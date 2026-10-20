// 先红后实现：仅自有Node/同源函数与Git fixture；不是实际VM/app/token证明。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { validateRunnerProof, processObservationSource } from '../scripts/test-weixin-windows-qualification.mjs'

const harness = new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url)
const source = fs.readFileSync(harness, 'utf8'), helperPath = 'scripts/weixin-native-token-observation.mjs'
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const exactSha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v)
const validHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function own(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'weixin-lazy-token-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(root)), parent); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
function artifact(name, value) {
  if (!process.env.CLAWPANEL_TOKEN_LAZY_EVIDENCE) return
  fs.mkdirSync(process.env.CLAWPANEL_TOKEN_LAZY_EVIDENCE, { recursive: true })
  fs.writeFileSync(path.join(process.env.CLAWPANEL_TOKEN_LAZY_EVIDENCE, name + '.json'), JSON.stringify({ scope: 'own Node/source-derived Git component only; not actual VM/app', ...value }, null, 2), { flag: 'wx' })
}
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim()
}
function span(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, a); return source.slice(start, end) }

test('真实metadata/plan入口在token缺失、语法坏、求值抛错时均不resolve/parse/load依赖', t => {
  const root = own(t), rows = []
  const checksum = '2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953'
  for (const [name, token] of [['absent', null], ['invalid-syntax', 'export const = ;'], ['throw-on-load', 'throw Error("TOKEN_LOADED")']]) {
    const dir = path.join(root, name); fs.mkdirSync(dir); const file = path.join(dir, 'harness.mjs')
    fs.copyFileSync(harness, file)
    if (token !== null) fs.writeFileSync(path.join(dir, 'weixin-native-token-observation.mjs'), token)
    const program = `import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){if(s.includes('weixin-native-token-observation'))throw Error('TOKEN_RESOLVED');return n(s,c)}});const m=await import(${JSON.stringify(pathToFileURL(file).href)});const r=await m.readPinnedTauriDriverMetadata(async(u,o)=>{if(o.redirect!=='error')throw Error('redirect');return new Response(JSON.stringify({version:{crate:'tauri-driver',num:'2.1.0',checksum:${JSON.stringify(checksum)},yanked:false}}),{status:200})});console.log(JSON.stringify({version:r.version.num,plan:m.parseArgs(['--plan','--diagnostic-attach','--observe-app-token']),source:m.processObservationSource('C:\\\\own',[],[],1233)}))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, name + ': ' + result.stderr)
    const actual = JSON.parse(result.stdout); assert.equal(actual.version, '2.1.0'); assert.equal(actual.plan['--observe-app-token'], true)
    for (const flags of [['--plan'], ['--plan', '--diagnostic-attach', '--observe-app-token'], ['--execute', '--diagnostic-attach', '--observe-app-token']]) {
      const r = spawnSync(process.execPath, [file, ...flags], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000 })
      assert.equal(r.status === 0, flags[0] === '--plan', r.stderr)
      assert.doesNotMatch(r.stderr, /TOKEN_LOADED|TOKEN_RESOLVED|Unexpected token|ERR_MODULE_NOT_FOUND/)
      if (flags[0] === '--plan') assert.equal(JSON.parse(r.stdout).status, 'not-run')
      else assert.match(r.stderr, /缺少 --root/, '缺参必须在任何runner import/探针前确定拒绝')
    }
    rows.push({ name, metadata: actual.version, dependencyResolved: false, localExecuteGateRetained: true })
  }
  artifact('metadata-no-token', { rows })
})

test('同源snapshot默认逐字走原source且不访问token模块；显式请求需已绑定且只调用一次', () => {
  const code = span('function processSnapshot(', '\nfunction hostExtra('), base = processObservationSource('C:\\own', [49234], [], process.pid), calls = []
  const context = { assert, processObservationSource, ps: (text, budget) => { calls.push({ text, budget }); return '{"own":true}' } }
  Object.defineProperty(context, 'tokenObservationModule', { get() { throw Error('DEFAULT_ACCESSED_TOKEN') }, configurable: true })
  const fn = vm.runInNewContext('(' + code + ')', context)
  assert.equal(JSON.stringify(fn('C:\\own', [49234], [], 12345)), '{"own":true}')
  assert.deepEqual(calls, [{ text: base, budget: 12345 }])
  Object.defineProperty(context, 'tokenObservationModule', { value: undefined, configurable: true })
  assert.throws(() => fn('C:\\own', [], [], 12345, {})); assert.equal(calls.length, 1)
  const request = { own: true }; let once = 0
  Object.defineProperty(context, 'tokenObservationModule', { value: { tokenObservationSource(text, actual) { once++; assert.equal(actual, request); return text + ';OWN' } } })
  fn('C:\\own', [], [], 12345, request); assert.equal(once, 1); assert.ok(calls[1].text.endsWith(';OWN')); assert.equal(calls[1].budget, 12345)
  artifact('snapshot-default-and-bound', { originalSourceSha256: sha(base), defaultTokenReads: 0, explicitCalls: once, budget: 12345 })
})

test('同源loader仅显式execute+observe且runner/全Gitblob绑定成功才真实import自有模块', async t => {
  assert.ok(source.includes('async function loadTokenObservation('), '先红：缺延迟绑定入口')
  const root = own(t); fs.mkdirSync(path.join(root, 'scripts')); const marker = path.join(root, 'loaded.txt')
  const file = path.join(root, helperPath), text = `import fs from'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'own fixture loaded');export const tokenObservationSource=(s)=>s;export const publicTokenObservation=(p)=>p;`
  fs.writeFileSync(file, text); git(root, ['init', '--quiet']); git(root, ['-c', 'core.autocrlf=false', 'add', '.'])
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'own component source only'])
  const commit = git(root, ['rev-parse', 'HEAD'])
  const physicalCode = span('function physical(', '\n\n// Browser')
  const physical = new Function('path', 'fs', 'assert', physicalCode + ';return physical')(path, fs, assert)
  const inside = (r, f) => { const x = path.relative(r, f); return x !== '' && x !== '..' && !x.startsWith('..' + path.sep) && !path.isAbsolute(x) }
  const group = span('function git(root,args,input)', '\nfunction directoryHashes(')
  const { bind, load } = new Function('assert', 'fs', 'path', 'crypto', 'spawnSync', 'physical', 'inside', 'sha', 'hash', 'exactSha', 'validHash', 'validateRunnerProof', 'pathToFileURL', 'tooling', group + ';return {bind:gitSnapshot,load:loadTokenObservation}')(assert, fs, path, crypto, spawnSync, physical, inside, sha, f => sha(fs.readFileSync(f)), exactSha, validHash, validateRunnerProof, pathToFileURL, root)
  const before = bind(root, commit), options = { '--execute': true, '--observe-app-token': true, '--diagnostic-attach': true, '--host': '2026.10.4', '--sha': commit }
  const proof = { platform: 'win32', arch: 'x64', runnerEnvironment: 'github-hosted', runnerOS: 'Windows', event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'qingchencloud/clawpanel', workflowRef: 'qingchencloud/clawpanel/.github/workflows/weixin-qualification.yml@refs/heads/main', workflowSha: commit, toolingSha: commit, runId: '1234', attempt: '1', virtualMachine: true, imageOS: 'win25', imageVersion: 'fixture', userName: 'runneradmin', sid: 'S-1-5-21-1-2-3-1001', actualProfile: 'C:\\Users\\runneradmin', registeredProfile: 'C:\\Users\\runneradmin' }
  const report = { tooling: { sha: commit, before }, source: { sha: commit, before } }, rows = []
  for (const [name, change] of [
    ['no-execute', o => delete o['--execute']], ['no-observe', o => delete o['--observe-app-token']], ['no-diag', o => delete o['--diagnostic-attach']], ['wrong-host', o => { o['--host'] = '2026.9.8' }],
    ['wrong-runner', (o, p) => { p.virtualMachine = false }], ['missing-tooling', (o, p, r) => delete r.tooling], ['missing-source', (o, p, r) => delete r.source], ['wrong-source-sha', (o, p, r) => { r.source.sha = '0'.repeat(40) }],
    ['missing-helper', (o, p, r) => delete r.tooling.before[helperPath]], ['wrong-blob', (o, p, r) => { r.tooling.before[helperPath].gitBlob = '0'.repeat(40) }], ['wrong-sha256', (o, p, r) => { r.tooling.before[helperPath].sha256 = '0'.repeat(64) }],
  ]) {
    const o = structuredClone(options), p = structuredClone(proof), r = structuredClone(report); change(o, p, r)
    await assert.rejects(() => load(o, p, r), name); assert.equal(fs.existsSync(marker), false, name); rows.push({ name, rejectedBeforeImport: true })
  }
  fs.appendFileSync(file, '// drift'); await assert.rejects(() => load(options, proof, report)); assert.throws(() => bind(root, commit)); assert.equal(fs.existsSync(marker), false)
  fs.writeFileSync(file, text); fs.renameSync(file, file + '.saved'); fs.mkdirSync(file)
  await assert.rejects(() => load(options, proof, report)); assert.equal(fs.existsSync(marker), false); fs.rmdirSync(file); fs.renameSync(file + '.saved', file)
  const module = await load(options, proof, report); assert.equal(fs.readFileSync(marker, 'utf8'), 'own fixture loaded')
  assert.equal(typeof module.tokenObservationSource, 'function'); assert.equal(typeof module.publicTokenObservation, 'function')
  artifact('explicit-bound-own-module', { rows, worktreeDriftRejected: true, directoryRejected: true, ownModuleLoaded: true, syntheticRunnerOnly: true, actualGitBlob: before[helperPath] })
})

test('真实execute调用次序：runner/source全Git绑定先于loader，source与public投影用同一module', () => {
  for (const match of source.matchAll(/^import .*?from ['"]([^'"]+)['"]/gm)) assert.ok(match[1].startsWith('node:'))
  const start = source.indexOf('async function execute('), before = source.indexOf('before:gitSnapshot(candidate', start), load = source.indexOf('tokenObservationModule=await loadTokenObservation(', start)
  const required = source.indexOf("for(const key of ['--root','--sha','--host','--output'])", start)
  assert.ok(required > start && required < source.indexOf('validateInjectionSyntax()', start) && required < source.indexOf('const shared=await import(', start), '必需参数在任何执行探针之前')
  assert.ok(source.indexOf('validateRunnerProof(proof)', start) < before && before > start && load > before)
  assert.match(source.slice(before, load), /if\(o\['--observe-app-token'\]\)/)
  assert.match(source, /tokenObservationModule\.publicTokenObservation\(observed\.tokenObservation,tokenRequest\)/)
  assert.equal((source.match(/await import\(pathToFileURL\(file\)\.href\)/g) || []).length, 1)
})
