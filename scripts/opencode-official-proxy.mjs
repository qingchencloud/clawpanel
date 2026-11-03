// 官方独立OpenCode的本机UI边界；Basic只在本进程内，前端只收到独立UI会话入口。
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { openCodeUpstreamHeaders, shouldRewriteOpenCodeResponse, decodeOpenCodeProxyBody } from './opencode-proxy.js'

export async function startOfficialOpenCodeProxy({ port, innerPort, password = '', cookie = '', engine = 'opencode' }) {
  if (!Number.isInteger(port) || !Number.isInteger(innerPort) || port < 1024 || innerPort < 1024 || !['opencode', 'deepseek-harness'].includes(engine) || !(password || cookie)) throw Error('official_runtime_proxy_invalid')
  const sessionToken = crypto.randomBytes(32).toString('base64url')
  const cookieToken = crypto.randomBytes(32).toString('base64url')
  const cookieName = `clawpanel_oc_ui_${port}_${crypto.randomBytes(6).toString('hex')}`
  const entries = new Map()
  const origin = `http://127.0.0.1:${port}`
  const sockets = new Set()
  const allowed = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
  function upstreamAuth(headers, websocket = false) {
    const result = openCodeUpstreamHeaders(headers, innerPort, { password, websocket })
    delete result['x-clawpanel-ui-session']
    if (cookie) { delete result.authorization;result.cookie = cookie }
    return result
  }
  function pluginStatic(url) {
    if (engine !== 'deepseek-harness') return false
    if (url.pathname === '/plugins/' && url.search.length <= 32768) {
      const matched = /^\?\?(.+)&rev=[a-f0-9]{12}$/.exec(url.search)
      const modules = matched?.[1].split(',') || []
      return modules.length > 0 && modules.length <= 256 && modules.every(file => /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\/client\.js$/.test(file))
    }
    return /^\/plugins\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(url.pathname) && /^\?rev=[a-f0-9]{12}$/.test(url.search)
  }
  function entry(options = {}) {
    const target = options.path || '/'
    const selection = options.selection
    if (target !== '/' && (engine !== 'opencode' || !/^\/[A-Za-z0-9_-]+\/session\/ses_[A-Za-z0-9]+$/.test(target))) throw Error('official_ui_target_invalid')
    if (selection && (engine !== 'deepseek-harness' || !/^session-[A-Za-z0-9-]+$/.test(selection.sessionId) || Object.keys(selection).length !== 1)) throw Error('official_ui_target_invalid')
    for (const [token, value] of entries) if (value.expires < Date.now()) entries.delete(token)
    while (entries.size >= 8) entries.delete(entries.keys().next().value)
    const token = crypto.randomBytes(32).toString('base64url');entries.set(token, { expires: Date.now() + 60000, target, selection })
    return origin + '/?clawpanel_ui_token=' + token
  }
  function authorize(req) {
    if (req.headers.host !== `127.0.0.1:${port}` || !allowed.has(req.method)) return null
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return null
    let url
    try { url = new URL(req.url, origin);const decoded = decodeURIComponent(req.url.split('?')[0]);if (decoded.includes('\\') || decoded.split('/').includes('..')) return null } catch { return null }
    if (url.origin !== origin || url.searchParams.has('auth_token')) return null
    // 外站simple POST同样可能写入；不能只依赖CORS阻止读取。
    const write = !['GET', 'HEAD'].includes(req.method)
    if ((write || req.headers.origin) && req.headers.origin !== origin) return null
    const bootstrap = url.searchParams.get('clawpanel_ui_token')
    if (bootstrap) {
      if (req.method !== 'GET' || url.pathname !== '/' || [...url.searchParams].length !== 1 || !entries.has(bootstrap) || entries.get(bootstrap).expires < Date.now()) return null
      const value = entries.get(bootstrap)
      entries.delete(bootstrap)
      return { upstreamPath: value.target, target: value.target, selection: value.selection, bootstrap: true, authenticated: true }
    }
    const header = req.headers['x-clawpanel-ui-session'] === sessionToken
    const query = !write && url.searchParams.getAll('clawpanel_ui_session').length === 1 && url.searchParams.get('clawpanel_ui_session') === sessionToken
    const cookie = !write && String(req.headers.cookie || '').split(';').some(pair => pair.trim() === cookieName + '=' + cookieToken)
    const publicStatic = !write && (/^\/(?:assets\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|svg|png|ico|webp|wasm|json)|favicon(?:-dark)?\.svg|manifest\.webmanifest)$/.test(url.pathname) || pluginStatic(url))
    if (!header && !query && !cookie && !publicStatic) return null
    if (write && !header) return null
    // DSH组合资源的??query是精确资源标识；无UI参数时保留原查询字节。
    if (url.searchParams.has('clawpanel_ui_session')) url.searchParams.delete('clawpanel_ui_session')
    return { upstreamPath: url.pathname + url.search, authenticated: header || query || cookie, publicStatic }
  }
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  function reject(res, status = 403) {
    headers(res);res.writeHead(status, { 'content-type': 'application/json' });res.end(JSON.stringify({ error: { code: 'official_runtime_access_denied' } }))
  }
  function securityPolicy(body) {
    const hashes = [...body.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`)
    const evaluation = engine === 'deepseek-harness' ? "'unsafe-eval'" : "'wasm-unsafe-eval'"
    return `default-src 'self'; script-src 'self' ${evaluation} ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; worker-src 'self' blob:; frame-ancestors http://127.0.0.1:* http://localhost:* tauri://localhost http://tauri.localhost:* https://tauri.localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'`
  }
  function bridge(route) {
    const seed = route.selection ? `localStorage.setItem('dsh.sessions.current',${JSON.stringify(JSON.stringify(route.selection))});` : ''
    // 闭包仅含本UI权限；不依赖第三方Cookie，也不把Basic/P/M/网关cap写给浏览器。
    return `<script>(()=>{${seed}const S=${JSON.stringify(sessionToken)},H='x-clawpanel-ui-session',O=location.origin;const local=u=>{const x=new URL(String(u),location.href);if(x.origin!==O)throw TypeError('official_runtime_external_request');return x};const original=window.fetch.bind(window);window.fetch=(u,o)=>{try{const r=new Request(u,o);local(r.url);const h=new Headers(r.headers);h.set(H,S);return original(new Request(r,{headers:h}))}catch(e){return Promise.reject(e)}};const targets=new WeakMap(),open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u,...r){targets.set(this,local(u).href);return open.call(this,m,u,...r)};XMLHttpRequest.prototype.send=function(...a){if(targets.has(this))this.setRequestHeader(H,S);return send.apply(this,a)};const ES=window.EventSource;if(ES){window.EventSource=function(u,o){const x=local(u);x.searchParams.set('clawpanel_ui_session',S);return new ES(x,o)};Object.setPrototypeOf(window.EventSource,ES);window.EventSource.prototype=ES.prototype}const WS=window.WebSocket;if(WS){window.WebSocket=function(u,p){const x=new URL(String(u),location.href);if(x.host!==location.host||!['ws:','wss:'].includes(x.protocol))throw TypeError('official_runtime_external_request');x.searchParams.set('clawpanel_ui_session',S);return new WS(x,p)};Object.setPrototypeOf(window.WebSocket,WS);window.WebSocket.prototype=WS.prototype}if(new URL(location.href).searchParams.has('clawpanel_ui_token'))history.replaceState(history.state,'',${JSON.stringify(route.target || '/')});})();</script>`
  }
  const server = http.createServer((req, res) => {
    const route = authorize(req)
    if (!route) return reject(res)
    if (req.method === 'OPTIONS') { headers(res);res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': [...allowed].join(', '), 'access-control-allow-headers': 'content-type, x-clawpanel-ui-session, x-opencode-directory, x-opencode-workspace' });res.end();return }
    if (Number(req.headers['content-length'] || 0) > 1024 * 1024) return reject(res, 413)
    let ended = false, responseStarted = false
    const fail = () => { if (!ended) { ended = true;if (!res.headersSent) reject(res, 502);else res.destroy() } }
    const upstreamHeaders = upstreamAuth(req.headers)
    const upstream = http.request({ hostname: '127.0.0.1', port: innerPort, path: route.upstreamPath, method: req.method, headers: upstreamHeaders }, response => {
      responseStarted = true
      headers(res)
      const type = String(response.headers['content-type'] || '')
      if (!route.authenticated && type.includes('text/html')) { response.destroy();return fail() }
      const rewrite = req.method !== 'HEAD' && shouldRewriteOpenCodeResponse(type)
      const blocked = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'www-authenticate', 'content-security-policy', 'x-frame-options', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', ...(rewrite ? ['content-length', 'content-encoding'] : [])])
      for (const [key, value] of Object.entries(response.headers)) {
        if (blocked.has(key) || value === undefined) continue
        if (key === 'location') {
          if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) { response.destroy();return fail() }
          res.setHeader(key, value)
        } else res.setHeader(key, value)
      }
      res.statusCode = response.statusCode || 502
      if (!rewrite) { response.pipe(res);response.on('error', fail);response.on('end', () => { ended = true });return }
      let size = 0;const chunks = []
      response.on('data', chunk => { size += chunk.length;if (size > 32 * 1024 * 1024) { response.destroy();fail() } else chunks.push(chunk) })
      response.on('error', fail)
      response.on('end', () => {
        if (ended) return
        try {
          const decoded = decodeOpenCodeProxyBody(Buffer.concat(chunks), response.headers['content-encoding'])
          const raw = decoded.toString('utf8')
          const body = type.includes('text/html') ? raw.replace(/<head([^>]*)>/i, `<head$1>${bridge(route)}`) : raw
          if (type.includes('text/html')) res.setHeader('Content-Security-Policy', securityPolicy(body))
          if (route.bootstrap) res.setHeader('Set-Cookie', `${cookieName}=${cookieToken}; Path=/; HttpOnly; SameSite=Strict`)
          ended = true;res.end(body)
        } catch { fail() }
      })
    })
    upstream.on('error', fail)
    upstream.setTimeout(120000, () => upstream.destroy())
    let size = 0
    req.on('data', chunk => { size += chunk.length;if (size > 1024 * 1024) { upstream.destroy();if (!res.headersSent) reject(res, 413) } })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => { if (!ended && responseStarted) upstream.destroy() })
    req.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket);socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const route = authorize(req)
    if (!route || req.headers.origin !== origin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return }
    const target = net.createConnection(innerPort, '127.0.0.1', () => {
      const upstreamHeaders = upstreamAuth(req.headers, true)
      target.write(`${req.method} ${route.upstreamPath} HTTP/1.1\r\n${Object.entries(upstreamHeaders).map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) target.write(head)
      socket.pipe(target);target.pipe(socket)
    })
    sockets.add(target);target.on('close', () => sockets.delete(target));target.on('error', () => socket.destroy());socket.on('error', () => target.destroy());socket.on('close', () => target.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(port, '127.0.0.1', resolve) })
  return { src: entry(), sessionToken, entry, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy();server.close(resolve) }) }
}
