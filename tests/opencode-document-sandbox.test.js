import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('能力文档即使直接打开也具有响应级 opaque sandbox',()=>{
 const source=readFileSync(new URL('../scripts/dev-api.js',import.meta.url),'utf8')
 const proxy=source.slice(source.indexOf('function copyOpenCodeProxyHeaders'),source.indexOf('function proxyOpenCodeEmbedHttp'))
 assert.match(proxy,/sandbox allow-scripts allow-forms allow-downloads allow-modals allow-popups/)
 assert.doesNotMatch(proxy,/sandbox[^\n]*allow-same-origin/)
})

test('DSH 能力文档同样具有响应级 opaque sandbox，预检先验令牌',()=>{
 const source=readFileSync(new URL('../scripts/dev-api.js',import.meta.url),'utf8')
 const proxy=source.slice(source.indexOf('function copyDshProxyResponseHeaders'),source.indexOf('function proxyDshEmbedHttp'))
 assert.match(proxy,/sandbox allow-scripts allow-forms allow-downloads allow-modals allow-popups/)
 assert.match(readFileSync(new URL('../scripts/serve.js',import.meta.url),'utf8'),/req\.method === 'OPTIONS' && !isOpenCodeEmbedRequest\(req\.url\) && !isDshEmbedRequest\(req\.url\)/)
})
