/**
 * OpenCode 受管运行时与模型配置适配器。
 *
 * 本模块只负责纯配置转换，不读取 ClawPanel 密钥，也不启动外部进程。
 * Web/Tauri 后端负责把密钥写入独立 0600 文件，并对写入结果做回读核对。
 */

export const OPENCODE_PACKAGE_NAME = 'opencode-ai'
export const OPENCODE_PACKAGE_VERSION = '1.18.21'
export const OPENCODE_DEFAULT_PORT = 4096
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json'

/** 只接受 npm 正式版本格式，避免把仓库返回值直接拼进安装参数。 */
export function normalizeOpenCodeVersion(value) {
  const version = String(value || '').trim()
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : ''
}

function parseVersion(value) {
  const version = normalizeOpenCodeVersion(value)
  if (!version) return null
  const coreAndPre = version.split('+')[0]
  const separator = coreAndPre.indexOf('-')
  const core = separator >= 0 ? coreAndPre.slice(0, separator) : coreAndPre
  const prerelease = separator >= 0 ? coreAndPre.slice(separator + 1) : ''
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  }
}

/** 足够覆盖 OpenCode npm 正式版的 SemVer 比较。 */
export function compareOpenCodeVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av === bv) continue
    const an = /^\d+$/.test(av) ? Number(av) : null
    const bn = /^\d+$/.test(bv) ? Number(bv) : null
    if (an !== null && bn !== null) return an > bn ? 1 : -1
    if (an !== null) return -1
    if (bn !== null) return 1
    return av > bv ? 1 : -1
  }
  return 0
}

export function buildOpenCodeUpdateInfo(currentVersion, latestVersion, extra = {}) {
  const current = normalizeOpenCodeVersion(currentVersion)
  const latest = normalizeOpenCodeVersion(latestVersion)
  return {
    currentVersion: current,
    latestVersion: latest,
    updateAvailable: Boolean(current && latest && compareOpenCodeVersions(latest, current) > 0),
    ...extra,
  }
}

const OPENCODE_PROVIDER_PACKAGES = {
  'openai-completions': '@ai-sdk/openai-compatible',
  ollama: '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

export function normalizeOpenCodePort(value = OPENCODE_DEFAULT_PORT) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('OpenCode 端口必须是 1024-65535 的整数')
  }
  return port
}

export function openCodePackageForApiType(apiType) {
  return OPENCODE_PROVIDER_PACKAGES[String(apiType || '').trim()] || null
}

export function openCodeSyncSupported(channel) {
  return !channel?.apiKeyRef && Boolean(openCodePackageForApiType(channel?.apiType))
}

/** 生成稳定且不会覆盖内置 Provider 的 ID。 */
export function openCodeProviderKey(channel) {
  const source = String(channel?.id || channel?.presetKey || channel?.name || 'model')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const suffix = (source || 'model').slice(0, 52).replace(/-+$/g, '') || 'model'
  return `clawpanel-${suffix}`
}

export function openCodeCredentialFileName(provider) {
  const normalized = String(provider || '').trim()
  if (!/^clawpanel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`OpenCode Provider ID 无效: ${normalized || '-'}`)
  }
  return `${normalized}.key`
}

function normalizeCredentialPath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/')
  if (!path || /[\r\n{}]/.test(path)) throw new Error('OpenCode 凭据文件路径无效')
  return path
}

/** 把 ClawPanel 模型渠道转换为 OpenCode Provider。 */
export function buildOpenCodeProvider(channel, credentialPath, provider = openCodeProviderKey(channel)) {
  const npm = openCodePackageForApiType(channel?.apiType)
  if (!npm) throw new Error(`OpenCode 暂不支持该 API 类型: ${channel?.apiType || '-'}`)
  const baseURL = String(channel?.baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseURL)) throw new Error('OpenCode Base URL 必须以 http:// 或 https:// 开头')

  const models = {}
  for (const raw of Array.isArray(channel?.models) ? channel.models : []) {
    const model = typeof raw === 'string' ? { id: raw } : asObject(raw)
    const id = String(model.id || '').trim()
    if (!id || models[id]) continue
    const next = {}
    const name = String(model.name || '').trim()
    if (name) next.name = name
    const context = positiveInteger(model.contextWindow || model.contextTokens)
    const output = positiveInteger(model.maxTokens)
    if (context || output) next.limit = {
      ...(context ? { context } : {}),
      ...(output ? { output } : {}),
    }
    models[id] = next
  }
  if (!Object.keys(models).length) throw new Error('OpenCode 至少需要一个模型')

  return {
    npm,
    name: String(channel?.name || provider).trim() || provider,
    options: {
      baseURL,
      apiKey: `{file:${normalizeCredentialPath(credentialPath)}}`,
    },
    models,
  }
}

/** 合并受管 Provider，保留用户手工配置和其他 Provider。 */
export function mergeOpenCodeProviderConfig(current, {
  channel,
  credentialPath,
  setDefault = false,
} = {}) {
  const providerId = openCodeProviderKey(channel)
  const provider = buildOpenCodeProvider(channel, credentialPath, providerId)
  const firstModel = Object.keys(provider.models)[0] || ''
  const requestedDefault = String(channel?.defaultModel || '').trim()
  const defaultModel = provider.models[requestedDefault] ? requestedDefault : firstModel
  const existing = asObject(current)
  const next = {
    ...existing,
    $schema: existing.$schema || OPENCODE_CONFIG_SCHEMA,
    autoupdate: false,
    provider: {
      ...asObject(existing.provider),
      [providerId]: provider,
    },
  }
  if (setDefault && defaultModel) next.model = `${providerId}/${defaultModel}`
  return { config: next, providerId, defaultModel, modelCount: Object.keys(provider.models).length }
}

/** 返回不包含凭据内容的配置摘要。 */
export function readOpenCodeSummary(config) {
  const value = asObject(config)
  const providers = asObject(value.provider)
  const configuredProviders = Object.keys(providers)
  const managedProviders = configuredProviders.filter(id => id.startsWith('clawpanel-'))
  const modelCount = configuredProviders.reduce((sum, id) => {
    return sum + Object.keys(asObject(asObject(providers[id]).models)).length
  }, 0)
  return {
    configuredProviders,
    managedProviders,
    defaultModel: String(value.model || ''),
    modelCount,
  }
}
