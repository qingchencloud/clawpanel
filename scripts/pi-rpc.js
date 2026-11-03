/** 官方 Pi JSONL RPC 的进程适配；stdout 严格按 LF 分帧，诊断只读 stderr。 */
import { spawn as spawnRpc } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export class PiRpcProcess {
  constructor({ cliPath, cwd, env, args = [], onEvent = () => {}, redact = value => String(value), spawn = spawnRpc }) {
    this.options = { cliPath, cwd, env, args, spawn }
    this.onEvent = onEvent
    this.redact = redact
    this.pending = new Map()
    this.dialogs = new Map()
    this.busy = false
    this.lastError = ''
    this.closed = false
  }

  async start() {
    const { cliPath, cwd, env, args, spawn } = this.options
    this.child = spawn(process.execPath, [cliPath, '--mode', 'rpc', ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return this.fail(new Error('Pi RPC 记录超过 16 MiB'))
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) continue
        try { this.accept(JSON.parse(line)) } catch (error) { this.fail(new Error(`Pi RPC 协议错误: ${error.message}`)) }
      }
    })
    this.child.stderr.on('data', chunk => {
      this.lastError = (this.lastError + this.redact(chunk.toString())).slice(-16000)
      this.onEvent({ type: 'diagnostic', text: this.redact(chunk.toString()) })
    })
    this.child.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`Pi 进程退出 (${code ?? signal}): ${this.lastError}`), false))
    return this.request({ type: 'get_state' }, 30000)
  }

  accept(record) {
    if (record.type === 'response') {
      const pending = this.pending.get(record.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(record.id)
      if (record.success) pending.resolve(pending.capture(record.data ?? {}))
      else pending.reject(new Error(this.redact(record.error || 'Pi RPC 请求失败')))
      return
    }
    if (record.type === 'agent_start') this.busy = true
    if (record.type === 'agent_settled') { this.busy = false; this.dialogs.clear() }
    if (record.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(record.method)) {
      this.dialogs.set(record.id, record)
      if (Number.isSafeInteger(record.timeout) && record.timeout > 0) {
        const timer = setTimeout(() => {
          if (this.dialogs.delete(record.id)) this.onEvent({ type: 'dialog_resolved', id: record.id })
        }, record.timeout)
        timer.unref?.()
      }
    }
    this.onEvent(record)
  }

  send(record) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Pi 会话进程已关闭')
    this.child.stdin.write(JSON.stringify(record) + '\n')
  }

  request(command, timeout = 30000, capture = value => value) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC ${command.type} 请求超时`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, capture })
      try { this.send({ ...command, id }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  async prompt(message) {
    if (this.busy) throw new Error('Pi 正在执行任务，请先停止或等待完成')
    if (!String(message || '').trim() || message.length > 1024 * 1024) throw new Error('Pi 消息为空或超过 1 MiB')
    this.busy = true
    try { return await this.request({ type: 'prompt', message }) } catch (error) { this.busy = false; throw error }
  }

  respond(args) {
    const dialog = this.dialogs.get(args.id)
    if (!dialog) throw new Error('Pi 交互请求已失效，请刷新会话')
    const response = { type: 'extension_ui_response', id: args.id }
    if (args.cancelled === true) response.cancelled = true
    else if (dialog.method === 'confirm') {
      if (typeof args.confirmed !== 'boolean') throw new Error('Pi 确认值无效')
      response.confirmed = args.confirmed
    } else {
      if (typeof args.value !== 'string' || args.value.length > 1024 * 1024) throw new Error('Pi 输入值无效')
      if (dialog.method === 'select' && !dialog.options.includes(args.value)) throw new Error('Pi 选择值不在选项列表中')
      response.value = args.value
    }
    this.send(response)
    this.dialogs.delete(args.id)
    this.onEvent({ type: 'dialog_resolved', id: args.id })
    return { success: true }
  }

  async abort() {
    for (const id of this.dialogs.keys()) this.respond({ id, cancelled: true })
    await this.request({ type: 'clear_queue' })
    await this.request({ type: 'abort' })
    this.busy = false
    return { success: true }
  }

  fail(error, terminate = true) {
    if (this.closed) return
    this.closed = true
    this.busy = false
    this.dialogs.clear()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.onEvent({ type: 'process_exit', error: this.redact(error.message) })
    if (terminate) this.child?.kill()
  }

  async stop() {
    if (this.closed) return
    if (this.busy) await this.abort().catch(() => {})
    this.child.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve() }, 2000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    this.fail(new Error('Pi 会话已停止'), false)
  }
}
