// 可信工具只解析同一次execFile.stderr；不查询进程，不执行日志，不构成资格证明。
const prefix = 'CLAWPANEL_HERMES_STATUS_TAIL '
const phasePrefix = 'CLAWPANEL_HERMES_PHASE '
const moduleSha = 'a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899'
const names = ['_print_duplicate_credential_warnings', '_print_other_profiles_gateway_status', '_print_standalone_by_config']
const order = [['observer', 'enter'], ...names.flatMap(name => [[name, 'enter'], [name, 'return']]), ['observer', 'return']]
const fields = ['schemaVersion', 'scope', 'target', 'event', 'pid', 'ppid', 'sequence', 'elapsedMs', 'utc', 'moduleSha256']
const fail = reason => { throw new Error('STATUS_TAIL_' + reason) }
const integer = value => Number.isSafeInteger(value) && value > 0

export function decodeStatusTailObservation(input, { rootPid } = {}) {
  if (!integer(rootPid)) fail('ROOT_PID')
  let text
  try { text = Buffer.isBuffer(input) ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input } catch { fail('UTF8') }
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576) fail('INPUT_BUDGET')
  const rows = [], phases = [], entries = new Map()
  let used = 0, clock = 0
  const lines = text.match(/[^\n]*(?:\n|$)/g).filter(Boolean)
  for (const [index, line] of lines.entries()) {
    if (line.startsWith(phasePrefix)) {
      let phase
      try { phase = JSON.parse(line.slice(phasePrefix.length)) } catch { fail('PHASE_JSON') }
      if (phase.scope !== 'launch') continue
      if (phases.length >= 128 || Buffer.byteLength(line) > 1024 || phase.schemaVersion !== 1 || !integer(phase.pid) || !integer(phase.ppid)) fail('PHASE_CONTRACT')
      phases.push({ ...phase, index })
      if (phase.phase === 'entry') {
        if (entries.has(phase.pid)) fail('DUPLICATE_ENTRY')
        entries.set(phase.pid, phase.ppid)
      }
    }
    if (!line.startsWith(prefix)) continue
    const size = Buffer.byteLength(line)
    used += size
    if (!line.endsWith('\n') || size > 1024 || used > 8192 || rows.length >= order.length) fail('EVENT_BUDGET_OR_CLOSURE')
    const raw = line.slice(prefix.length).replace(/\r?\n$/, '')
    let row
    try { row = JSON.parse(raw) } catch { fail('EVENT_JSON') }
    if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).length !== fields.length || !fields.every(key => Object.hasOwn(row, key))) fail('FIELDS')
    // 值均限定为原始标量；原始key计数同时拒绝重复或转义key，不接受JSON覆盖语义。
    const keys = [...raw.matchAll(/(?:^\s*\{|,)\s*"((?:\\.|[^"\\])*)"\s*:/g)].map(match => match[1])
    if (keys.length !== fields.length || new Set(keys).size !== fields.length || !keys.every(key => fields.includes(key))) fail('DUPLICATE_OR_ESCAPED_KEY')
    if (row.schemaVersion !== 1 || row.scope !== 'hermes-status-tail-diagnostic' || row.moduleSha256 !== moduleSha) fail('SOURCE')
    if (!integer(row.pid) || !integer(row.ppid) || row.sequence !== rows.length + 1) fail('IDENTITY_OR_SEQUENCE')
    const expected = order[rows.length]
    if (row.target !== expected[0] || row.event !== expected[1]) fail('ORDER')
    if (typeof row.elapsedMs !== 'number' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < clock || (!rows.length && row.elapsedMs !== 0)) fail('CLOCK')
    if (typeof row.utc !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?\+00:00$/.test(row.utc) || !Number.isFinite(Date.parse(row.utc)) || new Date(row.utc).toISOString().slice(0, 19) !== row.utc.slice(0, 19)) fail('UTC')
    if (rows.length && (row.pid !== rows[0].row.pid || row.ppid !== rows[0].row.ppid)) fail('MIXED_PROCESS')
    rows.push({ row, index }); clock = row.elapsedMs
  }
  if (rows.length !== order.length) fail('INCOMPLETE')
  const { pid, ppid } = rows[0].row
  if (entries.get(pid) !== ppid) fail('MISSING_ENTRY')
  const lineage = [], seen = new Set()
  let current = pid
  while (current !== rootPid) {
    if (seen.has(current) || lineage.length >= 16 || !entries.has(current)) fail('PARENT_CHAIN')
    seen.add(current); lineage.push(current); current = entries.get(current)
  }
  lineage.push(rootPid)
  const main = phases.filter(row => row.pid === pid && row.phase === 'main_b')
  const exit = phases.filter(row => row.pid === pid && row.phase === 'main_exit')
  if (main.length !== 1 || exit.length !== 1 || main[0].ppid !== ppid || exit[0].ppid !== ppid || !(rows[0].index < main[0].index && main[0].index < rows[1].index && rows.at(-1).index < exit[0].index)) fail('PHASE_BOUNDARY')
  return {
    diagnosticValid: true, qualificationPass: false,
    scope: 'strict original execFile.stderr only; not runtime qualification or performance fix',
    clockScope: 'one observer PID/perf origin; not _hp elapsed clock',
    pid, ppid, lineage, moduleSha256: moduleSha, bytes: used,
    events: rows.map(item => item.row),
    tails: names.map((target, i) => ({ target, intervalMs: Number((rows[2 + i * 2].row.elapsedMs - rows[1 + i * 2].row.elapsedMs).toFixed(3)), includesObserverWriteOverhead: true })),
  }
}
