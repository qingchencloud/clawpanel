import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { PiRpcProcess } from '../scripts/pi-rpc.js'
import { createPiState, applyPiEvent } from '../src/engines/pi/lib/session-state.js'

const fixture = () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => child.emit('exit', 1)
  child.stdin.once('finish', () => child.emit('exit', 0))
  child.stdin.on('data', chunk => {
    const record = JSON.parse(chunk.toString())
    if (record.type === 'extension_ui_response') return
    child.stdout.write(JSON.stringify({ type: 'response', id: record.id, success: true, data: record.type === 'get_state' ? { model: { provider: 'clawpanel-fixture' } } : {} }) + '\n')
  })
  const events = []
  const rpc = new PiRpcProcess({ cliPath: 'fixture.js', cwd: '.', env: {}, spawn: () => child, onEvent: event => events.push(event) })
  return { child, events, rpc }
}

test('Pi RPC 分帧保留 Unicode 分隔符及跨 chunk 中文 UTF-8', async () => {
  const { child, rpc, events } = fixture()
  await rpc.start()
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: '中文\u2028不拆帧\u2029' } }) + '\r\n')
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
  assert.equal(events.length, 1)
  assert.equal(events[0].message.content, '中文\u2028不拆帧\u2029')
  await rpc.stop()
})

test('Pi RPC 请求接受不是任务完成，交互按 id 校验，abort 清理队列和交互', async () => {
  const { child, rpc } = fixture()
  await rpc.start(); await rpc.prompt('hello')
  assert.equal(rpc.busy, true)
  child.stdout.write(JSON.stringify({ type: 'agent_end', willRetry: true }) + '\n')
  assert.equal(rpc.busy, true)
  child.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'question', method: 'select', options: ['one', 'two'] }) + '\n')
  assert.throws(() => rpc.respond({ id: 'question', value: 'three' }))
  assert.equal(rpc.respond({ id: 'question', value: 'one' }).success, true)
  assert.throws(() => rpc.respond({ id: 'question', value: 'one' }))
  await rpc.abort(); assert.equal(rpc.busy, false)
  await rpc.stop()
})

test('Pi RPC 进程错误拒绝所有等待请求，解析错误会停止进程', async () => {
  const { child, rpc } = fixture()
  await rpc.start()
  child.stdout.write('not-json\n')
  assert.equal(rpc.closed, true)
  await assert.rejects(rpc.request({ type: 'get_state' }), /已关闭/)
})

test('Pi RPC 四类交互回答按请求 ID 回传，取消和超时移除挂起请求', async () => {
  const { child, rpc } = fixture()
  const responses = []
  child.stdin.on('data', chunk => { const record = JSON.parse(chunk.toString()); if (record.type === 'extension_ui_response') responses.push(record) })
  await rpc.start()
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    rpc.accept({ type: 'extension_ui_request', id: method, method, options: ['one'] })
    const args = method === 'confirm' ? { confirmed: true } : { value: method === 'select' ? 'one' : '完整多行\n回答' }
    rpc.respond({ id: method, ...args })
    assert.deepEqual(responses.at(-1), { type: 'extension_ui_response', id: method, ...args })
  }
  rpc.accept({ type: 'extension_ui_request', id: 'cancelled', method: 'input' })
  rpc.respond({ id: 'cancelled', cancelled: true })
  assert.equal(responses.at(-1).cancelled, true)
  rpc.accept({ type: 'extension_ui_request', id: 'timeout', method: 'confirm', timeout: 5 })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(rpc.dialogs.has('timeout'), false)
  await rpc.stop()
})

test('Pi 状态归约最终消息覆盖流式 delta，agent_end 不结束任务', () => {
  const state = createPiState()
  applyPiEvent(state, { type: 'agent_start' })
  applyPiEvent(state, { type: 'message_start', message: { role: 'assistant', content: [] } })
  applyPiEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } })
  applyPiEvent(state, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete reply' }] } })
  applyPiEvent(state, { type: 'agent_end' })
  assert.equal(state.messages[0].content[0].text, 'complete reply')
  assert.equal(state.busy, true)
  applyPiEvent(state, { type: 'extension_ui_request', id: 'ask', method: 'confirm' })
  assert.equal(state.dialogs.length, 1)
  applyPiEvent(state, { type: 'agent_settled', aborted: false })
  assert.equal(state.busy, false); assert.equal(state.dialogs.length, 0)
})

test('Pi 累计消息快照优先于 delta，流式显示不重复首段内容', () => {
  const state = createPiState()
  applyPiEvent(state, { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '完整' }] } })
  applyPiEvent(state, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '完整' }] }, assistantMessageEvent: { type: 'text_delta', delta: '完整', contentIndex: 0 } })
  assert.equal(state.messages[0].content[0].text, '完整')
  applyPiEvent(state, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '完整回复' }] }, assistantMessageEvent: { type: 'text_delta', delta: '回复', contentIndex: 0 } })
  assert.equal(state.messages[0].content[0].text, '完整回复')
})

test('Pi 1.1 JSON start 重建文本块，避免初始首段和首个 delta 重复', () => {
  const state = createPiState()
  applyPiEvent(state, { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '完整' }] } })
  applyPiEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  applyPiEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '完整' } })
  assert.equal(state.messages[0].content[0].text, '完整')
  applyPiEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '回复' } })
  assert.equal(state.messages[0].content[0].text, '完整回复')
})
