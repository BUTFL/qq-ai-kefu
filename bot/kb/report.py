"""问答日报：今天问了多少、哪些问得最多、哪些还等你定调。

**2026-09-29 起不定时推送了**（管理员：「问答日报不需要了 因为有了每日复盘」）。
只剩 `/日报` 指令手动查；「等你定调」挪进了 23:00 的复盘结果（review.render）。
`daily_loop` 留着没删，wiring.py 不再起它。

这份东西是整个闭环的关键一环——你晚上就是照着它给标准答案的，
所以每条待办都带上编号和客户原话，你能直接回一条 `/答 12 …` 就结掉。

**发到 REPORT_GROUP 指定的那个群，留空就不发。** 故意不默认取
ENABLED_GROUPS 的第一个：日报里有「答不上来 4 条」「命中率 66%」这种
内部数据，默认值一旦指到真实客户群，就是当着客户的面公布机器人的短板。

**2026-09-23 补的一刀**：上面那条守住了定时推送，却漏了 `/日报` 指令 ——
它以前是 `send_now(..., ev.group_id)`，发回打指令的那个群，从旁边绕过了
这道保险。而待办和高频是**跨群聚合**的，等于在 A 群能打出 B 群客户的原话。
现在群里打也发到 `REPORT_GROUP`，私聊打发回本人（`private=True`）。
同一个模块里防住过一次的东西，换个入口又漏了 —— 这比「没想到」更值得记。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from ..config import Settings
from ..onebot import ApiError, OneBotClient, text
from .store import HO_TAKEN, HandoffRow, KBStore, today

log = logging.getLogger(__name__)

# 断线时重试一次再放弃。日报不是紧急消息，不值得为它一直重试占着任务
_RETRY_AFTER = 60.0


def render(store: KBStore, day: str = "", *, handoffs: bool = True) -> str:
    """生成日报文本。返回空串 = 今天没什么可报的，不用发。

    `handoffs=False`（`HANDOFF_ENABLED=false`）时不列转人工会话：那时三条指令
    都回「没开」，列出来他也关不掉，每天白催一遍。
    """
    day = day or today()
    st = store.day_stats(day)
    pending = store.open_clusters(limit=6)
    # 开着的转人工会话。**读不出来也要说一声，不能当成「没有」**：
    # 这一行是他发现「还有人挂着」的兜底，它静默失效就等于客户消失了
    opened: list[HandoffRow] = []
    opened_err = False
    if handoffs:
        try:
            opened = store.handoffs_open()
        except Exception:
            log.warning("日报读转人工会话失败", exc_info=True)
            opened_err = True
    if not st.total and not st.chat and not st.blocked and not st.holding and not pending \
            and not opened and not opened_err:
        return ""

    head = datetime.strptime(day, "%Y-%m-%d").strftime("%-m 月 %-d 日")
    out = [f"📊 {head} 问答日报\n"]

    if st.total:
        line1 = (
            f"今天 {st.total} 问｜命中标准答案 {st.kb} ({st.kb_rate}%)"
            f"｜查资料 {st.rag}｜答不上来 {st.miss}"
        )
        if st.human:
            line1 += f"｜转人工 {st.human}"
        if st.notice:
            line1 += f"｜照口径答 {st.notice}"
        extra = []
        if st.chat:
            extra.append(f"寒暄 {st.chat}")
        if st.holding:
            extra.append(f"接管中安抚 {st.holding}")
        if extra:
            # 寒暄和接管中的安抚都不在 total 里，所以单独挂在后面，别让人以为这几个数加不起来
            line1 += f"（另有{'、'.join(extra)}）"
        out.append(line1)
        line = f"平均 {st.avg_ms / 1000:.1f} 秒"
        if st.rewrite_fellback:
            # 这个数字高说明重写老是改坏事实，要么是答案写得太紧，要么该关掉重写
            line += f"｜重写退回原文 {st.rewrite_fellback} 次"
        if st.error:
            line += f"｜出错 {st.error} 次"
        out.append(line)
    elif st.chat:
        out.append(f"今天只有寒暄 {st.chat} 条，没人问问题。")
    elif st.holding:
        out.append(f"今天没有新问题，只有人工接管期间回的「稍等」{st.holding} 条。")
    elif st.blocked:
        # 今天一条正经问题都没有、只有红线消息。别说成「只有寒暄 0 条」
        out.append("今天没人问问题。")
    else:
        out.append("今天没人提问。")

    if st.blocked:
        # **单独起一行，不跟统计挤在一起**：这行不是用来看运营数据的，
        # 是提醒你群里今天有人说了不该说的，可能要去看一眼
        out.append(f"\n⚠️ 挡掉不聊的话题 {st.blocked} 条（黄赌毒政）。原话没写在这里，要看查日志。")

    if opened:
        # **单独起一行、排在前面**：
        # 这一行是每天提醒他一次的地方
        names = "、".join(
            f"#{h.id} {_clip(h.nickname, 8)}（{'接管中' if h.state == HO_TAKEN else '等人工'}）" for h in opened[:8]
        )
        more = f" 等 {len(opened)} 个" if len(opened) > 8 else ""
        out.append(f"\n🙋 还开着 {len(opened)} 个会话：{names}{more}\n      /会话 看详情｜/结束 编号 交还给 AI")
    elif opened_err:
        out.append("\n⚠️ 转人工会话读不出来，看日志（不代表没有人在等）。")

    top = store.top_clusters(since=day, limit=5)
    if top:
        out.append("\n问得最多：")
        for i, (c, n) in enumerate(top, 1):
            mark = "✅" if c.answered else ("🔇" if c.resolved else "⚠️等你定")
            out.append(f" {i}. {_clip(c.label, 24)} — {n} 次 {mark}")

    if pending:
        out.append("\n等你定调（直接发「/答 编号 内容」）：")
        for c in pending:
            out.append(f" [{c.id}] {_clip(c.label, 26)}（问了 {c.asked} 次）")
            others = [q for q in store.cluster_questions(c.id, 3) if q != c.label]
            if others:
                out.append(f"      客户原话：{'｜'.join(_clip(q, 18) for q in others)}")

    out.append("\n全文：/复盘详情｜/答 编号 内容 定答案｜/加 一句大白话")
    return "\n".join(out)


def _clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _seconds_until(hhmm: str) -> float:
    """到下一个 HH:MM 还有多少秒。已经过了就算明天的。"""
    hh, mm = (int(x) for x in hhmm.split(":"))
    now = datetime.now()
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def send_now(
    client: OneBotClient, store: KBStore, target: int, *, private: bool = False, handoffs: bool = True
) -> bool:
    """立刻发一份今天的日报。给定时循环和 `/日报` 指令共用。

    `private=True` 时 `target` 是 QQ 号而不是群号。私聊这一路是为了
    「在客户群里打 `/日报` 不能把内部数据抖在客户面前」—— 定时那一路本来就
    只发 `REPORT_GROUP`，`/日报` 指令以前是发回当前群，从旁边绕过了那道保险。
    """
    body = render(store, handoffs=handoffs)
    if not body:
        log.info("今天没有问答也没有待办，不发日报")
        return False
    where = "私聊" if private else "群"

    async def post() -> None:
        if private:
            await client.send_private_msg(target, [text(body)])
        else:
            await client.send_group_msg(target, [text(body)])

    try:
        await post()
    except (ApiError, ConnectionError) as e:
        log.warning("日报发送失败，%.0f 秒后重试一次：%s", _RETRY_AFTER, e)
        await asyncio.sleep(_RETRY_AFTER)
        try:
            await post()
        except (ApiError, ConnectionError) as e2:
            log.error("日报重试也失败，今天这份跳过：%s", e2)
            return False
    log.info("日报已发到%s %s", where, target)
    return True


async def daily_loop(client: OneBotClient, store: KBStore, settings: Settings) -> None:
    """定时循环。没配 REPORT_GROUP 就直接不跑。"""
    if not settings.report_group:
        log.info("REPORT_GROUP 没配，不发日报（群里发 /日报 仍可随时查）")
        return
    log.info("日报已排程：每天 %s 发到群 %s", settings.report_at, settings.report_group)
    while True:
        await asyncio.sleep(_seconds_until(settings.report_at))
        try:
            await send_now(client, store, settings.report_group, handoffs=settings.handoff_enabled)
        except Exception:
            # 这个循环要活到进程结束，任何意外都不能让它退出——
            # 退出了就再也没有日报，而且很难发现
            log.exception("发日报时出了意料外的错，明天继续")
        # 防同一分钟内重复触发：发完睡过这一分钟再去算下一次
        await asyncio.sleep(61)
