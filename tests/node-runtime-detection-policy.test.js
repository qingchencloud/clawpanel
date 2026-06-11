import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const devApi = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rustConfig = readFileSync(new URL('../src-tauri/src/commands/config.rs', import.meta.url), 'utf8')

test('web check_node prefers standalone bundled Node when available', () => {
  const start = devApi.indexOf('check_node() {')
  const end = devApi.indexOf('get_status_summary()', start)
  const fn = start >= 0 && end > start ? devApi.slice(start, end) : ''

  assert.ok(fn, 'check_node handler must exist')
  assert.match(fn, /classifyCliSource\(cliPath\) === 'standalone'/)
  assert.match(fn, /standaloneBundledNodePath\(cliPath\)/)
  assert.match(fn, /detectedFrom: 'standalone-bundled'/)
})

test('desktop check_node prefers standalone bundled Node before PATH lookup', () => {
  const start = rustConfig.indexOf('pub fn check_node()')
  const pathLookup = rustConfig.indexOf('let node_path = find_node_path', start)
  const bundledLookup = rustConfig.indexOf('standalone_bundled_node_bin(&cli_path)', start)

  assert.ok(start >= 0, 'check_node must exist')
  assert.ok(bundledLookup > start, 'standalone bundled Node lookup must exist')
  assert.ok(pathLookup > bundledLookup, 'bundled Node lookup must run before PATH lookup')
  assert.match(rustConfig, /"standalone-bundled"/)
})

test('Node 22.19 fallback is gated by OpenClaw 2026.6.5 or newer', () => {
  assert.match(devApi, /OPENCLAW_NODE_REQUIREMENT_VERSION_FLOOR = '2026\.6\.5'/)
  assert.match(devApi, /OPENCLAW_NODE_REQUIREMENT_FOR_NEWER_RUNTIME = '>=22\.19\.0'/)
  assert.match(devApi, /versionGe\(baseVersion\(installedVersion\), OPENCLAW_NODE_REQUIREMENT_VERSION_FLOOR\)/)
  assert.doesNotMatch(devApi, /DEFAULT_OPENCLAW_NODE_REQUIREMENT/)

  assert.match(rustConfig, /OPENCLAW_NODE_REQUIREMENT_VERSION_FLOOR: &str = "2026\.6\.5"/)
  assert.match(rustConfig, /OPENCLAW_NODE_REQUIREMENT_FOR_NEWER_RUNTIME: &str = ">=22\.19\.0"/)
  assert.match(rustConfig, /openclaw_version_requires_node_22_19/)
})
