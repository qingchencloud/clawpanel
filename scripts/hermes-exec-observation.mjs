// 只读诊断工厂，可直接 function.toString 嵌入可信 preload；不负责安装或准入。
// 无模块闭包/外部依赖：只需 Node 全局 Buffer，以及调用者注入原 execFile/write。
// 不序列化 options/env/error.message/error.cmd。调用者须通过 secrets/redact 提供业务凭据脱敏。
// 每流最多保留/输出1MiB；仅start/result/close，额外只记录块首末UTC/总字节，不改流或预算。
export function createHermesExecFileObserver(execFile, { write = () => {}, secrets = [], redact = text => text } = {}) {
  if (typeof execFile !== 'function' || typeof write !== 'function' || typeof redact !== 'function') throw new TypeError('exec observer requires execFile/write/redact functions')
  if (!Array.isArray(secrets) || !secrets.every(value => typeof value === 'string')) throw new TypeError('exec observer secrets must be strings')
  const knownSecrets = secrets.filter(Boolean).slice(), limit = 1024 * 1024
  let sequence = 0

  function decode(bytes, truncated) {
    let end = bytes.length
    if (truncated && end) {
      let start = end - 1
      while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--
      if (start >= 0) {
        const lead = bytes[start], width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
        if (start + width > end) end = start
      }
    }
    return bytes.subarray(0, end).toString('utf8')
  }
  function sanitize(text, truncated = false, byteLimit = limit) {
    for (const secret of knownSecrets) {
      text = text.replaceAll(secret, '[REDACTED]')
      // 有界截断可能留下已知凭据的前缀；该尾段也不输出。
      if (truncated) for (let size = Math.min(text.length, secret.length - 1); size > 0; size--) {
        if (text.endsWith(secret.slice(0, size))) { text = text.slice(0, -size) + '[REDACTED]'; break }
      }
    }
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(\b(?:authorization|api[-_]?key|token|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/\b(?:sk-|ghp_|github_pat_|hf_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    text = redact(text)
    if (typeof text !== 'string') throw new TypeError('exec observer redact must return string')
    const bytes = Buffer.from(text.slice(0, byteLimit + 1), 'utf8')
    return decode(bytes.subarray(0, byteLimit), bytes.length > byteLimit)
  }
  function textValue(value) {
    if (Buffer.isBuffer(value)) return { text: sanitize(decode(value.subarray(0, limit), value.length > limit), value.length > limit), truncated: value.length > limit }
    if (typeof value !== 'string') return { text: '', truncated: false }
    const bytes = Buffer.from(value.slice(0, limit + 1), 'utf8'), truncated = bytes.length > limit || value.length > limit
    return { text: sanitize(decode(bytes.subarray(0, limit), truncated), truncated), truncated }
  }
  function collector() {
    const bytes = Buffer.alloc(limit)
    let kept = 0, seen = 0, firstChunkUtc = null, lastChunkUtc = null
    return {
      add(chunk) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        if (value.length) { const utc = new Date().toISOString(); firstChunkUtc ??= utc; lastChunkUtc = utc }
        seen += value.length
        if (kept < limit) kept += value.copy(bytes, kept, 0, Math.min(value.length, limit - kept))
      },
      value() { return { text: sanitize(decode(bytes.subarray(0, kept), seen > kept), seen > kept), truncated: seen > kept } },
      timing() { return { firstChunkUtc, lastChunkUtc, bytes: seen } },
    }
  }
  function errorFields(error) {
    if (!error) return null
    // ENOENT的syscall可含完整program；只脱敏日志中的文本，原Error不修改。
    const name = error.name, syscall = error.syscall
    return { name: typeof name === 'string' ? sanitize(name) : name, code: error.code, signal: error.signal, killed: error.killed, errno: error.errno, syscall: typeof syscall === 'string' ? sanitize(syscall) : syscall }
  }
  function observe(makeRow) {
    try {
      const outcome = write(makeRow())
      // 只隔离观察器的失败；不包裹应用回调、不延迟应用完成。
      if (outcome && typeof outcome.then === 'function') Promise.resolve(outcome).catch(() => {})
    } catch { /* 观察失败不替代原始应用结果，也不回退输出未脱敏内容。 */ }
  }

  return function observedExecFile(...callArgs) {
    const callId = ++sequence, stdout = collector(), stderr = collector()
    let child, returned = false, resultRecorded = false, callbackSnapshot, resultErrorSnapshot, emittedError, emittedErrorSnapshot, earlyResult
    const base = event => ({ schemaVersion: 1, event, callId, utc: new Date().toISOString(), pid: child?.pid ?? null })
    const streamTiming = () => ({ stdout: stdout.timing(), stderr: stderr.timing() })
    const start = () => observe(() => {
      const argv = [], input = callArgs[1]
      let hideNext = false, argvTruncated = Array.isArray(input) && input.length > 128
      if (Array.isArray(input)) for (let i = 0; i < Math.min(input.length, 128); i++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i))
        const value = descriptor?.value
        if (typeof value === 'string' && value.length > 4096) argvTruncated = true
        argv.push(hideNext ? '[REDACTED]' : typeof value === 'string' ? sanitize(value.slice(0, 4096), value.length > 4096, 4096) : '[NON-DATA-ARGUMENT]')
        hideNext = typeof value === 'string' && /^--?(?:api[-_]?key|access[-_]?token|token|password|secret|authorization|auth)$/i.test(value)
      }
      return { ...base('execFile-start'), program: sanitize(typeof callArgs[0] === 'string' ? callArgs[0].slice(0, 4096) : '[NON-STRING-PROGRAM]', typeof callArgs[0] === 'string' && callArgs[0].length > 4096, 4096), argv, argvTruncated }
    })
    const output = values => {
      const out = values ? textValue(values[1]) : stdout.value(), err = values ? textValue(values[2]) : stderr.value()
      return { stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated }
    }
    const result = (source, values, code, signal) => {
      if (resultRecorded) return
      resultRecorded = true
      const error = values ? values[0] : emittedError
      observe(() => {
        // 在应用回调修改 Error 前冻结原字段；写入方也只收到副本。
        resultErrorSnapshot = values ? errorFields(error) : emittedErrorSnapshot ?? errorFields(error)
        callbackSnapshot = output(values)
        return { ...base('execFile-result'), source, ...callbackSnapshot, streamTiming: streamTiming(), error: resultErrorSnapshot ? { ...resultErrorSnapshot } : null, code: error ? resultErrorSnapshot.code : code ?? null, signal: error ? resultErrorSnapshot.signal : signal ?? null, killed: error ? resultErrorSnapshot.killed : child?.killed ?? false }
      })
    }
    // 只定位 Node normalizeExecFileArgs 实际消费的回调槽，不读取或克隆 options/env。
    const second = callArgs[1], third = callArgs[2]
    const index = typeof second === 'function' ? 1 : second != null && typeof second === 'object' && !Array.isArray(second) ? 2 : typeof third === 'function' ? 2 : 3
    const callback = callArgs[index]
    if (typeof callback === 'function') callArgs[index] = function (...values) {
      if (returned) result('callback', values)
      else earlyResult = values
      return Reflect.apply(callback, this, values)
    }
    try {
      child = Reflect.apply(execFile, this, callArgs)
    } catch (error) {
      returned = true; start()
      observe(() => ({ ...base('execFile-result'), source: 'sync-throw', error: errorFields(error) }))
      throw error
    }
    returned = true; start()
    if (earlyResult) result('callback', earlyResult)
    // 不setEncoding、不暂停/恢复、不注入缺省callback；原ChildProcess直接返回。
    child.stdout?.on('data', chunk => { try { stdout.add(chunk) } catch { /* 只隔离诊断采集错误。 */ } })
    child.stderr?.on('data', chunk => { try { stderr.add(chunk) } catch { /* 只隔离诊断采集错误。 */ } })
    child.once('error', error => { emittedError = error; try { emittedErrorSnapshot = errorFields(error) } catch { /* 原生错误仍由应用处理。 */ } })
    child.once('close', (code, signal) => {
      if (!resultRecorded) result('close-no-callback', null, code, signal)
      observe(() => ({ ...base('execFile-close'), code, signal, killed: child.killed, error: resultErrorSnapshot ? { ...resultErrorSnapshot } : null, ...(callbackSnapshot || output(null)), streamTiming: streamTiming() }))
    })
    return child
  }
}
