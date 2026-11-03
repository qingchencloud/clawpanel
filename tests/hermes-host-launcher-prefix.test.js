import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertHostUnchanged, hostSnapshot, windowsPathFingerprintSource } from '../scripts/test-hermes-windows-qualification.mjs'

// 故障清单：漏候选/误纳入、大小写与多目录、隐藏文件、链接跟随、hash/单prefix失败被吞、诊断泄漏、预算变化。
// 仅提取可信函数生成的脚本文本；ps替身不执行任何hostSnapshot/registry/真实PATH扫描。
let generated
const capture = new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(code => { generated = code; return {} }, windowsPathFingerprintSource, Buffer, () => 'unused', { env: {} })
capture({ actualProfile: 'fixture-only-not-a-host-profile' })
const block = generated.split("Write-ClawPanelHostPhase 'launchers'\n")[1]?.split("\nWrite-ClawPanelHostPhase 'execution-policy'")[0]
assert.ok(block, '真实launchers脚本片段必须精确可提取')
const original = String.raw`$launchers=@();$dirs=@(($env:PATH -split ';')+@("$real\AppData\Roaming\npm","$real\.local\bin","$real\.hermes\bin"))|Sort-Object -Unique
foreach($d in $dirs){if($d -and (Test-Path -LiteralPath $d)){foreach($f in (Get-ChildItem -LiteralPath $d -File -ErrorAction Stop|Where-Object {$_.Name -match '^(hermes|uv|node|npm|python|git)([.-].*|[0-9.]*\.exe|\.cmd|\.ps1)?$'}|Sort-Object FullName)){$fingerprint=Get-ClawPanelPathFingerprint $f.FullName;$launchers+=@{path=$f.FullName;bytes=$f.Length;sha256=$fingerprint.sha256;fingerprint=$fingerprint}}}}`

test('生产仅按原六个名称前缀作provider Filter，完整regex、排序和typed fingerprint保留', () => {
  assert.match(block, /\$launcherPrefixes=@\('hermes','uv','node','npm','python','git'\)/)
  assert.match(block, /Get-ChildItem -LiteralPath \$d -Filter \(\$prefix\+'\*'\) -File -ErrorAction Stop/)
  const regex = original.match(/Name -match '([^']+)'/)[1]
  assert.equal(block.match(/Name -match '([^']+)'/)[1], regex)
  for (const kept of ['Sort-Object -Unique', 'Sort-Object FullName', '$fingerprint=Get-ClawPanelPathFingerprint $f.FullName', 'path=$f.FullName;bytes=$f.Length;sha256=$fingerprint.sha256;fingerprint=$fingerprint']) assert.ok(block.includes(kept), kept)
  assert.doesNotMatch(block, /-Force|SilentlyContinue|catch|ContinueOnError|Get-FileHash|Get-CimInstance|Win32_Process/)
  assert.match(fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8'), /timeout: 30000, maxBuffer: 16 \* 1024 \* 1024/)
})

const windows = { skip: process.platform !== 'win32' }
function fixture() {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'hermes-prefix-fixture-'))
  const one = path.join(dir, 'one [literal] 资格'), two = path.join(dir, 'two'), real = path.join(dir, 'private')
  for (const d of [one, two, real, path.join(real, '.local/bin'), path.join(real, '.hermes/bin'), path.join(real, 'AppData/Roaming/npm')]) fs.mkdirSync(d, { recursive: true })
  const names = ['hermes', 'hermes.exe', 'HeRmEs-qual.ps1', 'uv.exe', 'uvx.exe', 'node', 'node.dll', 'npm.cmd', 'npmrc', 'python3.14.exe', 'python314.exe', 'git.exe', 'gitconfig', 'not-hermes.exe']
  for (const d of [one, two]) {
    for (const name of names) fs.writeFileSync(path.join(d, name), 'fixture-' + name)
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(d, `unrelated-${i}.dat`), 'not-a-launcher')
  }
  fs.writeFileSync(path.join(real, '.local/bin/npm-qual.cmd'), 'private-local')
  fs.writeFileSync(path.join(real, '.hermes/bin/hermes.ps1'), 'private-hermes')
  fs.writeFileSync(path.join(real, 'AppData/Roaming/npm/uv.cmd'), 'private-npm')
  const large = path.join(two, 'python-large.exe'), fd = fs.openSync(large, 'w')
  try { fs.ftruncateSync(fd, 8 * 1024 * 1024) } finally { fs.closeSync(fd) }
  const links = [], junction = path.join(one, 'hermes-directory.exe')
  fs.symlinkSync(two, junction, 'junction'); links.push(junction)
  return { dir, one, two, real, large, links, dirs: [one, two, one, one.toUpperCase(), path.join(dir, 'missing')], dispose() {
    for (const link of links) fs.unlinkSync(link)
    assert.equal(path.dirname(fs.realpathSync(dir)), parent)
    fs.rmSync(dir, { recursive: true, force: true })
  } }
}
function run(f, code) {
  const input = Buffer.from(JSON.stringify({ dirs: f.dirs, real: f.real, one: f.one, two: f.two })).toString('base64')
  const hash = generated.match(/^function Get-ClawPanelUtf8Sha256.*$/m)[0]
  const script = path.join(f.dir, 'fixture.ps1')
  fs.writeFileSync(script, `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n${hash}\n${windowsPathFingerprintSource()}\n$fixture=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')));$env:PATH=$fixture.dirs -join ';';$real=$fixture.real;$hostClock=[Diagnostics.Stopwatch]::StartNew()\n${code}`)
  const encoded = Buffer.from(script).toString('base64')
  const load = `$s=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')));& ([scriptblock]::Create($s))`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(load, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, JSON.stringify({ status: r.status, error: r.error?.code, stderr: r.stderr }))
  return { value: JSON.parse(r.stdout.replace(/^\uFEFF/, '')), stderr: r.stderr }
}

test('Windows真实私有多目录原/新完整有序fingerprint等价：大小写/隐藏/大文件/目录链接不穿越', windows, () => {
  const f = fixture()
  try {
    const { value } = run(f, `$hidden=Join-Path $fixture.one 'python-hidden.exe';[IO.File]::WriteAllText($hidden,'hidden');[IO.File]::SetAttributes($hidden,[IO.FileAttributes]::Hidden)\n${original}\n$old=@($launchers)\n${block}\n@{old=$old;new=@($launchers)}|ConvertTo-Json -Depth 12 -Compress`)
    assert.deepEqual(value.new, value.old)
    assert.ok(value.new.length > 15)
    assert.ok(value.new.every(x => x.sha256 && x.fingerprint.kind === 'file'))
    assert.ok(value.new.some(x => path.basename(x.path) === 'python-large.exe' && x.bytes === 8 * 1024 * 1024))
    assert.ok(value.new.some(x => path.basename(x.path) === 'HeRmEs-qual.ps1'))
    assert.ok(!value.new.some(x => /uvx|npmrc|gitconfig|hidden|directory|unrelated/.test(path.basename(x.path))))
    assert.equal(new Set(value.new.map(x => x.path.toLowerCase())).size, value.new.length)
  } finally { f.dispose() }
})

test('单prefix枚举失败与matching launcher不可读均保留失败，不变空集合/缺hash的绿灯', windows, () => {
  const f = fixture()
  try {
    const { value } = run(f, `$mode='';function Get-ChildItem {[CmdletBinding()]param([string]$LiteralPath,[switch]$File,[string]$Filter);if($mode -eq 'deny' -and $LiteralPath -eq $fixture.one -and (-not $Filter -or $Filter -eq 'npm*')){throw 'qualification-owned-enumeration-failure'};Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters}\n$results=@();foreach($variant in @('old','new')){foreach($failure in @('deny','locked')){$mode=$failure;$locked=$null;if($failure -eq 'locked'){$locked=[IO.File]::Open((Join-Path $fixture.one 'node.dll'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)};try{$errorId=$null;try{if($variant -eq 'old'){${original}}else{${block}}}catch{$errorId=$_.FullyQualifiedErrorId};$results+=@{variant=$variant;failure=$failure;errorId=$errorId}}finally{if($locked){$locked.Dispose()}}}};ConvertTo-Json -InputObject $results -Depth 5 -Compress`)
    assert.equal(value.length, 4)
    for (const row of value) assert.ok(row.errorId, JSON.stringify(row))
    assert.deepEqual(value.filter(x => x.failure === 'deny').map(x => x.errorId), ['qualification-owned-enumeration-failure', 'qualification-owned-enumeration-failure'])
    assert.ok(value.filter(x => x.failure === 'locked').every(x => /FileReadError|IOException|UnauthorizedAccess/.test(x.errorId)), JSON.stringify(value))
  } finally { f.dispose() }
})

test('Windows真实文件symlink仍读link metadata而非target内容；target变化必须被canary拒绝', windows, t => {
  const f = fixture()
  try {
    const link = path.join(f.one, 'hermes-link.exe'), target = path.join(f.two, 'not-hermes.exe')
    fs.symlinkSync(target, link, 'file'); f.links.push(link)
    assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.ok(fs.statSync(target).isFile())
    // 属性只改本fixture链接自身；不对生产枚举加Force，也不把NoForce合理排除当成正例通过。
    const visible = `$link=Join-Path $fixture.one 'hermes-link.exe';$before=[int64][IO.File]::GetAttributes($link);[IO.File]::SetAttributes($link,($before -band (-bnot ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System))));$literal=Get-Item -LiteralPath $link -Force -ErrorAction Stop;$linkProof=@{path=$literal.FullName;before=$before;attributes=[int64][IO.File]::GetAttributes($link);fingerprint=(Get-ClawPanelPathFingerprint $link)}`
    const pair = `function Read-FixtureLauncherPair {\n${original}\n$old=@($launchers)\n${block}\nreturn @{old=$old;new=@($launchers)}\n}`
    const { value } = run(f, `${pair}\n$link=Join-Path $fixture.one 'hermes-link.exe';$initialAttributes=[int64][IO.File]::GetAttributes($link);$initial=Read-FixtureLauncherPair;[IO.File]::SetAttributes($link,($initialAttributes -bor [IO.FileAttributes]::Hidden));$hiddenAttributes=[int64][IO.File]::GetAttributes($link);$hidden=Read-FixtureLauncherPair\n${visible}\n$shown=Read-FixtureLauncherPair;@{old=$shown.old;new=$shown.new;initial=$initial;initialAttributes=$initialAttributes;hidden=$hidden;hiddenAttributes=$hiddenAttributes;link=$linkProof}|ConvertTo-Json -Depth 12 -Compress`)
    assert.deepEqual(value.new, value.old)
    const selected = (rows, expected = value.link.path) => rows.filter(x => x.path.toLowerCase() === expected.toLowerCase())
    const diagnostic = { initialAttributes: value.initialAttributes, hiddenAttributes: value.hiddenAttributes, visibleAttributes: value.link.attributes, initiallySelectedOld: selected(value.initial.old).length, initiallySelectedNew: selected(value.initial.new).length }
    t.diagnostic(JSON.stringify(diagnostic))
    assert.deepEqual(value.initial.new, value.initial.old)
    assert.deepEqual(value.hidden.new, value.hidden.old)
    assert.ok(value.hiddenAttributes & 2); assert.equal(selected(value.hidden.old).length, 0); assert.equal(selected(value.hidden.new).length, 0)
    assert.equal(value.link.attributes & 6, 0); assert.ok(value.link.attributes & 1024)
    assert.equal(selected(value.old).length, 1, JSON.stringify({ ...diagnostic, literal: value.link, original: value.old }))
    assert.equal(selected(value.new).length, 1, JSON.stringify({ ...diagnostic, literal: value.link, filtered: value.new }))
    const observed = selected(value.new)[0]
    assert.deepEqual(observed.fingerprint, value.link.fingerprint, '必须是LiteralPath读到的真实同一reparse，不能按basename宽松补认')
    assert.equal(observed.fingerprint.kind, 'reparse'); assert.equal(observed.sha256, null)
    assert.equal(observed.fingerprint.linkType, 'SymbolicLink'); assert.ok(observed.fingerprint.metadataSha256)
    fs.unlinkSync(link); fs.symlinkSync(path.join(f.one, 'not-hermes.exe'), link, 'file')
    const after = run(f, `${visible}\n${pair}\n$shown=Read-FixtureLauncherPair;@{old=$shown.old;new=$shown.new;link=$linkProof}|ConvertTo-Json -Depth 12 -Compress`).value
    assert.deepEqual(after.new, after.old)
    const changed = after.new
    assert.equal(selected(changed, after.link.path).length, 1, JSON.stringify({ literal: after.link, filtered: changed }))
    const actual = selected(changed, after.link.path)[0]
    assert.deepEqual(actual.fingerprint, after.link.fingerprint)
    assert.notEqual(actual.fingerprint.metadataSha256, observed.fingerprint.metadataSha256)
    assert.throws(() => assertHostUnchanged({ launchers: value.new }, { launchers: changed }), /宿主/)
  } finally { f.dispose() }
})

test('逐目录只读数字诊断区分枚举和hash，有限且不泄漏路径/改变stdout canary', windows, () => {
  const f = fixture()
  try {
    const { value, stderr } = run(f, `${block}\nConvertTo-Json -InputObject @($launchers) -Depth 12 -Compress`)
    assert.ok(value.length)
    const rows = [...stderr.matchAll(/CLAWPANEL_LAUNCHER_DIRECTORY (\{[^\r\n]*\})/g)].map(m => JSON.parse(m[1]))
    assert.ok(rows.length > 0, 'launchers时间线需在每目录枚举前/后及hash后留证')
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['bytes', 'count', 'elapsedMs', 'event', 'index'].sort())
      assert.ok(['begin', 'enumerated', 'fingerprinted'].includes(row.event))
      for (const k of ['index', 'count', 'bytes', 'elapsedMs']) assert.ok(Number.isSafeInteger(row[k]) && row[k] >= 0, k)
      assert.ok(row.index <= 64)
    }
    for (const index of new Set(rows.map(x => x.index))) assert.deepEqual(rows.filter(x => x.index === index).map(x => x.event), ['begin', 'enumerated', 'fingerprinted'])
    assert.ok(rows.some(x => x.event === 'enumerated' && x.bytes >= 8 * 1024 * 1024))
    assert.ok(!stderr.includes(f.dir) && !stderr.includes('python-large.exe'))
  } finally { f.dispose() }
})
