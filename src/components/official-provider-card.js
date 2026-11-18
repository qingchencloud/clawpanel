/** 官方模型一键接入：作为普通 provider 写入引擎配置，聊天使用引擎自己的界面。 */
import { api, isTauriRuntime } from '../lib/tauri-api.js'
import { onPlatformAccountChange } from '../lib/platform-account.js'
import { engineAccessIdentity, sameEngineAccessIdentity } from '../lib/platform-engine-access.js'
import { activateEngine } from '../lib/engine-manager.js'
import { navigate } from '../router.js'
import { t, onLangChange } from '../lib/i18n.js'
import '../style/official-provider.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const text = (key, values) => t('platform.officialProvider.' + key, values)
const codeOf = error => String(error?.message || error || '').replace(/^Error: /, '')

export function createOfficialProviderCard() {
  const element = document.createElement('section')
  element.className = 'card platform-section official-provider'
  element.dataset.officialProvider = ''
  let rows = [], loading = true, busy = '', error = '', notice = '', disposed = false, revision = 0

  let identity = JSON.stringify(engineAccessIdentity())

  async function refresh() {
    const current = ++revision
    if (!isTauriRuntime() || !engineAccessIdentity()) { loading = false; draw(); return }
    try {
      const value = await api.officialProviderStatus()
      if (disposed || current !== revision) return
      rows = (value?.engines || []).filter(row => row.supported !== false)
      error = ''
    } catch (failure) {
      if (current === revision) error = text('loadFailed') + ' ' + codeOf(failure)
    }
    loading = false
    draw()
  }

  async function act(action, engine) {
    const expected = engineAccessIdentity(), version = revision
    if (busy || !expected) return
    busy = action
    error = ''
    notice = ''
    draw()
    const current = () => !disposed && version === revision && sameEngineAccessIdentity(expected)
    try {
      const result = action === 'install'
        ? await api.officialProviderInstall(engine, expected)
        : await api.officialProviderRemove(engine, expected)
      if (!current()) return
      rows = result.engines
      notice = text(action === 'install' ? 'installedNotice' : 'removedNotice')
    } catch (failure) {
      if (current()) error = text(action === 'install' ? 'installFailed' : 'removeFailed') + ' ' + codeOf(failure)
    } finally {
      if (current()) { busy = ''; draw() }
    }
  }

  function stateOf(row) {
    if (row?.configReady === false) return ['off', 'configMissing']
    if (row?.conflict) return ['warn', 'conflict']
    if (!row?.installed) return ['off', 'notInstalled']
    if (row.identityCurrent === false) return ['warn', 'needsReconnect']
    return ['on', 'installed']
  }

  function rowView(row) {
    const [tone, key] = stateOf(row)
    const models = Array.isArray(row.modelIds) ? row.modelIds.length : 0
    const installed = row?.installed === true
    const working = busy === 'install' || busy === 'remove'
    return `<li class="official-provider-row" data-official-engine="${esc(row.engine)}">
      <div class="official-provider-row-info">
        <strong>OpenClaw</strong>
        <span class="official-provider-state" data-tone="${tone}">${esc(text(key))}</span>
        <p class="form-hint">${esc(installed ? text('modelsHint', { count: models }) : text('installHint'))}</p>
      </div>
      <div class="official-provider-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-official-action="install" data-official-engine="${esc(row.engine)}" ${working || row.conflict || row.configReady === false ? 'disabled' : ''}>${esc(installed ? text('refreshAccess') : text('install'))}</button>
        ${row.configReady === false ? `<button type="button" class="btn btn-secondary btn-sm" data-official-action="setup">${esc(text('openSetup'))}</button>` : ''}
        ${installed || row.conflict ? `<button type="button" class="btn btn-secondary btn-sm" data-official-action="models">${esc(text('openModels'))}</button>` : ''}
        ${installed ? `<button type="button" class="btn btn-secondary btn-sm" data-official-action="remove" data-official-engine="${esc(row.engine)}" ${working ? 'disabled' : ''}>${esc(text('remove'))}</button>` : ''}
      </div>
    </li>`
  }

  function draw() {
    if (disposed) return
    const bound = isTauriRuntime() && !!engineAccessIdentity()
    element.setAttribute('aria-busy', String(loading || !!busy))
    const body = !isTauriRuntime()
      ? `<p class="form-hint">${esc(text('desktopOnly'))}</p>`
      : !bound
        ? `<p class="form-hint">${esc(text('bindFirst'))}</p>`
        : loading
          ? `<p class="form-hint">${esc(text('loading'))}</p>`
          : `${error ? `<div class="platform-feedback platform-feedback-warning" role="status"><p>${esc(error)}</p></div>` : ''}
             <ul class="official-provider-list">${rows.map(rowView).join('')}</ul>
             ${notice ? `<div class="platform-feedback" role="status"><p>${esc(notice)}</p></div>` : ''}`
    element.innerHTML = `<div class="official-provider-heading"><div><h3>${esc(text('title'))}</h3><p class="form-hint">${esc(text('intro'))}</p></div><button type="button" class="btn btn-secondary btn-sm" data-official-action="refresh" ${loading || busy ? 'disabled' : ''}>${esc(text('refresh'))}</button></div>
      ${body}`
  }

  async function onClick(event) {
    const button = event.target.closest('[data-official-action]')
    if (!button || button.disabled || disposed) return
    if (['models', 'setup'].includes(button.dataset.officialAction)) {
      try {
        await activateEngine('openclaw', false)
        navigate(button.dataset.officialAction === 'setup' ? '/setup' : '/models')
      } catch (failure) { error = codeOf(failure); draw() }
      return
    }
    if (button.dataset.officialAction === 'refresh') {
      loading = true
      error = ''
      draw()
      refresh()
      return
    }
    if (button.dataset.officialAction === 'install' || button.dataset.officialAction === 'remove') {
      act(button.dataset.officialAction, button.dataset.officialEngine)
    }
  }

  element.addEventListener('click', onClick)
  const offAccount = onPlatformAccountChange(() => {
    const next = JSON.stringify(engineAccessIdentity())
    if (next === identity || disposed) return
    identity = next
    rows = []; notice = ''; error = ''; busy = ''; loading = true
    draw(); void refresh()
  })
  const offLang = onLangChange(() => draw())
  void refresh()

  return {
    element,
    destroy() {
      disposed = true
      revision += 1
      element.removeEventListener('click', onClick)
      offAccount()
      offLang()
    },
  }
}
