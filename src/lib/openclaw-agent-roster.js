/**
 * OpenClaw Agent 注册表兼容层。
 *
 * - OpenClaw <= 2026.7 使用 agents.list[]
 * - OpenClaw >= 2026.8.1 使用 agents.entries.{id}
 *
 * ClawPanel 同时管理官方版与尚未同步到 8.1 的汉化版，因此所有读写都必须
 * 保留当前配置形状；只有配置尚未声明注册表时才根据已安装内核版本选型。
 */

export const OPENCLAW_AGENT_ENTRIES_VERSION_FLOOR = '2026.8.1'

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function versionParts(value) {
  return String(value || '')
    .split('-')[0]
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite)
}

function versionAtLeast(value, floor) {
  const left = versionParts(value)
  const right = versionParts(floor)
  if (!left.length) return false
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta > 0
  }
  return true
}

export function supportsAgentEntries(version) {
  return versionAtLeast(version, OPENCLAW_AGENT_ENTRIES_VERSION_FLOOR)
}

export function agentRosterKind(config, installedVersion = '') {
  if (isRecord(config?.agents?.entries)) return 'entries'
  if (Array.isArray(config?.agents?.list)) return 'list'
  return supportsAgentEntries(installedVersion) ? 'entries' : 'list'
}

export function hasExplicitAgentRoster(config) {
  return isRecord(config?.agents?.entries) || Array.isArray(config?.agents?.list)
}

/** 返回统一的带 id 投影；不把投影写回 canonical entries。 */
export function listAgentConfigs(config) {
  if (isRecord(config?.agents?.entries)) {
    return Object.entries(config.agents.entries).flatMap(([id, entry]) =>
      isRecord(entry) ? [{ ...entry, id }] : [],
    )
  }
  if (Array.isArray(config?.agents?.list)) {
    return config.agents.list.filter(isRecord).map(entry => ({ ...entry }))
  }
  return []
}

export function findAgentConfig(config, id) {
  const target = String(id || '').trim().toLowerCase()
  return listAgentConfigs(config).find(entry => String(entry.id || 'main').trim().toLowerCase() === target) || null
}

function ensureAgentsObject(config) {
  if (!isRecord(config.agents)) config.agents = {}
  return config.agents
}

function normalizeCanonicalOwnership(agents) {
  const entries = isRecord(agents.entries) ? agents.entries : {}
  const values = Object.values(entries).filter(isRecord)
  for (const entry of values) delete entry.default
  if (values.length > 1) agents.ownership = 'explicit'
  else if (values.length === 0) delete agents.ownership
}

function pruneAgentReferences(config, id) {
  const target = String(id || '').trim().toLowerCase()
  if (!target) return

  if (Array.isArray(config.bindings)) {
    config.bindings = config.bindings.filter(binding =>
      !isRecord(binding) || String(binding.agentId || '').trim().toLowerCase() !== target,
    )
  }

  const defaults = config?.agents?.defaults
  if (!isRecord(defaults)) return
  for (const key of ['heartbeat', 'systemAgent']) {
    const owner = defaults[key]
    if (!isRecord(owner) || String(owner.agentId || '').trim().toLowerCase() !== target) continue
    delete owner.agentId
    if (!Object.keys(owner).length) delete defaults[key]
  }
}

/** 获取可原地修改的条目；create=true 时按当前/目标内核形状创建。 */
export function ensureMutableAgentConfig(config, id, options = {}) {
  const normalizedId = String(id || '').trim().toLowerCase()
  if (!normalizedId) throw new Error('Agent ID 不能为空')
  const agents = ensureAgentsObject(config)
  const kind = agentRosterKind(config, options.installedVersion)

  if (kind === 'entries') {
    if (!isRecord(agents.entries)) agents.entries = {}
    delete agents.list
    const key = Object.keys(agents.entries).find(candidate => candidate.toLowerCase() === normalizedId)
    if (key) return agents.entries[key]
    if (!options.create) return null
    agents.entries[normalizedId] = {}
    normalizeCanonicalOwnership(agents)
    return agents.entries[normalizedId]
  }

  if (!Array.isArray(agents.list)) agents.list = []
  const existing = agents.list.find(entry =>
    isRecord(entry) && String(entry.id || 'main').trim().toLowerCase() === normalizedId,
  )
  if (existing) return existing
  if (!options.create) return null
  const entry = { id: normalizedId }
  agents.list.push(entry)
  return entry
}

export function addAgentConfig(config, id, values = {}, options = {}) {
  if (findAgentConfig(config, id)) throw new Error(`Agent "${id}" 已存在`)
  const entry = ensureMutableAgentConfig(config, id, { ...options, create: true })
  const kind = agentRosterKind(config, options.installedVersion)
  for (const [key, value] of Object.entries(values || {})) {
    if (kind === 'entries' && key === 'id') continue
    entry[key] = value
  }
  if (kind === 'entries') normalizeCanonicalOwnership(config.agents)
  return entry
}

export function removeAgentConfig(config, id) {
  const target = String(id || '').trim().toLowerCase()
  const agents = ensureAgentsObject(config)
  if (isRecord(agents.entries)) {
    const key = Object.keys(agents.entries).find(candidate => candidate.toLowerCase() === target)
    if (!key) return false
    delete agents.entries[key]
    normalizeCanonicalOwnership(agents)
    pruneAgentReferences(config, target)
    return true
  }
  if (!Array.isArray(agents.list)) return false
  const before = agents.list.length
  agents.list = agents.list.filter(entry =>
    !isRecord(entry) || String(entry.id || 'main').trim().toLowerCase() !== target,
  )
  const removed = agents.list.length !== before
  if (removed) pruneAgentReferences(config, target)
  return removed
}

/** 校准/初始化专用：确保目标内核得到合法且非空的注册表。 */
export function ensureAgentRoster(config, installedVersion = '') {
  const agents = ensureAgentsObject(config)
  if (agentRosterKind(config, installedVersion) === 'entries') {
    if (!isRecord(agents.entries)) agents.entries = {}
    delete agents.list
    if (!Object.values(agents.entries).some(isRecord)) agents.entries.main = {}
    normalizeCanonicalOwnership(agents)
    return 'entries'
  }
  if (!Array.isArray(agents.list)) agents.list = []
  return 'list'
}
