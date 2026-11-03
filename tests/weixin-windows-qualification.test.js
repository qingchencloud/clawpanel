// 先列资格误绿情形；这里只跑隔离契约，不安装 runtime、不启动 GUI/查询宿主任务。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import vm from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { parseArgs, runnerProofFailures, validateRunnerProof, HOSTS, REQUIRED_CASES, assertNativeComplete, assertOriginDenial, inspectTarMember, W3C, redact, processObservationSource, assertInstallObservation, assertPreparedTicket, expectedArtifact } from '../scripts/test-weixin-windows-qualification.mjs'

const proof = () => ({ platform:'win32',arch:'x64',runnerEnvironment:'github-hosted',runnerOS:'Windows',event:'workflow_dispatch',ref:'refs/heads/main',repository:'qingchencloud/clawpanel',workflowRef:'qingchencloud/clawpanel/.github/workflows/weixin-qualification.yml@refs/heads/main',workflowSha:'a'.repeat(40),toolingSha:'a'.repeat(40),runId:'1234',attempt:'1',virtualMachine:true,imageOS:'win25',imageVersion:'20261017.1',userName:'runneradmin',sid:'S-1-5-21-123-234-345-1001',actualProfile:'C:\\Users\\runneradmin',registeredProfile:'C:\\Users\\runneradmin' })

// R5 first-red：整包解压、大成员、lifecycle 唯一转换；不安装 runtime 或伪造 native 成功。
function contractTar(rows){const blocks=[];for(const [name,body=Buffer.from('x'),type='0']of rows){const header=Buffer.alloc(512);header.write(name);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=type.charCodeAt();header.write('ustar\0',257);header.write('00',263);header.fill(32,148,156);header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);blocks.push(header,body,Buffer.alloc((-body.length)%512+((body.length%512)?512:0)))}return Buffer.concat([...blocks,Buffer.alloc(1024)])}
const byteHash=b=>crypto.createHash('sha256').update(b).digest('hex')
test('R6 session真实HTTP first-red：profile必须经tauri:options.webviewOptions，非被覆盖的顶层ms:edgeOptions',async(t)=>{
 const folder='C:\\qualification\\h\\.webview2',seen=[];
 const expected={capabilities:{alwaysMatch:{'tauri:options':{application:'C:\\candidate\\clawpanel.exe',webviewOptions:{userDataFolder:folder,additionalBrowserArguments:['remote-debugging-port=0','remote-debugging-address=127.0.0.1']}}}}};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):null;seen.push({method:req.method,url:req.url,body});res.setHeader('content-type','application/json');if(req.url==='/session'){if(req.method!=='POST'||JSON.stringify(body)!==JSON.stringify(expected)){res.writeHead(500);res.end(JSON.stringify({value:{error:'session not created',message:"DevToolsActivePort file doesn't exist"}}));return}res.end(JSON.stringify({value:{sessionId:'isolated-http-not-native',capabilities:{browserName:'webview2'}}}))}else res.end(JSON.stringify({value:null}))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const c=new W3C('http://127.0.0.1:'+server.address().port);await c.create('C:\\candidate\\clawpanel.exe',folder);assert.deepEqual(seen[0].body,expected);assert.equal(seen[0].method,'POST');assert.deepEqual(seen[0].body.capabilities.alwaysMatch['tauri:options'].webviewOptions.additionalBrowserArguments,['remote-debugging-port=0','remote-debugging-address=127.0.0.1']);assert.equal(Object.hasOwn(seen[0].body.capabilities.alwaysMatch,'ms:edgeOptions'),false);assert.deepEqual(c.requestedCapabilities,seen[0].body);assert.deepEqual(seen[1].body,{script:120000,pageLoad:60000,implicit:0});await c.close();const count=seen.length;for(const bad of [undefined,'','relative','http://host/profile','C:\\qualification\\h\\..\\outside']){const x=new W3C(c.base);await assert.rejects(x.create('C:\\candidate\\clawpanel.exe',bad),/profile|userDataFolder/);assert.equal(seen.length,count,'非法profile不得发送请求')}
 }finally{t.diagnostic(JSON.stringify({scope:'own HTTP contract, not native VM',requests:seen}));server.closeAllConnections();await new Promise(r=>server.close(r))}
})
test('R6 profile诊断仅自有固定元数据路径：不创建、不泄露DevTools endpoint、拒绝越界链接',async()=>{
 const {webviewProfileMetadata}=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof webviewProfileMetadata,'function')
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'wx-profile-meta-'))),home=path.join(root,'h'),folder=path.join(home,'udd');fs.mkdirSync(home)
 try{const before=webviewProfileMetadata({home,userDataFolder:folder});assert.equal(before.folder.exists,false);assert.equal(fs.existsSync(folder),false);fs.mkdirSync(path.join(folder,'EBWebView'),{recursive:true});const content='49234\n/devtools/browser/private-endpoint\n';fs.writeFileSync(path.join(folder,'EBWebView/DevToolsActivePort'),content);const after=webviewProfileMetadata({home,userDataFolder:folder});assert.equal(after.files['EBWebView/DevToolsActivePort'].port,49234);assert.equal(after.files['EBWebView/DevToolsActivePort'].sha256,byteHash(Buffer.from(content)));assert.equal(JSON.stringify(after).includes('private-endpoint'),false);assert.equal(after.files.DevToolsActivePort.exists,false);fs.writeFileSync(path.join(folder,'DevToolsActivePort'),Buffer.alloc(4097));assert.equal(webviewProfileMetadata({home,userDataFolder:folder}).files.DevToolsActivePort.contentRead,false);assert.throws(()=>webviewProfileMetadata({home,userDataFolder:root}));const foreign=path.join(root,'foreign');fs.mkdirSync(foreign);fs.symlinkSync(foreign,path.join(home,'link'),'junction');assert.throws(()=>webviewProfileMetadata({home,userDataFolder:path.join(home,'link')}))
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('R6实际启动caps接线到env同一私有路径，保留request和脚本原timeout',()=>{
 const s=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8');assert.match(s,/client\.create\(application,env\.WEBVIEW2_USER_DATA_FOLDER\)/);assert.match(s,/receipt\('session-launch'/);assert.match(s,/timeout=120000/);assert.doesNotMatch(s,/--no-sandbox|ignoreCertificateErrors|disable-web-security/)
})
const contractLimits=(b,rows)=>({tarBytes:b.length,unpackedSize:rows.reduce((s,r)=>s+(r[1]??Buffer.from('x')).length,0),fileCount:rows.length,largeMembers:[]})
async function* oddChunks(b){for(let n=0;n<b.length;n+=37)yield b.subarray(n,n+37)}
test('R5 official metadata必须精确已审大小/文件数/SRI/版本，未知及缺大小均拒绝',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.validateHostArchiveMetadata,'function')
 for(const version of Object.keys(HOSTS)){const pin=HOSTS[version],meta={name:'openclaw',version,dist:{integrity:pin.integrity,tarball:`https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,unpackedSize:pin.unpackedSize,fileCount:pin.fileCount}};m.validateHostArchiveMetadata(version,meta)
  for(const patch of [{unpackedSize:undefined},{unpackedSize:0},{unpackedSize:String(pin.unpackedSize)},{unpackedSize:pin.unpackedSize+1},{fileCount:undefined},{fileCount:pin.fileCount+1},{integrity:HOSTS['2026.5.12'].integrity+'x'},{tarball:'https://example.invalid/x.tgz'}])assert.throws(()=>m.validateHostArchiveMetadata(version,{...meta,dist:{...meta.dist,...patch}}))
  assert.throws(()=>m.validateHostArchiveMetadata(version,{...meta,version:'2026.10.5'}))
 }assert.throws(()=>m.validateHostArchiveMetadata('2026.10.5',{}))
})
test('R5有界tar流逐成员hash，不缓存成员；截断/总量/数量/协议/路径/重复红灯',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.hashHostTarStream,'function')
 const rows=[['package/package.json',Buffer.from('{}')],['package/a',Buffer.from('abc')]],b=contractTar(rows),limits=contractLimits(b,rows)
 const r=await m.hashHostTarStream(oddChunks(b),limits);assert.deepEqual(r.members,rows.map(([name,v])=>({name,size:v.length,sha256:byteHash(v)})));assert.ok(r.peakBufferedBytes<=65536);assert.equal(r.tarBytes,b.length)
 for(const changed of [{tarBytes:b.length-1},{tarBytes:b.length+512},{unpackedSize:6},{fileCount:1},{fileCount:3}])await assert.rejects(m.hashHostTarStream(oddChunks(b),{...limits,...changed}))
 for(const broken of [b.subarray(0,b.length-512),Buffer.concat([b,Buffer.alloc(512)]),Buffer.from(b)]){if(broken.length===b.length)broken[200]^=1;await assert.rejects(m.hashHostTarStream(oddChunks(broken),limits))}
 for(const name of ['../x','package/../x','package/a//b','package/C:evil','package/a\\b','package/x.','package/./x']){const rows=[[name]],tar=contractTar(rows);await assert.rejects(m.hashHostTarStream(oddChunks(tar),contractLimits(tar,rows)))}
 for(const rows of [[['package/a'],['package/a']],[['package/A'],['package/a']],[['package/link',Buffer.from('x'),'2']],[['package/pax',Buffer.from('x'),'x']]]){const tar=contractTar(rows);await assert.rejects(m.hashHostTarStream(oddChunks(tar),contractLimits(tar,rows)))}
 const padding=Buffer.from(b);padding[514]=1;await assert.rejects(m.hashHostTarStream(oddChunks(padding),limits))
})
test('R5大成员仅精确已审path+size+hash可流过，未知大成员仍32MiB且超量立即cancel',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.hashHostTarStream,'function')
 const body=Buffer.alloc(32*1024*1024+1,97),rows=[['package/big',body]],b=contractTar(rows),limits=contractLimits(b,rows),approved={name:'package/big',size:body.length,sha256:byteHash(body)}
 await assert.rejects(m.hashHostTarStream(oddChunks(b.subarray(0,512)),limits),/成员预算/)
 const r=await m.hashHostTarStream([b],{...limits,largeMembers:[approved]});assert.equal(r.members[0].sha256,approved.sha256);assert.ok(r.peakBufferedBytes<=65536)
 for(const patch of [{name:'package/other'},{size:body.length+1},{sha256:'0'.repeat(64)}])await assert.rejects(m.hashHostTarStream([b],{...limits,largeMembers:[{...approved,...patch}]}))
 let closed=false,produced=0;async function* overflow(){try{while(true){produced++;yield Buffer.alloc(65536)}}finally{closed=true}}
 await assert.rejects(m.hashHostTarStream(overflow(),{tarBytes:1024,unpackedSize:1,fileCount:1,largeMembers:[]}));assert.equal(closed,true);assert.equal(produced,1)
})
test('R5压缩包入口绑定exact host/SRI/压缩字节，不让fixture/zipbomb/跨版本进入解压',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.inspectHostArchive,'function')
 const version='2026.10.4',pin=HOSTS[version],meta={name:'openclaw',version,dist:{integrity:pin.integrity,tarball:`https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,unpackedSize:pin.unpackedSize,fileCount:pin.fileCount}}
 await assert.rejects(m.inspectHostArchive(version,zlib.gzipSync(Buffer.alloc(2*1024*1024)),meta))
 await assert.rejects(m.inspectHostArchive('2026.10.5',Buffer.alloc(0),meta))
 await assert.rejects(m.inspectHostArchive(version,Buffer.alloc(pin.compressedSize),meta),/SRI|归档摘要/)
})
test('R5安装回读仅允许精确pending删除；其它缺失/变更/链接/pending保留均红',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.verifyHostMemberHashes,'function')
 const base=fs.realpathSync.native(os.tmpdir()),root=fs.realpathSync.native(fs.mkdtempSync(path.join(base,'weixin-host-readback-'))),body=Buffer.from('original'),pending=Buffer.from('pending\n'),members=[{name:'package/a',size:body.length,sha256:byteHash(body)},{name:'package/.openclaw-lifecycle-pending',size:pending.length,sha256:byteHash(pending)}],marker=members[1]
 try{fs.writeFileSync(path.join(root,'a'),body);fs.writeFileSync(path.join(root,'.openclaw-lifecycle-pending'),pending)
  await assert.rejects(m.verifyHostMemberHashes(root,members,marker),/pending|marker/)
  fs.unlinkSync(path.join(root,'.openclaw-lifecycle-pending'));assert.deepEqual(await m.verifyHostMemberHashes(root,members,marker),{a:byteHash(body)})
  await assert.rejects(m.verifyHostMemberHashes(root,members,null));await assert.rejects(m.verifyHostMemberHashes(root,members,{...marker,sha256:'0'.repeat(64)}));fs.writeFileSync(path.join(root,'a'),'changed');await assert.rejects(m.verifyHostMemberHashes(root,members,marker));fs.unlinkSync(path.join(root,'a'));await assert.rejects(m.verifyHostMemberHashes(root,members,marker));fs.mkdirSync(path.join(root,'.openclaw-lifecycle-pending'));await assert.rejects(m.verifyHostMemberHashes(root,members,marker))
 }finally{const rel=path.relative(base,fs.realpathSync.native(root));assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'只清理本次physical fixture');fs.rmSync(root,{recursive:true,force:true})}
})
test('R5 lifecycle完成收据需固定hook+真实npm成功命令和foreground输出，非零/静默/改hook均红',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.assertHostLifecycleReceipt,'function')
 for(const version of Object.keys(HOSTS)){const pin=HOSTS[version],members=Object.entries(pin.lifecycleHashes).map(([name,sha256])=>({name:'package/'+name,sha256,size:1}));if(pin.pending)members.push({name:'package/.openclaw-lifecycle-pending',...pin.pending})
  const cmd={ok:true,code:0,signal:null,pid:123,program:'C:\\private\\node.exe',cwd:'C:\\private\\host',args:['npm-cli.js','install','--global','--prefix','C:\\private\\host\\npm','--registry=https://registry.npmjs.org','--no-audit','--no-fund','--ignore-scripts=false','--foreground-scripts','C:\\private\\host\\openclaw.tgz']},stdout=`> openclaw@${version} postinstall\n> node scripts/postinstall-bundled-plugins.mjs\n`
  assert.equal(m.assertHostLifecycleReceipt(version,members,cmd,stdout).stdoutSha256,byteHash(Buffer.from(stdout)))
  for(const changed of [{code:1},{pid:0},{ok:false},{signal:'SIGTERM'},{args:cmd.args.filter(x=>x!=='--foreground-scripts')},{args:[...cmd.args,'--ignore-scripts']}])assert.throws(()=>m.assertHostLifecycleReceipt(version,members,{...cmd,...changed},stdout))
  assert.throws(()=>m.assertHostLifecycleReceipt(version,members,cmd,''));assert.throws(()=>m.assertHostLifecycleReceipt(version,members,cmd,stdout.replace(version,'other')));assert.throws(()=>m.assertHostLifecycleReceipt(version,[{...members[0],sha256:'0'.repeat(64)},...members.slice(1)],cmd,stdout))
 }
})
test('新 workflow 自己验证完整合取，不把 ref 改写后交老 validator',()=>{
  validateRunnerProof(proof()); assert.deepEqual(runnerProofFailures(proof()),[])
  assert.throws(()=>validateRunnerProof({...proof(),workflowRef:'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main'}))
})
for (const [key,value] of Object.entries({platform:'linux',arch:'arm64',runnerEnvironment:'self-hosted',runnerOS:'Linux',event:'push',ref:'refs/heads/work',repository:'fork/clawpanel',workflowRef:'wrong',workflowSha:'bad',toolingSha:'b'.repeat(40),runId:'',attempt:'',virtualMachine:false,imageOS:'win22',imageVersion:'',userName:'keh5',sid:'S-1-5-18',actualProfile:'D:\\home',registeredProfile:'C:\\Users\\other'})) {
  test(`门禁独立红灯 ${key}`,()=>assert.throws(()=>validateRunnerProof({...proof(),[key]:value})))
}
test('仅完整 SHA / 不接受 shell、浮动 host、默认不执行',()=>{
  assert.deepEqual(parseArgs([]),{})
  assert.throws(()=>parseArgs(['--execute','--sha','main']))
  assert.throws(()=>parseArgs(['--sha','a'.repeat(40),'--sha','b'.repeat(40)]))
  assert.throws(()=>parseArgs(['--host','2026.10.4-beta.1']))
  assert.throws(()=>parseArgs(['--execute','--plan']))
  assert.throws(()=>parseArgs(['--scope','fixture']))
  assert.equal(parseArgs(['--sha','a'.repeat(40),'--host','2026.10.4'])['--host'],'2026.10.4')
  for(const [v,p] of Object.entries(HOSTS)){assert.match(v,/^2026\.(5\.12|9\.8|10\.4)$/);assert.match(p.integrity,/^sha512-/);assert.match(p.manifest,/^[a-f0-9]{64}$/);assert.match(p.entry,/^[a-f0-9]{64}$/)}
})
test('本机 execute 在创建输出/安装/GUI之前拒绝',()=>{
  const r=spawnSync(process.execPath,['scripts/test-weixin-windows-qualification.mjs','--execute','--sha','a'.repeat(40),'--host','2026.10.4','--root','.','--output','DO-NOT-CREATE-WEIXIN'],{encoding:'utf8'})
  assert.notEqual(r.status,0); assert.match(r.stderr,/GitHub|hosted|Windows/); assert.equal(fs.existsSync('DO-NOT-CREATE-WEIXIN'),false)
})
test('无效key/SOP/缺API/超时不能冒充真实 frame ACL拒绝',()=>{
  const valid={frameUrl:'http://127.0.0.1:4321/probe.html',frameOrigin:'http://127.0.0.1:4321',messageOrigin:'http://127.0.0.1:4321',htmlSha256:'a'.repeat(64),sourceMatched:true,validInvokeKey:true,transport:'native-custom-protocol',response:'error',error:'Command prepare_weixin_install not allowed by ACL'}
  assertOriginDenial(valid)
  for(const patch of [{error:'missing __TAURI__'},{error:'invalid invoke key'},{error:'Failed to fetch'},{error:'timeout'},{response:'ok'},{sourceMatched:false},{validInvokeKey:false},{messageOrigin:'https://evil.test'},{htmlSha256:''},{transport:'parent-proxy'}])assert.throws(()=>assertOriginDenial({...valid,...patch}))
  assertOriginDenial({...valid,frameOrigin:'null',messageOrigin:'null',opaque:true})
  assert.throws(()=>assertOriginDenial({...valid,frameOrigin:'null',messageOrigin:'null',opaque:true,allowSameOrigin:true}))
})
test('tar固定位成员校验不接受链接、重复、超限/逃逸',()=>{
  const tar=(name,type='0')=>{const h=Buffer.alloc(512);h.write(name);h.write('00000000001\0',124);h[156]=type.charCodeAt();h.fill(32,148,156);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([h,Buffer.from('x'),Buffer.alloc(511),Buffer.alloc(1024)])}
  assert.equal(inspectTarMember(tar('package/package.json'),'package/package.json').toString(),'x')
  for(const b of [tar('package/package.json','2'),tar('../x'),Buffer.alloc(300*1024*1024+1)])assert.throws(()=>inspectTarMember(b,'package/package.json'))
})
const hash='a'.repeat(64)
function fixtureReport(){
  const source={file:{sha256:hash,gitBlob:'b'.repeat(40)}}
  return {sessionLaunch:{envUserDataFolder:debuggerProofFixture().metadata.userDataFolder},webviewDebugger:debuggerProofFixture(),status:'pass-native',scope:'complete',executionMode:'actual-github-hosted-windows-vm-weixin',runner:proof(),candidateSha:'c'.repeat(40),hostVersion:'2026.10.4',artifact:expectedArtifact('2026.10.4'),tooling:{sha:proof().toolingSha,before:structuredClone(source),after:structuredClone(source)},source:{sha:'c'.repeat(40),before:structuredClone(source),after:structuredClone(source)},build:{sha:'c'.repeat(40),noBundle:true,application:'C:\\private\\panel.exe',exeSha256:hash,dist:{'index.html':hash}},drivers:{tauri:tauriEvidence(),edge:{runtime:{path:debuggerProofFixture().runtimePath},path:'C:\\private\\edge\\msedgedriver.exe',version:'140.0.1.2',runtimeVersion:'140.0.1.2',sha256:hash}},cases:REQUIRED_CASES.map(id=>({id,status:'passed',evidenceKind:'actual-native',receipts:[hash]})),cleanup:{ports:[49345],webviewDebugger:{observation:{processes:[],present:[],listeners:[]}},hostUnchanged:true,processes:[],listeners:[],errors:[],identities:[{pid:111,creationDate:'2026-10-17T00:00:00.000Z'}]},gaps:[],errors:[]}
}
test('完整validator不接受partial、少negative/伪proof/stalehash/失败清理',()=>{
  assertNativeComplete(fixtureReport())
  const changes=[r=>delete r.webviewDebugger,r=>r.webviewDebugger=true,r=>delete r.cleanup.webviewDebugger,r=>r.cleanup.webviewDebugger.observation.listeners=[{port:49345}],r=>r.cleanup.ports=[],r=>r.artifact=expectedArtifact('2026.9.8'),r=>delete r.artifact,r=>r.scope='ui-origin',r=>r.status='passed-native-ui-origin-partial',r=>r.cases.pop(),r=>r.cases[0].status='skipped',r=>r.cases[0].receipts=[],r=>r.cases[0].evidenceKind='fixture',r=>r.runner.workflowRef='wrong',r=>r.source.sha='d'.repeat(40),r=>r.tooling.after.file.sha256='e'.repeat(64),r=>r.build.exeSha256='',r=>r.build.dist={},r=>r.drivers.edge.runtimeVersion='141.0.0.1',r=>r.cleanup.identities=[],r=>r.cleanup.processes=[{pid:111}],r=>r.gaps=['wrong-window NOT RUN'],r=>r.errors=['scannerfailed']]
  for(const change of changes){const r=fixtureReport();change(r);assert.throws(()=>assertNativeComplete(r))}
})
test('W3C失败响应不吞、trace脱敏不保存票据/key',async()=>{
  const c=new W3C('http://127.0.0.1:1')
  assert.throws(()=>new W3C('https://remote.test'))
  await assert.rejects(c.request('GET','/status',undefined,1000))
  const x=redact({confirmationToken:'secret',headers:{'Tauri-Invoke-Key':'native-key'},nested:{password:'p'},error:'WEIXIN_USED'})
  assert.equal(x.confirmationToken,'[REDACTED]');assert.equal(x.headers['Tauri-Invoke-Key'],'[REDACTED]');assert.equal(x.error,'WEIXIN_USED')
})
test('观察脚本排除控制器自身，不接受空PID/CreationDate替清理证据',()=>{
  const source=processObservationSource('C:\\private',[1234],[],9911)
  assert.match(source,/ProcessId -ne 9911/);assert.match(source,/ProcessId -ne \$PID/);assert.match(source,/CreationDate/);assert.match(source,/commandLine/)
})
test('必须观察真实private CLI安装命令，legacy不可新flag，现代必须两确认flag',()=>{
  const row={pid:77,creationDate:'2026-10-17T00:00:00Z',commandLine:'node C:\\private\\openclaw.mjs plugins install C:\\private\\artifact.tgz'}
  assertInstallObservation([row],'2026.5.12','C:\\private')
  assert.throws(()=>assertInstallObservation([],'2026.5.12','C:\\private'))
  assert.throws(()=>assertInstallObservation([{...row,commandLine:row.commandLine+' --accept-capabilities'}],'2026.5.12','C:\\private'))
  assert.throws(()=>assertInstallObservation([row],'2026.10.4','C:\\private'))
  assertInstallObservation([{...row,commandLine:row.commandLine+' --force --accept-capabilities'}],'2026.10.4','C:\\private')
  assert.throws(()=>assertInstallObservation([{...row,creationDate:null}],'2026.5.12','C:\\private'))
})
test('UI准备结果必须固定artifact/review/host并真实有效，不能只看modal存在',()=>{
 const p={protocolVersion:1,kind:'weixin-install-consent',operationId:'b38b0908-08bc-41f9-a46b-dd58dd04d390',confirmationToken:'x'.repeat(43),expiresAt:new Date(Date.now()+300000).toISOString(),hostVersion:'2026.10.4',capabilityMode:'native-cli',artifact:expectedArtifact('2026.10.4'),repairingIncompatible:false,priorCompatibility:{compatible:null,compatError:''},review:{manifestSha256:expectedArtifact('2026.10.4').manifestSha256,declared:{channels:['openclaw-weixin'],providers:[],tools:[],contracts:[],hooks:[],mcpServers:[],cliCommands:[],cliBackends:[],skills:[],dangerousConfigFlags:[]},reviewToken:'4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d'}}
 assertPreparedTicket(p,'2026.10.4')
 for(const change of [x=>x.hostVersion='2026.9.8',x=>x.artifact.sha256='0'.repeat(64),x=>x.review.reviewToken='bad',x=>x.expiresAt='2000-01-01',x=>x.capabilityMode='legacy-reviewed']){const q=structuredClone(p);change(q);assert.throws(()=>assertPreparedTicket(q,'2026.10.4'))}
})
test('隔离真实HTTP W3C收据：create/click/error/delete；不算native GUI',async()=>{
 const seen=[];const server=http.createServer((req,res)=>{let data='';req.on('data',b=>data+=b);req.on('end',()=>{seen.push({method:req.method,url:req.url,body:data?JSON.parse(data):null});res.setHeader('content-type','application/json');if(req.url==='/session')res.end(JSON.stringify({value:{sessionId:'fixture-session'}}));else if(req.url.endsWith('/element'))res.end(JSON.stringify({value:{'element-6066-11e4-a52e-4f735466cecf':'fixture-element'}}));else if(req.url.endsWith('/execute/sync')){res.statusCode=500;res.end(JSON.stringify({value:{error:'javascript error',message:'fixture native rejection'}}))}else res.end(JSON.stringify({value:null}))})})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const c=new W3C('http://127.0.0.1:'+server.address().port);await c.create('fixture.exe','C:\\qualification\\h\\.webview2');await c.click('[data-weixin-consent-accept]');await assert.rejects(c.script('throw Error()'),/fixture native rejection/);await c.close();assert.ok(seen.some(x=>x.url.endsWith('/fixture-element/click')));assert.ok(seen.some(x=>x.method==='DELETE'));assert.ok(c.events.every(e=>!Object.hasOwn(e,'body')))}finally{await new Promise(r=>server.close(r))}
})
test('workflow仅main手工canonical、精确SHA经环境输入、readonly/无持久凭据',()=>{
  const w=fs.readFileSync(new URL('../.github/workflows/weixin-qualification.yml',import.meta.url),'utf8')
  assert.match(w,/workflow_dispatch:/);assert.match(w,/contents: read/);assert.match(w,/refs\/heads\/main/);assert.match(w,/github\.repository == 'qingchencloud\/clawpanel'/);assert.match(w,/runs-on: windows-2025/)
  assert.equal((w.match(/persist-credentials: false/g)||[]).length,2);assert.doesNotMatch(w,/pull_request_target|contents: write|secrets\.|self-hosted/)
  assert.match(w,/CANDIDATE_SHA: \$\{\{ inputs.candidate_sha \}\}/);assert.doesNotMatch(w,/--sha ['"]?\$\{\{/)
})
test('所有嵌入的WebDriver脚本逐个经真实V8 parser，不能只node --check外层mjs',()=>{
 const source=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8')
 const literals=[...source.matchAll(/(?:\.script\(|script:)\s*(String\.raw`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)]
 assert.ok(literals.length>=16,'注入脚本提取覆盖意外减少')
 for(const m of literals){const script=vm.runInNewContext('('+m[1]+')');assert.equal(typeof script,'string');assert.doesNotThrow(()=>new vm.Script('(function(){\n'+script+'\n})'),`注入JS@${source.slice(0,m.index).split('\n').length}`)}
})
test('运行时完整脚本清单包含audit/HTML；动态脚本也在native发送前解析',async()=>{
 const {injectionScripts,validateInjectionSyntax}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const rows=injectionScripts();assert.ok(rows.length>=18);assert.ok(rows.some(x=>x.name==='audit'));assert.ok(rows.some(x=>x.name==='untrusted-frame-html'));validateInjectionSyntax()
 const c=new W3C('http://127.0.0.1:1');c.session='fixture';await assert.rejects(c.script('function(}'),/injected JS syntax|Unexpected/);assert.equal(c.events.length,0)
})

test('crates官方固定API真实HTTP契约：具名UA才200，固定version/hash且不重试/重定向',async()=>{
 const {readPinnedTauriDriverMetadata}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const original={version:{crate:'tauri-driver',num:'2.1.0',checksum:'2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953',yanked:false}},seen=[];let reply=original,mode='json'
 const server=http.createServer((req,res)=>{seen.push({method:req.method,url:req.url,headers:req.headers});if(!req.headers['user-agent']?.includes('ClawPanel-Weixin-Native-Qualification/')||!req.headers['user-agent'].includes('https://github.com/qingchencloud/clawpanel')){res.writeHead(403).end();return}if(mode==='403'){res.writeHead(403).end();return}if(mode==='redirect'){res.writeHead(302,{location:'https://example.invalid/untrusted'}).end();return}res.setHeader('content-type','application/json');res.end(mode==='oversize'?' '.repeat(2*1024*1024+1):JSON.stringify(reply))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+server.address().port+'/api/v1/crates/tauri-driver/2.1.0';let calls=0
 try{
  assert.equal((await fetch(local)).status,403,'原Node默认UA必须复现原403契约')
  const fetchImpl=(url,options)=>{calls++;assert.equal(url,'https://crates.io/api/v1/crates/tauri-driver/2.1.0');assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('accept'),'application/json');return fetch(local,options)}
  assert.deepEqual(await readPinnedTauriDriverMetadata(fetchImpl),original);assert.equal(calls,1);assert.equal(seen.at(-1).method,'GET');assert.equal(seen.at(-1).url,'/api/v1/crates/tauri-driver/2.1.0');assert.equal(seen.at(-1).headers.authorization,undefined)
  for(const patch of [{crate:'wrong'},{num:'2.1.1'},{checksum:'0'.repeat(64)},{yanked:true},{yanked:null}]){reply={version:{...original.version,...patch}};const before=calls;await assert.rejects(readPinnedTauriDriverMetadata(fetchImpl));assert.equal(calls,before+1,'不得对坏元数据重试')}
  for(const next of ['403','redirect','oversize']){mode=next;const before=calls;await assert.rejects(readPinnedTauriDriverMetadata(fetchImpl));assert.equal(calls,before+1,'错误/跳转/超额不得重试或回退')}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})

const driverHelp='USAGE: tauri-driver [FLAGS] [OPTIONS]\n\nFLAGS:\n  -h, --help              Prints help information\n\nOPTIONS:\n  --port NUMBER           Sets the tauri-driver intermediary port\n  --native-port NUMBER    Sets the port of the underlying WebDriver\n  --native-host HOST      Sets the host of the underlying WebDriver (Linux only)\n  --native-driver PATH    Sets the path to the native WebDriver binary'
test('真实R4 CI=1的bool解析红灯：构建显式--ci覆盖env，Cargo --locked置于Tauri分隔符之后',()=>{
 const source=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8'),call=/await run\(process.execPath,(\[npm,'run','tauri','build'[^\n]+?\]),(\d+)\)/.exec(source)
 assert.ok(call,'缺少实际npm/Tauri构建调用');const args=Array.from(vm.runInNewContext(call[1],{npm:'fixture-npm-cli.js'}))
 assert.deepEqual(args,['fixture-npm-cli.js','run','tauri','build','--','--no-bundle','--ci','--','--locked'],'固定CLI2.10 CI bool不接受1，显式flag优先级已用坏schema本机无build验证；不得删锁或给Cargo错误位置')
 assert.equal(Number(call[2]),2400000,'构建预算不变');assert.doesNotMatch(source,/(?:process\.env|env)\.CI\s*=/,'无需改变父环境或共享CI值')
 assert.match(source,/report\.source.after=gitSnapshot\(candidate,o\['--sha'\]\)/);assert.match(source,/report\.tooling.after=gitSnapshot\(tooling,proof.toolingSha\)/)
})
test('真实38962119578微软154输出新名称仍严格提取四段版本，不伪造工具stdout',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.parseMicrosoftEdgeDriverVersion,'function','原run两host真实exit0新名称被旧MSEdgeDriver正则解析为undefined')
 const actual='Microsoft Edge WebDriver 154.0.4258.62 (49f7c5590dad654f33b924537ccc8be227c5a43a)\r\n'
 assert.equal(m.parseMicrosoftEdgeDriverVersion(actual),'154.0.4258.62')
 assert.equal(m.parseMicrosoftEdgeDriverVersion('MSEdgeDriver 154.0.4258.62 (49f7c5590dad654f33b924537ccc8be227c5a43a)'),'154.0.4258.62')
 assert.equal(m.parseMicrosoftEdgeDriverVersion('MSEdgeDriver 154.0.4258.62'),'154.0.4258.62')
 for(const bad of ['',null,'154.0.4258.62','Other Driver 154.0.4258.62','Microsoft Edge WebDriver 154.0.4258','Microsoft Edge WebDriver 154.0.4258.62-beta','MSEdgeDriver 154.0.4258.62forged','error\n'+actual,actual+'second line','Microsoft Edge WebDriver 154.0.4258.62 (hash\nforged)'])assert.throws(()=>m.parseMicrosoftEdgeDriverVersion(bad))
 const source=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8')
 assert.match(source,/parseMicrosoftEdgeDriverVersion\(await run\(edge,\['--version'\]\)\)/)
 assert.match(source,/assert.equal\(edgeVersion,runtime.version\)/,'仍要求实际driver和runtime精确四段相等')
 assert.match(source,/Get-AuthenticodeSignature/,'官方签名门禁保持')
})
function driverReceipt(){return {installs:{'tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)':{version_req:'=2.1.0',bins:['tauri-driver.exe'],features:[],all_features:false,no_default_features:false,profile:'release',target:'x86_64-pc-windows-msvc',rustc:'rustc 1.95.0 fixture'}}}}
test('真实2.1.0 unused --version红灯不再作为ABI；实际help才是CLI探针',async()=>{
 const source=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8')
 assert.equal(/run\(tauri,\s*\['--version'\]/.test(source),false,'原VM三host均exit1，不应再次调用不存在的version flag')
 const {validateTauriDriverHelp}=await import('../scripts/test-weixin-windows-qualification.mjs');validateTauriDriverHelp(driverHelp)
 for(const bad of ['tauri-driver 2.1.0','Error: unused arguments left: ["--version"]\n'+driverHelp,driverHelp.replace('--native-driver','--unsupported'),driverHelp+'\n--version'])assert.throws(()=>validateTauriDriverHelp(bad))
})

test('Cargo真实tracking schema严格解析package version/source/bin，不用硬编码stdout充当版本',async()=>{
 const {parseTauriDriverInstallReceipt}=await import('../scripts/test-weixin-windows-qualification.mjs');const receipt=driverReceipt(),r=parseTauriDriverInstallReceipt(JSON.stringify(receipt));assert.equal(r.name,'tauri-driver');assert.equal(r.version,'2.1.0');assert.equal(r.packageId,Object.keys(receipt.installs)[0]);assert.equal(r.source,'registry+https://github.com/rust-lang/crates.io-index')
 const changes=[r=>r.installs={},r=>{const key=Object.keys(r.installs)[0];r.installs[key.replace('2.1.0','2.2.0')]=r.installs[key];delete r.installs[key]},r=>{const key=Object.keys(r.installs)[0];r.installs[key.replace('registry+https://github.com/rust-lang/crates.io-index','path+file:///foreign')]=r.installs[key];delete r.installs[key]},r=>Object.values(r.installs)[0].bins=[],r=>Object.values(r.installs)[0].bins=['other.exe'],r=>Object.values(r.installs)[0].version_req='^2.1',r=>Object.values(r.installs)[0].target='aarch64-pc-windows-msvc',r=>Object.values(r.installs)[0].profile='debug',r=>r.installs['other 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)']={}]
 for(const change of changes){const r=structuredClone(receipt);change(r);assert.throws(()=>parseTauriDriverInstallReceipt(JSON.stringify(r)))}for(const raw of ['',JSON.stringify({installs:[]}),'{bad'])assert.throws(()=>parseTauriDriverInstallReceipt(raw))
})

function tauriEvidence(){
 const h=x=>crypto.createHash('sha256').update(x).digest('hex'),rawJson=JSON.stringify(driverReceipt()),root='C:\\private\\tauri-driver',binary=root+'\\bin\\tauri-driver.exe',edge='C:\\private\\edge\\msedgedriver.exe'
 return {path:binary,version:'2.1.0',versionSource:'cargo-install-tracking',packageId:Object.keys(driverReceipt().installs)[0],sha256:hash,sha256AfterHelp:hash,sha256AfterSession:hash,crateChecksum:'2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953',crateArchive:{path:'C:\\private\\cargo\\registry\\tauri-driver-2.1.0.crate',sha256:'2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953'},receipt:{rawJson,sha256:h(rawJson)},sourceHashes:{'Cargo.toml':'b30161d77b195300c06d5b461907134e640f9c8ca84284d7de421bb5920fa3ed','src/cli.rs':'d08a622c036becf29cad6cbcae5974ae630005354370f7605582f68bf2709a7c','src/server.rs':'4670240b353c3430ecf5c5a6192e9107952ec5bd4eea97ee24bfb2564746fdfa'},help:{text:driverHelp,sha256:h(driverHelp)},installCommand:{program:'C:\\private\\cargo.exe',args:['install','tauri-driver','--version','2.1.0','--locked','--root',root,'--target-dir','C:\\private\\target'],ok:true,code:0,pid:55},session:{sessionId:'real-session-shape-fixture',application:'C:\\private\\panel.exe',capabilities:{browserName:'webview2',browserVersion:'140.0.1.2'},ports:{intermediary:4444,native:4445},processes:{intermediary:{pid:77,creationDate:'2026-10-17T00:00:00Z',exe:binary},native:{pid:78,creationDate:'2026-10-17T00:00:00Z',exe:edge}},listeners:[{port:4444,pid:77},{port:4445,pid:78}]}}
}
test('driver版本证据要同时绑定Cargo receipt/checksum/binary/help和真实session PID/监听端口',async()=>{
 const {assertTauriDriverEvidence}=await import('../scripts/test-weixin-windows-qualification.mjs'),edge={path:'C:\\private\\edge\\msedgedriver.exe',runtimeVersion:'140.0.1.2'};assertTauriDriverEvidence(tauriEvidence(),edge,'C:\\private\\panel.exe')
 const changes=[r=>r.version='tauri-driver 2.1.0',r=>r.versionSource='--version',r=>r.receipt.rawJson='{}',r=>r.receipt.sha256='0'.repeat(64),r=>r.crateChecksum='0'.repeat(64),r=>r.crateArchive.sha256='0'.repeat(64),r=>r.sourceHashes['src/cli.rs']='0'.repeat(64),r=>r.help.text='tauri-driver 2.1.0',r=>r.sha256AfterHelp='0'.repeat(64),r=>r.sha256AfterSession='0'.repeat(64),r=>r.installCommand.code=1,r=>r.installCommand.args[3]='2.2.0',r=>r.session.sessionId='',r=>r.session.capabilities={},r=>r.session.capabilities.browserVersion='139.0.0.1',r=>r.session.application='C:\\foreign.exe',r=>r.session.processes.intermediary.creationDate='',r=>r.session.processes.native.exe='C:\\foreign.exe',r=>r.session.listeners=[],r=>r.session.listeners[0].pid=999,r=>r.session.ports.native=0]
 for(const change of changes){const r=tauriEvidence();change(r);assert.throws(()=>assertTauriDriverEvidence(r,edge,'C:\\private\\panel.exe'))}
})

test('v2原生host精确选择两份独立artifact，同一reviewToken不能混用',async()=>{
 const {expectedArtifact}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const legacy=expectedArtifact('2026.5.12'),modern=expectedArtifact('2026.10.4')
 assert.equal(legacy.version,'2.4.9');assert.deepEqual(legacy,expectedArtifact('2026.9.8'));assert.equal(modern.version,'2.4.10');assert.equal(legacy.reviewToken,modern.reviewToken);assert.notEqual(legacy.sha256,modern.sha256);assert.notEqual(legacy.manifestSha256,modern.manifestSha256);assert.equal(modern.fileCount,131)
 for(const v of ['2026.10.5','2026.10.4-beta.1','2026.9.8-zh.bad','2026.9.8-zh.1-beta.1','latest',''])assert.throws(()=>expectedArtifact(v))
})

test('现代SDK回读不依赖已废弃installs，但任何矛盾/重复/未loaded必须红',async()=>{
 const {assertSdkReadback}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const status={installed:true,installedVersion:'2.4.10',extensionDir:'C:\\private\\ext'},cfg={plugins:{entries:{'openclaw-weixin':{enabled:true}}}},inventory={plugins:[{id:'openclaw-weixin',version:'2.4.10',status:'loaded',enabled:true,rootDir:status.extensionDir,channelIds:['openclaw-weixin']}]}
 assert.equal(assertSdkReadback(status,cfg,inventory,'2026.10.4'),status.extensionDir)
 const changes=[x=>x.s.installedVersion='2.4.9',x=>x.s.installed=false,x=>x.s.extensionDir='',x=>x.i.plugins.push({...x.i.plugins[0]}),x=>x.i.plugins[0].rootDir='C:\\foreign',x=>x.i.plugins[0].status='error',x=>x.i.plugins[0].enabled=false,x=>x.i.plugins[0].channelIds=[],x=>x.i.plugins[0].channelIds='openclaw-weixin',x=>x.i.plugins[0].dependencyStatus={requiredInstalled:false},x=>x.i.plugins[0].dependencyStatus={missing:['sdk']},x=>x.c.plugins.entries['openclaw-weixin'].enabled=false,x=>x.c.plugins.installs=null,x=>x.c.plugins.installs={'openclaw-weixin':{version:'2.4.9',installPath:status.extensionDir}},x=>x.c.plugins.installs={'openclaw-weixin':{version:'2.4.10',installPath:'C:\\foreign'}}]
 for(const change of changes){const x={s:structuredClone(status),c:structuredClone(cfg),i:structuredClone(inventory)};change(x);assert.throws(()=>assertSdkReadback(x.s,x.c,x.i,'2026.10.4'))}
})

test('窗口surface只能凭源码及真实枚举证明不可达，不把拒绝create当wrong-window通过',async()=>{
 const {assessWindowSurface}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const config={app:{windows:[{title:'ClawPanel'}]}},capabilities=[{windows:['main'],permissions:['core:default']}],source={'src/lib.js':'console.log(1)','src-tauri/src/tray.rs':'app.get_webview_window("main");'}
 const p=assessWindowSurface(config,capabilities,source,{windows:['main'],webviews:['main'],handles:['0']});assert.equal(p.status,'unreachable-existing-surface');assert.equal(p.negativeExecuted,false)
 for(const patch of [{windows:[],webviews:['main'],handles:['0']},{windows:['main'],webviews:['main','other'],handles:['0']},{windows:['main'],webviews:['main'],handles:['0','1']}])assert.throws(()=>assessWindowSurface(config,capabilities,source,patch))
 assert.throws(()=>assessWindowSurface(config,capabilities,{...source,'src-tauri/src/new.rs':'WebviewWindowBuilder::new(app,"secondary")'},{windows:['main'],webviews:['main'],handles:['0']}))
 assert.throws(()=>assessWindowSurface(config,[{windows:['main'],permissions:['core:webview:allow-create-webview-window']}],source,{windows:['main'],webviews:['main'],handles:['0']}))
})

test('实际执行私有operator policy协议：精确归档/manifest/host才记录block，坏来源不得算scanner绿',async()=>{
 const {makeInstallPolicyProgram,assertPolicyDenial}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'weixin-policy-contract-'))),artifact=expectedArtifact('2026.10.4'),sha=b=>crypto.createHash('sha256').update(b).digest('hex')
 try{
  const source=path.join(root,'source');fs.mkdirSync(source);const manifest=Buffer.from('{"id":"fixture"}'),archive=Buffer.from('fixture-not-vendor');fs.writeFileSync(path.join(source,'openclaw.plugin.json'),manifest);const tgz=path.join(root,'artifact.tgz');fs.writeFileSync(tgz,archive);const file=path.join(root,'receipt.json'),nonce='7'.repeat(32),program=makeInstallPolicyProgram({root,receiptFile:file,nonce,host:'2026.10.4',artifact:{...artifact,sha256:sha(archive),manifestSha256:sha(manifest)}});new vm.Script(program)
  const request={protocolVersion:1,openclawVersion:'2026.10.4',targetType:'plugin',targetName:'openclaw-weixin',sourcePath:source,sourcePathKind:'directory',request:{kind:'plugin-archive',mode:'install',requestedSpecifier:tgz},plugin:{pluginId:'openclaw-weixin',packageName:artifact.packageName,version:artifact.version}}
  const r=spawnSync(process.execPath,['-e',program],{input:JSON.stringify(request),encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{protocolVersion:1,decision:'block',reason:'clawpanel-native-policy-'+nonce});const receipt=JSON.parse(fs.readFileSync(file));assert.equal(receipt.nonce,nonce);assert.equal(receipt.artifactSha256,sha(archive));assert.equal(receipt.manifestSha256,sha(manifest))
  const valid={r:{ok:false,error:'WEIXIN_INSTALL_FAILED: CLI 1: Install blocked by policy\n\n  Plugin: openclaw-weixin\n  Reason: clawpanel-native-policy-'+nonce},receipt,nonce,artifact:{...artifact,sha256:sha(archive),manifestSha256:sha(manifest)},host:'2026.10.4',progress:'0%',log:'Install blocked by policy\n\n  Plugin: openclaw-weixin\n  Reason: clawpanel-native-policy-'+nonce,before:{config:'x',files:{}},after:{config:'x',files:{}},replay:{ok:false,error:'WEIXIN_USED'}};assertPolicyDenial(valid)
  for(const patch of [{r:{ok:true}},{r:{ok:false,error:'WEIXIN_HOST_CHANGED'}},{r:{ok:false,error:'WEIXIN_INSTALL_FAILED: clawpanel-native-policy-'+nonce}},{progress:'100%'},{log:''},{receipt:{...receipt,nonce:'forged'}},{after:{config:'changed'}},{replay:{ok:true}}])assert.throws(()=>assertPolicyDenial({...valid,...patch}))
  fs.unlinkSync(file)
  for(const patch of [{openclawVersion:'2026.9.8'},{sourcePath:os.tmpdir()},{request:{kind:'plugin-npm',mode:'install',requestedSpecifier:'remote'}},{plugin:{...request.plugin,version:'2.4.9'}}]){const bad=spawnSync(process.execPath,['-e',program],{input:JSON.stringify({...request,...patch}),encoding:'utf8',timeout:5000});assert.notEqual(bad.status,0);assert.equal(fs.existsSync(file),false)}
 }finally{assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})}
})

// R7现场派生；只跑自有文件/TCP及CIM形状，非native VM通过。
test('R8 debugger动态端口身份边界/失败cleanup first-red',async()=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');for(const key of ['nativeDriverChildEnv','captureWebviewDebugger','assertWebviewDebugger','assertWebviewDebuggerClosed','webviewDebuggerObservationSource'])assert.equal(typeof m[key],'function',key);
 const parent={PATH:'unchanged',webview2_additional_browser_arguments:'--foreign',WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER:'foreign',webview2_wait_for_script_debugger:'true'},copy=structuredClone(parent),env=m.nativeDriverChildEnv(parent);assert.deepEqual(parent,copy);assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,undefined);assert.equal(Object.keys(env).filter(k=>/webview2_additional_browser_arguments/i.test(k)).length,0);assert.deepEqual(env,{PATH:'unchanged'});assert.ok(!Object.keys(env).some(k=>/WEBVIEW2_(?:PIPE|WAIT)_FOR_SCRIPT_DEBUGGER/i.test(k)));
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'native-debug-r8-'))),home=path.join(root,'h'),folder=path.join(home,'udd'),data=path.join(folder,'EBWebView'),runtime='C:/official/154.0.4258.62/msedgewebview2.exe';fs.mkdirSync(data,{recursive:true});const endpoint=path.join(data,'DevToolsActivePort'),server=http.createServer((req,res)=>res.end('isolated-loopback-not-native'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,nonce='private-devtools-nonce';fs.writeFileSync(endpoint,port+'\n/devtools/browser/'+nonce+'\n');const p={pid:1234,creationDate:'2026-10-17T00:00:00.000Z',exe:runtime,commandLine:'msedgewebview2 --embedded-browser-webview=1 --user-data-dir="'+data+'" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1'},observation={processes:[p],listeners:[{...p,port,localAddress:'127.0.0.1'}],present:[p]},ports=new Set(),identities=new Map();let queried;
 const capture=(value=observation,extra={})=>m.captureWebviewDebugger({home,userDataFolder:folder,runtimePath:runtime,snapshot:wanted=>{queried=wanted;return structuredClone(value)},ports,identities,...extra});
 try{const proof=capture();assert.equal(proof.port,port);assert.ok(ports.has(port)&&queried.includes(port));assert.equal(identities.size,1);assert.equal(JSON.stringify(proof).includes(nonce),false);assert.equal((await fetch('http://127.0.0.1:'+proof.port)).status,200);m.assertWebviewDebugger(proof);
 const mutations=[x=>x.observation.listeners=[],x=>x.observation.listeners[0].localAddress='0.0.0.0',x=>x.observation.listeners[0].localAddress='::',x=>x.observation.listeners[0].localAddress='192.0.2.3',x=>x.observation.listeners.push({...x.observation.listeners[0],localAddress:'0.0.0.0'}),x=>x.observation.listeners[0].pid++,x=>x.observation.listeners[0].creationDate='2026-10-17T01:00:00Z',x=>x.observation.processes[0].exe='C:/foreign.exe',x=>x.observation.processes[0].commandLine=x.observation.processes[0].commandLine.replace(data,data+'-foreign'),x=>x.observation.processes[0].commandLine=x.observation.processes[0].commandLine.replace('--remote-debugging-port=0',''),x=>x.metadata.files['EBWebView/DevToolsActivePort'].sha256='',x=>x.port++];for(const change of mutations){const value=structuredClone(proof);change(value);assert.throws(()=>m.assertWebviewDebugger(value));}
 const rebound=structuredClone(observation);rebound.processes[0].creationDate='2026-10-18T00:00:00Z';rebound.listeners[0].creationDate=rebound.processes[0].creationDate;assert.throws(()=>capture(rebound,{expected:proof}));
 const bad=structuredClone(observation);bad.listeners[0].localAddress='0.0.0.0';const failedPorts=new Set(),failedIds=new Map();let failed;try{capture(bad,{ports:failedPorts,identities:failedIds})}catch(e){failed=e}assert.ok(failed?.debuggerEvidence);assert.ok(failedPorts.has(port)&&failedIds.size===1);assert.equal(JSON.stringify(failed.debuggerEvidence).includes(nonce),false);
 const source=m.webviewDebuggerObservationSource({userDataFolder:folder,ports:[port],tracked:[p]});for(const word of ['Get-CimInstance','Get-NetTCPConnection','LocalAddress','CreationDate','OwningProcess'])assert.ok(source.includes(word),word);assert.ok(source.indexOf('OutputEncoding')<source.indexOf('Get-CimInstance'));
 fs.writeFileSync(endpoint,Buffer.alloc(4097));assert.throws(()=>capture(),/DevTools/);fs.writeFileSync(endpoint,'0\n/devtools/browser/'+nonce);assert.throws(()=>capture(),/DevTools/);fs.writeFileSync(endpoint,port+'\nnot-an-endpoint');assert.throws(()=>capture(),/DevTools/);fs.unlinkSync(endpoint);assert.throws(()=>capture(),/DevTools/);fs.writeFileSync(endpoint,port+'\n/devtools/browser/'+nonce+'\n');fs.writeFileSync(path.join(folder,'DevToolsActivePort'),(port+1)+'\n/devtools/browser/'+nonce+'\n');assert.throws(()=>capture(),/DevTools/);assert.ok(ports.has(port+1));fs.unlinkSync(path.join(folder,'DevToolsActivePort'));
 await new Promise(r=>server.close(r));m.assertWebviewDebuggerClosed(proof,{processes:[],present:[],listeners:[]});for(const remaining of [{processes:[p],present:[],listeners:[]},{processes:[],present:[p],listeners:[]},{processes:[],present:[],listeners:observation.listeners}])assert.throws(()=>m.assertWebviewDebuggerClosed(proof,remaining));
 }finally{server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
});
test('R8 debugger接在driver-child/session finally/最终清理而非仅参数',()=>{const s=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8');assert.match(s,/const driverEnv = nativeDriverChildEnv\(env\)/);assert.match(s,/env: driverEnv\b/);assert.match(s,/report\.driverEnvSubmission = nativeDriverEnvSubmission\(driverEnv\)/);assert.ok(s.indexOf('report.driverEnvSubmission =')<s.indexOf('driver = spawn(') || s.indexOf('report.driverEnvSubmission =')<s.indexOf('driver=spawn('));assert.ok(s.includes('driver-env-submission'));assert.ok(s.includes('captureWebviewDebugger({'));assert.ok(s.includes('assertWebviewDebuggerClosed('));assert.ok(s.includes('debugger-before-cleanup'));assert.ok(s.includes('debugger-after-cleanup'));assert.ok(s.includes('debuggerGap'));assert.doesNotMatch(s,/--no-sandbox|ignoreCertificateErrors|disable-web-security/)});

// 仅供validator隔离形状测试；不是native运行收据。
function debuggerProofFixture(){
 const folder='C:\\private\\h\\udd',runtimePath='C:\\official\\154.0.4258.62\\msedgewebview2.exe',port=49345,p={pid:9912,creationDate:'2026-10-17T00:00:00.000Z',exe:runtimePath,commandLine:'msedgewebview2 --embedded-browser-webview=1 --user-data-dir="'+folder+'\\EBWebView" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1'};
 return {runtimePath,metadata:{userDataFolder:folder,files:{'DevToolsActivePort':{exists:false},'EBWebView/DevToolsActivePort':{exists:true,size:64,contentRead:true,validEndpoint:true,port,sha256:'1'.repeat(64)}}},port,ports:[port],process:p,identities:[p],observation:{processes:[p],present:[p],listeners:[{...p,port,localAddress:'127.0.0.1'}]}};
}

// R8真实失败后改接线；这里只证自有Node子环境/白名单收据，不冒充app环境或native UI。
test('R9 child env提交收据清理三冲突键且非app实际env证据',async(t)=>{
 const m=await import('../scripts/test-weixin-windows-qualification.mjs');assert.equal(typeof m.nativeDriverEnvSubmission,'function');
 const folder='C:\\qualification\\h\\private-udd',parent={PATH:process.env.PATH||'',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),WEBVIEW2_USER_DATA_FOLDER:folder,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--foreign-upper',webview2_additional_browser_arguments:'--foreign-lower',WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER:'foreign',WebView2_Wait_For_Script_Debugger:'true',QUALIFICATION_SECRET:'synthetic-do-not-publish',UNRELATED:'keep'};
 const before=structuredClone(parent),hostBefore={...process.env},env=m.nativeDriverChildEnv(parent),keys=['WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER','WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER'];
 assert.notEqual(env,parent);assert.deepEqual(parent,before);assert.deepEqual({...process.env},hostBefore);assert.equal(env.WEBVIEW2_USER_DATA_FOLDER,folder);assert.equal(env.UNRELATED,'keep');assert.ok(!Object.keys(env).some(k=>/^WEBVIEW2_(ADDITIONAL_BROWSER_ARGUMENTS|PIPE_FOR_SCRIPT_DEBUGGER|WAIT_FOR_SCRIPT_DEBUGGER)$/i.test(k)));
 const receipt=m.nativeDriverEnvSubmission(env),expected={scope:'driver-child spawn submission only; not actual driver/app/runtime environment readback',actualEnvironmentObserved:false,submitted:Object.fromEntries(keys.map(k=>[k,k==='WEBVIEW2_USER_DATA_FOLDER'?folder:null]))};
 assert.deepEqual(receipt,expected);assert.equal(JSON.stringify(receipt).includes('synthetic-do-not-publish'),false);assert.equal(JSON.stringify(receipt).includes('UNRELATED'),false);
 for(const k of keys.slice(1))for(const name of [k,k.toLowerCase()])assert.throws(()=>m.nativeDriverEnvSubmission({...env,[name]:'conflict'}));
 const child=spawnSync(process.execPath,['-e',`const keys=${JSON.stringify(keys)};process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))))`],{env,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),receipt.submitted);assert.deepEqual(parent,before);assert.deepEqual({...process.env},hostBefore);t.diagnostic(JSON.stringify({scope:'own Node child only; not actual driver/app/runtime env',receipt,childObserved:JSON.parse(child.stdout)}));
});
