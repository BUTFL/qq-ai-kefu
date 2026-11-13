"use strict";

const crypto = require("crypto");
const path = require("path");

function pickPositiveUin(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "" || typeof c === "boolean") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      const t = Math.trunc(n);
      if (t > 0) return t;
    }
  }
  return 0;
}

// ============================================================================
// 1. MessageIdStore (Bounded LRU, 32-bit positive integer OneBot message_id)
// ============================================================================

class MessageIdStore {
  constructor(maxEntries = 10000, maxRawEntries = 256) {
    this.maxEntries = Math.max(2, Number(maxEntries) || 10000);
    const parsedMaxRaw =
      maxRawEntries !== undefined && maxRawEntries !== null ? Number(maxRawEntries) : 256;
    this.maxRawEntries =
      Number.isFinite(parsedMaxRaw) && parsedMaxRaw >= 0 ? Math.trunc(parsedMaxRaw) : 256;
    this.byShortId = new Map();
    this.byOneBotId = this.byShortId;
    this.byMsgId = new Map();
    this.byPeerSeq = new Map();
    this._rawIds = new Set();
    this.byMediaKey = new Map();
    this._seqCounter = 100000;
  }

  static _peerSeqKey(chatType, peerUid, msgSeq) {
    if (!peerUid || msgSeq === undefined || msgSeq === null || String(msgSeq) === "0" || String(msgSeq) === "") {
      return "";
    }
    return `${Number(chatType) || 0}:${String(peerUid)}:${String(msgSeq)}`;
  }

  _computeShortId(msgIdStr, peer, msgSeq) {
    const seed = `${msgIdStr || ""}|${peer?.chatType || 0}|${peer?.peerUid || ""}|${msgSeq || ""}`;
    const digest = crypto.createHash("md5").update(seed).digest();
    // Positive 31-bit integer in [1, 0x7fffffff]
    let candidate = (digest.readUInt32BE(0) & 0x7fffffff) || 1;
    let attempts = 0;
    while (this.byShortId.has(candidate) && attempts < 16) {
      const existing = this.byShortId.get(candidate);
      if (existing && msgIdStr && existing.msgId === msgIdStr) {
        return candidate;
      }
      candidate = ((candidate + 1) & 0x7fffffff) || 1;
      attempts++;
    }
    if (this.byShortId.has(candidate)) {
      this._seqCounter = ((this._seqCounter + 1) & 0x7fffffff) || 1;
      candidate = this._seqCounter;
    }
    return candidate;
  }

  _touchRawId(oneBotId) {
    if (oneBotId === undefined || oneBotId === null) return;
    const id = Number(oneBotId);
    this._rawIds.delete(id);
    this._rawIds.add(id);
    this._evictRawIfNeeded();
  }

  _evictRawIfNeeded() {
    while (this._rawIds.size > this.maxRawEntries) {
      const id = this._rawIds.values().next().value;
      if (id === undefined) break;
      this._rawIds.delete(id);
      const old = this.byShortId.get(id);
      if (old) {
        old.rawMsg = null;
        old.oneBotEvent = null;
      }
    }
  }

  _evictIfNeeded() {
    while (this.byShortId.size > this.maxEntries) {
      const oldestKey = this.byShortId.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.byShortId.get(oldestKey);
      this.byShortId.delete(oldestKey);
      this._rawIds.delete(oldestKey);
      if (entry) {
        if (entry.msgId && this.byMsgId.get(entry.msgId) === entry) {
          this.byMsgId.delete(entry.msgId);
        }
        const psKey = MessageIdStore._peerSeqKey(
          entry.peer?.chatType,
          entry.peer?.peerUid,
          entry.msgSeq
        );
        if (psKey && this.byPeerSeq.get(psKey) === entry) {
          this.byPeerSeq.delete(psKey);
        }
        if (entry._mediaKeys) {
          for (const k of entry._mediaKeys) {
            const cur = this.byMediaKey.get(k);
            if (cur && cur.oneBotId === oldestKey) {
              this.byMediaKey.delete(k);
            }
          }
        }
      }
    }
  }

  _touch(entry) {
    if (!entry) return null;
    this.byShortId.delete(entry.shortId);
    this.byShortId.set(entry.shortId, entry);
    return entry;
  }

  get size() {
    return this.byShortId.size;
  }

  resolveByNtKey(chatType, peerUid, msgId) {
    if (msgId !== undefined && msgId !== null && String(msgId) !== "" && String(msgId) !== "0") {
      const byId = this.byMsgId.get(String(msgId));
      if (byId) return this._touch(byId);
    }
    return null;
  }

  resolve(id) {
    if (id === undefined || id === null || id === "") return null;
    const entry = this.get(id) || this.getByNtMsgId(String(id));
    if (!entry) return null;
    return {
      entry,
      msgId: entry.msgId,
      peer: entry.peer,
      msgSeq: entry.msgSeq,
    };
  }

  indexMsgMedia(ntMsg, oneBotId = null) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    if (oneBotId == null && ntMsg.msgId && ntMsg.peerUid) {
      oneBotId = this.resolveByNtKey(ntMsg.chatType, ntMsg.peerUid, ntMsg.msgId)?.oneBotId ?? null;
    } else if (oneBotId == null && ntMsg.msgId) {
      oneBotId = this.byMsgId.get(String(ntMsg.msgId))?.oneBotId ?? null;
    }
    const entry = oneBotId != null ? this.byOneBotId.get(Number(oneBotId)) || null : null;
    if (entry && !entry._mediaKeys) {
      entry._mediaKeys = new Set();
    }
    const resolvedOneBotId = entry
      ? entry.oneBotId
      : oneBotId != null
      ? Number(oneBotId) || null
      : null;

    const setKey = (k, desc, fallbackOnly = false) => {
      if (!k || typeof k !== "string") return;
      const trimmed = k.trim();
      if (!trimmed) return;
      if (fallbackOnly && this.byMediaKey.has(trimmed)) {
        const prev = this.byMediaKey.get(trimmed);
        if (prev && prev.ntMsgId && desc.ntMsgId && prev.ntMsgId !== desc.ntMsgId) {
          return;
        }
      }
      this.byMediaKey.set(trimmed, desc);
      if (entry) entry._mediaKeys.add(trimmed);
    };

    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      const elementType = Number(el.elementType) || 0;
      let md5 = "";
      let fileUuid = "";
      let fileName = "";
      let sourcePath = "";
      let url = "";

      if (elementType === 2 && el.picElement) {
        const pe = el.picElement;
        md5 = pe.md5HexStr || "";
        fileUuid = pe.fileUuid || "";
        fileName = pe.fileName || "";
        sourcePath = pe.sourcePath || "";
        url = pe.originImageUrl || "";
      } else if (elementType === 3 && el.fileElement) {
        const fe = el.fileElement;
        md5 = fe.fileMd5 || "";
        fileUuid = fe.fileUuid || "";
        fileName = fe.fileName || "";
        sourcePath = fe.filePath || "";
        url = "";
      } else if (elementType === 4 && el.pttElement) {
        const ptt = el.pttElement;
        md5 = ptt.md5HexStr || "";
        fileUuid = ptt.fileUuid || "";
        fileName = ptt.fileName || "";
        sourcePath = ptt.filePath || ptt.sourcePath || "";
        url = "";
      } else if (elementType === 5 && el.videoElement) {
        const ve = el.videoElement;
        md5 = ve.videoMd5 || ve.md5HexStr || "";
        fileUuid = ve.fileUuid || "";
        fileName = ve.fileName || "";
        sourcePath = ve.filePath || ve.sourcePath || "";
        url = "";
      } else {
        continue;
      }

      const desc = {
        oneBotId: resolvedOneBotId,
        shortId: resolvedOneBotId,
        ntMsgId: String(ntMsg.msgId || ""),
        msgId: String(ntMsg.msgId || ""),
        chatType: Number(ntMsg.chatType) || 0,
        peerUid: String(ntMsg.peerUid || ""),
        elementId: String(el.elementId || ""),
        elementType,
        md5: String(md5 || ""),
        fileUuid: String(fileUuid || ""),
        fileName: String(fileName || ""),
        sourcePath: String(sourcePath || ""),
        url: String(url || ""),
      };

      if (desc.fileUuid) {
        setKey(desc.fileUuid, desc);
      }
      if (desc.md5) {
        setKey(desc.md5, desc);
        setKey(desc.md5.toLowerCase(), desc);
      }
      if (desc.fileName) {
        const base = path.basename(desc.fileName);
        setKey(desc.fileName, desc);
        setKey(desc.fileName.toLowerCase(), desc, true);
        if (base && base !== desc.fileName) {
          setKey(base, desc);
          setKey(base.toLowerCase(), desc, true);
        }
      }
      if (desc.md5) {
        const md5Lower = desc.md5.toLowerCase();
        for (const ext of [".jpg", ".png", ".gif", ".amr", ".silk"]) {
          setKey(`${md5Lower}${ext}`, desc, true);
        }
      }
    }
  }

  lookupMedia(fileToken) {
    if (!fileToken || typeof fileToken !== "string") return null;
    const raw = fileToken.trim();
    if (!raw) return null;

    const direct = this.byMediaKey.get(raw) || this.byMediaKey.get(raw.toLowerCase());
    if (direct) return direct;

    if (raw.startsWith("ntqq://")) {
      try {
        const normalized = raw.includes("&amp;") ? raw.replace(/&amp;/g, "&") : raw;
        const parsed = new URL(normalized);
        const uuid = parsed.searchParams.get("uuid") || "";
        const md5 = parsed.searchParams.get("md5") || "";
        const file = parsed.searchParams.get("file") || "";
        for (const cand of [uuid, md5, md5.toLowerCase(), file, file.toLowerCase()]) {
          if (cand && this.byMediaKey.has(cand)) {
            return this.byMediaKey.get(cand);
          }
        }
        if (file) {
          const fileMd5Match = /^([0-9a-fA-F]{32})\.[a-zA-Z0-9]+$/.exec(file);
          if (fileMd5Match) {
            const byFileMd5 =
              this.byMediaKey.get(fileMd5Match[1].toLowerCase()) ||
              this.byMediaKey.get(fileMd5Match[1]);
            if (byFileMd5) return byFileMd5;
          }
        }
      } catch (_) {}
    }

    const md5ExtMatch = /^([0-9a-fA-F]{32})\.[a-zA-Z0-9]+$/.exec(raw);
    if (md5ExtMatch) {
      const hit =
        this.byMediaKey.get(md5ExtMatch[1].toLowerCase()) ||
        this.byMediaKey.get(md5ExtMatch[1]);
      if (hit) return hit;
    }

    return null;
  }

  register(msgId, peer, msgSeq, extra = {}) {
    if (msgId && typeof msgId === "object" && !Array.isArray(msgId)) {
      const obj = msgId;
      return this.register(
        obj.msgId,
        obj.peer || {
          chatType: obj.chatType,
          peerUid: obj.peerUid,
          guildId: obj.guildId,
        },
        obj.msgSeq,
        obj
      );
    }
    if (peer !== undefined && peer !== null && typeof peer !== "object" && arguments.length >= 3) {
      const chatTypeArg = peer;
      const peerUidArg = msgSeq;
      const msgSeqArg = arguments[3];
      const senderUinArg = arguments[4];
      const rawMsgArg = arguments[5] ?? null;
      const oneBotEventArg = arguments[6] ?? null;
      return this.register(
        msgId,
        { chatType: Number(chatTypeArg) || 1, peerUid: String(peerUidArg ?? ""), guildId: "" },
        msgSeqArg,
        {
          ...(senderUinArg !== undefined ? { senderUin: senderUinArg } : {}),
          ...(rawMsgArg !== null && rawMsgArg !== undefined ? { rawMsg: rawMsgArg } : {}),
          ...(oneBotEventArg !== null && oneBotEventArg !== undefined
            ? { oneBotEvent: oneBotEventArg }
            : {}),
        }
      );
    }
    const msgIdStr = msgId !== undefined && msgId !== null && String(msgId) !== "0" ? String(msgId) : "";
    const normPeer = {
      chatType: Number(peer?.chatType || extra.chatType || 1),
      peerUid: String(peer?.peerUid || extra.peerUid || ""),
      guildId: String(peer?.guildId || extra.guildId || ""),
    };
    const msgSeqStr = msgSeq !== undefined && msgSeq !== null ? String(msgSeq) : "";
    const psKey = MessageIdStore._peerSeqKey(normPeer.chatType, normPeer.peerUid, msgSeqStr);
    const rawMsg = extra.rawMsg || null;
    const rawRandom =
      extra.msgRandom !== undefined && extra.msgRandom !== null && extra.msgRandom !== ""
        ? extra.msgRandom
        : rawMsg?.msgRandom;
    const msgRandom =
      rawRandom !== undefined && rawRandom !== null && rawRandom !== "" ? String(rawRandom) : null;

    let existing = null;
    if (msgIdStr && this.byMsgId.has(msgIdStr)) {
      existing = this.byMsgId.get(msgIdStr);
    } else if (psKey && this.byPeerSeq.has(psKey)) {
      const candidate = this.byPeerSeq.get(psKey);
      const candMsgId = candidate && candidate.msgId ? String(candidate.msgId) : "";
      if (
        !msgIdStr ||
        !candMsgId ||
        candMsgId === "0" ||
        candMsgId.startsWith("sent_") ||
        candMsgId === String(candidate.shortId)
      ) {
        existing = candidate;
      }
    }

    if (existing) {
      if (
        msgIdStr &&
        (!existing.msgId ||
          existing.msgId === "0" ||
          String(existing.msgId).startsWith("sent_") ||
          String(existing.msgId) === String(existing.shortId))
      ) {
        existing.msgId = msgIdStr;
        this.byMsgId.set(msgIdStr, existing);
      }
      if (normPeer.peerUid) {
        existing.peer = normPeer;
        existing.chatType = normPeer.chatType;
        existing.peerUid = normPeer.peerUid;
      }
      if (msgSeqStr && msgSeqStr !== "0") {
        existing.msgSeq = msgSeqStr;
        if (psKey) this.byPeerSeq.set(psKey, existing);
      }
      if (extra.senderUin !== undefined) {
        const nextUin = String(extra.senderUin);
        if (pickPositiveUin(nextUin) > 0 || !existing.senderUin) {
          existing.senderUin = nextUin;
        }
      }
      if (extra.senderUid !== undefined && (extra.senderUid || !existing.senderUid)) {
        existing.senderUid = String(extra.senderUid);
      }
      if (extra.groupId !== undefined && (extra.groupId || !existing.groupId)) {
        existing.groupId = String(extra.groupId);
      }
      if (extra.msgTime !== undefined) existing.msgTime = Number(extra.msgTime);
      if (msgRandom && !existing.msgRandom) existing.msgRandom = msgRandom;
      if (!existing._mediaKeys) existing._mediaKeys = new Set();
      if (rawMsg) {
        existing.rawMsg = rawMsg;
        this._touchRawId(existing.shortId);
        this.indexMsgMedia(rawMsg, existing.shortId);
      }
      if (extra.oneBotEvent) existing.oneBotEvent = extra.oneBotEvent;
      this._touch(existing);
      return existing.shortId;
    }

    const shortId = this._computeShortId(msgIdStr, normPeer, msgSeqStr);
    const entry = {
      shortId,
      oneBotId: shortId,
      msgId: msgIdStr || String(shortId),
      peer: normPeer,
      chatType: normPeer.chatType,
      peerUid: normPeer.peerUid,
      msgSeq: msgSeqStr || "0",
      msgRandom,
      senderUin: extra.senderUin !== undefined ? String(extra.senderUin) : "",
      senderUid: extra.senderUid !== undefined ? String(extra.senderUid) : "",
      groupId: extra.groupId !== undefined ? String(extra.groupId) : "",
      msgTime: Number(extra.msgTime || Math.floor(Date.now() / 1000)),
      rawMsg,
      oneBotEvent: extra.oneBotEvent || null,
      createdAt: Date.now(),
      _mediaKeys: new Set(),
    };

    this.byShortId.set(shortId, entry);
    if (msgIdStr) {
      this.byMsgId.set(msgIdStr, entry);
    }
    if (psKey) {
      this.byPeerSeq.set(psKey, entry);
    }
    if (rawMsg) {
      this._touchRawId(shortId);
      this.indexMsgMedia(rawMsg, shortId);
    }
    this._evictIfNeeded();
    return shortId;
  }

  get(shortId) {
    return this.getByShortId(shortId);
  }

  getByShortId(shortId) {
    if (shortId === undefined || shortId === null) return null;
    const num = Number(shortId);
    if (Number.isInteger(num) && this.byShortId.has(num)) {
      return this._touch(this.byShortId.get(num));
    }
    const str = String(shortId).trim();
    if (this.byMsgId.has(str)) {
      return this._touch(this.byMsgId.get(str));
    }
    return null;
  }

  getByMsgId(msgId) {
    if (msgId === undefined || msgId === null) return null;
    const str = String(msgId).trim();
    if (this.byMsgId.has(str)) {
      return this._touch(this.byMsgId.get(str));
    }
    const num = Number(str);
    if (Number.isInteger(num) && this.byShortId.has(num)) {
      return this._touch(this.byShortId.get(num));
    }
    return null;
  }

  getByNtMsgId(msgId) {
    return this.getByMsgId(msgId);
  }

  getByPeerAndSeq(chatType, peerUid, msgSeq) {
    const psKey = MessageIdStore._peerSeqKey(chatType, peerUid, msgSeq);
    if (!psKey) return null;
    const entry = this.byPeerSeq.get(psKey);
    return entry ? this._touch(entry) : null;
  }

  getByPeerSeq(chatType, peerUid, msgSeq) {
    return this.getByPeerAndSeq(chatType, peerUid, msgSeq);
  }
}

// ============================================================================
// 2. UinUidStore (Bi-Directional QQ UIN <-> NTQQ UID Cache)
// ============================================================================

class UinUidStore {
  constructor(maxEntries = 20000) {
    this.maxEntries = Math.max(500, Number(maxEntries) || 20000);
    this.uinToUid = new Map();
    this.uidToUin = new Map();
    this.userMeta = new Map(); // uin -> { uin, uid, nickname, remark, sex, age }
    this.groupMemberMeta = new Map(); // `${groupId}:${uin}` -> { uin, uid, nickname, card, role, title }
  }

  _evictIfNeeded() {
    while (this.uinToUid.size > this.maxEntries) {
      const oldestUin = this.uinToUid.keys().next().value;
      if (oldestUin === undefined) break;
      const uid = this.uinToUid.get(oldestUin);
      this.uinToUid.delete(oldestUin);
      if (uid && this.uidToUin.get(uid) === oldestUin) {
        this.uidToUin.delete(uid);
      }
    }
  }

  record(uin, uid, meta = null) {
    return this.remember(uin, uid, meta);
  }

  register(uin, uid, meta = null) {
    return this.remember(uin, uid, meta);
  }

  remember(uin, uid, meta = null) {
    const uinStr = uin !== undefined && uin !== null ? String(uin).trim() : "";
    const uidStr = uid !== undefined && uid !== null ? String(uid).trim() : "";
    const validUin = /^\d+$/.test(uinStr) && Number(uinStr) > 0;
    const validUid = uidStr.length > 0 && uidStr !== "0";

    if (validUin && validUid) {
      this.uinToUid.delete(uinStr);
      this.uinToUid.set(uinStr, uidStr);
      this.uidToUin.delete(uidStr);
      this.uidToUin.set(uidStr, uinStr);
      this._evictIfNeeded();
    }

    if (validUin && meta && typeof meta === "object") {
      const prev = this.userMeta.get(uinStr) || { uin: Number(uinStr), uid: uidStr };
      this.userMeta.set(uinStr, {
        ...prev,
        ...(validUid ? { uid: uidStr } : {}),
        ...(meta.nickname ? { nickname: String(meta.nickname) } : {}),
        ...(meta.remark !== undefined ? { remark: String(meta.remark) } : {}),
        ...(meta.sex ? { sex: String(meta.sex) } : {}),
        ...(meta.age !== undefined ? { age: Number(meta.age) } : {}),
      });
      if (meta.groupId && /^\d+$/.test(String(meta.groupId))) {
        const gKey = `${meta.groupId}:${uinStr}`;
        const prevG = this.groupMemberMeta.get(gKey) || {};
        this.groupMemberMeta.set(gKey, {
          ...prevG,
          group_id: Number(meta.groupId),
          user_id: Number(uinStr),
          uid: validUid ? uidStr : prevG.uid || "",
          nickname: String(meta.nickname ?? prevG.nickname ?? ""),
          card: String(meta.card ?? prevG.card ?? ""),
          role: String(meta.role ?? prevG.role ?? ""),
          title: String(meta.title ?? prevG.title ?? ""),
        });
      }
    }
  }

  rememberFromNtMsg(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    if (ntMsg.senderUin && ntMsg.senderUid) {
      this.remember(ntMsg.senderUin, ntMsg.senderUid, {
        nickname: ntMsg.sendNickName || "",
        card: ntMsg.sendMemberName || "",
        groupId: ntMsg.chatType === 2 ? ntMsg.peerUid || ntMsg.peerUin : undefined,
      });
    }
    if ((ntMsg.chatType === 1 || ntMsg.chatType === 100) && ntMsg.peerUin && ntMsg.peerUid) {
      this.remember(ntMsg.peerUin, ntMsg.peerUid, {
        nickname: ntMsg.peerName || "",
      });
    }
    if (Array.isArray(ntMsg.elements)) {
      for (const el of ntMsg.elements) {
        if (el?.textElement && el.textElement.atType === 2) {
          const atUin = el.textElement.atUid;
          const atUid = el.textElement.atNtUid;
          if (atUin && atUid) {
            this.remember(atUin, atUid);
          }
        }
        if (el?.replyElement) {
          const rUin = el.replyElement.senderUid;
          const rUid = el.replyElement.senderUidStr;
          if (rUin && rUid) {
            this.remember(rUin, rUid);
          }
        }
      }
    }
  }

  rememberFromBuddyList(buddyData) {
    if (!buddyData) return;
    const simpleInfos = buddyData.userSimpleInfos;
    if (simpleInfos instanceof Map) {
      for (const [uidKey, info] of simpleInfos.entries()) {
        const core = info?.coreInfo || info?.baseInfo || info || {};
        this.remember(core.uin || info?.uin, core.uid || info?.uid || uidKey, {
          nickname: core.nick || info?.nick || "",
          remark: core.remark || info?.remark || "",
        });
      }
    } else if (simpleInfos && typeof simpleInfos === "object") {
      for (const [uidKey, info] of Object.entries(simpleInfos)) {
        const core = info?.coreInfo || info?.baseInfo || info || {};
        this.remember(core.uin || info?.uin, core.uid || info?.uid || uidKey, {
          nickname: core.nick || info?.nick || "",
          remark: core.remark || info?.remark || "",
        });
      }
    }
    const list = Array.isArray(buddyData) ? buddyData : buddyData.buddyCategory || buddyData.data || [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item.buddyList)) {
        for (const buddy of item.buddyList) {
          this._rememberBuddyObject(buddy);
        }
      } else if (!Array.isArray(item.buddyUids)) {
        this._rememberBuddyObject(item);
      }
    }
  }

  _rememberBuddyObject(buddy) {
    if (!buddy || typeof buddy !== "object") return;
    const core = buddy.coreInfo || buddy.baseInfo || buddy;
    const uin = buddy.uin || core.uin;
    const uid = buddy.uid || core.uid;
    const nickname = buddy.nick || core.nick || buddy.nickname || "";
    const remark = buddy.remark || core.remark || "";
    this.remember(uin, uid, { nickname, remark });
  }

  rememberFromGroupMemberList(groupId, membersContainer) {
    if (!membersContainer) return;
    let infos = membersContainer;
    if (membersContainer.result && membersContainer.result.infos) {
      infos = membersContainer.result.infos;
    } else if (membersContainer.infos) {
      infos = membersContainer.infos;
    }
    const iter =
      infos instanceof Map
        ? infos.values()
        : Array.isArray(infos)
        ? infos
        : typeof infos === "object"
        ? Object.values(infos)
        : [];
    for (const m of iter) {
      if (!m || typeof m !== "object") continue;
      const uin = m.uin ?? m.user_id;
      const uid = m.uid ?? "";
      const roleNum = m.role ?? m.permission;
      const role =
        typeof roleNum === "string"
          ? roleNum
          : roleNum === 4 || roleNum === 1
          ? "owner"
          : roleNum === 3 || roleNum === 2
          ? "admin"
          : "member";
      this.remember(uin, uid, {
        groupId,
        nickname: m.nick ?? m.nickname ?? m.memberName ?? "",
        card: m.cardName ?? m.card ?? m.memberCard?.memberCard ?? "",
        role,
        title: m.memberSpecialTitle ?? m.specialTitle ?? m.title ?? "",
      });
    }
  }

  getUid(uin) {
    return this.getUidSync(uin);
  }

  getUin(uid) {
    return this.getUinSync(uid);
  }

  getUidSync(uin) {
    if (uin === undefined || uin === null) return "";
    const str = String(uin).trim();
    if (!str || str === "0") return "";
    if (str.startsWith("u_")) return str;
    return this.uinToUid.get(str) || "";
  }

  getUinSync(uid) {
    if (uid === undefined || uid === null) return "";
    const str = String(uid).trim();
    if (!str || str === "0") return "";
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    return this.uidToUin.get(str) || "";
  }

  async resolveUid(uin, invokeNt) {
    const str = String(uin ?? "").trim();
    if (!str || str === "0") return "";
    if (str.startsWith("u_")) return str;
    const cached = this.getUidSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function" && /^\d+$/.test(str) && Number(str) > 0) {
      const extractUid = (mapOrObj) => {
        if (mapOrObj instanceof Map) {
          return mapOrObj.get(str) || mapOrObj.get(Number(str)) || "";
        }
        if (mapOrObj && typeof mapOrObj === "object") {
          return mapOrObj[str] || "";
        }
        return "";
      };
      try {
        const res = await invokeNt(
          "nodeIKernelUixConvertService/getUid",
          { uins: [str] },
          [[str]]
        );
        const resolved = extractUid(res?.uidInfo || res);
        if (resolved && String(resolved).trim() !== "0") {
          this.remember(str, resolved);
          return String(resolved);
        }
      } catch (_) {}
      try {
        const res2 = await invokeNt(
          "nodeIKernelGroupService/getUidByUins",
          { uinList: [str] },
          [[str]]
        );
        const resolved2 = extractUid(res2?.uids || res2?.uidInfo || res2);
        if (resolved2 && String(resolved2).trim() !== "0") {
          this.remember(str, resolved2);
          return String(resolved2);
        }
      } catch (_) {}
    }
    return "";
  }

  async resolveUin(uid, invokeNt) {
    const str = String(uid ?? "").trim();
    if (!str || str === "0") return "";
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    const cached = this.getUinSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function") {
      const extractUin = (mapOrObj) => {
        if (mapOrObj instanceof Map) {
          return mapOrObj.get(str) || "";
        }
        if (mapOrObj && typeof mapOrObj === "object") {
          return mapOrObj[str] || "";
        }
        return "";
      };
      try {
        const res = await invokeNt(
          "nodeIKernelUixConvertService/getUin",
          { uids: [str] },
          [[str]]
        );
        const resolved = extractUin(res?.uinInfo || res);
        if (resolved && /^\d+$/.test(String(resolved)) && Number(resolved) > 0) {
          this.remember(String(resolved), str);
          return String(resolved);
        }
      } catch (_) {}
      try {
        const res2 = await invokeNt(
          "nodeIKernelGroupService/getUinByUids",
          { uidList: [str], uids: [str] },
          [[str]]
        );
        const resolved2 = extractUin(res2?.uins || res2?.uinInfo || res2);
        if (resolved2 && /^\d+$/.test(String(resolved2)) && Number(resolved2) > 0) {
          this.remember(String(resolved2), str);
          return String(resolved2);
        }
      } catch (_) {}
    }
    return "";
  }
}

function lookupCachedUin(uinUidStore, uid) {
  if (!uinUidStore || !uid) return 0;
  const uidStr = String(uid).trim();
  if (!uidStr || uidStr === "0") return 0;
  if (typeof uinUidStore.getUinSync === "function") {
    return uinUidStore.getUinSync(uidStr);
  }
  if (typeof uinUidStore.getUin === "function") {
    return uinUidStore.getUin(uidStr);
  }
  if (typeof uinUidStore.resolveUin === "function") {
    const r = uinUidStore.resolveUin(uidStr);
    if (r && typeof r.then !== "function") return r;
  }
  return 0;
}

function stripTransientNtMedia(ntMsg) {
  if (ntMsg && Array.isArray(ntMsg.elements)) {
    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      if (el.picElement && typeof el.picElement === "object") {
        try {
          delete el.picElement.__base64Uri;
        } catch (_) {
          el.picElement.__base64Uri = undefined;
        }
      }
      if (el.pttElement && typeof el.pttElement === "object") {
        try {
          delete el.pttElement.__base64Uri;
        } catch (_) {
          el.pttElement.__base64Uri = undefined;
        }
      }
    }
  }
  return ntMsg;
}

module.exports = {
  pickPositiveUin,
  lookupCachedUin,
  stripTransientNtMedia,
  MessageIdStore,
  UinUidStore,
};
