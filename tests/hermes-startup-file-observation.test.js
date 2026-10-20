import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const load = () => import('../scripts/hermes-startup-diagnostic.mjs')
function fixture(t) {
  const base = fs.realpathSync.native(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-file-observer-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(dir)), base); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, file: path.join(dir, 'gateway-run.log') }
}
test('真实数字 stderr FD 保留原字节与 exit7；运行中旁读 phase（读取UTC不是发射UTC）', { timeout: 7000 }, async t => {
  const { startHermesFilePhaseObservation } = await load(), { file } = fixture(t), fd = fs.openSync(file, 'wx'), rows = []
  const script = String.raw`process.stderr.write('import time: '+ 'x'.repeat(180000)+'\n');process.stderr.write('CLAWPANEL_HERMES_PHASE {"sequence":1}\n');process.send('ready');process.on('message',()=>process.exit(7));setTimeout(()=>process.exit(78),5000).unref()`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', fd, 'ipc'], windowsHide: true })
  t.after(() => { if (child.exitCode === null) child.kill(); fs.closeSync(fd) })
  const stop = startHermesFilePhaseObservation({ fs, path, file, receive: bytes => rows.push({ line: Buffer.from(bytes).toString(), readAt: Date.now(), childStillAlive: child.exitCode === null }) })
  child.once('close', stop)
  await new Promise(resolve => child.once('message', resolve))
  for (let n = 0; n < 100 && !rows.length; n++) await new Promise(r => setTimeout(r, 10))
  assert.equal(child.stderr, null); assert.equal(rows.length, 1); assert.equal(rows[0].childStillAlive, true)
  assert.equal(rows[0].line, 'CLAWPANEL_HERMES_PHASE {"sequence":1}\n'); assert.ok(Number.isFinite(rows[0].readAt))
  const closed = new Promise(resolve => child.once('close', resolve)); child.send('done'); assert.equal(await closed, 7)
  assert.equal(fs.readFileSync(file, 'utf8'), 'import time: ' + 'x'.repeat(180000) + '\nCLAWPANEL_HERMES_PHASE {"sequence":1}\n')
})
test('链接文件不读取，提前 stop 幂等且没有修改原日志', { timeout: 7000 }, async t => {
  const { startHermesFilePhaseObservation } = await load(), { dir, file } = fixture(t), target = path.join(dir, 'target')
  fs.writeFileSync(target, 'CLAWPANEL_HERMES_PHASE {}\n'); fs.symlinkSync(target, file)
  const rows = [], stop = startHermesFilePhaseObservation({ fs, path, file, receive: b => rows.push(b) }); stop(); stop()
  assert.deepEqual(rows, []); assert.equal(fs.readFileSync(target, 'utf8'), 'CLAWPANEL_HERMES_PHASE {}\n')
})
test('观察写入失败不抛向应用，长行丢弃后继续限定 phase', { timeout: 7000 }, async t => {
  const { startHermesFilePhaseObservation } = await load(), { file } = fixture(t)
  fs.writeFileSync(file, 'x'.repeat(5000) + '\nCLAWPANEL_HERMES_PHASE {}\n')
  let called = 0
  const stop = startHermesFilePhaseObservation({ fs, path, file, receive: () => { called++; throw Error('fixture observation write failed') } })
  await new Promise(r => setTimeout(r, 150)); stop(); assert.equal(called, 1)
})
