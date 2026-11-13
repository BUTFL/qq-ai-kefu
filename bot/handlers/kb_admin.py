"""维护标准答案：/加 /答 /改 /删 /忽略 /同步。群里和私聊都能打。
阶段 6 的转人工会话 /会话 /接管 /结束 也挂在这儿（逻辑在 `bot/handoff.py`）。
夜间复盘的 /复盘详情 /采纳 /不要 也在这儿（逻辑在 `bot/kb/review.py`）。
/加 一句大白话 → 预览 → 回「好」生效，逻辑在 `bot/kb/teach.py`（2026-10-14）。
/待办 /草稿 /高频 /日报 /经验 /划掉 /导出 /复盘 2026-10-14 停用（管理员「以前的命令没有的可以禁用掉」，
日志里一次都没人用过），打了回一句改用什么，见 `RETIRED`。

**为什么主场是群里**：2026-09-22 管理员定的，「不需要 qq 私聊，
直接在群里发就可以」。日报和这些指令都是他随时想看想改的东西，
放群里一眼能看见；要他接手的通知（退款、答不上来）才走私聊。

**私聊那一路是 2026-09-23 补的**，起因是真机踩的那条缝：00:27 他在私聊打
`/答 23 …`，收到「不认识的指令 /答」，以为自己标点打错，重试一次还是不行，
标准答案库一条都没录上。两边指令表各长在一个文件里，而那句兜底提示是个
全局判断（完整病因见 `bot/commands.py` 开头）。补法是这里真的接私聊，
再用 `commands.claim()` 让 admin.py 那句兜底知道有人接了。

**谁能用**：
- 超管（`SUPER_ADMINS`）全都能用，群里私聊都行
- **自己人**（`.env` 的 TRUSTED + 6099「自己人」页，2026-09-29 加的）**在日报群（`REPORT_GROUP`）里**全都能用，
  跟超管一样。管理员原话「自己人在qq日报群里面也可以定答案」，选了「全部指令」「只在日报群」。
  **别的群、私聊里自己人还是普通群员**：客户群里不在客户面前操作；私聊他没选
- 群主 / 群管理员只能看（/复盘详情 /命令），**不能定答案、不能 /加**
- **/会话 /接管 /结束 只认超管**：接不接一个客户、什么时候交还给 AI，
  跟定答案一样是替机器人对着客户做决定
- **私聊只认超管**，没有「群主也能看」这一档：私聊事件里没有 `role` 字段，
  群身份在这儿根本无从查证，照抄群里那道门等于凭空放宽

分这一刀的理由：`/答` 决定的是机器人对着客户说什么，说错了是你担责任。
看的那几条指令没有这个风险，放开能省你被反复问「现在有哪些待办」。
身份直接读事件里的 `sender.role`，不额外调接口——群消息本来就带这个字段。

**回复发到哪**：

- 群里打 `/复盘详情 /会话 /命令` → 输出**一律发到 `REPORT_GROUP`**，
  不发回打指令的那个群（见 `INTERNAL`）。在客户群里打这几条，客户群里
  什么都不出现。其余指令（含 `/帮助` 和 `/答` 这类写操作的确认）就地回。
  **`/会话` 在 `REPORT_GROUP` 没配时改私聊本人**，不像另外四条那样只回一句
  「先配 REPORT_GROUP」：它是转人工的唯一名单。
- **私聊打什么都回给他本人，不转发到日报群。** 转过去这道弯没有意义：
  改发日报群是为了「别让客户看见内部数据」，而超管私聊本来就是最私密的
  一条道。顺带一个好处是私聊那一路不依赖 `REPORT_GROUP` 配没配。

`/答` 的编号是**待办编号**（问题类），`/改 /删` 的编号是**答案编号**。
两个编号不通用，所以 `/答` 成功后会明确告诉你新答案的编号是多少，也带上答的是哪道题。

**还有第三种：会话编号**（/接管 /结束）。09-29 同事看到自动关会话那条「#16 bowen 答不上来：月卡…」，
发了 `/答16 月卡周限额已取消…` —— 16 是会话编号，待办 16 是「怎么联系客服」，月卡那句就成了
「怎么联系客服」的标准答案。现在两道防线：会话的通知里直接给出 `/答 待办编号`；
`/答 N` 的 N 恰好是一天内的会话、而那个会话的题是另一道待办时，先不存，问一句（`_session_clash`）。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from .. import menu
from ..commands import GROUP, PRIVATE, claim, claimed
from ..config import Settings
from ..dispatcher import Dispatcher
from ..events import GroupMessage, PrivateMessage
from ..handoff import OFF_TEXT, Handoffs
from ..kb import assistant, chat_record, learn_chat, notice, review, sync, teach
from ..kb.cluster import link_similar
from ..kb.llm import LLM, LLMError
from ..kb.store import BY_QQ, HandoffRow, KBStore
from ..onebot import ApiError, OneBotClient, at, text

log = logging.getLogger(__name__)

# /命令 /功能 /菜单：全部功能一条看完（bot/menu.py，2026-09-29 管理员要的「/命令 展示功能」）
MENU = {"/命令", "/功能", "/菜单"}
# 夜间复盘的全文（每晚发群里的只是要你看的那 4 件，2026-10-14 管理员定的「每晚4条」）
DETAIL = {"/复盘详情"}
READ_ONLY = {"/帮助", "/help"} | MENU | DETAIL
WRITE = {"/答", "/改", "/删", "/忽略", "/同步"}
# 转人工会话（阶段 6）。**只认超管**，群主群管理员也不行，理由见模块开头
HANDOFF = {"/会话", "/接管", "/结束"}
# 夜间复盘起草的东西（2026-09-28 加的）。**只认超管**：采纳就是替机器人定答案，跟 /答 一样。
# 不用 /批 /拒：/批准 /拒绝 /y /n 是入群审批的指令（handlers/admin.py），手一滑就批错人进群
DRAFTS = {"/采纳", "/不要"}
# 机器人自己学的「管理员怎么回的」（bot/kb/memory.py，2026-10-15）：/记忆 看最近学的，/忘 3 删掉 3 号。
# 跟 DRAFTS 一样只认超管和日报群里的自己人：记忆不用审就会拿去回客户，删不删是替机器人做决定
MEMORY = {"/记忆", "/忘", "/改记忆"}
# 临时口径（bot/kb/notice.py，2026-09-30 加的）。发出去是客户看得见的话，跟 /答 一样只认超管和日报群里的自己人
NOTICE = {"/口径"}
# /加：大白话 → AI 改写 → 预览 → 回「好」才生效（bot/kb/teach.py，2026-10-14）。
# 后面这几个是他真会顺手打的别名：10-12 小追兵打的就是 /定调（照抄复盘里「等你定调的」那几个字）
TEACH = {"/加"}
TEACH_ALIASES = {"/定调": "/加", "/添加": "/加", "/新增": "/加", "/教你": "/加", "/记住": "/加", "/加答案": "/加"}
# **停用的老指令 → 打了告诉他改用什么**（2026-10-14 管理员：「以前的命令没有的可以禁用掉」）。
# 依据是 09-28 起全部日志：下面这几条一次都没人打过。
# 不直接删掉名字、而是留在这儿接住：删掉的话超管打了会撞上 admin.py 那句「不认识的指令」+ 审批清单，
# 群里则是一声不响 —— 都比不上直接告诉他「这条停了，改用 X」
_TO_DETAIL = "停用了：要你看的每晚 23:00 复盘里列了，全部的发 /复盘详情"
RETIRED = {
    "/待办": _TO_DETAIL,
    "/草稿": _TO_DETAIL + "（也可以去 6099「待审草稿」页）",
    "/高频": _TO_DETAIL,
    "/日报": "停用了：日报群每晚 23:00 只发一条复盘，全文发 /复盘详情",
    "/经验": _TO_DETAIL,
    "/划掉": "停用了（没人用过）。规律只给你看、不拿去答客户，不用管它",
    "/导出": "停用了：不用导出，每次改答案都会自动写进 知识库.md",
    "/复盘": "停用了：每晚 23:00 自动跑。看上一次的全文发 /复盘详情",
}
COMMANDS = READ_ONLY | WRITE | HANDOFF | DRAFTS | NOTICE | TEACH | MEMORY | set(TEACH_ALIASES) | set(RETIRED)

# 私聊里认的指令。**`/帮助` `/help` 故意排除。**
# `handlers/admin.py` 的私聊处理器自己接这两条（它的指令表里就有），
# 而它那句 `action == "help"` 的分支排在 `claimed()` 之前 —— 也就是说
# 它压根不会让给我。我要是也接，超管打一次 `/帮助` 就收到两条回复。
# 群里没这个问题：admin.py 只接私聊，群里这两条本来就归我。
#
# 代价是私聊打 `/帮助` 只能看到审批那份清单，看不到标准答案这几条。
# 不在这儿拉平，是因为那份 USAGE 长在别人的文件里。
PRIVATE_COMMANDS = COMMANDS - {"/帮助", "/help"}

# 一条「往哪儿发」。群和私聊的差别**只**落在这个类型上，下面十个 `do_*`
# 全都不知道自己在给谁发。这是私聊那一路几乎白捡的原因：加一个 handler，
# 十个 `do_*` 一个都不用碰，也就没有「群里改对了私聊忘了改」的机会。
Sink = Callable[[str], Awaitable[None]]

# 输出里带内部数据的指令。**这几条的回复一律发到 `REPORT_GROUP`，不发回当前群。**
#
# 为什么：日报和待办里有命中率、答不上来几条，而 `open_clusters()`
# `top_clusters()` 是**跨群聚合**的 —— 在 A 群打一句 `/待办`，打出来的是
# 全部群客户的原话。`report.py` 开头早就写明「默认值一旦指到真实客户群，
# 就是当着客户的面公布机器人的短板」，定时推送守住了，指令这条路以前
# 直接 `ev.group_id` 绕过去了（2026-09-23 补，管理员定的：回复改发日报群）。
#
# `/帮助` 故意不在里面：它只是指令清单，没有任何客户数据，
# 发回当前群才顺手；扔到别的群去反而让人以为机器人没反应。
#
# `/会话` 也在里面：列的是全部群里在等人工的客户昵称、QQ 号和原话，
# 落进客户群就是当着客户的面泄别的客户的信息
INTERNAL = {"/会话", "/记忆"} | MENU | DETAIL

# 指令和编号之间漏空格：`/答12 内容`、`/删3`。和 admin.py 里一个道理——
# 手机上打指令漏空格是常态，不该让人重打一遍
_GLUED = re.compile(r"^(/\S*?)\s*(\d.*)$", re.S)
_ID_HEAD = re.compile(r"(\d+)(.*)", re.S)
# /答 的号撞上会话编号被拦下后，多久内再发一次算「我确实要答这道」
CONFIRM_WITHIN = 120.0
# 私聊转发聊天记录学出来的那批，多久内回「好」算数（他可能要一条条看完，给半小时）
LEARN_MINUTES = 30
_LEARN_YES = re.compile(r"^好\s*([\d\s,，、]*)$")


class _AsstPending:
    """管理员大白话列出来、等他回「好」的改动（bot/kb/assistant.py）。跟 _Batches 一样存库，重启不丢"""

    def __init__(self, store: KBStore) -> None:
        self.store = store

    def get(self, uid: int) -> tuple[list[assistant.Action], float] | None:
        import json

        raw = self.store.get_meta(f"asst_plan:{uid}")
        if not raw:
            return None
        try:
            d = json.loads(raw)
            return [assistant.Action(a["kind"], a["params"], a["desc"]) for a in d["actions"]], float(d["at"])
        except (ValueError, KeyError, TypeError):
            return None

    def put(self, uid: int, actions: list[assistant.Action]) -> None:
        import json

        self.store.set_meta(f"asst_plan:{uid}", json.dumps(
            {"actions": [{"kind": a.kind, "params": a.params, "desc": a.desc} for a in actions], "at": time.time()},
            ensure_ascii=False,
        ))

    def pop(self, uid: int) -> None:
        self.store.set_meta(f"asst_plan:{uid}", "")


class _Batches:
    """私聊转发记录学出来、等他回「好」的那批。**存在库的 meta 表里，不放内存**：
    2026-10-15 19:36 同事转发了记录、19:40 机器人重启，19:50 他回「好 2 3 4 5 7」时这批已经没了，
    机器人一声不吭。重启不该吃掉别人等着确认的东西"""

    def __init__(self, store: KBStore) -> None:
        self.store = store

    @staticmethod
    def _key(uid: int) -> str:
        return f"learn_batch:{uid}"

    def get(self, uid: int) -> tuple[list[int], float] | None:
        import json

        raw = self.store.get_meta(self._key(uid))
        if not raw:
            return None
        try:
            d = json.loads(raw)
            return [int(i) for i in d["ids"]], float(d["at"])
        except (ValueError, KeyError, TypeError):
            return None

    def __contains__(self, uid: int) -> bool:
        return self.get(uid) is not None

    def __setitem__(self, uid: int, value: tuple[list[int], float]) -> None:
        import json

        self.store.set_meta(self._key(uid), json.dumps({"ids": value[0], "at": value[1]}))

    def pop(self, uid: int, default: object = None) -> object:
        got = self.get(uid)
        if got is not None:
            self.store.set_meta(self._key(uid), "")
        return got if got is not None else default


def _clip(s: str, n: int = 30) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"

# 2026-10-14 改短：以前 25 行、四种编号混在一起，管理员原话「用户都不知道命令是那个太绕了」。
# 现在常用的 5 条放前面，其余一行带过；全部的看 /命令
USAGE = (
    "常用的（群里直接发）：\n"
    "/加 一句大白话     要客户知道什么直接说，我改好给你看，回「好」才生效\n"
    "/答 12 内容       给 12 号待办定答案（编号在每晚复盘里）\n"
    "/改 7 内容        改 7 号答案　/删 7 删掉\n"
    "/口径 内容 2h     临时的事，到点自动撤（用 /加 也行，我会自己判断是不是临时的）\n"
    "/复盘详情         上一次夜间复盘的全文\n"
    "\n其它：/采纳 4（用 4 号草稿）/不要 4｜/忽略 12（不用答）｜/同步｜/会话 /接管 5 /结束 5（只有超管）\n"
    "/记忆            机器人学到的「同事怎么回的」　/记忆 3 看全文\n"
    "/改记忆 3 内容   把 3 号改成你写的回复　/忘 3 删掉 3 号\n"
    "全部功能：/命令"
)


def _split(parts: list[str]) -> tuple[int | None, str]:
    """`/答 3 内容` → (3, "内容")。`/答 3内容`（漏空格）也认。"""
    if len(parts) < 2:
        return None, ""
    m = _ID_HEAD.match(parts[1].strip().lstrip("#"))
    if not m:
        return None, ""
    glued, rest = m.group(2).strip(), " ".join(parts[2:]).strip()
    return int(m.group(1)), " ".join(x for x in (glued, rest) if x)


def _extra_ids(tail: str) -> str:
    """只吃一个编号的指令（/删 /忽略 /接管 /结束），把多打的编号回给他看。

    **这是 2026-09-24 修的真缺陷**：`/结束 5 6 7` 原先只关掉 5，6 和 7 一声不响地
    丢掉，他以为三个都关了 —— 而没关掉的那两个客户，机器人只会回「稍等」，
    等于被挂在那儿没人管。**跟看门狗那个盲区是同一个形状：静默 ≠ 成功。**

    修法是照实说，不是加批量。一条指令关一个是既定的：每个编号都要单独确认
    「原来是什么状态」（`handoff.py` 的 take/end 各自回一句），批量就得把那几句
    压成一行，他看不出哪个本来就已经结束了。
    """
    # 按数字串抓，不按空格切 —— 「/结束 5,6」「/结束 5、6」这种他真会打，
    # 按空格切的话 ",6" 不算数字，又静默丢掉一个
    nums = re.findall(r"\d+", tail)
    if not nums:
        return ""
    return (
        f"\n\n⚠️ 后面这{len(nums)}个我没动：{'、'.join('#' + n for n in nums)}\n"
        "一条指令只认一个编号，剩下的一个个发。"
    )


def normalize(body: str) -> list[str]:
    parts = body.split()
    if not parts:
        return parts
    if parts[0] not in COMMANDS:
        m = _GLUED.match(parts[0])
        if m and m.group(1) in COMMANDS:
            parts = [m.group(1), m.group(2), *parts[1:]]
        else:
            # /加 后面不打空格直接跟话（「/加开发票…」）：手机上很常见，跟漏空格的编号一个道理。
            # 长的别名先比，免得 /加答案 被切成 /加 + 答案
            for name in sorted(TEACH | set(TEACH_ALIASES), key=len, reverse=True):
                if parts[0].startswith(name) and len(parts[0]) > len(name):
                    parts = [name, parts[0][len(name):], *parts[1:]]
                    break
    if parts[0] in TEACH_ALIASES:
        parts = [TEACH_ALIASES[parts[0]], *parts[1:]]
    return parts


def register(
    dispatcher: Dispatcher,
    client: OneBotClient,
    settings: Settings,
    store: KBStore,
    llm: LLM,
    handoffs: Handoffs,
    *,
    review_llm: LLM | None = None,
) -> None:
    # /采纳、/加 改写要调的模型：复盘自己的（REVIEW_MODEL），没给就跟答题同一个
    rllm = review_llm or llm
    # 告诉 admin.py 那句「不认识的指令」：这些我接了，别再冤枉人。
    # 放在 register() 里而不是模块级，理由见 bot/commands.py 开头那段
    claim(GROUP, COMMANDS)
    claim(PRIVATE, PRIVATE_COMMANDS)
    # /加 的预览：{(在哪儿, 谁): (预览, 发出的时间)}。在哪儿 = 群号；私聊记成负的 QQ 号，跟群号不会撞。
    # 只活在内存里：重启丢了就丢了，他再发一次 /加，比把半天前的预览「好」掉安全
    plans: dict[tuple[int, int], tuple[teach.Plan, float]] = {}
    # 私聊转发聊天记录学答法（bot/kb/chat_record.py，2026-10-15）：
    # batches = {QQ: (这次起的草稿编号, 时间)}，等他回「好」；records = {QQ: (拆好的发言, 时间)}，
    # 认不出客服时他回一句「客服是 昵称」就拿这份重来，不用再转发一次；hints = {QQ: 他说的客服昵称}
    batches = _Batches(store)
    asst = _AsstPending(store)
    records: dict[int, tuple[list[chat_record.Line], float]] = {}
    hints: dict[int, set[str]] = {}
    learning: set[int] = set()
    # {(谁, 待办编号): 被拦下的时间}。/答 的号撞上会话编号时，2 分钟内再发一次算确认
    confirm: dict[tuple[int, int], float] = {}

    def _session_clash(cid: int) -> tuple[HandoffRow, int] | None:
        """会话#cid 是一天内开的、而且它的题是另一道还没定的待办 → (会话, 那道题的待办编号)"""
        row = store.handoff_get(cid)
        if row is None or row.created_at < (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S"):
            return None
        other = store.handoff_cluster(row)
        return (row, other) if other is not None and other != cid else None
    # 自己人名单（6099「自己人」页），30 秒重读一次，跟 listen.py 一样
    staff_cache: dict[str, object] = {"ids": frozenset(), "at": -30.0}

    async def staff() -> frozenset[int]:
        import time

        now = time.monotonic()
        if now - float(staff_cache["at"]) >= 30.0:  # type: ignore[arg-type]
            try:
                staff_cache["ids"] = settings.trusted | await asyncio.to_thread(store.trusted_ids)
            except Exception:
                log.warning("读自己人名单失败，这次只认超管和 .env 里的", exc_info=True)
                staff_cache["ids"] = settings.trusted
            staff_cache["at"] = now
        return staff_cache["ids"]  # type: ignore[return-value]

    def to_group(group_id: int) -> Sink:
        async def send(body: str) -> None:
            try:
                await client.send_group_msg(group_id, [text(body)])
            except (ApiError, ConnectionError) as e:
                log.warning("群 %s 回复失败：%s", group_id, e)

        return send

    def to_user(user_id: int) -> Sink:
        async def send(body: str) -> None:
            try:
                await client.send_private_msg(user_id, [text(body)])
            except (ApiError, ConnectionError) as e:
                log.warning("私聊 %s 回复失败：%s", user_id, e)
            # 同事（不是超管）多半不是机器人的 QQ 好友，私聊走的是「临时会话」：NapCat 显示发出去了，
            # 他手机上却常常收不到（10-15 Listen 说没收到回复）。**在日报群里 @ 他再发一份**，保证看得到。
            # 只发日报群（内部群），不发客户群
            if user_id not in settings.super_admins and settings.report_group:
                try:
                    await client.send_group_msg(settings.report_group, [at(user_id), text(" （私聊发你的，这里也放一份）\n" + body)])
                except (ApiError, ConnectionError) as e:
                    log.warning("日报群补发给 %s 失败：%s", user_id, e)

        return send

    async def do_answer(out: Sink, by: int, parts: list[str], by_name: str = "") -> None:
        cid, body = _split(parts)
        if cid is None or not body:
            await out("用法：/答 3 这是答案内容\n编号在每晚复盘里，全部的发 /复盘详情。没有编号的直接 /加 一句大白话")
            return
        cluster = await asyncio.to_thread(store.get_cluster, cid)
        if cluster is None:
            await out(f"没有 {cid} 号待办。编号看 /复盘详情；不是待办里的直接 /加 一句大白话。")
            return
        # 这个号同时是一个刚开过的转人工会话、而那个会话的题是另一道待办 → 多半把会话编号当成了
        # 待办编号（09-29 /答16 真出过：会话 #16 问月卡，待办 16 是「怎么联系客服」）。先拦下，
        # 给出那道题的号；确实要答这道就原样再发一次（2 分钟内）
        clash = await asyncio.to_thread(_session_clash, cid)
        # 没发过的默认值必须是负的：monotonic() 从开机算起，刚开机两分钟内 0.0 会被当成「刚发过」，
        # 第一次就直接存了（GitHub 的 CI 机器每次都是新开的，这四条用例从 f88abb5 起在 CI 上一直红；
        # 线上 Docker 的虚拟机一重启也一样）
        if clash is not None and confirm.get((by, cid), -CONFIRM_WITHIN - 1.0) < time.monotonic() - CONFIRM_WITHIN:
            confirm[(by, cid)] = time.monotonic()
            row, other = clash
            await out(
                f"⚠️ 先没存。{cid} 号待办是「{_clip(cluster.label)}」，\n"
                f"但会话#{cid}（{row.nickname}）问的是「{_clip(row.question)}」，那道题是 {other} 号待办。\n"
                f"要答 {row.nickname} 那道：/答 {other} {body}\n"
                f"确实要答「{_clip(cluster.label)}」：2 分钟内把刚才那条原样再发一次"
            )
            return
        confirm.pop((by, cid), None)

        # 这一类里客户实际说过的其它问法，直接当别名——它们是现成的真实语料，
        # 每个都单独算向量，下次任何一种问法都能命中。
        # **merge_aliases=True：这条路上别名只增不减。** 这一类底下如果只有一种
        # 说法，others 就是空的，直接覆盖会把这条答案原有的别名全冲掉——
        # 2026-09-23 18:30 真出过一次，细节见 store._merge_aliases
        others = [q for q in await asyncio.to_thread(store.cluster_questions, cid, 8) if q != cluster.label]
        eid, created = await asyncio.to_thread(
            store.upsert_entry,
            question=cluster.label, answer=body, aliases="\n".join(others), by=by, source=BY_QQ,
            merge_aliases=True,
        )
        entry = await asyncio.to_thread(store.get_entry, eid)
        if entry is None:
            await out("存是存下了，但读回来不见了，这不正常，看日志吧。")
            return
        # 存进库就记：后面算向量失败答案也还在，只是暂时匹配不到
        await asyncio.to_thread(store.audit, "定", eid, cluster.label, by, by_name)

        try:
            vecs = await llm.embed(entry.phrasings)
        except LLMError as e:
            # 答案已经存进库了，只是还没法被检索到。说清楚状态，别让人以为白答了
            log.warning("给答案 #%d 算向量失败：%s", eid, e)
            await out(f"答案 #{eid} 存下了，但算向量失败（{e}），现在还匹配不到。等会儿发 /同步 重试。")
            return
        await asyncio.to_thread(store.set_entry_vecs, eid, list(zip(entry.phrasings, vecs)))
        await asyncio.to_thread(store.attach_entry, cid, eid)
        linked = await asyncio.to_thread(link_similar, store, eid, vecs, settings.cluster_score)
        path = await asyncio.to_thread(sync.write, store)

        tail = f"，顺带结掉了 {len(linked) - 1} 条相似的待办" if len(linked) > 1 else ""
        extra = f"\n认得 {len(entry.phrasings)} 种问法" if len(entry.phrasings) > 1 else ""
        # 回复里带上答的是哪道题：编号挂错了当场看得出来，不用等客户问到才发现
        await out(
            f"{'记下了' if created else '更新了'} ✅ {cid} 号待办「{_clip(cluster.label)}」→ 答案编号 #{eid}{tail}{extra}\n"
            f"下次有人这么问就直接这么回。改它发 /改 {eid} 新内容\n（已写进 {path.name}）",
        )
        log.info("%s 给待办 #%d 定了答案 #%d，联动结掉 %d 条", by, cid, eid, len(linked))

    async def do_edit(out: Sink, parts: list[str], by: int = 0, by_name: str = "") -> None:
        eid, body = _split(parts)
        if eid is None or not body:
            await out("用法：/改 7 新的答案内容")
            return
        old = await asyncio.to_thread(store.get_entry, eid)
        if old is None:
            await out(f"没有 #{eid} 这条答案。")
            return
        # 只改答案正文，问法和别名原样保留——改的是「怎么回」，不是「问的是什么」，
        # 所以不用重算向量
        await asyncio.to_thread(
            store.upsert_entry,
            question=old.question, answer=body, aliases=old.aliases, source=BY_QQ, entry_id=eid,
        )
        await asyncio.to_thread(sync.write, store)
        await asyncio.to_thread(store.audit, "改", eid, old.question, by, by_name)
        await out(f"#{eid}「{old.question}」的答案改好了 ✅")

    async def do_delete(out: Sink, parts: list[str], by: int = 0, by_name: str = "") -> None:
        eid, tail = _split(parts)
        if eid is None:
            await out("用法：/删 7")
            return
        entry = await asyncio.to_thread(store.get_entry, eid)
        if entry is None:
            await out(f"没有 #{eid} 这条答案。" + _extra_ids(tail))
            return
        await asyncio.to_thread(store.delete_entry, eid)
        await asyncio.to_thread(sync.write, store)
        await asyncio.to_thread(store.audit, "删", eid, entry.question, by, by_name)
        await out(
            f"删了 #{eid}「{entry.question}」。以后这类问题会重新去查资料。" + _extra_ids(tail)
        )

    async def do_ignore(out: Sink, parts: list[str]) -> None:
        cid, tail = _split(parts)
        if cid is None:
            await out("用法：/忽略 3")
            return
        cluster = await asyncio.to_thread(store.get_cluster, cid)
        if cluster is None:
            await out(f"没有 {cid} 号待办。" + _extra_ids(tail))
            return
        await asyncio.to_thread(store.resolve_cluster, cid)
        await out(
            f"好，{cid} 号「{cluster.label}」不再催你。它还是会照常查资料回答。" + _extra_ids(tail)
        )

    async def do_sync(out: Sink, parts: list[str]) -> None:
        force = len(parts) > 1 and parts[1].strip() in {"确认", "强制", "force"}
        await out("在按 知识库.md 覆盖库…问法有变的要重算向量，稍等。")
        res = await sync.load(store, llm, force=force)
        tail = f"\n（改之前的版本备份成了 {res.backup}）" if res.backup else ""
        await out(res.summary() + tail)

    async def do_decide(out: Sink, cmd: str, by: int, parts: list[str], by_name: str = "") -> None:
        did, tail = _split(parts)
        if did is None:
            await out(f"用法：{cmd} 4\n编号在每晚复盘里，也可以去 6099「待审草稿」页")
            return
        pick = None
        if cmd == "/采纳":
            # `/采纳 4 2` = 4 号草稿用第 2 种说法。第二个数只认 1~9：多打的别的编号照旧回给他看
            m = re.match(r"^(\d)(?!\d)\s*(.*)$", tail, re.S)
            if m:
                pick, tail = int(m.group(1)), m.group(2).strip()
        try:
            if cmd == "/采纳":
                said = await review.accept(store, llm, settings, did, by, pick=pick, by_name=by_name)
            else:
                said = await review.reject(store, did, by)
        except review.DraftError as e:
            said = str(e)
        await out(said + _extra_ids(tail))

    async def do_memory(out: Sink, parts: list[str]) -> None:
        mid, _ = _split(parts)
        if mid is not None:
            r = await asyncio.to_thread(store.get_memory, mid)
            if r is None:
                await out(f"没有 #{mid} 这条记忆。")
                return
            await out(
                f"记忆 #{mid}（{r['staff_name']}，用过 {r['used']} 次，{r['updated_at'][:16]}）\n"
                f"客户问：{r['question']}\n回复：{r['answer']}\n——\n"
                f"改：/改记忆 {mid} 新的回复　删：/忘 {mid}"
            )
            return
        rows = await asyncio.to_thread(store.memories, 15)
        if not rows:
            await out("还没学到。同事在群里引用客户的话回答、或者紧接着回答，我就会记下来。")
            return
        lines = [f"学到的同事答法（共 {store.memory_count()} 条，新的在前）："]
        for r in rows:
            lines.append(f"[{r['id']}] 问：{_clip(r['question'], 30)}\n      {r['staff_name']}答：{_clip(r['answer'], 50)}（用过 {r['used']} 次）")
        lines.append("——\n没 @ 我的问题像到了就照这些原话回。看全文 /记忆 编号｜改 /改记忆 编号 新回复｜删 /忘 编号")
        await out("\n".join(lines))

    async def do_edit_memory(out: Sink, parts: list[str], by: int, by_name: str) -> None:
        mid, body = _split(parts)
        if mid is None or not body:
            await out("用法：/改记忆 3 新的回复（编号发 /记忆 看）")
            return
        r = await asyncio.to_thread(store.get_memory, mid)
        if r is None:
            await out(f"没有 #{mid} 这条记忆。")
            return
        body = body.strip()
        if not (2 <= len(body) <= 600):
            await out("回复要 2~600 字。")
            return
        if notice.looks_like_instruction(body):
            await out("这句像是给机器人看的（「让用户…」这种），客户收到的就是原文。写成直接对客户说的话。")
            return
        await asyncio.to_thread(store.update_memory, mid, answer=body, staff_id=by, staff_name=f"{by_name or by}改过")
        log.info("%s 改了记忆 #%d：%.40s", by_name or by, mid, body)
        await out(f"#{mid} 改好了 ✅ 客户问「{_clip(r['question'], 30)}」这类的，以后照这句回：\n{body}")

    async def do_forget(out: Sink, parts: list[str]) -> None:
        mid, tail = _split(parts)
        if mid is None:
            await out("用法：/忘 3（编号发 /记忆 看）")
            return
        ok = await asyncio.to_thread(store.delete_memory, mid)
        await out((f"#{mid} 忘了，以后不照它回。" if ok else f"没有 #{mid} 这条记忆。") + _extra_ids(tail))

    async def do_detail(out: Sink) -> None:
        row = await asyncio.to_thread(store.latest_review)
        if row is None:
            await out("还没有跑完过的复盘。每晚 23:00 自动跑。")
            return
        at = (row["finished_at"] or row["started_at"] or "")[:16]
        await out(f"（{at} 那次复盘的全文）\n{row['summary']}")

    async def do_teach(here: Sink, by: int, where: int, raw: str, by_name: str = "") -> None:
        try:
            plan = await teach.draft(rllm, raw)
        except teach.TeachError as e:
            await here(str(e))
            return
        await teach.find_dup(store, llm, plan, settings.kb_hit_score)
        cur = await asyncio.to_thread(notice.current, store) if plan.kind == teach.KIND_NOTICE else None
        plans[(where, by)] = (plan, time.monotonic())
        if where < 0:
            batches.pop(by, None)  # 私聊里同时只等一件事回「好」，免得一个「好」生效两样
            asst.pop(by)
        log.info("%s 发了 /加，等他回好：%s「%.30s」", by_name or by, plan.kind, plan.question)
        await here(teach.preview(plan, cur.outgoing if cur else ""))

    async def on_plan_reply(here: Sink, by: int, where: int, body: str, by_name: str = "") -> bool:
        """他发了 /加 之后回的「好 / 改：… / 新的」。不是在回预览 → False，这条消息不归我"""
        got = plans.get((where, by))
        if got is None:
            return False
        plan, at = got
        new_answer = teach.revision(body)
        if not (teach.is_yes(body) or new_answer or teach.is_new(body)):
            return False
        if time.monotonic() - at > teach.CONFIRM_MINUTES * 60:
            plans.pop((where, by), None)
            await here(f"那条预览超过 {teach.CONFIRM_MINUTES} 分钟作废了，什么都没改。要加就重新发 /加。")
            return True
        if teach.is_yes(body):
            plans.pop((where, by), None)
            await here(await teach.apply(store, llm, plan, by, by_name, cluster_score=settings.cluster_score))
            return True
        try:
            if new_answer:
                plan = teach.revise(plan, new_answer)
            elif plan.entry_id is None:
                await here("这条本来就是新的，回「好」就生效。")
                return True
            elif plan.question == plan.dup_question:
                # 问法一字不差的话另起也是按问法覆盖那条（upsert_entry 按问法找），等于没另起
                await here(f"#{plan.entry_id} 的问法跟这条一模一样，没法另起。要改它就回「好」。")
                return True
            else:
                plan.entry_id, plan.dup_question = None, ""
        except teach.TeachError as e:
            await here(str(e))
            return True
        plans[(where, by)] = (plan, time.monotonic())
        cur = await asyncio.to_thread(notice.current, store) if plan.kind == teach.KIND_NOTICE else None
        await here(teach.preview(plan, cur.outgoing if cur else ""))
        return True

    # ---- 私聊转发聊天记录 → 学答法（采纳才生效） ----

    async def learn_from(me: Sink, uid: int, name: str, lines: list[chat_record.Line] | None, shots: list[str]) -> None:
        """lines = 合并转发拆出来的发言；shots = 直接发的聊天截图地址。两样里有一样"""
        texts: list[str] = []
        if shots:
            from .relay import fetch_image

            for data, mime in await chat_record.gather_images(shots, fetch_image):
                try:
                    texts.append(await learn_chat.transcribe(
                        llm, data, mime, model=settings.vision_model, staff_hint="、".join(sorted(hints.get(uid, set()))),
                    ))
                except learn_chat.LearnError as e:
                    await me(f"有一张截图没看成：{e}")
            if not texts:
                await me("截图没看成（下载不下来或者看图模型没回），再发一次试试。")
                return
        if lines is not None:
            known = await asyncio.to_thread(store.staff_nicknames) | hints.get(uid, set())
            ids = await staff() | settings.super_admins | ({client.self_id} if getattr(client, "self_id", 0) else set())
            dialog, names = await chat_record.to_dialog(lines, rllm, staff_ids=frozenset(ids), known_names=known)
            if not names:
                records[uid] = (lines, time.monotonic())
                await me(
                    "这段记录里认不出哪个是客服（没人在回答问题，或者客服昵称我不认识）。\n"
                    "要是有客服在里面，回一句「客服是 昵称」（几个用逗号隔开），我拿这段重新整理，不用再转发。"
                )
                return
            texts.append(dialog)
            log.info("%s 私聊转发的聊天记录：%d 条发言，认成客服的是 %s", name, len(lines), "、".join(sorted(names)))
        try:
            async with asyncio.timeout(600):
                res = await learn_chat.analyze(store, rllm, llm, texts, hit_score=settings.kb_hit_score, by_name=f"{name} 私聊转发")
        except (learn_chat.LearnError, TimeoutError) as e:
            await me(f"没整理成：{e or '超时了'}")
            return
        records.pop(uid, None)
        if not res.drafts:
            why = "\n".join(f"· {s}" for s in res.skipped[:5])
            await me("这段聊天里没整理出能当标准答案的问答（只有闲聊，或者客服没给出具体回答）。" + (f"\n{why}" if why else ""))
            return
        batches[uid] = (res.drafts, time.time())
        asst.pop(uid)
        plans.pop((-uid, uid), None)
        out = [f"📚 从这段聊天学到 {len(res.drafts)} 条（还没生效）："]
        for i, did in enumerate(res.drafts[:15], 1):
            d = await asyncio.to_thread(store.get_draft, did)
            if d is None:
                continue
            opt = (store.draft_options(d) or [{"answer": d["answer"]}])[0]["answer"]
            dup = "（跟已有答案像）" if "像" in d["note"] else ""
            out.append(f"{i}. 客户问：{_clip(d['question'], 40)}{dup}\n   回复：{_clip(opt, 120)}")
        if len(res.drafts) > 15:
            out.append(f"……还有 {len(res.drafts) - 15} 条，在 6099「待审草稿」页")
        if res.skipped:
            out.append(f"（另有 {len(res.skipped)} 处没起草，比如：{_clip(res.skipped[0], 40)}）")
        out.append("")
        out.append(f"👉 回复「好」全部生效；只要几条就回「好 1 3」；回「不要」全扔掉（{LEARN_MINUTES} 分钟内）")
        out.append("不回也行：都留在 6099「待审草稿」，想改字去那里改了再采纳")
        await me("\n".join(out))

    async def do_learn(ev: PrivateMessage) -> None:
        me = to_user(ev.user_id)
        if ev.user_id in learning:
            await me("上一段还在整理，等我回完再发下一段。")
            return
        learning.add(ev.user_id)
        try:
            if chat_record.has_record(ev.message):
                await me("收到聊天记录，正在拆开整理，一两分钟。")
                lines = await chat_record.flatten(client.call_api, ev.message)
                if not lines:
                    await me("这段转发拆出来是空的（可能过期了），在 QQ 里重新转发一次。")
                    return
                from .relay import fetch_image

                await chat_record.describe_images(lines, llm, model=settings.vision_model, fetch=fetch_image)
                await learn_from(me, ev.user_id, ev.sender_name, lines, [])
            else:
                await me("收到聊天截图，正在看，一两分钟。")
                await learn_from(me, ev.user_id, ev.sender_name, None, chat_record.image_urls(ev.message))
        except Exception:
            log.exception("私聊学答法出错")
            await me("整理的时候出错了，看日志。草稿要是起了一部分，在 6099「待审草稿」页。")
        finally:
            learning.discard(ev.user_id)

    async def on_learn_reply(ev: PrivateMessage, body: str) -> bool:
        """他转发记录之后回的「好 / 好 1 3 / 不要 / 客服是 xx」。不是 → False"""
        uid, me = ev.user_id, to_user(ev.user_id)
        m = re.match(r"^客服(?:是|有)?\s*[:：]?\s*(.+)$", body)
        if m and uid in records:
            names = {x.strip() for x in re.split(r"[,，、\s]+", m.group(1)) if x.strip()}
            hints[uid] = names
            lines, _ = records[uid]
            if uid in learning:
                await me("还在整理上一段，等一下。")
                return True
            learning.add(uid)
            try:
                await me(f"好，按「{'、'.join(sorted(names))}」是客服重新整理。")
                await learn_from(me, uid, ev.sender_name, lines, [])
            finally:
                learning.discard(uid)
            return True
        got = batches.get(uid)
        if got is None:
            return False
        ids, at = got
        yes = _LEARN_YES.match(body)
        if not (yes or body in {"不要", "都不要", "不用"}):
            return False
        batches.pop(uid, None)
        if time.time() - at > LEARN_MINUTES * 60:
            await me(f"超过 {LEARN_MINUTES} 分钟了，这批没动，还在 6099「待审草稿」等你审。")
            return True
        if not yes:
            for did in ids:
                try:
                    await review.reject(store, did, uid)
                except review.DraftError:
                    pass
            await me(f"这 {len(ids)} 条都扔了。")
            return True
        nums = [int(x) for x in re.findall(r"\d+", yes.group(1))]
        pick = [ids[n - 1] for n in nums if 1 <= n <= len(ids)] if nums else ids
        done, failed = [], []
        for did in pick:
            try:
                said = await review.accept(store, llm, settings, did, uid, by_name=ev.sender_name)
                done.append(said.split("\n")[0])
            except review.DraftError as e:
                failed.append(str(e))
        rest = len(ids) - len(pick)
        msg = f"生效了 ✅ {len(done)} 条，下次客户这么问就照这个回。"
        if done:
            msg += "\n" + "\n".join(f"· {_clip(x, 60)}" for x in done[:10])
        if failed:
            msg += "\n没成的：" + "；".join(failed[:3])
        if rest:
            msg += f"\n没选的 {rest} 条还在 6099「待审草稿」"
        await me(msg)
        return True

    # ---- 管理员私聊大白话（bot/kb/assistant.py）：理解 → 列出来 → 回「好」才改 ----

    async def do_assistant(ev: PrivateMessage, body: str) -> None:
        me = to_user(ev.user_id)
        if ev.user_id in learning:
            await me("上一件还在弄，等我回完再说。")
            return
        learning.add(ev.user_id)
        try:
            p = await assistant.plan(rllm, llm, store, body)
        except assistant.AssistantError as e:
            await me(str(e))
            return
        except Exception:
            log.exception("管理员大白话出错")
            await me("这句我没处理好（出错了，看日志）。换个说法再说一次，或者用指令。")
            return
        finally:
            learning.discard(ev.user_id)
        if p.actions:
            asst.put(ev.user_id, p.actions)
            batches.pop(ev.user_id, None)
            plans.pop((-ev.user_id, ev.user_id), None)
        log.info("%s 私聊大白话：%.40s → %d 件改动", ev.sender_name, body, len(p.actions))
        await me(assistant.preview(p) or "收到。")

    async def on_asst_reply(ev: PrivateMessage, body: str) -> bool:
        got = asst.get(ev.user_id)
        if got is None:
            return False
        yes = _LEARN_YES.match(body)
        if not (yes or body in {"不要", "取消", "算了", "不用"}):
            return False
        actions, at = got
        asst.pop(ev.user_id)
        me = to_user(ev.user_id)
        if time.time() - at > LEARN_MINUTES * 60:
            await me(f"超过 {LEARN_MINUTES} 分钟了，没改。要改再说一次。")
            return True
        if not yes:
            await me("好，都没改。")
            return True
        nums = [int(x) for x in re.findall(r"\d+", yes.group(1))]
        pick = [actions[n - 1] for n in nums if 1 <= n <= len(actions)] if nums else actions
        done = await assistant.execute(store, llm, settings, pick, ev.user_id, ev.sender_name)
        await me("\n".join(done) or "没有要做的。")
        return True

    async def do_handoff(
        cmd: str, parts: list[str], by: int, here: Sink, out: Sink, where_group: int | None, by_name: str = ""
    ) -> None:
        """/会话 /接管 /结束。

        **关着的时候明说，不静默**：静默不理正是看门狗那个盲区的形状 ——
        「没报错」被当成「在工作」。出错也当面说，同一个理由。
        """
        by_name = by_name or str(by)
        if not handoffs.enabled:
            await here(OFF_TEXT)
            return
        try:
            if cmd == "/会话":
                await out(await asyncio.to_thread(handoffs.listing))
                return
            hid, tail = _split(parts)
            if hid is None:
                await here(f"用法：{cmd} 5\n编号发 /会话 看")
                return
            act = handoffs.take if cmd == "/接管" else handoffs.end
            said = await asyncio.to_thread(act, hid, by, where_group=where_group)
            # 多打的编号必须回给他 —— 没关掉的那个客户还在等人工
            await here(said + _extra_ids(tail))
            await handoffs.refresh_open()
        except Exception as e:
            log.exception("转人工指令 %s 出错", cmd)
            await here(f"{cmd} 出错了（{type(e).__name__}），看日志。会话状态没动。")

    async def run(
        cmd: str,
        parts: list[str],
        by: int,
        *,
        here: Sink,
        out: Sink,
        report_to: int,
        report_private: bool,
        where_group: int | None,
        by_name: str = "",
    ) -> None:
        """真正干活的那一段，群和私聊共用。

        两个出口：`here` 是「就地回」（打指令的那个群，或者打指令的那个人），
        `out` 是「内部数据往哪儿发」。群里这两个可能不一样（见 `INTERNAL`），
        私聊里是同一个。**共用这一段是故意的** —— 不然群里改对了私聊忘了改，
        两边行为会慢慢长歪，而这种歪只有真机上才看得出来。
        """
        if cmd in {"/帮助", "/help"}:
            await here(USAGE)
        elif cmd in RETIRED:
            await here(f"{cmd} {RETIRED[cmd]}")
        elif cmd in MENU:
            # **不跟 /帮助 一样就地回**：里面有入群审批的放行规则（售后群答案什么开头自动同意）、
            # 同事开口就算接管这些内部规则，落进客户群等于把后门贴在墙上。所以在 INTERNAL 里，发日报群
            await out(menu.render(settings))
        elif cmd in DETAIL:
            await do_detail(out)
        elif cmd in TEACH:
            await do_teach(here, by, where_group if where_group is not None else -by, " ".join(parts[1:]), by_name)
        elif cmd == "/答":
            await do_answer(here, by, parts, by_name)
        elif cmd == "/改":
            await do_edit(here, parts, by, by_name)
        elif cmd == "/删":
            await do_delete(here, parts, by, by_name)
        elif cmd == "/忽略":
            await do_ignore(here, parts)
        elif cmd == "/同步":
            await do_sync(here, parts)
        elif cmd in HANDOFF:
            await do_handoff(cmd, parts, by, here, out, where_group, by_name)
        elif cmd in DRAFTS:
            await do_decide(here, cmd, by, parts, by_name)
        elif cmd == "/记忆":
            await do_memory(out, parts)
        elif cmd == "/改记忆":
            await do_edit_memory(here, parts, by, by_name)
        elif cmd == "/忘":
            await do_forget(here, parts)
        elif cmd in NOTICE:
            said = await notice.command(store, " ".join(parts[1:]), by)
            if "给机器人看的指令" in said:
                # 10-12 小追兵那次：被拒了不知道下一步。直接给他一条能用的路
                said += "\n· 最省事：把原话发 /加，我改成客户能看的给你看，你回「好」才生效"
            await here(said)

    async def _is_super(ev: GroupMessage) -> bool:
        return ev.user_id in settings.super_admins or (
            bool(settings.report_group) and ev.group_id == settings.report_group and ev.user_id in await staff()
        )

    async def hint_unknown(ev: GroupMessage, body: str) -> None:
        """日报群里自己人打了个不存在的 / 指令 → 告诉他该用哪个，不再装没看见。

        起因 2026-10-12：小追兵照着复盘里「等你定调的」打了 /定调 …，机器人一声不吭
        （这儿不认、qa.py 也不接 / 开头的），他只好换着词再发一遍。
        **只在日报群、只对超管和自己人**：客户群里客户打个 /xxx 回提示 = 把后台指令表亮给客户看
        """
        if not body.startswith(("/", "／")) or not settings.report_group or ev.group_id != settings.report_group:
            return
        name = body.split()[0] if body.split() else body
        if name.startswith(settings.qa_prefix) or claimed(GROUP, name):
            return  # /问 之类别的模块在接
        if not await _is_super(ev):
            return
        log.info("日报群 %s（%s）发了不认识的 %s，回了提示", ev.sender_name, ev.user_id, name[:20])
        await to_group(ev.group_id)(
            f"没有 {name[:12]} 这个指令。\n想加答案、定说法：直接发「/加 一句大白话」，我整理好给你看，你回「好」才生效。\n全部指令：/帮助"
        )

    @dispatcher.on("message.group")
    async def on_group(ev: GroupMessage) -> None:
        if not settings.group_enabled(ev.group_id):
            return
        body = ev.plain_text.strip()
        parts = normalize(body)
        # 他刚发过 /加、这条是在回预览（好 / 改：… / 新的）。只认同一个人、同一个群，
        # 别人回「好」、他在别的群回「好」都不算（见 bot/kb/teach.py 开头）
        if (ev.group_id, ev.user_id) in plans and not (parts and parts[0] in COMMANDS):
            if await on_plan_reply(to_group(ev.group_id), ev.user_id, ev.group_id, body, ev.sender_name):
                return
        if not parts or parts[0] not in COMMANDS:
            await hint_unknown(ev, body)
            return

        cmd = parts[0]
        # 自己人在日报群里跟超管一样（见模块开头「谁能用」）。**只在日报群**：
        # 没配 REPORT_GROUP（=0）时这一条永远不成立，不会因为没配就变成哪个群都行
        is_super = await _is_super(ev)
        role = str(ev.sender.get("role") or "member")
        if not is_super and (
            cmd in WRITE or cmd in HANDOFF or cmd in DRAFTS or cmd in NOTICE or cmd in TEACH or cmd in MEMORY
            or role not in {"owner", "admin"}
        ):
            # 普通群员发这些指令多半是好奇，回一句比装没看见强；
            # 但绝不告诉他「你不是超管」之外的任何信息
            log.info("群 %s 的 %s（%s）发了 %s，权限不够", ev.group_id, ev.sender_name, ev.user_id, cmd)
            if cmd in WRITE:
                await to_group(ev.group_id)("标准答案只有管理员能定。自己人在日报群里能定。")
            elif cmd in HANDOFF:
                await to_group(ev.group_id)("转人工会话只有管理员能管。自己人在日报群里能管。")
            elif cmd in DRAFTS:
                await to_group(ev.group_id)("草稿只有管理员能审。自己人在日报群里能审。")
            elif cmd in NOTICE:
                await to_group(ev.group_id)("口径只有管理员能定。自己人在日报群里能定。")
            elif cmd in TEACH:
                await to_group(ev.group_id)("加答案只有管理员能加。自己人在日报群里能加。")
            elif cmd in MEMORY:
                await to_group(ev.group_id)("记忆只有管理员能管。自己人在日报群里能管。")
            return

        here = to_group(ev.group_id)

        # 带内部数据的那几条，回复发到 REPORT_GROUP，不发回当前群（见 INTERNAL）。
        # 没配 REPORT_GROUP 就当场说清楚 —— 这句提示本身不含任何客户数据
        dest = ev.group_id
        out = to_group(dest)
        if cmd in INTERNAL:
            if not settings.report_group and cmd == "/会话":
                # 没配日报群也得让他看得见名单（理由见模块开头），改私聊本人，
                # **不发回当前群** —— 名单里是全部群的客户
                log.info("群 %s 的 %s 发了 /会话，REPORT_GROUP 没配，改私聊本人", ev.group_id, ev.sender_name)
                out = to_user(ev.user_id)
            elif not settings.report_group:
                await here("内部数据不在这儿发。先在 .env 配 REPORT_GROUP=<内部群号>，重启后再用。")
                return
            else:
                dest = settings.report_group
                out = to_group(dest)
                if dest != ev.group_id:
                    log.info("群 %s 的 %s 发了 %s，结果发到日报群 %s", ev.group_id, ev.sender_name, cmd, dest)

        await run(
            cmd, parts, ev.user_id,
            here=here, out=out, report_to=dest, report_private=False, where_group=ev.group_id,
            by_name=ev.sender_name,
        )

    @dispatcher.on("message.private")
    async def on_private(ev: PrivateMessage) -> None:
        """私聊里的同一套指令。起因见模块开头那段（`/答 23` 被回「不认识的指令」）。

        **只认 `PRIVATE_COMMANDS` 里的指令名，其余一概不响应。** 普通私聊
        （问句、闲话、`/` 开头的别的东西）不归这儿管，也不归这儿兜底 ——
        2026-09-23 管理员定的「先保持静默」，等阶段 6 做私聊转人工时一起定。
        09-30 起普通私聊归 handlers/dm.py：客户私聊回一句固定话，请他到群里问。
        """
        body = ev.plain_text.strip()
        parts = normalize(body)
        # 超管 / 自己人私聊转发聊天记录（合并转发）或者发聊天截图 → 拆开学答法（chat_record.py）
        if not body.startswith("/") and (
            chat_record.has_record(ev.message) or (chat_record.image_urls(ev.message) and not body)
        ):
            if ev.user_id in settings.super_admins or ev.user_id in await staff():
                await do_learn(ev)
            return
        if asst.get(ev.user_id) is not None and not body.startswith("/"):
            if await on_asst_reply(ev, body):
                return
        if (ev.user_id in batches or ev.user_id in records) and not body.startswith("/"):
            if await on_learn_reply(ev, body):
                return
        elif (
            _LEARN_YES.match(body) and (-ev.user_id, ev.user_id) not in plans
            and (ev.user_id in settings.super_admins or ev.user_id in await staff())
        ):
            # 回了「好 2 4」却没有在等的那批（超时、或者被删了）：说清楚，别一声不吭（10-15 19:50 真事）
            await to_user(ev.user_id)(
                "现在没有等你确认的（超过半小时了，或者那批已经被处理掉了）。\n"
                "要学的话重新转发一次聊天记录；之前那批要是还在，去 6099「待审草稿」页点采纳。"
            )
            return
        if (-ev.user_id, ev.user_id) in plans and not (parts and parts[0] in PRIVATE_COMMANDS):
            # 私聊回预览。plans 里有他 = 他是超管（只有超管私聊的 /加 会走到这儿）
            if await on_plan_reply(to_user(ev.user_id), ev.user_id, -ev.user_id, body, ev.sender_name):
                return
        if not parts or parts[0] not in PRIVATE_COMMANDS:
            # 管理员（超管、自己人）私聊大白话 → 自己理解要做什么（2026-10-15）。/ 开头的不认识指令照旧交给 admin.py
            if body and not body.startswith(("/", "／")) and (
                ev.user_id in settings.super_admins or ev.user_id in await staff()
            ):
                await do_assistant(ev, body)
            return

        cmd = parts[0]
        # **私聊只认超管，而且这道门是自己写的，不是抄群里那一道。**
        # 群里放开了「群主 / 群管理员能看」，靠的是群消息自带 `sender.role`；
        # 私聊事件里没有这个字段，群身份在这儿无从查证，照抄就是凭空放宽。
        if ev.user_id not in settings.super_admins:
            # 不回复也不提示，免得给人试探的反馈（跟 admin.py 私聊那道门一个规矩）
            log.warning("非超管 %s(%s) 私聊发了 %s，已忽略", ev.sender_name, ev.user_id, cmd)
            return

        # 私聊不往日报群转（理由见模块开头「回复发到哪」）：改发日报群是为了
        # 别让客户看见内部数据，超管私聊本来就是最私密的一条道。
        # 所以这一路也不检查 REPORT_GROUP 配没配
        me = to_user(ev.user_id)
        log.info("超管 %s 私聊发了 %s", ev.sender_name, cmd)
        await run(
            cmd, parts, ev.user_id,
            here=me, out=me, report_to=ev.user_id, report_private=True, where_group=None,
            by_name=ev.sender_name,
        )