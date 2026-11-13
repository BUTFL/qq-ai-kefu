# 交接文档 · 从零配置跑通 qq-ai-kefu

> 面向「另一个 AI / 工程师」：照本文从零把这套 QQ AI 客服跑起来。按顺序做，每步都有验证点。
> 整套 = **protocol（Rosmontis 协议端，连 QQ）** + **bot（Python 客服逻辑）** + **lan（局域网入口，可选）**，由根目录 `docker-compose.yml` 一键编排。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 宿主机 | 装了 Docker + docker compose 的 Linux / macOS；长期 24h 建议国内网络、直连（见第 7 节风控） |
| QQ 号 | 一个**资料完整、有使用史、非主力**的号（机器人用）。首次要用它的手机扫码 |
| 大模型 | 一个 OpenAI 兼容网关地址 + API Key（问答用）+ 一个向量(embedding)模型 |
| 架构 | x86_64 或 arm64 均可；RK3588 等 arm64 板子原生支持（见 `deploy-rk3588.zh.md`） |
| 内存 | ≥2G（协议端跑的是完整 QQ + Xvfb），稳定建议 4G |

---

## 1. 配置 `.env`（最关键）

```bash
cp .env.example .env
```

逐项填（`[必填]` 的必须给值）：

- `QQ_ACCOUNT` [必填]：机器人 QQ 号。
- `ROSMONTIS_ACCESS_TOKEN` [必填]：协议端鉴权 token。随机生成：`openssl rand -hex 24`。
- `ONEBOT_TOKEN` [必填]：**必须和 `ROSMONTIS_ACCESS_TOKEN` 填成同一个值**（bot 用它连协议端）。
- `VNC_PASSWD`：随便设一个（如 `scan1234`），用于扫码桌面 noVNC 登录。
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` [必填]：主问答模型（OpenAI 兼容）。
- `EMBEDDING_MODEL` [必填]：向量模型名（检索知识库用）。
- `LLM_CHAT_*`：可留空，留空则复用主模型。
- `ENABLED_GROUPS` [必填]：机器人负责的群号，逗号分隔。群号获取：机器人进群后看群资料，或在协议端用 `get_group_list`。
- `SUPER_ADMINS` [必填]：超管 QQ 号（接收掉线告警、私聊管理），逗号分隔。
- `ADMIN_PASSWORD` [必填]：知识库控制台登录密码。
- `REPORT_GROUP` / `REPORT_AT`：夜间复盘结果发到哪个群、几点（可留空关闭）。
- `DRY_RUN`：**首次上线填 `true`**（只记录不真发，观察是否答得对），稳定后改 `false`。
- `LAN_IP`：要局域网访问才填这台机器的局域网 IP（如 `192.168.1.10`），不填=仅本机。
- `NAPCAT_UID` / `NAPCAT_GID`：容器内运行用户，Linux 一般 `1000`，按 `id -u`/`id -g` 填宿主当前用户更稳。

**验证点**：`.env` 存在、`ROSMONTIS_ACCESS_TOKEN == ONEBOT_TOKEN`、LLM 三项和 EMBEDDING 都非空。

---

## 2. 起服务

```bash
docker compose up -d --build
```

首次会构建两个镜像：`protocol`（基于 ubuntu 装官方原版 QQ，几分钟）和 `bot`（Python）。

- **国内构建卡在 `fonts-noto-cjk`**：`ports.ubuntu.com` 国际源对国内抽风。解决见 `deploy-rk3588.zh.md`（把 `protocol/docker/Dockerfile` 的源换成清华源）。
- **验证点**：`docker compose ps` 三个容器（qqkefu-protocol / qqkefu-bot，lan 可选）都 Up；`docker compose logs protocol` 到「等待扫码」。

---

## 3. 扫码登录（协议端连上 QQ）

浏览器打开 **http://127.0.0.1:6081**（noVNC），输 `VNC_PASSWD`，看到容器里的 QQ 登录窗口 → **用机器人号的手机扫码**。

- 也可用 API 取码：`curl -s -X POST http://127.0.0.1:3000/get_login_qrcode -H "Authorization: Bearer <ROSMONTIS_ACCESS_TOKEN>" -H 'Content-Type: application/json' -d '{}'`（返回里是 base64 PNG）。
- **新设备首次登录腾讯可能要手机验证**，在手机上过一下即可。
- 登录成功后重启容器会自动快速登录，不用再扫。
- **验证点**：`curl -s -X POST http://127.0.0.1:3000/get_status -H "Authorization: Bearer <token>" -d '{}'` 返回 `"online":true`。

---

## 4. 验证机器人跑通

```bash
docker compose logs -f bot
```

看到类似：`已连接 ws://protocol:3001，登录账号 <QQ_ACCOUNT>`、`AI 问答已启用 | 标准答案 N 条`、`中转站自检：对话…通，embedding…通` 即正常。

**端到端测试**：把机器人拉进一个测试群（群号加进 `ENABLED_GROUPS` 并 `docker compose restart bot`），在群里 `@机器人` 问一句知识库能答的问题，看它是否回复。

---

## 5. 知识库（答案从哪来、怎么维护）

- **主答案库**：`data/知识库.md`（仓库内是**去敏示例**，替换成你自己的）。bot 启动时从它反向加载标准答案（`bot/kb/store.py`）。
- **业务文档**：`knowledge/*.md`（套餐 `plans.md`、退款 `refund.md`、限流等），作为资料块参与检索。
- **群内维护指令**（`bot/commands.py`）：在群里/私聊超管用 `/教`、`/采纳`、`/复盘` 等增改答案。
- **夜间复盘**（`bot/kb/review.py`）：每天 `REPORT_AT` 自动从当天对话起草新答案，你审过才进库。
- 改完 `data/知识库.md` 后 `docker compose restart bot` 重载。

---

## 6. 自动入群审批 & 控制台

**自动入群审批**：机器人**必须是该群的管理员**（群主在手机 QQ 里设），否则收不到入群申请事件、也批不了。逻辑在 `bot/handlers/approval.py`。

**知识库控制台（管理网页）** —— 现状与改造（重要）：
- `bot` 的 `8090` 只提供**后端 API**（`/api/*`），**没有网页**。
- 原来的管理页面是 NapCat WebUI 的前端，换成 Rosmontis 后没有它了，且 `bot/napcat_auth.py` 当前是把浏览器凭证转发给 NapCat 的 `/api/auth/check` 校验——Rosmontis 没有这个接口，所以控制台 API 会返回 401。
- **两种处理**：
  1. **改本地鉴权**（推荐）：把 `bot/napcat_auth.py` 改成校验 `.env` 的 `ADMIN_PASSWORD`（不再依赖协议端），并给控制台配一个独立登录页/静态前端指向 `8090`；
  2. **暂不用网页**：用第 5 节的 QQ 指令管理知识库，功能不缺，只是没有表格界面。
- 群里答问、自动审批、复盘等**核心功能不依赖控制台**，不受影响。

---

## 7. 上线节奏 & 风控注意

- **暖机**：`DRY_RUN=true` 先观察几小时 → 确认答得对 → 改 `false`；头 1–3 天只收不发，再逐步开审批/欢迎语。
- **号**：资料完整、有使用史、非主力号；别把机器人号在手机/电脑端**双端同时登**（会互踢）。
- **网络**：QQ 流量直连，别走代理出境、别频繁换 IP；国内机器最佳。
- **掉线**：`bot/watchdog.py` 掉线会私聊 `SUPER_ADMINS`。掉了先看手机端那个号是否也被风控（是→账号问题，考虑换号）。
- 协议端是非官方客户端，存在平台风控的固有风险，不能根治、只能降低。

---

## 8. 常用运维

```bash
docker compose logs -f bot            # 看机器人日志
docker compose restart bot            # 改 .env / 知识库后重载（不动协议端，不用重扫码）
docker compose restart protocol       # 重启协议端（登录态在时自动快速登录）
docker compose down                   # 停全部
docker compose up -d                  # 起全部
```

- 备份：`backup/` 目录（夜间复盘自动备份知识库），仓库外再留一份更稳。
- 换号：改 `.env` 的 `QQ_ACCOUNT`，清空协议端登录态卷（`docker volume rm qq-ai-kefu_protocol-qq-config`）后重新扫码。

---

## 9. 故障排查

| 现象 | 查 |
|---|---|
| bot 日志一直「重连」 | 协议端没 online（没扫码/被踢）；先 `get_status` 看 online |
| 扫码桌面打不开 | `VNC_PASSWD` 没设；或 6081 没映射；`docker compose logs protocol` |
| 群里 @ 不回 | 群号在 `ENABLED_GROUPS` 吗？`DRY_RUN` 是不是 true？LLM 自检过了吗 |
| LLM 报错 | `LLM_BASE_URL/API_KEY/MODEL` 填对没；网关通不通 |
| 控制台 8090 返回 401 | 见第 6 节，`napcat_auth` 需改本地鉴权 |
| 构建卡 fonts-noto-cjk | 换国内 apt 源，见 `deploy-rk3588.zh.md` |

---

模块与架构细节见 [architecture.zh.md](architecture.zh.md)；RK3588 24h 与局域网分别见 [deploy-rk3588.zh.md](deploy-rk3588.zh.md) / [lan-access.zh.md](lan-access.zh.md)。
