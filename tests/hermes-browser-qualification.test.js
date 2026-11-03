import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// 保留R19/R22/R23原始600秒红灯；官方40747修复Node24.16的zip stream生命周期，原验收预算不变。
const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')

test('Windows Web使用固定Playwright默认headless shell，只安装实际使用的Chromium构建', () => {
  assert.equal(source.match(/'playwright@(\d+\.\d+\.\d+)'/)?.[1], '1.60.0', '固定含官方40747修复的精确版本，不降Node或替换宿主浏览器')
  assert.ok(/\[path\.join\(home, 'browser-tools\/node_modules\/playwright\/cli\.js'\), 'install', '--only-shell', 'chromium'\], \{ timeout: 600000, browserDiagnostics: true \}/.test(source), '固定600秒，额外日志不放宽或替代安装完成')
  assert.match(source, /browser = await chromium\.launch\(\{ headless: true, env \}\)/)
  assert.doesNotMatch(source, /chromium\.launch\([^\n]*(?:channel|executablePath)/)
  assert.match(source, /PLAYWRIGHT_BROWSERS_PATH: path\.join\(home,/)
  assert.match(source, /context\.tracing\.start\(\{ screenshots: true, snapshots: true, sources: true \}\)/)
})

test('固定版本安装后回读实际Playwright/core和browser manifest，不以npm退出码或下载100%充数', () => {
  const installed = source.indexOf("'playwright@1.60.0'")
  const readback = source.indexOf('r.browserTooling =', installed)
  const launch = source.indexOf('browser = await chromium.launch', installed)
  assert.ok(installed >= 0 && readback > installed && launch > readback, '真实安装后、实际launch前记录来源')
  for (const field of ['playwrightVersion', 'coreVersion', 'browserManifestSha256']) assert.ok(source.includes(field), field)
  assert.ok(source.includes("assert.equal(r.browserTooling.playwrightVersion, '1.60.0')"))
  assert.ok(source.includes("assert.equal(r.browserTooling.coreVersion, '1.60.0')"))
  assert.ok(source.includes("write('browser-tooling.json', r.browserTooling)"))
})

test('浏览器安装优化保留双流、原退出码和600秒拒绝，不以下载100%或现成宿主浏览器代替验收', () => {
  assert.match(source, /child\.stdout\.on\('data'/)
  assert.match(source, /child\.stderr\.on\('data'/)
  assert.match(source, /child\.once\('close', code =>/)
  assert.match(source, /assert\.equal\(result\.code, 0,/)
  assert.ok(/child\.kill\(\); reject\(new Error\(`命令超时:/.test(source), '原超时拒绝仍在')
  for (const stage of ['runtime-ui', 'update-stop', 'uninstall-reinstall-preserve']) assert.ok(source.includes(`await stage('${stage}'`))
  assert.match(source, /await stopRuntime\(\)/)
})

test('真实子进程输出100%但未退出：诊断不记录正文，不把进度当成功', async () => {
  const { observeQualificationCommand } = await import('../scripts/test-hermes-windows-qualification.mjs')
  assert.equal(typeof observeQualificationCommand, 'function')
  const child = spawn(process.execPath, ['-e', "process.stdout.write('100% SECRET-CONTENT');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  const closed = once(child, 'close'), receipt = {}, observer = observeQualificationCommand(child, receipt)
  try {
    await once(child.stdout, 'data'); observer.timeout()
    assert.equal(receipt.commandObservation.directExitCodeAtTimeout, null)
    assert.equal(receipt.commandObservation.stdoutEndedAtTimeout, false)
    assert.ok(receipt.commandObservation.stdoutBytes > 0)
    assert.equal(receipt.commandObservation.closeReceived, false)
    assert.doesNotMatch(JSON.stringify(receipt), /SECRET-CONTENT|100%/)
    assert.equal(receipt.exitCode, undefined)
  } finally { child.kill(); await closed }
  assert.equal(receipt.commandObservation.closeReceived, true)
})

test('真实直接孩子exit0：在exit回调先于close留证，超时记录不被后续close抹去', async () => {
  const { observeQualificationCommand } = await import('../scripts/test-hermes-windows-qualification.mjs')
  assert.equal(typeof observeQualificationCommand, 'function')
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }), receipt = {}, closed = once(child,'close'), observer = observeQualificationCommand(child,receipt)
  const atExit = await new Promise(resolve => child.once('exit', () => { observer.timeout(); resolve(structuredClone(receipt.commandObservation)) }))
  assert.equal(atExit.directExitCodeAtTimeout,0)
  assert.equal(atExit.exitReceived,true)
  assert.equal(atExit.closeReceived,false)
  await closed
  assert.ok(receipt.commandObservation.timedOutAt)
  assert.equal(receipt.exitCode,undefined)
  assert.equal(receipt.commandObservation.closeReceived,true)
  assert.ok(source.includes("DEBUG: 'pw:install'"), '只为此浏览器命令启用固定官方诊断，不污染内核环境')
})
