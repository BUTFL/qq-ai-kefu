"""资料站变了没有：夜里**只看、不换**，变了就在日报里说一声，要不要重抓你定。

**不自动重抓，这是你定的**（进度.md 第五节：「先不抓，我手回」「不要重抓 fetch_docs.py，
不要重跑 ingest」）。所以这里只做一件事：把线上 llms-full.txt 拉下来算个 sha256，
跟 knowledge/lmuai-docs.meta.json 里记的那次比。**不写 knowledge/、不碰库、不改 meta**。

变了的话，再粗算一下「哪几页变了」「哪几条标准答案里的链接指向变了的页」，
让你一眼看出值不值得重抓。算法很土：按 `# 标题` 切页，每页算个 hash 比对。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .store import ROOT, KBStore

log = logging.getLogger(__name__)

META = ROOT / "knowledge" / "lmuai-docs.meta.json"
LOCAL = ROOT / "knowledge" / "lmuai-docs.txt"
# 跟 scripts/fetch_docs.py 的 MIN_CHARS 一个意思：拉回来太短就当站点出事了，不下结论
MIN_CHARS = 50_000

_PAGE = re.compile(r"^# (.+)$", re.M)
_URL_LINE = re.compile(r"^URL:\s*(\S+)", re.M)


@dataclass
class DocDiff:
    changed: bool = False
    error: str = ""
    fetched_chars: int = 0
    pages_changed: list[str] = field(default_factory=list)  # 标题
    pages_added: list[str] = field(default_factory=list)
    pages_removed: list[str] = field(default_factory=list)
    entries_hit: list[tuple[int, str]] = field(default_factory=list)  # 答案里的链接指向变了的页


def pages(text: str) -> dict[str, tuple[str, str]]:
    """{标题: (这页的 URL, 这页内容的 hash)}。同名标题后面的覆盖前面的，够用"""
    out: dict[str, tuple[str, str]] = {}
    heads = list(_PAGE.finditer(text))
    for i, m in enumerate(heads):
        body = text[m.end(): heads[i + 1].start() if i + 1 < len(heads) else len(text)]
        u = _URL_LINE.search(body)
        out[m.group(1).strip()] = (u.group(1) if u else "", hashlib.sha1(body.strip().encode()).hexdigest())
    return out


def compare(old_text: str, new_text: str, entries: list[tuple[int, str]]) -> DocDiff:
    """纯函数。entries = [(答案 id, 答案正文)]"""
    d = DocDiff(changed=True, fetched_chars=len(new_text))
    old, new = pages(old_text), pages(new_text)
    d.pages_added = sorted(set(new) - set(old))
    d.pages_removed = sorted(set(old) - set(new))
    d.pages_changed = sorted(t for t in set(old) & set(new) if old[t][1] != new[t][1])
    urls = {old[t][0] for t in d.pages_changed + d.pages_removed if old[t][0]}
    for eid, answer in entries:
        if any(u and u in answer for u in urls):
            d.entries_hit.append((eid, answer[:30]))
    return d


async def check(store: KBStore) -> DocDiff:
    try:
        meta = json.loads(META.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return DocDiff(error=f"读不到 {META.name}（{type(e).__name__}）")
    url = meta.get("url") or "https://docs.lmuai.com/llms-full.txt"
    try:
        async with httpx.AsyncClient(timeout=60, trust_env=False, headers={"User-Agent": "Mozilla/5.0 (lingmou-bot docwatch)"}) as c:
            resp = await c.get(url)
            resp.raise_for_status()
            text = resp.text
    except httpx.HTTPError as e:
        return DocDiff(error=f"拉不到文档站（{type(e).__name__}）")
    if len(text) < MIN_CHARS:
        return DocDiff(error=f"只拉到 {len(text)} 字，站点可能出事了，不下结论")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() == meta.get("sha256"):
        return DocDiff(changed=False, fetched_chars=len(text))
    try:
        old = LOCAL.read_text(encoding="utf-8")
    except OSError:
        return DocDiff(changed=True, fetched_chars=len(text), error="本地没有旧文档，比不出哪几页变了")
    entries = [(e.id, e.answer) for e in await asyncio.to_thread(store.entries)]
    d = await asyncio.to_thread(compare, old, text, entries)
    log.info("文档站变了：改 %d 页、新增 %d、删 %d，影响标准答案 %d 条",
             len(d.pages_changed), len(d.pages_added), len(d.pages_removed), len(d.entries_hit))
    return d


def render(d: DocDiff, fetched_at: str) -> str:
    if d.error and not d.changed:
        return f"\n📄 文档站今晚没查成：{d.error}"
    if not d.changed:
        return ""  # 没变就不占日报一行
    out = [f"\n📄 文档站跟 {fetched_at[:10]} 抓的那份不一样了（没自动重抓，你说抓才抓）："]
    if d.pages_added:
        out.append(f" 新增 {len(d.pages_added)} 页：{'、'.join(d.pages_added[:5])}")
    if d.pages_changed:
        out.append(f" 改了 {len(d.pages_changed)} 页：{'、'.join(d.pages_changed[:5])}")
    if d.pages_removed:
        out.append(f" 删了 {len(d.pages_removed)} 页：{'、'.join(d.pages_removed[:5])}")
    if d.entries_hit:
        out.append(" 这几条标准答案里的链接指向变了的页，看看还对不对：" + "、".join(f"#{i}" for i, _ in d.entries_hit[:6]))
    if d.error:
        out.append(f" （{d.error}）")
    return "\n".join(out)


def fetched_at() -> str:
    try:
        return json.loads(META.read_text(encoding="utf-8")).get("fetched_at", "")
    except (OSError, ValueError):
        return ""
