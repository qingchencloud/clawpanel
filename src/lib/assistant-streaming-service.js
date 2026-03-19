export function updateAssistantToolProgress({ history, aiMsg, lastContainer, renderToolBlocks, throttledSave, messagesEl }) {
  aiMsg.toolHistory = history
  throttledSave()
  if (!lastContainer) return
  const toolHtml = renderToolBlocks(history)
  const bubble = lastContainer.querySelector('.ast-msg-bubble-ai')
  lastContainer.innerHTML = toolHtml + (bubble ? bubble.outerHTML : '')
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
}

export function appendAssistantStreamChunk({ aiMsg, chunk, throttledSave, lastBubble, renderMarkdown, messagesEl, lastRenderTime, now = Date.now(), throttleMs = 50 }) {
  aiMsg.content += chunk
  throttledSave()
  if (!lastBubble) return lastRenderTime
  if (now - lastRenderTime <= throttleMs) return lastRenderTime
  lastBubble.innerHTML = renderMarkdown(aiMsg.content) + '<span class="ast-cursor">▊</span>'
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
  return now
}

export function finalizeAssistantStreamBubble(lastBubble, content, renderMarkdown) {
  if (!lastBubble) return
  lastBubble.innerHTML = renderMarkdown(content)
}
