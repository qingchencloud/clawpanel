/**
 * Modal 弹窗组件
 */

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
export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:400px">
        <div class="modal-title">确认操作</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);white-space:pre-wrap;line-height:1.6">${escapeAttr(message)}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
          <button class="btn btn-danger btn-sm" data-action="confirm">确定</button>
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
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">确定</button>
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
 * 升级进度弹窗 — 带进度条和实时日志
 * @returns {{ appendLog, setProgress, setDone, setError, destroy }}
 */
export function showUpgradeModal() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-title">升级 OpenClaw</div>
      <div class="upgrade-progress-wrap">
        <div class="upgrade-progress-bar"><div class="upgrade-progress-fill" style="width:0%"></div></div>
        <div class="upgrade-progress-text">准备中...</div>
      </div>
      <div class="upgrade-log-box"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="close" disabled>关闭</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const fill = overlay.querySelector('.upgrade-progress-fill')
  const text = overlay.querySelector('.upgrade-progress-text')
  const logBox = overlay.querySelector('.upgrade-log-box')
  const closeBtn = overlay.querySelector('[data-action="close"]')
  const _logLines = []

  closeBtn.onclick = () => overlay.remove()
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !closeBtn.disabled) overlay.remove()
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
    setProgress(pct) {
      fill.style.width = pct + '%'
      if (pct >= 100) text.textContent = '完成'
      else if (pct >= 75) text.textContent = '正在安装...'
      else if (pct >= 30) text.textContent = '正在下载依赖...'
      else text.textContent = '准备中...'
    },
    setDone(msg) {
      text.textContent = msg || '升级完成'
      fill.style.width = '100%'
      fill.classList.add('done')
      closeBtn.disabled = false
      closeBtn.focus()
    },
    setError(msg) {
      text.textContent = msg || '升级失败'
      fill.classList.add('error')
      closeBtn.disabled = false
      closeBtn.focus()
    },
    destroy() { overlay.remove() },
  }
}
