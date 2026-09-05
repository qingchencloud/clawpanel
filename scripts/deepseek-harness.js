/**
 * DeepSeek Harness 回环 RPC 与模型配置适配器。
 *
 * Harness 的配置面只监听本机回环地址；浏览器永远通过已认证的 ClawPanel
 * 后端调用本模块，不直连 Harness，也不会读取凭据明文。
 */

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
export const DSH_PACKAGE_VERSION = '0.1.1-rc.2'
export const DSH_DEFAULT_PORT = 3080
export const DSH_SETTINGS_NAMESPACE = 'llm-pi-ai'
export const DSH_DEFAULT_MODEL_NAMESPACE = 'agent-default-model'

const DSH_PROTOCOL_MAP = {
  'openai-completions': 'openai-completions',
  ollama: 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function matchesSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((value, index) => matchesSubset(value, actual[index]))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) => matchesSubset(value, actual[key]))
  }
  return Object.is(expected, actual)
}

export function normalizeDshPort(value = DSH_DEFAULT_PORT) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DeepSeek Harness 端口必须是 1024-65535 的整数')
  }
  return port
}

export function dshProtocolForApiType(apiType) {
  return DSH_PROTOCOL_MAP[String(apiType || '').trim()] || null
}

export function dshSyncSupported(channel) {
  return !channel?.apiKeyRef && Boolean(dshProtocolForApiType(channel?.apiType))
}

/** 生成不会覆盖 Harness 内置 route 的稳定 provider id。 */
export function dshProviderKey(channel) {
  const source = String(channel?.id || channel?.presetKey || channel?.name || 'model')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const suffix = (source || 'model').slice(0, 52).replace(/-+$/g, '') || 'model'
  return `clawpanel-${suffix}`
}

export function dshCredentialRef(provider) {
  const normalized = String(provider || '').trim()
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`DeepSeek Harness provider id 无效: ${normalized || '-'}`)
  }
  return `${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** 把 ClawPanel 渠道转换为 llm-pi-ai provider profile。 */
export function buildDshProviderProfile(channel, provider = dshProviderKey(channel)) {
  const api = dshProtocolForApiType(channel?.apiType)
  if (!api) throw new Error(`DeepSeek Harness 暂不支持该 API 类型: ${channel?.apiType || '-'}`)
  const baseURL = String(channel?.baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseURL)) throw new Error('DeepSeek Harness Base URL 必须以 http:// 或 https:// 开头')

  const models = []
  const seen = new Set()
  for (const raw of Array.isArray(channel?.models) ? channel.models : []) {
    const model = typeof raw === 'string' ? { id: raw } : asObject(raw)
    const id = String(model.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const next = { id }
    const name = String(model.name || '').trim()
    if (name) next.name = name
    const contextWindow = positiveInteger(model.contextWindow || model.contextTokens)
    const maxTokens = positiveInteger(model.maxTokens)
    if (contextWindow) next.contextWindow = contextWindow
    if (maxTokens) next.maxTokens = maxTokens
    const input = Array.isArray(model.input)
      ? [...new Set(model.input.filter(value => ['text', 'image'].includes(value)))]
      : []
    if (input.length) next.input = input
    models.push(next)
  }
  if (!models.length) throw new Error('DeepSeek Harness 至少需要一个模型')

  return {
    displayName: String(channel?.name || provider).trim() || provider,
    apiKeyEnv: dshCredentialRef(provider),
    api,
    baseURL,
    models,
  }
}

function rpcErrorMessage(method, result) {
  const error = result?.error
  return String(error?.message || error?.code || error || `${method} 调用失败`)
}

/** 调用 Harness Web carrier 的单次回环 RPC。 */
export async function dshRpc(method, payload = {}, {
  port = DSH_DEFAULT_PORT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const normalizedPort = normalizeDshPort(port)
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时缺少 fetch')
  if (!/^[a-z][a-zA-Z0-9.-]+$/.test(String(method || ''))) throw new Error('DeepSeek Harness RPC 方法名无效')
  const rpcId = `clawpanel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(`http://127.0.0.1:${normalizedPort}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`DeepSeek Harness RPC 超时: ${method}`)
    throw new Error(`DeepSeek Harness 不可达: ${error?.message || error}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { throw new Error(`DeepSeek Harness 返回非 JSON 响应: HTTP ${response.status}`) }
  if (!response.ok) throw new Error(rpcErrorMessage(method, body?.result || body))
  if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
    throw new Error(`DeepSeek Harness RPC 响应不匹配: ${method}`)
  }
  if (!body?.result?.ok) throw new Error(rpcErrorMessage(method, body?.result))
  return body.result.value
}

function namespaceOf(describe, ns) {
  return (Array.isArray(describe?.namespaces) ? describe.namespaces : []).find(item => item?.ns === ns)
}

/**
 * 写入 provider、凭据和可选默认模型，并从 settings/credentials/llm 三个事实源回读。
 * profile 先落盘，凭据随后单向写入；错误会明确指出是否发生部分提交。
 */
export async function syncDshProvider({
  channel,
  apiKey,
  setDefault = false,
  port = DSH_DEFAULT_PORT,
  rpc = dshRpc,
} = {}) {
  const providerId = dshProviderKey(channel)
  const profile = buildDshProviderProfile(channel, providerId)
  const credentialRef = profile.apiKeyEnv
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('DeepSeek Harness API Key 不能为空')
  const call = (method, payload) => rpc(method, payload, { port })

  const before = await call('settings.describe', {})
  if (before?.writable !== true) throw new Error('DeepSeek Harness 设置当前为只读')
  const llmNamespace = namespaceOf(before, DSH_SETTINGS_NAMESPACE)
  if (!llmNamespace) throw new Error(`DeepSeek Harness 缺少设置命名空间: ${DSH_SETTINGS_NAMESPACE}`)

  await call('settings.mutate', {
    ns: DSH_SETTINGS_NAMESPACE,
    ops: [{ op: 'set', path: ['providers', providerId], value: profile }],
    expectedRevision: llmNamespace.revision,
  })

  try {
    await call('credentials.set', { ref: credentialRef, value: key })
  } catch (error) {
    throw new Error(`DeepSeek Harness provider 已写入，但凭据写入失败: ${error?.message || error}`)
  }

  const defaultModel = String(channel?.defaultModel || profile.models[0]?.id || '').trim()
  if (setDefault && defaultModel) {
    const current = await call('settings.describe', {})
    const defaultNamespace = namespaceOf(current, DSH_DEFAULT_MODEL_NAMESPACE)
    if (!defaultNamespace) throw new Error(`DeepSeek Harness 缺少设置命名空间: ${DSH_DEFAULT_MODEL_NAMESPACE}`)
    await call('settings.replace', {
      ns: DSH_DEFAULT_MODEL_NAMESPACE,
      section: { provider: providerId, model: defaultModel },
      expectedRevision: defaultNamespace.revision,
    })
  }

  const [settings, credentials, providers] = await Promise.all([
    call('settings.describe', {}),
    call('credentials.describe', { refs: [credentialRef] }),
    call('llm.providers', {}),
  ])
  const savedProfile = asObject(asObject(namespaceOf(settings, DSH_SETTINGS_NAMESPACE)?.value).providers)[providerId]
  if (!savedProfile || !matchesSubset(profile, savedProfile)) {
    throw new Error(`DeepSeek Harness provider 写入后回读核对失败: ${providerId}`)
  }
  const credential = asObject(credentials?.credentials)[credentialRef]
  if (credential?.configured !== true) {
    throw new Error(`DeepSeek Harness 凭据写入后回读核对失败: ${credentialRef}`)
  }
  const providerView = (Array.isArray(providers?.providers) ? providers.providers : [])
    .find(item => item?.provider === providerId)
  if (!providerView?.active) throw new Error(`DeepSeek Harness provider 尚未激活: ${providerId}`)
  if (setDefault && defaultModel) {
    const savedDefault = asObject(namespaceOf(settings, DSH_DEFAULT_MODEL_NAMESPACE)?.value)
    if (savedDefault.provider !== providerId || savedDefault.model !== defaultModel) {
      throw new Error(`DeepSeek Harness 默认模型写入后回读核对失败: ${providerId}/${defaultModel}`)
    }
  }

  return {
    providerId,
    credentialRef,
    model: defaultModel,
    modelCount: profile.models.length,
    verified: true,
  }
}

/** 返回不含任何凭据值的 Harness 配置摘要。 */
export async function readDshSummary({ port = DSH_DEFAULT_PORT, rpc = dshRpc } = {}) {
  const call = (method, payload) => rpc(method, payload, { port })
  const [settings, providers, models] = await Promise.all([
    call('settings.describe', {}),
    call('llm.providers', {}),
    call('llm.models', {}),
  ])
  const llm = asObject(namespaceOf(settings, DSH_SETTINGS_NAMESPACE)?.value)
  const defaults = asObject(namespaceOf(settings, DSH_DEFAULT_MODEL_NAMESPACE)?.value)
  const configuredProviders = Object.keys(asObject(llm.providers))
  const activeProviders = (Array.isArray(providers?.providers) ? providers.providers : [])
    .filter(item => item?.active).map(item => item.provider)
  const modelCount = (Array.isArray(models?.groups) ? models.groups : [])
    .reduce((sum, group) => sum + (Array.isArray(group?.models) ? group.models.length : 0), 0)
  return {
    writable: settings?.writable === true,
    configuredProviders,
    activeProviders,
    defaultModel: defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}` : '',
    modelCount,
    failures: Array.isArray(models?.failures) ? models.failures.length : 0,
  }
}
