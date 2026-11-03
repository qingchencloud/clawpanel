import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('官方模型以普通 provider 一键接入，不写平台凭据', () => {
  const source = read('src-tauri/src/commands/official_provider.rs')
  assert.match(source, /models\/providers\/clawpanel-official/)
  assert.match(source, /"apiKey": connection\["apiKey"\]/)
  assert.match(source, /save_openclaw_json/)
  // 引擎配置里只能是本机占位 key，不能出现平台 token / DPoP
  assert.doesNotMatch(source, /access_token|refresh_token|dpop|DPoP/)
  assert.match(source, /official_provider_install/)
  assert.match(source, /official_provider_remove/)
})

test('代理支持普通 provider：操作 ID 可缺省，端口与能力令牌持久化', () => {
  const source = read('src-tauri/src/commands/platform_gateway.rs')
  assert.match(source, /None => identity::random_id\(\)/)
  assert.match(source, /official-gateway\.json/)
  assert.match(source, /ensure_gateway_listener/)
  assert.match(source, /fn save_proxy_state/)
})

test('前端去掉独立官方会话入口，改为账户页一键接入', () => {
  const chat = read('src/pages/chat.js')
  assert.match(chat, /history\.replaceState\(null, '', '#\/chat'\)/)
  assert.match(chat, /旧版独立官方会话入口已停用/)
  const account = read('src/pages/account.js')
  assert.match(account, /createOfficialProviderCard/)
  assert.match(account, /data-platform-official-provider-slot/)
  const models = read('src/pages/models.js')
  assert.doesNotMatch(models, /createGatewayOfficialCard/)
  const api = read('src/lib/tauri-api.js')
  assert.match(api, /officialProviderInstall/)
  assert.match(api, /officialProviderRemove/)
})
