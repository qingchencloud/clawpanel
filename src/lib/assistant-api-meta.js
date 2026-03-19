export function normalizeAssistantApiType(raw) {
  const type = (raw || '').trim()
  if (type === 'anthropic' || type === 'anthropic-messages') return 'anthropic-messages'
  if (type === 'google-gemini') return 'google-gemini'
  if (type === 'openai' || type === 'openai-completions' || type === 'openai-responses') return 'openai-completions'
  return 'openai-completions'
}

export function requiresAssistantApiKey(apiType) {
  const type = normalizeAssistantApiType(apiType)
  return type === 'anthropic-messages' || type === 'google-gemini'
}

export function getAssistantApiHintText(apiType) {
  return {
    'openai-completions': '自动兼容 Chat Completions 和 Responses API；Ollama 可留空 API Key',
    'anthropic-messages': '使用 Anthropic Messages API（/v1/messages）',
    'google-gemini': '使用 Gemini generateContent API',
  }[normalizeAssistantApiType(apiType)] || '自动兼容 Chat Completions 和 Responses API；Ollama 可留空 API Key'
}

export function getAssistantApiBasePlaceholder(apiType) {
  return {
    'openai-completions': 'https://api.openai.com/v1 或 http://127.0.0.1:11434',
    'anthropic-messages': 'https://api.anthropic.com',
    'google-gemini': 'https://generativelanguage.googleapis.com/v1beta',
  }[normalizeAssistantApiType(apiType)] || 'https://api.openai.com/v1'
}

export function getAssistantApiKeyPlaceholder(apiType) {
  return {
    'openai-completions': 'sk-...（Ollama 可留空）',
    'anthropic-messages': 'sk-ant-...',
    'google-gemini': 'AIza...',
  }[normalizeAssistantApiType(apiType)] || 'sk-...'
}
