# ClawPanel Docker 多实例管理 — 技术规划

> 版本: v1.0 | 日期: 2026-03-08

## 1. 问题分析

### 1.1 现状

ClawPanel 当前架构是 **单实例管理**：

```
浏览器 → ClawPanel 前端
              │
              ├── /__api/* → dev-api.js → 读写本机 ~/.openclaw/ 文件
              ├── /ws     → 代理到本机 Gateway:18789 (WebSocket)
              └── 静态文件  → dist/
```

**所有页面**（模型配置、Agent 管理、Gateway 设置、日志、聊天等）操作的都是：
- 本机文件系统上的 `~/.openclaw/openclaw.json`
- 本机运行的 Gateway 进程（端口 18789）

### 1.2 Phase 1 已完成

Docker 集群页面实现了 **容器生命周期管理**（通过 Docker Socket API）：
- 启动/停止/重启/删除容器
- 部署新容器（端口映射、数据卷、环境变量）
- 查看容器日志
- 多节点管理（本机 + 远程 Docker 主机）

### 1.3 缺口

Docker 页面能管容器的"壳"，但 **无法管理容器里的 OpenClaw**：
- 无法配置某个容器内的模型
- 无法查看某个容器内的 Gateway 日志
- 无法管理某个容器内的 Agent
- 聊天功能只连本机 Gateway

---

## 2. 目标架构

### 2.1 核心思路：API 代理 + 实例切换

```
┌──────────────────────────────────────────────────┐
│                  ClawPanel 前端                   │
│  ┌────────────────────────────────────────────┐  │
│  │  实例切换器: [ ● 本机 ▼ ]                    │  │
│  │              [ ○ prod-server (Docker) ]     │  │
│  │              [ ○ dev-box (远程) ]           │  │
│  │              [ + 添加实例 ]                  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  现有页面（模型/Agent/Gateway/日志/聊天...）        │
│       │                                          │
│       │ api.readOpenclawConfig()                  │
│       │ api.listAgents()                         │
│       ▼                                          │
│  tauri-api.js → webInvoke('read_openclaw_config') │
│                    │                              │
│              自动附带 instanceId                   │
└──────────────────┼───────────────────────────────┘
                   ▼
         dev-api.js (本机后端)
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
       本机文件  代理转发   代理转发
     ~/.openclaw  ↓         ↓
              实例 A     实例 B
          http://host   http://192.168.1.100
            :18790        :1420
           /__api/*     /__api/*
```

**关键点：每个 Docker 容器运行 full 镜像，内含完整的 ClawPanel (serve.js) + Gateway。**
因此每个容器已经有自己的 `/__api/*` 端点，我们只需要代理请求过去。

### 2.2 WebSocket 连接

```
切换实例时：
  wsClient.disconnect()  ← 断开旧连接
  wsClient.connect(newHost, newToken)  ← 连接新实例的 Gateway
```

WebSocket 连接信息从目标实例的配置中读取（通过代理 API 获取 `read_openclaw_config`）。

### 2.3 自动组网流程

部署新容器时自动完成：

```
用户点击「部署容器」
    │
    ├─ 1. Docker API 创建容器（端口映射 hostPort→1420, hostPort→18789）
    ├─ 2. 启动容器，等待健康检查通过
    ├─ 3. 探测容器 Panel 端点：GET http://hostIP:hostPort/__api/check_installation
    ├─ 4. 自动写入实例注册表 ~/.openclaw/instances.json
    └─ 5. 前端自动刷新实例列表
```

---

## 3. 数据结构

### 3.1 实例注册表

文件位置：`~/.openclaw/instances.json`

```json
{
  "activeId": "local",
  "instances": [
    {
      "id": "local",
      "name": "本机",
      "type": "local",
      "endpoint": null,
      "gatewayPort": 18789,
      "addedAt": 1741420800,
      "note": ""
    },
    {
      "id": "docker-abc123",
      "name": "openclaw-prod",
      "type": "docker",
      "endpoint": "http://127.0.0.1:18790",
      "gatewayPort": 18789,
      "containerId": "abc123def456",
      "nodeId": "local",
      "addedAt": 1741420900,
      "note": "生产环境"
    },
    {
      "id": "remote-1",
      "name": "办公室服务器",
      "type": "remote",
      "endpoint": "http://192.168.1.100:1420",
      "gatewayPort": 18789,
      "addedAt": 1741421000,
      "note": ""
    }
  ]
}
```

**三种实例类型：**

| type | 说明 | 来源 |
|------|------|------|
| `local` | 本机 OpenClaw | 始终存在，不可删除 |
| `docker` | Docker 容器内的 OpenClaw | 部署容器时自动注册 |
| `remote` | 远程服务器上的 OpenClaw | 用户手动添加 |

### 3.2 实例状态（运行时，不持久化）

```js
{
  id: 'docker-abc123',
  online: true,           // 健康检查结果
  version: '2026.3.5',    // OpenClaw 版本
  gatewayRunning: true,   // Gateway 状态
  lastCheck: 1741420999,  // 上次检查时间
}
```

---

## 4. 改动清单

### 4.1 后端 dev-api.js

#### 4.1.1 实例注册表管理（新增）

```
新增 handlers:
  instance_list          → 读取 instances.json
  instance_add           → 添加实例（手动或自动）
  instance_remove        → 删除实例
  instance_set_active    → 切换活跃实例
  instance_health_check  → 健康检查单个实例
  instance_health_all    → 批量健康检查
```

#### 4.1.2 API 代理转发（核心改动）

改造 `_apiMiddleware`：

```js
// 伪代码
async function _apiMiddleware(req, res, next) {
  if (!req.url?.startsWith('/__api/')) return next()

  const cmd = extractCmd(req.url)
  const body = await readBody(req)

  // 实例管理命令 → 始终本机处理
  if (cmd.startsWith('instance_') || cmd.startsWith('docker_') || ALWAYS_LOCAL.has(cmd)) {
    return handleLocally(cmd, body, res)
  }

  // 获取当前活跃实例
  const active = getActiveInstance()

  if (active.type === 'local') {
    // 本机 → 直接处理（现有逻辑不变）
    return handleLocally(cmd, body, res)
  }

  // 远程/Docker 实例 → 代理转发
  return proxyToInstance(active, cmd, body, res)
}
```

**始终在本机处理的命令（ALWAYS_LOCAL）：**
- `instance_*` — 实例管理本身
- `docker_*` — Docker 容器管理
- `auth_*` — 认证
- `read_panel_config` / `write_panel_config` — 本地面板配置
- `assistant_*` — AI 助手（操作本机文件系统）

**通过代理转发的命令：**
- `read_openclaw_config` / `write_openclaw_config` — 目标实例的配置
- `get_services_status` / `start_service` / `stop_service` — 目标实例的服务
- `list_agents` / `add_agent` / `delete_agent` — 目标实例的 Agent
- `read_log_tail` / `search_log` — 目标实例的日志
- `get_version_info` / `upgrade_openclaw` — 目标实例的版本
- `list_memory_files` / `read_memory_file` — 目标实例的记忆文件
- `read_mcp_config` / `write_mcp_config` — 目标实例的 MCP 配置
- 等其他 OpenClaw 相关命令

#### 4.1.3 代理转发实现

```js
async function proxyToInstance(instance, cmd, body, res) {
  const url = `${instance.endpoint}/__api/${cmd}`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.text()
    res.writeHead(resp.status, { 'Content-Type': 'application/json' })
    res.end(data)
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `实例 ${instance.name} 不可达: ${e.message}` }))
  }
}
```

#### 4.1.4 Docker 部署自动注册

修改 `docker_create_container` handler：
- 容器创建并启动后，自动等待健康检查
- 通过 `GET http://hostIP:panelPort/__api/check_installation` 验证
- 健康检查通过后自动写入 `instances.json`
- 返回结果包含 `instanceId`

### 4.2 前端 tauri-api.js

#### 4.2.1 新增实例管理 API

```js
// 实例管理
instanceList:        () => cachedInvoke('instance_list', {}, 10000),
instanceAdd:         (instance) => { invalidate('instance_list'); return invoke('instance_add', instance) },
instanceRemove:      (id) => { invalidate('instance_list'); return invoke('instance_remove', { id }) },
instanceSetActive:   (id) => { invalidate('instance_list'); _cache.clear(); return invoke('instance_set_active', { id }) },
instanceHealthCheck: (id) => invoke('instance_health_check', { id }),
instanceHealthAll:   () => invoke('instance_health_all'),
```

**注意 `instanceSetActive` 清空全部缓存**，因为切换实例后所有缓存数据都过期了。

#### 4.2.2 无需改动的部分

现有的 `api.readOpenclawConfig()`、`api.listAgents()` 等方法 **完全不变**。
代理逻辑在后端 `_apiMiddleware` 层透明处理。

### 4.3 前端 app-state.js

新增：

```js
let _activeInstance = { id: 'local', name: '本机', type: 'local' }
let _instanceListeners = []

export function getActiveInstance() { return _activeInstance }
export function onInstanceChange(fn) { ... }

export async function switchInstance(id) {
  // 1. 调后端切换
  await api.instanceSetActive(id)
  // 2. 更新本地状态
  _activeInstance = instances.find(i => i.id === id)
  // 3. 清缓存
  invalidate()        // 清 API 缓存
  // 4. 断开旧 WebSocket
  wsClient.disconnect()
  // 5. 重新检测状态
  await detectOpenclawStatus()
  // 6. 连接新实例的 Gateway WebSocket
  connectToActiveGateway()
  // 7. 通知所有监听者（侧边栏、页面刷新）
  _instanceListeners.forEach(fn => fn(_activeInstance))
}
```

### 4.4 前端 sidebar.js

在侧边栏顶部 logo 下方添加实例切换器：

```html
<div class="instance-switcher">
  <button class="instance-current" onclick="toggleDropdown()">
    <span class="instance-dot online"></span>
    <span class="instance-name">本机</span>
    <svg class="chevron">▼</svg>
  </button>
  <div class="instance-dropdown">
    <div class="instance-option active" data-id="local">
      <span class="instance-dot online"></span> 本机
    </div>
    <div class="instance-option" data-id="docker-abc123">
      <span class="instance-dot online"></span> openclaw-prod
      <span class="instance-badge">Docker</span>
    </div>
    <hr/>
    <div class="instance-option" onclick="addInstance()">
      <span>+ 添加实例</span>
    </div>
  </div>
</div>
```

### 4.5 前端 main.js

`autoConnectWebSocket()` 改为读取当前活跃实例的 Gateway 端点：

```js
async function autoConnectWebSocket() {
  const instance = getActiveInstance()
  if (instance.type === 'local') {
    // 本机：读本地配置
    const config = await api.readOpenclawConfig()
    const port = config?.gateway?.port || 18789
    wsClient.connect(`127.0.0.1:${port}`, token)
  } else {
    // 远程/Docker：从实例 endpoint 推导 Gateway 地址
    const config = await api.readOpenclawConfig() // 已通过代理转发
    const gwPort = config?.gateway?.port || 18789
    const url = new URL(instance.endpoint)
    wsClient.connect(`${url.hostname}:${instance.gatewayPort || gwPort}`, token)
  }
}
```

### 4.6 serve.js WebSocket 代理

WebSocket 代理改为动态目标：

```js
server.on('upgrade', (req, socket, head) => {
  // 从 query 或 header 中获取目标实例
  const target = resolveWsTarget(req)
  const conn = net.createConnection(target.port, target.host, () => { ... })
})
```

### 4.7 docker.js 集群页面

部署对话框增加"自动注册"逻辑：
- 容器创建成功后显示"正在等待实例就绪..."
- 健康检查通过后自动出现在实例切换器中
- 用户可直接切换到新实例进行管理

### 4.8 现有页面适配

| 页面 | 改动 | 说明 |
|------|------|------|
| dashboard.js | 极小 | 页头显示当前实例名称 |
| models.js | 无 | API 透明代理 |
| agents.js | 无 | API 透明代理 |
| gateway.js | 极小 | 远程实例时隐藏部分本机功能 |
| logs.js | 无 | API 透明代理 |
| chat.js | 无 | WebSocket 已切换到目标实例 |
| chat-debug.js | 无 | API 透明代理 |
| memory.js | 无 | API 透明代理 |
| services.js | 小 | 已有 Docker 适配，远程实例时隐藏 npm/CLI 相关 |
| extensions.js | 小 | 远程实例时 cftunnel/clawapp 不可用 |
| skills.js | 无 | API 透明代理 |
| security.js | 小 | 远程实例的密码管理走代理 |
| setup.js | 小 | 远程实例不需要 setup 流程 |
| assistant.js | 特殊 | AI 助手始终操作本机（ALWAYS_LOCAL） |

---

## 5. 实施步骤

### Step 1: 实例注册表后端（dev-api.js）
- `readInstances()` / `saveInstances()` 工具函数
- 6 个 handler：`instance_list` / `add` / `remove` / `set_active` / `health_check` / `health_all`
- 预计：~150 行

### Step 2: API 代理转发（dev-api.js）
- 改造 `_apiMiddleware` 添加代理逻辑
- `proxyToInstance()` 函数
- `ALWAYS_LOCAL` 命令集合
- 预计：~80 行

### Step 3: 前端实例管理 API（tauri-api.js）
- 新增 `api.instance*` 方法 + mock 数据
- 预计：~40 行

### Step 4: 前端状态管理（app-state.js）
- `_activeInstance` 状态 + `switchInstance()` 函数
- 预计：~50 行

### Step 5: 实例切换器 UI（sidebar.js）
- 下拉选择器组件 + CSS
- 预计：~100 行 JS + ~80 行 CSS

### Step 6: WebSocket 动态连接（main.js + serve.js）
- 切换实例时重新连接 WebSocket
- serve.js WebSocket 代理动态化
- 预计：~40 行

### Step 7: Docker 部署自动注册（docker.js + dev-api.js）
- `docker_create_container` 完成后自动注册
- 健康检查 + 就绪等待
- 预计：~60 行

### Step 8: 页面微调
- dashboard 显示实例名
- 远程实例时隐藏本机独占功能
- 预计：~30 行

**总计新增代码：约 600 行**

---

## 6. 安全考虑

### 6.1 认证
- 远程实例可能有不同的访问密码
- 代理转发时需要携带目标实例的认证凭据
- 首次连接时提示输入密码，存入 `instances.json`（加密存储待定）

### 6.2 网络安全
- Docker 容器默认只暴露在宿主机网络
- 远程实例建议通过 SSH 隧道或 VPN 连接
- 不建议在公网暴露 `/__api/` 端点而不加密码

### 6.3 权限隔离
- AI 助手（assistant_*）始终操作本机文件系统，不代理到远程
- Docker 管理（docker_*）始终操作本机 Docker，不代理

---

## 7. 边界与约束

### 7.1 不做的事情
- **不做** 统一聚合视图（如"查看所有实例的模型列表"）
- **不做** 跨实例数据同步（如"把本机模型配置复制到远程"）— 后续可做
- **不做** 实例间负载均衡
- **不做** 复杂的权限角色系统

### 7.2 前提条件
- 远程实例必须运行 ClawPanel（serve.js），版本 >= 0.7.0
- Docker 实例使用 full 镜像（含 Panel + Gateway）
- 网络可达（ClawPanel 后端能访问远程实例的端口）

### 7.3 兼容性
- 现有单实例用户 **零影响**：默认 activeId 为 "local"，行为完全不变
- 实例切换器在只有本机时可以隐藏或最小化显示
- 所有新功能向后兼容

---

## 8. 测试计划

| 场景 | 验证内容 |
|------|---------|
| 纯本机使用 | 现有功能不受影响，无回归 |
| 部署 Docker 容器 | 自动注册为可管理实例 |
| 切换到 Docker 实例 | 模型/Agent/日志等页面显示容器内数据 |
| 切换实例后聊天 | WebSocket 连接到正确的 Gateway |
| 远程实例离线 | 优雅报错，可切回本机 |
| 删除 Docker 容器 | 实例列表自动移除 |
| 多实例批量健康检查 | 侧边栏状态点实时更新 |
