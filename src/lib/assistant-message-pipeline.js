export function createAssistantUserMessage({ text, images, buildMessageContent, persistImage }) {
  const textContent = text.trim()
  const msgContent = buildMessageContent(textContent, images)
  const userMsg = { role: 'user', content: msgContent, ts: Date.now() }

  if (images.length > 0) {
    userMsg._images = images.map(i => {
      const dbId = 'img_' + i.id
      persistImage(dbId, i.dataUrl)
      return { dbId, dataUrl: i.dataUrl, name: i.name, width: i.width, height: i.height }
    })
  }
  if (textContent) userMsg._text = textContent
  return userMsg
}

export function createAssistantAiPlaceholder() {
  return { role: 'assistant', content: '', ts: Date.now() }
}

export function createAssistantRequestContext(sessionId, nextRequestId, patchRequestState) {
  const requestId = nextRequestId(sessionId)
  const requestController = new AbortController()
  patchRequestState(sessionId, {
    streaming: true,
    abortController: requestController,
    status: 'streaming',
  })
  return { requestId, requestController }
}

export function buildAssistantRetryBarHtml() {
  const retrySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
  const continueSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
  return `
    <button class="btn btn-sm btn-primary ast-btn-retry">${retrySvg} 重试</button>
    <button class="btn btn-sm btn-secondary ast-btn-continue">${continueSvg} 输入继续</button>
    <span class="ast-retry-hint">请求失败（已自动重试 3 次）</span>
  `
}
