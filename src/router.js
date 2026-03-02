/**
 * 极简 hash 路由
 */
const routes = {}
const _moduleCache = {}
let _contentEl = null
let _loadId = 0
let _currentCleanup = null
let _initialized = false

let _defaultRoute = '/dashboard'

export function registerRoute(path, loader) {
  routes[path] = loader
}

export function setDefaultRoute(path) {
  _defaultRoute = path
}

export function navigate(path) {
  window.location.hash = path
}

export function initRouter(contentEl) {
  _contentEl = contentEl
  if (!_initialized) {
    window.addEventListener('hashchange', () => loadRoute())
    _initialized = true
  }
  loadRoute()
}

async function loadRoute() {
  const hash = window.location.hash.slice(1) || _defaultRoute
  const loader = routes[hash]
  if (!loader || !_contentEl) return

  // 竞态防护：记录本次加载 ID
  const thisLoad = ++_loadId

  // 清理上一个页面
  if (_currentCleanup) {
    try { _currentCleanup() } catch (_) {}
    _currentCleanup = null
  }

  // 立即移除旧页面（不等退出动画，消除切换卡顿）
  _contentEl.innerHTML = ''

  // 已缓存的模块：跳过 spinner，直接渲染
  let mod = _moduleCache[hash]
  if (!mod) {
    _contentEl.innerHTML = ''
    // 仅首次加载显示 spinner
    const spinnerEl = document.createElement('div')
    spinnerEl.className = 'page-loader'
    spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
    _contentEl.appendChild(spinnerEl)

    mod = await loader()
    _moduleCache[hash] = mod
  } else {
    _contentEl.innerHTML = ''
  }

  // 如果加载期间路由又变了，丢弃本次结果
  if (thisLoad !== _loadId) return

  const page = mod.render ? await mod.render() : mod.default ? await mod.default() : mod
  if (thisLoad !== _loadId) return

  // 插入页面内容
  _contentEl.innerHTML = ''
  if (typeof page === 'string') {
    _contentEl.innerHTML = page
  } else if (page instanceof HTMLElement) {
    _contentEl.appendChild(page)
  }

  // 保存页面清理函数
  _currentCleanup = mod.cleanup || null

  // 更新侧边栏激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.route === hash)
  })
}

export function getCurrentRoute() {
  return window.location.hash.slice(1) || _defaultRoute
}
