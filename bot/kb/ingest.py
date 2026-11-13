"""把 knowledge/ 里的资料切块、算向量、入库。

    uv run -m bot.kb.ingest           # 只导入变过的文件
    uv run -m bot.kb.ingest --force   # 全部重来（换了 embedding 模型时用）
    uv run -m bot.kb.ingest --dry     # 只切块看看，不花钱不写库

**按 sha1 跳过没变的文件**：资料不常改，但你会为了别的事重跑这个命令。
21.7 万字切出 900 多块，全量重算一次是 900 多条 embedding 请求，
没必要每次都烧。文件内容一个字没动就直接跳过。

**换了 EMBEDDING_MODEL 必须 --force**。维度对不上时检索会直接抛
DimensionMismatch 把问答降级（见 retrieve.py），不会悄悄按错分数回答，
但你得自己重跑一遍才能恢复。

只读纯文本（.txt/.md）。目前资料就是灵眸文档站的 llms-full.txt，
pdf/docx 等真有了再加——现在加就是写了没人用的代码。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import sys
import time
from pathlib import Path

from ..config import ConfigError, Settings
from .llm import LLM, LLMError
from .store import KBStore
from .text import split_doc

log = logging.getLogger("ingest")

ROOT = Path(__file__).resolve().parent.parent.parent
KNOWLEDGE = ROOT / "knowledge"
SUFFIXES = {".txt", ".md", ".markdown"}


def sources(folder: Path = KNOWLEDGE) -> list[Path]:
    """资料文件列表。`.meta.json` 那类附属文件不算，隐藏文件也不算。"""
    if not folder.exists():
        return []
    return sorted(
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in SUFFIXES and not p.name.startswith(".")
    )


def sha1(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


async def ingest_file(store: KBStore, llm: LLM, path: Path, *, force: bool = False) -> tuple[str, int]:
    """导入一份文件。返回 (状态, 块数)，状态是 新增/更新/跳过。"""
    rel = path.relative_to(ROOT).as_posix()
    digest = sha1(path)
    if not force and store.doc_sha1(rel) == digest:
        return "跳过", 0

    content = path.read_text(encoding="utf-8", errors="replace")
    blocks = split_doc(content, source=path.stem)
    if not blocks:
        log.warning("%s 切不出任何内容，跳过", rel)
        return "跳过", 0

    t0 = time.monotonic()
    vecs = await llm.embed([f"{b.title}\n{b.body}" for b in blocks])
    known = store.doc_sha1(rel) is not None
    n = store.replace_doc(
        rel, digest, len(content),
        [(b.title, b.body, b.url, v) for b, v in zip(blocks, vecs)],
    )
    log.info("%s：%d 块，算向量用了 %.1f 秒", rel, n, time.monotonic() - t0)
    return ("更新" if known else "新增"), n


async def run(*, force: bool = False, dry: bool = False) -> int:
    files = sources()
    if not files:
        print(f"{KNOWLEDGE} 里没有资料文件（只认 {'/'.join(sorted(SUFFIXES))}）。")
        print("灵眸文档可以用 uv run scripts/fetch_docs.py 抓一份。")
        return 1

    if dry:
        # 不连网不写库：改完切块规则先用这个看一眼，比跑完再发现切坏了省事
        total = 0
        for path in files:
            blocks = split_doc(path.read_text(encoding="utf-8", errors="replace"), source=path.stem)
            with_url = sum(1 for b in blocks if b.url)
            sizes = sorted(len(b.body) for b in blocks)
            total += len(blocks)
            print(
                f"{path.name}：{len(blocks)} 块｜带链接 {with_url}"
                f"｜中位 {sizes[len(sizes) // 2]} 字｜最长 {sizes[-1]} 字"
            )
            for b in blocks[:3]:
                print(f"    · {b.title} — {b.body[:40].strip()}…")
        print(f"合计 {total} 块。这只是预览，没有写库。")
        return 0

    try:
        cfg = Settings.load()
    except ConfigError as e:
        print(f"配置有问题：{e}")
        return 2
    if not cfg.llm_ready:
        print("LLM_BASE_URL / LLM_API_KEY 还没配，没法算向量。")
        return 2

    store = KBStore()
    llm = LLM(cfg.llm_base_url, cfg.llm_api_key, chat_model=cfg.llm_model, embed_model=cfg.embedding_model)
    try:
        log.info("自检：%s", await llm.probe())
        done: list[str] = []
        for path in files:
            state, n = await ingest_file(store, llm, path, force=force)
            done.append(path.relative_to(ROOT).as_posix())
            print(f"[{state}] {path.name} {f'{n} 块' if n else ''}")
        for gone in store.drop_docs_except(done):
            print(f"[清掉] {gone}（文件已经不在了）")
    except LLMError as e:
        print(f"调中转站失败：{e}")
        return 3
    finally:
        await llm.close()

    print(f"库里现在有 {store.chunk_count()} 个资料块、{store.entry_count()} 条标准答案。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="把 knowledge/ 里的资料导入问答库")
    ap.add_argument("--force", action="store_true", help="忽略 sha1，全部重新算向量（换 embedding 模型后用）")
    ap.add_argument("--dry", action="store_true", help="只看切块效果，不连网不写库")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    # httpx 每次请求都打一行 INFO，导入几百块时会把真正的进度刷没
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return asyncio.run(run(force=args.force, dry=args.dry))


if __name__ == "__main__":
    sys.exit(main())
