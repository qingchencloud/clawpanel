/**
 * @homebridge/ciao Windows cmd 弹窗 bug 检测与提示
 *
 * 背景：openclaw 的依赖 @homebridge/ciao (<= 1.3.6) 在 Windows 上每 15-30 秒
 * 调用 `child_process.exec("arp -a ...")` 时未传 `windowsHide: true`，
 * 导致 cmd.exe / conhost.exe 窗口闪烁。这是上游库的 bug，
 * 不在 ClawPanel 控制范围内。上游 issue #64 和 PR #65 尚未合并。
 *
 * 我们只做两件事：检测 + 给用户展示修复指引。不触碰用户 node_modules。
 */

import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { t } from './i18n.js'

const DISMISS_KEY_PREFIX = 'clawpanel_ciao_bug_dismissed_v'

function dismissKey(version) {
  return `${DISMISS_KEY_PREFIX}${version || 'unknown'}`
}

function isDismissed(version) {
  try {
    return localStorage.getItem(dismissKey(version)) === '1'
  } catch (_) {
    return false
  }
}

function markDismissed(version) {
  try {
    localStorage.setItem(dismissKey(version), '1')
  } catch (_) { /* quota 等异常忽略 */ }
}

/**
 * 启动后异步检测；若确实受影响，展示一个可 dismiss 的 toast。
 * 用户点"详情"会打开带修复步骤和官方链接的 modal。
 */
export async function checkAndWarnCiaoBug() {
  let result
  try {
    result = await api.checkCiaoWindowsHideBug()
  } catch (err) {
    console.debug('[ciao-bug] check failed:', err)
    return
  }

  if (!result || !result.affected) return
  if (isDismissed(result.version)) return

  const detailBtn = document.createElement('button')
  detailBtn.className = 'btn btn-sm btn-primary'
  detailBtn.textContent = t('ciaoBug.viewDetail')
  detailBtn.style.marginLeft = '8px'
  detailBtn.onclick = () => openCiaoBugModal(result)

  toast(
    t('ciaoBug.toastTitle'),
    'warning',
    { action: detailBtn, duration: 12000 },
  )
}

function openCiaoBugModal(result) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'

  const versionLine = result.version
    ? `<div class="ciao-bug-row"><span class="muted">@homebridge/ciao</span> <code>${escapeHtml(result.version)}</code></div>`
    : ''
  const pathLine = result.networkManagerPath
    ? `<div class="ciao-bug-row"><span class="muted">${escapeHtml(t('ciaoBug.pathLabel'))}</span> <code>${escapeHtml(result.networkManagerPath)}</code></div>`
    : ''

  overlay.innerHTML = `
    <div class="modal" style="max-width:640px;">
      <div class="modal-title">${escapeHtml(t('ciaoBug.modalTitle'))}</div>
      <div class="modal-body" style="font-size:var(--font-size-sm);line-height:1.6;">
        <p style="margin:0 0 12px;">${escapeHtml(t('ciaoBug.summary'))}</p>

        <h4 style="margin:16px 0 6px;font-size:13px;color:var(--text-secondary);">${escapeHtml(t('ciaoBug.envTitle'))}</h4>
        <div class="ciao-bug-env" style="font-size:12px;color:var(--text-secondary);word-break:break-all;">
          ${versionLine}
          ${pathLine}
        </div>

        <h4 style="margin:16px 0 6px;font-size:13px;color:var(--text-secondary);">${escapeHtml(t('ciaoBug.fixTitle'))}</h4>
        <ol style="margin:0;padding-left:20px;">
          <li style="margin-bottom:6px;">${t('ciaoBug.fixUpstream')}</li>
          <li style="margin-bottom:6px;">${t('ciaoBug.fixPatchPackage')}</li>
          <li style="margin-bottom:6px;">${t('ciaoBug.fixManual')}</li>
        </ol>

        <div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;">
          <a href="https://github.com/homebridge/ciao/issues/64" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(t('ciaoBug.linkIssue'))}</a>
          <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(t('ciaoBug.linkPr'))}</a>
        </div>

        <p style="margin:16px 0 0;font-size:12px;color:var(--text-tertiary);">${escapeHtml(t('ciaoBug.disclaimer'))}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="close">${escapeHtml(t('common.close'))}</button>
        <button class="btn btn-primary btn-sm" data-action="dismiss">${escapeHtml(t('ciaoBug.dismissForVersion'))}</button>
      </div>
    </div>
  `

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelector('[data-action="close"]').onclick = close
  overlay.querySelector('[data-action="dismiss"]').onclick = () => {
    markDismissed(result.version)
    close()
    toast(t('ciaoBug.dismissed'), 'info')
  }
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onEsc)
    }
  })

  document.body.appendChild(overlay)
}

function escapeHtml(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
