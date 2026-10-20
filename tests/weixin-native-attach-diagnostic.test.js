// 隔离失败清单先行：真实自有HTTP/Node child，不启动GUI、不安装内核、不伪造native资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { once, EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import * as m from '../scripts/test-weixin-windows-qualification.mjs'

const artifact = (name, value) => {
  if (process.env.CLAWPANEL_ATTACH_EVIDENCE_DIR) {
    const out = path.resolve(process.env.CLAWPANEL_ATTACH_EVIDENCE_DIR)
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  }
}
const fixture = () => {
  const runtimePath = 'C:\\official\\154.0.4258.62\\msedgewebview2.exe'
  const folder = 'C:\\qualification\\h\\.webview2'
  const process = { pid: 2345, creationDate: '2026-10-17T01:00:00.000Z', exe: runtimePath, commandLine: `"${runtimePath}" --user-data-dir="${folder}\\EBWebView" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1` }
  return { runtimePath, metadata: { userDataFolder: folder, files: { 'EBWebView/DevToolsActivePort': { exists: true, size: 60, contentRead: true, validEndpoint: true, port: 49234, sha256: 'a'.repeat(64) } } }, port: 49234, ports: [49234], identities: [process], observation: { processes: [process], listeners: [{ ...process, port: 49234, localAddress: '127.0.0.1' }], present: [] } }
}
async function serverFor(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return 'http://127.0.0.1:' + server.address().port
}

test('attach真实own HTTP：只能提交已证明动态port的标准W3C，不得重新launch', async t => {
  const seen = []
  const base = await serverFor(t, async (req, res) => {
    let raw = ''; for await (const b of req) raw += b
    const body = raw ? JSON.parse(raw) : null; seen.push({ method: req.method, path: req.url, body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/session') res.end(JSON.stringify({ value: { sessionId: 'own-http-not-native', capabilities: { browserName: 'webview2', browserVersion: '154.0.4258.62' } } }))
    else res.end(JSON.stringify({ value: null }))
  })
  const c = new m.W3C(base)
  assert.equal(typeof c.attachVerified, 'function', '缺少严格attach接口；不得退回create/launch')
  await c.attachVerified(fixture(), m.createAttachDeadline(), fixture().observation)
  assert.deepEqual(seen[0], { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: { browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: '127.0.0.1:49234' } } } } })
  for (const forbidden of ['tauri:options', 'binary', 'args', 'webviewOptions']) assert.equal(JSON.stringify(seen[0].body).includes('"' + forbidden + '"'), false)
  assert.deepEqual(c.requestedCapabilities, seen[0].body)
  assert.deepEqual(seen[1].body, { script: 120000, pageLoad: 60000, implicit: 0 })
  await c.close()
  artifact('attach-http', { scope: 'own HTTP protocol only, not native VM', seen })
})

test('attach所有实际端口负控在HTTP前拒绝；不放宽原debugger proof', async t => {
  let count = 0
  const base = await serverFor(t, (req, res) => { count++; res.end('{"value":null}') })
  const cases = [
    ['missing-file', e => { e.metadata.files = {} }],
    ['oversize', e => { e.metadata.files['EBWebView/DevToolsActivePort'].size = 4097 }],
    ['unread', e => { e.metadata.files['EBWebView/DevToolsActivePort'].contentRead = false }],
    ['invalid-file', e => { e.metadata.files['EBWebView/DevToolsActivePort'].validEndpoint = false }],
    ['wrong-port', e => { e.port++ }],
    ['wrong-pid', e => { e.observation.listeners[0].pid++ }],
    ['wrong-birth', e => { e.observation.listeners[0].creationDate = '2026-10-17T01:00:01Z' }],
    ['wrong-runtime', e => { e.observation.listeners[0].exe = 'C:\\other.exe' }],
    ['wrong-udd', e => { e.observation.processes[0].commandLine = '--user-data-dir=C:\\foreign --remote-debugging-port=0 --remote-debugging-address=127.0.0.1' }],
    ['non-loopback', e => { e.observation.listeners[0].localAddress = '0.0.0.0' }],
    ['no-listener', e => { e.observation.listeners = [] }],
    ['no-identity', e => { e.identities = [] }],
    ['no-cleanup-port', e => { e.ports = [] }],
    ['bare-flags', e => { e.observation.processes[0].commandLine = e.observation.processes[0].commandLine.replaceAll('--remote-', 'remote-') }],
  ]
  for (const [name, change] of cases) {
    const e = structuredClone(fixture()); change(e)
    const c = new m.W3C(base); assert.equal(typeof c.attachVerified, 'function')
    await assert.rejects(c.attachVerified(e, m.createAttachDeadline(), e.observation), name)
    assert.equal(count, 0, name + '不得发送attach')
  }
  artifact('attach-rejected-before-http', { scope: 'isolated proof negatives, not native observations', cases: cases.map(c => c[0]), requests: count })
})

test('child-only attach env必须是副本，去掉大小写冲突，不修改父环境', () => {
  assert.equal(typeof m.nativeAttachAppEnv, 'function')
  const input = { Path: 'private-path', WEBVIEW2_USER_DATA_FOLDER: 'C:\\old', webview2_additional_browser_arguments: 'bad', WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER: 'bad', WebView2_Wait_For_Script_Debugger: 'bad' }
  const before = structuredClone(input), out = m.nativeAttachAppEnv(input, 'C:\\qualification\\h\\.webview2')
  assert.deepEqual(input, before); assert.notEqual(out, input)
  assert.equal(out.WEBVIEW2_USER_DATA_FOLDER, 'C:\\qualification\\h\\.webview2')
  assert.equal(out.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1')
  assert.equal(Object.keys(out).filter(k => /^webview2_additional_browser_arguments$/i.test(k)).length, 1)
  assert.ok(!Object.keys(out).some(k => /WEBVIEW2_(?:PIPE_FOR_SCRIPT_DEBUGGER|WAIT_FOR_SCRIPT_DEBUGGER)/i.test(k)))
  assert.deepEqual(m.nativeDriverEnvSubmission(m.nativeDriverChildEnv(out)).actualEnvironmentObserved, false)
  const hostBefore = { ...process.env }, keys = ['WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER', 'WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER']
  const childEnv = m.nativeAttachAppEnv({ PATH: path.dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, out.WEBVIEW2_USER_DATA_FOLDER)
  const actual = spawnSync(process.execPath, ['-e', `const k=${JSON.stringify(keys)};process.stdout.write(JSON.stringify(Object.fromEntries(k.map(k=>[k,process.env[k]??null]))))`], { env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 10000 })
  assert.equal(actual.status, 0, actual.stderr); assert.deepEqual(JSON.parse(actual.stdout), Object.fromEntries(keys.map(k => [k, childEnv[k] ?? null]))); assert.deepEqual({ ...process.env }, hostBefore)
  artifact('own-child-env', { scope: 'actual owned Node child whitelist only; not application/runtime environment', actual: JSON.parse(actual.stdout), parentUnchanged: true })
})

test('own child+挂起HTTP：app阶段消耗同一deadline，attach不得重新获得60秒', async t => {
  assert.equal(typeof m.createAttachDeadline, 'function')
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("own-app-ready\\n");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const reaped = once(child, 'close')
  let observation
  t.after(async () => { if (child.exitCode === null) child.kill(); const [code, signal] = await reaped; artifact('own-child-deadline', { ...observation, reaped: true, code, signal }) })
  const deadline = m.createAttachDeadline(1500)
  await once(child.stdout, 'data')
  let seenAt, seenBody
  const base = await serverFor(t, async req => { let raw = ''; for await (const b of req) raw += b; seenAt = performance.now(); seenBody = JSON.parse(raw) })
  await new Promise(resolve => setTimeout(resolve, 300))
  const remainingBefore = deadline.remaining()
  assert.ok(remainingBefore < 1200 && remainingBefore > 0)
  const started = performance.now(), c = new m.W3C(base)
  await assert.rejects(c.attachVerified(fixture(), deadline, fixture().observation))
  const elapsed = performance.now() - started
  assert.ok(seenAt && elapsed < 1700, '真实HTTP必须由剩余deadline中止')
  assert.throws(() => deadline.remaining(), /deadline|60|预算/)
  assert.equal(c.session, null)
  observation = { scope: 'own Node child + actual pending loopback HTTP; not GUI', pid: child.pid, remainingBefore, elapsed, seenBody }
})

test('deadline过期必须零HTTP，禁止大于60秒/非法预算', async t => {
  assert.equal(typeof m.createAttachDeadline, 'function')
  for (const invalid of [0, -1, 60001, Infinity, NaN, '60000']) assert.throws(() => m.createAttachDeadline(invalid))
  let count = 0
  const base = await serverFor(t, (req, res) => { count++; res.end('{"value":null}') })
  const deadline = m.createAttachDeadline(5); await new Promise(resolve => setTimeout(resolve, 15))
  await assert.rejects(new m.W3C(base).attachVerified(fixture(), deadline, fixture().observation))
  assert.equal(count, 0)
})

test('诊断CLI与正式scope互斥，diagnostic报告始终过不了原complete15门禁', () => {
  assert.equal(m.parseArgs(['--plan', '--diagnostic-attach'])['--diagnostic-attach'], true)
  for (const scope of ['complete', 'ui-origin']) assert.throws(() => m.parseArgs(['--execute', '--diagnostic-attach', '--scope', scope]))
  for (const status of ['diagnostic-ui-ipc-observed', 'pass-native']) assert.throws(() => m.assertNativeComplete({ status, scope: 'diagnostic-attach', executionMode: 'actual-github-hosted-windows-vm-weixin-attach-diagnostic' }))
  assert.equal(m.REQUIRED_CASES.length, 15)
  assert.ok(m.REQUIRED_CASES.includes('wrong-window') && m.REQUIRED_CASES.includes('scanner-failure'))
})

test('诊断实际接线：单60秒、真实CIM与W3C点击/只读Rust IPC，日志和完整cleanup保持', () => {
  const source = fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /createAttachDeadline\(\)/)
  assert.match(source, /client\.attachVerified\(/)
  assert.match(source, /nativeAttachAppEnv\(env,env\.WEBVIEW2_USER_DATA_FOLDER\)/)
  assert.match(source, /spawn\(application,\[\]/)
  assert.match(source, /--verbose/)
  assert.match(source, /diagnostic-ui-ipc-observed/)
  assert.match(source, /client\.click\('\.nav-item\[data-route="\/channels"\]'\)/)
  assert.match(source, /client\.ipc\('get_openclaw_dir'\)/)
  assert.match(source, /diagnostic-binary-after/)
  assert.match(source, /if\(o\['--diagnostic-attach'\]\)assertWebviewDebugger\(report\.webviewDebugger\)/)
  assert.match(source, /deadline\.remaining\(\)/)
  assert.doesNotMatch(source, /--no-sandbox|disable-web-security|ignoreCertificateErrors/)
})

test('B1旧proof有效但最新direct矛盾：missing/birth/owner/UDD等必须零HTTP', async t => {
  let requests = 0
  const base = await serverFor(t, (req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: req.url === '/session' ? { sessionId: 'must-not-attach', capabilities: { browserName: 'webview2' } } : null })) })
  const cases = [
    ['missing-direct', () => undefined],
    ['missing-runtime', s => { s.processes = []; return s }],
    ['changed-birth', s => { for (const row of [...s.processes, ...s.listeners]) row.creationDate = '2026-10-17T01:00:01Z'; return s }],
    ['changed-owner', s => { s.listeners[0].pid++; return s }],
    ['new-owner-consistent', s => { for (const row of [...s.processes, ...s.listeners]) row.pid++; return s }],
    ['changed-exe', s => { s.processes[0].exe = 'C:\\foreign.exe'; return s }],
    ['changed-udd', s => { s.processes[0].commandLine = s.processes[0].commandLine.replace('qualification', 'foreign'); return s }],
    ['missing-port', s => { s.listeners = []; return s }],
    ['nonloopback', s => { s.listeners[0].localAddress = '0.0.0.0'; return s }],
  ]
  const results = []
  for (const [name, change] of cases) {
    const e = fixture(), latest = change(structuredClone(e.observation)), before = requests
    m.assertWebviewDebugger(e)
    let rejected = false
    try { await new m.W3C(base).attachVerified(e, m.createAttachDeadline(), latest) } catch { rejected = true }
    results.push({ name, rejected, requests: requests - before })
  }
  artifact('B1-latest-direct-zero-http', { scope: 'actual own HTTP, controlled CIM rows; not native', results })
  assert.deepEqual(results, cases.map(([name]) => ({ name, rejected: true, requests: 0 })))
})

const ownershipFixture = () => {
  const output = 'C:\\qualification', application = output + '\\target\\release\\clawpanel.exe', driver = output + '\\h\\edge\\msedgedriver.exe'
  const e = fixture(), pending = new Set(), child = new EventEmitter()
  Object.assign(child, { pid: 1234, exitCode: null, signalCode: null })
  const born = Date.parse('2026-10-17T01:00:00.000Z'), process = { pid: child.pid, exe: application, creationDate: new Date(born + 1).toISOString(), commandLine: '"' + application + '"' }
  const config = { output, application, driver, runtimePath: e.runtimePath, userDataFolder: e.metadata.userDataFolder, pending }
  return { child, pending, born, process, config, empty: { processes: [], present: [], listeners: [] } }
}
async function cleanupFixture(ownership, snapshot) {
  const kills = [], receipts = []
  const result = await m.cleanupAttachProcesses({ ownership, ports: new Set([49234]), snapshot, terminate: p => { kills.push(structuredClone(p)) }, receipt: (name, data) => receipts.push({ name, data }), waitUntil: async fn => { assert.equal(await fn(), true, '隔离回执未闭合') } })
  return { result, kills, receipts }
}

test('B2未知出生pending：foreign复用/同exe迟到/close事件未派发均零kill且保留红', async () => {
  assert.equal(typeof m.createAttachOwnership, 'function')
  assert.equal(typeof m.cleanupAttachProcesses, 'function')
  const results = []
  for (const mode of ['foreign-reuse', 'same-exe-late-birth', 'close-undelivered', 'no-owner', 'close-before-owner', 'error-before-owner']) {
    const f = ownershipFixture(), ownership = m.createAttachOwnership(f.config)
    ownership.start(f.child, f.config.application, f.born, f.born + 10)
    if (mode === 'close-before-owner') f.child.emit('close', 0, null)
    if (mode === 'error-before-owner') f.child.emit('error', new Error('own fixture spawn failure'))
    const foreign = { ...f.process, creationDate: new Date(f.born + 1000).toISOString(), exe: mode === 'same-exe-late-birth' ? f.config.application : 'C:\\foreign.exe', commandLine: 'foreign --log=C:\\qualification\\log' }
    const current = mode === 'no-owner' ? f.empty : { processes: [foreign], present: [foreign], listeners: [] }
    const { result, kills } = await cleanupFixture(ownership, () => current)
    assert.equal(kills.length, 0, mode); assert.equal(result.identities.length, 0, mode)
    assert.ok(result.errors.length, mode + '缺proof不能假绿')
    results.push({ mode, kills: kills.length, owned: result.identities.length, errors: result.errors, pending: [...f.pending] })
  }
  artifact('B2-no-birth-no-kill', { scope: 'controlled CIM + recording termination sink only', results })
})

test('B2已知own保持可清理；相同PID换birth/exe拒绝，非自有commandLine碰瓷不升级', async () => {
  assert.equal(typeof m.createAttachOwnership, 'function')
  const results = []
  for (const mode of ['owned', 'changed-birth', 'changed-exe', 'unrelated-output-reference']) {
    const f = ownershipFixture(), ownership = m.createAttachOwnership(f.config)
    ownership.start(f.child, f.config.application, f.born, f.born + 10)
    ownership.observe({ ...f.empty, processes: [f.process] })
    let live = true
    const current = { ...f.process, ...(mode === 'changed-birth' ? { creationDate: new Date(f.born + 1000).toISOString() } : {}), ...(mode === 'changed-exe' ? { exe: 'C:\\foreign.exe' } : {}) }
    const foreign = { pid: 999, creationDate: f.process.creationDate, exe: 'C:\\foreign.exe', commandLine: '--output=C:\\qualification\\h' }
    const kills = []
    const result = await m.cleanupAttachProcesses({ ownership, ports: new Set(), snapshot: () => live ? { processes: mode === 'unrelated-output-reference' ? [current, foreign] : [current], present: [current], listeners: [] } : f.empty, terminate: p => { kills.push(p); live = false }, receipt() {}, waitUntil: async fn => { if (mode === 'changed-birth' || mode === 'changed-exe') { await fn(); throw Error('fixture foreign未清理，禁止追绿') } else assert.equal(await fn(), true) } })
    assert.deepEqual(kills.map(p => p.pid), mode === 'changed-birth' || mode === 'changed-exe' ? [] : [f.process.pid], mode)
    assert.deepEqual(result.identities, [f.process], '不能纳入foreign或换birth')
    assert.equal(result.errors.length === 0, mode === 'owned', mode)
    results.push({ mode, kills, errors: result.errors })
  }
  artifact('B2-known-identity-cleanup', { scope: 'controlled observation/termination, not host process cleanup', results })
})

test('B2真实own Node child close/error收尾pending但不抹缺proof；同步窗口不靠事件保安全', async () => {
  assert.equal(typeof m.createAttachOwnership, 'function')
  const f = ownershipFixture(), ownership = m.createAttachOwnership(f.config)
  ownership.start(f.child, f.config.application, f.born, f.born + 10)
  assert.equal(f.pending.has(f.child.pid), true)
  f.child.emit('close', 0, null); assert.equal(f.pending.has(f.child.pid), false)
  ownership.observe({ ...f.empty, processes: [f.process] })
  const r = await cleanupFixture(ownership, () => f.empty)
  assert.equal(r.kills.length, 0); assert.ok(r.result.errors.length)
  const pending = new Set(), executable = fs.realpathSync.native(process.execPath), output = path.dirname(executable)
  const own = m.createAttachOwnership({ output, application: executable, driver: path.join(output, 'own-unused-driver.exe'), runtimePath: path.join(output, 'own-unused-runtime.exe'), userDataFolder: path.join(output, 'own-unused-udd'), pending })
  const started = Date.now(), child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setTimeout(()=>process.exit(0),100)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const reaped = once(child, 'close'); own.start(child, executable, started, Date.now())
  await once(child.stdout, 'data'); await reaped
  assert.equal(pending.has(child.pid), false)
  const closed = await cleanupFixture(own, () => f.empty)
  assert.equal(closed.kills.length, 0); assert.ok(closed.result.errors.length)
  artifact('B2-own-child-close', { scope: 'actual own Node close/reap, no CIM/native kill', pid: child.pid, pending: [...pending], errors: closed.result.errors })
})

test('B2实际diagnostic finally接线：CIM失败/unknown不得进入原barePID fallback，原正式块逐字不变', async () => {
  const source = fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("  if(o['--diagnostic-attach']){", source.indexOf('\n finally{'))
  const end = source.indexOf('  try{if(report.sessionLaunch)', start)
  assert.ok(start > 0 && end > start)
  const f = ownershipFixture(), ownership = m.createAttachOwnership(f.config)
  ownership.start(f.child, f.config.application, f.born, f.born + 10)
  const foreign = { ...f.process, creationDate: new Date(f.born + 1000).toISOString(), exe: 'C:\\foreign.exe' }, calls = [], report = { cleanup: { errors: [] } }
  const context = { assert, o: { '--diagnostic-attach': true }, output: f.config.output, attachOwnership: ownership, identities: new Map(), ports: new Set(), pending: f.pending, report, cleanupAttachProcesses: m.cleanupAttachProcesses, debugIdentity: p => `${p.pid}:${p.creationDate}`, redact: String, receipt() {}, processSnapshot: () => ({ processes: [], present: [foreign], listeners: [] }), ps() { throw Error('不得查询bare PID') }, spawnSync: (...args) => { calls.push(args); return { status: 0 } }, until: async fn => assert.equal(await fn(), true) }
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', context)
  assert.equal(calls.length, 0); assert.ok(report.cleanup.errors.length); assert.equal(context.identities.size, 0)
  const base = spawnSync('git', ['show', 'HEAD:scripts/test-weixin-windows-qualification.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(base.status, 0)
  const legacy = base.stdout.slice(base.stdout.indexOf('  try{const snap=processSnapshot(output,[...ports]);'), base.stdout.indexOf('  try{if(report.sessionLaunch)', base.stdout.indexOf('  try{const snap=processSnapshot(output,[...ports]);')))
  assert.ok(legacy.length > 1000); assert.ok(source.includes(legacy), '正式cleanup块不得顺带重写')
  const complete = text => text.slice(text.indexOf('export function assertNativeComplete('), text.indexOf('\n}', text.indexOf('export function assertNativeComplete(')) + 2)
  assert.equal(complete(source), complete(base.stdout), '原complete15 validator逐字不变')
  const originalTest = spawnSync('git', ['show', 'HEAD:tests/weixin-windows-qualification.test.js'], { windowsHide: true, timeout: 10000 })
  assert.equal(originalTest.status, 0); assert.deepEqual(fs.readFileSync(new URL('./weixin-windows-qualification.test.js', import.meta.url)), originalTest.stdout)
  artifact('B2-finally-wiring', { scope: 'actual finally diagnostic branch with controlled observation/recording kill sink', kills: calls.length, errors: report.cleanup.errors, formalCleanupUnchanged: true, completeValidatorUnchanged: true, original55TestFileUnchanged: true })
})

test('B2出生窗口+runtime私有UDD闭环；单项失败不阻断其它已证owner清理', async () => {
  const f = ownershipFixture(), ownership = m.createAttachOwnership(f.config), runtime = fixture().observation.processes[0]
  ownership.start(f.child, f.config.application, f.born, f.born + 10)
  for (const patch of [{ creationDate: new Date(f.born - 1).toISOString() }, { creationDate: new Date(f.born + 11).toISOString() }, { exe: 'C:\\foreign.exe' }]) {
    ownership.observe({ ...f.empty, processes: [{ ...f.process, ...patch }, runtime] })
    assert.equal(ownership.known().length, 0, '未证app不得补出生或认领runtime')
  }
  ownership.observe({ ...f.empty, processes: [f.process, { ...runtime, creationDate: new Date(f.born + 2).toISOString() }] })
  const known = ownership.known(); assert.equal(known.length, 2)
  const live = new Map(known.map(p => [p.pid, p])), attempts = []
  const result = await m.cleanupAttachProcesses({ ownership, ports: new Set([49234]), snapshot: () => ({ processes: [...live.values()], present: [...live.values()], listeners: live.has(runtime.pid) ? [{ ...known[1], port: 49234, localAddress: '127.0.0.1' }] : [] }), terminate: p => { attempts.push(p.pid); if (p.pid === f.process.pid) throw Error('own fixture terminate failure'); live.delete(p.pid) }, receipt() {}, waitUntil: async fn => { assert.equal(await fn(), false); throw Error('own fixture app remains') } })
  assert.deepEqual(attempts, known.map(p => p.pid)); assert.ok(result.errors.some(x => x.includes('terminate failure'))); assert.equal(live.has(runtime.pid), false)
  artifact('B2-independent-owned-cleanup', { scope: 'controlled birth window/privateUDD/listener/kill sinks', attempts, errors: result.errors, remaining: [...live.values()] })
})
