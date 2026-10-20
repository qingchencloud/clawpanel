#!/usr/bin/env node
/** 只用于非特权 Linux CI 的 Hermes warm UI 验收。安装仍由原 fresh11 verifier 完成。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { errorMonitor } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyHermesMetadataRequest } from './hermes-qualification-provider.mjs'

export const ORIGINAL_SOURCES = Object.freeze({
  bootstrap: '45209e4fbd161555c0bac5c47d5cb62bd8a655280baf634faf2f728fb542ee97',
  browser: '3a46991eb5bcd6a365624ab78488943097cabfa4a2ee66d9ccc9e6a4ec81eaa2',
})
export const STAGES = ['candidate-schema', 'isolation', 'web', 'install', 'version', 'config-sync', 'runtime-health', 'chat', 'provider-receipt', 'stop', 'cleanup']
export const SOURCE_FILES = ['scripts/serve.js', 'scripts/dev-api.js', 'scripts/pi-models.js', 'scripts/opencode.js', 'scripts/opencode-proxy.js', 'scripts/deepseek-harness.js', 'scripts/deepseek-harness-auth.js', 'scripts/deepseek-harness-proxy.js', 'src/lib/opencode-storage-bridge.js', 'src/lib/openclaw-gateway-compat.js', 'src/lib/tauri-api.js', 'src/engines/opencode/pages/workspace.js', 'src/engines/opencode/pages/dashboard.js', 'src/engines/hermes/pages/chat.js', 'package.json', 'package-lock.json', 'openclaw-version-policy.json', 'Dockerfile', '.github/maintenance/Runtime.Dockerfile']
export const OPTIONAL_SOURCE_FILES = ['scripts/hermes-pm-runtime.js', 'scripts/hermes-managed-install.ps1']
export const DEP_FILES = ['scripts/maintenance-pi-process.mjs', 'src/lib/openclaw-gateway-compat.js']
const PROOF_KEYS = ['requestedByParent', 'linux', 'dockerMarker', 'nonRoot', 'noNewPrivileges', 'noCapabilities', 'noDockerSocket']
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const jsonHash = x => sha(JSON.stringify(x))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()
export const PROXY_CONTEXT_LIMITS = Object.freeze({ eventsPerRequest: 16, lineBytes: 4096, totalBytes: 1048576 })

// 只记录代理自身已观察的顺序，不把错误字符串或时间接近当因果。
export function createProxyContextRecorder({ appendLine, sourceSha } = {}) {
  const prefix = '[HERMES_PROXY_CONTEXT] ', origin = process.hrtime.bigint(), runId = crypto.randomUUID()
  const routes = new Map([
    ['/', 'document:root'], ['/ws', 'gateway-ws'],
    ...['hermes_sessions_list', 'hermes_session_detail', 'hermes_profiles_list', 'hermes_agent_run_stream', 'check_hermes', 'hermes_health_check', 'hermes_gateway_action', 'health', 'auth_check', 'read_panel_config', 'get_portable_status'].map(cmd => [`/__api/${cmd}`, `api:${cmd}`]),
  ])
  const kinds = new Set(['request-start', 'request-end', 'request-aborted', 'upstream-created', 'upstream-connect', 'response-headers', 'response-end', 'response-aborted', 'response-error', 'upstream-error', 'upstream-close', 'downstream-finish', 'downstream-close', 'downstream-error', 'handler-error', 'unknown-error', 'local-destroy'])
  const reasons = new Set(['downstream-aborted', 'downstream-response-close-before-end', 'downstream-socket-close', 'downstream-socket-error'])
  const flagKeys = ['reqComplete', 'reqAborted', 'resHeadersSent', 'resEnded', 'resDestroyed', 'upstreamDestroyed', 'headersReceived', 'reusedSocket']
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])
  const state = { requests: 0, events: 0, errors: 0, closedRequests: 0, linesWritten: 0, bytesWritten: 0, bytesAttempted: 0, evidenceIncomplete: false, eventLimitExceeded: 0, lineLimitExceeded: 0, totalLimitExceeded: 0, writeFailures: 0, observerFailures: 0 }
  let eventSeq = 0, integrityAttempted = false
  const pin = typeof sourceSha === 'string' && /^[a-f0-9]{40}$/.test(sourceSha) ? sourceSha : 'unknown'
  if (pin === 'unknown') incomplete('observerFailures')
  const clock = () => (process.hrtime.bigint() - origin).toString()
  // 终态必须双端close齐全；只报告缺口，不为此延长原停止等待或改变资格门禁。
  const summary = () => Object.freeze({ ...state, openRequests: state.requests - state.closedRequests, evidenceIncomplete: state.evidenceIncomplete || state.requests !== state.closedRequests })
  function incomplete(counter) { state.evidenceIncomplete = true; state[counter]++ }
  function append(row, integrity = false) {
    try {
      const line = prefix + JSON.stringify(row) + '\n', bytes = Buffer.byteLength(line)
      if (bytes > PROXY_CONTEXT_LIMITS.lineBytes) { incomplete('lineLimitExceeded'); return false }
      // 预留固定完整性标记空间，超预算绝不静默截断。
      if (state.bytesAttempted + bytes > PROXY_CONTEXT_LIMITS.totalBytes - (integrity ? 0 : 768)) { incomplete('totalLimitExceeded'); return false }
      state.bytesAttempted += bytes
      try { appendLine(line) } catch { incomplete('writeFailures'); return false }
      state.linesWritten++; state.bytesWritten += bytes
      return true
    } catch { incomplete('observerFailures'); return false }
  }
  function integrity() {
    if (!state.evidenceIncomplete || integrityAttempted) return
    integrityAttempted = true
    append({ kind: 'evidence-incomplete', schemaVersion: 1, runId, sourceSha: pin, at: stamp(), eventSeq, monotonicNs: clock(), ...summary() }, true)
  }
  function begin(input = {}) {
    const requestSeq = ++state.requests, startedAt = stamp(), events = []
    let branch = 'unknown', method = 'OTHER', route = 'other', localDestroy = null, firstErrorSeq = null, errorCode = null, firstErrorPhase = null
    let bad = false, uncertainError = false, currentErrorPhase = null, abortedSeq = null, closedSeq = null, upstreamClosed = false, downstreamClosed = false, finalized = false
    try {
      const suppliedBranch = input.branch, suppliedMethod = input.method
      if (['http', 'upgrade'].includes(suppliedBranch)) branch = suppliedBranch
      else { bad = true; incomplete('observerFailures') }
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(suppliedMethod)) method = suppliedMethod
      else { bad = true; incomplete('observerFailures') }
      route = routes.get(input.pathname) || 'other'
    } catch { bad = true; incomplete('observerFailures') }
    function classification() {
      if (bad || uncertainError || state.evidenceIncomplete) return 'upstream-or-unknown'
      if (firstErrorSeq === null) return 'no-error'
      return branch === 'http' && firstErrorPhase === 'upstream-error' && errorCode === 'ECONNRESET' && localDestroy?.causeSeq && localDestroy.causeSeq < localDestroy.eventSeq && localDestroy.eventSeq < firstErrorSeq ? 'downstream-cancel-proven' : 'upstream-or-unknown'
    }
    function emit(phase) {
      const row = { kind: 'request-context', schemaVersion: 1, runId, sourceSha: pin, requestSeq, branch, method, route, startedAt, at: stamp(), eventSeq, monotonicNs: clock(), phase, errorCode, firstErrorSeq, firstErrorPhase, errorPhase: currentErrorPhase, rawErrorExpected: phase === 'error' && branch === 'http' && ['upstream-error', 'handler-error'].includes(currentErrorPhase), localDestroy, classification: classification(), evidenceIncomplete: bad || state.evidenceIncomplete, events }
      if (!append(row)) {
        bad = true
        integrity()
      }
    }
    function event(kind, flags = {}) {
      try {
        const seq = ++eventSeq; state.events++
        if (finalized) return null
        if (!kinds.has(kind)) { bad = true; incomplete('observerFailures'); integrity(); return null }
        if (events.length >= PROXY_CONTEXT_LIMITS.eventsPerRequest) { bad = true; incomplete('eventLimitExceeded'); integrity(); return null }
        const safe = {}
        for (const key of flagKeys) {
          const suppliedFlag = flags[key]
          if (typeof suppliedFlag === 'boolean') safe[key] = suppliedFlag
          else if (suppliedFlag !== undefined) { bad = true; incomplete('observerFailures') }
        }
        events.push({ eventSeq: seq, monotonicNs: clock(), kind, ...safe })
        if (kind === 'request-aborted' && safe.reqAborted === true) abortedSeq = seq
        if (kind === 'downstream-close') {
          downstreamClosed = true
          if (safe.resEnded === false) closedSeq = seq
        }
        if (kind === 'upstream-close') upstreamClosed = true
        if (downstreamClosed && upstreamClosed && !finalized) {
          finalized = true; state.closedRequests++
          // 正常请求只计数；错误或缺材料才补终态关联，并立即释放ring。
          if (firstErrorSeq !== null || bad) emit('closed')
          events.length = 0
        }
        return seq
      } catch { bad = true; incomplete('observerFailures'); integrity(); return null }
    }
    function destroy(reason) {
      try {
        const safeReason = reasons.has(reason) ? reason : 'unknown'
        const causeSeq = safeReason === 'downstream-aborted' ? abortedSeq : safeReason === 'downstream-response-close-before-end' ? closedSeq : null
        const seq = event('local-destroy')
        if (!localDestroy) localDestroy = { reason: safeReason, eventSeq: seq, causeSeq }
      } catch { bad = true; incomplete('observerFailures'); integrity() }
    }
    function error(value, phase = 'upstream-error', flags = {}) {
      try {
        state.errors++
        if (finalized) { bad = true; incomplete('observerFailures'); integrity() }
        currentErrorPhase = ['upstream-error', 'response-error', 'downstream-error', 'handler-error'].includes(phase) ? phase : 'unknown-error'
        const seq = event(currentErrorPhase, flags)
        if (firstErrorSeq === null) { firstErrorSeq = seq; firstErrorPhase = currentErrorPhase }
        const suppliedCode = value?.code
        errorCode = codes.has(suppliedCode) ? suppliedCode : 'OTHER'
        uncertainError ||= errorCode !== 'ECONNRESET' || currentErrorPhase !== 'upstream-error'
        emit('error')
      } catch { bad = true; incomplete('observerFailures'); integrity() }
    }
    event('request-start')
    return Object.freeze({ event, destroy, error })
  }
  return Object.freeze({ begin, summary })
}
function requireProof(proof) { for (const k of PROOF_KEYS) assert.equal(proof?.[k], true, `容器 proof: ${k}`) }
export function sourceInventory(presence) {
  return [...SOURCE_FILES, ...OPTIONAL_SOURCE_FILES.filter(file => {
    assert.equal(presence[file]?.git, presence[file]?.disk, `optional Git/文件存在性不一致: ${file}`)
    assert.equal(typeof presence[file]?.git, 'boolean', `缺少 optional 存在性: ${file}`)
    return presence[file].git
  })]
}

export function validateFreshReport(report, facts) {
  assert.equal(report.engine, 'hermes'); assert.equal(report.schemaVersion, 1)
  assert.equal(report.status, 'passed'); assert.equal(report.exitCode, 0); assert.equal(report.fault, null)
  assert.ok(Date.parse(report.finishedAt) > Date.parse(report.startedAt), 'fresh11 时间')
  assert.equal(report.cases?.length, STAGES.length)
  assert.deepEqual(report.cases.map(x => x.name), STAGES, 'fresh11 必须原11项，不漏项/重名/重排')
  for (const c of report.cases) {
    assert.equal(c.status, 'passed', c.name)
    assert.ok(Date.parse(c.startedAt) <= Date.parse(c.finishedAt), `${c.name} 未实际完成`)
    assert.ok(c.actual && typeof c.actual === 'object', `${c.name} 缺实际结果`)
  }
  const e = report.environment
  requireProof(e.installContainerProof); requireProof(facts.currentProof)
  assert.equal(e.platform, 'linux'); assert.match(facts.sourceSha, /^[a-f0-9]{40}$/)
  assert.equal(e.commit, facts.sourceSha, '候选 SHA 与 fresh11 不一致')
  const sourceKeys = [...SOURCE_FILES, ...OPTIONAL_SOURCE_FILES.filter(file => Object.hasOwn(facts.sourceHashes, file))]
  assert.deepEqual(Object.keys(facts.sourceHashes).sort(), [...sourceKeys].sort(), 'facts 不接受未声明 optional 的任意 extra')
  for (const [keys, actual, expected] of [[sourceKeys, e.candidateSourceHashes, facts.sourceHashes], [DEP_FILES, e.verifierDependencyHashes, facts.dependencyHashes]]) {
    assert.deepEqual(Object.keys(actual || {}).sort(), [...keys].sort(), 'hash 清单必须完整')
    for (const k of keys) { assert.match(actual[k], /^[a-f0-9]{64}$/); assert.equal(actual[k], expected[k], `stale hash: ${k}`) }
  }
  assert.match(e.verifierSha256 || '', /^[a-f0-9]{64}$/); assert.equal(e.verifierSha256, facts.verifierSha256)
  const get = name => report.cases.find(c => c.name === name).actual
  const install = get('install'), target = facts.target
  assert.deepEqual(install.expected, target); requireProof(install.proof)
  assert.equal(install.commit, target.commit); assert.equal(install.installerSha256, target.installerSha256)
  assert.equal(report.versions.hermes, target.version); assert.equal(get('version').version, target.version)
  assert.match(get('version').actual, new RegExp(`Hermes Agent v${target.version.replaceAll('.', '\\.')}(?:\\s|$)`))
  const health = get('runtime-health')
  assert.equal(health.health?.status, 'ok'); assert.equal(health.health.platform, 'hermes-agent'); assert.equal(health.health.version, target.version)
  assert.ok(health.pids?.length && health.pids.every(p => Number.isSafeInteger(p) && p > 0))
  assert.equal(get('stop').closed, true); assert.equal(get('stop').processesExited, true)
  for (const k of ['webPortClosed', 'runtimePortClosed', 'artifactsRetained']) assert.equal(get('cleanup')[k], true)
  return target
}

export function makeChildEnv(base, home, runtimeOutput) {
  const e = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (base[k]) e[k] = base[k]
  const config = path.join(home, '.openclaw'), hermes = path.join(home, '.hermes')
  Object.assign(e, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.data'), XDG_STATE_HOME: path.join(home, '.state'),
    OPENCLAW_CONFIG_DIR: config, OPENCLAW_HOME: config, OPENCLAW_STATE_DIR: config, OPENCLAW_CONFIG_PATH: path.join(config, 'openclaw.json'), HERMES_HOME: hermes,
    TMP: path.join(runtimeOutput, 'tmp'), TEMP: path.join(runtimeOutput, 'tmp'), TMPDIR: path.join(runtimeOutput, 'tmp'),
    NPM_CONFIG_CACHE: path.join(home, '.npm-cache'), NPM_CONFIG_PREFIX: path.join(home, '.npm-global'), NPM_CONFIG_USERCONFIG: path.join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npm-global-config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1', UV_CACHE_DIR: path.join(home, '.uv-cache'), UV_INSTALL_DIR: path.join(hermes, 'bin'), UV_PYTHON_INSTALL_DIR: path.join(home, '.uv-python'), UV_TOOL_DIR: path.join(home, '.uv-tools'), UV_TOOL_BIN_DIR: path.join(home, '.local', 'bin'), PIP_CACHE_DIR: path.join(home, '.pip-cache'),
    DOCKER_CONFIG: path.join(home, '.docker'), NO_PROXY: '127.0.0.1,localhost,::1', CI: '1', NO_COLOR: '1',
  })
  const key = Object.keys(e).find(k => k.toUpperCase() === 'PATH') || 'PATH'
  e[key] = [path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'), path.join(hermes, 'hermes-agent', 'venv', 'bin'), e[key] || ''].join(path.delimiter)
  return e
}

export function providerReceipt(body, authorization, key, seq) {
  assert.equal(authorization, `Bearer ${key}`, 'Provider auth')
  assert.equal(body.model, 'maintenance-model', 'Provider model')
  const user = body.messages?.findLast(x => x.role === 'user')
  const content = typeof user?.content === 'string' ? user.content : (user?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
  const matches = [...content.matchAll(/\bbrowser-acceptance-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g)]
  assert.equal(matches.length, 1, '最新 user 必须且仅含一个精确 nonce')
  return { seq, at: stamp(), path: '/v1/chat/completions', model: body.model, nonce: matches[0][0], nonceOccurrences: 1, stream: body.stream === true, authMatches: true, accepted: true }
}

export function parseProcStat(pid, stat) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, '非法 PID')
  assert.ok(stat.startsWith(`${pid} (`))
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  assert.match(fields[19] || '', /^\d+$/)
  return { pid, ppid: Number(fields[1]), state: fields[0], startTicks: fields[19] }
}
export function parseListeners(tcp, port) {
  const result = []
  for (const line of tcp.split('\n')) {
    const f = line.trim().split(/\s+/), [address, p] = (f[1] || '').split(':')
    if (f[3] !== '0A' || parseInt(p, 16) !== port) continue
    assert.ok(['0100007F', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F'].includes(address), 'Gateway 不得监听非 loopback 地址')
    assert.match(f[9] || '', /^\d+$/); result.push(f[9])
  }
  return result
}
export function checkAvailability(open, lastAction, pending, now = Date.now()) {
  if (pending) {
    assert.ok(['start', 'stop'].includes(pending.action) && now - pending.started < 120000, '启停转换超时/非法')
    return
  }
  assert.equal(lastAction, open ? 'start' : 'stop', '非 managed 启停的 Gateway 意外退出/重启')
}
export function isSnapshotCurrent(startEpoch, currentEpoch, pending, stopping) { return startEpoch === currentEpoch && !pending && !stopping }
function procIdentity(pid) { try { return parseProcStat(pid, fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null } }
function alive(identity) { const current = procIdentity(identity.pid); return current && current.startTicks === identity.startTicks && !['Z', 'X'].includes(current.state) }
function descendant(pid, ancestor) {
  for (let i = 0; i < 40 && pid > 1; i++) { if (pid === ancestor) return true; const p = procIdentity(pid); if (!p || p.ppid === pid) break; pid = p.ppid }
  return false
}
function ownedProcesses(home, webPid) {
  const found = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue
      const e = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      if (!e.includes(`HERMES_HOME=${home}`) || pid === webPid) continue
      const identity = procIdentity(pid)
      if (!identity || ['Z', 'X'].includes(identity.state)) continue
      assert.ok(descendant(pid, webPid), `HOME 有非本次 serve 子进程: ${pid}`)
      found.push({ ...identity, homeMatches: true, descendantOfWeb: true, commandSha256: sha(fs.readFileSync(`/proc/${pid}/cmdline`)) })
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error }
  }
  return found
}
function listenerOwners(port, processes) {
  const inodes = ['tcp', 'tcp6'].flatMap(name => parseListeners(fs.readFileSync(`/proc/net/${name}`, 'utf8'), port))
  const owners = []
  for (const inode of inodes) {
    const matches = processes.filter(p => {
      try { return fs.readdirSync(`/proc/${p.pid}/fd`).some(fd => { try { return fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`) === `socket:[${inode}]` } catch { return false } }) } catch { return false }
    })
    assert.ok(matches.length, `port ${port} 的真实 socket owner 不属于该 HOME/serve`)
    for (const p of matches) if (!owners.some(x => x.pid === p.pid)) owners.push(p)
  }
  return owners.sort((a, b) => a.pid - b.pid)
}
function portOpen(port) { return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); const finish = result => { socket.destroy(); resolve(result) }; socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)) }) }
function listen(server, port, host) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port) }) }) }
async function freePort() { const s = net.createServer(); const p = await listen(s, 0, '127.0.0.1'); await new Promise(resolve => s.close(resolve)); return p }
function currentProof() {
  const s = process.platform === 'linux' ? fs.readFileSync('/proc/self/status', 'utf8') : ''
  return { requestedByParent: process.env.MAINTENANCE_ISOLATED_RUNTIME === '1', linux: process.platform === 'linux', dockerMarker: fs.existsSync('/.dockerenv'), nonRoot: typeof process.getuid === 'function' && process.getuid() !== 0, noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(s), noCapabilities: /^CapEff:\s+0+$/m.test(s), noDockerSocket: !fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/docker.sock') && !process.env.DOCKER_HOST }
}
function noSymlinks(file) { for (let p = path.resolve(file); ; p = path.dirname(p)) { if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), `符号链接路径: ${p}`); if (p === path.dirname(p)) break } }
function git(root, ...args) {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-c', 'credential.helper=', '-C', root, ...args], { encoding: null, timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
  assert.equal(result.status, 0, `git ${args[0]} 失败`); return result.stdout
}
function sourceFacts(root, tooling) {
  const sourceSha = git(root, 'rev-parse', 'HEAD').toString().trim()
  const inventory = sourceInventory(Object.fromEntries(OPTIONAL_SOURCE_FILES.map(file => [file, { git: git(root, 'ls-tree', '--name-only', sourceSha, '--', file).toString().trim() === file, disk: fs.existsSync(path.join(root, file)) }])))
  const sourceHashes = Object.fromEntries(inventory.map(file => {
    assert.ok(fs.lstatSync(path.join(root, file)).isFile(), `候选 source 必须是普通文件: ${file}`)
    const bytes = fs.readFileSync(path.join(root, file)), hash = sha(bytes)
    assert.equal(hash, sha(git(root, 'show', `${sourceSha}:${file}`)), `候选文件不是该 Git blob: ${file}`)
    return [file, hash]
  }))
  const backend = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const constant = name => backend.match(new RegExp(`const ${name} = ['"]([^'"]+)['"]`))?.[1]
  const target = { version: constant('HERMES_STABLE_VERSION'), tag: constant('HERMES_STABLE_TAG'), commit: constant('HERMES_STABLE_COMMIT'), installerSha256: backend.match(/const HERMES_INSTALLER_SHA256\s*=\s*\{[^}]*posix:\s*['"]([a-f0-9]{64})['"]/s)?.[1] }
  assert.match(target.version || '', /^\d+\.\d+\.\d+$/); assert.match(target.commit || '', /^[a-f0-9]{40}$/); assert.match(target.installerSha256 || '', /^[a-f0-9]{64}$/)
  return { sourceSha, sourceHashes, target, dependencyHashes: Object.fromEntries(DEP_FILES.map(file => [file, sha(fs.readFileSync(path.join(tooling, file)))])), verifierSha256: sha(fs.readFileSync(path.join(tooling, 'scripts/maintenance-runtime-smoke.mjs'))), currentProof: currentProof() }
}
function redact(text, secrets = []) {
  let value = String(text)
  for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]')
  return value.replace(/((?:authorization|api[_-]?key|password|token|cookie)["']?\s*[:=]\s*)[^\s,}\n]+/gi, '$1[REDACTED]').replace(/\b(?:sk|ghp|gho)-[\w-]{8,}/g, '[REDACTED]')
}
function parseOptions(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i]; assert.ok(['--root', '--runtime-output', '--output', '--host', '--port'].includes(k) && argv[i + 1] && !options[k], `参数: ${k}`); options[k] = argv[i + 1] }
  for (const k of ['--root', '--runtime-output', '--output']) assert.ok(options[k], `缺少 ${k}`)
  const port = Number(options['--port'] || 1420), host = options['--host'] || '0.0.0.0'
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536); assert.ok(['127.0.0.1', '0.0.0.0'].includes(host))
  return { root: path.resolve(options['--root']), runtimeOutput: path.resolve(options['--runtime-output']), output: path.resolve(options['--output']), host, port }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { console.log('node hermes-qualification-bootstrap.mjs --root /candidate --runtime-output /tmp/runtime --output /evidence/server --host 0.0.0.0 --port 1420'); return }
  const { root, runtimeOutput, output, host, port } = parseOptions(argv)
  const tooling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const home = path.join(runtimeOutput, 'home'), hermesHome = path.join(home, '.hermes'), config = path.join(home, '.openclaw')
  for (const p of [root, runtimeOutput, home, output]) noSymlinks(p)
  assert.ok(!fs.existsSync(output), 'output 必须全新')
  assert.ok(![root, runtimeOutput, home].some(p => p === output || p.startsWith(output + path.sep) || output.startsWith(p + path.sep)), '证据输出必须在候选/HOME/runtime-output 之外')
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  const rawError = error => fs.appendFileSync(path.join(output, 'errors-private.log'), `${stamp()} ${error.stack || error}\n`, { mode: 0o600 })
  const reportFile = path.join(runtimeOutput, 'report.json')
  let facts, reportBytes, report
  try {
    facts = sourceFacts(root, tooling)
    reportBytes = fs.readFileSync(reportFile); report = JSON.parse(reportBytes)
    validateFreshReport(report, facts)
    if (process.env.QUALIFICATION_CANDIDATE_SHA) assert.equal(facts.sourceSha, process.env.QUALIFICATION_CANDIDATE_SHA, 'workflow 候选 SHA')
    if (process.env.QUALIFICATION_EXPECTED_VERSION) assert.equal(facts.target.version, process.env.QUALIFICATION_EXPECTED_VERSION, 'workflow 目标版本')
    assert.equal(report.environment.home, home); assert.equal(report.environment.hermesHome, hermesHome); assert.equal(report.environment.configDir, config)
  } catch (error) {
    rawError(error)
    write('preflight-failure.json', { status: 'failed', at: stamp(), runtimeStarted: false, homeMutated: false, error: redact(error.message) })
    console.log(JSON.stringify({ browserReady: false, runtimeStarted: false, output, error: 'preflight failed; see private artifact' }))
    process.exitCode = 1
    return
  }
  const parentEnvHash = jsonHash(Object.entries(process.env).sort()), env = makeChildEnv(process.env, home, runtimeOutput)
  const envFiles = ['.openclaw/clawpanel.json', '.openclaw/model-channels.json', '.hermes/.env', '.hermes/config.yaml', '.npmrc', '.gitconfig']
  const configHashes = () => Object.fromEntries(envFiles.map(file => [file, fs.existsSync(path.join(home, file)) ? sha(fs.readFileSync(path.join(home, file))) : null]))
  const before = configHashes(), key = `qualification-local-${crypto.randomUUID()}`, receipts = [], actions = [], observed = new Map()
  const proxyContext = createProxyContextRecorder({ appendLine: line => fs.appendFileSync(path.join(output, 'errors-private.log'), line, { mode: 0o600 }), sourceSha: facts.sourceSha })
  let provider, front, web, ready, stopping = false, failed = false, lastAction = 'initializing', healthTimer, pendingAction
  let actionEpoch = 0
  const proxySockets = new Set()
  let gatewayPort, webPort, providerPort, configuredHash, sourceHash = jsonHash(facts.sourceHashes)
  const remember = list => { for (const p of list) observed.set(`${p.pid}:${p.startTicks}`, p) }
  const appendLog = (name, chunk) => fs.appendFileSync(path.join(output, name), redact(chunk, [key]), { mode: 0o600 })
  async function api(cmd, body = {}) {
    const response = await fetch(`http://127.0.0.1:${webPort}/__api/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
    const value = await response.json()
    actions.push({ at: stamp(), cmd, action: body.action || null, status: response.status, ok: response.ok && !value?.error }); write('api-actions.json', actions)
    assert.ok(response.ok && !value?.error, `实际 API 失败: ${cmd} HTTP ${response.status}`)
    if (cmd === 'hermes_gateway_action') lastAction = body.action
    return value
  }
  async function snapshot() {
    const epoch = actionEpoch
    if (pendingAction) checkAvailability(false, lastAction, pendingAction)
    if (!isSnapshotCurrent(epoch, actionEpoch, pendingAction, stopping)) return { at: stamp(), transition: pendingAction?.action || 'shutdown' }
    assert.equal(failed, false, '已有失败，保持红灯，不以之后恢复抹除')
    assert.ok(web && !web.signalCode && web.exitCode === null, '实际 serve 已退出')
    const processes = ownedProcesses(hermesHome, web.pid); remember(processes)
    const owners = listenerOwners(gatewayPort, processes), open = await portOpen(gatewayPort)
    // 只放弃跨过已观察合法启停的读取快照，不把半个转换当成真实失败或成功。
    if (!isSnapshotCurrent(epoch, actionEpoch, pendingAction, stopping)) return { at: stamp(), transition: pendingAction?.action || 'settled-during-read' }
    assert.equal(open, owners.length > 0, 'TCP 与 socket owner 不一致')
    checkAvailability(open, lastAction, pendingAction)
    for (const f of OPTIONAL_SOURCE_FILES) assert.equal(fs.existsSync(path.join(root, f)), Object.hasOwn(facts.sourceHashes, f), '运行中 optional inventory 漂移')
    const currentHashes = Object.fromEntries(Object.keys(facts.sourceHashes).map(f => [f, sha(fs.readFileSync(path.join(root, f)))]))
    assert.equal(jsonHash(currentHashes), sourceHash, '运行中 source 漂移')
    assert.equal(sha(fs.readFileSync(reportFile)), sha(reportBytes), '原 fresh11 被改变')
    assert.equal(jsonHash(Object.entries(process.env).sort()), parentEnvHash, '父进程环境被改变')
    const environment = jsonHash({ childEnv: env, configs: configHashes() })
    assert.equal(environment, configuredHash, '配置环境漂移')
    return { at: stamp(), gatewayRunning: open, gatewayPids: owners.map(p => p.pid), gatewayIdentity: owners.map(({ pid, startTicks }) => ({ pid, startTicks })), gatewayPort, portOpen: open, ownershipVerified: true, pidsExited: [...observed.values()].every(p => !alive(p)), lastAction, processes, version: facts.target.version, sourceSha: facts.sourceSha, home, fingerprints: { source: sourceHash, environment, freshEvidence: sha(reportBytes) }, providerSequence: receipts.length, managedActions: actions.filter(x => x.cmd === 'hermes_gateway_action') }
  }
  async function closeServer(server) { if (!server?.listening) return; server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
  async function shutdown(signal) {
    if (stopping) return
    stopping = true; clearInterval(healthTimer)
    const errors = [], stop = { signal, at: stamp(), status: 'failed', productionStop: false, pidsExited: false, portsClosed: false, observed: [...observed.values()], limitations: ['仅本次 CI 受管停止证明；不归因或消除本机 SI_USER pid0 红灯'] }
    // 真正停止由产品 API 完成；不按进程名 kill、不降级为伪成功。
    if (web && web.exitCode === null && !web.signalCode) {
      for (const cmd of ['hermes_gateway_action', 'hermes_dashboard_stop']) {
        try { const value = await api(cmd, cmd === 'hermes_gateway_action' ? { action: 'stop' } : {}); stop[cmd] = value } catch (error) { rawError(error); errors.push(`production ${cmd} failed`) }
      }
      stop.productionStop = errors.length === 0
    }
    for (let i = 0; i < 100; i++) {
      if ([...observed.values()].every(p => !alive(p)) && (!gatewayPort || !await portOpen(gatewayPort)) && !await portOpen(ready?.ports.dashboard || 9119)) break
      await delay(100)
    }
    stop.pidsExited = [...observed.values()].every(p => !alive(p))
    stop.gatewayPortClosed = !gatewayPort || !await portOpen(gatewayPort)
    stop.dashboardPortClosed = !await portOpen(ready?.ports.dashboard || 9119)
    for (const name of ['gateway-run.log', 'dashboard-run.log']) if (fs.existsSync(path.join(hermesHome, name))) appendLog(name, fs.readFileSync(path.join(hermesHome, name)))
    if (web?.pid && web.exitCode === null && !web.signalCode) {
      web.kill('SIGTERM')
      await Promise.race([new Promise(resolve => web.once('exit', resolve)), delay(10000)])
    }
    stop.webExited = !web || web.exitCode !== null || !!web.signalCode
    for (const socket of proxySockets) socket.destroy()
    await closeServer(front); await closeServer(provider)
    stop.portsClosed = stop.gatewayPortClosed && stop.dashboardPortClosed && (!webPort || !await portOpen(webPort)) && (!providerPort || !await portOpen(providerPort)) && !await portOpen(port)
    stop.errors = errors; stop.finishedAt = stamp()
    stop.proxyContext = proxyContext.summary()
    stop.status = !failed && stop.productionStop && stop.pidsExited && stop.webExited && stop.portsClosed ? 'passed' : 'failed'
    write('provider-requests.json', receipts); write('stop.json', stop)
    console.log(JSON.stringify({ stopped: stop.status === 'passed', output, productionStop: stop.productionStop, pidsExited: stop.pidsExited, portsClosed: stop.portsClosed }))
    process.exit(stop.status === 'passed' ? 0 : 1)
  }
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => { rawError(error); process.exit(1) }) })
  process.once('SIGINT', () => { shutdown('SIGINT').catch(error => { rawError(error); process.exit(1) }) })
  try {
    write('provenance.json', { schemaVersion: 1, mode: 'warm-after-original-fresh11', originalSources: ORIGINAL_SOURCES, facts, originalReport: { path: reportFile, sha256: sha(reportBytes) }, originalEnvironment: { parentHash: parentEnvHash, configs: before }, childEnvSha256: jsonHash(env), tooling: { bootstrapSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), browserSha256: sha(fs.readFileSync(path.join(tooling, 'scripts/hermes-qualification-browser.py'))), metadataPolicySha256: sha(fs.readFileSync(path.join(tooling, 'scripts/hermes-qualification-provider.mjs'))) }, limitations: ['不安装、不拉取 vendor；不宣称修复本机异常 signal；Linux Web 不等于 Tauri 或 releaseReady'] })
    // 原 fresh11 清理应已完成。先检查 HOME 无现存 Gateway/外来监听。
    gatewayPort = await freePort(); webPort = await freePort()
    fs.writeFileSync(path.join(config, 'clawpanel.json'), JSON.stringify({ ignoreRisk: true, openclawDir: config, engineMode: 'hermes', enabledEngines: ['hermes'], engineSetupChoice: 'explicit' }), { mode: 0o600 })
    provider = http.createServer(async (req, res) => {
      let seq
      try {
        let raw = '', bytes = 0
        for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 * 1024, 'Provider 请求超额'); raw += chunk }
        seq = receipts.length + 1
        const body = raw ? JSON.parse(raw) : {}
        const metadata = classifyHermesMetadataRequest(req.method, req.url, raw, ['maintenance-model'])
        if (metadata) {
          const receipt = { seq, at: stamp(), kind: 'metadata', method: req.method, path: req.url, body, bodySha256: sha(raw), responseStatus: metadata.status, provider: metadata.provider, accepted: true, authMatches: req.headers.authorization === `Bearer ${key}` }
          receipts.push(receipt); write('provider-requests.json', receipts)
          res.writeHead(metadata.status, { 'content-type': 'application/json' })
          return res.end(JSON.stringify(metadata.status === 200 ? { data: [{ id: 'maintenance-model', object: 'model', owned_by: 'local' }] } : { error: 'unsupported-readonly-metadata' }))
        }
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
        const receipt = { ...providerReceipt(body, req.headers.authorization, key, seq), kind: 'chat', method: req.method, responseStatus: 200 }
        fs.appendFileSync(path.join(output, 'provider-private.jsonl'), JSON.stringify({ at: stamp(), body }) + '\n', { mode: 0o600 })
        assert.ok(!receipts.some(r => r.nonce === receipt.nonce), 'Provider nonce 重复请求')
        receipts.push(receipt); write('provider-requests.json', receipts)
        const content = `浏览器完整回复：${receipt.nonce}；模型：maintenance-model。`
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const delta of [{ role: 'assistant', content: '' }, { content: content.slice(0, 12) }, { content: content.slice(12) }, {}]) res.write('data: ' + JSON.stringify({ id: 'qualification-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n')
          res.end('data: [DONE]\n\n')
        } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'qualification-fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })) }
      } catch (error) {
        rawError(error); failed = true; receipts.push({ seq: seq || receipts.length + 1, at: stamp(), kind: 'unknown', method: req.method, path: req.url, accepted: false, authMatches: false }); write('provider-requests.json', receipts)
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"qualification-provider-rejected"}')
      }
    })
    providerPort = await listen(provider, 0, '127.0.0.1')
    web = spawn(process.execPath, ['scripts/serve.js', '--host', '127.0.0.1', '--port', String(webPort)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    web.stdout.on('data', chunk => appendLog('serve-stdout.log', chunk)); web.stderr.on('data', chunk => appendLog('serve-stderr.log', chunk))
    web.on('error', error => { rawError(error); failed = true })
    web.on('exit', (code, signal) => { write('serve-exit.json', { code, signal, at: stamp(), managedShutdown: stopping }); if (!stopping) { failed = true; shutdown('unexpected-serve-exit').catch(error => { rawError(error); process.exit(1) }) } })
    let webHealthy = false
    for (let i = 0; i < 90; i++) { try { webHealthy = (await fetch(`http://127.0.0.1:${webPort}/__api/health`, { signal: AbortSignal.timeout(1000) })).ok } catch {} if (webHealthy) break; assert.equal(web.exitCode, null); await delay(1000) }
    assert.ok(webHealthy, '实际 serve 未就绪')
    const initial = await api('check_hermes')
    assert.equal(initial.installed, true); assert.equal(initial.version, facts.target.version); assert.equal(initial.hermesHome, hermesHome); assert.equal(initial.gatewayRunning, false, 'warm HOME 已有运行实例，不接管')
    const revision = spawnSync('git', ['-c', `safe.directory=${path.join(hermesHome, 'hermes-agent')}`, '-C', path.join(hermesHome, 'hermes-agent'), 'rev-parse', 'HEAD'], { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(revision.status, 0); assert.equal(revision.stdout.trim(), facts.target.commit, '真实安装 checkout revision')
    const dashboard = await api('hermes_dashboard_probe'); assert.equal(dashboard.running, false, '已有 dashboard，不接管')
    const channel = { id: 'qualification-isolated', name: 'Qualification isolated provider', apiType: 'openai-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: key, models: [{ id: 'maintenance-model', name: 'maintenance-model', contextWindow: 131072, maxTokens: 8192, input: ['text'] }], defaultModel: 'maintenance-model' }
    await api('write_model_channels', { config: { version: 2, channels: [channel], syncState: {} } })
    await api('hermes_sync_provider', { provider: 'custom', apiKey: key, baseUrl: channel.baseUrl, model: 'maintenance-model', setDefault: true })
    await api('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' }); await api('hermes_env_set', { key: 'API_SERVER_PORT', value: String(gatewayPort) })
    await api('hermes_set_gateway_url', { url: `http://127.0.0.1:${gatewayPort}` })
    await api('hermes_gateway_action', { action: 'start' })
    const health = await api('hermes_health_check'); assert.equal(health.status, 'ok'); assert.equal(health.platform, 'hermes-agent'); assert.equal(health.version, facts.target.version)
    configuredHash = jsonHash({ childEnv: env, configs: configHashes() })
    const snap = await snapshot(); assert.ok(snap.gatewayPids.length)
    ready = { schemaVersion: 1, status: 'ready', browserReady: true, mode: 'warm-after-original-fresh11', home, sourceSha: facts.sourceSha, version: facts.target.version, target: facts.target, webPid: web.pid, bootstrapPid: process.pid, gatewayPids: snap.gatewayPids, ports: { web: port, serve: webPort, gateway: gatewayPort, provider: providerPort, dashboard: dashboard.port }, webUrl: `http://127.0.0.1:${port}`, initial: snap, originalSources: ORIGINAL_SOURCES, nonPrivilegedProof: facts.currentProof, sourceHashes: facts.sourceHashes, verifierDependencyHashes: facts.dependencyHashes, freshReportSha256: sha(reportBytes), limitations: ['warm UI after fresh11; no signal attribution; no native Tauri; not releaseReady'] }
    write('ready.json', ready); write('configured-environment.json', { sha256: configuredHash, configs: configHashes(), originalConfigs: before, parentEnvHash })
    front = http.createServer(async (req, res) => {
      let context
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname.startsWith('/__qualification/')) {
          assert.equal(req.method, 'GET'); assert.equal(url.search, '')
          const value = url.pathname === '/__qualification/ready' ? ready : url.pathname === '/__qualification/snapshot' ? await snapshot() : url.pathname === '/__qualification/receipts' ? { receipts } : null
          assert.ok(value, '未知 qualification 路径'); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(value))
        }
        // 透明转发真实 UI/HTTP/SSE；只观察启停成功回执，不替换产品响应。
        context = typeof proxyContext === 'undefined' ? null : proxyContext.begin({ branch: 'http', method: req.method, pathname: url.pathname })
        req.once('end', () => context?.event('request-end', { reqComplete: req.complete }))
        res.once('finish', () => context?.event('downstream-finish', { resEnded: res.writableEnded }))
        const observe = req.method === 'POST' && url.pathname === '/__api/hermes_gateway_action'
        let requestBody = '', responseBody = ''
        if (observe) {
          req.on('data', chunk => { if (requestBody.length < 4096) requestBody += chunk })
          req.on('end', () => { try { const body = JSON.parse(requestBody); if (['start', 'stop'].includes(body.action)) { assert.equal(pendingAction, undefined, '不并发启动/停止'); pendingAction = { action: body.action, started: Date.now() }; actionEpoch++ } } catch (error) { context?.error(error, 'handler-error'); rawError(error); failed = true } })
        }
        const upstream = http.request({ host: '127.0.0.1', port: webPort, path: req.url, method: req.method, agent: false, headers: { ...req.headers, host: `127.0.0.1:${webPort}` } }, response => {
          context?.event('response-headers', { headersReceived: true })
          response.once('end', () => context?.event('response-end'))
          response.once('aborted', () => context?.event('response-aborted'))
          if (context) response.on(errorMonitor, error => context.error(error, 'response-error'))
          if (observe) {
            response.on('data', chunk => { if (responseBody.length < 65536) responseBody += chunk })
            response.on('end', () => {
              try { const body = JSON.parse(requestBody), value = JSON.parse(responseBody), ok = response.statusCode >= 200 && response.statusCode < 300 && !value?.error; actions.push({ at: stamp(), cmd: 'hermes_gateway_action', action: body.action, status: response.statusCode, ok }); if (ok && ['start', 'stop'].includes(body.action)) lastAction = body.action; if (['start', 'stop'].includes(body.action)) { pendingAction = undefined; actionEpoch++ } write('api-actions.json', actions) } catch (error) { context?.error(error, 'handler-error'); rawError(error); failed = true }
            })
          }
          res.writeHead(response.statusCode, response.headers); response.pipe(res)
        })
        context?.event('upstream-created')
        upstream.once('close', () => context?.event('upstream-close', { upstreamDestroyed: upstream.destroyed }))
        upstream.on('error', error => { context?.error(error, 'upstream-error', { resHeadersSent: res.headersSent, resEnded: res.writableEnded, reusedSocket: upstream.reusedSocket }); rawError(error); if (!res.headersSent) res.writeHead(502); res.end() })
        req.on('aborted', () => { context?.event('request-aborted', { reqAborted: req.aborted }); context?.destroy('downstream-aborted'); upstream.destroy() }); res.on('close', () => { context?.event('downstream-close', { resEnded: res.writableEnded }); if (!res.writableEnded) { context?.destroy('downstream-response-close-before-end'); upstream.destroy() } }); req.pipe(upstream)
      } catch (error) { if (!context && typeof proxyContext !== 'undefined') context = proxyContext.begin({ branch: 'http', method: req.method }); context?.error(error, 'handler-error'); rawError(error); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"qualification-assertion-failed"}') }
    })
    front.on('upgrade', (req, socket, head) => {
      const context = typeof proxyContext === 'undefined' ? null : proxyContext.begin({ branch: 'upgrade', method: req.method, pathname: req.url })
      const upstream = net.connect(webPort, '127.0.0.1', () => { upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket) })
      context?.event('upstream-created')
      proxySockets.add(socket); proxySockets.add(upstream)
      socket.once('close', () => { proxySockets.delete(socket); context?.event('downstream-close') }); upstream.once('close', () => { proxySockets.delete(upstream); context?.event('upstream-close') })
      upstream.on('error', error => { context?.error(error); socket.destroy() }); socket.on('error', error => { context?.error(error, 'downstream-error'); context?.destroy('downstream-socket-error'); upstream.destroy() }); socket.on('close', () => { context?.destroy('downstream-socket-close'); upstream.destroy() })
    })
    await listen(front, port, host)
    // 只检查意外退出，不自动重启，也不吞掉长期 UI 中的红灯。
    healthTimer = setInterval(() => { if (stopping) return; snapshot().then(s => write('latest-snapshot.json', s)).catch(error => { failed = true; rawError(error); write('monitor-failure.json', { at: stamp(), error: 'unexpected-runtime-or-evidence-drift' }) }) }, 5000)
    console.log(JSON.stringify({ browserReady: true, sourceSha: facts.sourceSha, version: facts.target.version, webUrl: ready.webUrl, webPid: web.pid, gatewayPids: snap.gatewayPids, mode: ready.mode, output }))
  } catch (error) { failed = true; rawError(error); await shutdown('startup-failure') }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ browserReady: false, error: redact(error.message) })); process.exitCode = 1 })
