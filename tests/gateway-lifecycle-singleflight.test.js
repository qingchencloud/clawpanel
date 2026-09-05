import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { runGatewayLifecycleOnce } from '../scripts/dev-api.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('Web 后端应合并同类并发 Gateway 启动请求', async () => {
  const gate = deferred()
  const action = `start:test-${Date.now()}`
  let calls = 0

  const first = runGatewayLifecycleOnce(action, async () => {
    calls += 1
    await gate.promise
    return 'started'
  })
  const second = runGatewayLifecycleOnce(action, async () => {
    calls += 1
    return 'duplicate'
  })

  assert.strictEqual(second, first)
  assert.equal(calls, 0)
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['started', 'started'])
  assert.equal(calls, 1)
})

test('Web 后端应串行执行不同的 Gateway 生命周期操作', async () => {
  const gate = deferred()
  const suffix = Date.now()
  const events = []

  const start = runGatewayLifecycleOnce(`start:serial-${suffix}`, async () => {
    events.push('start-enter')
    await gate.promise
    events.push('start-exit')
  })
  const stop = runGatewayLifecycleOnce(`stop:serial-${suffix}`, async () => {
    events.push('stop-enter')
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['start-enter'])
  gate.resolve()
  await Promise.all([start, stop])
  assert.deepEqual(events, ['start-enter', 'start-exit', 'stop-enter'])
})

test('Web 后端生命周期任务失败后应释放单飞行状态', async () => {
  const action = `start:retry-${Date.now()}`
  await assert.rejects(
    runGatewayLifecycleOnce(action, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )

  const result = await runGatewayLifecycleOnce(action, async () => 'retried')
  assert.equal(result, 'retried')
})

test('桌面后端应串行 Gateway 生命周期操作并把 Windows 启动扫描移出 UI 初始化', () => {
  const source = readFileSync(new URL('../src-tauri/src/commands/service.rs', import.meta.url), 'utf8')
  assert.match(source, /static GATEWAY_LIFECYCLE_LOCK: OnceLock<tokio::sync::Mutex<\(\)>>/)
  assert.match(source, /let _operation = try_gateway_lifecycle_lock\("启动"\)\?/)
  assert.match(source, /let _operation = try_gateway_lifecycle_lock\("停止"\)\?/)
  assert.match(source, /let _operation = try_gateway_lifecycle_lock\("重启"\)\?/)

  const guardian = source.slice(source.indexOf('pub fn start_backend_guardian'))
  const spawnAt = guardian.indexOf('tauri::async_runtime::spawn')
  const cleanupAt = guardian.indexOf('spawn_blocking(platform::cleanup_zombie_gateway_processes)')
  assert.ok(spawnAt >= 0 && cleanupAt > spawnAt, 'Windows 清理必须在异步 guardian 任务内执行')
})
