import test from 'node:test'
import assert from 'node:assert/strict'

import {
  openCodeEmbedPrefix,
  openCodeUpstreamHeaders,
  parseOpenCodeEmbedUrl,
  rewriteOpenCodeProxyText,
  shouldRewriteOpenCodeResponse,
} from '../scripts/opencode-proxy.js'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
const PREFIX = `/__opencode/${TOKEN}`

test('内嵌 URL 只接受高熵令牌，拒绝越权和内部 API 路径', () => {
  assert.equal(openCodeEmbedPrefix(TOKEN), PREFIX)
  assert.deepEqual(parseOpenCodeEmbedUrl(`${PREFIX}/global/health?x=1`), {
    token: TOKEN,
    prefix: PREFIX,
    upstreamPathname: '/global/health',
    upstreamPath: '/global/health?x=1',
  })
  assert.equal(parseOpenCodeEmbedUrl('/__opencode/short/'), null)
  assert.equal(parseOpenCodeEmbedUrl(`${PREFIX}/%2e%2e/__api/reveal_model_channel_key`), null)
  assert.equal(parseOpenCodeEmbedUrl(`${PREFIX}/__api/auth_check`), null)
})

test('HTML 与 CSS 根路径写回令牌前缀，并注入 fetch/SSE/WebSocket 桥', () => {
  const source = '<html><head><link href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>'
  const html = rewriteOpenCodeProxyText(source, PREFIX, { contentType: 'text/html' })
  assert.match(html, new RegExp(`${PREFIX}/assets/app\\.css`))
  assert.match(html, new RegExp(`${PREFIX}/assets/app\\.js`))
  assert.match(html, /__CLAWPANEL_OPENCODE_PREFIX__/)
  assert.match(html, /window\.fetch=/)
  assert.match(html, /window\.EventSource/)
  assert.match(html, /mapWs/)
  assert.match(html, /wss:/)

  const css = rewriteOpenCodeProxyText('body{background:url(/assets/bg.png)}', PREFIX, { contentType: 'text/css' })
  assert.match(css, new RegExp(`url\\(${PREFIX}/assets/bg\\.png\\)`))
})

test('上游请求剥离面板凭据并仅注入 OpenCode Basic Auth', () => {
  const headers = openCodeUpstreamHeaders({
    cookie: 'clawpanel_session=panel-secret',
    authorization: 'Bearer panel-secret',
    origin: 'https://panel.example',
    referer: 'https://panel.example/',
    'content-type': 'application/json',
  }, 4096, { password: 'runtime-secret' })
  assert.equal(headers.cookie, undefined)
  assert.equal(headers.host, '127.0.0.1:4096')
  assert.equal(headers.origin, 'http://127.0.0.1:4096')
  assert.equal(headers.authorization, `Basic ${Buffer.from('opencode:runtime-secret').toString('base64')}`)
  assert.equal(headers['content-type'], 'application/json')
  assert.doesNotMatch(JSON.stringify(headers), /panel-secret/)
})

test('只改写静态文本响应，不改写会话与模型 API JSON', () => {
  assert.equal(shouldRewriteOpenCodeResponse('text/html; charset=utf-8'), true)
  assert.equal(shouldRewriteOpenCodeResponse('text/css'), true)
  assert.equal(shouldRewriteOpenCodeResponse('application/manifest+json'), true)
  assert.equal(shouldRewriteOpenCodeResponse('application/json'), false)
  assert.equal(shouldRewriteOpenCodeResponse('text/event-stream'), false)
})

