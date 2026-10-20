#!/usr/bin/env node
// 新应用/旧内核专用构建器；不复制 venv、不运行安装器，只接受同一次性 VM 的真实种子。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { actualRunnerProof, validateRunnerProof, hostSnapshot, assertHostUnchanged, isolationEnv, assertSameSource } from './test-hermes-windows-qualification.mjs'
import { assertNativeComplete } from './test-hermes-tauri-qualification.mjs'

const digest = b => crypto.createHash('sha256').update(b).digest('hex')
const hash = file => digest(fs.readFileSync(file))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const inside = (root, file) => { const r = path.relative(path.resolve(root), path.resolve(file)); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
function physical(file) {
  const root = path.resolve(file)
  for (let p = root;; p = path.dirname(p)) { if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), '拒绝链接祖先'); if (p === path.dirname(p)) break }
  return root
}
export const buildPlan = () => ({ installsKernel: false, copiesVenv: false, localExecution: false, seedSameVM: true, separateTargetDirectory: true })
export function buildArgs(argv) {
  const values = new Set(['--root', '--sha', '--seed-sha', '--web-output', '--native-output', '--output']), o = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; assert.ok(!Object.hasOwn(o, k), '重复参数')
    if (k === '--execute' || k === '--plan') o[k] = true
    else { assert.ok(values.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--'), '未知参数'); o[k] = argv[++i] }
  }
  for (const k of ['--sha', '--seed-sha']) if (o[k]) assert.match(o[k], /^[a-f0-9]{40}$/, 'SHA 必须精确')
  if (o['--sha'] && o['--seed-sha']) assert.notEqual(o['--sha'], o['--seed-sha'], '新应用不能冒用旧种子 SHA')
  assert.ok(!(o['--execute'] && o['--plan']), '模式互斥'); return o
}
function git(root, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr); return r.stdout
}
export function gitSourceManifest(root, sha) {
  physical(root); assert.match(sha, /^[a-f0-9]{40}$/)
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), sha)
  const files = {}, objects = {}
  // -z 禁用 Git 的中文/空格路径转义；直接用 blob SHA1 核验字节，不忽略行尾变化。
  for (const line of git(root, ['ls-tree', '-r', '-z', '--full-tree', sha]).split('\0').filter(Boolean)) {
    const match = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/); assert.ok(match, '拒绝 symlink/submodule Git mode')
    const [, , oid, name] = match, file = physical(path.join(root, name))
    assert.ok(inside(root, file) && fs.lstatSync(file).isFile(), '源码路径越界/非文件')
    const bytes = fs.readFileSync(file), actual = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(actual, oid, 'Git blob 字节漂移: ' + name)
    files[name] = digest(bytes); objects[name] = oid
  }
  assert.ok(Object.keys(files).length); assert.equal(git(root, ['status', '--porcelain', '--untracked-files=normal']).trim(), '', 'dirty source tree')
  return { sha, files, objects }
}
export function assertSeedIdentity(web, seedProof, actual, seedSha) {
  assert.equal(web.status, 'passed-web-native-missing'); assert.equal(web.candidateSha, seedSha); assert.equal(web.expectedVersion, '0.21.5')
  assert.equal(web.stages?.length, 5); assert.ok(web.stages.every(s => s.status === 'passed')); assert.equal(web.hostUnchanged, true)
  for (const key of ['sid', 'runId', 'attempt', 'workflowSha']) assert.equal(seedProof[key], actual[key], '种子不是同一次性 VM: ' + key)
}

export function bindCompatBuildArtifacts(root, manifest, app) {
  const file = physical(app); physical(manifest)
  assert.ok(inside(root, file) && fs.statSync(file).isFile(), '编译 EXE 越界/缺失')
  return { sourceManifestSha256: hash(manifest), application: { path: file, sha256: hash(file) } }
}

async function execute(o) {
  const proof = actualRunnerProof(); validateRunnerProof(proof)
  for (const k of ['--root', '--sha', '--seed-sha', '--web-output', '--native-output', '--output']) assert.ok(o[k], '缺参数 ' + k)
  const root = physical(o['--root']), output = physical(o['--output']), webOutput = physical(o['--web-output']), nativeOutput = physical(o['--native-output'])
  assert.ok(inside(physical(process.env.GITHUB_WORKSPACE), root) && inside(physical(process.env.RUNNER_TEMP), output) && !fs.existsSync(output))
  for (const p of [webOutput, nativeOutput]) assert.ok(inside(physical(process.env.RUNNER_TEMP), p))
  fs.mkdirSync(output)
  const r = { status: 'failed', candidateSha: o['--sha'], seedSha: o['--seed-sha'], scope: 'new-app build for existing old runtime; no kernel install', startedAt: new Date().toISOString(), commands: [] }
  const save = () => fs.writeFileSync(path.join(output, 'build-receipt.json'), JSON.stringify(r, null, 2))
  const pending = new Set(); let before, env, source, home, seedCommit
  save()
  async function run(program, args, timeout = 120000) {
    const index = r.commands.length, item = { program, args, startedAt: new Date().toISOString() }; r.commands.push(item); save()
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); pending.add(child); item.pid = child.pid
      let tail = ''; child.stdout.on('data', b => fs.appendFileSync(path.join(output, `command-${index}.stdout.log`), b)); child.stderr.on('data', b => { fs.appendFileSync(path.join(output, `command-${index}.stderr.log`), b); tail = (tail + b).slice(-8000) })
      const timer = setTimeout(() => { if (child.pid && child.exitCode === null && !child.signalCode) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); reject(Error('兼容构建超时')) }, timeout)
      child.once('error', e => { clearTimeout(timer); pending.delete(child); reject(e) })
      child.once('close', code => { clearTimeout(timer); pending.delete(child); Object.assign(item, { exitCode: code, finishedAt: new Date().toISOString() }); save(); resolve({ code, tail }) })
    })
    assert.equal(result.code, 0, result.tail)
  }
  try {
    const web = read(path.join(webOutput, 'report.json')), seedProof = read(path.join(webOutput, 'runner-proof.json')), oldNative = read(path.join(nativeOutput, 'report.json'))
    assertSeedIdentity(web, seedProof, proof, o['--seed-sha'])
    assert.equal(oldNative.status, 'passed-native-tauri'); assert.equal(oldNative.candidateSha, o['--seed-sha']); assert.equal(oldNative.expectedVersion, '0.21.5'); assertNativeComplete(oldNative)
    home = physical(path.join(webOutput, 'h')); assert.equal(path.resolve(web.environment.home), home)
    assert.ok(inside(webOutput, home) && fs.statSync(home).isDirectory())
    source = gitSourceManifest(root, o['--sha']); fs.writeFileSync(path.join(output, 'source-sha256.json'), JSON.stringify(source, null, 2))
    const text = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
    assert.match(text, /HERMES_STABLE_VERSION = '0\.22\.2'/); assert.match(text, /HERMES_STABLE_COMMIT = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'/)
    seedCommit = git(path.join(home, '.hermes/hermes-agent'), ['rev-parse', 'HEAD']).trim(); assert.equal(seedCommit, 'f97608f178d1ffeca59860195ab7da295f7c8e5f')
    r.source = source; r.runtimeHome = home; r.seedCommit = seedCommit; r.seedWebReportSha256 = hash(path.join(webOutput, 'report.json')); r.seedNativeReportSha256 = hash(path.join(nativeOutput, 'report.json'))
    before = hostSnapshot(proof); fs.writeFileSync(path.join(output, 'host-before.json'), JSON.stringify(before, null, 2))
    env = isolationEnv({ home, temp: path.join(output, 'tmp'), realProfile: proof.actualProfile }); fs.mkdirSync(env.TEMP, { recursive: true })
    for (const k of ['CARGO_HOME', 'RUSTUP_HOME', 'NATIVE_CARGO', 'NATIVE_TOOL_BIN']) {
      const p = physical(process.env[k]); assert.ok(inside(home, p), '编译工具越出种子 HOME: ' + k); env[k] = p
    }
    assert.equal(process.env.RUSTUP_TOOLCHAIN, 'stable-x86_64-pc-windows-msvc'); env.RUSTUP_TOOLCHAIN = process.env.RUSTUP_TOOLCHAIN
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (process.env[k]) env[k] = process.env[k]
    env.PATH = env.NATIVE_TOOL_BIN + ';' + path.dirname(process.execPath) + ';' + env.PATH
    // 不设置共享 CARGO_TARGET_DIR，不覆盖旧应用二进制或伪造旧应用回执。
    await run(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'ci'], 600000)
    await run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle', '--ci', '--', '--locked'], 1800000)
    assertSameSource(root, source.files); assert.equal(git(root, ['status', '--porcelain', '--untracked-files=normal']).trim(), '')
    const app = physical(path.join(root, 'src-tauri/target/release/clawpanel.exe')); assert.ok(inside(root, app) && fs.statSync(app).isFile())
    Object.assign(r, bindCompatBuildArtifacts(root, path.join(output, 'source-sha256.json'), app)); r.status = 'passed'
  } catch (e) { r.error = e.stack; process.exitCode = 1 }
  finally {
    for (const child of pending) if (child.pid && child.exitCode === null && !child.signalCode) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    for (let i = 0; pending.size && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 500))
    try {
      assert.equal(pending.size, 0, '编译子进程未退出')
      if (source) assertSameSource(root, source.files)
      if (seedCommit) assert.equal(git(path.join(home, '.hermes/hermes-agent'), ['rev-parse', 'HEAD']).trim(), seedCommit, '构建升级/替换了旧内核')
      if (before) { const after = hostSnapshot(proof); fs.writeFileSync(path.join(output, 'host-after.json'), JSON.stringify(after, null, 2)); assertHostUnchanged(before, after); r.hostUnchanged = true }
    } catch (e) { r.status = 'failed'; r.cleanupOrDriftError = e.stack; process.exitCode = 1 }
    r.finishedAt = new Date().toISOString(); save()
  }
  console.log(JSON.stringify({ status: r.status, sha: r.candidateSha, seedSha: r.seedSha, output }))
  return r.status === 'passed' ? 0 : 1
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const o = buildArgs(process.argv.slice(2)); if (o['--execute']) process.exitCode = await execute(o); else console.log(JSON.stringify(buildPlan())) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
