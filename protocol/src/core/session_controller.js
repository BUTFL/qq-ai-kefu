"use strict";

/**
 * Human Session Controller (`src/core/session_controller.js`)
 *
 * Standalone causal human-session state machine coordinating:
 * - Peer-affinity AIO serialization & switch cooldown via `CausalSessionScheduler`
 * - Tier 1 renderer session hooks / IPC commands with single-source state sync
 * - Transport-agnostic causal step runners (`runCausalActivateSteps`, `runCausalLeaveSteps`)
 * - Two-stage idle AIO exit (`aioIdleExitMs`) and window focus blur (`focusIdleBlurMs`)
 * - Bounded per-peer read/typing deduplication maps
 */

const { CausalSessionScheduler } = require("./session_scheduler");
const { BoundedMap, setBoundedMap } = require("./primitives");

async function runCausalLeaveSteps({
  shouldExitAio = false,
  shouldBlur = false,
  prevPeer = null,
  invokeNt,
} = {}) {
  let exitedAio = false;
  let blurredWindow = false;

  if (shouldExitAio && prevPeer) {
    try {
      await invokeNt("nodeIKernelMsgService/enterOrExitAio", {
        info: { peer: prevPeer, enterType: 2 },
      });
      exitedAio = true;
    } catch (_) {}
  }

  if (shouldBlur) {
    try {
      await invokeNt("nodeIKernelMsgService/setFocusOnBase", { isFocus: false });
      blurredWindow = true;
    } catch (_) {}
  }

  return { fallback: true, exitedAio, blurredWindow };
}

async function runCausalActivateSteps({
  peer,
  peerKey,
  prevPeer,
  prevPeerKey,
  windowFocused = false,
  shouldMarkRead = false,
  shouldSendTyping = false,
  effEventType = 1,
  readToTypingDelayMs = 0,
  invokeNt,
  sleepUnref,
} = {}) {
  const resolvedPeerKey =
    peerKey !== undefined && peerKey !== null && String(peerKey) !== ""
      ? String(peerKey)
      : `${Number(peer?.chatType || 1)}:${String(peer?.peerUid || "")}:${String(peer?.guildId || "")}`;
  const normPrevPeerKey = String(prevPeerKey || "");

  let didFocus = false;
  let focused = Boolean(windowFocused);
  if (!focused) {
    try {
      await invokeNt("nodeIKernelMsgService/setFocusOnBase", { isFocus: true });
      didFocus = true;
      focused = true;
    } catch (_) {}
  } else {
    didFocus = true;
  }

  let exitedPreviousAio = false;
  const alreadyInAio = normPrevPeerKey === resolvedPeerKey;
  if (!alreadyInAio) {
    if (prevPeer && normPrevPeerKey) {
      try {
        await invokeNt("nodeIKernelMsgService/enterOrExitAio", {
          info: { peer: prevPeer, enterType: 2 },
        });
        exitedPreviousAio = true;
      } catch (_) {}
    }
    try {
      await invokeNt("nodeIKernelMsgService/addActiveChatByUid", { peer });
    } catch (_) {}
    try {
      await invokeNt("nodeIKernelMsgService/enterOrExitAio", {
        info: { peer, enterType: 1 },
      });
    } catch (_) {}
  }

  let didMarkRead = false;
  let didSendTyping = false;

  if (shouldMarkRead) {
    try {
      await invokeNt("nodeIKernelMsgService/setMsgRead", { peer }, [peer]);
      didMarkRead = true;
    } catch (_) {}
  }

  if (shouldMarkRead && shouldSendTyping && readToTypingDelayMs > 0) {
    if (typeof sleepUnref === "function") {
      await sleepUnref(readToTypingDelayMs);
    } else {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, readToTypingDelayMs);
        if (typeof timer.unref === "function") timer.unref();
      });
    }
  }

  if (shouldSendTyping) {
    const resolvedEventType = Number(effEventType ?? 1);
    try {
      await invokeNt(
        "nodeIKernelMsgService/sendShowInputStatusReq",
        { eventType: resolvedEventType, peer },
        [1, resolvedEventType, peer.peerUid]
      );
      didSendTyping = true;
    } catch (_) {}
  }

  return {
    fallback: true,
    alreadyInAio,
    exitedPreviousAio,
    setFocusOnBase: didFocus,
    markRead: didMarkRead,
    sendTyping: didSendTyping,
    focused,
  };
}

class HumanSessionController {
  constructor({
    getConfig,
    config,
    invokeNt,
    canInvokeRenderer,
    invokeRendererCommand,
    getRendererHooks,
  } = {}) {
    this._getConfig =
      typeof getConfig === "function"
        ? getConfig
        : () => (config && typeof config === "object" ? config : {});
    this._invokeNt =
      typeof invokeNt === "function" ? invokeNt : async () => undefined;
    this._canInvokeRenderer =
      typeof canInvokeRenderer === "function" ? canInvokeRenderer : () => false;
    this._invokeRendererCommand =
      typeof invokeRendererCommand === "function"
        ? invokeRendererCommand
        : async () => null;
    this._getRendererHooks =
      typeof getRendererHooks === "function"
        ? getRendererHooks
        : () => ({ simulateSession: null, leaveSession: null });

    this.activeAioPeer = null;
    this.activeAioPeerKey = "";
    this.windowFocused = false;
    this.interactionSeq = 0;
    this.aioIdleTimer = null;
    this.focusBlurTimer = null;
    this.recentReadByPeer = new BoundedMap(2000);
    this.recentTypingByPeer = new BoundedMap(2000);

    const initCfg = this._getConfig() || {};
    this._lastCfgSwitchCooldown = initCfg.aioSwitchCooldownMs;
    this._lastCfgEnforceCooldown = initCfg.enforceSwitchCooldownOnSend;
    this.scheduler = new CausalSessionScheduler({
      getActivePeerKey: () => this.activeAioPeerKey,
      switchCooldownMs: initCfg.aioSwitchCooldownMs ?? 800,
      enforceHardCooldownOnExplicit: Boolean(initCfg.enforceSwitchCooldownOnSend),
    });
  }

  _syncSchedulerConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    if (cfg.aioSwitchCooldownMs !== this._lastCfgSwitchCooldown) {
      this._lastCfgSwitchCooldown = cfg.aioSwitchCooldownMs;
      const raw = Number(cfg.aioSwitchCooldownMs ?? 800);
      if (Number.isFinite(raw) && raw >= 0) {
        this.scheduler.switchCooldownMs = raw;
      }
    }
    if (cfg.enforceSwitchCooldownOnSend !== this._lastCfgEnforceCooldown) {
      this._lastCfgEnforceCooldown = cfg.enforceSwitchCooldownOnSend;
      this.scheduler.enforceHardCooldownOnExplicit = Boolean(cfg.enforceSwitchCooldownOnSend);
    }
  }

  withLock(fn, options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    return this.scheduler.runExclusive(opts.peerKey || "", fn, opts);
  }

  clearIdleTimers() {
    if (this.aioIdleTimer) {
      clearTimeout(this.aioIdleTimer);
      this.aioIdleTimer = null;
    }
    if (this.focusBlurTimer) {
      clearTimeout(this.focusBlurTimer);
      this.focusBlurTimer = null;
    }
  }

  reset({ resetRenderer = false } = {}) {
    this.interactionSeq += 1;
    this.clearIdleTimers();
    this.scheduler.dispose();
    this.activeAioPeer = null;
    this.activeAioPeerKey = "";
    this.windowFocused = false;
    this.recentReadByPeer.clear();
    this.recentTypingByPeer.clear();
    if (resetRenderer && this._canInvokeRenderer()) {
      Promise.resolve(this._invokeRendererCommand("resetSession", {}, 5000)).catch(() => {});
    }
  }

  touchActivity() {
    this.interactionSeq += 1;
    const seq = this.interactionSeq;
    this.clearIdleTimers();
    const cfg = this._getConfig() || {};
    if (cfg.humanSimulation === false) return;

    const aioIdleMs = Number(cfg.aioIdleExitMs ?? 45000);
    if (aioIdleMs > 0) {
      this.aioIdleTimer = setTimeout(() => {
        this.aioIdleTimer = null;
        if (seq !== this.interactionSeq || !this.activeAioPeer) return;
        this.withLock(async () => {
          if (seq !== this.interactionSeq || !this.activeAioPeer) return;
          await this.leaveUnlocked({ exitAio: true, blurWindow: false });
        }).catch(() => {});
      }, aioIdleMs);
      if (typeof this.aioIdleTimer.unref === "function") this.aioIdleTimer.unref();
    }

    const focusBlurMs = Number(cfg.focusIdleBlurMs ?? 300000);
    if (focusBlurMs > 0) {
      this.focusBlurTimer = setTimeout(() => {
        this.focusBlurTimer = null;
        if (seq !== this.interactionSeq || (!this.windowFocused && !this.activeAioPeer)) {
          return;
        }
        this.withLock(async () => {
          if (seq !== this.interactionSeq || (!this.windowFocused && !this.activeAioPeer)) {
            return;
          }
          await this.leaveUnlocked({ exitAio: true, blurWindow: true });
        }).catch(() => {});
      }, focusBlurMs);
      if (typeof this.focusBlurTimer.unref === "function") this.focusBlurTimer.unref();
    }
  }

  _commitLeftState({ shouldExitAio, shouldBlur }) {
    if (shouldExitAio) {
      this.activeAioPeer = null;
      this.activeAioPeerKey = "";
    }
    if (shouldBlur) {
      this.windowFocused = false;
    }
  }

  async leaveUnlocked({ exitAio = true, blurWindow = false } = {}) {
    const shouldExitAio = Boolean(exitAio && this.activeAioPeer && this.activeAioPeerKey);
    const shouldBlur = Boolean(blurWindow && this.windowFocused);
    if (!shouldExitAio && !shouldBlur) {
      return { exitedAio: false, blurredWindow: false };
    }

    const leaveOpts = {
      exitAio: shouldExitAio,
      blurWindow: shouldBlur,
      knownActivePeer: this.activeAioPeer,
      knownActivePeerKey: this.activeAioPeerKey,
      knownFocused: this.windowFocused,
    };

    const hooks = this._getRendererHooks() || {};
    if (typeof hooks.leaveSession === "function") {
      try {
        const res = await hooks.leaveSession(leaveOpts);
        if (res !== undefined && res !== null) {
          this._commitLeftState({ shouldExitAio, shouldBlur });
          return res;
        }
      } catch (_) {}
    }

    if (this._canInvokeRenderer()) {
      try {
        const res = await this._invokeRendererCommand("leaveSession", { opts: leaveOpts }, 8000);
        if (res && typeof res === "object" && ("exitedAio" in res || "blurredWindow" in res)) {
          this._commitLeftState({ shouldExitAio, shouldBlur });
          return res;
        }
      } catch (_) {}
    }

    const prevPeer = this.activeAioPeer;
    this._commitLeftState({ shouldExitAio, shouldBlur });
    return await runCausalLeaveSteps({
      shouldExitAio,
      shouldBlur,
      prevPeer,
      invokeNt: this._invokeNt,
    });
  }

  async leave(opts) {
    return this.withLock(() => this.leaveUnlocked(opts));
  }

  _commitActivatedState({
    peer,
    peerKey,
    prevPeerKey,
    shouldMarkRead,
    shouldSendTyping,
    effEventType,
    res,
  }) {
    this.windowFocused = res?.focused !== undefined ? Boolean(res.focused) : true;
    this.activeAioPeer = peer;
    this.activeAioPeerKey = peerKey;
    if (prevPeerKey !== this.activeAioPeerKey) {
      this.scheduler.recordSwitch(this.activeAioPeerKey);
    }
    if (shouldMarkRead && res?.markRead !== false) {
      setBoundedMap(this.recentReadByPeer, peerKey, Date.now());
    }
    if (shouldSendTyping && effEventType === 1 && res?.sendTyping !== false) {
      setBoundedMap(this.recentTypingByPeer, peerKey, Date.now());
    }
    this.touchActivity();
    return res;
  }

  async activateUnlocked(opts = {}) {
    const peer = {
      chatType: Number(opts?.chatType || 1),
      peerUid: String(opts?.peerUid || ""),
      guildId: String(opts?.guildId || ""),
    };
    if (!peer.peerUid) return null;

    const cfg = this._getConfig() || {};
    this._syncSchedulerConfig(cfg);

    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId}`;
    const prevPeer = this.activeAioPeer;
    const prevPeerKey = this.activeAioPeerKey;
    const switchDecision = this.scheduler.shouldAllowSwitch(peerKey, {
      advisory: Boolean(opts?.advisory),
    });
    if (!switchDecision.allowed) {
      return {
        skippedByCooldown: true,
        activeAioPeer: this.activeAioPeer,
        activeAioPeerKey: this.activeAioPeerKey,
        focused: this.windowFocused,
      };
    }
    if (switchDecision.waitMs > 0) {
      await this.scheduler.sleepUnref(switchDecision.waitMs);
    }

    const now = Date.now();
    const dedupeMs = Number(opts?.dedupeWindowMs ?? cfg?.dedupeWindowMs ?? 5000);
    const effEventType = Number(opts?.eventType ?? 1);
    const shouldMarkRead =
      Boolean(opts?.markRead) && now - (this.recentReadByPeer.get(peerKey) || 0) >= dedupeMs;
    const shouldSendTyping =
      Boolean(opts?.sendTyping && peer.chatType === 1) &&
      (effEventType !== 1 || now - (this.recentTypingByPeer.get(peerKey) || 0) >= dedupeMs);
    const delaySpec =
      opts?.readToTypingDelayMs !== undefined
        ? opts.readToTypingDelayMs
        : cfg.humanReadToTypingDelayMs;
    const readToTypingDelayMs =
      shouldMarkRead && shouldSendTyping
        ? this.scheduler.computeDelayMs(delaySpec, 0)
        : 0;

    const effectiveOpts = {
      ...opts,
      chatType: peer.chatType,
      peerUid: peer.peerUid,
      guildId: peer.guildId,
      markRead: shouldMarkRead,
      sendTyping: shouldSendTyping,
      readToTypingDelayMs,
      eventType: effEventType,
      dedupeWindowMs: dedupeMs,
      bypassDedupe: true,
      knownActivePeer: this.activeAioPeer,
      knownActivePeerKey: this.activeAioPeerKey,
      knownFocused: this.windowFocused,
    };

    const hooks = this._getRendererHooks() || {};
    if (typeof hooks.simulateSession === "function") {
      try {
        const res = await hooks.simulateSession(effectiveOpts);
        if (res !== undefined && res !== null) {
          return this._commitActivatedState({
            peer,
            peerKey,
            prevPeerKey,
            shouldMarkRead,
            shouldSendTyping,
            effEventType,
            res,
          });
        }
      } catch (_) {}
    }

    if (this._canInvokeRenderer()) {
      try {
        const res = await this._invokeRendererCommand(
          "simulateSession",
          { opts: effectiveOpts },
          10000
        );
        if (res && typeof res === "object" && ("enterOrExitAio" in res || "alreadyInAio" in res)) {
          return this._commitActivatedState({
            peer,
            peerKey,
            prevPeerKey,
            shouldMarkRead,
            shouldSendTyping,
            effEventType,
            res,
          });
        }
      } catch (_) {}
    }

    const fallbackRes = await runCausalActivateSteps({
      peer,
      peerKey,
      prevPeer,
      prevPeerKey,
      windowFocused: this.windowFocused,
      shouldMarkRead,
      shouldSendTyping,
      effEventType,
      readToTypingDelayMs,
      invokeNt: this._invokeNt,
      sleepUnref: (ms) => this.scheduler.sleepUnref(ms),
    });
    return this._commitActivatedState({
      peer,
      peerKey,
      prevPeerKey,
      shouldMarkRead,
      shouldSendTyping,
      effEventType,
      res: fallbackRes,
    });
  }

  async simulate(opts = {}) {
    const peerKey = opts?.peerUid
      ? `${Number(opts.chatType || 1)}:${String(opts.peerUid)}:${String(opts.guildId || "")}`
      : "";
    return this.withLock(() => this.activateUnlocked(opts), {
      peerKey,
      advisory: Boolean(opts?.advisory),
    });
  }
}

module.exports = {
  HumanSessionController,
  runCausalActivateSteps,
  runCausalLeaveSteps,
};
