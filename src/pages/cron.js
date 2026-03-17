/**
 * 定时任务管理
 * 通过 Gateway WebSocket RPC 管理（cron.list / cron.add / cron.update / cron.remove / cron.run）
 * 注意：openclaw.json 不支持 cron.jobs 字段，定时任务只能通过 Gateway 在线管理
 */
import { toast } from '../components/toast.js'
import { showContentModal, showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { onGatewayChange } from '../lib/app-state.js'
import { wsClient, uuid } from '../lib/ws-client.js'
import { api, invalidate } from '../lib/tauri-api.js'

let _unsub = null
let _unsubReady = null
let _unsubEvent = null
let _tickTimer = null
let _sessionLastActivity = new Map()
let _sessionActiveRuns = new Map()
let _sessionLabelMap = new Map()
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

const SESSION_MESSAGE_TEXT = '继续执行'
const LOCAL_SESSION_MESSAGE_KEY = 'localSessionMessageJobs'

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
          <span>定时任务通过 Gateway 管理。请先启动 Gateway 后使用此功能。</span>
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

  // 自动修复：移除可能被写入的无效 cron.jobs 字段
  fixInvalidCronConfig()

  // 监听 Gateway 状态变化
  if (_unsub) _unsub()
  _unsub = onGatewayChange(() => {
    updateGatewayHint(page)
    fetchJobs(page, state)
  })
  if (_unsubReady) _unsubReady()
  _unsubReady = wsClient.onReady(() => {
    updateGatewayHint(page)
    fetchJobs(page, state)
  })

  updateGatewayHint(page)
  await fetchJobs(page, state)

  return page
}

export function cleanup() {
  if (_unsub) { _unsub(); _unsub = null }
  if (_unsubReady) { _unsubReady(); _unsubReady = null }
  if (_unsubEvent) { _unsubEvent(); _unsubEvent = null }
  stopSessionMessageTicker()
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
      toast('已自动修复配置（移除无效的 cron.jobs）', 'info')
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
  state.loading = true
  renderList(page, state)

  try {
    const localSessionJobs = await loadLocalSessionMessageJobs()
    let gatewayJobs = []
    if (isGatewayUp()) {
      const res = await wsClient.request('cron.list', { includeDisabled: true })
      let jobs = res?.jobs || res
      if (!Array.isArray(jobs)) jobs = []
      gatewayJobs = jobs.map(j => ({
        id: j.id,
        name: j.name || j.id || '未命名',
        description: j.description || '',
        message: j.payload?.message || j.payload?.text || '',
        payloadKind: j.payload?.kind || 'agentTurn',
        sessionLabel: j.payload?.label || '',
        schedule: j.schedule || {},
        enabled: j.enabled !== false,
        agentId: j.agentId || null,
        lastRunStatus: j.state?.lastRunStatus || j.state?.lastStatus || null,
        lastRunAtMs: j.state?.lastRunAtMs || null,
        lastError: j.state?.lastError || null,
      }))
    }
    const localMapped = localSessionJobs.map(j => ({
      id: j.id,
      name: j.name || j.id || '未命名',
      description: j.description || '',
      message: j.payload?.message || '',
      payloadKind: 'sessionMessage',
      sessionLabel: j.payload?.label || '',
      schedule: j.schedule || {},
      triggerMode: j.triggerMode || 'cron',
      enabled: j.enabled !== false,
      agentId: null,
      lastRunStatus: j.state?.lastRunStatus || j.state?.lastStatus || null,
      lastRunAtMs: j.state?.lastRunAtMs || null,
      lastError: j.state?.lastError || null,
    }))
    const gatewayFiltered = gatewayJobs.filter(j => j.payloadKind !== 'sessionMessage')
    state.jobs = [...gatewayFiltered, ...localMapped]
  } catch (e) {
    toast('获取任务列表失败: ' + e, 'error')
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

  const sortedJobs = [...state.jobs].sort((a, b) => {
    if (a.enabled === b.enabled) return 0
    return a.enabled ? -1 : 1
  })

  el.innerHTML = sortedJobs.map(job => {
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
              <span class="cron-badge ${job.enabled ? 'active' : 'paused'}">${job.enabled ? '开启中' : '已暂停'}</span>
              ${lastRunHtml}
            </div>
            <div style="font-size:var(--font-size-sm);color:var(--text-tertiary);margin-bottom:6px">
              ${icon('clock', 12)} ${scheduleText}${job.payloadKind === 'sessionMessage'
    ? ` &middot; 目标: ${escapeHtml(job.sessionLabel || '未指定')} &middot; ${job.triggerMode === 'onIdle' ? '任务结束后发送' : '按 Cron'}`
    : (job.agentId ? ` &middot; Agent: ${escapeHtml(job.agentId)}` : '')}
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
          <div style="display:flex;gap:8px;flex-shrink:0;align-items:center">
            <button class="btn btn-sm btn-secondary" data-action="trigger" title="立即执行">${icon('play', 14)}</button>
            <label class="toggle-switch" style="margin:0">
              <input type="checkbox" data-action="toggle" ${job.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
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
        if (job.payloadKind === 'sessionMessage') {
          await runSessionMessageJob(job, true)
          toast('任务已触发执行', 'success')
          await fetchJobs(page, state)
        } else {
          await wsClient.request('cron.run', { jobId: jid })
          toast('任务已触发执行', 'success')
          setTimeout(() => fetchJobs(page, state), 2000)
        }
      } catch (err) { toast('触发失败: ' + err, 'error') }
      finally { btn.disabled = false }
    }

    card.querySelector('[data-action="toggle"]').onclick = async (e) => {
      const input = e.currentTarget
      input.disabled = true
      const nextEnabled = input.checked
      try {
        if (job.payloadKind === 'sessionMessage') {
          await updateLocalSessionMessageJob(job.id, { enabled: nextEnabled })
          toast(nextEnabled ? '已启用' : '已暂停', 'info')
          await fetchJobs(page, state)
        } else {
          await wsClient.request('cron.update', { jobId: jid, patch: { enabled: nextEnabled } })
          toast(nextEnabled ? '已启用' : '已暂停', 'info')
          await fetchJobs(page, state)
        }
      } catch (err) { toast('操作失败: ' + err, 'error') }
      finally { input.disabled = false }
    }

    card.querySelector('[data-action="edit"]').onclick = () => openTaskDialog(job, page, state)

    card.querySelector('[data-action="delete"]').onclick = async function() {
      const btn = this
      const yes = await showConfirm(`确定删除任务「${job.name}」？`)
      if (!yes) return
      if (btn) btn.disabled = true
      try {
        if (job.payloadKind === 'sessionMessage') {
          await removeLocalSessionMessageJob(job.id)
          toast('已删除', 'info')
          await fetchJobs(page, state)
        } else {
          await wsClient.request('cron.remove', { jobId: jid })
          toast('已删除', 'info')
          await fetchJobs(page, state)
        }
      } catch (err) { toast('删除失败: ' + err, 'error'); if (btn) btn.disabled = false }
    }
  })
}

// ── 创建/编辑任务弹窗 ──

async function openTaskDialog(job, page, state) {
  if (!isGatewayUp()) {
    toast('Gateway 未连接，非 sessionMessage 任务将无法保存', 'warning')
  }
  const isEdit = !!job
  const initSchedule = extractCronExpr(job?.schedule) || '0 9 * * *'
  const formId = 'cron-form-' + Date.now()

  const shortcutsHtml = CRON_SHORTCUTS.map(s => {
    const selected = s.expr === initSchedule ? 'selected' : ''
    return `<button type="button" class="btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'} cron-shortcut" data-expr="${s.expr}">${s.text}</button>`
  }).join('')

  // 先用默认选项，弹窗后异步加载 Agent 列表
  const agentOptionsHtml = `<option value="" ${!job?.agentId ? 'selected' : ''}>默认 Agent</option>${job?.agentId ? `<option value="${escapeAttr(job.agentId)}" selected>${escapeHtml(job.agentId)}</option>` : ''}`

  const content = `
    <form id="${formId}" style="display:flex;flex-direction:column;gap:var(--space-md)">
      <div class="form-group">
        <label class="form-label">任务名称 *</label>
        <input class="form-input" name="name" value="${escapeAttr(job?.name || '')}" placeholder="如：每日摘要推送" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">任务类型</label>
        <select class="form-input" name="taskKind">
          <option value="agentTurn" ${job?.payloadKind !== 'sessionMessage' ? 'selected' : ''}>Agent 执行指令</option>
          <option value="sessionMessage" ${job?.payloadKind === 'sessionMessage' ? 'selected' : ''}>发送 user 消息</option>
        </select>
      </div>
      <div class="form-group" data-field="sessionLabel" style="display:${job?.payloadKind === 'sessionMessage' ? 'block' : 'none'}">
        <label class="form-label">目标会话</label>
        <select class="form-input" name="sessionLabel"><option value="">请选择会话</option></select>
        <div class="form-hint">仅发送 user 消息，不附带系统注入</div>
      </div>
      <div class="form-group" data-field="triggerMode" style="display:${job?.payloadKind === 'sessionMessage' ? 'block' : 'none'}">
        <label class="form-label">触发模式</label>
        <select class="form-input" name="triggerMode">
          <option value="cron" ${job?.triggerMode !== 'onIdle' ? 'selected' : ''}>按 Cron</option>
          <option value="onIdle" ${job?.triggerMode === 'onIdle' ? 'selected' : ''}>监听任务结束</option>
        </select>
        <div class="form-hint">onIdle: 目标会话任务结束后发送</div>
      </div>
      <div class="form-group" data-field="message" style="display:block">
        <label class="form-label">执行内容 *</label>
        <textarea class="form-input" name="message" rows="3" placeholder="sessionMessage 将作为 user 消息发送；agentTurn 将作为指令执行">${escapeHtml(job?.message || '')}</textarea>
      </div>
      <div class="form-group" data-field="agent" style="display:${job?.payloadKind === 'sessionMessage' ? 'none' : 'block'}">
        <label class="form-label">指定 Agent</label>
        <select class="form-input" name="agentId">${agentOptionsHtml}</select>
        <div class="form-hint">不选则使用默认 Agent 执行</div>
      </div>
      <div class="form-group" data-field="delivery" style="display:${job?.payloadKind === 'sessionMessage' ? 'none' : 'block'}">
        <label class="form-label">投递渠道</label>
        <select class="form-input" name="deliveryChannel"><option value="">无（主会话）</option></select>
        <div class="form-hint">配置了多个消息渠道时必须指定，否则任务会报错</div>
      </div>
      <div class="form-group" data-field="schedule">
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

  // 异步加载渠道列表
  api.readOpenclawConfig().then(cfg => {
    const channels = cfg?.channels || {}
    const channelIds = Object.keys(channels).filter(k => k !== 'defaults')
    if (channelIds.length <= 1) return // 单渠道或无渠道不需要选
    const select = modal.querySelector('select[name="deliveryChannel"]')
    if (!select) return
    const current = job?.delivery?.channel || ''
    select.innerHTML = `<option value="">无（主会话）</option>` + channelIds.map(ch =>
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
    select.innerHTML = `<option value="">默认 Agent</option>` + agents.map(a =>
      `<option value="${escapeAttr(a.id)}" ${a.id === (job?.agentId || currentVal) ? 'selected' : ''}>${escapeHtml(a.name || a.id)}</option>`
    ).join('')
  }).catch(() => {})

  // 异步加载会话列表
  wsClient.sessionsList(50).then(res => {
    const list = res?.sessions || res || []
    const select = modal.querySelector('select[name="sessionLabel"]')
    if (!select) return
    const currentKey = job?.sessionKey || ''
    const currentLabel = job?.sessionLabel || ''
    select.innerHTML = `<option value="">请选择会话</option>` + list.map(s => {
      const key = s.sessionKey || s.key || ''
      const label = parseSessionLabel(key)
      const selected = (currentKey && key === currentKey) || (!currentKey && label === currentLabel)
      return `<option value="${escapeAttr(key)}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`
    }).join('')
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

  const toggleFields = () => {
    const kind = modal.querySelector('select[name="taskKind"]').value
    const showSession = kind === 'sessionMessage'
    modal.querySelector('[data-field="sessionLabel"]').style.display = showSession ? 'block' : 'none'
    modal.querySelector('[data-field="triggerMode"]').style.display = showSession ? 'block' : 'none'
    modal.querySelector('[data-field="schedule"]').style.display = (!showSession || modal.querySelector('select[name="triggerMode"]').value === 'cron') ? 'block' : 'none'
    modal.querySelector('[data-field="agent"]').style.display = showSession ? 'none' : 'block'
    modal.querySelector('[data-field="delivery"]').style.display = showSession ? 'none' : 'block'
  }
  toggleFields()
  modal.querySelector('select[name="taskKind"]').onchange = toggleFields
  modal.querySelector('select[name="triggerMode"]').onchange = toggleFields

  // 保存
  modal.querySelector('#btn-cron-save').onclick = async () => {
    const name = modal.querySelector('input[name="name"]').value.trim()
    const taskKind = modal.querySelector('select[name="taskKind"]').value
    const message = modal.querySelector('textarea[name="message"]').value.trim()
    const schedule = modal.querySelector('input[name="schedule"]').value.trim()
    const agentId = modal.querySelector('select[name="agentId"]').value || undefined
    const enabled = modal.querySelector('input[name="enabled"]').checked
    const sessionKey = modal.querySelector('select[name="sessionLabel"]').value
    const sessionLabel = sessionKey ? parseSessionLabel(sessionKey) : ''
    const triggerMode = modal.querySelector('select[name="triggerMode"]').value

    if (!name) { toast('请输入任务名称', 'warning'); return }
    if (!message) { toast('请输入执行内容', 'warning'); return }
    if (taskKind === 'sessionMessage' && !sessionKey) { toast('请选择会话', 'warning'); return }
    if (taskKind === 'sessionMessage' && triggerMode === 'cron' && !schedule) { toast('请设置执行周期', 'warning'); return }
    if (taskKind !== 'sessionMessage' && !schedule) { toast('请设置执行周期', 'warning'); return }
    if (taskKind !== 'sessionMessage' && !isGatewayUp()) { toast('Gateway 未连接，无法保存非 sessionMessage 任务', 'warning'); return }

    const saveBtn = modal.querySelector('#btn-cron-save')
    saveBtn.disabled = true
    saveBtn.textContent = '保存中...'

    try {
      if (taskKind === 'sessionMessage') {
        if (isEdit) {
          await updateLocalSessionMessageJob(job.id, {
            name,
            enabled,
            triggerMode,
            schedule: { kind: 'cron', expr: schedule },
            payload: { kind: 'sessionMessage', label: sessionLabel, sessionKey, message, role: 'user', waitForIdle: true },
          })
          toast('任务已更新', 'success')
        } else {
          await addLocalSessionMessageJob({
            id: job?.id || uuid(),
            name,
            enabled,
            triggerMode,
            schedule: { kind: 'cron', expr: schedule },
            payload: { kind: 'sessionMessage', label: sessionLabel, sessionKey, message, role: 'user', waitForIdle: true },
            state: { lastRunStatus: null, lastRunAtMs: 0, lastError: null, lastIdleAtMs: 0 },
          })
          toast('任务已创建', 'success')
        }
      } else {
        if (isEdit) {
          const patch = { name, enabled }
          patch.schedule = { kind: 'cron', expr: schedule }
          patch.payload = { kind: 'agentTurn', message }
          if (agentId) patch.agentId = agentId
          const deliveryChannel = modal.querySelector('select[name="deliveryChannel"]')?.value
          if (deliveryChannel) {
            patch.delivery = { mode: 'push', to: deliveryChannel, channel: deliveryChannel }
          }
          await wsClient.request('cron.update', { jobId: job.id, patch })
          toast('任务已更新', 'success')
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
            params.delivery = { mode: 'push', to: deliveryChannel, channel: deliveryChannel }
          }
          await wsClient.request('cron.add', params)
          toast('任务已创建', 'success')
        }
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

// ── sessionMessage 本地存储与调度 ──

async function loadLocalSessionMessageJobs() {
  const cfg = (await api.readPanelConfig()) || {}
  const jobs = Array.isArray(cfg[LOCAL_SESSION_MESSAGE_KEY]) ? cfg[LOCAL_SESSION_MESSAGE_KEY] : []
  return jobs
}

async function saveLocalSessionMessageJobs(jobs) {
  const cfg = (await api.readPanelConfig()) || {}
  cfg[LOCAL_SESSION_MESSAGE_KEY] = jobs
  await api.writePanelConfig(cfg)
}

async function addLocalSessionMessageJob(job) {
  const jobs = await loadLocalSessionMessageJobs()
  jobs.push(job)
  await saveLocalSessionMessageJobs(jobs)
}

async function updateLocalSessionMessageJob(id, patch) {
  const jobs = await loadLocalSessionMessageJobs()
  const idx = jobs.findIndex(j => j.id === id)
  if (idx === -1) throw new Error('任务不存在')
  jobs[idx] = { ...jobs[idx], ...patch }
  await saveLocalSessionMessageJobs(jobs)
}

async function removeLocalSessionMessageJob(id) {
  const jobs = await loadLocalSessionMessageJobs()
  const next = jobs.filter(j => j.id !== id)
  await saveLocalSessionMessageJobs(next)
}

function attachSessionMessageListeners() {
  if (_unsubEvent) return
  _unsubEvent = wsClient.onEvent((msg) => {
    if (msg?.type !== 'event') return
    const payload = msg.payload || {}
    const event = msg.event
    const sessionKey = payload.sessionKey || payload.session_key || null
    if (!sessionKey) return
    if (event === 'chat') {
      if (payload.state === 'delta') {
        _sessionLastActivity.set(sessionKey, Date.now())
        _sessionActiveRuns.set(sessionKey, true)
      }
      if (payload.state === 'final') {
        _sessionLastActivity.set(sessionKey, Date.now())
        _sessionActiveRuns.set(sessionKey, false)
      }
    }
  })
}

async function refreshSessionLabelMap() {
  const now = Date.now()
  if (now - _sessionLabelLastFetch < 30000 && _sessionLabelMap.size > 0) return
  _sessionLabelLastFetch = now
  _sessionLabelMap.clear()
  if (!isGatewayUp()) {
    if (wsClient.sessionKey) _sessionLabelMap.set('主会话', wsClient.sessionKey)
    return
  }
  const res = await wsClient.sessionsList(200)
  const list = res?.sessions || res || []
  list.forEach(s => {
    const key = s.sessionKey || s.key || ''
    const label = parseSessionLabel(key)
    if (label) _sessionLabelMap.set(label, key)
  })
  if (wsClient.sessionKey && !_sessionLabelMap.has('主会话')) {
    _sessionLabelMap.set('主会话', wsClient.sessionKey)
  }
}

function isSessionIdle(sessionKey) {
  const last = _sessionLastActivity.get(sessionKey) || 0
  const active = _sessionActiveRuns.get(sessionKey)
  return !active && (Date.now() - last >= SESSION_IDLE_MS)
}

function stopSessionMessageTicker() {
  if (_tickTimer) {
    clearInterval(_tickTimer)
    _tickTimer = null
  }
}

function restartSessionMessageTicker(page, state) {
  stopSessionMessageTicker()
  _tickTimer = setInterval(() => tickSessionMessageJobs(page, state), SESSION_MESSAGE_TICK_MS)
  tickSessionMessageJobs(page, state)
}

async function tickSessionMessageJobs(page, state) {
  await refreshSessionLabelMap().catch(() => {})
  const jobs = await loadLocalSessionMessageJobs()
  const now = new Date()
  for (const job of jobs) {
    if (job.enabled === false) continue
    const triggerMode = job.triggerMode || 'cron'
    if (triggerMode === 'cron') {
      const expr = extractCronExpr(job.schedule)
      if (!expr) continue
      if (!isCronDue(expr, now, job.state?.lastRunAtMs || 0)) continue
      await runSessionMessageJob(job, false).catch(() => {})
    } else if (triggerMode === 'onIdle') {
      await runSessionMessageJob(job, false).catch(() => {})
    }
  }
  await fetchJobs(page, state)
}

async function runSessionMessageJob(job, manual) {
  await refreshSessionLabelMap().catch(() => {})
  const label = job.payload?.label || '主会话'
  const sessionKey = job.payload?.sessionKey || _sessionLabelMap.get(label) || wsClient.sessionKey
  if (!sessionKey) {
    await updateLocalSessionMessageJob(job.id, { state: { ...job.state, lastRunStatus: 'error', lastError: 'session not found', lastRunAtMs: Date.now() } })
    throw new Error('session not found')
  }
  if (job.payload?.waitForIdle && !isSessionIdle(sessionKey)) {
    if (manual) throw new Error('session busy')
    return
  }
  const triggerMode = job.triggerMode || 'cron'
  if (triggerMode === 'onIdle') {
    const lastIdleAtMs = job.state?.lastIdleAtMs || 0
    if (lastIdleAtMs && Date.now() - lastIdleAtMs < SESSION_IDLE_MS) return
  }
  try {
    await wsClient.chatSend(sessionKey, job.payload?.message || '')
    const nextState = { ...job.state, lastRunStatus: 'ok', lastError: null, lastRunAtMs: Date.now() }
    if (triggerMode === 'onIdle') nextState.lastIdleAtMs = Date.now()
    await updateLocalSessionMessageJob(job.id, { state: nextState })
  } catch (e) {
    await updateLocalSessionMessageJob(job.id, { state: { ...job.state, lastRunStatus: 'error', lastError: String(e), lastRunAtMs: Date.now() } })
    throw e
  }
}

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

/** 将 Gateway 返回的 CronSchedule 对象也处理成可读文字 */
function describeCronFull(schedule) {
  if (!schedule) return '未知'
  if (typeof schedule === 'string') return describeCron(schedule)
  if (typeof schedule === 'object') {
    if (schedule.kind === 'every' && schedule.everyMs) {
      const ms = schedule.everyMs
      if (ms < 60000) return `每 ${Math.round(ms / 1000)} 秒`
      if (ms < 3600000) return `每 ${Math.round(ms / 60000)} 分钟`
      return `每 ${Math.round(ms / 3600000)} 小时`
    }
    if (schedule.kind === 'at' && schedule.at) {
      try { return '一次性: ' + new Date(schedule.at).toLocaleString() } catch { return schedule.at }
    }
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
