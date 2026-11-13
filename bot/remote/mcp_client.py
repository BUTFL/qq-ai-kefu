"""MCP 客户端：跟 ToDesk 自带的 MCP Server 通信。

ToDesk 5.1 起，客户端里内置了一个 MCP Server（二进制就在
`/Applications/ToDesk.app/Contents/MacOS/todesk-mcp`），把远控能力包成了 37 个工具：
连设备、截图、发鼠标键盘事件、传文件、执行命令。

它自己声明的传输方式（从二进制里读出来的配置）：

```json
{"transport": {
   "stdio": {"command": "./todesk-mcp-server", "env": ["MCP_AUTH_TOKEN", "MCP_LOG_LEVEL"]},
   "sse":   {"url": "http://localhost:8899/sse", "auth": "bearer"},
   "mcp":   {"url": "http://localhost:8899/mcp", "auth": "bearer"}}}
```

**必须先在这个客户端里手动打开 MCP 开关**（客户端会生成 token）。没开的话，
stdio 模式只会回一句 `Failed to connect to ToDesk via IPC. Ensure ToDesk is running.` ——
注意这句话是骗人的，ToDesk 明明在跑，真实原因是开关没开。

我们这个模块只负责协议，不管业务规矩（业务规矩在 operator.py）。

为什么不用官方 `mcp` Python 包：它是标准库式的重依赖，我们只需要 4 个方法
（initialize / notifications/initialized / tools/list / tools/call），
用已经在依赖里的 httpx 写 200 行就够，且出问题好查。
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import socket
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

log = logging.getLogger(__name__)

PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "lmuai-support-bot", "version": "1.0"}

# ToDesk 客户端自带的那个二进制。默认路径照 macOS 安装位置。
DEFAULT_BINARY = "/Applications/ToDesk.app/Contents/MacOS/todesk-mcp"

# stdio 单行回包的上限。默认 64KB 太小：截图（base64/长路径）一行就能超，
# 超了 asyncio 直接抛 ValueError，表现成「调截图必死」
STREAM_LIMIT = 32 * 1024 * 1024

# 连 MCP 的超时。HTTP 那条要走 Docker 的网络转发、stdio 那条要等子进程，
# 都可能慢，给宽一点（截图那种操作本身也要时间）
HTTP_TIMEOUT = 60.0


class McpError(RuntimeError):
    """MCP 返回了错误，或者我们发的东西它不认。"""


class McpUnavailable(McpError):
    """压根连不上：MCP 没开、token 不对、或客户端没跑。

    调用方看到这个应该去提示「让大哥在 ToDesk 里打开 MCP」，
    而不是当成「远程操作失败」。
    """


class McpClient:
    """一个 MCP 会话。用 `connect()` 起来，`call_tool()` 干活。

    支持两种传输：

    - `"http"`（推荐）：`http://127.0.0.1:8899/mcp`，标准 Streamable HTTP，
      一问一答，响应可能是 JSON 也可能是 SSE 帧，两种都解。
    - `"stdio"`：起一个子进程，走标准输入输出。MCP 没开时这条路死得最彻底，
      留着只是为了排查方便。

    典型用法：

        async with McpClient(url=..., token=...) as c:
            tools = await c.list_tools()
            out = await c.call_tool("todesk_list_devices", {})
    """

    def __init__(
        self,
        *,
        url: str = "http://127.0.0.1:8899/mcp",
        token: str = "",
        transport: str = "http",
        binary: str = DEFAULT_BINARY,
        timeout: float = 30.0,
        env: dict[str, str] | None = None,
    ) -> None:
        self.url = url
        self.token = token
        self.transport = transport
        self.binary = binary
        self.timeout = timeout
        # 给 stdio 子进程额外塞的环境变量。向日葵那条路靠这个传凭证：
        # AWESUN_API_URL=http://127.0.0.1:8908 + AWESUN_API_TOKEN=sk-sl-…
        self.extra_env = dict(env or {})

        self._http: httpx.AsyncClient | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._seq = 0
        self._lock = asyncio.Lock()  # MCP 有会话状态，并发发请求会串
        # Streamable HTTP 的会话号：握手那次响应头里给，之后每个请求都要回带，
        # 不带就 `HTTP 400: Invalid session ID`（2026-10-16 实测）
        self._session_id = ""
        self.server_info: dict[str, Any] = {}
        self.tools: list[dict[str, Any]] = []

    # ---------- 生命周期 ----------

    async def connect(self) -> None:
        """握手。连不上就抛 `McpUnavailable`，不做重试（重试交给上层调度）。"""
        if self.transport == "stdio":
            await self._spawn_stdio()
        else:
            headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            self._http = httpx.AsyncClient(base_url=self.url, headers=headers, timeout=self.timeout)

        try:
            init = await self._request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": CLIENT_INFO,
                },
            )
        except McpUnavailable:
            await self.aclose()
            raise
        except Exception as e:  # 连不上、被拒、格式不对——都归成「MCP 没准备好」
            await self.aclose()
            raise McpUnavailable(
                f"连不上 ToDesk MCP（{self.transport} {self.url}）：{e}。"
                "去 ToDesk 客户端里确认 MCP 已启用、token 是新的。"
            ) from e

        self.server_info = init.get("serverInfo") or {}
        log.info(
            "MCP 已连接：%s %s（协议 %s）",
            self.server_info.get("name", "?"),
            self.server_info.get("version", "?"),
            init.get("protocolVersion", "?"),
        )

        # MCP 规矩：握手后必须发这条通知，否则 server 可能不回 tools/list
        await self._notify("notifications/initialized", {})

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except (ProcessLookupError, asyncio.TimeoutError):
                if self._proc.returncode is None:
                    self._proc.kill()
            self._proc = None

    async def __aenter__(self) -> McpClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ---------- 工具 ----------

    async def list_tools(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        """37 个工具的清单，带 inputSchema / risk_level / required_scopes。"""
        if self.tools and not refresh:
            return self.tools
        out = await self._request("tools/list", {})
        self.tools = list(out.get("tools") or [])
        return self.tools

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """调一个工具。返回展平后的 dict（见 `_flatten`）。

        MCP 的返回结构是 `{content: [{type: "text", text: "{...json...}"}], isError?}`，
        这里的 `_flatten` 把里面那层 JSON 解出来，让上层直接拿到 `{status, session_id}` 这种。
        """
        async with self._lock:
            raw = await self._request("tools/call", {"name": name, "arguments": arguments or {}})
        return _flatten(name, raw)

    # ---------- 协议内部 ----------

    async def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._seq += 1
        rid = self._seq
        payload = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}

        if self.transport == "stdio":
            msg = await self._stdio_roundtrip(payload)
        else:
            msg = await self._http_roundtrip(payload)

        if "error" in msg:
            err = msg["error"] or {}
            raise McpError(f"{method} 失败：{err.get('code')} {err.get('message')}")
        return msg.get("result") or {}

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        """通知没有 id，也不该等回包。HTTP 下直接 POST，失败就算了。"""
        if self.transport != "stdio" or self._proc is None or self._proc.stdin is None:
            if self._http is None:
                return
            try:
                await self._http.post("", json={"jsonrpc": "2.0", "method": method, "params": params})
            except httpx.HTTPError as e:
                log.debug("通知 %s 没发出去（不影响）：%s", method, e)
            return
        line = json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, ensure_ascii=False)
        self._proc.stdin.write((line + "\n").encode())
        await self._proc.stdin.drain()

    async def _http_roundtrip(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._http is None:
            raise McpUnavailable("还没 connect()")
        headers = {"Mcp-Session-Id": self._session_id} if self._session_id else None
        try:
            resp = await self._http.post("", json=payload, headers=headers)
        except httpx.HTTPError as e:
            raise McpUnavailable(f"HTTP 请求失败：{e}") from e

        # 会话号第一次出现在握手的响应头里，之后所有请求都要回带（见 __init__ 注释）
        sid = resp.headers.get("mcp-session-id")
        if sid:
            self._session_id = sid

        if resp.status_code in (401, 403):
            raise McpUnavailable(f"token 被拒（HTTP {resp.status_code}）")
        if resp.status_code >= 400:
            raise McpError(f"HTTP {resp.status_code}：{resp.text[:200]}")

        ctype = resp.headers.get("content-type", "")
        body = resp.text
        if "text/event-stream" in ctype or body.lstrip().startswith("event:"):
            return _parse_sse_for_id(body, payload["id"])
        try:
            return json.loads(body or "{}")
        except json.JSONDecodeError as e:
            raise McpError(f"回的不是 JSON：{body[:200]}") from e

    async def _spawn_stdio(self) -> None:
        exe = shutil.which(self.binary) or self.binary
        env = {"MCP_LOG_LEVEL": "ERROR", **self.extra_env}
        if self.token:
            env["MCP_AUTH_TOKEN"] = self.token
        try:
            self._proc = await asyncio.create_subprocess_exec(
                exe,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={**__import__("os").environ, **env},
                # **必须放大这个上限**：默认 64KB，而截图那类回包一行就几十上百 KB，
                # 会炸成 `ValueError: Separator is found, but chunk is longer than limit`。
                # 2026-10-16 实测踩到（control_screenshot 一调就死）
                limit=STREAM_LIMIT,
            )
        except (FileNotFoundError, PermissionError) as e:
            raise McpUnavailable(f"起不了 {exe}：{e}") from e

    async def _stdio_roundtrip(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise McpUnavailable("stdio 子进程没起来")
        self._proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
        await self._proc.stdin.drain()

        deadline = asyncio.get_running_loop().time() + self.timeout
        while True:
            left = deadline - asyncio.get_running_loop().time()
            if left <= 0:
                raise McpUnavailable("stdio 等回包超时")
            try:
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=left)
            except asyncio.TimeoutError:
                raise McpUnavailable("stdio 等回包超时") from None
            except ValueError as e:
                # 行太长（超 STREAM_LIMIT）。理论上不该再出现，真出现了要说清楚是哪一步
                raise McpError(f"回包单行超长（{STREAM_LIMIT // 1024 // 1024}MB 上限）：{e}") from e
            if not line:
                raise McpUnavailable(
                    "stdio 通道关了。多半是 ToDesk 客户端里 MCP 开关没打开"
                    "（它的提示会写 Ensure ToDesk is running，别信，ToDesk 在跑）。"
                )
            text = line.decode("utf-8", "replace").strip()
            if not text.startswith("{"):
                continue  # 客户端往 stdout 里混了日志，跳过
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == payload["id"]:
                return msg


def _localize(url: str) -> str:
    """把「只在容器里能解析」的 `host.docker.internal` 换回 `127.0.0.1`。

    **为什么要这一步**：同一个项目在两种上下文里跑 —— 机器人本体在容器里（要
    `host.docker.internal` 才够得到宿主机的 MCP 服务），而 `scripts/` 下的探针、
    端到端脚本在宿主机上直接跑（那里 `host.docker.internal` 解析不了）。
    配置只写一份，谁跑谁自己换。实测依据：宿主机 127.0.0.1 上监听的服务，
    容器用 host.docker.internal 摸得到（Docker Desktop 会转发到回环口）。
    """
    if not url:
        return url
    parts = urlsplit(url)
    if parts.hostname != "host.docker.internal":
        return url
    try:
        socket.getaddrinfo(parts.hostname, parts.port or 80, proto=socket.IPPROTO_TCP)
        return url          # 容器里能解析，原样用
    except OSError:
        netloc = f"127.0.0.1:{parts.port}" if parts.port else "127.0.0.1"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def for_provider(p: Any, *, url: str = "", token: str = "", transport: str = "") -> McpClient:
    """按厂商（和指定传输）建一个客户端。

    - `transport="http"`（向日葵/ToDesk 现在的默认）：连 MCP 的 HTTP 入口。
      向日葵的服务端由 launchd 常驻宿主机（`deploy/com.lingmou.awesun-mcp.plist`）。
    - `transport="stdio"`：起厂商自带的 MCP 二进制（只在宿主机上跑得动，容器里不行）。
    """
    kind = (transport or getattr(p, "default_transport", "stdio")).strip().lower()
    if kind in ("http", "streamable_http", "sse"):
        return McpClient(url=_localize(url or p.default_url), token=token,
                         transport="http", timeout=HTTP_TIMEOUT)
    env = {p.url_env: (getattr(p, "client_api", "") or url or p.default_url)}
    if token:
        env[p.token_env] = token
    return McpClient(transport="stdio", binary=p.binary or DEFAULT_BINARY, timeout=HTTP_TIMEOUT, env=env)


# ---------- 解析辅助 ----------


def _parse_sse_for_id(body: str, want_id: int) -> dict[str, Any]:
    """从 SSE 文本里挑出 id 匹配的那条 JSON-RPC 回包。

    SSE 长这样（data: 后面才是 JSON，可能跨多行）：

        event: message
        data: {"jsonrpc":"2.0","id":2,"result":{...}}
    """
    for chunk in body.split("\n\n"):
        data_lines = [ln[5:].strip() for ln in chunk.splitlines() if ln.startswith("data:")]
        if not data_lines:
            continue
        try:
            msg = json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            continue
        if msg.get("id") in (want_id, None) and ("result" in msg or "error" in msg):
            return msg
    raise McpError(f"SSE 回包里没找到 id={want_id} 的响应：{body[:200]}")


def _flatten(tool: str, raw: dict[str, Any]) -> dict[str, Any]:
    """把 MCP 那层 content 拆掉。

    `{"content": [{"type": "text", "text": "{\\"status\\":\\"ok\\"}"}], "isError": false}`
    → `{"status": "ok"}`

    图片类结果是 `{"type": "image", "data": "<base64>", "mimeType": "image/jpeg"}`，
    保持原文，让上层决定存盘还是发给客户。
    """
    if raw.get("isError"):
        texts = [c.get("text", "") for c in raw.get("content") or [] if c.get("type") == "text"]
        raise McpError(f"{tool} 报错：{' '.join(texts)[:300]}")

    out: dict[str, Any] = {}
    if "structuredContent" in raw:
        out.update(raw["structuredContent"] or {})

    for c in raw.get("content") or []:
        if c.get("type") == "text":
            txt = c.get("text") or ""
            try:
                parsed = json.loads(txt)
            except json.JSONDecodeError:
                out.setdefault("text", txt)
                continue
            if isinstance(parsed, dict):
                out.update(parsed)
            else:
                out.setdefault("text", parsed)
        elif c.get("type") == "image":
            out["image_base64"] = c.get("data")
            out["image_mime"] = c.get("mimeType")
    return out
