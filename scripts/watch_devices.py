"""盯设备上线：一直轮询向日葵的设备列表，谁上线了就打印一行。

大哥去开第二台机器时用它。跑起来就不用管了，上线那一刻会打出来。

    uv run scripts/watch_devices.py --every 60

只读接口（`device_search`），不动任何设备。看到上线就退出（默认），
加 `--keep` 就一直盯。
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from bot.remote import McpClient, for_provider, pick  # noqa: E402

load_dotenv(ROOT / ".env")


def _flag(args: list[str], name: str, default: str = "") -> str:
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


async def main() -> int:
    args = sys.argv[1:]
    every = float(_flag(args, "--every", "60"))
    keep = "--keep" in args
    # 本机不算：向日葵不让连本机（109 Cannot control local device）
    p = pick(_flag(args, "--provider", "awesun"))
    client = for_provider(p, url=os.environ.get(p.url_env, ""), token=os.environ.get(p.token_env, ""))

    await client.connect()
    print(f"[{time.strftime('%H:%M:%S')}] 开始盯 {p.label} 设备列表，每 {every:.0f} 秒一次", flush=True)

    seen: dict[str, bool] = {}
    try:
        while True:
            try:
                out = await client.call_tool(p.tool("listDevices"), {"keyword": "", "limit": 50})
            except Exception as e:
                print(f"[{time.strftime('%H:%M:%S')}] 读设备失败（继续盯）：{type(e).__name__}: {e}", flush=True)
                await asyncio.sleep(every)
                continue

            for d in out.get("devices") or []:
                name = str(d.get("name") or "")
                online = bool(d.get("online"))
                was = seen.get(name)
                if was is None:
                    if online:
                        print(f"[{time.strftime('%H:%M:%S')}] 一开始就在线：{name} "
                              f"识别码={d.get('fastcode') or '-'} remote_id={d.get('remote_id')}", flush=True)
                elif not was and online:
                    print(f"[{time.strftime('%H:%M:%S')}] 🔔 上线了：{name} "
                          f"识别码={d.get('fastcode') or '-'} remote_id={d.get('remote_id')}", flush=True)
                    if not keep:
                        return 0
                elif was and not online:
                    print(f"[{time.strftime('%H:%M:%S')}] 下线了：{name}", flush=True)
                seen[name] = online

            await asyncio.sleep(every)
    finally:
        await client.aclose()


sys.exit(asyncio.run(main()))
