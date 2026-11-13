"use strict";

const {
  computeBkn,
  cookieObjToString,
  httpRequestText,
  parseJsonpOrJson,
} = require("../core/web_http");
const { isWebCredentialApiEnabled } = require("../core/qzone_actions");
const { createActionRouter, waitForEventOnce } = require("../core/primitives");
const {
  pickPositiveUin,
  normalizeGroupSummary,
  normalizeGroupMember,
} = require("../core/nt_normalizer");

const GROUP_LIST_WAIT_TIMEOUT_MS = 1200;

function hasMemberEntries(val) {
  if (!val) return false;
  if (val instanceof Map) return val.size > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "object") return Object.keys(val).length > 0;
  return false;
}

function extractMemberArray(infos) {
  if (infos instanceof Map) return Array.from(infos.values());
  if (Array.isArray(infos)) return infos;
  if (infos && typeof infos === "object") return Object.values(infos);
  return [];
}

function entriesFromMapOrObject(mapOrObj) {
  if (mapOrObj instanceof Map) return Array.from(mapOrObj.entries());
  if (mapOrObj && typeof mapOrObj === "object" && !Array.isArray(mapOrObj)) {
    return Object.entries(mapOrObj);
  }
  return [];
}

function formatOneBotGroupRecord(raw, fallbackGroupId = undefined) {
  const g = raw && typeof raw === "object" ? raw : {};
  const info =
    (g.info && typeof g.info === "object" ? g.info : null) ||
    (g.groupInfo && typeof g.groupInfo === "object" ? g.groupInfo : null) ||
    (g.detail && typeof g.detail === "object" ? g.detail : null) ||
    {};
  const directGid = pickPositiveUin(
    g.groupCode,
    g.groupUin,
    g.group_id,
    info.groupCode,
    info.groupUin,
    info.group_id
  );
  const summary = normalizeGroupSummary(
    directGid > 0 ? g : { ...g, groupCode: pickPositiveUin(fallbackGroupId) || 1 }
  );
  const gid =
    fallbackGroupId !== undefined
      ? Number(fallbackGroupId || 0)
      : directGid > 0 && summary
      ? summary.groupId
      : 0;
  const allShut =
    Number(g.shutUpAllTimestamp || info.shutUpAllTimestamp || 0) > 0 ||
    Boolean(g.isAllShut || g.shutUpAll || info.isAllShut || info.shutUpAll)
      ? -1
      : 0;
  const explicitRemark =
    g.remarkName ||
    g.groupRemark ||
    g.group_remark ||
    info.remarkName ||
    info.groupRemark ||
    info.group_remark ||
    "";
  return {
    group_id: gid,
    group_name: String(summary?.groupName || ""),
    group_remark: String(explicitRemark),
    member_count: Number(summary?.memberCount || 0),
    max_member_count: Number(summary?.maxMemberCount || 0),
    group_create_time: Number(g.createTime || info.createTime || info.createdTime || 0),
    group_level: Number(g.groupLevel || info.groupLevel || 0),
    group_memo: String(
      g.richFingerMemo ||
        g.groupMemo ||
        info.richFingerMemo ||
        info.groupMemo ||
        info.announcement ||
        ""
    ),
    group_all_shut: allShut,
  };
}

function toOneBotGroupMember(m, groupId, uinUidStore, fallbackUserId = undefined) {
  const norm = normalizeGroupMember(m, groupId);
  const resolvedUin =
    norm.uin ||
    pickPositiveUin(norm.uid && uinUidStore ? uinUidStore.getUinSync(norm.uid) : 0);
  const userId =
    resolvedUin > 0
      ? resolvedUin
      : fallbackUserId !== undefined
      ? Number(fallbackUserId || 0)
      : 0;
  return {
    group_id: groupId,
    user_id: userId,
    nickname: norm.nickname,
    card: norm.card,
    sex: norm.sex,
    age: norm.age,
    area: norm.area,
    join_time: norm.join_time,
    last_sent_time: norm.last_sent_time,
    level: norm.level,
    role: norm.role,
    unfriendly: norm.unfriendly,
    title: norm.title,
    title_expire_time: norm.title_expire_time,
    card_changeable: norm.card_changeable,
  };
}

async function fetchGroupSystemNotifies(bridge, doubt) {
  const res = await bridge.invokeNt(
    "nodeIKernelGroupService/getSingleScreenNotifies",
    { doubt, startSeq: "", number: 50 },
    [doubt, "", 50]
  );
  const notifies = Array.isArray(res?.notifies) ? res.notifies : [];
  const invited_requests = [];
  const join_requests = [];
  for (const item of notifies) {
    const seq = String(item.seq || "");
    const nType = Number(item.type || 1);
    const gid = pickPositiveUin(item.group?.groupCode);
    const flag = `${seq}:${nType}:${gid}`;
    bridge._setBoundedMap(bridge._groupNotifiesCache, flag, item);
    const entry = {
      request_id: Number(seq || 0),
      invitor_uin: pickPositiveUin(
        item.user2?.uin,
        bridge.uinUidStore.getUinSync(item.user2?.uid)
      ),
      invitor_nick: String(item.user2?.nickName || ""),
      group_id: gid,
      group_name: String(item.group?.groupName || ""),
      requester_uin: pickPositiveUin(
        item.user1?.uin,
        bridge.uinUidStore.getUinSync(item.user1?.uid)
      ),
      requester_nick: String(item.user1?.nickName || ""),
      message: String(item.postscript || ""),
      checked: Number(item.status) !== 1,
      actor: pickPositiveUin(
        item.actionUser?.uin,
        bridge.uinUidStore.getUinSync?.(item.actionUser?.uid)
      ),
      flag,
    };
    if (nType === 2) invited_requests.push(entry);
    else join_requests.push(entry);
  }
  return { invited_requests, join_requests };
}

async function updateGroupEssence(bridge, p, isAdd) {
  const entry =
    bridge.messageIdStore.resolveByOneBotId?.(p.message_id) ||
    bridge.messageIdStore.getByShortId(p.message_id) ||
    bridge.messageIdStore.getByMsgId(p.message_id);
  if (!entry) throw new Error("message not found");
  const cmd = isAdd
    ? "nodeIKernelGroupService/addGroupEssence"
    : "nodeIKernelGroupService/removeGroupEssence";
  await bridge.invokeNt(cmd, {
    param: {
      groupCode: String(entry.peer?.peerUid || entry.groupId || p.group_id || ""),
      msgRandom: Number(entry.rawMsg?.msgRandom ?? entry.msgRandom ?? 0),
      msgSeq: Number(entry.msgSeq || 0),
    },
  });
  return {};
}

const ACTION_HANDLERS = {
  async get_group_list(p) {
    const waitGroupEvent = waitForEventOnce(
      this._groupListWaiters,
      GROUP_LIST_WAIT_TIMEOUT_MS
    );

    const force = Boolean(p.no_cache);
    const res = await this.invokeNt(
      "nodeIKernelGroupService/getGroupList",
      { force },
      [force]
    );

    const hasDirectGroups =
      Array.isArray(res) || Array.isArray(res?.groupList) || Array.isArray(res?.groups);
    if (!hasDirectGroups && (force || this._groupListCache.size === 0)) {
      await waitGroupEvent;
    }

    const rawGroups = hasDirectGroups
      ? Array.isArray(res)
        ? res
        : res?.groupList || res?.groups || []
      : Array.from(this._groupListCache.values());

    return rawGroups.map((g) => {
      const formatted = formatOneBotGroupRecord(g);
      if (formatted.group_id > 0) {
        this._setBoundedMap(this._groupListCache, String(formatted.group_id), g);
      }
      return formatted;
    });
  },

  async get_group_info(p) {
    const groupId = Number(p.group_id || 0);
    try {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupAllInfo",
        { groupCode: String(groupId), source: 4 },
        [String(groupId), 4]
      );
      const probe =
        res && typeof res === "object"
          ? normalizeGroupSummary({
              ...res,
              groupCode: res.groupCode || pickPositiveUin(groupId) || 1,
            })
          : null;
      if (probe && (probe.groupName || probe.memberCount || probe.maxMemberCount)) {
        return formatOneBotGroupRecord(res, groupId);
      }
    } catch (_) {}
    const list = await this._dispatchAction("get_group_list", { no_cache: p.no_cache });
    return list.find((g) => g.group_id === groupId) || formatOneBotGroupRecord(null, groupId);
  },

  async get_group_share_link(p) {
    const groupCode = String(p.group_id || "").trim();
    if (!groupCode) throw new Error("group_id is required");
    try {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupRecommendContactArkJson",
        { groupCode },
        [groupCode]
      );
      const rawArk = String(
        res?.arkJson || res?.arkMsg || (typeof res === "string" ? res : "") || ""
      );
      if (rawArk) {
        try {
          const parsed = JSON.parse(rawArk);
          const jumpUrl =
            parsed?.meta?.contact?.jumpUrl ||
            parsed?.meta?.news?.jumpUrl ||
            parsed?.meta?.detail_1?.qqdocurl ||
            "";
          if (typeof jumpUrl === "string" && /^https?:\/\//i.test(jumpUrl)) {
            return { url: jumpUrl };
          }
        } catch (_) {
          const m = /https?:\/\/(?:qm\.qq\.com|qun\.qq\.com)\/[^\s"'\\]+/i.exec(rawArk);
          if (m) return { url: m[0] };
        }
      }
    } catch (_) {}
    return { url: `https://qun.qq.com/join.html?group_id=${encodeURIComponent(groupCode)}` };
  },

  async get_group_at_all_remain(p) {
    const groupCode = String(p.group_id || "").trim();
    if (!groupCode) throw new Error("group_id is required");
    try {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupRemainAtTimes",
        { groupCode },
        [groupCode]
      );
      const info = res?.atInfo || res || {};
      return {
        can_at_all: Boolean(info.canAtAll ?? true),
        remain_at_all_count_for_group: Number(
          info.RemainAtAllCountForGroup ?? info.remainAtAllCountForGroup ?? 10
        ),
        remain_at_all_count_for_uin: Number(
          info.RemainAtAllCountForUin ?? info.remainAtAllCountForUin ?? 10
        ),
      };
    } catch (_) {
      return {
        can_at_all: true,
        remain_at_all_count_for_group: 10,
        remain_at_all_count_for_uin: 10,
      };
    }
  },

  async get_group_shut_list(p) {
    const groupId = Number(p.group_id || 0);
    const groupCode = String(groupId);
    const nowSec = Math.floor(Date.now() / 1000);
    let rawMembers = [];
    try {
      const allRes = await this.invokeNt(
        "nodeIKernelGroupService/getAllMemberList",
        { groupCode, force_fetch: true, forceFetch: true },
        [groupCode, true]
      );
      rawMembers = extractMemberArray(allRes?.result?.infos || allRes?.infos || allRes);
    } catch (_) {}
    this.uinUidStore.rememberFromGroupMemberList(groupCode, rawMembers);
    const shutList = [];
    for (const m of rawMembers) {
      if (!m || typeof m !== "object") continue;
      const norm = normalizeGroupMember(m, groupId);
      if (norm.shut_up_timestamp > nowSec) {
        const uin =
          norm.uin ||
          pickPositiveUin(norm.uid ? this.uinUidStore.getUinSync(norm.uid) : 0);
        shutList.push({
          group_id: groupId,
          user_id: uin,
          uid: norm.uid,
          nickname: norm.nickname,
          card: norm.card,
          role: norm.role,
          shut_up_timestamp: norm.shut_up_timestamp,
        });
      }
    }
    return shutList;
  },

  async set_group_remark(p) {
    const groupCode = String(p.group_id || "").trim();
    if (!groupCode) throw new Error("group_id is required");
    const remarkName = String(p.remark ?? p.group_remark ?? "");
    await this.invokeNt(
      "nodeIKernelGroupService/modifyGroupRemark",
      { groupCode, remarkName },
      [groupCode, remarkName]
    );
    return {};
  },

  async get_group_member_list(p) {
    const groupId = Number(p.group_id || 0);
    const groupCode = String(groupId);
    const forceFetch = Boolean(p.no_cache);
    let infos = null;
    let sceneId = "";
    try {
      const sceneRes = await this.invokeNt(
        "nodeIKernelGroupService/createMemberListScene",
        { groupCode, scene: "groupMemberList_MainWindow" },
        [groupCode, "groupMemberList_MainWindow"]
      );
      sceneId = typeof sceneRes === "string" ? sceneRes : sceneRes?.sceneId || "";
      if (sceneId) {
        const listRes = await this.invokeNt(
          "nodeIKernelGroupService/getNextMemberList",
          { sceneId, lastId: undefined, prevId: undefined, num: 3000 },
          [sceneId, undefined, 3000]
        );
        infos = listRes?.result?.infos || listRes?.infos || listRes;
      }
    } catch (_) {
    } finally {
      if (sceneId) {
        this.invokeNt(
          "nodeIKernelGroupService/destroyMemberListScene",
          { sceneId },
          [sceneId]
        ).catch(() => {});
      }
    }
    if (!hasMemberEntries(infos) || forceFetch) {
      try {
        const allRes = await this.invokeNt(
          "nodeIKernelGroupService/getAllMemberList",
          { groupCode, force_fetch: forceFetch, forceFetch },
          [groupCode, forceFetch]
        );
        const allInfos = allRes?.result?.infos || allRes?.infos || allRes;
        if (hasMemberEntries(allInfos)) {
          infos = allInfos;
        }
      } catch (_) {}
    }
    this.uinUidStore.rememberFromGroupMemberList(groupCode, infos);
    const rawMembers = extractMemberArray(infos);
    const missingUids = rawMembers
      .filter((m) => m && !pickPositiveUin(m.uin, m.user_id) && m.uid)
      .map((m) => String(m.uid));
    if (missingUids.length > 0) {
      try {
        const uinRes = await this.invokeNt(
          "nodeIKernelUixConvertService/getUin",
          { uids: missingUids },
          [missingUids]
        );
        const pairs = entriesFromMapOrObject(uinRes?.uinInfo || uinRes);
        for (const [uid, rawUin] of pairs) {
          const uin = pickPositiveUin(rawUin);
          if (uin > 0) {
            this.uinUidStore.remember(String(uin), String(uid));
          }
        }
      } catch (_) {}
    }
    for (const m of rawMembers) {
      if (m && !pickPositiveUin(m.uin, m.user_id) && m.uid) {
        const resolvedUin = pickPositiveUin(this.uinUidStore.getUinSync(m.uid));
        if (resolvedUin > 0) {
          m.uin = String(resolvedUin);
        }
      }
    }
    this.uinUidStore.rememberFromGroupMemberList(groupCode, rawMembers);
    return rawMembers.map((m) => toOneBotGroupMember(m, groupId, this.uinUidStore));
  },

  async get_group_member_info(p) {
    const groupId = Number(p.group_id || 0);
    const userId = Number(p.user_id || 0);
    const gKey = `${groupId}:${userId}`;
    if (!p.no_cache && this.uinUidStore.groupMemberMeta.has(gKey)) {
      const cached = this.uinUidStore.groupMemberMeta.get(gKey);
      // Only short-circuit cache when `cached.role` has been authoritatively populated
      if (cached && cached.role) {
        return toOneBotGroupMember(cached, groupId, this.uinUidStore, userId);
      }
    }

    // Try single-member query via nodeIKernelGroupService/getMemberInfo first
    try {
      const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
      if (uid) {
        const forceFetch = Boolean(p.no_cache);
        const singleRes = await this.invokeNt(
          "nodeIKernelGroupService/getMemberInfo",
          {
            groupCode: String(groupId),
            uids: [uid],
            force_fetch: forceFetch,
            forceFetch,
          },
          [String(groupId), [uid], forceFetch]
        );
        const infos = singleRes?.result?.infos || singleRes?.infos;
        if (infos) {
          const positiveUserId = pickPositiveUin(userId);
          if (positiveUserId > 0) {
            for (const m of extractMemberArray(infos)) {
              if (m && m.uid === uid && !pickPositiveUin(m.uin, m.user_id)) {
                m.uin = String(positiveUserId);
              }
            }
          }
          this.uinUidStore.rememberFromGroupMemberList(String(groupId), infos);
          const refreshed = this.uinUidStore.groupMemberMeta.get(gKey);
          if (refreshed && refreshed.role) {
            return toOneBotGroupMember(refreshed, groupId, this.uinUidStore, userId);
          }
        }
      }
    } catch (_) {}

    const members = await this._dispatchAction("get_group_member_list", {
      group_id: groupId,
      no_cache: p.no_cache,
    });
    return (
      members.find((m) => Number(m.user_id) === userId) ||
      toOneBotGroupMember(null, groupId, this.uinUidStore, userId)
    );
  },

  async set_group_kick(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    await this.invokeNt(
      "nodeIKernelGroupService/kickMember",
      {
        groupCode: String(p.group_id),
        kickUids: [uid],
        refuseForever: Boolean(p.reject_add_request),
        kickReason: "",
      },
      [String(p.group_id), [uid], Boolean(p.reject_add_request), ""]
    );
    return {};
  },

  async set_group_ban(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const memList = [{ uid, timeStamp: Number(p.duration ?? 1800) }];
    await this.invokeNt(
      "nodeIKernelGroupService/banMember",
      { groupCode: String(p.group_id), memList },
      [String(p.group_id), memList]
    );
    return {};
  },

  async set_group_whole_ban(p) {
    const enable = Boolean(p.enable ?? true);
    const groupInfo = {
      groupCode: String(p.group_id),
      shutUpAllMember: enable ? 1 : 0,
    };
    await this.invokeNt(
      "nodeIKernelGroupService/modifyGroupExtInfo",
      { groupInfo },
      [groupInfo]
    );
    return {};
  },

  async set_group_admin(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const enable = Boolean(p.enable ?? true);
    const role = enable ? 3 : 2;
    await this.invokeNt(
      "nodeIKernelGroupService/modifyMemberRole",
      { groupCode: String(p.group_id), uid, role },
      [String(p.group_id), uid, role]
    );
    const gKey = `${Number(p.group_id || 0)}:${Number(p.user_id || 0)}`;
    if (this.uinUidStore.groupMemberMeta.has(gKey)) {
      const prev = this.uinUidStore.groupMemberMeta.get(gKey);
      this.uinUidStore.groupMemberMeta.set(gKey, {
        ...prev,
        role: enable ? "admin" : "member",
      });
    }
    return {};
  },

  async set_group_card(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const cardName = String(p.card ?? "");
    await this.invokeNt(
      "nodeIKernelGroupService/modifyMemberCardName",
      {
        groupCode: String(p.group_id),
        uid,
        cardName,
      },
      [String(p.group_id), uid, cardName]
    );
    return {};
  },

  async set_group_special_title(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const specialTitle = String(p.special_title ?? "");
    const expireTime = Number(p.duration ?? -1);
    try {
      await this.invokeNt(
        "nodeIKernelGroupService/setIdentityTitleInfo",
        {
          groupCode: String(p.group_id),
          uid,
          specialTitle,
          expireTime,
        },
        [String(p.group_id), uid, specialTitle, expireTime]
      );
    } catch (_) {
      await this.invokeNt("nodeIKernelGroupService/modifyMemberSpecialTitle", {
        groupCode: String(p.group_id),
        uid,
        specialTitle,
      });
    }
    return {};
  },

  async set_group_name(p) {
    const groupName = String(p.group_name ?? "");
    await this.invokeNt(
      "nodeIKernelGroupService/modifyGroupName",
      {
        groupCode: String(p.group_id),
        groupName,
        isConf: false,
      },
      [String(p.group_id), groupName, false]
    );
    return {};
  },

  async set_group_leave(p) {
    await this.invokeNt(
      "nodeIKernelGroupService/quitGroup",
      { groupCode: String(p.group_id) },
      [String(p.group_id)]
    );
    return {};
  },

  async set_group_add_request(p) {
    const flag = String(p.flag || "");
    const cached = this._groupNotifiesCache.get(flag);
    const parts = flag.split(":");
    const seq = cached?.seq || parts[0] || flag;
    const notifyType = Number(cached?.type || parts[1] || (p.sub_type === "invite" ? 2 : 1));
    const groupCode = String(cached?.group?.groupCode || parts[2] || p.group_id || "");
    const approve = Boolean(p.approve ?? true);
    await this.invokeNt("nodeIKernelGroupService/operateSysNotify", {
      doubt: false,
      operateMsg: {
        operateType: approve ? 1 : 2,
        targetMsg: {
          seq: String(seq),
          type: notifyType,
          groupCode,
          postscript: String(p.reason || ""),
        },
      },
    });
    return {};
  },

  async get_group_system_msg() {
    return await fetchGroupSystemNotifies(this, false);
  },

  async get_group_ignored_notifies() {
    const { invited_requests, join_requests } = await fetchGroupSystemNotifies(this, true);
    return [...invited_requests, ...join_requests];
  },

  async get_essence_msg_list(p) {
    const groupId = String(p.group_id || "");
    if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
      try {
        const cookies = await this._getCookiesObject("qun.qq.com");
        const bkn = computeBkn(cookies.p_skey || cookies.skey);
        const url = `https://qun.qq.com/cgi-bin/group_digest/digest_list?bkn=${bkn}&page_start=0&page_limit=50&group_code=${groupId}`;
        const text = await httpRequestText(url, "GET", "", {
          Cookie: cookieObjToString(cookies),
        });
        const parsed = parseJsonpOrJson(text);
        if (Array.isArray(parsed?.data?.msg_list)) {
          return parsed.data.msg_list;
        }
      } catch (_) {}
    }
    for (const essenceCmd of [
      "nodeIKernelGroupService/getGroupLatestEssenceList",
      "nodeIKernelGroupService/fetchGroupEssenceList",
      "nodeIKernelGroupService/getGroupEssenceList",
    ]) {
      try {
        const res = await this.invokeNt(essenceCmd, { groupCode: groupId }, [groupId]);
        if (res && (Array.isArray(res.msgList) || Array.isArray(res.list))) {
          return res.msgList || res.list;
        }
        if (res !== undefined) return res?.msgList || [];
      } catch (_) {}
    }
    return [];
  },

  async set_essence_msg(p) {
    return await updateGroupEssence(this, p, true);
  },

  async delete_essence_msg(p) {
    return await updateGroupEssence(this, p, false);
  },

  async _send_group_notice(p) {
    const groupCode = String(p.group_id || "");
    const content = String(p.content || "");
    if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
      try {
        const cookies = await this._getCookiesObject("qun.qq.com");
        if (cookies.skey || cookies.p_skey) {
          const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
          const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
          const body = new URLSearchParams({
            qid: groupCode,
            bkn: String(bodyBkn),
            text: content,
            pinned: String(p.pinned ?? 0),
            type: String(p.type ?? 1),
            settings: JSON.stringify({
              is_show_edit_card: 1,
              tip_window_type: 1,
              confirm_required: Number(p.confirm_required ?? 1),
            }),
          }).toString();
          const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${urlBkn}`;
          const text = await httpRequestText(url, "POST", body, {
            Cookie: cookieObjToString(cookies),
            "Content-Type": "application/x-www-form-urlencoded",
          });
          const json = parseJsonpOrJson(text);
          if (json && json.ec === 0) return {};
        }
      } catch (_) {}
    }
    await this.invokeNt("nodeIKernelGroupService/publishGroupBulletin", {
      groupCode,
      pskey: "",
      data: {
        text: content,
        pinned: Number(p.pinned ?? 0),
        isShowEditCard: 1,
        tipWindowType: 1,
        confirmRequired: Number(p.confirm_required ?? 1),
      },
    });
    return {};
  },

  async _get_group_notice(p) {
    const groupCode = String(p.group_id || "");
    try {
      const res = await this.invokeNt("nodeIKernelGroupService/getGroupBulletin", {
        groupCode,
      });
      if (Array.isArray(res?.feeds)) {
        return res.feeds;
      }
    } catch (_) {}
    if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
      try {
        const cookies = await this._getCookiesObject("qun.qq.com");
        if (cookies.skey || cookies.p_skey) {
          const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
          const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
          const body = new URLSearchParams({
            qid: groupCode,
            bkn: String(bodyBkn),
            ft: "23",
            s: "-1",
            n: "20",
            i: "1",
            ni: "1",
          }).toString();
          const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;
          const text = await httpRequestText(url, "POST", body, {
            Cookie: cookieObjToString(cookies),
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148",
          });
          const ret = parseJsonpOrJson(text);
          if (ret && Array.isArray(ret.feeds)) {
            return ret.feeds.map((f) => ({
              notice_id: String(f.fid || ""),
              sender_id: Number(f.u || 0),
              publish_time: Number(f.pubt || 0),
              message: {
                text: String(f.msg?.text || ""),
                images: (f.msg?.pics || []).map((pic) => ({
                  id: pic.id,
                  width: pic.w,
                  height: pic.h,
                })),
              },
            }));
          }
        }
      } catch (_) {}
    }
    return [];
  },

  async get_group_honor_info(p) {
    const groupId = Number(p.group_id || 0);
    return {
      group_id: groupId,
      current_talkative: null,
      talkative_list: [],
      performer_list: [],
      legend_list: [],
      strong_newbie_list: [],
      emotion_list: [],
    };
  },
};

const ACTION_ALIASES = {
  get_group_info_ex: "get_group_info",
  get_group_detail_info: "get_group_info",
  get_group_ignore_add_request: "get_group_ignored_notifies",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
