import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nodeVersionSatisfiesRequirement } from '../scripts/dev-api.js'

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

test('Node fallback follows the OpenClaw 6.5 and 7.1 runtime floors', () => {
  assert.match(devApi, /OPENCLAW_NODE_22_19_VERSION_FLOOR = '2026\.6\.5'/)
  assert.match(devApi, /OPENCLAW_NODE_22_19_REQUIREMENT = '>=22\.19\.0'/)
  assert.match(devApi, /OPENCLAW_NODE_7_1_VERSION_FLOOR = '2026\.7\.1'/)
  assert.match(devApi, /OPENCLAW_NODE_7_1_REQUIREMENT = '>=22\.22\.3 <23 \|\| >=24\.15\.0 <25 \|\| >=25\.9\.0'/)
  assert.match(devApi, /fallbackOpenclawNodeRequirement\(installedVersion\)/)
  assert.doesNotMatch(devApi, /DEFAULT_OPENCLAW_NODE_REQUIREMENT/)

  assert.match(rustConfig, /OPENCLAW_NODE_22_19_VERSION_FLOOR: &str = "2026\.6\.5"/)
  assert.match(rustConfig, /OPENCLAW_NODE_22_19_REQUIREMENT: &str = ">=22\.19\.0"/)
  assert.match(rustConfig, /OPENCLAW_NODE_7_1_VERSION_FLOOR: &str = "2026\.7\.1"/)
  assert.match(rustConfig, /OPENCLAW_NODE_7_1_REQUIREMENT: &str =\s*">=22\.22\.3 <23 \|\| >=24\.15\.0 <25 \|\| >=25\.9\.0"/)
  assert.match(rustConfig, /fallback_openclaw_node_requirement/)
})

test('Web Node range parser accepts OpenClaw 2026.7.1 supported versions only', () => {
  const requirement = '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0'
  assert.equal(nodeVersionSatisfiesRequirement('v22.22.2', requirement), false)
  assert.equal(nodeVersionSatisfiesRequirement('v22.22.3', requirement), true)
  assert.equal(nodeVersionSatisfiesRequirement('v23.11.1', requirement), false)
  assert.equal(nodeVersionSatisfiesRequirement('v24.14.9', requirement), false)
  assert.equal(nodeVersionSatisfiesRequirement('v24.15.0', requirement), true)
  assert.equal(nodeVersionSatisfiesRequirement('v25.8.9', requirement), false)
  assert.equal(nodeVersionSatisfiesRequirement('v25.9.0', requirement), true)
  assert.equal(nodeVersionSatisfiesRequirement('v33.0.0', requirement), true)
})
