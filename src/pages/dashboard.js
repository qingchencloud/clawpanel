/**
 * 仪表盘页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { getActiveInstance, onGatewayChange } from '../lib/app-state.js'
import { navigate } from '../router.js'
import { t } from '../lib/i18n.js'

let _unsubGw = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('dashboard.title')}</h1>
      <p class="page-desc">${t('dashboard.desc')}</p>
    </div>
    <div class="stat-cards" id="stat-cards">
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
    </div>
    <div id="dashboard-overview-container"></div>
    <div class="quick-actions">
      <button class="btn btn-secondary" id="btn-restart-gw">${t('dashboard.restartGw')}</button>
      <button class="btn btn-secondary" id="btn-check-update">${t('dashboard.checkUpdate')}</button>
      <button class="btn btn-secondary" id="btn-create-backup">${t('dashboard.createBackup')}</button>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('dashboard.recentLogs')}</div>
      <div class="log-viewer" id="recent-logs" style="max-height:300px"></div>
    </div>
  `

  // 绑定事件（只绑一次）
  bindActions(page)

  // 异步加载数据
  loadDashboardData(page).catch(e => {
    console.error('[dashboard] loadDashboardData 异常:', e)
    const cardsEl = page.querySelector('#stat-cards')
    if (cardsEl && cardsEl.querySelector('.loading-placeholder')) {
      cardsEl.innerHTML = `<div class="stat-card" style="grid-column:1/-1;text-align:center;color:var(--text-secondary)"><div>${t('common.loadFailed')}: ${escapeHtml(String(e?.message || e))}</div><button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="this.closest('.page')&&this.closest('.page').__retryLoad?.()">${t('dashboard.retry')}</button></div>`
    }
  })
  page.__retryLoad = () => loadDashboardData(page).catch(() => {})

  // 监听 Gateway 状态变化，自动刷新仪表盘
  if (_unsubGw) _unsubGw()
  _unsubGw = onGatewayChange(() => {
    loadDashboardData(page)
  })

  return page
}

export function cleanup() {
  if (_unsubGw) { _unsubGw(); _unsubGw = null }
}

let _dashboardInitialized = false
let _dashboardVersionCache = null
let _dashboardStatusSummaryCache = null
let _dashboardInstanceId = ''

function syncDashboardInstanceScope() {
  const instanceId = getActiveInstance()?.id || 'local'
  if (_dashboardInstanceId && _dashboardInstanceId !== instanceId) {
    _dashboardInitialized = false
    _dashboardVersionCache = null
    _dashboardStatusSummaryCache = null
  }
  _dashboardInstanceId = instanceId
}

async function loadDashboardData(page, fullRefresh = false) {
  syncDashboardInstanceScope()
  // 分波加载：关键数据先渲染，次要数据后填充，减少白屏等待
  // 轻量调用（读文件）每次都做；重量调用（spawn CLI/网络请求）只在首次或手动刷新时做
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超时(${ms/1000}s)`)), ms))
  ])
  const coreP = withTimeout(Promise.allSettled([
    api.getServicesStatus(),
    api.readOpenclawConfig(),
    // 版本信息：首次加载或手动刷新时才查询（避免 ARM 设备上频繁查 npm registry）
    (!_dashboardInitialized || fullRefresh || !_dashboardVersionCache) ? api.getVersionInfo() : Promise.resolve(_dashboardVersionCache),
  ]), 15000)
  const secondaryP = withTimeout(Promise.allSettled([
    api.listAgents(),
    api.readMcpConfig(),
    api.listBackups(),
    // getStatusSummary 是最重的调用（spawn openclaw status --json），只在首次加载时调用
    (!_dashboardInitialized || fullRefresh || !_dashboardStatusSummaryCache) ? api.getStatusSummary() : Promise.resolve(_dashboardStatusSummaryCache),
  ]), 15000).catch(() => [{ status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }])
  const logsP = api.readLogTail('gateway', 20).catch(() => '')

  // 第一波：服务状态 + 配置 + 版本 → 立即渲染统计卡片
  const [servicesRes, configRes, versionRes] = await coreP
  const services = servicesRes.status === 'fulfilled' ? servicesRes.value : []
  const version = (versionRes.status === 'fulfilled' && versionRes.value)
    ? (_dashboardVersionCache = versionRes.value)
    : (_dashboardVersionCache || {})
  const config = configRes.status === 'fulfilled' ? configRes.value : null
  if (servicesRes.status === 'rejected') toast(t('dashboard.servicesLoadFail'), 'error')
  if (versionRes.status === 'rejected') toast(t('dashboard.versionLoadFail'), 'error')

  // 自愈：补全关键默认值（先重新读取最新配置再 patch，避免用缓存覆盖其他页面的写入）
  if (config) {
    let needsPatch = false
    if (!config.gateway?.mode) needsPatch = true
    if (config.mode) needsPatch = true
    if (!config.tools || config.tools.profile !== 'full') needsPatch = true
    if (needsPatch) {
      try {
        const freshConfig = await api.readOpenclawConfig()
        let patched = false
        if (!freshConfig.gateway) freshConfig.gateway = {}
        if (!freshConfig.gateway.mode) { freshConfig.gateway.mode = 'local'; patched = true }
        if (freshConfig.mode) { delete freshConfig.mode; patched = true }
        if (!freshConfig.tools || freshConfig.tools.profile !== 'full') {
          freshConfig.tools = { profile: 'full', sessions: { visibility: 'all' }, ...(freshConfig.tools || {}) }
          freshConfig.tools.profile = 'full'
          if (!freshConfig.tools.sessions) freshConfig.tools.sessions = {}
          freshConfig.tools.sessions.visibility = 'all'
          patched = true
        }
        if (patched) api.writeOpenclawConfig(freshConfig).catch(() => {})
      } catch {}
    }
  }

  renderStatCards(page, services, version, [], config)

  // 第二波：Agent、MCP、备份 → 更新卡片 + 渲染总览
  const [agentsRes, mcpRes, backupsRes, statusRes] = await secondaryP
  const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : []
  const mcpConfig = mcpRes.status === 'fulfilled' ? mcpRes.value : null
  const backups = backupsRes.status === 'fulfilled' ? backupsRes.value : []
  const statusSummary = (statusRes.status === 'fulfilled' && statusRes.value)
    ? (_dashboardStatusSummaryCache = statusRes.value)
    : _dashboardStatusSummaryCache

  renderStatCards(page, services, version, agents, config)
  renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary)

  // 第三波：日志（最低优先级）
  const logs = await logsP
  renderLogs(page, logs)

  _dashboardInitialized = true
}

function renderStatCards(page, services, version, agents, config) {
  const cardsEl = page.querySelector('#stat-cards')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const runningCount = services.filter(s => s.running).length
  const versionMeta = version.recommended
    ? `${version.ahead_of_recommended ? t('dashboard.versionAhead', { version: version.recommended }) : version.is_recommended ? t('dashboard.versionStable', { version: version.recommended }) : t('dashboard.versionRecommend', { version: version.recommended })}${version.latest_update_available && version.latest ? ' · ' + t('dashboard.versionLatest', { version: version.latest }) : ''}`
    : (version.latest_update_available && version.latest ? t('dashboard.versionLatest', { version: version.latest }) : t('dashboard.versionUnknown'))

  // CLI 路径信息
  const cliSourceLabel = { standalone: t('dashboard.cliSourceStandalone'), 'npm-zh': t('dashboard.cliSourceNpmZh'), 'npm-official': t('dashboard.cliSourceNpmOfficial'), 'npm-global': t('dashboard.cliSourceNpmGlobal') }[version.cli_source] || t('dashboard.cliSourceUnknown')
  const installCount = version.all_installations?.length || 0
  const multiInstall = installCount > 1

  const defaultAgent = agents.find(a => a.id === 'main')?.name || 'main'
  const modelCount = config?.models?.providers ? Object.values(config.models.providers).reduce((acc, p) => acc + (p.models?.length || 0), 0) : 0
  const providerCount = config?.models?.providers ? Object.keys(config.models.providers).length : 0

  cardsEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.gateway')}</span>
        <span class="status-dot ${gw?.running ? 'running' : 'stopped'}"></span>
      </div>
      <div class="stat-card-value">${gw?.running ? t('common.running') : t('common.stopped')}</div>
      <div class="stat-card-meta">${gw?.pid ? 'PID: ' + gw.pid : (gw?.running ? t('dashboard.portDetect') : t('dashboard.notStarted'))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.versionLabel')} · ${version.source === 'official' ? t('dashboard.versionOfficial') : version.source === 'chinese' ? t('dashboard.versionChinese') : t('dashboard.versionUnknownSource')}</span>
      </div>
      <div class="stat-card-value">${version.current || t('common.unknown')}</div>
      <div class="stat-card-meta">${versionMeta}</div>
      ${version.cli_path ? `<div class="stat-card-meta" style="margin-top:2px;font-size:11px;opacity:0.7" title="${escapeHtml(version.cli_path)}">${cliSourceLabel}${multiInstall ? ' · <span style="color:var(--warning)">' + t('dashboard.installCount', { count: installCount }) + '</span>' : ''}</div>` : ''}
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.agentFleet')}</span>
      </div>
      <div class="stat-card-value">${agents.length} ${t('common.unit')}</div>
      <div class="stat-card-meta">${t('dashboard.defaultAgent')}: ${defaultAgent}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.modelPool')}</span>
      </div>
      <div class="stat-card-value">${modelCount} ${t('common.unit')}</div>
      <div class="stat-card-meta">${t('dashboard.basedOnProviders', { count: providerCount })}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.baseServices')}</span>
      </div>
      <div class="stat-card-value">${runningCount}/${services.length}</div>
      <div class="stat-card-meta">${t('common.survivalRate')} ${services.length ? Math.round(runningCount / services.length * 100) : 0}%</div>
    </div>
    <div class="stat-card stat-card-clickable" id="card-control-ui" title="${t('dashboard.controlUIDesc')}">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.controlUI')}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="opacity:0.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
      <div class="stat-card-value" style="font-size:var(--font-size-sm)">${t('dashboard.controlUIDesc')}</div>
      <div class="stat-card-meta">${gw?.running ? t('dashboard.controlUIClick') : t('dashboard.controlUINotRunning')}</div>
    </div>
  `
}

function renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary) {
  const containerEl = page.querySelector('#dashboard-overview-container')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const mcpCount = mcpConfig?.mcpServers ? Object.keys(mcpConfig.mcpServers).length : 0

  const formatDate = (timestamp) => {
    if (!timestamp) return '——'
    const d = new Date(timestamp * 1000)
    const mon = d.getMonth() + 1
    const day = d.getDate()
    const hr = d.getHours().toString().padStart(2, '0')
    const min = d.getMinutes().toString().padStart(2, '0')
    return mon + '-' + day + ' ' + hr + ':' + min
  }

  const latestBackup = backups.length > 0 ? backups.sort((a,b) => b.created_at - a.created_at)[0] : null
  const lastUpdate = config?.meta?.lastTouchedVersion || t('common.unknown')
  const runtimeVer = statusSummary?.runtimeVersion || null
  const sessions = statusSummary?.sessions || null

  const gwPort = config?.gateway?.port || 18789
  const primaryModel = config?.agents?.defaults?.model?.primary || t('dashboard.notSet')

  containerEl.innerHTML = `
    <div class="dashboard-overview">
      <div class="overview-grid">
        <div class="overview-card" data-nav="/gateway">
          <div class="overview-card-icon" style="color:${gw?.running ? 'var(--success)' : 'var(--error)'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">Gateway</div>
            <div class="overview-card-value" style="color:${gw?.running ? 'var(--success)' : 'var(--error)'}">${gw?.running ? t('common.running') : t('common.stopped')}</div>
            <div class="overview-card-meta">${t('dashboard.port')} ${gwPort} ${gw?.pid ? '· PID ' + gw.pid : ''}</div>
          </div>
          <div class="overview-card-actions">
            ${gw?.running
              ? '<button class="btn btn-danger btn-xs" data-action="stop-gw">' + t('dashboard.stopBtn') + '</button><button class="btn btn-secondary btn-xs" data-action="restart-gw">' + t('dashboard.restartBtn') + '</button>'
              : '<button class="btn btn-primary btn-xs" data-action="start-gw">' + t('dashboard.startBtn') + '</button>'
            }
          </div>
        </div>

        <div class="overview-card" data-nav="/models">
          <div class="overview-card-icon" style="color:var(--accent)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.primaryModel')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${primaryModel}</div>
            <div class="overview-card-meta">${t('dashboard.maxConcurrent')} ${config?.agents?.defaults?.maxConcurrent || 4}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/skills">
          <div class="overview-card-icon" style="color:var(--warning)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.mcpTools')}</div>
            <div class="overview-card-value">${mcpCount}</div>
            <div class="overview-card-meta">${t('dashboard.mountedExtensions')}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/services">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.recentBackup')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${latestBackup ? formatDate(latestBackup.created_at) : t('dashboard.noBackup')}</div>
            <div class="overview-card-meta">${t('dashboard.backupCount', { count: backups.length })}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/agents">
          <div class="overview-card-icon" style="color:var(--success)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.agentFleet')}</div>
            <div class="overview-card-value">${agents.length}</div>
            <div class="overview-card-meta">${t('dashboard.workspaceCount', { count: agents.filter(a => a.workspace).length })}</div>
          </div>
        </div>

        <div class="overview-card">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.runtimeVersion')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${runtimeVer || lastUpdate}</div>
            <div class="overview-card-meta">${runtimeVer ? 'OpenClaw Runtime' : 'openclaw.json'}</div>
          </div>
        </div>
      </div>
      ${renderSessionStatus(sessions)}
    </div>
  `

  // 概览卡片点击导航
  containerEl.querySelectorAll('[data-nav]').forEach(card => {
    card.style.cursor = 'pointer'
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return
      navigate(card.dataset.nav)
    })
  })
}

function renderSessionStatus(sessions) {
  if (!sessions || !sessions.recent || sessions.recent.length === 0) return ''
  const rows = sessions.recent.slice(0, 5).map(s => {
    const pct = s.percentUsed ?? 0
    const barColor = pct > 80 ? 'var(--error)' : pct > 50 ? 'var(--warning)' : 'var(--success)'
    const flags = (s.flags || []).map(f => `<span class="session-flag">${escapeHtml(f)}</span>`).join('')
    const model = s.model ? `<span class="session-model">${escapeHtml(s.model)}</span>` : ''
    const tokens = s.totalTokens != null && s.totalTokens > 0 ? `${Math.round(s.totalTokens / 1000)}k` : '0'
    const ctx = s.contextTokens != null ? `${Math.round(s.contextTokens / 1000)}k` : '—'
    const remaining = s.remainingTokens != null ? `${Math.round(s.remainingTokens / 1000)}k` : ctx
    const key = escapeHtml(s.key || '').replace(/^agent:main:/, '')
    return `<div class="session-row">
      <div class="session-row-header">
        <span class="session-key" title="${escapeHtml(s.key || '')}">${key || '—'}</span>
        ${model}${flags}
      </div>
      <div class="session-bar-wrap">
        <div class="session-bar" style="width:${Math.min(pct, 100)}%;background:${barColor}"></div>
      </div>
      <div class="session-row-meta">${tokens} / ${ctx} · ${t('dashboard.remaining')} ${remaining} · ${pct}%</div>
    </div>`
  })
  const defaultModel = sessions.defaults?.model || '—'
  const defaultCtx = sessions.defaults?.contextTokens ? `${Math.round(sessions.defaults.contextTokens / 1000)}k` : '—'
  return `
    <div class="config-section" style="margin-top:16px">
      <div class="config-section-title">${t('dashboard.activeSessions')} <span style="font-weight:normal;color:var(--text-tertiary);font-size:var(--font-size-xs)">${sessions.count || 0} · ${t('dashboard.defaultModel')} ${escapeHtml(defaultModel)} · ${t('dashboard.context')} ${defaultCtx}</span></div>
      <div class="session-list">${rows.join('')}</div>
    </div>`
}

function renderLogs(page, logs) {
  const logsEl = page.querySelector('#recent-logs')
  if (!logs) {
    logsEl.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">' + t('dashboard.noLogs') + '</div>'
    return
  }
  const lines = logs.trim().split('\n')
  logsEl.innerHTML = lines.map(l => `<div class="log-line">${escapeHtml(l)}</div>`).join('')
  logsEl.scrollTop = logsEl.scrollHeight
}

function bindActions(page) {
  const btnRestart = page.querySelector('#btn-restart-gw')
  const btnUpdate = page.querySelector('#btn-check-update')
  const btnCreateBackup = page.querySelector('#btn-create-backup')

  // Control UI 卡片点击 → 打开 OpenClaw 原生面板（用事件委托，因为卡片是动态渲染的）
  page.addEventListener('click', async (e) => {
    const card = e.target.closest('#card-control-ui')
    if (!card) return
    if (e.target.closest('button')) return
    try {
      const config = await api.readOpenclawConfig()
      const port = config?.gateway?.port || 18789
      // 远程部署时使用当前浏览器域名/IP，桌面版用 127.0.0.1
      const host = window.__TAURI_INTERNALS__ ? '127.0.0.1' : (location.hostname || '127.0.0.1')
      const proto = location.protocol === 'https:' ? 'https' : 'http'
      let url = `${proto}://${host}:${port}`
      // 如果 Gateway 配置了 token 鉴权，附加到 URL 方便直接访问
      const authToken = config?.gateway?.auth?.token
      if (authToken) url += `?token=${encodeURIComponent(authToken)}`
      // 尝试多种方式打开浏览器
      if (window.__TAURI_INTERNALS__) {
        try {
          const { open } = await import('@tauri-apps/plugin-shell')
          await open(url)
        } catch {
          window.open(url, '_blank')
        }
      } else {
        window.open(url, '_blank')
      }
    } catch (e2) {
      toast(t('dashboard.openControlUIFail') + ': ' + (e2.message || e2), 'error')
    }
  })

  // 概览区域的 Gateway 启动/停止/重启 + ClawApp 导航
  page.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]')
    if (!actionBtn) return
    const action = actionBtn.dataset.action

    if (action === 'start-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.starting')
      try {
        await api.startService('ai.openclaw.gateway')
        toast(t('dashboard.gwStartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 2000)
      } catch (err) { toast(t('dashboard.startFail') + ': ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.startBtn') }
    }
    if (action === 'stop-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.stopping')
      try {
        await api.stopService('ai.openclaw.gateway')
        toast(t('dashboard.gwStopped'), 'success')
        setTimeout(() => loadDashboardData(page), 1500)
      } catch (err) { toast(t('dashboard.stopFail') + ': ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.stopBtn') }
    }
    if (action === 'restart-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.restarting')
      try {
        await api.restartService('ai.openclaw.gateway')
        toast(t('dashboard.gwRestartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 3000)
      } catch (err) { toast(t('dashboard.restartFail') + ': ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.restartBtn') }
    }
  })

  btnRestart?.addEventListener('click', async () => {
    btnRestart.disabled = true
    btnRestart.classList.add('btn-loading')
    btnRestart.textContent = t('dashboard.restarting')
    try {
      await api.restartService('ai.openclaw.gateway')
    } catch (e) {
      toast(t('dashboard.restartFail') + ': ' + e, 'error')
      btnRestart.disabled = false
      btnRestart.classList.remove('btn-loading')
      btnRestart.textContent = t('dashboard.restartGw')
      return
    }
    // 轮询等待实际重启完成
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      try {
        const s = await api.getServicesStatus()
        const gw = s?.find?.(x => x.label === 'ai.openclaw.gateway') || s?.[0]
        if (gw?.running) {
          toast(t('dashboard.gwRestarted', { pid: gw.pid }), 'success')
          btnRestart.disabled = false
          btnRestart.classList.remove('btn-loading')
          btnRestart.textContent = t('dashboard.restartGw')
          loadDashboardData(page)
          return
        }
      } catch {}
      const sec = Math.floor((Date.now() - t0) / 1000)
      btnRestart.textContent = t('dashboard.restarting') + ` ${sec}s`
      await new Promise(r => setTimeout(r, 1500))
    }
    toast(t('dashboard.restartTimeout'), 'warning')
    btnRestart.disabled = false
    btnRestart.classList.remove('btn-loading')
    btnRestart.textContent = t('dashboard.restartGw')
    loadDashboardData(page)
  })

  btnUpdate?.addEventListener('click', async () => {
    btnUpdate.disabled = true
    btnUpdate.textContent = t('dashboard.checking')
    try {
      const info = await api.getVersionInfo()
      _dashboardVersionCache = info
      if (info.ahead_of_recommended && info.recommended) {
        toast(t('dashboard.versionAheadWarn', { current: info.current || '', recommended: info.recommended }), 'warning')
      } else if (info.update_available && info.recommended) {
        toast(t('dashboard.updateAvailable', { version: info.recommended }), 'info')
      } else if (info.latest_update_available && info.latest) {
        toast(t('dashboard.alignedWithLatest', { version: info.latest }), 'info')
      } else {
        toast(t('dashboard.upToDate'), 'success')
      }
    } catch (e) {
      toast(t('dashboard.checkUpdateFail') + ': ' + e, 'error')
    } finally {
      btnUpdate.disabled = false
      btnUpdate.textContent = t('dashboard.checkUpdate')
    }
  })

  btnCreateBackup?.addEventListener('click', async () => {
    btnCreateBackup.disabled = true
    btnCreateBackup.innerHTML = t('dashboard.backingUp')
    try {
      const res = await api.createBackup()
      toast(t('dashboard.backupDone', { name: res.name }), 'success')
      setTimeout(() => loadDashboardData(page), 500)
    } catch (e) {
      toast(t('dashboard.backupFail') + ': ' + e, 'error')
    } finally {
      btnCreateBackup.disabled = false
      btnCreateBackup.textContent = t('dashboard.createBackup')
    }
  })
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
