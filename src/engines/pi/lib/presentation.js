/** 只处理展示，不改动 RPC 消息、模型标识和会话内容。 */
export const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
export const thinkingText = message => Array.isArray(message?.content) ? message.content.filter(block => block?.type === 'thinking').map(block => block.thinking || '').join('\n') : ''

export function modelOptions(models, providers = []) {
  const names = models.map(model => model.name || model.id)
  const labels = models.map((model, index) => {
    const name = names[index]
    if (names.filter(value => value === name).length === 1) return name
    if (models.filter(value => (value.name || value.id) === name && value.id === model.id).length === 1) return `${name} · ${model.id}`
    const provider = providers.find(value => value.id === model.provider)
    try { return `${name} · ${new URL(provider?.baseUrl).host}` } catch { return name }
  })
  return models.map((model, index) => ({
    ...model,
    value: JSON.stringify([model.provider, model.id]),
    label: labels.filter(value => value === labels[index]).length > 1 ? `${labels[index]} (${labels.slice(0, index + 1).filter(value => value === labels[index]).length})` : labels[index],
  }))
}

const toolKinds = {
  read: ['readFile', 'file-text'], write: ['writeFile', 'pen-tool'], edit: ['editFile', 'pen-tool'],
  bash: ['runCommand', 'terminal'], powershell: ['runCommand', 'terminal'],
  grep: ['searchFiles', 'search'], find: ['searchFiles', 'search'], ls: ['listFiles', 'folder'],
}

export function toolPresentation(call = {}, event = {}, result) {
  const args = call.arguments || event.args || {}
  const output = result || event.result || event.partialResult
  const text = messageText(output)
  const cancelled = /ClawPanel: user cancelled tool execution/i.test(text)
  const complete = Boolean(result) || event.type === 'tool_execution_end'
  const failed = Boolean(result?.isError || event.isError || output?.isError)
  const name = call.name || event.toolName || result?.toolName || ''
  const [labelKey, icon] = toolKinds[name] || ['tool', 'terminal']
  const path = String(args.path || args.file_path || '')
  return {
    labelKey, icon, name, args, output, text,
    target: path.split(/[\\/]/).filter(Boolean).at(-1) || '',
    status: cancelled ? 'cancelled' : complete ? (failed ? 'failed' : 'completed') : 'running',
  }
}

/** 将历史 toolResult 与实时工具事件合并到原调用位置，避免重复输出和顺序错乱。 */
export function conversationEntries(messages, tools = {}) {
  const results = new Map(messages.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]))
  const shown = new Set(), entries = []
  const addTool = (id, call, event, result, key) => {
    if (id && shown.has(id)) return
    if (id) shown.add(id)
    entries.push({ kind: 'tool', key, ...toolPresentation(call, event, result) })
  }
  messages.forEach((message, index) => {
    const key = `message-${index}`
    if (['user', 'assistant'].includes(message.role) && (messageText(message) || thinkingText(message) || message.errorMessage || message.stopReason === 'aborted')) {
      entries.push({ kind: 'message', key, message, text: messageText(message), thinking: thinkingText(message), aborted: message.stopReason === 'aborted' })
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      message.content.filter(block => block?.type === 'toolCall').forEach((call, callIndex) => addTool(call.id, call, tools[call.id], results.get(call.id), `${key}-tool-${callIndex}`))
    }
    if (message.role === 'toolResult') addTool(message.toolCallId, {}, tools[message.toolCallId], message, `${key}-result`)
  })
  Object.entries(tools).forEach(([id, event]) => addTool(id, {}, event, results.get(id), `tool-${id}`))
  return entries
}
