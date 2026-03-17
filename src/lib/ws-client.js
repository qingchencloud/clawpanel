/**
 * WebSocket 客户端 - 直连 OpenClaw Gateway
 *
 * 协议流程（直连模式）：
 * 1. 连接 ws://host/ws?token=xxx
 * 2. Gateway 发 connect.challenge（带 nonce）
 * 3. 客户端调用 Tauri 后端生成 Ed25519 签名的 connect frame
 * 4. Gateway 返回 connect 响应（带 snapshot）
 * 5. 从 snapshot.sessionDefaults.mainSessionKey 获取 sessionKey
 * 6. 开始正常通信
 */
import { api } from './tauri-api.js'

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

const REQUEST_TIMEOUT = 30000
const MAX_RECONNECT_DELAY = 30000
const PING_INTERVAL = 25000
const CHALLENGE_TIMEOUT = 5000

export class WsClient {
  constructor() {
    this._ws = null
    this._url = ''
    this._token = ''
    this._pending = new Map()
    this._eventListeners = []
    this._statusListeners = []
    this._readyCallbacks = []
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._connected = false
    this._gatewayReady = false
    this._handshaking = false
    this._connecting = false
    this._intentionalClose = false
    this._snapshot = null
    this._hello = null
    this._sessionKey = null
    this._pingTimer = null
    this._challengeTimer = null
    this._wsId = 0
    this._autoPairAttempts = 0
    this._serverVersion = null
  }

  get connected() { return this._connected }
  get connecting() { return this._connecting }
  get gatewayReady() { return this._gatewayReady }
  get snapshot() { return this._snapshot }
  get hello() { return this._hello }
  get sessionKey() { return this._sessionKey }
  get serverVersion() { return this._serverVersion }

  onStatusChange(fn) {
    this._statusListeners.push(fn)
    return () => { this._statusListeners = this._statusListeners.filter(cb => cb !== fn) }
  }

  onReady(fn) {
    this._readyCallbacks.push(fn)
    return () => { this._readyCallbacks = this._readyCallbacks.filter(cb => cb !== fn) }
  }

  connect(host, token, opts = {}) {
    this._intentionalClose = false
    this._autoPairAttempts = 0
    this._token = token || ''
    // 自动检测协议：如果页面通过 HTTPS 加载（反代场景），使用 wss://
    const proto = opts.secure ?? (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws'
    const nextUrl = `${proto}://${host}/ws?token=${encodeURIComponent(this._token)}`
    if (this._connecting || this._handshaking || this._gatewayReady) {
      if (this._url === nextUrl) return
    }
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return
    this._url = nextUrl
    this._doConnect()
  }

  disconnect() {
    this._intentionalClose = true
    this._stopPing()
    this._clearReconnectTimer()
    this._clearChallengeTimer()
    this._flushPending()
    this._closeWs()
    this._setConnected(false)
    this._gatewayReady = false
    this._handshaking = false
  }

  reconnect() {
    if (!this._url) return
    this._intentionalClose = false
    this._reconnectAttempts = 0
    this._autoPairAttempts = 0
    this._stopPing()
    this._clearReconnectTimer()
    this._clearChallengeTimer()
    this._flushPending()
    this._closeWs()
    this._doConnect()
  }

  _doConnect() {
    this._connecting = true
    this._closeWs()
    this._gatewayReady = false
    this._handshaking = false
    this._setConnected(false, 'connecting')
    const wsId = ++this._wsId
    let ws
    try { ws = new WebSocket(this._url) } catch { this._scheduleReconnect(); return }
    this._ws = ws

    ws.onopen = () => {
      if (wsId !== this._wsId) return
      this._connecting = false
      this._reconnectAttempts = 0
      this._setConnected(true)
      this._startPing()
      // 等 Gateway 发 connect.challenge，超时则主动发
      this._challengeTimer = setTimeout(() => {
        if (!this._handshaking && !this._gatewayReady) {
          console.log('[ws] 未收到 challenge，主动发 connect')
          this._sendConnectFrame('')
        }
      }, CHALLENGE_TIMEOUT)
    }

    ws.onmessage = (evt) => {
      if (wsId !== this._wsId) return
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }
      this._handleMessage(msg)
    }

    ws.onclose = (e) => {
      if (wsId !== this._wsId) return
      this._ws = null
      this._connecting = false
      this._clearChallengeTimer()
      if (e.code === 4001 || e.code === 4003 || e.code === 4004) {
        this._setConnected(false, 'auth_failed', e.reason || 'Token 认证失败')
        this._intentionalClose = true
        this._flushPending()
        return
      }
      if (e.code === 1008 && !this._intentionalClose) {
        if (this._autoPairAttempts < 1) {
          console.log('[ws] origin not allowed (1008)，尝试自动修复...')
          this._setConnected(false, 'reconnecting', 'origin not allowed，修复中...')
          this._autoPairAndReconnect()
          return
        }
        console.warn('[ws] origin 1008 自动修复已尝试过，显示错误')
        this._setConnected(false, 'error', e.reason || 'origin not allowed，请点击「修复并重连」')
        return
      }
      this._setConnected(false)
      this._gatewayReady = false
      this._handshaking = false
      this._stopPing()
      this._flushPending()
      if (!this._intentionalClose) this._scheduleReconnect()
    }

    ws.onerror = () => {}
  }

  _handleMessage(msg) {
    // 握手阶段：connect.challenge
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      console.log('[ws] 收到 connect.challenge')
      this._clearChallengeTimer()
      const nonce = msg.payload?.nonce || ''
      this._sendConnectFrame(nonce)
      return
    }

    // 握手响应：connect 的 res
    if (msg.type === 'res' && msg.id?.startsWith('connect-')) {
      this._clearChallengeTimer()
      this._handshaking = false
      if (!msg.ok || msg.error) {
        const errMsg = msg.error?.message || 'Gateway 握手失败'
        const errCode = msg.error?.code
        console.error('[ws] connect 失败:', errMsg, errCode)

        // 如果是配对/origin 错误，尝试自动配对（仅一次，防止无限循环）
        if (errCode === 'NOT_PAIRED' || errCode === 'PAIRING_REQUIRED' || /origin not allowed/i.test(errMsg)) {
          if (this._autoPairAttempts < 1) {
            console.log('[ws] 检测到配对/origin 错误，尝试自动修复...', errCode || errMsg)
            this._autoPairAndReconnect()
            return
          }
          console.warn('[ws] 自动修复已尝试过，不再重试')
        }

        this._setConnected(false, 'error', errMsg)
        this._readyCallbacks.forEach(fn => {
          try { fn(null, null, { error: true, message: errMsg }) } catch {}
        })
        return
      }
      // 握手成功，提取 snapshot
      this._handleConnectSuccess(msg.payload)
      return
    }

    // RPC 响应
    if (msg.type === 'res') {
      const cb = this._pending.get(msg.id)
      if (cb) {
        this._pending.delete(msg.id)
        clearTimeout(cb.timer)
        if (msg.ok) cb.resolve(msg.payload)
        else cb.reject(new Error(msg.error?.message || msg.error?.code || 'request failed'))
      }
      return
    }

    // 事件转发
    if (msg.type === 'event') {
      this._eventListeners.forEach(fn => {
        try { fn(msg) } catch (e) { console.error('[ws] handler error:', e) }
      })
    }
  }

  async _autoPairAndReconnect() {
    this._autoPairAttempts++
    try {
      console.log('[ws] 执行自动配对（第', this._autoPairAttempts, '次）...')
      const result = await api.autoPairDevice()
      console.log('[ws] 配对结果:', result)

      // 配对后需要 reload Gateway 使 allowedOrigins 生效
      try {
        await api.reloadGateway()
        console.log('[ws] Gateway 已重载')
      } catch (e) {
        console.warn('[ws] reloadGateway 失败（非致命）:', e)
      }

      console.log('[ws] 配对成功，2秒后重新连接...')
      setTimeout(() => {
        if (!this._intentionalClose) {
          this.reconnect()
        }
      }, 2000)
    } catch (e) {
      console.error('[ws] 自动配对失败:', e)
      this._setConnected(false, 'error', `配对失败: ${e}`)
    }
  }

  async _sendConnectFrame(nonce) {
    this._handshaking = true
    try {
      const frame = await api.createConnectFrame(nonce, this._token)
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        console.log('[ws] 发送 connect frame')
        this._ws.send(JSON.stringify(frame))
      }
    } catch (e) {
      console.error('[ws] 生成 connect frame 失败:', e)
      this._handshaking = false
    }
  }

  _handleConnectSuccess(payload) {
    this._autoPairAttempts = 0
    this._hello = payload || null
    this._snapshot = payload?.snapshot || null
    this._serverVersion = payload?.serverVersion || null
    const defaults = this._snapshot?.sessionDefaults
    if (defaults?.mainSessionKey) {
      this._sessionKey = defaults.mainSessionKey
    } else {
      const agentId = defaults?.defaultAgentId || 'main'
      this._sessionKey = `agent:${agentId}:main`
    }
    this._gatewayReady = true
    console.log('[ws] Gateway 就绪, sessionKey:', this._sessionKey)
    this._setConnected(true, 'ready')
    this._readyCallbacks.forEach(fn => {
      try { fn(this._hello, this._sessionKey) } catch (e) {
        console.error('[ws] ready cb error:', e)
      }
    })
  }

  _setConnected(val, status, errorMsg) {
    this._connected = val
    const s = status || (val ? 'connected' : 'disconnected')
    this._statusListeners.forEach(fn => {
      try { fn(s, errorMsg) } catch (e) { console.error('[ws] status listener error:', e) }
    })
  }

  _closeWs() {
    if (this._ws) {
      const old = this._ws
      this._ws = null
      this._wsId++
      try { old.close() } catch {}
    }
  }

  _flushPending() {
    for (const [, cb] of this._pending) {
      clearTimeout(cb.timer)
      cb.reject(new Error('连接已断开'))
    }
    this._pending.clear()
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _clearChallengeTimer() {
    if (this._challengeTimer) {
      clearTimeout(this._challengeTimer)
      this._challengeTimer = null
    }
  }

  _scheduleReconnect() {
    this._clearReconnectTimer()
    const delay = this._reconnectAttempts < 3
      ? 1000
      : Math.min(1000 * Math.pow(2, this._reconnectAttempts - 2), MAX_RECONNECT_DELAY)
    this._reconnectAttempts++
    this._setConnected(false, 'reconnecting')
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay)
  }

  _startPing() {
    this._stopPing()
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send('{"type":"ping"}') } catch {}
      }
    }, PING_INTERVAL)
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._gatewayReady) {
        if (!this._intentionalClose && (this._reconnectAttempts > 0 || !this._gatewayReady)) {
          const waitTimeout = setTimeout(() => { unsub(); reject(new Error('等待重连超时')) }, 15000)
          const unsub = this.onReady((hello, sessionKey, err) => {
            clearTimeout(waitTimeout); unsub()
            if (err?.error) { reject(new Error(err.message || 'Gateway 握手失败')); return }
            this.request(method, params).then(resolve, reject)
          })
          return
        }
        return reject(new Error('WebSocket 未连接'))
      }
      const id = uuid()
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error('请求超时')) }, REQUEST_TIMEOUT)
      this._pending.set(id, { resolve, reject, timer })
      this._ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  chatSend(sessionKey, message, attachments) {
    const params = { sessionKey, message, deliver: false, idempotencyKey: uuid() }
    if (attachments && attachments.length > 0) {
      params.attachments = attachments
      console.log('[ws] 发送附件:', attachments.length, '个')
      console.log('[ws] 附件详情:', attachments.map(a => ({ type: a.type, mime: a.mimeType, name: a.fileName, size: a.content?.length })))
    }
    return this.request('chat.send', params)
  }

  chatHistory(sessionKey, limit = 200) {
    return this.request('chat.history', { sessionKey, limit })
  }

  chatAbort(sessionKey, runId) {
    const params = { sessionKey }
    if (runId) params.runId = runId
    return this.request('chat.abort', params)
  }

  sessionsList(limit = 50) {
    return this.request('sessions.list', { limit })
  }

  sessionsDelete(key) {
    return this.request('sessions.delete', { key })
  }

  sessionsReset(key) {
    return this.request('sessions.reset', { key })
  }

  onEvent(callback) {
    this._eventListeners.push(callback)
    return () => { this._eventListeners = this._eventListeners.filter(fn => fn !== callback) }
  }
}

const _g = typeof window !== 'undefined' ? window : globalThis
if (!_g.__clawpanelWsClient) _g.__clawpanelWsClient = new WsClient()
export const wsClient = _g.__clawpanelWsClient
