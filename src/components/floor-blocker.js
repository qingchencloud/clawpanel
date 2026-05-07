/**
 * 硬地板拦截组件
 *
 * 当检测到内核版本低于 ClawPanel 支持的最低版本（KERNEL_FLOOR）时，
 * 显示一个全屏遮罩，引导用户升级内核或继续以只读模式使用。
 *
 * 使用方式：
 *   import { showFloorBlocker, hideFloorBlocker } from './floor-blocker.js'
 *   showFloorBlocker({ currentVersion, floor, target, onIgnore })
 */
import { t } from '../lib/i18n.js'

const OVERLAY_ID = 'kernel-floor-blocker'

/**
 * 显示地板拦截
 *
 * @param {Object} opts
 * @param {string} opts.currentVersion  当前检测到的内核版本（含后缀）
 * @param {string} opts.floor           最低支持版本
 * @param {string|null} opts.target     推荐目标版本
 * @param {() => void} [opts.onIgnore]  用户点击「继续（只读模式）」时的回调
 */
export function showFloorBlocker({ currentVersion, floor, target, onIgnore }) {
  // 已存在则不重复创建
  if (document.getElementById(OVERLAY_ID)) return

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.className = 'floor-blocker-overlay'
  overlay.innerHTML = `
    <div class="floor-blocker-card">
      <div class="floor-blocker-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <h2 class="floor-blocker-title">${escapeHtml(t('kernel.floorBlocker.title'))}</h2>
      <p class="floor-blocker-message">${t('kernel.floorBlocker.message', {
        current: `<code>${escapeHtml(currentVersion || '-')}</code>`,
        floor: `<code>${escapeHtml(floor || '-')}</code>`,
      })}</p>
      ${target ? `<p class="floor-blocker-target">${t('kernel.floorBlocker.targetHint', {
        target: `<code>${escapeHtml(target)}</code>`,
      })}</p>` : ''}
      <div class="floor-blocker-actions">
        <a href="#/about" class="btn btn-primary" data-action="upgrade">${escapeHtml(t('kernel.floorBlocker.goUpgrade'))}</a>
        <button type="button" class="btn btn-ghost" data-action="ignore">${escapeHtml(t('kernel.floorBlocker.continueReadonly'))}</button>
      </div>
      <p class="floor-blocker-hint">${escapeHtml(t('kernel.floorBlocker.readonlyHint'))}</p>
    </div>
  `

  // 升级按钮 → 跳 about 页，然后移除遮罩让用户操作
  overlay.querySelector('[data-action="upgrade"]')?.addEventListener('click', () => {
    hideFloorBlocker()
  })

  // 忽略 → 只读模式
  overlay.querySelector('[data-action="ignore"]')?.addEventListener('click', () => {
    hideFloorBlocker()
    try { onIgnore?.() } catch (e) { console.warn('[floor-blocker] onIgnore error', e) }
  })

  document.body.appendChild(overlay)
  injectStyles()
}

export function hideFloorBlocker() {
  const el = document.getElementById(OVERLAY_ID)
  if (!el) return
  el.classList.add('hide')
  setTimeout(() => el.remove(), 300)
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
  .floor-blocker-overlay {
    position: fixed; inset: 0; z-index: 9998;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    animation: floor-blocker-fade-in 0.24s ease-out;
  }
  .floor-blocker-overlay.hide {
    opacity: 0;
    transition: opacity 0.24s ease-in;
  }
  .floor-blocker-card {
    max-width: 520px; width: 100%;
    background: var(--bg-primary, #fff);
    color: var(--text-primary, #111);
    border-radius: 16px;
    padding: 32px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.35);
    text-align: center;
    animation: floor-blocker-slide-up 0.28s ease-out;
  }
  .floor-blocker-icon {
    color: var(--warning, #f59e0b);
    display: inline-flex;
    margin-bottom: 12px;
  }
  .floor-blocker-title {
    margin: 0 0 12px; font-size: 20px; font-weight: 600;
  }
  .floor-blocker-message,
  .floor-blocker-target {
    margin: 0 0 12px;
    color: var(--text-secondary, #555);
    font-size: 14px;
    line-height: 1.6;
  }
  .floor-blocker-message code,
  .floor-blocker-target code {
    background: var(--bg-tertiary, #f3f4f6);
    padding: 2px 8px;
    border-radius: 4px;
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    color: var(--text-primary, #111);
  }
  .floor-blocker-actions {
    display: flex; flex-wrap: wrap; gap: 10px;
    justify-content: center;
    margin: 20px 0 12px;
  }
  .floor-blocker-actions .btn {
    min-width: 140px;
    text-decoration: none;
  }
  .floor-blocker-hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-tertiary, #888);
  }
  @keyframes floor-blocker-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes floor-blocker-slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  `
  const style = document.createElement('style')
  style.setAttribute('data-origin', 'floor-blocker')
  style.textContent = css
  document.head.appendChild(style)
}
