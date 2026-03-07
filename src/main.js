/**
 * ClawPanel 入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute } from './router.js'
import { renderSidebar } from './components/sidebar.js'
import { initTheme } from './lib/theme.js'
import { detectOpenclawStatus, isOpenclawReady, isGatewayRunning, onGatewayChange, startGatewayPoll, onGuardianGiveUp, resetAutoRestart } from './lib/app-state.js'
import { wsClient } from './lib/ws-client.js'
import { api } from './lib/tauri-api.js'
import { version as APP_VERSION } from '../package.json'
import { statusIcon } from './lib/icons.js'

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

function showLoginOverlay(defaultPw) {
  const hasDefault = !!defaultPw
  const overlay = document.createElement('div')
  overlay.id = 'login-overlay'
  overlay.innerHTML = `
    <div class="login-card">
      ${_logoSvg}
      <div class="login-title">ClawPanel</div>
      <div class="login-desc">${hasDefault
        ? '首次使用，默认密码已自动填充<br><span style="font-size:12px;color:#6366f1;font-weight:600">登录后请前往「安全设置」修改密码</span>'
        : (isTauri ? '应用已锁定，请输入密码' : '请输入访问密码')}</div>
      <form id="login-form">
        <input class="login-input" type="${hasDefault ? 'text' : 'password'}" id="login-pw" placeholder="访问密码" autocomplete="current-password" autofocus value="${hasDefault ? defaultPw : ''}" />
        <button class="login-btn" type="submit">登 录</button>
        <div class="login-error" id="login-error"></div>
      </form>
      <div style="margin-top:20px;font-size:11px;color:#aaa;text-align:center">
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
      try {
        if (isTauri) {
          // 桌面端：本地比对密码
          const { api } = await import('./lib/tauri-api.js')
          const cfg = await api.readPanelConfig()
          if (pw !== cfg.accessPassword) {
            errEl.textContent = '密码错误'
            btn.disabled = false
            btn.textContent = '登 录'
            return
          }
          sessionStorage.setItem('clawpanel_authed', '1')
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
            errEl.textContent = data.error || '登录失败'
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
  registerRoute('/extensions', () => import('./pages/extensions.js'))
  registerRoute('/skills', () => import('./pages/skills.js'))
  registerRoute('/security', () => import('./pages/security.js'))
  registerRoute('/about', () => import('./pages/about.js'))
  registerRoute('/assistant', () => import('./pages/assistant.js'))
  registerRoute('/setup', () => import('./pages/setup.js'))

  renderSidebar(sidebar)
  initRouter(content)

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

  // 后台检测状态，检测完再决定是否跳转 setup
  detectOpenclawStatus().then(() => {
    // 重新渲染侧边栏（检测完成后 isOpenclawReady 状态已更新）
    renderSidebar(sidebar)
    if (!isOpenclawReady()) {
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
        } else {
          wsClient.disconnect()
        }
      })

      // 守护放弃时，弹出恢复选项
      onGuardianGiveUp(() => {
        showGuardianRecovery()
      })
    }
  })
}

async function autoConnectWebSocket() {
  try {
    console.log('[main] 自动连接 WebSocket...')
    const config = await api.readOpenclawConfig()
    const port = config?.gateway?.port || 18789
    const token = config?.gateway?.auth?.token || ''

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

    const host = window.__TAURI_INTERNALS__ ? `127.0.0.1:${port}` : location.host
    wsClient.connect(host, token)
    console.log('[main] WebSocket 连接已启动')
  } catch (e) {
    console.error('[main] 自动连接 WebSocket 失败:', e)
  }
}

function setupGatewayBanner() {
  const banner = document.getElementById('gw-banner')
  if (!banner) return

  function update(running) {
    if (running) {
      banner.classList.add('gw-banner-hidden')
    } else {
      banner.classList.remove('gw-banner-hidden')
      banner.innerHTML = `
        <div class="gw-banner-content">
          <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
          <span>Gateway 未启动，部分功能不可用</span>
          <button class="btn btn-sm btn-primary" id="btn-gw-start">启动 Gateway</button>
        </div>
      `
      banner.querySelector('#btn-gw-start')?.addEventListener('click', async (e) => {
        const btn = e.target
        btn.disabled = true
        btn.classList.add('btn-loading')
        btn.textContent = '启动中...'
        try {
          await api.startService('ai.openclaw.gateway')
        } catch (err) {
          const errMsg = err.message || String(err)
          banner.innerHTML = `
            <div class="gw-banner-content">
              <span class="gw-banner-icon">${statusIcon('warn', 16)}</span>
              <span>启动失败: ${errMsg}</span>
              <button class="btn btn-sm btn-primary" id="btn-gw-start">重试</button>
              <a class="btn btn-sm btn-ghost" href="#/logs" style="color:inherit;text-decoration:underline">查看日志</a>
            </div>
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

// 启动：先检查认证，再加载应用
;(async () => {
  const auth = await checkAuth()
  if (!auth.ok) await showLoginOverlay(auth.defaultPw)
  boot()

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
        lines.push(`- 版本: ${ver?.current || '?'} → ${ver?.latest || '?'}`)
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
