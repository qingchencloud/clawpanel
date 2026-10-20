import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { hostSnapshot, windowsPathFingerprintSource } from '../scripts/test-hermes-windows-qualification.mjs'

// 先验证晚出现的大文件调度；只读自有文件，不执行真实宿主扫描或安装。
const out = process.env.HERMES_PRIORITY_EVIDENCE
let generated
new Function('ps', 'windowsPathFingerprintSource', 'Buffer', 'digest', 'process', `return (${hostSnapshot.toString()})`)(s => { generated = s; return {} }, windowsPathFingerprintSource, Buffer, () => '', { env: {} })({ actualProfile: 'owned-priority-fixture' })
const block = generated.split("Write-ClawPanelHostPhase 'launchers'\n")[1]?.split("\nWrite-ClawPanelHostPhase 'execution-policy'")[0]
assert.ok(block)
const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase()

test('晚出现的最大自有文件须在前两个完整literal hash中开始，结果原顺序且两路上限不变', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const parent = fs.realpathSync.native(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(parent, 'cp-hash-priority-'))
  t.after(() => {
    const real = fs.realpathSync.native(dir)
    assert.equal(path.dirname(real), parent)
    assert.ok(path.basename(real).startsWith('cp-hash-priority-'))
    fs.rmSync(real, { recursive: true, force: true })
  })
  const home = path.join(dir, 'h'); fs.mkdirSync(home)
  const dirs = [], files = [], originals = []
  for (const [i, length] of [65537, 65538, 4 * 1024 * 1024, 23].entries()) {
    const p = path.join(dir, 'paths', String(i).padStart(3, '0')); fs.mkdirSync(p, { recursive: true }); dirs.push(p)
    const file = path.join(p, 'node.exe'), data = Buffer.alloc(length, i + 1)
    fs.writeFileSync(file, data); files.push(file)
    const s = fs.statSync(file, { bigint: true })
    originals.push({ path: file, bytes: length, sha256: hash(data), mtimeNs: String(s.mtimeNs), inode: String(s.ino) })
  }
  const input = Buffer.from(JSON.stringify({ home, dirs, largest: files[2] })).toString('base64')
  const control = String.raw`Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
public static class PriorityControl {
  public static string Largest;
  public static int Active,Peak;
  public static Stopwatch Clock=Stopwatch.StartNew();
  public static List<string> Starts=new List<string>();
  public static List<long> StartTimes=new List<long>();
  public static List<long> EndTimes=new List<long>();
  public static void Enter(string p) {
    lock(Starts){Starts.Add(p);StartTimes.Add(Clock.ElapsedMilliseconds);int n=++Active;if(n>Peak)Peak=n;}
    Thread.Sleep(p==Largest?1600:(new FileInfo(p).Length>100?600:0));
  }
  public static void Leave(){lock(Starts){EndTimes.Add(Clock.ElapsedMilliseconds);Active--;}}
}
'@`
  let helper = windowsPathFingerprintSource()
  const literal = '$sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash'
  assert.equal(helper.split(literal).length, 2)
  helper = helper.replace(literal, `try{[PriorityControl]::Enter($p);${literal}}finally{[PriorityControl]::Leave()}`)
  const utf8Hash = generated.match(/^function Get-ClawPanelUtf8Sha256.*$/m)[0]
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n${control}\n${utf8Hash}\n${helper}\n$v=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')));$real=$v.home;$env:PATH=$v.dirs -join ';';[PriorityControl]::Largest=$v.largest;$hostClock=[Diagnostics.Stopwatch]::StartNew()\n${block}\n@{rows=@($launchers);starts=@([PriorityControl]::Starts);started=@([PriorityControl]::StartTimes);ended=@([PriorityControl]::EndTimes);peak=[PriorityControl]::Peak;active=[PriorityControl]::Active;poolState=$hw.p.RunspacePoolStateInfo.State.ToString()}|ConvertTo-Json -Depth 12 -Compress`
  const file = path.join(dir, 'fixture.ps1'); fs.writeFileSync(file, script)
  const loader = `& ([scriptblock]::Create([IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}')))))`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  const proof = { scope: 'controlled-delay own-file E2E, not cold VM qualification', node: process.version, status: r.status, error: r.error?.code, stdout: r.stdout, stderr: r.stderr, originals }
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'priority.json'), JSON.stringify(proof, null, 2)) }
  assert.equal(r.status, 0, JSON.stringify(proof))
  const j = JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
  assert.equal(j.active, 0); assert.equal(j.poolState, 'Closed'); assert.equal(j.peak, 2)
  assert.deepEqual(j.rows.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })), originals.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))
  for (const expected of originals) {
    const s = fs.statSync(expected.path, { bigint: true })
    assert.equal(hash(fs.readFileSync(expected.path)), expected.sha256)
    assert.equal(String(s.mtimeNs), expected.mtimeNs); assert.equal(String(s.ino), expected.inode)
  }
  assert.ok(j.starts.slice(0, 2).includes(files[2]), `LATE_LARGEST_HASH: ${JSON.stringify({ starts: j.starts, started: j.started, ended: j.ended })}`)
})
