import crypto from 'node:crypto'

import {
  buildOpenClawConnectFrame,
  rawWsConnect,
  wsReadFrame,
  wsReadLoop,
  wsSendFrame,
} from './dev-api.js'

const url = process.env.OPENCLAW_SMOKE_URL || 'ws://127.0.0.1:18789/ws'
const gatewayToken = process.env.OPENCLAW_SMOKE_TOKEN || ''
const gatewayPassword = process.env.OPENCLAW_SMOKE_PASSWORD || ''

if (!gatewayToken && !gatewayPassword) {
  throw new Error('请通过 OPENCLAW_SMOKE_TOKEN 或 OPENCLAW_SMOKE_PASSWORD 提供测试凭据')
}

const keyPair = crypto.generateKeyPairSync('ed25519')
const publicDer = keyPair.publicKey.export({ type: 'spki', format: 'der' })
const publicRaw = publicDer.subarray(-32)
const keyData = {
  deviceId: crypto.createHash('sha256').update(publicRaw).digest('hex'),
  publicKey: Buffer.from(publicRaw).toString('base64url'),
  privateKey: keyPair.privateKey,
}

const target = new URL(url)
const socket = await rawWsConnect(target.hostname, Number(target.port || 80), target.pathname || '/ws')
const challenge = JSON.parse(await wsReadFrame(socket, 15_000))
if (challenge.type !== 'event' || challenge.event !== 'connect.challenge') {
  socket.destroy()
  throw new Error('Gateway 未发送 connect.challenge')
}
const frame = buildOpenClawConnectFrame({
  nonce: challenge.payload?.nonce || '',
  challengeTs: challenge.payload?.ts,
  gatewayToken,
  gatewayPassword,
  keyData,
})
const responsePromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Gateway connect 响应超时')), 15_000)
  wsReadLoop(socket, text => {
    let candidate
    try { candidate = JSON.parse(text) } catch { return }
    if (candidate.type !== 'res' || candidate.id !== frame.id) return
    clearTimeout(timer)
    resolve(candidate)
  }, 16_000)
})
wsSendFrame(socket, JSON.stringify(frame))
const message = await responsePromise
socket.destroy()
if (!message.ok) {
  const code = message.error?.details?.code || message.error?.code || 'CONNECT_FAILED'
  throw new Error(`${code}: ${message.error?.message || `Gateway 返回非成功帧 ${JSON.stringify(message)}`}`)
}
const result = {
  ok: true,
  protocol: message.payload?.protocol ?? null,
  serverVersion: message.payload?.serverVersion ?? null,
}

console.log(JSON.stringify(result))
