"""盯广告：群里有人打别家广告、拉人进群、留联系方式、刷屏，报给超管（开了开关才撤回）。

词表和模型判断在 `bot/ads.py`，那里写了为什么不能拿「cc」「gpt」当广告词。这里只管流程：

    群消息 → 自己人跳过 → 词表初筛（两组信号）→ 模型确认 → 私聊超管（+ 撤回）

**跟问答是两个独立的处理器**，不在答题那条路上（dispatcher 一个事件喂给所有匹配的处理器）。
这一层坏了不影响任何别的功能：出错只记一条日志，客户该答的照答。
也**不拦答题** —— 一条既是广告又 @ 了机器人的消息，两边各走各的，互不等待。

**试运行期（`AD_RECALL` 默认关）**：只私聊超管，群里的消息不动。他看准了再打开。

刷屏（`ads.SPAM`）跟别的不一样，**不问模型**：同一个人短时间内重复发一模一样的内容，
这件事词表和模型都判断不了，只能靠记住他刚才发过什么。只记在内存里，重启就清。
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from .. import ads
from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import GroupMessage
from ..kb.llm import LLM
from ..onebot import ApiError, OneBotClient, text
from .listen import flatten

log = logging.getLogger(__name__)

# 刷屏：同一个人在这么久之内，发了 REPEAT_TIMES 条一模一样的
REPEAT_WITHIN = 10 * 60
REPEAT_TIMES = 3
# 记多少人的上一条。满了就把最旧的挤掉，免得群大了一直涨
MAX_SEEN = 500
# 同一个人多久之内只报一次，免得一个广告号连发十条把超管私聊刷爆
NOTIFY_EVERY = 5 * 60


def register(
    dispatcher: Dispatcher, client: OneBotClient, settings: Settings, llm: LLM,
    staff: Callable[[], Awaitable[frozenset[int]]],
) -> None:
    # {(群, QQ): (上一条原文, 连着发了几次, 最后一次的时间)}
    seen: dict[tuple[int, int], tuple[str, int, float]] = {}
    # {(群, QQ): 上次报给超管的时间}
    notified: dict[tuple[int, int], float] = {}

    async def notify(body: str) -> None:
        for admin in sorted(settings.super_admins):
            try:
                await client.send_private_msg(admin, [text(body)])
            except (ApiError, ConnectionError) as e:
                log.warning("私聊超管 %s 报广告失败：%s", admin, e)

    async def recall(ev: GroupMessage) -> str:
        """撤回那条。撤不了返回原因 —— QQ 对撤别人的消息有时限，超了撤不动，这不是错误"""
        try:
            await client.call_api("delete_msg", message_id=ev.message_id)
        except (ApiError, ConnectionError) as e:
            log.warning("撤回群 %s 的消息 %s 失败：%s", ev.group_id, ev.message_id, e)
            return str(e)
        log.info("撤回了群 %s 里 %s(%s) 的消息", ev.group_id, ev.sender_name, ev.user_id)
        return ""

    def repeat(key: tuple[int, int], body: str, now: float) -> bool:
        """同一个人重复发同一条：到 REPEAT_TIMES 次算刷屏"""
        last, n, at = seen.get(key, ("", 0, 0.0))
        n = n + 1 if body == last and now - at <= REPEAT_WITHIN else 1
        if len(seen) >= MAX_SEEN and key not in seen:
            seen.pop(next(iter(seen)), None)
        seen[key] = (body, n, now)
        return n >= REPEAT_TIMES

    @dispatcher.on("message.group")
    async def on_group(ev: GroupMessage) -> None:
        if not settings.group_enabled(ev.group_id) or ev.user_id == ev.self_id:
            return
        body, _ = flatten(ev)
        # 指令归指令；自己人在群里说「加我微信」「我拉你进群」是正常工作，一律豁免
        if not body or body.startswith("/") or ev.user_id in await staff():
            return

        key = (ev.group_id, ev.user_id)
        now = time.monotonic()
        kind = ads.suspect(body)
        # 刷屏不问模型（词表判断不了「重复」这件事）；别的都要模型确认
        if repeat(key, body, now):
            kind = kind or ads.SPAM
        elif kind and not await ads.judge(llm, body):
            return
        if not kind:
            return

        recalled = ""
        if settings.ad_recall:
            recalled = await recall(ev)

        # 同一个人 NOTIFY_EVERY 内只报一次：广告号常连发十条。**撤回不受这个限制**，
        # 每条都撤 —— 少报几条私聊是省事，少撤一条广告就留在群里了
        if now - notified.get(key, -NOTIFY_EVERY - 1.0) < NOTIFY_EVERY:
            return
        notified[key] = now
        if len(notified) > MAX_SEEN:
            notified.pop(next(iter(notified)), None)

        if not settings.ad_recall:
            did = "群里那条我没动（试运行，只报给你看准不准）。\n打开自动撤回：.env 里 AD_RECALL=1 重启"
        elif recalled:
            did = f"想撤回但撤不掉：{recalled}\n（QQ 对撤别人的消息有时限，超了就撤不动）"
        else:
            did = "已经撤回了。"
        await notify(
            f"🧹 像是{kind}\n群：{ev.group_id}\n发的人：{ev.sender_name}（{ev.user_id}）\n"
            f"原话：{body}\n\n{did}\n\n认错了的话把这条原话发我，我去调词表。"
        )
