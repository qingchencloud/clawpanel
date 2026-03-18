# 贡献指南 & 维护手册

感谢你对 ClawPanel 项目的关注！本文档同时作为**贡献指南**和**项目维护手册**，涵盖开发、构建、发版、部署的完整工作流。

> **官网**: [claw.qt.cool](https://claw.qt.cool/)  |  **仓库**: [github.com/qingchencloud/clawpanel](https://github.com/qingchencloud/clawpanel)

---

## 目录

- [开发环境要求](#开发环境要求)
- [项目结构](#项目结构)
- [运行模式](#运行模式)
- [版本管理](#版本管理)
- [发版流程](#发版流程)
- [CI/CD 工作流](#cicd-工作流)
- [配置文件说明](#配置文件说明)
- [关键脚本](#关键脚本)
- [前端开发约定](#前端开发约定)
- [Rust 后端约定](#rust-后端约定)
- [安全机制](#安全机制)
- [部署模式](#部署模式)
- [分支与提交规范](#分支与提交规范)
- [PR 流程](#pr-流程)
- [代码规范](#代码规范)
- [问题反馈](#问题反馈)

---

## 开发环境要求

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| Node.js | 18+ | 前端构建（推荐 22 LTS） |
| Rust | stable | Tauri 后端编译 |
| Tauri CLI | v2 | `cargo install tauri-cli --version "^2"` |

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel

# 安装前端依赖
npm install
```

#### macOS / Linux

```bash
# 启动完整 Tauri 桌面应用
./scripts/dev.sh

# 仅启动前端（浏览器调试，含 dev-api 真实后端）
./scripts/dev.sh web
```

#### Windows

```powershell
# 启动完整 Tauri 桌面应用
npm run tauri dev

# 仅启动前端（浏览器调试，含 dev-api 真实后端）
npm run dev
```

> Windows 开发需要安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选「使用 C++ 的桌面开发」工作负载）和 [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10+ 通常已预装）。

---

## 项目结构

```
clawpanel/
├── src/                        # 前端源码（Vanilla JS + Vite）
│   ├── pages/                  # 页面模块（每个导出 render()）
│   │   ├── dashboard.js        #   仪表盘
│   │   ├── assistant.js        #   AI 助手
│   │   ├── chat.js             #   实时聊天
│   │   ├── chat-debug.js       #   聊天调试（WebSocket）
│   │   ├── services.js         #   服务管理
│   │   ├── logs.js             #   日志查看
│   │   ├── config.js           #   模型配置
│   │   ├── gateway.js          #   网关配置
│   │   ├── agents.js           #   Agent 管理
│   │   ├── memory.js           #   记忆管理
│   │   ├── extensions.js       #   扩展工具
│   │   ├── security.js         #   安全设置
│   │   ├── setup.js            #   初始设置向导
│   │   └── about.js            #   关于页面
│   ├── components/             # 通用组件
│   │   ├── sidebar.js          #   侧边导航栏
│   │   ├── toast.js            #   消息提示
│   │   └── modal.js            #   弹窗组件
│   ├── lib/                    # 工具库
│   │   ├── tauri-api.js        #   Tauri API 封装（含 Web fallback + mock）
│   │   ├── theme.js            #   主题切换（暗色/亮色）
│   │   └── app-state.js        #   应用状态管理
│   ├── style/                  # CSS 样式（CSS Variables 驱动）
│   │   ├── variables.css       #   CSS 变量定义（主题色、间距、字号）
│   │   ├── base.css            #   基础样式重置
│   │   ├── layout.css          #   布局（侧边栏、内容区）
│   │   ├── components.css      #   组件样式（按钮、表单、卡片）
│   │   ├── pages.css           #   页面通用样式
│   │   ├── chat.css            #   聊天页样式
│   │   ├── agents.css          #   Agent 页样式
│   │   ├── debug.css           #   调试页样式
│   │   └── assistant.css       #   AI 助手页样式
│   ├── router.js               # Hash 路由
│   └── main.js                 # 入口文件（含密码保护逻辑）
├── src-tauri/                  # Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs              #   入口 + 命令注册
│   │   ├── commands/           #   Tauri 命令（按功能模块拆分）
│   │   │   ├── mod.rs          #     模块注册 + 环境变量构建
│   │   │   ├── config.rs       #     配置读写 + 版本管理 + 面板配置
│   │   │   ├── service.rs      #     Gateway 服务管理（跨平台）
│   │   │   ├── agent.rs        #     Agent CRUD
│   │   │   ├── memory.rs       #     记忆文件管理
│   │   │   ├── logs.rs         #     日志读取/搜索
│   │   │   ├── device.rs       #     设备密钥 + Gateway 握手
│   │   │   ├── pairing.rs      #     设备配对
│   │   │   ├── extensions.rs   #     扩展工具（cftunnel / clawapp）
│   │   │   └── assistant.rs    #     AI 助手工具调用
│   │   ├── models/             #   数据模型
│   │   ├── tray.rs             #   系统托盘
│   │   └── utils.rs            #   工具函数
│   ├── Cargo.toml              # Rust 依赖 + 版本号
│   └── tauri.conf.json         # Tauri 配置 + 版本号
├── scripts/                    # 开发与运维脚本
│   ├── dev.sh                  #   macOS/Linux 开发启动
│   ├── dev-api.js              #   Vite 插件：Web 模式真实后端 API
│   ├── build.sh                #   macOS/Linux 编译与打包
│   ├── linux-deploy.sh         #   Linux 服务器一键部署
│   └── sync-version.js         #   版本号同步脚本
├── docs/                       # 文档与截图
│   ├── index.html              #   官网（claw.qt.cool）
│   ├── linux-deploy.md         #   Linux 部署指南
│   └── docker-deploy.md        #   Docker 部署指南
├── public/                     # 静态资源（图标、Logo）
├── .github/workflows/          # CI/CD
│   ├── ci.yml                  #   持续集成（push/PR → 检查）
│   └── release.yml             #   发布构建（tag → 全平台打包）
├── .windsurf/workflows/        # Cascade AI 工作流
│   └── release.md              #   发版工作流指令
├── package.json                # 前端依赖 + 版本号（唯一真相源）
├── vite.config.js              # Vite 配置
├── CHANGELOG.md                # 更新日志
├── CONTRIBUTING.md             # 本文件
├── SECURITY.md                 # 安全政策
└── README.md                   # 项目介绍
```

---

## 运行模式

ClawPanel 有两种运行模式，前端代码通过 `isTauri` 标志自动适配：

| 模式 | 启动方式 | 后端 | API 通信 | 适用场景 |
|------|----------|------|----------|----------|
| **Tauri 桌面** | `npm run tauri dev` | Rust (IPC) | `window.__TAURI_INTERNALS__` → `invoke()` | macOS / Windows / Linux 桌面 |
| **Web 浏览器** | `npm run dev` | Node.js (`dev-api.js`) | `fetch('/__api/xxx')` | Linux 服务器远程管理 |

### API 调用链路

```
前端代码
  ↓
tauri-api.js  →  isTauri?
  ├─ YES → invoke() → Rust IPC → src-tauri/src/commands/*.rs
  └─ NO  → webInvoke() → fetch('/__api/cmd') → scripts/dev-api.js
              ↓ 失败时
           mockInvoke() → 内置 mock 数据（仅用于无后端调试）
```

### Web 模式后端 (`dev-api.js`)

`scripts/dev-api.js` 是一个 Vite 插件，在 Web 模式下提供与 Tauri IPC 等效的 HTTP API。它：
- 拦截 `/__api/*` 请求
- 调用与 Rust 命令同名的 handler 函数
- 提供密码保护中间件（session + cookie）
- 实际执行 `openclaw` CLI 命令操作服务器

---

## 版本管理

### 版本号位置

版本号以 `package.json` 为**唯一真相源**，通过同步脚本分发到其他文件：

| 文件 | 字段 | 用途 |
|------|------|------|
| `package.json` | `version` | **主版本源** — npm、前端构建、侧边栏显示 |
| `src-tauri/tauri.conf.json` | `version` | Tauri 打包版本号 |
| `src-tauri/Cargo.toml` | `version` | Rust crate 版本号 |
| `docs/index.html` | `softwareVersion` | 官网 JSON-LD SEO |
| `CHANGELOG.md` | `## [x.y.z]` | 变更日志（需手动编写内容） |

### 同步命令

```bash
# 设置新版本并自动同步到所有文件
npm run version:set 0.6.0

# 仅同步当前 package.json 版本到其他文件
npm run version:sync
```

### 前端版本读取

侧边栏底部自动从 `package.json` 读取版本号，无需手动维护：

```javascript
import { version as APP_VERSION } from '../../package.json'
```

---

## 发版流程

### 完整步骤

```bash
# 1. 确认工作区干净
git status

# 2. 设置新版本号（自动同步到 tauri.conf.json / Cargo.toml / docs/index.html）
npm run version:set 0.6.0

# 3. 编写 CHANGELOG.md 变更记录

# 4. 提交
git add -A
git commit -m "chore: release v0.6.0"
git push origin main

# 5. 打 tag 触发自动构建
git tag v0.6.0
git push origin v0.6.0
```

### 发版后自动执行

推送 tag 后，GitHub Actions (`release.yml`) 会自动：
1. **并行构建** macOS ARM64 / macOS Intel / Linux / Windows 四个平台
2. **创建 GitHub Release** 并上传安装包（.dmg / .exe / .msi / .AppImage / .deb / .rpm）
3. 所有平台构建完成后，**自动生成 Release Notes**（含下载表格 + 分类 Changelog）

### 回滚

```bash
git tag -d v0.6.0
git push origin :refs/tags/v0.6.0
# 修复后重新打 tag
```

---

## CI/CD 工作流

### `ci.yml` — 持续集成

- **触发**：push 到 `main` 分支 或 PR 到 `main`
- **平台**：macOS / Linux / Windows 三平台并行
- **检查项**：
  1. `npm ci` — 前端依赖安装
  2. `cargo fmt --check` — Rust 代码格式
  3. `cargo check` — Rust 编译检查
  4. `cargo clippy -- -D warnings` — Rust lint（警告即失败）
  5. `npm run build` — 前端构建验证

### `release.yml` — 发布构建

- **触发**：推送 `v*` 标签 或 手动触发
- **平台**：macOS ARM64 / macOS Intel / Linux x64 / Windows x64
- **产物**：通过 `tauri-apps/tauri-action@v0` 构建并上传到 GitHub Release
- **Release Notes**：独立 job，等所有平台构建完成后统一生成

---

## 配置文件说明

### `~/.openclaw/openclaw.json`

OpenClaw 主配置文件，包含模型配置、网关配置等。由 ClawPanel 的"模型配置"和"网关配置"页面读写。

### `~/.openclaw/clawpanel.json`

ClawPanel 面板自身的配置文件，独立于 OpenClaw：

```json
{
  "accessPassword": "用户设置的访问密码",
  "mustChangePassword": true,
  "ignoreRisk": false,
  "nodePath": "/custom/node/path"
}
```

| 字段 | 说明 |
|------|------|
| `accessPassword` | 面板访问密码（明文存储，桌面端本地比对） |
| `mustChangePassword` | `true` = 首次登录后强制修改默认密码 |
| `ignoreRisk` | `true` = 无视风险模式，跳过密码保护 |
| `nodePath` | 用户自定义 Node.js 路径，补充到 PATH |

### `~/.openclaw/npm-registry.txt`

用户配置的 npm 源地址，默认 `https://registry.npmmirror.com`。

---

## 关键脚本

| 脚本 | 用途 |
|------|------|
| `scripts/dev.sh` | macOS/Linux 开发启动（清理旧进程 → 启动 Vite 或 Tauri） |
| `scripts/dev-api.js` | Vite 插件，Web 模式的 Node.js 后端（API + 认证中间件） |
| `scripts/build.sh` | macOS/Linux 构建脚本（支持 `check` / `release` 模式） |
| `scripts/linux-deploy.sh` | Linux 服务器一键部署（安装依赖 → 克隆仓库 → systemd 服务） |
| `scripts/sync-version.js` | 版本号同步（`package.json` → 其他 4 个文件） |

---

## 前端开发约定

### 页面模块

每个页面是一个独立 JS 模块，导出 `render()` 函数：

```javascript
export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `<!-- 页面骨架，含加载占位符 -->`

  // 非阻塞：先返回 DOM，数据在后台异步加载
  loadData(page)
  return page
}
```

**关键原则**：`render()` 必须立即返回 DOM 元素，不要 `await` 数据加载，否则会阻塞页面切换。

### 新增页面清单

1. 创建 `src/pages/xxx.js`，导出 `render()`
2. 在 `src/main.js` 注册路由：`registerRoute('/xxx', () => import('./pages/xxx.js'))`
3. 在 `src/components/sidebar.js` 的 `NAV_ITEMS_FULL` 中添加导航项
4. 在 `ICONS` 对象中添加对应图标 SVG

### API 调用

统一通过 `tauri-api.js` 封装，不要在页面中直接 `fetch`：

```javascript
import { api } from '../lib/tauri-api.js'

// 读（自带缓存）
const config = await api.readOpenclawConfig()

// 写（自动清缓存）
await api.writeOpenclawConfig(config)
```

### 双模式适配

页面中需要区分 Tauri/Web 行为时：

```javascript
const isTauri = !!window.__TAURI_INTERNALS__

if (isTauri) {
  // 桌面端：通过 Tauri IPC
  const { api } = await import('../lib/tauri-api.js')
  const cfg = await api.readPanelConfig()
} else {
  // Web 端：通过 HTTP API
  const resp = await fetch('/__api/xxx', { method: 'POST', ... })
}
```

---

## Rust 后端约定

### 新增 Tauri 命令

1. 在对应的 `src-tauri/src/commands/xxx.rs` 中添加 `#[tauri::command]` 函数
2. 在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中注册
3. 在 `src/lib/tauri-api.js` 的 `api` 对象中添加前端包装方法
4. 在 `mockInvoke` 的 `mocks` 对象中添加 mock 数据（供无后端调试）

### 跨平台代码

平台相关代码使用条件编译：

```rust
#[cfg(target_os = "macos")]
{
    // macOS: launchctl / plist
}
#[cfg(target_os = "linux")]
{
    // Linux: 进程管理 / systemd
}
#[cfg(target_os = "windows")]
{
    // Windows: openclaw CLI / tasklist
}
```

### PATH 与环境变量

Tauri 桌面应用启动时 PATH 可能不完整（macOS Finder 启动、Windows 非默认安装路径）。现在 ClawPanel 会在启动时构建并注入完整系统环境变量（用户 + 系统 + 进程），并在 PATH 中追加 `enhanced_path` 的补充路径。

- **默认规则**：外部命令直接继承系统环境（无需手动设置 PATH）
- **特殊情况**：如需补充 PATH，可使用 `super::enhanced_path()` 或 `apply_system_env` 辅助函数

---

## 安全机制

### 密码保护

ClawPanel 支持访问密码保护，**Web 模式和 Tauri 桌面端均可启用**：

| 模式 | 密码存储 | 验证方式 | 会话管理 |
|------|----------|----------|----------|
| Web | `clawpanel.json` | 后端比对 + HTTP-only Cookie | 服务端 session（24h TTL） |
| Tauri 桌面 | `clawpanel.json` | 前端本地比对 | `sessionStorage` |

### 密码保护流程

```
启动 → 读 clawpanel.json
  ├─ 无密码 + ignoreRisk → 放行
  ├─ 有密码 + 未认证 → 弹出登录覆盖层
  └─ 有密码 + mustChangePassword → 登录后强制改密码
```

### 安全设置页 (`/security`)

- 查看当前密码状态
- 修改密码（含强度校验：≥6 位、不能纯数字、不能常见弱密码）
- 无视风险模式（关闭密码保护，仅建议受信任内网）

---

## 部署模式

### 1. 桌面应用（Tauri）

面向 macOS / Windows / Linux 桌面用户，从 [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases) 下载安装包。

### 2. Linux 服务器（Web 版）

一键部署脚本，适用于无桌面环境的 Linux 服务器：

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

部署后通过 `http://服务器IP:1420` 访问，自动生成默认密码。

详见 [Linux 部署指南](docs/linux-deploy.md)。

### 3. Docker

详见 [Docker 部署指南](docs/docker-deploy.md)。

---

## 分支与提交规范

### 分支策略

- 所有开发基于 `main` 分支
- 新功能分支：`feature/功能描述`（例如 `feature/log-export`）
- 修复分支：`fix/问题描述`（例如 `fix/model-save-crash`）
- 完成后发起 PR 合并回 `main`

### 提交格式

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<类型>(可选范围): 简要描述
```

| 类型 | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(model): 新增模型批量测试功能` |
| `fix` | 修复 Bug | `fix(gateway): 修复端口配置未生效的问题` |
| `docs` | 文档变更 | `docs: 更新安装说明` |
| `style` | 代码格式 | `style(css): 统一按钮圆角` |
| `refactor` | 重构 | `refactor(router): 简化路由匹配逻辑` |
| `perf` | 性能优化 | `perf(router): 添加模块缓存避免重复加载` |
| `chore` | 构建/工具 | `chore: release v0.6.0` |
| `security` | 安全修复 | `security(api): 修复命令注入漏洞` |

---

## PR 流程

1. Fork 本仓库并克隆到本地
2. 从 `main` 创建新分支
3. 完成开发并进行本地测试
4. 确保代码风格一致、注释完整
5. 提交并推送到你的 Fork 仓库
6. 发起 Pull Request，描述清楚变更内容和测试情况
7. 等待代码审查，根据反馈修改

---

## 代码规范

- **前端**：使用 Vanilla JS，不引入第三方框架
- **注释**：所有代码注释使用中文
- **风格**：简洁清晰，避免过度封装
- **命名**：变量和函数使用 camelCase，CSS 类名使用 kebab-case
- **资源**：静态资源本地化，禁止引用远程 CDN
- **异步**：页面 `render()` 中禁止阻塞式 await，数据加载走后台异步
- **版本**：只改 `package.json`，运行 `npm run version:sync` 同步

---

## 问题反馈

如果发现 Bug 或有功能建议，欢迎通过 [GitHub Issues](https://github.com/qingchencloud/clawpanel/issues) 提交。
