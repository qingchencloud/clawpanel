// 只执行 workflow 汇总脚本的私有文件 fixture；不运行安装器、driver 或宿主快照。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'
import { buildArgs } from '../scripts/test-hermes-compat-build.mjs'
import { nativeArgs } from '../scripts/test-hermes-tauri-qualification.mjs'
import { webCompatibilityArgs } from '../scripts/test-hermes-web-compatibility.mjs'
import { assertSameSource, assertHostUnchanged } from '../scripts/test-hermes-windows-qualification.mjs'

const file = new URL('../.github/workflows/hermes-qualification.yml', import.meta.url)
const workflow = () => YAML.parse(fs.readFileSync(file, 'utf8'))
const steps = () => workflow().jobs.qualify.steps
const step = id => { const s = steps().find(s => s.id === id); assert.ok(s, '缺 workflow step: ' + id); return s }
const oldSha = 'b'.repeat(40), newSha = 'a'.repeat(40), hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

test('失败清单：只有 old+both 且旧版 full native 成功才 checkout/build/run 兼容链', () => {
  const all = steps(), ids = ['native', 'compat_checkout', 'compat_build', 'web_compatibility', 'native_compatibility', 'native_summary']
  const positions = ids.map(id => all.indexOf(step(id)))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  for (const id of ids.slice(1, 5)) {
    const s = step(id)
    assert.match(s.if, /matrix\.variant == 'old'/); assert.match(s.if, /inputs\.target == 'both'/)
    assert.match(s.if, /steps\.native\.outcome == 'success'/)
    assert.doesNotMatch(s.if, /always|failure|cancelled/)
  }
  const checkout = step('compat_checkout')
  assert.match(checkout.uses, /^actions\/checkout@[a-f0-9]{40}$/)
  assert.equal(checkout.with.ref, '${{ inputs.candidate_sha }}'); assert.equal(checkout.with.path, 'candidate-compat')
  assert.equal(checkout.with['persist-credentials'], false)
})

test('新Web旧内核必须运行原CLI，复用相同seed/build且不重装工具', () => {
  const s = step('web_compatibility')
  assert.equal(s.shell, 'pwsh'); assert.equal(s.env.CANDIDATE_SHA, '${{ inputs.candidate_sha }}'); assert.equal(s.env.SEED_SHA, '${{ matrix.sha }}')
  const args = webCompatibilityArgs(commandArgs(s, 'test-hermes-web-compatibility.mjs'))
  assert.deepEqual(args, { '--execute': true, '--root': 'candidate-compat', '--sha': newSha, '--seed-sha': oldSha, '--web-output': 'C:/runner temp/hermes-qualification-old', '--build-output': 'C:/runner temp/hermes-native-build-old-runtime-compatibility', '--output': 'C:/runner temp/hermes-web-old-runtime-compatibility' })
  assert.doesNotMatch(s.run, /npm install|cargo|rustup|--hold|--force|continue-on-error/)
})

function commandArgs(s, script) {
  const line = s.run.split('\n').find(line => line.trim().startsWith('node tooling/scripts/' + script + ' '))
  assert.ok(line, '必须使用 trusted tooling CLI ' + script)
  const env = { CANDIDATE_SHA: newSha, SEED_SHA: oldSha, RUNNER_TEMP: 'C:/runner temp', GITHUB_WORKSPACE: 'C:/workspace', NATIVE_TAURI_ROOT: 'C:/private/tauri', NATIVE_EDGE_DRIVER: 'C:/private/edge.exe' }
  return line.trim().match(/"[^"]*"|\S+/g).slice(2).map(t => t.replace(/^"|"$/g, '').replace(/\$env:([A-Z_]+)/g, (_, k) => { assert.ok(env[k], k); return env[k] }))
}

test('失败清单：精确新/旧 SHA、旧 HOME、独立 EXE 和既有私有 drivers 必须全部接入真实 CLI', () => {
  const build = step('compat_build'), native = step('native_compatibility')
  for (const s of [build, native]) {
    assert.equal(s.shell, 'pwsh'); assert.equal(s.env.CANDIDATE_SHA, '${{ inputs.candidate_sha }}'); assert.equal(s.env.SEED_SHA, '${{ matrix.sha }}')
    assert.match(s.run, /exit \$LASTEXITCODE/); assert.doesNotMatch(s.run, /GITHUB_PATH|cargo install|rustup|--hold|--force|continue-on-error/)
  }
  const b = buildArgs(commandArgs(build, 'test-hermes-compat-build.mjs'))
  assert.deepEqual(b, { '--execute': true, '--root': 'candidate-compat', '--sha': newSha, '--seed-sha': oldSha, '--web-output': 'C:/runner temp/hermes-qualification-old', '--native-output': 'C:/runner temp/hermes-native-old', '--output': 'C:/runner temp/hermes-native-build-old-runtime-compatibility' })
  const n = nativeArgs(commandArgs(native, 'test-hermes-tauri-qualification.mjs'))
  assert.equal(n['--root'], 'candidate-compat'); assert.equal(n['--sha'], newSha); assert.equal(n['--seed-sha'], oldSha); assert.equal(n['--version'], '0.21.5')
  assert.equal(n['--web-output'], b['--web-output']); assert.equal(n['--output'], 'C:/runner temp/hermes-native-old-runtime-compatibility')
  assert.equal(n['--application'], 'C:/workspace/candidate-compat/src-tauri/target/release/clawpanel.exe')
  assert.equal(n['--driver'], 'C:/private/tauri/bin/tauri-driver.exe'); assert.equal(n['--native-driver'], 'C:/private/edge.exe')
})

// 本 fixture 只检验 workflow 是否调用完整门禁及绑定文件；native 门禁内部另由原 harness 测试负责。
function summaryFixture(t, target = 'both') {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-workflow-compat-')), temp = path.join(root, 'temp')
  t.after(() => { const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true }) })
  const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) }
  const at = (prefix, f) => path.join(temp, prefix, f), source = path.join(root, 'candidate-compat'), old = path.join(root, 'candidate')
  for (const dir of [source, old]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'fixture-source.js'), 'source bytes\n') }
  const files = { 'fixture-source.js': hash(path.join(source, 'fixture-source.js')) }
  const app = path.join(source, 'src-tauri/target/release/clawpanel.exe'), oldApp = path.join(old, 'clawpanel.exe')
  for (const f of [app, oldApp]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'fixture EXE bytes; not real application') }
  const native = { status: 'passed-native-tauri', candidateSha: oldSha, expectedVersion: '0.21.5', application: { path: oldApp, sha256: hash(oldApp) }, fixtureComplete: true, rounds: [{}, {}], nativeInstallerLifecycle: ['update', 'uninstall', 'reinstall'].map(name => ({ name, passed: true, dataPreserved: true })) }
  const web = { status: 'passed-web-native-missing', candidateSha: oldSha, expectedVersion: '0.21.5', environment: { source: old }, sourceHashes: files, distHashes: files }
  const build = { status: 'passed', candidateSha: newSha, seedSha: oldSha, hostUnchanged: true, seedCommit: 'f97608f178d1ffeca59860195ab7da295f7c8e5f', source: { sha: newSha, files }, application: { path: app, sha256: hash(app) } }
  const manifest = at('hermes-native-build-old-runtime-compatibility', 'source-sha256.json')
  write(manifest, build.source); build.sourceManifestSha256 = hash(manifest)
  write(at('hermes-qualification-old', 'report.json'), web); write(at('hermes-native-old', 'report.json'), native)
  build.seedWebReportSha256 = hash(at('hermes-qualification-old', 'report.json')); build.seedNativeReportSha256 = hash(at('hermes-native-old', 'report.json'))
  const buildFile = at('hermes-native-build-old-runtime-compatibility', 'build-receipt.json'); write(buildFile, build)
  const compatibility = { status: 'passed-native-old-runtime-compatibility', candidateSha: newSha, seedSha: oldSha, expectedVersion: '0.21.5', fixtureComplete: true, application: build.application, webQualification: { sha256: build.seedWebReportSha256 }, compatibility: { binding: { buildReceiptSha256: hash(buildFile), sourceManifestSha256: build.sourceManifestSha256, sourceHashes: files, application: build.application } } }
  write(at('hermes-native-old-runtime-compatibility', 'report.json'), compatibility)
  const webCompat = { status: 'passed-web-old-runtime-compatibility', candidateSha: newSha, seedSha: oldSha, runtimeVersion: '0.21.5', fixtureComplete: true, applicationSha256: build.application.sha256, sourceManifestSha256: build.sourceManifestSha256, seedWebReportSha256: build.seedWebReportSha256, seedNativeReportSha256: build.seedNativeReportSha256, buildReportSha256: hash(buildFile) }
  write(at('hermes-web-old-runtime-compatibility', 'report.json'), webCompat)
  write(at('hermes-native-build-old', 'build-receipt.json'), { status: 'passed', candidateSha: oldSha, application: native.application })
  for (const [p, names] of Object.entries({ 'hermes-qualification-old': ['host-before.json'], 'hermes-native-old': ['host-after.json'], 'hermes-native-build-old-runtime-compatibility': ['host-before.json', 'host-after.json'], 'hermes-native-old-runtime-compatibility': ['host-before.json', 'host-after.json'], 'hermes-web-old-runtime-compatibility': ['host-before.json', 'host-after.json'] })) for (const f of names) write(at(p, f), { registry: 'unchanged', parentEnvSha256: p })
  for (const f of ['test-hermes-tauri-qualification.mjs', 'test-hermes-windows-qualification.mjs', 'test-hermes-compat-build.mjs']) { const p = path.join(root, 'tooling/scripts', f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'trusted fixture tooling hash') }
  const calls = []
  function run() {
    const body = step('native_summary').run.match(/@'\r?\n([\s\S]*?)\r?\n'@/)[1].replace(/^import .*$/gm, '')
    const process = { env: { RUNNER_TEMP: temp, VARIANT: 'old', EXPECTED_VERSION: '0.21.5', CANDIDATE_SHA: oldSha, COMPAT_CANDIDATE_SHA: newSha, TARGET: target, GITHUB_WORKFLOW_SHA: 'c'.repeat(40) }, exitCode: 0 }
    const scopedFs = { ...fs, readFileSync: (f, ...args) => fs.readFileSync(path.isAbsolute(f) ? f : path.join(root, f), ...args) }
    const scopedPath = { ...path, resolve: (...p) => path.resolve(root, ...p) }
    const assertNativeComplete = r => { calls.push('full'); assert.equal(r.fixtureComplete, true) }
    const assertNativeCompatibilityComplete = r => { calls.push('compat'); assert.equal(r.fixtureComplete, true); assert.equal(r.status, 'passed-native-old-runtime-compatibility') }
    const assertWebCompatibilityComplete = r => { calls.push('web-compat'); assert.equal(r.fixtureComplete, true); assert.equal(r.status, 'passed-web-old-runtime-compatibility') }
    new Function('fs', 'path', 'assert', 'crypto', 'process', 'console', 'assertSameSource', 'assertHostUnchanged', 'assertNativeComplete', 'assertNativeCompatibilityComplete', 'assertWebCompatibilityComplete', body)(scopedFs, scopedPath, assert, crypto, process, { log() {} }, assertSameSource, assertHostUnchanged, assertNativeComplete, assertNativeCompatibilityComplete, assertWebCompatibilityComplete)
    return { code: process.exitCode, report: JSON.parse(fs.readFileSync(at('hermes-summary-old', 'qualification-summary.json'))), calls }
  }
  return { root, source, at, write, build, compatibility, run }
}

test('both 旧 job 汇总必须调用兼容完整门禁，并绑定独立 build/source/EXE 与 host 证据', t => {
  assert.equal(step('native_summary').env.TARGET, '${{ inputs.target }}')
  assert.equal(step('native_summary').env.COMPAT_CANDIDATE_SHA, '${{ inputs.candidate_sha }}')
  const f = summaryFixture(t), r = f.run()
  assert.equal(r.code, 0, r.report.error); assert.ok(r.calls.includes('compat')); assert.ok(r.calls.includes('web-compat')); assert.equal(r.report.nativeCompatibility.status, 'passed-native-old-runtime-compatibility')
  assert.equal(r.report.webCompatibility.status, 'passed-web-old-runtime-compatibility')
  for (const key of ['buildSha256', 'nativeSha256', 'sourceManifestSha256']) assert.match(r.report.nativeCompatibility.evidence[key], /^[a-f0-9]{64}$/)
})

for (const fault of ['missing-web', 'incomplete-web', 'web-source-sha', 'web-build-hash', 'web-host-drift']) {
  test('both旧job拒绝Web兼容缺口 ' + fault, t => {
    const f = summaryFixture(t), file = f.at('hermes-web-old-runtime-compatibility', 'report.json')
    const r = JSON.parse(fs.readFileSync(file))
    if (fault === 'missing-web') fs.unlinkSync(file)
    else if (fault === 'web-host-drift') f.write(f.at('hermes-web-old-runtime-compatibility', 'host-after.json'), { registry: 'mutated' })
    else { if (fault === 'incomplete-web') r.fixtureComplete = false; if (fault === 'web-source-sha') r.candidateSha = oldSha; if (fault === 'web-build-hash') r.buildReportSha256 = '0'.repeat(64); f.write(file, r) }
    const actual = f.run(); assert.equal(actual.code, 1); assert.equal(actual.report.status, 'failed')
  })
}

for (const fault of ['missing-native', 'missing-build', 'missing-manifest', 'incomplete-native', 'wrong-seed', 'wrong-new-sha', 'source-drift', 'exe-drift', 'manifest-drift', 'host-drift', 'missing-host']) {
  test('失败清单：both 旧 job 拒绝 ' + fault, t => {
    const f = summaryFixture(t), cf = f.at('hermes-native-old-runtime-compatibility', 'report.json'), bf = f.at('hermes-native-build-old-runtime-compatibility', 'build-receipt.json')
    if (fault === 'missing-native') fs.unlinkSync(cf)
    if (fault === 'missing-build') fs.unlinkSync(bf)
    if (fault === 'missing-manifest') fs.unlinkSync(f.at('hermes-native-build-old-runtime-compatibility', 'source-sha256.json'))
    if (fault === 'incomplete-native') f.write(cf, { ...f.compatibility, fixtureComplete: false })
    if (fault === 'wrong-seed') f.write(cf, { ...f.compatibility, seedSha: newSha })
    if (fault === 'wrong-new-sha') f.write(bf, { ...f.build, candidateSha: oldSha })
    if (fault === 'source-drift') fs.appendFileSync(path.join(f.source, 'fixture-source.js'), 'drift')
    if (fault === 'exe-drift') fs.appendFileSync(f.build.application.path, 'drift')
    if (fault === 'manifest-drift') fs.appendFileSync(f.at('hermes-native-build-old-runtime-compatibility', 'source-sha256.json'), '\n')
    if (fault === 'host-drift') f.write(f.at('hermes-native-old-runtime-compatibility', 'host-after.json'), { registry: 'changed' })
    if (fault === 'missing-host') fs.unlinkSync(f.at('hermes-native-build-old-runtime-compatibility', 'host-before.json'))
    const r = f.run(); assert.equal(r.code, 1, '缺失/漂移不得沿用旧 full native 绿灯'); assert.equal(r.report.status, 'failed')
  })
}

test('baseline-only 汇总显式 not-run，既有 full native 通过不伪装兼容绿灯', t => {
  const f = summaryFixture(t, 'baseline'); fs.unlinkSync(f.at('hermes-native-old-runtime-compatibility', 'report.json'))
  const r = f.run(); assert.equal(r.code, 0, r.report.error); assert.equal(r.report.nativeCompatibility.status, 'not-run'); assert.equal(r.report.nativeCompatibility.required, false); assert.deepEqual(r.calls, ['full'])
})

test('兼容 build/native 两根只经过原 publishEvidence，artifact 仍仅 public 副本', () => {
  const s = steps().find(s => s.run?.includes('await publishEvidence({roots'))
  assert.ok(s); assert.equal(s.if, 'always()')
  assert.match(s.run, /'compat-build':'hermes-native-build-old-runtime-compatibility'/)
  assert.match(s.run, /'compat-native':'hermes-native-old-runtime-compatibility'/)
  for (const s of steps().filter(s => s.uses?.startsWith('actions/upload-artifact@'))) assert.match(s.with.path, /\/hermes-public-\$\{\{ matrix\.variant \}\}\/$/)
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /continue-on-error|GITHUB_PATH|contents: write|path:.*candidate-compat\/.*(?:target|\.hermes)/)
})
