import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPENCODE_CONFIG_SCHEMA,
  buildOpenCodeUpdateInfo,
  buildOpenCodeProvider,
  compareOpenCodeVersions,
  mergeOpenCodeProviderConfig,
  openCodeCredentialFileName,
  openCodeProviderKey,
  openCodeSyncSupported,
  normalizeOpenCodeVersion,
  readOpenCodeSummary,
} from '../scripts/opencode.js'

const channel = {
  id: 'lm-studio-main',
  name: 'LM Studio 本地',
  baseUrl: 'http://127.0.0.1:1234/v1/',
  apiType: 'openai-completions',
  defaultModel: 'qwen-local',
  models: [
    { id: 'qwen-local', name: 'Qwen Local', contextWindow: 131072, maxTokens: 16384 },
    { id: 'vision-local', contextTokens: 65536 },
  ],
}

test('模型渠道转换为隔离 Provider，并保留可编辑上下文与输出容量', () => {
  const id = openCodeProviderKey(channel)
  assert.equal(id, 'clawpanel-lm-studio-main')
  assert.equal(openCodeCredentialFileName(id), 'clawpanel-lm-studio-main.key')
  assert.deepEqual(buildOpenCodeProvider(channel, 'C:/private/lm.key'), {
    npm: '@ai-sdk/openai-compatible',
    name: 'LM Studio 本地',
    options: {
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '{file:C:/private/lm.key}',
    },
    models: {
      'qwen-local': { name: 'Qwen Local', limit: { context: 131072, output: 16384 } },
      'vision-local': { limit: { context: 65536 } },
    },
  })
})

test('配置合并只替换目标 Provider，并保留用户手工字段', () => {
  const current = {
    theme: 'system',
    plugin: ['manual-plugin'],
    provider: {
      manual: { npm: '@ai-sdk/openai-compatible', models: { keep: {} } },
      'clawpanel-lm-studio-main': { old: true },
    },
  }
  const result = mergeOpenCodeProviderConfig(current, {
    channel,
    credentialPath: '/private/lm.key',
    setDefault: true,
  })
  assert.equal(result.config.$schema, OPENCODE_CONFIG_SCHEMA)
  assert.equal(result.config.autoupdate, false)
  assert.deepEqual(result.config.plugin, ['manual-plugin'])
  assert.deepEqual(result.config.provider.manual, current.provider.manual)
  assert.equal(result.config.model, 'clawpanel-lm-studio-main/qwen-local')
  assert.equal(result.modelCount, 2)
})

test('默认模型不存在时回退首个模型，摘要不包含凭据内容', () => {
  const result = mergeOpenCodeProviderConfig({}, {
    channel: { ...channel, defaultModel: 'missing' },
    credentialPath: '/private/lm.key',
    setDefault: true,
  })
  assert.equal(result.defaultModel, 'qwen-local')
  const summary = readOpenCodeSummary(result.config)
  assert.deepEqual(summary.configuredProviders, ['clawpanel-lm-studio-main'])
  assert.deepEqual(summary.managedProviders, ['clawpanel-lm-studio-main'])
  assert.equal(summary.modelCount, 2)
  assert.equal(summary.defaultModel, 'clawpanel-lm-studio-main/qwen-local')
  assert.doesNotMatch(JSON.stringify(summary), /private|apiKey/i)
})

test('支持的协议明确映射，SecretRef 与非法凭据路径被拒绝', () => {
  for (const apiType of ['openai-completions', 'openai-responses', 'anthropic-messages', 'ollama']) {
    assert.equal(openCodeSyncSupported({ apiType }), true)
  }
  assert.equal(openCodeSyncSupported({ apiType: 'google-generative-ai' }), false)
  assert.equal(openCodeSyncSupported({ apiType: 'openai-completions', apiKeyRef: { source: 'env', id: 'KEY' } }), false)
  assert.throws(() => buildOpenCodeProvider(channel, '/tmp/{bad}.key'), /凭据文件路径无效/)
  assert.throws(() => openCodeCredentialFileName('../bad'), /Provider ID 无效/)
})

test('在线更新版本号严格校验并按 SemVer 判断', () => {
  assert.equal(normalizeOpenCodeVersion('1.18.21'), '1.18.21')
  assert.equal(normalizeOpenCodeVersion('1.19.0-beta.2'), '1.19.0-beta.2')
  assert.equal(normalizeOpenCodeVersion('latest'), '')
  assert.equal(normalizeOpenCodeVersion('1.2.3 && bad'), '')
  assert.equal(compareOpenCodeVersions('1.19.0', '1.18.21'), 1)
  assert.equal(compareOpenCodeVersions('1.19.0-beta.2', '1.19.0'), -1)
  assert.equal(compareOpenCodeVersions('1.18.21', '1.18.21'), 0)
  assert.deepEqual(buildOpenCodeUpdateInfo('1.18.21', '1.19.0', { registry: 'https://registry.npmjs.org/' }), {
    currentVersion: '1.18.21',
    latestVersion: '1.19.0',
    updateAvailable: true,
    registry: 'https://registry.npmjs.org/',
  })
})
