import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {spawn, spawnSync} from 'node:child_process'
import {once} from 'node:events'

const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
const privatePs = source.match(/function ps\(code\) \{[\s\S]*?\n\}/)[0]
const invoke = new Function('spawnSync', 'assert', 'process', `${privatePs}; return ps`)(spawnSync, assert, process)

test('资格工具声明仅在真实VM启用phase诊断，不扩原就绪或CLI预算', () => {
  const script = new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url)
  const r = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--plan'], {encoding: 'utf8', windowsHide: true, timeout: 10000})
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).startupTiming, {qualifiedVmOnly: true, acceptanceExtension: false})
  const execute = source.slice(source.indexOf('async function execute('))
  const enabled = execute.indexOf("env.CLAWPANEL_HERMES_PHASE_TIMING = '1'")
  assert.ok(enabled > execute.indexOf('validateRunnerProof(proof)') && enabled > execute.indexOf('env = isolationEnv('))
  assert.ok(enabled < execute.indexOf("write('isolationenv.json'"))
})

test('Windows PS5 输出在序列化前固定 UTF8，不改变30秒或模块隔离门禁', () => {
  assert.match(privatePs, /\[Console\]::OutputEncoding\s*=\s*(?:New-Object |\[)?(?:System\.)?Text\.UTF8Encoding/)
  assert.match(privatePs, /timeout: 30000/)
  assert.match(privatePs, /key\.toLowerCase\(\) !== 'psmodulepath'/)
})

test('真实 PS5 CIM 长多行命令保留中文弯引号，不能转成未转义ASCII双引号破坏JSON', {skip: process.platform !== 'win32'}, async () => {
  // 仅观察亲自启动的进程；不读 registry、不修改 PATH、不启动 GUI。
  const payload = '# 私有受管 “不假装清理成功”\n' + 'line "quoted" \\ Unicode 中文 Δ\n'.repeat(700)
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)', payload], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
  try {
    await once(child.stdout, 'data')
    const code = `$ErrorActionPreference='Stop';@(Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}"|Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate)|ConvertTo-Json -Depth 4`
    const result = invoke(code), row = Array.isArray(result) ? result[0] : result
    assert.equal(row.ProcessId, child.pid)
    assert.equal(row.ParentProcessId, process.pid)
    assert.ok(row.CommandLine.includes('“不假装清理成功”'))
    assert.ok(row.CommandLine.includes('中文 Δ'))
    assert.ok(row.CommandLine.length > 20000)
    assert.ok(row.CreationDate)
    assert.ok(row.ExecutablePath)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})
