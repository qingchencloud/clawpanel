// 先固定失败契约；只执行隔离 Git/文件/API fixture，不运行安装器、driver 或 native GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as driverHelper from '../scripts/test-weixin-windows-qualification.mjs'

const workflow = fs.readFileSync(new URL('../.github/workflows/hermes-qualification.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const helperSource = fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url), 'utf8')
const helperPath = 'scripts/test-weixin-windows-qualification.mjs'
const hash = b => crypto.createHash('sha256').update(b).digest('hex')

test('真实微软driver品牌名变更仍绑定原四段版本，未知来源或版本不匹配保持失败', async () => {
  const code = inline().match(/const edgeVersion=await run\(edge,\['--version'\]\);assert\.equal\(driverHelper\.parseMicrosoftEdgeDriverVersion\(edgeVersion\),runtime\.version\);/)?.[0]
  assert.ok(code, '实际native builder必须调用已审查的共享版本解析器')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const check = new AsyncFunction('run', 'edge', 'driverHelper', 'runtime', 'assert', code)
  for (const output of ['MSEdgeDriver 154.0.4258.62 (build)', 'Microsoft Edge WebDriver 154.0.4258.62 (49f7c5590dad654f33b924537ccc8be227c5a43a)']) {
    const run = async (file, args) => { assert.equal(file, 'owned-driver'); assert.deepEqual(args, ['--version']); return output }
    await check(run, 'owned-driver', driverHelper, { version: '154.0.4258.62' }, assert)
    await assert.rejects(() => check(run, 'owned-driver', driverHelper, { version: '154.0.4258.63' }, assert))
  }
  await assert.rejects(() => check(async () => 'UnknownDriver 154.0.4258.62', 'owned-driver', driverHelper, { version: '154.0.4258.62' }, assert))
})

function inline() {
  const step = workflow.split('        id: native_build\n')[1]
  assert.ok(step, '缺少 native_build')
  const body = step.match(/^          @'\r?\n([\s\S]*?)^          '@ \| node --input-type=module/m)?.[1]
  assert.ok(body, '缺少实际内联 JS')
  return body.replace(/^          /gm, '')
}
function loadFunction(name, signals = AbortSignal) {
  const code = inline().match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))?.[0]
  assert.ok(code, '缺少实际内联函数 ' + name)
  return new Function('fs', 'path', 'assert', 'crypto', 'spawnSync', 'hash', 'AbortSignal', code + '\nreturn ' + name)(fs, path, assert, crypto, spawnSync, file => hash(fs.readFileSync(file)), signals)
}
function fixture(fn) {
  // physical temp 消除 macOS /var 别名；只清理本轮独占目录。
  const base = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-driver-workflow-'))
  try { return fn(root) } finally {
    const relative = path.relative(base, fs.realpathSync.native(root))
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    fs.rmSync(root, { recursive: true, force: true })
  }
}
function git(root, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') }
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function checkout(root) {
  git(root, ['init', '--quiet'])
  git(root, ['config', 'core.autocrlf', 'false'])
  fs.mkdirSync(path.join(root, 'scripts'))
  const file = path.join(root, helperPath)
  fs.writeFileSync(file, 'export const fixtureOnly = true\n')
  git(root, ['add', '--', helperPath])
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'isolated tooling fixture'])
  return { file, sha: git(root, ['rev-parse', 'HEAD']) }
}

test('实际内联 JS 经 Node module parser，不执行任何安装/native 代码', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: inline(), encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
})
test('固定 CLI ABI：不得执行 tauri-driver --version，Cargo 精确版本安装保持', () => {
  const code = inline()
  assert.equal(/run\(driver,\s*\['--version'\]\)/.test(code), false, '真实 2.1.0 --version 已退出1，不能再调用')
  assert.equal(code.includes("tauriVersion,'tauri-driver 2.1.0'"), false)
  assert.match(code, /\['install',\s*'tauri-driver',\s*'--version',\s*'2\.1\.0',\s*'--locked'/)
  assert.match(code, /runCommand\(driver,\['--help'\]\)/)
})
test('共享真实导出 API，metadata 不再另写弱化下载路径，先验证 Git bytes 再 import', () => {
  for (const name of ['readPinnedTauriDriverMetadata', 'parseTauriDriverInstallReceipt', 'validateTauriDriverHelp']) assert.equal(typeof driverHelper[name], 'function')
  for (const match of helperSource.matchAll(/^import .*?from ['"]([^'"]+)['"]/gm)) assert.ok(match[1].startsWith('node:'), '共享 helper 顶层依赖不是 builtin')
  const code = inline()
  assert.match(code, /driverHelper\.readPinnedTauriDriverMetadata\(/)
  assert.equal(code.includes('response=await fetch(metadataUrl'), false)
  const before = code.indexOf('before:builderHelperBinding('), imported = code.indexOf('driverHelper=await import(')
  assert.ok(before >= 0 && imported > before, '共享模块在可信 Git bytes 验证之前执行')
  assert.match(code, /report\.builderHelper\.after=builderHelperBinding\(/)
  assert.match(code, /assert\.deepEqual\(report\.builderHelper\.after,report\.builderHelper\.before/)
})
test('metadata API fixture 保留官方 exactversion/checksum/UA，拒绝重定向和篡改', async () => {
  const checksum = '2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953'
  const fixtureFetch = version => async (url, options) => {
    assert.equal(url, 'https://crates.io/api/v1/crates/tauri-driver/2.1.0')
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
    assert.match(options.headers['User-Agent'], /ClawPanel.*https:\/\/github.com\/qingchencloud\/clawpanel/)
    assert.equal(options.headers.Accept, 'application/json')
    return new Response(JSON.stringify({ version }), { status: 200 })
  }
  const version = { crate: 'tauri-driver', num: '2.1.0', checksum, yanked: false }
  assert.deepEqual((await driverHelper.readPinnedTauriDriverMetadata(fixtureFetch(version))).version, version)
  for (const patch of [{ num: '2.1.1' }, { checksum: '0'.repeat(64) }, { yanked: true }, { crate: 'other' }]) await assert.rejects(driverHelper.readPinnedTauriDriverMetadata(fixtureFetch({ ...version, ...patch })))
  await assert.rejects(driverHelper.readPinnedTauriDriverMetadata(async () => new Response('', { status: 302 })))
})
test('共享 metadata 不扩大 Hermes 既有120秒预算，实际传入组合后的 signal', async () => {
  const deadlines = [], signals = { timeout: ms => { deadlines.push(ms); return AbortSignal.timeout(ms) }, any: AbortSignal.any.bind(AbortSignal) }
  const read = loadFunction('readPinnedMetadata', signals)
  const version = { crate: 'tauri-driver', num: '2.1.0', checksum: '2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953', yanked: false }
  const result = await read(driverHelper, async (url, options) => {
    assert.equal(url, 'https://crates.io/api/v1/crates/tauri-driver/2.1.0'); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify({ version }), { status: 200 })
  })
  assert.deepEqual(result.version, version); assert.deepEqual(deadlines, [120000])
})
test('builder helper 实际 Git blob/raw SHA1/byte SHA256 绑定及前后回读', () => fixture(root => {
  const { file, sha } = checkout(root), bind = loadFunction('builderHelperBinding'), before = bind(root, sha), bytes = fs.readFileSync(file)
  assert.equal(before.toolingSha, sha); assert.equal(before.path, helperPath); assert.equal(before.sha256, hash(bytes)); assert.equal(before.bytes, bytes.length)
  assert.equal(before.gitBlob, crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'))
  assert.deepEqual(bind(root, sha), before)
  fs.appendFileSync(file, '// late change\n')
  assert.throws(() => bind(root, sha), /Git blob|bytes|字节/)
}))
test('builder helper 错 SHA、非完整 SHA、缺文件及非普通文件都红', () => fixture(root => {
  const { file, sha } = checkout(root), bind = loadFunction('builderHelperBinding')
  assert.throws(() => bind(root, 'main')); assert.throws(() => bind(root, '0'.repeat(40)))
  fs.unlinkSync(file); assert.throws(() => bind(root, sha))
  fs.mkdirSync(file); assert.throws(() => bind(root, sha))
}))
test('builder helper 文件即使自行算出好 hash，若不属于 trusted commit 仍拒绝', () => fixture(root => {
  const { file, sha } = checkout(root), bind = loadFunction('builderHelperBinding')
  fs.writeFileSync(file, 'export const fixtureOnly = false\n')
  assert.match(hash(fs.readFileSync(file)), /^[a-f0-9]{64}$/)
  assert.throws(() => bind(root, sha))
}))
test('实际安装证据函数必须使用 shared parse/help、固定归档与3源码 pin、binary pre/post help', () => {
  const code = inline(), match = /const sourcePins=(\{[^\n]+\})/.exec(code)
  assert.ok(match, '缺少固定编译 source pin')
  const shared = /const TAURI_SOURCE_PINS=Object\.freeze\((\{[^\n]+\})\)/.exec(helperSource)
  assert.deepEqual(new Function('return ' + match[1])(), new Function('return ' + shared[1])())
  assert.match(code, /helpers\.parseTauriDriverInstallReceipt\(trackingRaw\)/)
  assert.match(code, /helpers\.validateTauriDriverHelp\(help\)/)
  assert.match(code, /assert\.equal\(crateArchive\.sha256,metadata\.version\.checksum\)/)
  assert.match(code, /assert\.equal\(hash\(driver\),binaryBefore/)
  assert.match(code, /version:installed\.version/)
  assert.match(code, /versionSource:'cargo-install-tracking'/)
  assert.match(code, /sha256AfterHelp:hash\(driver\)/)
})
test('安装证据 fixture：错误 receipt/归档必须在 help 执行前失败，不调用安装器', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hermes-driver-evidence-'))
  try {
    const driverRoot = path.join(root, 'driver'), cargoHome = path.join(root, 'cargo')
    fs.mkdirSync(path.join(driverRoot, 'bin'), { recursive: true }); fs.writeFileSync(path.join(driverRoot, 'bin/tauri-driver.exe'), 'not-an-executable-fixture')
    const inspect = loadFunction('installedTauriDriverEvidence'), tracking = path.join(driverRoot, '.crates2.json')
    let calls = 0
    const options = { driverRoot, cargoHome, metadata: { version: { checksum: '2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953' } }, installCommand: { code: 0 }, helpers: driverHelper, runCommand: () => { calls++; throw Error('fixture must never execute driver') } }
    fs.writeFileSync(tracking, '{}'); await assert.rejects(inspect(options)); assert.equal(calls, 0)
    const record = { version_req: '2.1.0', bins: ['tauri-driver.exe'], features: [], all_features: false, no_default_features: false, profile: 'release', target: 'x86_64-pc-windows-msvc', rustc: 'rustc 1.90.0 fixture' }
    fs.writeFileSync(tracking, JSON.stringify({ installs: { 'tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)': record } }))
    fs.mkdirSync(path.join(cargoHome, 'registry/cache/fixture'), { recursive: true }); fs.writeFileSync(path.join(cargoHome, 'registry/cache/fixture/tauri-driver-2.1.0.crate'), 'wrong archive')
    await assert.rejects(inspect(options)); assert.equal(calls, 0)
  } finally {
    assert.ok(path.basename(root).startsWith('hermes-driver-evidence-')); fs.rmSync(root, { recursive: true, force: true })
  }
})
test('builder receipt 保留驱动原件 hash 和 helper 前后绑定；旧预算/来源门禁不变', () => {
  const code = inline()
  assert.match(code, /report\.driverReceiptSha256=hash\(path\.join\(output,'driver-receipt\.json'\)\)/)
  assert.match(code, /report\.builderHelper=\{before:builderHelperBinding\(path\.resolve\('tooling'\),proof\.toolingSha\)/)
  assert.match(code, /builder helper.*report\.status='failed'/)
  assert.match(code, /\],1200000\)/); assert.match(code, /\],1800000\)/)
  assert.match(code, /validateRunnerProof\(proof\)/); assert.match(code, /assertHostUnchanged\(before,after\)/)
  assert.match(code, /assertSameSource\(root,web\.sourceHashes\)/); assert.match(code, /'--no-bundle', '--ci', '--', '--locked'/)
  assert.equal(/pass-native|passed-native/.test(code), false, 'builder 不得伪造原生 UI 成功')
  assert.match(workflow, /permissions:\s*\n\s*contents: read/)
})
