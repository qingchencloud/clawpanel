# Hermes UI 全面重构规划

> 参考：`.tmp/hermes-web-ui`（官方 Vue + Koa 实现）
> 目标：ClawPanel Hermes 引擎视觉 + 功能与官方看齐，保留 editorial luxury 主题。
> 作者：Cascade（AI 助手）｜日期：2026-04-24

---

## 🎯 总体目标

1. **功能完备度**对齐官方 `hermes-web-ui`，不再是"初级 UI"。
2. **视觉风格**继续用已做好的 editorial luxury（暖黑 + 金色 + Serif 标题）。
3. **架构**：前端 Vanilla JS + CSS scope，后端走 ClawPanel Rust 命令（部分已有，部分需新增）。
4. **分阶段交付**，每阶段独立 PR，可回滚。

---

## 📊 官方 vs ClawPanel 现状对比

| 页面 | 官方功能 | ClawPanel 现状 | Gap |
|---|---|---|---|
| **Logs** | 文件列表、级别过滤、行数、搜索、**logger 列**、**access log 彩色（method/path/status）** | 文件列表、级别、行数、搜索 | 缺 logger 列 + access log 解析 + tail + 下载 |
| **Chat** | SSE 流式、工具可视化、**持久化 Session（SQLite）**、**会话搜索**、多 profile、token 用量、context length | localStorage 会话、流式、工具卡片 | **架构性差距**：无 DB session、无搜索、无 usage、无 profile |
| **Skills** | 分类列表、详情、**toggle enable**、**category 描述**、**skill files tree** | 只读分类列表 + 详情 | 缺 toggle、files tree、CRUD |
| **Memory** | 三段式（memory/user/**soul**）、**mtime 时间戳** | 二段式（memory/user） | 缺 soul 段、mtime 显示 |
| **Jobs (Cron)** | 完整 Job 字段（next_run_at、last_run_at、last_status、last_error、delivery、**origin** 聊天平台溯源、**repeat**、skills 绑定、model/provider 绑定） | 基础 CRUD + 统计 | 缺 next/last run 时间、历史、绑定、delivery |
| **Files** ⭐ | 完整文件管理器（上传/下载/删除/预览） | **页面不存在** | 整个缺失 |
| **Sessions** ⭐ | 独立会话浏览器（列表/搜索/重命名/删除/usage） | 无 | 整个缺失 |
| **Gateways** ⭐ | 多 Gateway 切换 | 单 Gateway（已有基础） | 多 gateway 管理 UI 缺 |
| **Models** | 模型库浏览 + 用量 | 只有仪表盘的模型配置 | 独立 Models 页缺 |
| **Profiles** ⭐ | Profile 管理（不同 config 切换） | 无 | 整个缺失 |
| **Usage** ⭐ | token 用量统计、成本分析 | 无 | 整个缺失 |
| **Terminal** ⭐ | 内置终端 | 无 | 整个缺失 |
| **Channels** | 消息渠道（飞书/Telegram 等） | 占位 "coming soon" | 整个缺失 |

⭐ = 官方独有的全新页面

---

## 🛠️ 工作量评估

### 前端（Vanilla JS + hermes.css 组件）

| 模块 | 代码量 | 复杂度 |
|---|---|---|
| Logs 重写 | ~300 行 | 中（含 access log 解析） |
| Chat 重写 | ~700 行 | 高（SSE + session DB + usage） |
| Skills 重写 | ~400 行 | 中（加 toggle + files） |
| Memory 重写 | ~250 行 | 低 |
| Cron 重写 | ~500 行 | 中高（字段丰富） |
| Files 新增 | ~400 行 | 中 |
| Sessions 新增 | ~450 行 | 中高 |
| Usage 新增 | ~200 行 | 低 |
| Profiles 新增 | ~250 行 | 中 |
| Models 新增 | ~300 行 | 中 |
| **合计** | **~3750 行** | — |

### 后端（Rust 新增命令）

| 命令 | 数据源 | 估计 |
|---|---|---|
| `hermes_sessions_list/get/delete/rename` | `~/.hermes/sessions.db` SQLite | 中（4 个命令） |
| `hermes_session_usage` | `usage` 表 | 低（2 个） |
| `hermes_context_length` | 模型元数据 | 低 |
| `hermes_skill_toggle/create/delete` | `~/.hermes/skills/*/` FS | 中（3 个） |
| `hermes_skill_files` | 遍历 skill 目录 | 低 |
| `hermes_memory_soul` | `~/.hermes/memories/SOUL.md` | 低 |
| `hermes_logs_tail` | SSE 流 `~/.hermes/logs/*.log` | **高**（流式） |
| `hermes_logs_download` | 文件下载 | 低 |
| `hermes_files_list/read/delete/upload` | `~/.hermes/` 任意文件 | 中（4 个） |
| `hermes_profiles_list/switch` | `~/.hermes/profiles.json` | 低 |
| `hermes_job_history` | Gateway `/api/jobs/:id/runs` | 低 |
| **合计** | | **~18 个命令** |

### 样式（hermes.css 扩展）

| 组件 | 估计 |
|---|---|
| Logs 页（access log/logger 徽章） | ~60 行 |
| Chat 页（session browser/usage bar） | ~100 行 |
| Skills 页（files tree/toggle） | ~80 行 |
| Memory 页（三段布局） | ~40 行 |
| Files 页（新） | ~120 行 |
| Sessions 页（新） | ~100 行 |
| Usage / Profiles / Models | ~150 行 |
| **合计** | **~650 行 CSS** |

---

## 🗓️ 分阶段交付（建议 6 个独立 PR）

### Phase 1 — **Logs + Memory 重写**（低风险起步）
- 后端新增：`hermes_logs_tail`（SSE）、`hermes_logs_download`、`hermes_memory_read/write` 扩展支持 soul
- 前端重写：logs.js（access log 解析/logger 列/tail toggle/下载/清空显示）
- 前端重写：memory.js（三段式：memory/user/soul，加 mtime、字数）
- **工作量**：~600 行前端 + ~250 行 Rust + ~100 行 CSS
- **风险**：低（功能相对独立）
- **PR 大小**：中

### Phase 2 — **Cron (Jobs) 完整字段**
- 后端：`hermes_job_history`（走 Gateway REST）
- 前端：cron.js 重写，含 next_run_at / last_run_at / last_status / 执行历史抽屉 / delivery 字段 / skills 绑定
- **工作量**：~500 行前端 + ~80 行 Rust + ~80 行 CSS
- **风险**：中（需要验证 Gateway REST 支持所有字段）

### Phase 3 — **Skills CRUD**
- 后端：`hermes_skill_toggle/create/delete`、`hermes_skill_files`
- 前端：skills.js 重写，加 toggle / 新建 modal / 编辑 / 删除 / 文件树
- **工作量**：~400 行前端 + ~300 行 Rust + ~80 行 CSS
- **风险**：中（FS 操作需权限/错误处理严谨）

### Phase 4 — **Chat 架构重构**（重头戏）
- 后端：`hermes_sessions_*`（读 Hermes 的 SQLite）、`hermes_session_usage`、`hermes_context_length`
- 前端：chat.js 完全重写
  - 从 localStorage 迁移到后端 session API
  - 增加停止按钮、消息复制、代码块语法高亮（引入 highlight.js 或自研）
  - Token 用量实时显示
  - context length bar
  - 搜索历史会话
- **工作量**：~700 行前端 + ~400 行 Rust + ~150 行 CSS
- **风险**：**高**（架构迁移、localStorage 数据要兼容迁移）

### Phase 5 — **新页面：Sessions + Usage**
- Sessions 独立页面（浏览所有历史、搜索、重命名、删除）
- Usage 页面（token 统计、成本）
- 侧栏导航项新增
- **工作量**：~650 行前端 + ~100 行 Rust + ~150 行 CSS

### Phase 6 — **Files + Profiles**（可选，根据需求）
- Files 浏览器（上传下载）
- Profiles 切换（多 config）
- **工作量**：~650 行前端 + ~250 行 Rust + ~170 行 CSS

---

## ⚠️ 关键技术决策

### 1. 后端协议：SQLite 直读 or Gateway REST？
Hermes Gateway **自身不暴露 session REST API**。必须**直接读 SQLite `~/.hermes/sessions.db`**（Hermes 进程也用这个文件，要注意并发）。

**方案**：Rust 端用 `rusqlite` crate + `WAL mode` 读。写操作（rename/delete）必须等 Gateway 停机或通过 Hermes CLI。

### 2. SSE 在 Tauri 中的实现
Tauri WebView 支持 EventSource，但 Windows 上某些版本的 WebView2 可能有 buffer 问题。**已知方案**：Rust 端用 `tauri::Event` 推事件，前端 listen 就好。logs tail、chat run 已在用这个模式。

### 3. SQLite 迁移 localStorage chat sessions
chat.js 现有 localStorage 数据要迁移。**方案**：首次进 chat 页检测 localStorage 有旧 session，询问用户是否导入到 Hermes DB，or 保留只读访问。

### 4. Session DB 的 schema 兼容性
Hermes 的 SQLite schema 可能版本间变化。参考 `.tmp/hermes-web-ui/packages/server/src/db/hermes/sessions-db.ts` 的 query 写法，保持一致。遇到 schema 差异用 `PRAGMA user_version` 检测。

### 5. Files 页面的权限边界
只允许访问 `~/.hermes/` 目录，**拒绝绝对路径**，`../` 遍历要 reject。

### 6. Profiles 的切换语义
切换 profile = 切换 `~/.hermes/config.yaml` + `.env` + 重启 Gateway。每个 profile 是一个完整配置目录。UI 要明示切换后需要重启 Gateway。

---

## 📋 验收标准（每阶段）

- [ ] 新功能单元测试（Rust 端 `cargo test`）
- [ ] 前端 lint 通过 `npm run build`
- [ ] 手动测试：Tauri 桌面端 + Web 模式两端都跑一遍
- [ ] 与官方 hermes-web-ui 视觉对比（截图），功能缺失 ≤ 10%
- [ ] 不影响 OpenClaw 引擎（scope 隔离验证）
- [ ] 性能：1000 条会话列表加载 < 500ms

---

## ⏱️ 估算总时长

| 阶段 | 预估时间 |
|---|---|
| Phase 1 | **1 天** |
| Phase 2 | **1 天** |
| Phase 3 | **1.5 天** |
| Phase 4 | **2.5 天** |
| Phase 5 | **1.5 天** |
| Phase 6 | **1.5 天** |
| **合计** | **~9 天** |

AI 辅助开发可能压缩到 5-6 个工作日。

---

## 🚀 建议执行顺序

1. **先合并当前 `feat/hermes-v0.14.1-providers` PR**（dashboard + sidebar 新样式 + env-editor + skeleton scope）
2. **再开 Phase 1 分支** `feat/hermes-logs-memory-refactor`，按此规划交付
3. Phase 2-6 每个都独立分支 + PR，按优先级排

这样用户可以：
- 每次只 review 一个 PR
- 任一阶段失败不会阻塞前面的工作
- 可以随时暂停，保留已完成的阶段成果

---

## 📎 参考实现

- 官方 Vue UI：`.tmp/hermes-web-ui/packages/client/src/views/hermes/*.vue`
- 官方 Server：`.tmp/hermes-web-ui/packages/server/src/services/hermes/*.ts`
- 官方 DB 层：`.tmp/hermes-web-ui/packages/server/src/db/hermes/*.ts`
- ClawPanel 现有：`src/engines/hermes/pages/*.js`、`src-tauri/src/commands/hermes.rs`
- 设计系统：`design-system/clawpanel/MASTER.md`、`src/engines/hermes/style/hermes.css`
