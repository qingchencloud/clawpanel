import test from 'node:test'
import assert from 'node:assert/strict'
import { WsClient } from '../src/lib/ws-client.js'

const startup = { code: 'UNAVAILABLE', message: 'gateway starting', retryable: true, retryAfterMs: 100, details: { reason: 'startup-sidecars', method: 'chat.send' } }

function gateway(replies) {
  const client = new WsClient()
  const calls = []
  client._gatewayReady = true
  client._ws = { readyState: WebSocket.OPEN, send(text) {
    const frame = JSON.parse(text)
    calls.push(frame)
    const error = replies.shift()
    queueMicrotask(() => client._handleMessage({ type: 'res', id: frame.id, ok: !error, error, payload: { runId: 'accepted' } }))
  } }
  return { client, calls }
}

test('首聊被启动阶段明确拒绝后使用原消息与幂等键，收到受理即停止', async () => {
  const { client, calls } = gateway([startup, null])
  assert.equal((await client.chatSend('a', 'hello')).runId, 'accepted')
  assert.deepEqual(calls.map(frame => frame.method), ['chat.send', 'chat.send'])
  assert.ok(calls[0].params.idempotencyKey)
  assert.deepEqual(calls[0].params, calls[1].params)
})

test('权限、普通不可用或未确认可重试的错误只发送一次', async () => {
  for (const change of [{ code: 'FORBIDDEN' }, { retryable: false }, { details: { reason: 'unavailable' } }]) {
    const { client, calls } = gateway([{ ...startup, ...change }])
    await assert.rejects(client.chatSend('a', 'hello'))
    assert.equal(calls.length, 1)
  }
})

test('切换模型只更新指定会话，权限拒绝或超时不会再触发聊天', async () => {
  for (const error of [null, { code: 'FORBIDDEN' }, { code: 'TIMEOUT' }]) {
    const { client, calls } = gateway([error])
    const change = client.sessionsSetModel('agent:main:chosen', 'local/model')
    if (error) await assert.rejects(change)
    else await change
    assert.deepEqual(calls.map(({ method, params }) => [method, params]), [
      ['sessions.patch', { key: 'agent:main:chosen', model: 'local/model' }],
    ])
  }
})

test('启动等待期间取消会话或更换连接时丢弃重试', async () => {
  for (const action of ['abort', 'reconnect']) {
    const { client, calls } = gateway([startup, null])
    const send = assert.rejects(client.chatSend('a', 'hello'))
    await new Promise(resolve => setImmediate(resolve))
    if (action === 'abort') await client.chatAbort('a')
    else client._wsId++
    await send
    assert.equal(calls.filter(frame => frame.method === 'chat.send').length, 1)
  }
})
