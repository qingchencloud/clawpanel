// 仅组件：不接生产入口、KnownFolder、GUI、workflow或发行资格。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const FLAGS = '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
const POLLUTING = new Set(['tauri_config', 'webview2_additional_browser_arguments', 'webview2_user_data_folder', 'webview2_pipe_for_script_debugger', 'webview2_wait_for_script_debugger'])
function contract(options) {
  assert.equal(options?.mode, 'component-config-only', '仅允许纯配置组件mode')
  assert.ok(options.env && typeof options.env === 'object' && !Array.isArray(options.env), 'env投影必须显式提供')
  assert.ok(!Object.keys(options.env).some(k => POLLUTING.has(k.toLowerCase())), '配置环境污染')
}
export function buildOwnedProfileOverlay(base, options) {
  contract(options)
  assert.ok(base && typeof base === 'object' && !Array.isArray(base))
  const copy = JSON.parse(JSON.stringify(base))
  assert.deepEqual(copy, base, '配置必须是无损JSON对象')
  assert.equal(copy.identifier, 'ai.openclaw.clawpanel')
  assert.ok(Array.isArray(copy.app?.windows) && copy.app.windows.length > 0, '缺完整windows数组')
  const labels = new Set()
  for (const w of copy.app.windows) {
    assert.ok(w && typeof w === 'object' && !Array.isArray(w))
    assert.ok(!Object.hasOwn(w, 'additionalBrowserArgs'), '不覆盖原browser args')
    const label = w.label ?? 'main'; assert.equal(typeof label, 'string'); assert.ok(label && !labels.has(label)); labels.add(label)
    w.additionalBrowserArgs = FLAGS
  }
  return { app: { windows: copy.app.windows } }
}
export function validateOwnedProfileOverlay(base, overlay, options) {
  assert.deepEqual(overlay, buildOwnedProfileOverlay(base, options), 'overlay必须精确clone全部window且仅固定两flags')
  return true
}

// 只创建本函数自己的全新TEMP fixture；不接受任意root/生产mode/假VM资格参数。
export async function startOwnedProfileFixture() {
  assert.equal(process.platform, 'win32', '真实NT组件仅Windows执行')
  const parent = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'weixin-owned-profile-fixture-'))
  const nonce = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(path.join(root, '.fixture-receipt.json'), JSON.stringify({ schemaVersion: 1, scope: 'own-temp-component-only', nonce, creatorPid: process.pid }), { flag: 'wx' })
  const file = fileURLToPath(new URL('./weixin-native-owned-profile.ps1', import.meta.url))
  const scriptBefore = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const args = ['-NoProfile', '-NonInteractive', '-File', file, '-Mode', 'own-temp-component', '-FixtureRoot', root, '-Nonce', nonce]
  assert.ok(args.join(' ').length < 32767)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'))
  // CodeDOM/Add-Type自身临时文件也收进本轮fixture；不改变父环境。
  for (const key of Object.keys(env)) if (['temp', 'tmp'].includes(key.toLowerCase())) delete env[key]
  env.TEMP = root; env.TMP = root
  assert.ok(env.SystemRoot && path.isAbsolute(env.SystemRoot))
  const program = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const argvBound = [program, ...args].reduce((n, value) => n + 2 * value.length + 3, 1)
  assert.ok(argvBound <= 32767, 'Windows argv保守上界超过32767')
  const started = process.hrtime.bigint()
  const child = spawn(program, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let bytes = 0, tail = '', stderr = '', sequence = 0, closed = false, exitCode = null, fault, deadlineExceeded = false, resolveDeadline
  const pending = new Map(), decoder = new StringDecoder('utf8')
  const rejectAll = error => { fault ||= error; for (const p of pending.values()) p.reject(error); pending.clear() }
  const deadlineResult = new Promise(resolve => { resolveDeadline = resolve })
  const deadline = setTimeout(() => {
    deadlineExceeded = true; rejectAll(Error('组件原30s总deadline超时')); child.kill()
    // 缺close/继承pipe也不继续无界等待；只关闭自有管道，保留退出/句柄未知红灯。
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    resolveDeadline(null)
  }, 30000)
  child.on('error', rejectAll)
  child.stdin.on('error', rejectAll)
  child.stdout.on('data', data => {
    bytes += data.length
    if (bytes > 16 * 1024 * 1024) { rejectAll(Error('组件原16MiB输出预算超限')); child.kill(); return }
    tail += decoder.write(data)
    for (;;) {
      const end = tail.indexOf('\n'); if (end < 0) break
      const line = tail.slice(0, end).trim(); tail = tail.slice(end + 1)
      if (!line) continue
      try {
        const value = JSON.parse(line), p = pending.get(value.id)
        assert.ok(p, '未请求或重复response id'); pending.delete(value.id); p.resolve(value)
      } catch (error) { rejectAll(error); child.kill() }
    }
  })
  child.stderr.on('data', data => { bytes += data.length; stderr = (stderr + data.toString('utf8')).slice(-16000); if (bytes > 16 * 1024 * 1024) { rejectAll(Error('组件原16MiB输出预算超限')); child.kill() } })
  const exit = new Promise(resolve => child.once('close', code => {
    closed = true; exitCode = code; clearTimeout(deadline)
    if (pending.size) rejectAll(Error('组件退出前缺response: ' + stderr))
    resolve(code)
  }))
  const request = payload => new Promise((resolve, reject) => {
    if (fault || closed) { reject(fault || Error('组件已退出')); return }
    const id = ++sequence; assert.ok(id <= 128, '组件最多128条请求')
    const data = JSON.stringify({ ...payload, id }); assert.ok(Buffer.byteLength(data) < 24576)
    pending.set(id, { resolve, reject }); child.stdin.write(data + '\n')
  })
  return {
    root, request,
    async close() {
      let receipt
      if (!closed && !fault) { try { receipt = await request({ op: 'shutdown' }) } catch (error) { fault ||= error } }
      child.stdin.end(); if (fault && !closed) child.kill()
      await Promise.race([exit, deadlineResult])
      if (!closed) child.unref()
      const scriptAfter = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      if (scriptAfter !== scriptBefore) fault ||= Error('组件PS源码执行期间漂移')
      return { ...receipt, exitCode, stderr, error: fault?.message, deadlineExceeded, cleanupGap: closed ? undefined : 'child-close-not-observed-at-deadline', childPid: child.pid, fixtureRoot: root, program, scriptPath: file, scriptBefore, scriptAfter, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024, outputBytes: bytes, argvBound, fixtureRetained: true, scope: 'component handles only; no app/runtime/production cleanup' }
    },
  }
}
