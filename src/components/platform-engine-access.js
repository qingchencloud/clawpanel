/** 官方通道配置与内核运行分开呈现；目录和配置均由用户显式发起。 */
import { api, isTauriRuntime } from '../lib/tauri-api.js'
import { onPlatformAccountChange } from '../lib/platform-account.js'
import { getActiveEngineId, activateEngine } from '../lib/engine-manager.js'
import { t, onLangChange } from '../lib/i18n.js'
import { navigate } from '../router.js'
import { OFFICIAL_ENGINES as ALL_OFFICIAL_ENGINES, engineAccessIdentity, sameEngineAccessIdentity, openConnectedEngine } from '../lib/platform-engine-access.js'
// OpenClaw 已改为「普通 provider 一键接入」，旧官方通道卡只保留其余引擎，避免出现两个入口。
const OFFICIAL_ENGINES = ALL_OFFICIAL_ENGINES.filter(engine => engine !== 'openclaw')
import '../style/platform-engine-access.css'

const names = { openclaw: 'OpenClaw', hermes: 'Hermes Agent', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode', pi: 'Pi' }
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const text = (key, values) => t('platform.engineAccess.' + key, values)

export function createPlatformEngineAccessCard() {
  const element = document.createElement('section')
  element.className = 'card platform-section platform-engine-access'
  element.dataset.platformEngineAccess = ''
  let rows = [], catalogs = new Map(), models = [], selected = '', busy = false, notice = '', disposed = false, revision = 0
  let identity = JSON.stringify(engineAccessIdentity())
  const results = new Map()
  const rowFor = engine => rows.find(row => row.engine === engine)
  const usable = row => row?.installed === true && row.available === true
  const ownConnection = row => row?.connected === true && sameEngineAccessIdentity(row)
  const configurable = row => usable(row) && !['pending', 'configChanged'].includes(results.get(row.engine)) && !(row.connected && !sameEngineAccessIdentity(row)) && (row.engine !== 'openclaw' || row.gatewayOwn && row.canConfigure !== false && !row.pendingRecovery && !!row.configSha256 && (!row.enabled || ownConnection(row)))
  // OpenClaw 必须取原 Gateway 的公开状态，不能把独立运行时登记当成已配置。
  function applyGateway(value) {
    const row = rowFor('openclaw')
    if (!row) return
    const own = sameEngineAccessIdentity(value), configured = own && value?.enabled === true && typeof value.agentId === 'string' && !!value.agentId && typeof value.modelId === 'string' && !!value.modelId
    Object.assign(row, {
      gatewayOwn: own, gatewayKnown: !!value, available: row.installed === true && own && value?.supported !== false,
      connected: configured, running: typeof value?.gatewayRunning === 'boolean' ? value.gatewayRunning : null,
      epoch: own ? value.epoch : null, memberId: own ? value.memberId : null,
      enabled: value?.enabled === true, agentId: configured ? value.agentId : null, modelId: configured ? value.modelId : null,
      canConfigure: value?.canConfigure, configSha256: typeof value?.configSha256 === 'string' ? value.configSha256 : '',
      attached: value?.attached === true, restartRequired: value?.restartRequired === true, pendingRecovery: value?.pendingRecovery === true,
    })
  }
  const ready = row => ownConnection(row) && (row.engine !== 'openclaw' || row.attached && !row.restartRequired && !row.pendingRecovery && row.running === true)
  function configuration(row) {
    if (!row || row.engine === 'openclaw' && !row.gatewayKnown) return ['unknown', 'unknown']
    if (row.engine === 'openclaw' && !row.gatewayOwn || row.connected && !sameEngineAccessIdentity(row)) return ['foreign', 'refreshRequired']
    return ownConnection(row) ? ['configured', 'configured'] : ['notConfigured', 'notConfigured']
  }
  function detailFor(row, state) {
    if (results.has(row?.engine) && !['connected', 'running'].includes(state)) return text(state)
    if (row && !row.installed) return text('installHint')
    if (row?.engine === 'openclaw') {
      if (!row.gatewayKnown) return text('gatewayUnavailable')
      if (!row.gatewayOwn) return text('refreshRequired')
      if (row.pendingRecovery) return text('pending')
      if (row.restartRequired) return text('restartRequired')
      if (row.enabled && !ownConnection(row)) return text('gatewayIncomplete')
      if (ownConnection(row) && !row.attached && row.running) return text('gatewayConnectRequired')
    }
    return row?.connected && !ownConnection(row) ? text('refreshRequired') : row && !row.available ? text('unavailable') : ''
  }
  function stateFor(row) {
    if (!row) return 'unknown'
    if (!row.installed) return 'notInstalled'
    if (row.engine === 'openclaw') {
      if (!row.gatewayKnown) return 'unknown'
      if (!row.gatewayOwn) return 'refreshRequired'
      if (row.pendingRecovery) return 'pending'
      if (row.restartRequired) return 'restartRequired'
    }
    if (!row.available) return 'unavailable'
    if (results.has(row.engine)) return results.get(row.engine)
    return ownConnection(row) ? row.running ? 'running' : 'connected' : row.connected ? 'refreshRequired' : 'installed'
  }
  function draw() {
    if (disposed) return
    const bound = isTauriRuntime() && !!engineAccessIdentity(), current = getActiveEngineId()
    const focused = element.contains(document.activeElement) ? document.activeElement : null
    const focus = focused?.matches('[data-platform-access-model]') ? '[data-platform-access-model]' : focused?.dataset.platformAccessAction ? `[data-platform-access-action="${focused.dataset.platformAccessAction}"]${focused.dataset.platformAccessEngine ? `[data-platform-access-engine="${focused.dataset.platformAccessEngine}"]` : ''}` : ''
    const model = models.find(model => model.id === selected)
    const fact = (kind, state, key) => `<div class="platform-engine-access-fact"><dt>${esc(text(kind + 'Label'))}</dt><dd data-platform-engine-${kind} data-state="${state}">${esc(text(key))}</dd></div>`
    element.setAttribute('aria-busy', String(busy))
    element.innerHTML = `<div class="platform-engine-access-heading"><div><h3>${esc(text('title'))}</h3><p class="form-hint">${esc(text(!isTauriRuntime() ? 'desktopOnly' : !bound ? 'bindFirst' : 'intro'))}</p></div>${bound ? `<button type="button" class="btn btn-secondary btn-sm" data-platform-access-action="refresh" ${busy ? 'disabled' : ''}>${esc(text('refresh'))}</button>` : ''}</div>
      ${bound ? `<div class="platform-engine-access-controls"><div class="platform-engine-access-model-field">${models.length ? `<label for="platform-official-engine-model">${esc(text('modelLabel'))}</label><select id="platform-official-engine-model" class="form-input" data-platform-access-model aria-label="${esc(text('modelLabel'))}" ${busy ? 'disabled' : ''}><option value="">${esc(t('platform.selectModel'))}</option>${models.map(model => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.display_name || model.id)}${model.textOnly || model.toolsAvailable === false ? ' · ' + esc(text('textLabel')) : ''}</option>`).join('')}</select>` : `<span class="platform-engine-access-model-label">${esc(text('modelLabel'))}</span><button type="button" class="btn btn-secondary platform-engine-access-model-trigger" data-platform-access-action="models" ${busy || !rows.some(usable) ? 'disabled' : ''}>${esc(text('chooseModelAction'))}</button>`}</div><div class="platform-engine-access-actions"><button type="button" class="btn btn-primary btn-sm" data-platform-access-action="current" ${busy || !selected || !configurable(rowFor(current)) ? 'disabled' : ''}>${esc(text('connectCurrent'))}</button><button type="button" class="btn btn-secondary btn-sm" data-platform-access-action="installed" ${busy || !selected || !rows.some(configurable) ? 'disabled' : ''}>${esc(text('connectInstalled'))}</button></div></div>
      <p class="form-hint platform-engine-access-model-hint" data-platform-access-tools>${esc(model ? text(model.textOnly || model.toolsAvailable === false ? 'textOnly' : 'toolsAvailable') : text(rows.some(usable) ? 'chooseModel' : busy ? 'working' : 'noInstalled'))}</p>
      <ul class="platform-engine-access-list">${OFFICIAL_ENGINES.map(engine => { const row = rowFor(engine), state = stateFor(row), own = ownConnection(row), detail = detailFor(row, state), config = configuration(row); return `<li data-platform-engine-row="${engine}" data-platform-engine-state="${state}" data-platform-engine-ready="${!!ready(row)}"><div class="platform-engine-access-name"><strong>${names[engine]}</strong>${engine === current ? `<span class="platform-engine-access-current">${esc(text('currentEngine'))}</span>` : ''}${detail ? `<p class="form-hint" data-platform-engine-result>${esc(detail)}</p>` : ''}</div><dl class="platform-engine-access-facts">${fact('installation', !row ? 'unknown' : row.installed ? 'installed' : 'notInstalled', !row ? 'unknown' : row.installed ? 'installationReady' : 'notInstalled')}${fact('configuration', ...config)}${fact('runtime', !row || typeof row.running !== 'boolean' ? 'unknown' : row.running ? 'running' : 'stopped', !row || typeof row.running !== 'boolean' ? 'unknown' : row.running ? 'running' : 'stopped')}</dl><div class="platform-engine-access-row-actions"><button type="button" class="btn btn-secondary btn-sm" data-platform-access-action="configure" data-platform-access-engine="${engine}" ${busy || !selected || !configurable(row) || catalogs.has(engine) && !catalogs.get(engine).some(model => model.id === selected) ? 'disabled' : ''}>${esc(text('configureOne'))}</button>${own ? `<button type="button" class="btn btn-secondary btn-sm" data-platform-access-action="open" data-platform-access-engine="${engine}" ${busy ? 'disabled' : ''}>${esc(text('open'))}</button>` : ''}</div></li>` }).join('')}</ul>
      <p class="form-hint platform-engine-access-result" data-platform-access-result role="status">${esc(notice || text(busy ? 'working' : 'preserve'))}</p>
      <div class="platform-engine-access-gateway"><button type="button" class="platform-text-button" data-platform-access-action="gateway">${esc(text('gateway'))}</button><span class="form-hint">${esc(text('gatewayHint'))}</span></div>` : ''}`
    const restore = focus && (element.querySelector(focus) || focused?.dataset.platformAccessAction === 'models' && element.querySelector('[data-platform-access-model]'))
    if (restore && !restore.disabled) restore.focus({ preventScroll: true })
  }
  async function inventory() {
    const expected = engineAccessIdentity(), version = ++revision
    rows = []; catalogs.clear(); models = []; selected = ''; results.clear(); notice = ''
    if (!isTauriRuntime() || !expected) { busy = false; draw(); return }
    busy = true; draw()
    try {
      const value = await api.officialEngineAccess('inventory', { expected })
      if (disposed || version !== revision || !sameEngineAccessIdentity(expected) || !sameEngineAccessIdentity(value)) return
      rows = (value.engines || []).filter(row => OFFICIAL_ENGINES.includes(row.engine))
      try {
        const gateway = await api.openclawGatewayOfficial('status', {})
        if (disposed || version !== revision || !sameEngineAccessIdentity(expected)) return
        applyGateway(gateway)
      } catch { if (version === revision && sameEngineAccessIdentity(expected)) applyGateway(null) }
    } catch { if (version === revision) notice = text('readFailed') }
    finally { if (!disposed && version === revision) { busy = false; draw() } }
  }
  async function readCatalogs(targets, expected, current) {
    for (const row of targets) {
      if (!current()) return false
      try {
        const catalog = row.engine === 'openclaw' ? await api.openclawGatewayOfficial('catalog', { expected }) : await api.officialEngineAccess('catalog', { engine: row.engine, expected })
        if (!current() || !sameEngineAccessIdentity(catalog)) return false
        if (row.engine === 'openclaw') applyGateway(catalog)
        const allowed = Array.isArray(catalog.models) ? catalog.models.filter(model => typeof model?.id === 'string') : []
        catalogs.set(row.engine, allowed)
        if (!allowed.length) results.set(row.engine, 'noModels')
      } catch { if (!current()) return false; results.set(row.engine, 'failed'); catalogs.set(row.engine, []) }
    }
    const union = new Map()
    for (const list of catalogs.values()) for (const model of list) union.set(model.id, model)
    models = [...union.values()]
    return true
  }
  async function chooseModels() {
    if (busy) return
    const expected = engineAccessIdentity(), version = revision
    if (!expected) return
    busy = true; notice = ''; draw()
    const current = () => !disposed && version === revision && sameEngineAccessIdentity(expected)
    try {
      if (!await readCatalogs(rows.filter(usable), expected, current)) return
      if (!models.some(model => model.id === selected)) selected = models.length === 1 ? models[0].id : ''
      notice = text(models.length ? 'chooseModel' : rows.some(row => results.get(row.engine) === 'failed') ? 'readFailed' : 'noModels')
    } finally { if (current()) { busy = false; draw() } }
  }
  async function connect(mode, engine) {
    if (busy || !selected) return
    const expected = engineAccessIdentity(), version = revision
    if (!expected) return
    const targets = rows.filter(row => configurable(row) && (mode === 'installed' || row.engine === (engine || getActiveEngineId())))
    if (!targets.length) return
    busy = true; notice = ''; draw()
    const current = () => !disposed && version === revision && sameEngineAccessIdentity(expected)
    try {
      // 每次明确配置前重新核对该内核的当前权限，不能用旧候选列表替代服务端判定。
      if (!await readCatalogs(targets, expected, current)) return
      for (const row of targets) {
        if (!current()) return
        if (!catalogs.get(row.engine)?.some(model => model.id === selected)) { if (!results.has(row.engine)) results.set(row.engine, 'modelUnavailable'); continue }
        if (row.engine === 'openclaw') {
          try {
            const gateway = await api.openclawGatewayOfficial('status', {})
            if (!current()) return
            applyGateway(gateway)
            if (!configurable(row)) { results.set(row.engine, row.pendingRecovery ? 'pending' : 'refreshRequired'); continue }
            if (row.enabled) { results.set(row.engine, row.modelId === selected ? row.restartRequired ? 'restartRequired' : row.running ? 'running' : 'connected' : 'modelConflict'); continue }
            results.set(row.engine, 'connecting'); draw()
            const value = await api.openclawGatewayOfficial('enable', { modelId: selected, expected, expectedConfigSha256: row.configSha256 })
            if (!current()) return
            applyGateway(value)
            results.set(row.engine, ownConnection(row) && row.modelId === selected ? row.restartRequired ? 'restartRequired' : 'connected' : 'failed')
          } catch (error) {
            if (!current()) return
            const code = String(error?.message || error)
            results.set(row.engine, /config_changed/.test(code) ? 'configChanged' : /recovery_required|outcome_unknown|request_pending/.test(code) ? 'pending' : 'failed')
          }
          continue
        }
        if (row.connected && row.modelId === selected && sameEngineAccessIdentity(row)) { results.set(row.engine, row.running ? 'running' : 'connected'); continue }
        if (row.running || row.connected && row.modelId !== selected) { results.set(row.engine, 'modelConflict'); continue }
        results.set(row.engine, 'connecting'); draw()
        try {
          const value = await api.officialEngineAccess('connect', { engine: row.engine, modelId: selected, expected })
          if (!current()) return
          if (!sameEngineAccessIdentity(value) || value.engine !== row.engine || value.modelId !== selected || value.connected !== true) { results.set(row.engine, 'failed'); continue }
          Object.assign(row, value); results.set(row.engine, 'connected')
        } catch (error) { if (!current()) return; const code = typeof error === 'string' ? error : error?.message || ''; results.set(row.engine, /recovery_required|outcome_unknown|request_pending/.test(code) ? 'pending' : 'failed') }
      }
      if (current()) notice = text('results')
    } finally { if (current()) { busy = false; draw() } }
  }
  element.addEventListener('change', event => {
    if (!event.target.matches('[data-platform-access-model]')) return
    selected = event.target.value
    draw()
  })
  element.addEventListener('click', async event => {
    const target = event.target.closest('[data-platform-access-action]')
    if (!target || target.disabled || busy) return
    const action = target.dataset.platformAccessAction
    if (action === 'models') return chooseModels()
    if (action === 'current' || action === 'installed' || action === 'configure') return connect(action, target.dataset.platformAccessEngine)
    if (action === 'refresh') return inventory()
    if (action === 'gateway') { await activateEngine('openclaw', false); navigate('/models'); return }
    if (action === 'open') {
      const row = rowFor(target.dataset.platformAccessEngine), expected = engineAccessIdentity(), version = revision
      try { await openConnectedEngine(row.engine, row, models.find(model => model.id === row.modelId)) }
      catch { if (version === revision && sameEngineAccessIdentity(expected)) { notice = text('openFailed'); draw() } }
    }
  })
  const offAccount = onPlatformAccountChange(() => {
    const next = JSON.stringify(engineAccessIdentity())
    if (next !== identity) { identity = next; void inventory() }
  })
  const offLang = onLangChange(draw)
  draw(); void inventory()
  return { element, destroy() { disposed = true; revision++; offAccount(); offLang() } }
}
