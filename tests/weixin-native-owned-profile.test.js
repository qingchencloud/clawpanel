// 失败清单先行：仅自有TEMP/真实NT目录API，不触及KnownFolder、GUI或产品资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let m, importError
try { m = await import('../scripts/weixin-native-owned-profile.mjs') } catch (error) { importError = error }
function api(name) { assert.equal(typeof m?.[name], 'function', `${name}尚未实现：${importError?.code || ''}`); return m[name] }
const options = () => ({ mode: 'component-config-only', env: {} })
const base = () => ({ identifier: 'ai.openclaw.clawpanel', app: { windows: [
  { title: '原窗口', width: 1100, height: 700, resizable: true },
  { label: 'fixture-disabled', create: false, url: 'index.html', width: 200 },
], security: { csp: null }, withGlobalTauri: true }, bundle: { active: true } })
const emit = (name, value) => {
  if (process.env.CLAWPANEL_OWNED_PROFILE_EVIDENCE) {
    const out = path.resolve(process.env.CLAWPANEL_OWNED_PROFILE_EVIDENCE)
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  }
}

test('overlay：完整clone全部windows，原输入/security/identifier不变', () => {
  const b = base(), before = JSON.stringify(b), overlay = api('buildOwnedProfileOverlay')(b, options())
  assert.equal(JSON.stringify(b), before)
  assert.deepEqual(Object.keys(overlay), ['app'])
  assert.deepEqual(Object.keys(overlay.app), ['windows'])
  assert.equal(overlay.app.windows.length, 2)
  for (let i = 0; i < 2; i++) {
    assert.notEqual(overlay.app.windows[i], b.app.windows[i])
    const { additionalBrowserArgs, ...rest } = overlay.app.windows[i]
    assert.equal(additionalBrowserArgs, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1')
    assert.deepEqual(rest, b.app.windows[i])
  }
  assert.equal(api('validateOwnedProfileOverlay')(b, overlay, options()), true)
  emit('overlay-positive.json', { base: b, overlay, originalUnchanged: before === JSON.stringify(b), actualBuild: false })
})
test('overlay真实仓库config只读输入：移除新增args后逐字段相同', () => {
  const file = new URL('../src-tauri/tauri.conf.json', import.meta.url), before = fs.readFileSync(file)
  const original = JSON.parse(before), overlay = api('buildOwnedProfileOverlay')(original, options())
  const recovered = structuredClone(overlay.app.windows)
  for (const w of recovered) delete w.additionalBrowserArgs
  assert.deepEqual(recovered, original.app.windows)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(api('validateOwnedProfileOverlay')(original, overlay, options()), true)
  emit('actual-config-component.json', { original, overlay, sourceConfigUnchanged: true, build: false, qualification: false })
})
for (const [name, change] of [
  ['稀疏丢width', o => { delete o.app.windows[0].width }],
  ['丢第二window', o => { o.app.windows.pop() }],
  ['create变true', o => { o.app.windows[1].create = true }],
  ['额外flags', o => { o.app.windows[0].additionalBrowserArgs += ' --no-sandbox' }],
  ['换port', o => { o.app.windows[0].additionalBrowserArgs = '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1' }],
  ['新增权限', o => { o.app.security = { capabilities: ['foreign'] } }],
  ['换identifier', o => { o.identifier = 'fixture.foreign' }],
]) test('overlay负向：' + name, () => {
  const b = base(), o = api('buildOwnedProfileOverlay')(b, options()); change(o)
  assert.throws(() => api('validateOwnedProfileOverlay')(b, o, options()))
})
for (const mode of ['production', 'diagnostic', '', undefined]) test('overlay拒绝错误mode：' + String(mode), () => {
  const build = api('buildOwnedProfileOverlay')
  assert.throws(() => build(base(), { mode, env: {} }))
})
for (const key of ['TAURI_CONFIG', 'tauri_config', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER', 'WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER']) test('overlay拒绝环境污染：' + key, () => {
  const build = api('buildOwnedProfileOverlay')
  assert.throws(() => build(base(), { ...options(), env: { [key]: 'unexpected' } }))
})
test('overlay拒绝非JSON输入与既有args，绝不覆盖原配置', () => {
  const build = api('buildOwnedProfileOverlay')
  for (const bad of [null, [], { ...base(), invalid: undefined }, { ...base(), invalid: NaN }]) assert.throws(() => build(bad, options()))
  const b = base(); b.app.windows[0].additionalBrowserArgs = 'original'
  assert.throws(() => build(b, options()))
})

test('真实ownTEMP子PS：NT atomic lease正负及同held-handle空目录释放', { skip: process.platform !== 'win32' }, async t => {
  const parentEnvBefore = JSON.stringify(process.env)
  const client = await api('startOwnedProfileFixture')()
  const traces = [], call = async (op, fields = {}) => { const r = await client.request({ op, ...fields }); traces.push({ op, fields, result: r }); return r }
  const parent = async name => { fs.mkdirSync(path.join(client.root, name)); const r = await call('parent', { relative: name }); assert.equal(r.ok, true, JSON.stringify(r)); return r }
  const create = async (p, extra = {}) => call('create', { parent: p.ticket, parentIdentity: p.identity, leaf: 'ai.openclaw.clawpanel', ...extra })
  try {
    await t.test('FILE_CREATED + held volume/fileID + 原句柄empty release真实消失', async () => {
      const p = await parent('case-positive'), r = await create(p); assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.created, true); assert.equal(r.information, 'FILE_CREATED'); assert.match(r.identity, /^[a-f0-9]{8}:[a-f0-9]{16}$/)
      assert.equal(r.nativeStatus, '0x00000000'); assert.equal(r.informationNumber, 2); assert.equal(r.held, true)
      assert.equal(fs.statSync(r.path).isDirectory(), true)
      const done = await call('release', { lease: r.lease, identity: r.identity }); assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.releasedByHeldHandle, true); assert.equal(fs.existsSync(r.path), false)
      assert.equal((await call('release', { lease: r.lease, identity: r.identity })).ok, false, '已释放lease不重放删除')
    })
    for (const marker of [false, true]) await t.test('既存' + (marker ? 'marker' : '空目录') + '拒绝且原件保留', async () => {
      const p = await parent(marker ? 'case-existing-marker' : 'case-existing-empty'), leaf = path.join(p.path, 'ai.openclaw.clawpanel'); fs.mkdirSync(leaf)
      if (marker) fs.writeFileSync(path.join(leaf, 'marker.txt'), 'own marker; preserve')
      const r = await create(p); assert.equal(r.ok, false); assert.match(r.error, /NtCreateFile status=0xc0000035/); assert.equal(fs.existsSync(leaf), true)
      if (marker) assert.equal(fs.readFileSync(path.join(leaf, 'marker.txt'), 'utf8'), 'own marker; preserve')
    })
    await t.test('相似leaf和parent identity矛盾不创建', async () => {
      const p = await parent('case-similar')
      assert.equal((await create(p, { leaf: 'ai.openclaw.clawpanel-other' })).ok, false)
      assert.equal((await create(p, { parentIdentity: '00000000:0000000000000000' })).ok, false)
      assert.deepEqual(fs.readdirSync(p.path), [])
    })
    await t.test('held lease期间另一个真实进程rename拒绝', async () => {
      const p = await parent('case-rename'), r = await create(p); assert.equal(r.ok, true)
      let renameError
      assert.throws(() => { try { fs.renameSync(r.path, r.path + '-moved') } catch (error) { renameError = error; throw error } })
      traces.push({ op: 'own-node-rename', code: renameError.code, errno: renameError.errno, rejected: true })
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(renameError.code))
      assert.equal(fs.existsSync(r.path), true); assert.equal(fs.existsSync(r.path + '-moved'), false)
      assert.equal((await call('release', { lease: r.lease, identity: r.identity })).ok, true)
    })
    await t.test('cleanup identity矛盾/unknown拒绝，不删除目录', async () => {
      const p = await parent('case-identity'), r = await create(p); assert.equal(r.ok, true)
      for (const identity of [undefined, '00000000:0000000000000000']) assert.equal((await call('release', { lease: r.lease, identity })).ok, false)
      assert.equal((await call('release', { lease: 'unknown-lease', identity: r.identity })).ok, false)
      assert.equal(fs.existsSync(r.path), true)
    })
    await t.test('cleanup前新child：内核拒绝非空删除，文件逐字节保留', async () => {
      const p = await parent('case-nonempty'), r = await create(p); assert.equal(r.ok, true)
      const f = path.join(r.path, 'created-by-own-node.txt'); fs.writeFileSync(f, 'DO NOT DELETE AFTER REFUSAL')
      const done = await call('release', { lease: r.lease, identity: r.identity }); assert.equal(done.ok, false)
      assert.match(done.error, /empty held release win32=145/)
      assert.equal(fs.readFileSync(f, 'utf8'), 'DO NOT DELETE AFTER REFUSAL'); assert.equal(fs.existsSync(r.path), true)
    })
    await t.test('同名link和ancestor link拒绝，不跟随/不删target', async () => {
      const target = path.join(client.root, 'own-junction-target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel'), 'keep')
      const p = await parent('case-leaf-link'); fs.symlinkSync(target, path.join(p.path, 'ai.openclaw.clawpanel'), 'junction')
      assert.equal((await create(p)).ok, false)
      fs.symlinkSync(target, path.join(client.root, 'case-ancestor-link'), 'junction')
      assert.equal((await call('parent', { relative: 'case-ancestor-link' })).ok, false)
      assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'keep')
    })
    await t.test('同名dangling junction原子拒绝，绝不创建missing target', async () => {
      const p = await parent('case-dangling-leaf'), target = path.join(client.root, 'owned-missing-target')
      const leaf = path.join(p.path, 'ai.openclaw.clawpanel')
      assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' })
      fs.symlinkSync(target, leaf, 'junction')
      const readLink = () => {
        const stat = fs.lstatSync(leaf, { bigint: true })
        return { symbolicLink: stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino), target: fs.readlinkSync(leaf) }
      }
      const before = { targetExists: fs.existsSync(target), link: readLink(), entries: fs.readdirSync(p.path) }
      assert.equal(before.link.symbolicLink, true)
      const r = await create(p)
      const after = { targetExists: fs.existsSync(target), link: readLink(), entries: fs.readdirSync(p.path) }
      const evidence = { scope: 'ownTEMP dangling leaf only; never cleanup this retained fixture', root: client.root, parent: p, target, before, create: r, after, qualification: false }
      traces.push({ op: 'dangling-leaf-side-effects', ...evidence })
      emit('dangling-leaf-e2e.json', evidence)
      assert.equal(r.ok, false, '既存link必须被拒绝')
      assert.equal(after.targetExists, false, '拒绝前不得跟随dangling link创建target')
      assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' })
      assert.deepEqual(after.link, before.link, '原junction身份与目标字符串不变')
      assert.deepEqual(after.entries, before.entries, '原parent没有新增目录项')
      assert.match(r.error, /NtCreateFile status=0xc000(?:050b|0035)/, '须在NT创建调用中无副作用拒绝，而非事后path contradiction')
    })
    await t.test('parent traversal/相似root/错误协议mode拒绝', async () => {
      for (const relative of ['../similar-root', client.root + '-foreign', 'case-ancestor-link/../case-positive']) assert.equal((await call('parent', { relative })).ok, false)
      assert.equal((await call('production-root')).ok, false)
    })
    await t.test('真实PS入口拒绝production mode，未访问请求root', () => {
      const file = new URL('../scripts/weixin-native-owned-profile.ps1', import.meta.url)
      const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(file), '-Mode', 'production', '-FixtureRoot', path.join(client.root, 'NEVER-CREATED'), '-Nonce', 'a'.repeat(32)], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath')) })
      assert.equal(result.status, 1); assert.match(result.stderr, /component mode\/ABI rejected/); assert.equal(fs.existsSync(path.join(client.root, 'NEVER-CREATED')), false)
      traces.push({ op: 'wrong-mode-own-child', pid: result.pid, status: result.status, stdout: result.stdout, stderr: result.stderr })
    })
  } finally {
    const closed = await client.close()
    emit('native-core-e2e.json', { scope: 'ownTEMP component only; retained negative fixtures not production cleanup', root: client.root, traces, closed, knownFolderQueried: false, gui: false, qualification: false })
    assert.equal(closed.openHandles, 0); assert.equal(closed.exitCode, 0)
    assert.equal(closed.opens, closed.closes); assert.equal(closed.error, undefined)
    assert.equal(closed.scriptBefore, closed.scriptAfter); assert.ok(closed.elapsedMs < closed.timeoutMs)
    assert.equal(closed.timeoutMs, 30000); assert.equal(closed.maxOutputBytes, 16 * 1024 * 1024)
    assert.ok(closed.argvBound <= 32767); assert.ok(closed.outputBytes <= closed.maxOutputBytes)
    assert.equal(path.resolve(closed.componentTempActual), path.resolve(client.root), 'C#编译临时文件也必须在本轮own fixture TEMP')
    assert.equal(JSON.stringify(process.env), parentEnvBefore, '父环境必须原样')
    assert.equal(closed.fixtureRoot, client.root, '异常回执也须保留本轮创建的fixture路径')
  }
})
