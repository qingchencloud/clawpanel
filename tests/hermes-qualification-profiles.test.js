import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const load = () => import('../scripts/hermes-qualification-profiles.mjs')
const digest = text => crypto.createHash('sha256').update(text).digest('hex')
const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const tasks = [{ name: '\\OwnedTask', sha256: 'a'.repeat(64) }]
function fixture(t, fault) {
  const base = fs.realpathSync(os.tmpdir()), home = fs.mkdtempSync(path.join(base, 'hermes-profile-qualification-'))
  t.after(() => {
    if (process.env.HERMES_PROFILE_TEST_EVIDENCE && fs.existsSync(path.join(home, 'evidence'))) {
      const destination = path.join(process.env.HERMES_PROFILE_TEST_EVIDENCE, fault || 'happy')
      fs.mkdirSync(destination, { recursive: true })
      fs.cpSync(path.join(home, 'evidence'), destination, { recursive: true })
    }
    const relative = path.relative(base, fs.realpathSync(home)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(home).startsWith('hermes-profile-qualification-'))
    fs.rmSync(home, { recursive: true, force: true })
  })
  const hh = path.join(home, '.hermes'), source = path.join(hh, 'hermes-agent')
  fs.mkdirSync(source, { recursive: true })
  const profiles = [{ name: 'default', provider: 'custom', model: 'fixture-model' }]
  let active = 'default', online = true, modal = '', text = '', selected = '', pid = 100, renamed, transient = 0
  const window = { __TAURI_INTERNALS__: { invoke: async (_cmd, args) => args.fixtureResponse } }
  const receipt = async (method, profile, response) => window.__TAURI_INTERNALS__.invoke('hermes_dashboard_api_proxy', { method, path: '/api/profiles/' + profile, fixtureResponse: response })
  const calls = [], clicks = [], history = { id: 'existing', messages: [{ role: 'user', content: 'private historical text' }] }
  const options = { home, output: path.join(home, 'evidence'), version: '0.22.2', expectedCommit: pin, defaultSessionId: 'existing', provider: 'custom', model: 'fixture-model', cloneFromDefault: true, noSkills: true, gatewayPort: 18791, timeoutMs: 50, pollMs: 1, evidenceKind: 'isolated-fixture',
    taskSnapshot: async () => fault === 'task-permission' ? Promise.reject(new Error('ScheduledTask unavailable')) : tasks,
    runtimeSnapshot: async () => ({ listeners: online ? [{ port: 18791, pid, creationDate: '2026-10-16T01:00:00Z', executablePath: path.join(home, 'python.exe') }] : [] }),
    ipc: async (cmd, args = {}) => {
      calls.push({ cmd, args })
      if (cmd === 'hermes_dashboard_start') return { started: true }
      if (cmd === 'hermes_profiles_list') return { active, profiles }
      if (cmd === 'hermes_profile_use') { active = args.name; return 'ok' }
      if (cmd === 'hermes_session_detail') return fault === 'history' && renamed ? { ...history, messages: [] } : history
      if (cmd === 'hermes_gateway_action') {
        online = args.action === 'start'
        if (online) {
          pid++
          transient = fault === 'transient-health' ? 1 : 0
          if (active !== 'default') fs.writeFileSync(path.join(hh, 'profiles', active, 'gateway_state.json'), JSON.stringify({ kind: 'hermes-gateway', gateway_state: 'running', pid, hermes_home: fault === 'runtime-profile' ? hh : path.join(hh, 'profiles', active), served_profiles: [active] }))
          if (options.version === '0.22.2' && active !== 'default' && fault !== 'boot') {
            const canonical = fs.realpathSync(source).replace(/^\\\\\?\\/, '')
            const file = path.join(hh, 'installs', digest(canonical).slice(0, 16), 'bootstrap', active + '.json')
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, identity: pin, bootstrappedAt: '2026-10-16T01:00:00Z', results: { migrate: { ok: true }, expose_cli: { ok: true } } }))
          }
        }
        return 'ok'
      }
      if (cmd === 'hermes_health_check') { if (!online || transient-- > 0) throw new Error('offline'); return { status: 'ok', platform: 'hermes-agent', version: options.version } }
      assert.equal(cmd, 'hermes_dashboard_api_proxy')
      if (args.method === 'GET') return profiles.map(p => ({ ...p }))
      const body = args.body == null ? null : JSON.parse(args.body)
      if (args.method === 'POST') {
        assert.equal(body.clone_from_default, options.cloneFromDefault); assert.equal(body.no_skills, options.noSkills)
        profiles.push({ name: body.name }); fs.mkdirSync(path.join(hh, 'profiles', body.name), { recursive: true })
        return { ok: true, name: body.name, path: path.join(hh, 'profiles', body.name) }
      }
      if (args.method === 'PUT') { Object.assign(profiles.at(-1), body); return { ok: true, ...body } }
      throw new Error('unexpected proxy call')
    },
    client: {
      script: async (code, args = []) => code.includes('__HERMES_PROFILE_QUALIFICATION_TAP__') ? new Function('window', 'argv', `return (function(){${code}}).apply(null,argv)`)(window, args) : code.includes('querySelectorAll') ? profiles.map(p => ({ name: p.name, visible: fault !== 'gui', active: p.name === active, configure: true, rename: true, switch: p.name !== active, delete: p.name !== active })) : true,
      element: async selector => selector,
      command: async (method, route, body) => {
        if (route.endsWith('/clear')) { text = ''; return }
        if (route.endsWith('/value')) { text = body.text; return }
        assert.ok(route.endsWith('/click')); clicks.push(route)
        const name = route.match(/data-name="([^"]+)"/)?.[1]
        if (route.includes('data-action="switch"')) active = name
        if (route.includes('data-action="rename"')) { modal = 'rename'; selected = name }
        if (route.includes('data-action="delete"')) { modal = 'delete'; selected = name }
        if (route.includes('data-action="confirm"')) {
          if (modal === 'rename') { profiles.find(p => p.name === selected).name = text; fs.renameSync(path.join(hh, 'profiles', selected), path.join(hh, 'profiles', text)); renamed = text; await receipt('PATCH', selected, { ok: true, name: text }) }
          else if (fault !== 'delete') { profiles.splice(profiles.findIndex(p => p.name === selected), 1); fs.rmSync(path.join(hh, 'profiles', selected), { recursive: true }); await receipt('DELETE', selected, { ok: true, settlement_pending: fault === 'settlement', identity_settled: fault !== 'settlement' }) }
        }
      },
      screenshot: async file => { if (fault !== 'screenshot') fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex')) },
    },
  }
  return { options, calls, clicks }
}

test('生产API参数/W3C操作/原boot文件/监听/历史与task canary形成完整模块回执', async t => {
  const { qualifyHermesProfiles } = await load(), f = fixture(t)
  const report = await qualifyHermesProfiles(f.options)
  assert.equal(report.status, 'passed', JSON.stringify(report))
  assert.equal(report.evidenceKind, 'isolated-fixture')
  assert.ok(f.clicks.some(x => x.includes('data-action="switch"')))
  assert.ok(f.clicks.some(x => x.includes('data-action="rename"')))
  assert.ok(f.clicks.some(x => x.includes('data-action="delete"')))
  assert.ok(report.boot.sha256 && report.screenshots.length >= 3)
  const saved = fs.readFileSync(path.join(f.options.output, 'profile-qualification.json'), 'utf8')
  assert.ok(!saved.includes('private historical text') && !saved.includes('<Task'))
})

for (const fault of ['boot', 'gui', 'screenshot', 'delete', 'history', 'task-permission', 'settlement', 'runtime-profile']) {
  test(`缺少真实证明保持失败并落盘：${fault}`, async t => {
    const f = fixture(t, fault), { qualifyHermesProfiles } = await load()
    const r = await qualifyHermesProfiles(f.options)
    assert.equal(r.status, 'failed')
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.output, 'profile-qualification.json'))).status, 'failed')
  })
}

test('Gateway API 启动后健康短暂未就绪时有界等待真实在线', async t => {
  const f = fixture(t, 'transient-health'), { qualifyHermesProfiles } = await load()
  assert.equal((await qualifyHermesProfiles(f.options)).status, 'passed')
})

test('ScheduledTask定义canary不比较运行状态，不导出XML，新增/删除/修改均失败', async () => {
  const { assertScheduledTasksStable, snapshotScheduledTasks } = await load()
  assert.doesNotThrow(() => assertScheduledTasksStable(tasks, tasks))
  for (const changed of [[], [...tasks, { name: '\\New', sha256: 'b'.repeat(64) }], [{ ...tasks[0], sha256: 'b'.repeat(64) }]]) assert.throws(() => assertScheduledTasksStable(tasks, changed))
  let script = ''
  const rows = await snapshotScheduledTasks({ platform: 'win32', run: (program, args) => { script = args.at(-1); return JSON.stringify([{ ...tasks[0], xml: '<Task>secret</Task>' }]) } })
  assert.deepEqual(rows, tasks); assert.match(script, /Get-ScheduledTask/); assert.match(script, /Export-ScheduledTask/)
  assert.doesNotMatch(script, /Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|LastRunTime|\.State/)
})

test('任务定义JSON子PS必须在读取/序列化前固定Console UTF8，Unicode名不经OEM best-fit', async () => {
  const { snapshotScheduledTasks } = await load()
  let script = ''
  const expected = [{ name: '\\fixture-中文“原名”', sha256: 'a'.repeat(64) }]
  const rows = await snapshotScheduledTasks({ platform: 'win32', run: (_program, args) => { script = args.at(-1); return JSON.stringify(expected) } })
  assert.deepEqual(rows, expected)
  const prefix = script.indexOf('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)')
  assert.ok(prefix >= 0 && prefix < script.indexOf('Get-ScheduledTask'), '固定child Console UTF8必须早于任务读取/JSON输出')
})

test('ScheduledTask子PS只移除继承的PSModulePath且父环境不变，权限失败仍失败', async () => {
  const { snapshotScheduledTasks } = await load(), before = Object.entries(process.env), calls = []
  const rows = await snapshotScheduledTasks({ platform: 'win32', run: (program, args, options) => { calls.push({ program, args, options }); return JSON.stringify(tasks) } })
  assert.deepEqual(rows, tasks); assert.equal(calls[0].program, 'powershell.exe')
  assert.notEqual(calls[0].options.env, process.env)
  assert.deepEqual(calls[0].options.env, Object.fromEntries(before.filter(([k]) => k.toLowerCase() !== 'psmodulepath')))
  assert.equal(calls[0].options.timeout, 60000); assert.deepEqual(Object.entries(process.env), before)
  await assert.rejects(snapshotScheduledTasks({ platform: 'win32', run: () => { throw new Error('denied') } }), /快照失败/)
})

test('原UI默认true/false与额外true/true均记录模型实际回读/最后session；legacy不造boot', async t => {
  const { qualifyHermesProfiles } = await load()
  for (const noSkills of [false, true]) {
    const f = fixture(t); f.options.noSkills = noSkills
    const report = await qualifyHermesProfiles(f.options)
    assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(report.noSkills, noSkills)
    assert.equal(report.defaultSessionId, f.options.defaultSessionId); assert.equal(report.expectedCommit, pin)
    assert.deepEqual(report.modelReadback, { provider: f.options.provider, model: f.options.model })
  }
  const f = fixture(t); f.options.version = '0.21.5'; f.options.expectedCommit = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'; f.options.noSkills = false
  const legacy = await qualifyHermesProfiles(f.options)
  assert.equal(legacy.status, 'passed', JSON.stringify(legacy)); assert.equal(legacy.boot.applicable, false); assert.equal(legacy.boot.identity, undefined)
})
