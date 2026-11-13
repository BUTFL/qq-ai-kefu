# Rosmontis 架构白皮书与运维指南

本文档详细阐述 **Rosmontis**（纯 JavaScript、零原生内存 Hook 的 Linux QQ NT 渲染层 OneBot v11 桥接器）的客户端四层剖析、因果状态机设计、核心工程细节与容器化运维方案。

---

## 1. Linux QQ NT 四层运行时结构

官方 Linux 版 QQ NT（Electron + Vue 3 + `wrapper.node`）在运行时自顶向下分为四个层级：

```text
+-----------------------------------------------------------------------------------+
| 第 1 层：X11 / Wayland 与 Chromium 窗口合成层                                     |
|   - Xvfb (:99) 虚拟帧缓冲、D-Bus 总线、窗口焦点与渲染树                           |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 第 2 层：Electron 渲染层（Renderer / BrowserWindow.webContents）                  |
|   - Vue 3 应用（#app.__vue_app__）、路由与会话状态机                              |
|   - preload.js 暴露 ipcRenderer / webContentId                                    |
|   - 官方双向 IPC 通道：RM_IPCFROM_RENDERER{windowId} / RM_IPCFROM_MAIN{windowId}  |
|   - 命名空间：eventName: "ntApi"（携带 peerId: windowId 与 RFC 4122 v4 UUID）     |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 第 3 层：Electron 主进程（Main Process）                                          |
|   - major.node 加载主进程入口                                                     |
|   - InversifyJS 依赖注入容器（管理 ntApi、ntStore、会话与生命周期）               |
|   - 客户端自身遥测、性能监控与日志管线                                            |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 第 4 层：wrapper.node 原生核心与 MSF 发包层                                       |
|   - NodeIQQNTWrapperSession（MsgService / GroupService / BuddyService / RichMedia）|
|   - 本地 SQLite 数据库、富媒体缓存与长连接通道                                    |
+-----------------------------------------------------------------------------------+
```

### 1.1 为什么“旁路第 1~3 层、直插第 4 层”是一条死胡同

早期基于 `LD_PRELOAD`、C++ `.so` 注入、`ptrace` 附加或篡改 `wrapper.node` 内存的方案，普遍绕过前 3 层直接调用第 4 层 C++ 接口，不仅在分发编译产物与二进制补丁时面临严峻的合规问题，还会造成严重的客户端状态割裂（“有包无态”）：

1. **缺失会话激活与窗口焦点因果链**：真实客户端发消息前必然经过第 2 层渲染窗口切换会话、触发 `enterOrExitAio` / `addActiveChatByUid` / `setFocusOnBase` 等状态流转；直调第 4 层 `sendMsg` 时客户端窗口状态长期冻结在空白页。
2. **缺失渲染层 IPC 轨迹**：主进程对 `RM_IPCFROM_RENDERER{windowId}` 具备完整生命周期统计，绕过 IPC 会出现“零 UI 交互却高频发包”的明显断层。
3. **跨进程状态不一致与富媒体崩溃**：未经过客户端内置 EXIF 清理与缓存目录规范化（`copyFileWithDelExifInfo`）就将外部临时路径直接塞入原生层，极易引发原生段错误；入站无 `rkey` 的 NTv2 图片 URL 若不经内核 `downloadRichMedia` 落盘，外部 HTTP 下载也会直接返回 `400 Bad Request`。

---

## 2. Rosmontis 核心架构

Rosmontis **不编译任何 C/C++ 代码、不注入任何 `.so`、不修改任何二进制文件、不拦截或伪造任何官方遥测接口**。全项目由 4 个顶层入口模块、JSDoc 类型契约（`src/types.js` & `jsconfig.json`）、`src/onebot/` 下的 4 个协议子模块、`src/core/` 下的 17 个零依赖核心子模块与 `src/actions/` 下的 4 个动作域子模块组成（零外部 npm 依赖）：

| 模块 | 职责 |
| :--- | :--- |
| `src/app_launcher_index.js` | 纯 JS 引导包装器：在 `major.node` 启动前初始化 `bridge_main.js`，支持 `ROSMONTIS_DISABLE=1` 一键旁路 |
| `src/bridge_renderer.js` | 渲染层受信任桥接器：闭包隔离 `__ipcToken` 鉴权，监听结构化 `__ROSMONTIS_BRIDGE_CMD__` 指令通道，构造原生 `RM_IPCFROM_RENDERER{windowId}` 帧并驱动会话因果状态机 |
| `src/bridge_main.js` | 主进程精简协调器：组合 `BridgeLogger`、`TtlDedupeSet`、`TempCleanupQueue`、`EchoCorrelator`、`HumanSessionController` 等核心子系统与动作路由表，统筹生命周期、自动快登与 OneBot v11 动作分发 |
| `src/bridge_onebot.js` & `src/onebot/*` | OneBot v11 协议统一门面与 4 个高内聚子模块：`stores`（LRU 消息短 ID 映射与 UIN/UID 双向索引）、`cq_codec`（CQ 码与消息段归一化编解码）、`segment_converter`（NTQQ `elements` 与消息段双向转换）、`event_formatter`（消息、灰条通知、请求与元事件格式化） |
| `src/types.js` & `jsconfig.json` | 零编译开销的 JSDoc 协议与内部运行时类型契约，提供 IDE 智能补全与静态契约约束 |
| `src/core/*` | 17 个零依赖核心子模块：`env`（多前缀环境变量统一解析）、`primitives`（有界 LRU、TTL 去重、临时文件清理队列、事件等待器、限流日志、跨进程 `Map`/`void` 无损编解码与声明式动作路由）、`nt_normalizer`（多版本 NTQQ 内核结构防腐层）、`echo_correlator`（出站 `sendMsg` <-> `onAddSendMsg` 真实 `msgId` 关联）、`session_controller`（人类会话因果控制器 `HumanSessionController`）、`session_scheduler`（会话亲和互斥锁与切换冷却 `CausalSessionScheduler`）、`nt_capture`（无痕捕获与原生原型链自动归还）、`renderer_ipc`（渲染窗口注入、受信任 IPC 与三级 `invokeNt` 调度）、`inbound_pipeline`（内核事件监听与富媒体水合）、`outbound_pipeline`（两阶段出站发送管线）、`server_runtime`（HTTP / 正向 WS / 反向 WS 服务运行时）、`ws_rfc6455`（RFC 6455 帧/掩码/大小上限）、`transport_security`（恒定时间鉴权、`Origin` 防护、非回环 Protected Mode 自动鉴权）、`media_security`（流式配额下载、IPv4/IPv6 SSRF 防护、严格 LFI 目录白名单）、`qzone_actions`（默认关闭的 Web 凭据/空间门控）、`web_http`、`config` |
| `src/actions/*` | 4 个 OneBot v11 动作域子模块：`message_actions`（登录状态、消息收发、合并转发、历史记录、已读/回应/戳一戳）、`contact_actions`（好友列表、资料、备注与好友申请）、`group_actions`（群信息/成员、群管操作、精华消息与入群申请）、`file_media_actions`（群/私聊文件传输、媒体解析、OCR/语音转文字、个人资料与 Ark 分享） |

### 2.1 渲染层官方 IPC 帧协议与 Map 跨进程还原

`bridge_renderer.js` 严格遵循官方渲染层通信格式：

- **请求帧**（发往 `RM_IPCFROM_RENDERER{windowId}`）：
  - `callbackId` 使用标准 `crypto.randomUUID()`（RFC 4122 v4），绝不添加任何自定义字符串前缀。
  - 请求体为 `[header, [cmd, ...args]]`，其中 `eventName: "ntApi"`，`cmdType: "invoke"`。
- **响应帧**（监听 `RM_IPCFROM_MAIN{windowId}`）：
  - 兼容处理 NTQQ 原生拼写 `header.promiseStatue`（`"fullfill"` / `"reject"`）。
  - **跨 `executeJavaScript` 的 `Map` 与 `void` 保真序列化**：Electron 的 `webContents.executeJavaScript` 在跨进程结构化克隆时会把 ES6 `Map` 退化为空对象 `{}`。Rosmontis 在渲染层出口递归编码 `Map` 条目并在主进程入口无损还原为真正的 `Map` 实例，解决了群成员列表（`result.infos` 为 `Map`）等接口返回空数据的问题。

### 2.2 瞬态捕获与原型链自动归还（Ephemeral Hook Release）

为获取主进程 DI 容器中的 `ntApi`、`ntStore` 与 `session` 引用，`bridge_main.js` 在启动瞬间安装极轻量的非枚举捕获钩子：
- 一旦三者捕获完成，等待 15 秒宽限期后**自动将 `Map.prototype.set` 还原为 V8 原生函数**并删除所有标记属性（可通过 `/get_status` 中的 `bridge.map_hook_active: false` 与 `bridge.map_hook_release.restored: true` 实时验证）。
- `Module._load` 钩子在首次观察到 `wrapper.node` 后立即卸载还原。

### 2.3 三级执行通道与“副作用命令绝不跨级重放”

`invokeNt(cmd, payload)` 提供三级通道：
- **Tier 1（首选常态）**：经活跃渲染窗口 `RM_IPCFROM_RENDERER{windowId}` 发起真实渲染层调用。
- **Tier 2（无窗口回退）**：主进程 `ntApi` 注册表直调。
- **Tier 3（兜底）**：`session.get*Service()` 原生服务方法调用。

**防重复发送保护（Side-Effect Replay Guard）**：
对于 `sendMsg`、`recallMsg`、转发、戳一戳、表情回应、群管理等有外部副作用的命令（`SIDE_EFFECT_NT_METHODS`），只有当上一级**根本未派发**（如渲染窗口尚未就绪，携带 `ROSMONTIS_BRIDGE_UNAVAILABLE` 标记）时才允许回退到下一级；一旦某级已派发请求，任何超时或业务错误均直接返回调用方，**绝不在下一级重放**，彻底杜绝大图慢速上传时的重复刷屏。

### 2.4 会话因果状态机与会话亲和并发调度（`HumanSessionController` & `CausalSessionScheduler`）

出站发消息采用**两阶段解耦**管线：第一阶段在锁外并发完成富媒体流式下载、图片尺寸嗅探与 EXIF 清理；第二阶段由 `HumanSessionController` 经 `CausalSessionScheduler`（同会话亲和互斥队列 + `maxAffinityStreak` 防饥饿上限 + `aioSwitchCooldownMs` 高频切换冷却）串行化包裹“会话激活 + `sendMsg` IPC 派发”，IPC 返回即释放互斥锁并在锁外等待 `onAddSendMsg` 真实回显（富媒体动态延长回显超时），消除多群并发来回乒乓切窗（AIO Thrashing）。

私聊与群聊严格遵循真实人类时间轴（**收到消息 -> 已读 -> 正在输入 -> 模型生成 -> 发送（或不发送）**）：

1. 窗口获焦：`setFocusOnBase({ isFocus: true })`（窗口已获焦时不重复发送）
2. 切换目标会话：若原驻留其他会话则先 `enterOrExitAio(prev, enterType: 2)`，再执行 `addActiveChatByUid` -> `enterOrExitAio(target, enterType: 1)`
3. 已读与输入态（`set_input_status` 或可选 `autoReadAndTypeOnPrivateRecv` 触发）：先调用 `setMsgRead` 消红点，再调用 `sendShowInputStatusReq` 展示“对方正在输入…”（模型最终决定不回复亦完全自然）
4. 发送与两级空闲退场：`send_msg` 阶段若已在目标会话则直接派发 `sendMsg`（不再瞬时补发 0ms 输入态）；默认无交互 45 秒后自动持锁发送 `enterOrExitAio(active, enterType: 2)` 退回会话列表，5 分钟无交互后自动发送 `setFocusOnBase({ isFocus: false })` 切入后台失焦

### 2.5 真实回显 `msgId` 关联（`EchoCorrelator`）与 NTv2 富媒体闭环

1. **出站 `sendMsg` <-> `onAddSendMsg` 回显关联**：
   NTQQ 3.2.32 的 `sendMsg` 返回值仅包含 `{result, errMsg}` 而不直接携带 `msgId`。Rosmontis 通过 `EchoCorrelator` 在调用 `sendMsg` 前挂起元素签名匹配器，精准捕获内核 `onAddSendMsg` 推送的真实 19 位 `msgId` 后再映射为 OneBot 31-bit 正整数 `message_id`，保证发送后立即调用 `delete_msg` 即可 100% 撤回。
2. **入站无 `rkey` 图片自动水合**：
   NTQQ 3.2.32 入站 `picElement.originImageUrl` 常为不带 `rkey=` 的相对路径，外部直接请求必返 `400 Bad Request`。`_hydrateNtMsgMedia` 优先读取本地原图/缩略图缓存，未命中时自动调用内核 `downloadRichMedia` 等待 `onRichMediaDownloadComplete` 落盘并编码为 `base64://` URI，下游机器人无需关心 `rkey` 签名算法即可直接读取图片字节。
3. **出站图片 EXIF 清理与路径规范化**：
   出站图片发送前自动调用 `nodeIKernelMsgService/copyFileWithDelExifInfo` 规范化至客户端内部富媒体缓存目录并重算真实大小与 MD5，消除野生路径引发的原生崩溃。
4. **免扫码快速登录恢复**：
   容器或进程重启后，Rosmontis 自动读取本地 `login.db` / `getLoginList` 中的快速登录凭据（自动开启 `setAutoLoginSwitch`），通过 `quickLoginWithUin` 与登录页按钮点击兜底在十余秒内恢复在线，无需重复扫码。

---

## 3. 诊断与运行状态观测

调用 OneBot `POST /get_status` 可实时查看桥接器内部健康度遥测：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "online": true,
    "good": true,
    "bridge": {
      "invoke": {
        "tier1": 178,
        "tier2": 0,
        "tier3": 0,
        "degraded": 0,
        "blockedReplays": 0,
        "failed": 0,
        "lastDegraded": null
      },
      "send_echo": {
        "matched": 53,
        "fromResult": 0,
        "timedOut": 0
      },
      "map_hook_active": false,
      "map_hook_release": {
        "reason": "captured",
        "restored": true
      }
    }
  }
}
```

- `invoke.tier1` 持续增长且 `degraded: 0`：表明 100% 请求均经由第 2 层真实渲染窗口 IPC 完成。
- `map_hook_active: false` 且 `restored: true`：表明初始化引用捕获已完成，全局 `Map.prototype.set` 已恢复为原生函数。

---

## 4. 应急旁路与无损卸载

1. **环境变量一键旁路**：设置 `ROSMONTIS_DISABLE=1` 重启 QQ，引导器将跳过 Rosmontis 加载，100% 原样运行官方客户端。
2. **一键还原原始文件**：执行 `sudo bash scripts/install_bridge.sh --uninstall`，自动从 `package.orig.json` 与 `index.orig.js` 恢复初始状态并清理桥接脚本。
