"use strict";

const { pickPositiveUin, lookupCachedUin } = require("./stores");
const { ntMsgToOneBotSegments } = require("./segment_converter");

function mapNtRoleToOneBot(roleVal) {
  if (roleVal === "owner" || roleVal === 4 || roleVal === 1) return "owner";
  if (roleVal === "admin" || roleVal === 3 || roleVal === 2) return "admin";
  return "member";
}

function parseGrayTipEvent(ntMsg, el, ctx = {}) {
  const gt = el.grayTipElement;
  if (!gt) return null;
  const selfId = pickPositiveUin(ctx.selfId);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const isGroup = Number(ntMsg.chatType) === 2;
  const groupId = isGroup ? pickPositiveUin(ntMsg.peerUid, ntMsg.peerUin) : 0;
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;
  const senderUin = pickPositiveUin(
    ntMsg.senderUin,
    ntMsg.senderUid ? lookupCachedUin(uinUidStore, ntMsg.senderUid) : 0
  );

  // 1. Revoke / recall
  if (gt.revokeElement) {
    const rev = gt.revokeElement;
    let hit = null;
    if (messageIdStore) {
      hit =
        messageIdStore.getByMsgId(ntMsg.msgId) ||
        (rev.origMsgId ? messageIdStore.getByMsgId(rev.origMsgId) : null) ||
        messageIdStore.getByPeerAndSeq(
          ntMsg.chatType,
          ntMsg.peerUid,
          rev.origMsgSeq || ntMsg.msgSeq
        );
    }
    const operatorId = pickPositiveUin(
      rev.operatorUin,
      rev.operatorUid ? lookupCachedUin(uinUidStore, rev.operatorUid) : 0,
      senderUin
    );
    const origSenderUin = pickPositiveUin(
      rev.origMsgSenderUin,
      rev.origMsgSenderUid ? lookupCachedUin(uinUidStore, rev.origMsgSenderUid) : 0,
      hit?.senderUin,
      hit?.senderUid ? lookupCachedUin(uinUidStore, hit.senderUid) : 0,
      operatorId
    );
    let shortId = hit ? hit.shortId : 0;
    if (!shortId && ntMsg.msgId) {
      shortId = messageIdStore
        ? messageIdStore.register(ntMsg.msgId, { chatType: ntMsg.chatType, peerUid: ntMsg.peerUid }, ntMsg.msgSeq)
        : Number(String(ntMsg.msgId).slice(-9));
    }
    if (isGroup) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_recall",
        group_id: groupId,
        user_id: origSenderUin,
        operator_id: operatorId || origSenderUin,
        message_id: shortId,
      };
    }
    const peerUin = pickPositiveUin(
      ntMsg.peerUin,
      ntMsg.peerUid ? lookupCachedUin(uinUidStore, ntMsg.peerUid) : 0
    );
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "friend_recall",
      user_id: pickPositiveUin(origSenderUin, peerUin),
      message_id: shortId,
    };
  }

  // 2. XML / JSON gray tip (poke, essence, etc.)
  const xmlContent = gt.xmlElement?.content || gt.jsonGrayTipElement?.jsonStr || "";
  const busiId = String(gt.xmlElement?.busiId || gt.jsonGrayTipElement?.busiId || "");
  const rawTempl =
    gt.xmlElement?.templParam ||
    gt.jsonGrayTipElement?.xmlToJsonParam?.templParam ||
    null;
  const getTemplParam = (key) => {
    if (!rawTempl) return undefined;
    if (rawTempl instanceof Map) return rawTempl.get(key);
    if (typeof rawTempl === "object") return rawTempl[key];
    return undefined;
  };
  const isEssenceTip =
    busiId === "2401" || busiId === "2407" || xmlContent.includes("精华消息");
  const hasTemplActor =
    getTemplParam("uin_str1") !== undefined || getTemplParam("uid_str1") !== undefined;

  if (
    !isEssenceTip &&
    (busiId === "1061" ||
      xmlContent.includes("poke") ||
      xmlContent.includes("戳了戳") ||
      hasTemplActor)
  ) {
    let fromUin = pickPositiveUin(
      getTemplParam("uin_str1"),
      getTemplParam("uid_str1") ? lookupCachedUin(uinUidStore, getTemplParam("uid_str1")) : 0
    );
    let toUin = pickPositiveUin(
      getTemplParam("uin_str2"),
      getTemplParam("uid_str2") ? lookupCachedUin(uinUidStore, getTemplParam("uid_str2")) : 0
    );
    if (!fromUin || !toUin) {
      const uinMatches = [...xmlContent.matchAll(/(?:uin|qq|jp)="?(\d{5,12})"?/gi)]
        .map((m) => pickPositiveUin(m[1]))
        .filter((n) => n > 0);
      if (uinMatches.length >= 2) {
        if (!fromUin) fromUin = uinMatches[0];
        if (!toUin) toUin = uinMatches[1];
      } else if (uinMatches.length === 1) {
        if (!fromUin) fromUin = uinMatches[0];
        if (!toUin) toUin = selfId;
      }
    }
    if ((!fromUin || !toUin) && uinUidStore) {
      const uidMatches = [...xmlContent.matchAll(/(?:uid|jp|col_uid)="?(u_[A-Za-z0-9_-]+)"?/gi)]
        .map((m) => pickPositiveUin(lookupCachedUin(uinUidStore, m[1])))
        .filter((n) => n > 0);
      if (uidMatches.length >= 2) {
        if (!fromUin) fromUin = uidMatches[0];
        if (!toUin) toUin = uidMatches[1];
      } else if (uidMatches.length === 1) {
        if (!fromUin) fromUin = uidMatches[0];
      }
    }
    if (!fromUin) fromUin = senderUin;
    if (!toUin) toUin = selfId;
    if (fromUin > 0 && toUin > 0) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        user_id: fromUin,
        sender_id: fromUin,
        target_id: toUin,
        ...(isGroup && groupId ? { group_id: groupId } : {}),
        event_id: String(ntMsg.msgId || ntMsg.msgSeq || `${time}_${fromUin}_${toUin}`),
      };
    }
  }

  // Essence message grayTip (busiId 2401 / 2407)
  if (isEssenceTip && isGroup) {
    const actor1 = pickPositiveUin(
      getTemplParam("uin_str1"),
      getTemplParam("uid_str1") ? lookupCachedUin(uinUidStore, getTemplParam("uid_str1")) : 0
    );
    const actor2 = pickPositiveUin(
      getTemplParam("uin_str2"),
      getTemplParam("uid_str2") ? lookupCachedUin(uinUidStore, getTemplParam("uid_str2")) : 0
    );
    const essOperator = pickPositiveUin(actor1, senderUin);
    const essSender = pickPositiveUin(actor2, senderUin, essOperator);
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "essence",
      sub_type: xmlContent.includes("移出") ? "delete" : "add",
      group_id: groupId,
      sender_id: essSender,
      operator_id: essOperator,
      message_id: Number(ntMsg.msgSeq || 0),
    };
  }

  // 3. Group element (increase, decrease, ban, admin)
  if (gt.groupElement && isGroup) {
    const ge = gt.groupElement;
    const gType = Number(ge.type || 0);
    const memberUin = pickPositiveUin(
      ge.memberUin,
      ge.memberUid ? lookupCachedUin(uinUidStore, ge.memberUid) : 0
    );
    const adminUin = pickPositiveUin(
      ge.adminUin,
      ge.adminUid ? lookupCachedUin(uinUidStore, ge.adminUid) : 0
    );
    if (gType === 1) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_increase",
        sub_type: adminUin ? "invite" : "approve",
        group_id: groupId,
        operator_id: adminUin || memberUin,
        user_id: memberUin,
      };
    }
    if (gType === 2 || gType === 3) {
      const subType =
        gType === 3
          ? selfId > 0 && memberUin > 0 && memberUin === selfId
            ? "kick_me"
            : "kick"
          : "leave";
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_decrease",
        sub_type: subType,
        group_id: groupId,
        operator_id: adminUin || memberUin,
        user_id: memberUin,
      };
    }
    if (gType === 4 || gType === 8) {
      const shutUp = ge.shutUp;
      const duration = Number(shutUp?.duration ?? (gType === 8 ? 0 : 1800));
      const shutMemberUid = String(shutUp?.member?.uid || "").trim();
      const targetUin = pickPositiveUin(
        shutUp?.member?.uin,
        shutMemberUid && shutMemberUid !== "0"
          ? lookupCachedUin(uinUidStore, shutMemberUid)
          : 0,
        !shutUp?.member || shutMemberUid ? memberUin : 0
      );
      const shutAdminUid = String(shutUp?.admin?.uid || "").trim();
      const opUin = pickPositiveUin(
        shutUp?.admin?.uin,
        shutAdminUid && shutAdminUid !== "0"
          ? lookupCachedUin(uinUidStore, shutAdminUid)
          : 0,
        adminUin
      );
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_ban",
        sub_type: duration > 0 ? "ban" : "lift_ban",
        group_id: groupId,
        operator_id: opUin,
        user_id: targetUin,
        duration,
      };
    }
    if (gType === 5) {
      const adminTargetUin = pickPositiveUin(
        memberUin,
        ge.adminNotify?.uin,
        ge.adminNotify?.uid ? lookupCachedUin(uinUidStore, ge.adminNotify.uid) : 0
      );
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_admin",
        sub_type: ge.isAdmin === false ? "unset" : "set",
        group_id: groupId,
        user_id: adminTargetUin,
      };
    }
  }

  // 4. New friend added gray tip
  if (
    !isGroup &&
    (xmlContent.includes("你们已经成为好友") ||
      xmlContent.includes("已添加你为好友") ||
      gt.buddyElement)
  ) {
    const be = gt.buddyElement || {};
    const beUid = be.peerUid || be.friendUid || "";
    const uin = pickPositiveUin(
      ntMsg.peerUin,
      be.peerUin,
      be.friendUin,
      ntMsg.peerUid ? lookupCachedUin(uinUidStore, ntMsg.peerUid) : 0,
      beUid ? lookupCachedUin(uinUidStore, beUid) : 0,
      senderUin
    );
    if (uin > 0) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "friend_add",
        user_id: uin,
      };
    }
  }

  return null;
}

/**
 * Format an NTQQ `RawMessage` into a OneBot v11 Event (or array of events when a
 * group file message also emits a `group_upload` notice).
 */
function formatNtMsgToOneBotEvent(ntMsg, ctx = {}) {
  if (!ntMsg || typeof ntMsg !== "object") return null;
  const selfId = pickPositiveUin(ctx.selfId);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const chatType = Number(ntMsg.chatType || 1);
  const isGroup = chatType === 2;
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;

  if (uinUidStore) {
    uinUidStore.rememberFromNtMsg(ntMsg);
  }

  // Check if this message was recalled (onMsgInfoListUpdate with recallTime > 0)
  if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
    const revEl = Array.isArray(ntMsg.elements)
      ? ntMsg.elements.find((e) => e?.grayTipElement?.revokeElement)
      : null;
    if (revEl) {
      return parseGrayTipEvent(ntMsg, revEl, ctx);
    }
    const hit = messageIdStore
      ? messageIdStore.getByMsgId(ntMsg.msgId) ||
        messageIdStore.getByPeerAndSeq(chatType, ntMsg.peerUid, ntMsg.msgSeq)
      : null;
    const recalledSenderUin = pickPositiveUin(
      ntMsg.senderUin,
      hit?.senderUin,
      ntMsg.senderUid ? lookupCachedUin(uinUidStore, ntMsg.senderUid) : 0,
      hit?.senderUid ? lookupCachedUin(uinUidStore, hit.senderUid) : 0
    );
    const shortId = messageIdStore
      ? hit?.shortId ||
        messageIdStore.register(ntMsg.msgId, { chatType, peerUid: ntMsg.peerUid }, ntMsg.msgSeq)
      : Number(String(ntMsg.msgId || 1).slice(-9));
    if (isGroup) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_recall",
        group_id: pickPositiveUin(ntMsg.peerUid, ntMsg.peerUin),
        user_id: recalledSenderUin,
        operator_id: recalledSenderUin,
        message_id: shortId,
      };
    }
    const recalledPeerUin = pickPositiveUin(
      ntMsg.peerUin,
      ntMsg.peerUid ? lookupCachedUin(uinUidStore, ntMsg.peerUid) : 0
    );
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "friend_recall",
      user_id: pickPositiveUin(recalledSenderUin, recalledPeerUin),
      message_id: shortId,
    };
  }

  // Check if message is a system grayTip notice (msgType === 5 or only grayTipElement)
  if (Array.isArray(ntMsg.elements)) {
    for (const el of ntMsg.elements) {
      if (el?.elementType === 8 && el.grayTipElement) {
        const noticeEv = parseGrayTipEvent(ntMsg, el, ctx);
        if (noticeEv) return noticeEv;
      }
    }
  }

  const senderUinNum = pickPositiveUin(
    ntMsg.senderUin,
    ntMsg.senderUid ? lookupCachedUin(uinUidStore, ntMsg.senderUid) : 0
  );
  const senderUin = senderUinNum > 0 ? String(senderUinNum) : "";
  const groupIdNum = isGroup ? pickPositiveUin(ntMsg.peerUid, ntMsg.peerUin) : 0;
  const groupId = isGroup
    ? groupIdNum > 0
      ? String(groupIdNum)
      : String(ntMsg.peerUid || ntMsg.peerUin || "")
    : "";
  const peerUid = String(ntMsg.peerUid || (isGroup ? groupId : ntMsg.senderUid || ""));
  const peerUin = !isGroup
    ? pickPositiveUin(
        ntMsg.peerUin,
        ntMsg.peerUid ? lookupCachedUin(uinUidStore, ntMsg.peerUid) : 0
      )
    : 0;

  const { segments, raw_message } = ntMsgToOneBotSegments(ntMsg, ctx);
  if (segments.length === 0 && Number(ntMsg.msgType) === 5) {
    return null;
  }

  const isSelf = Boolean(selfId > 0 && senderUinNum === selfId);
  const senderRole = mapNtRoleToOneBot(
    ntMsg.roleType ??
      ntMsg.senderRole ??
      (isGroup && uinUidStore
        ? uinUidStore.groupMemberMeta.get(`${groupId}:${senderUin}`)?.role
        : "member")
  );

  const sender = isGroup
    ? {
        user_id: senderUinNum,
        nickname: String(ntMsg.sendNickName || ""),
        card: String(ntMsg.sendMemberName || ""),
        role: senderRole,
        title: String(ntMsg.sendMemberTitle || ""),
      }
    : {
        user_id: senderUinNum,
        nickname: String(ntMsg.sendNickName || ""),
        sex: "unknown",
        age: 0,
      };

  const shortId = messageIdStore
    ? messageIdStore.register(
        ntMsg.msgId,
        { chatType, peerUid, guildId: String(ntMsg.guildId || "") },
        ntMsg.msgSeq,
        {
          senderUin,
          senderUid: ntMsg.senderUid || "",
          groupId,
          msgTime: time,
          rawMsg: ntMsg,
        }
      )
    : Number(String(ntMsg.msgId || 1).slice(-9)) || 1;

  if (messageIdStore && typeof messageIdStore.indexMsgMedia === "function") {
    messageIdStore.indexMsgMedia(ntMsg, shortId);
  }

  const event = {
    time,
    self_id: selfId,
    post_type: isSelf && !ctx.reportSelfMessage ? "message_sent" : "message",
    message_type: isGroup ? "group" : "private",
    sub_type: isGroup ? "normal" : chatType === 100 ? "group" : "friend",
    message_id: shortId,
    user_id: senderUinNum,
    ...(isGroup
      ? { group_id: groupIdNum, anonymous: null }
      : peerUin > 0
      ? { target_id: peerUin }
      : {}),
    message:
      ctx.messageFormat === "string" || ctx.postMessageFormat === "string"
        ? raw_message
        : segments,
    raw_message,
    font: 0,
    sender,
  };

  return event;
}

function formatGroupUploadNotice(ntMsg, ctx = {}) {
  if (!ntMsg || Number(ntMsg.chatType) !== 2 || !Array.isArray(ntMsg.elements)) return null;
  const fileEl = ntMsg.elements.find((e) => e?.elementType === 3 && e.fileElement)?.fileElement;
  if (!fileEl) return null;
  const selfId = pickPositiveUin(ctx.selfId);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const uinUidStore = ctx.uinUidStore || null;
  const senderUin = pickPositiveUin(
    ntMsg.senderUin,
    ntMsg.senderUid ? lookupCachedUin(uinUidStore, ntMsg.senderUid) : 0
  );
  return {
    time,
    self_id: selfId,
    post_type: "notice",
    notice_type: "group_upload",
    group_id: pickPositiveUin(ntMsg.peerUid, ntMsg.peerUin),
    user_id: senderUin,
    file: {
      id: String(fileEl.fileUuid || fileEl.fileBizId || fileEl.fileMd5 || ""),
      name: String(fileEl.fileName || "file"),
      size: Number(fileEl.fileSize || 0),
      busid: Number(fileEl.fileBizId || 102),
    },
  };
}

function formatNoticeEvent(noticeType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  const base = {
    time,
    self_id: selfId,
    post_type: "notice",
    notice_type: noticeType,
  };
  return { ...base, ...payload, time, self_id: selfId, post_type: "notice", notice_type: noticeType };
}

function formatRequestEvent(requestType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  if (requestType === "friend") {
    return {
      time,
      self_id: selfId,
      post_type: "request",
      request_type: "friend",
      user_id: Number(payload.user_id || 0),
      comment: String(payload.comment || ""),
      flag: String(payload.flag || ""),
    };
  }
  return {
    time,
    self_id: selfId,
    post_type: "request",
    request_type: "group",
    sub_type: String(payload.sub_type || "add"),
    group_id: Number(payload.group_id || 0),
    user_id: Number(payload.user_id || 0),
    comment: String(payload.comment || ""),
    flag: String(payload.flag || ""),
  };
}

function formatMetaEvent(metaEventType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  if (metaEventType === "lifecycle") {
    return {
      time,
      self_id: selfId,
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: String(payload.sub_type || "connect"),
    };
  }
  return {
    time,
    self_id: selfId,
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    status: payload.status || { online: true, good: true },
    interval: Number(payload.interval || 5000),
  };
}

module.exports = {
  mapNtRoleToOneBot,
  parseGrayTipEvent,
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
};
