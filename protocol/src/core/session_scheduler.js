"use strict";

const crypto = require("crypto");

/**
 * CausalSessionScheduler (`src/core/session_scheduler.js`)
 *
 * Upgrades AIO mutex serialization and human session-switch scheduling:
 * - Peer-affinity exclusive mutex queue with starvation cap (`maxAffinityStreak`)
 *   and non-advisory priority over `advisory: true` background tasks.
 * - High-frequency session switch cooldown (`shouldAllowSwitch` / `recordSwitch`).
 * - Jittered human delay helper (`computeDelayMs` / `sleepUnref`) with full handle
 *   tracking so `dispose()` cancels all timers immediately without leaking handles.
 * - Coalesced private-message auto-read/typing reaction scheduler per `peerKey`.
 */
class CausalSessionScheduler {
  constructor(options = {}) {
    this._customGetActivePeerKey =
      typeof options.getActivePeerKey === "function" ? options.getActivePeerKey : null;

    const rawMaxStreak = Number(options.maxAffinityStreak);
    this.maxAffinityStreak =
      Number.isFinite(rawMaxStreak) && rawMaxStreak >= 0 ? Math.floor(rawMaxStreak) : 8;

    const rawCooldown = Number(options.switchCooldownMs);
    this.switchCooldownMs =
      Number.isFinite(rawCooldown) && rawCooldown >= 0 ? rawCooldown : 800;

    this.enforceHardCooldownOnExplicit = Boolean(options.enforceHardCooldownOnExplicit);
    this.defaultPrivateRecvDelay =
      options.defaultPrivateRecvDelay !== undefined
        ? options.defaultPrivateRecvDelay
        : [500, 1800];

    this._locked = false;
    this._queue = [];
    this._affinityStreak = 0;

    this.lastSwitchAt = 0;
    this.lastPeerKey = "";
    this._hasSwitched = false;

    this._activeTimers = new Set();
    this._activeSleeps = new Set();
    this._peerReactions = new Map();
  }

  getActivePeerKey() {
    if (this._customGetActivePeerKey) {
      return String(this._customGetActivePeerKey() || "");
    }
    return this.lastPeerKey;
  }

  get isLocked() {
    return this._locked;
  }

  get queueLength() {
    return this._queue.length;
  }

  get pendingReactionCount() {
    return this._peerReactions.size;
  }

  /**
   * Executes `taskFn` with strict mutual exclusion over AIO session operations.
   * Supports both `runExclusive(peerKey, taskFn, options)` and `runExclusive(taskFn, options)`.
   */
  runExclusive(peerKey, taskFn, options = {}) {
    if (typeof peerKey === "function") {
      options = taskFn && typeof taskFn === "object" ? taskFn : {};
      taskFn = peerKey;
      peerKey = options.peerKey || "";
    }
    if (typeof taskFn !== "function") {
      return Promise.reject(new TypeError("taskFn must be a function"));
    }

    const normPeerKey = peerKey ? String(peerKey) : "";
    const advisory = Boolean(options && options.advisory);

    return new Promise((resolve, reject) => {
      const waiter = {
        peerKey: normPeerKey,
        advisory,
        taskFn,
        resolve,
        reject,
      };

      if (!this._locked) {
        this._locked = true;
        this._affinityStreak = 0;
        this._executeWaiter(waiter);
      } else {
        this._queue.push(waiter);
      }
    });
  }

  _executeWaiter(waiter) {
    Promise.resolve()
      .then(() => waiter.taskFn())
      .then(
        (result) => {
          this._advanceQueue();
          waiter.resolve(result);
        },
        (err) => {
          this._advanceQueue();
          waiter.reject(err);
        }
      );
  }

  _advanceQueue() {
    if (this._queue.length === 0) {
      this._locked = false;
      this._affinityStreak = 0;
      return;
    }

    const activePeerKey = this.getActivePeerKey();
    let chosenIdx = -1;

    if (activePeerKey && this._affinityStreak < this.maxAffinityStreak) {
      chosenIdx = this._queue.findIndex(
        (w) => !w.advisory && w.peerKey && w.peerKey === activePeerKey
      );
      if (chosenIdx === -1) {
        chosenIdx = this._queue.findIndex((w) => w.peerKey && w.peerKey === activePeerKey);
      }
      if (chosenIdx !== -1) {
        const [nextWaiter] = this._queue.splice(chosenIdx, 1);
        this._affinityStreak += 1;
        this._executeWaiter(nextWaiter);
        return;
      }
    }

    chosenIdx = this._queue.findIndex((w) => !w.advisory);
    if (chosenIdx === -1) {
      chosenIdx = 0;
    }
    const [nextWaiter] = this._queue.splice(chosenIdx, 1);
    this._affinityStreak = 0;
    this._executeWaiter(nextWaiter);
  }

  /**
   * Evaluates whether switching AIO focus to `targetPeerKey` should proceed, wait, or skip.
   */
  shouldAllowSwitch(targetPeerKey, { advisory = false, now = Date.now() } = {}) {
    const normTarget = targetPeerKey ? String(targetPeerKey) : "";
    const activePeerKey = this.getActivePeerKey();

    if (!normTarget || normTarget === activePeerKey) {
      return { allowed: true, waitMs: 0 };
    }

    if ((!this._hasSwitched && this.lastSwitchAt === 0) || this.switchCooldownMs <= 0) {
      return { allowed: true, waitMs: 0 };
    }

    const elapsed = Number(now) - this.lastSwitchAt;
    const remainingMs = this.switchCooldownMs - elapsed;
    if (remainingMs <= 0) {
      return { allowed: true, waitMs: 0 };
    }

    if (advisory === true) {
      return {
        allowed: false,
        skippedByCooldown: true,
        remainingMs,
      };
    }

    if (this.enforceHardCooldownOnExplicit === true) {
      return {
        allowed: true,
        waitMs: remainingMs,
      };
    }

    return { allowed: true, waitMs: 0 };
  }

  /**
   * Records an AIO switch to `targetPeerKey` at `now`.
   */
  recordSwitch(targetPeerKey, now = Date.now()) {
    const normTarget = targetPeerKey ? String(targetPeerKey) : "";
    if (!normTarget) return;
    this._hasSwitched = true;
    this.lastPeerKey = normTarget;
    this.lastSwitchAt = Number(now);
  }

  /**
   * Computes a concrete non-negative integer delay in milliseconds from a fixed number
   * or `[minMs, maxMs]` jitter range using `crypto.randomInt`.
   */
  computeDelayMs(spec, fallbackMs = 0) {
    if (typeof spec === "number") {
      if (Number.isFinite(spec) && spec >= 0) {
        return Math.floor(spec);
      }
      return this._resolveFallbackDelay(fallbackMs);
    }

    if (typeof spec === "string" && spec.trim() !== "") {
      const parsed = Number(spec);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
    }

    if (Array.isArray(spec)) {
      if (spec.length === 1) {
        return this.computeDelayMs(spec[0], fallbackMs);
      }
      if (spec.length >= 2) {
        const rawMin = Number(spec[0]);
        const rawMax = Number(spec[1]);
        if (Number.isFinite(rawMin) && Number.isFinite(rawMax) && rawMin >= 0 && rawMax >= 0) {
          const min = Math.floor(Math.min(rawMin, rawMax));
          const max = Math.floor(Math.max(rawMin, rawMax));
          if (max > min) {
            return crypto.randomInt(min, max + 1);
          }
          return min;
        }
      }
    }

    return this._resolveFallbackDelay(fallbackMs);
  }

  _resolveFallbackDelay(fallbackMs) {
    if (Array.isArray(fallbackMs)) {
      return this.computeDelayMs(fallbackMs, 0);
    }
    const n = Number(fallbackMs);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /**
   * Sleeps for `ms` milliseconds using an `.unref()`ed timer tracked in `_activeTimers`
   * so `dispose()` cancels and resolves pending sleeps immediately on shutdown.
   */
  sleepUnref(ms) {
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const sleepRecord = { timer: null, resolve };
      const timer = setTimeout(() => {
        this._activeTimers.delete(timer);
        this._activeSleeps.delete(sleepRecord);
        resolve();
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
      sleepRecord.timer = timer;
      this._activeTimers.add(timer);
      this._activeSleeps.add(sleepRecord);
    });
  }

  /**
   * Coalesces rapid incoming private messages per `peerKey` into a single delayed reaction.
   */
  schedulePrivateRecvReaction(peerKey, delaySpec, callback) {
    if (typeof delaySpec === "function") {
      callback = delaySpec;
      delaySpec = undefined;
    }
    const key = peerKey ? String(peerKey) : "";
    if (!key || typeof callback !== "function") {
      return null;
    }

    this.cancelPeerReaction(key);

    const effectiveSpec =
      delaySpec !== undefined && delaySpec !== null ? delaySpec : this.defaultPrivateRecvDelay;
    const delayMs = this.computeDelayMs(effectiveSpec, 500);

    const entry = { peerKey: key, timer: null, delayMs };
    const timer = setTimeout(() => {
      this._activeTimers.delete(timer);
      if (this._peerReactions.get(key) === entry) {
        this._peerReactions.delete(key);
      }
      Promise.resolve()
        .then(() => callback(key))
        .catch(() => {});
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();

    entry.timer = timer;
    this._activeTimers.add(timer);
    this._peerReactions.set(key, entry);

    return {
      peerKey: key,
      delayMs,
      cancel: () => this.cancelPeerReaction(key),
    };
  }

  hasPendingReaction(peerKey) {
    return this._peerReactions.has(String(peerKey || ""));
  }

  cancelPeerReaction(peerKey) {
    const key = peerKey ? String(peerKey) : "";
    const entry = this._peerReactions.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._activeTimers.delete(entry.timer);
    this._peerReactions.delete(key);
    return true;
  }

  cancelAllReactions() {
    for (const entry of this._peerReactions.values()) {
      clearTimeout(entry.timer);
      this._activeTimers.delete(entry.timer);
    }
    this._peerReactions.clear();
  }

  /**
   * Immediately cancels all pending reaction timers and sleep timers without leaking handles.
   */
  dispose() {
    this.cancelAllReactions();
    for (const sleepRecord of this._activeSleeps) {
      clearTimeout(sleepRecord.timer);
      this._activeTimers.delete(sleepRecord.timer);
      sleepRecord.resolve();
    }
    this._activeSleeps.clear();
    for (const timer of this._activeTimers) {
      clearTimeout(timer);
    }
    this._activeTimers.clear();
    this._affinityStreak = 0;
  }
}

module.exports = {
  CausalSessionScheduler,
};
