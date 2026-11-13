# -*- coding: utf-8 -*-
"""每周热度前三：客户在群里讨论什么、在问什么 → 发日报群。

2026-11-06 管理员要的：「每周一在日报群里面发消息…发一下用户问讨论的热度和提问的热度前三」。

**为什么读日志不读库**：group_msgs 只留一天（每晚复盘后 purge_group_msgs 清掉，
见 bot/kb/review.py），一周的数据在库里根本不存在。logs/bot.log* 按天轮转、留 15 天，
每一条群消息都在里面（bot.dispatcher 那行），所以这里从日志里抠。

两个榜分开算，不然两个榜一模一样：
- 讨论热度：客户之间聊的（**不含问句**）——谁在跟谁讨论什么
- 提问热度：问句——客户真正在问什么

归类按主题关键词（THEMES），一条消息只算进第一个命中的主题。不用向量：一周上千条，
按知识库条目归类时绝大多数落到 0.8 线以下，归出来的数字只有个位数，没法看。

用法（容器里跑）：
    python /app/scripts/weekly_heat.py            # 近 7 天，算完发日报群
    python /app/scripts/weekly_heat.py --no-send  # 只打印和写文件
    python /app/scripts/weekly_heat.py 14         # 近 14 天
"""
from __future__ import annotations

import asyncio
import glob
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, "/app")

LOG_DIR = Path("/app/logs")
OUT_DIR = Path("/app/data/weekly")

# 主题：业务上真正分得开的几类
THEMES = {
    "地区不可用·要开梯子": r"地区不可用|not available in your region|所在地区|地区不支持|梯子|魔法|翻墙|vpn|代理|节点|tun",
    "看不到国外模型·分组怎么选": r"看不到.{0,6}(claude|gpt|opus|国外|海外)|没有.{0,6}(claude|gpt|opus)模型|分组.{0,8}(选|没|看不到)|模型广场|海外模型|国外模型",
    "退款": r"退款|退费|退钱|申请退|能退",
    "发票·开票": r"发票|开票|开专票|普票|税号",
    "充值·套餐·价格": r"充值|余额|套餐|月卡|多少钱|价格|怎么买|购买|付费|订阅|倍率|计费|扣费",
    "配置·接口地址": r"接口地址|base.?url|配置|ccs|cc switch|导入|settings\.json|config\.toml|密钥|api key",
    "报错·连不上": r"报错|错误|error|401|403|404|429|500|502|503|504|超时|连不上|打不开|失败|掉线|断流|invalid|unauthorized",
    "慢·限流": r"很慢|太慢|慢|卡|限流|rate limit|排队|延迟",
    "封号·被封": r"封号|被封|封禁|封了|停用",
    "怎么用·教程": r"怎么用|如何使用|教程|文档|入门|新手|怎么配|怎么设置|不会用",
}
THEMES = {k: re.compile(v, re.I) for k, v in THEMES.items()}

# 这行是 dispatcher 给每条群消息打的
LINE = re.compile(r"^(\d\d-\d\d \d\d:\d\d:\d\d) INFO\s+bot\.dispatcher: 群 (\d+) \| (.+)\((\d+)\): (.*)$")
QUESTION = re.compile(
    r"[?？]|怎么|为什么|为啥|如何|怎样|能不能|可不可以|可以吗|是不是|有没有|哪里|在哪|多少|什么|"
    r"报错|失败|不行|用不了|打不开|连不上|求助|请问"
)
NOISE = re.compile(r"^\[(图片|视频|语音|表情)\]$|^[\W_]+$|^(在吗|你好|hi|hello|1|？|\?|好的|谢谢)+$", re.I)
GROUP = {2000000001: "售前4", 2000000002: "售后9", 2000000003: "售后10", 200000002: "日报群"}
TOP = 3


def norm(s: str) -> str:
    return " ".join((s or "").replace("\n", " ").split())


def keep(body: str) -> bool:
    return 4 <= len(body) <= 150 and not NOISE.search(body)


def load(days: int):
    """近 days 天的客户群消息：[(正文, 时间, 群号)]，跨天去重"""
    today = datetime.now().date()
    first = today - timedelta(days=days)
    year = datetime.now().year
    out, seen = [], set()
    for f in sorted(glob.glob(str(LOG_DIR / "bot.log*"))):
        for line in open(f, encoding="utf-8", errors="replace"):
            m = LINE.match(line.rstrip("\n"))
            if not m:
                continue
            ts, gid, _nick, _uid, body = m.groups()
            try:
                # **必须用 %Y**：写成字面的 2026 会被 strptime 当成普通字符，年份落到 1900，
                # 于是所有消息都被下面的日期过滤掉（2026-11-06 踩过，周报发出去是空的）
                day = datetime.strptime(f"{year}-{ts}", "%Y-%m-%d %H:%M:%S").date()
            except ValueError:
                continue
            if day < first or day > today:
                continue
            b = norm(body)
            if not keep(b) or b in seen:
                continue
            seen.add(b)
            out.append((b, f"{year}-{ts}", int(gid)))
    return out


def rank(msgs):
    disc, ask = defaultdict(list), defaultdict(list)
    n = 0
    for body, ts, gid in msgs:
        for name, pat in THEMES.items():
            if pat.search(body):
                (ask if QUESTION.search(body) else disc)[name].append((body, ts, gid))
                n += 1
                break
    return disc, ask, n


def top3(d):
    return [(k, len(v), v[:2]) for k, v in sorted(d.items(), key=lambda kv: -len(kv[1]))[:TOP] if v]


def render(disc, ask, total: int, days: int) -> str:
    end = datetime.now()
    span = f"{(end - timedelta(days=days)):%Y-%m-%d} ~ {end:%Y-%m-%d}"
    lines = [f"📊 近 {days} 天群里热度（{span}，客户消息 {total} 条去重后）", ""]
    for title, d in (("🔥 讨论热度前三（客户之间在聊的）", disc), ("❓ 提问热度前三", ask)):
        lines.append(title)
        rows = top3(d)
        if not rows:
            lines.append("（这周没有）")
        for i, (k, c, _s) in enumerate(rows, 1):
            lines.append(f"{i}. {k}  {c} 条")
        lines.append("")
    both = {k for k, _, _ in top3(disc)} & {k for k, _, _ in top3(ask)}
    if both:
        lines.append(f"两边都在前三的：{'、'.join(sorted(both))} —— 这块最值得做一条置顶说明")
    return "\n".join(lines).strip()


def markdown(disc, ask, total: int, days: int) -> str:
    end = datetime.now()
    span = f"{(end - timedelta(days=days)):%Y-%m-%d} ~ {end:%Y-%m-%d}"
    out = [f"# 近 {days} 天群里热度前三（{span}）", "", f"> 客户消息 {total} 条（去重）。自动生成。", ""]
    for title, d in (("讨论热度（客户之间聊的，不含问句）", disc), ("提问热度", ask)):
        out += [f"## {title}", ""]
        for i, (k, c, samples) in enumerate(top3(d), 1):
            out.append(f"### {i}. {k}（{c} 条）")
            for body, ts, gid in samples:
                out.append(f"- {ts[:10]} [{GROUP.get(gid, gid)}] {body[:80]}")
            out.append("")
    return "\n".join(out)


async def send_report(text: str) -> bool:
    from websockets.asyncio.client import connect

    from bot.config import Settings

    s = Settings.load()
    try:
        async with connect(s.onebot_url, additional_headers={"Authorization": f"Bearer {s.onebot_token}"}) as ws:
            await ws.send(json.dumps({
                "action": "send_group_msg",
                "params": {"group_id": s.report_group, "message": [{"type": "text", "data": {"text": text}}]},
                "echo": "weekly",
            }))
            while True:
                d = json.loads(await asyncio.wait_for(ws.recv(), 20))
                if d.get("echo") == "weekly":
                    ok = d.get("status") == "ok"
                    print(f"发日报群 {s.report_group}：{'成功' if ok else d}")
                    return ok
    except Exception as e:  # noqa: BLE001 —— 发不出去也不能把生成的报告弄丢
        print(f"发日报群失败：{e}")
        return False


async def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    days = int(args[0]) if args and args[0].isdigit() else 7
    send = "--no-send" not in sys.argv

    msgs = load(days)
    disc, ask, classified = rank(msgs)
    total = len(msgs)
    print(f"近 {days} 天客户消息 {total} 条（去重），归类到主题 {classified} 条")

    text = render(disc, ask, total, days)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"heat-{datetime.now():%Y-W%V}.md"
    out.write_text(markdown(disc, ask, total, days), encoding="utf-8")
    print(f"明细 → {out}")
    print("\n" + text + "\n")

    if send:
        await send_report(text)


if __name__ == "__main__":  # 别在 import 时把 main 跑了（调试时误发过一条空周报）
    asyncio.run(main())
