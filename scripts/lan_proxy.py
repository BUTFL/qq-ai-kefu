"""局域网入口：把局域网来的 6099 / 8090 原样转给 napcat / bot 容器。**不看内容，只搬字节。**

2026-09-29 管理员要的「开一个当前局域网都可以访问」，选了「整个 6099 都开」「公司或家里自己的网」。

**为什么是个单独的转发，不是改 napcat 的端口映射**：napcat 的 ports 一改就得重建容器，
重建 = QQ 退登要扫码、客户群断线。这个转发是 compose 里另一个服务（`lan`），
起停都不碰 napcat，关掉就回到只有本机能开。

安全靠两层，都没变：
- 6099 要 WebUI 的密码登录（`WEBUI_TOKEN`），NapCat 自带每分钟限次（webui.json 的 loginRate）
- 8090 每个请求都拿 6099 发的凭证去问 NapCat 真假（bot/napcat_auth.py），Host / CORS 另外认局域网地址（`LAN_HOSTS`）

用法（compose 里已经写好）：python scripts/lan_proxy.py 6099=napcat:6099 8090=bot:8090
"""
from __future__ import annotations

import asyncio
import logging
import sys

log = logging.getLogger("lan")


async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            w.close()
        except (ConnectionError, OSError):
            pass


def handler(host: str, port: int):
    async def on_conn(cr: asyncio.StreamReader, cw: asyncio.StreamWriter) -> None:
        peer = cw.get_extra_info("peername")
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
        except (OSError, TimeoutError) as e:
            log.warning("%s → %s:%d 连不上：%s", peer, host, port, e)
            cw.close()
            return
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))

    return on_conn


async def main(specs: list[str]) -> None:
    servers = []
    for spec in specs:
        listen, target = spec.split("=", 1)
        host, port = target.rsplit(":", 1)
        srv = await asyncio.start_server(handler(host, int(port)), "0.0.0.0", int(listen))
        servers.append(srv)
        log.info("局域网 :%s → %s", listen, target)
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%m-%d %H:%M:%S")
    asyncio.run(main(sys.argv[1:] or ["6099=napcat:6099", "8090=bot:8090"]))
