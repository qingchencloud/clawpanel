#!/usr/bin/env node
// 仅驱动一次性 Windows runner 的真实 ClawPanel WebView2；不修改产品插件或权限。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { qualifyHermesProfiles, assertScheduledTasksStable } from './hermes-qualification-profiles.mjs'
import { qualifyHermesProfileCollision, taskNamePythonSource } from './hermes-qualification-profile-collision.mjs'
import { validatePrivateCompletion, validateRunnerProof, classifyProviderRequest, matchesPinnedTitleRequest, qualificationProviderReply } from './test-hermes-windows-qualification.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const OLD_RUNTIME = { version: '0.21.5', commit: 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }
const NEW_APP_PIN = { version: '0.22.2', commit: 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' }
const COMPATIBILITY_MODE = 'new-app-old-runtime-native'
const COMPATIBILITY_STATUS = 'passed-native-old-runtime-compatibility'
const installerCommand = cmd => ['install_hermes', 'update_hermes', 'uninstall_hermes'].includes(cmd)
const nativePath = p => path.win32.isAbsolute(p) ? path.win32.resolve(p).toLowerCase() : path.resolve(p)
const TOOLING_FILES = ['scripts/test-hermes-tauri-qualification.mjs', 'scripts/test-hermes-windows-qualification.mjs', 'scripts/hermes-qualification-provider.mjs', 'scripts/hermes-qualification-profiles.mjs', 'scripts/hermes-qualification-profile-collision.mjs']
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const runtimePin = version => { const pin = [OLD_RUNTIME, NEW_APP_PIN].find(p => p.version === version); assert.ok(pin, '未知 profile runtime pin'); return pin }

export function readNativeToolingSnapshot({ root, sha }) {
  const git = args => { const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); assert.equal(r.status, 0, 'tooling Git 读取失败'); return r.stdout }
  assert.match(sha || '', /^[a-f0-9]{40}$/); assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), sha, 'tooling HEAD不是当前main工作流SHA')
  const files = {}
  for (const file of TOOLING_FILES) {
    const p = physical(path.join(root, file)); assert.ok(fs.statSync(p).isFile())
    const entry = git(['ls-tree', sha, '--', file]).toString().trim().match(/^100(?:644|755) blob ([a-f0-9]{40})\t/)
    assert.ok(entry, `tooling 文件未绑定Git blob ${file}`)
    const bytes = git(['show', `${sha}:${file}`])
    assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), entry[1])
    assert.equal(hash(p), sha256(bytes), `tooling 字节漂移 ${file}`); files[file] = { gitBlob: entry[1], sha256: sha256(bytes) }
  }
  return { sha, files }
}

function assertNativeTooling(r) {
  assert.equal(r.executionMode, 'actual-github-hosted-windows-vm-native', '非真实 native mode')
  validateRunnerProof(r.runner)
  const t = r.tooling; assert.equal(t?.scope, 'github-hosted-main-native-tooling'); assert.equal(t.sha, r.runner.toolingSha); assert.equal(t.sha, r.runner.workflowSha)
  for (const s of [t.before, t.after]) {
    assert.equal(s?.sha, t.sha); assert.deepEqual(Object.keys(s.files).sort(), [...TOOLING_FILES].sort())
    for (const value of Object.values(s.files)) { assert.ok(validHash(value.sha256)); assert.match(value.gitBlob || '', /^[a-f0-9]{40}$/) }
  }
  assert.deepEqual(t.after, t.before, '五个 native tooling helper pre/post 漂移')
  assert.equal(r.profileQualificationModuleSha256, t.before.files[TOOLING_FILES[3]].sha256)
  assert.equal(r.profileCollisionModuleSha256, t.before.files[TOOLING_FILES[4]].sha256)
}

function assertArtifactBinding(r, value, kind) {
  const b = value?.nativeBinding, pin = runtimePin(r.expectedVersion)
  assert.equal(b?.scope, 'actual-native-profile-artifact'); assert.equal(b.kind, kind); assert.equal(b.toolingSha, r.tooling.sha)
  assert.equal(b.sourceCommit, pin.commit); assert.equal(b.version, pin.version); assert.equal(nativePath(b.home), nativePath(r.runtimeHome))
  assert.deepEqual(b.moduleHashes, Object.fromEntries(TOOLING_FILES.map(f => [f, r.tooling.before.files[f].sha256])))
  assert.equal(b.reportFile, kind === 'named-profile' ? 'profile-qualification.json' : 'profile-collision.json')
  assert.ok(validHash(b.reportSha256) && validHash(b.envelopeSha256)); assert.equal(b.envelopeFile, 'native-bound.json')
  assert.ok(kind === 'collision' ? b.directory === 'profile-collision' : ['named-profile-ui-default', 'named-profile-no-skills'].includes(b.directory), 'artifact目录缺失/越界')
}

export function assertNativeNamedProfiles(r) {
  const pin = runtimePin(r.expectedVersion), source = r.profileRuntimeSource
  assert.ok(source && source.version === pin.version && source.commit === pin.commit && source.headBefore === pin.commit && source.headAfter === pin.commit, 'named profile source pin漂移')
  assert.ok(Array.isArray(r.namedProfiles) && r.namedProfiles.length && r.namedProfiles.some(p => p.cloneFromDefault === true && p.noSkills === false), '缺原UI默认true/false named profile实测')
  const last = r.rounds.at(-1), names = new Set()
  for (const p of r.namedProfiles) {
    assert.equal(p.schemaVersion, 1); assert.equal(p.status, 'passed'); assert.equal(p.evidenceKind, 'production-ipc-native-gui', 'fixture不能补named资格')
    assert.equal(p.version, pin.version); assert.equal(p.expectedCommit, pin.commit); assert.equal(p.defaultSessionId, last.sessionId)
    assert.equal(p.provider, 'custom'); assert.equal(p.model, last.prompts.at(-1).model); assert.deepEqual(p.modelReadback, { provider: p.provider, model: p.model })
    assert.equal(p.cloneFromDefault, true); assert.equal(typeof p.noSkills, 'boolean')
    assert.match(p.name || '', /^qualp-[a-f0-9]{12}$/); assert.ok(!names.has(p.name)); names.add(p.name); assert.equal(p.renamed, p.name + '-renamed')
    assert.deepEqual(p.steps, ['baseline-history-and-task-definitions', 'dashboard-proxy-create-and-model-readback', 'default-to-named-gui-runtime-and-boot', 'stop-named-restore-default', 'gui-rename-delete-and-physical-readback'])
    assert.deepEqual(p.errors, []); assert.deepEqual(p.gaps, [])
    assertNativeListeners(p.namedListeners, { home: r.runtimeHome, ports: [r.gatewayPort] }); assertNativeListeners(p.defaultListeners, { home: r.runtimeHome, ports: [r.gatewayPort] })
    assert.equal(p.namedRuntime?.profile, p.name); assert.equal(p.namedRuntime.file.replaceAll('\\', '/'), `profiles/${p.name}/gateway_state.json`); assert.ok(validHash(p.namedRuntime.sha256)); assert.ok(p.namedListeners.some(x => x.pid === p.namedRuntime.pid))
    if (p.namedRuntime.hermesHome) assert.equal(nativePath(p.namedRuntime.hermesHome), nativePath(path.join(r.runtimeHome, '.hermes/profiles', p.name)))
    if (pin.version === '0.22.2') { assert.equal(p.boot?.applicable, true); assert.equal(p.boot.identity, pin.commit); assert.ok(validHash(p.boot.sha256)); assert.ok(Array.isArray(p.boot.steps) && p.boot.steps.length && p.boot.steps.every(s => typeof s === 'string' && s)); assert.ok(Number.isFinite(Date.parse(p.boot.bootstrappedAt))); assert.match(p.boot.file.replaceAll('\\', '/'), new RegExp(`^installs/[a-f0-9]{16}/bootstrap/${p.name}\\.json$`)); assert.ok(Array.isArray(p.namedRuntime.servedProfiles) && p.namedRuntime.servedProfiles.includes(p.name)) }
    else { assert.deepEqual(p.boot, { applicable: false, reason: 'legacy-no-PM-boot-record-contract' }); assert.ok(!Object.hasOwn(p.namedRuntime, 'servedProfiles'), '旧runtime不伪造served_profiles') }
    assert.ok(validHash(p.historyBefore?.sha256) && p.historyBefore.messages > 0); assert.deepEqual(p.historyAfter, p.historyBefore)
    assertScheduledTasksStable(p.tasks?.before, p.tasks?.after)
    assert.equal(p.guiReceipts?.length, 2); const [rename, del] = p.guiReceipts
    assert.ok(rename.method === 'PATCH' && rename.path === `/api/profiles/${p.name}` && rename.ok === true && rename.name === p.renamed)
    assert.ok(del.method === 'DELETE' && del.path === `/api/profiles/${p.renamed}` && del.ok === true && del.identity_settled !== false && del.settlement_pending !== true)
    assert.deepEqual(p.screenshots?.map(s => s.file), ['named-visible.png', 'named-active.png', 'restored-default.png', 'before-rename.png', 'renamed-visible.png', 'deleted.png']); assert.ok(p.screenshots.every(s => validHash(s.sha256)))
    assertArtifactBinding(r, p, 'named-profile')
  }
  assertNativeStopped(r.namedProfileStopProof)
  for (const p of r.namedProfiles.flatMap(p => [...p.namedListeners, ...p.defaultListeners])) assert.ok(r.namedProfileStopProof.identities.some(s => identityKey(s) === identityKey(p)), 'named STOP漏监听身份')
}

export function assertNativeProfileCollision(r) {
  const p = r.profileCollision, pin = runtimePin(r.expectedVersion)
  assert.equal(p?.status, 'passed-windows-profile-collision'); assert.equal(p.evidenceKind, 'real-windows-vm-native-modal'); assert.equal(p.version, pin.version)
  assert.equal(p.runId, r.runner.runId); assert.equal(p.attempt, r.runner.attempt); assert.match(p.nonce || '', /^[a-f0-9]{24}$/)
  assert.equal(p.marker, `ClawPanel profile collision ${p.runId}/${p.attempt}/${p.nonce}`); assert.equal(p.source?.sourceCommit, pin.commit)
  const files = ['hermes_constants.py', 'hermes_cli/gateway.py', 'hermes_cli/gateway_windows.py', 'hermes_cli/profiles.py', ...(pin.version === '0.22.2' ? ['hermes_cli/profiles_service_cleanup.py'] : [])]
  assert.deepEqual(Object.keys(p.source.sourceHashes).sort(), files.sort()); assert.ok(Object.values(p.source.sourceHashes).every(validHash))
  assert.deepEqual(p.errors, []); assert.deepEqual(p.gaps, []); assert.deepEqual(p.cases?.map(c => c.operation), ['rename', 'delete'])
  assert.equal(r.profileCollisionDerivations?.length, 2)
  for (const [i, c] of p.cases.entries()) {
    assert.equal(c.stage, 'complete'); assert.equal(c.name, `qualc-${p.nonce}-${c.operation}`); assert.equal(c.renamed, c.name + '-renamed')
    assert.deepEqual(c.priorTask, { state: 'missing', hresult: '0x80070002' }); assert.equal(c.executionCount, 0); assert.equal(c.sentinelRemoved, true); assert.equal(c.normalCrudPassed, true); assert.ok(c.executionProof && c.normalCrudLayer)
    const t = c.taskBefore; assert.equal(t?.state, 'exists'); assert.equal(t.name, c.sentinel.name); assert.equal(t.marker, p.marker); assert.equal(c.sentinel.marker, p.marker); assert.equal(c.sentinel.sid, r.runner.sid); assert.ok(validHash(t.sha256)); assert.equal(t.userId, r.runner.sid); assert.notEqual(t.userId, 'S-1-5-18'); assert.equal(t.enabled, false); assert.equal(t.triggers, 0); assert.equal(t.actions, 1); assert.equal(t.allowDemandStart, false); assert.equal(t.runLevel, 0); assert.equal(t.logonType, 3); assert.equal(t.lastTaskResult, 0x41303); assert.ok(t.lastRunTime); assert.equal(t.action, c.sentinel.script); assert.deepEqual(c.taskAfter, t)
    assert.equal(c.derivation.method, 'original-get_task_name'); assert.equal(c.derivation.taskName, t.name); assert.equal(c.derivation.sourceCommit, pin.commit)
    assert.equal(nativePath(c.derivation.profileHome), nativePath(path.join(r.runtimeHome, '.hermes/profiles', c.name)))
    assert.equal(c.receipts?.length, 1); assert.equal(c.receipts[0].method, i === 0 ? 'PATCH' : 'DELETE'); assert.equal(c.receipts[0].path, '/api/profiles/' + c.name)
    if (pin.version === '0.22.2') { assert.equal(c.collisionDisposition, 'policy-rejected-before-profile-mutation'); assert.ok(c.receipts[0].error?.includes(t.name) && c.receipts[0].error.includes('private profile mutation blocked by external Windows task/query')); assert.ok(c.visibleError?.includes(t.name)); assert.deepEqual(c.historyAfter, c.historyBefore) }
    else { assert.equal(c.collisionDisposition, 'old21-profile-mutation-succeeded-task-retained'); assert.equal(c.receipts[0].ok, true) }
    const d = r.profileCollisionDerivations[i]; assert.equal(d.evidenceKind, 'actual-private-runtime-python'); assert.equal(d.profile, c.name); assert.equal(d.taskName, t.name); assert.equal(d.sourceCommit, pin.commit); assert.equal(nativePath(d.home), nativePath(r.runtimeHome)); assert.equal(nativePath(d.profileHome), nativePath(c.derivation.profileHome)); assert.equal(nativePath(d.python), nativePath(c.derivation.python)); assert.ok(privateProcess({ executablePath: d.python }, r.runtimeHome)); assert.equal(nativePath(d.sourceFile), nativePath(path.join(r.runtimeHome, '.hermes/hermes-agent/hermes_cli/gateway_windows.py'))); assert.equal(d.exitCode, 0); assert.ok([d.commandSha256, d.stdoutSha256, d.stderrSha256].every(validHash)); assert.equal(d.role, pin.version === '0.22.2' ? 'pm-launch-get-task-name' : 'legacy-private-venv-get-task-name'); assert.ok(privateProcess({ executablePath: d.program }, r.runtimeHome))
    assert.ok([d.programSha256, d.pythonSha256, d.sourceFileSha256].every(validHash)); assert.equal(d.sourceFileSha256, p.source.sourceHashes['hermes_cli/gateway_windows.py'])
    if (pin.version === '0.21.5') assert.equal(nativePath(d.program), nativePath(path.join(r.runtimeHome, '.hermes/hermes-agent/venv/Scripts/python.exe')))
    else assert.ok(nativePath(d.program).startsWith(nativePath(path.join(r.runtimeHome, '.hermes/installs')) + '\\') && nativePath(d.python).startsWith(nativePath(path.join(r.runtimeHome, '.hermes/tools')) + '\\') && nativePath(d.program) !== nativePath(d.python))
  }
  assert.deepEqual(p.screenshots?.map(s => s.file), ['rename-collision.png', 'delete-collision.png']); assert.ok(p.screenshots.every(s => validHash(s.sha256)))
  assertArtifactBinding(r, p, 'collision')
}
export const NATIVE_STEPS = [
  'native-window-rust-ipc-gateway-online', 'actual-native-send-button-complete-reply',
  'native-refresh-restores-real-history', 'native-sustained-210s-42-health',
  'native-production-stop-pid-and-port', 'native-restart-keeps-history',
  'native-post-restart-full-reply', 'native-dashboard-profiles-stop-and-data-retained',
]

export function nativePlan(o = {}) {
  return { installsOnLocalHost: false, webdriver: 'tauri-driver + Microsoft Edge Driver', uiRounds: 2, holdSeconds: 210, webFallback: false, productPluginsAdded: false, ...(o['--seed-sha'] ? { mode: COMPATIBILITY_MODE, seedSha: o['--seed-sha'], candidateSha: o['--sha'], runtimeVersion: OLD_RUNTIME.version, installerLifecycle: 'forbidden', fullInstallationQualification: false, windowsWebCompatibility: 'not-covered' } : {}) }
}

export function nativeArgs(argv) {
  const values = new Set(['--root', '--sha', '--seed-sha', '--version', '--web-output', '--output', '--application', '--driver', '--native-driver', '--hold'])
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    assert.ok(!Object.hasOwn(o, key), `重复参数 ${key}`)
    if (key === '--execute' || key === '--plan') o[key] = true
    else { assert.ok(values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--'), `未知或缺值参数 ${key}`); o[key] = argv[++i] }
  }
  if (o['--sha']) assert.match(o['--sha'], /^[a-f0-9]{40}$/, 'SHA 必须完整且精确')
  if (o['--version']) assert.match(o['--version'], /^0\.\d+\.\d+$/, '版本必须精确')
  if (o['--hold']) assert.equal(o['--hold'], '210', '保留210秒验收，不缩短')
  if (o['--seed-sha']) {
    assert.match(o['--seed-sha'], /^[a-f0-9]{40}$/, 'seed SHA 必须完整且精确')
    assert.ok(o['--sha'] && o['--sha'] !== o['--seed-sha'], '兼容模式必须是新app SHA与不同的旧seed SHA')
    assert.equal(o['--version'], OLD_RUNTIME.version, '兼容模式固定既有0.21.5，不升级runtime')
  }
  assert.ok(!(o['--execute'] && o['--plan']), '模式互斥')
  return o
}

export function assertNativePage(p) {
  const u = new URL(p.url)
  assert.ok(((u.protocol === 'http:' && u.hostname === 'tauri.localhost') || (u.protocol === 'tauri:' && u.hostname === 'localhost')) && !u.port && !u.username && !u.password && p.ipc === true && p.windowLabel === 'main', 'native Tauri 来源/IPC/窗口身份不完整')
}

export function assertNativeConfigDir(value, expected) {
  assert.ok(value && typeof value === 'object' && typeof value.path === 'string' && value.isCustom === true && value.configExists === true, 'Rust 配置目录对象/私有配置缺失')
  assert.equal(path.resolve(value.path), path.resolve(expected), 'Rust 实际配置目录不是本轮私有 HOME')
}

export function assertNativeHealth(health, version) {
  assert.equal(health?.status, 'ok', 'native health status 非 ok')
  assert.equal(health.platform, 'hermes-agent', 'native health platform 不符')
  assert.equal(health.version, version, 'native health version 不符')
}

const identityKey = p => `${p.pid}:${p.creationDate}`
function assertIdentity(p) {
  assert.ok(Number.isInteger(p?.pid) && p.pid > 0 && typeof p.creationDate === 'string' && Number.isFinite(Date.parse(p.creationDate)), 'runtime PID/CreationDate 身份缺失')
}
function privateProcess(p, home) {
  const base = path.win32.resolve(home).toLowerCase(), exe = String(p.executablePath || '').toLowerCase()
  const relative = path.win32.relative(base, exe)
  if (exe && relative && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)) return true
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"'=])${escaped}\\\\`, 'i').test(p.commandLine || '')
}
const validPort = port => Number.isInteger(port) && port > 0 && port < 65536
export function assertNativeListeners(rows, { home, ports, expected }) {
  assert.ok(typeof home === 'string' && home.length && Array.isArray(ports) && ports.length && ports.every(validPort), '缺少实际 HOME/监听端口')
  assert.ok(Array.isArray(rows) && rows.length, '实际监听 PID 集合为空')
  for (const p of rows) {
    assertIdentity(p)
    assert.ok(ports.includes(p.port) && privateProcess(p, home), '监听 PID 不属于目标端口/私有 HOME')
  }
  for (const port of ports) assert.ok(rows.some(p => p.port === port), `端口 ${port} 没有实际监听 PID`)
  if (expected) {
    assert.ok(expected.length, '监听基线身份集合为空')
    const keys = list => [...new Set(list.map(p => `${p.port}:${identityKey(p)}`))].sort()
    assert.deepEqual(keys(rows), keys(expected), '监听 PID/CreationDate 在长会话内变更')
  }
}

export function assertNativeStopped(proof) {
  assert.ok(proof?.productionStop && proof.pidsExited && proof.portsClosed, '生产 STOP/清理证明缺失')
  assert.ok(Array.isArray(proof.identities) && proof.identities.length, 'STOP 身份集合为空')
  proof.identities.forEach(assertIdentity)
  assert.ok(Array.isArray(proof.ports) && proof.ports.length && proof.ports.every(validPort), 'STOP 端口集合为空')
  assert.ok(Array.isArray(proof.present), 'STOP 缺少实际进程回读')
  proof.present.forEach(assertIdentity)
  assert.ok(!proof.present.some(p => proof.identities.some(old => identityKey(old) === identityKey(p))), 'STOP 后原 runtime 身份仍存活')
  assert.deepEqual(proof.listeners, [], 'STOP 后 runtime 端口仍有监听')
  assert.deepEqual(proof.reachablePorts, [], 'STOP 后 runtime 端口仍可达')
}

export function assertNativeProfiles(value) {
  assert.ok(Array.isArray(value?.profiles) && value.profiles.some(p => p?.name === 'default'), 'native profiles 缺实际 default 数组项')
}

function assertSample(s, index, { version, home, port, expected }) {
  assert.ok(Number.isFinite(s.startedMs) && Number.isFinite(s.finishedMs) && s.startedMs >= index * 5000 && s.finishedMs >= s.startedMs && s.finishedMs < (index + 1) * 5000, `native 第${index + 1}个5秒采样窗口超时/补采`)
  assertNativeHealth(s.health, version)
  assertNativeListeners(s.listeners, { home, ports: [port], expected })
}

export async function collectNativeSamples({ item, version, home, port, expected, sample, onSample = async () => {}, now = () => performance.now(), sleep = wait }) {
  assert.deepEqual(item.samples, [], '采样必须从空窗口开始')
  const start = now()
  for (let index = 0; index < 42; index++) {
    while (now() - start < index * 5000) await sleep(index * 5000 - (now() - start))
    const startedMs = now() - start
    assert.ok(startedMs < (index + 1) * 5000, 'native 采样窗口已错过，不补采')
    const s = { at: new Date().toISOString(), startedMs, ...await sample(), finishedMs: now() - start }
    item.samples.push(s)
    assertSample(s, index, { version, home, port, expected })
    await onSample()
    assert.ok(now() - start < (index + 1) * 5000, 'native 采样窗口处理超时，不补采')
  }
  while (now() - start < 210000) await sleep(210000 - (now() - start))
  item.elapsedSeconds = (now() - start) / 1000
}

// 每项均独立执行：早期截图/IPC失败不跳过后续STOP、关闭及最终回读。
export async function runNativeCleanup(steps) {
  const failures = []
  for (const [step, action] of Object.entries(steps)) {
    try { await action() } catch (error) { failures.push({ step, error: String(error.stack || error) }) }
  }
  return failures
}

function assertNativeUiComplete(r) {
  assertNativeTooling(r)
  assertNativePage(r.nativePage)
  assert.equal(r.webviewRuntime?.driverSource?.candidateSha, r.mode === COMPATIBILITY_MODE ? r.seedSha : r.candidateSha, 'driver builder来源SHA不是当前app/兼容seed')
  assert.equal(nativePath(r.webviewDebugger.metadata.userDataFolder), nativePath(r.sessionLaunch.envUserDataFolder)); assertWebviewDebugger(r.webviewDebugger); assertWebviewDebuggerClosed(r.webviewDebugger, r.webviewDebuggerCleanup); assert.ok(!r.debuggerGap, '存在未闭合debugger边界缺口'); assert.equal(nativePath(r.webviewDebugger.runtimePath), nativePath(r.webviewRuntime.path)); assert.ok(r.allFinalPorts.includes(r.webviewDebugger.port))
  assert.ok(r.completed && r.hostUnchanged && r.nativeProcessesExited && r.driverPortsClosed)
  assert.ok(!r.error && !r.cleanupError && !r.hostOrSourceError && !r.providerError)
  assert.equal(r.rounds.length, 2)
  for (const round of r.rounds) {
    assert.deepEqual(round.steps, NATIVE_STEPS)
    assert.equal(round.samples.length, 42)
    assert.ok(round.elapsedSeconds >= 210)
    assert.deepEqual(round.observedErrors, [])
    assert.equal(round.historyReadbackAfterStop, true)
    assertNativeListeners(round.gatewayListeners, { home: r.runtimeHome, ports: [r.gatewayPort] })
    round.samples.forEach((s, i) => assertSample(s, i, { version: r.expectedVersion, home: r.runtimeHome, port: r.gatewayPort, expected: round.gatewayListeners }))
    assertNativeProfiles(round.profiles)
    assert.equal(round.stopProofs?.length, 2)
    round.stopProofs.forEach(assertNativeStopped)
    assert.equal(round.prompts.length, 2)
    for (const p of round.prompts) assert.equal(r.provider.filter(x => !x.title && x.authenticated && x.nonce === p.nonce && x.model === p.model).length, 1)
  }
  assertNativeStopped(r.cleanup)
  assertNativeStopped(r.cleanup.final)
  assertNativeNamedProfiles(r)
  assertNativeProfileCollision(r)
  for (const proof of [...r.rounds.flatMap(x => x.stopProofs), r.namedProfileStopProof, r.cleanup]) {
    assert.ok(proof.identities.every(p => r.cleanup.final.identities.some(last => identityKey(last) === identityKey(p))), '最终清理漏掉已观察 runtime 身份')
    assert.ok(proof.ports.every(port => r.cleanup.final.ports.includes(port)), '最终清理漏掉已观察 runtime 端口')
  }
}

export function assertNativeComplete(r) {
  assert.ok(!r.seedSha && !r.compatibility && r.mode !== COMPATIBILITY_MODE && r.status !== COMPATIBILITY_STATUS, '兼容验收不属于完整安装资格')
  assertNativeUiComplete(r)
  assert.deepEqual(r.nativeInstallerLifecycle?.map(x => x.name), ['update', 'uninstall', 'reinstall'])
  assert.ok(r.nativeInstallerLifecycle.every(x => x.passed && x.dataPreserved))
}

export function assertNativeCompatibilitySeed(s) {
  assert.match(s.seedSha, /^[a-f0-9]{40}$/); assert.match(s.appSha, /^[a-f0-9]{40}$/); assert.notEqual(s.seedSha, s.appSha)
  const p = s.prior
  assert.equal(p.status, 'passed-web-native-missing'); assert.equal(p.candidateSha, s.seedSha); assert.equal(p.expectedVersion, OLD_RUNTIME.version)
  assert.equal(p.hostUnchanged, true); assert.ok(!p.error && !p.cleanupError && !p.stopError && !p.providerError)
  assert.deepEqual(p.stages.map(x => x.name), ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'])
  assert.ok(p.stages.every(x => x.status === 'passed'))
  assert.ok(p.browser?.actualChromium && p.browser.completeReply && p.browser.historyAfterReload && p.browser.trace && p.browser.screenshots?.length && p.browser.prompts?.length)
  assert.deepEqual(p.browser.pageErrors, [])
  assert.equal(nativePath(s.home), nativePath(path.win32.isAbsolute(s.webOutput) ? path.win32.join(s.webOutput, 'h') : path.join(s.webOutput, 'h')))
  assert.equal(nativePath(p.environment.home), nativePath(s.home)); assert.equal(p.environment.sourceSha, s.seedSha)
  assert.equal(nativePath(p.environment.hermesHome), nativePath(path.join(s.home, '.hermes')))
  for (const key of ['sid', 'actualProfile', 'runId', 'attempt', 'imageOS', 'imageVersion']) { assert.ok(s.runner[key]); assert.equal(s.seedProof[key], s.runner[key], `seed非同VM/run: ${key}`) }
  assert.equal(s.seedProof.virtualMachine, true); assert.equal(s.runner.virtualMachine, true)
  for (const release of [s.release, s.completion]) { assert.equal(release.version, OLD_RUNTIME.version); assert.equal(release.commit, OLD_RUNTIME.commit) }
}

export function assertNativeCompatibilityPins({ rust, web }) {
  for (const [source, language] of [[rust, 'Rust'], [web, 'Web']]) {
    const version = source.match(/const HERMES_STABLE_VERSION(?:\s*:\s*&str)?\s*=\s*['"]([^'"]+)['"]/)?.[1]
    const commit = source.match(/const HERMES_STABLE_COMMIT(?:\s*:\s*&str)?\s*=\s*['"]([^'"]+)['"]/)?.[1]
    assert.equal(version, NEW_APP_PIN.version, `${language} 新app pin不是22.2`); assert.equal(commit, NEW_APP_PIN.commit, `${language} 新app源码pin不符`)
  }
  return { ...NEW_APP_PIN }
}

export function assertNativeCompatibilityBinding(b) {
  assert.match(b.candidateSha, /^[a-f0-9]{40}$/); assert.equal(b.rootSha, b.candidateSha)
  for (const file of ['scripts/dev-api.js', 'src-tauri/src/commands/hermes.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'package.json']) assert.match(b.sourceHashes?.[file] || '', /^[a-f0-9]{64}$/, `缺新app源码hash ${file}`)
  assert.ok(Object.values(b.sourceHashes).every(h => /^[a-f0-9]{64}$/.test(h)))
  assert.equal(b.build.status, 'passed'); assert.equal(b.build.candidateSha, b.candidateSha); assert.equal(b.build.hostUnchanged, true); assert.ok(!b.build.error)
  assert.match(b.sourceManifestSha256, /^[a-f0-9]{64}$/); assert.equal(b.build.sourceManifestSha256, b.sourceManifestSha256)
  assert.match(b.application.sha256, /^[a-f0-9]{64}$/); assert.equal(b.build.application.sha256, b.application.sha256); assert.equal(nativePath(b.build.application.path), nativePath(b.application.path))
}

export function readNativeCompatibilityBinding({ root, app, sha, buildReceipt }) {
  const git = args => { const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 }); assert.equal(r.status, 0, r.stderr?.toString()); return r.stdout }
  const rootSha = git(['rev-parse', 'HEAD']).toString().trim(); assert.equal(rootSha, sha)
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']).toString().trim(), '', '新app工作树存在tracked改动')
  const sourceHashes = {}
  for (const entry of git(['ls-tree', '-rz', '--full-tree', sha]).toString().split('\0').filter(Boolean)) {
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/); assert.ok(match, '拒绝新app特殊Git entry')
    const [, , oid, file] = match, actual = physical(path.join(root, file)); assert.ok(inside(root, actual))
    const bytes = git(['show', `${sha}:${file}`])
    assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), oid)
    const expected = crypto.createHash('sha256').update(bytes).digest('hex'); assert.equal(hash(actual), expected, `新app源码字节不符 ${file}`); sourceHashes[file] = expected
  }
  const manifestFile = physical(path.join(path.dirname(buildReceipt), 'source-sha256.json')), manifest = read(manifestFile)
  assert.equal(manifest.sha, sha); assert.deepEqual(manifest.files, sourceHashes, 'build manifest不属于完整新app源码')
  const binding = { candidateSha: sha, rootSha, sourceHashes, sourceManifestSha256: hash(manifestFile), application: { path: app, sha256: hash(app) }, build: read(physical(buildReceipt)), buildReceiptSha256: hash(buildReceipt) }
  assertNativeCompatibilityBinding(binding); return binding
}

export function assertNativeCompatibilityComplete(r) {
  assert.equal(r.status, COMPATIBILITY_STATUS, '兼容报告必须使用独立成功status')
  assert.equal(r.mode, COMPATIBILITY_MODE); assert.equal(r.expectedVersion, OLD_RUNTIME.version)
  assert.ok(!Object.hasOwn(r, 'nativeInstallerLifecycle'), '兼容模式不得执行installer lifecycle')
  const c = r.compatibility; assert.ok(c)
  assertNativeCompatibilitySeed(c.seed); assert.equal(r.seedSha, c.seed.seedSha); assert.equal(r.candidateSha, c.seed.appSha); assert.equal(nativePath(r.runtimeHome), nativePath(c.seed.home))
  assert.equal(nativePath(r.webQualification.path), nativePath(c.seed.webOutput)); assert.match(r.webQualification.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(c.appPin, NEW_APP_PIN); assertNativeCompatibilityBinding(c.binding); assert.equal(c.binding.candidateSha, r.candidateSha)
  assert.deepEqual(r.application.path, c.binding.application.path); assert.equal(r.application.sha256, c.binding.application.sha256)
  assert.deepEqual(c.blockedInstallerCommands, []); assert.ok(Array.isArray(r.ipc) && !r.ipc.some(x => installerCommand(x.cmd)), '兼容模式出现installer IPC尝试')
  assert.deepEqual(c.runtimeChecks.map(x => x.phase), ['before-ui', 'after-round-1', 'after-round-2', 'after-ui'])
  for (const check of c.runtimeChecks) { assert.equal(check.installed, true); assert.equal(check.version, OLD_RUNTIME.version); assert.equal(check.commit, OLD_RUNTIME.commit); assert.equal(nativePath(check.hermesHome), nativePath(path.join(r.runtimeHome, '.hermes'))) }
  assert.equal(c.finalRuntimeHead, OLD_RUNTIME.commit); assert.equal(c.seedMemoryPreserved, true); assert.equal(c.seedHistoryPreserved, true)
  assertNativeUiComplete(r)
}

export async function createNativeProvider({ report, save = () => {}, runtimePin: providerPin, nonceFamily }) {
  const { classifyHermesMetadataRequest } = await import('./hermes-qualification-provider.mjs')
  const models = ['native-one', 'native-two']
  report.metadata ||= []
  report.providerMetadataClassifierSha256 = hash(fileURLToPath(new URL('./hermes-qualification-provider.mjs', import.meta.url)))
  return http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const b of req) { raw += b; assert.ok(Buffer.byteLength(raw) <= 1048576) }
      const body = raw ? JSON.parse(raw) : {}
      if (req.method === 'GET') assert.equal(raw, '', 'native Provider GET 仅接受空 raw 正文')
      const metadata = classifyHermesMetadataRequest(req.method, req.url, raw, models)
      if (metadata) {
        assert.equal(metadata.kind, 'metadata')
        const catalog = metadata.provider === 'openai-catalog'
        if (catalog) { assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/models'); assert.equal(metadata.status, 200) }
        else { assert.equal(metadata.status, 404); assert.ok(['lm-studio', 'ollama', 'llamacpp', 'vllm', 'openai'].includes(metadata.provider), '未核实 metadata label') }
        report.metadata.push({ ...metadata, method: req.method, path: req.url, at: new Date().toISOString() }); save()
        res.writeHead(metadata.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(catalog ? { data: models.map(id => ({ id, object: 'model', owned_by: 'qualification' })) } : { error: 'metadata protocol not provided by qualification fixture' })); return
      }
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer qualification-native-no-secret')
      const nonce = [...JSON.stringify(body.messages).matchAll(/native-acceptance-[a-f0-9-]{36}/g)].at(-1)?.[0]
      assert.ok(nonce, '模型请求缺少本轮 nonce')
      // 只以真实已分类且同端点POST的历史作证；title:false不等于已核chat。
      const family = nonceFamily === undefined ? { nonceFamily: 'native' } : { nonceFamily }
      const evidence = { ...family, nonce, pin: providerPin, method: req.method, path: req.url, authenticated: true, models, calls: report.provider.filter(c => c.method === 'POST' && c.path === '/v1/chat/completions') }
      const classified = classifyProviderRequest(body, evidence), pinnedTitle = matchesPinnedTitleRequest(body, evidence)
      // 原Native只认这一种raw前缀（不trim）；共享Web另外两种legacy不得改变原计数。
      const system = (body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n')
      const title = /^You are a title generator\./.test(system) || pinnedTitle
      const purpose = title ? 'title' : classified === 'chat' ? 'chat' : 'unattributed'
      const content = pinnedTitle ? qualificationProviderReply(body, nonce, evidence) : `原生完整回复：${nonce}；模型：${body.model}。`
      // Web兼容输入只记实际最后user文本的hash；不能从nonce或title布尔值补造正文证据。
      const openingMessage = nonceFamily === 'native-web-compat' && Array.isArray(body.messages) ? body.messages.filter(m => m.role === 'user').at(-1)?.content : null
      report.provider.push({ nonce, model: body.model, title, purpose, stream: body.stream, authenticated: true, method: req.method, path: req.url, ...(nonceFamily === 'native-web-compat' ? { openingMessageSha256: typeof openingMessage === 'string' ? sha256(openingMessage) : null } : {}) }); save()
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const delta of [{ role: 'assistant', content: '' }, { content }, {}]) res.write('data: ' + JSON.stringify({ id: 'native-qualification', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'native-qualification', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })) }
    } catch (e) { report.providerError = String(e); save(); if (!res.headersSent) res.writeHead(500); res.end('qualification provider failed') }
  })
}

export class NativeWebDriver {
  constructor(base, { compatibility = false } = {}) {
    const u = new URL(base)
    assert.ok(u.protocol === 'http:' && u.hostname === '127.0.0.1', 'WebDriver 只接受回环')
    this.base = u.origin; this.session = null; this.events = []
    this.compatibility = compatibility; this.blockedInstallerCommands = []
  }
  async request(method, route, body, timeout = 120000) {
    const start = performance.now()
    assert.ok(timeout > 0 && timeout <= 900000, '保留单次安装900秒上限')
    const response = await fetch(this.base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) })
    const data = await response.json()
    this.events.push({ method, route, status: response.status, durationMs: performance.now() - start })
    if (!response.ok || data.value?.error) throw new Error(`WebDriver ${route}: ${data.value?.message || data.value?.error || response.status}`)
    return data.value
  }
  async create(application, userDataFolder) {
    assert.ok(typeof userDataFolder === 'string' && (path.win32.isAbsolute(userDataFolder) || path.isAbsolute(userDataFolder)), 'userDataFolder 必须为私有绝对profile路径')
    const paths = path.win32.isAbsolute(userDataFolder) ? path.win32 : path
    assert.ok(paths !== path.win32 || /^[a-z]:\\/i.test(userDataFolder), 'profile拒绝网络路径'); assert.equal(paths.resolve(userDataFolder), userDataFolder, 'profile路径须正规化')
    // 固定tauri-driver 2.1.0从TauriOptions转发webviewOptions；顶层ms:edgeOptions会被覆盖。
    this.requestedCapabilities = { capabilities: { alwaysMatch: { 'tauri:options': { application, webviewOptions: { userDataFolder, additionalBrowserArguments: ['remote-debugging-port=0', 'remote-debugging-address=127.0.0.1'] } } } } }
    const data = await this.request('POST', '/session', this.requestedCapabilities)
    assert.ok(data?.sessionId, '缺少真实 WebDriver session')
    this.session = data.sessionId
    await this.command('POST', '/timeouts', { script: 120000, pageLoad: 60000, implicit: 0 })
    return data
  }
  command(method, route, body, timeout) { assert.ok(this.session); return this.request(method, `/session/${this.session}${route}`, body, timeout) }
  script(script, args = []) { return this.command('POST', '/execute/sync', { script, args }) }
  async ipc(cmd, args = {}, timeout = 120000) {
    if (this.compatibility && installerCommand(cmd)) { this.blockedInstallerCommands.push(cmd); throw new Error(`兼容模式禁止installer IPC: ${cmd}`) }
    if (timeout !== 120000) await this.command('POST', '/timeouts', { script: timeout })
    try {
      const data = await this.command('POST', '/execute/async', { script: `const [cmd,args,done]=arguments; if(!window.__TAURI__?.core?.invoke){done({ok:false,error:'missing native IPC'});return} window.__TAURI__.core.invoke(cmd,args).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));`, args: [cmd, args] }, timeout)
      assert.ok(data?.ok, `native IPC ${cmd}: ${data?.error || 'missing reply'}`)
      return data.value
    } finally { if (timeout !== 120000) await this.command('POST', '/timeouts', { script: 120000 }) }
  }
  async element(selector) {
    const x = await this.command('POST', '/element', { using: 'css selector', value: selector })
    const id = x?.['element-6066-11e4-a52e-4f735466cecf']; assert.ok(id, `缺少真实元素 ${selector}`); return id
  }
  async send(prompt) {
    const input = await this.element('#hm-chat-input')
    await this.command('POST', `/element/${input}/clear`, {})
    await this.command('POST', `/element/${input}/value`, { text: prompt, value: [...prompt] })
    await until(async () => await this.script('return !!document.querySelector("#hm-chat-send") && !document.querySelector("#hm-chat-send").disabled'))
    const send = await this.element('#hm-chat-send')
    await this.command('POST', `/element/${send}/click`, {})
  }
  async screenshot(file) {
    const data = Buffer.from(await this.command('GET', '/screenshot'), 'base64')
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '截图不是 PNG')
    fs.writeFileSync(file, data)
  }
  async close() { if (this.session) { await this.command('DELETE', ''); this.session = null } }
}


// Browser参数只经W3C capability提交；子环境清除冲突覆盖，不修改父/宿主环境。
export function nativeDriverChildEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^WEBVIEW2_(?:ADDITIONAL_BROWSER_ARGUMENTS|PIPE_FOR_SCRIPT_DEBUGGER|WAIT_FOR_SCRIPT_DEBUGGER)$/i.test(k)))
}
// 只记录交给spawn的白名单值；不是driver、应用或WebView实际收到环境的证明。
export function nativeDriverEnvSubmission(env) {
  assert.ok(typeof env.WEBVIEW2_USER_DATA_FOLDER === 'string' && env.WEBVIEW2_USER_DATA_FOLDER.length, '提交收据缺私有UDD')
  assert.ok(!Object.keys(env).some(k => /^WEBVIEW2_(?:ADDITIONAL_BROWSER_ARGUMENTS|PIPE_FOR_SCRIPT_DEBUGGER|WAIT_FOR_SCRIPT_DEBUGGER)$/i.test(k)), '提交收据仍有debug环境冲突')
  return {
    scope: 'driver-child spawn submission only; not actual driver/app/runtime environment readback',
    actualEnvironmentObserved: false,
    submitted: {
      WEBVIEW2_USER_DATA_FOLDER: env.WEBVIEW2_USER_DATA_FOLDER,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: null,
      WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER: null,
      WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER: null,
    },
  }
}
const debugPath = value => (path.win32.isAbsolute(value) ? path.win32 : path).normalize(value).toLowerCase()
const debugIdentity = p => `${p.pid}:${p.creationDate}`
const debugArgs = (text, key) => [...(text || '').matchAll(new RegExp('(?:^|\\s)--' + key + '=(?:"([^"]+)"|([^\\s"]+))(?=\\s|$)', 'g'))].map(m => m[1] || m[2])
export function assertWebviewDebugger(e) {
  assert.ok(e && Array.isArray(e.observation?.processes) && Array.isArray(e.observation.listeners), 'DevTools缺实际CIM/TCP观察')
  const rows = Object.entries(e.metadata?.files || {}).filter(([, row]) => row.exists)
  assert.ok(rows.length, 'DevToolsActivePort缺失')
  for (const [name, row] of rows) { assert.ok(['DevToolsActivePort', 'EBWebView/DevToolsActivePort'].includes(name)); assert.ok(row.size <= 4096 && row.contentRead && row.validEndpoint && /^[a-f0-9]{64}$/.test(row.sha256), 'DevTools文件超限/格式错误'); assert.ok(Number.isInteger(row.port) && row.port > 0 && row.port < 65536, 'DevTools端口无效') }
  const unique = [...new Set(rows.map(([, row]) => row.port))]; assert.equal(unique.length, 1, 'DevTools文件端口歧义'); assert.equal(e.port, unique[0], 'DevTools端口未绑定文件')
  const paths = path.win32.isAbsolute(e.metadata.userDataFolder) ? path.win32 : path
  const allowed = rows.map(([name]) => debugPath(paths.dirname(paths.join(e.metadata.userDataFolder, name))))
  const owners = e.observation.processes.filter(p => p.exe && debugPath(p.exe) === debugPath(e.runtimePath) && debugArgs(p.commandLine, 'user-data-dir').length === 1 && allowed.includes(debugPath(debugArgs(p.commandLine, 'user-data-dir')[0])) && !/(?:^|\s)--type=/.test(p.commandLine || ''))
  assert.equal(owners.length, 1, 'DevTools缺唯一精确runtime/privateUDD browser进程')
  const owner = owners[0]; assert.ok(Number.isInteger(owner.pid) && owner.pid > 0 && Number.isFinite(Date.parse(owner.creationDate)), 'DevTools缺PID/CreationDate')
  assert.deepEqual(debugArgs(owner.commandLine, 'remote-debugging-port'), ['0'], 'DevTools实际命令未开启随机端口')
  assert.deepEqual(debugArgs(owner.commandLine, 'remote-debugging-address'), ['127.0.0.1'], 'DevTools实际命令未限制回环')
  const listeners = e.observation.listeners.filter(p => p.port === e.port); assert.ok(listeners.length, 'DevTools缺实际监听端口')
  for (const p of listeners) { assert.ok(['127.0.0.1', '::1'].includes(p.localAddress), 'DevTools监听非loopback'); assert.equal(p.pid, owner.pid, 'DevTools监听错PID'); assert.equal(p.creationDate, owner.creationDate, 'DevTools监听错CreationDate'); assert.equal(debugPath(p.exe), debugPath(e.runtimePath), 'DevTools监听错runtime') }
  assert.ok(e.ports?.includes(e.port) && e.identities?.some(p => debugIdentity(p) === debugIdentity(owner) && debugPath(p.exe) === debugPath(e.runtimePath)), 'DevTools未纳入清理端口/身份');
  if (e.expected) { assert.equal(debugIdentity(owner), debugIdentity(e.expected), 'DevTools身份改变/PID复用'); assert.equal(e.port, e.expected.port, 'DevTools端口改变') }
  return owner
}
export function captureWebviewDebugger({ home, userDataFolder, runtimePath, snapshot, ports, identities, expected }) {
  const e = { capturedAt: new Date().toISOString(), runtimePath, expected: expected?.process ? { ...expected.process, port: expected.port } : null }
  try {
    e.metadata = webviewProfileMetadata({ home, userDataFolder })
    for (const row of Object.values(e.metadata.files)) if (Number.isInteger(row.port) && row.port > 0 && row.port < 65536) ports.add(row.port)
    e.ports = [...ports]; e.observation = snapshot([...ports], [...identities.values()])
    // 仅保存由本次CIM实际观察、属于精确runtime和私有UDD的身份；错owner绝不成为taskkill目标。
    for (const p of e.observation.processes) if (p.exe && debugPath(p.exe) === debugPath(runtimePath) && debugArgs(p.commandLine, 'user-data-dir').some(v => [userDataFolder, path.join(userDataFolder, 'EBWebView')].some(dir => debugPath(dir) === debugPath(v))) && Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(Date.parse(p.creationDate))) identities.set(debugIdentity(p), p)
    for (const p of e.observation.listeners) if (identities.has(debugIdentity(p))) ports.add(p.port)
    e.ports = [...ports]; e.identities = [...identities.values()]
    e.port = Object.values(e.metadata.files).find(row => row.port)?.port
    e.process = assertWebviewDebugger(e); e.status = 'verified-private-webview-debugger'; return e
  } catch (error) { e.gap = String(error.message); e.identities = [...identities.values()]; e.ports = [...ports]; error.debuggerEvidence = e; throw error }
}
export function assertWebviewDebuggerClosed(e, after) {
  assert.ok(e?.identities?.length && e.ports?.length, 'DevTools清理缺非空身份/端口')
  for (const key of ['processes', 'present', 'listeners']) assert.ok(Array.isArray(after?.[key]), 'DevTools清理缺实际回读')
  assert.equal(after.processes.length, 0, 'DevTools私有进程仍存活');
  assert.ok(e.identities.every(p => Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(Date.parse(p.creationDate))), 'DevTools清理身份无效');
  assert.ok(e.ports.every(p => Number.isInteger(p) && p > 0 && p < 65536), 'DevTools清理端口无效');
  const keys = new Set(e.identities.map(debugIdentity))
  assert.ok(![...after.processes, ...after.present].some(p => keys.has(debugIdentity(p))), 'DevTools原身份仍存活')
  assert.ok(!after.listeners.some(p => e.ports.includes(p.port)), 'DevTools监听端口未关闭')
}
export function webviewDebuggerObservationSource({ userDataFolder, ports, tracked = [] }) {
  assert.ok(ports.every(p => Number.isInteger(p) && p > 0 && p < 65536)); assert.ok(tracked.every(p => Number.isInteger(p.pid) && p.pid > 0))
  return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(userDataFolder).toString('base64')}'));$ports=@(${ports.join(',')});$ids=@(${tracked.map(p => p.pid).join(',')});$all=@(Get-CimInstance Win32_Process -ErrorAction Stop);$owned=@($all|Where-Object {$_.ProcessId -ne $PID -and $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($u,[StringComparison]::OrdinalIgnoreCase) -ge 0});function Row($p){if(!$p -or !$p.CreationDate){throw 'missing debugger CIM identity'};@{pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath;commandLine=$(if($owned.ProcessId -contains $p.ProcessId){$p.CommandLine}else{$null})}};$listeners=@(Get-NetTCPConnection -ErrorAction Stop|Where-Object {$_.State -eq 'Listen' -and ($ports -contains [int]$_.LocalPort -or $owned.ProcessId -contains [int]$_.OwningProcess)}|ForEach-Object {$c=$_;$p=$all|Where-Object {$_.ProcessId -eq $c.OwningProcess}|Select-Object -First 1;$r=Row $p;$r.port=[int]$c.LocalPort;$r.localAddress=$c.LocalAddress;$r});@{processes=@($owned|ForEach-Object {Row $_});present=@($all|Where-Object {$ids -contains [int]$_.ProcessId}|ForEach-Object {Row $_});listeners=$listeners}|ConvertTo-Json -Depth 6 -Compress`
}


// 复用同VM、同seed builder的实际driver/runtime收据，不根据进程名猜版本。
export function readNativeDebuggerRuntime({ webOutput, driver, nativeDriver, candidateSha }) {
  const variant = path.basename(webOutput).match(/^hermes-qualification-(.+)$/)?.[1]; assert.ok(variant, '缺已验证Web输出命名')
  const build = physical(path.join(path.dirname(webOutput), 'hermes-native-build-' + variant)), receiptFile = physical(path.join(build, 'driver-receipt.json'))
  const report = read(path.join(build, 'build-receipt.json')), drivers = read(receiptFile), runtime = read(path.join(build, 'installed-webview2.json'))
  assert.equal(report.status, 'passed'); assert.equal(report.candidateSha, candidateSha); assert.equal(report.driverReceiptSha256, hash(receiptFile), 'builder driver收据hash不符')
  assert.equal(nativePath(drivers.tauri.path), nativePath(driver)); assert.equal(drivers.tauri.sha256, hash(physical(driver))); assert.equal(drivers.microsoft.sha256, hash(physical(nativeDriver)))
  assert.deepEqual(runtime, drivers.microsoft.webview2); assert.match(runtime.version, /^\d+\.\d+\.\d+\.\d+$/); assert.equal(runtime.binaryVersion.match(/^\d+\.\d+\.\d+\.\d+/)?.[0], runtime.version)
  assert.equal(drivers.microsoft.version.trim().match(/^(?:MSEdgeDriver|Microsoft Edge WebDriver) (\d+\.\d+\.\d+\.\d+)(?: \([^\r\n()]+\))?$/)?.[1], runtime.version)
  assert.equal(path.basename(physical(runtime.path)).toLowerCase(), 'msedgewebview2.exe'); assert.ok(runtime.registry && Object.keys(runtime.registry).length)
  return { ...runtime, driverSource: { candidateSha, buildDirectory: build, tauriDriver: physical(driver), nativeDriver: physical(nativeDriver) }, sha256: hash(runtime.path), driverReceiptSha256: hash(receiptFile), buildReceiptSha256: hash(path.join(build, 'build-receipt.json')) }
}

export function webviewProfileMetadata({ home, userDataFolder }) {
  const root = physical(home), folder = physical(userDataFolder)
  assert.ok(folder !== root && inside(root, folder), 'profile越出私有HOME')
  const result = { scope: 'read-only explicit UDD metadata; not native launch proof', capturedAt: new Date().toISOString(), userDataFolder: folder, folder: { exists: false }, files: {} }
  try { assert.ok(fs.lstatSync(folder).isDirectory(), 'profile不是目录'); result.folder = { exists: true } } catch (e) { if (e.code !== 'ENOENT') throw e }
  for (const name of ['DevToolsActivePort', 'EBWebView/DevToolsActivePort']) {
    const file = physical(path.join(folder, name))
    try {
      const stat = fs.lstatSync(file), row = { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, contentRead: false }
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'DevTools文件类型'); result.files[name] = row
      if (stat.size <= 4096) {
        const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(4096); let n, stable
        try { n = fs.readSync(fd, buffer, 0, buffer.length, 0); stable = n === stat.size && fs.fstatSync(fd).size === n } finally { fs.closeSync(fd) }
        if (n <= 4096 && stable) {
          const bytes = buffer.subarray(0, n), first = bytes.toString('utf8').split(/\r?\n/)[0], port = /^\d+$/.test(first) ? Number(first) : 0
          Object.assign(row, { contentRead: true, validEndpoint: /^[1-9]\d{0,4}\r?\n\/devtools\/browser\/[A-Za-z0-9._-]+\r?\n?$/.test(bytes.toString('utf8')), sha256: sha256(bytes), port: port > 0 && port <= 65535 ? port : null })
        }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; result.files[name] = { exists: false } }
  }
  return result
}

async function until(predicate, timeout = 60000) {
  const end = performance.now() + timeout
  do { const v = await predicate(); if (v) return v; await wait(300) } while (performance.now() < end)
  throw new Error('native UI 有界等待失败')
}
async function freePort() { return await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) }) }
async function reachable(port) { return await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(false) }) }) }
function physical(file) {
  const absolute = path.resolve(file)
  for (let p = absolute;; p = path.dirname(p)) {
    if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), `拒绝链接祖先 ${p}`)
    if (p === path.dirname(p)) break
  }
  return absolute
}

export function buildNativeTaskNameCommand({ root, home, profileHome, release, completion }) {
  const pin = runtimePin(release.version); assert.equal(release.commit, pin.commit)
  home = physical(home); const source = physical(path.join(home, '.hermes/hermes-agent')), ownerHome = physical(path.join(home, '.hermes'))
  profileHome = physical(profileHome)
  assert.equal(nativePath(path.dirname(profileHome)), nativePath(path.join(ownerHome, 'profiles')), '派生profile不是owner HOME直接子目录')
  assert.match(path.basename(profileHome), /^qualc-[a-z0-9-]+$/); assert.ok(fs.statSync(profileHome).isDirectory())
  validatePrivateCompletion(completion, { home, ...pin })
  for (const f of [completion.python, ...Object.values(completion.modules)]) { physical(f); assert.ok(inside(home, fs.realpathSync(f)), 'privatecompletion实际路径越界') }
  // 固定内部命名snippet；不接收HTTP code、调用方任意Python或外部程序名。
  const original = taskNamePythonSource(profileHome)
  const code = `import sys,json,io,contextlib\nsys.stdout.reconfigure(encoding='utf-8')\n_capture=io.StringIO()\nwith contextlib.redirect_stdout(_capture):\n exec(${JSON.stringify(original)},{'__name__':'__main__'})\nfrom hermes_cli.gateway_windows import get_task_name as _naming\n_value=json.loads(_capture.getvalue())\n_value.update(python=sys.executable,sourceFile=_naming.__code__.co_filename)\nprint(json.dumps(_value))\n`
  let program, args, role, helperSha256
  if (pin.version === '0.22.2') {
    const helperFile = physical(path.join(root, 'scripts/hermes-pm-runtime.js')), helper = fs.readFileSync(helperFile, 'utf8')
    helperSha256 = hash(helperFile); assert.equal(helperSha256, completion.pm.helperSha256, 'LAUNCH helper不是实际安装验证字节')
    const originalScript = name => { const value = helper.match(new RegExp('export const ' + name + ' = String.raw`([\\s\\S]*?)\\n`'))?.[1]; assert.ok(value?.includes(pin.commit), `固定PM helper缺失 ${name}`); return value }
    const launch = originalScript('HERMES_PRIVATE_LAUNCH_SCRIPT'), metadata = originalScript('HERMES_PRIVATE_METADATA_SCRIPT')
    assert.deepEqual(completion.commandSpec.args, ['-I', '-B', '-c', metadata, source, pin.commit], '已装metadata commandSpec被改写/任意code')
    assert.equal(nativePath(completion.commandSpec.actualSelectedInterpreter), nativePath(completion.python))
    program = physical(completion.commandSpec.program); assert.equal(nativePath(program), nativePath(completion.pm.dependencyPython)); assert.ok(inside(home, fs.realpathSync(program)))
    args = ['-I', '-B', '-c', launch, source, ownerHome, pin.commit, '--python-json', code]; role = 'pm-launch-get-task-name'
  } else {
    program = physical(path.join(source, 'venv/Scripts/python.exe')); const cli = physical(path.join(source, 'venv/Scripts/hermes.exe'))
    assert.equal(nativePath(completion.python), nativePath(program)); assert.equal(nativePath(completion.cli), nativePath(cli))
    assert.deepEqual(completion.commandSpec, { program: cli, args: ['--version'], role: 'legacy-managed-hermes-cli' }, '旧venv commandSpec被改写')
    args = ['-I', '-B', '-c', `import sys\nsys.path.insert(0,${JSON.stringify(source)})\n` + code]; role = 'legacy-private-venv-get-task-name'
  }
  assert.ok(fs.statSync(program).isFile()); return { program, args, role, source, ownerHome, profileHome, expectedPython: completion.python, expectedSourceFile: path.join(source, 'hermes_cli/gateway_windows.py'), sourceCommit: pin.commit, ...(helperSha256 ? { helperSha256 } : {}) }
}

async function execute(o) {
  // 第一项是既有可信 VM/账户实证，传入路径或环境变量不构成本机安装授权。
  const qualification = await import('./test-hermes-windows-qualification.mjs')
  assert.equal(typeof qualification.actualRunnerProof, 'function', '一次性 runner 资格入口尚未具备')
  const proof = qualification.actualRunnerProof(); qualification.validateRunnerProof(proof)
  for (const key of ['--root', '--sha', '--version', '--web-output', '--output', '--application', '--driver', '--native-driver']) assert.ok(o[key], `缺少 ${key}`)
  const root = physical(o['--root']), output = physical(o['--output']), webOutput = physical(o['--web-output'])
  assert.ok(inside(physical(process.env.RUNNER_TEMP), output) && !fs.existsSync(output), 'native 输出必须是 RUNNER_TEMP 内全新目录')
  const prior = read(path.join(webOutput, 'report.json'))
  assert.equal(prior.status, 'passed-web-native-missing', '先完成真实 Web/安装生命周期，不用自述 receipt')
  const compatibility = !!o['--seed-sha']
  assert.equal(prior.candidateSha, compatibility ? o['--seed-sha'] : o['--sha'])
  const home = physical(path.join(webOutput, 'h')), app = physical(o['--application'])
  const release = read(path.join(webOutput, 'release.json')), completion = read(path.join(webOutput, 'privatecompletion.json'))
  assert.deepEqual({ version: release.version, commit: release.commit }, runtimePin(o['--version']))
  qualification.validatePrivateCompletion(completion, { home, version: release.version, commit: release.commit })
  assert.ok(fs.statSync(home).isDirectory() && inside(root, app) && /clawpanel\.exe$/i.test(app), '应用或安装 HOME 越界')
  const git = spawnSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
  assert.equal(git.status, 0); assert.equal(git.stdout.trim(), o['--sha'])
  fs.mkdirSync(output)
  const toolingRoot = physical(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const toolingBefore = readNativeToolingSnapshot({ root: toolingRoot, sha: proof.toolingSha })
  const report = { schemaVersion: 1, status: 'failed', candidateSha: o['--sha'], expectedVersion: o['--version'], runtimeHome: home, startedAt: new Date().toISOString(), executionMode: 'actual-github-hosted-windows-vm-native', tooling: { sha: proof.toolingSha, scope: 'github-hosted-main-native-tooling', before: toolingBefore, after: null }, profileQualificationModuleSha256: toolingBefore.files[TOOLING_FILES[3]].sha256, profileCollisionModuleSha256: toolingBefore.files[TOOLING_FILES[4]].sha256, scope: 'actual ClawPanel.exe / WebView2 / Rust IPC / W3C native driver', runner: proof, webQualification: { path: webOutput, sha256: hash(path.join(webOutput, 'report.json')) }, application: { path: app, sha256: hash(app) }, rounds: [], ipc: [], provider: [], nativePage: null, cleanup: null, errorObservationScope: 'observed flows only after error listener installation; excludes pre-attachment startup and every refresh until listeners are reinstalled; not a whole-lifecycle zero-error claim' }
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  if (compatibility) {
    assert.equal(o['--version'], OLD_RUNTIME.version)
    const seed = { prior, seedSha: o['--seed-sha'], appSha: o['--sha'], home, webOutput, runner: proof, seedProof: read(path.join(webOutput, 'runner-proof.json')), release: read(path.join(webOutput, 'release.json')), completion: read(path.join(webOutput, 'privatecompletion.json')) }
    qualification.validateRunnerProof(seed.seedProof); assertNativeCompatibilitySeed(seed)
    assert.equal(qualification.qualificationStatus(prior), 'passed-web-native-missing')
    qualification.validatePrivateCompletion(seed.completion, { home, ...OLD_RUNTIME })
    const suffix = path.basename(output).match(/^hermes-native-(.+)$/)?.[1]
    assert.ok(suffix, 'compat输出命名须hermes-native-NAME，对应同级hermes-native-build-NAME构建回执')
    const binding = readNativeCompatibilityBinding({ root, app, sha: o['--sha'], buildReceipt: path.join(path.dirname(output), `hermes-native-build-${suffix}`, 'build-receipt.json') })
    const appPin = assertNativeCompatibilityPins({ rust: fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8'), web: fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8') })
    Object.assign(report, { mode: COMPATIBILITY_MODE, seedSha: o['--seed-sha'], scope: 'new ClawPanel app (22.2 pin) / existing Hermes 0.21.5 runtime / native Rust IPC only; Windows Web compatibility not covered', compatibility: { seed, binding, appPin, runtimeChecks: [], blockedInstallerCommands: [], finalRuntimeHead: null, seedMemoryPreserved: false, seedHistoryPreserved: false } }); save()
  }
  const before = qualification.hostSnapshot(proof)
  fs.writeFileSync(path.join(output, 'host-before.json'), JSON.stringify(before, null, 2))
  const env = qualification.isolationEnv({ home, temp: path.join(output, 'tmp'), realProfile: proof.actualProfile })
  const psChildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  env.WEBVIEW2_USER_DATA_FOLDER = path.join(home, '.webview2-native-qualification')
  env.TAURI_WEBVIEW_AUTOMATION = '1'
  fs.mkdirSync(env.TEMP, { recursive: true })
  const panelDir = path.join(home, '.openclaw'), panelPath = path.join(panelDir, 'clawpanel.json')
  const originalPanel = fs.readFileSync(panelPath)
  const config = JSON.parse(originalPanel)
  Object.assign(config, { ignoreRisk: true, openclawDir: panelDir, engineMode: 'hermes', enabledEngines: ['hermes'], engineSetupChoice: 'explicit' })
  fs.writeFileSync(panelPath, JSON.stringify(config))
  if (!fs.existsSync(path.join(panelDir, 'openclaw.json'))) fs.writeFileSync(path.join(panelDir, 'openclaw.json'), '{}')
  const sources = compatibility ? report.compatibility.binding.sourceHashes : Object.fromEntries(['src-tauri/src/commands/hermes.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'package.json', ...(fs.existsSync(path.join(root, 'scripts/hermes-pm-runtime.js')) ? ['scripts/hermes-pm-runtime.js'] : [])].map(f => [f, hash(path.join(root, f))]))
  const watchedIdentities = new Map(), ports = new Set(), activeListeners = new Map()
  let driver, provider, client, providerPort, driverPort, nativePort
  const nativePids = new Set(), debuggerPorts = new Set(), debuggerIdentities = new Map()
  function nativeDebuggerSnapshot(wanted = [...debuggerPorts], tracked = [...debuggerIdentities.values()]) {
    const code = webviewDebuggerObservationSource({ userDataFolder: env.WEBVIEW2_USER_DATA_FOLDER, ports: wanted, tracked })
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: psChildEnv, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
  }
  function recordDebugger(stage) {
    let evidence
    try { evidence = captureWebviewDebugger({ home, userDataFolder: env.WEBVIEW2_USER_DATA_FOLDER, runtimePath: report.webviewRuntime.path, snapshot: nativeDebuggerSnapshot, ports: debuggerPorts, identities: debuggerIdentities, expected: report.webviewDebugger }); report.webviewDebugger ||= evidence; return evidence }
    catch (e) { report.debuggerGap = String(e.message); evidence = e.debuggerEvidence || { gap: report.debuggerGap }; throw e }
    finally { (report.debuggerAttempts ||= []).push({ stage, evidence }); fs.writeFileSync(path.join(output, stage + '.json'), JSON.stringify(evidence, null, 2)); save() }
  }
  async function ipc(cmd, args, timeout) {
    const receipt = { cmd, ok: false, at: new Date().toISOString() }; report.ipc.push(receipt)
    try { const value = await client.ipc(cmd, args, timeout); receipt.ok = true; return value } finally { save() }
  }
  function runtimeHead(expected = OLD_RUNTIME.commit) {
    const r = spawnSync('git', ['--no-optional-locks', '-C', path.join(env.HERMES_HOME, 'hermes-agent'), 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), expected, 'runtime source HEAD已变化/升级'); return r.stdout.trim()
  }
  async function compatibilityCheck(phase) {
    const state = await ipc('check_hermes'), commit = runtimeHead()
    assert.equal(state.installed, true); assert.equal(state.version, OLD_RUNTIME.version); assert.equal(nativePath(state.hermesHome), nativePath(env.HERMES_HOME))
    report.compatibility.runtimeChecks.push({ phase, installed: state.installed, version: state.version, commit, hermesHome: state.hermesHome, at: new Date().toISOString() }); save()
  }
  const seedMemory = path.join(env.HERMES_HOME, 'memories/qualification.txt')
  let seedMemoryHash
  async function compatibilityHistory() {
    const sessions = await ipc('hermes_sessions_list', { limit: 100 }), list = Array.isArray(sessions) ? sessions : sessions.sessions
    assert.ok(Array.isArray(list) && list.length, '旧seed历史为空')
    const missing = new Set(prior.browser.prompts.map(p => p.reply))
    assert.ok([...missing].every(reply => typeof reply === 'string' && reply.length), '旧seed缺实际完整回复')
    for (const s of list) {
      const detail = JSON.stringify(await ipc('hermes_session_detail', { sessionId: s.id || s.session_id }))
      for (const reply of missing) if (detail.includes(reply)) missing.delete(reply)
      if (!missing.size) break
    }
    assert.equal(missing.size, 0, '新app操控后旧seed完整历史丢失'); report.compatibility.seedHistoryPreserved = true
    assert.equal(hash(seedMemory), seedMemoryHash, '新app损坏旧seed记忆canary'); report.compatibility.seedMemoryPreserved = true; save()
  }
  function runtimeSnapshot() {
    // TCP实际owner与同次CIM身份绑定；仅输出私有HOME进程和所需端口，不枚举泄露全机命令行。
    const code = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString('base64')}'))
$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(app).toString('base64')}'))
$ports=@(${[...ports].join(',')});$tracked=@(${[...watchedIdentities.values()].map(p => p.pid).join(',')})
$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$owned=@($all|Where-Object {$_.ProcessId -ne $PID -and $_.ExecutablePath -ne $a -and $_.Name -ne 'msedgewebview2.exe' -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($h+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($h+'\\',[StringComparison]::OrdinalIgnoreCase) -ge 0))})
function Row($p){if(!$p -or !$p.CreationDate){throw 'missing CIM identity'};[pscustomobject]@{pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');executablePath=$p.ExecutablePath;commandLine=$(if($owned.ProcessId -contains $p.ProcessId){$p.CommandLine}else{$null})}}
$listeners=@(Get-NetTCPConnection -ErrorAction Stop|Where-Object {$_.State -eq 'Listen' -and $ports -contains [int]$_.LocalPort}|Sort-Object LocalPort,OwningProcess -Unique|ForEach-Object {$c=$_;$p=$all|Where-Object {$_.ProcessId -eq $c.OwningProcess}|Select-Object -First 1;$r=Row $p;$r|Add-Member -NotePropertyName port -NotePropertyValue ([int]$c.LocalPort);$r})
[pscustomobject]@{processes=@($owned|ForEach-Object {Row $_});listeners=$listeners;present=@($all|Where-Object {$tracked -contains [int]$_.ProcessId}|ForEach-Object {Row $_})}|ConvertTo-Json -Depth 6 -Compress`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: psChildEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    const data = JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
    for (const p of data.processes) {
      assertIdentity(p); assert.ok(privateProcess(p, home), 'runtime 身份越出私有 HOME')
      watchedIdentities.set(identityKey(p), p)
    }
    // 首次出现的私有进程也必须计入本次存活回读，不能等下次才观察。
    data.present = [...new Map([...data.present, ...data.processes].map(p => [identityKey(p), p])).values()]
    return data
  }
  function captureListeners(port) {
    const rows = runtimeSnapshot().listeners.filter(p => p.port === port)
    assertNativeListeners(rows, { home, ports: [port] })
    for (const p of rows) watchedIdentities.set(identityKey(p), p)
    activeListeners.set(port, rows)
    return rows
  }
  function applicationPids() {
    const a = Buffer.from(app).toString('base64'), u = Buffer.from(env.WEBVIEW2_USER_DATA_FOLDER).toString('base64')
    const code = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${a}'));$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${u}'));@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and ($_.ExecutablePath -eq $a -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.Contains($u)))}|Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})|ConvertTo-Json -Compress`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: psChildEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    const rows = r.stdout.trim() ? JSON.parse(r.stdout.replace(/^\uFEFF/, '')) : []
    return (Array.isArray(rows) ? rows : [rows]).filter(p => nativePath(p.ExecutablePath) === nativePath(app) || report.webviewRuntime && nativePath(p.ExecutablePath) === nativePath(report.webviewRuntime.path) && debugArgs(p.CommandLine, 'user-data-dir').some(v => [env.WEBVIEW2_USER_DATA_FOLDER, path.join(env.WEBVIEW2_USER_DATA_FOLDER, 'EBWebView')].some(dir => nativePath(dir) === nativePath(v))))
  }
  async function observe(item) {
    const seen = await client.script(`const k='__CLAWPANEL_HERMES_QUALIFICATION_ERRORS__';if(!window[k]){window[k]=[];addEventListener('error',e=>window[k].push(String(e.error?.stack||e.message).slice(0,4000)));addEventListener('unhandledrejection',e=>window[k].push(String(e.reason?.stack||e.reason).slice(0,4000)))}return window[k].splice(0);`)
    item.observedErrors.push(...seen); assert.deepEqual(item.observedErrors, [], 'native 交互期间存在未处理错误')
  }
  async function refresh(item) {
    await observe(item)
    const gap = { requestedAt: new Date().toISOString(), listenersReinstalledAt: null }
    item.errorObservationGaps.push(gap); save()
    await client.command('POST', '/refresh', {})
    await observe(item)
    gap.listenersReinstalledAt = new Date().toISOString(); save()
  }
  const processExists = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  async function stop() {
    assert.ok(client?.session, '缺少 native session，不能证明生产 STOP')
    let gatewayStopped = false, dashboardStopped = false
    const failures = await runNativeCleanup({
      beforeStop: async () => {
        const snapshot = runtimeSnapshot()
        for (const [port, expected] of activeListeners) assertNativeListeners(snapshot.listeners.filter(p => p.port === port), { home, ports: [port], expected })
      },
      gatewayStop: async () => { await ipc('hermes_gateway_action', { action: 'stop' }); gatewayStopped = true },
      dashboardStop: async () => { await ipc('hermes_dashboard_stop'); dashboardStopped = true },
      runtimeStopped: async () => { report.cleanup = await verifyRuntimeStopped(gatewayStopped && dashboardStopped); save() },
    })
    report.stopAttempts ||= []; report.stopAttempts.push({ at: new Date().toISOString(), gatewayStopped, dashboardStopped, failures }); save()
    assert.deepEqual(failures, [], '生产 STOP/身份或端口清理失败')
    activeListeners.clear()
    return structuredClone(report.cleanup)
  }
  async function verifyRuntimeStopped(productionStop) {
    let result
    await until(async () => {
      const snapshot = runtimeSnapshot()
      const reachablePorts = (await Promise.all([...ports].map(async port => await reachable(port) ? port : null))).filter(Boolean)
      result = { productionStop, identities: [...watchedIdentities.values()], present: snapshot.present, listeners: snapshot.listeners, ports: [...ports], reachablePorts, pidsExited: false, portsClosed: false }
      result.pidsExited = !result.present.some(p => watchedIdentities.has(identityKey(p)))
      result.portsClosed = !result.listeners.length && !reachablePorts.length
      report.lastRuntimeReadback = result; save()
      return result.pidsExited && result.portsClosed
    }, 30000)
    assertNativeStopped(result)
    return result
  }
  try {
    if (compatibility) { runtimeHead(); assert.equal(fs.readFileSync(seedMemory, 'utf8'), o['--seed-sha'], 'seed记忆canary不匹配'); seedMemoryHash = hash(seedMemory) }
    provider = await createNativeProvider({ report, save, runtimePin: compatibility ? OLD_RUNTIME.commit : release.commit })
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); providerPort = provider.address().port
    driverPort = await freePort(); nativePort = await freePort()
    report.webviewRuntime = readNativeDebuggerRuntime({ webOutput, driver: o['--driver'], nativeDriver: o['--native-driver'], candidateSha: prior.candidateSha }); save()
    const driverEnv = nativeDriverChildEnv(env)
    report.driverEnvSubmission = nativeDriverEnvSubmission(driverEnv)
    fs.writeFileSync(path.join(output, 'driver-env-submission.json'), JSON.stringify(report.driverEnvSubmission, null, 2)); save()
    const log = fs.openSync(path.join(output, 'driver.log'), 'a')
    driver = spawn(physical(o['--driver']), ['--port', String(driverPort), '--native-port', String(nativePort), '--native-driver', physical(o['--native-driver'])], { env: driverEnv, windowsHide: true, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    let spawnError; driver.once('error', e => { spawnError = e })
    await until(async () => { if (spawnError) throw spawnError; return await reachable(driverPort) }, 30000)
    client = new NativeWebDriver(`http://127.0.0.1:${driverPort}`, { compatibility })
    const launch = { application: app, envUserDataFolder: env.WEBVIEW2_USER_DATA_FOLDER, before: webviewProfileMetadata({ home, userDataFolder: env.WEBVIEW2_USER_DATA_FOLDER }) }; report.sessionLaunch = launch; save()
    let sessionFailure, debuggerFailure
    try { report.webdriver = await client.create(app, env.WEBVIEW2_USER_DATA_FOLDER) } catch (e) { sessionFailure = e; throw e } finally {
      launch.requestedCapabilities = client.requestedCapabilities || null; launch.sessionCreated = !!client.session
      try { launch.after = webviewProfileMetadata({ home, userDataFolder: env.WEBVIEW2_USER_DATA_FOLDER }) } catch (e) { launch.metadataError = String(e) }
      try { recordDebugger('debugger-after-session') } catch (e) { debuggerFailure = e; launch.debuggerGap = String(e.message) }
      fs.writeFileSync(path.join(output, 'session-launch.json'), JSON.stringify(launch, null, 2)); save(); if (debuggerFailure && !sessionFailure) throw debuggerFailure
    }
    if (compatibility) report.compatibility.blockedInstallerCommands = client.blockedInstallerCommands
    const startedApps = applicationPids(); assert.ok(startedApps.some(p => p.ExecutablePath.toLowerCase() === app.toLowerCase()), '没有实际 ClawPanel.exe 进程')
    report.application.processes = startedApps
    for (const p of startedApps) nativePids.add(p.ProcessId)
    report.nativePage = await client.script('return {url:location.href,ipc:!!window.__TAURI__?.core?.invoke && !!window.__TAURI_INTERNALS__?.invoke,windowLabel:window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label}')
    assertNativePage(report.nativePage)
    const resolved = await ipc('get_openclaw_dir'); assertNativeConfigDir(resolved, panelDir)
    const status = await ipc('check_hermes'); assert.equal(status.installed, true); assert.equal(status.version, o['--version'])
    if (compatibility) await compatibilityCheck('before-ui')
    const gatewayPort = await freePort(); ports.add(gatewayPort); report.gatewayPort = gatewayPort
    await ipc('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' })
    await ipc('hermes_env_set', { key: 'API_SERVER_PORT', value: String(gatewayPort) })
    await ipc('hermes_set_gateway_url', { url: `http://127.0.0.1:${gatewayPort}` })
    for (let round = 1; round <= 2; round++) {
      const item = { round, steps: [], samples: [], prompts: [], observedErrors: [], errorObservationGaps: [], stopProofs: [] }; report.rounds.push(item); save()
      await observe(item)
      const model = round === 1 ? 'native-one' : 'native-two'
      await ipc('configure_hermes', { provider: 'custom', apiKey: 'qualification-native-no-secret', model, baseUrl: `http://127.0.0.1:${providerPort}/v1` })
      await ipc('hermes_gateway_action', { action: 'start' }); assertNativeHealth(await ipc('hermes_health_check'), o['--version'])
      item.gatewayListeners = captureListeners(gatewayPort)
      await client.script("location.hash='/h/chat'; return true")
      await until(() => client.script('return !!document.querySelector("#hm-chat-input") && !!document.querySelector(".hm-chat-gw-status.is-online")'))
      item.steps.push('native-window-rust-ipc-gateway-online')
      const send = async () => {
        const nonce = 'native-acceptance-' + crypto.randomUUID(), reply = `原生完整回复：${nonce}；模型：${model}。`
        item.prompts.push({ nonce, model }); await client.send(nonce)
        await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]), 120000)
        return reply
      }
      const reply = await send(); item.steps.push('actual-native-send-button-complete-reply')
      const sessionId = await client.script('return document.querySelector(".hm-chat-session-item.is-active")?.dataset.sid')
      assert.ok(sessionId, 'native UI 缺当前真实会话 ID'); item.sessionId = sessionId
      await refresh(item)
      await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]))
      item.steps.push('native-refresh-restores-real-history')
      await collectNativeSamples({ item, version: o['--version'], home, port: gatewayPort, expected: item.gatewayListeners,
        sample: async () => ({ health: await ipc('hermes_health_check'), listeners: runtimeSnapshot().listeners.filter(p => p.port === gatewayPort) }),
        onSample: async () => { await observe(item); save() },
      })
      assert.ok(item.elapsedSeconds >= 210); item.steps.push('native-sustained-210s-42-health')
      item.stopProofs.push(await stop()); item.steps.push('native-production-stop-pid-and-port')
      await ipc('hermes_gateway_action', { action: 'start' })
      assertNativeHealth(await ipc('hermes_health_check'), o['--version']); captureListeners(gatewayPort)
      await refresh(item)
      await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]))
      item.steps.push('native-restart-keeps-history')
      await send(); item.steps.push('native-post-restart-full-reply')
      item.profiles = await ipc('hermes_profiles_list'); assertNativeProfiles(item.profiles)
      const beforeDash = await ipc('hermes_dashboard_probe'); assert.ok(validPort(beforeDash.port), 'Dashboard 缺少实际端口'); ports.add(beforeDash.port)
      const dash = await ipc('hermes_dashboard_start'); assert.equal(dash.started, true)
      const probe = await ipc('hermes_dashboard_probe'); assert.ok(probe.running || probe.reachable || probe.status === 'running', 'native Dashboard 未真实就绪')
      assert.equal(probe.port, beforeDash.port, 'Dashboard 实际端口发生漂移'); captureListeners(probe.port)
      item.stopProofs.push(await stop()); item.steps.push('native-dashboard-profiles-stop-and-data-retained')
      const detail = await ipc('hermes_session_detail', { sessionId })
      assert.ok(item.prompts.every(p => JSON.stringify(detail).includes(`原生完整回复：${p.nonce}；模型：${model}。`)), 'native 停止后实际 CLI 历史缺完整回复')
      item.historyReadbackAfterStop = true
      await observe(item); await client.screenshot(path.join(output, `round-${round}.png`)); save()
      if (compatibility) await compatibilityCheck(`after-round-${round}`)
    }
    for (const prompt of report.rounds.flatMap(x => x.prompts)) assert.equal(report.provider.filter(x => x.nonce === prompt.nonce && x.model === prompt.model && !x.title).length, 1, 'native 聊天请求缺失/重放')
    assert.ok(!report.providerError)
    // 两轮原生聊天全部完成后，安装生命周期之前：实际named profile，不以default列表补绿。
    report.profileRuntimeSource = { version: release.version, commit: release.commit, headBefore: runtimeHead(release.commit), headAfter: null, privateCompletionSha256: hash(path.join(webOutput, 'privatecompletion.json')) }
    const bindArtifact = (value, directory, kind) => {
      const reportFile = kind === 'named-profile' ? 'profile-qualification.json' : 'profile-collision.json'
      const original = read(path.join(directory, reportFile)); assert.deepEqual(original, value, 'helper原始JSON与返回值不一致')
      const binding = { scope: 'actual-native-profile-artifact', toolingSha: report.tooling.sha, sourceCommit: release.commit, version: release.version, home, kind, directory: path.relative(output, directory).replaceAll('\\', '/'), moduleHashes: Object.fromEntries(TOOLING_FILES.map(f => [f, toolingBefore.files[f].sha256])), reportFile, reportSha256: hash(path.join(directory, reportFile)), envelopeFile: 'native-bound.json' }
      const envelope = path.join(directory, binding.envelopeFile)
      fs.writeFileSync(envelope, JSON.stringify({ schemaVersion: 1, ...binding, report: original }, null, 2))
      return { ...original, nativeBinding: { ...binding, envelopeSha256: hash(envelope) } }
    }
    report.namedProfiles = []
    const defaultProfileOutput = path.join(output, 'named-profile-ui-default')
    const defaultNamed = await qualifyHermesProfiles({ ipc, client, output: defaultProfileOutput, home, version: o['--version'], expectedCommit: release.commit, defaultSessionId: report.rounds.at(-1).sessionId, provider: 'custom', model: 'native-two', gatewayPort, runtimeSnapshot, cloneFromDefault: true, noSkills: false })
    report.namedProfiles.push(bindArtifact(defaultNamed, defaultProfileOutput, 'named-profile')); save()
    assert.equal(defaultNamed.status, 'passed', JSON.stringify(defaultNamed.errors))
    const noSkillsOutput = path.join(output, 'named-profile-no-skills')
    const noSkillsNamed = await qualifyHermesProfiles({ ipc, client, output: noSkillsOutput, home, version: o['--version'], expectedCommit: release.commit, defaultSessionId: report.rounds.at(-1).sessionId, provider: 'custom', model: 'native-two', gatewayPort, runtimeSnapshot, cloneFromDefault: true, noSkills: true })
    report.namedProfiles.push(bindArtifact(noSkillsNamed, noSkillsOutput, 'named-profile')); save()
    assert.equal(noSkillsNamed.status, 'passed', JSON.stringify(noSkillsNamed.errors))
    report.profileCollisionDerivations = []
    const deriveTaskName = async input => {
      assert.equal(nativePath(input.home), nativePath(home)); assert.equal(input.sourceCommit, release.commit)
      const spec = buildNativeTaskNameCommand({ root, home, release, completion, profileHome: input.profileHome })
      assert.equal(nativePath(env.HERMES_HOME), nativePath(spec.ownerHome)); assert.equal(nativePath(env.HOME), nativePath(home))
      if (spec.helperSha256) assert.equal(spec.helperSha256, sources['scripts/hermes-pm-runtime.js'], 'LAUNCH源码未绑定实际app/source')
      const result = spawnSync(spec.program, spec.args, { env, cwd: spec.source, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
      const index = report.profileCollisionDerivations.length + 1, prefix = `profile-task-name-${index}`
      fs.writeFileSync(path.join(output, prefix + '.stdout.json'), result.stdout || ''); fs.writeFileSync(path.join(output, prefix + '.stderr.log'), result.stderr || String(result.error || ''))
      const d = { profile: input.profile, home, profileHome: input.profileHome, sourceCommit: release.commit, program: spec.program, role: spec.role, exitCode: result.status, commandSha256: sha256(JSON.stringify({ program: spec.program, args: spec.args })), stdoutSha256: hash(path.join(output, prefix + '.stdout.json')), stderrSha256: hash(path.join(output, prefix + '.stderr.log')), privateCompletionSha256: report.profileRuntimeSource.privateCompletionSha256, evidenceKind: 'actual-private-runtime-python' }
      report.profileCollisionDerivations.push(d); save(); assert.equal(result.status, 0, '实际私有Python命名失败；查看独立stderr原件')
      const actual = JSON.parse(result.stdout.trim())
      assert.equal(actual.method, 'original-get_task_name'); assert.equal(nativePath(actual.profileHome), nativePath(spec.profileHome))
      assert.equal(nativePath(fs.realpathSync(physical(actual.python))), nativePath(fs.realpathSync(spec.expectedPython)), '命名未使用已验证私有Python')
      assert.equal(nativePath(physical(actual.sourceFile)), nativePath(spec.expectedSourceFile), '原命名函数来源不是固定私有source')
      Object.assign(d, { taskName: actual.taskName, python: actual.python, sourceFile: actual.sourceFile, programSha256: hash(spec.program), pythonSha256: hash(actual.python), sourceFileSha256: hash(actual.sourceFile) }); save()
      return { taskName: actual.taskName, profileHome: actual.profileHome, method: actual.method, python: actual.python, sourceCommit: release.commit }
    }
    const collisionOutput = path.join(output, 'profile-collision')
    const collision = await qualifyHermesProfileCollision({ ipc, client, home, output: collisionOutput, proof, version: release.version, expectedCommit: release.commit, deriveTaskName })
    report.profileCollision = bindArtifact(collision, collisionOutput, 'collision'); save()
    assert.equal(collision.status, 'passed-windows-profile-collision', JSON.stringify(collision.errors))
    report.profileRuntimeSource.headAfter = runtimeHead(release.commit)
    captureListeners(gatewayPort)
    const profileDash = await ipc('hermes_dashboard_probe'); assert.ok(validPort(profileDash.port)); ports.add(profileDash.port); captureListeners(profileDash.port)
    report.namedProfileStopProof = await stop(); save()
    assertNativeNamedProfiles(report); assertNativeProfileCollision(report)
    await observe(report.rounds.at(-1))
    if (compatibility) { await compatibilityHistory(); await compatibilityCheck('after-ui') }
    else {
    // Web 冷安装证明不代替 Rust 安装链：同 HOME 实际更新、保留数据卸载和重装。
    // 安装阶段只订阅真实 Tauri 事件；不修改产品命令、权限或时间上限。
    const listen = await client.command('POST', '/execute/async', {
      script: `const done=arguments[arguments.length-1];window.__HERMES_NATIVE_INSTALL_EVENTS__=[];Promise.all(['hermes-install-log','hermes-install-progress'].map(name=>window.__TAURI__.event.listen(name,e=>window.__HERMES_NATIVE_INSTALL_EVENTS__.push({name,payload:e.payload,at:new Date().toISOString()})))).then(()=>done(true),e=>done({error:String(e)}));`, args: [],
    })
    assert.equal(listen, true, '缺少真实安装事件订阅')
    report.nativeInstallerLifecycle = []
    const memory = path.join(env.HERMES_HOME, 'memories/native-qualification.txt')
    fs.mkdirSync(path.dirname(memory), { recursive: true }); fs.writeFileSync(memory, o['--sha'])
    const memoryHash = hash(memory)
    const verifyData = async (installed) => {
      assert.equal(hash(memory), memoryHash, 'Rust 安装生命周期损坏记忆')
      assert.equal((await ipc('hermes_read_config')).model_raw, 'native-two', 'Rust 安装生命周期覆盖模型配置')
      assert.equal((await ipc('check_hermes')).installed, installed)
      if (installed) {
        assert.equal((await ipc('check_hermes')).version, o['--version'])
        const head = spawnSync('git', ['--no-optional-locks', '-C', path.join(env.HERMES_HOME, 'hermes-agent'), 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
        assert.equal(head.status, 0); assert.equal(head.stdout.trim(), release.commit, 'Rust 安装源码 pin 不符')
        for (const round of report.rounds) {
          const history = JSON.stringify(await ipc('hermes_session_detail', { sessionId: round.sessionId }))
          assert.ok(round.prompts.every(p => history.includes(`原生完整回复：${p.nonce}；模型：${p.model}。`)), 'Rust 安装生命周期损坏真实历史')
        }
      }
    }
    for (const name of ['update', 'uninstall', 'reinstall']) {
      const item = { name, passed: false, dataPreserved: false, startedAt: new Date().toISOString() }
      report.nativeInstallerLifecycle.push(item); save()
      await client.script('window.__HERMES_NATIVE_INSTALL_EVENTS__=[];return true')
      try {
        if (name === 'update') await ipc('update_hermes', {}, 900000)
        else if (name === 'uninstall') await ipc('uninstall_hermes', { cleanConfig: false })
        else await ipc('install_hermes', { method: 'uv-tool', extras: [] }, 900000)
        await verifyData(name !== 'uninstall'); item.dataPreserved = true
        if (name !== 'uninstall') {
          const events = await client.script('return window.__HERMES_NATIVE_INSTALL_EVENTS__')
          const stages = events.filter(e => e.name === 'hermes-install-log' && String(e.payload).startsWith('▶ Hermes 官方安装阶段: ')).map(e => String(e.payload).split(': ').at(-1))
          assert.deepEqual(stages, release.stages, '真实 Rust 安装阶段缺失/顺序不同')
        }
        item.passed = true
      } finally {
        item.events = await client.script('return window.__HERMES_NATIVE_INSTALL_EVENTS__')
        item.finishedAt = new Date().toISOString(); save()
      }
    }
    }
    await ipc('hermes_gateway_action', { action: 'start' })
    assertNativeHealth(await ipc('hermes_health_check'), o['--version']); captureListeners(gatewayPort)
    await stop()
    report.completed = true
  } catch (e) { report.error = e.stack; }
  finally {
    report.cleanupFailures = await runNativeCleanup({
      screenshot: async () => { if (client?.session) await client.screenshot(path.join(output, 'final.png')) },
      productionStop: async () => { if (client?.session) await stop() },
      applicationSnapshot: async () => { for (const p of applicationPids()) nativePids.add(p.ProcessId) },
      debuggerBefore: async () => { if (report.sessionLaunch) recordDebugger('debugger-before-cleanup') },
      sessionClose: async () => { if (client?.session) await client.close() },
      driver: async () => {
        if (driver?.pid) {
          const killed = spawnSync('taskkill.exe', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
          report.driverCleanup = { pid: driver.pid, exit: killed.status }
        }
      },
      provider: async () => { if (provider) { provider.closeAllConnections(); await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) } },
      panelRestore: async () => { fs.writeFileSync(panelPath, originalPanel) },
      sourceFinal: async () => {
        assert.deepEqual(Object.fromEntries(Object.keys(sources).map(f => [f, hash(path.join(root, f))])), sources, 'native源码发生漂移')
        assert.equal(hash(app), report.application.sha256)
        if (compatibility) assert.equal(spawnSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), o['--sha'])
      },
      toolingFinal: async () => {
        report.tooling.after = readNativeToolingSnapshot({ root: toolingRoot, sha: proof.toolingSha })
        assert.deepEqual(report.tooling.after, report.tooling.before, 'harness/qualification/provider/profile/collision字节漂移')
      },
      debuggerKill: async () => {
        const current = nativeDebuggerSnapshot()
        for (const p of current.present) if (debuggerIdentities.has(debugIdentity(p)) && debugPath(p.exe) === debugPath(report.webviewRuntime.path)) spawnSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 30000 })
      },
      nativeKill: async () => {
        // 仅清理实际EXE/私有WebView2，不按名称扫全机；失败不跳过后续核验。
        for (const p of applicationPids()) { nativePids.add(p.ProcessId); const current = applicationPids().find(q => q.ProcessId === p.ProcessId && q.ExecutablePath === p.ExecutablePath); if (current && p.CreationDate === current.CreationDate) spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 30000 }) }
      },
      nativeFinal: async () => {
        await until(() => [...nativePids].every(pid => !processExists(pid)), 30000)
        report.nativeProcessesExited = true; report.nativePids = [...nativePids]
      },
      runtimeFinal: async () => {
        const final = await verifyRuntimeStopped(report.cleanup?.productionStop === true)
        report.cleanup.final = final
      },
      debuggerFinal: async () => {
        if (!report.sessionLaunch) return
        const observed = report.debuggerAttempts?.findLast(x => x.evidence?.identities?.length && x.evidence?.ports?.length)?.evidence
        const after = nativeDebuggerSnapshot(); fs.writeFileSync(path.join(output, 'debugger-after-cleanup.json'), JSON.stringify(after, null, 2)); assertWebviewDebuggerClosed(observed, after)
        report.webviewDebuggerCleanup = after
      },
      portsFinal: async () => {
        const allPorts = [...new Set([...ports, ...debuggerPorts, driverPort, nativePort, providerPort].filter(Boolean))]
        await until(async () => (await Promise.all(allPorts.map(reachable))).every(v => !v), 30000)
        report.driverPortsClosed = true; report.allFinalPorts = allPorts
      },
      compatibilityFinal: async () => {
        if (compatibility) { report.compatibility.finalRuntimeHead = runtimeHead(); assert.equal(hash(seedMemory), seedMemoryHash, '最终旧seed记忆canary变化') }
      },
      hostFinal: async () => {
        const after = qualification.hostSnapshot(proof); fs.writeFileSync(path.join(output, 'host-after.json'), JSON.stringify(after, null, 2)); qualification.assertHostUnchanged(before, after); report.hostUnchanged = true
      },
      commandsArtifact: async () => { if (client) fs.writeFileSync(path.join(output, 'webdriver-commands.json'), JSON.stringify(client.events, null, 2)) },
    })
    if (report.cleanupFailures.length) report.cleanupError = JSON.stringify(report.cleanupFailures)
    report.finishedAt = new Date().toISOString()
    try { if (compatibility) { report.status = COMPATIBILITY_STATUS; assertNativeCompatibilityComplete(report) } else { assertNativeComplete(report); report.status = 'passed-native-tauri' } } catch (e) { report.status = 'failed'; report.gateError = String(e) }
    save()
  }
  console.log(JSON.stringify({ status: report.status, sha: o['--sha'], rounds: report.rounds.length, output }))
  return report.status === (compatibility ? COMPATIBILITY_STATUS : 'passed-native-tauri') ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const o = nativeArgs(process.argv.slice(2)); if (!o['--execute']) console.log(JSON.stringify(nativePlan(o))); else process.exitCode = await execute(o) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
