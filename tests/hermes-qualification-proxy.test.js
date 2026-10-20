// 真实 loopback HTTP 传输验收；不启动 Hermes、不伪造 verifier 或浏览器资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

const source = fs.readFileSync(new URL('../scripts/hermes-qualification-bootstrap.mjs', import.meta.url), 'utf8')
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const begin = source.indexOf('front = http.createServer(async (req, res) => {')
const end = source.indexOf("\n    front.on('upgrade'", begin)
assert.ok(begin >= 0 && end > begin, '必须使用 bootstrap 本身的完整 HTTP handler，不复制/模拟 http.request')
const handler = source.slice(begin, end).trim()
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) })

async function harness(t, name, route) {
  const ledger = [], errors = [], fixtureErrors = [], actions = [], sockets = new Set(), ids = new WeakMap()
  let nextId = 0
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks), row = { seq: ledger.length + 1, at: new Date().toISOString(), method: req.method, path: req.url, socketId: ids.get(req.socket), bodySha256: sha(body), host: req.headers.host }
      ledger.push(row); await route(req, res, body, row, ledger)
    } catch (error) { fixtureErrors.push(String(error)); res.destroy(error) }
  })
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  upstream.on('connection', socket => { ids.set(socket, ++nextId); track(socket) })
  upstream.keepAliveTimeout = 60000
  const upstreamPort = await listen(upstream)
  const factory = new Function('http', 'webPort', 'snapshot', 'ready', 'rawError', 'write', 'stamp', `
    let front, failed=false, pendingAction, actionEpoch=0, lastAction;
    const actions=[];
    ${handler}
    return front;
  `)
  const front = factory(http, upstreamPort, async () => ({ transportFixture: true }), { transportFixture: true }, error => errors.push({ code: error.code, message: error.message }), (file, value) => actions.push({ file, value }), () => new Date().toISOString())
  front.on('connection', track)
  const port = await listen(front), client = new http.Agent({ keepAlive: true })
  const responses = []
  t.after(async () => {
    client.destroy()
    const closed = [front, upstream].map(server => new Promise(resolve => server.close(resolve)))
    for (const socket of sockets) socket.destroy()
    await Promise.all(closed)
    for (let i = 0; sockets.size && i < 100; i++) await delay(5)
    const report = { scenario: name, node: process.version, platform: process.platform, bootstrapSha256: sha(source), handlerSha256: sha(handler), globalAgentKeepAlive: http.globalAgent.options.keepAlive, upstreamConnections: nextId, ledger, responses, errors, fixtureErrors, cleanup: { listening: front.listening || upstream.listening, openSockets: sockets.size }, limitation: 'controlled real HTTP transport fault; not an actual Hermes/UI CI rerun' }
    if (process.env.HERMES_PROXY_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.HERMES_PROXY_EVIDENCE_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.HERMES_PROXY_EVIDENCE_DIR, `${name}.json`), JSON.stringify(report, null, 2) + '\n')
    }
    assert.equal(report.cleanup.listening, false); assert.equal(sockets.size, 0); assert.deepEqual(fixtureErrors, [])
  })
  const request = (url, { method = 'GET', body = Buffer.alloc(0), headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: client, headers: { connection: 'keep-alive', 'content-length': body.length, ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => { const bytes = Buffer.concat(chunks), row = { method, path: url, status: res.statusCode, headers: res.headers, bodySha256: sha(bytes), body: bytes.toString('utf8') }; responses.push(row); resolve(row) })
    })
    req.setTimeout(3000, () => req.destroy(new Error('bounded loopback HTTP timeout'))); req.on('error', reject); req.end(body)
  })
  return { request, ledger, errors, upstreamPort }
}

test('真实 HTTP：已过期 keepalive TCP 复用触发 reset，reload 必须仍200且逐请求独立连接', { timeout: 10000 }, async t => {
  const expiry = new WeakMap()
  const h = await harness(t, 'expired-keepalive-reload', (req, res, body, row) => {
    const deadline = expiry.get(req.socket)
    row.expiredLease = deadline !== undefined && Date.now() >= deadline
    if (row.expiredLease) {
      // 控制上游空闲连接租期：真实收到对过期 TCP 的复用后发 RST，不模拟 HTTP 返回值。
      row.fixtureAction = 'reset-expired-reused-socket'; req.socket.resetAndDestroy(); return
    }
    expiry.set(req.socket, Date.now() + 20)
    const value = 'actual-upstream-root'
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(value), 'x-qualification-upstream': 'real-http' }); res.end(value)
  })
  assert.equal((await h.request('/')).status, 200)
  await delay(60)
  const reload = await h.request('/')
  assert.equal(reload.status, 200, 'reload 不应经由过期池连接变成502；不能以 GET/POST 重试掩盖')
  assert.equal(reload.body, 'actual-upstream-root'); assert.equal(reload.headers['x-qualification-upstream'], 'real-http')
  assert.equal(h.ledger.length, 2); assert.notEqual(h.ledger[0].socketId, h.ledger[1].socketId)
  assert.deepEqual(h.errors, [])
})

test('真实 HTTP：POST 上游 reset 仍502且恰好一次，不重试/吞错/改写请求正文', { timeout: 10000 }, async t => {
  const h = await harness(t, 'post-reset-no-retry', (req, res, body, row) => { row.fixtureAction = 'reset-after-full-post-body'; req.socket.resetAndDestroy() })
  const body = Buffer.from('{"nonce":"proxy-qualification-nonce","text":"原始正文"}')
  const response = await h.request('/__api/qualification-no-retry', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
  assert.equal(response.status, 502)
  await delay(80)
  assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0].method, 'POST'); assert.equal(h.ledger[0].bodySha256, sha(body))
  assert.equal(h.errors.length, 1); assert.equal(h.errors[0].code, 'ECONNRESET')
})

test('真实 HTTP：原路径/正文/状态/headers/SSE字节透明，不把上游错误改成功', { timeout: 10000 }, async t => {
  const h = await harness(t, 'transparent-http-and-sse', async (req, res, body) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(': ping\n\n'); await delay(20); res.end('data: {"actual":"upstream"}\n\n'); return
    }
    res.writeHead(418, { 'content-type': 'application/octet-stream', 'x-qualification-byte-echo': 'same', 'set-cookie': ['one=fake; HttpOnly', 'two=fake; SameSite=Strict'] }); res.end(body)
  })
  const body = Buffer.from([0, 13, 10, 255, 0xc3, 0xa9])
  const result = await h.request('/echo?raw=%2F%3F', { method: 'POST', body })
  assert.equal(result.status, 418); assert.equal(result.bodySha256, sha(body)); assert.equal(result.headers['x-qualification-byte-echo'], 'same')
  assert.deepEqual(result.headers['set-cookie'], ['one=fake; HttpOnly', 'two=fake; SameSite=Strict'])
  assert.equal(h.ledger[0].path, '/echo?raw=%2F%3F'); assert.equal(h.ledger[0].host, `127.0.0.1:${h.upstreamPort}`); assert.equal(h.ledger[0].bodySha256, sha(body))
  const sse = await h.request('/events')
  assert.equal(sse.status, 200); assert.equal(sse.headers['content-type'], 'text/event-stream'); assert.equal(sse.body, ': ping\n\ndata: {"actual":"upstream"}\n\n')
  assert.equal(h.ledger.length, 2); assert.deepEqual(h.errors, [])
})
