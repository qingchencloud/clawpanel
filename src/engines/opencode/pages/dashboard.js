import { api } from '../../../lib/tauri-api.js'
import { getOpenCodePort, setOpenCodePort } from '../../../lib/model-channels.js'
import { t } from '../../../lib/i18n.js'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function metric(label, value, tone = '') {
  return `<div class="oc-metric" data-tone="${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
}

function detail(label, value) {
  return `<div class="oc-detail"><span>${esc(label)}</span><code title="${esc(value)}">${esc(value || '—')}</code></div>`
}

export function render() {
  const page = document.createElement('div')
  page.className = 'page oc-page'
  page.dataset.engine = 'opencode'

  const state = {
    loading: true,
    busy: '',
    status: null,
    updateInfo: null,
    updateChecked: false,
    error: '',
    port: getOpenCodePort(),
  }

  function draw() {
    const status = state.status || {}
    const updateInfo = state.updateInfo || {}
    const summary = status.summary || {}
    const providerNames = Array.isArray(summary.configuredProviders) ? summary.configuredProviders : []
    page.innerHTML = `
      <style>
        .oc-page{--oc:#4f7cff;display:grid;gap:18px;max-width:1480px;margin:0 auto}
        .oc-hero{padding:24px;border:1px solid var(--border-primary);border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--oc) 13%,var(--bg-primary)),var(--bg-primary) 58%);display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}
        .oc-eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--oc);font-weight:700}.oc-hero h1{margin:7px 0 8px;font-size:28px;color:var(--text-primary)}.oc-hero p{margin:0;max-width:720px;color:var(--text-secondary);line-height:1.7}
        .oc-actions{display:flex;gap:8px;flex-wrap:wrap}.oc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.oc-metric{padding:16px;border:1px solid var(--border-primary);border-radius:12px;background:var(--bg-primary);display:grid;gap:9px}.oc-metric span{font-size:12px;color:var(--text-tertiary)}.oc-metric strong{font-size:20px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis}.oc-metric[data-tone=ok] strong{color:var(--success)}.oc-metric[data-tone=warn] strong{color:var(--warning)}
        .oc-panels{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.oc-panel{border:1px solid var(--border-primary);border-radius:14px;background:var(--bg-primary);padding:18px}.oc-panel h2{font-size:15px;margin:0 0 14px;color:var(--text-primary)}.oc-details{display:grid;gap:10px}.oc-detail{display:grid;grid-template-columns:128px minmax(0,1fr);gap:12px;align-items:center}.oc-detail span{font-size:12px;color:var(--text-tertiary)}.oc-detail code{font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg-secondary);border-radius:7px;padding:8px}
        .oc-port{display:flex;gap:8px;align-items:center;margin:0 0 14px}.oc-port input{max-width:150px}.oc-note{padding:13px 14px;border-radius:10px;background:color-mix(in srgb,var(--oc) 8%,var(--bg-secondary));border:1px solid color-mix(in srgb,var(--oc) 24%,var(--border-primary));color:var(--text-secondary);font-size:12px;line-height:1.65}.oc-note strong{display:block;color:var(--text-primary);margin-bottom:3px}.oc-error{padding:12px 14px;border:1px solid color-mix(in srgb,var(--error) 40%,var(--border-primary));border-radius:10px;color:var(--error);background:color-mix(in srgb,var(--error) 7%,var(--bg-primary));white-space:pre-wrap;word-break:break-word}.oc-provider-list{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.oc-chip{border:1px solid var(--border-primary);border-radius:999px;padding:4px 9px;font-size:11px;color:var(--text-secondary);background:var(--bg-secondary)}
        @media(max-width:900px){.oc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.oc-panels{grid-template-columns:1fr}}@media(max-width:560px){.oc-grid{grid-template-columns:1fr}.oc-detail{grid-template-columns:1fr}.oc-hero{padding:18px}}
      </style>
      <section class="oc-hero">
        <div>
          <div class="oc-eyebrow">OpenCode · Coding Agent</div>
          <h1>${esc(t('openCode.title'))}</h1>
          <p>${esc(t('openCode.desc'))}</p>
        </div>
        <div class="oc-actions">
          <button class="btn btn-secondary btn-sm" data-action="refresh" ${state.busy ? 'disabled' : ''}>${esc(t('openCode.refresh'))}</button>
          ${!status.installed ? `<button class="btn btn-primary btn-sm" data-action="install" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'install' ? t('openCode.installing') : t('openCode.install'))}</button>` : ''}
          ${status.managedInstalled ? `<button class="btn btn-secondary btn-sm" data-action="check-update" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'check-update' ? t('openCode.checkingUpdate') : t('openCode.checkUpdate'))}</button>` : ''}
          ${status.managedInstalled && updateInfo.updateAvailable ? `<button class="btn btn-primary btn-sm" data-action="update" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'update' ? t('openCode.updating') : t('openCode.updateNow'))}</button>` : ''}
          ${status.installed && !status.running ? `<button class="btn btn-primary btn-sm" data-action="start" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'start' ? t('openCode.starting') : t('openCode.start'))}</button>` : ''}
          ${status.running && status.managed ? `<button class="btn btn-danger btn-sm" data-action="stop" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'stop' ? t('openCode.stopping') : t('openCode.stop'))}</button>` : ''}
          ${status.managedInstalled ? `<button class="btn btn-secondary btn-sm" data-action="uninstall" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'uninstall' ? t('openCode.uninstalling') : t('openCode.uninstall'))}</button>` : ''}
          ${status.running && status.managed ? `<a class="btn btn-primary btn-sm" href="#/opencode/workspace">${esc(t('openCode.openWorkspace'))}</a>` : ''}
          <a class="btn btn-secondary btn-sm" href="#/model-channels">${esc(t('openCode.modelChannels'))}</a>
        </div>
      </section>

      ${state.error ? `<div class="oc-error">${esc(state.error)}</div>` : ''}
      ${status.foreignPort ? `<div class="oc-error">${esc(t('openCode.foreignPort'))}</div>` : ''}

      <section class="oc-grid">
        ${metric(t('openCode.status'), status.running ? t('openCode.running') : t('openCode.stopped'), status.running ? 'ok' : 'warn')}
        ${metric(t('openCode.packageVersion'), status.version || status.targetVersion || '—', updateInfo.updateAvailable ? 'warn' : '')}
        ${metric(t('openCode.providerCount'), summary.configuredProviders?.length ?? 0)}
        ${metric(t('openCode.modelCount'), summary.modelCount ?? 0)}
      </section>

      <section class="oc-panels">
        <div class="oc-panel">
          <h2>${esc(t('openCode.status'))}</h2>
          <div class="oc-port">
            <input class="form-input" id="oc-port" type="number" min="1024" max="65535" value="${esc(state.port)}">
            <button class="btn btn-secondary btn-sm" data-action="port" ${state.busy ? 'disabled' : ''}>${esc(t('openCode.applyPort'))}</button>
          </div>
          <div class="form-hint" style="margin:-7px 0 14px">${esc(t('openCode.portHint'))}</div>
          <div class="oc-details">
            ${detail(t('openCode.port'), status.url || `http://127.0.0.1:${state.port}`)}
            ${detail(t('openCode.runtimePath'), status.path || status.runtimeDir || '—')}
            ${detail(t('openCode.configPath'), status.configPath || '—')}
            ${detail(t('openCode.workspacePath'), status.workspacePath || '—')}
            ${detail(t('openCode.logPath'), status.logPath || '—')}
            ${detail(t('openCode.defaultModel'), summary.defaultModel || t('openCode.none'))}
            ${detail(t('openCode.latestVersion'), updateInfo.latestVersion || t('openCode.notChecked'))}
            ${detail(t('openCode.updateStatus'), updateInfo.latestVersion ? (updateInfo.updateAvailable ? t('openCode.updateAvailable') : t('openCode.upToDate')) : t('openCode.notChecked'))}
          </div>
          ${status.running && !status.managed ? `<div class="oc-note" style="margin-top:14px">${esc(t('openCode.externalStopHint'))}</div>` : ''}
          ${status.requiresManagedAuth ? `<div class="oc-note" style="margin-top:14px">${esc(t('openCode.desktopRestartHint'))}</div>` : ''}
        </div>
        <div class="oc-panel">
          <h2>${esc(t('openCode.providers'))}</h2>
          <div class="oc-details">
            ${detail(t('openCode.providerCount'), summary.configuredProviders?.length ?? 0)}
            ${detail(t('openCode.managedCount'), summary.managedProviders?.length ?? 0)}
            ${detail(t('openCode.modelCount'), summary.modelCount ?? 0)}
          </div>
          <div class="oc-provider-list">${providerNames.length ? providerNames.map(name => `<span class="oc-chip">${esc(name)}</span>`).join('') : `<span class="oc-chip">${esc(t('openCode.none'))}</span>`}</div>
          <div class="oc-note" style="margin-top:15px"><strong>${esc(t('openCode.loopbackTitle'))}</strong>${esc(t('openCode.loopbackDesc'))}</div>
        </div>
      </section>
      <div class="oc-note"><strong>Integration Preview</strong>${esc(t('openCode.developerPreview'))}</div>
    `
  }

  async function refresh() {
    state.loading = true
    state.error = ''
    try {
      state.status = await api.openCodeStatus(state.port)
    } catch (error) {
      state.status = null
      state.error = `${t('openCode.loadFailed')}: ${error?.message || error}`
    } finally {
      state.loading = false
      draw()
    }
    if (state.status?.managedInstalled && !state.updateChecked) {
      state.updateChecked = true
      api.openCodeCheckUpdate().then(result => {
        state.updateInfo = result
        draw()
      }).catch(() => {})
    }
  }

  page.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]')
    if (!button || state.busy) return
    const action = button.dataset.action
    try {
      if (action === 'refresh') return refresh()
      if (action === 'port') {
        state.port = setOpenCodePort(page.querySelector('#oc-port')?.value)
        return refresh()
      }
      if (action === 'install') {
        const ok = await showConfirm(t('openCode.installConfirm', { version: state.status?.targetVersion || '1.18.21' }), { variant: 'primary' })
        if (!ok) return
        state.busy = 'install'; draw()
        await api.openCodeInstall()
        toast(t('openCode.installedDone'), 'success')
        state.updateChecked = false
      } else if (action === 'check-update') {
        state.busy = 'check-update'; draw()
        state.updateInfo = await api.openCodeCheckUpdate()
        state.updateChecked = true
        toast(state.updateInfo.updateAvailable ? t('openCode.updateAvailable') : t('openCode.upToDate'), state.updateInfo.updateAvailable ? 'info' : 'success')
      } else if (action === 'update') {
        const ok = await showConfirm(t('openCode.updateConfirm', {
          current: state.updateInfo?.currentVersion || state.status?.version || '—',
          latest: state.updateInfo?.latestVersion || '—',
        }), { variant: 'primary' })
        if (!ok) return
        state.busy = 'update'; draw()
        const result = await api.openCodeUpdate()
        state.updateInfo = result
        state.updateChecked = true
        toast(result.updated ? t('openCode.updatedDone', { version: result.version || result.latestVersion }) : t('openCode.upToDate'), 'success')
      } else if (action === 'start') {
        state.busy = 'start'; draw()
        await api.openCodeStart(state.port)
        toast(t('openCode.startedDone'), 'success')
      } else if (action === 'stop') {
        const ok = await showConfirm(t('openCode.stopConfirm'))
        if (!ok) return
        state.busy = 'stop'; draw()
        await api.openCodeStop(state.port)
        toast(t('openCode.stoppedDone'), 'success')
      } else if (action === 'uninstall') {
        const ok = await showConfirm(t('openCode.uninstallConfirm'), { variant: 'danger' })
        if (!ok) return
        state.busy = 'uninstall'; draw()
        await api.openCodeUninstall()
        toast(t('openCode.uninstalledDone'), 'success')
      }
    } catch (error) {
      state.error = error?.message || String(error)
      toast(state.error, 'error')
    } finally {
      state.busy = ''
      await refresh()
    }
  })

  draw()
  refresh()
  return page
}
