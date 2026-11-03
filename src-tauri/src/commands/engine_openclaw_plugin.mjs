// 官方provider正式扩展；只在受管隔离进程读取父进程传入的本机能力。
import { randomUUID } from 'node:crypto'

const connection = () => {
  const value = globalThis[Symbol.for('clawpanel.official.connection')]
  if (!value || value.engine !== 'openclaw') throw new Error('official_connection_required')
  return value
}
let pendingOperation = null

function wrapStreamFn({ streamFn }) {
  if (!streamFn) throw new Error('official_chat_transport_required')
  return (model, context, options) => {
    const dto = connection()
    if (!dto.models.some(item => item.id === model.id)) throw new Error('official_model_not_allowed')
    if (dto.modelId && dto.modelId !== model.id) throw new Error('official_model_not_allowed')
    // 工具由primary正式policy禁用；不能在transport层剪掉工具冒充文本模式。
    if (dto.textOnly === true && context.tools?.length) throw new Error('official_text_only_tools_unavailable')
    // 终态成功才释放ID；运行时若再次尝试未知结果，仍是原操作，网关不会二次派发。
    const operationId = pendingOperation ||= randomUUID().replaceAll('-', '_')
    // SDK的reasoning标记仅用于保留真实返回的思考字段；不更改目录能力或上游思考参数。
    const source = streamFn({ ...model, baseUrl: dto.baseUrl, api: 'openai-completions', reasoning: true,
      compat: { ...model.compat, supportsStore: false, supportsDeveloperRole: false,
        supportsReasoningEffort: false, thinkingFormat: 'openai', requiresReasoningContentOnAssistantMessages: false, strictMessageKeys: false,
        supportsPromptCacheKey: false, maxTokensField: 'max_tokens' } }, context,
    { ...options, reasoning: 'low', reasoningEffort: 'low', apiKey: dto.apiKey, maxRetries: 0, cacheRetention: 'none',
      headers: { ...options?.headers, 'X-ClawPanel-Operation-ID': operationId } })
    const completed = value => {
      if (value && !['error', 'aborted'].includes(value.stopReason) && pendingOperation === operationId) pendingOperation = null
      return value
    }
    const observe = stream => new Proxy(stream, { get(target, key) {
      if (key === 'result') return async () => completed(await target.result())
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const event of target) {
          if (event.type === 'done') completed(event.message)
          yield event
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    return typeof source?.then === 'function' ? source.then(observe) : observe(source)
  }
}

export default { id: 'clawpanel-official', name: 'ClawPanel official',
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  register(api) {
    connection()
    api.registerProvider({ id: 'clawpanel-official', label: 'ClawPanel official', auth: [],
      transformSystemPrompt(ctx) {
        const dto = connection()
        const selected = dto.models.find(model => model.id === dto.modelId)
        if (ctx.provider !== 'clawpanel-official' || ctx.agentId !== 'main'
          || dto.textOnly !== true || ctx.modelId !== dto.modelId
          || !selected || selected.capabilities?.tool_calls !== false) return
        // 仅此owned进程本人main文本会话；不改用户messages/历史或工具模型system。
        return "You are a text-only assistant. Tools, file access, commands and external actions are unavailable. Answer directly in the user's language. Do not claim to have performed actions."
      },
      wrapStreamFn, wrapSimpleCompletionStreamFn: wrapStreamFn })
  } }
