/**
 * 内核版本徽章组件
 *
 * 在 sidebar 底部 / 设置页 / About 页显示当前对接的内核版本以及已启用特性数。
 * 用法：
 *   import { mountKernelBadge } from './components/kernel-badge.js'
 *   const el = mountKernelBadge(container, { compact: true })
 *
 * 自动订阅 onKernelChange，状态变化时刷新；container 销毁时调用 el._unsub() 清理。
 */
import { onKernelChange, getKernelSnapshot } from '../lib/kernel.js'
import { FEATURE_CATALOG } from '../lib/feature-catalog.js'
import { t } from '../lib/i18n.js'

/**
 * 在指定容器中挂载内核徽章。
 *
 * @param {HTMLElement} container 父容器
 * @param {Object} [opts]
 * @param {boolean} [opts.compact=false] 紧凑模式：仅显示版本号 + 角标
 * @returns {HTMLElement & { _unsub?: () => void }}
 */
export function mountKernelBadge(container, opts = {}) {
  const compact = !!opts.compact
  const el = document.createElement('div')
  el.className = compact ? 'kernel-badge kernel-badge-compact' : 'kernel-badge'

  function update(snap) {
    if (!snap || !snap.version) {
      el.innerHTML = compact
        ? `<span class="kernel-badge-version">${escapeHtml(t('kernel.badge.unknown'))}</span>`
        : `<div class="kernel-badge-row"><span class="kernel-badge-label">${escapeHtml(t('kernel.badge.currentKernel'))}</span><span class="kernel-badge-version">${escapeHtml(t('kernel.badge.unknown'))}</span></div>`
      return
    }

    const total = Object.values(FEATURE_CATALOG).filter(f => f.engine === snap.engine).length
    const enabled = snap.features.size

    let stateBadge = ''
    if (!snap.aboveFloor) {
      stateBadge = `<span class="kernel-badge-state warn">${escapeHtml(t('kernel.badge.belowTarget'))}</span>`
    } else if (snap.isLatest) {
      stateBadge = `<span class="kernel-badge-state ok">${escapeHtml(t('kernel.badge.latest'))}</span>`
    } else if (!snap.isLatest && snap.target) {
      stateBadge = `<span class="kernel-badge-state info">${escapeHtml(t('kernel.badge.belowTarget'))}</span>`
    }

    if (compact) {
      el.innerHTML = `
        <span class="kernel-badge-version">${escapeHtml(snap.versionLabel || snap.version)}</span>
        ${stateBadge}
      `
      el.title = t('kernel.badge.featuresEnabled', { enabled, total })
    } else {
      el.innerHTML = `
        <div class="kernel-badge-row">
          <span class="kernel-badge-label">${escapeHtml(t('kernel.badge.currentKernel'))}</span>
          <span class="kernel-badge-version">${escapeHtml(snap.versionLabel || snap.version)}</span>
          ${stateBadge}
        </div>
        <div class="kernel-badge-row kernel-badge-features">
          ${escapeHtml(t('kernel.badge.featuresEnabled', { enabled, total }))}
        </div>
      `
    }
  }

  // 立即渲染当前快照（可能为 null）
  update(getKernelSnapshot())

  // 订阅变化
  const unsub = onKernelChange(update)
  el._unsub = unsub

  injectStyles()
  container.appendChild(el)
  return el
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

let _stylesInjected = false
function injectStyles() {
  if (_stylesInjected) return
  _stylesInjected = true
  const css = `
  .kernel-badge {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--bg-tertiary, #f3f4f6);
    border: 1px solid var(--border-color, #e5e7eb);
    font-size: 12px;
    line-height: 1.4;
  }
  .kernel-badge-compact {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--border-color, #e5e7eb);
    cursor: default;
  }
  .kernel-badge-row {
    display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap;
  }
  .kernel-badge-label {
    color: var(--text-tertiary, #888);
    font-size: 11px;
  }
  .kernel-badge-version {
    font-family: var(--font-mono, monospace);
    font-weight: 600;
    color: var(--text-primary, #111);
  }
  .kernel-badge-features {
    color: var(--text-secondary, #555);
    font-size: 11px;
  }
  .kernel-badge-state {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kernel-badge-state.ok   { color: var(--success, #16a34a); background: rgba(34,197,94,.12); }
  .kernel-badge-state.info { color: var(--info, #2563eb);    background: rgba(59,130,246,.12); }
  .kernel-badge-state.warn { color: var(--warning, #d97706); background: rgba(245,158,11,.16); }
  `
  const style = document.createElement('style')
  style.setAttribute('data-origin', 'kernel-badge')
  style.textContent = css
  document.head.appendChild(style)
}
