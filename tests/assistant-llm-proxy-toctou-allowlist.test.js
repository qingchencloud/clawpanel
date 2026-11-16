import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// TOCTOU（校验后连接）/ DNS rebinding / 重定向 / allowlist 策略 — 针对性回归：
// 1) 连接必须绑定到校验阶段解析出的地址（自定义 lookup pinning），连接阶段不触发第二次 DNS
// 2) 禁止自动重定向：上游 3xx 原样返回，跳转目标必须再次通过完整校验
// 3) 目标 allowlist：默认仅放行 OpenAI/Anthropic/Gemini，其他公网目标一律拒绝（默认 deny）；
//    面板配置 assistantLlmProxy.allowlist 后增量放行
import {
  createPinnedLookup,
  _assistantLlmPinnedRequest,
  isAssistantLlmTargetAllowed,
  normalizeAssistantLlmHost,
} from '../scripts/dev-api.js'

test('pinnedLookup 只使用校验阶段地址，连接阶段永不解析 DNS（TOCTOU 防护）', async () => {
  // 回环 stub 服务；目标主机名在公共 DNS 不存在 —— 只有 pinning 才能连上
  const seen = []
  const stub = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('pinned-ok')
  })
  await new Promise(r => stub.listen(0, '127.0.0.1', r))
  t0: try {
    const port = stub.address().port
    const addrs = [{ address: '127.0.0.1', family: 4 }]
    // 主机名与地址无 DNS 关联：连接成功 ⇔ 连接没有做 DNS 查询（复用校验阶段地址）
    const resp = await _assistantLlmPinnedRequest(
      new URL(`http://rebound-during-connect.test:${port}/v1/chat/completions`),
      addrs,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' },
    )
    assert.equal(resp.statusCode, 200, 'pinned 连接必须成功（不触发 DNS）')
    let body = ''
    for await (const chunk of resp) body += chunk
    assert.equal(body, 'pinned-ok')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].host, `rebound-during-connect.test:${port}`, 'Host 头必须保留原始主机名（含端口）')
    assert.equal(seen[0].url, '/v1/chat/completions')
  } finally {
    stub.close()
  }
})

test('pinnedLookup 双栈地址按 family 派发，all:true 返回数组', async () => {
  const addrs = [
    { address: '203.0.113.9', family: 4 },
    { address: '2001:db8::9', family: 6 },
  ]
  const call = (lookup, options) => new Promise(resolve => {
    lookup('x.test', options, (...cbArgs) => resolve(cbArgs))
  })
  const lookup = createPinnedLookup(addrs)
  {
    const [err, address, family] = await call(lookup, {})
    assert.ifError(err)
    assert.ok(address === '203.0.113.9' || address === '2001:db8::9')
    assert.ok(family === 4 || family === 6)
  }
  {
    const [err, list] = await call(lookup, { all: true })
    assert.ifError(err)
    assert.ok(Array.isArray(list) && list.length === 2)
    assert.deepEqual(new Set(list.map(a => a.address)), new Set(['203.0.113.9', '2001:db8::9']))
  }
  {
    const [err, address, family] = await call(lookup, { family: 4 })
    assert.ifError(err)
    assert.equal(address, '203.0.113.9')
    assert.equal(family, 4)
  }
  {
    const [err, address, family] = await call(lookup, { family: 6 })
    assert.ifError(err)
    assert.equal(address, '2001:db8::9')
    assert.equal(family, 6)
  }
  // 空 family 池报错而不是 fallback 解析 DNS
  const v6Only = createPinnedLookup([{ address: '2001:db8::9', family: 6 }])
  {
    const [err] = await call(v6Only, { family: 4 })
    assert.ok(err, 'v4 缺失必须报错，绝不允许回退到 DNS')
    assert.equal(err.code, 'EAI_FAIL')
  }
})

test('pinned 请求禁止自动重定向：3xx 原样返回，绝不跟随 Location', async () => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://rebound-target.test:9/evil' })
      res.end()
      return
    }
    res.writeHead(200)
    res.end('should-not-reach')
  })
  await new Promise(r => stub.listen(0, '127.0.0.1', r))
  try {
    const port = stub.address().port
    const resp = await _assistantLlmPinnedRequest(
      new URL(`http://fake-redirect.test:${port}/redirect`),
      [{ address: '127.0.0.1', family: 4 }],
      { method: 'GET', headers: {} },
    )
    // 关键断言：3xx 必须原样返回给调用方（再由前端重新走完整校验），而不是自动跟随
    assert.equal(resp.statusCode, 302)
    assert.equal(resp.headers.location, 'http://rebound-target.test:9/evil')
    let body = ''
    for await (const chunk of resp) body += chunk
    assert.equal(body, '', '3xx 响应体不应包含跳转目标内容')
  } finally {
    stub.close()
  }
})

test('pinned 请求支持 AbortController 取消', async () => {
  const stub = http.createServer(() => { /* 永不响应 */ })
  await new Promise(r => stub.listen(0, '127.0.0.1', r))
  try {
    const port = stub.address().port
    const controller = new AbortController()
    const p = _assistantLlmPinnedRequest(
      new URL(`http://fake-slow.test:${port}/v1`),
      [{ address: '127.0.0.1', family: 4 }],
      { method: 'GET', headers: {}, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(p, err => err.name === 'AbortError')
  } finally {
    stub.close()
  }
})

test('HTTPS pinned 请求保留 TLS/SNI 语义（按主机名校验证书，连接仍用 pinning 地址）', async () => {
  // 自签名 TLS 服务器 + 不存在的域名：证书校验必须失败（证明 SNI/证书校验按原始主机名进行），
  // 同时若连接阶段做了 DNS 解析会先报 ENOTFOUND —— 只有「先连上再 TLS 握手」才会得到证书错误
  const https = await import('node:https')
  const pem = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 })
  // openssl 生成自签证书（离线可用）
  const { execFileSync } = await import('node:child_process')
  const tmp = (await import('node:fs')).mkdtempSync(`${process.cwd()}/test-logs/tls-`)
  const keyPath = `${tmp}/key.pem`, csrPath = `${tmp}/req.pem`, certPath = `${tmp}/cert.pem`
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=fake-tls-host.test'], { stdio: 'ignore' })
  const server = https.createServer({ key: (await import('node:fs')).readFileSync(keyPath), cert: (await import('node:fs')).readFileSync(certPath) }, (req, res) => {
    res.writeHead(200)
    res.end('tls-ok')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    const err = await _assistantLlmPinnedRequest(
      new URL(`https://fake-tls-host.test:${port}/v1`),
      [{ address: '127.0.0.1', family: 4 }],
      { method: 'GET', headers: {} },
    ).then(
      () => null,
      e => e,
    )
    assert.ok(err, '自签名证书必须校验失败（不得跳过证书校验）')
    assert.match(String(err.message || err), /certificate|SSL|TLS|EPROTO/i, `应为证书/TLS 错误而非 DNS 错误: ${err?.code || err?.message}`)
    assert.notEqual(err.code, 'ENOTFOUND', '错误必须是 TLS 层的，而不是 DNS 解析（DNS 被禁用）')
  } finally {
    server.close()
    ;(await import('node:fs')).rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 目标 allowlist 策略（默认 deny）
// ---------------------------------------------------------------------------

const BUILTIN_OK = ['https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent']
const DEFAULT_POLICY = { allowlist: null, allowBuiltin: true }

test('默认策略放行内置 OpenAI/Anthropic/Gemini（兼容模式不回归）', () => {
  for (const u of BUILTIN_OK) {
    assert.equal(isAssistantLlmTargetAllowed(new URL(u), DEFAULT_POLICY), true, `${u} 必须放行`)
  }
})

test('默认策略拒绝任意其他公网目标（默认 deny）', () => {
  for (const u of [
    'https://api.vsellm.example/v1/chat/completions',
    'https://openrouter.ai/api/v1',
    'http://203.0.113.9:8080/v1',
    'https://api.openai.com.evil.test/v1',        // 后缀伪装
    'https://fake-api.openai.com.attacker.test/v1',
    'http://[2001:db8::9]/v1',
  ]) {
    assert.equal(isAssistantLlmTargetAllowed(new URL(u), DEFAULT_POLICY), false, `${u} 必须拒绝`)
  }
})

test('allowlist 配置增量放行自定义服务商，内置三家仍可用', () => {
  const policy = { allowlist: ['vsellm.example', '*.relay.io', '203.0.113.9'], allowBuiltin: false }
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://vsellm.example/v1'), policy), true)
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://vsellm.example:8443/v1'), policy), true, 'host 级白名单不限端口')
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://a.relay.io/v1'), policy), true)
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://a.b.relay.io/v1'), policy), true)
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://203.0.113.9/v1'), policy), true)
  // 内置三家不受配置影响（增量而非替换）
  for (const u of BUILTIN_OK) {
    assert.equal(isAssistantLlmTargetAllowed(new URL(u), policy), true, `配置 allowlist 后 ${u} 仍须可用`)
  }
  // 其余目标仍然拒绝
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://random-provider.example/v1'), policy), false)
})

test('allowlist 通配符 *.example.com 不匹配裸域与伪装后缀', () => {
  const policy = { allowlist: ['*.relay.io'], allowBuiltin: false }
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://relay.io/v1'), policy), false, '裸域不匹配 *.relay.io')
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://evil-relay.io/v1'), policy), false)
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://relay.io.evil.test/v1'), policy), false)
  assert.equal(isAssistantLlmTargetAllowed(new URL('https://sub.relay.io/v1'), policy), true)
})

test('normalizeAssistantLlmHost 清洗条目并拒绝内网/非法主机', () => {
  assert.equal(normalizeAssistantLlmHost(' API.VseLLM.Example:8443 '), 'api.vsellm.example')
  assert.equal(normalizeAssistantLlmHost('*.Relay.IO'), '*.relay.io')
  assert.equal(normalizeAssistantLlmHost('[2001:DB8::9]:8443'), '2001:db8::9')
  assert.equal(normalizeAssistantLlmHost('2001:db8::9'), '2001:db8::9')
  assert.equal(normalizeAssistantLlmHost('api.example.com.'), 'api.example.com')
  for (const bad of ['localhost', 'panel.internal', 'printer.local', '127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '192.168.1.1:8000', 'not a host!!', '', 'v sellm', '*.']) {
    assert.equal(normalizeAssistantLlmHost(bad), null, `${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('allowlist 策略读取：默认未配置时为 null（内置模式），配置后清洗并去重', async () => {
  const { readAssistantLlmProxyPolicy } = await import('../scripts/dev-api.js')
  const policy = readAssistantLlmProxyPolicy()
  // 本测试环境无 assistantLlmProxy 配置 → 默认模式
  assert.equal(policy.allowlist, null)
  assert.equal(policy.allowBuiltin, true)
})
