import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import YAML from 'yaml'

// 先保留真实faefa26清理时序红灯；CI必须导出完整自有fixture材料，不能只留错误枚举刷重跑。
test('CI在原Node入口前准备自有证据目录，失败也只上传受控bounds报告，不改权限或测试命令', () => {
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')), job = ci.jobs.check
  assert.equal(ci.permissions.contents, 'read')
  assert.equal(job.env?.HERMES_BOUNDS_TEST_EVIDENCE, undefined, 'runner context在step作用域使用，不放入job env')
  const node = job.steps.findIndex(s => s.name === 'Node 单元测试'), setup = job.steps.findIndex(s => s.name === '准备 CLI 自有夹具诊断目录')
  assert.ok(setup >= 0 && setup < node)
  for (const index of [setup, node]) assert.equal(job.steps[index].env?.HERMES_BOUNDS_TEST_EVIDENCE, '${{ runner.temp }}/hermes-bounds-ci')
  assert.equal(job.steps[node].run, 'node --test tests/*.test.js')
  assert.equal(job.steps[node]['continue-on-error'], undefined)
  assert.ok(job.steps[setup].run.includes('fs.mkdirSync(process.env.HERMES_BOUNDS_TEST_EVIDENCE'))
  const upload = job.steps.find(s => s.name === '保留 CLI 自有夹具失败现场')
  assert.equal(upload?.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
  assert.equal(upload.if, 'always()')
  assert.equal(upload.with.path, '${{ runner.temp }}/hermes-bounds-ci/bounds-http-report.json')
  assert.equal(upload.with['include-hidden-files'], false)
  assert.equal(upload.with['retention-days'], 7)
  assert.equal(job.steps.find(s => s.name === '安装 Node.js').with['node-version'], '22.22.3')
})

// 失败清单：gate前材料未上传、路径扩大、条件依赖成功、action漂移、隐藏文件/权限扩大、原入口或门禁被改。
test('CI独立保留清理gate前的单个JSON，失败也上传且不扩大证据范围', () => {
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const uploads = ci.jobs.check.steps.filter(s => s.uses?.startsWith('actions/upload-artifact@'))
  const upload = uploads.find(s => s.with?.path === '${{ runner.temp }}/hermes-bounds-ci/cleanup-own-node-before-gate.json')
  assert.ok(upload, '缺少独立的 cleanup-own-node-before-gate.json artifact')
  assert.deepEqual(upload, {
    name: '保留 CLI 清理门禁前自有回执',
    if: 'always()',
    uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    with: {
      name: 'hermes-cli-cleanup-before-gate-${{ runner.os }}-${{ github.sha }}',
      path: '${{ runner.temp }}/hermes-bounds-ci/cleanup-own-node-before-gate.json',
      'if-no-files-found': 'warn',
      'include-hidden-files': false,
      'retention-days': 7,
    },
  })
  assert.equal(uploads.length, 2, '原bounds报告与gate前材料必须独立，不能改成目录打包')
  assert.equal(new Set(uploads.map(s => s.with.name)).size, 2)
  assert.deepEqual(ci.permissions, { contents: 'read' })
  assert.equal(ci.jobs.check.permissions, undefined)
})

test('新增诊断上传不改变七项必需检查、原bounds形状和Node环境', () => {
  const job = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs.check
  const required = {
    'Node 单元测试': 'node --test tests/*.test.js',
    'Pi 真实运行时协议验收': 'node scripts/test-pi-runtime.mjs',
    '前端构建验证': 'npm run build',
    'Rust 格式检查': 'cargo fmt --all -- --check',
    'Rust 编译检查': 'cargo check --locked',
    'Rust Clippy': 'cargo clippy --locked --all-targets -- -D warnings',
    'Rust 单元测试': 'cargo test --locked',
  }
  for (const [name, run] of Object.entries(required)) {
    const step = job.steps.find(s => s.name === name)
    assert.equal(step?.run, run)
    assert.equal(step.if, undefined, name + '不能变成条件跳过')
    assert.equal(step['continue-on-error'], undefined, name + '失败必须保留')
  }
  assert.equal(job['continue-on-error'], undefined)
  assert.equal(job.env, undefined)
  assert.deepEqual(job.steps.find(s => s.name === 'Node 单元测试').env, { HERMES_BOUNDS_TEST_EVIDENCE: '${{ runner.temp }}/hermes-bounds-ci' })
  assert.deepEqual(job.steps.find(s => s.name === '保留 CLI 自有夹具失败现场'), {
    name: '保留 CLI 自有夹具失败现场', if: 'always()',
    uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    with: { name: 'hermes-cli-bounds-${{ runner.os }}-${{ github.sha }}', path: '${{ runner.temp }}/hermes-bounds-ci/bounds-http-report.json', 'if-no-files-found': 'warn', 'include-hidden-files': false, 'retention-days': 7 },
  })
})

test('现有gate前JSON只投影自有PID时序与原生身份，不新增env或CommandLine', () => {
  const source = fs.readFileSync(new URL('./hermes-cli-cleanup-identity.test.js', import.meta.url), 'utf8')
  const observer = fs.readFileSync(new URL('../scripts/hermes-cli-bounds-observation.mjs', import.meta.url), 'utf8')
  const nativeFields = ['pid', 'status', 'executablePath', 'creationTimeFileTimeHex', 'createdAtMs', 'exitAtMs', 'sampledAtMs', 'queryStartedAtMs', 'queryCompletedAtMs', 'nativeError', 'imageQueryError', 'waitResult']
  const row = observer.match(/\$row = \[ordered\]@\{([^}\r\n]+)\}/)
  assert.ok(row, '必须仍是固定原生字段投影')
  assert.deepEqual(row[1].split(';').map(s => s.split('=')[0]), nativeFields)
  for (const [, field] of observer.matchAll(/\$row\.(\w+)\s*=/g)) assert.ok(nativeFields.includes(field), '新增原生字段：' + field)
  const start = source.match(/^  const start = (\{ event: 'start',[^\r\n]+\})$/m)
  const material = source.match(/^  const m = (\{ events: \[start\],[\s\S]*?observerErrors: \[\] \})$/m)
  assert.ok(start && material)
  // 仅执行已提取的纯对象表达式；不启动子进程、不调用observer或任何PID查询。
  const json = vm.runInNewContext(`const start = ${start[1]}; JSON.stringify(${material[1]})`, {
    child: { pid: 123 }, process: { hrtime: { bigint: () => 1000000n } },
    historyNativeRows: [], cleanupNativeRows: [], observer: true, nativeCompletedAtMs: 10,
    alive: false, errorCode: 'ESRCH', startedAtMs: 11, completedAtMs: 12, startedAtNs: '11000000', completedAtNs: '12000000',
  }, { timeout: 1000 })
  const m = JSON.parse(json)
  assert.deepEqual(Object.keys(m), ['events', 'historyNativeRows', 'cleanupNativeRows', 'rawProbes', 'rawOrder', 'observerErrors'])
  assert.deepEqual(Object.keys(m.events[0]), ['event', 'pid', 'name', 'birthId', 'at', 'monotonicMs'])
  assert.deepEqual(Object.keys(m.rawProbes[0]), ['pid', 'alive', 'errorCode', 'startedAtMs', 'completedAtMs', 'startedAtNs', 'completedAtNs'])
  assert.deepEqual(Object.keys(m.rawOrder), ['kind', 'nativeCompletedAtMs', 'startedAtMs', 'completedAtMs'])
  assert.match(source, /'cleanup-own-node-before-gate\.json'\), JSON\.stringify\(m, null, 2\)\)\r?\n  const result = await gate\(m, !!observer\)/)
})
