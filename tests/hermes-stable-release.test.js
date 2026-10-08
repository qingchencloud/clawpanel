import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_VERSION = '0.21.5'
const EXPECTED_TAG = 'v2026.9.24'
const EXPECTED_COMMIT = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('Web and Tauri installers pin the supported Hermes stable release and immutable installer', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, new RegExp(`HERMES_STABLE_VERSION = '${EXPECTED_VERSION}'`))
  assert.match(webSource, new RegExp(`HERMES_STABLE_TAG = '${EXPECTED_TAG.replaceAll('.', '\\.')}'`))
  assert.match(webSource, new RegExp(`HERMES_STABLE_COMMIT = '${EXPECTED_COMMIT}'`))
  assert.match(webSource, /raw\.githubusercontent\.com\/NousResearch\/hermes-agent\/\$\{HERMES_STABLE_COMMIT\}\/scripts/)
  assert.match(webSource, /0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2/)
  assert.match(webSource, /2017ddf0cc7bc6cfb70d40dc9fba1d916f47dbcccf5fe73bdee2cf93a11262af/)

  assert.match(tauriSource, new RegExp(`HERMES_STABLE_VERSION: &str = "${EXPECTED_VERSION}"`))
  assert.match(tauriSource, new RegExp(`HERMES_STABLE_TAG: &str = "${EXPECTED_TAG.replaceAll('.', '\\.')}"`))
  assert.match(tauriSource, new RegExp(`HERMES_STABLE_COMMIT: &str = "${EXPECTED_COMMIT}"`))
  assert.match(tauriSource, new RegExp(`raw\\.githubusercontent\\.com/NousResearch/hermes-agent/${EXPECTED_COMMIT}/scripts`))
  assert.match(readSource('src/lib/feature-catalog.js'), /hermes:\s*\{\s*default: '0\.21\.5'/)
})

test('Web install and update paths share the supported source installer', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const installBody = webSource.match(/async install_hermes\([^]*?\n  \},\n\n  async configure_hermes/)?.[0]
  const updateBody = webSource.match(/async update_hermes\([^]*?\n  \},\n\n  async uninstall_hermes/)?.[0]
  const tauriInstallBody = tauriSource.match(/pub async fn install_hermes\([^]*?\n}\n\n/)?.[0]
  const tauriUpdateBody = tauriSource.match(/pub async fn update_hermes\([^]*?\n}\n\n/)?.[0]

  assert.ok(installBody, 'install_hermes handler must be present')
  assert.ok(updateBody, 'update_hermes handler must be present')
  assert.match(installBody, /await installHermesManagedSource\(readPanelConfig\(\)\)/)
  assert.match(updateBody, /await installHermesManagedSource\(readPanelConfig\(\)\)/)
  assert.match(tauriInstallBody, /install_hermes_managed_source\(&app\)\.await\?/)
  assert.match(tauriUpdateBody, /install_hermes_managed_source\(&app\)\.await\?/)
  assert.doesNotMatch(installBody, /uv tool install|uv pip install/)
  assert.doesNotMatch(updateBody, /uv tool install|uv pip install/)
})

test('Hermes version detection supports the 0.20.5 --version-only CLI', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, /function runHermesVersionSilent\(\)[^]*?\['version'\][^]*?\['--version'\]/)
  assert.match(tauriSource, /fn hermes_version_at_path\(path: &str\)[^]*?&\["version"\][^]*?&\["--version"\]/)
  assert.match(webSource, /const ver = runHermesVersionSilent\(\)/)
  assert.match(tauriSource, /match hermes_version_at_path\(&enhanced\)/)
})

test('source installer uses upstream stage protocol without mutating user PATH', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, /stages: \['uv', 'git', 'node', 'repository', 'python', 'venv', 'dependencies', 'node-deps', 'config-templates', 'platform-sdks', 'bootstrap-marker'\]/)
  assert.match(webSource, /stages: \['repository', 'venv', 'python-deps', 'node-deps', 'config', 'complete'\]/)
  assert.match(webSource, /'-Commit', HERMES_STABLE_COMMIT, '-ForceCommit'/)
  assert.match(webSource, /'--commit', HERMES_STABLE_COMMIT, '--force-commit'/)
  assert.match(tauriSource, /"config-templates",\s*"platform-sdks",\s*"bootstrap-marker"/)
  assert.match(tauriSource, /\[\s*"repository",\s*"venv",\s*"python-deps",\s*"node-deps",\s*"config",\s*"complete",?\s*\]/)
  assert.match(tauriSource, /"repository",\s*"python",\s*"venv",\s*"dependencies",\s*"node-deps"/)
  assert.match(tauriSource, /\.arg\(HERMES_STABLE_COMMIT\)[^]*?\.arg\("-ForceCommit"\)/)
  assert.match(tauriSource, /\.arg\(HERMES_STABLE_COMMIT\)[^]*?\.arg\("--force-commit"\)/)
})

test('source venv is preferred and uninstall only removes ClawPanel-managed artifacts', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const webPathBody = webSource.match(/function hermesEnhancedPath\([^]*?\n}\n\nexport function buildHermesRuntimeEnv/)?.[0]
  const webUninstallBody = webSource.match(/async uninstall_hermes\([^]*?\n  \},\n\n  \/\/ =+/)?.[0]
  const tauriUninstallBody = tauriSource.match(/pub async fn uninstall_hermes\([^]*?\n}\n\n\/\//)?.[0]

  assert.match(webPathBody, /\[hermesSourceVenvBinDir\(\), path\.join\(hermesHome\(\), 'bin'\), uvBinDir\(\)\]/)
  assert.match(tauriSource, /extra\.push\([\s\S]*?hermes_source_venv_bin_dir\(\)/)
  assert.match(webUninstallBody, /uninstallHermesManagedSourceAt\(home, cleanConfig\)/)
  assert.match(webUninstallBody, /uv[^]*?tool[^]*?uninstall[^]*?hermes-agent/)
  assert.match(webSource, /export async function uninstallHermesManagedSourceAt/)
  assert.match(webSource, /path\.join\(home, 'bin', isWindows \? 'uv\.exe' : 'uv'\)/)
  assert.match(webSource, /path\.join\(home, '\.clawpanel-cache'\)/)
  assert.match(tauriUninstallBody, /kill_gateway_pid\(\)/)
  assert.match(tauriUninstallBody, /kill_dashboard_pid\(\)/)
  assert.match(tauriUninstallBody, /hermes_home\(\)\.join\("\.clawpanel-cache"\)/)
  assert.doesNotMatch(tauriUninstallBody, /\["uninstall", "--yes"\]/)
})

test('Hermes model sync preserves nested model keys from the 0.20.5 config template', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-hermes-model-sync-'))
  try {
    const { syncHermesProviderFilesAt, repairHermesCustomProviderRoutingAt } = await import('../scripts/dev-api.js')
    const YAML = await import('yaml')
    fs.writeFileSync(path.join(tempHome, 'config.yaml'), [
      'model:',
      '  default: old-model',
      '  provider: auto',
      'stt:',
      '  local:',
      '    model: whisper-large-v3',
      '    device: cpu',
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(tempHome, '.env'), '')

    syncHermesProviderFilesAt(tempHome, {
      provider: 'custom',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:19999/v1',
      model: 'smoke-model',
      setDefault: true,
    })
    repairHermesCustomProviderRoutingAt(tempHome)
    const saved = YAML.parse(fs.readFileSync(path.join(tempHome, 'config.yaml'), 'utf8'))

    assert.equal(saved.model.default, 'smoke-model')
    assert.equal(saved.model.provider, 'custom:clawpanel')
    assert.equal(saved.stt.local.model, 'whisper-large-v3')
    assert.equal(saved.stt.local.device, 'cpu')
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('ClawPanel provides a token-bootstrap Dashboard dist for the pinned Hermes release', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-hermes-dashboard-'))
  try {
    const { ensureHermesDashboardFallbackDist } = await import('../scripts/dev-api.js')
    const dist = ensureHermesDashboardFallbackDist(tempHome)
    const indexPath = path.join(dist, 'index.html')

    assert.equal(dist, path.join(tempHome, 'clawpanel-dashboard-web-dist'))
    assert.equal(fs.statSync(path.join(dist, 'assets')).isDirectory(), true)
    assert.match(fs.readFileSync(indexPath, 'utf8'), /clawpanel-dashboard-spa-stub/)

    fs.writeFileSync(indexPath, 'preserve-existing-dashboard-index')
    ensureHermesDashboardFallbackDist(tempHome)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), 'preserve-existing-dashboard-index')
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('Web and Tauri Dashboard launchers use the managed dist without opening a browser', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const webStartBody = webSource.match(/async hermes_dashboard_start\([^]*?\n  \},\n\n  async hermes_dashboard_stop/)?.[0]
  const tauriStartBody = tauriSource.match(/pub async fn hermes_dashboard_start\([^]*?\n}\n\n/)?.[0]

  assert.ok(webStartBody, 'Web hermes_dashboard_start handler must be present')
  assert.ok(tauriStartBody, 'Tauri hermes_dashboard_start command must be present')
  assert.match(webStartBody, /envVars\.HERMES_WEB_DIST = ensureHermesDashboardFallbackDist\(home\)/)
  assert.match(webStartBody, /spawn\('hermes', \['dashboard', '--no-open'\]/)
  assert.match(tauriStartBody, /ensure_hermes_dashboard_fallback_dist\(&home\)/)
  assert.match(tauriStartBody, /cmd\.args\(\["dashboard", "--no-open"\]\)/)
  assert.match(tauriStartBody, /cmd\.env\("HERMES_WEB_DIST", dashboard_dist\)/)
})
