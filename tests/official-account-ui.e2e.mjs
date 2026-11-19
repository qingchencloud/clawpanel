import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

// 使用真实账户页、引擎注册和浏览器路由，原生 IPC 固定为隔离数据；测试不访问官网。
const [playwright, executablePath, output] = process.argv.slice(2)
assert.ok(playwright && executablePath && output, '需要 Playwright 模块、浏览器、证据目录')
const { chromium } = await import(pathToFileURL(path.resolve(playwright)))
const engines = { hermes: '/h/chat', 'deepseek-harness': '/dsh/workspace', opencode: '/opencode/workspace', pi: '/pi/workspace' }
const report = {
  scope: 'real browser / account page / simulated IPC',
  expected: 'OpenClaw install, refresh, settings, disconnect, conflict and setup paths; four dedicated workbench routes; zero external requests',
  command: [process.execPath, ...process.argv.slice(1)], node: process.version, platform: process.platform,
  steps: [], errors: [], external: [],
}
const server = await createServer({
  optimizeDeps: { noDiscovery: true, include: ['@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-shell','yaml'] },
  cacheDir: path.join(path.resolve(output), 'vite-cache'), configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{ name: 'account-fixture', configureServer(vite) {
    vite.middlewares.use('/fixture', (_, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<main></main>')
    })
  } }],
})
const target = path.resolve(output)
fs.mkdirSync(target, { recursive: true })
let browser, page
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch({ executablePath, headless: true })
  report.browser = browser.version()
  const context = await browser.newContext()
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || url.protocol === 'data:') return route.continue()
    report.external.push(url.origin)
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(9000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.addInitScript(() => {
    const identity = { memberId: 'fixture-member', epoch: 8 }
    const account = { epoch: identity.epoch, phase: 'bound', member: { member_id: identity.memberId }, pendingRequests: [] }
    const provider = { installed: false, identityCurrent: true, engine: 'openclaw', modelIds: ['official/mock'] }
    const model = { id: 'official/mock', display_name: 'Fixture', toolsAvailable: true }
    window.fixture = { calls: [], failInstall: true, provider }
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      async invoke(cmd, payload = {}) {
        window.fixture.calls.push({ cmd, action: payload.action, engine: payload.engine || payload.args?.engine })
        if (cmd === 'plugin:event|listen') return 1
        if (cmd === 'platform_call') return account
        if (cmd === 'official_provider_install' || cmd === 'official_provider_remove') {
          if (payload.expected?.memberId !== identity.memberId || payload.expected?.epoch !== identity.epoch) throw Error('fixture identity mismatch')
          if (cmd === 'official_provider_install' && window.fixture.failInstall) throw Error('fixture_install_failed')
          provider.installed = cmd === 'official_provider_install'
        }
        if (cmd.startsWith('official_provider_')) return { engines: [{ ...provider }] }
        if (cmd === 'official_engine_access') {
          if (payload.action === 'inventory') return { ...identity, engines: ['openclaw','hermes','deepseek-harness','opencode','pi'].map(engine => ({ engine, installed: true, available: true })) }
          if (payload.action === 'catalog') return { ...identity, models: [model] }
          return { ...identity, ...payload.args, connected: true, newSession: true }
        }
        return {}
      },
    }
  })
  await page.goto(origin + '/fixture#/account')
  await page.evaluate(async () => {
    const { registerEngine } = await import('/src/lib/engine-manager.js')
    for (const id of ['openclaw', 'hermes', 'deepseek-harness', 'opencode', 'pi']) {
      registerEngine((await import('/src/engines/' + id + '/index.js')).default)
    }
    const account = await import('/src/pages/account.js')
    document.querySelector('main').append(await account.render())
  })
  const ordinary = page.locator('[data-official-provider]')
  const install = ordinary.locator('[data-official-action="install"]')
  await install.click()
  await ordinary.getByText(/fixture_install_failed/).waitFor()
  await page.evaluate(() => { window.fixture.failInstall = false })
  await install.click()
  await ordinary.locator('[data-official-action="remove"]').waitFor()
  await install.click()
  await ordinary.locator('[data-official-action="models"]').click()
  await page.waitForFunction(() => location.hash === '#/models')
  await ordinary.locator('[data-official-action="remove"]').click()
  await ordinary.locator('[data-official-action="remove"]').waitFor({ state: 'detached' })
  report.steps.push('OpenClaw install failure visible, retry, refresh, model route and remove')
  await page.evaluate(() => { window.fixture.provider.conflict = true })
  await ordinary.locator('[data-official-action="refresh"]').click()
  await ordinary.getByText(/同名服务商/).waitFor()
  assert.equal(await install.isDisabled(), true)
  report.steps.push('user-owned collision prevents overwrite')
  await page.evaluate(() => { window.fixture.provider.conflict = false; window.fixture.provider.configReady = false })
  await ordinary.locator('[data-official-action="refresh"]').click()
  await ordinary.locator('[data-official-action="setup"]').click()
  await page.waitForFunction(() => location.hash === '#/setup')
  assert.equal(await install.isDisabled(), true)
  report.steps.push('missing OpenClaw configuration opens setup')
  const access = page.locator('[data-platform-engine-access]')
  assert.deepEqual(await access.locator('[data-platform-engine-row]').evaluateAll(nodes => nodes.map(el => el.dataset.platformEngineRow)), Object.keys(engines))
  await access.locator('[data-platform-access-action="models"]').click()
  await access.locator('[data-platform-access-model]').waitFor()
  await access.locator('[data-platform-access-action="installed"]').click()
  for (const [id, route] of Object.entries(engines)) {
    await access.locator('[data-platform-access-action="open"][data-platform-access-engine="' + id + '"]').click()
    await page.waitForFunction(expected => location.hash.startsWith('#' + expected + '?accountOfficial='), route)
    const opened = await page.evaluate(async id => {
      const { consumeOfficialEngineIntent, adoptOfficialEngineIntent } = await import('/src/lib/platform-engine-access.js')
      return adoptOfficialEngineIntent(id, consumeOfficialEngineIntent(id))
    }, id)
    assert.equal(opened.engine, id)
    assert.equal(opened.modelId, 'official/mock')
    report.steps.push(id + ' configured and opened ' + route)
  }
  await page.screenshot({ path: path.join(target, 'account.png'), fullPage: true })
  report.calls = await page.evaluate(() => window.fixture.calls)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.external, [])
  report.passed = true
} catch (error) {
  if (page) {
    report.calls = await page.evaluate(() => window.fixture?.calls)
    report.visible = (await page.locator('body').innerText()).slice(0, 2200)
  }
  throw error
} finally {
  fs.writeFileSync(path.join(target, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await server.close()
}
