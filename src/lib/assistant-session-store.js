import { normalizeAssistantApiType } from './assistant-api-meta.js'

export function loadAssistantConfig(storage, storageKey, defaults) {
  let config = null
  try {
    const raw = storage.getItem(storageKey)
    config = raw ? JSON.parse(raw) : null
  } catch {
    config = null
  }
  if (!config) {
    config = {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.7,
      tools: { terminal: false, fileOps: false, webSearch: false },
      assistantName: defaults.name,
      assistantPersonality: defaults.personality,
    }
  }
  if (!config.assistantName) config.assistantName = defaults.name
  if (!config.assistantPersonality) config.assistantPersonality = defaults.personality
  if (!config.tools) config.tools = { terminal: false, fileOps: false, webSearch: false }
  if (!config.mode) config.mode = defaults.mode
  config.apiType = normalizeAssistantApiType(config.apiType)
  if (config.autoRounds === undefined) config.autoRounds = 8
  if (!Array.isArray(config.knowledgeFiles)) config.knowledgeFiles = []
  return config
}

export function saveAssistantConfig(storage, storageKey, config) {
  storage.setItem(storageKey, JSON.stringify(config))
}

export function loadAssistantSessions(storage, storageKey) {
  try {
    const raw = storage.getItem(storageKey)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function serializeAssistantSessions(sessions, maxSessions) {
  const normalized = Array.isArray(sessions) ? sessions.slice(-(maxSessions || 50)) : []
  const serialized = JSON.stringify(normalized, (key, value) => {
    if (key === 'dataUrl' && typeof value === 'string' && value.startsWith('data:image/')) return undefined
    if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) return '[image]'
    return value
  })
  return { sessions: normalized, serialized }
}

export function createAssistantSession(createId) {
  return {
    id: createId(),
    title: '新会话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function getAutoSessionTitle(session) {
  if (!session?.messages?.length || session.title !== '新会话') return null
  const firstUser = session.messages.find(m => m.role === 'user')
  if (!firstUser) return null
  const txt = firstUser._text || (typeof firstUser.content === 'string' ? firstUser.content : (firstUser.content?.find?.(p => p.type === 'text')?.text || '[图片消息]'))
  const firstLine = txt.split('\n').find(l => l.trim()) || txt
  return firstLine.slice(0, 30) + (firstLine.length > 30 ? '...' : '')
}
