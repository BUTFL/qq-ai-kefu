"""两家远控软件的「方言」映射。语义动作 → 各自的工具名 + 参数形状。

为什么要这层：ToDesk 和向日葵都把远控包成了 MCP，工具集几乎一样，但**叫法和参数不一样**：

| 语义       | 向日葵（AweSun）                | ToDesk                          |
|------------|--------------------------------|---------------------------------|
| 列出设备   | `device_search`                | `todesk_list_devices`           |
| 发起会话   | `control_connect(type, …)`     | `todesk_connect_device(device_id)` |
| 截图       | `control_screenshot(session_id)` | `todesk_take_screenshot(device_id)` |
| 点击       | `desktop_click_mouse(coordinates[])` | `todesk_send_mouse_event(x, y)` |
| 输文字     | `desktop_typing_text`          | `todesk_send_keyboard_event`    |

**最大的差别在「连谁」**：
- 向日葵：`control_connect` 接 `remote_id`（自家账号里的设备）**或 `fastcode`（9-10 位识别码，
  不在账号里的设备也能连）**。→ 客户报个识别码就能连，这是我们要的那条路。
- ToDesk：`todesk_connect_device` 接 `device_id` = 客户端的九位设备码 + 可选 `password`。

一句话：**要连客户的机器，向日葵走 `fastcode`，ToDesk 走 `device_id` + `password`。**

实测记录（2026-10-16）：
- 向日葵 MCP 服务端二进制在 `/Applications/AweSun.app/Contents/Helpers/awesun-mcp-server`，
  走 **stdio** 就能握手；真实调用要客户端里开「向日葵MCP」并配两个环境变量：
  `AWESUN_API_URL=http://127.0.0.1:8908`、`AWESUN_API_TOKEN=sk-sl-…`（客户端生成，可重置）。
- 没配 token 时报 `401 Unauthorized: Missing API Token`；客户端开关没开时报
  `dial tcp 127.0.0.1:8908: connect: connection refused`。
- **连自己这台会被拒**：`109 Cannot control local device`。测流程必须用第二台机器。
- **用识别码连陌生设备要对方放行**。`control_connect` 第一次 dial 返回
  `state=waitingInputVerifyCode`、`message=Connection established but requires verification
  code or approval. User must enter code manually`；**没有任何工具能提交验证码** ——
  所以那一步只能靠对方在自己电脑上点「同意」（或他自己把验证码报给我们、我们在他机器上敲）。
  对方放行后再 dial 一次就 `state=success`（实测 0.3 秒）。
  连上之后 `session_id` 长这样：`r=k399999003;p=desktop;t=desktop;h=fastCode;`（k 后面是识别码）。
- **`control_screenshot` 返回一行大 JSON**（`image_path` + `image_base64`，几十上百 KB），
  stdio 客户端必须把单行上限放大，否则报
  `ValueError: Separator is found, but chunk is longer than limit`（`mcp_client.STREAM_LIMIT`）。
- 桌面操作的坐标是**归一化 0~1**，点击回显是 `{"text": "Mouse click success"}`，
  但**回显成功不等于点对了地方** —— 要再截一张图看变化（实测点苹果菜单那一下，截图里
  菜单真的弹出来了，菜单栏左边那三个字也从「贝锐向日葵」变成「访达」）。
- `desktop_press_keys` 只认特定键名，`esc` 不在其中（报
  `Key 'esc' not supported. Supported key categories:`）。要关菜单就点一下别处。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 语义动作全集。白名单按这个来分档（见 operator.py），跟具体厂商无关。
ACTIONS = (
    "listDevices",   # 读设备列表
    "connect",       # 发起远控会话
    "disconnect",    # 断开
    "screenshot",    # 看屏幕
    "sessions",      # 查当前会话
    "click",         # 点鼠标
    "move",          # 移鼠标
    "drag",          # 拖拽
    "type",          # 打字（逐字）
    "paste",         # 粘贴长文本
    "press",         # 按单键
    "hotkey",        # 组合键
    "scroll",        # 滚轮
    "wait",          # 等一会儿
    "runCommand",    # 执行命令（最强权限）
)


@dataclass(frozen=True)
class Provider:
    """一个远控厂商的方言包。

    `tools` 里没有的语义动作 = 这家不支持，operator 会明确拒绝而不是瞎调。
    """

    key: str
    label: str
    tools: dict[str, str]
    binary: str | None          # stdio 启动命令；None = 只走 HTTP
    url_env: str                # 读哪个环境变量拿地址
    token_env: str              # 读哪个环境变量拿 token
    default_url: str            # MCP 入口地址
    # 连客户机器时用哪个字段：向日葵 fastcode / ToDesk device_id
    target_field: str
    target_label: str
    supports_password: bool     # 厂商的 MCP 是否接密码/验证码
    # 传输方式。**2026-10-16 起向日葵默认走 HTTP**：机器人本体在 Docker 容器里，
    # 而 MCP 服务端是 macOS 二进制 —— stdio 那条路容器里根本没法走。
    # 服务端由 launchd 常驻在宿主机（deploy/com.lingmou.awesun-mcp.plist）。
    default_transport: str = "stdio"
    # stdio 模式下要塞给子进程的「客户端 API 地址」（跟 MCP 入口不是一回事）
    client_api: str = ""

    def tool(self, action: str) -> str:
        try:
            return self.tools[action]
        except KeyError:
            raise KeyError(f"{self.label} 不支持「{action}」这个动作") from None

    # ---- 参数形状。两家不一样，都在这里收口，operator 不碰细节 ----

    def params(self, action: str, *, session: Any = None, **kw: Any) -> dict[str, Any]:
        """把语义参数翻成这家要的形状。

        `session` 要有 `.target`（识别码/设备码）和 `.session_id`（会话 ID，向日葵要）。
        """
        sid = getattr(session, "session_id", "") if session is not None else ""
        target = getattr(session, "target", "") if session is not None else ""

        if self.key == "awesun":
            if action == "connect":
                p: dict[str, Any] = {"type": kw.get("mode", "desktop")}
                # 账号里的设备用 remote_id（整数），外面的用 fastcode（字符串）
                if str(target).isdigit() and len(str(target)) >= 9:
                    p["fastcode"] = str(target)
                else:
                    p["remote_id"] = target
                return p
            if action == "disconnect":
                return {"session_id": sid}
            if action == "screenshot":
                return {"session_id": sid}
            if action == "click":
                return {"session_id": sid, "coordinates": [kw["x"], kw["y"]],
                        "button": kw.get("button", "left"), "clicks": kw.get("clicks", 1)}
            if action == "move":
                return {"session_id": sid, "coordinates": [kw["x"], kw["y"]]}
            if action == "drag":
                return {"session_id": sid, "paths": kw["paths"], "button": kw.get("button", "left")}
            if action == "type":
                return {"session_id": sid, "text": kw["text"], "delay": kw.get("delay", 30)}
            if action == "paste":
                return {"session_id": sid, "text": kw["text"]}
            if action == "press":
                return {"session_id": sid, "keys": kw["keys"] if isinstance(kw["keys"], list) else [kw["keys"]]}
            if action == "hotkey":
                return {"session_id": sid, "keys": kw["keys"]}
            if action == "scroll":
                return {"session_id": sid, "coordinates": [kw["x"], kw["y"]],
                        "direction": kw.get("direction", "down"), "scroll_count": kw.get("count", 3)}
            if action == "wait":
                return {"duration": kw.get("ms", 500)}
            if action == "listDevices":
                return {"keyword": kw.get("keyword", ""), "limit": kw.get("limit", 20)}
            if action == "sessions":
                return {"type": kw.get("mode", "desktop")}
            if action == "runCommand":
                return {"session_id": sid, "command": kw["command"], "args": kw.get("args") or []}

        else:  # todesk：参数以 device_id 为主键，没有 session_id 概念
            if action == "connect":
                p = {"device_id": str(target)}
                if kw.get("password"):
                    p["password"] = kw["password"]
                return p
            if action == "disconnect":
                return {"device_id": str(target)}
            if action == "screenshot":
                return {"device_id": str(target), "screen_id": kw.get("screen_id", 0)}
            if action == "click":
                return {"device_id": str(target), "action": "click",
                        "x": kw["x"], "y": kw["y"], "button": kw.get("button", "left"),
                        "clicks": kw.get("clicks", 1)}
            if action == "move":
                return {"device_id": str(target), "action": "move", "x": kw["x"], "y": kw["y"]}
            if action in ("type", "press"):
                return {"device_id": str(target),
                        "action": "type" if action == "type" else "press",
                        "key": kw.get("text") or kw.get("keys")}
            if action == "listDevices":
                return {"status_filter": "all"}
            if action == "runCommand":
                return {"device_id": str(target), "command": kw["command"]}
            if action == "sessions":
                return {}

        raise KeyError(f"{self.label} 的 {action} 参数形状还没写（要用就先补 provider.py）")


AWESUN = Provider(
    key="awesun",
    label="向日葵",
    binary="/Applications/AweSun.app/Contents/Helpers/awesun-mcp-server",
    url_env="AWESUN_API_URL",
    token_env="AWESUN_API_TOKEN",
    # MCP 入口。`host.docker.internal` 只在容器里能解析 —— 宿主机上跑脚本时
    # `mcp_client.for_provider` 会自动换回 127.0.0.1（见 _localize）
    default_url="http://host.docker.internal:8912/mcp",
    default_transport="http",
    client_api="http://127.0.0.1:8908",
    target_field="fastcode",
    target_label="识别码（向日葵主界面那个 9-10 位数字）",
    supports_password=False,   # MCP 不接验证码，验证码那步在客户端那侧
    tools={
        "listDevices": "device_search",
        "connect": "control_connect",
        "disconnect": "control_disconnect",
        "screenshot": "control_screenshot",
        "sessions": "control_sessions",
        "click": "desktop_click_mouse",
        "move": "desktop_move_mouse",
        "drag": "desktop_drag_mouse",
        "type": "desktop_typing_text",
        "paste": "desktop_paste_text",
        "press": "desktop_press_keys",
        "hotkey": "desktop_typing_keys",
        "scroll": "desktop_scroll_mouse",
        "wait": "desktop_waiting",
        "runCommand": "control_command",
    },
)

TODESK = Provider(
    key="todesk",
    label="ToDesk",
    binary="/Applications/ToDesk.app/Contents/MacOS/todesk-mcp",
    url_env="TODESK_MCP_URL",
    token_env="TODESK_MCP_TOKEN",
    default_url="http://127.0.0.1:8899/mcp",
    default_transport="http",
    target_field="device_id",
    target_label="设备代码（ToDesk 主界面那个九位数字）",
    supports_password=True,
    tools={
        "listDevices": "todesk_list_devices",
        "connect": "todesk_connect_device",
        "disconnect": "todesk_disconnect_device",
        "screenshot": "todesk_take_screenshot",
        "sessions": "todesk_get_active_sessions",
        "click": "todesk_send_mouse_event",
        "move": "todesk_send_mouse_event",
        "type": "todesk_send_keyboard_event",
        "press": "todesk_send_keyboard_event",
        "runCommand": "todesk_exec_command",
    },
)

PROVIDERS: dict[str, Provider] = {AWESUN.key: AWESUN, TODESK.key: TODESK}


def pick(name: str) -> Provider:
    """按名字取厂商。空字符串 = 向日葵（2026-10-16 起它才是能用的那条）。"""
    key = (name or "awesun").strip().lower()
    if key not in PROVIDERS:
        raise KeyError(f"不认识的远控厂商 {name!r}，可选：{sorted(PROVIDERS)}")
    return PROVIDERS[key]


def binary_exists(p: Provider) -> bool:
    return bool(p.binary) and Path(p.binary).exists()
