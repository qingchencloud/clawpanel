/**
 * 通信设置页面 — 消息、广播、命令、音频等 openclaw.json 配置的可视化编辑器
 * 对应上游 Dashboard 的「通信」+「自动化」合并页
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { icon } from '../lib/icons.js'
import { t } from '../lib/i18n.js'
import { wsClient } from '../lib/ws-client.js'

let _page = null, _config = null, _dirty = false

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  _page = page

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('communication.title')}</h1>
      <p class="page-desc">${t('communication.desc')}</p>
    </div>
    <div class="comm-toolbar" style="display:flex;gap:8px;margin-bottom:var(--space-lg);flex-wrap:wrap">
      <button class="btn btn-sm btn-primary comm-tab active" data-tab="messages">${t('communication.tabMessages')}</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="broadcast">${t('communication.tabBroadcast')}</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="commands">${t('communication.tabCommands')}</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="hooks">${t('communication.tabHooks')}</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="approvals">${t('communication.tabApprovals')}</button>
      <div style="flex:1"></div>
      <button class="btn btn-sm btn-primary" id="btn-comm-save" disabled>${icon('save', 14)} ${t('communication.save')}</button>
    </div>
    <div id="comm-content">
      <div class="stat-card loading-placeholder" style="height:200px"></div>
    </div>
  `

  // Tab 切换
  page.querySelectorAll('.comm-tab').forEach(tab => {
    tab.onclick = () => {
      page.querySelectorAll('.comm-tab').forEach(t => { t.classList.remove('active', 'btn-primary'); t.classList.add('btn-secondary') })
      tab.classList.remove('btn-secondary'); tab.classList.add('active', 'btn-primary')
      renderTab(page, tab.dataset.tab)
    }
  })

  // 保存按钮
  page.querySelector('#btn-comm-save').onclick = saveConfig

  await loadConfig(page)
  return page
}

export function cleanup() { _page = null; _config = null; _dirty = false }

async function loadConfig(page) {
  try {
    _config = await api.readOpenclawConfig()
    if (!_config) _config = {}
    renderTab(page, 'messages')
  } catch (e) {
    page.querySelector('#comm-content').innerHTML = `<div style="color:var(--error)">${t('communication.loadFailed')}: ${esc(e?.message || e)}</div>`
  }
}

function markDirty() {
  _dirty = true
  const btn = _page?.querySelector('#btn-comm-save')
  if (btn) btn.disabled = false
}

async function saveConfig() {
  if (!_config || !_dirty) return
  const btn = _page?.querySelector('#btn-comm-save')
  if (btn) { btn.disabled = true; btn.textContent = t('communication.saving') }
  try {
    // 从当前表单收集值到 _config
    collectCurrentTab()
    await api.writeOpenclawConfig(_config)
    _dirty = false
    toast(t('communication.configSaved'), 'info')
    try { await api.reloadGateway(); toast(t('communication.gwReloaded'), 'success') } catch {}
  } catch (e) {
    toast(humanizeError(e, t('communication.saveFailed')), 'error')
  } finally {
    if (btn) { btn.disabled = !_dirty; btn.innerHTML = `${icon('save', 14)} ${t('communication.save')}` }
  }
}

function collectCurrentTab() {
  if (!_page) return
  const activeTab = _page.querySelector('.comm-tab.active')?.dataset.tab
  if (activeTab === 'messages') collectMessages()
  else if (activeTab === 'broadcast') collectBroadcast()
  else if (activeTab === 'commands') collectCommands()
  else if (activeTab === 'hooks') collectHooks()
  else if (activeTab === 'approvals') collectApprovals()
}

// ── Tab 渲染 ──

function renderTab(page, tab) {
  const el = page.querySelector('#comm-content')
  if (tab === 'messages') renderMessages(el)
  else if (tab === 'broadcast') renderBroadcast(el)
  else if (tab === 'commands') renderCommands(el)
  else if (tab === 'hooks') renderHooks(el)
  else if (tab === 'approvals') renderApprovals(el)
}

// ── 消息设置 ──

function renderMessages(el) {
  const m = _config?.messages || {}
  const sr = m.statusReactions || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${t('communication.replySettings')}</div>
      <div class="form-group">
        <label class="form-label">${t('communication.replyPrefix')}</label>
        <input class="form-input" id="msg-responsePrefix" value="${esc(m.responsePrefix || '')}" placeholder="${t('communication.replyPrefixPlaceholder')}">
        <div class="form-hint">${t('communication.replyPrefixHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.ackReaction')}</label>
        <input class="form-input" id="msg-ackReaction" value="${esc(m.ackReaction || '')}" placeholder="${t('communication.ackReactionPlaceholder')}" style="max-width:200px">
        <div class="form-hint">${t('communication.ackReactionHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.ackScope')}</label>
        <select class="form-input" id="msg-ackReactionScope" style="max-width:300px">
          <option value="group-mentions" ${(m.ackReactionScope || 'group-mentions') === 'group-mentions' ? 'selected' : ''}>${t('communication.ackScopeGroupMentions')}</option>
          <option value="group-all" ${m.ackReactionScope === 'group-all' ? 'selected' : ''}>${t('communication.ackScopeGroupAll')}</option>
          <option value="direct" ${m.ackReactionScope === 'direct' ? 'selected' : ''}>${t('communication.ackScopeDirect')}</option>
          <option value="all" ${m.ackReactionScope === 'all' ? 'selected' : ''}>${t('communication.ackScopeAll')}</option>
          <option value="off" ${m.ackReactionScope === 'off' ? 'selected' : ''}>${t('communication.ackScopeOff')}</option>
        </select>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">${t('communication.removeAckAfterReply')}</label>
          <div class="form-hint" style="margin:0">${t('communication.removeAckAfterReplyHint')}</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-removeAckAfterReply" ${m.removeAckAfterReply ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">${t('communication.suppressToolErrors')}</label>
          <div class="form-hint" style="margin:0">${t('communication.suppressToolErrorsHint')}</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-suppressToolErrors" ${m.suppressToolErrors ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">${t('communication.statusReactions')}</div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">${t('communication.enableStatusReactions')}</label>
          <div class="form-hint" style="margin:0">${t('communication.enableStatusReactionsHint')}</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-sr-enabled" ${sr.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">${t('communication.messageQueue')}</div>
      <div class="form-group">
        <label class="form-label">${t('communication.debounceMs')}</label>
        <input class="form-input" id="msg-debounceMs" type="number" value="${m.inbound?.debounceMs || m.queue?.debounceMs || ''}" placeholder="" style="max-width:200px">
        <div class="form-hint">${t('communication.debounceMsHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.queueCap')}</label>
        <input class="form-input" id="msg-queueCap" type="number" value="${m.queue?.cap || ''}" placeholder="" style="max-width:200px">
        <div class="form-hint">${t('communication.queueCapHint')}</div>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">${t('communication.groupChat')}</div>
      <div class="form-group">
        <label class="form-label">${t('communication.groupHistoryLimit')}</label>
        <input class="form-input" id="msg-groupHistoryLimit" type="number" value="${m.groupChat?.historyLimit || ''}" placeholder="" style="max-width:200px">
        <div class="form-hint">${t('communication.groupHistoryLimitHint')}</div>
      </div>
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
    inp.addEventListener('input', markDirty)
  })
}

function collectMessages() {
  if (!_config) return
  const g = (id) => _page?.querySelector('#' + id)
  const v = (id) => g(id)?.value?.trim() || undefined
  const n = (id) => { const x = parseInt(g(id)?.value); return isNaN(x) ? undefined : x }
  const c = (id) => g(id)?.checked || false

  if (!_config.messages) _config.messages = {}
  const m = _config.messages
  m.responsePrefix = v('msg-responsePrefix')
  m.ackReaction = v('msg-ackReaction')
  m.ackReactionScope = v('msg-ackReactionScope') || undefined
  m.removeAckAfterReply = c('msg-removeAckAfterReply') || undefined
  m.suppressToolErrors = c('msg-suppressToolErrors') || undefined

  if (!m.statusReactions) m.statusReactions = {}
  m.statusReactions.enabled = c('msg-sr-enabled') || undefined

  const debounceMs = n('msg-debounceMs')
  if (debounceMs != null) {
    if (!m.inbound) m.inbound = {}
    m.inbound.debounceMs = debounceMs
  }
  const cap = n('msg-queueCap')
  if (cap != null) {
    if (!m.queue) m.queue = {}
    m.queue.cap = cap
  }
  const groupHistoryLimit = n('msg-groupHistoryLimit')
  if (groupHistoryLimit != null) {
    if (!m.groupChat) m.groupChat = {}
    m.groupChat.historyLimit = groupHistoryLimit
  }
}

// ── 广播设置 ──

function renderBroadcast(el) {
  const b = _config?.broadcast || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${t('communication.broadcastStrategy')}</div>
      <div class="form-group">
        <label class="form-label">${t('communication.broadcastMode')}</label>
        <select class="form-input" id="bc-strategy" style="max-width:300px">
          <option value="parallel" ${(b.strategy || 'parallel') === 'parallel' ? 'selected' : ''}>${t('communication.broadcastParallel')}</option>
          <option value="sequential" ${b.strategy === 'sequential' ? 'selected' : ''}>${t('communication.broadcastSequential')}</option>
        </select>
        <div class="form-hint">${t('communication.broadcastHint')}</div>
      </div>
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
  })
}

function collectBroadcast() {
  if (!_config) return
  const strategy = _page?.querySelector('#bc-strategy')?.value
  if (strategy) {
    if (!_config.broadcast) _config.broadcast = {}
    _config.broadcast.strategy = strategy
  }
}

// ── 命令配置 ──

function renderCommands(el) {
  const cmd = _config?.commands || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${t('communication.slashCommands')}</div>
      ${toggleRow('cmd-text', t('communication.cmdText'), t('communication.cmdTextHint'), cmd.text !== false)}
      ${toggleRow('cmd-bash', t('communication.cmdBash'), t('communication.cmdBashHint'), !!cmd.bash)}
      ${toggleRow('cmd-config', t('communication.cmdConfig'), t('communication.cmdConfigHint'), !!cmd.config)}
      ${toggleRow('cmd-debug', t('communication.cmdDebug'), t('communication.cmdDebugHint'), !!cmd.debug)}
      ${toggleRow('cmd-restart', t('communication.cmdRestart'), t('communication.cmdRestartHint'), cmd.restart !== false)}
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('communication.nativeCommands')}</div>
      <div class="form-group">
        <label class="form-label">${t('communication.nativeLabel')}</label>
        <select class="form-input" id="cmd-native" style="max-width:200px">
          <option value="auto" ${(cmd.native === 'auto' || cmd.native === undefined) ? 'selected' : ''}>${t('communication.nativeAuto')}</option>
          <option value="true" ${cmd.native === true ? 'selected' : ''}>${t('communication.nativeEnabled')}</option>
          <option value="false" ${cmd.native === false ? 'selected' : ''}>${t('communication.nativeDisabled')}</option>
        </select>
        <div class="form-hint">${t('communication.nativeHint')}</div>
      </div>
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
  })
}

function collectCommands() {
  if (!_config) return
  const c = (id) => _page?.querySelector('#' + id)?.checked
  if (!_config.commands) _config.commands = {}
  const cmd = _config.commands
  cmd.text = c('cmd-text') === false ? false : undefined
  cmd.bash = c('cmd-bash') || undefined
  cmd.config = c('cmd-config') || undefined
  cmd.debug = c('cmd-debug') || undefined
  cmd.restart = c('cmd-restart') === false ? false : undefined
  const native = _page?.querySelector('#cmd-native')?.value
  cmd.native = native === 'true' ? true : native === 'false' ? false : 'auto'
}

// ── Webhook ──

function renderHooks(el) {
  const h = _config?.hooks || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${t('communication.webhookSettings')}</div>
      ${toggleRow('hooks-enabled', t('communication.webhookEnabled'), t('communication.webhookEnabledHint'), !!h.enabled)}
      <div class="form-group">
        <label class="form-label">${t('communication.webhookPath')}</label>
        <input class="form-input" id="hooks-path" value="${esc(h.path || '')}" placeholder="/hooks" style="max-width:300px">
        <div class="form-hint">${t('communication.webhookPathHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.webhookToken')}</label>
        <input class="form-input" id="hooks-token" type="password" value="${esc(h.token || '')}" placeholder="">
        <div class="form-hint">${t('communication.webhookTokenHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.webhookSessionKey')}</label>
        <input class="form-input" id="hooks-defaultSessionKey" value="${esc(h.defaultSessionKey || '')}" placeholder="hook:<uuid>">
        <div class="form-hint">${t('communication.webhookSessionKeyHint')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('communication.webhookMaxBody')}</label>
        <input class="form-input" id="hooks-maxBodyBytes" type="number" value="${h.maxBodyBytes || ''}" placeholder="${t('communication.noLimit')}" style="max-width:200px">
      </div>
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
    inp.addEventListener('input', markDirty)
  })
}

function collectHooks() {
  if (!_config) return
  const v = (id) => _page?.querySelector('#' + id)?.value?.trim() || undefined
  const n = (id) => { const x = parseInt(_page?.querySelector('#' + id)?.value); return isNaN(x) ? undefined : x }
  const c = (id) => _page?.querySelector('#' + id)?.checked
  if (!_config.hooks) _config.hooks = {}
  const h = _config.hooks
  h.enabled = c('hooks-enabled') || undefined
  h.path = v('hooks-path')
  h.token = v('hooks-token')
  h.defaultSessionKey = v('hooks-defaultSessionKey')
  h.maxBodyBytes = n('hooks-maxBodyBytes')
}

// ── 执行审批 ──

function renderApprovals(el) {
  const a = _config?.approvals?.exec || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${t('communication.approvalsTitle')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">${t('communication.approvalsDesc')}</div>
      ${toggleRow('approvals-enabled', t('communication.approvalsEnabled'), t('communication.approvalsEnabledHint'), !!a.enabled)}
      <div class="form-group">
        <label class="form-label">${t('communication.approvalsMode')}</label>
        <select class="form-input" id="approvals-mode" style="max-width:300px">
          <option value="session" ${(a.mode || 'session') === 'session' ? 'selected' : ''}>${t('communication.approvalsModeSession')}</option>
          <option value="targets" ${a.mode === 'targets' ? 'selected' : ''}>${t('communication.approvalsModeTargets')}</option>
          <option value="both" ${a.mode === 'both' ? 'selected' : ''}>${t('communication.approvalsModeBoth')}</option>
        </select>
      </div>
      ${toggleRow('approvals-forwardExec', t('communication.approvalsForwardExec'), t('communication.approvalsForwardExecHint'), !!a.enabled)}
    </div>
    <div class="config-section" style="margin-top:var(--space-lg)">
      <div class="config-section-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>${t('communication.pendingApprovals')}</span>
        <button class="btn btn-sm btn-secondary" id="btn-refresh-approvals">${t('communication.refreshApprovals')}</button>
      </div>
      <div id="approval-queue" style="margin-top:var(--space-sm)">
        <div class="form-hint">${t('communication.approvalsLoadingQueue')}</div>
      </div>
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
  })
  el.querySelector('#btn-refresh-approvals')?.addEventListener('click', () => loadApprovalQueue(el))
  loadApprovalQueue(el)
}

async function loadApprovalQueue(el) {
  const container = (el || _page)?.querySelector('#approval-queue')
  if (!container) return
  if (!wsClient.connected || !wsClient.gatewayReady) {
    container.innerHTML = `<div class="form-hint">${esc(t('communication.approvalsGwNotReady'))}</div>`
    return
  }
  container.innerHTML = `<div class="form-hint">${esc(t('communication.approvalsLoadingQueue'))}</div>`
  let execItems = [], pluginItems = [], unsupported = false
  try {
    const [execRes, pluginRes] = await Promise.allSettled([
      wsClient.execApprovalList(),
      wsClient.pluginApprovalList(),
    ])
    if (execRes.status === 'fulfilled') execItems = execRes.value?.approvals || execRes.value?.items || []
    else {
      const msg = String(execRes.reason?.message || '').toLowerCase()
      if (msg.includes('unknown method') || msg.includes('not found')) unsupported = true
    }
    if (pluginRes.status === 'fulfilled') pluginItems = pluginRes.value?.approvals || pluginRes.value?.items || []
  } catch {}

  if (unsupported) {
    container.innerHTML = `<div class="form-hint" style="color:var(--text-tertiary)">${esc(t('communication.approvalsUnsupported'))}</div>`
    return
  }

  const allItems = [
    ...execItems.map(i => ({ ...i, _type: 'exec' })),
    ...pluginItems.map(i => ({ ...i, _type: 'plugin' })),
  ]

  if (!allItems.length) {
    container.innerHTML = `<div class="form-hint">${esc(t('communication.approvalsQueueEmpty'))}</div>`
    return
  }

  container.innerHTML = allItems.map(item => {
    const id = item.id || item.approvalId || ''
    const type = item._type === 'plugin' ? 'Plugin' : 'Exec'
    const cmd = item.command || item.description || item.name || id
    const status = item.status || 'pending'
    const ts = item.createdAt || item.timestamp || 0
    const timeStr = ts ? new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts).toLocaleString() : ''
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border-primary);display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div style="min-width:0;flex:1">
        <div style="font-size:13px"><span class="badge" style="font-size:11px;margin-right:4px">${esc(type)}</span>${esc(cmd)}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">${esc(status)}${timeStr ? ' · ' + timeStr : ''}</div>
      </div>
    </div>`
  }).join('')
}

function collectApprovals() {
  if (!_config) return
  const c = (id) => _page?.querySelector('#' + id)?.checked
  const v = (id) => _page?.querySelector('#' + id)?.value
  if (!_config.approvals) _config.approvals = {}
  if (!_config.approvals.exec) _config.approvals.exec = {}
  const a = _config.approvals.exec
  a.enabled = c('approvals-enabled') || undefined
  a.mode = v('approvals-mode') || undefined
}

// ── 工具函数 ──

function toggleRow(id, label, hint, checked) {
  return `
    <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <label class="form-label" style="margin:0">${label}</label>
        <div class="form-hint" style="margin:0">${hint}</div>
      </div>
      <label class="toggle-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
  `
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
