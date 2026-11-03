// 原Gateway的可选官方provider；真实平台凭据和本机能力只保留在进程内。
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ID = 'clawpanel-official-gateway'
const PREFIX = '/plugins/clawpanel-official/'
const STATE = Symbol.for('clawpanel.official.gateway.state.v1')
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const agentId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const keys = (value, allowed, required = allowed) => plain(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k))
const same = (a, b) => !!a && !!b && a.memberId === b.memberId && a.epoch === b.epoch
const identity = value => keys(value, ['memberId', 'epoch']) && id(value.memberId) && Number.isSafeInteger(value.epoch) && value.epoch >= 0
const error = code => new Error(code)
const state = () => globalThis[STATE] ??= { connection: null, agentIds: new Set(), runs: new Map(), runOwners: new Map(), configAgents: {} }
const runKey = (agentId, sessionId) => agentId + '/' + sessionId

function officialSdk() {
  // 复用实际宿主的正式SDK、独立registry；不改原Gateway全局provider或BYOK重试设置。
  return state().sdkV6 ??= (async () => {
    if (!process.argv[1] || !path.isAbsolute(process.argv[1])) throw error('official_runtime_sdk_unavailable')
    const require = createRequire(pathToFileURL(process.argv[1]))
    const [{ createApiRegistry, createLlmRuntime, createAssistantMessageEventStream }, { registerBuiltInApiProviders }] = await Promise.all([
      import(pathToFileURL(require.resolve('@openclaw/ai')).href), import(pathToFileURL(require.resolve('@openclaw/ai/providers')).href),
    ])
    const registry = createApiRegistry(); registerBuiltInApiProviders(registry)
    return { runtime: createLlmRuntime(registry), createAssistantMessageEventStream }
  })()
}

function model(value) {
  if (!plain(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.id)) throw error('official_invalid_models')
  if (!Number.isSafeInteger(value.context_tokens) || value.context_tokens < 1 || value.context_tokens > 2000000 || !Number.isSafeInteger(value.max_output_tokens) || value.max_output_tokens < 1 || value.max_output_tokens > 262144) throw error('official_invalid_models')
  if (!plain(value.capabilities) || typeof value.capabilities.tool_calls !== 'boolean' || typeof value.capabilities.streaming !== 'boolean') throw error('official_invalid_models')
  return { id: value.id, context_tokens: value.context_tokens, max_output_tokens: value.max_output_tokens,
    capabilities: { tool_calls: value.capabilities.tool_calls, streaming: value.capabilities.streaming } }
}

function connection(value) {
  if (!keys(value, ['engine', 'providerId', 'baseUrl', 'apiKey', 'models', 'memberId', 'epoch']) || value.engine !== 'openclaw' || value.providerId !== 'clawpanel-official' || value.apiKey !== 'clawpanel-local' || !identity({ memberId: value.memberId, epoch: value.epoch }) || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 128) throw error('official_invalid_connection')
  const url = new URL(value.baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/engine\/[A-Za-z0-9_-]{16,128}\/v1$/.test(url.pathname) || url.href !== value.baseUrl) throw error('official_invalid_connection')
  const models = value.models.map(model)
  if (new Set(models.map(m => m.id)).size !== models.length) throw error('official_invalid_models')
  return { ...value, models, privateCap: url.pathname.split('/')[2], transportBase: url.origin + '/openclaw-gateway/v1' }
}

function configuredAgent(api, which) {
  const declaration = state().configAgents[which]
  const actual = api.config.agents?.list?.find(a => a.id === which)
  if (!declaration || !actual || !plain(actual.model) || actual.model.primary !== ID + '/' + declaration.modelId || !Array.isArray(actual.model.fallbacks) || actual.model.fallbacks.length !== 0) throw error('official_agent_configuration_required')
  return declaration
}

function transportPolicy(config, c) {
  // 不改原Gateway代理环境；只有显式绕过127的官方请求才可携带本机能力。
  const proxies = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
  if (proxies.some(key => typeof process.env[key] === 'string' && process.env[key].trim())) {
    const noProxy = process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim() || ''
    const port = new URL(c.transportBase).port
    if (noProxy !== '*' && !noProxy.split(/[,\s]+/).some(entry => entry === '127.0.0.1' || entry === '127.0.0.1:' + port)) throw error('official_loopback_proxy_bypass_required')
  }
  const provider = config?.models?.providers?.[ID]
  if (!provider || provider.request?.proxy || provider.models?.some(m => m.request?.proxy)) throw error('official_loopback_proxy_bypass_required')
}

function publicStatus() {
  const s = state(), c = s.connection
  return { available: true, adapterVersion: 8, attached: !!c, memberId: c?.memberId ?? null, epoch: c?.epoch ?? null,
    agentIds: [...s.agentIds], agentModels: Object.fromEntries(Object.entries(s.configAgents).map(([which, declaration]) => [which, declaration.modelId])), models: c?.models ?? [], activeRuns: [...s.runs.values()].map(r => ({ agentId: r.agentId, runId: r.runId, state: r.status,
      operationIds: [...r.stages.values()].map(v => v.operationId) })) }
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

async function route(api, action, req, res) {
  try {
    const peer = req.socket?.remoteAddress
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(peer) || req.headers.origin !== undefined || Object.keys(req.headers).some(k => k.startsWith('sec-fetch-')) || req.headers.host !== '127.0.0.1:' + req.socket.localPort || !/^Bearer \S+$/.test(req.headers.authorization ?? '') || !['token', 'password'].includes(api.config.gateway?.auth?.mode)) return respond(res, 403, { error: { code: 'official_control_forbidden' } })
    if (req.url !== PREFIX + action || req.method !== (action === 'status' ? 'GET' : 'POST')) return respond(res, 400, { error: { code: 'official_invalid_control_request' } })
    if (action === 'status') {
      if (req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) return respond(res, 400, { error: { code: 'official_invalid_control_request' } })
      return respond(res, 200, publicStatus())
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { error: { code: 'official_json_required' } })
    if (Number(req.headers['content-length'] ?? 0) > 131072) return respond(res, 413, { error: { code: 'official_control_body_too_large' } })
    req.setTimeout(3000, () => req.destroy())
    let length = 0; const chunks = []
    for await (const chunk of req) { length += chunk.length; if (length > 131072) return respond(res, 413, { error: { code: 'official_control_body_too_large' } }); chunks.push(chunk) }
    req.setTimeout(0)
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), s = state()
    if (action === 'reconcile') {
      if (!keys(body, ['expected', 'operations']) || !identity(body.expected) || !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 512
        || !body.operations.every(item => keys(item, ['operationId', 'state', 'replyComplete']) && typeof item.operationId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(item.operationId) && ['settled', 'released'].includes(item.state) && typeof item.replyComplete === 'boolean')
        || new Set(body.operations.map(item => item.operationId)).size !== body.operations.length) throw error('official_request_not_terminal')
      if (!same(s.connection, body.expected)) return respond(res, 409, { error: { code: 'official_connection_changed' } })
      // 只认同一会员已存在的原操作；当前epoch可恢复同会员旧epoch，不能替其他账号清锁。
      const records = [...s.runs].filter(([_key, r]) => r.memberId === s.connection.memberId && r.status === 'recovery_required')
      const stages = new Map(records.flatMap(([_key, r]) => [...r.stages.values()].map(v => [v.operationId, v])))
      const supplied = new Set(body.operations.map(item => item.operationId))
      if (records.length === 0) {
        const closed = [...s.runOwners.values()].filter(r => r.closed && r.memberId === s.connection.memberId)
        if (!body.operations.every(item => closed.some(r => r.operationIds?.includes(item.operationId)))) throw error('official_original_operation_required')
        return respond(res, 200, publicStatus())
      }
      if (body.operations.some(item => !stages.has(item.operationId))) throw error('official_original_operation_required')
      if ([...stages.values()].some(v => v.status !== 'completed' && !supplied.has(v.operationId))) return respond(res, 409, { error: { code: 'official_all_original_operations_required' } })
      for (const [key, record] of records) {
        const owner = s.runOwners.get(record.runId)
        if (!owner) throw error('official_run_identity_required')
        // 保留closed tombstone：原run的迟到自动retry永远不能重新分配模型操作ID。
        owner.closed = true; owner.operationIds = [...record.stages.values()].map(v => v.operationId)
        s.runs.delete(key)
      }
      return respond(res, 200, publicStatus())
    }
    if (action === 'detach') {
      if (!keys(body, ['expected']) || !identity(body.expected)) throw error('official_invalid_control_request')
      if (!same(s.connection, body.expected)) return respond(res, 409, { error: { code: 'official_connection_changed' } })
      s.connection = null; s.agentIds.clear()
      for (const r of s.runs.values()) if (r.status === 'running') r.status = 'recovery_required'
      return respond(res, 200, publicStatus())
    }
    if (!keys(body, ['connection', 'agentIds', 'expected']) || !(body.expected === null || identity(body.expected)) || !Array.isArray(body.agentIds) || body.agentIds.length < 1 || body.agentIds.length > 16 || !body.agentIds.every(agentId) || new Set(body.agentIds).size !== body.agentIds.length) throw error('official_invalid_control_request')
    const c = connection(body.connection)
    transportPolicy(api.config, c)
    if (s.connection ? !same(s.connection, body.expected) : body.expected !== null) return respond(res, 409, { error: { code: 'official_connection_changed' } })
    if (s.connection && !same(c, s.connection) && c.epoch <= s.connection.epoch) return respond(res, 409, { error: { code: 'official_connection_changed' } })
    for (const which of body.agentIds) {
      const declaration = configuredAgent(api, which)
      if (declaration.memberId !== c.memberId || !c.models.some(m => m.id === declaration.modelId)) throw error('official_agent_owner_mismatch')
    }
    s.connection = c; s.agentIds = new Set(body.agentIds)
    return respond(res, 200, publicStatus())
  } catch (e) {
    const code = typeof e?.message === 'string' && /^official_[a-z_]+$/.test(e.message) ? e.message : 'official_invalid_control_request'
    return respond(res, 400, { error: { code } })
  }
}

function gate(api, ctx) {
  const s = state(), declaration = s.configAgents[ctx.agentId], priorOwner = s.runOwners.get(ctx.runId)
  if (!declaration && !priorOwner) return { outcome: 'pass' }
  const block = code => ({ outcome: 'block', reason: code })
  if (!id(ctx.runId) || !id(ctx.sessionId)) return block('official_run_identity_required')
  if (priorOwner?.closed) return block('official_reply_unavailable')
  if (ctx.modelProviderId !== ID) return block('official_fallback_forbidden')
  const c = s.connection
  if (!c || !s.agentIds.has(ctx.agentId)) return block('official_connection_required')
  try { transportPolicy(api.config, c) } catch { return block('official_loopback_proxy_bypass_required') }
  try { configuredAgent(api, ctx.agentId) } catch { return block('official_agent_configuration_required') }
  if (declaration?.memberId !== c.memberId || priorOwner && !same(priorOwner, c)) return block('official_agent_owner_mismatch')
  if ([...s.runs.values()].some(r => r.agentId === ctx.agentId && r.status === 'recovery_required')) return block('official_request_recovery_required')
  const key = runKey(ctx.agentId, ctx.sessionId), prior = s.runs.get(key)
  if (prior) {
    if (prior.status === 'recovery_required') return block('official_request_recovery_required')
    if (prior.runId !== ctx.runId || prior.sessionId !== ctx.sessionId) return block('official_agent_busy')
  } else {
    if (s.runOwners.size > 2048) return block('official_run_limit')
    if (s.runs.size >= 64) return block('official_agent_busy')
    s.runs.set(key, { agentId: ctx.agentId, runId: ctx.runId, sessionId: ctx.sessionId, memberId: c.memberId, epoch: c.epoch, status: 'running', stages: new Map() })
    s.runOwners.set(ctx.runId, { memberId: c.memberId, epoch: c.epoch, agentId: ctx.agentId })
  }
  return { outcome: 'pass' }
}

async function officialPayload(payload, runtimeModel, previous) {
  // 先保留宿主payload hook的异步修改与返回值，再做纯文本的等价表示转换。
  const replacement = await previous?.(payload, runtimeModel)
  const value = replacement === undefined ? payload : replacement
  if (!plain(value) || !Array.isArray(value.messages)) throw error('official_unsupported_content')
  return { ...value, messages: value.messages.map(message => {
    if (!Array.isArray(message?.content)) return message
    if (message.content.length === 0 || !message.content.every(part => keys(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string')) throw error('official_unsupported_content')
    return { ...message, content: message.content.map(part => part.text).join('') }
  }) }
}

function wrap({ streamFn, agentId: which, config }) {
  if (typeof streamFn !== 'function') throw error('official_chat_transport_required')
  return (runtimeModel, context, options) => {
    const s = state(), c = s.connection, run = s.runs.get(runKey(which, options?.sessionId))
    if (!run || run.status !== 'running') throw error('official_request_recovery_required')
    if (!c || !same(c, run) || !s.agentIds.has(which)) throw error('official_connection_changed')
    transportPolicy(config, c)
    if (options?.sessionId !== run.sessionId) throw error('official_run_identity_required')
    // 在stage和SDK请求之前明确拒绝超限工具；不截断、不把未发送操作记成unknown。
    if (Array.isArray(context.tools) && context.tools.length > 32) return officialSdk().then(sdk => {
      // 正式错误流保留安全提示；未创建stage，不经过unknown观察器或模型HTTP。
      const stream = sdk.createAssistantMessageEventStream()
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Too many tools are enabled. Reduce tools in your dedicated Agent settings, then try again.' }],
        api: runtimeModel.api, provider: runtimeModel.provider, model: runtimeModel.id, stopReason: 'error', errorMessage: 'official_tool_limit_exceeded', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      stream.push({ type: 'error', reason: 'error', error: message }); stream.end()
      return stream
    })
    const catalog = c.models.find(m => m.id === runtimeModel.id)
    if (!catalog) throw error('official_model_not_allowed')
    if (!catalog.capabilities.tool_calls && context.tools?.length) throw error('official_tools_not_supported')
    const fingerprint = createHash('sha256').update(JSON.stringify({ model: runtimeModel.id, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools })).digest('hex')
    let stage = run.stages.get(fingerprint)
    if (stage?.status === 'completed') throw error('official_reply_unavailable')
    if (stage?.status === 'unknown') throw error('official_request_recovery_required')
    if (!stage) { if (run.stages.size >= 64) throw error('official_stage_limit'); stage = { operationId: randomUUID().replaceAll('-', '_'), status: 'inflight' }; run.stages.set(fingerprint, stage) }
    const unknown = () => { stage.status = 'unknown'; run.status = 'recovery_required' }
    const completed = value => {
      if (!value || ['error', 'aborted'].includes(value.stopReason)) { unknown(); return value ? { ...value, errorMessage: 'official_request_recovery_required' } : value }
      stage.status = 'completed'; return value
    }
    const observe = stream => new Proxy(stream, { get(target, key) {
      if (key === 'result') return async () => { try { return completed(await target.result()) } catch { unknown(); throw error('official_request_recovery_required') } }
      if (key === Symbol.asyncIterator) return async function* () { try { for await (const event of target) { if (event.type === 'done') completed(event.message); if (event.type === 'error') { unknown(); yield { ...event, error: { ...event.error, errorMessage: 'official_request_recovery_required' } }; continue } yield event } } catch { unknown(); throw error('official_request_recovery_required') } }
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    try {
      // 仅让SDK记录并续传真实收到的思考字段；不向上游强开思考，也不生成空白占位。
      const source = officialSdk().then(sdk => sdk.runtime.streamSimple({ ...runtimeModel, baseUrl: c.transportBase, api: 'openai-completions', reasoning: true,
        compat: { ...runtimeModel.compat, supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: 'openai', requiresReasoningContentOnAssistantMessages: false, strictMessageKeys: false, supportsPromptCacheKey: false, maxTokensField: 'max_tokens' } }, context,
      { ...options, reasoning: 'low', reasoningEffort: 'low', apiKey: 'clawpanel-local', maxRetries: 0, cacheRetention: 'none', onPayload: (payload, model) => officialPayload(payload, model, options?.onPayload), headers: { ...options?.headers, 'X-ClawPanel-Engine-Token': c.privateCap, 'X-ClawPanel-Operation-ID': stage.operationId } }))
      return typeof source?.then === 'function' ? source.then(observe, () => { unknown(); throw error('official_request_recovery_required') }) : observe(source)
    } catch { unknown(); throw error('official_request_recovery_required') }
  }
}

function textOnlySystemPrompt(api, ctx) {
  const s = state(), c = s.connection
  if (ctx.provider !== ID || !c || !s.agentIds.has(ctx.agentId)) return
  let declaration
  try { declaration = configuredAgent(api, ctx.agentId) } catch { return }
  if (declaration.memberId !== c.memberId || declaration.modelId !== ctx.modelId) return
  const selected = c.models.find(model => model.id === ctx.modelId)
  if (!selected || selected.capabilities.tool_calls !== false) return
  // 正式provider hook仅用于本人专属文本Agent；原消息/历史和其他system保持原样。
  return "You are a text-only assistant. Tools, file access, commands and external actions are unavailable. Answer directly in the user's language. Do not claim to have performed actions."
}

export default {
  id: ID, name: 'ClawPanel official Gateway',
  register(api) {
    const s = state()
    s.configAgents = structuredClone(api.pluginConfig?.agents ?? {})
    for (const action of ['attach', 'detach', 'status', 'reconcile']) api.registerHttpRoute({ path: PREFIX + action, auth: 'gateway', match: 'exact', handler: (req, res) => route(api, action, req, res) })
    api.on('before_model_resolve', (_event, ctx) => {
      if (!state().configAgents[ctx.agentId]) return
      // 专属Agent不能被全局模型可见列表改选BYOK；最终授权仍由run门逐次核验。
      try { const declaration = configuredAgent(api, ctx.agentId); return { providerOverride: ID, modelOverride: declaration.modelId } } catch { return }
    })
    api.on('before_agent_run', (_event, ctx) => gate(api, ctx))
    api.on('agent_end', (_event, ctx) => {
      const key = runKey(ctx.agentId, ctx.sessionId), r = state().runs.get(key)
      if (!r || r.runId !== ctx.runId) return
      if ([...r.stages.values()].some(v => v.status !== 'completed')) r.status = 'recovery_required'
      if (r.status === 'running') { state().runs.delete(key); state().runOwners.delete(ctx.runId) }
    })
    api.registerProvider({ id: ID, label: 'ClawPanel official Gateway', auth: [],
      resolveSyntheticAuth: () => ({ apiKey: 'clawpanel-local', source: 'clawpanel-official-memory', mode: 'api-key' }),
      transformSystemPrompt: ctx => textOnlySystemPrompt(api, ctx),
      wrapStreamFn: wrap, wrapSimpleCompletionStreamFn: wrap })
  },
}
