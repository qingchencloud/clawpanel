/**
 * 通信设置页面 — 消息、广播、命令、音频等 openclaw.json 配置的可视化编辑器
 * 对应上游 Dashboard 的「通信」+「自动化」合并页
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { icon } from '../lib/icons.js'

let _page = null, _config = null, _dirty = false

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  _page = page

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">通信与自动化</h1>
      <p class="page-desc">管理 AI 在各消息渠道中的行为方式：如何回复消息、支持哪些命令、如何接收外部通知等</p>
    </div>
    <div class="comm-toolbar" style="display:flex;gap:8px;margin-bottom:var(--space-lg);flex-wrap:wrap">
      <button class="btn btn-sm btn-primary comm-tab active" data-tab="messages">消息</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="broadcast">广播</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="commands">命令</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="hooks">Webhook</button>
      <button class="btn btn-sm btn-secondary comm-tab" data-tab="approvals">执行审批</button>
      <div style="flex:1"></div>
      <button class="btn btn-sm btn-primary" id="btn-comm-save" disabled>${icon('save', 14)} 保存</button>
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
    page.querySelector('#comm-content').innerHTML = `<div style="color:var(--error)">加载配置失败: ${esc(e?.message || e)}</div>`
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
  if (btn) { btn.disabled = true; btn.textContent = '保存中...' }
  try {
    // 从全部表单收集值到 _config
    collectAllTabs()
    await api.writeOpenclawConfig(_config)
    _dirty = false
    toast('配置已保存，正在重载 Gateway...', 'info')
    try { await api.reloadGateway(); toast('Gateway 已重载', 'success') } catch {}
  } catch (e) {
    toast('保存失败: ' + e, 'error')
  } finally {
    if (btn) { btn.disabled = !_dirty; btn.innerHTML = `${icon('save', 14)} 保存` }
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

function collectAllTabs() {
  if (!_page) return
  collectMessages()
  collectBroadcast()
  collectCommands()
  collectHooks()
  collectApprovals()
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
      <div class="config-section-title">回复设置</div>
      <div class="form-group">
        <label class="form-label">回复前缀</label>
        <input class="form-input" id="msg-responsePrefix" value="${esc(m.responsePrefix || '')}" placeholder="如 [{model}] 或 auto">
        <div class="form-hint">每条 AI 回复开头自动加的前缀。支持 {model}、{provider}、{thinkingLevel} 等变量。设为 auto 则显示 Agent 名称</div>
      </div>
      <div class="form-group">
        <label class="form-label">确认反应标记</label>
        <input class="form-input" id="msg-ackReaction" value="${esc(m.ackReaction || '')}" placeholder="如 seen 或留空禁用" style="max-width:200px">
        <div class="form-hint">收到消息时自动添加的确认标记（确认已收到）</div>
      </div>
      <div class="form-group">
        <label class="form-label">确认反应范围</label>
        <select class="form-input" id="msg-ackReactionScope" style="max-width:300px">
          <option value="group-mentions" ${(m.ackReactionScope || 'group-mentions') === 'group-mentions' ? 'selected' : ''}>群聊 @提及时</option>
          <option value="group-all" ${m.ackReactionScope === 'group-all' ? 'selected' : ''}>群聊所有消息</option>
          <option value="direct" ${m.ackReactionScope === 'direct' ? 'selected' : ''}>仅私聊</option>
          <option value="all" ${m.ackReactionScope === 'all' ? 'selected' : ''}>所有消息</option>
          <option value="off" ${m.ackReactionScope === 'off' ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">回复后移除确认反应</label>
          <div class="form-hint" style="margin:0">回复发送成功后自动删除之前的确认 emoji</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-removeAckAfterReply" ${m.removeAckAfterReply ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">隐藏工具错误</label>
          <div class="form-hint" style="margin:0">不向用户显示 ⚠️ 工具执行错误</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-suppressToolErrors" ${m.suppressToolErrors ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">状态反应 Emoji</div>
      <div class="form-group" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <label class="form-label" style="margin:0">启用状态反应</label>
          <div class="form-hint" style="margin:0">在消息渠道中用 emoji 表示 AI 当前状态（思考中、执行工具、完成等）</div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="msg-sr-enabled" ${sr.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">消息队列</div>
      <div class="form-group">
        <label class="form-label">防抖延迟（毫秒）</label>
        <input class="form-input" id="msg-debounceMs" type="number" value="${m.inbound?.debounceMs || m.queue?.debounceMs || ''}" placeholder="默认无延迟" style="max-width:200px">
        <div class="form-hint">合并快速连续消息的等待时间（毫秒），避免 AI 对每条消息逐一回复</div>
      </div>
      <div class="form-group">
        <label class="form-label">队列上限</label>
        <input class="form-input" id="msg-queueCap" type="number" value="${m.queue?.cap || ''}" placeholder="默认无限制" style="max-width:200px">
        <div class="form-hint">等待处理的消息队列最大长度</div>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">群聊设置</div>
      <div class="form-group">
        <label class="form-label">群聊历史条数</label>
        <input class="form-input" id="msg-groupHistoryLimit" type="number" value="${m.groupChat?.historyLimit || ''}" placeholder="默认自动" style="max-width:200px">
        <div class="form-hint">群聊中回溯多少条历史消息作为上下文</div>
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
  const responsePrefix = v('msg-responsePrefix')
  const ackReaction = v('msg-ackReaction')
  const ackScope = v('msg-ackReactionScope') || undefined
  const removeAck = c('msg-removeAckAfterReply')
  const suppressErrors = c('msg-suppressToolErrors')
  const srEnabled = c('msg-sr-enabled')

  if (responsePrefix) m.responsePrefix = responsePrefix
  else delete m.responsePrefix
  if (ackReaction) m.ackReaction = ackReaction
  else delete m.ackReaction
  if (ackScope) m.ackReactionScope = ackScope
  else delete m.ackReactionScope
  if (removeAck === true) m.removeAckAfterReply = true
  else delete m.removeAckAfterReply
  if (suppressErrors === true) m.suppressToolErrors = true
  else delete m.suppressToolErrors

  if (srEnabled === true) {
    if (!m.statusReactions) m.statusReactions = {}
    m.statusReactions.enabled = true
  } else if (m.statusReactions) {
    delete m.statusReactions.enabled
  }

  const debounceMs = n('msg-debounceMs')
  if (debounceMs != null) {
    if (!m.inbound) m.inbound = {}
    m.inbound.debounceMs = debounceMs
  } else if (m.inbound) {
    delete m.inbound.debounceMs
  }
  const cap = n('msg-queueCap')
  if (cap != null) {
    if (!m.queue) m.queue = {}
    m.queue.cap = cap
  } else if (m.queue) {
    delete m.queue.cap
  }
  const groupHistoryLimit = n('msg-groupHistoryLimit')
  if (groupHistoryLimit != null) {
    if (!m.groupChat) m.groupChat = {}
    m.groupChat.historyLimit = groupHistoryLimit
  } else if (m.groupChat) {
    delete m.groupChat.historyLimit
  }
}

// ── 广播设置 ──

function renderBroadcast(el) {
  const b = _config?.broadcast || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">广播策略</div>
      <div class="form-group">
        <label class="form-label">广播处理方式</label>
        <select class="form-input" id="bc-strategy" style="max-width:300px">
          <option value="parallel" ${(b.strategy || 'parallel') === 'parallel' ? 'selected' : ''}>并行（parallel）— 同时发送给所有目标</option>
          <option value="sequential" ${b.strategy === 'sequential' ? 'selected' : ''}>顺序（sequential）— 逐个发送，严格有序</option>
        </select>
        <div class="form-hint">当消息需要广播给多个 Agent 时的处理策略。并行更快，顺序更可控</div>
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
  if (!_config.broadcast) _config.broadcast = {}
  if (strategy) _config.broadcast.strategy = strategy
  else delete _config.broadcast.strategy
}

// ── 命令配置 ──

function renderCommands(el) {
  const cmd = _config?.commands || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">斜杠命令</div>
      ${toggleRow('cmd-text', '文本命令解析', '允许通过 / 前缀在聊天中执行命令', cmd.text !== false)}
      ${toggleRow('cmd-bash', 'Bash 命令', '允许用 ! 前缀或 /bash 在聊天中执行 Shell 命令（危险）', !!cmd.bash)}
      ${toggleRow('cmd-config', '/config 命令', '允许在聊天中查看/修改配置', !!cmd.config)}
      ${toggleRow('cmd-debug', '/debug 命令', '允许在聊天中查看调试信息', !!cmd.debug)}
      ${toggleRow('cmd-restart', '重启命令', '允许通过命令重启 Gateway', cmd.restart !== false)}
    </div>
    <div class="config-section">
      <div class="config-section-title">原生命令注册</div>
      <div class="form-group">
        <label class="form-label">原生命令</label>
        <select class="form-input" id="cmd-native" style="max-width:200px">
          <option value="auto" ${(cmd.native === 'auto' || cmd.native === undefined) ? 'selected' : ''}>自动</option>
          <option value="true" ${cmd.native === true ? 'selected' : ''}>启用</option>
          <option value="false" ${cmd.native === false ? 'selected' : ''}>禁用</option>
        </select>
        <div class="form-hint">在支持的渠道（Telegram、Discord）自动注册原生命令菜单</div>
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
  const textEnabled = c('cmd-text')
  const bashEnabled = c('cmd-bash')
  const configEnabled = c('cmd-config')
  const debugEnabled = c('cmd-debug')
  const restartEnabled = c('cmd-restart')
  cmd.text = textEnabled === false ? false : undefined
  cmd.bash = bashEnabled === true ? true : undefined
  cmd.config = configEnabled === true ? true : undefined
  cmd.debug = debugEnabled === true ? true : undefined
  cmd.restart = restartEnabled === false ? false : undefined
  const native = _page?.querySelector('#cmd-native')?.value
  cmd.native = native === 'true' ? true : native === 'false' ? false : 'auto'
}

// ── Webhook ──

function renderHooks(el) {
  const h = _config?.hooks || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">Webhook 设置</div>
      ${toggleRow('hooks-enabled', '启用 Webhook', '允许外部服务通过 HTTP 触发 AI 执行', !!h.enabled)}
      <div class="form-group">
        <label class="form-label">Webhook 路径</label>
        <input class="form-input" id="hooks-path" value="${esc(h.path || '')}" placeholder="/hooks（默认）" style="max-width:300px">
        <div class="form-hint">Gateway 上暴露的 Webhook 接收路径</div>
      </div>
      <div class="form-group">
        <label class="form-label">认证 Token</label>
        <input class="form-input" id="hooks-token" type="password" value="${esc(h.token || '')}" placeholder="可选，用于验证 Webhook 请求">
        <div class="form-hint">外部请求需在 Header 中携带此 Token 才能触发 Webhook</div>
      </div>
      <div class="form-group">
        <label class="form-label">默认 Session Key</label>
        <input class="form-input" id="hooks-defaultSessionKey" value="${esc(h.defaultSessionKey || '')}" placeholder="自动生成 hook:<uuid>">
        <div class="form-hint">Webhook 触发的 Agent 会话标识。留空则每次自动生成</div>
      </div>
      <div class="form-group">
        <label class="form-label">请求体大小限制（字节）</label>
        <input class="form-input" id="hooks-maxBodyBytes" type="number" value="${h.maxBodyBytes || ''}" placeholder="默认无限制" style="max-width:200px">
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
  const enabled = c('hooks-enabled')
  h.enabled = enabled === true ? true : undefined
  const path = v('hooks-path')
  if (path) h.path = path
  else delete h.path
  const token = v('hooks-token')
  if (token) h.token = token
  else delete h.token
  const defaultKey = v('hooks-defaultSessionKey')
  if (defaultKey) h.defaultSessionKey = defaultKey
  else delete h.defaultSessionKey
  const maxBody = n('hooks-maxBodyBytes')
  if (maxBody != null) h.maxBodyBytes = maxBody
  else delete h.maxBodyBytes
}

// ── 执行审批 ──

function renderApprovals(el) {
  const a = _config?.approvals?.exec || {}
  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">执行审批转发</div>
      <div class="form-hint" style="margin-bottom:var(--space-md)">当 AI 请求执行命令时，将审批请求转发到消息渠道，方便在手机上审批</div>
      ${toggleRow('approvals-enabled', '启用审批转发', '将执行审批请求转发到配置的消息渠道', !!a.enabled)}
      <div class="form-group">
        <label class="form-label">转发模式</label>
        <select class="form-input" id="approvals-mode" style="max-width:300px">
          <option value="session" ${(a.mode || 'session') === 'session' ? 'selected' : ''}>原会话（session）— 发到发起请求的会话</option>
          <option value="targets" ${a.mode === 'targets' ? 'selected' : ''}>指定目标（targets）— 发到配置的目标渠道</option>
          <option value="both" ${a.mode === 'both' ? 'selected' : ''}>两者都发（both）</option>
        </select>
      </div>
      ${toggleRow('approvals-forwardExec', '转发执行请求', '将 exec 审批请求转发到渠道（默认关闭，低风险场景可开启）', !!a.forwardExec)}
    </div>
  `
  el.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('change', markDirty)
  })
}

function collectApprovals() {
  if (!_config) return
  const c = (id) => _page?.querySelector('#' + id)?.checked
  const v = (id) => _page?.querySelector('#' + id)?.value
  if (!_config.approvals) _config.approvals = {}
  if (!_config.approvals.exec) _config.approvals.exec = {}
  const a = _config.approvals.exec
  const enabled = c('approvals-enabled')
  const mode = v('approvals-mode')
  const forwardExec = c('approvals-forwardExec')
  a.enabled = enabled === true ? true : undefined
  if (mode) a.mode = mode
  else delete a.mode
  a.forwardExec = forwardExec === true ? true : undefined
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
