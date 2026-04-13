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
    if (gwOnline) await loadJobs()
    loading = false
    draw()
  }

  async function loadJobs() {
    try {
      const data = await gw('/api/jobs')
      jobs = data.jobs || []
      errorMsg = ''
    } catch (e) {
      errorMsg = String(e.message || e)
      jobs = []
    }
  }

  // ── 主渲染 ──

  function draw() {
    if (editingJob) { drawForm(); return }
    const total = jobs.length
    const active = jobs.filter(j => !j.paused).length
    const paused = total - active

    el.innerHTML = `
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <h1 style="margin:0">${t('engine.hermesCronTitle')}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-secondary hm-cron-refresh" title="Refresh" style="padding:4px 10px">${ICONS.refresh}</button>
          <button class="btn btn-primary btn-sm hm-cron-create" ${!gwOnline ? 'disabled' : ''}>${t('engine.cronCreate')}</button>
        </div>
      </div>
      ${errorMsg ? `<div style="color:var(--error);font-size:13px;margin-bottom:12px;padding:8px 12px;background:var(--error-muted, #fee2e2);border-radius:6px">${esc(errorMsg)}</div>` : ''}
      ${!gwOnline ? `
        <div class="card"><div class="card-body" style="padding:32px;text-align:center;color:var(--text-tertiary)">
          <div style="margin-bottom:8px">${ICONS.clock.replace('width="14"', 'width="32"').replace('height="14"', 'height="32"')}</div>
          ${t('engine.chatGatewayOffline')}
        </div></div>
      ` : ''}
      ${gwOnline && !loading ? `
        <!-- 统计卡片 -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div class="card"><div class="card-body" style="padding:12px 16px">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('engine.cronTotal')}</div>
            <div style="font-size:20px;font-weight:700">${total}</div>
          </div></div>
          <div class="card"><div class="card-body" style="padding:12px 16px">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('engine.cronRunning')}</div>
            <div style="font-size:20px;font-weight:700;color:var(--success,#22c55e)">${active}</div>
          </div></div>
          <div class="card"><div class="card-body" style="padding:12px 16px">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('engine.cronPaused')}</div>
            <div style="font-size:20px;font-weight:700;color:var(--text-tertiary)">${paused}</div>
          </div></div>
        </div>
        ${total === 0 ? `
          <div class="card"><div class="card-body" style="padding:40px;text-align:center">
            <div style="margin-bottom:8px;color:var(--text-tertiary)">${ICONS.clock.replace('width="14"', 'width="40"').replace('height="14"', 'height="40"')}</div>
            <div style="font-size:15px;color:var(--text-secondary);margin-bottom:6px">${t('engine.cronNoJobs')}</div>
            <div style="font-size:12px;color:var(--text-tertiary)">${t('engine.cronNoJobsHint')}</div>
          </div></div>
        ` : renderJobList()}
      ` : ''}
      ${loading ? `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          ${[1,2,3].map(() => '<div class="card"><div class="card-body" style="padding:12px 16px"><div class="skeleton-line" style="width:60%;height:12px;margin-bottom:8px"></div><div class="skeleton-line" style="width:40%;height:20px"></div></div></div>').join('')}
        </div>
        ${[1,2].map(() => '<div class="card" style="margin-bottom:12px"><div class="card-body" style="padding:16px"><div class="skeleton-line" style="width:50%;height:14px;margin-bottom:8px"></div><div class="skeleton-line" style="width:70%;height:12px"></div></div></div>').join('')}
      ` : ''}
    `
    bindList()
  }

  function renderJobList() {
    return `<div style="display:flex;flex-direction:column;gap:10px">${jobs.map(j => {
      const expr = extractCronExpr(j.schedule)
      const desc = describeCron(j.schedule)
      const id = esc(j.id || j.name)
      return `
      <div class="card hm-cron-item" data-id="${id}" style="transition:opacity .2s;${j.paused ? 'opacity:0.65' : ''}">
        <div class="card-body" style="padding:14px 18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span style="font-weight:600;font-size:14px">${esc(j.name)}</span>
                <span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:500;background:${j.paused ? 'var(--bg-tertiary)' : 'rgba(34,197,94,0.1)'};color:${j.paused ? 'var(--text-tertiary)' : 'var(--success,#22c55e)'}">${j.paused ? t('engine.cronPaused') : t('engine.cronActive')}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-tertiary);margin-bottom:2px">
                ${ICONS.clock}
                <span>${esc(desc)}</span>
                <code style="font-size:11px;padding:1px 6px;background:var(--bg-tertiary);border-radius:4px;color:var(--text-secondary)">${esc(expr)}</code>
              </div>
              ${j.prompt ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.prompt)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="btn btn-sm btn-secondary hm-cron-toggle" data-id="${id}" data-paused="${j.paused ? '1' : '0'}" title="${j.paused ? 'Resume' : 'Pause'}" style="padding:5px 8px">${j.paused ? ICONS.play : ICONS.pause}</button>
              <button class="btn btn-sm btn-secondary hm-cron-run" data-id="${id}" title="${t('engine.cronRunNow')}" style="padding:5px 8px">${ICONS.zap}</button>
              <button class="btn btn-sm btn-secondary hm-cron-edit" data-id="${id}" title="${t('engine.cronEdit')}" style="padding:5px 8px">${ICONS.edit}</button>
              <button class="btn btn-sm btn-secondary hm-cron-del" data-id="${id}" title="${t('engine.cronDelete')}" style="padding:5px 8px;color:var(--error)">${ICONS.trash}</button>
            </div>
          </div>
        </div>
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

  function drawForm() {
    const isEdit = !!editingJob._editing
    const id = editingJob.id || editingJob.name
    const initSchedule = editingJob.schedule || '0 9 * * *'

    const shortcutsHtml = CRON_SHORTCUTS().map(s => {
      const selected = s.expr === initSchedule
      return `<button type="button" class="btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'} hm-cron-shortcut" data-expr="${escAttr(s.expr)}" style="font-size:11px;padding:3px 10px">${s.text}</button>`
    }).join('')

    el.innerHTML = `
      <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <button class="btn btn-sm btn-secondary hm-cron-back" style="padding:5px 8px">${ICONS.back}</button>
        <h1 style="margin:0">${isEdit ? t('engine.cronEdit') + ' — ' + esc(editingJob.name) : t('engine.cronCreate')}</h1>
      </div>
      ${errorMsg ? `<div style="color:var(--error);font-size:13px;margin-bottom:12px;padding:8px 12px;background:var(--error-muted, #fee2e2);border-radius:6px">${esc(errorMsg)}</div>` : ''}
      <div class="card">
        <div class="card-body" style="padding:24px;display:flex;flex-direction:column;gap:18px">

          <div>
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">${t('engine.cronName')}</label>
            <input class="input" id="hm-cron-name" value="${escAttr(editingJob.name)}" placeholder="${t('engine.cronName')}" style="width:100%" ${isEdit ? 'disabled' : ''}>
          </div>

          <div>
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">${t('engine.cronSchedule')}</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${shortcutsHtml}</div>
            <input class="input" id="hm-cron-schedule" value="${escAttr(initSchedule)}" placeholder="0 9 * * *" style="width:100%;font-family:var(--font-mono,monospace)">
            <div id="hm-cron-preview" style="font-size:12px;color:var(--text-tertiary);margin-top:6px;display:flex;align-items:center;gap:6px">
              ${ICONS.clock} <span>${describeCron(initSchedule)}</span>
            </div>
          </div>

          <div>
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">${t('engine.cronPrompt')}</label>
            <textarea class="input" id="hm-cron-prompt" rows="4" style="width:100%;resize:vertical;font-size:13px;line-height:1.5" placeholder="${t('engine.cronPrompt')}">${esc(editingJob.prompt || '')}</textarea>
          </div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button class="btn btn-primary btn-sm hm-cron-save" ${busy ? 'disabled' : ''}>${busy ? t('engine.cronSaving') : t('engine.cronSave')}</button>
            <button class="btn btn-secondary btn-sm hm-cron-cancel">${t('engine.cronCancel')}</button>
          </div>
        </div>
      </div>
    `
    bindForm(isEdit, id)
  }

  function bindForm(isEdit, id) {
    el.querySelector('.hm-cron-back')?.addEventListener('click', () => { editingJob = null; errorMsg = ''; draw() })
    el.querySelector('.hm-cron-cancel')?.addEventListener('click', () => { editingJob = null; errorMsg = ''; draw() })

    // 快捷预设
    el.querySelectorAll('.hm-cron-shortcut').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.hm-cron-shortcut').forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-secondary') })
        btn.classList.remove('btn-secondary'); btn.classList.add('btn-primary')
        const input = el.querySelector('#hm-cron-schedule')
        input.value = btn.dataset.expr
        updatePreview(btn.dataset.expr)
      })
    })

    // 实时预览
    const schedInput = el.querySelector('#hm-cron-schedule')
    schedInput?.addEventListener('input', () => {
      const val = schedInput.value.trim()
      updatePreview(val)
      el.querySelectorAll('.hm-cron-shortcut').forEach(b => {
        b.classList.remove('btn-primary'); b.classList.add('btn-secondary')
        if (b.dataset.expr === val) { b.classList.remove('btn-secondary'); b.classList.add('btn-primary') }
      })
    })

    // 保存
    el.querySelector('.hm-cron-save')?.addEventListener('click', async () => {
      const name = el.querySelector('#hm-cron-name')?.value?.trim()
      const schedule = el.querySelector('#hm-cron-schedule')?.value?.trim()
      const prompt = el.querySelector('#hm-cron-prompt')?.value?.trim()
      if (!name) { errorMsg = t('engine.cronNameRequired'); draw(); return }
      if (!schedule) { errorMsg = t('engine.cronScheduleRequired'); draw(); return }
      if (!prompt) { errorMsg = t('engine.cronPromptRequired'); draw(); return }
      busy = true; errorMsg = ''; draw()
      try {
        if (isEdit) {
          await gw(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ schedule: { kind: 'cron', expr: schedule }, prompt }) })
        } else {
          await gw('/api/jobs', { method: 'POST', body: JSON.stringify({ name, schedule: { kind: 'cron', expr: schedule }, prompt }) })
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
