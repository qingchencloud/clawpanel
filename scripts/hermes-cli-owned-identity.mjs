// 合成CLI验收专用：保留原raw结果，只按前置时间证明排除旧创建身份；不控制产品进程。
import { createHash } from 'node:crypto'
export const FIXTURE_IDENTITY_LIMITS = Object.freeze({ materialBytes: 8 * 1024 * 1024, rawSweeps: 2048, rawProbes: 16384, nativeRows: 32768, starts: 128, outputBytes: 24576 })
const epoch = 116444736000000000n
const fail = code => { const error = new Error(`Fixture identity evidence: ${code}`); error.code = code; throw error }
const integer = n => Number.isSafeInteger(n) && n >= 0
const ticks = hex => { if (!/^[0-9a-f]{16}$/i.test(hex || '')) fail('NATIVE_IDENTITY'); return BigInt('0x' + hex) }
const lowerTick = ms => epoch + BigInt(ms) * 10000n
const startKey = s => `${s.pid}/${s.name}/${s.at}/${s.monotonicMs}`
const pickNative = r => ({ status: r.status, sampledAtMs: r.sampledAtMs, queryStartedAtMs: r.queryStartedAtMs, queryCompletedAtMs: r.queryCompletedAtMs, creationTimeFileTimeHex: r.creationTimeFileTimeHex ?? null, createdAtMs: r.createdAtMs ?? null, exitAtMs: r.exitAtMs ?? null, belongsToFixture: r.belongsToFixture ?? null, waitResult: r.waitResult, nativeError: r.nativeError, imageQueryError: r.imageQueryError ?? null })

// v2仅追加来源和因果证据；原PS UTC、FILETIME及raw字段均不转换或回填。
const nativeFields = ['pid', 'status', 'executablePath', 'creationTimeFileTimeHex', 'createdAtMs', 'exitAtMs', 'sampledAtMs', 'queryStartedAtMs', 'queryCompletedAtMs', 'nativeError', 'imageQueryError', 'waitResult']
const rawFields = ['pid', 'alive', 'errorCode', 'startedAtMs', 'completedAtMs', 'startedAtNs', 'completedAtNs']
const refFields = ['controllerPid', 'clockDomainId', 'transportSessionId', 'observerPid', 'requestId', 'rowsSha256']
const exactFields = (x, keys) => x && !Array.isArray(x) && typeof x === 'object' && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k))
const nsValue = n => typeof n === 'string' && /^(?:0|[1-9]\d{0,23})$/.test(n)
const idValue = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s)
const shaValue = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
function projectionDigest(rows, keys) {
  if (!Array.isArray(rows) || !rows.length || rows.length > FIXTURE_IDENTITY_LIMITS.starts) fail('CLEANUP_CAUSAL_ROWS')
  const projected = rows.map(row => {
    if (!row || !keys.every(k => Object.hasOwn(row, k))) fail('CLEANUP_CAUSAL_FIELDS')
    return Object.fromEntries(keys.map(k => [k, row[k]]))
  })
  return createHash('sha256').update(JSON.stringify(projected)).digest('hex')
}
export const fixtureNativeRowsDigest = rows => projectionDigest(rows, nativeFields)
export const fixtureRawProbesDigest = rows => projectionDigest(rows, rawFields)

function validateCleanupCausality(order, nativeRows, probes, pids) {
  const c = order.causal
  if (Buffer.byteLength(JSON.stringify(order)) > FIXTURE_IDENTITY_LIMITS.outputBytes) fail('CLEANUP_CAUSAL_BUDGET')
  if (!exactFields(order, ['kind', 'nativeCompletedAtMs', 'startedAtMs', 'completedAtMs', 'finalSnapshotRef', 'causal']) ||
      !exactFields(c, ['schemaVersion', 'phase', 'clock', ...refFields, 'orderedPids', 'send', 'receive', 'returned', 'rawBegin', 'rawEnd', 'rawSha256']) ||
      c.schemaVersion !== 2 || c.phase !== 'cleanup-final' || c.clock !== 'controller-process-hrtime-bigint-ns' ||
      !Number.isSafeInteger(c.controllerPid) || c.controllerPid <= 0 || !Number.isSafeInteger(c.observerPid) || c.observerPid <= 0 ||
      !Number.isSafeInteger(c.requestId) || c.requestId <= 0 || !idValue(c.clockDomainId) || !idValue(c.transportSessionId) || !shaValue(c.rowsSha256) || !shaValue(c.rawSha256)) fail('CLEANUP_CAUSAL_SCHEMA')
  if (!exactFields(order.finalSnapshotRef, refFields) || !refFields.every(k => order.finalSnapshotRef[k] === c[k])) fail('CLEANUP_CAUSAL_BINDING')
  if (!Array.isArray(c.orderedPids) || c.orderedPids.length !== pids.length || !c.orderedPids.every((p, i) => p === pids[i]) ||
      !nativeRows.every((r, i) => r.pid === pids[i]) || !probes.every((r, i) => r.pid === pids[i]) ||
      fixtureNativeRowsDigest(nativeRows) !== c.rowsSha256 || fixtureRawProbesDigest(probes) !== c.rawSha256) fail('CLEANUP_CAUSAL_PAYLOAD')
  let previous = null
  for (const point of [c.send, c.receive, c.returned, c.rawBegin, c.rawEnd]) {
    if (!exactFields(point, ['controllerPid', 'clockDomainId', 'sequence', 'ns', 'utcMs']) || point.controllerPid !== c.controllerPid || point.clockDomainId !== c.clockDomainId || !integer(point.sequence) || !point.sequence || !nsValue(point.ns) || !integer(point.utcMs)) fail('CLEANUP_CAUSAL_CLOCK')
    if (previous && (point.sequence <= previous.sequence || BigInt(point.ns) < BigInt(previous.ns))) fail('CLEANUP_NATIVE_AFTER_RAW_BOUND')
    previous = point
  }
  // 顺序只在此同controller域内比较；任何真正晚于raw的回包仍以原错误码拒绝。
  for (const p of probes) if (!nsValue(p.startedAtNs) || !nsValue(p.completedAtNs) || BigInt(p.startedAtNs) < BigInt(c.rawBegin.ns) || BigInt(p.completedAtNs) > BigInt(c.rawEnd.ns)) fail('CLEANUP_NATIVE_AFTER_RAW_BOUND')
  return c
}

export function qualifyFixtureIdentityHistory(material, { nativeIdentityAvailable = true } = {}) {
  let size
  try { size = Buffer.byteLength(JSON.stringify(material)) } catch { fail('MATERIAL_SCHEMA') }
  if (size > FIXTURE_IDENTITY_LIMITS.materialBytes || material.materialOverflow) fail('MATERIAL_BUDGET')
  const { events, rawSweeps, nativeRows, observerErrors } = material
  if (![events, rawSweeps, nativeRows, observerErrors].every(Array.isArray)) fail('MATERIAL_SCHEMA')
  if (observerErrors.length) fail('OBSERVATION_FAILED')
  if (!rawSweeps.length || rawSweeps.length > FIXTURE_IDENTITY_LIMITS.rawSweeps || nativeRows.length > FIXTURE_IDENTITY_LIMITS.nativeRows) fail('MATERIAL_BUDGET')
  const starts = events.filter(e => e.event === 'start'), byPid = new Map(), rowsByPid = new Map()
  if (!starts.length || starts.length > FIXTURE_IDENTITY_LIMITS.starts) fail('START_MATERIAL_BUDGET')
  for (const [id, s] of starts.entries()) {
    if (!Number.isSafeInteger(s.pid) || s.pid <= 0 || !integer(s.at) || !integer(s.monotonicMs) || !/^(?:burst-\d{1,3}|fail|recovery)$/.test(s.name || '')) fail('START_SCHEMA')
    if (byPid.has(s.pid)) fail('START_PID_REUSED_OR_DUPLICATED')
    byPid.set(s.pid, { id, start: s })
  }
  for (const row of nativeRows) {
    if (!byPid.has(row.pid) || !integer(row.sampledAtMs)) fail('NATIVE_SCHEMA')
    if (['createdAtMs', 'exitAtMs', 'waitResult', 'nativeError', 'imageQueryError'].some(key => row[key] != null && !integer(row[key])) || (row.belongsToFixture != null && typeof row.belongsToFixture !== 'boolean')) fail('NATIVE_SCHEMA')
    if (!integer(row.queryStartedAtMs) || !integer(row.queryCompletedAtMs)) fail('NATIVE_INTERVAL_MISSING')
    if (row.queryStartedAtMs > row.queryCompletedAtMs || row.queryCompletedAtMs !== row.sampledAtMs) fail('NATIVE_INTERVAL_INVALID')
    if (row.status === 'missing') {
      if (row.nativeError !== 87 || row.creationTimeFileTimeHex) fail('NATIVE_UNKNOWN_ABSENCE')
    } else if (row.status === 'running' || row.status === 'exited') {
      const creation = ticks(row.creationTimeFileTimeHex), createdMs = Number((creation - epoch) / 10000n)
      if (!integer(row.createdAtMs) || Math.abs(createdMs - row.createdAtMs) > 1 || creation > lowerTick(row.sampledAtMs + 1)) fail('NATIVE_TIME_CONFLICT')
      if (typeof row.belongsToFixture !== 'boolean' || row.nativeError !== 0) fail('NATIVE_IDENTITY_UNKNOWN')
      if (row.status === 'running' && (row.waitResult !== 258 || row.imageQueryError !== 0)) fail('NATIVE_RUNNING_UNKNOWN')
      if (row.status === 'exited' && (row.waitResult !== 0 || !integer(row.exitAtMs) || row.exitAtMs <= row.createdAtMs || row.exitAtMs > row.sampledAtMs + 1)) fail('NATIVE_EXIT_UNKNOWN')
    } else fail('NATIVE_OBSERVATION_UNKNOWN')
    if (!rowsByPid.has(row.pid)) rowsByPid.set(row.pid, [])
    rowsByPid.get(row.pid).push(row)
  }
  const baseline = new Map()
  for (const [pid, info] of byPid) {
    const rows = (rowsByPid.get(pid) || []).sort((a, b) => a.sampledAtMs - b.sampledAtMs)
    const candidates = rows.filter(r => r.status === 'running' && r.belongsToFixture && ticks(r.creationTimeFileTimeHex) < lowerTick(info.start.at))
    const births = new Set(candidates.map(r => r.creationTimeFileTimeHex))
    if (births.size > 1) fail('BASELINE_AMBIGUOUS')
    if (!candidates.length) {
      if (nativeIdentityAvailable) fail('BASELINE_MISSING')
      continue
    }
    const first = candidates[0]
    const replacements = rows.filter(r => r.status !== 'missing' && r.creationTimeFileTimeHex !== first.creationTimeFileTimeHex)
    for (const next of replacements) {
      if (ticks(next.creationTimeFileTimeHex) <= lowerTick(info.start.at + 1)) fail('START_IDENTITY_CONFLICT')
      if (rows.some(r => r.status === 'running' && r.creationTimeFileTimeHex === first.creationTimeFileTimeHex && r.queryStartedAtMs > next.createdAtMs + 1)) fail('NATIVE_IDENTITY_CONFLICT')
    }
    for (const gone of rows) {
      const goneAt = gone.status === 'missing' && gone.queryStartedAtMs > first.queryCompletedAtMs + 1 ? gone.queryCompletedAtMs
        : gone.status === 'exited' && gone.creationTimeFileTimeHex === first.creationTimeFileTimeHex ? gone.exitAtMs : null
      if (goneAt !== null && rows.some(r => r.status === 'running' && r.creationTimeFileTimeHex === first.creationTimeFileTimeHex && r.queryStartedAtMs > goneAt + 1)) fail('NATIVE_ABSENCE_CONFLICT')
    }
    baseline.set(pid, { first, rows, replacements })
  }
  let rawUnqualifiedPeak = 0, ownedPeak = 0, rawProbeCount = 0, rawPeakWitness = null, ownedPeakWitness = null, lastSweepAt = -1
  const proofs = [], proofIds = new Map(), exclusions = [], historical = new Set()
  let previousProbeEndNs = -1n, previousJournalCount = 0
  for (const [sweepIndex, sweep] of rawSweeps.entries()) {
    if (!integer(sweep.startedAtMs) || !integer(sweep.completedAtMs) || sweep.completedAtMs < sweep.startedAtMs || sweep.startedAtMs < lastSweepAt || !Array.isArray(sweep.starts) || !Array.isArray(sweep.probes)) fail('RAW_SCHEMA')
    lastSweepAt = sweep.startedAtMs
    const seen = new Map()
    for (const s of sweep.starts) {
      const known = byPid.get(s.pid)?.start
      if (!known || startKey(s) !== startKey(known) || known.birthId !== s.birthId || seen.has(s.pid) || s.at > sweep.startedAtMs) fail('RAW_START_IDENTITY_CONFLICT')
      seen.set(s.pid, s)
    }
    if ([...historical].some(pid => !seen.has(pid))) fail('RAW_HISTORY_MISSING')
    for (const pid of seen.keys()) historical.add(pid)
    if (sweep.probeCount !== sweep.probes.length || seen.size !== sweep.probes.length) fail('RAW_PROBE_MISSING')
    rawProbeCount += sweep.probes.length
    if (rawProbeCount > FIXTURE_IDENTITY_LIMITS.rawProbes) fail('MATERIAL_BUDGET')
    const visited = new Set(), witness = []
    let rawCount = 0, ownedCount = 0
    for (const [probeIndex, probe] of sweep.probes.entries()) {
      if (!seen.has(probe.pid) || visited.has(probe.pid) || typeof probe.alive !== 'boolean' || !integer(probe.startedAtMs) || !integer(probe.completedAtMs) || probe.startedAtMs < sweep.startedAtMs || probe.completedAtMs > sweep.completedAtMs || probe.completedAtMs < probe.startedAtMs || !/^\d{1,24}$/.test(probe.startedAtNs || '') || !/^\d{1,24}$/.test(probe.completedAtNs || '') || BigInt(probe.completedAtNs) < BigInt(probe.startedAtNs)) fail('RAW_PROBE_UNKNOWN')
      if (BigInt(probe.startedAtNs) < previousProbeEndNs) fail('RAW_PROBE_ORDER')
      previousProbeEndNs = BigInt(probe.completedAtNs)
      visited.add(probe.pid)
      if ((!probe.alive && probe.errorCode !== 'ESRCH') || (probe.alive && probe.errorCode != null)) fail('RAW_ERROR_UNKNOWN')
      const point = { pid: probe.pid, alive: probe.alive, errorCode: probe.alive ? null : probe.errorCode, startedAtMs: probe.startedAtMs, completedAtMs: probe.completedAtMs, startedAtNs: probe.startedAtNs, completedAtNs: probe.completedAtNs }
      if (!probe.alive) { witness.push(point); continue }
      rawCount++
      const base = baseline.get(probe.pid), start = byPid.get(probe.pid)
      // 非Windows保持原raw保守门禁，绝不在缺原生观察时推断排除。
      if (!nativeIdentityAvailable) { ownedCount++; witness.push({ ...point, startId: start.id, classification: 'unqualified-no-exclusions' }); continue }
      if (!base) fail('BASELINE_MISSING')
      // 新出生必须严格早于raw毫秒下界；仅“在raw之后看见了新PID”不是证明。
      let row = base.replacements.find(r => ticks(r.creationTimeFileTimeHex) < lowerTick(probe.startedAtMs)), kind
      if (row) kind = 'replacement-born-before-probe'
      if (!row) {
        row = base.rows.find(r => r.status === 'exited' && r.creationTimeFileTimeHex === base.first.creationTimeFileTimeHex && r.exitAtMs + 1 < probe.startedAtMs)
        if (row) kind = 'same-creation-os-exit-before-probe'
      }
      if (!row) {
        row = base.rows.find(r => r.status === 'missing' && r.queryStartedAtMs > base.first.queryCompletedAtMs + 1 && r.queryCompletedAtMs + 1 < probe.startedAtMs)
        if (row) kind = 'known-native-absence-before-probe'
      }
      if (!row) { ownedCount++; witness.push({ ...point, startId: start.id, expectedCreation: base.first.creationTimeFileTimeHex, classification: 'conservatively-owned' }); continue }
      const key = `${start.id}/${kind}/${row.creationTimeFileTimeHex || ''}/${row.sampledAtMs}`
      let proofId = proofIds.get(key)
      if (proofId === undefined) {
        proofId = proofs.length; proofIds.set(key, proofId)
        proofs.push({ id: proofId, pid: probe.pid, startId: start.id, kind, expectedCreation: base.first.creationTimeFileTimeHex, baseline: pickNative(base.first), witness: pickNative(row) })
      }
      exclusions.push([sweepIndex, probeIndex, proofId, probe.startedAtMs, probe.completedAtMs])
      witness.push({ ...point, startId: start.id, expectedCreation: base.first.creationTimeFileTimeHex, classification: 'proved-not-old-start', proofId })
    }
    // 产生时间不是文件可见时间。用同一次完整readEvents的长度对照最终追加journal前缀，
    // 同时保留以前已见历史与最终全start覆盖；收据缺失/回退/确证遗漏一律失败。
    if (!integer(sweep.journalEventCount) || sweep.journalEventCount < previousJournalCount || sweep.journalEventCount > events.length) fail('RAW_JOURNAL_RECEIPT')
    const visibleStarts = events.slice(0, sweep.journalEventCount).filter(e => e.event === 'start')
    if (visibleStarts.length !== seen.size || visibleStarts.some((s, i) => s.pid !== sweep.starts[i]?.pid)) fail('RAW_START_MISSING')
    previousJournalCount = sweep.journalEventCount
    if (sweep.count !== undefined && sweep.count !== rawCount) fail('RAW_COUNT_CONFLICT')
    const snapshot = { sweepIndex, startedAtMs: sweep.startedAtMs, completedAtMs: sweep.completedAtMs, rawCount, ownedCount, probes: witness }
    if (rawCount > rawUnqualifiedPeak) { rawUnqualifiedPeak = rawCount; rawPeakWitness = snapshot }
    if (ownedCount > ownedPeak) { ownedPeak = ownedCount; ownedPeakWitness = snapshot }
  }
  if (historical.size !== byPid.size) fail('RAW_START_MISSING')
  return { event: 'hermes-bounds-identity', schema: 1, samplingNotAtomic: true, nativeQualification: nativeIdentityAvailable ? 'creation-identity' : 'unavailable-no-exclusions', ownedPeakSemantics: 'conservative upper bound over original sequential raw probes', rawUnqualifiedPeak, ownedPeak, rawSweepCount: rawSweeps.length, rawProbeCount,
    starts: starts.map((s, id) => ({ id, pid: s.pid, name: s.name, at: s.at, monotonicMs: s.monotonicMs })), proofs, exclusions, rawPeakWitness, ownedPeakWitness }
}

// 使用原侧车已取得的材料，不增加查询/重试；Windows缺材料不得降级为raw通过。
export function evaluateFixtureBoundsGate(report, nativeIdentityAvailable) {
  return qualifyFixtureIdentityHistory({ events: report.events, rawSweeps: report.rawSweeps,
    nativeRows: report.observations.flatMap(o => o.processes), observerErrors: report.observerErrors,
    materialOverflow: report.materialOverflow }, { nativeIdentityAvailable })
}

// 独立stdout JSON行绕开TAP错误消息的inspect截断；超预算必须失败，绝不slice/pop材料。
export function encodeFixtureIdentityEvidence(result) {
  const line = JSON.stringify(result)
  if (Buffer.byteLength(line) > FIXTURE_IDENTITY_LIMITS.outputBytes) fail('OUTPUT_BUDGET')
  return line
}

// finally阶段独立资格：不复用peak的结论，不把后续fail/recovery冒充已验并发。
// 只消费原snapshot与原kill0材料；不查询、不重试、不控制进程。
export function qualifyFixtureCleanup(material, { nativeIdentityAvailable = true } = {}) {
  let bytes
  try { bytes = Buffer.byteLength(JSON.stringify(material)) } catch { fail('CLEANUP_SCHEMA') }
  if (bytes > FIXTURE_IDENTITY_LIMITS.materialBytes || material.materialOverflow) fail('CLEANUP_MATERIAL_BUDGET')
  const { events, historyNativeRows, cleanupNativeRows, rawProbes, rawOrder, observerErrors } = material
  if (![events, historyNativeRows, cleanupNativeRows, rawProbes, observerErrors].every(Array.isArray) || !rawOrder) fail('CLEANUP_SCHEMA')
  if (observerErrors.length) fail('CLEANUP_OBSERVATION_FAILED')
  const starts = events.filter(e => e.event === 'start'), byPid = new Map()
  if (!starts.length || starts.length > FIXTURE_IDENTITY_LIMITS.starts || historyNativeRows.length + cleanupNativeRows.length > FIXTURE_IDENTITY_LIMITS.nativeRows) fail('CLEANUP_MATERIAL_BUDGET')
  for (const s of starts) {
    if (!Number.isSafeInteger(s.pid) || s.pid <= 0 || !integer(s.at) || !integer(s.monotonicMs) || !/^(?:burst-\d{1,3}|fail|recovery)$/.test(s.name || '') || typeof s.birthId !== 'string' || !s.birthId.length || s.birthId.length > 128) fail('CLEANUP_START_SCHEMA')
    if (byPid.has(s.pid)) fail('CLEANUP_START_PID_REUSED')
    byPid.set(s.pid, s)
  }
  if (rawProbes.length !== starts.length || cleanupNativeRows.length !== (nativeIdentityAvailable ? starts.length : 0)) fail('CLEANUP_MISSING_MATERIAL')
  const legacy = rawOrder.kind === 'frozen-source-order-lower-bound'
  const causal = rawOrder.kind === 'captured-controller-causal-order-v2'
  let causalReceipt
  if (causal) {
    if (!nativeIdentityAvailable) fail('CLEANUP_CAUSAL_NATIVE_REQUIRED')
    causalReceipt = validateCleanupCausality(rawOrder, cleanupNativeRows, rawProbes, starts.map(s => s.pid))
    if (![rawOrder.nativeCompletedAtMs, rawOrder.startedAtMs, rawOrder.completedAtMs].every(integer) || rawOrder.nativeCompletedAtMs > rawOrder.startedAtMs || rawOrder.completedAtMs < rawOrder.startedAtMs) fail('CLEANUP_RAW_ORDER')
  } else if (legacy) {
    // 旧CI未捕获raw时点/错误码：仅接受显式冻结源码的await顺序下界，不补造时间或ESRCH。
    if (!nativeIdentityAvailable || rawOrder.awaitFinalNativeBeforeRaw !== true || !/^[0-9a-f]{40}$/.test(rawOrder.sourceSha || '') || !/^[0-9a-f]{64}$/.test(rawOrder.sourceTestSha256 || '') || !integer(rawOrder.notBeforeMs) ||
      rawOrder.notBeforeMs !== Math.max(...cleanupNativeRows.map(row => row.queryCompletedAtMs)) - 1) fail('CLEANUP_SOURCE_ORDER_MISSING')
  } else if (rawOrder.kind !== (nativeIdentityAvailable ? 'captured-after-final-native' : 'captured-raw-only') || !integer(rawOrder.startedAtMs) || !integer(rawOrder.completedAtMs) || rawOrder.completedAtMs < rawOrder.startedAtMs ||
    (nativeIdentityAvailable && (!integer(rawOrder.nativeCompletedAtMs) || rawOrder.nativeCompletedAtMs > rawOrder.startedAtMs))) fail('CLEANUP_RAW_ORDER')
  if (!nativeIdentityAvailable && historyNativeRows.length) fail('CLEANUP_NATIVE_UNAVAILABLE')
  const rowsByPid = new Map(), finals = new Map()
  const validateRow = row => {
    const start = byPid.get(row.pid)
    if (!start || !integer(row.queryStartedAtMs) || !integer(row.queryCompletedAtMs) || row.queryStartedAtMs > row.queryCompletedAtMs || row.queryCompletedAtMs !== row.sampledAtMs) fail('CLEANUP_NATIVE_INTERVAL')
    if (row.receipt && (startKey(row.receipt) !== startKey(start) || row.receipt.birthId !== start.birthId)) fail('CLEANUP_NATIVE_RECEIPT')
    if (['createdAtMs', 'exitAtMs', 'waitResult', 'nativeError', 'imageQueryError'].some(k => row[k] != null && !integer(row[k]))) fail('CLEANUP_NATIVE_SCHEMA')
    if (row.status === 'missing') {
      if (row.nativeError !== 87 || row.creationTimeFileTimeHex || row.waitResult !== 4294967295 || row.imageQueryError !== 0) fail('CLEANUP_NATIVE_UNKNOWN_MISSING')
    } else if (row.status === 'running' || row.status === 'exited') {
      const birth = ticks(row.creationTimeFileTimeHex), birthMs = Number((birth - epoch) / 10000n)
      if (!integer(row.createdAtMs) || Math.abs(birthMs - row.createdAtMs) > 1 || birth > lowerTick(row.queryCompletedAtMs + 1) || row.nativeError !== 0 || typeof row.belongsToFixture !== 'boolean') fail('CLEANUP_NATIVE_IDENTITY')
      if (row.status === 'running' && (row.waitResult !== 258 || row.imageQueryError !== 0 || row.exitAtMs !== 0)) fail('CLEANUP_NATIVE_RUNNING')
      if (row.status === 'exited' && (row.waitResult !== 0 || !integer(row.exitAtMs) || row.exitAtMs <= row.createdAtMs || row.exitAtMs > row.queryCompletedAtMs + 1)) fail('CLEANUP_NATIVE_EXIT')
    } else fail('CLEANUP_NATIVE_UNKNOWN')
    if (!rowsByPid.has(row.pid)) rowsByPid.set(row.pid, [])
    rowsByPid.get(row.pid).push(row)
  }
  historyNativeRows.forEach(validateRow)
  for (const row of cleanupNativeRows) {
    validateRow(row)
    if (finals.has(row.pid)) fail('CLEANUP_NATIVE_DUPLICATE')
    finals.set(row.pid, row)
    const bound = legacy ? rawOrder.notBeforeMs : rawOrder.nativeCompletedAtMs
    // 原PS -as[long]四舍五入，JS Date.now向下取整；只核验不矛盾的1ms包络。
    // 排除仍用原始raw毫秒下界/更保守的旧源码下界，绝不把+1当成出生证明。
    if (!causal) {
      if (row.queryCompletedAtMs > bound + 1) fail('CLEANUP_NATIVE_AFTER_RAW_BOUND')
    }
  }
  let previousNs = -1n, rawAliveCount = 0
  const rows = rawProbes.map((probe, index) => {
    const start = starts[index], pid = start.pid, final = finals.get(pid)
    if (probe.pid !== pid || typeof probe.alive !== 'boolean' || probe.observationFailed) fail('CLEANUP_RAW_MISSING_OR_UNKNOWN')
    let rawLowerBoundMs
    if (legacy) {
      if (probe.startedAtMs !== undefined || probe.completedAtMs !== undefined || probe.startedAtNs !== undefined || probe.completedAtNs !== undefined) fail('CLEANUP_LEGACY_INVENTED_RAW_TIME')
      rawLowerBoundMs = rawOrder.notBeforeMs
    } else {
      if (!integer(probe.startedAtMs) || !integer(probe.completedAtMs) || probe.startedAtMs < rawOrder.startedAtMs || probe.completedAtMs > rawOrder.completedAtMs || probe.completedAtMs < probe.startedAtMs || !/^\d{1,24}$/.test(probe.startedAtNs || '') || !/^\d{1,24}$/.test(probe.completedAtNs || '') || BigInt(probe.completedAtNs) < BigInt(probe.startedAtNs) || BigInt(probe.startedAtNs) < previousNs) fail('CLEANUP_RAW_INTERVAL')
      previousNs = BigInt(probe.completedAtNs); rawLowerBoundMs = probe.startedAtMs
    }
    if (rawLowerBoundMs <= start.at || (probe.alive && (legacy ? probe.errorCode != null : probe.errorCode !== null)) || (!probe.alive && probe.errorCode !== 'ESRCH' && !(legacy && probe.errorCode === undefined))) fail('CLEANUP_RAW_ERROR_OR_TIME')
    const history = rowsByPid.get(pid) || []
    const candidates = history.filter(r => r.status === 'running' && r.belongsToFixture && ticks(r.creationTimeFileTimeHex) < lowerTick(start.at) && r.queryCompletedAtMs < rawLowerBoundMs)
    if (new Set(candidates.map(r => r.creationTimeFileTimeHex)).size > 1) fail('CLEANUP_BASELINE_AMBIGUOUS')
    const baseline = candidates.sort((a, b) => a.queryCompletedAtMs - b.queryCompletedAtMs)[0]
    if (baseline) {
      for (const r of history) {
        const different = r.status !== 'missing' && r.creationTimeFileTimeHex !== baseline.creationTimeFileTimeHex
        if (different && ticks(r.creationTimeFileTimeHex) <= lowerTick(start.at + 1)) fail('CLEANUP_START_IDENTITY_CONFLICT')
        const gone = r.status === 'missing' && r.queryStartedAtMs > baseline.queryCompletedAtMs + 1 ? r.queryCompletedAtMs
          : r.status === 'exited' && r.creationTimeFileTimeHex === baseline.creationTimeFileTimeHex ? r.exitAtMs : different ? r.createdAtMs : null
        if (gone !== null && history.some(old => old.status === 'running' && old.creationTimeFileTimeHex === baseline.creationTimeFileTimeHex && old.queryStartedAtMs > gone + 1)) fail('CLEANUP_NATIVE_CONTRADICTION')
      }
    }
    let proof = null
    if (!probe.alive && probe.errorCode === 'ESRCH') proof = { kind: 'raw-esrch' }
    else if (!probe.alive && final?.status === 'missing' && final.queryStartedAtMs > start.at + 1) proof = { kind: 'explicit-native-missing-before-raw', witness: pickNative(final) }
    else if (probe.alive && nativeIdentityAvailable) {
      if (!baseline) fail('CLEANUP_BASELINE_MISSING')
      if (final.status !== 'missing' && final.creationTimeFileTimeHex !== baseline.creationTimeFileTimeHex && ticks(final.creationTimeFileTimeHex) > lowerTick(start.at + 1) && ticks(final.creationTimeFileTimeHex) < lowerTick(rawLowerBoundMs)) proof = { kind: 'replacement-born-before-raw', baseline: pickNative(baseline), witness: pickNative(final) }
      else if (final.status === 'exited' && final.creationTimeFileTimeHex === baseline.creationTimeFileTimeHex && final.exitAtMs + 1 < rawLowerBoundMs) proof = { kind: 'same-creation-os-exit-before-raw', baseline: pickNative(baseline), witness: pickNative(final) }
      else if (final.status === 'missing' && final.queryStartedAtMs > baseline.queryCompletedAtMs + 1 && final.queryCompletedAtMs + 1 < rawLowerBoundMs) proof = { kind: 'known-native-absence-before-raw', baseline: pickNative(baseline), witness: pickNative(final) }
    }
    if (probe.alive) rawAliveCount++
    return { pid, name: start.name, rawAlive: probe.alive, rawErrorCode: probe.errorCode ?? (legacy ? 'not-captured' : null), rawLowerBoundMs,
      oldFixtureIdentityAbsent: proof !== null, proof, ...(legacy ? {} : { rawStartedAtMs: probe.startedAtMs, rawCompletedAtMs: probe.completedAtMs, rawStartedAtNs: probe.startedAtNs, rawCompletedAtNs: probe.completedAtNs }) }
  })
  return { event: 'hermes-bounds-cleanup-identity', schema: causal ? 2 : 1, phase: 'cleanup-not-peak', samplingNotAtomic: true,
    ...(causal ? { causalOrderValidated: true, causalReceipt, legacyPredicate: cleanupNativeRows.every(row => row.queryCompletedAtMs <= rawOrder.nativeCompletedAtMs + 1), clockSources: { workerUtc: 'dotnet-utc-ms-rounded', controllerUtc: 'node-date-now-ms', ordering: 'same-controller-hrtime-bigint-ns' } } : {}),
    rawTiming: legacy ? 'source-order-lower-bound-not-captured-raw-time' : 'captured-original-kill0', rawAliveCount,
    allOldFixtureIdentitiesAbsent: rows.every(row => row.oldFixtureIdentityAbsent), rows }
}
