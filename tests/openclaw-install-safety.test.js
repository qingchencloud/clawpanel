import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as devApiModule from '../scripts/dev-api.js'

const { replaceStandaloneInstall, verifyInstalledOpenclawRuntimeDependencies } = devApiModule

const setup = readFileSync(new URL('../src/pages/setup.js', import.meta.url), 'utf8')
const tauriApi = readFileSync(new URL('../src/lib/tauri-api.js', import.meta.url), 'utf8')
const wsClient = readFileSync(new URL('../src/lib/ws-client.js', import.meta.url), 'utf8')
const devApi = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rustConfig = readFileSync(new URL('../src-tauri/src/commands/config.rs', import.meta.url), 'utf8')

function sliceFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

test('setup keeps standalone installation available without a system Node runtime', () => {
  const cliSection = sliceFunction(setup, '// 第三步：OpenClaw CLI', '// 第四步：')
  assert.doesNotMatch(
    cliSection,
    /opacity:0\.65;pointer-events:none/,
  )
  assert.match(setup, /if \(!installBtn\) return/)
  assert.doesNotMatch(setup, /if \(!installBtn \|\| !nodeOk\) return/)
})

test('npm installation checks the target OpenClaw Node requirement before running npm', () => {
  const webUpgrade = sliceFunction(devApi, 'async upgrade_openclaw(', '// 设备配对 + Gateway 握手')
  assert.match(webUpgrade, /ensureTargetNodeRuntimeCompatibleForNpm\(ver\)/)
  assert.ok(
    webUpgrade.indexOf('ensureTargetNodeRuntimeCompatibleForNpm(ver)') < webUpgrade.indexOf('const runInstall'),
    'Web target runtime check must run before npm install',
  )

  const rustUpgrade = sliceFunction(rustConfig, 'async fn upgrade_openclaw_inner(', '#[tauri::command]\npub async fn uninstall_openclaw')
  assert.match(rustUpgrade, /ensure_target_node_runtime_compatible_for_npm\(ver\)\?/)
  assert.ok(
    rustUpgrade.indexOf('ensure_target_node_runtime_compatible_for_npm(ver)?') < rustUpgrade.indexOf('pre_install_cleanup();'),
    'Desktop target runtime check must run before cleanup and npm install',
  )
})

test('standalone installation validates a staging directory before replacing the active install', () => {
  const webInstall = sliceFunction(devApi, 'async function _tryStandaloneInstall(', 'function r2PlatformKey()')
  assert.match(webInstall, /stagingDir/)
  assert.match(webInstall, /backupDir/)
  assert.match(webInstall, /verifyStandaloneInstall/)
  assert.ok(
    webInstall.indexOf('verifyStandaloneInstall') < webInstall.indexOf('replaceStandaloneInstall'),
    'Web standalone archive must be verified before activation',
  )

  const rustInstall = sliceFunction(rustConfig, 'async fn try_standalone_install(', '/// 尝试从 R2 CDN')
  assert.match(rustInstall, /staging_dir/)
  assert.match(rustInstall, /backup_dir/)
  assert.match(rustInstall, /verify_standalone_install/)
  assert.ok(
    rustInstall.indexOf('verify_standalone_install') < rustInstall.indexOf('replace_standalone_install'),
    'Desktop standalone archive must be verified before activation',
  )
})

test('npm installation validation rejects missing runtime dependencies and accepts a complete tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawpanel-npm-runtime-'))
  const cliName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
  const cliPath = join(root, cliName)
  const packageDir = join(root, 'node_modules', '@qingchencloud', 'openclaw-zh')
  const dependencyDir = join(root, 'node_modules', '@openclaw', 'ai')
  try {
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(cliPath, '')
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@qingchencloud/openclaw-zh',
      version: '2026.7.1-2-zh.1',
      dependencies: { '@openclaw/ai': '2026.7.1-2' },
    }))

    assert.throws(
      () => verifyInstalledOpenclawRuntimeDependencies(cliPath),
      /OpenClaw.*缺少运行时依赖.*@openclaw\/ai/i,
    )

    mkdirSync(dependencyDir, { recursive: true })
    writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({
      name: '@openclaw/ai',
      version: '2026.7.1-2',
    }))
    assert.equal(verifyInstalledOpenclawRuntimeDependencies(cliPath).dependencyCount, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('npm installation falls back to the official registry when dependency validation fails', () => {
  const webUpgrade = sliceFunction(devApi, 'async upgrade_openclaw(', '// 设备配对 + Gateway 握手')
  assert.match(webUpgrade, /verifyInstalledOpenclawRuntimeDependencies\(npmCli\)/)
  assert.match(webUpgrade, /镜像源安装完整性校验失败/)
  assert.match(webUpgrade, /runInstall\('https:\/\/registry\.npmjs\.org'\)/)

  const rustUpgrade = sliceFunction(rustConfig, 'async fn upgrade_openclaw_inner(', '#[tauri::command]\npub async fn uninstall_openclaw')
  assert.match(rustUpgrade, /verify_installed_openclaw_runtime_dependencies\(&npm_cli\)/)
  assert.match(rustUpgrade, /镜像源安装完整性校验失败/)
  assert.match(rustUpgrade, /"https:\/\/registry\.npmjs\.org"/)
})

test('standalone validation rejects a version-matching archive with missing runtime dependencies', () => {
  assert.equal(typeof devApiModule.verifyStandaloneInstall, 'function')

  const root = mkdtempSync(join(tmpdir(), 'clawpanel-standalone-runtime-'))
  const cliName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
  const packageDir = join(root, 'node_modules', '@qingchencloud', 'openclaw-zh')
  try {
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(root, cliName), '')
    writeFileSync(join(root, 'VERSION'), 'openclaw_version=2026.7.1-zh.2\n')
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@qingchencloud/openclaw-zh',
      version: '2026.7.1-zh.2',
      dependencies: {
        '@openclaw/ai': '2026.7.1',
      },
    }))

    assert.throws(
      () => devApiModule.verifyStandaloneInstall(root, '2026.7.1-zh.2'),
      /standalone.*缺少运行时依赖.*@openclaw\/ai/i,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GitHub standalone fallback can resolve a pinned version without the CDN manifest', () => {
  const webInstall = sliceFunction(devApi, 'async function _tryStandaloneInstall(', 'function r2PlatformKey()')
  assert.match(webInstall, /overrideBaseUrl && version !== 'latest'/)
  assert.match(webInstall, /remoteVersion = version/)

  const rustInstall = sliceFunction(rustConfig, 'async fn try_standalone_install(', '/// 尝试从 R2 CDN')
  assert.match(rustInstall, /override_base_url\.is_some\(\) && version != "latest"/)
})

test('Web Gateway pairing sends the actual browser origin to the backend', () => {
  assert.match(tauriApi, /autoPairDevice: \(origin = window\.location\.origin\) => invoke\('auto_pair_device', \{ origin: origin \|\| null \}\)/)
  assert.match(wsClient, /api\.autoPairDevice\(window\.location\.origin\)/)
  assert.match(devApi, /auto_pair_device\(\{ origin \} = \{\}\)/)
  assert.match(devApi, /patchGatewayOrigins\(origin\)/)
})

test('Web standalone activation replaces a verified staging directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawpanel-standalone-swap-'))
  const installDir = join(root, 'install')
  const stagingDir = join(root, 'staging')
  const backupDir = join(root, 'backup')
  try {
    mkdirSync(installDir)
    mkdirSync(stagingDir)
    writeFileSync(join(installDir, 'old.txt'), 'old')
    writeFileSync(join(stagingDir, 'new.txt'), 'new')

    replaceStandaloneInstall(stagingDir, installDir, backupDir)

    assert.equal(readFileSync(join(installDir, 'new.txt'), 'utf8'), 'new')
    assert.equal(existsSync(join(installDir, 'old.txt')), false)
    assert.equal(existsSync(backupDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Web standalone activation restores the old install when activation fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawpanel-standalone-rollback-'))
  const installDir = join(root, 'install')
  const missingStagingDir = join(root, 'missing-staging')
  const backupDir = join(root, 'backup')
  try {
    mkdirSync(installDir)
    writeFileSync(join(installDir, 'old.txt'), 'old')

    assert.throws(() => replaceStandaloneInstall(missingStagingDir, installDir, backupDir))

    assert.equal(readFileSync(join(installDir, 'old.txt'), 'utf8'), 'old')
    assert.equal(existsSync(backupDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
