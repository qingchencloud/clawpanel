// 字体视觉红灯先于实现；本文件只跑隔离契约/发布路径，不执行apt或本机GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runner=path.join(root,'scripts/hermes-qualification-browser.py'),python=process.platform==='win32'?'python':'python3'
function py(body){const code=`import importlib.util,json,copy,tempfile,pathlib\nspec=importlib.util.spec_from_file_location('cjk',${JSON.stringify(runner)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef reject(fn):\n try: fn()\n except (AssertionError,ValueError,KeyError): return\n raise AssertionError('negative accepted')\n`+body;const r=spawnSync(python,['-B','-X','utf8','-c',code],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stdout+r.stderr).slice(-4500));return r.stdout}
test('fontconfig cmap必须逐码点覆盖真实中文；加载成功/LastResort/零glyph不能补绿',()=>{py(String.raw`
assert hasattr(m,'parse_fc_charset') and hasattr(m,'assert_cjk_coverage')
assert m.parse_fc_charset('20-7e 4e00-9fff')==[(32,126),(19968,40959)]
for bad in ['', 'xyz','9-1','110000','4e00 4d00','1-2-3']:reject(lambda:m.parse_fc_charset(bad))
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'20-7e 4e00-9fff'}
fonts=[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':8,'isCustomFont':False}]
r=m.assert_cjk_coverage('浏览器完整回复模型',fonts,[face]);assert r['missingCodepoints']==[] and len(r['codepoints'])>0
m.assert_cjk_coverage('中文',[{**fonts[0],'glyphCount':2.0}],[face])
for bad in [[],[{**fonts[0],'glyphCount':0}],[{**fonts[0],'glyphCount':'8'}],[{**fonts[0],'glyphCount':True}],[{**fonts[0],'glyphCount':float('inf')}],[{**fonts[0],'glyphCount':2.5}],[{**fonts[0],'isCustomFont':True}],[{**fonts[0],'postScriptName':'LastResort'}]]:reject(lambda:m.assert_cjk_coverage('中文',bad,[face]))
reject(lambda:m.assert_cjk_coverage('中文',fonts,[{**face,'charset':'20-7e'}]));reject(lambda:m.assert_cjk_coverage('ASCII only',fonts,[face]))
print(json.dumps({'cmapContract':True,'nativeOrLiveUI':False}))
`)})
test('真实节点字体证据不造DOM，缺CDP/错字形/截图缺失仍红',()=>{py(String.raw`
assert hasattr(m,'capture_cjk_sample') and hasattr(m,'validate_cjk_report')
class Session:
 def send(self,name,args=None):
  if name=='DOM.getDocument':return {'root':{'nodeId':1}}
  if name=='DOM.querySelector':return {'nodeId':2}
  if name=='CSS.getPlatformFontsForNode':return {'fonts':[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':2,'isCustomFont':False}]}
  return {}
 def detach(self):pass
class Context:
 def new_cdp_session(self,page):return Session()
class Locator:
 def evaluate(self,script):return {'text':'中文','selector':'html > body > p','visible':True,'fontFamily':'sans-serif'}
class Page:
 context=Context()
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'4e00-9fff'}
with tempfile.TemporaryDirectory() as d:
 png=pathlib.Path(d,'reply.png');png.write_bytes(bytes.fromhex('89504e470d0a1a0a')+b'isolated-not-a-real-screenshot')
 r=m.capture_cjk_sample(Page(),Locator(),'中文','reply',png,[face]);assert r['missingCodepoints']==[] and r['screenshotSha256']
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'其他','reply',png,[face]))
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'中文','reply',pathlib.Path(d,'absent.png'),[face]))
 proof={'required':True,'environment':{'beforeSha256':'b'*64,'afterSha256':'c'*64,'faces':[face]},'samples':[r,{**r,'label':'restarted','screenshot':'restarted.png'}]};m.validate_cjk_report(proof)
 for change in [lambda x:x['samples'].pop(),lambda x:x['samples'][0].update(missingCodepoints=['4e2d']),lambda x:x['samples'][0].update(platformFonts=[]),lambda x:x['samples'][0].update(screenshotSha256=''),lambda x:x['environment'].update(afterSha256='')]:
  bad=copy.deepcopy(proof);change(bad);reject(lambda:m.validate_cjk_report(bad))
print(json.dumps({'fixtureCDP':True,'realBrowser':False}))
`)})
test('workflow仅host私有字体记录，原Chromium/90min/210/42/8及fresh目录保持',()=>{
 const source=fs.readFileSync(path.join(root,'.github/workflows/hermes-qualification.yml'),'utf8'),linux=source.split('  linux-long-ui:')[1];assert.ok(linux)
 for(const text of ['prepare_private_fonts','--font-environment','playwright==1.58.0','timeout-minutes: 90','--hold 210'])assert.ok(linux.includes(text),text)
 assert.ok(!/sudo|apt-get[^\n]*(?:update|install)|fc-cache -f \/usr/.test(linux));assert.ok(linux.indexOf('test ! -e "$EVIDENCE"')<linux.indexOf('prepare_private_fonts'));assert.ok(!/mkdir[^\n]*browser-round/.test(linux))
 const s=fs.readFileSync(runner,'utf8');for(const t of ['AllowUnauthenticated=false','AllowInsecureRepositories=false','fontconfig-before.json','fontconfig-after.json'])assert.ok(s.includes(t),t);assert.ok(s.includes('CSS.getPlatformFontsForNode'));assert.ok(s.includes('capture_cjk_sample(page,'));assert.ok(!/document\.fonts\.check|add_style_tag|set_content\(/.test(s));assert.ok(s.includes('210 <= a.hold <= 3600'))
})
test('字体metadata经现有publishEvidence脱敏；字体本体排除且不预建UI fresh根',async()=>{
 const {publishEvidence}=await import('../scripts/test-hermes-windows-qualification.mjs');const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cjk-publish-'))),source=path.join(dir,'evidence'),output=path.join(dir,'public');fs.mkdirSync(source)
 try{fs.writeFileSync(path.join(source,'fontconfig-before.json'),JSON.stringify({apiKey:'CJK-PUBLISH-SECRET-123',fonts:[]}));fs.writeFileSync(path.join(source,'fontconfig-after.json'),JSON.stringify({fontSHA256:'a'.repeat(64),version:'fixture'}));fs.writeFileSync(path.join(source,'font.ttc'),'fixture font must not upload');assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 await publishEvidence({roots:{evidence:source},output});assert.ok(fs.existsSync(path.join(output,'evidence/fontconfig-after.json')));assert.equal(fs.existsSync(path.join(output,'evidence/font.ttc')),false);assert.ok(!fs.readFileSync(path.join(output,'evidence/fontconfig-before.json'),'utf8').includes('CJK-PUBLISH-SECRET-123'));assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('字体环境before/after独立证据；after只接受私有成员且缺工具/漂移均红',()=>{py(String.raw`
import hashlib
assert hasattr(m,'font_environment') and hasattr(m,'read_font_environment')
m.sys.platform='linux'
def command(args,**kwargs):
 if args[0]=='dpkg-query':return {'args':args,'exitCode':0,'stdout':'fontconfig\t2.15.0\n'}
 if args[0]=='fc-query':return {'args':args,'exitCode':0,'stdout':'2\tNoto Sans CJK SC\tNotoSansCJKsc-Regular\t20-7e 4e00-9fff\n'}
 return {'args':args,'exitCode':0,'stdout':'fixture-only'}
m.font_command=command
reject(lambda:m.font_environment('after'))
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();private=root/'private';private.mkdir();(private/'fonts').mkdir();(private/'cache').mkdir();(private/'download').mkdir()
 config=private/'fonts.conf';config.write_text('<fontconfig/>');deb=private/'download/font.deb';deb.write_bytes(b'inert fixture')
 fonts=[]
 for name in ['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']:
  f=private/'fonts'/name;f.write_bytes(name.encode());fonts.append({'file':str(f),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 proof={'root':str(private),'config':str(config),'configSha256':hashlib.sha256(config.read_bytes()).hexdigest(),'archive':str(deb),'archiveSha256':hashlib.sha256(deb.read_bytes()).hexdigest(),'archiveBytes':deb.stat().st_size,'fonts':fonts,'package':{'version':'fixture-only'}}
 before=m.font_environment('before');after=m.font_environment('after',proof);assert after['faces'] and before['phase']=='before' and after['phase']=='after'
 (root/'fontconfig-before.json').write_text(json.dumps(before));(root/'fontconfig-after.json').write_text(json.dumps(after));receipt=m.read_font_environment(root);assert receipt['beforeSha256'] and receipt['afterSha256'] and receipt['childEnv']['FONTCONFIG_FILE']==str(config);assert not (root/'browser-round1').exists()
 (root/'fontconfig-after.json').write_text(json.dumps({**after,'faces':[]}));reject(lambda:m.read_font_environment(root))
 m.font_command=lambda args,**kwargs:{'args':args,'exitCode':1,'stdout':''};reject(lambda:m.font_environment('after',proof));assert m.font_environment('before')['faces']==[]
print(json.dumps({'fontconfigCalls':'fixtures only','apt':False,'GUI':False}))
`)})

// 私有下载方案先列全部拒绝场景；不改变既有Linux禁提权断言。
test('受信Ubuntu索引与精确version/URI/size/SHA256必须同一下载契约',()=>{py(String.raw`
assert hasattr(m,'validate_font_download')
version='1:20230817+repack1-3'
meta='Package: fonts-noto-cjk\nVersion: '+version+'\nArchitecture: all\nFilename: pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817_all.deb\nSize: 123\nInstalled-Size: 400\nSHA256: '+'a'*64+'\n'
index='Identifier: Packages\nOrigin: Ubuntu\nLabel: Ubuntu\nTrusted: yes\nSite: http://archive.ubuntu.com/ubuntu\nFilename: /var/lib/apt/lists/fixture_Packages\n'
uri="'http://archive.ubuntu.com/ubuntu/pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817_all.deb' fonts-noto-cjk_20230817_all.deb 123 SHA256:"+'a'*64
p=m.validate_font_download(meta,index,uri,version);assert p['sha256']=='a'*64 and p['bytes']==123 and p['unpackedLimit']==409600
for bad in [meta.replace('Package: fonts-noto-cjk','Package: other'),meta.replace('Architecture: all','Architecture: amd64'),meta.replace(version,'2'),meta.replace('Size: 123','Size: 0'),meta.replace('Size: 123','Size: 999999999'),meta.replace('Installed-Size: 400','Installed-Size: 0'),meta.replace('SHA256: '+'a'*64,'SHA256: bad'),meta.replace('pool/main/','../'),meta+'Size: 123\n']:
 reject(lambda:m.validate_font_download(bad,index,uri,version))
for bad in [index.replace('Trusted: yes','Trusted: no'),index.replace('Origin: Ubuntu','Origin: Other'),index.replace('archive.ubuntu.com','attacker.invalid')]:reject(lambda:m.validate_font_download(meta,bad,uri,version))
for bad in [uri.replace('123 SHA256','124 SHA256'),uri.replace('a'*64,'b'*64),uri.replace('archive.ubuntu.com','attacker.invalid'),uri+'\n'+uri]:reject(lambda:m.validate_font_download(meta,index,bad,version))
print(json.dumps({'aptMetadata':'isolated only','aptExecuted':False}))
`)})
test('真实tar流只提取四个普通字体成员；遍历重复链接设备超额均红',()=>{py(String.raw`
import io,tarfile,hashlib
assert hasattr(m,'extract_private_font_tar')
names=['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']
def archive(extra=None):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w') as t:
  for name in names:
   raw=('isolated '+name).encode();i=tarfile.TarInfo('./usr/share/fonts/opentype/noto/'+name);i.size=len(raw);t.addfile(i,io.BytesIO(raw))
  i=tarfile.TarInfo('./usr/share/doc/fonts-noto-cjk/copyright');i.size=4;t.addfile(i,io.BytesIO(b'doc!'))
  if extra:
   i,raw=extra;t.addfile(i,io.BytesIO(raw))
 b.seek(0);return b
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);dest=root/'good';out=m.extract_private_font_tar(archive(),dest,409600);assert len(out['fonts'])==4 and len(list(dest.iterdir()))==4;assert not (root/'usr').exists()
 for n,kind in [('../escape.ttc',tarfile.REGTYPE),('./usr/share/fonts/opentype/noto/'+names[0],tarfile.REGTYPE),('./usr/share/fonts/opentype//noto/'+names[0],tarfile.REGTYPE),('./usr/share/fonts/opentype/noto/evil.ttc',tarfile.SYMTYPE),('./usr/share/fonts/opentype/noto/other.ttc',tarfile.REGTYPE),('./device',tarfile.CHRTYPE)]:
  i=tarfile.TarInfo(n);i.type=kind;i.linkname='/outside';i.size=0
  reject(lambda:m.extract_private_font_tar(archive((i,b'')),root/('bad'+str(len(list(root.iterdir())))),409600))
 reject(lambda:m.extract_private_font_tar(archive(),root/'over',2))
print(json.dumps({'realTarParser':True,'data':'inert fixtures','hostFontInstall':False}))
`)})
test('私有fontconfig路径与字节/归档漂移受检且只克隆子环境',()=>{py(String.raw`
import os,hashlib
assert hasattr(m,'private_font_environment') and hasattr(m,'verify_private_fonts')
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();(root/'fonts').mkdir();(root/'cache').mkdir();config=root/'fonts.conf';config.write_text('<fontconfig/>');(root/'download').mkdir();deb=root/'download/font.deb';deb.write_bytes(b'inert fixture')
 fonts=[]
 for name in ['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']:
  f=root/'fonts'/name;f.write_bytes(name.encode());fonts.append({'file':str(f),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 proof={'root':str(root),'config':str(config),'configSha256':hashlib.sha256(config.read_bytes()).hexdigest(),'archive':str(deb),'archiveSha256':hashlib.sha256(deb.read_bytes()).hexdigest(),'archiveBytes':deb.stat().st_size,'fonts':fonts}
 parent={'KEEP':'same','FONTCONFIG_FILE':'old','FONTCONFIG_SYSROOT':'/foreign'};before=dict(os.environ);child=m.private_font_environment(proof,parent);assert child['KEEP']=='same' and child['FONTCONFIG_FILE']==str(config) and 'FONTCONFIG_SYSROOT' not in child and parent=={'KEEP':'same','FONTCONFIG_FILE':'old','FONTCONFIG_SYSROOT':'/foreign'} and dict(os.environ)==before
 m.verify_private_fonts(proof)
 for k,v in [('configSha256','a'*64),('archiveSha256','a'*64),('archiveBytes',0),('config',str(root.parent/'fonts.conf'))]:
  reject(lambda:m.verify_private_fonts({**proof,k:v}))
 fonts[0]['sha256']='a'*64;reject(lambda:m.verify_private_fonts(proof))
print(json.dumps({'envMutation':False,'fontInstall':False}))
`)})

test('隔离准备E2E：真实私有文件/tar/收据到childenv，错误归档必须在解包前红',()=>{py(String.raw`
import io,tarfile,hashlib,os,xml.etree.ElementTree as ET
assert hasattr(m,'prepare_private_fonts')
m.sys.platform='linux';m.os.geteuid=lambda:1001
version='1:20230817+repack1-3';payload=b'inert deb fixture, no host install';sha=hashlib.sha256(payload).hexdigest();filename='fonts-noto-cjk_20230817_all.deb'
meta='Package: fonts-noto-cjk\nVersion: '+version+'\nArchitecture: all\nFilename: pool/main/f/fonts-noto-cjk/'+filename+'\nSize: '+str(len(payload))+'\nInstalled-Size: 400\nSHA256: '+sha+'\n'
index='Identifier: Packages\nOrigin: Ubuntu\nLabel: Ubuntu\nTrusted: yes\nSite: http://archive.ubuntu.com/ubuntu\nFilename: /var/lib/apt/lists/fixture_Packages\n'
uri="'http://archive.ubuntu.com/ubuntu/pool/main/f/fonts-noto-cjk/"+filename+"' "+filename+' '+str(len(payload))+' SHA256:'+sha
stream=io.BytesIO()
with tarfile.open(fileobj=stream,mode='w') as t:
 for name in sorted(m.FONT_NAMES):
  value=('inert '+name).encode();i=tarfile.TarInfo('./usr/share/fonts/opentype/noto/'+name);i.size=len(value);t.addfile(i,io.BytesIO(value))
 i=tarfile.TarInfo('./etc/fonts/conf.d/70-fonts-noto-cjk.conf');i.type=tarfile.SYMTYPE;i.linkname='/must-not-extract';t.addfile(i)
raw=stream.getvalue();calls=[];tamper=False;processes=[];parent=dict(os.environ)
def command(args,**kwargs):
 calls.append((args,kwargs));stdout='fixture'
 if args[:2]==['apt-cache','policy']:stdout='  Candidate: '+version+'\n'
 elif args[:2]==['apt-cache','show']:stdout=meta
 elif args[:2]==['apt-get','indextargets']:stdout=index
 elif args[0]=='apt-get' and '--print-uris' in args:stdout=uri
 elif args[0]=='apt-get':
  assert 'download' in args and 'install' not in args and 'update' not in args and args[-1]=='fonts-noto-cjk='+version
  pathlib.Path(kwargs['cwd'],filename).write_bytes(payload+(b'bad' if tamper else b''))
 elif args[:2]==['dpkg-deb','--field']:stdout=meta
 elif args[0]=='dpkg-query':stdout='fontconfig\t2.15.0\n'
 elif args[0]=='fc-query':stdout='2\tNoto Sans CJK SC\tNotoSansCJKsc-Regular\t4e00-9fff\n'
 if args[0] in ('fc-cache','fc-query'):
  env=kwargs['env'];assert env['FONTCONFIG_FILE'].endswith('fonts.conf') and '/usr/share/fonts' not in env['XDG_CACHE_HOME']
 return {'args':args,'exitCode':0,'stdout':stdout,'error':''}
def extract(deb,destination,limit):
 processes.append(str(deb));assert pathlib.Path(deb).read_bytes()==payload
 return m.extract_private_font_tar(io.BytesIO(raw),destination,limit)
m.font_command=command;m.extract_private_font_process=extract
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();out=root/'evidence';out.mkdir();private=root/'private';m.prepare_private_fonts(out,private)
 r=json.loads((out/'fontconfig-after.json').read_text());assert r['private']['archiveSha256']==sha and len(r['private']['fonts'])==4;env=m.read_font_environment(out)['childEnv'];assert env['FONTCONFIG_FILE']==str(private/'fonts.conf')
 tree=ET.fromstring((private/'fonts.conf').read_text());assert [e.text for e in tree.findall('cachedir')]==[str(private/'cache')] and [e.text for e in tree.findall('dir')]==[str(private/'fonts')] and not tree.findall('include');assert not (private/'etc').exists() and not (out/'browser-round1').exists();assert dict(os.environ)==parent
 reject(lambda:m.prepare_private_fonts(out,private))
 # 同一实际准备入口的mirror成功/下载中漂移；只有外部APT/系统文件是明确隔离依赖。
 mirror_text='http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n'
 mirror_proof={'path':'/etc/apt/apt-mirrors.txt','sha256':hashlib.sha256(mirror_text.encode()).hexdigest(),'bytes':len(mirror_text),'content':mirror_text,'mirrors':m.parse_official_font_mirrors(mirror_text)}
 base='http://archive.ubuntu.com/ubuntu';wrapper='mirror+file:/etc/apt/apt-mirrors.txt'
 meta+='Origin: Ubuntu\n';index=index.replace(base,wrapper)+'Component: main\nSourcesentry: /etc/apt/sources.list.d/ubuntu.sources:1\n';uri=uri.replace(base,wrapper)
 mirror_reads=[]
 def fixed_mirror():mirror_reads.append(True);return copy.deepcopy(mirror_proof)
 m.read_fixed_apt_mirror=fixed_mirror;mirror_out=root/'mirror-evidence';mirror_out.mkdir();m.prepare_private_fonts(mirror_out,root/'mirror-private')
 stored=json.loads((mirror_out/'font-package.json').read_text());assert len(mirror_reads)==2 and stored['proof']['package']['mirrorSource']==stored['proof']['package']['mirrorSourceAfter']==mirror_proof
 mirror_reads.clear()
 def changed_mirror():mirror_reads.append(True);return {**mirror_proof,'sha256':mirror_proof['sha256'] if len(mirror_reads)==1 else 'f'*64}
 m.read_fixed_apt_mirror=changed_mirror;changed_out=root/'changed-evidence';changed_out.mkdir();count=len(processes);reject(lambda:m.prepare_private_fonts(changed_out,root/'changed-private'));assert len(processes)==count and not (changed_out/'fontconfig-after.json').exists()
 # 归档篡改原断言继续：先恢复相同mirror，再测试归档SHA失败。
 m.read_fixed_apt_mirror=fixed_mirror
 tamper=True;out2=root/'evidence2';out2.mkdir();before=len(processes);reject(lambda:m.prepare_private_fonts(out2,root/'bad-private'));assert len(processes)==before and not (out2/'fontconfig-after.json').exists()
print(json.dumps({'isolatedPreparationE2E':True,'actualAPT':False,'actualFontOrGUIInstall':False}))
`)})

// Linux真实自有进程：初始红灯执行原with块，不运行apt/dpkg；外部16.5秒watchdog仅防探针挂死。
const OWN_CHILD_PROBE = String.raw`
import ast,ctypes,io,os,signal,subprocess,sys,tarfile,threading,time

def run_case(kind):
 assert sys.platform=='linux'
 assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0 # 仅探针做subreaper，收回自己孤儿fixture。
 raw=io.BytesIO()
 with tarfile.open(fileobj=raw,mode='w') as tar:
  for name in sorted(m.FONT_NAMES):
   value=('inert '+name).encode();item=tarfile.TarInfo('./usr/share/fonts/opentype/noto/'+name);item.size=len(value);tar.addfile(item,io.BytesIO(value))
 payload=raw.getvalue();real_popen=subprocess.Popen;children=[];watchdog=[];timers=[]
 sentinel=real_popen([sys.executable,'-c','import time;time.sleep(60)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 with tempfile.TemporaryDirectory() as directory:
  root=pathlib.Path(directory);pidfile=root/'identity.json';deb=root/'inert.deb';deb.write_bytes(b'fixture not a package')
  source="""import json,os,subprocess,sys,time
kind,pidfile,datafile=sys.argv[1:]
record={'pid':os.getpid(),'pgid':os.getpgrp()}
if kind=='mid-stream':
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
 record['descendant']=child.pid
open(pidfile,'w').write(json.dumps(record))
if kind in ('mid-stream','normal','wait-stall'):
 data=open(datafile,'rb').read()
 os.write(1,data[:516] if kind=='mid-stream' else data)
if kind=='mid-stream':sys.exit(0)
if kind=='normal':sys.exit(0)
if kind=='wait-stall':os.close(1)
time.sleep(60)
"""
  datafile=root/'inert.tar';datafile.write_bytes(payload)
  def spawn(args,**kwargs):
   assert args[:2]==['dpkg-deb','--fsys-tarfile']
   isolated=kwargs.get('start_new_session') is True
   # 初始旧代码没有session，仅探针加保护，产品缺失仍由最终断言留红。
   child=real_popen([sys.executable,'-u','-c',source,kind,str(pidfile),str(datafile)],**{**kwargs,'start_new_session':True})
   children.append((child,isolated))
   def emergency():
    watchdog.append(True)
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
   timer=threading.Timer(16.5,emergency);timer.daemon=True;timer.start();timers.append(timer)
   return child
  subprocess.Popen=spawn
  error=None;result=None;started=time.monotonic()
  try:
   if hasattr(m,'extract_private_font_process'):
    result=m.extract_private_font_process(deb,root/'fonts',409600)
   else:
    # 原代码实际同步read+wait块直接执行，保留first-red而不是仅测函数缺失。
    tree=ast.parse(pathlib.Path(m.__file__).read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='prepare_private_fonts')
    block=next(n for n in fn.body if isinstance(n,ast.With) and 'subprocess.Popen' in ast.unparse(n))
    namespace={**m.__dict__,'deb':deb,'root':root,'package':{'unpackedLimit':409600}}
    exec(compile(ast.Module(body=[block],type_ignores=[]),m.__file__,'exec'),namespace);result=namespace['extracted']
  except Exception as caught:error=caught
  finally:
   elapsed=time.monotonic()-started;subprocess.Popen=real_popen
   for timer in timers:timer.cancel()
   identities=json.loads(pidfile.read_text()) if pidfile.exists() else {}
   direct_reaped=False
   if children:
    child=children[0][0]
    try:os.waitpid(child.pid,os.WNOHANG)
    except ChildProcessError:direct_reaped=True
    descendant=identities.get('descendant');descendant_stopped=not descendant
    if descendant:
     limit=time.monotonic()+.1
     while time.monotonic()<limit:
      stat=pathlib.Path('/proc')/str(descendant)/'stat'
      if not stat.exists() or stat.read_text().split(') ',1)[1][0]=='Z':descendant_stopped=True;break
      time.sleep(.005)
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    child.wait(timeout=1)
   descendant=identities.get('descendant');descendant_reaped=not descendant
   if descendant:
    until=time.monotonic()+1
    while time.monotonic()<until:
     try:
      if os.waitpid(descendant,os.WNOHANG)[0]==descendant:descendant_reaped=True;break
     except ChildProcessError:descendant_reaped=True;break
     time.sleep(.005)
   sentinel_untouched=sentinel.poll() is None;os.killpg(sentinel.pid,signal.SIGKILL);sentinel.wait(timeout=1)
   report={'case':kind,'elapsedSeconds':elapsed,'errorType':type(error).__name__ if error else None,'error':str(error),'watchdogUsed':bool(watchdog),'productionNewSession':bool(children and children[0][1]),'directReapedBeforeProbeCleanup':direct_reaped,'descendantStoppedBeforeProbeCleanup':descendant_stopped,'descendantReapedByProbeSubreaper':descendant_reaped,'unrelatedSentinelUntouched':sentinel_untouched,'identities':identities,'aptOrFontInstallOrGUI':False}
   print(json.dumps(report),flush=True)
  assert elapsed<15.3 and not watchdog, '原15秒总deadline未覆盖读/等候'
  assert children and children[0][1] and direct_reaped and descendant_stopped and descendant_reaped and sentinel_untouched, '自有进程组清理/回收失败'
  if kind=='normal':assert error is None and len(result['fonts'])==4
  else:assert isinstance(error,TimeoutError), '停滞必须明确deadline失败，不能靠tar错误补绿'
`

test('解包接线必须整段15秒期限+非阻塞pipe+自有进程组，无无界context wait',()=>{
 const source=fs.readFileSync(runner,'utf8');assert.ok(source.includes('def extract_private_font_process('));assert.ok(source.includes('start_new_session=True'));assert.ok(source.includes('os.killpg('));assert.ok(source.includes('selectors.DefaultSelector'));assert.ok(source.includes('extract_private_font_process(deb,'));assert.ok(!/with subprocess\.Popen\(/.test(source))
})
if(process.platform==='linux')for(const kind of ['first-byte','mid-stream','wait-stall','normal'])test('真实自有Linux解包进程E2E '+kind,()=>{py(OWN_CHILD_PROBE+`
run_case(${JSON.stringify(kind)})
`)})

// R25真实APT原件的metadata/单个匹配index/URI；原JSON SHA256固定，非下载成功或VM证明。
const ACTUAL_R25_APT = {
  "version": "1:20230817+repack1-3",
  "metadata": "Package: fonts-noto-cjk\nArchitecture: all\nVersion: 1:20230817+repack1-3\nMulti-Arch: foreign\nPriority: optional\nSection: fonts\nOrigin: Ubuntu\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nOriginal-Maintainer: Debian Fonts Team <debian-fonts@lists.debian.org>\nBugs: https://bugs.launchpad.net/ubuntu/+filebug\nInstalled-Size: 90994\nSuggests: fonts-noto-cjk-extra\nFilename: pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817+repack1-3_all.deb\nSize: 61229778\nMD5sum: 6d2b2c3dc717b8f8a1db0df79b34e628\nSHA1: 8bdbac876dd4314c90f1e2dcf92b299a0318ada4\nSHA256: 7d64b985f6fe128c99eae5610d5c047338e572bdcfb2bb09736be01b824a7f6c\nSHA512: 5c9e5d817477e8f858bfd06469e2eb86c5c62a562a9593732bd8578378720cd1b0cd4146333a21aa86546a374660e88276420e1f8ba965f33dd6dd5d6bda0941\nHomepage: https://github.com/notofonts/noto-cjk\nDescription-en: \"No Tofu\" font families with large Unicode coverage (CJK regular and bold)\n Noto is a collection of font families, each visually harmonized across\n scripts.\n .\n This package contains Noto font families for Traditional Chinese,\n Simplified Chinese, Japanese and Korean:\n .\n  * Noto Sans CJK JP\n  * Noto Sans CJK KR\n  * Noto Sans CJK SC\n  * Noto Sans CJK TC\n  * Noto Sans Mono CJK JP\n  * Noto Sans Mono CJK KR\n  * Noto Sans Mono CJK SC\n  * Noto Sans Mono CJK TC\n  * Noto Serif CJK JP\n  * Noto Serif CJK KR\n  * Noto Serif CJK SC\n  * Noto Serif CJK TC\n .\n These fonts are derived from the font family Source Han Sans.\n .\n The name \"Noto\" is short for \"No Tofu\", describing the aim of covering\n all living Unicode scripts.\n .\n Tofu (豆腐) is Japanese jargon for unicode replacement character \"�\"\n (U+FFFD) often displayed as replacement for unassigned or unknown\n characters.\n .\n This package contains regular and bold fonts.\nDescription-md5: 0ca861bf5dc90003c5a480427ee7d985\nTask: ubuntu-desktop-minimal, ubuntu-desktop, ubuntu-desktop-raspi, kubuntu-desktop, xubuntu-minimal, xubuntu-desktop, lubuntu-desktop, ubuntustudio-desktop-core, ubuntustudio-desktop, ubuntukylin-desktop, ubuntukylin-desktop-minimal, ubuntu-mate-core, ubuntu-mate-desktop, ubuntu-budgie-desktop-minimal, ubuntu-budgie-desktop, ubuntu-budgie-desktop-raspi, ubuntu-unity-desktop, edubuntu-desktop-gnome-minimal, edubuntu-desktop-gnome-raspi, ubuntucinnamon-desktop-minimal, ubuntucinnamon-desktop-raspi\n\n",
  "indexes": "MetaKey: main/binary-amd64/Packages\nShortDesc: Packages\nDescription: mirror+file:/etc/apt/apt-mirrors.txt noble/main amd64 Packages\nURI: mirror+file:/etc/apt/apt-mirrors.txt/dists/noble/main/binary-amd64/Packages\nFilename: /var/lib/apt/lists/_etc_apt_apt-mirrors.txt_dists_noble_main_binary-amd64_Packages\nOptional: no\nKeepCompressed: no\nCodename: noble\nLabel: Ubuntu\nOrigin: Ubuntu\nSuite: noble\nTrusted: yes\nVersion: 24.04\nArchitecture: amd64\nBase-URI: mirror+file:/etc/apt/apt-mirrors.txt/dists/noble/\nBy-Hash: yes\nComponent: main\nCompressionTypes: xz bz2 lzma gz lz4 zst uncompressed\nCreated-By: Packages\nDefaultEnabled: yes\nFallback-Of: \nIdentifier: Packages\nKeepCompressedAs: lz4 zst gz xz bz2 lzma uncompressed\nPDiffs: yes\nRelease: noble\nRepo-URI: mirror+file:/etc/apt/apt-mirrors.txt/\nSite: mirror+file:/etc/apt/apt-mirrors.txt\nSourcesentry: /etc/apt/sources.list.d/ubuntu.sources:1\nTarget-Of: deb\n",
  "uris": "'mirror+file:/etc/apt/apt-mirrors.txt/pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817%2brepack1-3_all.deb' fonts-noto-cjk_1%3a20230817+repack1-3_all.deb 61229778 SHA256:7d64b985f6fe128c99eae5610d5c047338e572bdcfb2bb09736be01b824a7f6c\n",
  "rawReceiptSha256": "53319149a82d6fbefa294b5f40ebe13d42af94a1d2fad6710da855f93b70acef"
}

test('R25真实mirror+file下载前误拒：固定系统列表、signed index及原SHA不可放宽',()=>{py(String.raw`
actual=json.loads(${JSON.stringify(JSON.stringify(ACTUAL_R25_APT))})
mirrorText=${JSON.stringify('http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n')}
# 仅隔离本机不存在的root-owned GHA文件；生产默认读取固定系统路径，绝非VM通过。
m.read_fixed_apt_mirror=lambda:{'path':'/etc/apt/apt-mirrors.txt','sha256':'b'*64,'content':mirrorText,'mirrors':m.parse_official_font_mirrors(mirrorText)}
p=m.validate_font_download(actual['metadata'],actual['indexes'],actual['uris'],actual['version'])
assert p['sourceURL'].startswith('mirror+file:/etc/apt/apt-mirrors.txt/pool/') and p['sha256']=='7d64b985f6fe128c99eae5610d5c047338e572bdcfb2bb09736be01b824a7f6c' and p['bytes']==61229778 and p['mirrorSource']['path']=='/etc/apt/apt-mirrors.txt'
for before,after in [('mirror+file:','file:'),('mirror+file:','mirror+http:'),('/etc/apt/apt-mirrors.txt','/tmp/apt-mirrors.txt'),('/etc/apt/apt-mirrors.txt','/etc/apt/../apt/apt-mirrors.txt'),('mirror+file:','mirror+file://attacker.invalid'),("_all.deb'","_all.deb?x=1'"),("_all.deb'","_all.deb#x'")]:
 bad=actual['uris'].replace(before,after);reject(lambda:m.validate_font_download(actual['metadata'],actual['indexes'],bad,actual['version']))
for bad in [actual['indexes'].replace('Trusted: yes','Trusted: no'),actual['indexes'].replace('Origin: Ubuntu','Origin: other'),actual['indexes'].replace('/etc/apt/sources.list.d/ubuntu.sources:1','/tmp/sources:1'),actual['indexes'].replace('Site: mirror+file:','Site: file:')]:reject(lambda:m.validate_font_download(actual['metadata'],bad,actual['uris'],actual['version']))
print(json.dumps({'actualRawURIRegression':True,'realVMDownload':False}))
`)})
test('固定mirrorfile只接官方端点，root/普通文件/权限/单链接/有界内容逐项拒绝',()=>{py(String.raw`
import stat,types
text=${JSON.stringify('http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n')}
assert len(m.parse_official_font_mirrors(text))==3
for bad in ['file:/tmp/mirror\n','mirror+file:/etc/apt/other\n','https://attacker.invalid/ubuntu/\n','https://archive.ubuntu.com/ubuntu/?a=b\n',text+'https://archive.ubuntu.com/ubuntu/\tpriority:2\n',text.replace('priority:1','priority:99'),'# no endpoints\n','x'*4097]:reject(lambda:m.parse_official_font_mirrors(bad))
good=types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o644,st_nlink=1,st_size=200)
m.check_fixed_mirror_stat(good)
for key,value in [('st_uid',1000),('st_mode',stat.S_IFLNK|0o644),('st_mode',stat.S_IFIFO|0o644),('st_mode',stat.S_IFREG|0o664),('st_mode',stat.S_IFREG|0o646),('st_nlink',2),('st_size',4097),('st_size',0)]:
 bad=copy.copy(good);setattr(bad,key,value);reject(lambda:m.check_fixed_mirror_stat(bad))
print(json.dumps({'rootFileFacts':'isolated stat fixtures','hostFileReadOrWrite':False}))
`)})
test('mirror分支实际准备调用必须前后固定路径回读，原tar/15秒/非root门禁保持',()=>{
 const s=fs.readFileSync(runner,'utf8');assert.ok(s.includes('def read_fixed_apt_mirror():'));assert.ok(s.includes("Path('/etc/apt/apt-mirrors.txt')"));assert.ok(s.includes('O_NOFOLLOW'));assert.ok(s.includes("package['mirrorSource']"));assert.ok(s.includes('mirrorSourceAfter'));assert.ok(s.includes('extract_private_font_process(deb,'));assert.ok(s.includes('read_deadline = deadline - 0.25'));assert.ok(s.includes('APT::Get::AllowUnauthenticated=false'));assert.ok(s.includes('os.geteuid() != 0'))
})
