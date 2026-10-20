import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as roster from '../src/lib/openclaw-agent-roster.js'
import {
  addAgentConfig, ensureAgentRoster, ensureMutableAgentConfig, listAgentConfigs,
} from '../src/lib/openclaw-agent-roster.js'

function explicitConfig() {
  return {
    agents: {
      ownership: 'explicit',
      defaults: {
        systemAgent: { agentId: 'alpha' }, sessionStore: { agentId: 'beta' },
        heartbeat: { agentId: 'beta', every: '30m' }, authInheritance: { agentId: 'alpha' },
      },
      entries: {
        alpha: { default: true, id: 'projection', isDefault: true, name: 'Alpha', tools: { deny: ['exec'] } },
        beta: { default: false, isDefault: false, sandbox: { mode: 'all' } },
      },
    },
    talk: { agentId: 'beta' }, bindings: [{ agentId: 'beta', match: { channel: 'telegram' } }],
    gateway: { auth: { mode: 'token', token: 'fixture-not-a-secret' } },
  }
}

test('explicit 既存 Agent 修改前清理整张 roster 的 default/id/isDefault，保留独立 owner 与权限', () => {
  const config = explicitConfig()
  const before = structuredClone(config)
  const agent = ensureMutableAgentConfig(config, 'ALPHA')
  agent.name = 'Renamed'
  for (const entry of Object.values(config.agents.entries)) {
    for (const key of ['default', 'id', 'isDefault']) assert.equal(Object.hasOwn(entry, key), false, key)
  }
  assert.equal(config.agents.entries.alpha.name, 'Renamed')
  assert.deepEqual(config.agents.defaults, before.agents.defaults)
  assert.equal(config.agents.ownership, 'explicit')
  for (const key of ['talk', 'bindings', 'gateway']) assert.deepEqual(config[key], before[key])
  assert.deepEqual(config.agents.entries.alpha.tools, before.agents.entries.alpha.tools)
  assert.deepEqual(config.agents.entries.beta.sandbox, before.agents.entries.beta.sandbox)
})

test('canonical 新增拒绝投影字段；default=true 不成为修改全局所有权的后门', () => {
  const config = explicitConfig()
  const defaults = structuredClone(config.agents.defaults)
  addAgentConfig(config, 'gamma', { id: 'wrong', default: true, isDefault: true, name: 'Gamma' })
  assert.deepEqual(config.agents.entries.gamma, { name: 'Gamma' })
  assert.deepEqual(config.agents.defaults, defaults)
  assert.equal(config.agents.ownership, 'explicit')
})

for (const operation of ['edit', 'add', 'ensure']) {
  test(`legacy entries 单一默认留给官方多 surface 迁移，不在 ${operation} 时丢失`, () => {
    const config = { agents: { entries: { alpha: { default: true }, beta: {} } }, talk: { agentId: 'beta' } }
    if (operation === 'edit') ensureMutableAgentConfig(config, 'beta').name = 'Beta'
    if (operation === 'add') addAgentConfig(config, 'gamma', { name: 'Gamma' })
    if (operation === 'ensure') ensureAgentRoster(config, '2026.10.4')
    assert.equal(config.agents.entries.alpha.default, true)
    assert.equal(Object.hasOwn(config.agents, 'ownership'), false)
    assert.equal(config.agents.defaults, undefined)
    assert.deepEqual(config.talk, { agentId: 'beta' })
  })
}

test('含糊或非法 legacy 标记留给 validator 报错，不静默选 owner', () => {
  for (const marker of [true, 'true']) {
    const config = { agents: { entries: { alpha: { default: true }, beta: { default: marker } } } }
    const before = structuredClone(config)
    ensureAgentRoster(config, '2026.9.4')
    assert.deepEqual(config, before)
  }
})

test('旧 list 的默认与形状保留，现代版本号不强迁移现存 list', () => {
  const config = { agents: { list: [{ id: 'alpha', default: true }, { id: 'beta', default: false }] } }
  ensureMutableAgentConfig(config, 'alpha', { installedVersion: '2026.10.4' }).name = 'Alpha'
  addAgentConfig(config, 'gamma', { name: 'Gamma' }, { installedVersion: '2026.10.4' })
  assert.equal(config.agents.list[0].default, true)
  assert.equal(config.agents.list[1].default, false)
  assert.equal(config.agents.entries, undefined)
  assert.equal(config.agents.ownership, undefined)
})

test('canonical 清理幂等，读取投影不变更原始配置，缺失 ID 不修配置', () => {
  const config = explicitConfig()
  const original = structuredClone(config)
  listAgentConfigs(config)
  assert.deepEqual(config, original)
  assert.equal(ensureMutableAgentConfig(config, 'missing'), null)
  assert.deepEqual(config, original)
  ensureMutableAgentConfig(config, 'alpha')
  const normalized = structuredClone(config)
  ensureMutableAgentConfig(config, 'alpha')
  assert.deepEqual(config, normalized)
})

test('Agent 页面没有全局设默认写操作，也没有直接 config.set/fetch/invoke', () => {
  for (const page of ['agents', 'agent-detail']) {
    const source = readFileSync(new URL(`../src/pages/${page}.js`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /data-action=["'](?:set-)?default["']|setDefaultAgent|\.default\s*=\s*true/)
    assert.doesNotMatch(source, /['"]config\.set['"]|\bfetch\s*\(|\binvoke\s*\(/)
  }
})

test('现代默认设置只写 systemAgent，独立 sessionStore/auth/heartbeat/bindings 不联动', () => {
  assert.equal(typeof roster.setAgentDefault, 'function')
  for (const version of ['2026.9.4', '2026.10.4', '2026.10.4-zh.1']) {
    const config = explicitConfig()
    const before = structuredClone(config)
    roster.setAgentDefault(config, 'BETA', version)
    const expected = structuredClone(before.agents.defaults)
    expected.systemAgent.agentId = 'beta'
    assert.deepEqual(config.agents.defaults, expected)
    assert.equal(config.agents.ownership, 'explicit')
    for (const key of ['talk', 'bindings', 'gateway']) assert.deepEqual(config[key], before[key])
    for (const entry of Object.values(config.agents.entries)) {
      assert.equal(Object.hasOwn(entry, 'default'), false)
      assert.equal(Object.hasOwn(entry, 'isDefault'), false)
    }
  }
})

test('旧 list 默认设置保持旧格式；未知版本/8.1 entries/已删目标/待官方迁移不写入', () => {
  assert.equal(typeof roster.setAgentDefault, 'function')
  const legacy = { agents: { list: [{ id: 'alpha', default: true }, { id: 'beta', name: 'Beta' }] } }
  roster.setAgentDefault(legacy, 'beta', '2026.7.1-2-zh.1')
  assert.equal(legacy.agents.list[1].default, true)
  assert.notEqual(legacy.agents.list[0].default, true)
  assert.equal(legacy.agents.defaults, undefined)
  assert.equal(legacy.agents.entries, undefined)
  for (const [config, id, version] of [
    [explicitConfig(), 'beta', ''], [explicitConfig(), 'beta', '2026.8.1'],
    [explicitConfig(), 'missing', '2026.10.4'], [legacy, 'alpha', '2026.10.4'],
    [{ agents: { entries: { alpha: { default: true }, beta: {} } } }, 'beta', '2026.9.4'],
  ]) {
    const before = structuredClone(config)
    assert.throws(() => roster.setAgentDefault(config, id, version))
    assert.deepEqual(config, before)
  }
})

test('默认设置入口可发现，先读最新配置，仍复用统一 read/writeConfig API', () => {
  const source = readFileSync(new URL('../src/pages/agents.js', import.meta.url), 'utf8')
  assert.match(source, /id="btn-agent-default"/)
  assert.match(source, /setAgentDefault\(/)
  assert.match(source, /invalidate\('read_openclaw_config'\)/)
  assert.match(source, /api\.writeOpenclawConfig\(/)
})

test('默认写入只接受 stable/数字 hotfix/汉化后缀，preview 和未知后缀先拒绝', () => {
  for (const version of ['2026.10.4-beta', '2026.10.4-beta.1', '2026.10.4-rc.1',
    '2026.10.4-nightly.20261016', '2026.10.4-dev', '2026.10.4-unknown',
    '2026.10.4+unknown', '2026.10.4-zh.1-rc.1', '2026.7.1-beta.1']) {
    const config = explicitConfig()
    const before = structuredClone(config)
    assert.equal(roster.agentDefaultMode(config, version), null, version)
    assert.throws(() => roster.setAgentDefault(config, 'beta', version), version)
    assert.deepEqual(config, before, version)
  }
  for (const version of ['2026.9.4', '2026.10.4-1', '2026.10.4-zh.1', '2026.10.4-1-zh.2']) {
    assert.equal(roster.agentDefaultMode(explicitConfig(), version), 'systemAgent', version)
  }
  assert.equal(roster.agentDefaultMode({ agents: { list: [] } }, '2026.7.1-2-zh.1'), 'legacy')
})
