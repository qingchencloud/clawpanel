import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
test('Pi 引擎、工作台、统一模型渠道和双后端注册完整', () => {
  assert.match(read('src/main.js'), /registerEngine\(piEngine\)/)
  assert.match(read('src/pages/engine-select.js'), /activeEngineId: 'pi'/)
  assert.match(read('src/engines/pi/index.js'), /\/pi\/workspace/)
  assert.match(read('src/lib/tauri-api.js'), /piSyncProvider:/)
  assert.match(read('scripts/dev-api.js'), /'pi_call'/)
  assert.match(read('scripts/dev-api.js'), /pi_call\(/)
  assert.match(read('src-tauri/src/lib.rs'), /pi::pi_call/)
  assert.match(read('src/pages/model-channels.js'), /syncChannelToPi\(/)
  assert.match(read('src/locales/index.js'), /modelChannels, deepseekHarness, openCode, pi/)
  assert.doesNotMatch(read('src/engines/pi/pages/workspace.js'), /fetch\(|invoke\(|ws-client|iframe/)
  assert.match(read('.github/workflows/ci.yml'), /node scripts\/test-pi-runtime\.mjs/)
  assert.match(read('.github/workflows/release.yml'), /node scripts\/test-pi-runtime\.mjs/)
})

test('桌面嵌入桥与 Web 共用源码，可启动、拒绝无认证请求并随父管道关闭退出', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-pi-bridge-test-'))
  const strip = source => source.replace(/^import .*from '\.\/pi-[^']+'\r?\n/gm, '')
  const source = ['scripts/pi-models.js', 'scripts/pi-rpc.js', 'scripts/pi-permission.js', 'scripts/pi-runtime.js', 'scripts/pi-bridge.js'].map(file => strip(read(file))).join('\n') + '\nawait startPiBridge();\n'
  const file = path.join(root, 'bridge.mjs')
  fs.writeFileSync(file, source)
  const token = 'fixture-bridge-token-not-a-secret'
  const child = spawn(process.execPath, [file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAWPANEL_PI_ROOT: root, CLAWPANEL_PI_TOKEN: token } })
  try {
    const exit = once(child, 'exit')
    let diagnostics = ''
    child.stderr.on('data', chunk => { diagnostics += chunk.toString() })
    const ready = await Promise.race([once(child.stdout, 'data').then(([data]) => JSON.parse(data.toString())), exit.then(() => { throw new Error(diagnostics) })])
    const endpoint = `http://127.0.0.1:${ready.port}/call`
    const denied = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ command: 'status' }) })
    assert.equal(denied.status, 401)
    const allowed = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ command: 'status' }) })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).result.installed, false)
    child.stdin.end()
    const [code] = await exit
    assert.equal(code, 0)
  } finally {
    if (child.exitCode == null) child.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
