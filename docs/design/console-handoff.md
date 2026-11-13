# 知识库控制台 · 开发交接说明

> 给接手的开发（人或 AI agent）看的唯一入口文档。先读完这份，再动代码。
> 设计稿：同目录 `console-v2.html`（**版面和配色以它为准**，本文只补充它画不出来的接口契约和改造点）。
> 旧规格书 `docs/console-design-spec.md` 是蓝色 SaaS 风的第一版，**视觉已废弃**，只有里面的业务语义还有效。

## 0. 一句话任务

在仓库 `console/` 下新建一个纯前端 SPA（Vite + React + TypeScript），把 `console-v2.html` 里画的
**登录页 + 9 个页面**做成能真正读写后端的可用控制台；配套改三处后端（本地密码登录、今日统计接口、token 7 天续期）。

## 1. 仓库与环境

| 项 | 值 |
| --- | --- |
| 仓库（公开） | https://github.com/BUTFL/qq-ai-kefu |
| 本地路径 | `~/qq-ai-kefu`（macOS） |
| 后端 | Python 3.11 + aiohttp，在 `bot/`，跑在机器人进程里，监听 `127.0.0.1:8090` |
| 前端产出 | **新建 `console/`**，本仓库里目前没有前端代码 |
| Node / pnpm | node v24.21.0 / pnpm 11.28.5（已验证） |
| 现成部署 | 根目录 `docker-compose.yml` 三服务：protocol（协议端）/ bot（机器人+控制台接口）/ lan（局域网代理） |

现成接口都在 `bot/admin_web.py`，文件头 docstring 讲了安全模型（只绑 127.0.0.1、Host 校验、CORS 白名单），**不要放松这些**。

## 2. 设计基准（硬要求）

打开 `docs/design/console-v2.html` 直接看。要抄的：

**设计语言**：台账/印刷感。细线分栏、无投影、无大色块、无渐变、无图标库。IBM Plex Sans + IBM Plex Mono（Google Fonts），
所有数字用等宽 + `font-variant-numeric: tabular-nums`。纸色底、白面板。

**CSS 变量（原值照抄）**：

```css
:root {
  --paper:#f1f3f2; --panel:#fff; --panel-2:#f8f9f8; --panel-3:#eceeed;
  --ink:#15181a; --ink-2:#575f64; --ink-3:#868e8c;
  --rule:#d8dcda; --rule-2:#e8ebe9;
  --seal:#b3351c; --seal-weak:#faece8; --on-seal:#fff;   /* 朱红：只给要人拍板的事 */
  --jade:#156b57; --jade-weak:#e6f2ee;                    /* 绿：只当成功/正常状态 */
  --amber:#84570a; --amber-weak:#fbf2df;                  /* 琥珀：只当提醒 */
  --sans:"IBM Plex Sans","Noto Sans SC",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){ :root{
  --paper:#101312; --panel:#171a19; --panel-2:#1d211f; --panel-3:#242827;
  --ink:#e9ebe9; --ink-2:#9aa29e; --ink-3:#6b7370; --rule:#2b302e;
  --seal:#ee7254; --jade:#4fb795; --amber:#d6a447;
}}
:root[data-theme="dark"] { /* 同上，手动切换用 */ }
```

**版面**：`.frame` = `grid-template-columns: 212px minmax(0,1fr)`；左侧 `.rail` 用 `--panel-2`（浅色，不是深色），
右边框一条竖线；导航项选中 = 左侧 3px 墨色竖条 + 白底 + 600 字重，右侧等宽数字角标（待审用朱红）；
三个分组标题：**知识 / 名单 / 群**；侧栏底部小字写「Rosmontis 1.4.2 · bot 8090 · 协议端 6099」。

**顶栏**：页标题 + 等宽读数区（协议端在线时长带脉冲圆点、今日问答、命中 x/y、待审数）+ 右侧「超管 · 退出」。

**响应式**：`max-width: 860px` 时侧栏变顶部横滚 tab（底部 3px 边框表示选中），四格统计变 2×2，两栏变单列。

**无障碍**：`aria-current="page"` 标当前页；`.chip` 用 `aria-pressed`；`.opt` 用 `aria-checked`；开关用真 `<input type="checkbox">`；弹层要有 `role="dialog"` 和 Esc 关闭。

## 3. 技术栈与目录

已定：**Vite + React 18 + TypeScript（严格）+ 手写 CSS 变量，不引 UI 组件库、不引 Tailwind**。
路由用 `react-router-dom`。状态就地 `useState`/`useEffect`，不引 redux/react-query（页面不多）。

```
console/
  package.json  vite.config.ts  tsconfig.json  index.html  README.md
  src/
    main.tsx  App.tsx  routes.ts
    styles/tokens.css       # 上面那套变量 + 字体
    styles/base.css         # 公共类：.frame .rail .topbar .band .card .tag .btn .chip .mix .note .drop .draft .opt .prog ...
    api/client.ts           # fetch 封装：VITE_API_BASE 默认 http://127.0.0.1:8090，带 Bearer，401 抛 AuthError
    api/types.ts            # 按第 5 节的类型
    auth.tsx                # AuthProvider：token 存 localStorage('kf_token')，登录/登出，守卫
    layout/Shell.tsx        # 侧栏 + 顶栏骨架
    pages/{Login,Home,Entries,Docs,Crawl,Learn,Drafts,Trusted,Banned,Notice}.tsx
```

路由：`/login /home /entries /docs /crawl /learn /drafts /trusted /banned /notice`。
未登录访问任何页 → 跳 `/login`；登录成功跳 `/home`。

**开发时跨域**：后端只放行 CORS 白名单里的来源。开发期请在 `vite.config.ts` 里配 proxy（`/api` → `http://127.0.0.1:8090`），
前端用相对路径 `/api/...` 请求，避免改后端 CORS。生产部署时前端静态文件由 lan 代理或 nginx 同源提供。

## 4. 后端要补的三件事

### 4.1 本地密码登录（替换 NapCat 鉴权）

现状：`bot/napcat_auth.py` 把浏览器带来的 Bearer 转手去问 NapCat 的 `POST /api/auth/check`（TTL 60s 缓存）。
NapCat 不在了就 401。

要改成：

1. `bot/config.py`：读 `ADMIN_PASSWORD`（环境变量，默认空字符串）。**为空时保持旧行为**（回落 napcat_auth），这样老部署不坏。
2. 新建 `bot/console_auth.py`：
   - `issue(password: str) -> str | None`：密码对（`hmac.compare_digest`）就签发 `secrets.token_urlsafe(32)`，记 `{token: expires_at}`；7 天有效，**每次 verify 成功就滑动续期**。
   - `verify(token: str) -> bool`：查表 + 过期清理。并发用 `asyncio.Lock`。
   - `revoke(token)`。
3. `bot/admin_web.py`：
   - 鉴权中间件：`settings.admin_password` 非空 → `console_auth.verify()`，否则原路径。
   - 新增 `POST /api/login`，body `{"password":"..."}` → `{"token":"..."}`；错密码 401 `{"error":"密码不对"}`。
   - 新增 `POST /api/logout`（带 token）→ `{"ok":true}`。
   - CORS / Host 校验 / `_err` 风格保持不变。
4. `.env.example` 里已经有 `ADMIN_PASSWORD=`（第 44 行，注释「[必填] 知识库控制台登录密码」），文档改成「启用本地登录时必填」。

### 4.2 今日统计 `/api/stats/today`

现状 `GET /api/stats` 只返回 `{"line": "标准答案 1284 条 · 资料 23 份 1962 块"}`（`store.stats_line`）。

新增 `GET /api/stats/today`，从问答日志表按当天统计（表名和字段去 `bot/store.py` 找，`qa_log` 之类；**不要造假数据**）：

```json
{ "total": 142, "by_source": {"kb":78,"rag":32,"miss":14,"chat":12,"human":6},
  "hits": 110, "avg_ms": 1800, "drafts_pending": 7 }
```

- `by_source` 的键用库里真实取值：`kb / rag / miss / chat / block / holding / human / notice / error`（九种，见 `bot/kb/*.py` 的 source 常量）。
- 没有耗时字段就 `avg_ms: null`。
- `drafts_pending` 用 `store.drafts("pending", 1)` 或等价 count。

### 4.3 登录态 7 天滑动续期

已含在 4.1。前端把 token 存 localStorage；`client.ts` 收到 401 清 token 并跳登录。

## 5. 后端接口契约（现有，字段从代码抠的）

所有接口都挂在 `bot/admin_web.py`，响应 JSON，错误统一 `{"error": "中文原因"}` + 4xx/5xx。
下文 `<...>` 表示路径参数/表单字段。

### 统计

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/stats` | `{"line": "标准答案 1284 条 · 资料 23 份 1962 块"}` |
| GET | `/api/stats/today` | 见 4.2（**待实现**） |

### 标准答案

`GET /api/entries` → 数组：

```ts
type Entry = {
  id: number; question: string; aliases: string[]; answer: string;
  hits: number; updated_at: string;          // "2026-11-12 21:03"
  source: string;                             // "web" | "nightly" | ...
  images: { id: number; url: string }[];      // url 形如 /api/image/12
};
```

- `POST /api/entries`，body `{id?, question, answer, aliases: string[]}` → 返回保存后的 `Entry`。
  校验失败 `{"error":"问题和回复都不能空"}`；向量算失败会返回 400 并说明「存下了但算向量失败」。
- `DELETE /api/entries/{id}` → `{"ok": true}`
- `POST /api/entries/{id}/images`（multipart，字段名 `file`）→ 图片对象 `{id, url}`；`DELETE /api/image/{id}`。
- `GET /api/image/{id}` → 图片二进制。

### 资料库

`GET /api/docs` → 数组：

```ts
type Doc = {
  path: string; name: string; chars: number; chunks: number;
  imported_at: string; uploaded: boolean; has_raw: boolean;
  web_url: string | null;                     // 网页抓的才有
};
```

- `GET /api/docs/chunks?path=...` → `[{title, body}]`
- `GET /api/docs/raw?path=...` → 原件（txt/md/pdf/...）
- `POST /api/docs/upload`（multipart，可多份，字段名 `file`）→ `[{name, ok:true, state, chunks, chars} | {name, ok:false, error}]`
- `POST /api/docs/fetch`，body `{url}` → 抓网页入库
- `POST /api/docs/delete`，body `{path}` → `{"ok":true}`

### 爬常见问题（任务制）

`GET /api/crawl` →

```ts
type CrawlJob = {
  id: number; url: string;
  state: string;            // running / stopped / failed / done / queued（以 crawl.py 常量为准）
  max_pages: number; pages: number; found: number; drafts: number; images: number;
  replaced: string[]; log: string; error: string;
  created_at: string; finished_at: string;
  pending: number;          // 队列里还剩几个网址
  can_resume: boolean;      // pending>0 且 state in (stopped, failed)
};
// 外层：{ running: boolean, jobs: CrawlJob[] }
```

- `POST /api/crawl`，body `{url, max_pages?}` → `{id}`；已有任务在跑时 409。
- `POST /api/crawl/stop` → `{ok}`
- `POST /api/crawl/{id}/resume`、`POST /api/crawl/{id}/retry`，body `{max_pages?}` → `{ok, id}`
- **一次只跑一个**：`running === true` 时「开个新的」要禁用并提示。

### 截图学答法

- `POST /api/learn/read`（multipart：`file` 一张图 + 可选 `staff` 客服昵称提示）→ `{name, text}`。
  **一张一个请求**，多张请并发/串行逐张发，单张失败不影响其他。
- `POST /api/learn/analyze`，body `{texts: string[]}` → `{drafts: Draft[], skipped: ...}`
  （`skipped` 是没能整理成草稿的条数/原因，按实际返回值展示）。

### 待审草稿

`GET /api/drafts` →

```ts
type Draft = {
  id: number;
  kind: "new" | "alias" | "merge";   // 常量 DR_NEW / DR_ALIAS / DR_MERGE
  entry_id: number | null;           // alias/merge 指向已有答案
  merge_from: string | null;
  question: string; answer: string;
  options: string[];                 // 候选答案（new 有多条候选）
  aliases: string[];
  evidence: string;                  // 依据：群名+时间+来龙去脉
  note: string;
  created_at: string;
  source_url: string | null;         // 爬来的才有
  images: { id: number; url: string; caption: string }[];
};
// 外层：{ drafts: Draft[], review: {at, summary, error} | null }   review = 昨晚复盘的运行记录
```

- `POST /api/drafts/{id}/accept`，body `{question?, answer?, aliases?: string[], images?: number[]}` → `{ok, message}`；冲突 409。
- `POST /api/drafts/{id}/reject` → `{ok, message}`
- `GET /api/draft_image/{id}` → 图片二进制。

### 自己人

`GET /api/trusted` → `{fixed: [{user_id, why}], list: [{user_id, note, created_at}]}`
（`why` = 「超管」或「.env 的 TRUSTED」，**只读**）
`POST /api/trusted`，body `{user_id, note?}` → `{ok}`
`DELETE /api/trusted/{uid}` → `{ok: boolean}`

### 群

`GET /api/groups` → `{groups: [{group_id, name, members, kind, admin: boolean|null}], busy: boolean}`
（`admin === false` 表示机器人不是管理员，发公告会被拒，页面上要提前标出来）

- `POST /api/groups/notice`（**multipart**：`group_id` 可多个、`content`、`pinned`（"1"）、`confirm`（"1"）、`image` 可选）→ `{results: [...]}`
- `POST /api/groups/file`（multipart：`group_id` 多个 + `file`）→ `{results}`
- `POST /api/groups/message`（发一条 @全体 的群消息，字段按 `send_message` 实现）
- `GET /api/groups/at_all_remain?group_id=1&group_id=2` → `{"<gid>": 剩余次数}`
- `GET /api/groups/notices?group_id=...` → `{notices: [{notice_id, text, images, sender_id, publish_time, read_num}]}`
  **必须带 group_id**，没有「全部群」视图。
- `POST /api/groups/notices/delete`，body `{group_id, notice_id}`

### 被封禁的人

`GET /api/banned` → `{list: [{user_id, group_id, operator_id, source, note, banned_at, nickname}]}`
（`source`: `kick`=被你踢出群 / `web`=这里手动加的 / `log`=以前踢的；`nickname` 是最后一次申请时填的，可能为 null）
`POST /api/banned`，body `{user_id, ...}`；`DELETE /api/banned/{uid}`

## 6. 九页逐页规格

### 登录 `/login`
居中卡片（`.lk`）+ 28px 朱红方章「客」+ 标题 + 说明（用 `ADMIN_PASSWORD`，只能本机与 `LAN_HOSTS` 访问）+
密码框 + 错误提示 + 登录按钮。提交 `POST /api/login`，成功存 token 跳 `/home`。

### 概览 `/home`
- 四格（`.band`）：标准答案数（`/api/entries` 长度）、资料份数/块数（`/api/docs` 求和）、
  今日问答（`/api/stats/today` 的 total + avg_ms 副标）、待审草稿数。
- 「今天怎么答的」命中构成条（`.mix` + `.legend`）：**五类合成** —— 标准答案(kb)、资料命中(rag)、未命中(miss)、
  闲聊挡下(chat+block)、转人工(human+holding)；`notice`/`error` 归「其他」或不显示（总数对得上即可）。
- 最近问答表：**目前后端没有列表接口**。先用 `/api/stats/today` 的分组数据画构成条；
  表格这一块写 `TODO：等后端加 /api/qa/recent`，不要编假数据上线。
- 昨晚复盘卡：`/api/drafts` 返回里的 `review`（`at`/`summary`/`error`），按钮跳 `/drafts`。

### 标准答案 `/entries`
- 搜索框（前端过滤 question/aliases/answer）+「＋ 新增」。
- 表：问题（+ `.alias` 小字列别名）、答案（截断，hover 显示全文）、命中、来源 `.tag`、改过时间、`改 / 删`。
- 弹层编辑：问题、别名（一行一个）、答案（textarea）、配图上传（`POST /api/entries/{id}/images`）、保存。
- 删除二次确认（`confirm()` 或自绘弹层，自绘优先）。

### 资料库 `/docs`
- 头部：份数/块数、`重新入库`、`抓个网页进来`（输网址 → `/api/docs/fetch`）、`＋ 上传`（多选，txt/md/pdf/docx/图片）。
- 表：文件（名 + 类型 tag + `.web_url` 可点）、块数（`.prog` 相对占比）、来源、入库时间、`看块 / 看原文 / 删`。
- 「看块」弹层：`/api/docs/chunks`；「看原文」新窗口打开 `/api/docs/raw`。

### 爬常见问题 `/crawl`
- 按任务制表：网址、状态 `.tag`（running 绿 / stopped 灰 / failed 朱红 / done 中性 / queued 琥珀）、
  页数 `x/y` + `.prog`、找到/起草、队列剩几个、操作（`停` `接着爬`（`can_resume` 才亮）`重试` `再爬一次` `日志`）。
- 顶部「＋ 开个新的」（网址 + 最多页数）；`running === true` 时禁用并提示「有一个在爬，先停它」。
- 底部 `.logline` 显示选中任务的 `log` 尾部。

### 截图学答法 `/learn`
- 左栏「抄出来的对话」：气泡示意（`.bub` / `.bub.me`）+ 可编辑的 Q/A 文本块 + 一起收的问法 `.chips`（可增删 toggle）+
  `存成待审草稿`（调 `/api/learn/analyze`）+ `这张不要`。
- 右栏「传截图」：`.drop` 拖拽/点选多张 png/jpg/webp，逐张 `POST /api/learn/read` 显示进度（n/总数），
  失败的那张单独标红可重试。
- 说明 note：「抄出来只进待审草稿，采纳才生效」。

### 待审草稿 `/drafts`
- **三种 kind 分开画**（同一列表里按 kind 渲染不同骨架）：
  - `new`：`.tag.seal`「新答案」+ 问题 + `options` 单选（`.opt` radio）+ 问法 chips + 依据；
  - `alias`：`.tag.amber`「加问法」+ 要加的问法 + 现有答案（只读）+ 为什么并进去；
  - `merge`：`.tag`「合并两条」+ 合并后的问题/答案 + `merge_from` 指向的原条目对比。
- 右侧依据栏：`.ev`（evidence）、配图 `.thumb`、备注、`采纳`（朱红主按钮）/`驳回`。
- 顶部「全部驳回」。采纳可编辑 question/answer/aliases/images 后提交 `/accept`。
- 脚注：「采纳 = 进标准答案并重算向量；驳回 = 这批问法下次复盘不再起草」。

### 自己人 `/trusted`
- 顶部 note 写清语义（名单里的号在群里回客户的话，夜间复盘当人工客服答法学成标准答案；不在名单的只当问题）。
- 两张卡：「固定的」（`fixed`，只读，注明要改去 `.env`）+「页面上加的」（表：QQ 脱敏、备注、加的时间、移除）。
- `＋ 加自己人`：QQ + 备注（≤40 字）。QQ 显示按 V2 那样中间打码。

### 被封禁的人 `/banned`
- 顶部 note：踢出群自动记入，以后申请任何群都自动拒（回「请输入正确订单号」，不告知、不私聊）；踢错了在这儿解封。
- 搜索（QQ/昵称）+ `手动封`。
- 表：QQ / 昵称 / 怎么进来的 `.tag`（kick 朱红 / web / log）/ 在哪个群踢的 / 时间 / `解封`（二次确认）。

### 群公告 `/notice`
- 左卡：群多选 `.chip`（`/api/groups`，`admin !== true` 的标「不是管理员」并禁用；旁边显示 `at_all_remain`）、
  内容 textarea（字数统计 / 上限，后端限制见 `announce.py`）、开关（置顶 / 要群员点确认 / 配一张图）、
  `发到 N 个群`（二次确认）+ `发群消息` + `传群文件`。
- 右卡：选中群已发公告（`/api/groups/notices?group_id=`），可删；切群跟着变；未选群时提示。
- 底部 `.note.warn`：@全体 每天有上限，建议用人工号发。

## 7. 验收清单

1. `cd console && pnpm install && pnpm build` 通过，`tsc --noEmit` 无错。
2. 十页都能从侧栏点到，刷新任意路由不 404（history fallback 配好）。
3. `tokens.css` 深色模式在系统深色 + `data-theme="dark"` 两种方式下都生效。
4. 所有列表都有 加载中 / 空 / 出错（区分「连不上后端」和「没登录」）三态。
5. 破坏性操作（删、解封、发公告、全部驳回）都有二次确认。
6. 前端无硬编码真实 QQ 号/密码/token（`grep -E '3803036801|1361744959|2963474083' console/` 无结果）。
7. 804px 宽下侧栏变顶部 tab，页面不横向溢出（表格用 `.scroll` 横滚）。
8. `README.md` 写清：`ADMIN_PASSWORD` 怎么设、`pnpm dev` 怎么起、构建产物怎么部署到 lan 代理。

## 8. 不要做的事

- 不要改 `bot/kb/*` 的业务逻辑和提示词。
- 不要动 `.env`、`data/`、`knowledge/`（真实数据）。
- 不要 git commit / push（由负责人审查后统一提交）。
- 不要为了「好看」加图标库、渐变、阴影、圆角大卡片 —— V2 的方向就是去掉这些。
- 不要把九种 source 压成五种存库；五种只是概览页的展示合并。
- 后端不要动 CORS 和 Host 校验去「方便开发」，用 vite proxy。
