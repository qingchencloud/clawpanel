/** Pi 事件归约：最终消息覆盖 delta，任务只在 agent_settled 后结束。 */
export const createPiState = snapshot => ({
  messages: snapshot?.messages || [], busy: Boolean(snapshot?.busy),
  dialogs: snapshot?.pendingDialogs || [], tools: {}, error: '', active: -1,
})

export function applyPiEvent(state, event) {
  if (event.type === 'agent_start') state.busy = true
  if (event.type === 'agent_settled') { state.busy = false; state.dialogs = []; state.active = -1 }
  if (event.type === 'message_start') {
    state.messages.push(structuredClone(event.message))
    state.active = event.message.role === 'assistant' ? state.messages.length - 1 : -1
  }
  if (event.type === 'message_update') {
    if (state.active < 0) {
      state.messages.push({ role: 'assistant', content: [] })
      state.active = state.messages.length - 1
    }
    // Pi 在 message_update 中附带累计快照；优先使用它，避免初始内容与 delta 重复。
    if (event.message?.role === 'assistant') {
      state.messages[state.active] = structuredClone(event.message)
      return state
    }
    const update = event.assistantMessageEvent || {}
    const message = state.messages[state.active]
    if (!Array.isArray(message.content)) message.content = []
    const index = update.contentIndex ?? 0
    const key = update.type?.startsWith('thinking') ? 'thinking' : 'text'
    if (['text_start', 'thinking_start', 'text_delta', 'thinking_delta', 'text_end', 'thinking_end'].includes(update.type)) {
      // 新版 JSON/RPC 删除累计快照；start 表示新块，不能复用 message_start 的首段文本。
      if (update.type.endsWith('_start')) message.content[index] = { type: key, [key]: '' }
      const block = message.content[index] ||= { type: key, [key]: '' }
      if (update.type.endsWith('_delta')) block[key] = (block[key] || '') + (update.delta || '')
      if (update.type.endsWith('_end')) block[key] = update.content || ''
    }
  }
  if (event.type === 'message_end') {
    const index = state.active >= 0 && event.message.role === 'assistant' ? state.active : state.messages.length - 1
    if (index >= 0 && state.messages[index]?.role === event.message.role) state.messages[index] = structuredClone(event.message)
    else state.messages.push(structuredClone(event.message))
    if (event.message.role === 'assistant') {
      state.active = -1
      if (event.message.errorMessage && event.message.stopReason !== 'aborted') state.error = event.message.errorMessage
    }
  }
  if (event.type?.startsWith('tool_execution_')) state.tools[event.toolCallId] = event
  if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
    state.dialogs = [...state.dialogs.filter(dialog => dialog.id !== event.id), event]
  }
  if (event.type === 'dialog_resolved') state.dialogs = state.dialogs.filter(dialog => dialog.id !== event.id)
  if (['process_exit', 'extension_error'].includes(event.type)) {
    state.error = event.error || 'Pi process exited'
    if (event.type === 'process_exit') state.busy = false
  }
  if (event.type === 'auto_retry_end' && !event.success) state.error = event.finalError || ''
  return state
}
