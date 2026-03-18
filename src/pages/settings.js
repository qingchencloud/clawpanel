/**
 * 面板设置页面
 * 统一管理 ClawPanel 的网络代理、npm 源、模型代理等配置
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

const isTauri = !!window.__TAURI_INTERNALS__

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const REGISTRIES = [
  { label: '淘宝镜像 (推荐)', value: 'https://registry.npmmirror.com' },
  { label: 'npm 官方源', value: 'https://registry.npmjs.org' },
  { label: '华为云镜像', value: 'https://repo.huaweicloud.com/repository/npm/' },
]

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">面板设置</h1>
      <p class="page-desc">管理 ClawPanel 的网络、代理和下载源配置</p>
    </div>

    <div class="config-section" id="proxy-section">
      <div class="config-section-title">网络代理</div>
      <div id="proxy-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="model-proxy-section">
      <div class="config-section-title">模型请求代理</div>
      <div id="model-proxy-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="registry-section">
      <div class="config-section-title">npm 源设置</div>
      <div id="registry-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="cloudflared-section">
      <div class="config-section-title">公网访问</div>
      <div id="cloudflared-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>

    <div class="config-section" id="openclaw-section">
      <div class="config-section-title">OpenClaw CLI</div>
      <div id="openclaw-bar"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>
  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  const tasks = [loadProxyConfig(page), loadModelProxyConfig(page)]
  tasks.push(loadRegistry(page))
  tasks.push(loadCloudflared(page))
  tasks.push(loadOpenclawCli(page))
  await Promise.all(tasks)
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
        <button class="btn btn-primary btn-sm" data-action="save-proxy">保存</button>
        <button class="btn btn-secondary btn-sm" data-action="test-proxy" ${proxyUrl ? '' : 'disabled'}>测试连通</button>
        <button class="btn btn-secondary btn-sm" data-action="clear-proxy" ${proxyUrl ? '' : 'disabled'}>关闭代理</button>
      </div>
      <div id="proxy-test-result" style="margin-top:var(--space-xs);font-size:var(--font-size-xs);min-height:20px"></div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        设置后，npm 安装/升级、版本检测、GitHub/Gitee 更新检查、ClawHub Skills 等下载类操作会走此代理。自动绕过 localhost 和内网地址。保存后新请求立即生效；如 Gateway 正在运行，建议重启一次服务。
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
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
          模型测试和模型列表请求也走代理
        </label>
        <button class="btn btn-primary btn-sm" data-action="save-model-proxy">保存</button>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">
        ${hasProxy
          ? '默认关闭。部分用户的模型 API 地址本身就是国内中转或内网地址，走代理反而会连接失败。只有当你的模型服务商需要翻墙访问时才建议开启。'
          : '请先在上方设置网络代理地址后，才能启用此选项。'
        }
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
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
          ${REGISTRIES.map(r => `<option value="${r.value}" ${r.value === current ? 'selected' : ''}>${r.label}</option>`).join('')}
          <option value="custom" ${!isPreset ? 'selected' : ''}>自定义</option>
        </select>
        <input class="form-input" data-name="custom-registry" placeholder="https://..." value="${isPreset ? '' : escapeHtml(current)}" style="max-width:320px;${isPreset ? 'display:none' : ''}">
        <button class="btn btn-primary btn-sm" data-action="save-registry">保存</button>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">升级和版本检测使用此源下载 npm 包，国内用户推荐淘宝镜像</div>
    `
    const select = bar.querySelector('[data-name="registry"]')
    const customInput = bar.querySelector('[data-name="custom-registry"]')
    select.onchange = () => {
      customInput.style.display = select.value === 'custom' ? '' : 'none'
    }
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
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
        case 'cloudflared-install':
          await handleCloudflaredInstall(page)
          break
        case 'cloudflared-login':
          await handleCloudflaredLogin(page)
          break
        case 'cloudflared-start':
          await handleCloudflaredStart(page)
          break
        case 'cloudflared-stop':
          await handleCloudflaredStop(page)
          break
        case 'cloudflared-refresh':
          await loadCloudflared(page)
          break
        case 'cloudflared-save':
          await handleCloudflaredSave(page)
          break
        case 'openclaw-save':
          await handleOpenclawSave(page)
          break
        case 'openclaw-clear':
          await handleOpenclawClear(page)
          break
        case 'openclaw-refresh':
          await loadOpenclawCli(page)
          break
        case 'openclaw-setup':
          await handleOpenclawSetup()
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
    throw new Error('代理地址必须以 http:// 或 https:// 开头')
  }
  return url
}

async function handleTestProxy(page) {
  const resultEl = page.querySelector('#proxy-test-result')
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--text-tertiary)">正在测试代理连通性...</span>'
  try {
    const r = await api.testProxy()
    if (resultEl) {
      resultEl.innerHTML = r.ok
        ? `<span style="color:var(--success)">✓ 代理连通（HTTP ${r.status}，耗时 ${r.elapsed_ms}ms）→ ${escapeHtml(r.target)}</span>`
        : `<span style="color:var(--warning)">⚠ 代理可达但返回异常（HTTP ${r.status}，${r.elapsed_ms}ms）</span>`
    }
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--error)">✗ ${escapeHtml(String(e))}</span>`
  }
}

async function handleSaveProxy(page) {
  const input = page.querySelector('[data-name="proxy-url"]')
  const proxyUrl = normalizeProxyUrl(input?.value || '')
  if (!proxyUrl) {
    toast('请输入代理地址，或点击"关闭代理"', 'error')
    return
  }
  const cfg = await api.readPanelConfig()
  if (!cfg.networkProxy || typeof cfg.networkProxy !== 'object') {
    cfg.networkProxy = {}
  }
  cfg.networkProxy.url = proxyUrl
  await api.writePanelConfig(cfg)
  toast('网络代理已保存；如 Gateway 正在运行，建议重启服务', 'success')
  await loadProxyConfig(page)
  await loadModelProxyConfig(page)
}

async function handleClearProxy(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.networkProxy
  await api.writePanelConfig(cfg)
  toast('网络代理已关闭', 'success')
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
  toast(checked ? '模型请求将走代理' : '模型请求已关闭代理', 'success')
}

async function handleSaveRegistry(page) {
  const select = page.querySelector('[data-name="registry"]')
  const customInput = page.querySelector('[data-name="custom-registry"]')
  const registry = select.value === 'custom' ? customInput.value.trim() : select.value
  if (!registry) { toast('请输入源地址', 'error'); return }
  await api.setNpmRegistry(registry)
  toast('npm 源已保存', 'success')
}

// ===== Cloudflared 公网访问 =====

function getCloudflaredForm(page) {
  const mode = page.querySelector('[data-name="cloudflared-mode"]')?.value || 'quick'
  const exposeTarget = page.querySelector('[data-name="cloudflared-expose"]')?.value || 'gateway'
  const customPort = Number(page.querySelector('[data-name="cloudflared-port"]')?.value || 0)
  const useHttp2 = !!page.querySelector('[data-name="cloudflared-http2"]')?.checked
  const tunnelName = (page.querySelector('[data-name="cloudflared-tunnel"]')?.value || '').trim()
  const hostname = (page.querySelector('[data-name="cloudflared-hostname"]')?.value || '').trim()
  return { mode, exposeTarget, customPort, useHttp2, tunnelName, hostname }
}

function resolveExposePort(form) {
  if (form.exposeTarget === 'webui') return 1420
  if (form.exposeTarget === 'custom') return form.customPort || 18789
  return 18789
}

async function loadCloudflared(page) {
  const el = page.querySelector('#cloudflared-bar')
  if (!el) return

  const cfg = await api.readPanelConfig()
  if (!cfg.cloudflared || typeof cfg.cloudflared !== 'object') {
    cfg.cloudflared = { mode: 'quick', exposeTarget: 'gateway', customPort: '', useHttp2: true, tunnelName: '', hostname: '' }
    await api.writePanelConfig(cfg)
  }
  const saved = cfg.cloudflared || {}
  const status = await api.cloudflaredGetStatus().catch(() => ({ installed: false, running: false }))

  const mode = saved.mode || 'quick'
  const exposeTarget = saved.exposeTarget || 'gateway'
  const customPort = saved.customPort || ''
  const useHttp2 = saved.useHttp2 !== false
  const tunnelName = saved.tunnelName || ''
  const hostname = saved.hostname || ''

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:var(--space-sm)">
      <span class="status-dot ${status.running ? 'running' : 'stopped'}"></span>
      <span>${status.running ? '运行中' : '未运行'}</span>
      <span style="color:var(--text-tertiary)">版本: ${escapeHtml(status.version || '未知')}</span>
      ${status.url ? `<a href="${escapeHtml(status.url)}" target="_blank" rel="noopener">打开公网地址</a>` : ''}
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-sm)">
      <button class="btn btn-primary btn-sm" data-action="cloudflared-install">安装</button>
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-login">登录</button>
      ${status.running
        ? '<button class="btn btn-danger btn-sm" data-action="cloudflared-stop">停止</button>'
        : '<button class="btn btn-primary btn-sm" data-action="cloudflared-start">启动</button>'
      }
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-refresh">刷新</button>
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-save">保存设置</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:720px">
      <label class="form-label">隧道类型
        <select class="form-input" data-name="cloudflared-mode">
          <option value="quick" ${mode === 'quick' ? 'selected' : ''}>快速隧道</option>
          <option value="named" ${mode === 'named' ? 'selected' : ''}>命名隧道</option>
        </select>
      </label>
      <label class="form-label">暴露目标
        <select class="form-input" data-name="cloudflared-expose">
          <option value="gateway" ${exposeTarget === 'gateway' ? 'selected' : ''}>Gateway 18789</option>
          <option value="webui" ${exposeTarget === 'webui' ? 'selected' : ''}>Web UI 1420</option>
          <option value="custom" ${exposeTarget === 'custom' ? 'selected' : ''}>自定义端口</option>
        </select>
      </label>
      <label class="form-label">自定义端口
        <input class="form-input" data-name="cloudflared-port" placeholder="18789" value="${escapeHtml(String(customPort))}">
      </label>
      <label class="form-label">启用 HTTP/2
        <input type="checkbox" data-name="cloudflared-http2" ${useHttp2 ? 'checked' : ''}>
      </label>
      <label class="form-label">隧道名称（命名隧道）
        <input class="form-input" data-name="cloudflared-tunnel" value="${escapeHtml(tunnelName)}">
      </label>
      <label class="form-label">域名（命名隧道）
        <input class="form-input" data-name="cloudflared-hostname" value="${escapeHtml(hostname)}">
      </label>
    </div>

    <div class="form-hint" style="margin-top:8px">
      选择 Gateway 暴露时，会自动将 Cloudflare URL 写入 gateway.controlUi.allowedOrigins。
    </div>
  `
}

async function handleCloudflaredSave(page) {
  const cfg = await api.readPanelConfig()
  const form = getCloudflaredForm(page)
  cfg.cloudflared = {
    mode: form.mode,
    exposeTarget: form.exposeTarget,
    customPort: form.customPort,
    useHttp2: form.useHttp2,
    tunnelName: form.tunnelName,
    hostname: form.hostname,
  }
  await api.writePanelConfig(cfg)
  toast('Cloudflared 设置已保存', 'success')
}

async function handleCloudflaredInstall(page) {
  await api.cloudflaredInstall()
  await loadCloudflared(page)
  toast('Cloudflared 已安装', 'success')
}

async function handleCloudflaredLogin(page) {
  await api.cloudflaredLogin()
  await loadCloudflared(page)
  toast('Cloudflared 登录完成', 'success')
}

async function handleCloudflaredStart(page) {
  const form = getCloudflaredForm(page)
  const port = resolveExposePort(form)
  await handleCloudflaredSave(page)
  await api.cloudflaredStart({
    mode: form.mode,
    port,
    use_http2: form.useHttp2,
    tunnel_name: form.tunnelName || null,
    hostname: form.hostname || null,
    add_allowed_origins: true,
    expose_target: form.exposeTarget,
  })
  await loadCloudflared(page)
  toast('Cloudflared 已启动', 'success')
}

async function handleCloudflaredStop(page) {
  await api.cloudflaredStop()
  await loadCloudflared(page)
  toast('Cloudflared 已停止', 'success')
}

// ===== OpenClaw CLI =====

async function loadOpenclawCli(page) {
  const bar = page.querySelector('#openclaw-bar')
  if (!bar) return
  try {
    const [cfg, services] = await Promise.all([
      api.readPanelConfig(),
      api.getServicesStatus(),
    ])
    const svc = Array.isArray(services)
      ? services.find(s => s.label === 'ai.openclaw.gateway' || s.id === 'ai.openclaw.gateway' || s.name === 'ai.openclaw.gateway' || s.label === 'openclaw' || s.id === 'openclaw')
      : null
    const detectedPath = svc?.cli_path || ''
    const detectedVersion = svc?.cli_version || ''
    const detectedSource = svc?.cli_source || ''
    const overridePath = cfg?.openclawPath || ''

    bar.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span class="status-dot ${svc?.cli_installed ? 'running' : 'stopped'}"></span>
          <span>${svc?.cli_installed ? '已检测到 OpenClaw CLI' : '未检测到 OpenClaw CLI'}</span>
          ${detectedVersion ? `<span style="color:var(--text-tertiary)">版本: ${escapeHtml(detectedVersion)}</span>` : ''}
          ${detectedSource ? `<span style="color:var(--text-tertiary)">来源: ${escapeHtml(detectedSource)}</span>` : ''}
        </div>
        ${detectedPath ? `<div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">检测路径: <span style="font-family:monospace;word-break:break-all">${escapeHtml(detectedPath)}</span></div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <input class="form-input" data-name="openclaw-path" placeholder="C:\\Program Files\\OpenClaw\\openclaw.exe" value="${escapeHtml(String(overridePath))}" style="max-width:520px">
          <button class="btn btn-primary btn-sm" data-action="openclaw-save">保存路径</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-clear">清除覆盖</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-refresh">刷新检测</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-setup">进入初始化设置</button>
        </div>
        <div class="form-hint" style="margin-top:4px">
          保存路径后将优先使用该路径检测与启动 Gateway。清除覆盖会回退到自动检测。
        </div>
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
  }
}

async function handleOpenclawSave(page) {
  const input = page.querySelector('[data-name="openclaw-path"]')
  const value = String(input?.value || '').trim()
  const cfg = await api.readPanelConfig()
  if (!value) {
    delete cfg.openclawPath
    await api.writePanelConfig(cfg)
    toast('路径为空，已清除覆盖', 'info')
    await loadOpenclawCli(page)
    return
  }
  cfg.openclawPath = value
  await api.writePanelConfig(cfg)
  toast('OpenClaw 路径已保存', 'success')
  await loadOpenclawCli(page)
}

async function handleOpenclawClear(page) {
  const cfg = await api.readPanelConfig()
  delete cfg.openclawPath
  await api.writePanelConfig(cfg)
  toast('OpenClaw 路径覆盖已清除', 'success')
  await loadOpenclawCli(page)
}

async function handleOpenclawSetup() {
  try {
    const cfg = await api.readPanelConfig().catch(() => ({}))
    await api.writePanelConfig({ ...cfg, forceSetup: true, skipSetup: false })
    window.location.hash = '#/setup'
  } catch (e) {
    toast('进入初始化设置失败: ' + (e?.message || e), 'error')
  }
}
