"""客户私聊机器人：回一句固定话，请他到群里问（2026-09-30 管理员选的）。

起因：09-30 15:16 有客户用临时会话私聊机器人，发了两张截图问「连上后回复空白」，机器人一声不吭，
他只好回群里说「看私信」。以前私聊是「先保持静默」（kb_admin.py 私聊那段写着），他这次选了
「只回一句固定话」，**不在私聊里答题**：答题、转人工、会话都在群里，私聊再开一套就是两本账。

规矩：
- 超管、自己人不回（他们私聊是来发指令的）；`/` 开头的不回（指令归 admin.py / kb_admin.py）
- 同一个人 COOLDOWN 内只回一次：他连发五条截图，不能回五遍
- 说了想不开的话（crisis.py）不回那句固定话：回一句关心的话 + 私聊超管，跟群里同一个处理
- 临时会话（sub_type=group，从群里点头像来的）带上 group_id 回，NapCat 才知道走哪个群的临时会话
"""
from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

from ..config import Settings
from ..crisis import CARE, HOTLINE
from ..crisis import hit as crisis_hit
from ..dispatcher import Dispatcher
from ..events import PrivateMessage
from ..onebot import ApiError, OneBotClient, text
# 远程协助流程（bot/remote/flow.py）。**只在流程里查状态，不 import 具体实现**：
# 那条流程没启用时 is_active 恒为 False，这里等于什么都不会发生
from ..remote import flow as remote_flow

log = logging.getLogger(__name__)

DM_TEXT = "私聊这边看不到消息哦，麻烦到群里 @我 或 @客服，会更快回复你～"
COOLDOWN = 6 * 3600


def register(
    dispatcher: Dispatcher, client: OneBotClient, settings: Settings, staff: Callable[[], Awaitable[frozenset[int]]],
) -> None:
    # {QQ: 上次回固定话的时间}。只在内存里，重启就清 —— 多回一句没坏处
    replied: dict[int, float] = {}

    async def send(ev: PrivateMessage, body: str) -> None:
        params: dict = {"user_id": ev.user_id, "message": [text(body)]}
        gid = ev.raw.get("group_id")
        if ev.sub_type == "group" and gid:
            params["group_id"] = int(gid)
        try:
            await client.call_api("send_private_msg", **params)
        except (ApiError, ConnectionError) as e:
            log.warning("私聊回 %s 失败：%s", ev.user_id, e)

    async def tell_admins(body: str) -> None:
        for uid in sorted(settings.super_admins):
            try:
                await client.send_private_msg(uid, [text(body)])
            except (ApiError, ConnectionError) as e:
                log.warning("私聊超管 %s 失败：%s", uid, e)

    @dispatcher.on("message.private")
    async def on_private(ev: PrivateMessage) -> None:
        if ev.user_id == ev.self_id or ev.user_id < 10000:
            return  # 自己、QQ 系统号
        body = ev.plain_text.strip()
        if body.startswith("/") or ev.user_id in settings.super_admins:
            return
        try:
            if ev.user_id in await staff():
                return
        except Exception:  # noqa: BLE001 —— 读不出自己人名单就当他是客户，多回一句没坏处
            log.warning("私聊：读自己人名单失败，当客户处理", exc_info=True)
        where = f"（从群 {ev.raw.get('group_id')} 来的临时会话）" if ev.sub_type == "group" else ""
        word = crisis_hit(body) if body else None
        if word is not None:
            log.warning("私聊里 %s(%s) 说了想不开的话（命中「%s」）：%.40s", ev.sender_name, ev.user_id, word, body)
            await send(ev, CARE)
            await tell_admins(
                f"⚠️ 有人私聊机器人说了想不开的话，你去看一眼\n客户：{ev.sender_name}（{ev.user_id}）{where}\n"
                f"原话：{body}\n（命中的词：{word}）\n\n"
                f"私聊里已经回了一句关心的话，带了心理援助热线 {HOTLINE}。"
                "**是不是真的只有你能判**，玩笑话也会触发这条。"
            )
            return
        # 远程协助流程里的客户：私聊归那条流程管（它要问「有没有向日葵」、收识别码）。
        # **放在危机判断之后** —— 说了想不开的话永远优先，不能被流程吞掉
        if remote_flow.is_active(ev.user_id):
            log.debug("私聊 %s(%s) 正在远程协助流程里，固定话不回", ev.sender_name, ev.user_id)
            return
        now = time.monotonic()
        if now - replied.get(ev.user_id, -COOLDOWN - 1) < COOLDOWN:
            log.info("私聊 %s(%s) 又发了一条，固定话已经回过，不再回", ev.sender_name, ev.user_id)
            return
        replied[ev.user_id] = now
        log.info("客户 %s(%s) 私聊机器人%s，回固定话请他到群里问：%.40s", ev.sender_name, ev.user_id, where, body or "[非文字]")
        await send(ev, DM_TEXT)
