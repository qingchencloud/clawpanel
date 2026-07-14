import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const policy = JSON.parse(readFileSync(new URL('../openclaw-version-policy.json', import.meta.url), 'utf8'))
const featureCatalog = readFileSync(new URL('../src/lib/feature-catalog.js', import.meta.url), 'utf8')
const linuxDeploy = readFileSync(new URL('../scripts/linux-deploy.sh', import.meta.url), 'utf8')
const webBackend = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const desktopDevice = readFileSync(new URL('../src-tauri/src/commands/device.rs', import.meta.url), 'utf8')

test('ClawPanel recommends the matching official and Chinese 2026.7.1 stable builds', () => {
  assert.equal(policy.default.official.recommended, '2026.7.1')
  assert.equal(policy.default.chinese.recommended, '2026.7.1-zh.2')
  assert.match(featureCatalog, /official: '2026\.7\.1'/)
  assert.match(featureCatalog, /chinese: '2026\.7\.1-zh\.2'/)
})

test('Linux deployment installs the Chinese 2026.7.1 stable build', () => {
  assert.match(linuxDeploy, /OPENCLAW_RECOMMENDED_VERSION="2026\.7\.1-zh\.2"/)
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
  assert.match(webBackend, /minProtocol: 3, maxProtocol: 4/)
  assert.match(desktopDevice, /"minProtocol": 3/)
  assert.match(desktopDevice, /"maxProtocol": 4/)
})
