import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { spawnSync } from 'node:child_process'
import { parseArgs, qualificationStatus, spawnAuditSource, matrixFromInputs } from '../scripts/test-hermes-windows-qualification.mjs'

const load = () => import('../scripts/hermes-startup-diagnostic.mjs')
const config = { enabled: true, scope: 'diagnostic-only-not-acceptance', version: '0.22.2', pmScript: 'fixed reviewed script', pin: 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' }
const spec = () => ({ program: 'C:\\private\\python.exe', args: ['-I', '-B', '-c', config.pmScript, 'C:\\private\\source', 'C:\\private\\home', config.pin, '--', 'gateway', 'run'], options: { detached: true, windowsHide: true, env: { HOME: 'private' }, stdio: ['ignore', 7, 7] } })

test('诊断默认关闭且不是 ambient env 开关', async () => {
  const { prepareStartupDiagnosticSpawn } = await load(), original = spec()
  assert.equal(prepareStartupDiagnosticSpawn(original), original)
  assert.equal(prepareStartupDiagnosticSpawn(original, { ...config, enabled: 'true' }), original)
  assert.equal(prepareStartupDiagnosticSpawn(original, { ...config, enabled: false }), original)
})
test('spawn(program, options) 重载和无关进程保持原样', async () => {
  const { prepareStartupDiagnosticSpawn } = await load()
  for (const args of [undefined, { windowsHide: true }, ['install']]) {
    const s = { program: 'unrelated', args, options: undefined }
    assert.equal(prepareStartupDiagnosticSpawn(s, config), s)
  }
})
test('新 PM 只插入 X importtime，不改原脚本/参数/stdio/env/进程语义', async () => {
  const { prepareStartupDiagnosticSpawn } = await load(), original = spec(), result = prepareStartupDiagnosticSpawn(original, config)
  assert.deepEqual(result.args, ['-I', '-B', '-X', 'importtime', ...original.args.slice(2)])
  assert.equal(result.options, original.options); assert.equal(result.program, original.program)
  assert.equal(original.args.includes('-X'), false)
})
test('新 PM 拒绝固定脚本或 pin 错配，而非移除 PM guards', async () => {
  const { prepareStartupDiagnosticSpawn } = await load()
  for (const index of [3, 6]) { const s = spec(); s.args[index] = 'changed'; assert.throws(() => prepareStartupDiagnosticSpawn(s, config), /contract/) }
})
test('非 Gateway spawn 不受诊断影响，metadata/install/profile 探针不注入', async () => {
  const { prepareStartupDiagnosticSpawn } = await load()
  for (const words of [['profile', 'list'], ['--version'], ['gateway', 'stop']]) {
    const s = spec(); s.args = [...s.args.slice(0, 8), ...words]; assert.equal(prepareStartupDiagnosticSpawn(s, config), s)
  }
})
test('旧 Gateway 仅显式 Python importtime 环境，不改 CLI、命令或原 options', async () => {
  const { prepareStartupDiagnosticSpawn } = await load(), s = { program: 'hermes', args: ['gateway', 'run'], options: { env: { HOME: 'private' }, stdio: ['ignore', 3, 3], detached: true } }
  const result = prepareStartupDiagnosticSpawn(s, { enabled: true, scope: config.scope, version: '0.21.5' })
  assert.deepEqual(result.options.env, { HOME: 'private', PYTHONPROFILEIMPORTTIME: '1' }); assert.equal(s.options.env.PYTHONPROFILEIMPORTTIME, undefined)
  assert.equal(result.args, s.args); assert.equal(result.program, s.program); assert.equal(result.options.stdio, s.options.stdio); assert.equal(result.options.detached, true)
})
test('诊断 command line 超出 Windows 32767 限制时失败', async () => {
  const { prepareStartupDiagnosticSpawn } = await load(), s = spec(); s.args[4] = 'x'.repeat(32767)
  assert.throws(() => prepareStartupDiagnosticSpawn(s, config), /32767/)
})
test('仅 execute 可显式选择诊断，诊断报告永不满足完整资格', () => {
  assert.equal(parseArgs(['--execute', '--startup-diagnostic'])['--startup-diagnostic'], true)
  assert.throws(() => parseArgs(['--plan', '--startup-diagnostic']), /execute/)
  const gatewayStatusReadback = { schemaVersion: 1, status: 'passed', requestFailed: false, api: { cmd: 'hermes_gateway_action', status: 200, result: 'Gateway is running (PID: 1234)' }, exec: [
    { event: 'execFile-start', callId: 1, pid: 1234, utc: '2026-10-16T22:36:18.419Z', command: ['gateway', 'status'] },
    { event: 'execFile-result', callId: 1, pid: 1234, utc: '2026-10-16T22:36:19.419Z', source: 'callback', error: null, code: null, signal: null, killed: false, stdout: 'Gateway is running (PID: 1234)', stdoutTruncated: false },
    { event: 'execFile-close', callId: 1, pid: 1234, utc: '2026-10-16T22:36:19.420Z', error: null, code: 0, signal: null, killed: false },
  ] }
  assert.equal(qualificationStatus({ diagnostic: { enabled: true }, hostUnchanged: true, stages: ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' })), browser: { actualChromium: true }, nativeTauri: { status: 'passed', qualificationComplete: true }, gatewayStatusReadback }), 'diagnostic-only-not-qualification')
})
test('诊断只允许运行 Windows，不准以 Linux 全 skipped 完成', () => {
  assert.throws(() => matrixFromInputs({ TARGET: 'baseline', BASELINE_SHA: 'a'.repeat(40), PLATFORM: 'linux', STARTUP_DIAGNOSTIC: 'true' }), /Windows/)
})
test('workflow 默认 false，诊断显式传参，native/Linux 不混入诊断资格', () => {
  const w = YAML.parse(fs.readFileSync('.github/workflows/hermes-qualification.yml', 'utf8'))
  assert.deepEqual(w.on.workflow_dispatch.inputs.startup_diagnostic, { description: '仅 Windows 冷启动观测，不构成资格通过；保留原20秒判定', type: 'boolean', default: false })
  const web = w.jobs.qualify.steps.find(s => s.id === 'web')
  assert.equal(web.env.STARTUP_DIAGNOSTIC, '${{ inputs.startup_diagnostic }}')
  assert.match(web.run, /--startup-diagnostic/)
  for (const id of ['native_environment', 'native_build', 'native']) assert.match(w.jobs.qualify.steps.find(s => s.id === id)?.if || '', /!inputs.startup_diagnostic/)
  assert.equal(w.jobs.qualify.steps.find(s => s.id === 'native_summary').if, 'always()')
  assert.match(w.jobs['linux-long-ui'].if, /!inputs.startup_diagnostic/)
})
test('只有完成真实 runner 准入才注入配置；pyc 在已核 completion 后只读', () => {
  const s = fs.readFileSync('scripts/test-hermes-windows-qualification.mjs', 'utf8')
  assert.match(s, /observeHermesPythonCache/)
  assert.match(s, /--startup-diagnostic/)
  assert.ok(s.indexOf('validateRunnerProof(proof)') < s.indexOf("write('startup-diagnostic-config.json'"))
  const audit = spawnAuditSource('audit.jsonl', { configFile: path.resolve('diagnostic.json') })
  assert.match(audit, /prepareStartupDiagnosticSpawn/)
  assert.match(audit, /diagnostic.json/)
})

test('宿主 canary 缺失或变化时诊断也必须失败', () => {
  for (const hostUnchanged of [undefined, false]) assert.equal(qualificationStatus({ diagnostic: { enabled: true }, hostUnchanged }), 'failed')
})

test('二级堆栈采样显式开启，仅新 PM 候选；原 args/script 不改写', async () => {
  const { prepareStartupDiagnosticSpawn } = await load(), s = spec(), result = prepareStartupDiagnosticSpawn(s, { ...config, stackSampling: true })
  assert.match(result.args[5], /dump_traceback_later\(2, repeat=True\)/)
  assert.ok(result.args[5].endsWith(s.args[3])); assert.equal(s.args[3], config.pmScript)
  assert.match(result.args[5], /daemon=True/); assert.match(result.args[5], /Timer\(60,/)
  assert.throws(() => matrixFromInputs({ TARGET: 'baseline', BASELINE_SHA: 'a'.repeat(40), PLATFORM: 'windows', STARTUP_DIAGNOSTIC: 'true', STARTUP_STACK_SAMPLES: 'true' }), /candidate/)
  assert.equal(parseArgs(['--execute', '--startup-diagnostic', '--startup-stack-samples'])['--startup-stack-samples'], true)
  assert.throws(() => parseArgs(['--execute', '--startup-stack-samples']), /diagnostic/)
})

test('实际 Python 栈采样不等待60秒、不替换 exit7，提供主线程 PID 映射', { timeout: 10000 }, async () => {
  // 采样目标须正在执行 Python：Windows hosted 的原生 sleep 实测可能只有 <no Python frame>。
  // 保留原2秒采样、2.3秒目标、exit7及全部预算，不用接受空栈替代主线程取证。
  const { prepareStartupDiagnosticSpawn } = await load(), s = spec(), script = [
    'import time',
    'def _clawpanel_fixture_sample_target():',
    '    end = time.monotonic() + 2.3',
    '    while time.monotonic() < end:',
    '        pass',
    '_clawpanel_fixture_sample_target()',
    'raise SystemExit(7)',
  ].join('\n')
  s.args[3] = script; s.program = process.env.PYTHON || 'python'
  const result = prepareStartupDiagnosticSpawn(s, { ...config, pmScript: script, stackSampling: true })
  const started = performance.now(), child = spawnSync(result.program, result.args, { windowsHide: true, encoding: 'utf8', timeout: 7000, maxBuffer: 1048576 })
  assert.equal(child.status, 7, child.stderr.slice(-1500)); assert.ok(performance.now() - started < 6000)
  assert.match(child.stderr, /CLAWPANEL_STACK_SAMPLER_MAIN \d+ 0x[0-9a-f]+/)
  assert.match(child.stderr, /Timeout \(0:00:02\)/); assert.match(child.stderr, /<string>/)
  assert.match(child.stderr, /_clawpanel_fixture_sample_target/)
})
