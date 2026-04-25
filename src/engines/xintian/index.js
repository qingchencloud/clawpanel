/**
 * 心甜Claw 引擎（产品宣传入口）
 * ------------------------------------------------------------------
 * 这不是一个本地引擎，而是「心甜Claw」产品的一个产品落地页入口：
 *   - 桌面客户端 + SaaS 后端，Windows 安装即用
 *   - ClawPanel 里只承载宣传 + 跳转下载
 *
 * 因此它的 detect/boot/cleanup 都是 no-op，永远 ready，
 * 也不与任何 Gateway / 本地进程打交道。
 */
import { t } from '../../lib/i18n.js'

// 心甜 LOGO · 采用 xintian-claw 桌面端同款六边形品牌图标
// 直接用 <img> 引用 public/ 下的 PNG，避免 SVG 的 gradient id 冲突问题
const XINTIAN_ICON = `<img src="/images/xintian/logo-icon-64.png" srcset="/images/xintian/logo-icon-64.png 1x, /images/xintian/logo-icon-128.png 2x" alt="Xintian" width="16" height="16" style="display:block;object-fit:contain;">`

let _listeners = []

export default {
  id: 'xintian',
  name: '心甜Claw',
  description: 'Xintian Claw · Worry-free AI Companion for Windows',
  icon: XINTIAN_ICON,

  async detect() {
    // 不依赖任何本地进程，永远「ready」
    return { installed: true, ready: true }
  },

  async boot() {
    // 无副作用启动
  },

  cleanup() {
    // 无副作用清理
  },

  getNavItems() {
    return [{
      section: '',
      items: [
        { route: '/x/landing', label: t('engine.xintianNavHome'), icon: 'assistant' },
      ],
    }, {
      section: '',
      items: [
        { route: '/about', label: t('sidebar.about'), icon: 'about' },
      ],
    }]
  },

  getRoutes() {
    return [
      { path: '/x/landing', loader: () => import('./pages/landing.js') },
      // 只暴露 /about；/settings 对心甜Claw 用户无意义，故不注册。
      // 切回 OpenClaw / Hermes 后会重新获得面板设置入口。
      { path: '/about', loader: () => import('../../pages/about.js') },
    ]
  },

  getSetupRoute() { return '/x/landing' },
  getDefaultRoute() { return '/x/landing' },

  isReady() { return true },
  isGatewayRunning() { return false },
  isGatewayForeign() { return false },

  onStateChange(fn) {
    _listeners.push(fn)
    return () => { _listeners = _listeners.filter(cb => cb !== fn) }
  },
  onReadyChange(fn) {
    _listeners.push(fn)
    return () => { _listeners = _listeners.filter(cb => cb !== fn) }
  },

  isFeatureAvailable() { return true },
}
