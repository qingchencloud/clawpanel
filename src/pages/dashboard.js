/**
 * 仪表盘页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

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
      <div class="log-viewer" id="recent-logs" style="max-height:300px"><div class="loading-text">加载中...</div></div>
    </div>
  `

  // 异步加载数据
  loadDashboardData(page)
  return page
}

async function loadDashboardData(page) {
  const [servicesRes, versionRes, logsRes, agentsRes, configRes, tunnelRes, mcpRes, clawappRes, backupsRes] = await Promise.allSettled([
    api.getServicesStatus(),
    api.getVersionInfo(),
    api.readLogTail('gateway', 20),
    api.listAgents(),
    api.readOpenclawConfig(),
    api.getCftunnelStatus(),
    api.readMcpConfig(),
    api.getClawappStatus(),
    api.listBackups(),
  ])

  const services = servicesRes.status === 'fulfilled' ? servicesRes.value : []
  const version = versionRes.status === 'fulfilled' ? versionRes.value : {}
  const logs = logsRes.status === 'fulfilled' ? logsRes.value : ''
  const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : []
  const config = configRes.status === 'fulfilled' ? configRes.value : null
  const tunnel = tunnelRes.status === 'fulfilled' ? tunnelRes.value : null
  const mcpConfig = mcpRes.status === 'fulfilled' ? mcpRes.value : null
  const clawapp = clawappRes.status === 'fulfilled' ? clawappRes.value : null
  const backups = backupsRes.status === 'fulfilled' ? backupsRes.value : []

  if (servicesRes.status === 'rejected') toast('服务状态加载失败', 'error')
  if (versionRes.status === 'rejected') toast('版本信息加载失败', 'error')
  if (logsRes.status === 'rejected') toast('日志加载失败', 'error')

  renderStatCards(page, services, version, agents, config, tunnel)
  renderOverview(page, services, clawapp, tunnel, mcpConfig, backups, config, agents)
  renderLogs(page, logs)
  bindActions(page)
}

function renderStatCards(page, services, version, agents, config, tunnel) {
  const cardsEl = page.querySelector('#stat-cards')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const runningCount = services.filter(s => s.running).length

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
      <div class="stat-card-meta">${gw?.pid ? 'PID: ' + gw.pid : '未启动'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">版本 · ${version.source === 'official' ? '官方' : '汉化'}</span>
      </div>
      <div class="stat-card-value">${version.current || '未知'}</div>
      <div class="stat-card-meta">${version.update_available ? '有新版本: ' + version.latest : '已是最新'}</div>
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
        <span class="stat-card-label">内网穿透隧道</span>
        <span class="status-dot ${tunnel?.running ? 'running' : 'stopped'}"></span>
      </div>
      <div class="stat-card-value">${tunnel?.running ? '运行中' : (tunnel?.installed ? '已停止' : '未配置')}</div>
      <div class="stat-card-meta">${tunnel?.routes ? tunnel.routes.length + ' 个路由映射' : '——'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">基础服务</span>
      </div>
      <div class="stat-card-value">${runningCount}/${services.length}</div>
      <div class="stat-card-meta">存活率 ${services.length ? Math.round(runningCount / services.length * 100) : 0}%</div>
    </div>
  `
}

function renderOverview(page, services, clawapp, tunnel, mcpConfig, backups, config, agents) {
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

  containerEl.innerHTML = `
    <div class="dashboard-overview">
      <div class="overview-section">
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
            Gateway 核心网关
          </div>
          <div class="overview-value" style="color: ${gw?.running ? 'var(--success)' : 'var(--error)'}">
            ${gw?.running ? '运行中' : '已停止'}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            ClawApp 守护进程
          </div>
          <div class="overview-value" style="color: ${clawapp?.running ? 'var(--success)' : 'var(--error)'}">
            ${clawapp?.running ? '端口 ' + clawapp.port : '未启动'}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            Cloudflare 隧道
          </div>
          <div class="overview-value" style="color: ${tunnel?.running ? 'var(--success)' : (tunnel?.installed ? 'var(--warning)' : 'var(--text-tertiary)')}">
            ${tunnel?.running ? tunnel.tunnel_name : (tunnel?.installed ? '已停止' : '未安装')}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
            MCP 扩展工具
          </div>
          <div class="overview-value">
            ${mcpCount} 个已挂载
          </div>
        </div>
      </div>

      <div class="overview-section">
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
            最近备份
          </div>
          <div class="overview-value">
            ${latestBackup ? formatDate(latestBackup.created_at) : '从无备份'}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            配置版本标识
          </div>
          <div class="overview-value">
            ${lastUpdate}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
            并行推理队列最大值
          </div>
          <div class="overview-value">
            ${config?.agents?.defaults?.maxConcurrent || 4}
          </div>
        </div>
        <div class="overview-item">
          <div class="overview-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
            工作区文件隔离
          </div>
          <div class="overview-value" style="color: ${agents.some(a => a.workspace) ? 'var(--success)' : 'var(--text-tertiary)'}">
            ${agents.filter(a => a.workspace).length} 个 Agent 启用
          </div>
        </div>
      </div>
    </div>
  `
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

  btnRestart?.addEventListener('click', async () => {
    btnRestart.disabled = true
    btnRestart.textContent = '重启中...'
    try {
      await api.restartService('ai.openclaw.gateway')
      toast('Gateway 已重启', 'success')
      setTimeout(() => loadDashboardData(page), 500)
    } catch (e) {
      toast('重启失败: ' + e, 'error')
    } finally {
      btnRestart.disabled = false
      btnRestart.textContent = '重启 Gateway'
    }
  })

  btnUpdate?.addEventListener('click', async () => {
    btnUpdate.disabled = true
    btnUpdate.textContent = '检查中...'
    try {
      const info = await api.getVersionInfo()
      if (info.update_available) {
        toast(`发现新版本: ${info.latest}`, 'info')
      } else {
        toast('已是最新版本', 'success')
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
