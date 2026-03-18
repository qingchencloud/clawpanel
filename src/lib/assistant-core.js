/**
 * assistant-core.js
 * 模型调用与工具执行核心逻辑（无 UI 依赖）
 * 提供 buildSystemPrompt / getEnabledTools / callAIWithTools / callAI / trimContext
 */

// ── 常量 ──
const DEFAULT_NAME = '晴辰助手'
const DEFAULT_PERSONALITY = '专业、友善、简洁。善于分析问题，给出可操作的解决方案。'
const DEFAULT_MODE = 'execute'

const MODES = {
  chat:     { label: '聊天', desc: '纯对话，不调用任何工具', tools: false, readOnly: false, confirmDanger: true },
  plan:     { label: '规划', desc: '可调用工具分析，但不修改文件', tools: true, readOnly: true, confirmDanger: true },
  execute:  { label: '执行', desc: '完整工具权限，危险操作需确认', tools: true, readOnly: false, confirmDanger: true },
  unlimited:{ label: '无限', desc: '最大权限，工具调用无需确认', tools: true, readOnly: false, confirmDanger: false },
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
        name: 'skills_clawhub_search',
        description: '在 ClawHub 社区市场中搜索 Skills。返回匹配的 Skill 列表（slug 和描述）。',
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
        name: 'skills_clawhub_install',
        description: '从 ClawHub 社区市场安装一个 Skill 到本地 ~/.openclaw/skills/ 目录。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'ClawHub 上的 Skill slug（名称标识）' },
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

const INTERACTIVE_TOOLS = new Set(['ask_user'])
const DANGEROUS_TOOLS = new Set(['run_command', 'write_file', 'skills_install_dep', 'skills_clawhub_install'])
const CRITICAL_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]/i,
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\//i,
  /format\s+[a-zA-Z]:/i,
  /mkfs\./i,
  /dd\s+.*of=\/dev\//i,
  />\s*\/dev\/[sh]d/i,
  /DROP\s+(DATABASE|TABLE|SCHEMA)/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
  /:\(\){ :\|:& };/,
  /shutdown|reboot|init\s+[06]/i,
  /chmod\s+(-R\s+)?777\s+\//i,
  /chown\s+(-R\s+)?.*\s+\//i,
  /curl\s+.*\|\s*(sudo\s+)?bash/i,
  /wget\s+.*\|\s*(sudo\s+)?bash/i,
  /npm\s+publish/i,
  /git\s+push\s+.*--force/i,
]

// 内置 Skills（用于系统提示词）
const BUILTIN_SKILLS = [
  { id: 'check-config', name: '检查 OpenClaw 配置', desc: '读取并分析 openclaw.json，检查配置是否正确' },
  { id: 'diagnose-gateway', name: '诊断 Gateway', desc: '检查 Gateway 运行状态、端口、日志' },
  { id: 'browse-dir', name: '浏览配置目录', desc: '查看 .openclaw 目录结构和文件' },
  { id: 'check-env', name: '检查系统环境', desc: '检测 Node.js、npm 版本和系统信息' },
]

const STOP_PATTERNS = [/\<\s*stop\s*\>/ig]

function normalizeApiType(raw) {
  const type = (raw || '').trim()
  if (type === 'anthropic' || type === 'anthropic-messages') return 'anthropic-messages'
  if (type === 'google-gemini') return 'google-gemini'
  if (type === 'openai' || type === 'openai-completions' || type === 'openai-responses') return 'openai-completions'
  return 'openai-completions'
}

function requiresApiKey(apiType) {
  const type = normalizeApiType(apiType)
  return type === 'anthropic-messages' || type === 'google-gemini'
}

function apiHintText(apiType) {
  return {
    'openai-completions': '自动兼容 Chat Completions 和 Responses API；Ollama 可留空 API Key',
    'anthropic-messages': '使用 Anthropic Messages API（/v1/messages）',
    'google-gemini': '使用 Gemini generateContent API',
  }[normalizeApiType(apiType)] || '自动兼容 Chat Completions 和 Responses API；Ollama 可留空 API Key'
}

function apiBasePlaceholder(apiType) {
  return {
    'openai-completions': 'https://api.openai.com/v1 或 http://127.0.0.1:11434',
    'anthropic-messages': 'https://api.anthropic.com',
    'google-gemini': 'https://generativelanguage.googleapis.com/v1beta',
  }[normalizeApiType(apiType)] || 'https://api.openai.com/v1'
}

function apiKeyPlaceholder(apiType) {
  return {
    'openai-completions': 'sk-...（Ollama 可留空）',
    'anthropic-messages': 'sk-ant-...',
    'google-gemini': 'AIza...',
  }[normalizeApiType(apiType)] || 'sk-...'
}

function getSystemPromptBase(config) {
  const name = config?.assistantName || DEFAULT_NAME
  const personality = config?.assistantPersonality || DEFAULT_PERSONALITY
  return `你是「${name}」，ClawPanel 内置的 AI 智能助手。

## 你的性格
${personality}

## 你是谁
- 你是 ClawPanel 内置的智能助手
- 你帮助用户管理和排障 OpenClaw AI Agent 平台
- 你精通 OpenClaw 的架构、配置、Gateway、Agent 管理等所有方面
- 你善于分析日志、诊断错误、提供解决方案

## 相关资源
- ClawPanel 官网: https://claw.qt.cool
- GitHub: https://github.com/qingchencloud
- 开源项目:
  - ClawPanel — OpenClaw 可视化管理面板（Tauri v2）
  - OpenClaw 汉化版 — AI Agent 平台中文版，npm install -g @qingchencloud/openclaw-zh

## ClawPanel 是什么
- OpenClaw 的可视化管理面板，基于 Tauri v2 的跨平台桌面应用（Windows/macOS/Linux）
- 支持仪表盘监控、模型配置、Agent 管理、实时聊天、记忆文件管理、AI 助手工具调用等
- 官网: https://claw.qt.cool | GitHub: https://github.com/qingchencloud/clawpanel

## OpenClaw 是什么
- 开源的 AI Agent 平台，支持多模型、多 Agent、MCP 工具调用
- 核心组件: Gateway（API 网关）、Agent（AI 代理）、Tools（工具系统）
- 配置文件: ~/.openclaw/openclaw.json（全局配置）
- 安装方式: npm install -g @qingchencloud/openclaw-zh（汉化版，推荐）或 npm install -g openclaw（官方英文版）`
}

function currentMode(config, modeOverride) {
  const modeKey = modeOverride || config?.mode
  return MODES[modeKey] ? modeKey : DEFAULT_MODE
}

function buildSystemPrompt({ config, soulCache, knowledgeBase }) {
  const cfg = config || {}
  const kbText = typeof knowledgeBase === 'string' ? knowledgeBase : ''
  let prompt = ''

  if (cfg?.soulSource?.startsWith('openclaw:') && soulCache) {
    prompt += '# 你的身份\n'
    if (soulCache.identity) prompt += soulCache.identity + '\n\n'
    if (soulCache.soul) prompt += '# 灵魂\n' + soulCache.soul + '\n\n'
    if (soulCache.user) prompt += '# 你的用户\n' + soulCache.user + '\n\n'
    if (soulCache.agents) {
      const agentsContent = soulCache.agents.length > 4000 ? soulCache.agents.slice(0, 4000) + '\n\n[...已截断]' : soulCache.agents
      prompt += '# 操作规则\n' + agentsContent + '\n\n'
    }
    if (soulCache.tools) prompt += '# 工具笔记\n' + soulCache.tools + '\n\n'
    if (soulCache.memory) {
      const memContent = soulCache.memory.length > 3000 ? soulCache.memory.slice(-3000) : soulCache.memory
      prompt += '# 长期记忆\n' + memContent + '\n\n'
    }
    if (soulCache.recentMemories?.length) {
      prompt += '# 最近记忆\n'
      for (const m of soulCache.recentMemories) {
        const content = m.content.length > 800 ? m.content.slice(0, 800) + '...' : m.content
        prompt += `## ${m.date}\n${content}\n\n`
      }
    }
    prompt += '\n# ClawPanel 工具能力\n你同时是 ClawPanel 内置助手，拥有以下额外能力：\n'
    prompt += '- 执行终端命令、读写文件、浏览目录\n'
    prompt += '- 联网搜索和网页抓取\n'
    prompt += '- 管理 OpenClaw 配置和服务\n'
    prompt += '- 你精通 OpenClaw 的架构、配置、Gateway、Agent 管理\n'
  } else {
    prompt += getSystemPromptBase(cfg)
  }

  const modeKey = currentMode(cfg)
  const mode = MODES[modeKey]

  prompt += `\n\n## 当前模式：${mode.label}模式`

  if (modeKey === 'chat') {
    prompt += '\n你处于纯聊天模式，没有任何工具可用。请通过文字回答问题，给出具体的命令建议供用户手动执行。'
    prompt += '\n如果用户需要你执行操作，建议用户切换到「执行」或「规划」模式。'
  } else {
    if (modeKey === 'plan') {
      prompt += '\n你处于规划模式：可以调用工具读取信息、分析问题，但绝对不能修改任何文件（write_file 已禁用）。'
      prompt += '\n你的任务是：分析问题 -> 制定方案 -> 输出详细步骤，让用户确认后再切换到执行模式操作。'
      prompt += '\n即使使用 run_command，也只能执行只读命令（查看、检查、列出），不要执行任何修改操作。'
    }
    if (modeKey === 'unlimited') {
      prompt += '\n你处于无限模式：所有工具调用无需用户确认，请高效完成任务。'
    }

    prompt += '\n\n### 可用工具'
    prompt += '\n- 用户交互: ask_user — 向用户提问（单选/多选/文本），获取结构化回答。需要用户做决定时优先用此工具。'
    prompt += '\n- 系统信息: get_system_info — 获取 OS 类型、架构、主目录等。在执行任何命令前必须先调用此工具。'
    prompt += '\n- 进程/端口: list_processes（按名称过滤）、check_port（检测端口占用）'
    prompt += '\n- 终端: run_command — 执行 shell 命令'
    if (mode.readOnly) {
      prompt += '\n- 文件: read_file、list_directory（只读，write_file 已禁用）'
    } else {
      prompt += '\n- 文件: read_file、write_file、list_directory'
    }

    prompt += '\n\n### 终端命令规范（重要）'
    prompt += '\n- Windows: 终端是 PowerShell，必须使用 PowerShell 语法:'
    prompt += '\n  - 列目录: Get-ChildItem'
    prompt += '\n  - 看文件: Get-Content'
    prompt += '\n  - 查进程: Get-Process | Where-Object { $_.Name -like "*openclaw*" }'
    prompt += '\n  - 查端口: Get-NetTCPConnection -LocalPort 18789'
    prompt += '\n  - 文件尾: Get-Content file.log -Tail 50'
    prompt += '\n  - 搜内容: Select-String -Path file.log -Pattern "ERROR"'
    prompt += '\n  - 环境变量: $env:USERPROFILE'
    prompt += '\n- macOS: zsh，标准 Unix 命令'
    prompt += '\n- Linux: bash，标准 Unix 命令'
    prompt += '\n- 绝对禁止 cmd.exe 语法（dir、type、findstr、netstat）'
    prompt += '\n- 一次只执行一条命令，等结果出来再决定下一步'
    prompt += '\n- 不要重复执行相同的命令'

    prompt += '\n\n### 跨平台路径'
    prompt += '\n- Windows: $env:USERPROFILE\\.openclaw\\'
    prompt += '\n- macOS/Linux: ~/.openclaw/'

    prompt += '\n\n### 工具使用原则'
    prompt += '\n- 先 get_system_info，再根据 OS 执行正确命令'
    prompt += '\n- 优先用 read_file / list_directory / list_processes / check_port 等专用工具，减少 run_command 使用'
    prompt += '\n- 主动使用工具，不要只建议用户手动操作'
    if (mode.confirmDanger) {
      prompt += '\n- 执行破坏性操作前先告知用户'
    }
  }

  prompt += '\n\n## 内置技能卡片'
  prompt += '\n用户可以在欢迎页点击技能卡片快速触发操作。当用户遇到问题时，你也可以主动推荐合适的技能：'
  for (const s of BUILTIN_SKILLS) {
    prompt += `\n- ${s.name}（${s.desc}）`
  }
  prompt += '\n\n当用户的需求匹配某个技能时，可以建议用户点击对应的技能卡片，或者你直接按技能的步骤操作。'

  if (kbText) {
    prompt += '\n\n' + kbText
  }

  const kbEnabled = (cfg.knowledgeFiles || []).filter(f => f.enabled !== false && f.content)
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

function getEnabledTools({ config, mode } = {}) {
  const cfg = config || {}
  const modeKey = currentMode(cfg, mode)
  const modeCfg = MODES[modeKey]
  if (!modeCfg.tools) return []

  const t = cfg.tools || {}
  const tools = [...TOOL_DEFS.system, ...TOOL_DEFS.process, ...TOOL_DEFS.interaction]

  if (t.terminal !== false) tools.push(...TOOL_DEFS.terminal)
  if (t.webSearch !== false) tools.push(...TOOL_DEFS.webSearch)

  if (t.fileOps !== false) {
    if (modeCfg.readOnly) {
      tools.push(...TOOL_DEFS.fileOps.filter(td => td.function.name !== 'write_file'))
    } else {
      tools.push(...TOOL_DEFS.fileOps)
    }
  }

  if (modeCfg.readOnly) {
    tools.push(...TOOL_DEFS.skills.filter(td => !['skills_install_dep', 'skills_clawhub_install'].includes(td.function.name)))
  } else {
    tools.push(...TOOL_DEFS.skills)
  }

  return tools
}

function trimContext(messages, maxTokens) {
  if (!Array.isArray(messages)) return []
  if (!maxTokens || maxTokens <= 0 || messages.length <= maxTokens) return messages

  const first = messages[0]
  if (first?.role === 'system' && maxTokens > 1) {
    return [first, ...messages.slice(-(maxTokens - 1))]
  }
  return messages.slice(-maxTokens)
}

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
  const type = normalizeApiType(apiType)
  if (type === 'anthropic-messages') {
    if (!base.endsWith('/v1')) base += '/v1'
    return base
  }
  if (type === 'google-gemini') {
    return base
  }
  if (/:(11434)$/i.test(base) && !base.endsWith('/v1')) return `${base}/v1`
  return base
}

function authHeaders(apiType, apiKey) {
  const type = normalizeApiType(apiType)
  const key = apiKey || ''
  if (type === 'anthropic-messages') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (key) headers['x-api-key'] = key
    return headers
  }
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

const TIMEOUT_TOTAL = 120000
const TIMEOUT_CHUNK = 30000

async function fetchWithRetry(url, options, retries = 3) {
  const delays = [1000, 3000, 8000]
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, options)
      if (resp.ok || resp.status < 500 || i >= retries) return resp
      await new Promise(r => setTimeout(r, delays[i]))
    } catch (err) {
      if (err.name === 'AbortError') throw err
      if (i >= retries) throw err
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
}

async function readSSEStream(resp, onEvent, signal) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const onAbort = () => { try { reader.cancel() } catch {} }
  if (signal) {
    if (signal.aborted) { reader.cancel(); throw new DOMException('Aborted', 'AbortError') }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
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
        if (trimmed.startsWith('event:')) continue
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return
        try { onEvent(JSON.parse(data)) } catch {}
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function convertToolsForAnthropic(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }))
}

function convertToolsForGemini(tools) {
  return [{ functionDeclarations: tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || { type: 'object', properties: {} },
  })) }]
}

function isCriticalCommand(command) {
  if (!command) return false
  return CRITICAL_PATTERNS.some(p => p.test(command))
}

function formatToolDescription(name, args) {
  if (name === 'run_command') {
    return `执行命令:\n\n${args.command}${args.cwd ? '\n\n工作目录: ' + args.cwd : ''}`
  }
  if (name === 'write_file') {
    const preview = (args.content || '').slice(0, 200)
    return `写入文件:\n${args.path}\n\n内容预览:\n${preview}${(args.content || '').length > 200 ? '\n...(已截断)' : ''}`
  }
  return `执行工具: ${name}`
}

async function confirmToolCall(toolName, args, critical, adapters) {
  if (!adapters?.confirm) return !critical
  const prefix = critical ? '安全围栏拦截：此命令被识别为极端危险操作。\n\n' : ''
  const text = `${prefix}AI 请求执行以下操作:\n\n${formatToolDescription(toolName, args)}\n\n是否允许？`
  return await adapters.confirm(text)
}

async function executeTool(name, args, adapters) {
  if (name === 'ask_user' && adapters?.askUser) {
    const answer = await adapters.askUser(args)
    if (answer && typeof answer === 'object') return answer.message || ''
    return answer || ''
  }
  if (!adapters?.execTool) return `未配置工具执行器: ${name}`
  return await adapters.execTool({ name, args })
}

async function executeToolWithSafety(toolName, args, adapters, modeKey) {
  let result = ''
  let approved = true
  const mode = MODES[modeKey] || MODES[DEFAULT_MODE]
  const isCritical = toolName === 'run_command' && isCriticalCommand(args.command)

  if (isCritical) {
    approved = await confirmToolCall(toolName, args, true, adapters)
    if (!approved) result = '用户拒绝了此危险操作'
  } else if (mode.confirmDanger && DANGEROUS_TOOLS.has(toolName)) {
    approved = await confirmToolCall(toolName, args, false, adapters)
    if (!approved) result = '用户拒绝了此操作'
  }

  if (approved) {
    try { result = await executeTool(toolName, args, adapters) }
    catch (err) { result = `执行失败: ${typeof err === 'string' ? err : err.message || JSON.stringify(err)}` }
  }
  return { result, approved }
}

function applyStop(text) {
  if (!text) return { text: '', stop: false }
  let stop = false
  let cleaned = text
  for (const pattern of STOP_PATTERNS) {
    if (pattern.test(cleaned)) {
      stop = true
      cleaned = cleaned.replace(pattern, '')
    }
  }
  return { text: cleaned.trim(), stop }
}

async function callChatCompletions({ base, config, messages, onChunk, signal }) {
  const url = base + '/chat/completions'
  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature || 0.7,
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(config.apiType, config.apiKey),
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    await readSSEStream(resp, (json) => {
      const d = json.choices?.[0]?.delta
      if (d?.content) onChunk(d.content)
      else if (d?.reasoning_content) onChunk(d.reasoning_content)
    }, signal)
  } else {
    const json = await resp.json()
    const msg = json.choices?.[0]?.message
    const content = msg?.content || msg?.reasoning_content || ''
    if (content) onChunk(content)
  }
}

async function callResponsesAPI({ base, config, messages, onChunk, signal }) {
  const url = base + '/responses'
  const input = messages.filter(m => m.role !== 'system')
  const instructions = messages.find(m => m.role === 'system')?.content || ''

  const body = {
    model: config.model,
    input,
    instructions,
    stream: true,
    temperature: config.temperature || 0.7,
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(config.apiType, config.apiKey),
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  await readSSEStream(resp, (json) => {
    if (json.type === 'response.output_text.delta' && json.delta) {
      onChunk(json.delta)
    }
    if (json.choices?.[0]?.delta?.content) {
      onChunk(json.choices[0].delta.content)
    }
  }, signal)
}

async function callAnthropicMessages({ base, config, messages, onChunk, signal }) {
  const url = base + '/messages'
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  const body = {
    model: config.model,
    max_tokens: 8192,
    stream: true,
    temperature: config.temperature || 0.7,
  }
  if (systemMsg) body.system = systemMsg
  body.messages = chatMessages

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(config.apiType, config.apiKey),
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  await readSSEStream(resp, (json) => {
    if (json.type === 'content_block_delta') {
      const delta = json.delta
      if (delta?.type === 'text_delta' && delta.text) onChunk(delta.text)
      else if (delta?.type === 'thinking_delta' && delta.thinking) onChunk(delta.thinking)
    }
  }, signal)
}

async function callGeminiGenerate({ base, config, messages, onChunk, signal }) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  const contents = chatMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }))

  const body = { contents, generationConfig: { temperature: config.temperature || 0.7 } }
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] }

  const url = `${base}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }

  await readSSEStream(resp, (json) => {
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) onChunk(text)
  }, signal)
}

async function callAI({ config, messages, adapters, mode, signal }) {
  const cfg = config || {}
  const apiType = normalizeApiType(cfg.apiType)
  if (!cfg.baseUrl || !cfg.model || (requiresApiKey(apiType) && !cfg.apiKey)) {
    throw new Error('请先配置 AI 模型')
  }

  const base = cleanBaseUrl(cfg.baseUrl, apiType)
  const allMessages = [{ role: 'system', content: buildSystemPrompt({ config: cfg, soulCache: adapters?.soulCache, knowledgeBase: adapters?.knowledgeBase }) }, ...messages]

  const timeoutController = new AbortController()
  const totalTimer = setTimeout(() => timeoutController.abort(new DOMException('请求超时', 'AbortError')), TIMEOUT_TOTAL)
  const activeSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  let buffer = ''
  const onChunk = (chunk) => { buffer += chunk }

  try {
    if (apiType === 'anthropic-messages') {
      await callAnthropicMessages({ base, config: cfg, messages: allMessages, onChunk, signal: activeSignal })
    } else if (apiType === 'google-gemini') {
      await callGeminiGenerate({ base, config: cfg, messages: allMessages, onChunk, signal: activeSignal })
    } else {
      try {
        await callChatCompletions({ base, config: cfg, messages: allMessages, onChunk, signal: activeSignal })
      } catch (err) {
        const msg = err.message || ''
        if (msg.includes('legacy protocol') || msg.includes('/v1/responses') || msg.includes('not supported')) {
          await callResponsesAPI({ base, config: cfg, messages: allMessages, onChunk, signal: activeSignal })
        } else {
          throw err
        }
      }
    }
  } finally {
    clearTimeout(totalTimer)
  }

  const stopRes = applyStop(buffer)
  return { text: stopRes.text, stop: stopRes.stop }
}

async function callAIWithTools({ config, messages, tools, adapters, mode, signal }) {
  const cfg = config || {}
  const apiType = normalizeApiType(cfg.apiType)
  if (!cfg.baseUrl || !cfg.model || (requiresApiKey(apiType) && !cfg.apiKey)) {
    throw new Error('请先配置 AI 模型')
  }

  const base = cleanBaseUrl(cfg.baseUrl, apiType)
  const modeKey = currentMode(cfg, mode)
  const enabledTools = tools || getEnabledTools({ config: cfg, mode })
  let currentMessages = [{ role: 'system', content: buildSystemPrompt({ config: cfg, soulCache: adapters?.soulCache, knowledgeBase: adapters?.knowledgeBase }) }, ...messages]

  const maxRounds = cfg.autoRounds ?? 8
  for (let round = 0; ; round++) {
    if (maxRounds > 0 && round >= maxRounds) {
      return { text: '工具调用达到上限，已停止。', stop: true }
    }

    const timeoutController = new AbortController()
    const totalTimer = setTimeout(() => timeoutController.abort(new DOMException('请求超时', 'AbortError')), TIMEOUT_TOTAL)
    const activeSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

    try {
      if (apiType === 'anthropic-messages') {
        const systemMsg = currentMessages.find(m => m.role === 'system')?.content || ''
        const chatMsgs = currentMessages.filter(m => m.role !== 'system')
        const body = {
          model: cfg.model,
          max_tokens: 8192,
          temperature: cfg.temperature || 0.7,
          messages: chatMsgs,
        }
        if (systemMsg) body.system = systemMsg
        if (enabledTools.length > 0) body.tools = convertToolsForAnthropic(enabledTools)

        const resp = await fetchWithRetry(base + '/messages', {
          method: 'POST',
          headers: authHeaders(cfg.apiType, cfg.apiKey),
          body: JSON.stringify(body),
          signal: activeSignal,
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
          currentMessages.push({ role: 'assistant', content: contentBlocks })
          const toolResults = []
          for (const tu of toolUses) {
            const args = tu.input || {}
            const { result } = await executeToolWithSafety(tu.name, args, adapters, modeKey)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            })
          }
          currentMessages.push({ role: 'user', content: toolResults })
          continue
        }

        const stopRes = applyStop(textContent)
        return { text: stopRes.text, stop: stopRes.stop }
      }

      if (apiType === 'google-gemini') {
        const systemMsg = currentMessages.find(m => m.role === 'system')?.content || ''
        const chatMsgs = currentMessages.filter(m => m.role !== 'system')
        const contents = chatMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'function' : 'user',
          parts: m.functionResponse
            ? [{ functionResponse: m.functionResponse }]
            : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        }))
        const body = { contents, generationConfig: { temperature: cfg.temperature || 0.7 } }
        if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] }
        if (enabledTools.length > 0) body.tools = convertToolsForGemini(enabledTools)

        const url = `${base}/models/${cfg.model}:generateContent?key=${cfg.apiKey}`
        const resp = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: activeSignal,
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
            const { result } = await executeToolWithSafety(fc.functionCall.name, args, adapters, modeKey)
            currentMessages.push({
              role: 'tool',
              content: typeof result === 'string' ? result : JSON.stringify(result),
              functionResponse: { name: fc.functionCall.name, response: { result: typeof result === 'string' ? result : JSON.stringify(result) } },
            })
          }
          continue
        }

        const stopRes = applyStop(textParts)
        return { text: stopRes.text, stop: stopRes.stop }
      }

      const body = {
        model: cfg.model,
        messages: currentMessages,
        temperature: cfg.temperature || 0.7,
      }
      if (enabledTools.length > 0) body.tools = enabledTools

      const resp = await fetchWithRetry(base + '/chat/completions', {
        method: 'POST',
        headers: authHeaders(cfg.apiType, cfg.apiKey),
        body: JSON.stringify(body),
        signal: activeSignal,
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
          const { result } = await executeToolWithSafety(toolName, args, adapters, modeKey)
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          })
        }
        continue
      }

      const content = assistantMsg.content || assistantMsg.reasoning_content || ''
      const stopRes = applyStop(content)
      return { text: stopRes.text, stop: stopRes.stop }
    } finally {
      clearTimeout(totalTimer)
    }
  }
}

// 适配器接口（由调用方提供）
// const adapters = {
//   execTool: async (toolCall) => {},
//   confirm: async (text) => false,
//   askUser: async (prompt) => ({ ok: false, message: '' }),
//   storage: { getItem, setItem },
//   imageStore: { saveImage, loadImage, deleteImage },
//   soulCache,
//   knowledgeBase,
// }

export {
  buildSystemPrompt,
  getEnabledTools,
  callAIWithTools,
  callAI,
  trimContext,
}

