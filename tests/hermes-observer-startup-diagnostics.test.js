// 只验证诊断可见性和原失败语义；不是实际Hermes或历史CI根因复现。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { startFixtureObserverTransport, startWindowsFixtureProcessObserver } from '../scripts/hermes-cli-bounds-observation.mjs'

const phases = ['script-entry', 'bindings-begin', 'bindings-ready', 'warmup-begin', 'warmup-end', 'json-warmup-end']
const write = (name, value) => { const dir = process.env.HERMES_BOUNDS_TEST_EVIDENCE; if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2)) } }
function ownChild(t, source, name) {
  const witness = { requestedAtMs: Date.now(), events: [], stdout: { bytes: 0 }, stderr: { bytes: 0 } }
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  witness.returnedAtMs = Date.now(); witness.pid = child.pid
  child.once('spawn', () => witness.events.push({ event: 'spawn', atMs: Date.now() }))
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => { const s = witness[stream]; s.firstAtMs ??= Date.now(); s.lastAtMs = Date.now(); s.bytes += data.length })
  child.once('exit', (code, signal) => witness.events.push({ event: 'exit', atMs: Date.now(), code, signal }))
  const closed = new Promise(resolve => child.once('close', (code, signal) => { witness.events.push({ event: 'close', atMs: Date.now(), code, signal }); resolve() }))
  const report = { scope: 'real own Node transport fixture, no native PID inspection', witness }
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; report.finalKilled = child.killed; write(name, report) })
  return { child, closed, report }
}
function assertBounded(diagnostic) {
  assert.equal(diagnostic.event, 'hermes-observer-diagnostic')
  assert.equal(diagnostic.startupBudgetMs, 7000); assert.equal(diagnostic.requestBudgetMs, 2000)
  const line = JSON.stringify(diagnostic)
  assert.ok(Buffer.byteLength(line) <= 8192)
  assert.doesNotMatch(line, /SECRET_|TOKEN|argv|NODE_OPTIONS|executablePath/)
  assert.equal(diagnostic.eventOverflow, false)
  return line
}

test('真实never-ready：原7秒红灯保留，诊断含实际spawn/流/timeout/exit/close而非TAP倒推', { timeout: 11000 }, async t => {
  const { child, report, closed } = ownChild(t, `console.error('SECRET_STDERR_CANARY');process.stdin.resume()`, 'startup-never-ready.json')
  const delivered = []; let failure
  try { await startFixtureObserverTransport(child, { onDiagnostic: row => delivered.push(row) }) } catch (e) { failure = e }
  await closed
  assert.ok(failure); assert.match(failure.message, /startup timeout/)
  const d = failure.observerDiagnostic; report.diagnostic = d
  assert.ok(d, '原始超时错误必须携带真实收据，不能仅有空stderr后缀')
  assertBounded(d); assert.equal(d.reason, 'startup-timeout'); assert.equal(d.pid, child.pid)
  assert.equal(delivered.length, 1); assert.equal(d.terminal, true)
  const at = event => d.events.find(e => e.event === event)
  for (const event of ['transport-start', 'spawn', 'startup-timer', 'failure', 'exit', 'close']) assert.ok(at(event), event)
  assert.ok(at('failure').elapsedMs - at('startup-timer').elapsedMs >= 6900)
  assert.ok(at('close').atMs >= at('failure').atMs)
  assert.equal(d.streams.stdout.bytes, 0); assert.equal(d.streams.stderr.bytes, report.witness.stderr.bytes)
  assert.ok(d.streams.stderr.firstAtMs >= report.witness.requestedAtMs)
  assert.equal(d.streams.stderr.sha256, createHash('sha256').update('SECRET_STDERR_CANARY\n').digest('hex'))
  assert.equal(d.close.killed, true); assert.equal(d.readyAtMs, null)
})

test('真实early-exit7：退出不误报timeout，保留原错误和实际code/signal/流时点', { timeout: 5000 }, async t => {
  const { child, report, closed } = ownChild(t, `console.error('fixture-bootstrap-failure');process.exit(7)`, 'startup-early-exit.json')
  let failure; try { await startFixtureObserverTransport(child, { onDiagnostic() {} }) } catch (e) { failure = e }
  await closed; assert.ok(failure); assert.match(failure.message, /closed 7\/null/)
  const d = failure.observerDiagnostic; report.diagnostic = d; assert.ok(d)
  assertBounded(d); assert.equal(d.reason, 'child-close'); assert.equal(d.close.code, 7); assert.equal(d.close.signal, null); assert.equal(d.close.killed, false)
  assert.ok(d.events.find(e => e.event === 'exit')); assert.equal(d.streams.stderr.bytes, report.witness.stderr.bytes)
})

test('真实phase/ready/snapshot：仅固定同PID phase，原响应不替换且close可读', { timeout: 5000 }, async t => {
  const code = `import{createInterface}from'node:readline';for(const phase of ${JSON.stringify(phases)})console.log(JSON.stringify({event:'observer-phase',protocol:1,phase,pid:process.pid,atMs:Date.now()}));console.log(JSON.stringify({event:'ready',protocol:1}));createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);console.log(JSON.stringify({id:r.id,processes:r.pids.map(pid=>({pid,marker:'transport-fixture-not-native'}))}))})`
  const { child, report } = ownChild(t, code, 'startup-phase-success.json')
  const observer = await startFixtureObserverTransport(child); t.after(() => observer.close())
  const sample = await observer.snapshot([process.pid]); assert.deepEqual(sample.processes, [{ pid: process.pid, marker: 'transport-fixture-not-native' }])
  await observer.close(); const d = observer.getDiagnostic(); report.diagnostic = d
  assertBounded(d); assert.deepEqual(d.events.filter(e => e.event === 'phase').map(e => e.phase), phases)
  assert.equal(d.reason, 'normal-close'); assert.equal(d.close.code, 0); assert.equal(d.close.killed, false)
  assert.ok(d.readyAtMs); assert.ok(d.streams.stdout.firstAtMs <= d.readyAtMs)
})

test('真实诊断writer抛错：仍返回原exit7错误，不重试/替换/泄露writer正文', { timeout: 5000 }, async t => {
  const { child, report, closed } = ownChild(t, `process.exit(7)`, 'startup-writer-failure.json')
  let failure; try { await startFixtureObserverTransport(child, { onDiagnostic() { throw Error('SECRET_WRITER') } }) } catch (e) { failure = e }
  await closed; assert.match(failure.message, /closed 7\/null/); assert.doesNotMatch(failure.message, /SECRET_WRITER/)
  const d = failure.observerDiagnostic; report.diagnostic = d; assert.ok(d); assertBounded(d)
  assert.equal(d.deliveryFailed, true); assert.equal(d.close.code, 7)
})

test('真实伪phase PID：不能当ready或借诊断改变协议失败', { timeout: 5000 }, async t => {
  const { child, report, closed } = ownChild(t, `console.log(JSON.stringify({event:'observer-phase',protocol:1,phase:'script-entry',pid:process.pid+1,atMs:Date.now()}));process.stdin.resume()`, 'startup-invalid-phase.json')
  let failure; try { await startFixtureObserverTransport(child, { onDiagnostic() {} }) } catch (e) { failure = e }
  await closed; assert.match(failure.message, /phase protocol mismatch/)
  report.diagnostic = failure.observerDiagnostic; assertBounded(report.diagnostic); assert.equal(report.diagnostic.readyAtMs, null)
})

test('真实请求超时后finally close：首错与默认stdout诊断都保留，不被正常清理标记吞掉', { timeout: 5000 }, async t => {
  const { child, report } = ownChild(t, `console.log(JSON.stringify({event:'ready',protocol:1}));process.stdin.resume()`, 'request-timeout-close.json')
  const lines = [], mock = t.mock.method(console, 'log', line => lines.push(String(line)))
  let observer, failure
  try {
    observer = await startFixtureObserverTransport(child)
    await assert.rejects(observer.snapshot([process.pid]), e => { failure = e; return /observation timeout/.test(e.message) })
    await observer.close()
  } finally { mock.mock.restore(); await observer?.close() }
  const diagnostics = lines.filter(line => line.startsWith('{"event":"hermes-observer-diagnostic"')).map(line => JSON.parse(line))
  assert.equal(diagnostics.length, 1, '原错误之后的finally不能吞掉独立诊断行')
  const d = diagnostics[0]; report.diagnostic = d; assertBounded(d); assert.equal(d.reason, 'request-timeout')
  await assert.rejects(observer.snapshot([process.pid]), e => e === failure)
  assert.equal(d.close.killed, true)
  const exit = d.events.find(e => e.event === 'exit'); assert.ok(exit); assert.ok(Object.hasOwn(exit, 'code')); assert.ok(Object.hasOwn(exit, 'signal'))
})

test('Windows实际startup：固定脚本阶段/真实spawn与close可读，不增加任何主体PID查询', { timeout: 11000 }, async t => {
  if (process.platform !== 'win32') { t.skip('需要Windows PowerShell'); return }
  let observer; t.after(async () => { await observer?.close() })
  observer = await startWindowsFixtureProcessObserver()
  const live = observer.getDiagnostic(); assert.ok(live.readyAtMs)
  assert.deepEqual(live.events.filter(e => e.event === 'phase').map(e => e.phase), phases)
  assert.ok(live.launch.requestedAtMs <= live.launch.returnedAtMs); assert.ok(live.events.some(e => e.event === 'spawn'))
  await observer.close(); const d = observer.getDiagnostic(); assertBounded(d)
  assert.equal(d.reason, 'normal-close'); assert.equal(d.close.code, 0); assert.equal(d.close.killed, false)
  write('startup-native-real.json', { scope: 'actual Windows observer startup only; zero subject snapshot calls', diagnostic: d })
})
