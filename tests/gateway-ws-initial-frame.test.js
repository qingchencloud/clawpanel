import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import test from 'node:test'
import { rawWsConnect, wsReadFrame } from '../scripts/dev-api.js'

const frame = (opcode, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  assert.ok(body.length < 126)
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
}
async function peer(initial, run) {
  let upstream, timer
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    upstream = socket
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const headers = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.write(Buffer.concat([headers, initial || Buffer.alloc(0)]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = await rawWsConnect('127.0.0.1', server.address().port, '/ws')
  try { await run(socket, upstream, callback => { timer = setTimeout(callback, 20) }) }
  finally { clearTimeout(timer); socket.destroy(); upstream?.destroy(); await new Promise(resolve => server.close(resolve)) }
}

test('真实 HTTP Upgrade 同包携带 challenge 时保留首帧', async () => {
  const challenge = JSON.stringify({ type: 'event', event: 'connect.challenge' })
  await peer(frame(1, challenge), async socket => assert.equal(await wsReadFrame(socket, 200), challenge))
})
test('Gateway 启动中关闭保留 1013 与原因，不把关闭帧作为 JSON', async () => {
  const code = Buffer.alloc(2); code.writeUInt16BE(1013)
  await peer(frame(8, Buffer.concat([code, Buffer.from('startup sidecars')])), async socket => {
    await assert.rejects(wsReadFrame(socket, 200), error => error.closeCode === 1013 && /closed.*1013.*startup sidecars/.test(error.message))
    assert.equal(socket.listenerCount('close'), 0)
  })
})
test('首帧前的 Ping/Pong 不冒充 challenge，并以掩码 Pong 回应', async () => {
  const challenge = JSON.stringify({ event: 'connect.challenge' })
  await peer(null, async (socket, upstream, later) => {
    const pong = new Promise(resolve => upstream.once('data', resolve))
    later(() => upstream.write(Buffer.concat([frame(9, 'hi'), frame(10, 'ignore'), frame(1, challenge)])))
    assert.equal(await wsReadFrame(socket, 300), challenge)
    const answer = await pong
    assert.equal(answer[0] & 0x0f, 10); assert.equal(answer[1] & 0x80, 0x80)
    const mask = answer.subarray(2, 6), bytes = answer.subarray(6)
    assert.equal(Buffer.from(bytes.map((byte, i) => byte ^ mask[i % 4])).toString(), 'hi')
  })
})
test('分包文本重组后解除读取监听，不积累 close 监听', async () => {
  await peer(null, async (socket, upstream, later) => {
    const data = frame(1, '{"ok":true}')
    later(() => { upstream.write(data.subarray(0, 3)); setTimeout(() => upstream.write(data.subarray(3)), 15) })
    assert.equal(await wsReadFrame(socket, 300), '{"ok":true}')
    assert.equal(socket.listenerCount('close'), 0)
    assert.equal(socket.listenerCount('data'), 0)
  })
})
test('二进制首帧和无状态码关闭仍明确失败', async () => {
  await peer(null, async (socket, upstream, later) => {
    later(() => upstream.write(frame(2, 'not-json')))
    await assert.rejects(wsReadFrame(socket, 300), /非文本|non-text/)
  })
  await peer(null, async (socket, upstream, later) => {
    later(() => upstream.write(frame(8, Buffer.alloc(0))))
    await assert.rejects(wsReadFrame(socket, 300), /closed/)
  })
})
