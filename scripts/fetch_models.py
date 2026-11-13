"""把模型广场（https://api.lmuai.com/models）抓成一份资料，存进 knowledge/。

为什么单独一个脚本、不塞进 fetch_docs.py：
文档站有 llms-full.txt，一个 URL 拿全部；模型广场没有这种东西，只有一张 HTML 表格。
而且这两份资料的时效完全不同 —— 文档几周不变，在售模型清单天天变。
2026-09-24 亲测过一次：广场上有 Claude Opus 5.5 在卖，文档里一个字都没提，
机器人照着文档回了句「没有 5.5 这个版本，你是不是记岔了」，对着真客户说的。
所以这份清单得自己每天抓一遍，别再让机器人拿几周前的文档当在售清单。

广场是前端渲染的，原始 HTML 里没有模型 ID 的 JSON（试过，扒出来的是 refund、terms 这种垃圾）。
能稳住的办法是解析渲染进 HTML 的表格文字：一行五格 —— 模型 / 厂商 / 输入价 / 输出价 / 上下文，
靠「第三格是价钱」这个特征对齐。不列厂商白名单：2026-09-24 就是白名单漏了 grok 和 xiaomi，
124 个模型只数出 103 个。价格对齐不挑厂商，数出来的数跟页面自己写的总数一模一样。

用法: uv run scripts/fetch_models.py [URL]
退出码: 0 成功（不管变没变） / 1 网络失败 / 2 抓回来的内容不对劲，没有覆盖旧文件
"""
import hashlib
import html as htmllib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE = ROOT / "knowledge"
DOC_FILE = KNOWLEDGE / "models-plaza.md"
META_FILE = KNOWLEDGE / "models-plaza.meta.json"
DEFAULT_URL = "https://api.lmuai.com/models"
# 标题里写清楚是哪个站的清单。**别把两个站的清单混进同一个文件** ——
# 抓 .ai 会把 .com 的清单整份覆盖掉，而且两站数量差得远（2026-09-24：.com 29 行、.ai 124 行），
# 缩水闸会拦住反向覆盖，但正向（.com -> .ai）拦不住。真要两份就再加一组文件名。
STATIONS = {"api.lmuai.com": "大陆站", "api.lmuai.ai": "国际站"}

# 解析出来的行数低于这个就当它不对劲（站点改版、被挡、返回错误页、前端没渲染出来）。
# 2026-09-24 首次抓取 .com 是 29 行，硬地板放到 12：宁可不动旧文件，也别把半张表当成全清单。
MIN_ROWS = 12
# 就算过了硬地板，比上次少两成也算可疑 —— 一次下架 20% 的模型不太可能，更像是没抓全。
SHRINK_TOLERANCE = 0.8

# 价钱格：¥0.002 / $1.181 这种。国内模型标人民币，国外标美元。
PRICE = re.compile(r"^[¥$]\s*[\d.,]+")
# 该填数、页面却填了破折号的格。embedding 模型没有输出价，生图模型没有上下文，都是「—」。
DASH = re.compile(r"^[—–\-]+$")
# 上下文格：1M / 205K / 1.3M / 262K，或者破折号。用来卡住「这一行到底是不是模型行」。
CONTEXT = re.compile(r"^(?:[\d.]+\s*[KMkm]|[\d,]+|[—–\-]+)$")


def fetch(url: str) -> str:
    # 带 UA，有些站对默认的 python-urllib 直接拒
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (lingmou-bot models fetcher)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def cells(page: str) -> list[str]:
    """把 HTML 拆成一串「格子文字」。

    脚本和样式先整段扔掉 —— 里面有 Next.js 塞的数据，留着会混进一堆假格子。
    剩下的按标签切开，每段去掉首尾空白，空的不要。
    """
    page = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", page)
    page = re.sub(r"(?is)<!--.*?-->", " ", page)
    chunks = re.split(r"(?s)<[^>]+>", page)
    return [c for c in (htmllib.unescape(x).strip() for x in chunks) if c]


def parse_rows(page: str) -> tuple[list[dict], int]:
    """按「第三格是价钱」对齐，抠出五列。返回（去重后的行, 页面上渲染出的行数）。

    遇到价钱格就往前看两格（模型、厂商）、往后看两格（输出价、上下文）。
    表头那行的「输入价 / 生图价」不是价钱格，自然不会被当成数据。

    卡三个条件，别的一律不挑（不列厂商白名单，见文件开头）：
    输入价是价钱、输出价是价钱或者破折号（embedding 没有输出价）、上下文是 1M/205K 那种或破折号。
    三格都对上才算一行 —— 页面别处的钱（余额、套餐价）后面不会正好跟着一个上下文格。

    去重只去「五格一模一样」的：2026-09-24 页面上 MiniMax M2.5 出现两次，
    价钱一次 ¥1.3/¥5.21 一次 ¥3.15/¥12.6 —— 那是同名不同档，两条都得留。
    只有 Qwen3.8 Max 那种五格全同的才是页面自己重了。
    """
    cs = cells(page)
    rows, seen = [], set()
    rendered = 0
    for i, c in enumerate(cs):
        if not PRICE.match(c) or i < 2 or i + 2 >= len(cs):
            continue
        model, vendor, out_price, ctx = cs[i - 2], cs[i - 1], cs[i + 1], cs[i + 2]
        if not (PRICE.match(out_price) or DASH.match(out_price)):
            continue
        if not CONTEXT.match(ctx):
            continue
        # 厂商格是 deepseek、qwen 这种短标识，不该带钱也不该是长句
        if len(vendor) > 32 or PRICE.match(vendor):
            continue
        rendered += 1
        key = (model, vendor, c, out_price, ctx)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"model": model, "vendor": vendor, "input": c, "output": out_price, "context": ctx})
    return rows, rendered


def render(rows: list[dict], url: str) -> str:
    """写成给切块器吃的 Markdown。

    故意不把抓取时间写进正文：正文里带时间戳，每天抓完 sha256 都不一样，
    「没变化就不重建索引」这条就废了。时间只进 .meta.json。
    一个厂商一个小节 —— 切块器按 ## 分段，客户问「有哪些 Claude」时正好命中一块。
    """
    by_vendor: dict[str, list[dict]] = {}
    for r in rows:
        by_vendor.setdefault(r["vendor"], []).append(r)

    host = urllib.parse.urlparse(url).hostname or ""
    station = STATIONS.get(host, host or "模型广场")

    out = [f"# 模型广场 · {station}（{host}）在售清单", ""]
    out.append(f"这份清单是从{station}的模型广场（{url}）当天抓下来的，价钱和上下文照这份说。")
    out.append("")
    out.append(f"共 {len(rows)} 个模型，{len(by_vendor)} 个厂商。token 模型的价钱是每 100 万 token，生图模型是每张；按各模型官方计价币种。")
    out.append("")
    out.append(f"**这份清单只是{station}的，不是灵眸的全部模型。**")
    if host == "api.lmuai.com":
        out.append("国外模型（Claude、GPT、Gemini、Grok）在国际站 https://api.lmuai.ai/models 的广场上，不在这份清单里。")
    # **这里只写事实，不写「别跟客户说…」那种命令。** 2026-09-24 一开始写成了命令句，
    # 两个毛病：① 资料是检索出来的，够不到就等于没写 —— 实测「怎么用opus5.5呀」
    # 这段排到 933 块里的第 707 名，而只有前 5 名进模型，那句话根本到不了它眼前；
    # ② 规矩的正确位置是 `bot/kb/answer.py` 的 `_RAG_SYSTEM`（那是每次必然生效的），
    # 现在是第 8 条。资料文件只负责说清「这份清单覆盖到哪」。
    out.append(f"清单里没有某个型号，只说明{station}广场当天没列它，**不说明灵眸没有这个型号**。")
    if host == "api.lmuai.com":
        out.append("客户问国外模型，让他上 https://api.lmuai.ai 登一下在那边选模型和分组，账号密钥余额跟大陆站是通的；"
                   "工具里的接口地址仍然填 https://api.lmuai.com，不用改。")
    out.append("")
    for vendor in sorted(by_vendor, key=lambda v: (-len(by_vendor[v]), v)):
        items = by_vendor[vendor]
        out.append(f"## {vendor}（{len(items)} 个）")
        out.append("")
        out.append("| 模型 | 输入价 | 输出价 | 上下文 |")
        out.append("| --- | --- | --- | --- |")
        for r in items:
            # 名字里真要带个 | 就会把表格拆坏，转义掉
            cell = {k: v.replace("|", "\\|") for k, v in r.items()}
            out.append(f"| {cell['model']} | {cell['input']} | {cell['output']} | {cell['context']} |")
        out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    print(f"抓取 {url} …")
    try:
        page = fetch(url)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"错误：抓取失败 -> {e}")
        return 1

    rows, rendered = parse_rows(page)
    old = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    old_rows = old.get("models", 0)
    if rendered != len(rows):
        print(f"  （页面上 {rendered} 行，其中 {rendered - len(rows)} 行五格全同，按重复去掉）")

    # 两道闸，过不去就不动旧文件：旧清单可能少几个新模型，也比把半张表当成全清单强
    if len(rows) < MIN_ROWS:
        print(f"错误：只解析出 {len(rows)} 个模型，少于 {MIN_ROWS}，判定没抓全（改版？被挡？）。旧文件没动。")
        return 2
    if old_rows and len(rows) < old_rows * SHRINK_TOLERANCE:
        print(f"错误：模型数从 {old_rows} 掉到 {len(rows)}，少了两成以上，不像是正常下架。旧文件没动。")
        print("  要是广场真的下架了这么多，手动删掉 knowledge/models-plaza.meta.json 再跑一次。")
        return 2

    text = render(rows, url)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if old.get("sha256") == digest:
        print(f"清单没变化（{len(rows)} 个模型，上次抓取 {old.get('fetched_at')}）。索引不用重建。")
        return 0

    vendors = sorted({r["vendor"] for r in rows})
    KNOWLEDGE.mkdir(exist_ok=True)
    DOC_FILE.write_text(text, encoding="utf-8")
    META_FILE.write_text(
        json.dumps(
            {
                "url": url,
                "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "sha256": digest,
                "models": len(rows),
                "rendered_rows": rendered,
                "vendors": len(vendors),
                "chars": len(text),
                "vendor_counts": {v: sum(1 for r in rows if r["vendor"] == v) for v in vendors},
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    if old:
        print(f"清单有更新：{old_rows} 个模型 -> {len(rows)} 个")
        was = set((old.get("vendor_counts") or {}).keys())
        now = set(vendors)
        if now - was:
            print(f"  新厂商：{'、'.join(sorted(now - was))}")
        if was - now:
            print(f"  没了的厂商：{'、'.join(sorted(was - now))}")
    else:
        print(f"首次抓取完成：{len(rows)} 个模型")
    print("  " + "、".join(f"{v} {sum(1 for r in rows if r['vendor'] == v)}" for v in vendors))
    print(f"  存到 {DOC_FILE.relative_to(ROOT)}")
    print("⚠️ 清单变了，向量索引要重建，跑 uv run -m bot.kb.ingest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
