"""远程协助的业务层：白名单、审批、审计、密码不落盘。**跟具体厂商解耦，方言在 provider.py。**

三层各管一件事：

1. `mcp_client.py` —— 协议层。跟远控软件的 MCP 说话（HTTP / SSE / stdio）。
2. `provider.py`   —— 方言层。语义动作 → 各家工具名和参数形状。
3. 这个文件        —— 规矩层。**机器人干远程活只能走这里。**

规矩层管四件事：

- **白名单分档**：`view` 只看 / `assist` 能连能点能敲（配中转站够用）/ `full` 才给执行命令。
  分档按**语义动作**分，不按厂商工具名分，换厂商白名单不用改。
- **审批**：连客户机器（`connect`）和执行命令（`runCommand`）必须有人点过头。
  大哥定的规矩：客户私聊同意 + 他点头，才开始远程（见 `approved_by`）。
- **上限**：一单最多几次操作、最长多少分钟，防失控。
- **审计**：每个动作写一行 JSONL。**密码/验证码永不落盘，设备码脱敏。**

### 出问题怎么查

审计在 `data/remote_audit.jsonl`（路径可改）。一行一个动作：谁、连哪台、干了什么、成没成、多久。
机器人说「我没干过这个」时，先看这个文件。
"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .mcp_client import McpClient, McpError
from .provider import AWESUN, Provider

log = logging.getLogger(__name__)

# ---- 语义动作的白名单分档。换厂商不用改这里，映射在 provider.py
VIEW_ACTIONS = frozenset({"listDevices", "screenshot", "sessions"})
ASSIST_ACTIONS = VIEW_ACTIONS | frozenset({
    "connect", "disconnect", "click", "move", "drag",
    "type", "paste", "press", "hotkey", "scroll", "wait",
})
FULL_ACTIONS = ASSIST_ACTIONS | frozenset({"runCommand"})

PROFILES: dict[str, frozenset[str]] = {
    "view": VIEW_ACTIONS,
    "assist": ASSIST_ACTIONS,
    "full": FULL_ACTIONS,
}

# 需要人点头的动作。**connect 是最关键的闸**：没点头就不许连客户的机器。
# runCommand 是第二道：能敲命令等于能改客户电脑上任何东西。
DEFAULT_APPROVAL_REQUIRED = frozenset({"connect", "runCommand"})

# 这些参数值不进日志、不进审计
SECRET_KEYS = frozenset({"password", "passwd", "token", "auth_token", "verify_code", "验证码"})

AUDIT_PATH = Path("data/remote_audit.jsonl")


class RemoteRefused(RuntimeError):
    """动作被规矩挡下了（不在档位里、没审批、超上限、目标格式不对）。

    跟 `McpError` 分开：这个是「我们不让」，那个是「工具坏了」。
    """


@dataclass
class Session:
    """一次远程协助会话。一次工单一个。

    `target` 是「连谁」：向日葵是识别码（fastcode），ToDesk 是九位设备码。
    `session_id` 是厂商连上之后给的会话句柄，向日葵的后续操作都要它。
    """

    target: str
    customer: str = ""          # 客户标识（QQ 号/昵称），只给人看
    approved_by: str = ""       # 谁同意的（客户自己 / 大哥）
    profile: str = "assist"
    provider: str = "awesun"
    session_id: str = ""        # 连上之后才有
    opened_at: float = field(default_factory=time.time)
    ops: int = 0
    connected: bool = False
    ended: bool = False

    @property
    def minutes(self) -> float:
        return (time.time() - self.opened_at) / 60


Approver = Callable[[str, str, str], Awaitable[bool]]


def mask_target(t: Any) -> str:
    """识别码/设备码脱敏：`399999001` → `4974***88`。日志里用这个。"""
    d = str(t or "").strip()
    if len(d) < 7:
        return "***"
    return f"{d[:4]}***{d[-2:]}"


def scrub(params: dict[str, Any]) -> dict[str, Any]:
    """参数里的密码类字段换成 `***` 再记日志。

    密码/验证码是客户给的临时凭据，只在内存里活到连上为止，**任何文件都不该有它**。
    """
    return {k: ("***" if str(k).lower() in SECRET_KEYS else v) for k, v in (params or {}).items()}


class RemoteOperator:
    """机器人干远程活的唯一入口。

        p = pick("awesun")
        op = RemoteOperator(for_provider(p, token=tok), provider=p, approver=有人点头吗)
        async with op.session("399999001", customer="QQ123456", approved_by="客户") as s:
            await op.connect(s)                 # 连（这条要审批）
            shot = await op.screenshot(s)       # 看
            await op.click(s, 0.42, 0.18)       # 点
            await op.type_text(s, "https://api.lmuai.com/v1")
    """

    def __init__(
        self,
        client: McpClient,
        *,
        provider: Provider = AWESUN,
        approver: Approver | None = None,
        actor: str = "灵眸助手",
        audit_path: Path = AUDIT_PATH,
        max_ops_per_session: int = 200,
        session_ttl_min: float = 60.0,
        approval_required: frozenset[str] = DEFAULT_APPROVAL_REQUIRED,
        dry_run: bool = False,
    ) -> None:
        self.client = client
        self.provider = provider
        self.approver = approver
        self.actor = actor
        self.audit_path = audit_path
        self.max_ops_per_session = max_ops_per_session
        self.session_ttl_min = session_ttl_min
        self.approval_required = approval_required
        self.dry_run = dry_run

    # ---------- 会话生命周期 ----------

    def session(self, target: str, *, customer: str = "", approved_by: str = "",
                profile: str = "assist") -> "_SessionCtx":
        """开一个会话上下文。退出时自动断开 + 写审计。

        `approved_by` 是**谁同意的**：客户自己点头写客户标识，大哥点头写他 QQ 号。
        空字符串 = 没人同意，第一次 connect 会被审批门挡掉。
        """
        if profile not in PROFILES:
            raise RemoteRefused(f"profile 只能是 {sorted(PROFILES)}，给的是 {profile!r}")
        return _SessionCtx(self, Session(target=str(target).strip(), customer=customer,
                                         approved_by=approved_by, profile=profile,
                                         provider=self.provider.key))

    def check_target(self, target: Any) -> None:
        """识别码/设备码格式检查。两家都是 9-10 位数字，所以合成一条。"""
        d = str(target or "").strip().replace(" ", "")
        if not d.isdigit() or not (9 <= len(d) <= 10):
            raise RemoteRefused(
                f"{self.provider.target_label} 应该是 9-10 位数字，给的是 {target!r}"
            )

    async def close_session(self, s: Session) -> None:
        if s.ended:
            return
        # 先标「已结束」：AI 操作员、实时画面每次动手前都查它，标上就不会再有新动作
        s.ended = True
        if s.connected:
            # **断开必须绕过「会话已结束 / 超时长 / 超次数」这几道闸**（`_force`）。
            # 以前这里走普通 _call，刚标完 ended 就被自己的「会话已经结束了」拦下 ——
            # 2026-10-16 真机发现：/远程断、AI 做完自动断开，**向日葵那边从来没真断过**，
            # 审计里一条 disconnect 都没有，control_sessions 里会话一直挂着（客户电脑一直开着门）。
            # 超时长、超次数也同理：正是这种时候最该断，不能被上限拦住
            try:
                await self._call(None, "disconnect", s, _force=True, _count=False)   # 收尾不算一次操作
            except Exception as e:      # 断开失败也要把收尾走完（审计、关客户端）
                log.warning("断开 %s 出错（不影响收尾，但向日葵那边可能还连着）：%s", mask_target(s.target), e)
        self._audit({"action": "session_end", "target": s.target, "customer": s.customer,
                     "approved_by": s.approved_by, "ops": s.ops, "minutes": round(s.minutes, 1)})

    async def start_session(self, s: Session) -> Session:
        """开一个会话并记一条审计。**给需要跨消息保持会话的调用方用**
        （`bot/remote/flow.py` 的 `/连` 之后要一直连着，不能包在 `with` 里）。

        `with op.session(...)` 那条路也走这里，两边的审计格式保持一致。
        """
        self._audit({"action": "session_start", "target": s.target, "customer": s.customer,
                     "approved_by": s.approved_by, "profile": s.profile})
        return s

    # ---------- 面向机器人的语义动作 ----------

    async def list_devices(self, keyword: str = "", limit: int = 20) -> dict[str, Any]:
        """读设备列表。只读，随便调。"""
        return await self._call(None, "listDevices", None, keyword=keyword, limit=limit)

    async def connect(self, s: Session, code: str = "") -> dict[str, Any]:
        """连上客户的机器。`code` 是验证码/密码（只有 ToDesk 那条用得上）。

        向日葵这条路：MCP 不接验证码，验证码那步在客户端的弹窗/授权里，
        **所以客户必须在自己电脑上点同意**——这正好是我们想要的形态。
        """
        self.check_target(s.target)
        if code and not self.provider.supports_password:
            raise RemoteRefused(f"{self.provider.label} 的 MCP 不接验证码参数，别白传")
        out = await self._call(s, "connect", s, mode="desktop", password=code)
        sid = out.get("session_id") or ""
        if sid:
            s.session_id = str(sid)
        s.connected = bool(sid) or out.get("status") in ("ok", "success", True)
        return out

    async def screenshot(self, s: Session) -> dict[str, Any]:
        """看一眼客户屏幕。向日葵返回的是 `image_path`（存盘的图片），ToDesk 是 base64。"""
        return await self._call(s, "screenshot", s)

    async def frame(self, s: Session) -> dict[str, Any]:
        """实时画面的一帧（`bot/remote/live.py` 后台一秒拉好几次用）。

        跟 `screenshot()` 是同一个工具、同一套门禁（白名单 / 会话结束 / 时长上限），
        **但不计操作次数、不逐帧写审计**：一秒几帧，计数会把「一单最多几次操作」撞满，
        写审计会把 jsonl 撑爆。看画面不是在动客户的电脑，开始/结束由 live.py 各记一条。
        """
        return await self._call(s, "screenshot", s, _count=False, _audit=False)

    def note(self, rec: dict[str, Any]) -> None:
        """给别的层记一条审计（格式跟动作那几条一样）。"""
        self._audit(dict(rec))

    async def click(self, s: Session, x: float, y: float, *, button: str = "left",
                    clicks: int = 1) -> dict[str, Any]:
        """点客户屏幕某处。**坐标是归一化的 0~1**（两家都这样，不是像素）。

        先 `screenshot()` 看准了再点，别瞎点。
        """
        self._check_xy(x, y)
        return await self._call(s, "click", s, x=x, y=y, button=button, clicks=clicks)

    async def move(self, s: Session, x: float, y: float) -> dict[str, Any]:
        self._check_xy(x, y)
        return await self._call(s, "move", s, x=x, y=y)

    async def type_text(self, s: Session, text: str, *, delay: int = 30) -> dict[str, Any]:
        """逐字打字。**先确保输入框有焦点**（click 一下再打）。"""
        return await self._call(s, "type", s, text=text, delay=delay)

    async def paste(self, s: Session, text: str) -> dict[str, Any]:
        """粘长文本（比逐字快）。向日葵这条走剪贴板同步。"""
        return await self._call(s, "paste", s, text=text)

    async def press(self, s: Session, keys: str | list[str]) -> dict[str, Any]:
        return await self._call(s, "press", s, keys=keys if isinstance(keys, list) else [keys])

    async def hotkey(self, s: Session, keys: list[str]) -> dict[str, Any]:
        """组合键，如 `["control", "v"]` 粘贴。"""
        return await self._call(s, "hotkey", s, keys=keys)

    async def scroll(self, s: Session, x: float, y: float, *, direction: str = "down",
                     count: int = 3) -> dict[str, Any]:
        self._check_xy(x, y)
        return await self._call(s, "scroll", s, x=x, y=y, direction=direction, count=count)

    async def wait(self, s: Session, ms: int = 500) -> dict[str, Any]:
        return await self._call(s, "wait", s, ms=ms)

    async def run_command(self, s: Session, command: str, args: list[str] | None = None) -> dict[str, Any]:
        """在客户机器上跑命令。**最强权限，必须审批。**"""
        return await self._call(s, "runCommand", s, command=command, args=args)

    async def raw(self, s: Session | None, action: str, **kw: Any) -> dict[str, Any]:
        """兜底：走白名单校验的动作，但参数自己给。用之前想清楚为什么要绕过语义化封装。"""
        return await self._call(s, action, s, **kw)

    # ---------- 内部：门禁 + 审计 ----------

    def _check_xy(self, x: float, y: float) -> None:
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise RemoteRefused(f"坐标要归一化到 0~1，给的是 ({x}, {y})")

    async def _call(self, s: Session | None, action: str, session: Session | None = None,
                    *, _count: bool = True, _audit: bool = True, _force: bool = False,
                    **kw: Any) -> dict[str, Any]:
        # 用哪个会话对象：s 是「判定用」，session 是「带 session_id 的那个」
        sess = session if session is not None else s
        profile = sess.profile if sess is not None else "assist"

        if action not in PROFILES[profile]:
            raise RemoteRefused(f"「{action}」不在 {profile} 档白名单里。要放开就改 PROFILES，别绕")
        if action not in self.provider.tools:
            raise RemoteRefused(f"{self.provider.label} 不支持「{action}」")

        if sess is not None and not _force:   # _force 只给断开用（见 close_session）
            if sess.ended:
                raise RemoteRefused("会话已经结束了")
            if sess.minutes > self.session_ttl_min:
                raise RemoteRefused(
                    f"会话开了 {sess.minutes:.0f} 分钟，超过 {self.session_ttl_min:.0f} 分钟上限，重开一单"
                )
            if sess.ops >= self.max_ops_per_session:
                raise RemoteRefused(f"这一单操作 {sess.ops} 次，到上限了（防失控）")

        if action in self.approval_required and not await self._approved(sess, action, kw):
            raise RemoteRefused(f"「{action}」需要人点头才算数，这次没有")

        tool = self.provider.tool(action)
        params = self.provider.params(action, session=sess, **kw)

        started = time.time()
        try:
            if self.dry_run:
                result: dict[str, Any] = {"dry_run": True, "would_call": tool, "params": scrub(params)}
            else:
                result = await self.client.call_tool(tool, params)
        except Exception as e:
            # 失败的也计数：不然反复失败重试能无限次
            if sess is not None and _count:
                sess.ops += 1
            if not _audit:
                raise
            self._audit({"action": action, "tool": tool, "params": scrub(params),
                         "target": sess.target if sess else "", "ok": False,
                         "error": f"{type(e).__name__}: {e}",
                         "ms": int((time.time() - started) * 1000)})
            raise
        else:
            # 只有真发出去了才计数。**别挪到 finally**：那样被白名单/审批挡下的也算，
            # 上限会被「拒几次」撞满，反而把正常操作挤掉（2026-10-16 踩过）
            if sess is not None and _count:
                sess.ops += 1

        if not _audit:
            return result
        self._audit({"action": action, "tool": tool, "params": scrub(params),
                     "target": sess.target if sess else "", "customer": sess.customer if sess else "",
                     "ok": True, "ms": int((time.time() - started) * 1000),
                     "result": _summarize(result)})
        return result

    async def _approved(self, s: Session | None, action: str, params: dict[str, Any]) -> bool:
        if s is not None and s.approved_by:
            return True  # 开单时就有人点过头
        if self.approver is None:
            return False
        try:
            return bool(await self.approver(action, s.target if s else "", _describe(self.provider, action, params)))
        except Exception as e:
            log.warning("审批回调自己炸了，当没同意处理：%s", e)
            return False

    def _audit(self, rec: dict[str, Any]) -> None:
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "actor": self.actor,
               "provider": self.provider.key, **rec}
        log.info("远程审计 %s", json.dumps(rec, ensure_ascii=False)[:400])
        try:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError as e:
            log.warning("审计日志写不进去（继续干活，但这事要修）：%s", e)


class _SessionCtx:
    """`async with op.session(...) as s:` 的壳，退出时保证收尾。"""

    def __init__(self, op: RemoteOperator, session: Session) -> None:
        self.op = op
        self.session = session

    async def __aenter__(self) -> Session:
        return await self.op.start_session(self.session)

    async def __aexit__(self, *exc: object) -> None:
        await self.op.close_session(self.session)


def _describe(p: Provider, action: str, params: dict[str, Any]) -> str:
    """给人看的一句话，审批时显示。"""
    t = params.get("fastcode") or params.get("device_id") or params.get("remote_id") or ""
    return {
        "connect": f"连接客户设备 {mask_target(t)}（{p.label}）",
        "runCommand": f"在设备 {mask_target(t)} 上执行命令：{str(params.get('command', ''))[:80]}",
    }.get(action, f"{action}（设备 {mask_target(t)}）")


def _summarize(result: dict[str, Any]) -> dict[str, Any]:
    """审计里不存截图 base64（一行几 MB 会撑爆日志），只留大小。"""
    out = {k: v for k, v in result.items() if k != "image_base64"}
    if "image_base64" in result:
        out["image_base64"] = f"<{len(result['image_base64'] or '')} 字节>"
    return out
