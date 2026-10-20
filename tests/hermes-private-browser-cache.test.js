import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 实施前失败清单：import与CLI使用不同cache、旧module cache、异常/并发泄漏、链接越界、browser继承宿主环境。
const load = () => import('../scripts/test-hermes-windows-qualification.mjs')
function fixture() {
  const base = fs.realpathSync.native(os.tmpdir()), home = fs.mkdtempSync(path.join(base, 'hermes-browser-cache-'))
  const cacheDirectory = path.join(home, '.browsers'), moduleFile = path.join(home, 'browser-tools/node_modules/playwright/index.mjs')
  fs.mkdirSync(cacheDirectory); fs.mkdirSync(path.dirname(moduleFile), { recursive: true }); fs.writeFileSync(moduleFile, '// owned fixture, never imported')
  return { home, cacheDirectory, moduleFile, dispose() { assert.equal(path.dirname(fs.realpathSync.native(home)), base); fs.rmSync(home, { recursive: true, force: true }) } }
}
const snapshot = () => ({ present: Object.hasOwn(process.env, 'PLAYWRIGHT_BROWSERS_PATH'), value: process.env.PLAYWRIGHT_BROWSERS_PATH })
const restore = ({ present, value }) => { if (present) process.env.PLAYWRIGHT_BROWSERS_PATH = value; else delete process.env.PLAYWRIGHT_BROWSERS_PATH }

test('异步私有import后原环境立即复原；保持官方默认lookup，不选择宿主browser executable', async () => {
  const { loadQualificationChromium } = await load(); assert.equal(typeof loadQualificationChromium, 'function')
  const f = fixture(), original = snapshot(), before = { ...process.env }
  try {
    let used; const browser = { executablePath: () => path.join(f.cacheDirectory, 'chromium-1223/chrome-win64/chrome.exe') }
    const result = await loadQualificationChromium({ ...f, importer: async url => {
      used = fileURLToPath(url); assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, f.cacheDirectory)
      await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, f.cacheDirectory)
      return { chromium: browser }
    } })
    assert.equal(result, browser); assert.equal(used, f.moduleFile); assert.deepEqual(snapshot(), original); assert.deepEqual({ ...process.env }, before)
  } finally { restore(original); f.dispose() }
})

test('原字段缺失/空值/旧值和import抛错均精确恢复，原异常不转成功', async () => {
  const { loadQualificationChromium } = await load(); assert.equal(typeof loadQualificationChromium, 'function')
  const f = fixture(), original = snapshot()
  try {
    for (const state of [{ present: false }, { present: true, value: '' }, { present: true, value: 'owned-existing-value' }]) {
      restore(state); const failure = new Error('owned import failure')
      await assert.rejects(loadQualificationChromium({ ...f, importer: async () => { throw failure } }), error => error === failure)
      assert.deepEqual(snapshot(), state.present ? state : { present: false, value: undefined })
    }
  } finally { restore(original); f.dispose() }
})

test('提前缓存到宿主的module必须失败，不能默默改executablePath/hostcache或留下env', async () => {
  const { loadQualificationChromium } = await load(); assert.equal(typeof loadQualificationChromium, 'function')
  const f = fixture(), original = snapshot()
  try {
    await assert.rejects(loadQualificationChromium({ ...f, importer: async () => ({ chromium: { executablePath: () => path.join(f.home, 'outside/chrome.exe') } }) }), /cache|private|私有/)
    assert.deepEqual(snapshot(), original)
  } finally { restore(original); f.dispose() }
})

test('并发import拒绝串扰；第一项仍完成和恢复，不扩大共享环境窗口', async () => {
  const { loadQualificationChromium } = await load(); assert.equal(typeof loadQualificationChromium, 'function')
  const f = fixture(), original = snapshot(); let unlock, first
  try {
    first = loadQualificationChromium({ ...f, importer: () => new Promise(resolve => { unlock = () => resolve({ chromium: { executablePath: () => path.join(f.cacheDirectory, 'chromium/chrome.exe') } }) }) })
    await assert.rejects(loadQualificationChromium({ ...f, importer: async () => { throw Error('must not import') } }), /concurrent|并发/)
    unlock(); await first; assert.deepEqual(snapshot(), original)
  } finally { if (unlock) unlock(); await first?.catch(() => {}); restore(original); f.dispose() }
})

test('仅同HOME固定module/cache、祖先链接拒绝，非法输入不执行import', async () => {
  const { loadQualificationChromium } = await load(); assert.equal(typeof loadQualificationChromium, 'function')
  const f = fixture(), original = snapshot(); let imports = 0
  const importer = async () => { imports++; throw Error('must not import') }
  try {
    for (const bad of [{ cacheDirectory: f.home }, { cacheDirectory: 'relative' }, { moduleFile: path.join(f.home, 'other.mjs') }]) await assert.rejects(loadQualificationChromium({ ...f, ...bad, importer }))
    const alias = path.join(f.home, 'alias'); fs.symlinkSync(f.cacheDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try { await assert.rejects(loadQualificationChromium({ ...f, cacheDirectory: alias, importer })) } finally { fs.unlinkSync(alias) }
    assert.equal(imports, 0); assert.deepEqual(snapshot(), original)
  } finally { restore(original); f.dispose() }
})

test('真实harness缓存作用域接线，实际browser子环境不继承runner凭据，不改默认headless/预算', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('await loadQualificationChromium('))
  assert.ok(source.includes('chromium.launch({ headless: true, env })'))
  assert.ok(source.includes("r.browserTooling.defaultRegistryExecutablePath = chromium.executablePath()"))
  assert.ok(source.includes('r.browserTooling.parentEnvironmentRestored ='))
  assert.doesNotMatch(source, /chromium\.launch\([^\n]*(?:channel|executablePath)/)
})
