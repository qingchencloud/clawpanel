import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { hostSnapshot, windowsPathFingerprintSource, assertHostUnchanged } from '../scripts/test-hermes-windows-qualification.mjs'

// 失败清单：混合API误归因、超时丢begin、读失败吞错、日志泄漏/改变canary、日志限额截断扫描、reparse误hash目标。
// 只提取实际生成的只读片段，在自有fixture运行；不执行真实hostSnapshot/registry/全局PATH。
let generated
new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(code => { generated = code; return {} }, windowsPathFingerprintSource, Buffer, () => 'unused', { env: {} })({ actualProfile: 'fixture-not-host-home' })
const block = generated.split("Write-ClawPanelHostPhase 'launchers'\n")[1]?.split("\nWrite-ClawPanelHostPhase 'execution-policy'")[0]
const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
const windows = { skip: process.platform !== 'win32' }
const hash = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase()

function fixture() {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'hermes-hash-timing-'))
  const real = path.join(dir, 'private'), one = path.join(dir, 'one [literal] 资格'), file = path.join(one, 'node.exe'), data = Buffer.alloc(65536, 'ClawPanel fingerprint timing fixture UTF8 资格')
  fs.mkdirSync(real); fs.mkdirSync(one); fs.writeFileSync(file, data)
  const links = []
  return { dir, real, one, file, data, links, dispose() {
    for (const link of links) fs.unlinkSync(link)
    assert.equal(path.dirname(fs.realpathSync(dir)), parent)
    fs.rmSync(dir, { recursive: true, force: true })
  } }
}

function command(f, code) {
  const input = Buffer.from(JSON.stringify({ real: f.real, one: f.one, file: f.file })).toString('base64')
  const hashSource = generated.match(/^function Get-ClawPanelUtf8Sha256.*$/m)[0], script = path.join(f.dir, 'fixture.ps1')
  fs.writeFileSync(script, `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n${hashSource}\n${windowsPathFingerprintSource()}\n$f=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')));$hostClock=[Diagnostics.Stopwatch]::StartNew()\n${code}`)
  const load = `& ([scriptblock]::Create([IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}')))))`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  return { args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(load, 'utf16le').toString('base64')], env }
}
function run(f, code) {
  const { args, env } = command(f, code)
  const r = spawnSync('powershell.exe', args, { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.code, stderr: r.stderr }))
  const rows = [...r.stderr.matchAll(/CLAWPANEL_LAUNCHER_FILE (\{[^\r\n]*\})/g)].map(m => JSON.parse(m[1]))
  return { value: JSON.parse(r.stdout.replace(/^\uFEFF/, '')), stderr: r.stderr, rows }
}
const trace = `$trace=@{directoryIndex=1;fileIndex=1;records=0;clock=$hostClock;process=[Diagnostics.Process]::GetCurrentProcess()}`

test('原预算/完整PATH/原Get-FileHash与canary字段保留，仅stderr固定逐文件阶段诊断', () => {
  assert.ok(block)
  assert.match(block, /Get-ClawPanelPathFingerprint \$f.FullName \$launcherFingerprintTrace/)
  assert.match(source, /timeout: 30000, maxBuffer: 16 \* 1024 \* 1024/)
  assert.match(windowsPathFingerprintSource(), /Get-FileHash -LiteralPath \$p -Algorithm SHA256 -ErrorAction Stop/)
  assert.match(windowsPathFingerprintSource(), /CLAWPANEL_LAUNCHER_FILE/)
  assert.match(block, /\$env:PATH -split ';'/)
  assert.match(block, /Sort-Object -Unique/)
  assert.doesNotMatch(block, /Select-Object -First|\$dirs\[|break|continue|return|SilentlyContinue/)
})

test('真实hostSnapshot EncodedCommand含UTF16 NUL仍适配Windows32767门禁', t => {
  let script
  new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(code => { script = code; return {} }, windowsPathFingerprintSource, Buffer, () => 'unused', { env: {} })({ actualProfile: 'C:\\Users\\' + 'x'.repeat(87) })
  const encoded = Buffer.from('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + script, 'utf16le').toString('base64')
  const argv = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand ' + encoded
  assert.ok(argv.length + 1 < 32767, `UTF16含NUL=${argv.length + 1}`)
  t.diagnostic(JSON.stringify({ case: 'host-snapshot-argv', utf16IncludingNul: argv.length + 1, remaining: 32767 - argv.length - 1 }))
})

test('真实普通文件逐阶段begin/end，与无诊断完整fingerprint等价且不泄露文件路径', windows, t => {
  const f = fixture()
  try {
    const { value, rows, stderr } = run(f, `${trace};$old=Get-ClawPanelPathFingerprint $f.file;$new=Get-ClawPanelPathFingerprint $f.file $trace;@{old=$old;new=$new}|ConvertTo-Json -Depth 10 -Compress`)
    assert.deepEqual(value.new, value.old)
    assert.equal(value.new.sha256, hash(f.data))
    assert.equal(rows.length, 6)
    assert.deepEqual(rows.map(r => [r.stage, r.event]), ['attributes', 'item', 'filehash'].flatMap(s => [[s, 'begin'], [s, 'end']]))
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['directoryIndex', 'fileIndex', 'stage', 'event', 'bytes', 'elapsedMs', 'cpuMs'].sort())
      for (const key of ['directoryIndex', 'fileIndex', 'bytes', 'elapsedMs', 'cpuMs']) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, JSON.stringify(row))
      assert.equal(row.directoryIndex, 1); assert.equal(row.fileIndex, 1)
    }
    assert.ok(rows.filter(r => r.stage === 'filehash').every(r => r.bytes === f.data.length))
    assert.ok(!stderr.includes(f.dir) && !stderr.includes('node.exe'))
    assert.doesNotThrow(() => assertHostUnchanged({ launchers: [value.old] }, { launchers: [value.new] }))
    t.diagnostic(JSON.stringify({ case: 'ordinary', rows, fingerprint: value.new }))
  } finally { f.dispose() }
})

test('真实受控慢Get-Item与Get-FileHash准确分段', windows, t => {
  const f = fixture()
  try {
    const { rows } = run(f, `function Get-Item {[CmdletBinding()]param($LiteralPath,[switch]$Force);Start-Sleep -Milliseconds 120;Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters}\nfunction Get-FileHash {[CmdletBinding()]param($LiteralPath,$Algorithm);Start-Sleep -Milliseconds 200;Microsoft.PowerShell.Utility\\Get-FileHash @PSBoundParameters}\n${trace};Get-ClawPanelPathFingerprint $f.file $trace|ConvertTo-Json -Depth 10 -Compress`)
    assert.equal(rows.length, 6)
    const elapsed = stage => rows.find(r => r.stage === stage && r.event === 'end').elapsedMs - rows.find(r => r.stage === stage && r.event === 'begin').elapsedMs
    assert.ok(elapsed('item') >= 100, JSON.stringify(rows))
    assert.ok(elapsed('filehash') >= 180, JSON.stringify(rows))
    assert.ok(rows[3].elapsedMs <= rows[4].elapsedMs, JSON.stringify(rows))
    t.diagnostic(JSON.stringify({ case: 'controlled-delays', rows }))
  } finally { f.dispose() }
})

test('真实活子进程hash尚未结束时已收到begin，不靠close后批量记录', windows, async t => {
  const f = fixture()
  let child
  try {
    const { args, env } = command(f, `function Get-FileHash {[CmdletBinding()]param($LiteralPath,$Algorithm);Start-Sleep -Milliseconds 1500;Microsoft.PowerShell.Utility\\Get-FileHash @PSBoundParameters}\n${trace};Get-ClawPanelPathFingerprint $f.file $trace|ConvertTo-Json -Compress`)
    child = spawn('powershell.exe', args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = '', stdout = '', beginBeforeClose = false
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
      if (/"stage":"filehash","event":"begin"/.test(stderr) && !/"stage":"filehash","event":"end"/.test(stderr)) beginBeforeClose = child.exitCode === null
    })
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    const timer = setTimeout(() => child.kill(), 30000)
    let result
    try { result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) }) } finally { clearTimeout(timer) }
    assert.deepEqual(result, { code: 0, signal: null }, stderr)
    assert.ok(beginBeforeClose, stderr)
    assert.equal(JSON.parse(stdout.replace(/^\uFEFF/, '')).sha256, hash(f.data))
    t.diagnostic(JSON.stringify({ case: 'live-begin', beginBeforeClose, exit: result, rows: [...stderr.matchAll(/CLAWPANEL_LAUNCHER_FILE (\{[^\r\n]*\})/g)].map(m => JSON.parse(m[1])) }))
  } finally { if (child?.exitCode === null) child.kill(); f.dispose() }
})

test('真实locked hash仍抛原错误，最后begin/failed准确且诊断写异常不改成功/失败', windows, () => {
  const f = fixture()
  try {
    const { value, rows } = run(f, `${trace};$locked=[IO.File]::Open($f.file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{$old=$null;$new=$null;try{Get-ClawPanelPathFingerprint $f.file|Out-Null}catch{$old=$_.FullyQualifiedErrorId};try{Get-ClawPanelPathFingerprint $f.file $trace|Out-Null}catch{$new=$_.FullyQualifiedErrorId}}finally{$locked.Dispose()};$saved=[Console]::Error;$writer=New-Object IO.StringWriter;$writer.Dispose();[Console]::SetError($writer);try{$ok=Get-ClawPanelPathFingerprint $f.file $trace;$locked=[IO.File]::Open($f.file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{$brokenLog=$null;try{Get-ClawPanelPathFingerprint $f.file $trace|Out-Null}catch{$brokenLog=$_.FullyQualifiedErrorId}}finally{$locked.Dispose()}}finally{[Console]::SetError($saved)};@{old=$old;new=$new;brokenLog=$brokenLog;ok=$ok}|ConvertTo-Json -Depth 10 -Compress`)
    assert.ok(value.old)
    assert.equal(value.new, value.old); assert.equal(value.brokenLog, value.old)
    assert.equal(value.ok.sha256, hash(f.data))
    assert.equal(rows.length, 6)
    assert.deepEqual(rows.slice(-2).map(r => [r.stage, r.event]), [['filehash', 'begin'], ['filehash', 'failed']])
  } finally { f.dispose() }
})

test('真实absent/directory/reparse保留原语义，无文件hash/目标跟随', windows, () => {
  const f = fixture()
  try {
    const link = path.join(f.one, 'hermes-link.exe'); fs.symlinkSync(f.file, link, 'file'); f.links.push(link)
    const { value, rows } = run(f, `${trace};$results=@();foreach($p in @((Join-Path $f.one 'missing.exe'),$f.one,(Join-Path $f.one 'hermes-link.exe'))){$old=Get-ClawPanelPathFingerprint $p;$new=Get-ClawPanelPathFingerprint $p $trace;$results+=@{old=$old;new=$new};$trace.fileIndex++};ConvertTo-Json -InputObject $results -Depth 12 -Compress`)
    assert.equal(value.length, 3)
    value.forEach(v => assert.deepEqual(v.new, v.old))
    assert.deepEqual(value.map(v => v.new.kind), ['absent', 'directory', 'reparse'])
    assert.ok(value.every(v => v.new.sha256 === null))
    assert.ok(rows.length > 0); assert.ok(!rows.some(r => r.stage === 'filehash'))
    assert.ok(rows.some(r => r.fileIndex === 3 && r.stage === 'reparse' && r.event === 'end'))
    assert.ok(rows.some(r => r.fileIndex === 1 && r.stage === 'attributes' && r.event === 'absent'))
  } finally { f.dispose() }
})

test('日志512限额不是扫描限额：70真实PATH目录/140完整文件、65+及日志耗尽后仍hash', windows, () => {
  const f = fixture()
  try {
    const dirs = []
    for (let i = 0; i < 70; i++) {
      const dir = path.join(f.dir, 'paths', String(i).padStart(3, '0')); fs.mkdirSync(dir, { recursive: true }); dirs.push(dir)
      for (const name of ['node.exe', 'hermes.cmd']) fs.writeFileSync(path.join(dir, name), `owned-${i}-${name}`)
    }
    const dirs64 = Buffer.from(JSON.stringify(dirs)).toString('base64')
    const { value, rows, stderr } = run(f, `$env:PATH=(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dirs64}')))) -join ';';$real=$f.real\n${block}\nConvertTo-Json -InputObject @($launchers) -Depth 12 -Compress`)
    assert.equal(value.length, 140)
    assert.equal(rows.length, 512)
    assert.ok(!stderr.includes(f.dir))
    for (const v of value) { assert.equal(v.fingerprint.kind, 'file'); assert.equal(v.sha256, hash(fs.readFileSync(v.path))) }
    assert.equal(value.filter(v => path.basename(path.dirname(v.path)) === '069').length, 2)
    assert.ok(rows.every(r => r.directoryIndex <= 70))
  } finally { f.dispose() }
})

test('真实私有文件Get-FileHash LiteralPath/InputStream/.NET CSP全字节API对比只记录测量不宣称冷IO修复', windows, t => {
  const f = fixture()
  try {
    const data = Buffer.alloc(8 * 1024 * 1024, 0xa5); fs.writeFileSync(f.file, data)
    const { value } = run(f, `$rows=@();foreach($method in @('literal','stream','direct','direct','stream','literal')){$clock=[Diagnostics.Stopwatch]::StartNew();$cpu=[Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds;$stream=$null;$h=$null;try{if($method -eq 'literal'){$digest=(Get-FileHash -LiteralPath $f.file -Algorithm SHA256 -ErrorAction Stop).Hash}else{$stream=[IO.File]::OpenRead($f.file);if($method -eq 'stream'){$digest=(Get-FileHash -InputStream $stream -Algorithm SHA256 -ErrorAction Stop).Hash}else{$h=New-Object Security.Cryptography.SHA256CryptoServiceProvider;$digest=([BitConverter]::ToString($h.ComputeHash($stream))).Replace('-','')}}}finally{if($stream){$stream.Dispose()};if($h){$h.Dispose()}};$rows+=@{method=$method;sha256=$digest;elapsedMs=$clock.ElapsedMilliseconds;cpuMs=([Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds-$cpu)}};@{scope='owned-local-cache-uncontrolled-not-production-cold';psVersion=$PSVersionTable.PSVersion.ToString();runtime=[Environment]::Version.ToString();commandType=(Get-Command Get-FileHash).CommandType.ToString();definitionSha256=(Get-ClawPanelUtf8Sha256 (Get-Command Get-FileHash).Definition);rows=$rows}|ConvertTo-Json -Depth 6 -Compress`)
    assert.equal(value.rows.length, 6)
    value.rows.forEach(r => assert.equal(r.sha256, hash(data)))
    t.diagnostic(JSON.stringify(value))
  } finally { f.dispose() }
})
