/**
 * Toast 通知组件
 */
let _container = null

function ensureContainer() {
  if (!_container) {
    _container = document.createElement('div')
    _container.className = 'toast-container'
    document.body.appendChild(_container)
  }
  return _container
}

export function toast(message, type = 'info', options = {}) {
  const duration = options.duration || 3000
  const action = options.action // 可选的操作按钮（DOM 元素）

  const container = ensureContainer()
  const el = document.createElement('div')
  el.className = `toast ${type}`

  const textSpan = document.createElement('span')
  if (options.html) {
    textSpan.innerHTML = message
  } else {
    textSpan.textContent = message
  }
  el.appendChild(textSpan)

  // 如果有操作按钮，添加到 toast 中
  if (action instanceof HTMLElement) {
    el.appendChild(action)
  }

  container.appendChild(el)

  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(20px)'
    el.style.transition = 'all 250ms ease'
    setTimeout(() => el.remove(), 250)
  }, duration)
}
