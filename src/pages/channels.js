/**
 * 消息渠道管理
 * 渠道列表 + Agent 对接（多绑定、独立配置、渠道测试）
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { CHANNEL_LABELS } from '../lib/channel-labels.js'
import { wsClient } from '../lib/ws-client.js'

// ── 渠道注册表：面板内置向导，覆盖 OpenClaw 官方渠道 + 国内扩展渠道 ──

const PLATFORM_REGISTRY = {
  qqbot: {
    label: 'QQ 机器人',
    iconName: 'message-square',
    desc: '内置 QQ 机器人接入能力，通过 QQ 开放平台快速启用',
    guide: [
      '使用手机 QQ 扫描二维码，<a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" style="color:var(--accent);text-decoration:underline">打开 QQ 机器人开放平台</a> 完成注册登录',
      '点击「创建机器人」，设置机器人名称和头像',
      '创建完成后，在机器人详情页复制 <b>AppID</b> 和 <b>AppSecret</b>（AppSecret 仅显示一次，请妥善保存）',
      '将 AppID 和 AppSecret 填入下方表单，点击「校验凭证」验证后保存',
      '面板会安装腾讯官方推荐的 <code>@tencent-connect/openclaw-qqbot</code>，并把凭证写入 <code>channels.qqbot.accounts.default</code>（与 <code>openclaw channels add</code> 一致）；保存后重载 Gateway，首次安装插件后会自动重启 Gateway 以加载扩展',
      '若 QQ 客户端提示「灵魂不在线」，多为本机 OpenClaw Gateway 未运行或未连上 QQ 长连接，不是单纯填错 AppID。请使用下方「完整联通诊断」并查阅 <a href="https://q.qq.com/qqbot/openclaw/faq.html" target="_blank" rel="noopener">QQ 开放平台 OpenClaw 常见问题</a>',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">详细教程：<a href="https://cloud.tencent.com/developer/article/2626045" target="_blank" style="color:var(--accent);text-decoration:underline">腾讯云 - 快速搭建 AI 私人 QQ 助理</a></div>',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '如 1903224859', required: true },
      { key: 'clientSecret', label: 'ClientSecret', placeholder: '如 cisldqspngYlyPdc', secret: true, required: true },
    ],
    pluginRequired: '@tencent-connect/openclaw-qqbot@latest',
    pluginId: 'qqbot',
  },
  dingtalk: {
    label: '钉钉',
    iconName: 'message-square',
    desc: '钉钉企业内部应用机器人，基于 Stream 模式长连接，无需公网地址',
    guide: [
      '打开 <a href="https://open-dev.dingtalk.com/" target="_blank" style="color:var(--accent);text-decoration:underline">钉钉开放平台</a>，进入「应用开发」→「企业内部开发」，创建企业内部应用',
      '在应用能力中添加「<b>机器人</b>」，消息接收方式选择 <b>Stream 模式</b>（不要选 Webhook）',
      '在「权限管理」中确认已开通：<code>Card.Streaming.Write</code>、<code>Card.Instance.Write</code>、<code>qyapi_robot_sendmsg</code>',
      '在「凭证与基础信息」页面复制 <b>Client ID</b>（AppKey）和 <b>Client Secret</b>（AppSecret）',
      '将 Client ID 和 Client Secret 填入下方表单，校验通过后保存',
      '⚠️ 发布应用版本！在「版本管理与发布」中创建版本并发布上线，否则机器人不会响应消息',
      '保存后面板会自动安装 <code>@dingtalk-real-ai/dingtalk-connector</code> 插件，并自动开启 Gateway HTTP chatCompletions 端点',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">详细教程：<a href="https://claw.qt.cool/docs/dingtalk-integration.html" target="_blank" style="color:var(--accent);text-decoration:underline">ClawPanel 钉钉接入指南</a></div>',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '钉钉应用 AppKey / Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '钉钉应用 AppSecret / Client Secret', secret: true, required: true },
    ],
    pluginRequired: '@dingtalk-real-ai/dingtalk-connector@latest',
    pluginId: 'dingtalk-connector',
  },
  feishu: {
    label: '飞书',
    iconName: 'message-square',
    desc: '飞书官方插件，支持私聊/群聊、文档读写、多维表格、日程等，一键创建机器人',
    guide: [
      '点击下方「安装插件」按钮安装飞书官方插件 <code>@larksuite/openclaw-lark</code>',
      '安装完成后，点击「登录」按钮，用飞书扫码一键创建机器人（或关联已有机器人）',
      '创建完成后，在飞书中向机器人发消息即可开始对话',
      '如需更多能力（文档、表格、日程等），在对话中发送 <code>/feishu auth</code> 完成用户授权',
      '验证安装：在对话中发送 <code>/feishu start</code>，返回版本号即成功',
      '升级插件：点击「安装插件」按钮即可升级到最新版',
    ],
    guideFooter: `<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">
      详细教程：<a href="https://www.feishu.cn/content/article/7613711414611463386" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw 飞书官方插件使用指南</a>
      &nbsp;·&nbsp;
      <a href="https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh" target="_blank" style="color:var(--accent);text-decoration:underline">更新日志</a>
    </div>`,
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxxxxx（扫码创建后自动填入）', required: true },
      { key: 'appSecret', label: 'App Secret', placeholder: '飞书应用凭证 AppSecret', secret: true, required: true },
      {
        key: 'domain', label: '平台版本', type: 'select',
        options: [
          { value: '', label: '飞书（国内版 open.feishu.cn）' },
          { value: 'lark', label: 'Lark（海外版 open.larksuite.com）' },
        ],
        required: false,
      },
    ],
    pluginRequired: '@larksuite/openclaw-lark@latest',
    pluginId: 'openclaw-lark',
    pairingChannel: 'feishu',
  },
  telegram: {
    label: 'Telegram',
    iconName: 'send',
    desc: 'Telegram Bot 接入，全球最流行的即时通讯平台之一',
    guide: [
      '打开 Telegram，搜索 <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent);text-decoration:underline">@BotFather</a>，发送 <code>/newbot</code> 创建机器人',
      '按照 BotFather 提示设置名称和用户名，完成后会收到一条包含 <b>Bot Token</b> 的消息',
      '复制 Bot Token 填入下方表单，点击「校验凭证」验证后保存',
      '保存后 Gateway 会自动启动 Telegram 长轮询连接',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/telegram" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Telegram 接入</a></div>',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true, required: true },
    ],
    configKey: 'telegram',
    pairingChannel: 'telegram',
  },
  discord: {
    label: 'Discord',
    iconName: 'hash',
    desc: 'Discord Bot 接入，支持服务器消息和私聊',
    guide: [
      '打开 <a href="https://discord.com/developers/applications" target="_blank" style="color:var(--accent);text-decoration:underline">Discord Developer Portal</a>，点击「New Application」创建应用',
      '在左侧「Bot」页面，点击「Reset Token」获取 <b>Bot Token</b>，并开启「Message Content Intent」',
      '在「OAuth2 → URL Generator」中勾选 <code>bot</code> scope 和所需权限，生成邀请链接将 Bot 拉入服务器',
      '复制 Bot Token 填入下方表单，校验后保存',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/discord" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Discord 接入</a></div>',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: 'MTExxxxxxxxx.Gxxxxxx.xxxxxxxx', secret: true, required: true },
    ],
    configKey: 'discord',
    pairingChannel: 'discord',
  },
  slack: {
    label: 'Slack',
    iconName: 'hash',
    desc: 'Slack 工作区机器人，支持 Socket Mode 长连接',
    guide: [
      '打开 <a href="https://api.slack.com/apps" target="_blank" style="color:var(--accent);text-decoration:underline">Slack API</a>，点击「Create New App」→「From scratch」',
      '在「Socket Mode」中开启 Socket Mode 并生成 <b>App-Level Token</b>（需要 <code>connections:write</code> scope）',
      '在「OAuth & Permissions」中添加 Bot Token Scopes：<code>chat:write</code>、<code>app_mentions:read</code> 等，安装到工作区后复制 <b>Bot Token</b>',
      '如改用 HTTP 事件订阅模式，请在「Event Subscriptions」中开启事件订阅，添加 <code>message.im</code>、<code>app_mention</code> 等事件，并填入 Signing Secret',
      '将 Bot Token 与对应模式所需字段填入下方表单，校验后保存',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/slack" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Slack 接入</a></div>',
    fields: [
      {
        key: 'mode', label: '接入模式', type: 'select', required: true,
        options: [
          { value: 'socket', label: 'Socket Mode（推荐，无需公网）' },
          { value: 'http', label: 'HTTP Event Subscriptions（需公网）' },
        ],
      },
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-xxxxxxxxxxxx', secret: true, required: true },
      { key: 'appToken', label: 'App Token', placeholder: 'xapp-xxxxxxxxxxxx', secret: true, requiredWhen: { mode: 'socket' }, hint: 'Socket Mode 必填，需具备 connections:write scope' },
      { key: 'signingSecret', label: 'Signing Secret', placeholder: 'Slack Event Subscriptions 签名密钥', secret: true, requiredWhen: { mode: 'http' }, hint: '仅 HTTP 模式必填' },
      { key: 'teamId', label: 'Team ID', placeholder: '可选，用于固定工作区', required: false },
      { key: 'webhookPath', label: 'Webhook Path', placeholder: '/slack/events（HTTP 模式可选）', required: false },
      { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'allow', label: '允许私聊' }, { value: 'deny', label: '拒绝私聊' }], required: false },
      { key: 'groupPolicy', label: '群组策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'all', label: '允许所有频道' }, { value: 'mentioned', label: '仅 @ 机器人' }, { value: 'allowlist', label: '仅 allowFrom 白名单' }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: '逗号分隔用户/频道 ID，可留空', required: false, hint: '用于 allowlist 模式' },
    ],
    configKey: 'slack',
    pairingChannel: 'slack',
  },
  // WhatsApp 已移除：上游插件运行时未加载，web.login.start 返回 "not available"
  // 等上游修复后可重新启用
  weixin: {
    label: '微信',
    iconName: 'message-circle',
    desc: '微信官方 ClawBot 插件，由腾讯微信团队出品',
    guide: [
      '点击下方「一键安装插件」，自动安装 <code>@tencent-weixin/openclaw-weixin</code> 并启用',
      '安装完成后点击「扫码登录」，终端会显示二维码',
      '用手机微信扫描二维码并在手机上确认授权',
      '登录凭证自动保存，随后重启 Gateway 即可收发消息',
      '支持多账号：每次扫码登录会创建新的账号条目',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">来源：<a href="https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin" target="_blank" style="color:var(--accent);text-decoration:underline">npm @tencent-weixin/openclaw-weixin</a> · 腾讯微信团队官方出品</div>',
    actions: [
      { id: 'install', label: '一键安装插件', hint: '执行 npx @tencent-weixin/openclaw-weixin-cli install，自动安装并启用插件' },
      { id: 'login', label: '扫码登录', hint: '执行 openclaw channels login --channel openclaw-weixin，终端显示 QR 码' },
    ],
    fields: [],
    configKey: 'openclaw-weixin',
    panelSupport: 'action-only',
  },
  msteams: {
    label: 'Microsoft Teams',
    iconName: 'users',
    desc: 'Microsoft Teams 机器人，企业协作场景接入',
    guide: [
      '在 <a href="https://dev.teams.microsoft.com/bots" target="_blank" style="color:var(--accent);text-decoration:underline">Teams Developer Portal</a> 中创建 Bot',
      '在 Azure AD 中注册应用，获取 <b>App ID</b> 和 <b>App Password</b>',
      '配置 Bot Endpoint（需要公网可访问的 HTTPS 地址）或按上游插件要求填写回调路径',
      '将凭证与租户信息填入下方表单保存',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/msteams" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Teams 接入</a></div>',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'Azure AD Application ID', required: true },
      { key: 'appPassword', label: 'App Password', placeholder: 'Azure AD Client Secret', secret: true, required: true },
      { key: 'tenantId', label: 'Tenant ID', placeholder: '组织租户 ID（可选但建议填写）', required: false },
      { key: 'botEndpoint', label: 'Bot Endpoint', placeholder: 'https://example.com/api/teams/messages', required: false },
      { key: 'webhookPath', label: 'Webhook Path', placeholder: '/msteams/messages', required: false },
      { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'allow', label: '允许私聊' }, { value: 'deny', label: '拒绝私聊' }], required: false },
      { key: 'groupPolicy', label: '群组策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'all', label: '允许所有团队/频道' }, { value: 'mentioned', label: '仅 @ 机器人' }, { value: 'allowlist', label: '仅 allowFrom 白名单' }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: '逗号分隔 team/channel/user ID', required: false },
    ],
    configKey: 'msteams',
    pluginRequired: '@openclaw/msteams@latest',
    pluginId: 'msteams',
  },
  signal: {
    label: 'Signal',
    iconName: 'shield',
    desc: '隐私优先的 Signal 消息接入，需要运行 signal-cli',
    guide: [
      '安装 <a href="https://github.com/AsamK/signal-cli" target="_blank" style="color:var(--accent);text-decoration:underline">signal-cli</a> 并注册 Signal 号码',
      '运行 <code>signal-cli -a +号码 daemon --http</code> 启动 HTTP 模式',
      '在下方填写已注册号码与 signal-cli / HTTP 信息，保存后即可让 OpenClaw 连接现有守护进程',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/signal" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Signal 接入</a></div>',
    fields: [
      { key: 'account', label: '号码', placeholder: '+8613800138000（E.164 格式）', required: true },
      { key: 'cliPath', label: 'signal-cli 路径', placeholder: '可选，如 C:/tools/signal-cli/bin/signal-cli.bat', required: false },
      { key: 'httpUrl', label: 'HTTP URL', placeholder: '可选，如 http://127.0.0.1:8080', required: false },
      { key: 'httpHost', label: 'HTTP Host', placeholder: '可选，如 127.0.0.1', required: false },
      { key: 'httpPort', label: 'HTTP Port', placeholder: '可选，如 8080', required: false },
      { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'allow', label: '允许私聊' }, { value: 'deny', label: '拒绝私聊' }], required: false },
      { key: 'groupPolicy', label: '群组策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'all', label: '允许所有群组' }, { value: 'mentioned', label: '仅提及机器人' }, { value: 'allowlist', label: '仅 allowFrom 白名单' }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: '逗号分隔用户或群组标识', required: false },
    ],
    configKey: 'signal',
  },
  matrix: {
    label: 'Matrix',
    iconName: 'globe',
    desc: '去中心化通讯协议 Matrix，支持 Element 等客户端',
    guide: [
      '在任意 Matrix 服务器注册一个 Bot 账号（如 <a href="https://app.element.io/" target="_blank" style="color:var(--accent);text-decoration:underline">Element</a>）',
      '获取 Access Token（可通过 Element Settings → Help → Access Token 复制）',
      '填入 Homeserver 地址和 Access Token；若你使用用户名密码登录，也可补充 User ID / Password / Device ID',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">官方文档：<a href="https://openclawdoc.org/channels/matrix" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw Matrix 接入</a></div>',
    fields: [
      { key: 'homeserver', label: 'Homeserver', placeholder: 'https://matrix.org', required: true },
      { key: 'accessToken', label: 'Access Token', placeholder: 'syt_xxxxx', secret: true, required: false, hint: '推荐直接使用 Access Token；若留空，请至少补充 User ID + Password' },
      { key: 'userId', label: 'User ID', placeholder: '@bot:matrix.org', required: false },
      { key: 'password', label: 'Password', placeholder: '若通过密码登录则填写', secret: true, required: false },
      { key: 'deviceId', label: 'Device ID', placeholder: '可选，如 CLAWPANEL', required: false },
      { key: 'e2ee', label: 'E2EE', type: 'select', options: [{ value: '', label: '默认' }, { value: 'true', label: '启用' }, { value: 'false', label: '禁用' }], required: false },
      { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'allow', label: '允许私聊' }, { value: 'deny', label: '拒绝私聊' }], required: false },
      { key: 'groupPolicy', label: '群组策略', type: 'select', options: [{ value: '', label: '默认' }, { value: 'all', label: '允许所有房间' }, { value: 'mentioned', label: '仅提及机器人' }, { value: 'allowlist', label: '仅 allowFrom 白名单' }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: '逗号分隔 userId / roomId', required: false },
    ],
    configKey: 'matrix',
    pluginRequired: '@openclaw/matrix@latest',
    pluginId: 'matrix',
  },
}

// ── 页面生命周期 ──

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">消息渠道</h1>
      <p class="page-desc">渠道列表管理接入；在 Agent 对接页为每个 Agent 绑定多条渠道路由，配置相互独立，并支持渠道连通性测试</p>
    </div>
    <div class="tab-bar" id="channels-page-tabs">
      <div class="tab active" data-ch-tab="channels">渠道列表</div>
      <div class="tab" data-ch-tab="agents">Agent 对接</div>
    </div>
    <div id="channels-panel-list" class="channels-tab-panel">
      <div id="platforms-configured" style="margin-bottom:var(--space-lg)"></div>
      <div class="config-section">
        <div class="config-section-title">可接入平台</div>
        <div id="platforms-available" class="platforms-grid"></div>
      </div>
    </div>
    <div id="channels-panel-agents" class="channels-tab-panel" style="display:none">
      <p class="form-hint" style="margin-bottom:var(--space-md)">每个 Agent 可绑定多条路由（例如不同账号或匹配条件）；绑定之间互不影响。请先在「渠道列表」中完成渠道接入。</p>
      <div id="agents-bindings-root"></div>
    </div>
  `

  bindChannelTabs(page)

  const state = { configured: [], bindings: [], agents: [] }
  await loadPlatforms(page, state)

  return page
}

function bindChannelTabs(page) {
  page.querySelectorAll('#channels-page-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.chTab
      page.querySelectorAll('#channels-page-tabs .tab').forEach(t => t.classList.toggle('active', t === tab))
      const listEl = page.querySelector('#channels-panel-list')
      const agentsEl = page.querySelector('#channels-panel-agents')
      if (listEl) listEl.style.display = key === 'channels' ? '' : 'none'
      if (agentsEl) agentsEl.style.display = key === 'agents' ? '' : 'none'
    })
  })
}

export function cleanup() {}

// ── 数据加载 ──

async function loadPlatforms(page, state) {
  try {
    const list = await api.listConfiguredPlatforms()
    state.configured = Array.isArray(list) ? list : []
  } catch (e) {
    toast('加载平台列表失败: ' + e, 'error')
    state.configured = []
  }
  try {
    const res = await api.listAllBindings()
    state.bindings = Array.isArray(res?.bindings) ? res.bindings : []
  } catch {
    state.bindings = []
  }
  try {
    state.agents = await api.listAgents()
    if (!Array.isArray(state.agents)) state.agents = []
  } catch {
    state.agents = []
  }
  renderConfigured(page, state)
  renderAvailable(page, state)
  renderAgentBindings(page, state)
}

// ── 已配置平台渲染 ──

// ── 多账号支持的平台（历史配置中飞书/钉钉等多实例仍展示子账号行） ──
const MULTI_INSTANCE_PLATFORMS = ['feishu', 'dingtalk', 'qqbot']

function platformLabel(pid) {
  return PLATFORM_REGISTRY[pid]?.label || CHANNEL_LABELS[pid] || pid
}

function renderConfigured(page, state) {
  const el = page.querySelector('#platforms-configured')
  if (!state.configured.length) {
    el.innerHTML = ''
    return
  }

  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">已接入</div>
      <div class="platforms-grid">
        ${state.configured.map(p => {
          const reg = PLATFORM_REGISTRY[p.id]
          const label = platformLabel(p.id)
          const ic = icon(reg?.iconName || 'radio', 22)
          const channelKey = getChannelBindingKey(p.id)
          const accounts = Array.isArray(p.accounts) ? p.accounts : []
          const hasAccounts = accounts.length > 0
          const supportsMulti = MULTI_INSTANCE_PLATFORMS.includes(p.id)

          if (hasAccounts) {
            const accountsHtml = accounts.map(acc => {
              const accId = acc.accountId || 'default'
              const accBindings = (state.bindings || []).filter(b =>
                b.match?.channel === channelKey && (b.match?.accountId || '') === (acc.accountId || '')
              )
              const accAgents = accBindings.map(b => b.agentId || 'main')
              const showBadge = accAgents.length > 0 && !(accAgents.length === 1 && accAgents[0] === 'main')
              const badgesHtml = showBadge ? accAgents.map(a =>
                `<span class="agent-badge">\u2192 ${escapeAttr(a)}</span>`
              ).join(' ') : ''
              return `
                <div class="account-item" data-account="${escapeAttr(acc.accountId || '')}">
                  <span class="account-id">${escapeAttr(accId)}</span>
                  ${acc.appId ? `<span class="account-appid">${escapeAttr(acc.appId)}</span>` : ''}
                  ${badgesHtml}
                  <span class="account-actions">
                    <button class="btn btn-xs btn-secondary" data-action="edit-account" data-account-id="${escapeAttr(acc.accountId || '')}">${icon('edit', 12)} 编辑</button>
                    <button class="btn btn-xs btn-danger" data-action="remove-account" data-account-id="${escapeAttr(acc.accountId || '')}">${icon('trash', 12)}</button>
                  </span>
                </div>
              `
            }).join('')

            return `
              <div class="platform-card ${p.enabled ? 'active' : 'inactive'}" data-pid="${p.id}">
                <div class="platform-card-header">
                  <span class="platform-emoji">${ic}</span>
                  <span class="platform-name">${label}</span>
                  <span class="account-count">${accounts.length} 个账号</span>
                  <span class="platform-status-dot ${p.enabled ? 'on' : 'off'}"></span>
                </div>
                <div class="platform-accounts">${accountsHtml}</div>
                <div class="platform-card-actions">
                  ${supportsMulti ? `<button class="btn btn-sm btn-secondary" data-action="add-account">${icon('plus', 14)} 添加账号</button>` : ''}
                  ${reg ? `<button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)} 编辑默认</button>` : `<span class="form-hint" style="align-self:center">无向导</span>`}
                  <button class="btn btn-sm btn-secondary" data-action="toggle">${p.enabled ? icon('pause', 14) + ' 禁用' : icon('play', 14) + ' 启用'}</button>
                  <button class="btn btn-sm btn-danger" data-action="remove">${icon('trash', 14)}</button>
                </div>
              </div>
            `
          }

          const allBindings = (state.bindings || []).filter(b => b.match?.channel === channelKey)
          const boundAgents = allBindings.map(b => b.agentId || 'main')
          const showAll = boundAgents.length > 1 || (boundAgents.length === 1 && boundAgents[0] !== 'main')
          const agentBadges = showAll ? boundAgents.map(a =>
            `<span style="font-size:var(--font-size-xs);color:var(--accent);background:var(--accent-muted);padding:1px 6px;border-radius:10px;white-space:nowrap">\u2192 ${escapeAttr(a)}</span>`
          ).join(' ') : ''
          return `
            <div class="platform-card ${p.enabled ? 'active' : 'inactive'}" data-pid="${p.id}">
              <div class="platform-card-header">
                <span class="platform-emoji">${ic}</span>
                <span class="platform-name">${label}</span>
                ${agentBadges}
                <span class="platform-status-dot ${p.enabled ? 'on' : 'off'}"></span>
              </div>
              <div class="platform-card-actions">
                ${supportsMulti ? `<button class="btn btn-sm btn-secondary" data-action="add-account">${icon('plus', 14)} 添加账号</button>` : ''}
                ${reg ? `<button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)} 编辑</button>` : `<span class="form-hint" style="align-self:center">无向导</span>`}
                <button class="btn btn-sm btn-secondary" data-action="toggle">${p.enabled ? icon('pause', 14) + ' 禁用' : icon('play', 14) + ' 启用'}</button>
                <button class="btn btn-sm btn-danger" data-action="remove">${icon('trash', 14)}</button>
              </div>
            </div>
          `
        }).join('')}
      </div>
    </div>
  `

  // 已接入平台的操作选项弹窗
  function showPlatformActionMenu(pid, page, state) {
    const configured = state.configured.find(p => p.id === pid)
    if (!configured) return

    const accounts = Array.isArray(configured.accounts) ? configured.accounts : []
    const hasAccounts = accounts.length > 0
    const supportsMulti = MULTI_INSTANCE_PLATFORMS.includes(pid)

    // 统计当前 channel+accountId 组合已有的 agent 绑定
    const channelKey = getChannelBindingKey(pid)
    const getBindingInfo = (accountId) => {
      const bindings = (state.bindings || []).filter(b =>
        b.match?.channel === channelKey &&
        (b.match?.accountId || '') === (accountId || '')
      )
      return bindings.map(b => b.agentId || 'main')
    }

    const actions = []
    if (hasAccounts) {
      accounts.forEach(acc => {
        const accId = acc.accountId || 'default'
        const agents = getBindingInfo(acc.accountId || '')
        actions.push({
          label: `${icon('edit', 14)} 编辑账号「${accId}」${acc.appId ? ' · ' + acc.appId : ''}`,
          sub: agents.length ? `已绑定: ${agents.join(', ')}` : '尚未绑定 Agent',
          onClick: () => openConfigDialog(pid, page, state, acc.accountId || '')
        })
        actions.push({
          label: `${icon('link', 14)} 为此账号添加 Agent 绑定`,
          sub: '在「Agent 对接」页添加，或在此快速添加',
          onClick: () => openAddAgentBindingModalForAccount(pid, acc.accountId || '', page, state)
        })
      })
    } else {
      const agents = getBindingInfo('')
      actions.push({
        label: `${icon('edit', 14)} 编辑配置`,
        sub: agents.length ? `已绑定: ${agents.join(', ')}` : '尚未绑定 Agent',
        onClick: () => openConfigDialog(pid, page, state, null)
      })
      actions.push({
        label: `${icon('link', 14)} 添加 Agent 绑定`,
        sub: '将消息路由到指定 Agent',
        onClick: () => openAddAgentBindingModalForAccount(pid, null, page, state)
      })
    }

    if (supportsMulti) {
      actions.push({
        label: `${icon('plus', 14)} 添加新账号`,
        sub: '每个账号可绑定不同 Agent',
        onClick: () => openConfigDialog(pid, page, state, '')
      })
    }

    const actionHtml = actions.map(a => `
      <button class="btn btn-secondary" style="justify-content:flex-start;text-align:left;padding:10px 14px" data-action="run">
        <div style="font-weight:500;margin-bottom:2px">${a.label}</div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">${a.sub}</div>
      </button>
    `).join('')

    const modal = showContentModal({
      title: `${platformLabel(pid)} 操作`,
      content: `<div style="display:flex;flex-direction:column;gap:8px">${actionHtml}</div>`,
      width: 400,
    })

    modal.querySelectorAll('[data-action="run"]').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        modal.close?.() || modal.remove?.()
        actions[i].onClick()
      })
    })
  }

  // 快速为指定 channel+accountId 添加 Agent 绑定（不打开完整配置弹窗）
  async function openAddAgentBindingModalForAccount(pid, accountId, page, state) {
    const agents = Array.isArray(state.agents) ? state.agents : []
    if (!agents.length) {
      toast('请先在「Agent 管理」中创建 Agent', 'warning')
      return
    }

    const configured = state.configured.find(p => p.id === pid)
    const channelKey = getChannelBindingKey(pid)

    const agentOptions = agents.map(a => {
      const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
      return `<option value="${escapeAttr(a.id)}">${a.id}${a.id !== label ? ' — ' + escapeAttr(label) : ''}</option>`
    }).join('')

    const accountLabel = accountId ? `账号「${accountId}」` : '默认账号'

    const modal = showContentModal({
      title: `为 ${platformLabel(pid)} ${accountLabel} 绑定 Agent`,
      content: `
        <div class="form-group">
          <label class="form-label">目标 Agent</label>
          <select class="form-input" id="quick-bind-agent">
            ${agentOptions}
          </select>
          <div class="form-hint">消息将路由到选定的 Agent。注意：同一渠道+账号可以绑定多个 Agent（不同 peer 条件）。</div>
        </div>
        <div class="form-group">
          <label class="form-label">会话范围</label>
          <select class="form-input" id="quick-bind-peer-kind">
            <option value="">所有消息（不限制）</option>
            <option value="direct">指定私聊用户</option>
            <option value="group">指定群组</option>
          </select>
          <div class="form-hint" id="quick-bind-peer-hint">不限制：所有匹配该渠道的消息都由本 Agent 处理。</div>
        </div>
        <div class="form-group" id="quick-bind-peer-id-wrap" style="display:none">
          <label class="form-label" id="quick-bind-peer-id-label">目标 ID</label>
          <input class="form-input" id="quick-bind-peer-id" placeholder="加载中…">
          <div class="form-hint" id="quick-bind-peer-id-hint"></div>
        </div>
      `,
      buttons: [{ label: '保存绑定', className: 'btn btn-primary', id: 'btn-quick-bind-save' }],
      width: 440,
    })

    const PEER_KIND_HINTS = {
      '': '不限制：所有匹配该渠道的消息都由本 Agent 处理。',
      direct: '指定私聊用户：仅当用户向机器人发私信时路由到本 Agent。可填用户的 open_id（格式 ou_xxx）。',
      group: '指定群组：仅当在指定群内收到机器人被 @ 的消息时路由到本 Agent。可填群 chat_id（格式 oc_xxx）。',
    }
    const PEER_HINT_LABELS = {
      direct: '用户 open_id（ou_xxx）',
      group: '群 chat_id（oc_xxx）',
    }

    const selPeerKind = modal.querySelector('#quick-bind-peer-kind')
    const peerHint = modal.querySelector('#quick-bind-peer-hint')
    const wrapPeerId = modal.querySelector('#quick-bind-peer-id-wrap')
    const inpPeerId = modal.querySelector('#quick-bind-peer-id')
    const lblPeerId = modal.querySelector('#quick-bind-peer-id-label')
    const hintPeerId = modal.querySelector('#quick-bind-peer-id-hint')

    selPeerKind?.addEventListener('change', () => {
      const kind = selPeerKind.value
      if (peerHint) peerHint.textContent = PEER_KIND_HINTS[kind] || ''
      if (kind) {
        wrapPeerId.style.display = ''
        if (lblPeerId) lblPeerId.textContent = PEER_HINT_LABELS[kind] || '目标 ID'
        if (inpPeerId) inpPeerId.placeholder = kind === 'direct' ? 'ou_xxxxxxxxxxxxxxxx' : 'oc_xxxxxxxxxxxxxxxx'
        if (hintPeerId) hintPeerId.innerHTML = `查看 Gateway 日志中收到的消息，或发一条消息测试路由。`
      } else {
        wrapPeerId.style.display = 'none'
        if (inpPeerId) inpPeerId.value = ''
      }
    })

    modal.querySelector('#btn-quick-bind-save').onclick = async () => {
      const agentId = modal.querySelector('#quick-bind-agent')?.value
      if (!agentId) return
      const peerKind = selPeerKind?.value || ''
      const peerId = inpPeerId?.value?.trim() || ''

      // 检查重复
      const dup = (state.bindings || []).some(b => {
        const bm = b.match || {}
        const bp = bm.peer
        return (b.agentId || 'main') === agentId &&
          bm.channel === channelKey &&
          (bm.accountId || '') === (accountId || '') &&
          ((bp?.kind || bp) ? (bp?.kind || bp) === peerKind : !peerKind) &&
          ((bp?.id) ? bp.id === peerId : !peerId)
      })
      if (dup) {
        toast('该 Agent 已存在相同的渠道、账号、会话范围绑定', 'warning')
        return
      }

      let bindingConfig = {}
      if (peerKind === 'direct' && peerId) {
        bindingConfig.peer = { kind: 'direct', id: peerId }
      } else if (peerKind === 'group' && peerId) {
        bindingConfig.peer = { kind: 'group', id: peerId }
      }

      modal.querySelector('#btn-quick-bind-save').disabled = true
      modal.querySelector('#btn-quick-bind-save').textContent = '保存中…'
      try {
        await api.saveAgentBinding(agentId, channelKey, accountId, bindingConfig)
        toast('绑定已保存', 'success')
        modal.close?.() || modal.remove?.()
        await loadPlatforms(page, state)
      } catch (e) {
        toast('保存失败: ' + e, 'error')
      } finally {
        modal.querySelector('#btn-quick-bind-save').disabled = false
        modal.querySelector('#btn-quick-bind-save').textContent = '保存绑定'
      }
    }
  }

  el.querySelectorAll('.platform-card').forEach(card => {
    const pid = card.dataset.pid
    // 点击卡片区域弹出操作菜单（不再直接进入编辑）
    card.querySelector('.platform-card-header')?.addEventListener('click', (e) => {
      // 忽略按钮的点击（按钮有自己的事件）
      if (e.target.closest('button')) return
      showPlatformActionMenu(pid, page, state)
    })

    card.querySelector('[data-action="add-account"]')?.addEventListener('click', () => openConfigDialog(pid, page, state, ''))
    card.querySelector('[data-action="edit"]')?.addEventListener('click', () => openConfigDialog(pid, page, state))

    card.querySelectorAll('[data-action="edit-account"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const accountId = btn.dataset.accountId
        openConfigDialog(pid, page, state, accountId)
      })
    })
    card.querySelectorAll('[data-action="remove-account"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const accountId = btn.dataset.accountId
        const displayName = accountId ? `${platformLabel(pid)} 账号「${accountId}」` : `${platformLabel(pid)} 默认账号`
        const yes = await showConfirm(`确定移除 ${displayName}？该账号配置将被删除。`)
        if (!yes) return
        try {
          await api.removeMessagingPlatform(pid, accountId || null)
          toast('已移除', 'info')
          await loadPlatforms(page, state)
        } catch (e) { toast('移除失败: ' + e, 'error') }
      })
    })

    card.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
      const cur = state.configured.find(p => p.id === pid)
      if (!cur) return
      try {
        await api.toggleMessagingPlatform(pid, !cur.enabled)
        toast(`${platformLabel(pid)} 已${cur.enabled ? '禁用' : '启用'}`, 'success')
        await loadPlatforms(page, state)
      } catch (e) { toast('操作失败: ' + e, 'error') }
    })
    card.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
      const yes = await showConfirm(`确定移除 ${platformLabel(pid)}？配置将被删除。`)
      if (!yes) return
      try {
        await api.removeMessagingPlatform(pid)
        toast('已移除', 'info')
        await loadPlatforms(page, state)
      } catch (e) { toast('移除失败: ' + e, 'error') }
    })
  })
}

// ── 可接入平台渲染 ──

function renderAvailable(page, state) {
  const el = page.querySelector('#platforms-available')
  const configuredIds = new Set(state.configured.map(p => p.id))

  el.innerHTML = Object.entries(PLATFORM_REGISTRY).map(([pid, reg]) => {
    const done = configuredIds.has(pid)
    return `
      <button class="platform-pick" data-pid="${pid}">
        <span class="platform-emoji">${icon(reg.iconName, 28)}</span>
        <span class="platform-pick-name">${reg.label}</span>
        <span class="platform-pick-desc">${reg.desc}</span>
        ${reg.actions?.length ? `<span class="platform-pick-badge" style="color:var(--accent)">支持运行前动作</span>` : ''}
        ${done ? `<span class="platform-pick-badge" style="color:var(--success)">已接入 · 点击编辑</span>` : ''}
      </button>
    `
  }).join('')

  el.querySelectorAll('.platform-pick').forEach(btn => {
    const pid = btn.dataset.pid
    btn.onclick = () => openConfigDialog(pid, page, state)
  })
}

// ── Agent 对接：按 Agent 管理多条渠道绑定 ──

/** openclaw binding.match.channel → listConfiguredPlatforms 的 id（read_platform_config 的 platform） */
function bindingChannelToPlatformId(channel) {
  if (!channel) return ''
  if (channel === 'dingtalk-connector') return 'dingtalk'
  if (channel === 'openclaw-weixin') return 'weixin'
  return channel
}

function channelKeyLabel(ch) {
  const pid = bindingChannelToPlatformId(ch)
  return CHANNEL_LABELS[pid] || CHANNEL_LABELS[ch] || ch || '—'
}

function formatBindingMatchSummary(binding) {
  const match = binding?.match || {}
  const peer = match?.peer
  const parts = [channelKeyLabel(match.channel)]
  if (match.accountId) parts.push(`账号 ${match.accountId}`)
  if (peer) {
    if (typeof peer === 'string') {
      parts.push(`私聊 ${peer}`)
    } else if (typeof peer === 'object' && peer) {
      const kindLabel = peer.kind === 'group' ? '群组' : peer.kind === 'channel' ? '频道' : '私聊'
      parts.push(`${kindLabel} ${peer.id || ''}`)
    }
  }
  return parts.join(' · ')
}

function collectAgentBindingRows(state) {
  const agents = Array.isArray(state.agents) ? state.agents : []
  const byId = new Map(agents.map(a => [a.id, a]))
  const bindingAgentIds = new Set()
  for (const b of state.bindings || []) {
    bindingAgentIds.add(b.agentId || 'main')
  }
  const rows = agents.map(a => ({ ...a, orphan: false }))
  for (const id of bindingAgentIds) {
    if (!byId.has(id)) {
      rows.push({ id, identityName: '', orphan: true })
    }
  }
  return rows
}

function renderAgentBindings(page, state) {
  const root = page.querySelector('#agents-bindings-root')
  if (!root) return

  const rows = collectAgentBindingRows(state)
  if (!rows.length) {
    root.innerHTML = `<div class="stat-card" style="padding:var(--space-xl);text-align:center;color:var(--text-tertiary)">暂无 Agent，请先在「Agent 管理」中创建。</div>`
    return
  }

  const configured = state.configured || []
  const canBind = configured.filter(p => p.enabled !== false)

  root.innerHTML = rows.map(agent => {
    const aid = agent.id
    const display = agent.identityName ? agent.identityName.split(',')[0].trim() : ''
    const subtitle = agent.orphan
      ? '<span style="color:var(--warning)">配置中存在绑定，但当前 Agent 列表中无此 ID</span>'
      : (display && display !== aid ? escapeAttr(display) : '')
    const list = (state.bindings || []).filter(b => (b.agentId || 'main') === aid)
    const rowsHtml = list.length
      ? list.map((b, idx) => {
        const match = b.match || {}
        const ch = match.channel || ''
        const acct = match.accountId || ''
        const summary = formatBindingMatchSummary(b)
        return `
          <div class="agent-binding-row" data-agent="${escapeAttr(aid)}" data-idx="${idx}">
            <div class="agent-binding-row-main">
              <span class="agent-binding-channel">${escapeAttr(summary)}</span>
              <span class="form-hint" style="font-family:var(--font-mono);font-size:11px">${escapeAttr(ch)}${acct ? ' · ' + escapeAttr(acct) : ''}</span>
            </div>
            <div class="agent-binding-row-actions">
              <button type="button" class="btn btn-xs btn-secondary" data-action="test-binding">${icon('zap', 12)} 联通诊断</button>
              <button type="button" class="btn btn-xs btn-danger" data-action="del-binding">${icon('trash', 12)} 移除</button>
            </div>
          </div>`
      }).join('')
      : `<div class="form-hint" style="padding:8px 0">尚未绑定任何渠道</div>`

    const addDisabled = !canBind.length ? 'disabled' : ''
    return `
      <div class="agent-binding-card" data-agent-id="${escapeAttr(aid)}">
        <div class="agent-binding-card-head">
          <div>
            <div class="agent-binding-title">${icon('package', 18)} <code style="font-size:var(--font-size-sm)">${escapeAttr(aid)}</code></div>
            ${subtitle ? `<div class="form-hint" style="margin-top:4px">${subtitle}</div>` : ''}
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-action="add-binding" ${addDisabled}>${icon('plus', 14)} 添加渠道绑定</button>
        </div>
        <div class="agent-binding-list">${rowsHtml}</div>
      </div>`
  }).join('')

  root.querySelectorAll('[data-action="add-binding"]').forEach(btn => {
    if (btn.disabled) {
      btn.title = '请先在「渠道列表」中接入并启用至少一个渠道'
      return
    }
    btn.addEventListener('click', () => {
      const card = btn.closest('.agent-binding-card')
      openAddAgentBindingModal(card?.dataset.agentId, page, state)
    })
  })

  root.querySelectorAll('[data-action="test-binding"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.agent-binding-row')
      const aid = row?.dataset.agent
      const idx = Number(row?.dataset.idx)
      const list = (state.bindings || []).filter(b => (b.agentId || 'main') === aid)
      const binding = list[idx]
      if (!binding) return
      await runChannelTestForBinding(binding, btn)
    })
  })

  root.querySelectorAll('[data-action="del-binding"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.agent-binding-row')
      const aid = row?.dataset.agent
      const idx = Number(row?.dataset.idx)
      const list = (state.bindings || []).filter(b => (b.agentId || 'main') === aid)
      const binding = list[idx]
      if (!binding) return
      const match = binding.match || {}
      const ch = match.channel
      const acct = match.accountId || null
      const yes = await showConfirm(`移除 Agent「${aid}」的这条渠道绑定？\n${formatBindingMatchSummary(binding)}`)
      if (!yes) return
      try {
        await api.deleteAgentBinding(aid, ch, acct)
        toast('已移除绑定', 'success')
        await loadPlatforms(page, state)
      } catch (e) {
        toast('移除失败: ' + e, 'error')
      }
    })
  })
}

async function openAddAgentBindingModal(agentId, page, state) {
  const configured = (state.configured || []).filter(p => p.enabled !== false)
  if (!configured.length) {
    toast('请先在「渠道列表」中接入渠道', 'warning')
    return
  }

  const platformOptions = configured.map(p => {
    const label = platformLabel(p.id)
    return `<option value="${escapeAttr(p.id)}">${escapeAttr(label)} (${escapeAttr(p.id)})</option>`
  }).join('')

  const modal = showContentModal({
    title: `为 Agent「${agentId}」添加渠道绑定`,
    content: `
      <div class="form-group">
        <label class="form-label">渠道</label>
        <select class="form-input" id="add-bind-platform">${platformOptions}</select>
        <div class="form-hint">每条绑定相互独立；同一渠道可绑定多次（需不同子账号或匹配条件）</div>
      </div>

      <!-- 子账号（多账号时可选） -->
      <div class="form-group" id="add-bind-account-wrap" style="display:none">
        <label class="form-label">子账号</label>
        <select class="form-input" id="add-bind-account"></select>
      </div>

      <!-- 会话范围 -->
      <div class="form-group" id="add-bind-peer-section">
        <label class="form-label">会话范围</label>
        <select class="form-input" id="add-bind-peer-kind">
          <option value="">所有消息（不限制）</option>
          <option value="direct">指定私聊用户</option>
          <option value="group">指定群组</option>
        </select>
        <div class="form-hint" id="add-bind-peer-kind-hint">不限制：所有匹配该渠道的消息都由本 Agent 处理。</div>
      </div>

      <!-- 目标 ID（选完 peerKind 后显示） -->
      <div class="form-group" id="add-bind-peer-id-wrap" style="display:none">
        <label class="form-label" id="add-bind-peer-id-label">目标 ID</label>
        <input class="form-input" id="add-bind-peer-id" placeholder="加载中…">
        <div class="form-hint" id="add-bind-peer-id-hint"></div>
      </div>

      <!-- 警告提示区 -->
      <div id="add-bind-warning" style="display:none;margin-top:var(--space-sm)"></div>
    `,
    buttons: [{ label: '保存绑定', className: 'btn btn-primary', id: 'btn-add-bind-save' }],
    width: 480,
  })

  const selPlat = modal.querySelector('#add-bind-platform')
  const wrapAcct = modal.querySelector('#add-bind-account-wrap')
  const selAcct = modal.querySelector('#add-bind-account')
  const selPeerKind = modal.querySelector('#add-bind-peer-kind')
  const peerHint = modal.querySelector('#add-bind-peer-kind-hint')
  const wrapPeerId = modal.querySelector('#add-bind-peer-id-wrap')
  const inpPeerId = modal.querySelector('#add-bind-peer-id')
  const lblPeerId = modal.querySelector('#add-bind-peer-id-label')
  const hintPeerId = modal.querySelector('#add-bind-peer-id-hint')
  const warnEl = modal.querySelector('#add-bind-warning')

  const PEER_KIND_HINTS = {
    '': '不限制：所有匹配该渠道的消息都由本 Agent 处理。',
    direct: '指定私聊用户：仅当用户向机器人发私信时路由到本 Agent。可填用户的 open_id（格式 ou_xxx）。',
    group: '指定群组：仅当在指定群内收到机器人被 @ 的消息时路由到本 Agent。可填群 chat_id（格式 oc_xxx）。',
  }

  const PEER_HINT_LABELS = {
    direct: '用户 open_id（ou_xxx）',
    group: '群 chat_id（oc_xxx）',
  }

  const showWarning = (msg, level = 'warning') => {
    warnEl.style.display = ''
    warnEl.innerHTML = `<div style="background:${level === 'error' ? 'var(--error-muted, #fee2e2)' : 'var(--warning-muted, #fef3c7)'};color:${level === 'error' ? 'var(--error)' : 'var(--warning)'};padding:8px 12px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">${escapeAttr(msg)}</div>`
  }

  const hideWarning = () => {
    warnEl.style.display = 'none'
    warnEl.innerHTML = ''
  }

  const syncAccounts = () => {
    const pid = selPlat?.value
    const p = configured.find(x => x.id === pid)
    const accounts = Array.isArray(p?.accounts) ? p.accounts : []
    if (accounts.length) {
      wrapAcct.style.display = ''
      selAcct.innerHTML = accounts.map(a => `<option value="${escapeAttr(a.accountId || '')}">${escapeAttr(a.accountId || 'default')}${a.appId ? ` · ${escapeAttr(a.appId)}` : ''}</option>`).join('')
    } else {
      // 无多账号时，也显示一行提示，方便用户去渠道列表添加
      wrapAcct.style.display = ''
      selAcct.innerHTML = `<option value="">— 该渠道暂无多账号 —</option>`
      selAcct.disabled = true
    }
  }

  // 当账号为空时，在 peer hint 里给出提示
  const syncPeerHint = () => {
    const kind = selPeerKind?.value || ''
    const noAccount = selAcct?.value === '' || selAcct?.disabled
    if (peerHint) {
      if (noAccount && !kind) {
        peerHint.textContent = '该渠道暂无多账号，绑定将路由到默认账号。如需多账号路由，请先在「渠道列表」为该渠道添加多个账号。'
      } else {
        peerHint.textContent = PEER_KIND_HINTS[kind] || ''
      }
    }
    if (kind) {
      wrapPeerId.style.display = ''
      if (lblPeerId) lblPeerId.textContent = PEER_HINT_LABELS[kind] || '目标 ID'
      if (inpPeerId) inpPeerId.placeholder = kind === 'direct' ? 'ou_xxxxxxxxxxxxxxxx' : 'oc_xxxxxxxxxxxxxxxx'
      if (hintPeerId) hintPeerId.innerHTML = `<b>如何获取？</b> 查看 Gateway 日志中收到的消息，或在飞书/机器人 DM 中发一条消息，日志中会打印 sender open_id / chat_id。也可先保存绑定，再发消息测试路由是否生效。`
    } else {
      wrapPeerId.style.display = 'none'
      if (inpPeerId) inpPeerId.value = ''
    }
    hideWarning()
  }

  selPlat?.addEventListener('change', () => { syncAccounts(); hideWarning() })
  selPeerKind?.addEventListener('change', syncPeerHint)

  syncAccounts()
  syncPeerHint()

  modal.querySelector('#btn-add-bind-save').onclick = async () => {
    const pid = selPlat?.value
    if (!pid) return
    const channelKey = getChannelBindingKey(pid)
    const accountId = (selAcct?.disabled || selAcct?.value === '' || selAcct?.value === '— 该渠道暂无多账号 —')
      ? null
      : (selAcct?.value?.trim() || null)
    const peerKind = selPeerKind?.value || ''
    const peerId = inpPeerId?.value?.trim() || ''

    // 检查重复绑定
    const dup = (state.bindings || []).some(b => {
      const bm = b.match || {}
      const bp = bm.peer
      return (b.agentId || 'main') === agentId &&
        bm.channel === channelKey &&
        (bm.accountId || '') === (accountId || '') &&
        ((bp?.kind || bp) ? (bp?.kind || bp) === peerKind : !peerKind) &&
        ((bp?.id) ? bp.id === peerId : !peerId)
    })
    if (dup) {
      toast('该 Agent 已存在相同的渠道、子账号与会话范围绑定', 'warning')
      return
    }

    // 构建 peer 配置
    let bindingConfig = {}
    if (peerKind === 'direct' && peerId) {
      bindingConfig.peer = { kind: 'direct', id: peerId }
    } else if (peerKind === 'group' && peerId) {
      bindingConfig.peer = { kind: 'group', id: peerId }
    }

    btnSave.disabled = true
    btnSave.textContent = '保存中…'
    try {
      const res = await api.saveAgentBinding(agentId, channelKey, accountId, bindingConfig)

      // 处理警告
      const warnings = res?.warnings || []
      if (warnings.length) {
        warnings.forEach(w => showWarning(w, 'warning'))
      }

      toast('绑定已保存', 'success')
      if (!warnings.length) {
        modal.close?.() || modal.remove?.()
      }
      await loadPlatforms(page, state)
    } catch (e) {
      toast('保存失败: ' + e, 'error')
    } finally {
      btnSave.disabled = false
      btnSave.textContent = '保存绑定'
    }
  }

  const btnSave = modal.querySelector('#btn-add-bind-save')
}

function openExternalUrl(href) {
  if (!href) return
  import('@tauri-apps/plugin-shell').then(({ open }) => open(href)).catch(() => window.open(href, '_blank'))
}

/** QQ：展示后端完整诊断（凭证 + Gateway + 插件 + chatCompletions）；可选一键修复插件 */
function showQqDiagnoseModal(result, options = {}) {
  const accountId = options.accountId != null ? options.accountId : null
  const faqUrl = result?.faqUrl || 'https://q.qq.com/qqbot/openclaw/faq.html'
  const checks = Array.isArray(result?.checks) ? result.checks : []
  const pluginFailed = checks.some(c => c.id === 'qq_plugin' && !c.ok)
  const list = checks.map(c => {
    const ok = !!c.ok
    const color = ok ? 'var(--success)' : 'var(--error)'
    const mark = ok ? '✓' : '✗'
    return `<div style="border-left:3px solid ${color};padding:10px 12px;margin-bottom:8px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;color:${color}">${mark} ${escapeAttr(c.title || '')}</div>
      <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-top:6px;line-height:1.55;white-space:pre-wrap">${escapeAttr(c.detail || '')}</div>
    </div>`
  }).join('')
  const hints = (result?.userHints || []).map(h =>
    `<li style="margin-bottom:8px;line-height:1.5">${escapeAttr(h)}</li>`
  ).join('')
  const summary = result?.overallReady
    ? `<div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:12px;font-size:var(--font-size-sm)">自动化检查均通过：已保存凭证、本机 Gateway、HTTP 健康、QQ 渠道开关、插件与 chatCompletions。若 QQ 端仍异常，请继续对照官方 FAQ（回调、网络、部署环境等）。</div>`
    : `<div style="background:var(--warning-muted);color:var(--warning);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:12px;font-size:var(--font-size-sm)">存在未通过项时，QQ 里常表现为「灵魂不在线」或无法回复。请按红项逐项处理；仅「校验凭证」通过<strong>不能</strong>代表机器人已在线。</div>`

  const repairHint = pluginFailed
    ? `<p class="form-hint" style="margin:10px 0 0;line-height:1.5">插件项未通过时，可尝试<strong>一键修复</strong>：自动安装 QQ 插件（若未安装）或写入 <code>plugins.allow</code> / <code>entries</code> 并重载 Gateway。</p>`
    : ''

  const buttons = []
  if (pluginFailed) {
    buttons.push({ label: '一键修复（安装/写入 plugins）', className: 'btn btn-primary', id: 'btn-diag-repair' })
  }
  buttons.push({
    label: '打开 QQ OpenClaw 常见问题',
    className: pluginFailed ? 'btn btn-secondary' : 'btn btn-primary',
    id: 'btn-diag-faq',
  })

  const diagModal = showContentModal({
    title: 'QQ 渠道联通诊断',
    content: `${summary}${repairHint}<div style="max-height:min(52vh,420px);overflow-y:auto;margin-bottom:12px;margin-top:12px">${list}</div><div style="font-weight:600;margin-bottom:8px;font-size:var(--font-size-sm)">说明</div><ul style="padding-left:18px;font-size:var(--font-size-sm);color:var(--text-secondary);margin:0">${hints}</ul>`,
    buttons,
    width: 540,
  })
  diagModal.querySelector('#btn-diag-faq')?.addEventListener('click', () => openExternalUrl(faqUrl))

  const repairBtn = diagModal.querySelector('#btn-diag-repair')
  repairBtn?.addEventListener('click', async () => {
    const prev = repairBtn.innerHTML
    try {
      repairBtn.disabled = true
      repairBtn.textContent = '处理中…'
      const out = await api.repairQqbotChannelSetup()
      toast(out?.message || '修复完成', 'success')
      const fresh = await api.diagnoseChannel('qqbot', accountId)
      diagModal.remove()
      showQqDiagnoseModal(fresh, { accountId })
    } catch (e) {
      toast('一键修复失败: ' + e, 'error')
    } finally {
      repairBtn.disabled = false
      repairBtn.innerHTML = prev
    }
  })
}

async function runChannelTestForBinding(binding, btnEl) {
  const match = binding?.match || {}
  const channel = match.channel
  const accountId = match.accountId || null
  const platformId = bindingChannelToPlatformId(channel)
  if (!platformId) {
    toast('无法识别渠道类型', 'warning')
    return
  }

  const prevHtml = btnEl?.innerHTML
  if (btnEl) {
    btnEl.disabled = true
    btnEl.textContent = channel === 'qqbot' ? '诊断中...' : '测试中...'
  }
  try {
    if (channel === 'qqbot') {
      const result = await api.diagnoseChannel('qqbot', accountId)
      showQqDiagnoseModal(result, { accountId })
      return
    }
    const res = await api.readPlatformConfig(platformId, accountId)
    if (!res?.exists) {
      toast('未找到该渠道在配置中的凭证，请先在「渠道列表」完成接入', 'warning')
      return
    }
    const form = res.values || {}
    const out = await api.verifyBotToken(platformId, form)
    if (out.valid) {
      const details = (out.details || []).join(' · ')
      toast(`渠道测试通过${details ? '：' + details : ''}`, 'success')
    } else {
      const errs = (out.errors || ['校验失败']).join('; ')
      toast('渠道测试未通过：' + errs, 'error')
    }
  } catch (e) {
    toast(channel === 'qqbot' ? '联通诊断失败: ' + e : '渠道测试失败: ' + e, 'error')
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      if (prevHtml != null) btnEl.innerHTML = prevHtml
    }
  }
}

// ── WhatsApp Gateway QR 登录 ──

async function handleGatewayWhatsAppLogin(btn, resultEl, actionDef) {
  const origLabel = btn.textContent
  btn.disabled = true
  btn.textContent = '连接 Gateway...'

  // 检查 Gateway WebSocket 是否已连接
  if (!wsClient.connected || !wsClient.gatewayReady) {
    resultEl.innerHTML = `
      <div style="background:var(--warning-muted);color:var(--warning);padding:12px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
        ${icon('alert-triangle', 14)} Gateway 未连接，无法启动扫码登录。请先确保 Gateway 已启动并在「对话」页面连接成功后再试。
      </div>`
    btn.disabled = false
    btn.textContent = origLabel
    return
  }

  resultEl.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:16px;text-align:center">
      <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:8px">正在生成 WhatsApp QR 码...</div>
      <div style="width:32px;height:32px;border:3px solid var(--border-primary);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto"></div>
    </div>`

  try {
    btn.textContent = '生成 QR 中...'
    const startResult = await wsClient.request('web.login.start', { force: false })

    if (!startResult?.qrDataUrl) {
      // 已链接或无 QR 数据
      resultEl.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:14px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.6">
          ${icon('check', 14)} ${escapeAttr(startResult?.message || 'WhatsApp 已链接，无需重新扫码')}
        </div>`
      btn.disabled = false
      btn.textContent = origLabel
      return
    }

    // 显示 QR 码
    resultEl.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:16px;text-align:center">
        <div style="font-size:var(--font-size-sm);font-weight:600;margin-bottom:8px;color:var(--text-primary)">用手机 WhatsApp 扫描此二维码</div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:12px">WhatsApp → 已连接的设备 → 连接设备</div>
        <img src="${startResult.qrDataUrl}" alt="WhatsApp QR" style="width:256px;height:256px;image-rendering:pixelated;border-radius:var(--radius-md);border:1px solid var(--border-primary)" />
        <div id="whatsapp-login-status" style="margin-top:12px;font-size:var(--font-size-xs);color:var(--text-tertiary)">等待扫码...</div>
      </div>`

    // 等待扫码完成
    btn.textContent = '等待扫码...'
    const statusEl = resultEl.querySelector('#whatsapp-login-status')

    const waitResult = await wsClient.request('web.login.wait', { timeoutMs: 120000 })

    if (waitResult?.connected) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--success);font-weight:600">${icon('check', 14)} 链接成功！</span>`
      resultEl.innerHTML = `
        <div style="background:var(--success-muted);color:var(--success);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
          ${icon('check', 14)} WhatsApp 链接成功！${escapeAttr(waitResult.message || '')}
        </div>`
      toast('WhatsApp 扫码链接成功', 'success')
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--warning)">${escapeAttr(waitResult?.message || '扫码超时')}</span>`
      resultEl.innerHTML = `
        <div style="background:var(--warning-muted);color:var(--warning);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
          ${icon('alert-triangle', 14)} ${escapeAttr(waitResult?.message || '扫码超时或未完成，请重试')}
        </div>`
    }
  } catch (e) {
    const msg = String(e?.message || e)
    // web login provider is not available = WhatsApp 插件未加载
    const hint = /not available|not supported/i.test(msg)
      ? '。请确认 Gateway 已启动且 WhatsApp 渠道已在 openclaw.json 中配置'
      : ''
    resultEl.innerHTML = `
      <div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
        ${icon('x', 14)} 扫码登录失败: ${escapeAttr(msg)}${hint}
      </div>`
  } finally {
    btn.disabled = false
    btn.textContent = origLabel
  }
}

// ── 配置弹窗（新增 / 编辑共用） ──

async function openConfigDialog(pid, page, state, accountId) {
  const reg = PLATFORM_REGISTRY[pid]
  if (!reg) { toast('未知平台', 'error'); return }

  if (reg.panelSupport === 'docs-only') {
    const docsOnlyContent = `
      ${reg.guide?.length ? `
        <details open style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);margin-bottom:var(--space-md)">
          <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">接入步骤</summary>
          <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
            ${reg.guide.map(s => `<li>${s}</li>`).join('')}
          </ol>
          ${reg.guideFooter || ''}
        </details>` : ''}
      <div style="background:rgba(245,158,11,0.12);color:#b45309;padding:12px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.7">
        <div style="font-weight:700;margin-bottom:6px">当前面板暂未完成该渠道的可用配置向导</div>
        <div>${reg.supportNote || '请先按上游文档或 CLI 完成接入。'}</div>
      </div>
    `

    const modal = showContentModal({
      title: `${reg.label} 接入说明`,
      content: docsOnlyContent,
      buttons: [
        { label: '知道了', className: 'btn btn-primary', id: 'btn-close' },
      ],
      width: 560,
    })
    modal.querySelector('#btn-close')?.addEventListener('click', () => modal.close?.() || modal.remove?.())
    modal.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]')
      if (!a) return
      const href = a.getAttribute('href')
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        e.preventDefault()
        openExternalUrl(href)
      }
    })
    return
  }

  if (reg.panelSupport === 'action-only') {
    const actionOnlyGuide = reg.guide?.length ? `
      <details open style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);margin-bottom:var(--space-md)">
        <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">接入步骤</summary>
        <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
          ${reg.guide.map(s => `<li>${s}</li>`).join('')}
        </ol>
        ${reg.guideFooter || ''}
      </details>` : ''

    const pluginStatusHtml = pid === 'weixin' ? `
      <div id="weixin-plugin-status" style="padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md);margin-bottom:var(--space-sm);font-size:var(--font-size-sm);color:var(--text-secondary)">
        检测插件状态…
      </div>` : ''

    const actionOnlyBtns = reg.actions?.length ? `
      <div style="padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
        <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:8px">操作</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${reg.actions.map(action => `<button type="button" class="btn btn-sm btn-primary" data-channel-action="${action.id}">${action.label}</button>`).join('')}
        </div>
        ${reg.actions.map(action => action.hint ? `<div class="form-hint" style="margin-top:6px">${action.label}：${action.hint}</div>` : '').join('')}
        <div id="channel-action-result" style="margin-top:10px"></div>
      </div>` : ''

    const modal = showContentModal({
      title: `${reg.label} 接入`,
      content: actionOnlyGuide + pluginStatusHtml + actionOnlyBtns,
      buttons: [
        { label: '关闭', className: 'btn btn-secondary', id: 'btn-close' },
      ],
      width: 560,
    })
    modal.querySelector('#btn-close')?.addEventListener('click', () => modal.close?.() || modal.remove?.())
    modal.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]')
      if (!a) return
      const href = a.getAttribute('href')
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        e.preventDefault()
        openExternalUrl(href)
      }
    })

    // 微信插件状态检测
    if (pid === 'weixin') {
      const statusEl = modal.querySelector('#weixin-plugin-status')
      if (statusEl) {
        api.checkWeixinPluginStatus().then(s => {
          if (!s) { statusEl.textContent = '无法获取插件状态'; return }
          const parts = []
          const installBtn = modal.querySelector('[data-channel-action="install"]')
          if (s.installed) {
            parts.push(`<span style="color:var(--success);font-weight:600">● 已安装</span>`)
            parts.push(`版本 <strong>${s.installedVersion || '未知'}</strong>`)
            if (s.updateAvailable && s.latestVersion) {
              parts.push(`<span style="color:var(--warning)">→ 新版 ${s.latestVersion} 可用，点击「升级插件」更新</span>`)
              if (installBtn) installBtn.textContent = '升级插件'
            } else if (s.latestVersion) {
              parts.push(`<span style="color:var(--text-tertiary)">（已是最新）</span>`)
            }
          } else {
            parts.push(`<span style="color:var(--text-tertiary)">○ 未安装</span>`)
            if (s.latestVersion) parts.push(`最新版 ${s.latestVersion}`)
            parts.push(`点击下方「一键安装插件」开始`)
          }
          statusEl.innerHTML = parts.join(' ')
        }).catch(() => { statusEl.textContent = '插件状态检测失败' })
      }
    }

    const actionResultEl = modal.querySelector('#channel-action-result')
    modal.querySelectorAll('[data-channel-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const actionId = btn.dataset.channelAction
        if (!actionId || !actionResultEl) return

        actionResultEl.innerHTML = `
          <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              ${icon('zap', 14)}
              <span style="font-size:var(--font-size-sm);font-weight:600">正在执行</span>
              <span id="channel-action-progress-text" style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-left:auto">0%</span>
            </div>
            <div style="height:6px;background:var(--bg-tertiary);border-radius:999px;overflow:hidden;margin-bottom:10px">
              <div id="channel-action-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
            </div>
            <div id="channel-action-log-box" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);max-height:260px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;word-break:break-all"></div>
          </div>`

        const logBox = actionResultEl.querySelector('#channel-action-log-box')
        const progressBar = actionResultEl.querySelector('#channel-action-progress-bar')
        const progressText = actionResultEl.querySelector('#channel-action-progress-text')
        const { listen } = await import('@tauri-apps/api/event')
        let unlistenLog = null, unlistenProgress = null
        let _qrTimer = null
        const cleanup = () => { unlistenLog?.(); unlistenProgress?.(); clearTimeout(_qrTimer) }

        try {
          btn.disabled = true
          btn.textContent = '执行中...'
          const _qrBuf = []
          let _qrDone = false
          const _flushQr = () => {
            if (!_qrBuf.length || _qrDone) return
            _qrDone = true
            // 解析 Unicode 半块字符为二值矩阵
            const hasHalf = _qrBuf.some(l => /[\u2580\u2584]/.test(l))
            const matrix = []
            for (const line of _qrBuf) {
              if (hasHalf) {
                const top = [], bot = []
                for (const ch of line) {
                  if (ch === '\u2588') { top.push(1); bot.push(1) }
                  else if (ch === '\u2580') { top.push(1); bot.push(0) }
                  else if (ch === '\u2584') { top.push(0); bot.push(1) }
                  else { top.push(0); bot.push(0) }
                }
                matrix.push(top, bot)
              } else {
                matrix.push([...line].map(ch => ch === '\u2588' ? 1 : 0))
              }
            }
            if (!matrix.length) return
            const mod = 4, w = Math.max(...matrix.map(r => r.length)), h = matrix.length
            const cvs = document.createElement('canvas')
            cvs.width = w * mod; cvs.height = h * mod
            const ctx = cvs.getContext('2d')
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cvs.width, cvs.height)
            ctx.fillStyle = '#000'
            for (let y = 0; y < h; y++) for (let x = 0; x < (matrix[y]?.length || 0); x++) {
              if (matrix[y][x]) ctx.fillRect(x * mod, y * mod, mod, mod)
            }
            const wrap = document.createElement('div')
            wrap.style.cssText = 'text-align:center;margin:12px 0;padding:16px;background:#fff;border-radius:var(--radius-md);border:1px solid var(--border-primary)'
            wrap.innerHTML = '<div style="font-size:var(--font-size-sm);font-weight:600;color:#000;margin-bottom:8px">用手机微信扫描此二维码</div>'
            const img = document.createElement('img')
            img.src = cvs.toDataURL()
            img.style.cssText = 'display:block;margin:0 auto;image-rendering:pixelated;max-width:280px'
            wrap.appendChild(img)
            logBox.appendChild(wrap)
          }
          unlistenLog = await listen('channel-action-log', (e) => {
            if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
            if (!logBox) return
            const msg = e.payload?.message || ''
            const isQrLine = /[\u2580\u2584\u2588]/.test(msg)
            if (isQrLine && actionId === 'login') {
              _qrBuf.push(msg)
              clearTimeout(_qrTimer)
              _qrTimer = setTimeout(_flushQr, 500)
            } else if (!isQrLine) {
              if (_qrBuf.length && !_qrDone) _flushQr()
              if (msg.trim()) {
                const div = document.createElement('div')
                div.textContent = msg
                logBox.appendChild(div)
              }
            }
            logBox.scrollTop = logBox.scrollHeight
          })
          unlistenProgress = await listen('channel-action-progress', (e) => {
            if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
            const pct = Number(e.payload?.progress || 0)
            if (progressBar) progressBar.style.width = `${pct}%`
            if (progressText) progressText.textContent = `${pct}%`
          })

          const output = await api.runChannelAction(pid, actionId)
          _flushQr() // 命令结束后刷新残留 QR 缓冲
          if (progressBar) progressBar.style.width = '100%'
          if (progressText) progressText.textContent = '100%'
          toast('执行完成', 'success')
          // 安装完成后刷新插件状态
          if (pid === 'weixin' && actionId === 'install') {
            const statusEl = modal.querySelector('#weixin-plugin-status')
            if (statusEl) {
              statusEl.textContent = '重新检测…'
              api.checkWeixinPluginStatus().then(s => {
                if (!s) return
                const p = []
                if (s.installed) {
                  p.push(`<span style="color:var(--success);font-weight:600">● 已安装</span>`)
                  p.push(`版本 <strong>${s.installedVersion || '未知'}</strong>`)
                  if (s.latestVersion) p.push(`<span style="color:var(--text-tertiary)">（已是最新）</span>`)
                }
                statusEl.innerHTML = p.join(' ') || '已安装'
              }).catch(() => {})
            }
          }
          // 登录成功后：显示成功提示 + 刷新渠道列表 + 自动关闭弹窗
          if (actionId === 'login') {
            if (logBox) {
              const banner = document.createElement('div')
              banner.style.cssText = 'margin-top:12px;padding:12px 16px;background:var(--success-bg, #e8f5e9);border:1px solid var(--success, #4caf50);border-radius:var(--radius-md);color:var(--success, #2e7d32);font-weight:600;text-align:center'
              banner.textContent = '🎉 渠道连接成功！正在刷新列表…'
              logBox.appendChild(banner)
              logBox.scrollTop = logBox.scrollHeight
            }
            // 刷新渠道列表（先清缓存）
            invalidate('list_configured_platforms')
            loadPlatforms(page, state).then(() => renderConfigured(page, state)).catch(() => {})
            // 2 秒后自动关闭弹窗
            setTimeout(() => { modal.close?.() || modal.remove?.() }, 2000)
          }
        } catch (e) {
          _flushQr()
          toast('执行失败: ' + e, 'error')
          if (logBox) {
            const div = document.createElement('div')
            div.style.color = 'var(--error)'
            div.textContent = '执行失败: ' + String(e)
            logBox.appendChild(div)
          }
        } finally {
          cleanup()
          btn.disabled = false
          btn.textContent = reg.actions.find(a => a.id === actionId)?.label || '执行'
        }
      })
    })
    return
  }

  // 尝试加载已有配置（accountId 用于多账号读取）
  let existing = {}
  let isEdit = false
  try {
    const res = await api.readPlatformConfig(pid, accountId)
    if (res?.values) {
      existing = res.values
    }
    if (res?.exists) {
      isEdit = true
    }
  } catch {}

  // 加载 Agent 列表（不预选，因为一个 channel+accountId 可以被多个 agent 绑定）
  let agents = []
  try {
    agents = await api.listAgents()
  } catch {}

  const formId = 'platform-form-' + Date.now()

  const supportsMultiAccount = ['feishu', 'dingtalk', 'dingtalk-connector', 'qqbot'].includes(pid)

  // 账号标识（多账号）；编辑时 accountId 非空会在 input value 中显示
  const accountIdHtml = supportsMultiAccount ? `
    <div class="form-group">
      <label class="form-label">账号标识</label>
      <input class="form-input" name="__accountId" placeholder="留空为默认账号；修改会创建新账号" value="${escapeAttr(accountId != null ? accountId : '')}">
      <div class="form-hint">每个账号对应一个独立机器人。不同账号可绑定不同 Agent。</div>
    </div>
  ` : ''

  // Agent 绑定选择（一个 channel+accountId 可以绑定到多个不同 agent）
  const agentOptions = agents.map(a => {
    const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
    // 默认预选第一个 agent，不依赖当前 binding
    const isFirst = a === agents[0]
    return `<option value="${escapeAttr(a.id)}" ${isFirst ? 'selected' : ''}>${a.id}${a.id !== label ? ' — ' + escapeAttr(label) : ''}</option>`
  }).join('')
  const agentBindingHtml = `
    <div class="form-group">
      <label class="form-label">绑定 Agent</label>
      <select class="form-input" name="__agentId" id="form-agent-id">
        ${agentOptions}
      </select>
      <div class="form-hint">该账号收到的消息路由到哪个 Agent（可在「Agent 对接」页添加更多绑定）。</div>
    </div>
  `

  const isFieldRequired = (field, form) => {
    if (field.required) return true
    if (!field.requiredWhen) return false
    return Object.entries(field.requiredWhen).every(([k, expected]) => (form[k] || '') === expected)
  }

  const fieldsHtml = reg.fields.map((f, i) => {
    const val = existing[f.key] || ''
    if (f.type === 'select' && f.options) {
      return `
        <div class="form-group">
          <label class="form-label">${f.label}${f.required ? ' *' : ''}</label>
          <select class="form-input" name="${f.key}" data-name="${f.key}">
            ${f.options.map(o => `<option value="${o.value}" ${val === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>
      `
    }
    return `
      <div class="form-group">
        <label class="form-label">${f.label}${f.required ? ' *' : ''}</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" name="${f.key}" type="${f.secret ? 'password' : 'text'}"
                 value="${escapeAttr(val)}" placeholder="${f.placeholder || ''}"
                 ${i === 0 ? 'autofocus' : ''} style="flex:1">
          ${f.secret ? `<button type="button" class="btn btn-sm btn-secondary toggle-vis" data-field="${f.key}">显示</button>` : ''}
        </div>
        ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
      </div>
    `
  }).join('')

  const guideHtml = reg.guide?.length ? `
    <details style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);margin-bottom:var(--space-md)">
      <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">接入步骤 <span style="color:var(--text-tertiary);font-weight:400">（点击展开）</span></summary>
      <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
        ${reg.guide.map(s => `<li>${s}</li>`).join('')}
      </ol>
      ${reg.guideFooter || ''}
    </details>
  ` : ''

  const pairingHtml = reg.pairingChannel ? `
    <div style="margin-top:var(--space-md);padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:6px">配对审批</div>
      <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.7;margin-bottom:8px">当机器人提示 <code>access not configured</code>、<code>Pairing code</code> 或要求执行 <code>openclaw pairing approve</code> 时，可直接在这里完成批准。</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" name="pairingCode" placeholder="例如 R3ZFPWZP" style="flex:1;min-width:180px">
        <button type="button" class="btn btn-sm btn-secondary" id="btn-pairing-list">查看待审批</button>
        <button type="button" class="btn btn-sm btn-primary" id="btn-pairing-approve">批准配对码</button>
      </div>
      <div id="pairing-result" style="margin-top:8px"></div>
    </div>
  ` : ''

  const actionPanelHtml = reg.actions?.length ? `
    <div style="margin-top:var(--space-md);padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:6px">运行前动作</div>
      <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.7;margin-bottom:8px">适用于需要先执行 CLI 登录、扫码或初始化命令的渠道。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${reg.actions.map(action => `<button type="button" class="btn btn-sm btn-secondary" data-channel-action="${action.id}">${action.label}</button>`).join('')}
      </div>
      ${reg.actions.map(action => action.hint ? `<div class="form-hint" style="margin-top:6px">${action.label}：${action.hint}</div>` : '').join('')}
      <div id="channel-action-result" style="margin-top:8px"></div>
    </div>
  ` : ''

  const content = `
    ${guideHtml}
    ${!isEdit && (existing.gatewayToken || existing.gatewayPassword) ? `<div style="background:var(--bg-tertiary);color:var(--text-secondary);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">已从当前 Gateway 鉴权配置中自动带出 ${existing.gatewayToken ? 'Token' : 'Password'}，通常无需手填</div>` : ''}
    ${isEdit ? `<div style="background:var(--accent-muted);color:var(--accent);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">当前已有配置，修改后点击保存即可覆盖</div>` : ''}
    <form id="${formId}">
      ${fieldsHtml}
      ${accountIdHtml}
      ${agentBindingHtml}
    </form>
    ${actionPanelHtml}
    ${pairingHtml}
    <div id="verify-result" style="margin-top:var(--space-sm)"></div>
    ${pid === 'qqbot' ? `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-primary)">
      <button type="button" class="btn btn-sm btn-secondary" id="btn-qq-full-diagnose">${icon('zap', 14)} 完整联通诊断</button>
      <p class="form-hint" style="margin-top:8px;margin-bottom:0;line-height:1.55">检查<strong>已保存到配置文件</strong>的凭证、本机 Gateway 端口、<code>/__api/health</code>、QQ 插件与 chatCompletions。QQ 提示「灵魂不在线」时优先看此处，并参考 <a href="https://q.qq.com/qqbot/openclaw/faq.html" target="_blank" rel="noopener">OpenClaw × QQ 常见问题</a>。</p>
    </div>` : ''}
  `

  const modal = showContentModal({
    title: `${isEdit ? '编辑' : '接入'} ${reg.label}`,
    content,
    buttons: [
      { label: '校验凭证', className: 'btn btn-secondary', id: 'btn-verify' },
      { label: isEdit ? '保存' : '接入并保存', className: 'btn btn-primary', id: 'btn-save' },
    ],
    width: 520,
  })

  // 外部链接用系统浏览器打开
  modal.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]')
    if (!a) return
    const href = a.getAttribute('href')
    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
      e.preventDefault()
      openExternalUrl(href)
    }
  })

  if (pid === 'qqbot') {
    const diagBtn = modal.querySelector('#btn-qq-full-diagnose')
    diagBtn?.addEventListener('click', async () => {
      const prev = diagBtn.innerHTML
      try {
        diagBtn.disabled = true
        diagBtn.textContent = '诊断中...'
        const result = await api.diagnoseChannel('qqbot', accountId || null)
        showQqDiagnoseModal(result, { accountId: accountId || null })
      } catch (e) {
        toast('诊断失败: ' + e, 'error')
      } finally {
        diagBtn.disabled = false
        diagBtn.innerHTML = prev
      }
    })
  }

  // 密码显隐
  modal.querySelectorAll('.toggle-vis').forEach(btn => {
    btn.onclick = () => {
      const input = modal.querySelector(`input[name="${btn.dataset.field}"]`)
      if (!input) return
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      btn.textContent = show ? '隐藏' : '显示'
    }
  })

  // 收集表单值
  const collectForm = () => {
    const obj = {}
    reg.fields.forEach(f => {
      const el = modal.querySelector(`input[name="${f.key}"]`) || modal.querySelector(`select[name="${f.key}"]`)
      if (el) obj[f.key] = el.value.trim()
    })
    return obj
  }

  // 校验按钮
  const btnVerify = modal.querySelector('#btn-verify')
  const btnSave = modal.querySelector('#btn-save')
  const resultEl = modal.querySelector('#verify-result')
  const actionResultEl = modal.querySelector('#channel-action-result')
  const pairingInput = modal.querySelector('input[name="pairingCode"]')
  const pairingResultEl = modal.querySelector('#pairing-result')
  const btnPairingList = modal.querySelector('#btn-pairing-list')
  const btnPairingApprove = modal.querySelector('#btn-pairing-approve')

  modal.querySelectorAll('[data-channel-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const actionId = btn.dataset.channelAction
      if (!actionId || !actionResultEl) return

      // WhatsApp 扫码登录：通过 Gateway WebSocket RPC 直接调用 web.login.start / web.login.wait
      const actionDef = reg.actions?.find(a => a.id === actionId)
      if (actionDef?.useGatewayLogin) {
        await handleGatewayWhatsAppLogin(btn, actionResultEl, actionDef)
        return
      }

      actionResultEl.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            ${icon('zap', 14)}
            <span style="font-size:var(--font-size-sm);font-weight:600">正在执行渠道动作</span>
            <span id="channel-action-progress-text" style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-left:auto">0%</span>
          </div>
          <div style="height:6px;background:var(--bg-tertiary);border-radius:999px;overflow:hidden;margin-bottom:10px">
            <div id="channel-action-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
          </div>
          <div id="channel-action-log-box" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);max-height:180px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;word-break:break-all"></div>
        </div>`

      const logBox = actionResultEl.querySelector('#channel-action-log-box')
      const progressBar = actionResultEl.querySelector('#channel-action-progress-bar')
      const progressText = actionResultEl.querySelector('#channel-action-progress-text')
      const { listen } = await import('@tauri-apps/api/event')
      let unlistenLog = null
      let unlistenProgress = null
      let unlistenDone = null
      let unlistenError = null
      const cleanup = () => {
        unlistenLog?.()
        unlistenProgress?.()
        unlistenDone?.()
        unlistenError?.()
      }

      try {
        btn.disabled = true
        btn.textContent = '执行中...'
        unlistenLog = await listen('channel-action-log', (e) => {
          if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
          if (logBox) {
            logBox.textContent += (logBox.textContent ? '\n' : '') + (e.payload?.message || '')
            logBox.scrollTop = logBox.scrollHeight
          }
        })
        unlistenProgress = await listen('channel-action-progress', (e) => {
          if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
          const pct = Number(e.payload?.progress || 0)
          if (progressBar) progressBar.style.width = `${pct}%`
          if (progressText) progressText.textContent = `${pct}%`
        })
        unlistenDone = await listen('channel-action-done', (e) => {
          if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
          if (progressBar) progressBar.style.width = '100%'
          if (progressText) progressText.textContent = '100%'
        })
        unlistenError = await listen('channel-action-error', (e) => {
          if (e.payload?.platform !== pid || e.payload?.action !== actionId) return
          if (logBox) {
            logBox.textContent += (logBox.textContent ? '\n' : '') + '执行失败：' + (e.payload?.message || '未知错误')
            logBox.scrollTop = logBox.scrollHeight
          }
        })

        const output = await api.runChannelAction(pid, actionId)
        toast('渠道动作执行完成', 'success')
        if (logBox && output && !String(output).includes(logBox.textContent)) {
          logBox.textContent += (logBox.textContent ? '\n' : '') + String(output)
        }
      } catch (e) {
        toast('渠道动作执行失败: ' + e, 'error')
      } finally {
        cleanup()
        btn.disabled = false
        btn.textContent = reg.actions.find(a => a.id === actionId)?.label || '执行'
      }
    })
  })

  if (btnPairingList && pairingResultEl) {
    btnPairingList.onclick = async () => {
      btnPairingList.disabled = true
      btnPairingList.textContent = '读取中...'
      pairingResultEl.innerHTML = ''
      try {
        const output = await api.pairingListChannel(reg.pairingChannel)
        pairingResultEl.innerHTML = `
          <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:10px 12px">
            <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:6px">待审批请求</div>
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-secondary);font-family:var(--font-mono)">${escapeAttr(output || '暂无待审批请求')}</pre>
          </div>`
      } catch (e) {
        pairingResultEl.innerHTML = `<div style="color:var(--error);font-size:var(--font-size-sm)">读取失败: ${escapeAttr(String(e))}</div>`
      } finally {
        btnPairingList.disabled = false
        btnPairingList.textContent = '查看待审批'
      }
    }
  }

  if (btnPairingApprove && pairingInput && pairingResultEl) {
    btnPairingApprove.onclick = async () => {
      const code = pairingInput.value.trim().toUpperCase()
      if (!code) {
        toast('请输入配对码', 'warning')
        pairingInput.focus()
        return
      }
      btnPairingApprove.disabled = true
      btnPairingApprove.textContent = '批准中...'
      pairingResultEl.innerHTML = ''
      try {
        const output = await api.pairingApproveChannel(reg.pairingChannel, code, !!reg.pairingNotify)
        pairingResultEl.innerHTML = `
          <div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('check', 14)} 配对已批准
            <div style="margin-top:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary)">${escapeAttr(output || '操作完成')}</div>
          </div>`
        pairingInput.value = ''
        toast('配对已批准', 'success')
      } catch (e) {
        pairingResultEl.innerHTML = `<div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">批准失败: ${escapeAttr(String(e))}</div>`
      } finally {
        btnPairingApprove.disabled = false
        btnPairingApprove.textContent = '批准配对码'
      }
    }
  }

  btnVerify.onclick = async () => {
    const form = collectForm()
    // 前端基础检查
    for (const f of reg.fields) {
      if (isFieldRequired(f, form) && !form[f.key]) {
        toast(`请填写「${f.label}」`, 'warning')
        return
      }
    }
    btnVerify.disabled = true
    btnVerify.textContent = '校验中...'
    resultEl.innerHTML = ''
    try {
      const res = await api.verifyBotToken(pid, form)
      if (res.valid) {
        const details = (res.details || []).join(' · ')
        resultEl.innerHTML = `
          <div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('check', 14)} 凭证有效${details ? ' — ' + details : ''}
          </div>
          ${pid === 'qqbot' ? `<div class="form-hint" style="margin-top:8px;line-height:1.55">此项只验证 AppID/Secret 能否向腾讯换 token。<strong>不能</strong>代表 QQ 里机器人已在线；若提示「灵魂不在线」，请使用下方 <strong>完整联通诊断</strong> 并对照 <a href="https://q.qq.com/qqbot/openclaw/faq.html" target="_blank" rel="noopener">QQ OpenClaw 常见问题</a>。</div>` : ''}`
      } else {
        const errs = (res.errors || ['校验失败']).join('<br>')
        resultEl.innerHTML = `
          <div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('x', 14)} ${errs}
          </div>`
      }
    } catch (e) {
      resultEl.innerHTML = `<div style="color:var(--error);font-size:var(--font-size-sm)">校验请求失败: ${e}</div>`
    } finally {
      btnVerify.disabled = false
      btnVerify.textContent = '校验凭证'
    }
  }

  // 保存按钮
  btnSave.onclick = async () => {
    const form = collectForm()
    for (const f of reg.fields) {
      if (isFieldRequired(f, form) && !form[f.key]) {
        toast(`请填写「${f.label}」`, 'warning')
        return
      }
    }
    if (pid === 'matrix' && !form.accessToken && !(form.userId && form.password)) {
      toast('Matrix 需要填写 Access Token，或填写 User ID + Password', 'warning')
      return
    }
    btnSave.disabled = true
    btnVerify.disabled = true
    btnSave.textContent = '保存中...'

    try {
      // 如果需要安装插件，先安装并显示日志
      if (reg.pluginRequired) {
        const pluginPackage = reg.pluginRequired
        const pluginId = reg.pluginId || pid
        const pluginStatus = await api.getChannelPluginStatus(pluginId)
        // 跳过安装：插件已安装或已内置
        if (!pluginStatus?.installed && !pluginStatus?.builtin) {
          btnSave.textContent = '安装插件中...'
          resultEl.innerHTML = `
            <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;margin-top:var(--space-sm)">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                ${icon('download', 14)}
                <span style="font-size:var(--font-size-sm);font-weight:600">安装插件</span>
                <span id="plugin-progress-text" style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-left:auto">0%</span>
              </div>
              <div style="height:4px;background:var(--bg-secondary);border-radius:2px;overflow:hidden;margin-bottom:8px">
                <div id="plugin-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
              </div>
              <div id="plugin-log-box" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);max-height:120px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;word-break:break-all"></div>
            </div>
          `
          const logBox = resultEl.querySelector('#plugin-log-box')
          const progressBar = resultEl.querySelector('#plugin-progress-bar')
          const progressText = resultEl.querySelector('#plugin-progress-text')
          let unlistenLog, unlistenProgress
          try {
            const { listen } = await import('@tauri-apps/api/event')
            unlistenLog = await listen('plugin-log', (e) => {
              logBox.textContent += e.payload + '\n'
              logBox.scrollTop = logBox.scrollHeight
            })
            unlistenProgress = await listen('plugin-progress', (e) => {
              const pct = e.payload
              progressBar.style.width = pct + '%'
              progressText.textContent = pct + '%'
            })
          } catch {}

          try {
            // QQ 必须用专用安装命令：官方包目录为 openclaw-qqbot，与 install_channel_plugin(…, "qqbot") 的备份路径不一致
            if (pid === 'qqbot') {
              await api.installQqbotPlugin()
            } else {
              await api.installChannelPlugin(pluginPackage, pluginId)
            }
          } catch (e) {
            toast('插件安装失败: ' + e, 'error')
            btnSave.disabled = false
            btnVerify.disabled = false
            btnSave.textContent = isEdit ? '保存' : '接入并保存'
            if (unlistenLog) unlistenLog()
            if (unlistenProgress) unlistenProgress()
            return
          }
          if (unlistenLog) unlistenLog()
          if (unlistenProgress) unlistenProgress()
        } else {
          resultEl.innerHTML = `
            <div style="background:var(--accent-muted);color:var(--accent);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
              ${icon('check', 14)} 已检测到插件，无需重复安装，本次仅更新配置
            </div>`
        }
      }

      // 写入配置
      btnSave.textContent = '写入配置...'
      const saveAccountId = modal.querySelector('input[name="__accountId"]')?.value?.trim() || null
      const saveAgentId = modal.querySelector('select[name="__agentId"]')?.value?.trim() || 'main'
      await api.saveMessagingPlatform(pid, form, saveAccountId, null)

      // 为该 channel + accountId 创建/更新 agent 绑定
      const channelKey = getChannelBindingKey(pid)
      await api.saveAgentBinding(saveAgentId, channelKey, saveAccountId, {})

      toast(`${reg.label} 配置已保存，Gateway 正在重载`, 'success')
      modal.close?.() || modal.remove?.()
      await loadPlatforms(page, state)
    } catch (e) {
      toast('保存失败: ' + e, 'error')
    } finally {
      btnSave.disabled = false
      btnVerify.disabled = false
      btnSave.textContent = isEdit ? '保存' : '接入并保存'
    }
  }
}

/** 将平台 ID 映射为 openclaw bindings 中的 channel key */
function getChannelBindingKey(pid) {
  const map = {
    qqbot: 'qqbot',
    telegram: 'telegram',
    discord: 'discord',
    feishu: 'feishu',
    dingtalk: 'dingtalk-connector',
    weixin: 'openclaw-weixin',
  }
  return map[pid] || pid
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
