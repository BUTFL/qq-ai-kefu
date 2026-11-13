"use strict";

/**
 * NTQQ Kernel Payload Anti-Corruption Layer (`src/core/nt_normalizer.js`)
 *
 * Normalizes multi-version Linux QQ NT (V1 / V2 / 3.2.x) kernel structures into
 * predictable internal representations while strictly rejecting placeholder UINs
 * (`0`, `"0"`, `""`, negative numbers, and non-digit strings).
 */

/**
 * @param {any} v
 * @returns {number} Positive integer UIN or `0` if invalid.
 */
function _toPositiveUinNumber(v) {
  if (
    v === null ||
    v === undefined ||
    typeof v === "boolean" ||
    typeof v === "object" ||
    typeof v === "function" ||
    typeof v === "symbol"
  ) {
    return 0;
  }
  if (typeof v === "bigint") {
    if (v <= 0n) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return 0;
    const t = Math.trunc(v);
    return t > 0 ? t : 0;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) return 0;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const t = Math.trunc(n);
    return t > 0 ? t : 0;
  }
  return 0;
}

/**
 * Returns `true` iff `v` represents a strictly positive integer QQ UIN
 * (rejects `0`, `"0"`, `""`, booleans, arrays, negative values, and non-digits).
 *
 * @param {any} v
 * @returns {boolean}
 */
function isPositiveUin(v) {
  return _toPositiveUinNumber(v) > 0;
}

/**
 * Picks the first strictly positive integer UIN from `candidates`, or `0` if none qualify.
 *
 * @param {...any} candidates
 * @returns {number}
 */
function pickPositiveUin(...candidates) {
  for (const c of candidates) {
    const n = _toPositiveUinNumber(c);
    if (n > 0) return n;
  }
  return 0;
}

function _pickNonEmptyString(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || typeof c === "object" || typeof c === "boolean") {
      continue;
    }
    const s = String(c);
    if (s !== "") return s;
  }
  return "";
}

function _pickTrimmedUid(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || typeof c === "object" || typeof c === "boolean") {
      continue;
    }
    const s = String(c).trim();
    if (s && s !== "0") return s;
  }
  return "";
}

function _pickPositiveIntOrZero(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "" || typeof c === "boolean") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      return Math.trunc(n);
    }
  }
  return 0;
}

function _normalizeSex(sexVal) {
  if (typeof sexVal === "string") {
    const lower = sexVal.trim().toLowerCase();
    if (lower === "male" || lower === "1") return "male";
    if (lower === "female" || lower === "2") return "female";
    if (lower === "unknown") return "unknown";
  }
  const n = Number(sexVal);
  if (n === 1) return "male";
  if (n === 2) return "female";
  return "unknown";
}

function _pickSex(...candidates) {
  for (const c of candidates) {
    const norm = _normalizeSex(c);
    if (norm !== "unknown") return norm;
  }
  return "unknown";
}

/**
 * Normalizes direct `{ chatType, peerUid, guildId }` or nested `{ peer: { ... } }`
 * structures into a canonical `NormalizedPeer`.
 *
 * @param {any} raw
 * @param {number} [defaultChatType=1]
 * @returns {import("../types").NormalizedPeer}
 */
function normalizePeer(raw, defaultChatType = 1) {
  const fallbackType =
    Number.isFinite(Number(defaultChatType)) && Number(defaultChatType) > 0
      ? Math.trunc(Number(defaultChatType))
      : 1;

  if (typeof raw === "string" || typeof raw === "number") {
    const peerUid = String(raw).trim();
    return {
      chatType: fallbackType,
      peerUid,
      guildId: "",
      peerKey: peerUid ? `${fallbackType}:${peerUid}:` : "",
    };
  }

  const outer = raw && typeof raw === "object" ? raw : {};
  const inner = outer.peer && typeof outer.peer === "object" ? outer.peer : outer;

  const rawChatType = inner.chatType ?? outer.chatType;
  const parsedType = Number(rawChatType);
  const chatType =
    Number.isFinite(parsedType) && parsedType > 0 ? Math.trunc(parsedType) : fallbackType;

  const rawPeerUid = inner.peerUid ?? outer.peerUid ?? "";
  const peerUid =
    rawPeerUid !== null && rawPeerUid !== undefined ? String(rawPeerUid).trim() : "";

  const rawGuildId = inner.guildId ?? outer.guildId ?? "";
  const guildId =
    rawGuildId !== null && rawGuildId !== undefined ? String(rawGuildId).trim() : "";

  const peerKey = peerUid ? `${chatType}:${peerUid}:${guildId}` : "";

  return {
    chatType,
    peerUid,
    guildId,
    peerKey,
  };
}

/**
 * Normalizes NTQQ `GroupSimpleInfo` / `GroupAllInfo` / OneBot-cached group records.
 * Returns `null` if `g` is invalid or lacks a positive `groupId`.
 *
 * @param {any} g
 * @returns {import("../types").NormalizedGroupSummary | null}
 */
function normalizeGroupSummary(g) {
  if (!g || typeof g !== "object") return null;
  const info =
    (g.info && typeof g.info === "object" ? g.info : null) ||
    (g.groupInfo && typeof g.groupInfo === "object" ? g.groupInfo : null) ||
    (g.detail && typeof g.detail === "object" ? g.detail : null) ||
    {};

  const groupId = pickPositiveUin(
    g.groupCode,
    g.groupUin,
    g.group_id,
    info.groupCode,
    info.groupUin,
    info.group_id
  );
  if (!(groupId > 0)) return null;

  const groupName = _pickNonEmptyString(
    g.groupName,
    g.group_name,
    info.groupName,
    info.group_name
  );

  const memberCount = _pickPositiveIntOrZero(
    g.memberCount,
    g.member_count,
    info.memberCount,
    info.member_count
  );

  const maxMemberCount = _pickPositiveIntOrZero(
    g.maxMember,
    g.maxMemberCount,
    g.max_member_count,
    info.memberMax,
    info.maxMember,
    info.maxMemberCount,
    info.max_member_count
  );

  const groupRemark = _pickNonEmptyString(
    g.remarkName,
    g.groupRemark,
    g.group_remark,
    g.group_memo,
    info.remarkName,
    info.groupRemark
  );

  const ownerUid = _pickTrimmedUid(g.ownerUid, g.owner_uid, info.ownerUid, info.owner_uid);

  const rawRole = g.memberRole ?? g.cmdUinPrivilege ?? info.memberRole ?? info.cmdUinPrivilege ?? 0;
  const parsedRole = Number(rawRole);
  const memberRole = Number.isFinite(parsedRole) ? Math.trunc(parsedRole) : 0;

  return {
    groupId,
    groupIdStr: String(groupId),
    groupName,
    memberCount,
    maxMemberCount,
    groupRemark,
    ownerUid,
    memberRole,
    raw: g,
  };
}

/**
 * Normalizes buddy/user profile structures across NTQQ V1, V2, `simpleInfo`,
 * `coreInfo`, and `baseInfo` containers.
 *
 * @param {any} raw
 * @param {string} [fallbackUid=""]
 * @returns {import("../types").NormalizedBuddyProfile}
 */
function normalizeBuddyProfile(raw, fallbackUid = "") {
  if (!raw || typeof raw !== "object") {
    return {
      uid: _pickTrimmedUid(fallbackUid),
      uin: 0,
      nickname: "",
      remark: "",
      sex: "unknown",
      age: 0,
      qid: "",
      longNick: "",
    };
  }

  const simple = raw.simpleInfo && typeof raw.simpleInfo === "object" ? raw.simpleInfo : null;
  const core =
    (simple?.coreInfo && typeof simple.coreInfo === "object" ? simple.coreInfo : null) ||
    (raw.coreInfo && typeof raw.coreInfo === "object" ? raw.coreInfo : null) ||
    {};
  const base =
    (simple?.baseInfo && typeof simple.baseInfo === "object" ? simple.baseInfo : null) ||
    (raw.baseInfo && typeof raw.baseInfo === "object" ? raw.baseInfo : null) ||
    {};

  const uid = _pickTrimmedUid(core.uid, base.uid, simple?.uid, raw.uid, fallbackUid);
  const uin = pickPositiveUin(core.uin, base.uin, simple?.uin, raw.uin, raw.user_id);
  const nickname = _pickNonEmptyString(
    core.nick,
    base.nick,
    raw.nick,
    core.nickname,
    base.nickname,
    raw.nickname
  );
  const remark = _pickNonEmptyString(core.remark, base.remark, raw.remark);
  const sex = _pickSex(base.sex, core.sex, raw.sex);
  const age = _pickPositiveIntOrZero(base.age, core.age, raw.age);
  const qid = _pickNonEmptyString(base.qid, core.qid, raw.qid);
  const longNick = _pickNonEmptyString(
    base.longNick,
    core.longNick,
    raw.longNick,
    raw.personal_note
  );

  return {
    uid,
    uin,
    nickname,
    remark,
    sex,
    age,
    qid,
    longNick,
  };
}

/**
 * Normalizes an NTQQ `MemberInfo` record to match `group_actions.js` member
 * field conventions cleanly.
 *
 * @param {any} m
 * @param {number | string} [groupId=0]
 * @returns {import("../types").NormalizedGroupMember}
 */
function normalizeGroupMember(m, groupId = 0) {
  const resolvedGroupId = pickPositiveUin(groupId, m?.groupCode, m?.group_id);
  if (!m || typeof m !== "object") {
    return {
      group_id: resolvedGroupId,
      uid: "",
      uin: 0,
      nickname: "",
      card: "",
      sex: "unknown",
      age: 0,
      area: "",
      join_time: 0,
      last_sent_time: 0,
      level: "0",
      role: "member",
      roleNum: 0,
      unfriendly: false,
      title: "",
      title_expire_time: 0,
      card_changeable: true,
      shut_up_timestamp: 0,
    };
  }

  const uid = _pickTrimmedUid(m.uid);
  const uin = pickPositiveUin(m.uin, m.user_id);
  const nickname = _pickNonEmptyString(m.nick, m.nickname, m.memberName);
  const card = _pickNonEmptyString(
    m.cardName,
    m.card,
    m.memberCard && typeof m.memberCard === "object" ? m.memberCard.memberCard : ""
  );
  const sex = _pickSex(m.sex);
  const age = _pickPositiveIntOrZero(m.age);
  const area = _pickNonEmptyString(m.area);
  const join_time = _pickPositiveIntOrZero(m.joinTime, m.join_time, m.joinTimestamp);
  const last_sent_time = _pickPositiveIntOrZero(
    m.lastSpeakTime,
    m.last_sent_time,
    m.lastMsgTimestamp
  );

  const rawLevel =
    m.memberLevel ??
    m.memberRealLevel ??
    (m.level && typeof m.level === "object" ? m.level.level : m.level) ??
    0;
  const level = String(rawLevel ?? 0);

  const rawRole = m.role ?? m.permission;
  let role = "member";
  let roleNum = 0;
  if (typeof rawRole === "number" && Number.isFinite(rawRole)) {
    roleNum = Math.trunc(rawRole);
    role =
      roleNum === 4 || roleNum === 1
        ? "owner"
        : roleNum === 3 || roleNum === 2
        ? "admin"
        : "member";
  } else if (typeof rawRole === "string") {
    const trimmedRole = rawRole.trim();
    if (/^\d+$/.test(trimmedRole)) {
      roleNum = Math.trunc(Number(trimmedRole));
      role =
        roleNum === 4 || roleNum === 1
          ? "owner"
          : roleNum === 3 || roleNum === 2
          ? "admin"
          : "member";
    } else if (trimmedRole) {
      role = trimmedRole;
      const lowerRole = trimmedRole.toLowerCase();
      roleNum = lowerRole === "owner" ? 4 : lowerRole === "admin" ? 3 : 0;
    }
  }

  const unfriendly = Boolean(m.unfriendly ?? false);
  const title = _pickNonEmptyString(m.memberSpecialTitle, m.specialTitle, m.title);
  const rawTitleExpire = m.specialTitleExpireTime ?? m.title_expire_time ?? 0;
  const parsedTitleExpire = Number(rawTitleExpire);
  const title_expire_time = Number.isFinite(parsedTitleExpire) ? Math.trunc(parsedTitleExpire) : 0;
  const card_changeable = m.card_changeable !== undefined ? Boolean(m.card_changeable) : true;
  const shut_up_timestamp = _pickPositiveIntOrZero(m.shutUpTime, m.shut_up_timestamp);

  return {
    group_id: resolvedGroupId,
    uid,
    uin,
    nickname,
    card,
    sex,
    age,
    area,
    join_time,
    last_sent_time,
    level,
    role,
    roleNum,
    unfriendly,
    title,
    title_expire_time,
    card_changeable,
    shut_up_timestamp,
  };
}

/**
 * Extracts `{ uin, uid, nick }` from `onUserLoggedIn`, `onQRCodeLoginSucceed`,
 * `authInfo`, `LocalLoginInfoList` items, or `selfInfo` payloads.
 *
 * @param {any} firstArg
 * @returns {import("../types").NormalizedLoginIdentity}
 */
function normalizeLoginIdentity(firstArg) {
  if (firstArg === null || firstArg === undefined) {
    return { uin: "", uid: "", nick: "" };
  }
  if (typeof firstArg !== "object") {
    const posUin = pickPositiveUin(firstArg);
    return {
      uin: posUin > 0 ? String(posUin) : "",
      uid: "",
      nick: "",
    };
  }

  const inner =
    (firstArg.selfInfo && typeof firstArg.selfInfo === "object" ? firstArg.selfInfo : null) ||
    (firstArg.accountInfo && typeof firstArg.accountInfo === "object"
      ? firstArg.accountInfo
      : null) ||
    (firstArg.userInfo && typeof firstArg.userInfo === "object" ? firstArg.userInfo : null) ||
    {};

  const posUin = pickPositiveUin(
    firstArg.uin,
    firstArg.userId,
    firstArg.user_id,
    inner.uin,
    inner.userId,
    inner.user_id
  );
  const uid = _pickTrimmedUid(firstArg.uid, inner.uid);
  const rawNick = _pickNonEmptyString(
    firstArg.nickName,
    firstArg.nick,
    firstArg.nickname,
    inner.nickName,
    inner.nick,
    inner.nickname
  ).trim();

  return {
    uin: posUin > 0 ? String(posUin) : "",
    uid,
    nick: rawNick,
  };
}

module.exports = {
  isPositiveUin,
  pickPositiveUin,
  normalizePeer,
  normalizeGroupSummary,
  normalizeBuddyProfile,
  normalizeGroupMember,
  normalizeLoginIdentity,
};
