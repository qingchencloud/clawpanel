/** 邀请海报面板；账号、绘图版本和保存意图都只在本次内存中保留。 */
import { api, isTauriRuntime } from '../lib/tauri-api.js'
import { getLang, onLangChange } from '../lib/i18n.js'
import { getPlatformAccount, onPlatformAccountChange } from '../lib/platform-account.js'
import { POSTER_ASSETS, posterText, validateInvitationPoster, invitationPosterSummary, renderInvitationPoster } from '../lib/invitation-poster-renderer.js'
import '../style/invitation-poster.css'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const outputLanguage = () => getLang().startsWith('zh') ? 'zh-CN' : 'en'
function currentIdentity() {
  const state = getPlatformAccount()
  return isTauriRuntime() && ['logged_in', 'bound'].includes(state.phase) && state.member?.member_id
    ? { epoch: state.epoch, memberId: state.member.member_id, origin: state.origin } : null
}
const identityKey = value => value ? JSON.stringify([value.epoch, value.memberId, value.origin]) : ''

export function createInvitationPosterPanel({ onBack = () => {}, restoreFocus } = {}) {
  const element = document.createElement('section')
  element.className = 'invitation-poster-panel'; element.dataset.posterPanel = ''; element.tabIndex = -1
  let language = outputLanguage(), template = 'warm', bundle = null, owner = currentIdentity()
  let disposed = false, reading = false, saving = false, ready = false, updated = false
  let activeSave = null
  let requestVersion = 0, paintVersion = 0, status = 'Loading', savedPath = '', expiryTimer = null, receivedAt = 0
  element.innerHTML = `<header class="invitation-poster-heading"><button type="button" class="btn btn-secondary btn-sm" data-poster-back></button><div><h2 id="invitation-poster-title"></h2><p data-poster-current-rules></p></div></header>
    <div class="invitation-poster-workspace">
      <div class="invitation-poster-preview"><canvas width="1080" height="1440" data-poster-canvas hidden role="img"></canvas></div>
      <div class="invitation-poster-sidebar">
        <div class="invitation-poster-controls"><div class="invitation-poster-style-field"><p data-poster-style-label></p><div class="invitation-poster-styles" role="group" data-poster-styles>${['warm', 'dark', 'paper'].map(name => `<button type="button" data-poster-template="${name}" aria-pressed="${name === 'warm'}"><img src="${escape(POSTER_ASSETS[name])}" alt="" width="36" height="48"><span></span></button>`).join('')}</div></div><label class="invitation-poster-language"><span data-poster-language-label></span><select data-poster-language><option value="zh-CN">简体中文</option><option value="en">English</option></select></label></div>
        <details class="invitation-poster-rule-details"><summary data-poster-rules-label></summary><ul data-poster-rules></ul><p data-poster-truth></p></details>
        <details class="invitation-poster-saved-details" data-poster-saved-details hidden><summary data-poster-location-label></summary><output data-poster-path hidden></output></details>
      </div>
    </div>
    <footer class="invitation-poster-feedback"><p data-poster-status role="status" aria-live="polite"></p><div class="invitation-poster-actions"><a class="btn btn-secondary btn-sm" href="#/account" data-poster-account hidden></a><button type="button" class="btn btn-secondary btn-sm" data-poster-retry hidden></button><button type="button" class="btn btn-primary" data-poster-save disabled></button></div></footer>`
  const q = selector => element.querySelector(selector), canvas = q('[data-poster-canvas]')
  const sameOwner = () => !disposed && identityKey(owner) !== '' && identityKey(owner) === identityKey(currentIdentity())
  const expired = () => !!bundle && Date.parse(bundle.view.promotion.referral.ends_at) - Date.parse(bundle.view.server_time) <= performance.now() - receivedAt
  const clearTimer = () => { if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = null }
  function clearPreview() {
    paintVersion++; ready = false; savedPath = ''; canvas.hidden = true
    canvas.width = 0; canvas.height = 0; q('[data-poster-rules]').replaceChildren(); clearTimer()
  }
  function labels() {
    const text = key => posterText(key, language)
    q('[data-poster-back]').textContent = text('Back'); q('#invitation-poster-title').textContent = text('Title')
    q('[data-poster-current-rules]').textContent = text('CurrentRules'); q('[data-poster-language-label]').textContent = text('Language'); q('[data-poster-style-label]').textContent = text('Style')
    q('[data-poster-language]').value = language; q('[data-poster-styles]').setAttribute('aria-label', text('Style'))
    for (const button of element.querySelectorAll('[data-poster-template]')) {
      const name = button.dataset.posterTemplate
      button.querySelector('span').textContent = text(name[0].toUpperCase() + name.slice(1)); button.setAttribute('aria-pressed', String(template === name)); button.disabled = saving
    }
    q('[data-poster-language]').disabled = saving
    q('[data-poster-rules-label]').textContent = text('RuleDetails'); q('[data-poster-truth]').textContent = text('Rules')
    q('[data-poster-status]').textContent = text(status)
    q('[data-poster-retry]').textContent = text('Retry'); q('[data-poster-retry]').hidden = ready || reading || status === 'Auth' || status === 'Scope'; q('[data-poster-retry]').disabled = saving
    q('[data-poster-account]').textContent = text('Account'); q('[data-poster-account]').hidden = !['Auth', 'Scope'].includes(status)
    q('[data-poster-save]').textContent = text('Save'); q('[data-poster-save]').disabled = !ready || saving || !sameOwner() || expired()
    q('[data-poster-save]').setAttribute('aria-busy', String(saving)); q('[data-poster-save]').toggleAttribute('data-poster-confirm-update', updated && ready)
    q('[data-poster-location-label]').textContent = text('SavedLocation')
    q('[data-poster-path]').textContent = savedPath; q('[data-poster-path]').hidden = !savedPath
    q('[data-poster-saved-details]').hidden = !savedPath
    if (!savedPath) q('[data-poster-saved-details]').open = false
    element.dataset.posterState = saving ? 'saving' : reading ? 'loading' : ready ? updated ? 'updated' : 'ready' : status.toLowerCase()
    element.setAttribute('aria-busy', String(reading || saving))
  }
  function fail(key = 'Failed') { clearPreview(); bundle = null; updated = false; status = key; labels() }
  function errorKey(error) {
    const code = typeof error === 'string' ? error : error?.code || error?.message || ''
    return code === 'insufficient_scope' ? 'Scope' : ['platform_login_required', 'platform_account_changed'].includes(code) ? 'Auth' : code === 'platform_poster_unavailable' ? 'Unavailable' : saving ? 'SaveFailed' : 'Failed'
  }
  function armExpiry() {
    clearTimer()
    if (!bundle) return
    const remaining = Date.parse(bundle.view.promotion.referral.ends_at) - Date.parse(bundle.view.server_time) - (performance.now() - receivedAt)
    if (remaining <= 0) { fail('Unavailable'); return }
    expiryTimer = setTimeout(() => { if (!disposed) { if (expired()) fail('Unavailable'); else armExpiry() } }, Math.min(remaining + 1, 2147483647))
  }
  async function paint() {
    clearPreview()
    if (!bundle || !sameOwner() || expired()) { fail(sameOwner() ? 'Unavailable' : 'Auth'); return }
    const current = bundle, version = paintVersion, selected = template, lang = language
    status = 'Loading'; labels()
    try {
      const done = await renderInvitationPoster(canvas, current, { template: selected, language: lang, isCurrent: () => !disposed && version === paintVersion && bundle === current && sameOwner() && !expired() })
      if (!done || disposed || version !== paintVersion) return
      ready = true; canvas.hidden = false; status = updated ? 'Updated' : 'Ready'
      for (const text of invitationPosterSummary(current, lang)) { const row = document.createElement('li'); row.textContent = text; q('[data-poster-rules]').append(row) }
      armExpiry(); labels()
    } catch { if (!disposed && version === paintVersion) fail('Failed') }
  }
  function adopt(value) {
    if (!sameOwner() || !validateInvitationPoster(value, owner)) { fail(sameOwner() ? 'Unavailable' : 'Auth'); return false }
    bundle = value; receivedAt = performance.now(); return true
  }
  async function load() {
    if (disposed || reading || saving) return
    const identity = currentIdentity(); requestVersion++; const version = requestVersion
    clearPreview(); bundle = null; updated = false; owner = identity
    if (!owner) { status = 'Auth'; labels(); return }
    reading = true; status = 'Loading'; labels()
    try {
      const value = await api.platformGetInvitationPoster()
      if (disposed || version !== requestVersion || !sameOwner()) return
      reading = false; if (adopt(value)) await paint()
    } catch (error) { if (!disposed && version === requestVersion && sameOwner()) fail(errorKey(error)) }
    finally { if (!disposed && version === requestVersion) { reading = false; labels() } }
  }
  async function save() {
    if (!ready || saving || reading || !sameOwner() || expired() || !bundle) return
    const version = paintVersion, current = bundle, selected = template, lang = language
    const flight = {}; activeSave = flight
    saving = true; status = 'Saving'; savedPath = ''; labels()
    try {
      // 不创建下载链接或Blob URL；只有原生保存命令可以写文件。
      const png = canvas.toDataURL('image/png').split(',')[1]
      if (!png || disposed || version !== paintVersion || !sameOwner() || bundle !== current || expired()) return
      const result = await api.platformSaveInvitationPoster({ epoch: current.epoch, memberId: current.memberId, revision: current.revision, template: selected, language: lang === 'en' ? 'en' : 'zh', pngBase64: png })
      if (disposed || version !== paintVersion || !sameOwner() || bundle !== current || selected !== template || lang !== language) return
      if (result?.status === 'updated') {
        clearPreview(); bundle = null; updated = true
        if (adopt(result.poster)) await paint()
      } else if (result?.status === 'saved' && typeof result.path === 'string' && result.path.length > 0 && result.path.length <= 4096 && !/[\u0000-\u001f]/.test(result.path)) { status = 'Saved'; savedPath = result.path; updated = false }
      else fail('SaveFailed')
    } catch (error) { if (!disposed && version === paintVersion && sameOwner()) fail(errorKey(error)) }
    finally { if (!disposed && activeSave === flight) { activeSave = null; saving = false; labels() } }
  }
  q('[data-poster-back]').addEventListener('click', () => { onBack(); if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }) })
  q('[data-poster-save]').addEventListener('click', save); q('[data-poster-retry]').addEventListener('click', load)
  q('[data-poster-language]').addEventListener('change', () => { language = q('[data-poster-language]').value === 'en' ? 'en' : 'zh-CN'; labels(); if (bundle) paint() })
  for (const button of element.querySelectorAll('[data-poster-template]')) button.addEventListener('click', () => { if (saving || template === button.dataset.posterTemplate) return; template = button.dataset.posterTemplate; labels(); if (bundle) paint() })
  const subscriptions = [onPlatformAccountChange(() => {
    if (!sameOwner()) { requestVersion++; reading = false; activeSave = null; saving = false; owner = null; fail('Auth') }
  }), onLangChange(() => { language = outputLanguage(); labels(); if (bundle) paint() })]
  labels(); queueMicrotask(load)
  return { element, dispose() { if (disposed) return; disposed = true; requestVersion++; clearPreview(); bundle = null; savedPath = ''; for (const off of subscriptions) off?.(); element.remove() } }
}
