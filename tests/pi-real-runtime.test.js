/** 可选真 Pi 验收：只访问本地模拟 Provider，不调用真实收费模型。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { PiRuntime } from '../scripts/pi-runtime.js'
import { createPiState, applyPiEvent } from '../src/engines/pi/lib/session-state.js'

const root = process.env.PI_REAL_RUNTIME_ROOT
test('真实 Pi：配置回读、流式消息、切换模型、审批、取消与历史恢复', { skip: !root, timeout: 120000 }, async () => {
  let server, runtime
  const serverRequests = []
  const send = (res, choices) => res.write('data: ' + JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices }) + '\n\n')
  server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    serverRequests.push(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const lastUser = body.messages.filter(message => message.role === 'user').at(-1)
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content)
    const last = body.messages.at(-1)
    if (prompt?.includes('fixture-write') && last.role !== 'tool') {
      send(res, [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool-' + serverRequests.length, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'pi-receipt.txt', content: 'approved-fixture' }) } }] }, finish_reason: null }])
      send(res, [{ index: 0, delta: {}, finish_reason: 'tool_calls' }])
      res.end('data: [DONE]\n\n'); return
    }
    send(res, [{ index: 0, delta: { role: 'assistant', content: '完整' }, finish_reason: null }])
    const timer = setTimeout(() => {
      send(res, [{ index: 0, delta: { content: '回复\u2028保留分隔符' }, finish_reason: null }])
      send(res, [{ index: 0, delta: {}, finish_reason: 'stop' }])
      res.end('data: [DONE]\n\n')
    }, prompt?.includes('fixture-abort') ? 20000 : 50)
    res.once('close', () => clearTimeout(timer))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const channel = { id: 'pi-local-fixture', apiType: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-local', models: [{ id: 'fixture-model', contextWindow: 65536, maxTokens: 4096 }, { id: 'fixture-second', contextWindow: 131072, maxTokens: 8192 }], defaultModel: 'fixture-model' }
  runtime = new PiRuntime({ root, readChannel: () => channel })
  let sessionId, cursor = 0
  const until = async predicate => {
    const all = []
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const result = await runtime.call('events', { sessionId, after: cursor })
      cursor = result.cursor
      all.push(...result.events.map(record => record.event))
      if (predicate(all)) return all
    }
    throw new Error('Pi fixture event deadline exceeded')
  }
  try {
    assert.ok(path.resolve(root).includes(`${path.sep}.tmp${path.sep}`), '真实验收根目录必须位于隔离 .tmp 目录')
    assert.equal(runtime.status().installed, true)
    const synced = await runtime.syncProvider({ channelId: channel.id, setDefault: true })
    assert.equal(synced.verified, true)
    assert.equal(runtime.status().providers[0].models[0].contextWindow, 65536)
    const workspace = runtime.file('workspace', 'smoke-' + Date.now())
    fs.mkdirSync(workspace, { recursive: true })
    await runtime.configure({ workspace, allowTools: true })
    const opened = await runtime.open()
    sessionId = opened.sessionId; cursor = opened.cursor
    assert.equal(opened.models.length, 2)
    await runtime.call('prompt', { sessionId, message: 'fixture-hello' })
    const normal = await until(events => events.some(event => event.type === 'agent_settled'))
    const visible = createPiState(), streamed = []
    for (const event of normal) {
      applyPiEvent(visible, event)
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        streamed.push(event.assistantMessageEvent.delta)
        assert.equal(visible.messages[visible.active].content[0].text, streamed.join(''))
      }
    }
    const final = normal.findLast(event => event.type === 'message_end' && event.message.role === 'assistant')
    assert.ok(final.message.content.some(block => block.text === '完整回复\u2028保留分隔符'))
    assert.equal(runtime.worker(sessionId).rpc.busy, false)
    await runtime.call('set_model', { sessionId, provider: synced.providerId, modelId: 'fixture-second' })
    assert.equal((await runtime.state(sessionId)).state.model.id, 'fixture-second')
    await runtime.call('prompt', { sessionId, message: 'fixture-write deny' })
    await until(events => events.some(event => event.type === 'extension_ui_request' && event.method === 'confirm'))
    const dialog = [...runtime.worker(sessionId).rpc.dialogs.values()][0]
    assert.ok(dialog)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(runtime.worker(sessionId).rpc.busy, true)
    await runtime.call('dialog_response', { sessionId, id: dialog.id, confirmed: false })
    await until(events => events.some(event => event.type === 'agent_settled'))
    assert.equal(fs.existsSync(path.join(workspace, 'pi-receipt.txt')), false)
    await runtime.call('prompt', { sessionId, message: 'fixture-write allow' })
    await until(events => events.some(event => event.type === 'extension_ui_request' && event.method === 'confirm'))
    const allow = [...runtime.worker(sessionId).rpc.dialogs.values()][0]
    await runtime.call('dialog_response', { sessionId, id: allow.id, confirmed: true })
    await until(events => events.some(event => event.type === 'agent_settled'))
    assert.equal(fs.readFileSync(path.join(workspace, 'pi-receipt.txt'), 'utf8'), 'approved-fixture')
    await runtime.call('prompt', { sessionId, message: 'fixture-abort' })
    await until(events => events.some(event => event.type === 'message_update'))
    await runtime.call('abort', { sessionId })
    assert.equal(runtime.worker(sessionId).rpc.busy, false)
    const before = await runtime.state(sessionId)
    await runtime.close(sessionId)
    const otherWorkspace = runtime.file('workspace', 'other-' + Date.now())
    fs.mkdirSync(otherWorkspace)
    await runtime.configure({ workspace: otherWorkspace, allowTools: false })
    const other = await runtime.open()
    assert.equal(runtime.worker(other.sessionId).rpc.options.cwd, fs.realpathSync(otherWorkspace))
    assert.equal(runtime.worker(other.sessionId).rpc.options.env.CLAWPANEL_PI_ALLOW_TOOLS, '0')
    const restored = await runtime.open({ sessionId })
    assert.equal(runtime.worker(sessionId).rpc.options.cwd, fs.realpathSync(workspace))
    assert.equal(runtime.worker(sessionId).rpc.options.env.CLAWPANEL_PI_ALLOW_TOOLS, '1')
    assert.equal(restored.messages.length, before.messages.length)
    assert.equal(restored.state.model.id, 'fixture-second')
    assert.equal(runtime.sessions().find(entry => entry.id === sessionId).name, 'fixture-hello')
    assert.ok(serverRequests.length >= 5)
    console.log(JSON.stringify({ piVersion: runtime.status().version, requests: serverRequests.length, dialogs: 'deny+allow', historyMessages: restored.messages.length, cancel: true, contextWindow: 65536, projectIsolation: true, stableTitle: true }))
  } finally {
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
