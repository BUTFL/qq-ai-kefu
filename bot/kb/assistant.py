"""管理员私聊大白话 → 机器人自己理解要做什么 → 列出来给他看 → 回「好」才执行（2026-10-15）。

管理员原话：「只要管理员私信你他可以大白话和你说你可以自己解析，管理员也可以命令你修改」。
能做的（都是现有指令能做的事，只是不用记指令）：
- 加一条标准答案 / 改某条的回复 / 删某条
- 改、删机器人学到的同事答法（记忆）
- 把某几条草稿采纳成标准答案（包括被删掉的草稿，比如「把 Listen 那几条 133 135 恢复」）
- 挂一条临时口径
- 只是问问题（「你学了几条」「#11 现在怎么回的」）→ 直接回答，不改东西

**改东西一律先列出来、回「好」才动**（跟 /加 同一个规矩）。编号是模型从给它的清单里挑的，
执行前逐个核对存在；回复里的数字、链接必须出现在他原话或那条原来的内容里，不许模型编。
"""
from __future__ import annotations

import array
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from . import notice
from .llm import LLM, LLMError
from .retrieve import dot
from .store import DR_PENDING, KBStore
from .text import facts

log = logging.getLogger(__name__)

KINDS = ("add_entry", "edit_entry", "delete_entry", "edit_memory", "delete_memory", "accept_draft", "notice")
MAX_ACTIONS = 10

_SYSTEM = """你是客服机器人的管理助手。管理员私聊你一段大白话，你要判断他想让你做什么，只输出一个 JSON：
{"reply": "给管理员的一句话（问问题就直接回答；要改东西就简单说你理解成什么）",
 "actions": [ ... 要执行的改动，没有就 [] ... ]}

能做的改动（字段照抄，编号只能用下面清单里有的）：
- {"kind": "add_entry", "question": "客户口吻的问法", "aliases": ["别的问法"], "answer": "直接发给客户的回复"}
- {"kind": "edit_entry", "id": 标准答案编号, "answer": "新的回复"}
- {"kind": "delete_entry", "id": 标准答案编号}
- {"kind": "edit_memory", "id": 记忆编号, "answer": "新的回复"}
- {"kind": "delete_memory", "id": 记忆编号}
- {"kind": "accept_draft", "id": 草稿编号, "pick": 第几种说法（从 1 数，不写就 1）, "answer": "要改字就写改后的，不改就不写"}
- {"kind": "notice", "text": "临时口径，直接发给客户的话", "hours": 几小时}

规矩：
1. 回复（answer、text）是直接发给客户看的话：口语、简短、说重点。不能写「让用户…」「用户问…的时候」这种给机器人看的话。
2. 管理员原话里的数字、链接、微信号、价格一个字都不能改；他没说的数字和链接一个都不能加。
3. 他说「改成…」「换成…」就用他的说法；说「删了」「不要了」就删；说「恢复」「采纳」草稿就 accept_draft。
4. 只是问问题、闲聊、看不懂他要干什么 → actions 留空，reply 里回答或问他一句。
5. 编号对不上清单的不要编，在 reply 里说找不到。"""


class AssistantError(Exception):
    """给管理员看的话"""


@dataclass
class Action:
    kind: str
    params: dict[str, Any]
    desc: str = ""


@dataclass
class Plan:
    reply: str
    actions: list[Action] = field(default_factory=list)


def _clip(s: str, n: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


async def _context(store: KBStore, llm: LLM, text: str) -> str:
    """给模型看的清单：全部标准答案的问法、跟这句最像的几条的全文、最近的记忆和草稿"""
    entries = await asyncio.to_thread(store.entries)
    lines = ["【标准答案清单（编号 问法）】"]
    lines += [f"#{e.id} {_clip(e.question, 30)}" for e in entries]
    try:
        q = array.array("f", await llm.embed_one(text))
        scored: dict[int, float] = {}
        for eid, _p, v in await asyncio.to_thread(store.entry_vecs):
            if len(v) == len(q):
                scored[eid] = max(scored.get(eid, 0.0), dot(v, q))
        top = sorted(scored, key=lambda i: -scored[i])[:5]
    except Exception:  # noqa: BLE001 —— 算不出最像的几条就只给清单，不挡别的
        top = []
    by_id = {e.id: e for e in entries}
    if top:
        lines.append("\n【跟这次说的最像的几条标准答案（全文）】")
        lines += [f"#{i} 问：{by_id[i].question}\n   答：{_clip(by_id[i].answer, 300)}" for i in top if i in by_id]
    mems = await asyncio.to_thread(store.memories, 20)
    if mems:
        lines.append("\n【机器人学到的同事答法（记忆）】")
        lines += [f"记忆#{m['id']} 问：{_clip(m['question'], 30)} → 答：{_clip(m['answer'], 80)}（{m['staff_name']}）" for m in mems]
    since = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    drafts = [d for d in await asyncio.to_thread(store.drafts_since, since, 60)]
    if drafts:
        lines.append("\n【最近三天的草稿（pending 等审 / rejected 被删了，也能恢复）】")
        for d in drafts:
            opts = store.draft_options(d)
            first = opts[0]["answer"] if opts else d["answer"]
            lines.append(f"草稿#{d['id']}（{d['state']}，{_clip(d['note'], 20)}）问：{_clip(d['question'], 30)} → {_clip(first, 60)}")
    return "\n".join(lines)


def _source_text(store: KBStore, a: dict[str, Any]) -> str:
    """改动里允许出现的数字、链接从哪来：他原话 + 那条原来的内容"""
    kind, i = a.get("kind"), a.get("id")
    try:
        if kind == "edit_entry" and i:
            e = store.get_entry(int(i))
            return e.answer if e else ""
        if kind == "edit_memory" and i:
            m = store.get_memory(int(i))
            return m["answer"] if m else ""
        if kind == "accept_draft" and i:
            d = store.get_draft(int(i))
            return "\n".join(o["answer"] for o in store.draft_options(d)) if d else ""
    except (ValueError, TypeError):
        return ""
    return ""


def check(data: dict | None, raw: str, store: KBStore) -> Plan:
    if not isinstance(data, dict):
        raise AssistantError("没理解你要做什么，换个说法再说一次。")
    reply = " ".join(str(data.get("reply") or "").split())[:500]
    out: list[Action] = []
    problems: list[str] = []
    for a in (data.get("actions") or [])[:MAX_ACTIONS]:
        if not isinstance(a, dict) or a.get("kind") not in KINDS:
            continue
        kind = a["kind"]
        text = str(a.get("answer") or a.get("text") or "").strip()
        if text:
            extra = facts(text) - facts(raw + "\n" + _source_text(store, a))
            if extra:
                problems.append(f"「{_clip(text, 20)}」里有你没说过的「{'、'.join(sorted(extra))}」，这条没敢列")
                continue
            if notice.looks_like_instruction(text):
                problems.append(f"「{_clip(text, 20)}」是给机器人看的口吻，这条没列")
                continue
        try:
            i = int(a["id"]) if a.get("id") is not None else None
        except (ValueError, TypeError):
            i = None
        if kind == "add_entry":
            q = " ".join(str(a.get("question") or "").split())
            if not (2 <= len(q) <= 80) or not (2 <= len(text) <= 600):
                continue
            aliases = [" ".join(str(x).split()) for x in (a.get("aliases") or []) if 2 <= len(str(x).strip()) <= 80][:5]
            out.append(Action(kind, {"question": q, "answer": text, "aliases": aliases}, f"新加标准答案「{_clip(q, 30)}」→ {_clip(text, 80)}"))
        elif kind in ("edit_entry", "delete_entry"):
            e = store.get_entry(i) if i else None
            if e is None:
                problems.append(f"没有标准答案 #{i}")
                continue
            if kind == "edit_entry":
                if not (2 <= len(text) <= 600):
                    continue
                out.append(Action(kind, {"id": i, "answer": text}, f"改标准答案 #{i}「{_clip(e.question, 24)}」的回复 → {_clip(text, 80)}"))
            else:
                out.append(Action(kind, {"id": i}, f"删掉标准答案 #{i}「{_clip(e.question, 30)}」"))
        elif kind in ("edit_memory", "delete_memory"):
            m = store.get_memory(i) if i else None
            if m is None:
                problems.append(f"没有记忆 #{i}")
                continue
            if kind == "edit_memory":
                if not (2 <= len(text) <= 600):
                    continue
                out.append(Action(kind, {"id": i, "answer": text}, f"改记忆 #{i}「{_clip(m['question'], 24)}」→ {_clip(text, 80)}"))
            else:
                out.append(Action(kind, {"id": i}, f"删掉记忆 #{i}「{_clip(m['question'], 30)}」"))
        elif kind == "accept_draft":
            d = store.get_draft(i) if i else None
            if d is None:
                problems.append(f"没有草稿 #{i}")
                continue
            opts = store.draft_options(d)
            try:
                pick = max(1, min(int(a.get("pick") or 1), len(opts) or 1))
            except (ValueError, TypeError):
                pick = 1
            ans = text or (opts[pick - 1]["answer"] if opts else d["answer"])
            if d["state"] == "accepted":
                problems.append(f"草稿 #{i} 早就采纳过了")
                continue
            out.append(Action(kind, {"id": i, "answer": ans}, f"草稿 #{i}「{_clip(d['question'], 24)}」变成标准答案 → {_clip(ans, 80)}"))
        elif kind == "notice":
            if not (2 <= len(text) <= notice.MAX_CHARS):
                continue
            try:
                hours = max(1, min(int(a.get("hours") or 24), int(notice.MAX.total_seconds() // 3600)))
            except (ValueError, TypeError):
                hours = 24
            out.append(Action(kind, {"text": text, "hours": hours}, f"挂临时口径 {hours} 小时：{_clip(text, 80)}"))
    if problems:
        reply = (reply + "\n" if reply else "") + "（" + "；".join(problems) + "）"
    return Plan(reply=reply, actions=out)


async def plan(llm: LLM, embed_llm: LLM, store: KBStore, text: str) -> Plan:
    from .review import parse_json

    ctx = await _context(store, embed_llm, text)
    try:
        raw = await llm.chat(
            [{"role": "system", "content": _SYSTEM + "\n\n" + ctx}, {"role": "user", "content": text[:2000]}],
            temperature=0.1, max_tokens=2000,
        )
    except LLMError as e:
        raise AssistantError(f"AI 这会儿没连上（{e}），过一会儿再说一次。") from e
    return await asyncio.to_thread(check, parse_json(raw), text, store)


def preview(p: Plan) -> str:
    lines = [p.reply] if p.reply else []
    if p.actions:
        lines.append("\n📋 我准备做这些（还没执行）：")
        lines += [f"{i}. {a.desc}" for i, a in enumerate(p.actions, 1)]
        lines.append("\n👉 回复「好」全部执行；只做几件回「好 1 3」；回「不要」取消（30 分钟内）")
    return "\n".join(lines).strip()


async def execute(store: KBStore, llm: LLM, settings: Any, actions: list[Action], by: int, by_name: str) -> list[str]:
    """一件件做，一件失败不影响别的。返回每件的结果"""
    from . import review, sync
    from .cluster import link_similar
    from .store import BY_QQ

    out: list[str] = []
    for a in actions:
        p = a.params
        try:
            if a.kind in ("add_entry", "edit_entry"):
                if a.kind == "add_entry":
                    eid, _ = await asyncio.to_thread(
                        store.upsert_entry, question=p["question"], answer=p["answer"], aliases="\n".join(p["aliases"]),
                        by=by, source=BY_QQ, merge_aliases=True,
                    )
                else:
                    e = await asyncio.to_thread(store.get_entry, p["id"])
                    if e is None:
                        out.append(f"❌ #{p['id']} 已经不在了")
                        continue
                    eid, _ = await asyncio.to_thread(
                        store.upsert_entry, question=e.question, answer=p["answer"], aliases=e.aliases, source=BY_QQ, entry_id=e.id,
                    )
                entry = await asyncio.to_thread(store.get_entry, eid)
                if a.kind == "add_entry" and entry is not None:
                    vecs = await llm.embed(entry.phrasings)
                    await asyncio.to_thread(store.set_entry_vecs, eid, list(zip(entry.phrasings, vecs)))
                    await asyncio.to_thread(link_similar, store, eid, vecs, settings.cluster_score)
                await asyncio.to_thread(store.audit, "加" if a.kind == "add_entry" else "改", eid, entry.question if entry else "", by, by_name)
                out.append(f"✅ 标准答案 #{eid}「{_clip(entry.question if entry else '', 24)}」{'加好了' if a.kind == 'add_entry' else '改好了'}")
            elif a.kind == "delete_entry":
                e = await asyncio.to_thread(store.get_entry, p["id"])
                ok = await asyncio.to_thread(store.delete_entry, p["id"])
                if ok:
                    await asyncio.to_thread(store.audit, "删", p["id"], e.question if e else "", by, by_name)
                out.append(f"✅ 删了标准答案 #{p['id']}" if ok else f"❌ #{p['id']} 已经不在了")
            elif a.kind == "edit_memory":
                await asyncio.to_thread(store.update_memory, p["id"], answer=p["answer"], staff_id=by, staff_name=f"{by_name or by}改过")
                out.append(f"✅ 记忆 #{p['id']} 改好了")
            elif a.kind == "delete_memory":
                ok = await asyncio.to_thread(store.delete_memory, p["id"])
                out.append(f"✅ 记忆 #{p['id']} 删了" if ok else f"❌ 记忆 #{p['id']} 已经不在了")
            elif a.kind == "accept_draft":
                await asyncio.to_thread(store.reopen_draft, p["id"])  # 被删掉（拒掉）的草稿先放回待审
                said = await review.accept(store, llm, settings, p["id"], by, answer=p["answer"], by_name=by_name)
                out.append("✅ " + said.split("\n")[0])
            elif a.kind == "notice":
                n = await asyncio.to_thread(notice.put, store, p["text"], timedelta(hours=p["hours"]), by)
                out.append(f"✅ 临时口径挂上了，到 {n.until:%m-%d %H:%M} 自动撤")
        except (review.DraftError, LLMError) as e:
            out.append(f"❌ {a.desc[:20]}…：{e}")
        except Exception as e:  # noqa: BLE001
            log.exception("管理员大白话执行出错：%s", a.desc)
            out.append(f"❌ {a.desc[:20]}…出错了（{type(e).__name__}）")
    if any(a.kind in ("add_entry", "edit_entry", "delete_entry", "accept_draft") for a in actions):
        await asyncio.to_thread(sync.write, store)
    log.info("%s 大白话执行了 %d 件：%s", by_name or by, len(actions), "；".join(out))
    return out


__all__ = ["DR_PENDING", "Action", "AssistantError", "Plan", "check", "execute", "plan", "preview"]
