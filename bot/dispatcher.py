"""事件分发。

处理器按 key 前缀注册："message" 收所有消息，"message.group" 只收群消息，
"request.group.add" 只收入群申请。一个事件能命中多个处理器，各自跑独立 task，
谁报错谁记日志，不影响别人，更不会拖垮读循环。
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable

from . import events
from .events import Event, GroupMessage, MetaEvent, PrivateMessage

log = logging.getLogger(__name__)

Handler = Callable[[Any], Awaitable[None]]


class Dispatcher:
    def __init__(self) -> None:
        self._handlers: dict[str, list[Handler]] = defaultdict(list)
        self._tasks: set[asyncio.Task[None]] = set()

    def on(self, key: str) -> Callable[[Handler], Handler]:
        """装饰器：@dispatcher.on("message.group")"""

        def register(fn: Handler) -> Handler:
            self._handlers[key].append(fn)
            return fn

        return register

    async def dispatch(self, raw: dict[str, Any]) -> None:
        """给 OneBotClient 当 on_event 回调用。必须快速返回，所以处理器都扔进 task。"""
        try:
            event = events.parse(raw)
        except (KeyError, ValueError, TypeError) as e:
            log.warning("事件解析失败 (%s): %s", e, raw)
            return
        self._log(event)

        parts = event.key.split(".")
        for depth in range(1, len(parts) + 1):
            for fn in self._handlers.get(".".join(parts[:depth]), ()):
                task = asyncio.create_task(self._guard(fn, event), name=f"handler:{fn.__name__}")
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)

    @staticmethod
    async def _guard(fn: Handler, event: Event) -> None:
        try:
            await fn(event)
        except Exception:
            log.exception("处理器 %s 处理 %s 时出错", fn.__qualname__, event.key)

    @staticmethod
    def _log(event: Event) -> None:
        if isinstance(event, GroupMessage):
            log.info("群 %s | %s(%s): %s", event.group_id, event.sender_name, event.user_id, event.plain_text or event.raw_message)
        elif isinstance(event, PrivateMessage):
            log.info("私聊 | %s(%s): %s", event.sender_name, event.user_id, event.plain_text or event.raw_message)
        elif isinstance(event, MetaEvent):
            log.debug("meta %s %s", event.meta_event_type, event.sub_type)
        else:
            log.info("事件 %s: %s", event.key, event.raw)
        log.debug("原文: %s", event.raw)
