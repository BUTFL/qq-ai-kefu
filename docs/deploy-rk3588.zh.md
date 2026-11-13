# RK3588 / arm64 24 小时部署

RK3588 是 arm64，和这套完全兼容（protocol 的 Dockerfile 按架构自动装 arm64 版官方 QQ）。放家里走家宽（住宅 IP）比机房 VPS 更不易被风控。

## 1. 板子准备

- 系统：带 Docker 的 Linux（Armbian / Ubuntu for RK3588）。
- 内存：4G 起，8G 最省心（协议端跑完整 QQ + Xvfb，空闲约 500MB，长跑可能到 1–1.5G）。2G 板务必加 2–4G swap，且只跑这一套。
- 装 Docker + docker compose，并设 Docker 开机自启；compose 里已 `restart: unless-stopped`，断电来电能自己拉起来。

## 2. 国内构建提速（重要）

`protocol/docker/Dockerfile` 默认用 `ports.ubuntu.com`，国内会卡在 `fonts-noto-cjk`。换清华源：

```bash
sed -i 's@//ports.ubuntu.com/ubuntu-ports@//mirrors.tuna.tsinghua.edu.cn/ubuntu-ports@g' \
  protocol/docker/Dockerfile 2>/dev/null || true
# 若该行在 ubuntu.sources 里，构建期也可在 apt-get update 前加一句同样的 sed
```

bot 镜像的 pip 已走阿里云源（见根 `Dockerfile`），无需改。

## 3. 免重复构建（同为 arm64 可直接搬镜像）

在任一 arm64 机器构建好后，导出镜像拷到板子加载，省去在板子上重装 QQ：

```bash
# 构建机
docker save qq-ai-kefu-protocol qq-ai-kefu-bot | gzip > qqkefu-images.tgz
# 板子
gunzip -c qqkefu-images.tgz | docker load
docker compose up -d        # 直接起，不加 --build
```

## 4. 迁移（带着身份走，别当新设备）

要把已登录的号迁到板子、不重扫码：把这几样原样带过去——
- docker 卷 `protocol-qq-config`、`protocol-qq-share`
- 目录 `protocol/docker/data`

即便带了，换了机器=换了 IP，腾讯多半仍要手机验证一次，正常。**同一个号别在两处同时登。**

## 5. 稳定性

- `docker stats` 盯内存/CPU；温度高给板子加散热。
- 掉线告警：`bot/watchdog.py` 会私聊 `SUPER_ADMINS`；也可在协议端配掉线邮件。
- 别在这台板子上再挤数据库等重服务。
