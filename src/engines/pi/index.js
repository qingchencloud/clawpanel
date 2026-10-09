/** Pi 实验引擎：不启动或复用 OpenClaw Gateway。 */
import { api } from '../../lib/tauri-api.js'
import { t } from '../../lib/i18n.js'

let ready = false
let running = false
let listeners = []
async function detect() {
  const status = await api.piStatus().catch(() => ({}))
  ready = Boolean(status.installed && status.nodeSupported)
  running = Boolean(status.running)
  for (const listener of listeners) listener({ ready, running })
  return { installed: Boolean(status.installed), ready }
}
const listen = listener => { listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener) } }

export default {
  id: 'pi', name: 'Pi', description: 'Pi Coding Agent · Experimental',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M9 6v12M16 6v10q0 3 3 2"/></svg>',
  detect, boot: detect, cleanup() {},
  getNavItems: () => [{ section: t('sidebar.sectionMonitor'), items: [
    { route: '/pi/dashboard', label: t('pi.dashboard'), icon: 'dashboard' },
    { route: '/pi/workspace', label: t('pi.workspace'), icon: 'chat' },
  ] }, { section: '', items: [
    { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
    { route: '/about', label: t('sidebar.about'), icon: 'about' },
  ] }],
  getRoutes: () => [
    { path: '/pi/dashboard', loader: () => import('./pages/dashboard.js') },
    { path: '/pi/workspace', loader: () => import('./pages/workspace.js') },
    { path: '/settings', loader: () => import('../../pages/settings.js') },
    { path: '/about', loader: () => import('../../pages/about.js') },
  ],
  getSetupRoute: () => '/pi/dashboard', getDefaultRoute: () => '/pi/dashboard',
  isReady: () => ready, isGatewayRunning: () => running, isGatewayForeign: () => false,
  onStateChange: listen, onReadyChange: listen, isFeatureAvailable: () => true,
}
