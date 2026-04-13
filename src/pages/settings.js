/**
 * 面板设置页面
 * 统一管理 ClawPanel 的网络代理、npm 源、模型代理等配置
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { t, getLang, setLang, getAvailableLangs, onLangChange } from '../lib/i18n.js'
import { isMacPlatform } from '../lib/app-state.js'
import { renderSidebar } from '../components/sidebar.js'
import { getActiveEngineId } from '../lib/engine-manager.js'

const isTauri = !!window.__TAURI_INTERNALS__

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function platformDefaultDockerEndpoint() {
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows')
  return isWin ? '//./pipe/docker_engine' : '/var/run/docker.sock'
}

function effectiveDockerEndpoint(cfg) {
  return (cfg?.dockerEndpoint || '').trim() || platformDefaultDockerEndpoint()
}

function effectiveDockerImage(cfg) {
  return (cfg?.dockerDefaultImage || '').trim() || 'ghcr.io/qingchencloud/openclaw'
}

function openclawInstallationIdentity(installation) {
  const rawPath = String(installation?.path || '').trim()
  if (!rawPath) return ''
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows')
  if (!isWin) return rawPath
  return rawPath
    .replace(/\//g, '\\')
    .replace(/\\openclaw(?:\.exe|\.ps1)?$/i, '\\openclaw.cmd')
    .toLowerCase()
}

function dedupeOpenclawInstallations(list = []) {
  const map = new Map()
  const preferCmd = inst => /openclaw\.cmd$/i.test(String(inst?.path || ''))
  for (const installation of Array.isArray(list) ? list : []) {
    const key = openclawInstallationIdentity(installation)
    if (!key) continue
    const existing = map.get(key)
    if (!existing || (!existing.active && installation.active) || (!preferCmd(existing) && preferCmd(installation))) {
      map.set(key, installation)
    }
  }
  return [...map.values()]
}

const REGISTRIES = [
  { label: () => t('settings.registryTaobao'), value: 'https://registry.npmmirror.com' },
  { label: () => t('settings.registryNpm'), value: 'https://registry.npmjs.org' },
  { label: () => t('settings.registryHuawei'), value: 'https://repo.huaweicloud.com/repository/npm/' },
]

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  const isHermes = getActiveEngineId() === 'hermes'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('settings.title')}</h1>
      <p class="page-desc">${t('settings.desc')}</p>
    </div>

    <div class="config-section" id="proxy-section">
      <div class="config-section-title">${t('settings.networkProxy')}</div>
      <div id="proxy-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="model-proxy-section">
      <div class="config-section-title">${t('settings.modelProxy')}</div>
      <div id="model-proxy-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    ${isHermes ? '' : `<div class="config-section" id="registry-section">
      <div class="config-section-title">${t('settings.npmRegistry')}</div>
      <div id="registry-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="openclaw-dir-section">
      <div class="config-section-title">${t('settings.openclawDir')}</div>
      <div id="openclaw-dir-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="openclaw-search-section">
      <div class="config-section-title">${t('settings.openclawSearchPaths')}</div>
      <div id="openclaw-search-bar"><div class="stat-card loading-placeholder" style="height:96px"></div></div>
    </div>

    <div class="config-section" id="docker-defaults-section">
      <div class="config-section-title">${t('settings.dockerDefaults')}</div>
      <div id="docker-defaults-bar"><div class="stat-card loading-placeholder" style="height:84px"></div></div>
    </div>

    <div class="config-section" id="git-path-section">
      <div class="config-section-title">${t('settings.gitPath')}</div>
      <div id="git-path-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="cli-binding-section">
      <div class="config-section-title">${t('settings.openclawCli')}</div>
      <div id="cli-binding-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>`}

    <div class="config-section" id="language-section">
      <div class="config-section-title">${t('settings.language')}</div>
      <div id="language-bar"></div>
    </div>

    ${window.__TAURI_INTERNALS__ ? `<div class="config-section" id="autostart-section">
      <div class="config-section-title">${t('settings.autostart')}</div>
      <div id="autostart-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>` : ''}

  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  const isHermes = getActiveEngineId() === 'hermes'
  const tasks = [loadProxyConfig(page), loadModelProxyConfig(page)]
  if (!isHermes) {
    tasks.push(loadOpenclawDir(page), loadOpenclawSearchPaths(page), loadDockerDefaults(page), loadGitPath(page), loadCliBinding(page), loadRegistry(page))
  }
  if (window.__TAURI_INTERNALS__) tasks.push(loadAutostart(page))
  await Promise.all(tasks)
  loadLanguageSwitcher(page)
}

// ===== 网络代理 =====

async function loadProxyConfig(page) {
  const bar = page.querySelector('#proxy-bar')
  if (!bar) return
  try {
    const cfg = await api.readPanelConfig()
    const proxyUrl = cfg?.networkProxy?.url || ''
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
        <input class="form-input" data-name="proxy-url" placeholder="http://127.0.0.1:7897" value="${escapeHtml(proxyUrl)}" style="max-width:360px">
        <button class="btn btn-primary btn-sm" data-action="save-proxy">${t('common.save')}</button>
        <button class="btn btn-secondary btn-sm" data-action="test-proxy" ${proxyUrl ? '' : 'disabled'}>${t('settings.testProxy')}</button>
        <button class="btn btn-secondary btn-sm" data-action="clear-proxy" ${proxyUrl ? '' : 'disabled'}>${t('settings.clearProxy')}</button>
      </div>
      <div id="proxy-test-result" style="margin-top:var(--space-xs);font-size:var(--font-size-xs);min-height:20px"></div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${t('settings.proxyHint')}
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

// ===== 模型请求代理 =====

async function loadModelProxyConfig(page) {
  const bar = page.querySelector('#model-proxy-bar')
  if (!bar) return
  try {
    const cfg = await api.readPanelConfig()
    const proxyUrl = cfg?.networkProxy?.url || ''
    const modelProxy = !!cfg?.networkProxy?.proxyModelRequests
    const hasProxy = !!proxyUrl

    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:var(--font-size-sm);cursor:pointer">
          <input type="checkbox" data-name="model-proxy-toggle" ${modelProxy ? 'checked' : ''} ${hasProxy ? '' : 'disabled'}>
          ${t('settings.modelProxyToggle')}
        </label>
        <button class="btn btn-primary btn-sm" data-action="save-model-proxy">${t('common.save')}</button>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${hasProxy
          ? t('settings.modelProxyHint')
          : t('settings.modelProxyNoProxy')
        }
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

// ===== npm 源设置 =====

async function loadRegistry(page) {
  const bar = page.querySelector('#registry-bar')
  try {
    const current = await api.getNpmRegistry()
    const isPreset = REGISTRIES.some(r => r.value === current)
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
        <select class="form-input" data-name="registry" style="max-width:320px">
          ${REGISTRIES.map(r => `<option value="${r.value}" ${r.value === current ? 'selected' : ''}>${typeof r.label === 'function' ? r.label() : r.label}</option>`).join('')}
          <option value="custom" ${!isPreset ? 'selected' : ''}>${t('settings.registryCustom')}</option>
        </select>
        <input class="form-input" data-name="custom-registry" placeholder="https://..." value="${isPreset ? '' : escapeHtml(current)}" style="max-width:320px;${isPreset ? 'display:none' : ''}">
        <button class="btn btn-primary btn-sm" data-action="save-registry">${t('common.save')}</button>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">${t('settings.registryHint')}</div>
    `
    const select = bar.querySelector('[data-name="registry"]')
    const customInput = bar.querySelector('[data-name="custom-registry"]')
    select.onchange = () => {
      customInput.style.display = select.value === 'custom' ? '' : 'none'
    }
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

// ===== OpenClaw 安装路径 =====

async function loadOpenclawDir(page) {
  const bar = page.querySelector('#openclaw-dir-bar')
  if (!bar) return
  try {
    const info = await api.getOpenclawDir()
    const cfg = await api.readPanelConfig()
    const customValue = cfg?.openclawDir || ''
    const statusText = info.configExists
      ? `<span style="color:var(--success)">${t('settings.configExists')}</span>`
      : `<span style="color:var(--warning)">${t('settings.configMissing')}</span>`
    bar.innerHTML = `
      <div style="margin-bottom:var(--space-xs)">
        <span class="form-hint">${t('settings.currentPath')}:</span>
        <strong style="font-size:var(--font-size-sm)">${escapeHtml(info.path)}</strong>
        <span style="margin-left:var(--space-xs);font-size:var(--font-size-xs)">${statusText}</span>
        ${info.isCustom ? `<span class="clawhub-badge" style="margin-left:var(--space-xs);background:rgba(99,102,241,0.14);color:#6366f1;font-size:var(--font-size-xs)">${t('settings.customBadge')}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
        <input class="form-input" data-name="openclaw-dir" placeholder="${t('settings.dirPlaceholder')}" value="${escapeHtml(customValue)}" style="max-width:420px">
        <button class="btn btn-primary btn-sm" data-action="save-openclaw-dir">${t('common.save')}</button>
        ${info.isCustom ? `<button class="btn btn-secondary btn-sm" data-action="reset-openclaw-dir">${t('settings.resetDefault')}</button>` : ''}
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${t('settings.dirHint')}
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

async function handleSaveOpenclawDir(page) {
  const input = page.querySelector('[data-name="openclaw-dir"]')
  const value = (input?.value || '').trim()
  const cfg = await api.readPanelConfig()
  if (value) {
    cfg.openclawDir = value
  } else {
    delete cfg.openclawDir
  }
  await api.writePanelConfig(cfg)
  await loadOpenclawDir(page)
  await loadCliBinding(page)
  const savedMsg = value ? t('settings.customPathSaved') : t('settings.defaultRestored')
  const refreshed = await maybeRefreshGatewayServiceBinding()
  if (refreshed) {
    toast(savedMsg, 'success')
    return
  }
  await promptRestart(savedMsg)
}

async function handleResetOpenclawDir(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.openclawDir
  await api.writePanelConfig(cfg)
  await loadOpenclawDir(page)
  await loadCliBinding(page)
  const refreshed = await maybeRefreshGatewayServiceBinding()
  if (refreshed) {
    toast(t('settings.defaultRestored'), 'success')
    return
  }
  await promptRestart(t('settings.defaultRestored'))
}

async function loadOpenclawSearchPaths(page) {
  const bar = page.querySelector('#openclaw-search-bar')
  if (!bar) return
  try {
    const cfg = await api.readPanelConfig()
    const value = Array.isArray(cfg?.openclawSearchPaths) ? cfg.openclawSearchPaths.join('\n') : ''
    bar.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:var(--space-sm)">
        <textarea class="form-input" data-name="openclaw-search-paths" rows="4" placeholder="${t('settings.searchPathsPlaceholder')}" style="max-width:680px;min-height:108px;resize:vertical">${escapeHtml(value)}</textarea>
        <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-action="save-openclaw-search-paths">${t('common.save')}</button>
        </div>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${t('settings.searchPathsHint')}
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

function parseOpenclawSearchPaths(raw) {
  const values = []
  const seen = new Set()
  for (const part of String(raw || '').split(/[\r\n;]+/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    values.push(value)
  }
  return values
}

async function handleSaveOpenclawSearchPaths(page) {
  const input = page.querySelector('[data-name="openclaw-search-paths"]')
  const paths = parseOpenclawSearchPaths(input?.value || '')
  const cfg = await api.readPanelConfig()
  if (paths.length > 0) {
    cfg.openclawSearchPaths = paths
  } else {
    delete cfg.openclawSearchPaths
  }
  await api.writePanelConfig(cfg)
  await loadOpenclawSearchPaths(page)
  await loadCliBinding(page)
  toast(paths.length > 0 ? t('settings.searchPathsSaved') : t('settings.searchPathsCleared'), 'success')
}

async function loadDockerDefaults(page) {
  const bar = page.querySelector('#docker-defaults-bar')
  if (!bar) return
  try {
    const cfg = await api.readPanelConfig()
    const endpoint = cfg?.dockerEndpoint || ''
    const image = cfg?.dockerDefaultImage || ''
    const currentEndpoint = effectiveDockerEndpoint(cfg)
    const currentImage = effectiveDockerImage(cfg)
    bar.innerHTML = `
      <div style="margin-bottom:var(--space-xs);display:flex;flex-direction:column;gap:4px">
        <div><span class="form-hint">${t('settings.currentDefault')}:</span> <code style="font-size:var(--font-size-xs)">${escapeHtml(currentEndpoint)}</code></div>
        <div><span class="form-hint">${t('settings.dockerDefaultImage')}:</span> <code style="font-size:var(--font-size-xs)">${escapeHtml(currentImage)}</code></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-sm)">
        <input class="form-input" data-name="docker-endpoint" placeholder="${t('settings.dockerEndpointPlaceholder')}" value="${escapeHtml(endpoint)}" style="max-width:680px">
        <input class="form-input" data-name="docker-default-image" placeholder="${t('settings.dockerDefaultImagePlaceholder')}" value="${escapeHtml(image)}" style="max-width:680px">
        <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-action="save-docker-defaults">${t('common.save')}</button>
        </div>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${t('settings.dockerDefaultsHint')}
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

async function handleSaveDockerDefaults(page) {
  const endpointInput = page.querySelector('[data-name="docker-endpoint"]')
  const imageInput = page.querySelector('[data-name="docker-default-image"]')
  const endpoint = (endpointInput?.value || '').trim()
  const image = (imageInput?.value || '').trim()
  const cfg = await api.readPanelConfig()
  if (endpoint) cfg.dockerEndpoint = endpoint
  else delete cfg.dockerEndpoint
  if (image) cfg.dockerDefaultImage = image
  else delete cfg.dockerDefaultImage
  await api.writePanelConfig(cfg)
  await loadDockerDefaults(page)
  toast(t('settings.dockerDefaultsSaved'), 'success')
}

async function maybeRefreshGatewayServiceBinding() {
  if (!isMacPlatform()) return false

  const [versionInfo, dirInfo] = await Promise.all([
    api.getVersionInfo().catch(() => null),
    api.getOpenclawDir().catch(() => null),
  ])
  if (!versionInfo?.cli_path || dirInfo?.configExists === false) {
    return false
  }

  const shouldRefresh = await showConfirm(t('settings.gatewayServiceRefreshConfirm'))
  if (!shouldRefresh) return false

  toast(t('settings.gatewayServiceRefreshing'), 'info')
  try {
    const services = await api.getServicesStatus().catch(() => [])
    const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
    const shouldStartAgain = gw?.running === true && gw?.owned_by_current_instance !== false

    await api.uninstallGateway().catch(() => {})
    await api.installGateway()
    if (shouldStartAgain) {
      await api.startService('ai.openclaw.gateway')
    }

    toast(t('settings.gatewayServiceRefreshed'), 'success')
    return true
  } catch (e) {
    toast(`${t('settings.gatewayServiceRefreshFailed')}: ${e?.message || e}`, 'warning')
    return false
  }
}

async function promptRestart(msg) {
  if (!isTauri) { toast(msg, 'success'); return }
  const ok = await showConfirm(`${msg}\n\n${t('settings.restartConfirm')}`)
  if (ok) {
    toast(t('settings.restarting'), 'info')
    try { await api.relaunchApp() } catch { toast(t('settings.restartFailed'), 'warning') }
  } else {
    toast(`${msg}, ${t('settings.effectNextLaunch')}`, 'success')
  }
}

// ===== 事件绑定 =====

function bindEvents(page) {
  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    btn.disabled = true
    try {
      switch (action) {
        case 'save-proxy':
          await handleSaveProxy(page)
          break
        case 'test-proxy':
          await handleTestProxy(page)
          break
        case 'clear-proxy':
          await handleClearProxy(page)
          break
        case 'save-model-proxy':
          await handleSaveModelProxy(page)
          break
        case 'save-registry':
          await handleSaveRegistry(page)
          break
        case 'save-openclaw-dir':
          await handleSaveOpenclawDir(page)
          break
        case 'reset-openclaw-dir':
          await handleResetOpenclawDir(page)
          break
        case 'save-openclaw-search-paths':
          await handleSaveOpenclawSearchPaths(page)
          break
        case 'save-docker-defaults':
          await handleSaveDockerDefaults(page)
          break
        case 'save-git-path':
          await handleSaveGitPath(page)
          break
        case 'reset-git-path':
          await handleResetGitPath(page)
          break
        case 'scan-git-paths':
          await handleScanGitPaths(page)
          break
        case 'use-scanned-git':
          page.querySelector('[data-name="git-path"]').value = btn.dataset.gitPath || ''
          await handleSaveGitPath(page)
          break
        case 'bind-cli':
          await handleBindCli(page, btn.dataset.path)
          break
        case 'unbind-cli':
          await handleUnbindCli(page)
          break
      }
    } catch (e) {
      toast(e.toString(), 'error')
    } finally {
      btn.disabled = false
    }
  })

}

function normalizeProxyUrl(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(t('settings.proxyUrlInvalid'))
  }
  return url
}

async function handleTestProxy(page) {
  const resultEl = page.querySelector('#proxy-test-result')
  if (resultEl) resultEl.innerHTML = `<span style="color:var(--text-tertiary)">${t('settings.testingProxy')}</span>`
  try {
    const r = await api.testProxy()
    if (resultEl) {
      resultEl.innerHTML = r.ok
        ? `<span style="color:var(--success)">✓ ${t('settings.proxyOk', { status: r.status, ms: r.elapsed_ms, target: escapeHtml(r.target) })}</span>`
        : `<span style="color:var(--warning)">⚠ ${t('settings.proxyWarn', { status: r.status, ms: r.elapsed_ms })}</span>`
    }
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--error)">✗ ${escapeHtml(String(e))}</span>`
  }
}

async function handleSaveProxy(page) {
  const input = page.querySelector('[data-name="proxy-url"]')
  const proxyUrl = normalizeProxyUrl(input?.value || '')
  if (!proxyUrl) {
    toast(t('settings.proxyUrlEmpty'), 'error')
    return
  }
  const cfg = await api.readPanelConfig()
  if (!cfg.networkProxy || typeof cfg.networkProxy !== 'object') {
    cfg.networkProxy = {}
  }
  cfg.networkProxy.url = proxyUrl
  await api.writePanelConfig(cfg)
  toast(t('settings.proxySaved'), 'success')
  await loadProxyConfig(page)
  await loadModelProxyConfig(page)
}

async function handleClearProxy(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.networkProxy
  await api.writePanelConfig(cfg)
  toast(t('settings.proxyCleared'), 'success')
  await loadProxyConfig(page)
  await loadModelProxyConfig(page)
}

async function handleSaveModelProxy(page) {
  const toggle = page.querySelector('[data-name="model-proxy-toggle"]')
  const checked = toggle?.checked || false
  const cfg = await api.readPanelConfig()
  if (!cfg.networkProxy || typeof cfg.networkProxy !== 'object') {
    cfg.networkProxy = {}
  }
  cfg.networkProxy.proxyModelRequests = checked
  await api.writePanelConfig(cfg)
  toast(checked ? t('settings.modelProxyOn') : t('settings.modelProxyOff'), 'success')
}

async function handleSaveRegistry(page) {
  const select = page.querySelector('[data-name="registry"]')
  const customInput = page.querySelector('[data-name="custom-registry"]')
  const registry = select.value === 'custom' ? customInput.value.trim() : select.value
  if (!registry) { toast(t('settings.registryEmpty'), 'error'); return }
  await api.setNpmRegistry(registry)
  toast(t('settings.registrySaved'), 'success')
}

// ===== Git 路径 =====

async function loadGitPath(page) {
  const bar = page.querySelector('#git-path-bar')
  if (!bar) return
  try {
    const gitInfo = await api.checkGit()
    const cfg = await api.readPanelConfig()
    const customValue = cfg?.gitPath || ''
    const invalidCustom = gitInfo.isCustom && !gitInfo.installed
    const statusText = gitInfo.installed
      ? `<span style="color:var(--success)">✓ ${escapeHtml(gitInfo.version || 'Git')}</span>`
      : invalidCustom
        ? `<span style="color:var(--error)">✗ ${t('settings.gitPathInvalid')}</span>`
        : `<span style="color:var(--error)">✗ Git ${t('setup.notInstalled')}</span>`
    const pathText = gitInfo.path ? `<span style="font-size:var(--font-size-xs);opacity:0.7">${escapeHtml(gitInfo.path)}</span>` : ''
    const customBadge = gitInfo.isCustom ? `<span class="badge" style="margin-left:6px;font-size:10px">${t('settings.customBadge')}</span>` : ''
    bar.innerHTML = `
      <div class="stat-card" style="padding:16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          ${statusText}${customBadge}
        </div>
        ${pathText ? `<div style="margin-bottom:10px">${pathText}</div>` : ''}
        <p style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:12px;line-height:1.5">${t('settings.gitPathHint')}</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input class="input" data-name="git-path" value="${escapeHtml(customValue)}" placeholder="${t('settings.gitPathPlaceholder')}" style="flex:1;min-width:200px">
          <button class="btn btn-primary btn-sm" data-action="save-git-path">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" data-action="reset-git-path">${t('settings.resetDefault')}</button>
          <button class="btn btn-secondary btn-sm" data-action="scan-git-paths">${t('settings.gitScan')}</button>
        </div>
        <div id="git-scan-results"></div>
      </div>`
  } catch (e) {
    bar.innerHTML = `<div class="stat-card" style="padding:16px;color:var(--error)">${e}</div>`
  }
}

async function handleSaveGitPath(page) {
  const input = page.querySelector('[data-name="git-path"]')
  const value = (input?.value || '').trim()
  const cfg = await api.readPanelConfig()
  if (value) {
    cfg.gitPath = value
  } else {
    delete cfg.gitPath
  }
  await api.writePanelConfig(cfg)
  const gitInfo = await api.checkGit()
  if (value && gitInfo.isCustom && !gitInfo.installed) {
    toast(t('settings.gitPathInvalid'), 'error')
  } else {
    toast(value ? t('settings.gitPathSaved') : t('settings.gitPathCleared'), 'success')
  }
  await loadGitPath(page)
}

async function handleScanGitPaths(page) {
  const container = page.querySelector('#git-scan-results')
  if (!container) return
  container.innerHTML = `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary)">${t('settings.gitScanning')}</div>`
  try {
    const results = await api.scanGitPaths()
    if (!results || results.length === 0) {
      container.innerHTML = `<div style="margin-top:10px;font-size:12px;color:var(--text-tertiary)">${t('settings.gitScanEmpty')}</div>`
      return
    }
    container.innerHTML = `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">${results.map(r =>
      `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;background:var(--bg-tertiary);border-radius:var(--radius-sm)">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</span>
        <span style="color:var(--text-tertiary);flex-shrink:0">${escapeHtml(r.version || '')}</span>
        <span class="badge" style="font-size:10px;flex-shrink:0">${escapeHtml(r.source)}</span>
        <button class="btn btn-primary btn-sm" style="padding:2px 8px;font-size:11px" data-action="use-scanned-git" data-git-path="${escapeHtml(r.path)}">${t('settings.gitScanUse')}</button>
      </div>`
    ).join('')}</div>`
  } catch (e) {
    container.innerHTML = `<div style="margin-top:10px;font-size:12px;color:var(--error)">${e}</div>`
  }
}

async function handleResetGitPath(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.gitPath
  await api.writePanelConfig(cfg)
  toast(t('settings.gitPathCleared'), 'success')
  await loadGitPath(page)
}

// ===== CLI 绑定 =====

async function loadCliBinding(page) {
  const bar = page.querySelector('#cli-binding-bar')
  if (!bar) return
  try {
    const version = await api.getVersionInfo()
    const cfg = await api.readPanelConfig()
    const boundPath = cfg?.openclawCliPath || ''
    const installations = dedupeOpenclawInstallations(version.all_installations || [])
    const currentPath = version.cli_path || ''

    const sourceLabel = (src) => ({
      standalone: t('dashboard.cliSourceStandalone'),
      'npm-zh': t('dashboard.cliSourceNpmZh'),
      'npm-official': t('dashboard.cliSourceNpmOfficial'),
      'npm-global': t('dashboard.cliSourceNpmGlobal'),
    })[src] || t('dashboard.cliSourceUnknown')

    let html = `<div class="form-hint" style="margin-bottom:var(--space-sm)">${t('settings.cliBindHint')}</div>`

    if (currentPath) {
      html += `<div style="margin-bottom:var(--space-sm);font-size:var(--font-size-sm)">
        <span style="color:var(--text-secondary)">${t('settings.cliCurrent')}:</span>
        <code style="font-size:var(--font-size-xs)">${escapeHtml(currentPath)}</code>
        ${boundPath ? `<span class="clawhub-badge" style="margin-left:var(--space-xs);background:rgba(99,102,241,0.14);color:#6366f1;font-size:var(--font-size-xs)">${t('settings.cliBound')}</span>` : ''}
      </div>`
    }

    if (installations.length > 0) {
      html += '<div style="display:flex;flex-direction:column;gap:var(--space-xs)">'
      // Auto-detect option
      html += `<div style="display:flex;align-items:center;gap:var(--space-sm);padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);${!boundPath ? 'background:var(--bg-active);border-color:var(--accent)' : ''}">
        <span style="flex:1;font-size:var(--font-size-sm)">${t('settings.cliAutoDetect')}</span>
        ${boundPath ? '<button class="btn btn-secondary btn-xs" data-action="unbind-cli">' + t('common.reset') + '</button>' : '<span style="color:var(--success);font-size:var(--font-size-xs)">✓ ' + t('settings.cliActive') + '</span>'}
      </div>`
      for (const inst of installations) {
        const isActive = inst.active
        const isBound = boundPath && inst.path === boundPath
        html += `<div style="display:flex;align-items:center;gap:var(--space-sm);padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);${isBound ? 'background:var(--bg-active);border-color:var(--accent)' : ''}">
          <div style="flex:1;min-width:0">
            <div style="font-size:var(--font-size-xs);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(inst.path)}">${escapeHtml(inst.path)}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${sourceLabel(inst.source)}${inst.version ? ' · v' + inst.version : ''}</div>
          </div>
          ${isBound ? '<span style="color:var(--success);font-size:var(--font-size-xs)">✓ ' + t('settings.cliBound') + '</span>' : `<button class="btn btn-secondary btn-xs" data-action="bind-cli" data-path="${escapeHtml(inst.path)}">${t('common.confirm')}</button>`}
        </div>`
      }
      html += '</div>'
    } else {
      html += `<div style="color:var(--text-tertiary);font-size:var(--font-size-sm)">${t('common.noData')}</div>`
    }

    bar.innerHTML = html
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">${t('common.loadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

async function handleBindCli(page, path) {
  if (!path) return
  const ok = await showConfirm(t('settings.cliSwitchConfirm'))
  if (!ok) return
  const cfg = await api.readPanelConfig()
  cfg.openclawCliPath = path
  await api.writePanelConfig(cfg)
  toast(t('common.saveSuccess'), 'success')
  await loadCliBinding(page)
  await maybeRefreshGatewayServiceBinding()
}

async function handleUnbindCli(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.openclawCliPath
  await api.writePanelConfig(cfg)
  toast(t('common.saveSuccess'), 'success')
  await loadCliBinding(page)
  await maybeRefreshGatewayServiceBinding()
}

// ===== 语言切换 =====

function loadLanguageSwitcher(page) {
  const bar = page.querySelector('#language-bar')
  if (!bar) return
  const langs = getAvailableLangs()
  const current = getLang()
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
      <select class="form-input" id="lang-select" style="max-width:200px">
        ${langs.map(l => `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${l.label}</option>`).join('')}
      </select>
    </div>
    <div class="form-hint" style="margin-top:var(--space-xs)">${t('settings.languageHint')}</div>
  `
  const select = bar.querySelector('#lang-select')
  select.onchange = () => {
    setLang(select.value)
    // Re-render sidebar + current page
    const sidebarEl = document.getElementById('sidebar')
    if (sidebarEl) renderSidebar(sidebarEl)
    // Re-render settings page
    const pageEl = page.closest('.page') || page
    render().then(newPage => {
      pageEl.replaceWith(newPage)
    }).catch(() => {})
  }
}

// ===== 开机自启 =====

async function loadAutostart(page) {
  const bar = page.querySelector('#autostart-bar')
  if (!bar) return
  try {
    const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
    const enabled = await isEnabled()
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-sm)">
        <label style="display:flex;align-items:center;gap:6px;font-size:var(--font-size-sm);cursor:pointer">
          <input type="checkbox" id="autostart-toggle" ${enabled ? 'checked' : ''}>
          ${t('settings.autostartToggle')}
        </label>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${t('settings.autostartHint')}
      </div>
    `
    bar.querySelector('#autostart-toggle')?.addEventListener('change', async (e) => {
      try {
        if (e.target.checked) {
          await enable()
          toast(t('settings.autostartEnabled'), 'success')
        } else {
          await disable()
          toast(t('settings.autostartDisabled'), 'success')
        }
      } catch (err) {
        e.target.checked = !e.target.checked
        toast(t('settings.autostartFailed') + ': ' + err, 'error')
      }
    })
  } catch {
    bar.innerHTML = `<div style="color:var(--text-tertiary);font-size:var(--font-size-sm)">${t('settings.autostartUnavailable')}</div>`
  }
}
