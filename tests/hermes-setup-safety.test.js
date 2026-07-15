import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Hermes setup phase resolver restores a valid later phase without bypassing prerequisites', async () => {
  const { resolveHermesSetupPhase } = await import('../src/engines/hermes/pages/setup.js')

  assert.equal(resolveHermesSetupPhase('install', 'gateway', false), 'install')
  assert.equal(resolveHermesSetupPhase('configure', 'gateway', true), 'gateway')
  assert.equal(resolveHermesSetupPhase('install', 'configure', true), 'configure')
  assert.equal(resolveHermesSetupPhase('gateway', 'complete', true), 'gateway')
})

test('Hermes setup claims the install single-flight guard before its first await', () => {
  const source = fs.readFileSync(path.join(root, 'src/engines/hermes/pages/setup.js'), 'utf8')
  const body = source.match(/async function doInstall\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ --- 获取模型列表 ---/)?.[1]
  assert.ok(body, 'doInstall body must be present')
  const guard = body.indexOf('if (installing) return')
  const claim = body.indexOf('installing = true')
  const firstAwait = body.indexOf('await ')
  assert.ok(guard >= 0 && claim > guard && claim < firstAwait, 'guard and claim must precede the first await')
})

test('Custom Hermes Gateway is probed before it is persisted', async () => {
  const { probeAndCommitHermesGateway } = await import('../src/engines/hermes/pages/setup.js')
  const calls = []
  const fakeApi = {
    async hermesProbeGateway(url) { calls.push(['probe', url]); return { ok: true } },
    async hermesSetGatewayUrl(url) { calls.push(['save', url]) },
  }
  await probeAndCommitHermesGateway(fakeApi, 'http://gateway.example:8642')
  assert.deepEqual(calls, [
    ['probe', 'http://gateway.example:8642'],
    ['save', 'http://gateway.example:8642'],
  ])

  await assert.rejects(
    probeAndCommitHermesGateway({
      async hermesProbeGateway() { return { ok: false } },
      async hermesSetGatewayUrl() { throw new Error('must not save') },
    }, 'http://bad.example:8642'),
  )
})

test('Web Hermes install environment includes configured PyPI mirror', async () => {
  const { buildHermesInstallEnv } = await import('../scripts/dev-api.js')
  const env = buildHermesInstallEnv({ pypiMirror: 'https://mirror.example/simple', gitMirror: '' }, { PATH: 'base' })
  assert.equal(env.UV_DEFAULT_INDEX, 'https://mirror.example/simple')
  assert.equal(env.PIP_INDEX_URL, 'https://mirror.example/simple')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('Web install_hermes does not block the server event loop with spawnSync', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const body = source.match(/async install_hermes\([^]*?\n  \},\n\n  async configure_hermes/)?.[0]
  assert.ok(body, 'install_hermes handler must be present')
  assert.doesNotMatch(body, /spawnSync\s*\(/)
  assert.match(body, /await runHermesInstallWithCacheRecovery\s*\(/)
})

test('Hermes rejects uv releases older than the archive collision fix', async () => {
  const { isHermesUvVersionSupported } = await import('../scripts/dev-api.js')

  assert.equal(isHermesUvVersionSupported('uv 0.11.14 (3fdfdc7d4 2026-05-12 x86_64-pc-windows-msvc)'), false)
  assert.equal(isHermesUvVersionSupported('uv 0.11.24 (5e04460 2026-06-23 x86_64-pc-windows-msvc)'), true)
  assert.equal(isHermesUvVersionSupported('uv 0.11.28 (ebf0f43 2026-07-07 x86_64-pc-windows-msvc)'), true)
})

test('Web Hermes install isolates the cache for unsafe uv and retries cache metadata failures', async () => {
  const { runHermesInstallWithCacheRecovery } = await import('../scripts/dev-api.js')
  const oldUvCalls = []
  const oldUvResult = await runHermesInstallWithCacheRecovery(
    async (_program, args) => {
      oldUvCalls.push(args)
      return { status: 0, stdout: 'ok', stderr: '' }
    },
    'uv',
    ['tool', 'install', 'hermes-agent'],
    {},
    'uv 0.11.14',
  )
  assert.equal(oldUvResult.status, 0)
  assert.equal(oldUvCalls.length, 1)
  assert.ok(oldUvCalls[0].includes('--no-cache'))

  const retryCalls = []
  const retryResult = await runHermesInstallWithCacheRecovery(
    async (_program, args) => {
      retryCalls.push(args)
      if (retryCalls.length === 1) {
        return {
          status: 2,
          stdout: '',
          stderr: 'The wheel is invalid: Metadata field Name not found',
        }
      }
      return { status: 0, stdout: 'ok', stderr: '' }
    },
    'uv',
    ['tool', 'install', 'hermes-agent'],
    {},
    'uv 0.11.28',
  )
  assert.equal(retryResult.status, 0)
  assert.equal(retryCalls.length, 2)
  assert.equal(retryCalls[0].includes('--no-cache'), false)
  assert.ok(retryCalls[1].includes('--no-cache'))
})

test('Tauri Hermes installer pins a uv release with the archive collision fix', () => {
  const source = fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8')

  assert.match(source, /const HERMES_UV_VERSION: &str = "0\.11\.28"/)
  assert.match(source, /const HERMES_MIN_UV_VERSION: &str = "0\.11\.24"/)
  assert.match(source, /is_uv_wheel_cache_error/)
  assert.match(source, /"--no-cache"/)
})

test('Hermes runtime environment pins the same home used by ClawPanel', async () => {
  const { buildHermesRuntimeEnv } = await import('../scripts/dev-api.js')

  assert.equal(typeof buildHermesRuntimeEnv, 'function')
  const env = buildHermesRuntimeEnv({ PATH: 'old' }, 'C:\\Users\\tester\\.hermes', 'managed-path')
  assert.equal(env.PATH, 'managed-path')
  assert.equal(env.HERMES_HOME, 'C:\\Users\\tester\\.hermes')
})

test('Hermes API Server runtime env creates a strong key without dropping provider settings', async () => {
  const { ensureHermesApiServerRuntimeEnvAt } = await import('../scripts/dev-api.js')
  const home = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'clawpanel-hermes-env-'))
  fs.writeFileSync(path.join(home, '.env'), 'CUSTOM_API_KEY=provider-secret\nOPENAI_BASE_URL=https://example.test/v1\n')

  const result = ensureHermesApiServerRuntimeEnvAt(home, () => 'a'.repeat(64))
  const saved = fs.readFileSync(path.join(home, '.env'), 'utf8')

  assert.equal(result.changed, true)
  assert.equal(result.apiServerKey, 'a'.repeat(64))
  assert.match(saved, /^API_SERVER_ENABLED=true$/m)
  assert.match(saved, new RegExp(`^API_SERVER_KEY=${'a'.repeat(64)}$`, 'm'))
  assert.match(saved, /^CUSTOM_API_KEY=provider-secret$/m)
  assert.match(saved, /^OPENAI_BASE_URL=https:\/\/example\.test\/v1$/m)

  const second = ensureHermesApiServerRuntimeEnvAt(home, () => 'b'.repeat(64))
  assert.equal(second.changed, false)
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), saved)
})

test('Hermes API Server runtime env preserves a usable existing key and replaces the legacy weak key', async () => {
  const { ensureHermesApiServerRuntimeEnvAt } = await import('../scripts/dev-api.js')
  const strongHome = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'clawpanel-hermes-strong-'))
  const existing = 'existing-strong-key-1234567890'
  fs.writeFileSync(path.join(strongHome, '.env'), `API_SERVER_KEY=${existing}\n`)
  const preserved = ensureHermesApiServerRuntimeEnvAt(strongHome, () => 'b'.repeat(64))
  assert.equal(preserved.apiServerKey, existing)

  const weakHome = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'clawpanel-hermes-weak-'))
  fs.writeFileSync(path.join(weakHome, '.env'), 'API_SERVER_KEY=clawpanel-local\n')
  const replaced = ensureHermesApiServerRuntimeEnvAt(weakHome, () => 'c'.repeat(64))
  assert.equal(replaced.apiServerKey, 'c'.repeat(64))
  assert.doesNotMatch(fs.readFileSync(path.join(weakHome, '.env'), 'utf8'), /clawpanel-local/)
})

test('Tauri Hermes runtime pins HERMES_HOME and repairs API Server auth before start', () => {
  const source = fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8')

  assert.match(source, /cmd\.env\("HERMES_HOME", hermes_home\(\)\);/)
  assert.match(source, /ensure_hermes_api_server_runtime_env\(\)\?/)
  assert.doesNotMatch(source, /\("API_SERVER_KEY"\.into\(\), "clawpanel-local"\.into\(\)\)/)
})

test('Hermes 0.18.2 migrates a legacy bare custom endpoint to a named provider route', async () => {
  const { repairHermesCustomProviderRoutingAt } = await import('../scripts/dev-api.js')
  const YAML = await import('yaml')
  const home = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'clawpanel-hermes-route-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), `model:\n  default: gpt-5.5\n  provider: custom\n  context_length: 131072\nhooks:\n  enabled: true\n`)
  fs.writeFileSync(path.join(home, '.env'), `OPENAI_BASE_URL=https://example.test/v1\nCUSTOM_API_KEY=provider-secret\n`)

  const result = repairHermesCustomProviderRoutingAt(home)
  const saved = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'))

  assert.equal(result.changed, true)
  assert.equal(saved.model.provider, 'custom:clawpanel')
  assert.equal(saved.model.base_url, 'https://example.test/v1')
  assert.equal(saved.model.context_length, 131072)
  assert.equal(saved.providers.clawpanel.base_url, 'https://example.test/v1')
  assert.equal(saved.providers.clawpanel.key_env, 'CUSTOM_API_KEY')
  assert.equal(saved.providers.clawpanel.default_model, 'gpt-5.5')
  assert.equal(saved.providers.clawpanel.api_mode, 'chat_completions')
  assert.deepEqual(saved.hooks, { enabled: true })

  const second = repairHermesCustomProviderRoutingAt(home)
  assert.equal(second.changed, false)
})

test('Hermes 0.18.2 keeps a normal OpenRouter route even when legacy custom env remains', async () => {
  const { repairHermesCustomProviderRoutingAt } = await import('../scripts/dev-api.js')
  const home = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'clawpanel-hermes-openrouter-'))
  const config = `model:\n  default: openai/gpt-5.5\n  provider: openrouter\n`
  fs.writeFileSync(path.join(home, 'config.yaml'), config)
  fs.writeFileSync(path.join(home, '.env'), `OPENAI_BASE_URL=https://legacy.example.test/v1\nOPENROUTER_API_KEY=openrouter-secret\n`)

  const result = repairHermesCustomProviderRoutingAt(home)

  assert.equal(result.changed, false)
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), config)
  assert.equal(fs.existsSync(path.join(home, 'config.yaml.bak')), false)
})
