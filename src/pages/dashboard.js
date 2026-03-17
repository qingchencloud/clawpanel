/**
 * 仪表盘页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { onGatewayChange } from '../lib/app-state.js'
import { navigate } from '../router.js'

let _unsubGw = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">仪表盘</h1>
      <p class="page-desc">OpenClaw 运行状态概览</p>
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
      <button class="btn btn-secondary" id="btn-restart-gw">重启 Gateway</button>
      <button class="btn btn-secondary" id="btn-check-update">检查更新</button>
      <button class="btn btn-secondary" id="btn-create-backup">创建备份</button>
    </div>
    <div class="config-section">
      <div class="config-section-title">最近日志</div>
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
      cardsEl.innerHTML = `<div class="stat-card" style="grid-column:1/-1;text-align:center;color:var(--text-secondary)"><div>加载失败: ${escapeHtml(String(e?.message || e))}</div><button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="this.closest('.page')&&this.closest('.page').__retryLoad?.()">重试</button></div>`
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

async function loadDashboardData(page, fullRefresh = false) {
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
    (!_dashboardInitialized || fullRefresh) ? api.getVersionInfo() : Promise.resolve(null),
  ]), 15000)
  const secondaryP = withTimeout(Promise.allSettled([
    api.listAgents(),
    api.readMcpConfig(),
    api.listBackups(),
    // getStatusSummary 是最重的调用（spawn openclaw status --json），只在首次加载时调用
    (!_dashboardInitialized || fullRefresh) ? api.getStatusSummary() : Promise.resolve(null),
  ]), 15000).catch(() => [{ status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }])
  const logsP = api.readLogTail('gateway', 20).catch(() => '')

  // 第一波：服务状态 + 配置 + 版本 → 立即渲染统计卡片
  const [servicesRes, configRes, versionRes] = await coreP
  const services = servicesRes.status === 'fulfilled' ? servicesRes.value : []
  const version = versionRes.status === 'fulfilled' ? versionRes.value : {}
  const config = configRes.status === 'fulfilled' ? configRes.value : null
  if (servicesRes.status === 'rejected') toast('服务状态加载失败', 'error')
  if (versionRes.status === 'rejected') toast('版本信息加载失败', 'error')

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
  const statusSummary = statusRes.status === 'fulfilled' ? statusRes.value : null

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
    ? `${version.ahead_of_recommended ? `当前版本高于推荐稳定版 ${version.recommended}，可能不稳定` : version.is_recommended ? '稳定版 ' + version.recommended : '推荐稳定版 ' + version.recommended}${version.latest_update_available && version.latest ? ' · 最新上游 ' + version.latest : ''}`
    : (version.latest_update_available && version.latest ? '最新上游: ' + version.latest : '版本信息未获取')

  const defaultAgent = agents.find(a => a.id === 'main')?.name || 'main'
  const modelCount = config?.models?.providers ? Object.values(config.models.providers).reduce((acc, p) => acc + (p.models?.length || 0), 0) : 0
  const providerCount = config?.models?.providers ? Object.keys(config.models.providers).length : 0

  cardsEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">Gateway</span>
        <span class="status-dot ${gw?.running ? 'running' : 'stopped'}"></span>
      </div>
      <div class="stat-card-value">${gw?.running ? '运行中' : '已停止'}</div>
      <div class="stat-card-meta">${gw?.pid ? 'PID: ' + gw.pid : (gw?.running ? '端口检测' : '未启动')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">版本 · ${version.source === 'official' ? '官方' : '汉化'}</span>
      </div>
      <div class="stat-card-value">${version.current || '未知'}</div>
      <div class="stat-card-meta">${versionMeta}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">Agent 舰队</span>
      </div>
      <div class="stat-card-value">${agents.length} 个</div>
      <div class="stat-card-meta">默认: ${defaultAgent}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">模型池</span>
      </div>
      <div class="stat-card-value">${modelCount} 个</div>
      <div class="stat-card-meta">基于 ${providerCount} 个渠道商</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">基础服务</span>
      </div>
      <div class="stat-card-value">${runningCount}/${services.length}</div>
      <div class="stat-card-meta">存活率 ${services.length ? Math.round(runningCount / services.length * 100) : 0}%</div>
    </div>
    <div class="stat-card stat-card-clickable" id="card-control-ui" title="打开 OpenClaw 原生控制面板">
      <div class="stat-card-header">
        <span class="stat-card-label">Control UI</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="opacity:0.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
      <div class="stat-card-value" style="font-size:var(--font-size-sm)">OpenClaw 原生面板</div>
      <div class="stat-card-meta">${gw?.running ? '点击打开浏览器' : 'Gateway 未运行'}</div>
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
  const lastUpdate = config?.meta?.lastTouchedVersion || '未知'
  const runtimeVer = statusSummary?.runtimeVersion || null
  const sessions = statusSummary?.sessions || null

  const gwPort = config?.gateway?.port || 18789
  const primaryModel = config?.agents?.defaults?.model?.primary || '未设置'

  containerEl.innerHTML = `
    <div class="dashboard-overview">
      <div class="overview-grid">
        <div class="overview-card" data-nav="/gateway">
          <div class="overview-card-icon" style="color:${gw?.running ? 'var(--success)' : 'var(--error)'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">Gateway</div>
            <div class="overview-card-value" style="color:${gw?.running ? 'var(--success)' : 'var(--error)'}">${gw?.running ? '运行中' : '已停止'}</div>
            <div class="overview-card-meta">端口 ${gwPort} ${gw?.pid ? '· PID ' + gw.pid : ''}</div>
          </div>
          <div class="overview-card-actions">
            ${gw?.running
              ? '<button class="btn btn-danger btn-xs" data-action="stop-gw">停止</button><button class="btn btn-secondary btn-xs" data-action="restart-gw">重启</button>'
              : '<button class="btn btn-primary btn-xs" data-action="start-gw">启动</button>'
            }
          </div>
        </div>

        <div class="overview-card" data-nav="/models">
          <div class="overview-card-icon" style="color:var(--accent)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">主模型</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${primaryModel}</div>
            <div class="overview-card-meta">并发上限 ${config?.agents?.defaults?.maxConcurrent || 4}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/skills">
          <div class="overview-card-icon" style="color:var(--warning)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">MCP 工具</div>
            <div class="overview-card-value">${mcpCount} 个</div>
            <div class="overview-card-meta">已挂载扩展</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/services">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">最近备份</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${latestBackup ? formatDate(latestBackup.created_at) : '从无备份'}</div>
            <div class="overview-card-meta">${backups.length} 个备份文件</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/agents">
          <div class="overview-card-icon" style="color:var(--success)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">Agent 舰队</div>
            <div class="overview-card-value">${agents.length} 个</div>
            <div class="overview-card-meta">${agents.filter(a => a.workspace).length} 个独立工作区</div>
          </div>
        </div>

        <div class="overview-card">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">运行时版本</div>
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
      <div class="session-row-meta">${tokens} / ${ctx} · 剩余 ${remaining} · ${pct}%</div>
    </div>`
  })
  const defaultModel = sessions.defaults?.model || '—'
  const defaultCtx = sessions.defaults?.contextTokens ? `${Math.round(sessions.defaults.contextTokens / 1000)}k` : '—'
  return `
    <div class="config-section" style="margin-top:16px">
      <div class="config-section-title">活跃会话 <span style="font-weight:normal;color:var(--text-tertiary);font-size:var(--font-size-xs)">${sessions.count || 0} 个 · 默认模型 ${escapeHtml(defaultModel)} · 上下文 ${defaultCtx}</span></div>
      <div class="session-list">${rows.join('')}</div>
    </div>`
}

function renderLogs(page, logs) {
  const logsEl = page.querySelector('#recent-logs')
  if (!logs) {
    logsEl.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">暂无日志</div>'
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
      toast('打开 Control UI 失败: ' + (e2.message || e2), 'error')
    }
  })

  // 概览区域的 Gateway 启动/停止/重启 + ClawApp 导航
  page.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]')
    if (!actionBtn) return
    const action = actionBtn.dataset.action

    if (action === 'start-gw') {
      actionBtn.disabled = true; actionBtn.textContent = '启动中...'
      try {
        await api.startService('ai.openclaw.gateway')
        toast('Gateway 启动指令已发送', 'success')
        setTimeout(() => loadDashboardData(page), 2000)
      } catch (err) { toast('启动失败: ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = '启动' }
    }
    if (action === 'stop-gw') {
      actionBtn.disabled = true; actionBtn.textContent = '停止中...'
      try {
        await api.stopService('ai.openclaw.gateway')
        toast('Gateway 已停止', 'success')
        setTimeout(() => loadDashboardData(page), 1500)
      } catch (err) { toast('停止失败: ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = '停止' }
    }
    if (action === 'restart-gw') {
      actionBtn.disabled = true; actionBtn.textContent = '重启中...'
      try {
        await api.restartService('ai.openclaw.gateway')
        toast('Gateway 重启指令已发送', 'success')
        setTimeout(() => loadDashboardData(page), 3000)
      } catch (err) { toast('重启失败: ' + err, 'error') }
      finally { actionBtn.disabled = false; actionBtn.textContent = '重启' }
    }
  })

  btnRestart?.addEventListener('click', async () => {
    btnRestart.disabled = true
    btnRestart.classList.add('btn-loading')
    btnRestart.textContent = '重启中...'
    try {
      await api.restartService('ai.openclaw.gateway')
    } catch (e) {
      toast('重启失败: ' + e, 'error')
      btnRestart.disabled = false
      btnRestart.classList.remove('btn-loading')
      btnRestart.textContent = '重启 Gateway'
      return
    }
    // 轮询等待实际重启完成
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      try {
        const s = await api.getServicesStatus()
        const gw = s?.find?.(x => x.label === 'ai.openclaw.gateway') || s?.[0]
        if (gw?.running) {
          toast(`Gateway 已重启 (PID: ${gw.pid})`, 'success')
          btnRestart.disabled = false
          btnRestart.classList.remove('btn-loading')
          btnRestart.textContent = '重启 Gateway'
          loadDashboardData(page)
          return
        }
      } catch {}
      const sec = Math.floor((Date.now() - t0) / 1000)
      btnRestart.textContent = `重启中... ${sec}s`
      await new Promise(r => setTimeout(r, 1500))
    }
    toast('重启超时，Gateway 可能仍在启动中', 'warning')
    btnRestart.disabled = false
    btnRestart.classList.remove('btn-loading')
    btnRestart.textContent = '重启 Gateway'
    loadDashboardData(page)
  })

  btnUpdate?.addEventListener('click', async () => {
    btnUpdate.disabled = true
    btnUpdate.textContent = '检查中...'
    try {
      const info = await api.getVersionInfo()
      if (info.ahead_of_recommended && info.recommended) {
        toast(`当前本地版本 ${info.current || ''} 高于推荐稳定版 ${info.recommended}，可能存在兼容风险`, 'warning')
      } else if (info.update_available && info.recommended) {
        toast(`发现推荐稳定版: ${info.recommended}`, 'info')
      } else if (info.latest_update_available && info.latest) {
        toast(`已对齐推荐稳定版，最新上游为 ${info.latest}`, 'info')
      } else {
        toast('已对齐推荐稳定版', 'success')
      }
    } catch (e) {
      toast('检查更新失败: ' + e, 'error')
    } finally {
      btnUpdate.disabled = false
      btnUpdate.textContent = '检查更新'
    }
  })

  btnCreateBackup?.addEventListener('click', async () => {
    btnCreateBackup.disabled = true
    btnCreateBackup.innerHTML = '备份中...'
    try {
      const res = await api.createBackup()
      toast(`已备份: ${res.name}`, 'success')
      setTimeout(() => loadDashboardData(page), 500)
    } catch (e) {
      toast('备份失败: ' + e, 'error')
    } finally {
      btnCreateBackup.disabled = false
      btnCreateBackup.textContent = '创建备份'
    }
  })
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
