import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  addAgentConfig,
  ensureAgentRoster,
  ensureMutableAgentConfig,
  listAgentConfigs,
  removeAgentConfig,
  supportsAgentEntries,
} from '../src/lib/openclaw-agent-roster.js'
import { syncExplicitModelPolicyAllow } from '../src/lib/openclaw-model-policy.js'
import {
  OPENCLAW_PROTOCOL_RANGE,
  buildDeviceAuthPayloadV3,
  isDeviceAuthDetailCode,
  isProtocolIncompatDetailCode,
  isProtocolIncompatReason,
  resolveConnectSignedAt,
} from '../src/lib/openclaw-gateway-compat.js'
import {
  buildOpenClawConnectFrame,
  stripRetiredOpenclawFields,
  stripUiFields,
} from '../scripts/dev-api.js'

const webBackend = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const desktopAgents = readFileSync(new URL('../src-tauri/src/commands/agent.rs', import.meta.url), 'utf8')
const desktopConfig = readFileSync(new URL('../src-tauri/src/commands/config.rs', import.meta.url), 'utf8')
const featureCatalog = readFileSync(new URL('../src/lib/feature-catalog.js', import.meta.url), 'utf8')
const wsClient = readFileSync(new URL('../src/lib/ws-client.js', import.meta.url), 'utf8')
const tauriApi = readFileSync(new URL('../src/lib/tauri-api.js', import.meta.url), 'utf8')
const setupPage = readFileSync(new URL('../src/pages/setup.js', import.meta.url), 'utf8')
const servicesPage = readFileSync(new URL('../src/pages/services.js', import.meta.url), 'utf8')
const chatDebugPage = readFileSync(new URL('../src/pages/chat-debug.js', import.meta.url), 'utf8')
const linuxDeploy = readFileSync(new URL('../scripts/linux-deploy.sh', import.meta.url), 'utf8')
const desktopDevice = readFileSync(new URL('../src-tauri/src/commands/device.rs', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')

test('OpenClaw 2026.8.1 使用 keyed agents.entries，7.1 仍保留 agents.list', () => {
  assert.equal(supportsAgentEntries('2026.8.1'), true)
  assert.equal(supportsAgentEntries('2026.8.1-zh.1'), true)
  assert.equal(supportsAgentEntries('2026.7.1-2-zh.1'), false)

  const official = { agents: { defaults: {} } }
  assert.equal(ensureAgentRoster(official, '2026.8.1'), 'entries')
  assert.deepEqual(official.agents.entries, { main: {} })
  assert.equal(official.agents.list, undefined)

  const chinese = { agents: { defaults: {} } }
  assert.equal(ensureAgentRoster(chinese, '2026.7.1-2-zh.1'), 'list')
  assert.deepEqual(chinese.agents.list, [])
  assert.equal(chinese.agents.entries, undefined)
})

test('8.1 Agent 增删改保持 canonical keyed 形状、ownership 并清理失效引用', () => {
  const config = {
    agents: {
      entries: { main: { name: 'Main' } },
      defaults: {
        heartbeat: { agentId: 'worker', every: '30m' },
        systemAgent: { agentId: 'WORKER' },
      },
    },
    bindings: [
      { agentId: 'worker', match: { channel: 'telegram' } },
      { agentId: 'main', match: { channel: 'discord' } },
    ],
  }
  addAgentConfig(config, 'Worker', { id: 'forbidden-inline-id', workspace: '/tmp/worker' })

  assert.deepEqual(listAgentConfigs(config).map(agent => agent.id), ['main', 'worker'])
  assert.equal(config.agents.ownership, 'explicit')
  assert.equal(config.agents.entries.worker.id, undefined)
  assert.equal(config.agents.entries.worker.workspace, '/tmp/worker')

  const worker = ensureMutableAgentConfig(config, 'worker')
  worker.model = { primary: 'openai/gpt-5.5' }
  assert.deepEqual(config.agents.entries.worker.model, { primary: 'openai/gpt-5.5' })

  assert.equal(removeAgentConfig(config, 'worker'), true)
  assert.equal(config.agents.ownership, 'explicit')
  assert.deepEqual(config.agents.entries, { main: { name: 'Main' } })
  assert.deepEqual(config.agents.defaults.heartbeat, { every: '30m' })
  assert.equal(config.agents.defaults.systemAgent, undefined)
  assert.deepEqual(config.bindings, [{ agentId: 'main', match: { channel: 'discord' } }])
})

test('旧版 Agent 写入继续保留 list，避免破坏尚未升级的汉化内核', () => {
  const config = { agents: { list: [{ id: 'main' }] } }
  addAgentConfig(config, 'worker', { workspace: '/tmp/worker' }, { installedVersion: '2026.8.1' })
  assert.deepEqual(config.agents.list.map(agent => agent.id), ['main', 'worker'])
  assert.equal(config.agents.entries, undefined)
})

test('配置清理覆盖 entries 且移除 8.1 禁止的内嵌 id', () => {
  const config = {
    agents: {
      entries: {
        main: { id: 'main', current: 'ui-only', name: 'keep' },
      },
    },
  }
  stripUiFields(config)
  assert.deepEqual(config.agents.entries.main, { name: 'keep' })
})

test('8.1 写入会移除退役字段，7.1 配置保持原样', () => {
  const legacy = {
    commands: { ownerDisplay: 'raw', ownerDisplaySecret: 'keep-on-7-1' },
    gateway: { controlUi: { allowInsecureAuth: true } },
  }
  const official = structuredClone(legacy)
  stripRetiredOpenclawFields(official, '2026.8.1')
  assert.deepEqual(official, { commands: {}, gateway: { controlUi: {} } })

  const chinese = structuredClone(legacy)
  stripRetiredOpenclawFields(chinese, '2026.7.1-2-zh.1')
  assert.deepEqual(chinese, legacy)
})

test('8.1 显式模型策略随面板候选模型同步，allow-any 配置不被收紧', () => {
  const restricted = {
    models: { 'openai/gpt-5.5': {}, 'lmstudio/qwen': {} },
    modelPolicy: { allow: ['stale/model'] },
  }
  assert.equal(syncExplicitModelPolicyAllow(restricted), true)
  assert.deepEqual(restricted.modelPolicy.allow, ['openai/gpt-5.5', 'lmstudio/qwen'])

  const allowAny = { models: { 'openai/gpt-5.5': {} }, modelPolicy: {} }
  assert.equal(syncExplicitModelPolicyAllow(allowAny), false)
  assert.equal(allowAny.modelPolicy.allow, undefined)
})

test('Web 与桌面后端均声明 8.1 注册表和 doctor 迁移支持', () => {
  assert.match(webBackend, /listAgentConfigs\(cfg\)/)
  assert.match(webBackend, /runOpenclawCaptured\(args\)/)
  assert.match(webBackend, /'doctor', '--fix', '--non-interactive', '--yes'/)
  assert.match(desktopAgents, /fn\s+uses_agent_entries\s*\(/)
  assert.match(desktopAgents, /get\("entries"\)/)
  assert.match(desktopConfig, /OPENCLAW_AGENT_ENTRIES_VERSION_FLOOR:\s*&str\s*=\s*"2026\.8\.1"/)
  assert.match(featureCatalog, /'agents\.keyedEntries'/)
  assert.match(featureCatalog, /'models\.explicitPolicy'/)
  assert.match(featureCatalog, /'doctor\.startupConfigRepair'/)
})

test('8.1 握手复用 challenge.ts，7.1 challenge 缺少 ts 时仍回退本机时间', () => {
  assert.equal(resolveConnectSignedAt(1_800_000_000_123, 99), 1_800_000_000_123)
  assert.equal(resolveConnectSignedAt(undefined, 1_700_000_000_456), 1_700_000_000_456)
  assert.deepEqual(OPENCLAW_PROTOCOL_RANGE, { min: 3, max: 4 })

  assert.match(wsClient, /const challengeTs = msg\.payload\?\.ts/)
  assert.match(wsClient, /this\._sendConnectFrame\(nonce, challengeTs\)/)
  assert.match(chatDebugPage, /msg\.payload\?\.ts/)
  assert.match(chatDebugPage, /password,/)
  assert.match(tauriApi, /challengeTs/)
  assert.match(webBackend, /resolveConnectSignedAt\(challengeTs\)/)
  assert.match(desktopDevice, /challenge_ts: Option<u64>/)
})

test('token 与 password 认证使用相同的 7.1/8.1 设备签名契约', () => {
  const common = {
    deviceId: 'DEVICE', clientId: 'openclaw-control-ui', clientMode: 'ui',
    role: 'operator', scopes: ['operator.admin'], signedAt: 123,
    nonce: 'NONCE', platform: 'Windows', deviceFamily: 'Desktop',
  }
  assert.equal(
    buildDeviceAuthPayloadV3({ ...common, signatureToken: 'TOKEN' }),
    'v3|DEVICE|openclaw-control-ui|ui|operator|operator.admin|123|TOKEN|NONCE|windows|desktop',
  )
  assert.equal(
    buildDeviceAuthPayloadV3({ ...common, signatureToken: '' }),
    'v3|DEVICE|openclaw-control-ui|ui|operator|operator.admin|123||NONCE|windows|desktop',
  )
  assert.match(webBackend, /gatewayPassword \? \{ password: gatewayPassword \} : \{\}/)
  assert.match(desktopDevice, /let signature_token = gateway_token\.as_str\(\)/)
})

test('Web connect frame 的 Ed25519 签名使用 challenge.ts 且能按 8.1 契约验签', () => {
  const pair = crypto.generateKeyPairSync('ed25519')
  const publicRaw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const keyData = {
    deviceId: crypto.createHash('sha256').update(publicRaw).digest('hex'),
    publicKey: Buffer.from(publicRaw).toString('base64url'),
    privateKey: pair.privateKey,
  }
  const frame = buildOpenClawConnectFrame({
    nonce: 'challenge-nonce',
    challengeTs: 1_800_000_000_123,
    gatewayToken: 'gateway-token',
    keyData,
    platform: 'Windows',
  })
  const payload = buildDeviceAuthPayloadV3({
    deviceId: keyData.deviceId,
    clientId: 'openclaw-control-ui',
    clientMode: 'ui',
    role: 'operator',
    scopes: frame.params.scopes,
    signedAt: frame.params.device.signedAt,
    signatureToken: 'gateway-token',
    nonce: 'challenge-nonce',
    platform: 'Windows',
    deviceFamily: 'desktop',
  })
  assert.equal(frame.params.device.signedAt, 1_800_000_000_123)
  assert.deepEqual(frame.params.auth, { token: 'gateway-token' })
  assert.equal(
    crypto.verify(null, Buffer.from(payload), pair.publicKey, Buffer.from(frame.params.device.signature, 'base64url')),
    true,
  )
})

test('设备签名失败不再误判为内核过旧', () => {
  assert.equal(isProtocolIncompatReason('device signature invalid'), false)
  assert.equal(isProtocolIncompatReason('protocol mismatch'), true)
  assert.equal(isDeviceAuthDetailCode('DEVICE_AUTH_SIGNATURE_INVALID'), true)
  assert.equal(isProtocolIncompatDetailCode('DEVICE_AUTH_SIGNATURE_INVALID'), false)
  assert.equal(isProtocolIncompatDetailCode('PROTOCOL_MISMATCH'), true)
  assert.match(wsClient, /kernel\.deviceAuthFailed/)
})

test('新安装和未知来源默认官方稳定版，同时保留汉化版切换入口', () => {
  assert.match(setupPage, /value="official" checked/)
  assert.match(setupPage, /value="chinese"/)
  assert.doesNotMatch(setupPage, /value="chinese" checked/)
  assert.match(tauriApi, /listOpenclawVersions: \(source = 'official'\)/)
  assert.match(tauriApi, /upgradeOpenclaw: \(source = 'official'/)
  assert.match(webBackend, /upgrade_openclaw\(\{ source = 'official'/)
  assert.match(servicesPage, /let detectedSource = 'official'/)
  assert.match(linuxDeploy, /OPENCLAW_SOURCE="\$\{OPENCLAW_SOURCE:-official\}"/)
  assert.match(linuxDeploy, /OPENCLAW_OFFICIAL_RECOMMENDED_VERSION="2026\.8\.2"/)
  assert.match(linuxDeploy, /OPENCLAW_CHINESE_RECOMMENDED_VERSION="2026\.7\.1-2-zh\.1"/)
  assert.match(dockerfile, /ARG OPENCLAW_PACKAGE=openclaw/)
  assert.match(dockerfile, /ARG OPENCLAW_VERSION=2026\.8\.2/)
})
