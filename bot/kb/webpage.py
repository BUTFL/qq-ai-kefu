"""6099「资料库」页输一个网址，把**那一页**抓成资料入库（2026-09-29 管理员要的）。

只抓这一页，不顺着链接爬整站：整站一爬就是几百页、几百次 embedding，而且大半是导航和无关页。
要几页就输几个网址（页面上一行一个）。

放哪儿：`knowledge/网页/<标题>-<网址指纹>.md`，旁边一个同名 `.meta.json` 记网址和抓取时间。
- 放 knowledge/ 底下：每天 07:23 的 ingest 会清掉「文件不在 knowledge/ 里」的资料（理由同 uploads.py）
- 文件名带网址指纹：同一个网址再抓一次是**覆盖同一份**（内容没变 ingest 按 sha1 跳过），不会越抓越多
- **别家平台的文档改成灵眸的说法**（`rebrand.py`，同一天他又要的「不能有别的平台的名称和地址」）：
  名称、地址、注册控制台换成我们的，别家的价格政策删掉。改写前的原文存 `data/网页原文/`，6099 点「原件」对照
- 只有**我们自己的站**正文第二行写 `URL: 网址`：切块时每一块都带着出处（`text.split_doc` 认这一行），
  机器人答题会把它附在回答末尾。别家的站不写 —— 附上去就是把别家网址发进客户群

**只认公网地址**（`check_host`，每一跳重定向都查）。机器人容器里连得到 napcat:6099、宿主机和局域网，
不拦的话输一个 http://napcat:6099/... 就把内部页面抓进资料、再被机器人念给客户听。

**要浏览器跑 JS 才出内容的页面抓不到正文**（只拿到一个空壳）。字数太少就报错，不入库。
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import socket
from dataclasses import dataclass, field
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from . import ingest, rebrand, uploads
from .ingest import KNOWLEDGE, ingest_file
from .llm import LLM
from .store import KBStore

log = logging.getLogger(__name__)

WEB_DIR = KNOWLEDGE / "网页"
RAW_DIR = ingest.ROOT / "data" / "网页原文"
MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT = 20.0
# 正文少于这么多字当没抓到（JS 渲染的空壳、登录页、被挡）
MIN_CHARS = 100
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


class FetchError(ValueError):
    """给人看的错误，页面上原样显示。"""


@dataclass
class FetchResult:
    doc_path: str
    title: str
    url: str
    state: str  # 新增 / 更新 / 跳过
    chunks: int
    chars: int
    replaced: list[str] = field(default_factory=list)  # 改写时换掉的别家平台


# ---- 只认公网 ----

# 「javascript:」「data:」「file:/etc/passwd」这种：开头是协议名 + 冒号，冒号后面不是端口号
_SCHEME_ONLY = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)")


def normalize_url(raw: str) -> str:
    url = raw.strip()
    if url and "://" not in url:
        # 没写协议的才补 https://。**但「javascript:alert(1)」「data:text/html,…」「file:/etc/passwd」
        # 这种本身就带着协议**，补上就成了 https://javascript:alert(1)，主机名变成 javascript ——
        # 以前靠后面 check_host 查不到这个域名凑巧挡住（10-09 安全用例抓到的）。
        # 在入口就拒，不靠 DNS 兜底。localhost:6099 这种冒号后面是端口的照常补（再交给 check_host 拦）
        if _SCHEME_ONLY.match(url):
            raise FetchError(f"不是网址：{url[:80]}")
        url = "https://" + url  # 只贴了 docs.xxx.com/page 也认
    u = urlsplit(url)
    if u.scheme not in {"http", "https"} or not u.hostname:
        raise FetchError(f"不是网址：{raw.strip()[:80]}")
    return url


def check_host(host: str) -> None:
    """解析出来的每个地址都得是公网的，不然拒绝。同步函数（要查 DNS），调用方放线程里跑"""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise FetchError(f"找不到 {host} 这个网站（域名解析失败）") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise FetchError(f"{host} 是内网 / 本机地址，不抓")


def _charset(resp: httpx.Response, body: bytes) -> str:
    ct = resp.headers.get("content-type", "")
    m = re.search(r"charset=([\w-]+)", ct, re.I) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', body[:4096], re.I)
    if m:
        cs = m.group(1)
        return cs.decode() if isinstance(cs, bytes) else cs
    return "utf-8"


def _decode(body: bytes, charset: str) -> str:
    try:
        return body.decode(charset)
    except (LookupError, UnicodeDecodeError):
        pass
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("gb18030", errors="replace")


async def download(url: str) -> tuple[str, str, bytes, str]:
    """GET 这个网址。返回 (最终网址, content-type, 内容, 字符集)。重定向自己跟，每一跳都查是不是公网"""
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}) as c:
        for _ in range(MAX_REDIRECTS + 1):
            await asyncio.to_thread(check_host, urlsplit(url).hostname or "")
            try:
                async with c.stream("GET", url) as r:
                    if r.is_redirect and r.headers.get("location"):
                        url = normalize_url(urljoin(url, r.headers["location"]))
                        continue
                    if r.status_code >= 400:
                        raise FetchError(f"网站回了 HTTP {r.status_code}" + ("（要登录才能看的页面抓不了）" if r.status_code in (401, 403) else ""))
                    buf = bytearray()
                    async for part in r.aiter_bytes():
                        buf += part
                        if len(buf) > MAX_BYTES:
                            raise FetchError(f"页面超过 {MAX_BYTES // 1024 // 1024}MB，不抓")
                    return str(r.url), r.headers.get("content-type", "").split(";")[0].strip().lower(), bytes(buf), _charset(r, bytes(buf))
            except httpx.TimeoutException:
                raise FetchError(f"{TIMEOUT:.0f} 秒没抓下来（网站太慢，或者要翻墙）") from None
            except httpx.HTTPError as e:
                raise FetchError(f"连不上：{type(e).__name__}") from None
        raise FetchError(f"重定向超过 {MAX_REDIRECTS} 次")


# ---- HTML → Markdown ----

_SKIP = {"script", "style", "noscript", "svg", "template", "iframe", "head", "form", "button", "select", "canvas"}
# 导航、侧栏在哪都跳过（文档站的目录侧栏常常就放在 <main> 里面）；
# 页头页脚只在正文外面跳过 —— 正文（main / article）里的 header 常常就是文章标题
_NAV = {"nav", "aside"}
_CHROME = {"footer", "header"}
_MAIN = {"main", "article"}
_BLOCK = {
    "p", "div", "section", "ul", "ol", "table", "blockquote", "dl", "dd", "dt", "figure", "figcaption",
    "main", "article", "header", "details", "summary", "hr",
}
_VOID = {"br", "hr", "img", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "param", "track"}
_ZW = re.compile("[​‌‍⁠﻿]")


class _Extract(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.all: list[str] = []
        self.main: list[str] = []
        self.article: list[str] = []
        self.title = ""
        self._in_title = False
        self._skip = 0
        self._main = 0
        self._article = 0
        self._pre = 0
        self._head: list[str] | None = None
        self._level = 0
        self._stack: list[str] = []
        # 爬常见问题用（kb/crawl.py）：页面里的链接（导航、侧栏的也要，顺着爬靠它）和正文里的图
        self.links: list[str] = []
        self.images: list[tuple[str, str]] = []  # (src, alt)

    def _emit(self, s: str) -> None:
        if self._head is not None:
            self._head.append(s)
            return
        self.all.append(s)
        if self._main:
            self.main.append(s)
        if self._article:
            self.article.append(s)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.links.append(a["href"] or "")
        if tag == "img" and not self._skip:
            src = a.get("src") or a.get("data-src") or ""
            if src and not src.startswith("data:"):
                self.images.append((src, (a.get("alt") or "").strip()))
                # 正文里留个记号：问答抽出来之后，靠它知道哪张图属于哪一条
                self._emit(f" [图{len(self.images)}] ")
        if tag in _VOID:
            if tag == "br" and not self._skip:
                self._emit("\n")
            return
        self._stack.append(tag)
        if self._skip or tag in _SKIP or tag in _NAV or (tag in _CHROME and not self._main):
            self._skip += 1
            return
        if tag in _MAIN:
            self._main += 1
        if tag == "article":
            self._article += 1
        if tag == "pre":
            self._pre += 1
            self._emit("\n\n```\n")
        elif m := re.fullmatch(r"h([1-6])", tag):
            self._head, self._level = [], int(m.group(1))
        elif tag == "li":
            self._emit("\n- ")
        elif tag == "tr":
            self._emit("\n")
        elif tag in {"td", "th"}:
            self._emit(" | ")
        elif tag in _BLOCK:
            self._emit("\n\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in _VOID or tag not in self._stack:
            return
        # 标签没配对（HTML 里很常见）：一路弹到对应的开标签，中间没关的一起算关了
        while self._stack:
            t = self._stack.pop()
            self._close(t)
            if t == tag:
                break

    def _close(self, tag: str) -> None:
        if self._skip:
            self._skip -= 1
            return
        if tag in _MAIN:
            self._main -= 1
        if tag == "article":
            self._article -= 1
        if tag == "pre":
            self._pre -= 1
            self._emit("\n```\n\n")
        elif re.fullmatch(r"h[1-6]", tag) and self._head is not None:
            text = " ".join("".join(self._head).split())
            self._head = None
            if text:
                # 正文里的 h1 降一级：`# ` 在 split_doc 里是「新的一页」，会把 URL 行清掉
                self._emit(f"\n\n{'#' * min(self._level + 1, 6)} {text}\n\n")
        elif tag in _BLOCK:
            self._emit("\n\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if self._skip:
            return
        # 零宽字符（文档站标题锚点常塞一个 U+200B）去掉，不然检索和显示都多一个看不见的字
        data = _ZW.sub("", data)
        self._emit(data if self._pre else re.sub(r"\s+", " ", data))


@dataclass
class Page:
    title: str
    body: str  # 正文 markdown，图片位置是「[图3]」这样的记号
    links: list[str]  # 原样的 href，没解析成绝对地址
    images: list[tuple[str, str]]  # (src, alt)，第 i 张对应正文里的 [图i+1]


def parse(html: str) -> Page:
    """有 article / main 且够长就只要那一段（article 优先），不然整个 body 去掉导航页脚"""
    p = _Extract()
    p.feed(html)
    p.close()
    article, main, full = _tidy("".join(p.article)), _tidy("".join(p.main)), _tidy("".join(p.all))
    body = article if len(article) >= MIN_CHARS else main if len(main) >= MIN_CHARS else full
    title = " ".join(unescape(p.title).split())
    if not title:
        m = re.search(r"^#{2,} (.+)$", body, re.M)
        title = m.group(1) if m else ""
    return Page(title=title, body=body, links=p.links, images=p.images)


_IMG_MARK = re.compile(r"\s*\[图\d+\]\s*")


def html_to_md(html: str) -> tuple[str, str]:
    """(标题, 正文)。抓单页当资料用：图片记号去掉（资料里一个「[图3]」没有意义）"""
    page = parse(html)
    return page.title, _IMG_MARK.sub(" ", page.body).strip()


def _tidy(s: str) -> str:
    out: list[str] = []
    fence = False
    for line in s.splitlines():
        if line.strip().startswith("```"):
            fence = not fence
            out.append(line.strip())
            continue
        out.append(line.rstrip() if fence else line.strip())
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"^\s*\|\s*", "| ", text, flags=re.M)  # 表格行开头多出来的空格
    text = re.sub(r"^- \s*$\n?", "", text, flags=re.M)  # 空的列表项（只有图标的那种）
    return text.strip()


# ---- 存 + 入库 ----

def _file_for(url: str, title: str) -> Path:
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", title or urlsplit(url).hostname or "网页").strip(" .")[:50] or "网页"
    return WEB_DIR / f"{stem}-{hashlib.sha1(url.encode()).hexdigest()[:6]}.md"


def source_url(doc_path: str) -> str:
    """资料是网页抓的就返回网址，不是返回空。6099 列表上显示、「重新抓取」用"""
    p = ingest.ROOT / doc_path
    if p.parent != WEB_DIR:
        return ""
    try:
        return str(json.loads(p.with_suffix(".meta.json").read_text(encoding="utf-8")).get("url", ""))
    except (OSError, ValueError):
        return ""


def _existing(url: str) -> Path | None:
    """这个网址以前抓过就返回那份（标题变了文件名也跟着变，按网址找，不按文件名找）"""
    if not WEB_DIR.exists():
        return None
    for meta in WEB_DIR.glob("*.meta.json"):
        try:
            if json.loads(meta.read_text(encoding="utf-8")).get("url") == url:
                return meta.with_name(meta.name.removesuffix(".meta.json") + ".md")
        except (OSError, ValueError):
            continue
    return None


def _raw_file(target: Path) -> Path:
    """改写前的原文存哪（6099「原件」按钮打开的就是它）。不放 knowledge/ 底下：放那儿会被当成资料入库"""
    return RAW_DIR / target.name


def raw_of(doc_path: str) -> Path | None:
    p = ingest.ROOT / doc_path
    if p.parent != WEB_DIR:
        return None
    raw = _raw_file(p)
    return raw if raw.exists() else None


async def fetch_and_ingest(
    store: KBStore, llm: LLM, raw_url: str, *, rewrite_llm: LLM | None = None, lock: asyncio.Lock | None = None
) -> FetchResult:
    """`rewrite_llm`：改成灵眸说法用的模型（复盘那个，长提示词稳）。没给就用 llm。
    `lock`：只包住写文件 + 算向量那一段（admin_web 的 _embed_lock）。改写要几十秒，别让它挡住别的上传和改答案"""
    url = normalize_url(raw_url)
    final, ctype, body, charset = await download(url)
    if ctype in {"text/html", "application/xhtml+xml"} or (not ctype and b"<html" in body[:2048].lower()):
        title, text = html_to_md(_decode(body, charset))
    elif ctype == "application/pdf":
        title, text = "", await asyncio.to_thread(uploads._pdf_text, body)  # noqa: SLF001
    elif ctype.startswith("text/"):
        title, text = "", _decode(body, charset).strip()
        # 纯文本 / markdown 里的一级标题同样降一级，理由见 _Extract._close
        text = re.sub(r"^# ", "## ", text, flags=re.M)
    else:
        raise FetchError(f"这个网址不是网页（{ctype or '不知道是什么'}）。文件请下载后用上面的「选择文件上传」")
    if len(text) < MIN_CHARS:
        raise FetchError(
            f"只抓到 {len(text)} 个字，多半是要浏览器跑 JS 才出内容、或者要登录的页面。"
            "可以在浏览器里全选复制，存成 .txt 上传"
        )
    title = title or urlsplit(final).path.strip("/").rsplit("/", 1)[-1] or urlsplit(final).hostname or "网页"
    host = urlsplit(final).hostname or ""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 别家的文档改成灵眸的说法（rebrand.py）。我们自己的站不改
    original, replaced = f"# {title}\n\nURL: {final}\n\n{text}\n", []
    if not rebrand.is_ours(host):
        try:
            title, rb = await rebrand.rebrand(rewrite_llm or llm, text, host=host, title=title)
        except rebrand.RebrandError as e:
            raise FetchError(str(e)) from None
        text, replaced = rb.text, rb.replaced
        if len(text) < MIN_CHARS:
            raise FetchError("改成灵眸说法后没剩什么内容（这页多半全是别家的价格、政策），没入库")

    async with lock or asyncio.Lock():
        return await _save(store, llm, url, final, host, title, text, original, replaced, now)


async def _save(
    store: KBStore, llm: LLM, url: str, final: str, host: str, title: str, text: str,
    original: str, replaced: list[str], now: str,
) -> FetchResult:
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    old = _existing(url)
    target = _file_for(url, title)
    if old is not None and old != target:
        # 同一个网址标题变了：换文件名，旧的连库里的块一起删掉，别留两份
        await asyncio.to_thread(uploads.delete, store, old.relative_to(ingest.ROOT).as_posix())
        _raw_file(old).unlink(missing_ok=True)
    # 抓取时间只记在 .meta.json：写进正文的话「# 标题」底下就只有那一行，切出来一个没用的块。
    # **`URL:` 行只给我们自己的站写**：机器人答题会把资料的网址附在回答末尾，别家的网址就这么发进客户群了
    head = f"# {title}\n\nURL: {final}\n\n" if rebrand.is_ours(host) else f"# {title}\n\n"
    content = f"{head}{text}\n"
    target.write_text(content, encoding="utf-8")
    if replaced:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        _raw_file(target).write_text(original, encoding="utf-8")
    else:
        _raw_file(target).unlink(missing_ok=True)
    target.with_suffix(".meta.json").write_text(
        json.dumps(
            {"url": url, "final_url": final, "title": title, "fetched_at": now, "chars": len(text), "replaced": replaced},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    state, n = await ingest_file(store, llm, target)
    log.info("后台抓网页 %s → %s（%s，%d 块，换掉了 %s）", url, target.name, state, n, "、".join(replaced) or "无")
    return FetchResult(
        doc_path=target.relative_to(ingest.ROOT).as_posix(), title=title, url=final, state=state,
        chunks=n, chars=len(text), replaced=replaced,
    )
