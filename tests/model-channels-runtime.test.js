import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = { location: { hostname: 'localhost' } }
const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
}

const { api } = await import('../src/lib/tauri-api.js')
const channels = await import('../src/lib/model-channels.js')
const devApi = await import('../scripts/dev-api.js')

const originalApi = {
  readOpenclawConfig: api.readOpenclawConfig,
  writeOpenclawConfig: api.writeOpenclawConfig,
  revealModelChannelKey: api.revealModelChannelKey,
  probeGatewayPort: api.probeGatewayPort,
  restartGateway: api.restartGateway,
  reloadGateway: api.reloadGateway,
}

test.beforeEach(() => {
  // 运行时应用动作由专门测试覆盖；其余同步测试保持纯配置回读。
  api.probeGatewayPort = async () => false
  api.restartGateway = async () => true
  api.reloadGateway = async () => true
})

function restoreApi() {
  Object.assign(api, originalApi)
  storage.clear()
}

test.afterEach(restoreApi)

test('渠道指纹覆盖模型能力元数据和凭据版本', () => {
  const base = {
    id: 'ch-1', name: '渠道', baseUrl: 'https://example.com/v1',
    apiType: 'openai-responses', apiKeyMask: 'sk-***same', credentialVersion: 1,
    models: [{ id: 'vision', input: ['text', 'image'], reasoning: true, maxTokens: 4096 }],
    defaultModel: 'vision',
  }
  assert.notEqual(
    channels.channelFingerprint(base),
    channels.channelFingerprint({ ...base, models: [{ ...base.models[0], maxTokens: 8192 }] }),
  )
  assert.notEqual(
    channels.channelFingerprint(base),
    channels.channelFingerprint({ ...base, credentialVersion: 2 }),
  )
})

test('从 OpenClaw 导入渠道时保留完整模型能力字段', async () => {
  api.readOpenclawConfig = async () => ({
    models: {
      providers: {
        rich: {
          baseUrl: 'https://example.com/v1',
          api: 'openai-responses',
          apiKey: '${RICH_API_KEY}',
          headers: { 'x-tenant': 'tenant-a' },
          models: [{
            id: 'vision', name: 'Vision', input: ['text', 'image'], reasoning: true,
            contextWindow: 200000, contextTokens: 160000, maxTokens: 8192,
            compat: { supportsDeveloperRole: false }, cost: { input: 1, output: 2 },
          }],
        },
      },
    },
  })

  const [channel] = await channels.importChannelsFromOpenclaw([])
  assert.deepEqual(channel.models[0].input, ['text', 'image'])
  assert.equal(channel.models[0].reasoning, true)
  assert.equal(channel.models[0].contextTokens, 160000)
  assert.equal(channel.models[0].maxTokens, 8192)
  assert.deepEqual(channel.models[0].compat, { supportsDeveloperRole: false })
  assert.deepEqual(channel.models[0].cost, { input: 1, output: 2 })
  assert.deepEqual(channel.providerConfig.headers, { 'x-tenant': 'tenant-a' })
})

test('从 OpenClaw 导入和同步渠道时原样保留结构化 SecretRef', async () => {
  const secretRef = { source: 'env', provider: 'default', id: 'RICH_API_KEY' }
  let written = null
  api.readOpenclawConfig = async () => written
    ? { models: { providers: written.models.providers } }
    : ({
        models: {
          providers: {
            rich: {
              baseUrl: 'https://example.com/v1',
              api: 'openai-responses',
              apiKey: secretRef,
              models: [{ id: 'vision', name: 'Vision' }],
            },
          },
        },
      })
  api.revealModelChannelKey = async () => {
    throw new Error('SecretRef 同步 OpenClaw 时不应读取明文')
  }
  api.writeOpenclawConfig = async patch => { written = patch }

  const [channel] = await channels.importChannelsFromOpenclaw([])
  assert.equal(channel.apiKey, '')
  assert.deepEqual(channel.apiKeyRef, secretRef)

  const result = await channels.syncChannelToOpenclaw(channel)
  assert.equal(result.verified, true)
  assert.deepEqual(written.models.providers.rich.apiKey, secretRef)
})

test('Web 渠道存储保留 SecretRef，并允许新明文 Key 显式替换', () => {
  assert.equal(typeof devApi.normalizeModelChannelsDoc, 'function')
  const secretRef = { source: 'file', provider: 'default', id: 'providers/rich/apiKey' }
  const input = {
    channels: [{
      id: 'secret-ref', name: 'Secret Ref', baseUrl: 'https://example.com/v1',
      apiType: 'openai-responses', apiKey: '', apiKeyRef: secretRef,
      models: [{ id: 'vision' }],
    }],
  }
  const stored = devApi.normalizeModelChannelsDoc(input, null)
  assert.deepEqual(stored.channels[0].apiKeyRef, secretRef)
  assert.equal(stored.channels[0].apiKey, '')

  const replaced = devApi.normalizeModelChannelsDoc({
    channels: [{ ...stored.channels[0], apiKey: 'sk-new' }],
  }, stored)
  assert.equal(replaced.channels[0].apiKey, 'sk-new')
  assert.equal('apiKeyRef' in replaced.channels[0], false)
})

test('同步旧 Codex 渠道时写入 7.1 正式 API 类型', async () => {
  let written = null
  api.revealModelChannelKey = async () => 'sk-test'
  api.readOpenclawConfig = async () => written || ({ models: { providers: {} } })
  api.writeOpenclawConfig = async config => { written = config; return { verified: true } }

  await channels.syncChannelToOpenclaw({
    id: 'legacy', name: 'Legacy', baseUrl: 'https://example.com/v1',
    apiType: 'openai-codex-responses', models: [{ id: 'gpt-test' }], defaultModel: 'gpt-test',
  })

  assert.equal(written.models.providers.legacy.api, 'openai-chatgpt-responses')
})

test('Web 模型渠道同步后会重启运行中的 Gateway 以加载 Agent 模型注册表', async () => {
  let written = null
  let restartCount = 0
  api.probeGatewayPort = async () => true
  api.restartGateway = async () => { restartCount += 1 }
  api.revealModelChannelKey = async () => 'sk-test'
  api.readOpenclawConfig = async () => written || ({ models: { providers: {} } })
  api.writeOpenclawConfig = async config => { written = config }

  await channels.syncChannelToOpenclaw({
    id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1',
    apiType: 'openai-completions', models: [{ id: 'qwen-local' }], defaultModel: 'qwen-local',
  })

  assert.equal(restartCount, 1)
})

test('OpenClaw 同步必须通过目标配置回读核对', async () => {
  api.revealModelChannelKey = async () => 'sk-test'
  api.readOpenclawConfig = async () => ({ models: { providers: {} } })
  api.writeOpenclawConfig = async () => ({ verified: true })

  await assert.rejects(
    channels.syncChannelToOpenclaw({
      id: 'verify', name: 'Verify', baseUrl: 'https://example.com/v1',
      apiType: 'openai-responses', models: [{ id: 'gpt-test', maxTokens: 1024 }],
      defaultModel: 'gpt-test',
    }),
    /回读|核对|verify/i,
  )
})

test('OpenClaw 同步只发送目标 provider 的最小补丁', async () => {
  let written = null
  const existing = {
    gateway: { port: 18789, auth: { token: 'keep-private' } },
    models: { providers: { keep: { api: 'openai-completions', models: [] } } },
  }
  api.revealModelChannelKey = async () => 'sk-target'
  api.readOpenclawConfig = async () => written
    ? { ...existing, models: { providers: { ...existing.models.providers, ...written.models.providers } } }
    : existing
  api.writeOpenclawConfig = async patch => { written = patch }

  await channels.syncChannelToOpenclaw({
    id: 'target', name: 'Target', baseUrl: 'https://example.com/v1',
    apiType: 'openai-responses', models: [{ id: 'gpt-test' }], defaultModel: 'gpt-test',
  })

  assert.deepEqual(Object.keys(written), ['models'])
  assert.deepEqual(Object.keys(written.models.providers), ['target'])
  assert.equal(written.models.providers.target.apiKey, 'sk-target')
})

test('OpenClaw 同步回读必须核对凭据', async () => {
  api.revealModelChannelKey = async () => 'sk-expected'
  api.readOpenclawConfig = async () => ({
    models: { providers: { target: {
      baseUrl: 'https://example.com/v1', api: 'openai-responses', apiKey: 'sk-wrong',
      models: [{ id: 'gpt-test', name: 'gpt-test' }],
    } } },
  })
  api.writeOpenclawConfig = async () => undefined

  await assert.rejects(
    channels.syncChannelToOpenclaw({
      id: 'target', name: 'Target', baseUrl: 'https://example.com/v1',
      apiType: 'openai-responses', models: [{ id: 'gpt-test' }], defaultModel: 'gpt-test',
    }),
    /回读核对失败/,
  )
})

test('助手同步拒绝把环境变量引用当成 API Key 保存', () => {
  assert.throws(
    () => channels.syncChannelToAssistant({ baseUrl: 'https://example.com', apiType: 'openai-completions' }, '${OPENAI_API_KEY}'),
    /环境变量|env/i,
  )
  assert.equal(storage.has(channels.ASSISTANT_STORAGE_KEY), false)
})

test('助手同步仅在 localStorage 回读一致后返回 verified', () => {
  const result = channels.syncChannelToAssistant({
    baseUrl: 'https://example.com/v1',
    apiType: 'openai-responses',
    defaultModel: 'gpt-test',
  }, 'sk-test', 'gpt-test')

  assert.equal(result.verified, true)
  assert.deepEqual(JSON.parse(storage.get(channels.ASSISTANT_STORAGE_KEY)), {
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    apiType: 'openai-responses',
  })
})
