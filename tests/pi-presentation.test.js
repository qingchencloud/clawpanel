import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationEntries, messageText, thinkingText, modelOptions, toolPresentation } from '../src/engines/pi/lib/presentation.js'

test('Pi 模型显示友好名称，RPC value 保留原始 provider/id', () => {
  const models = [{ name: '本地模型', id: 'model-a', provider: 'clawpanel-hash-a' }, { id: 'model-b', provider: 'clawpanel-hash-b' }]
  const options = modelOptions(models)
  assert.deepEqual(options.map(model => model.label), ['本地模型', 'model-b'])
  assert.deepEqual(JSON.parse(options[0].value), ['clawpanel-hash-a', 'model-a'])
  assert.doesNotMatch(options.map(model => model.label).join(' '), /clawpanel-/)
  assert.deepEqual(models[0], { name: '本地模型', id: 'model-a', provider: 'clawpanel-hash-a' })
})

test('重复模型名以模型 ID、渠道地址或序号区分，不显示凭据和内部哈希', () => {
  const options = modelOptions([
    { name: 'Model', id: 'a', provider: 'clawpanel-1' },
    { name: 'Model', id: 'b', provider: 'clawpanel-2' },
    { name: 'Same', id: 'c', provider: 'clawpanel-3' },
    { name: 'Same', id: 'c', provider: 'clawpanel-4' },
    { name: 'Same', id: 'c', provider: 'clawpanel-5' },
  ], [
    { id: 'clawpanel-3', baseUrl: 'https://user:secret@models.example/v1?token=hidden' },
    { id: 'clawpanel-4', baseUrl: 'https://models.example/v1' },
  ])
  assert.deepEqual(options.map(model => model.label), ['Model · a', 'Model · b', 'Same · models.example (1)', 'Same · models.example (2)', 'Same'])
  assert.doesNotMatch(options.map(model => model.label).join(' '), /clawpanel-|secret|hidden|user/)
})

test('工具历史与实时事件在调用原位置合并，完整参数和输出保留在折叠详情中', () => {
  const result = { role: 'toolResult', toolCallId: 'call-1', toolName: 'write', content: [{ type: 'text', text: 'Written' }], isError: false }
  const messages = [
    { role: 'user', content: '写入文件' },
    { role: 'assistant', content: [{ type: 'text', text: '开始写入' }, { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'D:\\project\\note.md', content: '正文' } }] },
    result,
    { role: 'assistant', content: [{ type: 'text', text: '已处理完成' }] },
  ]
  const entries = conversationEntries(messages, { 'call-1': { type: 'tool_execution_end', toolName: 'write', result } })
  assert.deepEqual(entries.map(entry => entry.kind), ['message', 'message', 'tool', 'message'])
  assert.equal(entries[2].labelKey, 'writeFile')
  assert.equal(entries[2].target, 'note.md')
  assert.equal(entries[2].status, 'completed')
  assert.equal(entries[2].args.content, '正文')
  assert.equal(entries[2].output, result)
})

test('工具拒绝与真正失败分别显示，运行中的工具不会误标完成', () => {
  assert.equal(toolPresentation({}, { type: 'tool_execution_start', toolName: 'read', args: { path: '/project/main.js' } }).status, 'running')
  assert.equal(toolPresentation({}, {}, { toolName: 'write', isError: true, content: [{ type: 'text', text: 'ClawPanel: user cancelled tool execution' }] }).status, 'cancelled')
  assert.equal(toolPresentation({}, { type: 'tool_execution_end', isError: true, result: { content: 'disk full' } }).status, 'failed')
  assert.equal(toolPresentation({ name: 'powershell' }).labelKey, 'runCommand')
})

test('停止生成保留已经输出的内容，不丢弃真实错误字段', () => {
  const aborted = { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: '部分输出' }], errorMessage: 'Request was aborted' }
  const error = { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'Invalid model' }
  const entries = conversationEntries([aborted, error])
  assert.equal(entries[0].aborted, true)
  assert.equal(entries[0].text, '部分输出')
  assert.equal(entries[0].message.errorMessage, 'Request was aborted')
  assert.equal(entries[1].aborted, false)
  assert.equal(entries[1].message.errorMessage, 'Invalid model')
})

test('历史工具、仅实时工具和思考内容均能展示，系统提示不进入对话区', () => {
  const entries = conversationEntries([
    { role: 'system', content: 'private system prompt' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '先查看文件' }] },
    { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: 'old output' },
  ], { fresh: { type: 'tool_execution_update', toolName: 'grep', partialResult: { content: 'matching' } } })
  assert.equal(entries.length, 3)
  assert.equal(entries[0].thinking, '先查看文件')
  assert.equal(entries[1].status, 'completed')
  assert.equal(entries[2].status, 'running')
  assert.doesNotMatch(JSON.stringify(entries), /private system prompt/)
  assert.equal(messageText({ content: [null, { type: 'text', text: '完整\u2028文本' }] }), '完整\u2028文本')
  assert.equal(thinkingText({ content: '普通文字' }), '')
})
