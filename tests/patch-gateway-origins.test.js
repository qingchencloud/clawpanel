import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const devApi = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const pairing = readFileSync(new URL('../src-tauri/src/commands/pairing.rs', import.meta.url), 'utf8')

test('patchGatewayOrigins writes only allowedOrigins via merge path', () => {
  const start = devApi.indexOf('function patchGatewayOrigins()')
  const end = devApi.indexOf('function readOpenclawConfigOptional()', start)
  const fn = start >= 0 && end > start ? devApi.slice(start, end) : ''
  assert.ok(fn, 'patchGatewayOrigins must exist')
  assert.match(
    fn,
    /只写入 allowedOrigins 增量/,
    'dev-api 自动配对 origin 修补必须只更新 allowedOrigins',
  )
  assert.match(
    fn,
    /mergeConfigsPreservingFields\(existingOnDisk, partial\)/,
    'dev-api 自动配对 origin 修补必须走局部 merge 写入',
  )
  assert.doesNotMatch(
    fn,
    /writeOpenclawConfigFile\(config\)/,
    'dev-api 不能再把陈旧全量 config 直接写回磁盘',
  )
})

test('patch_gateway_origins writes only allowedOrigins patch in Rust', () => {
  assert.match(
    pairing,
    /只写入 allowedOrigins 增量[\s\S]*save_openclaw_json\(&patch\)/,
    'Rust 自动配对 origin 修补必须只提交 gateway.controlUi.allowedOrigins 增量',
  )
})
