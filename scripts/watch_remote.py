"""实时盯屏：对着被控机器连续截图，存盘 + 标出哪几帧画面变了。

    uv run scripts/watch_remote.py --code 399999003 --seconds 20 --interval 1.5

为什么要它：远程排查时最缺的是"现在屏幕上到底在发生什么" —— 单张截图只能看到某一瞬，
而这一步（比如分组红字消失没、弹窗开了没、toast 弹出来没）常常是瞬时的。
每帧存到 data/live/<时间>/，文件名带内容指纹；画面变了打 ★，方便回头只看那几帧。
"""
from __future__ import annotations
import asyncio, hashlib, pathlib, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot.config import Settings  # noqa: E402
from bot.remote import RemoteOperator, for_provider, pick  # noqa: E402
from bot.remote.assist import shot_bytes  # noqa: E402


def flag(name: str, default: str = "") -> str:
    a = sys.argv[1:]
    if name in a:
        i = a.index(name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


async def main() -> None:
    code = flag("--code", "399999003")
    seconds = float(flag("--seconds", "20"))
    interval = float(flag("--interval", "1.5"))
    s = Settings.load(); p = pick(s.remote_provider)
    url, token = (s.awesun_mcp_url, s.awesun_api_token) if p.key == "awesun" else (s.todesk_mcp_url, s.todesk_mcp_token)
    c = for_provider(p, url=url, token=token, transport=s.remote_transport)
    await c.connect()
    op = RemoteOperator(c, provider=p, actor="实时盯屏")
    sess = await op.start_session(op.session(code, customer="盯屏", approved_by="大哥授权验证").session)
    root = ROOT / "data" / "live" / time.strftime("%H%M%S")
    root.mkdir(parents=True, exist_ok=True)
    try:
        await op.connect(sess)
        print(f"开始盯屏 {seconds:.0f} 秒（每 {interval}s 一帧）→ {root}")
        prev, n, changed = None, 0, []
        end = time.time() + seconds
        while time.time() < end:
            shot = await op.screenshot(sess)
            d = shot_bytes(shot)
            if d:
                h = hashlib.sha1(d).hexdigest()[:8]
                f = root / f"f{n:03d}-{h}.jpg"
                f.write_bytes(d)
                tag = "首帧" if prev is None else ("★变了" if h != prev else "＝没变")
                if tag == "★变了":
                    changed.append(f.name)
                print(f"  {time.strftime('%H:%M:%S')}  {f.name}  {len(d):>7}B  {tag}")
                prev = h; n += 1
            await op.wait(sess, int(interval * 1000))
        print(f"\n共 {n} 帧，画面变化 {len(changed)} 次：{', '.join(changed) if changed else '（整段没变）'}")
    finally:
        try:
            await op.close_session(sess)
        except Exception:
            pass
        await c.aclose()


asyncio.run(main())
