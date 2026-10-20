// 先验证诊断的证据绑定和失败优先级；本测试不安装内核、不启动GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { collectStatusTailReadback, assertStatusTailReadback, qualificationStatus } from '../scripts/test-hermes-windows-qualification.mjs'

const phase = name => 'CLAWPANEL_HERMES_PHASE ' + JSON.stringify({ schemaVersion: 1, scope: 'launch', phase: name, pid: 101, ppid: 100 }) + '\n'
function sample() {
  const steps = [['observer', 'enter'], ...['_print_duplicate_credential_warnings', '_print_other_profiles_gateway_status', '_print_standalone_by_config'].flatMap(n => [[n, 'enter'], [n, 'return']]), ['observer', 'return']]
  const stderr = phase('entry') + steps.map(([target, event], i) => (i === 1 ? phase('main_b') : '') + 'CLAWPANEL_HERMES_STATUS_TAIL ' + JSON.stringify({ schemaVersion: 1, scope: 'hermes-status-tail-diagnostic', target, event, pid: 101, ppid: 100, sequence: i + 1, elapsedMs: i, utc: '2026-10-17T03:00:00+00:00', moduleSha256: 'a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899' }) + '\n').join('') + phase('main_exit')
  const common = { callId: 2, pid: 101, utc: '2026-10-17T03:00:00Z' }
  const stdout = 'Gateway is running (PID 99)\n'
  const events = [
    { ...common, event: 'execFile-start', command: ['gateway', 'status'] },
    { ...common, event: 'execFile-result', source: 'callback', error: null, signal: null, code: 0, killed: false, stdout, stdoutTruncated: false, stderr, stderrTruncated: false },
    { ...common, event: 'execFile-close', error: null, signal: null, code: 0, killed: false },
  ]
  return { readback: { schemaVersion: 1, status: 'passed', requestFailed: false, api: { cmd: 'hermes_gateway_action', status: 200, result: stdout }, exec: structuredClone(events) }, events }
}

test('同一次原exec收据绑定，诊断通过也只返回neverqualification', () => {
  const { readback, events } = sample(), r = collectStatusTailReadback({ readback, execEvents: events })
  assertStatusTailReadback(readback, r)
  assert.equal(r.status, 'diagnostic-only-not-qualification'); assert.equal(r.qualificationPass, false)
  assert.equal(r.originalCliPassed, true); assert.equal(r.observation.events.length, 8)
  assert.equal(r.stderr.bytes, Buffer.byteLength(events[1].stderr)); assert.match(r.stderr.sha256, /^[a-f0-9]{64}$/)
  assert.equal(qualificationStatus({ gatewayStatusReadback: readback, diagnostic: { enabled: true }, hostUnchanged: true }), 'diagnostic-only-not-qualification')
})

test('原CLI失败优先；完整tail不洗绿；缺失/截断/异callId/异PID/重复callback均红', () => {
  const { readback, events } = sample()
  readback.status = 'failed'; readback.requestFailed = true
  const r = collectStatusTailReadback({ readback, execEvents: events })
  assert.equal(r.originalCliPassed, false); assert.equal(r.observation.diagnosticValid, true); assert.equal(r.status, 'failed')
  assert.throws(() => assertStatusTailReadback(readback, r), /STATUS_READBACK_/)
  for (const modify of [es => { es[1].stderrTruncated = true }, es => { es[1].callId++ }, es => { es[1].pid++ }, es => { es[1].stderr = '' }, es => { es.push(es[1]) }, es => { es[1].stderr = 'token=private-no-echo' }]) {
    const next = sample(); modify(next.events)
    const bad = collectStatusTailReadback({ readback: next.readback, execEvents: next.events })
    assert.equal(bad.status, 'failed'); assert.equal(bad.qualificationPass, false)
    assert.throws(() => assertStatusTailReadback(next.readback, bad), /STATUS_TAIL_/)
    assert.ok(!JSON.stringify(bad).includes('private-no-echo'))
  }
})

test('接线保留原一次status与预算/清理，显式子环境启用，不进入浏览器和生命周期', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes("env.CLAWPANEL_HERMES_STATUS_TAIL_DIAGNOSTIC = '1'"))
  assert.ok(source.includes("'scripts/hermes-status-tail-receipts.mjs'"))
  assert.ok(source.includes('r.statusTailReadback = collectStatusTailReadback('))
  assert.ok(source.includes('assertStatusTailReadback(r.gatewayStatusReadback, r.statusTailReadback)'))
  assert.ok(source.includes('if (!diagnostic && !statusTailDiagnostic)'))
  assert.ok(!source.includes('status tail diagnostic wiring not yet qualified for execution'))
  assert.ok(source.includes('executionWiringReady: true'))
})
