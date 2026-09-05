import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')

const lib = read('../src/lib/model-channels.js')
const page = read('../src/pages/model-channels.js')
const modelsPage = read('../src/pages/models.js')
const mainJs = read('../src/main.js')
const sidebar = read('../src/components/sidebar.js')
const tauriApi = read('../src/lib/tauri-api.js')
const devApi = read('../scripts/dev-api.js')
const rustLib = read('../src-tauri/src/lib.rs')
const rustModule = read('../src-tauri/src/commands/model_channels.rs')
const rustHermes = read('../src-tauri/src/commands/hermes.rs')
const rustConfig = read('../src-tauri/src/commands/config.rs')
const rustMedia = read('../src-tauri/src/commands/media.rs')
const localesIndex = read('../src/locales/index.js')

test('模型渠道命令注册链完整（Rust + tauri-api + dev-api + ALWAYS_LOCAL）', () => {
  for (const cmd of ['read_model_channels', 'write_model_channels', 'reveal_model_channel_key']) {
    assert.match(rustLib, new RegExp(`model_channels::${cmd}`), `lib.rs 缺少 ${cmd} 注册`)
    assert.match(devApi, new RegExp(`${cmd}\\(`), `dev-api.js 缺少 ${cmd} handler`)
    assert.match(devApi, new RegExp(`'${cmd}'`), `${cmd} 必须加入 ALWAYS_LOCAL（本机属性不可代理远程）`)
  }
  assert.match(tauriApi, /readModelChannels:/, 'tauri-api 缺少 readModelChannels 封装')
  assert.match(tauriApi, /writeModelChannels:/, 'tauri-api 缺少 writeModelChannels 封装')
  assert.match(tauriApi, /revealModelChannelKey:/, 'tauri-api 缺少 revealModelChannelKey 封装')
})

test('渠道读取只返回掩码，写入支持保留旧 Key 哨兵', () => {
  assert.match(rustModule, /apiKeySaved/, '读取必须返回 apiKeySaved')
  assert.match(rustModule, /apiKeyMask/, '读取必须返回 apiKeyMask')
  assert.match(rustModule, /__KEEP__/, '写入必须支持 __KEEP__ 哨兵')
  assert.match(devApi, /isChannelKeepSentinel/, 'dev-api 必须实现相同的哨兵语义')
})

test('Hermes 同步契约与内核注册表一致（已按内核源码核对）', () => {
  // 回退 provider id 必须是注册表真实存在的 API Key 型 id
  assert.match(lib, /'openai-completions':\s*\{\s*fallbackProvider:\s*'custom'/, 'OpenAI 兼容渠道应回退到 custom provider')
  assert.match(lib, /'anthropic-messages':\s*\{\s*fallbackProvider:\s*'anthropic'/, 'Anthropic 渠道应回退到 anthropic provider')
  assert.match(lib, /'google-generative-ai':\s*\{\s*fallbackProvider:\s*'gemini'/, 'Gemini 渠道应回退到 gemini provider（内核经 OpenAI 兼容端点接入）')
  assert.match(lib, /authType === 'api_key'/, 'OAuth/SDK 型 provider 必须被排除在渠道同步之外')
  // 内核不解析 "provider/model" 前缀：model.default 必须写纯模型 ID
  assert.match(lib, /model:\s*channel\.defaultModel\s*\|\|\s*''/, 'model.default 必须是纯模型 ID，不得拼接 provider 前缀')
  // 自定义端点只对 OpenAI 兼容渠道生效，避免破坏 anthropic/gemini 的专用端点
  assert.match(lib, /channel\.apiType === 'openai-completions'\s*&&\s*Boolean\(channel\.baseUrl\)/, '自定义 Base URL 仅限 OpenAI 兼容渠道')
})

test('OpenClaw 模型条目恒写完整对象（内核 strict schema 要求 id/name 必填）', () => {
  assert.match(lib, /name:\s*model\.name\s*\|\|\s*prevObj\.name\s*\|\|\s*model\.id/, '模型条目 name 必填，缺省回退为 id')
  assert.doesNotMatch(lib, /:\s*model\.id\s*\n\s*\}\)\s*$/m, '不得写裸字符串模型条目')
})

test('OpenClaw 同步只 upsert 单个 provider 并保留未知字段', () => {
  assert.match(lib, /\.\.\.existing,/, '写入 provider 时必须展开旧对象保留未知字段')
  assert.match(lib, /providers:\s*\{\s*\[providerKey\]:\s*providerPatch\s*\}/, '必须按 provider 键发送最小补丁')
})

test('结构化模型 SecretRef 不会被编辑器或渠道同步转成字符串', () => {
  assert.match(lib, /channel\?\.apiKeyRef/, '渠道同步必须识别结构化 SecretRef')
  assert.match(lib, /apiKey:\s*apiKeyValue/, 'OpenClaw 写入必须保留原始凭据值类型')
  assert.match(
    modelsPage,
    /hasStructuredApiKey[\s\S]{0,900}!String\(apiKey\s*\|\|\s*''\)\.trim\(\)[\s\S]{0,300}existingApiKey/,
    '旧模型编辑器留空时必须保留结构化 SecretRef',
  )
})

test('同步与删除必须经过确认弹窗', () => {
  assert.match(page, /showConfirm\(t\('modelChannels\.syncOpenclawConfirm'/, '同步 OpenClaw 前必须确认')
  assert.match(page, /showConfirm\(t\('modelChannels\.syncHermesConfirm'/, '同步 Hermes 前必须确认')
  assert.match(page, /showConfirm\(t\('modelChannels\.syncOpenCodeConfirm'/, '同步 OpenCode 前必须确认')
  assert.match(page, /showConfirm\(t\('modelChannels\.syncAssistantConfirm'/, '同步助手前必须确认')
  assert.match(page, /showConfirm\(t\('modelChannels\.deleteConfirm'/, '删除渠道前必须确认')
})

test('页面注册链完整（路由 + 侧栏 + 语言包）', () => {
  assert.match(mainJs, /registerRoute\('\/model-channels'/, 'main.js 缺少路由注册')
  assert.match(sidebar, /route: '\/model-channels'/, '侧栏缺少入口')
  assert.match(sidebar, /'channels-hub':/, '侧栏缺少图标')
  assert.match(localesIndex, /modelChannels/, '语言包聚合缺少 modelChannels 模块')
})

test('删除 OpenClaw provider 使用显式墓碑补丁并等待后端成功', () => {
  assert.match(tauriApi, /deleteOpenclawModelProvider:/, 'tauri-api 缺少 provider 删除封装')
  assert.match(
    modelsPage,
    /await api\.deleteOpenclawModelProvider\(providerKey,\s*\{\s*noReload:\s*true\s*\}\)/,
    '模型页必须等待后端删除成功后再更新 UI',
  )
  assert.doesNotMatch(
    modelsPage,
    /case 'delete-provider':[\s\S]{0,500}autoSave\(state\)/,
    '删除 provider 不得继续依赖省略键自动保存',
  )
})

test('Web 配置写入使用备份、fsync、替换和回读校验', () => {
  assert.match(devApi, /writeJsonAtomic\(CONFIG_PATH,\s*cleaned,\s*\{\s*backup:\s*true\s*\}\)/)
  assert.match(devApi, /fs\.fsyncSync\(/, '候选配置落盘后必须 fsync')
  assert.match(devApi, /配置写入后回读不一致/, '替换后必须回读验证')
  assert.match(
    devApi,
    /writeJsonAtomic\(modelChannelsPath\(\),\s*normalized,\s*\{\s*backup:\s*true\s*\}\)/,
    '渠道密钥文件也必须保留备份',
  )
})

test('桌面端渠道密钥文件使用安全替换、备份和回读校验', () => {
  assert.match(rustMedia, /OpenOptions::new\(\)[\s\S]{0,500}sync_all\(\)/, '临时文件必须完整落盘')
  assert.match(rustMedia, /JSON 写入后回读不一致/, '替换后必须回读验证')
  assert.doesNotMatch(
    rustMedia,
    /if path\.exists\(\)[\s\S]{0,120}remove_file\(path\)/,
    '不得先删除有效文件再尝试替换',
  )
  assert.match(
    rustModule,
    /channels_path\(\)[\s\S]{0,500}model-channels\.json\.bak|with_extension\("json\.bak"\)/,
    '渠道密钥文件必须保留最后有效备份',
  )
})

test('Hermes 同步在后端解析 OpenClaw 环境变量引用', () => {
  assert.match(
    rustHermes,
    /super::config::resolve_model_api_key\(&api_key\)/,
    '桌面端必须在写 Hermes .env 前解析环境变量引用',
  )
  assert.match(
    devApi,
    /hermes_sync_provider\([\s\S]{0,300}apiKey:\s*resolveModelApiKey\(apiKey\)/,
    'Web 端必须在写 Hermes .env 前解析环境变量引用',
  )
})

test('Hermes 配置事务在提交前落盘并在提交后回读', () => {
  assert.match(rustHermes, /sync_all\(\)/, '桌面端 Hermes 临时文件必须 fsync')
  assert.match(rustHermes, /Hermes 配置写入后回读不一致/, '桌面端 Hermes 提交后必须回读')
  assert.match(
    devApi,
    /replaceHermesFilesTransaction[\s\S]{0,1600}fs\.fsyncSync\([\s\S]{0,800}Hermes 配置写入后回读不一致/,
    'Web 端 Hermes 事务必须 fsync 并回读',
  )
})

test('模型连通性测试不把不同协议静默降级成 Chat Completions', () => {
  assert.match(rustConfig, /"openai-responses"\s*\|\s*"azure-openai-responses"[\s\S]{0,500}\/responses/)
  assert.match(devApi, /\['openai-responses',\s*'azure-openai-responses'\][\s\S]{0,600}\/responses/)
  assert.match(rustConfig, /该 API 类型需要由 OpenClaw 运行时验证/)
  assert.match(devApi, /该 API 类型需要由 OpenClaw 运行时验证/)
  assert.doesNotMatch(rustConfig, /返回成功但带提示[\s\S]{0,200}return Ok\(/)
  assert.doesNotMatch(devApi, /return `⚠ 连接正常/)
})

test('同步状态只接受回读验证成功的记录', () => {
  assert.match(page, /record\.verified\s*===\s*true/, '旧的未验证同步记录不得显示为已同步')
  assert.match(page, /providerKey:\s*result\.providerKey,\s*verified:\s*result\.verified/)
  assert.match(page, /providerId:\s*result\.providerId,\s*verified:\s*result\.verified/)
  assert.match(page, /model:\s*result\.model,\s*verified:\s*result\.verified/)
})
