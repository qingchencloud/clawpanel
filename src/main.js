/**
 * ClawPanel 入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute } from './router.js'
import { renderSidebar } from './components/sidebar.js'
import { initTheme } from './lib/theme.js'
import { detectOpenclawStatus, isOpenclawReady, isGatewayRunning, onGatewayChange, startGatewayPoll } from './lib/app-state.js'
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
  registerRoute('/about', () => import('./pages/about.js'))
  registerRoute('/setup', () => import('./pages/setup.js'))

  renderSidebar(sidebar)
  initRouter(content)

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
          wsClient.close()
        }
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

    if (!token) {
      console.warn('[main] Gateway token 未设置，跳过 WebSocket 连接')
      return
    }

    wsClient.connect(`ws://127.0.0.1:${port}/ws`, token)
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
        btn.textContent = '启动中...'
        try {
          await api.startService('ai.openclaw.gateway')
        } catch (err) {
          btn.textContent = '启动失败，重试'
          btn.disabled = false
        }
      })
    }
  }

  update(isGatewayRunning())
  onGatewayChange(update)
}

boot()
