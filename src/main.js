/**
 * ClawPanel 入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute } from './router.js'
import { renderSidebar } from './components/sidebar.js'
import { initTheme } from './lib/theme.js'
import { detectOpenclawStatus, isOpenclawReady, isGatewayRunning, onGatewayChange, startGatewayPoll, onGuardianGiveUp, resetAutoRestart } from './lib/app-state.js'
import { wsClient } from './lib/ws-client.js'
import { api } from './lib/tauri-api.js'

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

// 初始化主题
initTheme()

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
          <span class="gw-banner-icon">⚠</span>
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
              <span class="gw-banner-icon">⚠</span>
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
            <span class="gw-banner-icon">⚠</span>
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
      <span class="gw-banner-icon">🛠</span>
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

boot()
