/**
 * 消息渠道管理
 * 配置 Telegram / Discord 等外部消息接入，凭证校验后写入 openclaw.json
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'

// ── 渠道注册表：定义每个支持的消息渠道的元数据和表单规格 ──

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
      'ClawPanel 会自动安装 QQBot 社区插件并写入配置，保存后 Gateway 自动重载生效',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">详细教程：<a href="https://cloud.tencent.com/developer/article/2626045" target="_blank" style="color:var(--accent);text-decoration:underline">腾讯云 - 快速搭建 AI 私人 QQ 助理</a></div>',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '如 1903224859', required: true },
      { key: 'appSecret', label: 'AppSecret', placeholder: '如 cisldqspngYlyPdc', secret: true, required: true },
    ],
    pluginRequired: '@sliverp/qqbot@latest',
  },
  telegram: {
    label: 'Telegram',
    iconName: 'send',
    desc: '通过 BotFather 创建机器人，用 Bot Token 接入',
    guide: [
      '在 Telegram 中搜索 <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent);text-decoration:underline">@BotFather</a>，发送 <b>/newbot</b> 创建机器人',
      '按提示设置机器人名称和用户名，成功后 BotFather 会返回 <b>Bot Token</b>',
      '获取你的 Telegram 用户 ID：发送消息给 <a href="https://t.me/userinfobot" target="_blank" style="color:var(--accent);text-decoration:underline">@userinfobot</a> 即可查看',
      '将 Bot Token 和用户 ID 填入下方表单，点击「校验凭证」验证后保存',
    ],
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true, required: true },
      { key: 'allowedUsers', label: '允许的用户 ID', placeholder: '多个用逗号分隔，如 12345, 67890', required: true },
    ],
  },
  feishu: {
    label: '飞书',
    iconName: 'message-square',
    desc: '飞书/Lark 企业消息集成，支持文档、多维表格、日历等飞书生态能力',
    guide: [
      '<b>选择插件版本</b>：<br>• <b>内置插件</b>（默认）— OpenClaw 自带，主要做聊天入口，安装简单<br>• <b>飞书官方插件</b> — 飞书团队开发，能以你的身份操作飞书（写文档、建表、约日程）<br><span style="color:var(--text-tertiary)">两者互斥，只能启用一个</span>',
      '前往 <a href="https://open.feishu.cn/app" target="_blank" style="color:var(--accent);text-decoration:underline">飞书开放平台</a>，创建企业自建应用，在「应用能力」中添加<b>机器人</b>能力',
      '在<b>凭证与基础信息</b>页面获取 <b>App ID</b> 和 <b>App Secret</b>',
      '进入<b>权限管理</b>，参照 <a href="https://open.larkoffice.com/document/server-docs/application-scope/scope-list" target="_blank" style="color:var(--accent);text-decoration:underline">权限列表</a> 开通所需权限（<code>im:message</code> 等）',
      '进入<b>事件订阅</b>，选择<b>使用长连接（WebSocket）</b>模式，订阅<b>接收消息</b>和<b>卡片回调</b>事件。如有 user access token 开关请打开',
      '将 App ID 和 App Secret 填入下方表单，校验后保存',
      '保存后在飞书中向机器人发消息，获取配对码；你可以直接在下方"配对审批"区域粘贴配对码完成绑定，也可以在终端执行 <code>openclaw pairing approve feishu &lt;配对码&gt; --notify</code>',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">国际版 Lark 用户请将域名切换为 <b>lark</b>。详细教程：<a href="https://www.feishu.cn/content/article/7613711414611463386" target="_blank" style="color:var(--accent);text-decoration:underline">OpenClaw 飞书官方插件使用指南</a> · <a href="https://github.com/AlexAnys/openclaw-feishu" target="_blank" style="color:var(--accent);text-decoration:underline">两个插件怎么选</a></div>',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxx', required: true },
      { key: 'appSecret', label: 'App Secret', placeholder: '应用密钥', secret: true, required: true },
      { key: 'domain', label: '域名', placeholder: 'feishu（国际版选 lark）', required: false },
      { key: 'pluginVersion', label: '插件版本', type: 'select', required: false, options: [
        { value: 'builtin', label: '内置插件（默认，聊天入口）' },
        { value: 'official', label: '飞书官方插件（操作文档/日历/任务）' },
      ]},
    ],
    pluginRequired: '@openclaw/feishu@latest',
    pluginId: 'feishu',
    pairingChannel: 'feishu',
    pairingNotify: true,
  },
  dingtalk: {
    label: '钉钉',
    iconName: 'message-square',
    desc: '钉钉企业内部应用 + 机器人 Stream 模式接入',
    guide: [
      '前往 <a href="https://open-dev.dingtalk.com/" target="_blank" style="color:var(--accent);text-decoration:underline">钉钉开放平台</a> 创建企业内部应用，并添加<b>机器人</b>能力',
      '消息接收模式必须选择 <b>Stream 模式</b>，不要选 Webhook',
      '在<b>凭证与基础信息</b>页面复制 <b>Client ID</b> 和 <b>Client Secret</b>；如 Gateway 开启了鉴权，请按 <code>gateway.auth.mode</code> 填写 <b>Gateway Token</b> 或 <b>Gateway Password</b>',
      '在<b>权限管理</b>中至少确认已开通 <code>Card.Streaming.Write</code>、<code>Card.Instance.Write</code>、<code>qyapi_robot_sendmsg</code>，如需文档能力再补文档相关权限',
      '先在钉钉侧<b>发布应用版本</b>，并确认<b>应用可见范围</b>包含你自己和测试成员；否则私聊或加群时可能搜不到机器人',
      '回到 ClawPanel 保存。首次保存会自动安装插件，后续保存只更新配置；如果本机已配置 Gateway 鉴权，系统会自动带出对应的 Token 或 Password',
      '私聊测试时，可在钉钉客户端搜索应用/机器人名称，或从工作台进入应用后发起对话；若找不到，优先检查“已发布”和“可见范围”',
      '如果机器人首次私聊返回的是<b>配对码</b>，你可以直接在下方“配对审批”区域粘贴配对码完成授权，也可以在终端执行 <code>openclaw pairing approve dingtalk-connector &lt;配对码&gt;</code>',
      '群聊测试时，先进入目标群 → <b>群设置</b> → <b>智能群助手 / 机器人</b> → <b>添加机器人</b>，搜索并添加该机器人；回群后建议用 <code>@机器人</code> 再发消息，如仍不响应再检查连接器的 <code>groupPolicy</code> 是否被设为 <code>disabled</code>',
    ],
    guideFooter: '<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">参考资料：<a href="https://open.dingtalk.com/document/dingstart/install-openclaw-locally" target="_blank" style="color:var(--accent);text-decoration:underline">本地安装 OpenClaw</a>、<a href="https://open.dingtalk.com/document/orgapp/use-group-robots" target="_blank" style="color:var(--accent);text-decoration:underline">添加机器人到钉钉群</a>。排障重点：405 通常是 <code>chatCompletions</code> 未启用，401 通常是 Gateway 鉴权字段不匹配。</div>',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'dingxxxxxxxxxx', required: true },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true, required: true },
      { key: 'gatewayToken', label: 'Gateway Token', placeholder: '如已开启 Gateway token 鉴权则填写', required: false },
      { key: 'gatewayPassword', label: 'Gateway Password', placeholder: '与 token 二选一，可选', secret: true, required: false },
    ],
    pluginRequired: '@dingtalk-real-ai/dingtalk-connector',
    pluginId: 'dingtalk-connector',
    pairingChannel: 'dingtalk-connector',
  },
  discord: {
    label: 'Discord',
    iconName: 'message-circle',
    desc: '通过 Discord Developer Portal 创建 Bot 应用接入',
    guide: [
      '前往 <a href="https://discord.com/developers/applications" target="_blank" style="color:var(--accent);text-decoration:underline">Discord Developer Portal</a>，点击 New Application 创建应用',
      '进入应用 → 左侧 <b>Bot</b> 页面 → 点击 Reset Token 生成 Bot Token，并开启 <b>Message Content Intent</b>',
      '左侧 <b>OAuth2</b> → URL Generator，勾选 bot 权限，复制链接将 Bot 邀请到你的服务器',
      '将 Bot Token 和服务器 ID 填入下方表单，点击「校验凭证」验证后保存',
    ],
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: 'MTIz...', secret: true, required: true },
      { key: 'guildId', label: '服务器 ID', placeholder: '右键服务器 → 复制服务器 ID', required: false },
      { key: 'channelId', label: '频道 ID（可选）', placeholder: '不填则监听所有频道', required: false },
    ],
  },
}

// ── 页面生命周期 ──

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">消息渠道</h1>
      <p class="page-desc">支持 QQ、Telegram、Discord、飞书、钉钉等消息渠道接入</p>
    </div>
    <div id="platforms-configured" style="margin-bottom:var(--space-lg)"></div>
    <div class="config-section">
      <div class="config-section-title">可接入平台</div>
      <div id="platforms-available" class="platforms-grid"></div>
    </div>
  `

  const state = { configured: [] }
  await loadPlatforms(page, state)

  return page
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
  // 加载 bindings 信息
  try {
    const config = await api.readOpenclawConfig()
    state.bindings = Array.isArray(config?.bindings) ? config.bindings : []
  } catch { state.bindings = [] }
  renderConfigured(page, state)
  renderAvailable(page, state)
}

// ── 已配置平台渲染 ──

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
        ${state.configured.flatMap(p => {
          const reg = PLATFORM_REGISTRY[p.id]
          const label = reg?.label || p.id
          const ic = icon(reg?.iconName || 'radio', 22)
          const channelKey = getChannelBindingKey(p.id)
          const allBindings = (state.bindings || []).filter(b => b.match?.channel === channelKey)
          const boundAgents = allBindings.length ? allBindings.map(b => b.agentId || 'main') : ['main']
          return boundAgents.map(agentId => {
            const badge = agentId !== 'main'
              ? `<span style="font-size:var(--font-size-xs);color:var(--accent);background:var(--accent-muted);padding:1px 6px;border-radius:10px;white-space:nowrap">→ ${escapeAttr(agentId)}</span>`
              : ''
            return `
              <div class="platform-card ${p.enabled ? 'active' : 'inactive'}" data-pid="${p.id}" data-agent="${escapeAttr(agentId)}">
                <div class="platform-card-header">
                  <span class="platform-emoji">${ic}</span>
                  <span class="platform-name">${label}</span>
                  ${badge}
                  <span class="platform-status-dot ${p.enabled ? 'on' : 'off'}"></span>
                </div>
                <div class="platform-card-actions">
                  <button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)} 编辑</button>
                  <button class="btn btn-sm btn-secondary" data-action="toggle">${p.enabled ? icon('pause', 14) + ' 禁用' : icon('play', 14) + ' 启用'}</button>
                  <button class="btn btn-sm btn-danger" data-action="remove">${icon('trash', 14)}</button>
                </div>
              </div>
            `
          })
        }).join('')}
      </div>
    </div>
  `

  // 绑定事件
  el.querySelectorAll('.platform-card').forEach(card => {
    const pid = card.dataset.pid
    card.querySelector('[data-action="edit"]').onclick = () => openConfigDialog(pid, page, state)
    card.querySelector('[data-action="toggle"]').onclick = async () => {
      const cur = state.configured.find(p => p.id === pid)
      if (!cur) return
      try {
        await api.toggleMessagingPlatform(pid, !cur.enabled)
        toast(`${PLATFORM_REGISTRY[pid]?.label || pid} 已${cur.enabled ? '禁用' : '启用'}`, 'success')
        await loadPlatforms(page, state)
      } catch (e) { toast('操作失败: ' + e, 'error') }
    }
    card.querySelector('[data-action="remove"]').onclick = async () => {
      const yes = await showConfirm(`确定移除 ${PLATFORM_REGISTRY[pid]?.label || pid}？配置将被删除。`)
      if (!yes) return
      try {
        await api.removeMessagingPlatform(pid)
        toast('已移除', 'info')
        await loadPlatforms(page, state)
      } catch (e) { toast('移除失败: ' + e, 'error') }
    }
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
        ${done ? `<span class="platform-pick-badge" style="color:var(--success)">已接入 · 点击绑定新 Agent</span>` : ''}
      </button>
    `
  }).join('')

  el.querySelectorAll('.platform-pick').forEach(btn => {
    const pid = btn.dataset.pid
    const done = configuredIds.has(pid)
    btn.onclick = () => done ? openBindAgentDialog(pid, page, state) : openConfigDialog(pid, page, state)
  })
}

// ── 快速绑定 Agent 弹窗（已接入平台专用） ──

async function openBindAgentDialog(pid, page, state) {
  const reg = PLATFORM_REGISTRY[pid]
  if (!reg) return
  let agents = []
  try { agents = await api.listAgents() } catch {}
  if (!Array.isArray(agents)) agents = []

  const channelKey = getChannelBindingKey(pid)
  const existingBindings = (state.bindings || []).filter(b => b.match?.channel === channelKey)
  const boundIds = new Set(existingBindings.map(b => b.agentId || 'main'))

  const availableAgents = agents.filter(a => !boundIds.has(a.id))
  if (!availableAgents.length) {
    toast('所有 Agent 都已绑定到该渠道', 'info')
    return
  }

  const agentOptions = availableAgents.map(a => {
    const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
    return `<option value="${escapeAttr(a.id)}">${a.id}${a.id !== label ? ' — ' + label : ''}</option>`
  }).join('')

  const modal = showContentModal({
    title: `为 ${reg.label} 绑定新 Agent`,
    content: `
      <div style="margin-bottom:var(--space-md)">
        <div class="form-hint" style="margin-bottom:var(--space-sm)">已绑定: ${[...boundIds].join(', ') || '无'}</div>
        <label class="form-label">选择要绑定的 Agent</label>
        <select class="form-input" id="bind-agent-select">${agentOptions}</select>
        <div class="form-hint" style="margin-top:4px">该渠道的消息将路由到选中的 Agent 处理</div>
      </div>
    `,
    buttons: [
      { label: '绑定', className: 'btn btn-primary', id: 'btn-bind-agent' },
    ],
    width: 400,
  })

  modal.querySelector('#btn-bind-agent').onclick = async () => {
    const agentId = modal.querySelector('#bind-agent-select')?.value
    if (!agentId) { toast('请选择 Agent', 'warning'); return }
    try {
      await saveChannelBinding(pid, agentId)
      toast(`已将 ${reg.label} 绑定到 Agent「${agentId}」`, 'success')
      modal.close?.() || modal.remove?.()
      await loadPlatforms(page, state)
    } catch (e) {
      toast('绑定失败: ' + e, 'error')
    }
  }
}

// ── 配置弹窗（新增 / 编辑共用） ──

async function openConfigDialog(pid, page, state) {
  const reg = PLATFORM_REGISTRY[pid]
  if (!reg) { toast('未知平台', 'error'); return }

  // 尝试加载已有配置
  let existing = {}
  let isEdit = false
  let agents = []
  let currentBinding = ''
  let existingAccountId = ''
  try {
    const res = await api.readPlatformConfig(pid)
    if (res?.values) {
      existing = res.values
    }
    if (res?.accountId) {
      existingAccountId = res.accountId
    }
    if (res?.exists) {
      isEdit = true
    }
  } catch {}
  // 加载 Agent 列表和当前 binding
  try {
    agents = await api.listAgents()
  } catch {}
  try {
    const config = await api.readOpenclawConfig()
    const bindings = config?.bindings || []
    const channelKey = getChannelBindingKey(pid)
    const found = bindings.find(b => {
      if (b.match?.channel !== channelKey) return false
      if (existingAccountId) return (b.match?.accountId || '') === existingAccountId
      return !b.match?.accountId
    })
    if (found) currentBinding = found.agentId || ''
  } catch {}

  const formId = 'platform-form-' + Date.now()

  // Agent 绑定选择器
  const agentOptions = agents.map(a => {
    const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
    return `<option value="${escapeAttr(a.id)}" ${a.id === currentBinding ? 'selected' : ''}>${a.id}${a.id !== label ? ' — ' + label : ''}</option>`
  }).join('')
  const supportsMultiAccount = ['feishu', 'dingtalk', 'dingtalk-connector'].includes(pid)
  const accountIdHtml = supportsMultiAccount ? `
    <div class="form-group">
      <label class="form-label">账号标识（多账号模式）</label>
      <input class="form-input" name="__accountId" placeholder="如 sales、support（留空则为默认账号）" value="${escapeAttr(existingAccountId)}">
      <div class="form-hint">为同一平台接入多个应用时，每个应用需要一个唯一的账号标识。不同账号可绑定不同 Agent</div>
    </div>
  ` : ''
  const agentBindingHtml = `
    ${accountIdHtml}
    <div class="form-group">
      <label class="form-label">绑定 Agent</label>
      <select class="form-input" name="__agentBinding">
        <option value="" ${!currentBinding ? 'selected' : ''}>默认（main）</option>
        ${agentOptions}
      </select>
      <div class="form-hint">选择该渠道消息路由到哪个 Agent 处理。留空则使用默认 Agent（main）</div>
    </div>
  `

  // 飞书插件版本检测：根据已安装的插件自动选择
  if (pid === 'feishu' && !existing.pluginVersion) {
    try {
      const officialStatus = await api.getChannelPluginStatus('feishu-openclaw-plugin')
      if (officialStatus?.installed) existing.pluginVersion = 'official'
      else existing.pluginVersion = localStorage.getItem('clawpanel-feishu-plugin-version') || 'builtin'
    } catch { existing.pluginVersion = 'builtin' }
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

  const content = `
    ${guideHtml}
    ${!isEdit && (existing.gatewayToken || existing.gatewayPassword) ? `<div style="background:var(--bg-tertiary);color:var(--text-secondary);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">已从当前 Gateway 鉴权配置中自动带出 ${existing.gatewayToken ? 'Token' : 'Password'}，通常无需手填</div>` : ''}
    ${isEdit ? `<div style="background:var(--accent-muted);color:var(--accent);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">当前已有配置，修改后点击保存即可覆盖</div>` : ''}
    <form id="${formId}">
      ${fieldsHtml}
      ${agentBindingHtml}
    </form>
    ${pairingHtml}
    <div id="verify-result" style="margin-top:var(--space-sm)"></div>
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
      import('@tauri-apps/plugin-shell').then(({ open }) => open(href)).catch(() => window.open(href, '_blank'))
    }
  })

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
  const pairingInput = modal.querySelector('input[name="pairingCode"]')
  const pairingResultEl = modal.querySelector('#pairing-result')
  const btnPairingList = modal.querySelector('#btn-pairing-list')
  const btnPairingApprove = modal.querySelector('#btn-pairing-approve')

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
      if (f.required && !form[f.key]) {
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
          </div>`
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
      if (f.required && !form[f.key]) {
        toast(`请填写「${f.label}」`, 'warning')
        return
      }
    }
    btnSave.disabled = true
    btnVerify.disabled = true
    btnSave.textContent = '保存中...'

    try {
      // 如果需要安装插件，先安装并显示日志
      if (reg.pluginRequired) {
        // 飞书特殊处理：根据用户选择的插件版本决定安装包
        let pluginPackage = reg.pluginRequired
        let pluginId = reg.pluginId || pid
        if (pid === 'feishu') {
          const pluginVersionField = modal.querySelector('[data-name="pluginVersion"]')
          const pluginVersion = pluginVersionField?.value || 'builtin'
          localStorage.setItem('clawpanel-feishu-plugin-version', pluginVersion)
          if (pluginVersion === 'official') {
            pluginPackage = '@larksuiteoapi/feishu-openclaw-plugin'
            pluginId = 'feishu-openclaw-plugin'
          }
        }
        const pluginStatus = await api.getChannelPluginStatus(pluginId)
        // 跳过安装：插件已安装 或 已内置（新版 OpenClaw 内置了 feishu 等插件）
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

      // 写入配置（多账号模式传 accountId）
      btnSave.textContent = '写入配置...'
      const accountId = modal.querySelector('input[name="__accountId"]')?.value?.trim() || null
      await api.saveMessagingPlatform(pid, form, accountId)

      // 写入 Agent 绑定到 openclaw.json bindings（多账号时 binding.match 包含 accountId）
      const selectedAgent = modal.querySelector('select[name="__agentBinding"]')?.value || ''
      try {
        await saveChannelBinding(pid, selectedAgent, null, accountId)
      } catch (e) {
        console.warn('[channels] 保存 Agent 绑定失败:', e)
      }

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
  }
  return map[pid] || pid
}

/** 保存渠道→Agent 绑定到 openclaw.json 的 bindings 数组
 * 支持同一渠道多个 Agent 绑定（不同 agentId）
 * oldAgentId: 编辑时替换老绑定
 */
async function saveChannelBinding(pid, agentId, oldAgentId, accountId) {
  const config = await api.readOpenclawConfig()
  if (!config) return
  const channelKey = getChannelBindingKey(pid)
  let bindings = Array.isArray(config.bindings) ? [...config.bindings] : []

  // 构建匹配条件
  const matchesBinding = (b) => {
    if (b.match?.channel !== channelKey) return false
    if (accountId) return (b.match?.accountId || '') === accountId
    return !b.match?.accountId
  }

  // 编辑模式：移除旧绑定
  if (oldAgentId) {
    bindings = bindings.filter(b => !(matchesBinding(b) && (b.agentId || 'main') === oldAgentId))
  }

  // 避免重复
  const effectiveAgent = agentId || 'main'
  bindings = bindings.filter(b => !(matchesBinding(b) && (b.agentId || 'main') === effectiveAgent))

  // 添加新绑定（包含 accountId 用于多账号路由）
  if (agentId) {
    const match = { channel: channelKey }
    if (accountId) match.accountId = accountId
    bindings.push({ agentId, match })
  }

  config.bindings = bindings
  await api.writeOpenclawConfig(config)
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
