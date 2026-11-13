"""OneBot 11 正向 WebSocket 客户端。

只做三件事：连上并保持（断了指数退避重连）、把上报事件交给回调、call_api 发请求等回包。
业务逻辑一概不在这里，这层是 NapCat 换版本时唯一可能要动的地方。
"""
from __future__ import annotations

import asyncio
import base64
import itertools
import json
import logging
from typing import Any, Awaitable, Callable

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

log = logging.getLogger(__name__)

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


class ApiError(RuntimeError):
    """NapCat 明确回了失败，或超时没回。"""

    def __init__(self, action: str, retcode: int | None, message: str, wording: str = ""):
        self.action, self.retcode, self.message, self.wording = action, retcode, message, wording
        super().__init__(f"{action} 失败 retcode={retcode}: {wording or message}")


class AuthError(Exception):
    """令牌被拒。重试没有意义，直接退出让人改配置。故意不继承 ApiError，免得被重连逻辑吞掉。"""


def _log_reader_done(t: asyncio.Task[None]) -> None:
    """读循环带着异常结束时报一条 ERROR。

    正常断线走的是 _read_loop 的 finally，任务自己正常结束，不会进这里。会带着异常结束的
    只有两种：AuthError（令牌被拒，__main__ 那边已经报过一次，不重复刷）和 _on_event 里的
    意外错误。以前这里只把异常取走（为的是消掉 "Task exception was never retrieved" 警告），
    意外错误就这么静默丢了 —— 2026-10-10 和复盘/盯群那批后台任务一起补上日志。"""
    if t.cancelled():
        return
    exc = t.exception()
    if exc is None or isinstance(exc, AuthError):
        return
    log.error("读循环 %s 意外结束", t.get_name(), exc_info=exc)


# ---- 消息段：发消息一律用 array 格式，不走 CQ 码字符串，免得用户文本里的 [CQ:...] 被当成指令 ----

def text(s: str) -> dict[str, Any]:
    return {"type": "text", "data": {"text": s}}


def at(qq: int | str) -> dict[str, Any]:
    return {"type": "at", "data": {"qq": str(qq)}}


def image_b64(data: bytes) -> dict[str, Any]:
    """图片段。用 base64:// 而不是文件路径：NapCat 跑在容器里，看不到宿主机的文件。"""
    return {"type": "image", "data": {"file": "base64://" + base64.b64encode(data).decode()}}


def reply(message_id: int) -> dict[str, Any]:
    return {"type": "reply", "data": {"id": str(message_id)}}


class OneBotClient:
    def __init__(self, url: str, token: str, on_event: EventCallback, *, api_timeout: float = 30.0):
        self.url = url
        self._token = token
        self._on_event = on_event
        self._api_timeout = api_timeout
        self._ws: ClientConnection | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._echo = itertools.count(1)
        self._stopping = False
        self._auth_error: AuthError | None = None
        self.self_id: int | None = None
        self.nickname = ""

    @property
    def connected(self) -> bool:
        return self._ws is not None

    # ---- 连接生命周期 ----

    async def run(self) -> None:
        """主循环：连、读、断了重连，直到 stop()。令牌错误会抛 AuthError 直接结束。"""
        backoff = 1
        while not self._stopping:
            self._auth_error = None
            try:
                async with connect(
                    self.url,
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    max_size=8 * 2**20,  # 群成员列表这类回包可能不小，默认 1MB 不够
                ) as ws:
                    self._ws = ws
                    reader = asyncio.create_task(self._read_loop(ws), name="onebot-reader")
                    # 读循环的异常会经 _fail_pending 转给 call_api 抛出，任务本身的异常没人取；
                    # 取一下并记日志，免得 asyncio 在回收时报 "Task exception was never retrieved"
                    reader.add_done_callback(_log_reader_done)
                    try:
                        info = await self.call_api("get_login_info")
                        self.self_id, self.nickname = int(info["user_id"]), info.get("nickname", "")
                        log.info("已连接 %s，登录账号 %s (%s)", self.url, self.self_id, self.nickname)
                        backoff = 1
                        await reader
                    finally:
                        reader.cancel()
                log.warning("连接已关闭")
            except (OSError, WebSocketException, ApiError, ConnectionError) as e:
                # OSError = 连不上（NapCat 没起 / 端口没开）；WebSocketException 含握手失败和异常断开。
                # 令牌被拒时 NapCat 发完 1403 立刻关连接，这里多半先看到的是 send 失败，所以要查一下真因
                if self._auth_error is None:
                    log.warning("连接断开: %s", e)
            finally:
                self._ws = None
            if self._auth_error is not None:
                raise self._auth_error
            if self._stopping:
                break
            log.info("%d 秒后重连", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def stop(self) -> None:
        self._stopping = True
        if self._ws is not None:
            await self._ws.close()

    async def _read_loop(self, ws: ClientConnection) -> None:
        # 连接一断，所有还在等回包的调用立刻失败，别让它们干等到超时
        cause: BaseException = ConnectionError("连接断开")
        try:
            async for frame in ws:
                try:
                    msg = json.loads(frame)
                except ValueError:
                    log.warning("收到非 JSON 帧: %.200s", frame)
                    continue
                if msg.get("retcode") == 1403:
                    cause = self._auth_error = AuthError(f"NapCat 拒绝了令牌: {msg.get('message')}")
                    raise cause
                if msg.get("post_type"):
                    await self._on_event(msg)
                elif msg.get("echo") is not None:
                    self._resolve(msg)
                else:
                    log.debug("未识别的帧: %s", msg)
        finally:
            self._fail_pending(cause)

    # ---- 接口调用 ----

    async def call_api(self, action: str, *, _timeout: float | None = None, **params: Any) -> Any:
        """调一个 OneBot 动作，返回其 data；失败抛 ApiError。

        `_timeout` 只给传群文件这种慢的用（下划线开头，免得跟哪个动作自己的参数撞名），不传就是 api_timeout。
        """
        if self._ws is None:
            raise ConnectionError("未连接 NapCat")
        timeout = _timeout or self._api_timeout
        echo = f"{action}#{next(self._echo)}"
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[echo] = fut
        try:
            try:
                await self._ws.send(json.dumps({"action": action, "params": params, "echo": echo}, ensure_ascii=False))
            except WebSocketException as e:
                # 发到一半掉线抛的是 ConnectionClosed，它**不是** ConnectionError 的子类。
                # 调用方一律只接 (ApiError, ConnectionError)，不在这里转掉的话整个处理器直接炸穿：
                # 问答流水不记、转人工会话不开、超管也不知道
                raise ConnectionError(f"发送时连接断开：{e}") from e
            resp = await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            raise ApiError(action, None, f"{timeout:.0f} 秒内没等到回包") from None
        finally:
            self._pending.pop(echo, None)
        if resp.get("status") == "failed" or resp.get("retcode", 0) != 0:
            raise ApiError(action, resp.get("retcode"), resp.get("message", ""), resp.get("wording", ""))
        return resp.get("data")

    def _resolve(self, msg: dict[str, Any]) -> None:
        fut = self._pending.get(msg["echo"])
        if fut is None:
            log.debug("回包没人等（可能已超时）: %s", msg["echo"])
        elif not fut.done():
            fut.set_result(msg)

    def _fail_pending(self, exc: BaseException) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
                # 标记「异常已取走」：等它的 call_api 照样会抛；没人等的（send 先失败的那种）不会刷 never retrieved
                fut.exception()
        self._pending.clear()

    # ---- 常用动作的薄封装，参数名照 OneBot 11 ----

    async def send_group_msg(self, group_id: int, message: str | list[dict[str, Any]]) -> int:
        segs = [text(message)] if isinstance(message, str) else message
        data = await self.call_api("send_group_msg", group_id=group_id, message=segs)
        return int(data["message_id"])

    async def send_private_msg(self, user_id: int, message: str | list[dict[str, Any]]) -> int:
        segs = [text(message)] if isinstance(message, str) else message
        data = await self.call_api("send_private_msg", user_id=user_id, message=segs)
        return int(data["message_id"])

    async def set_group_add_request(self, flag: str, approve: bool, reason: str = "", *, count: int = 200) -> None:
        """同意/拒绝入群申请。三个 NapCat 的坑都在这堵死，调用方不用记。

        1. NapCat 判断是 `payload.approve?.toString() !== 'false'`——**除了显式 false，
           传什么（None、空串、不传）都算同意**。所以这里强制 bool，不给调用方留模糊空间：
           一个手滑的 None 就是真把陌生人放进客户群。
        2. `sub_type` / `type` NapCat 的 schema 里压根没有，只按 flag 全局反查。
           OneBot 11 标准文档写的「必须和上报的 sub_type 相符」在 NapCat 上是假的，不传。
        3. `reason` 内部默认值是一个空格（`payload.reason ?? ' '`），`??` 拦不住空字符串，
           显式传 "" 反而可能让协议层处理失败。所以只在拒绝且真有理由时才传。

        还有一个堵不住的：flag 已经被处理过时，NapCat 不检查底层返回，**照样回 retcode=0**。
        所以调用成功 ≠ QQ 那边真生效，回执话术要用「已提交」而不是「已批准」。
        flag 只在最近 count 条群通知里反查得到，超窗会抛 ApiError(retcode=1200, "No such request")。
        """
        if not isinstance(approve, bool):
            raise TypeError(f"approve 必须是 bool，传 {approve!r} 会被 NapCat 当成同意")
        params: dict[str, Any] = {"flag": flag, "approve": approve, "count": count}
        if not approve and reason:
            params["reason"] = reason
        await self.call_api("set_group_add_request", **params)

