import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWeixinCompatibilityStatus, resolveWeixinInstallVersion } from '../scripts/weixin-compat.js'
import { installChannelPluginAt } from '../scripts/channel-plugin-install.js'
import { selectFeishuPlugin } from '../src/lib/feishu-plugin-selection.js'
import { mergeOpenClawMessagingPlatformConfig } from '../scripts/dev-api.js'

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/weixin-compat.json', import.meta.url)))
for (const c of cases) test(`微信版本线 ${c.host} / ${c.plugin ?? '未安装'}`, () => {
  const actual = buildWeixinCompatibilityStatus(c.host, c.plugin)
  for (const key of ['compatible', 'recommendedVersion', 'installAllowed', 'updateAvailable']) assert.equal(actual[key], c[key], key)
})

test('安装不接受不兼容版本、未核实版本或可变标签', () => {
  assert.throws(() => resolveWeixinInstallVersion('2026.3.21', '2.4.8'), /要求 OpenClaw/)
  assert.throws(() => resolveWeixinInstallVersion('2026.9.4', '1.0.3'), /要求 OpenClaw/)
  for (const version of ['latest', 'legacy', '3.0.0', '2.4.9-beta.0']) assert.throws(() => resolveWeixinInstallVersion('2026.9.4', version))
})

test('微信精确版本替换忽略旧 latest 更新记录，回读不匹配时不启用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-review-'))
  const calls = []
  const input = {
    root, packageName: '@tencent-weixin/openclaw-weixin', pluginId: 'openclaw-weixin',
    version: '2.4.4', hostVersion: '2026.5.11', expectedVersion: '2.4.4', updateExisting: true, replaceExisting: true,
    status: async () => ({ installed: true, path: root }),
    run: async args => { calls.push(args); return { status: 0 } },
    enable: async id => calls.push(['enable', id]),
  }
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.4.8' }))
    await assert.rejects(installChannelPluginAt(input), /版本回读不一致/)
    assert.deepEqual(calls, [['plugins', 'install', '@tencent-weixin/openclaw-weixin@2.4.4', '--force']])
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.4.4' }))
    assert.equal(await installChannelPluginAt(input), '插件更新完成')
    assert.deepEqual(calls.at(-1), ['enable', 'openclaw-weixin'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('微信别名配置与路由使用 canonical id，不改全局会话策略或已有账号', () => {
  for (const platform of ['weixin', 'wechat', 'openclaw-weixin']) {
    const cfg = { session: { dmScope: 'per-channel-peer' }, channels: { 'openclaw-weixin': { accounts: { old: { enabled: true } } } } }
    const result = mergeOpenClawMessagingPlatformConfig(cfg, { platform, form: { enabled: true }, accountId: 'new' })
    assert.equal(result.storageKey, 'openclaw-weixin')
    assert.ok(cfg.channels['openclaw-weixin'].accounts.old)
    assert.ok(cfg.channels['openclaw-weixin'].accounts.new)
    assert.equal(cfg.session.dmScope, 'per-channel-peer')
    assert.deepEqual(Object.keys(cfg.channels), ['openclaw-weixin'])
  }
})

test('飞书新安装走官方包，既有 Lark 安装保留，双启用不擅自关闭任何一端', () => {
  assert.equal(selectFeishuPlugin().packageName, '@openclaw/feishu@latest')
  assert.equal(selectFeishuPlugin({ builtin: true, enabled: true }).pluginId, 'feishu')
  assert.equal(selectFeishuPlugin({ builtin: true, enabled: false }, { installed: true, enabled: true }).pluginId, 'openclaw-lark')
  assert.equal(selectFeishuPlugin({ installed: true, enabled: true }, { installed: true, enabled: false }).pluginId, 'feishu')
  assert.throws(() => selectFeishuPlugin({ installed: true, enabled: true }, { installed: true, enabled: true }), /两个已启用/)
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/messaging.rs', import.meta.url), 'utf8')
  assert.doesNotMatch(rust, /disable_legacy_plugin\(&mut cfg, "feishu"\)/)
})

test('微信状态更新统一处理未知兼容性，登录不再宣称消息已连接，Zalo Personal 暴露扫码入口', () => {
  const ui = fs.readFileSync(new URL('../src/pages/channels.js', import.meta.url), 'utf8')
  assert.match(ui, /s\.installAllowed !== true/)
  assert.match(ui, /weixinLoginSaved/)
  assert.match(ui, /api\.restartGateway\(\)/)
  assert.match(ui, /actions: \[\{ id: 'login'.*zalouserManualLoginHint/)
})
