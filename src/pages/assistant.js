/**
 * AI 助手页面
 * 独立模型配置，不依赖 OpenClaw
 * 支持：流式响应、Markdown 渲染、会话管理、日志分析、上下文注入
 */
import { renderMarkdown } from '../lib/markdown.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showConfirm } from '../components/modal.js'
import { api } from '../lib/tauri-api.js'
import { OPENCLAW_KB } from '../lib/openclaw-kb.js'
import { icon, statusIcon } from '../lib/icons.js'
import { QTCOOL, PROVIDER_PRESETS, API_TYPES as SHARED_API_TYPES, fetchQtcoolModels } from '../lib/model-presets.js'
import { t } from '../lib/i18n.js'
import { getActiveEngineId } from '../lib/engine-manager.js'
import { enhanceModelCallError } from '../lib/model-error-diagnosis.js'

// ── 常量 ──
const STORAGE_KEY = 'clawpanel-assistant'
const SESSIONS_KEY = 'clawpanel-assistant-sessions'
const MAX_SESSIONS = 50
const MAX_CONTEXT_TOKENS = 30 // 最近 N 条消息作为上下文

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
  chat:     { label: t('assistant.modeChat'), desc: t('assistant.modeChatDesc'), tools: false, readOnly: false, confirmDanger: true, accent: 'var(--text-secondary)' },
  plan:     { label: t('assistant.modePlan'), desc: t('assistant.modePlanDesc'), tools: true, readOnly: true, confirmDanger: true, accent: 'var(--info)' },
  execute:  { label: t('assistant.modeExecute'), desc: t('assistant.modeExecuteDesc'), tools: true, readOnly: false, confirmDanger: true, accent: 'var(--accent)' },
  unlimited:{ label: t('assistant.modeUnlimited'), desc: t('assistant.modeUnlimitedDesc'), tools: true, readOnly: false, confirmDanger: false, accent: 'var(--warning)' },
}
const DEFAULT_MODE = 'execute'

// ── API 类型（从共享模块导入）──
const API_TYPES = SHARED_API_TYPES

function normalizeApiType(raw) {
  const type = (raw || '').trim()
  if (type === 'anthropic' || type === 'anthropic-messages') return 'anthropic-messages'
  if (type === 'google-gemini' || type === 'google-generative-ai') return 'google-generative-ai'
  if (type === 'ollama') return 'ollama'
  if (type === 'openai' || type === 'openai-completions' || type === 'openai-responses') return 'openai-completions'
  return 'openai-completions'
}

function requiresApiKey(apiType) {
  const type = normalizeApiType(apiType)
  return type === 'anthropic-messages' || type === 'google-generative-ai'
}

function apiHintText(apiType) {
  return {
    'openai-completions': t('assistant.apiHintOpenai'),
    'anthropic-messages': t('assistant.apiHintAnthropic'),
    'google-generative-ai': t('assistant.apiHintGemini'),
    'ollama': 'Ollama 原生 API，baseUrl 填 http://127.0.0.1:11434（不需要 /v1）',
  }[normalizeApiType(apiType)] || t('assistant.apiHintOpenai')
}

function apiBasePlaceholder(apiType) {
  return {
    'openai-completions': t('assistant.apiBasePlaceholderOpenai'),
    'anthropic-messages': 'https://api.anthropic.com',
    'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
    'ollama': 'http://127.0.0.1:11434',
  }[normalizeApiType(apiType)] || 'https://api.openai.com/v1'
}

function apiKeyPlaceholder(apiType) {
  return {
    'openai-completions': t('assistant.apiKeyPlaceholderOpenai'),
    'anthropic-messages': 'sk-ant-...',
    'google-generative-ai': 'AIza...',
    'ollama': 'ollama-local',
  }[normalizeApiType(apiType)] || 'sk-...'
}

// ── 系统提示词 ──
const DEFAULT_NAME = t('assistant.defaultName')
const DEFAULT_PERSONALITY = t('assistant.defaultPersonality')

function getSystemPromptBase() {
  const name = _config?.assistantName || DEFAULT_NAME
  const personality = _config?.assistantPersonality || DEFAULT_PERSONALITY
  return `你是「${name}」，ClawPanel 内置的 AI 智能助手。

## 你的性格
${personality}

## 你是谁
- 你是 ClawPanel 内置的智能助手
- 你帮助用户管理和排障 OpenClaw AI Agent 平台
- 你精通 OpenClaw 的架构、配置、Gateway、Agent 管理等所有方面
- 你善于分析日志、诊断错误、提供解决方案

## 相关资源
- **ClawPanel 官网**: https://claw.qt.cool
- **GitHub**: https://github.com/qingchencloud
- **开源项目**:
  - **ClawPanel** — OpenClaw 可视化管理面板（Tauri v2）
  - **OpenClaw 汉化版** — AI Agent 平台中文版，npm install -g @qingchencloud/openclaw-zh

## ClawPanel 是什么
- OpenClaw 的可视化管理面板，基于 Tauri v2 的跨平台桌面应用（Windows/macOS/Linux）
- 支持仪表盘监控、模型配置、Agent 管理、实时聊天、记忆文件管理、AI 助手工具调用等
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

### Skills 管理
- openclaw skills list — 列出所有 Skills 及其状态
- openclaw skills info <name> — 查看某个 Skill 详情
- openclaw skills check — 检查所有 Skills 的依赖是否满足
- Skill 依赖安装: 根据 install spec 执行 brew/npm/go/uv 安装缺少的命令行工具
- SkillHub: 技能商店，可搜索和安装新 Skill（内置 HTTP，不依赖 CLI）
- Skills 目录: 捆绑 Skills 在 openclaw 安装包内，自定义 Skills 通常位于 ~/.openclaw/skills/<name>/ 或 ~/.claude/skills/<name>/

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
- **ClawPanel**: 从 https://github.com/qingchencloud/clawpanel/releases 下载
- **更多项目**: 访问 https://github.com/qingchencloud

## 社区贡献指引
当用户发现 Bug 或有改进建议时，你应该主动引导用户参与开源贡献：

### 提交 Issue
引导用户到对应仓库提交 Issue，帮用户整理好格式：
- **ClawPanel**: https://github.com/qingchencloud/clawpanel/issues/new
- **OpenClaw 汉化版**: https://github.com/qingchencloud/openclaw-zh/issues/new

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
  skills: [
    {
      type: 'function',
      function: {
        name: 'skills_list',
        description: '列出所有 OpenClaw Skills 及其状态（可用/缺依赖/已禁用）。返回每个 Skill 的名称、描述、来源、依赖状态、缺少的依赖项、可用的安装选项等信息。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skills_info',
        description: '查看指定 Skill 的详细信息，包括描述、来源、依赖要求、缺少的依赖、安装选项等。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill 名称，如 github、weather、coding-agent' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skills_check',
        description: '检查所有 Skills 的依赖状态，返回哪些可用、哪些缺少依赖、哪些已禁用的汇总信息。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skills_install_dep',
        description: '安装 Skill 缺少的依赖。根据 Skill 的 install spec 执行对应的包管理器命令（brew/npm/go/uv）。安装完成后会自动生效。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['brew', 'node', 'go', 'uv'], description: '安装类型' },
            spec: {
              type: 'object',
              description: '安装参数。brew 需要 formula，node 需要 package，go 需要 module，uv 需要 package。',
              properties: {
                formula: { type: 'string', description: 'Homebrew formula 名称' },
                package: { type: 'string', description: 'npm 或 uv 包名' },
                module: { type: 'string', description: 'Go module 路径' },
              },
            },
          },
          required: ['kind', 'spec'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skillhub_search',
        description: '在 SkillHub 技能商店中搜索 Skills。返回匹配的 Skill 列表（slug 和描述）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skillhub_install',
        description: '从 SkillHub 技能商店安装一个 Skill 到本地自定义 Skills 目录（通常为 ~/.openclaw/skills/ 或 ~/.claude/skills/）。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'SkillHub 上的 Skill slug（名称标识）' },
          },
          required: ['slug'],
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
const DANGEROUS_TOOLS = new Set(['run_command', 'write_file', 'skills_install_dep', 'skillhub_install'])

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
    name: t('assistant.skillCheckConfig'),
    desc: t('assistant.skillCheckConfigDesc'),
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
    name: t('assistant.skillDiagnoseGateway'),
    desc: t('assistant.skillDiagnoseGatewayDesc'),
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
    name: t('assistant.skillBrowseDir'),
    desc: t('assistant.skillBrowseDirDesc'),
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
    name: t('assistant.skillCheckEnv'),
    desc: t('assistant.skillCheckEnvDesc'),
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
    name: t('assistant.skillAnalyzeLogs'),
    desc: t('assistant.skillAnalyzeLogsDesc'),
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
    name: t('assistant.skillFixCommon'),
    desc: t('assistant.skillFixCommonDesc'),
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
    name: t('assistant.skillReportBug'),
    desc: t('assistant.skillReportBugDesc'),
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
`,
  },
  {
    id: 'pr-assistant',
    icon: icon('zap', 16),
    name: t('assistant.skillPrAssistant'),
    desc: t('assistant.skillPrAssistantDesc'),
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
  {
    id: 'skills-manager',
    icon: icon('box', 16),
    name: t('assistant.skillSkillsManager'),
    desc: t('assistant.skillSkillsManagerDesc'),
    tools: ['skills'],
    prompt: `请帮我管理 OpenClaw 的 Skills。

具体操作：
1. 调用 skills_list 获取所有 Skills 及其状态
2. 汇总展示：多少个可用、多少个缺依赖、多少个已禁用
3. 对于缺依赖的 Skills，列出每个缺少的依赖和对应的安装方法
4. 询问用户是否要安装某些缺少的依赖（用 ask_user 列出选项）
5. 如果用户选择安装，调用 skills_install_dep 执行安装
6. 安装完成后再次调用 skills_list 确认状态变化

注意：
- 安装依赖可能需要特定的包管理器（brew 仅限 macOS，Windows 用 npm/go 等）
- 先调用 get_system_info 判断操作系统，过滤出适合当前平台的安装选项
- 如果用户想从 SkillHub 搜索安装新 Skill，使用 skillhub_search 和 skillhub_install`,
  },
]

// ── Hermes 引擎专属 Skills ──
const HERMES_SKILLS = [
  {
    id: 'hermes-chat-terminal',
    icon: icon('terminal', 16),
    name: t('assistant.skillHermesChat'),
    desc: t('assistant.skillHermesChatDesc'),
    tools: ['terminal'],
    prompt: `请帮我在终端中启动 Hermes Agent 的交互式对话。

具体操作：
1. 调用 get_system_info 获取系统信息
2. 用 run_command 执行 \`hermes version\` 检查 Hermes 是否已安装
3. 如果已安装，告诉用户可以在终端中运行 \`hermes chat\` 开始对话
4. 如果未安装，引导用户使用 ClawPanel 的 Hermes Agent 安装向导完成安装`,
  },
  {
    id: 'hermes-diagnose',
    icon: icon('shield', 16),
    name: t('assistant.skillHermesDiagnose'),
    desc: t('assistant.skillHermesDiagnoseDesc'),
    tools: ['terminal', 'fileOps'],
    prompt: `请帮我诊断 Hermes Agent 的运行状态。

具体操作：
1. 调用 get_system_info 获取 OS 类型和主目录
2. 用 run_command 执行 \`hermes version\` 获取版本
3. 用 run_command 执行 \`hermes doctor\` 进行自诊断
4. 用 list_processes 检查 hermes/gateway 进程是否在运行
5. 用 check_port 检查端口 8642 是否在监听
6. 用 read_file 读取 ~/.hermes/config.yaml 检查配置
7. 给出诊断结论和修复建议`,
  },
  {
    id: 'hermes-config',
    icon: icon('wrench', 16),
    name: t('assistant.skillHermesConfig'),
    desc: t('assistant.skillHermesConfigDesc'),
    tools: ['fileOps'],
    prompt: `请帮我检查 Hermes Agent 的配置文件。

具体操作：
1. 调用 get_system_info 获取系统信息，确定主目录
2. 用 list_directory 查看 ~/.hermes/ 目录结构
3. 用 read_file 读取 ~/.hermes/config.yaml
4. 用 read_file 读取 ~/.hermes/.env（注意隐藏 API Key）
5. 分析配置内容，检查：
   - 模型配置是否正确
   - API Key 和 Base URL 是否设置
   - Gateway 端口配置
6. 给出配置健康度评估和改进建议`,
  },
  {
    id: 'hermes-browse-dir',
    icon: icon('folder', 16),
    name: t('assistant.skillHermesBrowseDir'),
    desc: t('assistant.skillHermesBrowseDirDesc'),
    tools: ['fileOps'],
    prompt: `请帮我浏览 Hermes Agent 的工作目录。

具体操作：
1. 调用 get_system_info 获取主目录路径
2. 用 list_directory 列出 ~/.hermes/ 根目录
3. 简要说明每个目录/文件的作用：
   - config.yaml: 全局配置
   - .env: 环境变量（API Key、Base URL 等）
   - sessions/: 对话会话记录
   - skills/: Skills 目录
   - logs/: 日志文件
   - cron/: 定时任务配置
4. 标注关键配置文件和常用路径`,
  },
  {
    id: 'hermes-upgrade',
    icon: icon('zap', 16),
    name: t('assistant.skillHermesUpgrade'),
    desc: t('assistant.skillHermesUpgradeDesc'),
    tools: ['terminal'],
    prompt: `请帮我升级 Hermes Agent 到最新版本。

具体操作：
1. 调用 get_system_info 获取系统信息
2. 用 run_command 执行 \`hermes version\` 获取当前版本
3. 引导用户使用 ClawPanel 的 Hermes Agent 升级功能
4. 提醒用户升级前先停止 Gateway：\`hermes gateway stop\`
5. 升级完成后建议重新启动 Gateway`,
  },
  {
    id: 'hermes-logs',
    icon: icon('clipboard', 16),
    name: t('assistant.skillHermesLogs'),
    desc: t('assistant.skillHermesLogsDesc'),
    tools: ['terminal', 'fileOps'],
    prompt: `请帮我分析 Hermes Agent 最近的日志。

具体操作：
1. 调用 get_system_info 获取主目录路径
2. 用 list_directory 查看 ~/.hermes/ 有哪些日志文件
3. 用 read_file 读取 ~/.hermes/gateway-run.log 和 ~/.hermes/gateway-err.log
4. 搜索 ERROR、WARN、fail、exception 等关键词
5. 分析错误原因，给出具体修复建议`,
  },
  {
    id: 'hermes-uninstall',
    icon: icon('trash', 16),
    name: t('assistant.skillHermesUninstall'),
    desc: t('assistant.skillHermesUninstallDesc'),
    tools: [],
    prompt: `请告诉我如何完全卸载 Hermes Agent。

卸载步骤：
1. 停止 Gateway：\`hermes gateway stop\`
2. 卸载 Hermes Agent：\`uv tool uninstall hermes-agent\`
3. 可选：删除配置目录 ~/.hermes/（Windows: %USERPROFILE%\\.hermes）
4. 可选：卸载 uv 包管理器

请详细说明每一步，并提醒用户备份重要数据。`,
  },
  {
    id: 'report-bug',
    icon: icon('bug', 16),
    name: t('assistant.skillReportBug'),
    desc: t('assistant.skillReportBugDesc'),
    tools: ['terminal', 'fileOps'],
    prompt: `我想反馈一个 Bug，请帮我整理成标准的 GitHub Issue。

具体操作：
1. 用 ask_user 工具询问我遇到了什么问题（如果我还没说的话）
2. 调用 get_system_info 获取系统环境信息
3. 用 run_command 收集：hermes version、node -v 等版本信息
4. 用 read_file 读取最近的错误日志（如有）
5. 按标准 Issue 模板整理：
   - **问题描述**（一句话）
   - **复现步骤**（1, 2, 3...）
   - **期望行为** / **实际行为**
   - **环境信息**（自动填充）
   - **相关日志**（如有）
6. 给出对应仓库的 Issue 链接：
   - ClawPanel: https://github.com/qingchencloud/clawpanel/issues/new
`,
  },
]

/** 根据当前引擎返回对应的技能列表 */
function getBuiltinSkills() {
  return getActiveEngineId() === 'hermes' ? HERMES_SKILLS : BUILTIN_SKILLS
}

function currentMode() {
  return MODES[_config?.mode] ? _config.mode : DEFAULT_MODE
}

function getEnabledTools() {
  const mode = MODES[currentMode()]
  if (!mode.tools) return [] // 聊天模式：无工具

  const tc = _config.tools || {}
  const tools = [...TOOL_DEFS.system, ...TOOL_DEFS.process, ...TOOL_DEFS.interaction]

  // 终端工具：受设置开关控制（优先级高于模式）
  if (tc.terminal !== false) tools.push(...TOOL_DEFS.terminal)

  // 联网搜索工具：受设置开关控制
  if (tc.webSearch !== false) tools.push(...TOOL_DEFS.webSearch)

  // 文件工具：受设置开关控制 + 规划模式排除写入
  if (tc.fileOps !== false) {
    if (mode.readOnly) {
      tools.push(...TOOL_DEFS.fileOps.filter(td => td.function.name !== 'write_file'))
    } else {
      tools.push(...TOOL_DEFS.fileOps)
    }
  }

  // Skills 管理工具：始终启用（规划模式下排除安装操作）
  if (mode.readOnly) {
    tools.push(...TOOL_DEFS.skills.filter(td => !['skills_install_dep', 'skillhub_install'].includes(td.function.name)))
  } else {
    tools.push(...TOOL_DEFS.skills)
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
  for (const s of getBuiltinSkills()) {
    prompt += `\n- **${s.name}**（${s.desc}）`
  }
  prompt += '\n\n当用户的需求匹配某个技能时，可以建议用户点击对应的技能卡片，或者你直接按技能的步骤操作。'

  // 注入内置知识库（仅 OpenClaw 模式）
  if (getActiveEngineId() !== 'hermes') {
    prompt += '\n\n' + OPENCLAW_KB
  }

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
    if (!home) throw new Error(t('assistant.errHomeUnavailable'))
    // default/main 使用 ~/.openclaw/workspace，其他使用 agents/{id}/workspace
    let ws
    if (agentId === 'default' || agentId === 'main') {
      ws = home + '/.openclaw/workspace'
    } else {
      ws = home + '/.openclaw/agents/' + agentId + '/workspace'
    }
    let wsExists = false
    try { await api.assistantListDir(ws); wsExists = true } catch {}
    if (!wsExists) throw new Error(t('assistant.errWorkspaceMissing', { agentId }))

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
    { name: 'SOUL.md', desc: t('assistant.soulFileSoul'), content: _soulCache.soul },
    { name: 'IDENTITY.md', desc: t('assistant.soulFileIdentity'), content: _soulCache.identity },
    { name: 'USER.md', desc: t('assistant.soulFileUser'), content: _soulCache.user },
    { name: 'AGENTS.md', desc: t('assistant.soulFileAgents'), content: _soulCache.agents },
    { name: 'TOOLS.md', desc: t('assistant.soulFileTools'), content: _soulCache.tools },
    { name: 'MEMORY.md', desc: t('assistant.soulFileMemory'), content: _soulCache.memory },
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
    <span>${t('assistant.soulLoaded', { loaded: loaded.length, total: stats.length, size: sizeStr })}</span>
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
        <span class="ast-soul-file-desc">${t('assistant.soulMemoryDaily')}</span>
      </div>
      <span class="ast-soul-file-size">${t('assistant.soulMemoryCount', { count: memCount })}</span>
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

  _queueEl.innerHTML = `<div class="ast-queue-header">${queueSvg} ${t('assistant.sendQueue')} (${_messageQueue.length})</div>` +
    _messageQueue.map((item, i) => `
      <div class="ast-queue-item" data-queue-id="${item.id}">
        <span class="ast-queue-num">${i + 1}</span>
        <span class="ast-queue-text" data-queue-edit="${item.id}" title="${t('assistant.clickToEdit')}">${escHtml(item.text)}</span>
        <div class="ast-queue-actions">
          <button class="ast-queue-btn edit" data-queue-edit-btn="${item.id}" title="${t('assistant.edit')}">${editSvg}</button>
          <button class="ast-queue-btn send" data-queue-send="${item.id}" title="${t('assistant.sendNow')}">${sendSvg}</button>
          <button class="ast-queue-btn delete" data-queue-del="${item.id}" title="${t('common.delete')}">${delSvg}</button>
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

// ── 本地文件路径检测（Fix #226）──
// 用于拦截用户意外粘贴/拖拽本地文件路径（而非图片内容本身）的场景
// 例如：C:\Users\x\img.png、/Users/x/img.png、file:///C:/img.png 等
// 这类字符串发送到 LLM 会触发 "Only base64/http/https URLs are supported" 错误
const LOCAL_PATH_PREFIX_RE = /^(?:[a-zA-Z]:[\\/]|\/(?:Users|home|mnt|media|opt|tmp|var|root)\/|file:\/\/)/i
// 匹配 markdown 图片语法中的本地路径：![alt](C:\...)、![alt](/Users/...)
const LOCAL_PATH_MD_IMG_RE = /!\[[^\]]*\]\((\s*(?:[a-zA-Z]:[\\/]|\/(?:Users|home|mnt|media|opt|tmp|var|root)\/|file:\/\/)[^)]+)\)/gi

function isLocalPathText(text) {
  if (!text) return false
  const trimmed = String(text).trim()
  if (!trimmed) return false
  // 多行粘贴：首行若匹配本地路径即视为路径
  const firstLine = trimmed.split(/\r?\n/)[0].trim()
  return LOCAL_PATH_PREFIX_RE.test(firstLine)
}

// 在发送给 LLM 之前清洗用户消息中的本地路径 markdown 图片引用
// LLM 不能访问本地文件，把路径替换为占位文本避免 API 报错
function sanitizeUserTextForApi(text) {
  if (!text || typeof text !== 'string') return text
  return text.replace(LOCAL_PATH_MD_IMG_RE, t('assistant.localPathSanitized'))
}

// ── 连续错误熔断（Fix #226）──
// 同一错误连续出现 N 次时暂停自动重试，引导用户检查配置，避免无限循环
const CIRCUIT_WINDOW_MS = 2 * 60 * 1000 // 2 分钟滑动窗口
const CIRCUIT_THRESHOLD = 3 // 同错误指纹出现 ≥3 次视为熔断打开
let _recentFailures = [] // [{ fp: string, ts: number }]

function _errorFingerprint(err) {
  const msg = String(err?.message || err || '').trim()
  if (!msg) return ''
  // 归一化：去掉变化的数字（时间戳/ID）、URL、多余空白，保留错误核心
  return msg
    .replace(/\d{3,}/g, 'N')
    .replace(/\bhttps?:\/\/\S+/gi, 'URL')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
}

function recordRequestFailure(err) {
  const fp = _errorFingerprint(err)
  if (!fp) return
  const now = Date.now()
  _recentFailures.push({ fp, ts: now })
  _recentFailures = _recentFailures.filter(f => now - f.ts < CIRCUIT_WINDOW_MS)
}

function isCircuitOpenFor(err) {
  const fp = _errorFingerprint(err)
  if (!fp) return false
  const now = Date.now()
  const matching = _recentFailures.filter(f => f.fp === fp && now - f.ts < CIRCUIT_WINDOW_MS)
  return matching.length >= CIRCUIT_THRESHOLD
}

function resetCircuit() {
  _recentFailures = []
}

// 创建错误重试栏（sendMessageDirect 和 retryAIResponse 共用）
// circuitOpen 为 true 时：禁用重试按钮、改用警告色 hint、点击重试时 toast 提示
function createRetryBar(session, circuitOpen) {
  const retryBar = document.createElement('div')
  retryBar.className = 'ast-retry-bar' + (circuitOpen ? ' ast-retry-bar-circuit' : '')
  const retrySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
  const continueSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
  const warnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  const hintText = circuitOpen ? t('assistant.retryCircuitHint') : t('assistant.retryHint')
  const hintIcon = circuitOpen ? warnSvg + ' ' : ''
  retryBar.innerHTML = `
    <button class="btn btn-sm btn-primary ast-btn-retry"${circuitOpen ? ' disabled aria-disabled="true"' : ''}>${retrySvg} ${t('assistant.retry')}</button>
    <button class="btn btn-sm btn-secondary ast-btn-continue">${continueSvg} ${t('assistant.continueInput')}</button>
    <span class="ast-retry-hint">${hintIcon}${hintText}</span>
  `
  retryBar.querySelector('.ast-btn-retry').addEventListener('click', (e) => {
    if (circuitOpen) {
      e.preventDefault()
      toast(t('assistant.retryCircuitBlocked'), 'warn')
      return
    }
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
  return retryBar
}

// ── 图片附件 ──
const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB
const MAX_IMAGE_DIM = 2048 // 最大边长

function addImageFromFile(file) {
  if (!file.type.startsWith('image/')) return
  if (file.size > MAX_IMAGE_SIZE * 2) {
    toast(t('assistant.imageTooLarge'), 'error')
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
      <button class="ast-img-thumb-del" data-img-del="${img.id}" title="${t('common.delete')}">${delSvg}</button>
    </div>
  `).join('')
}

function clearPendingImages() {
  _pendingImages = []
  renderImagePreview()
}

// 构建多模态消息 content
function buildMessageContent(text, images) {
  // Fix #226: 清洗 markdown 图片语法中的本地路径（LLM 无法访问）
  const sanitizedText = sanitizeUserTextForApi(text)
  if (!images || images.length === 0) return sanitizedText
  const parts = []
  if (sanitizedText) parts.push({ type: 'text', text: sanitizedText })
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
  _config.apiType = normalizeApiType(_config.apiType)
  if (_config.autoRounds === undefined) _config.autoRounds = 8
  if (!Array.isArray(_config.knowledgeFiles)) _config.knowledgeFiles = []
  // #Compat-3 备用模型组：主模型失败时自动切换
  if (!Array.isArray(_config.fallbackModels)) _config.fallbackModels = []
  return _config
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_config))
  // Fix #226: 配置变更后重置熔断状态，让用户改了 API/模型/key 后能立刻重试
  resetCircuit()
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
    title: t('assistant.newSession'),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  _sessions.push(session)
  _currentSessionId = session.id
  saveSessions()
  // Fix #226: 新会话重置熔断状态，与旧会话的错误历史隔离
  resetCircuit()
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
  if (session.messages.length >= 1 && session.title === t('assistant.newSession')) {
    const firstUser = session.messages.find(m => m.role === 'user')
    if (firstUser) {
      const txt = firstUser._text || (typeof firstUser.content === 'string' ? firstUser.content : (firstUser.content?.find?.(p => p.type === 'text')?.text || t('assistant.imageMessage')))
      // 取第一行或前30字作为标题（跳过空行）
      const firstLine = txt.split('\n').find(l => l.trim()) || txt
      const title = firstLine.slice(0, 30) + (firstLine.length > 30 ? '...' : '')
      session.title = title
    }
  }
}

// ── AI API 调用（自动兼容 Chat Completions + Responses API）──

function cleanBaseUrl(raw, apiType) {
  let base = (raw || '').replace(/\/+$/, '')
  base = base.replace(/\/api\/chat\/?$/, '')
  base = base.replace(/\/api\/generate\/?$/, '')
  base = base.replace(/\/api\/tags\/?$/, '')
  base = base.replace(/\/api\/?$/, '')
  base = base.replace(/\/chat\/completions\/?$/, '')
  base = base.replace(/\/completions\/?$/, '')
  base = base.replace(/\/responses\/?$/, '')
  base = base.replace(/\/messages\/?$/, '')
  base = base.replace(/\/models\/?$/, '')
  const type = normalizeApiType(apiType || _config.apiType)
  if (type === 'anthropic-messages') {
    // Anthropic: https://api.anthropic.com/v1
    if (!base.endsWith('/v1')) base += '/v1'
    return base
  }
  if (type === 'google-gemini') {
    // Gemini: https://generativelanguage.googleapis.com/v1beta
    return base
  }
  if (/:(11434)$/i.test(base) && !base.endsWith('/v1')) return `${base}/v1`
  // 不再强制追加 /v1，尊重用户填写的 URL（火山引擎等第三方用 /v3 等路径）
  return base
}

function authHeaders(apiType, apiKey) {
  const type = normalizeApiType(apiType || _config.apiType)
  const key = apiKey || _config.apiKey || ''
  if (type === 'anthropic-messages') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (key) headers['x-api-key'] = key
    return headers
  }
  const headers = {
    'Content-Type': 'application/json',
  }
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

// 超时常量
const TIMEOUT_TOTAL = 120_000    // 总超时 120 秒
const TIMEOUT_CHUNK = 30_000     // 流式 chunk 间隔超时 30 秒
const TIMEOUT_CONNECT = 30_000   // 连接超时 30 秒

// #Compat-3: 收集所有可用的模型槽位（主模型 + 启用的备用模型）
// 返回 [{ label, baseUrl, apiKey, model, apiType, isPrimary }, ...]
function buildActiveSlots() {
  const slots = []
  // 主模型
  if (_config.baseUrl && _config.model) {
    slots.push({
      label: t('assistant.slotPrimary'),
      baseUrl: _config.baseUrl,
      apiKey: _config.apiKey || '',
      model: _config.model,
      apiType: normalizeApiType(_config.apiType),
      isPrimary: true,
    })
  }
  // 备用模型（仅保留必填字段齐全 + enabled 的）
  for (const fb of (_config.fallbackModels || [])) {
    if (!fb || fb.enabled === false) continue
    if (!fb.baseUrl || !fb.model) continue
    const apiType = normalizeApiType(fb.apiType)
    if (requiresApiKey(apiType) && !fb.apiKey) continue
    slots.push({
      label: fb.label || fb.model,
      baseUrl: fb.baseUrl,
      apiKey: fb.apiKey || '',
      model: fb.model,
      apiType,
      isPrimary: false,
    })
  }
  return slots
}

// #Compat-3: 判断错误是否应该触发 failover 切换到下一个槽位
// - AbortError（用户手动中止）→ 不切
// - 鉴权错误 401/403 → 不切（key 错了，切了也白切）
// - 其它（网络/超时/429/5xx/400 请求格式错误/模型不存在）→ 切
function isFailoverableError(err) {
  if (!err) return false
  if (err.name === 'AbortError') return false
  const msg = (err.message || '').toLowerCase()
  // 鉴权错误关键字：401/403/invalid api key/unauthorized/authentication
  if (/\b(401|403)\b/.test(msg)) return false
  if (/unauthorized|forbidden|invalid\s+api\s*key|authentication|api\s*key\s+(invalid|missing|expired)/i.test(msg)) return false
  return true
}

async function callAI(messages, onChunk) {
  const slots = buildActiveSlots()
  if (slots.length === 0) {
    throw new Error(t('assistant.errConfigFirst'))
  }

  let lastErr
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    try {
      await callAIWithSlot(slot, messages, onChunk)
      if (i > 0) {
        console.log(`[assistant] Failover 成功：已切换到备用模型「${slot.label}」`)
      }
      return
    } catch (err) {
      lastErr = err
      // 用户中止或鉴权错误：直接抛出，不 failover
      if (!isFailoverableError(err)) throw err
      // 最后一个槽位也失败了，抛出最终错误
      if (i >= slots.length - 1) throw err
      // 还有备用：通知用户并继续
      const nextSlot = slots[i + 1]
      const shortMsg = (err.message || '').slice(0, 80)
      console.warn(`[assistant] 模型「${slot.label}」失败（${shortMsg}），切换到备用：${nextSlot.label}`)
      onChunk(`\n\n> ${t('assistant.failoverNotice', { from: slot.label, to: nextSlot.label, err: shortMsg })}\n\n`)
    }
  }
  throw lastErr
}

// 用指定槽位发起一次请求（原 callAI 的内部实现；通过临时替换 _config 实现槽位隔离）
async function callAIWithSlot(slot, messages, onChunk) {
  const savedConfig = _config
  _config = {
    ..._config,
    baseUrl: slot.baseUrl,
    apiKey: slot.apiKey,
    model: slot.model,
    apiType: slot.apiType,
  }
  try {
    await _callAIOnce(messages, onChunk)
  } finally {
    _config = savedConfig
  }
}

async function _callAIOnce(messages, onChunk) {
  const apiType = normalizeApiType(_config.apiType)
  if (!_config.baseUrl || !_config.model || (requiresApiKey(apiType) && !_config.apiKey)) {
    throw new Error(t('assistant.errConfigFirst'))
  }

  const base = cleanBaseUrl(_config.baseUrl, apiType)
  _abortController = new AbortController()
  const allMessages = [{ role: 'system', content: buildSystemPrompt() }, ...messages]

  // 总超时保护
  let _timedOut = false
  const totalTimer = setTimeout(() => {
    _timedOut = true
    if (_abortController) _abortController.abort()
  }, TIMEOUT_TOTAL)

  try {
    if (apiType === 'anthropic-messages') {
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
        throw new Error(t('assistant.errTimeout', { seconds: TIMEOUT_TOTAL / 1000 }))
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
    // #Compat-5: 识别 vLLM/Ollama 等本地服务端的常见拒绝消息，附加修复指引
    throw new Error(enhanceModelCallError(errMsg))
  }

  // 检测响应是否为 SSE 流式
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    _lastDebugInfo.streaming = true
    let chunkCount = 0
    let contentChunks = 0
    let reasoningChunks = 0
    let reasoningBuf = ''
    let streamError = ''

    await readSSEStream(resp, (json) => {
      chunkCount++
      // 捕获流内错误事件（如模型不可用）
      if (json.error) {
        streamError = streamError || json.error?.message || json.error || ''
      }
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
    // 流式完成但没有任何内容 → 视为无效响应（防止空气泡）
    if (contentChunks === 0 && !reasoningBuf) {
      const errDetail = streamError || t('assistant.errInvalidResponse')
      console.warn('[assistant] SSE 流完成但 0 内容块:', errDetail)
      throw new Error(errDetail)
    }
  } else {
    // 非流式响应：API 忽略了 stream:true，直接返回完整 JSON
    _lastDebugInfo.streaming = false
    const json = await resp.json()
    _lastDebugInfo.responseBody = { id: json.id, model: json.model, object: json.object, usage: json.usage }
    console.log('[assistant] 非流式响应:', json)
    const msg = json.choices?.[0]?.message
    const content = msg?.content || msg?.reasoning_content || ''
    if (content) {
      onChunk(content)
    } else {
      // 尝试从 error 字段提取错误信息
      const errMsg = json.error?.message || json.choices?.[0]?.finish_reason || ''
      throw new Error(errMsg || t('assistant.errInvalidResponse'))
    }
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
    // #Compat-5: 识别本地服务端拒绝消息，附加修复指引
    throw new Error(enhanceModelCallError(errMsg))
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
    // #Compat-5: 识别本地服务端拒绝消息，附加修复指引
    throw new Error(enhanceModelCallError(errMsg))
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
    // #Compat-5: 识别本地服务端拒绝消息，附加修复指引
    throw new Error(enhanceModelCallError(errMsg))
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
        setTimeout(() => reject(new Error(t('assistant.errStreamTimeout'))), TIMEOUT_CHUNK)
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
    case 'skills_list': {
      const data = await api.skillsList()
      const skills = data?.skills || []
      const eligible = skills.filter(s => s.eligible && !s.disabled)
      const missing = skills.filter(s => !s.eligible && !s.disabled)
      const disabled = skills.filter(s => s.disabled)
      let summary = `共 ${skills.length} 个 Skills: ${eligible.length} 可用, ${missing.length} 缺依赖, ${disabled.length} 已禁用\n\n`
      if (eligible.length) summary += `## 可用 (${eligible.length})\n` + eligible.map(s => `- ${s.emoji || '📦'} **${s.name}**: ${s.description || ''}${s.bundled ? ' [捆绑]' : ''}`).join('\n') + '\n\n'
      if (missing.length) summary += `## 缺依赖 (${missing.length})\n` + missing.map(s => {
        const m = s.missing || {}
        const deps = [...(m.bins||[]), ...(m.env||[]).map(e=>'$'+e), ...(m.config||[])].join(', ')
        const installs = (s.install||[]).map(i => i.label).join(' / ')
        return `- ${s.emoji || '📦'} **${s.name}**: 缺少 ${deps}${installs ? ' → 可通过: ' + installs : ''}`
      }).join('\n') + '\n\n'
      if (disabled.length) summary += `## 已禁用 (${disabled.length})\n` + disabled.map(s => `- ${s.emoji || '📦'} **${s.name}**: ${s.description || ''}`).join('\n') + '\n'
      return summary
    }
    case 'skills_info':
      return JSON.stringify(await api.skillsInfo(args.name), null, 2)
    case 'skills_check':
      return JSON.stringify(await api.skillsCheck(), null, 2)
    case 'skills_install_dep': {
      const result = await api.skillsInstallDep(args.kind, args.spec)
      return result?.success ? `${t('assistant.toolInstallSuccess')}\n${result.output || ''}` : t('assistant.toolInstallFail')
    }
    case 'skillhub_search': {
      const items = await api.skillhubSearch(args.query)
      if (!items?.length) return t('assistant.toolNoSkillFound')
      return items.map(i => `- **${i.slug}**: ${i.description || i.summary || t('assistant.toolNoDesc')}`).join('\n')
    }
    case 'skillhub_install': {
      const result = await api.skillhubInstall(args.slug)
      return result?.success ? `Skill "${args.slug}" ${t('assistant.toolInstallSuccess')}\n${result.path || ''}` : t('assistant.toolInstallFail')
    }
    default:
      return `${t('assistant.toolUnknown')}: ${name}`
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
      ? `<textarea class="ast-ask-text" placeholder="${escHtml(placeholder || t('assistant.askPlaceholder'))}" rows="2"></textarea>`
      : ''

    const customHtml = type !== 'text' && options?.length
      ? `<div class="ast-ask-custom"><input type="text" class="ast-ask-custom-input" placeholder="${t('assistant.askCustomPlaceholder')}"></div>`
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
        <button class="ast-ask-submit btn btn-primary btn-sm">${t('assistant.askConfirm')}</button>
        <button class="ast-ask-skip btn btn-secondary btn-sm">${t('assistant.askSkip')}</button>
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
        answer = checked.join(', ') || t('assistant.askNotSelected')
      } else {
        // single
        const checked = card.querySelector('input[type="radio"]:checked')
        const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
        answer = custom || checked?.value || t('assistant.askNotSelected')
      }

      // 替换卡片为已回答状态
      card.innerHTML = `<div class="ast-ask-answered">
        <div class="ast-ask-question">${escHtml(question)}</div>
        <div class="ast-ask-answer">${icon('check', 14)} ${escHtml(answer)}</div>
      </div>`
      card.classList.add('answered')

      if (session) setSessionStatus(session.id, 'streaming')
      resolve(`User answer: ${answer}`)
    })

    // 跳过处理
    card.querySelector('.ast-ask-skip').addEventListener('click', () => {
      card.innerHTML = `<div class="ast-ask-answered">
        <div class="ast-ask-question">${escHtml(question)}</div>
        <div class="ast-ask-answer" style="color:var(--text-tertiary)">— ${t('assistant.askSkipped')}</div>
      </div>`
      card.classList.add('answered')
      if (session) setSessionStatus(session.id, 'streaming')
      resolve('User skipped this question')
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
    desc = `${t('assistant.confirmRunCmd')}:\n\n${args.command}${args.cwd ? '\n\n' + t('assistant.confirmCwd') + ': ' + args.cwd : ''}`
  } else if (name === 'write_file') {
    const preview = (args.content || '').slice(0, 200)
    desc = `${t('assistant.confirmWriteFile')}:\n${args.path}\n\n${t('assistant.confirmPreview')}:\n${preview}${(args.content || '').length > 200 ? '\n...(' + t('assistant.confirmTruncated') + ')' : ''}`
  }

  const prefix = critical
    ? '⛔ ' + t('assistant.confirmCritical') + '\n\n'
    : ''

  const session = getCurrentSession()
  if (session) setSessionStatus(session.id, 'waiting')
  const result = await showConfirm(`${prefix}${t('assistant.confirmAiRequest')}:\n\n${desc}\n\n${t('assistant.confirmAllow')}`)
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
    if (!approved) result = t('assistant.toolRejectedDanger')
  } else if (mode.confirmDanger && DANGEROUS_TOOLS.has(toolName)) {
    approved = await confirmToolCall(tcForConfirm || { function: { name: toolName, arguments: JSON.stringify(args) } })
    if (!approved) result = t('assistant.toolRejected')
  }
  if (approved) {
    try { result = await executeTool(toolName, args) }
    catch (err) { result = `${t('assistant.toolExecFail')}: ${typeof err === 'string' ? err : err.message || JSON.stringify(err)}` }
  }
  return { result, approved }
}

// 带工具调用的 AI 请求（流式，支持 tool_calls 循环 + 打字机效果）
async function callAIWithTools(messages, onStatus, onToolProgress, onChunk) {
  const apiType = normalizeApiType(_config.apiType)
  if (!_config.baseUrl || !_config.model || (requiresApiKey(apiType) && !_config.apiKey)) {
    throw new Error(t('assistant.errConfigFirst'))
  }

  const base = cleanBaseUrl(_config.baseUrl, apiType)
  const tools = getEnabledTools()
  let currentMessages = [{ role: 'system', content: buildSystemPrompt() }, ...messages]
  const toolHistory = []

  const autoRounds = _config.autoRounds ?? 8  // 0 = 无限制
  let nextPauseAt = autoRounds   // 下一次暂停的轮次阈值
  for (let round = 0; ; round++) {
    // 检查是否已被用户中止
    if (!_isStreaming || _abortController?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (autoRounds > 0 && round >= nextPauseAt) {
      const answer = await showAskUserCard({
        question: t('assistant.toolLoopQuestion', { round }),
        type: 'single',
        options: [t('assistant.toolLoopContinue', { rounds: autoRounds }), t('assistant.toolLoopNoBreak'), t('assistant.toolLoopRethink'), t('assistant.toolLoopStop')],
      })
      if (answer.includes(t('assistant.toolLoopStop')) || answer.includes('stop') || answer.includes('Stop')) {
        return { content: 'User requested to stop tool calls. Here is a summary of what has been done so far.', toolHistory }
      } else if (answer.includes(t('assistant.toolLoopRethink')) || answer.includes('rethink')) {
        currentMessages.push({ role: 'user', content: 'Please try a different approach to solve this problem. Do not repeat previously failed operations.' })
        nextPauseAt = round + autoRounds
      } else if (answer.includes(t('assistant.toolLoopNoBreak')) || answer.includes('no break')) {
        nextPauseAt = Infinity
      } else {
        nextPauseAt = round + autoRounds
      }
    }

    _abortController = new AbortController()
    onStatus(round === 0 ? t('assistant.aiThinking') : t('assistant.aiProcessingRound', { round: round + 1 }))

    // ── Anthropic 工具调用 ──
    if (apiType === 'anthropic-messages') {
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

    // ── OpenAI 工具调用（流式） ──
    const body = {
      model: _config.model,
      messages: currentMessages,
      temperature: _config.temperature || 0.7,
      stream: true,
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
      // #Compat-5: callAIWithTools 场景下 tools 带进 body 最容易踩 vLLM tool choice 限制，
      // 识别并给出启动参数指引，避免用户一脸懵
      throw new Error(enhanceModelCallError(errMsg))
    }

    // 流式累积状态
    let contentBuf = ''
    let reasoningBuf = ''
    let streamError = ''
    const pendingToolCalls = []   // [{ id, type, function: { name, arguments } }]
    let finishReason = ''

    const ct = resp.headers.get('content-type') || ''
    if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
      // ── SSE 流式解析 ──
      await readSSEStream(resp, (json) => {
        if (json.error) {
          streamError = streamError || json.error?.message || json.error || ''
        }
        const choice = json.choices?.[0]
        if (!choice) return
        if (choice.finish_reason) finishReason = choice.finish_reason

        const d = choice.delta
        if (!d) return

        // 累积 content → 打字机效果
        if (d.content) {
          contentBuf += d.content
          if (onChunk) onChunk(d.content)
        }

        // 累积 reasoning_content
        if (d.reasoning_content) {
          reasoningBuf += d.reasoning_content
        }

        // 累积 tool_calls 分块
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? pendingToolCalls.length
            if (!pendingToolCalls[idx]) {
              pendingToolCalls[idx] = {
                id: tc.id || '',
                type: tc.type || 'function',
                function: { name: '', arguments: '' },
              }
            }
            const slot = pendingToolCalls[idx]
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.function.name += tc.function.name
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
          }
          // 实时显示工具调用进度（显示已知名称）
          const names = pendingToolCalls.filter(t => t.function.name).map(t => t.function.name)
          if (names.length) {
            onStatus(t('assistant.aiCallingTools', { tools: names.join(', ') }) || `调用工具: ${names.join(', ')}`)
          }
        }
      }, _abortController?.signal)
    } else {
      // ── 非流式回退（API 忽略了 stream:true）──
      const data = await resp.json()
      const choice = data.choices?.[0]
      const msg = choice?.message
      if (!msg) {
        const errMsg = data.error?.message || ''
        throw new Error(errMsg || t('assistant.errInvalidResponse'))
      }
      finishReason = choice.finish_reason || ''
      contentBuf = msg.content || msg.reasoning_content || ''
      if (contentBuf && onChunk) onChunk(contentBuf)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          pendingToolCalls.push(tc)
        }
      }
    }

    // 流式完成但无任何内容且无工具调用 → 无效响应
    if (!contentBuf && !reasoningBuf && pendingToolCalls.length === 0) {
      throw new Error(streamError || t('assistant.errInvalidResponse'))
    }

    // 无 content 但有 reasoning → 作为回复
    if (!contentBuf && reasoningBuf && pendingToolCalls.length === 0) {
      contentBuf = reasoningBuf
      if (onChunk) onChunk(contentBuf)
    }

    // ── 处理工具调用 ──
    if (pendingToolCalls.length > 0) {
      // 构造完整 assistant message 用于上下文
      const assistantMsg = { role: 'assistant', content: contentBuf || null, tool_calls: pendingToolCalls }
      currentMessages.push(assistantMsg)

      for (const tc of pendingToolCalls) {
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

    return { content: contentBuf, toolHistory }
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
      <button class="ast-session-delete" data-delete="${s.id}" title="${t('assistant.deleteSession')}">×</button>
    </div>`
  }).join('') || '<div class="ast-empty">' + t('assistant.noSessions') + '</div>'
}

function renderToolBlocks(toolHistory) {
  if (!toolHistory || toolHistory.length === 0) return ''
  return toolHistory.map(tc => {
    // ask_user 工具不显示在工具块中（它有自己的交互卡片）
    if (tc.name === 'ask_user') return ''

    const tcIcon = { run_command: icon('terminal', 14), write_file: icon('edit', 14), read_file: icon('file', 14), list_directory: icon('folder', 14), get_system_info: icon('monitor', 14), list_processes: icon('list', 14), check_port: icon('plug', 14), skills_list: icon('box', 14), skills_info: icon('box', 14), skills_check: icon('box', 14), skills_install_dep: icon('download', 14), skillhub_search: icon('search', 14), skillhub_install: icon('download', 14) }[tc.name] || icon('wrench', 14)
    const label = { run_command: t('assistant.toolRunCmd'), read_file: t('assistant.toolReadFile'), write_file: t('assistant.toolWriteFile'), list_directory: t('assistant.toolListDir'), get_system_info: t('assistant.toolSysInfo'), list_processes: t('assistant.toolProcessList'), check_port: t('assistant.toolCheckPort'), skills_list: t('assistant.toolSkillsList'), skills_info: t('assistant.toolSkillInfo'), skills_check: t('assistant.toolSkillsCheck'), skills_install_dep: t('assistant.toolInstallDep'), skillhub_search: t('assistant.toolSkillHubSearch'), skillhub_install: t('assistant.toolSkillHubInstall') }[tc.name] || tc.name
    const argsStr = tc.name === 'run_command' ? escHtml(tc.args.command || '')
      : tc.name === 'read_file' ? escHtml(tc.args.path || '')
      : tc.name === 'write_file' ? escHtml(tc.args.path || '')
      : tc.name === 'list_directory' ? escHtml(tc.args.path || '')
      : tc.name === 'get_system_info' ? ''
      : tc.name === 'list_processes' ? escHtml(tc.args.filter || t('assistant.toolFilterAll'))
      : tc.name === 'check_port' ? escHtml(String(tc.args.port || ''))
      : tc.name === 'skills_info' ? escHtml(tc.args.name || '')
      : tc.name === 'skills_install_dep' ? escHtml(`${tc.args.kind}: ${tc.args.spec?.formula || tc.args.spec?.package || tc.args.spec?.module || ''}`)
      : tc.name === 'skillhub_search' ? escHtml(tc.args.query || '')
      : tc.name === 'skillhub_install' ? escHtml(tc.args.slug || '')
      : ['skills_list', 'skills_check'].includes(tc.name) ? ''
      : escHtml(JSON.stringify(tc.args))

    if (tc.pending) {
      return `<div class="ast-tool-block pending">
        <div class="ast-tool-summary">${tcIcon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status"><span class="ast-typing">${t('assistant.toolExecuting')}</span></span></div>
      </div>`
    }

    const statusClass = tc.approved === false ? 'denied' : 'ok'
    const statusLabel = tc.approved === false ? t('assistant.toolDenied') : t('assistant.toolDone')
    const resultPreview = (tc.result || '').length > 500 ? tc.result.slice(0, 500) + '...' : (tc.result || '')
    return `<details class="ast-tool-block ${statusClass}">
      <summary class="ast-tool-summary">${tcIcon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status">${statusLabel}</span></summary>
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
        <button class="btn-analyze">${t('assistant.errorAnalyze')}</button>
        <button class="btn-dismiss">${t('assistant.errorDismiss')}</button>
      </div>
    </div>
    ${ctx.hint ? `<div class="ast-error-banner-hint">${escHtml(ctx.hint)}</div>` : ''}
    ${ctx.error ? `
      <button class="ast-error-toggle">${t('assistant.errorShowLog')} ▼</button>
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
      toggleBtn.textContent = expanded ? t('assistant.errorHideLog') + ' ▲' : t('assistant.errorShowLog') + ' ▼'
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
    const skillCards = getBuiltinSkills().map(s => `
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
        <p>${t('assistant.welcomeText')}</p>
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
          : `<div class="ast-msg-img-loading" data-db-id="${img.dbId || ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>${escHtml(img.name || t('assistant.image'))}</span></div>`
      ).join('')}</div>` : ''
      return `<div class="ast-msg ast-msg-user" data-msg-idx="${idx}"><div class="ast-msg-bubble ast-msg-bubble-user">${imagesHtml}${textPart ? escHtml(textPart) : ''}</div><div class="ast-msg-meta"><button class="msg-copy-btn" title="${t('common.copy')}">${icon('copy', 12)}</button></div></div>`
    } else if (m.role === 'assistant') {
      // 跳过空的 AI 消息（历史脏数据），除非正在流式中（最后一条是占位符）
      const isLastMsg = idx === session.messages.length - 1
      if (!m.content && !m.toolHistory?.length && !(isLastMsg && _isStreaming)) return ''
      const toolHtml = renderToolBlocks(m.toolHistory)
      return `<div class="ast-msg ast-msg-ai" data-msg-idx="${idx}">${toolHtml}<div class="ast-msg-bubble ast-msg-bubble-ai">${renderMarkdown(m.content)}</div><div class="ast-msg-meta"><button class="msg-copy-btn" title="${t('common.copy')}">${icon('copy', 12)}</button></div></div>`
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
      img.alt = el.querySelector('span')?.textContent || t('assistant.image')
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

function _linkify(str) { return str.replace(/(https?:\/\/[^\s,，。；）)'"]+)/g, '<a href="$1" target="_blank" style="color:var(--primary)">$1</a>') }

function buildTestResult({ success, elapsed, usedApi, reqUrl, reqBody, respStatus, respHeaders, respBody, respRawHex, respByteCount, reply, error }) {
  let html = ''
  // 尝试解析 API 返回的错误信息
  let apiErrMsg = ''
  if (!success && respBody) {
    try {
      const errJson = JSON.parse(respBody)
      apiErrMsg = errJson.error?.message || errJson.message || ''
    } catch {}
  }
  // 状态行（加粗显示，区分成功/警告/失败）
  if (error) {
    html += `<div style="color:var(--error);font-weight:500">✗ ${t('assistant.testFailed')}: ${escHtml(error)}</div>`
  } else if (success) {
    html += `<div style="color:var(--success);font-weight:500">✓ ${t('assistant.testSuccess', { elapsed, api: usedApi })}</div>`
  } else {
    html += `<div style="color:var(--warning);font-weight:500">${statusIcon('warn', 14)} HTTP ${respStatus} — ${t('assistant.testNoReply')}</div>`
  }
  // API 错误信息（完整展示，URL 可点击）
  if (apiErrMsg) {
    html += `<div style="margin-top:6px;padding:8px 10px;background:var(--bg-tertiary);border-left:3px solid var(--warning);border-radius:4px;font-size:12px;color:var(--text-secondary);line-height:1.6;word-break:break-all">${_linkify(escHtml(apiErrMsg))}</div>`
  }
  // 解码失败时，显眼展示关键诊断信息：Content-Encoding 和字节数
  if (error && respHeaders) {
    const contentEncoding = respHeaders['content-encoding'] || respHeaders['Content-Encoding'] || '(未声明)'
    const contentType = respHeaders['content-type'] || respHeaders['Content-Type'] || '(未知)'
    html += `<div style="margin-top:6px;padding:8px 10px;background:var(--bg-tertiary);border-left:3px solid var(--error);border-radius:4px;font-size:11px;color:var(--text-secondary);line-height:1.7;font-family:var(--font-mono)">` +
      `<div style="color:var(--text-primary);font-weight:600;margin-bottom:4px;font-family:var(--font-sans)">🔍 诊断信息</div>` +
      `Content-Encoding: <strong style="color:var(--warning)">${escHtml(contentEncoding)}</strong><br>` +
      `Content-Type: ${escHtml(contentType)}<br>` +
      (respByteCount ? `响应字节数: ${respByteCount}` : '') +
      `</div>`
  }
  // 模型回复（完整展示，不截断；长回复给最大高度 + scroll）
  if (reply) {
    html += `<div style="margin-top:6px;padding:8px 10px;background:var(--bg-tertiary);border-left:3px solid var(--success);border-radius:4px;font-size:13px;color:var(--text-primary);line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto">` +
      `<div style="font-size:10px;color:var(--text-tertiary);margin-bottom:4px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase">${t('assistant.testModelReply')}</div>` +
      escHtml(reply) +
      `</div>`
  }
  // respBody 空但 reply 非空：明确诊断
  if (!respBody && reply) {
    html += `<div style="margin-top:6px;font-size:11px;color:var(--text-tertiary);font-style:italic;line-height:1.5">${escHtml(t('assistant.testRespBodyEmpty'))}</div>`
  }
  // 固定 prompt 脚注（用户知情权：测试的是预设请求，不是真实对话）
  html += `<div style="margin-top:8px;font-size:10px;color:var(--text-tertiary);opacity:0.7;line-height:1.4">📌 ${escHtml(t('assistant.testFixedPrompt'))}</div>`
  // 折叠的详细信息
  html += `<details style="margin-top:6px;font-size:11px"><summary style="cursor:pointer;color:var(--text-tertiary);user-select:none">${t('assistant.testShowDetails')}</summary>`
  html += `<div style="margin-top:4px;max-height:240px;overflow:auto;background:var(--bg-tertiary);border-radius:4px;padding:8px;font-family:var(--font-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">`
  html += `<strong>POST</strong> ${escHtml(reqUrl)}\n\n`
  html += `<strong>Request Body:</strong>\n${escHtml(JSON.stringify(reqBody, null, 2))}\n\n`
  html += `<strong>Response Status:</strong> ${respStatus}\n\n`
  // Response Headers（完整列出，每行一个）
  if (respHeaders && typeof respHeaders === 'object') {
    html += `<strong>Response Headers:</strong>\n`
    const entries = Object.entries(respHeaders)
    if (entries.length === 0) {
      html += `<span style="color:var(--text-tertiary);font-style:italic">(无)</span>\n\n`
    } else {
      html += entries.map(([k, v]) => `  ${escHtml(k)}: ${escHtml(String(v))}`).join('\n') + '\n\n'
    }
  }
  html += `<strong>Response Body:</strong>`
  if (respByteCount !== undefined && respByteCount !== null) {
    html += ` <span style="color:var(--text-tertiary);font-weight:normal">(${respByteCount} bytes)</span>`
  }
  html += `\n`
  // 美化 JSON（空串单独提示，避免误导为"empty"字面量）
  if (!respBody) {
    html += `<span style="color:var(--text-tertiary);font-style:italic">${escHtml(t('assistant.testRespBodyEmptyDetail'))}</span>`
  } else {
    try {
      html += escHtml(JSON.stringify(JSON.parse(respBody), null, 2))
    } catch {
      html += escHtml(respBody.slice(0, 4000))
    }
  }
  // Raw Bytes (hex)：UTF-8 解码失败时最关键的诊断信息
  if (respRawHex) {
    html += `\n\n<strong>Raw Bytes (前 200 字节 hex):</strong>\n<span style="color:var(--text-tertiary);font-size:10px">${escHtml(respRawHex)}</span>`
  }
  html += `</div></details>`
  return html
}

function showSettings() {
  const c = _config
  const isHermes = getActiveEngineId() === 'hermes'
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-title" style="margin-bottom:0">${c.assistantName || DEFAULT_NAME} — ${t('assistant.settings')}</div>
      <div class="ast-settings-tabs">
        <button class="ast-tab active" data-tab="api">${t('assistant.settingsTabApi')}</button>
        <button class="ast-tab" data-tab="tools">${t('assistant.settingsTabTools')}</button>
        <button class="ast-tab" data-tab="persona">${t('assistant.settingsTabPersona')}</button>
        <button class="ast-tab" data-tab="knowledge">${t('assistant.settingsTabKnowledge')}</button>
      </div>
      <div class="modal-body">
      <div class="ast-settings-form">
        <div class="ast-tab-panel active" data-panel="api">
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label">${t('assistant.quickSelect')}</label>
            <div id="ast-provider-presets" style="display:flex;flex-wrap:wrap;gap:6px">
              ${PROVIDER_PRESETS.filter(p => !p.hidden).map(p => `<button class="btn btn-sm btn-secondary ast-preset-btn" data-key="${p.key}" data-url="${escHtml(p.baseUrl)}" data-api="${p.api}" style="font-size:12px;padding:3px 10px">${p.label}${p.badge ? ' <span style="font-size:9px;background:var(--accent);color:#fff;padding:1px 4px;border-radius:6px;margin-left:3px">' + p.badge + '</span>' : ''}</button>`).join('')}
            </div>
            <div id="ast-preset-detail" style="display:none;margin-top:6px;padding:8px 12px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:12px"></div>
          </div>
          <div style="display:flex;gap:10px">
            <div class="form-group" style="flex:1">
              <label class="form-label">API Base URL</label>
              <input class="form-input" id="ast-baseurl" value="${escHtml(c.baseUrl)}" placeholder="${escHtml(apiBasePlaceholder(c.apiType))}">
            </div>
            <div class="form-group" style="width:170px">
              <label class="form-label">${t('assistant.apiType')}</label>
              <select class="form-input" id="ast-apitype">
                ${API_TYPES.map(t => `<option value="${t.value}" ${c.apiType === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1;margin-bottom:0">
              <label class="form-label">API Key</label>
              <input class="form-input" id="ast-apikey" type="password" value="${escHtml(c.apiKey)}" placeholder="${escHtml(apiKeyPlaceholder(c.apiType))}">
            </div>
            <div style="display:flex;gap:6px;padding-bottom:1px">
              <button class="btn btn-sm btn-secondary" id="ast-btn-test" title="${t('assistant.testConnTitle')}">${t('assistant.testBtn')}</button>
              <button class="btn btn-sm btn-secondary" id="ast-btn-models" title="${t('assistant.fetchModelsTitle')}">${t('assistant.fetchBtn')}</button>
              ${!isHermes ? `<button class="btn btn-sm btn-secondary" id="ast-btn-import" title="${t('assistant.importTitle')}">${icon('download', 14)} ${t('assistant.importBtn')}</button>` : ''}
            </div>
          </div>
          <div id="ast-test-result" style="margin:6px 0 2px;font-size:12px;min-height:16px"></div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1">
              <label class="form-label">${t('assistant.model')}</label>
              <div style="position:relative">
                <input class="form-input" id="ast-model" value="${escHtml(c.model)}" placeholder="gpt-4o / deepseek-chat" autocomplete="off">
                <div id="ast-model-dropdown" class="ast-model-dropdown" style="display:none"></div>
              </div>
            </div>
            <div class="form-group" style="width:80px">
              <label class="form-label">${t('assistant.temperature')}</label>
              <input class="form-input" id="ast-temp" type="number" value="${c.temperature || 0.7}" min="0" max="2" step="0.1">
            </div>
          </div>
          <div class="form-hint" id="ast-api-hint" style="margin-top:-4px">${apiHintText(c.apiType)}</div>

          <div id="ast-qtcool-promo" style="margin-top:14px;border-radius:var(--radius-lg);border:1px solid var(--border-primary);border-left:3px solid var(--primary);background:var(--bg-secondary);overflow:hidden">
            <div style="padding:14px 16px 12px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">
                <div>
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                    <span style="font-weight:700;font-size:var(--font-size-sm)">${icon('zap', 14)} ${t('assistant.qtcoolName')}</span>
                    <span style="font-size:10px;background:var(--primary);color:#fff;padding:1px 7px;border-radius:8px">${t('assistant.qtcoolRecommend')}</span>
                  </div>
                  <div style="font-size:11px;color:var(--text-tertiary);line-height:1.4">
                    ${t('assistant.qtcoolDesc')}
                  </div>
                </div>
                <a href="${QTCOOL.checkinUrl}" target="_blank" class="btn btn-primary btn-xs" style="flex-shrink:0">${icon('gift', 11)} ${t('assistant.qtcoolCheckin')}</a>
              </div>
              <div style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-bottom:8px">
                ${t('assistant.qtcoolInstructions')}
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
                <input class="form-input" id="ast-qtcool-key" placeholder="${t('assistant.qtcoolKeyPlaceholder')}" style="font-size:12px;padding:5px 10px;flex:1;min-width:120px">
                <input type="checkbox" id="ast-qtcool-customkey" style="display:none">
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <select id="ast-qtcool-model" class="form-input" style="font-size:12px;padding:5px 10px;min-width:130px;flex:1">
                  <option value="" disabled selected>${t('assistant.qtcoolLoadingModels')}</option>
                </select>
                <button class="btn btn-sm btn-secondary" id="ast-qtcool-test">${icon('search', 12)} ${t('assistant.testBtn')}</button>
                <button class="btn btn-sm btn-primary" id="ast-qtcool-apply">${icon('zap', 12)} ${t('assistant.qtcoolApply')}</button>
              </div>
              <div id="ast-qtcool-status" style="margin-top:8px;font-size:11px;min-height:16px;line-height:1.5"></div>
            </div>
            <div style="border-top:1px solid var(--border-primary);padding:6px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;background:var(--bg-tertiary)">
              ${!isHermes ? `<div style="display:flex;gap:8px;align-items:center">
                <button class="btn btn-xs btn-secondary" id="ast-qtcool-sync-to" title="${t('assistant.qtcoolSyncToTitle')}">${icon('upload', 11)} ${t('assistant.qtcoolSyncTo')}</button>
                <button class="btn btn-xs btn-secondary" id="ast-qtcool-sync-from" title="${t('assistant.qtcoolSyncFromTitle')}">${icon('download', 11)} ${t('assistant.qtcoolSyncFrom')}</button>
              </div>` : '<div></div>'}
              <a href="${QTCOOL.site}" target="_blank" style="color:var(--primary);text-decoration:none;font-size:11px">${icon('external-link', 11)} ${t('assistant.qtcoolLearnMore')}</a>
            </div>
          </div>

          <!-- #Compat-3: 备用模型组（重设计：极简一行 + 厂商预设快捷添加） -->
          <details class="ast-fallback-section" id="ast-fallback-section" ${(c.fallbackModels || []).length ? 'open' : ''} style="margin-top:14px">
            <summary style="cursor:pointer;padding:10px 14px;border-radius:var(--radius-md);background:var(--bg-secondary);border:1px solid var(--border-primary);display:flex;justify-content:space-between;align-items:center;gap:8px;list-style:none;user-select:none">
              <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
                <span style="font-weight:600;font-size:var(--font-size-sm)">${icon('shield', 13)} ${t('assistant.fallbackModelsTitle')}</span>
                <span style="font-size:11px;color:var(--text-tertiary);white-space:nowrap" id="ast-fallback-count">${(c.fallbackModels || []).filter(f => f && f.enabled !== false).length} ${t('assistant.fallbackEnabledSuffix')}</span>
              </div>
              <span class="ast-fallback-chevron" style="color:var(--text-tertiary);font-size:12px;transition:transform 0.2s">▼</span>
            </summary>
            <div style="padding:10px 4px 4px">
              <div class="form-hint" style="margin-bottom:10px">${t('assistant.fallbackModelsDesc')}</div>
              <!-- 主模型只读行（让用户看到完整调用链） -->
              <div id="ast-fallback-primary-row" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-tertiary);border:1px dashed var(--border-primary);border-radius:var(--radius-md);margin-bottom:6px;font-size:12px">
                <span style="font-size:14px">📌</span>
                <span style="color:var(--text-tertiary);white-space:nowrap">${t('assistant.fallbackPrimaryRow')}</span>
                <span id="ast-fallback-primary-model" style="flex:1;min-width:0;font-family:var(--font-mono);color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
                <span id="ast-fallback-primary-host" style="color:var(--text-tertiary);font-size:11px;white-space:nowrap"></span>
              </div>
              <!-- 备用列表 -->
              <div id="ast-fallback-list" style="display:flex;flex-direction:column;gap:4px"></div>
              <!-- 厂商预设快捷添加区 -->
              <div id="ast-fallback-add-area" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border-primary)">
                <div class="form-hint" style="margin-bottom:6px">${t('assistant.fallbackPickProviderHint')}</div>
                <div id="ast-fallback-presets" style="display:flex;flex-wrap:wrap;gap:6px"></div>
              </div>
            </div>
          </details>
        </div>
        <div class="ast-tab-panel" data-panel="tools">
          <div class="form-hint" style="margin-bottom:10px">${t('assistant.toolsHint')}</div>
          <label class="ast-switch-row">
            <span>${t('assistant.toolTerminal')} <span style="color:var(--text-tertiary);font-size:11px">— ${t('assistant.toolTerminalDesc')}</span></span>
            <input type="checkbox" id="ast-tool-terminal" ${c.tools?.terminal !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>${t('assistant.toolFileOps')} <span style="color:var(--text-tertiary);font-size:11px">— ${t('assistant.toolFileOpsDesc')}</span></span>
            <input type="checkbox" id="ast-tool-fileops" ${c.tools?.fileOps !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>${t('assistant.toolWebSearch')} <span style="color:var(--text-tertiary);font-size:11px">— ${t('assistant.toolWebSearchDesc')}</span></span>
            <input type="checkbox" id="ast-tool-websearch" ${c.tools?.webSearch !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color)">
            <div class="form-group" style="margin-bottom:4px">
              <label class="form-label">${t('assistant.autoRoundsLabel')} <span style="color:var(--text-tertiary);font-size:11px">— ${t('assistant.autoRoundsDesc')}</span></label>
              <select class="form-input" id="ast-auto-rounds" style="width:100%">
                <option value="0" ${(c.autoRounds ?? 8) === 0 ? 'selected' : ''}>∞ ${t('assistant.autoRoundsUnlimited')}</option>
                <option value="8" ${(c.autoRounds ?? 8) === 8 ? 'selected' : ''}>8 ${t('assistant.autoRoundsDefault')}</option>
                <option value="15" ${(c.autoRounds ?? 8) === 15 ? 'selected' : ''}>15 ${t('assistant.autoRoundsUnit')}</option>
                <option value="30" ${(c.autoRounds ?? 8) === 30 ? 'selected' : ''}>30 ${t('assistant.autoRoundsUnit')}</option>
                <option value="50" ${(c.autoRounds ?? 8) === 50 ? 'selected' : ''}>50 ${t('assistant.autoRoundsUnit')}</option>
              </select>
            </div>
            <div class="form-hint">${t('assistant.autoRoundsHint')}</div>
          </div>
          <div class="form-hint" style="margin-top:10px">${t('assistant.toolsAlwaysAvailable')}</div>
        </div>
        <div class="ast-tab-panel" data-panel="persona">
          ${!isHermes ? `<div class="form-group">
            <label class="form-label">${t('assistant.personaSource')}</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="default" ${!c.soulSource || c.soulSource === 'default' ? 'checked' : ''}>
                <span>${t('assistant.personaDefault')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="openclaw" ${c.soulSource?.startsWith('openclaw:') ? 'checked' : ''}>
                <span>${t('assistant.personaOpenClaw')} <span style="font-size:11px;color:var(--text-tertiary)">${t('assistant.personaOpenClawHint')}</span></span>
              </label>
            </div>
          </div>` : ''}
          <div id="ast-soul-default" style="${!isHermes && c.soulSource?.startsWith('openclaw:') ? 'display:none' : ''}">
            <div class="form-group">
              <label class="form-label">${t('assistant.personaName')}</label>
              <input class="form-input" id="ast-name" value="${escHtml(c.assistantName || DEFAULT_NAME)}" placeholder="${DEFAULT_NAME}">
            </div>
            <div class="form-group">
              <label class="form-label">${t('assistant.personaPersonality')}</label>
              <textarea class="form-input" id="ast-personality" rows="3" placeholder="${DEFAULT_PERSONALITY}" style="resize:vertical">${escHtml(c.assistantPersonality || DEFAULT_PERSONALITY)}</textarea>
              <div class="form-hint">${t('assistant.personaPersonalityHint')}</div>
            </div>
          </div>
          <div id="ast-soul-openclaw" style="${!isHermes && c.soulSource?.startsWith('openclaw:') ? '' : 'display:none'}">
            <div class="form-group" style="margin-top:4px">
              <label class="form-label">${t('assistant.personaSelectAgent')}</label>
              <div style="display:flex;gap:6px;align-items:center">
                <select class="form-input" id="ast-soul-agent" style="flex:1;font-family:var(--font-mono);font-size:13px">
                  <option value="" disabled>${t('assistant.personaScanning')}</option>
                </select>
                <button class="btn btn-sm btn-primary" id="ast-btn-load-soul" style="gap:4px;white-space:nowrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
                  ${t('assistant.personaLoadSoul')}
                </button>
                <button class="btn btn-sm btn-ghost" id="ast-btn-refresh-soul" style="gap:4px;white-space:nowrap" title="${t('assistant.personaRefreshTitle')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
              </div>
            </div>
            <div id="ast-soul-status" class="ast-soul-card" style="margin-top:8px">
              <div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">
                ${t('assistant.personaSoulHint')}
              </div>
            </div>
            <div class="form-hint" style="margin-top:8px">${t('assistant.personaSoulInherit')}</div>
          </div>
        </div>
        <div class="ast-tab-panel" data-panel="knowledge">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div class="form-hint" style="margin:0">${t('assistant.kbDesc')}</div>
            <button class="btn btn-sm btn-primary" id="ast-kb-add" style="gap:4px;white-space:nowrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              ${t('common.add')}
            </button>
          </div>
          <div id="ast-kb-editor" style="display:none;margin-bottom:10px">
            <div class="form-group" style="margin-bottom:6px">
              <input class="form-input" id="ast-kb-name" placeholder="${t('assistant.kbNamePlaceholder')}" style="font-size:13px">
            </div>
            <div class="form-group" style="margin-bottom:6px">
              <textarea class="form-input" id="ast-kb-content" rows="6" placeholder="${t('assistant.kbContentPlaceholder')}" style="resize:vertical;font-size:12px;font-family:var(--font-mono)"></textarea>
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-sm btn-secondary" id="ast-kb-cancel">${t('common.cancel')}</button>
              <button class="btn btn-sm btn-primary" id="ast-kb-save">${t('assistant.kbSave')}</button>
            </div>
          </div>
          <div class="ast-soul-card" id="ast-kb-list"></div>
          <div class="form-hint" style="margin-top:8px" id="ast-kb-hint"></div>
        </div>
      </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">${t('common.save')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  // #Compat-3: 备用模型草稿（编辑态）——保存时才写回 _config.fallbackModels
  const fallbackDrafts = JSON.parse(JSON.stringify(c.fallbackModels || []))
  const fallbackListEl = overlay.querySelector('#ast-fallback-list')
  const fallbackCountEl = overlay.querySelector('#ast-fallback-count')
  const updateFallbackCount = () => {
    if (!fallbackCountEl) return
    const n = fallbackDrafts.filter(f => f && f.enabled !== false && f.baseUrl && f.model).length
    fallbackCountEl.textContent = `${n} ${t('assistant.fallbackEnabledSuffix')}`
  }
  // #Compat-3: 重设计 —— 极简一行 + 厂商预设快捷添加
  const fallbackPrimaryModelEl = overlay.querySelector('#ast-fallback-primary-model')
  const fallbackPrimaryHostEl = overlay.querySelector('#ast-fallback-primary-host')
  const fallbackPresetsEl = overlay.querySelector('#ast-fallback-presets')
  // 从 baseUrl 提取 hostname 用于紧凑显示
  const hostOf = (url) => {
    try { return new URL(url).host } catch { return url || '' }
  }
  // 渲染主模型只读行（从当前表单读取，不从 _config）
  const renderPrimaryRow = () => {
    if (!fallbackPrimaryModelEl) return
    const model = overlay.querySelector('#ast-model')?.value?.trim() || ''
    const base = overlay.querySelector('#ast-baseurl')?.value?.trim() || ''
    fallbackPrimaryModelEl.textContent = model || t('assistant.fallbackUnnamedModel')
    fallbackPrimaryHostEl.textContent = base ? hostOf(base) : ''
  }
  const renderFallbackList = () => {
    if (!fallbackListEl) return
    if (fallbackDrafts.length === 0) {
      fallbackListEl.innerHTML = `<div class="form-hint" style="text-align:center;padding:12px 0;color:var(--text-tertiary);font-style:italic">${t('assistant.fallbackEmpty')}</div>`
      updateFallbackCount()
      return
    }
    fallbackListEl.innerHTML = fallbackDrafts.map((fb, idx) => {
      const expanded = fb._editing === true || (!fb.baseUrl && !fb.model)
      const modelText = fb.model || t('assistant.fallbackUnnamedModel')
      const hostText = fb.baseUrl ? hostOf(fb.baseUrl) : ''
      const brandText = fb._brandLabel ? `<span style="color:var(--primary);font-size:10px;padding:1px 5px;border:1px solid var(--primary);border-radius:3px;margin-right:4px">${escHtml(fb._brandLabel)}</span>` : ''
      return `
      <div class="ast-fallback-row" data-fb-idx="${idx}" draggable="true" style="border:1px solid var(--border-primary);border-radius:var(--radius-md);background:var(--bg-secondary);transition:border-color 0.15s">
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;user-select:none">
          <span class="ast-fb-handle" style="color:var(--text-tertiary);cursor:grab;font-size:13px;line-height:1" title="${t('assistant.dragHint')}">⋮⋮</span>
          <span style="color:var(--text-tertiary);font-size:11px;font-weight:500;min-width:22px">#${idx + 2}</span>
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden">
            ${brandText}
            <span style="font-family:var(--font-mono);font-size:12px;color:${fb.model ? 'var(--text-primary)' : 'var(--text-tertiary)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(modelText)}</span>
            ${hostText ? `<span style="color:var(--text-tertiary);font-size:11px;white-space:nowrap">·&nbsp;${escHtml(hostText)}</span>` : ''}
          </div>
          <button type="button" class="btn btn-xs btn-ghost ast-fb-toggle" style="padding:2px 8px;font-size:11px;color:var(--text-secondary)">${expanded ? t('assistant.fallbackHideAdvanced') : t('assistant.fallbackEditAdvanced')}</button>
          <button type="button" class="btn btn-xs btn-ghost ast-fb-remove" title="${t('assistant.fallbackRemove')}" style="padding:2px 6px;color:var(--error);font-size:12px">✕</button>
        </div>
        <div class="ast-fb-edit" style="display:${expanded ? 'block' : 'none'};padding:6px 10px 10px;border-top:1px dashed var(--border-primary)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
            <input class="form-input ast-fb-key" type="password" placeholder="${t('assistant.fallbackApiKeyPlaceholder')}" value="${escHtml(fb.apiKey || '')}" style="font-size:12px;padding:4px 8px">
            <input class="form-input ast-fb-model" placeholder="${t('assistant.fallbackModelPlaceholder')}" value="${escHtml(fb.model || '')}" style="font-size:12px;padding:4px 8px">
          </div>
          <details class="ast-fb-advanced" ${!fb.baseUrl || !API_TYPES.some(at => at.value === normalizeApiType(fb.apiType)) ? 'open' : ''} style="margin-top:4px">
            <summary style="cursor:pointer;font-size:11px;color:var(--text-tertiary);padding:2px 0;list-style:none">▸ ${t('assistant.fallbackShowAdvanced')}</summary>
            <div style="display:grid;grid-template-columns:1fr 140px;gap:6px;margin-top:6px">
              <input class="form-input ast-fb-url" placeholder="${t('assistant.fallbackBaseUrlPlaceholder')}" value="${escHtml(fb.baseUrl || '')}" style="font-size:12px;padding:4px 8px">
              <select class="form-input ast-fb-apitype" style="font-size:12px;padding:4px 8px">
                ${API_TYPES.map(at => `<option value="${at.value}" ${normalizeApiType(fb.apiType) === at.value ? 'selected' : ''}>${at.label}</option>`).join('')}
              </select>
            </div>
          </details>
        </div>
      </div>
    `}).join('')

    // 绑定事件
    fallbackListEl.querySelectorAll('.ast-fallback-row').forEach(row => {
      const idx = parseInt(row.dataset.fbIdx, 10)
      const sync = () => {
        fallbackDrafts[idx] = {
          ...fallbackDrafts[idx],
          baseUrl: (row.querySelector('.ast-fb-url')?.value || fallbackDrafts[idx].baseUrl || '').trim(),
          apiKey: (row.querySelector('.ast-fb-key')?.value || '').trim(),
          model: (row.querySelector('.ast-fb-model')?.value || '').trim(),
          apiType: normalizeApiType(row.querySelector('.ast-fb-apitype')?.value || fallbackDrafts[idx].apiType),
        }
        updateFallbackCount()
        // 实时更新折叠态显示的 model / hostname
        const headerModel = row.querySelector('div > span[style*="var(--font-mono)"]')
        if (headerModel) {
          const m = fallbackDrafts[idx].model
          headerModel.textContent = m || t('assistant.fallbackUnnamedModel')
          headerModel.style.color = m ? 'var(--text-primary)' : 'var(--text-tertiary)'
        }
      }
      row.querySelectorAll('.ast-fb-url, .ast-fb-key, .ast-fb-model, .ast-fb-apitype').forEach(el => {
        el.addEventListener('input', sync)
        el.addEventListener('change', sync)
      })
      // 展开 / 收起
      row.querySelector('.ast-fb-toggle').onclick = () => {
        fallbackDrafts[idx]._editing = !(fallbackDrafts[idx]._editing === true || (!fallbackDrafts[idx].baseUrl && !fallbackDrafts[idx].model))
        renderFallbackList()
      }
      // 删除
      row.querySelector('.ast-fb-remove').onclick = () => {
        fallbackDrafts.splice(idx, 1)
        renderFallbackList()
      }
      // HTML5 拖拽排序
      row.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', String(idx))
        e.dataTransfer.effectAllowed = 'move'
        row.style.opacity = '0.4'
      }
      row.ondragend = () => { row.style.opacity = '' }
      row.ondragover = (e) => { e.preventDefault(); row.style.borderColor = 'var(--primary)' }
      row.ondragleave = () => { row.style.borderColor = 'var(--border-primary)' }
      row.ondrop = (e) => {
        e.preventDefault()
        row.style.borderColor = 'var(--border-primary)'
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10)
        if (isNaN(from) || from === idx) return
        const [moved] = fallbackDrafts.splice(from, 1)
        fallbackDrafts.splice(idx, 0, moved)
        renderFallbackList()
      }
    })
    updateFallbackCount()
  }
  // 添加一个厂商预设备用（点击快捷按钮触发）
  const addFallbackFromPreset = (preset) => {
    fallbackDrafts.push({
      baseUrl: preset.baseUrl,
      apiKey: '',
      model: '',
      apiType: normalizeApiType(preset.api),
      _editing: true,
      _brandLabel: preset.label,
    })
    renderFallbackList()
    // 聚焦到刚加的 apiKey 输入
    setTimeout(() => {
      const last = fallbackListEl.querySelector('.ast-fallback-row:last-child .ast-fb-key')
      last?.focus()
    }, 30)
  }
  // 从主模型复制
  const addFallbackFromPrimary = () => {
    const baseUrl = overlay.querySelector('#ast-baseurl')?.value?.trim() || ''
    const apiKey = overlay.querySelector('#ast-apikey')?.value?.trim() || ''
    const model = overlay.querySelector('#ast-model')?.value?.trim() || ''
    const apiType = overlay.querySelector('#ast-apitype')?.value || 'openai-completions'
    fallbackDrafts.push({
      baseUrl,
      apiKey,
      model,
      apiType: normalizeApiType(apiType),
      _editing: true,
    })
    renderFallbackList()
    setTimeout(() => {
      const last = fallbackListEl.querySelector('.ast-fallback-row:last-child .ast-fb-model')
      last?.focus()
      last?.select()
    }, 30)
  }
  // 渲染厂商预设按钮（6 个最常用 + 从主模型复制 + 自定义 + 更多）
  const TOP_PRESETS = ['qtcool', 'openai', 'anthropic', 'deepseek', 'google', 'ollama']
  let showAllPresets = false
  const renderPresetButtons = () => {
    const shown = showAllPresets
      ? PROVIDER_PRESETS
      : PROVIDER_PRESETS.filter(p => TOP_PRESETS.includes(p.key))
    const presetBtnHtml = shown.map(p => `
      <button type="button" class="btn btn-xs btn-secondary ast-fb-preset-btn" data-preset-key="${p.key}" style="padding:4px 10px;font-size:11px;gap:4px">
        ${p.badge ? `<span style="color:var(--warning);font-size:9px;margin-right:2px">★</span>` : ''}
        ${escHtml(p.label)}
      </button>
    `).join('')
    const extraBtnHtml = `
      <button type="button" class="btn btn-xs btn-ghost" id="ast-fb-copy-primary" style="padding:4px 10px;font-size:11px;border:1px dashed var(--primary);color:var(--primary)">
        ${icon('copy', 11)} ${t('assistant.fallbackAddCopyPrimary')}
      </button>
      <button type="button" class="btn btn-xs btn-ghost" id="ast-fb-custom" style="padding:4px 10px;font-size:11px;border:1px dashed var(--border-primary);color:var(--text-secondary)">
        ${icon('plus', 11)} ${t('assistant.fallbackAddCustom')}
      </button>
      ${!showAllPresets ? `<button type="button" class="btn btn-xs btn-ghost" id="ast-fb-more" style="padding:4px 10px;font-size:11px;color:var(--text-tertiary)">${t('assistant.fallbackMoreProviders')}</button>` : ''}
    `
    fallbackPresetsEl.innerHTML = presetBtnHtml + extraBtnHtml

    // 绑定每个预设按钮
    fallbackPresetsEl.querySelectorAll('.ast-fb-preset-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = PROVIDER_PRESETS.find(p => p.key === btn.dataset.presetKey)
        if (preset) addFallbackFromPreset(preset)
      }
    })
    // 从主模型复制
    fallbackPresetsEl.querySelector('#ast-fb-copy-primary').onclick = addFallbackFromPrimary
    // 自定义（空白）
    fallbackPresetsEl.querySelector('#ast-fb-custom').onclick = () => {
      const mainApi = overlay.querySelector('#ast-apitype')?.value || 'openai-completions'
      fallbackDrafts.push({
        baseUrl: '',
        apiKey: '',
        model: '',
        apiType: normalizeApiType(mainApi),
        _editing: true,
      })
      renderFallbackList()
      setTimeout(() => {
        const last = fallbackListEl.querySelector('.ast-fallback-row:last-child .ast-fb-key')
        last?.focus()
      }, 30)
    }
    // 更多服务商（展开全部）
    fallbackPresetsEl.querySelector('#ast-fb-more')?.addEventListener('click', () => {
      showAllPresets = true
      renderPresetButtons()
    })
  }
  // 主模型表单任一字段变更时，同步主模型只读行
  ;['#ast-baseurl', '#ast-model', '#ast-apikey', '#ast-apitype'].forEach(sel => {
    overlay.querySelector(sel)?.addEventListener('input', renderPrimaryRow)
    overlay.querySelector(sel)?.addEventListener('change', renderPrimaryRow)
  })
  renderPrimaryRow()
  renderFallbackList()
  renderPresetButtons()

  // Tab 切换
  overlay.querySelectorAll('.ast-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.ast-tab').forEach(t => t.classList.remove('active'))
      overlay.querySelectorAll('.ast-tab-panel').forEach(p => p.classList.remove('active'))
      tab.classList.add('active')
      overlay.querySelector(`.ast-tab-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active')
    })
  })

  // 服务商快捷预设按钮
  const apiTypeSelect = overlay.querySelector('#ast-apitype')
  const apiHintEl = overlay.querySelector('#ast-api-hint')
  const baseUrlInput = overlay.querySelector('#ast-baseurl')
  const apiKeyInput = overlay.querySelector('#ast-apikey')
  overlay.querySelectorAll('.ast-preset-btn').forEach(btn => {
    btn.onclick = () => {
      baseUrlInput.value = btn.dataset.url
      apiTypeSelect.value = btn.dataset.api
      apiTypeSelect.dispatchEvent(new Event('change'))
      // 切换服务商时清空模型和下拉列表，让用户重新选择或拉取
      const modelInput = overlay.querySelector('#ast-model')
      const modelDropdown = overlay.querySelector('#ast-model-dropdown')
      if (modelInput) modelInput.value = ''
      if (modelDropdown) { modelDropdown.innerHTML = ''; modelDropdown.style.display = 'none' }
      // 高亮选中
      overlay.querySelectorAll('.ast-preset-btn').forEach(b => b.style.opacity = '0.5')
      btn.style.opacity = '1'
      // 显示服务商详情
      const preset = PROVIDER_PRESETS.find(p => p.key === btn.dataset.key)
      const detailEl = overlay.querySelector('#ast-preset-detail')
      if (detailEl && preset && (preset.desc || preset.site)) {
        let html = preset.desc ? `<div style="color:var(--text-secondary);line-height:1.5">${preset.desc}</div>` : ''
        if (preset.site) html += `<a href="${preset.site}" target="_blank" style="color:var(--accent);text-decoration:none;font-size:11px;margin-top:3px;display:inline-block">→ ${t('assistant.visitSite', { name: preset.label })}</a>`
        detailEl.innerHTML = html
        detailEl.style.display = 'block'
      } else if (detailEl) {
        detailEl.style.display = 'none'
      }
    }
  })

  // API 类型切换时更新提示文本和 placeholder
  apiTypeSelect.addEventListener('change', () => {
    const v = normalizeApiType(apiTypeSelect.value)
    apiHintEl.textContent = apiHintText(v)
    baseUrlInput.placeholder = apiBasePlaceholder(v)
    apiKeyInput.placeholder = apiKeyPlaceholder(v)
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
    agentSelect.innerHTML = '<option value="" disabled selected>' + t('assistant.personaScanning') + '</option>'
    agentSelect.disabled = true
    const agents = await scanOpenClawAgents()
    agentSelect.innerHTML = ''
    if (agents.length === 0) {
      agentSelect.innerHTML = '<option value="" disabled selected>' + t('assistant.personaNoAgent') + '</option>'
      agentSelect.disabled = true
      return
    }
    let currentId = _config.soulSource?.replace('openclaw:', '') || 'default'
    if (currentId === 'main') currentId = 'default'
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = a.label + (a.hasWorkspace ? '' : ' (' + t('assistant.personaNoWorkspace') + ')')
      if (!a.hasWorkspace) opt.disabled = true
      if (a.id === currentId) opt.selected = true
      agentSelect.appendChild(opt)
    }
    agentSelect.disabled = false
  }

  // 加载灵魂函数
  const doLoadSoul = async (btn) => {
    const selectedAgent = agentSelect.value
    if (!selectedAgent) { toast(t('assistant.personaSelectFirst'), 'warning'); return }
    const statusEl = overlay.querySelector('#ast-soul-status')
    const origHTML = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ast-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg> ' + t('assistant.loading')
    statusEl.innerHTML = `<div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">${t('assistant.personaLoadingAgent', { agent: selectedAgent })}</div>`

    const soul = await loadOpenClawSoul(selectedAgent)
    btn.disabled = false
    btn.innerHTML = origHTML

    if (!soul) {
      statusEl.innerHTML = `<div style="text-align:center;padding:16px 0"><div style="color:var(--error);font-size:12px;font-weight:500">${t('assistant.personaLoadFailed')}</div><div style="color:var(--text-tertiary);font-size:11px;margin-top:4px">${t('assistant.personaLoadFailedDetail', { agent: selectedAgent })}</div></div>`
      return
    }

    statusEl.innerHTML = renderSoulStats(soul)
  }

  overlay.querySelector('#ast-btn-load-soul').onclick = (e) => doLoadSoul(e.target.closest('button'))
  // 刷新按钮：重新扫描 Agent 列表
  overlay.querySelector('#ast-btn-refresh-soul').onclick = (e) => {
    refreshAgentList()
    overlay.querySelector('#ast-soul-status').innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">' + t('assistant.personaSoulHint') + '</div>'
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
        <div>${t('assistant.kbEmpty')}</div></div>`
      kbHintEl.textContent = ''
      return
    }
    const totalSize = kbFiles.reduce((s, f) => s + (f.content?.length || 0), 0)
    const sizeStr = totalSize > 1024 ? (totalSize / 1024).toFixed(1) + ' KB' : totalSize + ' B'
    const enabledCount = kbFiles.filter(f => f.enabled !== false).length
    kbHintEl.textContent = t('assistant.kbSummary', { total: kbFiles.length, enabled: enabledCount, size: sizeStr })
    let html = '<div class="ast-soul-files">'
    kbFiles.forEach((f, i) => {
      const fSize = f.content?.length > 1024 ? (f.content.length / 1024).toFixed(1) + ' KB' : (f.content?.length || 0) + ' B'
      const enabled = f.enabled !== false
      html += `<div class="ast-soul-file ${enabled ? 'loaded' : 'missing'}" data-kb-idx="${i}" style="cursor:pointer" title="${t('assistant.clickToEdit')}">
        <button style="padding:2px;background:none;border:none;cursor:pointer;flex-shrink:0" data-kb-toggle="${i}" title="${enabled ? t('assistant.kbClickDisable') : t('assistant.kbClickEnable')}">
          <div class="ast-soul-file-icon">${enabled ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>'}</div>
        </button>
        <div class="ast-soul-file-info">
          <span class="ast-soul-file-name">${escHtml(f.name)}</span>
          <span class="ast-soul-file-desc">${f.content?.split('\n').length || 0} ${t('assistant.kbLines')}</span>
        </div>
        <span class="ast-soul-file-size">${fSize}</span>
        <button class="btn btn-sm" style="padding:2px 6px;font-size:11px;color:var(--error);background:none;border:none;cursor:pointer" data-kb-del="${i}" title="${t('common.delete')}">✕</button>
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
      overlay.querySelector('#ast-kb-save').textContent = t('common.update')
    } else {
      overlay.querySelector('#ast-kb-name').value = ''
      overlay.querySelector('#ast-kb-content').value = ''
      overlay.querySelector('#ast-kb-save').textContent = t('assistant.kbSave')
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
    if (!name) { toast(t('assistant.kbNameRequired'), 'warning'); return }
    if (!content) { toast(t('assistant.kbContentRequired'), 'warning'); return }
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
  const qtcoolKeyInput = overlay.querySelector('#ast-qtcool-key')

  // 动态获取模型列表（共享逻辑）
  ;(async () => {
    const models = await fetchQtcoolModels()
    qtcoolModelSelect.innerHTML = models.map((m, i) =>
      `<option value="${m.id}" style="color:#333"${i === 0 ? ' selected' : ''}>${m.name || m.id}${i === 0 ? ' ★' : ''}</option>`
    ).join('')
  })()

  // key input is always visible now (no more built-in key)
  const qtcoolStatus = overlay.querySelector('#ast-qtcool-status')

  // 测试按钮：快速验证接口可用性
  overlay.querySelector('#ast-qtcool-test').onclick = async (e) => {
    const btn = e.target
    const selectedModel = qtcoolModelSelect.value
    if (!selectedModel) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} ${t('assistant.qtcoolSelectModel')}</span>`; return }
    const key = qtcoolKeyInput.value.trim()
    if (!key) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} ${t('assistant.qtcoolEnterKey')}</span>`; return }

    btn.disabled = true
    btn.textContent = t('assistant.testing')
    qtcoolStatus.innerHTML = `<span style="color:rgba(255,255,255,0.5)">${t('assistant.qtcoolConnecting')}</span>`
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
        qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} ${t('assistant.qtcoolTestPass', { time: (ms/1000).toFixed(1) })}</span><span style="color:rgba(255,255,255,0.4);margin-left:6px">${selectedModel} OK</span>`
      } else {
        const errText = await resp.text().catch(() => '')
        let errMsg = `HTTP ${resp.status}`
        try {
          const errJson = JSON.parse(errText)
          if (errJson.error?.message) errMsg = errJson.error.message
        } catch { if (errText) errMsg += ' — ' + errText.slice(0, 200) }
        // 将 URL 转为可点击链接
        const errHtml = errMsg.replace(/(https?:\/\/[^\s,，。）)]+)/g, '<a href="$1" target="_blank" style="color:var(--primary)">$1</a>')
        qtcoolStatus.innerHTML = `<div style="color:#f87171;line-height:1.5">${statusIcon('err', 14)} <strong>${t('assistant.qtcoolTestFail')}</strong></div><div style="color:var(--text-secondary);font-size:11px;line-height:1.5;margin-top:4px;word-break:break-all">${errHtml}</div>`
      }
    } catch (err) {
      qtcoolStatus.innerHTML = `<div style="color:#f87171">${statusIcon('err', 14)} ${t('assistant.qtcoolConnectFail')}: ${err.message}</div>`
    }
    btn.disabled = false
    btn.innerHTML = `${icon('search', 12)} ${t('assistant.testBtn')}`
  }

  // 一键接入：填充配置 + 提示设为 OpenClaw 主模型
  overlay.querySelector('#ast-qtcool-apply').onclick = async () => {
    const selectedModel = qtcoolModelSelect.value
    if (!selectedModel) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} ${t('assistant.qtcoolSelectModel')}</span>`; return }
    const key = qtcoolKeyInput.value.trim()
    if (!key) { qtcoolStatus.innerHTML = `<span style="color:#fbbf24">${statusIcon('warn', 14)} ${t('assistant.qtcoolEnterKey')}</span>`; return }

    // 1) 填充助手配置
    overlay.querySelector('#ast-baseurl').value = QTCOOL.baseUrl
    overlay.querySelector('#ast-apikey').value = key
    overlay.querySelector('#ast-model').value = selectedModel
    overlay.querySelector('#ast-apitype').value = 'openai-completions'
    qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} ${t('assistant.qtcoolConfigured', { model: selectedModel })}</span>`
    toast(t('assistant.qtcoolConfigured', { model: selectedModel }), 'success')

    // 2) 提示是否同步写入 OpenClaw 配置（设为主模型）
    const yes = await showConfirm(
      t('assistant.qtcoolSyncTitle'),
      t('assistant.qtcoolSyncDesc', { model: selectedModel }),
      { confirmText: t('assistant.qtcoolSetMain'), cancelText: t('assistant.qtcoolAssistantOnly') }
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
            models: [{ id: selectedModel, name: selectedModel, contextWindow: 128000, reasoning: selectedModel.includes('codex') }]
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
        qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} ${t('assistant.qtcoolSetMainDone', { model: selectedModel })}</span>`
        try {
          await api.restartGateway()
          toast(t('assistant.qtcoolMainSwitched', { model: selectedModel }), 'success')
          qtcoolStatus.innerHTML = `<span style="color:#34d399">${statusIcon('ok', 14)} ${t('assistant.qtcoolAllDone', { model: selectedModel })}</span>`
        } catch (e) {
          toast(humanizeError(e, t('assistant.qtcoolGatewayFail')), 'warning')
        }
      } catch (e) {
        toast(humanizeError(e, t('assistant.qtcoolWriteFail')), 'error')
      }
    }
  }

  // 同步到 OpenClaw：将助手的 baseUrl/apiKey/model 写入 openclaw.json
  overlay.querySelector('#ast-qtcool-sync-to')?.addEventListener('click', async () => {
    const baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    const apiKey = overlay.querySelector('#ast-apikey').value.trim()
    const model = overlay.querySelector('#ast-model').value.trim()
    if (!baseUrl || !apiKey || !model) {
      toast(t('assistant.qtcoolFillFirst'), 'warning')
      return
    }
    const yes = await showConfirm(
      t('assistant.qtcoolSyncTo'),
      t('assistant.qtcoolSyncToDesc', { model }),
      { confirmText: t('assistant.qtcoolConfirmSync'), cancelText: t('common.cancel') }
    )
    if (!yes) return
    try {
      let config = {}
      try { config = await api.readOpenclawConfig() } catch {}
      if (!config.models) config.models = {}
      if (!config.models.providers) config.models.providers = {}
      config.models.providers.qtcool = {
        baseUrl,
        apiKey,
        api: 'openai-completions',
        models: [{ id: model, name: model, contextWindow: 128000, reasoning: model.includes('codex') }]
      }
      if (!config.agents) config.agents = {}
      if (!config.agents.defaults) config.agents.defaults = {}
      if (!config.agents.defaults.model) config.agents.defaults.model = {}
      config.agents.defaults.model.primary = 'qtcool/' + model
      await api.writeOpenclawConfig(config)
      toast(t('assistant.qtcoolSyncToDone', { model }), 'success')
      try { await api.restartGateway() } catch {}
    } catch (e) {
      toast(humanizeError(e, t('assistant.qtcoolSyncFail')), 'error')
    }
  })

  // 从 OpenClaw 读取：将 openclaw.json 的 qtcool provider 配置填入助手
  overlay.querySelector('#ast-qtcool-sync-from')?.addEventListener('click', async () => {
    try {
      const config = await api.readOpenclawConfig()
      const qtProvider = config?.models?.providers?.qtcool
      if (!qtProvider?.baseUrl) {
        toast(t('assistant.qtcoolNoProvider'), 'info')
        return
      }
      const primary = config?.agents?.defaults?.model?.primary || ''
      const primaryModel = primary.startsWith('qtcool/') ? primary.slice(7) : ''
      const firstModel = (qtProvider.models || [])[0]
      const modelId = primaryModel || (typeof firstModel === 'string' ? firstModel : firstModel?.id) || ''
      const yes = await showConfirm(
        t('assistant.qtcoolSyncFrom'),
        t('assistant.qtcoolSyncFromDesc', { baseUrl: qtProvider.baseUrl, apiKey: qtProvider.apiKey ? '****' + qtProvider.apiKey.slice(-6) : '(—)', model: modelId }),
        { confirmText: t('assistant.qtcoolConfirmRead'), cancelText: t('common.cancel') }
      )
      if (!yes) return
      overlay.querySelector('#ast-baseurl').value = qtProvider.baseUrl
      if (qtProvider.apiKey) {
        overlay.querySelector('#ast-apikey').value = qtProvider.apiKey
        qtcoolKeyInput.value = qtProvider.apiKey
      }
      overlay.querySelector('#ast-apitype').value = qtProvider.api || 'openai-completions'
      if (modelId) overlay.querySelector('#ast-model').value = modelId
      toast(t('assistant.qtcoolSyncFromDone'), 'success')
    } catch (e) {
      toast(humanizeError(e, t('assistant.qtcoolReadFail')), 'error')
    }
  })

  const resultEl = overlay.querySelector('#ast-test-result')
  const modelInput = overlay.querySelector('#ast-model')
  const dropdown = overlay.querySelector('#ast-model-dropdown')

  // 测试对话：真实发一条消息，显示完整请求/响应参数
  overlay.querySelector('#ast-btn-test').onclick = async (e) => {
    const btn = e.target
    const baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    const apiKey = overlay.querySelector('#ast-apikey').value.trim()
    const model = overlay.querySelector('#ast-model').value.trim()
    const selApiType = normalizeApiType(overlay.querySelector('#ast-apitype').value || 'openai-completions')
    if (!baseUrl || (requiresApiKey(selApiType) && !apiKey)) {
      resultEl.innerHTML = '<span style="color:var(--warning)">' + escHtml(requiresApiKey(selApiType) ? t('assistant.testFillUrlKey') : t('assistant.testFillUrl')) + '</span>'
      return
    }
    if (!model) {
      resultEl.innerHTML = '<span style="color:var(--warning)">' + t('assistant.testFillModel') + '</span>'
      return
    }
    btn.disabled = true
    btn.textContent = t('assistant.testing')
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">' + t('assistant.testSending') + '</span>'

    // #Compat-1: 统一走 Rust reqwest（规避 webview fetch 的 status 0 / CORS 问题）
    // Web 模式走 dev-api 的 /__api/test_model_verbose，Tauri 模式走 invoke('test_model_verbose')
    try {
      const r = await api.testModelVerbose(baseUrl, apiKey, model, selApiType)
      resultEl.innerHTML = buildTestResult({
        success: !!r.success,
        elapsed: r.elapsedMs || 0,
        usedApi: r.usedApi || selApiType,
        reqUrl: r.reqUrl || baseUrl,
        reqBody: r.reqBody || {},
        respStatus: r.status ?? 0,
        respHeaders: r.respHeaders || null,
        respBody: r.respBody || '',
        respRawHex: r.respRawHex || '',
        respByteCount: r.respByteCount || 0,
        reply: r.reply || '',
        error: r.error || null,
      })
    } catch (err) {
      // Rust 命令本身失败（如 client 构造失败），或 Web 模式网络异常
      resultEl.innerHTML = buildTestResult({
        success: false,
        elapsed: 0,
        usedApi: selApiType,
        reqUrl: baseUrl,
        reqBody: {},
        respStatus: 0,
        respHeaders: null,
        respBody: '',
        respRawHex: '',
        respByteCount: 0,
        error: err?.message || String(err),
      })
    }
    btn.disabled = false
    btn.textContent = t('assistant.testBtn')
  }

  // 获取模型列表
  overlay.querySelector('#ast-btn-models').onclick = async (e) => {
    const btn = e.target
    const baseUrl = overlay.querySelector('#ast-baseurl').value.trim()
    const apiKey = overlay.querySelector('#ast-apikey').value.trim()
    const selApiType = normalizeApiType(overlay.querySelector('#ast-apitype').value || 'openai-completions')
    if (!baseUrl || (requiresApiKey(selApiType) && !apiKey)) {
      resultEl.innerHTML = '<span style="color:var(--warning)">' + escHtml(requiresApiKey(selApiType) ? t('assistant.testFillUrlKey') : t('assistant.testFillUrl')) + '</span>'
      return
    }
    btn.disabled = true
    btn.textContent = t('assistant.fetching')
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">' + t('assistant.fetchingModels') + '</span>'
    try {
      // 走 Rust 后端（桌面 & Web 模式统一），绕过 WebView CORS 限制
      // 部分 provider 不返回 CORS 头，直接前端 fetch 会报 Failed to fetch
      const models = await api.listRemoteModels(baseUrl, apiKey, selApiType)
      if (!models || models.length === 0) {
        resultEl.innerHTML = '<span style="color:var(--warning)">' + t('assistant.noModelsFound') + '</span>'
        return
      }
      resultEl.innerHTML = '<span style="color:var(--success)">✓ ' + t('assistant.modelsFound', { count: models.length }) + '</span>'
      dropdown.innerHTML = models.map(m =>
        '<div class="ast-model-option" data-model="' + escHtml(m) + '">' + escHtml(m) + '</div>'
      ).join('')
      dropdown.style.display = 'block'
    } catch (err) {
      const errStr = String(err?.message || err)
      // 服务商不支持 /models 接口 → 友好提示引导手动填写
      if (errStr.includes('[NOT_SUPPORTED]') || errStr.includes('不支持自动获取')) {
        resultEl.innerHTML = '<span style="color:var(--warning);line-height:1.5">⚠ ' + escHtml(t('assistant.fetchNotSupported')) + '</span>'
      } else {
        resultEl.innerHTML = '<span style="color:var(--error)">✗ ' + escHtml(errStr) + '</span>'
      }
    } finally {
      btn.disabled = false
      btn.textContent = t('assistant.fetchBtn')
    }
  }

  // 从 OpenClaw 导入模型配置（Hermes 模式下该按钮不存在）
  const importBtn = overlay.querySelector('#ast-btn-import')
  if (importBtn) importBtn.onclick = async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = t('assistant.personaScanning')
    resultEl.innerHTML = '<span style="color:var(--text-tertiary)">' + t('assistant.importScanning') + '</span>'

    try {
      const sysInfo = await api.assistantSystemInfo()
      const home = sysInfo.match(/主目录[:：]\s*(.+)/)?.[1]?.trim() || sysInfo.match(/Home[:：]\s*(.+)/)?.[1]?.trim() || ''
      if (!home) throw new Error('Cannot get home dir')

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
              if (p.baseUrl) {
                providers.push({
                  source: 'Agent: ' + agentId,
                  name: pid,
                  baseUrl: p.baseUrl,
                  apiKey: p.apiKey || '',
                  apiType: normalizeApiType(p.api),
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
          if (p.baseUrl && !providers.find(x => x.name === pid)) {
            providers.push({
              source: t('assistant.importGlobal'),
              name: pid,
              baseUrl: p.baseUrl,
              apiKey: p.apiKey || '',
              apiType: normalizeApiType(p.api),
              models: (p.models || []).map(m => m.id || m.name).filter(Boolean),
            })
          }
        }
      } catch {}

      if (providers.length === 0) {
        resultEl.innerHTML = '<span style="color:var(--warning)">' + t('assistant.importNoConfig') + '</span>'
        return
      }

      // 构建选择 UI
      const listHtml = providers.map((p, i) => {
        const modelsStr = p.models.length ? p.models.join(', ') : '(' + t('assistant.importNoModels') + ')'
        return `<div class="ast-import-option" data-idx="${i}" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:background 0.15s">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escHtml(p.name)}</strong>
            <span style="font-size:11px;color:var(--text-tertiary)">${escHtml(p.source)}</span>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${escHtml(p.baseUrl)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${t('assistant.model')}: ${escHtml(modelsStr)}</div>
        </div>`
      }).join('')

      resultEl.innerHTML = `<div style="margin-top:4px">
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">${t('assistant.importFound', { count: providers.length })}</div>
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
          resultEl.innerHTML = '<span style="color:var(--success)">✓ ' + t('assistant.importDone', { name: p.name, count: p.models.length }) + '</span>'
        })
      })

    } catch (err) {
      resultEl.innerHTML = '<span style="color:var(--error)">' + t('assistant.importFail') + ': ' + escHtml(err.message || String(err)) + '</span>'
    } finally {
      btn.disabled = false
      btn.innerHTML = `${icon('download', 14)} ${t('assistant.importBtn')}`
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
    _config.apiType = normalizeApiType(overlay.querySelector('#ast-apitype').value || 'openai-completions')
    // 工具开关
    _config.tools.terminal = overlay.querySelector('#ast-tool-terminal').checked
    _config.tools.fileOps = overlay.querySelector('#ast-tool-fileops').checked
    _config.tools.webSearch = overlay.querySelector('#ast-tool-websearch').checked
    _config.autoRounds = parseInt(overlay.querySelector('#ast-auto-rounds').value, 10) || 0
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
    // #Compat-3: 备用模型组（过滤空卡 + 迁移清理老的禁用条目）
    // 新 UI 不再暴露 enabled 开关（删除即停用），保存时：
    // - 过滤掉空卡（baseUrl 或 model 为空）
    // - 过滤掉老数据里 enabled===false 的条目（隐式迁移，用户以后看到的都是启用状态）
    // - strip 掉 _editing / _brandLabel 等临时字段（只挑 5 个字段 map 出来）
    _config.fallbackModels = fallbackDrafts
      .filter(f => f && f.baseUrl && f.model && f.enabled !== false)
      .map(f => ({
        label: f.label || f.model,
        baseUrl: f.baseUrl,
        apiKey: f.apiKey || '',
        model: f.model,
        apiType: normalizeApiType(f.apiType),
      }))
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
    toast(t('assistant.settingsSaved'), 'info')
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
      badge.textContent = t('assistant.notConfigured')
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
      toast(t('assistant.waitForReply'), 'info')
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
    if (_pendingImages.length > 0) { toast(t('assistant.waitForReplyShort'), 'info'); return }
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
  if (lastBubble) lastBubble.innerHTML = '<span class="ast-typing">' + t('assistant.aiThinking') + '</span>'

  const toolsEnabled = getEnabledTools().length > 0

  try {
    if (toolsEnabled) {
      // ── 工具模式：流式 + tool_calls 循环 ──
      const aiMsgContainers = _messagesEl?.querySelectorAll('.ast-msg-ai')
      const lastContainer = aiMsgContainers?.[aiMsgContainers.length - 1]

      const result = await callAIWithTools(contextMessages,
        // onStatus
        (status) => {
          if (lastBubble && !aiMsg.content) lastBubble.innerHTML = `<span class="ast-typing">${escHtml(status)}</span>`
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
        },
        // onChunk — 流式打字机效果（需从 container 重新查询 bubble，因为 onToolProgress 会替换 innerHTML）
        (chunk) => {
          aiMsg.content += chunk
          throttledSave()
          const bubble = lastContainer?.querySelector('.ast-msg-bubble-ai') || lastBubble
          if (bubble) {
            const now = Date.now()
            if (now - _lastRenderTime > 50) {
              bubble.innerHTML = renderMarkdown(aiMsg.content) + '<span class="ast-cursor">▊</span>'
              if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
              _lastRenderTime = now
            }
          }
        }
      )

      // result.content 可能在流式中已经通过 onChunk 累积到 aiMsg.content
      // 但如果有额外内容（如 reasoning 回退），以 result 为准
      if (result.content && !aiMsg.content) aiMsg.content = result.content
      if (result.toolHistory.length > 0) {
        aiMsg.toolHistory = result.toolHistory
      }
      const finalBubble = lastContainer?.querySelector('.ast-msg-bubble-ai') || lastBubble
      if (finalBubble && aiMsg.content) finalBubble.innerHTML = renderMarkdown(aiMsg.content)
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
      aiMsg.content += aiMsg.content ? '\n\n*[' + t('assistant.stopped') + ']*' : '*[' + t('assistant.stopped') + ']*'
    } else {
      setSessionStatus(session.id, 'error')
      // Fix #226: 记录错误用于熔断判断
      recordRequestFailure(err)
      // 保留已有内容，追加错误信息和重试按钮
      const errInfo = aiMsg.content
        ? `\n\n---\n**${t('assistant.requestInterrupted')}**: ${err.message}`
        : err.message
      aiMsg.content += errInfo
      aiMsg._canRetry = true
      aiMsg._circuitOpen = isCircuitOpenFor(err)
    }
    renderMessages()

    // 错误后插入重试按钮（circuit 打开时禁用并提示）
    if (aiMsg._canRetry && _messagesEl) {
      _messagesEl.appendChild(createRetryBar(session, !!aiMsg._circuitOpen))
      _messagesEl.scrollTop = _messagesEl.scrollHeight
    }
  } finally {
    _isStreaming = false
    _abortController = null
    stopStreamRefresh()
    if (_sendBtn) _sendBtn.innerHTML = sendIcon()
    if (_textarea) _textarea.focus()
    // 清理空的 AI 消息（防止持久化空气泡）
    const _lastMsg = session.messages[session.messages.length - 1]
    if (_lastMsg?.role === 'assistant' && !_lastMsg.content && !_lastMsg.toolHistory?.length) {
      session.messages.pop()
    }
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
  if (lastBubble) lastBubble.innerHTML = '<span class="ast-typing">' + t('assistant.retrying') + '</span>'

  const toolsEnabled = getEnabledTools().length > 0

  try {
    if (toolsEnabled) {
      const aiMsgContainers = _messagesEl?.querySelectorAll('.ast-msg-ai')
      const lastContainer = aiMsgContainers?.[aiMsgContainers.length - 1]

      const result = await callAIWithTools(contextMessages,
        (status) => { if (lastBubble && !aiMsg.content) lastBubble.innerHTML = `<span class="ast-typing">${escHtml(status)}</span>` },
        (history) => {
          aiMsg.toolHistory = history
          throttledSave()
          if (!lastContainer) return
          const toolHtml = renderToolBlocks(history)
          const bubble = lastContainer.querySelector('.ast-msg-bubble-ai')
          lastContainer.innerHTML = toolHtml + (bubble ? bubble.outerHTML : '')
          if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
        },
        // onChunk — 流式打字机效果（需从 container 重新查询 bubble）
        (chunk) => {
          aiMsg.content += chunk
          throttledSave()
          const bubble = lastContainer?.querySelector('.ast-msg-bubble-ai') || lastBubble
          if (bubble) {
            const now = Date.now()
            if (now - _lastRenderTime > 50) {
              bubble.innerHTML = renderMarkdown(aiMsg.content) + '<span class="ast-cursor">▊</span>'
              if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
              _lastRenderTime = now
            }
          }
        }
      )
      if (result.content && !aiMsg.content) aiMsg.content = result.content
      if (result.toolHistory.length > 0) aiMsg.toolHistory = result.toolHistory
      const retryFinalBubble = lastContainer?.querySelector('.ast-msg-bubble-ai') || lastBubble
      if (retryFinalBubble && aiMsg.content) retryFinalBubble.innerHTML = renderMarkdown(aiMsg.content)
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
      aiMsg.content += aiMsg.content ? '\n\n*[' + t('assistant.stopped') + ']*' : '*[' + t('assistant.stopped') + ']*'
    } else {
      setSessionStatus(session.id, 'error')
      // Fix #226: 记录错误用于熔断判断
      recordRequestFailure(err)
      aiMsg.content += aiMsg.content
        ? `\n\n---\n**${t('assistant.requestInterrupted')}**: ${err.message}`
        : err.message
      aiMsg._canRetry = true
      aiMsg._circuitOpen = isCircuitOpenFor(err)
    }
    renderMessages()

    if (aiMsg._canRetry && _messagesEl) {
      _messagesEl.appendChild(createRetryBar(session, !!aiMsg._circuitOpen))
      _messagesEl.scrollTop = _messagesEl.scrollHeight
    }
  } finally {
    _isStreaming = false
    _abortController = null
    stopStreamRefresh()
    if (_sendBtn) _sendBtn.innerHTML = sendIcon()
    if (_textarea) _textarea.focus()
    // 清理空的 AI 消息（防止持久化空气泡）
    const _retryLastMsg = session.messages[session.messages.length - 1]
    if (_retryLastMsg?.role === 'assistant' && !_retryLastMsg.content && !_retryLastMsg.toolHistory?.length) {
      session.messages.pop()
    }
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
    <button data-action="copy-text">${t('assistant.copyText')}</button>
    <button data-action="copy-md">${t('assistant.copyMd')}</button>
    <hr/>
    <button data-action="view-raw">${t('assistant.viewRaw')}</button>
    ${msg._debug ? '<button data-action="view-debug">' + t('assistant.viewDebug') + '</button>' : ''}
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
      navigator.clipboard.writeText(textContent).then(() => toast(t('assistant.copiedText')))
    } else if (action === 'copy-md') {
      navigator.clipboard.writeText(msg.content || textContent).then(() => toast(t('assistant.copiedMd')))
    } else if (action === 'view-raw') {
      const raw = { role: msg.role, content: msg.content, ts: msg.ts }
      if (msg._images) raw._images = msg._images.map(i => ({ dbId: i.dbId, name: i.name, width: i.width, height: i.height }))
      if (msg.toolHistory) raw.toolHistory = msg.toolHistory
      showDebugModal(t('assistant.rawData'), JSON.stringify(raw, null, 2))
    } else if (action === 'view-debug' && msg._debug) {
      showDebugModal(t('assistant.debugInfo'), JSON.stringify(msg._debug, null, 2))
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
        <button class="btn btn-sm btn-primary ast-debug-copy">${t('common.copy')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('.ast-debug-close').onclick = () => overlay.remove()
  overlay.querySelector('.ast-debug-copy').onclick = () => {
    navigator.clipboard.writeText(content).then(() => toast(t('common.copied')))
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

const AST_GUIDE_KEY = 'clawpanel-guide-assistant-dismissed'

function getAssistantGuideHtml() {
  if (localStorage.getItem(AST_GUIDE_KEY)) return ''
  return `
    <div class="ast-page-guide" id="ast-page-guide">
      <div class="ast-guide-badge">${t('assistant.guideTag')}</div>
      <div class="ast-guide-text">
        <b>${t('assistant.guideTitle')}</b>${t('assistant.guideDesc')}
        <span style="opacity:0.6">${t('assistant.guideHint')}</span>
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
        <span>${t('assistant.sessionList')}</span>
        <button class="ast-sidebar-btn" id="ast-btn-new" title="${t('assistant.newSession')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <div class="ast-session-list" id="ast-session-list"></div>
    </div>
    <div class="ast-main">
      <div class="ast-header">
        <div class="ast-header-left">
          <button class="ast-toggle-sidebar" id="ast-btn-toggle" title="${t('assistant.sessionList')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span class="ast-title">${_config?.assistantName || DEFAULT_NAME}</span>
          <span class="ast-model-badge ${_config.model ? 'configured' : 'unconfigured'}" id="ast-model-badge">${_config.model || t('assistant.notConfigured')}</span>
        </div>
        <div class="ast-header-actions">
          <div class="ast-mode-selector" id="ast-mode-selector">
            <div class="ast-mode-slider" id="ast-mode-slider"></div>
            ${Object.entries(MODES).map(([key, m]) => `<button class="ast-mode-btn ${currentMode() === key ? 'active' : ''}" data-mode="${key}" title="${m.desc}">${MODE_ICONS[key]} ${m.label}</button>`).join('')}
          </div>
          <button class="btn btn-sm btn-ghost" id="ast-btn-settings" title="${t('assistant.settingsTitle')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
            ${t('common.settings')}
          </button>
        </div>
      </div>
      <div class="ast-messages" id="ast-messages"></div>
      <div class="ast-queue" id="ast-queue"></div>
      <div class="ast-input-area">
        <div class="ast-image-preview" id="ast-image-preview"></div>
        <div class="ast-input-wrap">
          <button class="ast-attach-btn" id="ast-btn-attach" title="${t('assistant.uploadImage')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <input type="file" id="ast-file-input" accept="image/*" multiple style="display:none"/>
          <textarea class="ast-textarea" id="ast-textarea" placeholder="${t('assistant.inputPlaceholder')}" rows="1"></textarea>
          <button class="ast-send-btn" id="ast-send-btn" title="${t('assistant.send')}">${sendIcon()}</button>
        </div>
        <div class="ast-input-hint">${t('assistant.inputHint')}</div>
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

  // 复制按钮（事件委托）
  _messagesEl.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.msg-copy-btn')
    if (!copyBtn) return
    e.stopPropagation()
    const msgWrap = copyBtn.closest('.ast-msg')
    const bubble = msgWrap?.querySelector('.ast-msg-bubble')
    if (bubble) {
      const text = bubble.innerText || bubble.textContent || ''
      navigator.clipboard.writeText(text.trim()).then(() => {
        copyBtn.classList.add('copied')
        copyBtn.innerHTML = icon('check', 12)
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = icon('copy', 12) }, 1500)
      }).catch(() => {})
    }
  })

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

  // Enter 发送，Shift+Enter 换行；IME 选词中不发送
  _textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
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
    if (hasImage) { e.preventDefault(); return }
    // Fix #226: 拦截纯文本的本地文件路径粘贴（LLM 无法访问本地文件）
    const pastedText = e.clipboardData?.getData('text/plain') || ''
    if (isLocalPathText(pastedText)) {
      e.preventDefault()
      toast(t('assistant.localPathBlocked'), 'warn')
    }
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
    // Fix #226: 拖拽路径文本（而非图片文件）时拦截
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles || droppedFiles.length === 0) {
      const droppedText = e.dataTransfer?.getData('text/plain') || e.dataTransfer?.getData('text/uri-list') || ''
      if (isLocalPathText(droppedText)) {
        toast(t('assistant.localPathBlocked'), 'warn')
      }
      return
    }
    for (const file of droppedFiles) addImageFromFile(file)
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
      showConfirm(t('assistant.confirmDeleteSession')).then(ok => {
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
      const skill = getBuiltinSkills().find(s => s.id === skillCard.dataset.skill)
      if (!skill) return

      // 技能需要工具 → 自动切换到执行模式（如果当前是聊天模式）
      if (skill.tools.length > 0 && currentMode() === 'chat') {
        _config.mode = 'execute'
        saveConfig()
        page.querySelectorAll('.ast-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'execute'))
        toast(t('assistant.autoSwitchExecute'), 'info')
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
