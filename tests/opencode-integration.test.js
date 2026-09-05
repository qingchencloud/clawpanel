import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')

const main = read('../src/main.js')
const engineSelect = read('../src/pages/engine-select.js')
const engine = read('../src/engines/opencode/index.js')
const dashboard = read('../src/engines/opencode/pages/dashboard.js')
const workspace = read('../src/engines/opencode/pages/workspace.js')
const channels = read('../src/lib/model-channels.js')
const channelsPage = read('../src/pages/model-channels.js')
const tauriApi = read('../src/lib/tauri-api.js')
const devApi = read('../scripts/dev-api.js')
const adapter = read('../scripts/opencode.js')
const proxy = read('../scripts/opencode-proxy.js')
const serve = read('../scripts/serve.js')
const rustLib = read('../src-tauri/src/lib.rs')
const rustModule = read('../src-tauri/src/commands/opencode.rs')
const locales = read('../src/locales/index.js')

test('OpenCode 引擎、独立工作台、入口和语言包注册完整', () => {
  assert.match(main, /import openCodeEngine/)
  assert.match(main, /registerEngine\(openCodeEngine\)/)
  assert.match(engineSelect, /activeEngineId:\s*'opencode'/)
  assert.match(engineSelect, /targetRoute:\s*'\/opencode\/dashboard'/)
  assert.match(engine, /id:\s*'opencode'/)
  assert.match(engine, /path:\s*'\/opencode\/dashboard'/)
  assert.match(engine, /path:\s*'\/opencode\/workspace'/)
  assert.match(workspace, /id="oc-workspace-frame"/)
  assert.match(locales, /openCode/)
})

test('Web 与 Tauri 同名命令链完整，OpenCode 命令固定本机处理', () => {
  for (const command of ['opencode_status', 'opencode_install', 'opencode_check_update', 'opencode_update', 'opencode_uninstall', 'opencode_start', 'opencode_stop', 'opencode_sync_provider']) {
    assert.match(devApi, new RegExp(`${command}\\(`), `dev-api 缺少 ${command}`)
    assert.match(devApi, new RegExp(`'${command}'`), `${command} 必须加入 ALWAYS_LOCAL`)
    assert.match(rustLib, new RegExp(`opencode::${command}`), `Rust invoke handler 缺少 ${command}`)
  }
  assert.match(devApi, /'opencode_embed_session'/)
  for (const method of ['openCodeStatus', 'openCodeInstall', 'openCodeCheckUpdate', 'openCodeUpdate', 'openCodeUninstall', 'openCodeEmbedSession', 'openCodeStart', 'openCodeStop', 'openCodeSyncProvider']) {
    assert.match(tauriApi, new RegExp(`${method}:`), `tauri-api 缺少 ${method}`)
  }
})

test('在线更新使用暂存目录、版本核验和失败回滚，运行中更新会自动重启', () => {
  for (const source of [devApi, rustModule]) {
    assert.match(source, /runtime\.update-staging/)
    assert.match(source, /runtime\.update-backup/)
    assert.match(source, /已回滚原运行时/)
    assert.match(source, /更新后版本核对失败/)
  }
  assert.match(devApi, /fetchLatestOpenCodeVersion/)
  assert.match(rustModule, /latest_version\(\)/)
  assert.match(devApi, /if \(restart\) await stopOpenCode/)
  assert.match(devApi, /if \(restart\)[\s\S]{0,100}startOpenCode/)
  assert.match(rustModule, /if running \{[\s\S]{0,100}opencode_stop/)
  assert.match(dashboard, /api\.openCodeCheckUpdate\(\)/)
  assert.match(dashboard, /api\.openCodeUpdate\(\)/)
})

test('卸载可自动停止受管服务并保留配置、凭据和工作区', () => {
  assert.match(devApi, /isManagedOpenCodeProcess\(record\)[\s\S]{0,80}stopOpenCode/)
  assert.match(rustModule, /if running \{[\s\S]{0,180}opencode_stop/)
  for (const source of [devApi, rustModule]) {
    assert.doesNotMatch(source, /remove_dir_all\([^\n]*(home_dir|credential_dir|workspace_dir)/)
  }
  assert.match(dashboard, /status\.managedInstalled \? `<button[^`]+data-action="uninstall"/)
})

test('安装链固定版本且隔离运行时、配置、凭据与工作区', () => {
  for (const source of [adapter, rustModule]) assert.match(source, /1\.18\.21/)
  assert.match(devApi, /OPENCODE_PACKAGE_VERSION/)
  for (const source of [devApi, rustModule]) {
    assert.match(source, /--ignore-scripts/)
    assert.match(source, /credentials/)
    assert.match(source, /workspace/)
  }
  assert.match(devApi, /OPENCODE_PACKAGE_NAME/)
  assert.match(devApi, /command:\s*'cmd\.exe',[\s\S]{0,100}'npm'/, 'Windows npm 必须经 cmd.exe 启动，避免 spawn EINVAL')
  assert.match(rustModule, /opencode-ai/)
  assert.match(devApi, /verifiedOpenCodeRuntimeDir/)
  assert.match(rustModule, /verified_runtime_dir/)
  assert.match(dashboard, /api\.openCodeInstall\(\)/)
  assert.match(dashboard, /api\.openCodeUninstall\(\)/)
  assert.match(devApi, /保留|openCodeHomeDir|verifiedOpenCodeRuntimeDir/)
  assert.doesNotMatch(rustModule, /remove_dir_all\([^\n]*(home_dir|credential_dir|workspace_dir)/)
})

test('服务只监听回环地址，不停止非受管进程', () => {
  assert.match(devApi, /'--hostname',\s*'127\.0\.0\.1'/)
  assert.match(rustModule, /"--hostname",\s*"127\.0\.0\.1"/s)
  assert.doesNotMatch(devApi, /opencode[^\n]{0,120}--hostname[^\n]{0,40}0\.0\.0\.0/i)
  assert.doesNotMatch(rustModule, /--hostname[\s\S]{0,80}0\.0\.0\.0/)
  assert.match(devApi, /不是由 ClawPanel 启动，未执行停止操作/)
  assert.match(rustModule, /不是由 ClawPanel 启动，未执行停止操作/)
  assert.match(rustModule, /basic_auth\("opencode"/, '桌面端必须能识别 Web 版带服务密码启动的受管实例')
  assert.match(workspace, /requiresManagedAuth/, '桌面工作台必须提示重启 Web 版带密码的实例')
})

test('Web 版使用随机服务密码、短期令牌和沙箱代理内嵌', () => {
  assert.match(devApi, /crypto\.randomBytes\(32\)/)
  assert.match(devApi, /OPENCODE_SERVER_PASSWORD/)
  assert.match(devApi, /createOpenCodeEmbedSession/)
  assert.match(devApi, /_handleOpenCodeUpgrade/)
  assert.match(serve, /_handleOpenCodeUpgrade\(req, socket, head\)/)
  assert.match(workspace, /referrerpolicy="no-referrer"/)
  assert.match(workspace, /allow-scripts allow-forms allow-downloads allow-modals allow-popups/)
  assert.match(proxy, /cookie.*authorization|authorization.*cookie/s)
  assert.match(proxy, /\/__opencode/)
})

test('模型渠道可同步 OpenCode，并记录回读验证结果和容量字段', () => {
  assert.match(channels, /export async function syncChannelToOpenCode/)
  assert.match(channels, /api\.openCodeSyncProvider/)
  assert.match(channelsPage, /target === 'opencode'/)
  assert.match(channelsPage, /providerId:\s*result\.providerId,\s*verified:\s*result\.verified/)
  assert.match(adapter, /next\.limit\s*=[\s\S]{0,160}context/)
  assert.match(rustModule, /"limit"/)
  assert.match(rustModule, /resolve_model_api_key/)
  assert.match(rustModule, /sync_all\(\)/, '桌面配置临时文件必须完整落盘')
  assert.match(rustModule, /已回滚/, '桌面配置替换失败必须恢复原文件')
  assert.doesNotMatch(rustModule, /if path\.exists\(\)[\s\S]{0,180}remove_file\(path\)/, '不得先删除有效配置再替换')
  assert.doesNotMatch(tauriApi, /openCodeSyncProvider:\s*\(\{[^}]*apiKey/)
})
