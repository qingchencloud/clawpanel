/** 公开注册条件仅存内存；不携带账号状态或平台凭据。 */
import { api, isTauriRuntime } from './tauri-api.js'

let offer = null
let loading = null
const listeners = new Set()
const unavailable = () => ({ status: 'unavailable', registration_rewards_enabled: false, simulation: false, offer: null, server_time: null })

function normalize(value) {
  if (!value || !['offered', 'not_open', 'unavailable'].includes(value.status)
    || typeof value.registration_rewards_enabled !== 'boolean' || typeof value.simulation !== 'boolean') return unavailable()
  const result = { status: value.status, registration_rewards_enabled: value.registration_rewards_enabled, simulation: value.simulation, offer: null, server_time: typeof value.server_time === 'string' ? value.server_time : null }
  if (result.status !== 'offered' || !result.registration_rewards_enabled && !result.simulation) {
    if (result.status === 'offered') result.status = 'not_open'
    return result
  }
  const entry = value.offer
  const hasHours = entry && Object.hasOwn(entry, 'valid_hours')
  const duration = hasHours ? entry.valid_hours : entry?.valid_days
  if (!entry || typeof entry.amount_micro_cny !== 'string' || !/^\d{1,32}$/.test(entry.amount_micro_cny)
    || BigInt(entry.amount_micro_cny) > 1000000000000n
    || !Number.isSafeInteger(duration) || duration < 1 || duration > (hasHours ? 720 : 30)
    || !Array.isArray(entry.models) || entry.models.length < 1 || entry.models.length > 64
    || entry.models.some(model => !model || typeof model.id !== 'string' || !/^official\/[a-z0-9][a-z0-9_-]{0,63}$/.test(model.id)
      || typeof model.display_name !== 'string' || !model.display_name.trim() || [...model.display_name].length > 128 || /\p{Cc}/u.test(model.display_name))
    || new Set(entry.models.map(model => model.id)).size !== entry.models.length) return unavailable()
  result.offer = { amount_micro_cny: BigInt(entry.amount_micro_cny).toString(), valid_days: hasHours ? Math.ceil(duration / 24) : duration, ...(hasHours ? { valid_hours: duration } : {}), models: entry.models.map(model => ({ id: model.id, display_name: model.display_name || model.id })) }
  return result
}

export function getPlatformPublicOffer() { return offer }
export function onPlatformPublicOfferChange(listener) { listeners.add(listener); return () => listeners.delete(listener) }
function notify() { for (const listener of listeners) { try { listener(offer) } catch {} } }

export function loadPlatformPublicOffer() {
  if (loading) return loading
  // 新一轮读取先撤下旧条件，关闭或断网时不继续宣传过期面额。
  offer = null
  loading = Promise.resolve().then(() => isTauriRuntime() ? api.platformPublicBenefits() : null)
    .then(value => normalize(value?.registrationOffer), () => unavailable())
    .then(value => { offer = value; notify(); return value })
    .finally(() => { loading = null })
  notify()
  return loading
}
