import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { supportsAgentEntries } from '../src/lib/openclaw-agent-roster.js'
import { OPENCLAW_PROTOCOL_RANGE } from '../src/lib/openclaw-gateway-compat.js'

const policy = JSON.parse(readFileSync(new URL('../openclaw-version-policy.json', import.meta.url), 'utf8'))
const featureCatalog = readFileSync(new URL('../src/lib/feature-catalog.js', import.meta.url), 'utf8')
const linuxDeploy = readFileSync(new URL('../scripts/linux-deploy.sh', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const dockerCompose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../src/pages/dashboard.js', import.meta.url), 'utf8')
const webBackend = readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')

test('OpenClaw 2026.8.2 is the official stable baseline across install paths', () => {
  assert.equal(policy.default.official.recommended, '2026.8.2')
  assert.match(featureCatalog, /official: '2026\.8\.2'/)
  assert.match(linuxDeploy, /OPENCLAW_OFFICIAL_RECOMMENDED_VERSION="2026\.8\.2"/)
  assert.match(dockerfile, /ARG OPENCLAW_PACKAGE=openclaw/)
  assert.match(dockerfile, /ARG OPENCLAW_VERSION=2026\.8\.2/)
  assert.match(dockerCompose, /openclaw@2026\.8\.2/)
})

test('OpenClaw 2026.8.2 keeps the 8.1 agent shape and protocol-4 handshake contract', () => {
  assert.equal(supportsAgentEntries('2026.8.2'), true)
  assert.deepEqual(OPENCLAW_PROTOCOL_RANGE, { min: 3, max: 4 })
  assert.match(featureCatalog, /minVersion: '2026\.8\.1'/)
})

test('dashboard refreshes the WebSocket badge when the delayed handshake completes', () => {
  assert.match(dashboard, /wsClient\.onStatusChange\(\(\) => refreshDashboardWsStatus\(page\)\)/)
  assert.match(dashboard, /data-dashboard-ws-status/)
  assert.match(dashboard, /current\.outerHTML = renderWsStatus\(\)/)
  assert.match(dashboard, /if \(_unsubWsStatus\) \{ _unsubWsStatus\(\); _unsubWsStatus = null \}/)
})

test('Web mode recognizes the official Windows global npm shim before unrelated installs', () => {
  assert.match(webBackend, /if \(lower\.includes\('node_modules'\)\) return 'npm-official'/)
  assert.match(webBackend, /const activeCliSource = classifyCliSource\(activeCliPath\)/)
  assert.match(webBackend, /if \(activeSource !== 'unknown'\) return activeSource/)
})
