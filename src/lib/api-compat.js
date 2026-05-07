/**
 * 跨内核版本的归一化 API 封装
 *
 * 上游不同版本的 RPC 返回结构可能不同（数组 vs 分页对象、字段拆分等）。
 * 此模块为页面提供 **统一形态** 的 helper：
 * - 老内核返回数组 → wrapper 包成 { items, truncated, cursor }
 * - 新内核返回 { items, truncated, cursor } → 透传
 * - 页面按一致接口处理，不需自己 if/else
 *
 * 仅在需要使用 5.x 新返回字段（truncation、status 拆分等）时引入本模块；
 * 不需要新字段的页面可以继续直接用 wsClient.request(...)。
 *
 * @see .tmp/multi-kernel-compat-design.md §5
 */
import { wsClient } from './ws-client.js'
import { hasFeature } from './kernel.js'

/**
 * @typedef {Object} PagedResult
 * @property {any[]}   items       数据条目
 * @property {boolean} truncated   是否被服务端截断
 * @property {string|null} cursor  下一页游标，null 表示没有更多
 * @property {number|null} total   服务端如果返回总数则填，否则 null
 */

/**
 * 列出会话，归一化分页字段（兼容 4.x 数组返回 / 5.4+ 截断元数据）
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=100]
 * @param {string} [opts.cursor]
 * @returns {Promise<PagedResult>}
 */
export async function listSessions(opts = {}) {
  const params = { limit: opts.limit ?? 100 }
  if (opts.cursor) params.cursor = opts.cursor

  // sessions.list 在所有支持的内核版本（>=2026.3.x）都存在；用 requestCompat 仅为兜底
  const raw = await wsClient.requestCompat('sessions.list', params, [])

  // 老内核：直接返回数组
  if (Array.isArray(raw)) {
    return {
      items: raw,
      truncated: false,
      cursor: null,
      total: raw.length,
    }
  }

  // 5.4+：返回 { items, truncated, cursor } 或 { sessions, hasMore, nextCursor }
  const items = raw?.items ?? raw?.sessions ?? []
  const truncated = !!(raw?.truncated || raw?.hasMore)
  const cursor = raw?.cursor ?? raw?.nextCursor ?? null
  const total = raw?.total ?? null

  return { items, truncated, cursor, total }
}

/**
 * @typedef {Object} MemoryStatus
 * @property {boolean} ready                整体就绪
 * @property {{ ready: boolean, reason?: string|null }} vectorStore  向量存储（sqlite-vec）
 * @property {{ ready: boolean, reason?: string|null }} embedding    嵌入提供方
 * @property {string|null} reason           整体失败原因（兼容老内核）
 * @property {Object} raw                   原始返回，调试用
 */

/**
 * 获取记忆系统状态，归一化新老内核字段差异。
 *
 * 老内核（< 2026.5.3）：返回 { ready, reason }，前端无法区分 vector-store / embedding
 * 新内核（>= 2026.5.3）：返回 { ready, vectorStore: {...}, embedding: {...} }
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.deep]  仅在新内核生效，老内核忽略此字段
 * @returns {Promise<MemoryStatus>}
 */
export async function memoryStatus(opts = {}) {
  const params = {}
  if (opts.deep && hasFeature('memory.statusDeepSplit')) {
    params.deep = true
  }
  // 上游 RPC 名称在不同版本间统一为 doctor.memory.status，老内核可能没有
  const raw = await wsClient.requestCompat('doctor.memory.status', params, null)
  if (!raw) {
    return {
      ready: false,
      vectorStore: { ready: false, reason: null },
      embedding: { ready: false, reason: null },
      reason: 'unsupported',
      raw: null,
    }
  }

  const overallReady = raw?.ready ?? raw?.healthy ?? false
  const overallReason = raw?.reason ?? raw?.error ?? null

  return {
    ready: overallReady,
    vectorStore: {
      ready: raw?.vectorStore?.ready ?? overallReady,
      reason: raw?.vectorStore?.reason ?? null,
    },
    embedding: {
      ready: raw?.embedding?.ready ?? overallReady,
      reason: raw?.embedding?.reason ?? null,
    },
    reason: overallReason,
    raw,
  }
}

/**
 * @typedef {Object} ProbeStatus
 * @property {string} model
 * @property {string|null} status     可能值: 'ok' | 'no_model' | 'excluded_by_auth_order' | 'cooling_down'
 * @property {number|null} cooldownUntilMs
 * @property {string|null} reason
 */

/**
 * 模型探测：归一化 5.2+ 的 excluded_by_auth_order / no_model / cooldown 字段。
 *
 * @param {Object} [opts]
 * @returns {Promise<ProbeStatus[]>}
 */
export async function modelStatusProbe(opts = {}) {
  // 5.2+ 才有专用 probe RPC，老内核回退到 model.list
  if (hasFeature('models.probeStatus')) {
    const raw = await wsClient.requestCompat('model.status.probe', opts, null)
    if (raw) {
      const list = raw?.results || raw?.probes || raw || []
      return list.map(m => ({
        model: m.model || m.id || '',
        status: m.status || 'ok',
        cooldownUntilMs: m.cooldownUntilMs ?? m.cooldown_until_ms ?? null,
        reason: m.reason ?? null,
      }))
    }
  }

  // 降级：用 model.list 构造简化 probe 结果
  const raw = await wsClient.requestCompat('model.list', {}, null)
  if (!raw) return []
  const models = raw?.models || raw || []
  return models.map(m => ({
    model: m.id || m.fullId || m.name || '',
    status: 'ok',
    cooldownUntilMs: null,
    reason: null,
  }))
}

/**
 * 列出 Agents，自动剥离/补全 agentRuntime 字段。
 *
 * - 老内核（< 2026.5.2）：补 `agentRuntime: { id: 'pi' }` 默认值
 * - 新内核：透传
 *
 * 注意：底层调用的是 Tauri 命令 `list_agents`（封装了 Gateway RPC），不直接走 WS。
 */
export async function listAgentsCompat() {
  // 动态导入避免顶层依赖
  const { api } = await import('./tauri-api.js')
  const list = await api.listAgents()
  if (!Array.isArray(list)) return []

  return list.map(ag => {
    const out = { ...ag }
    if (!out.agentRuntime) {
      out.agentRuntime = { id: 'pi' }
    } else if (typeof out.agentRuntime === 'string') {
      out.agentRuntime = { id: out.agentRuntime }
    }
    return out
  })
}

/**
 * Cron 任务列表，归一化老/新返回结构。
 *
 * - 老内核：可能直接返回数组或 { jobs: [...] }
 * - 新内核（5.4+）：每个 job 多了 lastErrorDetail 字段
 *
 * @returns {Promise<{ jobs: any[] }>}
 */
export async function cronList(opts = {}) {
  const params = { includeDisabled: opts.includeDisabled ?? true }
  const raw = await wsClient.requestCompat('cron.list', params, null)
  if (!raw) return { jobs: [], raw: null }
  const jobs = Array.isArray(raw) ? raw : (raw?.jobs ?? [])
  return { jobs, raw }
}
