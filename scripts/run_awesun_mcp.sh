#!/bin/sh
# 向日葵 MCP 服务端（HTTP 模式）—— 给跑在容器里的机器人当远控出口。
#
# **为什么需要这一层**（2026-10-16 实测得出）：
# `awesun-mcp-server` 是 macOS 二进制，跑不进 Linux 容器；而机器人本体在容器里。
# 所以把它跑在宿主机上，容器通过 `host.docker.internal` 连过来。
# 实测依据：宿主机 127.0.0.1 上监听的 8908（向日葵客户端），容器里
# `host.docker.internal:8908` 连得上 —— Docker Desktop 的 host.docker.internal
# 会转发到宿主机的回环口，**不需要**把服务绑到 0.0.0.0 暴露到局域网。
#
# 谁启动我：~/Library/LaunchAgents/com.lingmou.awesun-mcp.plist（开机自启、崩了自动拉）。
# 谁连我：机器人容器（见 docker-compose.yml 的 bot.environment 里 REMOTE_TRANSPORT/AWESUN_MCP_URL）。
#
# 手工查：launchctl print gui/$UID/com.lingmou.awesun-mcp | head -30
# 日志：logs/awesun-mcp.log
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

BIN="/Applications/AweSun.app/Contents/Helpers/awesun-mcp-server"
if [ ! -x "$BIN" ]; then
    echo "$(date '+%F %T') ❌ 找不到 $BIN —— 向日葵客户端装了没？"
    exit 1
fi

# 从 .env 里抠这两个值。**不要把 .env 整个 source 进来**：里面有别的变量，
# 而且 source 会把带空格/特殊字符的值炸开（这个坑 run_bot.sh 那些脚本都避开了）
URL=$(grep -E '^AWESUN_API_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)
TOKEN=$(grep -E '^AWESUN_API_TOKEN=' .env 2>/dev/null | tail -1 | cut -d= -f2-)
PORT=$(grep -E '^AWESUN_MCP_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2-)
[ -n "$URL" ] || URL="http://127.0.0.1:8908"
[ -n "$PORT" ] || PORT=8912

if [ -z "$TOKEN" ]; then
    echo "$(date '+%F %T') ❌ .env 里 AWESUN_API_TOKEN 是空的，起不了。"
    echo "   去向日葵客户端 →侧边栏「向日葵MCP」→ 复制 API Token，填进 .env"
    exit 1
fi

# **只绑回环**。这是能把客户电脑点着的口子，绝不能绑 0.0.0.0 暴露到局域网；
# 容器要走它，靠 host.docker.internal 转发（见文件头）。
echo "$(date '+%F %T') 启动 AweSun MCP（HTTP）→ 127.0.0.1:${PORT}（客户端 API ${URL}）"
AWESUN_API_URL="$URL" AWESUN_API_TOKEN="$TOKEN" \
    exec "$BIN" -transport streamable_http -host 127.0.0.1 -port "$PORT"
