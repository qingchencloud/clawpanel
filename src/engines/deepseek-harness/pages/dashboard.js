import { api } from '../../../lib/tauri-api.js'
import { getDshPort, setDshPort } from '../../../lib/model-channels.js'
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
  return `<div class="dsh-metric" data-tone="${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
}

function detail(label, value) {
  return `<div class="dsh-detail"><span>${esc(label)}</span><code title="${esc(value)}">${esc(value || '—')}</code></div>`
}

export function render() {
  const page = document.createElement('div')
  page.className = 'page dsh-page'
  page.dataset.engine = 'deepseek-harness'

  const state = {
    loading: true,
    busy: '',
    status: null,
    error: '',
    port: getDshPort(),
  }

  function draw() {
    const status = state.status || {}
    const summary = status.summary || {}
    const providerNames = Array.isArray(summary.configuredProviders) ? summary.configuredProviders : []
    page.innerHTML = `
      <style>
        .dsh-page{--dsh:#4f7cff;display:grid;gap:18px;max-width:1480px;margin:0 auto}
        .dsh-hero{padding:24px;border:1px solid var(--border-primary);border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsh) 13%,var(--bg-primary)),var(--bg-primary) 58%);display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}
        .dsh-eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--dsh);font-weight:700}.dsh-hero h1{margin:7px 0 8px;font-size:28px;color:var(--text-primary)}.dsh-hero p{margin:0;max-width:720px;color:var(--text-secondary);line-height:1.7}
        .dsh-actions{display:flex;gap:8px;flex-wrap:wrap}.dsh-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.dsh-metric{padding:16px;border:1px solid var(--border-primary);border-radius:12px;background:var(--bg-primary);display:grid;gap:9px}.dsh-metric span{font-size:12px;color:var(--text-tertiary)}.dsh-metric strong{font-size:20px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis}.dsh-metric[data-tone=ok] strong{color:var(--success)}.dsh-metric[data-tone=warn] strong{color:var(--warning)}
        .dsh-panels{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.dsh-panel{border:1px solid var(--border-primary);border-radius:14px;background:var(--bg-primary);padding:18px}.dsh-panel h2{font-size:15px;margin:0 0 14px;color:var(--text-primary)}.dsh-details{display:grid;gap:10px}.dsh-detail{display:grid;grid-template-columns:128px minmax(0,1fr);gap:12px;align-items:center}.dsh-detail span{font-size:12px;color:var(--text-tertiary)}.dsh-detail code{font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg-secondary);border-radius:7px;padding:8px}
        .dsh-port{display:flex;gap:8px;align-items:center;margin:0 0 14px}.dsh-port input{max-width:150px}.dsh-note{padding:13px 14px;border-radius:10px;background:color-mix(in srgb,var(--dsh) 8%,var(--bg-secondary));border:1px solid color-mix(in srgb,var(--dsh) 24%,var(--border-primary));color:var(--text-secondary);font-size:12px;line-height:1.65}.dsh-note strong{display:block;color:var(--text-primary);margin-bottom:3px}.dsh-error{padding:12px 14px;border:1px solid color-mix(in srgb,var(--error) 40%,var(--border-primary));border-radius:10px;color:var(--error);background:color-mix(in srgb,var(--error) 7%,var(--bg-primary));white-space:pre-wrap;word-break:break-word}.dsh-provider-list{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.dsh-chip{border:1px solid var(--border-primary);border-radius:999px;padding:4px 9px;font-size:11px;color:var(--text-secondary);background:var(--bg-secondary)}
        @media(max-width:900px){.dsh-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-panels{grid-template-columns:1fr}}@media(max-width:560px){.dsh-grid{grid-template-columns:1fr}.dsh-detail{grid-template-columns:1fr}.dsh-hero{padding:18px}}
      </style>
      <section class="dsh-hero">
        <div>
          <div class="dsh-eyebrow">DeepSeek · Agent Harness</div>
          <h1>${esc(t('deepseekHarness.title'))}</h1>
          <p>${esc(t('deepseekHarness.desc'))}</p>
        </div>
        <div class="dsh-actions">
          <button class="btn btn-secondary btn-sm" data-action="refresh" ${state.busy ? 'disabled' : ''}>${esc(t('deepseekHarness.refresh'))}</button>
          ${!status.installed ? `<button class="btn btn-primary btn-sm" data-action="install" ${state.busy || status.nodeCompatible === false ? 'disabled' : ''}>${esc(state.busy === 'install' ? t('deepseekHarness.installing') : t('deepseekHarness.install'))}</button>` : ''}
          ${status.installed && !status.running ? `<button class="btn btn-primary btn-sm" data-action="start" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'start' ? t('deepseekHarness.starting') : t('deepseekHarness.start'))}</button>` : ''}
          ${status.running && status.managed ? `<button class="btn btn-danger btn-sm" data-action="stop" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'stop' ? t('deepseekHarness.stopping') : t('deepseekHarness.stop'))}</button>` : ''}
          ${status.managedInstalled && !status.running ? `<button class="btn btn-secondary btn-sm" data-action="uninstall" ${state.busy ? 'disabled' : ''}>${esc(state.busy === 'uninstall' ? t('deepseekHarness.uninstalling') : t('deepseekHarness.uninstall'))}</button>` : ''}
          ${status.running && status.managed ? `<a class="btn btn-primary btn-sm" href="#/dsh/workspace">${esc(t('deepseekHarness.openWorkspace'))}</a>` : ''}
          <a class="btn btn-secondary btn-sm" href="#/model-channels">${esc(t('deepseekHarness.modelChannels'))}</a>
        </div>
      </section>

      ${state.error ? `<div class="dsh-error">${esc(state.error)}</div>` : ''}
      ${status.foreignPort ? `<div class="dsh-error">${esc(t('deepseekHarness.foreignPort'))}</div>` : ''}
      ${status.nodeCompatible === false ? `<div class="dsh-error">${esc(t('deepseekHarness.nodeIncompatible', { requirement: status.nodeRequirement || '^22.19.0 || >=24.0.0' }))}</div>` : ''}

      <section class="dsh-grid">
        ${metric(t('deepseekHarness.status'), status.running ? t('deepseekHarness.running') : t('deepseekHarness.stopped'), status.running ? 'ok' : 'warn')}
        ${metric(t('deepseekHarness.packageVersion'), status.version || status.targetVersion || '—')}
        ${metric(t('deepseekHarness.providerCount'), summary.configuredProviders?.length ?? 0)}
        ${metric(t('deepseekHarness.modelCount'), summary.modelCount ?? 0)}
      </section>

      <section class="dsh-panels">
        <div class="dsh-panel">
          <h2>${esc(t('deepseekHarness.status'))}</h2>
          <div class="dsh-port">
            <input class="form-input" id="dsh-port" type="number" min="1024" max="65535" value="${esc(state.port)}">
            <button class="btn btn-secondary btn-sm" data-action="port" ${state.busy ? 'disabled' : ''}>${esc(t('deepseekHarness.applyPort'))}</button>
          </div>
          <div class="form-hint" style="margin:-7px 0 14px">${esc(t('deepseekHarness.portHint'))}</div>
          <div class="dsh-details">
            ${detail(t('deepseekHarness.port'), status.url || `http://127.0.0.1:${state.port}`)}
            ${detail(t('deepseekHarness.nodeVersion'), `${status.nodeVersion || '—'} · ${status.nodeRequirement || ''}`)}
            ${detail(t('deepseekHarness.runtimePath'), status.path || status.runtimeDir || '—')}
            ${detail(t('deepseekHarness.logPath'), status.logPath || '—')}
            ${detail(t('deepseekHarness.defaultModel'), summary.defaultModel || t('deepseekHarness.none'))}
          </div>
          ${status.running && !status.managed ? `<div class="dsh-note" style="margin-top:14px">${esc(t('deepseekHarness.externalStopHint'))}</div>` : ''}
        </div>
        <div class="dsh-panel">
          <h2>${esc(t('deepseekHarness.providers'))}</h2>
          <div class="dsh-details">
            ${detail(t('deepseekHarness.providerCount'), summary.configuredProviders?.length ?? 0)}
            ${detail(t('deepseekHarness.activeCount'), summary.activeProviders?.length ?? 0)}
            ${detail(t('deepseekHarness.modelCount'), summary.modelCount ?? 0)}
          </div>
          <div class="dsh-provider-list">${providerNames.length ? providerNames.map(name => `<span class="dsh-chip">${esc(name)}</span>`).join('') : `<span class="dsh-chip">${esc(t('deepseekHarness.none'))}</span>`}</div>
          <div class="dsh-note" style="margin-top:15px"><strong>${esc(t('deepseekHarness.loopbackTitle'))}</strong>${esc(t('deepseekHarness.loopbackDesc'))}</div>
        </div>
      </section>
      <div class="dsh-note"><strong>Developer Preview</strong>${esc(t('deepseekHarness.developerPreview'))}</div>
    `
  }

  async function refresh() {
    state.loading = true
    state.error = ''
    try {
      state.status = await api.dshStatus(state.port)
    } catch (error) {
      state.status = null
      state.error = `${t('deepseekHarness.loadFailed')}: ${error?.message || error}`
    } finally {
      state.loading = false
      draw()
    }
  }

  page.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]')
    if (!button || state.busy) return
    const action = button.dataset.action
    try {
      if (action === 'refresh') return refresh()
      if (action === 'port') {
        state.port = setDshPort(page.querySelector('#dsh-port')?.value)
        return refresh()
      }
      if (action === 'install') {
        const ok = await showConfirm(t('deepseekHarness.installConfirm', { version: state.status?.targetVersion || '0.1.1-rc.2' }), { variant: 'primary' })
        if (!ok) return
        state.busy = 'install'; draw()
        await api.dshInstall()
        toast(t('deepseekHarness.installedDone'), 'success')
      } else if (action === 'start') {
        state.busy = 'start'; draw()
        await api.dshStart(state.port)
        toast(t('deepseekHarness.startedDone'), 'success')
      } else if (action === 'stop') {
        const ok = await showConfirm(t('deepseekHarness.stopConfirm'))
        if (!ok) return
        state.busy = 'stop'; draw()
        await api.dshStop(state.port)
        toast(t('deepseekHarness.stoppedDone'), 'success')
      } else if (action === 'uninstall') {
        const ok = await showConfirm(t('deepseekHarness.uninstallConfirm'), { variant: 'danger' })
        if (!ok) return
        state.busy = 'uninstall'; draw()
        await api.dshUninstall()
        toast(t('deepseekHarness.uninstalledDone'), 'success')
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
