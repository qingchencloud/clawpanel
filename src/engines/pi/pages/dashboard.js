import { api } from '../../../lib/tauri-api.js'
import { t } from '../../../lib/i18n.js'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'
import { esc } from '../lib/view.js'
import '../../../style/pi.css'

let teardown = () => {}
export function cleanup() { teardown() }

export function render() {
  const page = document.createElement('div')
  page.className = 'page pi-page'
  let disposed = false, busy = false, status = null, error = '', logs = '', update = null
  let draftWorkspace = null, draftAllowTools = null
  teardown = () => { disposed = true }
  const draw = () => {
    if (disposed) return
    const disabled = busy || !status ? 'disabled' : ''
    page.innerHTML = `
      <header class="pi-heading"><div><h1>${t('pi.title')}</h1><p>${t('pi.description')}</p></div><div class="pi-actions"><button class="btn btn-secondary" data-action="refresh" ${disabled}>${t('pi.refresh')}</button><a class="btn btn-primary" href="#/pi/workspace">${t('pi.open')}</a></div></header>
      <div class="pi-notice">${t('pi.preview')}</div>
      ${error ? `<div class="pi-notice pi-error" role="alert">${esc(error)}</div>` : ''}
      ${status && !status.nodeSupported ? `<div class="pi-notice pi-error">${t('pi.nodeRequired')}</div>` : ''}
      <div class="pi-card pi-grid">
        <div class="pi-metric"><span>${t('pi.status')}</span><strong>${!status ? t('pi.busy') : status.installed ? 'v' + esc(status.version) : t('pi.notInstalled')}</strong></div>
        <div class="pi-metric"><span>${t('pi.models')}</span><strong>${(status?.providers || []).reduce((count, provider) => count + provider.models.length, 0)}</strong></div>
        <div class="pi-metric"><span>${t('pi.sessions')}</span><strong>${status?.activeSessions || 0}</strong></div>
      </div>
      <section class="pi-card"><h2>${t('pi.status')}</h2><p class="pi-muted">Node.js ${esc(status?.nodeVersion || '—')}</p><div class="pi-actions">
        ${!status?.installed ? `<button class="btn btn-primary" data-action="install" ${disabled}>${t('pi.install')}</button>` : `<button class="btn btn-secondary" data-action="check_update" ${disabled}>${t('pi.checkUpdate')}</button>${update?.updateAvailable ? `<button class="btn btn-primary" data-action="update" ${disabled}>${t('pi.update')}</button>` : ''}<button class="btn btn-secondary" data-action="uninstall" ${disabled}>${t('pi.uninstall')}</button>`}
        <a class="btn btn-secondary" href="#/model-channels">${t('pi.channels')}</a>
      </div>${update ? `<p>${esc(t('pi.latest', { version: update.latestVersion }))}</p>${update.compatible === false ? `<p class="pi-muted">${t('pi.unverifiedUpdate')}</p>` : ''}` : ''}${busy ? `<p role="status">${t('pi.busy')}</p>` : ''}<p class="pi-path pi-muted">${t('pi.root')}：${esc(status?.root || '—')}</p></section>
      <section class="pi-card"><h2>${t('pi.configure')}</h2><p class="pi-muted">${t('pi.defaultsHint')}</p><form class="pi-form">
        <label>${t('pi.workingDirectory')}<input class="form-input" id="pi-directory" value="${esc(draftWorkspace ?? status?.config?.workspace ?? '')}" ${disabled}></label>
        <label class="pi-checkbox"><input type="checkbox" id="pi-tools" ${(draftAllowTools ?? status?.config?.allowTools) ? 'checked' : ''} ${disabled}>${t('pi.allowTools')}</label>
        <div><button type="button" class="btn btn-primary" data-action="save" ${disabled}>${t('pi.save')}</button></div>
      </form></section>
      <section class="pi-card"><h2>${t('pi.models')}</h2>${(status?.providers || []).map(provider => `<p class="pi-path"><b>${esc(provider.id)}</b> · ${esc(provider.api)}<br>${esc(provider.baseUrl)}<br>${provider.models.map(model => esc(model.id) + (model.contextWindow ? ' · ' + model.contextWindow : '')).join('<br>')}</p>`).join('') || `<p class="pi-muted">${t('pi.noModels')}</p>`}</section>
      <section class="pi-card"><button class="btn btn-secondary" data-action="logs" ${disabled}>${t('pi.logs')}</button><pre class="pi-logs">${esc(logs || t('pi.noLogs'))}</pre></section>`
  }
  const refresh = async () => { status = await api.piCall('status'); draw() }
  page.addEventListener('input', event => { if (event.target.id === 'pi-directory') draftWorkspace = event.target.value })
  page.addEventListener('change', event => { if (event.target.id === 'pi-tools') draftAllowTools = event.target.checked })
  page.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (!action || busy) return
    const workspace = page.querySelector('#pi-directory')?.value
    const allowTools = page.querySelector('#pi-tools')?.checked
    try {
      if (action === 'install' && !await showConfirm(t('pi.installConfirm', { version: status.recommendedVersion }))) return
      if (action === 'update' && !await showConfirm(t('pi.updateConfirm', { version: update.latestVersion }))) return
      if (action === 'uninstall' && !await showConfirm(t('pi.uninstallConfirm'))) return
      if (action === 'save' && allowTools && !status.config.allowTools && !await showConfirm(t('pi.permissionConfirm'))) return
      busy = true; error = ''; draw()
      if (action === 'refresh') await refresh()
      else if (action === 'logs') logs = await api.piCall('logs')
      else if (action === 'check_update') update = await api.piCall('check_update')
      else {
        await api.piCall(action === 'save' ? 'configure' : action, action === 'save' ? { workspace, allowTools } : {})
        if (action === 'save') { draftWorkspace = null; draftAllowTools = null }
        await refresh()
        if (!disposed) toast(t('pi.done'), 'success')
      }
    } catch (err) { error = err?.message || String(err) } finally { busy = false; draw() }
  })
  draw()
  refresh().catch(err => { error = err?.message || String(err); draw() })
  return page
}
