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

async function runRestart() {
  _pendingTimer = null
  _inflight = true
  emit('started')

  try {
    const result = await api.restartGateway()
    emit('succeeded', { result })
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
