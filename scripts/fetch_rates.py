"""把按量计费分组的倍率抓成一份资料，存进 knowledge/。

2026-09-28 管理员给了后台分组列表的截图，定的：「只有公开和不停用的是按量付费的倍率可以告诉用户，
不需要多说，只需要回答用户问的就好了」。

数据来自模型广场页（https://api.lmuai.ai/model-plaza）调的**不用登录**的接口：
    GET https://api.lmuai.ai/api/v1/model-plaza
它只返回公开、在用的按量分组（专属分组、停用分组、月卡周卡都不在里面），正好就是他说能讲的那些。
2026-09-28 跟后台截图逐个对过，19 个分组的倍率全对得上。这里只 GET 这一个接口，不登录。

**后台是「公开 + 正常」、广场接口却没列的有 5 个**（EXTRA，照当天截图手抄的）。
这 5 个**不会自己更新**：后台改了倍率、停了分组，得手改 EXTRA。广场哪天列出来了，按 id 以广场为准。

**文件里只写分组名和倍率**，不抄分组说明：说明里有「敢承诺官方Claude Max中转」「原6.8汇率」这种话，
抄进来模型就会照着讲给客户（「中转」是 answer.py 的甩锅词，「汇率」会跟月卡的折算汇率搅在一起）。

用法: uv run scripts/fetch_rates.py
退出码: 0 成功（不管变没变） / 1 网络失败 / 2 抓回来的内容不对劲，没有覆盖旧文件
"""
import hashlib
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE = ROOT / "knowledge"
DOC_FILE = KNOWLEDGE / "group-rates.md"
META_FILE = KNOWLEDGE / "group-rates.meta.json"
API = "https://api.lmuai.ai/api/v1/model-plaza"
PAGE = "https://api.lmuai.ai/model-plaza"

# 2026-09-28 首次是 19 个。少于这个当它不对劲（接口改了、被挡、返回空）
MIN_GROUPS = 10
# 分组数一下掉两成以上，不像正常下架，不覆盖
SHRINK_TOLERANCE = 0.8

# 后台「公开 + 正常」、广场接口没列的（2026-09-28 截图）
EXTRA = [
    {"id": 206, "name": "Claude-MAX-蒸馏分组 (0注入)", "rate_multiplier": 3.6},
    {"id": 80, "name": "Gemini-MAX 高倍率分组", "rate_multiplier": 2.5},
    {"id": 86, "name": "Gemini-image", "rate_multiplier": 1},
    {"id": 88, "name": "Grok-Pro 超值版", "rate_multiplier": 0.8},
    {"id": 141, "name": "Grok-heavy 高倍率分组", "rate_multiplier": 2.2},
]

# 按分组名归类。不按 platform 分：「阿里Qwen(Anthropic协议)」的 platform 也是 anthropic
FAMILIES = ("Claude", "GPT", "Gemini", "Grok")
DOMESTIC = "国产模型"


def fetch() -> dict:
    req = urllib.request.Request(API, headers={"User-Agent": "Mozilla/5.0 (lingmou-bot rates fetcher)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def family(name: str) -> str:
    low = name.lower()
    return next((f for f in FAMILIES if low.startswith(f.lower())), DOMESTIC)


def rate(x) -> str:
    """0.52 → 0.52x；3 → 3x"""
    return f"{float(x):g}x"


def merge(groups: list[dict]) -> list[dict]:
    """广场的分组 + EXTRA 里广场没列的。专属的、没倍率的不要"""
    out = [g for g in groups if not g.get("is_exclusive") and g.get("rate_multiplier") is not None]
    seen = {g.get("id") for g in out}
    return out + [g for g in EXTRA if g["id"] not in seen]


def render(groups: list[dict]) -> str:
    """写成给切块器吃的 Markdown。一家一个 ## 小节，客户问「claude 按量倍率多少」正好命中一块。

    **正文里不带抓取时间**（理由同 fetch_models.py：带了每天 sha256 都变，索引天天白重建）。
    """
    by_fam: dict[str, list[dict]] = {}
    for g in groups:
        by_fam.setdefault(family(g["name"]), []).append(g)

    # 第二行的 URL: 给切块器看的（bot/kb/text.py 的 _URL_LINE），每块都带模型广场的链接
    out = ["# 灵眸按量计费分组倍率", f"URL: {PAGE}", ""]
    out.append("按量计费（余额扣费）的分组，每个分组一个倍率。这里是公开、在用的全部按量分组。")
    fams = [f"{f}（{len(by_fam[f])} 个）" for f in (*FAMILIES, DOMESTIC) if by_fam.get(f)]
    out.append(f"一共 {len(groups)} 个，分 {len(fams)} 类：{'、'.join(fams)}。")
    out.append("月卡、周卡的倍率不在这里，见套餐价格那份。")
    out.append("")
    for fam in (*FAMILIES, DOMESTIC):
        items = sorted(by_fam.get(fam, []), key=lambda g: (float(g["rate_multiplier"]), g["name"]))
        if not items:
            continue
        out.append(f"## {fam} 按量计费分组倍率（{len(items)} 个）")
        out.append("")
        out.append("| 分组 | 倍率 |")
        out.append("| --- | --- |")
        for g in items:
            out.append(f"| {g['name']} | {rate(g['rate_multiplier'])} |")
        out.append("")
    return "\n".join(out)


def main() -> int:
    print(f"抓取 {API} …")
    try:
        data = fetch()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        print(f"错误：抓取失败 -> {e}")
        return 1
    raw = ((data or {}).get("data") or {}).get("groups") or []
    raw = [g for g in raw if isinstance(g, dict) and g.get("name")]

    old = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    if len(raw) < MIN_GROUPS:
        print(f"错误：只拿到 {len(raw)} 个分组，少于 {MIN_GROUPS}，判定不对劲。旧文件没动。")
        return 2
    if old.get("plaza_groups") and len(raw) < old["plaza_groups"] * SHRINK_TOLERANCE:
        print(f"错误：分组数从 {old['plaza_groups']} 掉到 {len(raw)}，少了两成以上。旧文件没动。")
        print("  真下架了这么多，手动删掉 knowledge/group-rates.meta.json 再跑一次。")
        return 2

    groups = merge(raw)
    text = render(groups)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if old.get("sha256") == digest:
        print(f"倍率没变化（{len(groups)} 个分组，上次抓取 {old.get('fetched_at')}）。")
        return 0
    KNOWLEDGE.mkdir(exist_ok=True)
    DOC_FILE.write_text(text, encoding="utf-8")
    META_FILE.write_text(
        json.dumps(
            {
                "url": API,
                "page": PAGE,
                "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "sha256": digest,
                "plaza_groups": len(raw),
                "groups": len(groups),
                "chars": len(text),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"已更新 {DOC_FILE.name}：{len(groups)} 个分组（广场 {len(raw)} + 手补 {len(groups) - len(raw)}），{len(text)} 字")
    return 0


if __name__ == "__main__":
    sys.exit(main())
