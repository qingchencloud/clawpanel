/** OpenCode Web 内嵌代理的纯函数。 */

export const OPENCODE_EMBED_ROOT = '/__opencode'
export const OPENCODE_EMBED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export function openCodeEmbedPrefix(token) {
  const normalized = String(token || '').trim()
  if (!OPENCODE_EMBED_TOKEN_PATTERN.test(normalized)) throw new Error('无效的 OpenCode 内嵌令牌')
  return `${OPENCODE_EMBED_ROOT}/${normalized}`
}

export function parseOpenCodeEmbedUrl(rawUrl) {
  let parsed
  try { parsed = new URL(String(rawUrl || ''), 'http://clawpanel.local') } catch { return null }
  let decodedPath
  try { decodedPath = decodeURIComponent(parsed.pathname) } catch { return null }
  if (decodedPath.includes('\\') || decodedPath.split('/').includes('..')) return null
  const match = parsed.pathname.match(/^\/__opencode\/([A-Za-z0-9_-]{32,128})(\/.*)?$/)
  if (!match) return null
  const upstreamPathname = match[2] || '/'
  if (upstreamPathname.startsWith('/__api') || upstreamPathname.startsWith('/__opencode')) return null
  return {
    token: match[1],
    prefix: `${OPENCODE_EMBED_ROOT}/${match[1]}`,
    upstreamPathname,
    upstreamPath: `${upstreamPathname}${parsed.search}`,
  }
}

function bridgeScript(prefix) {
  const escaped = JSON.stringify(prefix)
  return `<script>(function(){const P=${escaped};const own=x=>x.host===location.host||x.hostname==='127.0.0.1'||x.hostname==='localhost';const map=u=>{try{const x=new URL(String(u),location.href);if(own(x)&&!x.pathname.startsWith(P+'/'))return P+x.pathname+x.search+x.hash}catch{}return u};const mapWs=u=>{try{const x=new URL(String(u),location.href);if(own(x)&&!x.pathname.startsWith(P+'/'))x.pathname=P+x.pathname;x.protocol=location.protocol==='https:'?'wss:':'ws:';x.host=location.host;return x.href}catch{return u}};const f=window.fetch;window.fetch=(u,o)=>f.call(window,typeof u==='string'||u instanceof URL?map(u):new Request(map(u.url),u),o);const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return xo.call(this,m,map(u),...r)};const ES=window.EventSource;if(ES)window.EventSource=function(u,o){return new ES(map(u),o)};const WS=window.WebSocket;if(WS)window.WebSocket=function(u,p){return new WS(mapWs(u),p)};const push=history.pushState.bind(history),replace=history.replaceState.bind(history);history.pushState=(s,t,u)=>push(s,t,u==null?u:map(u));history.replaceState=(s,t,u)=>replace(s,t,u==null?u:map(u));window.__CLAWPANEL_OPENCODE_PREFIX__=P})();</script>`
}

function prefixRootReferences(text, prefix) {
  return text
    .replace(/((?:src|href|action)=['"])\/(?!\/|__opencode\/)/gi, `$1${prefix}/`)
    .replace(/url\((['"]?)\/(?!\/|__opencode\/)/gi, `url($1${prefix}/`)
}

export function rewriteOpenCodeProxyText(input, prefixValue, { contentType = 'text/html' } = {}) {
  const prefix = openCodeEmbedPrefix(String(prefixValue || '').replace(`${OPENCODE_EMBED_ROOT}/`, ''))
  let text = String(input ?? '')
  if (String(contentType).toLowerCase().includes('text/html')) {
    text = prefixRootReferences(text, prefix)
    if (!text.includes('__CLAWPANEL_OPENCODE_PREFIX__')) {
      text = text.replace(/<head([^>]*)>/i, `<head$1>${bridgeScript(prefix)}`)
    }
    return text
  }
  if (String(contentType).toLowerCase().includes('text/css')) return prefixRootReferences(text, prefix)
  if (String(contentType).toLowerCase().includes('manifest')) return text.replace(/"\/(?!\/|__opencode\/)/g, `"${prefix}/`)
  return text
}

export function shouldRewriteOpenCodeResponse(contentType) {
  const type = String(contentType || '').toLowerCase()
  return type.includes('text/html') || type.includes('text/css') || type.includes('manifest')
}

export function openCodeUpstreamHeaders(headers, port, { password = '', websocket = false } = {}) {
  const result = {}
  const blocked = new Set([
    'connection', 'content-length', 'cookie', 'host', 'origin', 'referer',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'upgrade',
  ])
  for (const [rawName, value] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase()
    if (blocked.has(name) || value === undefined) continue
    result[name] = value
  }
  result.host = `127.0.0.1:${Number(port)}`
  result.origin = `http://127.0.0.1:${Number(port)}`
  if (password) result.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  if (websocket) {
    result.connection = 'Upgrade'
    result.upgrade = headers?.upgrade || 'websocket'
  }
  return result
}
