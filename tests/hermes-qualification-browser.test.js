// 先固定失败契约；这些隔离测试不代表真实 Hermes 或 210 秒浏览器验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bootstrap = path.join(root, 'scripts/hermes-qualification-bootstrap.mjs')
const browser = path.join(root, 'scripts/hermes-qualification-browser.py')
const python = process.platform === 'win32' ? 'python' : 'python3'
const load = () => import(pathToFileURL(bootstrap).href)
const clone = value => structuredClone(value)

test('实际 Provider 对只读探针单独记账并保留未知请求失败和工具依赖 hash', () => {
  const source = fs.readFileSync(bootstrap, 'utf8')
  assert.match(source, /classifyHermesMetadataRequest\(req.method, req.url, raw, \['maintenance-model'\]\)/)
  assert.match(source, /metadataPolicySha256/)
  assert.match(source, /kind: 'metadata'/)
  assert.match(source, /responseStatus: metadata.status/)
  assert.match(source, /rawError\(error\); failed = true; receipts.push/)
})

test('两个入口存在且导入不启动服务，保留原断言来源 SHA256', async () => {
  assert.ok(fs.existsSync(browser), '浏览器入口缺失')
  const m = await load()
  assert.equal(m.ORIGINAL_SOURCES.bootstrap, '45209e4fbd161555c0bac5c47d5cb62bd8a655280baf634faf2f728fb542ee97')
  assert.equal(m.ORIGINAL_SOURCES.browser, '3a46991eb5bcd6a365624ab78488943097cabfa4a2ee66d9ccc9e6a4ec81eaa2')
  assert.equal(typeof m.main, 'function')
})

function fixture(m) {
  const proof = Object.fromEntries(['requestedByParent', 'linux', 'dockerMarker', 'nonRoot', 'noNewPrivileges', 'noCapabilities', 'noDockerSocket'].map(k => [k, true]))
  const target = { version: '0.21.5', tag: 'v2026.9.24', commit: 'a'.repeat(40), installerSha256: 'b'.repeat(64) }
  const facts = { sourceSha: 'c'.repeat(40), target, currentProof: proof, verifierSha256: 'd'.repeat(64), sourceHashes: Object.fromEntries(m.SOURCE_FILES.map(f => [f, 'e'.repeat(64)])), dependencyHashes: Object.fromEntries(m.DEP_FILES.map(f => [f, 'f'.repeat(64)])) }
  const r = { schemaVersion: 1, engine: 'hermes', status: 'passed', exitCode: 0, fault: null, startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:01:00Z', environment: { platform: 'linux', home: '/tmp/runtime/home', configDir: '/tmp/runtime/home/.openclaw', hermesHome: '/tmp/runtime/home/.hermes', commit: facts.sourceSha, installContainerProof: proof, candidateSourceHashes: facts.sourceHashes, verifierDependencyHashes: facts.dependencyHashes, verifierSha256: facts.verifierSha256 }, versions: { hermes: target.version }, cases: m.STAGES.map(name => ({ name, status: 'passed', startedAt: '2026-10-16T00:00:01Z', finishedAt: '2026-10-16T00:00:02Z', actual: { executed: true } })) }
  r.cases.find(c => c.name === 'install').actual = { expected: target, commit: target.commit, installerSha256: target.installerSha256, proof }
  r.cases.find(c => c.name === 'version').actual = { version: target.version, actual: 'Hermes Agent v0.21.5' }
  r.cases.find(c => c.name === 'runtime-health').actual = { health: { status: 'ok', platform: 'hermes-agent', version: target.version }, pids: [91] }
  r.cases.find(c => c.name === 'stop').actual = { closed: true, processesExited: true, runtimePids: [91] }
  r.cases.find(c => c.name === 'cleanup').actual = { webPortClosed: true, runtimePortClosed: true, artifactsRetained: true }
  return { r, facts }
}

test('fresh11、实际版本/来源/清理和全部非特权 proof 严格校验', async () => {
  const m = await load(), { r, facts } = fixture(m)
  assert.doesNotThrow(() => m.validateFreshReport(r, facts))
  const mutations = [
    x => { x.engine = 'opencode' }, x => { x.exitCode = 1 }, x => { x.fault = 'not-executed' },
    x => { x.cases.pop() }, x => { x.cases.push(clone(x.cases[0])) },
    x => { x.cases[6].status = 'missing' }, x => { delete x.cases[3].finishedAt },
    x => { x.environment.commit = '0'.repeat(40) },
    x => { delete x.environment.candidateSourceHashes['scripts/dev-api.js'] },
    x => { x.environment.verifierDependencyHashes[m.DEP_FILES[0]] = '0'.repeat(64) },
    x => { x.environment.verifierSha256 = '0'.repeat(64) },
    x => { x.versions.hermes = '0.22.2' },
    x => { x.cases.find(c => c.name === 'install').actual.commit = '0'.repeat(40) },
    x => { x.cases.find(c => c.name === 'runtime-health').actual.health.version = 'wrong' },
    x => { x.cases.find(c => c.name === 'runtime-health').actual.pids = [0] },
    x => { x.cases.find(c => c.name === 'stop').actual.processesExited = false },
    x => { x.cases.find(c => c.name === 'cleanup').actual.webPortClosed = false },
  ]
  for (const mutate of mutations) { const x = clone(r); mutate(x); assert.throws(() => m.validateFreshReport(x, facts)) }
  for (const key of Object.keys(facts.currentProof)) {
    for (const bad of [false, 'true', undefined]) {
      const x = clone(r); x.environment.installContainerProof[key] = bad
      assert.throws(() => m.validateFreshReport(x, facts), `旧 proof ${key}`)
      const f = clone(facts); f.currentProof[key] = bad
      assert.throws(() => m.validateFreshReport(r, f), `当前 proof ${key}`)
    }
  }
})

test('PM 存在但 fresh11 漏 hash 必须失败（先保留该错误接受的红灯）', async () => {
  const m = await load(), { r, facts } = fixture(m)
  const f = clone(facts)
  f.sourceHashes['scripts/hermes-pm-runtime.js'] = '1'.repeat(64)
  assert.throws(() => m.validateFreshReport(r, f), 'PM 模块实际存在但报告只有19项')
})

test('固定 PM optional inventory：真实存在必须第20项，缺失/篡改/伪造 extra 均拒绝', async () => {
  const m = await load(), { r, facts } = fixture(m), pm = 'scripts/hermes-pm-runtime.js', ps = 'scripts/hermes-managed-install.ps1'
  const noPs = { [ps]: { git: false, disk: false } }
  assert.equal(m.sourceInventory({ ...noPs, [pm]: { git: false, disk: false } }).length, 19)
  assert.equal(m.sourceInventory({ ...noPs, [pm]: { git: true, disk: true } }).length, 20)
  assert.throws(() => m.sourceInventory({ ...noPs, [pm]: { git: true, disk: false } }), 'Git 有、实际文件缺失')
  assert.throws(() => m.sourceInventory({ ...noPs, [pm]: { git: false, disk: true } }), '未提交模块不得冒充候选 Git blob')
  assert.throws(() => m.sourceInventory({ [pm]: { git: false, disk: false } }), 'PS存在性未知不得默认为不存在')
  assert.equal(m.sourceInventory({ [pm]: { git: false, disk: false }, [ps]: { git: true, disk: true } }).length, 20)
  assert.equal(m.sourceInventory({ [pm]: { git: true, disk: true }, [ps]: { git: true, disk: true } }).length, 21)
  assert.throws(() => m.sourceInventory({ [pm]: { git: true, disk: true }, [ps]: { git: true, disk: false } }))
  const f = clone(facts), report = clone(r)
  f.sourceHashes[pm] = '1'.repeat(64); report.environment.candidateSourceHashes[pm] = f.sourceHashes[pm]
  assert.doesNotThrow(() => m.validateFreshReport(report, f), '合法 PM 候选20项')
  const bothFacts = clone(f), bothReport = clone(report)
  bothFacts.sourceHashes[ps] = '4'.repeat(64); bothReport.environment.candidateSourceHashes[ps] = '4'.repeat(64)
  assert.doesNotThrow(() => m.validateFreshReport(bothReport, bothFacts))
  delete bothReport.environment.candidateSourceHashes[ps]
  assert.throws(() => m.validateFreshReport(bothReport, bothFacts), 'PS实际发运但报告漏指纹')
  const missing = clone(report); delete missing.environment.candidateSourceHashes[pm]
  assert.throws(() => m.validateFreshReport(missing, f), 'PM 存在但报告漏 hash')
  const stale = clone(report); stale.environment.candidateSourceHashes[pm] = '2'.repeat(64)
  assert.throws(() => m.validateFreshReport(stale, f), 'PM hash 篡改')
  assert.throws(() => m.validateFreshReport(report, facts), 'PM 不存在而报告伪造 extra')
  for (const pair of [[clone(r), clone(facts)], [clone(report), clone(f)]]) {
    pair[0].environment.candidateSourceHashes['scripts/forged-runtime.js'] = '3'.repeat(64)
    pair[1].sourceHashes['scripts/forged-runtime.js'] = '3'.repeat(64)
    assert.throws(() => m.validateFreshReport(...pair), '即使双方一致也不接受任意 extra')
  }
  assert.doesNotThrow(() => m.validateFreshReport(r, facts), 'baseline 仍19项')
})

test('环境白名单不继承真实凭据/代理且不修改父环境', async () => {
  const m = await load()
  const base = { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'real-secret', GH_TOKEN: 'secret', SSH_AUTH_SOCK: '/socket', HTTPS_PROXY: 'http://secret', HOME: '/real', NODE_OPTIONS: '--import evil', PYTHONPATH: '/evil' }, before = clone(base)
  const e = m.makeChildEnv(base, '/tmp/runtime/home', '/tmp/runtime')
  assert.deepEqual(base, before)
  for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(e[key], undefined, key)
  assert.equal(e.HOME, '/tmp/runtime/home'); assert.equal(e.HERMES_HOME, path.join('/tmp/runtime/home', '.hermes'))
  assert.equal(e.TMPDIR, path.join('/tmp/runtime', 'tmp')); assert.equal(e.USERPROFILE, e.HOME)
})

test('Provider 精确计最新 user 的一个 nonce，不重计历史，不接受重复/假凭据', async () => {
  const m = await load(), a = 'browser-acceptance-11111111-1111-4111-8111-111111111111', b = 'browser-acceptance-22222222-2222-4222-8222-222222222222'
  const body = { model: 'maintenance-model', stream: true, messages: [{ role: 'user', content: a }, { role: 'assistant', content: a }, { role: 'user', content: b }] }
  const r = m.providerReceipt(body, 'Bearer isolated-key', 'isolated-key', 3)
  assert.equal(r.nonce, b); assert.equal(r.nonceOccurrences, 1); assert.equal(r.seq, 3); assert.equal(r.accepted, true)
  assert.ok(!JSON.stringify(r).includes('isolated-key'))
  for (const content of [`${b} ${b}`, 'missing', `${b}x`]) assert.throws(() => m.providerReceipt({ ...body, messages: [{ role: 'user', content }] }, 'Bearer isolated-key', 'isolated-key', 4))
  assert.throws(() => m.providerReceipt(body, 'Bearer wrong', 'isolated-key', 4))
  assert.throws(() => m.providerReceipt({ ...body, model: 'unknown' }, 'Bearer isolated-key', 'isolated-key', 4))
})

test('PID 身份含 startTicks，监听仅 loopback 且拒绝 pid0/全地址监听', async () => {
  const m = await load()
  const stat = `123 (python tricky) name) S 91 ${Array(17).fill('0').join(' ')} 654321 0`
  assert.equal(m.parseProcStat(123, stat).startTicks, '654321')
  assert.equal(m.parseProcStat(123, stat).ppid, 91)
  assert.throws(() => m.parseProcStat(0, stat))
  const line = '  0: 0100007F:21C2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 98765 1'
  assert.deepEqual(m.parseListeners(line, 8642), ['98765'])
  assert.throws(() => m.parseListeners(line.replace('0100007F', '00000000'), 8642))
})

test('合法 stop/start 在途不误报，意外掉线/静默重启/超时转换必须失败', async () => {
  const m = await load()
  assert.doesNotThrow(() => m.checkAvailability(true, 'start', null, 1000))
  assert.doesNotThrow(() => m.checkAvailability(false, 'stop', null, 1000))
  assert.throws(() => m.checkAvailability(false, 'start', null, 1000))
  assert.throws(() => m.checkAvailability(true, 'stop', null, 1000))
  assert.doesNotThrow(() => m.checkAvailability(false, 'start', { action: 'stop', started: 900 }, 1000))
  assert.doesNotThrow(() => m.checkAvailability(true, 'stop', { action: 'start', started: 900 }, 1000))
  assert.throws(() => m.checkAvailability(false, 'start', { action: 'stop', started: 1 }, 121002))
  assert.throws(() => m.checkAvailability(false, 'start', { action: 'status', started: 900 }, 1000))
  assert.equal(m.isSnapshotCurrent(1, 1, null, false), true)
  assert.equal(m.isSnapshotCurrent(1, 2, null, false), false)
  assert.equal(m.isSnapshotCurrent(1, 1, { action: 'stop' }, false), false)
  assert.equal(m.isSnapshotCurrent(1, 1, null, true), false)
})

test('Python 严格 8steps/42samples/210s/按钮/Provider/PID/env 契约负向矩阵', () => {
  assert.ok(fs.existsSync(browser), '浏览器入口缺失')
  const code = String.raw`
import importlib.util, copy, json
spec=importlib.util.spec_from_file_location('qualification', ${JSON.stringify(browser)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def reject(fn):
 try: fn()
 except (AssertionError,ValueError,SystemExit): return
 raise AssertionError('negative accepted')
assert m.parse_options(['--base-url','http://127.0.0.1:1420','--output','new','--hold','210']).hold==210
for url in ['http://example.com:1420','http://user:pass@127.0.0.1:1420','http://127.0.0.1:1420/?token=secret']:
 reject(lambda:m.validate_base_url(url))
reject(lambda:m.parse_options(['--base-url','http://127.0.0.1:1420','--output','new','--hold','209']))
s={'gatewayRunning':True,'gatewayPids':[123],'gatewayIdentity':[{'pid':123,'startTicks':'42'}],'gatewayPort':8642,'portOpen':True,'ownershipVerified':True,'fingerprints':{'source':'a'*64,'environment':'b'*64,'freshEvidence':'c'*64},'version':'0.21.5','sourceSha':'d'*40,'home':'/tmp/runtime/home'}
off={**copy.deepcopy(s),'gatewayRunning':False,'gatewayPids':[],'gatewayIdentity':[],'portOpen':False,'pidsExited':True,'lastAction':'stop'}
new=copy.deepcopy(s);new['gatewayPids']=[124];new['gatewayIdentity']=[{'pid':124,'startTicks':'43'}]
nonces=['browser-acceptance-11111111-1111-4111-8111-111111111111','browser-acceptance-22222222-2222-4222-8222-222222222222']
r={'ok':True,'errors':[],'steps':m.expected_steps(210),'baseline':s,'hold':{'seconds':210,'elapsedSeconds':210.1,'health':[{'index':i,'offsetSeconds':i*5,'status':200,'health':{'status':'ok','platform':'hermes-agent','version':'0.21.5'},'snapshot':copy.deepcopy(s)} for i in range(42)]},'lifecycle':{'initialOnline':s,'afterStop':off,'restarted':new,'finalStop':off,'historyAfterReload':True,'historyAfterRestart':True,'finalDataRetained':True},'sends':[{'nonce':n,'method':'button.click','reply':'浏览器完整回复：'+n+'；模型：maintenance-model。','fullReplyVisible':True} for n in nonces],'provider':{'afterSequence':0,'receipts':[{'seq':i+1,'nonce':n,'nonceOccurrences':1,'accepted':True,'authMatches':True,'model':'maintenance-model','path':'/v1/chat/completions'} for i,n in enumerate(nonces)]}}
m.validate_report(r)
mixed=copy.deepcopy(r)
meta={'kind':'metadata','method':'POST','path':'/api/show','body':{'name':'maintenance-model'},'responseStatus':404,'provider':'ollama','accepted':True,'authMatches':False}
chat1,chat2=mixed['provider']['receipts'];chat1['seq']=2;chat2['seq']=4
mixed['provider']['receipts']=[dict(meta,seq=1),chat1,dict(meta,seq=3),chat2]
m.validate_report(mixed)
for patch in [{'path':'/unknown'},{'method':'DELETE'},{'body':{'name':'foreign'}},{'responseStatus':200},{'accepted':False},{'provider':'fake'}]:
 bad=copy.deepcopy(mixed);bad['provider']['receipts'][0].update(patch);reject(lambda:m.validate_report(bad))
mutations=[lambda x:x['steps'].pop(),lambda x:x['errors'].append('pageerror'),lambda x:x['hold']['health'].pop(),lambda x:x['hold']['health'].append(copy.deepcopy(x['hold']['health'][0])),lambda x:x['hold'].update(elapsedSeconds=209),lambda x:x['hold']['health'][3].update(status=500),lambda x:x['hold']['health'][4].update(offsetSeconds=0),lambda x:x['hold']['health'][3]['snapshot']['fingerprints'].update(environment='wrong'),lambda x:x['hold']['health'][3]['snapshot'].update(gatewayPids=[0]),lambda x:x['sends'][0].update(method='Enter'),lambda x:x['sends'][0].update(fullReplyVisible=False),lambda x:x['provider']['receipts'].append(copy.deepcopy(x['provider']['receipts'][0])),lambda x:x['provider']['receipts'][0].update(authMatches=False),lambda x:x['lifecycle']['afterStop'].update(portOpen=True),lambda x:x['lifecycle'].update(restarted=copy.deepcopy(s)),lambda x:x['lifecycle'].update(finalDataRetained=False)]
for mutate in mutations:
 x=copy.deepcopy(r);mutate(x);reject(lambda:m.validate_report(x))
print(json.dumps({'contractCases':len(mutations)+5,'liveUI':False}))
`
  const result = spawnSync(python, ['-B', '-c', code], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /"liveUI": false/)
})

test('Python help 在非 UTF8 host 可用，拒绝 -O 禁用断言，不回显 URL 凭据', () => {
  for (const extra of [['--help'], ['--base-url', 'http://user:DO-NOT-ECHO@127.0.0.1:1420', '--output', 'never-created']]) {
    const result = spawnSync(python, ['-B', browser, ...extra], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'ascii' }, timeout: 15000 })
    assert.equal(result.status, extra[0] === '--help' ? 0 : 2, result.stderr)
    assert.ok(!(result.stdout + result.stderr).includes('DO-NOT-ECHO'))
  }
  const optimized = spawnSync(python, ['-B', '-O', browser, '--help'], { encoding: 'utf8', timeout: 15000 })
  assert.notEqual(optimized.status, 0, '优化模式不得删掉验收断言')
})
