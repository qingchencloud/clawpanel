// 仅供合成 CLI 边界测试：按原生创建身份观察，不终止被查询的 PID。
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { fixtureNativeRowsDigest, fixtureRawProbesDigest, FIXTURE_IDENTITY_LIMITS } from './hermes-cli-owned-identity.mjs'

// 域属于此controller实例，不跨Node/worker比较单调时钟；只记录自己已有管道事件。
const clockDomainId = randomUUID().replaceAll('-', '')
let clockSequence = 0
const markController = () => ({ controllerPid: process.pid, clockDomainId, sequence: ++clockSequence, ns: process.hrtime.bigint().toString(), utcMs: Date.now() })
const authenticSnapshots = new WeakMap(), rawScopes = new WeakSet()
const finalRef = c => Object.fromEntries(['controllerPid', 'clockDomainId', 'transportSessionId', 'observerPid', 'requestId', 'rowsSha256'].map(k => [k, c[k]]))
const causalBudget = value => { if (Buffer.byteLength(JSON.stringify(value)) > FIXTURE_IDENTITY_LIMITS.outputBytes) throw new Error('CLEANUP_CAUSAL_BUDGET') }

export function beginFixtureCleanupRaw() {
  const scope = Object.freeze({ rawBegin: Object.freeze(markController()) }); rawScopes.add(scope); return scope
}

export function finishFixtureCleanupRaw(scope, snapshot, probes, { startedAtMs, completedAtMs }) {
  const rawEnd = markController(), stored = authenticSnapshots.get(snapshot)
  if (!rawScopes.has(scope) || !stored || JSON.stringify(snapshot) !== stored || fixtureNativeRowsDigest(snapshot.processes) !== snapshot.causalReceipt.rowsSha256) throw new Error('CLEANUP_CAUSAL_UNOWNED_RECEIPT')
  rawScopes.delete(scope); authenticSnapshots.delete(snapshot)
  const causal = { ...structuredClone(snapshot.causalReceipt), rawBegin: scope.rawBegin, rawEnd, rawSha256: fixtureRawProbesDigest(probes) }
  const order = { kind: 'captured-controller-causal-order-v2', nativeCompletedAtMs: snapshot.completedAtMs, startedAtMs, completedAtMs, finalSnapshotRef: finalRef(causal), causal }
  causalBudget(order); return order
}

const imageKey = value => path.win32.normalize(String(value || '')).toLowerCase()

// 只在原断言失败时调用；不新增进程查询，不用另时刻native样本自动归因或替代raw门禁。
export function formatFixtureBoundsFailure(report) {
  const number = value => Number.isFinite(value) ? value : null
  const hex = value => /^[0-9a-f]{16}$/i.test(value || '') ? value : null
  const native = row => row ? {
    sampledAtMs: number(row.sampledAtMs), status: ['running', 'exited', 'missing', 'error'].includes(row.status) ? row.status : 'unknown',
    creationTimeFileTimeHex: hex(row.creationTimeFileTimeHex), createdAtMs: number(row.createdAtMs), exitAtMs: number(row.exitAtMs),
    belongsToFixture: typeof row.belongsToFixture === 'boolean' ? row.belongsToFixture : null,
    waitResult: number(row.waitResult), nativeError: number(row.nativeError), imageQueryError: number(row.imageQueryError),
  } : null
  const event = row => row ? {
    event: ['start', 'exit', 'write', 'failure'].includes(row.event) ? row.event : 'unknown', pid: number(row.pid),
    name: /^(?:burst-\d{1,3}|fail|recovery)$/.test(row.name || '') ? row.name : '[other]', at: number(row.at), monotonicMs: number(row.monotonicMs),
  } : null
  const rows = (report.observations || []).flatMap(observation => observation.processes || [])
  const peaks = report.rawPeakSamples || []
  const selected = peaks.filter(sample => sample.count === report.peak).slice(0, 3)
  const samples = selected.map(sample => ({
    count: number(sample.count), startedAtMs: number(sample.startedAtMs), completedAtMs: number(sample.completedAtMs), probeCount: number(sample.probeCount),
    pids: (sample.probes || []).slice(0, 8).map(probe => {
      const candidates = rows.filter(row => row.pid === probe.pid && Number.isFinite(row.sampledAtMs)).sort((a, b) => a.sampledAtMs - b.sampledAtMs)
      const events = (report.events || sample.starts || []).filter(row => row.pid === probe.pid)
      return {
        pid: number(probe.pid), alive: probe.alive === true, startedAtMs: number(probe.startedAtMs), completedAtMs: number(probe.completedAtMs),
        startedAtNs: /^\d{1,24}$/.test(probe.startedAtNs || '') ? probe.startedAtNs : null,
        completedAtNs: /^\d{1,24}$/.test(probe.completedAtNs || '') ? probe.completedAtNs : null,
        start: event(events.find(row => row.event === 'start')), lastEvent: event(events.at(-1)),
        nativeFirst: native(candidates[0]), nativeBefore: native(candidates.filter(row => row.sampledAtMs <= probe.startedAtMs).at(-1)),
        nativeAfter: native(candidates.find(row => row.sampledAtMs >= probe.completedAtMs)),
      }
    }),
  }))
  const result = { cause: 'unresolved', samplingNotSimultaneous: true, rawPeak: number(report.peak), nativePeak: number(report.nativePeak),
    rawSamplesCaptured: peaks.length, samples, observerErrorCount: report.observerErrors?.length || 0,
    requestCount: report.requests?.length || 0, failureRecoveryPhase: report.failed ? 'failure-requested' : 'not-reached' }
  // 只输出白名单数字/枚举/fixture名，绝不输出env、argv、文件路径或原错误正文。
  while (Buffer.byteLength(JSON.stringify(result)) > 24576 && result.samples.length) result.samples.pop()
  return JSON.stringify(result)
}

export function classifyFixtureIdentitySample({ starts, processes, expectedExecutable }) {
  const receipts = new Map(starts.filter(row => row.event === 'start').map(row => [row.pid, row]))
  const identities = new Map(processes.map(row => [row.pid, row]))
  const classified = []
  for (const [pid, receipt] of receipts) {
    const row = identities.get(pid)
    if (!row) throw new Error(`identity missing for fixture PID ${pid}`)
    if (!['running', 'exited', 'missing'].includes(row.status)) throw new Error(`identity unavailable for fixture PID ${pid}: ${JSON.stringify(row)}`)
    const provedExitWithoutImage = row.status === 'exited' && row.waitResult === 0 && row.exitAtMs > 0 && row.creationTimeFileTimeHex
    if (row.status !== 'missing' && (!row.creationTimeFileTimeHex || (!row.executablePath && !provedExitWithoutImage))) throw new Error(`identity unavailable for fixture PID ${pid}: missing image or creation time`)
    const belongsToFixture = row.status !== 'missing' && Boolean(row.executablePath) && imageKey(row.executablePath) === imageKey(expectedExecutable)
    classified.push({ ...row, receipt, belongsToFixture, newerThanRecordedStart: row.createdAtMs > receipt.at, active: belongsToFixture && row.status === 'running' })
  }
  return { activeCount: classified.filter(row => row.active).length, processes: classified }
}

// 每轮查询仅短暂持有句柄；不跨采样保留句柄，避免人为阻止 PID 复用。
const nativeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# 固定数字/枚举诊断，不读环境或新增进程查询；ready仍是原协议唯一就绪信号。
function Fixture-Phase([string]$phase) {
  $at=([DateTime]::UtcNow.Ticks - 621355968000000000L) / 10000L -as [long]
  [Console]::Out.WriteLine(('{"event":"observer-phase","protocol":1,"phase":"'+$phase+'","pid":'+$PID+',"atMs":'+$at+'}'))
}
Fixture-Phase 'script-entry'
Fixture-Phase 'bindings-begin'
# 只为这5个只读Win32签名创建内存绑定；不用Add-Type/csc，不启动编译器孩子。
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('FixtureProcessNative')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('native')
$type = $module.DefineType('FixtureNative', 'Public, Abstract, Sealed')
$lastError = $type.DefineField('LastError', [int], 'Public, Static')
function Add-FixtureNativeMethod($name, $returnType, [Type[]]$parameters) {
  $method = $type.DefineMethod(('Native_' + $name), 'Private, Static, PinvokeImpl', $returnType, $parameters)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'), [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'))
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@('kernel32.dll'), $fields, [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode, $name))
  $method.SetCustomAttribute($attribute)
  # 必须在同一托管方法内立即保存GetLastWin32Error；回到PS动态binder后错误码可已被覆盖。
  $wrapper = $type.DefineMethod($name, 'Public, Static', $returnType, $parameters)
  $il = $wrapper.GetILGenerator()
  $result = $il.DeclareLocal($returnType)
  for($i=0; $i -lt $parameters.Length; $i++){$il.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]$i)}
  $il.Emit([Reflection.Emit.OpCodes]::Call, $method)
  $il.Emit([Reflection.Emit.OpCodes]::Stloc, $result)
  $il.Emit([Reflection.Emit.OpCodes]::Call, [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'))
  $il.Emit([Reflection.Emit.OpCodes]::Stsfld, $lastError)
  $il.Emit([Reflection.Emit.OpCodes]::Ldloc, $result)
  $il.Emit([Reflection.Emit.OpCodes]::Ret)
}
Add-FixtureNativeMethod 'OpenProcess' ([IntPtr]) @([uint32], [bool], [int])
Add-FixtureNativeMethod 'GetProcessTimes' ([bool]) @([IntPtr], [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType())
Add-FixtureNativeMethod 'QueryFullProcessImageNameW' ([bool]) @([IntPtr], [uint32], [Text.StringBuilder], [uint32].MakeByRefType())
Add-FixtureNativeMethod 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
Add-FixtureNativeMethod 'CloseHandle' ([bool]) @([IntPtr])
$native = $type.CreateType()
Fixture-Phase 'bindings-ready'
function Fixture-Now { return ([DateTime]::UtcNow.Ticks - 621355968000000000L) / 10000L -as [long] }
function Fixture-Unix([long]$fileTime) { if($fileTime -eq 0){return 0L}; return ([DateTime]::FromFileTimeUtc($fileTime).Ticks - 621355968000000000L) / 10000L -as [long] }
function Read-FixtureIdentity([int]$processId) {
  $row = [ordered]@{pid=$processId;status='error';executablePath=$null;creationTimeFileTimeHex=$null;createdAtMs=0L;exitAtMs=0L;sampledAtMs=0L;queryStartedAtMs=(Fixture-Now);queryCompletedAtMs=0L;nativeError=0;imageQueryError=0;waitResult=[uint32]::MaxValue}
  $handle = $native::OpenProcess(0x00101000, $false, $processId)
  if($handle -eq [IntPtr]::Zero) {
    $row.nativeError=$native::LastError
    if($row.nativeError -eq 87){$row.status='missing'}
    $row.sampledAtMs=Fixture-Now; $row.queryCompletedAtMs=$row.sampledAtMs
    return $row
  }
  try {
    [long]$creation=0; [long]$exit=0; [long]$kernel=0; [long]$user=0
    if(-not $native::GetProcessTimes($handle,[ref]$creation,[ref]$exit,[ref]$kernel,[ref]$user)) {
      $row.nativeError=$native::LastError; return $row
    }
    $row.creationTimeFileTimeHex=$creation.ToString('x16'); $row.createdAtMs=Fixture-Unix $creation
    $image = New-Object System.Text.StringBuilder(32768)
    [uint32]$length = $image.Capacity
    $imageOk = $native::QueryFullProcessImageNameW($handle,0,$image,[ref]$length)
    if($imageOk){$row.executablePath=$image.ToString()}else{$row.imageQueryError=$native::LastError}
    # 镜像查询可能正好遇到退出；在同一句柄上后取wait和times，不用旧running状态猜退出。
    # 镜像失败只等待一次最多10ms，让终止中的内核对象完成；仍非signaled则保持红灯。
    $row.waitResult=$native::WaitForSingleObject($handle, $(if($imageOk){0}else{10}))
    if($row.waitResult -ne 0 -and $row.waitResult -ne 258){$row.nativeError=$native::LastError; return $row}
    [long]$finalCreation=0
    if(-not $native::GetProcessTimes($handle,[ref]$finalCreation,[ref]$exit,[ref]$kernel,[ref]$user)) {
      $row.nativeError=$native::LastError; return $row
    }
    if($finalCreation -ne $creation){$row.nativeError=13; return $row}
    if($row.waitResult -eq 0 -and $exit -gt 0){$row.status='exited'; $row.exitAtMs=Fixture-Unix $exit}
    elseif($row.waitResult -eq 258 -and $imageOk){$row.status='running'}
    else{$row.nativeError=$row.imageQueryError}
    return $row
  } finally { $row.sampledAtMs=Fixture-Now; $row.queryCompletedAtMs=$row.sampledAtMs; $null=$native::CloseHandle($handle) }
}
# 在ready前预热只读本观察器自身：JIT/JSON不挤占首个实际样本的2秒预算。
Fixture-Phase 'warmup-begin'
$warm = Read-FixtureIdentity $PID
if($warm.status -ne 'running'){throw 'native identity observer warmup failed'}
Fixture-Phase 'warmup-end'
$null = ConvertFrom-Json '{"id":0,"pids":[]}'
$null = @{id=0;processes=@($warm)} | ConvertTo-Json -Depth 6 -Compress
Fixture-Phase 'json-warmup-end'
[Console]::Out.WriteLine('{"event":"ready","protocol":1}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json $line
  $rows = @(); foreach($processId in $request.pids){$rows += Read-FixtureIdentity ([int]$processId)}
  $reply = @{id=$request.id; processes=@($rows)} | ConvertTo-Json -Depth 6 -Compress
  if($null -ne $request.causal) {
    # 仅回显本管道的请求绑定；所有原始查询行/UTC不改写，无新系统查询。
    $c=$request.causal
    if($c.schemaVersion -ne 2 -or $c.requestId -ne $request.id){throw 'causal request mismatch'}
    $reply=@{id=$request.id;processes=@($rows);causal=@{schemaVersion=2;controllerPid=$c.controllerPid;clockDomainId=$c.clockDomainId;transportSessionId=$c.transportSessionId;observerPid=$PID;requestId=$request.id;orderedPids=@($request.pids)}} | ConvertTo-Json -Depth 6 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($reply) -gt 24576){throw 'CLEANUP_CAUSAL_BUDGET'}
  }
  [Console]::Out.WriteLine($reply)
}
`

export async function startWindowsFixtureProcessObserver({ spawnProcess = spawn, onDiagnostic } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows native fixture observer requires Windows')
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const launch = { requestedAtMs: Date.now(), requestedMonotonicMs: performance.now() }
  const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-Command', nativeScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  Object.assign(launch, { returnedAtMs: Date.now(), returnedMonotonicMs: performance.now() })
  return startFixtureObserverTransport(child, { onDiagnostic, launch })
}

const startupPhases = ['script-entry', 'bindings-begin', 'bindings-ready', 'warmup-begin', 'warmup-end', 'json-warmup-end']

// 只观察现有ChildProcess/流事件。没有额外PID查询、重试、CPU/AV推断或原文日志输出。
function observerDiagnostic(child, launch) {
  const origin = launch?.requestedMonotonicMs ?? performance.now(), events = [], streams = {}
  let eventCount = 0, eventOverflow = false
  const record = (event, fields = {}, atMs = Date.now(), mono = performance.now()) => {
    eventCount++
    if (events.length < 32) events.push({ event, atMs, elapsedMs: Math.round((mono - origin) * 1000) / 1000, ...fields })
    else eventOverflow = true
  }
  if (launch) {
    record('spawn-request', {}, launch.requestedAtMs, launch.requestedMonotonicMs)
    record('spawn-return', {}, launch.returnedAtMs, launch.returnedMonotonicMs)
  }
  record('transport-start')
  for (const name of ['stdout', 'stderr']) {
    const state = { bytes: 0, chunks: 0, firstAtMs: null, lastAtMs: null, hash: createHash('sha256') }; streams[name] = state
    child[name].on('data', bytes => {
      const at = Date.now(); state.bytes += bytes.length; state.chunks++
      if (state.firstAtMs === null) { state.firstAtMs = at; record(name + '-first', {}, at) }
      state.lastAtMs = at; state.hash.update(bytes)
    })
    child[name].once('end', () => record(name + '-end'))
  }
  return { record, render(state) {
    const safeStreams = Object.fromEntries(Object.entries(streams).map(([name, s]) => [name, { bytes: s.bytes, chunks: s.chunks, firstAtMs: s.firstAtMs, lastAtMs: s.lastAtMs, sha256: s.hash.copy().digest('hex') }]))
    const result = { event: 'hermes-observer-diagnostic', schema: 1, pid: Number.isSafeInteger(child.pid) ? child.pid : null, startupBudgetMs: 7000, requestBudgetMs: 2000,
      launch: { requestedAtMs: launch?.requestedAtMs ?? null, returnedAtMs: launch?.returnedAtMs ?? null }, events: [...events], eventCount, eventOverflow, streams: safeStreams, ...state }
    // 报告只含固定枚举/数字/摘要。任何未来超限显式报材料不完整，绝不改变原失败或假称完整。
    if (Buffer.byteLength(JSON.stringify(result)) > 8192) { result.events = []; result.eventOverflow = true; result.evidenceBudgetExceeded = true }
    return result
  } }
}

// 只服务合成测试子进程；所有失败终止本观察器，保留首红，不重放查询。
export async function startFixtureObserverTransport(child, { onDiagnostic, launch } = {}) {
  const transportSessionId = randomUUID().replaceAll('-', '')
  let causalModeUsed = false
  const diagnostic = observerDiagnostic(child, launch)
  const lines = createInterface({ input: child.stdout })
  let nextId = 0, stderr = '', readyResolve, readyReject, closed = false, failure = null
  let reason = null, readyAtMs = null, closeInfo = null, deliveryFailed = false, emitted = false, normalClose = false, lastPhaseIndex = -1
  const getDiagnostic = () => diagnostic.render({ reason, readyAtMs, close: closeInfo, terminal: closed, deliveryFailed })
  const attach = () => { if (failure && typeof failure === 'object') failure.observerDiagnostic = getDiagnostic() }
  const publish = () => {
    if (emitted) return
    emitted = true; attach()
    const failedWrite = () => { deliveryFailed = true; attach() }
    try {
      if (onDiagnostic) { const pendingWrite = onDiagnostic(getDiagnostic()); if (pendingWrite?.then) Promise.resolve(pendingWrite).catch(failedWrite) }
      else if (reason !== 'normal-close') console.log(JSON.stringify(getDiagnostic()))
    } catch { failedWrite() }
    attach()
  }
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const onFailure = (error, cause = 'protocol') => {
    if (failure) return
    failure = error; reason = cause
    if (cause !== 'normal-close') diagnostic.record('failure', { cause })
    readyReject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
    if (!closed) child.kill()
  }
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000) })
  child.once('spawn', () => diagnostic.record('spawn'))
  child.once('exit', (code, signal) => diagnostic.record('exit', { code: Number.isInteger(code) ? code : null, signal: signal === null ? null : /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : 'other' }))
  child.once('error', error => { diagnostic.record('child-error'); onFailure(error, 'child-error') })
  child.stdin.on('error', error => onFailure(error, 'stdin-error'))
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; closeInfo = { code: Number.isInteger(code) ? code : null, signal: signal === null ? null : /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : 'other', killed: child.killed, atMs: Date.now() }
    diagnostic.record('close'); onFailure(new Error(`fixture identity observer closed ${code}/${signal}: ${stderr}`), normalClose ? 'normal-close' : 'child-close'); publish(); resolve()
  }))
  lines.on('line', line => {
    if (failure) return
    try {
      if ([...pending.values()].some(item => item.causal) && Buffer.byteLength(line) > FIXTURE_IDENTITY_LIMITS.outputBytes) throw new Error('CLEANUP_CAUSAL_BUDGET')
      const message = JSON.parse(line)
      if (message.event === 'observer-phase') {
        const index = startupPhases.indexOf(message.phase)
        if (message.protocol !== 1 || message.pid !== child.pid || !Number.isSafeInteger(message.atMs) || message.atMs < 0 || index !== lastPhaseIndex + 1 || readyAtMs !== null) throw new Error('identity observer phase protocol mismatch')
        lastPhaseIndex = index; diagnostic.record('phase', { phase: message.phase, nativeAtMs: message.atMs }); return
      }
      if (message.event === 'ready') { if (message.protocol !== 1) throw new Error('identity observer protocol mismatch'); readyAtMs = Date.now(); diagnostic.record('ready', {}, readyAtMs); readyResolve(); return }
      const item = pending.get(message.id)
      if (!item) throw new Error('unexpected identity observer response ' + message.id)
      if (item.causal) {
        if (Buffer.byteLength(line) > FIXTURE_IDENTITY_LIMITS.outputBytes) throw new Error('CLEANUP_CAUSAL_BUDGET')
        const c = message.causal, expected = item.causal
        if (Object.keys(message).sort().join(',') !== 'causal,id,processes' || !c || Object.keys(c).sort().join(',') !== 'clockDomainId,controllerPid,observerPid,orderedPids,requestId,schemaVersion,transportSessionId' ||
            c.schemaVersion !== 2 || c.controllerPid !== process.pid || c.clockDomainId !== clockDomainId || c.transportSessionId !== transportSessionId || c.observerPid !== child.pid || c.requestId !== message.id ||
            !Array.isArray(c.orderedPids) || JSON.stringify(c.orderedPids) !== JSON.stringify(expected.orderedPids) || !Array.isArray(message.processes) || message.processes.length !== c.orderedPids.length || !message.processes.every((r, i) => r.pid === c.orderedPids[i])) throw new Error('CLEANUP_CAUSAL_RESPONSE_BINDING')
        item.receipt = { schemaVersion: 2, phase: 'cleanup-final', clock: 'controller-process-hrtime-bigint-ns', controllerPid: process.pid, clockDomainId, transportSessionId, observerPid: child.pid, requestId: message.id, orderedPids: [...c.orderedPids], rowsSha256: fixtureNativeRowsDigest(message.processes), send: item.send, receive: markController() }
      }
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message)
    } catch (error) { onFailure(error) }
  })
  diagnostic.record('startup-timer')
  const startupTimer = setTimeout(() => onFailure(new Error('fixture identity observer startup timeout: ' + stderr), 'startup-timeout'), 7000)
  try { await ready } catch (error) { if (!closed) child.kill(); await exited; throw error } finally { clearTimeout(startupTimer) }
  return {
    pid: child.pid,
    getDiagnostic,
    // 切换既有最终查询的协议，不新增一次查询；原snapshot(pids)调用点保持两处。
    forCleanup() {
      const transport = this
      return { ...transport, snapshot: pids => transport.snapshot(pids, { causal: true }) }
    },
    async snapshot(pids, { causal = false } = {}) {
      if (failure) throw failure
      if (closed) throw new Error('fixture identity observer closed')
      if (!pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('invalid fixture PID')
      if (typeof causal !== 'boolean' || (causal && (!pids.length || pids.length > FIXTURE_IDENTITY_LIMITS.starts || new Set(pids).size !== pids.length))) throw new Error('CLEANUP_CAUSAL_REQUEST')
      if (causal) causalModeUsed = true
      const id = ++nextId, startedAtMs = Date.now(), monotonicStart = performance.now()
      let item
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => onFailure(new Error('fixture identity observation timeout'), 'request-timeout'), 2000)
        item = { resolve, reject, timer }
        const request = { id, pids }
        if (causal) {
          request.causal = { schemaVersion: 2, controllerPid: process.pid, clockDomainId, transportSessionId, requestId: id }
          item.causal = { orderedPids: [...pids] }; item.send = markController()
        }
        pending.set(id, item)
        try { if (causal) causalBudget(request); child.stdin.write(JSON.stringify(request) + '\n', error => { if (error) onFailure(error) }) } catch (error) { onFailure(error) }
      })
      if (failure) throw failure
      if (!Array.isArray(reply.processes)) { const error = new Error('identity processes response missing'); onFailure(error); throw error }
      const snapshot = { startedAtMs, completedAtMs: Date.now(), durationMs: performance.now() - monotonicStart, processes: reply.processes }
      if (causal) {
        snapshot.causalReceipt = { ...item.receipt, returned: markController() }
        causalBudget(snapshot); authenticSnapshots.set(snapshot, JSON.stringify(snapshot))
      }
      return snapshot
    },
    async close() {
      const verify = () => { if (causalModeUsed && failure && reason !== 'normal-close') throw failure }
      if (closed) { verify(); return }
      normalClose = true; diagnostic.record('close-request')
      child.stdin.end()
      const timer = setTimeout(() => { if (!closed) child.kill() }, 2000)
      try { await exited } finally { clearTimeout(timer); lines.close() }
      verify()
    },
  }
}
