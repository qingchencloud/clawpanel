/**
 * CLI 冲突检测与一键隔离横幅
 *
 * 用户场景：
 *   系统 PATH 中存在多份 openclaw（CherryStudio 内嵌 / 旧 npm 全局 / 手动下载等），
 *   它们与 ClawPanel 管理的 standalone 共存时会引起：
 *   - 终端 `openclaw` 命令拿到老版本 → schema 不兼容 → doctor --fix 卡死
 *   - 第三方工具调用 openclaw 时拿到老版本
 *
 * 本组件：
 *   1. 异步扫描 PATH，发现冲突时在容器内显示警告横幅
 *   2. 提供"一键隔离"按钮：把冲突文件重命名为 .disabled-by-clawpanel-{ts}.bak（**不真删**）
 *   3. 提供"详情"展开列表 / 单条隔离按钮
 *   4. 一键隔离后保留"撤销"入口，找回 .bak 文件
 *
 * 使用：
 *   import { attachCliConflictBanner } from '../components/cli-conflict-banner.js'
 *   const cleanup = attachCliConflictBanner(containerEl)
 */

import { api } from '../lib/tauri-api.js'
import { t } from '../lib/i18n.js'
import { toast } from './toast.js'

const STORAGE_KEY = 'clawpanel-cli-conflict-dismissed-paths'

// 已知良性来源：这些 IDE/客户端会自带一份 openclaw，跟 ClawPanel 共存不会出问题——
// Tauri 后端的 `is_rejected_cli_path` 已排除它们，不会被 ClawPanel 选用；
// 用户在终端调用 `openclaw` 想拿到的本来也就是这些 IDE 自己的版本。
// 这些来源默认不再触发警告横幅，避免用户误以为需要清理一键安装包。
const BENIGN_SOURCES = new Set(['cherrystudio', 'cursor'])

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function loadDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch (_) {
    // 忽略 localStorage 异常（隐私模式 / 配额）
  }
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 在容器内挂载 CLI 冲突警告横幅。
 * @param {HTMLElement} containerEl - 容器元素（横幅会作为其首个子元素插入）
 * @returns {() => void} cleanup 函数，从 DOM 移除横幅
 */
export function attachCliConflictBanner(containerEl) {
  if (!containerEl || !(containerEl instanceof HTMLElement)) return () => {}

  // 占位元素（即便 scan 失败也保留，便于后续重试逻辑）
  const slot = document.createElement('div')
  slot.className = 'cli-conflict-slot'
  slot.style.display = 'none'
  containerEl.insertBefore(slot, containerEl.firstChild)

  let cancelled = false

  ;(async () => {
    let conflicts
    try {
      conflicts = await api.scanOpenclawPathConflicts()
    } catch (e) {
      // scan 失败本身不展示给用户（可能是 web 模式没注册命令）；仅在控制台留痕
      console.warn('[cli-conflict-banner] scan failed:', e?.message || e)
      return
    }
    if (cancelled) return

    const dismissed = loadDismissed()
    const isActionable = c => !dismissed.has(c.path) && !BENIGN_SOURCES.has(c.source)
    const visible = (conflicts || []).filter(isActionable)
    if (visible.length === 0) return

    // 重新扫描+重渲染（隔离后调用），用 named function 自引用
    const reload = async () => {
      try {
        const next = await api.scanOpenclawPathConflicts()
        const dismissedNow = loadDismissed()
        const stillVisible = (next || []).filter(c =>
          !dismissedNow.has(c.path) && !BENIGN_SOURCES.has(c.source)
        )
        if (stillVisible.length === 0) {
          slot.innerHTML = ''
          slot.style.display = 'none'
        } else {
          renderBanner(slot, stillVisible, reload)
        }
      } catch (_) { /* ignore */ }
    }
    renderBanner(slot, visible, reload)
  })()

  return () => {
    cancelled = true
    slot.remove()
  }
}

function renderBanner(slot, conflicts, onChanged) {
  const count = conflicts.length
  slot.style.display = ''
  slot.innerHTML = `
    <div class="cli-conflict-banner" role="alert">
      <div class="cli-conflict-banner-head">
        <div class="cli-conflict-banner-icon">⚠</div>
        <div class="cli-conflict-banner-text">
          <div class="cli-conflict-banner-title">${t('cliConflict.title', { count })}</div>
          <div class="cli-conflict-banner-desc">${t('cliConflict.desc')}</div>
        </div>
        <div class="cli-conflict-banner-actions">
          <button class="btn btn-sm btn-secondary" data-act="toggle">${t('cliConflict.viewDetails')}</button>
          <button class="btn btn-sm btn-primary" data-act="quarantine-all">${t('cliConflict.quarantineAll')}</button>
          <button class="btn btn-sm btn-ghost" data-act="dismiss">${t('cliConflict.dismiss')}</button>
        </div>
      </div>
      <div class="cli-conflict-banner-body" hidden>
        <div class="cli-conflict-list">
          ${conflicts.map((c, i) => `
            <div class="cli-conflict-item" data-idx="${i}">
              <div class="cli-conflict-item-main">
                <div class="cli-conflict-item-source">${escapeHtml(c.sourceLabel || c.source || '')}${c.version ? ` <span class="cli-conflict-item-version">v${escapeHtml(c.version)}</span>` : ''}</div>
                <div class="cli-conflict-item-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</div>
                ${c.sizeBytes != null ? `<div class="cli-conflict-item-meta">${escapeHtml(formatBytes(c.sizeBytes))}</div>` : ''}
              </div>
              <div class="cli-conflict-item-actions">
                <button class="btn btn-xs btn-secondary" data-act="quarantine-one" data-path="${escapeHtml(c.path)}">${t('cliConflict.quarantineOne')}</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="cli-conflict-banner-foot">${t('cliConflict.footnote')}</div>
      </div>
    </div>
  `

  const banner = slot.querySelector('.cli-conflict-banner')
  const body = banner.querySelector('.cli-conflict-banner-body')
  const toggleBtn = banner.querySelector('[data-act="toggle"]')
  const quarantineAllBtn = banner.querySelector('[data-act="quarantine-all"]')
  const dismissBtn = banner.querySelector('[data-act="dismiss"]')

  toggleBtn.addEventListener('click', () => {
    body.hidden = !body.hidden
    toggleBtn.textContent = body.hidden ? t('cliConflict.viewDetails') : t('cliConflict.hideDetails')
  })

  dismissBtn.addEventListener('click', () => {
    const dismissed = loadDismissed()
    conflicts.forEach(c => dismissed.add(c.path))
    saveDismissed(dismissed)
    slot.innerHTML = ''
    slot.style.display = 'none'
    toast(t('cliConflict.dismissedHint'), 'info', { duration: 4000 })
  })

  quarantineAllBtn.addEventListener('click', async () => {
    quarantineAllBtn.disabled = true
    quarantineAllBtn.textContent = t('cliConflict.quarantining')
    try {
      const result = await api.quarantineOpenclawPathsBulk(conflicts.map(c => c.path))
      const ok = result?.records?.length || 0
      const fail = result?.failed?.length || 0
      if (ok > 0) {
        toast(t('cliConflict.quarantineOk', { count: ok }), 'success', { duration: 4000 })
      }
      if (fail > 0) {
        const detail = result.failed.map(f => `${f.path}: ${f.error}`).join('\n')
        toast(t('cliConflict.quarantinePartial', { count: fail }) + '\n' + detail, 'warning', { duration: 8000 })
      }
      await onChanged()
    } catch (e) {
      toast(t('cliConflict.quarantineFail', { error: e?.message || e }), 'error', { duration: 8000 })
      quarantineAllBtn.disabled = false
      quarantineAllBtn.textContent = t('cliConflict.quarantineAll')
    }
  })

  body.querySelectorAll('[data-act="quarantine-one"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const path = btn.getAttribute('data-path')
      btn.disabled = true
      btn.textContent = t('cliConflict.quarantining')
      try {
        await api.quarantineOpenclawPath(path)
        toast(t('cliConflict.quarantineOneOk'), 'success', { duration: 4000 })
        await onChanged()
      } catch (e) {
        toast(t('cliConflict.quarantineFail', { error: e?.message || e }), 'error', { duration: 8000 })
        btn.disabled = false
        btn.textContent = t('cliConflict.quarantineOne')
      }
    })
  })
}
