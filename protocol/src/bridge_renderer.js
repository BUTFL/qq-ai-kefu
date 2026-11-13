"use strict";

/**
 * NTQQ Renderer-Layer Bridge (`bridge_renderer.js`)
 *
 * Self-contained module (zero top-level `require` calls) injected into
 * `BrowserWindow.webContents` after page load and importable in Node.js tests.
 *
 * Exposes `window.__ROSMONTIS_RENDERER_BRIDGE__`:
 * - Discovers `windowId` (`window.webContentId` / `?webcontentsid=`) and `window.ipcRenderer` / `window.ipcImpl`.
 * - Executes `invokeNtApi(cmd, args)` over `RM_IPCFROM_RENDERER{windowId}` using the genuine
 *   NTQQ 3.2.32 frame structure:
 *     meta: `{ type: "request", callbackId, eventName: "ntApi", peerId: windowId }`
 *     data: `{ cmdName: cmd, cmdType: "invoke", payload: [args, null] }`
 *   and resolves/rejects when `RM_IPCFROM_MAIN{windowId}` replies with matching `callbackId`
 *   and `promiseStatue: "full" | "err"`.
 * - Registers `ntApi-register` listeners so the main process forwards kernel events to
 *   `RM_IPCFROM_MAIN{windowId}`.
 * - Supports authenticated IPC command/event envelopes (`__ROSMONTIS_BRIDGE_CMD__`,
 *   `__ROSMONTIS_BRIDGE_CMD_ACK__`, `__ROSMONTIS_BRIDGE_EVENT__`) with `ipcAuthToken`
 *   confined strictly to closure scope (never readable on `window.__ROSMONTIS_RENDERER_BRIDGE__`).
 * - Implements causal human session simulation (`simulateHumanSessionFlow` / `leaveHumanSessionFlow`)
 *   with session-switch state tracking (`enterType: 2` on old AIO, `enterType: 1` on new AIO)
 *   and anti-burst deduplication for `setMsgRead` and `sendShowInputStatusReq`.
 */

const DEFAULT_REGISTERED_EVENTS = [
  "nodeIKernelMsgListener/onRecvMsg",
  "nodeIKernelMsgListener/onMsgInfoListUpdate",
  "nodeIKernelMsgListener/onAddSendMsg",
  "nodeIKernelMsgListener/onRichMediaDownloadComplete",
  "nodeIKernelMsgListener/onKickedOffLine",
  "nodeIKernelGroupListener/onGroupListUpdate",
  "nodeIKernelGroupListener/onGroupNotifiesUpdated",
  "nodeIKernelGroupListener/onMemberInfoChange",
  "nodeIKernelBuddyListener/onBuddyListChange",
  "nodeIKernelBuddyListener/onBuddyListChangedV2",
  "nodeIKernelBuddyListener/onBuddyReqChange",
  "nodeIKernelProfileListener/onProfileSimpleChanged",
  "nodeIKernelLoginListener/onQRCodeGetPicture",
  "nodeIKernelLoginListener/onQRCodeSessionQuickLoginFailed",
  "nodeIKernelLoginListener/onQRCodeLoginSucceed",
  "nodeIKernelLoginListener/onUserLoggedIn",
  "nodeIKernelSessionListener/onSessionInitComplete",
];

const KNOWN_MAP_FIELDS = new Set(["msgAttributeInfos", "thumbPath", "picThumbPath"]);
const BRIDGE_EVENT_CHANNEL = "__ROSMONTIS_BRIDGE_EVENT__";
const BRIDGE_CMD_CHANNEL = "__ROSMONTIS_BRIDGE_CMD__";
const BRIDGE_CMD_ACK_CHANNEL = "__ROSMONTIS_BRIDGE_CMD_ACK__";
const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";
const DEFAULT_BOUNDED_LRU_MAX = 2000;
const SESSION_STEP_TIMEOUT_MS = 4000;
const MAX_CODEC_DEPTH = 32;

const _cleanupByWindow = typeof WeakMap === "function" ? new WeakMap() : null;
const _bootstrapAuthByWindow = typeof WeakMap === "function" ? new WeakMap() : null;
const _diagSetterByWindow = typeof WeakMap === "function" ? new WeakMap() : null;

function getObjectTag(val) {
  return Object.prototype.toString.call(val);
}

function isMapLike(val) {
  return val instanceof Map || getObjectTag(val) === "[object Map]";
}

function isSetLike(val) {
  return val instanceof Set || getObjectTag(val) === "[object Set]";
}

function toUint8View(val) {
  if (val instanceof Uint8Array) return val;
  if (ArrayBuffer.isView(val)) {
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  }
  if (getObjectTag(val) === "[object Uint8Array]") {
    return Uint8Array.from(val);
  }
  return null;
}

function setOwnProp(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    target[key] = value;
  }
}

function encodeBridgeValue(val, { forJson = false, depth = 0, seen = null } = {}) {
  if (val === undefined) {
    return forJson ? { __rosmontisVoid__: true } : undefined;
  }
  if (val === null) return null;
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "function" || typeof val === "symbol") {
    return forJson ? { __rosmontisVoid__: true } : undefined;
  }
  if (typeof val !== "object") return val;

  const u8 = toUint8View(val);
  if (u8) {
    return forJson ? { __rosmontisUint8Array__: Array.from(u8) } : u8;
  }
  if (val instanceof Date || getObjectTag(val) === "[object Date]") {
    return forJson ? val.toISOString() : val;
  }
  if (depth > MAX_CODEC_DEPTH) {
    return val;
  }

  const ancestors = seen || new Set();
  if (ancestors.has(val)) {
    return null;
  }
  ancestors.add(val);

  try {
    const nextOpts = { forJson, depth: depth + 1, seen: ancestors };

    if (isMapLike(val)) {
      return {
        __rosmontisMap__: Array.from(val.entries(), ([k, v]) => [
          encodeBridgeValue(k, nextOpts),
          encodeBridgeValue(v, nextOpts),
        ]),
      };
    }
    if (isSetLike(val)) {
      return Array.from(val.values(), (v) => encodeBridgeValue(v, nextOpts));
    }
    if (Array.isArray(val)) {
      return val.map((item) => encodeBridgeValue(item, nextOpts));
    }

    const out = {};
    for (const [k, v] of Object.entries(val)) {
      setOwnProp(out, k, encodeBridgeValue(v, nextOpts));
    }
    return out;
  } finally {
    ancestors.delete(val);
  }
}

function encodeBridgeMaps(val, depth = 0) {
  return encodeBridgeValue(val, { forJson: false, depth });
}

function serializeBridgeResult(val) {
  const encoded = encodeBridgeValue(val, { forJson: true, depth: 0 });
  return JSON.stringify(encoded, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function reviveBridgePayload(val, fieldName = "", depth = 0, seen = null) {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }

  const u8 = toUint8View(val);
  if (u8) return u8;

  if (val instanceof Date || getObjectTag(val) === "[object Date]") {
    return val;
  }
  if (depth > MAX_CODEC_DEPTH) {
    return val;
  }

  const ancestors = seen || new Set();
  if (ancestors.has(val)) {
    return val;
  }
  ancestors.add(val);

  try {
    if (isMapLike(val)) {
      const revivedMap = new Map();
      for (const [k, v] of val.entries()) {
        revivedMap.set(
          reviveBridgePayload(k, "", depth + 1, ancestors),
          reviveBridgePayload(v, "", depth + 1, ancestors)
        );
      }
      return revivedMap;
    }

    if (Array.isArray(val)) {
      return val.map((item) => reviveBridgePayload(item, "", depth + 1, ancestors));
    }

    const keys = Object.keys(val);
    if (keys.length === 1) {
      if (val.__rosmontisVoid__ === true) {
        return undefined;
      }
      if (Array.isArray(val.__rosmontisMap__)) {
        return new Map(
          val.__rosmontisMap__.map((entry) => [
            Array.isArray(entry)
              ? reviveBridgePayload(entry[0], "", depth + 1, ancestors)
              : undefined,
            Array.isArray(entry)
              ? reviveBridgePayload(entry[1], "", depth + 1, ancestors)
              : undefined,
          ])
        );
      }
      if (Array.isArray(val.__rosmontisUint8Array__)) {
        return Uint8Array.from(val.__rosmontisUint8Array__);
      }
      if (Array.isArray(val.__rosmontisBytes__)) {
        return Uint8Array.from(val.__rosmontisBytes__);
      }
    } else if (
      keys.length === 2 &&
      val.type === "Buffer" &&
      Array.isArray(val.data) &&
      val.data.every((b) => typeof b === "number")
    ) {
      return Uint8Array.from(val.data);
    }

    if (KNOWN_MAP_FIELDS.has(fieldName)) {
      return new Map(
        Object.entries(val).map(([k, v]) => [
          /^\d+$/.test(k) && fieldName !== "msgAttributeInfos" ? Number(k) : k,
          reviveBridgePayload(v, "", depth + 1, ancestors),
        ])
      );
    }

    const out = {};
    for (const [k, v] of Object.entries(val)) {
      setOwnProp(out, k, reviveBridgePayload(v, k, depth + 1, ancestors));
    }
    return out;
  } finally {
    ancestors.delete(val);
  }
}

function setBoundedMap(map, key, value, maxEntries = DEFAULT_BOUNDED_LRU_MAX) {
  if (!isMapLike(map)) return map;
  if (maxEntries !== undefined && Number(maxEntries) <= 0) {
    map.clear();
    return map;
  }
  const limit =
    Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.floor(maxEntries)
      : DEFAULT_BOUNDED_LRU_MAX;
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return map;
}

function formatPeerKey(peer) {
  return `${peer.chatType}:${peer.peerUid}:${peer.guildId}`;
}

function formatIpcErrorBody(body) {
  if (body instanceof Error) return body.message;
  if (typeof body === "string") return body;
  try {
    return serializeBridgeResult(body);
  } catch (_) {
    return String(body);
  }
}

function installRendererBridge(targetWindow, options = {}) {
  const win =
    targetWindow ||
    (typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {});

  if (win.__ROSMONTIS_RENDERER_BRIDGE__ && !options.forceReinstall) {
    if (typeof win === "object" && win !== null) {
      if (typeof options.onDiagnostic === "function" && _diagSetterByWindow) {
        const setDiag = _diagSetterByWindow.get(win);
        if (typeof setDiag === "function") setDiag(options.onDiagnostic);
      }
      if (options.ipcAuthToken && _bootstrapAuthByWindow) {
        const bootstrapFn = _bootstrapAuthByWindow.get(win);
        if (typeof bootstrapFn === "function") {
          bootstrapFn(options.ipcAuthToken);
        }
      }
    }
    if (options.windowId && !win.__ROSMONTIS_RENDERER_BRIDGE__.windowId) {
      win.__ROSMONTIS_RENDERER_BRIDGE__.setWindowId(options.windowId);
    }
    if (typeof win.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners === "function") {
      win.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners();
    }
    return win.__ROSMONTIS_RENDERER_BRIDGE__;
  }

  let diagnosticHandler =
    typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;

  function reportDiag(scope, err) {
    if (diagnosticHandler) {
      try {
        diagnosticHandler(scope, err);
      } catch (_) {}
    }
    if (win && win.__ROSMONTIS_DEBUG__ === true) {
      try {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn(`[Rosmontis:renderer:${scope}]`, err);
        }
      } catch (_) {}
    }
  }

  if (_diagSetterByWindow && typeof win === "object" && win !== null) {
    _diagSetterByWindow.set(win, (fn) => {
      if (typeof fn === "function") diagnosticHandler = fn;
    });
  }

  if (options.forceReinstall && _cleanupByWindow && typeof win === "object" && win !== null) {
    const prevCleanup = _cleanupByWindow.get(win);
    if (typeof prevCleanup === "function") {
      try {
        prevCleanup();
      } catch (err) {
        reportDiag("cleanupPrevious", err);
      }
    }
  }

  let ipcAuthToken =
    typeof options.ipcAuthToken === "string" && options.ipcAuthToken.length > 0
      ? options.ipcAuthToken
      : "";

  function setIpcAuthTokenOnce(nextToken) {
    if (ipcAuthToken) return false;
    if (typeof nextToken === "string" && nextToken.length > 0) {
      ipcAuthToken = nextToken;
      return true;
    }
    return false;
  }

  if (_bootstrapAuthByWindow && typeof win === "object" && win !== null) {
    _bootstrapAuthByWindow.set(win, setIpcAuthTokenOnce);
  }

  function resolveIpcRenderer() {
    if (options.ipcRenderer) return options.ipcRenderer;
    if (win.ipcImpl && typeof win.ipcImpl.send === "function") {
      return win.ipcImpl;
    }
    if (
      win.ipcRenderer &&
      (typeof win.ipcRenderer.send === "function" || typeof win.ipcRenderer.invoke === "function")
    ) {
      return win.ipcRenderer;
    }
    if (win.ntqq && win.ntqq.ipcRenderer) return win.ntqq.ipcRenderer;
    if (win.electron && win.electron.ipcRenderer) return win.electron.ipcRenderer;
    if (win.qqnt && win.qqnt.ipcRenderer) return win.qqnt.ipcRenderer;
    try {
      if (typeof require === "function") {
        const el = require("electron");
        if (el && el.ipcRenderer) return el.ipcRenderer;
      }
    } catch (_) {}
    return null;
  }

  function discoverWindowId(ipc) {
    if (options.windowId && Number(options.windowId) > 0) {
      return Number(options.windowId);
    }
    if (typeof win.webContentId === "number" && win.webContentId > 0) {
      return win.webContentId;
    }
    if (win.__ROSMONTIS_WINDOW_ID__ && Number(win.__ROSMONTIS_WINDOW_ID__) > 0) {
      return Number(win.__ROSMONTIS_WINDOW_ID__);
    }
    try {
      if (ipc && typeof ipc.eventNames === "function") {
        for (const name of ipc.eventNames()) {
          const m = /^RM_IPCFROM_MAIN(\d+)$/.exec(String(name));
          if (m) return Number(m[1]);
        }
      }
    } catch (err) {
      reportDiag("discoverWindowId.eventNames", err);
    }
    try {
      const urlParams = new URLSearchParams(win.location ? win.location.search : "");
      const wid = Number(
        urlParams.get("webcontentsid") ||
          urlParams.get("webContentsId") ||
          urlParams.get("windowId") ||
          0
      );
      if (Number.isFinite(wid) && wid > 0) return wid;
    } catch (err) {
      reportDiag("discoverWindowId.location", err);
    }
    return 1;
  }

  const ipcRenderer = resolveIpcRenderer();
  let windowId = discoverWindowId(ipcRenderer);
  const pendingCallbacks = new Map();
  const observedChannels = new Set();
  const attachedIpcByChannel = new Map();
  const attachedHandlerByChannel = new Map();
  const registeredWindowIds = new Set();

  const sessionState = {
    activeAioPeer: null,
    activeAioPeerKey: "",
    focused: false,
    lastReadAtByPeer: new Map(),
    lastTypingAtByPeer: new Map(),
  };

  function resetSessionState() {
    sessionState.activeAioPeer = null;
    sessionState.activeAioPeerKey = "";
    sessionState.focused = false;
    sessionState.lastReadAtByPeer.clear();
    sessionState.lastTypingAtByPeer.clear();
  }

  function makeCallbackId() {
    try {
      if (win.crypto && typeof win.crypto.randomUUID === "function") {
        return win.crypto.randomUUID();
      }
    } catch (_) {}
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      if (typeof require === "function") {
        const nodeCrypto = require("crypto");
        if (nodeCrypto && typeof nodeCrypto.randomUUID === "function") {
          return nodeCrypto.randomUUID();
        }
      }
    } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function sendOverIpcChannel(channel, payload, diagScope) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc) return;
    try {
      if (typeof ipc.send === "function") {
        ipc.send(channel, payload);
        return;
      }
      if (typeof ipc.invoke === "function") {
        Promise.resolve(ipc.invoke(channel, payload)).catch((err) => {
          reportDiag(`${diagScope}.invoke`, err);
        });
      }
    } catch (err) {
      reportDiag(diagScope, err);
    }
  }

  function forwardToMain(payload) {
    const envelope =
      ipcAuthToken && payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, __ipcToken: ipcAuthToken }
        : payload;
    sendOverIpcChannel(BRIDGE_EVENT_CHANNEL, encodeBridgeMaps(envelope), "forwardToMain");
  }

  function sendCommandAck(reply) {
    const replyEnvelope = ipcAuthToken ? { ...reply, __ipcToken: ipcAuthToken } : reply;
    sendOverIpcChannel(BRIDGE_CMD_ACK_CHANNEL, replyEnvelope, "sendCommandAck");
  }

  function handleIncomingMainIpc(_event, header, body) {
    try {
      if (header && typeof header === "object" && header.callbackId) {
        const pending = pendingCallbacks.get(header.callbackId);
        if (pending) {
          pendingCallbacks.delete(header.callbackId);
          clearTimeout(pending.timer);
          if (
            header.promiseStatue &&
            header.promiseStatue !== "full" &&
            header.promiseStatue !== "fulfilled"
          ) {
            pending.reject(
              new Error(`NTQQ IPC error (${pending.cmd}): ${formatIpcErrorBody(body)}`)
            );
          } else {
            pending.resolve(body);
          }
          return;
        }
      }

      const eventName = header?.eventName || "ntApi";
      if (body && typeof body === "object" && !Array.isArray(body) && typeof body.cmdName === "string") {
        forwardToMain({
          source: "renderer_ipc",
          windowId,
          eventName,
          cmdName: body.cmdName,
          payload: body.payload,
          timestamp: Date.now(),
        });
      } else if (Array.isArray(body) && body.length >= 1) {
        const first = body[0];
        if (first && typeof first === "object" && typeof first.cmdName === "string") {
          forwardToMain({
            source: "renderer_ipc",
            windowId,
            eventName,
            cmdName: first.cmdName,
            payload: first.payload !== undefined ? first.payload : body[1],
            rawBody: body,
            timestamp: Date.now(),
          });
        } else if (
          typeof first === "string" &&
          (first.startsWith("nodeIKernel") || first.startsWith("on"))
        ) {
          forwardToMain({
            source: "renderer_ipc",
            windowId,
            eventName,
            cmdName: first,
            payload: body[1],
            rawBody: body,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      reportDiag("handleIncomingMainIpc", err);
    }
  }

  function decodeCommandField(serializedField, directField) {
    const raw = typeof serializedField === "string" ? JSON.parse(serializedField) : directField;
    return reviveBridgePayload(raw);
  }

  async function handleBridgeCommand(_eventOrEnvelope, maybeEnvelope) {
    const cmdEnvelope =
      maybeEnvelope !== undefined
        ? maybeEnvelope
        : _eventOrEnvelope &&
          typeof _eventOrEnvelope === "object" &&
          ("reqId" in _eventOrEnvelope || "type" in _eventOrEnvelope)
        ? _eventOrEnvelope
        : null;

    if (!cmdEnvelope || typeof cmdEnvelope !== "object" || !cmdEnvelope.reqId) {
      return;
    }
    if (ipcAuthToken && cmdEnvelope.__ipcToken !== ipcAuthToken) {
      reportDiag("handleBridgeCommand.authRejected", new Error("IPC auth token mismatch"));
      return;
    }

    try {
      switch (cmdEnvelope.type) {
        case "invokeNt": {
          const rawArgs = decodeCommandField(cmdEnvelope.argsSerialized, cmdEnvelope.args);
          const res = await invokeNtApi(
            cmdEnvelope.cmd,
            rawArgs,
            cmdEnvelope.timeoutMs !== undefined ? cmdEnvelope.timeoutMs : 15000
          );
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "simulateSession": {
          const opts = decodeCommandField(cmdEnvelope.optsSerialized, cmdEnvelope.opts);
          const res = await simulateHumanSessionFlow(opts || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "leaveSession": {
          const opts = decodeCommandField(cmdEnvelope.optsSerialized, cmdEnvelope.opts);
          const res = await leaveHumanSessionFlow(opts || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "syncSession": {
          const patch = decodeCommandField(cmdEnvelope.patchSerialized, cmdEnvelope.patch);
          syncSessionState(patch || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
          });
          break;
        }

        case "resetSession": {
          resetSessionState();
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
          });
          break;
        }

        case "bootstrapAuth": {
          const ok = setIpcAuthTokenOnce(
            cmdEnvelope.token || cmdEnvelope.ipcAuthToken || cmdEnvelope.__ipcToken
          );
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok,
          });
          break;
        }

        default: {
          const unknownErr = new Error(
            `Unsupported renderer bridge command type: ${String(cmdEnvelope.type || "")}`
          );
          unknownErr.code = "ERR_UNKNOWN_BRIDGE_CMD";
          throw unknownErr;
        }
      }
    } catch (err) {
      reportDiag("handleBridgeCommand", err);
      const message = String(err?.message || err || "Renderer command failed");
      const code =
        err?.code !== undefined && err?.code !== null
          ? String(err.code)
          : message.includes(BRIDGE_UNAVAILABLE_TAG)
          ? BRIDGE_UNAVAILABLE_TAG
          : "";
      sendCommandAck({
        reqId: cmdEnvelope.reqId,
        ok: false,
        error: { message, code },
      });
    }
  }

  function removeChannelHandler(ipc, channel, handler, diagScope) {
    if (!ipc || !handler) return false;
    if (typeof ipc.removeListener === "function") {
      try {
        ipc.removeListener(channel, handler);
      } catch (err) {
        reportDiag(diagScope, err);
      }
      return true;
    }
    if (typeof ipc.off === "function") {
      try {
        ipc.off(channel, handler);
      } catch (err) {
        reportDiag(diagScope, err);
      }
      return true;
    }
    return false;
  }

  function attachChannelListener(channel, handler, force = false) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc || typeof ipc.on !== "function") return;
    if (observedChannels.has(channel) && attachedIpcByChannel.get(channel) === ipc) {
      if (!force) return;
      const prevHandler = attachedHandlerByChannel.get(channel) || handler;
      if (!removeChannelHandler(ipc, channel, prevHandler, "attachChannelListener.remove")) {
        return;
      }
    }
    observedChannels.add(channel);
    attachedIpcByChannel.set(channel, ipc);
    attachedHandlerByChannel.set(channel, handler);
    try {
      ipc.on(channel, handler);
    } catch (err) {
      reportDiag("attachChannelListener.on", err);
    }
  }

  function attachPassiveListener(wid, force = false) {
    attachChannelListener(`RM_IPCFROM_MAIN${wid}`, handleIncomingMainIpc, force);
  }

  function attachCommandListener(force = false) {
    attachChannelListener(BRIDGE_CMD_CHANNEL, handleBridgeCommand, force);
  }

  function detachAllListeners() {
    for (const [channel, ipc] of attachedIpcByChannel.entries()) {
      const handler = attachedHandlerByChannel.get(channel);
      removeChannelHandler(ipc, channel, handler, "detachAllListeners");
    }
    observedChannels.clear();
    attachedIpcByChannel.clear();
    attachedHandlerByChannel.clear();
  }

  if (_cleanupByWindow && typeof win === "object" && win !== null) {
    _cleanupByWindow.set(win, detachAllListeners);
  }

  function reattachListeners() {
    attachPassiveListener(windowId, true);
    if (windowId === 1) {
      attachPassiveListener(2, true);
    }
    attachCommandListener(true);
  }

  function registerNtApiListeners(wid = windowId, eventNames = DEFAULT_REGISTERED_EVENTS) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc || typeof ipc.send !== "function") return false;
    const targetWid = Number(wid) || windowId || 1;
    if (registeredWindowIds.has(targetWid)) return true;
    registeredWindowIds.add(targetWid);
    const channel = `RM_IPCFROM_RENDERER${targetWid}`;
    try {
      for (const evtName of eventNames) {
        ipc.send(
          channel,
          {
            type: "request",
            eventName: "ntApi-register",
            peerId: targetWid,
          },
          evtName
        );
      }
      return true;
    } catch (err) {
      reportDiag("registerNtApiListeners", err);
      return false;
    }
  }

  attachPassiveListener(windowId);
  if (windowId === 1) {
    attachPassiveListener(2);
  }
  attachCommandListener();

  if (options.autoRegisterListeners) {
    registerNtApiListeners(windowId);
  }

  function inspectVueAppState() {
    try {
      const doc = win.document;
      if (!doc || typeof doc.querySelector !== "function") {
        return { mounted: false };
      }
      const appEl = doc.querySelector("#app");
      const vueApp = appEl && appEl.__vue_app__;
      if (!vueApp) {
        return { mounted: false };
      }
      const globalProps = vueApp.config?.globalProperties || {};
      const router = globalProps.$router;
      const route = globalProps.$route;
      return {
        mounted: true,
        currentRoute:
          router?.currentRoute?.value?.fullPath ||
          router?.currentRoute?.fullPath ||
          route?.fullPath ||
          route?.path ||
          "",
        hasPinia: Boolean(globalProps.$pinia),
        hasVuex: Boolean(globalProps.$store),
      };
    } catch (err) {
      reportDiag("inspectVueAppState", err);
      return { mounted: false };
    }
  }

  async function invokeNtApi(cmd, args, timeoutMs = 15000) {
    const ipc = resolveIpcRenderer();
    if (!ipc || (typeof ipc.send !== "function" && typeof ipc.invoke !== "function")) {
      // Tagged so the main process knows nothing was dispatched and fallback is safe.
      throw new Error(
        `${BRIDGE_UNAVAILABLE_TAG}: Renderer ipcRenderer (send/invoke) is not available`
      );
    }
    attachPassiveListener(windowId);
    attachCommandListener();

    const callbackId = makeCallbackId();
    const requestHeader = {
      type: "request",
      callbackId,
      eventName: "ntApi",
      peerId: windowId,
    };
    const revivedArgs = reviveBridgePayload(args);
    const payloadList =
      revivedArgs === undefined || revivedArgs === null
        ? [null, null]
        : Array.isArray(revivedArgs)
        ? revivedArgs.length === 1
          ? [revivedArgs[0], null]
          : [...revivedArgs]
        : [revivedArgs, null];
    const requestPayload = {
      cmdName: cmd,
      cmdType: "invoke",
      payload: payloadList,
    };
    const channel = `RM_IPCFROM_RENDERER${windowId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCallbacks.delete(callbackId);
        reject(new Error(`invokeNtApi timeout (${timeoutMs}ms): ${cmd}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      pendingCallbacks.set(callbackId, {
        resolve,
        reject,
        timer,
        cmd,
      });

      try {
        if (typeof ipc.send === "function") {
          ipc.send(channel, requestHeader, requestPayload);
        } else {
          Promise.resolve(ipc.invoke(channel, requestHeader, requestPayload)).then(
            (directResult) => {
              if (directResult !== undefined && pendingCallbacks.has(callbackId)) {
                pendingCallbacks.delete(callbackId);
                clearTimeout(timer);
                resolve(directResult);
              }
            },
            (err) => {
              if (pendingCallbacks.has(callbackId)) {
                pendingCallbacks.delete(callbackId);
                clearTimeout(timer);
                reject(err);
              }
            }
          );
        }
      } catch (err) {
        pendingCallbacks.delete(callbackId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function rethrowIfBridgeUnavailable(err) {
    if (err && String(err.message || err).includes(BRIDGE_UNAVAILABLE_TAG)) {
      throw err;
    }
  }

  function snapshotSessionSummary() {
    return {
      activeAioPeer: sessionState.activeAioPeer,
      activeAioPeerKey: sessionState.activeAioPeerKey,
      focused: sessionState.focused,
    };
  }

  function syncSessionState(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return snapshotSessionSummary();
    }
    if ("activeAioPeer" in patch && patch.activeAioPeer !== undefined) {
      sessionState.activeAioPeer = patch.activeAioPeer || null;
    }
    if ("activeAioPeerKey" in patch && patch.activeAioPeerKey !== undefined) {
      sessionState.activeAioPeerKey = String(patch.activeAioPeerKey || "");
      if (!sessionState.activeAioPeerKey) {
        sessionState.activeAioPeer = null;
      }
    }
    if ("focused" in patch && patch.focused !== undefined) {
      sessionState.focused = Boolean(patch.focused);
    }
    if (patch.clearDedupe) {
      sessionState.lastReadAtByPeer.clear();
      sessionState.lastTypingAtByPeer.clear();
    }
    return snapshotSessionSummary();
  }

  async function ensureWindowFocus(steps) {
    if (sessionState.focused) {
      steps.setFocusOnBase = true;
      return;
    }
    try {
      await invokeNtApi(
        "nodeIKernelMsgService/setFocusOnBase",
        [{ isFocus: true }, null],
        SESSION_STEP_TIMEOUT_MS
      );
      steps.setFocusOnBase = true;
      steps.focusActivated = true;
      sessionState.focused = true;
    } catch (err) {
      rethrowIfBridgeUnavailable(err);
      reportDiag("session.ensureWindowFocus", err);
    }
  }

  async function switchActiveAio(peer, peerKey, steps) {
    if (sessionState.activeAioPeerKey === peerKey) {
      steps.alreadyInAio = true;
      steps.enterOrExitAio = true;
      steps.addActiveChatByUid = true;
      return;
    }

    if (sessionState.activeAioPeer && sessionState.activeAioPeerKey) {
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/enterOrExitAio",
          [{ info: { peer: sessionState.activeAioPeer, enterType: 2 } }, null],
          SESSION_STEP_TIMEOUT_MS
        );
        steps.exitedPreviousAio = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
        reportDiag("session.exitPreviousAio", err);
      }
    }

    try {
      await invokeNtApi(
        "nodeIKernelMsgService/addActiveChatByUid",
        [{ peer }, null],
        SESSION_STEP_TIMEOUT_MS
      );
      steps.addActiveChatByUid = true;
    } catch (err) {
      rethrowIfBridgeUnavailable(err);
      reportDiag("session.addActiveChatByUid", err);
    }

    try {
      await invokeNtApi(
        "nodeIKernelMsgService/enterOrExitAio",
        [{ info: { peer, enterType: 1 } }, null],
        SESSION_STEP_TIMEOUT_MS
      );
      steps.enterOrExitAio = true;
    } catch (err) {
      rethrowIfBridgeUnavailable(err);
      reportDiag("session.enterAio", err);
    }

    sessionState.activeAioPeer = peer;
    sessionState.activeAioPeerKey = peerKey;
  }

  async function applyReadAndTyping(
    peer,
    peerKey,
    { markRead, sendTyping, eventType, dedupeWindowMs, bypassDedupe, readToTypingDelayMs },
    steps
  ) {
    if (markRead) {
      const lastReadAt = sessionState.lastReadAtByPeer.get(peerKey) || 0;
      if (bypassDedupe || Date.now() - lastReadAt >= dedupeWindowMs) {
        try {
          await invokeNtApi(
            "nodeIKernelMsgService/setMsgRead",
            [{ peer }, null],
            SESSION_STEP_TIMEOUT_MS
          );
          steps.markRead = true;
          setBoundedMap(sessionState.lastReadAtByPeer, peerKey, Date.now());
        } catch (err) {
          rethrowIfBridgeUnavailable(err);
          reportDiag("session.setMsgRead", err);
        }
      } else {
        steps.markReadSkipped = true;
      }
    }

    const isPrivateChat = peer.chatType === 1;
    const pauseMs = Number(readToTypingDelayMs);
    if (steps.markRead && sendTyping && isPrivateChat && Number.isFinite(pauseMs) && pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }

    if (sendTyping && isPrivateChat) {
      const effEventType = Number(eventType ?? 1);
      const lastTypingAt = sessionState.lastTypingAtByPeer.get(peerKey) || 0;
      if (bypassDedupe || effEventType !== 1 || Date.now() - lastTypingAt >= dedupeWindowMs) {
        try {
          await invokeNtApi(
            "nodeIKernelMsgService/sendShowInputStatusReq",
            [
              {
                eventType: effEventType,
                peer: { chatType: 1, peerUid: peer.peerUid, guildId: "" },
              },
              null,
            ],
            SESSION_STEP_TIMEOUT_MS
          );
          steps.sendTyping = true;
          if (effEventType === 1) {
            setBoundedMap(sessionState.lastTypingAtByPeer, peerKey, Date.now());
          }
        } catch (err) {
          rethrowIfBridgeUnavailable(err);
          reportDiag("session.sendShowInputStatusReq", err);
        }
      } else {
        steps.sendTypingSkipped = true;
      }
    }
  }

  async function leaveHumanSessionFlow({
    exitAio = true,
    blurWindow = false,
    knownActivePeer = undefined,
    knownActivePeerKey = undefined,
    knownFocused = undefined,
  } = {}) {
    syncSessionState({
      activeAioPeer: knownActivePeer,
      activeAioPeerKey: knownActivePeerKey,
      focused: knownFocused,
    });

    let exitedAio = false;
    let blurredWindow = false;

    if (exitAio && sessionState.activeAioPeer && sessionState.activeAioPeerKey) {
      const prevPeer = sessionState.activeAioPeer;
      sessionState.activeAioPeer = null;
      sessionState.activeAioPeerKey = "";
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/enterOrExitAio",
          [{ info: { peer: prevPeer, enterType: 2 } }, null],
          SESSION_STEP_TIMEOUT_MS
        );
        exitedAio = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
        reportDiag("session.leaveAio", err);
      }
    }

    if (blurWindow && sessionState.focused) {
      sessionState.focused = false;
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/setFocusOnBase",
          [{ isFocus: false }, null],
          SESSION_STEP_TIMEOUT_MS
        );
        blurredWindow = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
        reportDiag("session.blurWindow", err);
      }
    }

    return {
      exitedAio,
      blurredWindow,
      ...snapshotSessionSummary(),
    };
  }

  async function simulateHumanSessionFlow({
    chatType = 1,
    peerUid = "",
    guildId = "",
    markRead = true,
    sendTyping = false,
    eventType = 1,
    dedupeWindowMs = 5000,
    bypassDedupe = false,
    readToTypingDelayMs = 0,
    knownActivePeer = undefined,
    knownActivePeerKey = undefined,
    knownFocused = undefined,
  } = {}) {
    syncSessionState({
      activeAioPeer: knownActivePeer,
      activeAioPeerKey: knownActivePeerKey,
      focused: knownFocused,
    });

    const peer = {
      chatType: Number(chatType),
      peerUid: String(peerUid || ""),
      guildId: String(guildId || ""),
    };
    const steps = {
      vueState: inspectVueAppState(),
      exitedPreviousAio: false,
      alreadyInAio: false,
      enterOrExitAio: false,
      addActiveChatByUid: false,
      setFocusOnBase: false,
      focusActivated: false,
      markRead: false,
      markReadSkipped: false,
      sendTyping: false,
      sendTypingSkipped: false,
    };

    if (!peer.peerUid) {
      return steps;
    }

    const peerKey = formatPeerKey(peer);
    await ensureWindowFocus(steps);
    await switchActiveAio(peer, peerKey, steps);
    await applyReadAndTyping(
      peer,
      peerKey,
      { markRead, sendTyping, eventType, dedupeWindowMs, bypassDedupe, readToTypingDelayMs },
      steps
    );

    return Object.assign(steps, snapshotSessionSummary());
  }

  const bridgeApi = {
    version: "1.3.0",
    get windowId() {
      return windowId;
    },
    setWindowId(newId) {
      if (Number(newId) > 0) {
        windowId = Number(newId);
        attachPassiveListener(windowId);
        attachCommandListener();
      }
      return windowId;
    },
    get sessionState() {
      return sessionState;
    },
    syncSessionState,
    resetSessionState,
    makeCallbackId,
    reattachListeners,
    registerNtApiListeners,
    inspectVueAppState,
    invokeNtApi,
    async invokeNtApiSerialized(cmd, args, timeoutMs = 15000) {
      const res = await invokeNtApi(cmd, args, timeoutMs);
      return serializeBridgeResult(res);
    },
    simulateHumanSessionFlow,
    leaveHumanSessionFlow,
    _handleIncomingMainIpc: handleIncomingMainIpc,
  };

  Object.defineProperty(bridgeApi, "setIpcAuthToken", {
    value: setIpcAuthTokenOnce,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  win.__ROSMONTIS_RENDERER_BRIDGE__ = bridgeApi;
  return bridgeApi;
}

if (typeof window !== "undefined") {
  try {
    installRendererBridge(window, { autoRegisterListeners: true });
  } catch (err) {
    if (
      window &&
      window.__ROSMONTIS_DEBUG__ === true &&
      typeof console !== "undefined" &&
      typeof console.warn === "function"
    ) {
      console.warn("[Rosmontis:renderer:autoInstall]", err);
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    installRendererBridge,
    DEFAULT_REGISTERED_EVENTS,
    KNOWN_MAP_FIELDS,
    encodeBridgeMaps,
    serializeBridgeResult,
    reviveBridgePayload,
    setBoundedMap,
  };
}
