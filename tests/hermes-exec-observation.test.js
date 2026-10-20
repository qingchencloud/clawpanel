// 自有 Node 子进程端到端观察；不是 Hermes 内核或 Windows VM 资格证明。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const load = () => import('../scripts/hermes-exec-observation.mjs')
const limit = 1024 * 1024
const evidence = process.env.HERMES_EXEC_TEST_EVIDENCE
const fields = error => error ? Object.fromEntries(['name', 'code', 'signal', 'killed', 'errno', 'syscall'].map(key => [key, error[key]])) : null
const digest = value => createHash('sha256').update(value).digest('hex')

function fixture(t, name) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-exec-observation-'))
  const children = [], events = [], callbacks = [], files = []
  const source = code => { const file = path.join(dir, 'fixture-' + files.length + '.mjs'); fs.writeFileSync(file, code); files.push(file); return file }
  const options = extra => ({ windowsHide: true, cwd: dir, env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir }, ...extra })
  const remember = child => { const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, at: new Date().toISOString() }))); children.push({ child, closed }); return child }
  const run = (fn, args, opts = options()) => new Promise((resolve, reject) => {
    let child
    try {
      child = remember(fn(process.execPath, args, opts, function (...values) {
        const [error, stdout, stderr] = values
        callbacks.push({ pid: child?.pid, error: fields(error), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: digest(stdout), stderrSha256: digest(stderr), argumentCount: values.length })
        resolve({ child, receiver: this, values, error, stdout, stderr })
      }))
      child.stdin?.end()
    } catch (error) { reject(error) }
  })
  t.after(async () => {
    const cleanup = await Promise.all(children.map(async ({ child, closed }) => { if (child.exitCode === null && child.signalCode === null) child.kill(); const close = await closed; return { pid: child.pid ?? null, ...close } }))
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ scope: 'own Node real execFile, not VM or Hermes qualification', environment: { node: process.version, platform: process.platform, arch: process.arch }, events, callbacks, cleanup }, null, 2)) }
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, events, options, source, run, remember, children }
}

function lifecycle(events, pid) {
  const rows = events.filter(event => event.pid === pid)
  assert.deepEqual(rows.map(event => event.event), ['execFile-start', 'execFile-result', 'execFile-close'])
  for (const row of rows) assert.match(row.utc, /^\d{4}-\d\d-\d\dT.*Z$/)
  assert.equal(new Set(rows.map(row => row.callId)).size, 1)
  return rows
}

test('exec观察：成功原stdout/stderr、返回孩子、参数引用和callback this/全参数/返回值不变', async t => {
  const { createHermesExecFileObserver } = await load()
  const f = fixture(t, 'success'), args = [f.source("process.stdout.write('original-out');process.stderr.write('original-err')")], opts = Object.freeze(f.options({ timeout: 15000, encoding: 'utf8' }))
  let originalChild, invocation, appReceiver, appValues, appCalls = 0, callbackReturn
  const marker = {}, receiver = {}
  const delegate = function (...actual) {
    assert.equal(this, receiver); assert.equal(actual[0], process.execPath); assert.equal(actual[1], args); assert.equal(actual[2], opts); assert.equal(actual.length, 4)
    const callback = actual[3]
    actual[3] = function (...values) { invocation = { receiver: this, values }; callbackReturn = Reflect.apply(callback, this, [...values, marker, opts]); return callbackReturn }
    originalChild = Reflect.apply(execFile, this, actual); return originalChild
  }
  const wrapped = createHermesExecFileObserver(delegate, { write: row => f.events.push(row) })
  await new Promise(resolve => {
    const returned = f.remember(wrapped.call(receiver, process.execPath, args, opts, function (...values) { appCalls++; appReceiver = this; appValues = values; resolve(); return marker }))
    assert.equal(returned, originalChild); returned.stdin.end()
  })
  await f.children[0].closed
  assert.equal(appCalls, 1); assert.equal(appReceiver, invocation.receiver); assert.equal(appValues.length, 5)
  for (let i = 0; i < 3; i++) assert.equal(appValues[i], invocation.values[i])
  assert.equal(appValues[3], marker); assert.equal(appValues[4], opts); assert.equal(callbackReturn, marker)
  const [, result, close] = lifecycle(f.events, originalChild.pid)
  assert.equal(result.stdout, 'original-out'); assert.equal(result.stderr, 'original-err'); assert.equal(result.error, null)
  assert.equal(close.code, 0); assert.equal(close.signal, null)
})

test('exec观察：exit7保留原error对象和stdout+stderr，不改判identity或timeout', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'exit7')
  const args = [f.source("process.stdout.write('STOP partial stdout');process.stderr.write('STOP real stderr');process.exitCode=7")]
  let nativeError, nativeStdout, nativeStderr
  const delegate = (...actual) => { const cb = actual[3]; actual[3] = function (...values) { [nativeError, nativeStdout, nativeStderr] = values; return Reflect.apply(cb, this, values) }; return execFile(...actual) }
  const result = await f.run(createHermesExecFileObserver(delegate, { write: row => f.events.push(row) }), args)
  await f.children[0].closed
  assert.equal(result.error, nativeError); assert.equal(result.stdout, nativeStdout); assert.equal(result.stderr, nativeStderr)
  assert.equal(result.error.code, 7); assert.equal(result.stdout, 'STOP partial stdout'); assert.equal(result.stderr, 'STOP real stderr')
  const [, observed, close] = lifecycle(f.events, result.child.pid)
  assert.deepEqual(observed.error, fields(result.error)); assert.equal(observed.stdout, result.stdout); assert.equal(observed.stderr, result.stderr)
  assert.equal(close.code, 7); assert.equal(close.signal, result.child.signalCode); assert.equal(close.killed, result.child.killed)
  assert.equal(observed.error.killed, false); assert.equal('classification' in observed, false)
})

test('exec观察：真实原15秒timeout，code/signal/killed与直接execFile一致，预算不重置不重试', { timeout: 26000 }, async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'timeout-15000')
  const args = [f.source("process.stdout.write('before timeout out');process.stderr.write('before timeout err');setInterval(()=>{},1000)")]
  const opts = Object.freeze(f.options({ timeout: 15000, killSignal: 'SIGTERM' })), start = performance.now()
  let invocations = 0
  const wrapped = createHermesExecFileObserver(function (...actual) { invocations++; assert.equal(actual[1], args); assert.equal(actual[2], opts); assert.equal(actual[2].timeout, 15000); return Reflect.apply(execFile, this, actual) }, { write: row => f.events.push(row) })
  const [native, actual] = await Promise.all([f.run(execFile, args, opts), f.run(wrapped, args, opts)])
  await Promise.all(f.children.map(row => row.closed))
  const elapsed = performance.now() - start
  assert.equal(invocations, 1); assert.ok(elapsed >= 14500 && elapsed < 17500, '原15秒边界: ' + elapsed)
  assert.deepEqual(fields(actual.error), fields(native.error)); assert.equal(actual.stdout, native.stdout); assert.equal(actual.stderr, native.stderr)
  assert.equal(actual.error.killed, true); assert.equal(actual.error.signal, 'SIGTERM')
  const [, observed, close] = lifecycle(f.events, actual.child.pid)
  assert.deepEqual(observed.error, fields(actual.error)); assert.equal(observed.stdout, actual.stdout); assert.equal(observed.stderr, actual.stderr)
  assert.equal(close.signal, actual.child.signalCode); assert.equal(close.killed, actual.child.killed)
})

test('exec观察：原execFile重载和缺省callback逐一走真实孩子，不新增callback或改arity', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'overloads')
  const args = [f.source("process.stdout.write('overload out');process.stderr.write('overload err')")], opts = Object.freeze(f.options())
  for (const form of ['file-cb', 'file-args-cb', 'file-options-cb', 'file-args-options-cb', 'file-null-options-cb', 'file', 'file-args', 'file-options', 'file-args-options', 'file-args-options-null']) {
    let calls = 0, expected, callbackCount = 0, nativeChild
    const wrapped = createHermesExecFileObserver(function (...actual) { calls++; assert.equal(actual.length, expected.length, form); for (let i = 0; i < actual.length; i++) if (typeof expected[i] !== 'function') assert.equal(actual[i], expected[i], form + ':' + i); nativeChild = Reflect.apply(execFile, this, actual); return nativeChild }, { write: row => f.events.push(row) })
    const cb = function (error, stdout, stderr) { callbackCount++; assert.equal(error, null); assert.equal(stdout, form.includes('args') ? 'overload out' : ''); assert.equal(stderr, form.includes('args') ? 'overload err' : '') }
    expected = ({ 'file-cb': [process.execPath, cb], 'file-args-cb': [process.execPath, args, cb], 'file-options-cb': [process.execPath, opts, cb], 'file-args-options-cb': [process.execPath, args, opts, cb], 'file-null-options-cb': [process.execPath, null, opts, cb], file: [process.execPath], 'file-args': [process.execPath, args], 'file-options': [process.execPath, opts], 'file-args-options': [process.execPath, args, opts], 'file-args-options-null': [process.execPath, args, opts, null] })[form]
    const child = f.remember(wrapped(...expected)); assert.equal(child, nativeChild); child.stdin.end(); await f.children.at(-1).closed
    assert.equal(calls, 1); assert.equal(callbackCount, form.endsWith('-cb') ? 1 : 0)
    const [, result] = lifecycle(f.events, child.pid)
    assert.equal(result.source, form.endsWith('-cb') ? 'callback' : 'close-no-callback')
    assert.equal(result.stdout, form.includes('args') ? 'overload out' : '')
  }
})

test('exec观察：缺省callback的exit7保留close原码与两流，不捏造Error', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'no-callback-exit7')
  const wrapped = createHermesExecFileObserver(execFile, { write: row => f.events.push(row) })
  const child = f.remember(wrapped(process.execPath, [f.source("process.stdout.write('no cb out');process.stderr.write('no cb err');process.exitCode=7")], f.options()))
  child.stdin.end(); await f.children[0].closed
  const [, result, close] = lifecycle(f.events, child.pid)
  assert.equal(result.source, 'close-no-callback'); assert.equal(result.error, null); assert.equal(result.code, 7)
  assert.equal(result.stdout, 'no cb out'); assert.equal(result.stderr, 'no cb err'); assert.equal(close.code, 7)
})

test('exec观察：真实观察文件写失败和异步reject不改变应用成功/exit7', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'sink-failures')
  const args = [f.source("process.stdout.write('sink out');process.stderr.write('sink err');process.exitCode=7")]
  for (const write of [() => fs.appendFileSync(path.join(f.dir, 'absent-parent', 'audit.jsonl'), 'x'), () => Promise.reject(new Error('observer-only-rejection'))]) {
    const observed = await f.run(createHermesExecFileObserver(execFile, { write }), args)
    assert.equal(observed.error.code, 7); assert.equal(observed.stdout, 'sink out'); assert.equal(observed.stderr, 'sink err')
    const success = await f.run(createHermesExecFileObserver(execFile, { write }), [f.source("process.stdout.write('success survives sink')")])
    assert.equal(success.error, null); assert.equal(success.stdout, 'success survives sink')
  }
})

test('exec观察：原callback抛出异常仍到应用uncaughtException，不被观察错误保护吞掉', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'callback-throw')
  const source = `import {execFile} from 'node:child_process';const create=${createHermesExecFileObserver.toString()};const sentinel=new Error('application-original');process.once('uncaughtException',error=>{if(error!==sentinel)process.exit(8);process.stdout.write('callback-throw-preserved');process.exit(0)});const child=create(execFile,{write(){throw Error('observation-only')}})(process.execPath,['-e','process.exit(0)'],{windowsHide:true},function(){throw sentinel});child.stdin.end();setTimeout(()=>process.exit(9),3000)`
  const result = await f.run(execFile, [f.source(source)], f.options({ timeout: 5000 }))
  assert.equal(result.error, null); assert.equal(result.stdout, 'callback-throw-preserved')
})

test('exec观察：真实Buffer UTF8逐字节分片，不改stream编码或回调Buffer引用', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'utf8-split')
  const stdout = '中文🦞split结束', stderr = '错误🧪保留'
  const source = `for(const [stream,text]of [[process.stdout,${JSON.stringify(stdout)}],[process.stderr,${JSON.stringify(stderr)}]])for(const byte of Buffer.from(text)){stream.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,4))}`
  const result = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), [f.source(source)], f.options({ encoding: 'buffer' }))
  await f.children[0].closed
  assert.equal(result.error, null); assert.ok(Buffer.isBuffer(result.stdout)); assert.ok(Buffer.isBuffer(result.stderr))
  assert.equal(result.child.stdout.readableEncoding, null); assert.equal(result.stdout.toString('utf8'), stdout); assert.equal(result.stderr.toString('utf8'), stderr)
  const [, event] = lifecycle(f.events, result.child.pid)
  assert.equal(event.stdout, stdout); assert.equal(event.stderr, stderr); assert.doesNotMatch(event.stdout + event.stderr, /\uFFFD/)
})

test('exec观察：每流1MiB有界，不缩小原maxBuffer和应用输出；原生maxBuffer错误也原样保留', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'bounded-output')
  const args = [f.source(`process.stdout.write('x'.repeat(${limit + 65536}));process.stderr.write('stderr preserved')`)]
  const result = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), args, f.options({ maxBuffer: 4 * limit }))
  await f.children[0].closed
  assert.equal(result.error, null); assert.equal(result.stdout.length, limit + 65536); assert.equal(result.stderr, 'stderr preserved')
  const [, observed] = lifecycle(f.events, result.child.pid)
  assert.equal(Buffer.byteLength(observed.stdout), limit); assert.equal(observed.stdoutTruncated, true); assert.equal(observed.stderr, result.stderr)
  for (const event of f.events) for (const key of ['stdout', 'stderr']) if (event[key] !== undefined) assert.ok(Buffer.byteLength(event[key]) <= limit)
  const opts = f.options({ maxBuffer: limit }), [native, actual] = await Promise.all([f.run(execFile, args, opts), f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), args, opts)])
  await Promise.all(f.children.map(row => row.closed))
  assert.equal(actual.error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'); assert.deepEqual(fields(actual.error), fields(native.error)); assert.equal(actual.stdout, native.stdout)
  assert.deepEqual(lifecycle(f.events, actual.child.pid)[1].error, fields(actual.error))
})

test('exec观察：不输出options/env/message/cmd，已知凭据在argv和双流脱敏且原回调不改', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'redaction')
  const secret = 'SYNTHETIC_PRIVATE_EXEC_7b923', envOnly = 'SYNTHETIC_ENV_NEVER_DISPLAY_84cf'
  const args = [f.source("const value=process.argv.at(-1);process.stdout.write('Bearer '+value);process.stderr.write('token='+value);process.exitCode=7"), '--api-key', secret]
  const opts = Object.freeze(f.options({ env: Object.freeze({ ...f.options().env, SYNTHETIC_ENV: envOnly }) }))
  const result = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row), secrets: [secret] }), args, opts)
  await f.children[0].closed
  assert.equal(result.stdout, 'Bearer ' + secret); assert.equal(result.stderr, 'token=' + secret)
  const json = JSON.stringify(f.events)
  assert.ok(!json.includes(secret)); assert.ok(!json.includes(envOnly)); assert.ok(!json.includes('SYNTHETIC_ENV'))
  for (const event of f.events) { assert.equal('options' in event, false); assert.equal('env' in event, false); if(event.error){assert.equal('message' in event.error,false); assert.equal('cmd' in event.error,false)} }
  assert.deepEqual(lifecycle(f.events, result.child.pid)[1].error, fields(result.error))
})

test('exec观察：脱敏器错误不泄漏raw数据、不改变应用成功；sync原验证错误和ENOENT保持', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'redactor-and-errors')
  const result = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row), redact(){throw Error('redactor failed')} }), [f.source("process.stdout.write('application original')")])
  assert.equal(result.error, null); assert.equal(result.stdout, 'application original'); assert.equal(f.events.length, 0)
  const wrapped = createHermesExecFileObserver(execFile, { write: row => f.events.push(row) })
  let nativeError; try { execFile(process.execPath, [], { timeout: -1 }) } catch(error) { nativeError=error }
  assert.throws(() => wrapped(process.execPath, [], { timeout: -1 }), error => error.code === nativeError.code && error.message === nativeError.message)
  await new Promise(resolve => {
    const child = f.remember(wrapped(path.join(f.dir, 'absent-owned-executable'), [], f.options(), function(error, stdout, stderr){assert.equal(error.code,'ENOENT');assert.equal(stdout,'');assert.equal(stderr,'');resolve()})); child.stdin?.end()
  })
  await Promise.all(f.children.map(row => row.closed))
  const enoent = f.events.find(row => row.event === 'execFile-result' && row.error?.code === 'ENOENT')
  assert.ok(enoent); assert.equal(enoent.error.killed, undefined)
})

test('exec观察：AbortSignal只传递、不重试，error/close信号字段不替换', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'abort')
  const controller = new AbortController(), opts = f.options({ signal: controller.signal }), args = [f.source("process.stdout.write('abort ready');setInterval(()=>{},1000)")]
  let nativeError, calls = 0
  const delegate = function(...actual){calls++;assert.equal(actual[2],opts);const cb=actual[3];actual[3]=function(...values){nativeError=values[0];return Reflect.apply(cb,this,values)};return Reflect.apply(execFile,this,actual)}
  const pending = f.run(createHermesExecFileObserver(delegate,{write:row=>f.events.push(row)}),args,opts)
  await new Promise(resolve => f.children[0].child.stdout.once('data',resolve));controller.abort()
  const result = await pending;await f.children[0].closed
  assert.equal(calls,1);assert.equal(result.error,nativeError);assert.equal(result.error.code,'ABORT_ERR')
  const [, observed, close] = lifecycle(f.events,result.child.pid)
  assert.deepEqual(observed.error,fields(result.error));assert.equal(close.signal,result.child.signalCode);assert.equal(close.killed,result.child.killed)
})

test('exec观察：function.toString在独立JS上下文可嵌入，只需Node全局Buffer和注入execFile/write', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'inline-source')
  const factory = vm.runInNewContext('(' + createHermesExecFileObserver.toString() + ')', { Buffer })
  const observed = factory(execFile, { write: row => f.events.push(row) })
  const result = await f.run(observed, [f.source("process.stdout.write('inline out');process.stderr.write('inline err');process.exitCode=7")])
  await f.children[0].closed
  assert.equal(result.error.code,7);assert.equal(result.stdout,'inline out');assert.equal(result.stderr,'inline err')
  const [, event]=lifecycle(f.events,result.child.pid);assert.equal(event.error.code,7);assert.equal(event.stdout,result.stdout)
})

test('exec观察：凭据flag的独立后继值默认脱敏，不依赖读取env或调用者提供secret表', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'credential-flags')
  const value = 'SYNTHETIC_ARG_ONLY_f03c1'
  const args = [f.source("process.stdout.write('no credential output')"), '--api-key', value, '--token=' + value]
  const result = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), args)
  await f.children[0].closed
  assert.equal(result.error,null);assert.equal(result.stdout,'no credential output');assert.ok(!JSON.stringify(f.events).includes(value))
  assert.equal(args[2],value);assert.equal(args[3],'--token='+value)
})

test('exec观察：应用callback随后修改error不污染close中原error字段', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'error-original-fields')
  await new Promise(resolve => {
    const child = f.remember(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) })(process.execPath,[f.source("process.stdout.write('out');process.stderr.write('err');process.exitCode=7")],f.options(),function(error){assert.equal(error.code,7);error.code='application-mutated';error.killed='application-mutated';resolve()}));child.stdin.end()
  })
  await f.children[0].closed
  const [, result, close] = lifecycle(f.events,f.children[0].child.pid)
  assert.equal(result.error.code,7);assert.equal(close.error.code,7);assert.equal(close.error.killed,false);assert.equal(close.code,7)
})

test('exec观察：argv/options访问器只由原execFile消费，不为记录再读getter', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'accessor-contract')
  const file = f.source("process.stdout.write(process.argv.at(-1))")
  const counts = []
  for (const fn of [execFile, createHermesExecFileObserver(execFile, { write: row => f.events.push(row) })]) {
    const seen = { argument: 0, timeout: 0, env: 0 }, args = [file, 'argument'], baseOptions = f.options()
    Object.defineProperty(args, 1, { enumerable: true, get(){seen.argument++;return 'argument'} })
    const opts = { windowsHide: true, get timeout(){seen.timeout++;return 15000}, get env(){seen.env++;return baseOptions.env} }
    const result = await f.run(fn, args, opts)
    assert.equal(result.error,null);assert.equal(result.stdout,'argument');counts.push(seen)
  }
  assert.deepEqual(counts[1],counts[0])
})

test('exec观察：ENOENT syscall包含program时同样脱敏，原Error字段不改', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'syscall-redaction')
  const secret = 'SYNTHETIC_PROGRAM_CREDENTIAL_d619'
  let originalError
  await new Promise(resolve => {
    f.remember(createHermesExecFileObserver(execFile, { write: row => f.events.push(row), secrets: [secret] })(path.join(f.dir, secret + '.exe'), [], f.options(), error => { originalError = error; resolve() }))
  })
  await f.children[0].closed
  assert.equal(originalError.code,'ENOENT');assert.ok(originalError.syscall.includes(secret));assert.ok(!JSON.stringify(f.events).includes(secret))
})

function assertStreamTiming(rows, stream, bytes) {
  for (const row of rows.slice(1)) {
    const timing = row.streamTiming?.[stream]
    assert.ok(timing, stream + '缺首末块UTC/bytecount')
    assert.equal(timing.bytes, bytes)
    if (!bytes) { assert.equal(timing.firstChunkUtc, null); assert.equal(timing.lastChunkUtc, null) }
    else {
      assert.match(timing.firstChunkUtc, /^\d{4}-\d\d-\d\dT.*Z$/); assert.match(timing.lastChunkUtc, /^\d{4}-\d\d-\d\dT.*Z$/)
      assert.ok(timing.firstChunkUtc >= rows[0].utc && timing.firstChunkUtc <= timing.lastChunkUtc && timing.lastChunkUtc <= row.utc)
    }
  }
}

test('stream timing first red E2E：真实UTF8逐字节双流，只增首末UTC与实际bytecount，结果不变', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'timing-utf8')
  const stdout = '中文🦞分片', stderr = '错误🧪保留'
  const source = `for(const [stream,text]of [[process.stdout,${JSON.stringify(stdout)}],[process.stderr,${JSON.stringify(stderr)}]])for(const byte of Buffer.from(text)){stream.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,5))}`
  const actual = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), [f.source(source)], f.options({ encoding: 'buffer' }))
  await f.children[0].closed
  assert.equal(actual.error, null); assert.equal(actual.stdout.toString(), stdout); assert.equal(actual.stderr.toString(), stderr)
  assert.equal(actual.child.stdout.readableEncoding, null); assert.equal(actual.child.stderr.readableEncoding, null)
  const rows = lifecycle(f.events, actual.child.pid)
  assertStreamTiming(rows, 'stdout', Buffer.byteLength(stdout)); assertStreamTiming(rows, 'stderr', Buffer.byteLength(stderr))
  assert.ok(rows[1].streamTiming.stdout.firstChunkUtc < rows[1].streamTiming.stdout.lastChunkUtc)
  assert.deepEqual(rows[1].streamTiming, rows[2].streamTiming)
  assert.deepEqual(Object.keys(rows[1].streamTiming).sort(), ['stderr', 'stdout'])
  assert.deepEqual(Object.keys(rows[1].streamTiming.stdout).sort(), ['bytes', 'firstChunkUtc', 'lastChunkUtc'])
})

test('stream timing E2E：真实空流与exit7保留null边界、error与两流，观察失败仍不改应用', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'timing-empty-exit7')
  for (const code of [0, 7]) {
    const actual = await f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), [f.source(`process.exitCode=${code}`)])
    await f.children.at(-1).closed
    assert.equal(actual.error?.code ?? 0, code); assert.equal(actual.stdout, ''); assert.equal(actual.stderr, '')
    const rows = lifecycle(f.events, actual.child.pid); assertStreamTiming(rows, 'stdout', 0); assertStreamTiming(rows, 'stderr', 0)
    assert.deepEqual(rows[1].error, fields(actual.error)); assert.equal(rows[2].code, code)
  }
})

test('stream timing E2E：真实own Node先exit，应用暂缓读取使pipe迟close，最后块不丢', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'timing-late-close')
  const source = "process.stdout.write('early 首流');process.stderr.write('late 尾流');process.exitCode=7"
  let exitSeen = false, tailAfterExit = false
  const actualPromise = f.run(createHermesExecFileObserver(execFile, { write: row => f.events.push(row) }), [f.source(source)])
  const child = f.children[0].child
  // 应用而非观察器控制读取；真实exit与close分离，不造ChildProcess事件。
  child.stdout.pause(); child.stderr.pause()
  child.once('exit', () => { exitSeen = true; setTimeout(() => { child.stdout.resume(); child.stderr.resume() }, 100); assert.equal(f.events.some(e => e.event === 'execFile-close'), false) })
  child.stderr.on('data', () => { if (exitSeen) tailAfterExit = true })
  const actual = await actualPromise; await f.children[0].closed
  assert.equal(tailAfterExit, true); assert.equal(actual.error.code, 7); assert.equal(actual.stdout, 'early 首流'); assert.equal(actual.stderr, 'late 尾流')
  const rows = lifecycle(f.events, child.pid)
  assertStreamTiming(rows, 'stdout', Buffer.byteLength(actual.stdout)); assertStreamTiming(rows, 'stderr', Buffer.byteLength(actual.stderr))
  assert.equal(rows[2].stderr, actual.stderr); assert.deepEqual(rows[1].streamTiming, rows[2].streamTiming)
})

test('stream timing E2E：原1MiB文本上限不变，总bytes覆盖超限实际流；写入副本不污染close', async t => {
  const { createHermesExecFileObserver } = await load(), f = fixture(t, 'timing-limit')
  const observed = createHermesExecFileObserver(execFile, { write: row => { f.events.push(structuredClone(row)); if (row.streamTiming) row.streamTiming.stdout.bytes = -999 } })
  const actual = await f.run(observed, [f.source(`process.stdout.write('x'.repeat(${limit + 65536}));process.stderr.write('tail')`)], f.options({ maxBuffer: 4 * limit }))
  await f.children[0].closed; assert.equal(actual.error, null); assert.equal(actual.stdout.length, limit + 65536)
  const rows = lifecycle(f.events, actual.child.pid); assertStreamTiming(rows, 'stdout', limit + 65536); assertStreamTiming(rows, 'stderr', 4)
  assert.equal(Buffer.byteLength(rows[1].stdout), limit); assert.equal(rows[1].stdoutTruncated, true); assert.deepEqual(rows[1].streamTiming, rows[2].streamTiming)
})
