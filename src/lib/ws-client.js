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
import { t } from './i18n.js'
import { KERNEL_TARGET } from './feature-catalog.js'

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

const REQUEST_TIMEOUT = 30000
const MAX_RECONNECT_DELAY = 60000
const PING_INTERVAL = 30000
const CHALLENGE_TIMEOUT = 15000
const MAX_RECONNECT_ATTEMPTS = 20
const HEARTBEAT_TIMEOUT = 90000
const MESSAGE_CACHE_SIZE = 100
// Gateway 启动前的初始重连延迟（更长，给 Gateway 充足的重启/初始化时间）
const INITIAL_RECONNECT_DELAY = 10000

/**
 * 判断 RPC 错误是否为「method 不被当前 Gateway 支持」类型。
 * 用于跨内核兼容降级：老内核没有的新 RPC 应该被静默吃掉，而不是 toast 给小白用户。
 *
 * 上游 Gateway 错误码可能是：METHOD_NOT_FOUND / UNKNOWN_METHOD / UNKNOWN_RPC / NOT_IMPLEMENTED
 * 错误消息可能包含 "method ... not found" / "unknown method" / "no handler"
 */
function isMethodUnsupportedError(err) {
  if (!err) return false
  const code = String(err.code || '').toUpperCase()
  if (
    code === 'METHOD_NOT_FOUND' ||
    code === 'UNKNOWN_METHOD' ||
    code === 'UNKNOWN_RPC' ||
    code === 'NOT_IMPLEMENTED' ||
    code === 'UNSUPPORTED'
  ) return true
  const msg = String(err.message || '').toLowerCase()
  if (/method\s+.*\s+not\s+(found|implemented|supported)/.test(msg)) return true
  if (/unknown\s+(method|rpc|handler)/.test(msg)) return true
  if (/no\s+handler\s+for/.test(msg)) return true
  return false
}

/**
 * 判断 Gateway 关闭原因是否暗示 v3 协议 / 签名 payload 不被支持。
 * 老内核（仅 v1/v2 签名 payload，minProtocol < 3）会用类似 `device signature invalid`
 * 或 `protocol mismatch` 关闭，字面对小白用户毫无意义，需要替换为人话。
 */
function isProtocolIncompatReason(reason) {
  return /signature\s+invalid|invalid\s+signature|protocol\s+mismatch|unsupported\s+protocol|min(imum)?\s*protocol|max(imum)?\s*protocol/i.test(reason || '')
}

/**
 * 构造「Gateway 内核过旧、不支持当前握手协议」的友好提示文案。
 * 直接读 feature-catalog 的 KERNEL_TARGET 常量，避免循环依赖 kernel.js。
 */
function kernelTooOldMessage() {
  const recommended =
    KERNEL_TARGET?.openclaw?.chinese ||
    KERNEL_TARGET?.openclaw?.official ||
    '2026.5.x'
  return t('kernel.tooOldForProtocol', { recommended })
}

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
    this._authRetryCount = 0
    this._password = ''
    this._serverVersion = null

    // 增强状态追踪
    this._lastConnectedAt = null
    this._lastMessageAt = null
    this._pendingReconnect = false
    this._missedHeartbeats = 0
    this._heartbeatTimer = null
    this._reconnectState = 'idle' // idle | attempting | scheduled

    // 消息缓存
    this._messageCache = new Map()
    this._cacheSize = MESSAGE_CACHE_SIZE
    this._seenMessageIds = new Set()

    // 跨内核兼容：当前 Gateway 已确认不支持的 RPC method 名集合
    // 由 requestCompat 在收到 method-not-found 类错误时填充，连接断开时清空
    this._unsupportedMethods = new Set()
  }

  get connected() { return this._connected }
  get connecting() { return this._connecting }
  get gatewayReady() { return this._gatewayReady }
  get snapshot() { return this._snapshot }
  get hello() { return this._hello }
  get sessionKey() { return this._sessionKey }
  get serverVersion() { return this._serverVersion }
  /**
   * 当前 Gateway 与 ClawPanel 协商出的握手协议版本 (3 或 4)。
   *
   * 注意:这里的 "协议版本" 指 Gateway WebSocket 握手帧协议 (kernel ws frame protocol),
   * 不要与设备签名 payload 的前缀 `v3|deviceId|...` 混淆,后者是 device-signature
   * payload 字符串格式版本,两者完全独立。
   *
   * 取值优先级:
   *   1. hello payload 中显式回传的 protocol / protocolVersion / negotiatedProtocol 字段
   *   2. 按 serverVersion 推断:OpenClaw 内核 >= 2026.5.12 → v4,否则 v3
   *      (ClawPanel 客户端永远声明 minProtocol=3, maxProtocol=4,所以协商只会是 3 或 4)
   *
   * 未握手时返回 null。
   */
  get negotiatedProtocol() {
    if (!this._hello) return null
    const explicit = this._hello.protocol ?? this._hello.protocolVersion ?? this._hello.negotiatedProtocol
    if (Number.isFinite(explicit)) return explicit
    const ver = this._serverVersion
    if (!ver) return null
    const base = String(ver).replace(/-.*$/, '')
    const parts = base.split('.').map(n => Number(n))
    if (parts.length >= 3 && parts.every(Number.isFinite)) {
      const [y, mo, d] = parts
      if (y > 2026 || (y === 2026 && (mo > 5 || (mo === 5 && d >= 12)))) return 4
    }
    return 3
  }
  get reconnectState() { return this._reconnectState }
  get reconnectAttempts() { return this._reconnectAttempts }
  get lastConnectedAt() { return this._lastConnectedAt }
  get lastMessageAt() { return this._lastMessageAt }

  /**
   * 获取连接详细信息，供前端使用
   */
  getConnectionInfo() {
    return {
      connected: this._connected,
      gatewayReady: this._gatewayReady,
      lastConnectedAt: this._lastConnectedAt,
      lastMessageAt: this._lastMessageAt,
      reconnectAttempts: this._reconnectAttempts,
      reconnectState: this._reconnectState,
      serverVersion: this._serverVersion,
      negotiatedProtocol: this.negotiatedProtocol,
      missedHeartbeats: this._missedHeartbeats,
      pendingReconnect: this._pendingReconnect,
    }
  }

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
    this._password = opts.password || ''
    // 自动检测协议：如果页面通过 HTTPS 加载（反代场景），使用 wss://
    const proto = opts.secure ?? (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws'
    const nextUrl = `${proto}://${host}/ws?token=${encodeURIComponent(this._token)}`
    if (this._connecting || this._handshaking || this._gatewayReady) {
      if (this._url === nextUrl) return
    }
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return
    this._url = nextUrl
    this._lastConnectedAt = Date.now()
    this._doConnect()
  }

  disconnect() {
    this._intentionalClose = true
    this._stopPing()
    this._stopHeartbeat()
    this._clearReconnectTimer()
    this._clearChallengeTimer()
    this._flushPending()
    this._closeWs()
    this._setConnected(false)
    this._gatewayReady = false
    this._handshaking = false
    this._reconnectState = 'idle'
    this._pendingReconnect = false
  }

  reconnect() {
    if (!this._url) return
    this._intentionalClose = false
    this._reconnectAttempts = 0
    this._autoPairAttempts = 0
    this._authRetryCount = 0
    this._missedHeartbeats = 0
    this._stopPing()
    this._stopHeartbeat()
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
    this._reconnectState = 'attempting'
    this._setConnected(false, 'connecting')
    const wsId = ++this._wsId
    let ws
    try { ws = new WebSocket(this._url) } catch { this._scheduleReconnect(); return }
    this._ws = ws

    ws.onopen = () => {
      if (wsId !== this._wsId) return
      this._connecting = false
      this._reconnectAttempts = 0
      this._missedHeartbeats = 0
      this._lastConnectedAt = Date.now()
      this._lastMessageAt = Date.now()
      this._startHeartbeat()
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
      const reason = (e.reason || '').toLowerCase()

      // ── 4001: Gateway 配置热重载 / 设备被移除 ──
      // 上游仅在 config reload 和 device removal 时发 4001
      // 正确做法：短延迟后自动重连，而非永久断开
      if (e.code === 4001) {
        console.log('[ws] Gateway 配置变更，3秒后自动重连:', e.reason)
        this._setConnected(false, 'reconnecting', 'Gateway 配置已更新，自动重连中...')
        this._gatewayReady = false
        this._handshaking = false
        this._stopPing()
        setTimeout(() => {
          if (!this._intentionalClose) {
            this._reconnectAttempts = 0
            this._doConnect()
          }
        }, 3000)
        return
      }

      // ── 1008: 握手期策略拒绝（按 reason 文本精确分流）──
      if (e.code === 1008 && !this._intentionalClose) {
        if (/origin not allowed/i.test(reason)) {
          // Origin 不在白名单 → 自动配对（写 allowedOrigins + reload）
          if (this._autoPairAttempts < 1) {
            console.log('[ws] origin not allowed，尝试自动修复...')
            this._setConnected(false, 'reconnecting', 'origin 修复中...')
            this._autoPairAndReconnect()
            return
          }
          this._setConnected(false, 'error', 'origin not allowed，请检查 gateway.controlUi.allowedOrigins 配置')
          return
        }
        if (/unauthorized/i.test(reason)) {
          // Token/password 不匹配 → 尝试刷新凭据并重连
          if (this._authRetryCount < 2) {
            this._authRetryCount++
            console.log(`[ws] 认证失败，刷新凭据 (${this._authRetryCount}/2):`, e.reason)
            this._setConnected(false, 'reconnecting', `认证失败，刷新凭据中 (${this._authRetryCount}/2)...`)
            this._refreshCredentialsAndReconnect()
            return
          }
          this._setConnected(false, 'auth_failed', `认证失败: ${e.reason || 'token mismatch'}。请检查 Gateway Token 配置。`)
          this._intentionalClose = true
          this._flushPending()
          return
        }
        if (/pairing required/i.test(reason) || /not.paired/i.test(reason)) {
          // 设备未配对 → 自动配对
          if (this._autoPairAttempts < 1) {
            console.log('[ws] 设备未配对，尝试自动配对...')
            this._setConnected(false, 'reconnecting', '设备配对中...')
            this._autoPairAndReconnect()
            return
          }
          this._setConnected(false, 'error', '设备配对失败，请手动执行 openclaw pairing approve')
          return
        }
        if (/device identity required/i.test(reason) || /device auth/i.test(reason)) {
          // 设备认证问题 → 重新配对
          if (this._autoPairAttempts < 1) {
            console.log('[ws] 设备认证问题，尝试重新配对:', e.reason)
            this._setConnected(false, 'reconnecting', '设备认证修复中...')
            this._autoPairAndReconnect()
            return
          }
          this._setConnected(false, 'error', `设备认证失败: ${e.reason}`)
          return
        }
        if (/rate.?limit/i.test(reason)) {
          // 被限流 → 等待后重试
          console.log('[ws] 被限流，30秒后重试')
          this._setConnected(false, 'reconnecting', '请求过于频繁，30秒后重试...')
          setTimeout(() => {
            if (!this._intentionalClose) this._doConnect()
          }, 30000)
          return
        }
        // Gateway 内核过旧：不支持 ClawPanel 0.15+ 使用的 v3 签名 payload / minProtocol=3
        // 关闭 reason 通常是 'device signature invalid' / 'protocol mismatch'
        if (isProtocolIncompatReason(reason)) {
          console.warn('[ws] Gateway 协议/签名不兼容（内核过旧）:', e.reason)
          this._intentionalClose = true
          this._flushPending()
          this._setConnected(false, 'error', kernelTooOldMessage())
          return
        }
        // 其他 1008（如 invalid role）→ 显示错误
        console.warn('[ws] 收到 1008 关闭:', e.reason)
        this._setConnected(false, 'error', e.reason || '连接被 Gateway 拒绝')
        return
      }

      // ── 其他关闭码 → 普通断线重连 ──
      this._setConnected(false)
      this._gatewayReady = false
      this._handshaking = false
      this._stopPing()
      this._flushPending()
      if (!this._intentionalClose) this._scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.error('[ws] WebSocket 错误:', err)
    }
  }

  _handleMessage(msg) {
    // 更新最后消息时间（用于心跳检测）
    this._lastMessageAt = Date.now()
    this._missedHeartbeats = 0

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
        const details = msg.error?.details || {}
        const detailCode = details.code || ''
        const nextStep = details.recommendedNextStep || ''
        console.error('[ws] connect 失败:', { errCode, detailCode, nextStep, errMsg })

        // 按 detailCode 精确分流（上游 ConnectErrorDetailCodes）
        let handled = false
        switch (detailCode) {
          case 'PAIRING_REQUIRED':
          case 'CONTROL_UI_ORIGIN_NOT_ALLOWED':
            // 可自动修复：配对 + 写 origins
            if (this._autoPairAttempts < 1) {
              console.log('[ws] 自动修复:', detailCode)
              this._autoPairAndReconnect()
              return
            }
            break
          case 'AUTH_TOKEN_MISMATCH':
          case 'AUTH_TOKEN_MISSING':
          case 'AUTH_TOKEN_NOT_CONFIGURED':
          case 'AUTH_PASSWORD_MISMATCH':
          case 'AUTH_PASSWORD_MISSING':
          case 'AUTH_PASSWORD_NOT_CONFIGURED':
          case 'AUTH_DEVICE_TOKEN_MISMATCH':
            // 认证凭据问题 → 刷新凭据重试
            if (this._authRetryCount < 2) {
              this._authRetryCount++
              console.log(`[ws] 认证失败 (${detailCode})，刷新凭据 (${this._authRetryCount}/2)`)
              this._refreshCredentialsAndReconnect()
              return
            }
            handled = true
            break
          case 'AUTH_RATE_LIMITED': {
            // 被限流 → 等待后重试
            const retryMs = msg.error?.retryAfterMs || 30000
            console.log(`[ws] 被限流，${Math.round(retryMs / 1000)}秒后重试`)
            this._setConnected(false, 'reconnecting', `请求过于频繁，${Math.round(retryMs / 1000)}秒后重试...`)
            setTimeout(() => { if (!this._intentionalClose) this._doConnect() }, retryMs)
            return
          }
          case 'DEVICE_IDENTITY_REQUIRED':
          case 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED':
          case 'DEVICE_AUTH_SIGNATURE_INVALID':
          case 'DEVICE_AUTH_NONCE_MISMATCH':
          case 'DEVICE_AUTH_NONCE_REQUIRED':
          case 'DEVICE_AUTH_PUBLIC_KEY_INVALID':
          case 'DEVICE_AUTH_INVALID':
            // 设备签名/认证问题 → 重新配对
            if (this._autoPairAttempts < 1) {
              console.log('[ws] 设备认证问题:', detailCode)
              this._autoPairAndReconnect()
              return
            }
            break
          default:
            // 兼容旧版 Gateway（不含 details）：按 errCode / errMsg 分流
            if (errCode === 'NOT_PAIRED' || /origin not allowed/i.test(errMsg)) {
              if (this._autoPairAttempts < 1) {
                console.log('[ws] 检测到配对/origin 错误，尝试自动修复...', errCode || errMsg)
                this._autoPairAndReconnect()
                return
              }
            }
            if (/unauthorized/i.test(errMsg) && this._authRetryCount < 2) {
              this._authRetryCount++
              this._refreshCredentialsAndReconnect()
              return
            }
        }

        // 上游 5.4+：Gateway 启动期间收到的 connect 会返回 retryable UNAVAILABLE，
        // details.reason='startup-sidecars'，附带 retryAfterMs。
        // 这种错误对小白用户应该完全无感——按建议时间静默重试，不显示红色错误。
        const isStartupSidecars =
          /^UNAVAILABLE$/i.test(errCode || '') &&
          (
            details.reason === 'startup-sidecars' ||
            details.code === 'startup-sidecars' ||
            detailCode === 'STARTUP_SIDECARS' ||
            /startup[-_]?sidecars/i.test(errMsg)
          )
        if (!handled && isStartupSidecars) {
          const retryMs = Math.max(500, Math.min(details.retryAfterMs || msg.error?.retryAfterMs || 1500, 10000))
          console.log(`[ws] Gateway 启动中 (sidecars 加载)，${retryMs}ms 后重试`)
          // 标 reconnecting 而非 error，UI 上显示的是 spinner 不是红色叉
          this._setConnected(false, 'reconnecting', 'Gateway 启动中...')
          setTimeout(() => { if (!this._intentionalClose) this._doConnect() }, retryMs)
          return
        }

        // Gateway 内核过旧：自动配对后仍签名失败，或上游已明确返回协议不兼容
        // → 大概率是老 Gateway 不识别 v3 payload / minProtocol=3，给「内核过旧」提示
        if (!handled && (
          detailCode === 'DEVICE_AUTH_SIGNATURE_INVALID' ||
          detailCode === 'DEVICE_AUTH_INVALID' ||
          detailCode === 'PROTOCOL_VERSION_MISMATCH' ||
          detailCode === 'UNSUPPORTED_PROTOCOL'
        )) {
          const friendly = kernelTooOldMessage()
          this._intentionalClose = true
          this._flushPending()
          this._setConnected(false, 'error', friendly)
          this._readyCallbacks.forEach(fn => {
            try { fn(null, null, { error: true, message: friendly, detailCode, nextStep }) } catch {}
          })
          return
        }

        // 使用 recommendedNextStep 给用户更好的提示
        const hints = {
          'retry_with_device_token': '设备令牌需要更新，请重启面板',
          'update_auth_configuration': '请检查 Gateway 认证配置',
          'update_auth_credentials': '请检查 Gateway Token 是否正确',
          'wait_then_retry': '请稍后重试',
          'review_auth_configuration': '请检查 Gateway 安全配置',
        }
        const hint = hints[nextStep] || ''
        const displayMsg = hint ? `${errMsg}（${hint}）` : errMsg
        this._setConnected(false, 'error', displayMsg)
        this._readyCallbacks.forEach(fn => {
          try { fn(null, null, { error: true, message: displayMsg, detailCode, nextStep }) } catch {}
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
        else {
          const err = new Error(msg.error?.message || msg.error?.code || 'request failed')
          err.code = msg.error?.code || null
          err.details = msg.error?.details || null
          err.method = cb.method || null
          cb.reject(err)
        }
      }
      return
    }

    // 事件转发
    if (msg.type === 'event') {
      // 消息去重检查
      if (msg.id && this._seenMessageIds.has(msg.id)) {
        console.log('[ws] 跳过重复消息:', msg.id)
        return
      }
      if (msg.id) {
        this._seenMessageIds.add(msg.id)
        // 保持 Set 大小，防止内存泄漏
        if (this._seenMessageIds.size > 1000) {
          const arr = Array.from(this._seenMessageIds)
          this._seenMessageIds = new Set(arr.slice(-500))
        }
      }

      // 缓存聊天消息
      if (msg.event === 'chat.message' && msg.payload?.sessionKey) {
        this._cacheMessage(msg.payload.sessionKey, msg.payload)
      }

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

      // 修复 #160: 不调用 reconnect()（它会重置 _autoPairAttempts 导致无限循环），
      // 而是直接重连一次。如果仍然失败，_autoPairAttempts 不会被重置，不会再次触发自动修复。
      console.log('[ws] 配对成功，3秒后重新连接...')
      setTimeout(() => {
        if (!this._intentionalClose) {
          this._reconnectAttempts = 0
          this._closeWs()
          this._doConnect()
        }
      }, 3000)
    } catch (e) {
      console.error('[ws] 自动配对失败:', e)
      this._setConnected(false, 'error', `配对失败: ${e}`)
    }
  }

  async _refreshCredentialsAndReconnect() {
    try {
      // 重新从 openclaw.json 读取最新凭据
      const config = await api.readOpenclawConfig()
      const newToken = config?.gateway?.auth?.token || ''
      const newPassword = config?.gateway?.auth?.password || ''
      if ((newToken && newToken !== this._token) || (newPassword && newPassword !== this._password)) {
        console.log('[ws] 检测到凭据变更，使用新凭据重连')
        this._token = newToken
        this._password = newPassword
        const base = this._url.split('?')[0]
        this._url = `${base}?token=${encodeURIComponent(this._token)}`
      }
      // 确保配对和 origins
      try { await api.autoPairDevice() } catch {}
      // 3秒后重连
      setTimeout(() => {
        if (!this._intentionalClose) {
          this._doConnect()
        }
      }, 3000)
    } catch (e) {
      console.error('[ws] 刷新凭据失败:', e)
      this._setConnected(false, 'error', `凭据刷新失败: ${e}`)
    }
  }

  async _sendConnectFrame(nonce) {
    this._handshaking = true
    try {
      const frame = await api.createConnectFrame(nonce, this._token, this._password)
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
    this._authRetryCount = 0
    this._hello = payload || null
    this._snapshot = payload?.snapshot || null
    this._serverVersion = payload?.serverVersion || null
    // 新连接 → 清空 method 降级缓存（可能换了 Gateway 版本）
    this.resetCompatCache()
    const defaults = this._snapshot?.sessionDefaults
    if (defaults?.mainSessionKey) {
      this._sessionKey = defaults.mainSessionKey
    } else {
      const agentId = defaults?.defaultAgentId || 'main'
      this._sessionKey = `agent:${agentId}:main`
    }
    this._gatewayReady = true
    this._reconnectState = 'idle'
    this._pendingReconnect = false
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
    // 超过最大重连次数，停止重连
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[ws] 已达到最大重连次数 (', MAX_RECONNECT_ATTEMPTS, ')，停止自动重连')
      this._reconnectState = 'idle'
      this._pendingReconnect = false
      this._setConnected(false, 'error', `连接失败，已停止重连。请手动刷新页面重试。`)
      return
    }

    this._clearReconnectTimer()
    // 指数退避：1s, 2s, 4s, 8s, 16s, 32s, 60s (最多 60s)
    const baseDelay = 2000
    const maxDelay = MAX_RECONNECT_DELAY
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this._reconnectAttempts), maxDelay)
    // 首次连接（Gateway 可能还未启动）：使用更长的初始延迟
    const delay = this._reconnectAttempts === 0
      ? INITIAL_RECONNECT_DELAY
      : Math.round(exponentialDelay * (0.5 + Math.random())) // 50%~150% 抖动，防止同步风暴

    this._reconnectAttempts++
    this._reconnectState = 'scheduled'
    this._pendingReconnect = true
    this._setConnected(false, 'reconnecting', `重连中 (${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})，${Math.round(delay/1000)}秒后...`)
    console.log(`[ws] 计划重连 (${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})，延迟 ${Math.round(delay/1000)}秒`)
    this._reconnectTimer = setTimeout(() => {
      if (!this._intentionalClose) {
        this._reconnectState = 'attempting'
        this._doConnect()
      }
    }, delay)
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

  /**
   * 心跳检测：如果超过 HEARTBEAT_TIMEOUT 没有收到任何消息，触发重连
   * 这用于检测 Gateway 端崩溃或网络中断
   */
  _startHeartbeat() {
    this._stopHeartbeat()
    this._missedHeartbeats = 0
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected || !this._gatewayReady) return

      const now = Date.now()
      const timeSinceLastMessage = this._lastMessageAt ? now - this._lastMessageAt : 0

      if (timeSinceLastMessage > HEARTBEAT_TIMEOUT) {
        this._missedHeartbeats++
        console.warn(`[ws] 心跳超时 (${Math.round(timeSinceLastMessage/1000)}秒)，missedHeartbeats: ${this._missedHeartbeats}`)
        // 增加容忍度：连续 3 次超时（检查间隔 30s × 3 = 约 90s）才强制重连
        if (this._missedHeartbeats >= 3) {
          console.error('[ws] 心跳检测失败超过3次，强制重连')
          this._stopHeartbeat()
          this.reconnect()
        } else if (this._missedHeartbeats >= 2) {
          // 2 次超时：先尝试发 ping 探测，不行再重连
          console.warn('[ws] 心跳超时 2 次，发送探测 ping...')
          if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            try { this._ws.send('{"type":"ping"}') } catch {}
          }
        }
      }
    }, HEARTBEAT_TIMEOUT / 3) // 每 30 秒检查一次
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
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
      this._pending.set(id, { resolve, reject, timer, method })
      this._ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  /**
   * 跨内核兼容版 request：
   * - 老内核不支持的 RPC 会返回 fallback（默认 null），不抛错
   * - 第二次起跳过实际请求，直接返回 fallback
   * - 真实失败（网络、参数错误等）仍然 throw
   *
   * 用法：
   *   const status = await wsClient.requestCompat('memory.status.deep', {})
   *   if (status) renderRich(status); else renderBasic()
   *
   * @param {string} method
   * @param {object} [params]
   * @param {*} [fallback=null]  老内核不支持时返回此值
   * @returns {Promise<*>}
   */
  async requestCompat(method, params = {}, fallback = null) {
    if (this._unsupportedMethods.has(method)) {
      return fallback
    }
    try {
      return await this.request(method, params)
    } catch (e) {
      if (isMethodUnsupportedError(e)) {
        this._unsupportedMethods.add(method)
        console.warn(`[ws] RPC \`${method}\` 不被当前 Gateway 支持 (code=${e.code}), 已记入降级集合`)
        return fallback
      }
      throw e
    }
  }

  /**
   * 是否已确认某 method 在当前 Gateway 上不可用
   */
  isMethodUnsupported(method) {
    return this._unsupportedMethods.has(method)
  }

  /**
   * 清空降级集合（在新连接成功时自动调用）
   */
  resetCompatCache() {
    if (this._unsupportedMethods.size > 0) {
      console.log('[ws] 清空 method 降级集合', Array.from(this._unsupportedMethods))
    }
    this._unsupportedMethods.clear()
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

  // ===== 4.9: Sessions Compaction =====
  sessionsCompactionList(key) {
    return this.request('sessions.compaction.list', { key })
  }

  sessionsCompactionGet(key, checkpointId) {
    return this.request('sessions.compaction.get', { key, checkpointId })
  }

  sessionsCompactionBranch(key, checkpointId) {
    return this.request('sessions.compaction.branch', { key, checkpointId })
  }

  sessionsCompactionRestore(key, checkpointId) {
    return this.request('sessions.compaction.restore', { key, checkpointId })
  }

  // ===== 4.9: Skills Gateway RPC =====
  skillsSearch(query, limit) {
    return this.request('skills.search', { query, limit })
  }

  skillsDetail(slug) {
    return this.request('skills.detail', { slug })
  }

  // ===== 4.9: Approval management =====
  execApprovalList() {
    return this.request('exec.approval.list', {})
  }

  execApprovalGet(id) {
    return this.request('exec.approval.get', { id })
  }

  pluginApprovalList() {
    return this.request('plugin.approval.list', {})
  }

  onEvent(callback) {
    this._eventListeners.push(callback)
    return () => { this._eventListeners = this._eventListeners.filter(fn => fn !== callback) }
  }

  // ==================== 消息缓存管理 ====================

  /**
   * 缓存消息
   * @param {string} sessionKey - 会话 key
   * @param {object} message - 消息对象
   */
  _cacheMessage(sessionKey, message) {
    if (!this._messageCache.has(sessionKey)) {
      this._messageCache.set(sessionKey, [])
    }
    const messages = this._messageCache.get(sessionKey)

    // 去重检查（基于消息 ID 或内容哈希）
    const msgId = message.id || message.messageId
    if (msgId && messages.some(m => (m.id || m.messageId) === msgId)) {
      return
    }

    messages.push({
      ...message,
      _cachedAt: Date.now(),
    })

    // 限制缓存大小
    if (messages.length > this._cacheSize) {
      messages.splice(0, messages.length - this._cacheSize)
    }
  }

  /**
   * 获取缓存的消息
   * @param {string} sessionKey - 会话 key
   * @returns {array} 缓存的消息数组
   */
  _getCachedMessages(sessionKey) {
    return this._messageCache.get(sessionKey) || []
  }

  /**
   * 清除指定会话的缓存
   * @param {string} sessionKey - 会话 key
   */
  _clearCache(sessionKey) {
    if (sessionKey) {
      this._messageCache.delete(sessionKey)
    } else {
      this._messageCache.clear()
    }
    console.log('[ws] 消息缓存已清除:', sessionKey || '全部')
  }

  /**
   * 清除消息去重记录
   */
  _clearSeenMessageIds() {
    this._seenMessageIds.clear()
  }

  /**
   * 获取缓存状态信息
   */
  getCacheInfo() {
    const info = {}
    for (const [key, messages] of this._messageCache) {
      info[key] = {
        count: messages.length,
        oldest: messages[0]?._cachedAt,
        newest: messages[messages.length - 1]?._cachedAt,
      }
    }
    return info
  }

  /**
   * 连接成功后自动拉取历史消息（供前端调用）
   * @param {string} sessionKey - 会话 key
   * @param {number} limit - 消息数量限制
   */
  async fetchHistoryOnReconnect(sessionKey, limit = 200) {
    if (!sessionKey || !this._gatewayReady) {
      return { error: 'not ready' }
    }
    try {
      const history = await this.chatHistory(sessionKey, limit)
      // 将历史消息缓存起来
      if (history?.messages) {
        for (const msg of history.messages) {
          this._cacheMessage(sessionKey, msg)
        }
      }
      return { history }
    } catch (e) {
      console.error('[ws] 拉取历史消息失败:', e)
      return { error: e.message }
    }
  }
}

const _g = typeof window !== 'undefined' ? window : globalThis
if (!_g.__clawpanelWsClient) _g.__clawpanelWsClient = new WsClient()
export const wsClient = _g.__clawpanelWsClient
