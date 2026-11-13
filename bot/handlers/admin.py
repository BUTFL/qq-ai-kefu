"""超管私聊指令：/待批、/批准、/拒绝。

**第一道门是身份校验**：`ev.user_id in settings.super_admins`。不加这个，
任何人私聊机器人都能把人批进你的客户群。

`DRY_RUN` 不拦这里的指令——演练模式是用来验"规则判得对不对"的，
而 /批准 /拒绝 是你本人的决定，不是规则的判断，拦了只会让客户白等。
"""
from __future__ import annotations

import logging
import re

from .. import store as store_mod
from ..commands import PRIVATE, claim, claimed
from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import PrivateMessage
from ..onebot import ApiError, OneBotClient, text
from ..store import Store
from .approval import FLAG_GONE

log = logging.getLogger(__name__)

DEFAULT_REJECT_REASON = "请输入正确订单号"

# 主力是 /y /n /ls：短、全英文、手机上不用切输入法，也不会把「绝」打成「接」。
# 中文的仍然认（含 /拒接 这个实际打错过的写法），已经形成的手感不打断。
COMMANDS = {
    "/ls": "list", "/待批": "list", "/列表": "list",
    "/y": "approve", "/批准": "approve", "/同意": "approve",
    "/n": "reject", "/拒绝": "reject", "/拒接": "reject",
    "/help": "help", "/帮助": "help",
}

STATUS_CN = {
    store_mod.PENDING: "待批",
    store_mod.AUTO_APPROVED: "已自动放行",
    store_mod.APPROVED: "已批准",
    store_mod.REJECTED: "已拒绝",
    store_mod.EXPIRED: "已失效",
    store_mod.FAILED: "处理失败",
    store_mod.JOINED: "你在 QQ 上批了",
}

USAGE = (
    "指令：\n"
    "/ls              看还没处理的\n"
    "/y 7             放行 7 号\n"
    "/n 7 订单号不对   拒绝 7 号，理由发给对方\n"
    f"\n拒绝不写理由，默认发「{DEFAULT_REJECT_REASON}」\n"
    "中文的 /待批 /批准 /拒绝 也认\n"
    "\n全部功能和指令发 /命令"
)

_ID_HEAD = re.compile(r"(\d+)(.*)", re.S)
# 指令和编号之间漏空格：`/n5`、`/y6`、`/拒绝5`、`/n#5`。
# 非贪婪，所以 `/n5` 切成 `/n` + `5` 而不是 `/n5` + ``。
_CMD_GLUED = re.compile(r"^(/\S*?)\s*(#?\d.*)$", re.S)


def _normalize(parts: list[str]) -> list[str]:
    """把 `/n5订单号不对` 拆成 `["/n", "5订单号不对"]`。

    2026-09-22 真机实测：先发 `/n`、再发 `/n5`、第三次 `/n 5` 才成。
    `/n 5理由`（编号和理由之间漏空格）上次已经认了，这次补的是**指令和编号之间**
    漏空格。手机上打指令漏空格是常态，不该让人重打。
    只在第一段不是已知指令时才拆，`/ls` 这种完整指令原样放过。
    """
    if parts[0].lower() in COMMANDS:
        return parts
    m = _CMD_GLUED.match(parts[0])
    if m and m.group(1).lower() in COMMANDS:
        return [m.group(1), m.group(2), *parts[1:]]
    return parts


def _split_id(parts: list[str]) -> tuple[int | None, str]:
    """从 `/n 7 订单号不对` 里抠出编号和理由。

    `/n 7订单号不对` 这种**编号和理由之间没空格**的也认——实际用下来一漏空格
    就整条指令作废，还得重打一遍，这个坑不值得留给手机键盘。
    编号允许带 `#`，因为通知里显示的就是 `#7`，顺手复制过来会带上。
    """
    if len(parts) < 2:
        return None, ""
    m = _ID_HEAD.match(parts[1].strip().lstrip("#"))
    if not m:
        return None, ""
    glued, rest = m.group(2).strip(), " ".join(parts[2:]).strip()
    return int(m.group(1)), " ".join(x for x in (glued, rest) if x)


def register(dispatcher: Dispatcher, client: OneBotClient, settings: Settings, store: Store) -> None:
    # 告诉别的处理器「私聊里这些指令我接了」。放这儿而不是模块级：
    # 认领要和「真的注册了处理器」绑在一起，否则会出现认领了却没人接的静默
    claim(PRIVATE, COMMANDS)

    async def say(user_id: int, body: str) -> None:
        try:
            await client.send_private_msg(user_id, [text(body)])
        except (ApiError, ConnectionError) as e:
            log.warning("回复超管 %s 失败：%s", user_id, e)

    async def do_list(admin: int) -> None:
        recs = store.pending()
        if not recs:
            await say(admin, "没有待批的申请。")
            return
        lines = [f"待批 {len(recs)} 条："]
        for r in recs:
            what = "邀请入群" if r.sub_type == "invite" else "申请"
            lines.append(f"#{r.id} {r.who} {what} {r.where}\n    答案：{r.comment or '(没填)'}\n    {r.rule}")
        lines.append("——\n/y 编号 放行    /n 编号 理由 拒绝")
        await say(admin, "\n".join(lines))

    async def do_hint(admin: int, rec_id: int) -> None:
        """只发了个数字。猜不出要批还是要拒，但也不能装没看见。"""
        rec = store.get(rec_id)
        if rec is None:
            await say(admin, f"没有 #{rec_id} 这条。发 /ls 看当前列表。")
        elif rec.status != store_mod.PENDING:
            await say(admin, f"#{rec_id} 已经处理过了：{STATUS_CN.get(rec.status, rec.status)}")
        else:
            await say(admin, f"#{rec_id} {rec.who}：\n放行发 /y {rec_id}\n拒绝发 /n {rec_id} 理由")

    async def do_decide(admin: int, parts: list[str], approve: bool) -> None:
        verb = "批准" if approve else "拒绝"
        short = "/y" if approve else "/n"
        rec_id, reason = _split_id(parts)
        if rec_id is None:
            await say(admin, f"用法：{short} 编号" + ("" if approve else " 理由") + f"\n\n{USAGE}")
            return

        rec = store.get(rec_id)
        if rec is None:
            await say(admin, f"没有 #{rec_id} 这条。发 /ls 看当前列表。")
            return
        if rec.status != store_mod.PENDING:
            who = f"（{rec.decided_by}）" if rec.decided_by else ""
            await say(admin, f"#{rec_id} 已经处理过了：{STATUS_CN.get(rec.status, rec.status)}{who}")
            return

        reason = reason or ("" if approve else DEFAULT_REJECT_REASON)
        try:
            await client.set_group_add_request(rec.flag, approve, reason)
        except ApiError as e:
            gone = e.retcode == FLAG_GONE
            store.mark(rec.id, store_mod.EXPIRED if gone else store_mod.FAILED, by=admin, reason=str(e))
            hint = "这条申请已经失效了——多半是别的管理员先处理了，或者放太久被 QQ 清掉了。" if gone else str(e)
            await say(admin, f"#{rec_id} 处理失败：{hint}")
            log.warning("超管 %s %s #%s 失败：%s", admin, verb, rec_id, e)
            return
        except ConnectionError as e:
            await say(admin, f"#{rec_id} 没发出去：和 NapCat 的连接断了，等它重连后再试一次。")
            log.warning("超管 %s %s #%s 时连接断了：%s", admin, verb, rec_id, e)
            return

        store.mark(rec.id, store_mod.APPROVED if approve else store_mod.REJECTED, by=admin, reason=reason)
        log.info("超管 %s %s了 #%s（%s）理由=%r", admin, verb, rec_id, rec.who, reason)
        # 故意说"已提交"不说"已批准"：NapCat 不检查底层返回，哪怕 QQ 那边没生效也回 retcode=0，
        # 这里没法保证结果，说死了就是骗人
        tail = f"\n理由：{reason}" if reason else ""
        await say(admin, f"#{rec_id} {rec.who} 的{verb}已提交 ✅{tail}")

    @dispatcher.on("message.private")
    async def on_private(ev: PrivateMessage) -> None:
        body = ev.plain_text.strip()
        bare = body.lstrip("#")
        # 光发一个数字也收：实际用下来，收到「【入群申请 #2】」后直接回「2」是最自然的反应
        if not body.startswith("/") and not bare.isdigit():
            return  # 普通私聊不归这里管，阶段 6 转人工再说

        if ev.user_id not in settings.super_admins:
            # 不回复也不提示，免得给人试探的反馈。只留一条日志
            log.warning("非超管 %s(%s) 发了指令 %r，已忽略", ev.sender_name, ev.user_id, body)
            return

        if bare.isdigit():
            await do_hint(ev.user_id, int(bare))
            return

        parts = _normalize(body.split())
        action = COMMANDS.get(parts[0].lower())
        if action == "list":
            await do_list(ev.user_id)
        elif action == "approve":
            await do_decide(ev.user_id, parts, True)
        elif action == "reject":
            await do_decide(ev.user_id, parts, False)
        elif action == "help":
            await say(ev.user_id, USAGE)
        elif claimed(PRIVATE, parts[0]):
            # 这条归别的处理器接（知识库指令），它自己会回。
            # 这里必须闭嘴，否则超管打一次 /答 会同时收到「正确回复」和「不认识的指令」两条
            log.debug("私聊指令 %r 归别的处理器，这里不管", parts[0])
        else:
            await say(ev.user_id, f"不认识的指令 {parts[0]}\n\n{USAGE}")
