# qq-ai-kefu

QQ 群 **AI 客服机器人**：用 [Rosmontis](https://github.com/lingr25/Rosmontis)（零注入、跑官方原版 Linux QQ、输出 OneBot v11）作协议端，接一套 Python 客服逻辑（知识库问答、自动入群审批、群公告、夜间复盘、转人工），Docker 一键部署，原生支持 **RK3588 / arm64 24 小时运行** 与**局域网访问**。

> ⚠️ 本仓库是**可配置模板**：不含任何真实密钥、账号、客户数据。配置看 [`.env.example`](.env.example)，从零部署看 [docs/HANDOFF.zh.md](docs/HANDOFF.zh.md)。

## 架构

```
  QQ 服务器
     ▲
     │ 官方协议（Rosmontis 渲染层桥接，无注入）
     ▼
 ┌───────────┐  OneBot v11 (ws)  ┌──────────┐
 │ protocol  │ ◀───────────────▶ │   bot    │  客服逻辑 + 知识库 + LLM
 │ Rosmontis │                   │ (Python) │  控制台 API :8090
 └───────────┘                   └──────────┘
   HTTP :3000                         ▲
   noVNC :6081(扫码)                   │ 局域网
                                   ┌──────┐
                                   │ lan  │ 按 LAN_IP 暴露 3000/8090
                                   └──────┘
```

## 快速开始

```bash
cp .env.example .env          # 填 QQ_ACCOUNT / ROSMONTIS_ACCESS_TOKEN / ONEBOT_TOKEN / LLM_* / ENABLED_GROUPS / SUPER_ADMINS / ADMIN_PASSWORD / VNC_PASSWD
docker compose up -d --build  # 首次构建 protocol(装官方QQ,几分钟) + bot
# 扫码登录：浏览器打开 http://127.0.0.1:6081 （noVNC，密码=VNC_PASSWD），看到 QQ 窗口用手机扫
docker compose logs -f bot    # 看机器人是否连上协议端、问答是否就绪
```

首次建议 `.env` 里 `DRY_RUN=true` 只观察不真发；稳定后改 `false`。

## 目录结构

```
qq-ai-kefu/
├─ docker-compose.yml     # 一键编排：protocol + bot + lan
├─ Dockerfile             # bot 镜像（Python 3.12，多架构）
├─ .env.example           # 配置样例（复制为 .env）
├─ protocol/              # Rosmontis 协议端（上游 MIT，见 protocol/LICENSE）
├─ bot/                   # 客服机器人源码
├─ knowledge/             # 业务知识文档（套餐/退款/限流…）
├─ data/知识库.md          # 标准答案库（示例，去敏）
├─ scripts/               # 构建/局域网代理等脚本
└─ docs/                  # 交接 + 部署 + 架构文档
```

## 文档

- [docs/HANDOFF.zh.md](docs/HANDOFF.zh.md) — **从零配置跑通的详细交接**（另一个 AI 照着能独立完成）
- [docs/deploy-rk3588.zh.md](docs/deploy-rk3588.zh.md) — RK3588 / arm64 24 小时部署
- [docs/lan-access.zh.md](docs/lan-access.zh.md) — 局域网访问
- [docs/architecture.zh.md](docs/architecture.zh.md) — 架构与模块

## 已知事项

- **知识库控制台网页**（标准答案/资料库那套管理页）原本依赖 NapCat 的 WebUI 鉴权；换 Rosmontis 后 `bot/napcat_auth.py` 需改为本地密码鉴权，详见 HANDOFF「控制台」一节。群里答问、自动审批等核心功能不受影响。
- 协议端是非官方客户端，存在被平台风控的固有风险；账号请用资料完整、有使用史的号，勿用主力号。

## 致谢

协议端基于 [lingr25/Rosmontis](https://github.com/lingr25/Rosmontis)（MIT），仅在 `protocol/` 内置其源码并保留其 LICENSE。
