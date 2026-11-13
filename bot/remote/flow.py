"""远程协助的私聊流程：问客户 → 收识别码 → **等大哥点头** → 才连。

```
客户 @我（说「能远程帮我看看吗」）
   │
   ├─ 私聊客户：你有装向日葵吗？ ──客户说没有──▶ 结束（发安装地址）
   │                              └─客户说有───▶ 私聊要识别码
   │                                              │
   │                                     客户发来 9-10 位数字
   │                                              ▼
   └──────────────────────────────────── 私聊大哥：「等你点头」
                                                  │
                                        /连 编号 ──┴── /不连 编号 理由
                                            │                └──▶ 已拒绝（告诉客户）
                                            ▼
                                      连上 → 截图发给大哥 → 等他弄完 /远程断
```

**红线（大哥 2026-10-16 亲口定的）：必须他私聊同意之后才可以远程，不许自动连。**
所以「能不能连」只有一条路：`handle_staff()` 收到 `/连 编号` → `store.approve()` → 才
`_connect()`。`_connect()` 自己也要再查一遍 `approved_by`，别处调它照样拦得住 —— 靠调用方
自觉的红线不叫红线。

**为什么流程长在私聊里**：识别码是客户机器的门牌号，发群里等于告诉所有人他家住哪。群里只
出现「我叫了几号人去帮你」这种不泄露信息的短句，识别码一律走私聊。

**这一层坏了不影响别的**（fail-open 的镜像：这边是 fail-closed）。识别码、审批、连接
任何一步出错都只影响这一单，问答、审批、转人工照常跑。没配 `REMOTE_ENABLED` 时
`register()` 直接返回空壳，一个处理器都不注册。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from ..commands import GROUP, PRIVATE, claim
from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import GroupMessage, PrivateMessage
from ..onebot import ApiError, OneBotClient, image_b64, text
from . import store as st
from .assist import AutoAssist, build_llm
from .live import LiveScreen
from .mcp_client import McpClient, for_provider
from .operator import RemoteOperator, RemoteRefused
from .provider import Provider, pick

log = logging.getLogger(__name__)

# ---- 话术。客户看得到的，一个字都别乱改（大哥看过版本）----
ASK_TEXT = (
    "看你这个问题，我远程帮你看会更快点 🖥\n"
    "你电脑上有装「向日葵远程控制」吗？\n"
    "· 有的话回我「有」，我告诉你下一步\n"
    "· 没有的话回「没有」，我发你安装地址"
)
NO_SOFTWARE_TEXT = (
    "没关系，那你先去 https://sunlogin.oray.com/download 下个向日葵（个人版免费就行），\n"
    "装好之后回到群里 @我 说一声，我再来帮你 👌"
)
CODE_TEXT = (
    "好 👍 打开向日葵，把主界面上那串「识别码」发我（9-10 位数字，像 497 484 688 这样）。\n"
    "\n"
    "等下我这边申请连接时，你电脑上会弹一个提示，点「同意」我才能看到你屏幕 ——\n"
    "不点同意我什么都看不到，你随时可以断开。"
)
CODE_BAD_TEXT = "这串数字我没认出来 🤔 识别码是 9-10 位纯数字，再发我一次？"
WAIT_TEXT = "收到 ✅ 我先跟老板报一下，他点头我就连过来帮你看，几分钟内给你回话。"
STILL_WAIT_TEXT = "已经报给老板了，他那边一看我就连过来，你稍等两分钟 🙏"
REJECT_TEXT = "老板说这次先不远程，你的问题我让他在群里回你 👌"
DONE_TEXT = "这次就先到这儿，问题解决了吗？还有事随时 @我 👋"
AUTO_DONE_TEXT = "弄好了 ✅ 我这边已经断开连接了，你试一下能不能用。还有问题随时 @我 👋"
APPROVE_NUDGE_TEXT = "我这边在申请连你电脑了 🖥 你屏幕上应该弹了一个向日葵的窗口，点「同意」我就能看到了～"

# ---- 给大哥的私聊 ----
def _approval_text(rec: st.Assist, provider: Provider) -> str:
    return (
        f"🔔 远程协助 #{rec.id} 等你点头\n"
        f"客户：{rec.who}｜群 {rec.group_id or '私聊'}\n"
        f"识别码：{rec.target}（{provider.label}）\n"
        f"他电脑上弹连接请求时需要他自己点同意。\n"
        f"\n"
        f"/连 {rec.id}        ← 同意，我连过去（连上给你发一张他屏幕的截图）\n"
        f"/连 {rec.id} 任务描述  ← 让 AI 自己上手做（开了 REMOTE_AUTO_ASSIST 才有）\n"
        f"/不连 {rec.id} 理由  ← 不连\n"
        f"/远程              ← 看所有还没结的单"
    )


def _list_text(rows: list[st.Assist]) -> str:
    if not rows:
        return "现在没有待处理的远程协助。"
    lines = [f"远程协助 {len(rows)} 条："]
    for r in rows:
        extra = f"识别码 {r.target}" if r.target else ""
        lines.append(f"#{r.id} {st.STATE_CN.get(r.state, r.state)}｜{r.who}｜群 {r.group_id or '私聊'} {extra}")
    lines.append(
        "——\n"
        "/连 编号   同意并连过去\n"
        "/不连 编号 理由\n"
        "/远程断 编号 断开已经连上的"
    )
    return "\n".join(lines)


# 客户回「有」的几种说法。宁可多认几个：客户打错一个字就卡住，他只会觉得机器人坏了
_YES = ("有", "有啊", "有哦", "装了", "装好了", "是的", "是", "嗯", "可以", "好", "好啊", "行", "有的")
_NO = ("没有", "没装", "无", "不用", "不需要", "算了", "不了", "没", "木有")

# 识别码可能被客户连着空格一起抄过来（主界面显示就是 497 484 688）
_CODE_RE = re.compile(r"(\d[\d\s\-]{7,16}\d)")

_active_flow: "RemoteFlow | None" = None

# 等放行时看到这些状态 = 这次请求已经没了（对方拒绝 / 弹窗超时），再等也不会 success
_DEAD_STATES = frozenset({"disconnect", "disconnected", "failed", "rejected"})

# 截图存哪。做成模块级变量是为了**测试能替换掉**，不然跑用例会往真 data/ 里写文件
SHOTS_DIR = Path("data/remote_shots")


def is_active(user_id: int) -> bool:
    """给 `bot/handlers/dm.py` 用：这个客户正在远程协助流程里，私聊归那条流程管。

    没有流程在跑（或整层没启用）时一律返回 False —— dm 那边照旧回它的固定话。
    """
    return _active_flow is not None and _active_flow.has_open(user_id)


def parse_code(body: str) -> str:
    """从客户那串字里抠识别码。抠不出来返回空串。

    允许空格和横杠（主界面显示就带空格），抠完去掉分隔符；不是 9-10 位就当没抠到。
    """
    m = _CODE_RE.search(body or "")
    if not m:
        return ""
    digits = re.sub(r"\D", "", m.group(1))
    return digits if 9 <= len(digits) <= 10 else ""


class Live:
    """一个开着的远控会话。断开时要一起收掉 MCP 客户端。"""

    def __init__(self, client: McpClient, operator: RemoteOperator, session: Any) -> None:
        self.client = client
        self.operator = operator
        self.session = session
        self.opened = time.time()
        self.screen: LiveScreen | None = None   # AI 操作员上手时才开的实时画面

    async def close(self) -> None:
        # 先停实时画面：会话关了它还在拉帧，只会刷一串「会话已经结束」
        if self.screen is not None:
            await self.screen.stop()
            self.screen = None
        await self.operator.close_session(self.session)
        await self.client.aclose()


Connector = Callable[[st.Assist], Awaitable[tuple[Live, dict[str, Any]]]]


class RemoteFlow:
    def __init__(self, settings: Settings, bot: OneBotClient, store: st.RemoteStore,
                 connector: Connector | None = None) -> None:
        self.settings = settings
        self.bot = bot
        self.store = store
        self.connector = connector or self._real_connect
        self._live: dict[int, Live] = {}
        self._task: asyncio.Task[None] | None = None
        self._auto: set[asyncio.Task[None]] = set()   # 正在跑的 AI 操作员任务

    # ---------- 对外：大哥的指令 / 客户的私聊 ----------

    async def handle_staff(self, ev: PrivateMessage, body: str) -> None:
        """大哥私聊打指令。只有这里能把单子推到「已连上」。"""
        parts = body.split()
        cmd = parts[0].lower()
        if cmd in ("/远程", "/远程列表"):
            await self._say(ev.user_id, _list_text(self.store.open_all()))
            return
        if cmd in ("/连", "/同意连"):
            await self._approve_and_connect(ev.user_id, parts)
            return
        if cmd in ("/不连", "/拒绝连"):
            await self._reject(ev.user_id, parts)
            return
        if cmd in ("/远程断", "/断开"):
            await self._manual_disconnect(ev.user_id, parts)
            return

    async def _approve_and_connect(self, admin: int, parts: list[str]) -> None:
        rec = await self._pick(admin, parts, "/连 编号")
        if rec is None:
            return
        if not rec.is_open:
            await self._say(admin, f"#{rec.id} 已经结束了（{st.STATE_CN.get(rec.state, rec.state)}）")
            return
        if not rec.target:
            await self._say(admin, f"#{rec.id} 还没收到识别码，等他发过来再说。")
            return

        # **红线的落点**：先记账（谁同意的），再去连。连的动作只认这一条路径
        self.store.approve(rec.id, admin)
        rec = self.store.get(rec.id) or rec
        await self._say(admin, f"收到，去连 #{rec.id}（{rec.who}，识别码 {rec.target}）…")
        try:
            live, shot = await self.connector(rec)
        except (RemoteRefused, Exception) as e:  # noqa: B014 - 说清楚：远端任何错都要反馈给人
            log.warning("远程协助 #%s 连接失败：%s", rec.id, e)
            self.store.set_state(rec.id, st.WAITING, note=f"连接失败：{e}")
            await self._say(admin, f"#{rec.id} 没连上 ❌\n{type(e).__name__}: {str(e)[:220]}\n\n"
                                   f"再试一次发 /连 {rec.id}")
            return

        self._live[rec.id] = live
        self.store.set_state(rec.id, st.CONNECTED)
        task = " ".join(parts[2:]).strip()      # `/连 2 帮他把地址填好` —— 后面那句当任务
        await self._say(admin, f"#{rec.id} 已连上 ✅ 正在看他屏幕。\n弄完发 /远程断 {rec.id} 断开。")
        if self.settings.remote_auto_assist:
            # AI 自己上手：它看的是实时画面，不再给大哥发截图（大哥要看就开自己的向日葵）
            self._start_auto(rec, live, admin, task)
        else:
            await self._send_shot(admin, rec, shot)   # 大哥自己动手：给他一张屏幕看看情况

    def _start_auto(self, rec: st.Assist, live: Live, admin: int, task: str) -> None:
        """连上之后交给 AI 操作员（`REMOTE_AUTO_ASSIST=true` 才走这儿）。

        **必须后台跑**：一步 = 截一张图 + 调一次视觉模型，十几秒起步；卡在指令处理里的话
        大哥那条 `/连` 半天不返回，他还以为没生效。`flow.close()` 会把这些任务全掐掉。
        """
        dry = self.settings.remote_auto_dry_run
        steps = self.settings.remote_auto_steps

        reports: asyncio.Queue[str | None] = asyncio.Queue()

        async def reporter() -> None:
            """按顺序把进度发给大哥。收到 None 就收工。"""
            while True:
                msg = await reports.get()
                if msg is None:
                    return
                await self._say(admin, msg)

        async def run() -> None:
            outcome = ""
            sender = asyncio.create_task(reporter(), name=f"auto-report-{rec.id}")
            llm = build_llm(self.settings)
            screen = LiveScreen(live.operator, live.session, interval=self.settings.remote_live_interval)
            live.screen = screen
            try:
                await screen.start()
                await self._say(admin, f"#{rec.id} 我自己上手了（最多 {steps} 步）"
                                       + ("　【演练模式：只看不动】" if dry else ""))

                async def on_step(n: int, what: str) -> None:
                    # **不等 QQ 发完**：发一条私聊要走 NapCat、失败还会重试，等它就是让客户的
                    # 屏幕干等。塞进队列由后台按顺序发，AI 接着看下一帧
                    reports.put_nowait(f"#{rec.id} 第 {n} 步：{what}")

                auto = AutoAssist(
                    live.operator, live.session, llm,
                    model=self.settings.remote_auto_model or self.settings.vision_model,
                    # 主模型回空 / 分组里没有时换一次备用（以前只有调试脚本传了，线上没传）
                    fallback_model=self.settings.vision_fallback_model,
                    task=task, max_steps=steps, dry_run=dry, on_step=on_step, screen=screen,
                )
                summary = await auto.run()
                outcome = auto.outcome
            except Exception as e:      # 这一层坏了只影响这一单，不能带塌别处
                log.exception("AI 操作员跑挂了（#%s）", rec.id)
                summary = f"我自己上手时出错了：{type(e).__name__}: {str(e)[:120]}"
            finally:
                frames = screen.frames
                await screen.stop()       # AI 停手就不再拉帧，别白占远控带宽
                if live.screen is screen:
                    live.screen = None
                try:
                    await llm.close()
                except Exception:
                    pass
            log.info("远程协助 #%s AI 操作员收手，实时画面共 %s 帧", rec.id, frames)
            reports.put_nowait(None)          # 进度先发完，总结最后到，顺序不乱
            try:
                await asyncio.wait_for(sender, timeout=30)
            except (asyncio.TimeoutError, Exception):
                sender.cancel()
            if outcome == "done" and await self._finish_auto(rec.id):
                await self._say(admin, f"#{rec.id} {summary}\n已自动断开，也跟客户说了。")
                return
            # 没做完（放弃 / 要客户自己登录 / 出错 / 到步数上限）：**连接留着**给大哥接手
            await self._say(admin, f"#{rec.id} {summary}\n连接还开着，你接手或发 /远程断 {rec.id} 断开。")

        t = asyncio.create_task(run(), name=f"auto-assist-{rec.id}")
        self._auto.add(t)
        t.add_done_callback(self._auto.discard)

    async def _finish_auto(self, rec_id: int) -> bool:
        """AI 说做完了：断开、结单、私聊告诉客户。返回 True = 这边收的尾。

        大哥中途已经 /远程断 过（会话不在 `_live` 里了）就返回 False，别再重复告诉客户。
        **只在 done 时调**：放弃 / 出错时连接要留给大哥接手。
        """
        live = self._live.pop(rec_id, None)
        if live is None:
            return False
        try:
            await live.close()
        except Exception as e:      # 断不干净也要结单，不然客户那边一直显示「已连上」
            log.warning("远程协助 #%s AI 做完自动断开时出错：%s", rec_id, e)
        self.store.set_state(rec_id, st.DONE, note="AI 做完自动断开")
        rec = self.store.get(rec_id)
        if rec is not None:
            await self._say(rec.user_id, AUTO_DONE_TEXT)
        log.info("远程协助 #%s AI 做完了，已自动断开并通知客户", rec_id)
        return True

    async def _reject(self, admin: int, parts: list[str]) -> None:
        rec = await self._pick(admin, parts, "/不连 编号 理由")
        if rec is None:
            return
        reason = " ".join(parts[2:]).strip()
        self.store.set_state(rec.id, st.REJECTED, note=reason or f"超管 {admin} 拒绝")
        await self._say(admin, f"#{rec.id} 已标记不连。")
        await self._say(rec.user_id, REJECT_TEXT)
        log.info("超管 %s 拒绝了远程协助 #%s（%s）理由=%r", admin, rec.id, rec.who, reason)

    async def _manual_disconnect(self, admin: int, parts: list[str]) -> None:
        rec = await self._pick(admin, parts, "/远程断 编号")
        if rec is None:
            return
        live = self._live.pop(rec.id, None)
        if live is None:
            await self._say(admin, f"#{rec.id} 现在没有开着的会话。")
            return
        await live.close()
        self.store.set_state(rec.id, st.DONE)
        await self._say(admin, f"#{rec.id} 已断开 ✅")
        await self._say(rec.user_id, DONE_TEXT)

    async def _advance(self, rec: st.Assist, body: str) -> None:
        """客户私聊说了一句，按当前状态往下推。"""
        low = body.strip()
        if rec.state == st.ASKED:
            if any(w in low for w in _NO):
                self.store.set_state(rec.id, st.CANCELLED, note="客户说没装")
                await self._say(rec.user_id, NO_SOFTWARE_TEXT)
                return
            if any(w in low for w in _YES):
                self.store.set_state(rec.id, st.COLLECTING)
                await self._say(rec.user_id, CODE_TEXT)
                return
            await self._say(rec.user_id, "回我「有」或者「没有」就行 🙂\n\n" + ASK_TEXT)
            return

        if rec.state == st.COLLECTING:
            code = parse_code(low)
            if not code:
                await self._say(rec.user_id, CODE_BAD_TEXT)
                return
            self.store.set_state(rec.id, st.WAITING, target=code)
            await self._say(rec.user_id, WAIT_TEXT)
            await self._tell_admins(_approval_text(self.store.get(rec.id) or rec, self._provider()))
            log.info("远程协助 #%s 收到识别码（%s），等超管点头", rec.id, rec.who)
            return

        if rec.state == st.WAITING:
            await self._say(rec.user_id, STILL_WAIT_TEXT)
            return

        if rec.state == st.CONNECTED:
            await self._say(rec.user_id, "已经连上了，我看到你屏幕了，稍等我两分钟 👀")
            return

    # ---------- 群里：客户求助 / 自己人叫单 ----------

    async def handle_group(self, ev: GroupMessage) -> None:
        if not self.settings.group_enabled(ev.group_id):
            return
        body = ev.plain_text.strip()
        staff = ev.user_id in self.settings.trusted

        # 自己人：/远程 @客户 —— 客服见过问题之后直接叫单，不用等客户自己开口
        if staff and body.startswith("/远程"):
            target = _at_target(ev)
            if not target:
                await self._group_say(ev.group_id, "用法：/远程 @客户　（先 @ 上要帮的那个人）")
                return
            await self._start(target, ev.group_id, nickname="", source=f"自己人 {ev.user_id} 叫的")
            await self._group_say(ev.group_id, "好，我去私聊他 👌")
            return

        if staff:
            return

        # 客户：@我 + 说了远程相关的词
        if not ev.at_me or not self._hit_trigger(body):
            return
        if self.store.open_of(ev.user_id) is not None:
            return  # 这一单还没结，别再问一遍
        if self.store.asked_within(ev.user_id, self.settings.remote_ask_cooldown):
            return  # 最近问过了，别当复读机
        await self._start(ev.user_id, ev.group_id, nickname=ev.sender_name, source="客户自己问的")
        await self._group_say(ev.group_id, f"我私聊你一下哈 {ev.sender_name} 👉")

    def _hit_trigger(self, body: str) -> bool:
        return any(k in body for k in self.settings.remote_triggers)

    async def _start(self, user_id: int, group_id: int, *, nickname: str, source: str) -> int:
        rec_id = self.store.create(user_id=user_id, nickname=nickname, group_id=group_id,
                                   provider=self.settings.remote_provider, source=source)
        log.info("远程协助 #%s 开单：%s（群 %s，%s）", rec_id, user_id, group_id, source)
        await self._say(user_id, ASK_TEXT)
        return rec_id

    # ---------- 连接（只有 /连 会走到这儿）----------

    async def _real_connect(self, rec: st.Assist) -> tuple[Live, dict[str, Any]]:
        """真连。**先查 approved_by**：没大哥点头，谁调都别想连。"""
        fresh = self.store.get(rec.id)
        if fresh is None or fresh.approved_by is None:
            raise RemoteRefused(f"远程协助 #{rec.id} 没有超管点头，不许连（红线）")

        p = self._provider()
        url, token = self._credentials(p)
        client = for_provider(p, url=url, token=token, transport=self.settings.remote_transport)
        await client.connect()
        try:
            op = RemoteOperator(
                client, provider=p, actor=f"灵眸助手(#{rec.id})",
                max_ops_per_session=self.settings.remote_max_ops,
                session_ttl_min=self.settings.remote_session_ttl,
            )
            session = await op.start_session(
                op.session(fresh.target, customer=fresh.who, approved_by=str(fresh.approved_by),
                           profile=self.settings.remote_profile).session
            )
            out = await op.connect(session)
            # **连上 ≠ 能操作**：向日葵不接验证码参数，对方没点同意时状态停在
            # `waitingInputVerifyCode`，这时截图会一直等（实测把它当超时抛出来）。
            # 2026-10-16 实测记录：第一次 dial 返回 waitingInputVerifyCode，对方放行后
            # 再 dial 立刻 `success`。所以这里必须等状态，不能连上就截图
            nudged = False

            async def nudge(state: str) -> None:
                # 卡在等对方放行：**主动催客户一句**。2026-10-16 实测第一次 dial 几乎都停在这儿，
                # 以前只等 25 秒就报失败，客户还没找到那个弹窗，大哥就得再发一次 /连
                nonlocal nudged
                if nudged or state != "waitingInputVerifyCode":
                    return
                nudged = True
                await self._say(fresh.user_id, APPROVE_NUDGE_TEXT)

            state = str(out.get("state") or "")
            if state != "success":
                await nudge(state)
                state = await self._wait_ready(client, session.session_id,
                                               timeout=self.settings.remote_approve_wait, on_state=nudge)
            if state in _DEAD_STATES:
                raise RemoteRefused(
                    f"对方没放行（状态 {state}）—— 多半是他没点「同意」、点了拒绝，或者弹窗超时了。"
                    f"跟他确认一下再发 /连"
                )
            if state != "success":
                raise RemoteRefused(
                    f"对方还没放行（等了 {self.settings.remote_approve_wait:.0f} 秒，状态 {state or '未知'}）"
                    f"—— 他电脑上应该弹了一个连接请求，让他点「同意」；要是弹的是验证码，让他把验证码发给你"
                )
            shot = await op.screenshot(session)
        except Exception:
            # **连不上也要把向日葵那边的会话断掉**：以前只关了 MCP 客户端，向日葵那边的会话一直挂着
            # （2026-10-16 真机：90 秒没人点同意，control_sessions 里还留着那一条）。
            # 挂着的会话下次 /连 会被复用、状态说不清，客户电脑上的请求弹窗也可能一直在
            try:
                session.connected = True     # connect 回了 session_id 但没放行时 connected 可能是 False，照样要断
                await op.close_session(session)
            except Exception as e:
                log.warning("连接失败后断开会话也失败了：%s", e)
            await client.aclose()   # 连不上别把子进程留着
            raise
        return Live(client, op, session), shot

    async def _wait_ready(self, client: McpClient, session_id: str, timeout: float = 25.0,
                          on_state: Callable[[str], Awaitable[None]] | None = None,
                          poll: float = 1.0) -> str:
        """等对方放行。返回最后一次看到的状态，`success` = 可以动手了。

        每秒查一次（以前 2 秒）：客户一点同意，最多晚 1 秒就能开始。`on_state` 每看到一个状态调一次，
        用来催客户。"""
        if not session_id:
            return ""
        deadline = time.time() + timeout
        state = ""
        ended = 0
        while time.time() < deadline:
            try:
                r = await client.call_tool("control_connect_state", {"session_id": session_id})
            except Exception as e:   # 查状态都失败就没必要再等
                log.warning("查会话状态失败：%s", e)
                return state
            state = str(r.get("state") or "")
            if state == "success":
                return state
            # 对方拒绝 / 弹窗超时之后状态会变成 disconnect，再等也不会 success 了。
            # 连着几次都是它才算数：刚 dial 那一下状态还没稳，别一眼就判死
            ended = ended + 1 if state in _DEAD_STATES else 0
            if ended >= 3:
                return state
            if on_state is not None:
                try:
                    await on_state(state)
                except Exception as e:
                    log.debug("催客户那句没发出去：%s", e)
            await asyncio.sleep(poll)
        return state

    def _provider(self) -> Provider:
        return pick(self.settings.remote_provider)

    def _credentials(self, p: Provider) -> tuple[str, str]:
        """MCP 入口地址 + 凭证。**向日葵的入口是宿主机上那个 HTTP 服务**
        （`AWESUN_MCP_URL`，容器里写 host.docker.internal）；token 是客户端 API 的凭证，
        服务端自己拿去用，我们只是转交。"""
        if p.key == "awesun":
            return self.settings.awesun_mcp_url, self.settings.awesun_api_token
        return self.settings.todesk_mcp_url, self.settings.todesk_mcp_token

    async def _send_shot(self, admin: int, rec: st.Assist, shot: dict[str, Any]) -> None:
        """把客户屏幕截图发给大哥。截图存一份到 data/remote_shots/，审计要。"""
        data = b""
        if shot.get("image_base64"):
            try:
                data = base64.b64decode(str(shot["image_base64"]))
            except (ValueError, TypeError):
                data = b""
        elif shot.get("image_path"):
            try:
                data = Path(str(shot["image_path"])).read_bytes()
            except OSError as e:
                log.warning("截图读不出来：%s", e)
        if not data:
            await self._say(admin, "（这张截图没取到，自己上去看吧）")
            return
        try:
            out = SHOTS_DIR
            out.mkdir(parents=True, exist_ok=True)
            path = out / f"{rec.id}-{time.strftime('%Y%m%d-%H%M%S')}.jpg"
            path.write_bytes(data)
            log.info("远程协助 #%s 截图存到 %s", rec.id, path)
        except OSError as e:
            log.warning("截图存不下来（不影响发出去）：%s", e)
        try:
            await self.bot.send_private_msg(admin, [text(f"#{rec.id} 他现在的屏幕："), image_b64(data)])
        except (ApiError, ConnectionError) as e:
            log.warning("发截图给超管失败：%s", e)

    # ---------- 收尾 ----------

    def has_open(self, user_id: int) -> bool:
        return self.store.open_of(user_id) is not None

    async def expire_once(self, now: float | None = None) -> int:
        """超时的单子收掉：等太久的标记失效，连太久的自动断开。返回收掉几条。"""
        closed = 0
        now = now or time.time()
        for rec in self.store.by_state(st.ASKED, st.COLLECTING, st.WAITING, limit=50):
            if _age_minutes(rec.updated_at, now) > self.settings.remote_wait_minutes:
                self.store.set_state(rec.id, st.EXPIRED, note="等超时")
                closed += 1
        for rec_id, live in list(self._live.items()):
            if (now - live.opened) / 60 > self.settings.remote_session_minutes:
                await live.close()
                self._live.pop(rec_id, None)
                self.store.set_state(rec_id, st.DONE, note="到时自动断开")
                rec = self.store.get(rec_id)
                if rec is not None:
                    await self._say(rec.user_id, "时间到了我先把连接断开了，还有问题再 @我 👌")
                closed += 1
        return closed

    async def loop(self) -> None:
        while True:
            try:
                await self.expire_once()
            except Exception:
                log.exception("远程协助清理循环出错（不影响别的）")
            await asyncio.sleep(60)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        # 先把 AI 操作员停掉：它还在动客户电脑，得赶在会话关掉之前收手
        for t in list(self._auto):
            t.cancel()
        for t in list(self._auto):
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._auto.clear()
        for rec_id, live in list(self._live.items()):
            try:
                await live.close()
            except Exception as e:  # 关不干净也不能拦住退出
                log.warning("退出时关闭远程会话 #%s 出错：%s", rec_id, e)
        self._live.clear()

    # ---------- 说话 ----------

    async def _say(self, user_id: int, body: str) -> None:
        try:
            await self.bot.send_private_msg(user_id, [text(body)])
        except (ApiError, ConnectionError) as e:
            log.warning("私聊 %s 失败：%s", user_id, e)

    async def _group_say(self, group_id: int, body: str) -> None:
        try:
            await self.bot.send_group_msg(group_id, [text(body)])
        except (ApiError, ConnectionError) as e:
            log.warning("群里说 %s 失败：%s", group_id, e)

    async def _tell_admins(self, body: str) -> None:
        for uid in sorted(self.settings.super_admins):
            await self._say(uid, body)

    async def _pick(self, admin: int, parts: list[str], usage: str) -> st.Assist | None:
        """从 `/连 3` 里取编号。编号写错 / 没有这一单都**回一句**：
        以前是一声不吭，大哥打错一个字会以为机器人没收到。"""
        if len(parts) < 2 or not parts[1].lstrip("#").isdigit():
            await self._say(admin, f"用法：{usage}\n发 /远程 看有哪些单子")
            return None
        rec = self.store.get(int(parts[1].lstrip("#")))
        if rec is None:
            await self._say(admin, f"没有 #{parts[1].lstrip('#')} 这一单，发 /远程 看看编号")
        return rec


def _at_target(ev: GroupMessage) -> int:
    """消息里 @ 的**别人**（不算 @ 机器人自己）。没有就返回 0。"""
    for seg in ev.message:
        if seg["type"] == "at":
            qq = str(seg["data"].get("qq") or "")
            if qq.isdigit() and int(qq) != ev.self_id:
                return int(qq)
    return 0


def _age_minutes(stamp: str, now: float) -> float:
    try:
        t = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return 0.0
    return (now - t) / 60


def register(dispatcher: Dispatcher, bot: OneBotClient, settings: Settings) -> RemoteFlow | None:
    """挂上远程协助。没开 `REMOTE_ENABLED` 或没配凭据就返回 None —— 一个处理器都不注册。

    返回的实例要留着，退出时 `await flow.close()` 收摊（断开会话、停循环）。
    """
    global _active_flow

    if not settings.remote_enabled:
        log.info("远程协助没开（REMOTE_ENABLED=false），不注册")
        return None
    p = pick(settings.remote_provider)
    _, token = (settings.awesun_api_url, settings.awesun_api_token) if p.key == "awesun" \
        else (settings.todesk_mcp_url, settings.todesk_mcp_token)
    if not token:
        log.error(
            "远程协助开着，但 %s 的凭证是空的，不注册（免得客户白等）。"
            "去向日葵客户端开「向日葵MCP」把 token 填进 .env 的 %s",
            p.label, p.token_env,
        )
        return None

    store = st.RemoteStore()
    flow = RemoteFlow(settings, bot, store)
    _active_flow = flow

    # 告诉别的处理器「这几个指令我接了」：admin.py 的「不认识的指令」才不会冤枉它们
    claim(PRIVATE, ("/远程", "/远程列表", "/连", "/同意连", "/不连", "/拒绝连", "/远程断", "/断开"))
    claim(GROUP, ("/远程",))

    @dispatcher.on("message.private")
    async def on_private(ev: PrivateMessage) -> None:
        if ev.user_id == ev.self_id or ev.user_id < 10000:
            return
        body = ev.plain_text.strip()
        if ev.user_id in settings.super_admins:
            if body.startswith("/"):
                await flow.handle_staff(ev, body)
            return
        rec = store.open_of(ev.user_id)
        if rec is None:
            return  # 不归我管：dm.py 会回他那句固定话
        if body.startswith("/"):
            return
        await flow._advance(rec, body)

    @dispatcher.on("message.group")
    async def on_group(ev: GroupMessage) -> None:
        await flow.handle_group(ev)

    flow._task = asyncio.create_task(flow.loop(), name="remote-expire")
    # 这一行要能一眼看出**AI 操作员开没开**（大哥上线后第一件事就是来日志里确认这个）。
    # 演练模式单独标出来：它只报「本来要做什么」，一步都不动客户的电脑
    auto = "关"
    if settings.remote_auto_assist:
        auto = "演练（只看不动）" if settings.remote_auto_dry_run else f"开（最多 {settings.remote_auto_steps} 步）"
    log.info("远程协助已启用 | %s | 档位=%s | AI 操作员=%s | 触发词=%s",
             p.label, settings.remote_profile, auto, "/".join(settings.remote_triggers))
    return flow
