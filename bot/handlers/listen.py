"""把群里每一条消息记下来，给夜间复盘当原料（bot/kb/review.py）。**只记，不回话。**

2026-09-28 管理员定的：「存 1 天，复习完就删除」。所以这里只管写，
删在复盘那边（跑完就删，没跑成也删 36 小时前的）。

**记什么**：
- 不管 @ 没 @ 我都记 —— 客户之间互相问、人工在群里怎么答的，恰恰都不 @ 我
- 只记文字。图片、表情记成「[图片]」「[表情]」占个位，复盘看得出「这里有人发了张截图」
- 引用回复的那条 message_id 留着：理清「谁在回谁」靠它最准
- 谁是自己人：SUPER_ADMINS + `.env` 的 TRUSTED + 库里的 `trusted` 表（6099「自己人」页加）。
  **只有自己人说的话能当答案来源**，客户互相回答的只用来发现问题（客户也会说错）。
  名单每 30 秒从库里重读一次，页面上加了人不用重启

**不记什么**：
- 不在白名单里的群（这个号还在别的陌生群里）
- 机器人自己发的（qa_log 里已经有它答了什么）
- `/` 开头的指令 —— 那是在跟机器人说话，不是群里的交流

这一层**坏了不影响任何别的功能**：写库出错只记一条日志。它跟问答是两个独立的
处理器（dispatcher 一个事件喂给所有匹配的处理器），不在问答那条路上。
"""
from __future__ import annotations

import asyncio
import logging
import time

from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import GroupMessage
from ..kb.store import ROLE_CUSTOMER, ROLE_STAFF, KBStore

log = logging.getLogger(__name__)

# 一条消息最多存这么多字。复盘看的是「问了什么、答了什么」，一篇长文没必要全留
MAX_BODY = 600

_PLACEHOLDER = {"image": "[图片]", "face": "[表情]", "mface": "[表情]", "record": "[语音]", "video": "[视频]", "file": "[文件]"}


def flatten(ev: GroupMessage) -> tuple[str, int]:
    """消息段拼成一段文字，返回 (文字, 引用回复的 message_id)。@ 别人记成「@昵称」没有昵称就「@QQ号」"""
    parts: list[str] = []
    reply_to = 0
    for seg in ev.message:
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            parts.append(d.get("text", ""))
        elif t == "reply":
            try:
                reply_to = int(d.get("id") or 0)
            except (TypeError, ValueError):
                reply_to = 0
        elif t == "at":
            if str(d.get("qq")) != str(ev.self_id):
                parts.append(f"@{d.get('name') or d.get('qq')} ")
        elif t in _PLACEHOLDER:
            parts.append(_PLACEHOLDER[t])
    body = " ".join("".join(parts).split())
    return body[:MAX_BODY], reply_to


# 名单多久重读一次。页面上加了人，最多这么久之后生效
_RELOAD = 30.0


def register(dispatcher: Dispatcher, settings: Settings, store: KBStore) -> None:
    cache = {"ids": frozenset(), "at": -_RELOAD}

    async def staff() -> frozenset[int]:
        now = time.monotonic()
        if now - cache["at"] >= _RELOAD:
            try:
                cache["ids"] = settings.trusted | await asyncio.to_thread(store.trusted_ids)
            except Exception:
                log.warning("读自己人名单失败，这次只认超管和 .env 里的", exc_info=True)
                cache["ids"] = settings.trusted
            cache["at"] = now
        return cache["ids"]

    @dispatcher.on("message.group")
    async def on_group(ev: GroupMessage) -> None:
        if not settings.group_enabled(ev.group_id) or ev.user_id == ev.self_id:
            return
        body, reply_to = flatten(ev)
        if not body or body.startswith("/"):
            return
        role = ROLE_STAFF if ev.user_id in await staff() else ROLE_CUSTOMER
        try:
            await asyncio.to_thread(
                store.add_group_msg,
                group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name, role=role,
                message_id=ev.message_id, reply_to=reply_to, at_me=ev.at_me, body=body,
            )
        except Exception:
            log.warning("记群消息失败（不影响回答）", exc_info=True)
