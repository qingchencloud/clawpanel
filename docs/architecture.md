# ClawPanel 技术架构文档

> 本文档为 ClawPanel 项目内部开发者参考手册与技术决策记录，目标读者为：内部开发者和技术决策者。

## 目录

- [1. 系统概述](#1-系统概述)
- [2. 架构总览](#2-架构总览)
- [3. 技术选型](#3-技术选型)
- [4. 双模式部署](#4-双模式部署)
- [5. 关键设计决策](#5-关键设计决策)
- [6. 快速参考](#6-快速参考)

---

## 1. 系统概述

ClawPanel 是 [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) AI Agent 框架的可视化管理面板，提供：

- **仪表盘** — 实时服务状态、版本信息、快捷操作
- **模型配置** — 多服务商管理、批量连通性测试
- **Gateway 管理** — 启停控制、访问权限、认证 Token
- **消息渠道** — Telegram、Discord、飞书、钉钉、QQ 等接入
- **AI 助手** — 内置 AI 助手，4 种操作模式 + 8 大工具
- **记忆管理** — Agent 记忆文件查看/编辑、ZIP 导出
- **定时任务** — Cron 定时执行，多渠道投递

ClawPanel 有两种部署形态：

| 形态 | 技术栈 | 运行方式 | 典型场景 |
|------|--------|----------|----------|
| **桌面端** | Tauri v2 (Rust + WebView) | 原生可执行文件 | macOS/Windows/Linux 桌面 |
| **Web 端** | Vite + Node.js | 浏览器访问 | Linux 服务器、ARM 板、嵌入式设备 |

两者共享同一套前端代码，后端实现略有不同：桌面端通过 Tauri IPC 调用 Rust 命令；Web 端通过 HTTP API 调用 Node.js subprocess。

---

## 2. 架构总览

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    ClawPanel 前端                       │
│            (src/ — Vanilla JS + Vite)                   │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │  Pages   │ │Components │ │   Lib    │ │  Locales │   │
│  │ (20个)   │ │ (5个)    │ │ (13个)   │ │ (多语言)  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘   │
│       │             │             │                      │
│       └─────────────┴─────────────┘                      │
│                      │ Tauri IPC / HTTP API              │
├──────────────────────┼──────────────────────────────────┤
│                      │                                    │
│  ┌───────────────────▼───────────────────┐              │
│  │         ClawPanel 后端                 │              │
│  │   (src-tauri/ — Rust + Tauri v2)      │              │
│  │                                        │              │
│  │  commands/ (12个模块)                  │              │
│  │  ├── config    ├── messaging          │              │
│  │  ├── service   ├── pairing            │              │
│  │  ├── agent     ├── skills             │              │
│  │  ├── logs      ├── update             │              │
│  │  ├── memory    ├── extensions         │              │
│  │  ├── device    └── assistant          │              │
│  │                                        │              │
│  │  utils.rs: openclaw_dir,              │              │
│  │            gateway_listen_port,       │              │
│  │            enhanced_path, proxy       │              │
│  └───────────────────┬───────────────────┘              │
│                      │ Shell Plugin / HTTP                │
├──────────────────────┼──────────────────────────────────┤
│                      │                                    │
│  ┌───────────────────▼───────────────────┐              │
│  │       OpenClaw CLI                    │              │
│  │  (npm 全局包 @qingchencloud/openclaw-zh) │           │
│  │                                        │              │
│  │  openclaw config / start / stop / ... │              │
│  └───────────────────┬───────────────────┘              │
│                      │                                    │
│  ┌───────────────────▼───────────────────┐              │
│  │       OpenClaw Gateway                 │              │
│  │  (Node.js, 默认端口 18789)             │              │
│  │                                        │              │
│  │  WebSocket API / REST API             │              │
│  │  Agent 管理、模型路由、消息渠道         │              │
│  └────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────┘
```

### 2.2 前端模块结构

```
src/
├── main.js              # 入口：boot()、认证、路由注册、Gateway 状态管理
├── router.js            # 极简 hash 路由：registerRoute / navigate / initRouter
├── pages/               # 20个页面模块（懒加载）
│   ├── dashboard.js
│   ├── chat.js          # 实时聊天，流式响应
│   ├── models.js        # 模型配置
│   ├── services.js      # 服务管理
│   ├── gateway.js       # Gateway 配置
│   ├── memory.js        # 记忆文件管理
│   ├── agents.js        # Agent CRUD
│   ├── skills.js        # Skills 管理
│   ├── channels.js      # 消息渠道
│   ├── communication.js
│   ├── cron.js          # 定时任务
│   ├── usage.js         # Token 用量统计
│   ├── logs.js          # 日志查看
│   ├── security.js
│   ├── settings.js
│   ├── setup.js         # 初始安装向导
│   ├── assistant.js     # AI 助手
│   ├── chat-debug.js
│   ├── extensions.js
│   └── about.js
├── components/          # 通用 UI 组件
│   ├── sidebar.js       # 侧边栏 + 移动端汉堡菜单
│   ├── modal.js         # 弹窗组件
│   ├── toast.js         # Toast 通知
│   ├── ai-drawer.js     # AI 助手抽屉（右侧滑出）
│   └── engagement.js    # 社区引导弹窗
├── lib/                 # 核心工具库
│   ├── tauri-api.js     # Tauri IPC 封装（所有 invoke 调用的入口）
│   ├── ws-client.js     # WebSocket 客户端（连接 Gateway）
│   ├── app-state.js     # 全局状态（Gateway 运行状态、实例等）
│   ├── theme.js         # 暗色/亮色主题切换
│   ├── i18n.js          # 国际化初始化
│   ├── markdown.js       # Markdown 渲染（marked.js）
│   ├── icons.js         # SVG 图标库
│   ├── error-diagnosis.js
│   ├── gateway-guardian-policy.js
│   ├── channel-labels.js
│   ├── mirror-urls.js
│   ├── model-presets.js # 模型预设（DeepSeek/MiniMax 等）
│   ├── openclaw-kb.js
│   └── message-db.js
├── locales/             # 国际化资源
│   ├── index.js          # 初始化入口
│   ├── helper.js          # 辅助函数
│   ├── zh-CN.json / en.json / ja.json / ... (9种语言)
│   └── modules/           # 按页面拆分的翻译模块
└── style/               # 纯 CSS
    ├── variables.css     # CSS Variables（颜色、字体、圆角）
    ├── reset.css
    ├── layout.css        # 整体布局（sidebar + content）
    ├── components.css   # 通用组件样式
    ├── pages.css        # 页面通用样式
    ├── chat.css         # 聊天页面样式
    ├── agents.css
    ├── debug.css
    ├── assistant.css
    └── ai-drawer.css
```

### 2.3 后端/Rust 模块结构

```
src-tauri/src/
├── main.rs              # 入口：clawpanel_lib::run()
├── lib.rs               # run() — Tauri Builder 配置
│                          # - Shell Plugin / Autostart Plugin 注册
│                          # - URI Scheme Protocol（热更新 + 内嵌资源）
│                          # - setup() — 启动守护进程 + 系统托盘
│                          # - on_window_event — 关闭按钮最小化到托盘
│                          # - generate_handler![...] — ~90个命令注册
│                          # - run() — 事件循环
├── commands/             # 12个命令模块
│   ├── mod.rs            # openclaw_dir(), gateway_listen_port(),
│   │                      # enhanced_path(), HTTP client builders
│   ├── config.rs         # openclaw.json 读写、版本检测、备份恢复、
│   │                      # npm registry、Git 配置、doctor_check/fix
│   ├── service.rs        # 服务启停（launchctl/systemd/直接进程）、
│   │                      # Guardian 守护、状态轮询
│   ├── agent.rs          # Agent CRUD、身份编辑、模型绑定、备份
│   ├── logs.rs           # 日志读取、关键词搜索
│   ├── memory.rs         # 记忆文件读写、删除、ZIP导出
│   ├── messaging.rs      # 消息渠道配置（飞书/钉钉/TG/Discord/QQ）
│   │                      # Agent-渠道绑定管理
│   ├── pairing.rs        # 设备配对（auto_pair_device / check_pairing_status）
│   ├── device.rs         # create_connect_frame（Gateway握手）
│   ├── extensions.rs     # cftunnel 状态/启停、ClawApp 状态
│   ├── skills.rs         # openclaw skills CLI 封装
│   ├── assistant.rs       # AI 助手工具（读文件/写文件/执行命令/
│   │                      # 目录浏览/进程列表/端口检测/网页搜索）
│   └── update.rs         # 前端热更新（检查/下载/回滚）、web-update 目录
├── models/
│   ├── mod.rs
│   └── types.rs          # Rust 端数据类型定义
├── tray.rs               # macOS/Windows 系统托盘配置
└── utils.rs              # （已整合到 commands/mod.rs）
```

---

## 3. 技术选型

### 3.1 为什么用 Tauri v2

| 考量 | Tauri v2 | Electron |
|------|----------|----------|
| 体积 | ~8MB 安装包 | ~150MB+ |
| 内存 | Rust 后端，内存占用极低 | Node.js + Chromium，内存占用高 |
| 安全性 | 默认沙盒，CSP 严格 | 需要额外配置 |
| 开发者体验 | 需配 Rust 环境 | 前端开发者熟悉 |
| Plugin 生态 | tauri-plugin-shell/autostart 等成熟 | electron-forge 等 |

**决策**：ClawPanel 需要长期后台运行（Gateway 守护），对内存和体积敏感，选 Tauri v2。

### 3.2 为什么用纯 CSS（不用 CSS 框架）

- **零依赖**：没有 Bootstrap/Tailwind 的运行时开销
- **CSS Variables**：一套变量支持暗色/亮色主题切换
- **玻璃拟态风格**：用 `backdrop-filter: blur()` 实现毛玻璃效果，无需图片素材
- **按需加载**：每个页面独立 CSS，按路由懒加载

### 3.3 为什么用 Vanilla JS（不用 React/Vue）

- **轻量**：无需 Virtual DOM，页面切换零框架开销
- **无构建配置**：Vite 直接 serve 原生 ES Module
- **调试友好**：浏览器 DevTools 直接看到真实 DOM 结构
- **代码边界清晰**：每个页面是一个独立的 JS 模块，职责明确

### 3.4 为什么自研路由（不用 vue-router/react-router）

- **极简需求**：只需要 hash 路由 + 懒加载，无需嵌套路由、过渡动画等
- **竞态防护**：`loadRoute()` 用 `_loadId` 计数器防止快速切换时的竞态
- **无依赖**：5KB 代码，无外部依赖

---

## 4. 双模式部署

### 4.1 模式检测

```javascript
// 桌面端：window.__TAURI_INTERNALS__ 存在
const isTauri = !!window.__TAURI_INTERNALS__
```

### 4.2 桌面端架构

```
用户操作 → Tauri IPC (invoke) → Rust Commands → Shell Plugin → OpenClaw CLI
                                                      ↓
                                              Gateway (Node.js)
                                                      ↓
                                              WebSocket → 前端聊天页面
```

### 4.3 Web 端架构

```
用户操作 → HTTP API (/__api/*) → dev-api.js / serve.js → OpenClaw CLI
                                          ↓
                                  Gateway (Node.js)
                                          ↓
                                  WebSocket → 前端聊天页面
```

Web 端通过 Vite proxy 将 `/ws` 代理到 Gateway 的 WebSocket 端口。

### 4.4 Mock 模式（前端开发）

`npm run dev` 时，Vite plugin `devApiPlugin()` 注入 mock 后端，模拟：
- OpenClaw 安装状态
- Gateway 启停
- 模型列表
- Agent 配置

无需安装 OpenClaw 即可开发调试前端。

---

## 5. 关键设计决策

### 5.1 配置文件集中管理

```
~/.openclaw/
├── openclaw.json       # OpenClaw 主配置（模型、Gateway、渠道等）
└── clawpanel.json      # ClawPanel 自身配置（密码、代理、语言等）
```

ClawPanel 通过 `openclawDir` 支持自定义 OpenClaw 目录路径（用于多实例隔离）。

### 5.2 窗口关闭行为

桌面端点击关闭按钮时，窗口隐藏到系统托盘（不退出应用），防止误关导致 Gateway 守护中断。

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();  // 最小化到托盘
    }
})
```

### 5.3 Gateway 守护机制

`service::start_backend_guardian()` 在应用启动时运行，通过 `tauri-plugin-autostart` 注册为开机自启 Agent，确保 Gateway 始终保持运行。Windows 上使用 `CREATE_NO_WINDOW` 标志启动 Gateway 进程，避免弹出终端窗口。

### 5.4 热更新协议

桌面端支持前端热更新，不发版就能修复问题：

1. 检查 `~/.openclaw/clawpanel/web-update/` 目录
2. 有更新文件则优先从该目录读取（`lib.rs` 中的 URI Scheme Protocol）
3. 无则回退到内嵌的 web resource

---

## 6. 快速参考

### 关键路径

| 用途 | 路径 |
|------|------|
| OpenClaw 配置目录 | `~/.openclaw/` 或 `clawpanel.json` 中自定义路径 |
| ClawPanel 配置 | `~/.openclaw/clawpanel.json` |
| 热更新目录 | `~/.openclaw/clawpanel/web-update/` |
| Gateway 默认端口 | `18789` |

### 常用开发命令

```bash
# 完整桌面端开发
./scripts/dev.sh

# 前端独立开发（mock 模式）
./scripts/dev.sh web

# Rust 编译检查
./scripts/build.sh check

# 生产构建
./scripts/build.sh release
```

### 关键环境变量（PATH 增强）

`enhanced_path()` 在系统 PATH 基础上追加了：
- nvm/volta/fnm/nodenv 管理的 Node.js 路径
- npm 全局安装路径
- standalone 安装目录

解决 macOS 从 Finder 启动时 PATH 不完整导致找不到 Node.js 的问题。