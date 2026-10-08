import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

// 只创建并清理本脚本的临时容器，不接触现有容器或真实账号配置。
const image = process.argv[2]
if (!image) throw new Error('需要待验证的镜像名称')
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const policy = JSON.parse(fs.readFileSync(new URL('../openclaw-version-policy.json', import.meta.url), 'utf8'))
const run = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, windowsHide: true })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return result.stdout.trim()
}
const container = run(['run', '--detach', '--label', 'clawpanel.compatibility-fixture=true', '--publish', '127.0.0.1::1420', image])
assert.match(container, /^[a-f0-9]{64}$/)
const token = 'clawpanel-isolated-runtime-fixture-token'
try {
  run(['exec', container, 'node', '-e', "const fs=require('fs');fs.mkdirSync('/root/.openclaw',{recursive:true});fs.writeFileSync('/root/.openclaw/clawpanel.json',JSON.stringify({ignoreRisk:true}));"])
  const port = Number(run(['port', container, '1420/tcp']).split(':').at(-1))
  assert.ok(port > 0 && port <= 65535)
  const base = `http://127.0.0.1:${port}`
  let health
  for (let attempt = 0; attempt < 60; attempt++) {
    try { health = await (await fetch(`${base}/__api/health`, { signal: AbortSignal.timeout(3000) })).json(); break } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(health?.backendVersion, pkg.version)
  const version = run(['exec', container, 'openclaw', '--version'])
  assert.ok(version.includes(policy.default.official.recommended), version)
  const config = {
    agents: { ownership: 'explicit', entries: { main: { workspace: '/root/.openclaw/workspace' } } },
    gateway: { port: 18789, bind: 'loopback', mode: 'local', auth: { mode: 'token', token } },
    models: { providers: { fixture: { baseUrl: 'http://127.0.0.1:19974/v1', api: 'openai-completions', apiKey: 'not-a-real-secret', models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 131072, maxTokens: 8192 }] } } },
  }
  const api = async (command, args = {}) => {
    const response = await fetch(`${base}/__api/${command}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(120000) })
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  await api('write_openclaw_config', { config })
  const saved = await api('read_openclaw_config')
  assert.equal(saved.models.providers.fixture.models[0].contextWindow, 131072)
  run(['exec', container, 'openclaw', 'config', 'validate', '--json'])
  run(['exec', '--detach', container, 'openclaw', 'gateway', 'run'])
  const script = fileURLToPath(new URL('./smoke-openclaw-gateway-handshake.mjs', import.meta.url))
  let result
  for (let attempt = 0; attempt < 40; attempt++) {
    result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 35000,
      env: { ...process.env, OPENCLAW_SMOKE_URL: `ws://127.0.0.1:${port}/ws`, OPENCLAW_SMOKE_TOKEN: token },
    })
    if (result.status === 0) break
    assert.match(result.stderr, /UNAVAILABLE|ECONNREFUSED|ECONNRESET|连接|超时|未发送|not running|closed|Socket closed/i)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  assert.equal(result.status, 0, result.stderr)
  const handshake = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(handshake.protocol, 4)
  console.log(JSON.stringify({ panelVersion: pkg.version, openclawVersion: policy.default.official.recommended, health: true, configReadback: true, configValid: true, gatewayProtocol: handshake.protocol, dockerRuntime: true }))
} finally {
  run(['rm', '--force', container])
}
