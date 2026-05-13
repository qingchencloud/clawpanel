/**
 * 消息渠道管理
 * 渠道列表 + Agent 对接（多绑定、独立配置、渠道测试）
 */
import { api, invalidate, safeTauriListen } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { CHANNEL_LABELS } from '../lib/channel-labels.js'
import { t } from '../lib/i18n.js'
import { termHelpHtml, attachTermTooltips } from '../lib/term-tooltip.js'
import { wsClient } from '../lib/ws-client.js'

// ── 渠道注册表：面板内置向导，覆盖 OpenClaw 官方渠道 + 国内扩展渠道 ──

const PLATFORM_REGISTRY = {
  qqbot: {
    label: t('channels.qqbotLabel'),
    iconName: 'message-square',
    desc: t('channels.qqbotDesc'),
    guide: [
      t('channels.qqbotGuide1'),
      t('channels.qqbotGuide2'),
      t('channels.qqbotGuide3'),
      t('channels.qqbotGuide4'),
      t('channels.qqbotGuide5'),
      t('channels.qqbotGuide6'),
    ],
    guideFooter: t('channels.qqbotGuideFooter'),
    fields: [
      { key: 'appId', label: 'AppID', placeholder: t('channels.qqbotAppIdPh'), required: true },
      { key: 'clientSecret', label: 'ClientSecret', placeholder: t('channels.qqbotSecretPh'), secret: true, required: true },
    ],
    pluginRequired: '@tencent-connect/openclaw-qqbot@latest',
    pluginId: 'qqbot',
  },
  dingtalk: {
    label: t('channels.dingtalkLabel'),
    iconName: 'message-square',
    desc: t('channels.dingtalkDesc'),
    guide: [
      t('channels.dingtalkGuide1'),
      t('channels.dingtalkGuide2'),
      t('channels.dingtalkGuide3'),
      t('channels.dingtalkGuide4'),
      t('channels.dingtalkGuide5'),
      t('channels.dingtalkGuide6'),
      t('channels.dingtalkGuide7'),
    ],
    guideFooter: t('channels.dingtalkGuideFooter'),
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: t('channels.dingtalkClientIdPh'), required: true },
      { key: 'clientSecret', label: 'Client Secret', placeholder: t('channels.dingtalkClientSecretPh'), secret: true, required: true },
    ],
    pluginRequired: '@dingtalk-real-ai/dingtalk-connector@latest',
    pluginId: 'dingtalk-connector',
  },
  feishu: {
    label: t('channels.feishuLabel'),
    iconName: 'message-square',
    desc: t('channels.feishuDesc'),
    guide: [
      t('channels.feishuGuide1'),
      t('channels.feishuGuide2'),
      t('channels.feishuGuide3'),
      t('channels.feishuGuide4'),
      t('channels.feishuGuide5'),
      t('channels.feishuGuide6'),
    ],
    guideFooter: t('channels.feishuGuideFooter'),
    fields: [
      { key: 'appId', label: 'App ID', placeholder: t('channels.feishuAppIdPh'), required: true },
      { key: 'appSecret', label: 'App Secret', placeholder: t('channels.feishuAppSecretPh'), secret: true, required: true },
      {
        key: 'domain', label: t('channels.feishuDomainLabel'), type: 'select',
        options: [
          { value: '', label: t('channels.feishuDomainFeishu') },
          { value: 'lark', label: t('channels.feishuDomainLark') },
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
    desc: t('channels.telegramDesc'),
    guide: [
      t('channels.telegramGuide1'),
      t('channels.telegramGuide2'),
      t('channels.telegramGuide3'),
      t('channels.telegramGuide4'),
    ],
    guideFooter: t('channels.telegramGuideFooter'),
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true, required: true },
    ],
    configKey: 'telegram',
    pairingChannel: 'telegram',
  },
  discord: {
    label: 'Discord',
    iconName: 'hash',
    desc: t('channels.discordDesc'),
    guide: [
      t('channels.discordGuide1'),
      t('channels.discordGuide2'),
      t('channels.discordGuide3'),
      t('channels.discordGuide4'),
    ],
    guideFooter: t('channels.discordGuideFooter'),
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: 'MTExxxxxxxxx.Gxxxxxx.xxxxxxxx', secret: true, required: true },
    ],
    configKey: 'discord',
    pairingChannel: 'discord',
  },
  slack: {
    label: 'Slack',
    iconName: 'hash',
    desc: t('channels.slackDesc'),
    guide: [
      t('channels.slackGuide1'),
      t('channels.slackGuide2'),
      t('channels.slackGuide3'),
      t('channels.slackGuide4'),
      t('channels.slackGuide5'),
    ],
    guideFooter: t('channels.slackGuideFooter'),
    fields: [
      {
        key: 'mode', label: t('channels.modeLabel'), type: 'select', required: true,
        options: [
          { value: 'socket', label: t('channels.slackSocketMode') },
          { value: 'http', label: t('channels.slackHttpMode') },
        ],
      },
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-xxxxxxxxxxxx', secret: true, required: true },
      { key: 'appToken', label: 'App Token', placeholder: 'xapp-xxxxxxxxxxxx', secret: true, requiredWhen: { mode: 'socket' }, hint: t('channels.slackAppTokenHint') },
      { key: 'signingSecret', label: 'Signing Secret', placeholder: t('channels.slackSigningSecretPh'), secret: true, requiredWhen: { mode: 'http' }, hint: t('channels.slackSigningSecretHint') },
      { key: 'teamId', label: 'Team ID', placeholder: t('channels.slackTeamIdPh'), required: false },
      { key: 'webhookPath', label: 'Webhook Path', placeholder: t('channels.slackWebhookPathPh'), required: false },
      { key: 'dmPolicy', label: t('channels.dmPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'allow', label: t('channels.dmAllow') }, { value: 'deny', label: t('channels.dmDeny') }], required: false },
      { key: 'groupPolicy', label: t('channels.groupPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'all', label: t('channels.groupAllChannels') }, { value: 'mentioned', label: t('channels.groupMentionOnly') }, { value: 'allowlist', label: t('channels.groupAllowlist') }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: t('channels.allowFromPh'), required: false, hint: t('channels.allowFromHint') },
    ],
    configKey: 'slack',
    pairingChannel: 'slack',
  },
  // WhatsApp 已移除：上游插件运行时未加载，web.login.start 返回 "not available"
  // 等上游修复后可重新启用
  weixin: {
    label: t('channels.weixinLabel'),
    iconName: 'message-circle',
    desc: t('channels.weixinDesc'),
    guide: [
      t('channels.weixinGuide1'),
      t('channels.weixinGuide2'),
      t('channels.weixinGuide3'),
      t('channels.weixinGuide4'),
      t('channels.weixinGuide5'),
    ],
    guideFooter: t('channels.weixinGuideFooter'),
    actions: [
      { id: 'install', label: t('channels.weixinInstall'), hint: t('channels.weixinInstallHint') },
      { id: 'login', label: t('channels.weixinLogin'), hint: t('channels.weixinLoginHint') },
    ],
    fields: [],
    configKey: 'openclaw-weixin',
    panelSupport: 'action-only',
  },
  msteams: {
    label: 'Microsoft Teams',
    iconName: 'users',
    desc: t('channels.msteamsDesc'),
    guide: [
      t('channels.msteamsGuide1'),
      t('channels.msteamsGuide2'),
      t('channels.msteamsGuide3'),
      t('channels.msteamsGuide4'),
    ],
    guideFooter: t('channels.msteamsGuideFooter'),
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'Azure AD Application ID', required: true },
      { key: 'appPassword', label: 'App Password', placeholder: 'Azure AD Client Secret', secret: true, required: true },
      { key: 'tenantId', label: 'Tenant ID', placeholder: t('channels.msteamsTenantIdPh'), required: false },
      { key: 'botEndpoint', label: 'Bot Endpoint', placeholder: 'https://example.com/api/teams/messages', required: false },
      { key: 'webhookPath', label: 'Webhook Path', placeholder: '/msteams/messages', required: false },
      { key: 'dmPolicy', label: t('channels.dmPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'allow', label: t('channels.dmAllow') }, { value: 'deny', label: t('channels.dmDeny') }], required: false },
      { key: 'groupPolicy', label: t('channels.groupPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'all', label: t('channels.groupAllTeams') }, { value: 'mentioned', label: t('channels.groupMentionOnly') }, { value: 'allowlist', label: t('channels.groupAllowlist') }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: t('channels.msteamsAllowFromPh'), required: false },
    ],
    configKey: 'msteams',
    pluginRequired: '@openclaw/msteams@latest',
    pluginId: 'msteams',
  },
  signal: {
    label: 'Signal',
    iconName: 'shield',
    desc: t('channels.signalDesc'),
    guide: [
      t('channels.signalGuide1'),
      t('channels.signalGuide2'),
      t('channels.signalGuide3'),
    ],
    guideFooter: t('channels.signalGuideFooter'),
    fields: [
      { key: 'account', label: t('channels.signalAccountLabel'), placeholder: t('channels.signalAccountPh'), required: true },
      { key: 'cliPath', label: t('channels.signalCliPathLabel'), placeholder: t('channels.signalCliPathPh'), required: false },
      { key: 'httpUrl', label: 'HTTP URL', placeholder: t('channels.optionalEg', { example: 'http://127.0.0.1:8080' }), required: false },
      { key: 'httpHost', label: 'HTTP Host', placeholder: t('channels.optionalEg', { example: '127.0.0.1' }), required: false },
      { key: 'httpPort', label: 'HTTP Port', placeholder: t('channels.optionalEg', { example: '8080' }), required: false },
      { key: 'dmPolicy', label: t('channels.dmPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'allow', label: t('channels.dmAllow') }, { value: 'deny', label: t('channels.dmDeny') }], required: false },
      { key: 'groupPolicy', label: t('channels.groupPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'all', label: t('channels.groupAllGroups') }, { value: 'mentioned', label: t('channels.groupMentionBot') }, { value: 'allowlist', label: t('channels.groupAllowlist') }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: t('channels.signalAllowFromPh'), required: false },
    ],
    configKey: 'signal',
  },
  matrix: {
    label: 'Matrix',
    iconName: 'globe',
    desc: t('channels.matrixDesc'),
    guide: [
      t('channels.matrixGuide1'),
      t('channels.matrixGuide2'),
      t('channels.matrixGuide3'),
    ],
    guideFooter: t('channels.matrixGuideFooter'),
    fields: [
      { key: 'homeserver', label: 'Homeserver', placeholder: 'https://matrix.org', required: true },
      { key: 'accessToken', label: 'Access Token', placeholder: 'syt_xxxxx', secret: true, required: false, hint: t('channels.matrixAccessTokenHint') },
      { key: 'userId', label: 'User ID', placeholder: '@bot:matrix.org', required: false },
      { key: 'password', label: 'Password', placeholder: t('channels.matrixPasswordPh'), secret: true, required: false },
      { key: 'deviceId', label: 'Device ID', placeholder: t('channels.optionalEg', { example: 'CLAWPANEL' }), required: false },
      { key: 'e2ee', label: 'E2EE', type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'true', label: t('channels.enable') }, { value: 'false', label: t('channels.disable') }], required: false },
      { key: 'dmPolicy', label: t('channels.dmPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'allow', label: t('channels.dmAllow') }, { value: 'deny', label: t('channels.dmDeny') }], required: false },
      { key: 'groupPolicy', label: t('channels.groupPolicy'), type: 'select', options: [{ value: '', label: t('channels.policyDefault') }, { value: 'all', label: t('channels.groupAllRooms') }, { value: 'mentioned', label: t('channels.groupMentionBot') }, { value: 'allowlist', label: t('channels.groupAllowlist') }], required: false },
      { key: 'allowFrom', label: 'Allow From', placeholder: t('channels.matrixAllowFromPh'), required: false },
    ],
    configKey: 'matrix',
    pluginRequired: '@openclaw/matrix@latest',
    pluginId: 'matrix',
  },
}

function parseChannelsRouteIntent() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  return {
    tab: params.get('tab') || '',
    action: params.get('action') || '',
    agentId: params.get('agent') || '',
  }
}

function activateChannelsPageTab(page, key = 'channels') {
  const activeKey = key === 'agents' ? 'agents' : 'channels'
  page.querySelectorAll('#channels-page-tabs .tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.chTab === activeKey)
  })
  const listEl = page.querySelector('#channels-panel-list')
  const agentsEl = page.querySelector('#channels-panel-agents')
  if (listEl) listEl.style.display = activeKey === 'channels' ? '' : 'none'
  if (agentsEl) agentsEl.style.display = activeKey === 'agents' ? '' : 'none'
}

// ── 页面生命周期 ──

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('channels.title')}</h1>
      <p class="page-desc">${t('channels.desc')}</p>
    </div>
    <div class="tab-bar" id="channels-page-tabs">
      <div class="tab active" data-ch-tab="channels">${t('channels.tabChannels')}</div>
      <div class="tab" data-ch-tab="agents">${t('channels.tabAgents')}</div>
    </div>
    <div id="channels-panel-list" class="channels-tab-panel">
      <div id="platforms-configured" style="margin-bottom:var(--space-lg)"></div>
      <div class="config-section">
        <div class="config-section-title">${t('channels.available')}</div>
        <div id="platforms-available" class="platforms-grid"></div>
      </div>
    </div>
    <div id="channels-panel-agents" class="channels-tab-panel" style="display:none">
      <p class="form-hint" style="margin-bottom:var(--space-md)">${t('channels.agentBindHint')}</p>
      <div id="agents-bindings-root"></div>
    </div>
  `

  bindChannelTabs(page)

  const state = {
    configured: [],
    bindings: [],
    agents: [],
    routeIntent: parseChannelsRouteIntent(),
    routeIntentConsumed: false,
    routeIntentHintShown: false,
  }
  await loadPlatforms(page, state)

  return page
}

function bindChannelTabs(page) {
  page.querySelectorAll('#channels-page-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activateChannelsPageTab(page, tab.dataset.chTab)
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
    toast(humanizeError(e, t('channels.loadFailed')), 'error')
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
  applyRouteIntent(page, state)
}

function applyRouteIntent(page, state) {
  const intent = state.routeIntent
  if (!intent) return

  const requestedTab = intent.action === 'bind'
    ? 'agents'
    : (intent.tab === 'agents' ? 'agents' : intent.tab === 'channels' ? 'channels' : '')

  if (requestedTab) activateChannelsPageTab(page, requestedTab)

  if (state.routeIntentConsumed) return

  if (intent.action === 'bind' && intent.agentId) {
    const enabledConfigured = (state.configured || []).filter(p => p.enabled !== false)
    if (!enabledConfigured.length) {
      activateChannelsPageTab(page, 'channels')
      if (!state.routeIntentHintShown) {
        state.routeIntentHintShown = true
        toast(t('channels.enableChannelFirst'), 'info')
      }
      return
    }

    state.routeIntentConsumed = true
    const targetCard = Array.from(page.querySelectorAll('.agent-binding-card')).find(card => card.dataset.agentId === intent.agentId)
    targetCard?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setTimeout(() => openAddAgentBindingModal(intent.agentId, page, state), 0)
    return
  }

  if (requestedTab) state.routeIntentConsumed = true
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
      <div class="config-section-title">${t('channels.configured')}</div>
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
                    <button class="btn btn-xs btn-secondary" data-action="edit-account" data-account-id="${escapeAttr(acc.accountId || '')}">${icon('edit', 12)} ${t('channels.editAccount')}</button>
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
                  <span class="account-count">${t('channels.accountCount', { count: accounts.length })}</span>
                  <span class="platform-status-dot ${p.enabled ? 'on' : 'off'}"></span>
                </div>
                <div class="platform-accounts">${accountsHtml}</div>
                <div class="platform-card-actions">
                  ${supportsMulti ? `<button class="btn btn-sm btn-secondary" data-action="add-account">${icon('plus', 14)} ${t('channels.addAccount')}</button>` : ''}
                  ${reg ? `<button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)} ${t('channels.editDefault')}</button>` : `<span class="form-hint" style="align-self:center">${t('channels.noGuide')}</span>`}
                  <button class="btn btn-sm btn-secondary" data-action="toggle">${p.enabled ? icon('pause', 14) + ' ' + t('channels.disable') : icon('play', 14) + ' ' + t('channels.enable')}</button>
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
                ${supportsMulti ? `<button class="btn btn-sm btn-secondary" data-action="add-account">${icon('plus', 14)} ${t('channels.addAccount')}</button>` : ''}
                ${reg ? `<button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)} ${t('channels.editAccount')}</button>` : `<span class="form-hint" style="align-self:center">${t('channels.noGuide')}</span>`}
                <button class="btn btn-sm btn-secondary" data-action="toggle">${p.enabled ? icon('pause', 14) + ' ' + t('channels.disable') : icon('play', 14) + ' ' + t('channels.enable')}</button>
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
          label: `${icon('edit', 14)} ${t('channels.editAccountLabel', { id: accId })}${acc.appId ? ' · ' + acc.appId : ''}`,
          sub: agents.length ? `${t('channels.bound')}: ${agents.join(', ')}` : t('channels.notBoundAgent'),
          onClick: () => openConfigDialog(pid, page, state, acc.accountId || '')
        })
        actions.push({
          label: `${icon('link', 14)} ${t('channels.addAgentBindingForAccount')}`,
          sub: t('channels.addAgentBindingSub'),
          onClick: () => openAddAgentBindingModalForAccount(pid, acc.accountId || '', page, state)
        })
      })
    } else {
      const agents = getBindingInfo('')
      actions.push({
        label: `${icon('edit', 14)} ${t('channels.editConfig')}`,
        sub: agents.length ? `${t('channels.bound')}: ${agents.join(', ')}` : t('channels.notBoundAgent'),
        onClick: () => openConfigDialog(pid, page, state, null)
      })
      actions.push({
        label: `${icon('link', 14)} ${t('channels.addAgentBinding')}`,
        sub: t('channels.routeToAgent'),
        onClick: () => openAddAgentBindingModalForAccount(pid, null, page, state)
      })
    }

    if (supportsMulti) {
      actions.push({
        label: `${icon('plus', 14)} ${t('channels.addNewAccount')}`,
        sub: t('channels.addNewAccountSub'),
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
      title: `${platformLabel(pid)} ${t('channels.actions')}`,
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
      toast(t('channels.createAgentFirst'), 'warning')
      return
    }

    const configured = state.configured.find(p => p.id === pid)
    const channelKey = getChannelBindingKey(pid)

    const agentOptions = agents.map(a => {
      const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
      return `<option value="${escapeAttr(a.id)}">${a.id}${a.id !== label ? ' — ' + escapeAttr(label) : ''}</option>`
    }).join('')

    const accountLabel = accountId ? t('channels.accountLabel', { id: accountId }) : t('channels.defaultAccount')

    const modal = showContentModal({
      title: t('channels.bindAgentTitle', { platform: platformLabel(pid), account: accountLabel }),
      content: `
        <div class="form-group">
          <label class="form-label">${t('channels.targetAgent')}</label>
          <select class="form-input" id="quick-bind-agent">
            ${agentOptions}
          </select>
          <div class="form-hint">${t('channels.targetAgentHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('channels.peerScope')}</label>
          <select class="form-input" id="quick-bind-peer-kind">
            <option value="">${t('channels.peerAll')}</option>
            <option value="direct">${t('channels.peerDirect')}</option>
            <option value="group">${t('channels.peerGroup')}</option>
          </select>
          <div class="form-hint" id="quick-bind-peer-hint">${t('channels.peerAllHint')}</div>
        </div>
        <div class="form-group" id="quick-bind-peer-id-wrap" style="display:none">
          <label class="form-label" id="quick-bind-peer-id-label">${t('channels.targetId')}</label>
          <input class="form-input" id="quick-bind-peer-id" placeholder="${t('common.loading')}">
          <div class="form-hint" id="quick-bind-peer-id-hint"></div>
        </div>
      `,
      buttons: [{ label: t('channels.saveBinding'), className: 'btn btn-primary', id: 'btn-quick-bind-save' }],
      width: 440,
    })

    const PEER_KIND_HINTS = {
      '': t('channels.peerAllHint'),
      direct: t('channels.peerDirectHint'),
      group: t('channels.peerGroupHint'),
    }
    const PEER_HINT_LABELS = {
      direct: t('channels.peerDirectLabel'),
      group: t('channels.peerGroupLabel'),
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
        if (lblPeerId) lblPeerId.textContent = PEER_HINT_LABELS[kind] || t('channels.targetId')
        if (inpPeerId) inpPeerId.placeholder = kind === 'direct' ? 'ou_xxxxxxxxxxxxxxxx' : 'oc_xxxxxxxxxxxxxxxx'
        if (hintPeerId) hintPeerId.innerHTML = t('channels.peerIdHint')
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
        toast(t('channels.duplicateBinding'), 'warning')
        return
      }

      let bindingConfig = {}
      if (peerKind === 'direct' && peerId) {
        bindingConfig.peer = { kind: 'direct', id: peerId }
      } else if (peerKind === 'group' && peerId) {
        bindingConfig.peer = { kind: 'group', id: peerId }
      }

      modal.querySelector('#btn-quick-bind-save').disabled = true
      modal.querySelector('#btn-quick-bind-save').textContent = t('channels.saving')
      try {
        await api.saveAgentBinding(agentId, channelKey, accountId, bindingConfig)
        toast(t('channels.bindingSaved'), 'success')
        modal.close?.() || modal.remove?.()
        await loadPlatforms(page, state)
      } catch (e) {
        toast(humanizeError(e, t('channels.saveFailed')), 'error')
      } finally {
        modal.querySelector('#btn-quick-bind-save').disabled = false
        modal.querySelector('#btn-quick-bind-save').textContent = t('channels.saveBinding')
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
        const displayName = accountId ? `${platformLabel(pid)} ${t('channels.accountLabel', { id: accountId })}` : `${platformLabel(pid)} ${t('channels.defaultAccount')}`
        const yes = await showConfirm(t('channels.confirmRemoveAccount', { name: displayName }))
        if (!yes) return
        try {
          await api.removeMessagingPlatform(pid, accountId || null)
          toast(t('channels.removed'), 'info')
          await loadPlatforms(page, state)
        } catch (e) { toast(humanizeError(e, t('channels.removeFailed')), 'error') }
      })
    })

    card.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
      const cur = state.configured.find(p => p.id === pid)
      if (!cur) return
      try {
        await api.toggleMessagingPlatform(pid, !cur.enabled)
        toast(`${platformLabel(pid)} ${cur.enabled ? t('channels.disabled') : t('channels.enabled')}`, 'success')
        await loadPlatforms(page, state)
      } catch (e) { toast(humanizeError(e, t('channels.operationFailed')), 'error') }
    })
    card.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
      const channelKey = getChannelBindingKey(pid)
      const linkedBindings = (state.bindings || []).filter(b => b.match?.channel === channelKey).length
      const impact = [
        t('channels.removePlatformImpactConfig'),
        t('channels.removePlatformImpactStop'),
      ]
      if (linkedBindings > 0) {
        impact.unshift(t('channels.removePlatformImpactBindings', { n: linkedBindings }))
      }
      const yes = await showConfirm({
        title: t('channels.removePlatformTitle', { name: platformLabel(pid) }),
        message: t('channels.confirmRemovePlatform', { name: platformLabel(pid) }),
        impact,
        confirmText: t('channels.removePlatformBtn'),
        cancelText: t('channels.removePlatformCancel'),
      })
      if (!yes) return
      try {
        await api.removeMessagingPlatform(pid)
        toast(t('channels.removed'), 'info')
        await loadPlatforms(page, state)
      } catch (e) { toast(humanizeError(e, t('channels.removeFailed')), 'error') }
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
        ${reg.actions?.length ? `<span class="platform-pick-badge" style="color:var(--accent)">${t('channels.supportsActions')}</span>` : ''}
        ${done ? `<span class="platform-pick-badge" style="color:var(--success)">${t('channels.connectedClickEdit')}</span>` : ''}
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
  if (match.accountId) parts.push(`${t('channels.accountShort')} ${match.accountId}`)
  if (peer) {
    if (typeof peer === 'string') {
      parts.push(`${t('channels.peerDm')} ${peer}`)
    } else if (typeof peer === 'object' && peer) {
      const kindLabel = peer.kind === 'group' ? t('channels.peerGroupShort') : peer.kind === 'channel' ? t('channels.peerChannelShort') : t('channels.peerDm')
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
    root.innerHTML = `<div class="stat-card" style="padding:var(--space-xl);text-align:center;color:var(--text-tertiary)">${t('channels.noAgents')}</div>`
    return
  }

  const configured = state.configured || []
  const canBind = configured.filter(p => p.enabled !== false)

  root.innerHTML = rows.map(agent => {
    const aid = agent.id
    const display = agent.identityName ? agent.identityName.split(',')[0].trim() : ''
    const subtitle = agent.orphan
      ? `<span style="color:var(--warning)">${t('channels.orphanAgent')}</span>`
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
              <button type="button" class="btn btn-xs btn-secondary" data-action="test-binding">${icon('zap', 12)} ${t('channels.diagnose')}</button>
              <button type="button" class="btn btn-xs btn-danger" data-action="del-binding">${icon('trash', 12)} ${t('channels.remove')}</button>
            </div>
          </div>`
      }).join('')
      : `<div class="empty-state empty-compact" style="padding:14px 8px"><div class="empty-icon" style="font-size:28px">💬</div><div class="empty-desc">${t('channels.noBindings')}</div></div>`

    const addDisabled = !canBind.length ? 'disabled' : ''
    return `
      <div class="agent-binding-card" data-agent-id="${escapeAttr(aid)}">
        <div class="agent-binding-card-head">
          <div>
            <div class="agent-binding-title">${icon('package', 18)} <code style="font-size:var(--font-size-sm)">${escapeAttr(aid)}</code></div>
            ${subtitle ? `<div class="form-hint" style="margin-top:4px">${subtitle}</div>` : ''}
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-action="add-binding" ${addDisabled}>${icon('plus', 14)} ${t('channels.addChannelBinding')}</button>
        </div>
        <div class="agent-binding-list">${rowsHtml}</div>
      </div>`
  }).join('')

  root.querySelectorAll('[data-action="add-binding"]').forEach(btn => {
    if (btn.disabled) {
      btn.title = t('channels.enableChannelFirst')
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
      const yes = await showConfirm({
        title: t('channels.removeBindingTitle'),
        message: t('channels.confirmRemoveBinding', { agent: aid, summary: formatBindingMatchSummary(binding) }),
        impact: [
          t('channels.removeBindingImpactAgent'),
          t('channels.removeBindingImpactConfig'),
        ],
        confirmText: t('channels.removeBindingBtn'),
        cancelText: t('channels.removeBindingCancel'),
      })
      if (!yes) return
      try {
        await api.deleteAgentBinding(aid, ch, acct, match)
        toast(t('channels.bindingRemoved'), 'success')
        await loadPlatforms(page, state)
      } catch (e) {
        toast(humanizeError(e, t('channels.removeFailed')), 'error')
      }
    })
  })
}

async function openAddAgentBindingModal(agentId, page, state) {
  const configured = (state.configured || []).filter(p => p.enabled !== false)
  if (!configured.length) {
    toast(t('channels.enableChannelFirst'), 'warning')
    return
  }

  const platformOptions = configured.map(p => {
    const label = platformLabel(p.id)
    return `<option value="${escapeAttr(p.id)}">${escapeAttr(label)} (${escapeAttr(p.id)})</option>`
  }).join('')

  const modal = showContentModal({
    title: t('channels.addBindingForAgent', { agent: agentId }),
    content: `
      <div class="form-group">
        <label class="form-label">${t('channels.channel')}</label>
        <select class="form-input" id="add-bind-platform">${platformOptions}</select>
        <div class="form-hint">${t('channels.bindingIndependentHint')}</div>
      </div>

      <div class="form-group" id="add-bind-account-wrap" style="display:none">
        <label class="form-label">${t('channels.subAccount')}</label>
        <select class="form-input" id="add-bind-account"></select>
      </div>

      <div class="form-group" id="add-bind-peer-section">
        <label class="form-label">${t('channels.peerScope')}</label>
        <select class="form-input" id="add-bind-peer-kind">
          <option value="">${t('channels.peerAll')}</option>
          <option value="direct">${t('channels.peerDirect')}</option>
          <option value="group">${t('channels.peerGroup')}</option>
        </select>
        <div class="form-hint" id="add-bind-peer-kind-hint">${t('channels.peerAllHint')}</div>
      </div>

      <div class="form-group" id="add-bind-peer-id-wrap" style="display:none">
        <label class="form-label" id="add-bind-peer-id-label">${t('channels.targetId')}</label>
        <input class="form-input" id="add-bind-peer-id" placeholder="${t('common.loading')}">
        <div class="form-hint" id="add-bind-peer-id-hint"></div>
      </div>

      <div id="add-bind-warning" style="display:none;margin-top:var(--space-sm)"></div>
    `,
    buttons: [{ label: t('channels.saveBinding'), className: 'btn btn-primary', id: 'btn-add-bind-save' }],
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
    '': t('channels.peerAllHint'),
    direct: t('channels.peerDirectHint'),
    group: t('channels.peerGroupHint'),
  }

  const PEER_HINT_LABELS = {
    direct: t('channels.peerDirectLabel'),
    group: t('channels.peerGroupLabel'),
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
      selAcct.innerHTML = `<option value="">— ${t('channels.noMultiAccount')} —</option>`
      selAcct.disabled = true
    }
  }

  // 当账号为空时，在 peer hint 里给出提示
  const syncPeerHint = () => {
    const kind = selPeerKind?.value || ''
    const noAccount = selAcct?.value === '' || selAcct?.disabled
    if (peerHint) {
      if (noAccount && !kind) {
        peerHint.textContent = t('channels.noMultiAccountHint')
      } else {
        peerHint.textContent = PEER_KIND_HINTS[kind] || ''
      }
    }
    if (kind) {
      wrapPeerId.style.display = ''
      if (lblPeerId) lblPeerId.textContent = PEER_HINT_LABELS[kind] || t('channels.targetId')
      if (inpPeerId) inpPeerId.placeholder = kind === 'direct' ? 'ou_xxxxxxxxxxxxxxxx' : 'oc_xxxxxxxxxxxxxxxx'
      if (hintPeerId) hintPeerId.innerHTML = t('channels.peerIdHintDetailed')
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
    const accountId = (selAcct?.disabled || selAcct?.value === '' || selAcct?.value === `— ${t('channels.noMultiAccount')} —`)
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
      toast(t('channels.duplicateBinding'), 'warning')
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
    btnSave.textContent = t('channels.saving')
    try {
      const res = await api.saveAgentBinding(agentId, channelKey, accountId, bindingConfig)

      // 处理警告
      const warnings = res?.warnings || []
      if (warnings.length) {
        warnings.forEach(w => showWarning(w, 'warning'))
      }

      toast(t('channels.bindingSaved'), 'success')
      if (!warnings.length) {
        modal.close?.() || modal.remove?.()
      }
      await loadPlatforms(page, state)
    } catch (e) {
      toast(humanizeError(e, t('channels.saveFailed')), 'error')
    } finally {
      btnSave.disabled = false
      btnSave.textContent = t('channels.saveBinding')
    }
  }

  const btnSave = modal.querySelector('#btn-add-bind-save')
}

function openExternalUrl(href) {
  if (!href) return
  import('@tauri-apps/plugin-shell').then(({ open }) => open(href)).catch(() => window.open(href, '_blank'))
}

function getManualCommandSpecs(pid, reg) {
  if (pid === 'weixin') {
    return [
      {
        id: 'install',
        title: t('channels.manualInstallCommand'),
        hint: t('channels.manualInstallHint', { platform: reg.label }),
        command: 'npx -y @tencent-weixin/openclaw-weixin-cli@latest install',
      },
      {
        id: 'login',
        title: t('channels.manualLoginCommand'),
        hint: t('channels.manualLoginHint'),
        command: 'openclaw channels login --channel openclaw-weixin',
      },
    ]
  }

  if (!['qqbot', 'feishu', 'dingtalk'].includes(pid) || !reg.pluginRequired) {
    return []
  }

  return [{
    id: 'install',
    title: t('channels.manualInstallCommand'),
    hint: t('channels.manualInstallHint', { platform: reg.label }),
    command: `openclaw plugins install ${reg.pluginRequired}`,
  }]
}

function buildManualCommandPanel(commandSpecs) {
  if (!commandSpecs.length) return ''

  return `
    <div style="margin-top:var(--space-md);padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:6px">${t('channels.manualCommands')}</div>
      <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.7;margin-bottom:10px">${t('channels.manualCommandsHint')}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${commandSpecs.map(spec => `
          <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:10px 12px">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
              <div style="min-width:0;flex:1">
                <div style="font-weight:600;font-size:var(--font-size-sm)">${spec.title}</div>
                <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.6;margin-top:4px">${spec.hint}</div>
              </div>
              <button type="button" class="btn btn-xs btn-secondary" data-manual-copy="${escapeAttr(spec.id)}">${t('common.copy')}</button>
            </div>
            <pre style="margin:8px 0 0;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--text-primary)">${escapeAttr(spec.command)}</pre>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  textarea.remove()
  if (!ok) throw new Error('copy failed')
}

function bindManualCommandCopy(root, commandSpecs) {
  if (!root || !commandSpecs.length) return

  const commandMap = new Map(commandSpecs.map(spec => [spec.id, spec.command]))
  root.querySelectorAll('[data-manual-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const command = commandMap.get(btn.dataset.manualCopy)
      if (!command) return
      const prev = btn.textContent
      try {
        await copyTextToClipboard(command)
        btn.textContent = t('common.copied')
        toast(t('common.copied'), 'success')
        setTimeout(() => {
          btn.textContent = prev
        }, 1200)
      } catch (e) {
        toast(humanizeError(e, t('channels.copyCommandFailed')), 'error')
      }
    })
  })
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
    ? `<div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:12px;font-size:var(--font-size-sm)">${t('channels.qqDiagAllPassed')}</div>`
    : `<div style="background:var(--warning-muted);color:var(--warning);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:12px;font-size:var(--font-size-sm)">${t('channels.qqDiagHasFailed')}</div>`

  const repairHint = pluginFailed
    ? `<p class="form-hint" style="margin:10px 0 0;line-height:1.5">${t('channels.qqRepairHint')}</p>`
    : ''

  const buttons = []
  if (pluginFailed) {
    buttons.push({ label: t('channels.qqRepairBtn'), className: 'btn btn-primary', id: 'btn-diag-repair' })
  }
  buttons.push({
    label: t('channels.qqFaqBtn'),
    className: pluginFailed ? 'btn btn-secondary' : 'btn btn-primary',
    id: 'btn-diag-faq',
  })

  const diagModal = showContentModal({
    title: t('channels.qqDiagTitle'),
    content: `${summary}${repairHint}<div style="max-height:min(52vh,420px);overflow-y:auto;margin-bottom:12px;margin-top:12px">${list}</div><div style="font-weight:600;margin-bottom:8px;font-size:var(--font-size-sm)">${t('channels.notes')}</div><ul style="padding-left:18px;font-size:var(--font-size-sm);color:var(--text-secondary);margin:0">${hints}</ul>`,
    buttons,
    width: 540,
  })
  diagModal.querySelector('#btn-diag-faq')?.addEventListener('click', () => openExternalUrl(faqUrl))

  const repairBtn = diagModal.querySelector('#btn-diag-repair')
  repairBtn?.addEventListener('click', async () => {
    const prev = repairBtn.innerHTML
    try {
      repairBtn.disabled = true
      repairBtn.textContent = t('channels.processing')
      const out = await api.repairQqbotChannelSetup()
      toast(out?.message || t('channels.repairDone'), 'success')
      const fresh = await api.diagnoseChannel('qqbot', accountId)
      diagModal.remove()
      showQqDiagnoseModal(fresh, { accountId })
    } catch (e) {
      toast(humanizeError(e, t('channels.repairFailed')), 'error')
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
    toast(t('channels.unknownChannelType'), 'warning')
    return
  }

  const prevHtml = btnEl?.innerHTML
  if (btnEl) {
    btnEl.disabled = true
    btnEl.textContent = channel === 'qqbot' ? t('channels.diagnosing') : t('channels.testing')
  }
  try {
    if (channel === 'qqbot') {
      const result = await api.diagnoseChannel('qqbot', accountId)
      showQqDiagnoseModal(result, { accountId })
      return
    }
    const res = await api.readPlatformConfig(platformId, accountId)
    if (!res?.exists) {
      toast(t('channels.noCredentialsFound'), 'warning')
      return
    }
    const form = res.values || {}
    const out = await api.verifyBotToken(platformId, form)
    if (out.valid) {
      const details = (out.details || []).join(' · ')
      toast(`${t('channels.testPassed')}${details ? ': ' + details : ''}`, 'success')
    } else {
      const errs = (out.errors || [t('channels.verifyFailed')]).join('; ')
      toast(t('channels.testFailed') + ': ' + errs, 'error')
    }
  } catch (e) {
    toast(humanizeError(e, channel === 'qqbot' ? t('channels.diagFailed') : t('channels.testFailed')), 'error')
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
  btn.textContent = t('channels.connectingGateway')

  // 检查 Gateway WebSocket 是否已连接
  if (!wsClient.connected || !wsClient.gatewayReady) {
    resultEl.innerHTML = `
      <div style="background:var(--warning-muted);color:var(--warning);padding:12px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
        ${icon('alert-triangle', 14)} ${t('channels.gatewayNotConnected')}
      </div>`
    btn.disabled = false
    btn.textContent = origLabel
    return
  }

  resultEl.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:16px;text-align:center">
      <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:8px">${t('channels.generatingQr')}</div>
      <div style="width:32px;height:32px;border:3px solid var(--border-primary);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto"></div>
    </div>`

  try {
    btn.textContent = t('channels.generatingQrShort')
    const startResult = await wsClient.request('web.login.start', { force: false })

    if (!startResult?.qrDataUrl) {
      // 已链接或无 QR 数据
      resultEl.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:14px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.6">
          ${icon('check', 14)} ${escapeAttr(startResult?.message || t('channels.whatsappAlreadyLinked'))}
        </div>`
      btn.disabled = false
      btn.textContent = origLabel
      return
    }

    // 显示 QR 码
    resultEl.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:16px;text-align:center">
        <div style="font-size:var(--font-size-sm);font-weight:600;margin-bottom:8px;color:var(--text-primary)">${t('channels.whatsappScanQr')}</div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:12px">${t('channels.whatsappScanPath')}</div>
        <img src="${startResult.qrDataUrl}" alt="WhatsApp QR" style="width:256px;height:256px;image-rendering:pixelated;border-radius:var(--radius-md);border:1px solid var(--border-primary)" />
        <div id="whatsapp-login-status" style="margin-top:12px;font-size:var(--font-size-xs);color:var(--text-tertiary)">${t('channels.waitingScan')}</div>
      </div>`

    // 等待扫码完成
    btn.textContent = t('channels.waitingScan')
    const statusEl = resultEl.querySelector('#whatsapp-login-status')

    const waitResult = await wsClient.request('web.login.wait', { timeoutMs: 120000 })

    if (waitResult?.connected) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--success);font-weight:600">${icon('check', 14)} ${t('channels.linkedSuccess')}</span>`
      resultEl.innerHTML = `
        <div style="background:var(--success-muted);color:var(--success);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
          ${icon('check', 14)} ${t('channels.whatsappLinked')} ${escapeAttr(waitResult.message || '')}
        </div>`
      toast(t('channels.whatsappLinked'), 'success')
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--warning)">${escapeAttr(waitResult?.message || t('channels.scanTimeout'))}</span>`
      resultEl.innerHTML = `
        <div style="background:var(--warning-muted);color:var(--warning);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
          ${icon('alert-triangle', 14)} ${escapeAttr(waitResult?.message || t('channels.scanTimeoutRetry'))}
        </div>`
    }
  } catch (e) {
    const msg = String(e?.message || e)
    // web login provider is not available = WhatsApp 插件未加载
    const hint = /not available|not supported/i.test(msg)
      ? '. ' + t('channels.whatsappNotAvailableHint')
      : ''
    resultEl.innerHTML = `
      <div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.6">
        ${icon('x', 14)} ${t('channels.scanLoginFailed')}: ${escapeAttr(msg)}${hint}
      </div>`
  } finally {
    btn.disabled = false
    btn.textContent = origLabel
  }
}

// ── 配置弹窗（新增 / 编辑共用） ──

async function openConfigDialog(pid, page, state, accountId) {
  const reg = PLATFORM_REGISTRY[pid]
  if (!reg) { toast(t('channels.unknownPlatform'), 'error'); return }

  if (reg.panelSupport === 'docs-only') {
    const docsOnlyContent = `
      ${reg.guide?.length ? `
        <details open style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);margin-bottom:var(--space-md)">
          <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">${t('channels.setupSteps')}</summary>
          <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
            ${reg.guide.map(s => `<li>${s}</li>`).join('')}
          </ol>
          ${reg.guideFooter || ''}
        </details>` : ''}
      <div style="background:rgba(245,158,11,0.12);color:#b45309;padding:12px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:1.7">
        <div style="font-weight:700;margin-bottom:6px">${t('channels.docsOnlyTitle')}</div>
        <div>${reg.supportNote || t('channels.docsOnlyDefault')}</div>
      </div>
    `

    const modal = showContentModal({
      title: `${reg.label} ${t('channels.setupGuide')}`,
      content: docsOnlyContent,
      buttons: [
        { label: t('channels.gotIt'), className: 'btn btn-primary', id: 'btn-close' },
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
        <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">${t('channels.setupSteps')}</summary>
        <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
          ${reg.guide.map(s => `<li>${s}</li>`).join('')}
        </ol>
        ${reg.guideFooter || ''}
      </details>` : ''

    const pluginStatusHtml = pid === 'weixin' ? `
      <div id="weixin-plugin-status" style="padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md);margin-bottom:var(--space-sm);font-size:var(--font-size-sm);color:var(--text-secondary)">
        ${t('channels.detectingPlugin')}
      </div>` : ''

    const manualCommandSpecs = getManualCommandSpecs(pid, reg)
    const manualCommandHtml = buildManualCommandPanel(manualCommandSpecs)

    const actionOnlyBtns = reg.actions?.length ? `
      <div style="padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
        <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:8px">${t('channels.operations')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${reg.actions.map(action => `<button type="button" class="btn btn-sm btn-primary" data-channel-action="${action.id}">${action.label}</button>`).join('')}
        </div>
        ${reg.actions.map(action => action.hint ? `<div class="form-hint" style="margin-top:6px">${action.label}：${action.hint}</div>` : '').join('')}
        <div id="channel-action-result" style="margin-top:10px"></div>
      </div>` : ''

    const modal = showContentModal({
      title: `${reg.label} ${t('channels.setup')}`,
      content: actionOnlyGuide + pluginStatusHtml + manualCommandHtml + actionOnlyBtns,
      buttons: [
        { label: t('channels.close'), className: 'btn btn-secondary', id: 'btn-close' },
      ],
      width: 560,
    })
    bindManualCommandCopy(modal, manualCommandSpecs)
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
          if (!s) { statusEl.textContent = t('channels.pluginStatusFailed'); return }
          const parts = []
          const installBtn = modal.querySelector('[data-channel-action="install"]')
          if (s.installed && s.compatible === false) {
            parts.push(`<span style="color:var(--error);font-weight:600">⚠ ${t('channels.pluginIncompatible')}</span>`)
            parts.push(`${t('channels.version')} <strong>${s.installedVersion || '?'}</strong>`)
            parts.push(`<br><span style="color:var(--error);font-size:var(--font-size-xs)">${s.compatError || t('channels.pluginCompatErrorHint')}</span>`)
            if (installBtn) {
              installBtn.textContent = t('channels.reinstallCompatible')
              installBtn.style.background = 'var(--error)'
            }
          } else if (s.installed) {
            parts.push(`<span style="color:var(--success);font-weight:600">● ${t('channels.pluginInstalled')}</span>`)
            parts.push(`${t('channels.version')} <strong>${s.installedVersion || t('channels.unknown')}</strong>`)
            if (s.updateAvailable && s.latestVersion) {
              parts.push(`<span style="color:var(--warning)">→ ${t('channels.newVersionAvailable', { version: s.latestVersion })}</span>`)
              if (installBtn) installBtn.textContent = t('channels.upgradePlugin')
            } else if (s.latestVersion) {
              parts.push(`<span style="color:var(--text-tertiary)">(${t('channels.upToDate')})</span>`)
            }
          } else {
            parts.push(`<span style="color:var(--text-tertiary)">○ ${t('channels.pluginNotInstalled')}</span>`)
            if (s.latestVersion) parts.push(`${t('channels.latestVersion')} ${s.latestVersion}`)
            parts.push(t('channels.clickInstallBelow'))
          }
          statusEl.innerHTML = parts.join(' ')
        }).catch(() => { statusEl.textContent = t('channels.pluginStatusFailed') })
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
              <span style="font-size:var(--font-size-sm);font-weight:600">${t('channels.executing')}</span>
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
        const listen = safeTauriListen
        let unlistenLog = null, unlistenProgress = null
        let _qrTimer = null
        const cleanup = () => { unlistenLog?.(); unlistenProgress?.(); clearTimeout(_qrTimer) }

        try {
          btn.disabled = true
          btn.textContent = t('channels.executingShort')
          if (logBox) {
            const hint = document.createElement('div')
            hint.style.cssText = 'color:var(--text-tertiary);font-style:italic'
            hint.id = 'action-loading-hint'
            hint.textContent = t('channels.downloadingPlugin')
            logBox.appendChild(hint)
          }
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
            wrap.innerHTML = `<div style="font-size:var(--font-size-sm);font-weight:600;color:#000;margin-bottom:8px">${t('channels.weixinScanQr')}</div>`
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
            if (isQrLine && (actionId === 'login' || actionId === 'install')) {
              _qrBuf.push(msg)
              clearTimeout(_qrTimer)
              _qrTimer = setTimeout(_flushQr, 500)
            } else if (!isQrLine) {
              if (_qrBuf.length && !_qrDone) _flushQr()
              // 检测微信扫码 URL 并渲染为可扫描的二维码
              const weixinUrlMatch = msg.match(/(https:\/\/liteapp\.weixin\.qq\.com\/q\/[^\s]+)/)
              if (weixinUrlMatch && !_qrDone) {
                _qrDone = true
                const qrUrl = weixinUrlMatch[1]
                const wrap = document.createElement('div')
                wrap.style.cssText = 'text-align:center;margin:12px 0;padding:16px;background:#fff;border-radius:var(--radius-md);border:1px solid var(--border-primary)'
                wrap.innerHTML = `
                  <div style="font-size:var(--font-size-sm);font-weight:600;color:#000;margin-bottom:8px">${t('channels.weixinScanQr')}</div>
                  <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}" alt="WeChat QR" style="width:200px;height:200px;image-rendering:pixelated;border-radius:4px;margin:0 auto;display:block" loading="eager">
                  <div style="margin-top:8px"><a href="${escapeAttr(qrUrl)}" target="_blank" rel="noopener" style="color:var(--accent);font-size:var(--font-size-xs);word-break:break-all">${t('channels.weixinOpenInBrowser')}</a></div>
                `
                logBox.appendChild(wrap)
              } else if (msg.trim()) {
                const loadingHint = logBox.querySelector('#action-loading-hint')
                if (loadingHint) loadingHint.remove()
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

          // runChannelAction 的版本由后端自动检测（微信/QQ 版本号独立于 OpenClaw）
          const output = await api.runChannelAction(pid, actionId, null)
          _flushQr() // 命令结束后刷新残留 QR 缓冲
          if (progressBar) progressBar.style.width = '100%'
          if (progressText) progressText.textContent = '100%'
          toast(t('channels.executionDone'), 'success')
          // 安装完成后刷新插件状态
          if (pid === 'weixin' && actionId === 'install') {
            const statusEl = modal.querySelector('#weixin-plugin-status')
            if (statusEl) {
              statusEl.textContent = t('channels.reDetecting')
              api.checkWeixinPluginStatus().then(s => {
                if (!s) return
                const p = []
                if (s.installed) {
                  p.push(`<span style="color:var(--success);font-weight:600">● ${t('channels.pluginInstalled')}</span>`)
                  p.push(`${t('channels.version')} <strong>${s.installedVersion || t('channels.unknown')}</strong>`)
                  if (s.latestVersion) p.push(`<span style="color:var(--text-tertiary)">(${t('channels.upToDate')})</span>`)
                }
                statusEl.innerHTML = p.join(' ') || t('channels.pluginInstalled')
              }).catch(() => {})
            }
          }
          // 登录成功后：显示成功提示 + 刷新渠道列表 + 自动关闭弹窗
          if (actionId === 'login') {
            if (logBox) {
              const banner = document.createElement('div')
              banner.style.cssText = 'margin-top:12px;padding:12px 16px;background:var(--success-bg, #e8f5e9);border:1px solid var(--success, #4caf50);border-radius:var(--radius-md);color:var(--success, #2e7d32);font-weight:600;text-align:center'
              banner.textContent = t('channels.channelConnected')
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
          toast(humanizeError(e, t('channels.executionFailed')), 'error')
          if (logBox) {
            const div = document.createElement('div')
            div.style.color = 'var(--error)'
            div.textContent = t('channels.executionFailed') + ': ' + String(e)
            logBox.appendChild(div)
          }
        } finally {
          cleanup()
          btn.disabled = false
          btn.textContent = reg.actions.find(a => a.id === actionId)?.label || t('channels.execute')
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
      <label class="form-label">${t('channels.accountIdentifier')}</label>
      <input class="form-input" name="__accountId" placeholder="${t('channels.accountIdPlaceholder')}" value="${escapeAttr(accountId != null ? accountId : '')}">
      <div class="form-hint">${t('channels.accountIdHint')}</div>
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
      <label class="form-label">${t('channels.bindAgent')}</label>
      <select class="form-input" name="__agentId" id="form-agent-id">
        ${agentOptions}
      </select>
      <div class="form-hint">${t('channels.bindAgentHint')}</div>
    </div>
  `

  const isFieldRequired = (field, form) => {
    if (field.required) return true
    if (!field.requiredWhen) return false
    return Object.entries(field.requiredWhen).every(([k, expected]) => (form[k] || '') === expected)
  }

  // 字段 label 智能匹配术语 → 自动追加 ⓘ 按钮
  const labelWithHelp = (label) => {
    const l = String(label || '').toLowerCase()
    if (l.includes('bot token')) return label + termHelpHtml('bottoken')
    if (l.includes('webhook')) return label + termHelpHtml('webhook')
    if (l.includes('signing secret') || l.includes('client secret') || l.includes('app secret') || l.includes('api key')) return label + termHelpHtml('apikey')
    return label
  }

  const fieldsHtml = reg.fields.map((f, i) => {
    const val = existing[f.key] || ''
    if (f.type === 'select' && f.options) {
      return `
        <div class="form-group">
          <label class="form-label">${labelWithHelp(f.label)}${f.required ? ' *' : ''}</label>
          <select class="form-input" name="${f.key}" data-name="${f.key}">
            ${f.options.map(o => `<option value="${o.value}" ${val === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>
      `
    }
    return `
      <div class="form-group">
        <label class="form-label">${labelWithHelp(f.label)}${f.required ? ' *' : ''}</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" name="${f.key}" type="${f.secret ? 'password' : 'text'}"
                 value="${escapeAttr(val)}" placeholder="${f.placeholder || ''}"
                 ${i === 0 ? 'autofocus' : ''} style="flex:1">
          ${f.secret ? `<button type="button" class="btn btn-sm btn-secondary toggle-vis" data-field="${f.key}">${t('channels.show')}</button>` : ''}
        </div>
        ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
      </div>
    `
  }).join('')

  const guideHtml = reg.guide?.length ? `
    <details style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);margin-bottom:var(--space-md)">
      <summary style="font-weight:600;font-size:var(--font-size-sm);cursor:pointer;user-select:none">${t('channels.setupSteps')} <span style="color:var(--text-tertiary);font-weight:400">(${t('channels.clickToExpand')})</span></summary>
      <ol style="margin:8px 0 0;padding-left:20px;font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.8">
        ${reg.guide.map(s => `<li>${s}</li>`).join('')}
      </ol>
      ${reg.guideFooter || ''}
    </details>
  ` : ''

  const manualCommandSpecs = getManualCommandSpecs(pid, reg)
  const manualCommandHtml = buildManualCommandPanel(manualCommandSpecs)

  const pairingHtml = reg.pairingChannel ? `
    <div style="margin-top:var(--space-md);padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:6px">${t('channels.pairingApproval')}</div>
      <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.7;margin-bottom:8px">${t('channels.pairingApprovalHint')}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" name="pairingCode" placeholder="${t('channels.pairingCodePlaceholder')}" style="flex:1;min-width:180px">
        <button type="button" class="btn btn-sm btn-secondary" id="btn-pairing-list">${t('channels.viewPending')}</button>
        <button type="button" class="btn btn-sm btn-primary" id="btn-pairing-approve">${t('channels.approvePairingCode')}</button>
      </div>
      <div id="pairing-result" style="margin-top:8px"></div>
    </div>
  ` : ''

  const actionPanelHtml = reg.actions?.length ? `
    <div style="margin-top:var(--space-md);padding:12px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md)">
      <div style="font-weight:600;font-size:var(--font-size-sm);margin-bottom:6px">${t('channels.preActions')}</div>
      <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.7;margin-bottom:8px">${t('channels.preActionsHint')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${reg.actions.map(action => `<button type="button" class="btn btn-sm btn-secondary" data-channel-action="${action.id}">${action.label}</button>`).join('')}
      </div>
      ${reg.actions.map(action => action.hint ? `<div class="form-hint" style="margin-top:6px">${action.label}：${action.hint}</div>` : '').join('')}
      <div id="channel-action-result" style="margin-top:8px"></div>
    </div>
  ` : ''

  const content = `
    ${guideHtml}
    ${!isEdit && (existing.gatewayToken || existing.gatewayPassword) ? `<div style="background:var(--bg-tertiary);color:var(--text-secondary);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">${t('channels.gatewayAuthAutoFilled', { type: existing.gatewayToken ? 'Token' : 'Password' })}</div>` : ''}
    ${isEdit ? `<div style="background:var(--accent-muted);color:var(--accent);padding:8px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm);margin-bottom:var(--space-md)">${t('channels.existingConfigHint')}</div>` : ''}
    <form id="${formId}">
      ${fieldsHtml}
      ${accountIdHtml}
      ${agentBindingHtml}
    </form>
    ${manualCommandHtml}
    ${actionPanelHtml}
    ${pairingHtml}
    <div id="verify-result" style="margin-top:var(--space-sm)"></div>
    ${pid === 'qqbot' ? `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-primary)">
      <button type="button" class="btn btn-sm btn-secondary" id="btn-qq-full-diagnose">${icon('zap', 14)} ${t('channels.fullDiagnose')}</button>
      <p class="form-hint" style="margin-top:8px;margin-bottom:0;line-height:1.55">${t('channels.qqDiagHint')}</p>
    </div>` : ''}
  `

  const modal = showContentModal({
    title: `${isEdit ? t('channels.edit') : t('channels.connect')} ${reg.label}`,
    content,
    buttons: [
      { label: t('channels.verifyCredentials'), className: 'btn btn-secondary', id: 'btn-verify' },
      { label: isEdit ? t('channels.save') : t('channels.connectAndSave'), className: 'btn btn-primary', id: 'btn-save' },
    ],
    width: 520,
  })
  bindManualCommandCopy(modal, manualCommandSpecs)
  attachTermTooltips(modal)

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
        diagBtn.textContent = t('channels.diagnosing')
        const result = await api.diagnoseChannel('qqbot', accountId || null)
        showQqDiagnoseModal(result, { accountId: accountId || null })
      } catch (e) {
        toast(humanizeError(e, t('channels.diagFailed')), 'error')
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
      btn.textContent = show ? t('channels.hide') : t('channels.show')
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
            <span style="font-size:var(--font-size-sm);font-weight:600">${t('channels.executingAction')}</span>
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
      const listen = safeTauriListen
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
        btn.textContent = t('channels.executingShort')
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
            logBox.textContent += (logBox.textContent ? '\n' : '') + t('channels.executionFailed') + ': ' + (e.payload?.message || t('channels.unknownError'))
            logBox.scrollTop = logBox.scrollHeight
          }
        })

        // 微信/QQ 等第三方插件版本号独立，不 pin；run_channel_action 的 version 参数仅用于 npx 包名
        const output = await api.runChannelAction(pid, actionId, null)
        toast(t('channels.actionDone'), 'success')
        if (logBox && output && !String(output).includes(logBox.textContent)) {
          logBox.textContent += (logBox.textContent ? '\n' : '') + String(output)
        }
      } catch (e) {
        toast(humanizeError(e, t('channels.actionFailed')), 'error')
      } finally {
        cleanup()
        btn.disabled = false
        btn.textContent = reg.actions.find(a => a.id === actionId)?.label || t('channels.execute')
      }
    })
  })

  if (btnPairingList && pairingResultEl) {
    btnPairingList.onclick = async () => {
      btnPairingList.disabled = true
      btnPairingList.textContent = t('channels.reading')
      pairingResultEl.innerHTML = ''
      try {
        const output = await api.pairingListChannel(reg.pairingChannel)
        pairingResultEl.innerHTML = `
          <div style="background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:10px 12px">
            <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:6px">${t('channels.pendingRequests')}</div>
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-secondary);font-family:var(--font-mono)">${escapeAttr(output || t('channels.noPendingRequests'))}</pre>
          </div>`
      } catch (e) {
        pairingResultEl.innerHTML = `<div style="color:var(--error);font-size:var(--font-size-sm)">${t('channels.readFailed')}: ${escapeAttr(String(e))}</div>`
      } finally {
        btnPairingList.disabled = false
        btnPairingList.textContent = t('channels.viewPending')
      }
    }
  }

  if (btnPairingApprove && pairingInput && pairingResultEl) {
    btnPairingApprove.onclick = async () => {
      const code = pairingInput.value.trim().toUpperCase()
      if (!code) {
        toast(t('channels.enterPairingCode'), 'warning')
        pairingInput.focus()
        return
      }
      btnPairingApprove.disabled = true
      btnPairingApprove.textContent = t('channels.approving')
      pairingResultEl.innerHTML = ''
      try {
        const output = await api.pairingApproveChannel(reg.pairingChannel, code, !!reg.pairingNotify)
        pairingResultEl.innerHTML = `
          <div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('check', 14)} ${t('channels.pairingApproved')}
            <div style="margin-top:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary)">${escapeAttr(output || t('channels.operationComplete'))}</div>
          </div>`
        pairingInput.value = ''
        toast(t('channels.pairingApproved'), 'success')
      } catch (e) {
        pairingResultEl.innerHTML = `<div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">${t('channels.approveFailed')}: ${escapeAttr(String(e))}</div>`
      } finally {
        btnPairingApprove.disabled = false
        btnPairingApprove.textContent = t('channels.approvePairingCode')
      }
    }
  }

  btnVerify.onclick = async () => {
    const form = collectForm()
    // 前端基础检查
    for (const f of reg.fields) {
      if (isFieldRequired(f, form) && !form[f.key]) {
        toast(t('channels.pleaseFill', { field: f.label }), 'warning')
        return
      }
    }
    btnVerify.disabled = true
    btnVerify.textContent = t('channels.verifying')
    resultEl.innerHTML = ''
    try {
      const res = await api.verifyBotToken(pid, form)
      if (res.valid) {
        const details = (res.details || []).join(' · ')
        resultEl.innerHTML = `
          <div style="background:var(--success-muted);color:var(--success);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('check', 14)} ${t('channels.credentialsValid')}${details ? ' — ' + details : ''}
          </div>
          ${pid === 'qqbot' ? `<div class="form-hint" style="margin-top:8px;line-height:1.55">${t('channels.qqVerifyNote')}</div>` : ''}`
      } else {
        const errs = (res.errors || [t('channels.verifyFailed')]).join('<br>')
        resultEl.innerHTML = `
          <div style="background:var(--error-muted, #fee2e2);color:var(--error);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
            ${icon('x', 14)} ${errs}
          </div>`
      }
    } catch (e) {
      resultEl.innerHTML = `<div style="color:var(--error);font-size:var(--font-size-sm)">${t('channels.verifyRequestFailed')}: ${e}</div>`
    } finally {
      btnVerify.disabled = false
      btnVerify.textContent = t('channels.verifyCredentials')
    }
  }

  // 保存按钮
  btnSave.onclick = async () => {
    const form = collectForm()
    for (const f of reg.fields) {
      if (isFieldRequired(f, form) && !form[f.key]) {
        toast(t('channels.pleaseFill', { field: f.label }), 'warning')
        return
      }
    }
    if (pid === 'matrix' && !form.accessToken && !(form.userId && form.password)) {
      toast(t('channels.matrixAuthRequired'), 'warning')
      return
    }
    btnSave.disabled = true
    btnVerify.disabled = true
    btnSave.textContent = t('channels.saving')

    try {
      // 如果需要安装插件，先安装并显示日志
      if (reg.pluginRequired) {
        const pluginPackage = reg.pluginRequired
        const pluginId = reg.pluginId || pid
        const pluginStatus = await api.getChannelPluginStatus(pluginId)
        // 跳过安装：插件已安装或已内置
        if (!pluginStatus?.installed && !pluginStatus?.builtin) {
          btnSave.textContent = t('channels.installingPlugin')
          resultEl.innerHTML = `
            <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;margin-top:var(--space-sm)">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                ${icon('download', 14)}
                <span style="font-size:var(--font-size-sm);font-weight:600">${t('channels.installPlugin')}</span>
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
            const listen = safeTauriListen
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
            // 自动 pin 插件版本：仅 @openclaw/ 前缀的包与 OpenClaw 版本号同步，其他包（微信 CLI、QQ Bot）版本号独立
            let pluginVersion = null
            if (pluginPackage && pluginPackage.startsWith('@openclaw/')) {
              try {
                const vInfo = await api.getVersionInfo()
                if (vInfo?.current) pluginVersion = vInfo.current.split('-')[0]
              } catch {}
            }
            // QQ 必须用专用安装命令：官方包目录为 openclaw-qqbot，与 install_channel_plugin(…, "qqbot") 的备份路径不一致
            if (pid === 'qqbot') {
              await api.installQqbotPlugin(null)
            } else {
              await api.installChannelPlugin(pluginPackage, pluginId, pluginVersion)
            }
          } catch (e) {
            toast(humanizeError(e, t('channels.pluginInstallFailed')), 'error')
            btnSave.disabled = false
            btnVerify.disabled = false
            btnSave.textContent = isEdit ? t('channels.save') : t('channels.connectAndSave')
            if (unlistenLog) unlistenLog()
            if (unlistenProgress) unlistenProgress()
            return
          }
          if (unlistenLog) unlistenLog()
          if (unlistenProgress) unlistenProgress()
        } else {
          resultEl.innerHTML = `
            <div style="background:var(--accent-muted);color:var(--accent);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--font-size-sm)">
              ${icon('check', 14)} ${t('channels.pluginDetected')}
            </div>`
        }
      }

      // 写入配置
      btnSave.textContent = t('channels.writingConfig')
      const saveAccountId = modal.querySelector('input[name="__accountId"]')?.value?.trim() || null
      const saveAgentId = modal.querySelector('select[name="__agentId"]')?.value?.trim() || 'main'
      await api.saveMessagingPlatform(pid, form, saveAccountId, null)

      // 为该 channel + accountId 创建/更新 agent 绑定
      const channelKey = getChannelBindingKey(pid)
      await api.saveAgentBinding(saveAgentId, channelKey, saveAccountId, {})

      toast(t('channels.configSaved', { platform: reg.label }), 'success')
      modal.close?.() || modal.remove?.()
      await loadPlatforms(page, state)
    } catch (e) {
      toast(humanizeError(e, t('channels.saveFailed')), 'error')
    } finally {
      btnSave.disabled = false
      btnVerify.disabled = false
      btnSave.textContent = isEdit ? t('channels.save') : t('channels.connectAndSave')
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
