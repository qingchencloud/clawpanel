// 在 qualifyHermesProfiles 之后独立调用；不安装/升级/启停运行时，不改变宿主权限。
// 接口：qualifyHermesProfileCollision({ipc,client,home,output,proof,version,expectedCommit,deriveTaskName})。
// deriveTaskName 是受信任的 runner 接线函数，不是来自页面/HTTP 的数据或 bool：
// 它须使用已资格的私有 runtime Python/commandSpec 执行 taskNamePythonSource(profileHome)，
// 返回其 JSON 加 python(真实解释器路径)、sourceCommit(已绑定 HEAD)。模块独立核验源码 Git 字节。
// 新 PM 使用已验证 wrapper 的 --python-json；旧版使用私有 venv Python，并预置固定 source sys.path。
// 返回状态独立于 full native：passed-windows-profile-collision；fixture 永不产生该状态。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { actualRunnerProof, validateRunnerProof } from './test-hermes-windows-qualification.mjs'

const pins = { '0.21.5': 'f97608f178d1ffeca59860195ab7da295f7c8e5f', '0.22.2': 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' }
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const canonical = f => fs.realpathSync(f).replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '')
const inside = (r, f) => { const x = path.relative(r, f); return x !== '..' && !x.startsWith('..' + path.sep) && !path.isAbsolute(x) }
const message = e => typeof e === 'string' ? e : e?.message || JSON.stringify(e)
const TAP = '__HERMES_COLLISION_TAP__'
const checkPin = (version, pin) => assert.ok(Object.hasOwn(pins, version) && typeof pin === 'string' && pins[version] === pin, '固定 version/pin 不匹配')

export function taskNamePythonSource(profileHome) {
  // 仅调用固定源码命名函数；不调用 Query/Register/Run/Delete，不修改 vendor 或 HOME。
  return `import json\nfrom hermes_constants import set_hermes_home_override, reset_hermes_home_override\nfrom hermes_cli.gateway_windows import get_task_name\np=${JSON.stringify(String(profileHome))}\nt=set_hermes_home_override(p)\ntry:\n print(json.dumps({'taskName':get_task_name(),'profileHome':p,'method':'original-get_task_name'}))\nfinally:\n reset_hermes_home_override(t)\n`
}

export function scheduledTaskOperationSource(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64')
  return String.raw`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
function Read-Exact {
 try{$task=$folder.GetTask($p.name)}catch{
  $e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$hr='0x'+$e.HResult.ToString('X8')
  if($hr -eq '0x80070002'){return @{state='missing';hresult=$hr}};throw
 }
 $d=$task.Definition;$a=$d.Actions.Item(1);$user=$d.Principal.UserId
 if($user -notmatch '^S-1-'){ $user=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value }
 $sha=[Security.Cryptography.SHA256]::Create();$xml=$task.Xml.Replace([string][char]13,'')
 $h=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant()
 return @{state='exists';name=$task.Name;marker=$d.RegistrationInfo.Description;sha256=$h;enabled=[bool]$task.Enabled;triggers=$d.Triggers.Count;userId=$user;runLevel=[int]$d.Principal.RunLevel;logonType=[int]$d.Principal.LogonType;lastRunTime=$task.LastRunTime.ToString('o');lastTaskResult=[int]$task.LastTaskResult;action=([regex]::Match($a.Arguments,'^-NoProfile -NonInteractive -File "([^"]+)"$')).Groups[1].Value;executable=$a.Path;actions=$d.Actions.Count;allowDemandStart=[bool]$d.Settings.AllowDemandStart}
}
if($p.operation -eq 'read'){Read-Exact|ConvertTo-Json -Compress;exit}
if($p.operation -eq 'create'){
 $prior=Read-Exact;if($prior.state -ne 'missing' -or $prior.hresult -ne '0x80070002'){throw 'prior task exists or unknown'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if($sid -ne $p.sid -or $sid -eq 'S-1-5-18'){throw 'current user SID mismatch'}
 $d=$s.NewTask(0);$d.RegistrationInfo.Description=$p.marker
 $d.Principal.UserId=$sid;$d.Principal.LogonType=3;$d.Principal.RunLevel=0
 $d.Settings.Enabled=$false;$d.Settings.AllowDemandStart=$false
 $a=$d.Actions.Create(0);$a.Path=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';$a.Arguments='-NoProfile -NonInteractive -File "'+$p.script+'"'
 $null=$folder.RegisterTaskDefinition($p.name,$d,2,$sid,$null,3)
 Read-Exact|ConvertTo-Json -Compress;exit
}
if($p.operation -eq 'remove'){
 $v=Read-Exact
 if($v.state -ne 'exists' -or $v.name -cne $p.name -or $v.marker -cne $p.marker -or $v.sha256 -cne $p.sha256){throw 'ownership mismatch; preserved'}
 $folder.DeleteTask($p.name,0);Read-Exact|ConvertTo-Json -Compress;exit
}
throw 'unknown operation'`
}

function realTasks() {
  const run = p => {
    // 此函数不导出，唯一生产调用方已经 actualRunnerProof；每次仍检查平台/托管环境。
    assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Windows VM 门禁')
    const env = { ...process.env }; delete env.PSModulePath
    const source = scheduledTaskOperationSource(p)
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
    return JSON.parse(raw.replace(/^\uFEFF/, '').trim())
  }
  return { read: name => run({ operation: 'read', name }), create: p => run({ ...p, operation: 'create' }), remove: p => run({ ...p, operation: 'remove' }) }
}

function sourceFacts(home, version, expectedCommit) {
  const source = canonical(path.join(home, '.hermes/hermes-agent'))
  assert.ok(inside(home, source), 'source 超出私有 HOME')
  const git = args => execFileSync('git', ['--no-optional-locks', '-C', source, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), expectedCommit, 'source HEAD/pin 不匹配')
  const files = ['hermes_constants.py', 'hermes_cli/gateway.py', 'hermes_cli/gateway_windows.py', 'hermes_cli/profiles.py']
  if (version === '0.22.2') files.push('hermes_cli/profiles_service_cleanup.py')
  const sourceHashes = {}
  for (const f of files) {
    const disk = path.join(source, f)
    assert.ok(inside(source, canonical(disk)) && !fs.lstatSync(disk).isSymbolicLink(), 'source 文件链接/越界')
    const original = git(['show', `${expectedCommit}:${f}`]), actual = fs.readFileSync(disk)
    assert.equal(hash(actual), hash(original), `固定 source 字节变化 ${f}`)
    sourceHashes[f] = hash(actual)
  }
  return { sourceCommit: expectedCommit, sourceHashes }
}

export async function qualifyHermesProfileCollision(options) {
  // 必须先读取真实 VM/SID/ProfileList；任意 supplied proof/fixture bool 都不会跳过它。
  const actual = actualRunnerProof(); validateRunnerProof(actual); validateRunnerProof(options.proof)
  assert.deepEqual(options.proof, actual, 'proof 与本轮真实 VM 不同')
  checkPin(options.version, options.expectedCommit)
  const home = canonical(options.home)
  assert.ok(!inside(home, canonical(actual.actualProfile)), '不得使用宿主原 HOME 或其祖先')
  const facts = sourceFacts(home, options.version, options.expectedCommit)
  return runCollision({ ...options, home }, { tasks: realTasks(), facts, recheck: () => sourceFacts(home, options.version, options.expectedCommit) }, false)
}

// 明确隔离的测试入口；不能替换生产 tasks/admission，也不能产出真实资格状态。
export async function runProfileCollisionFixture(options, deps) {
  assert.ok(deps?.tasks && typeof deps.tasks.read === 'function', 'fixture 必须显式提供隔离 task backend')
  return runCollision(options, { ...deps, facts: { sourceCommit: options.expectedCommit, sourceHashes: {} } }, true)
}

function tree(root) {
  const rows = []
  const walk = f => {
    const st = fs.lstatSync(f); assert.ok(!st.isSymbolicLink(), 'profile 含链接，保留现场')
    assert.ok(inside(root, canonical(f)), 'profile 路径逃逸')
    const rel = path.relative(root, f).replaceAll('\\', '/')
    if (st.isDirectory()) { rows.push({ path: rel, type: 'directory' }); for (const n of fs.readdirSync(f).sort()) walk(path.join(f, n)) }
    else { assert.ok(st.isFile(), 'profile 非普通文件'); rows.push({ path: rel, bytes: st.size, sha256: hash(fs.readFileSync(f)) }) }
  }
  walk(root); return rows
}

async function runCollision(o, deps, fixture) {
  checkPin(o.version, o.expectedCommit)
  assert.ok(typeof o.ipc === 'function' && typeof o.deriveTaskName === 'function', '需要真实 IPC 与可信原始 get_task_name 接口')
  for (const m of ['script', 'element', 'command', 'screenshot']) assert.equal(typeof o.client?.[m], 'function', `缺少 W3C ${m}`)
  const timeout = o.timeoutMs ?? 30000, poll = o.pollMs ?? 100
  assert.ok(timeout > 0 && timeout <= 120000 && poll > 0, '等待必须有界')
  const home = canonical(o.home), hh = canonical(path.join(home, '.hermes')), output = path.resolve(o.output)
  assert.ok(inside(home, hh) && !inside(hh, output) && !inside(output, home), 'output/HOME 路径隔离失败')
  assert.ok(!fs.existsSync(output), 'output 必须全新'); fs.mkdirSync(output, { recursive: true })
  const nonce = crypto.randomBytes(12).toString('hex'), marker = `ClawPanel profile collision ${o.proof.runId}/${o.proof.attempt}/${nonce}`
  const r = { schemaVersion: 1, status: 'failed', evidenceKind: fixture ? 'isolated-fixture' : 'real-windows-vm-native-modal', version: o.version, source: deps.facts, runId: o.proof.runId, attempt: o.proof.attempt, nonce, marker, cases: [], screenshots: [], errors: [], gaps: [], startedAt: new Date().toISOString() }
  const save = () => fs.writeFileSync(path.join(output, 'profile-collision.json'), JSON.stringify(r, null, 2) + '\n')
  const until = async fn => { const end = performance.now() + timeout; do { const v = await fn(); if (v) return v; await sleep(poll) } while (performance.now() < end); throw new Error('collision 有界等待失败') }
  const ipc = o.ipc, client = o.client, tasks = deps.tasks
  const proxy = (method, route, body) => ipc('hermes_dashboard_api_proxy', { method, path: route, body: body == null ? null : JSON.stringify(body), headers: null })
  const list = async () => { const a = await proxy('GET', '/api/profiles'); const rows = Array.isArray(a) ? a : a?.profiles; assert.ok(Array.isArray(rows), 'Profile list 非数组'); return rows }
  const click = async selector => client.command('POST', `/element/${await client.element(selector)}/click`, {})
  const screenshot = async file => { const p = path.join(output, file); await client.screenshot(p); const b = fs.readFileSync(p); assert.ok(b.length > 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '缺少真实 GUI PNG'); r.screenshots.push({ file, sha256: hash(b) }) }
  const profilePath = n => path.join(hh, 'profiles', n)
  // Rust 此命令可能把 CLI 失败转成 []；因此这里只作补充回读，完整文件树才是历史文件不变证明。
  const history = async n => { const v = await ipc('hermes_sessions_list', { profile: n, limit: 100 }); assert.ok(Array.isArray(v), '历史导出非数组'); return { sha256: hash(JSON.stringify(v)), entries: v.length, scope: 'supplemental IPC export; empty is not proof of a successful CLI read' } }
  const missing = v => assert.deepEqual(v, { state: 'missing', hresult: '0x80070002' }, '任务不是权威 absent，保留现场')
  const safety = (v, spec) => {
    assert.equal(v.state, 'exists'); assert.equal(v.name, spec.name); assert.equal(v.marker, marker); assert.match(v.sha256 || '', /^[a-f0-9]{64}$/)
    assert.equal(v.enabled, false); assert.equal(v.triggers, 0); assert.equal(v.userId, o.proof.sid); assert.notEqual(v.userId, 'S-1-5-18'); assert.equal(v.runLevel, 0); assert.equal(v.logonType, 3); assert.equal(v.action, spec.script)
    if (!fixture) { assert.equal(v.actions, 1); assert.equal(v.allowDemandStart, false); assert.equal(v.executable.toLowerCase(), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe').toLowerCase()) }
    assert.ok(typeof v.lastRunTime === 'string' && v.lastRunTime, '缺 LastRunTime')
    // SCHED_S_TASK_HAS_NOT_RUN；不能把已经运行过但 canary 未写入的任务算作 executionCount=0。
    assert.equal(v.lastTaskResult, 0x41303, 'sentinel 非从未运行状态')
  }
  let observing = false
  try {
    save()
    const nativeProfiles = await ipc('hermes_profiles_list')
    assert.ok(nativeProfiles?.active === 'default' && Array.isArray(nativeProfiles.profiles) && nativeProfiles.profiles.some(p => p.name === 'default'), '必须在基础 Profile 资格之后恢复实际 default 项')
    for (const operation of ['rename', 'delete']) {
      const name = `qualc-${nonce}-${operation}`, renamed = name + '-renamed'
      const c = { operation, name, renamed, profilePath: profilePath(name), stage: 'create' }; r.cases.push(c); save()
      assert.ok(!(await list()).some(p => [name, renamed].includes(p.name)), '随机 profile 已存在')
      const created = await proxy('POST', '/api/profiles', { name, clone_from_default: true, no_skills: true })
      assert.ok(created?.ok === true && created.name === name, 'Dashboard POST 创建失败')
      assert.equal(canonical(created.path), canonical(profilePath(name)), 'API 创建到非预期 HOME')
      c.historyBefore = await history(name); c.treeBefore = tree(profilePath(name))
      const receipt = await o.deriveTaskName({ profile: name, profileHome: canonical(profilePath(name)), home, version: o.version, sourceCommit: o.expectedCommit, snippet: taskNamePythonSource(canonical(profilePath(name))) })
      const derived = Object.fromEntries(['taskName', 'profileHome', 'sourceCommit', 'method', 'python'].map(k => [k, receipt?.[k]]))
      assert.equal(derived.sourceCommit, o.expectedCommit, '派生 source pin 错误'); assert.equal(derived.method, 'original-get_task_name'); assert.equal(canonical(derived.profileHome), canonical(profilePath(name)))
      assert.ok(typeof derived.taskName === 'string' && derived.taskName.length <= 200 && !/[\\/\u0000-\u001f]/.test(derived.taskName), '任务名不是根目录安全名称')
      assert.ok(inside(home, canonical(derived.python)) && fs.statSync(derived.python).isFile(), '派生解释器不属于私有 runtime')
      assert.ok(!r.cases.slice(0, -1).some(prior => prior.derivation?.taskName === derived.taskName), '两个随机 profile 派生同一任务名')
      c.derivation = derived; c.priorTask = await tasks.read(derived.taskName); missing(c.priorTask); save()
      const foreign = path.join(output, 'foreign-home', operation); fs.mkdirSync(foreign, { recursive: true })
      const script = path.join(foreign, 'never-run.ps1'), executions = path.join(foreign, 'executions.log')
      fs.writeFileSync(script, `# ${marker}\nAdd-Content -LiteralPath '${executions.replaceAll("'", "''")}' -Value 'unexpected execution'\n`)
      c.foreignBefore = tree(foreign)
      const spec = { name: derived.taskName, marker, sid: o.proof.sid, script }
      c.stage = 'register-create-only'; c.sentinel = spec; save(); await tasks.create(spec)
      c.taskBefore = await tasks.read(spec.name); safety(c.taskBefore, spec); assert.ok(!fs.existsSync(executions), 'sentinel 已执行')
      c.stage = 'native-modal'; save()
      assert.equal(await client.script(`if(window.${TAP}||typeof window.__TAURI_INTERNALS__?.invoke!=='function')return false;const original=window.__TAURI_INTERNALS__.invoke,rows=[],target=arguments[0];const wrapper=async function(cmd,args,...rest){const match=cmd==='hermes_dashboard_api_proxy'&&args?.path===target&&['PATCH','DELETE'].includes(args?.method);try{const v=await original.call(this,cmd,args,...rest);if(match)rows.push({method:args.method,path:args.path,ok:v?.ok,name:v?.name});return v}catch(e){if(match)rows.push({method:args.method,path:args.path,error:typeof e==='string'?e:e?.message||JSON.stringify(e)});throw e}};window.${TAP}={original,wrapper,rows};window.__TAURI_INTERNALS__.invoke=wrapper;return true`, ['/api/profiles/' + name]), true, '原生 invoke 观察失败')
      observing = true
      await client.script("location.hash='/h/profiles';return true")
      await until(() => client.script('return !!document.querySelector("#hm-profiles-refresh")'))
      await click('#hm-profiles-refresh')
      await until(async () => (await client.script('return [...document.querySelectorAll(".lazy-deps-card-title")].map(e=>e.title)')).includes(name))
      await click(`[data-action="${operation}"][data-name="${name}"]`)
      if (operation === 'rename') {
        await until(() => client.script('return !!document.querySelector(\'.modal-overlay input[data-name="new_name"]\')'))
        const input = await client.element('.modal-overlay input[data-name="new_name"]'); await client.command('POST', `/element/${input}/clear`, {}); await client.command('POST', `/element/${input}/value`, { text: renamed, value: [...renamed] })
      }
      await until(() => client.script('return !!document.querySelector(\'.modal-overlay [data-action="confirm"]\')'))
      await click('.modal-overlay [data-action="confirm"]')
      c.receipts = await until(async () => { const rows = await client.script(`return window.${TAP}.rows`); return rows?.length && rows })
      assert.equal(c.receipts.length, 1, '原生 mutation 次数不是一次'); assert.equal(c.receipts[0].method, operation === 'rename' ? 'PATCH' : 'DELETE')
      if (o.version === '0.22.2') {
        assert.ok(c.receipts[0].error?.includes('private profile mutation blocked by external Windows task/query') && c.receipts[0].error.includes(spec.name), '没有实际 task policy 拒绝')
        c.visibleError = await until(() => client.script('return [...document.querySelectorAll(".toast.error")].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.textContent).join("\\n")'))
        assert.ok(c.visibleError.includes(spec.name), '可见错误未关联本轮任务')
        c.historyAfter = await history(name); assert.deepEqual(c.historyAfter, c.historyBefore, '拒绝后历史发生变化')
        assert.deepEqual(tree(profilePath(name)), c.treeBefore, '拒绝后 profile/config/memory/history 文件被改')
        assert.ok((await list()).some(p => p.name === name) && !fs.existsSync(profilePath(renamed)), '拒绝后 Profile 身份改变')
        const cards = await client.script('return [...document.querySelectorAll(".lazy-deps-card-title")].map(e=>e.title)')
        assert.ok(cards.includes(name) && !cards.includes(renamed), '拒绝后 GUI Profile 卡片消失/改名')
        c.collisionDisposition = 'policy-rejected-before-profile-mutation'
      } else {
        assert.equal(c.receipts[0].ok, true, 'old21 无该 cleanup 应成功，不能用其他错误冒充保护')
        assert.ok(operation === 'rename' ? fs.existsSync(profilePath(renamed)) && !fs.existsSync(profilePath(name)) : !fs.existsSync(profilePath(name)), 'old21 实际文件 mutation 缺失')
        c.collisionDisposition = 'old21-profile-mutation-succeeded-task-retained'
      }
      await screenshot(operation + '-collision.png')
      assert.equal(await client.script(`const t=window.${TAP};if(window.__TAURI_INTERNALS__.invoke!==t.wrapper)return false;window.__TAURI_INTERNALS__.invoke=t.original;delete window.${TAP};return true`), true, 'invoke 恢复冲突'); observing = false
      c.taskAfter = await tasks.read(spec.name); assert.deepEqual(c.taskAfter, c.taskBefore, 'foreign task 定义/执行状态改变'); assert.ok(!fs.existsSync(executions), 'sentinel 执行计数非0'); c.executionCount = 0
      assert.deepEqual(tree(foreign), c.foreignBefore, 'foreign HOME 内容改变')
      c.executionProof = 'SCHED_S_TASK_HAS_NOT_RUN + unchanged LastRunTime + absent owned execution canary'
      // 失败不 finally 删除：只有全部碰撞断言成功后，复核三重身份再移除本轮 sentinel。
      c.stage = 'owned-cleanup'; save(); const last = await tasks.read(spec.name); assert.deepEqual(last, c.taskBefore, '清理前任务身份改变')
      await tasks.remove({ ...spec, sha256: c.taskBefore.sha256 }); missing(await tasks.read(spec.name)); c.sentinelRemoved = true
      c.stage = 'normal-crud'; save()
      let current = o.version === '0.21.5' && operation === 'rename' ? renamed : name
      if (!fs.existsSync(profilePath(current))) { const v = await proxy('POST', '/api/profiles', { name: current, clone_from_default: true, no_skills: true }); assert.equal(v?.ok, true) }
      const final = name + '-normal'
      const ren = await proxy('PATCH', '/api/profiles/' + current, { new_name: final }); assert.ok(ren?.ok === true && ren.name === final); assert.ok(!fs.existsSync(profilePath(current)) && fs.existsSync(profilePath(final)))
      const del = await proxy('DELETE', '/api/profiles/' + final); assert.ok(del?.ok === true && del.identity_settled !== false && del.settlement_pending !== true); assert.ok(!fs.existsSync(profilePath(final)))
      assert.ok(!(await list()).some(p => [name, renamed, final].includes(p.name)))
      c.normalCrudPassed = true; c.normalCrudLayer = 'actual Dashboard API via Rust IPC + filesystem/list readback'; c.stage = 'complete'; save()
    }
    if (deps.recheck) assert.deepEqual(deps.recheck(), deps.facts, '源码前后发生变化')
    r.status = fixture ? 'passed-fixture' : 'passed-windows-profile-collision'
  } catch (e) { r.errors.push(message(e)); r.gaps.push('collision-incomplete-scene-preserved-no-task-repair') }
  finally {
    if (observing) try { assert.equal(await client.script(`const t=window.${TAP};if(!t||window.__TAURI_INTERNALS__.invoke!==t.wrapper)return false;window.__TAURI_INTERNALS__.invoke=t.original;delete window.${TAP};return true`), true) } catch (e) { r.status = 'failed'; r.errors.push('invoke restore: ' + message(e)) }
    r.finishedAt = new Date().toISOString(); save()
  }
  return r
}
