// 先红后实现：实际运行同源 workflow Node 内联程序；只调用自有 recorder，不执行 GUI/安装/Win32。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createAttachOwnership } from '../scripts/test-weixin-windows-qualification.mjs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const file = new URL('../.github/workflows/weixin-qualification.yml', import.meta.url)
const workflow = parse(fs.readFileSync(file, 'utf8')), job = workflow.jobs.native
// 原80eef workflow/生产两文件/旧workflow测试冻结；token测试SHA仅同步获批ddf基线内置修正。
// CI不读取历史Git对象、网络或额外fixture。
const original = {
  "name": "Manual Weixin Native Qualification",
  "on": {
    "workflow_dispatch": {
      "inputs": {
        "candidate_sha": {
          "description": "已审查且集成 Rust+UI 的完整40位候选SHA；不接受branch/tag",
          "type": "string",
          "required": true
        },
        "scope": {
          "description": "complete缺任何真实负向即失败；ui-origin仅首阶段，永不pass-native",
          "type": "choice",
          "options": [
            "complete",
            "ui-origin"
          ],
          "default": "complete"
        },
        "diagnostic_attach": {
          "description": "仅10.4 W3C attach诊断，永不作为15case资格通过",
          "type": "boolean",
          "required": false,
          "default": false
        }
      }
    }
  },
  "permissions": {
    "contents": "read"
  },
  "concurrency": {
    "group": "weixin-native-qualification",
    "cancel-in-progress": false
  },
  "jobs": {
    "native": {
      "if": "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'qingchencloud/clawpanel'",
      "name": "Windows official ${{ matrix.host }} / ${{ inputs.diagnostic_attach && 'diagnostic-attach (NEVER qualification)' || inputs.scope }} (partial is not qualification)",
      "runs-on": "windows-2025",
      "timeout-minutes": 110,
      "strategy": {
        "fail-fast": false,
        "max-parallel": 2,
        "matrix": {
          "host": "${{ fromJSON(inputs.diagnostic_attach && '[\"2026.10.4\"]' || '[\"2026.5.12\",\"2026.9.8\",\"2026.10.4\"]') }}"
        }
      },
      "steps": [
        {
          "uses": "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          "with": {
            "path": "tooling",
            "ref": "${{ github.sha }}",
            "persist-credentials": false
          }
        },
        {
          "uses": "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          "with": {
            "node-version": "24.16.0"
          }
        },
        {
          "name": "先检查完整SHA（仅plan，无安装/GUI；不插值到shell）",
          "shell": "pwsh",
          "env": {
            "CANDIDATE_SHA": "${{ inputs.candidate_sha }}",
            "DIAGNOSTIC_ATTACH": "${{ inputs.diagnostic_attach }}"
          },
          "run": "if (@('true','false') -cnotcontains $env:DIAGNOSTIC_ATTACH) { throw 'Invalid diagnostic boolean' }\nif ($env:DIAGNOSTIC_ATTACH -eq 'true') {\n  node tooling/scripts/test-weixin-windows-qualification.mjs --plan --diagnostic-attach --sha \"$env:CANDIDATE_SHA\"\n} else {\n  node tooling/scripts/test-weixin-windows-qualification.mjs --plan --sha \"$env:CANDIDATE_SHA\"\n}\nexit $LASTEXITCODE\n"
        },
        {
          "uses": "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          "with": {
            "path": "candidate",
            "ref": "${{ inputs.candidate_sha }}",
            "persist-credentials": false
          }
        },
        {
          "name": "${{ inputs.diagnostic_attach && '仅10.4 W3C attach诊断（永不资格化）' || '真实VM资格后私有安装、同SHA no-bundle/W3C UI及来源负向' }}",
          "shell": "pwsh",
          "env": {
            "CANDIDATE_SHA": "${{ inputs.candidate_sha }}",
            "OPENCLAW_HOST_VERSION": "${{ matrix.host }}",
            "QUALIFICATION_SCOPE": "${{ inputs.scope }}",
            "DIAGNOSTIC_ATTACH": "${{ inputs.diagnostic_attach }}"
          },
          "run": "node --input-type=module -e @'\nimport assert from 'node:assert/strict'\nimport { spawnSync } from 'node:child_process'\nconst env = process.env, diagnostic = env.DIAGNOSTIC_ATTACH\nassert.ok(['true', 'false'].includes(diagnostic), 'Invalid diagnostic boolean')\nif (diagnostic === 'true') assert.equal(env.OPENCLAW_HOST_VERSION, '2026.10.4', '诊断只允许10.4')\nconst args = ['tooling/scripts/test-weixin-windows-qualification.mjs', '--execute', '--root', 'candidate', '--sha', env.CANDIDATE_SHA, '--host', env.OPENCLAW_HOST_VERSION]\nif (diagnostic === 'true') args.push('--diagnostic-attach')\nelse args.push('--scope', env.QUALIFICATION_SCOPE)\nargs.push('--output', env.RUNNER_TEMP + '/weixin-native-' + env.OPENCLAW_HOST_VERSION)\nconst child = spawnSync(process.execPath, args, { stdio: 'inherit', env })\nif (child.error) throw child.error\nprocess.exit(child.status ?? 1)\n'@\nexit $LASTEXITCODE\n"
        },
        {
          "name": "摘要保留partial/未执行负向，不按job绿灯宣称完整",
          "if": "always()",
          "shell": "pwsh",
          "env": {
            "OPENCLAW_HOST_VERSION": "${{ matrix.host }}",
            "DIAGNOSTIC_ATTACH": "${{ inputs.diagnostic_attach }}"
          },
          "run": "node --input-type=module -e @'\nimport assert from 'node:assert/strict'\nimport fs from 'node:fs'\nimport path from 'node:path'\nconst env = process.env, diagnostic = env.DIAGNOSTIC_ATTACH\nassert.ok(['true', 'false'].includes(diagnostic), 'Invalid diagnostic boolean')\nconst append = text => fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text + '\\n')\nif (diagnostic === 'true') append(`### Weixin ${env.OPENCLAW_HOST_VERSION} — DIAGNOSTIC ONLY — NOT QUALIFIED\\nscope: diagnostic-attach; 15-case qualification NOT established.`)\nconst file = path.join(env.RUNNER_TEMP, 'weixin-native-' + env.OPENCLAW_HOST_VERSION, 'public/report.json')\nif (fs.existsSync(file)) {\n  const r = JSON.parse(fs.readFileSync(file, 'utf8'))\n  if (diagnostic === 'true') {\n    assert.equal(r.scope, 'diagnostic-attach'); assert.equal(r.executionMode, 'actual-github-hosted-windows-vm-weixin-attach-diagnostic')\n    assert.notEqual(r.status, 'pass-native'); assert.notEqual(r.nativeQualification, true)\n    if (r.status === 'diagnostic-ui-ipc-observed') assert.equal(r.nativeQualification, false)\n    append(`Observed status: ${r.status}; Candidate: ${r.candidateSha}; scope: diagnostic-attach. NOT QUALIFIED.`)\n  } else {\n    append(`### Weixin ${env.OPENCLAW_HOST_VERSION} — ${r.status}`)\n    append(`Candidate: ${r.candidateSha}; scope: ${r.scope}. UI-origin is partial, not pass-native.`)\n  }\n  for (const gap of r.gaps || []) append('- NOT EXECUTED: ' + gap)\n} else append('No admission/runtime report; NOT qualified.')\n'@\nexit $LASTEXITCODE\n"
        },
        {
          "uses": "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
          "if": "always()",
          "with": {
            "name": "weixin-native-${{ matrix.host }}-${{ inputs.candidate_sha }}-${{ inputs.diagnostic_attach && 'diagnostic-attach-never-qualification' || inputs.scope }}",
            "path": "${{ runner.temp }}/weixin-native-${{ matrix.host }}/public/",
            "if-no-files-found": "warn",
            "retention-days": 14,
            "include-hidden-files": false
          }
        }
      ]
    }
  }
}
const baselineHashes = {
  "tests/weixin-attach-workflow.test.js": "a5a72d116fb34134e20c93dbf8a22d850d57cb935450ebd86c55cb87273d5baa",
  "scripts/test-weixin-windows-qualification.mjs": "7775c9077909c171299010711c903755e502b8dcf0466c00e2e097237cac08e8",
  "scripts/weixin-native-token-observation.mjs": "9814365ca67d450552663fdbf398689825eff2891e66f27185464ced4d379665",
  "tests/weixin-native-token-observation.test.js": "f5ad5ce02923de73617a5f58489f740390faadf5427d3a26f0529ca421a1472a"
}
const select = w => ({ plan: w.jobs.native.steps.find(s => s.name?.startsWith('先检查完整SHA')), execute: w.jobs.native.steps.find(s => s.env?.QUALIFICATION_SCOPE), summary: w.jobs.native.steps.find(s => s.if === 'always()' && s.run) })
const steps = select(workflow), oldSteps = select(original)
function inline(step) {
  const m = /node --input-type=module -e @'\r?\n([\s\S]+?)\r?\n'@/.exec(step.run)
  assert.ok(m, 'plan/execute/summary 均须可真实运行同源 Node inline')
  return m[1]
}
function own(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wx-token-workflow-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(root)), parent); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(root, 'tooling/scripts'), { recursive: true }); fs.writeFileSync(path.join(root, 'tooling/package.json'), '{"type":"module"}')
  const harness = pathToFileURL(fileURLToPath(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url))).href
  fs.writeFileSync(path.join(root, 'tooling/scripts/test-weixin-windows-qualification.mjs'), `import fs from 'node:fs';import{parseArgs}from ${JSON.stringify(harness)};const argv=process.argv.slice(2);parseArgs(argv);fs.writeFileSync(process.env.OWN_CAPTURE,JSON.stringify({argv,nativeExecuted:false}));process.exit(23)`)
  fs.copyFileSync(new URL('../scripts/weixin-native-token-observation.mjs', import.meta.url), path.join(root, 'tooling/scripts/weixin-native-token-observation.mjs'))
  return root
}
function run(step, env, root) {
  const childEnv = { ...process.env }; delete childEnv.OBSERVE_APP_TOKEN
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v
  return spawnSync(process.execPath, ['--input-type=module', '-e', inline(step)], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 10000 })
}
function evidence(name, value) {
  if (!process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE) return
  fs.mkdirSync(process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE, { recursive: true })
  fs.writeFileSync(path.join(process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE, name + '.json'), JSON.stringify({ scope: 'own Node inline recorder / synthetic report, not VM token proof', qualificationPass: false, ...value }, null, 2), { flag: 'wx' })
}
const envFor = root => ({ CANDIDATE_SHA: 'a'.repeat(40), DIAGNOSTIC_ATTACH: 'true', OPENCLAW_HOST_VERSION: '2026.10.4', QUALIFICATION_SCOPE: 'complete', RUNNER_TEMP: root })

test('token input默认false；原workflow权限/矩阵/版本/预算/路径/actions及4旧测试字节不变', () => {
  const inputs = workflow.on.workflow_dispatch.inputs, oldInputs = original.on.workflow_dispatch.inputs
  assert.equal(inputs.observe_app_token.type, 'boolean'); assert.equal(inputs.observe_app_token.required, false); assert.equal(inputs.observe_app_token.default, false)
  const restored = structuredClone(workflow); delete restored.on.workflow_dispatch.inputs.observe_app_token
  for (let i = 0; i < job.steps.length; i++) {
    const step = restored.jobs.native.steps[i], prior = original.jobs.native.steps[i]
    if (step.run) { delete step.env.OBSERVE_APP_TOKEN; if (step === restored.jobs.native.steps.find(s => s.name?.startsWith('先检查完整SHA'))) delete step.env.OPENCLAW_HOST_VERSION; step.run = prior.run }
  }
  assert.deepEqual(restored, original)
  for (const key of Object.keys(oldInputs)) assert.deepEqual(inputs[key], oldInputs[key])
  for (const step of Object.values(steps)) assert.equal(step.env.OBSERVE_APP_TOKEN, '${{ inputs.observe_app_token }}')
  for (const [name, expectedSHA] of Object.entries(baselineHashes)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('../' + name, import.meta.url))).digest('hex'), expectedSHA, name)
  }
})

for (const phase of ['plan', 'execute']) {
  test(`${phase} 实际inline own recorder：undefined/false原argv，true显式token flag，原exit23`, t => {
    const root = own(t), rows = []
    for (const [value, diagnostic, host] of [[undefined, 'true', '2026.10.4'], ['false', 'true', '2026.10.4'], [undefined, 'false', '2026.5.12'], ['false', 'false', '2026.9.8'], ['false', 'false', '2026.10.4'], ['true', 'true', '2026.10.4']]) {
      const env = { ...envFor(root), OBSERVE_APP_TOKEN: value, DIAGNOSTIC_ATTACH: diagnostic, OPENCLAW_HOST_VERSION: host, OWN_CAPTURE: path.join(root, `${phase}-${rows.length}.json`) }
      const r = run(steps[phase], env, root); assert.equal(r.status, 23, r.stderr)
      const actual = JSON.parse(fs.readFileSync(env.OWN_CAPTURE, 'utf8'))
      const args = phase === 'plan' ? ['--plan'] : ['--execute', '--root', 'candidate', '--sha', env.CANDIDATE_SHA, '--host', host]
      if (diagnostic === 'true') args.push('--diagnostic-attach'); else if (phase === 'execute') args.push('--scope', env.QUALIFICATION_SCOPE)
      if (value === 'true') args.push('--observe-app-token')
      if (phase === 'plan') args.push('--sha', env.CANDIDATE_SHA); else args.push('--output', root + '/weixin-native-' + host)
      assert.deepEqual(actual, { argv: args, nativeExecuted: false })
      rows.push({ value: value ?? 'undefined', diagnostic, host, actual, childExit: r.status })
    }
    evidence(phase + '-argv', { rows })
  })
  test(`${phase} 坏bool/true无diag/非10.4在child前拒绝`, t => {
    const root = own(t), rows = []
    for (const patch of [{ OBSERVE_APP_TOKEN: '' }, { OBSERVE_APP_TOKEN: 'TRUE' }, { OBSERVE_APP_TOKEN: '1' }, { OBSERVE_APP_TOKEN: 'true ' }, { OBSERVE_APP_TOKEN: 'null' }, { OBSERVE_APP_TOKEN: 'true', DIAGNOSTIC_ATTACH: 'false' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.9.8' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.5.12' }]) {
      const env = { ...envFor(root), ...patch, OWN_CAPTURE: path.join(root, `${phase}-bad-${rows.length}.json`) }, r = run(steps[phase], env, root)
      assert.notEqual(r.status, 0); assert.equal(fs.existsSync(env.OWN_CAPTURE), false, '不得先运行child再验证')
      rows.push({ patch, status: r.status, noChild: true })
    }
    evidence(phase + '-rejects', { rows })
  })
}

function tokenReport() {
  const date = '2026-10-17T01:00:00.0000000Z', ticks = String(BigInt(Date.parse(date)) * 10000n + 116444736000000000n)
  const subject = (pid, parentPid, exe) => ({ pid, parentPid, exe, cimCreationUtc: date, fileTimeCreationUtc: date, cimFileTimeTicks: ticks, fileTimeTicks: ticks, delta100ns: 0, birthComparison: 'same-cim-microsecond', userSid: 'S-1-5-21-1-2-3-1001', integritySid: 'S-1-16-8192', integrityRid: 8192, isElevated: false, elevationType: 3, tokenType: 1, sessionId: 1, uiAccess: false, linked: { state: 'present', exists: true } })
  return { status: 'diagnostic-ui-ipc-observed', scope: 'diagnostic-attach', executionMode: 'actual-github-hosted-windows-vm-weixin-attach-diagnostic', nativeQualification: false, candidateSha: 'a'.repeat(40), gaps: ['native: NOT EXECUTED'], diagnostic: { tokenObservationRequested: true, application: 'C:\\owned\\clawpanel.exe', appSpawnStartedAt: date, appIdentity: { pid: 1002, exe: 'C:\\owned\\clawpanel.exe', creationDate: date }, tokenObservation: { mode: 'readonly-win32-process-primary-token', neverQualification: true, app: subject(1002, 1001, 'C:\\owned\\clawpanel.exe'), parent: subject(1001, 1000, 'C:\\owned\\node.exe') } } }
}
function reportFile(root) { const dir = path.join(root, 'weixin-native-2026.10.4/public'); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, 'report.json') }
function storedReceipts(root) {
  // 使用未改动80eef的实际ownership producer生成形状；数据仍为合成负控，不是假冒VM原件。
  const report = tokenReport(), d = report.diagnostic, born = Date.parse(d.appIdentity.creationDate)
  const ownership = createAttachOwnership({ output: 'C:\\owned', application: d.application, driver: 'C:\\owned\\driver.exe', runtimePath: 'C:\\runtime\\webview.exe', userDataFolder: 'C:\\owned\\udd', pending: new Set() })
  const child = Object.assign(new EventEmitter(), { pid: d.appIdentity.pid, exitCode: null, signalCode: null })
  ownership.start(child, d.application, born - 2, born + 5)
  ownership.observe({ processes: [d.appIdentity], present: [], listeners: [] })
  const folder = path.dirname(reportFile(root))
  fs.writeFileSync(path.join(folder, 'runner-proof.json'), JSON.stringify({ sid: 'S-1-5-21-1-2-3-1001' }))
  fs.writeFileSync(path.join(folder, 'attach-spawn-ownership.json'), JSON.stringify(ownership.receipt()))
  return folder
}

test('requested summary：完整存储proof才标observed，缺/坏/矛盾proof和无report均红且neverqualification', t => {
  const root = own(t), file = reportFile(root), rows = []
  storedReceipts(root)
  const mutations = [null, r => delete r.diagnostic.tokenObservation, r => r.diagnostic.tokenObservation = { mode: 'readonly-win32-process-primary-token', neverQualification: true }, r => r.diagnostic.tokenObservationRequested = false, r => r.diagnostic.tokenObservation.neverQualification = false, r => r.diagnostic.tokenObservation.app.pid++, r => r.diagnostic.tokenObservation.parent.userSid += '9', r => r.diagnostic.tokenObservation.app.environment = {}, r => r.diagnostic.appIdentity.creationDate = '2026-10-17T01:00:01.0000000Z', r => r.nativeQualification = true, r => r.status = 'pass-native']
  for (const mutation of mutations) {
    const report = tokenReport(); if (mutation) mutation(report); fs.writeFileSync(file, JSON.stringify(report))
    const summary = path.join(root, `requested-${rows.length}.md`), r = run(steps.summary, { ...envFor(root), OBSERVE_APP_TOKEN: 'true', GITHUB_STEP_SUMMARY: summary }, root)
    const text = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : ''
    assert.equal(r.status === 0, mutation === null, r.stderr)
    assert.ok(text.includes('neverQualification=true') && text.includes('NOT QUALIFIED'))
    assert.equal(text.includes('Token proof observed:'), mutation === null)
    if (mutation) assert.ok(!text.includes('Observed status:'))
    rows.push({ mutation: mutation ? mutation.toString() : 'synthetic full receipt; not actual VM token', status: r.status, text })
  }
  fs.unlinkSync(file)
  const summary = path.join(root, 'missing.md'), r = run(steps.summary, { ...envFor(root), OBSERVE_APP_TOKEN: 'true', GITHUB_STEP_SUMMARY: summary }, root)
  assert.notEqual(r.status, 0); assert.ok(!fs.readFileSync(summary, 'utf8').includes('Token proof observed:'))
  for (const patch of [{ OBSERVE_APP_TOKEN: '' }, { OBSERVE_APP_TOKEN: 'TRUE' }, { OBSERVE_APP_TOKEN: 'true', DIAGNOSTIC_ATTACH: 'false' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.9.8' }]) assert.notEqual(run(steps.summary, { ...envFor(root), ...patch, GITHUB_STEP_SUMMARY: summary }, root).status, 0)
  evidence('requested-summary', { rows, missingReportRejected: true })
})

test('requested summary绑定原runner-proof SID与实际80eef ownership receipt形状，拒绝循环SID/缺receipt/错spawn', t => {
  const root = own(t), file = reportFile(root), rows = []
  const mutateJSON = (folder, name, mutate) => { const f = path.join(folder, name), value = JSON.parse(fs.readFileSync(f, 'utf8')); mutate(value); fs.writeFileSync(f, JSON.stringify(value)) }
  for (const [name, change] of [
    ['source-derived producer shape', () => {}],
    ['both token SIDs foreign', (folder, r) => { r.diagnostic.tokenObservation.app.userSid = r.diagnostic.tokenObservation.parent.userSid = 'S-1-5-21-1-2-3-9999' }],
    ['runner receipt missing', folder => fs.unlinkSync(path.join(folder, 'runner-proof.json'))],
    ['runner SID wrong', folder => mutateJSON(folder, 'runner-proof.json', r => { r.sid = 'S-1-5-21-1-2-3-9999' })],
    ['spawn receipt missing', folder => fs.unlinkSync(path.join(folder, 'attach-spawn-ownership.json'))],
    ['spawn window wrong', folder => mutateJSON(folder, 'attach-spawn-ownership.json', r => { r[0].startedAt += 1000; r[0].returnedAt += 1000 })],
    ['spawn proof birth wrong', folder => mutateJSON(folder, 'attach-spawn-ownership.json', r => { r[0].proof.creationDate = '2026-10-17T01:00:01.0000000Z' })],
    ['spawn duplicate', folder => mutateJSON(folder, 'attach-spawn-ownership.json', r => r.push(structuredClone(r[0])))],
  ]) {
    const folder = storedReceipts(root), r = tokenReport(); change(folder, r); fs.writeFileSync(file, JSON.stringify(r))
    const summary = path.join(root, `stored-${rows.length}.md`), result = run(steps.summary, { ...envFor(root), OBSERVE_APP_TOKEN: 'true', GITHUB_STEP_SUMMARY: summary }, root)
    assert.equal(result.status === 0, rows.length === 0, name + ': ' + result.stderr)
    const text = fs.readFileSync(summary, 'utf8'); assert.equal(text.includes('Token proof observed:'), rows.length === 0)
    rows.push({ name, status: result.status, text })
  }
  assert.ok(rows[0].text.includes('stored validated harness receipt only'))
  evidence('stored-source-binding', { rows, receiptShape: 'actual createAttachOwnership producer; synthetic values only' })
})

test('undefined/false summary：与80eef原inline逐字相同，token报告字段不默默变成observed', t => {
  const root = own(t), file = reportFile(root), rows = []
  for (const observe of [undefined, 'false']) for (const diagnostic of ['false', 'true']) {
    fs.writeFileSync(file, JSON.stringify(diagnostic === 'true' ? tokenReport() : { status: 'failed', scope: 'complete', candidateSha: 'a'.repeat(40), gaps: ['old gap'] }))
    const env = { ...envFor(root), DIAGNOSTIC_ATTACH: diagnostic, OBSERVE_APP_TOKEN: observe }, a = path.join(root, `new-${rows.length}.md`), b = path.join(root, `old-${rows.length}.md`)
    const now = run(steps.summary, { ...env, GITHUB_STEP_SUMMARY: a }, root), old = run(oldSteps.summary, { ...env, GITHUB_STEP_SUMMARY: b }, root)
    assert.equal(now.status, old.status); assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b)); assert.ok(!fs.readFileSync(a, 'utf8').includes('Token proof observed:'))
    rows.push({ observe: observe ?? 'undefined', diagnostic, byteEqual: true })
  }
  evidence('disabled-summary', { rows })
})
