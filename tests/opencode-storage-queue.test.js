import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { openCodeStorageBootstrap } from '../src/lib/opencode-storage-bridge.js'

// 这里只隔离 child 的调度协议；原生 IDB 原子性与完整 UI 另由浏览器探针验收。
function fixture(t, { now } = {}) {
  const scope = '/__opencode/queue-fixture-0123456789abcdefghijklmnopqrstuv'
  const origin = 'http://127.0.0.1:1420', listeners = new Map(), timers = new Set()
  const transactions = new Map(), durable = new Map(), starts = [], aborts = []
  let serial = 0, maximum = 0, holdRequests = false, holdStarts = false
  const heldRequests = [], heldStarts = []
  const later = (fn, ms = 0) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
    return timer
  }
  const clear = timer => { timers.delete(timer); clearTimeout(timer) }
  const parent = { postMessage(payload) { later(() => receive(payload)) } }
  const reply = (p, value, name) => {
    const data = { type: p.type, scope, instance: p.instance, reply: p.id, ...(name ? { error: { name, message: name } } : { value }) }
    for (const listener of listeners.get('message') || []) listener({ source: parent, origin, data })
  }
  const receive = p => {
    if (p.op === 'snapshot') return reply(p, {})
    if (p.op === 'open') return reply(p, { version: 1, stores: ['documents', 'blobs'], upgradeNeeded: false })
    if (p.op === 'start') {
      starts.push({ stores: [...p.stores], mode: p.mode })
      if (transactions.size >= 8) return reply(p, null, 'QuotaExceededError')
      const id = String(++serial)
      transactions.set(id, { writes: new Map() })
      maximum = Math.max(maximum, transactions.size)
      const answer = () => reply(p, id)
      if (holdStarts) heldStarts.push(answer); else later(answer, 5)
      return
    }
    const tx = transactions.get(p.transaction)
    if (!tx) return reply(p, null, 'TransactionInactiveError')
    if (p.op === 'abort') { transactions.delete(p.transaction); aborts.push(p.transaction); return reply(p, null) }
    if (p.op === 'commit') {
      for (const [key, value] of tx.writes) durable.set(key, value)
      transactions.delete(p.transaction)
      return reply(p, null)
    }
    if (p.op === 'request') {
      const answer = () => {
        if (!transactions.has(p.transaction)) return reply(p, null, 'AbortError')
        const key = p.store + ':' + p.key
        if (p.action === 'put') { tx.writes.set(key, p.value); reply(p, p.key) }
        else reply(p, tx.writes.has(key) ? tx.writes.get(key) : durable.get(key))
      }
      if (holdRequests) heldRequests.push(answer); else later(answer, 1)
    }
  }
  const body = { appendChild() {} }
  const context = vm.createContext({
    EventTarget, Event, DOMException, Blob, Uint8Array, crypto: webcrypto,
    // 仅边界测试固定 child 的 wall clock；实际5000ms lease定时器仍不缩短。
    ...(now ? { Date: class extends Date { static now() { return now() } } } : {}),
    setTimeout: later, clearTimeout: clear, parent, location: { origin },
    document: { body, getElementById() { return null }, createElement() { return { style: {}, setAttribute() {} } }, addEventListener() {} },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  })
  context.window = context
  vm.runInContext(`(${openCodeStorageBootstrap.toString()})({},${JSON.stringify(scope)})`, context)
  t.after(() => { for (const timer of timers) clearTimeout(timer); timers.clear() })
  const open = () => new Promise((resolve, reject) => {
    const q = context.indexedDB.open('opencode-drafts', 1)
    q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error)
  })
  const settled = tx => new Promise(resolve => {
    tx.oncomplete = () => resolve({ ok: true })
    tx.onabort = () => resolve({ ok: false, name: tx.error?.name })
  })
  return {
    open, settled, starts, aborts, durable, transactions,
    get maximum() { return maximum },
    set holdRequests(value) { holdRequests = value },
    set holdStarts(value) { holdStarts = value },
    releaseRequests() { holdRequests = false; for (const answer of heldRequests.splice(0)) answer() },
    releaseStarts() { holdStarts = false; for (const answer of heldStarts.splice(0)) answer() },
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('冷启动同步32个写事务排队，成功回调追加请求仍原子提交且无父8槽红灯', async t => {
  const f = fixture(t), db = await f.open(), completions = []
  for (let i = 0; i < 32; i++) {
    const tx = db.transaction(['documents', 'blobs'], 'readwrite')
    completions.push(f.settled(tx))
    const q = tx.objectStore('documents').put('draft-' + i, 'd-' + i)
    q.onsuccess = () => tx.objectStore('blobs').put(new Blob(['blob-' + i]), 'b-' + i)
  }
  const result = await Promise.all(completions)
  assert.ok(result.every(r => r.ok), JSON.stringify(result))
  assert.equal(f.maximum, 1, 'quota store 使所有写事务重叠，保持创建顺序串行')
  assert.equal(f.durable.size, 64)
  assert.equal(f.transactions.size, 0)
})

test('readonly最多8个并行，排队writer先于后来readonly开始', async t => {
  const f = fixture(t), db = await f.open(), completions = []
  for (let i = 0; i < 8; i++) {
    const tx = db.transaction('documents'); completions.push(f.settled(tx)); tx.objectStore('documents').get('a')
  }
  const writer = db.transaction('blobs', 'readwrite'); completions.push(f.settled(writer)); writer.objectStore('blobs').put('b', 'b')
  for (let i = 0; i < 8; i++) {
    const tx = db.transaction('documents'); completions.push(f.settled(tx)); tx.objectStore('documents').get('a')
  }
  const result = await Promise.all(completions)
  assert.ok(result.every(r => r.ok), JSON.stringify(result))
  assert.equal(f.maximum, 8)
  assert.equal(f.starts[8].mode, 'readwrite')
  assert.equal(f.transactions.size, 0)
})

test('排队事务abort不向父发start，不写数据；请求错误和abort只通知一次', async t => {
  const f = fixture(t), db = await f.open()
  f.holdRequests = true
  const first = db.transaction('documents', 'readwrite'), one = f.settled(first)
  first.objectStore('documents').put('kept', 'kept')
  await delay(20)
  const second = db.transaction('documents', 'readwrite'), two = f.settled(second)
  let requestErrors = 0, abortEvents = 0
  second.addEventListener('abort', () => abortEvents++)
  second.objectStore('documents').put('discarded', 'discarded').onerror = () => requestErrors++
  second.abort()
  await delay(20)
  assert.equal(f.starts.length, 1)
  assert.deepEqual(await two, { ok: false, name: 'AbortError' })
  assert.equal(requestErrors, 1)
  assert.equal(abortEvents, 1)
  f.releaseRequests()
  assert.deepEqual(await one, { ok: true })
  assert.equal(f.durable.has('documents:discarded'), false)
  assert.equal(f.transactions.size, 0)
})

test('start等待回复期间abort，迟到start必须abort释放父槽且不commit', async t => {
  const f = fixture(t), db = await f.open()
  f.holdStarts = true
  const tx = db.transaction('documents', 'readwrite'), done = f.settled(tx)
  tx.objectStore('documents').put('discarded', 'discarded')
  await delay(20)
  tx.abort()
  assert.deepEqual(await done, { ok: false, name: 'AbortError' })
  f.releaseStarts()
  await delay(30)
  assert.equal(f.transactions.size, 0)
  assert.equal(f.aborts.length, 1)
  assert.equal(f.durable.size, 0)
})

test('child待处理事务最多64个，溢出显式QuotaExceededError而非无限积压', async t => {
  const f = fixture(t), db = await f.open(), all = []
  f.holdRequests = true
  const first = db.transaction('documents', 'readwrite'); all.push(first); first.objectStore('documents').get('a')
  for (let i = 0; i < 64; i++) { const tx = db.transaction('documents', 'readwrite'); all.push(tx); tx.objectStore('documents').get('a') }
  assert.throws(() => db.transaction('documents', 'readwrite'), { name: 'QuotaExceededError' })
  for (const tx of all) tx.abort()
  f.releaseRequests()
  await delay(30)
  assert.equal(f.transactions.size, 0)
})

test('child排队数据最多32MB，abort立即释放排队数据预算', async t => {
  const f = fixture(t), db = await f.open()
  f.holdRequests = true
  const first = db.transaction('documents', 'readwrite'); first.objectStore('documents').get('a')
  const a = db.transaction('documents', 'readwrite'), b = db.transaction('blobs', 'readwrite'), c = db.transaction('documents', 'readwrite')
  a.objectStore('documents').put('x'.repeat(8*1024*1024), 'a')
  b.objectStore('blobs').put(new Blob([new Uint8Array(16*1024*1024)]), 'b')
  assert.throws(() => c.objectStore('documents').put('x', 'c'), { name: 'QuotaExceededError' })
  a.abort()
  assert.doesNotThrow(() => c.objectStore('documents').put('x', 'c'))
  b.abort(); c.abort(); first.abort(); f.releaseRequests()
  await delay(30)
  assert.equal(f.transactions.size, 0)
})

test('排队时间计入5s事务总lease，超时不启动旧事务且释放父槽', { timeout: 9000 }, async t => {
  let clock = 0
  const f = fixture(t, { now: () => clock }), db = await f.open()
  f.holdRequests = true
  const first = db.transaction('documents', 'readwrite'), a = f.settled(first); first.objectStore('documents').get('a')
  const next = db.transaction('blobs', 'readwrite'), b = f.settled(next); next.objectStore('blobs').get('b')
  // 两者明确同一deadline；否则Windows上第二个可合法晚1ms到期，先开始再超时并非过期启动。
  assert.equal(first.deadline, 5000); assert.equal(next.deadline, 5000)
  clock = 5000
  const result = await Promise.all([a, b])
  assert.deepEqual(result, [{ ok: false, name: 'TimeoutError' }, { ok: false, name: 'TimeoutError' }])
  assert.equal(f.starts.length, 1)
  f.releaseRequests(); await delay(30)
  assert.equal(f.transactions.size, 0)
})

test('queue deadline 精确边界：尚余1ms允许启动，到期时禁止；不把合法启动当过期', async t => {
  for (const offset of [4999, 5000]) {
    await t.test(String(offset), async t => {
      let clock = 0
      const f = fixture(t, { now: () => clock }), db = await f.open()
      f.holdRequests = true
      const first = db.transaction('documents', 'readwrite'), a = f.settled(first)
      first.objectStore('documents').get('a')
      const next = db.transaction('blobs', 'readwrite'), b = f.settled(next)
      next.objectStore('blobs').get('b')
      await delay(20); assert.equal(f.starts.length, 1)
      clock = offset; first.abort(); await delay(30)
      assert.equal(f.starts.length, offset === 4999 ? 2 : 1)
      if (offset === 4999) next.abort()
      assert.deepEqual(await a, { ok: false, name: 'AbortError' })
      assert.deepEqual(await b, { ok: false, name: offset === 4999 ? 'AbortError' : 'TimeoutError' })
      f.releaseRequests(); await delay(30); assert.equal(f.transactions.size, 0)
      assert.equal(f.durable.size, 0)
    })
  }
})
