#!/usr/bin/env node
// 原生backend专用子进程；stdin接本机连接，独立成员profile，退出时只关自己的runtime。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import readline from 'node:readline'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { syncDshProvider, dshRpc } from './deepseek-harness.js'
import { buildOpenCodeProvider } from './opencode.js'
import { validateOfficialConnection, privateWrite, openCodeOfficialPluginSource, dshOfficialPluginSource } from './opencode-official-transport.mjs'
import { startOfficialOpenCodeProxy } from './opencode-official-proxy.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let runtime, uiProxy, newSession, stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  if (uiProxy) await uiProxy.close()
  if (runtime && runtime.exitCode === null) {
    // child句柄来自本进程刚启动的实例，绝不枚举或停止其他安装。
    runtime.kill()
    await Promise.race([new Promise(r => runtime.once('exit', r)), delay(5000)])
  }
}
process.on('SIGTERM', () => stop().finally(() => process.exit(0)))
process.on('SIGINT', () => stop().finally(() => process.exit(0)))

async function run(input) {
  const engine = input.engine
  if (!['deepseek-harness', 'opencode'].includes(engine)) throw Error('official_engine_invalid')
  const connection = validateOfficialConnection(input.connection, engine)
  const root = path.resolve(input.root || '')
  if (!path.isAbsolute(input.root || '') || !path.isAbsolute(input.entry || '') || !fs.statSync(input.entry).isFile()) throw Error('official_runtime_unavailable')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('official_port_invalid')
  const ownerPath = path.join(root, 'official-owner.json')
  const owner = { engine, memberId: connection.memberId }
  if (fs.existsSync(root)) {
    if (!fs.existsSync(ownerPath) || JSON.stringify(JSON.parse(fs.readFileSync(ownerPath, 'utf8'))) !== JSON.stringify(owner)) throw Error('official_profile_not_owned')
  } else fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  privateWrite(ownerPath, owner)
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('official_port_in_use'))); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const name of ['opencode-official-transport.mjs']) if (path.join(root, name) !== path.join(here, name)) privateWrite(path.join(root, name), fs.readFileSync(path.join(here, name), 'utf8'))
  privateWrite(path.join(root, 'package.json'), { type: 'module' })
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace')
  for (const dir of [home, workspace]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', NO_PROXY: '*', no_proxy: '*' }
  for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key) || key.startsWith('GIT_')) delete env[key]
  // 官方空工作区必须有自身边界，不能向上发现面板或其他用户仓库。
  // 只在已核验owner的目录初始化；空模板与配置屏蔽全局hook，不提交、不改外部仓库。
  const gitTemplate = path.join(root, 'git-empty-template'), gitConfig = path.join(root, 'git-empty-config')
  fs.mkdirSync(gitTemplate, { recursive: true, mode: 0o700 });privateWrite(gitConfig, '')
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig }
  const git = args => new Promise((resolve, reject) => {
    // Windows受管目录含成员hash，可能超过Git默认路径界限；只影响本次own命令。
    const child = spawn('git', ['-c', 'core.longpaths=true', ...args], { cwd: workspace, env: gitEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = '', finished = false
    const timer = setTimeout(() => { if (!finished) { child.kill();reject(Error('official_workspace_unavailable')) } }, 10000)
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-8192) })
    child.once('error', () => { finished = true;clearTimeout(timer);reject(Error('official_workspace_unavailable')) })
    child.once('exit', code => { finished = true;clearTimeout(timer);code === 0 ? resolve(stdout.trim()) : reject(Error('official_workspace_unavailable')) })
  })
  if (!fs.existsSync(path.join(workspace, '.git'))) await git(['-c', 'init.defaultBranch=main', 'init', '--quiet', '--template=' + gitTemplate, workspace])
  if (path.resolve(await git(['rev-parse', '--show-toplevel'])) !== workspace) throw Error('official_workspace_unavailable')
  // 已核确切Git根归属后才保存本repo长路径支持；不写用户global/system配置。
  await git(['config', 'core.longpaths', 'true'])
  // 两个 agent 本地使用事件流；官网普通回复由原生网关按实际目录能力转换，不裁请求工具。
  const selectedModel = connection.models.find(model => model.id === (connection.modelId || connection.models.find(model => model.capabilities?.tool_calls === true)?.id))
  if (!selectedModel || typeof selectedModel.capabilities?.streaming !== 'boolean') throw Error('official_models_incompatible')
  const textOnly = selectedModel.capabilities?.tool_calls !== true
  if (connection.modelId && (connection.textOnly !== textOnly || connection.toolsAvailable !== !textOnly)) throw Error('official_connection_invalid')
  // 每次连接固定实际能力模式，不将工具历史搬给纯文本模型。
  const models = connection.models.filter(model => typeof model.capabilities?.streaming === 'boolean' && (model.capabilities?.tool_calls !== true) === textOnly)
    .map(model => ({ id: model.id, name: model.display_name || model.id, contextTokens: model.context_tokens || model.context_window, maxTokens: model.max_output_tokens, input: ['text'] }))
  if (!models.length) throw Error('official_models_incompatible')
  const alias = new URL(connection.baseUrl)
  alias.pathname = '/v1'
  // 配置仅保留无cap路由别名，真实能力只经stdin交给插件并在内存改写。
  const channel = { id: 'official', name: 'ClawPanel Official', apiType: 'openai-completions', baseUrl: alias.href.replace(/\/$/, ''), models }
  let exe = input.entry, args, cookie = '', token = '', output = '', runtimePort = port, serverPassword = ''
  do { runtimePort = await new Promise((resolve, reject) => { const s = net.createServer();s.once('error', reject);s.listen(0, '127.0.0.1', () => { const p = s.address().port;s.close(() => resolve(p)) }) }) } while (runtimePort === port)
  if (engine === 'opencode') {
    // 覆盖继承环境，仅此owned实例使用新随机Basic；不落配置、不返回前端。
    serverPassword = crypto.randomBytes(32).toString('base64url')
    env.OPENCODE_SERVER_USERNAME = 'opencode';env.OPENCODE_SERVER_PASSWORD = serverPassword
    privateWrite(path.join(root, 'official-plugin.mjs'), openCodeOfficialPluginSource())
    privateWrite(path.join(root, 'local.key'), 'clawpanel-local')
    const config = { autoupdate: false, enabled_providers: ['clawpanel-official'], model: `clawpanel-official/${selectedModel.id}`, small_model: `clawpanel-official/${selectedModel.id}`, provider: { 'clawpanel-official': buildOpenCodeProvider(channel, path.join(root, 'local.key'), 'clawpanel-official') }, plugin: [pathToFileURL(path.join(root, 'official-plugin.mjs')).href], agent: { title: { disable: true }, summary: { disable: true } } }
    if (textOnly) {
      // 正式Agent配置从源头关闭工具，不在HTTP边界删除定义。
      config.default_agent = 'clawpanel-text'
      config.agent['clawpanel-text'] = { description: 'Official text-only conversation', mode: 'primary', prompt: 'You are a helpful assistant. Answer the user directly. Tools are unavailable in this text-only conversation.', tools: { '*': false }, permission: { '*': 'deny' } }
      config.permission = { '*': 'deny' }
    }
    privateWrite(path.join(root, 'opencode.json'), config)
    env.OPENCODE_CONFIG = path.join(root, 'opencode.json'); env.OPENCODE_CONFIG_DIR = root
    args = ['serve', '--hostname', '127.0.0.1', '--port', String(runtimePort)]
  } else {
    const modules = path.resolve(path.dirname(input.entry), '../../..')
    let llmEntry = path.join(modules, '@deepseek-ai/dsh-llm/lib/index.js')
    if (!fs.existsSync(llmEntry)) {
      const store = path.join(modules, '.pnpm')
      const candidates = fs.readdirSync(store).filter(name => name.startsWith('@deepseek-ai+dsh-llm@0.2.0-rc.2'))
      if (candidates.length !== 1) throw Error('official_runtime_version_unsupported')
      llmEntry = path.join(store, candidates[0], 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')
    }
    const llm = pathToFileURL(llmEntry).href
    privateWrite(path.join(root, 'official-plugin.mjs'), dshOfficialPluginSource(llm))
    // 正式Host配置覆盖系统KnownFolder；UI前另注册确切own工作区，不改原BYOK配置。
    const textPreset = textOnly ? `- id: agent-preset-registry\n  config:\n    default: clawpanel-text\n- insert:\n    - id: preset-clawpanel-text\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: clawpanel-text\n        name: Official text-only\n        plugins: []\n` : ''
    privateWrite(path.join(root, 'official.yml'), `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(path.join(root, 'documents'))}\n    documentsLookupTimeoutMs: 10000\n${textPreset}- insert:\n    - id: clawpanel-official-operation\n      name: ${JSON.stringify(pathToFileURL(path.join(root, 'official-plugin.mjs')).href)}\n`)
    exe = process.execPath; args = [input.entry, '--profile', 'web', '--patch', path.join(root, 'official.yml'), '--host', '127.0.0.1', '--port', String(runtimePort), '--no-open']
  }
  runtime = spawn(exe, args, { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  runtime.stdin.on('error', () => {})
  runtime.stdin.end(JSON.stringify(connection))
  const log = fs.createWriteStream(path.join(root, 'runtime.log'), { flags: 'a', mode: 0o600 })
  let pendingLog = ''
  const redact = text => text.replaceAll(connection.baseUrl, '[OFFICIAL_GATEWAY]').replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[REDACTED]')
  const capture = data => {
    output = (output + String(data)).slice(-16000)
    token ||= output.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] || ''
    pendingLog += String(data)
    let end
    while ((end = pendingLog.indexOf('\n')) >= 0) { log.write(redact(pendingLog.slice(0, end + 1))); pendingLog = pendingLog.slice(end + 1) }
    if (pendingLog.length > 16384) pendingLog = '[OVERSIZED_RUNTIME_LOG_LINE]\n'
  }
  runtime.stdout.on('data', capture); runtime.stderr.on('data', capture)
  runtime.once('exit', () => { if (pendingLog) log.write(redact(pendingLog)); log.end() })
  runtime.on('error', () => {})
  const until = async fn => { const end = Date.now() + 60000; while (Date.now() < end && runtime.exitCode === null) { const r = await Promise.resolve().then(fn).catch(() => null); if (r) return r; await delay(200) } throw Error('official_runtime_not_ready') }
  let src = `http://127.0.0.1:${runtimePort}/`
  if (engine === 'opencode') {
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + serverPassword).toString('base64') }
    await until(async () => (await (await fetch(src + 'global/health', { headers, signal: AbortSignal.timeout(1000) })).json()).healthy)
    uiProxy = await startOfficialOpenCodeProxy({ port, innerPort: runtimePort, password: serverPassword })
    src = uiProxy.src
    newSession = async modelId => {
      if (modelId !== selectedModel.id) throw Error('official_model_not_allowed')
      // 控制请求独占连接且仅发一次，不复用primary已关闭的health keep-alive连接。
      const session = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ title: 'Official conversation' })
        const request = http.request({ hostname: '127.0.0.1', port: runtimePort, path: '/session?directory=' + encodeURIComponent(workspace), method: 'POST', agent: false, headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
          let size = 0, value = ''
          response.on('data', chunk => { size += chunk.length; if (size > 65536) response.destroy(); else value += chunk })
          response.on('error', () => reject(Error('official_session_unavailable')))
          response.on('end', () => { try { if (response.statusCode !== 200) throw Error(); resolve(JSON.parse(value)) } catch { reject(Error('official_session_unavailable')) } })
        })
        request.setTimeout(60000, () => request.destroy());request.on('error', () => reject(Error('official_session_unavailable')));request.end(body)
      })
      if (typeof session.id !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(session.id) || path.resolve(session.directory) !== workspace) throw Error('official_session_unavailable')
      return { ready: true, sessionId: session.id, src: uiProxy.entry({ path: '/' + Buffer.from(workspace).toString('base64url') + '/session/' + session.id }) }
    }
  }
  else {
    await until(() => token)
    const auth = await fetch(src + '?token=' + token, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    cookie = auth.headers.get('set-cookie')?.split(';')[0] || ''
    if (auth.status !== 303 || !cookie) throw Error('official_runtime_auth_failed')
    const rpc = (method, payload) => dshRpc(method, payload, { port: runtimePort, modern: true, headers: { cookie } })
    await until(async () => (await rpc('settings.describe', {})).writable)
    // primary UI以最近的注册工作区作为新会话默认；显式正式注册避免首启回退到Documents。
    // 旧登记与旧会话均保留，不迁移其cwd，也不对原Documents做任何读写。
    const registered = await rpc('workspace.create', { request: { path: workspace } })
    if (typeof registered.workspace?.path !== 'string' || path.resolve(registered.workspace.path) !== fs.realpathSync(workspace)) throw Error('official_workspace_unavailable')
    await syncDshProvider({ channel, apiKey: 'clawpanel-local', setDefault: true, port, rpc: (method, payload) => rpc(method, payload) })
    // 使用SDK正式兼容项关闭不属于官网Chat契约的store字段，不在HTTP边界裁正文。
    const described = await rpc('settings.describe', {})
    const llm = described.namespaces?.find(item => item.ns === 'llm-pi-ai')
    const profile = llm?.value?.providers?.['clawpanel-official']
    if (!profile) throw Error('official_provider_unavailable')
    await rpc('settings.mutate', { ns: 'llm-pi-ai', expectedRevision: llm.revision, ops: [{ op: 'set', path: ['providers', 'clawpanel-official'], value: { ...profile, compat: { ...profile.compat, supportsStore: false } } }] })
    const verified = await rpc('settings.describe', {})
    if (verified.namespaces?.find(item => item.ns === 'llm-pi-ai')?.value?.providers?.['clawpanel-official']?.compat?.supportsStore !== false) throw Error('official_provider_unavailable')
    uiProxy = await startOfficialOpenCodeProxy({ port, innerPort: runtimePort, cookie, engine })
    src = uiProxy.src
    newSession = async modelId => {
      if (modelId !== selectedModel.id) throw Error('official_model_not_allowed')
      const session = await rpc('session.create', { request: { workspaceId: registered.workspace.workspaceId, ...(textOnly ? { agentPreset: 'clawpanel-text' } : {}) } })
      if (typeof session.sessionId !== 'string' || !/^session-[A-Za-z0-9-]+$/.test(session.sessionId)) throw Error('official_session_unavailable')
      await rpc('session.selectModel', { request: { sessionId: session.sessionId, provider: 'clawpanel-official', model: modelId } })
      return { ready: true, sessionId: session.sessionId, src: uiProxy.entry({ selection: { sessionId: session.sessionId } }) }
    }
  }
  // 仅本机runtime认证地址可供原有iframe使用；网关cap/API Key不会返回。
  return { ready: true, engine, providerId: 'clawpanel-official', memberId: connection.memberId, epoch: connection.epoch, modelId: selectedModel.id, textOnly, toolsAvailable: !textOnly, port, innerPort: runtimePort, pid: runtime.pid, src, uiSessionToken: uiProxy.sessionToken }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let started = false
lines.on('line', async line => {
  try {
    const input = JSON.parse(line)
    if (input.action === 'stop') { await stop(); lines.close(); process.exit(0) }
    if (input.action === 'ui_session') { if (!uiProxy || stopping) throw Error('official_runtime_unavailable');process.stdout.write(JSON.stringify({ ready: true, src: uiProxy.entry() }) + '\n');return }
    if (input.action === 'new_session') { if (!newSession || stopping) throw Error('official_runtime_unavailable');process.stdout.write(JSON.stringify(await newSession(input.modelId)) + '\n');return }
    if (started) throw Error('official_runtime_already_started')
    started = true
    const result = await run(input)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) { process.stdout.write(JSON.stringify({ ready: false, error: /^official_[a-z_]+$/.test(error.message) ? error.message : 'official_runtime_failed' }) + '\n'); await stop(); process.exit(1) }
})
lines.on('close', () => stop().finally(() => process.exit(0)))
