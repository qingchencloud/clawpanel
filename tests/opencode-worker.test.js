import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteOpenCodeProxyText } from '../scripts/opencode-proxy.js'
test('Markdown Worker 保持 opaque origin，通过 Blob 启动受管资产并可终止释放', () => {
 const html=rewriteOpenCodeProxyText('<head></head>','/__opencode/'+'b'.repeat(40))
 assert.match(html,/openCodeWorkerBootstrap/);assert.match(html,/URL\.revokeObjectURL/);assert.match(html,/pagehide/)
 assert.doesNotMatch(html,/allow-same-origin/)
})

test('classic Worker 内的相对 importScripts 保留原始受管资产基址',()=>{
 const html=rewriteOpenCodeProxyText('<head></head>','/__opencode/'+'d'.repeat(40))
 assert.match(html,/self\.importScripts=\(\.\.\.urls\)/)
})
