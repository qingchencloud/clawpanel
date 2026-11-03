// 仅官方独立profile使用的HTTP调用边界；不接触平台凭据或普通Provider。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function validateOfficialConnection(value, engine) {
  if (!value || value.engine !== engine || value.providerId !== 'clawpanel-official' || value.apiKey !== 'clawpanel-local'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.memberId || '') || !Number.isSafeInteger(value.epoch) || value.epoch < 1) throw Error('official_connection_invalid')
  const url = new URL(value.baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
    || !/^\/engine\/[A-Za-z0-9_-]{16,128}\/v1$/.test(url.pathname)) throw Error('official_connection_invalid')
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 64) throw Error('official_models_unavailable')
  const ids = new Set()
  for (const model of value.models) {
    if (!/^official\/[a-z0-9][a-z0-9_-]{0,63}$/.test(model.id || '') || ids.has(model.id)) throw Error('official_models_unavailable')
    ids.add(model.id)
  }
  return value
}

function recoveryResponse(id) {
  return new Response(JSON.stringify({ error: { message: 'official_request_recovery_required', code: 'official_request_recovery_required', type: 'clawpanel_official' } }), {
    status: 409, headers: { 'content-type': 'application/json', 'x-clawpanel-operation-id': id || '' },
  })
}

async function safeErrorCode(response) {
  try {
    const reader = response.clone().body?.getReader()
    if (!reader) return 'error_body_unavailable'
    let text = ''
    while (true) { const r = await reader.read(); if (r.done) break; if (text.length + r.value.length > 8192) { reader.cancel().catch(() => {}); return 'error_body_unavailable' } text += new TextDecoder().decode(r.value) }
    const value = JSON.parse(text)
    const code = value.error?.code || value.code
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : 'error_code_unavailable'
  } catch { return 'error_code_unavailable' }
}

export function installOfficialFetch({ connection, journalPath, currentInvocation = () => null }) {
  validateOfficialConnection(connection, connection.engine)
  const alias = new URL(connection.baseUrl)
  alias.pathname = '/v1'
  const publicBaseUrl = alias.href.replace(/\/$/, '')
  const original = globalThis.fetch.bind(globalThis)
  let records = {}
  if (fs.existsSync(journalPath)) {
    const loaded = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    if (loaded.memberId !== connection.memberId || loaded.epoch !== connection.epoch || !loaded.records || typeof loaded.records !== 'object') throw Error('official_operation_journal_invalid')
    records = loaded.records
  }
  const persist = () => {
    // 派发之前保存随机ID，只保归属/正文hash，不保存模型正文；失败关闭。
    const tmp = journalPath + '.next'
    fs.writeFileSync(tmp, JSON.stringify({ memberId: connection.memberId, epoch: connection.epoch, records }), { mode: 0o600 })
    fs.renameSync(tmp, journalPath)
  }
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    if (!raw.startsWith(publicBaseUrl + '/')) return original(input, init)
    const request = new Request(input, init)
    if (request.method === 'GET' && raw === publicBaseUrl + '/models') return original(new Request(connection.baseUrl + '/models', { headers: request.headers, redirect: 'error' }))
    if (request.method !== 'POST' || raw !== publicBaseUrl + '/chat/completions') return recoveryResponse()
    const context = currentInvocation()
    const turn = context?.turnId || request.headers.get('x-clawpanel-turn-id')
    if (!turn || turn.length > 512 || /[\x00-\x1f]/.test(turn)) return recoveryResponse()
    const bytes = new Uint8Array(await request.clone().arrayBuffer())
    if (bytes.length > 1024 * 1024) return recoveryResponse()
    const bodyHash = crypto.createHash('sha256').update(bytes).digest('hex')
    const key = crypto.createHash('sha256').update(turn).update('\0').update(bodyHash).digest('hex')
    let record = records[key]
    if (!record) {
      // 有界日志满时拒绝新增，不淘汰可能仍需恢复的旧调用。
      if (Object.keys(records).length >= 4096) return recoveryResponse()
      const shape = JSON.parse(new TextDecoder().decode(bytes))
      record = records[key] = {
        operationId: context?.operationId || crypto.randomUUID().replaceAll('-', '_'), bodyHash,
        bodyKeys: Object.keys(shape).sort(),
        messageContentTypes: (shape.messages || []).map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map(p => p.type) : typeof m.content })),
        toolCount: Array.isArray(shape.tools) ? shape.tools.length : 0,
        parallelToolCalls: typeof shape.parallel_tool_calls === 'boolean' ? shape.parallel_tool_calls : null,
      }
      persist()
    }
    // 已派发的同一次调用只允许恢复；SDK/agent重试不再次触发HTTP模型派发。
    if (record.dispatched) return recoveryResponse(record.operationId)
    record.dispatched = true
    persist()
    const headers = new Headers(request.headers)
    headers.delete('x-clawpanel-turn-id')
    headers.set('x-clawpanel-operation-id', record.operationId)
    headers.set('authorization', 'Bearer clawpanel-local')
    try {
      const response = await original(new Request(connection.baseUrl + '/chat/completions', { method: 'POST', body: bytes, headers, signal: request.signal, redirect: 'error' }))
      record.httpStatus = response.status
      if (!response.ok) record.errorCode = await safeErrorCode(response)
      persist()
      // 仅把可触发agent自动重试的失败转成明确恢复错误，绝不当成功返回。
      if (response.status >= 500) { await response.body?.cancel(); return recoveryResponse(record.operationId) }
      return response
    } catch { record.errorCode = 'transport_unavailable'; persist(); return recoveryResponse(record.operationId) }
  }
  return () => { globalThis.fetch = original }
}

export function openCodeOfficialPluginSource() {
  return `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installOfficialFetch } from './opencode-official-transport.mjs';
const connection=JSON.parse(fs.readFileSync(0,'utf8'));
installOfficialFetch({connection,journalPath:fileURLToPath(new URL('./operations-'+connection.epoch+'.json',import.meta.url))});
export default async()=>({
  'chat.headers':async(input,output)=>{
    if(input.model.providerID!=='clawpanel-official')return;
    if(!input.sessionID||!input.message?.id)throw Error('official_message_identity_required');
    output.headers['x-clawpanel-turn-id']=input.sessionID+':'+input.message.id;
  }
});
`
}

export function dshOfficialPluginSource(llmModule) {
  return `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAgentLoopRequest } from ${JSON.stringify(llmModule)};
import { installOfficialFetch } from './opencode-official-transport.mjs';
const connection=JSON.parse(fs.readFileSync(0,'utf8'));
const scope=new AsyncLocalStorage();
installOfficialFetch({connection,journalPath:fileURLToPath(new URL('./operations-'+connection.epoch+'.json',import.meta.url)),currentInvocation:()=>scope.getStore()});
export const name='clawpanel-official-operation';
export const inject=['llm'];
export function apply(ctx){
 ctx.on('llm/stream',(options,next)=>{
  if(options.provider!=='clawpanel-official')return next();
  // 标题等后台辅助调用不使用本人积分；只接正式agent loop请求。
  if(!isAgentLoopRequest(options))throw Error('official_interactive_request_required');
  const operationId=crypto.randomUUID().replaceAll('-','_');
  const state={operationId,turnId:String(options.sessionId||'session')+':'+operationId};
  return (async function*(){
   const iterator=scope.run(state,()=>next()[Symbol.asyncIterator]());
   try{while(true){const value=await scope.run(state,()=>iterator.next());if(value.done)return;yield value.value;}}
   finally{if(iterator.return)await scope.run(state,()=>iterator.return());}
  })();
 });
}
`
}

export function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
}
