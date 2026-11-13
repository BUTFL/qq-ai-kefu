"""临时口径：`/口径 GPT 分组官方在波动，预计半小时恢复 2h`（2026-09-30 管理员要的）。

起因：官方有波动、临时活动这种事，资料里没有，标准答案也不该为它写一条（过两小时就不对了）。
几个客户同时报错时盯群会私聊他「故障苗头」，但机器人自己不知道出了什么事，还是照资料答、或者转人工。

怎么用：
- `/口径 内容 2h`：接下来 2 小时，客户问到**跟这件事有关的**，机器人**照这句原话回**（@ 他）。
  时长写在最前或最后都行：`2h` `30m` `1.5小时` `20分钟` `1天`；不写就 DEFAULT，最长 MAX
- `/口径 条件 → 回复`：`/口径 客户问到开发票相关的就回复：目前在维护，稍等一下` ——
  前半句「客户问什么算有关」是给机器人看的，后半句才是发给客户的话；命中时**只发后半句**
- `/口径`：看现在生效的是哪句、到几点
- `/口径 撤`：提前撤掉

**原话回，不让模型改写**：口径是他亲笔写的，跟标准答案一个级别，价格、发票闸前面就照它回（qa.py）。

**原话回的前提是那句本来就是发给客户看的**：口径是逐字发给客户的原话，所以**只能写客户能直接看的话**。
客服顺手写成「用户询问…的时候，让用户…」这种给机器人看的指令句时，客户收到的就是它原文 ——
一句内部备注口吻，接不上话。2026-10-12 真事：客服把这条指令当口径挂上 2 小时，两个群里原样发给了
问「如何对公？」的客户。挂载时和取用时都过 `looks_like_instruction`，不是客户口吻就不发。
「有没有关系」是模型判的（只回 YES / NO），判不了、出错一律当没关系 —— 照常答题，不会因为口径卡住。
**额度必须用 JUDGE_TOKENS，不能图省钱填小**：09-30 上线当天这里填的 8，模型回 YES 之前也要先想
一百来个 token，10 次里 8 次正文是空的、全按「无关」放过去 —— 口径发了不生效，而且不报错（见 llm.py 的 JUDGE_TOKENS）。
存在 meta 表里（一条），机器人重启不丢；到点自己失效，不用谁去撤。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from .llm import JUDGE_TOKENS, LLM, LLMError
from .store import KBStore

log = logging.getLogger(__name__)

META_KEY = "notice"
DEFAULT = timedelta(hours=2)
MAX = timedelta(days=3)
MAX_CHARS = 300
JUDGE_TIMEOUT = 15.0
CLEAR_WORDS = {"撤", "撤掉", "撤销", "取消", "清", "清掉", "关", "关掉", "删", "删掉", "off", "0"}

# 给机器人看的「指令句」长什么样。**只用来拦，不用来改写**：口径是原话回客户，按设计一个字都不让模型改
# （见上面那段）—— 帮它改写等于把「他亲笔写的」换成「模型写的」，那是另一种错。看着像指令就不挂，
# 让他自己改成客户能直接看的话再发。
#
# 2026-10-12 真事：客服把「用户询问对公转账相关问题的时候，让用户添加我微信：18500000000 进一步对接。」
# 当口径挂上，2 小时里两个群把这句话原样发给了问「如何对公？」的客户。**只收明确指向用户/客户的
# 第二人称指令**，不碰正常口径：「GPT 分组官方在波动，预计半小时恢复」「国庆充值送 10%」都不沾这些词。
_TO_BOT = re.compile(
    r"的时候\s*[，,]?\s*(让|叫|请|提醒|告诉|回)"
    r"|(让|叫|请|提醒|告诉|回复|通知|引导)\s*(用户|客户|顾客)"
    r"|^(用户|客户)(询问|问|咨询|说|提到)"
    r"|(让|叫)\s*(机器人|它|小助手)"
)


def looks_like_instruction(text: str) -> bool:
    """这句是不是「写给机器人看的指令」，而不是「能直接发给客户的话」。
    漏放的代价是内部指令原样发给客户（2026-10-12 那次）；误拦的代价只是运营以为挂上了、其实没挂，
    而且挂载命令当场会回话告诉他，看得见。所以词表只收指向「用户 / 客户」的指令句式。
    """
    return bool(_TO_BOT.search(text))


# 「条件 → 回复」写法（追加需求 2026-10-12 21:07）。
# `/口径 用户问到开发票相关的就回复：目前在维护，稍等一下` —— 左边是触发条件（给机器人看的：
# 客户问什么算有关），右边才是发给客户的话。命中时只发右边。
# 这正是「对公转账」那次事故的正解：客服本来就该这么写，机器人不用猜、也不会把指令发出去。
_SPLIT_REPLY = re.compile(
    r"^(?P<cond>.+?)\s*(?:的话)?\s*(?:就|则|请|一律|都)?\s*(?:回复|答复|回)\s*[:：]\s*(?P<reply>.+)$",
    re.S,
)
_SPLIT_ARROW = re.compile(r"^(?P<cond>.+?)\s*(?:->|→|=>|＝>)\s*(?P<reply>.+)$", re.S)


def split_reply(text: str) -> tuple[str, str] | None:
    """把「条件 → 回复」拆成 (触发条件, 该发给客户的话)；不是这种写法返回 None。

    只在两边都非空、且分隔符明确（「回复：/回：」或箭头）时才拆：宁可当成普通口径，
    也不要把一句正常的话腰斩。条件那半句允许是指令口吻（本来就是给机器人看的），
    要发出去的那半句由 command() 再过一道 looks_like_instruction。
    """
    for pat in (_SPLIT_REPLY, _SPLIT_ARROW):
        m = pat.match(text.strip())
        if not m:
            continue
        # 条件末尾常常带个逗号（「后台正常，回：稍等」），去掉再存，免得回话和提示词里难看
        cond = m.group("cond").strip().rstrip("，,。.；;：:、")
        reply = m.group("reply").strip()
        if cond and reply:
            return cond, reply
    return None


_DUR = re.compile(r"^(\d+(?:\.\d+)?)\s*(h|hr|小时|个小时|m|min|分钟|分|d|天)$", re.I)
_UNIT = {"h": 60, "hr": 60, "小时": 60, "个小时": 60, "m": 1, "min": 1, "分钟": 1, "分": 1, "d": 1440, "天": 1440}

_JUDGE = """运营刚发了一条临时口径：这段时间客户问到跟下面这件事有关的，就按他定的话回：
「{text}」

客户在群里说：「{question}」

客户这句是不是在问这件事，或者正受这件事影响？
比如口径说「GPT 分组官方在波动」，客户说 GPT 报错、用不了、很慢、没反应，都算；
客户问怎么充值、Cursor 怎么配置、别的模型的事，跟口径没关系，不算。拿不准就算不相关。
只回 YES 或 NO。"""


@dataclass
class Notice:
    text: str
    until: datetime
    by: int = 0
    # 「条件 → 回复」里真正发给客户的那半句。空 = text 就是发给客户的原话（老写法，兼容存量）
    reply: str = ""

    @property
    def outgoing(self) -> str:
        """命中时真正发给客户的那句"""
        return self.reply or self.text

    @property
    def left(self) -> str:
        """还剩多久，给人看的"""
        mins = max(0, int((self.until - datetime.now()).total_seconds() // 60))
        return f"{mins // 60} 小时 {mins % 60} 分钟" if mins >= 60 else f"{mins} 分钟"


def parse_duration(tok: str) -> timedelta | None:
    m = _DUR.match(tok.strip())
    if not m:
        return None
    return timedelta(minutes=float(m.group(1)) * _UNIT[m.group(2).lower()])


def parse(args: str) -> tuple[str, timedelta]:
    """「内容 2h」或「2h 内容」→ (内容, 时长)。没写时长用 DEFAULT，超过 MAX 按 MAX"""
    toks = args.split()
    dur = None
    if toks and (d := parse_duration(toks[-1])):
        dur, toks = d, toks[:-1]
    elif toks and (d := parse_duration(toks[0])):
        dur, toks = d, toks[1:]
    dur = min(dur or DEFAULT, MAX)
    return " ".join(toks).strip(), dur


def current(store: KBStore, now: datetime | None = None) -> Notice | None:
    """生效中的那条；没有、过期了、存坏了都是 None"""
    raw = store.get_meta(META_KEY)
    if not raw:
        return None
    try:
        d = json.loads(raw)
        n = Notice(
            text=str(d["text"]), until=datetime.fromisoformat(d["until"]),
            by=int(d.get("by") or 0), reply=str(d.get("reply") or ""),
        )
    except (ValueError, KeyError, TypeError):
        log.warning("存的口径读不出来，当没有：%.80s", raw)
        return None
    if not n.text or n.until <= (now or datetime.now()):
        return None
    # 挂载校验是 2026-10-12 才加的，之前存进去的指令句得在这儿挡一下：当没有 = 客户问到相关的照常答题，
    # 比把内部备注原样发出去强。清掉那条得用 /口径 撤 或手动改库，这里只保证不发。
    # **看的是真正要发出去的那句**（outgoing）：条件→回复写法里条件本身就是指令口吻，不该拦。
    if looks_like_instruction(n.outgoing):
        log.warning("存着的口径像是给机器人看的指令，当没有：%.80s", n.outgoing)
        return None
    return n


def put(store: KBStore, text: str, dur: timedelta, by: int = 0, reply: str = "") -> Notice:
    n = Notice(text=text, until=datetime.now() + dur, by=by, reply=reply)
    store.set_meta(META_KEY, json.dumps(
        {"text": n.text, "reply": n.reply, "until": n.until.isoformat(timespec="seconds"), "by": by},
        ensure_ascii=False,
    ))
    return n


def clear(store: KBStore) -> bool:
    """撤掉。返回撤之前有没有生效中的"""
    had = current(store) is not None
    store.set_meta(META_KEY, "")
    return had


async def related(llm: LLM, n: Notice, question: str) -> bool:
    """客户这句跟口径有没有关系。**出错、超时、答得不像样一律 False**：照常答题"""
    try:
        async with asyncio.timeout(JUDGE_TIMEOUT):
            got = await llm.chat(
                [{"role": "user", "content": _JUDGE.format(text=n.text, question=question[:300])}],
                temperature=0, max_tokens=JUDGE_TOKENS,
            )
    except (LLMError, TimeoutError) as e:
        log.warning("判断跟口径有没有关系失败，照常答：%s", e)
        return False
    yes = got.strip().upper().startswith("YES")
    log.info("口径相关？%s：%.40s", "是" if yes else "否", question)
    return yes


async def command(store: KBStore, args: str, by: int) -> str:
    """/口径 指令本身。返回回给打指令那个人的话"""
    args = args.strip()
    if not args:
        n = await asyncio.to_thread(current, store)
        if n is None:
            return (
                "现在没有临时口径。\n"
                "发「/口径 内容 2h」：接下来 2 小时客户问到相关的，我照这句原话回。\n"
                "内容只能写客户能直接看的那句 —— 客户收到的就是它原文。\n"
                "也可以写「条件 → 回复」：/口径 客户问到开发票相关的就回复：目前在维护，稍等一下（只发后半句）"
            )
        body = f"触发：{n.text}\n客户看到：{n.outgoing}" if n.reply else n.text
        return f"现在的口径（还剩 {n.left}，到 {n.until:%H:%M}）：\n{body}\n\n提前撤：/口径 撤"
    if args.lower() in CLEAR_WORDS:
        had = await asyncio.to_thread(clear, store)
        return "撤了，客户再问照常答。" if had else "现在本来就没有口径。"
    text, dur = parse(args)
    if not text:
        return "口径内容是空的。写法：/口径 GPT 分组官方在波动，预计半小时恢复 2h"
    if len(text) > MAX_CHARS:
        return f"口径太长了（{len(text)} 字），{MAX_CHARS} 字以内，客户在群里看得完。"
    # 「条件 → 回复」写法：拆出触发条件和该发给客户的那半句（追加需求 2026-10-12 21:07）
    split = split_reply(text)
    if split is not None:
        cond, reply = split
        # 条件可以是给机器人看的指令口吻（「用户问到开发票相关的」），只有要发出去的回复必须是客户口吻
        if looks_like_instruction(reply):
            return (
                "回复那半句像是给机器人看的指令（「让用户…」这种），客户收到的就是它原文。\n"
                "后半句要写成客户能直接看的话，比如：/口径 客户问到开发票相关的就回复：目前在维护，稍等一下"
            )
        n = await asyncio.to_thread(put, store, cond, dur, by, reply)
        return (
            f"好，到 {n.until:%m-%d %H:%M}（{n.left}）为止，客户问到跟「{cond}」有关的，我只回这句：\n"
            f"{reply}\n\n"
            "没关系的问题照常答。看现在的：/口径　提前撤：/口径 撤"
        )
    if looks_like_instruction(text):
        return (
            "这句像是给机器人看的指令（「让用户…」「用户询问…」这种），挂上去客户收到的就是它原文，\n"
            "会当成咱们没写完的内部备注。两种改法：\n"
            "· 只写客户能直接看的那句话；\n"
            "· 或者写成「条件 → 回复」：/口径 客户问到开发票相关的就回复：目前在维护，稍等一下（只发后半句）"
        )
    n = await asyncio.to_thread(put, store, text, dur, by)
    return (
        f"好，到 {n.until:%m-%d %H:%M}（{n.left}）为止，客户问到跟这件事有关的，我照这句原话回：\n"
        f"{text}\n\n"
        "没关系的问题照常答。看现在的：/口径　提前撤：/口径 撤"
    )
