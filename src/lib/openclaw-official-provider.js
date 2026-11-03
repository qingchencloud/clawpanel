/** 原 Gateway 官方受管入口；只接收安全公开投影，不接触平台凭据。 */
import { api, isTauriRuntime } from './tauri-api.js'
import { getPlatformAccount, initPlatformAccount, onPlatformAccountChange } from './platform-account.js'
import { t } from './i18n.js'

export const GATEWAY_OFFICIAL_PROVIDER = 'clawpanel-official-gateway'
const managedAgents = new Set()
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
export const isGatewayOfficialModel = value => typeof value === 'string' && value.startsWith(GATEWAY_OFFICIAL_PROVIDER + '/')
export const gatewayOfficialIdentity = () => { const state = getPlatformAccount(); return state.phase === 'bound' && state.member?.member_id ? { epoch: state.epoch, memberId: state.member.member_id } : null }
export const sameGatewayOfficialIdentity = expected => { const current = gatewayOfficialIdentity(); return !!current && !!expected && current.epoch === expected.epoch && current.memberId === expected.memberId }
export const isGatewayOfficialAgent = agent => managedAgents.has(typeof agent === 'string' ? agent : agent?.id) || isGatewayOfficialModel(typeof agent?.model === 'string' ? agent.model : agent?.model?.primary)

function remember(value) {
  for (const id of value?.agentIds || []) if (typeof id === 'string') managedAgents.add(id)
  if (typeof value?.agentId === 'string') managedAgents.add(value.agentId)
  return value
}
export async function gatewayOfficialStatus() {
  if (!isTauriRuntime()) return null
  return remember(await api.openclawGatewayOfficial('status', {}))
}
export function gatewayOfficialChatAccess(status) {
  const expected = gatewayOfficialIdentity()
  if (!expected || status?.supported === false || status?.pendingRecovery || status?.memberId !== expected.memberId || status?.epoch !== expected.epoch || !status?.agentId || !status?.modelId) return null
  const ready = status.attached === true && !status.restartRequired && status.gatewayRunning !== false
  const stopped = status.enabled === true && status.gatewayRunning === false
  // 已配置但停机时只打开原连接提示；真实 attached 前不能发送官方消息。
  return ready || stopped ? { expected, ready } : null
}
export function newGatewayOfficialChat(status) {
  if (!gatewayOfficialChatAccess(status)) return ''
  const params = new URLSearchParams({ official: '1', agent: status.agentId, session: 'official-' + crypto.randomUUID() })
  return '/chat?' + params
}
export function gatewayOfficialBindings(status) {
  return '/channels?' + new URLSearchParams({ tab: 'agents', agent: status.agentId, action: 'bind' })
}

export function createGatewayOfficialCard() {
  const element = document.createElement('section')
  element.className = 'config-section'
  element.dataset.gatewayOfficial = ''
  let status = null, busy = false, error = '', revision = 0, disposed = false, identity = JSON.stringify(gatewayOfficialIdentity())
  const current = () => { const expected = gatewayOfficialIdentity(); return expected && status?.memberId === expected.memberId && status?.epoch === expected.epoch }
  const action = (name, label, primary = false) => `<button type="button" class="btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}" data-gateway-official-action="${name}" ${busy ? 'disabled' : ''}>${esc(t('platform.gatewayOfficial.' + label))}</button>`
  function draw() {
    if (disposed) return
    const bound = !!gatewayOfficialIdentity(), own = current(), supported = status?.supported !== false, models = own && supported && Array.isArray(status?.models) ? status.models : []
    const selected = element.querySelector('[data-gateway-official-model]')?.value || status?.modelId || ''
    const stateKey = !bound ? 'signInHint' : !status ? 'loading' : !supported ? 'upgrade' : !own ? 'unavailable' : status.pendingRecovery ? 'pending' : status.attached && !status.restartRequired ? 'ready' : status.enabled ? 'enabled' : 'intro'
    element.innerHTML = `<div class="config-section-title">${esc(t('platform.gatewayOfficial.title'))}</div><p class="form-hint" role="status">${esc(t('platform.gatewayOfficial.' + stateKey))}</p>
      ${error ? `<p class="form-hint" role="alert" data-gateway-official-error>${esc(error)}</p>` : ''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${!bound ? `<a class="btn btn-sm btn-primary" data-gateway-official-action="login" href="#/account">${esc(t('platform.loginOrRegister'))}</a>` : `${models.length ? `<select class="form-input" data-gateway-official-model aria-label="${esc(t('platform.selectModel'))}" style="width:auto;max-width:100%" ${busy || status?.pendingRecovery ? 'disabled' : ''}>${models.map(model => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.display_name || model.id)}</option>`).join('')}</select>` : ''}${own && supported && !status.pendingRecovery && models.length && status.canConfigure !== false ? action('enable', status.enabled ? 'saveModel' : 'enable', !status.enabled) : ''}${own && supported && !status.pendingRecovery && status.enabled && !status.attached && !status.restartRequired ? action('connect', 'connect', true) : ''}${own && supported && !status.pendingRecovery && status.attached && !status.restartRequired ? `${action('new-chat', 'newChat', true)}${action('channels', 'bindings')}${action('disconnect', 'disconnect')}` : ''}${own && status?.pendingRecovery ? action('recover', 'recover', true) : ''}${own && supported && status.restartRequired ? `<a class="btn btn-sm btn-primary" data-gateway-official-settings href="#/services">${esc(t('platform.gatewayOfficial.settings'))}</a>` : ''}${action('refresh', 'refresh')}`}
      </div>${bound ? `<p class="form-hint" style="margin-top:8px">${esc(t('platform.gatewayOfficial.preserve'))}${status?.restartRequired ? ' ' + esc(t('platform.gatewayOfficial.restartHint')) : ''}</p>` : ''}${models.find(model => model.id === selected)?.capabilities?.tool_calls === true ? `<p class="form-hint" data-gateway-official-tools>${esc(t('platform.gatewayOfficial.toolsHint'))}</p>` : ''}`
  }
  async function load() {
    const version = ++revision, expected = gatewayOfficialIdentity()
    busy = true; error = ''; draw()
    try {
      const value = await gatewayOfficialStatus()
      if (disposed || version !== revision || expected && !sameGatewayOfficialIdentity(expected)) return
      status = value
      if (expected && value?.supported !== false && value?.memberId === expected.memberId && value?.epoch === expected.epoch) {
        const catalog = await api.openclawGatewayOfficial('catalog', { expected })
        if (disposed || version !== revision || !sameGatewayOfficialIdentity(expected)) return
        status = remember(catalog)
      }
    } catch { if (version === revision) error = t('platform.gatewayOfficial.unavailable') }
    finally { if (!disposed && version === revision) { busy = false; draw() } }
  }
  element.addEventListener('click', async event => {
    const button = event.target.closest('[data-gateway-official-action]'), name = button?.dataset.gatewayOfficialAction
    if (!name || name === 'login' || busy) return
    if (name === 'refresh') { load(); return }
    const expected = gatewayOfficialIdentity()
    if (!expected || !current()) return
    if (name === 'new-chat') { const route = newGatewayOfficialChat(status); if (route) location.hash = route; return }
    if (name === 'channels') { location.hash = gatewayOfficialBindings(status); return }
    const modelId = element.querySelector('[data-gateway-official-model]')?.value, version = revision
    busy = true; error = ''; draw()
    try {
      const args = name === 'enable' ? { modelId, expected, expectedConfigSha256: status.configSha256 } : { expected }
      const value = await api.openclawGatewayOfficial(name, args)
      if (disposed || version !== revision || !sameGatewayOfficialIdentity(expected)) return
      status = remember(value)
    } catch (cause) {
      if (version === revision) error = t('platform.gatewayOfficial.' + (String(cause?.message || cause).includes('config_changed') ? 'configChanged' : 'actionFailed'))
    } finally { if (!disposed && version === revision) { busy = false; draw() } }
  })
  const off = onPlatformAccountChange(() => {
    const next = JSON.stringify(gatewayOfficialIdentity())
    if (next === identity) return
    identity = next; revision++; status = null; busy = false; error = ''; draw(); load()
  })
  draw(); initPlatformAccount().catch(() => {}).finally(() => { if (!disposed) load() })
  return { element, destroy() { disposed = true; revision++; off() } }
}
