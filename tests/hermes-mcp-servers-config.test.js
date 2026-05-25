import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesMcpServersConfigValues,
  mergeHermesMcpServersConfig,
} from '../scripts/dev-api.js'

test('Hermes MCP 服务配置读取会提供空对象默认值', () => {
  const values = buildHermesMcpServersConfigValues({})

  assert.deepEqual(values, {
    mcpServersJson: '{}',
  })
})

test('Hermes MCP 服务配置读取会格式化 stdio 和 HTTP 服务', () => {
  const values = buildHermesMcpServersConfigValues({
    mcp_servers: {
      time: {
        command: 'uvx',
        args: ['mcp-server-time'],
      },
      notion: {
        url: 'https://mcp.notion.com/mcp',
        connect_timeout: 30,
      },
    },
  })
  const mapping = JSON.parse(values.mcpServersJson)

  assert.deepEqual(mapping.time, {
    command: 'uvx',
    args: ['mcp-server-time'],
  })
  assert.deepEqual(mapping.notion, {
    url: 'https://mcp.notion.com/mcp',
    connect_timeout: 30,
  })
})

test('Hermes MCP 服务配置保存会保留未知字段并写入 mcp_servers', () => {
  const next = mergeHermesMcpServersConfig({
    model: { provider: 'openrouter' },
    mcp_servers: {
      time: {
        command: 'uvx',
        args: ['old-server'],
        sampling: {
          enabled: true,
          model: 'gemini-3-flash',
        },
      },
    },
    memory: { memory_enabled: true },
  }, {
    mcpServersJson: JSON.stringify({
      time: {
        command: 'uvx',
        args: ['mcp-server-time'],
        timeout: 120,
        sampling: {
          enabled: true,
          model: 'gemini-3-flash',
        },
      },
      notion: {
        url: 'https://mcp.notion.com/mcp',
        headers: {
          Authorization: 'Bearer token',
        },
        connect_timeout: 30,
      },
    }),
  })

  assert.deepEqual(next.model, { provider: 'openrouter' })
  assert.deepEqual(next.memory, { memory_enabled: true })
  assert.equal(next.mcp_servers.time.command, 'uvx')
  assert.deepEqual(next.mcp_servers.time.args, ['mcp-server-time'])
  assert.equal(next.mcp_servers.time.timeout, 120)
  assert.equal(next.mcp_servers.time.sampling.enabled, true)
  assert.equal(next.mcp_servers.time.sampling.model, 'gemini-3-flash')
  assert.equal(next.mcp_servers.notion.url, 'https://mcp.notion.com/mcp')
  assert.equal(next.mcp_servers.notion.headers.Authorization, 'Bearer token')
  assert.equal(next.mcp_servers.notion.connect_timeout, 30)
})

test('Hermes MCP 服务配置保存空对象会移除 mcp_servers', () => {
  const next = mergeHermesMcpServersConfig({
    mcp_servers: {
      time: { command: 'uvx' },
    },
    streaming: { enabled: true },
  }, {
    mcpServersJson: '{}',
  })

  assert.equal(next.mcp_servers, undefined)
  assert.deepEqual(next.streaming, { enabled: true })
})

test('Hermes MCP 服务配置保存会拒绝非法 JSON、名称、结构和超时', () => {
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: '[' }),
    /mcp_servers JSON/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ 'bad server': { command: 'uvx' } }) }),
    /mcp_servers\.bad server/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ time: 'uvx' }) }),
    /mcp_servers\.time/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ time: { command: '' } }) }),
    /mcp_servers\.time\.command/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ notion: { url: 'ftp://example.com/mcp' } }) }),
    /mcp_servers\.notion\.url/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ time: { command: 'uvx', args: 'mcp-server-time' } }) }),
    /mcp_servers\.time\.args/,
  )
  assert.throws(
    () => mergeHermesMcpServersConfig({}, { mcpServersJson: JSON.stringify({ time: { command: 'uvx', timeout: 0 } }) }),
    /mcp_servers\.time\.timeout/,
  )
})
