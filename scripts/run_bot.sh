#!/bin/sh
# launchd 起机器人用的包装脚本。
#
# 为什么不让 launchd 直接跑 `uv run -m bot`：launchd 给的环境几乎是空的，
# PATH 里没有 uv，工作目录也不是项目目录。所以这里自己 cd、自己写绝对路径。
#
# 第二个作用：进程**非 0 退出**时弹一条通知。看门狗（bot/watchdog.py）是跑在
# 进程里面的，进程本身死了它就跟着死了——那种情况只能由外面这层来喊。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV=$(command -v uv) || UV=uv

cd "$ROOT" || exit 1
"$UV" run -m bot
code=$?
[ "$code" -eq 0 ] && exit 0

case "$code" in
    2) why="配置错了，看 .env" ;;
    3) why="已经有一个在跑了" ;;
    1) why="令牌被拒或连接异常结束" ;;
    *) why="退出码 $code" ;;
esac

# 令牌配错这种问题会让它每 60 秒重试一次、永远好不了。不限流的话就是
# 每分钟一条一模一样的通知，弹到第三条人就再也不看通知了。十分钟最多一条。
mkdir -p "$ROOT/logs"
STAMP="$ROOT/logs/.last_exit_notice"
now=$(date +%s)
last=0
[ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null || echo 0)

if [ $((now - last)) -ge 600 ]; then
    echo "$now" >"$STAMP"
    # `${why}` 的花括号不能省。变量名后面紧跟全角标点时，sh 会把「。」的头一个字节
    # 当成变量名的一部分，凑出个 why<乱码> —— set -u 下就是 unbound variable，整个
    # 脚本当场中止。原先写的是 `$why。`，后果是：上面那行时间戳已经写进去了，通知却
    # 一条没发，还白占掉十分钟的静默窗口；退出码也从真实的 2/3 变成 1。
    # 也就是说这个文件第 7 行自称的「第二个作用」从来没生效过。（2026-09-24 修）
    /usr/bin/osascript -e 'on run argv
display notification (item 1 of argv) with title (item 2 of argv) sound name "Basso"
end run' "机器人停了：${why}。60 秒后自动重试。" "灵眸助手" >/dev/null 2>&1
fi

exit $code
