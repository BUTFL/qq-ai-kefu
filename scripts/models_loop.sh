#!/bin/sh
# 容器里的「每天 07:23 抓一次模型广场」。宿主机上这件事是 launchd 的 com.lingmou.models 干的，
# 容器里没有 launchd / cron，所以自己睡到点再跑，跑完接着睡。
#
# 为什么不在容器里装 cron：cron 跑的子进程拿不到 compose 给的环境变量，还得多一个守护进程。
# 这里就是 compose 的 models 服务的主进程，死了 restart: unless-stopped 会拉起来。
#
# 时间点照抄 deploy/com.lingmou.models.plist；时区靠镜像里的 TZ=Asia/Shanghai
set -u

AT_H=7
AT_M=23

cd /app || exit 1

while :; do
    now=$(date +%s)
    # 今天 07:23 的时间戳；过了就算明天的
    target=$(date -d "$(date +%F) $AT_H:$AT_M" +%s)
    [ "$target" -le "$now" ] && target=$((target + 86400))
    echo "下次抓取：$(date -d "@$target" '+%F %T')（$((target - now)) 秒后）"
    sleep $((target - now))

    # 跟 run_fetch_models.sh 同一套：抓到了再入库，日志落到 logs/models.log
    sh scripts/run_fetch_models.sh
    echo "本次抓取退出码 $?"
done
