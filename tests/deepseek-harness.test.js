import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DSH_DEFAULT_MODEL_NAMESPACE,
  DSH_SETTINGS_NAMESPACE,
  buildDshProviderProfile,
  dshCredentialRef,
  dshProviderKey,
  dshRpc,
  dshSyncSupported,
  syncDshProvider,
} from '../scripts/deepseek-harness.js'

function createFakeHarness() {
  const state = {
    llmRevision: 3,
    defaultRevision: 2,
    providers: {},
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    credentials: {},
    calls: [],
  }
  const describe = () => ({
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: DSH_SETTINGS_NAMESPACE, revision: state.llmRevision, value: { providers: structuredClone(state.providers) }, user: { providers: structuredClone(state.providers) }, schema: {}, applies: 'live', secrets: [] },
      { ns: DSH_DEFAULT_MODEL_NAMESPACE, revision: state.defaultRevision, value: structuredClone(state.defaultModel), user: structuredClone(state.defaultModel), schema: {}, applies: 'live', secrets: [] },
    ],
  })
  const rpc = async (method, payload) => {
    state.calls.push({ method, payload: structuredClone(payload) })
    if (method === 'settings.describe') return describe()
    if (method === 'settings.mutate') {
      assert.equal(payload.ns, DSH_SETTINGS_NAMESPACE)
      assert.equal(payload.expectedRevision, state.llmRevision)
      for (const op of payload.ops) {
        assert.deepEqual(op.path.slice(0, 1), ['providers'])
        state.providers[op.path[1]] = structuredClone(op.value)
      }
      state.llmRevision += 1
      return describe().namespaces[0]
    }
    if (method === 'settings.replace') {
      assert.equal(payload.ns, DSH_DEFAULT_MODEL_NAMESPACE)
      assert.equal(payload.expectedRevision, state.defaultRevision)
      state.defaultModel = structuredClone(payload.section)
      state.defaultRevision += 1
      return describe().namespaces[1]
    }
    if (method === 'credentials.set') {
      state.credentials[payload.ref] = { configured: Boolean(payload.value), writable: true, source: 'file' }
      return {}
    }
    if (method === 'credentials.describe') {
      return { credentials: Object.fromEntries(payload.refs.map(ref => [ref, state.credentials[ref] || { configured: false, writable: true }])) }
    }
    if (method === 'llm.providers') {
      return { providers: Object.keys(state.providers).map(provider => ({ provider, active: true, settingsNs: DSH_SETTINGS_NAMESPACE, settingsPath: ['providers', provider] })) }
    }
    if (method === 'llm.models') {
      return { groups: Object.entries(state.providers).map(([id, profile]) => ({ id, models: profile.models })), failures: [] }
    }
    throw new Error(`unexpected method: ${method}`)
  }
  return { state, rpc }
}

test('渠道映射生成隔离 provider id、凭据引用和完整容量字段', () => {
  const channel = {
    id: 'ch-lm', name: 'LM Studio 本地', baseUrl: 'http://127.0.0.1:1234/v1/',
    apiType: 'openai-completions',
    models: [{ id: 'qwen-local', contextTokens: 131072, maxTokens: 8192 }],
  }
  const provider = dshProviderKey(channel)
  assert.equal(provider, 'clawpanel-ch-lm')
  assert.equal(dshCredentialRef(provider), 'CLAWPANEL_CH_LM_API_KEY')
  assert.deepEqual(buildDshProviderProfile(channel), {
    displayName: 'LM Studio 本地',
    apiKeyEnv: 'CLAWPANEL_CH_LM_API_KEY',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:1234/v1',
    models: [{ id: 'qwen-local', contextWindow: 131072, maxTokens: 8192 }],
  })
})

test('Provider ID 跟随渠道 ID，重命名稳定且同名渠道互不覆盖', () => {
  assert.equal(dshProviderKey({ id: 'ch-one', name: '同名渠道' }), 'clawpanel-ch-one')
  assert.equal(dshProviderKey({ id: 'ch-one', name: '已重命名' }), 'clawpanel-ch-one')
  assert.equal(dshProviderKey({ id: 'ch-two', name: '同名渠道' }), 'clawpanel-ch-two')
})

test('Harness 同步只修改目标 provider，并回读 provider、凭据和默认模型', async () => {
  const { state, rpc } = createFakeHarness()
  state.providers.existing = {
    displayName: 'Existing', api: 'openai-completions', baseURL: 'https://keep.test/v1', models: [{ id: 'keep' }],
  }
  const result = await syncDshProvider({
    channel: {
      id: 'ch-one', name: 'One API', baseUrl: 'https://one.test/v1',
      apiType: 'openai-responses', models: [{ id: 'reasoner', contextWindow: 200000, maxTokens: 16000 }],
      defaultModel: 'reasoner',
    },
    apiKey: 'secret-never-returned',
    setDefault: true,
    rpc,
  })

  assert.equal(result.verified, true)
  assert.equal(result.providerId, 'clawpanel-ch-one')
  assert.ok(state.providers.existing, '不得覆盖其他 provider')
  assert.equal(state.providers['clawpanel-ch-one'].models[0].contextWindow, 200000)
  assert.deepEqual(state.defaultModel, { provider: 'clawpanel-ch-one', model: 'reasoner' })
  assert.equal(state.credentials.CLAWPANEL_CH_ONE_API_KEY.configured, true)
  const describeCall = state.calls.find(call => call.method === 'credentials.describe')
  assert.deepEqual(describeCall.payload, { refs: ['CLAWPANEL_CH_ONE_API_KEY'] })
  assert.doesNotMatch(JSON.stringify(result), /secret-never-returned/)
})

test('不受支持的协议和 SecretRef 不会进入 Harness 同步', () => {
  assert.equal(dshSyncSupported({ apiType: 'google-generative-ai' }), false)
  assert.equal(dshSyncSupported({ apiType: 'openai-chatgpt-responses' }), false)
  assert.equal(dshSyncSupported({ apiType: 'openai-completions', apiKeyRef: { source: 'env', id: 'KEY' } }), false)
  assert.throws(() => buildDshProviderProfile({
    name: 'Gemini', baseUrl: 'https://example.test', apiType: 'google-generative-ai', models: [{ id: 'gemini' }],
  }), /暂不支持/)
})

test('RPC 强制回环地址并校验 server-response 的 rpcId', async () => {
  let requestedUrl = ''
  let requestedBody = null
  const fetchImpl = async (url, init) => {
    requestedUrl = url
    requestedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: requestedBody.rpcId, result: { ok: true, value: { writable: true } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const value = await dshRpc('settings.describe', {}, { port: 33080, fetchImpl })
  assert.equal(requestedUrl, 'http://127.0.0.1:33080/api/settings.describe')
  assert.equal(requestedBody.type, 'client-request')
  assert.equal(value.writable, true)
})
