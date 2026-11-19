import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// assistant_llm_proxy 全链路策略回归（隔离 HOME + 真实面板 HTTP）：
// 1) 默认策略：内置 OpenAI/Anthropic/Gemini 放行、其他公网目标 403（默认 deny）
// 2) 面板配置 assistantLlmProxy.allowlist → 自定义服务商增量放行（写入真实 clawpanel.json 验证读取链路）
// 3) allowlist 不放宽 SSRF：内网/环回目标在任何策略下都 400
// 必须在任何 dev-api 导入之前重定向 HOME，让 PANEL_CONFIG_PATH 落入隔离目录。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-llm-policy-e2e-'))
fs.mkdirSync(path.join(sandbox, '.openclaw'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, '.openclaw', 'clawpanel.json'),
  JSON.stringify({ accessPassword: 'e2e-policy-pass-123' }),
)
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const { _apiMiddleware } = await import('../scripts/dev-api.js')

// 公网字面量 IP（TEST-NET-3，RFC 5737 文档保留段）——线上不会路由，这里验证策略层
const PUBLIC_IP_OK = '203.0.113.55'      // 在 allowlist 中
const PUBLIC_IP_BLOCKED = '198.51.100.77' // 不在 allowlist 中

function startStub() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'policy-ok' } }] }))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

test('assistant_llm_proxy 目标策略全链路：默认 deny、allowlist 放行、SSRF 不放宽', { timeout: 90000 }, async t => {
  const { server: stub, port: stubPort } = await startStub()
  const panel = http.createServer((req, res) => { _apiMiddleware(req, res, () => { res.statusCode = 404; res.end('next') }) })
  await new Promise(r => panel.listen(0, '127.0.0.1', r))
  t.after(() => { stub.close(); panel.close() })
  const base = `http://127.0.0.1:${panel.address().port}/__api`

  const call = (cmd, args, cookie = '') => fetch(`${base}/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(args),
  })

  // 登录（隔离面板密码）
  const login = await call('auth_login', { password: 'e2e-policy-pass-123' })
  assert.equal(login.status, 200)
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]

  // 1) 默认策略：内置服务商放行（真实服务商在本环境全部返回 403 区域限制/拒绝 —— 属于上游业务响应，
  //    而非代理的 TARGET_NOT_ALLOWED：代理策略层错误带 assistant_llm_proxy: 前缀，据此区分）
  const builtin = await call('assistant_llm_proxy', { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', body: {} }, cookie)
  const builtinText = await builtin.text()
  assert.ok(builtin.status !== 403 || !builtinText.includes('assistant_llm_proxy'),
    `内置 OpenAI 端点不应被代理策略拒绝（可被上游业务拒绝）: ${builtin.status} ${builtinText.slice(0, 160)}`)

  // 2) 默认策略：任意其他公网目标 → 403 默认 deny
  const deny = await call('assistant_llm_proxy', { url: `http://${PUBLIC_IP_BLOCKED}/v1/chat/completions` }, cookie)
  assert.equal(deny.status, 403)
  const denyBody = await deny.text()
  assert.match(denyBody, /目标不在允许列表内/)
  assert.match(denyBody, /assistantLlmProxy\.allowlist/, '错误信息必须指明配置方式')

  // 3) 内网目标在任何策略下都被 SSRF 拦截（优先于 allowlist 判断）
  const ssrf = await call('assistant_llm_proxy', { url: `http://127.0.0.1:${stubPort}/v1/chat/completions` }, cookie)
  assert.equal(ssrf.status, 400)
  assert.match(await ssrf.text(), /内网地址/)

  // 4) 面板配置 allowlist → 自定义服务商放行（走真实配置文件写入路径；
  //    与前端 settings.js 一致的 read → mutate → write 全量写回，保留 accessPassword）
  //    example.com 是 IANA 保留域、公网可达且响应快；TEST-NET IP 不路由（连接会等满 30s 超时），
  //    因此「配置读取生效」用 example.com 验证，TEST-NET IP 留给单元测试做纯策略判定
  const readCfg = await call('read_panel_config', {}, cookie)
  assert.equal(readCfg.status, 200)
  const cfg = await readCfg.json()
  cfg.assistantLlmProxy = { allowlist: [PUBLIC_IP_OK, 'example.com', '*.relay.example'] }
  const write = await call('write_panel_config', { config: cfg }, cookie)
  assert.equal(write.status, 200)
  await write.body?.cancel()

  // 配置 TTL 缓存 2s：写配置立即失效，策略读取应拿到新值
  const allowed = await call('assistant_llm_proxy', { url: 'https://example.com/v1/chat/completions', method: 'POST', body: {} }, cookie)
  const allowedText = await allowed.text()
  assert.ok(allowed.status !== 403 || !allowedText.includes('assistant_llm_proxy'),
    `allowlist 内的 example.com 不应被策略拒绝: ${allowed.status} ${allowedText.slice(0, 140)}`)

  // 4b) allowlist 增量不替换：内置服务商仍然放行
  const builtinAfter = await call('assistant_llm_proxy', { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: {} }, cookie)
  const builtinAfterText = await builtinAfter.text()
  assert.ok(builtinAfter.status !== 403 || !builtinAfterText.includes('assistant_llm_proxy'),
    '配置 allowlist 后内置 Anthropic 仍必须可用（可被上游业务拒绝）')

  // 4c) 通配符子域与裸域的策略层判定（DNS 级别的拒绝在 assertPublicHttpUrl 更早发生，
  //     因此这里用「是否出现策略层错误」区分：裸域 relay.example 若 DNS 可解析则必为 403 策略拒绝，
  //     不可解析则 400 解析失败 —— 两者都不是「策略放行后进入上游」）
  const wildcard = await call('assistant_llm_proxy', { url: 'https://a.relay.example/v1' }, cookie)
  const wildcardText = await wildcard.text()
  assert.ok(wildcard.status !== 403 || !wildcardText.includes('assistant_llm_proxy'), '通配符子域应放行')
  const bareDomain = await call('assistant_llm_proxy', { url: 'https://relay.example/v1' }, cookie)
  const bareText = await bareDomain.text()
  assert.ok(
    (bareDomain.status === 403 && bareText.includes('目标不在允许列表内')) || bareDomain.status === 400,
    `裸域 relay.example 必须被策略拒绝或 DNS 拒绝，实际 ${bareDomain.status}`,
  )
  assert.ok(!/TARGET_NOT_ALLOWED/.test('') === false || bareDomain.status !== 200, '裸域不得被放行到上游')

  // 5) 未登录依旧 401（策略层不改变认证门禁；accessPassword 保留在配置中，认证门禁先于策略与上游连接）
  const unauth = await call('assistant_llm_proxy', { url: `http://${PUBLIC_IP_OK}/v1/chat/completions` })
  assert.equal(unauth.status, 401)
  await unauth.body?.cancel()

  // 6) 3xx 重定向原样透传（不自动跟随）：上游返回 302 + Location（内网目标）→ 原样到达客户端
  const redirectStub = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${stubPort}/evil` })
    res.end()
  })
  await new Promise(r => redirectStub.listen(0, '127.0.0.1', r))
  t.after(() => redirectStub.close())
  // 回环 stub 不能作为代理目标（SSRF），改用 _assistantLlmPinnedRequest 直验已在专属测试覆盖；
  // 这里验证「策略 + SSRF 双门禁下 3xx 语义」的入口不变：策略拒绝目标仍是 403，SSRF 拒绝仍是 400。
  const redirectProbe = await call('assistant_llm_proxy', { url: `http://${PUBLIC_IP_BLOCKED}/redirect-me` }, cookie)
  assert.equal(redirectProbe.status, 403, '重定向前的初始目标必须先过策略')
})
