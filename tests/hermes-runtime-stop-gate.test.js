// 可信STOP门禁的隔离回归；不是实际Hermes/托管VM资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import * as q from '../scripts/test-hermes-windows-qualification.mjs'

const sourceFile = new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url)
const evidence = process.env.HERMES_STOP_GATE_TEST_EVIDENCE
const stamp = '2026-10-17T01:00:00.1234567Z'
const identity = (pid = 501, creation = stamp) => ({ ProcessId: pid, CreationDate: creation })
const terminal = (rows = [], pids = [501]) => ({ schemaVersion: 1, observedAt: new Date().toISOString(), query: { kind: 'pids', pids }, processes: rows })
const closedPort = port => ({ host: '127.0.0.1', port, observedAt: new Date().toISOString(), reachable: false, closed: true, errorCode: 'ECONNREFUSED' })
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function stopHarness(options = {}) {
  const source = fs.readFileSync(sourceFile, 'utf8')
  const body = source.slice(source.indexOf('  async function stopRuntime() {'), source.indexOf('  const history = async () =>'))
  assert.ok(body.includes('async function stopRuntime'))
  const writes = [], actions = [], runtimePids = new Set(options.historicalPids || [])
  const deps = { ...q, assert, base: 'http://127.0.0.1:fixture', runtimePort: options.ports?.[0] || 18101, dashboardPort: options.ports?.[1] || 18102, runtimePids,
    capturePids: async () => { const rows = await (options.capture ? options.capture() : options.pre || []); for(const row of rows)if(Number.isSafeInteger(row.ProcessId))runtimePids.add(row.ProcessId); return rows },
    ps: script => options.ps ? options.ps(script) : options.post || terminal(),
    observeHermesRuntimePort: port => options.portProbe ? options.portProbe(port) : Promise.resolve((options.portRows || [closedPort(18101), closedPort(18102)]).find(row => row.port === port)),
    api: async (cmd, args) => { actions.push({ cmd, args }); if(options.api)return options.api(cmd,args);return { ok: true } },
    until: async (fn, budget) => { assert.equal(budget,30000); for(let i=0;i<10;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('fixture bounded STOP wait failed') },
    reachable: async port => options.isOpen ? options.isOpen(port) : false,
    alive: options.alive || (()=>false),
    write: (file, receipt) => { writes.push({ file, receipt: structuredClone(receipt) }) },
  }
  const names=Object.keys(deps),stop=new Function(...names,`let stopped=false;${body};return stopRuntime`)(...names.map(n=>deps[n]))
  return { stop, writes, actions, runtimePids }
}
function save(name, value) { if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify({scope:'trusted STOP gate fixture, not Hermes/VM qualification',node:process.version,platform:process.platform,...value},null,2))} }

for (const historicalPids of [[], [999]]) test('旧空集合反例：fresh preStop空不得productionStop通过，历史PID='+historicalPids.length, async () => {
  const h=stopHarness({pre:[],historicalPids})
  let error;try{await h.stop()}catch(e){error=e}
  save('empty-pre-'+historicalPids.length,{writes:h.writes,actions:h.actions,error:String(error)})
  assert.ok(error,'旧stopRuntime在空集合+关闭端口上错误写入productionStop=true，必须失败')
  assert.ok(!h.writes.some(w=>w.receipt.productionStop===true))
  assert.deepEqual(h.actions.map(a=>a.cmd),['hermes_dashboard_stop','hermes_gateway_action'],'失败也保留独立的两个原停止API')
})

test('STOP证据：非空preStop、准确查询身份缺失及两个配置端口拒绝才能通过', async () => {
  const h=stopHarness({pre:[identity()],post:terminal()});await h.stop()
  const receipt=h.writes.find(w=>w.file==='stop-pids-ports.json')?.receipt
  assert.equal(receipt.productionStop,true);assert.equal(receipt.preStop.length,1);assert.equal(receipt.preStop[0].CreationDate,stamp)
  assert.deepEqual(receipt.postStop.query.pids,[501]);assert.equal(receipt.identities[0].exited,true);assert.equal(receipt.portEvidence.length,2)
  save('bound-success',{writes:h.writes,actions:h.actions})
})

const faults = {
  'missing-creation':{pre:[{ProcessId:501}]},
  'invalid-pid':{pre:[identity(0)]},
  'duplicate-pid':{pre:[identity(),identity()]},
  'same-pid-same-birth':{post:terminal([identity()])},
  'missing-terminal':{post:[]},
  'wrong-query-pids':{post:terminal([],[502])},
  'missing-terminal-rows':{post:{...terminal(),processes:undefined}},
  'missing-terminal-utc':{post:{...terminal(),observedAt:undefined}},
  'terminal-foreign-pid':{post:terminal([identity(502)])},
  'terminal-missing-birth':{post:terminal([{ProcessId:501}])},
  'missing-port':{portRows:[closedPort(18101)]},
  'empty-ports':{portRows:[]},
  'wrong-configured-port':{portRows:[closedPort(18101),closedPort(18103)]},
  'timeout-not-closed':{portRows:[closedPort(18101),{...closedPort(18102),errorCode:'ETIMEDOUT'}]},
  'port-still-open':{portRows:[closedPort(18101),{...closedPort(18102),reachable:true,closed:false,errorCode:null}]},
}
for (const [name,patch] of Object.entries(faults)) test('STOP保红：'+name, async () => {
  const h=stopHarness({pre:[identity()],post:terminal(),...patch})
  let error;try{await h.stop()}catch(e){error=e}
  save('fault-'+name,{writes:h.writes,actions:h.actions,error:String(error)})
  assert.ok(error,name);assert.ok(!h.writes.some(w=>w.receipt.productionStop===true),name)
  assert.equal(h.actions.length,2,'观察失败不跳过原停止动作')
})

test('STOP保红：dashboard停止失败仍执行Gateway停止，不覆盖失败为通过', async () => {
  const h=stopHarness({pre:[identity()],api:cmd=>{if(cmd==='hermes_dashboard_stop')throw Error('original-stop-error')}})
  await assert.rejects(h.stop(),/original-stop-error/)
  assert.deepEqual(h.actions.map(a=>a.cmd),['hermes_dashboard_stop','hermes_gateway_action'])
  assert.ok(!h.writes.some(w=>w.receipt.productionStop===true));save('api-failure',{writes:h.writes,actions:h.actions})
})

test('身份边界：已查询PID换CreationDate记录为复用，不把新进程当旧进程或执行kill', async () => {
  const h=stopHarness({pre:[identity()],post:terminal([identity(501,'2026-10-17T01:05:00.1234567Z')])})
  await h.stop();const receipt=h.writes.at(-1).receipt
  assert.equal(receipt.identities[0].exited,true);assert.equal(receipt.identities[0].reason,'pid-reused');assert.equal(receipt.identities[0].CreationDate,stamp)
  save('pid-reuse-boundary-only',{scopeNote:'synthetic boundary, not actual PID reuse reproduction',writes:h.writes,actions:h.actions})
})

function windowsQuery(source) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toLowerCase()!=='psmodulepath'))
  const script="[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n"+source
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:1048576})
  assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.trim(),'空结果必须有完整JSON envelope')
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''))
}

async function ownedRuntime(t) {
  const base=fs.realpathSync(os.tmpdir()),home=fs.mkdtempSync(path.join(base,'hermes-stop-runtime-')),file=path.join(home,'runtime.mjs')
  fs.writeFileSync(file,`import net from 'node:net';const servers=await Promise.all([0,0].map(()=>new Promise(resolve=>{const server=net.createServer(s=>s.end());server.listen(0,'127.0.0.1',()=>resolve(server))})));console.log(JSON.stringify({pid:process.pid,ports:servers.map(s=>s.address().port)}));process.on('message',async message=>{if(message==='stop'){await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));process.disconnect()}});`)
  const child=spawn(process.execPath,[file],{windowsHide:true,env:{...process.env,NODE_OPTIONS:'',HOME:home,USERPROFILE:home},stdio:['ignore','pipe','pipe','ipc']})
  const closed=new Promise(resolve=>child.once('close',resolve))
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;const rel=path.relative(base,fs.realpathSync(home));assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));fs.rmSync(home,{recursive:true,force:true})})
  const facts=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('owned fixture readiness')),5000);child.once('error',reject);child.stdout.on('data',data=>{output+=data;try{const value=JSON.parse(output);clearTimeout(timer);resolve(value)}catch{}})})
  return {home,child,closed,...facts,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.send('stop');await closed}}
}

test('真实Windows身份+双端口：自有Node正常STOP与空结果JSON，不使用宿主Hermes',{timeout:20000},async t=>{
  assert.equal(typeof q.hermesRuntimeProcessSnapshotSource,'function');assert.equal(typeof q.observeHermesRuntimePort,'function')
  if(process.platform!=='win32'){assert.match(q.hermesRuntimeProcessSnapshotSource({pids:[501]}),/ConvertTo-Json -InputObject/);return}
  const own=await ownedRuntime(t),pre=windowsQuery(q.hermesRuntimeProcessSnapshotSource({home:own.home}))
  assert.ok(pre.processes.some(p=>p.ProcessId===own.pid&&typeof p.CreationDate==='string'));assert.ok(pre.processes.length>0)
  const open=await Promise.all(own.ports.map(q.observeHermesRuntimePort));assert.ok(open.every(p=>p.reachable===true))
  const h=stopHarness({ports:own.ports,capture:()=>pre.processes,ps:windowsQuery,portProbe:q.observeHermesRuntimePort,isOpen:async port=>(await q.observeHermesRuntimePort(port)).reachable,alive,api:async cmd=>{if(cmd==='hermes_gateway_action')await own.stop()}})
  await h.stop();const receipt=h.writes.at(-1).receipt
  assert.equal(receipt.productionStop,true);assert.ok(receipt.preStop.length>0);assert.ok(receipt.postStop.processes.length===0||receipt.identities.every(p=>p.reason==='pid-reused'));assert.ok(receipt.portEvidence.every(p=>p.closed===true&&p.errorCode==='ECONNREFUSED'))
  save('real-windows-runtime',{preStop:pre,openPorts:open,writes:h.writes,actions:h.actions,ownedPid:own.pid,ownedExitCode:own.child.exitCode})
})

test('失败finally独立：空preStop保红仍清理自有Node和配置双端口，不宽杀',{timeout:12000},async t=>{
  assert.equal(typeof q.observeHermesRuntimePort,'function')
  const own=await ownedRuntime(t),h=stopHarness({ports:own.ports,pre:[],isOpen:async port=>(await q.observeHermesRuntimePort(port)).reachable,alive})
  let failure;try{await h.stop()}catch(error){failure=error}finally{await own.stop()}
  const ports=await Promise.all(own.ports.map(q.observeHermesRuntimePort))
  assert.ok(failure);assert.ok(!h.writes.some(w=>w.receipt.productionStop===true));assert.ok(ports.every(p=>p.closed===true));assert.equal(own.child.exitCode,0)
  save('failed-finally-owned-cleanup',{error:String(failure),writes:h.writes,actions:h.actions,ports,ownedPid:own.pid,ownedExitCode:own.child.exitCode})
})
