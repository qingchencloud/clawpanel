import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const policy = JSON.parse(readFileSync(new URL('../openclaw-version-policy.json', import.meta.url), 'utf8'))
const featureCatalog = readFileSync(new URL('../src/lib/feature-catalog.js', import.meta.url), 'utf8')
const linuxDeploy = readFileSync(new URL('../scripts/linux-deploy.sh', import.meta.url), 'utf8')
const webBackend = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const desktopDevice = readFileSync(new URL('../src-tauri/src/commands/device.rs', import.meta.url), 'utf8')
const desktopConfig = readFileSync(new URL('../src-tauri/src/commands/config.rs', import.meta.url), 'utf8')
const desktopService = readFileSync(new URL('../src-tauri/src/commands/service.rs', import.meta.url), 'utf8')
const chatPage = readFileSync(new URL('../src/pages/chat.js', import.meta.url), 'utf8')

test('ClawPanel recommends official 2026.8.2 while Chinese stays on its latest published correction', () => {
  assert.equal(policy.default.official.recommended, '2026.8.2')
  assert.equal(policy.default.chinese.recommended, '2026.7.1-2-zh.1')
  assert.match(featureCatalog, /official: '2026\.8\.2'/)
  assert.match(featureCatalog, /chinese: '2026\.7\.1-2-zh\.1'/)
})

test('Linux deployment keeps the Chinese 2026.7.1 correction as an explicit option', () => {
  assert.match(linuxDeploy, /OPENCLAW_SOURCE="\$\{OPENCLAW_SOURCE:-official\}"/)
  assert.match(linuxDeploy, /OPENCLAW_CHINESE_RECOMMENDED_VERSION="2026\.7\.1-2-zh\.1"/)
  assert.match(linuxDeploy, /OPENCLAW_SOURCE" = "chinese"/)
  assert.match(linuxDeploy, /@qingchencloud\/openclaw-zh@\$\{OPENCLAW_RECOMMENDED_VERSION\}/)
  assert.match(linuxDeploy, /\[ "\$major" -ge 25 \]/)
  assert.match(
    linuxDeploy,
    /OPENCLAW_7_1_NODE_REQUIREMENT=">=22\.22\.3 <23 \|\| >=24\.15\.0 <25 \|\| >=25\.9\.0"/,
  )

  const installStart = linuxDeploy.indexOf('install_openclaw() {')
  const npmInstall = linuxDeploy.indexOf('npm install -g "$openclaw_spec"', installStart)
  const runtimeGuard = linuxDeploy.indexOf('ensure_node_for_openclaw_version "$OPENCLAW_RECOMMENDED_VERSION"', installStart)
  assert.ok(installStart >= 0 && runtimeGuard > installStart, 'OpenClaw install must preflight its target runtime')
  assert.ok(npmInstall > runtimeGuard, 'Node runtime preflight must happen before npm installs OpenClaw')
})

test('Gateway connect frames retain a range that overlaps OpenClaw 2026.7.1 protocol v4', () => {
  assert.match(webBackend, /minProtocol: OPENCLAW_PROTOCOL_RANGE\.min/)
  assert.match(webBackend, /maxProtocol: OPENCLAW_PROTOCOL_RANGE\.max/)
  assert.match(desktopDevice, /const MIN_GATEWAY_PROTOCOL: u8 = 3/)
  assert.match(desktopDevice, /const MAX_GATEWAY_PROTOCOL: u8 = 4/)
})

test('OpenClaw 2026.7.1 config reload uses the kernel watcher without probing panel ports', () => {
  assert.match(desktopConfig, /fn\s+supports_native_config_reload\s*\(/)
  assert.match(desktopConfig, /OPENCLAW_NATIVE_CONFIG_RELOAD_VERSION_FLOOR:\s*&str\s*=\s*"2026\.7\.1"/)
  assert.doesNotMatch(desktopConfig, /control_ports\s*=\s*\[gw_port\s*\+\s*2,\s*18792\]/)
  assert.doesNotMatch(desktopConfig, /__api\/reload/)
  assert.match(
    desktopConfig,
    /pub\s+async\s+fn\s+reload_gateway[\s\S]*?reload_gateway_internal\(Some\(&app\)\)\.await/,
  )
  assert.match(
    desktopConfig,
    /pub\s+async\s+fn\s+restart_gateway[\s\S]*?restart_gateway_guarded\(Some\(&app\)\)\.await/,
  )
  assert.match(webBackend, /supportsNativeConfigReload\s*\(/)
})

test('Windows Gateway terminal closes after its managed process exits', () => {
  assert.match(
    desktopService,
    /"cmd",\s*"\/D",\s*"\/C",\s*runner_path_str\.as_str\(\)/,
  )
  assert.doesNotMatch(
    desktopService,
    /"cmd",\s*"\/D",\s*"\/K",\s*runner_path_str\.as_str\(\)/,
  )
  assert.doesNotMatch(desktopService, /pause \^>nul/)
})

test('Chat can abort a run while waiting for the first response event', () => {
  assert.match(chatPage, /let\s+_isAwaitingResponse\s*=\s*false/)
  assert.match(chatPage, /if\s*\(_isStreaming\s*\|\|\s*_isAwaitingResponse\)\s*stopGeneration\(\)/)
  assert.match(chatPage, /wsClient\.chatAbort\(_sessionKey,\s*_currentRunId\s*\|\|\s*undefined\)/)
})
