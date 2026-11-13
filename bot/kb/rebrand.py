"""抓来的别家文档改成灵眸的说法（2026-09-29 管理员：「抓取的文档需要改成咱们的，
不能有别的平台的名称和地址，关于别的平台的信息都需要替换成我们」）。

三步，模型只干中间那步，前后都是死规则：

1. **认出别家**（`detect`）：整页交给模型，列出里面出现的**同类平台**（卖大模型 API / 中转 / 云推理的）
   叫什么、域名是什么。**工具和模型厂商不算**：Claude Code、Cursor、OpenAI SDK、GPT、DeepSeek 这些是客户用的
   工具和模型名，换掉反而教错。页面本身属于同类平台的话，它的域名也算进去（`site_host`）。
2. **改写**（`rewrite`）：按标题切成几段并发改。名称 → 灵眸；接口地址 → 我们的；注册、控制台、Key、充值、联系方式
   → 我们的（`OURS`）；**别家的价格、额度、限流、免费额度、实名、发票、退款这些政策整段删掉**，不改成我们的 ——
   我们的这些以价格页和标准答案为准，照搬别家的数字等于替我们乱承诺。
3. **核对**（`leftovers` / `scrub` / `text.unsourced_facts`）：还剩别家名称或域名 → 指出来重改一次，
   还有就机械替换兜底；改完多出原文和 `OURS` 里都没有的链接、价钱、数量 → 重改一次，还有就整份不入库。

改完的正文里**不放原网址**（`webpage.py` 只给我们自己的域名写 `URL:` 行）：机器人答题会把资料的网址附在回答末尾，
别家的网址就这么发到客户群里了。原文另存一份（`data/网页原文/`），6099 列表上点「原件」能对照。
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from . import text as textutil
from .llm import LLM, LLMError
from .review import parse_json

log = logging.getLogger(__name__)

# 我们自己的域名：抓这些不改写
# 跟 text.py 共用一份（硬事实闸也要认我们自己的域名）
OUR_DOMAINS = textutil.OUR_DOMAINS
# 改写时照着换的「我们的说法」。**改这里就行**，来源是 knowledge/lmuai-docs.txt（快速开始、接入协议两页）
OURS = """\
- 名称：灵眸（灵眸 AI）
- 接口地址：Anthropic 协议 https://api.lmuai.com（不带 /v1）；OpenAI 兼容 https://api.lmuai.com/v1；Gemini 原生 https://api.lmuai.com（路径 /v1beta/...）
- 官网 / 控制台：大陆站 https://api.lmuai.com ；国外模型（Claude、GPT、Gemini、Grok）在国际站 https://api.lmuai.ai ，账号和余额两边通用
- 注册：https://api.lmuai.com/register?ref=vJaWWr4T
- API Key：sk- 开头。控制台左侧菜单「API 密钥」→「创建密钥」
- 充值 / 订阅：控制台左侧菜单「充值/订阅」
- 价格：https://api.lmuai.com/pricing
- 文档：https://docs.lmuai.com
- 能用哪些模型：由 API Key 所属分组决定，以控制台模型广场为准
- 联系我们：售前 QQ 群 2000000001；售后 QQ 群 2000000002（加群填支付订单号）
"""
# 别家特有、改写后仍不许出现的词（出现就重改 / 机械替换）
_BANNED = ("中转站",)
# 一段最多多少字交给模型。kimi-k2.5 改 1300 字约 25 秒；太长一次输出容易被截
PIECE = 2500
# 同时改几段
PARALLEL = 3
# 整页上限：再长就几十段、几分钟，而且多半是整站索引页
MAX_CHARS = 40_000
# 模型厂商、官方工具。认别家时模型偶尔把它们列进来，一律不换（理由见 _clean）
_NOT_RIVALS = {
    "anthropic", "claude", "claude code", "openai", "chatgpt", "gpt", "codex", "google", "gemini", "deepseek",
    "qwen", "通义", "kimi", "moonshot", "月之暗面", "glm", "智谱", "zhipu", "minimax", "grok", "xai", "meta", "llama",
    "cursor", "cline", "vscode", "vs code", "github", "cherry studio", "trae", "windows", "mac", "macos", "linux",
}
# 域名第一段是这些的不当品牌名（docs.xxx.com 里的 docs）
_GENERIC = {"www", "docs", "doc", "api", "cloud", "console", "platform", "help", "developer", "developers", "open", "app", "m"}

_DETECT_SYSTEM = """你在帮「灵眸」（卖大模型 API 的平台）整理抓来的网页资料。灵眸自己的域名是 lmuai.com、lmuai.ai。
找出这份网页里出现的**和灵眸同类的平台**：卖大模型 API、API 中转 / 聚合、云端模型推理、算力平台的公司或网站（不含灵眸）。

**这些不算**（它们是客户用的工具、SDK、模型或模型厂商，不要列）：
Claude Code、Cursor、Cline、Codex、VS Code、Cherry Studio、Trae、OpenAI SDK、anthropic SDK、GitHub、npm、pip、Node.js、Python，
以及模型名和模型厂商名（Claude、GPT、Gemini、DeepSeek、Qwen、Kimi、GLM、Llama……）作为「模型」出现的时候。
但如果文中是在说某家厂商**自己的 API 平台**（比如「在 DeepSeek 开放平台充值」「platform.openai.com 创建 key」），那个平台名和域名要列。

只输出 JSON：{"site_is_platform": 这个网站本身是不是同类平台（true/false）,
"names": [同类平台的名称，中英文、简称都列，比如 "SiliconFlow", "硅基流动"],
"domains": [它们的域名，比如 "siliconflow.cn"]}"""

_REWRITE_SYSTEM = """你在把别家平台的文档改写成「灵眸」的资料。灵眸的信息：
{ours}
要替换掉的别家平台：{names}
它们的域名：{domains}

规则：
1. 别家平台的名称一律换成「灵眸」，别家的网址换成灵眸对应的网址（API 地址换成灵眸的接口地址，
   注册 / 控制台 / 充值 / 创建 Key 换成灵眸的地址和菜单名）。联系方式（客服、群、邮箱、电话）换成灵眸的 QQ 群。
2. **别家的价格、计费、额度、免费额度、限流（RPM/TPM/并发）、实名认证、发票、退款、账户政策，整句整段删掉**，不要改成灵眸的，
   也不要编灵眸的数字。只在原来的位置留一句「以灵眸控制台 / 价格页为准」即可。
   别家的规模和宣传（「数百个模型」「百万开发者」「自动选最便宜的」「99.9% 可用」）也删掉，换成灵眸就成了我们的承诺。
3. 别家特有的模型 ID（带平台前缀或路径的，比如 Pro/xxx/yyy、@cf/xxx、~openai/xxx）换成 `模型名`，旁边说明「可用模型看灵眸控制台的模型广场」。
   通用的模型名（claude-sonnet-5、gpt-5 这类）不动。
   **完整端点只换主机、路径照原样补全**：别家的 `https://api.别家.com/api/v1/chat/completions` → `https://api.lmuai.com/v1/chat/completions`，
   不要只写到 `/v1` 就截断；`/v1/messages` 同理。
4. **别家特有、上面灵眸信息里没有的功能和页面，整段删掉，不要说成灵眸有**：在线体验 / playground / 体验中心、
   在线调试、Request Builder、排行榜、模型微调、批量推理、实名认证、代金券、邀请返利、文档站里「在线调用」这类；
   **别家自己出的 SDK / npm 包 / pip 包 / GitHub 仓库**（包名或仓库里带别家名字的，比如 @别家/sdk、别家-python、github.com/别家Team/…）
   连安装命令和示例代码一起删。客户会照着去找、去装，找不到就是我们骗人。
   只留通用的做法（拿 Key、填地址、用 OpenAI / Anthropic 官方 SDK 或 curl 调用）。
5. 页面末尾的「上一页 / 下一页」、相关文章推荐、面包屑、目录这类导航文字删掉。
6. 工具、SDK、模型厂商作为模型名（Claude Code、Cursor、OpenAI SDK、GPT、DeepSeek 等）不是平台，**不要替换**。
   第三方工具的下载地址（nodejs.org、github.com 等）保留。
7. 其余内容、步骤、代码、Markdown 格式（## 标题、- 列表、```代码块```、| 表格 |）原样保留，语言跟原文一样，不要总结、不要加解释。
   **不要写「中转站」这个词**，不要编原文和上面灵眸信息里都没有的网址和数字。
8. 只输出改写后的正文，不要任何前言后语。整段都是别家价格政策、别家特有功能或导航，删完什么都不剩的，输出 EMPTY。"""

_RETRY = "\n\n上一版还有问题：{why}。照规则再改一次，只输出正文。"


@dataclass
class Brands:
    names: list[str] = field(default_factory=list)
    domains: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.names or self.domains)


@dataclass
class Rebranded:
    text: str
    replaced: list[str]  # 换掉了谁（给页面上看）


class RebrandError(ValueError):
    """给人看的错误，页面上原样显示。"""


def is_ours(host: str) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in OUR_DOMAINS)


def site_host(host: str) -> tuple[str, str]:
    """(去掉常见前缀的域名, 品牌词)。docs.siliconflow.cn → ("siliconflow.cn", "siliconflow")"""
    parts = (host or "").lower().rstrip(".").split(".")
    while len(parts) > 2 and parts[0] in _GENERIC:
        parts = parts[1:]
    domain = ".".join(parts)
    # 二级后缀（.com.cn / .co.uk）：品牌在倒数第三段
    label = parts[-3] if len(parts) >= 3 and parts[-2] in {"com", "co", "net", "org", "gov", "edu"} else parts[0] if parts else ""
    return domain, label if len(label) >= 4 and label not in _GENERIC else ""


def _clean(xs: object) -> list[str]:
    out: list[str] = []
    for x in xs if isinstance(xs, list) else []:
        s = str(x).strip().strip("/")
        # 灵眸自己、太短的（「AI」这种一换全篇都是灵眸）不收
        if len(s) < 2 or "灵眸" in s or "lmuai" in s.lower() or s in out:
            continue
        # 全是通用词拼的（api-docs、docs、open api）不是品牌：实测模型把 api-docs 当成了平台名，
        # 那样正文里每个 api-docs 路径都会被换成「灵眸」
        if all(t in _GENERIC | {"ai", "api", "docs", "maas", "sdk"} for t in re.split(r"[-_.\s]+", s.lower()) if t):
            continue
        # 模型厂商、工具不是同类平台（09-29 爬 TIMI CC 时模型把 Anthropic 列进来了）：
        # 换掉的话「Anthropic 协议」「ANTHROPIC_BASE_URL」全成了「灵眸 协议」，客户照着配就错了
        if s.lower() in _NOT_RIVALS:
            continue
        out.append(s)
    return out


async def detect(llm: LLM, body: str, *, host: str, title: str) -> Brands:
    raw = await llm.chat(
        [{"role": "system", "content": _DETECT_SYSTEM},
         {"role": "user", "content": f"网址：{host}\n标题：{title}\n\n{body[:MAX_CHARS]}"}],
        temperature=0.0, max_tokens=800,
    )
    data = parse_json(raw)
    if data is None:
        raise RebrandError("认别家平台时模型没回 JSON，再抓一次试试")
    b = Brands(names=_clean(data.get("names")), domains=[d.lower() for d in _clean(data.get("domains"))])
    if data.get("site_is_platform"):
        domain, label = site_host(host)
        if domain and domain not in b.domains:
            b.domains.append(domain)
        if label and label.lower() not in {n.lower() for n in b.names}:
            b.names.append(label)
    # 域名的品牌词也当名称查：siliconflow.cn → siliconflow（正文里常写成 SiliconFlow）
    for d in list(b.domains):
        _, label = site_host(d)
        if label and label.lower() not in {n.lower() for n in b.names}:
            b.names.append(label)
    b.domains = [d for d in b.domains if not is_ours(d)]
    return b


def split(body: str, limit: int = PIECE) -> list[str]:
    """按标题（不行就按空行）切成不超过 limit 的几段。**不切在代码块中间**"""
    pieces: list[str] = []
    cur: list[str] = []
    size = 0
    fence = False
    for line in body.splitlines():
        if line.strip().startswith("```"):
            fence = not fence
        breakable = not fence and (line.startswith("#") or not line.strip())
        if breakable and size >= limit or (breakable and line.startswith("#") and size >= limit // 2):
            pieces.append("\n".join(cur).strip())
            cur, size = [], 0
        cur.append(line)
        size += len(line) + 1
    if cur:
        pieces.append("\n".join(cur).strip())
    return [p for p in pieces if p]


def _needle(s: str) -> re.Pattern[str]:
    """英文名只卡**左边**词边界（「Flow」不该命中「workflow」），右边不卡：OpenRouterTeam、siliconflow-python、
    OpenRouter's 都得算。中文直接找"""
    esc = re.escape(s)
    return re.compile(rf"(?<![A-Za-z0-9]){esc}" if s.isascii() else esc, re.I)


def leftovers(text: str, brands: Brands) -> list[str]:
    """改写后还剩的别家名称、域名，和不许出现的词"""
    out = [n for n in brands.names if _needle(n).search(text)]
    out += [d for d in brands.domains if d.lower() in text.lower()]
    out += [w for w in _BANNED if w in text]
    return out


def _our_url(u: str) -> str:
    """别家的网址换成我们的：`/v1/…` `/api/v1/…` 这种 API 路径换到我们的 /v1/…（OpenAI / Anthropic 兼容的路径我们都认），
    别的（官网、控制台、文档页）一律换成我们的首页 —— 猜不出对应哪一页，给个错的深链接不如给首页"""
    m = re.search(r"/(v1(?:beta)?(?:/[^?#]*)?)$", urlsplit(u).path)
    return f"https://api.lmuai.com/{m.group(1)}" if m else "https://api.lmuai.com"


def scrub(text: str, brands: Brands) -> str:
    """机械兜底：别家的网址 → 我们的，名称 → 灵眸，「中转站」→「平台」。模型两次都没改干净才用"""
    def url(m: re.Match[str]) -> str:
        u = m.group(0)
        host = (urlsplit(u).hostname or "").lower()
        return _our_url(u) if any(host == d or host.endswith("." + d) for d in brands.domains) else u

    text = re.sub(r"https?://[^\s)\]>'\"`，。]+", url, text)
    for d in sorted(brands.domains, key=len, reverse=True):
        text = re.sub(rf"(?<![A-Za-z0-9.-])(?:[a-z0-9-]+\.)*{re.escape(d)}", "api.lmuai.com", text, flags=re.I)
    # 别家的包和仓库（@openrouter/sdk、github.com/OpenRouterTeam/…）：换成「@灵眸/sdk」也是装不上的东西，
    # 整行删。只认这两种写法，别的行里提到名字的走下面的替换
    for n in (n for n in brands.names if n.isascii()):
        text = re.sub(rf"^[^\n]*(?:@{re.escape(n)}[A-Za-z0-9_-]*/|github\.com/{re.escape(n)})[^\n]*\n?", "", text, flags=re.I | re.M)
    for n in sorted(brands.names, key=len, reverse=True):
        # 右边粘着的后缀一起换（OpenRouterTeam → 灵眸，而不是「灵眸Team」）
        text = re.compile(rf"(?<![A-Za-z0-9]){re.escape(n)}[A-Za-z0-9_-]*" if n.isascii() else re.escape(n), re.I).sub("灵眸", text)
    for w in _BANNED:
        text = text.replace(w, "平台")
    return text


def _invented(out: str, piece: str) -> set[str]:
    """改写版多出来的、原文和 OURS 里都没有的链接、价钱、数量（`text.unsourced_facts`）。
    **我们自己域名下的链接不算**：别家的 /api/v1/chat/completions 换成我们的 /v1/chat/completions 本来就是要的，
    OURS 不可能把每个端点都列一遍"""
    return {f for f in textutil.unsourced_facts(out, piece + "\n" + OURS) if not is_ours(urlsplit(f).hostname or "")}


async def _one(llm: LLM, piece: str, brands: Brands, sem: asyncio.Semaphore) -> str:
    system = _REWRITE_SYSTEM.format(ours=OURS, names="、".join(brands.names) or "无", domains="、".join(brands.domains) or "无")
    why = ""
    out = ""
    for attempt in (1, 2):
        async with sem:
            out = (await llm.chat(
                [{"role": "system", "content": system + (_RETRY.format(why=why) if why else "")},
                 {"role": "user", "content": piece}],
                temperature=0.1, max_tokens=max(2000, len(piece) * 2),
            )).strip()
        if out.startswith("```") and out.endswith("```") and not piece.startswith("```"):
            out = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", out).strip()  # 整段被包进了代码块
        if out == "EMPTY":
            return ""
        left = leftovers(out, brands)
        bad = _invented(out, piece)
        if not left and not bad:
            return out
        why = "；".join(x for x in (
            f"还有别家的 {'、'.join(left)}" if left else "",
            f"多了原文和灵眸信息里都没有的 {'、'.join(sorted(bad))}，删掉" if bad else "",
        ) if x)
        log.info("改写第 %d 次没过：%s", attempt, why)
    out = scrub(out, brands)
    bad = _invented(out, piece)
    if bad:
        raise RebrandError(f"改写时模型两次都加了原文里没有的 {'、'.join(sorted(bad))}，没入库。再抓一次试试")
    return out


async def rebrand(llm: LLM, body: str, *, host: str, title: str) -> tuple[str, Rebranded]:
    """(改过的标题, 改过的正文 + 换掉了谁)。没认出别家就原样返回"""
    if len(body) > MAX_CHARS:
        raise RebrandError(f"页面有 {len(body)} 字，太长了（上限 {MAX_CHARS}）。多半是整站目录页，换成具体那一页的网址")
    try:
        brands = await detect(llm, body, host=host, title=title)
        if not brands:
            return title, Rebranded(text=body, replaced=[])
        sem = asyncio.Semaphore(PARALLEL)
        done = await asyncio.gather(*(_one(llm, p, brands, sem) for p in split(body)))
    except LLMError as e:
        raise RebrandError(f"改成灵眸说法时调模型失败（{e}），没入库") from None
    text = "\n\n".join(x for x in done if x).strip()
    # 标题短，机械换就够了（「SiliconFlow 快速上手」→「灵眸 快速上手」），不值得再调一次模型
    return scrub(title, brands), Rebranded(text=text, replaced=brands.names or brands.domains)
