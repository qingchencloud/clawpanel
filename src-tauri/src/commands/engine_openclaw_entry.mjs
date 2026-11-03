// stdin首行仅供native传递连接，不写配置/日志；真实OpenClaw入口和工具循环不替换。
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const lines = readline.createInterface({ input: process.stdin, terminal: false })
const dto = await new Promise((resolve, reject) => {
  lines.once('line', line => { try { resolve(JSON.parse(line)) } catch { reject(new Error('official_connection_invalid')) } })
  lines.once('close', () => reject(new Error('official_connection_missing')))
})
lines.close()
const url = new URL(dto.baseUrl)
if (dto.engine !== 'openclaw' || dto.providerId !== 'clawpanel-official' || dto.apiKey !== 'clawpanel-local'
  || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
  || !/^\/engine\/[A-Za-z0-9_-]{16,128}\/v1$/.test(url.pathname) || !Array.isArray(dto.models)) throw new Error('official_connection_invalid')
// 模式来自原生当前所选模型；无工具模型必须明确使用正式禁工具策略。
const selectedId = dto.modelId ?? (dto.models.length === 1 ? dto.models[0].id : null)
const selected = dto.models.find(model => model.id === selectedId)
if (!selected || typeof selected.capabilities?.tool_calls !== 'boolean'
  || (selected.capabilities.tool_calls === false && dto.textOnly !== true)
  || (selected.capabilities.tool_calls === true && dto.textOnly === true)
  || ('toolsAvailable' in dto && dto.toolsAvailable !== selected.capabilities.tool_calls)) throw new Error('official_model_mode_invalid')
dto.modelId = selectedId
globalThis[Symbol.for('clawpanel.official.connection')] = dto
// 上游transport诊断包含请求URL；仅此owned进程按行脱敏，能力不得进stderr日志。
const rawWrite = process.stderr.write.bind(process.stderr)
const cap = url.pathname.split('/')[2]
let pendingDiagnostic = ''
process.stderr.write = (chunk, encoding, callback) => {
  pendingDiagnostic += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk)
  for (let index; (index = pendingDiagnostic.indexOf('\n')) >= 0;) {
    const line = pendingDiagnostic.slice(0, index + 1)
    pendingDiagnostic = pendingDiagnostic.slice(index + 1)
    rawWrite(line.replaceAll(cap, '<local-capability>'))
  }
  if (pendingDiagnostic.length > 65536) { pendingDiagnostic = ''; rawWrite('<runtime diagnostic omitted>\n') }
  const done = typeof encoding === 'function' ? encoding : callback
  if (done) queueMicrotask(done)
  return true
}
process.on('exit', () => { if (pendingDiagnostic) rawWrite(pendingDiagnostic.replaceAll(cap, '<local-capability>')) })
// 明确关闭入口自动respawn，防止第二个进程丢失只在内存的连接。
process.env.OPENCLAW_NO_RESPAWN = '1'
// 专用官方子进程的SDK文件日志会记录路由URL；仅此进程关闭，恢复依据保留在native安全journal。
process.env.OPENCLAW_LOG_LEVEL = 'silent'
process.env.NODE_DISABLE_COMPILE_CACHE = '1'
process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED = '1'
const entry = process.argv[2]
process.argv.splice(2, 1)
process.argv[1] = entry
await import(pathToFileURL(entry).href)
