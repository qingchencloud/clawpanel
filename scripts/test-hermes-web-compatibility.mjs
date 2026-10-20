#!/usr/bin/env node
// 新应用/既有旧内核的独立 Windows Web 资格；不运行安装生命周期，不证明 native full。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { actualRunnerProof, validateRunnerProof, hostSnapshot, assertHostUnchanged, isolationEnv, assertSameSource, qualificationStatus, validatePrivateCompletion, loadQualificationChromium } from './test-hermes-windows-qualification.mjs'
import { gitSourceManifest, assertSeedIdentity } from './test-hermes-compat-build.mjs'
import { assertNativeComplete, assertNativeCompatibilitySeed, assertNativeCompatibilityPins, readNativeCompatibilityBinding, assertNativeHealth, assertNativeListeners, assertNativeStopped, runNativeCleanup, createNativeProvider } from './test-hermes-tauri-qualification.mjs'

const OLD = { version: '0.21.5', commit: 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }
const STATUS = 'passed-web-old-runtime-compatibility', SCOPE = 'new-app-old-runtime-web'
const PLAYWRIGHT_VERSION = '1.60.0'
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const read = file => JSON.parse(fs.readFileSync(physical(file), 'utf8').replace(/^\uFEFF/, ''))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = p => `${p.pid}:${p.creationDate}`
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
function physical(file) {
  const resolved = path.resolve(file)
  for (let p = resolved;; p = path.dirname(p)) { if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), '拒绝链接祖先'); if (p === path.dirname(p)) break }
  return resolved
}
export const webCompatibilityPlan = () => ({ scope: SCOPE, localExecution: false, installsKernel: false, copiesVenv: false, nativeQualification: false, actualBrowser: 'seed HOME playwright 1.60.0 / Chromium headless-shell', runtime: OLD, installerCalls: 'blocked before request handler' })
export async function createWebCompatibilityProvider({ report, save = () => {} }) {
  return createNativeProvider({ report, save, runtimePin: OLD.commit, nonceFamily: 'native-web-compat' })
}
export function webCompatibilityArgs(argv) {
  const values = new Set(['--root', '--sha', '--seed-sha', '--web-output', '--build-output', '--output']), o = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; assert.ok(!Object.hasOwn(o, k), '重复参数')
    if (k === '--execute' || k === '--plan') o[k] = true
    else { assert.ok(values.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--'), '未知/缺值参数'); o[k] = argv[++i] }
  }
  for (const k of ['--sha', '--seed-sha']) if (o[k]) assert.match(o[k], /^[a-f0-9]{40}$/, 'SHA 必须完整精确')
  if (o['--sha'] && o['--seed-sha']) assert.notEqual(o['--sha'], o['--seed-sha'])
  assert.ok(!(o['--execute'] && o['--plan']), '模式互斥'); return o
}

export function installerGuardSource(log) {
  // 仅验收进程 pre-import；不改源码/vendor，直接端口或浏览器请求均在 API 处理前阻断。
  return `import http from 'node:http';import fs from 'node:fs';const original=http.Server.prototype.emit;http.Server.prototype.emit=function(event,...args){if(event==='request'){const [q,r]=args;let cmd;try{const p=decodeURIComponent(new URL(q.url,'http://127.0.0.1').pathname).split('/');if(p[1]==='__api'&&p.slice(3).every(x=>x===''))cmd=p[2]}catch{}if(['install_hermes','update_hermes','uninstall_hermes'].includes(cmd)){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cmd,method:q.method,at:new Date().toISOString(),blockedBeforeHandler:true})+String.fromCharCode(10));q.resume();r.writeHead(403,{'content-type':'application/json'});r.end(JSON.stringify({error:'installer forbidden during compatibility qualification'}));return true}}return Reflect.apply(original,this,[event,...args])};`
}

export function assertWebCompatibilityComplete(r) {
  assert.equal(r.status, STATUS); assert.equal(r.scope, SCOPE); assert.match(r.candidateSha, /^[a-f0-9]{40}$/); assert.match(r.seedSha, /^[a-f0-9]{40}$/); assert.notEqual(r.candidateSha, r.seedSha)
  assert.equal(r.runtimeVersion, OLD.version); assert.equal(r.actualChromium, true); assert.ok(r.browserVersion); assert.equal(r.playwrightVersion, PLAYWRIGHT_VERSION)
  assert.deepEqual(r.blockedInstallerCommands, []); assert.deepEqual(r.pageErrors, []); assert.ok(!r.error && !r.providerError && !r.cleanupError)
  assert.deepEqual(r.runtimeChecks.map(x => x.phase), ['before-ui', 'after-model-one', 'after-model-two', 'after-cleanup'])
  for (const c of r.runtimeChecks) { assert.equal(c.installed, true); assert.equal(c.version, OLD.version); assert.equal(c.commit, OLD.commit) }
  assert.equal(r.prompts.length, 3); assert.deepEqual(r.prompts.map(p => p.model), ['native-one', 'native-two', 'native-two'])
  assert.equal(new Set(r.prompts.map(p => p.nonce)).size, 3)
  for (const p of r.prompts) {
    assert.match(p.nonce, /^native-acceptance-[a-f0-9-]{36}$/); assert.ok(p.clickedSend && p.complete && p.refreshed && p.sessionId && typeof p.reply === 'string' && /[^\x00-\x7f]/.test(p.reply))
    assert.equal(r.provider.filter(c => !c.title && c.authenticated && c.nonce === p.nonce && c.model === p.model).length, 1, '聊天缺失/重放')
    assert.ok(r.provider.filter(c => c.title && c.nonce === p.nonce).length <= 1, '标题重放')
  }
  assert.ok(r.provider.every(c => c.authenticated && r.prompts.some(p => p.nonce === c.nonce && p.model === c.model)), '未归因 Provider 请求')
  assert.ok(r.offline?.reconnected); assert.equal(r.offline.before, 2); assert.equal(r.offline.after, r.offline.before)
  for (const name of ['historyPreserved', 'memoryPreserved', 'hostUnchanged', 'sourceUnchanged', 'binaryUnchanged', 'distUnchanged', 'ownedProcessesExited']) assert.equal(r[name], true, name)
  assertNativeStopped(r.cleanup); assert.ok(Array.isArray(r.ownedPorts) && r.ownedPorts.length >= 3); assert.ok(r.cleanup.ports.every(p => r.ownedPorts.includes(p)), '最终端口 canary 漏掉 runtime'); assert.deepEqual(r.finalOpenPorts, [])
  for (const name of ['sourceManifestSha256', 'applicationSha256', 'seedWebReportSha256', 'seedNativeReportSha256', 'buildReportSha256', 'browserExecutableSha256', 'playwrightEntrySha256', 'playwrightPackageSha256', 'coreEntrySha256', 'corePackageSha256', 'coreBundleSha256', 'browserManifestSha256']) assert.match(r[name] || '', /^[a-f0-9]{64}$/, name)
  const artifact = a => { assert.ok(a && a.file && a.bytes > 0); assert.match(a.sha256, /^[a-f0-9]{64}$/) }
  artifact(r.artifacts?.trace); assert.ok(r.artifacts?.screenshots?.length >= 1); r.artifacts.screenshots.forEach(artifact)
}

function treeHashes(root) {
  const files = {}; physical(root); assert.ok(fs.statSync(root).isDirectory())
  const visit = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const f = physical(path.join(dir, item.name)); assert.ok(inside(root, f)); if (item.isDirectory()) visit(f); else { assert.ok(item.isFile()); files[path.relative(root, f)] = hash(f) } } }
  visit(root); assert.ok(Object.keys(files).length); return files
}
export function assertWebFileCanaries(files) {
  assert.ok(Object.keys(files).length)
  for (const [file, expected] of Object.entries(files)) { physical(file); assert.match(expected, /^[a-f0-9]{64}$/); assert.equal(hash(file), expected, '证据/工具二进制字节漂移: ' + file) }
}
export function resolveWebCompatibilityBrowser({ home, env }) {
  // 仅复用种子私有包；子进程先带固定cache再导入官方registry，不触发安装或查找全局cache。
  assert.ok(path.isAbsolute(home)); physical(home)
  const cache = physical(path.join(home, '.browsers')), modules = physical(path.join(home, 'browser-tools/node_modules'))
  assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === 'PLAYWRIGHT_BROWSERS_PATH'), ['PLAYWRIGHT_BROWSERS_PATH'])
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, cache, '只接受原私有HOME cache'); assert.ok(fs.statSync(cache).isDirectory())
  const paths = {
    playwrightEntrySha256: path.join(home, 'browser-tools/node_modules/playwright/index.mjs'),
    playwrightPackageSha256: path.join(modules, 'playwright/package.json'),
    coreEntrySha256: path.join(modules, 'playwright-core/index.mjs'),
    corePackageSha256: path.join(modules, 'playwright-core/package.json'),
    coreBundleSha256: path.join(modules, 'playwright-core/lib/coreBundle.js'),
    browserManifestSha256: path.join(modules, 'playwright-core/browsers.json'),
  }
  for (const file of Object.values(paths)) { physical(file); assert.ok(fs.statSync(file).isFile()) }
  for (const file of [paths.playwrightPackageSha256, paths.corePackageSha256]) assert.equal(read(file).version, PLAYWRIGHT_VERSION, 'seed browser package/core pin不符')
  assert.equal(read(paths.browserManifestSha256).browsers.filter(b => b.name === 'chromium-headless-shell').length, 1)
  const reportHashes = Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, hash(file)]))
  const code = `import coreBundle from ${JSON.stringify(pathToFileURL(paths.coreBundleSha256).href)};const e=coreBundle.registry.registry.findExecutable('chromium-headless-shell');if(e?.name!=='chromium-headless-shell')throw Error('missing headless shell');console.log(e.executablePath())`
  const resolved = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
  assert.equal(resolved.status, 0, resolved.stderr); const executable = resolved.stdout.trim(); assert.ok(path.isAbsolute(executable), 'browser路径必须绝对')
  const browserExe = physical(executable); assert.ok(browserExe !== cache && inside(cache, browserExe), 'headless shell越出私有cache'); assert.ok(fs.statSync(browserExe).isFile())
  paths.browserExecutableSha256 = browserExe; reportHashes.browserExecutableSha256 = hash(browserExe)
  const files = Object.fromEntries(Object.entries(paths).map(([name, file]) => [file, reportHashes[name]])); assertWebFileCanaries(files)
  return { browserExe, playwrightEntry: paths.playwrightEntrySha256, playwrightVersion: PLAYWRIGHT_VERSION, reportHashes, files }
}
export async function closeCompatibilityBrowser(browser, snapshot) {
  if (browser) { try { snapshot() } finally { await browser.close() } }
}
async function until(fn, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await wait(300) } throw Error('有界等待超时') }
async function reachable(port) { return new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)); s.setTimeout(750, () => { s.destroy(); resolve(false) }) }) }
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)) }) }) }

export function windowsWebSnapshotSource({ home, ports, tracked, webPid = 0, ownerPid = process.pid }) {
  assert.ok(typeof home === 'string' && home.length)
  assert.ok(ports.every(p => Number.isInteger(p) && p > 0 && p < 65536) && tracked.every(p => Number.isInteger(p) && p > 0))
  assert.ok(Number.isInteger(webPid) && webPid >= 0 && Number.isInteger(ownerPid) && ownerPid > 0)
  return `$base=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString('base64')}'));$prefix=$base+[char]92
$ports=@(${ports.join(',')});$tracked=@(${tracked.join(',')});$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$private=@($all|Where-Object {$_.ProcessId -ne $PID -and $_.ProcessId -ne ${ownerPid} -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0))})
function Row($p){if(!$p.CreationDate){throw 'missing CIM CreationDate'};@{pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');executablePath=$p.ExecutablePath;commandLine=$(if($private.ProcessId -contains $p.ProcessId){$p.CommandLine}else{$null})}}
$listeners=@(Get-NetTCPConnection -ErrorAction Stop|Where-Object {$_.State -eq 'Listen' -and ($ports -contains [int]$_.LocalPort -or $private.ProcessId -contains [int]$_.OwningProcess -or $_.OwningProcess -eq ${webPid})}|Sort-Object LocalPort,OwningProcess -Unique|ForEach-Object {$c=$_;$p=$all|Where-Object {$_.ProcessId -eq $c.OwningProcess}|Select-Object -First 1;$r=Row $p;$r.port=[int]$c.LocalPort;$r.address=$c.LocalAddress;$r})
@{processes=@($private|ForEach-Object {Row $_});present=@($all|Where-Object {$tracked -contains [int]$_.ProcessId}|ForEach-Object {Row $_});listeners=$listeners}|ConvertTo-Json -Depth 6 -Compress`
}

export async function executeWebCompatibility(o) {
  // 资格先于路径读取/hostSnapshot/任何候选执行，本机没有绕口。
  const proof = actualRunnerProof(); validateRunnerProof(proof)
  for (const k of ['--root', '--sha', '--seed-sha', '--web-output', '--build-output', '--output']) assert.ok(o[k], '缺参数 ' + k)
  const root = physical(o['--root']), webOutput = physical(o['--web-output']), buildOutput = physical(o['--build-output']), output = physical(o['--output']), home = physical(path.join(webOutput, 'h'))
  assert.ok(inside(physical(process.env.GITHUB_WORKSPACE), root))
  for (const p of [webOutput, buildOutput, output]) assert.ok(inside(physical(process.env.RUNNER_TEMP), p))
  assert.ok(!fs.existsSync(output) && !inside(webOutput, output) && !inside(buildOutput, output) && !inside(output, webOutput) && !inside(output, buildOutput)); fs.mkdirSync(output)
  const report = { schemaVersion: 1, status: 'failed', scope: SCOPE, candidateSha: o['--sha'], seedSha: o['--seed-sha'], runtimeVersion: OLD.version, startedAt: new Date().toISOString(), runner: proof, runtimeChecks: [], prompts: [], provider: [], pageErrors: [], blockedInstallerCommands: [], api: [], stopProofs: [], limitations: ['仅新应用/旧内核 Windows Web；不是 native full 或新内核安装资格', '真实 VM 运行前仅隔离契约测试，不外推通过'] }
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2)), save = () => write('report.json', report)
  save()
  let env, before, source, dist, app, appHash, web, provider, browser, context, page, base, prior, oldNative, seedHistory, memoryHash, webIdentity
  let providerPort, webPort, gatewayPort, dashboardPort, webClosed = false
  const ports = new Set(), runtimePorts = new Set(), owned = new Map(), runtime = new Map(), canaries = {}
  const blockedFile = path.join(output, 'blocked-installer.jsonl'), memory = path.join(home, '.hermes/memories/qualification.txt'), runtimeRoot = path.join(home, '.hermes/hermes-agent')
  function gitHead() { const r = spawnSync('git', ['--no-optional-locks', '-C', runtimeRoot, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 }); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), OLD.commit, '旧 runtime 已升级/替换'); return r.stdout.trim() }
  function ps(code) {
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + code, 'utf16le').toString('base64')], { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
  }
  function snapshot() {
    const tracked = [...new Set([...owned.values()].map(p => p.pid).concat(web?.pid || []).filter(Boolean))]
    const data = ps(windowsWebSnapshotSource({ home, ports: [...ports], tracked, webPid: web?.pid || 0 }))
    for (const p of data.processes) {
      assert.ok(Number.isInteger(p.pid) && Number.isFinite(Date.parse(p.creationDate))); owned.set(key(p), p)
      const binary = path.win32.basename(p.executablePath || '')
      const hermesNode = /^node\.exe$/i.test(binary) && (String(p.executablePath) + ' ' + p.commandLine).replaceAll('/', '\\').toLowerCase().includes(path.win32.join(home, '.hermes').toLowerCase() + '\\')
      if (/^(?:pythonw?|hermes|uv)(?:[0-9.]*)?\.exe$/i.test(binary) || hermesNode) runtime.set(key(p), p)
    }
    data.present = [...new Map([...data.present, ...data.processes].map(p => [key(p), p])).values()]
    for (const row of data.listeners) { assert.ok(['127.0.0.1', '::1'].includes(row.address), '监听越出回环'); ports.add(row.port); if (runtime.has(key(row))) runtimePorts.add(row.port) }
    return data
  }
  async function api(cmd, args = {}, timeout = 120000) {
    if (['install_hermes', 'update_hermes', 'uninstall_hermes'].includes(cmd)) { fs.appendFileSync(blockedFile, JSON.stringify({ cmd, blockedBeforeHandler: true, source: 'harness' }) + '\n'); throw Error('验收禁止 installer API') }
    const receipt = { cmd, at: new Date().toISOString() }; report.api.push(receipt); save()
    const r = await fetch(base + '/__api/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) }), value = await r.json()
    receipt.status = r.status; receipt.ok = r.ok && !value?.error; save(); assert.ok(receipt.ok, cmd + ': ' + JSON.stringify(value)); return value
  }
  async function runtimeCheck(phase) {
    const state = await api('check_hermes'), commit = gitHead()
    assert.equal(state.installed, true); assert.equal(state.version, OLD.version); assert.equal(path.resolve(state.hermesHome), path.join(home, '.hermes'))
    report.runtimeChecks.push({ phase, installed: state.installed, version: state.version, commit }); save()
  }
  function captureRuntime(port) {
    const s = snapshot(), listeners = s.listeners.filter(p => p.port === port)
    assertNativeListeners(listeners, { home, ports: [port] }); for (const p of listeners) { runtime.set(key(p), p); owned.set(key(p), p) }; return listeners
  }
  async function stop() {
    const failures = await runNativeCleanup({ gateway: () => api('hermes_gateway_action', { action: 'stop' }), dashboard: () => api('hermes_dashboard_stop') })
    assert.deepEqual(failures, [], '生产 STOP 失败')
    let result
    await until(async () => {
      const s = snapshot(), open = (await Promise.all([...runtimePorts].map(async p => await reachable(p) ? p : null))).filter(Boolean)
      result = { productionStop: true, identities: [...runtime.values()], present: s.present, ports: [...runtimePorts], listeners: s.listeners.filter(p => runtimePorts.has(p.port)), reachablePorts: open, pidsExited: !s.present.some(p => runtime.has(key(p))), portsClosed: !open.length }
      return result.pidsExited && result.portsClosed && !result.listeners.length
    })
    assertNativeStopped(result); report.stopProofs.push(result); save(); return result
  }
  async function history(initial = false) {
    if (initial) {
      const result = await api('hermes_sessions_list', { limit: 1000, profile: 'default' }), list = Array.isArray(result) ? result : result.sessions
      assert.ok(Array.isArray(list) && list.length); seedHistory = []
      const replies = new Set([...prior.browser.prompts.map(p => p.reply), ...oldNative.rounds.flatMap(r => r.prompts.map(p => `原生完整回复：${p.nonce}；模型：${p.model}。`))])
      for (const item of list) {
        const id = item.id || item.session_id, detail = await api('hermes_session_detail', { sessionId: id, profile: 'default' }); assert.equal(detail.id, id); assert.ok(Array.isArray(detail.messages))
        seedHistory.push({ id, sha256: digest({ id: detail.id, messages: detail.messages }) }); const text = JSON.stringify(detail)
        for (const reply of replies) { assert.ok(typeof reply === 'string' && reply.length); if (text.includes(reply)) replies.delete(reply) }
      }
      assert.equal(replies.size, 0, '旧 Web/native 种子回复不完整'); report.seedHistory = seedHistory
    } else {
      assert.ok(seedHistory?.length)
      for (const item of seedHistory) { const d = await api('hermes_session_detail', { sessionId: item.id, profile: 'default' }); assert.equal(digest({ id: d.id, messages: d.messages }), item.sha256, '旧种子消息变化/丢失') }
      for (const p of report.prompts.filter(p => p.complete && p.sessionId)) { const d = await api('hermes_session_detail', { sessionId: p.sessionId, profile: 'default' }), text = JSON.stringify(d); assert.ok(text.includes(p.reply) && text.includes(`Unicode 中文 🦀 café é ${p.nonce}`), '新 Web 回复/Unicode 输入在停止后丢失') }
      report.historyPreserved = true
    }
    assert.equal(hash(memory), memoryHash, '旧 memory canary 变化'); report.memoryPreserved = true; save()
  }
  function artifact(name) { const file = path.join(output, name), bytes = fs.readFileSync(file); assert.ok(bytes.length > 8); if (name.endsWith('.png')) assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); else assert.equal(bytes.subarray(0, 2).toString(), 'PK'); return { file: name, bytes: bytes.length, sha256: hash(file) } }
  try {
    prior = read(path.join(webOutput, 'report.json')); const seedProof = read(path.join(webOutput, 'runner-proof.json')), nativeFile = path.join(path.dirname(webOutput), 'hermes-native-old/report.json')
    oldNative = read(nativeFile); assertSeedIdentity(prior, seedProof, proof, o['--seed-sha']); assert.equal(qualificationStatus(prior), 'passed-web-native-missing')
    assert.equal(oldNative.status, 'passed-native-tauri'); assert.equal(oldNative.candidateSha, o['--seed-sha']); assert.equal(oldNative.expectedVersion, OLD.version); assertNativeComplete(oldNative)
    for (const k of ['sid', 'actualProfile', 'runId', 'attempt', 'workflowSha', 'imageOS', 'imageVersion']) assert.equal(oldNative.runner[k], proof[k], '旧 native 不是同 VM/run: ' + k)
    assert.equal(path.resolve(oldNative.runtimeHome), home); assert.equal(path.resolve(oldNative.webQualification.path), webOutput); assert.equal(oldNative.webQualification.sha256, hash(path.join(webOutput, 'report.json')))
    const seed = { prior, seedSha: o['--seed-sha'], appSha: o['--sha'], home, webOutput, runner: proof, seedProof, release: read(path.join(webOutput, 'release.json')), completion: read(path.join(webOutput, 'privatecompletion.json')) }
    validateRunnerProof(seedProof); assertNativeCompatibilitySeed(seed); validatePrivateCompletion(seed.completion, { home, ...OLD })
    source = gitSourceManifest(root, o['--sha']); const receipt = read(path.join(buildOutput, 'build-receipt.json')); assert.deepEqual(receipt.source, source)
    app = physical(path.join(root, 'src-tauri/target/release/clawpanel.exe')); const binding = readNativeCompatibilityBinding({ root, app, sha: o['--sha'], buildReceipt: path.join(buildOutput, 'build-receipt.json') })
    assert.equal(receipt.seedSha, o['--seed-sha']); assert.equal(receipt.seedCommit, OLD.commit)
    report.seedWebReportSha256 = hash(path.join(webOutput, 'report.json')); report.seedNativeReportSha256 = hash(nativeFile)
    assert.equal(receipt.seedWebReportSha256, report.seedWebReportSha256); assert.equal(receipt.seedNativeReportSha256, report.seedNativeReportSha256)
    report.buildReportSha256 = binding.buildReceiptSha256; report.sourceManifestSha256 = binding.sourceManifestSha256; appHash = hash(app); report.applicationSha256 = appHash
    assertNativeCompatibilityPins({ rust: fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8'), web: fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8') })
    const distRoot = physical(path.join(root, 'dist')); dist = treeHashes(distRoot); assert.ok(fs.statSync(path.join(distRoot, 'index.html')).isFile()); write('dist-sha256.json', dist); write('source-sha256.json', source)
    physical(runtimeRoot); physical(memory); assert.equal(fs.readFileSync(memory, 'utf8'), o['--seed-sha']); memoryHash = hash(memory)
    for (const f of [path.join(webOutput, 'report.json'), nativeFile, path.join(buildOutput, 'build-receipt.json'), path.join(buildOutput, 'source-sha256.json'), app, memory, seed.completion.python, seed.completion.cli]) { physical(f); canaries[f] = hash(f) }
    before = hostSnapshot(proof); write('host-before.json', before)
    env = isolationEnv({ home, temp: path.join(output, 'tmp'), realProfile: proof.actualProfile }); fs.mkdirSync(env.TEMP)
    const panel = read(path.join(home, '.openclaw/clawpanel.json')); assert.equal(panel.ignoreRisk, true); assert.equal(panel.engineMode, 'hermes'); assert.deepEqual(panel.enabledEngines, ['hermes'])
    gitHead(); assert.deepEqual(snapshot().processes, [], '旧 HOME 仍有进程，本验收不抢占/杀掉种子')
    const selectedBrowser = resolveWebCompatibilityBrowser({ home, env }), { playwrightEntry, browserExe } = selectedBrowser
    assert.equal(prior.browserTooling.playwrightVersion, PLAYWRIGHT_VERSION); assert.equal(prior.browserTooling.coreVersion, PLAYWRIGHT_VERSION)
    assert.equal(prior.browserTooling.browserManifestSha256, selectedBrowser.reportHashes.browserManifestSha256, '旧种子browser manifest漂移')
    Object.assign(report, selectedBrowser.reportHashes, { playwrightVersion: selectedBrowser.playwrightVersion }); Object.assign(canaries, selectedBrowser.files)
    write('input-canaries.json', canaries)
    provider = await createWebCompatibilityProvider({ report, save }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); providerPort = provider.address().port; ports.add(providerPort)
    webPort = await freePort(); ports.add(webPort); gatewayPort = await freePort(); ports.add(gatewayPort); runtimePorts.add(gatewayPort)
    assert.equal(ports.size, 3); const guard = path.join(output, 'installer-guard.mjs'); fs.writeFileSync(guard, installerGuardSource(blockedFile))
    web = spawn(process.execPath, ['--import', pathToFileURL(guard).href, path.join(root, 'scripts/serve.js'), '--host', '127.0.0.1', '--port', String(webPort)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    web.once('error', e => { report.serverSpawnError = String(e) }); web.once('close', (code, signal) => { webClosed = true; report.serverExit = { code, signal }; save() })
    web.stdout.on('data', b => fs.appendFileSync(path.join(output, 'serve.stdout.log'), b)); web.stderr.on('data', b => fs.appendFileSync(path.join(output, 'serve.stderr.log'), b))
    base = `http://127.0.0.1:${webPort}`; await until(async () => { assert.ok(!report.serverSpawnError && !webClosed, 'serve 提前退出'); return reachable(webPort) })
    const serverSnapshot = snapshot(); webIdentity = serverSnapshot.present.find(p => p.pid === web.pid); assert.ok(webIdentity, '缺 serve PID/CreationDate'); owned.set(key(webIdentity), webIdentity); report.webIdentity = webIdentity
    const serverListeners = serverSnapshot.listeners.filter(p => p.port === webPort); assert.ok(serverListeners.length && serverListeners.every(p => key(p) === key(webIdentity)), 'Web 监听不属于实际 serve 子进程')
    await runtimeCheck('before-ui'); await history(true)
    await api('hermes_profile_use', { name: 'default' }); await api('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' }); await api('hermes_env_set', { key: 'API_SERVER_PORT', value: String(gatewayPort) }); await api('hermes_set_gateway_url', { url: `http://127.0.0.1:${gatewayPort}` })
    const dash = await api('hermes_dashboard_probe'); dashboardPort = dash.port; assert.ok(Number.isInteger(dashboardPort) && dashboardPort > 0); assert.ok(!ports.has(dashboardPort)); ports.add(dashboardPort); runtimePorts.add(dashboardPort)
    if (await reachable(dashboardPort)) captureRuntime(dashboardPort)
    const chromium = await loadQualificationChromium({ home, cacheDirectory: env.PLAYWRIGHT_BROWSERS_PATH, moduleFile: playwrightEntry }); browser = await chromium.launch({ headless: true, executablePath: browserExe, env }); report.actualChromium = true; report.browserVersion = browser.version()
    context = await browser.newContext({ locale: 'zh-CN' }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); context.on('page', p => p.on('pageerror', e => { report.pageErrors.push(String(e)); save() }))
    page = await context.newPage(); const screenshots = []
    for (const [i, model] of ['native-one', 'native-two'].entries()) {
      await api(i ? 'hermes_sync_provider' : 'configure_hermes', { provider: 'custom', apiKey: 'qualification-native-no-secret', baseUrl: `http://127.0.0.1:${providerPort}/v1`, model, ...(i ? { setDefault: true } : {}) })
      await api('hermes_gateway_action', { action: 'start' })
      await until(async () => { let health; try { health = await api('hermes_health_check', {}, 10000) } catch { return false }; assertNativeHealth(health, OLD.version); return true })
      const listeners = captureRuntime(gatewayPort)
      await page.goto(base + '/#/h/chat'); await page.locator('#hm-chat-input').waitFor(); await page.locator('.hm-chat-gw-status.is-online').waitFor()
      const send = async () => {
        await page.locator('#hm-chat-new-chat').click(); const nonce = 'native-acceptance-' + crypto.randomUUID(), input = `Unicode 中文 🦀 café é ${nonce}`, reply = `原生完整回复：${nonce}；模型：${model}。`, prompt = { nonce, model, reply, clickedSend: false, complete: false, refreshed: false }; report.prompts.push(prompt); save()
        await page.locator('#hm-chat-input').fill(input); await page.locator('#hm-chat-send').click(); prompt.clickedSend = true
        await page.getByText(reply, { exact: false }).first().waitFor({ timeout: 120000 }); await page.locator('#hm-chat-stop').waitFor({ state: 'hidden', timeout: 120000 }); prompt.complete = true
        prompt.sessionId = await page.locator('.hm-chat-session-item.is-active').getAttribute('data-sid'); assert.ok(prompt.sessionId)
        const detail = await api('hermes_session_detail', { sessionId: prompt.sessionId }); assert.ok(JSON.stringify(detail).includes(input) && JSON.stringify(detail).includes(reply), 'Unicode 输入/完整回复未入真实历史')
        await page.reload(); await page.getByText(reply, { exact: false }).first().waitFor({ timeout: 30000 })
        const refreshed = JSON.stringify(await api('hermes_session_detail', { sessionId: prompt.sessionId })); assert.ok(refreshed.includes(input) && refreshed.includes(reply), '刷新后实际历史缺 Unicode 输入/完整回复'); prompt.refreshed = true
        const name = `chat-${report.prompts.length}.png`; await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(artifact(name)); save()
      }
      await send()
      if (i === 1) {
        report.offline = { before: report.provider.filter(p => !p.title).length }; await context.setOffline(true); await page.waitForTimeout(1500); await context.setOffline(false); await page.reload(); await page.getByText(report.prompts.at(-1).reply, { exact: false }).first().waitFor(); await page.waitForTimeout(1200)
        report.offline.after = report.provider.filter(p => !p.title).length; report.offline.reconnected = true; assert.equal(report.offline.after, report.offline.before, '重连重放聊天'); await send()
      }
      assertNativeHealth(await api('hermes_health_check'), OLD.version); assertNativeListeners(captureRuntime(gatewayPort), { home, ports: [gatewayPort], expected: listeners })
      await runtimeCheck(i ? 'after-model-two' : 'after-model-one'); if (!i) await stop()
    }
    report.artifacts = { screenshots }; await history(); report.completedUi = true
  } catch (e) { report.error = e.stack; save() }
  finally {
    const failures = await runNativeCleanup({
      trace: async () => { if (context) { await context.tracing.stop({ path: path.join(output, 'trace.zip') }); report.artifacts ||= { screenshots: [] }; report.artifacts.trace = artifact('trace.zip') } },
      browser: () => closeCompatibilityBrowser(browser, snapshot),
      runtimeStop: async () => { if (base && !webClosed) { try { snapshot() } finally { report.cleanup = await stop() } } },
      history: async () => { if (base && seedHistory) await history() },
      runtimeVersion: async () => { if (base && report.runtimeChecks.length) await runtimeCheck('after-cleanup') },
      web: async () => { if (web && !webClosed) { web.kill('SIGTERM'); await until(() => webClosed) } },
      provider: async () => { if (provider) { provider.closeAllConnections(); await new Promise((resolve, reject) => provider.close(e => e ? reject(e) : resolve())) } },
      pidPorts: async () => {
        if (env && ports.size) { await until(async () => { const s = snapshot(); report.finalOpenPorts = (await Promise.all([...ports].map(async p => await reachable(p) ? p : null))).filter(Boolean); report.finalPresent = s.present.filter(p => owned.has(key(p))); return !report.finalOpenPorts.length && !s.listeners.length && !report.finalPresent.length }); report.ownedProcessesExited = true }
        report.ownedPorts = [...ports]
      },
      source: async () => { if (source) { assert.deepEqual(gitSourceManifest(root, o['--sha']), source); report.sourceUnchanged = true; assertSameSource(root, source.files) }; if (Object.keys(canaries).length) assertWebFileCanaries(canaries); if (appHash) { assert.equal(hash(app), appHash); report.binaryUnchanged = true }; if (dist) { assert.deepEqual(treeHashes(path.join(root, 'dist')), dist); report.distUnchanged = true } },
      installer: async () => { report.blockedInstallerCommands = fs.existsSync(blockedFile) ? fs.readFileSync(blockedFile, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []; assert.deepEqual(report.blockedInstallerCommands, []) },
      host: async () => { if (before) { const after = hostSnapshot(proof); write('host-after.json', after); assertHostUnchanged(before, after); report.hostUnchanged = true } },
    })
    if (failures.length) report.cleanupError = failures
    if (!report.error && !failures.length) { try { report.status = STATUS; assertWebCompatibilityComplete(report) } catch (e) { report.status = 'failed'; report.gateError = e.stack } }
    report.finishedAt = new Date().toISOString(); save()
  }
  console.log(JSON.stringify({ status: report.status, output, scope: report.scope })); return report.status === STATUS ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const o = webCompatibilityArgs(process.argv.slice(2)); if (o['--execute']) process.exitCode = await executeWebCompatibility(o); else console.log(JSON.stringify(webCompatibilityPlan())) }
  catch (e) { console.error(e.stack || String(e)); process.exitCode = 1 }
}
