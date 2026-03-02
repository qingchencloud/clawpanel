/**
 * 扩展工具页面
 * cftunnel 隧道管理 + ClawApp 状态
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

// HTML 转义，防止 XSS
function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">扩展工具</h1>
      <p class="page-desc">管理 cftunnel 内网穿透和 ClawApp 移动客户端</p>
    </div>
    <div id="cftunnel-card" class="config-section">
      <div class="config-section-title">cftunnel 内网穿透</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">通过 Cloudflare Tunnel 将本地服务暴露到公网，无需公网 IP 和端口映射。</div>
      <div id="cftunnel-content" class="loading-text">加载中...</div>
    </div>
    <div id="clawapp-card" class="config-section">
      <div class="config-section-title">ClawApp 移动客户端</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">基于 LobeChat 的 AI 对话客户端，通过 Gateway 连接模型服务。支持本地和外网访问。</div>
      <div id="clawapp-content" class="loading-text">加载中...</div>
    </div>
  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  await Promise.all([
    loadCftunnel(page),
    loadClawapp(page),
  ])
}

// ===== cftunnel =====

async function loadCftunnel(page) {
  const el = page.querySelector('#cftunnel-content')
  el.innerHTML = '<div class="loading-text">加载中...</div>'
  try {
    const status = await api.getCftunnelStatus()
    renderCftunnel(el, status)
  } catch (e) {
    el.innerHTML = `<div style="color:var(--error)">加载失败: ${e}</div>`
  }
}

function renderCftunnel(el, s) {
  if (!s.installed) {
    el.innerHTML = `
      <div style="color:var(--text-tertiary);margin-bottom:var(--space-md)">cftunnel 未安装</div>
      <div style="display:flex;gap:var(--space-sm);align-items:center">
        <button class="btn btn-primary btn-sm" data-action="install-cftunnel">一键安装</button>
        <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/cftunnel" target="_blank" rel="noopener">查看文档</a>
      </div>
      <div id="install-progress-area"></div>
    `
    return
  }

  const running = s.running
  const routes = s.routes || []

  el.innerHTML = `
    <div class="stat-cards" style="margin-bottom:var(--space-md)">
      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-label">状态</span>
          <span class="status-dot ${running ? 'running' : 'stopped'}"></span>
        </div>
        <div class="stat-card-value">${running ? '运行中' : '已停止'}</div>
        <div class="stat-card-meta">${s.tunnel_name || ''}${s.pid ? ' (PID: ' + s.pid + ')' : ''}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">版本</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-md)">${s.version || '未知'}</div>
        <div class="stat-card-meta">${routes.length} 条路由</div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-md)">
      ${running
        ? '<button class="btn btn-danger btn-sm" data-action="cftunnel-down">停止隧道</button>'
        : '<button class="btn btn-primary btn-sm" data-action="cftunnel-up">启动隧道</button>'
      }
      <button class="btn btn-secondary btn-sm" data-action="cftunnel-logs">查看日志</button>
      <button class="btn btn-secondary btn-sm" data-action="cftunnel-refresh">刷新</button>
    </div>
    ${renderRoutes(routes)}
    <div id="cftunnel-logs-area"></div>
  `
}

function renderRoutes(routes) {
  if (!routes.length) return '<div style="color:var(--text-tertiary);padding:var(--space-md) 0">暂无路由</div>'
  return `
    <div class="tunnel-routes">
      ${routes.map(r => `
        <div class="tunnel-route-card">
          <div class="tunnel-route-header">
            <span class="tunnel-route-name">${escapeHtml(r.name)}</span>
            <span class="tunnel-route-badge">
              <span class="status-dot running" style="width:6px;height:6px"></span>
              活跃
            </span>
          </div>
          <div class="tunnel-route-domain">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
            <a href="https://${escapeHtml(r.domain)}" target="_blank" rel="noopener">${escapeHtml(r.domain)}</a>
          </div>
          <div class="tunnel-route-service">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-tertiary)">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
              <line x1="6" y1="6" x2="6.01" y2="6"></line>
              <line x1="6" y1="18" x2="6.01" y2="18"></line>
            </svg>
            <span>本地服务:</span>
            <code>${escapeHtml(r.service)}</code>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

// ===== ClawApp =====

async function loadClawapp(page) {
  const el = page.querySelector('#clawapp-content')
  el.innerHTML = '<div class="loading-text">加载中...</div>'
  try {
    const status = await api.getClawappStatus()
    renderClawapp(el, status)
  } catch (e) {
    el.innerHTML = `<div style="color:var(--error)">加载失败: ${e}</div>`
  }
}

function renderClawapp(el, s) {
  const running = s.running
  el.innerHTML = `
    <div class="stat-cards" style="margin-bottom:var(--space-md)">
      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-label">状态</span>
          <span class="status-dot ${running ? 'running' : 'stopped'}"></span>
        </div>
        <div class="stat-card-value">${running ? '运行中' : '已停止'}</div>
        <div class="stat-card-meta">${s.pid ? 'PID: ' + s.pid : ''}${s.port ? ' 端口: ' + s.port : ''}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">访问地址</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm)">${s.url || 'http://localhost:3210'}</div>
        <div class="stat-card-meta">外网: chat.qrj.ai</div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-sm)">
      <a class="btn btn-primary btn-sm" href="${s.url || 'http://localhost:3210'}" target="_blank" rel="noopener">打开 ClawApp</a>
      <a class="btn btn-secondary btn-sm" href="https://chat.qrj.ai" target="_blank" rel="noopener">打开外网地址</a>
      <button class="btn btn-secondary btn-sm" data-action="clawapp-refresh">刷新</button>
    </div>
  `
}

// ===== 事件绑定 =====

function bindEvents(page) {
  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action

    switch (action) {
      case 'cftunnel-up':
        await handleCftunnelAction(page, 'up')
        break
      case 'cftunnel-down':
        await handleCftunnelAction(page, 'down')
        break
      case 'cftunnel-logs':
        await handleCftunnelLogs(page)
        break
      case 'cftunnel-refresh':
        await loadCftunnel(page)
        break
      case 'clawapp-refresh':
        await loadClawapp(page)
        break
      case 'install-cftunnel':
        await handleInstallCftunnel(page)
        break
    }
  })
}

async function handleCftunnelAction(page, action) {
  const label = action === 'up' ? '启动' : '停止'
  try {
    toast(`正在${label}隧道...`, 'info')
    await api.cftunnelAction(action)
    toast(`隧道已${label}`, 'success')
    await loadCftunnel(page)
  } catch (e) {
    toast(`${label}失败: ${e}`, 'error')
  }
}

async function handleCftunnelLogs(page) {
  const area = page.querySelector('#cftunnel-logs-area')
  if (!area) return
  // 切换显示
  if (area.innerHTML) {
    area.innerHTML = ''
    return
  }
  try {
    const logs = await api.getCftunnelLogs(30)
    area.innerHTML = `
      <div style="margin-top:var(--space-md)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)">
          <span style="font-weight:600;font-size:var(--font-size-sm)">最近日志</span>
          <button class="btn btn-secondary btn-sm" data-action="cftunnel-logs">收起</button>
        </div>
        <pre class="log-viewer">${escapeHtml(logs) || '暂无日志'}</pre>
      </div>
    `
  } catch (e) {
    area.innerHTML = `<div style="color:var(--error);margin-top:var(--space-sm)">读取日志失败: ${e}</div>`
  }
}

async function handleInstallCftunnel(page) {
  const area = page.querySelector('#install-progress-area')
  if (!area) return

  // 显示进度条
  area.innerHTML = `
    <div style="margin-top:var(--space-lg)">
      <div class="upgrade-progress-wrap">
        <div class="upgrade-progress-bar">
          <div class="upgrade-progress-fill" id="install-progress-fill" style="width:0%"></div>
        </div>
        <div class="upgrade-progress-text" id="install-progress-text">准备安装...</div>
      </div>
      <div class="upgrade-log-box" id="install-log-box"></div>
    </div>
  `

  const progressFill = area.querySelector('#install-progress-fill')
  const progressText = area.querySelector('#install-progress-text')
  const logBox = area.querySelector('#install-log-box')

  let unlistenLog, unlistenProgress
  try {
    const { listen } = await import('@tauri-apps/api/event')

    unlistenLog = await listen('install-log', (e) => {
      logBox.textContent += e.payload + '\n'
      logBox.scrollTop = logBox.scrollHeight
    })

    unlistenProgress = await listen('install-progress', (e) => {
      const progress = e.payload
      progressFill.style.width = progress + '%'
      progressText.textContent = `安装中... ${progress}%`
    })

    await api.installCftunnel()

    progressFill.classList.add('done')
    progressText.textContent = '✅ 安装完成'
    toast('cftunnel 安装成功', 'success')

    // 3 秒后刷新状态
    setTimeout(() => loadCftunnel(page), 3000)
  } catch (e) {
    progressFill.classList.add('error')
    progressText.textContent = '❌ 安装失败'
    logBox.textContent += '\n错误: ' + e
    toast('安装失败: ' + e, 'error')
  } finally {
    unlistenLog?.()
    unlistenProgress?.()
  }
}
