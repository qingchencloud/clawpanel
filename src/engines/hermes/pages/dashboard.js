/**
 * Hermes Agent 仪表盘
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { PROVIDER_PRESETS } from '../../../lib/model-presets.js'

const ICONS = {
  running: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--success, #22c55e)" stroke-width="2.5" width="20" height="20"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>`,
  stopped: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--error, #ef4444)" stroke-width="2.5" width="20" height="20"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
  cron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  config: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>`,
}

const HERMES_PROVIDERS = PROVIDER_PRESETS.filter(p => !p.hidden)

// Lazy Tauri event listen (avoid top-level await for vite build)
let _listenFn = null
async function tauriListen(event, cb) {
  if (!_listenFn) {
    const mod = await import('@tauri-apps/api/event')
    _listenFn = mod.listen
  }
  return _listenFn(event, cb)
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'

  let info = null
  let health = null
  let hermesConfig = null   // { model, base_url, provider, api_key }
  let models = []           // fetched model list
  let loading = true
  let actionBusy = false
  let modelBusy = false
  let fetchBusy = false
  let cfgMsg = ''           // 配置区消息 HTML
  let showDropdown = false  // 模型下拉是否展开
  let envDetecting = false  // 环境探测中
  let envData = null        // { wsl2: {...}, docker: {...} }
  let connectMode = 'local' // local | wsl2 | docker | custom
  let customGwUrl = ''      // 自定义 Gateway URL
  let connectMsg = ''       // 连接区消息
  let modelConfigCollapsed = true // 模型配置默认折叠

  // 表单状态（跨 draw 保持，不被覆盖）
  let formBaseUrl = ''
  let formApiKey = ''
  let formModel = ''
  let formInited = false    // 首次加载后用 hermesConfig 初始化

  function syncFormFromDom() {
    const u = el.querySelector('#hm-cfg-baseurl')
    const k = el.querySelector('#hm-cfg-apikey')
    const m = el.querySelector('#hm-cfg-model')
    if (u) formBaseUrl = u.value
    if (k) formApiKey = k.value
    if (m) formModel = m.value
  }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }

  // --- 终端命令 ---
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows')
  const configPath = isWin ? '%USERPROFILE%\\.hermes' : '~/.hermes'

  const CLI_COMMANDS = [
    { label: t('engine.cliChat'),       desc: t('engine.cliChatDesc'),      cmd: 'hermes chat' },
    { label: t('engine.cliDoctor'),     desc: t('engine.cliDoctorDesc'),    cmd: 'hermes doctor' },
    { label: t('engine.cliVersion'),    desc: t('engine.cliVersionDesc'),   cmd: 'hermes version' },
    { label: t('engine.cliGwStart'),    desc: t('engine.cliGwStartDesc'),   cmd: 'hermes gateway run' },
    { label: t('engine.cliGwStop'),     desc: t('engine.cliGwStopDesc'),    cmd: 'hermes gateway stop' },
    { label: t('engine.cliUpgrade'),    desc: t('engine.cliUpgradeDesc'),   cmd: 'uv tool install --reinstall "hermes-agent @ git+https://github.com/NousResearch/hermes-agent.git" --python 3.11' },
    { label: t('engine.cliUninstall'),  desc: t('engine.cliUninstallDesc'), cmd: 'uv tool uninstall hermes-agent' },
    { label: t('engine.cliConfig'),     desc: t('engine.cliConfigDesc'),    cmd: isWin ? `explorer ${configPath}` : `open ${configPath}` },
  ]

  function renderCliCommands() {
    return CLI_COMMANDS.map((c, i) =>
      `<div class="hm-cli-row">
        <div class="hm-cli-info">
          <span class="hm-cli-label">${c.label}</span>
          <span class="hm-cli-desc">${c.desc}</span>
        </div>
        <div class="hm-cli-cmd-wrap">
          <code class="hm-cli-cmd">${esc(c.cmd)}</code>
          <button class="hm-cli-copy" data-cmd-idx="${i}" title="${t('common.copy')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        </div>
      </div>`
    ).join('')
  }

  function draw() {
    // 加载骨架屏
    if (loading) {
      el.innerHTML = `
        <div class="page-header" style="display:flex;align-items:center;gap:12px">
          <h1 style="margin:0">${t('engine.hermesDashboardTitle')}</h1>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px">
          ${[1,2,3,4].map(() => `<div class="card"><div class="card-body" style="padding:16px">
            <div class="skeleton-line" style="width:60%;height:12px;margin-bottom:10px"></div>
            <div class="skeleton-line" style="width:80%;height:20px"></div>
          </div></div>`).join('')}
        </div>
        <div class="card" style="margin-bottom:20px"><div class="card-body" style="padding:20px">
          <div class="skeleton-line" style="width:40%;height:16px;margin-bottom:16px"></div>
          <div style="display:flex;gap:6px;margin-bottom:14px">${[1,2,3,4].map(() => '<div class="skeleton-line" style="width:60px;height:24px;border-radius:12px"></div>').join('')}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="skeleton-line" style="height:36px"></div>
            <div class="skeleton-line" style="height:36px"></div>
          </div>
        </div></div>
        <div class="card" style="margin-bottom:20px"><div class="card-body" style="padding:16px">
          <div class="skeleton-line" style="width:120px;height:32px;border-radius:6px"></div>
        </div></div>
      `
      return
    }

    const gwRunning = info?.gatewayRunning
    const port = info?.gatewayPort || 8642
    const version = info?.version || '-'
    const modelName = formModel || hermesConfig?.model || health?.model || info?.model || ''
    const displayModel = modelName || t('engine.dashNoModel')

    // 服务商高亮匹配
    const activePreset = HERMES_PROVIDERS.find(p => formBaseUrl === p.baseUrl)

    // 模型下拉 HTML
    const dropdownHtml = showDropdown && models.length
      ? `<div id="hm-model-dropdown" style="position:absolute;top:100%;left:0;right:0;max-height:200px;overflow-y:auto;background:var(--bg-primary);border:1px solid var(--border-primary);border-radius:6px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.15)">${models.map(m =>
          `<div class="hm-model-opt" data-model="${esc(m)}" style="padding:5px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border-primary);${m === formModel ? 'font-weight:600;color:var(--accent)' : ''}">${esc(m)}</div>`
        ).join('')}</div>`
      : ''

    el.innerHTML = `
      <div class="page-header" style="display:flex;align-items:center;gap:12px">
        <h1 style="margin:0">${t('engine.hermesDashboardTitle')}</h1>
        <button class="btn-icon hm-dash-refresh" title="Refresh" style="opacity:0.5;cursor:pointer;background:none;border:none;padding:4px">${ICONS.refresh}</button>
      </div>

      <!-- 状态卡片行 -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px">
        <div class="card" style="border-left:4px solid ${gwRunning ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)'}">
          <div class="card-body" style="padding:16px">
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${t('engine.dashGatewayStatus')}</div>
            <div style="display:flex;align-items:center;gap:8px">
              ${gwRunning ? ICONS.running : ICONS.stopped}
              <span style="font-size:16px;font-weight:600">${gwRunning ? t('engine.dashRunning') : t('engine.dashStopped')}</span>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-body" style="padding:16px">
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${t('engine.dashModel')}</div>
            <div style="font-size:14px;font-weight:600;word-break:break-all">${esc(displayModel)}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-body" style="padding:16px">
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${t('engine.dashVersion')}</div>
            <div style="font-size:14px;font-weight:600">${version}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-body" style="padding:16px">
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${t('engine.dashApiEndpoint')}</div>
            <div style="font-size:13px;font-weight:600;font-family:var(--font-mono, monospace)">http://127.0.0.1:${port}</div>
          </div>
        </div>
      </div>

      <!-- 模型配置区 -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:0">
          <div class="hm-cfg-toggle" style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;cursor:pointer;user-select:none">
            <h3 style="margin:0;font-size:15px">${t('engine.dashModelConfig')}</h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="transition:transform .2s;transform:rotate(${modelConfigCollapsed ? '0' : '180'}deg);opacity:0.5"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div style="${modelConfigCollapsed ? 'display:none' : 'padding:0 20px 20px'}">
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
              ${HERMES_PROVIDERS.map(p =>
                `<button class="btn btn-sm btn-secondary hm-preset-btn" data-key="${p.key}" data-url="${esc(p.baseUrl)}" data-api="${p.api || 'openai-completions'}" style="font-size:11px;padding:2px 8px;${activePreset?.key === p.key ? 'opacity:1;font-weight:600' : 'opacity:0.6'}">${p.label}</button>`
              ).join('')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
              <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">
                API Base URL
                <input type="text" id="hm-cfg-baseurl" class="input" value="${esc(formBaseUrl)}" placeholder="https://gpt.qt.cool/v1" style="font-size:13px">
              </label>
              <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">
                API Key
                <input type="password" id="hm-cfg-apikey" class="input" value="${esc(formApiKey)}" placeholder="sk-..." style="font-size:13px">
              </label>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:12px">
              <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">
                ${t('engine.configModel')}
                <div style="position:relative">
                  <input type="text" id="hm-cfg-model" class="input" value="${esc(formModel)}" placeholder="QC-B01" style="font-size:13px">
                  ${dropdownHtml}
                </div>
              </label>
              <button class="btn btn-sm btn-secondary hm-fetch-models" style="white-space:nowrap;flex-shrink:0" ${fetchBusy ? 'disabled' : ''}>${fetchBusy ? t('engine.configFetching') : t('engine.configFetchModels')}</button>
            </div>
            <div id="hm-cfg-msg" style="font-size:12px;min-height:16px;margin-bottom:8px">${cfgMsg}</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary btn-sm hm-save-model" ${modelBusy ? 'disabled' : ''}>${modelBusy ? '...' : t('engine.configSaveBtn')}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Gateway 控制 -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${!gwRunning ? `<button class="btn btn-primary btn-sm hm-dash-start" ${actionBusy ? 'disabled' : ''}>${actionBusy ? t('engine.gatewayStarting') : t('engine.dashStartGw')}</button>` : ''}
          ${gwRunning ? `<button class="btn btn-sm btn-secondary hm-dash-stop" ${actionBusy ? 'disabled' : ''}>${actionBusy ? t('engine.dashStopping') : t('engine.dashStopGw')}</button>` : ''}
          ${gwRunning ? `<button class="btn btn-sm btn-secondary hm-dash-restart" ${actionBusy ? 'disabled' : ''}>${actionBusy ? t('engine.dashRestarting') : t('engine.dashRestartGw')}</button>` : ''}
          <div id="hm-dash-msg" style="font-size:12px;margin-left:8px"></div>
        </div>
      </div>

      <!-- 连接目标 -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <h3 style="margin:0;font-size:15px">${t('engine.dashConnectTarget')}</h3>
            <button class="btn btn-sm btn-secondary hm-detect-env" ${envDetecting ? 'disabled' : ''} style="font-size:11px;padding:2px 10px">${envDetecting ? t('engine.dashDetecting') : t('engine.dashDetectEnv')}</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
            <button class="btn btn-sm hm-connect-mode ${connectMode === 'local' ? 'btn-primary' : 'btn-secondary'}" data-mode="local" style="font-size:11px;padding:2px 10px">
              🖥️ ${t('engine.dashConnLocal')}
            </button>
            ${envData?.wsl2?.available ? `<button class="btn btn-sm hm-connect-mode ${connectMode === 'wsl2' ? 'btn-primary' : 'btn-secondary'}" data-mode="wsl2" style="font-size:11px;padding:2px 10px">
              🐧 WSL2 ${envData.wsl2.gatewayRunning ? '✅' : envData.wsl2.hermesInstalled ? '⚠️' : ''}
            </button>` : ''}
            ${envData?.docker?.available ? `<button class="btn btn-sm hm-connect-mode ${connectMode === 'docker' ? 'btn-primary' : 'btn-secondary'}" data-mode="docker" style="font-size:11px;padding:2px 10px">
              🐋 Docker ${envData.docker.hermesContainers?.length ? '✅' : ''}
            </button>` : ''}
            <button class="btn btn-sm hm-connect-mode ${connectMode === 'custom' ? 'btn-primary' : 'btn-secondary'}" data-mode="custom" style="font-size:11px;padding:2px 10px">
              🌐 ${t('engine.dashConnCustom')}
            </button>
          </div>
          ${connectMode === 'wsl2' && envData?.wsl2 ? `
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
              <div>IP: <code>${esc(envData.wsl2.ip || '-')}</code> · Distros: ${(envData.wsl2.distros || []).join(', ')}</div>
              ${envData.wsl2.hermesInstalled ? `<div style="color:var(--success)">✓ Hermes ${esc(envData.wsl2.hermesInfo || '')}</div>` : '<div style="color:var(--warning)">Hermes 未安装</div>'}
              ${envData.wsl2.gatewayRunning ? `<div style="color:var(--success)">✓ Gateway: ${esc(envData.wsl2.gatewayUrl || '')}</div>` : '<div style="color:var(--text-tertiary)">Gateway 未运行</div>'}
            </div>
          ` : ''}
          ${connectMode === 'docker' && envData?.docker ? `
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
              <div>Docker ${esc(envData.docker.version || '')}</div>
              ${envData.docker.hermesContainers?.length ? envData.docker.hermesContainers.map(c =>
                `<div style="margin-top:4px">🔹 <code>${esc(c.name)}</code> (${esc(c.image)}) — ${esc(c.ports)}</div>`
              ).join('') : '<div style="color:var(--text-tertiary)">未发现 Hermes 容器</div>'}
            </div>
          ` : ''}
          ${connectMode === 'custom' ? `
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
              <input type="text" id="hm-custom-gw-url" class="input" value="${esc(customGwUrl)}" placeholder="http://192.168.1.100:8642" style="flex:1;font-size:13px">
            </div>
          ` : ''}
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-sm btn-primary hm-apply-connect" style="font-size:11px;padding:2px 12px">${t('engine.dashConnApply')}</button>
            <span id="hm-connect-msg" style="font-size:12px">${connectMsg}</span>
          </div>
        </div>
      </div>

      <!-- 快捷操作 -->
      <div style="margin-bottom:12px;font-size:14px;font-weight:600">${t('engine.dashQuickActions')}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px">
        <button class="card hm-dash-link" data-route="/h/chat" style="cursor:pointer;border:none;text-align:left">
          <div class="card-body" style="padding:16px;display:flex;align-items:center;gap:10px">
            ${ICONS.chat}
            <span style="font-size:14px;font-weight:500">${t('engine.dashOpenChat')}</span>
          </div>
        </button>
        <button class="card hm-dash-link" data-route="/h/setup" style="cursor:pointer;border:none;text-align:left">
          <div class="card-body" style="padding:16px;display:flex;align-items:center;gap:10px">
            ${ICONS.config}
            <span style="font-size:14px;font-weight:500">${t('engine.dashOpenSetup')}</span>
          </div>
        </button>
      </div>

      <!-- 终端命令 -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:20px">
          <h3 style="margin:0 0 4px;font-size:15px">${t('engine.dashCliTitle')}</h3>
          <p style="margin:0 0 14px;font-size:12px;color:var(--text-tertiary)">${t('engine.dashCliDesc')}</p>
          <div class="hm-cli-grid">
            ${renderCliCommands()}
          </div>
        </div>
      </div>
    `
    bind()
  }

  function bind() {
    el.querySelector('.hm-dash-refresh')?.addEventListener('click', refresh)
    // 模型配置折叠/展开
    el.querySelector('.hm-cfg-toggle')?.addEventListener('click', () => {
      syncFormFromDom()
      modelConfigCollapsed = !modelConfigCollapsed
      draw()
    })
    // Gateway actions
    el.querySelector('.hm-dash-start')?.addEventListener('click', async () => {
      actionBusy = true; draw()
      showGwMsg(t('engine.gatewayStarting'), false)
      try {
        const result = await api.hermesGatewayAction('start')
        showGwMsg(result || 'Gateway 已启动', false)
      } catch (e) {
        showGwMsg(String(e).replace(/^Error:\s*/, ''), true)
      }
      actionBusy = false; await refresh()
    })
    el.querySelector('.hm-dash-stop')?.addEventListener('click', async () => {
      actionBusy = true; draw()
      try { await api.hermesGatewayAction('stop') } catch (e) { showGwMsg(String(e).replace(/^Error:\s*/, ''), true) }
      actionBusy = false; await refresh()
    })
    el.querySelector('.hm-dash-restart')?.addEventListener('click', async () => {
      actionBusy = true; draw()
      try { await api.hermesGatewayAction('stop') } catch (_) { /* ignore stop failure on Windows */ }
      await new Promise(r => setTimeout(r, 1500))
      try {
        await api.hermesGatewayAction('start')
      } catch (e) { showGwMsg(String(e).replace(/^Error:\s*/, ''), true) }
      actionBusy = false; await refresh()
    })
    // Quick links
    el.querySelectorAll('.hm-dash-link').forEach(btn => {
      btn.addEventListener('click', () => { window.location.hash = '#' + btn.dataset.route })
    })
    // Provider presets — 点击填充 URL
    el.querySelectorAll('.hm-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        formBaseUrl = btn.dataset.url
        draw()
      })
    })
    // Fetch models — 通过 Rust 后端代理获取（避免 CORS）
    el.querySelector('.hm-fetch-models')?.addEventListener('click', doFetchModels)
    // Model dropdown click
    el.querySelectorAll('.hm-model-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        formModel = opt.dataset.model
        showDropdown = false
        draw()
      })
    })
    // 输入框聚焦时展开已获取的下拉
    el.querySelector('#hm-cfg-model')?.addEventListener('focus', () => {
      if (models.length) { showDropdown = true; syncFormFromDom(); draw() }
    })
    // 点击外部收起下拉
    el.addEventListener('click', (e) => {
      if (showDropdown && !e.target.closest('#hm-cfg-model') && !e.target.closest('#hm-model-dropdown') && !e.target.closest('.hm-fetch-models')) {
        showDropdown = false; syncFormFromDom(); draw()
      }
    })
    // Save model config
    el.querySelector('.hm-save-model')?.addEventListener('click', doSaveModel)
    // --- 连接目标 ---
    el.querySelector('.hm-detect-env')?.addEventListener('click', doDetectEnv)
    el.querySelectorAll('.hm-connect-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        connectMode = btn.dataset.mode
        // WSL2 选中时自动填充 URL
        if (connectMode === 'wsl2' && envData?.wsl2?.gatewayUrl) {
          customGwUrl = envData.wsl2.gatewayUrl
        }
        syncFormFromDom(); draw()
      })
    })
    el.querySelector('.hm-apply-connect')?.addEventListener('click', doApplyConnect)
    // CLI copy buttons
    el.querySelectorAll('.hm-cli-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.cmdIdx)
        const cmd = CLI_COMMANDS[idx]?.cmd
        if (!cmd) return
        navigator.clipboard.writeText(cmd).then(() => {
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--success, #22c55e)" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'
          setTimeout(() => {
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>'
          }, 1500)
        }).catch(() => {})
      })
    })
  }

  async function doFetchModels() {
    syncFormFromDom()
    if (!formBaseUrl) { cfgMsg = `<span style="color:var(--warning)">${t('engine.configFetchNeedUrl')}</span>`; draw(); return }
    if (!formApiKey) { cfgMsg = `<span style="color:var(--warning)">${t('engine.configFetchNeedKey')}</span>`; draw(); return }

    const matched = HERMES_PROVIDERS.find(p => formBaseUrl === p.baseUrl)
    const apiType = matched?.api || 'openai-completions'

    fetchBusy = true; cfgMsg = ''; draw()
    try {
      const fetchedModels = await api.hermesFetchModels(formBaseUrl, formApiKey, apiType)
      models = fetchedModels || []
      cfgMsg = `<span style="color:var(--success)">✓ ${t('engine.configFetchSuccess', { count: models.length })}</span>`
      showDropdown = models.length > 0
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      cfgMsg = `<span style="color:var(--error)">✗ ${msg}</span>`
    } finally {
      fetchBusy = false; draw()
    }
  }

  async function doSaveModel() {
    syncFormFromDom()
    if (!formApiKey) { cfgMsg = `<span style="color:var(--warning)">${t('engine.configFetchNeedKey')}</span>`; draw(); return }
    if (!formModel) { cfgMsg = `<span style="color:var(--warning)">请输入模型名</span>`; draw(); return }

    const matched = HERMES_PROVIDERS.find(p => formBaseUrl && p.baseUrl === formBaseUrl)
    const provider = matched?.key || 'custom'

    modelBusy = true; cfgMsg = ''; draw()
    try {
      await api.configureHermes(provider, formApiKey, formModel, formBaseUrl || null)
      cfgMsg = `<span style="color:var(--success)">✓ 配置已保存</span>`
      // 刷新后端状态（不覆盖 form）
      try { hermesConfig = await api.hermesReadConfig() } catch (_) {}
    } catch (e) {
      cfgMsg = `<span style="color:var(--error)">✗ ${String(e).replace(/^Error:\s*/, '')}</span>`
    } finally {
      modelBusy = false; draw()
    }
  }

  async function doDetectEnv() {
    envDetecting = true; draw()
    try {
      envData = await api.hermesDetectEnvironments()
    } catch (e) {
      connectMsg = `<span style="color:var(--error)">探测失败: ${String(e).replace(/^Error:\s*/, '')}</span>`
    }
    envDetecting = false; draw()
  }

  async function doApplyConnect() {
    let targetUrl = null
    if (connectMode === 'local') {
      targetUrl = null // 清除自定义，使用本地默认
    } else if (connectMode === 'wsl2') {
      targetUrl = envData?.wsl2?.gatewayUrl || null
      if (!targetUrl) {
        connectMsg = '<span style="color:var(--warning)">WSL2 Gateway 未运行，请先在 WSL 中启动</span>'
        draw(); return
      }
    } else if (connectMode === 'docker') {
      // Docker 模式暂时需要用户提供 URL
      const urlInput = el.querySelector('#hm-custom-gw-url')
      targetUrl = urlInput?.value?.trim() || null
      if (!targetUrl && envData?.docker?.hermesContainers?.length) {
        connectMsg = '<span style="color:var(--warning)">请切换到"自定义"模式并输入容器的 Gateway URL</span>'
        draw(); return
      }
    } else if (connectMode === 'custom') {
      const urlInput = el.querySelector('#hm-custom-gw-url')
      targetUrl = urlInput?.value?.trim() || null
      if (!targetUrl) {
        connectMsg = '<span style="color:var(--warning)">请输入 Gateway URL</span>'
        draw(); return
      }
    }

    try {
      const result = await api.hermesSetGatewayUrl(targetUrl)
      connectMsg = `<span style="color:var(--success)">✓ ${result}</span>`
      // 刷新状态
      await refresh()
    } catch (e) {
      connectMsg = `<span style="color:var(--error)">✗ ${String(e).replace(/^Error:\s*/, '')}</span>`
      draw()
    }
  }

  function showGwMsg(msg, isErr) {
    const msgEl = el.querySelector('#hm-dash-msg')
    if (msgEl) {
      msgEl.textContent = msg
      msgEl.style.color = isErr ? 'var(--error)' : 'var(--success)'
    }
  }

  async function refresh() {
    try {
      info = await api.checkHermes()
      if (info?.gatewayRunning) {
        try { health = await api.hermesHealthCheck() } catch (_) {}
      } else {
        health = null
      }
      try { hermesConfig = await api.hermesReadConfig() } catch (_) {}
    } catch (_) {}
    loading = false
    // 首次加载时用 hermesConfig 初始化表单
    if (!formInited && hermesConfig) {
      formBaseUrl = hermesConfig.base_url || ''
      formApiKey = hermesConfig.api_key || ''
      formModel = hermesConfig.model || ''
      formInited = true
    }
    draw()
  }

  // 初始加载
  refresh()

  // --- Guardian 事件监听：实时响应 Gateway 状态变化 ---
  let unlisteners = []
  let autoRefreshTimer = null

  async function setupListeners() {
    try {
      // 监听 Guardian 推送的状态变化
      const unlisten1 = await tauriListen('hermes-gateway-status', (evt) => {
        const data = evt.payload
        if (info) {
          const wasRunning = info.gatewayRunning
          info.gatewayRunning = !!data.running
          if (data.port) info.gatewayPort = data.port
          // 状态变化时刷新（不覆盖 form 表单）
          if (wasRunning !== info.gatewayRunning) {
            draw()
          }
        }
      })
      unlisteners.push(unlisten1)

      // 监听 Guardian 日志（显示在消息区）
      const unlisten2 = await tauriListen('hermes-guardian-log', (evt) => {
        showGwMsg(evt.payload || '', false)
      })
      unlisteners.push(unlisten2)
    } catch (_) {
      // Web 模式下无 Tauri 事件，静默忽略
    }

    // 定期自动刷新（15s），作为事件监听的补充
    autoRefreshTimer = setInterval(async () => {
      if (actionBusy || modelBusy) return
      try {
        const newInfo = await api.checkHermes()
        if (newInfo && info) {
          const changed = newInfo.gatewayRunning !== info.gatewayRunning
          info = newInfo
          if (changed) draw()
        }
      } catch (_) {}
    }, 15000)
  }
  setupListeners()

  // 页面卸载时清理
  const cleanup = () => {
    unlisteners.forEach(fn => fn())
    unlisteners = []
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null }
  }
  // MutationObserver 检测元素从 DOM 移除
  const detachObserver = new MutationObserver(() => {
    if (!el.isConnected) { cleanup(); detachObserver.disconnect() }
  })
  requestAnimationFrame(() => {
    if (el.parentNode) detachObserver.observe(el.parentNode, { childList: true })
  })

  return el
}
