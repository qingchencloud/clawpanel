// 失败先行：隐式 HOME、越界/缺失模块、伪 site-packages、目录链接/循环、预算耗尽、
// 源码/凭据内容读取、写入和进程执行，以及把文件名 tag 或统计完成误报为资格通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const moduleUrl = new URL('../scripts/hermes-python-cache-observation.mjs', import.meta.url)
const load = () => import(moduleUrl.href)

function fixture(t) {
  // macOS /var 和 Windows RUNNER~1 都先归一化；普通 realpath 在 Windows 会保留 8.3 别名。
  const parent = fs.realpathSync.native(os.tmpdir())
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'hermes-pyc-observer-')))
  const home = path.join(root, 'h')
  const site = path.join(home, '.hermes', 'runtime', 'Lib', 'site-packages')
  const modulePath = path.join(site, 'fastapi', '__init__.py')
  fs.mkdirSync(path.dirname(modulePath), { recursive: true })
  fs.writeFileSync(modulePath, 'SOURCE_CONTENT_MUST_NOT_BE_READ')
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(root)), parent)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const put = (relative, content = 'PRIVATE_CONTENT_MUST_NOT_BE_READ') => {
    const file = path.join(site, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }
  return { root, home, site, modulePath, put }
}

function nonQualifying(r) {
  assert.equal(r.qualificationPassed, false)
  assert.equal(r.pythonExecuted, false)
  assert.equal(r.interpreterCacheTagVerified, false)
  assert.equal(r.cacheTagsSource, 'filenames-only-not-interpreter-cache-tag')
  assert.notEqual(r.status, 'passed')
}

test('临时样本向观察器提供 native 物理路径，不保留 Windows 8.3 祖先别名', t => {
  const f = fixture(t)
  for (const file of [f.root, f.home, f.modulePath]) {
    assert.equal(path.relative(fs.realpathSync.native(file), file), '', 'fixture 必须与观察器使用相同的 native 物理路径')
  }
})

test('真实私有目录聚合 py/pyc，tag 仅来自缓存文件名，不泄漏文件列表或源码', async t => {
  const f = fixture(t)
  f.put('fastapi/routing.py')
  f.put('fastapi/__pycache__/__init__.cpython-313.pyc')
  f.put('fastapi/__pycache__/routing.cpython-313.opt-1.pyc')
  f.put('fastapi/__pycache__/routing.cpython-313t.pyc')
  f.put('legacy.pyc')
  f.put('secret.env', 'TOKEN=DO_NOT_READ_OR_RETURN')
  f.put('fastapi/__pycache__/private.account-name.pyc')
  const { observeHermesPythonCache } = await load()
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath] })
  assert.equal(r.status, 'complete')
  assert.equal(r.rootsObserved, 1)
  assert.deepEqual(r.counts, { files: 8, directories: 3, entries: 10, py: 2, pyc: 5 })
  assert.deepEqual(r.cacheTags, ['cpython-313', 'cpython-313t'])
  nonQualifying(r)
  const json = JSON.stringify(r)
  for (const privateValue of [f.home, f.modulePath, 'fastapi', 'secret.env', 'account-name', 'DO_NOT_READ', 'SOURCE_CONTENT', 'TOKEN=']) assert.ok(!json.includes(privateValue), privateValue)
  assert.equal(r.reason, null)
})

test('同一 site-packages 多个已核模块去重，不把 venv 目录当解释器身份', async t => {
  const f = fixture(t), second = f.put('pydantic/__init__.py')
  const { observeHermesPythonCache } = await load()
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath, second, f.modulePath] })
  assert.equal(r.status, 'complete')
  assert.equal(r.rootsObserved, 1)
  assert.equal(r.counts.py, 2)
  assert.deepEqual(r.cacheTags, [])
  nonQualifying(r)
})

test('两个真实私有 site-packages 只聚合，不返回路径', async t => {
  const f = fixture(t), second = path.join(f.home, 'store', 'lib', 'python3.12', 'site-packages', 'other', '__init__.py')
  fs.mkdirSync(path.dirname(second), { recursive: true }); fs.writeFileSync(second, 'not read')
  const { observeHermesPythonCache } = await load()
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath, second] })
  assert.equal(r.status, 'complete'); assert.equal(r.rootsObserved, 2); assert.equal(r.counts.py, 2)
  assert.ok(!JSON.stringify(r).includes('python3.12'))
})

test('嵌套 site-packages 只扫描覆盖它的外层根，不重复计数', async t => {
  const f = fixture(t), second = f.put('vendor/site-packages/inside/module.py')
  const { observeHermesPythonCache } = await load()
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [second, f.modulePath] })
  assert.equal(r.status, 'complete'); assert.equal(r.rootsObserved, 1); assert.equal(r.counts.py, 2)
})

test('参数缺失/相对路径/空模块/过多输入不推断环境 HOME', async t => {
  const f = fixture(t), { observeHermesPythonCache } = await load()
  for (const input of [undefined, {}, { home: f.home }, { home: '.', modulePaths: [f.modulePath] }, { home: f.home, modulePaths: [] }, { home: f.home, modulePaths: ['relative.py'] }, { home: f.home, modulePaths: Array(17).fill(f.modulePath) }]) {
    const r = observeHermesPythonCache(input)
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'invalid-input'); nonQualifying(r)
  }
})

test('真实模块位于 HOME 同前缀兄弟目录仍拒绝', async t => {
  const f = fixture(t), foreign = path.join(f.root, 'h-foreign', 'site-packages', 'outside.py')
  fs.mkdirSync(path.dirname(foreign), { recursive: true }); fs.writeFileSync(foreign, 'foreign')
  const { observeHermesPythonCache } = await load(), r = observeHermesPythonCache({ home: f.home, modulePaths: [foreign] })
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'module-outside-home'); assert.equal(r.counts.files, 0)
})

test('缺失模块、普通非模块目录和没有精确 site-packages 祖先均拒绝', async t => {
  const f = fixture(t), other = path.join(f.home, 'site-packages-old', 'module.py')
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, 'not read')
  const { observeHermesPythonCache } = await load()
  for (const [p, reason] of [[path.join(f.site, 'missing.py'), 'metadata-unavailable'], [f.site, 'module-not-file'], [other, 'site-packages-not-found']]) {
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [p] })
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, reason)
  }
})

test('真实 junction/symlink HOME 别名拒绝，不把 realpath 后的外部目录当受管 HOME', async t => {
  const f = fixture(t), alias = path.join(f.root, 'home-link')
  fs.symlinkSync(f.home, alias, 'junction')
  const { observeHermesPythonCache } = await load(), r = observeHermesPythonCache({ home: alias, modulePaths: [path.join(alias, path.relative(f.home, f.modulePath))] })
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'linked-path')
})

test('已核模块路径的祖先是真实外部 junction 时拒绝，零外部递归', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside', 'site-packages'), alias = path.join(f.home, 'foreign-link')
  fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'module.py'), 'foreign')
  fs.symlinkSync(path.dirname(outside), alias, 'junction')
  const { observeHermesPythonCache } = await load(), r = observeHermesPythonCache({ home: f.home, modulePaths: [path.join(alias, 'site-packages', 'module.py')] })
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'linked-path'); assert.equal(r.counts.files, 0)
})

test('扫描发现外部链接或内部循环均拒绝，不递归、不算 complete', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'foreign.pyc'), 'foreign')
  const link = path.join(f.site, 'linked')
  const { observeHermesPythonCache } = await load()
  for (const target of [outside, f.site]) {
    fs.symlinkSync(target, link, 'junction')
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath] })
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'linked-entry'); assert.equal(r.counts.pyc, 0)
    fs.unlinkSync(link)
  }
})

test('文件/目录/条目/时间预算耗尽明确 incomplete，零预算也不变通过', async t => {
  const f = fixture(t), { observeHermesPythonCache } = await load()
  for (const [limits, reason] of [[{ maxFiles: 0 }, 'file-budget'], [{ maxDirectories: 0 }, 'directory-budget'], [{ maxEntries: 0 }, 'entry-budget'], [{ maxDurationMs: 0 }, 'time-budget']]) {
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits })
    assert.equal(r.status, 'incomplete'); assert.equal(r.reason, reason); nonQualifying(r)
  }
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits: { maxFiles: 1 } })
  assert.equal(r.status, 'complete', '恰好一个文件并扫描到 EOF，不误判超预算')
})

test('预算不得为无限/负值/小数/超硬上限；tag 集合也有界', async t => {
  const f = fixture(t), { observeHermesPythonCache } = await load()
  for (const limits of [{ maxFiles: Infinity }, { maxDurationMs: -1 }, { maxFiles: 0.5 }, { maxFiles: 1000000000 }, { unknown: 1 }]) {
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits })
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'invalid-limits')
  }
  for (const n of [311, 312]) f.put(`fastapi/__pycache__/module.cpython-${n}.pyc`)
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits: { maxCacheTags: 1 } })
  assert.equal(r.status, 'incomplete'); assert.equal(r.reason, 'cache-tag-budget'); assert.equal(r.cacheTags.length, 1)
})

test('真实批量目录的一毫秒时间预算超限返回 incomplete，未扫描部分不宣称完整', async t => {
  const f = fixture(t)
  for (let i = 0; i < 600; i++) f.put(`cache/file${i}.pyc`)
  const { observeHermesPythonCache } = await load()
  const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits: { maxDurationMs: 1 } })
  assert.equal(r.status, 'incomplete'); assert.equal(r.reason, 'time-budget'); nonQualifying(r)
  assert.ok(r.counts.pyc < 600)
})

test('opendir 前真实目录被替换成外部 junction，重检后关闭且零外部条目读取', async t => {
  const f = fixture(t), moved = f.site + '.moved', outside = path.join(f.root, 'external')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'foreign.pyc'), 'foreign')
  const { observeHermesPythonCache } = await load(), open = fs.opendirSync
  let swapped = false, reads = 0
  fs.opendirSync = function (p, ...args) {
    if (path.resolve(p) !== path.resolve(f.site)) return open.call(this, p, ...args)
    fs.renameSync(f.site, moved); fs.symlinkSync(outside, f.site, 'junction'); swapped = true
    const dir = open.call(this, p, ...args), read = dir.readSync.bind(dir)
    dir.readSync = () => { reads++; return read() }
    return dir
  }
  try {
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath] })
    assert.equal(swapped, true); assert.equal(reads, 0)
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'linked-path')
  } finally {
    fs.opendirSync = open
    if (swapped) { fs.unlinkSync(f.site); fs.renameSync(moved, f.site) }
  }
})

test('opendir 返回时已超时间预算，也必须关闭刚取得的真实目录句柄', async t => {
  const f = fixture(t), { observeHermesPythonCache } = await load(), open = fs.opendirSync
  let handle, closed = 0
  fs.opendirSync = function (...args) {
    handle = open.apply(this, args)
    const close = handle.closeSync.bind(handle)
    handle.closeSync = () => { closed++; return close() }
    const until = performance.now() + 300
    while (performance.now() < until) { /* 有界地模拟一次慢元数据操作，不读写任何文件。 */ }
    return handle
  }
  try {
    const r = observeHermesPythonCache({ home: f.home, modulePaths: [f.modulePath], limits: { maxDurationMs: 250 } })
    assert.equal(r.status, 'incomplete'); assert.equal(r.reason, 'time-budget')
    assert.ok(handle, '真实目录句柄已取得'); assert.equal(closed, 1, '即使超预算也释放句柄')
  } finally {
    fs.opendirSync = open
    if (handle && !closed) handle.closeSync()
  }
})

test('真实只读权限子进程禁止写/源码凭据读取/Python或CLI执行，无隐式副作用', async t => {
  const f = fixture(t); f.put('fastapi/__pycache__/x.cpython-313.pyc'); f.put('.env', 'SECRET_MUST_NOT_READ')
  await load()
  const before = fs.statSync(f.modulePath).mtimeMs
  const code = `
    import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict';
    const attempts=[];
    for(const name of ['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','rmSync','rm','unlinkSync','unlink','renameSync','rename','chmodSync','utimesSync','copyFileSync','createWriteStream'])fs[name]=()=>{attempts.push(name);throw Error('forbidden-write')};
    for(const name of ['readFileSync','readFile','openSync','open','createReadStream']){const original=fs[name];fs[name]=function(file,...args){if(String(file)===${JSON.stringify(fileURLToPath(moduleUrl))}||String(file)===${JSON.stringify(moduleUrl.href)})return original.call(this,file,...args);attempts.push(name);throw Error('forbidden-content-read')}}
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{attempts.push(name);throw Error('forbidden-process')};
    for(const name of ['readFile','writeFile','appendFile','open','mkdir','rm','unlink','rename','copyFile','chmod','utimes'])fs.promises[name]=()=>{attempts.push('promise-'+name);throw Error('forbidden-promises-io')};
    syncBuiltinESMExports();
    const {observeHermesPythonCache}=await import(${JSON.stringify(moduleUrl.href)});
    const r=observeHermesPythonCache(${JSON.stringify({ home: f.home, modulePaths: [f.modulePath] })});
    assert.equal(r.status,'complete');assert.deepEqual(attempts,[]);assert.equal(process.permission.has('fs.write',${JSON.stringify(f.home)}),false);
    console.log(JSON.stringify(r));
  `
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'SystemDrive', 'OS'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  Object.assign(env, { HOME: f.home, USERPROFILE: f.home, APPDATA: f.home, LOCALAPPDATA: f.home, TMPDIR: f.root, TEMP: f.root, TMP: f.root })
  const child = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${fileURLToPath(moduleUrl)}`, `--allow-fs-read=${f.root}`, '--input-type=module', '-e', code], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  const r = JSON.parse(child.stdout); nonQualifying(r)
  assert.equal(r.counts.py, 1); assert.equal(r.counts.pyc, 1)
  assert.equal(fs.statSync(f.modulePath).mtimeMs, before)
  assert.ok(!child.stdout.includes('SECRET_MUST_NOT_READ'))
})
