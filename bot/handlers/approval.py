"""阶段 3：入群审批。

收 `request.group.add` / `request.group.invite` → 跑规则 → 能自动放行的**静默**放行，
其余私聊超管等人工指令。每一条都写库留痕。

另外每次连上 NapCat 都补拉一次历史申请。原因在 NapCat 源码里写死了：

    const notifyTime = parseInt(notify.seq) / 1000 / 1000;
    if (notifyTime < this.bootTime) continue;

**它只为「本次进程启动之后」产生的群通知上报事件。** 容器一重启，之前攒着没处理的
申请永远不会补推——这不是理论风险，本项目的容器每次 Docker Desktop 更新都会重启。
所以补拉是必需品，不是可选优化。
"""
from __future__ import annotations

import asyncio
import logging
import time

from .. import rules, store as store_mod
from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import MetaEvent, NoticeEvent, RequestEvent
from ..onebot import ApiError, OneBotClient, text
from ..store import Record, Store

log = logging.getLogger(__name__)

GROUP_NAME_TTL = 300.0  # 群名缓存秒数。群名很少改，但改了要能在几分钟内跟上
# 自动拒绝时发给对方的理由。跟手动 /n 不写理由时的默认话一样（handlers/admin.py），
# 两条路对客户说的是同一句。**这句得让人知道该怎么改**：拒了还能重新申请，
# 看不懂错在哪就等于封死了
REJECT_REASON = "请输入正确订单号"
BACKFILL_COUNT = 200  # 补拉时往回翻多少条群系统消息
FLAG_GONE = 1200  # NapCat: flag 在回溯窗口里找不到了，retcode=1200 "No such request"


class Approver:
    def __init__(self, client: OneBotClient, settings: Settings, store: Store) -> None:
        self.client = client
        self.settings = settings
        self.store = store
        self._names: dict[int, tuple[float, str]] = {}
        self._backfilled = False
        self._lock = asyncio.Lock()  # 补拉和事件可能同时进来，别让同一条申请插两遍

    # ---- 查询辅助。这两个失败都不该让整条审批流程挂掉，取不到就用兜底值 ----

    async def group_name(self, group_id: int) -> str:
        hit = self._names.get(group_id)
        if hit and time.monotonic() - hit[0] < GROUP_NAME_TTL:
            return hit[1]
        try:
            data = await self.client.call_api("get_group_info", group_id=group_id)
            name = str(data.get("group_name", "") or "")
        except (ApiError, ConnectionError) as e:
            # 被邀请进的群机器人还不是成员，查不到很正常。空群名会让规则走兜底转人工，安全
            log.warning("查群名失败 group=%s: %s", group_id, e)
            return ""
        self._names[group_id] = (time.monotonic(), name)
        return name

    async def nickname(self, user_id: int) -> str:
        try:
            data = await self.client.call_api("get_stranger_info", user_id=user_id)
            return str(data.get("nickname", "") or "")
        except (ApiError, ConnectionError):
            return ""  # 只用来展示，取不到就显示 QQ 号

    # ---- 主流程 ----

    async def intake(
        self,
        *,
        flag: str,
        sub_type: str,
        group_id: int,
        user_id: int,
        comment: str,
        group_name: str = "",
        nickname: str = "",
        source: str = "事件",
    ) -> None:
        if not flag:
            log.warning("收到没有 flag 的入群申请，没法回复，只记原文：group=%s user=%s", group_id, user_id)
            return

        if sub_type == "invite":
            # 有人邀请机器人进别的群。装 NapCat 时小号就被自动拉进过一个 288 人的群，
            # 所以这事真会发生。一律转人工，绝不自动进。
            decision = rules.Decision(rules.Action.MANUAL, "有人邀请机器人入群")
        else:
            if not self.settings.group_enabled(group_id):
                log.info("群 %s 不在白名单，入群申请只记日志不处理：user=%s 答案=%r", group_id, user_id, comment)
                return
            # 被你踢过的人（不管在哪个群踢的）再申请任何一个群，直接拒（2026-10-09 他定的：永久、所有群）。
            # 排在规则前面：售前群本来不看答案直接放，被封的人也不能从那儿进
            if self.store.is_banned(user_id):
                decision = rules.Decision(rules.Action.REJECT, "被封禁的人（被你踢出过群）")
            else:
                group_name = group_name or await self.group_name(group_id)
                decision = rules.decide(group_name, comment, self.settings.approval_answer_prefix)

        if not group_name:
            group_name = await self.group_name(group_id) if group_id else ""
        if not nickname:
            nickname = await self.nickname(user_id)

        async with self._lock:
            rec_id = self.store.add(
                flag=flag,
                sub_type=sub_type,
                group_id=group_id,
                group_name=group_name,
                user_id=user_id,
                nickname=nickname,
                comment=comment,
                rule=decision.reason,
                source=source,
            )
        if rec_id is None:
            log.debug("这条申请已经在库里了，跳过：flag=%s", flag)
            return

        rec = self.store.get(rec_id)
        assert rec is not None
        # 原始 comment 一定要进日志：它的确切格式（纯答案？带「问题：…答案：…」前缀？）
        # 腾讯没文档、NapCat 只透传，只能靠真实样本确认，这直接决定 sub2 规则能不能用
        log.info(
            "入群申请 #%s [%s] %s 申请 %s | 答案原文=%r | 判定=%s",
            rec.id, source, rec.who, rec.where, comment, decision.reason,
        )

        if decision.auto:
            await self._auto_approve(rec)
        elif decision.deny:
            await self._auto_reject(rec)
        else:
            await self._notify_admins(rec)

    async def _auto_approve(self, rec: Record) -> None:
        """规则命中，放行。**成功不通知超管**——手机只被真正要决策的事打扰。"""
        if self.settings.dry_run:
            # 演练期不能把人晾着：规则命中的也照样通知超管走人工，只是标明"规则本会放行"。
            # 否则演练这两天里所有正常客户既进不来、你也收不到消息，全卡死。
            log.info("演练模式：#%s 规则判定本应自动放行（%s），改走人工", rec.id, rec.rule)
            await self._notify_admins(rec, dry_note=True)
            return
        try:
            await self.client.set_group_add_request(rec.flag, True)
        except ApiError as e:
            gone = e.retcode == FLAG_GONE
            self.store.mark(rec.id, store_mod.EXPIRED if gone else store_mod.FAILED, reason=str(e))
            log.warning("自动放行 #%s 失败：%s", rec.id, e)
            # 本来要放行的没放成，客户就卡在那了——这属于"需要你拿主意"，得通知
            await self._send_admins(
                f"⚠️ 自动放行失败 #{rec.id}\n"
                f"{rec.who} 申请 {rec.where}\n"
                f"原因：{'申请已失效或被人先处理了' if gone else e}"
            )
            return
        except ConnectionError as e:
            self.store.mark(rec.id, store_mod.FAILED, reason=str(e))
            log.warning("自动放行 #%s 时连接断了：%s", rec.id, e)
            return
        self.store.mark(rec.id, store_mod.AUTO_APPROVED, reason=rec.rule)
        log.info("已自动放行 #%s %s → %s（%s）", rec.id, rec.who, rec.where, rec.rule)

    async def _auto_reject(self, rec: Record) -> None:
        """答案格式不对，直接拒。**成功不通知超管**——跟自动放行同一个道理，
        这不是要他拿主意的事，他每天收的私聊已经够多了（2026-10-08 他定的「格式不对的直接拒绝就可以」）。

        理由会发给对方（`REJECT_REASON`），改对了可以重新申请，所以拒绝不是封死。
        失败了才通知：那种情况人卡在门外，得有人知道。
        """
        if self.settings.dry_run:
            # 演练期不真拒：误拒的代价比误放行大，演练阶段一律交给人看
            log.info("演练模式：#%s 规则判定本应自动拒绝（%s），改走人工", rec.id, rec.rule)
            await self._notify_admins(rec, dry_note=True)
            return
        try:
            await self.client.set_group_add_request(rec.flag, False, REJECT_REASON)
        except ApiError as e:
            gone = e.retcode == FLAG_GONE
            self.store.mark(rec.id, store_mod.EXPIRED if gone else store_mod.FAILED, reason=str(e))
            log.warning("自动拒绝 #%s 失败：%s", rec.id, e)
            await self._send_admins(
                f"⚠️ 自动拒绝失败 #{rec.id}\n"
                f"{rec.who} 申请 {rec.where}\n"
                f"答案：{rec.comment or '(没填)'}\n"
                f"原因：{'申请已失效或被人先处理了' if gone else e}"
            )
            return
        except ConnectionError as e:
            self.store.mark(rec.id, store_mod.FAILED, reason=str(e))
            log.warning("自动拒绝 #%s 时连接断了：%s", rec.id, e)
            return
        self.store.mark(rec.id, store_mod.REJECTED, reason=rec.rule)
        # 原文照样进日志：误拒了要能查出当时客户到底写了什么
        log.info("已自动拒绝 #%s %s → %s | 答案原文=%r（%s）", rec.id, rec.who, rec.where, rec.comment, rec.rule)

    async def _notify_admins(self, rec: Record, *, dry_note: bool = False) -> None:
        what = "有人邀请机器人入群" if rec.sub_type == "invite" else "入群申请"
        head = f"【{what} #{rec.id}】"
        if dry_note:
            head += "\n🧪 演练模式：规则判定本会自动放行，现在交给你确认"
        body = (
            f"{head}\n"
            f"群 {rec.where}\n"
            f"申请人：{rec.who}\n"
            f"答案：{rec.comment or '(没填)'}\n"
            f"时间：{rec.created_at}\n"
            f"判定：{rec.rule}\n"
            f"——\n"
            f"/y {rec.id} 放行      /n {rec.id} 理由 拒绝"
        )
        await self._send_admins(body)


    async def _send_admins(self, body: str) -> None:
        if not self.settings.super_admins:
            log.error("SUPER_ADMINS 没配置，这条通知没人收得到：\n%s", body)
            return
        for admin in sorted(self.settings.super_admins):
            try:
                await self.client.send_private_msg(admin, [text(body)])
            except (ApiError, ConnectionError) as e:
                # 一个超管发不出去不影响别人。机器人和超管不是好友时也可能失败
                log.warning("通知超管 %s 失败：%s", admin, e)

    # ---- 补拉离线期间漏掉的 ----

    async def backfill(self) -> None:
        try:
            data = await self.client.call_api("get_group_system_msg", count=BACKFILL_COUNT)
        except (ApiError, ConnectionError) as e:
            log.warning("补拉历史入群申请失败：%s", e)
            return
        if not isinstance(data, dict):
            log.warning("get_group_system_msg 返回的不是 dict，跳过补拉：%r", data)
            return

        # invited_requests 和 InvitedRequest 是同一份数据的新旧字段名，取一个就行
        groups = [("add", data.get("join_requests") or []), ("invite", data.get("invited_requests") or [])]
        found = 0
        for sub_type, items in groups:
            for it in items:
                if not isinstance(it, dict) or it.get("checked"):
                    continue  # 列表里混着已处理的，必须按 checked 过滤
                found += 1
                await self.intake(
                    # 字段叫 request_id 且是数字，事件里叫 flag 且是字符串，底层同一个 seq
                    flag=str(it.get("request_id", "")),
                    sub_type=sub_type,
                    group_id=int(it.get("group_id") or 0),
                    user_id=int(it.get("invitor_uin") or 0),
                    comment=str(it.get("message", "") or ""),
                    group_name=str(it.get("group_name", "") or ""),
                    nickname=str(it.get("requester_nick") or it.get("invitor_nick") or ""),
                    source="补拉",
                )
        log.info("补拉完成，未处理的申请 %d 条，当前待批 %d 条", found, self.store.pending_count())
        await self.sweep_joined()

    async def sweep_joined(self) -> None:
        """挨个查待批的人是不是已经在群里了，在的就结掉。

        `on_joined` 只能接住机器人在线时进的群。机器人离线那段时间你在 QQ 上批的，
        进群事件永远收不到，那条申请就一直挂着 —— 2026-10-08 发现的 11 条待批里
        有 5 个人早就在群里了，最老的躺了 14 天。所以每次重连补拉完顺手对一遍。

        **只读接口，一条待批一次调用**（平时就几条，重连才跑）。查不到的一律不动：
        接口报错、超时都当「还不在群里」，宁可留着也不乱结别人的申请。
        """
        pend = self.store.pending(limit=50)
        if not pend:
            return
        fixed = 0
        for rec in pend:
            if not rec.group_id or not rec.user_id:
                continue
            try:
                await self.client.call_api("get_group_member_info", group_id=rec.group_id, user_id=rec.user_id)
            except ApiError:
                continue  # 不在群里（接口会报错），正常情况，留着等你处理
            except ConnectionError as e:
                log.warning("对群成员时连接断了，这轮不对了：%s", e)
                return
            except Exception:  # noqa: BLE001
                # 这一步是在启动路径上跑的，**任何**没想到的异常都不能让机器人起不来。
                # 测试里就是拿 RuntimeError 抓到的：原先只接 ApiError / ConnectionError
                log.warning("对群成员 #%s 时出错，这条留着不动", rec.id, exc_info=True)
                continue
            self.store.mark(rec.id, store_mod.JOINED, reason="你在 QQ 上直接批了（对群成员时发现他已经在群里）")
            log.info("申请 #%s %s 其实早进群了，库里跟着结掉", rec.id, rec.who)
            fixed += 1
        if fixed:
            log.info("对完群成员：结掉 %d 条早就进群的，当前待批 %d 条", fixed, self.store.pending_count())

    # ---- 你在 QQ 上直接批了 ----

    def on_joined(self, group_id: int, user_id: int) -> None:
        """这人进群了：把他还挂着的待批申请结掉。

        2026-10-08 加。**不是机器人放行的**（机器人放行时自己就把状态写成 `AUTO_APPROVED` 了，
        那条已经不是 pending），所以走到这里只有一种情况：你在 QQ 上直接点了同意。
        以前这种情况库里一直留着 pending，待批数就虚高 —— 当天 11 条待批里 5 个人早在群里了，
        数字没法看一眼就知道要不要管。

        谁点的、什么理由，QQ 不告诉我们，所以 `decided_by` 留空，状态单独记 `JOINED`，
        不混进 `/y` 批的那些。**只动 pending**：已经结过的一律不碰。
        """
        for rec in self.store.pending_of(group_id, user_id):
            self.store.mark(rec.id, store_mod.JOINED, reason="你在 QQ 上直接批了（机器人是看见他进群才知道的）")
            log.info("申请 #%s %s 已经进群了，你在 QQ 上批的，库里跟着结掉", rec.id, rec.who)


def register(dispatcher: Dispatcher, client: OneBotClient, settings: Settings, store: Store) -> Approver:
    approver = Approver(client, settings, store)

    @dispatcher.on("request.group")
    async def on_group_request(ev: RequestEvent) -> None:
        await approver.intake(
            flag=ev.flag,
            sub_type=ev.sub_type or "add",
            group_id=ev.group_id or 0,
            user_id=ev.user_id,
            comment=ev.comment,
        )

    @dispatcher.on("notice.group_increase")
    async def on_increase(ev: NoticeEvent) -> None:
        # 进群了就把他挂着的待批结掉（你在 QQ 上直接批的那种）。
        # 跟 welcome.py 各走各的：一个事件喂给所有匹配的处理器，这边坏了不影响欢迎语
        group_id, user_id = ev.group_id or 0, ev.user_id or 0
        if group_id and user_id and user_id != ev.self_id:
            approver.on_joined(group_id, user_id)

    @dispatcher.on("notice.group_decrease")
    async def on_decrease(ev: NoticeEvent) -> None:
        # 超管踢人 = 封这个人（所有群）。自己退群（leave）、别的管理员踢的都不算。
        # 白名单外的群也照记：封的是人，你在哪踢的都说明这人不要
        if ev.sub_type != "kick":
            return
        group_id, user_id = ev.group_id or 0, ev.user_id or 0
        operator_id = int(ev.raw.get("operator_id") or 0)
        if not user_id or user_id == ev.self_id or operator_id not in settings.super_admins:
            return
        store.ban(user_id, group_id=group_id, operator_id=operator_id, source="kick")
        log.info("%s 在群 %s 踢了 %s，记进封禁名单（以后申请哪个群都拒）", operator_id, group_id, user_id)

    @dispatcher.on("meta_event")
    async def on_meta(ev: MetaEvent) -> None:
        # 没有"连上了"的回调可用，借 NapCat 的元事件当信号。
        # lifecycle.connect 每次握手成功都会来一条，正好覆盖"NapCat 自己重启了、
        # 机器人重连上去"这种情况——那时 NapCat 的 bootTime 刚重置，最该补一次。
        if ev.meta_event_type == "lifecycle" and ev.sub_type == "connect":
            approver._backfilled = True
            await approver.backfill()
        elif not approver._backfilled:
            approver._backfilled = True  # 心跳兜底：万一这版 NapCat 不发 lifecycle
            await approver.backfill()

    if not settings.super_admins:
        log.warning("SUPER_ADMINS 为空，转人工的申请将没有任何人收到通知")
    return approver
