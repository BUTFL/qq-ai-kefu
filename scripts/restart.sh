#!/usr/bin/env bash
# 重启机器人：**先优雅停、再起**，不要用 docker restart / docker compose restart。
#
# 为什么：docker restart 到时间会 SIGKILL，SQLite 可能正写着一半。
# 2026-10-20 16:08 就是这样把 data/qa.db 写坏了（文件头全 0，容器起不来），
# 最后用当天凌晨的备份恢复，丢了约 16 小时的问答流水。
# 2026-10-16 也坏过一次，当时换了 WAL；WAL 只保证主库不出现坏页，
# 挡不住「整个文件被截断/清零」这类挂载层问题，所以停机方式还得对。
#
# 用法：
#   ./scripts/restart.sh              # 停 30 秒再起
#   STOP_TIMEOUT=60 ./scripts/restart.sh   # 给更多收尾时间
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-qqbot-bot}"
TIMEOUT="${STOP_TIMEOUT:-30}"

echo "== 停止 ${NAME}（最多等 ${TIMEOUT}s，让它把数据库写完）=="
docker stop -t "${TIMEOUT}" "${NAME}" >/dev/null || true

echo "== 启动 ${NAME} =="
docker start "${NAME}" >/dev/null

echo "== 等它起来 =="
for _ in $(seq 1 30); do
    sleep 1
    if docker exec "${NAME}" true >/dev/null 2>&1; then break; fi
done
sleep 3

docker ps --format '{{.Names}}\t{{.Status}}' | grep "^${NAME}" || echo "（容器没起来，看下面日志）"
echo "== 最近日志 =="
docker logs --tail 8 "${NAME}" 2>&1 | cut -c1-160
