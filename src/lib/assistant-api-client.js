import { normalizeAssistantApiType } from './assistant-api-meta.js'

export function cleanAssistantBaseUrl(raw, apiType) {
  let base = (raw || '').replace(/\/+$/, '')
  base = base.replace(/\/api\/chat\/?$/, '')
  base = base.replace(/\/api\/generate\/?$/, '')
  base = base.replace(/\/api\/tags\/?$/, '')
  base = base.replace(/\/api\/?$/, '')
  base = base.replace(/\/chat\/completions\/?$/, '')
  base = base.replace(/\/completions\/?$/, '')
  base = base.replace(/\/responses\/?$/, '')
  base = base.replace(/\/messages\/?$/, '')
  base = base.replace(/\/models\/?$/, '')
  const type = normalizeAssistantApiType(apiType)
  if (type === 'anthropic-messages') {
    if (!base.endsWith('/v1')) base += '/v1'
    return base
  }
  if (type === 'google-gemini') return base
  if (/:(11434)$/i.test(base) && !base.endsWith('/v1')) return `${base}/v1`
  return base
}

export function buildAssistantAuthHeaders(apiType, apiKey = '') {
  const type = normalizeAssistantApiType(apiType)
  const key = apiKey || ''
  if (type === 'anthropic-messages') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (key) headers['x-api-key'] = key
    return headers
  }
  const headers = {
    'Content-Type': 'application/json',
  }
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

export async function fetchAssistantWithRetry(url, options, retries = 3) {
  const delays = [1000, 2000, 4000]
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, options)
      if (resp.ok || resp.status < 500 || i >= retries) return resp
      const retryAfter = Number(resp.headers.get('retry-after') || 0)
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : delays[i]
      await new Promise(r => setTimeout(r, waitMs))
    } catch (err) {
      lastErr = err
      if (options?.signal?.aborted) throw err
      if (i >= retries) throw err
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
  throw lastErr || new Error('请求失败')
}
