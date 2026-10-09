import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPiProvider, mergePiConfig, piProviderId, piVersion, piNodeSupported, PI_API_TYPES } from '../scripts/pi-models.js'

const channel = (extra = {}) => ({ id: 'channel-one', baseUrl: 'http://localhost:1234/v1', apiType: 'openai-completions', apiKey: 'fixture-key', models: [{ id: 'model', contextWindow: 65536, maxTokens: 8192 }], defaultModel: 'model', ...extra })

test('Pi 支持协议转换与 Ollama v1 地址，Provider ID 稳定且不使用显示名称', () => {
  for (const apiType of PI_API_TYPES) {
    const result = buildPiProvider(channel({ apiType }))
    assert.equal(result.provider.api, apiType === 'ollama' ? 'openai-completions' : apiType)
  }
  assert.equal(buildPiProvider(channel({ apiType: 'ollama', baseUrl: 'http://localhost:11434/api' })).provider.baseUrl, 'http://localhost:11434/v1')
  assert.equal(piProviderId(channel()), piProviderId(channel({ name: 'Renamed' })))
})

test('Pi 上下文、输出和视觉/推理元数据正确，不强制 50000', () => {
  const result = buildPiProvider(channel({ models: [{ id: 'model', contextTokens: 131072, maxTokens: 4096, input: ['text', 'image'], reasoning: true }] }))
  assert.deepEqual(result.provider.models[0], { id: 'model', name: 'model', contextWindow: 131072, maxTokens: 4096, input: ['text', 'image'], reasoning: true })
  assert.equal(buildPiProvider(channel({ models: [{ id: 'model' }] })).provider.models[0].contextWindow, undefined)
})

test('Pi 配置转换不把密钥或命令型密钥写进 models.json，保留用户配置', () => {
  const raw = channel({ apiKey: '!echo command-key' })
  const result = mergePiConfig({ providers: { existing: { models: [] } }, extra: 'kept' }, { theme: 'dark' }, raw, true)
  assert.ok(result.models.providers.existing)
  assert.equal(result.settings.theme, 'dark')
  assert.equal(result.settings.defaultProvider, result.providerId)
  assert.equal(result.settings.defaultModel, 'model')
  assert.match(result.provider.apiKey, /^\$\{CLAWPANEL_PI_KEY_/)
  assert.ok(!JSON.stringify(result).includes(raw.apiKey))
})

test('Pi 拒绝非法地址、空模型、重复模型、SecretRef 与错误上限', () => {
  for (const override of [
    { baseUrl: 'file:///tmp/test' }, { baseUrl: 'https://name:password@example.com/v1' }, { baseUrl: 'https://example.com/v1?token=fixture' },
    { models: [] }, { models: [{ id: 'model' }, { id: 'model' }] }, { models: [{ id: 'model', contextWindow: 20, maxTokens: 40 }] },
    { apiKeyRef: { source: 'env', id: 'KEY' } }, { apiType: 'unknown' }, { defaultModel: 'not-in-list' },
  ]) assert.throws(() => buildPiProvider(channel(override)))
})

test('Pi 版本参数限制正式 SemVer，Node 最低 22.19', () => {
  assert.equal(piVersion('1.1.0'), '1.1.0')
  for (const value of ['latest', '1.2.0-rc.1', '1.1.0;command', '../runtime']) assert.throws(() => piVersion(value))
  assert.equal(piNodeSupported('22.18.9'), false)
  assert.equal(piNodeSupported('22.19.0'), true)
  assert.equal(piNodeSupported('24.15.0'), true)
})
