"""私聊发给机器人的聊天记录 / 合并转发 → 拆开成一段对话 → 交给 learn_chat 整理成标准答案草稿。

2026-10-15 管理员改的需求（原话「我设置管理员给当前这个qq号发聊天记录和合并记录的时候自己拆开解析
不需要上传截图」）：不走 6099 上传，超管和自己人**私聊**把群里的聊天记录转发给机器人就行。

能收的三种：
- 合并转发（消息段 type=forward）：NapCat 的 get_forward_msg 拉出里面每一条；转发里套转发的往下拆，最多 MAX_DEPTH 层。
- 记录里带的图：看图模型抄出图里的字（报错截图、聊天截图都可能），每条记录最多看 MAX_IMAGES 张。
- 直接私聊发的聊天截图：当整张聊天记录抄（learn_chat.transcribe）。

**谁是客服怎么认**（转发记录里的 user_id 靠不住：实测 10-15 一段转发里两个不同昵称的人 user_id 一样，
是 NapCat 填的转发者）：
1. user_id 是超管 / 自己人 / 机器人自己 → 客服；
2. 昵称跟最近群里出现过的自己人昵称对得上 → 客服；
3. 都认不出时让模型按说话内容判谁是客服（谁在回答别人的问题、介绍怎么用），判不出就告诉他认不出。
认错了的后果只是草稿起得不准，草稿一律要他确认才生效。
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from . import learn_chat
from .llm import LLM, LLMError

log = logging.getLogger(__name__)

MAX_DEPTH = 3
MAX_MESSAGES = 600
MAX_IMAGES = 20
IMAGE_PROMPT = (
    "这是客服群聊天记录里的一张图。把图里的文字原样抄出来（报错原文、错误码、模型名、提示语、聊天内容都抄），"
    "最后用一句话说这张图在讲什么。不超过 300 字，不要开场白。"
)

_GUESS_SYSTEM = (
    "下面是一段客服群的聊天记录，每行「昵称：说的话」。判断哪些昵称是**我们的客服**"
    "（在回答别人的问题、介绍产品怎么用、给出处理办法、昵称像客服 / 管理员 / AI 助手），其余是客户。"
    '只输出 JSON：{"staff": ["昵称1", "昵称2"]}，一个都判断不出就 {"staff": []}。'
)


@dataclass
class Line:
    name: str
    user_id: int
    text: str
    images: list[str]


CallApi = Callable[..., Awaitable[Any]]


def has_record(segments: Iterable[dict]) -> bool:
    return any(s.get("type") == "forward" for s in segments)


def image_urls(segments: Iterable[dict]) -> list[str]:
    out = []
    for s in segments:
        d = s.get("data") or {}
        if s.get("type") == "image" and d.get("url") and str(d.get("sub_type", 0)) != "1":
            out.append(str(d["url"]))
    return out


def _text(segments: Iterable[dict]) -> str:
    parts = []
    for s in segments:
        t, d = s.get("type"), s.get("data") or {}
        if t == "text":
            parts.append(str(d.get("text", "")))
        elif t == "at":
            parts.append(f"@{d.get('name') or d.get('qq', '')} ")
        elif t == "face":
            parts.append("[表情]")
        elif t == "image":
            parts.append("[表情]" if str(d.get("sub_type", 0)) == "1" else "[图片]")
        elif t == "file":
            parts.append(f"[文件 {d.get('file', '')}]")
    return "".join(parts).strip()


async def flatten(call_api: CallApi, segments: list[dict], *, depth: int = 0, out: list[Line] | None = None) -> list[Line]:
    """把一条消息里的合并转发拆成一行行发言（套娃的往下拆）"""
    out = [] if out is None else out
    for seg in segments:
        if seg.get("type") != "forward" or len(out) >= MAX_MESSAGES:
            continue
        if depth >= MAX_DEPTH:
            out.append(Line("（转发套得太深，没再往下拆）", 0, "", []))
            continue
        d = seg.get("data") or {}
        nodes = d.get("content")
        if not isinstance(nodes, list):
            fid = d.get("id")
            if not fid:
                continue
            try:
                got = await call_api("get_forward_msg", message_id=fid, id=fid)
            except Exception as e:  # noqa: BLE001 —— 一条拆不开不连累别的
                log.warning("拆合并转发 %s 失败：%s", fid, e)
                out.append(Line("（有一段转发拆不开）", 0, "", []))
                continue
            nodes = (got or {}).get("messages") or []
        for node in nodes:
            if len(out) >= MAX_MESSAGES:
                break
            sender = node.get("sender") or {}
            name = str(sender.get("card") or sender.get("nickname") or node.get("user_id") or "?")
            msg = node.get("message") or node.get("content") or []
            if isinstance(msg, str):
                msg = [{"type": "text", "data": {"text": msg}}]
            body = _text(msg)
            if body or image_urls(msg):
                out.append(Line(name, int(sender.get("user_id") or node.get("user_id") or 0), body, image_urls(msg)))
            if has_record(msg):
                await flatten(call_api, msg, depth=depth + 1, out=out)
    return out


async def describe_images(
    lines: list[Line], llm: LLM, *, model: str, fetch: Callable[[str], Awaitable[tuple[bytes, str] | None]],
) -> int:
    """把记录里的图抄成字，接在那一行后面。返回看了几张"""
    seen = 0
    for ln in lines:
        for url in ln.images:
            if seen >= MAX_IMAGES:
                ln.text += "（[图片] 太多了没看）"
                continue
            got = await fetch(url)
            if got is None:
                continue
            seen += 1
            try:
                desc = await llm.read_image(got[0], got[1], model=model, prompt=IMAGE_PROMPT)
            except LLMError as e:
                log.warning("聊天记录里的图看不了：%s", e)
                continue
            ln.text = ln.text.replace("[图片]", "", 1).strip()
            ln.text = f"{ln.text}（图里写着：{' '.join(desc.split())[:300]}）".strip()
    return seen


async def guess_staff(llm: LLM, lines: list[Line]) -> set[str]:
    from .review import parse_json

    sample = "\n".join(f"{ln.name}：{ln.text}" for ln in lines if ln.text)[:6000]
    if not sample:
        return set()
    try:
        raw = await llm.chat([{"role": "system", "content": _GUESS_SYSTEM}, {"role": "user", "content": sample}], temperature=0, max_tokens=600)
    except LLMError as e:
        log.warning("判断谁是客服失败：%s", e)
        return set()
    names = (parse_json(raw) or {}).get("staff") or []
    return {str(x).strip() for x in names if str(x).strip()}


def render(lines: list[Line], *, staff_ids: frozenset[int], staff_names: set[str]) -> str:
    out = []
    for ln in lines:
        if not ln.text:
            continue
        tag = learn_chat.STAFF_TAG if (ln.user_id and ln.user_id in staff_ids) or ln.name in staff_names else learn_chat.CUSTOMER_TAG
        out.append(f"{tag}{ln.name}：{ln.text}")
    return "\n".join(out)


async def to_dialog(
    lines: list[Line], llm: LLM, *, staff_ids: frozenset[int], known_names: set[str],
) -> tuple[str, set[str]]:
    """拆好的发言 → 带【客服】【客户】的对话。返回 (对话, 认成客服的昵称)"""
    names = {ln.name for ln in lines if (ln.user_id and ln.user_id in staff_ids) or ln.name in known_names}
    if not names:
        names = await guess_staff(llm, lines)
        names &= {ln.name for ln in lines}
    return render(lines, staff_ids=staff_ids, staff_names=names), names


async def gather_images(urls: list[str], fetch: Callable[[str], Awaitable[tuple[bytes, str] | None]]) -> list[tuple[bytes, str]]:
    got = await asyncio.gather(*(fetch(u) for u in urls[:MAX_IMAGES]))
    return [g for g in got if g is not None]
