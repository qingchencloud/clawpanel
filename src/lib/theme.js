/**
 * 主题管理（日间/夜间模式）
 *
 * 桌面端：除了切换 `<html data-theme>`，还会同步 Tauri 原生窗口标题栏的
 * 主题（Windows 下通过 DwmSetWindowAttribute 切 immersive dark mode），
 * 避免夜间模式下出现"应用黑、窗口栏白"的割裂观感。Web 端该步骤会安静跳过。
 */
import { isTauriRuntime } from './tauri-api.js'

const THEME_KEY = 'clawpanel-theme'

// 延迟加载 Tauri window 模块，Web 构建不会真正拉取
let _tauriWindowModule = null
async function getTauriCurrentWindow() {
  if (!isTauriRuntime()) return null
  if (_tauriWindowModule === false) return null
  if (!_tauriWindowModule) {
    try {
      _tauriWindowModule = await import('@tauri-apps/api/window')
    } catch (_) {
      _tauriWindowModule = false
      return null
    }
  }
  try {
    return _tauriWindowModule.getCurrentWindow()
  } catch (_) {
    return null
  }
}

async function syncTauriTitleBar(theme) {
  const win = await getTauriCurrentWindow()
  if (!win || typeof win.setTheme !== 'function') return
  try {
    // Tauri v2: 接受 'light' | 'dark' | null（null = 跟随系统）
    await win.setTheme(theme === 'dark' ? 'dark' : 'light')
  } catch (_) {
    // 某些 WebView2 版本或未授权时会抛错，静默忽略
  }
}

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  applyTheme(theme)
}

export function toggleTheme(onApply) {
  const html = document.documentElement
  const current = html.dataset.theme || 'light'
  const next = current === 'dark' ? 'light' : 'dark'

  // 设置扩散起点：白切黑从左下角，黑切白从右上角
  const toDark = next === 'dark'
  html.style.setProperty('--theme-reveal-x', toDark ? '0%' : '100%')
  html.style.setProperty('--theme-reveal-y', toDark ? '100%' : '0%')

  const doApply = () => {
    applyTheme(next)
    if (onApply) onApply(next)
  }

  if (document.startViewTransition) {
    document.startViewTransition(doApply)
  } else {
    doApply()
  }
  return next
}

export function getTheme() {
  return document.documentElement.dataset.theme || 'light'
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(THEME_KEY, theme)
  // Fire-and-forget，不等待 Tauri IPC 返回，避免阻塞 DOM 更新和过渡动画
  syncTauriTitleBar(theme)
}
