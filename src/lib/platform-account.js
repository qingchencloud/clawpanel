/** 官网账户的非秘密视图。凭据、授权交易和恢复日志均由原生层持有。 */
import { api, isTauriRuntime, safeTauriListen } from './tauri-api.js'
import { getLang, t } from './i18n.js'
export { getPlatformPublicOffer, loadPlatformPublicOffer, onPlatformPublicOfferChange } from './platform-public-offer.js'

let snapshot = { epoch: 0, phase: 'guest', member: null, pendingRequests: [], models: [] }
let initializing = null
let refreshing = null
let mutation = 0
// 原生事件可能先于对应IPC返回；旧返回不能回滚已观察到的同epoch状态。
let snapshotEventRevision = 0
let lastRefresh = 0
const refreshInterval = 5000
let returnRefreshInstallation = null
let returnActivation = 0
const listeners = new Set()
const eventListeners = new Set()
const terminal = state => ['settled', 'released'].includes(state)

export function formatCredits(value) {
  if (!/^-?\d+$/.test(String(value ?? ''))) return '—'
  const amount = BigInt(value)
  const absolute = amount < 0n ? -amount : amount
  const fraction = String(absolute % 10000n).padStart(4, '0').replace(/0+$/, '')
  return `${amount < 0n ? '-' : ''}${absolute / 10000n}${fraction ? `.${fraction}` : ''}`
}

export function displayPlanName(member = {}, lang = getLang()) {
  return member.plan_id === 'free' && member.plan_display_name === '免费用户'
    ? (lang.startsWith('zh') ? '免费用户' : 'Free users')
    : (member.plan_display_name || '—')
}

export function trialPresentation(trial) {
  const known = ['not_eligible', 'disabled', 'delivery_disabled', 'pending_delivery', 'pending_budget', 'pending_review', 'configuration_unavailable', 'issued', 'expired', 'unavailable']
  const status = known.includes(trial?.status) ? trial.status : 'unavailable'
  return { status, label: t(`platform.trial.${status}`), amount: formatCredits(trial?.amount_micro_cny), issued: status === 'issued', simulated: trial?.simulated === true }
}

export function platformErrorText(error) {
  const raw = typeof error === 'string' ? error : error?.code || error?.error?.code || error?.message || ''
  const rawCode = typeof raw === 'string' ? raw : ''
  const aliases = { platform_reauthorization_required: 'reauth_required', platform_authorization_timeout: 'connection_expired', platform_authorization_denied: 'access_denied', official_request_recovery_required: 'request_pending', official_request_id_unknown: 'outcome_unknown', platform_stream_incomplete: 'outcome_unknown', platform_stream_error: 'outcome_unknown', platform_response_incomplete: 'outcome_unknown', platform_storage_corrupt: 'storage_unavailable', platform_revocation_pending: 'revocation_pending' }
  const code = aliases[rawCode] || rawCode.replace(/^platform_/, '')
  const key = `platform.errors.${code}`
  const translated = t(key)
  // 未知错误码保留原文，便于定位“官方服务暂不可用”背后的真实原因。
  return translated === key ? (code ? `${t('platform.errors.unavailable')} (${code})` : t('platform.errors.unavailable')) : translated
}

export function getPlatformAccount() { return snapshot }
export function onPlatformAccountChange(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export function onPlatformEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) }

function applySnapshot(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.epoch) || value.epoch < snapshot.epoch) return
  if (value.epoch !== snapshot.epoch) lastRefresh = 0
  // 只接收公开字段，未知扩展不写浏览器存储或日志。
  const next = {}
  for (const key of ['epoch', 'phase', 'supported', 'debugLocalOnly', 'origin', 'member', 'entitlements', 'trial', 'wallet', 'grants', 'usage', 'models', 'binding', 'platformStatus', 'benefits', 'revocationPending', 'error', 'updatedAt', 'pendingRequests']) {
    if (key in value) next[key] = value[key]
  }
  if (value.connection && typeof value.connection === 'object') {
    const connection = {}
    for (const key of ['connection_id', 'status', 'expires_at', 'poll_interval_seconds']) {
      if (key in value.connection && ['string', 'number'].includes(typeof value.connection[key])) connection[key] = value.connection[key]
    }
    next.connection = connection
  }
  // 同一交易的旧响应或轮询可能省略初次确认码，不能抹掉仍有效的核对信息。
  const previousBinding = snapshot.binding
  const incomingBinding = next.binding
  const bindingContinues = value.epoch === snapshot.epoch && ['binding', 'reauthorizing'].includes(next.phase)
    && ['binding', 'reauthorizing'].includes(snapshot.phase)
    && previousBinding?.intent_id && Date.parse(previousBinding.expires_at) > Date.now()
    && (!incomingBinding?.intent_id || incomingBinding.intent_id === previousBinding.intent_id)
    && ['pending', 'approved'].includes(incomingBinding?.status || previousBinding.status)
  if (bindingContinues) {
    next.binding = { ...previousBinding }
    for (const [key, field] of Object.entries(incomingBinding || {})) if (field !== null && field !== undefined && field !== '') next.binding[key] = field
  }
  if (Array.isArray(next.pendingRequests)) next.pendingRequests = next.pendingRequests.map(item => {
    const request = {}
    for (const key of ['operationId', 'requestId', 'state', 'epoch', 'replyComplete', 'cancellationRequested', 'admissionRejected', 'preDispatch']) {
      if (key in item) request[key] = item[key]
    }
    return request
  })
  snapshot = { phase: 'guest', member: null, pendingRequests: [], models: [], ...next }
  for (const listener of listeners) { try { listener(snapshot) } catch {} }
}

export async function initPlatformAccount() {
  if (!isTauriRuntime()) return snapshot
  if (!initializing) initializing = (async () => {
    await safeTauriListen('platform-event', event => {
      const payload = event.payload || event
      if (!Number.isSafeInteger(payload.epoch) || payload.epoch < snapshot.epoch) return
      if (payload.type === 'snapshot') {
        if (Number.isSafeInteger(payload.data?.epoch) && payload.data.epoch >= snapshot.epoch) snapshotEventRevision++
        applySnapshot(payload.data)
      }
      for (const listener of eventListeners) { try { listener(payload) } catch {} }
    })
    const eventVersion = snapshotEventRevision
    const value = await api.platformSnapshot()
    if (eventVersion === snapshotEventRevision) applySnapshot(value)
    return snapshot
  })().catch(error => { initializing = null; throw error })
  return initializing
}

export async function restorePlatformAccount() {
  await initPlatformAccount()
  if (!isTauriRuntime()) return snapshot
  const version = mutation
  const eventVersion = snapshotEventRevision
  const value = await api.platformRestore()
  if (version === mutation && eventVersion === snapshotEventRevision) applySnapshot(value)
  return snapshot
}

export async function refreshPlatformAccount({ force = false } = {}) {
  await initPlatformAccount()
  if (!isTauriRuntime() || !['logged_in', 'binding', 'bound'].includes(snapshot.phase)) return snapshot
  if (refreshing?.epoch === snapshot.epoch) return refreshing.promise
  if (!force && Date.now() - lastRefresh < refreshInterval) return snapshot
  const version = mutation
  const eventVersion = snapshotEventRevision
  lastRefresh = Date.now()
  const flight = { epoch: snapshot.epoch, activation: returnActivation, promise: null }
  flight.promise = api.platformRefresh().then(value => {
    if (version === mutation && eventVersion === snapshotEventRevision) applySnapshot(value)
    return snapshot
  }).finally(() => { if (refreshing === flight) refreshing = null })
  refreshing = flight
  return flight.promise
}

/** 合并 DOM 与当前原生窗口的返回通知；冷却中的返回保留一次补刷。 */
export function installPlatformAccountReturnRefresh() {
  if (!isTauriRuntime()) return () => {}
  if (returnRefreshInstallation) return returnRefreshInstallation
  let disposed = false
  let timer = null
  let pendingEpoch = null
  let nativeFocused = null
  let unlistenNative = null
  let away = false
  let waitingFlight = null
  const canRefresh = () => !disposed && !document.hidden && nativeFocused !== false
    && ['logged_in', 'binding', 'bound'].includes(snapshot.phase)
  const clearPending = () => {
    clearTimeout(timer)
    timer = null
    pendingEpoch = null
    waitingFlight = null
  }
  const flush = () => {
    timer = null
    if (!canRefresh() || pendingEpoch !== snapshot.epoch) return clearPending()
    if (refreshing?.epoch === snapshot.epoch) {
      const flight = refreshing
      if (flight.activation === returnActivation) return clearPending()
      // 离开前开始的读取可能已取到旧值，等其结束后仍需补读。
      if (waitingFlight === flight) return
      waitingFlight = flight
      const resume = () => {
        if (waitingFlight !== flight) return
        waitingFlight = null
        flush()
      }
      void flight.promise.then(resume, resume)
      return
    }
    const remaining = refreshInterval - (Date.now() - lastRefresh)
    if (remaining > 0) {
      timer = setTimeout(flush, remaining)
      return
    }
    clearPending()
    void refreshPlatformAccount().catch(() => {})
  }
  const onReturn = () => {
    if (!canRefresh()) return clearPending()
    if (away) { returnActivation++; away = false }
    if (refreshing?.epoch === snapshot.epoch && refreshing.activation === returnActivation) return clearPending()
    if (timer !== null || waitingFlight) return
    pendingEpoch = snapshot.epoch
    // 给同次激活的 DOM、可见性及原生事件留出合并窗口。
    timer = setTimeout(flush, Math.max(100, refreshInterval - (Date.now() - lastRefresh)))
  }
  const onAway = () => { away = true; clearPending() }
  const onVisibility = () => { document.hidden ? onAway() : onReturn() }
  const unsubscribeAccount = onPlatformAccountChange(() => {
    if (pendingEpoch !== snapshot.epoch || !canRefresh()) clearPending()
  })
  window.addEventListener('focus', onReturn)
  window.addEventListener('blur', onAway)
  document.addEventListener('visibilitychange', onVisibility)
  // SDK 在 Window target 上监听 focus/blur；不使用 app 全局监听冒充窗口事件。
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(event => {
    if (disposed) return
    nativeFocused = event.payload === true
    nativeFocused ? onReturn() : onAway()
  })).then(unlisten => {
    if (disposed) unlisten()
    else unlistenNative = unlisten
  }).catch(() => {})
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearPending()
    window.removeEventListener('focus', onReturn)
    window.removeEventListener('blur', onAway)
    document.removeEventListener('visibilitychange', onVisibility)
    unsubscribeAccount()
    unlistenNative?.()
    if (returnRefreshInstallation === dispose) returnRefreshInstallation = null
  }
  returnRefreshInstallation = dispose
  return dispose
}

export async function platformAccountAction(action, options = {}) {
  await initPlatformAccount()
  const version = ++mutation
  const eventVersion = snapshotEventRevision
  const language = getLang().startsWith('zh') ? 'zh' : 'en'
  const actions = {
    login: () => api.platformLogin({ language, ...(options.deviceName ? { deviceName: options.deviceName } : {}) }),
    'login-cancel': () => api.platformLoginCancel(),
    bind: () => api.platformBind(options.deviceName || 'ClawPanel Desktop', { language }),
    logout: () => api.platformLogout(options.localOnly === true),
    unlink: () => api.platformUnbind(),
  }
  if (!actions[action]) throw new Error('invalid_action')
  const value = await actions[action]()
  if (version === mutation && eventVersion === snapshotEventRevision) applySnapshot(value)
  return snapshot
}

export async function openPlatformMember(section = 'account') {
  if (!isTauriRuntime()) throw new Error('desktop_required')
  return api.platformOpenMember(section === 'referrals' ? 'referrals' : 'account')
}

export function pendingPlatformRequests() {
  return (snapshot.pendingRequests || []).filter(item => !terminal(item.state))
}

export async function loadPlatformModels(modelId = '') {
  await initPlatformAccount()
  const epoch = snapshot.epoch
  const result = await api.platformModels(modelId)
  if (epoch !== snapshot.epoch) throw new Error('account_changed')
  const models = Array.isArray(result) ? result : result.data || []
  snapshot = { ...snapshot, models }
  for (const listener of listeners) { try { listener(snapshot) } catch {} }
  return models
}

export async function recoverPlatformRequest(operationId) {
  const epoch = snapshot.epoch
  let state
  try { state = await api.platformRecover(operationId) }
  finally { if (epoch === snapshot.epoch) await refreshPlatformAccount({ force: true }).catch(() => {}) }
  if (epoch !== snapshot.epoch) throw new Error('account_changed')
  return state
}

/** 一次逻辑请求只发一次。重试和 nonce 协商仅在原生边界内处理。 */
export async function sendPlatformRequest(body, { onDelta, onRequest, signal } = {}) {
  await initPlatformAccount()
  if (snapshot.phase !== 'bound') throw new Error('binding_required')
  if (pendingPlatformRequests().length) throw new Error('request_pending')
  const epoch = snapshot.epoch
  const operationId = crypto.randomUUID().replaceAll('-', '_')
  let unsubscribe
  let unsubscribeAccount
  let timer
  let complete = false
  let cancellationRequested = false
  const result = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      unsubscribe?.()
      unsubscribeAccount?.()
      signal?.removeEventListener('abort', cancel)
      error ? reject(error) : resolve(value)
    }
    const cancel = () => {
      if (cancellationRequested || complete) return
      cancellationRequested = true
      api.platformCancel(operationId).then(state => onRequest?.({ operationId, ...state, cancellationRequested: true })).catch(() => onRequest?.({ operationId, cancellationRequested: true }))
    }
    unsubscribeAccount = onPlatformAccountChange(value => {
      if (value.epoch !== epoch) finish(new Error('account_changed'))
    })
    unsubscribe = onPlatformEvent(async event => {
      if (event.epoch !== epoch || event.operationId !== operationId || complete) return
      if (event.type === 'request') onRequest?.({ operationId, requestId: event.requestId, ...event.data })
      if (event.type === 'delta') onDelta?.(event.data)
      if (event.type === 'complete' || event.type === 'error') {
        const replyComplete = event.type === 'complete' && event.data?.replyComplete !== false
        let request
        try { request = await recoverPlatformRequest(operationId) } catch {}
        if (snapshot.epoch !== epoch) return finish(new Error('account_changed'))
        onRequest?.({ operationId, ...request, replyComplete })
        if (event.type === 'error') {
          const code = request?.state === 'settled' && !replyComplete ? 'reply_incomplete' : event.data?.code || 'outcome_unknown'
          return finish(Object.assign(new Error(code), { code, request, operationId }))
        }
        if (!request || !terminal(request.state)) return finish(Object.assign(new Error('request_pending'), { request, operationId, responseData: event.data }))
        if (!replyComplete) return finish(Object.assign(new Error('reply_incomplete'), { request, operationId, responseData: event.data }))
        finish(null, { data: event.data, request, operationId })
      }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => finish(Object.assign(new Error('outcome_unknown'), { operationId })), 125000)
    api.platformSend(operationId, body).then(async accepted => {
      if (accepted?.accepted === false) {
        let request
        try { request = await recoverPlatformRequest(operationId) } catch {}
        return finish(Object.assign(new Error('request_pending'), { operationId, request }))
      }
      onRequest?.({ operationId, state: 'dispatching' })
      if (signal?.aborted) cancel()
    }).catch(error => finish(error))
  })
  return result
}
