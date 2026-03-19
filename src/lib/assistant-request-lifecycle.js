export function mountAssistantRetryBar({ messagesEl, buildRetryBarHtml, onRetry, onContinue }) {
  if (!messagesEl) return null
  const retryBar = document.createElement('div')
  retryBar.className = 'ast-retry-bar'
  retryBar.innerHTML = buildRetryBarHtml()
  messagesEl.appendChild(retryBar)
  messagesEl.scrollTop = messagesEl.scrollHeight

  retryBar.querySelector('.ast-btn-retry')?.addEventListener('click', () => onRetry?.(retryBar))
  retryBar.querySelector('.ast-btn-continue')?.addEventListener('click', () => onContinue?.(retryBar))
  return retryBar
}

export function finalizeAssistantRequestLifecycle({
  session,
  requestId,
  clearRequestState,
  getSessionStatus,
  currentSessionId,
  messagesEl,
  renderMessages,
  flushSave,
  processQueue,
  focusTextarea,
  isActiveRequest,
}) {
  clearRequestState(session.id, {
    keepStatus: getSessionStatus(session.id) === 'error',
    requestId,
  })
  if (currentSessionId === session.id) focusTextarea?.()
  session.updatedAt = Date.now()
  flushSave()
  if (isActiveRequest(session.id, requestId) && messagesEl && currentSessionId === session.id) {
    renderMessages()
    messagesEl.scrollTop = messagesEl.scrollHeight
  }
  setTimeout(() => processQueue(session.id), 100)
}
