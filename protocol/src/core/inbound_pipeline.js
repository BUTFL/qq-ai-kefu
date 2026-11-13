"use strict";

const fs = require("fs");

const bridgeOnebot = require("../bridge_onebot");
const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
} = bridgeOnebot;
const { isPrefixedEnvFlagOne } = require("./env");
const { setBoundedMap } = require("./primitives");
const { pickPositiveUin, normalizeLoginIdentity } = require("./nt_normalizer");

function _isPositiveUin(v) {
  return (
    v != null &&
    v !== "" &&
    typeof v !== "boolean" &&
    !Array.isArray(v) &&
    Number.isFinite(Number(v)) &&
    Number(v) > 0
  );
}

function _pickPositiveUin(...candidates) {
  const picked = pickPositiveUin(...candidates);
  return picked > 0 ? String(picked) : "";
}

function _stripTransientMedia(ntMsg) {
  if (typeof bridgeOnebot.stripTransientNtMedia === "function") {
    try {
      bridgeOnebot.stripTransientNtMedia(ntMsg);
    } catch (_) {}
  }
  if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
  for (const el of ntMsg.elements) {
    if (!el || typeof el !== "object") continue;
    if (el.picElement && "__base64Uri" in el.picElement) {
      delete el.picElement.__base64Uri;
    }
    if (el.pttElement && "__base64Uri" in el.pttElement) {
      delete el.pttElement.__base64Uri;
    }
  }
}

function _isRecallMsg(ntMsg) {
  if (!ntMsg || typeof ntMsg !== "object") return false;
  if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
    return true;
  }
  if (
    Number(ntMsg.msgType) === 5 &&
    Array.isArray(ntMsg.elements) &&
    ntMsg.elements.some((e) => Boolean(e?.grayTipElement?.revokeElement))
  ) {
    return true;
  }
  return false;
}

async function _statPositiveFile(filePath) {
  if (!filePath) return null;
  try {
    const st = await fs.promises.stat(String(filePath));
    if (st.isFile() && st.size > 0) {
      return st;
    }
  } catch (_) {}
  return null;
}

function _collectTemplParamUids(templParam, out) {
  if (!templParam) return;
  const checkPair = (k, v) => {
    const keyStr = String(k || "");
    if ((keyStr === "uid_str1" || keyStr === "uid_str2") && v != null && v !== "") {
      out.push(String(v));
    }
  };
  if (templParam instanceof Map) {
    for (const [k, v] of templParam.entries()) {
      checkPair(k, v);
    }
  } else if (Array.isArray(templParam)) {
    for (const entry of templParam) {
      if (Array.isArray(entry) && entry.length >= 2) {
        checkPair(entry[0], entry[1]);
      } else if (entry && typeof entry === "object") {
        checkPair(entry.key ?? entry.k ?? entry.name, entry.value ?? entry.v ?? entry.val);
      }
    }
  } else if (typeof templParam === "object") {
    for (const [k, v] of Object.entries(templParam)) {
      checkPair(k, v);
    }
  }
}

const inboundPipelineMixin = {
  _isPositiveUin(v) {
    return _isPositiveUin(v);
  },

  _isNtReady() {
    if (this.dispatcher !== undefined) {
      return Boolean(this.dispatcher?.ready);
    }
    if (typeof this.rendererExecute === "function") return true;
    if (
      typeof this._canInvokeRenderer === "function" &&
      this._canInvokeRenderer(this.activeWebContents)
    ) {
      return true;
    }
    if (this.capturedServices) {
      const cs = this.capturedServices;
      if (
        cs.ntApi ||
        cs.wrapperSession ||
        cs.ntStore?.wrapperSession ||
        cs.ntStore?.session ||
        cs.ntSessionManager?.ntStore?.wrapperSession ||
        cs.ntSessionManager?.ntStore?.session
      ) {
        return true;
      }
    }
    if (typeof this.ntCall === "function") return true;
    if (
      typeof this.invokeNt === "function" &&
      (!this.capturedServices || Object.prototype.hasOwnProperty.call(this, "invokeNt"))
    ) {
      return true;
    }
    return false;
  },

  _dispatchInboundEvent(ev) {
    if (!ev) return;
    if (typeof this.broadcastOneBotEvent === "function") {
      this.broadcastOneBotEvent(ev);
    } else if (typeof this._dispatchEvent === "function") {
      this._dispatchEvent(ev);
    }
  },

  async _ensureUinForUid(uid) {
    const uidStr = uid != null ? String(uid).trim() : "";
    if (!uidStr || uidStr === "0" || uidStr === "all") return "";
    if (/^\d+$/.test(uidStr) && _isPositiveUin(uidStr)) return uidStr;
    if (!this.uinUidStore) return "";

    const cached = this.uinUidStore.getUinSync?.(uidStr) || "";
    if (_isPositiveUin(cached)) return String(cached);

    if (typeof this.uinUidStore.resolveUin === "function") {
      const invoker =
        typeof this.invokeNt === "function"
          ? this.invokeNt.bind(this)
          : typeof this.ntCall === "function"
          ? (cmd, payload) => {
              const [service, method] = String(cmd).split("/");
              return this.ntCall(service, method, [payload]);
            }
          : undefined;
      try {
        const resolved = await this.uinUidStore.resolveUin(uidStr, invoker);
        if (_isPositiveUin(resolved)) {
          return String(resolved);
        }
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
    return "";
  },

  async _resolveNtMsgUids(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    this.uinUidStore?.rememberFromNtMsg?.(ntMsg);

    const pendingByUid = new Map();
    let mutated = false;

    const queueUid = (rawUid, onResolved) => {
      const uidStr = rawUid != null ? String(rawUid).trim() : "";
      if (!uidStr || uidStr === "0" || uidStr === "all") return;
      if (/^\d+$/.test(uidStr) && _isPositiveUin(uidStr)) {
        if (onResolved) {
          onResolved(uidStr);
          mutated = true;
        }
        return;
      }
      const cached = this.uinUidStore?.getUinSync?.(uidStr) || "";
      if (_isPositiveUin(cached)) {
        if (onResolved) {
          onResolved(String(cached));
          mutated = true;
        }
        return;
      }
      if (!pendingByUid.has(uidStr)) {
        pendingByUid.set(uidStr, []);
      }
      if (onResolved) {
        pendingByUid.get(uidStr).push(onResolved);
      }
    };

    if (!_isPositiveUin(ntMsg.senderUin) && ntMsg.senderUid) {
      queueUid(ntMsg.senderUid, (uin) => {
        ntMsg.senderUin = String(uin);
      });
    }

    if (Number(ntMsg.chatType) === 1 && !_isPositiveUin(ntMsg.peerUin) && ntMsg.peerUid) {
      queueUid(ntMsg.peerUid, (uin) => {
        ntMsg.peerUin = String(uin);
      });
    }

    if (Array.isArray(ntMsg.elements)) {
      for (const el of ntMsg.elements) {
        if (!el || typeof el !== "object") continue;

        if (el.textElement) {
          const te = el.textElement;
          if (Number(te.atType) === 2 && te.atNtUid && !_isPositiveUin(te.atUid)) {
            queueUid(te.atNtUid, (uin) => {
              te.atUid = String(uin);
            });
          }
        }

        if (Number(el.elementType) === 8 || el.grayTipElement) {
          const gt = el.grayTipElement;
          if (!gt || typeof gt !== "object") continue;

          if (gt.revokeElement && typeof gt.revokeElement === "object") {
            const rev = gt.revokeElement;
            if (rev.operatorUid && !_isPositiveUin(rev.operatorUin)) {
              queueUid(rev.operatorUid, (uin) => {
                rev.operatorUin = String(uin);
              });
            }
            if (rev.origMsgSenderUid && !_isPositiveUin(rev.origMsgSenderUin)) {
              queueUid(rev.origMsgSenderUid, (uin) => {
                rev.origMsgSenderUid = String(uin);
              });
            }
          }

          if (gt.groupElement && typeof gt.groupElement === "object") {
            const ge = gt.groupElement;
            if (ge.memberUid && !_isPositiveUin(ge.memberUin)) {
              queueUid(ge.memberUid, (uin) => {
                ge.memberUin = String(uin);
              });
            }
            if (ge.adminUid && !_isPositiveUin(ge.adminUin)) {
              queueUid(ge.adminUid, (uin) => {
                ge.adminUin = String(uin);
              });
            }
            if (ge.shutUp?.member?.uid && !_isPositiveUin(ge.shutUp.member.uin)) {
              queueUid(ge.shutUp.member.uid, (uin) => {
                ge.shutUp.member.uin = String(uin);
              });
            }
            if (ge.shutUp?.admin?.uid && !_isPositiveUin(ge.shutUp.admin.uin)) {
              queueUid(ge.shutUp.admin.uid, (uin) => {
                ge.shutUp.admin.uin = String(uin);
              });
            }
          }

          if (gt.buddyElement && typeof gt.buddyElement === "object") {
            const be = gt.buddyElement;
            const buddyUid = be.peerUid || ntMsg.peerUid;
            if (buddyUid && !_isPositiveUin(be.peerUin)) {
              queueUid(buddyUid, (uin) => {
                be.peerUin = String(uin);
              });
            }
          }

          const templUids = [];
          _collectTemplParamUids(gt.xmlElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.xmlToJsonParam?.templParam, templUids);
          const rawTipBody = `${gt.xmlElement?.content || ""}\n${gt.jsonGrayTipElement?.jsonStr || ""}`;
          if (rawTipBody.includes("u_")) {
            for (const m of rawTipBody.matchAll(/(?:uid|jp|col_uid)"?\s*[:=]\s*"?(u_[A-Za-z0-9_-]+)"?/gi)) {
              if (m[1]) templUids.push(m[1]);
            }
          }
          for (const uidVal of templUids) {
            queueUid(uidVal, null);
          }
        }
      }
    }

    if (pendingByUid.size > 0) {
      await Promise.all(
        Array.from(pendingByUid.entries()).map(async ([uidStr, callbacks]) => {
          const resolvedUin = await this._ensureUinForUid(uidStr);
          if (_isPositiveUin(resolvedUin)) {
            const uinStr = String(resolvedUin);
            for (const cb of callbacks) {
              cb(uinStr);
            }
            if (callbacks.length > 0) {
              mutated = true;
            }
          }
        })
      );
    }

    if (mutated) {
      this.uinUidStore?.rememberFromNtMsg?.(ntMsg);
    }
  },

  async _handleKernelEvent(_listenerName, eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;

    // 1. Incoming messages: onRecvMsg / onRecvActiveMsg
    if (eventName === "onRecvMsg" || eventName === "onRecvActiveMsg") {
      const msgList = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.msgList)
        ? firstArg.msgList
        : [];
      for (const ntMsg of msgList) {
        await this._processIncomingNtMessage(ntMsg);
      }
      return;
    }

    // 2. Self-sent message confirmation: onAddSendMsg
    if (eventName === "onAddSendMsg") {
      const ntMsg = firstArg?.msgRecord || firstArg;
      if (ntMsg && typeof ntMsg === "object" && ntMsg.msgId) {
        if (this._isDuplicateEvent(`send:${ntMsg.msgId}`)) {
          return;
        }
        this._matchSendEcho(ntMsg);
        this.uinUidStore.rememberFromNtMsg(ntMsg);
        try {
          const ev = formatNtMsgToOneBotEvent(ntMsg, {
            selfId: this.selfUin,
            uinUidStore: this.uinUidStore,
            messageIdStore: this.messageIdStore,
            reportSelfMessage: false,
          });
          if (ev && ev.message_id !== undefined) {
            this.messageIdStore?.indexMsgMedia?.(ntMsg, ev.message_id);
          }
          if (ev && ev.post_type === "message_sent") {
            this._dispatchInboundEvent(ev);
          }
        } finally {
          _stripTransientMedia(ntMsg);
        }
      }
      return;
    }

    // 3. Message updates (recalls, PTT transcription completion, emoji likes, async media updates)
    if (eventName === "onMsgInfoListUpdate") {
      const msgList = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.msgList)
        ? firstArg.msgList
        : [];
      for (const ntMsg of msgList) {
        if (!ntMsg || typeof ntMsg !== "object") continue;

        // Check PTT voice-to-text completion waiters
        if (Array.isArray(ntMsg.elements)) {
          const pttEl = ntMsg.elements.find((e) => e?.elementType === 4 && e.pttElement)?.pttElement;
          if (pttEl && pttEl.text && this._pttTextWaiters.has(String(ntMsg.msgId))) {
            const waiter = this._pttTextWaiters.get(String(ntMsg.msgId));
            this._pttTextWaiters.delete(String(ntMsg.msgId));
            waiter(String(pttEl.text));
          }
        }

        if (_isRecallMsg(ntMsg)) {
          const recallTag =
            ntMsg.recallTime && String(ntMsg.recallTime) !== "0"
              ? String(ntMsg.recallTime)
              : "revoke";
          const dedupKey = `recall:${ntMsg.msgId}:${recallTag}`;
          if (!this._isDuplicateEvent(dedupKey)) {
            await this._resolveNtMsgUids(ntMsg);
            try {
              const ev = formatNtMsgToOneBotEvent(ntMsg, {
                selfId: this.selfUin,
                uinUidStore: this.uinUidStore,
                messageIdStore: this.messageIdStore,
              });
              if (ev && ev.post_type === "notice") {
                this._dispatchInboundEvent(ev);
              }
            } finally {
              _stripTransientMedia(ntMsg);
            }
          }
        } else {
          await this._resolveNtMsgUids(ntMsg);
          try {
            const hit =
              this.messageIdStore?.resolveByNtKey?.(ntMsg.chatType, ntMsg.peerUid, ntMsg.msgId) ||
              (ntMsg.msgId ? this.messageIdStore?.getByMsgId?.(ntMsg.msgId) : null) ||
              (ntMsg.peerUid && ntMsg.msgSeq
                ? this.messageIdStore?.getByPeerAndSeq?.(
                    ntMsg.chatType,
                    ntMsg.peerUid,
                    ntMsg.msgSeq
                  )
                : null);
            if (hit) {
              if (hit.rawMsg !== null && hit.rawMsg !== undefined) {
                hit.rawMsg = ntMsg;
              } else {
                this.messageIdStore?.register?.(
                  ntMsg.msgId,
                  {
                    chatType: Number(ntMsg.chatType || 1),
                    peerUid: String(ntMsg.peerUid || ""),
                    guildId: String(ntMsg.guildId || ""),
                  },
                  ntMsg.msgSeq,
                  {
                    ...(ntMsg.senderUin ? { senderUin: String(ntMsg.senderUin) } : {}),
                    ...(ntMsg.senderUid ? { senderUid: String(ntMsg.senderUid) } : {}),
                    rawMsg: ntMsg,
                  }
                );
              }
              const oneBotId = hit.oneBotId ?? hit.shortId;
              this.messageIdStore?.indexMsgMedia?.(ntMsg, oneBotId);
            } else {
              this.messageIdStore?.indexMsgMedia?.(ntMsg);
            }
          } finally {
            _stripTransientMedia(ntMsg);
          }
        }
      }
      return;
    }

    // 4. Group notifications (join/invite requests)
    if (eventName === "onGroupNotifiesUpdated") {
      const notifies = Array.isArray(args[1])
        ? args[1]
        : Array.isArray(firstArg?.notifies)
        ? firstArg.notifies
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      for (const item of notifies) {
        if (!item || typeof item !== "object") continue;
        const seq = String(item.seq || "");
        const notifyType = Number(item.type || 0);
        const status = Number(item.status || 0);
        const groupId = pickPositiveUin(item.group?.groupCode);
        const flag = seq ? `${seq}:${notifyType}:${groupId}` : "";
        if (flag) setBoundedMap(this._groupNotifiesCache, flag, item);

        if (item.user1?.uid && _isPositiveUin(item.user1?.uin)) {
          this.uinUidStore?.remember?.(item.user1.uin, item.user1.uid, {
            nickname: item.user1.nickName || "",
          });
        }
        if (item.user2?.uid && _isPositiveUin(item.user2?.uin)) {
          this.uinUidStore?.remember?.(item.user2.uin, item.user2.uid, {
            nickname: item.user2.nickName || "",
          });
        }

        // status === 1 means pending approval
        if (status === 1 && (notifyType === 1 || notifyType === 2 || notifyType === 7)) {
          const dedupKey = `group_req:${flag}`;
          if (this._isDuplicateEvent(dedupKey)) continue;
          const userUid = item.user1?.uid || "";
          const resolvedUser1Uin =
            _pickPositiveUin(item.user1?.uin) || (await this._ensureUinForUid(userUid));
          if (_isPositiveUin(resolvedUser1Uin) && item.user1) {
            item.user1.uin = String(resolvedUser1Uin);
          }
          if (item.user2?.uid && !_isPositiveUin(item.user2?.uin)) {
            const resolvedUser2Uin = await this._ensureUinForUid(item.user2.uid);
            if (_isPositiveUin(resolvedUser2Uin)) {
              item.user2.uin = String(resolvedUser2Uin);
            }
          }
          const userUin = _isPositiveUin(resolvedUser1Uin) ? Number(resolvedUser1Uin) : 0;
          const ev = formatRequestEvent(
            "group",
            {
              sub_type: notifyType === 2 ? "invite" : "add",
              group_id: groupId,
              user_id: userUin,
              comment: String(item.postscript || ""),
              flag,
            },
            { selfId: this.selfUin }
          );
          this._dispatchInboundEvent(ev);
        }
      }
      return;
    }

    // 5. Friend requests: onBuddyReqChange
    if (eventName === "onBuddyReqChange") {
      const reqs = Array.isArray(firstArg?.buddyReqs)
        ? firstArg.buddyReqs
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      for (const req of reqs) {
        if (!req || typeof req !== "object") continue;
        if (req.isDecide || Number(req.reqType) !== 1) continue;
        const rawFriendUid = String(req.friendUid || "");
        const positiveReqUin = _pickPositiveUin(req.friendUin);
        const friendUid = rawFriendUid || positiveReqUin;
        const reqExtra = String(req.reqTime || req.flag || req.postscript || req.extWords || "0");
        const flag = `${friendUid}:${reqExtra}`;
        setBoundedMap(this._buddyReqsCache, flag, req);
        const dedupKey = `friend_req:${friendUid}:${req.reqTime || req.flag || req.postscript || req.extWords || ""}`;
        if (this._isDuplicateEvent(dedupKey)) continue;
        const resolvedUin =
          positiveReqUin || (await this._ensureUinForUid(rawFriendUid || friendUid));
        if (_isPositiveUin(resolvedUin)) {
          req.friendUin = String(resolvedUin);
          if (rawFriendUid) {
            this.uinUidStore?.remember?.(resolvedUin, rawFriendUid, {
              nickname: req.friendNick || "",
            });
          }
        }
        const userUin = _isPositiveUin(resolvedUin) ? Number(resolvedUin) : 0;
        const ev = formatRequestEvent(
          "friend",
          {
            user_id: userUin,
            comment: String(req.extWords || ""),
            flag,
          },
          { selfId: this.selfUin }
        );
        this._dispatchInboundEvent(ev);
      }
      return;
    }

    // 6. Buddy list change (V1 & V2) + Profile simple change + RichMedia download complete
    if (eventName === "onBuddyListChange" || eventName === "onBuddyListChangedV2") {
      this.uinUidStore.rememberFromBuddyList(firstArg);
      const cats = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.buddyCategory)
        ? firstArg.buddyCategory
        : Array.isArray(firstArg?.data)
        ? firstArg.data
        : [];
      if (cats.length > 0) {
        this._buddyCategoriesCache = cats;
        this.online = true;
      }
      for (const waiter of Array.from(this._buddyListWaiters)) {
        try {
          waiter(firstArg);
        } catch (err) {
          this.logger?.debug?.("inbound", err);
        }
      }
      return;
    }

    if (eventName === "onProfileSimpleChanged") {
      const profiles = firstArg?.profiles || firstArg;
      const entries =
        profiles instanceof Map
          ? Array.from(profiles.entries())
          : profiles && typeof profiles === "object"
          ? Object.entries(profiles)
          : [];
      for (const [uidKey, info] of entries) {
        if (!info || typeof info !== "object") continue;
        const core = info.coreInfo || info.baseInfo || info;
        const uin = _pickPositiveUin(core.uin, info.uin);
        this.uinUidStore.remember(uin, core.uid || info.uid || uidKey, {
          nickname: core.nick || info.nick || "",
          remark: core.remark || info.remark || "",
        });
      }
      return;
    }

    if (eventName === "onRichMediaDownloadComplete") {
      const info = firstArg?.notifyInfo || firstArg || {};
      const msgId = String(info.msgId || "");
      const elId = String(info.msgElementId || info.elementId || "");
      const filePath = String(info.filePath || "");
      const keys = [`${msgId}:${elId}`, `${msgId}:0`, filePath].filter(Boolean);
      const toInvoke = new Set();
      for (const k of keys) {
        const set = this._richMediaWaiters?.get(k);
        if (!set) continue;
        for (const waiter of Array.from(set)) {
          if (typeof waiter === "function") {
            set.delete(waiter);
            toInvoke.add(waiter);
          } else if (waiter && typeof waiter.resolve === "function") {
            const specificElMismatch =
              elId &&
              elId !== "0" &&
              waiter.elementId &&
              waiter.elementId !== "0" &&
              waiter.elementId !== elId &&
              (!filePath || !waiter.targetPath || filePath !== waiter.targetPath);
            if (!specificElMismatch) {
              set.delete(waiter);
              toInvoke.add(waiter);
            }
          }
        }
        if (set.size === 0) {
          this._richMediaWaiters.delete(k);
        }
      }
      for (const waiter of toInvoke) {
        try {
          if (typeof waiter === "function") {
            waiter(filePath);
          } else {
            waiter.resolve(filePath);
          }
        } catch (err) {
          this.logger?.debug?.("inbound", err);
        }
      }
      return;
    }

    // 7. Group list update
    if (eventName === "onGroupListUpdate") {
      const groupList = Array.isArray(args[1])
        ? args[1]
        : Array.isArray(firstArg?.groupList)
        ? firstArg.groupList
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      if (groupList.length > 0) {
        this.online = true;
      }
      for (const g of groupList) {
        if (g && (g.groupCode || g.groupUin || g.group_id)) {
          const gid = String(g.groupCode || g.groupUin || g.group_id);
          setBoundedMap(this._groupListCache, gid, g);
        }
      }
      for (const waiter of Array.from(this._groupListWaiters)) {
        try {
          waiter(groupList);
        } catch (err) {
          this.logger?.debug?.("inbound", err);
        }
      }
      return;
    }

    // 8. Group member info change
    if (eventName === "onMemberInfoChange") {
      const groupCode = String(firstArg || "");
      const members = args[2] || args[1];
      if (groupCode && members) {
        this.uinUidStore.rememberFromGroupMemberList(groupCode, members);
      }
      return;
    }

    // 9. Login / QR / Session / Offline
    if (eventName === "onQRCodeGetPicture" || eventName === "onQRCodeSessionQuickLoginFailed") {
      const pngBase64 =
        firstArg?.pngBase64QrcodeData ||
        firstArg?.qrcodeImage ||
        firstArg?.result?.pngBase64QrcodeData ||
        "";
      if (pngBase64) {
        this.lastQrCodeBase64 = String(pngBase64);
      }
      return;
    }
    if (eventName === "onUserLoggedIn" || eventName === "onQRCodeLoginSucceed") {
      const identity = normalizeLoginIdentity(firstArg);
      this._updateSelfIdentity({
        ...identity,
        markOnline: true,
      });
      return;
    }
    if (eventName === "onSessionInitComplete") {
      const code =
        firstArg && typeof firstArg === "object" ? Number(firstArg.result ?? 0) : Number(firstArg ?? 0);
      if (!Number.isFinite(code) || code === 0) {
        this.online = true;
      }
      return;
    }
    if (eventName === "onKickedOffLine") {
      this.online = false;
      this._resetHumanSessionState({ resetRenderer: true });
      this._dispatchInboundEvent(
        formatNoticeEvent(
          "bot_offline",
          {
            user_id: pickPositiveUin(this.selfUin),
            tag: String(firstArg?.tipsTitle || "kicked_offline"),
            message: String(firstArg?.tipsDesc || "QQ offline"),
          },
          { selfId: this.selfUin }
        )
      );
    }
  },

  async _downloadRichMediaElement({
    msgId,
    chatType,
    peerUid,
    elementId,
    downloadType = 1,
    thumbSize = 0,
    filePath = "",
    timeoutMs = 8000,
  } = {}) {
    const targetPath = filePath ? String(filePath).trim() : "";
    if (targetPath) {
      const existingStat = await _statPositiveFile(targetPath);
      if (existingStat) {
        return targetPath;
      }
    }
    if (!this._isNtReady()) return "";
    if (!msgId || !peerUid) return "";

    const msgIdStr = String(msgId);
    const elIdStr = String(elementId || "0");
    const effectiveTimeout = Math.max(100, Number(timeoutMs) || 8000);
    if (!this._richMediaWaiters) {
      this._richMediaWaiters = new Map();
    }
    const waitKeys = [`${msgIdStr}:${elIdStr}`, `${msgIdStr}:0`, targetPath].filter(Boolean);

    let timer = null;
    let pollTimer = null;
    let waiterEntry = null;
    const cleanupWaiter = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (waiterEntry && this._richMediaWaiters) {
        for (const k of waitKeys) {
          const set = this._richMediaWaiters.get(k);
          if (set) {
            set.delete(waiterEntry);
            if (set.size === 0) {
              this._richMediaWaiters.delete(k);
            }
          }
        }
      }
    };

    const waitDownload = new Promise((resolve) => {
      let settled = false;
      let polling = false;
      const finish = (candidate) => {
        if (settled) return;
        settled = true;
        cleanupWaiter();
        resolve(candidate || targetPath);
      };
      waiterEntry = {
        msgId: msgIdStr,
        elementId: elIdStr,
        targetPath,
        resolve: (downloadedPath) => finish(downloadedPath || targetPath),
      };
      for (const k of waitKeys) {
        if (!this._richMediaWaiters.has(k)) {
          this._richMediaWaiters.set(k, new Set());
        }
        this._richMediaWaiters.get(k).add(waiterEntry);
      }
      if (targetPath) {
        pollTimer = setInterval(async () => {
          if (polling || settled) return;
          polling = true;
          try {
            const st = await _statPositiveFile(targetPath);
            if (st) {
              finish(targetPath);
            }
          } finally {
            polling = false;
          }
        }, 200);
        pollTimer.unref?.();
      }
      timer = setTimeout(() => finish(targetPath), effectiveTimeout);
      timer.unref?.();
    });

    try {
      const getReq = {
        downSourceType: 0,
        downloadSourceType: 0,
        fileModelId: "0",
        triggerType: 1,
        msgId: msgIdStr,
        chatType: Number(chatType || 1),
        peerUid: String(peerUid),
        elementId: elIdStr,
        thumbSize: Number(thumbSize || 0),
        downloadType: Number(downloadType ?? 1),
        filePath: targetPath,
      };
      const dlRes =
        typeof this.invokeNt === "function"
          ? await this.invokeNt(
              "nodeIKernelMsgService/downloadRichMedia",
              { getReq },
              [getReq]
            )
          : typeof this.ntCall === "function"
          ? await this.ntCall("nodeIKernelMsgService", "downloadRichMedia", [{ getReq }])
          : null;
      const directPath =
        typeof dlRes === "string" ? dlRes : dlRes?.filePath ? String(dlRes.filePath) : "";
      if (directPath && (await _statPositiveFile(directPath))) {
        return directPath;
      }
      const waitedPath = await waitDownload;
      if (waitedPath && (await _statPositiveFile(waitedPath))) {
        return String(waitedPath);
      }
    } catch (err) {
      this.logger?.debug?.("inbound", err);
    } finally {
      cleanupWaiter();
    }
    return "";
  },

  async _hydrateNtMsgMedia(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    const maxPicBytes = 10 * 1024 * 1024;
    const maxPttBytes = 2 * 1024 * 1024;
    const hydrationTimeout = Math.max(
      500,
      Number(
        this.config?.mediaHydrationTimeoutMs ??
          this.config?.richMediaDownloadTimeoutMs ??
          8000
      ) || 8000
    );

    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      const elType = Number(el.elementType);

      if (elType === 2 && el.picElement) {
        const pe = el.picElement;
        if (pe.__base64Uri) continue;
        const origin = String(pe.originImageUrl || "").trim();
        if (origin && origin.includes("rkey=")) continue;
        if (
          origin &&
          /^https?:\/\//i.test(origin) &&
          !origin.includes("multimedia.nt.qq.com.cn/download")
        ) {
          continue;
        }
        if (Number(pe.fileSize || 0) > maxPicBytes) continue;

        let localPath = String(pe.sourcePath || "").trim();
        let st = await _statPositiveFile(localPath);

        if (!st && !localPath && pe.md5HexStr && this._isNtReady()) {
          try {
            const pathInfo = {
              md5HexStr: String(pe.md5HexStr),
              fileName: String(pe.fileName || `${pe.md5HexStr}.jpg`),
              elementType: 2,
              elementSubType: Number(pe.picSubType || 0),
              thumbSize: 0,
              needCreate: true,
              downloadType: 1,
              file_uuid: String(pe.fileUuid || ""),
            };
            const pathRes = await this.invokeNt(
              "nodeIKernelMsgService/getRichMediaFilePathForGuild",
              { path_info: pathInfo },
              [pathInfo]
            );
            const resolvedPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
            if (resolvedPath) {
              localPath = String(resolvedPath);
              st = await _statPositiveFile(localPath);
            }
          } catch (err) {
            this.logger?.debug?.("inbound", err);
          }
        }

        if (!st && ntMsg.msgId && ntMsg.peerUid) {
          const downloadedOrig = await this._downloadRichMediaElement({
            msgId: ntMsg.msgId,
            chatType: ntMsg.chatType || 1,
            peerUid: ntMsg.peerUid,
            elementId: el.elementId || "0",
            downloadType: 1,
            thumbSize: 0,
            filePath: localPath,
            timeoutMs: Math.min(hydrationTimeout, 8000),
          });
          if (downloadedOrig) {
            const dlStat = await _statPositiveFile(downloadedOrig);
            if (dlStat && dlStat.size <= maxPicBytes) {
              localPath = downloadedOrig;
              st = dlStat;
            }
          }
        }

        if (!st) {
          const thumbs =
            pe.thumbPath instanceof Map
              ? Array.from(pe.thumbPath.values())
              : pe.thumbPath && typeof pe.thumbPath === "object"
              ? Object.values(pe.thumbPath)
              : [];
          for (const tp of thumbs) {
            const candidate = String(tp || "").trim();
            const tpStat = await _statPositiveFile(candidate);
            if (tpStat && tpStat.size <= maxPicBytes) {
              localPath = candidate;
              st = tpStat;
              break;
            }
          }
          if (!st && ntMsg.msgId && ntMsg.peerUid) {
            const fallbackThumbPath = thumbs.length > 0 ? String(thumbs[0] || "") : "";
            const downloadedThumb = await this._downloadRichMediaElement({
              msgId: ntMsg.msgId,
              chatType: ntMsg.chatType || 1,
              peerUid: ntMsg.peerUid,
              elementId: el.elementId || "0",
              downloadType: 2,
              thumbSize: 720,
              filePath: fallbackThumbPath,
              timeoutMs: Math.min(hydrationTimeout, 5000),
            });
            if (downloadedThumb) {
              const dlThumbStat = await _statPositiveFile(downloadedThumb);
              if (dlThumbStat && dlThumbStat.size <= maxPicBytes) {
                localPath = downloadedThumb;
                st = dlThumbStat;
              }
            }
          }
        }

        if (st && st.size > 0 && localPath) {
          pe.sourcePath = localPath;
          if (st.size <= maxPicBytes) {
            try {
              const buf = await fs.promises.readFile(localPath);
              Object.defineProperty(pe, "__base64Uri", {
                value: `base64://${buf.toString("base64")}`,
                enumerable: false,
                configurable: true,
                writable: true,
              });
            } catch (err) {
              this.logger?.debug?.("inbound", err);
            }
          }
        }
        continue;
      }

      if (elType === 4 && el.pttElement) {
        const ptt = el.pttElement;
        if (ptt.__base64Uri) continue;
        let localPath = String(ptt.filePath || ptt.sourcePath || "").trim();
        let st = await _statPositiveFile(localPath);

        if (!st && this._isNtReady() && ntMsg.msgId && ntMsg.peerUid && el.elementId) {
          const downloadedPtt = await this._downloadRichMediaElement({
            msgId: ntMsg.msgId,
            chatType: ntMsg.chatType || 1,
            peerUid: ntMsg.peerUid,
            elementId: el.elementId,
            downloadType: 1,
            thumbSize: 0,
            filePath: localPath,
            timeoutMs: Math.min(hydrationTimeout, 8000),
          });
          if (downloadedPtt) {
            localPath = downloadedPtt;
            st = await _statPositiveFile(localPath);
          }
        }

        if (st && st.size > 0 && localPath) {
          ptt.filePath = localPath;
          if (st.size <= maxPttBytes) {
            try {
              const buf = await fs.promises.readFile(localPath);
              Object.defineProperty(ptt, "__base64Uri", {
                value: `base64://${buf.toString("base64")}`,
                enumerable: false,
                configurable: true,
                writable: true,
              });
            } catch (err) {
              this.logger?.debug?.("inbound", err);
            }
          }
        }
      }
    }

    this.messageIdStore?.indexMsgMedia?.(ntMsg);
  },

  async _processIncomingNtMessage(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    const msgId = String(ntMsg.msgId || "");
    if (msgId && this._isDuplicateEvent(`msg:${msgId}`)) {
      return;
    }

    await this._resolveNtMsgUids(ntMsg);
    await this._hydrateNtMsgMedia(ntMsg);

    try {
      const ev = formatNtMsgToOneBotEvent(ntMsg, {
        selfId: this.selfUin,
        uinUidStore: this.uinUidStore,
        messageIdStore: this.messageIdStore,
      });
      if (ev && ev.message_id !== undefined) {
        this.messageIdStore?.indexMsgMedia?.(ntMsg, ev.message_id);
      }
      if (ev) {
        this._dispatchInboundEvent(ev);
      }

      const uploadNotice = formatGroupUploadNotice(ntMsg, {
        selfId: this.selfUin,
        uinUidStore: this.uinUidStore,
      });
      if (uploadNotice) {
        this._dispatchInboundEvent(uploadNotice);
      }
    } finally {
      _stripTransientMedia(ntMsg);
    }

    const autoReadAndType =
      Boolean(this.config && this.config.autoReadAndTypeOnPrivateRecv === true) ||
      isPrefixedEnvFlagOne("AUTO_READ_AND_TYPE_ON_PRIVATE_RECV");
    const isSelfSender =
      (Boolean(this.selfUin) && String(ntMsg.senderUin || "") === String(this.selfUin)) ||
      (Boolean(this.selfUid) && String(ntMsg.senderUid || "") === String(this.selfUid));
    if (
      this.config.humanSimulation !== false &&
      autoReadAndType &&
      Number(ntMsg.chatType) === 1 &&
      ntMsg.peerUid &&
      Number(ntMsg.msgType) !== 5 &&
      !isSelfSender
    ) {
      const peerUid = String(ntMsg.peerUid);
      const peerKey = `1:${peerUid}:`;
      this._sessionScheduler.schedulePrivateRecvReaction(
        peerKey,
        this.config.autoReadReactionDelayMs ?? [500, 1800],
        () =>
          this.simulateHumanSession({
            chatType: 1,
            peerUid,
            guildId: "",
            markRead: true,
            sendTyping: true,
            eventType: 1,
            advisory: true,
          }).catch((err) => {
            this.logger?.debug?.("inbound", err);
          })
      );
    }
  },
};

module.exports = {
  inboundPipelineMixin,
  _isPositiveUin,
};
