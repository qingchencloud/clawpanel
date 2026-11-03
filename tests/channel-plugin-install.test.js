import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChannelPluginSpec, channelPluginHostVersion } from '../src/lib/channel-plugin-spec.js'
import { channelPluginStatusAt, channelPluginStatusFromInventory, installChannelPluginAt } from '../scripts/channel-plugin-install.js'

test('官方插件版本替换 latest，保留官方修订版本且第三方版本独立', () => {
  assert.equal(buildChannelPluginSpec('@openclaw/line@latest', '2026.8.2'), '@openclaw/line@2026.8.2')
  assert.equal(buildChannelPluginSpec('@openclaw/line@2026.8.1', '2026.9.4'), '@openclaw/line@2026.9.4')
  assert.equal(buildChannelPluginSpec('@larksuite/openclaw-lark@latest'), '@larksuite/openclaw-lark@latest')
  assert.equal(channelPluginHostVersion('2026.7.1-2-zh.1'), '2026.7.1-2')
  assert.equal(channelPluginHostVersion('2026.9.4-beta.1'), '2026.9.4-beta.1')
  for (const spec of ['@openclaw/line@latest@2026.8.2', '../x', 'x & whoami', 'x;cmd', 'https://example.com/p.tgz']) {
    assert.throws(() => buildChannelPluginSpec(spec))
  }
  assert.throws(() => buildChannelPluginSpec('line', '1 & cmd'))
})

test('插件检测覆盖 extensions、manifest 别名、旧目录和新版内置目录，不运行 CLI', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-plugin-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (dir, id) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'), JSON.stringify({ id }))
  }
  put(path.join(root, 'extensions', 'openclaw-qqbot'), 'qqbot')
  put(path.join(root, 'plugins', 'node_modules', 'legacy'), 'legacy')
  put(path.join(root, 'core', 'dist', 'extensions', 'line'), 'line')
  put(path.join(root, 'extensions', 'mismatch'), 'other')
  assert.equal(channelPluginStatusAt(root, 'qqbot').installed, true)
  assert.equal(channelPluginStatusAt(root, 'legacy').installed, true)
  assert.equal(channelPluginStatusAt(root, 'line', path.join(root, 'core')).builtin, true)
  assert.equal(channelPluginStatusAt(root, 'mismatch').installed, false)
  assert.equal(channelPluginStatusAt(root, 'absent').installed, false)
  assert.throws(() => channelPluginStatusAt(root, '../outside'))
  const npmDir = path.join(root, 'npm', 'projects', 'generation-1', 'node_modules', '@openclaw', 'line')
  put(npmDir, 'line')
  const status = channelPluginStatusAt(root, 'line')
  const found = channelPluginStatusFromInventory(status, 'line', { plugins: [{ id: 'line', rootDir: npmDir, origin: 'global', enabled: true }] })
  assert.equal(found.installed, true)
  assert.equal(found.path, npmDir)
  assert.equal(channelPluginStatusFromInventory(status, 'line', { plugins: [{ id: 'line', rootDir: path.join(root, 'missing'), origin: 'global' }] }).installed, false)
})

function fixture(overrides = {}) {
  let installed = false
  const calls = [], events = []
  const input = {
    root: path.join(os.tmpdir(), 'plugin-test-' + Math.random()),
    packageName: '@openclaw/line@latest', pluginId: 'line', version: '2026.8.2', hostVersion: '2026.8.2',
    run: async args => { calls.push(args); installed = true; return { status: 0 } },
    status: async () => ({ installed }), enable: async id => calls.push(['enable', id]),
    onEvent: e => events.push(e), ...overrides,
  }
  return { input, calls, events }
}

test('安装成功须经文件回读验证，重复安装幂等且旧内核不添加新选项', async () => {
  const { input, calls, events } = fixture()
  assert.equal(await installChannelPluginAt(input), '安装成功')
  assert.deepEqual(calls[0], ['plugins', 'install', '@openclaw/line@2026.8.2'])
  assert.equal(events.at(-1).payload, 100)
  assert.equal(await installChannelPluginAt(input), '插件已就绪')
  assert.equal(calls.filter(c => c[0] === 'plugins').length, 1)
})

test('9.4 首次 npm 安装确认来源，安全策略检查继续由上游执行', async () => {
  const { input, calls } = fixture({ hostVersion: '2026.9.4', version: '2026.9.4' })
  await installChannelPluginAt(input)
  assert.deepEqual(calls[0], ['plugins', 'install', '@openclaw/line@2026.9.4', '--force'])
})

test('通用插件升级仍执行原生 update，失败不宣称成功', async () => {
  const { input, calls } = fixture({
    pluginId: 'openclaw-weixin', packageName: '@tencent-weixin/openclaw-weixin@latest', version: null,
    hostVersion: '2026.9.4', updateExisting: true, status: async () => ({ installed: true }),
  })
  assert.equal(await installChannelPluginAt(input), '插件更新完成')
  assert.deepEqual(calls[0], ['plugins', 'update', 'openclaw-weixin'])
  assert.deepEqual(calls[1], ['enable', 'openclaw-weixin'])
  calls.length = 0
  await assert.rejects(installChannelPluginAt({ ...input, run: async () => ({ status: 1, stderr: 'E404' }) }), /E404/)
  assert.equal(calls.length, 0)
})

test('桌面微信安装复用共享安装器且不预先删除账号配置', () => {
  const source = fs.readFileSync(new URL('../src-tauri/src/commands/messaging.rs', import.meta.url), 'utf8')
  const action = source.slice(source.indexOf('pub async fn run_channel_action('), source.indexOf('const QQ_OPENCLAW_FAQ_URL'))
  assert.match(action, /install_channel_plugin\(/)
  assert.match(action, /install_target/); assert.match(action, /verify_weixin_installed_version/)
  assert.doesNotMatch(action, /remove_dir_all|channels\.remove|entries\.remove/)
  assert.match(action, /app\.unlisten\(log_listener\)/)
})

test('非零退出保留实际错误并脱敏，不报告成功或自动改写配置', async () => {
  const { input, calls } = fixture({ run: async () => ({ status: 1, stderr: 'E404 package missing token=SECRET apiKey=SECRET2' }) })
  await assert.rejects(installChannelPluginAt(input), error => error.message.includes('E404') && !error.message.includes('SECRET'))
  assert.equal(calls.length, 0)
})

test('退出零但无插件文件也算失败，失败后释放安装锁', async () => {
  const { input } = fixture({ run: async () => ({ status: 0 }) })
  await assert.rejects(installChannelPluginAt(input), /未检测到插件文件/)
  await assert.rejects(installChannelPluginAt(input), /未检测到插件文件/)
})

test('安装异步等待期间不阻塞事件循环，并拒绝共享配置的并发安装', async () => {
  let release, installed = false
  const { input } = fixture({
    status: async () => ({ installed }),
    run: () => new Promise(resolve => { release = () => { installed = true; resolve({ status: 0 }) } }),
  })
  const pending = installChannelPluginAt(input)
  await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(installChannelPluginAt({ ...input, pluginId: 'matrix' }), /已有渠道插件正在安装/)
  release()
  await pending
})

test('Web 消息渠道安装和微信操作走认证后的流式接口而非桌面占位实现', () => {
  const web = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
  const api = fs.readFileSync(new URL('../src/lib/tauri-api.js', import.meta.url), 'utf8')
  const ui = fs.readFileSync(new URL('../src/pages/channels.js', import.meta.url), 'utf8')
  assert.doesNotMatch(web, /Web 模式暂未实现渠道操作/)
  assert.match(web, /async check_weixin_plugin_status\(\)/)
  const middleware = web.slice(web.indexOf('async function _apiMiddleware'))
  assert.ok(middleware.indexOf('if (!isAuthenticated(req))') < middleware.indexOf("cmd === 'channel_plugin_install_stream'"))
  assert.match(api, /webStreamInvoke\('channel_action_stream'/)
  assert.match(ui, /installChannelPluginWithLogs/)
  assert.doesNotMatch(ui, /api\.qrserver\.com/)
})
