#!/usr/bin/env node
/** 每日维护的真实运行时验收；只使用全新 HOME 与回环模拟模型，不合并或发布。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { isManagedRenamedPiProcess } from './maintenance-pi-process.mjs'
import { OPENCLAW_PROTOCOL_RANGE, buildDeviceAuthPayloadV3, resolveConnectSignedAt } from '../src/lib/openclaw-gateway-compat.js'
const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function collectCandidateSourceHashes(project) {
  const files = ['scripts/serve.js', 'scripts/dev-api.js', 'scripts/pi-models.js', 'scripts/opencode.js', 'scripts/opencode-proxy.js', 'scripts/deepseek-harness.js', 'scripts/deepseek-harness-auth.js', 'scripts/deepseek-harness-proxy.js', 'src/lib/opencode-storage-bridge.js', 'src/lib/openclaw-gateway-compat.js', 'src/lib/tauri-api.js', 'src/engines/opencode/pages/workspace.js', 'src/engines/opencode/pages/dashboard.js', 'src/engines/hermes/pages/chat.js', 'package.json', 'package-lock.json', 'openclaw-version-policy.json', 'Dockerfile', '.github/maintenance/Runtime.Dockerfile']
  // 新 PM 是运行依赖，存在时必须进入快照；旧分支没有该文件时仍保留原19项。
  for (const optional of ['scripts/hermes-pm-runtime.js', 'scripts/hermes-managed-install.ps1']) {
    try { fs.lstatSync(path.join(project, optional)); files.push(optional) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return Object.fromEntries(files.map(file => {
    const absolute = path.join(project, file), stat = fs.lstatSync(absolute)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), '源码必须为普通文件，不接受链接: ' + file)
    return [file, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]
  }))
}
const engines = ['pi', 'opencode', 'deepseek-harness', 'hermes', 'openclaw', 'openclaw-zh', 'weixin', 'deepseek-harness-preview']
const argv = process.argv.slice(2)
if (argv.includes('--help')) {
  console.log('node tooling/scripts/maintenance-runtime-smoke.mjs [--root <candidateRepo>] --engine <pi|opencode|deepseek-harness|hermes|openclaw|openclaw-zh|weixin|deepseek-harness-preview> [--output <new-dir>] [--timeout-ms <ms>] [--fault <isolation|install|version|provider|stop|not-executed>]')
  process.exit(0)
}
const options = {}
for (let i = 0; i < argv.length; i += 2) {
  if (!['--root', '--engine', '--output', '--timeout-ms', '--fault'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw new Error(`参数无效: ${argv[i]}`)
  options[argv[i]] = argv[i + 1]
}
const engine = options['--engine']
const project = path.resolve(options['--root'] || toolingRoot)
assert.ok(engines.includes(engine), '必须指定有效 --engine；用 --help 查看')
const fault = options['--fault'] || ''
assert.ok(!fault || ['isolation', 'install', 'version', 'provider', 'stop', 'not-executed'].includes(fault), '未知 --fault')
assert.ok(!fault || engine === 'pi', '--fault 只用于 Pi 的负向验收，不得当作正常验收')
const timeoutMs = Number(options['--timeout-ms'] || 1200000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000, 'timeout-ms 应在 1000..3600000')
const id = crypto.randomUUID()
const output = options['--output'] ? path.resolve(options['--output']) : path.join(project, '.tmp', `maintenance-runtime-${engine}-${id}`)
// 输出必须全新且不含符号链接祖先，不接触已有配置/证据。
assert.ok(output !== project && !project.startsWith(output + path.sep), '输出不得是仓库或其祖先')
assert.ok(!fs.existsSync(output), '输出目录已存在，请使用全新目录')
for (let ancestor = path.dirname(output); ; ancestor = path.dirname(ancestor)) {
  if (fs.existsSync(ancestor)) assert.ok(!fs.lstatSync(ancestor).isSymbolicLink(), '输出祖先不得为符号链接')
  if (ancestor === path.dirname(ancestor)) break
}
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
// Windows 的 pnpm 生命周期 CWD 可能超过 260 字符；受管 HOME 使用候选内的短新目录。
const shortDshHome = process.platform === 'win32' && ['deepseek-harness', 'deepseek-harness-preview'].includes(engine)
const home = shortDshHome ? path.join(project, '.tmp', `mrh-${id.slice(0, 12)}`) : path.join(output, 'home')
if (shortDshHome) {
  const parent = path.dirname(home)
  if (fs.existsSync(parent)) assert.ok(!fs.lstatSync(parent).isSymbolicLink(), '候选 .tmp 不得为符号链接')
  fs.mkdirSync(parent, { recursive: true })
  fs.mkdirSync(home, { mode: 0o700 })
}
const configDir = path.join(home, '.openclaw')
const hermesHome = path.join(home, '.hermes')
const workspace = path.join(output, 'workspace')
for (const dir of [home, configDir, hermesHome, workspace, path.join(output, 'logs'), path.join(output, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const nonce = `maintenance-${id}`
const reply = `receipt:${id}:完整回复`
const testKey = `local-test-${id}`
const secrets = [testKey]
const required = ['candidate-schema', 'isolation', 'web', 'install', 'version', 'config-sync', 'runtime-health', 'chat', 'provider-receipt', 'stop', 'cleanup']
const report = {
  schemaVersion: 1, runId: id, engine, status: 'failed', fault: fault || null,
  startedAt: new Date().toISOString(), output,
  scope: 'real-production-web-http-e2e-with-local-simulated-provider',
  environment: { platform: process.platform, arch: process.arch, node: process.version, executable: process.execPath, projectRoot: project, toolingRoot, home, configDir, hermesHome, workspace },
  versions: {},
  cases: required.map(name => ({ name, status: 'missing', expected: '实际执行并通过断言', actual: '未执行' })),
  limitations: ['不覆盖浏览器视觉/Tauri/真实消息渠道/收费模型', '隔离 HOME 不是操作系统沙箱；上游安装脚本需在一次性 CI 环境运行'],
}
const children = new Set()
const servers = new Set()
const providerRequests = []
const commands = []
const apiReceipts = []
const runtimeLogs = new Set()
const runtimePids = new Set()
let web, base, port, runtimePort, started = false, sessionId, cursor = 0, embedPrefix, gatewaySocket
let env, deadlineTimer, progressTimer, failure = false, cleaning = false
let PI_PACKAGE_VERSION, OPENCODE_PACKAGE_VERSION, DSH_PACKAGE_VERSION
let hermesRelease
const abort = new AbortController()
function missing(message) { const error = new Error(message); error.missing = true; return error }
function redact(value) {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text.replace(/(\/__(?:dsh|opencode)\/)[^/\s"?]+/g, '$1[SESSION]')
    .replace(/((?:authorization|api[_-]?key|password|token|cookie)["']?\s*[:=]\s*)[^\s,}\n]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|gho)-[\w-]{8,}/g, '[REDACTED]')
}
function safe(value) {
  if (value == null) return value ?? null
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(safe)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:apiKey|password|authorization|cookie|token|upstreamHeaders)$/i.test(key) ? '[REDACTED]' : safe(item)]))
  return value
}
function write(name, value) { fs.writeFileSync(path.join(output, name), typeof value === 'string' ? redact(value) : JSON.stringify(safe(value), null, 2) + '\n', { mode: 0o600 }) }
function save() { write('report.json', report); write('commands.json', commands); write('api-receipts.json', apiReceipts); write('provider-requests.json', providerRequests) }
async function stage(name, expected, fn) {
  const entry = report.cases.find(item => item.name === name)
  Object.assign(entry, { status: 'running', expected, startedAt: new Date().toISOString() }); save()
  console.log(`[${engine}] ${name}`)
  try { entry.actual = safe(await fn() ?? '断言通过'); entry.status = 'passed' }
  catch (error) { entry.actual = redact(error.stack || error.message); entry.status = error.missing ? 'missing' : 'failed'; throw error }
  finally { entry.finishedAt = new Date().toISOString(); save() }
}
function within(file) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file)
  assert.ok([output, home].some(root => {
    const relative = path.relative(fs.realpathSync(root), target)
    return (relative || target === fs.realpathSync(home)) && !relative.startsWith('..') && !path.isAbsolute(relative)
  }), '文件不在本次隔离目录')
  return file
}
function validateCandidate() {
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'clawpanel', '--root 必须是 ClawPanel 项目')
  assert.equal(pkg.type, 'module')
  const semver = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/
  assert.match(pkg.version, semver, 'package.version 格式错误')
  assert.equal(typeof pkg.scripts?.build, 'string')
  assert.equal(typeof pkg.scripts?.serve, 'string')
  const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'))
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version)
  const policy = JSON.parse(fs.readFileSync(path.join(project, 'openclaw-version-policy.json'), 'utf8'))
  assert.match(policy.default?.official?.recommended || '', semver)
  assert.match(policy.default?.chinese?.recommended || '', semver)
  for (const file of ['scripts/serve.js', 'scripts/dev-api.js', 'src/lib/tauri-api.js', 'Dockerfile']) assert.ok(fs.statSync(path.join(project, file)).isFile(), `候选缺少 ${file}`)
  // 只读取声明常量，不 import 候选测试或候选验收实现，避免候选篡改判定器。
  const constant = (file, name, alias = '') => {
    const source = fs.readFileSync(path.join(project, file), 'utf8')
    let value = source.match(new RegExp(`export const ${name} = ['\"]([^'\"]+)['\"]`))?.[1]
    if (!value && alias && new RegExp(`export const ${name} = ${alias}\\b`).test(source)) value = source.match(new RegExp(`export const ${alias} = ['\"]([^'\"]+)['\"]`))?.[1]
    assert.match(value || '', semver, `候选版本声明不合格: ${name}`)
    return value
  }
  PI_PACKAGE_VERSION = constant('scripts/pi-models.js', 'PI_PACKAGE_VERSION')
  OPENCODE_PACKAGE_VERSION = constant('scripts/opencode.js', 'OPENCODE_PACKAGE_VERSION')
  DSH_PACKAGE_VERSION = engine === 'deepseek-harness-preview' ? constant('scripts/deepseek-harness.js', 'DSH_PREVIEW_VERSION') : constant('scripts/deepseek-harness.js', 'DSH_PACKAGE_VERSION', 'DSH_STABLE_VERSION')
  const backend = fs.readFileSync(path.join(project, 'scripts/dev-api.js'), 'utf8')
  const declaration = key => backend.match(new RegExp(`const ${key} = ['\"]([^'\"]+)['\"]`))?.[1] || ''
  hermesRelease = { version: declaration('HERMES_STABLE_VERSION'), tag: declaration('HERMES_STABLE_TAG'), commit: declaration('HERMES_STABLE_COMMIT'), installerSha256: backend.match(/const HERMES_INSTALLER_SHA256\s*=\s*\{[^}]*posix:\s*['"]([a-f0-9]{64})['"]/s)?.[1] || '' }
  assert.match(hermesRelease.version, semver); assert.match(hermesRelease.commit, /^[a-f0-9]{40}$/)
  assert.match(hermesRelease.installerSha256, /^[a-f0-9]{64}$/)
  report.versions = { panel: pkg.version, pi: PI_PACKAGE_VERSION, opencode: OPENCODE_PACKAGE_VERSION, dsh: DSH_PACKAGE_VERSION, openclaw: policy.default.official.recommended, 'openclaw-zh': policy.default.chinese.recommended }
  report.environment.verifierSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  report.environment.verifierDependencyHashes = Object.fromEntries(['scripts/maintenance-pi-process.mjs', 'src/lib/openclaw-gateway-compat.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(toolingRoot, file))).digest('hex')]))
  report.environment.candidateSourceHashes = collectCandidateSourceHashes(project)
  return { packageName: pkg.name, versions: report.versions, candidateRoot: project, verifier: fileURLToPath(import.meta.url) }
}
function requireInstallContainer() {
  // 开关只读 parent 的环境，不接受 CLI、Issue、PR、候选配置或 API 返回值开门。
  const status = process.platform === 'linux' ? fs.readFileSync('/proc/self/status', 'utf8') : ''
  const proof = {
    requestedByParent: process.env.MAINTENANCE_ISOLATED_RUNTIME === '1',
    linux: process.platform === 'linux', dockerMarker: fs.existsSync('/.dockerenv'),
    nonRoot: typeof process.getuid === 'function' && process.getuid() !== 0,
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status), noCapabilities: /^CapEff:\s+0+$/m.test(status),
    noDockerSocket: !fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/docker.sock') && !process.env.DOCKER_HOST,
  }
  report.environment.installContainerProof = proof
  if (!Object.values(proof).every(value => value === true)) throw missing('系统安装门禁未满足：需 parent MAINTENANCE_ISOLATED_RUNTIME=1 + Linux /.dockerenv + 非 root + NoNewPrivs=1 + CapEff=0 + 无 Docker socket；宿主仅设置变量仍不安装。')
  return proof
}
function isolationEnv() {
  // 白名单继承非敏感的可执行文件搜索路径，不继承 Provider/SSH/代理/CI Token。
  const result = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[key]) result[key] = process.env[key]
  Object.assign(result, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.data'), XDG_STATE_HOME: path.join(home, '.state'),
    OPENCLAW_CONFIG_DIR: configDir, OPENCLAW_HOME: configDir, OPENCLAW_STATE_DIR: configDir, OPENCLAW_CONFIG_PATH: path.join(configDir, 'openclaw.json'), HERMES_HOME: hermesHome,
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PI_OFFLINE: '1',
    TMP: path.join(output, 'tmp'), TEMP: path.join(output, 'tmp'), TMPDIR: path.join(output, 'tmp'),
    NPM_CONFIG_CACHE: path.join(home, '.npm-cache'), NPM_CONFIG_PREFIX: path.join(home, '.npm-global'),
    NPM_CONFIG_USERCONFIG: path.join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npm-global-config'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', NPM_CONFIG_FETCH_RETRIES: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', PYTHONNOUSERSITE: '1', UV_CACHE_DIR: path.join(home, '.uv-cache'),
    UV_INSTALL_DIR: path.join(hermesHome, 'bin'), UV_PYTHON_INSTALL_DIR: path.join(home, '.uv-python'), UV_TOOL_DIR: path.join(home, '.uv-tools'), UV_TOOL_BIN_DIR: path.join(home, '.local', 'bin'), PIP_CACHE_DIR: path.join(home, '.pip-cache'),
    DOCKER_CONFIG: path.join(home, '.docker'), MODELS_DEV_API_JSON: path.join(home, 'models-dev.json'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    NO_PROXY: '127.0.0.1,localhost,::1', CI: '1', NO_COLOR: '1',
  })
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'DOCKER_CONFIG']) fs.mkdirSync(result[key], { recursive: true })
  for (const file of [result.NPM_CONFIG_USERCONFIG, result.NPM_CONFIG_GLOBALCONFIG, result.GIT_CONFIG_GLOBAL]) fs.writeFileSync(file, '')
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(npmCli)) result.npm_execpath = npmCli
  const pathKey = Object.keys(result).find(key => key.toUpperCase() === 'PATH') || 'PATH'
  result[pathKey] = [path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'), path.join(hermesHome, 'hermes-agent', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin'), result[pathKey] || ''].join(path.delimiter)
  return result
}
async function terminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return
  if (process.platform === 'win32') {
    await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' }); killer.once('error', resolve); killer.once('close', resolve) })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await new Promise(resolve => setTimeout(resolve, 700))
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))])
  assert.ok(child.exitCode !== null || child.signalCode, `进程 ${child.pid} 未停止`)
}
async function command(program, args, { timeout = 600000, background = false, log = 'commands' } = {}) {
  const record = { program, args: safe(args), cwd: project, startedAt: new Date().toISOString() }
  commands.push(record); save()
  const child = spawn(program, args, { cwd: project, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let text = '', pending = { out: '', err: '' }
  for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
    const lines = (pending[key] + chunk.toString()).split('\n'); pending[key] = lines.pop()
    for (const line of lines) fs.appendFileSync(path.join(output, 'logs', `${log}.log`), redact(line) + '\n')
    text = (text + redact(chunk.toString())).slice(-256000)
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { record.error = error.message; children.delete(child); reject(error) })
    child.once('close', code => {
      for (const tail of Object.values(pending)) if (tail) fs.appendFileSync(path.join(output, 'logs', `${log}.log`), redact(tail) + '\n')
      record.code = code; record.finishedAt = new Date().toISOString(); children.delete(child); save()
      code === 0 ? resolve(text) : reject(new Error(`${program} 退出码 ${code}: ${text.slice(-6000)}`))
    })
  })
  // 后台进程的错误也会体现在 web 健康检测和命令回执中。
  if (background) { done.catch(() => {}); return child }
  let timer, onAbort
  try {
    return await Promise.race([done, new Promise((_, reject) => {
      const cancel = error => { terminate(child).catch(() => {}); reject(error) }
      timer = setTimeout(() => cancel(new Error(`命令超时: ${program}`)), timeout)
      if (!cleaning) {
        onAbort = () => cancel(abort.signal.reason || new Error('验收中断'))
        abort.signal.addEventListener('abort', onAbort, { once: true })
        if (abort.signal.aborted) onAbort()
      }
    })])
  } finally { clearTimeout(timer); if (onAbort) abort.signal.removeEventListener('abort', onAbort) }
}
async function listen(server) { servers.add(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return server.address().port }
async function unusedPort() { const server = net.createServer(); const value = await listen(server); await new Promise(resolve => server.close(resolve)); servers.delete(server); return value }
async function reachable(value) {
  return new Promise(resolve => { const socket = net.createConnection({ host: '127.0.0.1', port: value }); const end = result => { socket.destroy(); resolve(result) }; socket.setTimeout(500, () => end(false)); socket.once('connect', () => end(true)); socket.once('error', () => end(false)) })
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function rememberPiPids() {
  let values
  const entry = path.join(configDir, 'clawpanel', 'pi', 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
  if (process.platform === 'win32') {
    // Web 进程还会拥有 ConsoleHost 等辅助子进程，只把私有 CLI 的 RPC 进程计入停止断言。
    const literal = entry.replaceAll("'", "''")
    const text = await command('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${web.pid}' | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') -and $_.CommandLine.Contains('--mode') -and $_.CommandLine.Contains('rpc') }).ProcessId | ConvertTo-Json -Compress`], { timeout: 15000 })
    const parsed = text.trim() ? JSON.parse(text) : []
    values = Array.isArray(parsed) ? parsed : [parsed]
  } else if (process.platform === 'linux') {
    values = fs.readFileSync(`/proc/${web.pid}/task/${web.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    values = values.filter(pid => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (args.includes(entry) && args.includes('--mode') && args.includes('rpc')) return true
        // 新 Pi 把 argv 改成 pi，额外检查全部归属，避免把无关 Node 子进程计入停止验收。
        const parentPid = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)$/m)?.[1])
        const agentPath = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(value => value.startsWith('PI_CODING_AGENT_DIR='))?.slice('PI_CODING_AGENT_DIR='.length)
        return isManagedRenamedPiProcess({ pid, parentPid, command: args, executable: fs.realpathSync(`/proc/${pid}/exe`), workspace: fs.realpathSync(`/proc/${pid}/cwd`), agentPath }, { parentPid: web.pid, nodePath: fs.realpathSync(process.execPath), workspace: fs.realpathSync(workspace), agentPath: path.join(configDir, 'clawpanel', 'pi', 'agent') })
      } catch { return false }
    })
  } else {
    const text = await command('pgrep', ['-P', String(web.pid)], { timeout: 10000 })
    values = text.trim().split(/\s+/).filter(Boolean).map(Number)
    const selected = []
    for (const pid of values) {
      const args = await command('ps', ['-p', String(pid), '-o', 'command='], { timeout: 10000 })
      if (args.includes(entry) && args.includes('--mode') && args.includes('rpc')) selected.push(pid)
    }
    values = selected
  }
  assert.ok(values.length > 0 && values.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Pi API 就绪但未发现其真实子进程')
  for (const pid of values) runtimePids.add(pid)
  report.environment.runtimePids = [...runtimePids]
}
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    if (!cleaning) abort.signal.throwIfAborted()
    try { const result = await fn(); if (result) return result } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`等待超时${last ? ': ' + last.message : ''}`)
}
async function request(url, body, method = body === undefined ? 'GET' : 'POST', timeout = 60000) {
  assert.equal(new URL(url).hostname, '127.0.0.1', '验收 HTTP 只能访问回环地址')
  const signal = cleaning ? AbortSignal.timeout(timeout) : AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)])
  const headers = { 'content-type': 'application/json' }
  // 安装可能超过 fetch 内部的 header 等待上限，使用原生 HTTP 贯彻显式总预算；不跟随重定向。
  const response = timeout > 240000 ? await new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, signal }, res => {
      const chunks = []; let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) { res.destroy(new Error('验收 HTTP 响应超过预算')); return }
        chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: new Headers(Object.entries(res.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]])), arrayBuffer: async () => Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  }) : await fetch(url, { method, redirect: 'error', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const headers = Object.fromEntries([...response.headers].filter(([key]) => !/cookie|authorization/i.test(key)))
    apiReceipts.push({ url: redact(url), method, status: response.status, headers, contentEncoding: response.headers.get('content-encoding'), contentType: response.headers.get('content-type'), bytes: bytes.length, failure: 'gzip-without-decodable-content-encoding', prefixHex: bytes.subarray(0, 64).toString('hex') }); save()
    throw new Error('内嵌代理返回未解码 gzip；Content-Encoding 丢失会使真实浏览器 JSON 读取失败')
  }
  const text = bytes.toString('utf8')
  let value
  try { value = JSON.parse(text) } catch { value = text }
  apiReceipts.push({ url: redact(url), method, request: safe(body ?? null), status: response.status, response: safe(value) }); save()
  assert.ok(response.ok, `${response.status} ${redact(JSON.stringify(value)).slice(0, 6000)}`)
  // DSH 停止响应带当前探测诊断，PID 退出与端口关闭并非同一时刻；最终状态由 stop 阶段独立核验。
  const dshStatusDiagnostic = /\/__api\/dsh_(?:stop|status)$/.test(new URL(url).pathname)
    && typeof value?.running === 'boolean' && typeof value?.portOpen === 'boolean'
  if (value && typeof value === 'object' && !dshStatusDiagnostic) assert.ok(!value.error, `响应错误: ${redact(JSON.stringify(value.error))}`)
  if (value?.logPath) runtimeLogs.add(within(value.logPath))
  return value
}
const api = (name, body = {}, timeout) => request(`${base}/__api/${name}`, body, 'POST', timeout)
const pi = (command, args = {}, timeout) => api('pi_call', { command, args }, timeout)
async function provider() {
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 8 * 1024 * 1024, 'Provider 请求过大') }
      const body = raw ? JSON.parse(raw) : {}
      const entry = { at: new Date().toISOString(), path: req.url, method: req.method, authorizationPresent: Boolean(req.headers.authorization), authorizationMatchesFixture: req.headers.authorization === `Bearer ${testKey}`, body }
      providerRequests.push(entry); save()
      if (req.url === '/v1/models' && req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'maintenance-model', object: 'model', owned_by: 'local' }] }))
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return res.writeHead(404).end('{}')
      assert.ok(entry.authorizationMatchesFixture, 'Provider 未收到本次同步的测试凭据；不记录实际 Header')
      assert.equal(body.model, 'maintenance-model')
      assert.ok(JSON.stringify(body.messages).includes(nonce), '缺少本次唯一提示词')
      const result = { id, object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
      send({ role: 'assistant', content: reply.slice(0, -4) })
      await new Promise(resolve => setTimeout(resolve, 80))
      send({ content: reply.slice(-4) }); send({}, 'stop'); res.end('data: [DONE]\n\n')
    } catch (error) { providerRequests.push({ error: error.message }); save(); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })) }
  })
  const value = await listen(server)
  report.environment.provider = `http://127.0.0.1:${value}/v1`
  return report.environment.provider
}
async function setupWeb() {
  assert.ok(fs.existsSync(path.join(project, 'dist', 'index.html')), '缺少生产 dist，请先 npm run build')
  port = await unusedPort(); runtimePort = await unusedPort()
  fs.writeFileSync(path.join(configDir, 'clawpanel.json'), JSON.stringify({ ignoreRisk: true, openclawDir: configDir }))
  fs.writeFileSync(path.join(configDir, 'npm-registry.txt'), 'https://registry.npmjs.org')
  if (engine === 'openclaw') fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({ gateway: { port: runtimePort } }))
  env.HOST = '127.0.0.1'; env.PORT = String(port)
  web = await command(process.execPath, [path.join(project, 'scripts', 'serve.js'), '--host', '127.0.0.1', '--port', String(port)], { background: true, log: 'web' })
  base = `http://127.0.0.1:${port}`
  const health = await until(async () => { if (web.exitCode !== null) throw new Error('Web 进程已退出'); return await request(`${base}/__api/health`) })
  assert.equal(health.backendVersion, report.versions.panel)
  const location = await api('get_openclaw_dir')
  assert.equal(path.resolve(location.path), configDir)
  assert.equal(typeof await request(`${base}/`), 'string')
  return { health, location, base, runtimePort }
}
async function channel() {
  const value = { id: 'maintenance-local', name: 'Maintenance local provider', apiType: 'openai-completions', baseUrl: report.environment.provider, apiKey: testKey, models: [{ id: 'maintenance-model', name: 'Maintenance model', contextWindow: 65536, maxTokens: 4096, input: ['text'] }], defaultModel: 'maintenance-model' }
  const saved = await api('write_model_channels', { config: { version: 2, channels: [value], syncState: {} } })
  assert.equal(saved.channels[0].id, value.id)
  const read = await api('read_model_channels')
  assert.equal(read.channels[0].baseUrl, value.baseUrl)
  assert.equal(read.channels[0].models[0].contextWindow, 65536)
  return value
}
async function piEvents(predicate) {
  const events = []
  await until(async () => { const result = await pi('events', { sessionId, after: cursor }); cursor = result.cursor; events.push(...result.events.map(record => record.event)); return predicate(events) })
  write('pi-events.json', events)
  return events
}
async function piRun() {
  await stage('install', '通过真实生产 API 安装 Pi；安装失败必须非零', async () => {
    if (fault === 'install') {
      const registry = http.createServer((req, res) => res.writeHead(503).end('deliberate-install-failure'))
      const badPort = await listen(registry)
      registry.on('clientError', (_error, socket) => socket.destroy())
      await api('set_npm_registry', { registry: `https://127.0.0.1:${badPort}` })
    }
    const installed = await pi('install', {}, 600000)
    assert.equal(installed.installed, true); within(installed.root)
    return installed
  })
  await stage('version', '核验 API 与执行文件版本均匹配推荐常量', async () => {
    const status = await pi('status')
    report.versions.pi = status.version; report.versions.expected = PI_PACKAGE_VERSION
    assert.equal(status.version, fault === 'version' ? '0.0.0' : PI_PACKAGE_VERSION)
    // 安装器内部已执行两次 CLI --version；此处独立再执行一次。
    const entry = within(path.join(status.root, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'))
    const actual = await command(process.execPath, [entry, '--version'])
    assert.ok(actual.split(/\r?\n/).includes(PI_PACKAGE_VERSION))
    return { status: status.version, executable: actual.trim() }
  })
  let synced
  await stage('config-sync', '统一渠道 → Pi Provider → 配置回读', async () => {
    const ch = await channel()
    synced = await pi('sync_provider', { channelId: ch.id, setDefault: true })
    assert.equal(synced.verified, true)
    const status = await pi('configure', { workspace, allowTools: false })
    assert.equal(status.defaultModel, 'maintenance-model'); assert.equal(status.providers[0].models[0].contextWindow, 65536)
    return { synced, defaultModel: status.defaultModel }
  })
  await stage('runtime-health', '真实 Pi RPC 会话可用且只读', async () => {
    const opened = await pi('open_session'); sessionId = opened.sessionId; cursor = opened.cursor
    assert.ok(opened.models.some(model => model.id === 'maintenance-model'))
    await rememberPiPids()
    return { sessionId, state: opened.state }
  })
  if (fault === 'not-executed') throw missing('故意停止执行；chat/provider-receipt 不得标 passed')
  if (fault === 'provider') {
    report.cases.find(item => item.name === 'chat').actual = '故障注入：只配置/打开会话，不发送 prompt；Provider 回执门禁应失败'
    return
  }
  await stage('chat', '真实 RPC prompt 流式返回完整本次回执与终止事件', async () => {
    await pi('prompt', { sessionId, message: nonce })
    const events = await piEvents(list => list.some(event => event.type === 'agent_settled'))
    const final = events.findLast(event => event.type === 'message_end' && event.message?.role === 'assistant')
    assert.ok(final?.message.content.some(block => block.text === reply), 'Pi 回复缺失或截断')
    assert.ok(events.filter(event => event.assistantMessageEvent?.type === 'text_delta').length >= 2)
    await pi('close_session', { sessionId })
    const restored = await pi('open_session', { sessionId })
    await rememberPiPids()
    assert.ok(JSON.stringify(restored.messages).includes(reply), '历史恢复缺少完整回执')
    return { final: final.message, restoredMessages: restored.messages.length }
  })
}
async function openCodeRun() {
  await stage('install', '真实 API 安装受管 OpenCode 二进制', async () => { const value = await api('opencode_install', {}, 600000); assert.equal(value.managedInstalled, true); within(value.path); return value })
  await stage('version', '包版本、CLI、健康版本一致', async () => {
    const status = await api('opencode_status', { port: runtimePort })
    report.versions.opencode = status.version; report.versions.expected = OPENCODE_PACKAGE_VERSION
    assert.equal(status.version, OPENCODE_PACKAGE_VERSION)
    const actual = await command(within(status.path), ['--version']); assert.ok(actual.split(/\r?\n/).includes(OPENCODE_PACKAGE_VERSION))
    return { version: status.version, executable: actual.trim() }
  })
  let synced
  await stage('config-sync', '统一渠道 → OpenCode Provider → 持久配置回读', async () => {
    const ch = await channel(); synced = await api('opencode_sync_provider', { channelId: ch.id, setDefault: true }); assert.equal(synced.verified, true)
    const status = await api('opencode_status', { port: runtimePort })
    const config = JSON.parse(fs.readFileSync(within(status.configPath)))
    assert.equal(config.model, `${synced.providerId}/maintenance-model`); assert.equal(config.provider[synced.providerId].options.baseURL, ch.baseUrl)
    return { synced, model: config.model }
  })
  await stage('runtime-health', '随机回环端口启动、认证与面板内嵌代理健康', async () => {
    assert.equal(await reachable(runtimePort), false, '启动前端口被占用')
    started = true; const status = await api('opencode_start', { port: runtimePort }); assert.equal(status.managed, true); assert.equal(status.version, OPENCODE_PACKAGE_VERSION)
    assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0); runtimePids.add(status.pid)
    const embed = await api('opencode_embed_session', { port: runtimePort }); embedPrefix = embed.src.replace(/\/$/, '')
    const health = await request(`${base}${embedPrefix}/global/health`); assert.equal(health.healthy, true)
    return { status, embed, health }
  })
  await stage('chat', '通过面板内嵌代理创建真实会话并返回完整本次回执', async () => {
    const session = await request(`${base}${embedPrefix}/session`, { title: nonce }); sessionId = session.id; assert.ok(sessionId)
    const response = await request(`${base}${embedPrefix}/session/${sessionId}/message`, { model: { providerID: synced.providerId, modelID: 'maintenance-model' }, parts: [{ type: 'text', text: nonce }] }, 'POST', 120000)
    assert.ok(!response.info?.error, 'OpenCode 消息以错误结束')
    assert.equal(response.info?.finish, 'stop')
    assert.ok(response.parts?.some(part => part.type === 'text' && part.text === reply), 'OpenCode 回复缺失/截断')
    const history = await request(`${base}${embedPrefix}/session/${sessionId}/message`); assert.ok(JSON.stringify(history).includes(reply))
    return { response, historyMessages: history.length }
  })
}
async function dshRpc(method, args = {}) {
  const rpcId = crypto.randomUUID()
  const namedArgs = method.startsWith('session/') ? { request: args } : args
  const response = await request(`${base}${embedPrefix}/api/${method}`, { type: 'client-request', rpcId, method, payload: { args: namedArgs } })
  assert.equal(response.rpcId, rpcId); assert.equal(response.result?.ok, true, JSON.stringify(response.result))
  return response.result.value
}
async function dshRun() {
  await stage('install', '真实 API 安装受管 DSH 指定通道，不把预览冒充默认', async () => { const value = await api('dsh_install', { channel: engine === 'deepseek-harness-preview' ? 'preview' : 'stable' }, 900000); assert.equal(value.managedInstalled, true); within(value.path); return value })
  await stage('version', 'API 与 CLI 版本与默认通道一致', async () => {
    const status = await api('dsh_status', { port: runtimePort }); report.versions.dsh = status.version; report.versions.expected = DSH_PACKAGE_VERSION
    assert.equal(status.version, DSH_PACKAGE_VERSION)
    const actual = await command(process.execPath, [within(status.path), '--version']); assert.ok(actual.includes(DSH_PACKAGE_VERSION)); return { version: status.version, executable: actual.trim() }
  })
  // DSH 同步 API 依赖正在运行的设置命名空间，因此先启动再同步。
  await stage('runtime-health', '真实 DSH 设置命名空间/模型目录可用，面板代管认证', async () => {
    assert.equal(await reachable(runtimePort), false, '启动前端口被占用')
    started = true; const value = await api('dsh_start', { port: runtimePort }, 120000); assert.equal(value.managed, true); assert.equal(value.running, true)
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0); runtimePids.add(value.pid)
    const embed = await api('dsh_embed_session', { port: runtimePort }); embedPrefix = embed.src.replace(/\/$/, '')
    const describe = await dshRpc('settings/describe'); assert.equal(describe.writable, true)
    return { value, embed, writable: describe.writable }
  })
  let synced
  await stage('config-sync', '统一渠道 → DSH Provider/凭据/默认模型三方回读', async () => {
    const ch = await channel(); synced = await api('dsh_sync_provider', { channelId: ch.id, setDefault: true, port: runtimePort }); assert.equal(synced.verified, true)
    const status = await api('dsh_status', { port: runtimePort }); assert.ok(status.summary.configuredProviders.includes(synced.providerId)); return { synced, summary: status.summary }
  })
  await stage('chat', '真实 DSH session send 完成并持久化本次回执', async () => {
    // 斜线 RPC 契约来自安装后的真实 DSH；若上游不兼容，保留失败响应。
    const created = await dshRpc('session/create', { cwd: workspace }); sessionId = created.sessionId || created.id
    assert.ok(sessionId, 'DSH session/create 未返回会话 ID')
    await dshRpc('session/selectModel', { sessionId, provider: synced.providerId, model: 'maintenance-model' })
    const accepted = await dshRpc('session/prompt', { sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: nonce }] })
    assert.equal(accepted.accepted, true)
    const history = await until(async () => {
      const projection = await dshRpc('session/projections', { sessionId })
      assert.ok(Number.isSafeInteger(projection?.asOfSeq), 'DSH 投影缺少持久日志水位')
      const value = await dshRpc('session/page', { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 100 })
      const records = value.records || []
      return records.some(item => item.event?.type === 'assistant/message' && JSON.stringify(item.event.data).includes(reply))
        && records.some(item => item.event?.type === 'turn/end') ? value : false
    }, 120000)
    return { sessionId, history }
  })
}
async function hermesRun() {
  await stage('install', '仅在经过 parent 核验的非特权 Linux 容器内执行精确 commit/hash 官方安装 API', async () => {
    const proof = requireInstallContainer()
    const output = await api('install_hermes', { method: 'uv-tool' }, 900000)
    const installer = within(path.join(hermesHome, '.clawpanel-cache', `install-${hermesRelease.tag}.sh`))
    const installerSha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex')
    assert.equal(installerSha256, hermesRelease.installerSha256)
    const commit = (await command('git', ['-C', within(path.join(hermesHome, 'hermes-agent')), 'rev-parse', 'HEAD'])).trim()
    assert.equal(commit, hermesRelease.commit)
    return { proof, output, expected: hermesRelease, commit, installerSha256 }
  })
  await stage('version', 'Hermes 真实 CLI 与精确 commit 对应版本一致', async () => {
    const status = await api('check_hermes'); assert.equal(status.installed, true); assert.equal(status.version, hermesRelease.version)
    const cli = within(status.path || path.join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes'))
    const actual = await command(cli, ['--version']); assert.ok(actual.includes(hermesRelease.version))
    report.versions.hermes = hermesRelease.version
    return { version: status.version, actual }
  })
  await stage('config-sync', 'Hermes 独立 HOME 内模型同步和配置回读（不冒充运行时）', async () => {
    await channel()
    const profiles = await api('hermes_profiles_list')
    assert.ok(profiles.profiles.some(profile => profile.name === 'default'), '默认 Profile 未被真实 CLI 发现')
    await api('hermes_profile_use', { name: 'default' })
    const synced = await api('hermes_sync_provider', { provider: 'custom', apiKey: testKey, baseUrl: report.environment.provider, model: 'maintenance-model', setDefault: true })
    const config = await api('hermes_read_config'); assert.equal(config.model_raw, 'maintenance-model'); assert.equal(config.base_url, report.environment.provider)
    await api('hermes_env_set', { key: 'API_SERVER_PORT', value: String(runtimePort) })
    await api('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' })
    await api('hermes_set_gateway_url', { url: `http://127.0.0.1:${runtimePort}` })
    return { synced, profiles, configExists: config.config_exists, model: config.model_raw }
  })
  await stage('runtime-health', '随机回环端口启动真实 Hermes Gateway；API 健康/能力与独立 PID', async () => {
    assert.equal(await reachable(runtimePort), false)
    runtimeLogs.add(path.join(hermesHome, 'gateway-run.log'))
    started = true
    await api('hermes_gateway_action', { action: 'start' }, 120000)
    const health = await api('hermes_health_check')
    const capability = await api('hermes_capabilities')
    const pids = fs.readFileSync(`/proc/${web.pid}/task/${web.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    for (const pid of pids) {
      try { const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); if (args.includes(hermesHome) && args.includes('gateway')) runtimePids.add(pid) } catch {}
    }
    assert.ok(runtimePids.size > 0, '未找到受管 Hermes Gateway PID')
    const runtimeKey = fs.readFileSync(within(path.join(hermesHome, '.env')), 'utf8').match(/^API_SERVER_KEY=(.+)$/m)?.[1]?.trim()
    if (runtimeKey) secrets.push(runtimeKey)
    return { health, capability, pids: [...runtimePids] }
  })
  await stage('chat', '面板原生 Hermes run → 终态 → 完整回复', async () => {
    const runId = await api('hermes_agent_run', { input: nonce })
    assert.equal(typeof runId, 'string')
    const result = await until(async () => {
      const value = await api('hermes_run_status', { runId })
      if (['failed', 'error', 'cancelled'].includes(value.status)) throw new Error(`Hermes run 失败: ${JSON.stringify(value)}`)
      return ['completed', 'succeeded', 'done'].includes(value.status) && JSON.stringify(value).includes(reply) ? value : false
    }, 120000)
    return { runId, result }
  })
}
async function openclawRun() {
  const prefix = path.join(home, '.npm-global')
  let cli
  await stage('install', '隔离 Linux 容器内独立 npm-prefix 精确安装 candidate 官方版本；不访问 Docker socket', async () => {
    const proof = requireInstallContainer()
    assert.equal(report.versions.openclaw, report.cases.find(item => item.name === 'candidate-schema').actual.versions.openclaw)
    await command('npm', ['install', '--global', '--prefix', prefix, '--save-exact', '--audit=false', '--fund=false', '--registry', 'https://registry.npmjs.org', `openclaw@${report.versions.openclaw}`], { timeout: 600000, log: 'openclaw-install' })
    const pkgDir = within(path.join(prefix, 'lib', 'node_modules', 'openclaw'))
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'openclaw'); assert.equal(pkg.version, report.versions.openclaw)
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.openclaw
    assert.equal(typeof bin, 'string'); cli = within(path.resolve(pkgDir, bin)); assert.ok(fs.existsSync(cli))
    return { proof, prefix, cli, version: pkg.version }
  })
  await stage('version', '独立执行已安装官方 CLI，版本必须精确匹配候选', async () => {
    const actual = await command(process.execPath, [cli, '--version']); assert.ok(actual.includes(report.versions.openclaw)); return { actual }
  })
  await stage('config-sync', '面板生产 HTTP 写入模型、Agent、Gateway 配置并交由真实 CLI validate', async () => {
    const panel = await api('read_panel_config'); await api('write_panel_config', { config: { ...panel, openclawCliPath: cli } })
    const config = {
      agents: { ownership: 'explicit', defaults: { model: { primary: 'maintenance/maintenance-model' } }, entries: { main: { workspace } } },
      gateway: { port: runtimePort, bind: 'loopback', mode: 'local', auth: { mode: 'token', token: testKey }, controlUi: { allowedOrigins: ['http://localhost', base] } },
      models: { providers: { maintenance: { baseUrl: report.environment.provider, api: 'openai-completions', apiKey: testKey, models: [{ id: 'maintenance-model', name: 'Local maintenance', contextWindow: 65536, maxTokens: 4096 }] } } },
    }
    await api('write_openclaw_config', { config })
    const saved = await api('read_openclaw_config'); assert.equal(saved.models.providers.maintenance.baseUrl, report.environment.provider); assert.equal(saved.gateway.port, runtimePort)
    const valid = await command(process.execPath, [cli, 'config', 'validate', '--json']); return { config: saved, valid }
  })
  let rpc, frames
  await stage('runtime-health', '生产 API 启动 Gateway，并经 candidate /ws 完成签名握手', async () => {
    assert.equal(await reachable(runtimePort), false)
    runtimeLogs.add(path.join(configDir, 'logs', 'gateway.log')); runtimeLogs.add(path.join(configDir, 'logs', 'gateway.err.log'))
    started = true; await api('start_service', { label: 'ai.openclaw.gateway' }, 120000)
    const services = await api('get_services_status')
    for (const service of services) if (service.label === 'ai.openclaw.gateway' && service.running && Number.isSafeInteger(service.pid) && service.pid > 0) runtimePids.add(service.pid)
    assert.ok(runtimePids.size > 0, '生产 Gateway 状态没有实际 PID')
    const connection = await awaitOpenclawReady(); rpc = connection.rpc; frames = connection.frames
    return { services, handshake: connection.hello, startupRetries: connection.startupRetries }
  })
  await stage('chat', '真实 Gateway chat.send、终态事件与 chat.history 完整本次回执', async () => {
    const sessionKey = `agent:main:${id}`
    const sent = await rpc('chat.send', { sessionKey, message: nonce, deliver: false, idempotencyKey: crypto.randomUUID() })
    const history = await until(async () => {
      const value = await rpc('chat.history', { sessionKey, limit: 100 })
      const final = frames.some(frame => frame.type === 'event' && frame.event === 'chat' && frame.payload?.state === 'final' && (!sent.runId || frame.payload.runId === sent.runId))
      return final && JSON.stringify(value).includes(reply) ? value : false
    }, 120000)
    write('openclaw-frames.json', frames)
    return { sent, history }
  })
}
async function awaitOpenclawReady() {
  const deadline = Date.now() + 30000, retries = []
  while (true) {
    try { return { ...await openclawConnect(), startupRetries: retries.length } }
    catch (error) {
      gatewaySocket?.close()
      if (error.code !== 'UNAVAILABLE' || error.retryable !== true || Date.now() >= deadline) throw error
      retries.push({ at: new Date().toISOString(), code: error.code, message: error.message, retryAfterMs: error.retryAfterMs })
      write('openclaw-startup-retries.json', retries)
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(100, Number(error.retryAfterMs) || 500))))
    }
  }
}
async function openclawConnect() {
  if (typeof WebSocket !== 'function') throw missing('Node 缺少原生 WebSocket')
  const frames = [], pending = new Map()
  let resolveChallenge, rejectChallenge
  const challengeReady = new Promise((resolve, reject) => { resolveChallenge = resolve; rejectChallenge = reject })
  gatewaySocket = new WebSocket(base.replace('http:', 'ws:') + '/ws')
  gatewaySocket.addEventListener('error', () => rejectChallenge(new Error('candidate WebSocket 连接失败')))
  gatewaySocket.addEventListener('message', event => {
    try {
      const frame = JSON.parse(String(event.data)); frames.push(frame)
      write('openclaw-frames.json', frames)
      if (frame.type === 'event' && frame.event === 'connect.challenge') resolveChallenge(frame.payload)
      const request = pending.get(frame.id)
      if (frame.type === 'res' && request) {
        pending.delete(frame.id)
        if (frame.ok) request.resolve(frame.payload)
        else request.reject(Object.assign(new Error(JSON.stringify(frame.error)), { code: frame.error?.code, retryable: frame.error?.retryable, retryAfterMs: frame.error?.retryAfterMs }))
      }
    } catch (error) { rejectChallenge(error) }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`Gateway RPC 超时: ${method}`)) }, 15000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    gatewaySocket.send(JSON.stringify({ type: 'req', id, method, params }))
  })
  let timer
  const challenge = await Promise.race([challengeReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gateway challenge 超时')), 15000) })]).finally(() => clearTimeout(timer))
  const keys = crypto.generateKeyPairSync('ed25519'), raw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const deviceId = crypto.createHash('sha256').update(raw).digest('hex'), signedAt = resolveConnectSignedAt(challenge.ts)
  const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write']
  const metadata = { deviceId, clientId: 'openclaw-control-ui', clientMode: 'ui', role: 'operator', scopes, signedAt, signatureToken: testKey, nonce: challenge.nonce, platform: 'linux', deviceFamily: 'desktop' }
  const signature = crypto.sign(null, Buffer.from(buildDeviceAuthPayloadV3(metadata)), keys.privateKey).toString('base64url')
  const hello = await rpc('connect', { minProtocol: OPENCLAW_PROTOCOL_RANGE.min, maxProtocol: OPENCLAW_PROTOCOL_RANGE.max, client: { id: 'openclaw-control-ui', version: '1.0.0', platform: 'linux', deviceFamily: 'desktop', mode: 'ui' }, role: 'operator', scopes, caps: [], auth: { token: testKey }, device: { id: deviceId, publicKey: raw.toString('base64url'), signedAt, nonce: challenge.nonce, signature }, locale: 'zh-CN', userAgent: 'ClawPanel maintenance E2E' })
  assert.ok([3, 4].includes(hello.protocol), 'Gateway 没有协商受支持协议')
  return { rpc, frames, hello }
}
async function stopRuntime() {
  if (engine === 'pi' && sessionId) {
    await pi('close_session', { sessionId })
    const status = await pi('status'); assert.equal(status.activeSessions, 0)
    await until(() => [...runtimePids].every(pid => !alive(pid)), 10000)
    return { activeSessions: status.activeSessions, runtimePids: [...runtimePids], processesExited: true }
  }
  if (started) {
    gatewaySocket?.close()
    let result
    if (engine === 'hermes') result = await api('hermes_gateway_action', { action: 'stop' }, 30000)
    else if (engine === 'openclaw') result = await api('stop_service', { label: 'ai.openclaw.gateway' }, 30000)
    else result = await api(`${engine === 'opencode' ? 'opencode' : 'dsh'}_stop`, { port: runtimePort }, 30000)
    await until(async () => !await reachable(runtimePort), 10000)
    await until(() => [...runtimePids].every(pid => !alive(pid)), 10000)
    if (result && typeof result === 'object') assert.equal(result.running, false)
    let finalStatus
    if (['deepseek-harness', 'deepseek-harness-preview'].includes(engine)) finalStatus = await until(async () => {
      const status = await api('dsh_status', { port: runtimePort })
      return !status.running && !status.portOpen && !status.error ? status : false
    }, 10000)
    return { port: runtimePort, closed: true, runtimePids: [...runtimePids], processesExited: true, ...(finalStatus ? { stopReceipt: result, finalStatus } : {}) }
  }
  return { noRuntimeStarted: true }
}
async function cleanup() {
  cleaning = true
  gatewaySocket?.close()
  const errors = []
  if (base && ((started && report.cases.find(c => c.name === 'stop').status !== 'passed') || sessionId)) {
    try { await stopRuntime() } catch (error) { errors.push('运行时清理: ' + error.message) }
  }
  for (const child of children) try { await terminate(child) } catch (error) { errors.push(error.message) }
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
  if (port && await reachable(port)) errors.push('Web 端口仍可达')
  if (started && runtimePort && await reachable(runtimePort)) errors.push('运行时端口仍可达')
  for (const pid of runtimePids) if (alive(pid)) errors.push(`本次运行时 PID ${pid} 仍存活`)
  // 只采集本次目录的已知日志，不遍历 node_modules 或读取用户凭据。
  for (const [name, file] of [
    ['pi-runtime', path.join(configDir, 'clawpanel', 'pi', 'runtime.log')],
    ['opencode-runtime', path.join(configDir, 'clawpanel', 'opencode', 'runtime', 'server.log')],
    ['dsh-runtime', path.join(configDir, 'clawpanel', 'deepseek-harness', 'dsh.log')],
  ]) if (fs.existsSync(within(file))) write(`logs/${name}.log`, fs.readFileSync(file, 'utf8').slice(-128000))
  for (const file of runtimeLogs) if (fs.existsSync(within(file))) write(`logs/captured-${path.basename(file)}`, fs.readFileSync(file, 'utf8').slice(-128000))
  assert.equal(errors.length, 0, errors.join('; '))
  return { webPortClosed: true, runtimePortClosed: !started || !await reachable(runtimePort), artifactsRetained: true }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)))
try {
  env = isolationEnv()
  if (fault === 'isolation') {
    const wrongHome = path.join(output, 'misdirected-home')
    fs.mkdirSync(wrongHome)
    env.HOME = wrongHome; env.USERPROFILE = wrongHome
  }
  deadlineTimer = setTimeout(() => abort.abort(new Error('整体超时')), timeoutMs)
  progressTimer = setInterval(() => {
    const current = report.cases.find(item => item.status === 'running')
    if (current) console.log(`[${engine}] ${current.name}: running ${Math.round((Date.now() - Date.parse(current.startedAt)) / 1000)}s; evidence=${path.join(output, 'report.json')}`)
  }, 30000)
  await stage('candidate-schema', 'candidate package/lock/策略与版本声明合格；验收器从 tooling 执行', validateCandidate)
  await stage('isolation', '新 HOME 子进程路径回读全部位于本次目录；无继承凭据', async () => {
    // parent 选择容器验收时，每个引擎都回读真实隔离事实；宿主只设变量不算通过。
    if (process.env.MAINTENANCE_ISOLATED_RUNTIME === '1') requireInstallContainer()
    const source = "console.log(JSON.stringify({osHomedir:require('node:os').homedir(),...Object.fromEntries(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','OPENCLAW_CONFIG_DIR','HERMES_HOME'].map(k=>[k,process.env[k]]))}))"
    const result = JSON.parse((await command(process.execPath, ['-e', source])).trim())
    for (const value of Object.values(result)) within(value)
    assert.equal(path.resolve(result.osHomedir), home)
    report.environment.isolation = result
    // NTFS bind mount 的 owner 可能与容器 UID 不同；仅此命令信任已核验的精确候选目录。
    const revision = await command('git', ['-c', `safe.directory=${project}`, '-C', project, 'rev-parse', 'HEAD']); report.environment.commit = revision.trim()
    return result
  })
  if (['openclaw-zh', 'weixin'].includes(engine)) {
    await stage('install', '独立 source id 只允许针对该发行物的实测；高风险项不自动选择', async () => { throw missing(`${engine} 尚无独立安装/真实渠道或预览版聊天验收；保持高风险人工确认，不降级为 official/stable 验收`) })
  }
  await stage('web', '真实 serve.js 绑定随机回环端口，配置根目录回读与健康一致', setupWeb)
  await provider()
  if (engine === 'pi') await piRun()
  else if (engine === 'opencode') await openCodeRun()
  else if (['deepseek-harness', 'deepseek-harness-preview'].includes(engine)) await dshRun()
  else if (engine === 'hermes') await hermesRun()
  else await openclawRun()
  await stage('provider-receipt', '真实模型 HTTP 请求含唯一提示词、模型和本地凭据，完整回复已由引擎读回', async () => {
    const calls = providerRequests.filter(item => item.path === '/v1/chat/completions')
    assert.ok(calls.length > 0, 'Provider 未调用')
    assert.ok(calls.some(item => item.body.model === 'maintenance-model' && JSON.stringify(item.body.messages).includes(nonce) && item.authorizationMatchesFixture), 'Provider 回执不匹配')
    assert.ok(!providerRequests.some(item => item.error), 'Provider 有错误回执')
    return { requests: calls.length, nonce, expectedReply: reply }
  })
  await stage('stop', '受管进程停止后端口/会话关闭', async () => {
    if (fault === 'stop') {
      const before = await pi('status')
      assert.equal(before.activeSessions, 0, '故障注入：未执行停止，真实 RPC 进程仍存活；finally 负责清理')
    }
    return stopRuntime()
  })
} catch (error) {
  failure = true; report.error = redact(error.stack || error.message)
  console.error(redact(error.message))
} finally {
  clearTimeout(deadlineTimer)
  clearInterval(progressTimer)
  // 整体超时/中断之后也留出有界清理窗口。
  try { await stage('cleanup', '停止本次进程/回环服务，保留脱敏证据；清理失败整体失败', cleanup) } catch (error) { failure = true; report.cleanupError = redact(error.message) }
  report.finishedAt = new Date().toISOString()
  report.status = !failure && !fault && report.cases.every(item => item.status === 'passed') ? 'passed' : report.cases.some(item => item.status === 'failed') ? 'failed' : 'missing'
  report.exitCode = report.status === 'passed' ? 0 : 1
  report.rerun = { argv: [process.execPath, fileURLToPath(import.meta.url), '--root', project, '--engine', engine, '--timeout-ms', String(timeoutMs), ...(fault ? ['--fault', fault] : [])], output: '省略 --output 时自动生成新目录，不覆盖本次证据' }
  save()
  write('report.md', `# ${engine}: ${report.status}\n\n- Run: ${id}\n- Commit: ${report.environment.commit || 'unknown'}\n- Node: ${process.version}\n- Scope: ${report.scope}\n\n| Phase | Status | Actual |\n| --- | --- | --- |\n${report.cases.map(item => `| ${item.name} | ${item.status} | ${JSON.stringify(item.actual).replaceAll('|', '/').replaceAll('\\n', ' ').slice(0, 700)} |`).join('\n')}\n\n${report.error || ''}\n\n重新运行 argv（保留 tooling/candidate 分离，自动新输出目录）：\n\n\`\`\`json\n${JSON.stringify(report.rerun.argv, null, 2)}\n\`\`\`\n`)
  console.log(JSON.stringify({ engine, status: report.status, output, report: path.join(output, 'report.json') }))
  process.exitCode = report.exitCode
}
