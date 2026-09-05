/** DeepSeek Harness 引擎入口。 */
import { t } from '../../lib/i18n.js'
import { api, invalidate } from '../../lib/tauri-api.js'
import { getDshPort } from '../../lib/model-channels.js'

let _ready = false
let _running = false
let _listeners = []
let _pollTimer = null

async function detectStatus() {
  try {
    invalidate('dsh_status')
    const status = await api.dshStatus(getDshPort())
    _ready = Boolean(status?.installed)
    _running = Boolean(status?.running)
  } catch {
    _ready = false
    _running = false
  }
  const snapshot = { ready: _ready, running: _running }
  _listeners.forEach(listener => { try { listener(snapshot) } catch {} })
  return snapshot
}

function startPoll() {
  if (_pollTimer) return
  _pollTimer = setInterval(detectStatus, 15000)
}

function stopPoll() {
  if (_pollTimer) clearInterval(_pollTimer)
  _pollTimer = null
}

export default {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  description: 'DeepSeek Agent Harness · Local Web Runtime',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4 5h16v14H4z"/><path d="M8 9l3 3-3 3"/><path d="M13 15h3"/></svg>',

  async detect() {
    const status = await detectStatus()
    return { installed: status.ready, ready: status.ready }
  },

  async boot() {
    await detectStatus()
    startPoll()
  },

  cleanup() { stopPoll() },

  getNavItems() {
    return [{
      section: t('sidebar.sectionMonitor'),
      items: [
        { route: '/dsh/dashboard', label: t('deepseekHarness.dashboard'), icon: 'dashboard' },
        { route: '/dsh/workspace', label: t('deepseekHarness.workspace'), icon: 'chat' },
      ],
    }, {
      section: '',
      items: [
        { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
        { route: '/about', label: t('sidebar.about'), icon: 'about' },
      ],
    }]
  },

  getRoutes() {
    return [
      { path: '/dsh/dashboard', loader: () => import('./pages/dashboard.js') },
      { path: '/dsh/workspace', loader: () => import('./pages/workspace.js') },
      { path: '/settings', loader: () => import('../../pages/settings.js') },
      { path: '/about', loader: () => import('../../pages/about.js') },
    ]
  },

  getSetupRoute() { return '/dsh/dashboard' },
  getDefaultRoute() { return '/dsh/dashboard' },
  isReady() { return _ready },
  isGatewayRunning() { return _running },
  isGatewayForeign() { return false },
  onStateChange(listener) {
    _listeners.push(listener)
    return () => { _listeners = _listeners.filter(value => value !== listener) }
  },
  onReadyChange(listener) {
    _listeners.push(listener)
    return () => { _listeners = _listeners.filter(value => value !== listener) }
  },
  isFeatureAvailable() { return true },
}
