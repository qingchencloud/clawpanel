/**
 * 侧边导航栏
 */
import { navigate, getCurrentRoute, reloadCurrentRoute } from '../router.js'
import { toggleTheme, getTheme } from '../lib/theme.js'
import { isOpenclawReady, getActiveInstance, switchInstance, onInstanceChange } from '../lib/app-state.js'
import { api } from '../lib/tauri-api.js'
import { toast } from './toast.js'
import { version as APP_VERSION } from '../../package.json'
import { t, getLang, setLang, getAvailableLangs } from '../lib/i18n.js'

function NAV_ITEMS_FULL() { return [
  {
    section: t('sidebar.sectionMonitor'),
    items: [
      { route: '/dashboard', label: t('sidebar.dashboard'), icon: 'dashboard' },
      { route: '/assistant', label: t('sidebar.assistant'), icon: 'assistant' },
      { route: '/chat', label: t('sidebar.chat'), icon: 'chat' },
      { route: '/services', label: t('sidebar.services'), icon: 'services' },
      { route: '/logs', label: t('sidebar.logs'), icon: 'logs' },
    ]
  },
  {
    section: t('sidebar.sectionConfig'),
    items: [
      { route: '/models', label: t('sidebar.models'), icon: 'models' },
      { route: '/agents', label: t('sidebar.agents'), icon: 'agents' },
      { route: '/gateway', label: t('sidebar.gateway'), icon: 'gateway' },
      { route: '/channels', label: t('sidebar.channels'), icon: 'channels' },
      { route: '/communication', label: t('sidebar.communication'), icon: 'settings' },
      { route: '/security', label: t('sidebar.security'), icon: 'security' },
    ]
  },
  {
    section: t('sidebar.sectionData'),
    items: [
      { route: '/memory', label: t('sidebar.memory'), icon: 'memory' },
      { route: '/cron', label: t('sidebar.cron'), icon: 'clock' },
      { route: '/usage', label: t('sidebar.usage'), icon: 'bar-chart' },
    ]
  },
  {
    section: t('sidebar.sectionExtension'),
    items: [
      { route: '/skills', label: t('sidebar.skills'), icon: 'skills' },
      { route: '/workflow', label: t('workflow.title'), icon: 'workflow' },
    ]
  },
  {
    section: '',
    items: [
      { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
      { route: '/chat-debug', label: t('sidebar.chatDebug'), icon: 'debug' },
      { route: '/about', label: t('sidebar.about'), icon: 'about' },
    ]
  }
] }

function NAV_ITEMS_SETUP() { return [
  {
    section: '',
    items: [
      { route: '/setup', label: t('sidebar.setup'), icon: 'setup' },
      { route: '/assistant', label: t('sidebar.assistant'), icon: 'assistant' },
    ]
  },
  {
    section: '',
    items: [
      { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
      { route: '/chat-debug', label: t('sidebar.chatDebug'), icon: 'debug' },
      { route: '/about', label: t('sidebar.about'), icon: 'about' },
    ]
  }
] }

const ICONS = {
  setup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  services: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  models: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>',
  gateway: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>',
  extensions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/><path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>',
  security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  skills: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
  channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  'bar-chart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  debug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="7" height="7" rx="1"/><rect x="15" y="14" width="7" height="7" rx="1"/><path d="M9 6.5h6a2 2 0 012 2v5.5"/></svg>',
}

let _delegated = false
let _hasMultipleInstances = false

// 异步检测是否有多实例（首次渲染后触发，有多实例时重渲染）
function _checkMultiInstances(el) {
  api.instanceList().then(data => {
    const has = data.instances && data.instances.length > 1
    if (has !== _hasMultipleInstances) {
      _hasMultipleInstances = has
      renderSidebar(el)
    }
  }).catch(() => {})
}

const LS_SIDEBAR_COLLAPSED = 'clawpanel_sidebar_collapsed'

function _isDesktopSidebarCollapsed() {
  try { return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1' } catch { return false }
}

function _setDesktopSidebarCollapsed(collapsed) {
  try { localStorage.setItem(LS_SIDEBAR_COLLAPSED, collapsed ? '1' : '0') } catch {}
  const sidebar = document.getElementById('sidebar')
  if (sidebar) {
    sidebar.classList.toggle('sidebar-collapsed', !!collapsed)
  }
  const btn = document.getElementById('btn-sidebar-collapse')
  if (btn) btn.textContent = collapsed ? '»' : '«'
}

export function renderSidebar(el) {
  const current = getCurrentRoute()

  const inst = getActiveInstance()
  const isLocal = inst.type === 'local'
  const showSwitcher = !isLocal || _hasMultipleInstances

  const collapsed = _isDesktopSidebarCollapsed()
  let html = `
    <div class="sidebar-header">
      <div class="sidebar-logo">
        <img src="/images/logo.png" alt="ClawPanel">
      </div>
      <span class="sidebar-title">ClawPanel</span>
      <button class="sidebar-collapse-btn" id="btn-sidebar-collapse" title="${t('sidebar.collapse')}">${collapsed ? '»' : '«'}</button>
      <button class="sidebar-close-btn" id="btn-sidebar-close" title="${t('sidebar.closeMenu')}">&times;</button>
    </div>
    ${showSwitcher ? `<div class="instance-switcher" id="instance-switcher">
      <button class="instance-current" id="btn-instance-toggle">
        <span class="instance-dot ${isLocal ? 'local' : 'remote'}"></span>
        <span class="instance-label">${_escSidebar(inst.name)}</span>
        <svg class="instance-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="instance-dropdown" id="instance-dropdown"></div>
    </div>` : ''}
    <nav class="sidebar-nav">
  `

  const navItems = isOpenclawReady() ? NAV_ITEMS_FULL() : NAV_ITEMS_SETUP()

  for (const section of navItems) {
    html += `<div class="nav-section">
      <div class="nav-section-title">${section.section}</div>`

    for (const item of section.items) {
      const active = current === item.route ? ' active' : ''
      html += `<div class="nav-item${active}" data-route="${item.route}">
        ${ICONS[item.icon] || ''}
        <span>${item.label}</span>
      </div>`
    }
    html += '</div>'
  }

  html += '</nav>'

  // 主题切换按钮
  const isDark = getTheme() === 'dark'
  const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
  const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'

  const langCode = getLang()
  const langs = getAvailableLangs()
  const currentLang = langs.find(l => l.code === langCode) || langs[0]
  const globeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>'
  const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'

  const langOptions = langs.map(l => `
    <div class="lang-option${l.code === langCode ? ' active' : ''}" data-lang="${l.code}">
      <span class="lang-option-label">${l.label}</span>
      <span class="lang-option-code">${l.code}</span>
      ${l.code === langCode ? `<span class="lang-option-check">${checkIcon}</span>` : ''}
    </div>
  `).join('')

  html += `
    <div class="sidebar-footer">
      <div class="nav-item" id="btn-theme-toggle">
        ${isDark ? sunIcon : moonIcon}
        <span>${isDark ? t('sidebar.themeLight') : t('sidebar.themeDark')}</span>
      </div>
      <div class="lang-switcher" id="lang-switcher">
        <button class="nav-item lang-trigger" id="btn-lang-toggle">
          ${globeIcon}
          <span>${currentLang.label}</span>
          <svg class="lang-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <div class="lang-dropdown" id="lang-dropdown">
          ${langs.length > 4 ? '<div class="lang-search-wrap"><input class="lang-search" id="lang-search" type="text" placeholder="Search..." autocomplete="off"></div>' : ''}
          <div class="lang-options" id="lang-options">${langOptions}</div>
        </div>
      </div>
      <div class="sidebar-meta">
        <a href="https://claw.qt.cool" target="_blank" rel="noopener" class="sidebar-link">claw.qt.cool</a>
        <span class="sidebar-version">v${APP_VERSION}</span>
      </div>
    </div>
  `

  el.innerHTML = html

  // 应用折叠态（桌面端）
  _setDesktopSidebarCollapsed(collapsed)

  // 首次渲染时异步检测多实例
  if (!_delegated) _checkMultiInstances(el)

  // 事件委托：只绑定一次，避免重复绑定
  if (!_delegated) {
    _delegated = true
    el.addEventListener('click', (e) => {
      // 导航点击
      const navItem = e.target.closest('.nav-item[data-route]')
      if (navItem) {
        navigate(navItem.dataset.route)
        _closeMobileSidebar()
        return
      }
      // 移动端关闭按钮
      if (e.target.closest('#btn-sidebar-close')) {
        _closeMobileSidebar()
        return
      }
      // 侧边栏折叠
      const collapseBtn = e.target.closest('#btn-sidebar-collapse')
      if (collapseBtn) {
        _setDesktopSidebarCollapsed(!_isDesktopSidebarCollapsed())
        // 不需要整体重渲染
        return
      }
      // 主题切换
      const themeBtn = e.target.closest('#btn-theme-toggle')
      if (themeBtn) {
        toggleTheme(() => renderSidebar(el))
        return
      }
      // 语言切换器：打开/关闭下拉
      const langBtn = e.target.closest('#btn-lang-toggle')
      if (langBtn) {
        _toggleLangDropdown(el)
        return
      }
      // 语言选项点击
      const langOpt = e.target.closest('.lang-option[data-lang]')
      if (langOpt) {
        const code = langOpt.dataset.lang
        if (code !== getLang()) {
          setLang(code)
          renderSidebar(el)
          reloadCurrentRoute()
        } else {
          _closeLangDropdown()
        }
        return
      }
      // 实例切换器
      const toggleBtn = e.target.closest('#btn-instance-toggle')
      if (toggleBtn) {
        _toggleInstanceDropdown(el)
        return
      }
      // 选择实例
      const opt = e.target.closest('.instance-option[data-id]')
      if (opt) {
        const id = opt.dataset.id
        _closeInstanceDropdown()
        if (id !== getActiveInstance().id) {
          opt.style.opacity = '0.5'
          switchInstance(id).then(() => {
            const inst = getActiveInstance()
            const desc = inst.type === 'local' ? t('instance.local') : inst.name
            toast(t('instance.switchedTo', { name: desc }), 'success')
            renderSidebar(el)
            reloadCurrentRoute()
          })
        }
        return
      }
      // 添加实例
      const addBtn = e.target.closest('#btn-instance-add')
      if (addBtn) {
        _closeInstanceDropdown()
        _showAddInstanceDialog(el)
        return
      }
      // 点击其他区域关闭下拉
      if (!e.target.closest('.instance-switcher')) {
        _closeInstanceDropdown()
      }
      if (!e.target.closest('.lang-switcher')) {
        _closeLangDropdown()
      }
    })

    // 监听实例变化，刷新多实例标记后重新渲染
    onInstanceChange(() => { _checkMultiInstances(el); renderSidebar(el) })
  }
}

function _escSidebar(s) { return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// === 移动端侧边栏 ===
function _closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar')
  const overlay = document.getElementById('sidebar-overlay')
  if (sidebar) sidebar.classList.remove('sidebar-open')
  if (overlay) overlay.classList.remove('visible')
}

export function openMobileSidebar() {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return
  sidebar.classList.add('sidebar-open')
  let overlay = document.getElementById('sidebar-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'sidebar-overlay'
    overlay.className = 'sidebar-overlay'
    overlay.addEventListener('click', _closeMobileSidebar)
    document.getElementById('app').appendChild(overlay)
  }
  requestAnimationFrame(() => overlay.classList.add('visible'))
}

function _closeLangDropdown() {
  const sw = document.getElementById('lang-switcher')
  const dd = document.getElementById('lang-dropdown')
  if (dd) dd.classList.remove('open')
  if (sw) sw.classList.remove('open')
}

function _toggleLangDropdown(sidebarEl) {
  const sw = document.getElementById('lang-switcher')
  const dd = document.getElementById('lang-dropdown')
  if (!dd) return
  if (dd.classList.contains('open')) { dd.classList.remove('open'); if (sw) sw.classList.remove('open'); return }
  dd.classList.add('open')
  if (sw) sw.classList.add('open')
  const searchInput = dd.querySelector('#lang-search')
  if (searchInput) {
    searchInput.value = ''
    _filterLangOptions('')
    requestAnimationFrame(() => searchInput.focus())
    searchInput.oninput = () => _filterLangOptions(searchInput.value)
  }
}

function _filterLangOptions(query) {
  const opts = document.querySelectorAll('#lang-options .lang-option')
  const q = query.toLowerCase().trim()
  opts.forEach(opt => {
    if (!q) { opt.style.display = ''; return }
    const label = (opt.querySelector('.lang-option-label')?.textContent || '').toLowerCase()
    const code = (opt.querySelector('.lang-option-code')?.textContent || '').toLowerCase()
    opt.style.display = (label.includes(q) || code.includes(q)) ? '' : 'none'
  })
}

function _closeInstanceDropdown() {
  const dd = document.getElementById('instance-dropdown')
  if (dd) dd.classList.remove('open')
}

async function _toggleInstanceDropdown(sidebarEl) {
  const dd = document.getElementById('instance-dropdown')
  if (!dd) return
  if (dd.classList.contains('open')) { dd.classList.remove('open'); return }

  dd.innerHTML = `<div style="padding:8px;color:var(--text-tertiary);font-size:12px">${t('common.loading')}</div>`
  dd.classList.add('open')

  try {
    const [data, health] = await Promise.all([api.instanceList(), api.instanceHealthAll()])
    const healthMap = Object.fromEntries((health || []).map(h => [h.id, h]))
    const activeId = getActiveInstance().id
    let html = `<div class="instance-hint">${t('instance.switchHint')}</div>`
    for (const inst of data.instances) {
      const h = healthMap[inst.id] || {}
      const active = inst.id === activeId ? ' active' : ''
      const dot = h.online !== false ? 'online' : 'offline'
      const badge = inst.type === 'docker' ? `<span class="instance-badge docker">${t('instance.docker')}</span>` : inst.type === 'remote' ? `<span class="instance-badge remote">${t('instance.remote')}</span>` : ''
      const port = inst.endpoint ? inst.endpoint.match(/:(\d+)/)?.[1] : ''
      const portTag = port ? `<span class="instance-port">:${port}</span>` : ''
      html += `<div class="instance-option${active}" data-id="${inst.id}">
        <span class="instance-dot ${dot}"></span>
        <span class="instance-opt-name">${_escSidebar(inst.name)}</span>
        ${portTag}
        ${badge}
        ${active ? `<span class="instance-active-tag">${t('instance.current')}</span>` : ''}
      </div>`
    }
    html += '<div class="instance-divider"></div>'
    html += `<div class="instance-option instance-add" id="btn-instance-add">+ ${t('instance.addInstance')}</div>`
    dd.innerHTML = html
  } catch (e) {
    dd.innerHTML = `<div style="padding:8px;color:var(--error);font-size:12px">${_escSidebar(e.message)}</div>`
  }
}

async function _showAddInstanceDialog(sidebarEl) {
  const overlay = document.createElement('div')
  overlay.className = 'docker-dialog-overlay'
  overlay.innerHTML = `
    <div class="docker-dialog">
      <div class="docker-dialog-title">${t('instance.addRemote')}</div>
      <div class="form-group" style="margin-bottom:var(--space-md)">
        <label class="form-label">${t('instance.nameLabel')}</label>
        <input class="form-input" id="inst-name" placeholder="${t('instance.namePlaceholder')}" />
      </div>
      <div class="form-group" style="margin-bottom:var(--space-md)">
        <label class="form-label">${t('instance.endpointLabel')}</label>
        <input class="form-input" id="inst-endpoint" placeholder="http://192.168.1.100:1420" />
      </div>
      <div class="form-group" style="margin-bottom:var(--space-md)">
        <label class="form-label">${t('instance.gwPortLabel')}</label>
        <input class="form-input" id="inst-gw-port" type="number" value="18789" />
      </div>
      <div class="docker-dialog-hint">
        ${t('instance.remoteHint')}<br/>
        ${t('instance.example')}: <code>http://192.168.1.100:1420</code>
      </div>
      <div id="inst-add-error" style="color:var(--error);font-size:12px;margin-top:var(--space-sm)"></div>
      <div class="docker-dialog-actions">
        <button class="btn btn-secondary btn-sm" id="inst-cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" id="inst-confirm">${t('common.add')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('#inst-cancel').onclick = () => overlay.remove()
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('#inst-confirm').onclick = async () => {
    const name = overlay.querySelector('#inst-name').value.trim()
    const endpoint = overlay.querySelector('#inst-endpoint').value.trim()
    const gwPort = parseInt(overlay.querySelector('#inst-gw-port').value) || 18789
    const errEl = overlay.querySelector('#inst-add-error')
    if (!name || !endpoint) { errEl.textContent = t('instance.nameRequired'); return }
    const btn = overlay.querySelector('#inst-confirm')
    btn.disabled = true; btn.textContent = t('instance.adding')
    try {
      await api.instanceAdd({ name, type: 'remote', endpoint, gatewayPort: gwPort })
      overlay.remove()
      renderSidebar(sidebarEl)
    } catch (e) {
      errEl.textContent = e.message || String(e)
      btn.disabled = false; btn.textContent = t('common.add')
    }
  }
}
