"""把 `notice.bot_offline` 接上 `bot/health.py` 的标记文件。

**为什么单独一个处理器、而不是塞进 `bot/watchdog.py`**：

1. `watchdog.py` 判的是「连接层」——心跳停了、或者心跳里 `online=false`。还有一种它
   判不出来的情况：WebSocket 还通着、心跳照来，但 QQ 登录态已经被服务端作废了。
   `notice.bot_offline` 是这类问题**唯一直接、明确的信号**，扔了可惜。
2. 落盘的那份标记是给**宿主机上的守护进程**（`scripts/napcat_guard.py`）读的。
   它是另一个进程、另一个地址空间，`watchdog.py` 的内存状态它看不见。
3. `watchdog.py` 有一段很细的静默检测逻辑（白天 90 分钟没消息才报），那是「事后知道
   掉过」的口径。这里只管一件事：**掉登录的第一秒就把消息递出去**。两件事混在一个类里，
   以后改哪个都会碰坏另一个。

**为什么 `handlers/` 底下刚好合适**：所有 `@dispatcher.on` 处理器都在这个包里，
`bot/__main__.py` 逐个头文件似的 `register(...)` 一遍。这个文件不改任何状态机、
不发任何消息，只是「把事件翻译成文件标记」，所以它比 `watchdog.py` 轻得多，
也不占一条后台任务。

接线三条（设计规格第六节）：

    ① notice.bot_offline              → mark_offline(事件里的 message)
    ② 收到任何群消息 / 私聊消息         → mark_online()
    ③ 心跳里 status.online 为真        → mark_online()

**②③ 为什么这么写**：标记的语义是「刚刚还掉着」。只要有任何证据证明 QQ 这头在正常
收发（进来一条消息、或者心跳自己说 online），就该把标记撤掉，否则守护进程会一直以为
在掉线、白重启 NapCat。**反过来不要用 notice/request 来撤标记**：入群申请、撤回通知
这些在掉登录的瞬间也可能从缓冲里冒出来，不如「真的收到一条消息」实在。
"""
from __future__ import annotations

import logging

from .. import health
from ..dispatcher import Dispatcher
from ..events import MetaEvent, NoticeEvent

log = logging.getLogger(__name__)


def register(dispatcher: Dispatcher) -> None:
    """挂三个处理器。不需要 settings：这是健康信号，不是业务动作，任何模式下都该记。"""

    @dispatcher.on("notice.bot_offline")
    async def on_bot_offline(ev: NoticeEvent) -> None:
        """NapCat 说「你的账号当前登录已失效，请重新登录」。

        真实事件的原文（`logs/bot.log` 2026-11-09 00:36:04）：

            {'time': 1794155764, 'self_id': 10000000001, 'post_type': 'notice',
             'notice_type': 'bot_offline', 'user_id': 10000000001, 'tag': '下线通知',
             'message': '你的账号当前登录已失效，请重新登录。'}

        几个细节：
        - `events.parse` 把它解析成通用的 `NoticeEvent`，`key` 正好是
          `notice.bot_offline`——**分发器按 key 前缀匹配，所以这个装饰器能命中，
          `events.py` 一个字都不用改**。
        - 文案在 `raw["message"]` 里。`NoticeEvent` 没给 `message` 单独建字段
          （那个类只建模了 group_id / user_id / sub_type），为了这一个事件去改
          数据结构不值当，这里直接读 raw。
        - 这条事件之后大约 4 秒 WebSocket 就断了、重连拿到 Errno 111
          （同一条日志链里看得到），所以**别指望在这之后还能补发什么 QQ 消息**。
          这也是为什么真正的报警通道在宿主机上、不依赖 QQ。
        """
        raw = ev.raw or {}
        reason = str(raw.get("message") or raw.get("comment") or raw.get("tag") or "")
        health.mark_offline(reason)
        # 这条日志是事故复盘时的第一现场，**别省**：谁在什么时刻掉的、原话是什么
        log.error("收到 notice.bot_offline（%s）——已写掉线标记给宿主机守护进程", reason or "没带原因")

    @dispatcher.on("message")
    async def on_any_message(ev: object) -> None:
        """群消息、私聊消息都算「QQ 这头在正常收发」。按前缀注册，`message.group`
        和 `message.private` 都会命中（分发器会逐段匹配 key 的前缀）。"""
        health.mark_online()

    @dispatcher.on("meta_event.heartbeat")
    async def on_heartbeat(ev: MetaEvent) -> None:
        """心跳里 `status.online` 为真 = QQ 在线，撤标记。

        字段缺失/改名一律**不当成在线**（`online is not None and online`）——
        没有证据就别乱撤标记，否则标记会被一个字段缺失的心跳悄悄抹掉。
        """
        if ev.status.get("online"):
            health.mark_online()
