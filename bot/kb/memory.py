"""机器人自己学：管理员 / 同事在群里怎么回客户的，记下来，下次有人问同样的事就照着回（2026-10-15）。

管理员原话：「现在不需要 @机器人了让机器人所有都回答但是前提得命中，然后自动判断上下文思考是不是问题形式，
自主学习思考，不要长篇大论说重点」「也需要参考管理员回复客户怎么回复的自己学习记忆」。

三件事都在这儿：
1. **记**（capture）：自己人在群里说一句话，找出他在回谁的哪个问题（引用回复最准；没引用就取 3 分钟内
   最近一条客户的话），让快模型判一下「这是不是一条以后能原样回别的客户的通用回答」（不针对这个人的
   订单、账号、截图；不是「稍等」「私聊你」），是就记进 staff_memory。同一个问题再答一次，用新的覆盖。
2. **想起**（recall）：给一句客户的话，找最像的那条记忆。
3. ~~**判断该不该接话**（should_answer）~~ —— **2026-10-16 删掉了**（管理员：「判断条件太多了，
   把误伤的都删除掉」）。那道模型判断把答得了的答案判掉过，而且每条没 @ 我的消息都要多花一次调用。
   现在「该不该接」由两个便宜的判断说了算：**像不像问句**（正则，`watch._QUESTION`）+
   **库里有没有像的东西**（命中线 / 沾边线），见 `handlers/qa.py` 的 auto_answer。

记忆**不走审核**（他要的是「自己学」），所以门槛另外收紧：没 @ 我时照原话回要像到 MEMORY_SCORE，
（2026-10-16 起不再过模型那道判断）。记错了用 /记忆 看、/忘 编号 删。夜间复盘照旧会把这些答法起草成标准答案给他审。
"""
from __future__ import annotations

import array
import asyncio
import logging
import re
from collections.abc import Sequence
from datetime import datetime, timedelta

from . import notice
from .llm import LLM, LLMError
from .retrieve import dot
from .store import ROLE_STAFF, KBStore

log = logging.getLogger(__name__)

# 没 @ 我的问题，记忆要像到这个分才照原话回（比标准答案的 UNASKED_SCORE 0.85 更严：这些没人审过）
MEMORY_SCORE = 0.9
# 同一个问题（像到这个分）再答一次 = 覆盖那条，不另记
SAME_SCORE = 0.95
# 记忆多久不用就不再拿出来（口径会变：上个月的价格、上周的维护通知）
MEMORY_DAYS = 60
# 自己人说的话往前找几分钟内的客户提问
LOOKBACK_MINUTES = 3
ANSWER_MIN, ANSWER_MAX = 4, 300
QUESTION_MIN = 4
JUDGE_TOKENS = 600

_AT = re.compile(r"@\S+\s*")
_FILLER = re.compile(r"^(稍等|等下|等等|收到|好的?|嗯+|ok|OK|好嘞|私聊|我看(一)?下|马上|在的?|是的?|对的?|谢谢)[\s。!！~，,]*$")
_ORDER = re.compile(r"sub2_\w+|\d{7,}", re.I)

_KEEP = """客服群里，客户问了一句，我们的客服回了一句。判断这条客服回复能不能**原样**拿去回答以后问同样问题的别的客户：
- 是实质的回答（给了办法、结论、地址、步骤），不是「稍等」「收到」「私聊你」「我看下」
- 是通用的，不针对这个客户个人的情况（查他的订单、他的账号、他发的截图、他这次的退款）
- 客户那句确实是在提问或求助
都满足回 YES，否则回 NO。只回 YES 或 NO。

客户问：{q}
客服答：{a}"""


def clean(s: str) -> str:
    return " ".join(_AT.sub(" ", s.replace("[图片]", " ").replace("[表情]", " ")).split())


async def _yes(llm: LLM, prompt: str) -> bool | None:
    """YES / NO 判断题。出错、没回 YES/NO → None（调用方按「不」处理）"""
    try:
        got = await llm.chat([{"role": "user", "content": prompt}], temperature=0, max_tokens=JUDGE_TOKENS)
    except (LLMError, Exception) as e:  # noqa: BLE001 —— 判断题出任何错都当没判出来
        log.warning("记忆判断题失败：%s", e)
        return None
    s = got.strip().upper()
    return True if s.startswith("YES") else False if s.startswith("NO") else None


def find_question(rows: Sequence, reply_to: int, now: datetime) -> object | None:
    """自己人这句在回哪条客户消息。rows = 这个群最近的群消息（新的在前，不含这句本身）"""
    if reply_to:
        for r in rows:
            if r["message_id"] == reply_to:
                return r if r["role"] != ROLE_STAFF else None
    cut = (now - timedelta(minutes=LOOKBACK_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    for r in rows:
        if r["created_at"] < cut:
            break
        if r["role"] != ROLE_STAFF and len(clean(r["body"])) >= QUESTION_MIN:
            return r
    return None


async def capture(
    store: KBStore, llm: LLM, judge: LLM, *, group_id: int, staff_id: int, staff_name: str,
    body: str, reply_to: int, message_id: int = 0, now: datetime | None = None,
) -> int | None:
    """自己人在群里说了一句。像是在回答客户就记下来，返回记忆编号；不记返回 None。**不抛异常**"""
    try:
        now = now or datetime.now()
        a = clean(body)
        if not (ANSWER_MIN <= len(a) <= ANSWER_MAX) or a.startswith("/") or _FILLER.match(a):
            return None
        if notice.looks_like_instruction(a):
            return None
        since = (now - timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
        rows = [r for r in await asyncio.to_thread(store.group_msgs_recent, group_id, since, 60) if r["message_id"] != message_id]
        q_row = find_question(rows, reply_to, now)
        if q_row is None:
            return None
        q = clean(q_row["body"])
        # 客户自己的订单号、QQ 号出现在回答里 = 在回他个人的事
        if any(m.group(0) in a for m in _ORDER.finditer(q)):
            return None
        if await _yes(judge, _KEEP.format(q=q[:300], a=a)) is not True:
            return None
        vec = await llm.embed_one(q)
        hit = await asyncio.to_thread(_best, store, vec, "")
        if hit and hit[1] >= SAME_SCORE:
            await asyncio.to_thread(store.update_memory, hit[0], answer=a, staff_id=staff_id, staff_name=staff_name)
            log.info("记忆 #%d 更新：%s 又答了「%.20s」", hit[0], staff_name, q)
            return hit[0]
        mid = await asyncio.to_thread(
            store.add_memory, group_id=group_id, question=q, answer=a, staff_id=staff_id, staff_name=staff_name, vec=vec,
        )
        log.info("记住了 #%d：%s 回「%.20s」→「%.30s」", mid, staff_name, q, a)
        return mid
    except Exception:  # noqa: BLE001 —— 学不到不该影响任何别的
        log.warning("记管理员答法出错（不影响别的）", exc_info=True)
        return None


def _best(store: KBStore, vec: Sequence[float], since: str) -> tuple[int, float] | None:
    q = array.array("f", vec)
    best_id, best = None, 0.0
    for mid, v in store.memory_vecs(since):
        if len(v) != len(q):
            continue
        s = dot(v, q)
        if s > best:
            best_id, best = mid, s
    return (best_id, best) if best_id is not None else None


async def recall(store: KBStore, vec: Sequence[float], threshold: float) -> tuple[object, float] | None:
    """最像的那条记忆（MEMORY_DAYS 以内的）。不够 threshold → None"""
    since = (datetime.now() - timedelta(days=MEMORY_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    hit = await asyncio.to_thread(_best, store, vec, since)
    if hit is None or hit[1] < threshold:
        return None
    row = await asyncio.to_thread(store.get_memory, hit[0])
    return (row, hit[1]) if row is not None else None
