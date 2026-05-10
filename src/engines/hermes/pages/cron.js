/**
 * Hermes Agent 定时任务管理
 * 通过 Gateway /api/jobs REST API 管理 cron jobs
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

// ── Schedule 解析工具 ──

function extractCronExpr(schedule) {
  if (!schedule) return ''
  if (typeof schedule === 'string') return schedule
  return schedule.expr || schedule.display || schedule.cron || schedule.value || ''
}

function CRON_SHORTCUTS() {
  return [
    { expr: '*/5 * * * *', text: t('engine.cronEvery5min') },
    { expr: '*/15 * * * *', text: t('engine.cronEvery15min') },
    { expr: '0 * * * *', text: t('engine.cronHourly') },
    { expr: '0 9 * * *', text: t('engine.cronDaily9') },
    { expr: '0 18 * * *', text: t('engine.cronDaily18') },
    { expr: '0 9 * * 1', text: t('engine.cronMonday9') },
    { expr: '0 9 1 * *', text: t('engine.cronMonthly1') },
  ]
}

function describeCron(raw) {
  const expr = typeof raw === 'string' ? raw : extractCronExpr(raw)
  if (!expr) return ''
  const hit = CRON_SHORTCUTS().find(s => s.expr === expr)
  if (hit) return hit.text
  const parts = expr.split(' ')
  if (parts.length !== 5) return expr
  const [min, hr, dom, , dow] = parts
  if (min === '*' && hr === '*') return t('engine.cronEveryMinute')
  if (min.startsWith('*/')) return t('engine.cronEveryNMin').replace('{n}', min.slice(2))
  if (hr === '*' && min === '0') return t('engine.cronHourlyOnTheHour')
  if (dow !== '*' && dom === '*') {
    const days = ['日', '一', '二', '三', '四', '五', '六']
    const d = parseInt(dow)
    return `每周${isNaN(d) ? dow : (days[d] || dow)} ${hr}:${min.padStart(2, '0')}`
  }
  if (dom !== '*') return `每月${dom}日 ${hr}:${min.padStart(2, '0')}`
  if (hr !== '*') return `每天 ${hr}:${min.padStart(2, '0')}`
  return expr
}

// ── SVG Icons ──

const ICONS = {
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  zap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let jobs = []
  let gwOnline = false
  let loading = true
  let editingJob = null
  let busy = false
  let errorMsg = ''

  async function gw(path, opts = {}) {
    return await api.hermesApiProxy((opts.method || 'GET').toUpperCase(), path, opts.body || null)
  }

  async function init() {
    try {
      const info = await api.checkHermes()
      gwOnline = !!info?.gatewayRunning
    } catch (_) {}
    await loadJobs()
    loading = false
    draw()
  }

  async function loadJobs() {
    try {
      if (gwOnline) {
        const data = await gw('/api/jobs')
        jobs = data.jobs || []
      } else {
        const data = await api.hermesCronJobsList()
        jobs = Array.isArray(data) ? data : []
      }
      errorMsg = ''
    } catch (e) {
      try {
        const data = await api.hermesCronJobsList()
        jobs = Array.isArray(data) ? data : []
        errorMsg = ''
      } catch (_) {
        errorMsg = String(e.message || e)
        jobs = []
      }
    }
  }

  // ── 主渲染 ──

  // ── Helpers ──

  /**
   * Derive a semantic job state label.
   * Priority: running > paused > disabled > scheduled
   */
  function jobStateOf(j) {
    if (j.state === 'running') return 'running'
    if (j.state === 'paused' || j.paused) return 'paused'
    if (j.enabled === false) return 'disabled'
    return 'scheduled'
  }

  /** Format any server-side timestamp (ISO / epoch-sec / epoch-ms) → local. */
  function fmtJobTime(ts) {
    if (!ts && ts !== 0) return '—'
    let d
    if (typeof ts === 'number') {
      d = new Date(ts > 1e12 ? ts : ts * 1000)
    } else {
      d = new Date(ts)
    }
    if (isNaN(d.getTime())) return String(ts)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** Human-friendly "in X minutes" hint for next_run_at. */
  function relativeFuture(ts) {
    if (!ts && ts !== 0) return ''
    let d
    if (typeof ts === 'number') d = new Date(ts > 1e12 ? ts : ts * 1000)
    else d = new Date(ts)
    const diff = Math.floor((d.getTime() - Date.now()) / 1000)
    if (diff < 0) return t('engine.cronOverdue')
    if (diff < 60) return t('engine.cronInSeconds').replace('{n}', diff)
    if (diff < 3600) return t('engine.cronInMinutes').replace('{n}', Math.floor(diff / 60))
    if (diff < 86400) return t('engine.cronInHours').replace('{n}', Math.floor(diff / 3600))
    return t('engine.cronInDays').replace('{n}', Math.floor(diff / 86400))
  }

  // ── 主渲染 ──

  function draw() {
    if (editingJob) { drawForm(); return }
    const total = jobs.length
    const runningCount = jobs.filter(j => jobStateOf(j) === 'running').length
    const paused = jobs.filter(j => jobStateOf(j) === 'paused').length
    const failed = jobs.filter(j => j.last_status && j.last_status !== 'ok').length

    el.innerHTML = `
      <!-- Editorial hero -->
      <div class="hm-hero" data-state="${gwOnline ? 'running' : 'stopped'}">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <span class="hm-dot hm-dot--${gwOnline ? 'run' : 'stop'}"></span>
            ${t('engine.cronEyebrow')}
          </div>
          <h1 class="hm-hero-h1">${t('engine.hermesCronTitle')}</h1>
          <div class="hm-hero-sub">${total} ${t('engine.cronJobs')} · ${runningCount} ${t('engine.cronRunning').toLowerCase()}</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm hm-cron-refresh" ${!gwOnline || loading ? 'disabled' : ''} title="${t('engine.logsRefresh')}">
            ${ICONS.refresh} ${t('engine.logsRefresh')}
          </button>
          <button class="hm-btn hm-btn--cta hm-cron-create" ${!gwOnline ? 'disabled' : ''}>
            + ${t('engine.cronCreate')}
          </button>
        </div>
      </div>

      ${errorMsg ? `
        <div class="hm-panel" style="margin-bottom:16px">
          <div class="hm-panel-body hm-panel-body--tight">
            <div style="color:var(--hm-error);font-family:var(--hm-font-mono);font-size:12.5px">${esc(errorMsg)}</div>
          </div>
        </div>
      ` : ''}

      ${!gwOnline ? `
        <div class="hm-panel"><div class="hm-panel-body" style="text-align:center;padding:40px 28px">
          <div style="margin-bottom:10px;color:var(--hm-text-muted)">${ICONS.clock.replace('width="14"', 'width="32"').replace('height="14"', 'height="32"')}</div>
          <div style="font-family:var(--hm-font-serif);font-style:italic;font-size:15px;color:var(--hm-text-tertiary)">${t('engine.chatGatewayOffline')}</div>
        </div></div>
      ` : ''}

      ${gwOnline && !loading ? `
        <!-- KPI grid (4 stats) -->
        <div class="hm-kpi-grid">
          <div class="hm-kpi" data-tone="accent">
            <div class="hm-kpi-label">${t('engine.cronTotal')}</div>
            <div class="hm-kpi-value">${total}</div>
            <div class="hm-kpi-foot">jobs defined</div>
          </div>
          <div class="hm-kpi" data-tone="success">
            <div class="hm-kpi-label">${t('engine.cronRunning')}</div>
            <div class="hm-kpi-value">${runningCount}</div>
            <div class="hm-kpi-foot">actively executing</div>
          </div>
          <div class="hm-kpi" data-tone="${paused > 0 ? 'warn' : ''}">
            <div class="hm-kpi-label">${t('engine.cronPaused')}</div>
            <div class="hm-kpi-value">${paused}</div>
            <div class="hm-kpi-foot">manually paused</div>
          </div>
          <div class="hm-kpi" data-tone="${failed > 0 ? 'error' : ''}">
            <div class="hm-kpi-label">${t('engine.cronFailed')}</div>
            <div class="hm-kpi-value">${failed}</div>
            <div class="hm-kpi-foot">last run failed</div>
          </div>
        </div>

        ${total === 0 ? `
          <div class="hm-panel"><div class="hm-panel-body" style="text-align:center;padding:48px 28px">
            <div style="margin-bottom:12px;color:var(--hm-text-muted)">${ICONS.clock.replace('width="14"', 'width="40"').replace('height="14"', 'height="40"')}</div>
            <div style="font-family:var(--hm-font-serif);font-size:16px;color:var(--hm-text-secondary);margin-bottom:6px">${t('engine.cronNoJobs')}</div>
            <div class="hm-muted">${t('engine.cronNoJobsHint')}</div>
          </div></div>
        ` : renderJobList()}
      ` : ''}

      ${loading ? `
        <div class="hm-kpi-grid">
          ${[1,2,3,4].map(() => `<div class="hm-kpi">
            <div class="hm-skel" style="width:60%;height:11px;margin-bottom:10px"></div>
            <div class="hm-skel" style="width:40%;height:20px;margin-bottom:8px"></div>
            <div class="hm-skel" style="width:50%;height:10px"></div>
          </div>`).join('')}
        </div>
        ${[1,2].map(() => `<div class="hm-panel" style="margin-bottom:12px"><div class="hm-panel-body">
          <div class="hm-skel" style="width:30%;height:14px;margin-bottom:10px"></div>
          <div class="hm-skel" style="width:60%;height:12px"></div>
        </div></div>`).join('')}
      ` : ''}
    `
    bindList()
  }

  function renderJobList() {
    return `<div class="hm-cron-list">${jobs.map(j => {
      const expr = extractCronExpr(j.schedule)
      const desc = describeCron(j.schedule)
      const id = esc(j.id || j.job_id || j.name)
      const state = jobStateOf(j)
      const stateBadge = {
        running:   { cls: 'hm-badge--accent',  label: t('engine.cronStateRunning') },
        paused:    { cls: 'hm-badge--warn',    label: t('engine.cronStatePaused') },
        disabled:  { cls: 'hm-badge--error',   label: t('engine.cronStateDisabled') },
        scheduled: { cls: 'hm-badge--success', label: t('engine.cronStateScheduled') },
      }[state]
      const lastStatus = j.last_status
        ? (j.last_status === 'ok'
            ? `<span class="hm-cron-last-ok">✓ ok</span>`
            : `<span class="hm-cron-last-err" title="${esc(j.last_error || '')}">✗ ${esc(j.last_status)}</span>`)
        : ''
      const repeatTxt = j.repeat && typeof j.repeat === 'object'
        ? `${j.repeat.completed ?? 0} / ${j.repeat.times ?? '∞'}`
        : (typeof j.repeat === 'string' ? j.repeat : '')
      const deliverLabel = j.deliver
        ? (j.deliver === 'origin' && j.origin
            ? `${esc(j.deliver)} (${esc(j.origin.platform || '')})`
            : esc(j.deliver))
        : '—'
      const promptPreview = j.prompt_preview || j.prompt || ''

      return `
        <div class="hm-panel hm-cron-item" data-id="${id}" data-state="${state}">
          <div class="hm-cron-head">
            <div class="hm-cron-head-left">
              <div class="hm-cron-title-row">
                <span class="hm-cron-name">${esc(j.name)}</span>
                <span class="hm-badge ${stateBadge.cls}">${stateBadge.label}</span>
              </div>
              ${promptPreview ? `<div class="hm-cron-prompt">${esc(promptPreview)}</div>` : ''}
            </div>
            <div class="hm-cron-actions">
              <button class="hm-btn hm-btn--icon hm-cron-toggle" data-id="${id}" data-paused="${state === 'paused' ? '1' : '0'}" title="${state === 'paused' ? t('engine.cronResume') : t('engine.cronPauseBtn')}">
                ${state === 'paused' ? ICONS.play : ICONS.pause}
              </button>
              <button class="hm-btn hm-btn--icon hm-cron-run" data-id="${id}" title="${t('engine.cronRunNow')}">${ICONS.zap}</button>
              <button class="hm-btn hm-btn--icon hm-cron-edit" data-id="${id}" title="${t('engine.cronEdit')}">${ICONS.edit}</button>
              <button class="hm-btn hm-btn--icon hm-cron-del" data-id="${id}" title="${t('engine.cronDelete')}" style="color:var(--hm-error)">${ICONS.trash}</button>
            </div>
          </div>
          <div class="hm-cron-meta">
            <div class="hm-cron-meta-item">
              <span class="hm-cron-meta-label">${t('engine.cronScheduleLabel')}</span>
              <span class="hm-cron-meta-value">
                <span class="hm-cron-schedule-desc">${esc(desc)}</span>
                <code class="hm-code hm-cron-schedule-expr">${esc(expr)}</code>
              </span>
            </div>
            <div class="hm-cron-meta-item">
              <span class="hm-cron-meta-label">${t('engine.cronNextRun')}</span>
              <span class="hm-cron-meta-value">
                ${esc(fmtJobTime(j.next_run_at))}
                ${j.next_run_at ? `<span class="hm-cron-rel">${esc(relativeFuture(j.next_run_at))}</span>` : ''}
              </span>
            </div>
            <div class="hm-cron-meta-item">
              <span class="hm-cron-meta-label">${t('engine.cronLastRun')}</span>
              <span class="hm-cron-meta-value">
                ${esc(fmtJobTime(j.last_run_at))}
                ${lastStatus}
              </span>
            </div>
            <div class="hm-cron-meta-item">
              <span class="hm-cron-meta-label">${t('engine.cronDeliverLabel')}</span>
              <span class="hm-cron-meta-value">${deliverLabel}</span>
            </div>
            ${repeatTxt ? `
              <div class="hm-cron-meta-item">
                <span class="hm-cron-meta-label">${t('engine.cronRepeatLabel')}</span>
                <span class="hm-cron-meta-value">${esc(repeatTxt)}</span>
              </div>
            ` : ''}
            ${Array.isArray(j.skills) && j.skills.length ? `
              <div class="hm-cron-meta-item hm-cron-meta-item--skills">
                <span class="hm-cron-meta-label">${t('engine.cronSkillsLabel')}</span>
                <span class="hm-cron-meta-value">${j.skills.map(s => `<span class="hm-cron-skill-tag">${esc(s)}</span>`).join('')}</span>
              </div>
            ` : ''}
          </div>
          ${j.last_error ? `
            <div class="hm-cron-err">
              <span class="hm-cron-err-label">${t('engine.cronLastError')}</span>
              <code class="hm-cron-err-msg">${esc(j.last_error)}</code>
            </div>
          ` : ''}
        </div>`
    }).join('')}</div>`
  }

  function bindList() {
    el.querySelector('.hm-cron-create')?.addEventListener('click', () => {
      editingJob = { name: '', schedule: '0 9 * * *', prompt: '' }
      draw()
    })
    el.querySelector('.hm-cron-refresh')?.addEventListener('click', async () => {
      loading = true; draw()
      await loadJobs()
      loading = false; draw()
    })
    el.querySelectorAll('.hm-cron-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id
        const paused = btn.dataset.paused === '1'
        btn.disabled = true
        try { await gw(`/api/jobs/${encodeURIComponent(id)}/${paused ? 'resume' : 'pause'}`, { method: 'POST' }) } catch (_) {}
        await loadJobs(); draw()
      })
    })
    el.querySelectorAll('.hm-cron-run').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        try {
          await gw(`/api/jobs/${encodeURIComponent(btn.dataset.id)}/run`, { method: 'POST' })
          // 成功反馈：短暂闪烁绿色
          btn.style.color = 'var(--success,#22c55e)'
          btn.innerHTML = '✓'
          setTimeout(() => { btn.innerHTML = ICONS.zap; btn.style.color = ''; btn.disabled = false }, 1500)
        } catch (_) {
          btn.style.color = 'var(--error)'
          btn.innerHTML = '✕'
          setTimeout(() => { btn.innerHTML = ICONS.zap; btn.style.color = ''; btn.disabled = false }, 1500)
        }
      })
    })
    el.querySelectorAll('.hm-cron-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const job = jobs.find(j => (j.id || j.name) === btn.dataset.id)
        if (job) { editingJob = { ...job, schedule: extractCronExpr(job.schedule), _editing: true }; draw() }
      })
    })
    el.querySelectorAll('.hm-cron-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const job = jobs.find(j => (j.id || j.name) === btn.dataset.id)
        const msg = t('engine.cronConfirmDelete').replace('{name}', job?.name || btn.dataset.id)
        if (!confirm(msg)) return
        btn.disabled = true
        try { await gw(`/api/jobs/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }) } catch (_) {}
        await loadJobs(); draw()
      })
    })
  }

  // ── 创建/编辑表单 ──

  /** Light cron expression sanity check — 5 space-separated fields. */
  function validateCron(expr) {
    if (!expr) return false
    const parts = expr.trim().split(/\s+/)
    return parts.length === 5
  }

  function drawForm() {
    const isEdit = !!editingJob._editing
    const id = editingJob.id || editingJob.job_id || editingJob.name
    const initSchedule = editingJob.schedule || '0 9 * * *'
    const initDeliver = editingJob.deliver || 'origin'
    const initRepeat = editingJob.repeat_times != null
      ? editingJob.repeat_times
      : (typeof editingJob.repeat === 'number'
          ? editingJob.repeat
          : (typeof editingJob.repeat === 'object' ? editingJob.repeat?.times : ''))

    const shortcutsHtml = CRON_SHORTCUTS().map(s => {
      const selected = s.expr === initSchedule
      return `<button type="button" class="hm-pill hm-cron-shortcut ${selected ? 'is-active' : ''}" data-expr="${escAttr(s.expr)}">${s.text}</button>`
    }).join('')

    el.innerHTML = `
      <!-- Back hero -->
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <button class="hm-cron-back" style="color:inherit;background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font:inherit;padding:0">
              ${ICONS.back} ${t('engine.hermesCronTitle')}
            </button>
          </div>
          <h1 class="hm-hero-h1">${isEdit ? t('engine.cronEdit') : t('engine.cronCreate')}</h1>
          <div class="hm-hero-sub">${isEdit ? esc(editingJob.name) : t('engine.cronNoJobsHint')}</div>
        </div>
      </div>

      ${errorMsg ? `
        <div class="hm-panel" style="margin-bottom:16px">
          <div class="hm-panel-body hm-panel-body--tight">
            <div style="color:var(--hm-error);font-family:var(--hm-font-mono);font-size:12.5px">${esc(errorMsg)}</div>
          </div>
        </div>
      ` : ''}

      <div class="hm-panel">
        <div class="hm-panel-body" style="display:flex;flex-direction:column;gap:22px">

          <!-- Name -->
          <label class="hm-field">
            <span class="hm-field-label">${t('engine.cronName')}</span>
            <input class="hm-input" id="hm-cron-name" value="${escAttr(editingJob.name)}" placeholder="daily-standup-summary" ${isEdit ? 'disabled' : ''}>
          </label>

          <!-- Schedule -->
          <div class="hm-field">
            <span class="hm-field-label">${t('engine.cronSchedule')}</span>
            <div class="hm-pills" style="margin-bottom:10px">${shortcutsHtml}</div>
            <input class="hm-input" id="hm-cron-schedule" value="${escAttr(initSchedule)}" placeholder="0 9 * * *">
            <div id="hm-cron-preview" class="hm-muted" style="margin-top:6px;display:flex;align-items:center;gap:6px">
              ${ICONS.clock} <span>${describeCron(initSchedule)}</span>
            </div>
          </div>

          <!-- Prompt -->
          <label class="hm-field">
            <span class="hm-field-label">${t('engine.cronPrompt')}</span>
            <textarea class="hm-input" id="hm-cron-prompt" rows="5" style="resize:vertical;height:auto;min-height:120px;line-height:1.6;padding:12px 14px" placeholder="e.g. Summarize today's standup and post to the team channel">${esc(editingJob.prompt || '')}</textarea>
          </label>

          <!-- Deliver + Repeat (side-by-side) -->
          <div class="hm-field-row">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.cronDeliverLabel')}</span>
              <select class="hm-input" id="hm-cron-deliver">
                <option value="origin" ${initDeliver === 'origin' ? 'selected' : ''}>${t('engine.cronDeliverOrigin')}</option>
                <option value="local"  ${initDeliver === 'local'  ? 'selected' : ''}>${t('engine.cronDeliverLocal')}</option>
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.cronRepeatLimit')}</span>
              <input class="hm-input" id="hm-cron-repeat" type="number" min="1" step="1" value="${initRepeat != null && initRepeat !== '' ? String(initRepeat) : ''}" placeholder="∞">
              <span class="hm-muted" style="margin-top:4px">${t('engine.cronRepeatLimitHint')}</span>
            </label>
          </div>

          <div class="hm-stack" style="margin-top:8px">
            <button class="hm-btn hm-btn--cta hm-cron-save" ${busy ? 'disabled' : ''}>${busy ? t('engine.cronSaving') : t('engine.cronSave')}</button>
            <button class="hm-btn hm-btn--sm hm-cron-cancel">${t('engine.cronCancel')}</button>
          </div>
        </div>
      </div>
    `
    bindForm(isEdit, id)
  }

  function bindForm(isEdit, id) {
    el.querySelector('.hm-cron-back')?.addEventListener('click', () => { editingJob = null; errorMsg = ''; draw() })
    el.querySelector('.hm-cron-cancel')?.addEventListener('click', () => { editingJob = null; errorMsg = ''; draw() })

    // Cron shortcut pills
    el.querySelectorAll('.hm-cron-shortcut').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.hm-cron-shortcut').forEach(b => b.classList.remove('is-active'))
        btn.classList.add('is-active')
        const input = el.querySelector('#hm-cron-schedule')
        input.value = btn.dataset.expr
        updatePreview(btn.dataset.expr)
      })
    })

    // Live preview & sync shortcut highlight
    const schedInput = el.querySelector('#hm-cron-schedule')
    schedInput?.addEventListener('input', () => {
      const val = schedInput.value.trim()
      updatePreview(val)
      el.querySelectorAll('.hm-cron-shortcut').forEach(b => {
        b.classList.toggle('is-active', b.dataset.expr === val)
      })
    })

    // Save
    el.querySelector('.hm-cron-save')?.addEventListener('click', async () => {
      const name     = el.querySelector('#hm-cron-name')?.value?.trim()
      const schedule = el.querySelector('#hm-cron-schedule')?.value?.trim()
      const prompt   = el.querySelector('#hm-cron-prompt')?.value?.trim()
      const deliver  = el.querySelector('#hm-cron-deliver')?.value || 'origin'
      const repeatRaw = el.querySelector('#hm-cron-repeat')?.value?.trim()
      const repeat = repeatRaw ? parseInt(repeatRaw, 10) : undefined

      if (!name)                  { errorMsg = t('engine.cronNameRequired');     draw(); return }
      if (!schedule)              { errorMsg = t('engine.cronScheduleRequired'); draw(); return }
      if (!validateCron(schedule)){ errorMsg = t('engine.cronInvalidCron');      draw(); return }
      if (!prompt)                { errorMsg = t('engine.cronPromptRequired');   draw(); return }
      if (repeat !== undefined && (Number.isNaN(repeat) || repeat < 1)) {
        errorMsg = t('engine.cronRepeatLimit'); draw(); return
      }

      busy = true; errorMsg = ''; draw()
      try {
        const payload = {
          name,
          schedule: { kind: 'cron', expr: schedule },
          prompt,
          deliver,
        }
        if (repeat !== undefined) payload.repeat = repeat

        if (isEdit) {
          // PATCH does not accept `name`.
          const patch = { schedule: payload.schedule, prompt, deliver }
          if (repeat !== undefined) patch.repeat = repeat
          await gw(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
        } else {
          await gw('/api/jobs', { method: 'POST', body: JSON.stringify(payload) })
        }
        editingJob = null
        await loadJobs()
      } catch (e) {
        errorMsg = String(e.message || e)
      }
      busy = false; draw()
    })
  }

  function updatePreview(expr) {
    const previewEl = el.querySelector('#hm-cron-preview span')
    if (previewEl) previewEl.textContent = describeCron(expr) || expr
  }

  init()
  return el
}
