/**
 * 统一模型渠道 — 共享逻辑
 *
 * 渠道是唯一维护入口（Base URL + API Key + 模型列表），通过显式同步推送到
 * OpenClaw / Hermes / DeepSeek Harness / OpenCode / 晴辰助手。同步全部组合现有 API 完成：
 * - OpenClaw：read/write_openclaw_config（后端自带备份，合并保留未知字段）
 * - Hermes：hermes_sync_provider（事务更新 .env + config.yaml）
 * - DeepSeek Harness：dsh_sync_provider（后端读取渠道密钥并通过回环 RPC 回读核对）
 * - OpenCode：opencode_sync_provider（后端写独立凭据文件和 opencode.json 并回读核对）
 * - 助手：一次性拷贝到 localStorage（clawpanel-assistant）
 * 本模块自身不直接写任何引擎配置文件。
 */
import { api, isTauriRuntime } from './tauri-api.js'
import { normalizeModelApiType } from './model-presets.js'

export const ASSISTANT_STORAGE_KEY = 'clawpanel-assistant'
export const DSH_PORT_STORAGE_KEY = 'clawpanel-dsh-port'
export const OPENCODE_PORT_STORAGE_KEY = 'clawpanel-opencode-port'

/**
 * 渠道 apiType → Hermes 回退 provider id（已按内核注册表逐一核对）：
 * - openai-completions → 'custom'（Custom OpenAI-Compatible：OPENAI_BASE_URL + OPENAI_API_KEY，
 *   覆盖官方 OpenAI、聚合网关、NewAPI、本地 Ollama 等一切 OpenAI 兼容端点）
 * - anthropic-messages → 'anthropic'（ANTHROPIC_API_KEY）
 * - google-generative-ai → 'gemini'（内核经 OpenAI 兼容端点接入 Gemini，GOOGLE_API_KEY）
 * 仅 API Key 型可同步；OAuth / 云 SDK 型仍走 Hermes 向导。
 */
export const HERMES_TARGET_MAP = {
  'openai-completions': { fallbackProvider: 'custom' },
  'anthropic-messages': { fallbackProvider: 'anthropic' },
  'google-generative-ai': { fallbackProvider: 'gemini' },
}

/** 晴辰助手支持的 apiType 族（见 assistant.js normalizeApiType） */
export const ASSISTANT_SUPPORTED_API_TYPES = [
  'openai-completions', 'anthropic-messages', 'google-generative-ai', 'ollama',
]

const DSH_SUPPORTED_API_TYPES = new Set([
  'openai-completions', 'ollama', 'openai-responses', 'anthropic-messages',
])

const OPENCODE_SUPPORTED_API_TYPES = new Set([
  'openai-completions', 'ollama', 'openai-responses', 'anthropic-messages',
])

export function hermesSyncSupported(channel) {
  return !channel?.apiKeyRef && Boolean(HERMES_TARGET_MAP[channel?.apiType])
}

export function assistantSyncSupported(channel) {
  return !channel?.apiKeyRef && ASSISTANT_SUPPORTED_API_TYPES.includes(channel?.apiType)
}

export function dshSyncSupported(channel) {
  return !channel?.apiKeyRef && DSH_SUPPORTED_API_TYPES.has(normalizeModelApiType(channel?.apiType))
}

export function openCodeSyncSupported(channel) {
  return !channel?.apiKeyRef && OPENCODE_SUPPORTED_API_TYPES.has(normalizeModelApiType(channel?.apiType))
}

export function getDshPort() {
  try {
    const port = Number(localStorage.getItem(DSH_PORT_STORAGE_KEY) || 3080)
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 3080
  } catch {
    return 3080
  }
}

export function setDshPort(port) {
  const normalized = Number(port)
  if (!Number.isInteger(normalized) || normalized < 1024 || normalized > 65535) {
    throw new Error('DeepSeek Harness 端口必须是 1024-65535 的整数')
  }
  localStorage.setItem(DSH_PORT_STORAGE_KEY, String(normalized))
  return normalized
}

export function getOpenCodePort() {
  try {
    const port = Number(localStorage.getItem(OPENCODE_PORT_STORAGE_KEY) || 4096)
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 4096
  } catch {
    return 4096
  }
}

export function setOpenCodePort(port) {
  const normalized = Number(port)
  if (!Number.isInteger(normalized) || normalized < 1024 || normalized > 65535) {
    throw new Error('OpenCode 端口必须是 1024-65535 的整数')
  }
  localStorage.setItem(OPENCODE_PORT_STORAGE_KEY, String(normalized))
  return normalized
}

/**
 * 渠道内容指纹（djb2）：基于脱敏字段计算，用于「已同步 / 有未同步变更」徽标。
 * credentialVersion 覆盖明文 Key 变更，apiKeyRef 覆盖结构化凭据引用变更。
 */
export function channelFingerprint(channel) {
  const src = JSON.stringify([
    channel?.name || '',
    channel?.baseUrl || '',
    normalizeModelApiType(channel?.apiType),
    channel?.credentialVersion || channel?.apiKeyMask || '',
    channel?.apiKeyRef || null,
    channel?.models || [],
    channel?.providerConfig || {},
    channel?.defaultModel || '',
  ])
  let hash = 5381
  for (let i = 0; i < src.length; i += 1) {
    hash = ((hash << 5) + hash + src.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

/** OpenClaw providers 键：优先预设 key，否则由名称生成 slug */
export function channelProviderKey(channel) {
  const preset = String(channel?.presetKey || '').trim()
  if (preset) return preset
  const slug = String(channel?.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `channel-${channel?.id || ''}`
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
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

async function applyOpenclawModelConfig() {
  if (isTauriRuntime()) {
    await api.reloadGateway()
    return
  }

  // Web 版没有 Tauri 的 native config reload；同步 models.json 后，
  // 运行中的 Gateway 需要完整重启才能重新加载 Agent 模型注册表。
  const running = await api.probeGatewayPort().catch(() => false)
  if (running) await api.restartGateway()
}

/**
 * 同步到 OpenClaw：只 upsert 渠道对应的 models.providers.{key}，
 * 展开旧对象保留未知字段；渠道模型为准但保留目标已有模型的测试元数据。
 */
export async function syncChannelToOpenclaw(channel, { setDefault = false } = {}) {
  const apiKeyRef = asObject(channel?.apiKeyRef)
  const apiKeyValue = Object.keys(apiKeyRef).length
    ? apiKeyRef
    : await api.revealModelChannelKey(channel.id)
  const config = asObject(await api.readOpenclawConfig())
  const providers = asObject(asObject(config.models).providers)
  const providerKey = channelProviderKey(channel)
  const existing = asObject(providers[providerKey])
  const existingModels = Array.isArray(existing.models) ? existing.models : []

  // 内核 ModelDefinitionSchema 为 strict 且 id/name 必填（zod-schema.core.ts）：
  // 恒写完整对象、name 缺省回退为 id，不写裸字符串；保留目标已有条目的
  // cost/reasoning 等扩展元数据（展开 prevObj）
  const models = (channel.models || []).map(model => {
    const prev = existingModels.find(e => (typeof e === 'string' ? e : e?.id) === model.id)
    const prevObj = prev && typeof prev === 'object' ? prev : {}
    const merged = {
      ...prevObj,
      ...model,
      id: model.id,
      name: model.name || prevObj.name || model.id,
    }
    if (model.contextWindow) merged.contextWindow = model.contextWindow
    return merged
  })

  const providerPatch = {
    ...existing,
    ...asObject(channel.providerConfig),
    baseUrl: channel.baseUrl,
    api: normalizeModelApiType(channel.apiType),
    apiKey: apiKeyValue,
    models,
  }

  const patch = { models: { providers: { [providerKey]: providerPatch } } }
  if (setDefault && channel.defaultModel) {
    patch.agents = { defaults: { model: { primary: `${providerKey}/${channel.defaultModel}` } } }
  }

  await api.writeOpenclawConfig(patch, { noReload: true })
  const readback = asObject(await api.readOpenclawConfig())
  const savedProvider = asObject(asObject(readback.models).providers)[providerKey]
  const expectedProvider = {
    ...asObject(channel.providerConfig),
    baseUrl: channel.baseUrl,
    api: normalizeModelApiType(channel.apiType),
    apiKey: apiKeyValue,
    models,
  }
  if (!savedProvider || !matchesSubset(expectedProvider, savedProvider)) {
    throw new Error(`OpenClaw 配置写入后回读核对失败: ${providerKey}`)
  }
  if (setDefault && channel.defaultModel) {
    const primary = readback?.agents?.defaults?.model?.primary
    if (primary !== `${providerKey}/${channel.defaultModel}`) {
      throw new Error(`OpenClaw 默认模型写入后回读核对失败: ${providerKey}/${channel.defaultModel}`)
    }
  }
  await applyOpenclawModelConfig()
  return { providerKey, modelCount: models.length, verified: true }
}

/** 解析渠道对应的 Hermes provider（API Key 型；预设命中优先，否则用核对过的回退 id），不支持返回 null */
export async function resolveHermesTarget(channel) {
  const mapping = HERMES_TARGET_MAP[channel?.apiType]
  if (!mapping) return null
  const raw = await api.hermesListProviders().catch(() => null)
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.providers) ? raw.providers : [])
  const usable = p => p
    && p.authType === 'api_key'
    && Array.isArray(p.apiKeyEnvVars) && p.apiKeyEnvVars.length > 0
  const byPreset = list.find(p => p.id === String(channel?.presetKey || '') && usable(p))
  const fallback = list.find(p => p.id === mapping.fallbackProvider && usable(p))
  return byPreset || fallback || null
}

/**
 * 同步到 Hermes：API Key 写入对应环境变量（Hermes .env），
 * OpenAI 兼容渠道的自定义 Base URL 写 baseUrlEnvVar；可选设为默认模型（config.yaml，自带备份）。
 */
export async function syncChannelToHermes(channel, { setDefault = false } = {}) {
  const target = await resolveHermesTarget(channel)
  if (!target) throw new Error('unsupported')
  const apiKey = await api.revealModelChannelKey(channel.id)
  if (!apiKey) throw new Error('no-key')

  // 仅 OpenAI 兼容渠道写自定义端点：anthropic / gemini 在 Hermes 侧走各自的
  // transport 专用端点，渠道里的原生 API 地址格式不一定一致，误写会破坏请求。
  // Provider Key/Base URL/默认模型由后端单个事务命令更新，避免通用 env
  // 编辑器拒绝受管 Key，也避免多步写入留下半同步状态。
  const targetBase = String(target.baseUrl || '').replace(/\/+$/, '')
  const baseUrlDiffers = channel.apiType === 'openai-completions'
    && Boolean(channel.baseUrl) && channel.baseUrl !== targetBase
  return api.hermesSyncProvider({
    provider: target.id,
    apiKey,
    baseUrl: baseUrlDiffers ? channel.baseUrl : '',
    model: channel.defaultModel || '',
    setDefault: Boolean(setDefault && channel.defaultModel),
  })
}

/** 同步到 DeepSeek Harness：由后端通过回环 RPC 写入并执行三源回读核对。 */
export async function syncChannelToDsh(channel, { setDefault = false, port = getDshPort() } = {}) {
  if (!dshSyncSupported(channel)) throw new Error('unsupported-dsh')
  if (!channel?.apiKeySaved) throw new Error('no-key')
  return api.dshSyncProvider({ channelId: channel.id, setDefault, port })
}

/** 同步到 OpenCode：后端写独立凭据文件和 opencode.json，并执行回读核对。 */
export async function syncChannelToOpenCode(channel, { setDefault = false } = {}) {
  if (!openCodeSyncSupported(channel)) throw new Error('unsupported-opencode')
  if (!channel?.apiKeySaved) throw new Error('no-key')
  return api.openCodeSyncProvider({ channelId: channel.id, setDefault })
}

/**
 * 同步到晴辰助手：一次性拷贝接入信息（渠道后续变更需再次同步）。
 * apiKey 由调用方 reveal 后传入，避免本模块内多次取明文。
 */
export function syncChannelToAssistant(channel, apiKey, model = '') {
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(String(apiKey || '').trim())) {
    throw new Error('环境变量引用不能直接保存到浏览器助手，请改用明文 Key 或通过后端代理')
  }
  let config = {}
  try {
    config = JSON.parse(localStorage.getItem(ASSISTANT_STORAGE_KEY) || '{}') || {}
  } catch {
    config = {}
  }
  config.baseUrl = channel.baseUrl
  config.apiKey = apiKey
  config.model = model || channel.defaultModel || config.model || ''
  config.apiType = channel.apiType
  localStorage.setItem(ASSISTANT_STORAGE_KEY, JSON.stringify(config))
  let readback
  try {
    readback = JSON.parse(localStorage.getItem(ASSISTANT_STORAGE_KEY) || '{}')
  } catch {
    throw new Error('助手模型配置写入后回读失败')
  }
  const verified = readback?.baseUrl === config.baseUrl
    && readback?.apiKey === config.apiKey
    && readback?.model === config.model
    && readback?.apiType === config.apiType
  if (!verified) throw new Error('助手模型配置写入后回读不一致')
  return { model: config.model, verified: true }
}

/** 从 OpenClaw 现有 providers 生成渠道（跳过已按 presetKey 存在的），用于冷启动导入 */
export async function importChannelsFromOpenclaw(existingChannels = []) {
  const config = await api.readOpenclawConfig().catch(() => null)
  const providers = asObject(asObject(config?.models).providers)
  const taken = new Set(existingChannels.map(c => c.presetKey).filter(Boolean))
  const imported = []
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object' || taken.has(key)) continue
    const models = (Array.isArray(provider.models) ? provider.models : [])
      .map(m => (typeof m === 'string'
        ? { id: m }
        : { ...m, id: String(m?.id || '').trim(), name: m?.name }))
      .filter(m => m.id)
    const { baseUrl, api: providerApi, apiKey, models: _models, ...providerConfig } = provider
    const apiKeyRef = asObject(apiKey)
    imported.push({
      id: `ch-${key}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      name: key,
      presetKey: key,
      baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
      apiType: normalizeModelApiType(providerApi),
      apiKey: typeof apiKey === 'string' ? apiKey : '',
      ...(Object.keys(apiKeyRef).length ? { apiKeyRef } : {}),
      models,
      providerConfig,
      defaultModel: '',
      enabled: true,
    })
  }
  return imported
}
