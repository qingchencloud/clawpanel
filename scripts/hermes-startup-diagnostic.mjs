/** 仅可信 VM 诊断调用；不是准入证明，普通产品路径不得调用。 */
export function prepareStartupDiagnosticSpawn(spec, config) {
  if (config?.enabled !== true) return spec
  if (config.scope !== 'diagnostic-only-not-acceptance') throw Error('diagnostic scope contract mismatch')
  const args = spec.args
  if (!Array.isArray(args)) return spec
  if (!args.every(a => typeof a === 'string' && !a.includes('\0'))) throw Error('diagnostic argv contract mismatch')
  if (config.version === '0.21.5') {
    if (spec.program !== 'hermes' || args.length !== 2 || args[0] !== 'gateway' || args[1] !== 'run') return spec
    return { ...spec, options: { ...spec.options, env: { ...spec.options?.env, PYTHONPROFILEIMPORTTIME: '1' } } }
  }
  if (config.version !== '0.22.2') throw Error('diagnostic version contract mismatch')
  // metadata/安装/STOP 等进程保持完全原样；只观测实际前台 Gateway。
  if (args.at(-2) !== 'gateway' || args.at(-1) !== 'run') return spec
  if (args.length !== 10 || args[0] !== '-I' || args[1] !== '-B' || args[2] !== '-c' ||
      args[3] !== config.pmScript || !config.pmScript || args[6] !== config.pin ||
      config.pin !== 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' || args[7] !== '--') throw Error('diagnostic PM contract mismatch')
  const prepared = [args[0], args[1], '-X', 'importtime', ...args.slice(2)]
  if (config.stackSampling === true) {
    // 不改固定源码或 PM 原脚本；原始脚本作为后缀完整执行。采样线程不阻止退出。
    const prefix = String.raw`import faulthandler as _hfd, threading as _hth, os as _hos, sys as _hsys
print('CLAWPANEL_STACK_SAMPLER_MAIN',_hos.getpid(),hex(_hth.get_ident()),file=_hsys.stderr,flush=True)
_hfd.dump_traceback_later(2, repeat=True)
_hst=_hth.Timer(60,_hfd.cancel_dump_traceback_later);_hst.daemon=True;_hst.start()
`
    prepared[5] = prefix + prepared[5]
  }
  // Python subprocess.list2cmdline 的 Windows UTF16 长度（包含 NUL）；不裁剪 PM 脚本。
  function quote(value) {
    const quoted = !value || /[ \t]/.test(value)
    let output = quoted ? '"' : '', slashes = 0
    for (const c of value) {
      if (c === '\\') { slashes++; continue }
      output += c === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + c
      slashes = 0
    }
    return output + '\\'.repeat(slashes * (quoted ? 2 : 1)) + (quoted ? '"' : '')
  }
  if ([spec.program, ...prepared].map(quote).join(' ').length + 1 > 32767) throw Error('diagnostic exceeds 32767 UTF16 limit')
  return { ...spec, args: prepared }
}

/** 固定日志旁读；保持数字 stdio FD 不变。时间仅指观察进程读到文件的时刻。 */
export function startHermesFilePhaseObservation({ fs, path, file, receive, onFinish = () => {} }) {
  const started = Date.now(), decoder = new TextDecoder('utf-8')
  let fd, identity, offset = 0, records = 0, buffered = '', dropping = false, timer, stopped = false, status = 'stopped'
  function stop(reason = 'stopped') {
    if (stopped) return
    stopped = true; status = typeof reason === 'string' ? reason : 'child-closed'; clearInterval(timer)
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 只读诊断不得影响应用退出。 */ } }
    try { onFinish({ scope: 'gateway-log-file-read-not-emission', status, bytesRead: offset, records, elapsedMs: Date.now() - started, qualificationPass: false }) } catch { /* 保留产品结果。 */ }
  }
  function tick() {
    if (stopped) return
    if (Date.now() - started > 60000) { stop('duration-limit'); return }
    try {
      // 只读一个固定普通文件，拒绝所有祖先链接；不跟随轮转或替换后的文件。
      for (let p = path.resolve(file);; p = path.dirname(p)) {
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) { stop('linked-path'); return }
        if (p === path.dirname(p)) break
      }
      if (!fs.existsSync(file)) return
      const current = fs.lstatSync(file)
      if (!current.isFile()) { stop('not-regular-file'); return }
      if (fd === undefined) {
        fd = fs.openSync(file, 'r'); identity = fs.fstatSync(fd)
        if (current.dev !== identity.dev || current.ino !== identity.ino) { stop('changed-file'); return }
      }
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.size < offset) { stop('changed-file'); return }
      if (offset >= 8 * 1024 * 1024 || records >= 64) { stop('observation-limit'); return }
      const length = Math.min(65536, current.size - offset, 8 * 1024 * 1024 - offset)
      if (!length) return
      const bytes = Buffer.alloc(length), count = fs.readSync(fd, bytes, 0, length, offset); offset += count
      const parts = decoder.decode(bytes.subarray(0, count), { stream: true }).split('\n')
      for (let i = 0; i < parts.length; i++) {
        const complete = i < parts.length - 1
        if (dropping) { if (complete) dropping = false; continue }
        buffered += parts[i]
        if (buffered.length > 4096) { buffered = ''; dropping = !complete; continue }
        if (!complete) continue
        const line = buffered.replace(/\r$/, ''); buffered = ''
        if (line.startsWith('CLAWPANEL_HERMES_PHASE ') && records < 64) {
          records++
          try { receive(Buffer.from(line + '\n', 'utf8')) } catch { /* 不吞掉或改写产品日志。 */ }
        }
      }
    } catch { stop('observation-error') }
  }
  tick(); if (!stopped) { timer = setInterval(tick, 100); timer.unref() }
  return stop
}
