/**
 * OpenClaw 内置知识库
 * 来源：https://openclawcn.com/docs/
 * 供 ClawPanel AI 助手在系统提示词中使用
 */

export const OPENCLAW_KB = `
# OpenClaw 知识库（内置参考）

## 一、架构概览
OpenClaw 是开源个人 AI 助手平台，核心组件：
- **Gateway 网关**：核心后端服务，处理消息路由、Agent 执行、渠道连接
- **CLI**：命令行工具，用于安装/配置/管理 OpenClaw
- **Agent（智能体）**：独立的 AI 角色实例，有自己的工作区、身份、模型配置
- **Workspace（工作区）**：Agent 的个性化存储（Skills、提示、记忆）
- **Channel（渠道）**：消息通道（WhatsApp/Telegram/Discord/Mattermost 等）
- **Control UI / Dashboard**：内置 Web 管理界面，端口 18789

## 二、目录结构
\`\`\`
~/.openclaw/
├── openclaw.json          # 主配置文件（JSON5，支持注释）
├── .env                   # 全局环境变量
├── workspace/             # 默认(main) Agent 的工作区
│   ├── IDENTITY.md        # Agent 身份定义
│   ├── SOUL.md            # Agent 灵魂/人格
│   ├── USER.md            # 用户信息
│   ├── AGENTS.md          # 操作规则
│   └── ...                # Skills、记忆等
├── agents/
│   ├── main/
│   │   └── agent/
│   │       ├── auth-profiles.json   # 认证配置（OAuth + API Key）
│   │       ├── models.json          # 模型提供商配置
│   │       └── auth.json            # 运行时认证缓存（自动管理）
│   └── <agentId>/
│       ├── agent/                   # 同上
│       └── workspace/              # 自定义 Agent 的工作区
├── credentials/
│   ├── oauth.json                  # 旧版 OAuth 导入
│   ├── whatsapp/<accountId>/       # WhatsApp 凭证
│   └── <channel>-allowFrom.json   # 配对白名单
└── logs/                           # 日志文件
\`\`\`

**重要路径规则：**
- main Agent 工作区：\`~/.openclaw/workspace\`（根级别）
- 自定义 Agent 工作区：\`~/.openclaw/agents/<agentId>/workspace\`
- Agent 配置目录：\`~/.openclaw/agents/<agentId>/agent/\`

## 三、CLI 常用命令
| 命令 | 说明 |
|------|------|
| \`openclaw onboard\` | 新手引导向导（推荐首次使用） |
| \`openclaw onboard --install-daemon\` | 引导 + 安装后台服务 |
| \`openclaw setup\` | 初始化/配置工作区 |
| \`openclaw gateway\` | 启动 Gateway（前台） |
| \`openclaw gateway --port 18789 --verbose\` | 指定端口启动 |
| \`openclaw gateway status\` | 查看 Gateway 状态 |
| \`openclaw dashboard\` | 打开 Web Dashboard |
| \`openclaw status\` | 系统状态概览 |
| \`openclaw status --all\` | 完整调试报告（可粘贴） |
| \`openclaw health\` | 健康检查 |
| \`openclaw doctor\` | 诊断配置问题 |
| \`openclaw doctor --fix\` | 自动修复配置问题 |
| \`openclaw security audit --deep\` | 深度安全审计 |
| \`openclaw channels login\` | 登录渠道（如 WhatsApp QR） |
| \`openclaw pairing list <channel>\` | 列出配对请求 |
| \`openclaw pairing approve <channel> <code>\` | 批准配对 |
| \`openclaw configure --section web\` | 配置 Web 搜索（Brave API） |
| \`openclaw config set <key> <value>\` | 设置单个配置项 |
| \`openclaw logs\` | 查看日志 |
| \`openclaw service start/stop/restart\` | 管理后台服务 |
| \`openclaw message send --target <num> --message "text"\` | 发送测试消息 |

## 四、配置文件（openclaw.json）
配置位于 \`~/.openclaw/openclaw.json\`，JSON5 格式（支持注释和尾逗号）。
不存在时使用安全默认值。严格 schema 验证，未知键会阻止启动。

### 最小配置示例
\`\`\`json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace"
    }
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"]
    }
  }
}
\`\`\`

### 关键配置项
- **agents.defaults.workspace** — 默认工作区路径
- **agents.defaults.model.primary** — 默认模型（格式 "provider/model"）
- **agents.defaults.sandbox** — 沙箱配置（mode: "off"|"non-main"|"all"）
- **agents.list[]** — 多 Agent 配置（id, name, workspace, model, identity, groupChat, sandbox）
- **channels.whatsapp** — WhatsApp（allowFrom, groups, dmPolicy, accounts）
- **channels.telegram** — Telegram Bot
- **channels.discord** — Discord Bot
- **channels.mattermost** — Mattermost 插件
- **gateway.auth.token** — Gateway 认证令牌
- **gateway.port** — Gateway 端口（默认 18789）
- **models.providers** — 自定义模型提供商（baseUrl, apiKey, api, models[]）
- **env.vars** — 内联环境变量
- **bindings[]** — 消息路由绑定（channel→agentId）

### 配置管理 RPC
- \`config.get\` — 获取当前配置（含 hash）
- \`config.apply\` — 全量替换配置并重启（需 baseHash）
- \`config.patch\` — 部分更新配置并重启（JSON merge patch 语义）
- \`config.schema\` — 获取配置的 JSON Schema

### 环境变量
- \`~/.openclaw/.env\` — 全局 .env
- 配置中支持 \`\${VAR_NAME}\` 语法引用环境变量
- env.shellEnv.enabled=true 可从 shell 导入环境变量

## 五、多 Agent 路由
\`\`\`json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace", sandbox: { mode: "off" } },
      { id: "helper", name: "Helper Bot", workspace: "~/.openclaw/agents/helper/workspace" }
    ]
  },
  bindings: [
    { match: { channel: "telegram" }, agentId: "helper" },
    { match: { channel: "whatsapp" }, agentId: "main" }
  ]
}
\`\`\`
- main Agent 的工作区默认 \`~/.openclaw/workspace\`
- 其他 Agent 默认 \`~/.openclaw/workspace-<agentId>\`
- Agent 配置目录固定为 \`~/.openclaw/agents/<agentId>/agent/\`

## 六、模型配置
模型配置存储在 \`~/.openclaw/agents/<agentId>/agent/models.json\`。
也可在 openclaw.json 的 \`models.providers\` 中定义自定义提供商。

自定义提供商示例：
\`\`\`json5
{
  models: {
    providers: {
      "my-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "sk-...",
        api: "openai-completions",
        models: [
          { id: "gpt-4o", name: "GPT-4o", reasoning: false, input: ["text", "image"],
            contextWindow: 128000, maxTokens: 16384 }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "my-proxy/gpt-4o" }
    }
  }
}
\`\`\`

## 七、认证
- **OAuth（推荐）**：通过 \`openclaw onboard\` 设置，支持 Anthropic、OpenAI Codex
- **API Key**：直接在 auth-profiles.json 或环境变量中设置
- **凭证位置**：\`~/.openclaw/agents/<agentId>/agent/auth-profiles.json\`
- **旧版导入**：\`~/.openclaw/credentials/oauth.json\`

## 八、安装
**macOS/Linux：**
\`\`\`bash
curl -fsSL https://openclaw.ai/install.sh | bash
\`\`\`
**Windows（WSL2 推荐）：**
\`\`\`powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
\`\`\`
**npm 全局安装：**
\`\`\`bash
npm install -g openclaw@latest
\`\`\`
**前置条件：** Node.js >= 22

## 九、后台服务
- **macOS**：launchd 服务（openclaw 应用管理）
- **Linux**：systemd 用户服务（需 \`sudo loginctl enable-linger $USER\`）
- **Windows**：WSL2 内运行 Linux 步骤

## 十、渠道配置
### WhatsApp
- \`openclaw channels login\` → 扫描 QR 登录
- 配置 allowFrom 白名单限制私聊
- groups 配置群组行为（requireMention 等）
- 首次私信会返回配对码，需 approve

### Telegram
- 使用 Bot Token
- \`channels.telegram.tokenFile\` 或环境变量
- 群组支持 @提及触发

### Discord
- 使用 Bot Token
- 环境变量或配置中设置
- 支持 guild 级别配置

## 十一、故障排查
1. \`openclaw doctor\` — 诊断所有已知问题
2. \`openclaw doctor --fix\` — 自动修复
3. \`openclaw status --all\` — 完整状态报告
4. \`openclaw health\` — 健康检查
5. \`openclaw logs\` — 查看日志
6. 配置验证失败 → Gateway 拒绝启动，仅允许诊断命令
7. WhatsApp 不回消息 → 检查配对是否已 approve
8. 认证错误 → 检查 auth-profiles.json 或重新 \`openclaw onboard\`

## 十二、ClawPanel 公益 AI 接口计划
ClawPanel 项目组正式开放公益 AI 接口测试计划，降低用户接入 AI 能力的门槛。

### 核心信息
- **GPT-AI 网关地址**：https://gpt.qt.cool/v1
- **支持接口**：/v1/chat/completions、/v1/responses（OpenAI 兼容）
- **支持模型**：OpenAI 全系列（GPT-5、GPT-5.1、GPT-5.2、GPT-5.3-codex、GPT-5.4 等）
- **费用**：测试期间所有调用成本由项目组内部承担，用户无需付费
- **限制**：无请求限制
- **用户后台**：https://gpt.qt.cool/user（查看用量、提交工单）

### 官方入口
- **ClawPanel 官网**：https://claw.qt.cool/
- **GPT-AI 网关官网**：https://gpt.qt.cool/
- **用户后台**：https://gpt.qt.cool/user
- **晴辰导航站**：https://qt.cool/

### 测试密钥
- ClawPanel 已内置公共体验密钥，开箱即用
- 用户也可前往 gpt.qt.cool 签到获取独立密钥
- 独立密钥可在用户后台管理和查询用量

### 接入方式
已兼容 OpenAI API 的项目，只需替换：
1. Base URL → https://gpt.qt.cool/v1
2. API Key → 测试密钥
即可完成接入。

### 在 ClawPanel 中配置
- **助手设置**：打开 AI 助手设置 → 模型配置 → 使用「一键接入」按钮
- **模型配置页**：进入模型配置 → 使用「一键添加全部模型」按钮
- 两处均自动填入网关地址和内置密钥
`.trim()
