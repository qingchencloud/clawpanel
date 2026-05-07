/**
 * 内核版本与特性门控
 *
 * 此模块是 ClawPanel 多内核版本兼容的核心：
 * - 连接 Gateway 成功后，从 hello.serverVersion 构造 kernel snapshot
 * - 页面通过 hasFeature(id) 同步查询特性可用性
 * - 低于硬地板时通过 onKernelChange 触发 floor blocker
 *
 * @see .tmp/multi-kernel-compat-design.md §4.2 为详细设计
 */
import { FEATURE_CATALOG, KERNEL_FLOOR, KERNEL_TARGET } from './feature-catalog.js'
import { wsClient } from './ws-client.js'
import { getActiveEngineId, onEngineChange } from './engine-manager.js'

/** @type {KernelSnapshot|null} */
let _snapshot = null
let _initialized = false
const _listeners = []

/**
 * @typedef {Object} KernelSnapshot
 * @property {string}  engine        当前引擎 id
 * @property {string|null} version   原始版本字符串，可能含 -zh.2 后缀
 * @property {string|null} versionBase 剥离后缀的基础版本 x.y.z
 * @property {'official'|'chinese'|'unknown'} variant
 * @property {string|null} target    当前推荐目标版本
 * @property {string}  floor         硬地板版本
 * @property {boolean} aboveFloor    是否 >= floor
 * @property {boolean} isLatest      是否 >= target
 * @property {Set<string>} features  当前启用的特性 id 集合
 * @property {string}  versionLabel  人类可读的版本显示，例如 "2026.5.6 汉化"
 */

/**
 * 解析版本号 → [major, minor, patch]，自动剥离 -zh.* / -beta.* 等后缀
 * @param {string|null|undefined} ver
 * @returns {number[]|null}
 */
export function parseVersion(ver) {
  if (!ver) return null
  const base = String(ver).replace(/-.*$/, '')
  const parts = base.split('.').map(Number)
  if (parts.some(isNaN)) return null
  while (parts.length < 3) parts.push(0)
  return parts.slice(0, 3)
}

/**
 * 比较版本: a >= b 返回 true。版本无法解析时返回 false（严格）。
 */
export function versionGte(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return true
}

/**
 * 检测版本是否属于汉化版
 */
function detectVariant(ver) {
  if (!ver) return 'unknown'
  if (/-zh/i.test(ver)) return 'chinese'
  return 'official'
}

/**
 * 根据当前 engine + serverVersion 构造一份特性快照
 * @param {string} engineId
 * @param {string|null} version
 * @returns {KernelSnapshot}
 */
export function buildSnapshot(engineId, version) {
  const features = new Set()
  for (const [id, def] of Object.entries(FEATURE_CATALOG)) {
    if (def.engine !== engineId) continue
    if (version && versionGte(version, def.minVersion)) {
      features.add(id)
    }
  }

  const variant = detectVariant(version)
  const target = KERNEL_TARGET[engineId]?.[variant]
    || KERNEL_TARGET[engineId]?.official
    || KERNEL_TARGET[engineId]?.default
    || null
  const floor = KERNEL_FLOOR[engineId] || '0.0.0'
  const versionBase = parseVersion(version)?.join('.') || version || null

  return {
    engine: engineId,
    version: version || null,
    versionBase,
    variant,
    target,
    floor,
    aboveFloor: !!version && versionGte(version, floor),
    isLatest: !!version && !!target && versionGte(version, target),
    features,
    versionLabel: version
      ? `${versionBase}${variant === 'chinese' ? ' 汉化' : ''}`
      : '',
  }
}

/**
 * 同步：当前是否启用某个特性
 *
 * 语义：
 * - featureId **不在** catalog 中 → 返回 true（兼容老代码 isFeatureAvailable，例如 'memory' / 'cron'）
 * - featureId **在** catalog 中：
 *   - 还未连接 Gateway / 无版本信息 → 返回 **false**（避免首屏闪烁出 5.x 新功能后又消失）
 *   - 有版本信息但引擎不匹配 → 返回 false
 *   - 有版本信息且匹配 → 返回 features.has(id)
 *
 * 设计要点：在 catalog 中的特性默认严格，对小白用户 UX 更平滑——
 * 老内核连接前他根本不会看到 5.x 按钮闪现一下又消失。
 *
 * @param {string} featureId
 * @returns {boolean}
 */
export function hasFeature(featureId) {
  const def = FEATURE_CATALOG[featureId]
  if (!def) return true
  if (!_snapshot || !_snapshot.version) return false
  if (_snapshot.engine !== def.engine) return false
  return _snapshot.features.has(featureId)
}

/**
 * @deprecated 当前 hasFeature 已经是 strict 行为，本函数仅做向后兼容
 */
export function hasFeatureStrict(featureId) {
  return hasFeature(featureId)
}

/**
 * 返回当前内核快照（可能为 null）。
 * 页面应该通过此对象读取 version/versionLabel/aboveFloor/target 等状态。
 * @returns {KernelSnapshot|null}
 */
export function getKernelSnapshot() {
  return _snapshot
}

/**
 * 当前版本是否高于硬地板
 */
export function isAboveFloor() {
  return _snapshot?.aboveFloor ?? true
}

/**
 * 监听内核快照变化。
 * - 连接 Gateway 握手成功 → 触发
 * - 重连后 serverVersion 变化 → 触发
 * - 引擎切换 → 触发
 *
 * @param {(snap: KernelSnapshot) => void} fn
 * @returns {() => void} 取消监听函数
 */
export function onKernelChange(fn) {
  _listeners.push(fn)
  if (_snapshot) {
    try { fn(_snapshot) } catch (e) { console.warn('[kernel] listener error', e) }
  }
  return () => {
    const idx = _listeners.indexOf(fn)
    if (idx >= 0) _listeners.splice(idx, 1)
  }
}

/**
 * 刷新快照。内部调用。
 * @returns {KernelSnapshot}
 */
function refresh() {
  const engineId = getActiveEngineId()
  const version = wsClient.serverVersion
  const next = buildSnapshot(engineId, version)
  const changed = !_snapshot
    || _snapshot.engine !== next.engine
    || _snapshot.version !== next.version
    || _snapshot.features.size !== next.features.size
  _snapshot = next
  if (changed) {
    _listeners.forEach(fn => {
      try { fn(next) } catch (e) { console.warn('[kernel] listener error', e) }
    })
  }
  return next
}

/**
 * 手动触发刷新（给 ws-client 在握手成功后调用）。
 * 也可在外部场景（例如手动切版本后）调用。
 */
export function refreshKernelSnapshot() {
  return refresh()
}

/**
 * 初始化。应由 engine.boot() 调用一次。
 * - 立即构造一份快照（可能 version=null）
 * - 订阅 wsClient.onReady 以在握手成功后刷新
 * - 订阅 engine 切换
 */
export function initKernelGates() {
  if (_initialized) {
    refresh()
    return
  }
  _initialized = true
  refresh()

  // WS 握手成功 → 刷新快照
  wsClient.onReady(() => {
    refresh()
  })

  // 引擎切换 → 刷新快照
  onEngineChange(() => {
    refresh()
  })
}

// === 兼容旧 API（feature-gates.js 曾经使用的名字） ===

/** @deprecated 使用 hasFeature 代替 */
export function isFeatureAvailable(featureId) {
  return hasFeature(featureId)
}

/** @deprecated 使用 initKernelGates 代替 */
export function initFeatureGates() {
  initKernelGates()
  return Promise.resolve()
}

/** @deprecated 使用 getKernelSnapshot()?.version 代替 */
export function getCachedVersion() {
  return _snapshot?.version || null
}

/** @deprecated kernel.js 会自动 refresh，手动清缓存无效；仅保留函数签名兼容 */
export function invalidateVersionCache() {
  refresh()
}

/** 调试用：获取所有特性的启用状态 */
export function getAllFeatureStatus() {
  const snap = _snapshot
  const result = {}
  for (const [id, def] of Object.entries(FEATURE_CATALOG)) {
    result[id] = {
      engine: def.engine,
      minVersion: def.minVersion,
      desc: def.desc,
      available: snap ? snap.features.has(id) : null,
    }
  }
  return {
    snapshot: snap,
    features: result,
  }
}
