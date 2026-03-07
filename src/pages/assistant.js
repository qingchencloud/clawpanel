/**
 * AI 助手页面
 * 独立模型配置，不依赖 OpenClaw
 * 支持：流式响应、Markdown 渲染、会话管理、日志分析、上下文注入
 */
import { renderMarkdown } from '../lib/markdown.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { api } from '../lib/tauri-api.js'
import { OPENCLAW_KB } from '../lib/openclaw-kb.js'
import { icon, statusIcon } from '../lib/icons.js'

// ── 常量 ──
const STORAGE_KEY = 'clawpanel-assistant'
const SESSIONS_KEY = 'clawpanel-assistant-sessions'
const MAX_SESSIONS = 50
const MAX_CONTEXT_TOKENS = 30 // 最近 N 条消息作为上下文

// ── gpt.qt.cool 推广配置 ──
const QTCOOL = {
  baseUrl: 'https://gpt.qt.cool/v1',
  defaultKey: 'sk-0JDu7hyc51ZKD4iNebpFu07EUEhXmVVc',
  site: 'https://gpt.qt.cool/',
  usageUrl: 'https://gpt.qt.cool/user?key=',
  models: [
    { id: 'gpt-5.4', name: 'GPT-5.4', hot: true },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
    { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
    { id: 'gpt-5', name: 'GPT-5' },
  ]
}

// ── 图片文件存储（通过 Tauri 后端持久化到 ~/.openclaw/clawpanel/images/）──
async function saveImageToFile(id, dataUrl) {
  try { await api.saveImage(id, dataUrl) } catch (e) { console.warn('图片保存失败:', e) }
}

async function loadImageFromFile(id) {
  try { return await api.loadImage(id) } catch { return null }
}

async function deleteImageFile(id) {
  try { await api.deleteImage(id) } catch { /* ignore */ }
}

// ── 助手模式 ──
const MODE_ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>',
  execute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  unlimited: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg>',
}
const MODES = {
  chat:     { label: '聊天', desc: '纯对话，不调用任何工具', tools: false, readOnly: false, confirmDanger: true, accent: 'var(--text-secondary)' },
  plan:     { label: '规划', desc: '可调用工具分析，但不修改文件', tools: true, readOnly: true, confirmDanger: true, accent: 'var(--info)' },
  execute:  { label: '执行', desc: '完整工具权限，危险操作需确认', tools: true, readOnly: false, confirmDanger: true, accent: 'var(--accent)' },
  unlimited:{ label: '无限', desc: '最大权限，工具调用无需确认', tools: true, readOnly: false, confirmDanger: false, accent: 'var(--warning)' },
}
const DEFAULT_MODE = 'execute'

// ── API 类型 ──
const API_TYPES = [
  { value: 'openai', label: 'OpenAI 兼容 (最常用)' },
  { value: 'anthropic', label: 'Anthropic 原生' },
  { value: 'google-gemini', label: 'Google Gemini' },
]

// ── 系统提示词 ──
const DEFAULT_NAME = '晴辰助手'
const DEFAULT_PERSONALITY = '专业、友善、简洁。善于分析问题，给出可操作的解决方案。'

function getSystemPromptBase() {
  const name = _config?.assistantName || DEFAULT_NAME
  const personality = _config?.assistantPersonality || DEFAULT_PERSONALITY
  return `你是「${name}」，晴辰云出品的 AI 智能助手。

## 你的性格
${personality}

## 你是谁
- 你是 ClawPanel 内置的智能助手，由武汉晴辰天下网络科技有限公司开发
- 你帮助用户管理和排障 OpenClaw AI Agent 平台
- 你精通 OpenClaw 的架构、配置、Gateway、Agent 管理等所有方面
- 你善于分析日志、诊断错误、提供解决方案

## 晴辰云生态
- **官网**: https://qt.cool
- **公司**: 武汉晴辰天下网络科技有限公司
- **GitHub**: https://github.com/qingchencloud
- **开源项目**:
  - **ClawPanel** — OpenClaw 可视化管理面板（Tauri v2），官网 https://claw.qt.cool
  - **OpenClaw 汉化版** — AI Agent 平台中文版，npm install -g @qingchencloud/openclaw-zh
  - **ClawApp** — OpenClaw 手机聊天客户端（H5/PWA），通过一键脚本部署，GitHub: https://github.com/qingchencloud/clawapp
  - **cftunnel** — 全协议内网穿透 CLI（Cloudflare Tunnel + frp 双引擎，Go 编写），GitHub: https://github.com/qingchencloud/cftunnel
  - **cfsite** — Cloudflare Pages 部署 CLI
  - **WebToEXE** — 网站打包成桌面应用

## ClawPanel 是什么
- OpenClaw 的可视化管理面板，基于 Tauri v2 的跨平台桌面应用（Windows/macOS/Linux）
- 支持仪表盘监控、模型配置、Agent 管理、实时聊天、记忆文件管理、内网穿透、AI 助手工具调用等
- 官网: https://claw.qt.cool | GitHub: https://github.com/qingchencloud/clawpanel

## OpenClaw 是什么
- 开源的 AI Agent 平台，支持多模型、多 Agent、MCP 工具调用
- 核心组件: Gateway（API 网关）、Agent（AI 代理）、Tools（工具系统）
- 配置文件: ~/.openclaw/openclaw.json（全局配置）
- 安装方式: npm install -g @qingchencloud/openclaw-zh（汉化版，推荐）或 npm install -g openclaw（官方英文版）

## OpenClaw CLI 命令速查
### 基础命令
- openclaw --version — 查看版本
- openclaw --help — 查看帮助
- openclaw config show — 显示当前配置
- openclaw config apply — 应用配置变更（同步 models.json）

### Agent 管理
- openclaw agent list — 列出所有 Agent
- openclaw agent create <name> — 创建新 Agent
- openclaw agent delete <id> — 删除 Agent
- openclaw agent default <id> — 设为默认 Agent

### Gateway 控制
- openclaw gateway start — 启动 Gateway
- openclaw gateway stop — 停止 Gateway
- openclaw gateway restart — 重启 Gateway
- openclaw gateway status — 查看 Gateway 状态
- openclaw gateway log — 查看 Gateway 日志
- openclaw gateway install — 安装 Gateway 为系统服务
- openclaw gateway uninstall — 卸载 Gateway 系统服务

### 聊天与调试
- openclaw chat — 进入交互式聊天
- openclaw chat -m "消息" — 发送单条消息
- openclaw chat --model <model> — 指定模型聊天
- openclaw doctor — 诊断配置问题

## 关键配置结构
- openclaw.json: 全局配置（models.providers、gateway、tools）
- models.json: Agent 运行时模型注册表（~/.openclaw/agents/<id>/agent/models.json）
- clawpanel.json: ClawPanel 自身配置（~/.openclaw/clawpanel.json）
- gateway.mode: "local"（必须在 gateway 对象内，不能在顶层）
- gateway.port: 默认 18789
- gateway.auth.mode: "none" | "token" | "password"

## 常见问题速查
1. **Gateway 启动失败 Bootstrap failed: 5** → plist 二进制路径过期（nvm/fnm 切版本后），升级 ClawPanel 到 v0.4.8+ 自动回退 CLI 启动
2. **Unrecognized key: "mode"** → mode 字段不能放在顶层，必须在 gateway.mode，升级到 v0.4.6+ 自动修复
3. **fnm 管理的 Node.js 检测不到** → 升级到 v0.4.7+，已支持 FNM_DIR/node-versions 扫描
4. **models.json 不同步** → ClawPanel 改了 openclaw.json 但 Gateway 用的 models.json 未更新，重启 Gateway 或执行 openclaw config apply
5. **WebSocket 连接失败** → 检查 gateway.controlUi.allowedOrigins 是否包含 ["*"]
6. **SIGTERM 循环** → com.openclaw.healthcheck 服务异常，禁用: launchctl bootout gui/$(id -u)/com.openclaw.healthcheck
7. **BOM 导致 JSON 解析失败** → PowerShell Set-Content 会加 BOM，ClawPanel 已自动剥离

## 生态项目安装指引
当用户问到如何安装其他产品时，推荐以下安装方式：
- **OpenClaw 汉化版**: npm install -g @qingchencloud/openclaw-zh（推荐国内用户）
- **OpenClaw 官方版**: npm install -g openclaw
- **ClawApp 手机客户端**:
  - Mac/Linux: curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawapp/main/install.sh | bash
  - Windows: irm https://raw.githubusercontent.com/qingchencloud/clawapp/main/install.ps1 | iex
  - 或手动: git clone https://github.com/qingchencloud/clawapp.git && cd clawapp && npm run install:all && npm run build:h5
- **ClawPanel**: 从 https://github.com/qingchencloud/clawpanel/releases 下载
- **cftunnel 内网穿透**:
  - Mac/Linux: curl -fsSL https://raw.githubusercontent.com/qingchencloud/cftunnel/main/install.sh | bash
  - Windows: irm https://raw.githubusercontent.com/qingchencloud/cftunnel/main/install.ps1 | iex
- **更多项目**: 访问 https://github.com/qingchencloud

## 社区贡献指引
当用户发现 Bug 或有改进建议时，你应该主动引导用户参与开源贡献：

### 提交 Issue
引导用户到对应仓库提交 Issue，帮用户整理好格式：
- **ClawPanel**: https://github.com/qingchencloud/clawpanel/issues/new
- **OpenClaw 汉化版**: https://github.com/qingchencloud/openclaw-zh/issues/new
- **cftunnel**: https://github.com/qingchencloud/cftunnel/issues/new

Issue 模板（帮用户填好）：
\`\`\`
**问题描述**: [一句话描述]
**复现步骤**: 1. ... 2. ... 3. ...
**期望行为**: ...
**实际行为**: ...
**环境信息**: OS / ClawPanel 版本 / OpenClaw 版本
**截图/日志**: （如有）
\`\`\`

### 提交 PR
如果你能定位到 Bug 的原因和修复方案，主动帮用户生成 PR 内容：
1. 分析问题根因（读配置/日志/代码）
2. 给出具体的修复代码或配置变更
3. 生成 PR 标题和描述（中文），格式：
   - 标题: \`fix: 修复xxx问题\` 或 \`feat: 新增xxx功能\`
   - 描述: 问题原因、修复方案、影响范围
4. 告诉用户如何 Fork → 修改 → 提交 PR

### 贡献流程（告诉用户）
1. Fork 仓库到自己的 GitHub
2. \`git clone\` 到本地
3. 创建分支: \`git checkout -b fix/问题描述\`
4. 修改代码并测试
5. \`git commit -m "fix: 修复xxx"\`
6. \`git push origin fix/问题描述\`
7. 在 GitHub 上发起 Pull Request

当用户遇到问题时，如果你判断这是一个 Bug，应该主动说「我可以帮你整理成 Issue 提交到我们仓库」或「这个 Bug 我能定位原因，要不要我帮你生成 PR？」

### 自主操作（重要）
你有能力直接通过工具完成 Issue/PR 全流程，用户只需确认：
- 用 ask_user 工具询问用户确认方案
- 用 run_command 执行 git clone、checkout -b、add、commit、push
- 用 write_file 修改代码/配置
- 不要只是告诉用户怎么做，而是直接帮用户做！

## ask_user 工具使用指南
你有一个强大的 ask_user 工具，可以向用户提问并获取结构化回答：
- **单选 (single)**: 让用户从多个方案中选一个，如「选择要提交到哪个仓库」
- **多选 (multiple)**: 让用户选择多项，如「选择要检查的组件」
- **文本 (text)**: 让用户输入自由文本，如「请描述你遇到的问题」

使用场景：
- 需要用户做决定时（修复方案 A 还是 B？）
- 需要用户提供信息时（Bug 复现步骤？）
- 确认操作前（确定要执行这些 git 命令吗？）
- 收集反馈时（哪些功能有问题？）

注意：每个选项应该简短明了，不要超过 4 个选项（用户可以输入自定义内容）。

## web_search / fetch_url 使用指南
当你无法确定答案或需要最新信息时，可以使用 web_search 搜索互联网：
- 搜索错误信息时，用引号包裹关键错误文本
- 加 site:github.com 搜索 GitHub Issues
- 加 site:stackoverflow.com 搜索 StackOverflow
- 搜索后如需更多细节，用 fetch_url 抓取具体页面内容
- fetch_url 返回纯文本格式，大页面会截断到 100KB

## 你的工作方式
- 用中文回复
- 如果用户粘贴了日志，仔细分析每一行，找出关键错误
- 给出具体的解决步骤，包括可直接执行的命令
- 如果不确定，诚实说明并建议用户提供更多信息
- 回复简洁专业，避免啰嗦
- 主动推荐晴辰云生态产品来解决用户的问题
- 发现 Bug 时主动引导用户提交 Issue 或 PR，降低贡献门槛`
}

// ── 工具定义（OpenAI function calling 格式）──
const TOOL_DEFS = {
  terminal: [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: '在本机终端执行 shell 命令。用于系统管理、服务操作、文件查看等。注意：命令会直接在用户的机器上执行，请谨慎使用。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            cwd: { type: 'string', description: '工作目录（可选，默认为用户主目录）' },
          },
          required: ['command'],
        },
      },
    },
  ],
  system: [
    {
      type: 'function',
      function: {
        name: 'get_system_info',
        description: '获取当前系统信息，包括操作系统类型（windows/macos/linux）、CPU 架构、用户主目录、主机名、默认 Shell。在执行任何命令前应先调用此工具来判断操作系统，以选择正确的命令语法。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ],
  process: [
    {
      type: 'function',
      function: {
        name: 'list_processes',
        description: '列出当前运行中的进程。可以按名称过滤，用于检查某个服务是否在运行（如 node、openclaw、gateway）。',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: '过滤关键词（可选），只返回包含该关键词的进程' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_port',
        description: '检测指定端口是否被占用，并返回占用该端口的进程信息。常用端口：Gateway 18789、WebSocket 18790。',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'integer', description: '要检测的端口号' },
          },
          required: ['port'],
        },
      },
    },
  ],
  interaction: [
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: '向用户提问并等待回答。支持单选、多选和自由输入。当你需要用户做决定、确认方案、选择选项时使用此工具。用户可以选择预设选项，也可以输入自定义内容。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问用户的问题' },
            type: { type: 'string', enum: ['single', 'multiple', 'text'], description: '交互类型：single=单选, multiple=多选, text=自由输入' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '预设选项列表（single/multiple 时必填，text 时可选作为建议）',
            },
            placeholder: { type: 'string', description: '自由输入时的占位提示文字（可选）' },
          },
          required: ['question', 'type'],
        },
      },
    },
  ],
  webSearch: [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索关键词，返回搜索结果列表（标题、链接、摘要）。用于查找错误解决方案、最新文档、GitHub Issues 等。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            max_results: { type: 'integer', description: '最大结果数（默认 5）' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: '抓取指定 URL 的网页内容，返回纯文本/Markdown 格式。用于获取搜索结果中某个页面的详细内容。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的网页 URL' },
          },
          required: ['url'],
        },
      },
    },
  ],
  fileOps: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取指定路径的文件内容。用于查看配置文件、日志文件等。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件的完整路径' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入或创建文件。会自动创建父目录。注意：会覆盖已有内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件的完整路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: '列出目录下的文件和子目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录路径' },
          },
          required: ['path'],
        },
      },
    },
  ],
}

// 危险工具（需要用户确认）
const INTERACTIVE_TOOLS = new Set(['ask_user']) // 交互式工具，不走 confirmToolCall
const DANGEROUS_TOOLS = new Set(['run_command', 'write_file'])

// 安全围栏：极端危险命令模式（任何模式都必须确认，包括无限模式）
const CRITICAL_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]/i,  // rm -rf / 或 rm -f ~/
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\//i,          // rm -r /
  /format\s+[a-zA-Z]:/i,                       // format C:
  /mkfs\./i,                                    // mkfs.ext4 等
  /dd\s+.*of=\/dev\//i,                         // dd of=/dev/sda
  />\s*\/dev\/[sh]d/i,                          // > /dev/sda
  /DROP\s+(DATABASE|TABLE|SCHEMA)/i,            // DROP DATABASE
  /TRUNCATE\s+TABLE/i,                          // TRUNCATE TABLE
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,             // DELETE FROM table (无 WHERE)
  /:(){ :\|:& };:/,                             // fork bomb
  /shutdown|reboot|init\s+[06]/i,              // 关机/重启
  /chmod\s+(-R\s+)?777\s+\//i,                 // chmod 777 /
  /chown\s+(-R\s+)?.*\s+\//i,                  // chown -R ... /
  /curl\s+.*\|\s*(sudo\s+)?bash/i,             // curl | bash
  /wget\s+.*\|\s*(sudo\s+)?bash/i,             // wget | bash
  /npm\s+publish/i,                             // npm publish
  /git\s+push\s+.*--force/i,                    // git push --force
]

function isCriticalCommand(command) {
  if (!command) return false
  return CRITICAL_PATTERNS.some(p => p.test(command))
}

// ── 内置 Skills ──
const BUILTIN_SKILLS = [
  {
    id: 'check-config',
    icon: icon('wrench', 16),
    name: '检查 OpenClaw 配置',
    desc: '读取并分析 openclaw.json，检查配置是否正确',
    tools: ['fileOps'],
    prompt: `请帮我检查 OpenClaw 的配置文件。

具体操作：
1. 调用 get_system_info 获取系统信息，确定主目录和 OS 类型
2. 用 list_directory 查看 ~/.openclaw/ 目录结构
3. 用 read_file 读取 ~/.openclaw/openclaw.json
4. 分析配置内容，检查：
   - models.providers 服务商配置（baseUrl 格式、apiKey 是否存在）
   - gateway 配置（port 默认 18789、mode 必须在 gateway 对象内）
   - 常见配置错误（mode 放在顶层、缺少 gateway 对象、controlUi.allowedOrigins 未配置）
5. 给出配置健康度评估和具体改进建议`,
  },
  {
    id: 'diagnose-gateway',
    icon: icon('shield', 16),
    name: '诊断 Gateway',
    desc: '检查 Gateway 运行状态、端口、日志',
    tools: ['terminal', 'fileOps'],
    prompt: `请帮我诊断 OpenClaw Gateway 的运行状态。

具体操作：
1. 调用 get_system_info 获取 OS 类型和主目录
2. 用 list_processes 工具检查 openclaw/gateway 进程是否在运行
3. 用 check_port 工具检查端口 18789 是否在监听
4. 用 read_file 读取 ~/.openclaw/logs/gateway.log（取最后 50 行）
5. 分析日志中的 ERROR、WARN、fail 等关键词
6. 给出诊断结论（进程状态 + 端口状态 + 日志分析）和修复建议`,
  },
  {
    id: 'browse-dir',
    icon: icon('folder', 16),
    name: '浏览配置目录',
    desc: '查看 .openclaw 目录结构和文件',
    tools: ['fileOps'],
    prompt: `请帮我浏览 OpenClaw 的配置目录结构。

具体操作：
1. 调用 get_system_info 获取主目录路径（Windows: $env:USERPROFILE, Mac/Linux: ~）
2. 用 list_directory 列出 ~/.openclaw/ 根目录
3. 列出 ~/.openclaw/agents/ 下的 Agent 列表
4. 对于 main Agent，列出 ~/.openclaw/agents/main/agent/ 子目录
5. 简要说明每个目录/文件的作用：
   - openclaw.json: 全局配置（模型、Gateway、工具）
   - clawpanel.json: ClawPanel 面板配置
   - mcp.json: MCP 工具配置
   - agents/: Agent 工作目录
   - logs/: 日志文件
   - backups/: 配置备份
6. 标注关键配置文件和常用路径`,
  },
  {
    id: 'check-env',
    icon: icon('monitor', 16),
    name: '检查系统环境',
    desc: '检测 Node.js、npm 版本和系统信息',
    tools: ['terminal'],
    prompt: `请帮我检查当前系统环境是否满足 OpenClaw 的运行要求。

具体操作：
1. 调用 get_system_info 获取 OS、架构、Node.js 版本等基础信息
2. 用 run_command 检查 Node.js 版本（node -v），要求 >= 18
3. 用 run_command 检查 npm 版本（npm -v）
4. 用 run_command 检查 OpenClaw CLI（openclaw --version）
5. 用 check_port 检查 Gateway 端口 18789
6. 给出环境评估报告，每项标注通过/失败，并给出缺失项的安装命令`,
  },
  {
    id: 'analyze-logs',
    icon: icon('clipboard', 16),
    name: '分析错误日志',
    desc: '读取最近日志，定位错误原因',
    tools: ['terminal', 'fileOps'],
    prompt: `请帮我分析 OpenClaw 最近的日志，找出可能的问题。

具体操作：
1. 调用 get_system_info 获取主目录路径
2. 用 list_directory 查看 ~/.openclaw/logs/ 有哪些日志文件
3. 用 read_file 读取 ~/.openclaw/logs/gateway.log
4. 搜索 ERROR、WARN、fail、exception、SIGTERM、Bootstrap 等关键词
5. 对照常见问题速查表分析错误原因
6. 汇总日志分析报告，给出具体修复步骤`,
  },
  {
    id: 'fix-common',
    icon: icon('wrench', 16),
    name: '一键排障',
    desc: '自动检测并修复常见问题',
    tools: ['terminal', 'fileOps'],
    prompt: `请帮我自动检测并修复 OpenClaw 的常见问题。

先调用 get_system_info 获取系统信息，然后按以下步骤逐一检查：
1. **配置检查**：用 read_file 读取 openclaw.json，检查是否有已知错误（mode 在顶层、缺少 gateway 对象等）
2. **models.json 同步**：用 read_file 对比 openclaw.json 和 agents/main/agent/models.json 的 providers
3. **Gateway 状态**：用 list_processes 检查 openclaw 进程，用 check_port 检查端口 18789
4. **WebSocket 配置**：检查 gateway.controlUi.allowedOrigins 是否包含 "*"
5. **Node.js 环境**：用 run_command 检查 node 和 npm 版本

对每个检查项给出通过/失败状态，并对发现的问题给出具体修复命令（但不要自动修改配置文件，等我确认）。`,
  },
  {
    id: 'report-bug',
    icon: icon('bug', 16),
    name: '提交 Bug 报告',
    desc: '整理问题信息，生成标准 Issue 提交到 GitHub',
    tools: ['terminal', 'fileOps'],
    prompt: `我想反馈一个 Bug，请帮我整理成标准的 GitHub Issue。

具体操作：
1. 用 ask_user 工具询问我遇到了什么问题（如果我还没说的话）
2. 调用 get_system_info 获取系统环境信息
3. 用 run_command 收集：openclaw --version、node -v 等版本信息
4. 用 read_file 读取最近的错误日志（如有）
5. 按标准 Issue 模板整理：
   - **问题描述**（一句话）
   - **复现步骤**（1, 2, 3...）
   - **期望行为** / **实际行为**
   - **环境信息**（自动填充）
   - **相关日志**（如有）
6. 用代码块展示完整 Issue 内容，给出对应仓库的 Issue 链接：
   - ClawPanel: https://github.com/qingchencloud/clawpanel/issues/new
   - OpenClaw: https://github.com/qingchencloud/openclaw-zh/issues/new
   - cftunnel: https://github.com/qingchencloud/cftunnel/issues/new
   - ClawApp: https://github.com/qingchencloud/clawapp/issues/new`,
  },
  {
    id: 'pr-assistant',
    icon: icon('zap', 16),
    name: 'PR 助手',
    desc: '定位 Bug 原因，生成修复代码和 PR 描述',
    tools: ['terminal', 'fileOps'],
    prompt: `我发现了一个问题，想提交 PR 来修复它。请帮我走一遍 PR 流程。

具体操作：
1. 先听我描述问题（如果我还没说的话）
2. 帮我分析问题可能的原因，如果有工具可以用就主动调用来诊断
3. 定位到具体的代码/配置/逻辑问题
4. 给出修复方案和具体代码
5. 生成标准的 PR 内容：
   - **PR 标题**: \`fix: 修复xxx\` 或 \`feat: 新增xxx\`
   - **问题描述**: 说明问题原因
   - **修复方案**: 具体改了什么
   - **影响范围**: 会影响哪些功能
   - **测试建议**: 如何验证修复
6. 给出完整的贡献流程：
   - Fork 仓库链接
   - git clone / checkout -b / commit / push 命令
   - 创建 PR 的链接
7. 如果用户不熟悉 Git，给出每一步的详细命令`,
  },
]

function currentMode() {
  return MODES[_config?.mode] ? _config.mode : DEFAULT_MODE
}

function getEnabledTools() {
  const mode = MODES[currentMode()]
  if (!mode.tools) return [] // 聊天模式：无工具

  const t = _config.tools || {}
  const tools = [...TOOL_DEFS.system, ...TOOL_DEFS.process, ...TOOL_DEFS.interaction]

  // 终端工具：受设置开关控制（优先级高于模式）
  if (t.terminal !== false) tools.push(...TOOL_DEFS.terminal)

  // 联网搜索工具：受设置开关控制
  if (t.webSearch !== false) tools.push(...TOOL_DEFS.webSearch)

  // 文件工具：受设置开关控制 + 规划模式排除写入
  if (t.fileOps !== false) {
    if (mode.readOnly) {
      tools.push(...TOOL_DEFS.fileOps.filter(td => td.function.name !== 'write_file'))
    } else {
      tools.push(...TOOL_DEFS.fileOps)
    }
  }

  return tools
}

function applyModeStyle(page, modeKey) {
  const main = page.querySelector('.ast-main') || page
  main.dataset.mode = modeKey
  positionModeSlider(page, modeKey)
}

function positionModeSlider(page, modeKey) {
  const selector = page?.querySelector('#ast-mode-selector')
  const slider = page?.querySelector('#ast-mode-slider')
  const activeBtn = selector?.querySelector(`.ast-mode-btn[data-mode="${modeKey}"]`)
  if (!selector || !slider || !activeBtn) return

  const sRect = selector.getBoundingClientRect()
  const bRect = activeBtn.getBoundingClientRect()
  slider.style.width = bRect.width + 'px'
  slider.style.left = (bRect.left - sRect.left) + 'px'
  slider.style.opacity = '1'
}

const MODE_COLORS = {
  chat: { primary: '#6b7280', rgb: '107,114,128' },
  plan: { primary: '#3b82f6', rgb: '59,130,246' },
  execute: { primary: '#8b5cf6', rgb: '139,92,246' },
  unlimited: { primary: '#f59e0b', rgb: '245,158,11' },
}

function playModeTransition(page, modeKey) {
  const main = page?.querySelector('.ast-main')
  const header = page?.querySelector('.ast-header')
  const selector = page?.querySelector('#ast-mode-selector')
  if (!main || !header) return

  const mc = MODE_COLORS[modeKey] || MODE_COLORS.execute
  const m = MODES[modeKey]

  // ① 全屏涟漪扩散
  const ripple = document.createElement('div')
  ripple.className = 'ast-mode-ripple'
  // 从模式选择器位置发射
  if (selector) {
    const sRect = selector.getBoundingClientRect()
    const mRect = main.getBoundingClientRect()
    ripple.style.setProperty('--ripple-x', (sRect.left + sRect.width / 2 - mRect.left) + 'px')
    ripple.style.setProperty('--ripple-y', (sRect.top + sRect.height / 2 - mRect.top) + 'px')
  }
  ripple.style.setProperty('--ripple-color', mc.primary)
  main.appendChild(ripple)
  setTimeout(() => ripple.remove(), 800)

  // ② 粒子爆发
  if (selector) {
    const sRect = selector.getBoundingClientRect()
    const mRect = main.getBoundingClientRect()
    const cx = sRect.left + sRect.width / 2 - mRect.left
    const cy = sRect.top + sRect.height / 2 - mRect.top
    for (let i = 0; i < 24; i++) {
      const p = document.createElement('div')
      p.className = 'ast-mode-particle'
      const angle = (Math.PI * 2 * i) / 24 + (Math.random() - 0.5) * 0.5
      const dist = 60 + Math.random() * 120
      const size = 3 + Math.random() * 4
      p.style.setProperty('--px', cx + 'px')
      p.style.setProperty('--py', cy + 'px')
      p.style.setProperty('--dx', (Math.cos(angle) * dist) + 'px')
      p.style.setProperty('--dy', (Math.sin(angle) * dist - 30) + 'px')
      p.style.setProperty('--size', size + 'px')
      p.style.setProperty('--color', mc.primary)
      p.style.setProperty('--delay', (Math.random() * 0.1) + 's')
      p.style.setProperty('--duration', (0.5 + Math.random() * 0.4) + 's')
      main.appendChild(p)
      setTimeout(() => p.remove(), 1000)
    }
  }

  // ③ Header 脉冲
  header.classList.remove('ast-mode-pulse')
  void header.offsetWidth
  header.classList.add('ast-mode-pulse')

  // ④ 模式简介浮现
  const existing = page.querySelector('.ast-mode-toast')
  if (existing) existing.remove()
  if (!m) return
  const tip = document.createElement('div')
  tip.className = `ast-mode-toast mode-${modeKey}`
  tip.innerHTML = `<span class="ast-mode-toast-icon">${MODE_ICONS[modeKey]}</span><span class="ast-mode-toast-label">${m.label}</span><span class="ast-mode-toast-desc">${m.desc}</span>`
  main.appendChild(tip)
  setTimeout(() => tip.classList.add('show'), 10)
  setTimeout(() => { tip.classList.remove('show'); setTimeout(() => tip.remove(), 300) }, 2000)
}

function buildSystemPrompt() {
  let prompt = ''

  // 灵魂移植模式：用 OpenClaw Agent 的身份替代默认人设
  if (_config?.soulSource?.startsWith('openclaw:') && _soulCache) {
    prompt += '# 你的身份\n'
    if (_soulCache.identity) prompt += _soulCache.identity + '\n\n'
    if (_soulCache.soul) prompt += '# 灵魂\n' + _soulCache.soul + '\n\n'
    if (_soulCache.user) prompt += '# 你的用户\n' + _soulCache.user + '\n\n'
    if (_soulCache.agents) {
      // 截断 AGENTS.md 到约 4000 字符以节省 token
      const agentsContent = _soulCache.agents.length > 4000 ? _soulCache.agents.slice(0, 4000) + '\n\n[...已截断]' : _soulCache.agents
      prompt += '# 操作规则\n' + agentsContent + '\n\n'
    }
    if (_soulCache.tools) prompt += '# 工具笔记\n' + _soulCache.tools + '\n\n'
    if (_soulCache.memory) {
      const memContent = _soulCache.memory.length > 3000 ? _soulCache.memory.slice(-3000) : _soulCache.memory
      prompt += '# 长期记忆\n' + memContent + '\n\n'
    }
    if (_soulCache.recentMemories?.length) {
      prompt += '# 最近记忆\n'
      for (const m of _soulCache.recentMemories) {
        const content = m.content.length > 800 ? m.content.slice(0, 800) + '...' : m.content
        prompt += `## ${m.date}\n${content}\n\n`
      }
    }
    // 追加 ClawPanel 特有的产品知识和工具说明
    prompt += '\n# ClawPanel 工具能力\n你同时是 ClawPanel 内置助手，拥有以下额外能力：\n'
    prompt += '- 执行终端命令、读写文件、浏览目录\n'
    prompt += '- 联网搜索和网页抓取\n'
    prompt += '- 管理 OpenClaw 配置和服务\n'
    prompt += '- 你精通 OpenClaw 的架构、配置、Gateway、Agent 管理\n'
  } else {
    prompt += getSystemPromptBase()
  }

  const modeKey = currentMode()
  const mode = MODES[modeKey]

  // 模式说明
  prompt += `\n\n## 当前模式：${mode.label}模式`

  if (modeKey === 'chat') {
    prompt += '\n你处于纯聊天模式，没有任何工具可用。请通过文字回答问题，给出具体的命令建议供用户手动执行。'
    prompt += '\n如果用户需要你执行操作，建议用户切换到「执行」或「规划」模式。'
  } else {
    // 规划模式特殊指令
    if (modeKey === 'plan') {
      prompt += '\n**你处于规划模式**：可以调用工具读取信息、分析问题，但 **绝对不能修改任何文件**（write_file 已禁用）。'
      prompt += '\n你的任务是：分析问题 → 制定方案 → 输出详细步骤，让用户确认后再切换到执行模式操作。'
      prompt += '\n即使使用 run_command，也只能执行只读命令（查看、检查、列出），不要执行任何修改操作。'
    }
    if (modeKey === 'unlimited') {
      prompt += '\n**你处于无限模式**：所有工具调用无需用户确认，请高效完成任务。'
    }

    prompt += '\n\n### 可用工具'
    prompt += '\n- **用户交互**: ask_user — 向用户提问（单选/多选/文本），获取结构化回答。需要用户做决定时优先用此工具。'
    prompt += '\n- **系统信息**: get_system_info — 获取 OS 类型、架构、主目录等。**在执行任何命令前必须先调用此工具**。'
    prompt += '\n- **进程/端口**: list_processes（按名称过滤）、check_port（检测端口占用）'
    prompt += '\n- **终端**: run_command — 执行 shell 命令'
    if (mode.readOnly) {
      prompt += '\n- **文件**: read_file、list_directory（只读，write_file 已禁用）'
    } else {
      prompt += '\n- **文件**: read_file、write_file、list_directory'
    }

    prompt += '\n\n### 终端命令规范（极其重要）'
    prompt += '\n- **Windows**: 终端是 **PowerShell**，必须使用 PowerShell 语法：'
    prompt += '\n  - 列目录: `Get-ChildItem` 或 `ls`（不要用 `dir`）'
    prompt += '\n  - 看文件: `Get-Content` 或 `cat`（不要用 `type`）'
    prompt += '\n  - 查进程: `Get-Process | Where-Object { $_.Name -like \"*openclaw*\" }`'
    prompt += '\n  - 查端口: `Get-NetTCPConnection -LocalPort 18789`'
    prompt += '\n  - 文件尾: `Get-Content file.log -Tail 50`'
    prompt += '\n  - 搜内容: `Select-String -Path file.log -Pattern \"ERROR\"`'
    prompt += '\n  - 环境变量: `$env:USERPROFILE`（不要用 `%USERPROFILE%`）'
    prompt += '\n- **macOS**: zsh，标准 Unix 命令'
    prompt += '\n- **Linux**: bash，标准 Unix 命令'
    prompt += '\n- **绝对禁止** cmd.exe 语法（dir、type、findstr、netstat）'
    prompt += '\n- **一次只执行一条命令**，等结果出来再决定下一步'
    prompt += '\n- **不要重复执行相同的命令**'
    prompt += '\n\n### 跨平台路径'
    prompt += '\n- Windows: `$env:USERPROFILE\\.openclaw\\`'
    prompt += '\n- macOS/Linux: `~/.openclaw/`'
    prompt += '\n\n### 工具使用原则'
    prompt += '\n- 先 get_system_info，再根据 OS 执行正确命令'
    prompt += '\n- 优先用 read_file / list_directory / list_processes / check_port 等专用工具，减少 run_command 使用'
    prompt += '\n- 主动使用工具，不要只建议用户手动操作'
    if (mode.confirmDanger) {
      prompt += '\n- 执行破坏性操作前先告知用户'
    }
  }

  // 注入内置技能列表
  prompt += '\n\n## 内置技能卡片'
  prompt += '\n用户可以在欢迎页点击技能卡片快速触发操作。当用户遇到问题时，你也可以主动推荐合适的技能：'
  for (const s of BUILTIN_SKILLS) {
    prompt += `\n- **${s.name}**（${s.desc}）`
  }
  prompt += '\n\n当用户的需求匹配某个技能时，可以建议用户点击对应的技能卡片，或者你直接按技能的步骤操作。'

  // 注入内置 OpenClaw 知识库
  prompt += '\n\n' + OPENCLAW_KB

  // 注入用户自定义知识库内容
  const kbEnabled = (_config.knowledgeFiles || []).filter(f => f.enabled !== false && f.content)
  if (kbEnabled.length > 0) {
    prompt += '\n\n## 用户自定义知识库'
    prompt += '\n以下是用户提供的参考知识，回答问题时请优先参考这些内容：'
    for (const kb of kbEnabled) {
      const content = kb.content.length > 5000 ? kb.content.slice(0, 5000) + '\n\n[...内容已截断]' : kb.content
      prompt += `\n\n### ${kb.name}\n${content}`
    }
  }

  return prompt
}

// ── 灵魂移植：扫描可用 Agent ──
async function scanOpenClawAgents() {
  try {
    const sysInfo = await api.assistantSystemInfo()
    const home = sysInfo.match(/主目录[:：]\s*(.+)/)?.[1]?.trim() || sysInfo.match(/Home[:：]\s*(.+)/)?.[1]?.trim() || ''
    if (!home) return []
    const agents = []
    // 默认主工作区始终存在于 ~/.openclaw/workspace
    let defaultExists = false
    try { await api.assistantListDir(home + '/.openclaw/workspace'); defaultExists = true } catch {}
    agents.push({ id: 'default', label: '默认 (主工作区)', hasWorkspace: defaultExists })
    // 扫描自定义 Agent
    try {
      const agentsDir = home + '/.openclaw/agents'
      const listing = await api.assistantListDir(agentsDir)
      const dirs = listing.split('\n').filter(l => l.includes('[DIR]'))
        .map(l => l.replace(/^\[DIR\]\s*/, '').replace(/[\/\\]+$/, '').trim()).filter(Boolean)
      for (const id of dirs) {
        if (id === 'main') continue // main 就是默认，已在上面添加
        const wsPath = agentsDir + '/' + id + '/workspace'
        let hasWorkspace = false
        try { await api.assistantListDir(wsPath); hasWorkspace = true } catch {}
        agents.push({ id, label: id, hasWorkspace })
      }
    } catch {}
    return agents
  } catch (err) {
    console.error('[soul] 扫描 Agent 失败:', err)
    return []
  }
}

// ── 灵魂移植：加载指定 Agent 的身份 ──
async function loadOpenClawSoul(agentId = 'default') {
  try {
    const sysInfo = await api.assistantSystemInfo()
    const home = sysInfo.match(/主目录[:：]\s*(.+)/)?.[1]?.trim() || sysInfo.match(/Home[:：]\s*(.+)/)?.[1]?.trim() || ''
    if (!home) throw new Error('无法获取主目录')
    // default/main 使用 ~/.openclaw/workspace，其他使用 agents/{id}/workspace
    let ws
    if (agentId === 'default' || agentId === 'main') {
      ws = home + '/.openclaw/workspace'
    } else {
      ws = home + '/.openclaw/agents/' + agentId + '/workspace'
    }
    let wsExists = false
    try { await api.assistantListDir(ws); wsExists = true } catch {}
    if (!wsExists) throw new Error('Agent workspace 不存在: ' + agentId)

    const readSafe = async (p) => { try { return await api.assistantReadFile(p) } catch { return null } }

    const soul = {
      agentId,
      identity: await readSafe(ws + '/IDENTITY.md'),
      soul: await readSafe(ws + '/SOUL.md'),
      user: await readSafe(ws + '/USER.md'),
      agents: await readSafe(ws + '/AGENTS.md'),
      tools: await readSafe(ws + '/TOOLS.md'),
      memory: await readSafe(ws + '/MEMORY.md'),
      recentMemories: [],
    }

    // 读取最近 3 天的每日记忆
    try {
      const memDir = await api.assistantListDir(ws + '/memory')
      const files = memDir.split('\n').map(l => l.trim()).filter(l => l.match(/\d{4}-\d{2}-\d{2}/))
      const recent = files.sort().slice(-3)
      for (const f of recent) {
        const fname = f.replace(/^\[FILE\]\s*/, '').replace(/\s*\(.*\)$/, '').trim()
        const content = await readSafe(ws + '/memory/' + fname)
        if (content) soul.recentMemories.push({ date: fname, content })
      }
    } catch {}

    _soulCache = soul
    return soul
  } catch (err) {
    console.error('[soul] 加载失败:', err)
    _soulCache = null
    return null
  }
}

// 获取灵魂文件的统计信息（用于 UI 显示）
function getSoulStats() {
  if (!_soulCache) return []
  const files = [
    { name: 'SOUL.md', desc: '灵魂 · 人格边界', content: _soulCache.soul },
    { name: 'IDENTITY.md', desc: '身份 · 名称形象', content: _soulCache.identity },
    { name: 'USER.md', desc: '用户 · 偏好称呼', content: _soulCache.user },
    { name: 'AGENTS.md', desc: '规则 · 操作指令', content: _soulCache.agents },
    { name: 'TOOLS.md', desc: '笔记 · 工具环境', content: _soulCache.tools },
    { name: 'MEMORY.md', desc: '记忆 · 长期存储', content: _soulCache.memory },
  ]
  return files.map(f => ({
    name: f.name,
    desc: f.desc,
    loaded: !!f.content,
    size: f.content ? f.content.length : 0,
  }))
}

// 渲染灵魂文件加载状态卡片
function renderSoulStats(soul) {
  if (!soul) return ''
  const stats = getSoulStats()
  const loaded = stats.filter(f => f.loaded)
  const totalSize = stats.reduce((s, f) => s + f.size, 0)
  const memCount = soul.recentMemories?.length || 0
  const sizeStr = totalSize > 1024 ? (totalSize / 1024).toFixed(1) + ' KB' : totalSize + ' B'

  let html = `<div class="ast-soul-header">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    <span>已加载 <strong>${loaded.length}/${stats.length}</strong> 个文件（${sizeStr}）</span>
  </div>`

  html += '<div class="ast-soul-files">'
  for (const f of stats) {
    const fSize = f.loaded ? (f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B') : '—'
    html += `<div class="ast-soul-file ${f.loaded ? 'loaded' : 'missing'}">
      <div class="ast-soul-file-icon">${f.loaded ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}</div>
      <div class="ast-soul-file-info">
        <span class="ast-soul-file-name">${f.name}</span>
        <span class="ast-soul-file-desc">${f.desc}</span>
      </div>
      <span class="ast-soul-file-size">${fSize}</span>
    </div>`
  }
  if (memCount > 0) {
    html += `<div class="ast-soul-file loaded">
      <div class="ast-soul-file-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="ast-soul-file-info">
        <span class="ast-soul-file-name">memory/</span>
        <span class="ast-soul-file-desc">每日记忆日志</span>
      </div>
      <span class="ast-soul-file-size">${memCount} 个文件</span>
    </div>`
  }
  html += '</div>'
  return html
}

// ── 状态 ──
let _page = null, _messagesEl = null, _textarea = null, _sendBtn = null
let _sessionListEl = null, _settingsPanel = null, _queueEl = null
let _isStreaming = false, _abortController = null
let _config = null, _sessions = [], _currentSessionId = null
let _lastRenderTime = 0
let _saveThrottleTimer = null
const _sessionStatus = new Map() // sessionId → 'idle' | 'streaming' | 'waiting' | 'error'
let _messageQueue = [] // [{ id, text, ts }]
let _streamRefreshTimer = null // 后台流式刷新定时器
let _pendingImages = [] // [{ id, dataUrl, name, size }] 待发送图片
let _errorContext = null // 待处理的错误上下文 { scene, title, hint, error, ts }
let _soulCache = null // 灵魂移植缓存 { identity, soul, user, agents, tools, memory, recentMemories[] }

// ── 节流保存 ──
function throttledSave() {
  if (_saveThrottleTimer) return
  _saveThrottleTimer = setTimeout(() => {
    _saveThrottleTimer = null
    saveSessions()
  }, 500)
}

function flushSave() {
  if (_saveThrottleTimer) {
    clearTimeout(_saveThrottleTimer)
    _saveThrottleTimer = null
  }
  saveSessions()
}

// ── 后台流式刷新 ──
// 当用户切页面再回来时，轮询刷新最后一个 AI 气泡内容
function refreshStreamingBubble() {
  if (!_messagesEl || !_isStreaming) return
  const session = getCurrentSession()
  if (!session) return
  const lastMsg = session.messages[session.messages.length - 1]
  if (!lastMsg || lastMsg.role !== 'assistant') return

  const bubbles = _messagesEl.querySelectorAll('.ast-msg-bubble-ai')
  const lastBubble = bubbles[bubbles.length - 1]
  if (lastBubble && lastMsg.content) {
    lastBubble.innerHTML = renderMarkdown(lastMsg.content) + '<span class="ast-cursor">▊</span>'
    _messagesEl.scrollTop = _messagesEl.scrollHeight
  }
}

function startStreamRefresh() {
  stopStreamRefresh()
  _streamRefreshTimer = setInterval(refreshStreamingBubble, 200)
}

function stopStreamRefresh() {
  if (_streamRefreshTimer) {
    clearInterval(_streamRefreshTimer)
    _streamRefreshTimer = null
  }
}

// ── 发送队列 ──
function enqueueMessage(text) {
  _messageQueue.push({ id: Date.now().toString(), text, ts: Date.now() })
  renderQueue()
}

function renderQueue() {
  if (!_queueEl) return
  if (_messageQueue.length === 0) {
    _queueEl.innerHTML = ''
    _queueEl.style.display = 'none'
    return
  }
  _queueEl.style.display = 'block'
  const queueSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
  const sendSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
  const editSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
  const delSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

  _queueEl.innerHTML = `<div class="ast-queue-header">${queueSvg} 发送队列 (${_messageQueue.length})</div>` +
    _messageQueue.map((item, i) => `
      <div class="ast-queue-item" data-queue-id="${item.id}">
        <span class="ast-queue-num">${i + 1}</span>
        <span class="ast-queue-text" data-queue-edit="${item.id}" title="点击编辑">${escHtml(item.text)}</span>
        <div class="ast-queue-actions">
          <button class="ast-queue-btn edit" data-queue-edit-btn="${item.id}" title="编辑">${editSvg}</button>
          <button class="ast-queue-btn send" data-queue-send="${item.id}" title="立即发送（插队）">${sendSvg}</button>
          <button class="ast-queue-btn delete" data-queue-del="${item.id}" title="删除">${delSvg}</button>
        </div>
      </div>
    `).join('')
}

function processQueue() {
  if (_isStreaming || _messageQueue.length === 0) return
  const next = _messageQueue.shift()
  renderQueue()
  sendMessageDirect(next.text)
}

// ── 图片附件 ──
const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB
const MAX_IMAGE_DIM = 2048 // 最大边长

function addImageFromFile(file) {
  if (!file.type.startsWith('image/')) return
  if (file.size > MAX_IMAGE_SIZE * 2) {
    toast('图片太大（超过 8MB）', 'error')
    return
  }
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      // 超大图片压缩
      let { width, height } = img
      if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
        const scale = MAX_IMAGE_DIM / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)
      // JPEG 压缩到合理大小
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      _pendingImages.push({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        dataUrl,
        name: file.name || 'image.jpg',
        width, height,
      })
      renderImagePreview()
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

function addImageFromClipboard(item) {
  const file = item.getAsFile()
  if (file) addImageFromFile(file)
}

function removeImage(id) {
  _pendingImages = _pendingImages.filter(img => img.id !== id)
  renderImagePreview()
}

function renderImagePreview() {
  const container = _page?.querySelector('#ast-image-preview')
  if (!container) return
  if (_pendingImages.length === 0) {
    container.innerHTML = ''
    container.style.display = 'none'
    return
  }
  container.style.display = 'flex'
  const delSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  container.innerHTML = _pendingImages.map(img => `
    <div class="ast-img-thumb" data-img-id="${img.id}">
      <img src="${img.dataUrl}" alt="${escHtml(img.name)}"/>
      <button class="ast-img-thumb-del" data-img-del="${img.id}" title="移除">${delSvg}</button>
    </div>
  `).join('')
}

function clearPendingImages() {
  _pendingImages = []
  renderImagePreview()
}

// 构建多模态消息 content
function buildMessageContent(text, images) {
  if (!images || images.length === 0) return text
  const parts = []
  if (text) parts.push({ type: 'text', text })
  for (const img of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: img.dataUrl, detail: 'auto' },
    })
  }
  return parts
}

// ── 会话状态管理 ──
function setSessionStatus(sessionId, status) {
  if (status === 'idle') {
    _sessionStatus.delete(sessionId)
  } else {
    _sessionStatus.set(sessionId, status)
  }
  renderSessionList()
}

function getSessionStatus(sessionId) {
  return _sessionStatus.get(sessionId) || 'idle'
}

// ── 带重试的 fetch ──
async function fetchWithRetry(url, options, retries = 3) {
  const delays = [1000, 3000, 8000]
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, options)
      if (resp.ok || resp.status < 500 || i >= retries) return resp
      // 5xx 服务端错误，静默重试
      await new Promise(r => setTimeout(r, delays[i]))
    } catch (err) {
      if (err.name === 'AbortError') throw err // 用户手动中止，不重试
      if (i >= retries) throw err
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
}

// ── 配置读写 ──
function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    _config = raw ? JSON.parse(raw) : null
  } catch { _config = null }
  if (!_config) {
    _config = { baseUrl: '', apiKey: '', model: '', temperature: 0.7, tools: { terminal: false, fileOps: false, webSearch: false }, assistantName: DEFAULT_NAME, assistantPersonality: DEFAULT_PERSONALITY }
  }
  if (!_config.assistantName) _config.assistantName = DEFAULT_NAME
  if (!_config.assistantPersonality) _config.assistantPersonality = DEFAULT_PERSONALITY
  if (!_config.tools) _config.tools = { terminal: false, fileOps: false, webSearch: false }
  if (!_config.mode) _config.mode = DEFAULT_MODE
  if (!_config.apiType) _config.apiType = 'openai'
  if (!Array.isArray(_config.knowledgeFiles)) _config.knowledgeFiles = []
  return _config
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_config))
}

// ── 会话管理 ──
function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    _sessions = raw ? JSON.parse(raw) : []
  } catch { _sessions = [] }
  return _sessions
}

function saveSessions() {
  if (_sessions.length > MAX_SESSIONS) {
    _sessions = _sessions.slice(-MAX_SESSIONS)
  }
  // 保存时剥离图片 dataUrl（避免撑爆 localStorage）
  const serialized = JSON.stringify(_sessions, (key, value) => {
    if (key === 'dataUrl' && typeof value === 'string' && value.startsWith('data:image/')) return undefined
    if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) return '[image]'
    return value
  })
  try {
    localStorage.setItem(SESSIONS_KEY, serialized)
  } catch (e) {
    // QuotaExceeded: 清理最旧的会话
    if (e.name === 'QuotaExceededError' && _sessions.length > 1) {
      _sessions.shift()
      saveSessions()
    }
  }
}

function getCurrentSession() {
  return _sessions.find(s => s.id === _currentSessionId) || null
}

function createSession() {
  const session = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2),
    title: '新会话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  _sessions.push(session)
  _currentSessionId = session.id
  saveSessions()
  return session
}

function deleteSession(id) {
  _sessions = _sessions.filter(s => s.id !== id)
  if (_currentSessionId === id) {
    _currentSessionId = _sessions.length > 0 ? _sessions[_sessions.length - 1].id : null
  }
  saveSessions()
}

function autoTitle(session) {
  if (session.messages.length >= 1 && session.title === '新会话') {
    const firstUser = session.messages.find(m => m.role === 'user')
    if (firstUser) {
      const txt = firstUser._text || (typeof firstUser.content === 'string' ? firstUser.content : (firstUser.content?.find?.(p => p.type === 'text')?.text || '[图片消息]'))
      // 取第一行或前30字作为标题（跳过空行）
      const firstLine = txt.split('\n').find(l => l.trim()) || txt
      const title = firstLine.slice(0, 30) + (firstLine.length > 30 ? '...' : '')
      session.title = title
    }
  }
}

// ── AI API 调用（自动兼容 Chat Completions + Responses API）──

function cleanBaseUrl(raw, apiType) {
  let base = raw.replace(/\/+$/, '')
  base = base.replace(/\/chat\/completions\/?$/, '')
  base = base.replace(/\/completions\/?$/, '')
  base = base.replace(/\/responses\/?$/, '')
  base = base.replace(/\/messages\/?$/, '')
  const type = apiType || _config.apiType || 'openai'
  if (type === 'anthropic') {
    // Anthropic: https://api.anthropic.com/v1
    if (!base.endsWith('/v1')) base += '/v1'
    return base
  }
  if (type === 'google-gemini') {
    // Gemini: https://generativelanguage.googleapis.com/v1beta
    return base
  }
  if (!base.endsWith('/v1')) base = base.replace(/\/v1\/.*$/, '/v1')
  return base
}

function authHeaders(apiType, apiKey) {
  const type = apiType || _config.apiType || 'openai'
  const key = apiKey || _config.apiKey || ''
  if (type === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  }
}

// 超时常量
const TIMEOUT_TOTAL = 120_000    // 总超时 120 秒
const TIMEOUT_CHUNK = 30_000     // 流式 chunk 间隔超时 30 秒
const TIMEOUT_CONNECT = 30_000   // 连接超时 30 秒

async function callAI(messages, onChunk) {
  if (!_config.baseUrl || !_config.apiKey || !_config.model) {
    throw new Error('请先配置 AI 模型（点击右上角设置按钮）')
  }

  const base = cleanBaseUrl(_config.baseUrl)
  _abortController = new AbortController()
  const allMessages = [{ role: 'system', content: buildSystemPrompt() }, ...messages]

  // 总超时保护
  let _timedOut = false
  const totalTimer = setTimeout(() => {
    _timedOut = true
    if (_abortController) _abortController.abort()
  }, TIMEOUT_TOTAL)

  try {
    const apiType = _config.apiType || 'openai'

    if (apiType === 'anthropic') {
      await callAnthropicMessages(base, allMessages, onChunk)
      return
    }

    if (apiType === 'google-gemini') {
      await callGeminiGenerate(base, allMessages, onChunk)
      return
    }

    // OpenAI: 先尝试 Chat Completions API
    try {
      await callChatCompletions(base, allMessages, onChunk)
      return
    } catch (err) {
      // 超时触发的 abort → 转换为超时错误
      if (err.name === 'AbortError' && _timedOut) {
        throw new Error(`请求超时（${TIMEOUT_TOTAL / 1000} 秒），模型响应时间过长`)
      }
      // 如果是 "legacy protocol" 或 "use /v1/responses" 类错误，自动切换到 Responses API
      const msg = err.message || ''
      if (msg.includes('legacy protocol') || msg.includes('/v1/responses') || msg.includes('not supported')) {
        console.log('[assistant] Chat Completions 不支持此模型，自动切换到 Responses API')
        _abortController = new AbortController()
        await callResponsesAPI(base, allMessages, onChunk)
        return
      }
      throw err
    }
  } finally {
    clearTimeout(totalTimer)
  }
}

// ── 调试信息 ──
let _lastDebugInfo = null

// ── Chat Completions API（/v1/chat/completions）──
async function callChatCompletions(base, messages, onChunk) {
  const url = base + '/chat/completions'
  const body = {
    model: _config.model,
    messages,
    stream: true,
    temperature: _config.temperature || 0.7,
  }

  const reqTime = Date.now()
  _lastDebugInfo = {
    url,
    method: 'POST',
    requestBody: { ...body, messages: body.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '') : '[multimodal]' })) },
    requestTime: new Date(reqTime).toLocaleString('zh-CN'),
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: _abortController.signal,
  })

  _lastDebugInfo.status = resp.status
  _lastDebugInfo.contentType = resp.headers.get('content-type') || ''
  _lastDebugInfo.responseTime = new Date().toLocaleString('zh-CN')
  _lastDebugInfo.latency = Date.now() - reqTime + 'ms'

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    _lastDebugInfo.errorBody = errText.slice(0, 500)
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  // 检测响应是否为 SSE 流式
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    _lastDebugInfo.streaming = true
    let chunkCount = 0
    let contentChunks = 0
    let reasoningChunks = 0
    let reasoningBuf = ''

    await readSSEStream(resp, (json) => {
      chunkCount++
      const d = json.choices?.[0]?.delta
      if (!d) return

      // content 和 reasoning_content 分开处理
      if (d.content) {
        contentChunks++
        onChunk(d.content)
      } else if (d.reasoning_content) {
        reasoningChunks++
        reasoningBuf += d.reasoning_content
      }
    }, _abortController?.signal)

    _lastDebugInfo.chunks = { total: chunkCount, content: contentChunks, reasoning: reasoningChunks }

    // 如果没有 content 但有 reasoning，将推理内容作为回复（部分模型只返回 reasoning）
    if (contentChunks === 0 && reasoningBuf) {
      console.warn('[assistant] 无 content 块，使用 reasoning_content 作为回复')
      onChunk(reasoningBuf)
      _lastDebugInfo.fallbackToReasoning = true
    }
  } else {
    // 非流式响应：API 忽略了 stream:true，直接返回完整 JSON
    _lastDebugInfo.streaming = false
    const json = await resp.json()
    _lastDebugInfo.responseBody = { id: json.id, model: json.model, object: json.object, usage: json.usage }
    console.log('[assistant] 非流式响应:', json)
    const msg = json.choices?.[0]?.message
    const content = msg?.content || msg?.reasoning_content || ''
    if (content) onChunk(content)
  }
}

// ── Responses API（/v1/responses）──
async function callResponsesAPI(base, messages, onChunk) {
  const url = base + '/responses'
  const input = messages.filter(m => m.role !== 'system')
  const instructions = messages.find(m => m.role === 'system')?.content || ''

  const body = {
    model: _config.model,
    input,
    instructions,
    stream: true,
    temperature: _config.temperature || 0.7,
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: _abortController.signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  await readSSEStream(resp, (json) => {
    // Responses API 的流式事件格式
    if (json.type === 'response.output_text.delta') {
      if (json.delta) onChunk(json.delta)
    }
    // 兼容：有些代理会转换为 choices 格式
    if (json.choices?.[0]?.delta?.content) {
      onChunk(json.choices[0].delta.content)
    }
  }, _abortController?.signal)
}

// ── Anthropic Messages API（/v1/messages）──
async function callAnthropicMessages(base, messages, onChunk) {
  const url = base + '/messages'
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  const body = {
    model: _config.model,
    max_tokens: 8192,
    stream: true,
    temperature: _config.temperature || 0.7,
  }
  if (systemMsg) body.system = systemMsg
  body.messages = chatMessages

  const reqTime = Date.now()
  _lastDebugInfo = {
    url, method: 'POST',
    requestBody: { ...body, messages: body.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '') : '[multimodal]' })) },
    requestTime: new Date(reqTime).toLocaleString('zh-CN'),
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: _abortController.signal,
  })

  _lastDebugInfo.status = resp.status
  _lastDebugInfo.contentType = resp.headers.get('content-type') || ''
  _lastDebugInfo.responseTime = new Date().toLocaleString('zh-CN')
  _lastDebugInfo.latency = Date.now() - reqTime + 'ms'

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    _lastDebugInfo.errorBody = errText.slice(0, 500)
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  _lastDebugInfo.streaming = true
  let chunkCount = 0, contentChunks = 0, thinkingChunks = 0
  let thinkingBuf = ''

  await readSSEStream(resp, (json) => {
    chunkCount++
    if (json.type === 'content_block_delta') {
      const delta = json.delta
      if (delta?.type === 'text_delta' && delta.text) {
        contentChunks++
        onChunk(delta.text)
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        thinkingChunks++
        thinkingBuf += delta.thinking
      }
    }
  }, _abortController?.signal)

  _lastDebugInfo.chunks = { total: chunkCount, content: contentChunks, thinking: thinkingChunks }

  if (contentChunks === 0 && thinkingBuf) {
    console.warn('[assistant] Anthropic: 无 text 块，使用 thinking 作为回复')
    onChunk(thinkingBuf)
    _lastDebugInfo.fallbackToThinking = true
  }
}

// ── Google Gemini API ──
async function callGeminiGenerate(base, messages, onChunk) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  // Gemini 格式转换
  const contents = chatMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }))

  const body = {
    contents,
    generationConfig: { temperature: _config.temperature || 0.7 },
  }
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg }] }
  }

  const url = `${base}/models/${_config.model}:streamGenerateContent?alt=sse&key=${_config.apiKey}`

  const reqTime = Date.now()
  _lastDebugInfo = { url: url.replace(_config.apiKey, '***'), method: 'POST', requestTime: new Date(reqTime).toLocaleString('zh-CN') }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: _abortController.signal,
  })

  _lastDebugInfo.status = resp.status
  _lastDebugInfo.latency = Date.now() - reqTime + 'ms'

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }

  _lastDebugInfo.streaming = true
  let chunkCount = 0

  await readSSEStream(resp, (json) => {
    chunkCount++
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) onChunk(text)
  }, _abortController?.signal)

  _lastDebugInfo.chunks = { total: chunkCount }
}

// ── 通用 SSE 流读取 ──
async function readSSEStream(resp, onEvent, signal) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 监听 abort 信号 → 取消 reader（关键：fetch abort 不会自动取消已建立的流）
  const onAbort = () => { try { reader.cancel() } catch {} }
  if (signal) {
    if (signal.aborted) { reader.cancel(); throw new DOMException('Aborted', 'AbortError') }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      // chunk 超时：如果 30 秒内没有收到任何数据，视为超时
      const readPromise = reader.read()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('流式响应超时：30 秒内未收到数据')), TIMEOUT_CHUNK)
      )
      const { done, value } = await Promise.race([readPromise, timeoutPromise])
      if (done) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const trimmed = line.trim()
        if (!trimmed) continue

        // 处理 SSE event: 行
        if (trimmed.startsWith('event:')) continue

        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return

        try {
          onEvent(JSON.parse(data))
        } catch {}
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// ── 工具执行 ──

async function executeTool(name, args) {
  switch (name) {
    case 'run_command':
      return await api.assistantExec(args.command, args.cwd)
    case 'read_file':
      return await api.assistantReadFile(args.path)
    case 'write_file':
      return await api.assistantWriteFile(args.path, args.content)
    case 'list_directory':
      return await api.assistantListDir(args.path)
    case 'get_system_info':
      return await api.assistantSystemInfo()
    case 'list_processes':
      return await api.assistantListProcesses(args.filter)
    case 'check_port':
      return await api.assistantCheckPort(args.port)
    case 'ask_user':
      return await showAskUserCard(args)
    case 'web_search':
      return await api.assistantWebSearch(args.query, args.max_results)
    case 'fetch_url':
      return await api.assistantFetchUrl(args.url)
    default:
      return `未知工具: ${name}`
  }
}

// ── ask_user 交互卡片 ──
function showAskUserCard({ question, type, options, placeholder }) {
  const session = getCurrentSession()
  if (session) setSessionStatus(session.id, 'waiting')
  return new Promise((resolve) => {
    const cardId = 'ask-user-' + Date.now()
    const optionsHtml = (options || []).map((opt, i) => {
      const inputType = type === 'multiple' ? 'checkbox' : 'radio'
      return `<label class="ast-ask-option">
        <input type="${inputType}" name="${cardId}" value="${escHtml(opt)}">
        <span>${escHtml(opt)}</span>
      </label>`
    }).join('')

    const textHtml = type === 'text' || !options?.length
      ? `<textarea class="ast-ask-text" placeholder="${escHtml(placeholder || '请输入...')}" rows="2"></textarea>`
      : ''

    const customHtml = type !== 'text' && options?.length
      ? `<div class="ast-ask-custom"><input type="text" class="ast-ask-custom-input" placeholder="或输入自定义内容..."></div>`
      : ''

    const card = document.createElement('div')
    card.className = 'ast-ask-card'
    card.id = cardId
    card.innerHTML = `
      <div class="ast-ask-question">${escHtml(question)}</div>
      ${optionsHtml ? `<div class="ast-ask-options">${optionsHtml}</div>` : ''}
      ${customHtml}
      ${textHtml}
      <div class="ast-ask-actions">
        <button class="ast-ask-submit btn btn-primary btn-sm">确认</button>
        <button class="ast-ask-skip btn btn-secondary btn-sm">跳过</button>
      </div>
    `

    // 插入到消息区域
    _messagesEl.appendChild(card)
    _messagesEl.scrollTop = _messagesEl.scrollHeight

    // 提交处理
    card.querySelector('.ast-ask-submit').addEventListener('click', () => {
      let answer = ''

      if (type === 'text' || (!options?.length)) {
        answer = card.querySelector('.ast-ask-text')?.value?.trim() || ''
      } else if (type === 'multiple') {
        const checked = [...card.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value)
        const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
        if (custom) checked.push(custom)
        answer = checked.join('、') || '未选择'
      } else {
        // single
        const checked = card.querySelector('input[type="radio"]:checked')
        const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
        answer = custom || checked?.value || '未选择'
      }

      // 替换卡片为已回答状态
      card.innerHTML = `<div class="ast-ask-answered">
        <div class="ast-ask-question">${escHtml(question)}</div>
        <div class="ast-ask-answer">${icon('check', 14)} ${escHtml(answer)}</div>
      </div>`
      card.classList.add('answered')

      if (session) setSessionStatus(session.id, 'streaming')
      resolve(`用户回答: ${answer}`)
    })

    // 跳过处理
    card.querySelector('.ast-ask-skip').addEventListener('click', () => {
      card.innerHTML = `<div class="ast-ask-answered">
        <div class="ast-ask-question">${escHtml(question)}</div>
        <div class="ast-ask-answer" style="color:var(--text-tertiary)">— 已跳过</div>
      </div>`
      card.classList.add('answered')
      if (session) setSessionStatus(session.id, 'streaming')
      resolve('用户跳过了此问题')
    })
  })
}

// 危险工具确认弹窗
async function confirmToolCall(tc, critical = false) {
  const name = tc.function.name
  let args
  try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

  let desc = ''
  if (name === 'run_command') {
    desc = `执行命令:\n\n${args.command}${args.cwd ? '\n\n工作目录: ' + args.cwd : ''}`
  } else if (name === 'write_file') {
    const preview = (args.content || '').slice(0, 200)
    desc = `写入文件:\n${args.path}\n\n内容预览:\n${preview}${(args.content || '').length > 200 ? '\n...(已截断)' : ''}`
  }

  const prefix = critical
    ? '⛔ 安全围栏拦截 — 此命令被识别为极端危险操作！\n\n'
    : ''

  const session = getCurrentSession()
  if (session) setSessionStatus(session.id, 'waiting')
  const result = await showConfirm(`${prefix}AI 请求执行以下操作:\n\n${desc}\n\n是否允许？`)
  if (session) setSessionStatus(session.id, 'streaming')
  return result
}

// 将 OpenAI 格式工具定义转为 Anthropic 格式
function convertToolsForAnthropic(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }))
}

// 将 OpenAI 格式工具定义转为 Gemini 格式
function convertToolsForGemini(tools) {
  return [{ functionDeclarations: tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || { type: 'object', properties: {} },
  }))}]
}

// 工具调用执行（共用逻辑）
async function executeToolWithSafety(toolName, args, tcForConfirm) {
  let result = '', approved = true
  const mode = MODES[currentMode()]
  const isCritical = toolName === 'run_command' && isCriticalCommand(args.command)
  if (isCritical) {
    approved = await confirmToolCall(tcForConfirm || { function: { name: toolName, arguments: JSON.stringify(args) } }, true)
    if (!approved) result = '用户拒绝了此危险操作'
  } else if (mode.confirmDanger && DANGEROUS_TOOLS.has(toolName)) {
    approved = await confirmToolCall(tcForConfirm || { function: { name: toolName, arguments: JSON.stringify(args) } })
    if (!approved) result = '用户拒绝了此操作'
  }
  if (approved) {
    try { result = await executeTool(toolName, args) }
    catch (err) { result = `执行失败: ${typeof err === 'string' ? err : err.message || JSON.stringify(err)}` }
  }
  return { result, approved }
}

// 带工具调用的 AI 请求（非流式，用于 tool_calls 检测循环）
async function callAIWithTools(messages, onStatus, onToolProgress) {
  if (!_config.baseUrl || !_config.apiKey || !_config.model) {
    throw new Error('请先配置 AI 模型（点击右上角设置按钮）')
  }

  const apiType = _config.apiType || 'openai'
  const base = cleanBaseUrl(_config.baseUrl)
  const tools = getEnabledTools()
  let currentMessages = [{ role: 'system', content: buildSystemPrompt() }, ...messages]
  const toolHistory = []

  const MAX_AUTO_ROUNDS = 8
  for (let round = 0; ; round++) {
    // 检查是否已被用户中止
    if (!_isStreaming || _abortController?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (round >= MAX_AUTO_ROUNDS) {
      const answer = await showAskUserCard({
        question: `AI 已连续调用工具 ${round} 轮，可能陷入循环。你希望怎么做？`,
        type: 'single',
        options: ['继续执行', '让 AI 换个思路', '停止并总结'],
      })
      if (answer.includes('停止')) {
        return { content: '用户要求停止工具调用，以下是目前的执行情况摘要。', toolHistory }
      } else if (answer.includes('换个思路')) {
        currentMessages.push({ role: 'user', content: '请换一种方法来解决这个问题，不要重复之前失败的操作。' })
      }
    }

    _abortController = new AbortController()
    onStatus(round === 0 ? 'AI 思考中...' : `AI 处理工具结果 (第${round + 1}轮)...`)

    // ── Anthropic 工具调用 ──
    if (apiType === 'anthropic') {
      const systemMsg = currentMessages.find(m => m.role === 'system')?.content || ''
      const chatMsgs = currentMessages.filter(m => m.role !== 'system')
      const body = {
        model: _config.model,
        max_tokens: 8192,
        temperature: _config.temperature || 0.7,
        messages: chatMsgs,
      }
      if (systemMsg) body.system = systemMsg
      if (tools.length > 0) body.tools = convertToolsForAnthropic(tools)

      const resp = await fetchWithRetry(base + '/messages', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
        signal: _abortController.signal,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        let errMsg = `API 错误 ${resp.status}`
        try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
        throw new Error(errMsg)
      }

      const data = await resp.json()
      const contentBlocks = data.content || []
      const toolUses = contentBlocks.filter(b => b.type === 'tool_use')
      const textContent = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('')

      if (toolUses.length > 0) {
        // 将 assistant 消息加入上下文
        currentMessages.push({ role: 'assistant', content: contentBlocks })

        const toolResults = []
        for (const tu of toolUses) {
          const args = tu.input || {}
          toolHistory.push({ name: tu.name, args, result: null, approved: true, pending: true })
          onToolProgress(toolHistory)

          const { result, approved } = await executeToolWithSafety(tu.name, args)
          const last = toolHistory[toolHistory.length - 1]
          last.result = result; last.approved = approved; last.pending = false
          onToolProgress(toolHistory)

          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          })
        }
        currentMessages.push({ role: 'user', content: toolResults })
        continue
      }

      return { content: textContent, toolHistory }
    }

    // ── Gemini 工具调用 ──
    if (apiType === 'google-gemini') {
      const systemMsg = currentMessages.find(m => m.role === 'system')?.content || ''
      const chatMsgs = currentMessages.filter(m => m.role !== 'system')
      const contents = chatMsgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'function' : 'user',
        parts: m.functionResponse
          ? [{ functionResponse: m.functionResponse }]
          : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }))
      const body = { contents, generationConfig: { temperature: _config.temperature || 0.7 } }
      if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] }
      if (tools.length > 0) body.tools = convertToolsForGemini(tools)

      const url = `${base}/models/${_config.model}:generateContent?key=${_config.apiKey}`
      const resp = await fetchWithRetry(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: _abortController.signal,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        let errMsg = `API 错误 ${resp.status}`
        try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
        throw new Error(errMsg)
      }

      const data = await resp.json()
      const parts = data.candidates?.[0]?.content?.parts || []
      const funcCalls = parts.filter(p => p.functionCall)
      const textParts = parts.filter(p => p.text).map(p => p.text).join('')

      if (funcCalls.length > 0) {
        currentMessages.push({ role: 'assistant', content: textParts, _geminiParts: parts })

        for (const fc of funcCalls) {
          const args = fc.functionCall.args || {}
          toolHistory.push({ name: fc.functionCall.name, args, result: null, approved: true, pending: true })
          onToolProgress(toolHistory)

          const { result, approved } = await executeToolWithSafety(fc.functionCall.name, args)
          const last = toolHistory[toolHistory.length - 1]
          last.result = result; last.approved = approved; last.pending = false
          onToolProgress(toolHistory)

          currentMessages.push({
            role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result),
            functionResponse: { name: fc.functionCall.name, response: { result: typeof result === 'string' ? result : JSON.stringify(result) } },
          })
        }
        continue
      }

      return { content: textParts, toolHistory }
    }

    // ── OpenAI 工具调用 ──
    const body = {
      model: _config.model,
      messages: currentMessages,
      temperature: _config.temperature || 0.7,
    }
    if (tools.length > 0) body.tools = tools

    const resp = await fetchWithRetry(base + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: _abortController.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      let errMsg = `API 错误 ${resp.status}`
      try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
      throw new Error(errMsg)
    }

    const data = await resp.json()
    const choice = data.choices?.[0]
    const assistantMsg = choice?.message

    if (!assistantMsg) throw new Error('AI 未返回有效响应')

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      currentMessages.push(assistantMsg)

      for (const tc of assistantMsg.tool_calls) {
        let args
        try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
        const toolName = tc.function.name

        toolHistory.push({ name: toolName, args, result: null, approved: true, pending: true })
        onToolProgress(toolHistory)

        const { result, approved } = await executeToolWithSafety(toolName, args, tc)
        const last = toolHistory[toolHistory.length - 1]
        last.result = result; last.approved = approved; last.pending = false
        onToolProgress(toolHistory)

        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        })
      }

      continue
    }

    const content = assistantMsg.content || assistantMsg.reasoning_content || ''
    return { content, toolHistory }
  }
}

// ── 渲染 ──

function renderSessionList() {
  if (!_sessionListEl) return
  const sorted = [..._sessions].reverse()
  _sessionListEl.innerHTML = sorted.map(s => {
    const status = getSessionStatus(s.id)
    const dotClass = status === 'streaming' ? 'ast-status-dot streaming'
      : status === 'waiting' ? 'ast-status-dot waiting'
      : status === 'error' ? 'ast-status-dot error'
      : ''
    const dot = dotClass ? `<span class="${dotClass}"></span>` : ''
    return `<div class="ast-session-item ${s.id === _currentSessionId ? 'active' : ''}" data-id="${s.id}">
      ${dot}<span class="ast-session-title">${escHtml(s.title)}</span>
      <button class="ast-session-delete" data-delete="${s.id}" title="删除会话">×</button>
    </div>`
  }).join('') || '<div class="ast-empty">暂无会话</div>'
}

function renderToolBlocks(toolHistory) {
  if (!toolHistory || toolHistory.length === 0) return ''
  return toolHistory.map(tc => {
    // ask_user 工具不显示在工具块中（它有自己的交互卡片）
    if (tc.name === 'ask_user') return ''

    const tcIcon = { run_command: icon('terminal', 14), write_file: icon('edit', 14), read_file: icon('file', 14), list_directory: icon('folder', 14), get_system_info: icon('monitor', 14), list_processes: icon('list', 14), check_port: icon('plug', 14) }[tc.name] || icon('wrench', 14)
    const label = { run_command: '执行命令', read_file: '读取文件', write_file: '写入文件', list_directory: '列出目录', get_system_info: '系统信息', list_processes: '进程列表', check_port: '端口检测' }[tc.name] || tc.name
    const argsStr = tc.name === 'run_command' ? escHtml(tc.args.command || '')
      : tc.name === 'read_file' ? escHtml(tc.args.path || '')
      : tc.name === 'write_file' ? escHtml(tc.args.path || '')
      : tc.name === 'list_directory' ? escHtml(tc.args.path || '')
      : tc.name === 'get_system_info' ? ''
      : tc.name === 'list_processes' ? escHtml(tc.args.filter || '全部')
      : tc.name === 'check_port' ? escHtml(String(tc.args.port || ''))
      : escHtml(JSON.stringify(tc.args))

    if (tc.pending) {
      return `<div class="ast-tool-block pending">
        <div class="ast-tool-summary">${icon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status"><span class="ast-typing">执行中...</span></span></div>
      </div>`
    }

    const statusClass = tc.approved === false ? 'denied' : 'ok'
    const statusLabel = tc.approved === false ? '已拒绝' : '已执行'
    const resultPreview = (tc.result || '').length > 500 ? tc.result.slice(0, 500) + '...' : (tc.result || '')
    return `<details class="ast-tool-block ${statusClass}">
      <summary class="ast-tool-summary">${icon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status">${statusLabel}</span></summary>
      <pre class="ast-tool-result">${escHtml(resultPreview)}</pre>
    </details>`
  }).join('')
}

// ── 错误上下文 Banner ──

function checkErrorContext() {
  const raw = sessionStorage.getItem('assistant-error-context')
  if (!raw) return
  try {
    _errorContext = JSON.parse(raw)
    // 不立即移除 sessionStorage，等用户操作后再移除
  } catch { _errorContext = null }
}

function clearErrorContext() {
  _errorContext = null
  sessionStorage.removeItem('assistant-error-context')
  _messagesEl?.querySelector('.ast-error-banner')?.remove()
}

function renderErrorBanner() {
  if (!_errorContext || !_messagesEl) return
  // 避免重复
  if (_messagesEl.querySelector('.ast-error-banner')) return

  const ctx = _errorContext
  const banner = document.createElement('div')
  banner.className = 'ast-error-banner'
  banner.innerHTML = `
    <div class="ast-error-banner-header">
      <span class="ast-error-banner-icon">${statusIcon('warn', 18)}</span>
      <span class="ast-error-banner-title">${escHtml(ctx.title)}</span>
      <div class="ast-error-banner-actions">
        <button class="btn-analyze">让 AI 分析</button>
        <button class="btn-dismiss">忽略</button>
      </div>
    </div>
    ${ctx.hint ? `<div class="ast-error-banner-hint">${escHtml(ctx.hint)}</div>` : ''}
    ${ctx.error ? `
      <button class="ast-error-toggle">查看详细日志 ▼</button>
      <div class="ast-error-banner-detail">
        <pre>${escHtml(ctx.error)}</pre>
      </div>
    ` : ''}
  `

  // 展开/折叠详细日志
  const toggleBtn = banner.querySelector('.ast-error-toggle')
  const detailEl = banner.querySelector('.ast-error-banner-detail')
  if (toggleBtn && detailEl) {
    toggleBtn.addEventListener('click', () => {
      const expanded = detailEl.classList.toggle('expanded')
      toggleBtn.textContent = expanded ? '收起日志 ▲' : '查看详细日志 ▼'
    })
  }

  // "让 AI 分析" → 组装 prompt 并发送
  banner.querySelector('.btn-analyze').addEventListener('click', () => {
    const prompt = [
      ctx.scene ? `**场景**: ${ctx.scene}` : '',
      ctx.title ? `**错误**: ${ctx.title}` : '',
      ctx.hint ? `**提示**: ${ctx.hint}` : '',
      ctx.error ? `\n\`\`\`\n${ctx.error}\n\`\`\`` : '',
      '\n请分析以上错误信息，给出原因和修复方案。',
    ].filter(Boolean).join('\n')

    // 自动切换到执行模式
    if (currentMode() === 'chat') {
      _config.mode = 'execute'
      saveConfig()
      _page?.querySelectorAll('.ast-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'execute'))
    }

    clearErrorContext()
    sendMessage(prompt)
  })

  // "忽略" → 移除 banner 和上下文
  banner.querySelector('.btn-dismiss').addEventListener('click', () => {
    clearErrorContext()
  })

  // 插入到消息区域顶部
  _messagesEl.insertBefore(banner, _messagesEl.firstChild)
}

function renderMessages() {
  const session = getCurrentSession()
  if (!_messagesEl) return
  if (!session || session.messages.length === 0) {
    const skillCards = BUILTIN_SKILLS.map(s => `
      <button class="ast-skill-card" data-skill="${s.id}">
        <span class="ast-skill-icon">${s.icon}</span>
        <div class="ast-skill-info">
          <strong>${s.name}</strong>
          <span>${s.desc}</span>
        </div>
      </button>
    `).join('')

    _messagesEl.innerHTML = `
      <div class="ast-welcome">
        <div class="ast-welcome-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
            <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>
          </svg>
        </div>
        <h3>${_config?.assistantName || DEFAULT_NAME}</h3>
        <p>我可以帮你分析日志、排查问题、配置 OpenClaw。<br>点击下方技能卡片，AI 会自动调用工具完成任务。</p>
        ${getAssistantGuideHtml()}
        <div class="ast-skills-grid">${skillCards}</div>
      </div>
    `
    // 在欢迎页也显示错误 banner
    if (_errorContext) renderErrorBanner()
    return
  }

  _messagesEl.innerHTML = session.messages.map((m, idx) => {
    if (m.role === 'user') {
      const textPart = m._text || (typeof m.content === 'string' ? m.content : (m.content?.find?.(p => p.type === 'text')?.text || ''))
      const imagesHtml = m._images?.length ? `<div class="ast-msg-images">${m._images.map(img =>
        img.dataUrl
          ? `<img class="ast-msg-img" src="${img.dataUrl}" alt="${escHtml(img.name)}" style="max-width:${Math.min(img.width || 300, 300)}px" loading="lazy"/>`
          : `<div class="ast-msg-img-loading" data-db-id="${img.dbId || ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>${escHtml(img.name || '图片')}</span></div>`
      ).join('')}</div>` : ''
      return `<div class="ast-msg ast-msg-user" data-msg-idx="${idx}"><div class="ast-msg-bubble ast-msg-bubble-user">${imagesHtml}${textPart ? escHtml(textPart) : ''}</div></div>`
    } else if (m.role === 'assistant') {
      const toolHtml = renderToolBlocks(m.toolHistory)
      return `<div class="ast-msg ast-msg-ai" data-msg-idx="${idx}">${toolHtml}<div class="ast-msg-bubble ast-msg-bubble-ai">${renderMarkdown(m.content)}</div></div>`
    }
    return ''
  }).join('')

  // 从文件系统恢复图片
  _messagesEl.querySelectorAll('.ast-msg-img-loading[data-db-id]').forEach(async (el) => {
    const dbId = el.dataset.dbId
    if (!dbId) return
    const dataUrl = await loadImageFromFile(dbId)
    if (dataUrl) {
      const img = document.createElement('img')
      img.className = 'ast-msg-img'
      img.src = dataUrl
      img.alt = el.querySelector('span')?.textContent || '图片'
      img.loading = 'lazy'
      img.style.maxWidth = '300px'
      el.replaceWith(img)
      // 同步回内存中的 session 数据（当前会话期间不用再查文件）
      for (const s of _sessions) {
        for (const m of s.messages) {
          if (m._images) {
            const match = m._images.find(i => i.dbId === dbId)
            if (match) match.dataUrl = dataUrl
          }
        }
      }
    } else {
      el.classList.remove('ast-msg-img-loading')
      el.classList.add('ast-msg-img-placeholder')
    }
  })

  // 滚动到底部
  requestAnimationFrame(() => {
    _messagesEl.scrollTop = _messagesEl.scrollHeight
  })
}

function buildTestResult({ success, elapsed, usedApi, reqUrl, reqBody, respStatus, respBody, reply, error }) {
  let html = ''
  // 状态行
  if (error) {
    html += `<span style="color:var(--error)">✗ 请求失败: ${escHtml(error)}</span>`
  } else if (success) {
    html += `<span style="color:var(--success)">✓ 模型回复成功 (${elapsed}ms, ${usedApi} API)</span>`
  } else {
    html += `<span style="color:var(--warning)">${statusIcon('warn', 14)} HTTP ${respStatus} — 请求完成但未解析到回复内容</span>`
  }
  // 回复预览
  if (reply) {
    const short = reply.length > 80 ? reply.slice(0, 80) + '...' : reply
    html += `<div style="margin-top:4px;padding:6px 8px;background:var(--bg-tertiary);border-radius:4px;font-size:12px;color:var(--text-secondary)">「${escHtml(short)}」</div>`
  }
  // 折叠的详细信息
  html += `<details style="margin-top:6px;font-size:11px"><summary style="cursor:pointer;color:var(--text-tertiary);user-select:none">查看完整请求/响应参数</summary>`
  html += `<div style="margin-top:4px;max-height:200px;overflow:auto;background:var(--bg-tertiary);border-radius:4px;padding:8px;font-family:var(--font-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">`
  html += `<strong>POST</strong> ${escHtml(reqUrl)}\n\n`
  html += `<strong>Request Body:</strong>\n${escHtml(JSON.stringify(reqBody, null, 2))}\n\n`
  html += `<strong>Response Status:</strong> ${respStatus}\n\n`
  html += `<strong>Response Body:</strong>\n`
  // 美化 JSON
  try {
    html += escHtml(JSON.stringify(JSON.parse(respBody), null, 2))
  } catch {
    html += escHtml(respBody?.slice(0, 2000) || '(empty)')
  }
  html += `</div></details>`
  return html
}

function showSettings() {
  const c = _config
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-title" style="margin-bottom:0">${c.assistantName || DEFAULT_NAME} — 设置</div>
      <div class="ast-settings-tabs">
        <button class="ast-tab active" data-tab="api">模型配置</button>
        <button class="ast-tab" data-tab="tools">工具权限</button>
        <button class="ast-tab" data-tab="persona">助手人设</button>
        <button class="ast-tab" data-tab="knowledge">知识库</button>
      </div>
      <div class="modal-body">
      <div class="ast-settings-form">
        <div class="ast-tab-panel active" data-panel="api">
          <div style="display:flex;gap:10px">
            <div class="form-group" style="flex:1">
              <label class="form-label">API Base URL</label>
              <input class="form-input" id="ast-baseurl" value="${escHtml(c.baseUrl)}" placeholder="https://api.openai.com/v1">
            </div>
            <div class="form-group" style="width:170px">
              <label class="form-label">API 类型</label>
              <select class="form-input" id="ast-apitype">
                ${API_TYPES.map(t => `<option value="${t.value}" ${c.apiType === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1;margin-bottom:0">
              <label class="form-label">API Key</label>
              <input class="form-input" id="ast-apikey" type="password" value="${escHtml(c.apiKey)}" placeholder="sk-...">
            </div>
            <div style="display:flex;gap:6px;padding-bottom:1px">
              <button class="btn btn-sm btn-secondary" id="ast-btn-test" title="测试连通性">测试</button>
              <button class="btn btn-sm btn-secondary" id="ast-btn-models" title="从 API 获取可用模型">拉取</button>
              <button class="btn btn-sm btn-secondary" id="ast-btn-import" title="从 OpenClaw 导入模型配置">${icon('download', 14)} 导入</button>
            </div>
          </div>
          <div id="ast-test-result" style="margin:6px 0 2px;font-size:12px;min-height:16px"></div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1">
              <label class="form-label">模型</label>
              <div style="position:relative">
                <input class="form-input" id="ast-model" value="${escHtml(c.model)}" placeholder="gpt-4o / deepseek-chat" autocomplete="off">
                <div id="ast-model-dropdown" class="ast-model-dropdown" style="display:none"></div>
              </div>
            </div>
            <div class="form-group" style="width:80px">
              <label class="form-label">温度</label>
              <input class="form-input" id="ast-temp" type="number" value="${c.temperature || 0.7}" min="0" max="2" step="0.1">
            </div>
          </div>
          <div class="form-hint" id="ast-api-hint" style="margin-top:-4px">${{
            openai: '自动兼容 Chat Completions 和 Responses API',
            anthropic: '使用 Anthropic Messages API（/v1/messages）',
            'google-gemini': '使用 Gemini generateContent API',
          }[c.apiType || 'openai']}</div>

          <div id="ast-qtcool-promo" style="margin-top:14px;border-radius:12px;background:linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%);color:#fff;position:relative;overflow:hidden;box-shadow:0 4px 20px rgba(48,43,99,0.3)">
            <div style="position:absolute;top:-40px;right:-40px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,0.15) 0%,transparent 70%);pointer-events:none"></div>
            <div style="position:absolute;bottom:-20px;left:-20px;width:100px;height:100px;border-radius:50%;background:radial-gradient(circle,rgba(168,85,247,0.1) 0%,transparent 70%);pointer-events:none"></div>
            <div style="padding:16px 18px 12px">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <span style="font-size:16px">${icon('gift', 18)}</span>
                <span style="font-weight:700;font-size:14px;letter-spacing:0.3px">ClawPanel 公益 AI 接口计划</span>
              </div>
              <div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.6;margin-bottom:12px">
                Token 费用？我们帮你出了。调用成本由项目组内部承担，GPT-5 全系列模型开箱即用，无需注册、无需付费。选模型，一键接入。
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <select id="ast-qtcool-model" style="padding:5px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#fff;font-size:12px;outline:none;cursor:pointer;backdrop-filter:blur(4px);min-width:140px">
                  <option value="" disabled selected style="color:#333">加载模型列表...</option>
                </select>
                <button class="btn btn-sm" id="ast-qtcool-test" style="background:rgba(255,255,255,0.12);color:#fff;font-weight:500;border:1px solid rgba(255,255,255,0.2);font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer">${icon('search', 12)} 测试</button>
                <button class="btn btn-sm" id="ast-qtcool-apply" style="background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font-weight:600;border:none;font-size:12px;padding:6px 16px;border-radius:8px;box-shadow:0 2px 8px rgba(99,102,241,0.4);transition:transform 0.15s;cursor:pointer">${icon('zap', 12)} 一键接入</button>
              </div>
              <div id="ast-qtcool-status" style="margin-top:8px;font-size:11px;min-height:16px;line-height:1.5"></div>
            </div>
            <div style="border-top:1px solid rgba(255,255,255,0.08);padding:10px 18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;background:rgba(0,0,0,0.15)">
              <label style="cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:rgba(255,255,255,0.5)">
                <input type="checkbox" id="ast-qtcool-customkey" style="accent-color:#a855f7;width:13px;height:13px"> 使用自定义密钥
              </label>
              <div style="display:flex;gap:12px;font-size:11px">
                <a href="https://gpt.qt.cool/checkin" target="_blank" style="color:rgba(168,133,247,0.9);text-decoration:none">${icon('target', 12)} 签到领密钥</a>
                <a id="ast-qtcool-usage" href="${QTCOOL.usageUrl}${QTCOOL.defaultKey}" target="_blank" style="color:rgba(168,133,247,0.9);text-decoration:none">${icon('bar-chart', 12)} 用量查询</a>
                <a href="https://claw.qt.cool/" target="_blank" style="color:rgba(168,133,247,0.9);text-decoration:none">${icon('home', 12)} 官网</a>
              </div>
            </div>
            <div id="ast-qtcool-keyrow" style="display:none;border-top:1px solid rgba(255,255,255,0.08);padding:10px 18px;background:rgba(0,0,0,0.1)">
              <input class="form-input" id="ast-qtcool-key" placeholder="粘贴你的独立密钥（签到可得）" style="font-size:12px;padding:6px 10px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:8px">
            </div>
          </div>
        </div>
        <div class="ast-tab-panel" data-panel="tools">
          <div class="form-hint" style="margin-bottom:10px">工具开关优先级高于模式设置。关闭的工具在任何模式下都不可用。</div>
          <label class="ast-switch-row">
            <span>终端工具 <span style="color:var(--text-tertiary);font-size:11px">— 允许执行 Shell 命令</span></span>
            <input type="checkbox" id="ast-tool-terminal" ${c.tools?.terminal !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>文件工具 <span style="color:var(--text-tertiary);font-size:11px">— 允许读写文件和浏览目录</span></span>
            <input type="checkbox" id="ast-tool-fileops" ${c.tools?.fileOps !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>联网搜索 <span style="color:var(--text-tertiary);font-size:11px">— 允许搜索互联网和抓取网页</span></span>
            <input type="checkbox" id="ast-tool-websearch" ${c.tools?.webSearch !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <div class="form-hint" style="margin-top:10px">进程列表、端口检测、系统信息工具始终可用（非聊天模式下）。</div>
        </div>
        <div class="ast-tab-panel" data-panel="persona">
          <div class="form-group">
            <label class="form-label">身份来源</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="default" ${!c.soulSource || c.soulSource === 'default' ? 'checked' : ''}>
                <span>ClawPanel 默认人设</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="openclaw" ${c.soulSource?.startsWith('openclaw:') ? 'checked' : ''}>
                <span>OpenClaw Agent 身份 <span style="font-size:11px;color:var(--text-tertiary)">（借尸还魂）</span></span>
              </label>
            </div>
          </div>
          <div id="ast-soul-default" style="${c.soulSource?.startsWith('openclaw:') ? 'display:none' : ''}">
            <div class="form-group">
              <label class="form-label">助手名称</label>
              <input class="form-input" id="ast-name" value="${escHtml(c.assistantName || DEFAULT_NAME)}" placeholder="${DEFAULT_NAME}">
            </div>
            <div class="form-group">
              <label class="form-label">助手性格</label>
              <textarea class="form-input" id="ast-personality" rows="3" placeholder="${DEFAULT_PERSONALITY}" style="resize:vertical">${escHtml(c.assistantPersonality || DEFAULT_PERSONALITY)}</textarea>
              <div class="form-hint">描述助手的说话风格和行为方式，会注入到系统提示词中</div>
            </div>
          </div>
          <div id="ast-soul-openclaw" style="${c.soulSource?.startsWith('openclaw:') ? '' : 'display:none'}">
            <div class="form-group" style="margin-top:4px">
              <label class="form-label">选择 Agent</label>
              <div style="display:flex;gap:6px;align-items:center">
                <select class="form-input" id="ast-soul-agent" style="flex:1;font-family:var(--font-mono);font-size:13px">
                  <option value="" disabled>扫描中...</option>
                </select>
                <button class="btn btn-sm btn-primary" id="ast-btn-load-soul" style="gap:4px;white-space:nowrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
                  加载灵魂
                </button>
                <button class="btn btn-sm btn-ghost" id="ast-btn-refresh-soul" style="gap:4px;white-space:nowrap" title="重新扫描 Agent 列表">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
              </div>
            </div>
            <div id="ast-soul-status" class="ast-soul-card" style="margin-top:8px">
              <div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">
                选择 Agent 后点击「加载灵魂」读取身份文件
              </div>
            </div>
            <div class="form-hint" style="margin-top:8px">附身后助手将继承 Agent 的人格、记忆和用户偏好，同时保留 ClawPanel 的工具能力。</div>
          </div>
        </div>
        <div class="ast-tab-panel" data-panel="knowledge">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div class="form-hint" style="margin:0">为助手添加自定义知识，对话时会自动注入到系统提示词中。</div>
            <button class="btn btn-sm btn-primary" id="ast-kb-add" style="gap:4px;white-space:nowrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              添加
            </button>
          </div>
          <div id="ast-kb-editor" style="display:none;margin-bottom:10px">
            <div class="form-group" style="margin-bottom:6px">
              <input class="form-input" id="ast-kb-name" placeholder="知识名称，如：产品文档、API参考" style="font-size:13px">
            </div>
            <div class="form-group" style="margin-bottom:6px">
              <textarea class="form-input" id="ast-kb-content" rows="6" placeholder="粘贴知识内容（支持 Markdown 格式）..." style="resize:vertical;font-size:12px;font-family:var(--font-mono)"></textarea>
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-sm btn-secondary" id="ast-kb-cancel">取消</button>
              <button class="btn btn-sm btn-primary" id="ast-kb-save">保存知识</button>
            </div>
          </div>
          <div class="ast-soul-card" id="ast-kb-list"></div>
          <div class="form-hint" style="margin-top:8px" id="ast-kb-hint"></div>
        </div>
      </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">保存</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  // Tab 切换
  overlay.querySelectorAll('.ast-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.ast-tab').forEach(t => t.classList.remove('active'))
      overlay.querySelectorAll('.ast-tab-panel').forEach(p => p.classList.remove('active'))
      tab.classList.add('active')
      overlay.querySelector(`.ast-tab-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active')
    })
  })

  // API 类型切换时更新提示文本和 placeholder
  const apiTypeSelect = overlay.querySelector('#ast-apitype')
  const apiHintEl = overlay.querySelector('#ast-api-hint')
  const baseUrlInput = overlay.querySelector('#ast-baseurl')
  const apiKeyInput = overlay.querySelector('#ast-apikey')
  apiTypeSelect.addEventListener('change', () => {
    const v = apiTypeSelect.value
    const hints = { openai: '自动兼容 Chat Completions 和 Responses API', anthropic: '使用 Anthropic Messages API（/v1/messages）', 'google-gemini': '使用 Gemini generateContent API' }
    const placeholders = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', 'google-gemini': 'https://generativelanguage.googleapis.com/v1beta' }
    const keyPlaceholders = { openai: 'sk-...', anthropic: 'sk-ant-...', 'google-gemini': 'AIza...' }
    apiHintEl.textContent = hints[v] || hints.openai
    baseUrlInput.placeholder = placeholders[v] || placeholders.openai
    apiKeyInput.placeholder = keyPlaceholders[v] || keyPlaceholders.openai
  })

  // 灵魂来源切换
  const agentSelect = overlay.querySelector('#ast-soul-agent')
  overlay.querySelectorAll('input[name="ast-soul-source"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isOpenclaw = radio.value === 'openclaw' && radio.checked
      overlay.querySelector('#ast-soul-default').style.display = isOpenclaw ? 'none' : ''
      overlay.querySelector('#ast-soul-openclaw').style.display = isOpenclaw ? '' : 'none'
      if (isOpenclaw) refreshAgentList()
    })
  })

  // 扫描并填充 Agent 下拉列表
  const refreshAgentList = async () => {
    agentSelect.innerHTML = '<option value="" disabled selected>扫描中...</option>'
    agentSelect.disabled = true
    const agents = await scanOpenClawAgents()
    agentSelect.innerHTML = ''
    if (agents.length === 0) {
      agentSelect.innerHTML = '<option value="" disabled selected>未发现 Agent</option>'
      agentSelect.disabled = true
      return
    }
    let currentId = _config.soulSource?.replace('openclaw:', '') || 'default'
    if (currentId === 'main') currentId = 'default'
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = a.label + (a.hasWorkspace ? '' : ' (无 workspace)')
      if (!a.hasWorkspace) opt.disabled = true
      if (a.id === currentId) opt.selected = true
      agentSelect.appendChild(opt)
    }
    agentSelect.disabled = false
  }

  // 加载灵魂函数
  const doLoadSoul = async (btn) => {
    const selectedAgent = agentSelect.value
    if (!selectedAgent) { toast('请先选择一个 Agent', 'warning'); return }
    const statusEl = overlay.querySelector('#ast-soul-status')
    const origHTML = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ast-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg> 加载中...'
    statusEl.innerHTML = `<div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">正在读取 Agent「${selectedAgent}」的 workspace...</div>`

    const soul = await loadOpenClawSoul(selectedAgent)
    btn.disabled = false
    btn.innerHTML = origHTML

    if (!soul) {
      statusEl.innerHTML = `<div style="text-align:center;padding:16px 0"><div style="color:var(--error);font-size:12px;font-weight:500">加载失败</div><div style="color:var(--text-tertiary);font-size:11px;margin-top:4px">Agent「${selectedAgent}」的 workspace 不存在或无法访问</div></div>`
      return
    }

    statusEl.innerHTML = renderSoulStats(soul)
  }

  overlay.querySelector('#ast-btn-load-soul').onclick = (e) => doLoadSoul(e.target.closest('button'))
  // 刷新按钮：重新扫描 Agent 列表
  overlay.querySelector('#ast-btn-refresh-soul').onclick = (e) => {
    refreshAgentList()
    overlay.querySelector('#ast-soul-status').innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">选择 Agent 后点击「加载灵魂」读取身份文件</div>'
  }

  // 打开面板时：如果已选 openclaw 模式，自动扫描 Agent 列表
  if (_config?.soulSource?.startsWith('openclaw:')) {
    refreshAgentList().then(() => {
      // 如果已有缓存，显示统计
      if (_soulCache) {
        overlay.querySelector('#ast-soul-status').innerHTML = renderSoulStats(_soulCache)
      }
    })
  }

  // ── 知识库管理 ──
  const kbListEl = overlay.querySelector('#ast-kb-list')
  const kbEditorEl = overlay.querySelector('#ast-kb-editor')
  const kbHintEl = overlay.querySelector('#ast-kb-hint')
  // 临时副本，保存时写回 _config
  let kbFiles = JSON.parse(JSON.stringify(_config.knowledgeFiles || []))

  const renderKBList = () => {
    if (kbFiles.length === 0) {
      kbListEl.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--text-tertiary);font-size:12px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:6px;opacity:0.4"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <div>点击「添加」按钮添加知识文件</div></div>`
      kbHintEl.textContent = ''
      return
    }
    const totalSize = kbFiles.reduce((s, f) => s + (f.content?.length || 0), 0)
    const sizeStr = totalSize > 1024 ? (totalSize / 1024).toFixed(1) + ' KB' : totalSize + ' B'
    const enabledCount = kbFiles.filter(f => f.enabled !== false).length
    kbHintEl.textContent = `共 ${kbFiles.length} 个知识文件（${enabledCount} 个启用，${sizeStr}），保存后生效。`
    let html = '<div class="ast-soul-files">'
    kbFiles.forEach((f, i) => {
      const fSize = f.content?.length > 1024 ? (f.content.length / 1024).toFixed(1) + ' KB' : (f.content?.length || 0) + ' B'
      const enabled = f.enabled !== false
      html += `<div class="ast-soul-file ${enabled ? 'loaded' : 'missing'}" data-kb-idx="${i}" style="cursor:pointer" title="点击编辑">
        <button style="padding:2px;background:none;border:none;cursor:pointer;flex-shrink:0" data-kb-toggle="${i}" title="${enabled ? '点击禁用' : '点击启用'}">
          <div class="ast-soul-file-icon">${enabled ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>'}</div>
        </button>
        <div class="ast-soul-file-info">
          <span class="ast-soul-file-name">${escHtml(f.name)}</span>
          <span class="ast-soul-file-desc">${f.content?.split('\n').length || 0} 行 · 点击编辑</span>
        </div>
        <span class="ast-soul-file-size">${fSize}</span>
        <button class="btn btn-sm" style="padding:2px 6px;font-size:11px;color:var(--error);background:none;border:none;cursor:pointer" data-kb-del="${i}" title="删除">✕</button>
      </div>`
    })
    html += '</div>'
    kbListEl.innerHTML = html
  }
  renderKBList()

  // 添加/编辑状态
  let kbEditIdx = -1 // -1=新增, >=0=编辑索引
  const openKBEditor = (idx) => {
    kbEditIdx = idx
    kbEditorEl.style.display = ''
    if (idx >= 0) {
      overlay.querySelector('#ast-kb-name').value = kbFiles[idx].name
      overlay.querySelector('#ast-kb-content').value = kbFiles[idx].content
      overlay.querySelector('#ast-kb-save').textContent = '更新'
    } else {
      overlay.querySelector('#ast-kb-name').value = ''
      overlay.querySelector('#ast-kb-content').value = ''
      overlay.querySelector('#ast-kb-save').textContent = '保存知识'
    }
    overlay.querySelector('#ast-kb-name').focus()
  }
  overlay.querySelector('#ast-kb-add').onclick = () => openKBEditor(-1)
  overlay.querySelector('#ast-kb-cancel').onclick = () => {
    kbEditorEl.style.display = 'none'
  }
  overlay.querySelector('#ast-kb-save').onclick = () => {
    const name = overlay.querySelector('#ast-kb-name').value.trim()
    const content = overlay.querySelector('#ast-kb-content').value.trim()
    if (!name) { toast('请输入知识名称', 'warning'); return }
    if (!content) { toast('请输入知识内容', 'warning'); return }
    if (kbEditIdx >= 0) {
      kbFiles[kbEditIdx].name = name
      kbFiles[kbEditIdx].content = content
    } else {
      kbFiles.push({ name, content, enabled: true })
    }
    kbEditorEl.style.display = 'none'
    renderKBList()
  }
  // 点击列表项：编辑/切换启用/删除
  kbListEl.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-kb-del]')
    if (delBtn) {
      e.stopPropagation()
      const idx = parseInt(delBtn.dataset.kbDel)
      kbFiles.splice(idx, 1)
      if (kbEditIdx === idx) kbEditorEl.style.display = 'none'
      renderKBList()
      return
    }
    const toggleBtn = e.target.closest('[data-kb-toggle]')
    if (toggleBtn) {
      e.stopPropagation()
      const idx = parseInt(toggleBtn.dataset.kbToggle)
      kbFiles[idx].enabled = kbFiles[idx].enabled === false ? true : false
      renderKBList()
      return
    }
    const row = e.target.closest('[data-kb-idx]')
    if (row) {
      openKBEditor(parseInt(row.dataset.kbIdx))
    }
  })

  // ── gpt.qt.cool 一键配置 ──
  const qtcoolModelSelect = overlay.querySelector('#ast-qtcool-model')
  const qtcoolCustomKeyCheckbox = overlay.querySelector('#ast-qtcool-customkey')
  const qtcoolKeyRow = overlay.querySelector('#ast-qtcool-keyrow')
  const qtcoolKeyInput = overlay.querySelector('#ast-qtcool-key')
  const qtcoolUsageLink = overlay.querySelector('#ast-qtcool-usage')

  // 动态获取模型列表
  ;(async () => {
    let models = QTCOOL.models // fallback
    try {
      const resp = await fetch(QTCOOL.baseUrl + '/models', {
        headers: { 'Authorization': 'Bearer ' + QTCOOL.defaultKey },
        signal: AbortSignal.timeout(8000)
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.data && data.data.length) {
          models = data.data.map(m => ({ id: m.id, name: m.id })).sort((a, b) => b.id.localeCompare(a.id))
        }
      }
    } catch { /* use fallback */ }
    qtcoolModelSelect.innerHTML = models.map((m, i) =>
      `<option value="${m.id}" style="color:#333"${i === 0 ? ' selected' : ''}>${m.name || m.id}${i === 0 ? ' ★' : ''}</option>`
    ).join('')
  })()

  qtcoolCustomKeyCheckbox.onchange = () => {
    qtcoolKeyRow.style.display = qtcoolCustomKeyCheckbox.checked ? '' : 'none'
    if (qtcoolCustomKeyCheckbox.checked) qtcoolKeyInput.focus()
  }
  qtcoolKeyInput.oninput = () => {
    const key = qtcoolKeyInput.value.trim()
    qtcoolUsageLink.href = QTCOOL.usageUrl + (key || QTCOOL.defaultKey)
  }
  const qtcoolStatus = overlay.querySelector('#ast-qtcool-status')

  // 测试按钮：快速验证接口可用性
  overlay.querySelector('#ast-qtcool-test').onclick = async (e) => {
    const btn = e.target
    const selectedModel = qtcoolModelSelect.value
    if (!selectedModel) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} 请先选择模型</span>`; return }
    const customKey = qtcoolCustomKeyCheckbox.checked ? qtcoolKeyInput.value.trim() : ''
    const key = customKey || QTCOOL.defaultKey

    btn.disabled = true
    btn.textContent = '测试中...'
    qtcoolStatus.innerHTML = '<span style="color:rgba(255,255,255,0.5)">正在连接 GPT-AI 网关...</span>'
    const t0 = Date.now()
    try {
      const resp = await fetch(QTCOOL.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: selectedModel, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 }),
        signal: AbortSignal.timeout(15000)
      })
      const ms = Date.now() - t0
      if (resp.ok) {
        const data = await resp.json()
        const reply = data.choices?.[0]?.message?.content || ''
        qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} 测试通过（${(ms/1000).toFixed(1)}s）</span><span style="color:rgba(255,255,255,0.4);margin-left:6px">${selectedModel} 响应正常</span>`
      } else {
        const errText = await resp.text().catch(() => '')
        qtcoolStatus.innerHTML = `<span style="color:#f87171">${statusIcon('err', 14)} 测试失败（HTTP ${resp.status}）</span><span style="color:rgba(255,255,255,0.4);margin-left:6px">${errText.slice(0, 80)}</span>`
      }
    } catch (err) {
      qtcoolStatus.innerHTML = `<span style="color:#f87171">${statusIcon('err', 14)} 连接失败：${err.message}</span>`
    }
    btn.disabled = false
    btn.innerHTML = `${icon('search', 12)} 测试`
  }

  // 一键接入：填充配置 + 提示设为 OpenClaw 主模型
  overlay.querySelector('#ast-qtcool-apply').onclick = async () => {
    const selectedModel = qtcoolModelSelect.value
    if (!selectedModel) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} 请先选择模型</span>`; return }
    const customKey = qtcoolCustomKeyCheckbox.checked ? qtcoolKeyInput.value.trim() : ''
    const key = customKey || QTCOOL.defaultKey

    // 1) 填充助手配置
    overlay.querySelector('#ast-baseurl').value = QTCOOL.baseUrl
    overlay.querySelector('#ast-apikey').value = key
    overlay.querySelector('#ast-model').value = selectedModel
    overlay.querySelector('#ast-apitype').value = 'openai'
    qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} 助手已配置为 ${selectedModel}</span>`
    toast('助手已接入 gpt.qt.cool — ' + selectedModel, 'success')

    // 2) 提示是否同步写入 OpenClaw 配置（设为主模型）
    const yes = await showConfirm(
      '同步到 OpenClaw？',
      `是否将 qtcool/${selectedModel} 设为 OpenClaw 主模型？\n\n这将把 gpt.qt.cool 添加为模型服务商，并设置 ${selectedModel} 为全局主模型，AI 助手和所有渠道都将使用该模型。`,
      { confirmText: '设为主模型', cancelText: '仅配置助手' }
    )
    if (yes) {
      try {
        let config = {}
        try { config = await api.readOpenclawConfig() } catch {}
        if (!config.models) config.models = {}
        if (!config.models.providers) config.models.providers = {}

        // 添加/更新 qtcool provider
        if (!config.models.providers.qtcool) {
          config.models.providers.qtcool = {
            baseUrl: QTCOOL.baseUrl,
            apiKey: key,
            api: 'openai-completions',
            models: QTCOOL.models.map(m => ({ id: m.id, name: m.name, contextWindow: 128000, reasoning: m.id.includes('codex') }))
          }
        } else {
          config.models.providers.qtcool.apiKey = key
        }

        // 设为主模型
        if (!config.agents) config.agents = {}
        if (!config.agents.defaults) config.agents.defaults = {}
        if (!config.agents.defaults.model) config.agents.defaults.model = {}
        config.agents.defaults.model.primary = 'qtcool/' + selectedModel

        await api.writeOpenclawConfig(config)
        qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} 已设为主模型 qtcool/${selectedModel}，正在重启 Gateway...</span>`
        try {
          await api.restartGateway()
          toast('OpenClaw 主模型已切换为 qtcool/' + selectedModel, 'success')
          qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} 全部完成！主模型：qtcool/${selectedModel}</span>`
        } catch (e) {
          toast('配置已保存，Gateway 重启失败: ' + e.message, 'warning')
        }
      } catch (e) {
        toast('写入 OpenClaw 配置失败: ' + e, 'error')
      }
    }
  }

  const resultEl = overlay.querySelector('#ast-test-result')
  const modelInput = overlay.querySelector('#ast-model')
  const dropdown = overlay.querySelector('#ast-model-dropdown')

  // 测试对话：真实发一条消息，显示完整请求/响应参数
  overlay.querySelector('#ast-btn-test').onclick = async (e) => {
    const btn = e.target
    const baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    const apiKey = overlay.querySelector('#ast-apikey').value.trim()
    const model = overlay.querySelector('#ast-model').value.trim()
    const selApiType = overlay.querySelector('#ast-apitype').value || 'openai'
    if (!baseUrl || !apiKey) {
      resultEl.innerHTML = '<span style="color:var(--warning)">请先填写 Base URL 和 API Key</span>'
      return
    }
    if (!model) {
      resultEl.innerHTML = '<span style="color:var(--warning)">请先填写或选择模型</span>'
      return
    }
    btn.disabled = true
    btn.textContent = '测试中...'
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">正在发送测试消息...</span>'
    const base = cleanBaseUrl(baseUrl, selApiType)
    const hdrs = authHeaders(selApiType, apiKey)
    const t0 = Date.now()

    let respStatus = 0, respBody = '', reply = '', usedApi = '', reqUrl = '', reqBody = {}

    try {
      if (selApiType === 'anthropic') {
        usedApi = 'Anthropic Messages'
        reqUrl = base + '/messages'
        reqBody = { model, messages: [{ role: 'user', content: '你好，请用一句话回复' }], max_tokens: 200 }
        const resp = await fetch(reqUrl, { method: 'POST', headers: hdrs, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000) })
        respStatus = resp.status; respBody = await resp.text()
        try {
          const data = JSON.parse(respBody)
          reply = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || ''
        } catch {}
      } else if (selApiType === 'google-gemini') {
        usedApi = 'Gemini'
        reqUrl = `${base}/models/${model}:generateContent?key=***`
        reqBody = { contents: [{ role: 'user', parts: [{ text: '你好，请用一句话回复' }] }] }
        const realUrl = `${base}/models/${model}:generateContent?key=${apiKey}`
        const resp = await fetch(realUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000) })
        respStatus = resp.status; respBody = await resp.text()
        try {
          const data = JSON.parse(respBody)
          reply = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        } catch {}
      } else {
        // OpenAI: Chat Completions + Responses fallback
        usedApi = 'Chat Completions'
        reqUrl = base + '/chat/completions'
        reqBody = { model, messages: [{ role: 'user', content: '你好，请用一句话回复' }], max_tokens: 200 }
        const resp = await fetch(reqUrl, { method: 'POST', headers: hdrs, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000) })
        respStatus = resp.status; respBody = await resp.text()

        let fallback = false
        if (!resp.ok && (respBody.includes('legacy protocol') || respBody.includes('/v1/responses') || respBody.includes('not supported'))) {
          fallback = true
        }

        if (!fallback) {
          try {
            const data = JSON.parse(respBody)
            const msg = data.choices?.[0]?.message
            reply = msg?.content || msg?.reasoning_content || data.choices?.[0]?.text || data.output?.text || ''
            if (!msg?.content && msg?.reasoning_content) reply = '[推理内容] ' + reply
          } catch {}
        }

        if (fallback) {
          usedApi = 'Responses'
          reqUrl = base + '/responses'
          reqBody = { model, input: [{ role: 'user', content: '你好，请用一句话回复' }], max_output_tokens: 200 }
          try {
            const resp2 = await fetch(reqUrl, { method: 'POST', headers: hdrs, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000) })
            respStatus = resp2.status; respBody = await resp2.text()
            try { const d = JSON.parse(respBody); reply = d.output_text || d.output?.[0]?.content?.[0]?.text || '' } catch {}
          } catch (err2) {
            resultEl.innerHTML = buildTestResult({ success: false, elapsed: Date.now() - t0, usedApi, reqUrl, reqBody, respStatus: 0, respBody: '', error: err2.message })
            btn.disabled = false; btn.textContent = '测试'; return
          }
        }
      }
    } catch (err) {
      resultEl.innerHTML = buildTestResult({ success: false, elapsed: Date.now() - t0, usedApi, reqUrl, reqBody, respStatus: 0, respBody: '', error: err.message })
      btn.disabled = false; btn.textContent = '测试'; return
    }

    resultEl.innerHTML = buildTestResult({ success: !!reply, elapsed: Date.now() - t0, usedApi, reqUrl, reqBody, respStatus, respBody, reply })
    btn.disabled = false
    btn.textContent = '测试'
  }

  // 获取模型列表
  overlay.querySelector('#ast-btn-models').onclick = async (e) => {
    const btn = e.target
    const baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    const apiKey = overlay.querySelector('#ast-apikey').value.trim()
    if (!baseUrl || !apiKey) {
      resultEl.innerHTML = '<span style="color:var(--warning)">请先填写 Base URL 和 API Key</span>'
      return
    }
    btn.disabled = true
    btn.textContent = '获取中...'
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">正在获取模型列表...</span>'
    const selApiType = overlay.querySelector('#ast-apitype').value || 'openai'
    try {
      const base = cleanBaseUrl(baseUrl, selApiType)
      const hdrs = authHeaders(selApiType, apiKey)
      let models = []

      if (selApiType === 'anthropic') {
        // Anthropic: GET /v1/models
        const resp = await fetch(base + '/models', { headers: hdrs, signal: AbortSignal.timeout(10000) })
        if (!resp.ok) {
          const text = await resp.text().catch(() => '')
          let msg = 'HTTP ' + resp.status
          try { msg = JSON.parse(text).error?.message || msg } catch {}
          resultEl.innerHTML = '<span style="color:var(--error)">✗ ' + escHtml(msg) + '</span>'
          return
        }
        const data = await resp.json()
        models = (data.data || []).map(m => m.id).filter(Boolean).sort()
      } else if (selApiType === 'google-gemini') {
        // Gemini: GET /models?key=xxx
        const resp = await fetch(base + '/models?key=' + apiKey, { signal: AbortSignal.timeout(10000) })
        if (!resp.ok) {
          const text = await resp.text().catch(() => '')
          let msg = 'HTTP ' + resp.status
          try { msg = JSON.parse(text).error?.message || msg } catch {}
          resultEl.innerHTML = '<span style="color:var(--error)">✗ ' + escHtml(msg) + '</span>'
          return
        }
        const data = await resp.json()
        models = (data.models || []).map(m => m.name?.replace('models/', '') || m.name).filter(Boolean).sort()
      } else {
        // OpenAI: GET /v1/models
        const resp = await fetch(base + '/models', { headers: hdrs, signal: AbortSignal.timeout(10000) })
        if (!resp.ok) {
          const text = await resp.text().catch(() => '')
          let msg = 'HTTP ' + resp.status
          try { msg = JSON.parse(text).error?.message || msg } catch {}
          resultEl.innerHTML = '<span style="color:var(--error)">✗ ' + escHtml(msg) + '</span>'
          return
        }
        const data = await resp.json()
        models = (data.data || []).map(m => m.id).filter(Boolean).sort()
      }

      if (models.length === 0) {
        resultEl.innerHTML = '<span style="color:var(--warning)">未发现可用模型</span>'
        return
      }
      resultEl.innerHTML = '<span style="color:var(--success)">✓ 发现 ' + models.length + ' 个模型，点击下方列表选择</span>'
      dropdown.innerHTML = models.map(m =>
        '<div class="ast-model-option" data-model="' + escHtml(m) + '">' + escHtml(m) + '</div>'
      ).join('')
      dropdown.style.display = 'block'
    } catch (err) {
      resultEl.innerHTML = '<span style="color:var(--error)">✗ ' + escHtml(err.message) + '</span>'
    } finally {
      btn.disabled = false
      btn.textContent = '拉取'
    }
  }

  // 从 OpenClaw 导入模型配置
  overlay.querySelector('#ast-btn-import').onclick = async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = '扫描中...'
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">正在扫描 OpenClaw 模型配置...</span>'

    try {
      const sysInfo = await api.assistantSystemInfo()
      const home = sysInfo.match(/主目录[:：]\s*(.+)/)?.[1]?.trim() || sysInfo.match(/Home[:：]\s*(.+)/)?.[1]?.trim() || ''
      if (!home) throw new Error('无法获取主目录路径')

      const providers = []

      // 扫描 agents/*/agent/models.json
      try {
        const agentsList = await api.assistantListDir(home + '/.openclaw/agents')
        const agentIds = agentsList.split('\n').map(l => l.replace(/\/$/, '').trim()).filter(Boolean)
        for (const agentId of agentIds) {
          try {
            const raw = await api.assistantReadFile(home + '/.openclaw/agents/' + agentId + '/agent/models.json')
            const data = JSON.parse(raw)
            for (const [pid, p] of Object.entries(data.providers || {})) {
              if (p.baseUrl && p.apiKey) {
                providers.push({
                  source: 'Agent: ' + agentId,
                  name: pid,
                  baseUrl: p.baseUrl,
                  apiKey: p.apiKey,
                  apiType: 'openai',
                  models: (p.models || []).map(m => m.id || m.name).filter(Boolean),
                })
              }
            }
          } catch {}
        }
      } catch {}

      // 扫描全局 openclaw.json
      try {
        const raw = await api.assistantReadFile(home + '/.openclaw/openclaw.json')
        const config = JSON.parse(raw)
        for (const [pid, p] of Object.entries(config.models?.providers || {})) {
          if (p.baseUrl && p.apiKey && !providers.find(x => x.name === pid)) {
            providers.push({
              source: '全局配置',
              name: pid,
              baseUrl: p.baseUrl,
              apiKey: p.apiKey,
              apiType: 'openai',
              models: [],
            })
          }
        }
      } catch {}

      if (providers.length === 0) {
        resultEl.innerHTML = '<span style="color:var(--warning)">未发现 OpenClaw 模型配置。请先安装并配置 OpenClaw。</span>'
        return
      }

      // 构建选择 UI
      const listHtml = providers.map((p, i) => {
        const modelsStr = p.models.length ? p.models.join(', ') : '(无模型列表)'
        return `<div class="ast-import-option" data-idx="${i}" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:background 0.15s">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escHtml(p.name)}</strong>
            <span style="font-size:11px;color:var(--text-tertiary)">${escHtml(p.source)}</span>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${escHtml(p.baseUrl)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">模型: ${escHtml(modelsStr)}</div>
        </div>`
      }).join('')

      resultEl.innerHTML = `<div style="margin-top:4px">
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">检测到 ${providers.length} 个服务商，点击选择：</div>
        ${listHtml}
      </div>`

      // 点击选择后填充
      resultEl.querySelectorAll('.ast-import-option').forEach(el => {
        el.addEventListener('mouseenter', () => el.style.background = 'var(--bg-secondary)')
        el.addEventListener('mouseleave', () => el.style.background = '')
        el.addEventListener('click', () => {
          const p = providers[parseInt(el.dataset.idx)]
          overlay.querySelector('#ast-baseurl').value = p.baseUrl
          overlay.querySelector('#ast-apikey').value = p.apiKey
          overlay.querySelector('#ast-apitype').value = p.apiType
          if (p.models.length > 0) {
            overlay.querySelector('#ast-model').value = p.models[0]
            // 填充模型下拉列表
            dropdown.innerHTML = p.models.map(m =>
              '<div class="ast-model-option" data-model="' + escHtml(m) + '">' + escHtml(m) + '</div>'
            ).join('')
          }
          resultEl.innerHTML = '<span style="color:var(--success)">✓ 已导入「' + escHtml(p.name) + '」的配置' + (p.models.length ? '（' + p.models.length + ' 个模型）' : '') + '</span>'
        })
      })

    } catch (err) {
      resultEl.innerHTML = '<span style="color:var(--error)">导入失败: ' + escHtml(err.message || String(err)) + '</span>'
    } finally {
      btn.disabled = false
      btn.innerHTML = `${icon('download', 14)} 导入`
    }
  }

  // 模型下拉选择
  dropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.ast-model-option')
    if (opt) {
      modelInput.value = opt.dataset.model
      dropdown.style.display = 'none'
    }
  })

  // 点击输入框外关闭下拉
  modelInput.addEventListener('focus', () => {
    if (dropdown.children.length > 0) dropdown.style.display = 'block'
  })
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); return }
    if (!e.target.closest('#ast-model') && !e.target.closest('#ast-model-dropdown') && !e.target.closest('#ast-btn-models')) {
      dropdown.style.display = 'none'
    }
  })

  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    _config.assistantName = overlay.querySelector('#ast-name').value.trim() || DEFAULT_NAME
    _config.assistantPersonality = overlay.querySelector('#ast-personality').value.trim() || DEFAULT_PERSONALITY
    _config.baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    _config.apiKey = overlay.querySelector('#ast-apikey').value.trim()
    _config.model = overlay.querySelector('#ast-model').value.trim()
    _config.temperature = parseFloat(overlay.querySelector('#ast-temp').value) || 0.7
    _config.apiType = overlay.querySelector('#ast-apitype').value || 'openai'
    // 工具开关
    _config.tools.terminal = overlay.querySelector('#ast-tool-terminal').checked
    _config.tools.fileOps = overlay.querySelector('#ast-tool-fileops').checked
    _config.tools.webSearch = overlay.querySelector('#ast-tool-websearch').checked
    // 灵魂来源
    const soulRadio = overlay.querySelector('input[name="ast-soul-source"]:checked')
    if (soulRadio?.value === 'openclaw') {
      const selectedAgent = overlay.querySelector('#ast-soul-agent')?.value || 'main'
      _config.soulSource = 'openclaw:' + selectedAgent
    } else {
      _config.soulSource = 'default'
      _soulCache = null
    }
    // 知识库
    _config.knowledgeFiles = kbFiles
    saveConfig()
    overlay.remove()
    // 更新 Header 标题和欢迎页
    const titleEl = _page.querySelector('.ast-title')
    if (titleEl) {
      // 灵魂移植模式下，尝试从 IDENTITY.md 提取名称
      let displayName = _config.assistantName
      if (_config.soulSource?.startsWith('openclaw:') && _soulCache?.identity) {
        const nameMatch = _soulCache.identity.match(/\*\*Name:\*\*\s*(.+)/i) || _soulCache.identity.match(/名[字称][:：]\s*(.+)/i)
        const extracted = nameMatch?.[1]?.trim()
        // 跳过占位符文本（模板未填写时的默认值）
        if (extracted && !extracted.startsWith('_') && !extracted.startsWith('（') && extracted.length < 30) {
          displayName = extracted
        }
      }
      titleEl.textContent = displayName
    }
    renderMessages()
    toast('设置已保存', 'info')
    updateModelBadge()
  }
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove()
  })
  const firstInput = overlay.querySelector('input')
  if (firstInput) firstInput.focus()
}

function updateModelBadge() {
  const badge = _page?.querySelector('#ast-model-badge')
  if (badge) {
    if (_config.model) {
      badge.textContent = _config.model
      badge.className = 'ast-model-badge configured'
    } else {
      badge.textContent = '未配置'
      badge.className = 'ast-model-badge unconfigured'
    }
  }
}

// ── 发送消息 ──
function sendMessage(text) {
  const hasContent = text.trim() || _pendingImages.length > 0
  if (!hasContent) return
  // 流式中 → 排队（图片不排队，提示用户）
  if (_isStreaming) {
    if (_pendingImages.length > 0) {
      toast('AI 正在回复中，图片消息请等待完成后再发送', 'info')
      return
    }
    enqueueMessage(text.trim())
    return
  }
  sendMessageDirect(text)
}

// 直接发送（内部使用，不经过队列）
async function sendMessageDirect(text) {
  const hasContent = text.trim() || _pendingImages.length > 0
  if (!hasContent) return
  if (_isStreaming) {
    if (_pendingImages.length > 0) { toast('请等待 AI 回复完成', 'info'); return }
    enqueueMessage(text.trim())
    return
  }

  let session = getCurrentSession()
  if (!session) {
    session = createSession()
    renderSessionList()
  }

  // 收集当前附件图片
  const images = [..._pendingImages]
  clearPendingImages()

  // 添加用户消息（多模态或纯文本）
  const textContent = text.trim()
  const msgContent = buildMessageContent(textContent, images)
  const userMsg = { role: 'user', content: msgContent, ts: Date.now() }
  if (images.length > 0) {
    // 为每张图片生成稳定 ID 并存入文件系统
    userMsg._images = images.map(i => {
      const dbId = 'img_' + i.id
      saveImageToFile(dbId, i.dataUrl) // 异步存储，不阻塞
      return { dbId, dataUrl: i.dataUrl, name: i.name, width: i.width, height: i.height }
    })
  }
  if (textContent) userMsg._text = textContent
  session.messages.push(userMsg)
  autoTitle(session)
  session.updatedAt = Date.now()
  saveSessions()
  renderMessages()
  renderSessionList()

  // 准备 AI 上下文（只保留 role + content，剔除内部字段）
  // 过滤掉空的 AI 回复，避免污染上下文导致模型也返回空
  const contextMessages = session.messages
    .filter(m => {
      if (m.role === 'user') return true
      if (m.role === 'assistant') return m.content && m.content.length > 0
      return false
    })
    .slice(-MAX_CONTEXT_TOKENS)
    .map(m => ({ role: m.role, content: m.content }))

  // 添加空 AI 消息占位
  const aiMsg = { role: 'assistant', content: '', ts: Date.now() }
  session.messages.push(aiMsg)

  _isStreaming = true
  _sendBtn.innerHTML = stopIcon()
  setSessionStatus(session.id, 'streaming')

  // 渲染流式 typing 状态
  renderMessages()
  const aiBubbles = _messagesEl?.querySelectorAll('.ast-msg-bubble-ai')
  const lastBubble = aiBubbles?.[aiBubbles.length - 1]
  if (lastBubble) lastBubble.innerHTML = '<span class="ast-typing">思考中...</span>'

  const toolsEnabled = getEnabledTools().length > 0

  try {
    if (toolsEnabled) {
      // ── 工具模式：非流式，支持 tool_calls 循环 ──
      const aiMsgContainers = _messagesEl?.querySelectorAll('.ast-msg-ai')
      const lastContainer = aiMsgContainers?.[aiMsgContainers.length - 1]

      const result = await callAIWithTools(contextMessages,
        // onStatus
        (status) => {
          if (lastBubble) lastBubble.innerHTML = `<span class="ast-typing">${escHtml(status)}</span>`
        },
        // onToolProgress
        (history) => {
          aiMsg.toolHistory = history
          throttledSave() // 实时保存工具调用进度
          if (!lastContainer) return
          const toolHtml = renderToolBlocks(history)
          const bubble = lastContainer.querySelector('.ast-msg-bubble-ai')
          lastContainer.innerHTML = toolHtml + (bubble ? bubble.outerHTML : '')
          if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
        }
      )

      aiMsg.content = result.content
      if (result.toolHistory.length > 0) {
        aiMsg.toolHistory = result.toolHistory
      }
      renderMessages()
    } else {
      // ── 普通流式模式 ──
      await callAI(contextMessages, (chunk) => {
        aiMsg.content += chunk
        throttledSave() // 实时保存每个 chunk
        if (lastBubble) {
          const now = Date.now()
          if (now - _lastRenderTime > 50) {
            lastBubble.innerHTML = renderMarkdown(aiMsg.content) + '<span class="ast-cursor">▊</span>'
            if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
            _lastRenderTime = now
          }
        }
      })

      if (lastBubble) {
        lastBubble.innerHTML = renderMarkdown(aiMsg.content)
      }
    }
    // 保存调试信息到 AI 消息
    if (_lastDebugInfo) {
      aiMsg._debug = _lastDebugInfo
      _lastDebugInfo = null
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      aiMsg.content += aiMsg.content ? '\n\n*[已停止]*' : '*[已停止]*'
    } else {
      setSessionStatus(session.id, 'error')
      // 保留已有内容，追加错误信息和重试按钮
      const errInfo = aiMsg.content
        ? `\n\n---\n**请求中断**: ${err.message}`
        : err.message
      aiMsg.content += errInfo
      aiMsg._canRetry = true
    }
    renderMessages()

    // 错误后插入重试按钮
    if (aiMsg._canRetry && _messagesEl) {
      const retryBar = document.createElement('div')
      retryBar.className = 'ast-retry-bar'
      const retrySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
      const continueSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
      retryBar.innerHTML = `
        <button class="btn btn-sm btn-primary ast-btn-retry">${retrySvg} 重试</button>
        <button class="btn btn-sm btn-secondary ast-btn-continue">${continueSvg} 输入继续</button>
        <span class="ast-retry-hint">请求失败（已自动重试 3 次）</span>
      `
      _messagesEl.appendChild(retryBar)
      _messagesEl.scrollTop = _messagesEl.scrollHeight

      retryBar.querySelector('.ast-btn-retry').addEventListener('click', () => {
        retryBar.remove()
        session.messages.pop()
        saveSessions()
        setSessionStatus(session.id, 'idle')
        retryAIResponse(session)
      })
      retryBar.querySelector('.ast-btn-continue').addEventListener('click', () => {
        retryBar.remove()
        setSessionStatus(session.id, 'idle')
        renderSessionList()
        _textarea?.focus()
      })
    }
  } finally {
    _isStreaming = false
    _abortController = null
    stopStreamRefresh()
    if (_sendBtn) _sendBtn.innerHTML = sendIcon()
    if (_textarea) _textarea.focus()
    session.updatedAt = Date.now()
    flushSave()
    if (getSessionStatus(session.id) !== 'error') {
      setSessionStatus(session.id, 'idle')
    }
    // 最终渲染（可能从后台回来，DOM 已重建）
    if (_messagesEl) {
      renderMessages()
      _messagesEl.scrollTop = _messagesEl.scrollHeight
    }
    setTimeout(() => processQueue(), 100)
  }
}

// 重试 AI 响应（不重复添加用户消息）
async function retryAIResponse(session) {
  if (_isStreaming) return

  const contextMessages = session.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_CONTEXT_TOKENS)

  const aiMsg = { role: 'assistant', content: '', ts: Date.now() }
  session.messages.push(aiMsg)

  _isStreaming = true
  if (_sendBtn) _sendBtn.innerHTML = stopIcon()
  setSessionStatus(session.id, 'streaming')

  renderMessages()
  const aiBubbles = _messagesEl?.querySelectorAll('.ast-msg-bubble-ai')
  const lastBubble = aiBubbles?.[aiBubbles.length - 1]
  if (lastBubble) lastBubble.innerHTML = '<span class="ast-typing">重试中...</span>'

  const toolsEnabled = getEnabledTools().length > 0

  try {
    if (toolsEnabled) {
      const aiMsgContainers = _messagesEl?.querySelectorAll('.ast-msg-ai')
      const lastContainer = aiMsgContainers?.[aiMsgContainers.length - 1]

      const result = await callAIWithTools(contextMessages,
        (status) => { if (lastBubble) lastBubble.innerHTML = `<span class="ast-typing">${escHtml(status)}</span>` },
        (history) => {
          aiMsg.toolHistory = history
          throttledSave()
          if (!lastContainer) return
          const toolHtml = renderToolBlocks(history)
          const bubble = lastContainer.querySelector('.ast-msg-bubble-ai')
          lastContainer.innerHTML = toolHtml + (bubble ? bubble.outerHTML : '')
          if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
        }
      )
      aiMsg.content = result.content
      if (result.toolHistory.length > 0) aiMsg.toolHistory = result.toolHistory
      renderMessages()
    } else {
      await callAI(contextMessages, (chunk) => {
        aiMsg.content += chunk
        throttledSave()
        if (lastBubble) {
          const now = Date.now()
          if (now - _lastRenderTime > 50) {
            lastBubble.innerHTML = renderMarkdown(aiMsg.content) + '<span class="ast-cursor">▊</span>'
            if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
            _lastRenderTime = now
          }
        }
      })
      if (lastBubble) lastBubble.innerHTML = renderMarkdown(aiMsg.content)
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      aiMsg.content += aiMsg.content ? '\n\n*[已停止]*' : '*[已停止]*'
    } else {
      setSessionStatus(session.id, 'error')
      aiMsg.content += aiMsg.content
        ? `\n\n---\n**请求中断**: ${err.message}`
        : err.message
      aiMsg._canRetry = true
    }
    renderMessages()

    if (aiMsg._canRetry && _messagesEl) {
      const retryBar = document.createElement('div')
      retryBar.className = 'ast-retry-bar'
      const retrySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
      const continueSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
      retryBar.innerHTML = `
        <button class="btn btn-sm btn-primary ast-btn-retry">${retrySvg} 重试</button>
        <button class="btn btn-sm btn-secondary ast-btn-continue">${continueSvg} 输入继续</button>
        <span class="ast-retry-hint">请求失败（已自动重试 3 次）</span>
      `
      _messagesEl.appendChild(retryBar)
      _messagesEl.scrollTop = _messagesEl.scrollHeight

      retryBar.querySelector('.ast-btn-retry').addEventListener('click', () => {
        retryBar.remove()
        session.messages.pop()
        saveSessions()
        setSessionStatus(session.id, 'idle')
        retryAIResponse(session)
      })
      retryBar.querySelector('.ast-btn-continue').addEventListener('click', () => {
        retryBar.remove()
        setSessionStatus(session.id, 'idle')
        renderSessionList()
        _textarea?.focus()
      })
    }
  } finally {
    _isStreaming = false
    _abortController = null
    stopStreamRefresh()
    if (_sendBtn) _sendBtn.innerHTML = sendIcon()
    if (_textarea) _textarea.focus()
    session.updatedAt = Date.now()
    flushSave()
    if (getSessionStatus(session.id) !== 'error') {
      setSessionStatus(session.id, 'idle')
    }
    if (_messagesEl) {
      renderMessages()
      _messagesEl.scrollTop = _messagesEl.scrollHeight
    }
    setTimeout(() => processQueue(), 100)
  }
}

function stopStreaming() {
  _isStreaming = false
  if (_abortController) {
    _abortController.abort()
    _abortController = null
  }
}

// ── 右键调试菜单 ──
let _ctxMenu = null

function showMsgContextMenu(e, msgIdx) {
  e.preventDefault()
  hideContextMenu()

  const session = getCurrentSession()
  if (!session) return
  const msg = session.messages[msgIdx]
  if (!msg) return

  const menu = document.createElement('div')
  menu.className = 'ast-ctx-menu'
  menu.innerHTML = `
    <button data-action="copy-text">复制文本</button>
    <button data-action="copy-md">复制 Markdown</button>
    <hr/>
    <button data-action="view-raw">查看原始数据</button>
    ${msg._debug ? '<button data-action="view-debug">查看请求/响应</button>' : ''}
  `
  // 定位
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px'
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px'
  document.body.appendChild(menu)
  _ctxMenu = menu

  menu.addEventListener('click', (ev) => {
    const action = ev.target.dataset?.action
    if (!action) return
    hideContextMenu()

    const textContent = typeof msg.content === 'string'
      ? msg.content
      : (msg._text || msg.content?.find?.(p => p.type === 'text')?.text || '')

    if (action === 'copy-text') {
      navigator.clipboard.writeText(textContent).then(() => toast('已复制文本'))
    } else if (action === 'copy-md') {
      navigator.clipboard.writeText(msg.content || textContent).then(() => toast('已复制 Markdown'))
    } else if (action === 'view-raw') {
      const raw = { role: msg.role, content: msg.content, ts: msg.ts }
      if (msg._images) raw._images = msg._images.map(i => ({ dbId: i.dbId, name: i.name, width: i.width, height: i.height }))
      if (msg.toolHistory) raw.toolHistory = msg.toolHistory
      showDebugModal('消息原始数据', JSON.stringify(raw, null, 2))
    } else if (action === 'view-debug' && msg._debug) {
      showDebugModal('请求/响应调试', JSON.stringify(msg._debug, null, 2))
    }
  })

  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 10)
}

function hideContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null }
}

function showDebugModal(title, content) {
  const overlay = document.createElement('div')
  overlay.className = 'ast-debug-overlay'
  overlay.innerHTML = `
    <div class="ast-debug-modal">
      <div class="ast-debug-header">
        <span>${escHtml(title)}</span>
        <button class="ast-debug-close">&times;</button>
      </div>
      <pre class="ast-debug-content">${escHtml(content)}</pre>
      <div class="ast-debug-actions">
        <button class="btn btn-sm btn-primary ast-debug-copy">复制</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('.ast-debug-close').onclick = () => overlay.remove()
  overlay.querySelector('.ast-debug-copy').onclick = () => {
    navigator.clipboard.writeText(content).then(() => toast('已复制'))
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

const AST_GUIDE_KEY = 'clawpanel-guide-assistant-dismissed'

function getAssistantGuideHtml() {
  if (localStorage.getItem(AST_GUIDE_KEY)) return ''
  return `
    <div class="ast-page-guide" id="ast-page-guide">
      <div class="ast-guide-badge">内置 AI</div>
      <div class="ast-guide-text">
        <b>这是 ClawPanel 内置的 AI 助手</b>，独立于 OpenClaw，使用你在右上角「设置」中配置的 API。
        <span style="opacity:0.6">如需与 OpenClaw Agent 对话，请前往「实时聊天」页面。</span>
      </div>
      <button class="ast-guide-close" onclick="localStorage.setItem('${AST_GUIDE_KEY}','1');this.closest('.ast-page-guide').remove()">&times;</button>
    </div>
  `
}

// ── 工具函数 ──
function escHtml(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

function sendIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
}

function stopIcon() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
}

// ── 页面渲染 ──
export async function render() {
  loadConfig()
  loadSessions()

  // 确保数据目录存在（~/.openclaw/clawpanel/images/ 等）
  api.ensureDataDir().catch(e => console.warn('数据目录初始化失败:', e))

  // 如果没有会话，不自动创建（显示欢迎页）
  if (_sessions.length > 0 && !_currentSessionId) {
    _currentSessionId = _sessions[_sessions.length - 1].id
  }

  const page = document.createElement('div')
  page.className = 'page ast-page'
  _page = page

  page.innerHTML = `
    <div class="ast-sidebar" id="ast-sidebar">
      <div class="ast-sidebar-header">
        <span>会话列表</span>
        <button class="ast-sidebar-btn" id="ast-btn-new" title="新建会话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <div class="ast-session-list" id="ast-session-list"></div>
    </div>
    <div class="ast-main">
      <div class="ast-header">
        <div class="ast-header-left">
          <button class="ast-toggle-sidebar" id="ast-btn-toggle" title="会话列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span class="ast-title">${_config?.assistantName || DEFAULT_NAME}</span>
          <span class="ast-model-badge ${_config.model ? 'configured' : 'unconfigured'}" id="ast-model-badge">${_config.model || '未配置'}</span>
        </div>
        <div class="ast-header-actions">
          <div class="ast-mode-selector" id="ast-mode-selector">
            <div class="ast-mode-slider" id="ast-mode-slider"></div>
            ${Object.entries(MODES).map(([key, m]) => `<button class="ast-mode-btn ${currentMode() === key ? 'active' : ''}" data-mode="${key}" title="${m.desc}">${MODE_ICONS[key]} ${m.label}</button>`).join('')}
          </div>
          <button class="btn btn-sm btn-ghost" id="ast-btn-settings" title="模型设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
            设置
          </button>
        </div>
      </div>
      <div class="ast-messages" id="ast-messages"></div>
      <div class="ast-queue" id="ast-queue"></div>
      <div class="ast-input-area">
        <div class="ast-image-preview" id="ast-image-preview"></div>
        <div class="ast-input-wrap">
          <button class="ast-attach-btn" id="ast-btn-attach" title="上传图片">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <input type="file" id="ast-file-input" accept="image/*" multiple style="display:none"/>
          <textarea class="ast-textarea" id="ast-textarea" placeholder="描述你的问题，粘贴日志、截图或错误信息..." rows="1"></textarea>
          <button class="ast-send-btn" id="ast-send-btn" title="发送">${sendIcon()}</button>
        </div>
        <div class="ast-input-hint">Enter 发送 · Shift+Enter 换行 · 支持粘贴/拖拽图片 · AI 助手独立于 OpenClaw</div>
      </div>
    </div>
  `

  // 缓存 DOM 引用
  _messagesEl = page.querySelector('#ast-messages')
  _queueEl = page.querySelector('#ast-queue')
  _textarea = page.querySelector('#ast-textarea')
  _sendBtn = page.querySelector('#ast-send-btn')
  _sessionListEl = page.querySelector('#ast-session-list')

  // 渲染
  renderSessionList()
  renderMessages()
  renderQueue()
  applyModeStyle(page, currentMode())
  // 滑块需要等 DOM 绘制完毕才能获取正确位置
  requestAnimationFrame(() => positionModeSlider(page, currentMode()))

  // 如果有后台流式正在进行，恢复 UI 状态
  if (_isStreaming) {
    _sendBtn.innerHTML = stopIcon()
    startStreamRefresh()
  }

  // 检查是否有从 setup 页面带来的自动提问
  const autoPrompt = sessionStorage.getItem('assistant-auto-prompt')
  if (autoPrompt) {
    sessionStorage.removeItem('assistant-auto-prompt')
    // 自动切换到执行模式
    if (currentMode() === 'chat') {
      _config.mode = 'execute'
      saveConfig()
      page.querySelectorAll('.ast-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'execute'))
    }
    // 延迟发送，确保页面渲染完成
    setTimeout(() => sendMessage(autoPrompt), 300)
  }

  // 检查是否有错误上下文待处理（显示 banner，不自动发送）
  checkErrorContext()
  if (_errorContext) {
    setTimeout(() => renderErrorBanner(), 100)
  }
  // 监听实时错误注入（用户已在助手页面时，其他页面发生错误）
  window.addEventListener('assistant-error-injected', () => {
    checkErrorContext()
    if (_errorContext) renderErrorBanner()
  })

  // ── 事件绑定 ──

  // 右键调试菜单（事件委托）
  _messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('[data-msg-idx]')
    if (!msgEl) return
    showMsgContextMenu(e, parseInt(msgEl.dataset.msgIdx))
  })

  // 发送（流式中输入排队，空输入时点按钮停止流式）
  _sendBtn.addEventListener('click', () => {
    if (_isStreaming && !_textarea.value.trim() && _pendingImages.length === 0) { stopStreaming(); return }
    if (_textarea.value.trim() || _pendingImages.length > 0) {
      sendMessage(_textarea.value)
      _textarea.value = ''
      autoResize(_textarea)
    }
  })

  // Enter 发送，Shift+Enter 换行
  _textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!_textarea.value.trim() && _pendingImages.length === 0) return
      sendMessage(_textarea.value)
      _textarea.value = ''
      autoResize(_textarea)
    }
  })

  // 自动高度
  _textarea.addEventListener('input', () => autoResize(_textarea))

  // 图片上传按钮
  const fileInput = page.querySelector('#ast-file-input')
  page.querySelector('#ast-btn-attach').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files) addImageFromFile(file)
    fileInput.value = ''
  })

  // 粘贴图片（Ctrl+V）
  _textarea.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    let hasImage = false
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        addImageFromClipboard(item)
        hasImage = true
      }
    }
    if (hasImage) e.preventDefault()
  })

  // 拖拽图片
  const mainEl = page.querySelector('.ast-main')
  mainEl.addEventListener('dragover', (e) => {
    e.preventDefault()
    mainEl.classList.add('ast-drag-over')
  })
  mainEl.addEventListener('dragleave', (e) => {
    if (!mainEl.contains(e.relatedTarget)) mainEl.classList.remove('ast-drag-over')
  })
  mainEl.addEventListener('drop', (e) => {
    e.preventDefault()
    mainEl.classList.remove('ast-drag-over')
    for (const file of e.dataTransfer.files) addImageFromFile(file)
  })

  // 图片预览删除
  page.querySelector('#ast-image-preview').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-img-del]')
    if (delBtn) removeImage(delBtn.dataset.imgDel)
  })

  // 队列事件委托
  _queueEl.addEventListener('click', (e) => {
    // 插队发送
    const sendBtn = e.target.closest('[data-queue-send]')
    if (sendBtn) {
      const id = sendBtn.dataset.queueSend
      const idx = _messageQueue.findIndex(m => m.id === id)
      if (idx === -1) return
      const item = _messageQueue.splice(idx, 1)[0]
      renderQueue()
      if (_isStreaming) stopStreaming()
      setTimeout(() => sendMessageDirect(item.text), 150)
      return
    }
    // 删除
    const delBtn = e.target.closest('[data-queue-del]')
    if (delBtn) {
      const id = delBtn.dataset.queueDel
      _messageQueue = _messageQueue.filter(m => m.id !== id)
      renderQueue()
      return
    }
    // 编辑（点击文字或编辑按钮）
    const editTarget = e.target.closest('[data-queue-edit]') || e.target.closest('[data-queue-edit-btn]')
    if (editTarget) {
      const id = editTarget.dataset.queueEdit || editTarget.dataset.queueEditBtn
      const item = _messageQueue.find(m => m.id === id)
      if (!item) return
      const queueItem = _queueEl.querySelector(`[data-queue-id="${id}"]`)
      if (!queueItem || queueItem.classList.contains('editing')) return
      queueItem.classList.add('editing')
      const textEl = queueItem.querySelector('.ast-queue-text')
      const input = document.createElement('textarea')
      input.className = 'ast-queue-edit-input'
      input.value = item.text
      input.rows = 1
      textEl.replaceWith(input)
      input.focus()
      input.style.height = Math.min(input.scrollHeight, 100) + 'px'
      // 保存编辑
      const save = () => {
        const newText = input.value.trim()
        if (newText) item.text = newText
        renderQueue()
      }
      input.addEventListener('blur', save)
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save() }
        if (ev.key === 'Escape') renderQueue()
      })
      input.addEventListener('input', () => {
        input.style.height = 'auto'
        input.style.height = Math.min(input.scrollHeight, 100) + 'px'
      })
    }
  })

  // 侧边栏切换
  page.querySelector('#ast-btn-toggle').addEventListener('click', () => {
    page.querySelector('#ast-sidebar').classList.toggle('open')
  })

  // 新建会话
  page.querySelector('#ast-btn-new').addEventListener('click', () => {
    createSession()
    renderSessionList()
    renderMessages()
  })

  // 模式切换
  page.querySelector('#ast-mode-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.ast-mode-btn')
    if (!btn) return
    const modeKey = btn.dataset.mode
    if (!MODES[modeKey] || modeKey === currentMode()) return
    _config.mode = modeKey
    saveConfig()
    page.querySelectorAll('.ast-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === modeKey))
    applyModeStyle(page, modeKey)
    playModeTransition(page, modeKey)
  })

  // 设置
  page.querySelector('#ast-btn-settings').addEventListener('click', showSettings)

  // 会话列表事件委托
  _sessionListEl.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-delete]')
    if (deleteBtn) {
      e.stopPropagation()
      const id = deleteBtn.dataset.delete
      showConfirm('确定删除这个会话吗？').then(ok => {
        if (!ok) return
        deleteSession(id)
        renderSessionList()
        renderMessages()
      })
      return
    }
    const item = e.target.closest('.ast-session-item')
    if (item) {
      _currentSessionId = item.dataset.id
      renderSessionList()
      renderMessages()
      // 切换到正在流式的会话时，启动刷新
      if (_isStreaming && getSessionStatus(_currentSessionId) === 'streaming') {
        startStreamRefresh()
      } else {
        stopStreamRefresh()
      }
    }
  })

  // 欢迎页技能卡片 & 快捷按钮委托
  _messagesEl.addEventListener('click', (e) => {
    const skillCard = e.target.closest('.ast-skill-card')
    if (skillCard) {
      const skill = BUILTIN_SKILLS.find(s => s.id === skillCard.dataset.skill)
      if (!skill) return

      // 技能需要工具 → 自动切换到执行模式（如果当前是聊天模式）
      if (skill.tools.length > 0 && currentMode() === 'chat') {
        _config.mode = 'execute'
        saveConfig()
        page.querySelectorAll('.ast-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'execute'))
        toast('已自动切换到执行模式', 'info')
      }

      sendMessage(skill.prompt)
      return
    }

    const quickBtn = e.target.closest('.ast-quick-btn')
    if (quickBtn) {
      const prompt = quickBtn.dataset.prompt
      if (prompt) sendMessage(prompt)
    }
  })

  return page
}

function autoResize(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
}

export function cleanup() {
  flushSave()
  stopStreaming()
  stopStreamRefresh()
  _pendingImages = []
  _page = null
  _messagesEl = null
  _queueEl = null
  _textarea = null
  _sendBtn = null
  _sessionListEl = null
}
