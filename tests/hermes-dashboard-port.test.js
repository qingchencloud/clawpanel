import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = process.env.HERMES_DASHBOARD_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url))
const evidence = process.env.HERMES_DASHBOARD_TEST_EVIDENCE
const web = () => fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
const rust = () => fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8')
const listen = s => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(s.address().port)) })
const close = s => new Promise(resolve => { s.closeAllConnections?.(); s.close(() => resolve()) })
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('Rust Dashboard start/probe只认配置端口TCP，显式port且保留no-open/90秒/本机边界', () => {
  const source = rust(), start = source.match(/pub async fn hermes_dashboard_start\([^]*?\n\}/)?.[0], probe = source.match(/pub async fn hermes_dashboard_probe\([^]*?\n\}/)?.[0]
  assert.ok(start); assert.ok(probe)
  assert.match(start, /cmd\.args\(\["dashboard", "--no-open", "--port", &port\.to_string\(\)\]\)/)
  assert.doesNotMatch(start, /\|\|\s*hermes_dashboard_cli_status/)
  assert.match(start, /if hermes_dashboard_tcp_running\(port, 500\)/)
  assert.match(start, /Duration::from_secs\(90\)/)
  assert.match(probe, /let running = tokio::task::spawn_blocking\([^]*?hermes_dashboard_tcp_running\(port, 800\)/)
  assert.doesNotMatch(probe, /cli_status[^;]*\|\||running\s*\|\|/)
  assert.match(source.match(/fn hermes_dashboard_tcp_running\([^]*?\n\}/)?.[0] || '', /127\.0\.0\.1:\{port\}/)
  if (fs.existsSync(path.join(root, 'scripts/hermes-pm-runtime.js'))) {
    assert.match(start, /let mut cmd = hermes_command\(\)\?/)
    assert.match(web().match(/  async hermes_dashboard_start\(\) \{[^]*?\n  \},/)?.[0] || '', /spawnHermes\(\['dashboard', '--no-open', '--port', String\(port\)\]/)
  }
})

test('Dashboard配置端口保留默认与Rust u16边界，JS不接受65536', () => {
  const method = web().match(/  _hermesDashboardPort\(\) \{[^]*?\n  \},/)?.[0]
  assert.ok(method)
  for (const [port, expected] of [[65535, 65535], [65536, 9119], [0, 9119], [-1, 9119]]) {
    const handlers = new Function('fs', 'path', 'hermesHome', `return {${method}}`)({ existsSync: () => true, readFileSync: () => `gateway:\n  port: 9999\ndashboard:\n  port: ${port}\n` }, path, () => 'fixture')
    assert.equal(handlers._hermesDashboardPort(), expected)
  }
  assert.match(rust().match(/fn hermes_dashboard_port\(\)[^]*?\n\}/)?.[0] || '', /parse::<u16>\(\)/)
})

for (const mode of ['normal', 'foreign-positive', 'already-online', 'early-exit']) {
  test(`真实HTTP Dashboard启动/argv与实例边界：${mode}`, { timeout: 30000 }, async t => {
    const base = fs.realpathSync.native(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-dashboard-port-'))
    const home = path.join(dir, 'h'), hermesHome = path.join(home, '.hermes'), bin = path.join(hermesHome, 'bin'), cliLog = path.join(dir, 'cli.jsonl')
    const nonce = path.basename(dir), observations = [], cleanup = []
    let panel, foreign, configured, stdout = '', stderr = ''
    const readCli = () => fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
    t.after(async () => {
      // 只清本fixture自己实际记录的PID，不调用会扫描其他HOME的全局dashboard --stop。
      for (const record of readCli().filter(e => e.event === 'launch' && e.nonce === nonce)) {
        if (alive(record.pid)) { try { process.kill(record.pid) } catch {} }
        for (let n = 0; n < 40 && alive(record.pid); n++) await pause(50)
        cleanup.push({ pid: record.pid, alive: alive(record.pid), nonce: record.nonce })
      }
      if (panel && panel.exitCode === null) { const closed = new Promise(resolve => panel.once('close', resolve)); panel.kill(); await closed }
      if (configured) await close(configured)
      let foreignFinal
      if (foreign) {
        foreignFinal = await (await fetch(`http://127.0.0.1:${foreign.address().port}`, { signal: AbortSignal.timeout(2000) })).text()
        observations.push({ phase: 'cleanup-before-close', foreignFinal })
        await close(foreign)
      }
      if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, mode + '.json'), JSON.stringify({ scope: 'production HTTP / bounded CLI fixture not real Hermes or native UI', root, mode, nonce, observations, cli: readCli(), cleanup, stdout, stderr }, null, 2)) }
      assert.ok(cleanup.every(p => !p.alive), JSON.stringify(cleanup))
      assert.equal(foreignFinal, 'foreign-' + nonce, '退出清理前foreign listener必须仍在线且响应未变')
      assert.equal(path.dirname(fs.realpathSync.native(dir)), base)
      fs.rmSync(dir, { recursive: true, force: true })
    })
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true })
    foreign = http.createServer((_q, r) => r.end('foreign-' + nonce)); const foreignPort = await listen(foreign)
    configured = http.createServer((_q, r) => r.end('existing-' + nonce)); const configuredPort = await listen(configured)
    if (mode !== 'already-online') { await close(configured); configured = null }
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), `gateway:\n  port: ${foreignPort}\ndashboard:\n  port: ${configuredPort}\n`)
    fs.writeFileSync(path.join(home, '.openclaw/clawpanel.json'), JSON.stringify({ ignoreRisk: true, engineMode: 'hermes', enabledEngines: ['hermes'] }))
    const preload = path.join(dir, 'cli-preload.mjs')
    fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const copied=/^hermes(?:\\.exe)?$/i.test(path.basename(process.execPath));
if(copied||path.basename(process.argv[1]||'')==='hermes'){
 const args=process.argv.slice(copied?1:2).map((v,i)=>copied&&i===0?path.basename(v):v);
 const record=event=>fs.appendFileSync(${JSON.stringify(cliLog)},JSON.stringify({event,args,pid:process.pid,home:process.env.HERMES_HOME,nonce:${JSON.stringify(nonce)}})+'\\n');
 if(args[0]!=='dashboard'){process.exit(72)}
 if(args.includes('--status')||args.includes('status')){record('status');console.log(${JSON.stringify(mode === 'foreign-positive' ? `1 hermes dashboard/serve process(es) running:\nPID 999999 --port ${foreignPort} other-HOME` : 'No hermes dashboard or serve processes running.')});process.exit(0)}
 record('launch');
 if(args.includes('--stop')||args.includes('stop')){console.error('fixture forbids global stop');process.exit(73)}
 if(!args.includes('--no-open')||args[args.indexOf('--port')+1]!==${JSON.stringify(String(configuredPort))}||!args.includes('--port')){console.error('configured explicit --port missing');process.exit(78)}
 if(${JSON.stringify(mode)}==='early-exit'){console.error('fixture-original-dashboard-error');process.exit(7)}
 const s=http.createServer((_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,port:${configuredPort},home:process.env.HERMES_HOME}))});
 s.listen(${configuredPort},'127.0.0.1',()=>record('listening'));
 setTimeout(()=>{s.closeAllConnections();s.close(()=>process.exit(0))},15000).unref();
 await new Promise(()=>{});
}`)
    if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(bin, 'hermes.exe'))
    else { const cli = path.join(bin, 'hermes'); fs.writeFileSync(cli, '#!' + process.execPath + '\n' + fs.readFileSync(preload, 'utf8')); fs.chmodSync(cli, 0o755) }
    const server = path.join(dir, 'panel.mjs')
    fs.writeFileSync(server, `import http from 'node:http';import {_initApi,_apiMiddleware} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/dev-api.js')).href)};_initApi();const s=http.createServer((q,r)=>{Promise.resolve(_apiMiddleware(q,r,()=>{r.statusCode=404;r.end()})).catch(e=>{r.statusCode=500;r.end(JSON.stringify({error:String(e)}))})});s.listen(0,'127.0.0.1',()=>console.log('READY '+s.address().port))`)
    const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: hermesHome, OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'), NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, PATH: bin + path.delimiter + process.env.PATH }
    panel = spawn(process.execPath, [server], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const panelPort = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('panel startup timeout: ' + stderr)), 10000); panel.once('error', reject); panel.once('exit', code => { clearTimeout(timer); reject(Error('panel exited ' + code + ': ' + stderr)) }); panel.stdout.on('data', b => { stdout += b; const m = stdout.match(/READY (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } }); panel.stderr.on('data', b => { stderr += b }) })
    const foreignUrl = `http://127.0.0.1:${foreignPort}`, before = await (await fetch(foreignUrl, { signal: AbortSignal.timeout(2000) })).text()
    const response = await fetch(`http://127.0.0.1:${panelPort}/__api/hermes_dashboard_start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(12000) })
    const result = await response.json(); observations.push({ configuredPort, foreignPort, status: response.status, result })
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.port, configuredPort)
    if (mode === 'early-exit') { assert.equal(result.started, false); assert.equal(result.exit_code, 7); assert.match(result.log_tail, /fixture-original-dashboard-error/) }
    else {
      assert.equal(result.started, true, JSON.stringify(result)); assert.equal(result.already_running, mode === 'already-online', 'global CLI positive must not stand in for configured TCP')
      if (mode === 'already-online') assert.equal(readCli().filter(e => e.event === 'launch').length, 0)
      else {
        const actual = await (await fetch(`http://127.0.0.1:${configuredPort}`, { signal: AbortSignal.timeout(2000) })).json(); observations.push({ actual })
        assert.equal(actual.nonce, nonce); assert.equal(actual.port, configuredPort); assert.equal(actual.home, hermesHome)
        const launches = readCli().filter(e => e.event === 'launch'); assert.equal(launches.length, 1); assert.deepEqual(launches[0].args, ['dashboard', '--no-open', '--port', String(configuredPort)])
      }
    }
    const after = await (await fetch(foreignUrl, { signal: AbortSignal.timeout(2000) })).text()
    observations.push({ foreignBefore: before, foreignAfter: after }); assert.equal(after, before); assert.equal(before, 'foreign-' + nonce)
    assert.ok(readCli().every(e => !e.args.includes('--stop') && !e.args.includes('stop')), '不得全局停止其他HOME')
    assert.match(web().match(/  async hermes_dashboard_start\(\) \{[^]*?\n  \},/)?.[0] || '', /Date\.now\(\) \+ 90000/)
  })
}
