"""中转站客户端。OpenAI 兼容的 /chat/completions 和 /embeddings。

base_url 由 config._api_base() 补成 `…/v1` 再传进来，这里只管拼后半段路径。
漏了 /v1 的后果不是 404 而是一个 HTTP 200 的 HTML 页面，见那个函数的注释。

选型依据在方案 §10（2026-09-22 横评 14 个模型）：embedding 用
qwen3.7-text-embedding（1024 维）。Claude 因为中转站有约 4100 token 固定开销被淘汰。

**对话模型从 deepseek-v4-flash 换成了 kimi-k2.5**，因为 deepseek 在这个中转站上
**偶发丢掉回复开头的一小截**。同一天真机实测：

| 场景 | deepseek-v4-flash | glm-5.2 | kimi-k2.5 |
|---|---|---|---|
| 真实 RAG 提示词 ×24 | 空回复 2 次、`NO_ANSWER` 被啃成 `_ANSWER` 1 次 | 0 | 0 |
| 重写自检通过率 | **5/12**（失败的全是 `{"answer` 被啃掉，成了坏 JSON） | 12/12 | 12/12 |
| 该答的 15 问答出几个 | — | 13 | **14** |
| 中位延迟 | 1.9s | 5.1s | 4.4s |

丢掉的样子：`'_ANSWER'`（少了 `NO`）、`'": "正常的话…'`（少了 `{"answer`）、
`'://api.lmuai.com'`（少了 `https`）、`'muai.com'`（少了 `https://api.l`）。

**病因定位（2026-09-22 复核，绕开本文件直接看线上原始字节）**：
问「接口地址是什么」×12，11 次回包**只有 `content` 字段**、答案完好；
出事的那 1 次是**唯一同时带 `reasoning_content` 的那次**，content 成了
`'://api.lmuai.com'`。也就是说这个模型一旦进推理模式，推理段转正文段的接缝上
会掉一小截。丢的长度不固定（2、5、8、13 个字符），像掉了一两个 token，
不像固定切片。

**不是本文件的锅。** 证据链有三节，**真正堵死的是第三节**，前两节单独都不够：
1. 线上原始 JSON 里 `"content"` 的值本身就是残的 —— 这只排除了「解析回包时
   切了一刀」（这里是 `stream: False` + `msg.get("content")` + `.strip()`，
   没有切片也没有拼接）；
2. 发请求那一步对所有模型是同一份 payload，没有任何模型分支 —— 这排除了
   「因为是这个模型，所以请求发得不一样」；
3. kimi **每一次**回包都同时带 `content` 和 `reasoning_content`，走同一段代码，
   38 次零缺陷 —— 双字段触发的客户端 bug 真存在，kimi 会一起烂。这一节才让
   「客户端」和「客户端之外」这两个假说不再对称。

**这组数据分不开「模型」和「中转站」**：拿到的原始字节是中转站吐出来的，
到底是模型生成时就少了，还是中转站转发时掉的，从这里看不出来。所以上面
一律写「在这个中转站上」而不是「这个模型有毛病」。不影响决策——同一个
中转站上换成 kimi 就好，动作一样。

也别想着「把 reasoning_content 接到 content 前面补回来」：实测那两段接不上
（推理段末尾是「…直接答。」这样的完整思考句，不是答案的前半截），
而且推理过程本来就不该发给客户。

**最要命的不是 `NO_ANSWER` 变 `_ANSWER`**（那个 answer.py 里有 `_chewed_marker`
兜着）。是正常答案也会被啃：客户拿到的是 `://api.lmuai.com` 这种残地址，
内容错了但读着像个答案，代码无从发现。这种没法在客户端修，只能不用这个模型。

改模型只要动 .env 的 `LLM_MODEL` 一行，代码不用改；黑名单在 kb/wiring.py。

**超时设 90 秒**：实测所有可用模型中位延迟 9~13s，最慢见过 24.8s。设小了会在
高峰期把本来能成的请求掐掉，而问答超时的代价是客户白等；设大了只是失败晚一点。

**向量入库前归一化成单位向量**，检索时余弦相似度就等于点积，省掉每次算模长。
这是全项目向量比对的共同前提，改这里要同步改 retrieve.py。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import math
import random
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Sequence

import httpx

log = logging.getLogger(__name__)

TIMEOUT = 90.0
# 默认输出额度。**别为了省钱往小了调。** deepseek-v4-flash 是推理模型，
# 它先写一段 reasoning_content，这段同样吃 max_tokens，而且**不会出现在
# content 里也不会让 finish_reason 变成 length**。2026-09-22 实测同一个提问：
#   max_tokens=16  → message 里只有 reasoning_content，没有 content 这个键
#   max_tokens=64  → 同上（completion_tokens=38，已经超过 16 那次的上限）
#   max_tokens=200 → content='正常'
# 也就是说额度给小了，表现是「模型回了空内容」而 finish_reason 还写着 stop，
# 完全看不出是额度问题。1500 给思考留够余量，正文本身几百字绰绰有余
MAX_TOKENS = 1500
# 只要一句 YES / NO 的判断题用这个额度。**不许往小填。**
# 2026-09-30 踩的（/口径 上线当天就坏了）：`deepseek-v4.1-flash` 回 YES 之前也要先想
# 90~130 个 token，而 max_tokens 卡的是**思考 + 正文的总额**。同一个判断题各打 20 次：
#   max_tokens=8 → 成功 2/20（18 次正文是空的，finish_reason=length）
#   max_tokens=600 → 19/20；2000 也是 19/20（不是额度越大越好，剩下那次是偶发）
#   600 + 下面那道「空了就加大重发」→ 20/20
# 判断失败的调用方多半当「没判出来」放过去，所以这种失败是**静默**的：/口径 发了不生效，
# 日志里只有一行 WARNING。别再用小额度省钱 —— 一次判断百来个 token，省不出什么
JUDGE_TOKENS = 600
# 上面那道兜底加大多少倍重发
_RETRY_FACTOR = 3
# 一次 embedding 请求最多带几条。**上限是 20，别往上调。**
# 2026-09-22 实测：32 条时导入直接挂在
#   HTTP 400 batch size is invalid, it should not be larger than 20
# 取 16 留点余量——上限是上游模型（qwen）给的，中转站换个后端就可能更小
EMBED_BATCH = 16
# 句末标点。和 bot/handlers/qa.py 的 _SENT_END 是同一套标点，用途不同：
# 那边是把完整回复切段，这边是把被截断的回复砍回最后一个完整句子
_SENT_END = re.compile(r"[~。！？…!?]+")
# 已经按上面那套实测跑过、确认不啃字的模型。
# **这不是「推荐模型」清单，是「验过了」清单**——不在里面不等于坏，等于没验。
# 它只有一个用途：模型进推理模式时决定要不要提醒你去验（见 chat 里那条 WARNING）。
# v4.1：2026-09-29 连打 75 次 0 啃字；claude-opus-5-5：2026-10-10 非推理配置连打 40 次 + 破甲实测 12 次，0 啃字（docs §35）
KNOWN_CLEAN = frozenset({"kimi-k2.5", "glm-5.2", "deepseek-v4.1-flash", "claude-opus-5-5"})
# 图片转文字的提示词。要的是能被检索到的原文，不是描述——
# 截图里的菜单名、报错原文、按钮文字才是客户会问到的东西
_READ_IMAGE_PROMPT = (
    "这是一张客服资料图片（可能是截图、教程、价目表、报错）。"
    "把图里所有文字原样抄出来，保持原有的层级和顺序；表格用 markdown 表格。"
    "抄完另起一段，用一两句话说明这张图讲的是什么、适合回答什么问题。"
    "只输出内容本身，不要加开场白。"
)
# 提问向量的内存缓存。群里重复问同一句话很常见（尤其是转发和跟风问），
# 缓存一下省钱也省 10 秒延迟。只缓存提问，资料向量本来就在库里
_CACHE_MAX = 512
# 看图模型回「模型不存在」之后，多久之内不再去打它（秒）。
# 2026-10-10 日志：qwen3.7-plus 在对话那组 key 下 404，每张截图都白等一轮请求才「当没图」。
# 模型不存在不是网络抖动，下一秒也还是不存在；10 分钟后再试一次，免得改好配置还要重启
_DEAD_MODEL_TTL = 600.0
# 429 重试前最多等几秒。中转站限的是「每分钟请求数」，固定等 1 秒基本还会撞上
# （2026-09-30 夜间复盘 90 次 429，重试几乎全失败）。上限压在 3 秒：客户那一路有
# answer_timeout=60 的总时限，等太久不如早点转人工。夜间考试的节奏另在 exam.py 里控
_RETRY_AFTER_MAX = 3.0


def _parse_retry_after(raw: str) -> float | None:
    """Retry-After 头 → 秒数。两种写法都合法（RFC 9110）：秒数，或 HTTP-date。看不懂就 None"""
    raw = raw.strip()
    if not raw:
        return None
    try:
        return max(float(raw), 0.0)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max((when - datetime.now(timezone.utc)).total_seconds(), 0.0)


def _retry_wait(resp: httpx.Response) -> float:
    """429/5xx 重试前等多久。上游给了 Retry-After（秒）就听它的，封顶 _RETRY_AFTER_MAX；
    没给的话 429 等 2~3 秒（带抖动，免得并发的几路同时再撞一次），5xx 照旧 1 秒"""
    sec = _parse_retry_after(resp.headers.get("retry-after", ""))
    if sec is not None:
        return min(sec, _RETRY_AFTER_MAX)
    if resp.status_code == 429:
        return 2.0 + random.random()
    return 1.0


def _cached_tokens(usage: dict[str, Any]) -> Any:
    """这次 prompt 里命中缓存的 token 数。OpenAI 兼容写在 prompt_tokens_details.cached_tokens，
    claude 原生字段是 cache_read_input_tokens，中转站两种都可能透传。都没有就是 None（=没报，不等于 0）"""
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict) and details.get("cached_tokens") is not None:
        return details["cached_tokens"]
    return usage.get("cache_read_input_tokens")


def _model_missing(err: str) -> bool:
    """中转站回的是不是「这个模型在当前分组不存在」。两种写法都见过：
    {"error":{"code":"model_not_found",...}} 和 {"error":{"message":"Model \"x\" is not ..."}}"""
    return err.startswith("HTTP 404") and (
        "model_not_found" in err or "not supported by any configured" in err or "当前分组不可用" in err
    )


class LLMError(RuntimeError):
    """中转站没给出可用结果。调用方要能把它翻译成一句人话发给客户。"""


class ModelMissing(LLMError):
    """中转站说这个模型在当前分组不存在（404 model_not_found），或者刚说过、还在负缓存里。

    单独分一类是给看图那条路**换备用模型**用的（qa.py 的 screens_of）：模型不存在下一秒也还是不存在，
    换一个才有用；超时、5xx 是临时的，换模型只是多等一轮。调用方不认这一类的，照旧当 LLMError 处理。
    """


class EmptyContent(LLMError):
    """请求成功，但回包里只有思考过程没有正文。

    单独分一类是因为它**不代表配置有问题**：key、模型名、地址全对，
    重发一次通常就好了。启动自检碰上它不该报错退出（见 probe）。
    """


def trim_to_sentence(content: str) -> str:
    """把被 max_tokens 截断的回复砍回**最后一个完整句子**。

    2026-09-24 加的。之前 finish_reason=length 只写一条 WARNING，残句照发给客户
    ——真机上出过「1. 去 https://api.lmuai.ai 登一下，2」然后就没了，客户看着
    第 2 步凭空消失。半句话比少半句话更糟：客户不知道后面还有，也不知道断在哪。

    只砍不补，一个字都不改写。砍不动就原样返回（宁可发残句，也不能发空白）：

    - 整段一个句末标点都没有 —— 比如模型在写编号列表、或者末尾是个链接；
    - 标点出现在开头附近（砍完只剩几个字）—— 那不如把残句整段给客户，
      至少信息量还在。阈值按「一句中文短句」估，不必精确。
    """
    body = content.rstrip()
    ends = list(_SENT_END.finditer(body))
    if not ends:
        return content
    cut = ends[-1].end()
    if cut < 12 or cut == len(body):
        return content
    return body[:cut]


class LLM:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        chat_model: str,
        embed_model: str,
        thinking: bool = False,
        embed_base_url: str = "",
        embed_api_key: str = "",
    ) -> None:
        self._base = base_url.rstrip("/")
        self._chat_model = chat_model
        self._embed_model = embed_model
        # 让模型进思考模式（`LLM_THINKING`）。**默认关，开之前先验一轮。**
        # 理由就在这个文件顶部那段：2026-09-22 那个「回复开头被啃掉」的触发条件
        # 是「这个中转站 × 推理模式」，12 次里只有带 reasoning_content 的那 1 次丢字。
        # KNOWN_CLEAN 里的模型是按**非推理**配置验的，打开这个开关就不再是验过的配置。
        self._thinking = thinking
        self._client = httpx.AsyncClient(
            base_url=self._base,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=httpx.Timeout(TIMEOUT, connect=10.0),
        )
        # 对话和 embedding 可以走不同的 key / base_url（LLM_CHAT_* 和 LLM_* 分开配时用）
        _embed_url = (embed_base_url or base_url).rstrip("/")
        _embed_key = embed_api_key or api_key
        self._embed_client = (
            self._client
            if (_embed_url == self._base and _embed_key == api_key)
            else httpx.AsyncClient(
                base_url=_embed_url,
                headers={"Authorization": f"Bearer {_embed_key}", "Content-Type": "application/json"},
                timeout=httpx.Timeout(TIMEOUT, connect=10.0),
            )
        )
        self._cache: OrderedDict[str, list[float]] = OrderedDict()
        # 回过「模型不存在」的模型 → 那一刻的 monotonic 时间。见 _DEAD_MODEL_TTL
        self._dead_models: dict[tuple[str, str], float] = {}
        # 那条推理模式提醒只记一次，不然每问一句刷一行
        self._warned_reasoning = False

    async def close(self) -> None:
        await self._client.aclose()
        if self._embed_client is not self._client:
            await self._embed_client.aclose()

    async def _post(self, path: str, payload: dict[str, Any], *, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
        """发一次请求，网络类错误重试一次。

        只重试连接/超时这类**明确没拿到业务结果**的错误。4xx 不重试——
        key 不对、模型名写错、余额没了，重试一百次都是同样的结果，
        只会让客户多等一轮超时。
        """
        c = client or self._client
        last: Exception | None = None
        for attempt in (1, 2):
            try:
                resp = await c.post(path, json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last = e
                log.warning("%s 第 %d 次请求失败：%s", path, attempt, e)
                if attempt == 1:
                    await asyncio.sleep(1.0)
                continue
            if resp.status_code >= 400:
                body = resp.text[:300]
                # 429/5xx 是「现在不行，等会儿可能行」，值得重试一次
                if resp.status_code in (429, 500, 502, 503, 504) and attempt == 1:
                    wait = _retry_wait(resp)
                    log.warning("%s 返回 %d，%.1f 秒后重试：%.200s", path, resp.status_code, wait, body)
                    await asyncio.sleep(wait)
                    last = LLMError(f"HTTP {resp.status_code}: {body}")
                    continue
                raise LLMError(f"HTTP {resp.status_code}: {body}")
            try:
                return resp.json()
            except ValueError as e:
                raise LLMError(_not_json(self._base, path, resp)) from e
        raise LLMError(f"{path} 两次都没成功：{last}")

    # ---- 对话 ----

    async def chat(self, messages: list[dict[str, str]], *, temperature: float = 0.2, max_tokens: int = MAX_TOKENS) -> str:
        """要一段回答。temperature 默认压到 0.2——客服场景要的是稳定复现，
        同一个问题今天明天答得不一样会让你没法验收。"""
        payload: dict[str, Any] = {
            "model": self._chat_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            # **不要改成 True。** 边收边发意味着第一段已经发进客户群了，模型后面
            # 才吐出 NO_ANSWER —— 那等于绕过「答不上来只能转人工」整条防线，
            # 而这个机器人没有撤回（撤回属于管理员撤掉的阶段 2）。
            # 「一段一段发」是在拿到完整回复、检查全过之后再切段发的，
            # 见 bot/handlers/qa.py 的 split_reply
            "stream": False,
        }
        if self._thinking:
            # glm-5 系的思考开关。**思考内容只进日志，绝不拼进发给客户的文本** ——
            # 一段 <think> 漏进客户群比不思考更像机器
            payload["thinking"] = {"type": "enabled"}
        for attempt in (1, 2):
            data = await self._post("/chat/completions", payload)
            try:
                choice = data["choices"][0]
                msg = choice["message"]
            except (KeyError, IndexError, TypeError) as e:
                raise LLMError(f"回包里没有 choices[0].message：{str(data)[:200]}") from e

            usage = data.get("usage") or {}
            self._warn_if_unverified_reasoner(msg)
            # 一定要用 .get：只有思考过程时回包里**根本没有 content 这个键**，
            # 下标取会直接 KeyError
            content = (msg.get("content") or "").strip()
            finish = choice.get("finish_reason")
            # cached = 这次 prompt 命中缓存的 token。中转站没报就不打这一项（没报 ≠ 0）
            cached = _cached_tokens(usage)
            log.info(
                "chat %s | prompt=%s%s completion=%s total=%s finish=%s",
                self._chat_model, usage.get("prompt_tokens"),
                "" if cached is None else f" cached={cached}",
                usage.get("completion_tokens"), usage.get("total_tokens"), finish,
            )
            if content:
                if finish == "length":
                    log.warning("回答被 max_tokens=%d 截断了，末尾可能不完整：%.60s", max_tokens, content)
                    trimmed = trim_to_sentence(content)
                    if trimmed != content:
                        log.info("截断的尾巴砍掉了 %d 个字，只发完整句子", len(content) - len(trimmed))
                    return trimmed
                return content

            if finish == "length" and attempt == 1:
                # 正文是空的、而且是被额度截断：额度全花在思考上了，加大重发一次。
                # **这道兜底是给「调用方额度填小了」兜的**，不是正常路径 —— 正常该在调用处
                # 就给够（判断题用 JUDGE_TOKENS）。没有它的话，失败是静默的：
                # 2026-09-30 /口径 上线当天就这么坏了，判断 10 次失败 8 次，全按「无关」放过去
                bigger = max_tokens * _RETRY_FACTOR
                log.warning(
                    "正文是空的、还被 max_tokens=%d 截断了（额度全花在思考上，用了 %s token），"
                    "加大到 %d 重发一次。调用方该把额度给够",
                    max_tokens, usage.get("completion_tokens"), bigger,
                )
                payload["max_tokens"] = max_tokens = bigger
                continue

            if msg.get("reasoning_content"):
                # 偶发，和额度无关：实测 max_tokens=1500、只用了 37 个 token、
                # finish_reason=stop，模型却把答案留在思考里没吐正文。重发一次基本就好
                if attempt == 1:
                    log.warning("这次只回了思考过程没有正文（用了 %s token），重发一次", usage.get("completion_tokens"))
                    continue
                raise EmptyContent(f"连着两次只回思考过程没有正文（max_tokens={max_tokens}）")
            raise LLMError(f"模型回了空内容（finish_reason={finish}）")
        raise EmptyContent("模型没给出正文")  # 走不到，给类型检查器看的

    def _warn_if_unverified_reasoner(self, msg: dict[str, Any]) -> None:
        """换了个没验过的模型、而它会进推理模式时，提醒一次去实测。

        **为什么值得专门记这一条**：wiring.py 的黑名单拉的是**模型名**，而
        2026-09-22 那个啃字 bug 的触发条件是**「这个中转站 × 推理模式」**
        （12 次里只有带 reasoning_content 的那 1 次丢字）。两者不是一回事——
        哪天换成另一个推理模型，同样的接缝、同样的 bug，但名字不在黑名单里，
        保险就**静默失效**，客户照收残答案。

        这里不拦也拦不了：「这句话开头是不是被啃了」本来就没法可靠判定，
        硬做只会误杀好答案。能做的是让换模型这件事**有人看见**。
        """
        if self._warned_reasoning or self._chat_model in KNOWN_CLEAN:
            return
        if not msg.get("reasoning_content"):
            return
        self._warned_reasoning = True
        log.warning(
            "%s 会进推理模式，而推理模式正是 2026-09-22 那个「回复开头被啃掉」的触发条件"
            "（见 bot/kb/llm.py 顶部）。这个模型还没按那套实测跑过，建议先验一轮："
            "同一个问题连打十几次，看有没有哪次开头少字。已验过的是 %s",
            self._chat_model, "、".join(sorted(KNOWN_CLEAN)),
        )

    # ---- 向量 ----

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """批量算向量，顺序和入参一致。返回的都是单位向量。

        一次请求带多条：导入资料时几百个切块逐条发会等到天亮。
        批量大小见 EMBED_BATCH，那个上限是实测撞出来的，别往上调。
        """
        out: list[list[float] | None] = [None] * len(texts)
        todo: list[tuple[int, str]] = []
        for i, raw in enumerate(texts):
            key = (raw or "").strip()
            if not key:
                raise LLMError("不能给空文本算向量")
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                out[i] = hit
            else:
                todo.append((i, key))

        for start in range(0, len(todo), EMBED_BATCH):
            batch = todo[start : start + EMBED_BATCH]
            data = await self._post(
                "/embeddings", {"model": self._embed_model, "input": [t for _, t in batch]},
                client=self._embed_client,
            )
            items = data.get("data")
            if not isinstance(items, list) or len(items) != len(batch):
                raise LLMError(f"embedding 回包条数不对：要 {len(batch)} 条，回了 {str(data)[:200]}")
            # 中转站不保证按入参顺序返回，按 index 字段对齐；没这个字段才退回下标顺序
            items = sorted(items, key=lambda d: d.get("index", 0)) if all("index" in d for d in items) else items
            for (i, key), item in zip(batch, items):
                vec = _unit(item.get("embedding") or [])
                if not vec:
                    raise LLMError(f"embedding 回包里没有向量：{str(item)[:200]}")
                out[i] = vec
                self._cache[key] = vec
                self._cache.move_to_end(key)
        while len(self._cache) > _CACHE_MAX:
            self._cache.popitem(last=False)

        missing = [i for i, v in enumerate(out) if v is None]
        if missing:
            raise LLMError(f"有 {len(missing)} 条文本没算出向量")
        return [v for v in out if v is not None]

    # ---- 看图 ----

    async def read_image(self, data: bytes, mime: str, *, model: str, prompt: str = "") -> str:
        """把一张图里的内容转成文字。后台「上传图片当资料」用默认提示词；
        客户在群里 @我 发的截图用 SCREENSHOT_PROMPT（bot/handlers/relay.py）。

        对话模型 glm-5.2 不收图（中转站直接 400），所以单独传一个看图模型。
        2026-09-28 实测能看图的：kimi-k2.5 / qwen3.6-plus / qwen3.7-plus / qwen3.8-* / MiniMax-M3 / kimi-k3。

        **走 LLM_* 那组 key（和 embedding 同一个 client），不走对话那组。**
        2026-10-09 拆出 LLM_CHAT_* 之后对话那组 key 只开了 claude，看图模型全在 LLM_* 那组；
        之前这里跟着对话 client 走，每张截图都 404 model_not_found、白等一轮才当没图。
        没单独配 LLM_CHAT_* 时两个 client 是同一个，行为和以前一样。
        """
        # 按 (地址, 模型) 记：换了 key / 地址的同名模型不该被连坐
        dead_key = (str(self._embed_client.base_url), model)
        dead_at = self._dead_models.get(dead_key)
        if dead_at is not None:
            if time.monotonic() - dead_at < _DEAD_MODEL_TTL:
                raise ModelMissing(f"看图模型 {model} 刚报过模型不存在，先不打了")
            del self._dead_models[dead_key]
        url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        payload: dict[str, Any] = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": MAX_TOKENS,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt or _READ_IMAGE_PROMPT},
                        {"type": "image_url", "image_url": {"url": url}},
                    ],
                }
            ],
        }
        try:
            resp = await self._post("/chat/completions", payload, client=self._embed_client)
        except LLMError as e:
            if _model_missing(str(e)):
                self._dead_models[dead_key] = time.monotonic()
                log.warning("看图模型 %s 在当前 key 下不存在，%d 分钟内不再调用。检查 VISION_MODEL 和 LLM_* 的 key", model, int(_DEAD_MODEL_TTL // 60))
                raise ModelMissing(str(e)) from e
            raise
        try:
            content = (resp["choices"][0]["message"].get("content") or "").strip()
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"看图回包里没有 choices[0].message：{str(resp)[:200]}") from e
        if not content:
            raise EmptyContent(f"看图模型 {model} 回了空内容")
        return content

    async def embed_one(self, s: str) -> list[float]:
        return (await self.embed([s]))[0]

    async def probe(self) -> str:
        """启动自检：对话和 embedding 各打一发，确认 key、模型名、维度都对。

        宁可在启动时报错，也别等客户问了第一句才发现模型名写错。
        """
        try:
            got = f"回「{(await self.chat([{'role': 'user', 'content': '回复两个字：正常'}]))[:20]}」"
        except EmptyContent:
            # 这次只回了思考过程。连得通、key 和模型名都对，没必要为此拦住启动
            got = "只回了思考过程，属偶发，不拦启动"
        vec = await self.embed_one("自检")
        return f"对话 {self._chat_model} 通（{got}），embedding {self._embed_model} 通（{len(vec)} 维）"


def _not_json(base: str, path: str, resp: httpx.Response) -> str:
    """回包不是 JSON 时，尽量把原因指到「地址配错了」上。

    实测中转站对错误路径回的是 HTTP 200 + HTML 首页，光说「不是 JSON」
    会让人去怀疑模型、怀疑 key，实际上只是 LLM_BASE_URL 少了 /v1。
    """
    head = resp.text.lstrip()[:200]
    if head.startswith("<") or "text/html" in resp.headers.get("content-type", ""):
        return (
            f"{base}{path} 返回的是网页不是接口数据（HTTP {resp.status_code}）。"
            "多半是 .env 里的 LLM_BASE_URL 写错了——它应该指到 OpenAI 兼容接口的根，"
            f"程序会自动补 /v1。现在实际请求的是 {base}{path}"
        )
    return f"回包不是 JSON：{head}"


def _unit(vec: Sequence[float]) -> list[float]:
    """归一化成单位向量。零向量原样返回（调用方会当成失败）。"""
    vals = [float(x) for x in vec]
    norm = math.sqrt(sum(x * x for x in vals))
    return [x / norm for x in vals] if norm > 1e-12 else vals
