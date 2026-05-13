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

const chatStore = getChatStore()

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

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
        ${error ? `<div style="color:var(--error);padding:20px">${escHtml(error)}</div>` : ''}
        ${(!loading && !error && !profiles.length) ? `
          <div class="empty-state empty-compact">
            <div class="empty-icon">📁</div>
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
      error = String(e?.message || e)
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
