// 先重放真实CI，再验证相反边界；不安装Hermes、不更改生产队列或原采样预算。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const B = 1792182390000, epoch = 116444736000000000n
const hex = ms => (epoch + BigInt(ms) * 10000n).toString(16).padStart(16, '0')
const copy = value => structuredClone(value)
const moduleUrl = new URL('../scripts/hermes-cli-owned-identity.mjs', import.meta.url)
const load = () => import(moduleUrl)
const native = (pid, at = B + 50, birth = B + pid) => ({ pid, status: 'running', sampledAtMs: at, queryStartedAtMs: at, queryCompletedAtMs: at, creationTimeFileTimeHex: hex(birth), createdAtMs: birth, exitAtMs: 0, belongsToFixture: true, waitResult: 258, nativeError: 0, imageQueryError: 0 })
function material() {
  const events = [1, 2, 3].map(pid => ({ event: 'start', pid, name: `burst-${pid}`, birthId: `fixture-${pid}`, at: B + 20, monotonicMs: 20 }))
  return { events, rawSweeps: [{ startedAtMs: B + 1000, completedAtMs: B + 1001, journalEventCount: events.length, probeCount: 3, starts: copy(events), probes: events.map((e, i) => ({ pid: e.pid, alive: true, startedAtMs: B + 1000, completedAtMs: B + 1001, startedAtNs: String(1000000000 + i * 10000), completedAtNs: String(1000001000 + i * 10000), errorCode: null })) }], nativeRows: events.map(e => native(e.pid)), observerErrors: [] }
}
function replacement(input, birth = B + 800) {
  input.nativeRows.push({ ...native(3, Math.max(B + 1010, birth + 5), birth), belongsToFixture: false })
  return input
}
function shiftedSweep(sweep, ms) {
  const r = copy(sweep); r.startedAtMs += ms; r.completedAtMs += ms
  for (const p of r.probes) { p.startedAtMs += ms; p.completedAtMs += ms; p.startedAtNs = String(BigInt(p.startedAtNs) + BigInt(ms) * 1000000n); p.completedAtNs = String(BigInt(p.completedAtNs) + BigInt(ms) * 1000000n) }
  return r
}
async function gate(input) { const { qualifyFixtureIdentityHistory } = await load(); const r = qualifyFixtureIdentityHistory(input); assert.ok(r.ownedPeak <= 2, 'fixture owned peak <=2'); return r }
function actualReplay() {
  const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-cli-pid7056-ci407519b.json', import.meta.url), 'utf8'))
  const s = saved.sample, events = s.pids.flatMap(p => [p.start, ...(p.lastEvent.event === 'start' ? [] : [p.lastEvent])])
  // 旧采集器没有记录kill0错误码；保留undefined，绝不补造ESRCH。
  return { saved, input: { events, rawSweeps: [{ ...s, starts: s.pids.map(p => p.start), probes: s.pids.map(({ pid, alive, startedAtMs, completedAtMs, startedAtNs, completedAtNs }) => ({ pid, alive, startedAtMs, completedAtMs, startedAtNs, completedAtNs, errorCode: alive ? null : undefined })) }], nativeRows: s.pids.flatMap(p => [p.nativeFirst, p.nativeBefore, p.nativeAfter].map(row => ({ pid: p.pid, ...row }))), observerErrors: [] } }
}

test('真实407完整样本：raw3保留，旧捕获缺原生查询区间仍红，false码也不补造', async () => {
  const { input, saved } = actualReplay(), before = copy(input)
  assert.equal(saved.provenance.sourceSha, '407519bcc3ed15a00f9b8b1d4d6099e2b283f6e2')
  assert.equal(input.rawSweeps[0].probes.filter(p => p.alive).length, 3)
  await assert.rejects(gate(input), /NATIVE_INTERVAL_MISSING/)
  assert.deepEqual(input, before)
})

test('真实407三个原true探针逐项重放：7056有前置出生证明，另外两项仍owned；不是整轮通过', async () => {
  const { input } = actualReplay(), { qualifyFixtureIdentityHistory } = await load(), results = []
  for (const probe of input.rawSweeps[0].probes.filter(p => p.alive)) {
    const start = input.events.find(e => e.event === 'start' && e.pid === probe.pid)
    // 仅此旧单项诊断投影使用[Unix epoch, 已捕获完成时间]的保守包络；不是新增原始捕获。
    // 宽包络不能证明missing发生在baseline之后；7056仍只使用精确FILETIME出生证明。
    const nativeRows = input.nativeRows.filter(r => r.pid === probe.pid).map(r => ({ ...r, queryStartedAtMs: 0, queryCompletedAtMs: r.sampledAtMs }))
    const r = qualifyFixtureIdentityHistory({ events: [start], rawSweeps: [{ ...input.rawSweeps[0], journalEventCount: 1, starts: [start], probes: [probe], probeCount: 1, count: 1 }], nativeRows, observerErrors: [] })
    results.push(r)
  }
  assert.equal(results.reduce((n, r) => n + r.rawUnqualifiedPeak, 0), 3)
  assert.equal(results.reduce((n, r) => n + r.ownedPeak, 0), 2)
  const exclusions = results.flatMap(r => r.proofs)
  assert.equal(exclusions.length, 1); assert.equal(exclusions[0].pid, 7056)
  assert.equal(exclusions[0].kind, 'replacement-born-before-probe')
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) { fs.mkdirSync(process.env.HERMES_BOUNDS_TEST_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'ci407-positive-probe-replay.json'), JSON.stringify({ completeSweepAccepted: false, reason: 'legacy false-probe errorCode not recorded', results }, null, 2)) }
})

test('三个当前fixture身份仍活跃：原<=2必须红，不靠native另时刻计数补绿', async () => {
  await assert.rejects(gate(material()), { code: 'ERR_ASSERTION' })
})

for (const [label, mutate] of [
  ['替代仅在raw后新生', m => replacement(m, B + 1002)],
  ['替代出生恰在raw毫秒下界', m => replacement(m, B + 1000)],
  ['仅raw后的missing', m => m.nativeRows.push({ pid: 3, status: 'missing', sampledAtMs: B + 1002, queryStartedAtMs: B + 1002, queryCompletedAtMs: B + 1002, nativeError: 87, waitResult: 4294967295, creationTimeFileTimeHex: null })],
  ['仅JS exit而无OS证据', m => m.events.push({ ...m.events[2], event: 'exit', at: B + 700 })],
]) test(`无足够前置证明仍红：${label}`, async () => { const m = material(); mutate(m); await assert.rejects(gate(m), { code: 'ERR_ASSERTION' }) })

for (const [label, mutate] of [
  ['旧身份存在后原生missing87早于raw', m => m.nativeRows.push({ pid: 3, status: 'missing', sampledAtMs: B + 700, queryStartedAtMs: B + 700, queryCompletedAtMs: B + 700, nativeError: 87, waitResult: 4294967295, creationTimeFileTimeHex: null })],
  ['同一旧创建身份OS exit早于raw', m => m.nativeRows.push({ ...native(3, B + 1010), status: 'exited', exitAtMs: B + 700, waitResult: 0, imageQueryError: 31 })],
]) test(`独立前置时间证明可排除：${label}`, async () => { const m = material(); mutate(m); const r = await gate(m); assert.equal(r.rawUnqualifiedPeak, 3); assert.equal(r.ownedPeak, 2); assert.equal(r.exclusions.length, 1) })

for (const [label, mutate, code] of [
  ['baseline材料缺失', m => { m.nativeRows = m.nativeRows.filter(r => r.pid !== 3) }, 'BASELINE'],
  ['未知native状态', m => { m.nativeRows[2].status = 'unknown' }, 'NATIVE'],
  ['AccessDenied', m => { m.nativeRows[2] = { pid: 3, status: 'error', sampledAtMs: B + 50, nativeError: 5 } }, 'NATIVE'],
  ['观察器失败', m => { m.observerErrors.push('SECRET-OBSERVER-ERROR') }, 'OBSERVATION'],
  ['跨同PID新start', m => { m.events.push({ ...m.events[2], birthId: 'second-start', at: B + 900, monotonicMs: 900 }) }, 'START_PID'],
  ['缺少原raw探针', m => { m.rawSweeps[0].probes.pop() }, 'RAW'],
  ['raw非ESRCH错误', m => { m.rawSweeps[0].probes[2].alive = false; m.rawSweeps[0].probes[2].errorCode = 'EPERM' }, 'RAW'],
  ['旧native在新出生后仍running的矛盾', m => { replacement(m); m.nativeRows.push(native(3, B + 900)) }, 'CONFLICT'],
  ['出生字段与FILETIME矛盾', m => { m.nativeRows[2].createdAtMs += 100 }, 'TIME'],
  ['false探针错误码未记录', m => { m.rawSweeps[0].probes[2].alive = false; delete m.rawSweeps[0].probes[2].errorCode }, 'RAW'],
  ['native可选错误字段不是数字', m => { m.nativeRows.push({ pid: 3, status: 'missing', sampledAtMs: B + 700, nativeError: 87, imageQueryError: 'SECRET-NATIVE' }) }, 'NATIVE'],
]) test(`材料异常不补绿：${label}`, async () => { const m = material(); mutate(m); await assert.rejects(gate(m), new RegExp(code)); })

for (const [label, mutate, code] of [
  ['raw=false也不接受无baseline的start', m => { m.nativeRows.pop(); Object.assign(m.rawSweeps[0].probes[2], { alive: false, errorCode: 'ESRCH' }) }, 'BASELINE'],
  ['missing之后旧创建身份又running', m => { m.nativeRows.push({ pid: 3, status: 'missing', sampledAtMs: B + 700, queryStartedAtMs: B + 700, queryCompletedAtMs: B + 700, nativeError: 87 }); m.nativeRows.push(native(3, B + 900)) }, 'CONFLICT'],
  ['OS exit之后旧创建身份又running', m => { m.nativeRows.push({ ...native(3, B + 800), status: 'exited', exitAtMs: B + 700, waitResult: 0 }); m.nativeRows.push(native(3, B + 900)) }, 'CONFLICT'],
  ['raw探针次序重叠', m => { m.rawSweeps[0].probes[1].startedAtNs = '999999999' }, 'RAW'],
  ['先前已见历史start被下一轮丢弃', m => { const r = copy(m.rawSweeps[0]); r.startedAtMs++; r.completedAtMs++; r.starts.pop(); r.probes.pop(); r.probeCount--; r.probes.forEach(p => { p.startedAtMs++; p.completedAtMs++; p.startedAtNs = String(BigInt(p.startedAtNs) + 1000000n); p.completedAtNs = String(BigInt(p.completedAtNs) + 1000000n) }); m.rawSweeps.push(r) }, 'RAW'],
  ['已有start从所有raw材料中遗漏', m => { m.rawSweeps[0].starts.pop(); m.rawSweeps[0].probes.pop(); m.rawSweeps[0].probeCount-- }, 'RAW'],
  ['raw start丢失原birthId', m => { delete m.rawSweeps[0].starts[2].birthId }, 'RAW'],
]) test(`闭合身份和原采样历史：${label}`, async () => { const m = material(); mutate(m); await assert.rejects(gate(m), new RegExp(code)) })

test('跨平台无原生观察时保守保留raw，不把未知身份排除；预算仍硬失败', async () => {
  const { evaluateFixtureBoundsGate } = await load()
  const report = { events: material().events, rawSweeps: material().rawSweeps, observations: [], observerErrors: [] }
  const r = evaluateFixtureBoundsGate(report, false)
  assert.equal(r.ownedPeak, 3); assert.equal(r.rawUnqualifiedPeak, 3)
  assert.equal(r.nativeQualification, 'unavailable-no-exclusions'); assert.deepEqual(r.exclusions, [])
  assert.throws(() => assert.ok(r.ownedPeak <= 2), { code: 'ERR_ASSERTION' })
  assert.throws(() => evaluateFixtureBoundsGate({ ...report, materialOverflow: true }, false), /BUDGET/)
  assert.throws(() => evaluateFixtureBoundsGate(report, true), /BASELINE/)
})

test('材料和输出预算硬失败，不切片/丢证明；白名单不包含env/原错误正文', async () => {
  const { qualifyFixtureIdentityHistory, encodeFixtureIdentityEvidence, FIXTURE_IDENTITY_LIMITS } = await load()
  const m = replacement(material()); m.env = { TOKEN: 'SECRET-TOKEN' }
  const encoded = encodeFixtureIdentityEvidence(qualifyFixtureIdentityHistory(m))
  assert.doesNotMatch(encoded, /SECRET|TOKEN|argv|executablePath/)
  const many = replacement(material())
  many.rawSweeps = Array.from({ length: 1000 }, (_, i) => shiftedSweep(many.rawSweeps[0], i * 25))
  assert.throws(() => encodeFixtureIdentityEvidence(qualifyFixtureIdentityHistory(many)), /OUTPUT_BUDGET/)
  const oversized = material(); oversized.extra = 'X'.repeat(FIXTURE_IDENTITY_LIMITS.materialBytes + 1)
  assert.throws(() => qualifyFixtureIdentityHistory(oversized), /MATERIAL_BUDGET/)
})

test('真实Node TAP stdout回读>10K且<=24KiB的完整JSON，不依赖错误消息inspect', { timeout: 15000 }, async t => {
  const { qualifyFixtureIdentityHistory, encodeFixtureIdentityEvidence } = await load()
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'bounds-tap-identity-'))
  t.after(() => { const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true }) })
  const m = replacement(material())
  m.rawSweeps = Array.from({ length: 250 }, (_, i) => shiftedSweep(m.rawSweeps[0], i * 25))
  const json = encodeFixtureIdentityEvidence(qualifyFixtureIdentityHistory(m))
  assert.ok(Buffer.byteLength(json) > 10000 && Buffer.byteLength(json) <= 24576)
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(m))
  fs.writeFileSync(path.join(dir, 'roundtrip.test.mjs'), `import test from 'node:test';import fs from 'node:fs';import{qualifyFixtureIdentityHistory,encodeFixtureIdentityEvidence}from ${JSON.stringify(moduleUrl.href)};test('console JSON roundtrip',()=>{console.log(encodeFixtureIdentityEvidence(qualifyFixtureIdentityHistory(JSON.parse(fs.readFileSync(new URL('./input.json',import.meta.url),'utf8')))))})`)
  // 嵌套node --test不得继承父runner的私有IPC上下文，否则显式tap reporter也没有stdout。
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT
  const result = await new Promise(resolve => execFile(process.execPath, ['--test', '--test-reporter=tap', path.join(dir, 'roundtrip.test.mjs')], { encoding: 'utf8', timeout: 12000, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv }, (error, stdout, stderr) => resolve({ error, stdout, stderr })))
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) {
    const out = process.env.HERMES_BOUNDS_TEST_EVIDENCE
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'identity-tap-stdout.log'), result.stdout)
    fs.writeFileSync(path.join(out, 'identity-tap-stderr.log'), result.stderr)
    fs.writeFileSync(path.join(out, 'identity-tap-context.json'), JSON.stringify({ testContext: process.env.NODE_TEST_CONTEXT ?? null, errorCode: result.error?.code ?? null }))
  }
  assert.equal(result.error, null, String(result.error)); assert.doesNotMatch(result.stdout, /more characters/)
  const line = result.stdout.split('\n').find(s => s.includes('{"event":"hermes-bounds-identity"'))
  assert.ok(line); const actual = line.slice(line.indexOf('{'))
  assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(json).digest('hex'))
  assert.deepEqual(JSON.parse(actual), JSON.parse(json))
})

test('Windows真实三活跃：原25ms kill0加短句柄native身份，owned3必须继续红', { timeout: 12000 }, async t => {
  if (process.platform !== 'win32') return
  const { qualifyFixtureIdentityHistory } = await load()
  const { startWindowsFixtureProcessObserver, classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'bounds-owned-three-')), executable = process.execPath
  const children = [], events = []; let observer, timer
  t.after(async () => { clearInterval(timer); for (const row of children) { if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill(); await row.closed } await observer?.close(); const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true }) })
  observer = await startWindowsFixtureProcessObserver()
  for (let i = 0; i < 3; i++) {
    const child = spawn(executable, ['--eval', 'process.stdin.resume();console.log("READY")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
    const closed = new Promise(resolve => child.once('close', resolve)); children.push({ child, closed })
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
    events.push({ event: 'start', pid: child.pid, name: 'burst-' + i, at: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1000000n) })
  }
  const before = await observer.snapshot(events.map(e => e.pid))
  const raw = await new Promise(resolve => { timer = setInterval(() => { const startedAtMs = Date.now(), probes = events.map(e => { const p = { pid: e.pid, startedAtMs: Date.now(), startedAtNs: process.hrtime.bigint().toString(), errorCode: null }; try { process.kill(e.pid, 0); p.alive = true } catch (error) { p.alive = false; p.errorCode = error.code } return { ...p, completedAtMs: Date.now(), completedAtNs: process.hrtime.bigint().toString() } }); clearInterval(timer); resolve({ startedAtMs, completedAtMs: Date.now(), journalEventCount: events.length, starts: events, probes, probeCount: probes.length }) }, 25) })
  const after = await observer.snapshot(events.map(e => e.pid))
  const nativeRows = [before, after].flatMap(sample => classifyFixtureIdentitySample({ starts: events, processes: sample.processes, expectedExecutable: executable }).processes)
  const r = qualifyFixtureIdentityHistory({ events, rawSweeps: [raw], nativeRows, observerErrors: [] })
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) { fs.mkdirSync(process.env.HERMES_BOUNDS_TEST_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'identity-three-active-control.json'), JSON.stringify({ environment: { platform: process.platform, node: process.version }, events, raw, nativeRows, result: r }, null, 2)) }
  assert.equal(r.rawUnqualifiedPeak, 3); assert.equal(r.ownedPeak, 3); assert.equal(r.exclusions.length, 0)
  assert.throws(() => assert.ok(r.ownedPeak <= 2), { code: 'ERR_ASSERTION' })
})
