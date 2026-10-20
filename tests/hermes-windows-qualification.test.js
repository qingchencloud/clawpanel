import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { createHermesExecFileObserver } from '../scripts/hermes-exec-observation.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = path.join(root, 'scripts/test-hermes-windows-qualification.mjs')
const load = () => import('../scripts/test-hermes-windows-qualification.mjs')

test('新旧 Windows 各自一次性 VM 有界并行，同平台 run 互斥及私有 HOME 保留', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  assert.equal(w.jobs.qualify.strategy['max-parallel'], 2)
  assert.equal(w.concurrency['cancel-in-progress'], false)
  assert.equal(w.concurrency.group, 'hermes-qualification-${{ inputs.platform }}')
  assert.equal(w.jobs.qualify['runs-on'], 'windows-2025')
  assert.match(JSON.stringify(w.jobs.qualify.steps), /hermes-qualification-.*VARIANT/)
})
const sha = 'a'.repeat(40)
const proof = () => ({ platform: 'win32', runnerEnvironment: 'github-hosted', runnerOS: 'Windows', arch: 'x64', event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'qingchencloud/clawpanel', workflowRef: 'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main', workflowSha: sha, toolingSha: sha, runId: '1234', attempt: '1', imageOS: 'win25', imageVersion: '20261016.1', virtualMachine: true, actualProfile: 'C:\\Users\\runneradmin', registeredProfile: 'C:\\Users\\runneradmin', userName: 'runneradmin', sid: 'S-1-5-21-1-2-3-1001' })

test('资格计划固定五阶段，实际安装协议及原生证据另立门禁', async () => {
  const q = await load()
  assert.deepEqual(q.STAGES, ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'])
  const r = spawnSync(process.execPath, [script, '--plan'], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  const plan = JSON.parse(r.stdout)
  assert.equal(plan.installsOnLocalHost, false)
  assert.equal(plan.nativeTauriRequiredForFullQualification, true)
  assert.equal(plan.candidateSecrets, false)
  assert.equal(plan.retries, 0)
})

test('参数拒绝浮动或注入 SHA、未知参数和不精确版本', async () => {
  const q = await load()
  for (const bad of ['main', 'a'.repeat(7), `${sha}\n`, `${sha};echo x`]) assert.throws(() => q.parseArgs(['--sha', bad]), /SHA/)
  assert.throws(() => q.parseArgs(['--force']), /未知/)
  assert.throws(() => q.parseArgs(['--version', 'latest']), /版本/)
  assert.throws(() => q.parseArgs(['--variant', 'anything']), /variant/)
})

test('真实 runner 资格拒绝宿主、伪装环境、自托管、非 main、fork 和非手工入口', async t => {
  const { validateRunnerProof } = await load()
  assert.doesNotThrow(() => validateRunnerProof(proof()))
  for (const [name, patch] of Object.entries({ host: { platform: 'linux' }, selfHosted: { runnerEnvironment: 'self-hosted' }, pr: { event: 'pull_request' }, branch: { ref: 'refs/heads/wip' }, fork: { repository: 'other/clawpanel' }, otherWorkflow: { workflowRef: 'qingchencloud/clawpanel/.github/workflows/maintenance.yml@refs/heads/main' }, mismatch: { toolingSha: 'b'.repeat(40) }, notVM: { virtualMachine: false }, realUser: { actualProfile: 'C:\\Users\\keh5', registeredProfile: 'C:\\Users\\keh5' }, spoofedHome: { registeredProfile: 'C:\\Users\\someone' }, missingSid: { sid: '' }, missingImage: { imageVersion: '' } })) {
    await t.test(name, () => assert.throws(() => validateRunnerProof({ ...proof(), ...patch }), /资格/))
  }
})

test('隔离 env 白名单不继承凭据或双重大小写 PATH，所有用户目录私有化', async () => {
  const { isolationEnv } = await load()
  const home = path.join(root, '.tmp/qualification-env-only/home')
  const env = isolationEnv({ home, temp: path.join(root, '.tmp/qualification-env-only/temp'), parent: { PATH: 'C:\\Windows', Path: 'poison', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret', SSH_AUTH_SOCK: 'secret', NODE_OPTIONS: '--require poison', PYTHONPATH: 'poison', NPM_CONFIG_PREFIX: 'poison' } })
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HERMES_HOME', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) assert.ok(path.relative(home, env[key]) === '' || !path.relative(home, env[key]).startsWith('..'), key)
  assert.equal(Object.keys(env).filter(k => k.toLowerCase() === 'path').length, 1)
  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(env[key], undefined)
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.PYTHONNOUSERSITE, '1')
})

test('HKCU/HKLM PATH 类型、shell 和 global launcher 任一改变均失败，不自动恢复', async () => {
  const { assertHostUnchanged } = await load()
  const before = { registry: [{ hive: 'HKCU', name: 'Path', kind: 'ExpandString', sha256: 'a' }], shells: [{ path: 'profile.ps1', exists: false }], launchers: [{ path: 'hermes.exe', exists: false }], parentEnvSha256: 'x' }
  assert.doesNotThrow(() => assertHostUnchanged(before, structuredClone(before)))
  for (const patch of [{ registry: [{ ...before.registry[0], kind: 'String' }] }, { shells: [{ path: 'profile.ps1', exists: true }] }, { launchers: [{ path: 'hermes.exe', exists: true }] }, { parentEnvSha256: 'y' }]) assert.throws(() => assertHostUnchanged(before, { ...before, ...patch }), /宿主/)
})

test('private completion 要求真实 CLI/模块路径、commit、阶段成功，不接受 installed=true 自述', async () => {
  const { validatePrivateCompletion } = await load()
  const home = path.resolve(root, '.tmp/private-proof')
  const receipt = { version: '0.21.5', commit: sha, cli: path.join(home, 'bin/hermes.exe'), python: path.join(home, 'venv/python.exe'), modules: { 'hermes_cli.main': path.join(home, 'src/main.py'), fastapi: path.join(home, 'venv/fastapi.py'), uvicorn: path.join(home, 'venv/uvicorn.py') }, stages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'].map(name => ({ name, exitCode: 0 })), requiredStages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'] }
  const expected = { home, version: '0.21.5', commit: sha }
  assert.doesNotThrow(() => validatePrivateCompletion(receipt, expected))
  for (const bad of [{ installed: true }, { ...receipt, python: path.resolve(home, '../global/python.exe') }, { ...receipt, stages: receipt.stages.slice(1) }, { ...receipt, stages: receipt.stages.map(s => ({ ...s, exitCode: 1 })) }, { ...receipt, version: '0.22.2' }, { ...receipt, commit: 'b'.repeat(40) }]) assert.throws(() => validatePrivateCompletion(bad, expected), /completion/)
})

test('22.2 五 stage + PM products/preflight，dependency Python 不冒充 selected store', async () => {
  const { validatePrivateCompletion } = await load(), home = path.resolve(root, '.tmp/new-pm-proof'), managed = path.join(home, '.hermes')
  const dependencyPython = path.join(managed, 'installs/key/environments/env/Scripts/python.exe'), store = path.join(managed, 'tools/python/python.exe')
  const requiredStages = ['repository', 'venv', 'python-deps', 'config', 'complete']
  const receipt = { version: '0.22.2', commit: sha, reportedStatusPath: store, python: store, commandSpec: { program: dependencyPython, args: ['-I', '-B', '-c', 'original metadata'], role: 'pm-bootstrap-metadata' }, modules: { 'hermes_cli.main': path.join(managed, 'hermes-agent/hermes_cli/main.py'), fastapi: path.join(managed, 'installs/key/environments/env/fastapi.py'), uvicorn: path.join(managed, 'installs/key/environments/env/uvicorn.py') }, requiredStages, stages: requiredStages.map(name => ({ name, exitCode: 0 })), pm: { dependencyPython, selectedStorePython: store, completion: { commit: sha, current: true, same: true, completed: true, pending: false }, preflight: { commit: sha, current: true, same: true, completed: true, command: ['profile', 'list'] } } }
  const expected = { home, version: '0.22.2', commit: sha }
  assert.doesNotThrow(() => validatePrivateCompletion(receipt, expected))
  for (const bad of [{ ...receipt, pm: undefined }, { ...receipt, python: dependencyPython }, { ...receipt, requiredStages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'] }, { ...receipt, pm: { ...receipt.pm, completion: { ...receipt.pm.completion, pending: true } } }, { ...receipt, pm: { ...receipt.pm, preflight: { ...receipt.pm.preflight, current: false } } }, { ...receipt, commandSpec: undefined }]) assert.throws(() => validatePrivateCompletion(bad, expected), /completion/)
})

test('单次生产 install/update/reinstall 保持900秒，Provider chat/title明确分开', async () => {
  const source = fs.readFileSync(script, 'utf8')
  assert.doesNotMatch(source, /1800000/)
  for (const cmd of ['install_hermes', 'update_hermes']) assert.match(source, new RegExp(`api\\('${cmd}'[^\\n]+900000`))
  const { classifyProviderRequest } = await load()
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'You are a title generator. You output ONLY a thread title. Nothing else.' }] }), 'title')
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'You are Hermes, an AI assistant.' }] }), 'chat')
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'unknown helper task' }] }), 'unattributed')
})

test('API/mock 不能冒充用户 UI，native missing 不能冒充完整资格', async () => {
  const { qualificationStatus } = await load()
  const stages = ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' }))
  const report = { stages, hostUnchanged: true, browser: { actualChromium: true, screenshots: ['a.png'], trace: 'trace.zip', pageErrors: [], completeReply: true, historyAfterReload: true }, nativeTauri: { status: 'not-run' }, gatewayStatusReadback: statusProof() }
  assert.equal(qualificationStatus(report), 'passed-web-native-missing')
  assert.equal(qualificationStatus({ ...report, nativeTauri: { status: 'passed' } }), 'passed-web-native-missing', '外部自述不升级 native 证据')
  for (const bad of [{ ...report, hostUnchanged: false }, { ...report, stages: stages.slice(1) }, { ...report, browser: { ...report.browser, actualChromium: false } }, { ...report, browser: { ...report.browser, pageErrors: ['error'] } }, { ...report, browser: { ...report.browser, historyAfterReload: false } }]) assert.equal(qualificationStatus(bad), 'failed')
})

// R24 原件的最小白名单投影；不是本机重跑 Hermes/VM 的成绩。
function statusProof(value = 'Gateway is running (PID: 8100)') {
  return { schemaVersion: 1, status: 'passed', requestFailed: false,
    api: { cmd: 'hermes_gateway_action', status: 200, result: value },
    exec: [
      { event: 'execFile-start', callId: 5, pid: 8680, utc: '2026-10-16T22:36:18.419Z', command: ['gateway', 'status'] },
      { event: 'execFile-result', callId: 5, pid: 8680, utc: '2026-10-16T22:36:33.415Z', source: 'callback', error: null, code: null, signal: null, killed: false, stdout: value, stdoutTruncated: false },
      { event: 'execFile-close', callId: 5, pid: 8680, utc: '2026-10-16T22:36:33.416Z', error: null, code: 0, signal: null, killed: false },
    ] }
}
function completedWebFixture(gatewayStatusReadback) {
  return { stages: ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' })), hostUnchanged: true,
    browser: { actualChromium: true, screenshots: ['a.png'], trace: 'trace.zip', pageErrors: [], completeReply: true, historyAfterReload: true }, gatewayStatusReadback }
}

const stateNames = ['gateway.pid', 'gateway.lock', 'gateway_state.json']
const stateSha = data => createHash('sha256').update(data).digest('hex')
function stateFixture(t, name) {
  const tmp = fs.realpathSync.native(os.tmpdir()), dir = fs.mkdtempSync(path.join(tmp, 'hermes-status-files-')), home = path.join(dir, 'h'), hermes = path.join(home, '.hermes'), children = [], rows = []
  fs.mkdirSync(hermes, { recursive: true })
  const marker = 'SYNTHETIC_PRIVATE_STATE_DO_NOT_PUBLISH_87da', argv = ['-c', marker, 'gateway', 'run']
  const record = { pid: 5932, kind: 'hermes-gateway', argv, start_time: 1792186376412040, hermes_home: hermes, clawpanel_legacy_identity: { create_time: 1792186376.4120407, script_sha256: 'a'.repeat(64), pin: 'f97608f178d1ffeca59860195ab7da295f7c8e5f', privatecode: marker }, gateway_state: 'running', updated_at: '2026-10-16T22:36:11.000Z', desired_state: 'running', api_key: marker, privatecode: marker, nested: { password: marker } }
  const write = (file, value) => fs.writeFileSync(path.join(hermes, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  for (const file of stateNames) write(file, record)
  const originals = () => Object.fromEntries(stateNames.map(file => { const p = path.join(hermes, file), s = fs.lstatSync(p, { bigint: true }); return [file, { sha256: stateSha(fs.readFileSync(p)), inode: String(s.ino), size: String(s.size), mtime: String(s.mtimeNs), birthtime: String(s.birthtimeNs) }] }))
  t.after(async () => {
    for (const c of children) { c.stdin?.end(); await new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) return resolve(); c.once('close', resolve) }) }
    if (process.env.HERMES_STATE_TEST_EVIDENCE) { fs.mkdirSync(process.env.HERMES_STATE_TEST_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.HERMES_STATE_TEST_EVIDENCE, name + '.json'), JSON.stringify({ scope: 'own private files, no Hermes/VM installation or process identity query', platform: process.platform, node: process.version, rows }, null, 2)) }
    const rel = path.relative(tmp, fs.realpathSync.native(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, home, hermes, record, marker, argv, write, originals, rows, children }
}

test('状态文件首红E2E：仅确切3文件、typed身份/白名单/hash，原字节及mtime不变', async t => {
  const { captureHermesGatewayStateFiles } = await load(), f = stateFixture(t, 'safe-three-files'), before = f.originals()
  fs.writeFileSync(path.join(f.hermes, 'unrelated-private-canary'), f.marker)
  const r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r)
  assert.equal(r.status, 'complete'); assert.equal(r.phase, 'before-status'); assert.deepEqual(r.files.map(row => row.file), stateNames)
  assert.deepEqual(r.limits, { perFileBytes: 65536, totalBytes: 131072 }); assert.equal(r.lockProbe, 'not-performed')
  for (const row of r.files) {
    const bytes = fs.readFileSync(path.join(f.hermes, row.file))
    assert.equal(row.status, 'captured'); assert.equal(row.sha256, stateSha(bytes)); assert.equal(row.bytes, bytes.length)
    assert.equal(row.record.pid, 5932); assert.equal(row.record.kind, 'hermes-gateway'); assert.equal(row.record.argvSha256, stateSha(JSON.stringify(f.argv)))
    assert.equal(row.record.hermesHome.matchesPrivateHome, true); assert.equal(row.record.hermesHome.sha256, stateSha(f.hermes))
    assert.deepEqual(row.record.legacyIdentity, { createTime: f.record.clawpanel_legacy_identity.create_time, scriptSha256: 'a'.repeat(64), pin: f.record.clawpanel_legacy_identity.pin })
    assert.match(row.fileIdentity.inode, /^\d+$/); assert.match(row.fileIdentity.createdNs, /^\d+$/)
  }
  const json = JSON.stringify(r); assert.ok(!json.includes(f.marker)); assert.ok(!json.includes(f.hermes)); assert.ok(!json.includes('privatecode')); assert.ok(!json.includes('api_key'))
  assert.deepEqual(f.originals(), before); assert.equal(fs.readFileSync(path.join(f.hermes, 'unrelated-private-canary'), 'utf8'), f.marker)
})

test('状态文件E2E：原status前后删除/替换按实记录missing与新身份，不补写、不锁定', async t => {
  const { captureHermesGatewayStateFiles, qualificationStatus } = await load(), f = stateFixture(t, 'before-after-missing')
  const before = captureHermesGatewayStateFiles(f.home, 'before-status'); let calls = 0
  try { calls++; fs.unlinkSync(path.join(f.hermes, 'gateway.pid')); throw Error('original status failed') }
  catch (error) { assert.equal(error.message, 'original status failed') }
  finally { f.rows.push(before, captureHermesGatewayStateFiles(f.home, 'after-status')) }
  const after = f.rows[1]; assert.equal(calls, 1); assert.equal(after.status, 'incomplete'); assert.equal(after.files[0].status, 'missing'); assert.equal(after.files[0].reason, 'ENOENT')
  assert.equal(fs.existsSync(path.join(f.hermes, 'gateway.pid')), false)
  assert.equal(qualificationStatus({ ...completedWebFixture(statusProof('unknown')), gatewayStatusFiles: { before, after } }), 'failed', 'status失败不因诊断文件存在而转绿')
  assert.equal(qualificationStatus({ ...completedWebFixture(statusProof('unknown')), gatewayStatusFiles: undefined }), 'failed')
  f.write('gateway.pid', '5932'); const bare = captureHermesGatewayStateFiles(f.home, 'after-status'); f.rows.push(bare)
  assert.equal(bare.files[0].status, 'captured'); assert.equal(bare.files[0].record.format, 'bare-pid'); assert.equal(bare.files[0].record.pid, 5932)
})

test('状态文件E2E：空/畸形JSON/非法UTF8/非record类型均留原因不成功、不泄异常原文', async t => {
  const { captureHermesGatewayStateFiles } = await load(), f = stateFixture(t, 'invalid-records')
  for (const value of ['', f.marker, '[1,2]', 'null', '-4', Buffer.from([0xff, 0xfe])]) {
    f.write('gateway.pid', value); const r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r)
    assert.equal(r.status, 'incomplete'); assert.equal(r.files[0].status, 'invalid-record'); assert.equal(typeof r.files[0].reason, 'string'); assert.ok(!JSON.stringify(r).includes(f.marker))
  }
  f.write('gateway.pid', f.record); fs.rmSync(path.join(f.hermes, 'gateway_state.json')); fs.mkdirSync(path.join(f.hermes, 'gateway_state.json'))
  const directory = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(directory); assert.equal(directory.files[2].status, 'rejected')
})

test('状态文件E2E：file64KiB与phase128KiB硬预算，超限不截断冒成功', async t => {
  const { captureHermesGatewayStateFiles } = await load(), f = stateFixture(t, 'read-budgets')
  f.write('gateway.pid', JSON.stringify({ padding: 'x'.repeat(65536) })); let r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r)
  assert.equal(r.files[0].status, 'over-budget'); assert.equal(r.files[0].reason, 'FILE_BYTES'); assert.equal(r.files[0].bytesRead, 0); assert.equal(r.status, 'incomplete')
  const exact = JSON.stringify({ padding: 'x'.repeat(65536 - 14) }); assert.equal(Buffer.byteLength(exact), 65536)
  f.write('gateway.pid', exact); f.write('gateway.lock', exact); r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r)
  assert.equal(r.files[0].status, 'captured'); assert.equal(r.files[1].status, 'captured'); assert.equal(r.files[2].status, 'over-budget'); assert.equal(r.files[2].reason, 'TOTAL_BYTES'); assert.equal(r.files[2].bytesRead, 0); assert.equal(r.bytesRead, 131072)
})

test('状态文件E2E：file/home链接、junction、硬链接和外部路径均拒绝且canary不变', async t => {
  const { captureHermesGatewayStateFiles } = await load(), f = stateFixture(t, 'link-boundaries'), foreign = path.join(f.dir, 'foreign')
  fs.mkdirSync(foreign); const canary = path.join(foreign, 'gateway.pid'); fs.writeFileSync(canary, f.marker)
  fs.unlinkSync(path.join(f.hermes, 'gateway.pid')); fs.linkSync(canary, path.join(f.hermes, 'gateway.pid'))
  let r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r); assert.equal(r.files[0].status, 'rejected'); assert.equal(fs.readFileSync(canary, 'utf8'), f.marker)
  fs.unlinkSync(path.join(f.hermes, 'gateway.pid')); f.write('gateway.pid', f.record)
  const renamed = path.join(f.home, 'original-hermes'); fs.renameSync(f.hermes, renamed); fs.symlinkSync(foreign, f.hermes, process.platform === 'win32' ? 'junction' : 'dir')
  r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r); assert.equal(r.status, 'incomplete'); assert.ok(r.files.every(row => row.status === 'rejected')); assert.equal(fs.readFileSync(canary, 'utf8'), f.marker)
  r = captureHermesGatewayStateFiles(f.home + path.sep + '..' + path.sep + 'foreign', 'before-status'); f.rows.push(r); assert.equal(r.status, 'incomplete'); assert.ok(r.files.every(row => row.status === 'rejected'))
  assert.throws(() => captureHermesGatewayStateFiles(f.home, 'other-phase'))
})

test('状态文件E2E：Windows真实FileShare.None冲突留read-failed，不试图抢锁或写入', { skip: process.platform !== 'win32' }, async t => {
  const { captureHermesGatewayStateFiles } = await load(), f = stateFixture(t, 'actual-windows-share-conflict'), before = f.originals()
  const file = path.join(f.hermes, 'gateway.lock').replaceAll("'", "''")
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${file}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[Console]::Out.WriteLine('OWN_FILE_LOCK_READY');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); f.children.push(child)
  let stderr = ''; child.stderr.on('data', d => { stderr += d })
  await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => { child.stdin.end(); reject(Error('own share fixture readiness failed')) }, 5000); child.once('error', e => { clearTimeout(timer); reject(e) }); child.stdout.on('data', d => { out += d; if (out.includes('OWN_FILE_LOCK_READY')) { clearTimeout(timer); resolve() } }); child.once('exit', code => { clearTimeout(timer); if (!out.includes('OWN_FILE_LOCK_READY')) reject(Error('own share fixture exit ' + code + ':' + stderr)) }) })
  const r = captureHermesGatewayStateFiles(f.home, 'before-status'); f.rows.push(r); assert.equal(r.status, 'incomplete'); assert.equal(r.files[1].status, 'read-failed'); assert.ok(['EACCES', 'EPERM', 'EBUSY', 'EAGAIN'].includes(r.files[1].reason)); assert.equal(r.lockProbe, 'not-performed')
  child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); assert.deepEqual(f.originals(), before)
})

test('状态文件E2E：原publish仅导出安全投影，真实私有argv/code/env与HOME不公开', async t => {
  const { captureHermesGatewayStateFiles, publishEvidence } = await load(), f = stateFixture(t, 'safe-publication')
  const raw = path.join(f.dir, 'raw'), publicDir = path.join(f.dir, 'public'); fs.mkdirSync(raw)
  const r = { before: captureHermesGatewayStateFiles(f.home, 'before-status'), after: captureHermesGatewayStateFiles(f.home, 'after-status') }
  fs.writeFileSync(path.join(raw, 'gateway-status-files.json'), JSON.stringify(r)); fs.symlinkSync(f.home, path.join(raw, 'h'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await publishEvidence({ roots: { web: raw }, output: publicDir }); f.rows.push({ evidence: r, publication: result })
  const published = fs.readFileSync(path.join(publicDir, 'web/gateway-status-files.json'), 'utf8')
  assert.ok(!published.includes(f.marker)); assert.ok(!published.includes(f.hermes)); assert.deepEqual(JSON.parse(published), r); assert.equal(fs.existsSync(path.join(publicDir, 'web/h')), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'publication-manifest.json'))); assert.equal(manifest.privateHomeUploaded, false); assert.ok(manifest.files.every(row => !row.path.includes('/h/')))
})

test('状态文件接线：VM准入后，原一次status的try/finally两侧取证，不新增查询/预算', () => {
  const source = fs.readFileSync(script, 'utf8')
  assert.ok(source.includes("captureHermesGatewayStateFiles(home, 'before-status')")); assert.ok(source.includes("captureHermesGatewayStateFiles(home, 'after-status')"))
  assert.ok(source.indexOf('validateRunnerProof(proof)') < source.indexOf("captureHermesGatewayStateFiles(home, 'before-status')"))
  const before = source.indexOf("captureHermesGatewayStateFiles(home, 'before-status')"), request = source.indexOf('r.gatewayStatusReadback = await collectGatewayStatusReadback'), after = source.indexOf("captureHermesGatewayStateFiles(home, 'after-status')")
  assert.ok(before < request && request < after && after < source.indexOf('browser = await chromium.launch')); assert.match(source.slice(request, after), /finally/)
  assert.ok(source.includes("write('gateway-status-files.json', r.gatewayStatusFiles)")); assert.equal([...source.matchAll(/api\('hermes_gateway_action', \{ action: 'status' \}\)/g)].length, 1)
  const reader = source.indexOf('export function captureHermesGatewayStateFiles('); assert.ok(reader >= 0)
  const body = source.slice(reader, source.indexOf('\nfunction physical(', reader))
  assert.doesNotMatch(body, /\b(?:spawn|execFile|readdirSync|writeFileSync|mkdirSync|unlinkSync|renameSync|chmodSync|flock)\s*\(/)
  const originalGate = source.replaceAll('\r\n', '\n').match(/export function qualificationStatus\(r\) \{[\s\S]*?\n\}/)[0]
  assert.equal(stateSha(originalGate), '47cbdc43dcfa421eec94ec916dd04e9c3c187a5143358639f19a35728839e510', '纯诊断取证不改48ef资格算法/status硬门禁')
})

test('status漏判first red：R24真实200 unknown与SIGTERM，即使其他UI/生命周期全有效仍FAILED', async () => {
  const { qualificationStatus } = await load(), proof = statusProof('unknown')
  proof.exec[1] = { ...proof.exec[1], error: { name: 'Error', code: null, signal: 'SIGTERM', killed: true }, signal: 'SIGTERM', killed: true, stdout: '✓ Gateway is running (PID: 8100)\r\n  (Running manually, not as a system service)\r\n\r\nTo install as a Windows Scheduled Task (auto-start on login):\r\n  hermes gateway install\r\n' }
  proof.exec[2] = { ...proof.exec[2], code: null, signal: 'SIGTERM', killed: true }
  assert.equal(qualificationStatus(completedWebFixture(proof)), 'failed')
  assert.equal(qualificationStatus({ ...completedWebFixture(proof), nativeTauri: { status: 'passed', qualificationComplete: true } }), 'failed')
  assert.equal(qualificationStatus(completedWebFixture(undefined)), 'failed', '缺少独立status不能借health通过')
})

test('status回读边界：HTTP/空值/unknown/exec错误/缺失/身份与双向输出证据不完整均红', async () => {
  const { assertGatewayStatusReadback, qualificationStatus } = await load()
  assert.doesNotThrow(() => assertGatewayStatusReadback(statusProof()))
  assert.equal(qualificationStatus(completedWebFixture(statusProof())), 'passed-web-native-missing')
  const invalid = [undefined, {}, { ...statusProof(), status: 'failed' }, { ...statusProof(), requestFailed: true }]
  for (const value of ['', '  ', 'unknown', ' UNKNOWN\n', null, false, {}, 'Gateway is not running']) invalid.push(statusProof(value))
  for (const code of [0, 199, 300, 401, 500]) { const p = statusProof(); p.api.status = code; invalid.push(p) }
  for (const change of [r => { r.exec = [] }, r => { r.exec.pop() }, r => { r.exec[2].code = 7 }, r => { r.exec[1].error = { code: 7 } }, r => { r.exec[1].killed = true }, r => { r.exec[2].signal = 'SIGTERM' }, r => { r.exec[2].pid++ }, r => { r.exec[1].stdout = 'different output' }, r => { r.exec[1].stdoutTruncated = true }, r => { r.exec[0].command = ['profile', 'list'] }, r => { r.exec.push({ ...r.exec[2] }) }, r => { r.exec[1].source = 'close-no-callback' }]) { const p = statusProof(); change(p); invalid.push(p) }
  for (const p of invalid) { assert.throws(() => assertGatewayStatusReadback(p)); assert.equal(qualificationStatus(completedWebFixture(p)), 'failed'); assert.equal(qualificationStatus({ ...completedWebFixture(p), diagnostic: { enabled: true } }), 'failed') }
  assert.equal(qualificationStatus({ ...completedWebFixture(statusProof()), diagnostic: { enabled: true } }), 'diagnostic-only-not-qualification')
})

test('status只读接线E2E：单次真实HTTP与own Node exec，失败继续收集但最终红', async t => {
  const { collectGatewayStatusReadback, qualificationStatus } = await load()
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-status-readback-')), children = [], events = [], receipts = [], runs = []
  let mode = 'success', requests = 0
  const server = http.createServer((req, res) => {
    requests++
    const stdout = mode === 'empty' ? '' : 'Gateway is running (PID: 8100)'
    const child = createHermesExecFileObserver(execFile, { write: row => events.push(row) })(process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${mode === 'exec7' ? 7 : 0}`, 'gateway', 'status'],
      { cwd: dir, env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir }, windowsHide: true, timeout: 15000 },
      (error, out) => { res.writeHead(mode === 'http500' ? 500 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(mode === 'unknown' || error ? 'unknown' : out.trim())) })
    child.stdin.end(); children.push({ child, closed: new Promise(resolve => child.once('close', resolve)) })
  })
  t.after(async () => {
    await Promise.all(children.map(row => row.closed)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (process.env.HERMES_STATUS_TEST_EVIDENCE) { fs.mkdirSync(process.env.HERMES_STATUS_TEST_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.HERMES_STATUS_TEST_EVIDENCE, 'status-http-own-child.json'), JSON.stringify({ scope: 'real localhost HTTP/own Node, simulated downstream markers; not Hermes VM/UI qualification', node: process.version, platform: process.platform, requests, runs, ownedChildren: children.map(({ child }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })) }, null, 2)) }
    assert.ok(path.relative(base, dir) && !path.relative(base, dir).startsWith('..')); fs.rmSync(dir, { recursive: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  for (mode of ['success', 'unknown', 'empty', 'exec7', 'http500']) {
    const before = requests, cursor = events.length
    const proof = await collectGatewayStatusReadback({ apiReceipts: receipts, readExecEvents: () => events.slice(cursor), request: async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/__api/hermes_gateway_action`, { method: 'POST', body: JSON.stringify({ action: 'status' }) })
      const result = await response.json(); receipts.push({ cmd: 'hermes_gateway_action', status: response.status, result })
      assert.ok(response.ok && !result?.error)
      return result
    } })
    assert.equal(requests - before, 1, 'status禁止重试/重放')
    const downstream = ['UI evidence collection', 'update-stop collection', 'reinstall collection']
    assert.equal(proof.status, mode === 'success' ? 'passed' : 'failed')
    assert.equal(qualificationStatus(completedWebFixture(proof)), mode === 'success' ? 'passed-web-native-missing' : 'failed')
    assert.equal(downstream.length, 3); runs.push({ mode, proof, downstream })
  }
  const failed = await collectGatewayStatusReadback({ apiReceipts: [], readExecEvents: () => { throw Error('audit unavailable') }, request: async () => { throw Error('transport failed') } })
  assert.equal(failed.status, 'failed'); assert.equal(qualificationStatus(completedWebFixture(failed)), 'failed')
})

test('status接线：原一次status在UI之前独立记录；不扩CLI/安装/浏览器预算、不阻断后续收集', () => {
  const source = fs.readFileSync(script, 'utf8')
  assert.equal([...source.matchAll(/api\('hermes_gateway_action', \{ action: 'status' \}\)/g)].length, 1)
  assert.ok(source.includes('r.gatewayStatusReadback = await collectGatewayStatusReadback'))
  assert.ok(source.indexOf('r.gatewayStatusReadback = await collectGatewayStatusReadback') < source.indexOf('browser = await chromium.launch'))
  assert.ok(source.includes("write('gateway-status-readback.json', r.gatewayStatusReadback)"))
  assert.ok(!source.includes('assertGatewayStatusReadback(r.gatewayStatusReadback);'))
})

test('手工资格 workflow 不绕过 Daily main guard，不写权限/凭据，不运行候选工具', () => {
  const p = path.join(root, '.github/workflows/hermes-qualification.yml')
  const src = fs.readFileSync(p, 'utf8')
  const w = YAML.parse(src)
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch'])
  assert.deepEqual(w.permissions, { contents: 'read' })
  const job = w.jobs.qualify
  assert.equal(job['runs-on'], 'windows-2025')
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/)
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/)
  assert.match(job.if, /github\.repository == 'qingchencloud\/clawpanel'/)
  const checkouts = job.steps.filter(s => s.uses?.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 3)
  for (const step of checkouts) { assert.equal(step.with['persist-credentials'], false); assert.match(step.uses, /@[a-f0-9]{40}$/) }
  assert.equal(checkouts[0].with.path, 'tooling')
  assert.equal(checkouts[0].with.ref, '${{ github.sha }}')
  assert.equal(checkouts[1].with.path, 'candidate')
  assert.equal(checkouts[1].with.ref, '${{ matrix.sha }}')
  assert.equal(checkouts[2].with.path, 'candidate-compat')
  assert.equal(checkouts[2].with.ref, '${{ inputs.candidate_sha }}')
  assert.equal(checkouts[2].if, "matrix.variant == 'old' && inputs.target == 'both' && steps.native.outcome == 'success'")
  assert.doesNotMatch(src, /secrets\.|codex-action|pull_request_target|workflow_call|schedule:|GH_TOKEN|GITHUB_TOKEN|contents: write|id-token: write|git push|Set-ExecutionPolicy/i)
  assert.match(src, /tooling\/scripts\/test-hermes-windows-qualification\.mjs/)
  assert.doesNotMatch(src, /run:.*\$\{\{ inputs\./)
  const daily = fs.readFileSync(path.join(root, '.github/workflows/maintenance.yml'), 'utf8')
  assert.match(daily, /inputs\.runtime_selftest.*github\.repository == 'qingchencloud\/clawpanel'.*github\.ref == 'refs\/heads\/main'/)
  assert.match(daily, /--cap-drop=ALL --security-opt=no-new-privileges/)
})

test('真实宿主 execute 在任何 candidate/install 命令前失败，伪装容器变量也无效', async () => {
  assert.ok(fs.existsSync(script), '先有可信资格入口，红灯阶段不执行候选')
  const tempRoot = fs.realpathSync(os.tmpdir())
  const tmp = fs.mkdtempSync(path.join(tempRoot, 'hermes-qualification-negative-'))
  try {
    const output = path.join(tmp, 'evidence')
    const r = spawnSync(process.execPath, [script, '--execute', '--root', root, '--sha', sha, '--version', '0.22.2', '--variant', 'new', '--output', output], { env: { ...process.env, GITHUB_ACTIONS: 'false', MAINTENANCE_ISOLATED_RUNTIME: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
    assert.equal(report.status, 'failed')
    assert.match(report.error, /资格/)
    assert.deepEqual(report.commands, [])
    assert.equal(report.installerStarted, false)
  } finally {
    const rel = path.relative(tempRoot, fs.realpathSync(tmp))
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Linux 长 UI job 使用原可信容器门禁，fresh11 后同容器同 HOME 两轮 hold210', () => {
  const src = fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8')
  const job = YAML.parse(src).jobs['linux-long-ui']
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'.*github\.ref == 'refs\/heads\/main'/)
  const body = job.steps.map(s => s.run || '').join('\n')
  assert.match(body, /tooling\/\.github\/maintenance\/Runtime\.Dockerfile/)
  assert.match(body, /--user.*--cap-drop=ALL.*--security-opt=no-new-privileges/)
  assert.match(body, /dst=\/tooling,readonly/)
  assert.match(body, /MAINTENANCE_ISOLATED_RUNTIME=1/)
  assert.match(body, /maintenance-runtime-smoke\.mjs.*--output \/tmp\/runtime/)
  assert.match(body, /127\.0\.0\.1::1420/)
  assert.match(body, /--host 0\.0\.0\.0 --port 1420/)
  assert.match(body, /for round in 1 2/)
  assert.match(body, /hermes-qualification-browser\.py.*--base-url.*--output.*--hold 210/)
  assert.match(body, /docker logs/)
  assert.match(body, /docker cp/)
  assert.match(body, /--signal=TERM/)
  assert.doesNotMatch(body, /--privileged|docker\.sock|--network=host|--user root|chmod 777|sudo/)
  assert.doesNotMatch(src, /secrets\.|codex-action|workflow_call|pull_request_target/)
})

test('不同路径源码必须逐文件与 Web git blob SHA256 一致，丢失或改字节失败', async () => {
  const { assertSameSource } = await load(); assert.equal(typeof assertSameSource, 'function')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-source-contract-'))
  try {
    fs.writeFileSync(path.join(tmp, 'one.txt'), 'one\n')
    const { createHash } = await import('node:crypto'), files = { 'one.txt': createHash('sha256').update('one\n').digest('hex') }
    assert.doesNotThrow(() => assertSameSource(tmp, files))
    fs.writeFileSync(path.join(tmp, 'one.txt'), 'one\r\n'); assert.throws(() => assertSameSource(tmp, files), /源码/)
    fs.rmSync(path.join(tmp, 'one.txt')); assert.throws(() => assertSameSource(tmp, files), /源码/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('Windows file URL preload 实际子进程保留 PID、stdout 和非零退出，不吞失败', async () => {
  const { spawnAuditSource } = await load(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-observer-contract-'))
  try {
    const observer = path.join(tmp, 'observer.mjs'), log = path.join(tmp, 'audit.jsonl')
    fs.writeFileSync(observer, spawnAuditSource(log))
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(observer).href, '--input-type=module', '-e', `import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','process.stdout.write("actual-child");process.exitCode=7']);c.stdout.pipe(process.stdout);c.on('close',code=>process.exitCode=code)`], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    assert.equal(r.status, 7, r.stderr); assert.equal(r.stdout, 'actual-child')
    const receipts = fs.readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)); assert.equal(receipts.length, 2)
    assert.equal(receipts[0].event, 'start'); const receipt = receipts[1]; assert.equal(receipt.event, 'close'); assert.equal(receipts[0].pid, receipt.pid); assert.ok(receipt.pid > 0); assert.equal(receipt.exitCode, 7); assert.equal(receipt.stdout, 'actual-child')
    assert.match(fs.readFileSync(script, 'utf8'), /\['--import', pathToFileURL\(audit\)\.href/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('产物仅上传新公开副本，不带 HOME/env/caches，日志与 trace 随机 Gateway key 脱敏且原件保留', async () => {
  const { publishEvidence } = await load(); assert.equal(typeof publishEvidence, 'function')
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermes-publication-contract-'))
  try {
    const raw = path.join(tmp, 'raw'), output = path.join(tmp, 'public'), key = 'random-gateway-contract-7e282ce1234'
    fs.mkdirSync(path.join(raw, 'h/.hermes'), { recursive: true }); fs.mkdirSync(path.join(raw, 'runtime/home'), { recursive: true })
    fs.writeFileSync(path.join(raw, 'h/.hermes/.env'), `API_SERVER_KEY=${key}\n`)
    fs.writeFileSync(path.join(raw, 'runtime/home/private'), key)
    fs.writeFileSync(path.join(raw, 'isolationenv.json'), JSON.stringify({ HOME: raw }))
    fs.writeFileSync(path.join(raw, 'report.json'), JSON.stringify({ status: 'failed', API_SERVER_KEY: key, nonce: 'fake-provider-nonce' }))
    fs.writeFileSync(path.join(raw, 'serve.log'), `Authorization: Bearer ${key}\n`)
    const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.writestr("trace.network",sys.argv[2]);z.close()', path.join(raw, 'trace.zip'), JSON.stringify({ key })], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(py.status, 0, py.stderr)
    await publishEvidence({ roots: { web: raw }, output })
    assert.ok(!fs.existsSync(path.join(output, 'web/h')) && !fs.existsSync(path.join(output, 'web/runtime/home')) && !fs.existsSync(path.join(output, 'web/isolationenv.json')))
    assert.ok(!fs.readFileSync(path.join(output, 'web/report.json'), 'utf8').includes(key))
    assert.ok(fs.readFileSync(path.join(output, 'web/report.json'), 'utf8').includes('fake-provider-nonce'))
    assert.ok(!fs.readFileSync(path.join(output, 'web/serve.log'), 'utf8').includes(key))
    const check = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read("trace.network").decode())', path.join(output, 'web/trace.zip')], { encoding: 'utf8', windowsHide: true }); assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(key))
    assert.ok(fs.readFileSync(path.join(raw, 'serve.log'), 'utf8').includes(key), '原始失败证据不覆盖')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('workflow 只上传脱敏 public 副本，native 严格复用既有资格与快照导出', async () => {
  const q = await load(); assert.equal(typeof q.actualRunnerProof, 'function'); assert.equal(typeof q.hostSnapshot, 'function')
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  for (const job of [w.jobs.qualify, w.jobs['linux-long-ui']]) {
    const publish = job.steps.findIndex(s => s.run?.includes('--publish-evidence') || s.run?.includes('await publishEvidence('))
    const upload = job.steps.findIndex(s => s.uses?.startsWith('actions/upload-artifact@'))
    assert.ok(publish >= 0 && upload > publish)
    assert.equal(job.steps[publish].if, 'always()')
    assert.match(job.steps[upload].with.path, /hermes-public-/)
    assert.doesNotMatch(job.steps[upload].with.path, /hermes-qualification-/)
  }
})

test('Windows workflow 缺 native 接线必须红：Web 后同 SHA 构建，再真实两轮及 Rust lifecycle', () => {
  const src = fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'), w = YAML.parse(src), job = w.jobs.qualify
  assert.equal(job['timeout-minutes'], 120, '3Web+2Rust installer900s 与构建/14min UI 累计预算，不放宽单次安装')
  const steps = job.steps, index = id => steps.findIndex(s => s.id === id)
  for (const id of ['web', 'native_environment', 'native_build', 'native', 'native_summary']) assert.ok(index(id) >= 0, `缺少 ${id} 门禁`)
  assert.ok(index('web') < index('native_environment') && index('native_environment') < index('native_build') && index('native_build') < index('native') && index('native') < index('native_summary'))
  const setup = steps[index('native_environment')].run, build = steps[index('native_build')].run, native = steps[index('native')].run, summary = steps[index('native_summary')]
  for (const body of [setup, build]) { assert.match(body, /actualRunnerProof\(\)/); assert.match(body, /validateRunnerProof\(proof\)/); assert.match(body, /isolationEnv\(/); assert.match(body, /hostSnapshot\(proof\)/); assert.match(body, /assertHostUnchanged\(/) }
  assert.match(setup + build, /passed-web-native-missing/); assert.match(build, /assertSameSource/)
  assert.match(build, /\['ci'\]/); assert.match(build, /'build', '--no-bundle', '--ci', '--', '--locked'/)
  assert.match(build, /'install', 'tauri-driver', '--version', '2\.1\.0', '--locked', '--root'/)
  assert.match(build, /version\.yanked/); assert.match(build, /2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953/)
  assert.match(build, /https:\/\/msedgedriver\.microsoft\.com\/\$\{[^}]+\}\/edgedriver_win64\.zip/)
  assert.match(build, /EdgeUpdate/); assert.match(build, /GetFileVersionInfo|FileVersionInfo/); assert.match(build, /driver-receipt\.json/)
  assert.match(build, /sha256/); assert.match(build, /--version/)
  const cache = steps.find(s => s.uses?.toLowerCase().startsWith('swatinem/rust-cache@'))
  assert.ok(cache); assert.match(cache.uses, /@[a-f0-9]{40}$/); assert.equal(cache.with.workspaces, 'candidate/src-tauri -> target'); assert.equal(cache.with['cache-bin'], false)
  assert.ok(steps.indexOf(cache) > index('native_environment') && steps.indexOf(cache) < index('native_build'))
  for (const value of ['test-hermes-tauri-qualification.mjs --execute', '--root candidate', '--sha', '--version', '--web-output', '--output', '--application', 'candidate/src-tauri/target/release/clawpanel.exe', '--driver', '--native-driver']) assert.ok(native.includes(value), value)
  assert.equal(summary.if, 'always()'); assert.match(summary.run, /assertNativeComplete/); assert.match(summary.run, /passed-native-tauri/); assert.match(summary.run, /process\.exitCode = 1/)
  assert.doesNotMatch(src, /continue-on-error|GITHUB_PATH|Set-ExecutionPolicy|LATEST_RELEASE|selenium|--ignore-version-mismatches|--features.*webdriver|tauri-plugin-webdriver/i)
})

test('native literal Git blob 策略要求当前 tracked bat/cmd 为0，未来引入 CRLF 文件必须另审', () => {
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '--', '*.bat', '*.cmd'], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '', '新增 tracked bat/cmd 后须先审查严格行尾规范化契约；不忽略文件或删除 assertSameSource')
})

test('Windows native、build 与 Web 报告多根同一次脱敏，不上传 native tmp 或整个 HOME', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  const publish = w.jobs.qualify.steps.find(s => s.run?.includes('await publishEvidence('))
  assert.ok(publish); assert.equal(publish.if, 'always()')
  for (const label of ['web', 'native', 'build', 'summary']) assert.ok(publish.run.includes(label), label)
  assert.match(publish.run, /hermes-public-/)
  assert.equal(w.jobs.qualify.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with.path, '${{ runner.temp }}/hermes-public-${{ matrix.variant }}/')
})

test('testjob-envcontext: job env 禁用 runner.temp；step 写 GITHUB_ENV，artifact 路径仍合法', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  for (const job of Object.values(w.jobs)) assert.doesNotMatch(JSON.stringify(job.env || {}), /\$\{\{\s*runner\./, 'job-level env 没有 runner 上下文；GitHub dispatch 会返回422')
  const job = w.jobs['linux-long-ui']
  assert.equal(job.env.EVIDENCE, undefined); assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, undefined)
  const init = job.steps.findIndex(s => s.id === 'runtime_paths')
  const use = job.steps.findIndex(s => s.run?.includes('test ! -e "$EVIDENCE"'))
  assert.ok(init >= 0 && init < use, '使用证据路径之前先通过 step 写入 GITHUB_ENV')
  const run = job.steps[init].run
  assert.match(run, /printf 'EVIDENCE=%s\/hermes-qualification-%s\\n' "\$RUNNER_TEMP" "\$VARIANT" >> "\$GITHUB_ENV"/)
  assert.match(run, /printf 'PLAYWRIGHT_BROWSERS_PATH=%s\/hermes-browser-cache\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/)
  for (const j of [w.jobs.qualify, job]) assert.equal(j.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with.path, '${{ runner.temp }}/hermes-public-${{ matrix.variant }}/')
})

test('publication fixture 先规范系统 tmp 物理路径，覆盖 mac /var 到 /private/var 别名', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(source, /fs\.mkdtempSync\(path\.join\(fs\.realpathSync\(os\.tmpdir\(\)\), 'hermes-publication-contract-'\)\)/)
})

test('publication 保留真实 symlink/junction 拒绝：输入或输出祖先为链接均失败', async () => {
  const { publishEvidence } = await load(), base = fs.realpathSync(os.tmpdir())
  const tmp = fs.mkdtempSync(path.join(base, 'hermes-publication-symlink-')), actual = path.join(tmp, 'actual'), alias = path.join(tmp, 'alias')
  try {
    fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, 'report.json'), '{"status":"failed"}')
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const output = path.join(tmp, 'public')
    await assert.rejects(publishEvidence({ roots: { web: alias }, output }), /reparse|symlink/)
    assert.equal(fs.existsSync(output), false)
    await assert.rejects(publishEvidence({ roots: { web: actual }, output: path.join(alias, 'public') }), /reparse|symlink/)
    assert.equal(fs.existsSync(path.join(actual, 'public')), false)
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias)
    const relative = path.relative(base, fs.realpathSync(tmp)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('runner admission 失败前落盘实际 proof 与逐条件 reason，诊断不放宽 guard', async () => {
  const { runnerProofFailures } = await load(); assert.equal(typeof runnerProofFailures, 'function')
  assert.deepEqual(runnerProofFailures(proof()), [])
  const bad = { ...proof(), virtualMachine: false, registeredProfile: 'C:\\Users\\other', workflowSha: 'b'.repeat(40) }
  assert.deepEqual(runnerProofFailures(bad).sort(), ['profile-registration', 'virtual-machine', 'workflow-sha-match'])
  assert.ok(runnerProofFailures(bad).every(s => /^[a-z-]+$/.test(s)), '只记录静态原因名，不拼入实际环境或凭据')
  const src = fs.readFileSync(script, 'utf8'), begin = src.indexOf('proof = actualRunnerProof()'), validate = src.indexOf('validateRunnerProof(proof)', begin)
  assert.ok(begin >= 0 && validate > begin)
  for (const name of ['runner-proof.json', 'runner-admission.json']) { const write = src.indexOf(`write('${name}'`, begin); assert.ok(write > begin && write < validate, `${name} 必须早于 validate`) }
})

test('真实 runner ImageOS 精确 allowlist win25 / win25-vs2026，不接受任意 win 前后缀', async () => {
  const { validateRunnerProof, runnerProofFailures } = await load()
  for (const imageOS of ['win25', 'win25-vs2026']) assert.doesNotThrow(() => validateRunnerProof({ ...proof(), imageOS }))
  for (const imageOS of ['win22', 'win2025', 'win25-vs2025', 'win25-vs2026-extra', 'prefix-win25-vs2026', 'win25-other', 'win25-vs2026\n', '', 'Win25']) {
    const p = { ...proof(), imageOS }; assert.deepEqual(runnerProofFailures(p), ['image-os']); assert.throws(() => validateRunnerProof(p), /image-os/)
  }
  const p = { ...proof(), imageOS: 'win25-vs2026', sid: '' }; assert.throws(() => validateRunnerProof(p), /sid-format/, '新 ImageOS 不绕过真实 SID 门禁')
})

test('Linux Python Chromium 保留1.58.0；Windows npm单独固定含Node24.16修复的1.60.0', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  const body = w.jobs['linux-long-ui'].steps.map(s => s.run || '').join('\n')
  assert.match(body, /pip" install 'playwright==1\.58\.0'/)
  assert.doesNotMatch(body, /playwright==1\.58\.2/)
  assert.equal(fs.readFileSync(script, 'utf8').match(/'playwright@(\d+\.\d+\.\d+)'/)?.[1], '1.60.0', 'Windows使用已复现修复的npm版本，不误改Python发布线')
})

test('hostSnapshot UTF8 哈希命令使用唯一名称，不删 h alias，保留全部 canary', async () => {
  const { hostSnapshot } = await load(), source = hostSnapshot.toString()
  assert.match(source, /function Get-ClawPanelUtf8Sha256\(\$s\)/)
  assert.match(source, /sha256=\(Get-ClawPanelUtf8Sha256 \(ConvertTo-Json -InputObject \$v -Compress\)\)/)
  assert.equal((source.match(/Get-ClawPanelUtf8Sha256/g) || []).length, 2, '一处定义和一处循环调用覆盖三个 registry hive')
  assert.doesNotMatch(source, /function H\(|sha256=\(H |Remove-(?:Item|Alias)|Set-Alias|New-Alias/i)
  for (const canary of ['HKCU:', 'HKLM:', 'Environment', 'Command Processor', 'DoNotExpandEnvironmentNames', 'GetValueKind', 'Get-ExecutionPolicy -List', 'registry=$registry;shells=$shells;launchers=$launchers;executionPolicy=', 'parentEnvSha256']) assert.ok(source.includes(canary), canary)
  const q = await load(); assert.ok((source + q.windowsPathFingerprintSource?.()).includes('Get-FileHash'), '普通文件内容 hash 门禁仍存在')
})

test('独立 Windows PowerShell canary 复现 H alias 抢占；UTF8/file hash 正确且子环境模块隔离', { skip: process.platform !== 'win32' }, async () => {
  const { hostSnapshot } = await load(), { createHash } = await import('node:crypto')
  const definition = hostSnapshot.toString().match(/^function ([\w-]+)\(\$s\).*$/m)
  assert.ok(definition)
  const run = code => {
    // 只执行提取出的纯哈希函数与常量；绝不调用 hostSnapshot 或访问真实 registry/profile。
    assert.doesNotMatch(code, /HKCU|HKLM|Get-Item|Get-Content|Set-Item|Remove-Item|Get-FileHash|hostSnapshot/)
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
  }
  const legacy = run(`$ErrorActionPreference='Stop'\n${definition[0].replace(`function ${definition[1]}(`, 'function H(')}\n$aliasBefore=(Get-Alias -Name h).Definition;try{H 'qualification-path-canary';throw 'legacy H unexpectedly succeeded'}catch{if($_.FullyQualifiedErrorId -notmatch 'GetHistoryCommand'){throw};@{aliasBefore=$aliasBefore;aliasAfter=(Get-Alias -Name h).Definition;errorId=$_.FullyQualifiedErrorId;command=$_.InvocationInfo.MyCommand.Name}|ConvertTo-Json -Compress}`)
  assert.equal(legacy.aliasBefore, 'Get-History'); assert.equal(legacy.aliasAfter, 'Get-History')
  assert.equal(legacy.command, 'Get-History'); assert.match(legacy.errorId, /CannotConvertArgument.*GetHistoryCommand/)
  const values = ['C:\\qualification-canary\\bin;D:\\qualification-canary\\tools', '资格-canary-Δ', '']
  const input = Buffer.from(JSON.stringify(values)).toString('base64')
  const actual = run(`$ErrorActionPreference='Stop'\n${definition[0]}\n$aliasBefore=(Get-Alias -Name h).Definition;$values=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')));$hashes=@(foreach($v in $values){${definition[1]} (ConvertTo-Json -InputObject $v -Compress)});@{aliasBefore=$aliasBefore;aliasAfter=(Get-Alias -Name h).Definition;commandType=(Get-Command ${definition[1]}).CommandType.ToString();hashes=$hashes}|ConvertTo-Json -Compress`)
  assert.equal(actual.aliasBefore, 'Get-History'); assert.equal(actual.aliasAfter, 'Get-History'); assert.equal(actual.commandType, 'Function')
  assert.deepEqual(actual.hashes, values.map(value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')))
  const base = fs.realpathSync(os.tmpdir()), tmp = fs.mkdtempSync(path.join(base, 'hermes-ps-module-canary-')), file = path.join(tmp, 'bytes.bin')
  try {
    const bytes = Buffer.from([0, 13, 10, 255, 0xc3, 0xa9, 10]); fs.writeFileSync(file, bytes)
    const input = Buffer.from(file).toString('base64'), parentBefore = Object.entries(process.env)
    const code = `$ErrorActionPreference='Stop';$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'));@{sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant();version=$PSVersionTable.PSVersion.Major;module=(Get-Command Get-FileHash).Module.Path}|ConvertTo-Json -Compress`
    assert.doesNotMatch(code, /HKCU|HKLM|hostSnapshot|Set-ExecutionPolicy|Set-Item/)
    const pwsh = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(pwsh.status, 0, pwsh.stderr)
    const core = JSON.parse(pwsh.stdout.replace(/^\uFEFF/, '')); assert.equal(core.version, 7)
    const privatePs = fs.readFileSync(script, 'utf8').match(/function ps\(code\) \{[\s\S]*?\n\}/)[0]
    // 给真实私有 ps() 注入含 PS7 模块目录的父环境副本，不改本进程环境、不执行真实 snapshot。
    const parent = { env: { ...process.env, PSModulePath: path.dirname(path.dirname(core.module)) } }
    const invoke = new Function('spawnSync', 'assert', 'process', `${privatePs}; return ps`)(spawnSync, assert, parent)
    const desktop = invoke(code), expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(core.sha256, expected); assert.equal(desktop.sha256, expected); assert.equal(desktop.version, 5)
    assert.match(desktop.module, /WindowsPowerShell[\\/]v1\.0[\\/]Modules[\\/]Microsoft\.PowerShell\.Utility/i)
    assert.deepEqual(Object.entries(process.env), parentBefore)
    const q = await load(); assert.equal(typeof q.windowsPathFingerprintSource, 'function')
    const app = target => {
      const payload = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from(`qualification.package\0qualification!App\0${target}\0desktop\0`, 'utf16le')])
      const header = Buffer.alloc(8); header.writeUInt32LE(0x8000001b); header.writeUInt16LE(payload.length, 4); return Buffer.concat([header, payload])
    }
    const a = app('C:\\qualification\\one.exe'), b = app('C:\\qualification\\two.exe'), badLength = Buffer.from(a), badCount = Buffer.from(a)
    badLength.writeUInt16LE(a.length, 4); badCount.writeUInt32LE(2, 8)
    const data = Buffer.from(JSON.stringify({ file, a: a.toString('base64'), b: b.toString('base64'), bad: [Buffer.alloc(7), badLength, badCount, a.subarray(0, a.length - 1)].map(v => v.toString('base64')) })).toString('base64')
    const typedCode = `$ErrorActionPreference='Stop'\n${definition[0]}\n${q.windowsPathFingerprintSource()}\n$input=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')));$normal=Get-ClawPanelPathFingerprint $input.file;$again=Get-ClawPanelPathFingerprint $input.file;$a=[ClawPanelReparseReader]::Decode([Convert]::FromBase64String($input.a));$b=[ClawPanelReparseReader]::Decode([Convert]::FromBase64String($input.b));$bad=@(foreach($value in $input.bad){try{$null=[ClawPanelReparseReader]::Decode([Convert]::FromBase64String($value));$false}catch{$true}});$locked=[IO.File]::Open($input.file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{$readError=$null;try{$null=Get-ClawPanelPathFingerprint $input.file}catch{$readError=$_.FullyQualifiedErrorId}}finally{$locked.Dispose()};@{normal=$normal;again=$again;a=$a;b=$b;bad=$bad;readError=$readError}|ConvertTo-Json -Depth 8 -Compress`
    assert.doesNotMatch(typedCode, /HKCU|HKLM|hostSnapshot|Set-ExecutionPolicy/)
    const typed = invoke(typedCode)
    assert.equal(typed.normal.kind, 'file'); assert.equal(typed.normal.sha256.toLowerCase(), expected); assert.deepEqual(typed.normal, typed.again)
    assert.equal(typed.a.ReparseTag, '0x8000001b'); assert.equal(typed.a.LinkType, 'AppExecLink'); assert.equal(typed.a.Target, 'C:\\qualification\\one.exe')
    assert.equal(typed.b.Target, 'C:\\qualification\\two.exe'); assert.notEqual(typed.a.DataSha256, typed.b.DataSha256)
    assert.equal(typed.a.DataSha256, createHash('sha256').update(a).digest('hex')); assert.deepEqual(typed.bad, [true, true, true, true])
    assert.match(typed.readError, /FileReadError|IOException|UnauthorizedAccess/, '不可读普通文件必须失败，不能记录 null hash 后视为 unchanged')
    const snapshotSource = q.hostSnapshot.toString(), phaseDefinition = snapshotSource.match(/^function Write-ClawPanelHostPhase.*$/m)
    assert.ok(phaseDefinition, '真实 canary 需要有限 phase 时间线')
    const messages = [], phasePs = new Function('spawnSync', 'assert', 'process', 'console', `${privatePs}; return ps`)(spawnSync, assert, parent, { error: line => messages.push(line) })
    const phaseResult = phasePs(`$ErrorActionPreference='Stop';$hostClock=[Diagnostics.Stopwatch]::StartNew()\n${phaseDefinition[0]}\nWrite-ClawPanelHostPhase 'init'\nWrite-ClawPanelHostPhase 'complete'\n'{"ok":true}'`)
    assert.deepEqual(phaseResult, { ok: true }, 'diagnostics 不污染 stdout JSON 或参与宿主 before/after 比较')
    const diagnostic = JSON.parse(messages.at(-1).replace(/^CLAWPANEL_PS_DIAGNOSTICS /, ''))
    assert.deepEqual(diagnostic.phaseTimings.map(p => p.phase), ['init', 'complete']); assert.ok(diagnostic.phaseTimings.every(p => Number.isSafeInteger(p.elapsedMs) && p.elapsedMs >= 0))
  } finally {
    assert.equal(path.dirname(fs.realpathSync(tmp)), base)
    fs.unlinkSync(file); fs.rmdirSync(tmp)
  }
})

test('私有 ps() 只从子环境副本移除全部大小写 PSModulePath，其余父环境原样保留', () => {
  const source = fs.readFileSync(script, 'utf8').match(/function ps\(code\) \{[\s\S]*?\n\}/)[0]
  for (const moduleKeys of [{}, { PSModulePath: 'core-only-modules' }, { PSModulePath: 'core', psmodulepath: 'other', PsMoDuLePaTh: 'mixed' }]) {
    const env = Object.freeze({ PATH: 'unchanged-path', HOME: 'unchanged-home', QUALIFICATION_CANARY: 'same', ...moduleKeys }), before = Object.entries(env), calls = []
    const invoke = new Function('spawnSync', 'assert', 'process', `${source}; return ps`)((exe, args, options) => { calls.push({ exe, args, options }); return { status: 0, stdout: '{"ok":true}', stderr: '' } }, assert, { env })
    assert.deepEqual(invoke('only-canary'), { ok: true }); assert.equal(calls.length, 1)
    const { exe, args, options } = calls[0]; assert.equal(exe, 'powershell.exe'); assert.ok(args.includes('-NoProfile'))
    assert.notEqual(options.env, env, '必须显式传子环境副本，不能继承跨版本模块目录')
    assert.deepEqual(options.env, { PATH: 'unchanged-path', HOME: 'unchanged-home', QUALIFICATION_CANARY: 'same' })
    assert.deepEqual(Object.entries(env), before); assert.equal(options.timeout, 30000)
  }
})

test('typed fingerprint 不过滤 WindowsApps；两处 canary 保留 path/bytes/sha256 并记录类型', async () => {
  const q = await load(); assert.equal(typeof q.windowsPathFingerprintSource, 'function')
  const source = q.hostSnapshot.toString(), helper = q.windowsPathFingerprintSource()
  assert.equal((source.match(/Get-ClawPanelPathFingerprint/g) || []).length, 2, 'shell 和 global launcher 均使用 typed fingerprint')
  assert.match(source, /fingerprint=\$fingerprint/); assert.match(source, /bytes=\$f\.Length/)
  assert.doesNotMatch(source, /WindowsApps.*(?:continue|exclude|Where-Object)|Get-FileHash/)
  for (const value of ['FILE_FLAG_OPEN_REPARSE_POINT', 'FSCTL_GET_REPARSE_POINT', 'metadataSha256', 'ReparseTag', 'Target', 'Get-FileHash', "kind='reparse'", "kind='file'"]) assert.ok(helper.includes(value), value)
  assert.match(helper, /Get-FileHash[^\n]+-ErrorAction Stop/)
  assert.doesNotMatch(helper, /FSCTL_SET_REPARSE_POINT|Set-ExecutionPolicy|Set-ItemProperty/)
})

test('typed reparse 的 tag/target/metadata hash 或类型变化均失败，不以缺 content hash 当 unchanged', async () => {
  const { assertHostUnchanged } = await load(), fingerprint = { kind: 'reparse', sha256: null, reparseTag: '0x8000001b', linkType: 'AppExecLink', target: 'C:\\qualification\\one.exe', metadataSha256: 'a'.repeat(64) }
  const before = { launchers: [{ path: 'WindowsApps/python.exe', bytes: 0, sha256: null, fingerprint }] }
  assert.doesNotThrow(() => assertHostUnchanged(before, structuredClone(before)))
  for (const patch of [{ reparseTag: '0xa000000c' }, { target: 'C:\\qualification\\two.exe' }, { metadataSha256: 'b'.repeat(64) }, { kind: 'file' }]) assert.throws(() => assertHostUnchanged(before, { launchers: [{ ...before.launchers[0], fingerprint: { ...fingerprint, ...patch } }] }), /宿主/)
})

test('ps timeout 保留 status/signal/error.code 与有限 phase，不放宽30000或泄漏新诊断字段', () => {
  const source = fs.readFileSync(script, 'utf8').match(/function ps\(code\) \{[\s\S]*?\n\}/)[0], logs = [], calls = []
  const stderr = '#< CLIXML\nCLAWPANEL_HOST_PHASE {"phase":"init","elapsedMs":0}\nCLAWPANEL_HOST_PHASE {"phase":"launchers","elapsedMs":12000,"ignored":"not-a-diagnostic-field"}\nCLAWPANEL_HOST_PHASE {"phase":"unknown","elapsedMs":1}\n'
  const invoke = new Function('spawnSync', 'assert', 'process', 'console', `${source}; return ps`)((exe, args, options) => { calls.push(options); return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr } }, assert, { env: Object.freeze({ PATH: 'unchanged' }) }, { error: line => logs.push(line) })
  assert.throws(() => invoke('only-canary'), error => /"errorCode":"ETIMEDOUT"/.test(error.message) && /"status":null/.test(error.message) && /"phase":"launchers"/.test(error.message))
  assert.equal(calls.length, 1); assert.equal(calls[0].timeout, 30000)
  assert.equal(logs.length, 1)
  const report = JSON.parse(logs[0].replace(/^CLAWPANEL_PS_DIAGNOSTICS /, ''))
  assert.deepEqual(Object.keys(report).sort(), ['elapsedMs', 'errorCode', 'phaseTimings', 'signal', 'status'].sort())
  assert.equal(report.signal, 'SIGTERM'); assert.equal(report.errorCode, 'ETIMEDOUT')
  assert.deepEqual(report.phaseTimings, [{ phase: 'init', elapsedMs: 0 }, { phase: 'launchers', elapsedMs: 12000 }])
  assert.doesNotMatch(logs[0], /ignored|not-a-diagnostic-field|only-canary|unchanged/)
})

test('hostSnapshot 六个有限阶段只写 stderr，不给 before/after canary 增加时变字段', async () => {
  const { hostSnapshot } = await load(), source = hostSnapshot.toString()
  const phases = [...source.matchAll(/Write-ClawPanelHostPhase '([^']+)'/g)].map(m => m[1])
  assert.deepEqual(phases, ['init', 'registry', 'shells', 'launchers', 'execution-policy', 'complete'])
  assert.match(source, /\[Console\]::Error\.WriteLine/); assert.match(source, /executionPolicy=\$executionPolicy/)
  assert.doesNotMatch(source.slice(source.indexOf('@{registry=$registry')), /phaseTimings|hostClock|elapsedMs/)
})

// R18：以下 factory 为4ca/669共同的真实 Git 源片段；只读解析，不执行候选代码。
const releaseFactory = [
  "export function hermesInstallerPlan(home = hermesHome()) {",
  "  const installDir = hermesSourceDir(home)",
  "  const cacheDir = path.join(home, '.clawpanel-cache')",
  "  if (isWindows) {",
  "    // 旧版回归保留原11阶段隔离入口；新PM不能进入旧vendor wrapper。",
  "    if (HERMES_STABLE_VERSION === '0.21.5') {",
  "      if (HERMES_STABLE_COMMIT !== 'f97608f178d1ffeca59860195ab7da295f7c8e5f') throw new Error('Hermes legacy installer pin 未审查')",
  "      return {",
  "        url: HERMES_INSTALLER_BASE_URL + '/install.ps1', sha256: HERMES_INSTALLER_SHA256.windows,",
  "        sourcePath: 'scripts/install.ps1', scriptPath: path.join(cacheDir, 'install-' + HERMES_STABLE_TAG + '.ps1'), program: 'powershell.exe',",
  "        stages: ['uv', 'git', 'node', 'repository', 'python', 'venv', 'dependencies', 'node-deps', 'config-templates', 'platform-sdks', 'bootstrap-marker'],",
  "        argsForStage: (scriptPath, stage, wrapperPath) => [",
  "          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '-InstallerPath', scriptPath,",
  "          '-HermesHome', home, '-InstallDir', installDir, '-Branch', HERMES_STABLE_BRANCH, '-Commit', HERMES_STABLE_COMMIT,",
  "          '-ForceCommit', '-SkipSetup', '-SkipComputerUse', '-NonInteractive', '-Json', '-Stage', stage,",
  "        ],",
  "      }",
  "    }",
  "    if (HERMES_STABLE_VERSION !== '0.22.2' || HERMES_STABLE_COMMIT !== 'd923a5eb487a17c0a68801bba9ef0f56c81040a8') throw new Error('Hermes PM installer pin 未审查')",
  "    return {",
  "      url: `${HERMES_INSTALLER_BASE_URL}/install.ps1`,",
  "      sha256: HERMES_INSTALLER_SHA256.windows,",
  "      sourcePath: 'scripts/install.ps1',",
  "      scriptPath: path.join(cacheDir, `install-${HERMES_STABLE_TAG}.ps1`),",
  "      program: 'powershell.exe',",
  "      // 0.22.2 由固定 commit 内的 PM 管理依赖；跳过修改用户 PATH 的 products 和系统 prerequisites。",
  "      stages: ['repository', 'venv', 'python-deps', 'config', 'complete'],",
  "      argsForStage: (scriptPath, stage) => [",
  "        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,",
  "        '-HermesHome', home, '-InstallDir', installDir,",
  "        '-Branch', HERMES_STABLE_BRANCH,",
  "        '-Commit', HERMES_STABLE_COMMIT,",
  "        '-SkipSetup', '-SkipComputerUse', '-NonInteractive', '-Json', '-Stage', stage,",
  "      ],",
  "    }",
  "  }",
  "  return {",
  "    url: `${HERMES_INSTALLER_BASE_URL}/install.sh`,",
  "    sha256: HERMES_INSTALLER_SHA256.posix,",
  "    sourcePath: 'scripts/install.sh',",
  "    scriptPath: path.join(cacheDir, `install-${HERMES_STABLE_TAG}.sh`),",
  "    program: 'bash',",
  "    stages: ['repository', 'venv', 'python-deps', 'config', 'complete'],",
  "    argsForStage: (scriptPath, stage) => [",
  "      scriptPath,",
  "      '--hermes-home', home, '--dir', installDir,",
  "      '--branch', HERMES_STABLE_BRANCH,",
  "      '--commit', HERMES_STABLE_COMMIT,",
  "      '--skip-setup', '--skip-computer-use', '--non-interactive', '--json', '--stage', stage,",
  "    ],",
  "  }",
  "}"
].join('\n')

function releaseInputs(version = '0.22.2') {
  const old = version === '0.21.5', commit = old ? 'f97608f178d1ffeca59860195ab7da295f7c8e5f' : 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
  const tag = old ? 'v2026.9.24' : 'v0.22.2', branch = old ? tag : 'release/0.22.2'
  return { version, web: [
    "const HERMES_STABLE_VERSION = '" + version + "'",
    "const HERMES_STABLE_TAG = '" + tag + "'",
    "const HERMES_STABLE_BRANCH = '" + branch + "'",
    "const HERMES_STABLE_COMMIT = '" + commit + "'",
    "const HERMES_INSTALLER_SHA256 = { windows: '" + 'a'.repeat(64) + "', posix: '" + 'b'.repeat(64) + "' }",
    releaseFactory,
  ].join('\n'), rust: 'const HERMES_STABLE_VERSION: &str = "' + version + '";\nconst HERMES_STABLE_COMMIT: &str = "' + commit + '";' }
}
const oldReleaseStages = ['uv', 'git', 'node', 'repository', 'python', 'venv', 'dependencies', 'node-deps', 'config-templates', 'platform-sdks', 'bootstrap-marker']
const newReleaseStages = ['repository', 'venv', 'python-deps', 'config', 'complete']

test('R18：真实双分支factory按版本/pin读取声明，22.2不误取旧11，21.5仍原11', async () => {
  const { readHermesRelease } = await load(); assert.equal(typeof readHermesRelease, 'function')
  for (const version of ['0.22.2', '0.21.5']) {
    const f = releaseInputs(version), r = readHermesRelease(f.web, f.rust, version)
    assert.equal(r.version, version); assert.deepEqual(r.stages, version === '0.21.5' ? oldReleaseStages : newReleaseStages)
    assert.equal(r.installerSha256, 'a'.repeat(64))
  }
  const source = fs.readFileSync(script, 'utf8')
  assert.match(source, /release = readHermesRelease\(webSource, rust, o\['--version'\]\)/)
  assert.doesNotMatch(source, /webSource\.match\(\/stages:/)
})

test('R18：无关全文/注释/非Windows stages不能抢占；候选源码始终只作数据不执行', async () => {
  const { readHermesRelease } = await load(), f = releaseInputs()
  const poison = "throw new Error('candidate source executed')\nconst decoy = { stages: ['not-the-installer'] }\n"
  const web = poison + f.web.replace("if (isWindows) {", "if (isWindows) { /* stages: ['comment-only'] */")
  assert.deepEqual(readHermesRelease(web, f.rust, f.version).stages, newReleaseStages)
})

test('R18：未知版本/错pin/期望版本或Rust不符、重复常量、缺branch均failclosed', async () => {
  const { readHermesRelease } = await load(), f = releaseInputs()
  assert.equal(typeof readHermesRelease, 'function')
  for (const web of [
    f.web.replace("VERSION = '0.22.2'", "VERSION = '0.22.3'"),
    f.web.replace("COMMIT = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'", "COMMIT = '" + '0'.repeat(40) + "'"),
    f.web + "\nconst HERMES_STABLE_VERSION = '0.22.2'",
    f.web.replace("const HERMES_STABLE_BRANCH = 'release/0.22.2'\n", ''),
    f.web.replace("const HERMES_STABLE_BRANCH = 'release/0.22.2'", "const HERMES_STABLE_BRANCH = 'unknown'"),
  ]) assert.throws(() => readHermesRelease(web, f.rust, f.version))
  assert.throws(() => readHermesRelease(f.web, f.rust, '0.21.5'))
  assert.throws(() => readHermesRelease(f.web, f.rust.replace('0.22.2', '0.21.5'), f.version))
  assert.throws(() => readHermesRelease(f.web, f.rust.replace('d923a5eb487a17c0a68801bba9ef0f56c81040a8', '0'.repeat(40)), f.version))
})

test('R18：两固定guard及Windows分支必须完整，错guard/缺/重复/改形态不可fallback', async () => {
  const { readHermesRelease } = await load(), f = releaseInputs()
  assert.equal(typeof readHermesRelease, 'function')
  const oldBranch = releaseFactory.match(/    if \(HERMES_STABLE_VERSION === '0\.21\.5'\) \{[^]*?\n    \}/)[0]
  for (const web of [
    f.web.replace("HERMES_STABLE_COMMIT !== 'f97608f178d1ffeca59860195ab7da295f7c8e5f'", "HERMES_STABLE_COMMIT !== '" + '1'.repeat(40) + "'"),
    f.web.replace("HERMES_STABLE_COMMIT !== 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'", "HERMES_STABLE_COMMIT !== '" + '2'.repeat(40) + "'"),
    f.web.replace("HERMES_STABLE_VERSION === '0.21.5'", "HERMES_STABLE_VERSION === '0.21.4'"),
    f.web.replace("if (isWindows)", "if (!isWindows)"),
    f.web.replace(/^    if \(HERMES_STABLE_VERSION !== '0.22.2'[^\n]+\n/m, ''),
    f.web.replace(oldBranch, ''),
    f.web.replace(oldBranch, oldBranch + '\n' + oldBranch),
    f.web + '\n' + releaseFactory,
  ]) assert.throws(() => readHermesRelease(web, f.rust, f.version))
})

test('R18：stages必须来自单一真实literal，重复/缺失/未知/表达式不硬造expected', async () => {
  const { readHermesRelease } = await load(), f = releaseInputs()
  assert.equal(typeof readHermesRelease, 'function')
  const declaration = "stages: ['repository', 'venv', 'python-deps', 'config', 'complete']"
  for (const replacement of [
    "stages: ['repository', 'venv', 'python-deps', 'config', 'complete', 'node-deps']",
    "stages: ['repository', 'venv', 'python-deps', 'config']",
    "stages: ['repository', 'venv', 'python-deps', 'config', 'config']",
    "stages: ['invented', 'venv', 'python-deps', 'config', 'complete']",
    'stages: buildStages()',
    declaration + ', ' + declaration,
    "otherStages: ['repository', 'venv', 'python-deps', 'config', 'complete']",
  ]) assert.throws(() => readHermesRelease(f.web.replace(declaration, replacement), f.rust, f.version))
  const old = releaseInputs('0.21.5')
  assert.throws(() => readHermesRelease(old.web.replace("stages: ['uv', 'git'", "stages: ['unsafe', 'git'"), old.rust, old.version))
  assert.throws(() => readHermesRelease(f.web.replace('windows:', 'otherPlatform:'), f.rust, f.version))
})

// 固定上游标题合同：只重放公开资格fixture，不启动任何内核或宿主探针。
const titleFixturePath = new URL('./fixtures/hermes-title-contracts.json', import.meta.url)
const titleFixture = JSON.parse(fs.readFileSync(titleFixturePath, 'utf8'))
const titleEvidence = (item, calls = [item.priorChat], pin = titleFixture.upstream[1].pin) => ({ method: 'POST', path: '/v1/chat/completions', authenticated: true, pin, models: ['qualification-one', 'qualification-two'], calls })

test('固定上游标题：双pin原Git blob/完整system与三份实际wire hash闭合', async () => {
  const { gunzipSync } = await import('node:zlib')
  const pins = ['f97608f178d1ffeca59860195ab7da295f7c8e5f', 'd923a5eb487a17c0a68801bba9ef0f56c81040a8']
  const blobs = ['9e5073cbb8bec3b0d2e63a0ae86eaf32a228277a', 'fa14b71d4061af3d17eeabd813f333b549c66833']
  assert.deepEqual(titleFixture.upstream.map(x => x.pin), pins)
  for (const [i, item] of titleFixture.upstream.entries()) {
    const bytes = gunzipSync(Buffer.from(item.sourceGzipBase64, 'base64'))
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), blobs[i])
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sourceSha256)
    assert.match(bytes.toString(), /def generate_title\(/)
    assert.match(bytes.toString(), /task="title_generation"/)
    assert.match(bytes.toString(), /messages=\[\{"role": "system", "content": prompt\}, \{"role": "user", "content": user_snippet\}\]/)
  }
  assert.equal(createHash('sha256').update(titleFixture.system).digest('hex'), '3f1eef0616ddd2c13d45a3f8cef4ed648dadfdacdba7fbedceebf5a04d549998')
  assert.equal(createHash('sha256').update(JSON.stringify(titleFixture.responseFormat)).digest('hex'), titleFixture.responseFormatSha256)
  for (const item of titleFixture.rawCases) {
    assert.equal(createHash('sha256').update(item.rawBody).digest('hex'), item.bodySha256)
    const body = JSON.parse(item.rawBody)
    assert.deepEqual(body.messages, [{ role: 'system', content: titleFixture.system }, { role: 'user', content: item.nonce }])
    assert.deepEqual(Object.keys(body), ['messages', 'model', 'reasoning_effort', 'response_format'])
    assert.equal(Object.hasOwn(body, 'stream'), false)
  }
})

test('固定上游标题：精确合同须双pin、认证及同model/nonce唯一已收chat', async () => {
  const { classifyProviderRequest } = await load()
  for (const item of titleFixture.rawCases) for (const source of titleFixture.upstream) {
    assert.equal(classifyProviderRequest(JSON.parse(item.rawBody), titleEvidence(item, [item.priorChat], source.pin)), 'title')
  }
})

test('固定上游标题：prefix/结构/stream/路由/认证/来源/关联/重放负控不免检', async () => {
  const { classifyProviderRequest } = await load(), item = titleFixture.rawCases[0], original = JSON.parse(item.rawBody), context = titleEvidence(item)
  const changes = [b => { b.messages[0].content += ' ' }, b => { b.messages[0].content = 'You name chat sessions.' }, b => { b.messages.push({ role: 'assistant', content: 'extra' }) }, b => { b.messages.reverse() }, b => { b.messages[1].role = 'assistant' }, b => { b.messages[1].content += ' extra' }, b => { b.messages[1].extra = true }, b => { b.messages[0].name = 'extra' }, b => { b.messages.pop() }, b => { b.stream = true }, b => { b.stream = false }, b => { b.tools = [] }, b => { b.extra = true }, b => { b.reasoning_effort = 'low' }, b => { b.response_format.json_schema.strict = false }, b => { b.response_format.json_schema.schema.additionalProperties = true }, b => { b.model = 'qualification-two' }, b => { delete b.response_format }]
  for (const change of changes) { const b = structuredClone(original); change(b); assert.equal(classifyProviderRequest(b, context), 'unattributed', String(change)) }
  for (const patch of [{ method: 'GET' }, { method: 'post' }, { path: '/v1/chat/completions?x=1' }, { path: '/v1/chat/completions/' }, { authenticated: false }, { authenticated: 'true' }, { pin: '0'.repeat(40) }, { models: [] }, { calls: [] }, { calls: [item.priorChat, item.priorChat] }, { calls: [{ ...item.priorChat, authenticated: false }] }, { calls: [{ ...item.priorChat, stream: false }] }, { calls: [{ ...item.priorChat, model: 'qualification-two' }] }, { calls: [{ ...item.priorChat, nonce: item.nonce + 'x' }] }, { calls: [item.priorChat, { ...item.priorChat, purpose: 'title' }] }]) assert.equal(classifyProviderRequest(original, { ...context, ...patch }), 'unattributed', JSON.stringify(patch))
  assert.equal(classifyProviderRequest(original), 'unattributed', '无可信调用端关联不单凭prompt放行')
})

test('固定上游标题：真实HTTP原wire重放三chat三title，unknown原门禁留红到实现', { timeout: 30000 }, async t => {
  const { classifyProviderRequest } = await load(), calls = [], receipts = [], token = 'qualification-local-no-secret'
  const out = process.env.HERMES_TITLE_EVIDENCE_DIR || fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hermes-title-http-'))
  fs.mkdirSync(out, { recursive: true })
  const report = { scope: 'actual loopback HTTP with exact original R26 title wire SHA; controlled component, not VM/Hermes execution', sourceSha256: createHash('sha256').update(fs.readFileSync(script)).digest('hex'), fixtureSha256: createHash('sha256').update(fs.readFileSync(titleFixturePath)).digest('hex'), calls, receipts }
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) { raw += part; assert.ok(Buffer.byteLength(raw) <= 65536) }
      const body = JSON.parse(raw), authenticated = req.headers.authorization === `Bearer ${token}`
      const purpose = classifyProviderRequest(body, { ...titleEvidence(titleFixture.rawCases[0], calls), method: req.method, path: req.url, authenticated })
      const nonce = body.messages.find(m => m.role === 'user')?.content
      calls.push({ purpose, nonce, model: body.model, stream: body.stream, authenticated })
      receipts.push({ method: req.method, path: req.url, authenticated, rawBody: raw, bodySha256: createHash('sha256').update(raw).digest('hex'), purpose })
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ purpose }))
    } catch (error) { report.serverError = String(error); res.writeHead(500); res.end('{}') }
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
    for (const item of titleFixture.rawCases) {
      const chat = JSON.stringify({ messages: [{ role: 'system', content: 'You are Hermes, an AI assistant.' }, { role: 'user', content: item.nonce }], model: item.model, stream: true })
      for (const raw of [chat, item.rawBody]) {
        const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200); await r.json()
      }
    }
    assert.equal(report.serverError, undefined)
    report.counts = { chats: calls.filter(c => c.purpose === 'chat').length, titles: calls.filter(c => c.purpose === 'title').length, unknown: calls.filter(c => c.purpose === 'unattributed').length }
    for (const item of titleFixture.rawCases) assert.equal(receipts.filter(r => r.bodySha256 === item.bodySha256).length, 1)
    assert.equal(report.counts.unknown, 0, '实际固定title仍unknown')
    assert.equal(report.counts.chats, 3); assert.equal(report.counts.titles, 3)
    for (const item of titleFixture.rawCases) { assert.equal(calls.filter(c => c.purpose === 'chat' && c.nonce === item.nonce && c.model === item.model).length, 1); assert.ok(calls.filter(c => c.purpose === 'title' && c.nonce === item.nonce).length <= 1) }
    report.passed = true
  } catch (error) { report.passed = false; report.error = String(error); throw error }
  finally { await new Promise(resolve => server.close(resolve)); report.loopbackClosed = !server.listening; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); t.diagnostic('HTTP evidence: ' + out) }
})

test('strict标题响应：真实接线handler返回JSON title，保留SSE/chat/旧title/unknown', { timeout: 30000 }, async t => {
  const q = await load(), { compileFunction } = await import('node:vm'), { classifyHermesMetadataRequest } = await import('../scripts/hermes-qualification-provider.mjs')
  const source = fs.readFileSync(script, 'utf8'), marker = 'provider = http.createServer(async (req, res) => {'
  const start = source.indexOf(marker), end = source.indexOf('; await new Promise(resolve => provider.listen', start)
  assert.ok(start > 0 && end > start); assert.equal(source.indexOf(marker, start + 1), -1)
  // 只截取可信工具真实handler，不进入execute/VM安装；不复制其分类或响应实现。
  const expression = source.slice(start + 'provider = '.length, end)
  const out = process.env.HERMES_TITLE_REPLY_EVIDENCE_DIR || fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hermes-title-reply-'))
  fs.mkdirSync(out, { recursive: true })
  const calls = [], providerHTTP = [], writes = {}, r = {}, observations = []
  const report = { scope: 'actual trusted Windows provider handler carve + real loopback HTTP; not full VM/kernel/UI', sourceSha256: createHash('sha256').update(source).digest('hex'), handlerSha256: createHash('sha256').update(expression).digest('hex'), observations, calls, providerHTTP }
  const bindings = { http, assert, classifyHermesMetadataRequest, classifyProviderRequest: q.classifyProviderRequest, qualificationProviderReply: q.qualificationProviderReply, providerModels: ['qualification-one', 'qualification-two'], release: { commit: titleFixture.upstream[1].pin }, calls, providerHTTP, r, save() {}, write(name, value) { assert.ok(['provider-http.json', 'provider-metadata.json', 'provider-requests.json'].includes(name)); writes[name] = structuredClone(value) }, digest: value => createHash('sha256').update(value).digest('hex') }
  const server = compileFunction('return (' + expression + ')', Object.keys(bindings), { filename: '<owned-exact-windows-provider-handler>' })(...Object.values(bindings))
  async function send(raw, authorization = 'Bearer qualification-local-no-secret') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(5000) })
    const text = await response.text(); const row = { requestSha256: createHash('sha256').update(raw).digest('hex'), status: response.status, contentType: response.headers.get('content-type'), response: text }; observations.push(row); return row
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const titleRows = []
    for (const item of titleFixture.rawCases) {
      const chat = await send(JSON.stringify({ messages: [{ role: 'system', content: 'You are Hermes, an AI assistant.' }, { role: 'user', content: item.nonce }], model: item.model, stream: true }))
      const reply = `Hermes qualification reply ${item.nonce} ${item.model}.`
      const expected = [{ role: 'assistant', content: '' }, { content: reply }, {}].map(delta => 'data: ' + JSON.stringify({ id: 'qualification', object: 'chat.completion.chunk', model: item.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n').join('') + 'data: [DONE]\n\n'
      assert.equal(chat.status, 200); assert.match(chat.contentType, /text\/event-stream/); assert.equal(chat.response, expected)
      const response = await send(item.rawBody); assert.equal(response.status, 200)
      const envelope = JSON.parse(response.response); assert.equal(envelope.choices[0].finish_reason, 'stop'); assert.deepEqual(envelope.usage, { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 })
      const content = envelope.choices[0].message.content; assert.equal(typeof content, 'string')
      const row = { nonce: item.nonce, model: item.model, requestSha256: response.requestSha256, content, parsed: null }
      try { row.parsed = JSON.parse(content) } catch (error) { row.parseError = String(error) }
      titleRows.push(row)
    }
    report.titleRows = titleRows; report.structuredValid = titleRows.filter(x => x.parsed && Object.keys(x.parsed).length === 1 && x.parsed.title === `Hermes qualification ${x.nonce} ${x.model}`).length
    assert.equal(report.structuredValid, 3, '已声明strict session_title必须返回合法JSON content，不依赖上游prose fallback')
    assert.equal(calls.filter(x => x.purpose === 'unattributed').length, 0)
    for (const item of titleFixture.rawCases) { assert.equal(calls.filter(x => x.purpose === 'chat' && x.nonce === item.nonce && x.model === item.model).length, 1); assert.ok(calls.filter(x => x.purpose === 'title' && x.nonce === item.nonce).length <= 1) }
    const legacyNonce = 'hq-00000000-0000-0000-0000-000000000099', model = 'qualification-one'
    for (const [label, system, purpose] of [['legacy-title', 'You are a title generator. You output ONLY a thread title. Nothing else.', 'title'], ['unknown', 'unknown helper task', 'unattributed'], ['chat-nonstream', 'You are Hermes, an AI assistant.', 'chat']]) {
      const result = await send(JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: legacyNonce }], model }))
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.response).choices[0].message.content, `Hermes qualification reply ${legacyNonce} ${model}.`); assert.equal(calls.at(-1).purpose, purpose); result.negativeLabel = label
    }
    const unauthorized = await send(titleFixture.rawCases[0].rawBody, 'Bearer wrong-owned-fixture')
    assert.equal(unauthorized.status, 500); assert.equal(unauthorized.response, 'qualification provider error'); assert.equal(calls.at(-1).purpose, 'unattributed'); assert.equal(providerHTTP.at(-1).accepted, false)
    assert.deepEqual(writes['provider-requests.json'], calls)
    report.passed = true
  } catch (error) { report.passed = false; report.error = String(error); throw error }
  finally { await new Promise(resolve => server.close(resolve)); report.loopbackClosed = !server.listening; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); t.diagnostic('Exact handler HTTP evidence: ' + out) }
})

test('native标题family：显式canonical family、不改写nonce、未知family拒绝', async () => {
  const q = await load(), item = titleFixture.rawCases[0], body = JSON.parse(item.rawBody)
  const nonce = 'native-acceptance-12345678-1234-1234-1234-123456789abc'
  body.model = 'native-one'; body.messages[1].content = nonce
  const evidence = { ...titleEvidence(item), nonceFamily: 'native', models: ['native-one', 'native-two'], calls: [{ purpose: 'chat', nonce, model: body.model, authenticated: true, stream: true }] }
  for (const source of titleFixture.upstream) {
    assert.equal(q.classifyProviderRequest(body, { ...evidence, pin: source.pin }), 'title')
    assert.deepEqual(JSON.parse(q.qualificationProviderReply(body, nonce, { ...evidence, pin: source.pin })), { title: `Hermes qualification ${nonce} native-one` })
  }
  for (const nonceFamily of [undefined, 'web', 'unknown', null, '', true]) assert.equal(q.classifyProviderRequest(body, { ...evidence, nonceFamily }), 'unattributed')
  for (const bad of [nonce.toUpperCase(), nonce + 'x', nonce.replace('native-acceptance-', 'hq-'), 'prefix ' + nonce]) {
    const changed = structuredClone(body); changed.messages[1].content = bad; assert.equal(q.classifyProviderRequest(changed, evidence), 'unattributed')
  }
  const webBody = JSON.parse(item.rawBody)
  assert.equal(q.classifyProviderRequest(webBody, titleEvidence(item)), 'title')
  assert.equal(q.classifyProviderRequest(webBody, { ...titleEvidence(item), nonceFamily: 'web' }), 'title')
  assert.equal(q.classifyProviderRequest(webBody, { ...titleEvidence(item), nonceFamily: 'native' }), 'unattributed')
  for (const nonceFamily of ['unknown', null, '']) assert.equal(q.classifyProviderRequest(webBody, { ...titleEvidence(item), nonceFamily }), 'unattributed')
  assert.equal(body.messages[1].content, nonce)
})
