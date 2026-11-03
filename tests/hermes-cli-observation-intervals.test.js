// 两个观测契约反例：真实自有孩子/文件及原生API，不作为任何历史CI故障的根因声明。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { qualifyFixtureIdentityHistory } from '../scripts/hermes-cli-owned-identity.mjs'
import { startWindowsFixtureProcessObserver, classifyFixtureIdentitySample } from '../scripts/hermes-cli-bounds-observation.mjs'

const B = 1792182390000, epoch = 116444736000000000n
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = x => structuredClone(x)
const start = (pid, at = B + 20) => ({ event: 'start', pid, name: `burst-${pid}`, birthId: `interval-${pid}`, at, monotonicMs: 20 })
const native = (pid, begin = B + 50, end = begin, birth = B + pid) => ({ pid, status: 'running', sampledAtMs: end, queryStartedAtMs: begin, queryCompletedAtMs: end, creationTimeFileTimeHex: (epoch + BigInt(birth) * 10000n).toString(16).padStart(16, '0'), createdAtMs: birth, exitAtMs: 0, belongsToFixture: true, waitResult: 258, nativeError: 0, imageQueryError: 0 })
const probe = (pid, at) => ({ pid, alive: true, errorCode: null, startedAtMs: at, completedAtMs: at + 1, startedAtNs: String(BigInt(at - B) * 1000000n), completedAtNs: String(BigInt(at - B) * 1000000n + 1000n) })
const sweep = (at, events, probes, end = at + 1) => ({ startedAtMs: at, completedAtMs: end, journalEventCount: events.length, starts: events.filter(e => e.event === 'start'), probes, probeCount: probes.length, count: probes.filter(p => p.alive).length })
const material = () => { const events = [1, 2, 3].map(pid => start(pid)); return { events, rawSweeps: [sweep(B + 1000, events, events.map((e, i) => probe(e.pid, B + 1000 + i * 2)), B + 1005)], nativeRows: events.map(e => native(e.pid)), observerErrors: [] } }
const gate = m => { const r = qualifyFixtureIdentityHistory(m); assert.ok(r.ownedPeak <= 2); return r }
const save = (name, report) => { if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) { fs.mkdirSync(process.env.HERMES_BOUNDS_TEST_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, name), JSON.stringify(report, null, 2)) } }
function temp(prefix) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, prefix))
  return { dir, remove() { const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true }) } }
}
const readEvents = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
function sampleRaw(events) {
  const startedAtMs = Date.now(), probes = [], pids = [...new Set(events.filter(e => e.event === 'start').map(e => e.pid))]
  const alive = pid => {
    const p = { pid, startedAtMs: Date.now(), startedAtNs: process.hrtime.bigint().toString(), errorCode: null }
    try { process.kill(pid, 0); p.alive = true; return true } catch (e) { p.alive = false; p.errorCode = e.code; return false }
    finally { probes.push({ ...p, completedAtMs: Date.now(), completedAtNs: process.hrtime.bigint().toString() }) }
  }
  const count = pids.filter(alive).length
  return { ...sweep(startedAtMs, events, probes, Date.now()), count }
}

test('真实journal E2E：产生start后才可见，空前缀和完整已见前缀均合法', { timeout: 12000 }, async t => {
  const workspace = temp('bounds-journal-visible-'), dir = workspace.dir, journal = path.join(dir, 'events.jsonl')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `import fs from 'node:fs';const e={event:'start',pid:process.pid,name:'burst-1',birthId:'own-visible',at:Date.now(),monotonicMs:Number(process.hrtime.bigint()/1000000n)};process.send(e);process.on('message',m=>{if(m==='append'){fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(e)+'\\n');process.send('appended')}if(m==='stop')process.exit(0)})`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' } })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const report = { scope: 'real own Node, actual delayed append, original all-seen-PID kill0', samples: [] }; let outcome
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); report.cleanup = await closed; report.outcome = outcome; save('journal-visible-e2e.json', report); workspace.remove() })
  const produced = await new Promise((resolve, reject) => { child.once('error', reject); child.once('message', resolve) }); report.produced = produced
  await delay(25)
  const before = readEvents(journal); report.samples.push(sampleRaw(before))
  assert.equal(before.length, 0); assert.ok(report.samples[0].startedAtMs > produced.at + 1)
  const appended = new Promise(resolve => child.once('message', resolve)); child.send('append'); assert.equal(await appended, 'appended')
  const events = readEvents(journal); report.samples.push(sampleRaw(events)); assert.equal(events.length, 1)
  const input = { events, rawSweeps: report.samples, nativeRows: [], observerErrors: [] }; report.input = input
  try { const r = qualifyFixtureIdentityHistory(input, { nativeIdentityAvailable: false }); report.result = r; assert.equal(r.rawUnqualifiedPeak, 1); assert.equal(r.ownedPeak, 1); assert.equal(r.exclusions.length, 0); outcome = 'passed' } catch (e) { outcome = { code: e.code, message: e.message }; throw e }
  child.send('stop'); await closed
})

test('真实Windows E2E：running查询期间退出、行尾才完成，不是原身份复活', { timeout: 12000 }, async t => {
  if (process.platform !== 'win32') { t.skip('需要Windows原生API'); return }
  const workspace = temp('bounds-native-interval-'), dir = workspace.dir, held = path.join(dir, 'held'), release = path.join(dir, 'release')
  const report = { scope: 'two original native query sets, two independent observers, one own Node; pause only inside first query', subjectSnapshotCalls: 0 }; let observerA, observerB, child, closed, pendingA, outcome
  t.after(async () => {
    fs.writeFileSync(release, 'release')
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    if (closed) report.cleanup = await closed
    if (pendingA) await pendingA.catch(() => {})
    await Promise.all([observerA?.close(), observerB?.close()]); report.outcome = outcome; save('native-interval-e2e.json', report); workspace.remove()
  })
  // 两个原启动预算并行保持；一侧失败也等另一侧完成归属登记，finally才能可靠关闭。
  const startups = await Promise.allSettled([
    startWindowsFixtureProcessObserver({ spawnProcess(executable, argv, options) {
      const point = "    return $row\n  } finally {"
      let script = argv.at(-1); assert.ok(script.includes(point))
      script = script.replace(point, `    if($processId -ne $PID){[IO.File]::WriteAllText(${JSON.stringify(held)},'held');$until=[DateTime]::UtcNow.AddSeconds(1);while(-not [IO.File]::Exists(${JSON.stringify(release)}) -and [DateTime]::UtcNow -lt $until){[Threading.Thread]::Sleep(1)}}\n` + point)
      return spawn(executable, [...argv.slice(0, -1), script], options)
    } }).then(o => { observerA = o }),
    startWindowsFixtureProcessObserver().then(o => { observerB = o }),
  ])
  const failedStartup = startups.find(r => r.status === 'rejected'); if (failedStartup) throw failedStartup.reason
  child = spawn(process.execPath, ['--eval', 'process.stdin.resume();process.stdin.once("data",()=>process.exit(0));console.log("READY")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
  const events = [{ ...start(child.pid, Date.now()), name: 'burst-1', monotonicMs: Number(process.hrtime.bigint() / 1000000n) }]
  pendingA = observerA.snapshot([child.pid]); report.subjectSnapshotCalls++
  // 保留原Promise/错误；只避免在等待B期间首个2秒红灯变成未处理拒绝而跳过清理。
  pendingA.catch(() => {})
  const until = performance.now() + 1500; while (!fs.existsSync(held) && performance.now() < until) await delay(5)
  assert.ok(fs.existsSync(held), '第一次原查询已得到running，仍在原查询的短句柄内')
  await delay(25); const raw = sampleRaw(events); assert.equal(raw.count, 1)
  child.stdin.end('exit'); await closed
  const after = await observerB.snapshot([child.pid]); report.subjectSnapshotCalls++
  assert.equal(after.processes[0].status, 'exited'); assert.equal(after.processes[0].waitResult, 0)
  fs.writeFileSync(release, 'release'); const before = await pendingA
  assert.equal(before.processes[0].status, 'running')
  assert.equal(before.processes[0].creationTimeFileTimeHex, after.processes[0].creationTimeFileTimeHex)
  assert.ok(before.processes[0].sampledAtMs > after.processes[0].exitAtMs + 1)
  assert.ok(after.processes[0].exitAtMs > raw.completedAtMs, 'OS退出晚于raw，所以绝不能据此排除raw=true')
  const nativeRows = [before, after].flatMap(s => classifyFixtureIdentitySample({ starts: events, processes: s.processes, expectedExecutable: process.execPath }).processes)
  const input = { events, rawSweeps: [raw], nativeRows, observerErrors: [] }; Object.assign(report, { input, before, after })
  try { const r = qualifyFixtureIdentityHistory(input); report.result = r; assert.equal(r.rawUnqualifiedPeak, 1); assert.equal(r.ownedPeak, 1); assert.equal(r.exclusions.length, 0); outcome = 'passed' } catch (e) { outcome = { code: e.code, message: e.message }; throw e }
  assert.equal(report.subjectSnapshotCalls, 2)
})

for (const [label, mutate] of [
  ['收据缺失', m => { delete m.rawSweeps[0].journalEventCount }],
  ['收据声称看见少于实际start', m => { m.rawSweeps[0].journalEventCount = 2 }],
  ['收据超过最终journal', m => { m.rawSweeps[0].journalEventCount = 4 }],
  ['已见完整前缀确证遗漏一个start', m => { m.rawSweeps[0].starts.pop(); m.rawSweeps[0].probes.pop(); m.rawSweeps[0].probeCount--; m.rawSweeps[0].count-- }],
]) test(`完整已见journal不放宽：${label}`, () => { const m = material(); mutate(m); assert.throws(() => qualifyFixtureIdentityHistory(m), /RAW_/); })

test('同样的重叠running/exit区间合法；明确非重叠的复活仍红', () => {
  const e = start(1), m = { events: [e], rawSweeps: [sweep(B + 40, [e], [probe(1, B + 40)])], nativeRows: [native(1, B + 50, B + 60), { ...native(1, B + 80), status: 'exited', exitAtMs: B + 55, waitResult: 0 }], observerErrors: [] }
  const r = gate(m); assert.equal(r.ownedPeak, 1); assert.equal(r.exclusions.length, 0)
  const impossible = clone(m); impossible.nativeRows[0].queryStartedAtMs = B + 58
  assert.throws(() => qualifyFixtureIdentityHistory(impossible), /NATIVE_.*CONFLICT/)
})

test('missing区间与旧baseline重叠：不确定不能排除，raw3仍owned3', () => {
  const m = material(); m.nativeRows.push({ pid: 3, status: 'missing', sampledAtMs: B + 700, queryStartedAtMs: B, queryCompletedAtMs: B + 700, nativeError: 87 })
  const r = qualifyFixtureIdentityHistory(m); assert.equal(r.ownedPeak, 3); assert.equal(r.exclusions.length, 0); assert.throws(() => gate(m))
  const definite = clone(m); definite.nativeRows.at(-1).queryStartedAtMs = B + 690
  assert.equal(gate(definite).ownedPeak, 2)
})

for (const [label, mutate] of [
  ['原生区间缺失', m => { delete m.nativeRows[2].queryStartedAtMs }],
  ['原生区间倒序', m => { m.nativeRows[2].queryStartedAtMs += 1 }],
  ['行尾和区间结束矛盾', m => { m.nativeRows[2].queryCompletedAtMs += 1 }],
]) test(`原生观测材料仍硬失败：${label}`, () => { const m = material(); mutate(m); assert.throws(() => qualifyFixtureIdentityHistory(m), /NATIVE_/); })

test('保守顺序raw3：物理至多2的时间线无前置身份排除证明时仍红', () => {
  const events = [start(1), start(2), start(3, B + 620)]
  const m = { events, rawSweeps: [sweep(B + 1000, events, [probe(1, B + 1000), probe(2, B + 1003), probe(3, B + 1006)], B + 1007)], nativeRows: [native(1), native(2), native(3, B + 650, B + 650, B + 600), { ...native(1, B + 1010, B + 1010, B + 1008), belongsToFixture: false }, { ...native(2, B + 1020, B + 1020, B + 1017), belongsToFixture: false }], observerErrors: [] }
  const r = qualifyFixtureIdentityHistory(m); assert.equal(r.rawUnqualifiedPeak, 3); assert.equal(r.ownedPeak, 3); assert.equal(r.exclusions.length, 0); assert.throws(() => gate(m))
})
