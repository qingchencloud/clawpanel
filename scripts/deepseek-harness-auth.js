import { normalizeDshPort } from './deepseek-harness.js'

export function redactDshOutput(text) {
  return String(text).replace(/([?&]token=)[^\s)]+/g, '$1[REDACTED]')
}

// 只接收受管子进程的就绪行；上游令牌/Cookie 只存内存，不写状态、日志或浏览器存储。
export function createDshAuth(portValue, { fetchImpl = globalThis.fetch } = {}) {
  const port = normalizeDshPort(portValue)
  let token = '', cookie = '', pending = null
  return {
    get modern() { return !!token },
    observe(line) {
      const match = String(line).match(/^dsh web: (http:\/\/[^\s]+)/)
      if (!match) return
      try {
        const url = new URL(match[1])
        const next = url.searchParams.get('token') || ''
        if (url.hostname === '127.0.0.1' && Number(url.port) === port && url.pathname === '/' && /^[A-Za-z0-9_-]{43}$/.test(next)) {
          if (next !== token) cookie = ''
          token = next
        }
      } catch {}
    },
    async headers() {
      if (!token) return {}
      if (cookie) return { cookie }
      if (!pending) pending = (async () => {
        const response = await fetchImpl(`http://127.0.0.1:${port}/?token=${token}`, {
          redirect: 'manual', signal: AbortSignal.timeout(8000),
        })
        const received = (response.headers.get('set-cookie') || '').split(';')[0]
        // 0.2+ 改用 ./，只接受新旧两种根跳转，不放宽到任意跳转地址。
        if (response.status !== 303 || !['/', './'].includes(response.headers.get('location')) || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(received)) {
          throw new Error(`DeepSeek Harness 会话认证失败: HTTP ${response.status}`)
        }
        cookie = received
      })().catch(() => { throw new Error('DeepSeek Harness 会话认证失败，请重新启动受管服务') }).finally(() => { pending = null })
      await pending
      return { cookie }
    },
  }
}
