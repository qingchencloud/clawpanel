// Gateway question 协议状态；仅保存在内存，不把提问或答案写入聊天历史。
const TERMINAL = new Set(['answered', 'cancelled', 'expired', 'unavailable'])

export function normalizeQuestionRecord(value) {
  if (!value || typeof value.id !== 'string' || !value.id ||
      !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 3 ||
      !Number.isFinite(value.expiresAtMs) || !['pending', ...TERMINAL].includes(value.status)) return null
  const ids = new Set()
  for (const q of value.questions) {
    if (!q || !/^[a-z][a-z0-9_]*$/.test(q.questionId) || ids.has(q.questionId) ||
        typeof q.question !== 'string' || !q.question || !Array.isArray(q.options) ||
        q.options.length > 4 || q.options.some(o => !o || typeof o.label !== 'string' || !o.label)) return null
    ids.add(q.questionId)
  }
  return { ...value, questions: value.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o })) })) }
}

export function buildQuestionAnswers(record, values) {
  const answers = Object.create(null)
  for (const q of record.questions) {
    const items = values[q.questionId]
    if (!Array.isArray(items) || !items.length || (!q.multiSelect && items.length !== 1)) throw new Error('questionRequired')
    if (q.isSecret || q.secretStore) throw new Error('questionSecretHint')
    const cleaned = [...new Set(items.map(v => typeof v === 'string' ? v.trim() : ''))]
    if (cleaned.some(v => !v)) throw new Error('questionRequired')
    if (q.options.length && !q.isOther && cleaned.some(v => !q.options.some(o => o.label.trim() === v))) throw new Error('questionRequired')
    answers[q.questionId] = cleaned.map(v => q.options.find(o => o.label.trim() === v)?.label || v)
  }
  return { answers }
}

export class ChatQuestions {
  constructor(client, onChange = () => {}, clock = {}) {
    this.client = client
    this.onChange = onChange
    this.now = clock.now || Date.now
    this.setTimer = clock.setTimeout || ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = clock.clearTimeout || (id => clearTimeout(id))
    this.records = new Map()
    this.revisions = new Map()
    this.busy = new Set()
    this.errors = new Map()
    this.connected = false
    this.ready = false
    this.error = ''
    this.generation = 0
    this.revision = 0
    this.timer = null
    this.sync = null
  }

  forSession(key) {
    // 没有会话归属的全局提问不绑定到当前聊天，更不跨 Agent 代答。
    return [...this.records.values()].filter(r => key && r.sessionKey === key)
      .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0))
  }

  hasPending(key) { return this.forSession(key).some(r => r.status === 'pending') }

  setConnected(connected) {
    this.generation++
    this.connected = connected
    this.ready = false
    this.sync = null
    this.busy.clear()
    this.notify()
    if (connected) return this.refresh()
  }

  notify() {
    this.clearTimer(this.timer)
    this.timer = null
    // 终态记录有限保留，防止迟到的 requested/list 把已答问题重新激活。
    const terminal = [...this.records.values()].filter(r => TERMINAL.has(r.status))
    for (const r of terminal.slice(0, Math.max(0, terminal.length - 100))) {
      this.records.delete(r.id)
      this.errors.delete(r.id)
    }
    const pending = [...this.records.values()].filter(r => r.status === 'pending')
    if (pending.length) {
      const delay = Math.max(1, Math.min(2147483647, Math.min(...pending.map(r => r.expiresAtMs)) - this.now()))
      this.timer = this.setTimer(() => {
        for (const r of this.records.values()) if (r.status === 'pending' && r.expiresAtMs <= this.now()) this.put({ ...r, status: 'expired' })
        this.notify()
      }, delay)
    }
    this.onChange()
  }

  put(record) {
    this.records.set(record.id, record)
    this.revisions.set(record.id, ++this.revision)
    // 保留足够长的终态墓碑，并限制长期会话的内存占用。
    if (this.revisions.size > 1000) for (const id of this.revisions.keys()) {
      if (!this.records.has(id)) this.revisions.delete(id)
      if (this.revisions.size <= 500) break
    }
  }

  handleEvent({ event, payload }) {
    if (!payload || typeof payload.id !== 'string') return false
    if (event === 'question.requested') {
      const record = normalizeQuestionRecord(payload)
      if (!record) return false
      if (TERMINAL.has(this.records.get(record.id)?.status)) return true
      if (record.expiresAtMs <= this.now()) record.status = 'expired'
      this.put(record)
    } else if (event === 'question.resolved' && TERMINAL.has(payload.status)) {
      const record = this.records.get(payload.id)
      // resolved 可能先于 list 返回；保留墓碑阻止旧快照复活问题。
      this.put({ ...record, id: payload.id, status: payload.status })
      this.errors.delete(payload.id)
    } else return false
    this.notify()
    return true
  }

  refresh() {
    if (!this.connected) return Promise.resolve()
    if (this.sync) return this.sync
    const generation = this.generation
    const revision = this.revision
    this.sync = (async () => {
      try {
        const result = await this.client.questionsList()
        if (generation !== this.generation) return
        if (result !== null && !Array.isArray(result?.questions)) throw new Error('Invalid question.list response')
        const listed = new Set()
        for (const raw of result?.questions || []) {
          const record = normalizeQuestionRecord(raw)
          if (!record) continue
          listed.add(record.id)
          if ((this.revisions.get(record.id) || 0) > revision || TERMINAL.has(this.records.get(record.id)?.status)) continue
          if (record.expiresAtMs <= this.now()) record.status = 'expired'
          this.put(record)
        }
        for (const record of this.records.values()) {
          if (record.status === 'pending' && !listed.has(record.id) && (this.revisions.get(record.id) || 0) <= revision) {
            this.put({ ...record, status: 'unavailable' })
          }
        }
        this.error = ''
        this.ready = true
      } catch {
        if (generation === this.generation) this.error = 'questionLoadFailed'
      } finally {
        if (generation === this.generation) { this.sync = null; this.notify() }
      }
    })()
    return this.sync
  }

  async resolve(id, values, cancel = false) {
    const record = this.records.get(id)
    if (!this.connected || !this.ready || this.busy.has(id) || record?.status !== 'pending') return false
    if (record.expiresAtMs <= this.now()) { this.put({ ...record, status: 'expired' }); this.notify(); return false }
    let answers
    try { if (!cancel) answers = buildQuestionAnswers(record, values) } catch (e) { this.errors.set(id, e.message); this.notify(); return false }
    const generation = this.generation
    this.busy.add(id)
    this.errors.delete(id)
    this.notify()
    try {
      const result = await this.client.questionResolve(id, answers, cancel)
      if (generation !== this.generation) return false
      if (!['answered', 'cancelled'].includes(result?.status)) throw new Error('Invalid question.resolve response')
      this.handleEvent({ event: 'question.resolved', payload: { id, status: result.status } })
      return true
    } catch (e) {
      if (generation === this.generation && this.records.get(id)?.status === 'pending') {
        this.errors.set(id, 'questionSubmitFailed')
        // 另一客户端已回答、请求过期等情况，以 Gateway 回读为准；网络失败保留输入。
        await this.refresh()
      }
      return false
    } finally {
      if (generation === this.generation) { this.busy.delete(id); this.notify() }
    }
  }

  dispose() {
    this.generation++
    this.connected = false
    this.clearTimer(this.timer)
    this.records.clear()
    this.revisions.clear()
    this.busy.clear()
    this.errors.clear()
    this.onChange = () => {}
  }
}
