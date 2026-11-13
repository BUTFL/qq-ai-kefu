"""/加：管理员用大白话说一句，AI 改写成客户能看的回复，给他看一眼，他回「好」才生效。

**起因（2026-10-12 22:51 日报群，真机）**：小追兵想加一条「开发票报销要盖章材料就加微信」，
先发了「/定调 …」（不是指令，被静默），又发「/口径 …」（被当成「给机器人看的指令」拒了，
回了一大段改法），最后发「这个内容让 ai 加工一下。」也没人理。东西最后是别人加上去的，
他本人发了两遍都不知道该用哪条指令。管理员 10-14 的原话：「我设置回答问题和添加东西的时候
简单一点…用户都不知道命令是那个太绕了」。

所以这条指令只要他说清楚**要客户知道什么**，剩下的我来：
- 改写成客户口吻（「让用户加微信」→「加微信 …」），**数字、链接、微信号原样保留**；
- 自己判断是长期答案还是临时口径（「这几天」「维护中」「活动」→ 临时，到点自动撤）；
- 跟已有答案像同一件事 → 默认改那一条（不然库里两条打架），他要另起就回「新的」。

**一定先给他看、回「好」才生效**（管理员 10-14 定的：「用回好这个可以，但是得告诉管理员
有这个好这个回答才执行」）。预览里明说「回复『好』才生效」，只认发 /加 的本人、同一个地方、
10 分钟内。生效之前什么都不写库。

**数字为什么不走 review.scrub**：scrub 会把 7 位以上的数字抹成 ***（防客户 QQ 号进草稿），
这里的数字是管理员亲手给的联系方式，抹掉就废了。取而代之的是反方向的校验：
回复里的数字和链接必须**全都**出现在他原话里（多一个 = 模型编的，不用）；
他原话里有、回复里没了的，预览里点出来让他确认。
"""
from __future__ import annotations

import array
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import timedelta

from . import notice
from .cluster import link_similar
from .llm import LLM, LLMError
from .retrieve import dot
from .store import BY_QQ, KBStore
from .text import facts

log = logging.getLogger(__name__)

# 回「好」的有效期。10 分钟够他看完、问一圈同事；再长就容易把上午的预览下午「好」掉
CONFIRM_MINUTES = 10
# 回这几个字之一 = 确认。故意很窄：「好的谢谢」「好像不对」都不算，宁可他再回一次
YES_WORDS = {"好", "好的", "好。", "好！", "好!", "确认", "可以", "行", "ok", "OK", "Ok"}
# 要另起一条、不改那条像的
NEW_WORDS = {"新的", "新建", "另起"}
ANSWER_MAX = 600
HOURS_DEFAULT = 24
HOURS_MAX = int(notice.MAX.total_seconds() // 3600)

KIND_ENTRY = "entry"
KIND_NOTICE = "notice"

_SYSTEM = (
    "你是客服知识库的编辑。管理员发来一段话，要变成客服机器人以后回客户的话。\n"
    "只输出一个 JSON，不要别的字：\n"
    '{"kind": "entry 或 notice", "question": "客户最可能怎么问（一句，客户口吻，4~40 字）",'
    ' "aliases": ["客户别的问法，最多 4 个"], "answer": "直接发给客户的那段回复", "hours": 数字}\n'
    "规则：\n"
    "1. answer 是对客户说的话，像真人客服在群里回，口语、简短，不加「您好」「亲」这类客套。"
    "不能写「让用户…」「用户问…的时候」「请引导客户…」这种给机器人看的话。\n"
    "2. 管理员原话里的数字、链接、微信号、价格、时间，一个字都不能改、不能漏。"
    "原话里没有的数字和链接一个都不能加。\n"
    "3. 只说管理员说了的事，不补充、不推测、不解释原因。\n"
    "4. 原话讲的是有时效的事（今天、这几天、维护中、临时、活动、预计几点恢复、波动）→ kind 填 notice，"
    "hours 按原话估这件事还要持续几小时（没说就 24，最多 72）；其余 → kind 填 entry，hours 填 0。\n"
    "5. question 和 aliases 写客户真会怎么问，不是管理员这段话的标题。"
)


class TeachError(Exception):
    """改写不成，str(e) 就是回给管理员的那句话"""


@dataclass
class Plan:
    """一次 /加 的预览。回「好」之前只活在内存里"""

    kind: str
    question: str
    answer: str
    raw: str  # 管理员的原话，事实校验以它为准
    aliases: list[str] = field(default_factory=list)
    hours: int = 0
    entry_id: int | None = None  # 非空 = 改这条已有的答案，不新建
    dup_question: str = ""
    dup_score: float = 0.0
    missing: list[str] = field(default_factory=list)  # 原话里有、回复里没了的数字 / 链接


def is_yes(body: str) -> bool:
    return body.strip() in YES_WORDS


def is_new(body: str) -> bool:
    return body.strip() in NEW_WORDS


def revision(body: str) -> str | None:
    """「改：新的回复」→ 新的回复；不是这种写法 → None"""
    s = body.strip()
    for head in ("改成：", "改成:", "改：", "改:"):
        if s.startswith(head):
            return s[len(head):].strip() or None
    return None


def _clean(s: object, n: int) -> str:
    return " ".join(str(s or "").split())[:n]


def check(data: dict | None, raw: str) -> Plan:
    """模型给的 JSON 能不能用。不能就抛 TeachError，话是回给管理员的"""
    from .answer import blame_words

    if not isinstance(data, dict):
        raise TeachError("AI 没改写出来。再发一次，或者直接写成客户能看的那句话。")
    kind = KIND_NOTICE if str(data.get("kind") or "").strip().lower() == KIND_NOTICE else KIND_ENTRY
    q = _clean(data.get("question"), 80)
    a = str(data.get("answer") or "").strip()
    if not (4 <= len(q) <= 80) or not (2 <= len(a) <= ANSWER_MAX):
        raise TeachError("AI 改写出来的东西不完整。再发一次，或者说清楚「客户问什么、回什么」。")
    if kind == KIND_NOTICE and len(a) > notice.MAX_CHARS:
        raise TeachError(f"临时口径太长了（{len(a)} 字），{notice.MAX_CHARS} 字以内客户才看得完。说短一点再发。")
    # 多出来的数字和链接 = 模型编的，这一版直接不用
    extra = facts(a) - facts(raw)
    if extra:
        log.info("/加 改写多了原话没有的 %s：%.40s", sorted(extra), raw)
        raise TeachError(
            f"AI 改写时多出了你没说的「{'、'.join(sorted(extra))}」，没敢用。\n"
            "再发一次，或者直接写成客户能看的那句话。"
        )
    if notice.looks_like_instruction(a) or blame_words(a):
        raise TeachError("AI 改写出来还是给机器人看的口吻，没敢用。直接写成客户能看的那句话再发一次。")
    aliases: list[str] = []
    for x in data.get("aliases") or []:
        x = _clean(x, 80)
        if 4 <= len(x) <= 80 and x != q and x not in aliases:
            aliases.append(x)
    hours = 0
    if kind == KIND_NOTICE:
        try:
            hours = int(float(data.get("hours") or HOURS_DEFAULT))
        except (TypeError, ValueError):
            hours = HOURS_DEFAULT
        hours = min(max(hours, 1), HOURS_MAX)
    # 原话里有、回复里没了的：可能是漏了电话。预览里点出来让他看
    missing = sorted(facts(raw) - facts(a))
    return Plan(kind=kind, question=q, answer=a, raw=raw, aliases=aliases[:4], hours=hours, missing=missing)


async def draft(llm: LLM, raw: str) -> Plan:
    raw = raw.strip()
    if len(raw) < 4:
        raise TeachError(
            "要加什么？直接说就行，比如：\n"
            "/加 开发票报销要盖章材料的，加微信 18500000000 拿"
        )
    from .review import parse_json

    try:
        got = await llm.chat(
            [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": raw[:1500]}],
            temperature=0.1, max_tokens=800,
        )
    except LLMError as e:
        raise TeachError(f"AI 这会儿没连上（{e}），过一会儿再发一次。") from e
    return check(parse_json(got), raw)


async def find_dup(store: KBStore, llm: LLM, plan: Plan, threshold: float) -> None:
    """跟已有答案像同一件事 → 记到 plan 上，生效时默认改那一条。只对长期答案查；算向量失败当没重复"""
    if plan.kind != KIND_ENTRY:
        return
    try:
        vecs = await llm.embed([plan.question, *plan.aliases])
    except LLMError as e:
        log.warning("/加 查重算向量失败，当没重复：%s", e)
        return
    rows = await asyncio.to_thread(store.entry_vecs)
    qs = [array.array("f", v) for v in vecs]
    best_id, best = None, 0.0
    for eid, _phrase, vec in rows:
        s = max((dot(vec, q) for q in qs if len(q) == len(vec)), default=0.0)
        if s > best:
            best_id, best = eid, s
    if best_id is not None and best >= threshold:
        entry = await asyncio.to_thread(store.get_entry, best_id)
        if entry is not None:
            plan.entry_id, plan.dup_question, plan.dup_score = best_id, entry.question, best


def preview(plan: Plan, current_notice: str = "") -> str:
    """给管理员看的那一屏。**明说「回复『好』才生效」**（管理员 10-14 定的）"""
    lines = ["📋 我理解成这样（还没生效）："]
    if plan.kind == KIND_NOTICE:
        lines.append(f"类型：临时口径，{plan.hours} 小时后自动撤（看着像有时效的事）")
        lines.append(f"客户问到相关的，回：{plan.answer}")
        if current_notice:
            lines.append(f"⚠️ 会替换现在这条口径：{current_notice[:40]}")
    else:
        if plan.entry_id is not None:
            lines.append(f"类型：改已有的 #{plan.entry_id}「{plan.dup_question}」（像同一件事），原来的问法都留着")
        else:
            lines.append("类型：新的标准答案")
        lines.append(f"客户问：{plan.question}")
        if plan.aliases:
            lines.append(f"也认：{'｜'.join(plan.aliases)}")
        lines.append(f"回复：{plan.answer}")
    if plan.missing:
        lines.append(f"⚠️ 你原话里的「{'、'.join(plan.missing)}」回复里没有，确认不需要")
    lines.append("")
    lines.append(f"👉 回复「好」才会生效（{CONFIRM_MINUTES} 分钟内，只认你本人）")
    lines.append("想换说法：发「改：新的回复」")
    if plan.entry_id is not None:
        lines.append("不改那条、要另起一条：发「新的」")
    lines.append("不要就不用管，过时自动作废")
    return "\n".join(lines)


def revise(plan: Plan, new_answer: str) -> Plan:
    """「改：…」= 他亲手写的回复，原样用。只挡指令口吻和超长，不查事实（他写的就是事实来源）"""
    a = new_answer.strip()
    if not (2 <= len(a) <= ANSWER_MAX):
        raise TeachError(f"回复要 2~{ANSWER_MAX} 字。")
    if plan.kind == KIND_NOTICE and len(a) > notice.MAX_CHARS:
        raise TeachError(f"临时口径 {notice.MAX_CHARS} 字以内。")
    if notice.looks_like_instruction(a):
        raise TeachError("这句还是给机器人看的口吻（「让用户…」这种），客户收到的就是原文。写成直接对客户说的话。")
    plan.answer = a
    plan.raw = f"{plan.raw}\n{a}"
    plan.missing = []
    return plan


async def apply(store: KBStore, llm: LLM, plan: Plan, by: int, by_name: str, *, cluster_score: float) -> str:
    """回「好」之后真正写库。返回回给他的话"""
    from . import sync

    if plan.kind == KIND_NOTICE:
        n = await asyncio.to_thread(notice.put, store, plan.answer, timedelta(hours=plan.hours), by)
        log.info("%s 用 /加 挂了临时口径 %d 小时：%.40s", by_name or by, plan.hours, plan.answer)
        return (
            f"生效了 ✅ 临时口径，到 {n.until:%m-%d %H:%M} 自动撤。客户问到相关的就回这句。\n"
            "提前撤：/口径 撤"
        )

    old = await asyncio.to_thread(store.get_entry, plan.entry_id) if plan.entry_id is not None else None
    if old is not None:
        eid, _ = await asyncio.to_thread(
            store.upsert_entry,
            question=old.question, answer=plan.answer, aliases="\n".join([plan.question, *plan.aliases]),
            by=by, source=BY_QQ, entry_id=old.id, merge_aliases=True,
        )
        created = False
    else:  # 没重复，或者这 10 分钟里那条被人删了：照新的建
        eid, created = await asyncio.to_thread(
            store.upsert_entry,
            question=plan.question, answer=plan.answer, aliases="\n".join(plan.aliases), by=by, source=BY_QQ,
            merge_aliases=True,
        )
    entry = await asyncio.to_thread(store.get_entry, eid)
    if entry is None:
        return "存是存下了，但读回来不见了，这不正常，看日志吧。"
    await asyncio.to_thread(store.audit, "加" if created else "改", eid, entry.question, by, by_name)
    try:
        vecs = await llm.embed(entry.phrasings)
    except LLMError as e:
        log.warning("/加 给答案 #%d 算向量失败：%s", eid, e)
        return f"答案 #{eid} 存下了，但算向量失败（{e}），现在还匹配不到。等会儿发 /同步 重试。"
    await asyncio.to_thread(store.set_entry_vecs, eid, list(zip(entry.phrasings, vecs)))
    linked = await asyncio.to_thread(link_similar, store, eid, vecs, cluster_score)
    await asyncio.to_thread(sync.write, store)
    tail = f"，顺带结掉了 {len(linked)} 条相似的待办" if linked else ""
    log.info("%s 用 /加 %s了答案 #%d，联动结掉 %d 条", by_name or by, "新建" if created else "更新", eid, len(linked))
    return (
        f"生效了 ✅ 标准答案 #{eid}「{entry.question}」{'（新的）' if created else '（更新了）'}{tail}\n"
        f"下次客户这么问就这么回。要改：/改 {eid} 新内容"
    )
