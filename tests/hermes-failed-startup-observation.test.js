import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'

test('启动已失败后的真实TCP/HTTP观察只解释晚就绪，不补绿、不重新启动', async t => {
  const q = await import('../scripts/test-hermes-windows-qualification.mjs')
  assert.equal(typeof q.observeFailedGatewayStartup, 'function')
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end('{"status":"ok","platform":"hermes-agent","version":"0.22.2"}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port, original = { status: 'failed', error: 'original start deadline', stages: [{ status: 'failed' }] }, before = structuredClone(original)
  let probes = 0
  const result = await q.observeFailedGatewayStartup({
    isOpen: async () => { probes++; return new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) }) },
    readHealth: async () => (await fetch(`http://127.0.0.1:${port}/health`)).json(),
  })
  assert.equal(result.scope, 'post-failure-observation-not-acceptance'); assert.equal(result.qualificationPass, false)
  assert.equal(result.becameReachable, true); assert.equal(result.health.status, 'ok'); assert.equal(requests, 1); assert.equal(probes, 1)
  assert.deepEqual(original, before)
  const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /r.error = e.stack;[\s\S]*?r.failedStartupObservation = await observeFailedGatewayStartup/)
  assert.match(source, /if \(env && !stopped\) \{ try \{ await capturePids\(\)/)
})

test('观察预算有界，未就绪仍明确false；原生产启动/健康超时不变', async () => {
  const { observeFailedGatewayStartup } = await import('../scripts/test-hermes-windows-qualification.mjs')
  let time = 0, probes = 0, health = 0
  const result = await observeFailedGatewayStartup({ isOpen: async () => { probes++; return false }, readHealth: async () => { health++; throw Error('not reached') }, now: () => time, pause: async ms => { time += ms } })
  assert.equal(time, 20000); assert.ok(probes <= 40); assert.equal(health, 0); assert.equal(result.becameReachable, false); assert.equal(result.qualificationPass, false)
})
