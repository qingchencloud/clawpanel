/**
 * 全局 AI 助手浮动按钮（FAB）
 * 右下角可拖动按钮 → 点击导航到 AI 助手页面（复用完整功能）
 * 自动注入当前页面上下文到 AI 助手会话
 */

const BOT_ICON = '<svg viewBox="0 0 24 24"><path d="M12 8V4H8"/><rect x="5" y="8" width="14" height="12" rx="2"/><path d="M9 13h0"/><path d="M15 13h0"/><path d="M10 17h4"/></svg>'

const POS_KEY = 'clawpanel-fab-pos'

// ── 页面上下文收集器注册表 ──
const _contextProviders = {}

/**
 * 注册页面上下文提供器
 * @param {string} route - 路由路径，如 '/chat-debug'
 * @param {function} provider - 返回 { label, detail } 的函数（可 async）
 */
export function registerPageContext(route, provider) {
  _contextProviders[route] = provider
}

// ── 单例 ──
let _fab = null

/** 初始化 FAB */
export function initAIFab() {
  if (_fab) return _fab
  _fab = createFab()
  return _fab
}

/** 导航到 AI 助手并注入错误上下文（显示为可操作的 banner，而非自动发送） */
export function openAIDrawerWithError(errorCtx) {
  sessionStorage.setItem('assistant-error-context', JSON.stringify({
    scene: errorCtx.scene || '',
    title: errorCtx.title || '操作失败',
    hint: errorCtx.hint || '',
    error: truncate(errorCtx.error || '', 3000),
    ts: Date.now(),
  }))
  // 不自动导航 — FAB 按钮会出现红点提示，用户主动点击时跳转
  // 如果用户已在助手页，也会实时检测到
  if (getCurrentRoute() !== '/assistant') {
    // 让 FAB 显示红点
    if (_fab?.el) _fab.el.classList.add('has-error')
  } else {
    // 已在助手页 → 直接触发 banner 显示
    window.dispatchEvent(new CustomEvent('assistant-error-injected'))
  }
}

function truncate(str, max) {
  if (!str || str.length <= max) return str
  return str.slice(0, max) + '\n... (截断)'
}

// ── 创建 FAB ──
function createFab() {
  const fab = document.createElement('button')
  fab.className = 'ai-fab'
  fab.title = 'AI 助手'
  fab.innerHTML = BOT_ICON
  document.body.appendChild(fab)

  // 恢复保存的位置
  restorePosition(fab)

  // ── 拖动逻辑 ──
  let _dragging = false
  let _dragMoved = false
  let _startX = 0, _startY = 0
  let _fabX = 0, _fabY = 0

  function onPointerDown(e) {
    if (e.button !== 0) return
    _dragging = true
    _dragMoved = false
    _startX = e.clientX
    _startY = e.clientY
    const rect = fab.getBoundingClientRect()
    _fabX = rect.left
    _fabY = rect.top
    fab.style.transition = 'none'
    fab.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!_dragging) return
    const dx = e.clientX - _startX
    const dy = e.clientY - _startY
    if (!_dragMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    _dragMoved = true
    fab.classList.add('dragging')

    // 计算新位置（限制在视口内）
    const vw = window.innerWidth
    const vh = window.innerHeight
    const size = 48
    let newX = Math.max(8, Math.min(vw - size - 8, _fabX + dx))
    let newY = Math.max(8, Math.min(vh - size - 8, _fabY + dy))

    fab.style.left = newX + 'px'
    fab.style.top = newY + 'px'
    fab.style.right = 'auto'
    fab.style.bottom = 'auto'
  }

  function onPointerUp(e) {
    if (!_dragging) return
    _dragging = false
    fab.classList.remove('dragging')
    fab.style.transition = ''

    if (_dragMoved) {
      // 吸附到最近的边（左/右）
      const rect = fab.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const snapRight = rect.left > vw / 2
      const y = Math.max(8, Math.min(vh - 56, rect.top))

      if (snapRight) {
        fab.style.left = 'auto'
        fab.style.right = '24px'
      } else {
        fab.style.left = '24px'
        fab.style.right = 'auto'
      }
      fab.style.top = y + 'px'
      fab.style.bottom = 'auto'

      // 保存位置
      savePosition(snapRight ? 'right' : 'left', y)
    } else {
      // 没有拖动 → 点击
      handleClick()
    }
  }

  fab.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)

  // ── 点击 → 导航到 AI 助手 ──
  async function handleClick() {
    const route = getCurrentRoute()

    // 已经在 AI 助手页面，不做任何操作
    if (route === '/assistant') return

    // 清除红点
    fab.classList.remove('has-error')

    // 如果没有错误上下文待处理，收集当前页面上下文
    if (!sessionStorage.getItem('assistant-error-context')) {
      const provider = _contextProviders[route]
      if (provider) {
        try {
          const ctx = await provider()
          if (ctx?.detail) {
            const prompt = `以下是当前页面的上下文信息，请根据情况提供帮助：\n\n${ctx.detail}`
            sessionStorage.setItem('assistant-auto-prompt', prompt)
          }
        } catch (e) {
          console.warn('[ai-fab] 上下文收集失败:', e)
        }
      }
    }

    window.location.hash = '#/assistant'
  }

  // ── 路由变化时隐藏/显示 ──
  function updateVisibility() {
    const route = getCurrentRoute()
    fab.style.display = route === '/assistant' ? 'none' : 'flex'
  }

  window.addEventListener('hashchange', updateVisibility)
  updateVisibility()

  return { el: fab }
}

function getCurrentRoute() {
  return (window.location.hash.replace('#', '') || '/dashboard').split('?')[0]
}

function savePosition(side, top) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ side, top }))
  } catch {}
}

function restorePosition(fab) {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const { side, top } = JSON.parse(raw)
    if (side === 'left') {
      fab.style.left = '24px'
      fab.style.right = 'auto'
    }
    if (typeof top === 'number') {
      fab.style.top = top + 'px'
      fab.style.bottom = 'auto'
    }
  } catch {}
}
