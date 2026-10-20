/** OpenCode 的 opaque iframe 只拥有自己的存储，不获得父页面同源权限。 */
export const OPENCODE_STORAGE_KEY = 'clawpanel-opencode-web-storage-v1'
const MESSAGE = 'clawpanel-opencode-storage-v1'
const STORES = ['documents', 'blobs']
const MAX_LOCAL = 2 * 1024 * 1024
const MAX_DATABASE = 32 * 1024 * 1024

export function sanitizeOpenCodeStorage(input) {
  const result = Object.create(null)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result
  for (const [key, value] of Object.entries(input)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 256 || typeof value !== 'string' || value.length > 512 * 1024) continue
    result[key] = value
  }
  if (JSON.stringify(result).length > MAX_LOCAL) throw new Error('OpenCode 本地存储超过 2MB')
  return result
}

export function readOpenCodeStorage() {
  return sanitizeOpenCodeStorage(JSON.parse(localStorage.getItem(OPENCODE_STORAGE_KEY) || '{}'))
}

/** 只绑定当前工作台 iframe；原生 IDB 始终使用独立固定命名空间。 */
export function bindOpenCodeStorageBridge(page) {
  const transactions = new Map()
  let dbPromise, disposed = false, activeDocument = null, opening = 0, sequence = 0, windowStart = Date.now(), messages = 0, created = false
  const error = (name, message) => Object.assign(new Error(message), { name })
  const open = () => dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('clawpanel-opencode-drafts-v1', 1)
    request.onupgradeneeded = () => {
      created = true
      for (const store of [...STORES, 'quota']) request.result.createObjectStore(store)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      if (disposed) { request.result.close(); reject(error('AbortError', '工作台已关闭')); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
  const fail = (state, cause) => {
    if (state.done || state.aborting) return
    state.aborting = true
    state.failure = cause
    // abort 已使原生事务失活；立即释放桥预算，不让旧文档占住新文档的配额。
    transactions.delete(state.id)
    try { state.native.abort() } catch {}
  }
  const send = (source, scope, instance, id, value, cause) => {
    if (disposed) return
    source.postMessage({ type: MESSAGE, scope, instance, reply: id, ...(cause ? { error: { name: cause.name || 'UnknownError', message: String(cause.message || cause).slice(0, 256) } } : { value }) }, '*')
  }
  const start = async (source, payload) => {
    const reply = (id, value, cause) => send(source, payload.scope, payload.instance, id, value, cause)
    if (!Array.isArray(payload.stores) || !payload.stores.length || payload.stores.some(s => !STORES.includes(s)) || !['readonly', 'readwrite'].includes(payload.mode)) throw error('NotSupportedError', '不支持的 OpenCode 事务')
    if (transactions.size + opening >= 8) throw error('QuotaExceededError', 'OpenCode 并发存储事务过多')
    opening++
    let db
    try { db = await open() } finally { opening-- }
    if (disposed || activeDocument?.instance !== payload.instance) throw error('AbortError', '工作台文档已关闭')
    const id = String(++sequence)
    const native = db.transaction([...new Set([...payload.stores, 'quota'])], payload.mode)
    const state = { id, source, scope: payload.scope, instance: payload.instance, native, stores: payload.stores, queue: [], done: false, closing: false, commitReply: null, deadline: Date.now() + 5000, operations: 0 }
    transactions.set(id, state)
    const finish = cause => {
      state.done = true
      transactions.delete(id)
      if (state.commitReply) reply(state.commitReply, null, cause)
      if (state.active && cause) reply(state.active.id, null, cause)
      for (const item of state.queue) reply(item.id, null, cause || error('AbortError', '事务已结束'))
      state.queue.length = 0
    }
    native.oncomplete = () => finish()
    native.onabort = () => finish(state.failure || native.error || error('AbortError', '事务已中止'))
    native.onerror = () => { state.failure ||= native.error }
    // 跨 frame 消息不是 IDB 活跃任务；只在原生请求回调内排队实际操作。
    const tick = () => {
      if (state.done || state.aborting) return
      if (Date.now() > state.deadline || disposed) return fail(state, error('TimeoutError', 'OpenCode 存储事务超时'))
      for (const item of state.busy ? [] : state.queue.splice(0, 1)) {
        state.busy = true; state.active = item
        try {
          const p = item.payload, store = native.objectStore(p.store)
          const complete = request => {
            request.onsuccess = () => { state.busy = false; state.active = null; reply(item.id, request.result) }
            request.onerror = () => { reply(item.id, null, request.error); fail(state, request.error) }
          }
          if (['put', 'delete'].includes(p.action)) {
            if (payload.mode !== 'readwrite') throw error('ReadOnlyError', '只读事务禁止写入')
            const size = p.action === 'delete' ? 0 : typeof p.value === 'string' ? p.value.length * 2 : p.value instanceof Blob ? p.value.size : -1
            if (size < 0 || size > 16 * 1024 * 1024) throw error('QuotaExceededError', 'OpenCode 草稿值超出限制')
            const quota = native.objectStore('quota'), entry = p.store + ':' + p.key
            const previous = quota.get(entry)
            previous.onsuccess = () => {
              const total = quota.get('total')
              total.onsuccess = () => {
                const next = Number(total.result || 0) - Number(previous.result || 0) + size
                if (next > MAX_DATABASE) { const e = error('QuotaExceededError', 'OpenCode 草稿存储超过 32MB'); reply(item.id, null, e); fail(state, e); return }
                quota.put(next, 'total')
                if (size) quota.put(size, entry); else quota.delete(entry)
                complete(p.action === 'put' ? store.put(p.value, p.key) : store.delete(p.key))
              }
            }
          } else if (p.action === 'getAll' || p.action === 'getAllKeys') complete(store[p.action]())
          else complete(store[p.action](p.key))
        } catch (e) { reply(item.id, null, e); fail(state, e) }
      }
      if (!state.aborting && (!state.closing || state.queue.length || state.busy)) {
        const keep = native.objectStore(payload.stores[0]).get('\u0000clawpanel-lease')
        keep.onsuccess = tick
      }
    }
    tick()
    return id
  }
  const listener = async event => {
    const frame = page.querySelector('#oc-workspace-frame')
    if (disposed || !frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return
    const p = event.data
    if (!p || p.type !== MESSAGE || typeof p.id !== 'string' || p.id.length > 80 || !/^[a-f0-9]{32}$/.test(p.instance)) return
    const frameUrl = new URL(frame.src, location.href), token = frameUrl.searchParams.get('__opencode_embed')
    const scope = token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? '/__opencode/' + token : frameUrl.pathname.match(/^\/__opencode\/[A-Za-z0-9_-]{32,128}\//)?.[0]?.slice(0, -1)
    if (!scope || p.scope !== scope) return
    const reply = (id, value, cause) => send(event.source, scope, p.instance, id, value, cause)
    if (p.op === 'snapshot') {
      activeDocument = { source: event.source, scope, instance: p.instance }
      // 新快照接管时，也释放整个 iframe 被替换后旧 WindowProxy 留下的事务。
      for (const state of transactions.values()) if (state.source !== event.source || state.scope !== scope || state.instance !== p.instance) fail(state, error('AbortError', '工作台文档已更新'))
    } else if (activeDocument?.source !== event.source || activeDocument?.scope !== scope || activeDocument?.instance !== p.instance) {
      reply(p.id, null, error('AbortError', '工作台文档已更新')); return
    }
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); messages = 0 }
    if (++messages > 1000) { reply(p.id, null, error('QuotaExceededError', 'OpenCode 存储请求过于频繁')); return }
    try {
      if (p.op === 'snapshot') reply(p.id, readOpenCodeStorage())
      else if (p.op === 'dispose') {
        activeDocument = null
        for (const state of transactions.values()) if (state.source === event.source && state.instance === p.instance) fail(state, error('AbortError', '工作台文档已关闭'))
      } else if (p.op === 'local') {
        const values = readOpenCodeStorage()
        if (p.action === 'clear') for (const key of Object.keys(values)) delete values[key]
        else {
          if (typeof p.key !== 'string' || !p.key || p.key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(p.key)) throw error('DataError', '无效的存储键')
          if (p.action === 'remove') delete values[p.key]
          else if (p.action === 'set' && typeof p.value === 'string') values[p.key] = p.value
          else throw error('NotSupportedError', '未知的存储操作')
        }
        localStorage.setItem(OPENCODE_STORAGE_KEY, JSON.stringify(sanitizeOpenCodeStorage(values)))
        reply(p.id, null)
      } else if (p.op === 'open') {
        if (p.name !== 'opencode-drafts' || p.version !== 1) throw error('NotSupportedError', '仅支持 OpenCode 草稿数据库 v1')
        await open(); reply(p.id, { version: 1, stores: STORES, upgradeNeeded: created }); created = false
      } else if (p.op === 'start') reply(p.id, await start(event.source, p))
      else {
        const state = transactions.get(p.transaction)
        if (!state || state.source !== event.source || state.scope !== scope || state.instance !== p.instance || state.done) throw error('TransactionInactiveError', '事务不存在或已结束')
        if (p.op === 'abort') { fail(state, error('AbortError', '事务已中止')); reply(p.id, null) }
        else if (p.op === 'commit') { state.commitReply = p.id; state.closing = true }
        else if (p.op === 'request') {
          if (state.closing || !state.stores.includes(p.store) || !['get', 'getKey', 'getAll', 'getAllKeys', 'put', 'delete'].includes(p.action) || ++state.operations > 1000) throw error('NotSupportedError', '无效的数据库请求')
          if (!['getAll', 'getAllKeys'].includes(p.action) && (typeof p.key !== 'string' || p.key.length > 4096)) throw error('DataError', '无效的草稿键')
          state.queue.push({ id: p.id, payload: p })
        } else throw error('NotSupportedError', '未知的数据库操作')
      }
    } catch (e) { reply(p.id, null, e) }
  }
  window.addEventListener('message', listener)
  return () => {
    disposed = true
    window.removeEventListener('message', listener)
    for (const state of transactions.values()) fail(state, error('AbortError', '工作台已关闭'))
    dbPromise?.then(db => db.close(), () => {})
  }
}

/** 此函数的独立源码由代理插入 iframe；不要引用外层模块的变量。 */
export function openCodeStorageBootstrap(initial, scope) {
  const TYPE = 'clawpanel-opencode-storage-v1', pending = new Map()
  const instance = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')
  window.__CLAWPANEL_OPENCODE_STORAGE_INSTANCE__ = instance
  let sequence = 0
  const call = payload => new Promise((resolve, reject) => {
    const id = String(++sequence)
    const timeout = setTimeout(() => { pending.delete(id); reject(new DOMException('存储桥无响应', 'TimeoutError')) }, 7000)
    pending.set(id, { resolve, reject, timeout })
    parent.postMessage({ ...payload, type: TYPE, id, scope, instance }, location.origin)
  })
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== TYPE || event.data.scope !== scope || event.data.instance !== instance) return
    const item = pending.get(event.data.reply)
    if (!item) return
    clearTimeout(item.timeout); pending.delete(event.data.reply)
    if (event.data.error) item.reject(new DOMException(event.data.error.message, event.data.error.name))
    else item.resolve(event.data.value)
  })
  window.addEventListener('pagehide', event => {
    if (!event.persisted) parent.postMessage({ type: TYPE, id: 'document-dispose', scope, instance, op: 'dispose' }, location.origin)
  })
  const values = Object.assign(Object.create(null), initial), confirmed = Object.assign(Object.create(null), initial), writes = new Map()
  let writeSequence = 0
  const apply = (target, operation) => {
    if (operation.action === 'clear') for (const key of Object.keys(target)) delete target[key]
    else if (operation.action === 'remove') delete target[operation.key]
    else target[operation.key] = operation.value
  }
  const rebase = () => {
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, confirmed)
    for (const operation of writes.values()) apply(values, operation)
  }
  const showWriteError = cause => {
    const show = () => {
      let box = document.getElementById('clawpanel-opencode-storage-error')
      if (!box) { box = document.createElement('div'); box.id = 'clawpanel-opencode-storage-error'; box.setAttribute('role', 'alert'); box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px;background:#7f1d1d;color:#fff;font:14px/1.5 sans-serif'; document.body?.appendChild(box) }
      box.textContent = 'OpenCode 偏好保存失败，未保存的更改已回退；草稿和会话不会因此删除。' + cause.message
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true })
  }
  const persist = operation => {
    const id = ++writeSequence
    writes.set(id, operation); apply(values, operation)
    call({ op: 'local', ...operation }).then(() => { apply(confirmed, operation); writes.delete(id); rebase() }, cause => { writes.delete(id); rebase(); showWriteError(cause) })
  }
  window.__CLAWPANEL_OC_STORAGE_READY__ = call({ op: 'snapshot' }).then(snapshot => {
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, snapshot)
    for (const key of Object.keys(confirmed)) delete confirmed[key]
    Object.assign(confirmed, snapshot)
  })
  window.__CLAWPANEL_OC_STORAGE_READY__.catch(e => {
    const show = () => { const box = document.createElement('pre'); box.textContent = 'OpenCode 存储初始化失败：' + e.message; document.body?.prepend(box) }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true })
  })
  const storage = {
    get length() { return Object.keys(values).length },
    key(index) { return Object.keys(values)[Number(index)] ?? null },
    getItem(key) { return Object.hasOwn(values, String(key)) ? values[String(key)] : null },
    setItem(key, value) {
      key = String(key); value = String(value)
      if (!key || key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key) || value.length > 512 * 1024 || JSON.stringify({ ...values, [key]: value }).length > 2 * 1024 * 1024) throw new DOMException('存储配额已满或键无效', 'QuotaExceededError')
      persist({ action: 'set', key, value })
    },
    removeItem(key) { persist({ action: 'remove', key: String(key) }) },
    clear() { persist({ action: 'clear' }) },
  }
  Object.defineProperty(window, 'localStorage', { value: storage })
  const session = Object.create(null)
  Object.defineProperty(window, 'sessionStorage', { value: {
    get length() { return Object.keys(session).length }, key(i) { return Object.keys(session)[Number(i)] ?? null },
    getItem(k) { return Object.hasOwn(session, String(k)) ? session[String(k)] : null },
    setItem(k, v) { k = String(k); v = String(v); if (k.length > 256 || v.length > 512 * 1024 || JSON.stringify({ ...session, [k]: v }).length > 2 * 1024 * 1024) throw new DOMException('Session 存储配额已满', 'QuotaExceededError'); session[k] = v }, removeItem(k) { delete session[String(k)] },
    clear() { for (const k of Object.keys(session)) delete session[k] },
  } })
  // 上游主题代码写 cookie；仅模拟 iframe 自己的偏好，绝不访问面板 Cookie。
  const cookieKey = 'clawpanel-isolated-ui-cookies'
  let cookies
  try { cookies = JSON.parse(storage.getItem(cookieKey) || '{}') } catch { cookies = {} }
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) cookies = {}
  Object.defineProperty(document, 'cookie', {
    get() { try { cookies = JSON.parse(storage.getItem(cookieKey) || '{}') } catch { cookies = {} }; return Object.entries(cookies || {}).filter(([k, v]) => typeof v === 'string').map(([k, v]) => k + '=' + v).join('; ') },
    set(raw) {
      try { cookies = JSON.parse(storage.getItem(cookieKey) || '{}') || {} } catch { cookies = {} }
      const parts = String(raw).split(';'), item = parts.shift(), index = item.indexOf('=')
      if (index < 1) return
      const key = item.slice(0, index).trim(), value = item.slice(index + 1)
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || value.length > 4096) return
      const expired = parts.some(x => /^\s*max-age\s*=\s*0\s*$/i.test(x) || /^\s*expires=/i.test(x) && Date.parse(x.slice(x.indexOf('=') + 1)) <= Date.now())
      if (expired) delete cookies[key]; else cookies[key] = value
      if (Object.keys(cookies).length > 32) throw new DOMException('Cookie 配额已满', 'QuotaExceededError')
      storage.setItem(cookieKey, JSON.stringify(cookies))
    },
  })
  class Target extends EventTarget {
    emit(type) { const event = new Event(type); this.dispatchEvent(event); this['on' + type]?.call(this, event) }
  }
  class Request extends Target {
    constructor() { super(); this.readyState = 'pending'; this.result = undefined; this.error = null }
    success(value) { this.result = value; this.readyState = 'done'; this.emit('success') }
    failure(e) { this.error = e; this.readyState = 'done'; this.emit('error') }
  }
  const waiting = [], running = new Set()
  let waitingBytes = 0, pumping = false
  // 父侧所有事务都含 quota store；写事务与任何事务重叠，读事务可并行。
  const conflicts = (left, right) => left.mode === 'readwrite' || right.mode === 'readwrite'
  const pump = () => {
    if (pumping) return
    pumping = true
    try {
      for (let index = 0; index < waiting.length && running.size < 8;) {
        const tx = waiting[index]
        if (Date.now() >= tx.deadline) { tx.failure(new DOMException('OpenCode 存储事务超时', 'TimeoutError')); continue }
        if ([...running].some(other => conflicts(tx, other)) || waiting.slice(0, index).some(other => conflicts(tx, other))) { index++; continue }
        waiting.splice(index, 1); running.add(tx); tx.launch()
      }
    } finally { pumping = false }
  }
  class Transaction extends Target {
    constructor(stores, mode) {
      super()
      if (!stores.length || stores.some(store => !['documents', 'blobs'].includes(store)) || !['readonly', 'readwrite'].includes(mode)) throw new DOMException('不支持的 OpenCode 事务', 'NotSupportedError')
      if (waiting.length >= 64) throw new DOMException('OpenCode 待处理存储事务过多', 'QuotaExceededError')
      this.mode = mode; this.stores = stores; this.pending = 0; this.done = false; this.error = null; this.requests = new Set(); this.operations = 0
      this.deadline = Date.now() + 5000
      this.started = new Promise((resolve, reject) => { this.resolveStarted = resolve; this.rejectStarted = reject })
      this.started.then(() => this.check(), e => this.failure(e))
      this.lease = setTimeout(() => this.failure(new DOMException('OpenCode 存储事务超时', 'TimeoutError')), 5000)
      waiting.push(this); pump()
    }
    launch() {
      call({ op: 'start', stores: this.stores, mode: this.mode }).then(transaction => {
        this.nativeId = transaction
        if (this.done) { this.cancelNative(); return }
        this.resolveStarted(transaction)
      }, e => { try { this.failure(e) } finally { this.release() } })
    }
    release() {
      clearTimeout(this.lease)
      const index = waiting.indexOf(this)
      if (index >= 0) waiting.splice(index, 1)
      running.delete(this); pump()
    }
    cancelNative() {
      if (!this.nativeId || this.cancelling) return
      this.cancelling = true
      // 原错误已由请求/事务事件传播；清理 RPC 的成败都必须释放调度槽。
      call({ op: 'abort', transaction: this.nativeId }).then(() => this.release(), () => this.release())
    }
    failure(e) {
      if (this.done) return
      this.done = true; this.error = e; clearTimeout(this.timer); clearTimeout(this.lease); this.rejectStarted(e)
      for (const entry of this.requests) {
        entry.release()
        if (entry.result.readyState === 'pending') entry.result.failure(e)
      }
      this.requests.clear(); this.pending = 0
      if (running.has(this)) this.cancelNative(); else this.release()
      this.emit('error'); this.emit('abort')
    }
    check() {
      clearTimeout(this.timer)
      if (this.pending || this.done) return
      this.timer = setTimeout(async () => {
        if (this.pending || this.done) return
        try {
          const transaction = await this.started
          if (this.done) return
          await call({ op: 'commit', transaction })
          if (this.done) return
          this.done = true; this.release(); this.emit('complete')
        } catch (e) { this.failure(e) }
      }, 0)
    }
    abort() { this.failure(new DOMException('事务已中止', 'AbortError')) }
    commit() { this.check() }
    objectStore(store) {
      if (!this.stores.includes(store)) throw new DOMException('未知的对象存储', 'NotFoundError')
      const request = (action, key, value, cursor = false) => {
        if (this.done) throw new DOMException('事务已结束', 'TransactionInactiveError')
        if (!['getAll', 'getAllKeys'].includes(action) && (typeof key !== 'string' || key.length > 4096)) throw new DOMException('无效的草稿键', 'DataError')
        if (action === 'put' || action === 'delete') {
          if (this.mode !== 'readwrite') throw new DOMException('只读事务禁止写入', 'ReadOnlyError')
        }
        const bytes = action !== 'put' ? 0 : typeof value === 'string' ? value.length * 2 : value instanceof Blob ? value.size : -1
        if (bytes < 0 || bytes > 16 * 1024 * 1024 || waitingBytes + bytes > 32 * 1024 * 1024) throw new DOMException('OpenCode 待处理草稿数据超过限制', 'QuotaExceededError')
        if (++this.operations > 1000) throw new DOMException('无效的数据库请求', 'NotSupportedError')
        const result = new Request(); result.transaction = this; this.pending++; clearTimeout(this.timer)
        let reserved = true
        waitingBytes += bytes
        const entry = { result, release: () => { if (reserved) { reserved = false; waitingBytes -= bytes } } }
        this.requests.add(entry)
        this.started.then(transaction => {
          if (this.done) throw this.error
          return call({ op: 'request', transaction, store, action, key, value })
        }).then(value => {
          if (this.done) return
          entry.release()
          if (!cursor) { this.requests.delete(entry); result.success(value); if (!this.done) { this.pending--; this.check() }; return }
          let index = 0
          const next = () => {
            let continued = false
            let active = true
            const row = index < value.length ? { key: value[index], primaryKey: value[index], delete: () => request('delete', value[index]), continue: () => { if (continued || !active || this.done) throw new DOMException('游标已继续或事务失活', 'InvalidStateError'); continued = true; index++; setTimeout(next, 0) } } : null
            result.success(row)
            active = false
            if (!continued && !this.done) { this.requests.delete(entry); this.pending--; this.check() }
          }
          next()
        }, e => this.failure(e))
        return result
      }
      return { get: key => request('get', key), getKey: key => request('getKey', key), getAll: () => request('getAll'), getAllKeys: () => request('getAllKeys'), put: (value, key) => request('put', key, value), delete: key => request('delete', key), openKeyCursor: () => request('getAllKeys', undefined, undefined, true) }
    }
  }
  const factory = {
    open(name, version = 1) {
      const result = new Request()
      call({ op: 'open', name, version }).then(meta => {
        const names = [...meta.stores]; names.contains = value => names.includes(value)
        const db = { name, version: meta.version, objectStoreNames: names, close() {}, createObjectStore(store) { if (!names.includes(store)) throw new DOMException('未知的对象存储', 'NotSupportedError'); return {} }, transaction(stores, mode = 'readonly') { return new Transaction(typeof stores === 'string' ? [stores] : [...stores], mode) } }
        result.result = db; if (meta.upgradeNeeded) result.emit('upgradeneeded'); result.success(db)
      }, e => result.failure(e))
      return result
    },
  }
  Object.defineProperty(window, 'indexedDB', { value: factory })
  window.__CLAWPANEL_OPENCODE_STORAGE__ = true
}
