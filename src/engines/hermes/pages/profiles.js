/**
 * Hermes Profile 管理（Batch 2 §H）
 *
 * 全部走 Dashboard 9119 HTTP API（hermes_dashboard_api_proxy）：
 *   - GET    /api/profiles                  - 列表
 *   - POST   /api/profiles { name, clone_from_default, no_skills } - 创建
 *   - PATCH  /api/profiles/{name} { new_name } - 重命名
 *   - DELETE /api/profiles/{name}            - 删除
 *
 * 切换 active profile 仍走现有 chat-store.switchProfile（CLI 实现），
 * 因为 dashboard server 绑定的 active profile 改变后还需要重启 dashboard。
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showConfirm, showModal } from '../../../components/modal.js'
import { humanizeError } from '../../../lib/humanize-error.js'
import { getChatStore } from '../lib/chat-store.js'
import { svgIcon } from '../lib/svg-icons.js'

const chatStore = getChatStore()

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

function renderInlineError(err) {
  const h = humanizeError(err, t('engine.hermesProfilesTitle'))
  return `
    <div class="page-inline-error">
      <div class="page-inline-error-icon">${svgIcon('alert-triangle', { size: 20 })}</div>
      <div class="page-inline-error-body">
        <div class="page-inline-error-message">${escHtml(h.message)}</div>
        ${h.hint ? `<div class="page-inline-error-hint">${escHtml(h.hint)}</div>` : ''}
        ${h.raw ? `<details class="page-inline-error-details"><summary>${escHtml(t('common.errorRawLabel'))}</summary><pre>${escHtml(h.raw)}</pre></details>` : ''}
      </div>
    </div>
  `
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let profiles = []
  let loading = true
  let error = ''

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesProfilesTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesProfilesDesc'))}</p>
        </div>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm" id="hm-profiles-refresh">${escHtml(t('hermesLazyDeps.refresh'))}</button>
          <button class="btn btn-primary btn-sm" id="hm-profiles-create">+ ${escHtml(t('engine.hermesProfileNew'))}</button>
        </div>
      </div>
      <div id="hm-profiles-content">
        ${loading ? `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>` : ''}
        ${error ? renderInlineError(error) : ''}
        ${(!loading && !error && !profiles.length) ? `
          <div class="empty-state empty-compact">
            <div class="empty-icon">${svgIcon('folder', { size: 32 })}</div>
            <div class="empty-title">${escHtml(t('engine.hermesProfilesEmpty'))}</div>
          </div>` : ''}
        ${(!loading && profiles.length) ? `
          <div class="lazy-deps-grid">
            ${profiles.map(renderProfileCard).join('')}
          </div>` : ''}
      </div>
    `
    bind()
  }

  function renderProfileCard(p) {
    const isActive = !!p.active
    const desc = p.description ? `<div class="lazy-deps-card-meta" title="${escAttr(p.description)}">${escHtml(p.description)}</div>` : ''
    return `
      <div class="lazy-deps-card">
        <div class="lazy-deps-card-head">
          <div class="lazy-deps-card-title" title="${escAttr(p.name)}">${escHtml(p.name)}</div>
          ${isActive ? `<span class="lazy-deps-badge ok">${escHtml(t('engine.hermesProfileActive'))}</span>` : ''}
        </div>
        ${desc}
        <div class="lazy-deps-card-actions" style="gap:6px">
          ${isActive ? '' : `<button class="btn btn-secondary btn-sm" data-action="switch" data-name="${escAttr(p.name)}">${escHtml(t('engine.hermesProfileSwitch'))}</button>`}
          <button class="btn btn-secondary btn-sm" data-action="rename" data-name="${escAttr(p.name)}">${escHtml(t('engine.hermesProfileRename'))}</button>
          ${isActive ? '' : `<button class="btn btn-secondary btn-sm" data-action="delete" data-name="${escAttr(p.name)}" style="color:var(--error)">${escHtml(t('engine.hermesProfileDelete'))}</button>`}
        </div>
      </div>
    `
  }

  function bind() {
    el.querySelector('#hm-profiles-refresh')?.addEventListener('click', load)
    el.querySelector('#hm-profiles-create')?.addEventListener('click', onCreate)
    el.querySelectorAll('[data-action]').forEach(btn => {
      const action = btn.dataset.action
      const name = btn.dataset.name
      btn.addEventListener('click', () => {
        if (action === 'switch') onSwitch(name)
        else if (action === 'rename') onRename(name)
        else if (action === 'delete') onDelete(name)
      })
    })
  }

  async function load() {
    loading = true
    error = ''
    draw()
    // 9119 Dashboard 是独立进程，profile/* API 只由它提供。
    // 先 probe + 自动启动，避免用户看到「网络连接失败」这种无头错误。
    // 启动失败也不在这里中断，下面 hermesDashboardApi 抛出的连接错误会由 humanizeError 显示。
    try {
      const probe = await api.hermesDashboardProbe()
      if (!probe?.running) {
        await api.hermesDashboardStart().catch(() => {})
      }
    } catch { /* probe 失败也继续尝试调用 */ }
    try {
      const resp = await api.hermesDashboardApi('GET', '/api/profiles')
      const list = Array.isArray(resp) ? resp : (resp?.profiles || [])
      // active 标记：与 chat-store 的 activeProfile 对齐
      const activeName = chatStore.state?.activeProfile || 'default'
      profiles = list.map(p => ({
        name: p.name || String(p),
        description: p.description || p.kind || '',
        active: (p.name || String(p)) === activeName,
        raw: p,
      }))
    } catch (e) {
      error = e
    } finally {
      loading = false
      draw()
    }
  }

  function onCreate() {
    showModal({
      title: t('engine.hermesProfileNewTitle'),
      fields: [
        { name: 'name', label: t('engine.hermesProfileNameLabel'), value: '', placeholder: 'work, personal, ...' },
        { name: 'clone_from_default', type: 'checkbox', value: true, label: t('engine.hermesProfileCloneFromDefault'), hint: t('engine.hermesProfileCloneHint') },
      ],
      onConfirm: async (data) => {
        const name = (data.name || '').trim()
        if (!name) {
          toast(t('engine.hermesProfileNameRequired'), 'error')
          return
        }
        try {
          await api.hermesDashboardApi('POST', '/api/profiles', {
            name,
            clone_from_default: !!data.clone_from_default,
            no_skills: false,
          })
          toast(t('engine.hermesProfileCreated', { name }), 'success')
          await load()
        } catch (e) {
          toast(humanizeError(e, t('engine.hermesProfileCreateFailed')), 'error')
        }
      },
    })
  }

  function onRename(name) {
    showModal({
      title: t('engine.hermesProfileRenameTitle', { name }),
      fields: [
        { name: 'new_name', label: t('engine.hermesProfileNewNameLabel'), value: name, placeholder: name },
      ],
      onConfirm: async (data) => {
        const newName = (data.new_name || '').trim()
        if (!newName || newName === name) return
        try {
          await api.hermesDashboardApi('PATCH', `/api/profiles/${encodeURIComponent(name)}`, { new_name: newName })
          toast(t('engine.hermesProfileRenamed', { from: name, to: newName }), 'success')
          await load()
        } catch (e) {
          toast(humanizeError(e, t('engine.hermesProfileRenameFailed')), 'error')
        }
      },
    })
  }

  async function onDelete(name) {
    const ok = await showConfirm({
      message: t('engine.hermesProfileDeleteConfirm', { name }),
      impact: [t('engine.hermesProfileDeleteImpact')],
      confirmText: t('engine.hermesProfileDelete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.hermesDashboardApi('DELETE', `/api/profiles/${encodeURIComponent(name)}`)
      toast(t('engine.hermesProfileDeleted', { name }), 'success')
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesProfileDeleteFailed')), 'error')
    }
  }

  async function onSwitch(name) {
    try {
      await chatStore.switchProfile(name)
      toast(t('engine.hermesProfileSwitched', { name }), 'success')
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesProfileSwitchFailed')), 'error')
    }
  }

  draw()
  load()
  return el
}
