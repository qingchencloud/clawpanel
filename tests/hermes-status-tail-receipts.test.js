// 先红后实现：仅协议/真实自有Node child；不是Hermes、原生UI或VM资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { createHermesExecFileObserver } from '../scripts/hermes-exec-observation.mjs'
import { assertGatewayStatusReadback } from '../scripts/test-hermes-windows-qualification.mjs'

const sourceSha = 'a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899'
const prefix = 'CLAWPANEL_HERMES_STATUS_TAIL '
const tails = ['_print_duplicate_credential_warnings', '_print_other_profiles_gateway_status', '_print_standalone_by_config']
const steps = [['observer', 'enter'], ...tails.flatMap(n => [[n, 'enter'], [n, 'return']]), ['observer', 'return']]
const load = () => import('../scripts/hermes-status-tail-receipts.mjs')
function input() {
  return steps.map(([target, event], index) => ({ schemaVersion: 1, scope: 'hermes-status-tail-diagnostic', target, event, pid: 103, ppid: 102, sequence: index + 1, elapsedMs: index, utc: '2026-10-17T03:00:00.000000+00:00', moduleSha256: sourceSha }))
}
function phase(pid, ppid, name) { return 'CLAWPANEL_HERMES_PHASE ' + JSON.stringify({ schemaVersion: 1, scope: 'launch', phase: name, pid, ppid, sequence: 1, elapsedMs: 0, deltaMs: 0 }) + '\n' }
function stderr(rows = input()) {
  return phase(102, 101, 'entry') + phase(103, 102, 'entry') + rows.map((r, i) => (i === 1 ? phase(103, 102, 'main_b') : '') + prefix + JSON.stringify(r) + '\n').join('') + phase(103, 102, 'main_exit')
}

test('尾收据只接同一次stderr的完整8事件，独立时钟不混_hp，永不qualification', async () => {
  const m = await load(), r = m.decodeStatusTailObservation(stderr(), { rootPid: 101 })
  assert.equal(r.diagnosticValid, true); assert.equal(r.qualificationPass, false)
  assert.equal(r.pid, 103); assert.equal(r.ppid, 102); assert.equal(r.events.length, 8)
  assert.deepEqual(r.tails.map(x => [x.target, x.intervalMs]), tails.map(x => [x, 1]))
  assert.equal(r.clockScope, 'one observer PID/perf origin; not _hp elapsed clock')
  assert.equal(m.decodeStatusTailObservation(stderr().replaceAll('\n', '\r\n'), { rootPid: 101 }).diagnosticValid, true)
})

test('来源/字段/clock/顺序/PID/父链/闭合/重复JSON/预算坏材料逐项拒绝', async () => {
  const m = await load(), mutations = [
    rows => { rows[2].pid = 999 }, rows => { rows[2].ppid = 999 },
    rows => { rows[2].moduleSha256 = 'b'.repeat(64) }, rows => { rows[2].event = 'raise' },
    rows => { rows[2].target = '_unknown' }, rows => { rows[2].sequence = 99 },
    rows => { rows[2].elapsedMs = -1 }, rows => { rows[0].elapsedMs = 0.1 },
    rows => { rows[2].elapsedMs = '2' }, rows => { rows[2].pid = true },
    rows => { rows[2].scope = 'qualified' }, rows => { rows[2].schemaVersion = 2 },
    rows => { rows[2].utc = '2026-02-31T03:00:00+00:00' }, rows => { rows[2].utc = '2026-10-17T03:00:00+01:00' },
    rows => { rows[2].secret = 'must-not-be-reported' }, rows => { rows.pop() }, rows => { rows.push(rows.at(-1)) },
  ]
  for (const mutate of mutations) { const rows = input(); mutate(rows); assert.throws(() => m.decodeStatusTailObservation(stderr(rows), { rootPid: 101 }), /STATUS_TAIL_/) }
  for (const text of [stderr().replace('"event":"return"', '"event":"raise","event":"return"'), stderr().replace(phase(102, 101, 'entry'), ''), stderr().replace(phase(103, 102, 'main_b'), ''), stderr().replace(phase(103, 102, 'main_exit'), ''), stderr() + prefix + ' '.repeat(1025) + '\n', 'x'.repeat(1048577), prefix + '{"bad":true}']) assert.throws(() => m.decodeStatusTailObservation(text, { rootPid: 101 }), /STATUS_TAIL_/)
  assert.throws(() => m.decodeStatusTailObservation(stderr(), { rootPid: 999 }), /STATUS_TAIL_/)
  // JSON.parse会覆盖转义拼写的重复key；原始协议必须连相同值也拒绝。
  assert.throws(() => m.decodeStatusTailObservation(stderr().replaceAll('"pid":103', '"pid":103,"p\\u0069d":103'), { rootPid: 101 }), /STATUS_TAIL_/)
})

test('真实自有execFile stderr收据与close，完整tail也不把原CLI失败改绿', async () => {
  const m = await load(), cases = []
  for (const hang of [false, true]) {
    const rows = [], observed = createHermesExecFileObserver(execFile, { write: row => rows.push(row) })
    const program = `const{performance}=require('node:perf_hooks');const S=${JSON.stringify(steps)},h=performance.now();let seq=0;const p=(name)=>process.stderr.write('CLAWPANEL_HERMES_PHASE '+JSON.stringify({schemaVersion:1,scope:'launch',phase:name,pid:process.pid,ppid:process.ppid,sequence:1,elapsedMs:performance.now()-h,deltaMs:0})+'\\n');p('entry');const t=performance.now();for(const[target,event]of S){if(seq===1)p('main_b');process.stderr.write(${JSON.stringify(prefix)}+JSON.stringify({schemaVersion:1,scope:'hermes-status-tail-diagnostic',target,event,pid:process.pid,ppid:process.ppid,sequence:++seq,elapsedMs:seq===1?0:performance.now()-t,utc:new Date().toISOString().replace('Z','+00:00'),moduleSha256:${JSON.stringify(sourceSha)}})+'\\n')}p('main_exit');process.stdout.write('owned Node protocol fixture, not Gateway\\n');${hang ? 'setTimeout(()=>{},2000)' : ''}`
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:SystemRoot|WINDIR|ComSpec|PATHEXT|Path)$/i.test(k)))
    let callback
    const child = observed(process.execPath, ['-e', program, '--', 'gateway', 'status'], { env, windowsHide: true, encoding: 'utf8', timeout: hang ? 300 : 5000, maxBuffer: 1048576 }, (error, stdout, errorText) => { callback = { failed: !!error, killed: error?.killed === true, stdout, stderr: errorText } })
    child.stdin?.end(); await once(child, 'close')
    const result = rows.find(row => row.event === 'execFile-result'), close = rows.find(row => row.event === 'execFile-close')
    assert.ok(result && close && callback); assert.equal(result.stderrTruncated, false)
    const parsed = m.decodeStatusTailObservation(result.stderr, { rootPid: child.pid })
    assert.equal(parsed.qualificationPass, false); assert.equal(parsed.diagnosticValid, true)
    assert.equal(callback.failed, hang); if (hang) assert.equal(callback.killed, true)
    if (hang) assert.throws(() => assertGatewayStatusReadback({ schemaVersion: 1, status: 'failed', requestFailed: true, exec: rows }), /STATUS_READBACK_/)
    cases.push({ scope: 'actual owned Node only, no kernel/GUI', hang, callback, observed: rows, parsed, actualChildClosed: true })
  }
  if (process.env.HERMES_STATUS_TAIL_RECEIPTS_EVIDENCE) { const out = path.resolve(process.env.HERMES_STATUS_TAIL_RECEIPTS_EVIDENCE); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'own-exec.json'), JSON.stringify({ qualificationPass: false, cases }, null, 2), { flag: 'wx' }) }
})
