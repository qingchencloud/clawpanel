import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GATEWAY_LOOPBACK_ORIGIN,
  gatewayWebSocketUpstreamHeaders,
  serializeGatewayWebSocketHeaders,
} from '../scripts/gateway-ws-proxy.js'

test('Web Gateway 代理把远程浏览器 Origin 规范化为本机可信来源', () => {
  const headers = gatewayWebSocketUpstreamHeaders({
    host: 'panel.example.com:1420',
    origin: 'https://panel.example.com',
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'abc',
  }, 18789)

  assert.equal(headers.host, '127.0.0.1:18789')
  assert.equal(headers.origin, GATEWAY_LOOPBACK_ORIGIN)
  assert.equal(headers.upgrade, 'websocket')
  assert.equal(headers['sec-websocket-key'], 'abc')
})

test('Web Gateway 代理序列化时清除头部换行，避免请求走样', () => {
  const serialized = serializeGatewayWebSocketHeaders({
    origin: 'https://remote.example',
    'x-test': 'one\r\ntwo',
  }, 19981)

  assert.match(serialized, /host: 127\.0\.0\.1:19981/)
  assert.match(serialized, /origin: http:\/\/localhost/)
  assert.match(serialized, /x-test: one two/)
  assert.doesNotMatch(serialized, /x-test: one\r\ntwo/)
})
