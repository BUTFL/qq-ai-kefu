"""白天盯着群：有人问了没人理、有人急了、同一类问题突然扎堆，就私聊超管。**不在群里说话。**

2026-09-28 管理员批的计划第三批（主动发现问题）。三件事，都只看 group_msgs 和 qa_log，
**不调模型**（白天随时在跑，调模型就是随时在花钱）：

1. **没人理的问题**：客户发了一句像问题的话（有问号、或者「怎么/为什么/能不能…」），
   过了 UNANSWERED_MINUTES 分钟，群里没有自己人（超管、同事）说话、机器人也没答这个人
   → **先对标准答案，命中就引用他那条 @ 他答**（09-30 他选的「不 @ 不插话」放宽版，
   门槛比 @ 我时严，只发标准答案原文，见 handlers/qa.py 的 answer_unasked）；
   没命中才私聊一句「群 X 的 Y 问了 Z，还没人回」提醒人去看。
2. **客户急了**：同一个人 FRUSTRATED_WINDOW 分钟内连着发了 FRUSTRATED_COUNT 条以上，
   而且里面有「还是不行」「急」「人呢」这类词 → 私聊提醒。
3. **故障苗头**：SPIKE_WINDOW 分钟内 SPIKE_USERS 个以上**不同的**客户说了「报错 / 连不上 /
   用不了 / 503」这类词 → 私聊「是不是中转站出问题了」。**不发群公告**：要不要公告、
   怎么说，是他的决定。
4. **客户贴订单号**（2026-10-08 他要的：「客户贴了订单号不需要进别的群 你给我私发就可以」）：
   群里出现 `APPROVAL_ANSWER_PREFIX` 开头的订单号 → 私聊他一条。**群里不回、群成员不动**
   —— 他明确说了不让客户加别的群。机器人查不了订单（没有那个接口），所以这里只转述，
   不装作能查。10 天 12 次都在售后群，有人同一个订单号贴了四遍，之前一次都没人接。

每类提醒对同一个人 / 同一个群有冷却，不会一分钟一条。坏了只记日志，不影响答题。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any

from ..config import Settings
from .store import ROLE_CUSTOMER, ROLE_STAFF, KBStore

log = logging.getLogger(__name__)

CHECK_EVERY = 60.0
UNANSWERED_MINUTES = 10
FRUSTRATED_WINDOW = 10
FRUSTRATED_COUNT = 3
SPIKE_WINDOW = 30
SPIKE_USERS = 3
# 客户贴订单号：多久内的算新的。每分钟扫一次，5 分钟的窗是给重启和查询慢留的余量
ORDER_WINDOW = 5
# 「他是不是正在跟群里某个客户说话」往前看多久（分钟）。**比提醒窗口宽**：
# 客户之间你一句我一句能隔上半小时，而「没人回」的线是 10 分钟，所以取 60（2026-10-16）
TALK_WINDOW = 60
# 同一件事多久内不重复提醒
COOLDOWN = 60 * 60
# 「刚过线」的宽度：每分钟查一次，给 3 分钟余量，机器人重启、查询慢了也不漏
_SLACK = timedelta(minutes=3)

_QUESTION = re.compile(r"[?？]|怎么|为什么|为啥|咋|能不能|可以吗|能吗|吗$|如何|哪里|在哪|多久|是不是")
_URGENT = ("还是不行", "还是用不了", "还是报错", "急", "人呢", "有人吗", "没人", "回一下", "在吗", "投诉", "垃圾", "骗")
_OUTAGE = ("报错", "连不上", "用不了", "不能用", "挂了", "超时", "503", "502", "500", "429", "timeout", "error", "卡住", "没反应")
# 记群消息时 @ 写成「@昵称」或「@QQ号」（listen.flatten）。NapCat 给的 at 段多半只有 qq，所以大多是号码
_AT = re.compile(r"@(\d{5,12})")


def talking_to_customer(msgs: Sequence, i: int, m: Mapping[str, Any]) -> bool:
    """这条是不是**在回群里某个客户的话**（客户之间聊）→ 那不算「没人理的问题」。

    2026-10-16 真机：12:49 客户「@3999990003 用codex不好吗」，13:19 那个人回
    「？我不就是codex吗」—— 盯群把后面那句当成「问了 10 分钟还没人回」，私聊了超管。
    管理员：「这个不是问机器人的问题，这个是回复客户的，这个也需要判断，不用给我发消息」。

    认两种（都不看模型，纯看群消息）：
    ① 他**引用了**客户那条话（reply_to 指到客户身上）
    ② 前面（TALK_WINDOW 分钟内）**最近一条别人的话 @ 了他** —— 那是在回那个人
       （自己前面那几句不算：「怎么充值」+「月卡能用吗」这种同一件事分几条打很常见）
    """
    # 用 .get 取这两个字段：测试和别处可能只造了必要的列（真库里都有）
    before = [x for x in msgs[:i] if x["group_id"] == m["group_id"] and x["role"] != ROLE_STAFF]
    rid = m.get("reply_to") or 0
    if rid and any((x.get("message_id") or 0) == rid for x in before):
        return True
    cut = _ts(m["created_at"]) - timedelta(minutes=TALK_WINDOW)
    for x in reversed(before):
        if x["user_id"] == m["user_id"]:
            continue  # 自己前面那几句不算
        return _ts(x["created_at"]) >= cut and f"@{m['user_id']}" in x["body"]
    return False


def unanswered(
    msgs: Sequence, answered_users: set[tuple[int, int]], now: datetime, staff: frozenset[int] | set[int] = frozenset(),
) -> list:
    """[(群消息行)]：像问题、超过 UNANSWERED_MINUTES 分钟、之后群里没有自己人开口、机器人也没答这个人。
    `staff` = 超管 + 自己人的 QQ（判断「@的是不是自己人」用）"""
    out = []
    cut = now - timedelta(minutes=UNANSWERED_MINUTES)
    for i, m in enumerate(msgs):
        if m["role"] == ROLE_STAFF or m["at_me"] or not _QUESTION.search(m["body"]):
            continue
        t = _ts(m["created_at"])
        # 只看刚过线那一段：再老的就算没人理，提醒也晚了（而且上一轮已经提醒过）
        if not (cut - _SLACK < t <= cut):
            continue
        if (m["group_id"], m["user_id"]) in answered_users:
            continue
        # @的是别的客户：客户之间在聊（09-29「@3999990004 什么是首token时间？」），不是在等我们。
        # @的是自己人的照样提醒 —— 那正是在等同事回
        ats = {int(x) for x in _AT.findall(m["body"])}
        if ats and not ats & staff:
            continue
        # 他在回群里某个客户的话（前面有人 @ 他，或者他引用了客户那条）→ 客户之间聊，不是等我们
        if talking_to_customer(msgs, i, m):
            continue
        later = [x for x in msgs[i + 1:] if x["group_id"] == m["group_id"] and _ts(x["created_at"]) > t]
        if any(x["role"] == ROLE_STAFF for x in later):
            continue
        # 同一个人刚才那句已经提醒过了（09-29 13:28、13:30 同一句发了两遍，提醒了两次）
        if any(o["group_id"] == m["group_id"] and o["user_id"] == m["user_id"] for o in out):
            continue
        # 后面有别的客户接话了（@他、或者他自己又接着说了几句）也算有人理 —— 客户互相帮着答很常见
        if any(x["role"] != ROLE_STAFF and x["user_id"] != m["user_id"] and f"@{m['user_id']}" in x["body"] for x in later):
            continue
        out.append(m)
    return out


def frustrated(msgs: Sequence, now: datetime) -> list[tuple[int, int, str, list[str]]]:
    """[(群, QQ, 昵称, 最近几句)]：一个人最近 FRUSTRATED_WINDOW 分钟连发好几条且带急词"""
    since = now - timedelta(minutes=FRUSTRATED_WINDOW)
    by: dict[tuple[int, int], list] = {}
    for m in msgs:
        if m["role"] != ROLE_STAFF and _ts(m["created_at"]) >= since:
            by.setdefault((m["group_id"], m["user_id"]), []).append(m)
    out = []
    for (g, u), rows in by.items():
        if len(rows) >= FRUSTRATED_COUNT and any(w in r["body"] for r in rows for w in _URGENT):
            out.append((g, u, rows[-1]["nickname"], [r["body"][:40] for r in rows[-3:]]))
    return out


def spike(msgs: Sequence, now: datetime) -> list[tuple[int, list[str]]]:
    """[(群, 几句原话)]：最近 SPIKE_WINDOW 分钟 SPIKE_USERS 个以上不同客户说了故障词"""
    since = now - timedelta(minutes=SPIKE_WINDOW)
    by: dict[int, dict[int, str]] = {}
    for m in msgs:
        if m["role"] == ROLE_STAFF or _ts(m["created_at"]) < since:
            continue
        low = m["body"].lower()
        if any(w in low for w in _OUTAGE):
            by.setdefault(m["group_id"], {})[m["user_id"]] = m["body"][:40]
    return [(g, list(users.values())[:4]) for g, users in by.items() if len(users) >= SPIKE_USERS]


def order_re(prefix: str) -> re.Pattern[str] | None:
    """认订单号的正则。前缀就是入群答题那个（`APPROVAL_ANSWER_PREFIX`，默认 sub2），
    后面跟 8 位日期加随机串。大小写不敏感 —— 客户是从网页上复制的，大小写不该影响。

    前缀为空就返回 None（那种配置下没法认订单号，这一项整个不工作，不是报错）。
    """
    p = prefix.strip()
    if not p:
        return None
    return re.compile(rf"{re.escape(p)}[_-]?[A-Za-z0-9]{{8,}}", re.I)


def orders(msgs: Sequence, now: datetime, prefix: str) -> list[tuple]:
    """[(群消息行, 订单号)]：最近 ORDER_WINDOW 分钟里客户贴的订单号。

    **自己人贴的不算**：同事在群里念订单号是正常干活。一条消息里贴了好几个就每个都报
    —— 10-02 真有客户一次贴两个（「sub2_…fXG5JOzK；sub2_…eGSI6Ir9这两个订单」）。
    """
    pat = order_re(prefix)
    if pat is None:
        return []
    since = now - timedelta(minutes=ORDER_WINDOW)
    out: list[tuple] = []
    for m in msgs:
        if m["role"] == ROLE_STAFF or _ts(m["created_at"]) < since:
            continue
        for num in dict.fromkeys(pat.findall(m["body"])):
            out.append((m, num))
    return out


def _ts(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


class Watcher:
    def __init__(
        self, store: KBStore, settings: Settings, notify: Callable[[str], Awaitable[None]],
        answer: Callable[[Mapping[str, Any]], Awaitable[bool]] | None = None,
    ) -> None:
        self.store = store
        self.cfg = settings
        self.notify = notify
        # 没人回的问题先交给它试着答（命中标准答案才答，返回答了没有）。None = 只提醒
        self.answer = answer
        self._sent: dict[tuple, float] = {}
        # 试着答过的群消息 id：刚过线那一段每分钟都会再扫到它，没命中的别再算一遍向量
        self._tried: set[int] = set()

    def _fresh(self, key: tuple) -> bool:
        now = time.monotonic()
        if now - self._sent.get(key, -COOLDOWN - 1) < COOLDOWN:
            return False
        self._sent[key] = now
        return True

    async def _answered(self, m: Mapping[str, Any]) -> bool:
        """交给 self.answer 试一次。**出任何错都当没答**：照旧私聊提醒，不能因为这一步坏了连提醒都没了"""
        if self.answer is None or m["id"] in self._tried:
            return False
        if len(self._tried) > 5000:
            self._tried.clear()
        self._tried.add(m["id"])
        try:
            return await self.answer(m)
        except Exception:  # noqa: BLE001
            log.warning("没 @ 我的问题试着答出错，照旧提醒：%.40s", m["body"], exc_info=True)
            return False

    async def check(self, now: datetime | None = None) -> list[str]:
        now = now or datetime.now()
        # 取数窗口按最宽的那个来（TALK_WINDOW 60 分钟）：另外几个检查各自带自己的窗口
        start = (now - timedelta(
            minutes=max(SPIKE_WINDOW, UNANSWERED_MINUTES + 10, TALK_WINDOW)
        )).strftime("%Y-%m-%d %H:%M:%S")
        end = now.strftime("%Y-%m-%d %H:%M:%S")
        msgs = await asyncio.to_thread(self.store.group_msgs_between, start, end)
        # 按现在的自己人名单重新标：6099 刚加的同事，他回过客户就不算「没人回」（同 review._restaff）
        staff: frozenset[int] = self.cfg.super_admins | self.cfg.trusted
        try:
            staff = staff | await asyncio.to_thread(self.store.trusted_ids)
            msgs = [{**dict(m), "role": ROLE_STAFF if m["user_id"] in staff else ROLE_CUSTOMER} for m in msgs]
        except Exception:  # noqa: BLE001
            log.warning("盯群读自己人名单失败，按记消息时打的标算", exc_info=True)
        qa = await asyncio.to_thread(self.store.qa_rows_between, start, end)
        answered = {(r["group_id"], r["user_id"]) for r in qa}
        said: list[str] = []

        for m in unanswered(msgs, answered, now, staff):
            if await self._answered(m):
                continue
            if self._fresh(("q", m["group_id"], m["user_id"])):
                said.append(
                    f"🕐 群 {m['group_id']} 有人问了 {UNANSWERED_MINUTES} 分钟还没人回\n"
                    f"{m['nickname']}（{m['user_id']}）：{m['body'][:80]}\n\n"
                    "他没 @ 我，标准答案里也没有对得上的，所以我没答。要我答就引用他那条 @我，或者你直接回他。"
                )
        for g, u, nick, last in frustrated(msgs, now):
            if self._fresh(("f", g, u)):
                said.append(
                    f"😣 群 {g} 的 {nick}（{u}）好像急了，{FRUSTRATED_WINDOW} 分钟内连发了好几条：\n"
                    + "\n".join(f"｜{x}" for x in last)
                )
        for g, quotes in spike(msgs, now):
            if self._fresh(("s", g)):
                said.append(
                    f"⚠️ 群 {g} 最近 {SPIKE_WINDOW} 分钟有 {len(quotes)}+ 个客户在说报错 / 用不了，"
                    "是不是官方那边在波动？\n" + "\n".join(f"｜{x}" for x in quotes)
                    + "\n\n我没在群里说什么。要发公告你来定。"
                )
        # 客户贴订单号：**冷却按订单号算**，不按人。同一个订单号连贴三遍只报一次
        # （10-04 真有客户一分钟内贴了三遍），但他换一个订单号照样报
        for m, num in orders(msgs, now, self.cfg.approval_answer_prefix):
            if self._fresh(("o", m["group_id"], num)):
                said.append(
                    f"🧾 群 {m['group_id']} 的客户贴了订单号，在等人查\n"
                    f"{m['nickname']}（{m['user_id']}）：{m['body'][:80]}\n"
                    f"订单号：{num}\n\n我没在群里回他。"
                )
        for body in said:
            await self.notify(body)
        return said


async def loop(
    store: KBStore, settings: Settings, notify: Callable[[str], Awaitable[None]],
    answer: Callable[[Mapping[str, Any]], Awaitable[bool]] | None = None,
) -> None:
    if not settings.review_enabled:
        return
    w = Watcher(store, settings, notify, answer)
    log.info(
        "白天盯群已启动：%d 分钟没人回（命中标准答案就答，没命中私聊超管）、有人急了、同类报错扎堆、"
        "客户贴订单号（私聊，群里不回）", UNANSWERED_MINUTES,
    )
    while True:
        await asyncio.sleep(CHECK_EVERY)
        try:
            await w.check()
        except Exception:  # noqa: BLE001
            log.exception("盯群出错，下一分钟继续")
