/** Pi 受管运行时：Web 与桌面桥共用，不依赖 OpenClaw Gateway。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn as spawnRuntime } from 'node:child_process'
import { PiRpcProcess } from './pi-rpc.js'
import { PI_PACKAGE_NAME, PI_PACKAGE_VERSION, piVersion, piNodeSupported, piCredentialEnv, mergePiConfig } from './pi-models.js'
import { PI_PERMISSION_SOURCE } from './pi-permission.js'

const jsonRead = (file, fallback = {}) => {
  if (!fs.existsSync(file)) return fallback
  const source = fs.readFileSync(file, 'utf8')
  try { return JSON.parse(source) } catch { throw new Error('Pi JSON 配置格式错误: ' + path.basename(file)) }
}
const safeId = value => {
  if (!/^[a-f0-9-]{36}$/.test(String(value || ''))) throw new Error('Pi 会话 ID 无效')
  return value
}

export class PiRuntime {
  constructor({ root, readChannel, registry = () => 'https://registry.npmjs.org', spawn = spawnRuntime, rpcFactory = options => new PiRpcProcess(options) }) {
    this.root = path.resolve(root)
    this.readChannel = readChannel
    this.registry = registry
    this.spawn = spawn
    this.rpcFactory = rpcFactory
    this.workers = new Map()
    this.opening = new Map()
    this.mutating = false
    this.secrets = []
    this.children = new Set()
    this.disposed = false
    this.reaper = setInterval(() => {
      for (const [id, worker] of this.workers) if (!worker.rpc.busy && Date.now() - worker.accessed > 30 * 60 * 1000) this.close(id).catch(() => {})
    }, 60000)
    this.reaper.unref?.()
  }

  file(...names) { return path.join(this.root, ...names) }
  cli(runtime = 'runtime') { return this.file(runtime, 'node_modules', ...PI_PACKAGE_NAME.split('/'), 'dist', 'bundle', 'cli.js') }
  agentFile(name) { return this.file('agent', name) }
  manifest() { return jsonRead(this.file('sessions.json'), []) }
  config() { return { workspace: this.file('workspace'), allowTools: false, ...jsonRead(this.file('config.json')) } }

  resolveWorkspace(workspace) {
    const directory = path.resolve(String(workspace))
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Pi 工作目录不存在或不是目录')
    const resolved = fs.realpathSync(directory), privateRoot = fs.realpathSync(this.file('agent'))
    if (resolved === fs.realpathSync(this.root) || resolved === privateRoot || resolved.startsWith(privateRoot + path.sep)) throw new Error('Pi 工作目录不接受私有配置目录或受管根目录')
    return resolved
  }

  recoverSessions() {
    // 兼容旧索引的 500 条截断：只读取受管 UUID 文件的有界首行，不猜测项目目录。
    const entries = this.manifest(), known = new Set(entries.map(entry => entry.id))
    if (!fs.existsSync(this.file('sessions'))) return entries
    let recovered = false
    for (const name of fs.readdirSync(this.file('sessions'))) {
      if (!/^[a-f0-9-]{36}\.jsonl$/.test(name) || known.has(name.slice(0, -6))) continue
      const file = this.file('sessions', name), info = fs.lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(8192)
      let header
      try { const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0); header = JSON.parse(buffer.subarray(0, length).toString('utf8').split('\n')[0]) }
      catch { continue } finally { fs.closeSync(descriptor) }
      if (header?.type !== 'session' || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) continue
      const id = name.slice(0, -6)
      // 旧记录没有权限快照时降级为只读，不继承当前命令授权。
      entries.push({ id, name: 'New session', workspace: header.cwd, allowTools: false, updatedAt: info.mtime.toISOString() })
      known.add(id); recovered = true
    }
    if (recovered) this.write(this.file('sessions.json'), entries)
    return entries
  }

  ensure() {
    for (const dir of [this.root, this.file('agent'), this.file('sessions'), this.file('workspace')]) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('Pi 受管目录不接受符号链接')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    this.write(this.file('permission.mjs'), PI_PERMISSION_SOURCE, false)
  }

  write(file, value, asJson = true) {
    const relative = path.relative(this.root, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pi 写入目标超出受管目录')
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Pi 配置文件不接受符号链接')
    const temp = file + '.' + crypto.randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temp, asJson ? JSON.stringify(value, null, 2) + '\n' : value, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
      fs.chmodSync(file, 0o600)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }

  redact(value) {
    let text = String(value ?? '')
    for (const key of this.secrets) if (key.length >= 4) text = text.split(key).join('[REDACTED]')
    return text.replace(/\b(?:sk|ghp|gho)-[\w-]{8,}/g, '[REDACTED]')
  }

  log(value) {
    this.ensure()
    const file = this.file('runtime.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) this.write(file, '', false)
    fs.appendFileSync(file, this.redact(value) + '\n', { mode: 0o600 })
  }

  async exclusive(operation) {
    if (this.mutating || this.opening.size) throw new Error('Pi 正在执行管理操作，请稍后重试')
    this.mutating = true
    try { return await operation() } finally { this.mutating = false }
  }

  status() {
    const pkg = jsonRead(this.file('runtime', 'node_modules', ...PI_PACKAGE_NAME.split('/'), 'package.json'))
    const models = jsonRead(this.agentFile('models.json'))
    const settings = jsonRead(this.agentFile('settings.json'))
    return {
      installed: pkg.name === PI_PACKAGE_NAME && fs.existsSync(this.cli()), version: pkg.version || '',
      recommendedVersion: PI_PACKAGE_VERSION, nodeVersion: process.versions.node, nodeSupported: piNodeSupported(),
      running: [...this.workers.values()].some(worker => !worker.rpc.closed), activeSessions: [...this.workers.values()].filter(worker => !worker.rpc.closed).length, managing: this.mutating,
      providers: Object.entries(models.providers || {}).map(([id, provider]) => ({ id, api: provider.api, baseUrl: provider.baseUrl, models: (provider.models || []).map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })) })),
      defaultProvider: settings.defaultProvider || '', defaultModel: settings.defaultModel || '',
      config: this.config(), root: this.root, logPath: this.file('runtime.log'),
    }
  }

  npmCommand() {
    const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)]
    for (const dir of dirs) {
      const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (fs.existsSync(cli)) return { command: process.execPath, prefix: [cli] }
    }
    if (process.platform !== 'win32') return { command: 'npm', prefix: [] }
    throw new Error('找不到 npm-cli.js，请在 Node.js 设置中选择完整 Node 安装目录')
  }

  run(command, args, env, timeout = 180000) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.add(child)
      let output = ''
      const collect = chunk => { output = (output + this.redact(chunk.toString())).slice(-32000) }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const timer = setTimeout(() => { child.kill(); reject(new Error('Pi 安装或版本核验超时')) }, timeout)
      child.once('error', error => { this.children.delete(child); clearTimeout(timer); reject(error) })
      child.once('close', code => { this.children.delete(child); clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`Pi 命令失败 (${code}): ${output}`)) })
    })
  }

  registryUrl() {
    const url = new URL(this.registry())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Pi npm 源必须是无凭据的 HTTPS URL')
    return url.href.replace(/\/$/, '')
  }

  async checkUpdate() {
    const response = await fetch(`${this.registryUrl()}/${encodeURIComponent(PI_PACKAGE_NAME)}/latest`, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Pi 版本查询 HTTP ${response.status}`)
    const latestVersion = piVersion((await response.json()).version)
    const currentVersion = this.status().version
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
    const compatible = latestVersion === PI_PACKAGE_VERSION
    return { currentVersion, latestVersion, compatible, updateAvailable: Boolean(compatible && currentVersion && cmp(latestVersion, currentVersion) > 0) }
  }

  removeRuntime(name) {
    if (!/^runtime(?:\.update-(?:staging|backup))?$/.test(name)) throw new Error('Pi 删除目标无效')
    const target = this.file(name)
    if (!fs.existsSync(target)) return
    if (fs.lstatSync(target).isSymbolicLink() || path.dirname(fs.realpathSync(target)) !== fs.realpathSync(this.root)) throw new Error('Pi 删除目标不在受管根目录内')
    fs.rmSync(target, { recursive: true, force: true })
  }

  async install(version = PI_PACKAGE_VERSION) {
    version = piVersion(version)
    if (version !== PI_PACKAGE_VERSION) throw new Error('Pi 版本尚未通过面板兼容测试，请使用推荐版本 ' + PI_PACKAGE_VERSION)
    return this.exclusive(async () => {
      if (!piNodeSupported()) throw new Error('Pi 需要 Node.js >=22.19.0')
      if ([...this.workers.values()].some(worker => worker.rpc.busy)) throw new Error('Pi 有执行中的任务，请先停止任务再安装/更新')
      this.ensure()
      const stage = 'runtime.update-staging', backup = 'runtime.update-backup'
      // 未完成的上次切换先恢复，避免覆盖唯一回滚副本。
      if (!fs.existsSync(this.file('runtime')) && fs.existsSync(this.file(backup))) fs.renameSync(this.file(backup), this.file('runtime'))
      this.removeRuntime(stage)
      this.removeRuntime(backup)
      fs.mkdirSync(this.file(stage), { mode: 0o700 })
      const npm = this.npmCommand()
      try {
        this.log(`Installing Pi ${version}`)
        const output = await this.run(npm.command, [...npm.prefix, 'install', '--prefix', this.file(stage), '--registry', this.registryUrl(), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${PI_PACKAGE_NAME}@${version}`], {}, 600000)
        this.log(output)
        const verified = await this.run(process.execPath, [this.cli(stage), '--version'], { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: this.file('agent') }, 30000)
        if (!verified.split(/\r?\n/).some(line => line.trim() === version)) throw new Error(`Pi 版本核验失败，期望 ${version}`)
        await this.stopAll()
        if (fs.existsSync(this.file('runtime'))) fs.renameSync(this.file('runtime'), this.file(backup))
        try {
          fs.renameSync(this.file(stage), this.file('runtime'))
          const actual = await this.run(process.execPath, [this.cli(), '--version'], { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: this.file('agent') }, 30000)
          if (!actual.split(/\r?\n/).some(line => line.trim() === version)) throw new Error('Pi 切换后版本核验失败')
        } catch (error) {
          this.removeRuntime('runtime')
          if (fs.existsSync(this.file(backup))) fs.renameSync(this.file(backup), this.file('runtime'))
          throw new Error(`${error.message}；已回滚原运行时`)
        }
        this.removeRuntime(backup)
        return this.status()
      } catch (error) { this.log(error.message); throw error } finally { this.removeRuntime(stage) }
    })
  }

  async uninstall() {
    return this.exclusive(async () => {
      if ([...this.workers.values()].some(worker => worker.rpc.busy)) throw new Error('Pi 有执行中的任务，请先停止任务')
      await this.stopAll()
      this.removeRuntime('runtime')
      return { ...this.status(), dataPreserved: true }
    })
  }

  async configure(args) {
    return this.exclusive(async () => {
      if ([...this.workers.values()].some(worker => worker.rpc.busy)) throw new Error('请先停止 Pi 任务再修改工作目录或权限')
      this.ensure()
      const resolved = this.resolveWorkspace(args.workspace || this.config().workspace)
      if (typeof args.allowTools !== 'boolean') throw new Error('Pi 工具授权值无效')
      this.write(this.file('config.json'), { workspace: resolved, allowTools: args.allowTools })
      return this.status()
    })
  }

  async syncProvider(args) {
    return this.exclusive(async () => {
      if ([...this.workers.values()].some(worker => worker.rpc.busy)) throw new Error('请先停止 Pi 任务再同步模型渠道')
      this.ensure()
      const channel = await this.readChannel(args.channelId)
      if (!channel) throw new Error('模型渠道不存在')
      let apiKey = String(channel.apiKey || '')
      const match = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
      if (match) apiKey = process.env[match[1]] || ''
      if (!apiKey || /[\r\n\x00]/.test(apiKey)) throw new Error('Pi 渠道密钥为空或包含控制字符')
      this.secrets.push(apiKey)
      const result = mergePiConfig(jsonRead(this.agentFile('models.json')), jsonRead(this.agentFile('settings.json')), channel, args.setDefault === true)
      const credentials = { ...jsonRead(this.agentFile('credentials.json')), [result.providerId]: apiKey }
      const changes = [[this.agentFile('credentials.json'), credentials], [this.agentFile('models.json'), result.models], [this.agentFile('settings.json'), result.settings]]
      const previous = changes.map(([file]) => [file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null])
      await this.stopAll()
      try {
        for (const [file, value] of changes) this.write(file, value)
        for (const [file, value] of changes) if (JSON.stringify(jsonRead(file)) !== JSON.stringify(value)) throw new Error('Pi 配置回读不一致')
      } catch (error) {
        for (const [file, content] of previous) content == null ? (fs.existsSync(file) && fs.unlinkSync(file)) : this.write(file, content, false)
        throw error
      }
      return { providerId: result.providerId, model: result.defaultModel, verified: true, verification: 'config-readback', modelCount: result.provider.models.length }
    })
  }

  sessions() {
    return this.recoverSessions().map(session => {
      const worker = this.workers.get(session.id)
      return { id: session.id, name: session.name, updatedAt: session.updatedAt, workspace: session.workspace, allowTools: session.allowTools === true, running: Boolean(worker && !worker.rpc.closed), busy: Boolean(worker?.rpc.busy), pendingDialogs: worker ? [...worker.rpc.dialogs.values()].map(value => JSON.parse(this.redact(JSON.stringify(value)))) : [] }
    })
  }

  async open(args = {}) {
    if (this.mutating) throw new Error('Pi 正在执行管理操作')
    if (!this.status().installed) throw new Error('请先安装 Pi 受管运行时')
    if (!piNodeSupported()) throw new Error('Pi 需要 Node.js >=22.19.0')
    const id = args.sessionId ? safeId(args.sessionId) : crypto.randomUUID()
    if (this.workers.get(id)?.rpc.closed) this.workers.delete(id)
    if (this.workers.has(id)) return this.state(id)
    if (this.opening.has(id)) return this.opening.get(id)
    for (const [closedId, worker] of this.workers) if (worker.rpc.closed) this.workers.delete(closedId)
    if (new Set([...this.workers.keys(), ...this.opening.keys()]).size >= 3) throw new Error('Pi 最多同时打开 3 个会话，请先关闭空闲会话')
    const opening = this.startWorker(id, args).finally(() => this.opening.delete(id))
    this.opening.set(id, opening)
    return opening
  }

  async startWorker(id, args) {
    this.ensure()
    const manifest = this.recoverSessions()
    const existing = manifest.find(session => session.id === id)
    if (args.sessionId && !existing) throw new Error('Pi 会话不存在')
    const config = this.config()
    const workspace = this.resolveWorkspace(existing ? existing.workspace : config.workspace)
    const allowTools = existing ? existing.allowTools === true : config.allowTools === true
    const entry = existing || { id, name: 'New session', workspace, allowTools, updatedAt: new Date().toISOString() }
    const credentials = jsonRead(this.agentFile('credentials.json'))
    this.secrets = Object.values(credentials)
    const env = { ...process.env, PI_CODING_AGENT_DIR: this.file('agent'), PI_CODING_AGENT_SESSION_DIR: this.file('sessions'), PI_OFFLINE: '1', CLAWPANEL_PI_PRIVATE_ROOT: fs.realpathSync(this.file('agent')), CLAWPANEL_PI_ALLOW_TOOLS: allowTools ? '1' : '0' }
    for (const [provider, key] of Object.entries(credentials)) env[piCredentialEnv(provider)] = key
    const worker = { rpc: null, events: [], sequence: 0, bytes: 0, waiting: new Set(), accessed: Date.now(), entry }
    const publish = event => {
      const clean = JSON.parse(this.redact(JSON.stringify(event)))
      const item = { sequence: ++worker.sequence, event: clean }
      worker.events.push(item)
      worker.bytes += Buffer.byteLength(JSON.stringify(item))
      while (worker.events.length > 500 || worker.bytes > 4 * 1024 * 1024) worker.bytes -= Buffer.byteLength(JSON.stringify(worker.events.shift()))
      for (const wake of worker.waiting) wake()
      if (event.type === 'diagnostic' || event.type === 'process_exit') this.log(event.text || event.error)
      if (event.type === 'agent_settled') this.saveEntry({ ...entry, updatedAt: new Date().toISOString() })
    }
    const toolArgs = allowTools ? (process.platform === 'win32' ? 'read,grep,find,ls,edit,write,powershell' : 'read,grep,find,ls,edit,write,bash') : 'read,grep,find,ls'
    worker.rpc = this.rpcFactory({ cliPath: this.cli(), cwd: workspace, env, args: ['--session', this.file('sessions', id + '.jsonl'), '--no-approve', '--offline', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--extension', this.file('permission.mjs'), '--tools', toolArgs], onEvent: publish, redact: text => this.redact(text) })
    this.workers.set(id, worker)
    try {
      const initial = await worker.rpc.start()
      const available = (await worker.rpc.request({ type: 'get_available_models' })).models || []
      if (!initial.model?.provider?.startsWith('clawpanel-')) {
        const selected = available.find(model => model.provider.startsWith('clawpanel-'))
        if (selected) await worker.rpc.request({ type: 'set_model', provider: selected.provider, modelId: selected.id })
      }
      this.saveEntry(entry)
      return await this.state(id)
    } catch (error) { await worker.rpc.stop().catch(() => {}); this.workers.delete(id); throw error }
  }

  saveEntry(entry) {
    const sessions = this.manifest().filter(session => session.id !== entry.id)
    this.write(this.file('sessions.json'), [entry, ...sessions])
  }

  worker(id, allowClosed = false) {
    const worker = this.workers.get(safeId(id))
    if (!worker || (worker.rpc.closed && !allowClosed)) throw new Error('Pi 会话未启动，请重新打开会话')
    worker.accessed = Date.now()
    return worker
  }

  async state(id) {
    const worker = this.worker(id)
    // 游标在 get_messages 响应解析的同一时刻捕获，防止恢复流时丢掉并发 delta。
    const [state, snapshot, models] = await Promise.all([worker.rpc.request({ type: 'get_state' }), worker.rpc.request({ type: 'get_messages' }, 30000, data => ({ messages: data.messages || [], cursor: worker.sequence })), worker.rpc.request({ type: 'get_available_models' })])
    return JSON.parse(this.redact(JSON.stringify({ sessionId: id, state, messages: snapshot.messages, models: (models.models || []).filter(model => model.provider.startsWith('clawpanel-')).map(({ id, provider, name, contextWindow, maxTokens, reasoning }) => ({ id, provider, name, contextWindow, maxTokens, reasoning })), pendingDialogs: [...worker.rpc.dialogs.values()], cursor: snapshot.cursor, busy: worker.rpc.busy })))
  }

  async events(id, after = 0) {
    // 进程退出后的最后一批诊断仍可读取，前端收到 closed 后停止长轮询。
    const worker = this.worker(id, true)
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Pi 事件游标无效')
    if (after === worker.sequence && !worker.rpc.closed) await new Promise(resolve => {
      if (worker.waiting.size >= 8) throw new Error('Pi 会话事件订阅过多')
      const wake = () => { clearTimeout(timer); worker.waiting.delete(wake); resolve() }
      const timer = setTimeout(wake, 20000)
      worker.waiting.add(wake)
    })
    const reset = after > worker.sequence || (worker.events.length > 0 && after < worker.events[0].sequence - 1)
    return { cursor: worker.sequence, reset, events: reset ? [] : worker.events.filter(record => record.sequence > after), busy: worker.rpc.busy, closed: worker.rpc.closed, pendingDialogs: [...worker.rpc.dialogs.values()].map(value => JSON.parse(this.redact(JSON.stringify(value)))) }
  }

  async close(id) {
    const worker = this.workers.get(safeId(id))
    if (worker) { await worker.rpc.stop(); this.workers.delete(id); for (const wake of worker.waiting) wake() }
    return { success: true }
  }

  async stopAll() { for (const id of this.workers.keys()) await this.close(id) }
  async dispose() { this.disposed = true; clearInterval(this.reaper); for (const child of this.children) child.kill(); await this.stopAll() }

  async call(command, args = {}) {
    if (this.disposed) throw new Error('Pi 运行时已关闭')
    switch (command) {
      case 'status': return this.status()
      case 'install': return this.install()
      case 'check_update': return this.checkUpdate()
      case 'update': return this.install((await this.checkUpdate()).latestVersion)
      case 'uninstall': return this.uninstall()
      case 'configure': return this.configure(args)
      case 'sync_provider': return this.syncProvider(args)
      case 'sessions': return this.sessions()
      case 'open_session': return this.open(args)
      case 'session_state': return this.state(args.sessionId)
      case 'events': return this.events(args.sessionId, args.after ?? 0)
      case 'prompt': {
        const worker = this.worker(args.sessionId)
        const state = await worker.rpc.request({ type: 'get_state' })
        if (!state.model?.provider?.startsWith('clawpanel-')) throw new Error('请先从模型渠道同步并选择 Pi 模型')
        const result = await worker.rpc.prompt(String(args.message || ''))
        if (!worker.entry.name || worker.entry.name === 'New session') worker.entry.name = String(args.message).replace(/\s+/g, ' ').trim().slice(0, 60)
        this.saveEntry({ ...worker.entry, updatedAt: new Date().toISOString() })
        return result
      }
      case 'set_model': {
        const worker = this.worker(args.sessionId)
        if (worker.rpc.busy) throw new Error('任务执行中，请完成或停止后切换模型')
        const available = (await worker.rpc.request({ type: 'get_available_models' })).models || []
        if (!available.some(model => model.provider.startsWith('clawpanel-') && model.provider === args.provider && model.id === args.modelId)) throw new Error('Pi 模型未通过渠道同步或不可用')
        return worker.rpc.request({ type: 'set_model', provider: args.provider, modelId: args.modelId })
      }
      case 'abort': return this.worker(args.sessionId).rpc.abort()
      case 'dialog_response': return this.worker(args.sessionId).rpc.respond(args)
      case 'close_session': return this.close(args.sessionId)
      case 'logs': { const file = this.file('runtime.log'); return fs.existsSync(file) ? this.redact(fs.readFileSync(file, 'utf8').slice(-32000)) : '' }
      default: throw new Error('Pi 命令不存在')
    }
  }
}
