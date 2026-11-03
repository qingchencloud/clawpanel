import { readFileSync } from 'node:fs'
import https from 'node:https'

// 仅供本地传输验收；公钥和 leaf 私钥均为公开测试材料，不写入系统信任库。
const [protocol, nonce] = process.argv.slice(2)
if (!['TLSv1.2', 'TLSv1.3'].includes(protocol) || !/^[a-zA-Z0-9-]{1,128}$/.test(nonce || '')) {
  throw new Error('Expected an exact TLS protocol and a test nonce')
}
const fixture = JSON.parse(readFileSync(new URL('./tls-localhost.json', import.meta.url), 'utf8'))
const fixtureName = 'clawpanel-https-transport'
const maxBodyBytes = 128 * 1024
const sockets = new Set()
let requestCount = 0
let stopping = false

const server = https.createServer({
  cert: fixture.certificatePem,
  key: fixture.privateKeyPem,
  minVersion: protocol,
  maxVersion: protocol,
  ALPNProtocols: ['http/1.1'],
}, (request, response) => {
  requestCount += 1
  const sequence = requestCount
  const chunks = []
  let length = 0
  request.on('data', chunk => {
    length += chunk.length
    if (length > maxBodyBytes) request.destroy()
    else chunks.push(chunk)
  })
  request.on('error', () => response.destroy())
  request.on('end', () => {
    if (request.method !== 'POST' || request.url !== '/transport') {
      response.writeHead(404).end()
      return
    }
    let received
    try {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400).end()
      return
    }
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      fixture: fixtureName,
      nonce,
      protocol: request.socket.getProtocol(),
      method: request.method,
      path: request.url,
      requestCount: sequence,
      received,
    }))
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    // 跨多次写入和 TLS record，便于暴露截断、重复明文与 UTF-8 边界问题。
    response.write(body.subarray(0, 8191))
    setImmediate(() => {
      if (!response.destroyed) response.end(body.subarray(8191))
    })
  })
})

server.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
server.on('tlsClientError', (_error, socket) => socket.destroy())
server.on('error', () => process.exit(1))
server.requestTimeout = 5000
server.headersTimeout = 5000

const stop = () => {
  if (stopping) return
  stopping = true
  server.close(() => process.exit(0))
  for (const socket of sockets) socket.destroy()
  process.stdin.destroy()
}
// 父进程只操作自己创建的 Child；stdin 关闭时服务也自行退出。
process.stdin.setEncoding('utf8')
let control = ''
process.stdin.on('data', chunk => {
  control += chunk
  if (control.length > 32 || control.includes('\n')) {
    if (control === 'stop\n') stop()
    else process.exit(2)
  }
})
process.stdin.on('end', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
  const address = server.address()
  // stdout 只发布这一行；后续不记录请求、证书、环境或密钥。
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    fixture: fixtureName,
    pid: process.pid,
    host: address.address,
    port: address.port,
    protocol,
    nonce,
    nodeVersion: process.version,
  })}\n`)
})
