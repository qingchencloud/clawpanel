import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'

// 仅显式连接隔离 HOME 中已启动的真实受管运行时，不伪造 PID、安装状态或上游响应。
const base = process.env.CLAWPANEL_EMBED_AUTH_E2E_URL
const password = process.env.CLAWPANEL_EMBED_AUTH_E2E_PASSWORD
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('Web embed 认证变化同时撤销 DSH/OpenCode 能力和现存连接', {
  skip: !base || !password,
  timeout: 240000,
}, async t => {
  const origin = new URL(base)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), '只允许隔离回环验收入口')
  assert.equal(origin.protocol, 'http:')

  async function call(command, args = {}, cookie = '', expected = 200) {
    const response = await fetch(new URL('/__api/' + command, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(120000),
    })
    const value = await response.json()
    assert.equal(response.status, expected, command + ' 状态码')
    if (expected === 200) assert.ok(!value?.error, command + ' 不应返回业务错误')
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (value = password) => (await call('auth_login', { password: value })).cookie
  const mint = async cookie => ({
    dsh: (await call('dsh_embed_session', { port: 3080 }, cookie)).value.src.replace(/\/$/, ''),
    opencode: (await call('opencode_embed_session', { port: 4096 }, cookie)).value.src.replace(/\/$/, ''),
  })
  async function status(caps, expected, method = 'GET') {
    const actual = {}, required = {}
    for (const [engine, prefix] of Object.entries(caps)) {
      const response = await fetch(new URL(prefix + (engine === 'opencode' ? '/global/health' : '/'), origin), {
        method, signal: AbortSignal.timeout(10000),
      })
      await response.body?.cancel()
      actual[engine] = response.status
      required[engine] = expected
    }
    assert.deepEqual(actual, required, method + ' 两引擎 capability 状态码')
  }
  async function websocket(pathname) {
    return new Promise((resolve, reject) => {
      const request = http.request(new URL(pathname, origin), {
        headers: {
          connection: 'Upgrade', upgrade: 'websocket', origin: 'null',
          'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'),
        },
      })
      const timer = setTimeout(() => { request.destroy(); reject(Error('真实 WebSocket 握手超时')) }, 10000)
      request.on('error', () => { clearTimeout(timer); reject(Error('真实 WebSocket 握手失败')) })
      request.on('response', response => {
        clearTimeout(timer); response.resume()
        resolve({ status: response.statusCode, close() { request.destroy() }, isClosed: () => true })
      })
      request.on('upgrade', (response, socket) => {
        clearTimeout(timer)
        socket.on('error', () => {})
        socket.on('data', () => {})
        let closed = false
        socket.once('close', () => { closed = true })
        resolve({ status: response.statusCode, close() { socket.destroy() }, isClosed: () => closed })
      })
      request.end()
    })
  }
  async function sse(prefix) {
    return new Promise((resolve, reject) => {
      const request = http.get(new URL(prefix + '/global/event', origin))
      const timer = setTimeout(() => { request.destroy(); reject(Error('真实 SSE 首包超时')) }, 10000)
      request.on('error', () => { clearTimeout(timer); reject(Error('真实 SSE 建立失败')) })
      request.on('response', response => {
        if (response.statusCode !== 200) { clearTimeout(timer); response.resume(); reject(Error('真实 SSE 状态码异常')); return }
        let closed = false
        response.on('error', () => {})
        response.once('close', () => { closed = true })
        response.once('data', () => {
          clearTimeout(timer)
          resolve({ close() { response.destroy(); request.destroy() }, isClosed: () => closed })
        })
      })
    })
  }
  async function pendingHttp(prefix, engine) {
    let closed = false
    const request = http.request(new URL(prefix + (engine === 'opencode' ? '/session' : '/api/session/list'), origin), {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1024' },
    })
    request.on('error', () => {})
    request.on('response', response => response.resume())
    request.once('close', () => { closed = true })
    request.flushHeaders(); request.write('{')
    await delay(100)
    assert.equal(closed, false, engine + ' 待完成 HTTP 必须先真实保持连接')
    return { close() { request.destroy() }, isClosed: () => closed }
  }
  async function connections(caps) {
    const opened = []
    try {
      opened.push(['OpenCode SSE', await sse(caps.opencode)])
      opened.push(['DSH HTTP', await pendingHttp(caps.dsh, 'dsh')])
      opened.push(['OpenCode HTTP', await pendingHttp(caps.opencode, 'opencode')])
      const dsh = await websocket(caps.dsh + '/api/remote.mux')
      opened.push(['DSH WS', dsh]); assert.equal(dsh.status, 101, 'DSH 真实 WebSocket 必须先建立')
      const response = await fetch(new URL(caps.opencode + '/pty', origin), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/cat', args: [], cwd: '/tmp/auth-home' }), signal: AbortSignal.timeout(10000),
      })
      assert.equal(response.status, 200, 'OpenCode 隔离 PTY 创建成功')
      const pty = await response.json()
      const opencode = await websocket(caps.opencode + '/pty/' + encodeURIComponent(pty.id) + '/connect?cursor=0')
      opened.push(['OpenCode WS', opencode]); assert.equal(opencode.status, 101, 'OpenCode 真实 WebSocket 必须先建立')
      return { opened, pty: pty.id }
    } catch (error) {
      for (const [, connection] of opened) connection.close()
      throw error
    }
  }
  async function assertClosed(opened) {
    for (let i = 0; i < 40 && opened.some(([, connection]) => !connection.isClosed()); i++) await delay(25)
    assert.deepEqual(Object.fromEntries(opened.map(([name, connection]) => [name, connection.isClosed()])),
      Object.fromEntries(opened.map(([name]) => [name, true])), '所有真实 HTTP/SSE/WS 必须随认证变更断开')
  }
  async function deletePty(id, cookie) {
    if (!id) return
    const caps = await mint(cookie)
    const response = await fetch(new URL(caps.opencode + '/pty/' + encodeURIComponent(id), origin), {
      method: 'DELETE', signal: AbortSignal.timeout(10000),
    })
    await response.body?.cancel()
    assert.ok([200, 204, 404].includes(response.status), '只清理本测试创建的 PTY')
  }

  const fixture = (await call('read_panel_config', {}, await login())).value
  assert.equal(fixture.ocReviewEmbedAuthFixture, true, '认证变更验收只允许运行于显式标记的独立 HOME')

  await t.test('前置门禁是真实受管进程、密码保护与有效能力', async () => {
    const cookie = await login()
    assert.ok(cookie, '密码登录必须产生真实 PanelSession')
    assert.equal((await call('auth_check')).value.authenticated, false)
    for (const engine of ['dsh', 'opencode']) {
      const value = (await call(engine + '_status', { port: engine === 'dsh' ? 3080 : 4096 }, cookie)).value
      assert.equal(value.running, true, engine + ' 真实运行中')
      assert.equal(value.managed, true, engine + ' 真实受管')
    }
    await status(await mint(cookie), 200)
  })

  await t.test('无认证、伪造及已退出 Cookie 的 logout 不撤销其他页面能力', async () => {
    const stale = await login()
    await call('auth_logout', {}, stale)
    const cookie = await login(), caps = await mint(cookie)
    for (const anonymous of ['', 'clawpanel_session=oc-review-invalid-session', stale]) {
      await call('auth_logout', {}, anonymous)
      await status(caps, 200)
    }
    assert.equal((await call('auth_check', {}, cookie)).value.authenticated, true)
  })

  await t.test('失败认证变更和无关配置写入不撤权', async () => {
    const cookie = await login(), caps = await mint(cookie)
    await call('auth_change_password', { oldPassword: 'oc-review-wrong', newPassword: 'oc-review-Other#2026' }, cookie, 400)
    for (const command of ['auth_change_password', 'auth_ignore_risk', 'write_panel_config', 'auth_set_password']) {
      await call(command, {}, '', 401)
    }
    const config = (await call('read_panel_config', {}, cookie)).value
    await call('write_panel_config', { config: { ...config, ocReviewAuthNoop: true } }, cookie)
    await status(caps, 200)
    await call('write_panel_config', { config }, cookie)
  })

  await t.test('认证 logout 撤销两引擎旧能力但保留其他 PanelSession', async () => {
    const actor = await login(), other = await login(), caps = await mint(actor)
    await call('auth_logout', {}, actor)
    await status(caps, 401)
    await status(caps, 401, 'OPTIONS')
    for (const pathname of [caps.dsh + '/api/remote.mux', caps.opencode + '/pty/oc-review-missing/connect?cursor=0']) {
      const denied = await websocket(pathname)
      try { assert.equal(denied.status, 401, '两引擎旧能力 WebSocket 新连接必须拒绝') } finally { denied.close() }
    }
    assert.equal((await call('auth_check', {}, other)).value.authenticated, true)
    await status(await mint(other), 200)
  })

  await t.test('认证 logout 同时关闭已建立 HTTP/SSE/DSH WS/OpenCode WS', async () => {
    const actor = await login(), other = await login(), caps = await mint(actor)
    const live = await connections(caps)
    try {
      await call('auth_logout', {}, actor)
      await assertClosed(live.opened)
      await status(await mint(other), 200)
    } finally {
      for (const [, connection] of live.opened) connection.close()
      await deletePty(live.pty, other)
    }
  })

  const alternate = 'oc-review-Changed#2026'
  for (const mutation of ['auth_change_password', 'auth_set_password', 'auth_ignore_risk', 'write_panel_config-password', 'write_panel_config-mode']) {
    await t.test(mutation + ' 撤权、断开现存连接且新能力可重新取得', async () => {
      const actor = await login(), caps = await mint(actor)
      const config = (await call('read_panel_config', {}, actor)).value
      const live = await connections(caps)
      let recovery = actor
      try {
        if (mutation === 'auth_change_password') recovery = (await call(mutation, { oldPassword: password, newPassword: alternate }, actor)).cookie
        else if (mutation === 'auth_set_password') { await call(mutation, { password: alternate }, actor); recovery = await login(alternate) }
        else if (mutation === 'auth_ignore_risk') { await call(mutation, { enable: true }, actor); recovery = '' }
        else await call('write_panel_config', { config: { ...config, ...(mutation.endsWith('password') ? { accessPassword: alternate } : { ignoreRisk: !config.ignoreRisk }) } }, actor)
        await status(caps, 401)
        await assertClosed(live.opened)
        await status(await mint(recovery), 200)
      } finally {
        for (const [, connection] of live.opened) connection.close()
        await deletePty(live.pty, recovery)
        await call('write_panel_config', { config }, recovery)
      }
    })
  }

  await t.test('关闭 ignoreRisk 的实际模式变化也撤销两引擎能力', async () => {
    const cookie = await login(), config = (await call('read_panel_config', {}, cookie)).value
    try {
      await call('auth_ignore_risk', { enable: true }, cookie)
      const caps = await mint('')
      await call('auth_logout')
      await status(caps, 200)
      await call('auth_ignore_risk', { enable: false })
      await status(caps, 401)
    } finally { await call('write_panel_config', { config }) }
  })

  for (const engine of ['dsh', 'opencode']) {
    await t.test(engine + ' 在请求正文等待期间 logout 后不能补发新能力', async () => {
      const actor = await login()
      const request = http.request(new URL('/__api/' + engine + '_embed_session', origin), {
        method: 'POST', headers: { cookie: actor, 'content-type': 'application/json', 'content-length': '2' },
      })
      const response = new Promise((resolve, reject) => {
        request.on('response', incoming => { incoming.resume(); resolve(incoming.statusCode) })
        request.on('error', () => reject(Error('等待正文的能力请求意外断开')))
      })
      request.flushHeaders(); request.write('{'); await delay(100)
      await call('auth_logout', {}, actor)
      request.end('}')
      assert.equal(await response, 401, '旧认证代次的延迟请求必须失败')
    })
  }
})
