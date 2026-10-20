import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
test('生产服务器仅把受管嵌入预检交回能力令牌校验，普通 API OPTIONS 不执行命令', () => {
 const serve = read('../scripts/serve.js')
 assert.match(serve, /req\.method === 'OPTIONS' && !isOpenCodeEmbedRequest\(req\.url\)/)
 assert.match(read('../scripts/dev-api.js'), /export \{[^}]*isOpenCodeEmbedRequest/)
})
