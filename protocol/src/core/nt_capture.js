"use strict";

const { isPrefixedEnvFlagOne } = require("./env");

// Native `Map.prototype.set`, captured at module load before any bridge hook is installed.
const NATIVE_MAP_SET = Map.prototype.set;

// Process-wide state of the temporary `Map.prototype.set` capture hook (one per process).
const MAP_HOOK_STATE = {
  owner: null, // NtqqOneBotBridge receiving captures
  hookFn: null, // our installed wrapper
  orig: null, // Map.prototype.set at install time
  inspecting: false, // re-entrancy guard
};

const ntCaptureMixin = {
  installMapPrototypeHook() {
    // Another bridge instance in this process (tests / hot reinstall) already owns our hook:
    // route captures to the newest instance instead of stacking a second wrapper.
    if (MAP_HOOK_STATE.hookFn && Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      MAP_HOOK_STATE.owner = this;
      this._mapSetHook = MAP_HOOK_STATE.hookFn;
      this._scheduleMapHookMaxLifetime();
      return;
    }
    if (Map.prototype.__rosmontisBridgeHooked__) return;

    const origSet = Map.prototype.set;
    Object.defineProperty(Map.prototype, "__rosmontisBridgeHooked__", {
      value: true,
      enumerable: false,
      configurable: true,
    });

    const hookFn = function (k, v) {
      const res = origSet.call(this, k, v);
      const owner = MAP_HOOK_STATE.owner;
      if (owner && !MAP_HOOK_STATE.inspecting) {
        MAP_HOOK_STATE.inspecting = true;
        try {
          owner._inspectMapEntry(this, k, v);
        } catch (err) {
          try {
            owner.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        } finally {
          MAP_HOOK_STATE.inspecting = false;
        }
      }
      return res;
    };

    MAP_HOOK_STATE.owner = this;
    MAP_HOOK_STATE.hookFn = hookFn;
    MAP_HOOK_STATE.orig = origSet;
    this._mapSetHook = hookFn;
    Map.prototype.set = hookFn;
    this._scheduleMapHookMaxLifetime();
  },

  _mapHookReleaseDisabled() {
    return (
      Boolean(this.config && this.config.keepMapHook) ||
      isPrefixedEnvFlagOne("KEEP_MAP_HOOK")
    );
  },

  _scheduleMapHookMaxLifetime() {
    if (this._mapHookReleaseDisabled() || this._mapHookMaxTimer) return;
    const maxMs = Number(this.config?.mapHookMaxLifetimeMs ?? 10 * 60 * 1000);
    if (!(maxMs > 0)) return;
    this._mapHookMaxTimer = setTimeout(() => {
      this._mapHookMaxTimer = null;
      this.releaseMapPrototypeHook("max_lifetime");
    }, maxMs);
    if (typeof this._mapHookMaxTimer.unref === "function") this._mapHookMaxTimer.unref();
  },

  _mapHookCapturesComplete() {
    const cs = this.capturedServices;
    let hasNtApi = false;
    try {
      hasNtApi = Boolean(
        cs.ntApi &&
          (typeof cs.ntApi["nodeIKernelMsgService/sendMsg"] === "function" ||
            (cs.ntApi.invoke && typeof cs.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"))
      );
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
    return hasNtApi && Boolean(cs.ntStore) && Boolean(cs.wrapperSession || cs.ntSessionManager);
  },

  /**
   * Called after every successful capture. Once ntApi + ntStore + session are all captured,
   * schedule restoring the native `Map.prototype.set` (after a grace period so the second
   * `globalIPCMainMap` "ntApi" registration is still observed). Later kernel listeners keep
   * flowing through `ntStore.emitter`, the hooked `setNewListenEmitter`, the instance-level
   * `listenerEventEmitterMap.set` patch and the Inversify `binding.cache` watchers.
   */
  _maybeScheduleMapHookRelease() {
    if (!this._mapSetHook || this._mapHookReleaseTimer || this._mapHookReleaseDisabled()) return;
    if (MAP_HOOK_STATE.owner !== this) return;
    if (!this._mapHookCapturesComplete()) return;
    const delayMs = Math.max(0, Number(this.config?.mapHookReleaseDelayMs ?? 15000));
    this._mapHookReleaseTimer = setTimeout(() => {
      this._mapHookReleaseTimer = null;
      this.releaseMapPrototypeHook("captured");
    }, delayMs);
    if (typeof this._mapHookReleaseTimer.unref === "function") this._mapHookReleaseTimer.unref();
  },

  releaseMapPrototypeHook(reason = "manual") {
    for (const key of ["_mapHookReleaseTimer", "_mapHookMaxTimer"]) {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
    if (!this._mapSetHook || MAP_HOOK_STATE.owner !== this || MAP_HOOK_STATE.hookFn !== this._mapSetHook) {
      return false;
    }
    let restored = false;
    if (Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      Map.prototype.set = MAP_HOOK_STATE.orig;
      try {
        delete Map.prototype.__rosmontisBridgeHooked__;
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
      restored = true;
    }
    // If something wrapped Map.prototype.set on top of us we can not unlink safely; with no
    // owner our hook degrades to a pure pass-through.
    MAP_HOOK_STATE.owner = null;
    MAP_HOOK_STATE.hookFn = restored ? null : MAP_HOOK_STATE.hookFn;
    this._mapSetHook = null;
    this.mapHookRelease = { reason, restored, at: Date.now() };
    this._restoreModuleLoad();

    const missing = [];
    if (!this.capturedServices.ntApi) missing.push("ntApi");
    if (!this.capturedServices.ntStore) missing.push("ntStore");
    if (!this.capturedServices.wrapperSession && !this.capturedServices.ntSessionManager) missing.push("session");
    const releaseMsg = `Map.prototype.set hook released (reason=${reason}, restored=${restored}${
      missing.length ? `, missing=${missing.join("/")}` : ""
    })`;
    if (typeof this._logWarn === "function") {
      this._logWarn("map-hook-release", releaseMsg, 0);
    } else {
      this.logger?.warnThrottled?.("map-hook-release", releaseMsg, 0);
    }
    return restored;
  },

  installWrapperHook() {
    try {
      const Module = require("module");
      if (!Module || Module._load.__rosmontisWrapperHooked__) return;
      const origLoad = Module._load;
      const self = this;
      const wrappedLoad = function (request, parent, isMain) {
        const exp = origLoad.apply(this, [request, parent, isMain]);
        try {
          if (typeof request === "string" && request.includes("wrapper.node") && exp) {
            if (self._hookWrapperExports(exp)) {
              // wrapper.node is loaded once per process; stop intercepting every require().
              self._restoreModuleLoad();
            }
          }
        } catch (err) {
          try {
            self.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        }
        return exp;
      };
      Object.defineProperty(wrappedLoad, "__rosmontisWrapperHooked__", {
        value: true,
        enumerable: false,
      });
      Module._load = wrappedLoad;
      this._moduleLoadHook = { Module, origLoad, wrappedLoad };
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _restoreModuleLoad() {
    const h = this._moduleLoadHook;
    if (!h) return false;
    this._moduleLoadHook = null;
    if (h.Module._load === h.wrappedLoad) {
      h.Module._load = h.origLoad;
      return true;
    }
    return false;
  },

  _hookWrapperExports(wrapperExports) {
    if (!wrapperExports || typeof wrapperExports !== "object") return false;
    const self = this;
    const SessionClass = wrapperExports.NodeIQQNTWrapperSession;
    if (!SessionClass) return false;
    if (!SessionClass.__rosmontisHookedSessionClass__) {
      try {
        Object.defineProperty(SessionClass, "__rosmontisHookedSessionClass__", {
          value: true,
          enumerable: false,
        });
        for (const staticFn of ["get", "create", "getNTWrapperSession"]) {
          if (typeof SessionClass[staticFn] === "function") {
            const origFn = SessionClass[staticFn].bind(SessionClass);
            SessionClass[staticFn] = function (...args) {
              const inst = origFn(...args);
              if (inst && typeof inst === "object") {
                self.capturedServices.wrapperSession = inst;
                self._maybeScheduleMapHookRelease();
              }
              return inst;
            };
          }
        }
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
    }
    return true;
  },

  _inspectMapEntry(_mapInstance, k, v) {
    // 1. String keys in Inversify or globalIPCMainMap or listenerEventEmitterMap
    if (typeof k === "string") {
      if (k === "ntApi" && v) {
        // First registration is the direct ntApi route Proxy; second registration in
        // globalIPCMainMap is `{ emit: Proxy, invoke: Proxy }` where `v.invoke` is the route Proxy.
        if (typeof v["nodeIKernelMsgService/sendMsg"] === "function") {
          this.capturedServices.ntApi = v;
        } else if (
          v.invoke &&
          typeof v.invoke["nodeIKernelMsgService/sendMsg"] === "function"
        ) {
          this.capturedServices.ntApi = v.invoke;
        } else if (!this.capturedServices.ntApi) {
          this.capturedServices.ntApi = v;
        }
        this.capturedServices.ntApiContainer = v;
        this._maybeScheduleMapHookRelease();
        return;
      }
      if (
        k === "WindowApi" ||
        k === "PerformanceApi" ||
        k === "LoggerApi" ||
        k === "UserBehaviorReportService" ||
        k === "SubWindowApi" ||
        k === "ScreenRecordApi" ||
        k === "ntCall"
      ) {
        this.capturedServices[k] = v;
        return;
      }
      if (k.startsWith("nodeIKernel") && k.endsWith("Listener") && v) {
        this._attachKernelListenerEmitter(k, v);
        return;
      }
    }

    // 2. Symbol or Inversify binding arrays: [{ cache, implementationType, type }]
    if (Array.isArray(v)) {
      for (const binding of v) {
        if (!binding || typeof binding !== "object") continue;
        if (binding.cache) {
          this._inspectInversifyCache(binding.cache);
        } else if ("cache" in binding) {
          this._watchBindingCacheProperty(binding);
        }
      }
    } else if (v && typeof v === "object") {
      this._inspectInversifyCache(v);
    }
  },

  _watchBindingCacheProperty(binding) {
    if (binding.__rosmontisWatched__) return;
    try {
      Object.defineProperty(binding, "__rosmontisWatched__", {
        value: true,
        enumerable: false,
      });
      let currentCache = binding.cache;
      const self = this;
      Object.defineProperty(binding, "cache", {
        configurable: true,
        enumerable: true,
        get() {
          return currentCache;
        },
        set(newVal) {
          currentCache = newVal;
          try {
            self._inspectInversifyCache(newVal);
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
        },
      });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _updateSelfIdentity({ uin, uid, nick, markOnline = false } = {}) {
    const prevUin = this.selfUin;
    if (uin && /^\d+$/.test(String(uin))) {
      this.selfUin = String(uin);
    }
    if (uid && String(uid).trim()) {
      this.selfUid = String(uid).trim();
    }
    if (nick && String(nick).trim()) {
      this.selfNickname = String(nick).trim();
    }
    if (this.selfUin && this.selfUid) {
      this.uinUidStore.record(this.selfUin, this.selfUid, {
        nick: this.selfNickname !== "QQBot" ? this.selfNickname : "",
      });
    }
    if (markOnline) {
      const wasOnline = this.online;
      this.online = true;
      if (!wasOnline && this.config.autoQuickLogin !== false && !this._persistedAutoLogin) {
        this._persistedAutoLogin = true;
        const t = setTimeout(() => {
          this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]).catch(() => {});
          this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]).catch(() => {});
        }, 1000);
        if (t && typeof t.unref === "function") t.unref();
      }
    }
    if ((!prevUin || prevUin === "0") && this.selfUin && this.selfUin !== "0") {
      this._reconnectUnidentifiedReverseWs();
    }
  },

  _reconnectUnidentifiedReverseWs() {
    if (!this.selfUin || this.selfUin === "0") return;
    for (const rev of this._reverseWsClients) {
      if (!rev.stopped && rev.conn && (!rev.connectedSelfId || rev.connectedSelfId === "0")) {
        rev.immediateReconnectOnce = true;
        try {
          rev.conn.close();
        } catch (_) {}
      }
    }
  },

  _inspectInversifyCache(obj) {
    if (!obj || typeof obj !== "object") return;
    const proto = Object.getPrototypeOf(obj) || {};

    // Check if obj is ntStore (has listenerEventEmitterMap, setNewListenEmitter, or emitter + session)
    if (
      obj.listenerEventEmitterMap instanceof Map ||
      typeof obj.setNewListenEmitter === "function" ||
      typeof proto.setNewListenEmitter === "function" ||
      (obj.emitter &&
        typeof obj.emitter.emit === "function" &&
        ("listenerEventEmitterMap" in obj || "wrapperSession" in obj || "session" in obj))
    ) {
      this._inspectNtStore(obj);
    }

    // Check if obj is ntSessionManager (has createNt or ntStore)
    if (
      typeof obj.createNt === "function" ||
      typeof proto.createNt === "function" ||
      (obj.ntStore && typeof obj.ntStore === "object")
    ) {
      this.capturedServices.ntSessionManager = obj;
      this._hookNtSessionManager(obj);
      this._maybeScheduleMapHookRelease();
    }

    // Check if obj is authMgr (has initAppSessionAndWindowPool) to auto-sync selfUin/selfUid/selfNickname
    if (
      typeof obj.initAppSessionAndWindowPool === "function" ||
      typeof proto.initAppSessionAndWindowPool === "function"
    ) {
      if (!obj.__rosmontisHookedAuthMgr__) {
        try {
          Object.defineProperty(obj, "__rosmontisHookedAuthMgr__", {
            value: true,
            enumerable: false,
          });
          const origInitPool = obj.initAppSessionAndWindowPool;
          const self = this;
          obj.initAppSessionAndWindowPool = function (authInfo, ...rest) {
            try {
              if (authInfo && typeof authInfo === "object") {
                self._updateSelfIdentity({
                  uin: authInfo.uin,
                  uid: authInfo.uid,
                  nick: authInfo.nick || authInfo.nickName,
                  markOnline: true,
                });
              }
            } catch (err) {
              try {
                self.logger?.debug?.("nt_capture", err);
              } catch (_) {}
            }
            return origInitPool.apply(this, [authInfo, ...rest]);
          };
        } catch (err) {
          this.logger?.debug?.("nt_capture", err);
        }
      }
    }

    // Check if obj is NodeIQQNTWrapperSession (has getMsgService & getGroupService)
    if (
      typeof obj.getMsgService === "function" ||
      typeof proto.getMsgService === "function"
    ) {
      this.capturedServices.wrapperSession = obj;
      this._maybeScheduleMapHookRelease();
    }
  },

  _inspectNtStore(ntStore) {
    if (!ntStore || typeof ntStore !== "object") return;
    this.capturedServices.ntStore = ntStore;
    if (ntStore.wrapperSession || ntStore.session) {
      this.capturedServices.wrapperSession = ntStore.wrapperSession || ntStore.session;
    }
    if (ntStore.emitter && typeof ntStore.emitter === "object") {
      this._attachNtStoreRootEmitter(ntStore.emitter);
    }
    if (ntStore.listenerEventEmitterMap instanceof Map) {
      for (const [listenerName, emitter] of ntStore.listenerEventEmitterMap.entries()) {
        this._attachKernelListenerEmitter(listenerName, emitter);
      }
      this._patchListenerEmitterMapInstance(ntStore.listenerEventEmitterMap);
    }
    if (typeof ntStore.setNewListenEmitter === "function" && !ntStore.__rosmontisHookedSetNew__) {
      try {
        Object.defineProperty(ntStore, "__rosmontisHookedSetNew__", {
          value: true,
          enumerable: false,
        });
        const origSetNew = ntStore.setNewListenEmitter;
        const self = this;
        ntStore.setNewListenEmitter = function (listenerName, emitter, ...rest) {
          const res = origSetNew.apply(this, [listenerName, emitter, ...rest]);
          try {
            if (listenerName && emitter) {
              self._attachKernelListenerEmitter(String(listenerName), emitter);
            }
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
          return res;
        };
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
    }
    this._maybeScheduleMapHookRelease();
  },

  /**
   * Instance-level replacement for the global `Map.prototype.set` hook on the one Map that
   * keeps receiving kernel listener emitters after startup, so the global hook can be released.
   */
  _patchListenerEmitterMapInstance(map) {
    if (!(map instanceof Map) || Object.prototype.hasOwnProperty.call(map, "set")) return;
    const self = this;
    try {
      Object.defineProperty(map, "set", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (k, v) {
          const res = NATIVE_MAP_SET.call(this, k, v);
          try {
            if (typeof k === "string" && v) {
              self._attachKernelListenerEmitter(k, v);
            }
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
          return res;
        },
      });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _attachNtStoreRootEmitter(emitter) {
    if (!emitter || typeof emitter.emit !== "function") return;
    if (this._attachedEmitters.has(emitter)) return;
    this._attachedEmitters.add(emitter);
    const origEmit = emitter.emit;
    const self = this;
    emitter.emit = function (fullEventName, ...args) {
      try {
        const name = String(fullEventName || "");
        const sepIdx = name.indexOf("-") >= 0 ? name.indexOf("-") : name.indexOf("/");
        if (sepIdx > 0) {
          const listenerName = name.slice(0, sepIdx);
          const shortEvent = name.slice(sepIdx + 1);
          if (listenerName && shortEvent) {
            self._handleKernelEvent(listenerName, shortEvent, args);
          }
        }
      } catch (err) {
        try {
          self.logger?.debug?.("nt_capture", err);
        } catch (_) {}
      }
      return origEmit.apply(this, [fullEventName, ...args]);
    };
  },

  _hookNtSessionManager(mgr) {
    if (!mgr || mgr.__rosmontisHooked__) return;
    try {
      Object.defineProperty(mgr, "__rosmontisHooked__", { value: true, enumerable: false });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    if (mgr.ntStore) {
      this._inspectNtStore(mgr.ntStore);
    }

    if (typeof mgr.createNt === "function") {
      const origCreateNt = mgr.createNt;
      const self = this;
      mgr.createNt = function (...args) {
        const session = origCreateNt.apply(this, args);
        if (session && typeof session === "object") {
          self.capturedServices.wrapperSession = session;
          if (self.selfUid) {
            self.online = true;
          }
        }
        if (this.ntStore) {
          self._inspectNtStore(this.ntStore);
        }
        self._maybeScheduleMapHookRelease();
        return session;
      };
    }
  },

  _attachKernelListenerEmitter(listenerName, emitterOrMap) {
    if (!emitterOrMap || typeof emitterOrMap !== "object") return;
    if (emitterOrMap instanceof Map) {
      for (const sub of emitterOrMap.values()) {
        this._attachKernelListenerEmitter(listenerName, sub);
      }
      return;
    }
    if (this._attachedEmitters.has(emitterOrMap)) return;
    if (typeof emitterOrMap.on !== "function" && typeof emitterOrMap.emit !== "function") return;
    this._attachedEmitters.add(emitterOrMap);

    const self = this;
    if (typeof emitterOrMap.emit === "function") {
      const origEmit = emitterOrMap.emit;
      emitterOrMap.emit = function (eventName, ...args) {
        try {
          self._handleKernelEvent(listenerName, String(eventName), args);
        } catch (err) {
          try {
            self.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        }
        return origEmit.apply(this, [eventName, ...args]);
      };
    }
  },
};

module.exports = {
  NATIVE_MAP_SET,
  MAP_HOOK_STATE,
  ntCaptureMixin,
};
