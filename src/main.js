/**
 * ClawPanel 入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute } from './router.js'
import { renderSidebar, openMobileSidebar } from './components/sidebar.js'
import { initTheme } from './lib/theme.js'
import { detectOpenclawStatus, isOpenclawReady, isUpgrading, isGatewayRunning, onGatewayChange, startGatewayPoll, onGuardianGiveUp, resetAutoRestart, loadActiveInstance, getActiveInstance, onInstanceChange } from './lib/app-state.js'
import { wsClient } from './lib/ws-client.js'
import { api, checkBackendHealth, isBackendOnline, onBackendStatusChange } from './lib/tauri-api.js'
import { version as APP_VERSION } from '../package.json'
import { statusIcon } from './lib/icons.js'
import { tryShowEngagement } from './components/engagement.js'

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

// 初始化主题
initTheme()

// === 访问密码保护（Web + 桌面端通用） ===
const isTauri = !!window.__TAURI_INTERNALS__
let _forceSetup = false
let _skipSetup = false


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
      <div class="login-title" style="color:var(--error,#ef4444)">后端未启动</div>
      <div class="login-desc" style="line-height:1.8">
        ClawPanel 后端服务未运行，无法获取真实数据。<br>
        <span style="font-size:12px;color:var(--text-tertiary)">请在服务器上启动后端服务后刷新页面。</span>
      </div>
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># 开发模式</div>
        npm run dev<br>
        <div style="color:var(--text-tertiary);margin-top:8px;margin-bottom:4px"># 生产模式</div>
        npm run preview
      </div>
      <button class="login-btn" id="btn-backend-retry" style="margin-top:8px">
        <span id="backend-retry-text">重新检测</span>
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
    textEl.textContent = '检测中...'
    statusEl.textContent = ''

    const ok = await checkBackendHealth()
    if (ok) {
      statusEl.textContent = '后端已连接，正在加载...'
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); location.reload() }, 600)
    } else {
      statusEl.textContent = '后端仍未响应，请确认服务已启动'
      statusEl.style.color = 'var(--error,#ef4444)'
      textEl.textContent = '重新检测'
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
      statusEl.textContent = '后端已连接，正在加载...'
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
  overlay.innerHTML = `
    <div class="login-card">
      ${_logoSvg}
      <div class="login-title">ClawPanel</div>
      <div class="login-desc">${hasDefault
        ? '首次使用，默认密码已自动填充<br><span style="font-size:12px;color:#6366f1;font-weight:600">登录后请前往「安全设置」修改密码</span>'
        : (isTauri ? '应用已锁定，请输入密码' : '请输入访问密码')}</div>
      <form id="login-form">
        <input class="login-input" type="${hasDefault ? 'text' : 'password'}" id="login-pw" placeholder="访问密码" autocomplete="current-password" autofocus value="${hasDefault ? defaultPw : ''}" />
        <div id="login-captcha" style="display:${_captcha ? 'block' : 'none'};margin-bottom:10px">
          <div style="font-size:12px;color:#888;margin-bottom:6px">请先完成验证：<strong id="captcha-q" style="color:var(--text-primary,#333)">${_captcha ? _captcha.q : ''}</strong></div>
          <input class="login-input" type="number" id="login-captcha-input" placeholder="输入计算结果" style="text-align:center" />
        </div>
        <button class="login-btn" type="submit">登 录</button>
        <div class="login-error" id="login-error"></div>
      </form>
      ${!hasDefault ? `<details class="login-forgot" style="margin-top:16px;text-align:center">
        <summary style="font-size:11px;color:#aaa;cursor:pointer;list-style:none;user-select:none">忘记密码？</summary>
        <div style="margin-top:8px;font-size:11px;color:#888;line-height:1.8;text-align:left;background:rgba(0,0,0,.03);border-radius:8px;padding:10px 14px">
          ${isTauri
            ? '删除配置文件中的 <code style="background:rgba(99,102,241,.1);padding:1px 5px;border-radius:3px;font-size:10px">accessPassword</code> 字段即可重置：<br><code style="background:rgba(99,102,241,.1);padding:2px 6px;border-radius:3px;font-size:10px;word-break:break-all">~/.openclaw/clawpanel.json</code>'
            : '编辑服务器上的配置文件，删除 <code style="background:rgba(99,102,241,.1);padding:1px 5px;border-radius:3px;font-size:10px">accessPassword</code> 字段后重启服务：<br><code style="background:rgba(99,102,241,.1);padding:2px 6px;border-radius:3px;font-size:10px;word-break:break-all">~/.openclaw/clawpanel.json</code>'
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
      btn.textContent = '登录中...'
      errEl.textContent = ''
      // 验证码校验
      if (_captcha) {
        const captchaVal = parseInt(overlay.querySelector('#login-captcha-input')?.value)
        if (captchaVal !== _captcha.a) {
          errEl.textContent = '验证码错误'
          _captcha = _genCaptcha()
          const qEl = overlay.querySelector('#captcha-q')
          if (qEl) qEl.textContent = _captcha.q
          overlay.querySelector('#login-captcha-input').value = ''
          btn.disabled = false
          btn.textContent = '登 录'
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
            errEl.textContent = `密码错误${_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`}`
            btn.disabled = false
            btn.textContent = '登 录'
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
            errEl.textContent = (data.error || '登录失败') + (_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`)
            btn.disabled = false
            btn.textContent = '登 录'
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
        errEl.textContent = '网络错误: ' + (err.message || err)
        btn.disabled = false
        btn.textContent = '登 录'
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
  // 先注册所有路由，立即渲染 UI（不等后端检测）
  registerRoute('/dashboard', () => import('./pages/dashboard.js'))
  registerRoute('/chat', () => import('./pages/chat.js'))
  registerRoute('/chat-debug', () => import('./pages/chat-debug.js'))
  registerRoute('/services', () => import('./pages/services.js'))
  registerRoute('/logs', () => import('./pages/logs.js'))
  registerRoute('/models', () => import('./pages/models.js'))
  registerRoute('/agents', () => import('./pages/agents.js'))
  registerRoute('/gateway', () => import('./pages/gateway.js'))
  registerRoute('/memory', () => import('./pages/memory.js'))
  registerRoute('/skills', () => import('./pages/skills.js'))
  registerRoute('/security', () => import('./pages/security.js'))
  registerRoute('/about', () => import('./pages/about.js'))
  registerRoute('/assistant', () => import('./pages/assistant.js'))
  registerRoute('/setup', () => import('./pages/setup.js'))
  registerRoute('/channels', () => import('./pages/channels.js'))
  registerRoute('/cron', () => import('./pages/cron.js'))
  registerRoute('/usage', () => import('./pages/usage.js'))
  registerRoute('/communication', () => import('./pages/communication.js'))
  registerRoute('/settings', () => import('./pages/settings.js'))

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

  // 默认密码提醒横幅
  if (sessionStorage.getItem('clawpanel_must_change_pw') === '1') {
    const banner = document.createElement('div')
    banner.id = 'pw-change-banner'
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    banner.innerHTML = `
      <span>${statusIcon('warn', 14)} 当前使用的是系统生成的默认密码，为了安全请尽快修改</span>
      <a href="#/security" style="color:#fff;background:rgba(255,255,255,0.2);padding:4px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600" onclick="document.getElementById('pw-change-banner').remove();sessionStorage.removeItem('clawpanel_must_change_pw')">前往安全设置</a>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:16px;padding:0 4px;margin-left:4px">✕</button>
    `
    document.body.prepend(banner)
  }

  // Tauri 模式：确保 web session 存在（页面刷新后 cookie 可能丢失），然后加载实例和检测状态
  const ensureWebSession = isTauri
    ? api.readPanelConfig().then(cfg => {
        _forceSetup = cfg.forceSetup === true
        _skipSetup = cfg.skipSetup === true
        if (cfg.accessPassword) {
          return fetch('/__api/auth_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: cfg.accessPassword }),
          }).catch(() => {})
        }
      }).catch(() => {})
    : Promise.resolve()

  ensureWebSession.then(() => loadActiveInstance()).then(() => detectOpenclawStatus()).then(() => {
    // 重新渲染侧边栏（检测完成后 isOpenclawReady 状态已更新）
    renderSidebar(sidebar)
    if (_forceSetup || (!isOpenclawReady() && !_skipSetup)) {
      setDefaultRoute('/setup')
      navigate('/setup')
    } else {
      if (window.location.hash === '#/setup') navigate('/dashboard')
      setupGatewayBanner()
      startGatewayPoll()

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
      if (window.__TAURI_INTERNALS__) {
        import('@tauri-apps/api/event').then(async ({ listen }) => {
          await listen('guardian-event', (e) => {
            if (e.payload?.kind === 'give_up') showGuardianRecovery()
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

    // 全局监听后台任务完成/失败事件，自动刷新安装状态和侧边栏
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/event').then(async ({ listen }) => {
        const refreshAfterTask = async () => {
          // 清除 API 缓存，确保拿到最新状态
          const { invalidate } = await import('./lib/tauri-api.js')
          invalidate('check_installation', 'get_services_status', 'get_version_info')
          await detectOpenclawStatus()
          renderSidebar(sidebar)
          // 如果安装完成后变为就绪，跳转到仪表盘
          if (!_forceSetup && isOpenclawReady() && window.location.hash === '#/setup') {
            navigate('/dashboard')
          }
          // 如果卸载后变为未就绪，跳转到 setup
          if ((_forceSetup || (!isOpenclawReady() && !_skipSetup)) && !isUpgrading()) {
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

    let host
    const inst2 = getActiveInstance()
    if (inst2.type !== 'local' && inst2.endpoint) {
      try {
        const url = new URL(inst2.endpoint)
        host = `${url.hostname}:${inst2.gatewayPort || port}`
      } catch {
        host = window.__TAURI_INTERNALS__ ? `127.0.0.1:${port}` : location.host
      }
    } else {
      host = window.__TAURI_INTERNALS__ ? `127.0.0.1:${port}` : location.host
    }
    wsClient.connect(host, token)
    console.log(`[main] WebSocket 连接已启动 -> ${host}`)
  } catch (e) {
    console.error('[main] 自动连接 WebSocket 失败:', e)
  }
}

function setupGatewayBanner() {
  const banner = document.getElementById('gw-banner')
  if (!banner) return

  function update(running) {
    if (running || sessionStorage.getItem('gw-banner-dismissed')) {
      banner.classList.add('gw-banner-hidden')
      return
    } else {
      banner.classList.remove('gw-banner-hidden')
      banner.innerHTML = `
        <div class="gw-banner-content">
          <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
          <span>Gateway 未运行</span>
          <button class="btn btn-sm btn-primary" id="btn-gw-start" style="margin-left:auto">启动</button>
          <a class="btn btn-sm btn-ghost" href="#/services" style="color:inherit;font-size:12px">服务管理</a>
          <button class="gw-banner-close" id="btn-gw-dismiss" title="关闭提示">&times;</button>
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
        btn.textContent = '启动中...'
        try {
          await api.startService('ai.openclaw.gateway')
        } catch (err) {
          const errMsg = (err.message || String(err)).slice(0, 120)
          banner.innerHTML = `
            <div class="gw-banner-content" style="flex-wrap:wrap">
              <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
              <span>启动失败</span>
              <button class="btn btn-sm btn-primary" id="btn-gw-start" style="margin-left:auto">重试</button>
              <a class="btn btn-sm btn-ghost" href="#/services" style="color:inherit;font-size:12px">服务管理</a>
              <a class="btn btn-sm btn-ghost" href="#/logs" style="color:inherit;font-size:12px">查看日志</a>
            </div>
            <div style="font-size:11px;opacity:0.7;margin-top:4px;font-family:monospace;word-break:break-all">${errMsg}</div>
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
          btn.textContent = `启动中... ${sec}s`
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
            <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
            <span>启动超时，Gateway 可能仍在启动中</span>
            <button class="btn btn-sm btn-primary" id="btn-gw-start">重试</button>
            <a class="btn btn-sm btn-ghost" href="#/logs" style="color:inherit;text-decoration:underline">查看日志</a>
          </div>
          ${logHint}
        `
        update(false)
      })
    }
  }

  update(isGatewayRunning())
  onGatewayChange(update)
}

function showGuardianRecovery() {
  const banner = document.getElementById('gw-banner')
  if (!banner) return
  banner.classList.remove('gw-banner-hidden')
  banner.innerHTML = `
    <div class="gw-banner-content" style="flex-wrap:wrap;gap:8px">
      <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
      <span>Gateway 反复启动失败，可能配置有误</span>
      <button class="btn btn-sm btn-primary" id="btn-gw-recover-restart">重试启动</button>
      <button class="btn btn-sm btn-secondary" id="btn-gw-recover-backup">从备份恢复</button>
      <a class="btn btn-sm btn-ghost" href="#/services" style="color:inherit;text-decoration:underline">服务管理</a>
      <a class="btn btn-sm btn-ghost" href="#/logs" style="color:inherit;text-decoration:underline">查看日志</a>
    </div>
  `
  banner.querySelector('#btn-gw-recover-restart')?.addEventListener('click', async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = '启动中...'
    resetAutoRestart()
    try {
      await api.startService('ai.openclaw.gateway')
      btn.textContent = '已发送启动命令'
    } catch (err) {
      btn.textContent = '启动失败'
      btn.disabled = false
    }
  })
  banner.querySelector('#btn-gw-recover-backup')?.addEventListener('click', () => {
    navigate('/services')
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
    const dismissed = sessionStorage.getItem('clawpanel_update_dismissed')
    if (dismissed === ver) return

    const changelog = info.manifest?.changelog || ''
    const isWeb = !window.__TAURI_INTERNALS__

    banner.classList.remove('update-banner-hidden')
    banner.innerHTML = `
      <div class="update-banner-content">
        <div class="update-banner-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span class="update-banner-ver">ClawPanel v${ver} 可用</span>
          ${changelog ? `<span class="update-banner-changelog">· ${changelog}</span>` : ''}
        </div>
        ${isWeb
          ? `<button class="btn btn-sm" id="btn-update-show-cmd">更新方法</button>
             <a class="btn btn-sm" href="https://github.com/qingchencloud/clawpanel/releases" target="_blank" rel="noopener">Release Notes</a>`
          : `<button class="btn btn-sm" id="btn-update-hot">热更新</button>
             <a class="btn btn-sm" href="https://github.com/qingchencloud/clawpanel/releases" target="_blank" rel="noopener">完整安装包</a>`
        }
        <button class="update-banner-close" id="btn-update-dismiss" title="忽略此版本">✕</button>
      </div>
    `

    // 关闭按钮：记住忽略的版本
    banner.querySelector('#btn-update-dismiss')?.addEventListener('click', () => {
      sessionStorage.setItem('clawpanel_update_dismissed', ver)
      banner.classList.add('update-banner-hidden')
    })

    // Web 模式：显示更新命令弹窗
    banner.querySelector('#btn-update-show-cmd')?.addEventListener('click', () => {
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'
      overlay.innerHTML = `
        <div class="modal" style="max-width:480px">
          <div class="modal-title">更新到 v${ver}</div>
          <div style="font-size:var(--font-size-sm);line-height:1.8">
            <p style="margin-bottom:12px">在服务器上执行以下命令：</p>
            <pre style="background:var(--bg-tertiary);padding:12px 16px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:var(--font-size-xs);overflow-x:auto;white-space:pre-wrap;user-select:all">cd /opt/clawpanel
git pull origin main
npm install
npm run build
sudo systemctl restart clawpanel</pre>
            <p style="margin-top:12px;color:var(--text-tertiary);font-size:var(--font-size-xs)">
              如果 git pull 失败，可先执行 <code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px">git checkout -- .</code> 丢弃本地修改。<br>
              路径请替换为实际的 ClawPanel 安装目录。
            </p>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary btn-sm" data-action="close">关闭</button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
      overlay.querySelector('[data-action="close"]').onclick = () => overlay.remove()
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove() })
    })

    // Tauri 热更新按钮
    banner.querySelector('#btn-update-hot')?.addEventListener('click', async () => {
      const btn = banner.querySelector('#btn-update-hot')
      if (!btn) return
      btn.disabled = true
      btn.textContent = '下载中...'
      try {
        await api.downloadFrontendUpdate(info.manifest?.url || '', info.manifest?.hash || '')
        btn.textContent = '重载应用'
        btn.disabled = false
        btn.onclick = () => window.location.reload()
      } catch (e) {
        btn.textContent = '下载失败'
        btn.disabled = false
        const { toast } = await import('./components/toast.js')
        toast('更新下载失败: ' + (e.message || e), 'error')
      }
    })
  } catch {
    // 检查失败静默忽略
  }
}

function startUpdateChecker() {
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
  } catch (bootErr) {
    console.error('[main] boot() 失败:', bootErr)
    _hideSplash()
    const app = document.getElementById('app')
    if (app) app.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;color:#18181b">页面加载失败</div>
        <div style="font-size:13px;color:#71717a;max-width:400px;line-height:1.6;margin-bottom:16px">${String(bootErr?.message || bootErr).replace(/</g,'&lt;')}</div>
        <button onclick="location.reload()" style="padding:8px 20px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;cursor:pointer">刷新重试</button>
        <div style="margin-top:24px;font-size:11px;color:#a1a1aa">如果问题持续出现，请尝试重新安装 ClawPanel<br>或在 <a href="https://github.com/qingchencloud/clawpanel/issues" target="_blank" style="color:#6366f1">GitHub Issues</a> 反馈</div>
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
