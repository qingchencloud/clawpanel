/**
 * Modal 弹窗组件
 */

import { t } from '../lib/i18n.js'

// 转义 HTML 属性值，防止双引号等字符破坏 HTML 结构
function escapeAttr(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 自定义确认弹窗，替代原生 confirm()
 * Tauri WebView 不支持原生 confirm/alert，必须用自定义弹窗
 * @param {string} message 确认消息
 * @returns {Promise<boolean>} 用户选择确认返回 true，取消返回 false
 */
export function showConfirm(message, options = {}) {
  // options:
  //   title: 标题文本（默认 t('common.confirmAction')）
  //   confirmText: 确认按钮文字（默认 t('common.confirm')）
  //   cancelText: 取消按钮文字（默认 t('common.cancel')）
  //   variant: 'danger' | 'primary'（默认 'danger'，决定确认按钮颜色）
  const title = options.title || t('common.confirmAction')
  const confirmText = options.confirmText || t('common.confirm')
  const cancelText = options.cancelText || t('common.cancel')
  const variant = options.variant === 'primary' ? 'btn-primary' : 'btn-danger'
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:400px">
        <div class="modal-title">${escapeAttr(title)}</div>
        <div class="modal-body" style="font-size:var(--font-size-sm);color:var(--text-secondary);white-space:pre-wrap;line-height:1.6">${escapeAttr(message)}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary btn-sm" data-action="cancel">${escapeAttr(cancelText)}</button>
          <button class="btn ${variant} btn-sm" data-action="confirm">${escapeAttr(confirmText)}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const close = (result) => {
      overlay.remove()
      resolve(result)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false)
    })
    overlay.querySelector('[data-action="cancel"]').onclick = () => close(false)
    overlay.querySelector('[data-action="confirm"]').onclick = () => close(true)
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true) }
      else if (e.key === 'Escape') close(false)
    })
    // 聚焦确认按钮以接收键盘事件
    overlay.querySelector('[data-action="confirm"]').focus()
  })
}

export function showModal({ title, fields, onConfirm }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'

  const fieldHtml = fields.map(f => {
    if (f.type === 'checkbox') {
      return `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" data-name="${f.name}" ${f.value ? 'checked' : ''}>
            <span class="form-label" style="margin:0">${f.label}</span>
          </label>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>`
    }
    if (f.type === 'select') {
      return `
        <div class="form-group">
          <label class="form-label">${f.label}</label>
          <select class="form-input" data-name="${f.name}">
            ${f.options.map(o => `<option value="${o.value}" ${o.value === f.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>`
    }
    return `
      <div class="form-group">
        <label class="form-label">${f.label}</label>
        <input class="form-input" data-name="${f.name}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.placeholder)}"${f.readonly ? ' readonly style="opacity:0.6;cursor:not-allowed"' : ''}>
        ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
      </div>`
  }).join('')

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${title}</div>
      ${fieldHtml}
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">${t('common.confirm')}</button>
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()

  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const result = {}
    overlay.querySelectorAll('[data-name]').forEach(el => {
      if (el.type === 'checkbox') {
        result[el.dataset.name] = el.checked
      } else {
        result[el.dataset.name] = el.value
      }
    })
    // 先调用回调，再移除 overlay，避免嵌套对话框时序问题
    const callback = onConfirm
    setTimeout(() => overlay.remove(), 0)
    callback(result)
  }

  // 键盘事件：Enter 确认，Escape 关闭
  const handleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      overlay.querySelector('[data-action="confirm"]')?.click()
    } else if (e.key === 'Escape') {
      overlay.remove()
    }
  }
  overlay.addEventListener('keydown', handleKey)

  // 自动聚焦第一个输入框
  const firstInput = overlay.querySelector('input, select')
  if (firstInput) firstInput.focus()
}

/**
 * 通用内容弹窗 — 支持自定义 HTML 和按钮
 * @param {{ title, content, buttons, width }} opts
 *   buttons: [{ label, className, id }]
 * @returns {HTMLElement} overlay 元素（带 .close() 方法）
 */
export function showContentModal({ title, content, buttons = [], width = 480 }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'

  const btnsHtml = buttons.map(b =>
    `<button class="${b.className || 'btn btn-primary btn-sm'}" id="${b.id || ''}">${b.label}</button>`
  ).join('')

  overlay.innerHTML = `
    <div class="modal" style="max-width:${width}px">
      <div class="modal-title">${title}</div>
      <div class="modal-content-body">${content}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">${t('common.cancel')}</button>
        ${btnsHtml}
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  overlay.close = () => overlay.remove()

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove()
  })

  // 自动聚焦第一个输入框或按钮
  const firstInput = overlay.querySelector('input, textarea, select')
  if (firstInput) firstInput.focus()

  return overlay
}

/**
 * 升级进度弹窗 — 带进度条和实时日志
 * @returns {{ appendLog, setProgress, setDone, setError, destroy }}
 */
export function showUpgradeModal(title) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-title">${title || t('common.upgradeOpenClaw')}</div>
      <div class="upgrade-progress-wrap">
        <div class="upgrade-progress-bar"><div class="upgrade-progress-fill" style="width:0%"></div></div>
        <div class="upgrade-progress-text">${t('common.preparing')}</div>
      </div>
      <div class="upgrade-log-box"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="close">${t('common.close')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const fill = overlay.querySelector('.upgrade-progress-fill')
  const text = overlay.querySelector('.upgrade-progress-text')
  const logBox = overlay.querySelector('.upgrade-log-box')
  const closeBtn = overlay.querySelector('[data-action="close"]')
  const _logLines = []

  let _onClose = null
  let _finished = false
  let _taskBar = null
  let _progressLabels = null

  // 重新打开弹窗（从任务状态栏点击时）
  function reopenModal() {
    if (_taskBar) { _taskBar.remove(); _taskBar = null }
    document.body.appendChild(overlay)
  }

  // 关闭弹窗：未完成时显示任务状态栏
  function closeModal() {
    overlay.remove()
    if (!_finished) {
      showTaskBar()
    } else {
      if (_taskBar) { _taskBar.remove(); _taskBar = null }
      _onClose?.()
    }
  }

  // 全局任务状态栏：关闭弹窗后显示在页面顶部
  function showTaskBar() {
    if (_taskBar) return
    _taskBar = document.createElement('div')
    _taskBar.className = 'upgrade-task-bar'
    _taskBar.innerHTML = `
      <span class="upgrade-task-bar-text">${text.textContent}</span>
      <button class="btn btn-sm upgrade-task-bar-open">${t('common.viewDetails')}</button>
      <button class="btn btn-sm btn-ghost upgrade-task-bar-dismiss">×</button>
    `
    _taskBar.querySelector('.upgrade-task-bar-open').onclick = reopenModal
    _taskBar.querySelector('.upgrade-task-bar-dismiss').onclick = () => { _taskBar.remove(); _taskBar = null }
    document.body.appendChild(_taskBar)
  }

  function updateTaskBar(statusText) {
    if (_taskBar) {
      const span = _taskBar.querySelector('.upgrade-task-bar-text')
      if (span) span.textContent = statusText
    }
  }

  closeBtn.onclick = closeModal
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal()
  })

  return {
    appendLog(line) {
      _logLines.push(line)
      const div = document.createElement('div')
      div.textContent = line
      logBox.appendChild(div)
      logBox.scrollTop = logBox.scrollHeight
    },
    appendHtmlLog(line) {
      _logLines.push(line)
      const div = document.createElement('div')
      div.innerHTML = line
      logBox.appendChild(div)
      logBox.scrollTop = logBox.scrollHeight
    },
    getLogText() { return _logLines.join('\n') },
    setProgressLabels(labels) { _progressLabels = labels },
    setProgress(pct) {
      fill.style.width = pct + '%'
      const labels = _progressLabels || {}
      let statusText
      if (pct >= 100) statusText = labels.done || t('common.completed')
      else if (pct >= 75) statusText = labels.installing || t('common.installingProgress')
      else if (pct >= 30) statusText = labels.downloading || t('common.downloadingDependencies')
      else statusText = labels.preparing || t('common.preparing')
      text.textContent = statusText
      updateTaskBar(statusText)
    },
    setDone(msg) {
      _finished = true
      text.textContent = msg || t('common.upgradeCompleted')
      fill.style.width = '100%'
      fill.classList.add('done')
      if (_taskBar) { _taskBar.remove(); _taskBar = null }
      closeBtn.focus()
    },
    setError(msg) {
      _finished = true
      text.textContent = msg || t('common.upgradeFailed')
      fill.classList.add('error')
      if (_taskBar) {
        const span = _taskBar.querySelector('.upgrade-task-bar-text')
        if (span) { span.textContent = msg || t('common.upgradeFailed'); span.style.color = 'var(--error)' }
      }
      closeBtn.focus()
    },
    onClose(fn) { _onClose = fn },
    destroy() { overlay.remove(); if (_taskBar) { _taskBar.remove(); _taskBar = null } _onClose?.() },
  }
}
