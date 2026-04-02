# ClawPanel 核心数据流

## 1. 应用启动链路

### 1.1 桌面端启动

```
ClawPanel.app 入口
    ↓
main() → clawpanel_lib::run()
    ↓
lib.rs: run()
    ├─ Plugin 初始化
    │    ├─ tauri_plugin_shell::init()
    │    └─ tauri_plugin_autostart::init()
    │
    ├─ URI Scheme Protocol 注册（tauri://）
    │
    ├─ setup():
    │    ├─ service::start_backend_guardian()  → 启动 Guardian 后台守护
    │    └─ tray::setup_tray()                 → 配置系统托盘
    │
    ├─ invoke_handler 注册 ~90 个命令
    │
    └─ run() → 事件循环
         ↓
    窗口显示
         ↓
    前端 main.js: boot()
         ├─ registerRoute() 注册20个路由
         ├─ initRouter() 初始化路由
         ├─ checkAuth() 访问密码检查
         ├─ loadActiveInstance() 加载活跃实例
         ├─ detectOpenclawStatus() 检测安装状态
         │    └─ api.checkInstallation()
         │
         ├─ setupGatewayBanner() Gateway未运行提示
         ├─ startGatewayPoll() 启动状态轮询
         │
         ├─ autoConnectWebSocket()
         │    ├─ api.autoPairDevice() 设备配对
         │    ├─ api.patchModelVision() 添加vision支持
         │    ├─ api.reloadGateway() 重载配置
         │    └─ wsClient.connect() 建立WebSocket
         │
         └─ onGatewayChange() 监听状态变化
```

### 1.2 Web 端启动

```
npm run serve → serve.js (Node.js)
    ↓
Express 服务器启动，监听 1420
    ↓
前端浏览器访问 http://localhost:1420
    ↓
main.js: boot()
    ├─ checkBackendHealth() → fetch('/__api/health')
    │    └─ 后端离线 → showBackendDownOverlay()
    │
    ├─ checkAuth() → fetch('/__api/auth_check')
    │    └─ 需要密码 → showLoginOverlay()
    │
    ├─ loadActiveInstance()
    ├─ detectOpenclawStatus()
    │    └─ fetch('/__api/check_installation')
    │
    └─ autoConnectWebSocket()
         └─ wsClient.connect() → proxy 到 Gateway WebSocket
```

### 1.3 Mock 开发模式启动

```
npm run dev → Vite Dev Server
    ↓
dev-api.js (Vite Plugin) 注入 mock handler
    ↓
浏览器访问 http://localhost:1420
    ↓
前端请求 /__api/* 被 dev-api.js 拦截
    ↓
返回模拟数据（安装状态、Gateway 状态、模型列表等）
```

---

## 2. 用户操作数据流

### 2.1 读取配置

```
用户：打开模型配置页面
    ↓
pages/models.js: render()
    ↓
api.readOpenclawConfig()
    ↓
桌面端: invoke('read_openclaw_config')
    ↓
Rust: config::read_openclaw_config()
    ├─ openclaw_dir() 解析配置目录
    ├─ 读 openclaw.json
    └─ 返回 JSON 响应
    ↓
前端：渲染模型列表 UI
```

### 2.2 启动服务

```
用户：点击「启动」Gateway
    ↓
pages/services.js → api.startService('ai.openclaw.gateway')
    ↓
桌面端: invoke('start_service', { name })
    ↓
Rust: service::start_service()
    ├─ enhanced_path() 获取完整 PATH
    ├─ 选择启动方式：
    │    ├─ macOS: launchctl
    │    ├─ Linux: systemd
    │    └─ Windows: 直接进程
    └─ 执行 openclaw start --gateway
    ↓
返回 { success: true }
    ↓
前端：更新服务状态 UI → 绿色「运行中」
```

### 2.3 聊天消息

```
用户：在聊天框输入消息，按发送
    ↓
pages/chat.js → wsClient.send(JSON.stringify({type: 'chat', content, ...}))
    ↓
WebSocket 连接（ws://127.0.0.1:18789/ws，Token 认证）
    ↓
Gateway (Node.js) 接收消息
    ├─ 解析请求，路由到对应 Agent
    ├─ 调用 AI 模型（DeepSeek / MiniMax / OpenAI / ...）
    └─ 流式响应（Server-Sent Events）
    ↓
WebSocket 推送 {type: 'chunk', content: '...'}
    ↓
wsClient.onMessage() → 渲染到聊天窗口
    ↓
完成：{type: 'done', usage: {...}}
```

---

## 3. WebSocket 连接管理

### 3.1 连接时机

```
应用启动 → detectOpenclawStatus() → isGatewayRunning()
    ├─ true → autoConnectWebSocket()
    └─ false → 显示 Gateway 未运行 Banner

Gateway 状态变化（轮询触发 onGatewayChange）
    ├─ running → autoConnectWebSocket()
    └─ stopped → wsClient.disconnect()
```

### 3.2 连接参数

```javascript
// autoConnectWebSocket() 核心逻辑
const config = await api.readOpenclawConfig()
const port = config?.gateway?.port || 18789
const token = config?.gateway?.auth?.token || ''

// 远程实例
if (inst.type !== 'local' && inst.endpoint) {
  host = `${url.hostname}:${inst.gatewayPort || port}`
} else {
  host = isTauri ? `127.0.0.1:${port}` : location.host
}

wsClient.connect(host, token)
```

### 3.3 自动重连

`ws-client.js` 内部维护重连逻辑：

```javascript
// 断开时自动重连（指数退避）
socket.on('close', () => {
  if (!manualDisconnect) {
    setTimeout(() => reconnect(), delay)
    delay = Math.min(delay * 2, MAX_DELAY)
  }
})
```

---

## 4. 设备配对流程

```
autoConnectWebSocket() 前提条件
    ↓
api.autoPairDevice()
    ├─ 调用 device::create_connect_frame()
    │    ├─ 生成 Ed25519 密钥对
    │    ├─ 读取 OpenClaw 公钥
    │    ├─ 生成 CONNECT Frame
    │    └─ 返回签名后的 Frame
    │
    └─ 调用 pairing::auto_pair_device()
         ├─ 读取 openclaw.json
         ├─ 获取本机设备信息
         ├─ 写入 allowedOrigins（允许 ClawPanel 域名访问 Gateway）
         └─ 如果 origins 有变化 → needReload = true
```

配对成功后，Gateway 允许来自 ClawPanel 的 WebSocket 连接。

---

## 5. AI 助手工具调用

```
用户在 AI 助手中输入命令
    ↓
助手 LLM 返回 tool_call
    ↓
前端调用对应 Rust 命令：
    ├─ assistant_exec(cmd, args)    → 执行 Shell 命令
    ├─ assistant_read_file(path)   → 读文件
    ├─ assistant_write_file(...)   → 写文件
    ├─ assistant_list_dir(path)   → 列目录
    ├─ assistant_system_info()     → 系统信息
    ├─ assistant_list_processes()  → 进程列表
    ├─ assistant_check_port(port)  → 端口检测
    └─ assistant_web_search(query) → 网页搜索
    ↓
结果返回助手 → LLM 整合结果 → 返回给用户
```

---

## 6. 热更新流程

```
应用启动 → update::check_frontend_update()
    ↓
有更新 → 显示更新 Banner
    ↓
用户点击「热更新」
    ↓
api.downloadFrontendUpdate(url, hash)
    ↓
Rust: update::download_frontend_update()
    ├─ reqwest 下载 zip
    ├─ 验证 hash
    ├─ 解压到 ~/.openclaw/clawpanel/web-update/
    └─ 返回成功
    ↓
前端 window.location.reload()
    ↓
lib.rs: URI Scheme Protocol
    ├─ 请求 /index.html
    ├─ 检查 web-update/index.html 是否存在
    │    ├─ 存在 → 返回新文件
    │    └─ 不存在 → 回退到内嵌 resource
    └─ 浏览器加载新前端
```

---

## 7. 主题切换流程

```
用户点击主题切换
    ↓
toggleTheme()
    ↓
document.documentElement.setAttribute('data-theme', next)
    ↓
localStorage.setItem('clawpanel_theme', next)
    ↓
CSS Variables 响应式变化
    └─ 页面无需刷新，所有样式实时切换
```