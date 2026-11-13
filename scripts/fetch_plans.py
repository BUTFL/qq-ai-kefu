"""把套餐价格页（https://api.lmuai.ai/purchase）抓成一份资料，存进 knowledge/。

2026-09-28 管理员定的：「https://api.lmuai.ai/purchase 这个是国外模型和国内模型的套餐价格」，
机器人回答套餐、价格照这份说。

页面是前端渲染的，数据来自一个**不用登录**的接口：
    GET https://api.lmuai.ai/api/v1/payment/public/plans
（/pricing 页的 PricingView 调的就是它；/purchase 要登录，接口一样）。这里只 GET 这一个接口，
不登录、不碰支付。

**为什么要单独一份、不信文档站里的价格表**：文档站 docs/enterprise 那页写的「40 并发起」，
购买页已经是「30+ 并发」了 —— 文档几周不变，价格页随时改。价格以这份为准。

国外 / 国内怎么分：接口里没有「国外」两个字。国产的 `category` 是「国产模型月卡」、
`currency` 是 CNY；其余（Claude / GPT）都是国外。价格一律人民币（`price`），
`original_price` 是划线价。

**国外套餐在大陆网络下看不到**（接口给它们标了 `availability: region_not_supported`）。
2026-09-28 14:28 真客户问「月卡只看到 kimi glm，没看到 claude，是我理解错了吗」，机器人检索到的
只有「国产模型月卡」那块，就答了「没理解错，Claude 一般走按量」—— 错的。所以每一节国外套餐
开头都写一句「有 Claude / GPT 月卡，看不到是因为要开梯子走 .ai」，不管检索到哪一块都带着这句。

用法: uv run scripts/fetch_plans.py
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
DOC_FILE = KNOWLEDGE / "plans.md"
META_FILE = KNOWLEDGE / "plans.meta.json"
API = "https://api.lmuai.ai/api/v1/payment/public/plans"
PAGE = "https://api.lmuai.ai/purchase"

# 2026-09-28 首次是 35 个套餐。少于这个当它不对劲（接口改了、被挡、返回空）
MIN_PLANS = 10
# 套餐数一下掉两成以上，不像正常下架，不覆盖
SHRINK_TOLERANCE = 0.8
DOMESTIC = "国产模型月卡"


def fetch() -> dict:
    req = urllib.request.Request(API, headers={"User-Agent": "Mozilla/5.0 (lingmou-bot plans fetcher)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def money(x) -> str:
    """599 → ¥599；3999 → ¥3,999。跟文档站那张表同一种写法，客户看着一致"""
    if x is None:
        return "—"
    n = float(x)
    return f"¥{n:,.0f}" if n == int(n) else f"¥{n:,.2f}"


def quota(p: dict) -> str:
    parts = []
    for key, cn in (("daily_limit_usd", "日"), ("weekly_limit_usd", "周"), ("monthly_limit_usd", "月")):
        v = p.get(key)
        if v:  # 0 和 None 都当「不限」
            parts.append(f"{cn} ${v:g}")
    return " / ".join(parts) or "—"


def days(p: dict) -> str:
    d = p.get("validity_days")
    return f"{d} 天" if d else "—"


def concurrency(p: dict) -> str:
    """企业版的并发数写在 features 里（「30+ 个独立并发」），名字里也有（「(30+并发)」）"""
    import re

    for f in [*(p.get("features") or []), p.get("name") or ""]:
        m = re.search(r"(\d+\+?)\s*(?:个)?\s*(?:独立)?并发", str(f))
        if m:
            return m.group(1)
    return ""


def render(plans: list[dict]) -> str:
    """写成给切块器吃的 Markdown。一类套餐一个 ## 小节，客户问「claude 月卡多少钱」正好命中一块。

    **正文里不带抓取时间**（理由同 fetch_models.py：带了每天 sha256 都变，索引天天白重建）。
    """
    foreign = [p for p in plans if p.get("category") != DOMESTIC]
    domestic = [p for p in plans if p.get("category") == DOMESTIC]

    # 第二行的 URL: 是给切块器看的（bot/kb/text.py 的 _URL_LINE）：这份资料切出来的每一块都带上购买页的链接，
    # 机器人答完附的就是购买页，而不是文档站那页过期的价格表
    out = ["# 灵眸套餐价格（国外模型 + 国产模型）", f"URL: {PAGE}", ""]
    out.append(f"这份是从购买页 {PAGE} 抓下来的，**套餐和价格以这份为准**（文档站里的价格表可能是旧的）。")
    out.append("价格都是人民币；「原价」是页面上的划线价。额度是美元额度，按页面写的折算。")
    out.append(f"购买入口：{PAGE}（要先登录）。")
    out.append("")
    out.append(f"**Claude、GPT 这些国外模型也有月卡、周卡、企业版**（共 {len(foreign)} 个），只是在大陆网络下购买页只显示国产模型月卡。"
               "客户说「只看到 kimi / glm，没看到 claude」不是没有，是要开梯子走 https://api.lmuai.ai 才看得到，账号跟 .com 通用。")
    ent = [p for p in foreign if concurrency(p)]
    if ent:
        # **并发单独写一段放最前面**：文档站 docs/enterprise 还写着「40 起 / 80 起」，是旧的。
        # 不单独写的话，客户问「企业版并发多少」检索到的是文档站那块，照旧的答
        out.append("")
        out.append("**企业版并发数（以购买页为准，文档站写的「40 起 / 80 起」是旧的）：**")
        for p in sorted(ent, key=lambda p: p.get("price") or 0):
            out.append(f"- {p['name']}：{concurrency(p)} 个独立并发，{money(p.get('price'))} / {days(p)}")
    out.append("")

    groups: dict[str, list[dict]] = {}
    for p in foreign:
        cat = p.get("category") or "月卡"
        plat = {"anthropic": "Claude", "openai": "GPT"}.get(p.get("group_platform", ""), p.get("group_platform", ""))
        groups.setdefault(f"国外模型 · {plat} {cat}", []).append(p)
    for title in sorted(groups, key=lambda t: (("企业" in t), ("周卡" in t), t)):
        items = sorted(groups[title], key=lambda p: p.get("price") or 0)
        out.append(f"## {title}（{len(items)} 个）")
        out.append("")
        out.append("这一档是国外模型的套餐，大陆网络下购买页看不到，要开梯子走 https://api.lmuai.ai 才显示。")
        out.append("")
        with_conc = any(concurrency(p) for p in items)
        out.append("| 套餐 | 价格 | 原价 | 有效期 | 额度 | 倍率 |" + (" 并发 |" if with_conc else ""))
        out.append("| --- | --- | --- | --- | --- | --- |" + (" --- |" if with_conc else ""))
        for p in items:
            out.append(
                f"| {p['name']} | {money(p.get('price'))} | {money(p.get('original_price'))} | {days(p)} "
                f"| {quota(p)} | {p.get('rate_multiplier', '—')}x |" + (f" {concurrency(p) or '—'} |" if with_conc else "")
            )
        out.append("")
        for p in items:
            feats = [f for f in (p.get("features") or []) if f]
            desc = " ".join(str(p.get("description") or "").split())
            out.append(f"**{p['name']}**：{desc}")
            if feats:
                out.append(f"包含：{'、'.join(feats)}")
            out.append("")

    by_product: dict[str, list[dict]] = {}
    for p in domestic:
        by_product.setdefault(p.get("product_name") or p.get("group_platform") or "国产模型", []).append(p)
    if by_product:
        out.append(f"## 国产模型月卡（{len(domestic)} 个，{len(by_product)} 家）")
        out.append("")
        out.append("每档都是 30 天，月额度等于价格（按人民币 1:1 折算）。")
        out.append(f"**这里只是国产模型。Claude、GPT 也有月卡**（见上面「国外模型」那几节，共 {len(foreign)} 个），"
                   "购买页只看到国产的，是因为国外套餐要开梯子走 https://api.lmuai.ai 才显示。")
        out.append("")
        out.append("| 模型 | 套餐 | 价格 | 倍率 |")
        out.append("| --- | --- | --- | --- |")
        for prod in by_product:
            for p in sorted(by_product[prod], key=lambda p: p.get("price") or 0):
                out.append(f"| {prod} | {p['name']} | {money(p.get('price'))} | {p.get('rate_multiplier', '—')}x |")
        out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    print(f"抓取 {API} …")
    try:
        data = fetch()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        print(f"错误：抓取失败 -> {e}")
        return 1
    plans = ((data or {}).get("data") or {}).get("plans") or []
    plans = [p for p in plans if isinstance(p, dict) and p.get("name") and p.get("price") is not None]

    old = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    if len(plans) < MIN_PLANS:
        print(f"错误：只拿到 {len(plans)} 个套餐，少于 {MIN_PLANS}，判定不对劲。旧文件没动。")
        return 2
    if old.get("plans") and len(plans) < old["plans"] * SHRINK_TOLERANCE:
        print(f"错误：套餐数从 {old['plans']} 掉到 {len(plans)}，少了两成以上。旧文件没动。")
        print("  真下架了这么多，手动删掉 knowledge/plans.meta.json 再跑一次。")
        return 2

    text = render(plans)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if old.get("sha256") == digest:
        print(f"套餐没变化（{len(plans)} 个，上次抓取 {old.get('fetched_at')}）。")
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
                "plans": len(plans),
                "domestic": sum(1 for p in plans if p.get("category") == DOMESTIC),
                "chars": len(text),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"已更新 {DOC_FILE.name}：{len(plans)} 个套餐，{len(text)} 字")
    return 0


if __name__ == "__main__":
    sys.exit(main())
