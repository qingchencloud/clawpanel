# AI 助手功能扩展规划

> 基于现有工具架构（TOOL_DEFS + executeTool + getEnabledTools），扩展 6 大能力模块。
> 每个模块独立开关，遵循现有的 `_config.tools.xxx` + 设置面板 toggle 模式。

---

## 当前架构概览

```
TOOL_DEFS = {
  system:      [get_system_info]               // 始终可用
  process:     [list_processes, check_port]     // 始终可用
  interaction: [ask_user]                       // 始终可用
  terminal:    [run_command]                    // 开关控制
  fileOps:     [read_file, write_file, list_directory] // 开关控制
}

_config.tools = { terminal: true/false, fileOps: true/false }
```

扩展后：

```
TOOL_DEFS = {
  ...existing,
  docker:      [docker_list, docker_exec, docker_logs, wsl_exec]     // 新增
  webSearch:   [web_search, fetch_url]                                // 新增
  ssh:         [ssh_exec, ssh_read_file, ssh_write_file]             // 新增
  knowledge:   [search_knowledge]                                     // 新增
}

_config.tools = {
  ...existing,
  docker: false,      // 默认关闭
  webSearch: false,   // 默认关闭
  ssh: false,         // 默认关闭
  knowledge: false,   // 默认关闭
}
```

---

## 模块一：Docker / WSL 管理工具

### 场景
- 用户的 OpenClaw 可能安装在 Docker 容器或 WSL 中
- 本地检测不到时，帮用户在容器/WSL 内操作
- 查看容器日志、进入容器执行命令、管理容器生命周期

### 工具定义

| 工具名 | 描述 | 参数 | 危险等级 |
|--------|------|------|----------|
| `docker_list` | 列出 Docker 容器 | `filter?`, `all?` | 安全 |
| `docker_exec` | 在容器内执行命令 | `container`, `command` | ⚠️ 危险 |
| `docker_logs` | 查看容器日志 | `container`, `lines?` | 安全 |
| `docker_compose` | 执行 docker-compose 命令 | `action`, `file?`, `service?` | ⚠️ 危险 |
| `wsl_exec` | 在 WSL 内执行命令 | `distro?`, `command` | ⚠️ 危险 |
| `wsl_list` | 列出 WSL 发行版 | — | 安全 |

### 后端实现

```
Tauri (Rust):
  - docker_list → Command::new("docker").args(["ps", ...])
  - docker_exec → Command::new("docker").args(["exec", container, ...])
  - wsl_exec → Command::new("wsl").args(["-d", distro, "-e", ...])  (Windows only)

dev-api.js (Web):
  - execSync('docker ps --format json')
  - execSync(`docker exec ${container} ${command}`)
  - execSync(`wsl -d ${distro} -e ${command}`)  (Windows only)
```

### 安全围栏
- `docker_exec` / `wsl_exec` 归入 DANGEROUS_TOOLS
- `docker rm`, `docker rmi`, `docker system prune` 归入 CRITICAL_PATTERNS

### UI 扩展
- 设置面板工具权限 tab 新增 toggle：
  ```
  Docker / WSL 工具 — 允许管理容器和 WSL 环境
  ```

### 内置技能卡片
```js
{
  id: 'detect-docker-openclaw',
  icon: '🐳',
  name: '检测 Docker/WSL 中的 OpenClaw',
  desc: '扫描 Docker 容器和 WSL，查找 OpenClaw 安装',
  tools: ['docker'],
  prompt: `请帮我检查 Docker 和 WSL 中是否安装了 OpenClaw。
  1. 调用 get_system_info 判断操作系统
  2. 用 docker_list 列出所有容器，过滤包含 openclaw/gateway 的
  3. 如果是 Windows，用 wsl_list 列出 WSL 发行版
  4. 对每个 WSL 发行版，用 wsl_exec 执行 "which openclaw" 检测
  5. 汇总发现的 OpenClaw 实例及其状态`
}
```

### 优先级：🔴 高（解决用户最常见困惑）
### 工时估算：1-2 天

---

## 模块二：联网搜索工具

### 场景
- 用户遇到不常见的错误，AI 知识库可能没有
- 搜索 GitHub Issues、文档、Stack Overflow 找到解决方案
- 查找最新版本信息、API 文档等

### 工具定义

| 工具名 | 描述 | 参数 | 危险等级 |
|--------|------|------|----------|
| `web_search` | 联网搜索关键词 | `query`, `max_results?` | 安全 |
| `fetch_url` | 抓取网页内容 | `url` | 安全 |

### 后端实现方案（3 选 1）

#### 方案 A：DuckDuckGo Instant Answer API（推荐，免费无 Key）
```js
// 搜索
const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`)
// 但 Instant Answer 只返回摘要，不返回搜索结果列表

// 实际搜索需要用 DuckDuckGo HTML 页面解析或第三方库
```

#### 方案 B：SearXNG 代理（自托管，最灵活）
```js
// 部署一个 SearXNG 实例，或者用公共实例
const resp = await fetch(`https://searx.example.com/search?q=${query}&format=json`)
```

#### 方案 C：Jina Reader API（推荐搭配使用，免费）
```js
// 将任意 URL 转为纯文本/Markdown
const resp = await fetch(`https://r.jina.ai/${targetUrl}`)
const text = await resp.text()
```

### 推荐组合
- **搜索**：使用 DuckDuckGo 的 `html.duckduckgo.com/html/?q=xxx` 页面解析结果
- **内容抓取**：使用 Jina Reader `r.jina.ai/URL` 获取纯文本
- 两者都 **免费无 Key**，无需用户配置

### 系统提示词补充
```
## web_search 使用指南
当你无法确定答案或需要最新信息时，可以使用 web_search 搜索互联网。
搜索后，如果需要更多内容，可以用 fetch_url 抓取具体页面。
搜索技巧：
- 加 site:github.com 搜索 GitHub
- 加 site:stackoverflow.com 搜索 StackOverflow
- 搜索错误信息时，用引号包裹关键错误文本
```

### 安全围栏
- 搜索和抓取不涉及破坏性操作，不归入 DANGEROUS_TOOLS
- 但需要网络请求，添加超时保护（10 秒）
- URL 抓取限制最大内容长度（100KB → 截断）

### UI 扩展
```
联网搜索 — 允许搜索互联网和抓取网页内容（需联网）
```

### 优先级：🔴 高（大幅提升问题解决能力）
### 工时估算：0.5-1 天

---

## 模块三：SSH 远程管理工具

### 场景
- 用户的 OpenClaw 部署在远程服务器上
- 帮用户远程安装、配置、排查 OpenClaw
- 远程查看日志、重启服务、修改配置

### 工具定义

| 工具名 | 描述 | 参数 | 危险等级 |
|--------|------|------|----------|
| `ssh_exec` | 在远程服务器执行命令 | `connection_id`, `command` | ⚠️ 危险 |
| `ssh_read_file` | 读取远程文件 | `connection_id`, `path` | 安全 |
| `ssh_write_file` | 写入远程文件 | `connection_id`, `path`, `content` | ⚠️ 危险 |

### 配置数据结构

```js
_config.sshConnections = [
  {
    id: 'my-server',
    name: '生产服务器',
    host: '192.168.1.100',
    port: 22,
    user: 'root',
    authType: 'key',       // 'key' | 'password'
    keyPath: '~/.ssh/id_rsa',
    // password 不存储在 localStorage，每次询问或用 keytar 安全存储
  }
]
```

### 后端实现

```
Tauri (Rust):
  - 使用 ssh2 crate 或调用系统 ssh CLI
  - ssh_exec → Command::new("ssh").args(["-p", port, "user@host", command])
  - ssh_read_file → ssh + cat
  - ssh_write_file → 通过 stdin pipe 写入

dev-api.js (Web):
  - 使用 node-ssh 或 ssh2 npm 包
  - 或者直接调用 ssh CLI
```

### 设置 UI：新增 tab「远程连接」

```
┌─────────────────────────────────────────────┐
│  模型配置  │  工具权限  │  远程连接  │ 助手人设 │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ 生产服务器 ──────────────── [编辑] [删] │
│  │ root@192.168.1.100:22 (密钥认证)         │
│  └──────────────────────────────────────────│
│                                             │
│  ┌─ 测试服务器 ──────────────── [编辑] [删] │
│  │ admin@10.0.0.5:22 (密码认证)             │
│  └──────────────────────────────────────────│
│                                             │
│  [+ 添加连接]                               │
│                                             │
│  提示：推荐使用 SSH 密钥认证。              │
│  生成密钥：ssh-keygen -t ed25519            │
│  复制公钥：ssh-copy-id user@host            │
│                                             │
└─────────────────────────────────────────────┘
```

### 安全围栏
- `ssh_exec`, `ssh_write_file` 归入 DANGEROUS_TOOLS
- 密码认证：每次执行时用 ask_user 确认，或使用系统密钥链
- SSH 密钥路径验证：检查文件是否存在
- 关键命令（rm -rf, reboot 等）在远程同样走 CRITICAL_PATTERNS

### 系统提示词补充
```
## SSH 远程管理
用户可能配置了远程服务器连接。当操作远程服务器时：
- 先用 ask_user 确认要操作哪个连接
- 远程命令比本地更谨慎，优先使用只读操作
- 修改配置前先备份（cp xxx xxx.bak）
```

### 内置技能卡片
```js
{
  id: 'remote-manage',
  icon: '🌐',
  name: '远程管理 OpenClaw',
  desc: '通过 SSH 连接远程服务器，管理 OpenClaw',
  tools: ['ssh', 'fileOps'],
  prompt: `请帮我管理远程服务器上的 OpenClaw。
  1. 获取系统信息，列出已配置的 SSH 连接
  2. 用 ask_user 让我选择要操作的服务器
  3. 用 ssh_exec 检查远程 OpenClaw 状态
  4. 检查 Gateway 进程和端口
  5. 读取远程配置和日志
  6. 汇总远程 OpenClaw 状态报告`
}
```

### 优先级：🟡 中（用户量较少但价值极高）
### 工时估算：2-3 天

---

## 模块四：知识库 + 灵魂移植（借尸还魂 🔥）

### 核心理念

OpenClaw 的 Agent 有一套完整的**身份系统**，由工作区引导文件定义：

```
~/.openclaw/workspace/           ← Agent 的"灵魂"所在
  ├── AGENTS.md                  ← 操作指令、规则、记忆管理方式
  ├── SOUL.md                    ← 人设、边界、语气（"Who You Are"）
  ├── IDENTITY.md                ← 名称、物种、风格、表情符号、头像
  ├── USER.md                    ← 用户档案（名字、称呼、时区、偏好）
  ├── TOOLS.md                   ← 工具本地笔记（SSH 配置、设备名等）
  ├── HEARTBEAT.md               ← 心跳任务清单
  ├── MEMORY.md                  ← 精选长期记忆（仅主会话加载）
  └── memory/                    ← 每日记忆日志
      ├── 2026-03-04-1609.md
      └── ...

~/.openclaw/agents/<agentId>/agent/  ← Agent 的运行时状态
  ├── models.json                ← 模型提供商配置（baseUrl + apiKey + models）
  ├── auth-profiles.json         ← 认证配置文件
  └── auth.json
```

**"借尸还魂"不是复用知识库，而是完整接管 Agent 的灵魂**——
ClawPanel 的 AI 助手直接读取这些文件，像 OpenClaw 一样把它们注入 system prompt，
从而变成那个 Agent：有他的名字、他的性格、他的记忆、他认识的用户。

### 4A：灵魂移植（Agent Identity Takeover）

#### 工作流程

1. **扫描** `~/.openclaw/workspace/` 和 `~/.openclaw/agents/` 目录
2. **发现** 所有可用的 Agent 身份（main、test 等）
3. **用户选择** 要附身的 Agent
4. **读取** 该 Agent 的全部引导文件：
   - `SOUL.md` → 注入为人设（替换 ClawPanel 助手的默认人设）
   - `IDENTITY.md` → 提取名称/表情/风格（替换助手名称和性格描述）
   - `USER.md` → 注入用户上下文（知道用户叫什么、偏好什么）
   - `AGENTS.md` → 注入操作规则（Agent 的行为准则）
   - `TOOLS.md` → 注入工具笔记
   - `MEMORY.md` → 注入长期记忆
   - `memory/` → 注入最近的每日记忆（最近 3 天）
5. **注入** 到 `buildSystemPrompt()` 中，完全替代默认人设

#### 实现

```js
// 新增配置项
_config.soulSource = null  // null = 使用 ClawPanel 默认 | 'openclaw:main' | 'openclaw:test' | 'custom'
_config.soulCache = null   // 缓存读取的灵魂文件内容

// buildSystemPrompt 改造
function buildSystemPrompt() {
  if (_config.soulSource?.startsWith('openclaw:')) {
    // 借尸还魂模式：使用 OpenClaw Agent 的灵魂
    return buildOpenClawSoulPrompt()
  }
  // 默认模式：使用 ClawPanel 自带的系统提示词
  return buildDefaultPrompt()
}

function buildOpenClawSoulPrompt() {
  const soul = _config.soulCache
  if (!soul) return buildDefaultPrompt() // fallback

  let prompt = ''

  // 1. 身份注入
  if (soul.identity) {
    prompt += `# Identity\n${soul.identity}\n\n`
  }

  // 2. 灵魂注入（人设、边界、语气）
  if (soul.soul) {
    prompt += `# Soul\n${soul.soul}\n\n`
  }

  // 3. 用户上下文
  if (soul.user) {
    prompt += `# User\n${soul.user}\n\n`
  }

  // 4. 操作规则
  if (soul.agents) {
    prompt += `# Operating Instructions\n${soul.agents}\n\n`
  }

  // 5. 工具笔记
  if (soul.tools) {
    prompt += `# Tool Notes\n${soul.tools}\n\n`
  }

  // 6. 长期记忆
  if (soul.memory) {
    prompt += `# Long-term Memory\n${soul.memory}\n\n`
  }

  // 7. 最近的每日记忆
  if (soul.recentMemories?.length) {
    prompt += `# Recent Memory\n`
    for (const m of soul.recentMemories) {
      prompt += `## ${m.date}\n${m.content}\n\n`
    }
  }

  // 8. 追加 ClawPanel 特有的工具说明（保持工具能力）
  prompt += buildToolInstructions()

  return prompt
}
```

#### 灵魂加载函数

```js
async function loadOpenClawSoul(agentId = 'main') {
  const home = await getHomeDir()
  const ws = `${home}/.openclaw/workspace`  // 工作区是全局的，不按 agentId 分

  const readSafe = async (path) => {
    try { return await api.assistantReadFile(path) }
    catch { return null }
  }

  const soul = {
    identity: await readSafe(`${ws}/IDENTITY.md`),
    soul: await readSafe(`${ws}/SOUL.md`),
    user: await readSafe(`${ws}/USER.md`),
    agents: await readSafe(`${ws}/AGENTS.md`),
    tools: await readSafe(`${ws}/TOOLS.md`),
    memory: await readSafe(`${ws}/MEMORY.md`),
    recentMemories: [],
  }

  // 读取最近 3 天的每日记忆
  try {
    const memDir = await api.assistantListDir(`${ws}/memory`)
    const files = memDir.split('\n').filter(f => f.match(/\d{4}-\d{2}-\d{2}/))
    const recent = files.sort().slice(-3)
    for (const f of recent) {
      const content = await readSafe(`${ws}/memory/${f.trim()}`)
      if (content) soul.recentMemories.push({ date: f.trim(), content })
    }
  } catch {}

  return soul
}
```

#### UI：设置面板「助手人设」Tab 改造

```
┌─────────────────────────────────────────────┐
│  模型配置 │ 工具权限 │ 知识库 │ 远程连接 │ 人设 │
├─────────────────────────────────────────────┤
│                                             │
│  身份来源                                   │
│  ┌──────────────────────────────────────────│
│  │ ● ClawPanel 默认人设                     │ ← 当前默认
│  │ ○ OpenClaw Agent 身份（借尸还魂）        │ ← 新增
│  │ ○ 自定义人设                             │
│  └──────────────────────────────────────────│
│                                             │
│  ─── 当选择「OpenClaw Agent」时显示 ────    │
│                                             │
│  选择 Agent:  [main ▼]                      │
│                                             │
│  📜 灵魂文件预览                            │
│  ┌──────────────────────────────────────────│
│  │ SOUL.md    ✅ 已加载 (1.6KB)            │
│  │ IDENTITY.md ✅ 已加载 (636B)            │
│  │ USER.md    ✅ 已加载 (237B)             │
│  │ AGENTS.md  ✅ 已加载 (7.8KB)            │
│  │ TOOLS.md   ✅ 已加载 (860B)             │
│  │ MEMORY.md  ❌ 未找到                     │
│  │ memory/    📝 2 个日志文件              │
│  └──────────────────────────────────────────│
│                                             │
│  [👻 附身！]  [🔄 刷新]                     │
│                                             │
│  ⚠️ 附身后，助手将使用该 Agent 的人格、    │
│  记忆和用户偏好。可随时切回默认。           │
│                                             │
│  ─── 当选择「ClawPanel 默认」时显示 ────    │
│                                             │
│  助手名称: [晴辰助手          ]             │
│  助手性格: [________________________]       │
│                                             │
└─────────────────────────────────────────────┘
```

#### 附身后的效果

| 维度 | 默认模式 | 附身模式 |
|------|----------|----------|
| 名称 | "晴辰助手" | IDENTITY.md 中的名称 |
| 性格 | 简洁专业 | SOUL.md 定义的风格 |
| 称呼用户 | "你" | USER.md 中的称呼（如"爸爸"） |
| 行为规则 | ClawPanel 内置 | AGENTS.md 的规则体系 |
| 记忆 | 无 | MEMORY.md + 每日记忆 |
| 工具知识 | ClawPanel 内置 | TOOLS.md 的本地笔记 |
| 工具能力 | 保持不变 | 保持 ClawPanel 的工具 |

**关键设计**：附身只替换"灵魂"（system prompt），**工具能力保持 ClawPanel 的**。
因为 OpenClaw 的工具（exec/read/edit/write）和 ClawPanel 的工具本质相同，
但 ClawPanel 有独有的 docker/ssh/搜索等扩展工具，这些要保留。

### 4B：自定义知识库

在灵魂移植之外，仍然支持用户上传额外的知识文档：

#### 数据存储
```
~/.openclaw/clawpanel-kb/
  ├── index.json          # 知识库索引
  ├── docs/
  │   ├── api-guide.md    # 用户上传的文档
  │   ├── faq.md
  │   └── deploy-notes.txt
  └── chunks/             # 分块索引（可选，用于大文档）
      └── ...
```

#### 实现方案

**V1（简单方案）**：
- 小文档（<8KB）直接全文注入 system prompt 尾部
- 大文档做关键词搜索（正则匹配 + 上下文窗口）
- 总注入 token 上限：4000 tokens
- 知识库和灵魂移植可叠加使用

**V2（进阶方案）**：
- embedding 语义搜索
- `search_knowledge` 工具让 AI 按需检索

### 优先级：� 高（灵魂移植是杀手级差异化功能）
### 工时估算：灵魂移植 1-2 天，自定义知识库 V1 额外 1 天

---

## 模块五：模型配置自动导入

### 场景
- 用户已安装 OpenClaw 并配置了模型
- ClawPanel AI 助手需要单独配置模型（目前手动填写）
- 一键从 OpenClaw 配置导入，省去重复配置

### 实现

#### 数据来源（两个层级）

**层级 1：全局配置** `~/.openclaw/openclaw.json`
```json
{
  "models": {
    "providers": {
      "shengsuanyun": {
        "baseUrl": "http://127.0.0.1:8082/v1",
        "apiKey": "sk-xxx",
        "api": "openai-completions"
      }
    }
  }
}
```

**层级 2：Agent 模型注册表** `~/.openclaw/agents/<agentId>/agent/models.json`
```json
{
  "providers": {
    "openai": {
      "baseUrl": "http://127.0.0.1:8082/v1",
      "apiKey": "sk-eB3ybVNFvqB4fGrTUp3F8Lq16QxF7tut",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-5.4", "name": "gpt-5.4", "contextWindow": 200000, "maxTokens": 8192 },
        { "id": "gpt-5.2-codex", "name": "gpt-5.2-codex", ... }
      ]
    }
  }
}
```

**推荐优先读取 Agent 的 models.json**——它有完整的 baseUrl + apiKey + models 列表，
一键就能填充 ClawPanel 助手的配置。

#### 读取逻辑
```js
async function discoverOpenClawModels() {
  const home = await getHomeDir()
  const results = []

  // 1. 扫描所有 Agent 的 models.json
  try {
    const agents = await api.assistantListDir(`${home}/.openclaw/agents`)
    for (const agentId of agents.split('\n').map(s => s.trim()).filter(Boolean)) {
      try {
        const raw = await api.assistantReadFile(`${home}/.openclaw/agents/${agentId}/agent/models.json`)
        const data = JSON.parse(raw)
        for (const [providerId, provider] of Object.entries(data.providers || {})) {
          results.push({
            source: `Agent: ${agentId}`,
            providerId,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            apiType: provider.api === 'openai-completions' ? 'openai' : provider.api,
            models: (provider.models || []).map(m => m.id || m.name),
          })
        }
      } catch {}
    }
  } catch {}

  // 2. 读取全局 openclaw.json 作为补充
  try {
    const raw = await api.assistantReadFile(`${home}/.openclaw/openclaw.json`)
    const config = JSON.parse(raw)
    for (const [providerId, provider] of Object.entries(config.models?.providers || {})) {
      // 去重：如果 Agent models.json 已有相同 providerId，跳过
      if (!results.find(r => r.providerId === providerId)) {
        results.push({
          source: '全局配置',
          providerId,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiType: 'openai',
          models: [],  // 全局配置没有 models 列表
        })
      }
    }
  } catch {}

  return results
}
```

#### UI：模型配置 tab 新增「导入」按钮

```
┌─────────────────────────────────────────────┐
│  API Base URL              API 类型         │
│  [________________________] [OpenAI 兼容 ▼] │
│                                             │
│  API Key          [测试] [拉取] [📥 导入]  │ ← 新增「导入」按钮
│  [________________________]                 │
│                                             │
│  模型              温度                     │
│  [________________________] [0.7]           │
│                                             │
└─────────────────────────────────────────────┘
```

点击「📥 导入」弹出选择面板：

```
┌─────────────────────────────────────────────┐
│  从 OpenClaw 导入模型配置                   │
│                                             │
│  检测到以下已配置的服务商：                 │
│                                             │
│  ○ OpenAI                                   │
│    https://api.openai.com/v1                │
│    模型: gpt-4o, gpt-4o-mini               │
│                                             │
│  ○ DeepSeek                                 │
│    https://api.deepseek.com                 │
│    模型: deepseek-chat, deepseek-reasoner   │
│                                             │
│  ○ 本地 Ollama                              │
│    http://127.0.0.1:11434/v1               │
│    模型: qwen2.5:7b                        │
│                                             │
│  选择一个服务商，自动填充配置。             │
│                       [取消] [导入]         │
└─────────────────────────────────────────────┘
```

### 后端

```
Tauri: 已有 read_openclaw_config 命令
dev-api.js: 已有 read_config handler

// 只需在前端加一个读取+解析+填充的逻辑
```

### 优先级：🔴 高（零成本，纯前端，极大提升体验）
### 工时估算：0.5 天

---

## 实施路线图

### Phase 1：快速见效（1-2 天）
| 序号 | 功能 | 工时 | 理由 |
|------|------|------|------|
| 1 | **模型配置自动导入** | 0.5d | 读 Agent models.json → 一键填充，纯前端零风险 |
| 2 | **联网搜索工具** | 0.5-1d | DuckDuckGo + Jina，免费无 Key |
| 3 | **灵魂移植（借尸还魂）** | 1-2d | 杀手级差异化——读 SOUL/IDENTITY/USER/AGENTS/MEMORY → 变身 |

### Phase 2：核心扩展（2-3 天）
| 序号 | 功能 | 工时 | 理由 |
|------|------|------|------|
| 4 | **Docker/WSL 工具** | 1-2d | 解决用户最常见的安装困惑 |
| 5 | **自定义知识库 V1** | 1d | 用户上传 md/txt → 注入 prompt |

### Phase 3：高级功能（3-5 天）
| 序号 | 功能 | 工时 | 理由 |
|------|------|------|------|
| 6 | **SSH 远程管理** | 2-3d | 价值最高但复杂度也最高 |
| 7 | **知识库 V2（语义搜索）** | 3-5d | 依赖 embedding API |

---

## 设置面板 Tab 规划

当前 3 个 Tab → 扩展为 5 个 Tab：

```
模型配置 │ 工具权限 │ 知识库 │ 远程连接 │ 助手人设
```

### 工具权限 Tab 最终形态

```
基础工具
  ☑ 终端工具      — 允许执行 Shell 命令
  ☑ 文件工具      — 允许读写文件和浏览目录

扩展工具
  ☐ Docker/WSL    — 允许管理容器和 WSL 环境
  ☐ 联网搜索      — 允许搜索互联网和抓取网页
  ☐ SSH 远程      — 允许连接远程服务器（需先配置连接）
  ☐ 知识库        — 允许检索知识库内容

ℹ️ 进程列表、端口检测、系统信息工具始终可用（非聊天模式下）。
```

---

## 技术注意事项

### 1. Token 预算管理
灵魂移植 + 知识库注入会占用 context window，需要精细管理：

| 组件 | 预算 | 说明 |
|------|------|------|
| ClawPanel 基础 prompt | ~2000 tokens | 产品介绍、工具指南、技能卡片 |
| SOUL.md | ~500 tokens | 人设通常简短 |
| IDENTITY.md | ~200 tokens | 名称/风格 |
| USER.md | ~200 tokens | 用户档案 |
| AGENTS.md | ~3000 tokens | 操作规则（最大，可截断） |
| TOOLS.md | ~300 tokens | 工具笔记 |
| MEMORY.md | ~2000 tokens | 长期记忆（截断保留最近部分） |
| 每日记忆 (3天) | ~1500 tokens | 自动截断 |
| 自定义知识库 | ~4000 tokens | 用户上传文档 |
| 搜索结果 | ~2000 tokens | web_search 返回内容 |
| **总计上限** | **~16000 tokens** | 留足空间给对话历史 |

策略：
- AGENTS.md 超过 3000 tokens 时截断尾部，保留前面的核心规则
- MEMORY.md 超过 2000 tokens 时只保留最后 2000 tokens
- 每日记忆超过 500 tokens/天时截断
- 灵魂文件加载时计算总 token 并在 UI 中显示

### 2. 跨平台兼容
- Docker CLI 在 Windows/Mac/Linux 都可用
- WSL 仅 Windows
- SSH 密钥路径：Windows 用 `%USERPROFILE%\.ssh\`，Mac/Linux 用 `~/.ssh/`

### 3. 安全存储
- SSH 密码/API Key：
  - Tauri 模式：使用 keytar 或 tauri-plugin-store 加密存储
  - Web 模式：仅支持密钥认证（不存储密码）
- 知识库文件：存储在 `~/.openclaw/` 下，与用户数据同目录

### 4. 工具发现
AI 模型需要知道哪些工具可用。当前已在 `buildSystemPrompt()` 中列出技能卡片。
新增工具后，需要在系统提示词中补充使用指南（类似现有的 `ask_user` 指南）。

---

## 文件变更预估

| 文件 | 变更 |
|------|------|
| `src/pages/assistant.js` | TOOL_DEFS 新增 4 类 · executeTool 新增 case · getEnabledTools 新增分支 · 设置面板 UI · 模型导入弹窗 |
| `src-tauri/src/commands/assistant.rs` | 新增 Rust 命令：docker_*, wsl_*, ssh_*, web_search, fetch_url |
| `scripts/dev-api.js` | 新增 Web 模式 handler：同上 |
| `src/style/assistant.css` | 知识库管理 UI · SSH 连接管理 UI · 导入弹窗样式 |
| `src/pages/assistant.js` (prompt) | 系统提示词新增各工具使用指南 |
