import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const load = () => import('../scripts/hermes-qualification-provider.mjs')
const models = ['maintenance-model', 'qualification-one', 'org/model 1', '模型:1']
const expected = provider => ({ kind: 'metadata', status: 404, provider })
const routes = [['/api/v1/models', 'lm-studio'], ['/api/tags', 'ollama'], ['/v1/props', 'llamacpp'], ['/props', 'llamacpp'], ['/version', 'vllm']]

test('metadata 固定五条 GET 路由，只接受无请求体，不因无认证伪造服务能力', async () => {
  const { classifyHermesMetadataRequest: classify } = await load()
  for (const [route, provider] of routes) {
    for (const body of ['', null, undefined]) assert.deepEqual(classify('GET', route, body, models), expected(provider))
    for (const body of [' ', '{}', 'null', {}, [], 0, false, Buffer.alloc(0)]) assert.equal(classify('GET', route, body, models), null)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'get', ' GET', undefined]) assert.equal(classify(method, route, '', models), null)
  }
})

test('OpenAI catalog 精确 GET /v1/models 空体或{}为 metadata200，其他方法/体不免检', async () => {
  const { classifyHermesMetadataRequest: classify } = await load()
  for (const body of ['', null, undefined, {}, Object.create(null), '{}', ' \n{}\n']) assert.deepEqual(classify('GET', '/v1/models', body, models), { kind: 'metadata', status: 200, provider: 'openai-catalog' })
  for (const body of [' ', 'null', '[]', [], { name: 'maintenance-model' }, { extra: true }, false, 0, new Date()]) assert.equal(classify('GET', '/v1/models', body, models), null)
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'get']) assert.equal(classify(method, '/v1/models', {}, models), null)
})

test('metadata model detail 必须精确匹配 declared encodeURI model；不解码或放宽 URL', async () => {
  const { classifyHermesMetadataRequest: classify } = await load()
  for (const model of models) {
    const route = '/v1/models/' + encodeURI(model)
    assert.deepEqual(classify('GET', route, '', models), expected('openai'))
    assert.deepEqual(classify('GET', route, null, new Set(models)), expected('openai'))
    for (const method of ['POST', 'HEAD', 'get']) assert.equal(classify(method, route, '', models), null)
    for (const body of ['{}', {}, ' ', 'null']) assert.equal(classify('GET', route, body, models), null)
    assert.equal(classify('GET', route, '', []), null)
    assert.equal(classify('GET', route, '', [model + '-other']), null)
  }
  for (const route of ['/v1/models/unknown', '/v1/models/', '/v1/models/maintenance-model/', '/v1/models/maintenance-model?x=1', '/v1/models/maintenance-model#x', '/v1/models/org%2Fmodel%201', '/v1/models/org/model%25201', '/v1/models/../maintenance-model']) assert.equal(classify('GET', route, '', models), null)
  for (const declared of [null, {}, 'maintenance-model', [1], [undefined], ['\uD800']]) assert.equal(classify('GET', '/v1/models/maintenance-model', '', declared), null)
})

test('Ollama show 只接受 POST 且 JSON 自有可枚举 name 唯一键及已声明模型', async () => {
  const { classifyHermesMetadataRequest: classify } = await load()
  for (const name of models) for (const body of [{ name }, JSON.stringify({ name }), ' \n' + JSON.stringify({ name }) + '\n', Object.assign(Object.create(null), { name })]) assert.deepEqual(classify('POST', '/api/show', body, models), expected('ollama'))
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { throw new Error('不得执行 getter') } })
  const hidden = Object.defineProperty({}, 'name', { value: 'maintenance-model' })
  const symbol = { name: 'maintenance-model', [Symbol('extra')]: true }
  for (const body of [undefined, null, '', ' ', '{bad', 'null', '{}', [], ['maintenance-model'], false, 1, { model: 'maintenance-model' }, { name: 'unknown' }, { name: '' }, { name: 1 }, { name: 'maintenance-model', extra: true }, Object.create({ name: 'maintenance-model' }), accessor, hidden, symbol, Buffer.from('{"name":"maintenance-model"}')]) assert.equal(classify('POST', '/api/show', body, models), null)
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post', 'POST ']) assert.equal(classify(method, '/api/show', { name: models[0] }, models), null)
  for (const declared of [null, {}, [], 'maintenance-model']) assert.equal(classify('POST', '/api/show', { name: models[0] }, declared), null)
})

test('未知路由、query、prefix 与 chat 请求不归为 metadata', async () => {
  const { classifyHermesMetadataRequest: classify } = await load()
  for (const route of ['/v1/chat/completions', '/api/v1/models/load', '/api/generate', '/api/chat', '/api/show/', '/API/tags', '/api/tags/', '/api/tags?x=1', '/api/tags#x', '//api/tags', '/prefix/api/tags', 'https://example.invalid/api/tags', '/props?model=maintenance-model', '/api/%74ags', '', null, undefined]) {
    assert.equal(classify('GET', route, '', models), null)
    assert.equal(classify('POST', route, { name: models[0] }, models), null)
  }
})

test('可信 tooling hash 清单包含共用 provider helper，不只哈希调用方', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/hermes-qualification.yml', import.meta.url), 'utf8')
  assert.match(workflow, /sha256sum[^\n]*tooling\/scripts\/hermes-qualification-provider\.mjs/)
})

test('分类为纯函数，不变更 body/models，不读网络、文件或认证、不把404伪装200', async () => {
  const { classifyHermesMetadataRequest: classify } = await load(), body = Object.freeze({ name: 'maintenance-model' }), declared = Object.freeze(['maintenance-model'])
  assert.deepEqual(classify('POST', '/api/show', body, declared), expected('ollama'))
  assert.deepEqual(body, { name: 'maintenance-model' }); assert.deepEqual(declared, ['maintenance-model'])
  const source = fs.readFileSync(new URL('../scripts/hermes-qualification-provider.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]node:|fetch\(|process\.env|child_process|Authorization|Bearer/)
})

test('Windows provider 在 JSON/chat/auth 断言前分类，保留完整聊天 once/title 与未知红灯', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/hermes-qualification-provider\.mjs'/)
  const start = source.indexOf('provider = http.createServer'), classify = source.indexOf('classifyHermesMetadataRequest(req.method, req.url, raw, providerModels)', start), chat = source.indexOf('const b = JSON.parse(raw)', start)
  assert.ok(start >= 0 && classify > start && chat > classify)
  for (const value of ["kind: 'metadata'", 'bodySha256: digest(raw)', 'metadata.status', 'metadata.provider']) assert.ok(source.includes(value), value)
  assert.match(source, /metadata\.status === 200/); assert.match(source, /providerModels\.map/)
  for (const value of ['responseStatus', 'accepted: true', 'bodySha256', 'authMatches']) assert.ok(source.includes(value), value)
  assert.match(source, /assert\.equal\(req\.method, 'POST'\)/)
  assert.match(source, /assert\.equal\(req\.url, '\/v1\/chat\/completions'\)/)
  assert.match(source, /assert\.equal\(req\.headers\.authorization, 'Bearer qualification-local-no-secret'\)/)
  assert.match(source, /聊天请求必须恰好一次/); assert.match(source, /同 nonce 标题请求重复/); assert.match(source, /purpose === 'unattributed'/)
  assert.match(source, /kind: 'unknown'/); assert.match(source, /r\.providerError = String\(e\)/)
  assert.match(source, /hermes-qualification-provider\.mjs.*sha256|tooling-dependencies\.json/)
})
