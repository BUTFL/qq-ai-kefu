# 项目背景

## 定位与技术约束

- **Rosmontis（迷迭香）** 是面向官方 Linux QQ NT 的纯 JavaScript OneBot v11 协议桥接器。
- 核心技术边界：**0 行 C/C++ 代码、0 个原生 `.so` / `LD_PRELOAD` / `ptrace` Hook、0 个第三方 npm 运行时依赖**（仅使用 Node.js `>=18` 与 Electron 内置模块），通过官方渲染层 IPC（`RM_IPCFROM_RENDERER` / `RM_IPCFROM_MAIN`）与客户端会话因果状态机收发事件和调用内核能力。

## 与小晓（`little_xiao`）的关系

- 本项目最初由小晓仓库（本机同级目录 `D:\Desktop\litte_xiao` 下的 `deploy/ntqq_renderer_bridge/`）孵化并独立开源。
- 现阶段 **Rosmontis 作为通用开源项目独立演进，同时充当小晓 QQ 接入层的唯一上游（Single Source of Truth）**：
  - 需保持对通用第三方 OneBot v11 客户端（AstrBot、NoneBot2、Koishi 等）的标准协议兼容；
  - 同时保留对小晓运行环境的向后兼容（包括 `XIAO_BRIDGE_*` 旧环境变量别名，以及小晓跨容器共享媒体挂载目录 `/opt/xiao-data`）。

## 目录结构与测试入口

- `src/app_launcher_index.js`：Linux QQ `app_launcher` 纯 JS 引导入口
- `src/bridge_main.js`：Electron 主进程精简协调器，组合核心子系统与 OneBot v11 动作分发路由
- `src/bridge_renderer.js`：注入 `BrowserWindow` 渲染层的受信任 IPC 桥接与客户端会话状态机
- `src/types.js` & `jsconfig.json`：零编译开销的 JSDoc 协议与内部运行时类型契约及 IDE 检查配置
- `src/bridge_onebot.js`：OneBot v11 协议与富媒体转换统一门面导出，底层拆分为 `src/onebot/`（4 个高内聚子模块）：
  - `stores.js`：有界 LRU 31-bit 消息 ID 映射（`MessageIdStore`）与 UIN/UID 双向索引缓存（`UinUidStore`）
  - `cq_codec.js`：CQ 码转义/反转义与 OneBot v11 消息段/字符串双向归一化编解码
  - `segment_converter.js`：NTQQ 内核 `elements` 与 OneBot v11 消息段双向转换及富媒体路径解析
  - `event_formatter.js`：NTQQ 消息、灰条通知、群文件上传、好友/加群请求与元事件格式化器
- `src/core/`：零依赖核心子模块（17 个）：
  - `env.js`：`ROSMONTIS_*` / `ONEBOT_*` / `XIAO_BRIDGE_*` 多前缀环境变量统一解析器
  - `primitives.js`：有界 LRU `BoundedMap`、TTL 去重集（`TtlDedupeSet`）、临时文件清理环（`TempCleanupQueue`）、一次性事件等待器、限流日志（`BridgeLogger`）、跨进程 `Map`/`void` 无损编解码与声明式动作路由器（`createActionRouter`）
  - `nt_normalizer.js`：NTQQ 多版本内核数据结构防腐层（Peer、群摘要、好友资料、群成员、登录身份与正整数 UIN 强校验）
  - `echo_correlator.js`：出站 `sendMsg` 与异步 `onAddSendMsg` 真实 64-bit `msgId` 签名匹配关联器（`EchoCorrelator`）
  - `session_controller.js`：独立人类会话因果控制器（`HumanSessionController`，统筹渲染层钩子、跨进程指令回退、已读/输入去重与两级空闲退场）
  - `session_scheduler.js`：会话级亲和公平互斥锁、AIO 切换冷却、已读→输入抖动与私聊延迟响应调度器（`CausalSessionScheduler`）
  - `nt_capture.js`：`Map.prototype.set` / `Module._load` 瞬态无痕捕获与 V8 原生原型链自动归还
  - `renderer_ipc.js`：渲染窗口注入、受信任 IPC 鉴权、三级 `invokeNt` 调度与防重复发送保护
  - `inbound_pipeline.js`：内核事件监听（消息、群通知、好友/加群请求、富媒体水合）与入站事件分发管线
  - `outbound_pipeline.js`：两阶段出站发送管线（锁外富媒体准备 + 会话激活、`sendMsg` 派发与回显关联）
  - `server_runtime.js`：内置 HTTP API、正向 WebSocket、反向 WebSocket 客户端重连与心跳/事件广播运行时
  - `ws_rfc6455.js`：RFC 6455 WebSocket 编解码、掩码校验、负载上限与反向 WS 客户端
  - `transport_security.js`：恒定时间鉴权、`Origin` 校验、非回环地址受保护模式（Protected Mode）自动鉴权与 HTTP 请求体上限
  - `media_security.js`：媒体源 SSRF 防护、本地目录白名单校验与临时文件生命周期管理
  - `config.js`：多路径 JSON 配置与环境变量加载器
  - `web_http.js`：受限腾讯域重定向校验的 HTTPS Cookie / HTTP 文本与 JSONP 工具
  - `qzone_actions.js`：默认关闭（`enableWebCredentialApi` 显式门控）的 Web 凭据提取与 QQ 空间（QZone）动作模块
- `src/actions/`：OneBot v11 动作域处理子模块（4 个）：
  - `message_actions.js`：登录/状态查询、私聊与群聊收发、合并转发、历史记录、已读标记、表情回应与戳一戳动作
  - `contact_actions.js`：好友列表、陌生人资料、好友备注/删除、好友分组与加好友请求处理动作
  - `group_actions.js`：群列表/群资料/群成员查询、踢人/禁言/管理员/头衔/精华消息与入群请求管理动作
  - `file_media_actions.js`：群文件与私聊文件上传下载、图片/语音/文件解析、OCR/语音转文字、个人资料状态与 Ark 卡片分享动作
- `scripts/` & `docker/`：无头 Linux QQ 容器构建（官方 `.deb` 拉取）、`Xvfb` 启动与桥接安装脚本
- `test/`：零依赖契约与端到端模拟测试套件，直接运行 `npm test` 验证
