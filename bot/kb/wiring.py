"""把阶段 5 整套东西挂上去的唯一入口。

`bot/__main__.py` 里只要两行：

    qa = wiring.setup(dispatcher, client, settings)   # 注册处理器 + 排日报
    ...
    await qa.close()                                   # 退出前收摊

**做成一个函数是有原因的**：`__main__.py` 里挂着阶段 3/4 已经上线的四个处理器，
那个文件在别人手上。把注册、自检、日报排程、关连接全收进这里，接线时
只加两行，改坏已上线功能的机会就小得多。

没配 `LLM_BASE_URL` / `LLM_API_KEY` 时 `setup()` 照样返回一个对象，
只是什么都不注册。这样入群审批不会因为阶段 5 没配齐就起不来。
"""
from __future__ import annotations

import asyncio
import logging

from ..config import Settings
from ..dispatcher import Dispatcher
from ..handlers import adwatch, dm, kb_admin, listen, qa
from .. import handoff as handoff_mod
from ..handoff import Handoffs
from ..onebot import ApiError, OneBotClient, text
from ..store import Store
from . import review, watch
from .answer import Answerer
from .llm import LLM, LLMError
from .store import KBStore

log = logging.getLogger(__name__)


def _log_done(t: asyncio.Task[None]) -> None:
    """后台任务结束时的回调：不是被取消、而是抛异常退出的，记一条 ERROR。
    复盘、盯群、会话过期、知识库接口这几个任务本该一直跑；循环里接了 Exception，
    但循环外抛的错以前会让任务**静默**结束 —— 夜间复盘停了都没人知道"""
    if t.cancelled():
        return
    exc = t.exception()
    if exc is not None:
        log.error("后台任务 %s 意外结束", t.get_name(), exc_info=exc)


def _tracked(t: asyncio.Task[None]) -> asyncio.Task[None]:
    t.add_done_callback(_log_done)
    return t

# 不许上线的模型。**这是一份「2026-09-22 在 api.lmuai.com 上实测坏掉的组合」的
# 快照，不是关于这些模型本身的永久结论。**
#
# 坏在哪：进推理模式时回复开头会掉一两个 token，线上原始字节就是残的，
# 客户端修不了（病因定位见 llm.py 顶部）。拦它是因为真正兜不住的不是
# NO_ANSWER 变 _ANSWER（answer.py 的 _chewed_marker 接着），而是**正常答案也会残**：
# 客户拿到 `://api.lmuai.com` 这种地址，内容错了但读着像答案，代码无从发现。
# 宁可整块不启用——不启用的代价是零，等于维持接线之前的现状。
#
# **什么时候往里加**：发现新的模型会啃字就加进来。
# **什么时候可以拿掉**：换了中转站，或者这家修好了。都要重验才能动，
#   验法见 llm.py 顶部（同一个长提示词连打十几次，看有没有哪次开头少字）。
# **这道保险的真实强度**：只挡住「已知坏的那几个名字」。它按模型名匹配，
#   而 bug 的触发条件是「这个中转站 × 推理模式」——换个没验过的推理模型，
#   同样的 bug、名字不在这儿，这里就拦不住了。那种情况靠 llm.py 里
#   _warn_if_unverified_reasoner() 记一条 WARNING 让人看见，不是靠这个集合。
BROKEN_MODELS = frozenset({"deepseek-v4-flash"})


class QASystem:
    """问答系统的句柄。没启用时是个空壳，所有方法都安全可调。"""

    def __init__(self, store: KBStore | None = None, llm: LLM | None = None) -> None:
        self.store = store
        self.llm = llm
        self.review_llm: LLM | None = None  # 复盘自己的模型（REVIEW_MODEL）；跟 llm 同一个就是 None 或同一个对象
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def enabled(self) -> bool:
        return self.llm is not None

    async def close(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                # 早就因为异常结束了的任务，await 会把异常再抛一遍；不接住的话
                # 后面的 llm / store 都关不上。异常本身 _log_done 已经记过了
                pass
        if self.llm is not None:
            await self.llm.close()
        if self.review_llm is not None and self.review_llm is not self.llm:
            await self.review_llm.close()
        if self.store is not None:
            self.store.close()


def setup(
    dispatcher: Dispatcher, client: OneBotClient, settings: Settings, approval_store: Store | None = None,
) -> QASystem:
    """`approval_store` = 入群审批那个库（data/approvals.db），给 8090 的「被封禁用户」页用。不给的话那页接口回 503"""
    if not settings.llm_ready:
        log.warning("LLM_BASE_URL / LLM_API_KEY 没配，AI 问答不启用（其它功能照常）")
        return QASystem()

    # 查的是**真正跟客户对话的那个模型**（settings.chat_model），不是 llm_model。
    # 10-09 拆出 LLM_CHAT_MODEL 之后 llm_model 只喂 embedding 了：只看 llm_model
    # 会让一个会啃字的模型从 LLM_CHAT_MODEL 那一路绕进来，而这条闸一声不响
    if settings.chat_model in BROKEN_MODELS:
        log.error(
            "对话模型=%s 实测会啃掉回复开头的几个字（NO_ANSWER 会变成 _ANSWER 发给客户），"
            "AI 问答不启用。请把 .env 的 LLM_CHAT_MODEL / LLM_MODEL 改成 kimi-k2.5 再重启；"
            "其它功能照常跑。详情见 bot/kb/llm.py 顶部",
            settings.chat_model,
        )
        return QASystem()

    store = KBStore()
    # 对话用专门的 LLM_CHAT_* 一组（有配就用），embedding 一律走 LLM_* 那组。
    # 「两组怎么挑」的规则在 config.py 的 chat_* 里（只算一次，scripts/ask.py 也从那儿取）
    llm = LLM(
        settings.chat_base_url, settings.chat_api_key,
        chat_model=settings.chat_model, embed_model=settings.embedding_model,
        embed_base_url=settings.llm_base_url, embed_api_key=settings.llm_api_key,
        thinking=settings.llm_thinking,
    )
    # 复核只有一级（2026-10-16 砍掉预筛：当天跑 10 次只省下 1 次终审，每次还要 2~5 秒）
    answerer = Answerer(store, llm, settings)
    # 两边共用一个：问答那边开会话、自动接管，指令那边列出、接管、结束
    handoffs = Handoffs(store, settings)
    # 复盘用自己的模型（REVIEW_MODEL，理由见 config.py），向量还是同一个 embedding 模型
    review_llm = LLM(
        settings.llm_base_url, settings.llm_api_key,
        chat_model=settings.review_model, embed_model=settings.embedding_model,
    ) if settings.review_model != settings.llm_model else llm
    # 返回的是「没 @ 我、十分钟没人回的问题，命中标准答案就答」那一段，交给下面的盯群用
    answer_unasked = qa.register(dispatcher, client, settings, store, answerer, llm, handoffs)
    kb_admin.register(dispatcher, client, settings, store, llm, handoffs, review_llm=review_llm)
    # 客户私聊机器人：回一句固定话请他到群里问（09-30 他选的，不在私聊里答题）
    dm.register(dispatcher, client, settings, handoffs.staff)
    # 记群消息给夜间复盘用（只留一天）。关了复盘就不记
    if settings.review_enabled:
        listen.register(dispatcher, settings, store)
    # 盯广告：打别家广告、拉人进群、留联系方式、刷屏，报给超管（AD_RECALL=1 才自动撤回）。
    # 跟问答是两个独立的处理器，这一层坏了不影响答题
    adwatch.register(dispatcher, client, settings, llm, handoffs.staff)

    system = QASystem(store, llm)
    system._tasks.append(_tracked(asyncio.create_task(_probe(llm), name="llm-probe")))
    # 22:00 的问答日报 2026-09-29 停了（管理员：「问答日报不需要了 因为有了每日复盘」）。
    # 「等你定调」挪进了 23:00 的复盘结果（review.render）；/日报 指令照旧能随时手动查
    system.review_llm = review_llm
    system._tasks.append(_tracked(asyncio.create_task(review.loop(client, store, review_llm, settings, answer_llm=llm), name="nightly-review")))

    async def tell_admins(body: str) -> None:
        for uid in sorted(settings.super_admins):
            try:
                await client.send_private_msg(uid, [text(body)])
            except (ApiError, ConnectionError) as e:
                log.warning("私聊超管 %s 失败：%s", uid, e)

    system._tasks.append(_tracked(asyncio.create_task(watch.loop(store, settings, tell_admins, answer_unasked), name="day-watch")))
    # **日报群里机器人主动发的只有 23:00 复盘那一条**（review.run_once 自己发）。
    # 09-30 他定的：「日报群就发23点一条就可以了 别的也不需要发 剩下的只有我问你你在回复我」。
    # 以前还往这儿发的：接管播报（✋ 谁接了谁）、自动关会话（🔓）、爬完常见问题（🕷）、掉线通知，都停了，只记日志

    # 会话 5 分钟没动静自动关：**不通知**（关不关对客户没区别，他再 @我 照常回答；通知只会变成噪音）
    system._tasks.append(_tracked(asyncio.create_task(handoff_mod.expire_loop(handoffs), name="handoff-expire")))
    # 知识库接口（6099 左边栏「标准答案」「资料库」「群公告」这些页用）。鉴权借 6099 的登录，不另设口令。
    # 群公告那几个要用机器人自己的 QQ 连接发，所以 client 也给它
    from .. import admin_web

    system._tasks.append(_tracked(asyncio.create_task(admin_web.serve(settings, store, llm, rewrite_llm=review_llm, client=client, approval_store=approval_store), name="admin-web")))

    log.info(
        "AI 问答已启用 | %s | 命中线 %.2f / 资料线 %.2f | 重写=%s / 长答案缩短=%s | 触发：@我 或 %s | 转人工会话=%s",
        store.stats_line(), settings.kb_hit_score, settings.rag_min_score,
        settings.rewrite, settings.condense, settings.qa_prefix, settings.handoff_enabled,
    )
    if not store.chunk_count():
        log.warning("库里一个资料块都没有，先跑 uv run -m bot.kb.ingest，不然什么都查不到")
    return system


async def _probe(llm: LLM) -> None:
    """自检放后台跑。中转站慢的时候不该连带拖住机器人上线——
    真有问题这条日志会说清楚，而且第一个提问也会立刻暴露。"""
    try:
        log.info("中转站自检：%s", await llm.probe())
    except LLMError as e:
        log.error("中转站自检没过，AI 问答现在答不了：%s", e)
