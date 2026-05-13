/**
 * Hermes 多 Gateway 看板（Batch 2 §G）
 *
 * 让用户同时跑多个 Hermes Gateway 实例（每个绑不同 profile）。
 * 端口完全由 profile 的 config.yaml 决定，ClawPanel 只负责 spawn + PID 跟踪。
 *
 * 后端 Tauri 命令：
 *   - hermesMultiGatewayList() → [{name, profile, port, running, pid, owned}]
 *   - hermesMultiGatewayAdd(name, profile)
 *   - hermesMultiGatewayRemove(name)
 *   - hermesMultiGatewayStart(name)
 *   - hermesMultiGatewayStop(name)
 *
 * 持久化在 panelConfig.hermes.multiGateways
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showModal, showConfirm } from '../../../components/modal.js'
import { humanizeError } from '../../../lib/humanize-error.js'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let gateways = []
  let profiles = []
  let loading = true
  let error = ''
  let busyName = ''  // 操作中的 gateway 名

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesGatewaysTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesGatewaysDesc'))}</p>
        </div>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm" id="hm-gws-refresh">${escHtml(t('hermesLazyDeps.refresh'))}</button>
          <button class="btn btn-primary btn-sm" id="hm-gws-add">+ ${escHtml(t('engine.hermesGatewayAdd'))}</button>
        </div>
      </div>
      <div id="hm-gws-content">
        ${loading ? `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>` : ''}
        ${error ? `<div style="color:var(--error);padding:20px">${escHtml(error)}</div>` : ''}
        ${(!loading && !error && !gateways.length) ? `
          <div class="empty-state empty-compact">
            <div class="empty-icon">⚙️</div>
            <div class="empty-title">${escHtml(t('engine.hermesGatewaysEmpty'))}</div>
            <div class="empty-desc" style="margin-top:8px">${escHtml(t('engine.hermesGatewaysEmptyHint'))}</div>
          </div>` : ''}
        ${(!loading && gateways.length) ? `
          <div class="lazy-deps-grid">
            ${gateways.map(renderCard).join('')}
          </div>` : ''}
      </div>
    `
    bind()
  }

  function renderCard(g) {
    const isBusy = busyName === g.name
    const isOwned = !!g.owned
    const isRunning = !!g.running
    const stateBadge = isRunning
      ? `<span class="lazy-deps-badge ok">${escHtml(t('engine.hermesGatewayRunning'))}</span>`
      : `<span class="lazy-deps-badge">${escHtml(t('engine.hermesGatewayStopped'))}</span>`
    const ownedHint = isRunning && !isOwned
      ? `<div class="lazy-deps-card-meta" style="color:var(--warning)">${escHtml(t('engine.hermesGatewayForeign'))}</div>`
      : ''
    return `
      <div class="lazy-deps-card">
        <div class="lazy-deps-card-head">
          <div class="lazy-deps-card-title">${escHtml(g.name)}</div>
          ${stateBadge}
        </div>
        <div class="lazy-deps-card-meta">Profile: <b>${escHtml(g.profile)}</b></div>
        <div class="lazy-deps-card-meta">Port: <code style="font-family:var(--font-mono);font-size:12px">:${g.port}</code></div>
        ${g.pid ? `<div class="lazy-deps-card-meta" style="font-family:var(--font-mono);font-size:11px">PID ${g.pid}</div>` : ''}
        ${ownedHint}
        <div class="lazy-deps-card-actions" style="gap:6px">
          ${isRunning
            ? `<button class="btn btn-secondary btn-sm" data-action="stop" data-name="${escAttr(g.name)}" ${isBusy || !isOwned ? 'disabled' : ''} ${!isOwned ? 'title="' + escAttr(t('engine.hermesGatewayForeignTip')) + '"' : ''}>${escHtml(isBusy ? t('engine.dashStopping') : t('engine.dashStopGw'))}</button>`
            : `<button class="btn btn-primary btn-sm" data-action="start" data-name="${escAttr(g.name)}" ${isBusy ? 'disabled' : ''}>${escHtml(isBusy ? t('engine.gatewayStarting') : t('engine.gatewayStartBtn'))}</button>`}
          <button class="btn btn-secondary btn-sm" data-action="remove" data-name="${escAttr(g.name)}" ${isBusy || isRunning ? 'disabled' : ''} style="color:var(--error)">${escHtml(t('engine.hermesGatewayRemove'))}</button>
        </div>
      </div>
    `
  }

  function bind() {
    el.querySelector('#hm-gws-refresh')?.addEventListener('click', load)
    el.querySelector('#hm-gws-add')?.addEventListener('click', onAdd)
    el.querySelectorAll('[data-action]').forEach(btn => {
      const action = btn.dataset.action
      const name = btn.dataset.name
      btn.addEventListener('click', () => {
        if (action === 'start') onStart(name)
        else if (action === 'stop') onStop(name)
        else if (action === 'remove') onRemove(name)
      })
    })
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      const [gws, profileList] = await Promise.all([
        api.hermesMultiGatewayList(),
        api.hermesProfilesList().catch(() => ({ profiles: [] })),
      ])
      gateways = Array.isArray(gws) ? gws : []
      const arr = Array.isArray(profileList) ? profileList : (profileList?.profiles || [])
      profiles = arr.map(p => (typeof p === 'string' ? p : (p.name || ''))).filter(Boolean)
      if (!profiles.includes('default')) profiles.unshift('default')
    } catch (e) {
      error = String(e?.message || e)
    } finally {
      loading = false
      draw()
    }
  }

  function onAdd() {
    showModal({
      title: t('engine.hermesGatewayAddTitle'),
      fields: [
        {
          name: 'name',
          label: t('engine.hermesGatewayNameLabel'),
          value: '',
          placeholder: 'main, coder, ...',
          hint: t('engine.hermesGatewayNameHint'),
        },
        {
          name: 'profile',
          label: t('engine.hermesGatewayProfileLabel'),
          type: 'select',
          options: profiles.map(p => ({ value: p, label: p })),
          value: profiles[0] || 'default',
          hint: t('engine.hermesGatewayProfileHint'),
        },
      ],
      onConfirm: async (data) => {
        const name = (data.name || '').trim()
        const profile = (data.profile || '').trim()
        if (!name) {
          toast(t('engine.hermesGatewayNameRequired'), 'error')
          return
        }
        try {
          await api.hermesMultiGatewayAdd(name, profile)
          toast(t('engine.hermesGatewayAdded', { name }), 'success')
          await load()
        } catch (e) {
          toast(humanizeError(e, t('engine.hermesGatewayAddFailed')), 'error')
        }
      },
    })
  }

  async function onStart(name) {
    busyName = name
    draw()
    try {
      const result = await api.hermesMultiGatewayStart(name)
      if (result?.warning) {
        toast(t('engine.hermesGatewayStartedWarning', { warning: result.warning }), 'warning')
      } else {
        toast(t('engine.hermesGatewayStarted', { name }), 'success')
      }
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesGatewayStartFailed')), 'error')
    } finally {
      busyName = ''
      draw()
    }
  }

  async function onStop(name) {
    const ok = await showConfirm({
      message: t('engine.hermesGatewayStopConfirm', { name }),
      impact: [t('engine.servicesImpactInflight')],
      confirmText: t('engine.dashStopGw'),
      variant: 'danger',
    })
    if (!ok) return
    busyName = name
    draw()
    try {
      await api.hermesMultiGatewayStop(name)
      toast(t('engine.hermesGatewayStopped', { name }), 'success')
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesGatewayStopFailed')), 'error')
    } finally {
      busyName = ''
      draw()
    }
  }

  async function onRemove(name) {
    const ok = await showConfirm({
      message: t('engine.hermesGatewayRemoveConfirm', { name }),
      confirmText: t('engine.hermesGatewayRemove'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.hermesMultiGatewayRemove(name)
      toast(t('engine.hermesGatewayRemoved', { name }), 'success')
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesGatewayRemoveFailed')), 'error')
    }
  }

  draw()
  load()
  return el
}
