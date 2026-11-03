// 只运行自有Node的私有preload夹具；不冒充Windows VM准入，不运行候选/安装器。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnAuditSource } from '../scripts/test-hermes-windows-qualification.mjs'
import { createHermesExecFileObserver } from '../scripts/hermes-exec-observation.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const qualification = path.join(root, 'scripts/test-hermes-windows-qualification.mjs')
const evidence = process.env.HERMES_EXEC_PRELOAD_TEST_EVIDENCE
const sha = value => createHash('sha256').update(value).digest('hex')
const legacyBody = source => source.slice(source.indexOf('cp.spawn=function'), source.indexOf('return child};') + 'return child};'.length)

function fixture(t, label) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-exec-preload-'))
  const children = [], runs = []
  const env = { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir, TMP: dir, TEMP: dir, SYNTHETIC_PRELOAD_ENV: 'SYNTHETIC_ENV_NOT_AUDIT_249f' }
  const capture = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const state = { child, pid: child.pid }, closed = new Promise(done => child.once('close', done)); children.push({ ...state, closed })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('owned Node probe exceeded 26s')) }, 26000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid, code, signal, stdout, stderr }) })
  })
  const run = async ({ mode = 'success', preload = true, diagnostic = false, noCallback = false, buffer = false, brokenSink = false, legacy = false, viaCP = false } = {}) => {
    const index = runs.length, prefix = path.join(dir, 'run-' + index)
    const audit = brokenSink ? path.join(dir, 'absent-' + index, 'audit.jsonl') : prefix + '.audit.jsonl'
    const preloadFile = prefix + '.preload.mjs', spy = prefix + '.spy.mjs', app = prefix + '.app.mjs', target = prefix + '.target.mjs'
    const generated = spawnAuditSource(audit, diagnostic ? { configFile: prefix + '.nonexistent-config.json' } : null)
    fs.writeFileSync(preloadFile, generated)
    // 原生execFile代理只作恒等性断言；不改变程序/argv/options/结果，保留原ChildProcess。
    fs.writeFileSync(spy, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.execFile;cp.execFile=function(...args){const state={supplied:args.slice(),calls:0};const cb=args[3];if(typeof cb==='function')args[3]=function(...values){state.values=values;state.receiver=this;state.calls++;state.callbackReturn=Reflect.apply(cb,this,values);return state.callbackReturn};const child=Reflect.apply(original,this,args);state.child=child;globalThis.__ownedExecSpy=state;return child};syncBuiltinESMExports();`)
    const token = 'qualification-local-no-secret'
    const out = mode === 'auth' ? 'Bearer ' + token : 'probe stdout', err = mode === 'auth' ? 'token=' + token : 'probe stderr'
    const targetSource = mode === 'utf8' ? `for(const [stream,text]of [[process.stdout,'中文🦞逐字节'],[process.stderr,'错误🧪完整']])for(const byte of Buffer.from(text)){stream.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,4))}` : `process.stdout.write(${JSON.stringify(out)});process.stderr.write(${JSON.stringify(err)});${mode === 'timeout' ? 'setInterval(()=>{},1000)' : 'process.exitCode=' + (mode === 'exit7' ? 7 : 0)}`
    fs.writeFileSync(target, targetSource)
    fs.writeFileSync(app, `import assert from 'node:assert/strict';import cp,{execFile,spawn}from'node:child_process';const errorFields=e=>e?Object.fromEntries(['name','code','signal','killed','errno','syscall'].map(k=>[k,e[k]])):null;const argv=[${JSON.stringify(target)}${mode === 'auth' ? ',' + JSON.stringify('--api-key') + ',' + JSON.stringify(token) : ''}];const options=Object.freeze({timeout:15000,windowsHide:true,encoding:${JSON.stringify(buffer ? 'buffer' : 'utf8')},env:process.env});const marker={};let callbackCount=0,callbackResult;const started=performance.now();const child=(${viaCP ? 'cp.execFile' : 'execFile'})(process.execPath,argv,options${noCallback ? '' : `,function(...values){callbackCount++;const s=globalThis.__ownedExecSpy;callbackResult={error:errorFields(values[0]),stdout:String(values[1]),stderr:String(values[2]),argCount:values.length,errorIdentity:values[0]===s.values[0],stdoutIdentity:values[1]===s.values[1],stderrIdentity:values[2]===s.values[2],thisIdentity:this===s.receiver};return marker}`} );const state=globalThis.__ownedExecSpy;let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin?.end();const close=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,killed:child.killed})));const elapsedMs=performance.now()-started;let legacyResult=null;if(${legacy}){const old=spawn(process.execPath,['-e',"process.stdout.write('legacy spawn out');process.stderr.write('legacy spawn err');process.exitCode=7"],{windowsHide:true,stdio:['ignore','pipe','pipe']});legacyResult=await new Promise(resolve=>old.once('close',(code,signal)=>resolve({pid:old.pid,code,signal})));}console.log(JSON.stringify({pid:child.pid,callbackCount,callbackResult,callbackReturn:state.callbackReturn===marker,returnedChildIdentity:child===state.child,programIdentity:state.supplied[0]===process.execPath,argvIdentity:state.supplied[1]===argv,optionsIdentity:state.supplied[2]===options,arity:state.supplied.length,optionsTimeout:options.timeout,namedExportIdentity:execFile===cp.execFile,bufferEncoding:child.stdout.readableEncoding,stdout,stderr,close,elapsedMs,legacyResult}));`)
    const record = { input: { mode, preload, diagnostic, noCallback, buffer, brokenSink, legacy, viaCP }, preloadSha256: sha(generated), legacySpawnSha256: sha(legacyBody(generated)) }; runs.push(record)
    const args = ['--import', pathToFileURL(spy).href, ...(preload ? ['--import', pathToFileURL(preloadFile).href] : []), app]
    const actual = await capture(args); record.outer = actual
    assert.equal(actual.code, 0, actual.stderr)
    record.application = JSON.parse(actual.stdout)
    record.events = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    return record
  }
  t.after(async () => {
    for (const { child, closed } of children) { if(child.exitCode===null&&child.signalCode===null)child.kill(); await closed }
    if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,label+'.json'),JSON.stringify({scope:'private Node preload wiring only; not actual VM qualification',environment:{node:process.version,platform:process.platform,arch:process.arch},runs,ownedRootsClosed:children.map(({child})=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode}))},null,2))}
    const rel=path.relative(base,fs.realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));fs.rmSync(dir,{recursive:true,force:true})
  })
  return { dir, env, runs, run, capture }
}

function assertIdentity(actual, noCallback = false) {
  const a=actual.application
  for(const key of ['returnedChildIdentity','programIdentity','argvIdentity','optionsIdentity','namedExportIdentity'])assert.equal(a[key],true,key)
  assert.equal(a.arity,noCallback?3:4);assert.equal(a.optionsTimeout,15000);assert.equal(a.callbackCount,noCallback?0:1)
  if(!noCallback){for(const key of ['errorIdentity','stdoutIdentity','stderrIdentity','thisIdentity'])assert.equal(a.callbackResult[key],true,key);assert.equal(a.callbackResult.argCount,3);assert.equal(a.callbackReturn,true)}
}
function execEvents(run) {
  const events=run.events.filter(e=>e.event.startsWith('execFile-')&&e.pid===run.application.pid)
  assert.deepEqual(events.map(e=>e.event),['execFile-start','execFile-result','execFile-close'])
  for(const e of events){assert.ok(Number.isSafeInteger(e.pid)&&e.pid>0);assert.match(e.utc,/^\d{4}-\d\d-\d\dT.*Z$/)}
  assert.equal(new Set(events.map(e=>e.callId)).size,1)
  return events
}

test('接线E2E：成功preload保留实际回调和ChildProcess/参数恒等，named export确实观察',async t=>{
  const f=fixture(t,'success'), native=await f.run({preload:false}), actual=await f.run()
  assertIdentity(actual);assert.deepEqual(actual.application.callbackResult,native.application.callbackResult)
  const[,result,close]=execEvents(actual);assert.equal(result.error,null);assert.equal(result.stdout,'probe stdout');assert.equal(result.stderr,'probe stderr');assert.equal(close.code,0);assert.equal(close.signal,null)
})
test('接线E2E：exit7两流和code/signal/killed与原execFile一致，不改判失败',async t=>{
  const f=fixture(t,'exit7'), native=await f.run({mode:'exit7',preload:false}), actual=await f.run({mode:'exit7',viaCP:true})
  assertIdentity(actual);assert.deepEqual(actual.application.callbackResult,native.application.callbackResult)
  const[,result,close]=execEvents(actual);assert.equal(result.error.code,7);assert.equal(result.error.signal,null);assert.equal(result.error.killed,false);assert.equal(result.stdout,'probe stdout');assert.equal(result.stderr,'probe stderr');assert.equal(close.code,7);assert.deepEqual({code:close.code,signal:close.signal,killed:close.killed},actual.application.close)
})
test('接线E2E：preload真实原15s超时，预算/原error/两流/close不变不重试',{timeout:26000},async t=>{
  const f=fixture(t,'timeout-15000'), [native,actual]=await Promise.all([f.run({mode:'timeout',preload:false}),f.run({mode:'timeout'})])
  assertIdentity(actual);assert.deepEqual(actual.application.callbackResult,native.application.callbackResult)
  assert.ok(actual.application.elapsedMs>=14500&&actual.application.elapsedMs<17500)
  const[,result,close]=execEvents(actual);assert.deepEqual(result.error,actual.application.callbackResult.error);assert.equal(result.error.signal,'SIGTERM');assert.equal(result.error.killed,true);assert.equal(result.stdout,'probe stdout');assert.equal(result.stderr,'probe stderr');assert.deepEqual({code:close.code,signal:close.signal,killed:close.killed},actual.application.close)
})
test('接线E2E：缺省callback不注入，Buffer UTF8逐字节完整观察',async t=>{
  const f=fixture(t,'no-callback-utf8'), actual=await f.run({mode:'utf8',noCallback:true,buffer:true})
  assertIdentity(actual,true);assert.equal(actual.application.bufferEncoding,null)
  const[,result]=execEvents(actual);assert.equal(result.source,'close-no-callback');assert.equal(result.stdout,'中文🦞逐字节');assert.equal(result.stderr,'错误🧪完整');assert.equal(result.code,0)
})
test('接线E2E：固定资格凭据脱敏不改真实输出，不展示options/env',async t=>{
  const f=fixture(t,'redaction'),actual=await f.run({mode:'auth'})
  assertIdentity(actual);const events=execEvents(actual),json=JSON.stringify(events)
  assert.equal(actual.application.stdout,'Bearer qualification-local-no-secret');assert.equal(actual.application.stderr,'token=qualification-local-no-secret')
  assert.ok(!json.includes('qualification-local-no-secret'));assert.ok(!json.includes('SYNTHETIC_ENV_NOT_AUDIT_249f'));assert.ok(!json.includes('SYNTHETIC_PRELOAD_ENV'))
  for(const e of events){assert.equal('env'in e,false);assert.equal('options'in e,false)}
})
test('接线E2E：观察文件写失败不替代exit7和两流，实际应用回调仍一次',async t=>{
  const f=fixture(t,'write-failure'),actual=await f.run({mode:'exit7',brokenSink:true})
  assertIdentity(actual);assert.equal(actual.application.callbackResult.error.code,7);assert.equal(actual.application.stdout,'probe stdout');assert.equal(actual.application.stderr,'probe stderr');assert.deepEqual(actual.events,[])
})
test('接线E2E：正常/诊断preload完整保留原spawn观察器及真实start/close',async t=>{
  assert.equal(sha(legacyBody(spawnAuditSource('LOG'))),'10664ad6ec5b782579da70c826bbd0f8a91ba06d7e112059d6441c1d98701ccf')
  assert.equal(sha(legacyBody(spawnAuditSource('LOG',{configFile:'CONFIG'}))),'7603672af384785edbf9bd593a6e560c432720e3385f1ceb129c3dc200f3f82a')
  const f=fixture(t,'spawn-preservation')
  for(const diagnostic of [false,true]){
    const actual=await f.run({legacy:true,diagnostic});assertIdentity(actual);execEvents(actual)
    const events=actual.events.filter(e=>e.pid===actual.application.legacyResult.pid)
    assert.deepEqual(events.map(e=>e.event),['start','close']);assert.equal(events[1].exitCode,7);assert.equal(events[1].stdout,'legacy spawn out');assert.equal(events[1].stderr,'legacy spawn err');assert.equal(events[1].signal,actual.application.legacyResult.signal)
  }
})
test('接线：tooling helper独立hash纳入VM后toolingDependencies，原准入和生成顺序保持',()=>{
  const source=fs.readFileSync(qualification,'utf8'),line=source.split('\n').find(s=>s.includes('r.toolingDependencies = Object.fromEntries'))
  assert.ok(line.includes("'scripts/hermes-exec-observation.mjs'"),'helper缺失toolingDependencies')
  assert.ok(source.indexOf('validateRunnerProof(proof)')<source.indexOf('r.toolingDependencies = Object.fromEntries'))
  assert.ok(source.indexOf('validateRunnerProof(proof)')<source.indexOf('fs.writeFileSync(audit, spawnAuditSource('))
  const generated=spawnAuditSource('LOG');assert.ok(generated.includes(createHermesExecFileObserver.toString()));assert.doesNotMatch(generated,/from ['"][^'"]*hermes-exec-observation/)
})
test('接线E2E：真实本机execute准入拒绝，不生成资格preload/私有HOME或启动候选',async t=>{
  const f=fixture(t,'host-admission-rejection'),output=path.join(f.dir,'rejected')
  const result=await f.capture([qualification,'--execute','--root',path.join(f.dir,'candidate-never-created'),'--sha','a'.repeat(40),'--version','0.22.2','--variant','new','--output',output],{GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'self-hosted'})
  assert.equal(result.code,1);const report=JSON.parse(fs.readFileSync(path.join(output,'report.json')))
  assert.equal(report.status,'failed');assert.equal(report.installerStarted,false);assert.deepEqual(report.commands,[]);assert.match(report.error,/资格门禁/)
  assert.equal(fs.existsSync(path.join(output,'h')),false);assert.equal(fs.existsSync(path.join(output,'h/spawn-audit.mjs')),false);assert.equal(fs.existsSync(path.join(output,'tooling-dependencies.json')),false)
  f.runs.push({scope:'actual negative admission on host, not spoofed VM',result:{code:result.code},report})
})
