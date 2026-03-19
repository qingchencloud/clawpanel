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
  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  const tasks = [loadProxyConfig(page), loadModelProxyConfig(page)]
  tasks.push(loadRegistry(page))
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
  page.addEventListener('change', (e) => {
    if (e.target?.matches?.('[data-name="cloudflared-mode"], [data-name="cloudflared-expose"], [data-name="cloudflared-port"]')) {
      syncCloudflaredFormState(page)
    }
  })

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

function validateCloudflaredForm(form) {
  if (form.exposeTarget === 'custom' && !(Number(form.customPort) > 0)) {
    return '自定义端口模式下必须填写有效端口'
  }
  if (form.mode === 'named' && !form.tunnelName) {
    return '命名隧道模式下必须填写隧道名称'
  }
  if (form.mode === 'named' && !form.hostname) {
    return '命名隧道模式下必须填写绑定域名'
  }
  return ''
}

function syncCloudflaredFormState(page) {
  const form = getCloudflaredForm(page)
  const modeBlocks = page.querySelectorAll('[data-cloudflared-mode-block]')
  const exposeBlocks = page.querySelectorAll('[data-cloudflared-expose-block]')
  modeBlocks.forEach(node => {
    node.style.display = node.dataset.cloudflaredModeBlock === form.mode ? '' : 'none'
  })
  exposeBlocks.forEach(node => {
    node.style.display = node.dataset.cloudflaredExposeBlock === form.exposeTarget ? '' : 'none'
  })
  const resolvedPortEl = page.querySelector('[data-cloudflared-resolved-port]')
  if (resolvedPortEl) resolvedPortEl.textContent = String(resolveExposePort(form))
  const customPortInput = page.querySelector('[data-name="cloudflared-port"]')
  if (customPortInput) customPortInput.disabled = form.exposeTarget !== 'custom'
  const tunnelNameInput = page.querySelector('[data-name="cloudflared-tunnel"]')
  const hostnameInput = page.querySelector('[data-name="cloudflared-hostname"]')
  if (tunnelNameInput) tunnelNameInput.disabled = form.mode !== 'named'
  if (hostnameInput) hostnameInput.disabled = form.mode !== 'named'
  const validationEl = page.querySelector('[data-cloudflared-validation]')
  const errorText = validateCloudflaredForm(form)
  if (validationEl) {
    validationEl.textContent = errorText || '当前配置可直接保存；启动前会按你的选择自动计算实际端口。'
    validationEl.style.color = errorText ? 'var(--warning)' : 'var(--text-tertiary)'
  }
  const startBtn = page.querySelector('[data-action="cloudflared-start"]')
  if (startBtn) startBtn.disabled = !!errorText
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
    <div class="stat-cards" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:var(--space-md)">
      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-label">运行状态</span>
          <span class="status-dot ${status.running ? 'running' : 'stopped'}"></span>
        </div>
        <div class="stat-card-value">${status.running ? '运行中' : '未运行'}</div>
        <div class="stat-card-meta">版本 ${escapeHtml(status.version || '未知')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">当前模式</span></div>
        <div class="stat-card-value">${mode === 'named' ? '命名隧道' : '快速隧道'}</div>
        <div class="stat-card-meta">暴露 ${exposeTarget === 'gateway' ? 'Gateway' : exposeTarget === 'webui' ? 'Web UI' : '自定义端口'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">实际端口</span></div>
        <div class="stat-card-value" data-cloudflared-resolved-port>${resolveExposePort({ mode, exposeTarget, customPort, useHttp2, tunnelName, hostname })}</div>
        <div class="stat-card-meta">启动时传给 cloudflared</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">公网地址</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm)">${status.url ? '已生成' : '未生成'}</div>
        <div class="stat-card-meta">${status.url ? `<a href="${escapeHtml(status.url)}" target="_blank" rel="noopener">打开公网地址</a>` : '启动后自动生成'}</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-md)">
      <button class="btn btn-primary btn-sm" data-action="cloudflared-install">安装</button>
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-login">登录 Cloudflare</button>
      ${status.running
        ? '<button class="btn btn-danger btn-sm" data-action="cloudflared-stop">停止公网访问</button>'
        : '<button class="btn btn-primary btn-sm" data-action="cloudflared-start">启动公网访问</button>'
      }
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-refresh">刷新状态</button>
      <button class="btn btn-secondary btn-sm" data-action="cloudflared-save">保存设置</button>
    </div>

    <div class="config-section" style="margin-bottom:var(--space-md)">
      <div class="config-section-title">1. 选择暴露目标</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-width:900px">
        <label class="form-label">暴露目标
          <select class="form-input" data-name="cloudflared-expose">
            <option value="gateway" ${exposeTarget === 'gateway' ? 'selected' : ''}>Gateway 18789</option>
            <option value="webui" ${exposeTarget === 'webui' ? 'selected' : ''}>Web UI 1420</option>
            <option value="custom" ${exposeTarget === 'custom' ? 'selected' : ''}>自定义端口</option>
          </select>
        </label>
        <div class="form-hint" style="align-self:end;padding-bottom:10px">推荐默认暴露 Gateway。选择 Gateway 时，会自动把 Cloudflare URL 写入 <code>gateway.controlUi.allowedOrigins</code>。</div>
      </div>
      <div class="config-section" data-cloudflared-expose-block="gateway" style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--bg-tertiary);border:1px solid var(--border-secondary)">
        <div class="form-hint">固定暴露 OpenClaw Gateway，端口 18789，无需额外输入。</div>
      </div>
      <div class="config-section" data-cloudflared-expose-block="webui" style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--bg-tertiary);border:1px solid var(--border-secondary)">
        <div class="form-hint">固定暴露 ClawPanel Web UI，端口 1420，适合只开放管理面板。</div>
      </div>
      <div class="config-section" data-cloudflared-expose-block="custom" style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--bg-tertiary);border:1px solid var(--border-secondary)">
        <label class="form-label">自定义端口
          <input class="form-input" data-name="cloudflared-port" placeholder="18789" value="${escapeHtml(String(customPort))}">
        </label>
        <div class="form-hint">只有在“自定义端口”模式下这里才生效。</div>
      </div>
    </div>

    <div class="config-section" style="margin-bottom:var(--space-md)">
      <div class="config-section-title">2. 选择隧道模式</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-width:900px">
        <label class="form-label">隧道类型
          <select class="form-input" data-name="cloudflared-mode">
            <option value="quick" ${mode === 'quick' ? 'selected' : ''}>快速隧道</option>
            <option value="named" ${mode === 'named' ? 'selected' : ''}>命名隧道</option>
          </select>
        </label>
        <label class="form-label">启用 HTTP/2
          <input type="checkbox" data-name="cloudflared-http2" ${useHttp2 ? 'checked' : ''}>
        </label>
      </div>
      <div class="config-section" data-cloudflared-mode-block="quick" style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--bg-tertiary);border:1px solid var(--border-secondary)">
        <div class="form-hint">快速隧道无需隧道名和域名，适合临时开放，启动后自动生成公网地址。</div>
      </div>
      <div class="config-section" data-cloudflared-mode-block="named" style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--bg-tertiary);border:1px solid var(--border-secondary)">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-width:900px">
          <label class="form-label">隧道名称
            <input class="form-input" data-name="cloudflared-tunnel" value="${escapeHtml(tunnelName)}" placeholder="my-openclaw-tunnel">
          </label>
          <label class="form-label">绑定域名
            <input class="form-input" data-name="cloudflared-hostname" value="${escapeHtml(hostname)}" placeholder="openclaw.example.com">
          </label>
        </div>
        <div class="form-hint">命名隧道适合长期使用。通常先登录，再填写隧道名称和域名。</div>
      </div>
    </div>

    <div class="form-hint">
      推荐顺序：安装 → 登录 Cloudflare → 选择暴露目标 → 选择隧道模式 → 保存设置 → 启动公网访问。
    </div>
  `
  syncCloudflaredFormState(page)
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
  if (page.__cloudflaredInstalled === false) {
    toast('请先安装 Cloudflared', 'warning')
    syncCloudflaredFormState(page)
    return
  }
  await api.cloudflaredLogin()
  await loadCloudflared(page)
  toast('Cloudflared 登录完成', 'success')
}

async function handleCloudflaredStart(page) {
  const form = getCloudflaredForm(page)
  const validationError = validateCloudflaredForm(form)
  if (validationError) {
    syncCloudflaredFormState(page)
    toast(validationError, 'warning')
    return
  }
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
    const overridePath = cfg?.openclawPath || ''
    const cliMeta = buildOpenclawCliMeta(svc, { overridePath })
    const detectedPath = cliMeta.path || ''
    const detectedVersion = cliMeta.version || ''
    const candidates = Array.isArray(svc?.cli_candidates) ? svc.cli_candidates : []
    const selectedValue = overridePath || detectedPath || ''

    bar.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span class="status-dot ${cliMeta.installed ? 'running' : 'stopped'}"></span>
          <span>${escapeHtml(cliMeta.statusLabel)}</span>
          ${detectedVersion ? `<span style="color:var(--text-tertiary)">CLI 版本: ${escapeHtml(detectedVersion)}</span>` : ''}
          <span style="color:var(--text-tertiary)">路径来源: ${escapeHtml(cliMeta.pathSourceLabel)}</span>
          <span style="color:var(--text-tertiary)">路径策略: ${escapeHtml(cliMeta.strategyLabel)}</span>
        </div>
        ${detectedPath ? `<div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">CLI 路径: <span style="font-family:monospace;word-break:break-all">${escapeHtml(detectedPath)}</span></div>` : ''}
        ${detectedVersion ? `<div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">版本来源: ${escapeHtml(cliMeta.versionSourceLabel)}</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <select class="form-input" data-name="openclaw-candidate" style="max-width:520px">
            <option value="">自动检测当前 PATH</option>
            ${candidates.map(p => `<option value="${escapeHtml(p)}" ${p === selectedValue ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
          </select>
          <input class="form-input" data-name="openclaw-path" placeholder="C:\\Program Files\\OpenClaw\\openclaw.cmd" value="${escapeHtml(String(overridePath || detectedPath))}" style="max-width:520px">
          <button class="btn btn-primary btn-sm" data-action="openclaw-save">保存路径</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-clear">清除覆盖</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-refresh">刷新检测</button>
          <button class="btn btn-secondary btn-sm" data-action="openclaw-setup">进入初始化设置</button>
        </div>
        <div class="form-hint" style="margin-top:4px">
          保存路径后将优先使用该路径检测与启动 Gateway。若检测到多条 CLI 路径，可先在下拉框中选中再保存。清除覆盖会回退到自动检测。
        </div>
      </div>
    `

    const candidateSelect = bar.querySelector('[data-name="openclaw-candidate"]')
    const pathInput = bar.querySelector('[data-name="openclaw-path"]')
    candidateSelect?.addEventListener('change', () => {
      if (candidateSelect.value) pathInput.value = candidateSelect.value
    })
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
  }
}

async function handleOpenclawSave(page) {
  const candidate = page.querySelector('[data-name="openclaw-candidate"]')
  const input = page.querySelector('[data-name="openclaw-path"]')
  const inputValue = String(input?.value || '').trim()
  const candidateValue = String(candidate?.value || '').trim()
  const value = inputValue || candidateValue
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
