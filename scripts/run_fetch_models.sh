#!/bin/sh
# launchd 每天抓一次模型广场用的包装脚本。照 run_bot.sh 的路子写：
# launchd 给的环境几乎是空的，PATH 里没有 uv，工作目录也不是项目目录，
# 所以这里自己 cd、自己写绝对路径。
#
# 抓完接着跑 ingest：清单没变的话 ingest 按 sha1 跳过，不会重算向量，
# 只多花一次自检的调用。机器人不用重启 —— 检索器每次提问都看库里的 revision，
# 变了自己重建索引（bot/kb/retrieve.py 的 _ensure）。
#
# 抓失败**不弹通知**：广场偶尔抽一下很正常，旧清单还在库里，第二天会自己补上。
# 只有「能打开但解析不出东西」（退出码 2，多半是改版了）才喊人——那种不会自己好。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV=$(command -v uv) || UV=
# 容器里（models_loop.sh 调过来）没装 uv，依赖已经装进系统 python，直接用 python
if [ -n "$UV" ]; then PY="$UV run"; else PY=python; fi

cd "$ROOT" || exit 1
mkdir -p logs
LOG="$ROOT/logs/models.log"

echo "===== $(date '+%Y-%m-%d %H:%M:%S') 开抓 =====" >>"$LOG"
# 套餐价格页（2026-09-28 加的，见 scripts/fetch_plans.py）。**失败不影响模型广场**：
# 它挂了旧的 plans.md 还在库里，第二天再抓；下面的 ingest 照常跑
$PY scripts/fetch_plans.py >>"$LOG" 2>&1 || echo "fetch_plans.py 退出码 $?" >>"$LOG"
# 按量分组倍率（2026-09-28 晚上加的，见 scripts/fetch_rates.py）。同上，失败不影响后面
$PY scripts/fetch_rates.py >>"$LOG" 2>&1 || echo "fetch_rates.py 退出码 $?" >>"$LOG"
$PY scripts/fetch_models.py >>"$LOG" 2>&1
code=$?

if [ "$code" -eq 0 ]; then
    $PY -m bot.kb.ingest >>"$LOG" 2>&1
    icode=$?
    [ "$icode" -eq 0 ] || echo "ingest 没跑成，退出码 $icode" >>"$LOG"
    exit 0
fi

echo "fetch_models.py 退出码 $code" >>"$LOG"

# 容器里没有 osascript，那边只记日志（logs/models.log 挂在宿主机上）
if [ "$code" -eq 2 ] && [ -x /usr/bin/osascript ]; then
    /usr/bin/osascript -e 'on run argv
display notification (item 1 of argv) with title (item 2 of argv) sound name "Basso"
end run' "模型广场解析不出东西，多半是页面改版了。旧清单没动，看 logs/models.log。" "灵眸助手" >/dev/null 2>&1
fi

exit $code
