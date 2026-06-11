import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const devApi = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const pairing = readFileSync(new URL('../src-tauri/src/commands/pairing.rs', import.meta.url), 'utf8')

test('patchGatewayOrigins writes only allowedOrigins through merge path', () => {
  const start = devApi.indexOf('function patchGatewayOrigins()')
  const end = devApi.indexOf('function readOpenclawConfigOptional()', start)
  const fn = start >= 0 && end > start ? devApi.slice(start, end) : ''

  assert.ok(fn, 'patchGatewayOrigins must exist')
  assert.match(fn, /只写入 allowedOrigins 增量/)
  assert.match(fn, /const partial = \{\s*gateway: \{\s*controlUi: \{\s*allowedOrigins: merged,/s)
  assert.match(fn, /mergeConfigsPreservingFields\(latest, partial\)/)
  assert.doesNotMatch(fn, /writeOpenclawConfigFile\(config\)/)
})

test('patch_gateway_origins writes only allowedOrigins patch in Rust', () => {
  const start = pairing.indexOf('fn patch_gateway_origins()')
  const end = pairing.indexOf('#[tauri::command]', start)
  const fn = start >= 0 && end > start ? pairing.slice(start, end) : ''

  assert.ok(fn, 'patch_gateway_origins must exist')
  assert.match(fn, /只写入 allowedOrigins 增量/)
  assert.match(fn, /let patch = serde_json::json!\(\{/)
  assert.match(fn, /save_openclaw_json\(&patch\)/)
})
