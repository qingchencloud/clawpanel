/** OpenCode Web 内嵌代理的纯函数。 */
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { openCodeStorageBootstrap, sanitizeOpenCodeStorage } from '../src/lib/opencode-storage-bridge.js'
export { sanitizeOpenCodeStorage } from '../src/lib/opencode-storage-bridge.js'

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
  if (parsed.searchParams.has('__opencode_embed')) {
    const tokens = parsed.searchParams.getAll('__opencode_embed')
    if (tokens.length !== 1 || !OPENCODE_EMBED_TOKEN_PATTERN.test(tokens[0]) || decodedPath.startsWith('/__')) return null
    parsed.searchParams.delete('__opencode_embed')
    return { token: tokens[0], prefix: openCodeEmbedPrefix(tokens[0]), upstreamPathname: parsed.pathname, upstreamPath: parsed.pathname + parsed.search }
  }
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

/** 使用原生请求属性但缓冲有界正文，避免 Request 重建退化成 HTTP/2 上传流。 */
export function openCodeNetworkBootstrap(P) {
  const own = x => x.host === location.host || x.hostname === '127.0.0.1' || x.hostname === 'localhost'
  const map = u => { try { const x = new URL(String(u), location.href); if (own(x) && !x.pathname.startsWith(P + '/')) return P + x.pathname + x.search + x.hash } catch {}; return u }
  const route = u => { try { const x = new URL(String(u), location.href); if (!own(x)) return u; if (x.pathname.startsWith(P + '/')) x.pathname = x.pathname.slice(P.length); x.searchParams.set('__opencode_embed', P.slice('/__opencode/'.length)); return x.pathname + x.search + x.hash } catch { return u } }
  const mapWs = u => { try { const x = new URL(String(u), location.href); if (own(x) && !x.pathname.startsWith(P + '/')) x.pathname = P + x.pathname; x.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; x.host = location.host; return x.href } catch { return u } }
  const fetch = window.fetch
  window.fetch=async (u, options) => {
    if (typeof u === 'string' || u instanceof URL) return fetch.call(window, map(u), options)
    const q = new Request(u, options), url = map(q.url)
    if (url === q.url) return fetch.call(window, q)
    let body
    if (q.body && !['GET', 'HEAD'].includes(q.method)) {
      const reader = q.body.getReader(), chunks = []; let size = 0, rejectAbort
      const aborted = new Promise((_, reject) => { rejectAbort = reject })
      const abort = () => { const cause = q.signal.reason || new DOMException('请求已中止', 'AbortError'); reader.cancel(cause).catch(() => {}); rejectAbort(cause) }
      q.signal.addEventListener('abort', abort, { once: true })
      try {
        if (q.signal.aborted) throw q.signal.reason || new DOMException('请求已中止', 'AbortError')
        while (true) {
          const part = await Promise.race([reader.read(), aborted])
          if (part.done) break
          size += part.value.length
          if (size > 32 * 1024 * 1024) throw new DOMException('OpenCode 请求正文超过 32MB', 'QuotaExceededError')
          chunks.push(part.value)
        }
        if (q.signal.aborted) throw q.signal.reason || new DOMException('请求已中止', 'AbortError')
        const bytes = new Uint8Array(size); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        body = bytes.buffer
      } finally { q.signal.removeEventListener('abort', abort); reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    return fetch.call(window, url, { method: q.method, headers: q.headers, body, signal: q.signal, mode: q.mode, credentials: q.credentials, cache: q.cache, redirect: q.redirect, referrer: q.referrer, referrerPolicy: q.referrerPolicy, integrity: q.integrity, keepalive: q.keepalive })
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...args) { return open.call(this, method, map(url), ...args) }
  const ES = window.EventSource; if (ES) window.EventSource = function (url, options) { return new ES(map(url), options) }
  const WS = window.WebSocket; if (WS) window.WebSocket = function (url, protocols) { return new WS(mapWs(url), protocols) }
  const push = history.pushState.bind(history), replace = history.replaceState.bind(history)
  history.pushState = (state, title, url) => push(state, title, url == null ? url : route(url))
  history.replaceState = (state, title, url) => replace(state, title, url == null ? url : route(url))
  window.__CLAWPANEL_OPENCODE_PREFIX__ = P
}

/** 外部 SVG use 不支持 opaque 跨域；仅把受管静态图标导入当前文档。 */
export function openCodeSpriteBootstrap(prefix) {
  if (!window.SVGUseElement) return
  const cache = new Map(), pending = new WeakMap()
  let sequence = 0
  const original = SVGUseElement.prototype.setAttribute
  const originalNS = SVGUseElement.prototype.setAttributeNS
  const inline = (node, value) => {
    let url
    try { url = new URL(String(value), location.href) } catch { return false }
    const asset = url.pathname.startsWith(prefix + '/assets/') ? url.pathname.slice(prefix.length) : url.pathname
    if (url.host !== location.host || !/^\/assets\/sprite-[A-Za-z0-9_-]+\.svg$/.test(asset) || !/^#[A-Za-z0-9_-]+$/.test(url.hash)) return false
    const identity = asset + url.hash
    pending.set(node, identity)
    original.call(node, 'href', '#clawpanel-icon-pending')
    if (!cache.has(asset)) {
      if (cache.size >= 20) return true
      cache.set(asset, fetch(prefix + asset).then(async response => {
        if (!response.ok) throw new Error('OpenCode 图标读取失败')
        const reader = response.body.getReader(), chunks = []; let size = 0
        try {
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) throw new Error('OpenCode 图标超过 2MB'); chunks.push(part.value) }
        } finally { await reader.cancel().catch(() => {}) }
        const bytes = new Uint8Array(size); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
        if (xml.querySelector('parsererror')) throw new Error('OpenCode 图标格式无效')
        return { xml, ids: new Map() }
      }))
    }
    cache.get(asset).then(({ xml, ids }) => {
      if (pending.get(node) !== identity) return
      let id = ids.get(url.hash)
      if (!id) {
        const symbol = xml.getElementById(url.hash.slice(1))
        if (!symbol || symbol.localName !== 'symbol') return
        const copy = document.importNode(symbol, true)
        id = 'clawpanel-icon-' + (++sequence)
        copy.id = id
        for (const element of [copy, ...copy.querySelectorAll('*')]) {
          if (['script', 'foreignObject', 'iframe', 'image', 'use'].includes(element.localName)) { element.remove(); continue }
          for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name) || /href$/i.test(attribute.name)) element.removeAttribute(attribute.name)
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.style.display = 'none'; svg.setAttribute('aria-hidden', 'true'); svg.appendChild(copy)
        ;(document.body || document.documentElement).appendChild(svg)
        ids.set(url.hash, id)
      }
      original.call(node, 'href', '#' + id)
    }).catch(error => console.warn(error.message))
    return true
  }
  SVGUseElement.prototype.setAttribute = function (name, value) { if ((name === 'href' || name === 'xlink:href') && inline(this, value)) return; return original.call(this, name, value) }
  SVGUseElement.prototype.setAttributeNS = function (namespace, name, value) { if ((name === 'href' || name === 'xlink:href') && inline(this, value)) return; return originalNS.call(this, namespace, name, value) }
}

/** Worker 的脚本仍在 opaque 来源执行，不获取面板同源存储和 Cookie。 */
export function openCodeWorkerBootstrap(prefix) {
  const NativeWorker = window.Worker, workers = new Set()
  if (!NativeWorker) return
  function Worker(url, options = {}) {
    const target = new URL(String(url), location.href)
    const asset = target.pathname.startsWith(prefix + '/assets/') ? target.pathname.slice(prefix.length) : target.pathname
    if (target.origin !== location.origin || !/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(asset)) return new NativeWorker(url, options)
    const source = location.origin + prefix + asset + target.search
    const script = options.type === 'module' ? `import ${JSON.stringify(source)}` : `const base=${JSON.stringify(source)};const load=self.importScripts.bind(self);self.importScripts=(...urls)=>load(...urls.map(url=>new URL(String(url),base).href));importScripts(base)`
    // Chromium 的 opaque module Worker 不接受 blob:null；data 引导仍是独立 opaque 来源。
    const blob = options.type === 'module' ? 'data:text/javascript,' + encodeURIComponent(script) : URL.createObjectURL(new Blob([script], { type: 'text/javascript' }))
    let worker
    try { worker = new NativeWorker(blob, options) } catch (error) { URL.revokeObjectURL(blob); throw error }
    const release = () => { URL.revokeObjectURL(blob); clearTimeout(timer) }
    const timer = setTimeout(release, 30000)
    worker.addEventListener('message', release, { once: true }); worker.addEventListener('error', release, { once: true })
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => { release(); workers.delete(worker); terminate() }
    workers.add(worker)
    return worker
  }
  Worker.prototype = NativeWorker.prototype; Object.setPrototypeOf(Worker, NativeWorker)
  window.Worker = Worker
  window.addEventListener('pagehide', event => { if (!event.persisted) for (const worker of workers) worker.terminate() })
}

function bridgeScript(prefix) {
  return `<script>(${openCodeNetworkBootstrap.toString()})(${JSON.stringify(prefix)});(${openCodeSpriteBootstrap.toString()})(${JSON.stringify(prefix)});(${openCodeWorkerBootstrap.toString()})(${JSON.stringify(prefix)})</script>`
}

function prefixRootReferences(text, prefix) {
  return text
    .replace(/((?:src|href|action)=['"])\/(?!\/|__opencode\/)/gi, `$1${prefix}/`)
    .replace(/url\((['"]?)\/(?!\/|__opencode\/)/gi, `url($1${prefix}/`)
}

export function rewriteOpenCodeProxyText(input, prefixValue, { contentType = 'text/html', storage = {} } = {}) {
  const prefix = openCodeEmbedPrefix(String(prefixValue || '').replace(`${OPENCODE_EMBED_ROOT}/`, ''))
  let text = String(input ?? '')
  if (String(contentType).toLowerCase().includes('text/html')) {
    text = prefixRootReferences(text, prefix)
    if (!text.includes('__CLAWPANEL_OPENCODE_PREFIX__')) {
      const initial = JSON.stringify(sanitizeOpenCodeStorage(storage)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      text = text.replace(/<head([^>]*)>/i, `<head$1><script>(${openCodeStorageBootstrap.toString()})(${initial},${JSON.stringify(prefix)})</script>${bridgeScript(prefix)}`)
      // 等待父页的实时快照再执行原生入口；保留原 script 的 SRI/nonce 等属性。
      text = text.replace(/<script\b([^>]*\bsrc=['"][^'"]+['"][^>]*)>\s*<\/script>/gi, (original, attributes) => {
        if (!/\btype=['"]module['"]/i.test(attributes)) return original
        const markup = JSON.stringify(original).replace(/</g, '\\u003c')
        return `<script type="module">await window.__CLAWPANEL_OC_STORAGE_READY__;const template=document.createElement('template');template.innerHTML=${markup};const entry=document.createElement('script');for(const attribute of template.content.firstElementChild.attributes)entry.setAttribute(attribute.name,attribute.value);document.head.appendChild(entry)</script>`
      })
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

/** 改写前解码文本；限制解压后的大小，避免压缩响应被直接当作 UTF-8。 */
export function decodeOpenCodeProxyBody(body, encoding) {
  const normalized = String(encoding || 'identity').toLowerCase().trim()
  const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }
  if (!normalized || normalized === 'identity') return body
  const decode = decoders[normalized]
  if (!decode) throw new Error('OpenCode 响应使用不支持的内容编码')
  return decode(body, { maxOutputLength: 32 * 1024 * 1024 })
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
  } else result['accept-encoding'] = 'identity'
  return result
}
