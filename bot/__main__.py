"""入口：uv run -m bot

读配置 → 起日志 → 注册处理器 → 跑客户端，Ctrl-C / SIGTERM 干净退出。
退出码：0 正常 / 1 令牌被拒或客户端意外结束 / 2 配置错误 / 3 已经有一个在跑了
"""
from __future__ import annotations

import asyncio
import fcntl
import logging
import signal
import sys
from typing import IO

from . import log as logsetup, watchdog
from .config import ROOT, ConfigError, Settings
from .dispatcher import Dispatcher
from .handlers import admin, approval, health as health_hook, welcome
from .kb import wiring
from .onebot import AuthError, OneBotClient
from .remote import flow as remote_flow
from .store import Store

log = logging.getLogger("bot")

# 独占锁。开了自启之后，再手敲一次 `uv run -m bot` 就会有两个机器人连同一个
# NapCat：同一条入群申请批两次、新人欢迎两遍，而且两边日志都显示「正常」，
# 从日志里根本看不出是撞了。宁可让第二个直接起不来。
LOCK_PATH = ROOT / "data" / "bot.lock"


def _lock() -> IO[str] | None:
    """抢独占锁，抢不到返回 None。句柄要一直拿着，进程退出时内核自动放锁。"""
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fh = LOCK_PATH.open("w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


async def _run(settings: Settings, store: Store) -> int:
    dispatcher = Dispatcher()
    client = OneBotClient(settings.onebot_url, settings.onebot_token, dispatcher.dispatch)
    approval.register(dispatcher, client, settings, store)
    admin.register(dispatcher, client, settings, store)
    welcome.register(dispatcher, client, settings)
    # 掉登录信号（notice.bot_offline）→ data/health/qq_offline.json。
    # 这是给**宿主机上**的 scripts/napcat_guard.py 读的：QQ 掉登录时 WebSocket 可能
    # 还通着、心跳照来，光看连接层看不出来，而这条事件是最准的信号（见 bot/health.py）。
    # 它不碰配置、不发消息，所以不带 settings
    health_hook.register(dispatcher)
    watchdog.register(dispatcher, client, settings)
    # 阶段 5 AI 问答。故意不加 if：中转站没配、模型在黑名单里、库是空的，
    # setup 自己会记一条日志然后返回一个空壳，入群审批那些照常跑 ——
    # 不能因为问答起不来就让整个机器人起不来
    # 入群审批的库也交给它：8090 的「被封禁用户」页要读写 kicked 表
    qa = wiring.setup(dispatcher, client, settings, approval_store=store)
    # 远程协助（2026-10-16）。**没开 REMOTE_ENABLED 就是 None，一个处理器都不注册**，
    # 线上行为跟接线之前完全一样。红线：只有超管私聊 /连 之后才会连客户机器
    remote = remote_flow.register(dispatcher, client, settings)

    try:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)

        runner = asyncio.create_task(client.run(), name="onebot-client")
        waiter = asyncio.create_task(stop.wait(), name="stop-signal")
        done, _ = await asyncio.wait({runner, waiter}, return_when=asyncio.FIRST_COMPLETED)

        if runner in done:
            # 没人叫停它就自己结束了，只有令牌被拒这一种正常路径
            try:
                runner.result()
            except AuthError as e:
                log.error("%s —— 检查 .env 里的 ONEBOT_TOKEN 是否和 NapCat 配置一致", e)
            else:
                log.error("客户端意外结束")
            waiter.cancel()
            return 1

        log.info("收到退出信号，断开连接")
        await client.stop()
        await runner
        return 0
    finally:
        # 放 finally 是因为上面有两条 return，漏一条就会留下后台任务和没关的
        # HTTP 连接，退出时报一堆 "Task was destroyed but it is pending"
        if remote is not None:
            # 退出时把开着的远控会话断掉，别让客户电脑一直开着门
            await remote.close()
        await qa.close()


def main() -> int:
    try:
        settings = Settings.load()
    except ConfigError as e:
        print(f"配置错误: {e}", file=sys.stderr)
        return 2
    logsetup.setup(settings.log_level)
    holder = _lock()
    if holder is None:
        log.error("已经有一个机器人在跑了（%s 被占着），这个就不起了。要换成这个，先停掉那个", LOCK_PATH)
        return 3
    store = Store()
    log.info(
        "启动 | 演练模式=%s | 生效群=%s | 超管=%s | 答案前缀=%s | 待批 %d 条",
        settings.dry_run,
        ",".join(map(str, sorted(settings.enabled_groups))) or "全部",
        ",".join(map(str, sorted(settings.super_admins))) or "未配置",
        settings.approval_answer_prefix,
        store.pending_count(),
    )
    try:
        return asyncio.run(_run(settings, store))
    except KeyboardInterrupt:
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
