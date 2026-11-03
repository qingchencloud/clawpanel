import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DSH_STABLE_VERSION, DSH_PREVIEW_VERSION, DSH_STABLE_PNPM_VERSION, DSH_PREVIEW_PNPM_VERSION, DSH_RELEASE_CHANNELS, dshReleaseChannel } from '../scripts/deepseek-harness.js'

test('DSH 私有安装器避开受影响 pnpm，稳定默认与精确通道保持不变', () => {
  assert.equal(DSH_STABLE_PNPM_VERSION, '11.28.5')
  assert.equal(DSH_PREVIEW_PNPM_VERSION, '11.28.5')
  assert.equal(dshReleaseChannel(), 'stable')
  assert.deepEqual(DSH_RELEASE_CHANNELS.stable, { channel: 'stable', version: '0.2.0-rc.2', pnpmVersion: '11.28.5' })
  assert.throws(() => dshReleaseChannel('latest'), /发行通道无效/)
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/deepseek_harness.rs', import.meta.url), 'utf8')
  assert.match(rust, /DSH_STABLE_PNPM_VERSION: &str = "11\.28\.5"/)
  assert.match(rust, /DSH_PREVIEW_PNPM_VERSION: &str = "11\.28\.5"/)
  assert.doesNotMatch(rust, /DSH_STABLE_PNPM_VERSION: &str = "11\.7\.0"/)
})

test('DSH 默认 RC 与新 Alpha 分离，Web/Rust 精确版本一致', () => {
  assert.equal(DSH_STABLE_VERSION, '0.2.0-rc.2')
  assert.equal(DSH_PREVIEW_VERSION, '0.2.1-alpha.4')
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/deepseek_harness.rs', import.meta.url), 'utf8')
  assert.match(rust, /DSH_STABLE_VERSION: &str = "0\.2\.0-rc\.2"/)
  assert.match(rust, /DSH_PREVIEW_VERSION: &str = "0\.2\.1-alpha\.4"/)
})

test('预览验收独立选择 preview 安装与精确版本，保留实际 PID 和端口清理', () => {
  const source = fs.readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs', import.meta.url), 'utf8')
  assert.match(source, /engine === 'deepseek-harness-preview' \? constant\('scripts\/deepseek-harness\.js', 'DSH_PREVIEW_VERSION'\)/)
  assert.match(source, /channel: engine === 'deepseek-harness-preview' \? 'preview' : 'stable'/)
  assert.match(source, /until\(\(\) => \[\.\.\.runtimePids\]\.every\(pid => !alive\(pid\)\)/)
  assert.match(source, /!status\.running && !status\.portOpen && !status\.error/)
})
