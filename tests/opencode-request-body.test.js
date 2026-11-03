import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { openCodeNetworkBootstrap } from '../scripts/opencode-proxy.js'
test('映射 Request 不把固定 JSON 请求变成 HTTP/1 不支持的上传流，保留认证隔离及 signal', async () => {
 const calls = [], origin = 'http://panel.test:1420', prefix = '/__opencode/' + 'a'.repeat(40)
 const window = { fetch: async (...args) => { calls.push(args); return new Response('{}') } }
 const history = { pushState() {}, replaceState() {} }, location = new URL(origin + '/?__opencode_embed=' + 'a'.repeat(40))
 const context = { window, history, location, Request, URL, DOMException, Uint8Array, XMLHttpRequest: { prototype: { open() {} } } }
 vm.runInNewContext(`(${openCodeNetworkBootstrap.toString()})(${JSON.stringify(prefix)})`, context)
 const controller = new AbortController()
 await window.fetch(new Request(origin + '/session/test/prompt_async', { method: 'POST', headers: { 'content-type':'application/json' }, body:'{"text":"完整😀"}', signal:controller.signal }))
 assert.equal(calls.length, 1); assert.equal(calls[0][0], prefix + '/session/test/prompt_async')
 const init = calls[0][1]; assert.equal(init.method,'POST'); assert.equal(init.headers.get('content-type'),'application/json')
 assert.ok(init.body instanceof ArrayBuffer); assert.equal(new TextDecoder().decode(init.body),'{"text":"完整😀"}')
 assert.equal(init.signal.aborted,false);controller.abort();assert.equal(init.signal.aborted,true)
})

test('超过上限及时取消正文消费，挂起流能够被 signal 终止', async () => {
 const calls=[], window={fetch:async(...args)=>{calls.push(args);return new Response('{}')}},history={pushState(){},replaceState(){}},location=new URL('http://panel.test:1420/')
 const context={window,history,location,Request,URL,DOMException,Uint8Array,XMLHttpRequest:{prototype:{open(){}}}}
 vm.runInNewContext(`(${openCodeNetworkBootstrap.toString()})("/__opencode/${'c'.repeat(40)}")`,context)
 let produced=0,canceled=false
 const body=new ReadableStream({pull(c){produced++;if(produced<=40)c.enqueue(new Uint8Array(1024*1024));else c.close()},cancel(){canceled=true}},{highWaterMark:0})
 await assert.rejects(window.fetch(new Request(location.origin+'/session',{method:'POST',body,duplex:'half'})),{name:'QuotaExceededError'})
 assert.ok(produced<=34,`consumed ${produced} MiB`);assert.equal(canceled,true);assert.equal(calls.length,0)
 const controller=new AbortController(),pending=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){}})
 const request=window.fetch(new Request(location.origin+'/session',{method:'POST',body:pending,duplex:'half',signal:controller.signal}))
 controller.abort();await assert.rejects(Promise.race([request,new Promise((_,no)=>setTimeout(()=>no(Error('abort did not settle')),300))]),{name:'AbortError'})
})
