/**
 * ClawPanel 入口
 */

// 标记 JS 模块已加载（供 index.html 多阶段启动检测使用）
window._jsLoaded = true

import { registerRoute, initRouter, navigate, setDefaultRoute } from './router.js'
import { renderSidebar, openMobileSidebar } from './components/sidebar.js'
import { initTheme } from './lib/theme.js'
import { detectOpenclawStatus, isOpenclawReady, isUpgrading, isGatewayRunning, isGatewayForeign, onGatewayChange, startGatewayPoll, onGuardianGiveUp, resetAutoRestart, loadActiveInstance, getActiveInstance, onInstanceChange } from './lib/app-state.js'
import { wsClient } from './lib/ws-client.js'
import { api, checkBackendHealth, isBackendOnline, isTauriRuntime, onBackendStatusChange } from './lib/tauri-api.js'
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
import { statusIcon } from './lib/icons.js'
import { isForeignGatewayError, showGatewayConflictGuidance } from './lib/gateway-ownership.js'
import { tryShowEngagement } from './components/engagement.js'
import { toast } from './components/toast.js'
import { initI18n, t } from './lib/i18n.js'
import { initFeatureGates } from './lib/feature-gates.js'
import { onKernelChange } from './lib/kernel.js'
import { showFloorBlocker, hideFloorBlocker } from './components/floor-blocker.js'
import { registerEngine, initEngineManager, getActiveEngine, getActiveEngineId, needsInitialEngineChoice, isEngineSetupDeferred, adoptActiveEngineSelection, onEngineChange } from './lib/engine-manager.js'
import openclawEngine from './engines/openclaw/index.js'
import hermesEngine from './engines/hermes/index.js'
import xintianEngine from './engines/xintian/index.js'

// 样式
import './style/variables.css'
import './style/reset.css'
import './style/layout.css'
import './style/components.css'
import './style/pages.css'
import './style/chat.css'
import './style/agents.css'
import './style/debug.css'
import './style/assistant.css'
import './style/ai-drawer.css'
// 引擎专属样式（scope 到 [data-engine="<id>"] 子树，不影响其他引擎）
import './engines/hermes/style/hermes.css'
import './engines/xintian/style/xintian.css'

// 初始化主题 + 国际化
initTheme()
initI18n()

/** HTML 转义，防止 XSS 注入 */
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function openGatewayConflict(error = null) {
  const services = await api.getServicesStatus().catch(() => [])
  const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
  await showGatewayConflictGuidance({ error, service: gw })
}

// === 访问密码保护（Web + 桌面端通用） ===
const isTauri = isTauriRuntime()

async function checkAuth() {
  if (isTauri) {
    // 桌面端：读 clawpanel.json，检查密码配置
    try {
      const { api } = await import('./lib/tauri-api.js')
      const cfg = await api.readPanelConfig()
      if (!cfg.accessPassword) return { ok: true }
      if (sessionStorage.getItem('clawpanel_authed') === '1') return { ok: true }
      // 默认密码：直接传给登录页，避免二次读取
      const defaultPw = (cfg.mustChangePassword && cfg.accessPassword) ? cfg.accessPassword : null
      return { ok: false, defaultPw }
    } catch { return { ok: true } }
  }
  // Web 模式
  try {
    const resp = await fetch('/__api/auth_check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const data = await resp.json()
    if (!data.required || data.authenticated) return { ok: true }
    return { ok: false, defaultPw: data.defaultPassword || null }
  } catch { return { ok: true } }
}

const _logoSvg = `<svg class="login-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
  <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>
</svg>`

function _hideSplash() {
  const splash = document.getElementById('splash')
  if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 500) }
}

// === 后端离线检测（Web 模式） ===
let _backendRetryTimer = null

function showBackendDownOverlay() {
  if (document.getElementById('backend-down-overlay')) return
  _hideSplash()
  const overlay = document.createElement('div')
  overlay.id = 'backend-down-overlay'
  overlay.innerHTML = `
    <div class="login-card" style="text-align:center">
      ${_logoSvg}
      <div class="login-title" style="color:var(--error,#ef4444)">${t('common.backendDownTitle')}</div>
      <div class="login-desc" style="line-height:1.8">
        ${t('common.backendDownDesc')}<br>
        <span style="font-size:12px;color:var(--text-tertiary)">${t('common.backendDownHint')}</span>
      </div>
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># ${t('common.devMode')}</div>
        npm run dev<br>
        <div style="color:var(--text-tertiary);margin-top:8px;margin-bottom:4px"># ${t('common.prodMode')}</div>
        npm run preview
      </div>
      <button class="login-btn" id="btn-backend-retry" style="margin-top:8px">
        <span id="backend-retry-text">${t('common.checkAgain')}</span>
      </button>
      <div id="backend-retry-status" style="font-size:12px;color:var(--text-tertiary);margin-top:12px"></div>
      <div style="margin-top:16px;font-size:11px;color:#aaa">
        <a href="https://claw.qt.cool" target="_blank" rel="noopener" style="color:#aaa;text-decoration:none">claw.qt.cool</a>
        <span style="margin:0 6px">&middot;</span>v${APP_VERSION}
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  let retrying = false
  const btn = overlay.querySelector('#btn-backend-retry')
  const statusEl = overlay.querySelector('#backend-retry-status')
  const textEl = overlay.querySelector('#backend-retry-text')

  btn.addEventListener('click', async () => {
    if (retrying) return
    retrying = true
    btn.disabled = true
    textEl.textContent = t('common.checking')
    statusEl.textContent = ''

    const ok = await checkBackendHealth()
    if (ok) {
      statusEl.textContent = t('common.backendConnectedLoading')
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); location.reload() }, 600)
    } else {
      statusEl.textContent = t('common.backendStillDown')
      statusEl.style.color = 'var(--error,#ef4444)'
      textEl.textContent = t('common.checkAgain')
      btn.disabled = false
      retrying = false
    }
  })

  // 自动轮询：每 5 秒检测一次
  if (_backendRetryTimer) clearInterval(_backendRetryTimer)
  _backendRetryTimer = setInterval(async () => {
    const ok = await checkBackendHealth()
    if (ok) {
      clearInterval(_backendRetryTimer)
      _backendRetryTimer = null
      statusEl.textContent = t('common.backendConnectedLoading')
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); location.reload() }, 600)
    }
  }, 5000)
}

let _loginFailCount = 0
const CAPTCHA_THRESHOLD = 3

function _genCaptcha() {
  const a = Math.floor(Math.random() * 20) + 1
  const b = Math.floor(Math.random() * 20) + 1
  return { q: `${a} + ${b} = ?`, a: a + b }
}

function showLoginOverlay(defaultPw) {
  const hasDefault = !!defaultPw
  const overlay = document.createElement('div')
  overlay.id = 'login-overlay'
  let _captcha = _loginFailCount >= CAPTCHA_THRESHOLD ? _genCaptcha() : null
  const securityLabel = t('sidebar.security')
  const accessPasswordField = '<code style="background:rgba(99,102,241,.1);padding:1px 5px;border-radius:3px;font-size:10px">accessPassword</code>'
  const resetPath = '<code style="background:rgba(99,102,241,.1);padding:2px 6px;border-radius:3px;font-size:10px;word-break:break-all">~/.openclaw/clawpanel.json</code>'
  overlay.innerHTML = `
    <div class="login-card">
      ${_logoSvg}
      <div class="login-title">ClawPanel</div>
      <div class="login-desc">${hasDefault
        ? `${t('security.firstLoginHint')}<br><span style="font-size:12px;color:#6366f1;font-weight:600">${t('security.firstLoginChangeHint', { security: securityLabel })}</span>`
        : (isTauri ? t('security.appLocked') : t('security.loginPrompt'))}</div>
      <form id="login-form">
        <input class="login-input" type="${hasDefault ? 'text' : 'password'}" id="login-pw" placeholder="${t('security.accessPasswordPlaceholder')}" autocomplete="current-password" autofocus value="${hasDefault ? defaultPw : ''}" />
        <div id="login-captcha" style="display:${_captcha ? 'block' : 'none'};margin-bottom:10px">
          <div style="font-size:12px;color:#888;margin-bottom:6px">${t('security.captchaPrompt')}<strong id="captcha-q" style="color:var(--text-primary,#333)">${_captcha ? _captcha.q : ''}</strong></div>
          <input class="login-input" type="number" id="login-captcha-input" placeholder="${t('security.captchaPlaceholder')}" style="text-align:center" />
        </div>
        <button class="login-btn" type="submit">${t('security.loginAction')}</button>
        <div class="login-error" id="login-error"></div>
      </form>
      ${!hasDefault ? `<details class="login-forgot" style="margin-top:16px;text-align:center">
        <summary style="font-size:11px;color:#aaa;cursor:pointer;list-style:none;user-select:none">${t('security.forgotPassword')}</summary>
        <div style="margin-top:8px;font-size:11px;color:#888;line-height:1.8;text-align:left;background:rgba(0,0,0,.03);border-radius:8px;padding:10px 14px">
          ${isTauri
            ? `${t('security.resetPasswordLocal', { field: accessPasswordField })}<br>${resetPath}`
            : `${t('security.resetPasswordRemote', { field: accessPasswordField })}<br>${resetPath}`
          }
        </div>
      </details>` : ''}
      <div style="margin-top:${hasDefault ? '20' : '12'}px;font-size:11px;color:#aaa;text-align:center">
        <a href="https://claw.qt.cool" target="_blank" rel="noopener" style="color:#aaa;text-decoration:none">claw.qt.cool</a>
        <span style="margin:0 6px">·</span>v${APP_VERSION}
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  _hideSplash()

  return new Promise((resolve) => {
    overlay.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = overlay.querySelector('#login-pw').value
      const btn = overlay.querySelector('.login-btn')
      const errEl = overlay.querySelector('#login-error')
      btn.disabled = true
      btn.textContent = t('security.loginSubmitting')
      errEl.textContent = ''
      // 验证码校验
      if (_captcha) {
        const captchaVal = parseInt(overlay.querySelector('#login-captcha-input')?.value)
        if (captchaVal !== _captcha.a) {
          errEl.textContent = t('security.wrongCaptcha')
          _captcha = _genCaptcha()
          const qEl = overlay.querySelector('#captcha-q')
          if (qEl) qEl.textContent = _captcha.q
          overlay.querySelector('#login-captcha-input').value = ''
          btn.disabled = false
          btn.textContent = t('security.loginAction')
          return
        }
      }
      try {
        if (isTauri) {
          // 桌面端：本地比对密码
          const { api } = await import('./lib/tauri-api.js')
          const cfg = await api.readPanelConfig()
          if (pw !== cfg.accessPassword) {
            _loginFailCount++
            if (_loginFailCount >= CAPTCHA_THRESHOLD && !_captcha) {
              _captcha = _genCaptcha()
              const cEl = overlay.querySelector('#login-captcha')
              if (cEl) { cEl.style.display = 'block'; cEl.querySelector('#captcha-q').textContent = _captcha.q }
            }
            errEl.textContent = `${t('security.loginWrongPassword')}${_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`}`
            btn.disabled = false
            btn.textContent = t('security.loginAction')
            return
          }
          sessionStorage.setItem('clawpanel_authed', '1')
          // 同步建立 web session（WEB_ONLY_CMDS 需要 cookie 认证）
          try {
            await fetch('/__api/auth_login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: pw }),
            })
          } catch {}
          overlay.classList.add('hide')
          setTimeout(() => overlay.remove(), 400)
          if (cfg.accessPassword === '123456') {
            sessionStorage.setItem('clawpanel_must_change_pw', '1')
          }
          resolve()
        } else {
          // Web 模式：调后端
          const resp = await fetch('/__api/auth_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
          })
          const data = await resp.json()
          if (!resp.ok) {
            _loginFailCount++
            if (_loginFailCount >= CAPTCHA_THRESHOLD && !_captcha) {
              _captcha = _genCaptcha()
              const cEl = overlay.querySelector('#login-captcha')
              if (cEl) { cEl.style.display = 'block'; cEl.querySelector('#captcha-q').textContent = _captcha.q }
            }
            errEl.textContent = (data.error || t('security.loginFailed')) + (_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`)
            btn.disabled = false
            btn.textContent = t('security.loginAction')
            return
          }
          overlay.classList.add('hide')
          setTimeout(() => overlay.remove(), 400)
          if (data.mustChangePassword || data.defaultPassword === '123456') {
            sessionStorage.setItem('clawpanel_must_change_pw', '1')
          }
          resolve()
        }
      } catch (err) {
        errEl.textContent = `${t('common.networkError')}: ${err.message || err}`
        btn.disabled = false
        btn.textContent = t('security.loginAction')
      }
    })
  })
}

// 全局 401 拦截：API 返回 401 时弹出登录
window.__clawpanel_show_login = async function() {
  if (document.getElementById('login-overlay')) return
  await showLoginOverlay()
  location.reload()
}

const sidebar = document.getElementById('sidebar')
const content = document.getElementById('content')

async function boot() {
  // 注册引擎
  registerEngine(openclawEngine)
  registerEngine(hermesEngine)
  registerEngine(xintianEngine)
  registerRoute('/engine-select', () => import('./pages/engine-select.js'))

  // 初始化引擎管理器：读取 clawpanel.json 的 engineMode，注册对应路由
  await initEngineManager()

  // 用户尚未做过明确的引擎选择（无 engineSetupChoice）→ 立即把默认路由
  // 指向 /engine-select，避免初始化期间先闪到 /dashboard 或 /setup 再被
  // 后续逻辑弹回选择页。引擎就绪后会在下方自动 adopt 并跳到 dashboard。
  if (needsInitialEngineChoice() || isEngineSetupDeferred()) {
    setDefaultRoute('/engine-select')
  }

  // 订阅内核版本变化：低于硬地板时弹出全屏拦截，恢复后自动隐藏；
  // 同时刷新 sidebar 以反映 "内核可升级" 提示卡片状态。
  // 触发时机：Gateway 握手成功 / 重连后版本变化 / 引擎切换
  let _readonlyModeActive = false
  onKernelChange((snap) => {
    if (!snap?.version) {
      // 还未拿到版本，保持当前状态不变
      return
    }
    if (!snap.aboveFloor && !_readonlyModeActive) {
      console.warn(`[kernel] 检测到内核版本 ${snap.version} 低于 ${snap.engine} 硬地板 ${snap.floor}`)
      showFloorBlocker({
        currentVersion: snap.version,
        floor: snap.floor,
        target: snap.target,
        onIgnore: () => { _readonlyModeActive = true },
      })
    } else if (snap.aboveFloor) {
      hideFloorBlocker()
      _readonlyModeActive = false
    }
    // sidebar 卡片显隐依赖 snapshot，状态变化时刷新一次
    if (sidebar) {
      try { renderSidebar(sidebar) } catch (e) { console.warn('[main] kernel-change renderSidebar 失败', e) }
    }
  })

  renderSidebar(sidebar)
  initRouter(content)

  // 移动端顶栏（汉堡菜单 + 标题）
  const mainCol = document.getElementById('main-col')
  const topbar = document.createElement('div')
  topbar.className = 'mobile-topbar'
  topbar.id = 'mobile-topbar'
  topbar.innerHTML = `
    <button class="mobile-hamburger" id="btn-mobile-menu">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <span class="mobile-topbar-title">ClawPanel</span>
  `
  topbar.querySelector('.mobile-hamburger').addEventListener('click', openMobileSidebar)
  mainCol.prepend(topbar)

  // 隐藏启动加载屏
  const splash = document.getElementById('splash')
  if (splash) {
    splash.classList.add('hide')
    setTimeout(() => splash.remove(), 500)
  }

  // 启动 3 秒后提示 @homebridge/ciao cmd 弹窗问题（仅 Windows 受影响）
  // 只在桌面端跑——Web 模式下的 dev-api.js 桩会直接返回 affected:false
  setTimeout(async () => {
    try {
      const { checkAndWarnCiaoBug } = await import('./lib/ciao-bug-warning.js')
      checkAndWarnCiaoBug()
    } catch (err) {
      console.debug('[ciao-bug] module skipped:', err)
    }
  }, 3000)

  // 默认密码提醒横幅
  if (sessionStorage.getItem('clawpanel_must_change_pw') === '1') {
    const banner = document.createElement('div')
    banner.id = 'pw-change-banner'
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    banner.innerHTML = `
      <span>${statusIcon('warn', 14)} ${t('common.defaultPasswordBanner')}</span>
      <a href="#/security" style="color:#fff;background:rgba(255,255,255,0.2);padding:4px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600" onclick="document.getElementById('pw-change-banner').remove();sessionStorage.removeItem('clawpanel_must_change_pw')">${t('common.goSecurity')}</a>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:16px;padding:0 4px;margin-left:4px">✕</button>
    `
    document.body.prepend(banner)
  }

  // Tauri 模式：确保 web session 存在（页面刷新后 cookie 可能丢失），然后加载实例和检测状态
  const ensureWebSession = isTauri
    ? api.readPanelConfig().then(cfg => {
        if (cfg.accessPassword) {
          return fetch('/__api/auth_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: cfg.accessPassword }),
          }).catch(() => {})
        }
      }).catch(() => {})
    : Promise.resolve()

  // --- 引擎状态监听管理 ---
  let _engineStateUnsub = null
  let _engineReadyUnsub = null
  function bindEngineListeners(engine) {
    // 清理旧监听
    if (_engineStateUnsub) { _engineStateUnsub(); _engineStateUnsub = null }
    if (_engineReadyUnsub) { _engineReadyUnsub(); _engineReadyUnsub = null }
    // 注册新监听
    if (engine.onStateChange) {
      _engineStateUnsub = engine.onStateChange(() => renderSidebar(sidebar))
    }
    if (engine.onReadyChange) {
      _engineReadyUnsub = engine.onReadyChange(() => renderSidebar(sidebar))
    }
  }

  // 引擎切换时：重新绑定状态监听 + 刷新侧边栏
  onEngineChange((engine) => {
    bindEngineListeners(engine)
    renderSidebar(sidebar)
  })

  ensureWebSession.then(() => getActiveEngineId() === 'openclaw' ? loadActiveInstance() : Promise.resolve()).then(async () => {
    const engine = getActiveEngine()
    if (!engine) return

    // 立即显示骨架屏，避免 boot() 期间内容区空白
    if (!content.querySelector('.page')) {
      content.innerHTML = `<div class="page" style="padding:32px">
        <div class="skeleton-line" style="width:200px;height:28px;margin-bottom:24px"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px">
          ${[1,2,3].map(() => '<div class="card"><div class="card-body" style="padding:16px"><div class="skeleton-line" style="width:60%;height:12px;margin-bottom:10px"></div><div class="skeleton-line" style="width:80%;height:20px"></div></div></div>').join('')}
        </div>
        <div class="card"><div class="card-body" style="padding:20px"><div class="skeleton-line" style="width:40%;height:16px;margin-bottom:16px"></div><div class="skeleton-line" style="height:36px"></div></div></div>
      </div>`
    }

    // 引擎启动（检测安装状态 + 初始化轮询等）
    await engine.boot()

    // 重新渲染侧边栏（引擎检测完成后状态已更新）
    renderSidebar(sidebar)

    // 监听引擎状态变化（如 setup 完成后 ready 变为 true），自动刷新侧边栏
    bindEngineListeners(engine)

    if (needsInitialEngineChoice() && engine.isReady()) {
      await adoptActiveEngineSelection({ choice: 'auto-detected' })
      renderSidebar(sidebar)
    }

    if (needsInitialEngineChoice() && !engine.isReady()) {
      setDefaultRoute('/engine-select')
      navigate('/engine-select')
    } else if (isEngineSetupDeferred() && !engine.isReady()) {
      setDefaultRoute('/engine-select')
      const currentHash = window.location.hash.slice(1) || ''
      if (!currentHash || currentHash === engine.getSetupRoute()) {
        navigate('/engine-select')
      }
    } else if (!engine.isReady()) {
      setDefaultRoute(engine.getSetupRoute())
      navigate(engine.getSetupRoute())
    } else {
      const setupRoute = engine.getSetupRoute()
      const currentHash = window.location.hash.slice(1) || ''
      if (currentHash === setupRoute || !currentHash) {
        navigate(engine.getDefaultRoute())
      }

      // Gateway 横幅（所有引擎均注册，update() 内部按引擎判断显隐）
      setupGatewayBanner()

      // === OpenClaw 专属逻辑（WebSocket、Guardian 守护等） ===
      if (getActiveEngineId() === 'openclaw') {
        // 自动连接 WebSocket（如果 Gateway 正在运行）
        if (isGatewayRunning()) {
          autoConnectWebSocket()
        }

        // 监听 Gateway 状态变化，自动连接/断开 WebSocket
        onGatewayChange((running) => {
          if (running) {
            autoConnectWebSocket()
            // 正向时机：Gateway 启动成功，延迟弹社区引导
            setTimeout(tryShowEngagement, 5000)
          } else {
            wsClient.disconnect()
          }
        })

        // 守护放弃时，弹出恢复选项
        if (isTauriRuntime()) {
          import('@tauri-apps/api/event').then(async ({ listen }) => {
            await listen('guardian-event', (e) => {
              if (e.payload?.kind === 'give_up') showGuardianRecovery()
              else if (e.payload?.kind === 'auto_fix_start') toast(t('dashboard.fixing'), 'info')
              else if (e.payload?.kind === 'auto_fix_retry') toast(t('dashboard.fixDoneRestarting'), 'info')
              else if (e.payload?.kind === 'auto_fix_success') toast(t('dashboard.fixDoneRestarted'), 'success')
              else if (e.payload?.kind === 'auto_fix_failure') toast(String(e.payload?.message || t('dashboard.fixDoneRestartFail')).slice(0, 240), 'error')
            })
          }).catch(() => {})
          api.guardianStatus().then(status => {
            if (status?.giveUp) showGuardianRecovery()
          }).catch(() => {})
        } else {
          onGuardianGiveUp(() => {
            showGuardianRecovery()
          })
        }

        // 实例切换时，重连 WebSocket + 重新检测状态
        onInstanceChange(async () => {
          wsClient.disconnect()
          await detectOpenclawStatus()
          if (isGatewayRunning()) autoConnectWebSocket()
        })
      }
    }

    // 全局监听后台任务完成/失败事件，自动刷新安装状态和侧边栏（仅 OpenClaw）
    if (isTauriRuntime() && getActiveEngineId() === 'openclaw') {
      import('@tauri-apps/api/event').then(async ({ listen }) => {
        const refreshAfterTask = async () => {
          // 清除 API 缓存，确保拿到最新状态
          const { invalidate } = await import('./lib/tauri-api.js')
          invalidate('check_installation', 'get_services_status', 'get_version_info')
          await detectOpenclawStatus()
          renderSidebar(sidebar)
          // 如果安装完成后变为就绪，跳转到仪表盘
          if (isOpenclawReady() && window.location.hash === '#/setup') {
            navigate('/dashboard')
          }
          // 如果卸载后变为未就绪，跳转到 setup
          if (!isOpenclawReady() && !isUpgrading()) {
            setDefaultRoute('/setup')
            navigate('/setup')
          }
        }
        await listen('upgrade-done', refreshAfterTask)
        await listen('upgrade-error', refreshAfterTask)
      }).catch(() => {})
    }
  })
}

async function autoConnectWebSocket() {
  try {
    const inst = getActiveInstance()
    console.log(`[main] 自动连接 WebSocket (实例: ${inst.name})...`)
    const config = await api.readOpenclawConfig()
    const port = config?.gateway?.port || 18789
    const rawToken = config?.gateway?.auth?.token
    const token = (typeof rawToken === 'string') ? rawToken : ''
    const rawPassword = config?.gateway?.auth?.password
    const password = (typeof rawPassword === 'string') ? rawPassword : ''

    // 启动前先确保设备已配对 + allowedOrigins 已写入，无需用户手动操作
    let needReload = false
    try {
      const pairResult = await api.autoPairDevice()
      console.log('[main] 设备配对 + origins 已就绪:', pairResult)
      // 仅在配置实际变更时才需要 reload（dev-api 返回 {changed}，Tauri 返回字符串）
      if (typeof pairResult === 'object' && pairResult.changed) {
        needReload = true
      } else if (typeof pairResult === 'string' && pairResult !== '设备已配对') {
        needReload = true
      }
    } catch (pairErr) {
      console.warn('[main] autoPairDevice 失败（非致命）:', pairErr)
    }

    // 确保模型配置包含 vision 支持（input: ["text", "image"]）
    try {
      const patched = await api.patchModelVision()
      if (patched) {
        console.log('[main] 已为模型添加 vision 支持')
        needReload = true
      }
    } catch (visionErr) {
      console.warn('[main] patchModelVision 失败（非致命）:', visionErr)
    }

    // 统一 reload Gateway（配对 origins + vision patch 合并为一次 reload）
    if (needReload) {
      try {
        await api.reloadGateway()
        console.log('[main] Gateway 已重载')
      } catch (reloadErr) {
        console.warn('[main] reloadGateway 失败（非致命）:', reloadErr)
      }
    }

    // TCP 端口就绪探测：等待 Gateway 端口可达后再发起 WS 连接（仅 Tauri 桌面端）
    if (isTauriRuntime()) {
      const probeStart = Date.now()
      const probeTimeout = 20000
      let portReady = false
      while (Date.now() - probeStart < probeTimeout) {
        try {
          portReady = await api.probeGatewayPort()
          if (portReady) break
        } catch {}
        await new Promise(r => setTimeout(r, 2000))
      }
      if (!portReady) {
        console.warn(`[main] Gateway 端口 ${port} 在 ${probeTimeout / 1000}s 内未就绪，仍尝试连接`)
      }
    }

    let host
    const inst2 = getActiveInstance()
    if (inst2.type !== 'local' && inst2.endpoint) {
      try {
        const url = new URL(inst2.endpoint)
        host = `${url.hostname}:${inst2.gatewayPort || port}`
      } catch {
        host = isTauriRuntime() ? `127.0.0.1:${port}` : location.host
      }
    } else {
      host = isTauriRuntime() ? `127.0.0.1:${port}` : location.host
    }
    wsClient.connect(host, token, { password })
    console.log(`[main] WebSocket 连接已启动 -> ${host}${password ? ' (password mode)' : ''}`)
  } catch (e) {
    console.error('[main] 自动连接 WebSocket 失败:', e)
  }
}

function setupGatewayBanner() {
  const banner = document.getElementById('gw-banner')
  if (!banner) return

  function update(running, foreign) {
    // Hermes 模式不显示 OpenClaw Gateway 横幅
    if (getActiveEngineId() !== 'openclaw') {
      banner.classList.add('gw-banner-hidden')
      return
    }
    if (running || sessionStorage.getItem('gw-banner-dismissed')) {
      banner.classList.add('gw-banner-hidden')
      return
    }
    banner.classList.remove('gw-banner-hidden')

    if (foreign) {
      // Gateway 在运行但属于外部实例 —— 显示认领按钮
      banner.innerHTML = `
        <div class="gw-banner-content">
          <span class="gw-banner-icon">${statusIcon('warning', 16)}</span>
          <span>${t('dashboard.foreignGatewayBanner')}</span>
          <button class="btn btn-sm btn-secondary" id="btn-gw-claim" style="margin-left:auto">${t('dashboard.claimGateway')}</button>
          <a class="btn btn-sm btn-ghost" href="#/services">${t('sidebar.services')}</a>
          <button class="gw-banner-close" id="btn-gw-dismiss" title="${t('common.close')}">&times;</button>
        </div>
      `
      banner.querySelector('#btn-gw-dismiss')?.addEventListener('click', () => {
        banner.classList.add('gw-banner-hidden')
        sessionStorage.setItem('gw-banner-dismissed', '1')
      })
      banner.querySelector('#btn-gw-claim')?.addEventListener('click', async (e) => {
        const btn = e.target
        btn.disabled = true
        btn.textContent = t('common.processing')
        try {
          await api.claimGateway()
          // 认领后立刻刷新全局状态
          const { refreshGatewayStatus } = await import('./lib/app-state.js')
          await refreshGatewayStatus()
        } catch (err) {
          btn.disabled = false
          btn.textContent = t('dashboard.claimGateway')
          console.error('[banner] claim failed:', err)
        }
      })
      return
    }

    // Gateway 未运行 —— 显示启动按钮
    banner.innerHTML = `
      <div class="gw-banner-content">
        <span class="gw-banner-icon">${statusIcon('info', 16)}</span>
        <span>${t('dashboard.controlUINotRunning')}</span>
        <button class="btn btn-sm btn-secondary" id="btn-gw-start" style="margin-left:auto">${t('dashboard.startBtn')}</button>
        <a class="btn btn-sm btn-ghost" href="#/services">${t('sidebar.services')}</a>
        <button class="gw-banner-close" id="btn-gw-dismiss" title="${t('common.close')}">&times;</button>
      </div>
    `
    banner.querySelector('#btn-gw-dismiss')?.addEventListener('click', () => {
      banner.classList.add('gw-banner-hidden')
      sessionStorage.setItem('gw-banner-dismissed', '1')
    })
    banner.querySelector('#btn-gw-start')?.addEventListener('click', async (e) => {
        const btn = e.target
        btn.disabled = true
        btn.classList.add('btn-loading')
        btn.textContent = t('dashboard.starting')
        try {
          await api.startService('ai.openclaw.gateway')
        } catch (err) {
          if (isForeignGatewayError(err)) {
            await openGatewayConflict(err)
            update(false)
            return
          }
          const errMsg = (err.message || String(err)).slice(0, 120)
          banner.innerHTML = `
            <div class="gw-banner-content" style="flex-wrap:wrap">
              <span class="gw-banner-icon">${statusIcon('info', 16)}</span>
              <span>${t('dashboard.startFail')}</span>
              <button class="btn btn-sm btn-secondary" id="btn-gw-start" style="margin-left:auto">${t('dashboard.retry')}</button>
              <a class="btn btn-sm btn-ghost" href="#/services">${t('sidebar.services')}</a>
              <a class="btn btn-sm btn-ghost" href="#/logs">${t('sidebar.logs')}</a>
            </div>
            <div style="font-size:11px;opacity:0.7;margin-top:4px;font-family:monospace;word-break:break-all">${escapeHtml(errMsg)}</div>
          `
          update(false)
          return
        }
        // 轮询等待实际启动
        const t0 = Date.now()
        while (Date.now() - t0 < 30000) {
          try {
            const s = await api.getServicesStatus()
            const gw = s?.find?.(x => x.label === 'ai.openclaw.gateway') || s?.[0]
            if (gw?.running) { update(true); return }
          } catch {}
          const sec = Math.floor((Date.now() - t0) / 1000)
          btn.textContent = `${t('dashboard.starting')} ${sec}s`
          await new Promise(r => setTimeout(r, 1500))
        }
        // 超时后尝试获取日志帮助排查
        let logHint = ''
        try {
          const logs = await api.readLogTail('gateway', 5)
          if (logs?.trim()) logHint = `<div style="font-size:12px;margin-top:4px;opacity:0.8;font-family:monospace;white-space:pre-wrap">${logs.trim().split('\n').slice(-3).join('\n')}</div>`
        } catch {}
        banner.innerHTML = `
          <div class="gw-banner-content">
            <span class="gw-banner-icon">${statusIcon('info', 16)}</span>
            <span>${t('dashboard.startTimeout')}</span>
            <button class="btn btn-sm btn-secondary" id="btn-gw-start" style="margin-left:auto">${t('dashboard.retry')}</button>
            <a class="btn btn-sm btn-ghost" href="#/logs">${t('sidebar.logs')}</a>
          </div>
          ${logHint}
        `
        update(false)
      })
  }

  update(isGatewayRunning(), isGatewayForeign())
  onGatewayChange(update)
  // 引擎切换时刷新横幅（Hermes 模式隐藏，OpenClaw 模式按 Gateway 状态显示）
  onEngineChange(() => update(isGatewayRunning(), isGatewayForeign()))
}

function showGuardianRecovery() {
  const banner = document.getElementById('gw-banner')
  if (!banner) return
  banner.classList.remove('gw-banner-hidden')
  banner.innerHTML = `
    <div class="gw-banner-content" style="flex-wrap:wrap;gap:8px">
      <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
      <span>${t('dashboard.guardianFailed')}</span>
      <button class="btn btn-sm btn-primary" id="btn-gw-recover-fix" style="margin-left:auto">${t('dashboard.autoFix')}</button>
      <button class="btn btn-sm btn-secondary" id="btn-gw-recover-restart">${t('dashboard.retryStart')}</button>
      <a class="btn btn-sm btn-ghost" href="#/logs">${t('sidebar.logs')}</a>
    </div>
  `
  banner.querySelector('#btn-gw-recover-fix')?.addEventListener('click', async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = t('dashboard.fixing')
    // 弹出修复弹窗
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <div class="modal-title">${t('dashboard.fixModalTitle')}</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:12px">
          ${t('dashboard.fixModalDesc')}
        </div>
        <div id="fix-log" style="font-family:var(--font-mono);font-size:11px;background:var(--bg-tertiary);padding:12px;border-radius:var(--radius-md);max-height:300px;overflow-y:auto;white-space:pre-wrap;line-height:1.6;color:var(--text-secondary)">${t('dashboard.fixRunning')}\n</div>
        <div id="fix-status" style="margin-top:12px;font-size:var(--font-size-sm);font-weight:600"></div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-secondary btn-sm" id="fix-close" style="display:none">${t('common.close')}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const logEl = overlay.querySelector('#fix-log')
    const statusEl = overlay.querySelector('#fix-status')
    const closeBtn = overlay.querySelector('#fix-close')
    closeBtn.onclick = () => overlay.remove()

    try {
      const result = await api.doctorFix()
      const output = result?.stdout || result?.output || JSON.stringify(result, null, 2)
      logEl.textContent = output || t('dashboard.fixDoneNoOutput')
      logEl.scrollTop = logEl.scrollHeight
      if (result?.errors) {
        statusEl.innerHTML = `<span style="color:var(--warning)">${t('dashboard.fixDoneWarning')}${escapeHtml(String(result.errors).slice(0, 200))}</span>`
      } else {
        statusEl.innerHTML = `<span style="color:var(--success)">${t('dashboard.fixDoneRestarting')}</span>`
        resetAutoRestart()
        try {
          await api.startService('ai.openclaw.gateway')
          statusEl.innerHTML = `<span style="color:var(--success)">${t('dashboard.fixDoneRestarted')}</span>`
        } catch (err) {
          if (isForeignGatewayError(err)) await openGatewayConflict(err)
          statusEl.innerHTML = `<span style="color:var(--warning)">${t('dashboard.fixDoneRestartFail')}</span>`
        }
      }
    } catch (err) {
      logEl.textContent += '\n❌ ' + (err.message || String(err))
      statusEl.innerHTML = `<span style="color:var(--error)">${t('dashboard.fixFailed')}${escapeHtml(String(err.message || err).slice(0, 200))}</span>`
    }
    closeBtn.style.display = ''
    btn.textContent = t('dashboard.autoFix')
    btn.disabled = false
  })
  banner.querySelector('#btn-gw-recover-restart')?.addEventListener('click', async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = t('dashboard.fixing')
    resetAutoRestart()
    try {
      await api.startService('ai.openclaw.gateway')
      btn.textContent = t('dashboard.startSent')
    } catch (err) {
      if (isForeignGatewayError(err)) await openGatewayConflict(err)
      btn.textContent = t('dashboard.retryStart')
      btn.disabled = false
    }
  })
}

// === 全局版本更新检测 ===
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // 30 分钟
let _updateCheckTimer = null

async function checkGlobalUpdate() {
  const banner = document.getElementById('update-banner')
  if (!banner) return

  try {
    const info = await api.checkFrontendUpdate()
    if (!info.hasUpdate) return

    const ver = info.latestVersion || info.manifest?.version || ''
    if (!ver) return

    // 用户已忽略过该版本，不再打扰
    const dismissed = localStorage.getItem('clawpanel_update_dismissed')
    if (dismissed === ver) return

    const changelog = info.manifest?.changelog || ''
    const canHotUpdate = isTauriRuntime()
      && info.manifest?.downloadUrl
      && info.manifest?.hash

    banner.classList.remove('update-banner-hidden')
    banner.innerHTML = `
      <div class="update-banner-content">
        <div class="update-banner-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span class="update-banner-ver">${t('about.versionAvailable', { version: ver })}</span>
          ${changelog ? `<span class="update-banner-changelog">· ${changelog}</span>` : ''}
        </div>
        ${canHotUpdate ? `<button class="btn btn-sm btn-primary" id="btn-hot-update">${t('about.hotUpdateNow')}</button>` : ''}
        <a class="btn btn-sm" href="https://claw.qt.cool" target="_blank" rel="noopener">${t('about.downloadFromWebsite')}</a>
        <a class="btn btn-sm" href="https://github.com/qingchencloud/clawpanel/releases" target="_blank" rel="noopener">${t('about.downloadFromGitHub')}</a>
        <button class="update-banner-close" id="btn-update-dismiss" title="${t('about.dismissVersion')}">✕</button>
      </div>
    `

    // 关闭按钮：记住忽略的版本
    banner.querySelector('#btn-update-dismiss')?.addEventListener('click', () => {
      localStorage.setItem('clawpanel_update_dismissed', ver)
      banner.classList.add('update-banner-hidden')
    })

    // 热更新按钮
    const hotUpdateBtn = banner.querySelector('#btn-hot-update')
    if (hotUpdateBtn && canHotUpdate) {
      hotUpdateBtn.addEventListener('click', async () => {
        hotUpdateBtn.disabled = true
        hotUpdateBtn.textContent = t('about.hotUpdateDownloading')
        try {
          await api.downloadFrontendUpdate(
            info.manifest.downloadUrl,
            info.manifest.hash,
            ver
          )
          hotUpdateBtn.style.display = 'none'
          toast(t('about.hotUpdateDone'), 'success')
          // 在 banner 中插入重启按钮
          const rebootBtn = document.createElement('button')
          rebootBtn.className = 'btn btn-sm btn-primary'
          rebootBtn.textContent = t('about.restartApp')
          rebootBtn.onclick = () => api.relaunchApp().catch(() => {})
          banner.querySelector('.update-banner-text').after(rebootBtn)
        } catch (err) {
          hotUpdateBtn.disabled = false
          hotUpdateBtn.textContent = t('about.hotUpdateNow')
          toast(t('about.hotUpdateFailed') + ': ' + (err.message || err), 'error')
        }
      })
    }
  } catch {
    // 检查失败静默忽略
  }
}

function startUpdateChecker() {
  // Web 模式：浏览器每次刷新都拿最新前端，前端热更新无意义；跳过避免 404 噪音
  if (!isTauri) return
  // 启动后 5 秒检查一次
  setTimeout(checkGlobalUpdate, 5000)
  // 之后每 30 分钟检查一次
  _updateCheckTimer = setInterval(checkGlobalUpdate, UPDATE_CHECK_INTERVAL)
}

// 启动：先检查后端 → 认证 → 加载应用
;(async () => {
  // Web 模式：先检测后端是否在线（不在线则显示提示，不加载应用）
  if (!isTauri) {
    const backendOk = await checkBackendHealth()
    if (!backendOk) {
      showBackendDownOverlay()
      return
    }
  }

  const auth = await checkAuth()
  if (!auth.ok) await showLoginOverlay(auth.defaultPw)
  try {
    await boot()
    window._bootDone = true
  } catch (bootErr) {
    window._bootDone = true
    console.error('[main] boot() 失败:', bootErr)
    _hideSplash()
    const app = document.getElementById('app')
    if (app) app.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;color:#18181b">${t('common.pageLoadFailed')}</div>
        <div style="font-size:13px;color:#71717a;max-width:400px;line-height:1.6;margin-bottom:16px">${String(bootErr?.message || bootErr).replace(/</g,'&lt;')}</div>
        <button onclick="location.reload()" style="padding:8px 20px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;cursor:pointer">${t('common.reloadRetry')}</button>
        <div style="margin-top:24px;font-size:11px;color:#a1a1aa">${t('common.pageLoadFailedHint')}<br><a href="https://github.com/qingchencloud/clawpanel/issues" target="_blank" style="color:#6366f1">GitHub Issues</a></div>
      </div>`
  }
  startUpdateChecker()

  // 初始化全局 AI 助手浮动按钮（延迟加载，不阻塞启动）
  setTimeout(async () => {
    const { initAIFab, registerPageContext, openAIDrawerWithError } = await import('./components/ai-drawer.js')
    initAIFab()

    // 注册各页面上下文提供器
    registerPageContext('/chat-debug', async () => {
      const { isOpenclawReady, isGatewayRunning } = await import('./lib/app-state.js')
      const { wsClient } = await import('./lib/ws-client.js')
      const { api } = await import('./lib/tauri-api.js')
      const lines = ['## 系统诊断快照']
      lines.push(`- OpenClaw: ${isOpenclawReady() ? '就绪' : '未就绪'}`)
      lines.push(`- Gateway: ${isGatewayRunning() ? '运行中' : '未运行'}`)
      lines.push(`- WebSocket: ${wsClient.connected ? '已连接' : '未连接'}`)
      try {
        const node = await api.checkNode()
        lines.push(`- Node.js: ${node?.version || '未知'}`)
      } catch {}
      try {
        const ver = await api.getVersionInfo()
        lines.push(`- 版本: 当前 ${ver?.current || '?'} / 推荐 ${ver?.recommended || '?'} / 最新 ${ver?.latest || '?'}${ver?.ahead_of_recommended ? ' / 当前版本高于推荐版' : ''}`)
      } catch {}
      return { detail: lines.join('\n') }
    })

    registerPageContext('/services', async () => {
      const { isGatewayRunning } = await import('./lib/app-state.js')
      const { api } = await import('./lib/tauri-api.js')
      const lines = ['## 服务状态']
      lines.push(`- Gateway: ${isGatewayRunning() ? '运行中' : '未运行'}`)
      try {
        const svc = await api.getServicesStatus()
        if (svc?.[0]) {
          lines.push(`- CLI: ${svc[0].cli_installed ? '已安装' : '未安装'}`)
          lines.push(`- PID: ${svc[0].pid || '无'}`)
        }
      } catch {}
      return { detail: lines.join('\n') }
    })

    registerPageContext('/gateway', async () => {
      const { api } = await import('./lib/tauri-api.js')
      try {
        const config = await api.readOpenclawConfig()
        const gw = config?.gateway || {}
        const lines = ['## Gateway 配置']
        lines.push(`- 端口: ${gw.port || 18789}`)
        lines.push(`- 模式: ${gw.mode || 'local'}`)
        lines.push(`- Token: ${gw.auth?.token ? '已设置' : '未设置'}`)
        if (gw.controlUi?.allowedOrigins) lines.push(`- Origins: ${JSON.stringify(gw.controlUi.allowedOrigins)}`)
        return { detail: lines.join('\n') }
      } catch { return null }
    })

    registerPageContext('/setup', () => {
      return { detail: '用户正在进行 OpenClaw 初始安装，请帮助检查 Node.js 环境和网络状况' }
    })

    // 挂到全局，供安装/升级失败时调用
    window.__openAIDrawerWithError = openAIDrawerWithError
  }, 500)
})()
