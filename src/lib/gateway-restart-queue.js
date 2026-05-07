/**
 * Gateway 重启防抖队列
 *
 * 解决 issue #243 #244 #240：用户快速连续改动配置时，之前会触发多次 Gateway 重启
 * 导致僵尸进程堆积、风扇狂转、重启失败等问题。
 *
 * 设计：
 *   - 默认 3s 空闲防抖：连续编辑时每次重置计时
 *   - 单飞行锁：前一次重启未完成时，新请求只设"补重启"标记
 *   - 立即执行入口：UI 提供 "立即重载" 按钮跳过倒计时
 *   - 事件订阅：供顶部状态条 / toast 展示倒计时与结果
 *
 * 对外 API：
 *   scheduleGatewayRestart({ delay, reason })  // 入队
 *   fireRestartNow()                            // 跳过倒计时
 *   cancelPendingRestart()                      // 取消
 *   hasPendingRestart() / isRestartInFlight()   // 状态查询
 *   onRestartState(cb)                          // 订阅状态变化
 */

import { api } from './tauri-api.js'

const DEFAULT_DELAY_MS = 3000
const RESCHEDULE_DELAY_MS = 500

let _pendingTimer = null
let _scheduledAt = 0
let _scheduledDelay = 0
let _currentReason = ''
let _inflight = false
let _needRerun = false
let _listeners = []

function emit(eventName, detail = {}) {
  const payload = {
    event: eventName,
    reason: _currentReason,
    pending: hasPendingRestart(),
    inflight: _inflight,
    scheduledAt: _scheduledAt,
    delay: _scheduledDelay,
    ...detail,
  }
  _listeners.forEach(fn => {
    try { fn(payload) } catch (_) { /* 忽略订阅方异常 */ }
  })
}

/**
 * 预约一次 Gateway 重启。多次调用会合并为一次。
 * @param {Object} opts
 * @param {number} [opts.delay=3000] 空闲多久后触发（毫秒）
 * @param {string} [opts.reason='config-change'] 触发原因（用于日志/UI）
 */
export function scheduleGatewayRestart(opts = {}) {
  const delay = Number.isFinite(opts.delay) ? opts.delay : DEFAULT_DELAY_MS
  const reason = opts.reason || 'config-change'

  if (_pendingTimer) clearTimeout(_pendingTimer)
  _scheduledAt = Date.now()
  _scheduledDelay = delay
  _currentReason = reason

  if (_inflight) {
    _needRerun = true
    emit('deferred')
    return
  }

  _pendingTimer = setTimeout(runRestart, delay)
  emit('scheduled')
}

/**
 * 跳过倒计时，立即执行重启。
 */
export function fireRestartNow() {
  if (_pendingTimer) {
    clearTimeout(_pendingTimer)
    _pendingTimer = null
  }
  if (_inflight) {
    _needRerun = true
    emit('deferred')
    return
  }
  runRestart()
}

/**
 * 取消待执行的重启。用户显式拒绝、页面卸载时调用。
 */
export function cancelPendingRestart() {
  if (_pendingTimer) {
    clearTimeout(_pendingTimer)
    _pendingTimer = null
  }
  _needRerun = false
  _scheduledAt = 0
  emit('cancelled')
}

export function hasPendingRestart() {
  return _pendingTimer !== null
}

export function isRestartInFlight() {
  return _inflight
}

export function getPendingInfo() {
  if (!_pendingTimer) return null
  const elapsed = Date.now() - _scheduledAt
  return {
    reason: _currentReason,
    delay: _scheduledDelay,
    remaining: Math.max(0, _scheduledDelay - elapsed),
  }
}

/**
 * 订阅重启状态事件。返回取消订阅函数。
 * 事件类型：
 *   - scheduled / deferred / cancelled
 *   - started / succeeded / failed
 */
export function onRestartState(fn) {
  _listeners.push(fn)
  return () => {
    _listeners = _listeners.filter(cb => cb !== fn)
  }
}

/**
 * 等待 Gateway 端口真正监听上。
 * 修复了之前 restart_service 返回 Ok 后立即 emit('succeeded') 的误报：
 * Rust 端 restart_service 只代表"启动命令执行了"，不代表 Gateway 真正监听端口。
 * 比如 Gateway 进程因配置错误启动后立即崩溃，前端却显示"配置已生效"，导致小白误判。
 *
 * 这里在 restart 命令返回后，**实际探测端口** 最多 PROBE_TIMEOUT_MS，可连通才认为成功。
 *
 * @returns {Promise<boolean>} 端口是否在限定时间内变得可连通
 */
const PROBE_TIMEOUT_MS = 12000  // 12s 给 Gateway 充分启动时间（一般 1-3s 就能起来）
const PROBE_INTERVAL_MS = 500
async function _waitGatewayPortReady() {
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ok = await api.probeGatewayPort()
      if (ok) return true
    } catch (_) {
      // probe 自身异常也算未就绪，继续重试
    }
    await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS))
  }
  return false
}

async function runRestart() {
  _pendingTimer = null
  _inflight = true
  emit('started')

  try {
    const result = await api.restartGateway()
    // ⚠ 关键修复：restart_service 返回 Ok 不代表 Gateway 真正在监听端口。
    // 必须 probe 端口确认它真起来了，才能 emit('succeeded')。
    // 否则用户会在"已重启"的假象下继续操作，但实际 WS 连不上。
    const portReady = await _waitGatewayPortReady()
    if (portReady) {
      emit('succeeded', { result })
    } else {
      emit('failed', {
        error: 'Gateway 重启命令已执行，但端口在 12 秒内仍未监听。请前往「服务管理」查看日志。',
        portTimeout: true,
      })
    }
  } catch (err) {
    emit('failed', { error: err?.message ? err.message : String(err) })
  } finally {
    _inflight = false
  }

  // 运行期间有新请求 → 稍等 500ms 再跑一次
  if (_needRerun) {
    _needRerun = false
    scheduleGatewayRestart({ delay: RESCHEDULE_DELAY_MS, reason: 'rescheduled' })
  }
}
