import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ChatQuestions, buildQuestionAnswers, normalizeQuestionRecord } from '../src/lib/chat-questions.js'

const record = (extra = {}) => ({
  id: 'request-1', sessionKey: 'agent:main:main', runId: 'run-1',
  createdAtMs: 1000, expiresAtMs: 901000, status: 'pending',
  questions: [{ questionId: 'source', header: '来源', question: '请选择数据来源', options: [{ label: '官方' }, { label: '截图' }], isOther: true }],
  ...extra,
})
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fakeClock() {
  let time = 1000, sequence = 0
  const tasks = new Map()
  return {
    now: () => time,
    setTimeout: (fn, ms) => { tasks.set(++sequence, { fn, at: time + ms }); return sequence },
    clearTimeout: id => tasks.delete(id),
    async tick(ms) {
      const end = time + ms
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        time = next[1].at; tasks.delete(next[0]); await next[1].fn()
      }
      time = end
    },
    tasks,
  }
}
function setup(overrides = {}, onChange) {
  const clock = fakeClock()
  const calls = []
  const client = {
    questionsList: async () => ({ questions: [] }),
    questionResolve: async (...args) => { calls.push(args); return { status: args[2] ? 'cancelled' : 'answered' } },
    ...overrides,
  }
  const store = new ChatQuestions(client, onChange, clock)
  return { store, client, clock, calls }
}
const requested = (store, value = record()) => store.handleEvent({ event: 'question.requested', payload: value })

test('识别官方 question.requested，并按会话隔离、不显示无归属问题', async () => {
  const { store } = setup()
  await store.setConnected(true)
  requested(store); requested(store, record({ id: 'other', sessionKey: 'agent:other:main' })); requested(store, record({ id: 'global', sessionKey: undefined }))
  assert.equal(store.forSession('agent:main:main').length, 1)
  assert.equal(store.hasPending('agent:main:main'), true)
  assert.equal(store.forSession('new').length, 0)
  assert.equal(store.forSession(null).length, 0)
  store.dispose()
})

test('提问形状校验和单选、多选、自由答案遵守服务端规则', () => {
  assert.equal(normalizeQuestionRecord({}), null)
  assert.equal(normalizeQuestionRecord(record({ questions: [{ questionId: 'bad key' }] })), null)
  assert.deepEqual(JSON.parse(JSON.stringify(buildQuestionAnswers(record(), { source: [' 自定义 '] }))), { answers: { source: ['自定义'] } })
  assert.throws(() => buildQuestionAnswers(record(), { source: [] }), /questionRequired/)
  assert.throws(() => buildQuestionAnswers(record(), { source: ['官方', '截图'] }), /questionRequired/)
  const multi = record({ questions: [{ ...record().questions[0], multiSelect: true, isOther: false }] })
  assert.deepEqual(buildQuestionAnswers(multi, { source: ['官方', '截图'] }).answers.source, ['官方', '截图'])
  assert.throws(() => buildQuestionAnswers(multi, { source: ['未知'] }), /questionRequired/)
  const free = record({ questions: [{ ...record().questions[0], options: [] }] })
  assert.deepEqual(buildQuestionAnswers(free, { source: ['自由文本'] }).answers.source, ['自由文本'])
})

test('敏感问题不进入普通答案收集链路', () => {
  const secret = record({ questions: [{ ...record().questions[0], isSecret: true, options: [] }] })
  assert.throws(() => buildQuestionAnswers(secret, { source: ['secret-input'] }), /questionSecretHint/)
})

test('三题必须全部回答，RPC 提交 questionId 到数组的映射而非 chat.send', async () => {
  const { store, calls } = setup()
  await store.setConnected(true)
  requested(store, record({ questions: [1, 2, 3].map(i => ({ questionId: `q${i}`, header: '', question: `题 ${i}`, options: [] })) }))
  assert.equal(await store.resolve('request-1', { q1: ['a'] }), false)
  assert.equal(calls.length, 0)
  assert.equal(await store.resolve('request-1', { q1: ['a'], q2: ['b'], q3: ['c'] }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['request-1', { answers: { q1: ['a'], q2: ['b'], q3: ['c'] } }, false])
  assert.equal(store.hasPending('agent:main:main'), false)
  store.dispose()
})

test('防重复提交，只有 Gateway 确认成功才结束等待', async () => {
  const pending = deferred()
  const { store, calls, client } = setup()
  await store.setConnected(true); requested(store)
  client.questionResolve = (...args) => { calls.push(args); return pending.promise }
  const first = store.resolve('request-1', { source: ['官方'] })
  assert.equal(store.hasPending('agent:main:main'), true)
  assert.equal(await store.resolve('request-1', { source: ['截图'] }), false)
  assert.equal(calls.length, 1)
  pending.resolve({ status: 'answered' }); assert.equal(await first, true)
  assert.equal(store.hasPending('agent:main:main'), false)
  store.dispose()
})

test('取消走 question.resolve cancel，不伪造空答案', async () => {
  const { store, calls } = setup()
  await store.setConnected(true); requested(store)
  await store.resolve('request-1', {}, true)
  assert.equal(calls[0][2], true)
  assert.equal(store.records.get('request-1').status, 'cancelled')
  store.dispose()
})

test('读取不支持的旧内核静默降级，认证错误仍显示读取失败', async () => {
  const { store, client } = setup({ questionsList: async () => null })
  await store.setConnected(true)
  assert.equal(store.error, '')
  assert.equal(store.ready, true)
  client.questionsList = async () => { throw new Error('FORBIDDEN') }
  await store.setConnected(true)
  assert.equal(store.error, 'questionLoadFailed')
  assert.equal(store.ready, false)
  store.dispose()
})

test('刷新/重连从 question.list 恢复待答状态，掉线禁止提交', async () => {
  const { store, calls } = setup({ questionsList: async () => ({ questions: [record()] }) })
  await store.setConnected(true)
  store.setConnected(false)
  assert.equal(await store.resolve('request-1', { source: ['官方'] }), false)
  assert.equal(calls.length, 0)
  await store.setConnected(true)
  assert.equal(store.hasPending('agent:main:main'), true)
  assert.equal(await store.resolve('request-1', { source: ['官方'] }), true)
  store.dispose()
})

test('提交失败保留 pending 和错误提示，重试后成功', async () => {
  const { store, client } = setup({ questionsList: async () => ({ questions: [record()] }) })
  await store.setConnected(true)
  client.questionResolve = async () => { throw new Error('network down') }
  assert.equal(await store.resolve('request-1', { source: ['官方'] }), false)
  assert.equal(store.hasPending('agent:main:main'), true)
  assert.equal(store.errors.get('request-1'), 'questionSubmitFailed')
  client.questionResolve = async () => ({ status: 'answered' })
  assert.equal(await store.resolve('request-1', { source: ['官方'] }), true)
  store.dispose()
})

test('resolved 先到，迟到 list/requested 不复活问题', async () => {
  const pending = deferred()
  const { store } = setup({ questionsList: () => pending.promise })
  const sync = store.setConnected(true)
  store.handleEvent({ event: 'question.resolved', payload: { id: 'request-1', status: 'answered' } })
  pending.resolve({ questions: [record()] }); await sync
  requested(store)
  assert.equal(store.hasPending('agent:main:main'), false)
  store.dispose()
})

test('list 在途收到新问题，旧空列表不能移除它', async () => {
  const pending = deferred()
  const { store } = setup({ questionsList: () => pending.promise })
  const sync = store.setConnected(true)
  requested(store)
  pending.resolve({ questions: [] }); await sync
  assert.equal(store.hasPending('agent:main:main'), true)
  store.dispose()
})

test('旧连接的异步列表和提交响应不能覆盖新连接', async () => {
  const pending = deferred()
  const { store, client } = setup({ questionsList: () => pending.promise })
  const old = store.setConnected(true)
  store.setConnected(false)
  client.questionsList = async () => ({ questions: [] })
  await store.setConnected(true)
  pending.resolve({ questions: [record()] }); await old
  assert.equal(store.records.size, 0)
  requested(store)
  const answer = deferred(); client.questionResolve = () => answer.promise
  const submit = store.resolve('request-1', { source: ['官方'] })
  store.setConnected(false)
  answer.resolve({ status: 'answered' }); await submit
  assert.equal(store.records.get('request-1').status, 'pending')
  store.dispose()
})

test('过期或已由其他客户端处理后关闭卡片，不继续提交', async () => {
  const { store, clock, client, calls } = setup()
  await store.setConnected(true)
  requested(store, record({ expiresAtMs: 2000 }))
  await clock.tick(1001)
  assert.equal(store.records.get('request-1').status, 'expired')
  assert.equal(await store.resolve('request-1', { source: ['官方'] }), false)
  requested(store, record({ id: 'request-2' }))
  await store.refresh()
  assert.equal(store.records.get('request-2').status, 'unavailable')
  assert.equal(calls.length, 0)
  store.dispose()
  assert.equal(clock.tasks.size, 0)
})

// 加载真实聊天页的事件/计时器函数，仅替换 DOM、持久化和时间源。
function chatHarness() {
  const clock = fakeClock(), messages = [], saved = [], bubbles = []
  const context = vm.createContext({
    ChatQuestions, clock, messages, saved, bubbles, console,
    t: key => key, uuid: () => 'id', renderMarkdown: text => text,
    saveMessage: msg => saved.push(msg),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setTimeout, clearInterval: clock.clearTimeout,
    Date: class extends Date { static now() { return clock.now() } },
    wsClient: { questionsList: async () => ({ questions: [] }), questionResolve: async () => ({ status: 'answered' }), chatHistory: async () => ({ messages: [] }), gatewayReady: true },
  })
  const source = readFileSync(new URL('../src/pages/chat.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  vm.runInContext(source + `
    showTyping = () => {}; updateSendState = () => {}; scrollToBottom = () => {};
    appendSystemMessage = text => messages.push(text);
    appendImagesToEl = appendVideosToEl = appendAudiosToEl = appendFilesToEl = appendToolsToEl = () => {};
    createStreamBubble = () => { const bubble = {innerHTML: '', parentElement: null}; bubbles.push(bubble); return bubble };
    throttledRender = () => { _currentAiBubble.innerHTML = _currentAiText };
    loadHistory = async () => {}; shouldCaptureHostedTarget = () => false;
    _pageActive = true; _sessionKey = 'agent:main:main';
    _questions = new ChatQuestions(wsClient, onQuestionsChanged, clock);
    globalThis.h = {
      event: handleEvent, ready: () => _questions.setConnected(true),
      resolve: () => _questions.resolve('request-1', {source: ['官方']}),
      waiting: () => _isAwaitingResponse, streaming: () => _isStreaming,
      hasPending: hasPendingQuestion,
      start: () => { _isAwaitingResponse = true; _startResponseWatchdog() },
      setList: fn => { wsClient.questionsList = fn },
      switchAway: () => { _sessionKey = 'agent:other:main'; _waitingQuestionSession = null; _cancelResponseWatchdog(); resetStreamState(); onQuestionsChanged() },
      dispose: () => { _questions.dispose(); _cancelResponseWatchdog(); resetStreamState(); clearTimeout(_postFinalCheck) },
    };
  `, context)
  return { h: context.h, clock, messages, saved, bubbles }
}
const delta = text => ({ event: 'chat', payload: { sessionKey: 'agent:main:main', runId: 'run-1', state: 'delta', message: { content: text } } })

test('复现截图：delta 后提问，超过 90/180 秒仍待答，回答后继续同一 run', async () => {
  const { h, clock, messages, saved } = chatHarness()
  await h.ready(); h.start(); h.event(delta('请先选择：'))
  h.event({ event: 'question.requested', payload: record() })
  await clock.tick(240000)
  assert.equal(h.hasPending(), true)
  assert.equal(h.waiting(), true)
  assert.deepEqual(messages, [])
  await h.resolve()
  h.event(delta('请先选择：已收到，继续执行'))
  h.event({ event: 'chat', payload: { ...delta('').payload, state: 'final', message: { content: '最终完整答案（不丢最后一段）' } } })
  assert.equal(saved.at(-1).content, '最终完整答案（不丢最后一段）')
  assert.equal(h.streaming(), false)
  assert.deepEqual(messages, [])
  h.dispose()
})

test('漏收 requested 时，90 秒超时前回读 pending，避免假结束', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.event(delta('请先确认'))
  h.setList(async () => ({ questions: [record()] }))
  await clock.tick(91000)
  assert.equal(h.hasPending(), true)
  assert.deepEqual(messages, [])
  h.dispose()
})

test('正常卡死仍会超时，同一会话的工具活动可延长空闲计时', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.event(delta('正在处理'))
  await clock.tick(80000)
  h.event({ event: 'agent', payload: { sessionKey: 'agent:main:main', runId: 'run-1', stream: 'tool', data: {} } })
  await clock.tick(80000)
  assert.deepEqual(messages, [])
  await clock.tick(10001)
  assert.deepEqual(messages, ['chat.streamTimeout'])
  h.dispose()
})

test('其他会话的提问和工具事件不掩盖当前会话超时', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.event(delta('正在处理'))
  h.event({ event: 'question.requested', payload: record({ sessionKey: 'agent:other:main' }) })
  await clock.tick(80000)
  h.event({ event: 'agent', payload: { sessionKey: 'agent:other:main', stream: 'tool', data: {} } })
  await clock.tick(10001)
  assert.deepEqual(messages, ['chat.streamTimeout'])
  h.dispose()
})

test('切换会话后，旧提问 resolved 不触发新会话等待', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.event({ event: 'question.requested', payload: record() })
  h.switchAway()
  h.event({ event: 'question.resolved', payload: { id: 'request-1', status: 'answered' } })
  assert.equal(h.waiting(), false)
  await clock.tick(240000)
  assert.deepEqual(messages, [])
  h.dispose()
})

test('等待回复阶段的 180 秒超时也识别提问，非提问卡死仍结束', async () => {
  const pending = chatHarness()
  await pending.h.ready(); pending.h.start()
  pending.h.event({ event: 'question.requested', payload: record() })
  await pending.clock.tick(240000)
  assert.deepEqual(pending.messages, [])
  pending.h.dispose()
  const stuck = chatHarness()
  await stuck.h.ready(); stuck.h.start(); await stuck.clock.tick(180001)
  assert.deepEqual(stuck.messages, ['chat.responseTimeout'])
  stuck.h.dispose()
})

test('同一 run 的工具活动延长首回复空闲计时，而非绝对 3 分钟结束', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.start()
  await clock.tick(150000)
  h.event({ event: 'agent', payload: { sessionKey: 'agent:main:main', runId: 'run-1', stream: 'thinking', data: {} } })
  await clock.tick(150000)
  assert.deepEqual(messages, [])
  await clock.tick(30001)
  assert.deepEqual(messages, ['chat.responseTimeout'])
  h.dispose()
})

test('无关联 run 的独立提问结束后，不启动虚假的回复超时', async () => {
  const { h, clock, messages } = chatHarness()
  await h.ready(); h.event({ event: 'question.requested', payload: record({ runId: undefined }) })
  h.event({ event: 'question.resolved', payload: { id: 'request-1', status: 'cancelled' } })
  await clock.tick(240000)
  assert.equal(h.waiting(), false)
  assert.deepEqual(messages, [])
  h.dispose()
})

test('WsClient 的 question RPC 能力降级和写入参数精确匹配官方契约', async () => {
  const source = readFileSync(new URL('../src/lib/ws-client.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*? from ['"][^'"\n]+['"]\r?\n/gm, '').replace(/^export /gm, '')
  const context = vm.createContext({ console, crypto: { randomUUID: () => 'id' } })
  vm.runInContext(source + '\nglobalThis.Client = WsClient', context)
  const client = new context.Client()
  const calls = []
  client.request = async (method, params) => { calls.push({ method, params }); return { questions: [] } }
  client._hello = { features: { methods: ['chat.send'] } }
  assert.equal(await client.questionsList(), null)
  assert.equal(calls.length, 0)
  client._hello = { features: { methods: ['question.list', 'question.resolve'] } }
  await client.questionsList()
  await client.questionResolve('request-1', { answers: { source: ['官方'] } })
  await client.questionResolve('request-1', undefined, true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { method: 'question.list', params: {} },
    { method: 'question.resolve', params: { id: 'request-1', answers: { answers: { source: ['官方'] } } } },
    { method: 'question.resolve', params: { id: 'request-1', cancel: true } },
  ])
  client._hello = {}
  let count = 0
  client.request = async () => { count++; throw Object.assign(new Error('unknown method'), { code: 'METHOD_NOT_FOUND' }) }
  assert.equal(await client.questionsList(), null)
  assert.equal(await client.questionsList(), null)
  assert.equal(count, 1)
  await assert.rejects(() => client.questionResolve('id', { answers: {} }), /unknown method/)
})
