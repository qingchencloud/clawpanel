import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dshEmbedPrefix,
  dshUpstreamHeaders,
  parseDshEmbedUrl,
  rewriteDshProxyText,
  shouldRewriteDshResponse,
} from '../scripts/deepseek-harness-proxy.js'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
const PREFIX = `/__dsh/${TOKEN}`

test('内嵌 URL 只接受高熵令牌并精确剥离代理前缀', () => {
  assert.equal(dshEmbedPrefix(TOKEN), PREFIX)
  assert.deepEqual(parseDshEmbedUrl(`${PREFIX}/api/settings.describe?x=1`), {
    token: TOKEN,
    prefix: PREFIX,
    upstreamPath: '/api/settings.describe?x=1',
    upstreamPathname: '/api/settings.describe',
  })
  assert.equal(parseDshEmbedUrl('/__dsh/short/api'), null)
  assert.equal(parseDshEmbedUrl(`${PREFIX}/%2e%2e/__api/reveal_model_channel_key`), null)
  assert.equal(parseDshEmbedUrl(`${PREFIX}/%2F__api/health`), null)
})

test('HTML、插件脚本和 Manifest 的绝对入口全部留在令牌路径', () => {
  const htmlSource = [
    '<!doctype html><html><head>',
    '<script src="/plugins/pkg/client.js"></script>',
    '<script src="/assets/index.js"></script>',
    '<link href="/manifest.webmanifest"><link href="/favicon.svg">',
    '</head><body>',
    '</body></html>',
  ].join('\n')
  const result = rewriteDshProxyText(htmlSource, PREFIX, {
    contentType: 'text/html',
    storage: { 'dsh.saved': 'value</script><script>bad()</script>' },
  })
  for (const entry of ['plugins/pkg/client.js', 'assets/index.js', 'manifest.webmanifest', 'favicon.svg', 'api', 'plugins/events']) {
    if (htmlSource.includes(`/${entry}`)) {
      assert.match(result, new RegExp(`${PREFIX.replaceAll('/', '\\/')}\\/${entry.replaceAll('/', '\\/')}`))
    }
  }
  assert.match(result, /__CLAWPANEL_DSH_SANDBOX__/)
  assert.match(result, /proxyRoots=\['\/api','\/plugins','\/assets'/)
  assert.match(result, /<script crossorigin="anonymous" src=/)
  assert.match(result, /document\.createElement=\(name,options\)=>/)
  assert.match(result, /"dsh\.saved":"value\\u003c\/script>/)
  assert.doesNotMatch(result, /value<\/script>/)
  assert.doesNotMatch(result, /(?:src|href)=["']\/(?:plugins|assets)(?:\/|["'])/)

  const script = 'const API_PATH = "/api"; const TEMPLATE = `/api/settings.describe`; const EVENTS = "/plugins/events";'
  assert.equal(rewriteDshProxyText(script, PREFIX, { contentType: 'text/javascript' }), script)

  const manifest = '{"start_url":"/","scope":"/","src":"/favicon.svg"}'
  const rewrittenManifest = rewriteDshProxyText(manifest, PREFIX, { contentType: 'application/manifest+json' })
  assert.match(rewrittenManifest, new RegExp(`"start_url":"${PREFIX.replaceAll('/', '\\/')}\\/"`))
  assert.match(rewrittenManifest, new RegExp(`"scope":"${PREFIX.replaceAll('/', '\\/')}\\/"`))
})

test('上游请求剥离面板 Cookie、Authorization 和转发来源', () => {
  const headers = dshUpstreamHeaders({
    cookie: 'clawpanel_session=secret',
    authorization: 'Bearer panel-secret',
    origin: 'https://panel.example',
    referer: 'https://panel.example/__dsh/token/',
    'x-forwarded-for': '203.0.113.8',
    'content-type': 'application/json',
  }, 33080)
  assert.equal(headers.cookie, undefined)
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers.host, '127.0.0.1:33080')
  assert.equal(headers.origin, 'http://127.0.0.1:33080')
  assert.equal(headers.referer, 'http://127.0.0.1:33080/')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['accept-encoding'], 'identity')
})

test('只改写静态文本，不改写可能包含用户内容的 API JSON', () => {
  assert.equal(shouldRewriteDshResponse('text/html; charset=utf-8', '/'), true)
  assert.equal(shouldRewriteDshResponse('text/css', '/assets/index.css'), true)
  assert.equal(shouldRewriteDshResponse('text/javascript', '/plugins/x/client.js'), false)
  assert.equal(shouldRewriteDshResponse('application/manifest+json', '/manifest.webmanifest'), true)
  assert.equal(shouldRewriteDshResponse('application/json', '/api/session.list'), false)
})
