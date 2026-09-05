import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseHermesProfileListOutput } from '../scripts/dev-api.js'

const profilePage = readFileSync(new URL('../src/engines/hermes/pages/profiles.js', import.meta.url), 'utf8')
const chatPage = readFileSync(new URL('../src/engines/hermes/pages/chat.js', import.meta.url), 'utf8')
const componentCss = readFileSync(new URL('../src/style/components.css', import.meta.url), 'utf8')

test('Hermes 新版 profile list 的星号格式可以正确解析', () => {
  const result = parseHermesProfileListOutput(`Available profiles:\n  default\n* work\n  dev\n  personal`)

  assert.equal(result.active, 'work')
  assert.deepEqual(result.profiles.map(profile => profile.name), ['default', 'work', 'dev', 'personal'])
  assert.equal(result.profiles.find(profile => profile.name === 'work')?.active, true)
  assert.equal(result.profiles.find(profile => profile.name === 'default')?.active, false)
})

test('Hermes 旧版 profile 表格仍保留模型和 Gateway 状态', () => {
  const result = parseHermesProfileListOutput([
    'Profile       Model                 Gateway   Alias',
    '◆ default     anthropic/claude      stopped   —',
    '  work        openai/gpt             running   work',
  ].join('\n'))

  assert.equal(result.active, 'default')
  assert.deepEqual(result.profiles, [
    { name: 'default', active: true, model: 'anthropic/claude', gatewayRunning: false, alias: '' },
    { name: 'work', active: false, model: 'openai/gpt', gatewayRunning: true, alias: 'work' },
  ])
})

test('Hermes 0.20.5 profile 表格可解析显示名、canonical id 与 Distribution 列', () => {
  const result = parseHermesProfileListOutput([
    'Profile                         Model                           Gateway   Alias  Distribution',
    '◆ 智能 编码助手 (work)          anthropic/claude-sonnet-4.6    running   work   team@1',
    '  默认助手 (default)             openai/gpt-5.4                  stopped   —      —',
  ].join('\n'))

  assert.equal(result.active, 'work')
  assert.deepEqual(result.profiles, [
    { name: 'work', displayName: '智能 编码助手', active: true, model: 'anthropic/claude-sonnet-4.6', gatewayRunning: true, alias: 'work' },
    { name: 'default', displayName: '默认助手', active: false, model: 'openai/gpt-5.4', gatewayRunning: false, alias: '' },
  ])
})

test('Hermes Profile 页面提供按 Profile 写入模型的入口', () => {
  assert.match(profilePage, /hermesDashboardApi\('PUT', `\/api\/profiles\/\$\{encodeURIComponent\(name\)\}\/model`/)
  assert.match(profilePage, /data-action="configure"/)
})

test('Hermes 聊天页提供直接启动 Gateway 的入口', () => {
  assert.match(chatPage, /id="hm-chat-start-gateway"/)
  assert.match(chatPage, /hermesGatewayAction\('start'\)/)
})

test('Hermes Profile 移动端操作按钮满足触控高度', () => {
  assert.match(componentCss, /\.lazy-deps-card-actions \.btn\s*\{[^}]*min-height:\s*40px/s)
})
