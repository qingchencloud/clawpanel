/**
 * DeepSeek Harness Web 内嵌代理的纯函数。
 *
 * DSH 0.1.1-rc.2 的浏览器包使用 /plugins、/assets 与 /api 绝对路径，
 * 因此远程 Web 版不能只把首页挂在一个子路径下。这里把这些固定入口
 * 改写到带短期能力令牌的隔离路径；令牌只允许访问 DSH，不授予 ClawPanel API。
 */

export const DSH_EMBED_ROOT = '/__dsh'
export const DSH_EMBED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export function dshEmbedPrefix(token) {
  const normalized = String(token || '')
  if (!DSH_EMBED_TOKEN_PATTERN.test(normalized)) throw new Error('无效的 DeepSeek Harness 内嵌令牌')
  return `${DSH_EMBED_ROOT}/${normalized}`
}

export function parseDshEmbedUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ''), 'http://clawpanel.local')
  // 拒绝编码后的路径分隔符和点段，避免代理路径与校验路径产生歧义。
  const rawPath = String(rawUrl || '').split('?')[0]
  if (/%(?:2e|2f|5c)/i.test(rawPath) || rawPath.includes('\\')) return null
  const match = parsed.pathname.match(/^\/__dsh\/([A-Za-z0-9_-]{32,128})(\/.*)?$/)
  if (!match) return null
  const suffix = match[2] || '/'
  return {
    token: match[1],
    prefix: `${DSH_EMBED_ROOT}/${match[1]}`,
    upstreamPath: `${suffix}${parsed.search}`,
    upstreamPathname: suffix,
  }
}

function replaceAbsoluteEntry(text, prefix, entry) {
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp("([\"'`(=])\\/" + escaped + "(?=\\/|\\?|[\"'`)\\s])", 'g')
  return text.replace(pattern, `$1${prefix}/${entry}`)
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function dshSandboxCompatibilityShim(prefix, initialStorage) {
  const prefixLiteral = safeScriptJson(prefix)
  const storageLiteral = safeScriptJson(initialStorage || {})
  return `<script>(()=>{
const proxyPrefix=${prefixLiteral}
const proxyRoots=['/api','/plugins','/assets','/manifest.webmanifest','/favicon.svg']
const mappedUrl=value=>{
  try{
    const url=new URL(value instanceof URL?value.href:String(value),location.href)
    const page=new URL(location.href)
    const sameHost=url.hostname===page.hostname&&url.port===page.port
    const pairedProtocol=(url.protocol===page.protocol)||(page.protocol==='http:'&&url.protocol==='ws:')||(page.protocol==='https:'&&url.protocol==='wss:')
    if(!sameHost||!pairedProtocol||url.pathname===proxyPrefix||url.pathname.startsWith(proxyPrefix+'/'))return null
    if(!proxyRoots.some(root=>url.pathname===root||url.pathname.startsWith(root+'/')))return null
    url.pathname=proxyPrefix+url.pathname
    return url.href
  }catch{return null}
}
const values=Object.assign(Object.create(null),${storageLiteral})
const notifyStorage=(op,key,value)=>{
  try{parent.postMessage({type:'clawpanel-dsh-storage',op,key,value},location.origin)}catch{}
}
const storage={
  get length(){return Object.keys(values).length},
  key(index){return Object.keys(values)[Number(index)]??null},
  getItem(key){key=String(key);return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null},
  setItem(key,value){key=String(key);value=String(value);values[key]=value;notifyStorage('set',key,value)},
  removeItem(key){key=String(key);delete values[key];notifyStorage('remove',key)},
  clear(){for(const key of Object.keys(values))delete values[key];notifyStorage('clear')},
}
try{Object.defineProperty(window,'localStorage',{value:storage,configurable:false})}catch{}
const nativeCreateElement=document.createElement.bind(document)
document.createElement=(name,options)=>{
  const element=options===undefined?nativeCreateElement(name):nativeCreateElement(name,options)
  if(String(name).toLowerCase()==='script')element.crossOrigin='anonymous'
  return element
}
const nativeFetch=window.fetch.bind(window)
window.fetch=(input,init)=>{
  if(input instanceof Request){
    const mapped=mappedUrl(input.url)
    return nativeFetch(mapped?new Request(mapped,input):input,init)
  }
  return nativeFetch(mappedUrl(input)||input,init)
}
const nativeXhrOpen=XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open=function(method,url,...rest){return nativeXhrOpen.call(this,method,mappedUrl(url)||url,...rest)}
const NativeWebSocket=window.WebSocket
window.WebSocket=class extends NativeWebSocket{
  constructor(url,protocols){
    const target=mappedUrl(url)||url
    if(arguments.length>1)super(target,protocols);else super(target)
  }
}
if(window.EventSource){
  const NativeEventSource=window.EventSource
  window.EventSource=class extends NativeEventSource{
    constructor(url,options){
      const target=mappedUrl(url)||url
      if(arguments.length>1)super(target,options);else super(target)
    }
  }
}
if(navigator.sendBeacon){
  const nativeSendBeacon=navigator.sendBeacon.bind(navigator)
  navigator.sendBeacon=(url,data)=>nativeSendBeacon(mappedUrl(url)||url,data)
}
window.__CLAWPANEL_DSH_SANDBOX__=true
})()</script>`
}

function injectDshSandboxCompatibility(text, prefix, storage) {
  if (!/<html[\s>]/i.test(text) || text.includes('__CLAWPANEL_DSH_SANDBOX__')) return text
  return text.replace(/<head([^>]*)>/i, `<head$1>${dshSandboxCompatibilityShim(prefix, storage)}`)
}

export function rewriteDshProxyText(input, prefixValue, { contentType = 'text/html', storage = {} } = {}) {
  const prefix = dshEmbedPrefix(String(prefixValue || '').replace(`${DSH_EMBED_ROOT}/`, ''))
  let text = String(input ?? '')
  const type = String(contentType || '').toLowerCase()
  // JavaScript 内部的 /api 同时也是 DSH RPC channel，直接改写会破坏目标校验。
  // HTML/Manifest/CSS 中的资源入口仍可静态改写，运行时请求由上面的沙箱 shim 接管。
  if (type.includes('text/html') || type.includes('text/css') || type.includes('manifest')) {
    for (const entry of ['api', 'plugins', 'assets', 'manifest.webmanifest', 'favicon.svg']) {
      text = replaceAbsoluteEntry(text, prefix, entry)
    }
  }
  if (type.includes('text/html')) {
    text = text.replace(/<script(?![^>]*\bcrossorigin\s*=)(?=[^>]*\bsrc\s*=)/gi, '<script crossorigin="anonymous"')
  }
  // Web App Manifest 的根 scope/start_url 也必须留在令牌路径中。
  if (type.includes('manifest')) {
    text = text
      .replace(/("start_url"\s*:\s*")\/("\s*[,}])/g, `$1${prefix}/$2`)
      .replace(/("scope"\s*:\s*")\/("\s*[,}])/g, `$1${prefix}/$2`)
  }
  return type.includes('text/html') ? injectDshSandboxCompatibility(text, prefix, storage) : text
}

const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization', 'connection', 'cookie', 'host', 'keep-alive', 'origin',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'referer',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export function dshUpstreamHeaders(headers, port, { websocket = false } = {}) {
  const result = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase()
    if (REQUEST_HEADER_BLOCKLIST.has(name) || name.startsWith('x-forwarded-')) continue
    if (name.startsWith('sec-fetch-')) continue
    if (rawValue !== undefined) result[name] = rawValue
  }
  result.host = `127.0.0.1:${port}`
  result.origin = `http://127.0.0.1:${port}`
  result.referer = `http://127.0.0.1:${port}/`
  result['sec-fetch-site'] = 'same-origin'
  if (websocket) {
    result.connection = 'Upgrade'
    result.upgrade = 'websocket'
  } else {
    result['accept-encoding'] = 'identity'
  }
  return result
}

export function shouldRewriteDshResponse(contentType, upstreamPathname) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('text/html') || type.includes('text/css')) return true
  return upstreamPathname === '/manifest.webmanifest'
}
