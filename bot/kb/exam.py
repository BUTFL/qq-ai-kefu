"""夜间考试：拿你定过的标准答案当考卷，看机器人现在还答不答得对。

**为什么要考**：标准答案本身不会变，但会变的东西很多 —— 你换了模型、调了阈值、
资料重新导入了、别的答案加了别名把这条挤掉了。任何一样都能让「以前答得好好的」
悄悄变成答不上来或者答成别的，而白天没人会专门去问一遍。考试就是每晚替你问一遍。

**怎么考**：每条标准答案取它的问法（标准问法 + 别名），在**库的副本**上走一遍真的回答流程
（`Answerer.answer`，跟白天客户问的一模一样），看结果：

| 结果 | 算 | 说明 |
|---|---|---|
| 命中的就是这条答案 | ✅ 对 | |
| 转人工 / 答不上来 | 🟡 保守 | 没答错，只是没用上你定的答案。**不算错**（2026-09-28 定的：转人工比答错强） |
| 命中了别的答案 | ❌ 错 | 两条答案打架了，要么合并、要么改问法 |
| 查资料自己答了 | ⚠️ 没命中 | 你的答案没被用上，模型自己编了一套，值得看 |

**只用向量、不调对话模型**，除非查资料那一步本来就要调（「没命中」那一档）。
一晚上 11 条答案 × 最多 3 个问法，几十次向量调用，几乎不花钱。

**在副本上考**：回答会建问题类、给答案 +1 命中次数，在正式库上考就是往日报里灌假数据。
副本用 `KBStore.snapshot()` 拍（SQLite backup，不怕机器人正在写）。

**每晚换一批（2026-10-16）。** 管理员要的是「每天复习一下资料库」，但一晚上考不完：
走到「查资料自己答」那一档要调对话模型，额度用完就当夜收工。以前是**按 id 顺序**考的，
于是额度用完的时候，**排在后面的那批每一晚都轮不到** —— 天天复习的永远是开头那几条。
现在顺序每晚用日期当种子打乱一遍，几天下来整本都能轮到（`_order`）。
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import random
import shutil
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from .answer import Answerer
from .llm import LLM
from .store import SRC_ERROR, SRC_HUMAN, SRC_KB, SRC_MISS, SRC_RAG, KBStore

log = logging.getLogger(__name__)

# 每条答案最多考几个问法。别名很多的答案（#2 有 6 个）全考一遍不值当
PER_ENTRY = 3
# 每道题之间歇多久（秒）。中转站按「每分钟请求数」限流，09-29/30 两晚考试每秒连打
# 2~3 发 embedding，撞了几十次 429，被判成「调模型出错」的题等于没考。
# 278 题 × 0.5 秒 ≈ 2 分多钟，夜里不赶这点时间
PAUSE = 0.5


@dataclass
class ExamResult:
    total: int = 0
    ok: int = 0
    entries_total: int = 0  # 库里有几条标准答案
    entries_done: int = 0  # 今晚考到了几条（没考完时 < entries_total，明晚换一批接着考）
    entries_skipped: int = 0  # 一个问法都没轮到的条数
    safe: int = 0  # 转人工 / 答不上来
    wrong: list[tuple[int, str, int]] = field(default_factory=list)  # (答案 id, 问法, 命中的别的答案 id)
    drifted: list[tuple[int, str, float]] = field(default_factory=list)  # (答案 id, 问法, 查资料的分)
    errors: int = 0
    calls: int = 0

    @property
    def score(self) -> int:
        """对 + 保守，占多少。**保守算过关**：转人工比答错强"""
        return round((self.ok + self.safe) * 100 / self.total) if self.total else 100


async def run(store: KBStore, llm: LLM, settings: Settings, *, max_chat: int = 20) -> ExamResult:
    """在副本上考一遍。`max_chat` = 最多允许几次走到「查资料让模型答」（那一步要调对话模型）"""
    tmp = Path(tempfile.mkdtemp(prefix="exam-"))
    try:
        await asyncio.to_thread(store.snapshot, tmp / "qa.db")
        copy = KBStore(tmp / "qa.db")
        try:
            return await _run(copy, llm, settings, max_chat)
        finally:
            copy.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _order(entries: Sequence, night: str) -> list:
    """今晚考哪几条、按什么顺序。**每晚换一遍**（2026-10-16）。

    考不完是常态（见模块开头）：额度一用完 `_run` 就 return，而条目原来是按 id 顺序考的，
    排在后面的那批**每一晚都轮不到**，等于从来没复习过。用日期当随机种子打乱：
    同一晚重跑顺序一样（好复现），隔一晚换一批，几天下来整本就都轮到。
    """
    out = list(entries)
    random.Random(night or "0").shuffle(out)
    return out


async def _run(store: KBStore, llm: LLM, settings: Settings, max_chat: int, *, night: str = "") -> ExamResult:
    r = ExamResult()
    night = night or time.strftime("%Y-%m-%d")
    # 考的是「检索还找不找得到这条答案」，不是重写写得好不好：关掉重写，
    # 不然 KB_REWRITE 一开，每道题都多一次对话模型调用
    answerer = Answerer(store, llm, dataclasses.replace(settings, rewrite=False))
    entries = await asyncio.to_thread(store.entries)
    r.entries_total = len(entries)
    for entry in _order(entries, night):
        if r.calls >= max_chat:
            r.entries_skipped = r.entries_total - r.entries_done
            log.info(
                "考试：查资料作答已经 %d 次，今晚考了 %d/%d 条，剩下明晚换一批接着考",
                r.calls, r.entries_done, r.entries_total,
            )
            return r
        r.entries_done += 1
        for q in entry.phrasings[:PER_ENTRY]:
            if r.calls >= max_chat:
                r.entries_skipped = r.entries_total - r.entries_done
                log.info(
                    "考试：查资料作答已经 %d 次，今晚考了 %d/%d 条，剩下明晚换一批接着考",
                    r.calls, r.entries_done, r.entries_total,
                )
                return r
            if r.total:
                await asyncio.sleep(PAUSE)
            r.total += 1
            reply = await answerer.answer(q)
            if reply.source == SRC_KB and reply.entry_id == entry.id:
                r.ok += 1
            elif reply.source == SRC_KB:
                r.wrong.append((entry.id, q, reply.entry_id or 0))
            elif reply.source in (SRC_MISS, SRC_HUMAN):
                r.safe += 1
            elif reply.source == SRC_RAG:
                r.calls += 1
                r.drifted.append((entry.id, q, reply.score))
            elif reply.source == SRC_ERROR:
                r.errors += 1
            else:
                # 寒暄 / 自我介绍那一路（问法本身就是「你会什么」这种）：没答错，算保守
                r.safe += 1
    log.info("考试：%d 题，对 %d、保守 %d、错 %d、没命中 %d、出错 %d", r.total, r.ok, r.safe, len(r.wrong), len(r.drifted), r.errors)
    return r


def render(r: ExamResult) -> str:
    if not r.total:
        return ""
    head = f"\n🧪 考试：标准答案 {r.total} 个问法，答对 {r.ok}"
    if r.safe:
        head += f"、转人工 {r.safe}"
    head += f"（{r.score}% 过关）"
    out = [head]
    for eid, q, other in r.wrong[:4]:
        out.append(f" ❌ 问「{q[:24]}」命中了 #{other}，应该是 #{eid} —— 两条打架，合并或改问法")
    for eid, q, sc in r.drifted[:4]:
        out.append(f" ⚠️ 问「{q[:24]}」没命中 #{eid}（查资料自己答的，{sc:.2f}）—— 这个问法可能要加回别名")
    if r.entries_total and r.entries_done < r.entries_total:
        out.append(f" 📚 今晚考了 {r.entries_done}/{r.entries_total} 条（额度用完就收工，明晚换一批接着考）")
    if r.errors:
        out.append(f" 调模型出错 {r.errors} 次，这几题没考成")
    return "\n".join(out)
