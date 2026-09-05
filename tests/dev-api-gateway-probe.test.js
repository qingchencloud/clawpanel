import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

import { probeTcpPort } from '../scripts/dev-api.js'

test('Web Gateway 端口探测在 ESM 运行时返回布尔值', async () => {
  const server = net.createServer(socket => socket.end())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.equal(await probeTcpPort(address.port, '127.0.0.1', 1000), true)

  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert.equal(await probeTcpPort(address.port, '127.0.0.1', 1000), false)
})
