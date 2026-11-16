/**
 * 会话分组 - 纯函数模块（无 DOM / 无 Gateway 依赖，可直接单测）
 *
 * 目标：把 Gateway `sessions.list` 返回的原始记录，归一化为「主会话 + 子代理分组」结构。
 *
 * 子会话判定（任一命中即视为子会话，**不使用 classification 作为唯一依据**）：
 *   - spawnedBy 有值
 *   - parentSessionKey 有值
 *   - spawnDepth > 0
 *   - subagentRole 有值（orchestrator / leaf）
 *   - createdVia === 'spawn'
 *
 * 活跃时间优先级：lastActivityAt → updatedAt → lastInteractionAt → createdAt
 */

/** 支持的会话列表视图模式 */
export const SESSION_VIEW_MODES = ['groups', 'all']
export const DEFAULT_SESSION_VIEW_MODE = 'groups'

/** 分组 ID 前缀（用于 localStorage 中持久化折叠状态） */
export const GROUP_ID_OWNER = 'owner'
export const GROUP_ID_ARCHIVED = 'archived'

/**
 * 拆分会话键：agent:<agentId>:<channel...>
 * @param {string} key
 * @returns {{ agentId: string, channel: string }}
 */
export function splitSessionKey(key) {
  const raw = String(key || '')
  const parts = raw.split(':')
  if (parts.length < 3) return { agentId: '', channel: raw }
  return { agentId: parts[1] || '', channel: parts.slice(2).join(':') }
}

/**
 * 时间戳归一化：统一成毫秒；支持 number / 数字字符串 / ISO 字符串
 * @param {unknown} value
 * @returns {number} 毫秒时间戳；无法解析返回 0
 */
export function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    return normalizeEpoch(value)
  }
  if (typeof value === 'string') {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return normalizeEpoch(num)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 纪元时间归一化到毫秒。
 * - < 1e9 视为已经是毫秒（相对时间/测试用小数值）
 * - < 1e12 视为秒（1e9 ~ 1e12 对应 2001-09 ~ 33658 年，足够覆盖真实 epoch 秒）
 * - 其余视为毫秒
 */
function normalizeEpoch(num) {
  if (num < 1e9) return Math.round(num)
  if (num < 1e12) return Math.round(num * 1000)
  return Math.round(num)
}

/**
 * 取会话活跃时间：lastActivityAt → updatedAt → lastInteractionAt → createdAt
 * @param {object} row 原始记录或归一化记录
 * @returns {number} 毫秒时间戳；没有则 0
 */
export function sessionActivityTs(row) {
  if (!row || typeof row !== 'object') return 0
  const candidates = [row.lastActivityAt, row.updatedAt, row.lastInteractionAt, row.createdAt]
  for (const candidate of candidates) {
    const ts = toTimestamp(candidate)
    if (ts) return ts
  }
  return 0
}

/**
 * 判断是否为子会话（子代理运行）
 * @param {object} row 原始记录或归一化记录
 * @returns {boolean}
 */
export function isChildSession(row) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.isChild === 'boolean') return row.isChild
  const spawnedBy = String(row.spawnedBy || '').trim()
  const parentKey = String(row.parentSessionKey || '').trim()
  const subagentRole = String(row.subagentRole || '').trim()
  const createdVia = String(row.createdVia || '').trim()
  const depth = Number(row.spawnDepth)
  return !!(spawnedBy || parentKey || subagentRole || createdVia === 'spawn' || (Number.isFinite(depth) && depth > 0))
}

/**
 * 解析会话归属的 Agent（owner）
 * 优先级：owner.actor.id → createdActor.id → parentSessionKey/spawnedBy 里的 agent → 自身 agentId
 * @param {object} row
 * @returns {string}
 */
export function resolveOwnerAgent(row) {
  if (!row || typeof row !== 'object') return ''
  const actor = row.owner?.actor?.id || row.createdActor?.id || row.ownerActor?.id || ''
  if (actor) return String(actor)
  const fromParent = splitSessionKey(row.parentSessionKey || row.spawnedBy || '').agentId
  if (fromParent) return fromParent
  const own = row.agentId || splitSessionKey(row.sessionKey || row.key || '').agentId
  return own ? String(own) : ''
}

/**
 * 归一化 Gateway 会话记录
 * @param {any[]} rows 原始记录数组（字段缺失/脏数据都容忍）
 * @returns {object[]} 归一化记录
 */
export function normalizeSessionRows(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const key = String(row.sessionKey || row.key || '').trim()
    if (!key) continue
    const parsed = splitSessionKey(key)
    const agentId = String(row.agentId || parsed.agentId || '').trim()
    const parentKey = String(row.parentSessionKey || '').trim()
    const spawnedBy = String(row.spawnedBy || '').trim()
    const rawDepth = Number(row.spawnDepth)
    const spawnDepth = Number.isFinite(rawDepth) ? rawDepth : 0
    const subagentRole = String(row.subagentRole || '').trim()
    const createdVia = String(row.createdVia || '').trim()
    const isChild = !!(spawnedBy || parentKey || spawnDepth > 0 || subagentRole || createdVia === 'spawn')
    const ownerAgent = resolveOwnerAgent({ ...row, agentId })
    out.push({
      key,
      agentId,
      channel: parsed.channel,
      parentKey,
      spawnedBy,
      spawnDepth,
      subagentRole,
      createdVia,
      isChild,
      ownerAgent,
      classification: String(row.classification || ''),
      isMain: !!row.isMain,
      archived: !!row.archived,
      archivedAt: row.archivedAt || null,
      archiveReason: String(row.archiveReason || ''),
      activityTs: sessionActivityTs(row),
      label: String(row.label || row.displayName || ''),
      messageCount: Number(row.messageCount || row.messages || 0) || 0,
      compactionCheckpointCount: Number(row.compactionCheckpointCount || 0) || 0,
      childSessions: Array.isArray(row.childSessions) ? row.childSessions.map(String) : [],
      raw: row,
    })
  }
  return out
}

/**
 * 按最后活跃时间倒序排序（新的在上），同时间按 key 升序保证稳定
 * @param {object[]} rows
 * @returns {object[]} 新数组
 */
export function sortSessionsByActivity(rows) {
  if (!Array.isArray(rows)) return []
  return [...rows].sort((a, b) => {
    const diff = (b?.activityTs || 0) - (a?.activityTs || 0)
    if (diff !== 0) return diff
    return String(a?.key || '').localeCompare(String(b?.key || ''))
  })
}

/**
 * 分组
 * @param {any[]} rows 原始记录
 * @returns {{
 *   mains: object[], ownerGroups: { id: string, type: string, ownerAgent: string, sessions: object[] }[],
 *   archivedGroup: { id: string, type: string, ownerAgent: string, sessions: object[] }|null,
 *   flat: object[], total: number, archivedCount: number, childCount: number
 * }}
 */
export function groupSessions(rows) {
  const normalized = normalizeSessionRows(rows)
  const mains = []
  const archived = []
  const ownerBuckets = new Map()
  let childCount = 0

  for (const row of normalized) {
    if (row.archived) { archived.push(row); continue }
    if (row.isChild) {
      childCount++
      const owner = row.ownerAgent || 'unknown'
      if (!ownerBuckets.has(owner)) ownerBuckets.set(owner, [])
      ownerBuckets.get(owner).push(row)
    } else {
      mains.push(row)
    }
  }

  const ownerGroups = [...ownerBuckets.entries()]
    .map(([ownerAgent, sessions]) => ({
      id: `${GROUP_ID_OWNER}:${ownerAgent}`,
      type: GROUP_ID_OWNER,
      ownerAgent,
      sessions: sortSessionsByActivity(sessions),
    }))
    .sort((a, b) => {
      const aMax = a.sessions.reduce((acc, s) => Math.max(acc, s.activityTs || 0), 0)
      const bMax = b.sessions.reduce((acc, s) => Math.max(acc, s.activityTs || 0), 0)
      if (bMax !== aMax) return bMax - aMax
      return a.ownerAgent.localeCompare(b.ownerAgent)
    })

  const archivedGroup = archived.length
    ? { id: GROUP_ID_ARCHIVED, type: GROUP_ID_ARCHIVED, ownerAgent: '', sessions: sortSessionsByActivity(archived) }
    : null

  return {
    mains: sortSessionsByActivity(mains),
    ownerGroups,
    archivedGroup,
    flat: sortSessionsByActivity(normalized),
    total: normalized.length,
    archivedCount: archived.length,
    childCount,
  }
}

/**
 * 从 Gateway 返回体中提取会话数组（兼容数组 / { sessions } / { items }）
 * @param {any} raw
 * @returns {object[]}
 */
export function extractSessionRows(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.sessions)) return raw.sessions
    if (Array.isArray(raw.items)) return raw.items
  }
  return []
}

/**
 * 判断错误是否为「参数不被支持」（旧内核不认 archived 参数时返回 INVALID_REQUEST）
 * @param {any} err
 * @returns {boolean}
 */
export function isInvalidParamsError(err) {
  if (!err) return false
  const code = String(err.code || '').toUpperCase()
  if (code === 'INVALID_REQUEST' || code === 'INVALID_PARAMS' || code === 'BAD_REQUEST') return true
  return /unexpected property|invalid .*params|unknown property/i.test(String(err.message || ''))
}

/**
 * 缩短过长标签（保留首尾可读性，避免 UUID 撑破侧边栏）
 * @param {string} label
 * @param {number} [max=28]
 * @returns {string}
 */
export function shortenSessionLabel(label, max = 28) {
  const text = String(label || '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}
