# ClawPanel 前端架构详解

## 1. 模块职责总览

前端采用**零框架 + 极简路由 + 模块懒加载**的架构，每个页面是一个独立 JS 模块。

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `main.js` | boot()、认证流程、路由注册、Gateway 状态监听 |
| 路由 | `router.js` | hash 路由、懒加载、竞态防护 |
| 页面 | `pages/*.js` | 20 个页面模块，导出 render() 或 default |
| 组件 | `components/*.js` | sidebar、modal、toast、ai-drawer、engagement |
| 工具库 | `lib/*.js` | Tauri IPC、WebSocket、状态、主题、i18n |
| 样式 | `style/*.css` | CSS Variables、布局、组件、页面样式 |

---

## 2. 路由机制（router.js）

### 2.1 核心 API

```javascript
registerRoute(path, loader)   // 注册路由：path 是 hash 路径，loader 是 () => import('...')
initRouter(contentEl)         // 初始化：传入页面容器 DOM 元素
navigate(path)                // 编程式导航：window.location.hash = path
setDefaultRoute(path)         // 设置默认路由（未匹配时）
getCurrentRoute()             // 获取当前路由
reloadCurrentRoute()          // 重新加载当前页面
```

### 2.2 路由注册

`main.js` 在 `boot()` 中注册所有 20 个路由：

```javascript
registerRoute('/dashboard',    () => import('./pages/dashboard.js'))
registerRoute('/chat',        () => import('./pages/chat.js'))
registerRoute('/services',    () => import('./pages/services.js'))
// ... 共20个
```

页面模块使用动态 import，实现**代码分割 + 懒加载**。

### 2.3 加载流程

```
hashchange → loadRoute()
  ├─ 清理上一个页面（_currentCleanup()）
  ├─ 记录 loadId（递增计数器）
  ├─ 从 _moduleCache 查找缓存
  │    ├─ 未缓存：显示 spinner → retryLoad(loader, 3次, 500ms间隔)
  │    └─ 已缓存：直接使用
  ├─ 调用 mod.render() 或 mod.default（15s 超时）
  ├─ 竞态检查：thisLoad !== _loadId → 丢弃结果
  └─ 插入页面内容到 _contentEl
```

### 2.4 竞态防护

```javascript
let _loadId = 0  // 全局递增计数器

async function loadRoute() {
  const thisLoad = ++_loadId   // 记录本次加载 ID

  // 期间用户又切换了路由？
  if (thisLoad !== _loadId) return  // 是 → 丢弃结果
}
```

### 2.5 页面清理

每个页面模块可以导出 `cleanup()` 函数，页面切换时自动调用：

```javascript
// pages/chat.js 示例
export function cleanup() {
  wsClient.disconnect()
  clearInterval(pollTimer)
}

export async function render() {
  // ...
}
```

---

## 3. 状态管理（lib/）

### 3.1 app-state.js — 全局状态

```javascript
// 导出函数（均为 getter/setter 闭包）
isOpenclawReady()       // OpenClaw 是否已安装就绪
isGatewayRunning()       // Gateway 是否在运行
isUpgrading()           // 是否正在升级
getActiveInstance()      // 当前活跃实例 { type, name, endpoint, gatewayPort }
loadActiveInstance()     // 加载实例信息
detectOpenclawStatus()  // 触发状态检测
startGatewayPoll()       // 启动 Gateway 状态轮询

// 事件订阅
onGatewayChange(cb)      // Gateway 状态变化时回调
onInstanceChange(cb)     // 实例切换时回调
onGuardianGiveUp(cb)     // Guardian 放弃时回调
resetAutoRestart()       // 重置自动重启标记
```

### 3.2 ws-client.js — WebSocket 客户端

管理前端与 Gateway 的 WebSocket 连接：

```javascript
wsClient.connect(host, token)    // 连接（host 通常是 127.0.0.1:18789）
wsClient.disconnect()             // 断开连接
wsClient.send(data)               // 发送消息
wsClient.onMessage(handler)       // 消息处理
wsClient.onClose(handler)         // 断开处理（触发自动重连）
wsClient.connected                 // 连接状态布尔值
```

连接建立后自动维护心跳，超时自动重连。

### 3.3 tauri-api.js — Tauri IPC 封装

所有前端 → Rust 的 IPC 调用都通过此模块：

```javascript
// 封装为 async 函数
api.readOpenclawConfig()         // → config::read_openclaw_config
api.writeOpenclawConfig(cfg)      // → config::write_openclaw_config
api.startService('ai.openclaw.gateway')  // → service::start_service
api.readLogTail('gateway', 50)    // → logs::read_log_tail
// ... 约 90 个命令
```

Web 模式下，同一模块透明切换到 HTTP API（`fetch('/__api/*')`），通过 `dev-api.js` 或 `serve.js` 代理到 OpenClaw CLI。

### 3.4 模式检测

```javascript
const isTauri = !!window.__TAURI_INTERNALS__

if (isTauri) {
  // 调用 Tauri 命令
  const cfg = await api.readPanelConfig()
} else {
  // 调用 Web API
  const resp = await fetch('/__api/auth_check', ...)
}
```

---

## 4. 主题系统（lib/theme.js + style/variables.css）

### 4.1 CSS Variables

```css
:root, [data-theme="dark"] {
  --bg-primary: #0f0f0f;
  --bg-secondary: #1a1a1a;
  --bg-tertiary: #252525;
  --text-primary: #f5f5f5;
  --text-secondary: #a1a1aa;
  --border: #2e2e2e;
  --accent: #6366f1;
  /* ... */
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --bg-tertiary: #ebebeb;
  --text-primary: #18181b;
  /* ... */
}
```

### 4.2 切换机制

```javascript
// theme.js
export function initTheme() {
  const saved = localStorage.getItem('clawpanel_theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = saved || (prefersDark ? 'dark' : 'light')
  document.documentElement.setAttribute('data-theme', theme)
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme')
  const next = current === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('clawpanel_theme', next)
}
```

---

## 5. 国际化（lib/i18n.js + locales/）

### 5.1 结构

```
locales/
├── index.js       # 初始化 i18n，导出 t() 函数
├── helper.js      # 翻译辅助函数
├── zh-CN.json     # 中文简体
├── en.json        # 英文
├── zh-TW.json     # 中文繁体
├── ja.json        # 日语
├── ko.json        # 韩语
├── de.json / es.json / fr.json / pt.json / ru.json / vi.json
└── modules/       # 按页面拆分的翻译块
    ├── dashboard.js
    ├── chat.js
    └── ...
```

### 5.2 使用

```javascript
import { t } from './lib/i18n.js'

// 模板中使用
t('dashboard.title')           // "仪表盘"
t('common.save')               // "保存"
t('chat.websocketConnected')   // "WebSocket 已连接"
```

翻译字符串支持嵌套 key 和复数形式。

---

## 6. AI 助手抽屉（components/ai-drawer.js）

### 6.1 功能

右侧滑出的 AI 助手面板，提供 4 种操作模式：

| 模式 | 图标 | 工具调用 | 写文件 | 确认 |
|------|------|----------|--------|------|
| 聊天 | 💬 | ❌ | ❌ | — |
| 规划 | 📋 | ✅ | ❌ | ✅ |
| 执行 | ⚡ | ✅ | ✅ | ✅ |
| 无限 | ∞ | ✅ | ✅ | ❌ |

### 6.2 八大工具

| 工具 | Rust 命令 | 功能 |
|------|-----------|------|
| `ask_user` | — | 向用户提问（单选/多选/文本） |
| `get_system_info` | `assistant::assistant_system_info` | 获取 OS、架构、主目录 |
| `run_command` | `assistant::assistant_exec` | 执行 Shell 命令 |
| `read_file` | `assistant::assistant_read_file` | 读取文件 |
| `write_file` | `assistant::assistant_write_file` | 写入文件 |
| `list_directory` | `assistant::assistant_list_dir` | 浏览目录 |
| `list_processes` | `assistant::assistant_list_processes` | 查看进程 |
| `check_port` | `assistant::assistant_check_port` | 检测端口占用 |

### 6.3 上下文注册

`main.js` 中注册各页面的上下文提供器，AI 助手打开时可自动获取当前页面状态：

```javascript
registerPageContext('/chat-debug', async () => {
  return { detail: '## 系统诊断快照\n...' }
})
registerPageContext('/services', async () => {
  return { detail: '## 服务状态\n...' }
})
```

---

## 7. 页面模块规范

每个页面模块（`pages/*.js`）遵循以下规范：

```javascript
// pages/example.js

// 可选：清理函数，页面切换时调用
export function cleanup() {
  // 取消定时器、断开 WebSocket、清除状态
}

// 必须：render 函数（async）
export async function render() {
  const container = document.createElement('div')
  container.className = 'page'

  // 渲染逻辑...
  // 调用 api / wsClient

  return container  // 返回 DOM 元素或 HTML 字符串
}

// 或者导出 default
export default { render, cleanup }
```

页面模块应做到：
- **自包含**：自己的状态、数据获取、事件处理
- **可清理**：切换页面时清除副作用
- **异步渲染**：数据获取在 render() 内完成，不依赖外部状态

---

## 8. CSS 架构

### 8.1 文件划分

| 文件 | 内容 |
|------|------|
| `variables.css` | CSS Variables（颜色、字体、圆角、阴影） |
| `reset.css` | 浏览器默认样式重置 |
| `layout.css` | sidebar + content 整体布局 |
| `components.css` | 按钮、输入框、卡片、表格等通用组件 |
| `pages.css` | 所有页面通用样式（分页、标题等） |
| `chat.css` | 聊天页面专用（消息气泡、输入区等） |
| `agents.css` | Agent 页面 |
| `debug.css` | chat-debug 页面 |
| `assistant.css` | AI 助手页面 |
| `ai-drawer.css` | AI 抽屉样式 |

### 8.2 命名约定

- BEM-lite：`nav-item`、`page-loader`、`login-card`
- 功能前缀：`btn-*`、`modal-*`、`toast-*`、`gw-banner-*`
- 页面前缀：`chat-*`、`agent-*`、`dashboard-*`

### 8.3 玻璃拟态效果

```css
.glass-card {
  background: rgba(30, 30, 30, 0.8);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-lg);
}
```