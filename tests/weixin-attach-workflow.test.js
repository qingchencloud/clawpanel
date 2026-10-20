// 先红后接线：真实Node执行workflow内联JS；仅自有CLI recorder，不执行安装器/GUI或模拟native成功。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const source = fs.readFileSync(new URL('../.github/workflows/weixin-qualification.yml', import.meta.url), 'utf8')
const workflow = parse(source), job = workflow.jobs.native, inputs = workflow.on.workflow_dispatch.inputs
const execute = job.steps.find(s => s.env?.QUALIFICATION_SCOPE), summary = job.steps.find(s => s.if === 'always()' && s.run)
const evidence = (name, value) => {
  if (process.env.CLAWPANEL_WEIXIN_WORKFLOW_EVIDENCE) {
    const out = path.resolve(process.env.CLAWPANEL_WEIXIN_WORKFLOW_EVIDENCE); fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  }
}
function inline(run) {
  const match = /node --input-type=module -e @'\r?\n([\s\S]+?)\r?\n'@/.exec(run)
  assert.ok(match, 'workflow必须保留可实际执行的同源Node selector/summary')
  return match[1]
}
function ownRoot() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-workflow-contract-')))
}
function runJS(program, env, cwd) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
}

test('workflow手工诊断input/matrix必须精确单10.4，false保留原三host/scope', () => {
  assert.deepEqual(inputs.diagnostic_attach, { description: '仅10.4 W3C attach诊断，永不作为15case资格通过', type: 'boolean', required: false, default: false })
  assert.equal(inputs.scope.default, 'complete'); assert.deepEqual(inputs.scope.options, ['complete', 'ui-origin'])
  const matrix = job.strategy.matrix.host
  assert.equal(typeof matrix, 'string')
  const m = /^\$\{\{ fromJSON\(inputs\.diagnostic_attach && '([^']+)' \|\| '([^']+)'\) \}\}$/.exec(matrix)
  assert.ok(m, '仅允许boolean选择两份固定host清单')
  assert.deepEqual(JSON.parse(m[1]), ['2026.10.4']); assert.deepEqual(JSON.parse(m[2]), ['2026.5.12', '2026.9.8', '2026.10.4'])
  assert.equal(execute.env.DIAGNOSTIC_ATTACH, '${{ inputs.diagnostic_attach }}')
  assert.ok(job.name.includes('diagnostic-attach') && job.name.includes('NEVER qualification'))
  const upload = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'))
  assert.ok(upload.with.name.includes("inputs.diagnostic_attach && 'diagnostic-attach-never-qualification' || inputs.scope"))
})

test('真实内联selector E2E：true无scope，false原argv，子失败原样传播且不执行native', () => {
  const root = ownRoot(), tooling = path.join(root, 'tooling/scripts'); fs.mkdirSync(tooling, { recursive: true })
  const harnessURL = pathToFileURL(fileURLToPath(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url))).href
  fs.writeFileSync(path.join(root, 'tooling/package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(tooling, 'test-weixin-windows-qualification.mjs'), `import fs from 'node:fs';import {parseArgs} from ${JSON.stringify(harnessURL)};const argv=process.argv.slice(2);const parsed=parseArgs(argv);fs.writeFileSync(process.env.OWN_CAPTURE,JSON.stringify({scope:'owned recorder, no native execute',argv,parsed,nativeExecuted:false}));process.exit(23)`)
  const program = inline(execute.run), rows = []
  for (const [diagnostic, host, scope] of [['true', '2026.10.4', 'complete'], ['true', '2026.10.4', 'ui-origin'], ['false', '2026.5.12', 'complete'], ['false', '2026.9.8', 'complete'], ['false', '2026.10.4', 'ui-origin']]) {
    const capture = path.join(root, 'capture-' + rows.length + '.json'), env = { CANDIDATE_SHA: 'a'.repeat(40), OPENCLAW_HOST_VERSION: host, QUALIFICATION_SCOPE: scope, DIAGNOSTIC_ATTACH: diagnostic, RUNNER_TEMP: root, OWN_CAPTURE: capture }
    const r = runJS(program, env, root); assert.equal(r.status, 23, r.stderr)
    const actual = JSON.parse(fs.readFileSync(capture, 'utf8')), expected = ['--execute', '--root', 'candidate', '--sha', env.CANDIDATE_SHA, '--host', host]
    if (diagnostic === 'true') expected.push('--diagnostic-attach'); else expected.push('--scope', scope)
    expected.push('--output', root + '/weixin-native-' + host)
    assert.deepEqual(actual.argv, expected); assert.equal(actual.nativeExecuted, false)
    if (diagnostic === 'true') assert.ok(!actual.argv.includes('--scope'))
    rows.push({ diagnostic, host, scope, childExit: r.status, actual })
  }
  for (const [diagnostic, host] of [['true', '2026.9.8'], ['true', '2026.5.12'], ['TRUE', '2026.10.4'], ['1', '2026.10.4'], ['', '2026.10.4']]) {
    const capture = path.join(root, 'forbidden-' + rows.length + '.json'), r = runJS(program, { DIAGNOSTIC_ATTACH: diagnostic, OPENCLAW_HOST_VERSION: host, CANDIDATE_SHA: 'a'.repeat(40), QUALIFICATION_SCOPE: 'complete', RUNNER_TEMP: root, OWN_CAPTURE: capture }, root)
    assert.notEqual(r.status, 0); assert.equal(fs.existsSync(capture), false); rows.push({ diagnostic, host, rejectedBeforeChild: true })
  }
  evidence('selector-actual-node', { scope: 'actual Node inline program + owned CLI recorder; no native/installer', rows })
})

test('真实summary E2E：diagnostic永不资格化，伪pass/错scope/mode/qualifiedtrue红，原formal不变', () => {
  const root = ownRoot(), folder = path.join(root, 'weixin-native-2026.10.4/public'); fs.mkdirSync(folder, { recursive: true })
  const report = path.join(folder, 'report.json'), program = inline(summary.run), rows = []
  const good = { status: 'diagnostic-ui-ipc-observed', scope: 'diagnostic-attach', executionMode: 'actual-github-hosted-windows-vm-weixin-attach-diagnostic', nativeQualification: false, candidateSha: 'a'.repeat(40), gaps: ['wrong-window: not executed'] }
  for (const mutation of [null, { status: 'pass-native' }, { scope: 'complete' }, { executionMode: 'actual-github-hosted-windows-vm-weixin' }, { nativeQualification: true }]) {
    const output = path.join(root, 'summary-' + rows.length + '.md'); fs.writeFileSync(report, JSON.stringify({ ...good, ...mutation }))
    const r = runJS(program, { DIAGNOSTIC_ATTACH: 'true', OPENCLAW_HOST_VERSION: '2026.10.4', RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: output }, root)
    assert.equal(r.status === 0, mutation === null, r.stderr)
    const text = fs.readFileSync(output, 'utf8'); assert.ok(text.includes('DIAGNOSTIC ONLY') && text.includes('NOT QUALIFIED')); assert.ok(!text.includes('pass-native'))
    rows.push({ mutation, status: r.status, text })
  }
  const formal = { status: 'failed', scope: 'complete', candidateSha: 'b'.repeat(40), gaps: ['wrong-window: not executed'] }, output = path.join(root, 'formal-summary.md')
  fs.writeFileSync(report, JSON.stringify(formal)); const r = runJS(program, { DIAGNOSTIC_ATTACH: 'false', OPENCLAW_HOST_VERSION: '2026.10.4', RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: output }, root)
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(output, 'utf8'), `### Weixin 2026.10.4 — failed\nCandidate: ${formal.candidateSha}; scope: complete. UI-origin is partial, not pass-native.\n- NOT EXECUTED: wrong-window: not executed\n`)
  evidence('summary-actual-node', { scope: 'summary schema fixtures, not native results', rows, formalUnchanged: true })
})

test('保留main/readonly/pins/credentials/110min及原workflow隔离边界', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(job.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'qingchencloud/clawpanel'")
  assert.equal(job['runs-on'], 'windows-2025'); assert.equal(job['timeout-minutes'], 110)
  assert.equal(job.strategy['fail-fast'], false); assert.equal(job.strategy['max-parallel'], 2)
  assert.deepEqual(workflow.concurrency, { group: 'weixin-native-qualification', 'cancel-in-progress': false })
  assert.deepEqual(job.steps.filter(s => s.uses).map(s => s.uses), ['actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'])
  assert.ok(job.steps.filter(s => s.uses?.startsWith('actions/checkout@')).every(s => s.with['persist-credentials'] === false))
  assert.ok(job.steps.filter(s => s.run).every(s => !s.run.includes('${{')))
  const upload = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload.if, 'always()'); assert.equal(upload.with['retention-days'], 14); assert.equal(upload.with['include-hidden-files'], false)
})
