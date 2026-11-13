"""把以前踢过的人从日志里捞出来，导进封禁名单：`uv run scripts/import_kicks.py [--dry-run] [--skip QQ号 …]`

封禁名单是 2026-10-09 才有的（handlers/approval.py 的 on_decrease），在那之前你踢过的人
库里没记，再申请照样能进。日志里每次踢人都有一条 `事件 notice.group_decrease … 'sub_type': 'kick'`，
从那儿捞：只认超管踢的，同一个人踢过几次只记最后一次（时间、群照日志里的）。

**已经在名单里的不动**（不会把后来手动写的备注、更新的时间盖掉）。
日志只留 14 天，再早的踢人记录捞不到。

`--skip` 跳过不想封的号（比如测试号）。容器里跑：
    docker exec qqbot-bot python scripts/import_kicks.py --dry-run
"""
from __future__ import annotations

import argparse
import ast
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot.config import Settings  # noqa: E402
from bot.store import Store  # noqa: E402

LOG_DIR = ROOT / "logs"
# 10-09 15:26:38 INFO    bot.dispatcher: 事件 notice.group_decrease: {...}
_LINE = re.compile(r"^(\d\d-\d\d \d\d:\d\d:\d\d) .*事件 notice\.group_decrease: (\{.*\})\s*$")


def kicks(log_dir: Path, admins: frozenset[int]) -> dict[int, tuple[str, int, int]]:
    """{QQ号: (踢人时间, 群号, 谁踢的)}，同一个人留最晚那次"""
    out: dict[int, tuple[str, int, int]] = {}
    for f in sorted(log_dir.glob("bot.log*")):
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            m = _LINE.match(line)
            if not m:
                continue
            try:
                raw = ast.literal_eval(m.group(2))  # 日志里是 Python 的 dict 写法（单引号），不是 JSON
            except (ValueError, SyntaxError):
                continue
            if raw.get("sub_type") != "kick" or int(raw.get("operator_id") or 0) not in admins:
                continue
            uid = int(raw.get("user_id") or 0)
            if not uid or uid == int(raw.get("self_id") or 0):
                continue
            # 日志时间不带年份，按 time 字段（unix 秒）算准的
            at = datetime.fromtimestamp(int(raw["time"])).strftime("%Y-%m-%d %H:%M:%S") if raw.get("time") else m.group(1)
            if uid not in out or at > out[uid][0]:
                out[uid] = (at, int(raw.get("group_id") or 0), int(raw["operator_id"]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列出来，不写库")
    ap.add_argument("--skip", type=int, nargs="*", default=[], help="不封的 QQ 号")
    args = ap.parse_args()

    settings = Settings.load()
    found = kicks(LOG_DIR, settings.super_admins)
    store = Store()
    try:
        added = 0
        for uid, (at, gid, op) in sorted(found.items(), key=lambda x: x[1][0]):
            if uid in args.skip:
                print(f"跳过 {uid}（--skip）")
                continue
            if store.is_banned(uid):
                print(f"已在名单里 {uid}，不动")
                continue
            print(f"{'会封' if args.dry_run else '封了'} {uid}：{at} 在群 {gid} 被 {op} 踢出")
            if not args.dry_run:
                store.ban(uid, group_id=gid, operator_id=op, source="log", at=at)
            added += 1
        print(f"\n日志里超管踢过 {len(found)} 个人，{'会新封' if args.dry_run else '新封'} {added} 个")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
