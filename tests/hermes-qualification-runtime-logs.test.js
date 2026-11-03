import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

test('实际运行日志限界留证：已知文件、前后stop分开、尾部上限及原缺失显式记录', async () => {
  const q = await import('../scripts/test-hermes-windows-qualification.mjs')
  assert.equal(typeof q.captureHermesRuntimeLogs, 'function')
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-runtime-log-'))
  try {
    const home = path.join(root, 'h'), output = path.join(root, 'evidence')
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true }); fs.mkdirSync(output)
    const file = path.join(home, '.hermes/gateway-run.log')
    fs.writeFileSync(file, 'original startup failure\n')
    fs.writeFileSync(path.join(home, '.hermes/unrelated-data.txt'), 'DO NOT COLLECT')
    const before = q.captureHermesRuntimeLogs(home, output, 'before-stop')
    const row = before.find(r => r.sourceRelative === 'gateway-run.log')
    assert.ok(row && !row.missing && !row.truncated); assert.equal(row.totalBytes, 25)
    assert.equal(fs.readFileSync(path.join(output, row.file), 'utf8'), 'original startup failure\n')
    assert.equal(row.sha256, crypto.createHash('sha256').update('original startup failure\n').digest('hex'))
    assert.ok(before.some(r => r.missing)); assert.ok(!before.some(r => r.sourceRelative === 'unrelated-data.txt'))
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024) + 'EXPECTED_TAIL')
    const after = q.captureHermesRuntimeLogs(home, output, 'after-stop'), last = after.find(r => r.sourceRelative === 'gateway-run.log')
    assert.ok(last.truncated); assert.equal(last.capturedBytes, 1024 * 1024); assert.equal(last.totalBytes, 2 * 1024 * 1024 + 13)
    assert.ok(fs.readFileSync(path.join(output, last.file), 'utf8').endsWith('EXPECTED_TAIL'))
    assert.notEqual(row.file, last.file); assert.equal(fs.readFileSync(path.join(output, row.file), 'utf8'), 'original startup failure\n')
    assert.throws(() => q.captureHermesRuntimeLogs(home, output, '../outside'))
    const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
    assert.match(source, /captureHermesRuntimeLogs\(home, output, 'before-stop'\)/)
    assert.match(source, /captureHermesRuntimeLogs\(home, output, 'after-stop'\)/)
  } finally {
    const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true })
  }
})
