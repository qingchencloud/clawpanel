// 独立诊断先红：只运行解析器和真实只读plan child，不安装内核或启动GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs, matrixFromInputs } from '../scripts/test-hermes-windows-qualification.mjs'

const sha = 'a'.repeat(40)
const mode = ['--status-tail-diagnostic', '--version', '0.22.2', '--variant', 'new', '--sha', sha]
const write = (name, value) => {
  if (!process.env.HERMES_STATUS_TAIL_MODE_EVIDENCE) return
  const root = path.resolve(process.env.HERMES_STATUS_TAIL_MODE_EVIDENCE)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' })
}

test('status尾诊断显式模式：只允许new精确版本，plan不执行，旧startup保持原契约', () => {
  assert.equal(parseArgs(['--execute', ...mode])['--status-tail-diagnostic'], true)
  assert.equal(parseArgs(['--plan', ...mode])['--status-tail-diagnostic'], true)
  for (const bad of [
    mode,
    ['--execute', ...mode, '--startup-diagnostic'],
    ['--execute', ...mode, '--startup-stack-samples'],
    ['--execute', ...mode.map(x => x === '0.22.2' ? '0.21.5' : x)],
    ['--execute', ...mode.map(x => x === 'new' ? 'old' : x)],
  ]) assert.throws(() => parseArgs(bad))
  assert.deepEqual(parseArgs(['--execute', '--startup-diagnostic']), { '--execute': true, '--startup-diagnostic': true })
  assert.deepEqual(parseArgs(['--plan']), { '--plan': true })
})

test('status尾诊断matrix只选candidate/windows，不接Linux/old/both或模糊布尔值', () => {
  const base = { TARGET: 'candidate', PLATFORM: 'windows', CANDIDATE_SHA: sha, STATUS_TAIL_DIAGNOSTIC: 'true' }
  assert.deepEqual(matrixFromInputs(base), { include: [{ variant: 'new', sha, version: '0.22.2' }] })
  for (const change of [
    { TARGET: 'baseline', BASELINE_SHA: sha }, { TARGET: 'both', BASELINE_SHA: sha },
    { PLATFORM: 'linux' }, { PLATFORM: 'both' }, { STARTUP_DIAGNOSTIC: 'true' },
    { STARTUP_STACK_SAMPLES: 'true' }, { STATUS_TAIL_DIAGNOSTIC: 'TRUE' },
    { STATUS_TAIL_DIAGNOSTIC: '1' }, { CANDIDATE_SHA: 'main' },
  ]) assert.throws(() => matrixFromInputs({ ...base, ...change }))
  assert.deepEqual(matrixFromInputs({ TARGET: 'baseline', BASELINE_SHA: sha }), { include: [{ variant: 'old', sha, version: '0.21.5' }] })
})

test('真实plan child明确neverqualification；错误pin模式在执行准入之前红，未运行内核', () => {
  const script = fileURLToPath(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  const good = run(['--plan', ...mode])
  assert.equal(good.status, 0, good.stderr)
  const report = JSON.parse(good.stdout)
  assert.equal(report.installsOnLocalHost, false)
  assert.equal(report.statusTailDiagnostic, true)
  assert.equal(report.diagnosticNeverQualifies, true)
  assert.equal(report.diagnosticScope, 'status-tail-diagnostic-only-not-qualification')
  const bad = run(['--execute', ...mode.map(x => x === '0.22.2' ? '0.21.5' : x)])
  assert.notEqual(bad.status, 0)
  assert.ok(!bad.stderr.includes('Windows 资格门禁失败'), '模式必须在宿主准入/安装前拒绝')
  write('plan-child', { scope: 'actual Node plan/parser child only; no runtime/GUI', good: { status: good.status, report }, bad: { status: bad.status, stderr: bad.stderr } })
})

test('独立手工job默认关闭，原完整native步骤与Linux门禁不变且不给诊断资格', async () => {
  const { parse } = await import('yaml')
  const w = parse(fs.readFileSync(new URL('../.github/workflows/hermes-qualification.yml', import.meta.url), 'utf8'))
  const h = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.deepEqual(w.on.workflow_dispatch.inputs.status_tail_diagnostic, { description: '仅新版Windows状态三尾诊断，永不作为发布资格', type: 'boolean', default: false })
  assert.equal(w.jobs.prepare.steps.find(s => s.id === 'matrix').env.STATUS_TAIL_DIAGNOSTIC, '${{ inputs.status_tail_diagnostic }}')
  assert.equal(h(w.jobs.qualify.steps), 'ec29e649faa5e287e1f2f95583334d0d0fbc5f93fd08dad08d013b3adb50df4d')
  assert.equal(h(w.jobs['linux-long-ui']), '74abd69f6f670f0d4fa3649f96c5e441328d02b876303ebeef13b5877d226546')
  assert.equal(w.jobs.qualify.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'qingchencloud/clawpanel' && inputs.platform != 'linux' && !inputs.status_tail_diagnostic")
  const job = w.jobs['status-tail-diagnostic']
  assert.equal(job.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'qingchencloud/clawpanel' && inputs.status_tail_diagnostic")
  assert.equal(job['runs-on'], 'windows-2025'); assert.equal(job.needs, 'prepare')
  assert.equal(job['timeout-minutes'], 35)
  assert.deepEqual(w.permissions, { contents: 'read' })
  assert.ok(job.name.includes('NEVER qualification'))
  assert.ok(job.steps.filter(s => s.uses?.startsWith('actions/checkout@')).every(s => s.with['persist-credentials'] === false))
  assert.ok(job.steps.filter(s => s.run).every(s => !s.run.includes('${{')))
  assert.ok(job.steps.find(s => s.id === 'status_tail').run.includes('--status-tail-diagnostic'))
  assert.ok(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with.name.endsWith('-never-qualification'))
})
