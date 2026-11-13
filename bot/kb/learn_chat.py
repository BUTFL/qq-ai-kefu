"""截图学答法：管理员在 6099 传客服和客户的聊天截图，机器人看懂「客户问什么、客服怎么答的」，
起草成标准答案放进待审草稿，**管理员点采纳才生效**（2026-10-15 管理员要的，原话「上传聊天记录图片…
机器人去分析并且理解和学习，然后下次有用户问就按照这个方法去回复」；采纳才生效、图片不限张数是他定的）。

两步，分开做是为了让他能改：
1. transcribe：看图模型把一张截图逐字抄成对话，每行标【客服】/【客户】。页面上显示出来，
   认错人、抄错字他当场改。
2. analyze：把（改过的）几张截图的对话连起来，让复盘模型整理出「问题 + 几种说法」，
   每条进待审草稿（跟夜间复盘「学同事答法」同一张表、同一个采纳流程）。

程序外面再卡一道（提示词模型可以不听）：
- 回复里的数字、链接必须**全都**出现在【客服】那几行里。多一个就是模型编的，那种说法扔掉；
  只出现在客户那几行的也不行（客户的订单号、QQ 号不能变成发给所有人的答案）。
- **数字不抹**：这里的号码是客服亲口说的（微信号、价格），跟 review.scrub 防客户号码进草稿的场景不一样。
- 「让用户…」这种给机器人看的口吻、推责任的说法，扔掉。
- 跟已有标准答案像同一件事（向量到命中线），草稿备注里写明像哪条，审的时候自己判断要不要另起。
"""
from __future__ import annotations

import array
import asyncio
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from . import notice
from .llm import LLM, LLMError
from .retrieve import dot
from .store import DR_NEW, KBStore
from .text import facts

log = logging.getLogger(__name__)

# 一次交给模型整理的对话最长多少字。截图多了就按整张切成几段分别整理
CHUNK_CHARS = 6000
MAX_OPTIONS = 3
NOTE = "聊天截图学来的"
STAFF_TAG = "【客服】"
CUSTOMER_TAG = "【客户】"
SEP = "\n——（下一张截图）——\n"

TRANSCRIBE_PROMPT = (
    "这是一张客服群 / 私聊的聊天记录截图。把里面的对话逐条抄出来，一条一行，按截图里从上到下的顺序：\n"
    "【客服】昵称：说的话\n"
    "【客户】昵称：说的话\n"
    "怎么分客服和客户：昵称旁边带「管理员」「群主」标签的、机器人（名字带 AI）、右边自己发的气泡算客服，"
    "{staff_hint}其余算客户。\n"
    "规则：字一个都不改、不总结、不补充；数字、链接、微信号、价格原样抄；"
    "引用回复的写成「（引用某某：原话）」接在那条后面；图片写「[图片]」、表情写「[表情]」；"
    "看不清的字写「□」。只输出对话本身，不要开场白。"
)

_ANALYZE_SYSTEM = (
    "你在帮客服团队把「人工客服在聊天里是怎么回答客户的」整理成标准答案，以后机器人遇到同样的问题就这么回。\n"
    "下面是几张聊天截图抄出来的对话，【客服】是我们的人，【客户】是客户。\n\n"
    "找出客户问的每一个**业务问题**（怎么用、为什么报错、怎么买、怎么配置、怎么开票这类），"
    "而且客服在对话里给了**实质的回答**。闲聊、「稍等」「收到」「私聊你」「我看下」不算回答；"
    "只针对这个客户个人的处理（查他的订单、给他退款、说他账号的情况）也不要。\n\n"
    "每个问题写一条，只输出一个 JSON，不要别的字：\n"
    '{"items": [{"question": "客户口吻的通用问法，去掉昵称和个人信息，4~40 字",'
    ' "aliases": ["客户别的问法，最多 3 个"],'
    ' "options": [{"label": "贴近原话", "answer": "…"}, {"label": "简短", "answer": "…"}, {"label": "完整", "answer": "…"}]}]}\n'
    "回复的规矩：\n"
    "1. 只用客服说过的意思，不补充、不推测；客服原话里的数字、链接、微信号、价格一个字都不改，没说过的一个都不加。\n"
    "2. 直接对客户说，口语，像真人客服在群里回；不能写「让用户…」「用户问…的时候」这种给机器人看的话。\n"
    "3. 不写客户的昵称、QQ 号、订单号。\n"
    "4. 「贴近原话」照客服原话整理通顺；「简短」一两句；「完整」要操作的分步写（最多 4 步）。三种意思一样。\n"
    '一个都找不到就输出 {"items": []}。'
)

# 步骤编号不算事实：「1. 」「2、」「第 2 步」，行首、句中都有（「完整」那种模型常写成一行）
_STEP_NO = re.compile(r"(^|[\s，。；：:])\d{1,2}\s*[.、)）](?!\d)|第\s*\d{1,2}\s*步", re.M)
# 链接只认 ASCII 字符。截图抄出来常是「https://a.com改成https://b.ai」连在一起，
# 不先隔开的话两个链接会被当成一个，跟回复里分开写的对不上
_URL = re.compile(r"https?://[A-Za-z0-9._~:/?#@!$&*+=%-]+", re.I)


def _facts(s: str) -> set[str]:
    s = _STEP_NO.sub(lambda m: m.group(1) or " ", s)
    return facts(_URL.sub(lambda m: f" {m.group(0).rstrip('.,;:!?')} ", s))


class LearnError(Exception):
    """给管理员看的错误，页面原样显示"""


@dataclass
class Result:
    drafts: list[int] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # 给人看的：哪条为什么没起草


async def transcribe(llm: LLM, data: bytes, mime: str, *, model: str, staff_hint: str = "") -> str:
    hint = f"昵称是「{staff_hint.strip()}」的也算客服，" if staff_hint.strip() else ""
    try:
        text = await llm.read_image(data, mime, model=model, prompt=TRANSCRIBE_PROMPT.format(staff_hint=hint))
    except LLMError as e:
        raise LearnError(f"看图失败：{e}") from e
    return text.strip()


def staff_lines(dialog: str) -> str:
    return "\n".join(ln for ln in dialog.splitlines() if ln.strip().startswith(STAFF_TAG))


def chunks(texts: Sequence[str], limit: int = CHUNK_CHARS) -> list[str]:
    """几张截图的对话连起来，超过 limit 就按整张切开（一张截图不拆，拆了上下文就断了）"""
    out: list[str] = []
    cur: list[str] = []
    size = 0
    for t in (t.strip() for t in texts):
        if not t:
            continue
        if cur and size + len(t) > limit:
            out.append(SEP.join(cur))
            cur, size = [], 0
        cur.append(t)
        size += len(t)
    if cur:
        out.append(SEP.join(cur))
    return out


def check_item(item: object, staff_said: str) -> tuple[str, list[dict], list[str]] | str:
    """模型整理出来的一条能不能进草稿。能 → (问题, 几种说法, 别名)；不能 → 给人看的原因"""
    from .answer import blame_words

    if not isinstance(item, dict):
        return "格式不对"
    q = " ".join(str(item.get("question") or "").split())
    if not (4 <= len(q) <= 80):
        return "问题写得不完整"
    raw = item.get("options")
    if not isinstance(raw, list):
        raw = [{"label": "贴近原话", "answer": item.get("answer")}]
    allowed = _facts(staff_said)
    opts: list[dict] = []
    why = ""
    for o in raw:
        if not isinstance(o, dict):
            continue
        a = str(o.get("answer") or "").strip()
        label = " ".join(str(o.get("label") or "").split())[:8]
        if not (2 <= len(a) <= 600):
            continue
        extra = _facts(a) - allowed
        if extra:
            why = f"回复里有客服没说过的「{'、'.join(sorted(extra))}」"
            log.info("截图学答法「%s」多了客服没说的 %s，这一种扔掉：%.40s", label, sorted(extra), q)
            continue
        if notice.looks_like_instruction(a) or blame_words(a):
            why = "回复是给机器人看的口吻或者在推责任"
            continue
        if any(x["answer"] == a for x in opts):
            continue
        opts.append({"label": label, "answer": a})
        if len(opts) >= MAX_OPTIONS:
            break
    if not opts:
        return f"「{q}」没起草：{why or '没有能用的回复'}"
    aliases: list[str] = []
    for x in item.get("aliases") or []:
        x = " ".join(str(x).split())
        if 4 <= len(x) <= 80 and x != q and x not in aliases:
            aliases.append(x)
    return q, opts, aliases[:3]


async def _similar(store: KBStore, llm: LLM, phrasings: list[str], threshold: float) -> tuple[int, str] | None:
    """跟已有标准答案像不像。算向量失败当不像（只是少一句提示，不挡起草）"""
    try:
        vecs = await llm.embed(phrasings)
    except LLMError:
        return None
    rows = await asyncio.to_thread(store.entry_vecs)
    qs = [array.array("f", v) for v in vecs]
    best_id, best = None, 0.0
    for eid, _p, vec in rows:
        s = max((dot(vec, q) for q in qs if len(q) == len(vec)), default=0.0)
        if s > best:
            best_id, best = eid, s
    if best_id is None or best < threshold:
        return None
    e = await asyncio.to_thread(store.get_entry, best_id)
    return (best_id, e.question) if e else None


async def analyze(
    store: KBStore, llm: LLM, embed_llm: LLM, texts: Sequence[str], *, hit_score: float, by_name: str = "6099 页面",
) -> Result:
    """把几张截图的对话整理成待审草稿。llm = 整理用的（复盘模型），embed_llm = 算向量查重用的"""
    from .review import parse_json

    parts = chunks(texts)
    if not parts:
        raise LearnError("没有对话内容。先传截图，等识别完再整理。")
    if not any(staff_lines(p) for p in parts):
        raise LearnError(
            f"认不出哪句是客服说的（每行开头要有「{STAFF_TAG}」）。"
            "在上面的对话框里把客服那几行开头改成【客服】，或者填上客服昵称重新识别。"
        )
    res = Result()
    seen: set[str] = set()
    pending = {d["question"] for d in await asyncio.to_thread(store.drafts, "pending", 500)}
    for dialog in parts:
        said = staff_lines(dialog)
        if not said:
            res.skipped.append("有一段对话里没有客服说话，跳过")
            continue
        try:
            raw = await llm.chat(
                [{"role": "system", "content": _ANALYZE_SYSTEM}, {"role": "user", "content": dialog}],
                temperature=0.2, max_tokens=3000,
            )
        except LLMError as e:
            res.skipped.append(f"整理这段对话时 AI 没连上：{e}")
            continue
        data = parse_json(raw)
        items = (data or {}).get("items")
        if not isinstance(items, list):
            res.skipped.append("AI 没整理出格式化的结果，这段对话再试一次")
            continue
        for item in items:
            got = check_item(item, said)
            if isinstance(got, str):
                res.skipped.append(got)
                continue
            q, opts, aliases = got
            if q in seen or q in pending:
                res.skipped.append(f"「{q}」已经有一条草稿在等你审了")
                continue
            seen.add(q)
            note = f"{NOTE}（{by_name}）"
            dup = await _similar(store, embed_llm, [q, *aliases], hit_score)
            if dup:
                note += f"｜跟已有 #{dup[0]}「{dup[1][:20]}」像，采纳会另起一条，想改那条去「标准答案」页"
            did = await asyncio.to_thread(
                store.add_draft,
                kind=DR_NEW, question=q, answer=opts[0]["answer"], aliases="\n".join(aliases), options=opts,
                evidence=dialog[:3000], note=note,
            )
            res.drafts.append(did)
            log.info("截图学答法起草 #%d：%.40s", did, q)
    return res
