/**
 * 定时任务管理（本地调度 + WSS 发送）
 * 任务存储在 panel config，本地调度器在 Gateway 连接后发送 user 消息
 */
import { toast } from '../components/toast.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { onGatewayChange } from '../lib/app-state.js'
import { wsClient, uuid } from '../lib/ws-client.js'
import { api } from '../lib/tauri-api.js'

let _unsub = null
let _schedulerTimer = null
let _lastSessionActivity = new Map() // sessionKey -> ts
let _sessionLabelMap = new Map() // label -> sessionKey
let _sessionLabelLastFetch = 0

// ── Cron 表达式快捷预设 ──

const CRON_SHORTCUTS = [
  { expr: '*/5 * * * *', text: '每 5 分钟' },
  { expr: '*/15 * * * *', text: '每 15 分钟' },
  { expr: '0 * * * *', text: '每小时整点' },
  { expr: '0 9 * * *', text: '每天 9:00' },
  { expr: '0 18 * * *', text: '每天 18:00' },
  { expr: '0 9 * * 1', text: '每周一 9:00' },
  { expr: '0 9 1 * *', text: '每月 1 号 9:00' },
]

const LOCAL_CRON_KEY = 'localCronJobs'
const SESSION_IDLE_MS = 5000
const SCHEDULER_INTERVAL_MS = 10000

function parseSessionLabel(key) {
  const parts = (key || '').split(':')
  if (parts.length < 3) return key || '未知'
  const agent = parts[1] || 'main'
  const channel = parts.slice(2).join(':')
  if (agent === 'main' && channel === 'main') return '主会话'
  if (agent === 'main') return channel
  return `${agent} / ${channel}`
}

// ── 页面生命周期 ──

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">定时任务</h1>
      <p class="page-desc">创建计划任务，让 AI 按设定时间自动执行指令</p>
    </div>
    <div id="cron-gw-hint" style="display:none;margin-bottom:var(--space-md)">
      <div class="config-section" style="border-left:3px solid var(--warning);padding:12px 16px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:var(--font-size-sm)">
          ${icon('alert-circle', 16)}
          <span>本地定时任务需要 Gateway 连接后才能发送消息。</span>
          <a href="#/services" class="btn btn-sm btn-secondary" style="margin-left:auto;font-size:11px">服务管理</a>
        </div>
      </div>
    </div>
    <div id="cron-stats" class="stat-cards" style="margin-bottom:var(--space-lg)"></div>
    <div class="config-actions" style="margin-bottom:var(--space-md)">
      <button class="btn btn-primary btn-sm" id="btn-new-task">+ 创建任务</button>
      <button class="btn btn-secondary btn-sm" id="btn-refresh-tasks">刷新</button>
    </div>
    <div id="cron-list"></div>
  `

  const state = { jobs: [], loading: false }

  page.querySelector('#btn-new-task').onclick = () => openTaskDialog(null, page, state)
  page.querySelector('#btn-refresh-tasks').onclick = () => fetchJobs(page, state)

  // 监听 Gateway 状态变化
  if (_unsub) _unsub()
  _unsub = onGatewayChange(() => {
    updateGatewayHint(page)
    fetchJobs(page, state)
    restartScheduler(page, state)
  })

  updateGatewayHint(page)
  await fetchJobs(page, state)
  attachSessionActivityListener()
  restartScheduler(page, state)

  return page
}

export function cleanup() {
  if (_unsub) { _unsub(); _unsub = null }
  stopScheduler()
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
  state.loading = true
  renderList(page, state)

  try {
    const cfg = (await api.readPanelConfig()) || {}
    const jobs = Array.isArray(cfg?.[LOCAL_CRON_KEY]) ? cfg[LOCAL_CRON_KEY] : []
    state.jobs = jobs.map(j => ({
      id: j.id,
      name: j.name || j.id || '未命名',
      message: j.payload?.message || '',
      payloadKind: 'sessionMessage',
      sessionLabel: j.payload?.label || '',
      schedule: j.schedule || {},
      enabled: j.enabled !== false,
      lastRunStatus: j.state?.lastStatus || null,
      lastRunAtMs: j.state?.lastRunAtMs || null,
      lastError: j.state?.lastError || null,
    }))
  } catch (e) {
    toast('获取本地任务失败: ' + e, 'error')
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
      <div class="stat-card-header"><span class="stat-card-label">总任务</span></div>
      <div class="stat-card-value">${total}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">运行中</span></div>
      <div class="stat-card-value" style="color:var(--success)">${active}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">已暂停</span></div>
      <div class="stat-card-value" style="color:var(--text-tertiary)">${paused}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">近期失败</span></div>
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
      <div style="text-align:center;padding:40px 0;color:var(--text-tertiary)">
        <div style="margin-bottom:12px;color:var(--text-tertiary)">${icon('clock', 48)}</div>
        <div style="font-size:var(--font-size-md);margin-bottom:6px">暂无定时任务</div>
        <div style="font-size:var(--font-size-sm)">点击「+ 创建任务」添加你的第一个计划任务</div>
      </div>
    `
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
              <span class="cron-badge ${job.enabled ? 'active' : 'paused'}">${job.enabled ? '运行中' : '已暂停'}</span>
              ${lastRunHtml}
            </div>
            <div style="font-size:var(--font-size-sm);color:var(--text-tertiary);margin-bottom:6px">
              ${icon('clock', 12)} ${scheduleText} &middot; 目标: ${escapeHtml(job.sessionLabel || '未指定')}
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
            <button class="btn btn-sm btn-secondary" data-action="trigger" title="立即执行">${icon('play', 14)}</button>
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
        await runLocalJob(job, true)
        toast('任务已触发执行', 'success')
        await fetchJobs(page, state)
      } catch (err) { toast('触发失败: ' + err, 'error') }
      finally { btn.disabled = false }
    }

    card.querySelector('[data-action="toggle"]').onclick = async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.innerHTML = icon('refresh-cw', 14)
      try {
        await updateLocalJob(job.id, { enabled: !job.enabled })
        toast(job.enabled ? '已暂停' : '已启用', 'info')
        await fetchJobs(page, state)
      } catch (err) { toast('操作失败: ' + err, 'error'); btn.disabled = false; btn.innerHTML = job.enabled ? icon('pause', 14) : icon('play', 14) }
    }

    card.querySelector('[data-action="edit"]').onclick = () => openTaskDialog(job, page, state)

    card.querySelector('[data-action="delete"]').onclick = async function() {
      const btn = this
      const yes = await showConfirm(`确定删除任务「${job.name}」？`)
      if (!yes) return
      if (btn) btn.disabled = true
      try {
        await removeLocalJob(job.id)
        toast('已删除', 'info')
        await fetchJobs(page, state)
      } catch (err) { toast('删除失败: ' + err, 'error'); if (btn) btn.disabled = false }
    }
  })
}

// ── 创建/编辑任务弹窗 ──

async function openTaskDialog(job, page, state) {
  const isEdit = !!job
  const initSchedule = extractCronExpr(job?.schedule) || '0 9 * * *'
  const formId = 'cron-form-' + Date.now()

  const shortcutsHtml = CRON_SHORTCUTS.map(s => {
    const selected = s.expr === initSchedule ? 'selected' : ''
    return `<button type="button" class="btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'} cron-shortcut" data-expr="${s.expr}">${s.text}</button>`
  }).join('')

  const content = `
    <form id="${formId}" style="display:flex;flex-direction:column;gap:var(--space-md)">
      <div class="form-group">
        <label class="form-label">任务名称 *</label>
        <input class="form-input" name="name" value="${escapeAttr(job?.name || '')}" placeholder="如：每日摘要推送" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">目标会话</label>
        <select class="form-input" name="sessionLabel"><option value="">请选择会话</option></select>
        <div class="form-hint">将通过 WSS 发送 user 消息</div>
      </div>
      <div class="form-group">
        <label class="form-label">消息内容 *</label>
        <textarea class="form-input" name="message" rows="3" placeholder="发送给会话的内容">${escapeHtml(job?.message || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">执行周期</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${shortcutsHtml}</div>
        <input class="form-input" name="schedule" value="${escapeAttr(initSchedule)}" placeholder="Cron 表达式，如 0 9 * * *">
        <div class="form-hint" id="cron-preview">${describeCron(initSchedule)}</div>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <label class="form-label" style="margin:0">创建后立即启用</label>
        <label class="toggle-switch">
          <input type="checkbox" name="enabled" ${job?.enabled !== false ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </form>
  `

  const modal = showContentModal({
    title: isEdit ? '编辑任务' : '创建定时任务',
    content,
    buttons: [
      { label: isEdit ? '保存修改' : '创建', className: 'btn btn-primary', id: 'btn-cron-save' },
    ],
    width: 500,
  })

  // 异步加载会话列表
  refreshSessionLabelMap().then(() => {
    const select = modal.querySelector('select[name="sessionLabel"]')
    if (!select) return
    const current = job?.sessionLabel || ''
    const options = Array.from(_sessionLabelMap.entries()).map(([label, key]) => {
      const selected = label === current ? 'selected' : ''
      return `<option value="${escapeAttr(label)}" ${selected}>${escapeHtml(label)}</option>`
    }).join('')
    select.innerHTML = `<option value="">请选择会话</option>` + options
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
    const enabled = modal.querySelector('input[name="enabled"]').checked
    const sessionLabel = modal.querySelector('select[name="sessionLabel"]').value

    if (!name) { toast('请输入任务名称', 'warning'); return }
    if (!message) { toast('请输入消息内容', 'warning'); return }
    if (!sessionLabel) { toast('请选择会话', 'warning'); return }
    if (!schedule) { toast('请设置执行周期', 'warning'); return }

    const saveBtn = modal.querySelector('#btn-cron-save')
    saveBtn.disabled = true
    saveBtn.textContent = '保存中...'

    try {
      if (isEdit) {
        await updateLocalJob(job.id, {
          name,
          enabled,
          schedule: { kind: 'cron', expr: schedule },
          payload: { kind: 'sessionMessage', label: sessionLabel, message, waitForIdle: true },
        })
        toast('任务已更新', 'success')
      } else {
        await addLocalJob({
          id: uuid(),
          name,
          enabled,
          schedule: { kind: 'cron', expr: schedule },
          payload: { kind: 'sessionMessage', label: sessionLabel, message, waitForIdle: true },
          state: { lastRunAtMs: 0, lastStatus: null, lastError: null },
        })
        toast('任务已创建', 'success')
      }
      modal.close?.() || modal.remove?.()
      await fetchJobs(page, state)
    } catch (e) {
      toast('保存失败: ' + e, 'error')
      saveBtn.disabled = false
      saveBtn.textContent = isEdit ? '保存修改' : '创建'
    }
  }
}

// ── 工具函数 ──

// ── 本地调度辅助 ──

async function loadLocalJobs() {
  const cfg = (await api.readPanelConfig()) || {}
  if (!cfg[LOCAL_CRON_KEY] || !Array.isArray(cfg[LOCAL_CRON_KEY])) {
    cfg[LOCAL_CRON_KEY] = []
    await api.writePanelConfig(cfg)
  }
  return cfg[LOCAL_CRON_KEY]
}

async function saveLocalJobs(jobs) {
  const cfg = (await api.readPanelConfig()) || {}
  cfg[LOCAL_CRON_KEY] = jobs
  await api.writePanelConfig(cfg)
}

async function addLocalJob(job) {
  const jobs = await loadLocalJobs()
  jobs.push(job)
  await saveLocalJobs(jobs)
}

async function updateLocalJob(id, patch) {
  const jobs = await loadLocalJobs()
  const idx = jobs.findIndex(j => j.id === id)
  if (idx === -1) throw new Error('任务不存在')
  jobs[idx] = { ...jobs[idx], ...patch }
  await saveLocalJobs(jobs)
}

async function removeLocalJob(id) {
  const jobs = await loadLocalJobs()
  const next = jobs.filter(j => j.id !== id)
  await saveLocalJobs(next)
}

function attachSessionActivityListener() {
  wsClient.onEvent((msg) => {
    if (msg?.type !== 'event') return
    const payload = msg.payload || {}
    const sessionKey = payload.sessionKey || payload.session_key || null
    if (sessionKey) {
      _lastSessionActivity.set(sessionKey, Date.now())
    }
  })
}

async function refreshSessionLabelMap() {
  const now = Date.now()
  if (now - _sessionLabelLastFetch < 30000 && _sessionLabelMap.size > 0) return
  _sessionLabelLastFetch = now
  if (!isGatewayUp()) return
  const res = await wsClient.sessionsList(200)
  const list = res?.sessions || res || []
  _sessionLabelMap.clear()
  list.forEach(s => {
    const key = s.sessionKey || s.key || ''
    const label = parseSessionLabel(key)
    if (label) _sessionLabelMap.set(label, key)
  })
}

function isSessionIdle(sessionKey) {
  const last = _lastSessionActivity.get(sessionKey) || 0
  return Date.now() - last >= SESSION_IDLE_MS
}

function stopScheduler() {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer)
    _schedulerTimer = null
  }
}

function restartScheduler(page, state) {
  stopScheduler()
  _schedulerTimer = setInterval(() => tickScheduler(page, state), SCHEDULER_INTERVAL_MS)
  tickScheduler(page, state)
}

async function tickScheduler(page, state) {
  if (!isGatewayUp()) return
  await refreshSessionLabelMap().catch(() => {})
  const jobs = await loadLocalJobs()
  const now = new Date()
  for (const job of jobs) {
    if (job.enabled === false) continue
    const expr = extractCronExpr(job.schedule)
    if (!expr) continue
    if (!isCronDue(expr, now, job.state?.lastRunAtMs || 0)) continue
    await runLocalJob(job, false).catch(() => {})
  }
  await fetchJobs(page, state)
}

async function runLocalJob(job, manual) {
  await refreshSessionLabelMap().catch(() => {})
  const sessionKey = _sessionLabelMap.get(job.payload?.label || '')
  if (!sessionKey) {
    await updateLocalJob(job.id, { state: { ...job.state, lastStatus: 'error', lastError: 'session not found', lastRunAtMs: Date.now() } })
    throw new Error('session not found')
  }
  if (job.payload?.waitForIdle && !isSessionIdle(sessionKey)) {
    if (manual) throw new Error('session busy')
    return
  }
  try {
    await wsClient.chatSend(sessionKey, job.payload?.message || '')
    await updateLocalJob(job.id, { state: { ...job.state, lastStatus: 'ok', lastError: null, lastRunAtMs: Date.now() } })
  } catch (e) {
    await updateLocalJob(job.id, { state: { ...job.state, lastStatus: 'error', lastError: String(e), lastRunAtMs: Date.now() } })
    throw e
  }
}

function isCronDue(expr, now, lastRunAtMs) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hr, dom, mon, dow] = parts
  const last = lastRunAtMs ? new Date(lastRunAtMs) : null
  if (last && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate() && last.getHours() === now.getHours() && last.getMinutes() === now.getMinutes()) {
    return false
  }
  return matchCronField(min, now.getMinutes(), 0, 59)
    && matchCronField(hr, now.getHours(), 0, 23)
    && matchCronField(dom, now.getDate(), 1, 31)
    && matchCronField(mon, now.getMonth() + 1, 1, 12)
    && matchCronField(dow, now.getDay(), 0, 6)
}

function matchCronField(field, value, min, max) {
  if (field === '*') return true
  const parts = field.split(',')
  return parts.some(p => matchCronPart(p, value, min, max))
}

function matchCronPart(part, value, min, max) {
  if (part === '*') return true
  if (part.includes('/')) {
    const [base, stepStr] = part.split('/')
    const step = Number(stepStr)
    if (!step || Number.isNaN(step)) return false
    if (base === '*') return (value - min) % step === 0
    if (base.includes('-')) {
      const [start, end] = base.split('-').map(Number)
      if (Number.isNaN(start) || Number.isNaN(end)) return false
      if (value < start || value > end) return false
      return (value - start) % step === 0
    }
    return false
  }
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(Number)
    if (Number.isNaN(start) || Number.isNaN(end)) return false
    return value >= start && value <= end
  }
  const num = Number(part)
  if (Number.isNaN(num)) return false
  return num === value
}

/** 从 CronSchedule 对象或字符串中提取纯 cron 表达式 */
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
  if (!expr) return '未知周期'

  const hit = CRON_SHORTCUTS.find(s => s.expr === expr)
  if (hit) return hit.text

  const parts = expr.split(' ')
  if (parts.length !== 5) return expr

  const [min, hr, dom, , dow] = parts
  if (min === '*' && hr === '*') return '每分钟'
  if (min.startsWith('*/')) return `每 ${min.slice(2)} 分钟`
  if (hr === '*' && min === '0') return '每小时整点'
  if (dow !== '*' && dom === '*') return `每周 ${dow} 的 ${hr}:${min.padStart(2, '0')}`
  if (dom !== '*') return `每月 ${dom} 号 ${hr}:${min.padStart(2, '0')}`
  if (hr !== '*') return `每天 ${hr}:${min.padStart(2, '0')}`

  return expr
}

/** 将 CronSchedule 对象处理成可读文字 */
function describeCronFull(schedule) {
  if (!schedule) return '未知'
  if (typeof schedule === 'string') return describeCron(schedule)
  if (typeof schedule === 'object') {
    if (schedule.kind === 'cron' && schedule.expr) return describeCron(schedule.expr)
  }
  return String(schedule)
}

/** 相对时间描述 */
function relativeTime(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = Date.now() - t
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
