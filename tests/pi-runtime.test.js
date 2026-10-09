import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import crypto from 'node:crypto'
import { PiRuntime } from '../scripts/pi-runtime.js'
import { PI_PACKAGE_NAME } from '../scripts/pi-models.js'

const channel = { id: 'fixture', apiType: 'openai-completions', baseUrl: 'http://localhost:1234/v1', apiKey: '!not-a-command-fixture', models: [{ id: 'model', contextWindow: 131072 }], defaultModel: 'model' }
async function withRuntime(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-pi-test-'))
  const runtime = new PiRuntime({ root, readChannel: () => channel, ...options })
  try { await run(runtime) } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
}
const installFixture = (runtime, directory, version) => {
  const entry = runtime.cli(directory)
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '')
  fs.writeFileSync(path.resolve(path.dirname(entry), '..', '..', 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version }))
}

test('Pi status 无进程启动；同步私有密钥、回读验证与卸载保留数据', async () => withRuntime(async runtime => {
  let spawned = 0
  runtime.spawn = () => { spawned++; throw new Error('should not spawn') }
  assert.equal(runtime.status().installed, false); assert.equal(spawned, 0)
  const synced = await runtime.syncProvider({ channelId: channel.id, setDefault: true })
  assert.equal(synced.verified, true)
  const models = fs.readFileSync(runtime.agentFile('models.json'), 'utf8')
  assert.ok(!models.includes(channel.apiKey))
  assert.equal(JSON.parse(fs.readFileSync(runtime.agentFile('credentials.json'), 'utf8'))[synced.providerId], channel.apiKey)
  assert.ok(!JSON.stringify(runtime.status()).includes(channel.apiKey))
  assert.equal(runtime.redact('key: ' + channel.apiKey), 'key: [REDACTED]')
  installFixture(runtime, 'runtime', '1.1.0')
  assert.equal(runtime.status().installed, true)
  const uninstalled = await runtime.uninstall()
  assert.equal(uninstalled.installed, false); assert.equal(uninstalled.dataPreserved, true)
  assert.ok(fs.existsSync(runtime.agentFile('credentials.json')))
}))

test('Pi 同步失败回滚全部配置，执行中任务阻止管理操作', async () => withRuntime(async runtime => {
  runtime.ensure()
  runtime.write(runtime.agentFile('models.json'), { extra: true })
  const write = runtime.write.bind(runtime)
  let failed = false
  runtime.write = (file, value, json = true) => {
    if (!failed && json && file === runtime.agentFile('models.json')) { failed = true; throw new Error('fixture write failure') }
    write(file, value, json)
  }
  await assert.rejects(runtime.syncProvider({ channelId: channel.id }), /fixture write failure/)
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.agentFile('models.json'), 'utf8')), { extra: true })
  assert.equal(fs.existsSync(runtime.agentFile('credentials.json')), false)
  runtime.workers.set('fixture', { rpc: { busy: true, stop: async () => {} }, waiting: new Set() })
  await assert.rejects(runtime.syncProvider({ channelId: channel.id }), /停止 Pi/)
  await assert.rejects(runtime.uninstall(), /执行中的任务/)
  runtime.workers.clear()
}))

test('Pi 切换运行时后核验失败恢复旧版本，不删除配置或工作区', async () => withRuntime(async runtime => {
  runtime.ensure(); installFixture(runtime, 'runtime', '1.0.0')
  runtime.write(runtime.file('config.json'), { workspace: runtime.file('workspace'), allowTools: false })
  runtime.spawn = (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', 1)
    queueMicrotask(() => {
      if (args.includes('install')) installFixture(runtime, 'runtime.update-staging', '1.1.0')
      else child.stdout.write(args[0] === runtime.cli('runtime.update-staging') ? '1.1.0\n' : '0.0.0\n')
      child.emit('close', 0)
    })
    return child
  }
  await assert.rejects(runtime.install('1.1.0'), /已回滚原运行时/)
  assert.equal(runtime.status().version, '1.0.0')
  assert.ok(fs.existsSync(runtime.file('config.json')))
  assert.ok(fs.existsSync(runtime.file('workspace')))
}))

test('Pi 删除路径和版本参数受限，不能删除根目录或数据目录', async () => withRuntime(async runtime => {
  for (const target of ['..', 'agent', 'workspace', '../runtime', 'runtime/../../']) assert.throws(() => runtime.removeRuntime(target))
  await assert.rejects(runtime.install('latest'), /SemVer/)
  runtime.ensure()
  await assert.rejects(runtime.configure({ workspace: runtime.file('agent'), allowTools: true }), /私有配置目录/)
  await assert.rejects(runtime.call('unknown'), /命令不存在/)
}))

test('Pi 已退出进程保留最后诊断，不占用活动会话，事件游标溢出提示恢复', async () => withRuntime(async runtime => {
  runtime.ensure()
  const id = '00000000-0000-4000-8000-000000000001'
  runtime.saveEntry({ id, name: 'fixture', workspace: runtime.config().workspace })
  runtime.workers.set(id, { rpc: { closed: true, busy: false, dialogs: new Map(), stop: async () => {} }, waiting: new Set(), events: [{ sequence: 5, event: { type: 'process_exit', error: 'fixture crash diagnostic' } }], sequence: 5 })
  assert.equal(runtime.status().activeSessions, 0)
  assert.equal(runtime.sessions()[0].running, false)
  const result = await runtime.events(id, 4)
  assert.equal(result.closed, true)
  assert.equal(result.events[0].event.error, 'fixture crash diagnostic')
  assert.equal((await runtime.events(id, 0)).reset, true)
  await assert.rejects(runtime.events(id, -1), /游标无效/)
  assert.throws(() => runtime.worker(id), /重新打开/)
}))

test('Pi 损坏的凭据 JSON 只报告文件名，不泄露解析器的原始内容片段', async () => withRuntime(async runtime => {
  runtime.ensure()
  runtime.write(runtime.agentFile('credentials.json'), 'private-fixture-secret-invalid-json', false)
  await assert.rejects(runtime.syncProvider({ channelId: channel.id }), error => error.message === 'Pi JSON 配置格式错误: credentials.json')
}))

const fakeRpc = options => ({
  closed: false, busy: false, dialogs: new Map(),
  start: async () => ({ model: { provider: 'clawpanel-fixture', id: 'model' } }),
  request: async ({ type }) => type === 'get_state' ? { model: { provider: 'clawpanel-fixture', id: 'model' } } : type === 'get_available_models' ? { models: [{ provider: 'clawpanel-fixture', id: 'model' }] } : { messages: [] },
  prompt: async () => ({ disposition: 'started' }),
  async stop() { this.closed = true },
  options,
})

test('Pi 历史会话按原 cwd 和权限恢复，默认目录切换不关闭其他会话', async () => withRuntime(async runtime => {
  runtime.ensure(); installFixture(runtime, 'runtime', '1.1.0'); runtime.rpcFactory = fakeRpc
  const directoryA = runtime.file('workspace', 'A'), directoryB = runtime.file('workspace', 'B')
  fs.mkdirSync(directoryA); fs.mkdirSync(directoryB)
  await runtime.configure({ workspace: directoryA, allowTools: false })
  const first = await runtime.open()
  await runtime.configure({ workspace: directoryB, allowTools: true })
  assert.equal(runtime.worker(first.sessionId).rpc.closed, false)
  const second = await runtime.open()
  assert.equal(runtime.worker(second.sessionId).rpc.options.cwd, fs.realpathSync(directoryB))
  assert.equal(runtime.worker(second.sessionId).rpc.options.env.CLAWPANEL_PI_ALLOW_TOOLS, '1')
  await runtime.close(first.sessionId); await runtime.open({ sessionId: first.sessionId })
  const restored = runtime.worker(first.sessionId).rpc.options
  assert.equal(restored.cwd, fs.realpathSync(directoryA))
  assert.equal(restored.env.CLAWPANEL_PI_ALLOW_TOOLS, '0')
  assert.ok(!restored.args.at(-1).includes('write'))
}))

test('Pi 第一条消息生成标题，追问不覆盖；索引超过 500 条仍保留', async () => withRuntime(async runtime => {
  runtime.ensure(); installFixture(runtime, 'runtime', '1.1.0'); runtime.rpcFactory = fakeRpc
  const first = await runtime.open()
  await runtime.call('prompt', { sessionId: first.sessionId, message: '首次问题' })
  await runtime.call('prompt', { sessionId: first.sessionId, message: '第二次追问' })
  assert.equal(runtime.manifest().find(entry => entry.id === first.sessionId).name, '首次问题')
  for (let index = 0; index < 501; index++) runtime.saveEntry({ id: crypto.randomUUID(), name: 'fixture', workspace: runtime.config().workspace })
  assert.equal(runtime.manifest().length, 502)
  assert.ok(runtime.sessions().some(entry => entry.id === first.sessionId))
}))

test('Pi 恢复旧版遗漏的 JSONL 入口，旧权限只读，不读取非法文件或猜测目录', async () => withRuntime(async runtime => {
  runtime.ensure(); installFixture(runtime, 'runtime', '1.1.0'); runtime.rpcFactory = fakeRpc
  const id = crypto.randomUUID(), invalid = crypto.randomUUID()
  fs.writeFileSync(runtime.file('sessions', id + '.jsonl'), JSON.stringify({ type: 'session', cwd: runtime.config().workspace }) + '\n')
  fs.writeFileSync(runtime.file('sessions', invalid + '.jsonl'), 'broken or missing directory')
  fs.writeFileSync(runtime.file('sessions', 'not-a-session.jsonl'), JSON.stringify({ type: 'session', cwd: runtime.config().workspace }))
  assert.deepEqual(runtime.sessions().map(entry => entry.id), [id])
  await runtime.open({ sessionId: id })
  assert.equal(runtime.worker(id).rpc.options.env.CLAWPANEL_PI_ALLOW_TOOLS, '0')
  assert.equal(runtime.sessions().length, 1)
}))

test('Pi 历史目录消失或移入私有目录时明确拒绝恢复', async () => withRuntime(async runtime => {
  runtime.ensure(); installFixture(runtime, 'runtime', '1.1.0'); runtime.rpcFactory = fakeRpc
  for (const workspace of [runtime.file('missing'), runtime.file('agent')]) {
    const id = crypto.randomUUID(); runtime.saveEntry({ id, workspace })
    await assert.rejects(runtime.open({ sessionId: id }), /工作目录/)
  }
  await assert.rejects(runtime.install('2.0.0'), /兼容测试/)
}))
