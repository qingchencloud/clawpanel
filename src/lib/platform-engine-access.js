/** 一次性的官方工作台打开意图；只存公开元数据，不持久化能力地址或凭据。 */
import { api } from './tauri-api.js'
import { getPlatformAccount, onPlatformAccountChange } from './platform-account.js'
import { activateEngine } from './engine-manager.js'
import { navigate } from '../router.js'
import { gatewayOfficialStatus, newGatewayOfficialChat } from './openclaw-official-provider.js'

export const OFFICIAL_ENGINES = ['openclaw', 'hermes', 'deepseek-harness', 'opencode', 'pi']
const routes = { openclaw: '/chat', hermes: '/h/chat', 'deepseek-harness': '/dsh/workspace', opencode: '/opencode/workspace', pi: '/pi/workspace' }
const intents = new Map()
export function engineAccessIdentity() {
  const account = getPlatformAccount()
  return account.phase === 'bound' && account.member?.member_id ? { epoch: account.epoch, memberId: account.member.member_id } : null
}
export function sameEngineAccessIdentity(expected) {
  const current = engineAccessIdentity()
  return !!expected && !!current && expected.epoch === current.epoch && expected.memberId === current.memberId
}
let identity = JSON.stringify(engineAccessIdentity())
onPlatformAccountChange(() => {
  const next = JSON.stringify(engineAccessIdentity())
  if (next !== identity) { identity = next; intents.clear() }
})

export async function openConnectedEngine(engine, connection, model) {
  const expected = engineAccessIdentity()
  if (!OFFICIAL_ENGINES.includes(engine) || !sameEngineAccessIdentity(connection) || connection.connected !== true || !expected) throw Error('platform_account_changed')
  if (engine === 'openclaw') {
    // OpenClaw 复用原 Gateway 专属 Agent，普通通道连接不代表 Gateway 已配置或运行。
    await activateEngine(engine, false)
    let status = null
    try { status = await gatewayOfficialStatus() } catch {}
    if (!sameEngineAccessIdentity(expected)) throw Error('platform_account_changed')
    const route = status?.modelId === connection.modelId ? newGatewayOfficialChat(status) : ''
    navigate(route || '/models?official=1')
    return
  }
  const nonce = crypto.randomUUID()
  const entry = { engine, expected, model: { id: connection.modelId, display_name: model?.display_name || connection.modelId, textOnly: model?.textOnly === true || connection.textOnly === true, toolsAvailable: model?.toolsAvailable ?? connection.toolsAvailable }, createdAt: Date.now() }
  intents.set(nonce, entry)
  await activateEngine(engine, false)
  if (!sameEngineAccessIdentity(expected)) { intents.delete(nonce); throw Error('platform_account_changed') }
  navigate(routes[engine] + '?' + new URLSearchParams({ accountOfficial: nonce }))
}

export function consumeOfficialEngineIntent(engine) {
  const query = location.hash.split('?')[1] || ''
  const nonce = new URLSearchParams(query).get('accountOfficial')
  if (!nonce) return null
  const entry = intents.get(nonce)
  intents.delete(nonce)
  if (!entry || entry.engine !== engine || Date.now() - entry.createdAt > 60000 || !sameEngineAccessIdentity(entry.expected)) return { invalid: true }
  return entry
}

export async function adoptOfficialEngineIntent(engine, entry) {
  if (!entry || entry.invalid || entry.engine !== engine || !sameEngineAccessIdentity(entry.expected)) throw Error('platform_account_changed')
  const result = await api.officialEngineAccess('open', { engine, modelId: entry.model.id, expected: entry.expected, newSession: true })
  if (!sameEngineAccessIdentity(entry.expected) || !sameEngineAccessIdentity(result) || result.engine !== engine || result.newSession !== true || result.modelId !== entry.model.id) throw Error('platform_account_changed')
  return result
}
