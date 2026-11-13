"""把灵眸文档整站抓下来，存进 knowledge/，给阶段 5 的 AI 问答当资料。

文档站提供了 llms-full.txt —— 整站内容压成一个纯文本文件，本来就是给大模型读的。
所以这里不爬站、不解析 HTML：一个 URL 拿全部，也不用对付它的 Next.js 动态渲染。
文档更新了就重跑一次，脚本会告诉你变没变、变了多少。

用法: uv run scripts/fetch_docs.py [URL]
退出码: 0 成功（不管变没变） / 1 网络失败 / 2 抓回来的内容不对劲，没有覆盖旧文件
"""
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE = ROOT / "knowledge"
DOC_FILE = KNOWLEDGE / "lmuai-docs.txt"
META_FILE = KNOWLEDGE / "lmuai-docs.meta.json"
DEFAULT_URL = "https://docs.lmuai.com/llms-full.txt"

# 抓回来的东西小于这个就当它不对劲（站点改版、被挡、返回错误页）。
# 2026-09-22 首次抓取是 217456 字，留了很大余量，只防「明显不是文档」的情况。
MIN_CHARS = 50_000


def fetch(url: str) -> str:
    # 带 UA，有些站对默认的 python-urllib 直接拒
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (lingmou-bot docs fetcher)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def summarize(text: str) -> dict:
    """数一下规模，用来和上次比对，也让人一眼看出抓得对不对"""
    return {
        "chars": len(text),
        "lines": text.count("\n") + 1,
        "pages": len(re.findall(r"^# ", text, re.M)),
        "sections": len(re.findall(r"^## ", text, re.M)),
        # Callout 是文档里的问答块，天然就是 FAQ，切块时会单独拿出来
        "callouts": len(re.findall(r"<Callout", text)),
    }


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    print(f"抓取 {url} …")
    try:
        text = fetch(url)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"错误：抓取失败 -> {e}")
        return 1

    if len(text) < MIN_CHARS:
        # 宁可不动旧文件：旧资料虽然可能过期，也比把错误页当成资料强
        print(f"错误：只抓到 {len(text)} 字，少于 {MIN_CHARS}，判定不是完整文档。旧文件没动。")
        return 2

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    old = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    stat = summarize(text)

    if old.get("sha256") == digest:
        print(f"文档没变化（{stat['chars']:,} 字，上次抓取 {old.get('fetched_at')}）。索引不用重建。")
        return 0

    KNOWLEDGE.mkdir(exist_ok=True)
    DOC_FILE.write_text(text, encoding="utf-8")
    META_FILE.write_text(
        json.dumps(
            {"url": url, "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "sha256": digest, **stat},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    if old:
        delta = stat["chars"] - old.get("chars", 0)
        print(f"文档有更新：{old.get('chars', 0):,} 字 -> {stat['chars']:,} 字（{delta:+,}）")
        print("⚠️ 资料变了，向量索引要重建，跑 scripts/build_index.py")
    else:
        print(f"首次抓取完成：{stat['chars']:,} 字")
    print(f"  {stat['pages']} 页 / {stat['sections']} 个章节 / {stat['callouts']} 个问答块")
    print(f"  存到 {DOC_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
