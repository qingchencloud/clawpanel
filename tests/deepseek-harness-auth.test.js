import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshAuth, redactDshOutput } from '../scripts/deepseek-harness-auth.js'
import { dshRpc, dshWireRequest, dshHasUpdate, normalizeDshRpcValue } from '../scripts/deepseek-harness.js'

const fixtureToken = 'A'.repeat(43)

test('新版认证仅接收指定回环端口就绪行，合并并发交换且不暴露认证数据', async () => {
  let exchanges = 0
  const auth = createDshAuth(3080, { fetchImpl: async (url, options) => {
    exchanges++
    assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=v1.fixture.signature; HttpOnly' } })
  } })
  auth.observe(`dsh web: http://example.test:3080/?token=${fixtureToken}`)
  auth.observe(`dsh web: http://127.0.0.1:3081/?token=${fixtureToken}`)
  assert.deepEqual(await auth.headers(), {})
  auth.observe(`dsh web: http://127.0.0.1:3080/?token=${fixtureToken}`)
  assert.equal(auth.modern, true)
  const results = await Promise.all([auth.headers(), auth.headers(), auth.headers()])
  assert.equal(exchanges, 1)
  assert.equal(results[0].cookie, 'dsh-auth-fixture=v1.fixture.signature')
  assert.doesNotMatch(JSON.stringify(auth), /signature|AAAAAAAA/)
  assert.doesNotMatch(redactDshOutput(`dsh web: http://127.0.0.1:3080/?token=${fixtureToken}`), /AAAAAAAA/)
})

test('认证拒绝非本地跳转和非 DSH Cookie，失败不回显带令牌 URL', async () => {
  for (const headers of [
    ...['https://example.test/', '//example.test/', 'http://127.0.0.1:3081/', '/other', './?token=leak', './#leak'].map(location => ({ location, 'set-cookie': 'dsh-auth-fixture=v1.a.b' })),
    { location: '/', 'set-cookie': 'panel=secret' },
  ]) {
    const auth = createDshAuth(3080, { fetchImpl: async () => new Response(null, { status: 303, headers }) })
    auth.observe(`dsh web: http://127.0.0.1:3080/?token=${fixtureToken}`)
    await assert.rejects(auth.headers(), error => !error.message.includes(fixtureToken) && error.message.includes('认证失败'))
  }
})

test('DSH 0.2 的相对根跳转 ./ 与旧版 / 均能交换认证', async () => {
  for (const location of ['/', './']) {
    const auth = createDshAuth(3080, { fetchImpl: async () => new Response(null, {
      status: 303, headers: { location, 'set-cookie': 'dsh-auth-fixture=v1.a.b; HttpOnly' },
    }) })
    auth.observe(`dsh web: http://127.0.0.1:3080/?token=${fixtureToken}`)
    assert.deepEqual(await auth.headers(), { cookie: 'dsh-auth-fixture=v1.a.b' })
  }
})

test('新旧 RPC 封套和新版 Provider/Credential 回包保持业务接口一致', async () => {
  assert.deepEqual(dshWireRequest('settings.mutate', { ns: 'llm-pi-ai', ops: [] }), { method: 'settings.mutate', payload: { ns: 'llm-pi-ai', ops: [] } })
  assert.deepEqual(dshWireRequest('settings.mutate', { ns: 'llm-pi-ai', ops: [] }, true), { method: 'settings/mutate', payload: { args: { ns: 'llm-pi-ai', ops: [] } } })
  assert.equal(dshWireRequest('llm.models', {}, true).method, 'session/modelCatalog')
  assert.deepEqual(normalizeDshRpcValue('credentials.describe', { KEY: { configured: true } }, true), { credentials: { KEY: { configured: true } } })
  const result = await dshRpc('llm.providers', {}, {
    port: 3080, modern: true, headers: { cookie: 'dsh-auth-fixture=v1.a.b' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3080/api/llm/listProviders')
      const body = JSON.parse(options.body)
      assert.deepEqual(body.payload, { args: {} })
      assert.equal(options.headers.cookie, 'dsh-auth-fixture=v1.a.b')
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: [{ id: 'local', name: 'Local' }] } })
    },
  })
  assert.equal(result.providers[0].provider, 'local')
  assert.equal(result.providers[0].active, true)
})

test('401 明确提示受管服务认证，而非非 JSON 错误或反复重试写入', async () => {
  let requests = 0
  await assert.rejects(dshRpc('settings.mutate', {}, { fetchImpl: async () => { requests++; return new Response('unauthorized', { status: 401 }) } }), /会话认证/)
  assert.equal(requests, 1)
})

test('候选版更新提示不把正式版或更高版本降级到 RC', () => {
  for (const version of ['0.1.1-rc.2', '0.1.5-rc.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-alpha.2']) assert.equal(dshHasUpdate(version), true, version)
  for (const version of ['', '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1-alpha.1']) assert.equal(dshHasUpdate(version), false, version)
})
