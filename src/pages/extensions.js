/**
 * 扩展工具页面
 * cftunnel 隧道管理 + ClawApp 状态
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { statusIcon } from '../lib/icons.js'
import { t } from '../lib/i18n.js'

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
      <h1 class="page-title">${t('ext.title')}</h1>
      <p class="page-desc">${t('ext.desc')}</p>
    </div>
    <div id="cftunnel-card" class="config-section">
      <div class="config-section-title">${t('ext.cftunnelTitle')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">${t('ext.cftunnelDesc')}</div>
      <div id="cftunnel-content"><div class="stat-card loading-placeholder" style="height:64px"></div></div>
    </div>
    <div id="clawapp-card" class="config-section">
      <div class="config-section-title">${t('ext.clawappTitle')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">${t('ext.clawappDesc')}</div>
      <div id="clawapp-content"><div class="stat-card loading-placeholder" style="height:64px"></div></div>
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
  try {
    const status = await api.getCftunnelStatus()
    renderCftunnel(el, status)
  } catch (e) {
    el.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${e}</div>`
  }
}

function renderCftunnel(el, s) {
  if (!s.installed) {
    el.innerHTML = `
      <div style="color:var(--text-tertiary);margin-bottom:var(--space-md)">${t('ext.cftunnelNotInstalled')}</div>
      <div style="display:flex;gap:var(--space-sm);align-items:center">
        <button class="btn btn-primary btn-sm" data-action="install-cftunnel">${t('ext.installBtn')}</button>
        <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/cftunnel" target="_blank" rel="noopener">${t('ext.viewDocs')}</a>
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
          <span class="stat-card-label">${t('ext.status')}</span>
          <span class="status-dot ${running ? 'running' : 'stopped'}"></span>
        </div>
        <div class="stat-card-value">${running ? t('ext.running') : t('ext.stopped')}</div>
        <div class="stat-card-meta">${s.tunnel_name || ''}${s.pid ? ' (PID: ' + s.pid + ')' : ''}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">${t('ext.version')}</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-md)">${s.version || t('ext.unknown')}</div>
        <div class="stat-card-meta">${routes.length} ${t('ext.routes')}</div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-md)">
      ${running
        ? '<button class="btn btn-danger btn-sm" data-action="cftunnel-down">' + t('ext.stopTunnel') + '</button>'
        : '<button class="btn btn-primary btn-sm" data-action="cftunnel-up">' + t('ext.startTunnel') + '</button>'
      }
      <button class="btn btn-secondary btn-sm" data-action="cftunnel-logs">${t('ext.viewLogs')}</button>
      <button class="btn btn-secondary btn-sm" data-action="cftunnel-refresh">${t('ext.refresh')}</button>
    </div>
    ${renderRoutes(routes)}
    <div id="cftunnel-logs-area"></div>
  `
}

function renderRoutes(routes) {
  if (!routes.length) return '<div style="color:var(--text-tertiary);padding:var(--space-md) 0">' + t('ext.noRoutes') + '</div>'
  return `
    <div class="tunnel-routes">
      ${routes.map(r => `
        <div class="tunnel-route-card">
          <div class="tunnel-route-header">
            <span class="tunnel-route-name">${escapeHtml(r.name)}</span>
            <span class="tunnel-route-badge">
              <span class="status-dot running" style="width:6px;height:6px"></span>
              ${t('ext.active')}
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
            <span>${t('ext.localService')}:</span>
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
  try {
    const status = await api.getClawappStatus()
    renderClawapp(el, status)
  } catch (e) {
    el.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${e}</div>`
  }
}

function renderClawapp(el, s) {
  if (!s.installed) {
    el.innerHTML = `
      <div style="color:var(--text-tertiary);margin-bottom:var(--space-md)">${t('ext.clawappNotInstalled')}</div>
      <div style="display:flex;gap:var(--space-sm);align-items:center">
        <button class="btn btn-primary btn-sm" data-action="install-clawapp">${t('ext.installBtn')}</button>
        <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawapp" target="_blank" rel="noopener">${t('ext.viewDocs')}</a>
      </div>
      <div id="install-clawapp-progress-area"></div>
    `
    return
  }

  const running = s.running
  el.innerHTML = `
    <div class="stat-cards" style="margin-bottom:var(--space-md)">
      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-label">${t('ext.status')}</span>
          <span class="status-dot ${running ? 'running' : 'stopped'}"></span>
        </div>
        <div class="stat-card-value">${running ? t('ext.running') : t('ext.stopped')}</div>
        <div class="stat-card-meta">${s.pid ? 'PID: ' + s.pid : ''}${s.port ? ' ' + t('ext.port') + ': ' + s.port : ''}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">${t('ext.accessUrl')}</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm)">${s.url || 'http://localhost:3210'}</div>
        <div class="stat-card-meta">${t('ext.publicUrl')}: chat.qrj.ai</div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-sm)">
      <a class="btn btn-primary btn-sm" href="${s.url || 'http://localhost:3210'}" target="_blank" rel="noopener">${t('ext.openClawapp')}</a>
      <a class="btn btn-secondary btn-sm" href="https://chat.qrj.ai" target="_blank" rel="noopener">${t('ext.openPublicUrl')}</a>
      <button class="btn btn-secondary btn-sm" data-action="clawapp-refresh">${t('ext.refresh')}</button>
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
      case 'install-clawapp':
        await handleInstallClawapp(page)
        break
    }
  })
}

async function handleCftunnelAction(page, action) {
  const label = action === 'up' ? t('ext.start') : t('ext.stop')
  const btn = page.querySelector(`[data-action="cftunnel-${action === 'up' ? 'up' : 'down'}"]`)
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; btn.textContent = `${label}...` }
  try {
    await api.cftunnelAction(action)
    toast(t('ext.tunnelActionDone', { action: label }), 'success')
    await loadCftunnel(page)
  } catch (e) {
    toast(humanizeError(e, t('ext.tunnelActionFail', { action: label })), 'error')
    if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; btn.textContent = label }
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
          <span style="font-weight:600;font-size:var(--font-size-sm)">${t('ext.recentLogs')}</span>
          <button class="btn btn-secondary btn-sm" data-action="cftunnel-logs">${t('ext.collapse')}</button>
        </div>
        <pre class="log-viewer">${escapeHtml(logs) || t('ext.noLogs')}</pre>
      </div>
    `
  } catch (e) {
    area.innerHTML = `<div style="color:var(--error);margin-top:var(--space-sm)">${t('ext.readLogsFailed')}: ${e}</div>`
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
        <div class="upgrade-progress-text" id="install-progress-text">${t('ext.preparing')}</div>
      </div>
      <div class="upgrade-log-box" id="install-log-box"></div>
    </div>
  `

  const progressFill = area.querySelector('#install-progress-fill')
  const progressText = area.querySelector('#install-progress-text')
  const logBox = area.querySelector('#install-log-box')

  let unlistenLog, unlistenProgress
  try {
    if (window.__TAURI_INTERNALS__) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlistenLog = await listen('install-log', (e) => {
          logBox.textContent += e.payload + '\n'
          logBox.scrollTop = logBox.scrollHeight
        })
        unlistenProgress = await listen('install-progress', (e) => {
          const progress = e.payload
          progressFill.style.width = progress + '%'
          progressText.textContent = t('ext.installing') + ` ${progress}%`
        })
      } catch { /* Web mode no Tauri event */ }
    } else {
      logBox.textContent += t('ext.webModeNoLogs') + '\n'
    }

    await api.installCftunnel()

    progressFill.classList.add('done')
    progressText.innerHTML = `${statusIcon('ok', 14)} ${t('ext.installDone')}`
    toast(t('ext.installSuccess', { name: 'cftunnel' }), 'success')

    // 3 秒后刷新状态
    setTimeout(() => loadCftunnel(page), 3000)
  } catch (e) {
    progressFill.classList.add('error')
    progressText.innerHTML = `${statusIcon('err', 14)} ${t('ext.installFailed')}`
    logBox.textContent += '\n' + t('ext.error') + ': ' + e
    toast(humanizeError(e, t('ext.installFailed')), 'error')
    if (window.__openAIDrawerWithError) {
      window.__openAIDrawerWithError({
        title: t('ext.installFailedTitle', { name: 'cftunnel' }),
        error: logBox.textContent,
        scene: t('ext.installScene', { name: 'cftunnel' }),
        hint: String(e),
      })
    }
  } finally {
    unlistenLog?.()
    unlistenProgress?.()
  }
}

async function handleInstallClawapp(page) {
  const area = page.querySelector('#install-clawapp-progress-area')
  if (!area) return

  area.innerHTML = `
    <div style="margin-top:var(--space-lg)">
      <div class="upgrade-progress-wrap">
        <div class="upgrade-progress-bar">
          <div class="upgrade-progress-fill" id="install-clawapp-progress-fill" style="width:0%"></div>
        </div>
        <div class="upgrade-progress-text" id="install-clawapp-progress-text">${t('ext.preparing')}</div>
      </div>
      <div class="upgrade-log-box" id="install-clawapp-log-box"></div>
    </div>
  `

  const progressFill = area.querySelector('#install-clawapp-progress-fill')
  const progressText = area.querySelector('#install-clawapp-progress-text')
  const logBox = area.querySelector('#install-clawapp-log-box')

  let unlistenLog, unlistenProgress
  try {
    if (window.__TAURI_INTERNALS__) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlistenLog = await listen('install-log', (e) => {
          logBox.textContent += e.payload + '\n'
          logBox.scrollTop = logBox.scrollHeight
        })
        unlistenProgress = await listen('install-progress', (e) => {
          const progress = e.payload
          progressFill.style.width = progress + '%'
          progressText.textContent = t('ext.installing') + ` ${progress}%`
        })
      } catch { /* Web mode no Tauri event */ }
    } else {
      logBox.textContent += t('ext.webModeNoLogs') + '\n'
    }

    await api.installClawapp()

    progressFill.classList.add('done')
    progressText.innerHTML = `${statusIcon('ok', 14)} ${t('ext.installDone')}`
    toast(t('ext.installSuccess', { name: 'ClawApp' }), 'success')

    setTimeout(() => loadClawapp(page), 3000)
  } catch (e) {
    progressFill.classList.add('error')
    progressText.innerHTML = `${statusIcon('err', 14)} ${t('ext.installFailed')}`
    logBox.textContent += '\n' + t('ext.error') + ': ' + e
    toast(humanizeError(e, t('ext.installFailed')), 'error')
    if (window.__openAIDrawerWithError) {
      window.__openAIDrawerWithError({
        title: t('ext.installFailedTitle', { name: 'ClawApp' }),
        error: logBox.textContent,
        scene: t('ext.installScene', { name: 'ClawApp' }),
        hint: String(e),
      })
    }
  } finally {
    unlistenLog?.()
    unlistenProgress?.()
  }
}
