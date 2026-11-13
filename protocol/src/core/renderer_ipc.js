"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { verifyAccessTokenConstantTime } = require("./transport_security");
const {
  safeJsJson,
  serializeBridgePayload,
  reviveBridgePayload,
  setBoundedMap,
} = require("./primitives");
const { isQuietLogsEnabled } = require("./env");

function _reviveUint8Arrays(val) {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }
  if (
    val instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) ||
    ArrayBuffer.isView(val)
  ) {
    return val;
  }
  if (val instanceof Map) {
    const out = new Map();
    for (const [k, v] of val.entries()) {
      out.set(_reviveUint8Arrays(k), _reviveUint8Arrays(v));
    }
    return out;
  }
  if (Array.isArray(val)) {
    return val.map((item) => _reviveUint8Arrays(item));
  }
  if (Array.isArray(val.__rosmontisUint8Array__) && Object.keys(val).length === 1) {
    return Uint8Array.from(val.__rosmontisUint8Array__);
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    const nextVal = _reviveUint8Arrays(v);
    if (k === "__proto__") {
      Object.defineProperty(out, k, {
        value: nextVal,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      out[k] = nextVal;
    }
  }
  return out;
}

const SERVICE_GETTER_MAP = {
  nodeIKernelMsgService: "getMsgService",
  nodeIKernelGroupService: "getGroupService",
  nodeIKernelBuddyService: "getBuddyService",
  nodeIKernelProfileService: "getProfileService",
  nodeIKernelProfileLikeService: "getProfileLikeService",
  nodeIKernelRichMediaService: "getRichMediaService",
  nodeIKernelRecentContactService: "getRecentContactService",
  nodeIKernelTicketService: "getTicketService",
  nodeIKernelUixConvertService: "getUixConvertService",
  nodeIKernelOnlineStatusService: "getOnlineStatusService",
  nodeIKernelRobotService: "getRobotService",
  nodeIKernelSearchService: "getSearchService",
  nodeIKernelFileAssistantService: "getFileAssistantService",
  nodeIKernelUnitedConfigService: "getUnitedConfigService",
  nodeIKernelTipOffService: "getTipOffService",
  nodeIKernelNodeMiscService: "getNodeMiscService",
  nodeIKernelMiscService: "getNodeMiscService",
  nodeIKernelLoginService: "getLoginService",
};

// Error tag for "this tier could not even dispatch the call" (renderer bridge not injected,
// ipcRenderer missing, webContents gone). Only such errors allow side-effect commands to
// fall through to the next tier; any other failure means the call may already have reached
// the kernel/server and must NOT be replayed.
const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";

// Kernel commands whose duplicate execution is user-visible or harmful (double messages,
// double recalls, repeated admin actions, burst retries under risk control).
const SIDE_EFFECT_NT_METHODS = new Set([
  "sendMsg",
  "forwardMsg",
  "forwardMsgWithComment",
  "multiForwardMsg",
  "multiForwardMsgWithComment",
  "recallMsg",
  "sendNudge",
  "sendPoke",
  "setMsgEmojiLikes",
  "sendShowInputStatusReq",
  "kickMember",
  "banMember",
  "quitGroup",
  "delBuddy",
  "approvalFriendRequest",
  "approvalDoubtBuddyReq",
  "operateSysNotify",
  "publishGroupBulletin",
  "addGroupEssence",
  "removeGroupEssence",
  "setBuddyProfileLike",
  "setBuddyRemark",
  "createGroupFolder",
  "deleteGroupFile",
  "deleteGroupFolder",
  "moveGroupFile",
  "transGroupFile",
  "modifyGroupName",
  "modifyGroupExtInfo",
  "modifyMemberRole",
  "modifyMemberCardName",
  "modifyMemberSpecialTitle",
  "setIdentityTitleInfo",
  "setHeader",
  "setLongNick",
  "modifySelfProfile",
  "modifyDesktopMiniProfile",
  "setOnlineStatus",
  "quickLogin",
  "quickLoginWithUin",
]);

function isSideEffectNtCmd(cmd) {
  const method = String(cmd || "").split("/").pop();
  return SIDE_EFFECT_NT_METHODS.has(method);
}

function makeBridgeUnavailableError(message) {
  const err = new Error(`${BRIDGE_UNAVAILABLE_TAG}: ${message}`);
  err.rosmontisUnavailable = true;
  return err;
}

function isBridgeUnavailableError(err) {
  if (!err) return false;
  if (err.rosmontisUnavailable === true) return true;
  return String(err.message || err).includes(BRIDGE_UNAVAILABLE_TAG);
}

let cachedRendererBridgeSource = null;

function getRendererBridgeSource() {
  if (cachedRendererBridgeSource !== null) {
    return cachedRendererBridgeSource;
  }
  try {
    const candidates = [
      path.join(__dirname, "..", "bridge_renderer.js"),
      path.join(__dirname, "bridge_renderer.js"),
    ];
    const rendererPath = candidates.find((p) => fs.existsSync(p));
    if (!rendererPath) {
      cachedRendererBridgeSource = "";
      return "";
    }
    cachedRendererBridgeSource = fs.readFileSync(rendererPath, "utf8");
    return cachedRendererBridgeSource;
  } catch (_) {
    return "";
  }
}

const rendererIpcMixin = {
  _safeJsJson(val) {
    return safeJsJson(val);
  },

  _isTrustedRendererUrl(url) {
    if (url === undefined || url === null) return true;
    const trimmed = String(url).trim().toLowerCase();
    if (trimmed === "") return true;
    if (
      trimmed.startsWith("http:") ||
      trimmed.startsWith("https:") ||
      trimmed.startsWith("devtools:") ||
      trimmed.startsWith("chrome-extension:") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("about:")
    ) {
      return false;
    }
    if (
      trimmed.startsWith("app:") ||
      trimmed.startsWith("file:") ||
      trimmed.startsWith("qq:") ||
      trimmed.startsWith("ntqq:") ||
      trimmed.startsWith("local-resource:")
    ) {
      return true;
    }
    return false;
  },

  _isTrustedIpcEvent(event, payload) {
    if (!event || !event.sender) {
      if (payload && typeof payload === "object" && payload.__ipcToken !== undefined) {
        return verifyAccessTokenConstantTime(String(payload.__ipcToken || ""), this._ipcAuthToken);
      }
      return true;
    }
    const sender = event.sender;
    if (!this._knownWebContents.has(sender) || !this._isWebContentsAlive(sender)) {
      return false;
    }
    if (typeof sender.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = sender.getURL();
      } catch (_) {
        return false;
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        return false;
      }
    }
    if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) {
      return false;
    }
    if (sender.__rosmontisIpcTokenInjected) {
      const provided =
        payload && typeof payload === "object" && typeof payload.__ipcToken === "string"
          ? payload.__ipcToken
          : "";
      if (!verifyAccessTokenConstantTime(provided, this._ipcAuthToken)) {
        return false;
      }
    }
    return true;
  },

  _handleRendererCmdAck(_event, ack) {
    if (!this._isTrustedIpcEvent(_event, ack)) return;
    if (!ack || typeof ack !== "object" || !ack.reqId) return;
    const reqId = String(ack.reqId);
    const pending = this._pendingRendererCmds.get(reqId);
    if (!pending) return;
    if (pending.webContents && _event && _event.sender && _event.sender !== pending.webContents) {
      return;
    }
    this._pendingRendererCmds.delete(reqId);
    if (pending.timer) clearTimeout(pending.timer);

    if (ack.ok) {
      let val = ack.result !== undefined ? ack.result : ack.data;
      if (typeof ack.resultSerialized === "string") {
        try {
          val = JSON.parse(ack.resultSerialized);
        } catch (_) {
          val = ack.resultSerialized;
        }
      }
      pending.resolve(this._reviveBridgeResult(val));
    } else {
      const errMsg = String(ack.error?.message || ack.error || "Renderer bridge command failed");
      const err = new Error(errMsg);
      if (ack.error?.code) {
        err.code = String(ack.error.code);
      }
      if (err.code === BRIDGE_UNAVAILABLE_TAG || errMsg.includes(BRIDGE_UNAVAILABLE_TAG)) {
        err.rosmontisUnavailable = true;
      }
      pending.reject(err);
    }
  },

  _rejectPendingRendererCmds(webContents = null, reason = "Renderer command channel closed") {
    for (const [reqId, pending] of Array.from(this._pendingRendererCmds.entries())) {
      if (!webContents || pending.webContents === webContents) {
        this._pendingRendererCmds.delete(reqId);
        if (pending.timer) clearTimeout(pending.timer);
        try {
          pending.reject(makeBridgeUnavailableError(reason));
        } catch (_) {}
      }
    }
  },

  installElectronHooks(electronModule) {
    let electron = electronModule;
    if (!electron) {
      try {
        electron = require("electron");
      } catch (_) {
        return false;
      }
    }
    if (!electron || typeof electron !== "object") return false;

    const { app, ipcMain } = electron;
    if (ipcMain) {
      try {
        ipcMain.on("__ROSMONTIS_BRIDGE_EVENT__", (_event, payload) => {
          if (!this._isTrustedIpcEvent(_event, payload)) return;
          this._handleRendererForwardedEvent(payload);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle("__ROSMONTIS_BRIDGE_EVENT__", (_event, payload) => {
            if (!this._isTrustedIpcEvent(_event, payload)) return { ok: false };
            this._handleRendererForwardedEvent(payload);
            return { ok: true };
          });
        }
        ipcMain.on("__ROSMONTIS_BRIDGE_CMD_ACK__", (_event, ack) => {
          this._handleRendererCmdAck(_event, ack);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle("__ROSMONTIS_BRIDGE_CMD_ACK__", (_event, ack) => {
            this._handleRendererCmdAck(_event, ack);
            return { ok: true };
          });
        }
        this._ipcCmdAckInstalled = true;
        for (const wc of this._knownWebContents) {
          if (wc && wc.__rosmontisIpcTokenInjected && typeof wc.send === "function") {
            wc.__rosmontisCmdChannelReady = true;
          }
        }
      } catch (_) {}
    }

    if (app && typeof app.on === "function") {
      app.on("web-contents-created", (_event, webContents) => {
        this._attachToWebContents(webContents);
      });
    }
    try {
      const existing = electron.webContents?.getAllWebContents?.();
      if (Array.isArray(existing)) {
        for (const wc of existing) {
          this._attachToWebContents(wc);
        }
      }
    } catch (_) {}
    return true;
  },

  _isWebContentsAlive(wc) {
    if (!wc) return false;
    if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
    return true;
  },

  _canInvokeRenderer(wc) {
    if (!this._isWebContentsAlive(wc)) return false;
    if (this._ipcCmdAckInstalled && wc.__rosmontisCmdChannelReady && typeof wc.send === "function") {
      return true;
    }
    return typeof wc.executeJavaScript === "function";
  },

  _isMainChatUrl(url) {
    const u = String(url || "").trim().toLowerCase();
    return Boolean(u && (u.includes("main") || (u.includes("index.html") && !u.includes("login"))));
  },

  _shouldPromoteWebContents(webContents) {
    if (!this._isWebContentsAlive(webContents)) return false;
    let url = "";
    try {
      if (typeof webContents.getURL === "function") {
        url = String(webContents.getURL() || "").trim().toLowerCase();
      }
    } catch (_) {}
    if (!this._isTrustedRendererUrl(url)) {
      return false;
    }
    if (!this._isWebContentsAlive(this.activeWebContents)) {
      return true;
    }
    if (this.activeWebContents === webContents) {
      return true;
    }
    const isAuxiliaryPopup =
      url.includes("image-viewer") ||
      url.includes("media-viewer") ||
      url.includes("video") ||
      url.includes("popup") ||
      url.includes("tray") ||
      url.includes("notification") ||
      url.includes("about:blank");
    if (isAuxiliaryPopup) {
      return false;
    }
    let currentUrl = "";
    try {
      if (typeof this.activeWebContents.getURL === "function") {
        currentUrl = String(this.activeWebContents.getURL() || "").trim().toLowerCase();
      }
    } catch (_) {}
    const currentIsMain = this._isMainChatUrl(currentUrl);
    if (!url) {
      return !currentIsMain;
    }
    if (this._isMainChatUrl(url)) {
      return true;
    }
    if (url.includes("login") && !currentIsMain) {
      return true;
    }
    return false;
  },

  _attachToWebContents(webContents) {
    if (!webContents || typeof webContents.on !== "function") return;
    if (this._knownWebContents.has(webContents)) return;
    this._knownWebContents.add(webContents);

    if (this._shouldPromoteWebContents(webContents)) {
      this.activeWebContents = webContents;
    }
    const onDestroyed = () => {
      webContents.__rosmontisCmdChannelReady = false;
      this._rejectPendingRendererCmds(webContents, "renderer webContents destroyed");
      this._knownWebContents.delete(webContents);
      if (this.activeWebContents === webContents) {
        this.activeWebContents = null;
        for (const candidate of this._knownWebContents) {
          if (this._shouldPromoteWebContents(candidate)) {
            this.activeWebContents = candidate;
            break;
          }
        }
      }
    };
    if (typeof webContents.once === "function") {
      webContents.once("destroyed", onDestroyed);
    } else {
      webContents.on("destroyed", onDestroyed);
    }

    let pageInjected = false;
    let injectPending = false;
    let injectGen = 0;
    const resetPageInjected = () => {
      injectGen += 1;
      pageInjected = false;
      injectPending = false;
      webContents.__rosmontisCmdChannelReady = false;
      webContents.__rosmontisIpcTokenInjected = false;
      this._rejectPendingRendererCmds(webContents, "renderer navigated");
    };

    const injectScript = () => {
      try {
        if (!this._isWebContentsAlive(webContents)) return;
        let rawUrl = "";
        try {
          if (typeof webContents.getURL === "function") {
            rawUrl = String(webContents.getURL() || "");
          }
        } catch (_) {
          return;
        }
        if (!this._isTrustedRendererUrl(rawUrl)) return;
        const url = rawUrl.trim().toLowerCase();
        if (this._isMainChatUrl(url)) {
          this.online = true;
        }
        if (this._shouldPromoteWebContents(webContents)) {
          this.activeWebContents = webContents;
        }
        const maybeTriggerQuickLogin = () => {
          if (!this.online && url.includes("login") && this.config.autoQuickLogin !== false) {
            const timer = setTimeout(() => {
              this._tryAutoQuickLogin({ webContents }).catch(() => {});
            }, 1500);
            if (timer && typeof timer.unref === "function") timer.unref();
          }
        };
        if (pageInjected || injectPending) {
          maybeTriggerQuickLogin();
          return;
        }
        const code = getRendererBridgeSource();
        if (!code) return;
        const rawWid = Number(webContents.id || 1);
        const widJson = this._safeJsJson(Number.isFinite(rawWid) && rawWid > 0 ? rawWid : 1);
        const ipcAuthTokenJson = this._safeJsJson(this._ipcAuthToken);
        const syncPatchJson = this._safeJsJson({
          activeAioPeer: this._activeAioPeer,
          activeAioPeerKey: this._activeAioPeerKey,
          focused: this._windowFocused,
        });
        const script = `(function(){ var wid = ${widJson}; var ipcAuthToken = ${ipcAuthTokenJson}; var syncPatch = ${syncPatchJson}; if (window.__ROSMONTIS_RENDERER_BRIDGE__) { if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken(ipcAuthToken); window.__ROSMONTIS_RENDERER_BRIDGE__.setWindowId(wid); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners(); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(syncPatch); return true; } window.__ROSMONTIS_WINDOW_ID__ = wid; ${code}\n if (typeof installRendererBridge === "function") { var b = installRendererBridge(window, { windowId: wid, autoRegisterListeners: true, ipcAuthToken: ipcAuthToken }); if (b && typeof b.setIpcAuthToken === "function") b.setIpcAuthToken(ipcAuthToken); if (b && typeof b.syncSessionState === "function") b.syncSessionState(syncPatch); } return true; })();`;
        const genAtStart = injectGen;
        injectPending = true;
        Promise.resolve(webContents.executeJavaScript(script, true))
          .then(() => {
            if (genAtStart !== injectGen || !this._isWebContentsAlive(webContents)) {
              return;
            }
            if (typeof webContents.getURL === "function") {
              try {
                if (!this._isTrustedRendererUrl(webContents.getURL())) return;
              } catch (_) {
                return;
              }
            }
            injectPending = false;
            pageInjected = true;
            webContents.__rosmontisIpcTokenInjected = true;
            if (typeof webContents.send === "function" && this._ipcCmdAckInstalled) {
              webContents.__rosmontisCmdChannelReady = true;
            }
            maybeTriggerQuickLogin();
          })
          .catch(() => {
            if (genAtStart === injectGen) {
              injectPending = false;
            }
          });
      } catch (_) {
        injectPending = false;
      }
    };

    webContents.on("did-start-loading", resetPageInjected);
    webContents.on("did-navigate", resetPageInjected);
    webContents.on("dom-ready", injectScript);
    webContents.on("did-finish-load", injectScript);
    webContents.on("did-navigate-in-page", injectScript);
  },

  async _tryAutoQuickLogin({ uin: explicitUin = "", force = false, webContents = null } = {}) {
    if (this.online && !force) {
      return { skipped: true, reason: "already_online", online: true };
    }
    const now = Date.now();
    if (!force) {
      if ((this._autoQuickLoginAttempts || 0) >= 3) {
        return { skipped: true, reason: "max_attempts_reached", online: Boolean(this.online) };
      }
      if (this._lastAutoQuickLoginAt && now - this._lastAutoQuickLoginAt < 12000) {
        return { skipped: true, reason: "cooldown", online: Boolean(this.online) };
      }
      this._lastAutoQuickLoginAt = now;
      this._autoQuickLoginAttempts = (this._autoQuickLoginAttempts || 0) + 1;
    }

    try {
      await this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]);
    } catch (_) {}

    let loginRes = null;
    try {
      loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
    } catch (_) {}
    const list = Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
    const targetUin = String(explicitUin || this.selfUin || "").trim();
    const acc =
      (targetUin && list.find((item) => item && String(item.uin) === targetUin)) ||
      list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
      null;

    if (!acc || (!acc.isQuickLogin && !acc.isAutoLogin && !force)) {
      return {
        skipped: true,
        reason: acc ? "quick_login_unavailable" : "no_saved_account",
        accounts: list.map((x) => ({
          uin: String(x?.uin || ""),
          isQuickLogin: Boolean(x?.isQuickLogin),
          isAutoLogin: Boolean(x?.isAutoLogin),
        })),
      };
    }

    const uin = String(acc.uin);
    this._updateSelfIdentity({
      uin,
      uid: acc.uid || this.selfUid,
      nick: acc.nickName || acc.nick || this.selfNickname,
      markOnline: false,
    });

    try {
      await this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]);
    } catch (_) {}

    let quickRes = null;
    let methodUsed = "";
    for (const cmd of [
      "nodeIKernelLoginService/quickLoginWithUin",
      "nodeIKernelLoginService/quickLogin",
    ]) {
      try {
        quickRes = await this.invokeNt(cmd, { uin }, [uin]);
        const code = Number(quickRes?.result ?? quickRes?.resultCode ?? 0);
        if (!Number.isNaN(code) && code === 0) {
          methodUsed = cmd;
          break;
        }
      } catch (_) {}
    }

    const wc = webContents || this.activeWebContents;
    if (
      !methodUsed &&
      wc &&
      this._isWebContentsAlive(wc) &&
      typeof wc.executeJavaScript === "function" &&
      (typeof wc.getURL !== "function" || this._isTrustedRendererUrl(wc.getURL()))
    ) {
      try {
        const clicked = await wc.executeJavaScript(
          `(function(){
            const btns = Array.from(document.querySelectorAll("button, .q-button, [role='button']"));
            const loginBtn = btns.find((el) => /^\\s*登\\s*录\\s*$/.test(String(el.textContent || "")));
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
          })()`,
          true
        );
        if (clicked) methodUsed = "dom_button_click";
      } catch (_) {}
    }

    return {
      triggered: Boolean(methodUsed),
      uin,
      method: methodUsed,
      result: quickRes || null,
      online: Boolean(this.online),
    };
  },

  _reviveBridgeResult(val) {
    return _reviveUint8Arrays(reviveBridgePayload(val));
  },

  _reviveBridgePayload(val) {
    return this._reviveBridgeResult(val);
  },

  _handleRendererForwardedEvent(rawData) {
    const data = this._reviveBridgeResult(rawData);
    if (!data || typeof data !== "object") return;
    const cmdName = String(data.cmdName || "");
    const eventName = String(data.eventName || "");
    const shortEvent = cmdName.includes("/") ? cmdName.split("/").pop() : cmdName;
    const listenerName = cmdName.includes("/") ? cmdName.split("/")[0] : eventName;
    const payload = data.payload;
    if (shortEvent) {
      this._handleKernelEvent(
        listenerName,
        shortEvent,
        Array.isArray(payload) ? payload : [payload]
      );
    }
  },

  _serializeBridgeArgs(value) {
    return serializeBridgePayload(value);
  },

  _serializeBridgePayload(value) {
    return serializeBridgePayload(value);
  },

  async _invokeRendererCommand(type, cmdPayload = {}, timeoutMs = 15000) {
    const wc = this.activeWebContents;
    if (!this._isWebContentsAlive(wc)) {
      throw makeBridgeUnavailableError("no live renderer webContents");
    }
    if (typeof wc.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = wc.getURL();
      } catch (_) {
        throw makeBridgeUnavailableError("failed to inspect renderer URL");
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        throw makeBridgeUnavailableError("active renderer URL is untrusted");
      }
    }

    // Primary structured IPC channel (zero executeJavaScript per command)
    if (
      this._ipcCmdAckInstalled &&
      wc.__rosmontisCmdChannelReady &&
      typeof wc.send === "function"
    ) {
      const reqId = crypto.randomUUID();
      const envelope = {
        reqId,
        __ipcToken: this._ipcAuthToken,
        type,
        ...cmdPayload,
        timeoutMs,
      };
      return await new Promise((resolve, reject) => {
        const effectiveTimeout = Math.max(100, Number(timeoutMs) || 15000);
        const timer = setTimeout(() => {
          this._pendingRendererCmds.delete(reqId);
          reject(new Error(`Renderer IPC command timeout (${effectiveTimeout}ms): ${type}`));
        }, effectiveTimeout);
        if (typeof timer.unref === "function") timer.unref();

        this._pendingRendererCmds.set(reqId, {
          reqId,
          type,
          webContents: wc,
          timer,
          resolve,
          reject,
        });

        try {
          wc.send("__ROSMONTIS_BRIDGE_CMD__", envelope);
        } catch (err) {
          clearTimeout(timer);
          this._pendingRendererCmds.delete(reqId);
          reject(makeBridgeUnavailableError(`webContents.send failed: ${err?.message || err}`));
        }
      });
    }

    // Fallback for synthetic unit-test mocks that only provide executeJavaScript
    if (typeof wc.executeJavaScript === "function") {
      let js = "";
      if (type === "invokeNt") {
        const cmdJson = this._safeJsJson(cmdPayload.cmd);
        const argsJson =
          typeof cmdPayload.argsSerialized === "string"
            ? cmdPayload.argsSerialized
            : this._serializeBridgeArgs(cmdPayload.args ?? [null, null]);
        const notReady = this._safeJsJson(`${BRIDGE_UNAVAILABLE_TAG}: Renderer bridge not ready`);
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized(${cmdJson}, ${argsJson}) : (window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi(${cmdJson}, ${argsJson}) : Promise.reject(new Error(${notReady}))`;
      } else if (type === "simulateSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "leaveSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "syncSession") {
        const patchJson = this._safeJsJson(cmdPayload.patch || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(${patchJson}) : null`;
      } else if (type === "resetSession") {
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState() : null`;
      } else {
        throw new Error(`Unsupported renderer command type: ${type}`);
      }
      const rawRes = await wc.executeJavaScript(js, true);
      if (typeof rawRes === "string" && type === "invokeNt") {
        try {
          return this._reviveBridgeResult(JSON.parse(rawRes));
        } catch (_) {
          return rawRes;
        }
      }
      return this._reviveBridgeResult(rawRes);
    }

    throw makeBridgeUnavailableError("no live renderer command transport");
  },

  _recordInvokeTier(cmd, tier, prevErrors) {
    const stats = this.invokeStats;
    stats[`tier${tier}`] = (stats[`tier${tier}`] || 0) + 1;
    if (tier > 1) {
      stats.degraded += 1;
      stats.lastDegraded = { cmd, tier, at: Date.now() };
      const reason = prevErrors.length > 0 ? String(prevErrors[0]?.message || prevErrors[0]) : "";
      this._logInvokeWarning(
        `degrade:${cmd}:${tier}`,
        `invokeNt degraded to Tier ${tier} for ${cmd}${reason ? ` (after: ${reason.slice(0, 200)})` : ""}`
      );
    }
  },

  _logInvokeWarning(key, message) {
    if (this.logger && typeof this.logger.warnThrottled === "function") {
      this.logger.warnThrottled(key, `WARN: ${message}`, 60000);
      return;
    }
    if (isQuietLogsEnabled(this.config)) return;
    const now = Date.now();
    if (!this._logThrottle) {
      this._logThrottle = new Map();
    }
    const last = this._logThrottle.get(key);
    if (last !== undefined && now - last < 60000) return;
    setBoundedMap(this._logThrottle, key, now, 500);
    try {
      process.stderr.write(`[rosmontis] WARN: ${message}\n`);
    } catch (_) {}
  },

  _logWarn(key, message, intervalMs = 60000) {
    if (this.logger && typeof this.logger.warnThrottled === "function") {
      this.logger.warnThrottled(key, message, intervalMs);
      return;
    }
    if (isQuietLogsEnabled(this.config)) return;
    const now = Date.now();
    if (!this._logThrottle) {
      this._logThrottle = new Map();
    }
    const last = this._logThrottle.get(key);
    if (last !== undefined && now - last < intervalMs) return;
    setBoundedMap(this._logThrottle, key, now, 500);
    try {
      process.stderr.write(`[rosmontis] ${message}\n`);
    } catch (_) {}
  },

  /**
   * 3-tier NTQQ invocation.
   *
   * Fallback policy:
   * - Read/idempotent commands: any Tier failure falls through to the next Tier (legacy behaviour).
   * - Side-effect commands (`SIDE_EFFECT_NT_METHODS`, e.g. sendMsg/recallMsg): only fall through
   *   when the previous Tier could not dispatch at all (`BRIDGE_UNAVAILABLE_TAG`). Once a Tier has
   *   actually dispatched the call, its timeout/error is surfaced as-is and never replayed, so a
   *   slow upload or a risk-control rejection can not turn into duplicate messages.
   */
  async invokeNt(cmd, payload = {}, positionalArgs = null) {
    const errors = [];
    const sideEffect = isSideEffectNtCmd(cmd);
    const stopAfterDispatchedFailure = (err) => {
      errors.push(err);
      if (sideEffect && !isBridgeUnavailableError(err)) {
        this.invokeStats.blockedReplays += 1;
        this._logInvokeWarning(
          `blocked:${cmd}`,
          `invokeNt not replaying side-effect ${cmd} after dispatched failure: ${String(err?.message || err).slice(0, 200)}`
        );
        return true;
      }
      return false;
    };

    // Tier 1: Execute via Renderer structured IPC (`__ROSMONTIS_BRIDGE_CMD__`) or safe fallback
    if (typeof this.rendererExecute === "function") {
      try {
        const res = await this.rendererExecute(cmd, [payload, null]);
        this._recordInvokeTier(cmd, 1, errors);
        return this._reviveBridgeResult(res);
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else if (this._canInvokeRenderer(this.activeWebContents)) {
      try {
        const argsSerialized = this._serializeBridgeArgs([payload, null]);
        const res = await this._invokeRendererCommand("invokeNt", {
          cmd,
          argsSerialized,
        });
        if (res !== undefined || sideEffect) {
          this._recordInvokeTier(cmd, 1, errors);
          return res;
        }
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else {
      errors.push(makeBridgeUnavailableError("no live renderer webContents"));
    }

    // Tier 2: Execute via Main-Process `ntApi[cmd]` Proxy
    // Note: Real NTQQ 3.2.32 `ntApi.invoke[cmd]` expects `(payload, ipcEvent)` directly
    // (NOT `([payload, null], ipcEvent)`).
    if (this.capturedServices.ntApi) {
      const ntApiTarget =
        typeof this.capturedServices.ntApi["nodeIKernelMsgService/sendMsg"] === "function"
          ? this.capturedServices.ntApi
          : this.capturedServices.ntApi.invoke &&
            typeof this.capturedServices.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"
          ? this.capturedServices.ntApi.invoke
          : this.capturedServices.ntApi;
      let handler = null;
      try {
        handler = ntApiTarget[cmd];
      } catch (_) {}
      if (typeof handler === "function") {
        try {
          const fakeIpcEvent = {
            sender: this.activeWebContents || {
              id: 1,
              send() {},
              isDestroyed: () => false,
            },
          };
          const res = await handler(payload, fakeIpcEvent);
          // A resolved side-effect call has been dispatched even if it returns void.
          if (res !== undefined || sideEffect) {
            this._recordInvokeTier(cmd, 2, errors);
            return res;
          }
        } catch (e) {
          if (stopAfterDispatchedFailure(e)) throw e;
        }
      } else {
        errors.push(makeBridgeUnavailableError(`ntApi has no handler for ${cmd}`));
      }
    }

    // Tier 3: Execute via live `NodeIQQNTWrapperSession.get*Service()[method](...positionalArgs)`
    const session =
      this.capturedServices.wrapperSession ||
      this.capturedServices.ntStore?.wrapperSession ||
      this.capturedServices.ntStore?.session ||
      this.capturedServices.ntSessionManager?.ntStore?.wrapperSession ||
      this.capturedServices.ntSessionManager?.ntStore?.session;
    if (session && cmd.includes("/")) {
      const [serviceName, methodName] = cmd.split("/");
      const getterName = SERVICE_GETTER_MAP[serviceName];
      if (getterName && typeof session[getterName] === "function") {
        try {
          const svc = session[getterName]();
          if (svc && typeof svc[methodName] === "function") {
            const callArgs = Array.isArray(positionalArgs)
              ? positionalArgs
              : payload && typeof payload === "object"
              ? Object.values(payload)
              : [];
            const res = await svc[methodName](...callArgs);
            this._recordInvokeTier(cmd, 3, errors);
            return res;
          }
        } catch (e) {
          errors.push(e);
        }
      }
    }

    this.invokeStats.failed += 1;
    const dispatched = errors.find((e) => !isBridgeUnavailableError(e));
    if (dispatched) {
      throw dispatched;
    }
    const unavailable = new Error(`NTQQ service unavailable for ${cmd}`);
    unavailable.rosmontisUnavailable = true;
    throw unavailable;
  },
};

module.exports = {
  safeJsJson,
  SERVICE_GETTER_MAP,
  BRIDGE_UNAVAILABLE_TAG,
  SIDE_EFFECT_NT_METHODS,
  isSideEffectNtCmd,
  makeBridgeUnavailableError,
  isBridgeUnavailableError,
  getRendererBridgeSource,
  rendererIpcMixin,
};
