/** Pi 配置转换：纯函数，不读取或返回渠道密钥。 */
import { createHash } from 'node:crypto'

export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'
export const PI_PACKAGE_VERSION = '1.1.0'
export const PI_API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'ollama']

export function piVersion(value) {
  const version = String(value || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pi 版本必须是正式 SemVer 版本')
  return version
}

export function piNodeSupported(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 19)
}

export function piProviderId(channel) {
  if (!channel?.id) throw new Error('模型渠道 ID 为空')
  return 'clawpanel-' + createHash('sha256').update(String(channel.id)).digest('hex').slice(0, 16)
}

export function piCredentialEnv(provider) {
  return 'CLAWPANEL_PI_KEY_' + provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()
}

function positive(value, label) {
  if (value == null || value === '') return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} 必须是正整数`)
  return number
}

export function buildPiProvider(channel) {
  if (channel?.apiKeyRef || !PI_API_TYPES.includes(channel?.apiType)) throw new Error('该模型渠道协议暂不支持同步到 Pi')
  const url = new URL(String(channel.baseUrl || '').trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Pi Base URL 必须是无凭据、无查询参数的 HTTP(S) 地址')
  }
  let baseUrl = url.href.replace(/\/+$/, '')
  if (channel.apiType === 'ollama') baseUrl = baseUrl.replace(/\/(api|v1)$/, '') + '/v1'
  const providerId = piProviderId(channel)
  const models = (channel.models || []).map(model => {
    const id = String(model.id || '').trim()
    if (!id || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Pi 模型 ID 无效')
    const result = { id, name: String(model.name || id), input: ['text'] }
    if (typeof model.reasoning === 'boolean') result.reasoning = model.reasoning
    if (Array.isArray(model.input) && model.input.includes('image')) result.input.push('image')
    const contextWindow = positive(model.contextWindow ?? model.contextTokens, '上下文窗口')
    const maxTokens = positive(model.maxTokens, '输出上限')
    if (contextWindow) result.contextWindow = contextWindow
    if (maxTokens) result.maxTokens = maxTokens
    if (contextWindow && maxTokens && maxTokens > contextWindow) throw new Error('输出上限超过上下文窗口')
    return result
  })
  if (!models.length || new Set(models.map(model => model.id)).size !== models.length) throw new Error('Pi 模型列表为空或包含重复 ID')
  const defaultModel = channel.defaultModel || models[0].id
  if (!models.some(model => model.id === defaultModel)) throw new Error('Pi 默认模型不在渠道模型列表中')
  return {
    providerId, defaultModel,
    provider: { baseUrl, api: channel.apiType === 'ollama' ? 'openai-completions' : channel.apiType, apiKey: '${' + piCredentialEnv(providerId) + '}', models },
  }
}

export function mergePiConfig(models, settings, channel, setDefault) {
  const converted = buildPiProvider(channel)
  const nextModels = structuredClone(models || {})
  nextModels.providers = { ...nextModels.providers, [converted.providerId]: converted.provider }
  const nextSettings = { ...settings }
  if (setDefault) {
    nextSettings.defaultProvider = converted.providerId
    nextSettings.defaultModel = converted.defaultModel
  }
  return { ...converted, models: nextModels, settings: nextSettings }
}
