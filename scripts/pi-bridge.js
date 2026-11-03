/** 桌面端私有桥：只绑定回环随机端口，认证令牌从环境注入，父进程退出即释放会话。 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import * as bridgeFs from 'node:fs'
import * as bridgePath from 'node:path'
import { PiRuntime } from './pi-runtime.js'

export async function startPiBridge() {
  const root = process.env.CLAWPANEL_PI_ROOT
  const token = process.env.CLAWPANEL_PI_TOKEN
  if (!root || !token) throw new Error('Pi 桥缺少私有启动参数')
  const runtime = new PiRuntime({
    root,
    readChannel: id => {
      const file = bridgePath.resolve(root, '..', 'model-channels.json')
      const doc = bridgeFs.existsSync(file) ? JSON.parse(bridgeFs.readFileSync(file, 'utf8')) : {}
      const channel = (doc.channels || []).find(channel => channel.id === id)
      if (!channel) return null
      const reference = String(channel.apiKey || '').match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
      if (!reference) return channel
      // 与 Web 一样支持 OpenClaw env / .env；只解析变量，不执行凭据命令。
      const configDir = bridgePath.resolve(root, '..', '..')
      const configFile = bridgePath.join(configDir, 'openclaw.json')
      const config = bridgeFs.existsSync(configFile) ? JSON.parse(bridgeFs.readFileSync(configFile, 'utf8')) : {}
      const envFile = bridgePath.join(configDir, '.env')
      const dotenv = {}
      if (bridgeFs.existsSync(envFile)) for (const line of bridgeFs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const entry = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (entry) dotenv[entry[1]] = entry[2].trim().replace(/^(['"])(.*)\1$/, '$2')
      }
      const key = reference[1]
      const apiKey = config.env?.vars?.[key] ?? config.env?.[key] ?? dotenv[key] ?? process.env[key]
      if (typeof apiKey !== 'string' || !apiKey) throw new Error('Pi 渠道密钥环境变量未配置')
      return { ...channel, apiKey }
    },
    registry: () => {
      const file = bridgePath.resolve(root, '..', '..', 'npm-registry.txt')
      return bridgeFs.existsSync(file) ? bridgeFs.readFileSync(file, 'utf8').trim() || 'https://registry.npmjs.org' : 'https://registry.npmjs.org'
    },
  })
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''))
    const expected = Buffer.from(token)
    if (req.method !== 'POST' || req.url !== '/call' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end(); return
    }
    try {
      let bytes = 0
      const chunks = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Pi 请求超过 2 MiB'); chunks.push(chunk) }
      const { command, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const result = await runtime.call(command, args || {})
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: runtime.redact(error.message) }))
    }
  })
  server.requestTimeout = 0
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n')
  const shutdown = async () => { await runtime.dispose(); server.closeAllConnections(); server.close(); process.exit(0) }
  process.stdin.resume()
  process.stdin.once('end', shutdown)
  process.once('SIGTERM', shutdown)
  return { runtime, server }
}
