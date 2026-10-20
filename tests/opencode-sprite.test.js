import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteOpenCodeProxyText } from '../scripts/opencode-proxy.js'
test('opaque iframe 图标转为内联 symbol，资产只走当前能力代理且大小有界', () => {
 const html=rewriteOpenCodeProxyText('<head></head>','/__opencode/'+'b'.repeat(40))
 assert.match(html,/openCodeSpriteBootstrap/);assert.match(html,/SVGUseElement\.prototype/);assert.match(html,/2 \* 1024 \* 1024/)
 assert.doesNotMatch(html,/allow-same-origin/)
})
