export async function readAssistantSSEStream(resp, onEvent, signal, timeoutChunk) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const onAbort = () => { try { reader.cancel() } catch {} }
  if (signal) {
    if (signal.aborted) { reader.cancel(); throw new DOMException('Aborted', 'AbortError') }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const readPromise = reader.read()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('流式响应超时：30 秒内未收到数据')), timeoutChunk)
      )
      const { done, value } = await Promise.race([readPromise, timeoutPromise])
      if (done) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('event:')) continue
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return
        try {
          onEvent(JSON.parse(data))
        } catch {}
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export function convertAssistantToolsForAnthropic(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }))
}

export function convertAssistantToolsForGemini(tools) {
  return [{ functionDeclarations: tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || { type: 'object', properties: {} },
  })) }]
}

export async function callAssistantChatCompletions({ base, messages, onChunk, signal, config, fetchWithRetry, authHeaders, setDebugInfo }) {
  const url = base + '/chat/completions'
  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature || 0.7,
  }

  const reqTime = Date.now()
  setDebugInfo({
    url,
    method: 'POST',
    requestBody: { ...body, messages: body.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '') : '[multimodal]' })) },
    requestTime: new Date(reqTime).toLocaleString('zh-CN'),
  })

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  })

  setDebugInfo(prev => ({
    ...prev,
    status: resp.status,
    contentType: resp.headers.get('content-type') || '',
    responseTime: new Date().toLocaleString('zh-CN'),
    latency: Date.now() - reqTime + 'ms',
  }))

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    setDebugInfo(prev => ({ ...prev, errorBody: errText.slice(0, 500) }))
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    setDebugInfo(prev => ({ ...prev, streaming: true }))
    let chunkCount = 0
    let contentChunks = 0
    let reasoningChunks = 0
    let reasoningBuf = ''

    await readAssistantSSEStream(resp, (json) => {
      chunkCount++
      const d = json.choices?.[0]?.delta
      if (!d) return
      if (d.content) {
        contentChunks++
        onChunk(d.content)
      } else if (d.reasoning_content) {
        reasoningChunks++
        reasoningBuf += d.reasoning_content
      }
    }, signal, 30000)

    setDebugInfo(prev => ({ ...prev, chunks: { total: chunkCount, content: contentChunks, reasoning: reasoningChunks } }))

    if (contentChunks === 0 && reasoningBuf) {
      console.warn('[assistant] 无 content 块，使用 reasoning_content 作为回复')
      onChunk(reasoningBuf)
      setDebugInfo(prev => ({ ...prev, fallbackToReasoning: true }))
    }
    return
  }

  setDebugInfo(prev => ({ ...prev, streaming: false }))
  const json = await resp.json()
  setDebugInfo(prev => ({ ...prev, responseBody: { id: json.id, model: json.model, object: json.object, usage: json.usage } }))
  console.log('[assistant] 非流式响应:', json)
  const msg = json.choices?.[0]?.message
  const content = msg?.content || msg?.reasoning_content || ''
  if (content) onChunk(content)
}

export async function callAssistantResponsesAPI({ base, messages, onChunk, signal, config, fetchWithRetry, authHeaders }) {
  const url = base + '/responses'
  const input = messages.filter(m => m.role !== 'system')
  const instructions = messages.find(m => m.role === 'system')?.content || ''

  const body = {
    model: config.model,
    input,
    instructions,
    stream: true,
    temperature: config.temperature || 0.7,
  }

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  await readAssistantSSEStream(resp, (json) => {
    if (json.type === 'response.output_text.delta') {
      if (json.delta) onChunk(json.delta)
    }
    if (json.choices?.[0]?.delta?.content) {
      onChunk(json.choices[0].delta.content)
    }
  }, signal, 30000)
}

export async function callAssistantAnthropicMessages({ base, messages, onChunk, signal, config, fetchWithRetry, authHeaders, setDebugInfo }) {
  const url = base + '/messages'
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  const body = {
    model: config.model,
    max_tokens: 8192,
    stream: true,
    temperature: config.temperature || 0.7,
  }
  if (systemMsg) body.system = systemMsg
  body.messages = chatMessages

  const reqTime = Date.now()
  setDebugInfo({
    url,
    method: 'POST',
    requestBody: { ...body, messages: body.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '') : '[multimodal]' })) },
    requestTime: new Date(reqTime).toLocaleString('zh-CN'),
  })

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  })

  setDebugInfo(prev => ({
    ...prev,
    status: resp.status,
    contentType: resp.headers.get('content-type') || '',
    responseTime: new Date().toLocaleString('zh-CN'),
    latency: Date.now() - reqTime + 'ms',
  }))

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    setDebugInfo(prev => ({ ...prev, errorBody: errText.slice(0, 500) }))
    let errMsg = `API 错误 ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {
      if (errText) errMsg += `: ${errText.slice(0, 200)}`
    }
    throw new Error(errMsg)
  }

  setDebugInfo(prev => ({ ...prev, streaming: true }))
  let chunkCount = 0
  let contentChunks = 0
  let thinkingChunks = 0
  let thinkingBuf = ''

  await readAssistantSSEStream(resp, (json) => {
    chunkCount++
    if (json.type === 'content_block_delta') {
      const delta = json.delta
      if (delta?.type === 'text_delta' && delta.text) {
        contentChunks++
        onChunk(delta.text)
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        thinkingChunks++
        thinkingBuf += delta.thinking
      }
    }
  }, signal, 30000)

  setDebugInfo(prev => ({ ...prev, chunks: { total: chunkCount, content: contentChunks, thinking: thinkingChunks } }))
  if (contentChunks === 0 && thinkingBuf) {
    console.warn('[assistant] Anthropic: 无 text 块，使用 thinking 作为回复')
    onChunk(thinkingBuf)
    setDebugInfo(prev => ({ ...prev, fallbackToThinking: true }))
  }
}

export async function callAssistantGeminiGenerate({ base, messages, onChunk, signal, config, fetchWithRetry, setDebugInfo }) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system')

  const contents = chatMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }))

  const body = {
    contents,
    generationConfig: { temperature: config.temperature || 0.7 },
  }
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] }

  const url = `${base}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`
  const reqTime = Date.now()
  setDebugInfo({ url: url.replace(config.apiKey, '***'), method: 'POST', requestTime: new Date(reqTime).toLocaleString('zh-CN') })

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  setDebugInfo(prev => ({ ...prev, status: resp.status, latency: Date.now() - reqTime + 'ms' }))

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }

  setDebugInfo(prev => ({ ...prev, streaming: true }))
  let chunkCount = 0
  await readAssistantSSEStream(resp, (json) => {
    chunkCount++
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) onChunk(text)
  }, signal, 30000)

  setDebugInfo(prev => ({ ...prev, chunks: { total: chunkCount } }))
}
