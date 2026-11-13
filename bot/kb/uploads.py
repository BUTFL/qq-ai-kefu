"""后台上传的资料：存文件、抽文字、入库。

放哪儿：
- `knowledge/上传/<名字>.md|.txt` —— 抽出来的文字，**这才是入库的东西**。
  放在 knowledge/ 底下是故意的：每天 07:23 那次 `bot.kb.ingest` 会 `drop_docs_except`
  清掉「文件已经不在 knowledge/ 里」的资料，放别处的话第二天早上就被当成过期资料删了。
- `data/上传原件/<名字>` —— pdf / docx / 图片的原件，后台里点得开，方便核对抽得对不对。
  txt / md 本身就是文字，不另存原件。

图片走看图模型转成文字（`LLM.read_image`），抽出来的文字和别的资料一样切块、算向量。
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from .ingest import KNOWLEDGE, ROOT, ingest_file
from .llm import LLM
from .store import KBStore

log = logging.getLogger(__name__)

UPLOAD_DIR = KNOWLEDGE / "上传"
RAW_DIR = ROOT / "data" / "上传原件"

TEXT_SUFFIXES = {".txt", ".md", ".markdown"}
DOC_SUFFIXES = {".pdf", ".docx"}
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
ALLOWED = TEXT_SUFFIXES | DOC_SUFFIXES | set(IMAGE_MIME)

_BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class UploadError(ValueError):
    """给人看的错误，后台原样显示。"""


@dataclass
class UploadResult:
    doc_path: str  # 入库用的相对路径，同时也是后台列表里的主键
    state: str  # 新增 / 更新 / 跳过
    chunks: int
    chars: int


def safe_name(name: str) -> str:
    """只留文件名本身，去掉路径和文件系统不认的字符。

    先 unquote：有的客户端把 multipart 里的中文文件名按 %E8%AE… 编码发上来，
    不解码的话磁盘上就是一串百分号，后台列表里认不出是哪份。
    """
    base = Path(unquote(name).replace("\\", "/")).name
    base = _BAD_CHARS.sub("_", base).strip().lstrip(".")
    if not base:
        raise UploadError("文件名是空的")
    stem, suffix = Path(base).stem[:80], Path(base).suffix.lower()
    if suffix not in ALLOWED:
        raise UploadError(f"不支持 {suffix or '无后缀'} 文件，只收 {' '.join(sorted(ALLOWED))}")
    return f"{stem}{suffix}"


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = [(p.extract_text() or "").strip() for p in reader.pages]
    return "\n\n".join(f"## 第 {i} 页\n\n{t}" for i, t in enumerate(pages, 1) if t)


def _docx_text(data: bytes) -> str:
    import docx

    d = docx.Document(io.BytesIO(data))
    out: list[str] = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        # Word 的「标题 1/2/3」样式转成 md 标题，切块才能按章节切
        style = (p.style.name or "") if p.style is not None else ""
        m = re.search(r"(?:Heading|标题)\s*(\d)", style)
        out.append(f"{'#' * (int(m.group(1)) + 1)} {t}" if m else t)
    for table in d.tables:
        rows = [[c.text.strip().replace("\n", " ") for c in r.cells] for r in table.rows]
        if rows:
            out.append("| " + " | ".join(rows[0]) + " |")
            out.append("|" + " --- |" * len(rows[0]))
            out.extend("| " + " | ".join(r) + " |" for r in rows[1:])
    return "\n\n".join(out)


async def save_and_ingest(
    store: KBStore, llm: LLM, name: str, data: bytes, *, vision_model: str
) -> UploadResult:
    fname = safe_name(name)
    stem, suffix = Path(fname).stem, Path(fname).suffix
    if not data:
        raise UploadError(f"{fname} 是空文件")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if suffix in TEXT_SUFFIXES:
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            try:
                content = data.decode("gb18030")
            except UnicodeDecodeError:
                raise UploadError(f"{fname} 不是 UTF-8 也不是 GBK 编码的文字") from None
        target = UPLOAD_DIR / fname
    else:
        if suffix == ".pdf":
            content = _pdf_text(data)
            kind = "PDF"
        elif suffix == ".docx":
            content = _docx_text(data)
            kind = "Word"
        else:
            content = await llm.read_image(data, IMAGE_MIME[suffix], model=vision_model)
            kind = "图片"
        if not content.strip():
            raise UploadError(f"{fname} 里抽不出文字（扫描版 PDF 请截图后按图片上传）")
        # 标题用原文件名：切块标题会带上它，检索和排查时一眼知道出自哪份
        content = f"# {stem}\n\n> {kind}资料，原件：{fname}\n\n{content.strip()}\n"
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        (RAW_DIR / fname).write_bytes(data)
        target = UPLOAD_DIR / f"{stem}{suffix.replace('.', '_')}.md"

    if not content.strip():
        raise UploadError(f"{fname} 里没有文字")
    target.write_text(content, encoding="utf-8")
    state, n = await ingest_file(store, llm, target)
    log.info("后台上传资料 %s → %s（%s，%d 块）", fname, target.name, state, n)
    return UploadResult(doc_path=target.relative_to(ROOT).as_posix(), state=state, chunks=n, chars=len(content))


def raw_of(doc_path: str) -> Path | None:
    """资料对应的原件（只有 pdf/docx/图片有）。"""
    p = ROOT / doc_path
    m = re.fullmatch(r"(.+)_(pdf|docx|png|jpe?g|webp|gif)", p.stem)
    if p.parent != UPLOAD_DIR or not m:
        return None
    raw = RAW_DIR / f"{m.group(1)}.{m.group(2)}"
    return raw if raw.exists() else None


def delete(store: KBStore, doc_path: str) -> bool:
    """删资料：库里的块、knowledge/ 下的文件、原件，三样都删。

    只许删 knowledge/ 底下的东西，路径是前端传来的，不能信。
    """
    p = (ROOT / doc_path).resolve()
    if not p.is_relative_to(KNOWLEDGE.resolve()):
        raise UploadError("只能删 knowledge/ 里的资料")
    raw = raw_of(doc_path)
    # 网页抓的：改写前的原文（kb/webpage.py），函数里 import 免得循环引用
    from . import webpage

    web_raw = webpage.raw_of(doc_path)
    found = store.drop_doc(doc_path)
    if p.exists():
        p.unlink()
        found = True
    if raw is not None:
        raw.unlink()
    if web_raw is not None:
        web_raw.unlink()
    # 抓回来的资料有个同名 .meta.json，一起清掉，不然留个孤儿文件
    meta = p.with_suffix(".meta.json")
    if meta.exists():
        meta.unlink()
    return found
