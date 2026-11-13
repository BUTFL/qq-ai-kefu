"""新人进群，@ 他发一条欢迎语。

文案就在下面 `WELCOME_TEXT`，要改直接改那一段，别的地方不用动。

**注意**：⚠️ 原先这里写「AI 问答（阶段 5）和转人工（阶段 6）都还没做，这句是空头
支票」——**那是过期的**。阶段 5 问答 2026-09-23 00:21 上线，阶段 6 三道闸 + 私聊
通知也在跑了。文案里两句话现在都兑现了。

**2026-09-28 换成了防诈骗提醒**（管理员给的原文，一个字都别改）：群里混进了第三方推广号，
私聊客户发链接、二维码。官方网址只有 api.lmuai.com 和 api.lmuai.ai 两个。

末尾「有问题 @我 就行」是他选的留着，**不是客套，是使用说明**：除了「要人工」那一条，
其余闸门都要 @ 机器人才触发（见 `qa.py` 的 @ 检查）。真机 09-24 19:54 有客户没 @ 直接
发问题，机器人按设计不吭声，客户以为没人理。删这句等于把那道闸门的说明书撕掉。
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import NoticeEvent
from ..onebot import ApiError, OneBotClient, at, text

log = logging.getLogger(__name__)

# 2026-10-29 大哥换的第四版（原文照抄，一个字没动）：去掉「国内站：api.lmuai.com」那行，
# 官方文档改成 docs.lmuai.ai。以后改还是只改这一段。
WELCOME_TEXT = (
    "欢迎加入！请认准群管理员。群内可能混入第三方推广号，请勿轻信私聊/链接/二维码，谨防诈骗。\n"
    "灵眸官方网址仅认准\n"
    "国际站【全量模型】：api.lmuai.ai\n"
    "官方社区 ：community.lmuai.ai\n"
    "官方文档：docs.lmuai.ai\n"
    "可疑请@管理员举报。\n"
    "\n"
    "有问题 @我 就行～"
)

# 几秒内进群的合成一条发。一是避免连着刷屏，二是机器人号连发同样的话容易被 QQ
# 风控——这号本来就是 NapCat 挂的，禁不起折腾。
MERGE_WINDOW = 5.0
# 一次 @ 太多人就干脆不 @，只发文案。真碰上批量进群（群转让、导入），
# @ 一串人比不 @ 更像广告号。
MAX_AT = 8


class Welcomer:
    def __init__(self, client: OneBotClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings
        self._waiting: dict[int, list[int]] = defaultdict(list)
        self._timers: dict[int, asyncio.Task[None]] = {}

    def on_join(self, group_id: int, user_id: int) -> None:
        self._waiting[group_id].append(user_id)
        timer = self._timers.get(group_id)
        if timer is None or timer.done():
            task = asyncio.create_task(self._flush_later(group_id), name=f"welcome-{group_id}")
            # 这个任务自己吞异常，加回调只是防 asyncio 回收时刷 "never retrieved"
            task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
            self._timers[group_id] = task

    async def _flush_later(self, group_id: int) -> None:
        await asyncio.sleep(MERGE_WINDOW)
        self._timers.pop(group_id, None)
        # 同一个人短时间内退了又进会来两条事件，去重但保持先来后到
        users = list(dict.fromkeys(self._waiting.pop(group_id, [])))
        if not users:
            return

        who = "、".join(map(str, users))
        if self.settings.dry_run:
            log.info("演练模式：本该在群 %s 欢迎 %s，没真发", group_id, who)
            return

        segs = []
        if len(users) <= MAX_AT:
            for uid in users:
                segs += [at(uid), text(" ")]
        else:
            log.info("群 %s 一次进来 %d 个人，不 @ 了，只发文案", group_id, len(users))
        segs.append(text(WELCOME_TEXT))

        try:
            await self.client.send_group_msg(group_id, segs)
        except (ApiError, ConnectionError) as e:
            # 发不出去不重试：欢迎语有时效性，隔几分钟补一条比不发更奇怪
            log.warning("群 %s 的欢迎语没发出去：%s", group_id, e)
            return
        log.info("群 %s 欢迎了 %s", group_id, who)


def register(dispatcher: Dispatcher, client: OneBotClient, settings: Settings) -> Welcomer:
    welcomer = Welcomer(client, settings)

    @dispatcher.on("notice.group_increase")
    async def on_increase(ev: NoticeEvent) -> None:
        group_id, user_id = ev.group_id or 0, ev.user_id or 0
        if not group_id or not user_id:
            return
        if user_id == ev.self_id:
            return  # 机器人自己被拉进群，别欢迎自己
        if not settings.group_enabled(group_id):
            log.info("群 %s 不在白名单，新人 %s 进群只记日志", group_id, user_id)
            return
        # 日报群是内部群，进来的是同事，防诈骗那段是给客户看的。
        # 而且 09-30 他定了「日报群就发23点一条就可以了」：日报群里机器人不主动说话
        if group_id == settings.report_group:
            log.info("日报群进了新人 %s，不发欢迎语", user_id)
            return
        welcomer.on_join(group_id, user_id)

    return welcomer
