// 清理只证明旧创建身份消失；原raw存活结果和真实CI首红不得覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-cli-cleanup-ci1b6b061.json', import.meta.url), 'utf8'))
const load = () => import('../scripts/hermes-cli-owned-identity.mjs')
const B = 1792186730000, epoch = 116444736000000000n
const hex = ms => (epoch + BigInt(ms) * 10000n).toString(16).padStart(16, '0')
const copy = structuredClone
const native = (pid, birth = B + pid, at = B + 100) => ({ pid, status: 'running', creationTimeFileTimeHex: hex(birth), createdAtMs: birth, exitAtMs: 0, sampledAtMs: at, queryStartedAtMs: at, queryCompletedAtMs: at, belongsToFixture: true, nativeError: 0, imageQueryError: 0, waitResult: 258 })
const missing = pid => ({ pid, status: 'missing', sampledAtMs: B + 1000, queryStartedAtMs: B + 1000, queryCompletedAtMs: B + 1000, creationTimeFileTimeHex: null, createdAtMs: 0, exitAtMs: 0, nativeError: 87, imageQueryError: 0, waitResult: 4294967295 })
function material() {
  const events = [1, 2, 3].map(pid => ({ event: 'start', pid, name: 'burst-' + pid, at: B + 20, monotonicMs: 20, birthId: 'birth-' + pid }))
  return { events, historyNativeRows: events.map(s => native(s.pid)), cleanupNativeRows: events.map(s => native(s.pid, B + s.pid, B + 1000)),
    rawProbes: events.map((s, i) => ({ pid: s.pid, alive: true, errorCode: null, startedAtMs: B + 1100, completedAtMs: B + 1100, startedAtNs: String(1100000000 + i * 10000), completedAtNs: String(1100001000 + i * 10000) })),
    rawOrder: { kind: 'captured-after-final-native', nativeCompletedAtMs: B + 1001, startedAtMs: B + 1100, completedAtMs: B + 1101 }, observerErrors: [] }
}
async function gate(m, nativeIdentityAvailable = true) {
  const { qualifyFixtureCleanup } = await load()
  assert.equal(typeof qualifyFixtureCleanup, 'function')
  const r = qualifyFixtureCleanup(m, { nativeIdentityAvailable })
  assert.equal(r.allOldFixtureIdentitiesAbsent, true, JSON.stringify(r))
  return r
}
function actualMaterial() {
  return { events: saved.cleanup.map(r => r.receipt), historyNativeRows: saved.peak.proofs.filter(p => p.pid === 1856).map(p => ({ pid: p.pid, ...p.baseline })),
    cleanupNativeRows: copy(saved.cleanup), rawProbes: saved.cleanup.map(r => ({ pid: r.pid, alive: r.rawAlive })), observerErrors: [],
    // 不伪造UTC或ESRCH：冻结源码先await整个snapshot，再同步map kill0；仅此下界有证据。
    rawOrder: { kind: 'frozen-source-order-lower-bound', sourceSha: saved.provenance.sourceSha, sourceTestSha256: saved.provenance.boundsTestSha256,
      notBeforeMs: Math.max(...saved.cleanup.map(r => r.queryCompletedAtMs)) - 1, awaitFinalNativeBeforeRaw: true } }
}

test('真实1b6原样清理收据：原all raw inactive断言必红，PID1856替代身份原样保留', () => {
  assert.equal(saved.provenance.runId, 38970520687)
  assert.equal(saved.cleanup.length, 8)
  assert.throws(() => assert.ok(saved.cleanup.every(p => !p.alive)), { code: 'ERR_ASSERTION' })
  assert.equal(saved.cleanup[0].rawAlive, true)
  assert.equal(saved.cleanup[0].nativeOwnedActive, false)
  assert.equal(saved.cleanup[0].creationTimeFileTimeHex, '01dd5db6c5eb6d05')
})

test('HTTP finally接线：保留原raw采集和独立peak门禁，只按清理旧创建身份判定', () => {
  const source = fs.readFileSync(new URL('./hermes-cli-bounds.test.js', import.meta.url), 'utf8')
  assert.match(source, /report\.cleanupGate = qualifyFixtureCleanup\(/)
  assert.match(source, /assert\.ok\(report\.cleanupGate\.allOldFixtureIdentitiesAbsent/)
  assert.match(source, /rawAlive, alive: rawAlive, nativeOwnedActive: row\.active/)
  assert.match(source, /assert\.ok\(peak <= 2,/)
  assert.match(source, /assert\.ok\(report\.nativePeak <= 2,/)
  assert.match(source, /const sink = \{ count: 0, probes: \[\] \}/)
  assert.doesNotMatch(source, /taskkill|process\.kill\([^,]+,\s*['"]SIG/)
})

test('真实1b6完整回放：只有旧fixture已消失，raw1856仍活跃；短任务missing87不补造baseline/ESRCH', async () => {
  const m = actualMaterial(), before = copy(m), r = await gate(m)
  assert.deepEqual(m, before)
  assert.equal(r.rawAliveCount, 1)
  assert.equal(r.rows[0].proof.kind, 'replacement-born-before-raw')
  assert.equal(r.rows[0].rawAlive, true)
  assert.equal(r.rows[0].oldFixtureIdentityAbsent, true)
  assert.equal(r.rawTiming, 'source-order-lower-bound-not-captured-raw-time')
  assert.ok(r.rows.slice(1).every(p => p.proof.kind === 'explicit-native-missing-before-raw'))
  assert.equal(m.rawProbes[6].errorCode, undefined)
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-real-ci-replay.json'), JSON.stringify({ provenance: saved.provenance, result: r }, null, 2))
})

test('清理反例：三个当前创建身份活跃，即使nativeOwnedActive全false也仍红', async () => {
  const m = material(); m.cleanupNativeRows.forEach(r => { r.nativeOwnedActive = false; r.active = false })
  await assert.rejects(gate(m), { code: 'ERR_ASSERTION' })
})

for (const [label, mutate] of [
  ['缺旧baseline', m => { m.historyNativeRows = [] }],
  ['只有foreign镜像而无替代出生', m => { m.cleanupNativeRows.forEach(r => { r.belongsToFixture = false; r.nativeOwnedActive = false }) }],
  ['替代出生晚于raw', m => { m.cleanupNativeRows[0] = { ...native(1, B + 1101, B + 1200), belongsToFixture: false } }],
  ['替代出生正好raw下界', m => { m.cleanupNativeRows[0] = { ...native(1, B + 1100, B + 1100), belongsToFixture: false }; m.rawOrder.nativeCompletedAtMs = B + 1100 }],
  ['未知状态', m => { m.cleanupNativeRows[0].status = 'unknown' }],
  ['原生AccessDenied', m => { m.cleanupNativeRows[0] = { ...missing(1), status: 'error', nativeError: 5 } }],
  ['raw错误不是ESRCH', m => { Object.assign(m.rawProbes[0], { alive: false, errorCode: 'EPERM' }) }],
  ['raw缺错误记录', m => { m.rawProbes[0].alive = false; delete m.rawProbes[0].errorCode }],
  ['缺前置出生字段', m => { delete m.historyNativeRows[0].creationTimeFileTimeHex }],
  ['缺raw完整材料', m => { m.rawProbes.pop() }],
  ['空清单不作vacuous通过', m => { m.events = []; m.rawProbes = []; m.cleanupNativeRows = []; m.historyNativeRows = [] }],
  ['跨同PID新start', m => { m.events.push({ ...m.events[0], birthId: 'another-birth', at: B + 900 }) }],
  ['query区间缺失', m => { delete m.cleanupNativeRows[0].queryStartedAtMs }],
  ['缺最终native收据', m => { m.cleanupNativeRows.pop() }],
  ['观察失败', m => { m.observerErrors.push('SECRET-ERROR-CANARY') }],
  ['raw单调时间反向', m => { m.rawProbes[0].completedAtNs = '0' }],
  ['原生先前缺失后又同身份running', m => { m.historyNativeRows.push({ ...missing(1), sampledAtMs: B + 900, queryStartedAtMs: B + 900, queryCompletedAtMs: B + 900 }) }],
  ['材料超预算', m => { m.materialOverflow = true }],
]) test('清理缺证据必须红：' + label, async () => { const m = material(); mutate(m); await assert.rejects(gate(m)) })

test('严格替代出生可证旧身份消失，但不依赖foreign镜像；全部raw仍true', async () => {
  const m = material(); m.cleanupNativeRows = m.events.map(s => native(s.pid, B + 800, B + 1000))
  const r = await gate(m); assert.equal(r.rawAliveCount, 3)
  assert.ok(r.rows.every(p => p.proof.kind === 'replacement-born-before-raw'))
})

test('短fail/recovery没有baseline：实际ESRCH与明确前置missing分别可证消失', async () => {
  const m = material(); m.events = m.events.slice(0, 2).map((s, i) => ({ ...s, name: i ? 'recovery' : 'fail' })); m.historyNativeRows = []
  m.rawProbes = m.rawProbes.slice(0, 2).map(p => ({ ...p, alive: false, errorCode: 'ESRCH' })); m.cleanupNativeRows = m.events.map(s => missing(s.pid))
  const r = await gate(m); assert.ok(r.rows.every(p => p.proof.kind === 'raw-esrch'))
  const legacy = actualMaterial(); legacy.historyNativeRows = []; legacy.events = legacy.events.slice(-2); legacy.rawProbes = legacy.rawProbes.slice(-2); legacy.cleanupNativeRows = legacy.cleanupNativeRows.slice(-2)
  await gate(legacy)
  legacy.cleanupNativeRows[0].nativeError = 5; await assert.rejects(gate(legacy))
})

test('source顺序下界不是任意时间补造：缺来源/顺序、rawtrue缺baseline、unknown误写false均红', async () => {
  for (const mutate of [m => { delete m.rawOrder.sourceSha }, m => { m.rawOrder.awaitFinalNativeBeforeRaw = false }, m => { m.historyNativeRows = [] }, m => { m.rawProbes[0].observationFailed = true }, m => { m.rawOrder.notBeforeMs = B }, m => { m.rawOrder.notBeforeMs += 100 }]) {
    const m = actualMaterial(); mutate(m); await assert.rejects(gate(m))
  }
})

test('捕获raw=true必须有原成功错误码null；不得把未记录的错误默认为成功', async () => {
  const m = material(); m.cleanupNativeRows = m.events.map(s => native(s.pid, B + 800, B + 1000))
  delete m.rawProbes[0].errorCode
  await assert.rejects(gate(m), /CLEANUP_RAW_ERROR_OR_TIME/)
})

test('清理独立JSON行超过24KiB拒绝而非截断；白名单不带env/原生路径', async () => {
  const { qualifyFixtureCleanup, encodeFixtureIdentityEvidence, FIXTURE_IDENTITY_LIMITS } = await load()
  const m = actualMaterial(); m.env = { SECRET_CANARY: 'NEVER-PUBLISH' }
  const r = qualifyFixtureCleanup(m), line = encodeFixtureIdentityEvidence(r)
  assert.ok(Buffer.byteLength(line) <= FIXTURE_IDENTITY_LIMITS.outputBytes)
  assert.doesNotMatch(line, /NEVER-PUBLISH|TiWorker|WinSxS|executablePath/)
  r.rows = Array.from({ length: 128 }, () => copy(r.rows[0]))
  assert.throws(() => encodeFixtureIdentityEvidence(r), /OUTPUT_BUDGET/)
})

test('非Windows清理仍保守：真实ESRCH才绿；rawtrue或未知失败保持红', async () => {
  const m = material(); m.cleanupNativeRows = []; m.historyNativeRows = []; m.rawOrder.kind = 'captured-raw-only'
  m.rawProbes.forEach(p => { p.alive = false; p.errorCode = 'ESRCH' }); await gate(m, false)
  Object.assign(m.rawProbes[0], { alive: true, errorCode: null }); await assert.rejects(gate(m, false))
})

test('原生UTC四舍五入而JS向下取整：保留先await顺序与1ms包络，不用它排除临界出生', async () => {
  const m = material(); m.historyNativeRows = []; m.cleanupNativeRows = m.events.map(s => ({ ...missing(s.pid), sampledAtMs: B + 1101, queryStartedAtMs: B + 1101, queryCompletedAtMs: B + 1101 }))
  m.rawOrder.nativeCompletedAtMs = B + 1100
  m.rawProbes.forEach(p => { p.alive = false; p.errorCode = 'ESRCH' })
  await gate(m)
  m.cleanupNativeRows[0].queryCompletedAtMs++; m.cleanupNativeRows[0].sampledAtMs++
  await assert.rejects(gate(m), /CLEANUP_NATIVE_AFTER_RAW_BOUND/)
})

test('真实自有Node清理：只按原ChildProcess句柄退出，原一次kill0/原生观察回读保留', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bounds-cleanup-identity-'))
  let child, observer
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise(r => child.once('close', r)); child.kill(); await closed }
    await observer?.close()
    const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  const executable = path.join(dir, process.platform === 'win32' ? 'cleanup-node.exe' : 'cleanup-node')
  fs.copyFileSync(process.execPath, executable); if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  child = spawn(executable, ['--eval', 'process.stdin.resume();process.stdin.once("data",()=>process.exit(0));console.log("READY")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir } })
  const closed = new Promise(r => child.once('close', r))
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
  const start = { event: 'start', pid: child.pid, name: 'recovery', birthId: 'own-real-child', at: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1000000n) }
  let historyNativeRows = [], cleanupNativeRows = [], nativeCompletedAtMs, finalSnapshot, rawScope, causalApi
  if (process.platform === 'win32') {
    const { startWindowsFixtureProcessObserver, classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
    observer = await startWindowsFixtureProcessObserver()
    historyNativeRows = classifyFixtureIdentitySample({ starts: [start], processes: (await observer.snapshot([child.pid])).processes, expectedExecutable: executable }).processes
  }
  child.stdin.end('exit'); await closed
  if (observer) {
    const n = await observer.snapshot([child.pid], { causal: true }); nativeCompletedAtMs = n.completedAtMs; finalSnapshot = n
    const { classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
    cleanupNativeRows = classifyFixtureIdentitySample({ starts: [start], processes: n.processes, expectedExecutable: executable }).processes
    causalApi = await import('../scripts/hermes-cli-bounds-observation.mjs'); rawScope = causalApi.beginFixtureCleanupRaw()
  }
  const startedAtMs = Date.now(), startedAtNs = process.hrtime.bigint().toString(); let alive = false, errorCode = null
  try { process.kill(child.pid, 0); alive = true } catch (error) { errorCode = error.code }
  const completedAtMs = Date.now(), completedAtNs = process.hrtime.bigint().toString()
  const m = { events: [start], historyNativeRows, cleanupNativeRows, rawProbes: [{ pid: child.pid, alive, errorCode, startedAtMs, completedAtMs, startedAtNs, completedAtNs }],
    rawOrder: { kind: observer ? 'captured-after-final-native' : 'captured-raw-only', nativeCompletedAtMs, startedAtMs, completedAtMs }, observerErrors: [] }
  if (observer) m.rawOrder = causalApi.finishFixtureCleanupRaw(rawScope, finalSnapshot, m.rawProbes, { startedAtMs, completedAtMs })
  try { await observer?.close() } catch (error) { m.observerErrors.push(String(error)) }
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-own-node-before-gate.json'), JSON.stringify(m, null, 2))
  const result = await gate(m, !!observer)
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-own-node-e2e.json'), JSON.stringify({ environment: { node: process.version, platform: process.platform }, material: m, result, noForeignKill: true }, null, 2))
})

// 新时序先用真正自有Node/PS留下红灯；不靠改UTC制造跨clock现象。
async function causalRoundtrip(t, late) {
  const api = await import('../scripts/hermes-cli-bounds-observation.mjs')
  if (process.platform !== 'win32') { await assert.rejects(api.startWindowsFixtureProcessObserver(), /Windows/); return }
  let child, observer, held, holding = false, release
  const report = { scope: 'actual owned Node + readonly PS/Win32 only; never Hermes/VM qualification', late, node: process.version, snapshots: [] }
  t.after(async () => {
    release?.()
    if (child && child.exitCode === null && child.signalCode === null) { const close = new Promise(r => child.once('close', r)); child.kill(); await close }
    try { await observer?.close() } finally {
      report.closed = { ownNode: child ? child.exitCode !== null || child.signalCode !== null : null, observer: observer?.getDiagnostic().terminal ?? null }
      if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, `causal-${late ? 'B-late' : 'A-ordered'}.json`), JSON.stringify(report, null, 2))
    }
  })
  observer = await api.startWindowsFixtureProcessObserver({ spawnProcess(executable, argv, options) {
    const ps = spawn(executable, argv, options), write = ps.stdin.write.bind(ps.stdin)
    ps.stdin.write = (...args) => {
      if (!holding) return write(...args)
      assert.equal(held, undefined, '每次只持有自己一个请求，不重放')
      held = args; release = () => { if (held) { const bytes = held; held = undefined; holding = false; write(...bytes) } }
      return true
    }
    return ps
  } })
  child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.once("data",()=>process.exit(0));console.log("READY")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  const closed = new Promise(r => child.once('close', r))
  await new Promise((r, reject) => { child.once('error', reject); child.stdout.once('data', r) })
  const start = { event: 'start', pid: child.pid, name: 'recovery', birthId: 'causal-own-' + child.pid, at: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1000000n) }
  const history = await observer.snapshot([child.pid]); report.snapshots.push(history)
  const historyNativeRows = api.classifyFixtureIdentitySample({ starts: [start], processes: history.processes, expectedExecutable: process.execPath }).processes
  child.stdin.end('exit'); await closed
  holding = late
  const pending = observer.snapshot([child.pid], { causal: true })
  let snapshot = late ? null : await pending
  const rawScope = api.beginFixtureCleanupRaw?.()
  const startedAtMs = Date.now(), startedAtNs = process.hrtime.bigint().toString()
  let alive = false, errorCode = null
  try { process.kill(child.pid, 0); alive = true } catch (e) { errorCode = e.code }
  const completedAtMs = Date.now(), completedAtNs = process.hrtime.bigint().toString()
  const rawProbes = [{ pid: child.pid, alive, errorCode, startedAtMs, completedAtMs, startedAtNs, completedAtNs }]
  if (late) { assert.ok(held, '实际PS请求尚未送达，raw已经完成'); release(); snapshot = await pending }
  report.snapshots.push(snapshot); report.originalRaw = rawProbes
  report.actualOrder = { requestHeldUntilAfterRaw: late, rawCompletedNs: completedAtNs }
  assert.ok(snapshot.causalReceipt, '真实返回必须含v2收据；旧实现先红，原UTC不改')
  assert.equal(typeof api.finishFixtureCleanupRaw, 'function')
  const actualCompletedAtMs = snapshot.completedAtMs
  if (!late) {
    snapshot.completedAtMs++
    assert.throws(() => api.finishFixtureCleanupRaw(rawScope, snapshot, rawProbes, { startedAtMs, completedAtMs }), /CLEANUP_CAUSAL_UNOWNED_RECEIPT/, '不能改原Node接收UTC再绑定收据')
    snapshot.completedAtMs = actualCompletedAtMs
  }
  const rawOrder = api.finishFixtureCleanupRaw(rawScope, snapshot, rawProbes, { startedAtMs, completedAtMs })
  const cleanupNativeRows = api.classifyFixtureIdentitySample({ starts: [start], processes: snapshot.processes, expectedExecutable: process.execPath }).processes
  const m = { events: [start], historyNativeRows, cleanupNativeRows, rawProbes, rawOrder, observerErrors: [] }
  await observer.close()
  report.material = m
  const { qualifyFixtureCleanup } = await load()
  if (late) {
    assert.throws(() => qualifyFixtureCleanup(m), { code: 'CLEANUP_NATIVE_AFTER_RAW_BOUND' })
    report.rejected = 'CLEANUP_NATIVE_AFTER_RAW_BOUND'
  } else {
    report.result = await gate(m)
    assert.equal(report.result.schema, 2)
    assert.equal(report.result.causalOrderValidated, true)
    assert.equal(report.result.legacyPredicate, cleanupNativeRows.every(row => row.queryCompletedAtMs <= snapshot.completedAtMs + 1))
    assert.deepEqual(snapshot.processes.map(row => row.queryCompletedAtMs), cleanupNativeRows.map(row => row.queryCompletedAtMs))
    // 原始实际回包/UTC不改；以下只破坏副本，明确属于isolated contract。
    const hashBefore = createHash('sha256').update(JSON.stringify(m)).digest('hex')
    for (const [label, mutate] of [
      ['缺收据', x => { delete x.rawOrder.causal }],
      ['混domain', x => { x.rawOrder.causal.clockDomainId = 'f'.repeat(32) }],
      ['混session', x => { x.rawOrder.causal.transportSessionId = 'f'.repeat(32) }],
      ['混callID', x => { x.rawOrder.causal.requestId++ }],
      ['PID清单', x => { x.rawOrder.causal.orderedPids.push(process.pid) }],
      ['row摘要', x => { x.cleanupNativeRows[0].queryCompletedAtMs++ }],
      ['raw摘要', x => { x.rawProbes[0].completedAtNs = String(BigInt(x.rawProbes[0].completedAtNs) + 1n) }],
      ['反序', x => { x.rawOrder.causal.receive.ns = x.rawOrder.causal.rawEnd.ns }],
      ['原生unknown', x => { x.cleanupNativeRows[0].status = 'unknown' }],
      ['raw EPERM', x => { x.rawProbes[0].errorCode = 'EPERM' }],
    ]) {
      const x = copy(m); mutate(x); assert.throws(() => qualifyFixtureCleanup(x), undefined, label)
    }
    assert.equal(createHash('sha256').update(JSON.stringify(m)).digest('hex'), hashBefore)
    report.isolatedNegativeCases = 10
  }
}

test('v2 A真实ownNode/PS roundtrip：原UTC不改，同controller完整收据先红', { timeout: 12000 }, async t => causalRoundtrip(t, false))
test('v2 B真实ownNode/PS barrier：native确晚于raw，即使ESRCH也必须红', { timeout: 12000 }, async t => causalRoundtrip(t, true))

const nativeFields = ['pid', 'status', 'executablePath', 'creationTimeFileTimeHex', 'createdAtMs', 'exitAtMs', 'sampledAtMs', 'queryStartedAtMs', 'queryCompletedAtMs', 'nativeError', 'imageQueryError', 'waitResult']
const rawFields = ['pid', 'alive', 'errorCode', 'startedAtMs', 'completedAtMs', 'startedAtNs', 'completedAtNs']
const projectionHash = (rows, keys) => createHash('sha256').update(JSON.stringify(rows.map(row => Object.fromEntries(keys.map(k => [k, row[k]]))))).digest('hex')
function causalMaterial() {
  // 纯schema反例工厂：不来自旧a859原件，也不声称实际worker发生此offset。
  const m = material()
  m.cleanupNativeRows = m.events.map(s => ({ ...missing(s.pid), executablePath: null, queryStartedAtMs: B + 1105, queryCompletedAtMs: B + 1105, sampledAtMs: B + 1105 }))
  m.rawProbes.forEach(p => { p.alive = false; p.errorCode = 'ESRCH' })
  const marker = (sequence, ns) => ({ controllerPid: 7, clockDomainId: 'a'.repeat(32), sequence, ns: String(ns), utcMs: B + 1000 + sequence })
  const c = { schemaVersion: 2, phase: 'cleanup-final', clock: 'controller-process-hrtime-bigint-ns', controllerPid: 7, clockDomainId: 'a'.repeat(32), transportSessionId: 'b'.repeat(32), observerPid: 8, requestId: 2, orderedPids: [1, 2, 3], rowsSha256: projectionHash(m.cleanupNativeRows, nativeFields), send: marker(1, 1000000000), receive: marker(2, 1020000000), returned: marker(3, 1030000000), rawBegin: marker(4, 1090000000), rawEnd: marker(5, 1200000000), rawSha256: projectionHash(m.rawProbes, rawFields) }
  const ref = Object.fromEntries(['controllerPid', 'clockDomainId', 'transportSessionId', 'observerPid', 'requestId', 'rowsSha256'].map(k => [k, c[k]]))
  m.rawOrder = { ...m.rawOrder, kind: 'captured-controller-causal-order-v2', causal: c, finalSnapshotRef: ref }
  return m
}

test('v2 isolated契约：legacyPredicate=false原值保留；v1同值仍拒绝，不补旧收据', async () => {
  const m = causalMaterial(), before = copy(m), r = await gate(m)
  assert.equal(r.legacyPredicate, false); assert.equal(r.schema, 2); assert.deepEqual(m, before)
  const old = copy(m); old.rawOrder = { kind: 'captured-after-final-native', nativeCompletedAtMs: m.rawOrder.nativeCompletedAtMs, startedAtMs: m.rawOrder.startedAtMs, completedAtMs: m.rawOrder.completedAtMs }
  await assert.rejects(gate(old), /CLEANUP_NATIVE_AFTER_RAW_BOUND/)
  const env = process.env.HERMES_CLEANUP_OLD_RED
  if (env) {
    const bytes = fs.readFileSync(env), original = JSON.parse(bytes), oldMaterial = { events: original.events, historyNativeRows: original.observations.flatMap(x => x.processes), cleanupNativeRows: original.cleanup, rawProbes: original.cleanupRawProbes, rawOrder: original.cleanupRawOrder, observerErrors: original.observerErrors }
    await assert.rejects(gate(oldMaterial), /CLEANUP_NATIVE_AFTER_RAW_BOUND/)
    oldMaterial.rawOrder = { ...oldMaterial.rawOrder, kind: m.rawOrder.kind }
    await assert.rejects(gate(oldMaterial), /CLEANUP_CAUSAL_/)
    assert.deepEqual(fs.readFileSync(env), bytes)
  }
})

for (const [label, mutate] of [
  ['少receive', m => { delete m.rawOrder.causal.receive }],
  ['缺ref', m => { delete m.rawOrder.finalSnapshotRef }],
  ['异domain', m => { m.rawOrder.causal.clockDomainId = 'c'.repeat(32) }],
  ['异raw来源', m => { m.rawOrder.causal.rawBegin.clockDomainId = 'c'.repeat(32) }],
  ['异session', m => { m.rawOrder.causal.transportSessionId = 'c'.repeat(32) }],
  ['异callID', m => { m.rawOrder.causal.requestId++ }],
  ['异controller', m => { m.rawOrder.causal.controllerPid++ }],
  ['异observer', m => { m.rawOrder.causal.observerPid++ }],
  ['乱序', m => { m.rawOrder.causal.receive.ns = '1200000001' }],
  ['反sequence', m => { m.rawOrder.causal.returned.sequence = 1 }],
  ['缺PID', m => { m.rawOrder.causal.orderedPids.pop() }],
  ['换PID顺序', m => { m.rawOrder.causal.orderedPids.reverse() }],
  ['缺row', m => { m.cleanupNativeRows.pop() }],
  ['改row', m => { m.cleanupNativeRows[0].nativeError = 5 }],
  ['改raw', m => { m.rawProbes[0].errorCode = 'EPERM' }],
  ['raw早于包络', m => { m.rawOrder.causal.rawBegin.ns = '1100000001' }],
  ['schema未知', m => { m.rawOrder.causal.schemaVersion = 3 }],
  ['workerclock冒充', m => { m.rawOrder.causal.clock = 'worker-stopwatch' }],
  ['缺ns', m => { delete m.rawOrder.causal.send.ns }],
  ['无限ns', m => { m.rawOrder.causal.send.ns = 'Infinity' }],
  ['伪布尔', m => { m.rawOrder.causal = true }],
  ['额外字段', m => { m.rawOrder.causal.trusted = true }],
  ['元数据超原24KiB', m => { m.rawOrder.causal.clockDomainId = 'a'.repeat(24577) }],
]) test('v2拒绝而不降级：' + label, async () => { const m = causalMaterial(); mutate(m); await assert.rejects(gate(m)) })

test('v2真实PS管道负向：缺echo/混请求/混session/重复回包/报文超预算均终止且无降级', { timeout: 12000 }, async t => {
  const { startWindowsFixtureProcessObserver } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  if (process.platform !== 'win32') { await assert.rejects(startWindowsFixtureProcessObserver(), /Windows/); return }
  const cases = []
  for (const [label, change] of [
    ['missing-echo', "$reply=@{id=$request.id;processes=@($rows)}|ConvertTo-Json -Depth 6 -Compress"],
    ['mixed-call', '$v=ConvertFrom-Json $reply;$v.id++;$reply=$v|ConvertTo-Json -Depth 6 -Compress'],
    ['mixed-session', "$v=ConvertFrom-Json $reply;$v.causal.transportSessionId='cccccccccccccccccccccccccccccccc';$reply=$v|ConvertTo-Json -Depth 6 -Compress"],
    ['duplicate', '[Console]::Out.WriteLine($reply);$null=[Console]::ReadLine()'],
    ['over-budget', "$reply=(' ' * 24577)+$reply"],
  ]) {
    let observer
    try {
      observer = await startWindowsFixtureProcessObserver({ spawnProcess(executable, argv, options) {
        const anchor = '[Console]::Out.WriteLine($reply)', body = argv.at(-1)
        assert.equal(body.split(anchor).length, 2, '只改自己测试PS回包点，不改查询与原UTC')
        return spawn(executable, [...argv.slice(0, -1), body.replace(anchor, `if($null -ne $request.causal){${change}}\n` + anchor)], options)
      } })
      // 回包可能分不同chunk；完整事务必须包括close fence，而非假定重复必在await前到达。
      await assert.rejects(async () => { await observer.snapshot([process.pid], { causal: true }); await observer.close() }, /CLEANUP_CAUSAL_|unexpected identity observer response/, label)
      cases.push({ label, rejected: true, diagnostic: observer.getDiagnostic() })
    } finally {
      try { await observer?.close() } catch (e) { assert.match(e.message, /CLEANUP_CAUSAL_|unexpected identity observer response/) }
    }
  }
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'causal-transport-negative.json'), JSON.stringify({ scope: 'actual owned PS transport + readonly self PID; test-only response corruption', cases }, null, 2))
})
