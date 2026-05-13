/**
 * 定时任务管理
 * 通过 Gateway WebSocket RPC 管理（cron.list / cron.add / cron.update / cron.remove / cron.run）
 * 注意：openclaw.json 不支持 cron.jobs 字段，定时任务只能通过 Gateway 在线管理
 */
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { onGatewayChange } from '../lib/app-state.js'
import { wsClient } from '../lib/ws-client.js'
import { api, invalidate } from '../lib/tauri-api.js'
import { t } from '../lib/i18n.js'

let _unsub = null

// ── Cron 表达式快捷预设 ──

function CRON_SHORTCUTS() {
  return [
    { expr: '*/5 * * * *', text: t('cron.cronEvery5min') },
    { expr: '*/15 * * * *', text: t('cron.cronEvery15min') },
    { expr: '0 * * * *', text: t('cron.cronHourly') },
    { expr: '0 9 * * *', text: t('cron.cronDaily9') },
    { expr: '0 18 * * *', text: t('cron.cronDaily18') },
    { expr: '0 9 * * 1', text: t('cron.cronMonday9') },
    { expr: '0 9 1 * *', text: t('cron.cronMonthly1') },
  ]
}

// ── 页面生命周期 ──

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('cron.title')}</h1>
      <p class="page-desc">${t('cron.desc')}</p>
    </div>
    <div id="cron-gw-hint" style="display:none;margin-bottom:var(--space-md)">
      <div class="config-section" style="border-left:3px solid var(--warning);padding:12px 16px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:var(--font-size-sm)">
          ${icon('alert-circle', 16)}
          <span>${t('cron.gwHint')}</span>
          <a href="#/services" class="btn btn-sm btn-secondary" style="margin-left:auto;font-size:11px">${t('cron.goServices')}</a>
        </div>
      </div>
    </div>
    <div id="cron-stats" class="stat-cards" style="margin-bottom:var(--space-lg)"></div>
    <div class="config-actions" style="margin-bottom:var(--space-md)">
      <button class="btn btn-primary btn-sm" id="btn-new-task">${t('cron.newTask')}</button>
      <button class="btn btn-secondary btn-sm" id="btn-refresh-tasks">${t('cron.refresh')}</button>
    </div>
    <div id="cron-list"></div>
  `

  const state = { jobs: [], loading: false }

  page.querySelector('#btn-new-task').onclick = () => openTaskDialog(null, page, state)
  page.querySelector('#btn-refresh-tasks').onclick = () => fetchJobs(page, state)

  // 自动修复：移除可能被写入的无效 cron.jobs 字段
  fixInvalidCronConfig()

  // 监听 Gateway 状态变化
  if (_unsub) _unsub()
  _unsub = onGatewayChange(() => {
    updateGatewayHint(page)
    fetchJobs(page, state)
  })

  updateGatewayHint(page)
  await fetchJobs(page, state)

  return page
}

export function cleanup() {
  if (_unsub) { _unsub(); _unsub = null }
}

/** 自动移除无效的 cron.jobs 字段（之前版本错误写入，会导致 Gateway 崩溃） */
async function fixInvalidCronConfig() {
  try {
    invalidate('read_openclaw_config')
    const config = await api.readOpenclawConfig()
    if (config?.cron?.jobs) {
      delete config.cron.jobs
      if (Object.keys(config.cron).length === 0) delete config.cron
      await api.writeOpenclawConfig(config)
      toast(t('cron.fixedConfig'), 'info')
    }
  } catch {}
}

function isGatewayUp() {
  return wsClient && wsClient.gatewayReady
}

function updateGatewayHint(page) {
  const el = page.querySelector('#cron-gw-hint')
  if (!el) return
  el.style.display = isGatewayUp() ? 'none' : ''
}

// ── 数据加载（Gateway RPC） ──

async function fetchJobs(page, state) {
  if (!isGatewayUp()) {
    state.jobs = []
    state.loading = false
    renderStats(page, state)
    renderList(page, state)
    return
  }

  state.loading = true
  renderList(page, state)

  try {
    const res = await wsClient.request('cron.list', { includeDisabled: true })
    let jobs = res?.jobs || res
    if (!Array.isArray(jobs)) jobs = []

    state.jobs = jobs.map(j => ({
      id: j.id,
      name: j.name || j.id || t('cron.unknown'),
      description: j.description || '',
      message: j.payload?.message || j.payload?.text || '',
      payloadKind: j.payload?.kind || 'agentTurn',
      schedule: j.schedule || {},
      enabled: j.enabled !== false,
      agentId: j.agentId || null,
      delivery: j.delivery || null,
      lastRunStatus: j.state?.lastRunStatus || j.state?.lastStatus || null,
      lastRunAtMs: j.state?.lastRunAtMs || null,
      lastError: j.state?.lastError || null,
    }))
  } catch (e) {
    toast(humanizeError(e, t('cron.fetchFailed')), 'error')
    state.jobs = []
  }

  state.loading = false
  renderStats(page, state)
  renderList(page, state)
}

// ── 统计卡片 ──

function renderStats(page, state) {
  const el = page.querySelector('#cron-stats')
  const total = state.jobs.length
  const active = state.jobs.filter(j => j.enabled).length
  const paused = total - active
  const failed = state.jobs.filter(j => j.lastRunStatus === 'error').length

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">${t('cron.totalTasks')}</span></div>
      <div class="stat-card-value">${total}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">${t('cron.running')}</span></div>
      <div class="stat-card-value" style="color:var(--success)">${active}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">${t('cron.paused')}</span></div>
      <div class="stat-card-value" style="color:var(--text-tertiary)">${paused}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">${t('cron.recentFailed')}</span></div>
      <div class="stat-card-value" style="color:${failed ? 'var(--error)' : 'var(--text-tertiary)'}">${failed}</div>
    </div>
  `
}

// ── 任务列表渲染 ──

function renderList(page, state) {
  const el = page.querySelector('#cron-list')

  if (state.loading) {
    el.innerHTML = `
      <div class="config-section"><div class="stat-card loading-placeholder" style="height:80px"></div></div>
      <div class="config-section"><div class="stat-card loading-placeholder" style="height:80px"></div></div>
    `
    return
  }

  if (!state.jobs.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⏰</div>
        <div class="empty-title">${t('cron.noTasks')}</div>
        <div class="empty-desc">${t('cron.noTasksHint')}</div>
        <div class="empty-cta"><button class="btn btn-primary" data-empty-cta="new-task">${t('cron.newTask')}</button></div>
      </div>
    `
    el.querySelector('[data-empty-cta="new-task"]')?.addEventListener('click', () => {
      page.querySelector('#btn-new-task')?.click()
    })
    return
  }

  el.innerHTML = state.jobs.map(job => {
    const scheduleText = describeCronFull(job.schedule)
    const lastRunOk = job.lastRunStatus === 'ok' || job.lastRunStatus === 'skipped'
    const lastRunHtml = job.lastRunAtMs ? `
      <span style="font-size:var(--font-size-xs);color:${lastRunOk ? 'var(--success)' : 'var(--error)'}">
        ${lastRunOk ? icon('check', 12) : icon('x', 12)} ${relativeTime(job.lastRunAtMs)}
      </span>
    ` : ''

    return `
      <div class="config-section cron-job-card ${job.enabled ? '' : 'disabled'}" data-jid="${job.id}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-weight:600">${escapeHtml(job.name)}</span>
              <span class="cron-badge ${job.enabled ? 'active' : 'paused'}">${job.enabled ? t('cron.statusRunning') : t('cron.statusPaused')}</span>
              ${lastRunHtml}
            </div>
            <div style="font-size:var(--font-size-sm);color:var(--text-tertiary);margin-bottom:6px">
              ${icon('clock', 12)} ${scheduleText}${job.agentId ? ` &middot; Agent: ${escapeHtml(job.agentId)}` : ''}
            </div>
            <div style="font-size:var(--font-size-sm);color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px">
              ${escapeHtml(job.message)}
            </div>
            ${job.lastRunStatus === 'error' && job.lastError ? `
              <div style="margin-top:6px;font-size:var(--font-size-xs);color:var(--error);background:var(--error-muted, #fee2e2);padding:4px 8px;border-radius:var(--radius-sm)">
                ${escapeHtml(job.lastError)}
              </div>
            ` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-sm btn-secondary" data-action="trigger" title="${t('cron.triggerSuccess')}">${icon('play', 14)}</button>
            <button class="btn btn-sm btn-secondary" data-action="toggle">${job.enabled ? icon('pause', 14) : icon('play', 14)}</button>
            <button class="btn btn-sm btn-secondary" data-action="edit">${icon('edit', 14)}</button>
            <button class="btn btn-sm btn-danger" data-action="delete">${icon('trash', 14)}</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  // 绑定事件
  el.querySelectorAll('.cron-job-card').forEach(card => {
    const jid = card.dataset.jid
    const job = state.jobs.find(j => j.id === jid)
    if (!job) return

    card.querySelector('[data-action="trigger"]').onclick = async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      try {
        await wsClient.request('cron.run', { jobId: jid })
        toast(t('cron.triggerSuccess'), 'success')
        setTimeout(() => fetchJobs(page, state), 2000)
      } catch (err) { toast(t('cron.triggerFailed') + ': ' + err, 'error') }
      finally { btn.disabled = false }
    }

    card.querySelector('[data-action="toggle"]').onclick = async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.innerHTML = icon('refresh-cw', 14)
      try {
        await wsClient.request('cron.update', { jobId: jid, patch: { enabled: !job.enabled } })
        toast(job.enabled ? t('cron.togglePaused') : t('cron.toggleEnabled'), 'info')
        await fetchJobs(page, state)
      } catch (err) { toast(t('cron.toggleFailed') + ': ' + err, 'error'); btn.disabled = false; btn.innerHTML = job.enabled ? icon('pause', 14) : icon('play', 14) }
    }

    card.querySelector('[data-action="edit"]').onclick = () => openTaskDialog(job, page, state)

    card.querySelector('[data-action="delete"]').onclick = async function() {
      const btn = this
      const yes = await showConfirm({
        title: t('cron.deleteTitle', { name: job.name }),
        message: t('cron.confirmDelete', { name: job.name }),
        impact: [
          t('cron.deleteImpactStop'),
          t('cron.deleteImpactHistory'),
        ],
        confirmText: t('cron.deleteBtn'),
        cancelText: t('cron.deleteCancel'),
      })
      if (!yes) return
      if (btn) btn.disabled = true
      try {
        await wsClient.request('cron.remove', { jobId: jid })
        toast(t('cron.deleted'), 'info')
        await fetchJobs(page, state)
      } catch (err) { toast(t('cron.deleteFailed') + ': ' + err, 'error'); if (btn) btn.disabled = false }
    }
  })
}

// ── 创建/编辑任务弹窗 ──

async function openTaskDialog(job, page, state) {
  if (!isGatewayUp()) {
    toast(t('cron.gwNotConnected'), 'warning')
    return
  }
  const isEdit = !!job
  const initSchedule = extractCronExpr(job?.schedule) || '0 9 * * *'
  const formId = 'cron-form-' + Date.now()

  const shortcutsHtml = CRON_SHORTCUTS().map(s => {
    const selected = s.expr === initSchedule ? 'selected' : ''
    return `<button type="button" class="btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'} cron-shortcut" data-expr="${s.expr}">${s.text}</button>`
  }).join('')

  // 先用默认选项，弹窗后异步加载 Agent 列表
  const agentOptionsHtml = `<option value="" ${!job?.agentId ? 'selected' : ''}>${t('cron.taskAgentDefault')}</option>${job?.agentId ? `<option value="${escapeAttr(job.agentId)}" selected>${escapeHtml(job.agentId)}</option>` : ''}`

  const content = `
    <form id="${formId}" style="display:flex;flex-direction:column;gap:var(--space-md)">
      <div class="form-group">
        <label class="form-label">${t('cron.taskName')}</label>
        <input class="form-input" name="name" value="${escapeAttr(job?.name || '')}" placeholder="${t('cron.taskNamePlaceholder')}" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">${t('cron.taskMessage')}</label>
        <textarea class="form-input" name="message" rows="3" placeholder="${t('cron.taskMessagePlaceholder')}">${escapeHtml(job?.message || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${t('cron.taskAgent')}</label>
        <select class="form-input" name="agentId">${agentOptionsHtml}</select>
        <div class="form-hint">${t('cron.taskAgentHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('cron.taskDelivery')}</label>
        <select class="form-input" name="deliveryChannel"><option value="">${t('cron.taskDeliveryNone')}</option></select>
        <div class="form-hint">${t('cron.taskDeliveryHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('cron.taskSchedule')}</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${shortcutsHtml}</div>
        <input class="form-input" name="schedule" value="${escapeAttr(initSchedule)}" placeholder="${t('cron.taskSchedulePlaceholder')}">
        <div class="form-hint" id="cron-preview">${describeCron(initSchedule)}</div>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <label class="form-label" style="margin:0">${t('cron.taskEnableNow')}</label>
        <label class="toggle-switch">
          <input type="checkbox" name="enabled" ${job?.enabled !== false ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </form>
  `

  const modal = showContentModal({
    title: isEdit ? t('cron.editTitle') : t('cron.createTitle'),
    content,
    buttons: [
      { label: isEdit ? t('cron.saveEdit') : t('cron.saveCreate'), className: 'btn btn-primary', id: 'btn-cron-save' },
    ],
    width: 500,
  })

  // 异步加载渠道列表
  api.readOpenclawConfig().then(cfg => {
    const channels = cfg?.channels || {}
    const channelIds = Object.keys(channels).filter(k => k !== 'defaults')
    if (channelIds.length === 0) return // 无渠道不需要选
    const select = modal.querySelector('select[name="deliveryChannel"]')
    if (!select) return
    const current = job?.delivery?.channel || ''
    select.innerHTML = `<option value="">${t('cron.taskDeliveryNone')}</option>` + channelIds.map(ch =>
      `<option value="${escapeAttr(ch)}" ${ch === current ? 'selected' : ''}>${escapeHtml(ch)}</option>`
    ).join('')
  }).catch(() => {})

  // 异步加载 Agent 列表并更新下拉框（不阻塞弹窗显示）
  api.listAgents().then(res => {
    const agents = Array.isArray(res) ? res : (res?.agents || [])
    if (!agents.length) return
    const select = modal.querySelector('select[name="agentId"]')
    if (!select) return
    const currentVal = select.value
    select.innerHTML = `<option value="">${t('cron.taskAgentDefault')}</option>` + agents.map(a =>
      `<option value="${escapeAttr(a.id)}" ${a.id === (job?.agentId || currentVal) ? 'selected' : ''}>${escapeHtml(a.name || a.id)}</option>`
    ).join('')
  }).catch(() => {})

  // 快捷预设按钮
  modal.querySelectorAll('.cron-shortcut').forEach(btn => {
    btn.onclick = () => {
      modal.querySelectorAll('.cron-shortcut').forEach(b => {
        b.classList.remove('btn-primary')
        b.classList.add('btn-secondary')
      })
      btn.classList.remove('btn-secondary')
      btn.classList.add('btn-primary')
      const input = modal.querySelector('input[name="schedule"]')
      input.value = btn.dataset.expr
      modal.querySelector('#cron-preview').textContent = describeCron(btn.dataset.expr)
    }
  })

  // 自定义表达式实时预览
  const schedInput = modal.querySelector('input[name="schedule"]')
  schedInput.oninput = () => {
    modal.querySelector('#cron-preview').textContent = describeCron(schedInput.value.trim())
    // 取消预设按钮高亮
    modal.querySelectorAll('.cron-shortcut').forEach(b => {
      b.classList.remove('btn-primary')
      b.classList.add('btn-secondary')
      if (b.dataset.expr === schedInput.value.trim()) {
        b.classList.remove('btn-secondary')
        b.classList.add('btn-primary')
      }
    })
  }

  // 保存
  modal.querySelector('#btn-cron-save').onclick = async () => {
    const name = modal.querySelector('input[name="name"]').value.trim()
    const message = modal.querySelector('textarea[name="message"]').value.trim()
    const schedule = modal.querySelector('input[name="schedule"]').value.trim()
    const agentId = modal.querySelector('select[name="agentId"]').value || undefined
    const enabled = modal.querySelector('input[name="enabled"]').checked

    if (!name) { toast(t('cron.nameRequired'), 'warning'); return }
    if (!message) { toast(t('cron.messageRequired'), 'warning'); return }
    if (!schedule) { toast(t('cron.scheduleRequired'), 'warning'); return }

    const saveBtn = modal.querySelector('#btn-cron-save')
    saveBtn.disabled = true
    saveBtn.textContent = t('cron.saving')

    try {
      if (isEdit) {
        const patch = { name, enabled }
        patch.schedule = { kind: 'cron', expr: schedule }
        patch.payload = { kind: 'agentTurn', message }
        if (agentId) patch.agentId = agentId
        const deliveryChannel = modal.querySelector('select[name="deliveryChannel"]')?.value
        if (deliveryChannel) {
          patch.delivery = { mode: 'announce', channel: deliveryChannel }
        }
        await wsClient.request('cron.update', { jobId: job.id, patch })
        toast(t('cron.updated'), 'success')
      } else {
        const params = {
          name,
          enabled,
          schedule: { kind: 'cron', expr: schedule },
          payload: { kind: 'agentTurn', message },
        }
        if (agentId) params.agentId = agentId
        const deliveryChannel = modal.querySelector('select[name="deliveryChannel"]')?.value
        if (deliveryChannel) {
          params.delivery = { mode: 'announce', channel: deliveryChannel }
        }
        await wsClient.request('cron.add', params)
        toast(t('cron.created'), 'success')
      }
      modal.close?.() || modal.remove?.()
      await fetchJobs(page, state)
    } catch (e) {
      toast(humanizeError(e, t('cron.saveFailed')), 'error')
      saveBtn.disabled = false
      saveBtn.textContent = isEdit ? t('cron.saveEdit') : t('cron.saveCreate')
    }
  }
}

// ── 工具函数 ──

/** 从 Gateway 的 CronSchedule 对象或字符串中提取纯 cron 表达式 */
function extractCronExpr(schedule) {
  if (!schedule) return null
  if (typeof schedule === 'string') return schedule
  if (typeof schedule === 'object' && schedule.expr) return schedule.expr
  if (typeof schedule === 'object' && schedule.kind === 'cron' && schedule.expr) return schedule.expr
  return null
}

/** 将 cron 表达式转为可读文字 */
function describeCron(raw) {
  const expr = typeof raw === 'string' ? raw : extractCronExpr(raw)
  if (!expr) return t('cron.unknownPeriod')

  const hit = CRON_SHORTCUTS().find(s => s.expr === expr)
  if (hit) return hit.text

  const parts = expr.split(' ')
  if (parts.length !== 5) return expr

  const [min, hr, dom, , dow] = parts
  if (min === '*' && hr === '*') return t('cron.everyMinute')
  if (min.startsWith('*/')) return t('cron.everyNMin', { n: min.slice(2) })
  if (hr === '*' && min === '0') return t('cron.hourlyOnTheHour')
  if (dow !== '*' && dom === '*') return `${dow} ${hr}:${min.padStart(2, '0')}`
  if (dom !== '*') return `${dom} ${hr}:${min.padStart(2, '0')}`
  if (hr !== '*') return `${hr}:${min.padStart(2, '0')}`

  return expr
}

/** 将 Gateway 返回的 CronSchedule 对象也处理成可读文字 */
function describeCronFull(schedule) {
  if (!schedule) return t('cron.unknown')
  if (typeof schedule === 'string') return describeCron(schedule)
  if (typeof schedule === 'object') {
    if (schedule.kind === 'every' && schedule.everyMs) {
      const ms = schedule.everyMs
      if (ms < 60000) return t('cron.everyNSec', { n: Math.round(ms / 1000) })
      if (ms < 3600000) return t('cron.everyNMin', { n: Math.round(ms / 60000) })
      return t('cron.everyNHour', { n: Math.round(ms / 3600000) })
    }
    if (schedule.kind === 'at' && schedule.at) {
      try { return t('cron.oneTime') + ': ' + new Date(schedule.at).toLocaleString() } catch { return schedule.at }
    }
    if (schedule.kind === 'cron' && schedule.expr) return describeCron(schedule.expr)
  }
  return String(schedule)
}

/** 相对时间描述 */
function relativeTime(ts) {
  if (!ts) return ''
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = Date.now() - ms
  if (diff < 60000) return t('cron.justNow')
  if (diff < 3600000) return t('cron.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('cron.hoursAgo', { n: Math.floor(diff / 3600000) })
  return t('cron.daysAgo', { n: Math.floor(diff / 86400000) })
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
