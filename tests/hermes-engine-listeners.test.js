import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = globalThis.window || { location: { hostname: '127.0.0.1' } }
globalThis.localStorage = globalThis.localStorage || {
  getItem() { return null },
  setItem() {},
}

test('Hermes 引擎状态监听注册和取消不会引用不存在的监听数组', async () => {
  const { default: hermesEngine } = await import('../src/engines/hermes/index.js')

  let stateUnsub
  let readyUnsub
  assert.doesNotThrow(() => {
    stateUnsub = hermesEngine.onStateChange(() => {})
    readyUnsub = hermesEngine.onReadyChange(() => {})
  })

  assert.equal(typeof stateUnsub, 'function')
  assert.equal(typeof readyUnsub, 'function')
  assert.doesNotThrow(() => {
    stateUnsub()
    readyUnsub()
  })
})
