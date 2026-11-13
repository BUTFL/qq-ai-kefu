"""试 AI 操作员的提示词：连一台机器，让视觉模型看屏幕、决定下一步。

    # 演练（默认）：只打印模型想做什么，**不动那台机器**
    uv run scripts/remote_auto_try.py --code 399999003 --task "把 Finder 窗口关掉"

    # 真做（会真的点/敲）
    uv run scripts/remote_auto_try.py --code 399999003 --task "..." --real

    # 想留每步的画面就加 --shots 目录（默认不存：模型看的是实时画面，不靠截图）
    uv run scripts/remote_auto_try.py --code 399999003 --task "..." --shots data/auto_shots

    # 实时画面多久一帧（默认跟 .env 的 REMOTE_LIVE_INTERVAL 一样）
    uv run scripts/remote_auto_try.py --code 399999003 --task "..." --interval 0.25

调提示词就在这里调：改 `bot/remote/assist.py` 的 `PLAN_PROMPT`，然后跑这个脚本看模型怎么反应。
生产那条路（`/连 编号 任务`）走的是同一份代码，这里跑得对，那边就对。
"""
from __future__ import annotations

import asyncio
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot.config import Settings  # noqa: E402
from bot.remote import RemoteOperator, for_provider, pick  # noqa: E402
from bot.remote.assist import AutoAssist, build_llm  # noqa: E402
from bot.remote.live import LiveScreen  # noqa: E402


def flag(name: str, default: str = "") -> str:
    args = sys.argv[1:]
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


async def main() -> int:
    code = flag("--code") or flag("--remote-id")
    task = flag("--task")
    real = "--real" in sys.argv
    steps = int(flag("--steps", "6"))
    shots = flag("--shots")
    shots_dir = pathlib.Path(shots) if shots else None
    if not code:
        print("要给出目标：--code 识别码（或 --remote-id）")
        return 2
    if not task:
        print("要给出任务：--task \"把中转站地址填好\"")
        return 2

    s = Settings.load()
    p = pick(s.remote_provider)
    url, token = (s.awesun_mcp_url, s.awesun_api_token) if p.key == "awesun" \
        else (s.todesk_mcp_url, s.todesk_mcp_token)
    model = s.remote_auto_model or s.vision_model
    print(f"目标 {code}｜模型 {model}（备用 {s.vision_fallback_model}）｜"
          f"最多 {steps} 步｜{'真做' if real else '演练（只看不动）'}")
    print(f"任务：{task}\n")

    client = for_provider(p, url=url, token=token, transport=s.remote_transport)
    await client.connect()
    op = RemoteOperator(client, provider=p, actor="提示词调试")
    session = await op.start_session(
        op.session(code, customer="调试机", approved_by="大哥授权验证").session
    )
    rc = 0
    llm = None
    screen = LiveScreen(op, session, interval=float(flag("--interval", str(s.remote_live_interval))))
    try:
        out = await op.connect(session)
        print(f"连上：{out.get('message') or out}")
        llm = build_llm(s)
        await screen.start()
        t0 = time.time()

        async def on_step(n: int, what: str) -> None:
            f = screen.latest()
            if shots_dir is not None and f is not None:
                shots_dir.mkdir(parents=True, exist_ok=True)
                p = shots_dir / f"step{n}-{time.strftime('%H%M%S')}.jpg"
                p.write_bytes(f.data)
                print(f"  第 {n} 步画面：{p}")
            print(f"  第 {n} 步（{time.time() - t0:.1f}s）：{what}")

        auto = AutoAssist(op, session, llm, model=model, fallback_model=s.vision_fallback_model,
                          task=task, max_steps=steps, dry_run=not real, on_step=on_step, screen=screen)
        summary = await auto.run()
        secs = time.time() - t0
        print(f"\n结果：{summary}")
        print(f"实时画面：{screen.frames} 帧 / {secs:.1f}s ≈ {screen.frames / secs:.1f} 帧/秒，拉帧出错 {screen.total_errors} 次")
    except Exception as e:
        print(f"\n❌ {type(e).__name__}: {e}")
        rc = 1
    finally:
        await screen.stop()
        try:
            await op.close_session(session)
        except Exception:
            pass
        await client.aclose()
        if llm is not None:
            try:
                await llm.close()
            except Exception:
                pass

    print(f"\n审计：data/remote_audit.jsonl")
    return rc


sys.exit(asyncio.run(main()))
