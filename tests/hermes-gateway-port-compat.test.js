import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveHermesGatewayPort } from '../scripts/dev-api.js'

test('Hermes 原生 API Server 端口优先于旧字段，忽略其他模块的 port', () => {
  assert.equal(resolveHermesGatewayPort({ platforms: { api_server: { port: 19982 } }, api_server_port: 19981, dashboard: { port: 9119 } }), 19982)
  assert.equal(resolveHermesGatewayPort({ platforms: { api_server: { port: '19982' } } }), 19982)
  assert.equal(resolveHermesGatewayPort({ api_server_port: 19981, dashboard: { port: 9119 } }), 19981)
  assert.equal(resolveHermesGatewayPort({ dashboard: { port: 9119 } }), 8642)
})

test('Hermes 端口解析拒绝非整数、布尔值和越界值', () => {
  for (const port of [null, true, 0, -1, 65536, 1.5, 'oops', '0x1000', '1e4']) {
    assert.equal(resolveHermesGatewayPort({ platforms: { api_server: { port } } }), 8642)
  }
})

test('Hermes 原生端口优先于环境端口，环境端口优先于旧面板别名', () => {
  assert.equal(resolveHermesGatewayPort({}, '19984'), 19984)
  assert.equal(resolveHermesGatewayPort({ api_server_port: 19981 }, '19984'), 19984)
  assert.equal(resolveHermesGatewayPort({ platforms: { api_server: { port: 19982 } } }, '19984'), 19982)
  assert.equal(resolveHermesGatewayPort({}, '65536'), 8642)
})
