# 架构与模块

## 三个服务

| 服务 | 职责 | 关键端口 |
|---|---|---|
| **protocol**（Rosmontis） | 跑官方原版 Linux QQ，零注入渲染层桥接，对外输出 OneBot v11 | HTTP `3000` / OneBot WS `3001` / noVNC `6081` |
| **bot**（Python） | 客服逻辑：问答、入群审批、群公告、夜间复盘、转人工 | 控制台 API `8090` |
| **lan**（可选） | 把 `3000`/`8090` 按 `LAN_IP` 暴露给局域网 | `LAN_IP:3000/8090` |

## 数据流

```
QQ 服务器 ──► Rosmontis(protocol) ──OneBot v11 ws──► bot.onebot ──► bot.dispatcher
                                                                      │
                            ┌─────────────────────────────────────────┤
                            ▼                 ▼                ▼       ▼
                     handlers/qa      handlers/approval  handlers/welcome  handlers/dm …
                            │
                            ▼  检索+LLM
                     kb/retrieve ─► kb/llm ─► 回复 ──► bot.onebot ──► Rosmontis ──► QQ
```

## bot 模块速览（`bot/`）

- **接入层**：`onebot.py`（连协议端、收发）、`events.py`（事件解析）、`dispatcher.py`（分发）、`napcat_auth.py`（控制台鉴权，换 Rosmontis 后需改，见 HANDOFF §6）。
- **handlers/**：`qa.py`（问答主流程）、`approval.py`（入群申请审批）、`welcome.py`（欢迎语）、`dm.py`（私聊/临时会话）、`health.py`（在线/掉线事件）、`listen.py` `relay.py` `admin.py` `adwatch.py`。
- **kb/**（知识库）：`store.py`（标准答案库，读 `data/知识库.md`）、`retrieve.py`（向量检索）、`llm.py`（模型调用）、`ingest.py`/`docwatch.py`（资料入库）、`review.py`（夜间复盘起草）、`learn_chat.py`/`teach.py`（学习/教）、`backup.py`（备份）。
- **其它**：`admin_web.py`（控制台 8090 API）、`watchdog.py`（掉线私聊超管）、`commands.py`（群内管理指令 `/采纳` `/复盘` 等）、`config.py`（读 `.env`）、`handoff.py`（转人工）、`announce.py`（群公告）、`remote/`（可选远程协助，默认关）。

## 配置与数据

- 配置：`.env` → `bot/config.py`（真实环境变量优先于 `.env`，compose 里对 `ONEBOT_URL` 等做了覆盖）。
- 数据：`data/知识库.md`（标准答案）、`knowledge/*.md`（业务资料）、`logs/`（日志）、`backup/`（复盘备份）。
- 协议端状态：docker 卷 `protocol-qq-config`/`protocol-qq-share` + `protocol/docker/data`（设备身份+登录态）。
