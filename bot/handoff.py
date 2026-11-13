"""转人工会话（阶段 6）：谁在等人、谁被人接走了、什么时候交还给 AI。

一个客户在一个群里同时最多一条会话，存在 data/qa.db 的 handoffs 表：

    （没有行）AI 在管 ──转人工──▶ 等人工 ──超管开口 / 接管──▶ 人工接管 ──/结束──▶ 结束
                                    └──────────────────/结束──────────────────▶

进「等人工」有五个口：点名要人工、退款、价格、发票、答不上来（`bot/handlers/qa.py`）。

**只有「人工接管」才让机器人闭嘴，等人工期间照常答题。** 价格闸很容易碰到，
要是一进等人工就闭嘴，随便一个问价格的客户就被哑掉，直到有人手动 /结束（09-29 之后
是最多 5 分钟没动静）。2026-09-23 定的原则：宁可漏一次闭嘴，不可让客户彻底收不到回答。
所以判断写的是 `state == 人工接管`，**别改成 `state != 结束`**。

**5 分钟没动静自动关**（`IDLE_MINUTES`）。09-28 定的是一天（#9 七安、#10 Patrichorrr 09-24 被接管后
没人发 /结束，挂了四天，这四天 @我 都只收到「稍等」）；**09-29 他改成「转人工后5分钟自动结束」**。
「动静」（`updated_at`）= 开会话、被接管、接管中客户又 @我，**以及客户或自己人在那个群里说话**
（`activity`）—— 同事正跟客户你一句我一句的时候，谁都不 @我，只认 @我 的话五分钟一到会话就关了、
机器人插进来抢答。每 CHECK_EVERY 查一次，关掉的私聊告诉超管一声、发日报群一行。
`/结束 编号` 还是随时能关，编号照样出现在给超管的每条私聊里。群里给客户的话术不带编号，一个字都不动。

**怎么算「超管接了」**：超管在那个群里开口。`/` 开头的指令、@我、`/问` 都不算，
那是在跟机器人说话 —— 他在客户群里查一下 `/待办` 就把人认领掉，是典型的误触发。
@客户、纯图片都算。自动认领只在「恰好一个客户在等，而且这个群里没有正被接着的人」
时发生；其余情况他在回谁是猜的，猜错的代价是把一个客户哑掉一整天，
而少认领一次几乎零成本（等人工的客户照常有人答）。所以不猜，私聊问他。
他 `/结束` 掉正在接的那个之后，局面回到「只有一个在等」，自动认领自然恢复。

**超管自己不进这套状态机。** 他在群里测「转人工」，不该把自己挂成待处理。

**自己人（同事）跟超管一样**（2026-09-29 管理员：「当自己人在售后和售前说话也算」）：
6099「自己人」页 + `.env` 的 TRUSTED 里的人在客户群里开口，照样算接管；他们自己也不进状态机。
名单 30 秒重读一次（`staff()`），页面上加了人不用重启。接管的私聊发给开口的那个同事，
不是超管的话再抄一份给超管 —— 会话编号还是要让超管看得见，他是兜底关会话的人。

**这一层坏了等于不存在（fail-open）**：问答路上读写会话出任何异常，一律当
「没被接管」，照常往下走。反过来的失败方式是「库坏了 → 所有客户都只收到稍等」，
那是事故。`HANDOFF_ENABLED=false` 时整层跳过，问答回到阶段 5 的样子。
超管手打的三条指令（/会话 /接管 /结束）不吞异常，出错当面告诉他。
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from datetime import datetime, timedelta

from .config import Settings
from .events import GroupMessage
from .kb.store import HO_ENDED, HO_TAKEN, HO_WAITING, HandoffRow, KBStore

log = logging.getLogger(__name__)

# 进等人工的七个口
R_HUMAN = "human"
R_REFUND = "refund"
R_PRICE = "price"
R_INVOICE = "invoice"  # 2026-09-23 加的，管理员要「只要提发票就叫人」
R_MISS = "miss"
# 2026-09-24 加的，见 bot/crisis.py。**单独一个口，不复用 human**：
# `/会话` 列表上「点名要人工」和这个的紧急程度差得远，混成一个等于把它藏起来
R_CRISIS = "crisis"
# 2026-09-30 加的：调模型出错 / 超时。群里那句 ERROR_TEXT 说了「已经叫同事过来」，
# 以前这条路既不开会话也不私聊，客户等的人根本不知道有这回事。**不复用 miss**：
# 答不上来是缺资料（该补标准答案），这个是中转站或网络出事（该去看服务），处理的人不一样
R_ERROR = "error"
REASON_CN = {
    R_HUMAN: "点名要人工", R_REFUND: "退款", R_PRICE: "问价格",
    R_INVOICE: "问发票", R_MISS: "答不上来", R_CRISIS: "说了想不开的话",
    R_ERROR: "机器人出错",
}
STATE_CN = {HO_WAITING: "等人工", HO_TAKEN: "人工接管中", HO_ENDED: "已结束"}

# 每个动作能从哪些状态出发。`KBStore.handoff_move` 拿它拼 UPDATE 的 WHERE，
# 检查和改写是一步，所以这张表就是真正生效的规则，不是注释
TAKE_FROM = (HO_WAITING,)
END_FROM = (HO_WAITING, HO_TAKEN)

OFF_TEXT = "转人工会话没开（HANDOFF_ENABLED=false）"
# 自己人名单多久重读一次
_STAFF_RELOAD = 30.0

# 多久没动静自动关（理由见模块开头）。多久查一次
IDLE_MINUTES = 5
CHECK_EVERY = 60
# 上班时间（2026-09-29 管理员定的「早上9点到晚上6点」）。不在这个时间转人工的，
# 群里话术后面补一句 OFF_HOURS_TEXT，别让客户以为马上有人
WORK_FROM, WORK_TO = 9, 18
OFF_HOURS_TEXT = "现在是下班时间（人工 9:00-18:00 在线），同事上班后第一时间回你。"


def off_hours(now: datetime | None = None) -> bool:
    h = (now or datetime.now()).hour
    return not (WORK_FROM <= h < WORK_TO)


def silenced(state: str | None) -> bool:
    """这个状态下机器人要不要闭嘴。**只认人工接管**，理由见模块开头。"""
    return state == HO_TAKEN


def counts_as_speaking(body: str, *, at_me: bool, prefix: str) -> bool:
    """超管这句话算不算「在群里开口回客户」。

    跟机器人说话的不算：`/` 开头的指令、`/问`（前缀可配，单独判）、@我。
    **只看 @的是不是我**，@客户照样算 —— 那明显是在回客户。
    """
    body = body.strip()
    if at_me or body.startswith("/"):
        return False
    return not (prefix and body.startswith(prefix))


def pick(waiting: Sequence[HandoffRow], taken: Sequence[HandoffRow]) -> HandoffRow | None:
    """超管在这个群开口时该自动认领谁。None = 不认领。

    群里已经有他正接着的人，他这句话多半是在回那个人，不是新来的这个。
    """
    if len(waiting) == 1 and not taken:
        return waiting[0]
    return None


def tag(row: HandoffRow | None) -> str:
    """接在私聊通知末尾的会话编号 + 现成的命令。

    5 分钟没动静会自动关，要早点关还得靠这个编号。

    2026-09-24 管理员要「反馈的时候在最下面告诉我对应的命令,我好使用」，所以
    三条都列出来，而不是只列 /结束。**顺序照他实际操作的顺序**：先接管（机器人
    闭嘴，他自己跟客户聊）→ 聊完结束（交还给 AI）。/会话 放最后，那是「我忘了
    刚才那个编号」时的退路。

    `row is None` 时**也要出一段**。原先这里返回空字符串，结果他自己在群里测
    「转人工」，私聊末尾什么都没有，发了条光秃秃的 /结束 —— 那条命令必须带编号。
    没会话有三种原因（整层关了 / 他自己是超管 / 开会话出错），这里不区分：对他
    有用的信息是同一句「这条没有编号可用，别发带编号的命令」。
    """
    if row is None:
        return (
            "\n\n（这条没开会话，所以没有编号 —— 可能是你或同事在群里测的：自己人不进"
            "这套状态机。想看现在谁在等，群里或私聊发 /会话）"
        )
    return (
        f"\n\n转人工会话 #{row.id}（不发 /结束 的话，5 分钟没动静自动关）\n"
        f"　/接管 {row.id}　← 你来跟他聊，机器人闭嘴\n"
        f"　/结束 {row.id}　← 聊完了，交还给 AI\n"
        f"　/会话　　← 看这个群现在谁在等"
    )


def _clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


class Handoffs:
    """问答和指令两边共用的一个实例（`bot/kb/wiring.py` 里建）。"""

    def __init__(self, store: KBStore, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        # {群号: 上次私聊问「你在回谁」时的局面}。局面没变就不再问 ——
        # 不然他在那个群每说一句就收一条私聊，一天几十条，最后他把私聊静音，
        # 那比不问还糟。局面一变（有人进来、有人被接、有人结束）才重新问
        self._asked: dict[int, tuple[frozenset[int], frozenset[int]]] = {}
        self._staff: frozenset[int] = frozenset()
        self._staff_at = -_STAFF_RELOAD
        # {群号: 开着的会话数}。群消息每条都要问一次「这个群有没有会话」，别每条都查库
        self._open_groups: dict[int, int] = {}

    async def staff(self) -> frozenset[int]:
        """超管 + 自己人（`.env` 的 TRUSTED + 6099「自己人」页）。30 秒重读一次，读不出来就只认超管和 .env"""
        now = time.monotonic()
        if now - self._staff_at >= _STAFF_RELOAD:
            try:
                self._staff = self.settings.trusted | await asyncio.to_thread(self.store.trusted_ids)
            except Exception:
                log.warning("读自己人名单失败，这次只认超管和 .env 里的", exc_info=True)
                self._staff = self.settings.trusted
            self._staff_at = now
        return self._staff

    async def is_staff(self, user_id: int) -> bool:
        return user_id in self.settings.super_admins or user_id in await self.staff()

    @property
    def enabled(self) -> bool:
        return self.settings.handoff_enabled

    # ---- 问答路上用的。全部 fail-open：出错就当没这回事 ----

    async def silenced(self, group_id: int, user_id: int) -> bool:
        """这个客户是不是正被人工接着（是就只回话术）。出错一律 False。"""
        if not self.enabled:
            return False
        try:
            state = await asyncio.to_thread(self.store.handoff_state, group_id, user_id)
        except Exception:
            log.warning("读转人工状态失败，当没被接管、照常回答", exc_info=True)
            return False
        return silenced(state)

    async def open(self, ev: GroupMessage, question: str, reason: str) -> HandoffRow | None:
        """客户进等人工。已经开着就返回开着的那条。None = 没开（关了 / 超管或自己人 / 出错）。"""
        if not self.enabled or await self.is_staff(ev.user_id):
            return None
        try:
            row, created = await asyncio.to_thread(
                self.store.handoff_open,
                group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
                question=question, reason=reason,
            )
        except Exception:
            log.warning("开转人工会话失败，私聊里不带编号", exc_info=True)
            return None
        if created:
            log.info("群 %s 的 %s 进了等人工（%s），会话 #%d", ev.group_id, ev.sender_name, reason, row.id)
        self._open_groups[ev.group_id] = self._open_groups.get(ev.group_id, 0) + (1 if created else 0) or 1
        return row

    async def admin_spoke(self, ev: GroupMessage) -> str | None:
        """超管或自己人在群里说了一句话。返回要私聊他的那句，None = 什么都不用说。"""
        if not self.enabled:
            return None
        if not counts_as_speaking(ev.plain_text, at_me=ev.at_me, prefix=self.settings.qa_prefix):
            return None
        try:
            return await self._admin_spoke(ev)
        except Exception:
            log.warning("自己人开口时判断自动接管出错，这次不接", exc_info=True)
            return None

    async def _admin_spoke(self, ev: GroupMessage) -> str | None:
        rows = await asyncio.to_thread(self.store.handoffs_open, ev.group_id)
        waiting = [r for r in rows if r.state == HO_WAITING]
        taken = [r for r in rows if r.state == HO_TAKEN]

        target = pick(waiting, taken)
        if target is not None:
            moved = await asyncio.to_thread(
                self.store.handoff_move, target.id, to=HO_TAKEN, allowed_from=TAKE_FROM, by=ev.user_id
            )
            if not moved:
                return None  # 就在这一瞬间被 /结束 或 /接管 了，以那边为准
            self._asked.pop(ev.group_id, None)
            log.info("%s(%s) 在群 %s 开口，自动接管会话 #%d（%s）", ev.sender_name, ev.user_id, ev.group_id, target.id, target.nickname)
            return (
                f"✋ 你刚在群 {ev.group_id} 说话，算你接管了会话 #{target.id}\n"
                f"客户：{target.nickname}（{target.user_id}）\n原话：{_clip(target.question, 60)}\n\n"
                f"这之后他 @我，我只回「稍等」那句。处理完发 /结束 {target.id}，不发的话 5 分钟没动静自动关。"
            )

        if not waiting:
            return None
        situation = (frozenset(r.id for r in waiting), frozenset(r.id for r in taken))
        if self._asked.get(ev.group_id) == situation:
            return None
        self._asked[ev.group_id] = situation
        why = (
            f"有 {len(waiting)} 个客户在等人工" if not taken
            else f"有 {len(waiting)} 个客户在等人工，你还接着 {'、'.join(f'#{r.id}' for r in taken)}"
        )
        lines = [f"❓ 你刚在群 {ev.group_id} 说话，但这个群{why}，我分不清你在回谁，没有自动接："]
        for r in waiting:
            lines.append(f"#{r.id} {r.nickname}（{REASON_CN.get(r.reason, r.reason)}）：{_clip(r.question, 30)}")
        lines.append("\n回的是哪个就发 /接管 编号。不接也行，等人工的客户我照常回答。")
        return "\n".join(lines)

    async def touched(self, group_id: int, user_id: int) -> None:
        """接管中的客户又 @我 了，算有动静。出错不管：最坏是早一点自动关"""
        try:
            await asyncio.to_thread(self.store.handoff_touch, group_id, user_id)
        except Exception:
            log.warning("刷新会话动静时间失败", exc_info=True)

    async def activity(self, group_id: int, user_id: int) -> None:
        """群里有人说话了：这个人自己的会话、以及他是自己人的话这个群里被接着的会话，都算有动静。
        **不查库就先看内存**：绝大多数群消息跟会话无关，每条都去写库没必要"""
        if not self.enabled or not self._open_groups.get(group_id):
            return
        try:
            staff = await self.is_staff(user_id)
            await asyncio.to_thread(self.store.handoff_touch_group, group_id, None if staff else user_id)
        except Exception:
            log.warning("刷新会话动静时间失败", exc_info=True)

    async def refresh_open(self) -> None:
        """哪些群有开着的会话（`activity` 的快速判断用）。开 / 关 / 过期之后调一次"""
        try:
            rows = await asyncio.to_thread(self.store.handoffs_open)
        except Exception:
            log.warning("读开着的会话失败", exc_info=True)
            return
        groups: dict[int, int] = {}
        for r in rows:
            groups[r.group_id] = groups.get(r.group_id, 0) + 1
        self._open_groups = groups

    async def expire(self, now: datetime | None = None) -> None:
        """把 IDLE_MINUTES 没动静的会话关掉。不通知——不管有没有人接过，关不关对客户都没区别（他再 @我 照常回答），
        通知只会变成每 5 分钟一响的噪音"""
        if not self.enabled:
            return
        before = ((now or datetime.now()) - timedelta(minutes=IDLE_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
        rows = await asyncio.to_thread(self.store.handoff_expire, before)
        await self.refresh_open()
        for r in rows:
            log.info("会话 #%d（%s，%s）%d 分钟没动静，自动交还给 AI", r.id, r.nickname, STATE_CN.get(r.state), IDLE_MINUTES)

    # ---- 三条指令（bot/handlers/kb_admin.py 调）。不吞异常 ----

    def listing(self) -> str:
        rows = self.store.handoffs_open()
        if not rows:
            return "没有开着的转人工会话。"
        lines = [f"开着的转人工会话 {len(rows)} 个："]
        for r in rows:
            lines.append(
                f"会话#{r.id} {STATE_CN.get(r.state, r.state)}｜群 {r.group_id}｜{r.nickname}（{r.user_id}）"
                f"｜{REASON_CN.get(r.reason, r.reason)}｜{r.created_at[5:16]} 起"
            )
            lines.append(f"      原话：{_clip(r.question, 30)}")
            cid = self.store.handoff_cluster(r)
            if cid is not None:
                lines.append(f"      要定答案：/答 {cid} 你的答案")
        lines.append("——\n/接管 编号 手动接｜/结束 编号 交还给 AI\n不发 /结束 的话，5 分钟没动静自动关")
        return "\n".join(lines)

    def take(self, handoff_id: int, by: int, *, where_group: int | None) -> str:
        """`where_group` = 在哪个群打的指令，私聊给 None。只有私聊或同一个群才带客户昵称：
        在 A 群打 `/接管 5`，回复里不该冒出 B 群客户的名字。"""
        row = self.store.handoff_get(handoff_id)
        if row is None:
            return f"没有 #{handoff_id} 这个会话。发 /会话 看现在开着的。"
        who = self._who(row, where_group)
        if row.state == HO_TAKEN:
            return f"#{row.id}{who} 已经是人工接管了。处理完发 /结束 {row.id}。"
        if row.state == HO_ENDED:
            return f"#{row.id}{who} 已经结束了。客户再要人工会开一个新编号。"
        if not self.store.handoff_move(row.id, to=HO_TAKEN, allowed_from=TAKE_FROM, by=by):
            return f"#{row.id} 状态刚变了，发 /会话 再看一眼。"
        log.info("%s 手动接管会话 #%d", by, row.id)
        return (
            f"#{row.id}{who} 算你接管了。这之后他 @我，我只回「稍等」那句。\n"
            f"处理完发 /结束 {row.id}，不发的话 5 分钟没动静自动关。"
        )

    def end(self, handoff_id: int, by: int, *, where_group: int | None) -> str:
        row = self.store.handoff_get(handoff_id)
        if row is None:
            return f"没有 #{handoff_id} 这个会话。发 /会话 看现在开着的。"
        who = self._who(row, where_group)
        if row.state == HO_ENDED:
            return f"#{row.id}{who} 早就结束了。"
        if not self.store.handoff_move(row.id, to=HO_ENDED, allowed_from=END_FROM, by=by):
            return f"#{row.id} 状态刚变了，发 /会话 再看一眼。"
        log.info("%s 结束了会话 #%d（原来是%s）", by, row.id, STATE_CN.get(row.state, row.state))
        return f"#{row.id}{who} 结束了，交还给 AI。他之后 @我 我就照常回答。"

    @staticmethod
    def _who(row: HandoffRow, where_group: int | None) -> str:
        return f"（{row.nickname}）" if where_group is None or where_group == row.group_id else ""


async def expire_loop(handoffs: Handoffs) -> None:
    """每 CHECK_EVERY 关一次没动静的会话。启动时先跑一次（重启前就该关的别再多等）"""
    if not handoffs.enabled:
        return
    log.info("转人工会话 %d 分钟没动静自动关，每 %d 秒查一次；人工上班 %d:00-%d:00", IDLE_MINUTES, CHECK_EVERY, WORK_FROM, WORK_TO)
    while True:
        try:
            await handoffs.expire()
        except Exception:  # noqa: BLE001
            log.exception("自动关会话出错，下一轮再试")
        await asyncio.sleep(CHECK_EVERY)
