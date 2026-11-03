// 独立资格步骤：复用调用方真实 IPC/WebDriver，不创建 driver、启动器或系统服务。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { actualRunnerProof, validateRunnerProof } from './test-hermes-windows-qualification.mjs'

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const canonical = file => fs.realpathSync(file).replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '')
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
const taskRows = rows => {
  assert.ok(Array.isArray(rows), 'ScheduledTask 定义快照缺失')
  const clean = rows.map(({ name, sha256 }) => {
    assert.ok(typeof name === 'string' && name && /^[a-f0-9]{64}$/.test(sha256), 'ScheduledTask 名称/hash 无效')
    return { name, sha256 }
  }).sort((a, b) => a.name.localeCompare(b.name))
  assert.equal(new Set(clean.map(x => x.name)).size, clean.length, 'ScheduledTask 名称重复')
  return clean
}

export function assertScheduledTasksStable(before, after) {
  assert.deepEqual(taskRows(after), taskRows(before), 'ScheduledTask 静态定义发生变化')
}

export async function snapshotScheduledTasks({ platform = process.platform, run = execFileSync } = {}) {
  assert.equal(platform, 'win32', 'ScheduledTask 快照仅适用于 Windows')
  if (run === execFileSync) validateRunnerProof(actualRunnerProof())
  // XML 仅在 PowerShell 内存中计算静态定义 hash；不输出 XML/运行状态，也不修改任务。
  const script = String.raw`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$sha=[Security.Cryptography.SHA256]::Create();$rows=@(Get-ScheduledTask -ErrorAction Stop | Sort-Object TaskPath,TaskName | ForEach-Object { $xml=[xml](Export-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction Stop);$bytes=[Text.Encoding]::UTF8.GetBytes($xml.OuterXml.Replace([string][char]13,''));[pscustomobject]@{name=$_.TaskPath+$_.TaskName;sha256=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()} });ConvertTo-Json -InputObject $rows -Compress -Depth 3`
  let raw
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  try { raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }) }
  catch { throw new Error('ScheduledTask 只读定义快照失败；权限或接口缺口未资格') }
  return taskRows(JSON.parse(String(raw).replace(/^\uFEFF/, '')))
}

export async function qualifyHermesProfiles({ ipc, client, output, home, version, expectedCommit, defaultSessionId, provider, model,
  gatewayPort, runtimeSnapshot, cloneFromDefault = true, noSkills = false, taskSnapshot,
  timeoutMs = 60000, pollMs = 300, evidenceKind = 'production-ipc-native-gui' }) {
  assert.ok(typeof ipc === 'function' && typeof runtimeSnapshot === 'function', '必须提供真实 IPC 和监听快照')
  for (const method of ['script', 'element', 'command', 'screenshot']) assert.equal(typeof client?.[method], 'function', `缺少 WebDriver ${method}`)
  assert.ok(defaultSessionId && provider && model && /^\d+\.\d+\.\d+$/.test(version), '缺少已有 default 历史/模型/精确版本')
  assert.ok(Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort < 65536, 'Gateway 实际端口无效')
  assert.ok(timeoutMs > 0 && timeoutMs <= 120000 && pollMs > 0, '等待必须有界')
  assert.equal(typeof cloneFromDefault, 'boolean'); assert.equal(typeof noSkills, 'boolean')
  home = canonical(home)
  const hh = canonical(path.join(home, '.hermes')), source = canonical(path.join(hh, 'hermes-agent'))
  assert.ok(inside(home, hh) && inside(hh, source), '运行时超出私有 HOME')
  if (version === '0.22.2') assert.match(expectedCommit || '', /^[a-f0-9]{40}$/, '新 PM 缺精确 source commit')
  assert.ok(!fs.existsSync(output), '证据目录必须全新')
  fs.mkdirSync(output, { recursive: true })
  const name = 'qualp-' + crypto.randomBytes(6).toString('hex'), renamed = name + '-renamed'
  const report = { schemaVersion: 1, status: 'failed', evidenceKind: taskSnapshot ? 'isolated-fixture' : evidenceKind, version, expectedCommit, defaultSessionId, provider, model, name, renamed, cloneFromDefault, noSkills, steps: [], screenshots: [], gaps: [], errors: [], startedAt: new Date().toISOString() }
  const save = () => fs.writeFileSync(path.join(output, 'profile-qualification.json'), JSON.stringify(report, null, 2) + '\n')
  const tasks = taskSnapshot || (() => process.platform === 'win32' ? snapshotScheduledTasks() : null)
  let beforeTasks, historyBefore, mutated = false, observing = false
  const until = async fn => {
    const end = performance.now() + timeoutMs
    do { const value = await fn(); if (value) return value; await sleep(pollMs) } while (performance.now() < end)
    throw new Error('named profile 有界等待失败')
  }
  const step = async (label, fn) => { await fn(); report.steps.push(label); save() }
  const proxy = (method, route, body) => ipc('hermes_dashboard_api_proxy', { method, path: route, body: body == null ? null : JSON.stringify(body), headers: null })
  const list = async () => { const value = await proxy('GET', '/api/profiles'); const rows = Array.isArray(value) ? value : value?.profiles; assert.ok(Array.isArray(rows), 'Profile 列表未返回实际数组'); return rows }
  const click = async selector => client.command('POST', `/element/${await client.element(selector)}/click`, {})
  const button = (action, profile) => `[data-action="${action}"][data-name="${profile}"]`
  const profilePath = profile => path.join(hh, 'profiles', profile)
  const snapshot = async () => { const value = await runtimeSnapshot(); assert.ok(Array.isArray(value?.listeners), '缺少真实监听集合'); return value.listeners.filter(row => row.port === gatewayPort) }
  const offline = async () => until(async () => {
    let health = false
    try { health = !!(await ipc('hermes_health_check')) } catch { /* 实际连接失败与端口快照共同判断。 */ }
    return !health && (await snapshot()).length === 0
  })
  const online = async () => {
    await until(async () => {
      try { const h = await ipc('hermes_health_check'); return h?.status === 'ok' && h.platform === 'hermes-agent' && h.version === version }
      catch { return false }
    })
    const rows = await snapshot(); assert.ok(rows.length, '健康接口在线但没有真实监听 PID')
    for (const row of rows) {
      assert.ok(Number.isInteger(row.pid) && row.pid > 0 && Number.isFinite(Date.parse(row.creationDate)), '监听进程身份缺失')
      const command = String(row.commandLine || '').toLowerCase(), exe = String(row.executablePath || '')
      assert.ok((exe && inside(home, path.resolve(exe))) || command.includes((home + path.sep).toLowerCase()), '监听进程不属于私有 HOME')
    }
    return rows.map(({ port, pid, creationDate, executablePath, commandLine }) => ({ port, pid, creationDate, executablePath, commandLine }))
  }
  const history = async () => {
    const detail = await ipc('hermes_session_detail', { sessionId: defaultSessionId, profile: 'default' })
    assert.ok(detail?.id === defaultSessionId && Array.isArray(detail.messages) && detail.messages.length, 'default 真实历史缺失')
    return { sha256: hash(JSON.stringify({ id: detail.id, messages: detail.messages })), messages: detail.messages.length }
  }
  const screenshot = async filename => {
    const file = path.join(output, filename); await client.screenshot(file)
    const bytes = fs.readFileSync(file); assert.ok(bytes.length > 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'GUI PNG 未落盘')
    report.screenshots.push({ file: filename, sha256: hash(bytes) })
  }
  const gui = async (profile, filename, active = false) => {
    await client.script("location.hash='/h/profiles';return true")
    await until(() => client.script('return !!document.querySelector("#hm-profiles-refresh")'))
    await click('#hm-profiles-refresh')
    const row = await until(async () => {
      const rows = await client.script(`return [...document.querySelectorAll('.lazy-deps-card')].map(c=>{const title=c.querySelector('.lazy-deps-card-title');if(title?.title===arguments[0])c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();const has=a=>!!c.querySelector('[data-action="'+a+'"]');return {name:title?.title,visible:r.width>0&&r.height>0&&getComputedStyle(c).visibility!=='hidden',active:!!c.querySelector('.lazy-deps-badge.ok'),configure:has('configure'),rename:has('rename'),switch:has('switch'),delete:has('delete')}})`, [profile])
      return rows.find(r => r.name === profile && r.visible && r.active === active)
    })
    assert.ok(row.configure && row.rename && (active || (row.switch && row.delete)), 'Profile GUI 操作缺失')
    await screenshot(filename)
  }
  try {
    save()
    await step('baseline-history-and-task-definitions', async () => {
      beforeTasks = await tasks()
      if (process.platform === 'win32' || taskSnapshot) taskRows(beforeTasks)
      historyBefore = await history(); report.historyBefore = historyBefore
      assert.equal((await ipc('hermes_profiles_list')).active, 'default', '调用前必须在 default')
    })
    await step('dashboard-proxy-create-and-model-readback', async () => {
      await ipc('hermes_dashboard_start')
      assert.ok(!(await list()).some(p => p.name === name || p.name === renamed), '本轮 profile 名称冲突')
      if (version === '0.22.2') assert.ok(!fs.existsSync(path.join(hh, 'installs', hash(source).slice(0, 16), 'bootstrap', name + '.json')), 'named boot record 已存在，不能借用旧记录')
      const created = await proxy('POST', '/api/profiles', { name, clone_from_default: cloneFromDefault, no_skills: noSkills })
      assert.ok(created?.ok && created.name === name, 'Profile create 未成功')
      mutated = true
      assert.equal(canonical(created.path), canonical(profilePath(name)), 'Profile create 实际目录不符')
      assert.ok(inside(hh, canonical(created.path)), 'Profile create 越界')
      const configured = await proxy('PUT', `/api/profiles/${name}/model`, { provider, model })
      assert.ok(configured?.ok && configured.provider === provider && configured.model === model, 'Profile 模型写入回执不符')
      const row = (await list()).find(p => p.name === name)
      assert.ok(row?.provider === provider && row.model === model, 'Profile 模型实际回读不符')
      report.modelReadback = { provider: row.provider, model: row.model }
      await gui(name, 'named-visible.png')
    })
    await step('default-to-named-gui-runtime-and-boot', async () => {
      await ipc('hermes_gateway_action', { action: 'stop' }); await offline()
      await click(button('switch', name))
      await until(async () => (await ipc('hermes_profiles_list')).active === name)
      await ipc('hermes_gateway_action', { action: 'start' }); report.namedListeners = await online()
      const runtimeFile = path.join(profilePath(name), 'gateway_state.json')
      assert.equal(canonical(runtimeFile), path.resolve(runtimeFile), 'named runtime 原记录缺失/重定向')
      const runtimeBytes = fs.readFileSync(runtimeFile)
      assert.ok(runtimeBytes.length < 128 * 1024, 'named runtime 原记录超限')
      const state = JSON.parse(runtimeBytes.toString('utf8').replace(/^\uFEFF/, ''))
      assert.ok(state.kind === 'hermes-gateway' && state.gateway_state === 'running' &&
        canonical(state.hermes_home) === canonical(profilePath(name)) && report.namedListeners.some(p => p.pid === state.pid), 'named runtime HOME/PID 与实际监听不符')
      if (version === '0.22.2') assert.ok(state.served_profiles?.includes(name), '新 PM runtime 未实际服务 named profile')
      report.namedRuntime = { file: path.relative(hh, runtimeFile), sha256: hash(runtimeBytes), pid: state.pid, profile: name, hermesHome: state.hermes_home, ...(version === '0.22.2' ? { servedProfiles: state.served_profiles } : {}) }
      if (version === '0.22.2') {
        const key = hash(source).slice(0, 16), file = path.join(hh, 'installs', key, 'bootstrap', name + '.json')
        assert.equal(canonical(file), path.resolve(file), 'named boot record 越界/重定向')
        const bytes = fs.readFileSync(file); assert.ok(bytes.length < 128 * 1024, 'named boot record 超限')
        const record = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
        assert.ok(record.schemaVersion === 1 && record.identity === expectedCommit && Number.isFinite(Date.parse(record.bootstrappedAt)), 'named boot record 身份/时间不符')
        const steps = Object.entries(record.results || {})
        assert.ok(steps.length && steps.every(([, value]) => value?.ok === true), 'named boot 原步骤不完整')
        report.boot = { applicable: true, file: path.relative(hh, file), sha256: hash(bytes), identity: record.identity, bootstrappedAt: record.bootstrappedAt, steps: steps.map(([name]) => name) }
      } else report.boot = { applicable: false, reason: 'legacy-no-PM-boot-record-contract' }
      await gui(name, 'named-active.png', true)
    })
    await step('stop-named-restore-default', async () => {
      await ipc('hermes_gateway_action', { action: 'stop' }); await offline()
      await click(button('switch', 'default'))
      await until(async () => (await ipc('hermes_profiles_list')).active === 'default')
      await ipc('hermes_gateway_action', { action: 'start' }); report.defaultListeners = await online()
      await gui('default', 'restored-default.png', true)
    })
    await step('gui-rename-delete-and-physical-readback', async () => {
      // 只观察本轮两条 proxy mutation 的有限回执；原 invoke 返回值/异常不改写。
      // 生产前端 @tauri-apps/api/core 走 INTERNALS，不能只观察 client.ipc 的外层调用。
      observing = await client.script(`if(window.__HERMES_PROFILE_QUALIFICATION_TAP__||typeof window.__TAURI_INTERNALS__?.invoke!=='function')return false;
const original=window.__TAURI_INTERNALS__.invoke,paths=arguments[0],rows=[];
const wrapper=async function(cmd,args,...rest){const value=await original.call(this,cmd,args,...rest);if(cmd==='hermes_dashboard_api_proxy'&&paths.includes(args?.path)&&['PATCH','DELETE'].includes(args?.method)){const row={method:args.method,path:args.path};for(const k of ['ok','name','identity_settled','settlement_pending'])if(value?.[k]!==undefined)row[k]=value[k];rows.push(row)}return value};
window.__HERMES_PROFILE_QUALIFICATION_TAP__={original,wrapper,rows};window.__TAURI_INTERNALS__.invoke=wrapper;return window.__TAURI_INTERNALS__.invoke===wrapper`, [[`/api/profiles/${name}`, `/api/profiles/${renamed}`]])
      assert.equal(observing, true, 'GUI 原生 proxy 回执观察不可用')
      await gui(name, 'before-rename.png')
      await click(button('rename', name))
      const input = await client.element('.modal-overlay input[data-name="new_name"]')
      await client.command('POST', `/element/${input}/clear`, {})
      await client.command('POST', `/element/${input}/value`, { text: renamed, value: [...renamed] })
      await click('.modal-overlay [data-action="confirm"]')
      await until(async () => { const rows = await list(); return rows.some(p => p.name === renamed) && !rows.some(p => p.name === name) })
      assert.ok(!fs.existsSync(profilePath(name)) && fs.existsSync(profilePath(renamed)), 'rename 磁盘结果不符')
      await gui(renamed, 'renamed-visible.png')
      await click(button('delete', renamed)); await click('.modal-overlay [data-action="confirm"]')
      await until(async () => !(await list()).some(p => p.name === name || p.name === renamed))
      assert.ok(!fs.existsSync(profilePath(name)) && !fs.existsSync(profilePath(renamed)), 'delete 未物理完成/identity settlement 待续')
      report.guiReceipts = await client.script('return window.__HERMES_PROFILE_QUALIFICATION_TAP__.rows')
      const rename = report.guiReceipts.find(x => x.method === 'PATCH' && x.path === `/api/profiles/${name}`)
      const deletion = report.guiReceipts.find(x => x.method === 'DELETE' && x.path === `/api/profiles/${renamed}`)
      assert.ok(rename?.ok === true && rename.name === renamed, 'GUI rename 缺原生产 proxy 回执')
      assert.ok(deletion?.ok === true && deletion.identity_settled !== false && deletion.settlement_pending !== true, 'GUI delete 未完成 identity settlement')
      await until(async () => !(await client.script('return [...document.querySelectorAll(".lazy-deps-card-title")].map(e=>({name:e.title}))')).some(p => p.name === name || p.name === renamed))
      await screenshot('deleted.png')
    })
    report.status = 'passed'
  } catch (error) {
    report.errors.push(String(error.message)); report.gaps.push('named-profile-qualification-incomplete')
    if (mutated) {
      try { await ipc('hermes_gateway_action', { action: 'stop' }); await offline(); await ipc('hermes_profile_use', { name: 'default' }) }
      catch (cleanupError) { report.errors.push('恢复default失败: ' + cleanupError.message) }
    }
  } finally {
    if (observing) {
      try {
        assert.equal(await client.script(`const t=window.__HERMES_PROFILE_QUALIFICATION_TAP__;if(!t||window.__TAURI_INTERNALS__.invoke!==t.wrapper)return false;window.__TAURI_INTERNALS__.invoke=t.original;delete window.__HERMES_PROFILE_QUALIFICATION_TAP__;return true`), true, 'GUI 回执观察恢复冲突')
      } catch (error) { report.status = 'failed'; report.errors.push(String(error.message)) }
    }
    try {
      report.historyAfter = await history()
      if (historyBefore) assert.deepEqual(report.historyAfter, historyBefore, 'default 历史发生变化')
      const after = await tasks()
      if (beforeTasks !== undefined && beforeTasks !== null) { report.tasks = { before: taskRows(beforeTasks), after: taskRows(after) }; assertScheduledTasksStable(beforeTasks, after) }
      else report.tasks = { applicable: false, reason: 'not-windows' }
    } catch (error) { report.status = 'failed'; report.errors.push(String(error.message)); report.gaps.push('history-or-ScheduledTask-canary-incomplete') }
    report.finishedAt = new Date().toISOString(); save()
  }
  return report
}
