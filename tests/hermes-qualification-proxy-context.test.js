// 仅自有 loopback 组件；不启动 bootstrap/main、内核、GUI 或外部 Provider。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { errorMonitor, once } from 'node:events'
import * as bootstrap from '../scripts/hermes-qualification-bootstrap.mjs'

const source = fs.readFileSync(new URL('../scripts/hermes-qualification-bootstrap.mjs', import.meta.url), 'utf8')
const prefix = '[HERMES_PROXY_CONTEXT] '
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function bound(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`own-loopback-deadline:${label}`)), 3000) })]) }
  finally { clearTimeout(timer) }
}
const listen = server => bound(new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))), 'listen')
const decode = lines => lines.map(line => { assert.ok(line.startsWith(prefix)); return JSON.parse(line.slice(prefix.length)) })
const contexts = h => decode(h.lines).filter(x => x.kind === 'request-context')
function recorder(appendLine) {
  assert.equal(typeof bootstrap.createProxyContextRecorder, 'function', '缺少可信上下文记录器')
  return bootstrap.createProxyContextRecorder({ appendLine, sourceSha: '1'.repeat(40) })
}
function evidence(name, value) {
  if (!process.env.HERMES_PROXY_CONTEXT_EVIDENCE_DIR) return
  const dir = process.env.HERMES_PROXY_CONTEXT_EVIDENCE_DIR
  fs.mkdirSync(dir, { recursive: true })
  const bytes = JSON.stringify(value, null, 2) + '\n'
  assert.ok(Buffer.byteLength(bytes) <= 128 * 1024, '专项证据超额，不截断')
  fs.writeFileSync(path.join(dir, `${name}.json`), bytes)
}
async function harness(t, name, { writeFail = false, diskLog = false } = {}) {
  const lines = [], rawErrors = [], ledger = [], requests = [], sockets = new Set(), proxySockets = new Set(), waiters = [], closeWaiters = []
  const logRoot = diskLog ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-proxy-context-own-'))) : null
  const logPath = logRoot && path.join(logRoot, 'errors-private.log')
  const rawDeclaration = source.match(/^  const rawError = error => .+$/m)?.[0]
  assert.ok(rawDeclaration, '必须使用源文件原rawError写入闭包')
  const originalRawError = diskLog ? new Function('fs', 'path', 'output', 'stamp', `${rawDeclaration}; return rawError`)(fs, path, logRoot, () => new Date().toISOString()) : null
  const observedError = deferred()
  const observer = typeof bootstrap.createProxyContextRecorder === 'function'
    ? bootstrap.createProxyContextRecorder({ appendLine: line => {
      if (writeFail) {
        if (diskLog) fs.appendFileSync(logRoot, line)
        throw new Error('SECRET_WRITER_FAILURE')
      }
      if (diskLog) fs.appendFileSync(logPath, line, { mode: 0o600 })
      lines.push(line)
      for (let i = closeWaiters.length - 1; i >= 0; i--) if (decode(lines).filter(x => x.phase === 'closed').length >= closeWaiters[i].count) closeWaiters.splice(i, 1)[0].resolve()
    }, sourceSha: '1'.repeat(40) }) : undefined
  // 只观察原event返回后的计数，让正常请求不依赖写日志唤醒测试；不轮询/不加请求。
  const notifyClosed = () => {
    for (let i = closeWaiters.length - 1; i >= 0; i--) if (observer.summary().closedRequests >= closeWaiters[i].count) closeWaiters.splice(i, 1)[0].resolve()
  }
  const observedRecorder = observer && { begin(input) {
    const context = observer.begin(input)
    return { ...context, event(...args) { const result = context.event(...args); notifyClosed(); return result } }
  } }
  const track = server => server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const backend = track(http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ req, res }); ledger.push({ method: req.method, bytes: Buffer.concat(chunks).length, sha256: sha(Buffer.concat(chunks)) })
      while (waiters.length && requests.length >= waiters[0].count) waiters.shift().resolve()
    })
  }))
  const upgraded = deferred()
  let backendUpgrade
  backend.on('upgrade', (_req, socket) => { backendUpgrade = socket; socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); upgraded.resolve() })
  const backendPort = await listen(backend)
  const begin = source.indexOf('front = http.createServer(async (req, res) => {')
  const end = source.indexOf('\n    await listen(front, port, host)', begin)
  assert.ok(begin > 0 && end > begin, '必须执行源文件实际完整HTTP/upgrade接线')
  const factory = new Function('http', 'net', 'webPort', 'rawError', 'proxyContext', 'errorMonitor', 'proxySockets', 'assert', `
    let front, failed=false, pendingAction, actionEpoch=0,lastAction;
    const actions=[], ready={fixture:true}, snapshot=async()=>({fixture:true}),write=()=>{},stamp=()=>new Date().toISOString();
    ${source.slice(begin, end)}
    return {front, getFailed:()=>failed};
  `)
  const f = factory(http, net, backendPort, error => { originalRawError?.(error); rawErrors.push({ code: error.code, message: error.message, stack: error.stack }); observedError.resolve() }, observedRecorder, errorMonitor, proxySockets, assert)
  const front = track(f.front), port = await listen(front)
  const clientSockets = new Set()
  const request = ({ route = '/__api/hermes_sessions_list?token=SECRET_QUERY', body = Buffer.from('{"password":"SECRET_BODY"}') } = {}) => {
    const result = deferred(), closed = deferred()
    const client = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      headers: { 'content-length': body.length, 'authorization': 'Bearer sk-SECRET_HEADER', 'content-type': 'application/json' } }, res => {
      const data = []; res.on('data', chunk => data.push(chunk)); res.on('error', error => result.resolve({ error: error.code }))
      res.on('end', () => result.resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(data) }))
    })
    client.on('socket', socket => { clientSockets.add(socket); socket.once('close', () => clientSockets.delete(socket)) })
    client.on('error', error => result.resolve({ error: error.code })); client.once('close', () => closed.resolve())
    client.end(body); return { client, result: result.promise, closed: closed.promise }
  }
  const arrived = count => requests.length >= count ? Promise.resolve() : bound(new Promise(resolve => waiters.push({ count, resolve })), 'upstream-arrival')
  t.after(async () => {
    const all = [...new Set([...sockets, ...proxySockets, ...clientSockets])]
    // 集合仅在close回执移除；closed属性可能已true而回执还排在事件队列中。
    const closes = all.map(s => new Promise(resolve => s.once('close', resolve)))
    for (const s of all) s.destroy()
    await bound(Promise.all(closes), 'own-socket-close')
    for (const s of [front, backend]) if (s.listening) await bound(new Promise((resolve, reject) => s.close(error => error ? reject(error) : resolve())), 'own-server-close')
    assert.equal(sockets.size, 0); assert.equal(proxySockets.size, 0); assert.equal(clientSockets.size, 0)
    evidence(name, { node: process.version, platform: process.platform, bootstrapSha256: sha(source), ledger, rawErrors, context: decode(lines), summary: observer?.summary(), failed: f.getFailed(), cleanup: { sockets: sockets.size, proxySockets: proxySockets.size, clientSockets: clientSockets.size, frontListening: front.listening, backendListening: backend.listening }, scope: 'own loopback only; not actualkernel or UI qualification' })
    if (logRoot) {
      assert.equal(fs.realpathSync.native(logRoot), logRoot)
      if (fs.existsSync(logPath)) { assert.equal(fs.lstatSync(logPath).isSymbolicLink(), false); fs.unlinkSync(logPath) }
      fs.rmdirSync(logRoot)
    }
  })
  const finished = count => !observer || observer.summary().closedRequests >= count ? Promise.resolve() : bound(new Promise(resolve => closeWaiters.push({ count, resolve })), 'context-close-receipt')
  return { lines, rawErrors, observer, request, arrived, finished, requests, ledger, observedError: observedError.promise, port, backend, logPath, upgraded: upgraded.promise, get upgradeSocket() { return backendUpgrade }, getFailed: f.getFailed }
}

test('真实HTTP JSON/二进制和SSE原字节/status/header透明，正常close非取消', { timeout: 10000 }, async t => {
  const h = await harness(t, 'normal-http-sse')
  const body = Buffer.from([0, 255, 13, 10, 0xe4, 0xb8, 0xad])
  const c = h.request({ body }); await h.arrived(1)
  h.requests[0].res.writeHead(418, { 'content-type': 'application/octet-stream', 'x-owned-test': 'same' }); h.requests[0].res.end(body)
  const r = await bound(c.result, 'binary-result'); await bound(c.closed, 'binary-close')
  assert.equal(r.status, 418); assert.equal(r.headers['x-owned-test'], 'same'); assert.deepEqual(r.body, body)
  const s = h.request({ route: '/events' }); await h.arrived(2)
  h.requests[1].res.writeHead(200, { 'content-type': 'text/event-stream' }); h.requests[1].res.write(': ping\n\n'); h.requests[1].res.end('data: [DONE]\n\n')
  const sr = await bound(s.result, 'sse-result'); await bound(s.closed, 'sse-close')
  assert.equal(sr.status, 200); assert.equal(sr.body.toString(), ': ping\n\ndata: [DONE]\n\n')
  await h.finished(2)
  assert.equal(h.rawErrors.length, 0); assert.equal(h.ledger.length, 2)
  assert.ok(h.observer, '原source缺少真实请求的上下文统计')
  assert.equal(contexts(h).length, 0, '正常请求只统计，不写流水')
  assert.equal(h.observer.summary().requests, 2); assert.equal(h.observer.summary().closedRequests, 2)
  assert.equal(h.observer.summary().errors, 0); assert.equal(h.observer.summary().evidenceIncomplete, false)
  assert.equal(h.getFailed(), false)
})

test('真实下游取消：保留旧rawError，同请求先close→localDestroy→error', { timeout: 10000 }, async t => {
  const h = await harness(t, 'downstream-cancel')
  const c = h.request(); await h.arrived(1); c.client.destroy(); await bound(c.closed, 'client-cancel'); await bound(h.observedError, 'raw-error')
  assert.equal(h.rawErrors.length, 1); assert.equal(h.rawErrors[0].message, 'socket hang up')
  const ctx = contexts(h).find(x => x.phase === 'error')
  assert.ok(ctx, 'MISSING_PROXY_CONTEXT:requestSeq')
  assert.equal(ctx.route, 'api:hermes_sessions_list'); assert.equal(ctx.branch, 'http')
  assert.equal(ctx.classification, 'downstream-cancel-proven')
  assert.ok(ctx.localDestroy.causeSeq < ctx.localDestroy.eventSeq && ctx.localDestroy.eventSeq < ctx.firstErrorSeq)
  assert.equal(ctx.evidenceIncomplete, false); assert.equal(h.getFailed(), false)
})

test('真实并发同route，仅一条取消，另一条成功，序号不能串', { timeout: 10000 }, async t => {
  const h = await harness(t, 'two-concurrent-one-cancel')
  const a = h.request(), b = h.request(); await h.arrived(2)
  a.client.destroy(); await bound(a.closed, 'a-close'); await bound(h.observedError, 'a-raw')
  h.requests[1].res.end('survivor'); assert.equal((await bound(b.result, 'b-result')).body.toString(), 'survivor'); await bound(b.closed, 'b-close')
  await h.finished(2)
  const errors = contexts(h).filter(x => x.phase === 'error')
  assert.equal(errors.length, 1); assert.equal(errors[0].requestSeq, 1)
  assert.ok(contexts(h).every(x => x.requestSeq === 1), '成功请求无错误上下文，不能串到取消请求')
  assert.equal(h.observer.summary().requests, 2); assert.equal(h.observer.summary().closedRequests, 2)
  assert.equal(h.rawErrors.length, 1); assert.equal(h.ledger.length, 2)
})

test('真实upstream FIN仍502，错误先于close，不能事后标取消', { timeout: 10000 }, async t => {
  const h = await harness(t, 'upstream-fin-502')
  const c = h.request(); await h.arrived(1); h.requests[0].req.socket.end()
  assert.equal((await bound(c.result, 'fin-result')).status, 502); await bound(c.closed, 'fin-close')
  assert.equal(h.rawErrors.length, 1); assert.equal(h.ledger.length, 1)
  const errors = contexts(h).filter(x => x.phase === 'error'); assert.equal(errors.length, 1)
  assert.equal(errors[0].classification, 'upstream-or-unknown'); assert.equal(errors[0].localDestroy, null)
  assert.equal(h.getFailed(), false)
})

test('真实WS正常TCP关闭/拒连：原upgrade行为不加rawError、不冒称Gateway STOP', { timeout: 10000 }, async t => {
  for (const refused of [false, true]) {
    await t.test(refused ? 'refused' : 'normal', async tt => {
      const h = await harness(tt, refused ? 'ws-refused' : 'ws-normal')
      if (refused) await bound(new Promise(resolve => h.backend.close(resolve)), 'backend-closed')
      const c = net.connect(h.port, '127.0.0.1'); c.on('error', () => {}); c.resume()
      const closed = new Promise(resolve => c.once('close', resolve))
      tt.after(() => c.destroy())
      await bound(once(c, 'connect'), 'ws-client-connect')
      c.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      if (!refused) { await bound(h.upgraded, 'ws-upgraded'); h.upgradeSocket.end() }
      await bound(closed, 'ws-client-close')
      await h.finished(1)
      assert.equal(h.rawErrors.length, 0)
      const records = contexts(h)
      if (refused) assert.ok(records.length > 0, '拒连upgrade必须有安全上下文')
      else { assert.equal(records.length, 0); assert.equal(h.observer.summary().closedRequests, 1) }
      assert.ok(records.every(x => x.branch === 'upgrade' && x.classification !== 'downstream-cancel-proven'))
      if (refused) assert.equal(records.find(x => x.phase === 'error')?.errorCode, 'ECONNREFUSED')
    })
  }
})

test('顺序倒置/无关闭证据/未知code不得凭message标取消，输入仅白名单', () => {
  const lines = [], r = recorder(line => lines.push(line))
  for (const prior of [false, true]) {
    const c = r.begin({ branch: 'http', method: 'POST', pathname: '/__api/hermes_sessions_list', url: 'SECRET_URL', headers: { authorization: 'Bearer SECRET_HEADER' }, body: 'SECRET_BODY' })
    if (!prior) c.error({ code: 'ECONNRESET', message: 'SECRET_ERROR' })
    c.destroy('downstream-response-close-before-end')
    if (prior) c.error({ code: 'PRIVATE_CODE_SECRET', message: 'SECRET_ERROR' })
    c.event('downstream-close', { resEnded: false }); c.event('upstream-close')
  }
  const all = decode(lines).filter(x => x.kind === 'request-context')
  assert.ok(all.length >= 2); assert.ok(all.every(x => x.classification === 'upstream-or-unknown'))
  assert.ok(!lines.join('').includes('SECRET')); assert.ok(all.some(x => x.errorCode === 'OTHER'))
})

test('真实坏route与query/header/body秘密不进入新上下文，rawError仍在', { timeout: 10000 }, async t => {
  const h = await harness(t, 'bad-route-secret-boundary')
  const c = h.request({ route: '/private-SECRET_PATH?token=SECRET_QUERY' }); await h.arrived(1); h.requests[0].req.socket.end()
  assert.equal((await bound(c.result, 'secret-result')).status, 502); await bound(c.closed, 'secret-close')
  assert.equal(h.rawErrors.length, 1)
  assert.ok(contexts(h).length > 0); assert.ok(contexts(h).every(x => x.route === 'other'))
  assert.ok(!h.lines.join('').includes('SECRET')); assert.ok(!h.lines.join('').includes('Bearer')); assert.ok(!h.lines.join('').includes('sk-'))
})

test('每请求16事件硬上限：超额显式incomplete，不把截断上下文标已归因', () => {
  const lines = [], r = recorder(line => lines.push(line)), c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  for (let i = 0; i < 20; i++) c.event('request-end')
  c.error({ code: 'ECONNRESET' }); c.event('downstream-close'); c.event('upstream-close')
  assert.equal(r.summary().evidenceIncomplete, true); assert.ok(r.summary().eventLimitExceeded > 0)
  assert.ok(decode(lines).some(x => x.evidenceIncomplete === true))
  for (const row of decode(lines).filter(x => x.kind === 'request-context')) { assert.ok(row.events.length <= 16); assert.notEqual(row.classification, 'downstream-cancel-proven') }
})

test('4KiB行预算、1MiB全轮预算：超额显式留证，不悄悄截断', () => {
  const lines = [], r = recorder(line => lines.push(line))
  // 合法的较大序号使边界不依赖执行机器上hrtime的字符串位数。
  for (let i = 0; i < 10000; i++) r.begin({ branch: 'http', method: 'GET', pathname: '/' })
  const flags = { reqComplete: false, reqAborted: false, resHeadersSent: false, resEnded: false, resDestroyed: false, upstreamDestroyed: false, headersReceived: false, reusedSocket: false }
  const c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  for (let i = 0; i < 14; i++) c.event('downstream-finish', flags)
  c.error({ code: 'ECONNRESET' }, 'upstream-error', flags)
  assert.ok(r.summary().lineLimitExceeded > 0, '必须真实触发固定4KiB行上限')
  for (let i = 0; i < 4000; i++) { const x = r.begin({ branch: 'http', method: 'GET', pathname: '/' }); x.error({ code: 'ECONNRESET' }); x.event('downstream-close'); x.event('upstream-close') }
  assert.ok(r.summary().totalLimitExceeded > 0); assert.equal(r.summary().evidenceIncomplete, true)
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 4096))
  assert.ok(lines.reduce((n, line) => n + Buffer.byteLength(line), 0) <= 1024 * 1024)
  assert.equal(r.summary().bytesWritten, lines.reduce((n, line) => n + Buffer.byteLength(line), 0))
  evidence('budgets', { summary: r.summary(), maxLineBytes: Math.max(...lines.map(x => Buffer.byteLength(x))) })
})

test('先有关闭与localReason，但未知错误仍不得标为已证明取消', () => {
  const lines = [], r = recorder(line => lines.push(line)), c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  c.event('downstream-close', { resEnded: false }); c.destroy('downstream-response-close-before-end')
  c.error({ code: 'PRIVATE_UNKNOWN', message: 'SECRET_MESSAGE' })
  assert.equal(decode(lines).find(x => x.phase === 'error').classification, 'upstream-or-unknown')
})

test('写失败也占用尝试字节预算，部分写入不能突破全轮1MiB', () => {
  let attempted = 0
  const r = recorder(line => { attempted += Buffer.byteLength(line); throw new Error('SECRET_PARTIAL_WRITE') })
  for (let i = 0; i < 4000; i++) { const c = r.begin({ branch: 'http', method: 'POST', pathname: '/' }); c.error({ code: 'ECONNRESET' }) }
  assert.ok(attempted <= 1024 * 1024, '失败/部分写入仍须预留真实请求字节')
  assert.equal(r.summary().evidenceIncomplete, true); assert.ok(r.summary().writeFailures > 0)
  evidence('partial-write-budget', { attempted, summary: r.summary() })
})

test('同一请求先未知error再已知error，不能用后者覆盖首错换取取消归因', () => {
  const lines = [], r = recorder(line => lines.push(line)), c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  c.event('downstream-close', { resEnded: false }); c.destroy('downstream-response-close-before-end')
  c.error({ code: 'UNKNOWN' }); c.error({ code: 'ECONNRESET' }); c.event('upstream-close')
  assert.ok(decode(lines).filter(x => x.kind === 'request-context').every(x => x.classification === 'upstream-or-unknown'))
})

test('真实URL解析错误也有other上下文，不能漏记成上下文完整', { timeout: 10000 }, async t => {
  const h = await harness(t, 'malformed-url')
  const c = h.request({ route: 'http://[SECRET_INVALID' })
  assert.equal((await bound(c.result, 'malformed-result')).status, 500); await bound(c.closed, 'malformed-close')
  assert.equal(h.rawErrors.length, 1)
  const ctx = contexts(h).find(x => x.phase === 'error'); assert.ok(ctx, 'handler错误必须绑定内部上下文')
  assert.equal(ctx.route, 'other'); assert.equal(ctx.classification, 'upstream-or-unknown'); assert.ok(!h.lines.join('').includes('SECRET'))
})

test('真实写失败不遮盖原rawError、502、failed/status，summary明确incomplete', { timeout: 10000 }, async t => {
  const h = await harness(t, 'write-failure-original-result', { writeFail: true, diskLog: true })
  const c = h.request(); await h.arrived(1); h.requests[0].req.socket.end()
  assert.equal((await bound(c.result, 'writefail-result')).status, 502); await bound(c.closed, 'writefail-close')
  assert.equal(h.rawErrors.length, 1); assert.equal(h.rawErrors[0].message, 'socket hang up')
  assert.equal(h.getFailed(), false); assert.equal(h.observer?.summary().evidenceIncomplete, true)
  assert.ok(h.observer.summary().writeFailures > 0); assert.equal(h.lines.length, 0)
  assert.match(fs.readFileSync(h.logPath, 'utf8'), /^\d{4}-\d\d-\d\dT\S+ Error: socket hang up\n/m)
})

test('真实同文件prefix上下文紧邻原UTC+stack，闭包字段与旧错误不改写', { timeout: 10000 }, async t => {
  const h = await harness(t, 'same-file-raw-binding', { diskLog: true })
  const c = h.request(); await h.arrived(1); h.requests[0].req.socket.end()
  assert.equal((await bound(c.result, 'paired-result')).status, 502); await bound(c.closed, 'paired-close'); await h.finished(1)
  const log = fs.readFileSync(h.logPath, 'utf8'), rows = log.split('\n')
  const rawIndex = rows.findIndex(line => /^\d{4}-\d\d-\d\dT\S+ Error: socket hang up$/.test(line))
  assert.ok(rawIndex > 0); assert.ok(rows[rawIndex - 1].startsWith(prefix))
  const ctx = JSON.parse(rows[rawIndex - 1].slice(prefix.length))
  assert.equal(ctx.phase, 'error'); assert.equal(ctx.rawErrorExpected, true); assert.equal(ctx.requestSeq, 1)
  assert.equal(ctx.classification, 'upstream-or-unknown'); assert.equal(ctx.route, 'api:hermes_sessions_list')
  assert.ok(log.includes(h.rawErrors[0].stack + '\n'))
  evidence('same-file-projection', { sha256: sha(log), rawErrorRecords: h.rawErrors.length, pairedRequestSeq: ctx.requestSeq, rawFormatPreserved: true, contextLines: rows.filter(x => x.startsWith(prefix)).length })
})

test('接线保留原rawError格式/pipe/destroy/门禁与stop完整性统计', () => {
  assert.ok(source.includes("`${stamp()} ${error.stack || error}\\n`"), '原UTC+stack格式不可改')
  assert.ok(source.includes("agent: false, headers: { ...req.headers, host: `127.0.0.1:${webPort}` }"))
  assert.ok(source.includes('res.writeHead(response.statusCode, response.headers); response.pipe(res)'))
  assert.ok(source.includes("stop.status = !failed && stop.productionStop && stop.pidsExited && stop.webExited && stop.portsClosed ? 'passed' : 'failed'"))
  assert.ok(/stop\.proxyContext\s*=\s*proxyContext\.summary\(\)/.test(source))
  assert.ok(/const proxyContext = createProxyContextRecorder\(/.test(source))
  assert.deepEqual(bootstrap.PROXY_CONTEXT_LIMITS, { eventsPerRequest: 16, lineBytes: 4096, totalBytes: 1048576 })
})

test('R31规模正常请求只统计并释放ring，400请求不占上下文日志预算', () => {
  const lines = [], r = recorder(line => lines.push(line))
  for (let i = 0; i < 400; i++) { const c = r.begin({ branch: 'http', method: 'GET', pathname: '/' }); c.event('request-end', { reqComplete: true }); c.event('response-headers'); c.event('response-end'); c.event('downstream-finish', { resEnded: true }); c.event('downstream-close', { resEnded: true }); c.event('upstream-close') }
  assert.equal(r.summary().requests, 400); assert.equal(r.summary().closedRequests, 400)
  assert.equal(lines.length, 0, '正常请求仅统计，不产生逐请求或逐事件流水')
  assert.equal(r.summary().evidenceIncomplete, false)
})

test('未知source/phase不冒充已知来源，错误只读code不读取秘密message/stack', () => {
  const lines = [], r = bootstrap.createProxyContextRecorder({ appendLine: line => lines.push(line), sourceSha: 'SECRET_SOURCE' })
  const c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  c.event('downstream-close', { resEnded: false }); c.destroy('downstream-response-close-before-end')
  c.error({ code: 'ECONNRESET', get message() { throw new Error('SECRET_MESSAGE') }, get stack() { throw new Error('SECRET_STACK') } }, 'SECRET_PHASE')
  const ctx = decode(lines).find(x => x.phase === 'error')
  assert.equal(ctx.errorPhase, 'unknown-error'); assert.equal(ctx.sourceSha, 'unknown')
  assert.equal(ctx.classification, 'upstream-or-unknown'); assert.equal(ctx.evidenceIncomplete, true)
  assert.ok(!lines.join('').includes('SECRET'))
})

test('终态未收到双端close不得把上下文统计说完整；不增加等待或改变transport', () => {
  const r = recorder(() => {}), c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  assert.equal(r.summary().openRequests, 1); assert.equal(r.summary().evidenceIncomplete, true)
  c.event('downstream-close', { resEnded: true }); c.event('upstream-close')
  assert.equal(r.summary().openRequests, 0); assert.equal(r.summary().evidenceIncomplete, false)
})

test('r2 翻转getter：branch/method/flag捕获一次再判型投影，不泄漏第二读canary', async t => {
  for (const mode of ['branch', 'method', 'flag']) await t.test(mode, () => {
    const lines = [], r = recorder(line => lines.push(line))
    let reads = 0
    const input = { branch: 'http', method: 'POST', pathname: '/' }, flags = {}
    Object.defineProperty(mode === 'flag' ? flags : input, mode === 'flag' ? 'reqComplete' : mode, {
      get() { reads++; return reads === 1 ? (mode === 'flag' ? true : mode === 'branch' ? 'http' : 'POST') : `CANARY_PRIVATE_${mode}` },
    })
    const c = r.begin(input)
    c.event('request-end', flags); c.error({ code: 'ECONNRESET' })
    c.event('downstream-close', { resEnded: true }); c.event('upstream-close')
    const rows = decode(lines).filter(x => x.kind === 'request-context')
    evidence(`r2-getter-${mode}`, { reads, rows, summary: r.summary() })
    assert.equal(reads, 1, '判型与赋值必须使用同一次property读取')
    assert.ok(!lines.join('').includes('CANARY_PRIVATE'))
    assert.ok(rows.every(x => x.branch === 'http' && x.method === 'POST'))
    if (mode === 'flag') assert.equal(rows[0].events.find(x => x.kind === 'request-end').reqComplete, true)
    assert.equal(r.summary().evidenceIncomplete, false)
  })
})

test('r2 未知或throw的安全字段sticky不完整且不抛，不读取秘密message/stack', async t => {
  for (const mode of ['branch', 'method', 'flag']) for (const throwing of [false, true]) await t.test(`${mode}-${throwing ? 'throw' : 'unknown'}`, () => {
    const lines = [], r = recorder(line => lines.push(line)), input = { branch: 'http', method: 'POST', pathname: '/' }, flags = {}
    let reads = 0
    Object.defineProperty(mode === 'flag' ? flags : input, mode === 'flag' ? 'reqComplete' : mode, { get() {
      reads++; if (throwing) throw new Error('CANARY_PRIVATE_THROW'); return 'CANARY_PRIVATE_UNKNOWN'
    } })
    let c
    assert.doesNotThrow(() => { c = r.begin(input); c.event('request-end', flags); c.error({ code: 'ECONNRESET' }); c.event('downstream-close', { resEnded: true }); c.event('upstream-close') })
    evidence(`r2-invalid-${mode}-${throwing}`, { reads, rows: decode(lines), summary: r.summary() })
    assert.equal(reads, 1); assert.equal(r.summary().evidenceIncomplete, true)
    assert.ok(r.summary().observerFailures > 0)
    assert.ok(!lines.join('').includes('CANARY_PRIVATE'))
    assert.ok(decode(lines).filter(x => x.kind === 'request-context').every(x => x.classification === 'upstream-or-unknown'))
  })
})

test('r2 error.code保持一次捕获，秘密字段getter不被读取', () => {
  const lines = [], r = recorder(line => lines.push(line)), c = r.begin({ branch: 'http', method: 'POST', pathname: '/' })
  let reads = 0
  c.error({ get code() { return ++reads === 1 ? 'ECONNRESET' : 'CANARY_PRIVATE_CODE' }, get message() { throw new Error('CANARY_PRIVATE_MESSAGE') }, get stack() { throw new Error('CANARY_PRIVATE_STACK') } })
  c.event('downstream-close', { resEnded: true }); c.event('upstream-close')
  assert.equal(reads, 1); assert.ok(!lines.join('').includes('CANARY_PRIVATE'))
  assert.equal(decode(lines).find(x => x.phase === 'error').errorCode, 'ECONNRESET')
})

test('r2 真实action内层catch：HTTP200不掩盖failed/rawError与同request handler-error', { timeout: 10000 }, async t => {
  for (const mode of ['bad-request', 'bad-response', 'write-failure', 'valid']) await t.test(mode, async tt => {
    const writeFail = mode === 'write-failure', badRequest = mode === 'bad-request' || writeFail
    const h = await harness(tt, `r2-action-${mode}`, { writeFail, diskLog: !writeFail })
    const body = Buffer.from(badRequest ? '{' : '{"action":"start"}')
    const c = h.request({ route: '/__api/hermes_gateway_action', body })
    await h.arrived(1); h.requests[0].res.end(mode === 'bad-response' ? '{' : '{}')
    const response = await bound(c.result, 'r2-action-response'); await bound(c.closed, 'r2-action-close'); await h.finished(1)
    const expectedErrors = badRequest ? 2 : mode === 'bad-response' ? 1 : 0
    assert.equal(response.status, 200); assert.equal(response.body.toString(), mode === 'bad-response' ? '{' : '{}')
    assert.equal(h.getFailed(), expectedErrors > 0); assert.equal(h.rawErrors.length, expectedErrors)
    assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0].sha256, sha(body))
    const summary = h.observer.summary(), errors = contexts(h).filter(x => x.phase === 'error')
    evidence(`r2-action-result-${mode}`, { status: response.status, failed: h.getFailed(), rawErrors: h.rawErrors.length, errors, summary })
    assert.equal(summary.errors, expectedErrors, '原rawError不能在上下文摘要中静默丢失')
    if (writeFail) { assert.equal(h.lines.length, 0); assert.equal(summary.evidenceIncomplete, true); assert.ok(summary.writeFailures > 0) }
    else {
      assert.equal(summary.evidenceIncomplete, false); assert.equal(errors.length, expectedErrors)
      assert.ok(errors.every(x => x.requestSeq === 1 && x.route === 'api:hermes_gateway_action' && x.errorPhase === 'handler-error' && x.rawErrorExpected === true && x.classification === 'upstream-or-unknown'))
      if (expectedErrors) {
        const log = fs.readFileSync(h.logPath, 'utf8'), rows = log.split('\n')
        const rawIndices = rows.flatMap((line, i) => /^\d{4}-\d\d-\d\dT\S+ SyntaxError:/.test(line) ? [i] : [])
        assert.equal(rawIndices.length, expectedErrors)
        for (const i of rawIndices) {
          assert.ok(i > 0 && rows[i - 1].startsWith(prefix))
          const row = JSON.parse(rows[i - 1].slice(prefix.length)); assert.equal(row.requestSeq, 1); assert.equal(row.errorPhase, 'handler-error')
        }
        for (const error of h.rawErrors) assert.ok(log.includes(error.stack + '\n'), '原UTC+完整stack字节保留')
      }
    }
  })
})
