"use strict";

const fs = require("fs");
const path = require("path");

const {
  normalizeOneBotMessage,
  oneBotSegmentsToNtElements,
} = require("../bridge_onebot");
const {
  EchoCorrelator,
  _ntElementsSignature,
  _elementsSignatureMatch,
  hasRichMediaElements,
} = require("./echo_correlator");

const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";

let cachedRendererIpc = null;
function getRendererIpcHelpers() {
  if (cachedRendererIpc) return cachedRendererIpc;
  try {
    const mod = require("./renderer_ipc");
    if (
      mod &&
      typeof mod.makeBridgeUnavailableError === "function" &&
      typeof mod.isBridgeUnavailableError === "function"
    ) {
      cachedRendererIpc = mod;
      return cachedRendererIpc;
    }
  } catch (_) {}
  return null;
}

function makeBridgeUnavailableError(message) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.makeBridgeUnavailableError(message);
  const err = new Error(message || "NTQQ bridge unavailable");
  err.code = BRIDGE_UNAVAILABLE_TAG;
  Object.defineProperty(err, BRIDGE_UNAVAILABLE_TAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

function isBridgeUnavailableError(err) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.isBridgeUnavailableError(err);
  return Boolean(err && (err.code === BRIDGE_UNAVAILABLE_TAG || err[BRIDGE_UNAVAILABLE_TAG]));
}

const outboundPipelineMixin = {
  _ensureEchoCorrelator() {
    if (!this.echoCorrelator) {
      this.echoCorrelator = new EchoCorrelator({
        getSignatureFns: () => ({
          _ntElementsSignature: this?.constructor?._ntElementsSignature,
          _elementsSignatureMatch: this?.constructor?._elementsSignatureMatch,
        }),
      });
      if (this._sendEchoWaiters instanceof Map) {
        this.echoCorrelator.waiters = this._sendEchoWaiters;
      } else {
        this._sendEchoWaiters = this.echoCorrelator.waiters;
      }
      if (this.sendEchoStats && typeof this.sendEchoStats === "object") {
        this.echoCorrelator.stats = this.sendEchoStats;
      } else {
        this.sendEchoStats = this.echoCorrelator.stats;
      }
    }
    return this.echoCorrelator;
  },

  async _resolvePeerForUser(userId, groupId) {
    const uinStr = String(userId || "").trim();
    const uid = await this.uinUidStore.resolveUid(uinStr, this.invokeNt.bind(this));
    if (groupId && Number(groupId) > 0) {
      return {
        chatType: 100,
        peerUid: uid || uinStr,
        guildId: "",
      };
    }
    return {
      chatType: 1,
      peerUid: uid || uinStr,
      guildId: "",
    };
  },

  async _prepareNtImagePath(media, subType = 0) {
    const elemSubType = Number(subType || 0);
    try {
      const exifRes = await this.invokeNt(
        "nodeIKernelMsgService/copyFileWithDelExifInfo",
        {
          sourcePath: media.localPath,
          elementSubType: elemSubType,
        },
        [media.localPath, elemSubType]
      );
      if (exifRes && exifRes.newPath && !exifRes.errorMsg) {
        const newPath = String(exifRes.newPath);
        let fileSize = media.fileSize;
        try {
          if (fs.existsSync(newPath)) {
            fileSize = fs.statSync(newPath).size || media.fileSize;
          }
        } catch (_) {}
        return {
          localPath: newPath,
          md5HexStr: String(exifRes.md5 || media.md5HexStr),
          fileSize,
          fileName: path.basename(newPath) || media.fileName,
        };
      }
    } catch (_) {}

    try {
      const pathInfo = {
        md5HexStr: media.md5HexStr,
        fileName: media.fileName,
        elementType: 2,
        elementSubType: elemSubType,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: "",
      };
      const pathRes = await this.invokeNt(
        "nodeIKernelMsgService/getRichMediaFilePathForGuild",
        { path_info: pathInfo },
        [pathInfo]
      );
      const targetPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
      if (targetPath && targetPath !== media.localPath) {
        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(media.localPath, targetPath);
          return targetPath;
        } catch (_) {
          await this.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetPath },
            [media.localPath, targetPath]
          );
          return targetPath;
        }
      }
    } catch (_) {}
    return media.localPath;
  },

  _sendPeerKey(peer) {
    return this._ensureEchoCorrelator().peerKey(peer);
  },

  _registerSendEchoWaiter(peer, elements, elementPredicate = null) {
    return this._ensureEchoCorrelator().register(peer, elements, elementPredicate);
  },

  _matchSendEcho(ntMsg) {
    return this._ensureEchoCorrelator().match(ntMsg);
  },

  _hasRichMediaElements(elements) {
    return hasRichMediaElements(elements);
  },

  _computeSendEchoTimeoutMs(elements) {
    return this._ensureEchoCorrelator().computeTimeoutMs(elements, this.config);
  },

  _mediaSecurityOptions() {
    return {
      maxMediaBytes: this.config.maxMediaBytes,
      allowPrivateUrls:
        this.config.allowPrivateUrls === true || this.config.allowPrivateMediaUrls === true
          ? true
          : undefined,
      allowArbitraryLocalFiles:
        this.config.allowArbitraryLocalFiles === true ? true : undefined,
      allowedFileDirs: this.config.allowedFileDirs,
    };
  },

  async _sendMessageToPeer(peer, message, autoEscape = false, groupId = undefined, options = {}) {
    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
    this._sessionScheduler.cancelPeerReaction(peerKey);

    // Phase 1 (unlocked): concurrent heavy I/O (HTTP media download, EXIF normalize, @UIN->UID)
    const { elements, sideEffects, cleanupCallbacks } = await oneBotSegmentsToNtElements(message, {
      autoEscape,
      groupId,
      uinUidStore: this.uinUidStore,
      messageIdStore: this.messageIdStore,
      invokeNt: this.invokeNt.bind(this),
      prepareNtImagePath: this._prepareNtImagePath.bind(this),
      ...this._mediaSecurityOptions(),
    });

    try {
      // Phase 2 (AIO-mutex serialized): activate target AIO + dispatch sendMsg IPC, then release immediately
      const { echoWaiter, sendRes } = await this._withAioLock(
        async () => {
          this._sessionScheduler.cancelPeerReaction(peerKey);
          if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
            await this._activateSessionUnlocked({
              chatType: peer.chatType,
              peerUid: peer.peerUid,
              guildId: peer.guildId || "",
              markRead: true,
              sendTyping: false,
            });
          }

          for (const effect of sideEffects) {
            if (effect.type === "poke") {
              await this._sendPokeInternal(
                peer.chatType === 2 ? Number(peer.peerUid) : undefined,
                effect.qq || (peer.chatType === 1 ? Number(this.uinUidStore.getUinSync(peer.peerUid)) : 0)
              );
            }
          }

          if (elements.length === 0) {
            return { echoWaiter: null, sendRes: null };
          }

          const waiter = this._registerSendEchoWaiter(peer, elements);
          try {
            const res = await this.invokeNt(
              "nodeIKernelMsgService/sendMsg",
              {
                msgId: "0",
                peer,
                msgElements: elements,
                msgAttributeInfos: new Map(),
              },
              ["0", peer, elements, new Map()]
            );
            if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
              this._touchAioActivity();
            }
            return { echoWaiter: waiter, sendRes: res };
          } catch (err) {
            waiter.cancel();
            throw err;
          }
        },
        { peerKey }
      );

      if (!echoWaiter) {
        return { message_id: this.messageIdStore.register("", peer, "0") };
      }

      if (sendRes && typeof sendRes.result === "number" && sendRes.result !== 0) {
        echoWaiter.cancel();
        throw new Error(sendRes.errMsg || `sendMsg failed with code ${sendRes.result}`);
      }

      // Phase 3 (unlocked): await onAddSendMsg echo correlation without holding _aioMutex
      const normId = (v) => (v !== undefined && v !== null && String(v) !== "0" ? String(v) : "");
      let realMsgId = normId(sendRes?.msgId || sendRes?.msgRecord?.msgId);
      let msgSeq = String(sendRes?.msgSeq || sendRes?.msgRecord?.msgSeq || "0");
      let msgTime = Math.floor(Date.now() / 1000);
      let echoRawMsg = sendRes?.msgRecord || null;
      const echoStats = this.sendEchoStats || this._ensureEchoCorrelator().stats;
      if (realMsgId) {
        echoWaiter.cancel();
        echoStats.fromResult += 1;
      } else {
        const echoTimeoutMs = this._computeSendEchoTimeoutMs(elements);
        const echo = await echoWaiter.wait(echoTimeoutMs);
        if (echo && echo.msgId) {
          realMsgId = echo.msgId;
          if (msgSeq === "0" && echo.msgSeq) msgSeq = echo.msgSeq;
          if (Number.isFinite(echo.msgTime) && echo.msgTime > 0) msgTime = echo.msgTime;
          if (echo.rawMsg) echoRawMsg = echo.rawMsg;
          echoStats.matched += 1;
        } else {
          echoStats.timedOut += 1;
          const peerKeyStr = this._sendPeerKey(peer);
          const warnKey = `send-echo-timeout:${peerKeyStr}`;
          const warnMsg = `sendMsg to ${peerKeyStr} succeeded but no onAddSendMsg echo arrived within ${echoTimeoutMs}ms; message_id will not be recallable`;
          if (typeof this._logWarn === "function") {
            this._logWarn(warnKey, warnMsg);
          } else {
            this.logger?.warnThrottled?.(warnKey, warnMsg, 60000);
          }
        }
      }
      if (!realMsgId) {
        realMsgId = `sent_${Date.now()}`;
      }

      const shortId = this.messageIdStore.register(realMsgId, peer, msgSeq, {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        msgTime,
        rawMsg: echoRawMsg || null,
      });
      if (echoRawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(echoRawMsg, shortId);
      }

      return { message_id: shortId, real_id: realMsgId };
    } finally {
      this._scheduleTempCleanup(cleanupCallbacks, Boolean(options.cleanupTempImmediately));
    }
  },

  async _invokeForwardWithEcho(peer, invokeFn, fallbackSeed = "") {
    const timeoutMs =
      Number(this.config?.forwardEchoTimeoutMs) > 0
        ? Number(this.config.forwardEchoTimeoutMs)
        : Math.min(Math.max(50, Number(this.config?.sendEchoTimeoutMs) || 200), 200);
    const echoWaiter = this._registerSendEchoWaiter(
      peer,
      null,
      (ntMsg) => Boolean(ntMsg && ntMsg.msgId && String(ntMsg.msgId) !== "0")
    );

    let res;
    try {
      res = await invokeFn();
    } catch (err) {
      echoWaiter.cancel();
      throw err;
    }

    if (res && typeof res.result === "number" && res.result !== 0) {
      echoWaiter.cancel();
      throw new Error(res.errMsg || `forward failed with code ${res.result}`);
    }

    const normId = (v) => (v !== undefined && v !== null && String(v) !== "0" ? String(v) : "");
    const directMsgId = normId(res?.msgId || res?.result?.msgId || res?.msgRecord?.msgId);
    const directSeq = String(res?.msgSeq || res?.result?.msgSeq || res?.msgRecord?.msgSeq || "0");
    if (directMsgId) {
      echoWaiter.cancel();
      const rawMsg = res?.msgRecord || null;
      const oneBotId = this.messageIdStore.register(directMsgId, peer, directSeq, {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        rawMsg,
      });
      if (rawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(rawMsg, oneBotId);
      }
      return { message_id: oneBotId, real_id: String(directMsgId), msgId: String(directMsgId) };
    }

    const echo = await echoWaiter.wait(timeoutMs);
    if (echo && echo.msgId) {
      const rawMsg = echo.rawMsg || null;
      const oneBotId = this.messageIdStore.register(echo.msgId, peer, echo.msgSeq || "0", {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        ...(Number.isFinite(echo.msgTime) && echo.msgTime > 0 ? { msgTime: echo.msgTime } : {}),
        rawMsg,
      });
      if (rawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(rawMsg, oneBotId);
      }
      return { message_id: oneBotId, real_id: String(echo.msgId), msgId: String(echo.msgId) };
    }

    const seedPart = fallbackSeed ? `${String(fallbackSeed)}_` : "";
    const syntheticId = `fwd_${seedPart}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const oneBotId = this.messageIdStore.register(syntheticId, peer, "0", {
      senderUin: this.selfUin,
      senderUid: this.selfUid,
      groupId: peer.chatType === 2 ? peer.peerUid : "",
    });
    return { message_id: oneBotId, real_id: String(syntheticId), msgId: String(syntheticId) };
  },

  async _sendPokeInternal(groupId, userId) {
    const targetUin = Number(userId || 0);
    const targetGroup = groupId ? Number(groupId) : 0;
    const targetUid = targetUin
      ? await this.uinUidStore.resolveUid(targetUin, this.invokeNt.bind(this))
      : "";
    const peer =
      targetGroup > 0
        ? { chatType: 2, peerUid: String(targetGroup), guildId: "" }
        : await this._resolvePeerForUser(targetUin);

    // 1. Primary: genuine NTQQ 3.2.32 `nodeIKernelMsgService/sendNudge`
    try {
      await this.invokeNt(
        "nodeIKernelMsgService/sendNudge",
        {
          peer,
          toUid: targetUid || String(targetUin),
          uid: targetUid || String(targetUin),
        },
        [peer, targetUid || String(targetUin)]
      );
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 2. Fallback: legacy `sendPoke` if bridged by a custom adapter
    try {
      if (targetGroup > 0) {
        await this.invokeNt("nodeIKernelMsgService/sendPoke", {
          groupCode: String(targetGroup),
          toUin: String(targetUin),
          peer,
          targetUid: targetUid || String(targetUin),
        });
        return;
      }
      await this.invokeNt("nodeIKernelMsgService/sendPoke", {
        toUin: String(targetUin),
        peer,
        targetUid: targetUid || String(targetUin),
      });
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 3. Final fallback: sendMsg poke faceElement
    if (targetUin > 0 && peer && peer.peerUid) {
      const pokeElements = [
        {
          elementType: 6,
          elementId: "",
          faceElement: {
            faceIndex: 0,
            faceType: 5,
            faceText: "[戳一戳]",
            pokeType: 1,
            spokeSummary: "",
            doubleHit: 0,
            vasPokeId: 1,
            vasPokeName: "戳一戳",
          },
        },
      ];
      await this.invokeNt(
        "nodeIKernelMsgService/sendMsg",
        {
          msgId: "0",
          peer,
          msgElements: pokeElements,
          msgAttributeInfos: new Map(),
        },
        ["0", peer, pokeElements, new Map()]
      );
      return;
    }
    throw makeBridgeUnavailableError("NTQQ service unavailable for sendNudge/sendPoke");
  },
};

module.exports = {
  outboundPipelineMixin,
  _ntElementsSignature,
  _elementsSignatureMatch,
  BRIDGE_UNAVAILABLE_TAG,
  makeBridgeUnavailableError,
  isBridgeUnavailableError,
  normalizeOneBotMessage,
};
