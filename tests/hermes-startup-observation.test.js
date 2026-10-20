import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { spawnAuditSource } from '../scripts/test-hermes-windows-qualification.mjs'

// 只观察自己创建的有界子进程，不安装内核、不碰 registry 或用户桌面。
async function observe(t, { enabled = '1', malformed = false, count = 1, oversized = false, writeFailure = false, reordered = false } = {}) {
  const base = fs.realpathSync.native(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-startup-observation-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(dir)), base); fs.rmSync(dir, { recursive: true, force: true }) })
  const log = path.join(dir, 'audit.jsonl'), preload = path.join(dir, 'observer.mjs'), child = path.join(dir, 'child.cjs'), worker = path.join(dir, 'worker.mjs')
  fs.writeFileSync(preload, spawnAuditSource(log))
  fs.writeFileSync(child, `
const good = n => ({schemaVersion:1,scope:'launch',phase:n===1?'entry':'main_b',pid:process.pid,ppid:process.ppid,sequence:n,elapsedMs:n,deltaMs:1});
let lines=['vendor-original-中文'];
if(${malformed}) {
 for(const bad of [{...good(1),secret:'fixture-private-canary'}, {...good(1),phase:'path-or-dynamic-label'}, {...good(1),pid:-1}, {...good(1),deltaMs:-1}, {...good(1),elapsedMs:Infinity}, {...good(1),scope:'unknown'}, {...good(1),sequence:0}, {...good(1),schemaVersion:2}]) lines.push('CLAWPANEL_HERMES_PHASE '+JSON.stringify(bad));
 lines.push('CLAWPANEL_HERMES_PHASE {not-json}');
}
if(${oversized}) lines.push('CLAWPANEL_HERMES_PHASE '+ 'x'.repeat(12000));
for(const n of (${reordered} ? [1,3,2,4] : Array.from({length:${count}},(_,i)=>i+1))) lines.push('CLAWPANEL_HERMES_PHASE '+JSON.stringify(good(n)));
const text=lines.join('\\r\\n')+'\\r\\n';
process.stdout.write('original-stdout');
const bytes=Buffer.from(text),cut=bytes.indexOf(Buffer.from('中'))+1;
process.stderr.write(bytes.subarray(0,cut));
setTimeout(()=>{for(let offset=cut;offset<bytes.length;offset+=17)process.stderr.write(bytes.subarray(offset,offset+17));process.send({event:'ready',text})},40);
process.on('message',()=>process.exit(7));
setTimeout(()=>process.exit(79),5000).unref();
`)
  fs.writeFileSync(worker, `
import fs from 'node:fs';import {spawn} from 'node:child_process';
const append=fs.appendFileSync;
if(${writeFailure}) fs.appendFileSync=function(file,data,...args){if(String(data).includes('"event":"hermes-phase"')) throw Error('fixture-phase-write-failure');return Reflect.apply(append,this,[file,data,...args])};
const c=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:['ignore','pipe','pipe','ipc']});
let out=[],err=[];c.stdout.on('data',d=>out.push(d));c.stderr.on('data',d=>err.push(d));
let readback=null;
c.on('message',async message=>{if(message.event!=='ready')return;const end=Date.now()+1200;let rows=[];do{rows=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(s=>JSON.parse(s));if(rows.some(r=>r.event==='hermes-phase')||${JSON.stringify(enabled !== '1' || writeFailure)})break;await new Promise(r=>setTimeout(r,10))}while(Date.now()<end);readback={beforeClose:rows.every(r=>r.event!=='close'),phaseBeforeClose:rows.some(r=>r.event==='hermes-phase'),childStillAlive:c.exitCode===null,expectedStderr:message.text};c.send('done')});
c.on('close',code=>console.log(JSON.stringify({code,out:Buffer.concat(out).toString('utf8'),err:Buffer.concat(err).toString('utf8'),readback})));c.on('error',()=>process.exitCode=91);
`)
  const env = { ...process.env }; delete env.CLAWPANEL_HERMES_PHASE_TIMING
  if (enabled !== undefined) env.CLAWPANEL_HERMES_PHASE_TIMING = enabled
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, worker], { env, encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout.trim()), receipts = fs.readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s))
  assert.equal(result.code, 7); assert.equal(result.out, 'original-stdout'); assert.equal(result.err, result.readback.expectedStderr)
  const lifecycle = receipts.filter(r => r.event === 'start' || r.event === 'close')
  assert.equal(lifecycle.length, 2); assert.equal(lifecycle[1].exitCode, 7); assert.equal(lifecycle[0].pid, lifecycle[1].pid)
  assert.equal(lifecycle[1].stdout, result.out); assert.equal(lifecycle[1].stderr, result.readback.expectedStderr)
  assert.equal(result.readback.beforeClose, true); assert.equal(result.readback.childStillAlive, true)
  return { result, phases: receipts.filter(r => r.event === 'hermes-phase'), childPid: lifecycle[0].pid }
}

test('实际stderr分片/UTF8/CRLF：phase在子进程关闭前有UTC锚点，原输出/非零退出不变', async t => {
  const { result, phases, childPid } = await observe(t)
  assert.equal(result.readback.phaseBeforeClose, true)
  assert.equal(phases.length, 1)
  const record = phases[0]
  assert.deepEqual(Object.keys(record).sort(), ['event', 'childPid', 'observerPid', 'observedAt', 'spawnElapsedMs', 'phase'].sort())
  assert.equal(record.childPid, childPid); assert.equal(record.phase.pid, childPid); assert.ok(record.observerPid > 0)
  assert.ok(Number.isFinite(Date.parse(record.observedAt))); assert.ok(record.spawnElapsedMs >= 0 && record.spawnElapsedMs < 5000)
  assert.equal(record.phase.phase, 'entry'); assert.equal(record.phase.sequence, 1)
})

test('未知字段/动态label/负数/非有限/错误scope/schema不写派生phase，不阻断后续正确记录', async t => {
  const { phases } = await observe(t, { malformed: true })
  assert.equal(phases.length, 1); assert.equal(phases[0].phase.phase, 'entry')
  assert.doesNotMatch(JSON.stringify(phases), /fixture-private-canary|secret|args|program|HOME/)
})

test('派生phase每child最多64条，后续原stderr与退出仍完整', async t => {
  const { phases } = await observe(t, { count: 100 })
  assert.equal(phases.length, 64)
  assert.deepEqual(phases.map(r => r.phase.sequence), Array.from({ length: 64 }, (_, i) => i + 1))
  assert.ok(phases.every((r, i) => i === 0 || r.spawnElapsedMs >= phases[i - 1].spawnElapsedMs))
})

test('超长单行丢弃后恢复行边界，不从截断尾巴猜JSON', async t => {
  const { phases } = await observe(t, { oversized: true })
  assert.equal(phases.length, 1); assert.equal(phases[0].phase.phase, 'entry')
})

test('同一解释器倒序sequence不能污染阶段时间轴，后续正序继续观察', async t => {
  const { phases } = await observe(t, { reordered: true })
  assert.deepEqual(phases.map(r => r.phase.sequence), [1, 3, 4])
})

for (const enabled of ['0', 'true', '']) test(`未精确opt-in=${JSON.stringify(enabled)}时不额外观察phase`, async t => {
  const { phases } = await observe(t, { enabled })
  assert.deepEqual(phases, [])
})

test('新增派生记录写失败不改变原stderr、生命周期和非零退出', async t => {
  const { phases } = await observe(t, { writeFailure: true })
  assert.deepEqual(phases, [])
})
