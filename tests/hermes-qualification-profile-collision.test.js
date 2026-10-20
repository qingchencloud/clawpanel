// 失败清单先行：本机伪 proof、错误 pin/派生回执、查询不明、占名/注册竞争、危险任务、
// 任务/文件/历史被改、非 policy 错误/无 toast、清理身份变化、清理后 CRUD 失败，均保留现场。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
const load = () => import('../scripts/hermes-qualification-profile-collision.mjs')
const sha = x => crypto.createHash('sha256').update(x).digest('hex')
const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
function fixture(t, fault, version = '0.22.2', tempBase = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tempBase), 'hermes-collision-owned-'))
  const home = path.join(root, 'h'), output = path.join(root, 'output')
  fs.mkdirSync(path.join(home, '.hermes/hermes-agent'), { recursive: true })
  fs.writeFileSync(path.join(home, 'python.exe'), 'fixture-not-executable')
  fs.writeFileSync(path.join(root, 'foreign-python.exe'), 'fixture-not-executable')
  t.after(() => {
    if (process.env.HERMES_COLLISION_TEST_EVIDENCE && fs.existsSync(output)) {
      const target = path.join(process.env.HERMES_COLLISION_TEST_EVIDENCE, fault || version)
      fs.mkdirSync(target, { recursive: true }); fs.cpSync(output, target, { recursive: true })
    }
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const taskMap = new Map(), profiles = new Set(['default']), calls = [], deletes = []
  let modal, text, toast = '', attempted = false, taskReads = 0
  const dir = n => path.join(home, '.hermes/profiles', n)
  const ipc = async (cmd, a = {}) => {
    calls.push({ cmd, ...a })
    if (cmd === 'hermes_profiles_list') return { active: 'default', profiles: fault === 'missing-default' ? [] : [...profiles].map(name => ({ name })) }
    if (cmd === 'hermes_sessions_list') return [{ id: 'fixture-history', messages: fault === 'history-loss' && attempted ? 0 : 2 }]
    assert.equal(cmd, 'hermes_dashboard_api_proxy')
    const body = a.body ? JSON.parse(a.body) : {}
    if (a.method === 'GET') return [...profiles].map(name => ({ name }))
    if (a.method === 'POST') {
      profiles.add(body.name); fs.mkdirSync(dir(body.name), { recursive: true })
      for (const f of ['config.yaml', 'memories.md', 'history.db']) fs.writeFileSync(path.join(dir(body.name), f), 'fixture-owned-' + f)
      return { ok: true, name: body.name, path: dir(body.name) }
    }
    const name = a.path.split('/').at(-1), collision = taskMap.has('original-' + name)
    if (collision) {
      attempted = true
      if (fault === 'file-loss') fs.writeFileSync(path.join(dir(name), 'config.yaml'), 'changed')
      if (fault === 'task-loss') taskMap.delete('original-' + name)
      if (fault === 'task-change') taskMap.get('original-' + name).sha256 = 'b'.repeat(64)
      if (fault === 'executed') taskMap.get('original-' + name).lastRunTime = 'now'
      if (fault === 'foreign-loss') fs.writeFileSync(taskMap.get('original-' + name).action, 'foreign changed')
      if (version === '0.22.2' && fault !== 'unguarded') throw new Error(fault === 'unrelated-error' ? 'connection lost' : 'private profile mutation blocked by external Windows task/query: original-' + name)
    } else if (fault === 'normal-crud') throw new Error('CRUD unavailable')
    if (a.method === 'PATCH') { fs.renameSync(dir(name), dir(body.new_name)); profiles.delete(name); profiles.add(body.new_name); return { ok: true, name: body.new_name } }
    if (a.method === 'DELETE') { fs.rmSync(dir(name), { recursive: true }); profiles.delete(name); return { ok: true, identity_settled: true } }
    throw new Error('unexpected method')
  }
  const window = { __TAURI_INTERNALS__: { invoke: ipc } }
  const client = {
    script: async (code, args = []) => {
      if (code.includes('__HERMES_COLLISION_TAP__')) return new Function('window', 'argv', `return (function(){${code}}).apply(null,argv)`)(window, args)
      if (code.includes('toast.error')) return fault === 'no-toast' ? '' : toast
      if (code.includes('lazy-deps-card-title')) return fault === 'no-card-after' && attempted ? [] : [...profiles]
      return true
    },
    element: async s => s,
    command: async (_method, route, body) => {
      if (route.endsWith('/clear')) { text = ''; return }
      if (route.endsWith('/value')) { text = body.text; return }
      if (route.includes('data-name=')) {
        modal = { action: /data-action="(rename|delete)"/.exec(route)?.[1], name: /data-name="([^"]+)"/.exec(route)?.[1] }; return
      }
      if (route.includes('confirm')) {
        toast = ''
        try { await window.__TAURI_INTERNALS__.invoke('hermes_dashboard_api_proxy', { method: modal.action === 'rename' ? 'PATCH' : 'DELETE', path: '/api/profiles/' + modal.name, body: modal.action === 'rename' ? JSON.stringify({ new_name: text }) : null }) }
        catch (e) { toast = e.message }
      }
    },
    screenshot: async f => fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a00000001', 'hex')),
  }
  const tasks = {
    read: async name => {
      taskReads++
      if (!attempted && fault === 'unknown') return { state: 'unknown', hresult: '0x80070005' }
      if (!attempted && fault === 'occupied') return { state: 'exists' }
      const v = taskMap.get(name)
      return v ? { ...v } : { state: 'missing', hresult: '0x80070002' }
    },
    create: async spec => {
      if (fault === 'register-race') throw new Error('TASK_CREATE conflict')
      const row = { state: 'exists', name: spec.name, marker: spec.marker, sha256: sha(JSON.stringify(spec)), enabled: false, triggers: 0, userId: spec.sid, runLevel: 0, logonType: 3, lastRunTime: 'never', lastTaskResult: fault === 'initial-run' ? 0 : 0x41303, action: spec.script }
      if (fault === 'enabled') row.enabled = true
      if (fault === 'highest') row.runLevel = 1
      if (fault === 'SYSTEM') row.userId = 'S-1-5-18'
      if (fault === 'trigger') row.triggers = 1
      taskMap.set(spec.name, row)
    },
    remove: async spec => {
      if (fault === 'cleanup-identity') throw new Error('ownership changed; preserved')
      assert.equal(taskMap.get(spec.name).sha256, spec.sha256); deletes.push(spec.name); taskMap.delete(spec.name)
    },
  }
  const options = { home, output, ipc, client, version, expectedCommit: version === '0.22.2' ? pin : 'f97608f178d1ffeca59860195ab7da295f7c8e5f', timeoutMs: 30, pollMs: 1,
    proof: { runId: '123', attempt: '1', sid: 'S-1-5-21-1-2-3-1001' },
    deriveTaskName: async ({ profile, profileHome, sourceCommit }) => ({ taskName: 'original-' + profile, profileHome: fault === 'derive-home' ? home : profileHome, sourceCommit: fault === 'derive-pin' ? '0'.repeat(40) : sourceCommit, method: fault === 'derive-method' ? 'guessed' : 'original-get_task_name', python: fault === 'derive-python' ? path.join(root, 'foreign-python.exe') : path.join(home, 'python.exe') }),
  }
  return { options, deps: { tasks }, calls, deletes, taskMap, taskReads: () => taskReads }
}
test('production admission rejects local machine before tasks/files, even with forged proof/deps', async () => {
  const { qualifyHermesProfileCollision } = await load()
  if (process.env.GITHUB_ACTIONS === 'true' && process.platform === 'win32') return
  let called = false
  await assert.rejects(() => qualifyHermesProfileCollision({ proof: { passed: true }, deriveTaskName: () => { called = true } }), /门禁|Windows/)
  assert.equal(called, false)
})
for (const version of ['0.22.2', '0.21.5']) test('isolated flow ' + version + ' is never production qualification', async t => {
  const f = fixture(t, null, version), { runProfileCollisionFixture } = await load()
  const r = await runProfileCollisionFixture(f.options, f.deps)
  assert.equal(r.status, 'passed-fixture', JSON.stringify(r.errors))
  assert.equal(r.cases.length, 2); assert.equal(f.deletes.length, 2); assert.equal(f.taskMap.size, 0)
  assert.ok(r.cases.every(c => c.executionCount === 0 && c.normalCrudPassed))
  assert.ok(r.cases.every(c => c.priorTask?.state === 'missing' && c.priorTask.hresult === '0x80070002'), '须落盘注册前权威 absent 回执')
})
test('temp根经目录alias仍以物理路径构建fixture，旧新runtime都不放宽产品链接防护', async t => {
  const base = fs.realpathSync(os.tmpdir()), outer = fs.mkdtempSync(path.join(base, 'hermes-collision-alias-owned-'))
  const target = path.join(outer, 'physical'), alias = path.join(outer, 'alias')
  fs.mkdirSync(target); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => {
    const actual = fs.realpathSync(outer), relative = path.relative(base, actual)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('hermes-collision-alias-owned-'))
    assert.equal(fs.realpathSync(alias), fs.realpathSync(target))
    fs.rmSync(actual, { recursive: true, force: true })
  })
  for (const version of ['0.22.2', '0.21.5']) await t.test(version, async child => {
    const f = fixture(child, null, version, alias), { runProfileCollisionFixture } = await load()
    const result = await runProfileCollisionFixture(f.options, f.deps)
    assert.equal(result.status, 'passed-fixture', JSON.stringify(result.errors))
    assert.equal(f.options.home, fs.realpathSync(f.options.home), '仅规范fixture temp root，产品拒绝链接规则不变')
  })
})
for (const fault of ['unknown', 'occupied', 'register-race', 'enabled', 'highest', 'SYSTEM', 'trigger', 'initial-run', 'missing-default', 'derive-pin', 'derive-home', 'derive-method', 'derive-python', 'unguarded', 'file-loss', 'history-loss', 'foreign-loss', 'no-card-after', 'task-loss', 'task-change', 'executed', 'unrelated-error', 'no-toast', 'cleanup-identity', 'normal-crud']) {
  test('fail closed and preserve scene: ' + fault, async t => {
    const f = fixture(t, fault), { runProfileCollisionFixture } = await load()
    const r = await runProfileCollisionFixture(f.options, f.deps)
    assert.equal(r.status, 'failed'); assert.ok(r.errors.length)
    if (!['normal-crud'].includes(fault)) assert.equal(f.deletes.length, 0, '失败不得清理/修复任务追绿')
  })
}
test('wrong fixed version/pin rejects before task reads', async t => {
  const f = fixture(t), { runProfileCollisionFixture } = await load(); f.options.expectedCommit = '0'.repeat(40)
  await assert.rejects(() => runProfileCollisionFixture(f.options, f.deps), /pin/); assert.equal(f.taskReads(), 0)
})
test('unknown version with omitted pin is not a valid fixed-source mode', async t => {
  const f = fixture(t), { runProfileCollisionFixture } = await load(); f.options.version = '0.99.0'; delete f.options.expectedCommit
  await assert.rejects(() => runProfileCollisionFixture(f.options, f.deps), /pin/); assert.equal(f.taskReads(), 0)
})
test('task backend source is create-only least-privilege/no-trigger and exact GetTask missing', async () => {
  const { scheduledTaskOperationSource } = await load()
  const src = scheduledTaskOperationSource({ operation: 'create', name: 'example', marker: 'm', sid: 's', script: 'f' })
  assert.match(src, /RegisterTaskDefinition\(\$p.name,\$d,2,/)
  assert.match(src, /RunLevel=0/); assert.match(src, /Enabled=\$false/); assert.match(src, /AllowDemandStart=\$false/)
  assert.match(src, /80070002/); assert.doesNotMatch(src, /Triggers\.Create|\.Run\(/)
  const remove = scheduledTaskOperationSource({ operation: 'remove', name: 'example', marker: 'm', sha256: 'a'.repeat(64) })
  assert.ok(remove.indexOf('ownership mismatch') < remove.indexOf('DeleteTask('))
})
