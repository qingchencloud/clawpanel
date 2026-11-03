import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { hostSnapshot, windowsPathFingerprintSource } from '../scripts/test-hermes-windows-qualification.mjs'

// 先失败：两路真实literal hash/有界等待、完整输出、锁/未知值/入队换link失败、70目录、默认helper与32767门禁。
let generated
new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(s => { generated = s; return {} }, windowsPathFingerprintSource, Buffer, () => '', { env: {} })({ actualProfile: 'C:\\Users\\' + 'x'.repeat(87) })
const block = generated.split("Write-ClawPanelHostPhase 'launchers'\n")[1].split("\nWrite-ClawPanelHostPhase 'execution-policy'")[0]
const serial = String.raw`$launchers=@();$dirs=@(($env:PATH -split ';')+@("$real\AppData\Roaming\npm","$real\.local\bin","$real\.hermes\bin"))|Sort-Object -Unique
foreach($d in $dirs){if($d -and (Test-Path -LiteralPath $d)){foreach($f in (Get-ChildItem -LiteralPath $d -File -ErrorAction Stop|Where-Object {$_.Name -match '^(hermes|uv|node|npm|python|git)([.-].*|[0-9.]*\.exe|\.cmd|\.ps1)?$'}|Sort-Object FullName)){$fingerprint=Get-ClawPanelPathFingerprint $f.FullName;$launchers+=@{path=$f.FullName;bytes=$f.Length;sha256=$fingerprint.sha256;fingerprint=$fingerprint}}}}`
const windows = { skip: process.platform !== 'win32' }
const out = process.env.HERMES_HOST_IO_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-host-io-evidence-'))
fs.mkdirSync(out, { recursive: true })
const digest = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase()

const control = String.raw`Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class OwnedHashControl {
  public static int Active,Peak,Calls,Pending;
  public static string Mode,SwapPath,Prepared;
  public static ManualResetEventSlim Classified=new ManualResetEventSlim(),Swapped=new ManualResetEventSlim();
  public static CountdownEvent Both=new CountdownEvent(2);
  public static void Enter(string p){
    int n=Interlocked.Increment(ref Active);Interlocked.Increment(ref Calls);
    int old;do{old=Peak;if(n<=old)break;}while(Interlocked.CompareExchange(ref Peak,n,old)!=old);
    string name=Path.GetFileName(p);
    if((Mode=="overlap"||Mode=="swap"||Mode=="mutate")&&(name=="node-a.exe"||name=="node-b.exe")){
      Both.Signal();if(!Both.Wait(5000))return;
      if((Mode=="swap"||Mode=="mutate")&&Classified.Wait(5000)){
        if(name=="node-a.exe"){
          if(Mode=="swap"){File.Delete(SwapPath);File.Move(Prepared,SwapPath);}
          else {File.SetLastWriteTimeUtc(SwapPath,File.GetLastWriteTimeUtc(SwapPath).AddSeconds(2));}
          Swapped.Set();
        }
        else Swapped.Wait(5000);
      }
    }
    if(Mode=="throw"&&name=="node-a.exe")throw new IOException("owned hash failure");
  }
  public static void Leave(){Interlocked.Decrement(ref Active);}
  public static void Observe(int n){Pending=Math.Max(Pending,n);}
  public static string After(string hash,string p){
    if(Mode=="postswap"&&p==SwapPath){File.Delete(SwapPath);File.Move(Prepared,SwapPath);Swapped.Set();}
    if(Path.GetFileName(p)=="node-a.exe"){if(Mode=="bad")return "unknown";if(Mode=="empty")return "";}
    return hash;
  }
}
'@`

function fixture(count = 1, root = os.tmpdir()) {
  // native展开8.3别名，与PowerShell provider的FullName一致；只规范自有fixture输入。
  const parent = fs.realpathSync.native(root), dir = fs.mkdtempSync(path.join(parent, 'cp-host-io-')), real = path.join(dir, 'private'), dirs = [], links = []
  fs.mkdirSync(real)
  for (let i = 0; i < count; i++) {
    const d = path.join(dir, 'paths', String(i).padStart(3, '0')); fs.mkdirSync(d, { recursive: true }); dirs.push(d)
    for (const name of count === 1 ? ['node-a.exe', 'node-b.exe', 'node-c.exe'] : ['node.exe', 'hermes.cmd']) fs.writeFileSync(path.join(d, name), Buffer.alloc(i === 0 ? 65537 : 37 + i, i))
  }
  return { dir, real, dirs, links, dispose() {
    for (const link of links) { if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) }
    assert.equal(path.dirname(fs.realpathSync.native(dir)), parent); fs.rmSync(dir, { recursive: true, force: true })
  } }
}

function run(f, name, { mode = 'none', compare = false, before = '', after = '' } = {}) {
  const values = { real: f.real, dirs: f.dirs, file: path.join(f.dirs[0], 'node-a.exe'), swapPath: path.join(f.dirs[0], 'node-c.exe'), prepared: path.join(f.dir, 'prepared-link.tmp') }
  const input = Buffer.from(JSON.stringify(values)).toString('base64')
  let helper = windowsPathFingerprintSource()
  const call = '$sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash'
  assert.equal(helper.split(call).length, 2, '只代理实际单一Get-FileHash调用；不以fake hash替代读文件')
  helper = helper.replace(call, `try{[OwnedHashControl]::Enter($p);${call};if([OwnedHashControl]::Mode -eq 'error'){Write-Error 'owned nonterminating error' -ErrorAction Continue};$sha256=[OwnedHashControl]::After($sha256,$p)}finally{[OwnedHashControl]::Leave()}`)
  helper = helper.replace('$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop', `$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop;if($p -eq $v.swapPath){[OwnedHashControl]::Classified.Set()}`)
  let actual = block.replace("Close-ClawDir $t.dir", "[OwnedHashControl]::Observe($hw.j.Count);Close-ClawDir $t.dir")
  const hashSource = generated.match(/^function Get-ClawPanelUtf8Sha256.*$/m)[0]
  const resourceState = 'active=[OwnedHashControl]::Active;poolState=$hw.p.RunspacePoolStateInfo.State.ToString()'
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n${control}\n${hashSource}\n${helper}\n$v=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')));$real=$v.real;$env:PATH=$v.dirs -join ';';$hostClock=[Diagnostics.Stopwatch]::StartNew();$locked=$null\n${before}\ntry{\n${compare ? serial + '\n$old=@($launchers)' : '$old=@()'}\n[OwnedHashControl]::Calls=0;[OwnedHashControl]::Peak=0;[OwnedHashControl]::Mode='${mode}';[OwnedHashControl]::SwapPath=$v.swapPath;[OwnedHashControl]::Prepared=$v.prepared\n${actual}\n${after}\n@{failed=$false;old=$old;launchers=@($launchers);peak=[OwnedHashControl]::Peak;pending=[OwnedHashControl]::Pending;calls=[OwnedHashControl]::Calls;swapped=[OwnedHashControl]::Swapped.IsSet;${resourceState}}|ConvertTo-Json -Depth 14 -Compress\n}catch{@{failed=$true;errorId=$_.FullyQualifiedErrorId;error=$_.Exception.Message;peak=[OwnedHashControl]::Peak;calls=[OwnedHashControl]::Calls;swapped=[OwnedHashControl]::Swapped.IsSet;${resourceState}}|ConvertTo-Json -Compress}finally{if($locked){$locked.Dispose()}}`
  const file = path.join(f.dir, 'fixture.ps1'); fs.writeFileSync(file, script)
  const load = `& ([scriptblock]::Create([IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}')))))`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(load, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.code, stdout: r.stdout, stderr: r.stderr, qualificationPass: false }, null, 2))
  assert.equal(r.status, 0, JSON.stringify({ error: r.error, stderr: r.stderr }))
  const result = JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
  assert.equal(result.active, 0, JSON.stringify(result)); assert.equal(result.poolState, 'Closed', JSON.stringify(result))
  return result
}

test('只regular launcher启用两路滚动，原30s/16MiB/PS传输和96位ASCII/Unicode完整32767UTF16门禁', t => {
  assert.match(windowsPathFingerprintSource(), /CreateRunspacePool\(1,2\)/)
  const lengths = []
  for (const character of ['x', '汉']) {
    let code
    new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(s => { code = s; return {} }, windowsPathFingerprintSource, Buffer, () => '', { env: {} })({ actualProfile: 'C:\\Users\\' + character.repeat(87) })
    code = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + code
    const n = ('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand ' + Buffer.from(code, 'utf16le').toString('base64')).length + 1
    lengths.push({ profile: character === 'x' ? 'ASCII96' : 'BMP96', utf16IncludingNul: n, remaining: 32767 - n })
    assert.ok(n < 32767, `完整UTF16含NUL=${JSON.stringify(lengths.at(-1))}`)
  }
  const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /timeout: 30000, maxBuffer: 16 \* 1024 \* 1024/)
  assert.doesNotMatch(block, /Start-Job|Start-Process|ForEach-Object -Parallel|Select-Object -First/)
  fs.writeFileSync(path.join(out, 'argv.json'), JSON.stringify({ lengths, qualificationPass: false }))
  t.diagnostic(JSON.stringify({ lengths }))
})

test('真实文件+阻塞literal API双路重叠且不超过2；完整结果与原串行逐字段一致', windows, () => {
  const f = fixture()
  try {
    const j = run(f, 'overlap', { mode: 'overlap', compare: true })
    assert.equal(j.failed, false, JSON.stringify(j)); assert.equal(j.peak, 2, JSON.stringify(j)); assert.ok(j.pending <= 2)
    assert.equal(j.active, 0); assert.equal(j.calls, 3); assert.deepEqual(j.launchers, j.old)
    for (const row of j.launchers) assert.equal(row.sha256, digest(fs.readFileSync(row.path)))
  } finally { f.dispose() }
})

test('单job失败/错误流/empty或unknown hash/实际locked文件均使整个snapshot失败，没有部分canary', windows, () => {
  for (const mode of ['throw', 'bad', 'empty', 'error', 'locked']) {
    const f = fixture()
    try {
      const j = run(f, mode, { mode, before: mode === 'locked' ? "$locked=[IO.File]::Open($v.file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)" : '' })
      assert.equal(j.failed, true, JSON.stringify(j)); assert.ok(j.errorId); assert.equal(j.launchers, undefined)
      if (mode === 'locked') assert.equal(j.errorId, 'FileReadError,Get-FileHash', '跨runspace传播原错误记录，不用包装异常替换原IO失败')
    } finally { f.dispose() }
  }
})

test('同长度文件入队后仅mtime变化仍拒绝，不能读取变动后metadata冒充原记录', windows, () => {
  const f = fixture()
  try {
    const j = run(f, 'queued-metadata-change', { mode: 'mutate' })
    assert.equal(j.swapped, true, JSON.stringify(j)); assert.equal(j.failed, true, JSON.stringify(j)); assert.equal(j.launchers, undefined)
  } finally { f.dispose() }
})

test('真实入队后leaf换symlink必须拒绝，不跟随target填入hash', windows, () => {
  for (const mode of ['swap', 'postswap']) {
    const f = fixture()
    try {
      const prepared = path.join(f.dir, 'prepared-link.tmp'), target = path.join(f.dir, 'owned-target.bin')
      fs.writeFileSync(target, 'not-original'); fs.symlinkSync(target, prepared, 'file'); f.links.push(prepared, path.join(f.dirs[0], 'node-c.exe'))
      const j = run(f, 'queued-link-' + mode, { mode })
      assert.equal(j.swapped, true, JSON.stringify(j)); assert.equal(j.failed, true, JSON.stringify(j)); assert.equal(j.launchers, undefined)
    } finally { f.dispose() }
  }
})

test('跨目录滚动而非按目录等待：两个自有文件在不同目录仍真实重叠', windows, () => {
  const f = fixture()
  try {
    const second = path.join(f.dir, 'paths', '001'); fs.mkdirSync(second)
    fs.renameSync(path.join(f.dirs[0], 'node-b.exe'), path.join(second, 'node-b.exe')); f.dirs.push(second)
    const j = run(f, 'cross-directory', { mode: 'overlap', compare: true })
    assert.equal(j.failed, false, JSON.stringify(j)); assert.equal(j.peak, 2, JSON.stringify(j)); assert.ok(j.pending <= 2)
    assert.equal(j.calls, 3); assert.deepEqual(j.launchers, j.old)
  } finally { f.dispose() }
})

test('70真实PATH目录完整覆盖、日志限额不截断；初始typed reparse仍串行且不读target', windows, () => {
  const f = fixture(70)
  try {
    const link = path.join(f.dirs[0], 'hermes-link.exe'), target = path.join(f.dir, 'owned-target.bin')
    fs.writeFileSync(target, 'target-not-hashed'); fs.symlinkSync(target, link, 'file'); f.links.push(link)
    const before = `$link=Join-Path $v.dirs[0] 'hermes-link.exe';[IO.File]::SetAttributes($link,([IO.File]::GetAttributes($link) -band (-bnot ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System))))`
    const j = run(f, 'all-paths', { compare: true, before })
    assert.equal(j.failed, false, JSON.stringify(j)); assert.equal(j.launchers.length, 141); assert.deepEqual(j.launchers, j.old)
    assert.ok(j.peak <= 2); assert.ok(j.pending <= 2); assert.equal(j.calls, 140)
    for (const row of j.launchers) { if (row.fingerprint.kind === 'file') assert.equal(row.sha256, digest(fs.readFileSync(row.path))) }
    const rp = j.launchers.find(x => x.path.toLowerCase() === link.toLowerCase()); assert.equal(rp.fingerprint.kind, 'reparse'); assert.equal(rp.sha256, null)
    assert.equal(j.launchers.filter(x => path.basename(path.dirname(x.path)) === '069').length, 2)
  } finally { f.dispose() }
})

test('真实8.3父路径输入须与provider FullName同口径；mtime/link控制与typed reparse不丢目标', windows, async t => {
  // 只创建本测试自有目录；GetShortPathName只读，不启用8.3、不改系统或用户配置。
  const parent = fs.realpathSync.native(path.join(process.env.LOCALAPPDATA, 'Temp'))
  const root = fs.mkdtempSync(path.join(parent, 'clawpanel io alias '))
  try {
    const input = Buffer.from(root).toString('base64')
    const code = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);Add-Type -TypeDefinition 'using System.Text;using System.Runtime.InteropServices;public static class OwnedShortPath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathName(string p,StringBuilder b,uint n);}';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'));$b=New-Object Text.StringBuilder 32768;$n=[OwnedShortPath]::GetShortPathName($p,$b,32768);if(!$n -or $n -ge 32768){throw 'owned short path query failed'};[Console]::Write($b.ToString())`
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0, r.stderr)
    const short = r.stdout, canonical = fs.realpathSync.native(short)
    assert.notEqual(short.toLowerCase(), canonical.toLowerCase(), '必须是真实8.3别名，不用fake路径或skip替代此边界')
    assert.equal(canonical, root)
    const observed = { short, legacy: fs.realpathSync(short), native: canonical, providerPaths: [] }
    for (const mode of ['none', 'mutate', 'swap', 'postswap', 'reparse']) {
      await t.test(mode, () => {
        const f = fixture(1, short)
        try {
          const target = path.join(f.dir, 'owned-target.bin'); fs.writeFileSync(target, 'owned-target')
          let link
          if (mode === 'swap' || mode === 'postswap' || mode === 'reparse') {
            link = path.join(f.dir, mode === 'reparse' ? 'paths/000/hermes-link.exe' : 'prepared-link.tmp')
            fs.symlinkSync(target, link, 'file'); f.links.push(link)
            if (mode !== 'reparse') f.links.push(path.join(f.dirs[0], 'node-c.exe'))
          }
          const before = mode === 'reparse' ? `$link=Join-Path $v.dirs[0] 'hermes-link.exe';[IO.File]::SetAttributes($link,([IO.File]::GetAttributes($link) -band (-bnot ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System))))` : ''
          const j = run(f, 'short-alias-' + mode, { mode, compare: mode === 'none' || mode === 'reparse', before })
          if (mode === 'none' || mode === 'reparse') {
            assert.equal(j.failed, false, JSON.stringify(j)); assert.deepEqual(j.launchers, j.old)
            for (const row of j.launchers) {
              observed.providerPaths.push(row.path)
              assert.equal(path.dirname(row.path), f.dirs[0], JSON.stringify({ ...observed, inputDirectory: f.dirs[0], providerPath: row.path }))
            }
            if (mode === 'reparse') {
              const row = j.launchers.find(x => x.path.toLowerCase() === link.toLowerCase())
              assert.ok(row, JSON.stringify({ link, rows: j.launchers })); assert.equal(row.fingerprint.kind, 'reparse'); assert.equal(row.sha256, null)
            }
          } else {
            assert.equal(j.swapped, true, JSON.stringify(j)); assert.equal(j.failed, true, JSON.stringify(j)); assert.equal(j.launchers, undefined)
          }
        } finally { f.dispose() }
      })
    }
    fs.writeFileSync(path.join(out, 'short-alias-contract.json'), JSON.stringify(observed, null, 2))
    t.diagnostic(JSON.stringify(observed))
  } finally {
    assert.equal(path.dirname(fs.realpathSync.native(root)), parent); fs.rmSync(root, { recursive: true, force: true })
  }
})
