import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const entry = new URL('../scripts/test-hermes-compat-build.mjs', import.meta.url)
const load = () => import(entry)

test('兼容构建明确为新应用配旧种子，不安装内核或复制旧 venv', async () => {
  const m = await load()
  assert.deepEqual(m.buildPlan(), { installsKernel: false, copiesVenv: false, localExecution: false, seedSameVM: true, separateTargetDirectory: true })
  for (const args of [['--sha', 'main'], ['--seed-sha', 'a'.repeat(7)], ['--sha', 'a'.repeat(40), '--seed-sha', 'a'.repeat(40)], ['--force']]) assert.throws(() => m.buildArgs(args))
})

test('完整 Git blob 字节回读支持中文/空格，拒绝漂移和错误 commit', async () => {
  const m = await load(), base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-compat-build-'))
  const git = args => { const r = spawnSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  try {
    git(['init', '-q']); git(['config', 'core.autocrlf', 'false']); fs.writeFileSync(path.join(root, '中文 file.md'), '完整字节\n')
    git(['add', '.']); git(['-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', 'commit', '-qm', 'fixture'])
    const sha = git(['rev-parse', 'HEAD']), facts = m.gitSourceManifest(root, sha)
    assert.match(facts.files['中文 file.md'], /^[a-f0-9]{64}$/); assert.equal(facts.sha, sha)
    assert.throws(() => m.gitSourceManifest(root, '0'.repeat(40)))
    fs.appendFileSync(path.join(root, '中文 file.md'), '漂移')
    assert.throws(() => m.gitSourceManifest(root, sha), /blob|dirty|漂移/)
  } finally {
    const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('种子身份拒绝不同 VM/SID/run/版本或冒用候选 SHA', async () => {
  const m = await load(), sha = 'a'.repeat(40), proof = { sid: 'runner-test', runId: '123', attempt: '1', workflowSha: 'b'.repeat(40) }
  const web = { status: 'passed-web-native-missing', candidateSha: sha, expectedVersion: '0.21.5', stages: Array.from({ length: 5 }, () => ({ status: 'passed' })), hostUnchanged: true }
  assert.doesNotThrow(() => m.assertSeedIdentity(web, proof, proof, sha))
  for (const p of [{ sid: 'other' }, { runId: '456' }, { attempt: '2' }, { workflowSha: 'c'.repeat(40) }]) assert.throws(() => m.assertSeedIdentity(web, { ...proof, ...p }, proof, sha))
  for (const p of [{ candidateSha: 'd'.repeat(40) }, { expectedVersion: '0.22.2' }, { status: 'failed' }, { stages: [] }, { hostUnchanged: false }]) assert.throws(() => m.assertSeedIdentity({ ...web, ...p }, proof, proof, sha))
})

test('兼容构建回执必须绑定 manifest 本身和实际 EXE 字节', async () => {
  const m = await load(); assert.equal(typeof m.bindCompatBuildArtifacts, 'function')
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-compat-binding-'))
  try {
    const manifest = path.join(root, 'source-sha256.json'), app = path.join(root, 'clawpanel.exe')
    fs.writeFileSync(manifest, '{"sha":"fixture-only"}'); fs.writeFileSync(app, 'fixture-binary-not-real-app')
    const receipt = m.bindCompatBuildArtifacts(root, manifest, app)
    assert.match(receipt.sourceManifestSha256, /^[a-f0-9]{64}$/); assert.match(receipt.application.sha256, /^[a-f0-9]{64}$/)
    fs.appendFileSync(app, 'changed'); assert.notEqual(m.bindCompatBuildArtifacts(root, manifest, app).application.sha256, receipt.application.sha256)
    fs.appendFileSync(manifest, '\n'); assert.notEqual(m.bindCompatBuildArtifacts(root, manifest, app).sourceManifestSha256, receipt.sourceManifestSha256)
    assert.throws(() => m.bindCompatBuildArtifacts(path.join(root, 'other'), manifest, app))
  } finally { const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true }) }
})

test('本机 execute 在读取任何用户报告和构建前拒绝', async () => {
  await load()
  const r = spawnSync(process.execPath, [path.resolve(new URL(entry).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '--execute'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, timeout: 30000 })
  assert.equal(r.status, 1); assert.match(r.stderr, /资格|runner|一次性/)
})
