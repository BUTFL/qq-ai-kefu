"""掉线了在 Mac 上弹通知，恢复了补一条 QQ 私聊。

**这不是实时告警，别当兜底用。** Mac 通知只有人在电脑前才看得见——合着盖子、
人不在座位上，掉线那条就白弹了。真正追得上人的是恢复之后补发的那条 QQ 私聊。
所以它的实际效果是「事后知道掉过、掉了多久」，不是「掉的当下找到你」。
文案和日志都按这个口径写，免得以后误以为有人替你盯着。

怎么判掉线——两个信号，都是现成的，`onebot.py` 一行没动：

1. NapCat 每 30 秒推一条 `meta_event.heartbeat`（配置里 `heartInterval=30000`）。
   连着几拍不来 = 要么 NapCat 挂了，要么 WebSocket 断了。
2. 心跳里带 `status.online`。**这条是专为开机那个场景留的** ——
   容器重启后 QQ 会退登（见 `进度.md` 第五节，这号不支持自动登录），
   那时 WebSocket 通着、心跳照来，但机器人其实是个哑巴。
   光数心跳数不出来，必须看这个字段。

为什么通知只在**状态翻转**时发一次：掉线可能持续几小时，按周期弹就是几十条
一模一样的通知，弹到第三条人就不看了。掉一次弹一条、恢复一次弹一条。

3. **静默检测**（2026-09-28 加）：那天 10:04 起 QQ 登录态被服务器作废，
   但 NapCat 心跳照来、`online=true`，WebSocket 也通着——上面两条全判正常，
   两个多小时一条消息都没进来，没人知道。重启 napcat 时才看到
   「你的用户身份已失效」。所以另外数「多久没收到任何消息/通知/申请」。
   只在白天（SILENCE_ACTIVE_FROM 点以后）算，并且从当天那个点起算——
   夜里本来就会安静七八个小时（日志里最长 526 分钟），不能每天早上一到点就报。
   它跟心跳是两套独立状态：只有真收到一条消息才算恢复，过零点不会假恢复。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Awaitable, Callable

from .config import Settings
from .dispatcher import Dispatcher
from .events import Event, MetaEvent
from .onebot import ApiError, OneBotClient, text

log = logging.getLogger(__name__)


def _log_done(t: asyncio.Task[None]) -> None:
    if t.cancelled():
        return
    exc = t.exception()
    if exc is not None:
        log.error("后台任务 %s 意外结束", t.get_name(), exc_info=exc)

# 多久查一次。比心跳间隔（30 秒）密一点，这样判定延迟主要由 OFFLINE_ALERT_AFTER 决定
CHECK_EVERY = 15.0
# 刚启动那会儿还没连上、还没收到第一拍，别急着报。这个宽限只对「一拍都没收到过」生效
GRACE = 90.0
# 白天多久一条消息都没有算可疑。9-22 ~ 9-28 的日志里白天正常最长空档 75 分钟
# （另有一次 132 分钟说不清是不是真没人说话），90 分钟一年到头误报不了几次
SILENCE_ALERT_AFTER = 90 * 60.0
# 几点以后才算静默（本地时间，容器 TZ=Asia/Shanghai）
SILENCE_ACTIVE_FROM = 9

# 用 `on run argv` 把正文和标题当参数传进去，而不是拼进脚本文本里。
# 拼字符串的话，文案里出现引号或反斜杠就会把 AppleScript 语法搞坏——
# 掉线通知是出故障时才跑的代码，最不该在那个时候自己再崩一次。
_OSA = (
    "on run argv\n"
    'display notification (item 1 of argv) with title (item 2 of argv) sound name "Basso"\n'
    "end run"
)

Notifier = Callable[[str, str], Awaitable[None]]


async def mac_notify(title: str, body: str) -> None:
    """弹一条 macOS 通知。失败不抛——通知发不出去不该反过来影响机器人。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/osascript", "-e", _OSA, body, title,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except (OSError, ValueError) as e:
        log.warning("Mac 通知没弹出来：%s", e)


def pretty_secs(secs: float) -> str:
    """把秒数说成人话。日志和私聊里都用，别一处写「183 秒」一处写「3 分钟」。"""
    secs = int(secs)
    if secs < 60:
        return f"{secs} 秒"
    if secs < 3600:
        return f"{secs // 60} 分 {secs % 60} 秒"
    return f"{secs // 3600} 小时 {secs % 3600 // 60} 分"


class Watchdog:
    """数心跳。`clock` 和 `notifier` 能换掉，所以离线用例不用真等三分钟、不用真弹通知。

    静默检测要看「几点了」，单调时钟给不了，所以另有一个墙上时钟 `now`，用例里一样能换。
    """

    def __init__(
        self,
        client: OneBotClient,
        settings: Settings,
        *,
        notifier: Notifier | None = None,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.client = client
        self.settings = settings
        self._clock = clock
        self._now = now
        self._notifier = notifier or mac_notify
        self._started = clock()
        self._started_at = now()
        self._last_msg: datetime | None = None
        self._silent_since: datetime | None = None
        self._last_beat: float | None = None
        # 收到第一拍之前先当它在线，由宽限期兜着。反过来（先当掉线）会在每次
        # 正常启动时都弹一条「掉线了」，属于自己制造噪音
        self._qq_online = True
        self._down_since: float | None = None
        self._down_reason = ""
        self.task: asyncio.Task[None] | None = None

    # ---- 收心跳 ----

    def on_heartbeat(self, status: dict) -> None:
        self._last_beat = self._clock()
        online = status.get("online")
        # 字段缺失不当掉线：`online` 是 NapCat 给的，将来改名或没了，
        # 宁可漏报也不要每 30 秒误报一次
        self._qq_online = True if online is None else bool(online)

    def on_activity(self) -> None:
        """收到任何一条消息 / 通知 / 申请。心跳不算——出事那天心跳一拍没少。"""
        self._last_msg = self._now()

    # ---- 判定 ----

    def _judge(self) -> str:
        """返回掉线原因；空串 = 一切正常。纯函数，好测。"""
        now = self._clock()
        after = self.settings.offline_alert_after
        if self._last_beat is None:
            # 一拍都没收到过：可能是刚开机 NapCat 还没起，给足宽限再说
            if now - self._started < max(GRACE, after):
                return ""
            return "连不上 NapCat，一拍心跳都没收到"
        gap = now - self._last_beat
        if gap > after:
            return f"{pretty_secs(gap)}没有心跳，NapCat 那边断了"
        if not self._qq_online:
            return "QQ 掉登录了，要去 127.0.0.1:6099 扫码重登"
        return ""

    def _judge_silence(self) -> str:
        """白天太久没收到任何事件就返回原因。起算点取「上一条消息 / 机器人启动 / 今天几点」里最晚的。"""
        now = self._now()
        if now.hour < SILENCE_ACTIVE_FROM:
            return ""
        day_start = now.replace(hour=SILENCE_ACTIVE_FROM, minute=0, second=0, microsecond=0)
        since = max(t for t in (self._last_msg, self._started_at, day_start) if t is not None)
        gap = (now - since).total_seconds()
        if gap <= SILENCE_ALERT_AFTER:
            return ""
        return f"{pretty_secs(gap)}一条消息都没收到，心跳却正常，多半是 QQ 登录态被服务器作废了"

    async def check(self) -> None:
        """判一次并在状态翻转时通知。循环调它，离线用例也直接调它。"""
        reason = self._judge()
        if reason and self._down_since is None:
            self._down_since = self._clock()
            self._down_reason = reason
            log.error("掉线了：%s", reason)
            await self._alert("机器人掉线了", f"{reason}。恢复后会补一条 QQ 私聊。")
        elif not reason and self._down_since is not None:
            lasted = self._clock() - self._down_since
            was, self._down_reason = self._down_reason, ""
            self._down_since = None
            log.info("恢复了，这次掉了 %s（%s）", pretty_secs(lasted), was)
            await self._alert("机器人恢复了", f"这次掉了 {pretty_secs(lasted)}（{was}）")
            await self._tell_admins(lasted, was)
        await self._check_silence()

    async def _check_silence(self) -> None:
        # 心跳那边已经报了掉线，就别再叠一条「没消息」——断线了当然没消息
        if self._silent_since is None and self._down_since is None:
            reason = self._judge_silence()
            if reason:
                self._silent_since = self._now()
                log.error("静默：%s", reason)
                await self._alert("机器人可能收不到消息", f"{reason}。")
                # 容器里 MAC_NOTIFY=false，这条私聊是唯一能当场找到人的渠道。
                # QQ 真失效了它多半发不出去，但真只是没人说话的话能发到——你回它一句，就恢复了
                await self._dm_admins(
                    f"⚠️ {reason}。\n"
                    "回我一句任何话：我能收到就是误报；没反应就去 127.0.0.1:6099 看，"
                    "必要时 docker compose restart napcat 重新扫码。"
                )
        elif self._silent_since is not None and self._last_msg is not None and self._last_msg > self._silent_since:
            lasted = (self._last_msg - self._silent_since).total_seconds()
            self._silent_since = None
            log.info("静默解除：报警后 %s 收到了新消息", pretty_secs(lasted))
            await self._alert("机器人又收到消息了", f"报警后 {pretty_secs(lasted)} 收到新消息")
            await self._dm_admins(f"又收到消息了（报警后 {pretty_secs(lasted)}），之前那条静默提醒可以不管了。")

    async def run(self) -> None:
        while True:
            await asyncio.sleep(CHECK_EVERY)
            try:
                await self.check()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — 看门狗自己崩了就等于没装
                log.exception("掉线检查出错")

    # ---- 通知 ----

    async def _alert(self, title: str, body: str) -> None:
        if not self.settings.mac_notify:
            return
        try:
            await self._notifier(title, body)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("弹通知时出错")

    async def _tell_admins(self, lasted: float, was: str) -> None:
        """恢复之后补一条私聊（和日报群）。掉线当下发不出去，这是唯一能事后送达的渠道。"""
        await self._dm_admins(
            f"我刚才掉线了 {pretty_secs(lasted)}，原因：{was}\n"
            "现在恢复了。这段时间的入群申请我重连时会补拉，群里的消息补不回来。"
        )

    async def _dm_admins(self, msg: str) -> None:
        for uid in sorted(self.settings.super_admins):
            try:
                await self.client.send_private_msg(uid, [text(msg)])
            except (ApiError, ConnectionError) as e:
                # 刚恢复就发，QQ 那边可能还没完全就绪。不重试：Mac 通知已经弹过了
                log.warning("给超管的私聊没发给 %s：%s", uid, e)
        # **不发日报群**（09-29 选过 13A 发，09-30 他改成「日报群就发23点一条就可以了 别的也不需要发」）


def register(dispatcher: Dispatcher, client: OneBotClient, settings: Settings) -> Watchdog:
    dog = Watchdog(client, settings)

    @dispatcher.on("meta_event.heartbeat")
    async def on_beat(ev: MetaEvent) -> None:
        dog.on_heartbeat(ev.status)

    # 按前缀注册：所有消息、通知、申请都算「QQ 那头还有东西进来」
    for key in ("message", "notice", "request"):
        @dispatcher.on(key)
        async def on_any(_ev: Event) -> None:
            dog.on_activity()

    dog.task = asyncio.create_task(dog.run(), name="watchdog")
    # 看门狗自己死了，掉线和静默提醒就全没了 —— 至少在日志里留一条 ERROR
    dog.task.add_done_callback(_log_done)
    log.info(
        "掉线检测已开：超过 %s 没心跳就提醒；%d 点后 %s 没收到任何消息也提醒",
        pretty_secs(settings.offline_alert_after), SILENCE_ACTIVE_FROM, pretty_secs(SILENCE_ALERT_AFTER),
    )
    return dog
