import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const source = fs.readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs', import.meta.url), 'utf8')

test('真实 verifier 保留19基线，实际发运的 PM/PS wrapper均须纳入原字节快照', () => {
  const fn = source.match(/function collectCandidateSourceHashes\(project\) \{[^]*?\n\}/)?.[0]
  assert.ok(fn, '实际 verifier 缺可验证的完整快照入口')
  assert.match(source, /report.environment.candidateSourceHashes = collectCandidateSourceHashes\(project\)/)
  const collect = new Function('assert', 'fs', 'path', 'crypto', `${fn}; return collectCandidateSourceHashes`)(assert, fs, path, crypto)
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-source-inventory-'))
  const baseline = ['scripts/serve.js', 'scripts/dev-api.js', 'scripts/pi-models.js', 'scripts/opencode.js', 'scripts/opencode-proxy.js', 'scripts/deepseek-harness.js', 'scripts/deepseek-harness-auth.js', 'scripts/deepseek-harness-proxy.js', 'src/lib/opencode-storage-bridge.js', 'src/lib/openclaw-gateway-compat.js', 'src/lib/tauri-api.js', 'src/engines/opencode/pages/workspace.js', 'src/engines/opencode/pages/dashboard.js', 'src/engines/hermes/pages/chat.js', 'package.json', 'package-lock.json', 'openclaw-version-policy.json', 'Dockerfile', '.github/maintenance/Runtime.Dockerfile']
  try {
    for (const name of baseline) { const f = path.join(root, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, name) }
    assert.deepEqual(Object.keys(collect(root)), baseline)
    const optional = path.join(root, 'scripts/hermes-pm-runtime.js'); fs.writeFileSync(optional, 'exact PM bytes')
    const r = collect(root); assert.equal(Object.keys(r).length, 20); assert.equal(r['scripts/hermes-pm-runtime.js'], crypto.createHash('sha256').update('exact PM bytes').digest('hex'))
    fs.appendFileSync(optional, ' changed'); assert.notEqual(collect(root)['scripts/hermes-pm-runtime.js'], r['scripts/hermes-pm-runtime.js'])
    const wrapper = path.join(root, 'scripts/hermes-managed-install.ps1'); fs.writeFileSync(wrapper, 'exact PS wrapper bytes')
    const both = collect(root); assert.equal(Object.keys(both).length, 21)
    assert.equal(both['scripts/hermes-managed-install.ps1'], crypto.createHash('sha256').update('exact PS wrapper bytes').digest('hex'))
    fs.appendFileSync(wrapper, ' changed'); assert.notEqual(collect(root)['scripts/hermes-managed-install.ps1'], both['scripts/hermes-managed-install.ps1'])
    const linked = new Function('assert', 'fs', 'path', 'crypto', `${fn};return collectCandidateSourceHashes`)(assert, { ...fs, lstatSync: f => f === optional ? { isFile: () => false, isSymbolicLink: () => true } : fs.lstatSync(f) }, path, crypto)
    assert.throws(() => linked(root), /源码|链接|file|symbol/i)
    const linkedWrapper = new Function('assert', 'fs', 'path', 'crypto', `${fn};return collectCandidateSourceHashes`)(assert, { ...fs, lstatSync: f => f === wrapper ? { isFile: () => false, isSymbolicLink: () => true } : fs.lstatSync(f) }, path, crypto)
    assert.throws(() => linkedWrapper(root), /源码|链接|file|symbol/i)
    fs.unlinkSync(optional); assert.equal(Object.keys(collect(root)).length, 20, '旧内核PS wrapper和新PM互不冒充')
    fs.unlinkSync(path.join(root, baseline[0])); assert.throws(() => collect(root), /ENOENT|源码/)
  } finally { const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true }) }
})
