import { toLocalAssistantImages } from './history-view-model.js'

export function takePendingHistoryPayload(state, options = {}) {
  if (!state) return null
  if (!options.hasMessagesEl) return null
  if (options.isBusy) return null
  if (!state.pendingHistoryPayload) return null

  const payload = state.pendingHistoryPayload
  const payloadTs = options.maxHistoryTimestamp(payload?.messages || [])
  state.pendingHistoryPayload = null
  state.pendingHistoryTs = 0

  if (payloadTs && payloadTs <= Number(state.lastHistoryAppliedTs || 0)) return null
  return payload
}

export function renderLocalHistoryMessages(messages = [], handlers) {
  messages.forEach(msg => {
    if (!msg.content && !msg.attachments?.length) return
    const msgTime = msg.timestamp ? new Date(msg.timestamp) : new Date()
    if (msg.role === 'user') {
      handlers.appendUserMessage(msg.content || '', msg.attachments || null, msgTime)
      return
    }
    if (msg.role === 'assistant') {
      const images = toLocalAssistantImages(msg.attachments || [])
      handlers.appendAiMessage(msg.content || '', msgTime, images, [], [], [], [])
      return
    }
    handlers.appendSystemMessage(msg.content || '', msgTime?.getTime?.() || Date.now())
  })
}
