import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpenCodeEmbedUrl, rewriteOpenCodeProxyText } from '../scripts/opencode-proxy.js'
const token = 'route-fixture-0123456789abcdefghijklmnopqrstuv'

test('原生 UI 路由保留 pathname，以独立 query 能力令牌加载文档', () => {
  const route = parseOpenCodeEmbedUrl(`/workspace/session/s1?__opencode_embed=${token}&tab=files`)
  assert.equal(route?.token, token)
  assert.equal(route.upstreamPath, '/workspace/session/s1?tab=files')
  assert.equal(route.prefix, '/__opencode/' + token)
})

test('文档能力令牌不授予面板 API、其他引擎或重复参数访问', () => {
  for (const path of ['/__api/auth_check', '/__dsh/token/api', '/__%61pi/read_panel_config', '/x/%2e%2e/__api/read_panel_config']) {
    assert.equal(parseOpenCodeEmbedUrl(`${path}?__opencode_embed=${token}`), null)
  }
  assert.equal(parseOpenCodeEmbedUrl(`/?__opencode_embed=${token}&__opencode_embed=${token}`), null)
  assert.equal(parseOpenCodeEmbedUrl('/?__opencode_embed=short'), null)
})

test('UI 的 history 映射与 API 前缀分离，不改变 opaque sandbox', () => {
  const html = rewriteOpenCodeProxyText('<html><head></head><body></body></html>', '/__opencode/' + token)
  assert.match(html, /__opencode_embed/)
  assert.match(html, /openCodeStorageBootstrap/)
  assert.doesNotMatch(html, /allow-same-origin/)
})
