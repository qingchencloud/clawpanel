/**
 * 仪表盘页面
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { getActiveInstance, onGatewayChange } from '../lib/app-state.js'
import { isForeignGatewayError, isForeignGatewayService, maybeShowForeignGatewayBindingPrompt, showGatewayConflictGuidance, showInstallationCleanup } from '../lib/gateway-ownership.js'
import { navigate } from '../router.js'
import { t } from '../lib/i18n.js'
import { wsClient } from '../lib/ws-client.js'
import { attachCliConflictBanner } from '../components/cli-conflict-banner.js'

let _unsubGw = null
let _loadInFlight = false
let _lastGwChangeLoad = 0
let _detachCliConflict = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('dashboard.title')}</h1>
      <p class="page-desc">${t('dashboard.desc')}</p>
    </div>
    <div id="cli-conflict-mount"></div>
    <div id="onboarding-mount"></div>
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
      <button class="btn btn-ghost" id="btn-open-glossary">📖 ${t('glossary.title')}</button>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('dashboard.recentLogs')}</div>
      <div class="log-viewer" id="recent-logs" style="max-height:300px"></div>
    </div>
  `

  // 绑定事件（只绑一次）
  bindActions(page)

  // 挂载 CLI 冲突检测横幅（异步扫描 PATH，发现非 standalone 的 openclaw 时显示）
  const cliConflictMount = page.querySelector('#cli-conflict-mount')
  if (cliConflictMount) {
    if (_detachCliConflict) { try { _detachCliConflict() } catch (_) {} }
    _detachCliConflict = attachCliConflictBanner(cliConflictMount)
  }

  // 异步加载数据
  loadDashboardData(page).catch(e => {
    console.error('[dashboard] loadDashboardData 异常:', e)
    const cardsEl = page.querySelector('#stat-cards')
    if (cardsEl && cardsEl.querySelector('.loading-placeholder')) {
      cardsEl.innerHTML = `<div class="stat-card" style="grid-column:1/-1;text-align:center;color:var(--text-secondary)"><div>${t('common.loadFailed')}: ${escapeHtml(String(e?.message || e))}</div><button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="this.closest('.page')&&this.closest('.page').__retryLoad?.()">${t('dashboard.retry')}</button></div>`
    }
  })
  setTimeout(() => {
    const cardsEl = page.querySelector('#stat-cards')
    if (cardsEl && cardsEl.querySelector('.loading-placeholder')) {
      console.warn('[dashboard] first paint fallback: dashboard APIs are still pending')
      renderStatCards(page, [], _dashboardVersionCache || {}, [], null, null)
      renderLogs(page, '')
    }
  }, 1200)
  page.__retryLoad = () => loadDashboardData(page).catch(() => {})

  // 监听 Gateway 状态变化，节流刷新仪表盘（至少间隔 5 秒，防止状态抖动导致 UI 闪烁）
  if (_unsubGw) _unsubGw()
  _unsubGw = onGatewayChange(() => {
    const now = Date.now()
    if (now - _lastGwChangeLoad < 5000) return
    _lastGwChangeLoad = now
    loadDashboardData(page)
  })

  return page
}

export function cleanup() {
  if (_unsubGw) { _unsubGw(); _unsubGw = null }
  if (_detachCliConflict) { try { _detachCliConflict() } catch (_) {} _detachCliConflict = null }
}

function openclawInstallationIdentity(installation) {
  const rawPath = String(installation?.path || '').trim()
  if (!rawPath) return ''
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows')
  if (!isWin) return rawPath
  return rawPath
    .replace(/\//g, '\\')
    .replace(/\\openclaw(?:\.exe|\.ps1)?$/i, '\\openclaw.cmd')
    .toLowerCase()
}

function dedupeOpenclawInstallations(list = []) {
  const map = new Map()
  const preferCmd = inst => /openclaw\.cmd$/i.test(String(inst?.path || ''))
  for (const installation of Array.isArray(list) ? list : []) {
    const key = openclawInstallationIdentity(installation)
    if (!key) continue
    const existing = map.get(key)
    if (!existing || (!existing.active && installation.active) || (!preferCmd(existing) && preferCmd(installation))) {
      map.set(key, installation)
    }
  }
  return [...map.values()]
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

function versionInfoIncomplete(version) {
  return !version || !version.current || !version.source || version.source === 'unknown'
}

async function loadDashboardData(page, fullRefresh = false) {
  // 并发保护：如果上一次加载仍在进行，跳过本次（fullRefresh 除外）
  if (_loadInFlight && !fullRefresh) return
  _loadInFlight = true
  try { await _loadDashboardDataInner(page, fullRefresh) } finally { _loadInFlight = false }
}

async function _loadDashboardDataInner(page, fullRefresh) {
  syncDashboardInstanceScope()
  // 分波加载：关键数据先渲染，次要数据后填充，减少白屏等待
  // 轻量调用（读文件）每次都做；重量调用（spawn CLI/网络请求）只在首次或手动刷新时做
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${(ms/1000).toFixed(1)}s`)), ms))
  ])
  const shouldFetchVersion = !_dashboardInitialized || fullRefresh || !_dashboardVersionCache || versionInfoIncomplete(_dashboardVersionCache)
  if (shouldFetchVersion && (fullRefresh || versionInfoIncomplete(_dashboardVersionCache))) {
    invalidate('get_version_info')
  }
  // 每个请求独立超时：避免单个慢请求拖垮整体渲染
  const coreP = Promise.allSettled([
    withTimeout(api.getServicesStatus(), 2500),
    withTimeout(api.readOpenclawConfig(), 2000),
    withTimeout(api.readPanelConfig(), 2000),
  ])

  // 第一波：服务状态 + 配置 + 版本 → 立即渲染统计卡片
  const [servicesRes, configRes, panelConfigRes] = await coreP
  const services = servicesRes.status === 'fulfilled' ? servicesRes.value : []
  let version = _dashboardVersionCache || {}
  const config = configRes.status === 'fulfilled' ? configRes.value : null
  const panelConfig = panelConfigRes.status === 'fulfilled' ? panelConfigRes.value : null
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  let agents = []
  const shouldLoadStatusSummary = gw?.running === true
  if (!shouldLoadStatusSummary) {
    _dashboardStatusSummaryCache = null
  }
  if (servicesRes.status === 'rejected') {
    console.warn('[dashboard] getServicesStatus slow/failed:', servicesRes.reason)
    toast(t('dashboard.servicesLoadFail'), 'error')
  }
  if (configRes.status === 'rejected') console.warn('[dashboard] readOpenclawConfig slow/failed:', configRes.reason)
  if (panelConfigRes.status === 'rejected') console.warn('[dashboard] readPanelConfig slow/failed:', panelConfigRes.reason)

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

  renderStatCards(page, services, version, [], config, panelConfig)
  renderLogs(page, '')
  if (gw) {
    maybeShowForeignGatewayBindingPrompt({
      service: gw,
      onRefresh: () => loadDashboardData(page, true),
    }).catch(() => {})
  }

  const versionP = shouldFetchVersion
    ? withTimeout(api.getVersionInfo(), 8000)
      .then(v => {
        if (v) _dashboardVersionCache = v
        return _dashboardVersionCache || {}
      })
      .catch(e => {
        console.warn('[dashboard] getVersionInfo slow/failed:', e)
        return _dashboardVersionCache || {}
      })
    : Promise.resolve(_dashboardVersionCache || {})
  versionP.then(v => {
    if (!page.isConnected) return
    version = v || {}
    renderStatCards(page, services, version, agents, config, panelConfig)
  })

  const secondaryP = Promise.allSettled([
    withTimeout(api.listAgents(), 5000),
    withTimeout(api.readMcpConfig(), 5000),
    withTimeout(api.listBackups(), 5000),
    withTimeout(api.listConfiguredPlatforms(), 5000).catch(() => []),
  ])
  const logsP = withTimeout(api.readLogTail('gateway', 20), 5000).catch(e => {
    console.warn('[dashboard] readLogTail slow/failed:', e)
    return ''
  })

  // 第二波：Agent、MCP、备份 → 更新卡片 + 渲染总览
  const [agentsRes, mcpRes, backupsRes, channelsRes] = await secondaryP
  agents = agentsRes.status === 'fulfilled' ? agentsRes.value : []
  const mcpConfig = mcpRes.status === 'fulfilled' ? mcpRes.value : null
  const backups = backupsRes.status === 'fulfilled' ? backupsRes.value : []
  const channels = channelsRes.status === 'fulfilled' ? (channelsRes.value || []) : []
  let statusSummary = null
  if (shouldLoadStatusSummary) {
    try {
      statusSummary = (!_dashboardInitialized || fullRefresh || !_dashboardStatusSummaryCache)
        ? await withTimeout(api.getStatusSummary(), 10000)
        : _dashboardStatusSummaryCache
      _dashboardStatusSummaryCache = statusSummary
    } catch {
      statusSummary = _dashboardStatusSummaryCache
    }
  }

  renderStatCards(page, services, version, agents, config, panelConfig)
  renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary, channels)
  renderOnboarding(page, { gw, config, agents, channels })

  // 第三波：日志（最低优先级）
  const logs = await logsP
  renderLogs(page, logs)

  _dashboardInitialized = true
}

async function openGatewayConflict(page, error = null, reason = null) {
  const services = await api.getServicesStatus().catch(() => [])
  const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
  await showGatewayConflictGuidance({
    error,
    service: gw,
    reason,
    onRefresh: async () => loadDashboardData(page, true),
  })
}

function renderStatCards(page, services, version, agents, config, panelConfig) {
  const cardsEl = page.querySelector('#stat-cards')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const foreignGateway = isForeignGatewayService(gw)
  const runningCount = services.filter(s => s.running).length
  const versionMeta = version.recommended
    ? `${version.ahead_of_recommended ? t('dashboard.versionAhead', { version: version.recommended }) : version.is_recommended ? t('dashboard.versionStable', { version: version.recommended }) : t('dashboard.versionRecommend', { version: version.recommended })}${version.latest_update_available && version.latest ? ' · ' + t('dashboard.versionLatest', { version: version.latest }) : ''}`
    : (version.latest_update_available && version.latest ? t('dashboard.versionLatest', { version: version.latest }) : t('dashboard.versionUnknown'))

  // CLI 路径信息
  const cliSourceLabel = { standalone: t('dashboard.cliSourceStandalone'), 'npm-zh': t('dashboard.cliSourceNpmZh'), 'npm-official': t('dashboard.cliSourceNpmOfficial'), 'npm-global': t('dashboard.cliSourceNpmGlobal') }[version.cli_source] || t('dashboard.cliSourceUnknown')
  const installCount = dedupeOpenclawInstallations(version.all_installations).length
  const multiInstall = installCount > 1
  const cliBound = !!(panelConfig?.openclawCliPath && String(panelConfig.openclawCliPath).trim())

  const defaultAgent = agents.find(a => a.id === 'main')?.name || 'main'
  const modelCount = config?.models?.providers ? Object.values(config.models.providers).reduce((acc, p) => acc + (p.models?.length || 0), 0) : 0
  const providerCount = config?.models?.providers ? Object.keys(config.models.providers).length : 0

  cardsEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.gateway')}</span>
        <span class="status-dot ${gw?.running ? 'running' : 'stopped'}"></span>
      </div>
      <div class="stat-card-value">${foreignGateway ? t('dashboard.externalInstance') : gw?.running ? t('common.running') : t('common.stopped')}</div>
      <div class="stat-card-meta">${foreignGateway ? t('dashboard.externalGatewayDetected', { pid: gw?.pid ? ' · PID ' + gw.pid : '' }) : gw?.pid ? 'PID: ' + gw.pid : (gw?.running ? t('dashboard.portDetect') : t('dashboard.notStarted'))}</div>
      ${foreignGateway
        ? `<div class="stat-card-meta" style="margin-top:8px;color:var(--warning);line-height:1.6">${t('dashboard.foreignGatewayHint')}</div>
           <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
             <button class="btn btn-secondary btn-xs" data-action="resolve-foreign-gateway">${t('dashboard.viewGuidance')}</button>
             <button class="btn btn-primary btn-xs" data-action="open-settings">${t('dashboard.goSettings')}</button>
           </div>`
        : ''}
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.versionLabel')} · ${version.source === 'official' ? t('dashboard.versionOfficial') : version.source === 'chinese' ? t('dashboard.versionChinese') : t('dashboard.versionUnknownSource')}</span>
      </div>
      <div class="stat-card-value">${version.current || t('common.unknown')}</div>
      <div class="stat-card-meta">${versionMeta}</div>
      ${version.cli_path ? `<div class="stat-card-meta" style="margin-top:2px;font-size:11px;opacity:0.7" title="${escapeHtml(version.cli_path)}">${cliSourceLabel}${multiInstall ? ' · <span' + (cliBound ? '' : ' style="color:var(--warning)"') + '>' + t('dashboard.installCount', { count: installCount }) + '</span>' : ''}</div>` : ''}
      ${multiInstall && !cliBound
        ? `<div class="stat-card-meta" style="margin-top:8px;color:var(--warning);line-height:1.6">${t('dashboard.multiInstallCardHint')}</div>
           <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
             <button class="btn btn-primary btn-xs" data-action="open-cleanup">${t('services.cleanupTitle')}</button>
             <button class="btn btn-secondary btn-xs" data-action="resolve-multi-install">${t('dashboard.viewGuidance')}</button>
             <button class="btn btn-secondary btn-xs" data-action="open-settings">${t('dashboard.goSettings')}</button>
           </div>`
        : multiInstall && cliBound
          ? `<div class="stat-card-meta" style="margin-top:4px;color:var(--text-tertiary);font-size:11px">✓ ${t('dashboard.multiInstallBoundOk', { count: installCount })}</div>
             <div style="margin-top:6px"><button class="btn btn-secondary btn-xs" data-action="open-cleanup">${t('services.cleanupTitle')}</button></div>`
        : ''}
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

function renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary, channels) {
  const containerEl = page.querySelector('#dashboard-overview-container')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const foreignGateway = isForeignGatewayService(gw)
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
  const runtimeMeta = runtimeVer
    ? (statusSummary?.source === 'file-read' ? t('dashboard.runtimeMetaFileRead') : t('dashboard.runtimeMetaLive'))
    : t('dashboard.runtimeMetaConfig')

  const gwPort = config?.gateway?.port || 18789
  const primaryModel = config?.agents?.defaults?.model?.primary || t('dashboard.notSet')

  containerEl.innerHTML = `
    <div class="dashboard-overview">
      <div class="overview-grid">
        <div class="overview-card" data-nav="/gateway">
          <div class="overview-card-icon" style="color:${foreignGateway ? 'var(--warning)' : gw?.running ? 'var(--success)' : 'var(--error)'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">Gateway</div>
            <div class="overview-card-value" style="color:${foreignGateway ? 'var(--warning)' : gw?.running ? 'var(--success)' : 'var(--error)'}">${foreignGateway ? t('dashboard.externalInstance') : gw?.running ? t('common.running') : t('common.stopped')}</div>
            <div class="overview-card-meta">${foreignGateway ? `${t('dashboard.port')} ${gwPort}${gw?.pid ? ' · PID ' + gw.pid : ''} · ${t('dashboard.viewOnlyStatus')}` : `${t('dashboard.port')} ${gwPort} ${gw?.pid ? '· PID ' + gw.pid : ''}`}</div>
          </div>
          <div class="overview-card-actions">
            ${foreignGateway
              ? '<button class="btn btn-secondary btn-xs" data-action="resolve-foreign-gateway">' + t('dashboard.viewGuidance') + '</button><button class="btn btn-primary btn-xs" data-action="open-settings">' + t('dashboard.goSettings') + '</button>'
              : gw?.running
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
            <div class="overview-card-meta">${runtimeMeta}</div>
          </div>
        </div>
      </div>
      ${renderWsStatus()}
      ${renderChannelsOverview(channels)}
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

function renderWsStatus() {
  const connected = wsClient.connected
  const ready = wsClient.gatewayReady
  const reconnecting = wsClient.reconnectState === 'attempting' || wsClient.reconnectState === 'scheduled'
  const attempts = wsClient.reconnectAttempts
  const serverVer = wsClient.serverVersion

  let statusColor, statusLabel, statusDetail
  if (ready) {
    statusColor = 'var(--success)'
    statusLabel = t('dashboard.wsConnected')
    statusDetail = serverVer ? `Gateway ${serverVer}` : ''
  } else if (connected) {
    statusColor = 'var(--warning)'
    statusLabel = t('dashboard.wsHandshaking')
    statusDetail = ''
  } else if (reconnecting) {
    statusColor = 'var(--warning)'
    statusLabel = t('dashboard.wsReconnecting')
    statusDetail = `#${attempts}`
  } else {
    statusColor = 'var(--text-tertiary)'
    statusLabel = t('dashboard.wsDisconnected')
    statusDetail = ''
  }

  return `
    <div class="config-section" style="margin-top:16px">
      <div class="config-section-title" style="display:flex;align-items:center;gap:8px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor}"></span>
        WebSocket ${statusLabel}
        ${statusDetail ? `<span style="font-weight:normal;color:var(--text-tertiary);font-size:var(--font-size-xs)">${escapeHtml(statusDetail)}</span>` : ''}
      </div>
    </div>`
}

const CHANNEL_ICONS = { qqbot: '🐧', qq: '🐧', feishu: '🪶', dingtalk: '📌', telegram: '✈️', discord: '🎮', slack: '💬', weixin: '💚', wechat: '💚', webchat: '🌐', whatsapp: '📱', line: '🟢', teams: '👥', matrix: '🔗' }

function renderChannelsOverview(channels) {
  if (!channels || channels.length === 0) return ''
  const items = channels.map(ch => {
    const icon = CHANNEL_ICONS[ch.platform] || '📡'
    const enabled = ch.enabled !== false
    const dot = enabled ? 'var(--success)' : 'var(--text-tertiary)'
    const name = ch.name || ch.platform || ch.id || ''
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;background:var(--bg-secondary);font-size:var(--font-size-xs);white-space:nowrap">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dot}"></span>
      ${icon} ${escapeHtml(name)}
    </span>`
  })
  return `
    <div class="config-section" style="margin-top:12px">
      <div class="config-section-title">${t('dashboard.connectedChannels')} <span style="font-weight:normal;color:var(--text-tertiary);font-size:var(--font-size-xs)">${channels.length}</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${items.join('')}</div>
    </div>`
}

function parseLogLine(line) {
  // 常见日志格式: [2024-01-15 14:30:25] [INFO] message 或 2024-01-15T14:30:25 INFO message
  const m = line.match(/^[\[（]?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?\s*[\[（]?\s*(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\s*[\]）]?\s*(.*)$/i)
  if (m) return { time: m[1].replace('T', ' ').replace(/\.\d+$/, ''), level: m[2].toUpperCase().replace('WARNING', 'WARN'), msg: m[3] }
  // 简单 level 前缀: INFO: xxx / [ERROR] xxx
  const m2 = line.match(/^[\[（]?\s*(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\s*[\]）:]\s*(.*)$/i)
  if (m2) return { time: '', level: m2[1].toUpperCase().replace('WARNING', 'WARN'), msg: m2[2] }
  return { time: '', level: '', msg: line }
}

const LOG_LEVEL_STYLE = {
  ERROR: 'background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.2)',
  FATAL: 'background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.2)',
  WARN: 'background:rgba(234,179,8,0.12);color:#ca8a04;border:1px solid rgba(234,179,8,0.2)',
  INFO: 'background:rgba(59,130,246,0.10);color:#3b82f6;border:1px solid rgba(59,130,246,0.15)',
  DEBUG: 'background:rgba(148,163,184,0.10);color:#94a3b8;border:1px solid rgba(148,163,184,0.15)',
  TRACE: 'background:rgba(148,163,184,0.08);color:#94a3b8;border:1px solid rgba(148,163,184,0.1)',
}

function renderLogs(page, logs) {
  const logsEl = page.querySelector('#recent-logs')
  if (!logs) {
    logsEl.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">' + t('dashboard.noLogs') + '</div>'
    return
  }
  const lines = logs.trim().split('\n')
  logsEl.innerHTML = lines.map(l => {
    const parsed = parseLogLine(l)
    if (!parsed.level) return `<div class="log-line">${escapeHtml(l)}</div>`
    const badge = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:0.5px;${LOG_LEVEL_STYLE[parsed.level] || ''}">${parsed.level}</span>`
    const time = parsed.time ? `<span style="color:var(--text-tertiary);font-size:11px;opacity:0.7;margin-right:4px">${escapeHtml(parsed.time)}</span>` : ''
    return `<div class="log-line" style="display:flex;align-items:center;gap:6px">${time}${badge}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(parsed.msg)}</span></div>`
  }).join('')
  logsEl.scrollTop = logsEl.scrollHeight
}

function bindActions(page) {
  const btnRestart = page.querySelector('#btn-restart-gw')
  const btnUpdate = page.querySelector('#btn-check-update')
  const btnCreateBackup = page.querySelector('#btn-create-backup')
  page.querySelector('#btn-open-glossary')?.addEventListener('click', () => navigate('/glossary'))

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

    if (action === 'open-settings') {
      navigate('/settings')
      return
    }

    if (action === 'open-cleanup') {
      await showInstallationCleanup({ onRefresh: () => loadDashboardData(page, true) })
      return
    }

    if (action === 'resolve-foreign-gateway') {
      await openGatewayConflict(page, null, 'foreign-gateway')
      return
    }

    if (action === 'resolve-multi-install') {
      await openGatewayConflict(page, null, 'multiple-installations')
      return
    }

    if (action === 'start-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.starting')
      try {
        await api.startService('ai.openclaw.gateway')
        toast(t('dashboard.gwStartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 2000)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.startFail') + ': ' + err, 'error')
      }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.startBtn') }
    }
    if (action === 'stop-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.stopping')
      try {
        await api.stopService('ai.openclaw.gateway')
        toast(t('dashboard.gwStopped'), 'success')
        setTimeout(() => loadDashboardData(page), 1500)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.stopFail') + ': ' + err, 'error')
      }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.stopBtn') }
    }
    if (action === 'restart-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.restarting')
      try {
        await api.restartService('ai.openclaw.gateway')
        toast(t('dashboard.gwRestartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 3000)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.restartFail') + ': ' + err, 'error')
      }
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
      if (isForeignGatewayError(e)) await openGatewayConflict(page, e)
      else toast(humanizeError(e, t('dashboard.restartFail')), 'error')
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
      toast(humanizeError(e, t('dashboard.checkUpdateFail')), 'error')
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
      toast(humanizeError(e, t('dashboard.backupFail')), 'error')
    } finally {
      btnCreateBackup.disabled = false
      btnCreateBackup.textContent = t('dashboard.createBackup')
    }
  })
}

// ── 新手引导卡片 ──
// 4 步任务：启动 Gateway / 加模型 / 创建 Agent / 第一次聊天。
// 全部完成或用户主动关闭后，localStorage 标记隐藏，dashboard 不再渲染。

const ONBOARDING_HIDDEN_KEY = 'clawpanel_onboarding_hidden'

function isOnboardingHidden() {
  try { return localStorage.getItem(ONBOARDING_HIDDEN_KEY) === '1' } catch { return false }
}

function hideOnboarding() {
  try { localStorage.setItem(ONBOARDING_HIDDEN_KEY, '1') } catch {}
}

function getOnboardingSteps({ gw, config, agents, channels }) {
  // 步骤 1：Gateway 启动
  const gwRunning = !!gw?.running
  // 步骤 2：至少配了一个 provider 且非空
  const providers = config?.models?.providers || {}
  const hasModel = Object.keys(providers).length > 0
  // 步骤 3：自定义 Agent（默认 main 不算）
  const agentList = Array.isArray(agents) ? agents : []
  const hasCustomAgent = agentList.some(a => a && a.id && a.id !== 'main')
  // 步骤 4：渠道接入（不是必须，但作为「已开始用」的标志）
  // 实际上更好的判定是「点过聊天页 / 发过一条消息」，但目前没记录，先用 channels 数量作为可选完成判据
  // 改为：把第 4 步定义为「尝试聊天」—— 不强校验，CTA 触发跳转即可（用户点了就当完成）
  const hasChatTried = (() => {
    try { return localStorage.getItem('clawpanel_onboarding_chat_clicked') === '1' } catch { return false }
  })()
  return [
    { id: 'gateway', titleKey: 'onboardingStep1Title', descKey: 'onboardingStep1Desc', ctaKey: 'onboardingStep1Cta', route: '/services', done: gwRunning },
    { id: 'model', titleKey: 'onboardingStep2Title', descKey: 'onboardingStep2Desc', ctaKey: 'onboardingStep2Cta', route: '/models', done: hasModel },
    { id: 'agent', titleKey: 'onboardingStep3Title', descKey: 'onboardingStep3Desc', ctaKey: 'onboardingStep3Cta', route: '/agents', done: hasCustomAgent },
    { id: 'chat', titleKey: 'onboardingStep4Title', descKey: 'onboardingStep4Desc', ctaKey: 'onboardingStep4Cta', route: '/chat', done: hasChatTried, markOnClick: 'clawpanel_onboarding_chat_clicked' },
  ]
}

function renderOnboarding(page, ctx) {
  const mount = page.querySelector('#onboarding-mount')
  if (!mount) return
  if (isOnboardingHidden()) { mount.innerHTML = ''; return }

  const steps = getOnboardingSteps(ctx)
  const allDone = steps.every(s => s.done)
  // 全部完成时显示一条庆祝条 + 关闭按钮
  if (allDone) {
    mount.innerHTML = `
      <div class="onboarding-card onboarding-done-card">
        <div class="onboarding-done-text">${escapeHtml(t('dashboard.onboardingAllDone'))}</div>
        <button class="btn btn-sm btn-secondary" data-onboarding-action="close">${escapeHtml(t('dashboard.onboardingClose'))}</button>
      </div>
    `
    mount.querySelector('[data-onboarding-action="close"]')?.addEventListener('click', () => {
      hideOnboarding()
      mount.innerHTML = ''
    })
    return
  }

  // 渲染 4 步进度卡片
  const stepsHtml = steps.map((s, idx) => {
    const num = idx + 1
    const cls = s.done ? 'onboarding-step done' : 'onboarding-step'
    const badge = s.done
      ? `<span class="onboarding-step-badge done">✓ ${escapeHtml(t('dashboard.onboardingDone'))}</span>`
      : `<span class="onboarding-step-badge todo">${num}</span>`
    const cta = s.done
      ? ''
      : `<button class="btn btn-sm btn-primary" data-onboarding-step="${s.id}">${escapeHtml(t(`dashboard.${s.ctaKey}`))} →</button>`
    return `
      <div class="${cls}">
        ${badge}
        <div class="onboarding-step-body">
          <div class="onboarding-step-title">${escapeHtml(t(`dashboard.${s.titleKey}`))}</div>
          <div class="onboarding-step-desc">${escapeHtml(t(`dashboard.${s.descKey}`))}</div>
        </div>
        <div class="onboarding-step-action">${cta}</div>
      </div>
    `
  }).join('')

  mount.innerHTML = `
    <div class="onboarding-card">
      <div class="onboarding-header">
        <div>
          <div class="onboarding-title">${escapeHtml(t('dashboard.onboardingTitle'))}</div>
          <div class="onboarding-desc">${escapeHtml(t('dashboard.onboardingDesc'))}</div>
        </div>
        <button class="btn btn-xs btn-ghost" data-onboarding-action="close" title="${escapeHtml(t('dashboard.onboardingClose'))}">×</button>
      </div>
      <div class="onboarding-steps">
        ${stepsHtml}
      </div>
    </div>
  `

  mount.querySelector('[data-onboarding-action="close"]')?.addEventListener('click', () => {
    hideOnboarding()
    mount.innerHTML = ''
  })

  steps.forEach(s => {
    if (s.done) return
    const btn = mount.querySelector(`[data-onboarding-step="${s.id}"]`)
    if (!btn) return
    btn.addEventListener('click', () => {
      if (s.markOnClick) {
        try { localStorage.setItem(s.markOnClick, '1') } catch {}
      }
      navigate(s.route)
    })
  })
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
