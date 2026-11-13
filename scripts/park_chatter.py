#!/usr/bin/env python3
"""把待办里的闲聊标成「不用答」，只留真问题（2026-09-30 管理员要的「只把寒暄那类清掉，排序不动」）。

起因：`/待办` 里有 170 多条，他打开看到的那一屏基本都不用管 —— 「你好」「起床啦」「吃饭了吗」
「明天天气怎么样」这些是 09-22~09-24 寒暄判别还没改好那几天留下的死数据（现在这类不再进待办了）。

怎么判：**逐条问模型「这句需不需要一条客服标准答案」**，不用关键词表。
关键词表这里不够用：「怎么把余额提现」「能寄快递吗」看着像闲聊，其实一个是真业务、一个该回「不寄」，
而「起床啦」「我不困」没有任何共同词面。**判不准就留着** —— 留一条没用的待办只是眼睛多扫一行，
错标一条真问题就是把客户的需求埋了。

**不删数据**，标 `resolved=1`（跟 `/忽略` 同一条路）：qa_log 还外键指着它，而且事后要看得出哪些被放过了。

用法（默认只看不改）：
    uv run scripts/park_chatter.py            # 列出会归档哪些，不动库
    uv run scripts/park_chatter.py --apply    # 真改库
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot.config import Settings
from bot.kb.llm import JUDGE_TOKENS, LLM
from bot.kb.store import KBStore

PARALLEL = 4
# 判几遍。**两遍都说「不用」才归档。**
# 09-30 实测同一批跑两次，结论差了一条：第二次把「问题是开了高也一点不给」（真的技术投诉）
# 也判成了闲聊。判断本身不稳，而错标一条真问题就是把客户的需求埋了，多花一倍调用换稳
PASSES = 2

JUDGE = """下面是客户在一个 API 中转服务的 QQ 客服群里说的一句话：

「{q}」

这句话需不需要客服准备一条标准答案？
- 在问业务（怎么充值、怎么配置、报错怎么解、发票、价格、退款、能不能用某个模型…）→ YES
- 就算听着像闲聊，但其实在问业务（「能寄快递吗」要回「我们不寄」，「你们几点上班」要回上班时间）→ YES
- 问怎么找到人、怎么联系客服、在哪提工单 → YES（这是要告诉他怎么找人，不是寒暄）
- 提到某个编辑器 / 客户端 / 工具名字，问它怎么用、怎么接（Cursor、Obsidian、ChatBox、VS Code…）→ YES
  （我们卖的就是给这些工具用的接口，「某某怎么用」永远是业务问题）
- 纯打招呼、寒暄、道谢、开玩笑、骂人、聊天气聊吃饭 → NO
- 没头没尾、脱离上下文完全看不出在问什么（「什么意思」「对吧」「还是不行」）→ NO
- 只是要转人工（「我要人工」「转人工」）→ NO

只回 YES 或 NO。"""


async def main() -> None:
    apply = "--apply" in sys.argv
    cfg = Settings.load()
    st = KBStore()
    with st._tx() as db:
        rows = db.execute(
            "SELECT id, label, asked FROM clusters WHERE entry_id IS NULL AND resolved=0 ORDER BY asked DESC, id"
        ).fetchall()
    print(f"待办 {len(rows)} 条，每条问 {PASSES} 遍「要不要标准答案」，两遍都说不用才归档（判不准就留着）…\n")
    llm = LLM(cfg.llm_base_url, cfg.llm_api_key, chat_model=cfg.review_model, embed_model=cfg.embedding_model)
    sem = asyncio.Semaphore(PARALLEL)
    junk: list[tuple[int, int, str]] = []

    async def one(r) -> None:  # noqa: ANN001
        async with sem:
            for _ in range(PASSES):
                try:
                    got = await llm.chat(
                        [{"role": "user", "content": JUDGE.format(q=r["label"][:200])}],
                        temperature=0, max_tokens=JUDGE_TOKENS,
                    )
                except Exception as e:  # noqa: BLE001 —— 判不出来就留着
                    print(f"  ! #{r['id']} 判不出来，留着：{type(e).__name__}")
                    return
                if not got.strip().upper().startswith("NO"):
                    return  # 有一遍说「要答案」就留着
            junk.append((r["id"], r["asked"], r["label"]))

    await asyncio.gather(*(one(r) for r in rows))
    await llm.close()

    junk.sort(key=lambda x: (-x[1], x[0]))
    print(f"要归档 {len(junk)} 条（累计被问 {sum(x[1] for x in junk)} 次），留下 {len(rows) - len(junk)} 条：\n")
    for cid, asked, label in junk:
        print(f"  [{cid}] {asked}次 {label[:44]}")
    if not apply:
        print("\n只是看看，库没动。要真改加 --apply")
    else:
        done = sum(await asyncio.gather(*(asyncio.to_thread(st.resolve_cluster, c) for c, _, _ in junk)))
        print(f"\n归档了 {done} 条。待办还剩 {len(rows) - done} 条。")
        print("看得回来：sqlite3 data/qa.db \"select id,label from clusters where resolved=1\"")
    st.close()


asyncio.run(main())
