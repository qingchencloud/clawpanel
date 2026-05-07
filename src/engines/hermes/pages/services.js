/**
 * Hermes Agent 服务管理
 */
import { api, invalidate, isTauriRuntime } from '../../../lib/tauri-api.js'
import { t } from '../../../lib/i18n.js'
import { showConfirm, showUpgradeModal } from '../../../components/modal.js'

const ICONS = {
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
  start: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.13-3.36L23 10"/><path d="M20.49 15A9 9 0 016.36 18.36L1 14"/></svg>',
  package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="7.5 4.21 12 6.81 16.5 4.21"/><polyline points="7.5 19.79 7.5 14.6 3 12"/><polyline points="21 12 16.5 14.6 16.5 19.79"/><polyline points="12 22.08 12 16.8 21 12"/><polyline points="12 16.8 3 12"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/><circle cx="17" cy="17" r="2"/><circle cx="8" cy="7" r="2"/><circle cx="14" cy="12" r="2"/></svg>',
  health: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="15" height="15"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripError(error) {
  return String(error?.message || error || '').replace(/^Error:\s*/, '')
}

function maskSecret(value) {
  const raw = String(value || '').trim()
  if (!raw) return t('engine.servicesNotSet')
  if (raw.length <= 8) return '••••••••'
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`
}

function isLocalGatewayUrl(url, port) {
  if (!url) return true
  try {
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) return false
    if (!parsed.port) return true
    return Number(parsed.port) === Number(port || 8642)
  } catch (_) {
    return false
  }
}

function summarizeHealth(value, limit = 8) {
  const rows = []
  function visit(prefix, current, depth) {
    if (rows.length >= limit || depth > 1 || current == null) return
    if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
      rows.push({
        key: prefix || 'status',
        value: typeof current === 'boolean' ? (current ? 'true' : 'false') : String(current),
      })
      return
    }
    if (Array.isArray(current)) {
      if (current.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
        rows.push({ key: prefix || 'items', value: current.join(', ') })
      }
      return
    }
    if (typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        visit(prefix ? `${prefix}.${key}` : key, item, depth + 1)
        if (rows.length >= limit) break
      }
    }
  }
  visit('', value, 0)
  return rows
}

function renderKpi(label, value, foot, tone = '') {
  return `
    <div class="hm-kpi" data-tone="${tone}">
      <div class="hm-kpi-label">${esc(label)}</div>
      <div class="hm-kpi-value">${esc(value)}</div>
      <div class="hm-kpi-foot">${esc(foot)}</div>
    </div>
  `
}

function renderInfoRow(label, value, mono = false) {
  return `
    <div class="hm-services-row">
      <div class="hm-services-row-label">${esc(label)}</div>
      <div class="hm-services-row-value ${mono ? 'is-mono' : ''}">${esc(value)}</div>
    </div>
  `
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page hm-services-page'
  el.dataset.engine = 'hermes'

  let info = null
  let config = null
  let health = null
  let envData = null
  let loading = true
  let refreshBusy = false
  let actionBusy = false
  let targetBusy = false
  let envBusy = false
  let maintenanceBusy = false
  let pageMsg = ''
  let pageMsgTone = 'muted'
  let connectMsg = ''
  let connectMsgTone = 'muted'
  let targetMode = 'local'
  let customUrl = ''

  function syncCustomInput() {
    const input = el.querySelector('#hm-services-custom-url')
    if (input) customUrl = input.value
  }

  function syncTargetFromInfo() {
    const port = info?.gatewayPort || 8642
    const currentUrl = info?.gatewayUrl || `http://127.0.0.1:${port}`
    if (isLocalGatewayUrl(currentUrl, port)) {
      targetMode = 'local'
      customUrl = ''
      return
    }
    if (envData?.wsl2?.gatewayUrl && currentUrl === envData.wsl2.gatewayUrl) {
      targetMode = 'wsl2'
      customUrl = currentUrl
      return
    }
    targetMode = 'custom'
    customUrl = currentUrl
  }

  function setPageMessage(message, tone = 'muted') {
    pageMsg = message
    pageMsgTone = tone
  }

  function setConnectMessage(message, tone = 'muted') {
    connectMsg = message
    connectMsgTone = tone
  }

  function draw() {
    if (loading) {
      el.innerHTML = `
        <div class="hm-hero">
          <div class="hm-hero-title">
            <div class="hm-hero-eyebrow"><span class="hm-dot hm-dot--idle"></span>${esc(t('engine.servicesEyebrow'))}</div>
            <div class="hm-skel" style="width:260px;height:28px;margin-bottom:8px"></div>
            <div class="hm-skel" style="width:220px;height:14px"></div>
          </div>
        </div>
        <div class="hm-kpi-grid">
          ${[1, 2, 3, 4].map(() => `
            <div class="hm-kpi">
              <div class="hm-skel" style="width:60%;height:10px;margin-bottom:10px"></div>
              <div class="hm-skel" style="width:45%;height:22px;margin-bottom:8px"></div>
              <div class="hm-skel" style="width:55%;height:10px"></div>
            </div>
          `).join('')}
        </div>
      `
      return
    }

    const gwRunning = !!info?.gatewayRunning
    const port = info?.gatewayPort || 8642
    const version = info?.version || '—'
    const gatewayUrl = info?.gatewayUrl || `http://127.0.0.1:${port}`
    const model = config?.model || info?.model || health?.model || t('engine.dashNoModel')
    const provider = config?.provider || t('engine.servicesUnknown')
    const installType = info?.managed || (info?.installed ? 'uv-tool' : t('engine.servicesUnknown'))
    const installState = info?.installed ? t('engine.servicesInstalled') : t('engine.servicesMissing')
    const llmBaseUrl = config?.base_url || t('engine.servicesNotSet')
    const configModel = config?.model_raw || config?.model || info?.model || t('engine.dashNoModel')
    const targetLabel = targetMode === 'local'
      ? t('engine.installModeLocal')
      : targetMode === 'custom'
        ? t('engine.installModeCustom')
        : targetMode === 'wsl2'
          ? 'WSL2'
          : 'Docker'
    const healthRows = summarizeHealth(health)
    const configExists = !!(config?.config_exists || info?.configExists)
    const envExists = !!info?.envExists
    const customInputVisible = targetMode === 'custom' || targetMode === 'docker'
    const targetNote = targetMode === 'local'
      ? `${t('engine.installModeLocal')} · http://127.0.0.1:${port}`
      : targetMode === 'wsl2'
        ? (envData?.wsl2?.gatewayUrl || t('engine.servicesWslHint'))
        : targetMode === 'docker'
          ? t('engine.servicesDockerHint')
          : t('engine.installCustomDesc')

    el.innerHTML = `
      <div class="hm-hero" data-state="${gwRunning ? 'running' : 'stopped'}">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <span class="hm-dot hm-dot--${gwRunning ? 'run' : 'stop'}"></span>
            ${esc(t('engine.servicesEyebrow'))}
          </div>
          <h1 class="hm-hero-h1">${esc(t('engine.hermesServicesTitle'))}</h1>
          <div class="hm-hero-sub">${esc(gatewayUrl)} · ${esc(model)} · v${esc(version)}</div>
        </div>
        <div class="hm-hero-actions">
          ${info?.installed && !gwRunning ? `<button class="hm-btn hm-btn--cta hm-btn--sm hm-services-start" ${actionBusy ? 'disabled' : ''}>${ICONS.start}<span>${esc(actionBusy ? t('engine.gatewayStarting') : t('engine.gatewayStartBtn'))}</span></button>` : ''}
          ${info?.installed && gwRunning ? `<button class="hm-btn hm-btn--danger hm-btn--sm hm-services-stop" ${actionBusy ? 'disabled' : ''}>${ICONS.stop}<span>${esc(actionBusy ? t('engine.dashStopping') : t('engine.dashStopGw'))}</span></button>` : ''}
          ${info?.installed && gwRunning ? `<button class="hm-btn hm-btn--sm hm-services-restart" ${actionBusy ? 'disabled' : ''}>${ICONS.restart}<span>${esc(actionBusy ? t('engine.dashRestarting') : t('engine.dashRestartGw'))}</span></button>` : ''}
          <button class="hm-btn hm-btn--ghost hm-btn--icon hm-services-refresh" title="${esc(t('engine.logsRefresh'))}" ${refreshBusy ? 'disabled' : ''}>${ICONS.refresh}</button>
        </div>
      </div>

      <div class="hm-services-desc">${esc(t('engine.servicesDesc'))}</div>

      <div class="hm-kpi-grid">
        ${renderKpi(t('engine.servicesInstallState'), installState, `${t('engine.servicesInstallType')} · ${installType}`, info?.installed ? 'success' : 'error')}
        ${renderKpi(t('engine.dashGatewayStatus'), gwRunning ? t('engine.dashRunning') : t('engine.dashStopped'), `:${port}`, gwRunning ? 'success' : 'error')}
        ${renderKpi(t('engine.dashModel'), model, provider, 'accent')}
        ${renderKpi(t('engine.dashConnectTarget'), targetLabel, gatewayUrl, 'info')}
      </div>

      ${pageMsg ? `<div class="hm-services-msg" data-tone="${esc(pageMsgTone)}">${esc(pageMsg)}</div>` : ''}

      <div class="hm-services-grid">
        <section class="hm-panel">
          <div class="hm-panel-header">
            <div class="hm-panel-title">
              <span class="hm-panel-title-icon">${ICONS.package}</span>
              ${esc(t('engine.servicesInstallState'))}
            </div>
          </div>
          <div class="hm-panel-body hm-panel-body--tight">
            <div class="hm-services-rows">
              ${renderInfoRow(t('engine.dashVersion'), `v${version}`)}
              ${renderInfoRow(t('engine.servicesInstallType'), installType)}
              ${renderInfoRow(t('engine.servicesPath'), info?.path || t('engine.servicesNotSet'), true)}
              ${renderInfoRow(t('engine.servicesHome'), info?.hermesHome || t('engine.servicesNotSet'), true)}
            </div>
            <div class="hm-field-label" style="margin:16px 0 10px">${esc(t('engine.servicesConfigFiles'))}</div>
            <div class="hm-pills">
              <span class="hm-pill ${configExists ? 'hm-pill--ok' : 'hm-pill--muted'}">config.yaml</span>
              <span class="hm-pill ${envExists ? 'hm-pill--ok' : 'hm-pill--muted'}">.env</span>
            </div>
          </div>
        </section>

        <section class="hm-panel">
          <div class="hm-panel-header">
            <div class="hm-panel-title">
              <span class="hm-panel-title-icon">${ICONS.config}</span>
              ${esc(t('engine.hermesConfigTitle'))}
            </div>
          </div>
          <div class="hm-panel-body hm-panel-body--tight">
            <div class="hm-services-rows">
              ${renderInfoRow(t('engine.configProvider'), provider)}
              ${renderInfoRow(t('engine.configModel'), configModel)}
              ${renderInfoRow(t('engine.configBaseUrl'), llmBaseUrl, true)}
              ${renderInfoRow(t('engine.configApiKey'), maskSecret(config?.api_key), true)}
            </div>
            <div class="hm-stack" style="margin-top:14px">
              <a class="hm-btn hm-btn--ghost hm-btn--sm" href="#/h/config">${esc(t('engine.servicesOpenConfig'))}</a>
              <a class="hm-btn hm-btn--ghost hm-btn--sm" href="#/h/env">${esc(t('engine.servicesOpenEnv'))}</a>
            </div>
          </div>
        </section>
      </div>

      <section class="hm-panel hm-services-panel" style="margin-top:16px">
        <div class="hm-panel-header">
          <div class="hm-panel-title">
            <span class="hm-panel-title-icon">${ICONS.link}</span>
            ${esc(t('engine.dashConnectTarget'))}
          </div>
          <div class="hm-panel-actions">
            <button class="hm-btn hm-btn--ghost hm-btn--sm hm-services-detect-env" ${envBusy ? 'disabled' : ''}>${esc(envBusy ? t('engine.dashDetecting') : t('engine.dashDetectEnv'))}</button>
          </div>
        </div>
        <div class="hm-panel-body hm-panel-body--tight">
          <div class="hm-pills" style="margin-bottom:12px">
            <button class="hm-pill hm-services-mode ${targetMode === 'local' ? 'is-active' : ''}" data-mode="local">${esc(t('engine.installModeLocal'))}</button>
            ${envData?.wsl2?.available ? `<button class="hm-pill hm-services-mode ${targetMode === 'wsl2' ? 'is-active' : ''}" data-mode="wsl2">WSL2${envData.wsl2.gatewayRunning ? ` · ${esc(t('engine.servicesReadyTag'))}` : ''}</button>` : ''}
            ${envData?.docker?.available ? `<button class="hm-pill hm-services-mode ${targetMode === 'docker' ? 'is-active' : ''}" data-mode="docker">Docker</button>` : ''}
            <button class="hm-pill hm-services-mode ${targetMode === 'custom' ? 'is-active' : ''}" data-mode="custom">${esc(t('engine.installModeCustom'))}</button>
          </div>

          ${customInputVisible ? `
            <label class="hm-field" style="margin-bottom:12px">
              <span class="hm-field-label">${esc(t('engine.servicesCustomUrl'))}</span>
              <input id="hm-services-custom-url" class="hm-input" type="text" value="${esc(customUrl)}" placeholder="http://192.168.1.100:8642">
            </label>
          ` : ''}

          <div class="hm-services-note">${esc(targetNote)}</div>

          ${envData ? `
            <div class="hm-services-env-grid">
              ${envData?.wsl2?.available ? `
                <div class="hm-services-env-card">
                  <div class="hm-services-env-title">WSL2</div>
                  <div class="hm-services-env-meta">${esc((envData.wsl2.distros || []).join(', ') || t('engine.servicesDefaultDistro'))}</div>
                  <div class="hm-services-env-meta">${esc(envData.wsl2.ip || '—')}</div>
                  <div class="hm-services-env-meta">${esc(envData.wsl2.gatewayRunning ? (envData.wsl2.gatewayUrl || '') : t('engine.servicesWslHint'))}</div>
                </div>
              ` : ''}
              ${envData?.docker?.available ? `
                <div class="hm-services-env-card">
                  <div class="hm-services-env-title">Docker</div>
                  <div class="hm-services-env-meta">${esc(envData.docker.version || '—')}</div>
                  <div class="hm-services-env-meta">${esc(t('engine.servicesContainerCount', { n: String(envData.docker.hermesContainers?.length || 0) }))}</div>
                  <div class="hm-services-env-meta">${esc(t('engine.servicesDockerHint'))}</div>
                </div>
              ` : ''}
            </div>
          ` : ''}

          <div class="hm-stack" style="margin-top:14px">
            <button class="hm-btn hm-btn--primary hm-btn--sm hm-services-apply-target" ${targetBusy ? 'disabled' : ''}>${esc(t('engine.dashConnApply'))}</button>
            ${connectMsg ? `<span class="hm-services-inline-msg" data-tone="${esc(connectMsgTone)}">${esc(connectMsg)}</span>` : ''}
          </div>
        </div>
      </section>

      <section class="hm-panel hm-services-panel" style="margin-top:16px">
        <div class="hm-panel-header">
          <div class="hm-panel-title">
            <span class="hm-panel-title-icon">${ICONS.health}</span>
            ${esc(t('engine.servicesHealthTitle'))}
          </div>
          <div class="hm-panel-actions">
            <span class="hm-pill ${gwRunning ? 'hm-pill--ok' : 'hm-pill--muted'}">${esc(gwRunning ? t('engine.dashRunning') : t('engine.dashStopped'))}</span>
          </div>
        </div>
        <div class="hm-panel-body">
          ${healthRows.length ? `
            <div class="hm-services-health-grid">
              ${healthRows.map(row => `
                <div class="hm-services-health-card">
                  <div class="hm-services-health-key">${esc(row.key)}</div>
                  <div class="hm-services-health-value">${esc(row.value)}</div>
                </div>
              `).join('')}
            </div>
            <details class="hm-services-json-wrap">
              <summary>${esc(t('engine.servicesRawJson'))}</summary>
              <pre class="hm-term hm-services-json">${esc(JSON.stringify(health, null, 2))}</pre>
            </details>
          ` : `
            <div class="hm-services-empty">${esc(t('engine.servicesNoHealth'))}</div>
          `}
        </div>
      </section>

      <section class="hm-panel hm-services-panel" style="margin-top:16px">
        <div class="hm-panel-header">
          <div class="hm-panel-title">
            <span class="hm-panel-title-icon">${ICONS.upload}</span>
            ${esc(t('engine.servicesMaintenance'))}
          </div>
        </div>
        <div class="hm-panel-body">
          <div class="hm-services-action-grid">
            <button class="hm-btn hm-btn--primary hm-btn--sm hm-services-upgrade" ${maintenanceBusy || !info?.installed ? 'disabled' : ''}>${ICONS.upload}<span>${esc(t('engine.servicesUpgrade'))}</span></button>
            <button class="hm-btn hm-btn--sm hm-services-install" ${maintenanceBusy ? 'disabled' : ''}>${ICONS.package}<span>${esc(info?.installed ? t('engine.servicesRepairInstall') : t('engine.servicesInstall'))}</span></button>
            <button class="hm-btn hm-btn--sm hm-services-uninstall" ${maintenanceBusy || !info?.installed ? 'disabled' : ''}>${ICONS.trash}<span>${esc(t('engine.servicesUninstall'))}</span></button>
            <button class="hm-btn hm-btn--danger hm-btn--sm hm-services-uninstall-clean" ${maintenanceBusy || !info?.installed ? 'disabled' : ''}>${ICONS.trash}<span>${esc(t('engine.servicesUninstallClean'))}</span></button>
          </div>
          <div class="hm-stack" style="margin-top:14px">
            <a class="hm-btn hm-btn--ghost hm-btn--sm" href="#/h/logs">${esc(t('engine.servicesOpenLogs'))}</a>
            <a class="hm-btn hm-btn--ghost hm-btn--sm" href="#/h/config">${esc(t('engine.servicesOpenConfig'))}</a>
            <a class="hm-btn hm-btn--ghost hm-btn--sm" href="#/h/setup">${esc(t('engine.servicesOpenSetup'))}</a>
          </div>
        </div>
      </section>
    `

    bind()
  }

  async function refresh(withSpinner = true) {
    if (withSpinner) {
      refreshBusy = true
      if (!loading) draw()
    }
    invalidate('check_hermes')
    try {
      info = await api.checkHermes()
      if (info?.gatewayRunning) {
        try {
          health = await api.hermesHealthCheck()
        } catch (error) {
          health = null
          setPageMessage(stripError(error), 'warn')
        }
      } else {
        health = null
      }
      try {
        config = await api.hermesReadConfig()
      } catch (_) {
        config = null
      }
      syncTargetFromInfo()
    } catch (error) {
      setPageMessage(stripError(error), 'error')
    } finally {
      loading = false
      refreshBusy = false
      draw()
    }
  }

  async function runGatewayAction(action) {
    if (actionBusy) return
    actionBusy = true
    setPageMessage(
      action === 'start'
        ? t('engine.gatewayStarting')
        : action === 'restart'
          ? t('engine.dashRestarting')
          : t('engine.dashStopping'),
      'muted'
    )
    draw()
    try {
      if (action === 'restart') {
        try { await api.hermesGatewayAction('stop') } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 1200))
        const result = await api.hermesGatewayAction('start')
        setPageMessage(result || t('engine.dashRestartGw'), 'success')
      } else {
        const result = await api.hermesGatewayAction(action)
        setPageMessage(result || action, 'success')
      }
    } catch (error) {
      setPageMessage(stripError(error), 'error')
    }
    actionBusy = false
    await refresh(false)
  }

  async function detectEnvironments() {
    if (envBusy) return
    envBusy = true
    draw()
    try {
      envData = await api.hermesDetectEnvironments()
      if (info) syncTargetFromInfo()
      setConnectMessage('', 'muted')
    } catch (error) {
      setConnectMessage(stripError(error), 'error')
    }
    envBusy = false
    draw()
  }

  async function applyTarget() {
    if (targetBusy) return
    syncCustomInput()

    let targetUrl = null
    if (targetMode === 'wsl2') {
      targetUrl = envData?.wsl2?.gatewayUrl || null
      if (!targetUrl) {
        setConnectMessage(t('engine.servicesDetectFirst'), 'warn')
        draw()
        return
      }
    } else if (targetMode === 'docker') {
      targetUrl = customUrl.trim() || null
      if (!targetUrl) {
        setConnectMessage(t('engine.servicesDockerHint'), 'warn')
        draw()
        return
      }
    } else if (targetMode === 'custom') {
      targetUrl = customUrl.trim() || null
      if (!targetUrl) {
        setConnectMessage(t('engine.installCustomEmpty'), 'warn')
        draw()
        return
      }
    }

    targetBusy = true
    draw()
    try {
      const result = await api.hermesSetGatewayUrl(targetUrl)
      setConnectMessage(result, 'success')
      setPageMessage(result, 'success')
    } catch (error) {
      setConnectMessage(stripError(error), 'error')
    }
    targetBusy = false
    await refresh(false)
  }

  async function runMaintenance(kind) {
    if (maintenanceBusy) return

    const confirmText = kind === 'install'
      ? (info?.installed ? t('engine.servicesConfirmRepairInstall') : t('engine.servicesConfirmInstall'))
      : kind === 'upgrade'
        ? t('engine.servicesConfirmUpgrade')
        : kind === 'uninstall-clean'
          ? t('engine.servicesConfirmUninstallClean')
          : t('engine.servicesConfirmUninstall')
    const confirmed = await showConfirm(confirmText, {
      title: t('engine.servicesMaintenance'),
      confirmText: kind.includes('uninstall') ? t('engine.servicesUninstall') : t('common.confirm'),
      variant: kind.includes('uninstall') ? 'danger' : 'primary',
    })
    if (!confirmed) return

    maintenanceBusy = true
    setPageMessage(
      kind === 'install'
        ? t('engine.servicesInstall')
        : kind === 'upgrade'
          ? t('engine.servicesUpgrade')
          : t('engine.servicesUninstall'),
      'muted'
    )
    draw()

    const modalTitle = kind === 'install'
      ? (info?.installed ? t('engine.servicesRepairInstall') : t('engine.servicesInstall'))
      : kind === 'upgrade'
        ? t('engine.servicesUpgrade')
        : kind === 'uninstall-clean'
          ? t('engine.servicesUninstallClean')
          : t('engine.servicesUninstall')
    const modal = showUpgradeModal(`${modalTitle} Hermes Agent`)
    modal.setProgressLabels({
      preparing: t('common.preparing'),
      downloading: kind === 'install' ? t('engine.installingBtn') : kind === 'upgrade' ? t('about.upgrading') : t('about.uninstalling'),
      installing: kind === 'install' ? t('engine.installingBtn') : kind === 'upgrade' ? t('about.upgrading') : t('about.uninstalling'),
      done: kind === 'install' ? t('engine.installSuccess') : kind === 'upgrade' ? t('engine.servicesUpgradeDone') : t('engine.servicesUninstallDone'),
    })
    modal.setProgress(5)
    modal.appendLog(`${modalTitle} Hermes Agent`)

    let unlisten = null
    try {
      if (isTauriRuntime()) {
        const { listen } = await import('@tauri-apps/api/event')
        const u1 = await listen('hermes-install-log', (event) => modal.appendLog(String(event.payload)))
        const u2 = await listen('hermes-install-progress', (event) => modal.setProgress(Number(event.payload) || 0))
        unlisten = () => { u1(); u2() }
      }
    } catch (_) {}

    const shouldStopGateway = !!info?.gatewayRunning && (kind === 'install' || kind === 'upgrade' || kind.includes('uninstall'))
    let shouldRestartGateway = !!info?.gatewayRunning && (kind === 'install' || kind === 'upgrade')

    try {
      if (shouldStopGateway) {
        modal.appendLog(t('engine.servicesMaintenanceStopGateway'))
        modal.setProgress(12)
        try {
          await api.hermesGatewayAction('stop')
          await new Promise(resolve => setTimeout(resolve, 900))
          modal.appendLog(t('engine.servicesMaintenanceGatewayStopped'))
        } catch (error) {
          modal.appendLog(t('engine.servicesMaintenanceGatewayStopWarn', { error: stripError(error) }))
        }
      }

      modal.setProgress(25)
      const result = kind === 'install'
        ? await api.installHermes('uv-tool', ['web'])
        : kind === 'upgrade'
          ? await api.updateHermes()
          : await api.uninstallHermes(kind === 'uninstall-clean')
      modal.appendLog(`✅ ${result || modalTitle}`)
      modal.setProgress(85)

      if (shouldRestartGateway) {
        modal.appendLog(t('engine.servicesMaintenanceRestartGateway'))
        try {
          await api.hermesGatewayAction('start')
          modal.appendLog(t('engine.servicesMaintenanceGatewayRestarted'))
        } catch (error) {
          shouldRestartGateway = false
          modal.appendLog(t('engine.servicesMaintenanceGatewayRestartWarn', { error: stripError(error) }))
        }
      }

      modal.setProgress(100)
      modal.setDone(kind === 'install' ? t('engine.installSuccess') : kind === 'upgrade' ? t('engine.servicesUpgradeDone') : t('engine.servicesUninstallDone'))
      setPageMessage(result, 'success')
      invalidate('check_hermes')
      await refresh(false)
      if (kind !== 'upgrade' && !info?.installed) {
        window.location.hash = '#/h/setup'
      }
    } catch (error) {
      const message = stripError(error)
      modal.appendLog(`❌ ${message}`)
      modal.setError(message)
      setPageMessage(message, 'error')
    } finally {
      if (unlisten) unlisten()
      modal.onClose(() => refresh(false))
    }
    maintenanceBusy = false
    draw()
  }

  function bind() {
    el.querySelector('.hm-services-refresh')?.addEventListener('click', () => refresh())
    el.querySelector('.hm-services-start')?.addEventListener('click', () => runGatewayAction('start'))
    el.querySelector('.hm-services-stop')?.addEventListener('click', () => runGatewayAction('stop'))
    el.querySelector('.hm-services-restart')?.addEventListener('click', () => runGatewayAction('restart'))
    el.querySelector('.hm-services-detect-env')?.addEventListener('click', detectEnvironments)
    el.querySelector('.hm-services-apply-target')?.addEventListener('click', applyTarget)
    el.querySelectorAll('.hm-services-mode').forEach(button => {
      button.addEventListener('click', () => {
        syncCustomInput()
        targetMode = button.dataset.mode
        if (targetMode === 'wsl2' && envData?.wsl2?.gatewayUrl) customUrl = envData.wsl2.gatewayUrl
        if (targetMode === 'local') customUrl = ''
        draw()
      })
    })
    el.querySelector('#hm-services-custom-url')?.addEventListener('input', (event) => {
      customUrl = event.target.value
    })
    el.querySelector('.hm-services-install')?.addEventListener('click', () => runMaintenance('install'))
    el.querySelector('.hm-services-upgrade')?.addEventListener('click', () => runMaintenance('upgrade'))
    el.querySelector('.hm-services-uninstall')?.addEventListener('click', () => runMaintenance('uninstall'))
    el.querySelector('.hm-services-uninstall-clean')?.addEventListener('click', () => runMaintenance('uninstall-clean'))
  }

  draw()
  refresh()
  return el
}
