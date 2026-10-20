import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workflow = fs.readFileSync(path.join(root, '.github/workflows/maintenance.yml'), 'utf8')
const verifier = path.join(root, 'scripts/maintenance-runtime-smoke.mjs')
const source = fs.readFileSync(verifier, 'utf8')

test('可信实装矩阵包含既有两项及 OpenCode、DSH 默认和预览，保持手工 main 门禁', () => {
  const job = workflow.split('\n  runtime-selftest:')[1]?.split('\n  scan:')[0] || ''
  const engines = job.match(/engine:\s*\[([^\]]+)\]/)?.[1].split(',').map(s => s.trim())
  assert.deepEqual(engines, ['openclaw', 'hermes', 'opencode', 'deepseek-harness', 'deepseek-harness-preview'])
  assert.match(job, /github\.event_name == 'workflow_dispatch'.*inputs\.runtime_selftest/)
  assert.match(job, /github\.ref == 'refs\/heads\/main'/)
  assert.match(job, /--cap-drop=ALL --security-opt=no-new-privileges/)
  assert.match(job, /dst=\/tooling,readonly/)
  assert.doesNotMatch(job, /secrets\.|GH_TOKEN|GITHUB_TOKEN|--privileged|docker\.sock/)
})

test('parent 请求容器验收时，所有引擎均先核验真实隔离事实，再创建 Web 或安装进程', async t => {
  const stage = source.split("await stage('isolation'")[1]?.split("await stage('web'")[0] || ''
  // 先检查门禁存在；红灯阶段不得让负向测试误启动宿主安装。
  assert.match(stage, /if \(process\.env\.MAINTENANCE_ISOLATED_RUNTIME === '1'\) requireInstallContainer\(\)/)
  // macOS 的 /var 临时目录是链接；使用物理目录，不放宽验收器的祖先链接门禁。
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawpanel-runtime-guard-'))
  try {
    for (const engine of ['pi', 'openclaw', 'hermes', 'opencode', 'deepseek-harness', 'deepseek-harness-preview']) {
      await t.test(engine, () => {
        const output = path.join(temp, engine)
        const run = spawnSync(process.execPath, [verifier, '--root', root, '--engine', engine, '--output', output], {
          env: { ...process.env, MAINTENANCE_ISOLATED_RUNTIME: '1', DOCKER_HOST: 'disabled-by-negative-test' },
          encoding: 'utf8', timeout: 30000, windowsHide: true,
        })
        assert.equal(run.status, 1, run.stdout + run.stderr)
        assert.ok(fs.existsSync(path.join(output, 'report.json')), run.stdout + run.stderr)
        const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
        assert.equal(report.environment.installContainerProof.noDockerSocket, false)
        assert.equal(report.cases.find(c => c.name === 'isolation').status, 'missing')
        for (const name of ['web', 'install', 'runtime-health', 'chat']) assert.equal(report.cases.find(c => c.name === name).status, 'missing')
        const commands = JSON.parse(fs.readFileSync(path.join(output, 'commands.json'), 'utf8'))
        assert.equal(commands.length, 0, '隔离门禁失败前不应启动任何外部命令')
      })
    }
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(temp))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
