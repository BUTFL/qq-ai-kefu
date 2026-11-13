"""@我 之前先弄清三件事：问的到底是谁、问题里有没有截图、是不是在追问上一句。

2026-09-28 管理员看完当天流水批的三条，都改的是「@我 → 回答」这一段，所以放在一起：

1. **自己人替客户问**。当天他 @我 转述了 16 次，机器人回答 @ 的全是他自己，客户收不到提醒。
   两种转述都认：
   - **引用**客户那条再 @我（14:48「@机器人 您可以看一下」引用了「都是当前地区不可用」）：
     问题取被引用那条（NapCat `get_msg`），他自己打的字当补充，回答 @ 被引用的人。
   - **原样复制**客户的话 @我（15:21 KIAkun 问完，他 @我 贴了同一句）：在这个群最近
     RELAY_WINDOW 分钟里找一条客户说过的、字一样的，回答 @ 那个客户。
   找不到原主就当他自己问，跟以前一样。**只认自己人**（超管 + TRUSTED + 6099「自己人」页）：
   客户引用别人的话 @我，那是他自己在问，回答还 @ 他。
2. **截图**。当天客户发了 15 张图，大多是报错截图，机器人只看文字。现在 @我 的这条
   （或者被引用的那条）里有图、或者同一个人 IMAGE_WINDOW 分钟内刚发过图，就用看图模型
   （`VISION_MODEL`，对话模型 glm-5.2 不收图）把图转成文字拼进问题。**最多 MAX_IMAGES 张**，
   看图失败不影响回答（就当没图）。
3. **追问**。「c-pro 和 c-max 有什么区别」之后问「能用的模型有区别吗」，单看后一句检索不到。
   同一个人在同一个群 FOLLOW_WINDOW 分钟内问过一句，而这句**像追问**（短、以「那/呢/还有」
   这类开头结尾），检索时把上一句拼在前面；给模型的提问也带上上一句。**标准答案还是只拿这一句去比**
   （`Answerer.answer` 的 `context`）：上一句混进来会让「你好」之后那句问什么都像「你是谁」。
4. **反问之后客户答的那一句**（2026-10-16）。机器人问了「你用的哪个客户端？」，客户回
   「cherry studio」——这句既不像追问（13 个字、不带「那/呢」），也没 @我，以前就这么断在群里。
   现在 `asks_back` 认出机器人问出去的话，那一句就当成在答它（`ASK_WINDOW` 分钟）。

这里只放纯函数和一个取图的小工具，状态（上一问记在哪、等谁答）在 qa.py 里。
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from ..kb.webpage import MAX_REDIRECTS, FetchError, check_host, normalize_url

log = logging.getLogger(__name__)

# 原样复制：在这个群最近多少分钟里找原话
RELAY_WINDOW = 30
# 同一个人多少分钟内刚发的图算这次问题的截图
IMAGE_WINDOW = 5
# 同一个人多少分钟内的上一问算上下文
FOLLOW_WINDOW = 5
# **机器人反问之后**，客户多久内接的这一句还算「在答我那个问题」（2026-10-16）。
# 比 FOLLOW_WINDOW 长：追问是自己接着上一句说，答问是回过神再打一行字，慢一点很正常
ASK_WINDOW = 10
# 最近对话的窗口和长度（2026-10-23）。15 分钟够覆盖「贴报错 → 说还是不行」这一来一回；
# 只留 8 行是因为再多模型也开始抓不住重点，而且每行都要吃 token
THREAD_WINDOW = 15
THREAD_MAX_LINES = 8
THREAD_LINE_MAX = 150
# 一次最多看几张图。看一张要 5~10 秒，客户在等
MAX_IMAGES = 2
# 图太大不看（QQ 原图可能好几 MB，看图模型也吃不下）
MAX_IMAGE_BYTES = 8 * 2**20
# 追问：这么短、或者开头结尾像接着上一句说的
FOLLOW_MAX_LEN = 25
_FOLLOW_HEAD = ("那", "那么", "还有", "另外", "然后", "所以", "但是", "可是", "也", "就是说", "这个", "那个", "它", "他")
_FOLLOW_TAIL = ("呢", "呢？", "呢?", "吗", "吗？", "吗?")

SCREENSHOT_PROMPT = (
    "这是客户在 AI 接口服务的客服群里发的截图。只挑跟他遇到的问题有关的东西抄出来："
    "报错原文、错误码、模型名、分组名和倍率、接口地址、提示语。菜单、侧边栏、别的标签页、聊天记录这些不要抄。"
    "最后用一句话说这张图在讲什么问题。总共不超过 150 字，不要开场白，不要给解决办法。"
    "要是图里没有跟接口、模型、报错、充值、分组相关的东西，只输出两个字：无关"
)
# 看图模型回了这个 = 这张图跟问题不沾边，当没图（不然一整页菜单塞进检索，答案被带偏；
# 2026-09-28 实测一张 ChatGPT 首页截图让 glm-5.2 思考了 1500 token 没吐正文，客户等了 102 秒）
IRRELEVANT = "无关"


@dataclass(frozen=True)
class Asker:
    """这次问题算谁问的。`user_id` 是回答要 @ 的人"""

    user_id: int
    nickname: str
    question: str
    relayed_by: int = 0  # 自己人转述的：转述人的 QQ；自己问的 = 0


def reply_id(segments: list[dict]) -> int:
    """这条消息引用了哪条（message_id），没引用 = 0"""
    for seg in segments:
        if seg.get("type") == "reply":
            try:
                return int((seg.get("data") or {}).get("id") or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def image_urls(segments: list[dict]) -> list[str]:
    """消息里的图片下载地址。表情包（sub_type=1）不算：那不是截图"""
    out = []
    for seg in segments:
        d = seg.get("data") or {}
        if seg.get("type") == "image" and d.get("url") and str(d.get("sub_type", 0)) != "1":
            out.append(str(d["url"]))
    return out


def plain(segments: list[dict]) -> str:
    return "".join((s.get("data") or {}).get("text", "") for s in segments if s.get("type") == "text").strip()


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def find_original(question: str, recent: list, *, staff: frozenset[int]) -> tuple[int, str] | None:
    """自己人原样贴了一句客户的话 @我：在最近的群消息里找原主。返回 (QQ, 昵称)，找不到 None。

    `recent` 是 group_msgs 的行，**新的在前**。只认客户说的、没 @我 的，字去掉空白后完全一样
    （太短的不认：「好的」「在吗」谁都说过）。
    """
    q = _norm(question)
    if len(q) < 6:
        return None
    for m in recent:
        if m["role"] != "customer" or m["user_id"] in staff or m["at_me"]:
            continue
        body = _norm(re.sub(r"@\S+\s?", "", m["body"]).replace("[图片]", ""))
        if body == q:
            return int(m["user_id"]), str(m["nickname"])
    return None


def merge_relayed(quoted: str, own: str) -> str:
    """引用转述：被引用的那条是问题主体，自己人打的字当补充。他只打了「您可以看一下」这类就不带"""
    quoted, own = quoted.strip(), own.strip()
    if not quoted:
        return own
    if not own or len(own) <= 8 or own in quoted:
        return quoted
    return f"{quoted}（同事补充：{own}）"


def looks_like_follow_up(question: str) -> bool:
    q = question.strip()
    if len(q) > FOLLOW_MAX_LEN:
        return False
    return q.startswith(_FOLLOW_HEAD) or q.endswith(_FOLLOW_TAIL) or len(q) <= 10


def format_thread(items: list[tuple[str, str, str]]) -> str:
    """把「最近对话」拼成给模型看的几行。每项 =（created_at, 谁, 说了什么）。

    **从早到晚**：模型要顺着读才能看出「先贴报错、再说还是不行」。
    只留最后 THREAD_MAX_LINES 条，太久以前的那几句反而会带偏。
    内容先拍平空白（群消息里换行多，一行一个换行会把 8 行占满），
    超过 THREAD_LINE_MAX 字截断加「…」—— 长报错贴进来不能把整段提示词挤爆。
    """
    if not items:
        return ""
    ordered = sorted(items, key=lambda it: it[0])[-THREAD_MAX_LINES:]
    lines = []
    for created_at, who, what in ordered:
        body = " ".join(what.split())
        if len(body) > THREAD_LINE_MAX:
            body = body[:THREAD_LINE_MAX] + "…"
        hhmm = created_at[11:16] if len(created_at) >= 16 else created_at
        lines.append(f"{hhmm} {who}：{body}")
    return "\n".join(lines)


def clean_logged_answer(text: str) -> str:
    """去掉 qa.py 记进 qa_log 的回答末尾那些「[ 开头、] 结尾」的备注行。

    2026-10-23：这些行是给人和复盘看的，不是机器人说的话 ——
    `[看了截图：…]`、`[拦下：…]`、`[依据：…]`、`[12345 转述的]`。
    拼「最近对话」时必须去掉，不然模型会以为机器人真在群里说过「[依据：#57]」。
    只从**末尾**往前剥：正文中间本来就有方括号（`[图片]`、报错里的 `[ERROR]`）不能动。
    """
    lines = text.rstrip().splitlines()
    while lines:
        last = lines[-1].strip()
        if not (last.startswith("[") and last.endswith("]")):
            break
        lines.pop()
    return "\n".join(lines).rstrip()


def media_note(failed_images: int, has_file: bool) -> str:
    """截图/文件没看成时，给模型的一句实话（2026-10-23）。

    2026-10-10 02:04 真机（qa_log #488）：客户说「截图如上」，看图模型当时一直 404，截图全当没图，
    机器人回「截图我这边没显示出来，你再发一次」，还让他换节点、换热点 —— 那两样他前面都说试过了。
    10-22 #899 客户发的是 .md 文件，机器人读不了，就猜「一般是开着梯子导致的」。
    没看成就是没看成：告诉模型，让它照 _RAG_SYSTEM 第二节第 6 条要文字，不猜图里写了什么。
    """
    parts = []
    if failed_images > 0:
        parts.append(f"客户发了 {failed_images} 张截图，这边没看成，不知道图里是什么")
    if has_file:
        parts.append("客户发了文件，这边读不了文件内容")
    return "；".join(parts)


# 反问里在要什么。**跟 answer.py 提示词第 12 条那条列的一一对齐**（缺了就没法答的那几样）：
# 哪个客户端、什么系统、报错码、截图、具体版本型号。客户照答的时候，答的就是这些东西
_ASK_BACK = (
    "说一下", "讲一下", "发一下", "发我", "截图", "报错", "哪个", "哪一个",
    "是什么", "是多少", "多少", "什么场景", "怎么用的", "用的什么", "什么客户端",
    "客户端", "版本", "型号", "系统", "具体",
)


def asks_back(body: str) -> bool:
    """机器人刚发出去的那句话，是不是在向客户要一句回答（反问）。

    2026-10-16 加的。真机上这个样子：客户问「连不上」，机器人答「这个一般是地址或密钥填错了，
    你先对一下这两个。你用的哪个客户端？」—— 客户回「cherry studio」，**没 @ 我**。
    按当时的规矩，这句只能靠没 @ 我的那条窄路（撞标准答案要 0.85 以上）去接，
    撞不上就一声不吭，话头断在这儿。真人不会这样：自己问出去的话，对方答了就得接着办。

    **两道都满足才算**（宁可漏一次，别把陈述句当反问）：
    1. 最后一行以问号收尾。看的是**最后一行**，不是整条 —— 回答带出处链接时，最后一行是网址
    2. 里面有要东西的说法（`_ASK_BACK`）。只说「有什么可以帮你的？」不算，
       那是在收尾客套，不是等一个具体答案
    """
    lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
    if not lines:
        return False
    last = lines[-1]
    if not last.endswith(("？", "?")):
        return False
    return any(w in last for w in _ASK_BACK)


async def fetch_image(url: str) -> tuple[bytes, str] | None:
    """下载一张群图片。失败返回 None（过期、太大、网络不通、地址不对都一样：当没图）。

    QQ 的图片地址是公网 https（multimedia.nt.qq.com.cn），带 rkey，过一阵会失效。
    `trust_env=False`：宿主机开着系统代理的话 httpx 会走代理，国内的 QQ 图床不需要。

    **只认公网 http/https，每跳重定向都查**（2026-10-08 加的，写法跟 `kb/webpage.download`、
    `kb/crawl.fetch_image` 统一）。原先是 `follow_redirects=True` 且不查地址 ——
    这个地址是 NapCat 从 QQ 服务器拿的、客户改不了，所以当时不是能打的洞；补它的理由是
    **机器人容器连得到内网**：实测 `http://127.0.0.1:6099/` 返回 200，而 6099 是 NapCat 的
    控制台（拿到它等于拿到这个 QQ 号的完全控制权），8090 是知识库接口。只要这个地址哪天
    变成别人能摆布的（QQ 图床被劫、NapCat 换个实现把 url 原样透出来），一次 302 就能让
    机器人把内网页面读出来喂给看图模型，再顺着答案发到群里。
    `file://` 这类协议 httpx 自己就不支持（实测抛 UnsupportedProtocol），但这里仍然显式卡协议 ——
    不把安全性寄托在某个库的默认行为上。
    """
    try:
        url = normalize_url(url)
    except FetchError as e:
        log.warning("群图片地址不收：%s", e)
        return None
    try:
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as c:
            for _ in range(MAX_REDIRECTS + 1):
                await asyncio.to_thread(check_host, urlsplit(url).hostname or "")
                r = await c.get(url)
                if r.is_redirect and r.headers.get("location"):
                    url = normalize_url(urljoin(url, r.headers["location"]))
                    continue
                r.raise_for_status()
                data = r.content
                break
            else:
                log.warning("群图片重定向太多，不看")
                return None
    except FetchError as e:
        log.warning("群图片地址不收：%s", e)
        return None
    except (httpx.HTTPError, OSError) as e:
        log.warning("下载群图片失败：%s", e)
        return None
    if not data or len(data) > MAX_IMAGE_BYTES:
        log.warning("群图片大小不对（%d 字节），不看", len(data))
        return None
    mime = r.headers.get("content-type", "").split(";")[0].strip()
    if not mime.startswith("image/"):
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return data, mime
