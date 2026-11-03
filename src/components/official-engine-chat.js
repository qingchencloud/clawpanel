// 内核官方会话与原自有Key会话分开；连接能力只在native处理。
import { api, isTauriRuntime, safeTauriListen } from '../lib/tauri-api.js'
import { getPlatformAccount, initPlatformAccount, onPlatformAccountChange } from '../lib/platform-account.js'
import { t } from '../lib/i18n.js'
import { consumeOfficialEngineIntent, adoptOfficialEngineIntent } from '../lib/platform-engine-access.js'

export function createOfficialEngineChat(engine, onChannelChange = () => {}) {
  const accessIntent = consumeOfficialEngineIntent(engine)
  const element = document.createElement('section')
  element.className = 'official-engine-chat'
  element.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0;flex-shrink:0'
  let account = getPlatformAccount(), models = [], connected = null, running = false, runId = null, pendingEvents = [], version = 0
  let sessionId = `official_${crypto.randomUUID().replaceAll('-', '_')}`
  let identity = `${account.epoch}:${account.member?.member_id || ''}`, messages = []
  let offEvent = () => {}, disposed = false
  element.innerHTML = `<label>${t('platform.channel')} <select class="form-input" data-engine-channel><option value="byok">${t('platform.byok')}</option>${isTauriRuntime() ? `<option value="official">${t('platform.official')}</option>` : ''}</select></label>
    <div data-official-engine-panel hidden><p>${t('platform.officialHint')}</p><a href="#/account" data-official-engine-account>${t('platform.title')}</a>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><select class="form-input" data-official-engine-model aria-label="${t('platform.selectModel')}"><option value="">${t('platform.selectModel')}</option></select><button class="btn btn-secondary" data-official-engine-connect>${t('channels.connect')}</button></div>
    <div data-official-engine-status role="status"></div><p data-official-engine-text-only hidden>${t('platform.engineAccess.textOnly')}</p><div data-official-engine-output role="log" style="white-space:pre-wrap;overflow:auto;max-height:40vh;overflow-wrap:anywhere"></div>
    <textarea class="form-input" data-official-engine-input aria-label="${t('platform.official')}" rows="3"></textarea>
    <div style="display:flex;gap:8px"><button class="btn btn-primary" data-official-engine-send>${t('chat.send')}</button><button class="btn btn-secondary" data-official-engine-cancel>${t('common.cancel')}</button><a href="#/account">${t('platform.recover')}</a></div></div>`
  const find = name => element.querySelector(`[data-${name}]`)
  const status = value => { find('official-engine-status').textContent = value }
  const identityNow = () => `${account.epoch}:${account.member?.member_id || ''}`
  const callerIdentity = () => ({ epoch: account.epoch, memberId: account.member?.member_id })
  const closed = () => account.platformStatus?.fixture_mode === false && account.platformStatus?.real_upstream_enabled === false
  function update() {
    const bound = account.phase === 'bound' && !closed()
    find('official-engine-connect').disabled = !bound || running || !find('official-engine-model').value
    find('official-engine-model').disabled = !bound || running
    find('official-engine-send').disabled = !bound || !connected || running
    find('official-engine-input').disabled = !bound || !connected || running
    find('official-engine-cancel').disabled = !running
    find('official-engine-account').hidden = bound
    const model = models.find(model => model.id === find('official-engine-model').value)
    find('official-engine-text-only').hidden = !(model?.textOnly || model?.toolsAvailable === false || model?.capabilities?.tool_calls === false || connected?.textOnly)
  }
  function output() { find('official-engine-output').textContent = messages.map(message => message.text).join('\n\n') }
  async function catalog() {
    if (account.phase !== 'bound' || closed()) { update(); return }
    const current = version
    try {
      const result = await api.officialEngineConnect(engine, '')
      if (disposed || current !== version) return
      models = result.models || []
      const select = find('official-engine-model')
      select.replaceChildren(new Option(t('platform.selectModel'), ''))
      for (const model of models) select.append(new Option(model.display_name || model.id, model.id))
      status(models.length ? t('platform.selectModelFirst') : t('platform.noModels'))
    } catch { if (current === version) status(t('platform.errors.official_models_unavailable')) }
    update()
  }
  find('engine-channel').onchange = () => {
    const official = find('engine-channel').value === 'official'
    find('official-engine-panel').hidden = !official
    onChannelChange(official)
    if (official) catalog()
  }
  find('official-engine-model').onchange = () => { connected = null; update() }
  find('official-engine-connect').onclick = async () => {
    const current = version, model = find('official-engine-model').value, expected = callerIdentity()
    if (!model || running) return
    status(t('common.loading')); find('official-engine-connect').disabled = true
    try {
      await api.officialEngineDisconnect(engine, expected)
      if (current !== version) return
      const result = await api.officialEngineConnect(engine, model, expected)
      if (current !== version || result.epoch !== account.epoch || result.memberId !== account.member?.member_id) return
      connected = result; status(t('platform.officialReady'))
    } catch { if (current === version) status(t('platform.errors.official_models_unavailable')) }
    update()
  }
  function applyEvent(value) {
    if (disposed || value.engine !== engine || value.memberId !== account.member?.member_id || value.epoch !== account.epoch || !running) return
    if (!runId) { pendingEvents.push(value); return }
    if (value.runId !== runId) return
    const answer = messages.at(-1)
    if (value.type === 'delta') answer.text += value.data?.delta || ''
    if (value.type === 'complete') { if (typeof value.data?.output === 'string') answer.text = value.data.output; running = false; status(t('platform.officialReady')) }
    if (value.type === 'error') { running = false; status(t('platform.errors.outcome_unknown')) }
    output(); update()
  }
  safeTauriListen('official-engine-event', event => applyEvent(event.payload)).then(unlisten => { if (disposed) unlisten(); else offEvent = unlisten }).catch(() => {})
  find('official-engine-send').onclick = async () => {
    const input = find('official-engine-input').value.trim(), current = version, expected = callerIdentity()
    if (!input || running || !connected || account.phase !== 'bound' || closed()) return
    running = true; runId = null; pendingEvents = []; messages.push({ text: input }, { text: '' }); find('official-engine-input').value = ''; output(); update()
    try {
      const result = await api.officialEngineRun(engine, input, sessionId, expected)
      if (current !== version) return
      runId = result.runId
      for (const event of pendingEvents.splice(0)) applyEvent(event)
    } catch { if (current === version) { running = false; status(t('platform.errors.outcome_unknown')); update() } }
  }
  find('official-engine-cancel').onclick = async () => {
    if (!running) return
    const expected = callerIdentity(), current = version
    try { await api.officialEngineCancel(engine, expected); if (current === version) status(t('platform.cancelRequested')) } catch { if (current === version) status(t('platform.errors.outcome_unknown')) }
  }
  const offAccount = onPlatformAccountChange(next => {
    account = next
    if (identityNow() !== identity) {
      identity = identityNow(); version++; connected = null; running = false; runId = null; pendingEvents = []; messages = []; models = []
      sessionId = `official_${crypto.randomUUID().replaceAll('-', '_')}`
      output(); find('official-engine-model').replaceChildren(new Option(t('platform.selectModel'), ''))
      if (find('engine-channel').value === 'official') catalog()
    }
    update()
  })
  if (accessIntent) {
    find('engine-channel').value = 'official'; find('official-engine-panel').hidden = false; onChannelChange(true)
    status(t('platform.engineAccess.intentExpired'))
  }
  initPlatformAccount().then(async () => {
    if (!accessIntent || accessIntent.invalid || disposed) return
    const current = version
    try {
      const result = await adoptOfficialEngineIntent(engine, accessIntent)
      if (disposed || current !== version) return
      models = [accessIntent.model]
      find('official-engine-model').replaceChildren(new Option(accessIntent.model.display_name, accessIntent.model.id))
      connected = result; status(t('platform.officialReady')); update()
    } catch { if (!disposed && current === version) status(t('platform.engineAccess.openFailed')) }
  }).catch(() => {}); update()
  return { element, destroy() { disposed = true; version++; offAccount(); offEvent() } }
}
