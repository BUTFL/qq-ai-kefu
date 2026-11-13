"use strict";

/**
 * NTQQ Main-Process & Renderer-Coordinated OneBot v11 Bridge (`bridge_main.js`)
 *
 * Pure JavaScript coordinator (zero C++ hooks, zero npm dependencies) composing
 * `src/core/*` runtime subsystems, `src/bridge_onebot.js` (`src/onebot/*`) codecs,
 * and `src/actions/*` declarative OneBot v11 action routers.
 */

const crypto = require("crypto");
const { EventEmitter } = require("events");

const {
  MessageIdStore, UinUidStore, segmentsToCqCode,
  getNtqqVersionMetadata, buildNtqqUserAgent, pruneTempDir,
} = require("./bridge_onebot");
const { isAutoInstallDisabledFromEnv } = require("./core/env");
const {
  BoundedMap, BridgeLogger, TtlDedupeSet, TempCleanupQueue, setBoundedMap, safeJsJson,
} = require("./core/primitives");
const {
  EchoCorrelator, _ntElementsSignature, _elementsSignatureMatch,
} = require("./core/echo_correlator");
const { HumanSessionController } = require("./core/session_controller");
const {
  encodeWsFrame, Rfc6455Connection, connectReverseWebSocket,
} = require("./core/ws_rfc6455");
const { loadBridgeConfig } = require("./core/config");
const {
  computeBkn, cookieObjToString, httpsGetCookies, httpRequestText, parseJsonpOrJson,
} = require("./core/web_http");
const {
  assertWebCredentialApiEnabled, fetchClientKey, getCookiesObject,
} = require("./core/qzone_actions");

const { ntCaptureMixin } = require("./core/nt_capture");
const { rendererIpcMixin } = require("./core/renderer_ipc");
const { inboundPipelineMixin } = require("./core/inbound_pipeline");
const { outboundPipelineMixin } = require("./core/outbound_pipeline");
const { serverRuntimeMixin } = require("./core/server_runtime");

const messageActions = require("./actions/message_actions");
const contactActions = require("./actions/contact_actions");
const groupActions = require("./actions/group_actions");
const fileMediaActions = require("./actions/file_media_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn, cookieObjToString, httpsGetCookies, httpRequestText, parseJsonpOrJson,
});

const ACTION_MODULES = [messageActions, contactActions, groupActions, fileMediaActions];
const ACTION_DISPATCH_MAP = new Map();
for (const mod of ACTION_MODULES) {
  for (const act of mod.HANDLED_ACTIONS) {
    if (ACTION_DISPATCH_MAP.has(act)) {
      throw new Error(`Duplicate OneBot action registration: ${act}`);
    }
    ACTION_DISPATCH_MAP.set(act, mod.dispatch);
  }
}

// ============================================================================
// Main Bridge Coordinator Class (`NtqqOneBotBridge`)
// ============================================================================

class NtqqOneBotBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || loadBridgeConfig(options.configDir);
    this.messageIdStore = options.messageIdStore || new MessageIdStore(10000);
    this.uinUidStore = options.uinUidStore || new UinUidStore(20000);

    this.logger = new BridgeLogger({ getConfig: () => this.config });
    this.eventDedupe = new TtlDedupeSet(5000, 30000);
    this.tempCleanupQueue = new TempCleanupQueue(() => this.config);
    this.echoCorrelator = new EchoCorrelator({
      getSignatureFns: () => ({
        _ntElementsSignature: this.constructor._ntElementsSignature,
        _elementsSignatureMatch: this.constructor._elementsSignatureMatch,
      }),
    });
    this.sessionController = new HumanSessionController({
      getConfig: () => this.config,
      invokeNt: (...args) => this.invokeNt(...args),
      canInvokeRenderer: () => this._canInvokeRendererBridge(),
      invokeRendererCommand: (action, payload, timeoutMs) =>
        this._invokeRendererBridgeCommand(action, payload, timeoutMs),
      getRendererHooks: () => ({
        simulateSession: this.rendererSimulateSession,
        leaveSession: this.rendererLeaveSession,
      }),
    });

    this.selfUin = String(options.selfUin || this.config.selfUin || "");
    this.selfUid = String(options.selfUid || "");
    this.selfNickname = String(options.selfNickname || this.config.selfNickname || "QQBot");
    this.startedAtMs = Number.isFinite(Number(options.startedAtMs))
      ? Number(options.startedAtMs)
      : Date.now();
    const isLiveElectron = Boolean(
      process.versions?.electron &&
        !options.ntApi &&
        !options.wrapperSession &&
        !options.rendererExecute
    );
    this.online = options.online !== undefined ? Boolean(options.online) : !isLiveElectron;
    this.lastQrCodeBase64 = "";

    this.capturedServices = {
      ntApi: options.ntApi || null, ntApiContainer: null, ntStore: null,
      WindowApi: null, PerformanceApi: null, LoggerApi: null,
      UserBehaviorReportService: null, SubWindowApi: null, ScreenRecordApi: null,
      ntCall: null, ntSessionManager: options.ntSessionManager || null,
      wrapperSession: options.wrapperSession || null,
    };

    this.rendererExecute = options.rendererExecute || null;
    this.rendererSimulateSession = options.rendererSimulateSession || null;
    this.rendererLeaveSession = options.rendererLeaveSession || null;
    this.activeWebContents = null;
    this._knownWebContents = new Set();
    this._attachedEmitters = new WeakSet();
    this._ipcAuthToken = crypto.randomBytes(32).toString("hex");
    this._pendingRendererCmds = new Map();
    this._ipcCmdAckInstalled = false;

    this._pttTextWaiters = new Map();
    this._richMediaWaiters = new Map();
    this._groupNotifiesCache = new BoundedMap(2000);
    this._buddyReqsCache = new BoundedMap(2000);
    this._groupListCache = new BoundedMap(2000);
    this._buddyCategoriesCache = [];
    this._groupListWaiters = new Set();
    this._buddyListWaiters = new Set();
    this._recentSentMsgByPeer = new BoundedMap(2000);

    this.invokeStats = {
      tier1: 0, tier2: 0, tier3: 0, degraded: 0,
      blockedReplays: 0, failed: 0, lastDegraded: null,
    };

    this._httpServers = [];
    this._wsServers = [];
    this._wsServerClients = new Set();
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    this.listenErrors = [];
    this._heartbeatTimer = null;
    this._wsPingTimer = null;
  }

  // --------------------------------------------------------------------------
  // Subsystem State Accessors & Delegates
  // --------------------------------------------------------------------------

  get _seenEventKeys() { return this.eventDedupe.entries; }
  set _seenEventKeys(v) { if (v instanceof Map) this.eventDedupe.entries = v; }
  get _tempCleanupRing() { return this.tempCleanupQueue.ring; }
  set _tempCleanupRing(v) { if (Array.isArray(v)) this.tempCleanupQueue._ring = v; }
  get _logThrottle() { return this.logger._throttleMap; }
  set _logThrottle(v) { if (v instanceof Map) this.logger._throttleMap = v; }
  get _sendEchoWaiters() { return this.echoCorrelator.waiters; }
  set _sendEchoWaiters(v) { if (v instanceof Map) this.echoCorrelator.waiters = v; }
  get sendEchoStats() { return this.echoCorrelator.stats; }
  set sendEchoStats(v) { if (v && typeof v === "object") this.echoCorrelator.stats = v; }
  get _activeAioPeer() { return this.sessionController.activeAioPeer; }
  set _activeAioPeer(v) { this.sessionController.activeAioPeer = v; }
  get _activeAioPeerKey() { return this.sessionController.activeAioPeerKey; }
  set _activeAioPeerKey(v) { this.sessionController.activeAioPeerKey = v; }
  get _windowFocused() { return this.sessionController.windowFocused; }
  set _windowFocused(v) { this.sessionController.windowFocused = Boolean(v); }
  get _aioIdleTimer() { return this.sessionController.aioIdleTimer; }
  set _aioIdleTimer(v) { this.sessionController.aioIdleTimer = v; }
  get _focusBlurTimer() { return this.sessionController.focusBlurTimer; }
  set _focusBlurTimer(v) { this.sessionController.focusBlurTimer = v; }
  get _aioInteractionSeq() { return this.sessionController.interactionSeq; }
  set _aioInteractionSeq(v) { this.sessionController.interactionSeq = Number(v) || 0; }
  get _recentReadByPeer() { return this.sessionController.recentReadByPeer; }
  get _recentTypingByPeer() { return this.sessionController.recentTypingByPeer; }
  get _sessionScheduler() { return this.sessionController.scheduler; }
  get wsClients() { return this._wsServerClients; }
  get reverseWsClients() { return this._reverseWsClients; }

  _safeJsJson(val) { return safeJsJson(val); }
  _setBoundedMap(map, key, value, maxEntries = 2000) { return setBoundedMap(map, key, value, maxEntries); }
  _logWarn(key, msg, windowMs = 60000) { return this.logger.warnThrottled(key, msg, windowMs); }
  _scheduleTempCleanup(cbs, immediate) { return this.tempCleanupQueue.schedule(cbs, immediate); }
  _scheduleMediaCleanup(media) { return this.tempCleanupQueue.scheduleMedia(media); }
  flushTempCleanup() { return this.tempCleanupQueue.flush(); }
  _isDuplicateEvent(key, ttlMs = 30000) { return this.eventDedupe.isDuplicate(key, ttlMs); }
  _canInvokeRendererBridge() { return Boolean(this._canInvokeRenderer?.(this.activeWebContents)); }
  _invokeRendererBridgeCommand(action, payload, timeoutMs) { return this._invokeRendererCommand(action, payload, timeoutMs); }

  _withAioLock(fn, options) { return this.sessionController.withLock(fn, options); }
  _clearAioIdleTimers() { return this.sessionController.clearIdleTimers(); }
  _clearIdleTimers() { return this.sessionController.clearIdleTimers(); }
  _resetSessionState(opts) { return this.sessionController.reset(opts || undefined); }
  _resetHumanSessionState(opts) { return this.sessionController.reset(opts || undefined); }
  _touchAioActivity() { return this.sessionController.touchActivity(); }
  _leaveSessionUnlocked(opts) { return this.sessionController.leaveUnlocked(opts); }
  _leaveSession(opts) { return this.sessionController.leave(opts); }
  leaveHumanSession(opts) { return this.sessionController.leave(opts); }
  _activateSessionUnlocked(opts) { return this.sessionController.activateUnlocked(opts); }
  simulateHumanSession(opts) { return this.sessionController.simulate(opts); }

  // --------------------------------------------------------------------------
  // Event Formatting & Broadcast
  // --------------------------------------------------------------------------

  _formatEventForEndpoint(eventObj, messageFormat) {
    if (
      messageFormat === "string" &&
      eventObj &&
      (eventObj.post_type === "message" || eventObj.post_type === "message_sent")
    ) {
      return {
        ...eventObj,
        message:
          typeof eventObj.raw_message === "string"
            ? eventObj.raw_message
            : Array.isArray(eventObj.message)
            ? segmentsToCqCode(eventObj.message)
            : String(eventObj.message ?? ""),
      };
    }
    return eventObj;
  }

  broadcastOneBotEvent(event) {
    if (!event || typeof event !== "object") return;
    if (!event.self_id && this.selfUin) {
      event.self_id = Number(this.selfUin);
    }
    const defaultFormat = this.config.messageFormat || "array";
    this.emit("onebot_event", this._formatEventForEndpoint(event, defaultFormat));

    for (const client of this._wsServerClients) {
      if (client.closed) {
        this._wsServerClients.delete(client);
        continue;
      }
      if (event.post_type === "message_sent" && !client.reportSelfMessage) continue;
      const targetFormat = client._messageFormat || defaultFormat;
      client.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    for (const rev of this._reverseWsClients) {
      if (!rev.conn || rev.conn.closed) continue;
      if (event.post_type === "message_sent" && !rev.cfg?.reportSelfMessage) continue;
      const targetFormat = rev.messageFormat || rev.cfg?.messageFormat || defaultFormat;
      rev.conn.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }
  }

  // --------------------------------------------------------------------------
  // Credential Helper Delegates & OneBot v11 Action Dispatcher
  // --------------------------------------------------------------------------

  async _fetchClientKey() {
    assertWebCredentialApiEnabled(this.config, "get_clientkey");
    return await fetchClientKey(this);
  }

  async _getCookiesObject(domain = "qun.qq.com") {
    assertWebCredentialApiEnabled(this.config, "get_cookies");
    return await getCookiesObject(this, domain, WEB_HTTP_HELPERS);
  }

  async handleOneBotAction(action, params = {}, echo = undefined, context = {}) {
    const act = String(action || "").replace(/^\/+/, "").trim();
    const p = params && typeof params === "object" ? params : {};

    try {
      const data = await this._dispatchAction(act, p, context);
      return {
        status: "ok",
        retcode: 0,
        data: data === undefined ? {} : data,
        message: "",
        wording: "",
        ...(echo !== undefined ? { echo } : {}),
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const retcode = Number(
        err?.retcode || (err?.code === "ERR_WEB_CREDENTIAL_API_DISABLED" ? 1403 : 1400)
      );
      return {
        status: "failed",
        retcode,
        data: null,
        message: msg,
        wording: msg,
        ...(echo !== undefined ? { echo } : {}),
      };
    }
  }

  async _dispatchAction(action, p, context = {}) {
    const handler = ACTION_DISPATCH_MAP.get(action);
    if (!handler) {
      throw new Error(`Unsupported OneBot action: ${action}`);
    }
    return await handler.call(this, action, p, context);
  }
}

NtqqOneBotBridge._ntElementsSignature = _ntElementsSignature;
NtqqOneBotBridge._elementsSignatureMatch = _elementsSignatureMatch;

Object.assign(
  NtqqOneBotBridge.prototype,
  ntCaptureMixin, rendererIpcMixin, inboundPipelineMixin, outboundPipelineMixin, serverRuntimeMixin
);

// ============================================================================
// Bootstrap & Public Exports
// ============================================================================

let singletonBridge = null;

function installMainBridge(options = {}) {
  if (singletonBridge && !options.forceNew) {
    if (options.config) {
      singletonBridge.config = options.config;
      singletonBridge
        .stopServers()
        .then(() => {
          if (options.autoStartServers !== false) return singletonBridge.startServers();
        })
        .catch(() => {});
    }
    return singletonBridge;
  }
  const bridge = new NtqqOneBotBridge(options);
  bridge.installMapPrototypeHook();
  bridge.installWrapperHook();
  bridge.installElectronHooks(options.electron);
  if (options.autoStartServers !== false) {
    bridge.startServers().catch(() => {});
  }
  singletonBridge = bridge;
  return bridge;
}

if (require.main !== module && !isAutoInstallDisabledFromEnv() && process.versions?.electron) {
  installMainBridge();
}

module.exports = {
  NtqqOneBotBridge, Rfc6455Connection, encodeWsFrame, connectReverseWebSocket,
  loadBridgeConfig, computeBkn, getNtqqVersionMetadata, buildNtqqUserAgent,
  pruneTempDir, installMainBridge,
};
