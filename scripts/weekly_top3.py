# -*- coding: utf-8 -*-
"""每周总结群里问得最多的 3 个问题 → 生成社区帖子草稿（先给老板看，别直接发）。

数据来源（容器内 /app/data/qa.db）：
  group_msgs  客户原话（role='customer'，含没 @ 机器人的）
  qa_log      机器人答过的问法
做法：每条问题用 embedding 归到知识库最相近的一条上（就是「话题」），按条数排前三；
      每个话题附 3 条原话 + 知识库里的标准答法，拼成 Markdown 草稿。
用法：python3 scripts/weekly_top3.py [天数=7] [--out 路径]
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, "/app")

from bot.config import Settings
from bot.kb.llm import LLM
from bot.kb.store import KBStore
from bot.kb.answer import Answerer

DB = "/app/data/qa.db"
NOISE = re.compile(r"^\[(图片|视频|语音|表情)\]$|^[\W_]+$|^(在吗|你好|hi|hello|1|？|\?)+$", re.I)
GROUP_NAME = {
    2000000001: "售前4", 2000000002: "售后9", 2000000003: "售后10",
}


def load_questions(days: int) -> list[tuple[str, int, str]]:
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    c = sqlite3.connect(DB)
    rows: list[tuple[str, int, str]] = []
    for body, gid, ts in c.execute(
        "SELECT body, group_id, created_at FROM group_msgs "
        "WHERE role='customer' AND created_at > ? ORDER BY id", (since,)
    ):
        b = (body or "").strip()
        if 4 <= len(b) <= 150 and not NOISE.search(b):
            rows.append((b, gid, ts))
    seen = {(b, t) for b, _, t in rows}
    for q, gid, ts in c.execute(
        "SELECT question, group_id, created_at FROM qa_log WHERE created_at > ?", (since,)
    ):
        q = (q or "").strip()
        if 4 <= len(q) <= 150 and not NOISE.search(q) and (q, ts) not in seen:
            rows.append((q, gid, ts))
    c.close()
    return rows


async def main() -> None:
    days = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 7
    out_path = None
    if "--out" in sys.argv:
        out_path = Path(sys.argv[sys.argv.index("--out") + 1])

    s = Settings.load()
    store = KBStore()
    llm = LLM(s.chat_base_url, s.chat_api_key, chat_model=s.chat_model,
              embed_model=s.embedding_model, embed_base_url=s.llm_base_url,
              embed_api_key=s.llm_api_key, thinking=s.llm_thinking)
    ans = Answerer(store, llm, s)

    rows = load_questions(days)
    print(f"近 {days} 天候选问题 {len(rows)} 条")

    buckets: dict[int, list[tuple[str, int, str]]] = defaultdict(list)
    misses: list[str] = []
    vecs = []
    BATCH = 10                       # 一批 10 条，别触发分组的每分钟限流
    for i in range(0, len(rows), BATCH):
        chunk = [b for b, _, _ in rows[i:i + BATCH]]
        for attempt in range(4):
            try:
                vecs.extend(await llm.embed(chunk))
                break
            except Exception as e:
                if '429' not in str(e) or attempt == 3:
                    raise
                await asyncio.sleep(8 * (attempt + 1))
        await asyncio.sleep(3)
    for (body, gid, ts), vec in zip(rows, vecs):
        hit = await ans.retriever.best_entry(body, vec)
        if hit and hit.score >= 0.80:
            buckets[hit.entry_id].append((body, gid, ts))
        else:
            misses.append(body)

    ranked = sorted(buckets.items(), key=lambda kv: -len(kv[1]))[:3]
    period = f"{(datetime.now() - timedelta(days=days)):%Y-%m-%d} ~ {datetime.now():%Y-%m-%d}"
    lines = [f"# 本周群里问得最多的 3 个问题（{period}）", "",
             f"> 样本：近 {days} 天群内客户提问 {len(rows)} 条（含没 @ 机器人的），"
             f"其中 {len(rows) - len(misses)} 条能归到已有知识库话题。自动生成，发之前人工过一遍。", ""]
    for i, (eid, items) in enumerate(ranked, 1):
        e = store.get_entry(eid)
        lines.append(f"## {i}. {e.question if e else f'#{eid}'}（{len(items)} 次）")
        for b, gid, ts in items[:3]:
            lines.append(f"- {ts[:10]} [{GROUP_NAME.get(gid, gid)}] {b}")
        if e:
            first = e.answer.strip().splitlines()[0]
            lines.append(f"- 标准答法：{first[:120]}")
        lines.append(f"- 知识库条目：#{eid}")
        lines.append("")
    if misses:
        lines += ["## 没归类的问法（人工看看要不要补条目）", ""]
        lines += [f"- {m}" for m in misses[:10]] + [""]
    draft = "\n".join(lines)

    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(draft)
        print(f"草稿 → {out_path}")
    print("\n" + draft)
    store.close()


asyncio.run(main())
