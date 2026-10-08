import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import YAML from 'yaml'

test('共享 Hermes Gateway 不按进程名批量终止，桌面列表识别原生 served_profiles', () => {
  const web = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
  const desktop = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  const page = fs.readFileSync(new URL('../src/engines/hermes/pages/gateways.js', import.meta.url), 'utf8')
  assert.doesNotMatch(web, /\['\/F', '\/IM', 'hermes\.exe'\]/)
  assert.doesNotMatch(desktop, /\.args\(\["\/F", "\/IM", "hermes\.exe"\]\)/)
  assert.match(desktop, /read_live_hermes_multiplex_state/)
  assert.match(desktop, /hermes_multiplex_serves_profile/)
  assert.match(page, /g\.shared \? 'engine\.hermesGatewayShared'/)
})

test('Hermes Web 能力探测携带认证，启动/聊天保留 handler 方法绑定', async () => {
  const tempRoot = path.resolve(os.tmpdir())
  const home = fs.mkdtempSync(path.join(tempRoot, 'clawpanel-hermes-runtime-'))
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'HERMES_HOME'].map(key => [key, process.env[key]]))
  for (const key of Object.keys(previous)) process.env[key] = home
  const key = 'local-runtime-fixture-key-1234567890'
  let gateway, server
  try {
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true })
    fs.writeFileSync(path.join(home, '.openclaw', 'clawpanel.json'), JSON.stringify({ ignoreRisk: true }))
    fs.writeFileSync(path.join(home, '.env'), `API_SERVER_KEY=${key}\n`)
    gateway = http.createServer((req, res) => {
      const authenticated = req.headers.authorization === `Bearer ${key}`
      res.setHeader('content-type', 'application/json')
      if (!authenticated) { res.statusCode = 401; res.end('{"error":"missing authentication"}'); return }
      res.end(JSON.stringify(req.url === '/v1/runs' ? { run_id: 'fixture-run' } : { features: { run_status: true } }))
    })
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({ model: { default: 'fixture-model', provider: 'openrouter' }, platforms: { api_server: { enabled: false, host: '127.0.0.1', port: gateway.address().port, customOption: { preserved: true } } } }))
    const { _apiMiddleware } = await import('../scripts/dev-api.js')
    server = http.createServer((req, res) => _apiMiddleware(req, res, () => { res.statusCode = 404; res.end() }))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const api = async (command, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/__api/${command}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return result
    }
    assert.deepEqual(await api('hermes_capabilities'), { features: { run_status: true } })
    await api('hermes_gateway_action', { action: 'start' })
    assert.equal(YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).platforms.api_server.enabled, true)
    const saved = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).platforms.api_server
    assert.equal(saved.port, gateway.address().port)
    assert.equal(saved.host, '127.0.0.1')
    assert.deepEqual(saved.customOption, { preserved: true })
    assert.equal(await api('hermes_agent_run', { input: 'fixture input' }), 'fixture-run')
    // 环境端口不依赖 config.yaml，带引号的 dotenv 值同样可探测。
    fs.writeFileSync(path.join(home, '.env'), `API_SERVER_KEY=${key}\nAPI_SERVER_PORT='${gateway.address().port}'\n`)
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({ platforms: { api_server: { enabled: true } } }))
    assert.deepEqual(await api('hermes_capabilities'), { features: { run_status: true } })
    // 已启用服务也需要迁移旧端口别名；保留原字段以便回滚到旧面板。
    fs.writeFileSync(path.join(home, '.env'), `API_SERVER_KEY=${key}\n`)
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({ api_server_port: gateway.address().port, platforms: { api_server: { enabled: true, customOption: 'preserved' } } }))
    await api('hermes_gateway_action', { action: 'start' })
    const migrated = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'))
    assert.equal(migrated.api_server_port, gateway.address().port)
    assert.equal(migrated.platforms.api_server.port, gateway.address().port)
    assert.equal(migrated.platforms.api_server.customOption, 'preserved')
  } finally {
    for (const instance of [server, gateway].filter(Boolean)) {
      instance.closeAllConnections()
      await new Promise(resolve => instance.close(resolve))
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.equal(path.dirname(path.resolve(home)), tempRoot)
    assert.ok(path.basename(home).startsWith('clawpanel-hermes-runtime-'))
    fs.rmSync(home, { recursive: true, force: true })
  }
})
