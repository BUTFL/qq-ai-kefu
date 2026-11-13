"use strict";

const fs = require("fs");
const { isQuietLogsEnabled, isDebugLogsEnabled } = require("./env");

/**
 * Shared Zero-Dependency Runtime Primitives (`src/core/primitives.js`)
 *
 * Provides bounded LRU maps, TTL event deduplication, bounded temp-file cleanup
 * queues, one-shot event waiters, rate-limited stderr logging, lossless cross-process
 * IPC payload serialization, and declarative OneBot v11 action routing.
 */

// ============================================================================
// 1. BoundedMap & setBoundedMap
// ============================================================================

class BoundedMap extends Map {
  /**
   * @param {number} [maxEntries=2000]
   * @param {Iterable<readonly [any, any]>} [iterable]
   */
  constructor(maxEntries = 2000, iterable = undefined) {
    super();
    const parsed = Number(maxEntries);
    this.maxEntries = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 2000;
    if (iterable !== undefined && iterable !== null) {
      for (const entry of iterable) {
        if (entry && typeof entry === "object") {
          this.set(entry[0], entry[1]);
        }
      }
    }
  }

  /**
   * Reads `key` and refreshes its recency order (LRU) when present.
   *
   * @param {any} key
   * @returns {any}
   */
  get(key) {
    if (!super.has(key)) return undefined;
    const val = super.get(key);
    super.delete(key);
    super.set(key, val);
    return val;
  }

  /**
   * Inserts or updates `key`, refreshing insertion order (LRU) and evicting
   * oldest entries while `this.size > this.maxEntries`.
   *
   * @param {any} key
   * @param {any} value
   * @returns {this}
   */
  set(key, value) {
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    const limit = this.maxEntries > 0 ? this.maxEntries : 2000;
    while (super.size > limit) {
      const first = super.keys().next();
      if (first.done) break;
      super.delete(first.value);
    }
    return this;
  }
}

/**
 * Sets `(key, value)` on either a `BoundedMap` or plain `Map` with LRU order refresh
 * and oldest-entry eviction.
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} [maxEntries]
 * @returns {Map<K, V>}
 */
function setBoundedMap(map, key, value, maxEntries = undefined) {
  if (!map || typeof map.set !== "function") return map;
  const fallbackMax = map instanceof BoundedMap ? map.maxEntries : 2000;
  const parsed = maxEntries !== undefined ? Number(maxEntries) : fallbackMax;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallbackMax;

  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > limit) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
  return map;
}

// ============================================================================
// 2. TtlDedupeSet
// ============================================================================

class TtlDedupeSet {
  /**
   * @param {number} [maxEntries=5000]
   * @param {number} [defaultTtlMs=30000]
   */
  constructor(maxEntries = 5000, defaultTtlMs = 30000) {
    const parsedMax = Number(maxEntries);
    const parsedTtl = Number(defaultTtlMs);
    this.maxEntries = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.trunc(parsedMax) : 5000;
    this.defaultTtlMs = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : 30000;
    /** @type {Map<string, number>} */
    this.entries = new Map();
  }

  /**
   * Checks whether `key` was seen within `ttlMs`. If not (or expired), records
   * the current timestamp and evicts oldest entries beyond `this.maxEntries`.
   *
   * @param {string} key
   * @param {number} [ttlMs=this.defaultTtlMs]
   * @returns {boolean}
   */
  isDuplicate(key, ttlMs = this.defaultTtlMs) {
    if (!key) return false;
    const now = Date.now();
    const effectiveTtl =
      ttlMs !== undefined && Number.isFinite(Number(ttlMs))
        ? Math.max(0, Number(ttlMs))
        : this.defaultTtlMs;
    const prev = this.entries.get(key);
    if (prev !== undefined && now - prev < effectiveTtl) {
      return true;
    }
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, now);
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next();
      if (first.done) break;
      this.entries.delete(first.value);
    }
    return false;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

// ============================================================================
// 3. TempCleanupQueue
// ============================================================================

class TempCleanupQueue {
  /**
   * @param {(() => Record<string, any>) | Record<string, any>} [getConfig]
   */
  constructor(getConfig = () => ({})) {
    this._getConfig =
      typeof getConfig === "function"
        ? getConfig
        : () => (getConfig && typeof getConfig === "object" ? getConfig : {});
    /** @type {Array<() => void>} */
    this._ring = [];
  }

  /**
   * Underlying ring buffer of idempotent cleanup functions.
   * @returns {Array<() => void>}
   */
  get ring() {
    return this._ring;
  }

  /**
   * Schedules one or more cleanup callbacks either immediately or after
   * `tempCleanupDelayMs`, bounded by `maxTempCleanupRing`.
   *
   * @param {Array<() => void> | (() => void)} [cleanupCallbacks=[]]
   * @param {boolean} [immediate=false]
   */
  schedule(cleanupCallbacks = [], immediate = false) {
    const callbacks =
      typeof cleanupCallbacks === "function" ? [cleanupCallbacks] : cleanupCallbacks;
    if (!Array.isArray(callbacks) || callbacks.length === 0) return;

    const cfg = this._getConfig() || {};
    if (immediate || cfg.cleanupTempImmediately) {
      for (const fn of callbacks) {
        try {
          if (typeof fn === "function") fn();
        } catch (_) {}
      }
      return;
    }

    const maxRing = Math.max(8, Number(cfg.maxTempCleanupRing || 64));
    const delayMs = Math.max(0, Number(cfg.tempCleanupDelayMs ?? 5000));

    for (const fn of callbacks) {
      if (typeof fn !== "function") continue;
      let called = false;
      let timer = null;
      const runOnce = () => {
        if (called) return;
        called = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const idx = this._ring.indexOf(runOnce);
        if (idx >= 0) {
          this._ring.splice(idx, 1);
        }
        try {
          fn();
        } catch (_) {}
      };
      timer = setTimeout(runOnce, delayMs);
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
      this._ring.push(runOnce);
      while (this._ring.length > maxRing) {
        const oldest = this._ring.shift();
        if (typeof oldest === "function") oldest();
      }
    }
  }

  /**
   * Schedules cleanup for a resolved media descriptor (`media.cleanup` or temp `localPath`).
   *
   * @param {{ cleanup?: () => void, isTempFile?: boolean, localPath?: string } | null | undefined} media
   */
  scheduleMedia(media) {
    if (!media) return;
    if (typeof media.cleanup === "function") {
      this.schedule(media.cleanup);
      return;
    }
    if (media.isTempFile && media.localPath) {
      const tempPath = media.localPath;
      this.schedule(() => {
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (_) {}
      });
    }
  }

  /**
   * Immediately executes and drains all pending cleanup callbacks.
   */
  flush() {
    while (this._ring.length > 0) {
      const fn = this._ring.shift();
      if (typeof fn === "function") {
        try {
          fn();
        } catch (_) {}
      }
    }
  }
}

// ============================================================================
// 4. One-Shot Event Waiters
// ============================================================================

/**
 * Registers a one-shot listener into `waiterSet` with an unref'd timeout and
 * an explicit `cancel()` handle.
 *
 * @template T
 * @param {Set<(payload: T, ...rest: any[]) => void>} waiterSet
 * @param {number} timeoutMs
 * @param {((payload: T, ...rest: any[]) => boolean) | null} [predicate=null]
 * @returns {{ promise: Promise<T | null>, cancel: () => void }}
 */
function createEventWaiter(waiterSet, timeoutMs, predicate = null) {
  if (!waiterSet || typeof waiterSet.add !== "function" || typeof waiterSet.delete !== "function") {
    return {
      promise: Promise.resolve(null),
      cancel: () => {},
    };
  }

  const hasPredicate = typeof predicate === "function";
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  let settled = false;
  let timer = null;
  let resolvePromise = null;

  const listener = (arg, ...rest) => {
    if (settled) return;
    if (hasPredicate) {
      let matched = false;
      try {
        matched = Boolean(predicate(arg, ...rest));
      } catch (_) {
        matched = false;
      }
      if (!matched) return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    waiterSet.delete(listener);
    if (resolvePromise) {
      const r = resolvePromise;
      resolvePromise = null;
      r(arg);
    }
  };

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = null;
      waiterSet.delete(listener);
      resolvePromise = null;
      resolve(null);
    }, waitMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    waiterSet.add(listener);
  });

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    waiterSet.delete(listener);
    if (!settled) {
      settled = true;
      if (resolvePromise) {
        const r = resolvePromise;
        resolvePromise = null;
        r(null);
      }
    }
  };

  return { promise, cancel };
}

/**
 * Awaits a single matching event from `waiterSet`, resolving to `null` on timeout.
 *
 * @template T
 * @param {Set<(payload: T, ...rest: any[]) => void>} waiterSet
 * @param {number} timeoutMs
 * @param {((payload: T, ...rest: any[]) => boolean) | null} [predicate=null]
 * @returns {Promise<T | null>}
 */
function waitForEventOnce(waiterSet, timeoutMs, predicate = null) {
  return createEventWaiter(waiterSet, timeoutMs, predicate).promise;
}

// ============================================================================
// 5. BridgeLogger
// ============================================================================

function _formatLogValue(val) {
  if (val === undefined || val === null) return "";
  if (val instanceof Error) {
    return val.message || String(val);
  }
  if (typeof val === "object" && typeof val.message === "string") {
    return val.message;
  }
  return String(val);
}

class BridgeLogger {
  /**
   * @param {object} [options]
   * @param {() => Record<string, any>} [options.getConfig]
   * @param {string} [options.prefix="[rosmontis]"]
   * @param {number} [options.maxThrottleEntries=500]
   * @param {(cfg: Record<string, any>) => boolean} [options.isQuiet]
   * @param {(cfg: Record<string, any>) => boolean} [options.isDebug]
   * @param {(line: string) => void} [options.write]
   */
  constructor({
    getConfig = () => ({}),
    prefix = "[rosmontis]",
    maxThrottleEntries = 500,
    isQuiet = undefined,
    isDebug = undefined,
    write = undefined,
  } = {}) {
    this._getConfig =
      typeof getConfig === "function"
        ? getConfig
        : () => (getConfig && typeof getConfig === "object" ? getConfig : {});
    this.prefix = String(prefix || "[rosmontis]");
    this._throttleMap = new BoundedMap(maxThrottleEntries);
    this._isQuietFn = typeof isQuiet === "function" ? isQuiet : null;
    this._isDebugFn = typeof isDebug === "function" ? isDebug : null;
    this._writeFn =
      typeof write === "function" ? write : (chunk) => process.stderr.write(chunk);
  }

  _isQuiet(cfg) {
    if (this._isQuietFn) {
      return Boolean(this._isQuietFn(cfg));
    }
    return Boolean(isQuietLogsEnabled(cfg));
  }

  _isDebug(cfg) {
    if (this._isDebugFn) {
      return Boolean(this._isDebugFn(cfg));
    }
    return Boolean(isDebugLogsEnabled(cfg));
  }

  _emit(line) {
    try {
      this._writeFn(`${line}\n`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Emits a debug diagnostic when debug logging is enabled and quiet mode is off.
   *
   * @param {string} scope
   * @param {any} [errOrMsg]
   * @returns {boolean}
   */
  debug(scope, errOrMsg) {
    const cfg = this._getConfig() || {};
    if (this._isQuiet(cfg) || !this._isDebug(cfg)) return false;
    if (errOrMsg === undefined) {
      return this._emit(`${this.prefix} DEBUG: ${_formatLogValue(scope)}`);
    }
    return this._emit(`${this.prefix} DEBUG [${scope}]: ${_formatLogValue(errOrMsg)}`);
  }

  /**
   * Emits an unthrottled warning to stderr unless quiet mode is enabled.
   *
   * @param {string} msg
   * @returns {boolean}
   */
  warn(msg) {
    const cfg = this._getConfig() || {};
    if (this._isQuiet(cfg)) return false;
    return this._emit(`${this.prefix} ${_formatLogValue(msg)}`);
  }

  /**
   * Emits a rate-limited warning keyed by `key` within `windowMs`.
   *
   * @param {string} key
   * @param {string} msg
   * @param {number} [windowMs=60000]
   * @returns {boolean}
   */
  warnThrottled(key, msg, windowMs = 60000) {
    const cfg = this._getConfig() || {};
    if (this._isQuiet(cfg)) return false;
    const throttleKey = String(key || msg || "");
    const now = Date.now();
    const interval = Number.isFinite(Number(windowMs)) ? Math.max(0, Number(windowMs)) : 60000;
    const last = this._throttleMap.get(throttleKey);
    if (last !== undefined && now - last < interval) {
      return false;
    }
    this._throttleMap.set(throttleKey, now);
    return this._emit(`${this.prefix} ${_formatLogValue(msg)}`);
  }

  /**
   * Emits an error message to stderr unless quiet mode is enabled.
   *
   * @param {string} msg
   * @param {any} [err]
   * @returns {boolean}
   */
  error(msg, err) {
    const cfg = this._getConfig() || {};
    if (this._isQuiet(cfg)) return false;
    const detail = err !== undefined && err !== null ? `: ${_formatLogValue(err)}` : "";
    return this._emit(`${this.prefix} ERROR: ${_formatLogValue(msg)}${detail}`);
  }
}

// ============================================================================
// 6. Lossless Cross-Process Wire Codec
// ============================================================================

function _escapeJsJsonChars(raw) {
  return raw.replace(
    /[<>&\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * JSON-encodes `val` safely for embedding inside JavaScript source/IPC strings.
 *
 * @param {any} val
 * @returns {string}
 */
function safeJsJson(val) {
  const raw = JSON.stringify(val);
  if (typeof raw !== "string") return "undefined";
  return _escapeJsJsonChars(raw);
}

/**
 * Serializes cross-process bridge payloads while preserving `Map` and
 * `Uint8Array` instances and `bigint` values losslessly, handling top-level/array
 * `undefined`, and escaping HTML/JS line-terminator characters (`[<>&\u2028\u2029]`).
 *
 * @param {any} value
 * @returns {string}
 */
function serializeBridgePayload(value) {
  const raw = JSON.stringify(value, (_key, val) => {
    if (val instanceof Map) {
      return { __rosmontisMap__: Array.from(val.entries()) };
    }
    if (val instanceof Uint8Array) {
      return { __rosmontisUint8Array__: Array.from(val) };
    }
    if (typeof val === "bigint") {
      return val.toString();
    }
    return val;
  });
  if (typeof raw !== "string") return "undefined";
  return _escapeJsJsonChars(raw);
}

/**
 * Revives wire-decoded payloads produced by `serializeBridgePayload` or
 * `bridge_renderer.js` (`{ __rosmontisMap__ }`, `{ __rosmontisVoid__ }`,
 * `{ __rosmontisUint8Array__ }`).
 *
 * @param {any} val
 * @returns {any}
 */
function reviveBridgePayload(val) {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }
  if (
    val instanceof Map ||
    val instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) ||
    ArrayBuffer.isView(val)
  ) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => reviveBridgePayload(item));
  }
  const keys = Object.keys(val);
  if (keys.length === 1) {
    if (val.__rosmontisVoid__ === true) {
      return undefined;
    }
    if (Array.isArray(val.__rosmontisMap__)) {
      return new Map(
        val.__rosmontisMap__.map((entry) => [
          Array.isArray(entry) ? reviveBridgePayload(entry[0]) : undefined,
          Array.isArray(entry) ? reviveBridgePayload(entry[1]) : undefined,
        ])
      );
    }
    if (Array.isArray(val.__rosmontisUint8Array__)) {
      return Uint8Array.from(val.__rosmontisUint8Array__);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    const revived = reviveBridgePayload(v);
    if (k === "__proto__") {
      Object.defineProperty(out, k, {
        value: revived,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      out[k] = revived;
    }
  }
  return out;
}

// ============================================================================
// 7. Declarative OneBot Action Router
// ============================================================================

/**
 * Builds a validated `{ HANDLED_ACTIONS, dispatch, handlers, aliases }` router
 * for an action domain module.
 *
 * @param {Record<string, (p: Record<string, any>, context: Record<string, any>, action: string) => any>} handlers
 * @param {Record<string, string>} [aliases={}]
 */
function createActionRouter(handlers, aliases = {}) {
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new Error("createActionRouter requires a plain handlers object");
  }
  if (aliases === null || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("createActionRouter aliases must be a plain object");
  }

  for (const [name, fn] of Object.entries(handlers)) {
    if (typeof fn !== "function") {
      throw new Error(`Action handler "${name}" must be a function, got ${typeof fn}`);
    }
  }

  for (const [alias, target] of Object.entries(aliases)) {
    if (
      typeof target !== "string" ||
      !Object.prototype.hasOwnProperty.call(handlers, target) ||
      typeof handlers[target] !== "function"
    ) {
      throw new Error(
        `Action alias "${alias}" points to missing or invalid handler "${String(target)}"`
      );
    }
  }

  const HANDLED_ACTIONS = new Set([...Object.keys(handlers), ...Object.keys(aliases)]);

  async function dispatch(action, p = {}, context = {}) {
    const canonical = Object.prototype.hasOwnProperty.call(aliases, action)
      ? aliases[action]
      : action;
    const fn = Object.prototype.hasOwnProperty.call(handlers, canonical)
      ? handlers[canonical]
      : null;
    if (typeof fn !== "function") {
      throw new Error(`Unsupported OneBot action: ${action}`);
    }
    return await fn.call(this, p && typeof p === "object" ? p : {}, context, action);
  }

  return {
    HANDLED_ACTIONS,
    dispatch,
    handlers,
    aliases,
  };
}

module.exports = {
  BoundedMap,
  setBoundedMap,
  TtlDedupeSet,
  TempCleanupQueue,
  createEventWaiter,
  waitForEventOnce,
  BridgeLogger,
  safeJsJson,
  serializeBridgePayload,
  reviveBridgePayload,
  createActionRouter,
};
