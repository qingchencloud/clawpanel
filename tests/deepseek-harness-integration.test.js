import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')

const main = read('../src/main.js')
const engine = read('../src/engines/deepseek-harness/index.js')
const dashboard = read('../src/engines/deepseek-harness/pages/dashboard.js')
const workspace = read('../src/engines/deepseek-harness/pages/workspace.js')
const channels = read('../src/lib/model-channels.js')
const channelsPage = read('../src/pages/model-channels.js')
const tauriApi = read('../src/lib/tauri-api.js')
const devApi = read('../scripts/dev-api.js')
const adapter = read('../scripts/deepseek-harness.js')
const rustLib = read('../src-tauri/src/lib.rs')
const rustModule = read('../src-tauri/src/commands/deepseek_harness.rs')
const locales = read('../src/locales/index.js')
const serve = read('../scripts/serve.js')
const proxy = read('../scripts/deepseek-harness-proxy.js')

test('DeepSeek Harness 引擎、页面和语言包注册完整', () => {
  assert.match(main, /import deepseekHarnessEngine/)
  assert.match(main, /registerEngine\(deepseekHarnessEngine\)/)
  const engineSelect = read('../src/pages/engine-select.js')
  assert.match(engineSelect, /activeEngineId:\s*'deepseek-harness'/)
  assert.match(engineSelect, /targetRoute:\s*'\/dsh\/dashboard'/)
  assert.match(engine, /id:\s*'deepseek-harness'/)
  assert.match(engine, /path:\s*'\/dsh\/dashboard'/)
  assert.match(engine, /path:\s*'\/dsh\/workspace'/)
  assert.match(engine, /route:\s*'\/dsh\/workspace'/)
  assert.match(dashboard, /api\.dshInstall\(\)/)
  assert.match(dashboard, /api\.dshUninstall\(\)/)
  assert.doesNotMatch(dashboard, /dsh-workspace-frame/)
  assert.match(workspace, /api\.dshEmbedSession\(state\.status\.port, readDshWebStorage\(\)\)/)
  assert.match(workspace, /clawpanel-dsh-web-storage-v1/)
  assert.match(workspace, /event\.source !== frame\.contentWindow/)
  assert.match(dashboard, /api\.dshStart\(state\.port\)/)
  assert.match(dashboard, /api\.dshStop\(state\.port\)/)
  assert.match(locales, /deepseekHarness/)
})

test('Web 版通过专用令牌和沙箱代理内嵌完整 Harness 页面', () => {
  assert.match(devApi, /dsh_embed_session/)
  assert.match(devApi, /createDshEmbedSession/)
  assert.match(devApi, /_handleDshUpgrade/)
  assert.match(serve, /_handleDshUpgrade\(req, socket, head\)/)
  assert.match(tauriApi, /dshEmbedSession:/)
  assert.match(workspace, /id="dsh-workspace-frame"/)
  assert.match(workspace, /referrerpolicy="no-referrer"/)
  assert.match(workspace, /allow-scripts allow-forms allow-downloads allow-modals allow-popups/)
  assert.match(proxy, /cookie.*authorization|authorization.*cookie/s)
  assert.match(proxy, /\/__dsh/)
  assert.match(proxy, /clawpanel-dsh-storage/)
})

test('Web 与 Tauri 同名命令链完整且 Web 命令固定本机处理', () => {
  for (const command of ['dsh_status', 'dsh_install', 'dsh_uninstall', 'dsh_start', 'dsh_stop', 'dsh_sync_provider']) {
    assert.match(devApi, new RegExp(`${command}\\(`), `dev-api 缺少 ${command}`)
    assert.match(devApi, new RegExp(`'${command}'`), `${command} 必须加入 ALWAYS_LOCAL`)
    assert.match(rustLib, new RegExp(`deepseek_harness::${command}`), `Rust invoke handler 缺少 ${command}`)
  }
  for (const method of ['dshStatus', 'dshInstall', 'dshUninstall', 'dshStart', 'dshStop', 'dshSyncProvider']) {
    assert.match(tauriApi, new RegExp(`${method}:`), `tauri-api 缺少 ${method}`)
  }
})

test('安装链固定 DSH 与 pnpm 版本，并显式允许所需原生构建', () => {
  for (const source of [adapter, rustModule]) {
    assert.match(source, /0\.1\.1-rc\.2/)
  }
  for (const source of [devApi, rustModule]) {
    assert.match(source, /11\.7\.0/)
    for (const dependency of ['dsh-subprocess-local', 'koffi', 'node-pty', 'protobufjs']) {
      assert.match(source, new RegExp(dependency))
    }
    assert.match(source, /allow-build/)
  }
})

test('Harness 服务只绑定回环地址且不会终止非受管进程', () => {
  assert.match(devApi, /'--host',\s*'127\.0\.0\.1'/)
  assert.match(rustModule, /"--host"\.into\(\),\s*"127\.0\.0\.1"\.into\(\)/s)
  assert.doesNotMatch(devApi, /dsh[^\n]{0,120}--host[^\n]{0,40}0\.0\.0\.0/i)
  assert.doesNotMatch(rustModule, /--host[\s\S]{0,80}0\.0\.0\.0/)
  assert.match(devApi, /不是由 ClawPanel 启动，未执行停止操作/)
  assert.match(rustModule, /不是由 ClawPanel 启动，未执行停止操作/)
  assert.match(dashboard, /loopbackDesc/)
  assert.match(workspace, /dsh-workspace-frame/)
})

test('受管运行时支持安全卸载并保留 Harness 配置', () => {
  assert.match(devApi, /verifiedDshRuntimeDir/)
  assert.match(rustModule, /verified_runtime_dir/)
  assert.match(devApi, /path\.basename\(actual\) !== 'deepseek-harness'/)
  assert.match(rustModule, /file_name\(\).*Some\("deepseek-harness"\)/s)
  assert.match(devApi, /请先停止 ClawPanel 管理的 DeepSeek Harness/)
  assert.match(rustModule, /请先停止 ClawPanel 管理的 DeepSeek Harness/)
  assert.doesNotMatch(devApi, /remove.*\.deepseek|rmSync\([^\n]*\.deepseek/i)
  assert.doesNotMatch(rustModule, /remove_dir_all\([^\n]*\.deepseek/i)
})

test('模型渠道包含 Harness 同步、回读标记和可编辑上下文容量', () => {
  assert.match(channels, /export async function syncChannelToDsh/)
  assert.match(channels, /api\.dshSyncProvider/)
  assert.match(channelsPage, /target === 'dsh'/)
  assert.match(channelsPage, /providerId:\s*result\.providerId,\s*verified:\s*result\.verified/)
  assert.match(channelsPage, /id="mch-context-window"/)
  assert.match(channelsPage, /id="mch-max-tokens"/)
  assert.match(channelsPage, /contextWindow/)
  assert.match(channelsPage, /maxTokens/)
})

test('Harness 凭据只单向写入，状态响应不包含密钥值', () => {
  assert.match(adapter, /credentials\.set/)
  assert.match(rustModule, /"credentials\.set"/)
  assert.match(adapter, /credentials\.describe/)
  assert.match(rustModule, /"credentials\.describe"/)
  assert.doesNotMatch(channels, /syncChannelToDsh[\s\S]{0,400}revealModelChannelKey/)
  assert.match(tauriApi, /dshSyncProvider:\s*\(\{\s*channelId,\s*setDefault/)
  assert.doesNotMatch(tauriApi, /dshSyncProvider:\s*\(\{[^}]*apiKey/)
  assert.doesNotMatch(dashboard, /credential.*value|apiKey.*value/i)
})
