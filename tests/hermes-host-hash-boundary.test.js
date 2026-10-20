import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostSnapshot, windowsPathFingerprintSource } from '../scripts/test-hermes-windows-qualification.mjs'

// 先有 FAILURE-FIRST：只 carve 原 source。ps 替身只取文本，绝不扫描真实 host。
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'scripts/test-hermes-windows-qualification.mjs'))
const fixtureSource = fs.readFileSync(new URL('./fixtures/hermes-host-hash-boundary.cs', import.meta.url), 'utf8')
let generated
new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(code => { generated = code; return {} }, windowsPathFingerprintSource, Buffer, () => '', { env: {} })({ actualProfile: 'C:\\Users\\' + '汉'.repeat(87) })
const baseHelper = windowsPathFingerprintSource()
const block = generated.split("Write-ClawPanelHostPhase 'launchers'\n")[1]?.split("\nWrite-ClawPanelHostPhase 'execution-policy'")[0]
assert.ok(block)
const hashLine = '$sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash'
const out = path.resolve(process.env.HERMES_HOST_BOUNDARY_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-boundary-evidence-')))
const checkpoint = process.env.HERMES_HOST_BOUNDARY_CHECKPOINT
const protectedRoots = checkpoint ? JSON.parse(fs.readFileSync(checkpoint, 'utf8').replace(/^\uFEFF/, '')).protectedRoots : []
const norm = p => path.resolve(p).toLowerCase()
const inside = (a, b) => { const r = path.relative(norm(a), norm(b)); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
function unprotected(p) {
  for (const q of protectedRoots) assert.ok(!inside(p, q) && !inside(q, p), 'fixture intersects protectedRoots')
}
unprotected(out); fs.mkdirSync(out, { recursive: true })
const reports = []
const write = (name, value) => fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2))

function instrument() {
  let helper = baseHelper, actual = block
  const edits = []
  const change = (which, from, to) => {
    const text = which === 'helper' ? helper : actual
    assert.equal(text.split(from).length, 2, '唯一真实 source 插入点: ' + from)
    if (which === 'helper') helper = text.replace(from, to); else actual = text.replace(from, to)
    edits.push({ which, from, to })
  }
  // barrier 位于 fixture 边界；literal cmdlet 本身及参数原字节保留，每次读取不重放。
  change('helper', hashLine, `try{[ClawBoundaryControl]::Enter($p);[ClawBoundaryControl]::Literal($p);${hashLine};[ClawBoundaryControl]::Returned($p);if([ClawBoundaryControl]::Mode -eq 'error' -and [ClawBoundaryControl]::Index($p) -eq 0){Write-Error 'owned nonterminating hash stream' -ErrorAction Continue}}catch{[ClawBoundaryControl]::Failed($p);throw}finally{[ClawBoundaryControl]::Leave($p)}`)
  change('helper', "Write-ClawPanelFingerprintStage $trace $k 'end' $z}", "Write-ClawPanelFingerprintStage $trace $k 'end' $z;[ClawBoundaryControl]::Marker($p)}")
  change('helper', '$h=@($j.p.EndInvoke($j.a))', '$h=@($j.p.EndInvoke($j.a));[ClawBoundaryControl]::Reaped($j.r.path)')
  change('helper', '$j.p.Dispose();$s.j=', '$j.p.Dispose();[ClawBoundaryControl]::Disposed($j.r.path);$s.j=')
  change('helper', 'd=$t.dir};$p=$null', 'd=$t.dir};[ClawBoundaryControl]::Created($f.FullName,$s.j.Count);$p=$null')
  change('block', '$j.p.Stop();$j.a.AsyncWaitHandle.Close();$j.p.Dispose()', '$j.p.Stop();$j.a.AsyncWaitHandle.Close();$j.p.Dispose();[ClawBoundaryControl]::Disposed($j.r.path)')
  let restoredHelper = helper, restoredBlock = actual
  for (const e of [...edits].reverse()) {
    if (e.which === 'helper') restoredHelper = restoredHelper.replace(e.to, e.from); else restoredBlock = restoredBlock.replace(e.to, e.from)
  }
  assert.equal(restoredHelper, baseHelper); assert.equal(restoredBlock, block)
  const csharp = text => text.split("if(-not ('ClawPanelReparseReader' -as [type])){Add-Type -TypeDefinition @'\n")[1].split("\n'@}")[0]
  assert.equal(csharp(helper), csharp(baseHelper), '原 C# reader 逐字节不变')
  return { helper, actual, proof: { productionSha256: sha(source), helperSha256: sha(baseHelper), launcherBlockSha256: sha(block), originalCSharpSha256: sha(csharp(baseHelper)), sourceReverseExact: true, originalHashLineRetained: helper.includes(hashLine), edits: edits.map(e => ({ target: e.which, original: e.from })) } }
}

function fileFacts(file) {
  const s = fs.statSync(file, { bigint: true })
  return { size: String(s.size), ino: String(s.ino), dev: String(s.dev), createdNs: String(s.birthtimeNs), modifiedNs: String(s.mtimeNs) }
}

function run(mode) {
  const parent = fs.realpathSync.native(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(parent, 'cp-host-boundary-'))
  unprotected(dir)
  assert.equal(path.dirname(fs.realpathSync.native(dir)), parent)
  const dirs = [path.join(dir, 'files-000'), path.join(dir, 'files-001')], home = path.join(dir, 'home')
  for (const d of [...dirs, home]) fs.mkdirSync(d)
  const expected = ['a', 'b', 'c', 'd'].map((v, i) => {
    const file = path.join(dirs[i < 2 ? 0 : 1], `node-${v}.exe`), bytes = Buffer.alloc([196611, 131073, 65537, 33][i], i + 17)
    fs.writeFileSync(file, bytes)
    return { path: file, bytes: bytes.length, sha256: sha(bytes).toUpperCase(), facts: fileFacts(file) }
  })
  const transformed = instrument()
  const input = Buffer.from(JSON.stringify({ home, dirs, files: expected.map(f => f.path), mode })).toString('base64')
  const utf8 = generated.match(/^function Get-ClawPanelUtf8Sha256.*$/m)[0]
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
${fixtureSource}
'@
${utf8}
${transformed.helper}
$v=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')))
$real=$v.home;$env:PATH=$v.dirs -join ';';$hostClock=[Diagnostics.Stopwatch]::StartNew();[ClawBoundaryControl]::Clock=$hostClock;[ClawBoundaryControl]::Paths=[string[]]$v.files;[ClawBoundaryControl]::Mode=$v.mode
function OwnedFacts { @($v.files|ForEach-Object {$i=Get-Item -LiteralPath $_ -Force -ErrorAction Stop;@{path=$i.FullName;bytes=$i.Length;attributes=[int64]$i.Attributes;created=[string]$i.CreationTimeUtc.Ticks;modified=[string]$i.LastWriteTimeUtc.Ticks}}) }
$before=@(OwnedFacts);$locked=$null
if($v.mode -eq 'locked'){$locked=[IO.File]::Open($v.files[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)}
try{
${transformed.actual}
$result=@{failed=$false;launchers=@($launchers)}
}catch{$result=@{failed=$true;errorId=$_.FullyQualifiedErrorId;error=$_.Exception.Message}}
finally{if($locked){$locked.Dispose()}}
$self=[Diagnostics.Process]::GetCurrentProcess();$result.mode=$v.mode;$result.events=@([ClawBoundaryControl]::Events());$result.beforeRelease=[ClawBoundaryControl]::BeforeRelease;$result.calls=@([ClawBoundaryControl]::Calls);$result.peak=[ClawBoundaryControl]::Peak;$result.active=[ClawBoundaryControl]::Active;$result.maxJobs=[ClawBoundaryControl]::MaxJobs;$result.poolState=$hw.p.RunspacePoolStateInfo.State.ToString();$result.before=$before;$result.after=@(OwnedFacts);$result.ownedProcess=@{pid=$self.Id;createdUtc=$self.StartTime.ToUniversalTime().ToString('o')};$result|ConvertTo-Json -Depth 12 -Compress
`
  const file = path.join(dir, 'fixture.ps1'); fs.writeFileSync(file, script)
  const loader = `& ([scriptblock]::Create([IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}')))))`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
  const startedAt = new Date().toISOString()
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  let receipt
  try { receipt = JSON.parse((r.stdout || '').replace(/^\uFEFF/, '')) } catch { /* 原失败保留，不产生伪 canary。 */ }
  const report = { scope: 'own-file source-carve boundary component only; not R31 attribution or qualification', mode, startedAt, endedAt: new Date().toISOString(), node: process.version, command: { program: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', '<owned fixture loader>'], timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 }, child: { pid: r.pid, status: r.status, signal: r.signal, errorCode: r.error?.code ?? null }, stdout: r.stdout, stderr: r.stderr, receipt, expected, instrumentation: transformed.proof, cleanup: { ownedRoot: dir, deleted: false }, entryMeaning: 'api-enter is test wrapper boundary; before mode barrier precedes exact literal cmdlet, never claimed kernel entry' }
  fs.writeFileSync(path.join(out, mode + '-fixture.ps1'), script)
  write(mode, report); reports.push(report)
  try {
    assert.equal(r.status, 0, JSON.stringify(report)); assert.ok(receipt, JSON.stringify(report))
    assert.equal(receipt.ownedProcess.pid, r.pid); assert.ok(Number.isFinite(Date.parse(receipt.ownedProcess.createdUtc)))
    assert.equal(receipt.poolState, 'Closed'); assert.equal(receipt.active, 0)
    assert.ok(receipt.maxJobs <= 2); assert.ok(receipt.peak <= 2)
    for (const f of receipt.before) { assert.equal(typeof f.created, 'string'); assert.match(f.created, /^\d+$/); assert.equal(typeof f.modified, 'string'); assert.match(f.modified, /^\d+$/) }
    assert.deepEqual(receipt.after, receipt.before)
    expected.forEach(f => assert.deepEqual(fileFacts(f.path), f.facts))
    const created = receipt.events.filter(e => e.stage === 'job-created').map(e => e.file).sort()
    const disposed = receipt.events.filter(e => e.stage === 'job-disposed').map(e => e.file).sort()
    assert.deepEqual(disposed, created, '所有实际创建 pipeline 都已 dispose')
    return report
  } finally {
    // 仅凭本次 close/poolClosed/active0 证据删 own 根；unknown 时保留，不回查旧 PID。
    if (r.status === 0 && receipt?.poolState === 'Closed' && receipt.active === 0) {
      const real = fs.realpathSync.native(dir); unprotected(real)
      assert.equal(path.dirname(real), parent); assert.ok(path.basename(real).startsWith('cp-host-boundary-'))
      fs.rmSync(real, { recursive: true, force: true }); report.cleanup.deleted = !fs.existsSync(real)
    }
    write(mode, report)
  }
}

function complete(report) {
  const j = report.receipt
  assert.equal(j.failed, false, JSON.stringify(report)); assert.equal(j.peak, 2); assert.equal(j.maxJobs, 2)
  assert.deepEqual(j.calls, [1, 1, 1, 1], '每个自有文件原 literal Get-FileHash 恰好一次')
  assert.deepEqual(j.launchers, report.expected.map((f, i) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, fingerprint: { kind: 'file', bytes: f.bytes, attributes: j.before[i].attributes, sha256: f.sha256 } })))
  for (let i = 0; i < 4; i++) {
    const stages = ['api-enter', 'literal-call', 'api-return', 'end-marker-return', 'endinvoke-return', 'job-disposed']
    const indices = stages.map(s => j.events.findIndex(e => e.stage === s && e.file === i))
    assert.ok(indices.every(n => n >= 0)); assert.deepEqual([...indices].sort((a, b) => a - b), indices)
  }
  const ends = [...report.stderr.matchAll(/CLAWPANEL_LAUNCHER_FILE (\{[^\r\n]*\})/g)].map(m => JSON.parse(m[1])).filter(e => e.stage === 'filehash' && e.event === 'end')
  assert.equal(ends.length, 4, 'handler返回与真实原stderr end记录同时核验')
  assert.ok(report.cleanup.deleted)
}

test('R32 source carve保留原hash/C#/stamp/worker2/bounds；fixture不含host扫描', () => {
  const p = instrument().proof
  assert.equal(p.sourceReverseExact, true)
  assert.match(baseHelper, /CreateRunspacePool\(1,2\)/); assert.match(baseHelper, /WaitHandle\]::WaitAny/)
  assert.match(baseHelper, /\$j.p.HadErrors/); assert.match(baseHelper, /\$b.records -ge 512/)
  assert.match(block, /\$index -le 64/); assert.doesNotMatch(block, /registry|HKCU|HKLM|Get-CimInstance|Win32_Process|Get-ExecutionPolicy/)
  assert.match(source.toString(), /timeout: 30000, maxBuffer: 16 \* 1024 \* 1024/)
  const code = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + generated
  const n = ('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand ' + Buffer.from(code, 'utf16le').toString('base64')).length + 1
  assert.ok(n < 32767); write('source-contract', { ...p, utf16IncludingNul: n, available: 32767 - n, protectedRootCount: protectedRoots.length, checkpointSha256: checkpoint ? sha(fs.readFileSync(checkpoint)) : null, realHostScanned: false, productionChanged: false })
})

for (const mode of ['baseline', 'before', 'after']) test(`R32 ${mode}:原source四界点/真实literal/原序hash/两路与退出`, { skip: process.platform !== 'win32', timeout: 40000 }, () => {
  const report = run(mode); complete(report)
  const j = report.receipt
  if (mode !== 'baseline') {
    const b = j.beforeRelease
    assert.equal(b.entered, true); assert.equal(b.returned, mode === 'after'); assert.equal(b.literalCalls, mode === 'after' ? 1 : 0)
    assert.equal(b.marker, false); assert.equal(b.reaped, false)
    for (const i of [1, 2, 3]) assert.ok(j.events.find(e => e.file === i && e.stage === 'endinvoke-return').seq <= b.seq)
    assert.ok(j.events.find(e => e.file === 0 && e.stage === 'endinvoke-return').seq > b.seq)
  }
})

for (const mode of ['locked', 'error']) test(`R32 ${mode}:原错误/错误流整次失败，无partial canary`, { skip: process.platform !== 'win32', timeout: 40000 }, () => {
  const r = run(mode), j = r.receipt
  assert.equal(j.failed, true, JSON.stringify(r)); assert.equal(j.launchers, undefined)
  assert.ok(j.calls.every(c => c <= 1)); assert.ok(j.calls[0] === 1)
  if (mode === 'locked') assert.equal(j.errorId, 'FileReadError,Get-FileHash')
  else { assert.match(j.error, /Invalid hash/); assert.ok(j.events.some(e => e.file === 0 && e.stage === 'api-return')) }
  assert.ok(r.cleanup.deleted)
})

test.after(() => write('summary', { schemaVersion: 1, scope: 'controlled own-file component only', productionChanged: false, globalHostScan: false, noR31RootCauseClaim: true, reports: reports.map(r => ({ mode: r.mode, actualChild: r.child, componentFailed: r.receipt?.failed ?? null, poolState: r.receipt?.poolState ?? null, calls: r.receipt?.calls ?? null, peak: r.receipt?.peak ?? null, maxJobs: r.receipt?.maxJobs ?? null, beforeRelease: r.receipt?.beforeRelease ?? null, cleanup: r.cleanup })) }))
