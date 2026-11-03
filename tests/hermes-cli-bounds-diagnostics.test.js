// 诊断只能解释原红灯；不能改变采样结果、预算或以缺失身份补绿。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const fixture = () => {
  const starts = [1, 2, 3].map(pid => ({ event: 'start', pid, at: 100, name: `burst-${pid}`, birthId: `fixture-${pid}` }))
  const raw = starts.map(row => ({ pid: row.pid, alive: true, startedAtMs: 200, completedAtMs: 201, startedAtNs: '200000000', completedAtNs: '201000000' }))
  const native = (pid, sampledAtMs, creation) => ({ pid, sampledAtMs, status: 'running', creationTimeFileTimeHex: creation, createdAtMs: 90, belongsToFixture: true, executablePath: 'SECRET-PATH/hermes.exe', waitResult: 258 })
  return { peak: 3, legacyPeak: 3, nativePeak: 2, rawPeakSamples: [{ count: 3, startedAtMs: 200, completedAtMs: 201, probes: raw, probeCount: 3, starts }], events: starts, observations: [{ processes: [native(1, 190, '0000000000000001'), native(2, 190, '0000000000000002'), native(3, 190, '0000000000000003')] }, { processes: [native(1, 210, '0000000000000001'), { ...native(2, 210, '0000000000000004'), belongsToFixture: false }, native(3, 210, '0000000000000003')] }], observerErrors: [], requests: [{ status: 500, value: { error: 'SECRET-ERROR token=SECRET-TOKEN' } }] }
}

test('bounds失败诊断包含原raw探针与前后native创建身份，明确不同时间不等于原子峰值', async () => {
  const { formatFixtureBoundsFailure } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  assert.equal(typeof formatFixtureBoundsFailure, 'function')
  const report = fixture(), before = structuredClone(report), result = JSON.parse(formatFixtureBoundsFailure(report))
  assert.equal(result.rawPeak, 3)
  assert.equal(result.nativePeak, 2)
  assert.equal(result.samplingNotSimultaneous, true)
  assert.equal(result.cause, 'unresolved')
  assert.equal(result.samples[0].count, 3)
  assert.equal(result.samples[0].pids[1].nativeBefore.creationTimeFileTimeHex, '0000000000000002')
  assert.equal(result.samples[0].pids[1].nativeAfter.creationTimeFileTimeHex, '0000000000000004')
  assert.equal(result.samples[0].pids[1].nativeAfter.belongsToFixture, false)
  assert.equal(result.samples[0].pids[1].start.name, 'burst-2')
  assert.equal(result.failureRecoveryPhase, 'not-reached')
  assert.deepEqual(report, before, '只读诊断不能修改原报告或计数')
})

test('bounds失败诊断有界且不序列化env/argv/路径/原error；缺native仍为unknown', async () => {
  const { formatFixtureBoundsFailure } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  const report = fixture()
  report.env = { TOKEN: 'SECRET-TOKEN' }; report.observerErrors = ['SECRET-ERROR']
  report.rawPeakSamples = Array.from({ length: 5000 }, () => structuredClone(report.rawPeakSamples[0]))
  const encoded = formatFixtureBoundsFailure(report)
  assert.ok(Buffer.byteLength(encoded) <= 24576)
  assert.doesNotMatch(encoded, /SECRET-|executablePath|TOKEN|argv/)
  const result = JSON.parse(encoded)
  assert.ok(result.samples.length <= 3)
  assert.equal(result.observerErrorCount, 1)
  const missing = JSON.parse(formatFixtureBoundsFailure({ peak: 3, rawPeakSamples: fixture().rawPeakSamples, observations: [] }))
  assert.equal(missing.samples[0].pids[0].nativeBefore, null)
  assert.equal(missing.samples[0].pids[0].nativeAfter, null)
  assert.equal(missing.cause, 'unresolved')
})

test('原HTTP predicate/raw25ms/预算与断言保持；诊断不增加kill0或原生采样调用', () => {
  const current = fs.readFileSync(new URL('./hermes-cli-bounds.test.js', import.meta.url), 'utf8')
  assert.match(current, /assert\.ok\(peak <= 2,/)
  assert.match(current, /pids\.filter\(alive\)\.length/)
  assert.equal((current.match(/observer\.snapshot\(pids\)/g) || []).length, 2)
  assert.equal((current.match(/process\.kill\(pid, 0\)/g) || []).length, 1)
  assert.ok(current.includes('}, 25)'))
  assert.ok(current.includes("{ timeout: 35000 }"))
  for (const guard of ['health.ms < 2000', 'report.wallMs >= 14500 && report.wallMs < 17500', 'starts.length <= 6 && starts.length >= 4', 'e.monotonicMs - startedMonotonicMs < 15000', 'report.nativePeak <= 2']) assert.ok(current.includes(guard), guard)
})

test('原assert实际执行仍拒绝所属peak3；错误仅引用独立证据，不依赖inspect长消息', () => {
  const source = fs.readFileSync(new URL('./hermes-cli-bounds.test.js', import.meta.url), 'utf8')
  const statement = source.split('\n').find(line => line.trim().startsWith('assert.ok(peak <= 2,'))
  assert.ok(statement)
  const execute = new Function('assert', 'peak', 'report', statement)
  assert.throws(() => execute(assert, 3, { identityGate: { rawUnqualifiedPeak: 3 } }), error => {
    assert.equal(error.code, 'ERR_ASSERTION')
    assert.match(error.message, /实际所属创建身份峰值 3/)
    assert.match(error.message, /原raw峰值 3/)
    assert.match(error.message, /hermes-bounds-identity JSON/)
    assert.match(error.message, /非atomic/)
    assert.doesNotMatch(error.message, /SECRET-/)
    assert.ok(Buffer.byteLength(error.message) < 1000)
    return true
  })
  execute(assert, 2, { identityGate: { rawUnqualifiedPeak: 3 } })
})

test('HTTP身份接线必须收集完整原raw并先独立输出，再按所属peak执行原门限', () => {
  const source = fs.readFileSync(new URL('./hermes-cli-bounds.test.js', import.meta.url), 'utf8')
  assert.match(source, /report\.rawSweeps\.push\(/)
  assert.match(source, /report\.identityGate = evaluateFixtureBoundsGate\(report, process\.platform === 'win32'\)/)
  assert.match(source, /const peak = report\.identityGate\.ownedPeak/)
  assert.ok(source.indexOf('console.log(encodeFixtureIdentityEvidence(report.identityGate))') < source.indexOf('assert.ok(peak <= 2,'))
  assert.match(source, /rawUnqualifiedPeak = Math\.max\(rawUnqualifiedPeak, count\)/)
  assert.match(source, /report\.materialOverflow = true/)
  assert.doesNotMatch(source, /sink\.probes\.length < 8/)
  assert.doesNotMatch(source, /starts: starts\.slice\(-8\)/)
  assert.match(source, /journalEventCount: events\.length/)
})
