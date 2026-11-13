# Rosmontis

<div align="center">

**Pure-JS · Zero Native Hook · Electron Renderer-Layer OneBot v11 Bridge for Linux QQ NT**

[![CI](https://github.com/lingr25/Rosmontis/actions/workflows/ci.yml/badge.svg)](https://github.com/lingr25/Rosmontis/actions/workflows/ci.yml)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-blue.svg)](./package.json)
[![Protocol: OneBot v11](https://img.shields.io/badge/OneBot-v11-orange.svg)](https://github.com/botuniverse/onebot-11)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](./LICENSE)

*“背负并铭记过去，带着它拥抱新生。”*

</div>

---



传统的无头 NTQQ 方案大多依赖 C++ `.so` 内存注入（`LD_PRELOAD` / `ptrace`）或对底层 `wrapper.node` 二进制进行硬补丁与短路调用。这类方案不仅伴随沉重的二进制维护负担与合规风险，更因为绕过了客户端渲染层与状态机，造成“**有包无态**（Packets without Client State）”的机械断层与原生崩溃隐患。

**Rosmontis** 选择了一条截然不同的路：
- **0 行 C/C++ 代码、0 个 `.so` 动态库、0 个第三方 npm 运行时依赖、0 字节二进制篡改**。
- 完全站在官方 Electron **渲染层（Renderer Layer）** 与标准 JS 引导层之上，沿着真实客户端的 `RM_IPCFROM_RENDERER` 官方 IPC 通道与会话状态机因果链，折射出完整的 **OneBot v11** 协议生态。

---

## 核心特性

| 维度 | 传统 C++ Hook 方案 | **Rosmontis（纯 JS 渲染层桥接）** |
| :--- | :--- | :--- |
| **注入方式** | `LD_PRELOAD` / `ptrace` / `.so` 内存劫持 | **零原生注入**，纯 JS 启动器引导 + 渲染窗口脚本桥接 |
| **二进制完整性** | 需捆绑闭源/编译补丁库 | **100% 官方原版二进制**，不分发任何专有客户端文件 |
| **调用路径** | 旁路 UI，直接裸调第 4 层 `wrapper.node` | **第 2 层渲染窗口真实 `ntApi` IPC**（`RM_IPCFROM_RENDERER`） |
| **客户端状态因果链** | 缺失窗口焦点、AIO 激活与输入态流转 | **内置会话因果状态机**：焦点 -> 进会话 -> 已读 -> 输入态 -> 发送 |
| **原型链与运行时卫生** | 永久驻留底层 Hook | **瞬态捕获后自动归还原生 `Map.prototype.set`**，标准 UUIDv4 回调 |
| **副作用安全** | 超时重试易导致重复发消息 | **副作用命令防重放保护**（已派发请求绝不跨级重放） |
| **收发图与撤回闭环** | 易遇 NTv2 图片 `400` 或野生路径 Crash | **无 `rkey` 入站图内核自动水合 + 出站 EXIF 规范化 + 真实回显 `msgId` 撤回** |
| **重启免扫码恢复** | 常需人工重新扫码 | **自动持久化 `autoLogin` 并执行 A1 快速登录恢复** |
| **运行时依赖** | 复杂 C++ 工具链与 Node 依赖树 | **零 npm 运行时依赖**（内置纯 JS RFC 6455 WebSocket 与 HTTP 服务） |

---

## 架构概览

```text
  OneBot v11 Clients (NoneBot2 / Koishi / AstrBot / SnowLuma / Custom Agent)
          ▲                     ▲                     │
          │ HTTP (:3000)        │ Forward WS (:3001)  │ Reverse WS Client
          ▼                     ▼                     ▼
+-------------------------------------------------------------------------+
| Rosmontis Main Coordinator (src/bridge_main.js + src/core/* + actions/*)|
|  - 75+ OneBot v11 Actions / Send Echo msgId Correlator / Media Hydrator |
|  - Ephemeral DI Capture (restores native Map.prototype.set once ready)  |
+-------------------------------------------------------------------------+
          │ Structured CMD/ACK IPC                     ▲
          ▼                                            │ Kernel Events
+-------------------------------------------------------------------------+
| Rosmontis Renderer Bridge (src/bridge_renderer.js in BrowserWindow)     |
|  - Causal Session State Machine (Focus -> AIO -> Read -> Typing -> Send)|
|  - Official IPC Frame: RM_IPCFROM_RENDERER{wid} / RM_IPCFROM_MAIN{wid}  |
+-------------------------------------------------------------------------+
          │                                            ▲
          ▼ Official Electron Main IPC -> wrapper.node │
+-------------------------------------------------------------------------+
| Unmodified Official Linux QQ NT Runtime (/opt/QQ/qq)                    |
+-------------------------------------------------------------------------+
```

深入技术细节（四层剖析、`Map` 跨进程保真还原、三级回退与副作用防重放、遥测诊断）请参阅 **[架构白皮书与运维指南 (`docs/architecture.md`)](./docs/architecture.md)**。

---

## 快速开始

### 方式一：Docker Compose 全新独立部署（推荐）

`docker/Dockerfile` 基于干净的 `ubuntu:24.04`，构建时直接从腾讯官方 CDN 拉取原版 Linux QQ `.deb` 包并装载 Rosmontis 纯 JS 桥接脚本，不依赖任何第三方修改版镜像：

```bash
git clone https://github.com/lingr25/Rosmontis.git
cd Rosmontis/docker

cp .env.example .env
# 按需编辑 .env 设置 ROSMONTIS_ACCESS_TOKEN、ROSMONTIS_REVERSE_WS_URL 或 VNC_PASSWD

docker compose up -d --build
```

**首次扫码登录**（无需开启 VNC 也可直接通过 API 获取二维码）：

```bash
# 获取登录二维码 Base64 PNG
curl -s -X POST http://127.0.0.1:3000/get_login_qrcode \
  -H "Content-Type: application/json" -d '{}'

# 扫码成功后检查在线状态与桥接层健康遥测
curl -s -X POST http://127.0.0.1:3000/get_status \
  -H "Content-Type: application/json" -d '{}'
```

首次扫码登录成功后，后续重启容器会自动通过本地快速登录凭据在十余秒内恢复 `online: true`，无需再次扫码。

### 方式二：Linux 宿主机原位安装（已有 `/opt/QQ`）

如果宿主机已安装官方 Linux QQ（`/opt/QQ`）：

```bash
git clone https://github.com/lingr25/Rosmontis.git
cd Rosmontis

# 安装纯 JS 桥接器（自动备份原版 package.json 与 index.js）
sudo bash scripts/install_bridge.sh

# 如需无损卸载并恢复官方原版入口：
sudo bash scripts/install_bridge.sh --uninstall
```

### 方式三：从旧容器平滑迁移（保留现有登录态免重登）

如果你已有挂载了 `/app/.config` 登录态卷的无头 QQ 容器，只需将仓库只读挂载至 `/opt/rosmontis` 并将容器 `entrypoint` 指向 `["bash", "/opt/rosmontis/scripts/entrypoint.sh"]`。入口脚本会自动清空 `LD_PRELOAD`、剥离旧原生注入器并复用现有登录态直接上线，详见 [`docs/architecture.md`](./docs/architecture.md)。

---

## 配置说明

Rosmontis 支持**零配置开箱即用**、**环境变量配置**与 **JSON 配置文件**（原生支持 `rosmontis.json` / `rosmontis_<uin>.json`，同时无缝兼容旧版 `onebot.json` / `onebot_<uin>.json`）。

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ROSMONTIS_HTTP_PORT` / `ONEBOT_HTTP_PORT` | `3000` | OneBot v11 HTTP API 监听端口 |
| `ROSMONTIS_WS_PORT` / `ONEBOT_WS_PORT` | `3001` | OneBot v11 正向 WebSocket 监听端口 |
| `ROSMONTIS_REVERSE_WS_URL` / `ONEBOT_REVERSE_WS_URL` | *(空)* | 反向 WebSocket 目标地址（如 `ws://127.0.0.1:8080/onebot/v11/ws`） |
| `ROSMONTIS_ACCESS_TOKEN` / `ONEBOT_ACCESS_TOKEN` | *(非回环自动生成)* | Bearer 鉴权 Token（绑定非回环地址且留空时，Protected Mode 自动生成 256-bit 随机 Token 并输出至日志） |
| `ROSMONTIS_HOST` / `ONEBOT_HOST` | `0.0.0.0` | HTTP / 正向 WS 绑定地址（宿主机单机部署推荐 `127.0.0.1`） |
| `ROSMONTIS_COMPAT_PROFILE` / `ONEBOT_COMPAT_PROFILE` | `rosmontis` | 下游兼容画像（可选 `snowluma` / `napcat`，亦可在各网络端点单独配置 `compatProfile`） |
| `ROSMONTIS_ENABLE_WEB_CREDENTIAL_API` | `0` | 设为 `1` 时显式开启 `get_cookies` / `get_clientkey` / QZone 等高敏凭据接口（默认关闭） |
| `ROSMONTIS_CONFIG_DIR` | `/app/data/config` | 配置文件搜索目录（详见 [`config/rosmontis.example.json`](./config/rosmontis.example.json)） |
| `ROSMONTIS_DISABLE` | `0` | 设为 `1` 时一键跳过桥接器加载，原样启动官方 QQ |

### 下游框架与插件兼容

Rosmontis 默认原生兼容 **NoneBot2**、**Koishi**、**AstrBot** 等标准 OneBot v11 框架（内置 `.handle_quick_operation` / `.handle_quick_operation_async` 快速操作、单端点 `messageFormat: "array" | "string"` 切换、消息段顶层简写、动画表情 `resultId` 往返、直传 `node` 合并转发及群务扩展字段）。

针对部分在握手或插件启动时硬编码校验 `get_version_info.app_name` 的特定生态 SDK（如 **SnowLuma** 插件生态或基于 **NapCat** 专属适配器的插件），可通过环境变量 `ROSMONTIS_COMPAT_PROFILE` 或在 `rosmontis.json` 的全局 / 单个网络端点上按需开启兼容画像（响应中仍保留 `bridge_name: "Rosmontis"` 供运维识别）：

- `rosmontis`（默认）：返回标准身份 `app_name: "Rosmontis"`
- `snowluma`：对齐 SnowLuma 插件生态身份与状态结构（`app_name: "SnowLuma"`）
- `napcat`：对齐 NapCat 下游适配器版本标识（`app_name: "NapCat.Onebot"`）

---

## 已实现的 OneBot v11 接口（75+ Actions）

- **账号、登录与诊断**：`get_login_info`, `get_status`, `get_version_info`, `get_login_qrcode`, `quick_login`, `can_send_image`, `can_send_record`, `clean_cache`, `set_online_status`, `set_diy_online_status`, `set_qq_profile`, `set_self_longnick`
- **消息收发与富媒体**：`send_private_msg`, `send_group_msg`, `send_msg`, `delete_msg`, `get_msg`, `.handle_quick_operation`, `get_group_msg_history`, `get_friend_msg_history`, `get_forward_msg`, `send_group_forward_msg`, `send_private_forward_msg`, `forward_friend_single_msg`, `forward_group_single_msg`（完整支持文本、表情与动画 `resultId`、`@`、回复、图片 `base64://`/`file://`/`http(s)://`、语音、视频、文件、链接分享 `share`、JSON 卡片简写与合并转发）
- **拟人交互与表态**：`mark_msg_as_read`, `mark_private_msg_as_read`, `mark_group_msg_as_read`, `set_input_status`, `send_poke`, `group_poke`, `friend_poke`, `set_msg_emoji_like`, `get_msg_emoji_likes`, `fetch_custom_face`
- **好友与群组信息**：`get_friend_list`, `get_stranger_info`, `send_like`, `delete_friend`, `get_group_list`, `get_group_info`, `get_group_info_ex`, `get_group_share_link`, `get_group_member_info`, `get_group_member_list`, `get_group_honor_info`, `get_group_at_all_remain`, `get_group_shut_list`
- **群务管理与申请处理**：`set_group_ban`, `set_group_whole_ban`, `set_group_kick`, `set_group_leave`, `set_group_name`, `set_group_remark`, `set_group_card`, `set_group_special_title`, `set_group_admin`, `_send_group_notice`, `_get_group_notice`, `set_essence_msg`, `delete_essence_msg`, `get_essence_msg_list`, `get_group_system_msg`, `get_doubt_friends_add_request`, `set_group_add_request`, `set_friend_add_request`, `set_doubt_friends_add_request`
- **群文件与私聊文件**：`get_group_root_files`, `get_group_files_by_folder`, `get_group_file_system_info`, `get_group_file_url`, `get_private_file_url`, `upload_group_file`, `upload_private_file`, `create_group_file_folder`, `delete_group_file`, `delete_group_folder`, `move_group_file`, `rename_group_file`, `rename_group_file_folder`
- **Web 凭据与空间扩展（默认关闭，需显式开启 `ROSMONTIS_ENABLE_WEB_CREDENTIAL_API=1`）**：`get_cookies`, `get_csrf_token`, `get_credentials`, `get_clientkey`, `get_qzone_msg_list`, `get_qzone_feeds`, `send_qzone_msg`, `delete_qzone_msg`, `like_qzone`, `unlike_qzone`, `comment_qzone`

---

## 开发与测试

本项目包含完整的协议契约、安全边界与模拟 Electron 渲染窗口/主进程的端到端测试套件（34 组测试，零外部依赖）：

```bash
npm test
```

---

## 免责声明与合规说明

1. **纯净互操作研究**：本仓库仅包含原创的纯 JavaScript 协议桥接与自动化脚本代码，**不包含、不分发任何腾讯专有二进制程序、解包资源、密钥或逆向破解补丁**。
2. **合法合规使用**：本项目仅供个人学习 Electron 跨进程通信架构与 OneBot 标准协议互操作性研究使用。请严格遵守所在地区法律法规及软件服务条款，切勿用于垃圾信息发送、群控骚扰或任何违法违规用途。使用者需自行承担不当使用带来的一切风险与责任。

---

## License

Released under the [MIT License](./LICENSE).
