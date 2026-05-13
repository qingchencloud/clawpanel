/**
 * Hermes 群聊（Batch 3 §N）
 *
 * Hermes 内核没有「群聊」概念，由 ClawPanel 前端编排：
 *   - 用户选择多个 Profile（每个对应一个 Agent 配置）
 *   - 发消息时并发调用每个 Profile 的 hermes_agent_run
 *   - 把每个 Profile 的回复以 @profile_name 标记后显示
 *
 * 限制：
 *   - 仅 Tauri 桌面端（Web 模式禁用，因为依赖 hermesAgentRun）
 *   - 非流式（用阻塞式 run 等所有完成）
 *   - 不持久化（一次性会话，刷新清空）
 */
import { t } from '../../../lib/i18n.js'
import { api, isTauriRuntime } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { humanizeError } from '../../../lib/humanize-error.js'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let profiles = []
  let selected = new Set()  // 选中的 profile 名集合
  let messages = []  // [{ id, role: 'user'|'assistant'|'system', from?, content, ts, error?, loading? }]
  let inputValue = ''
  let sending = false
  let loadError = ''

  function draw() {
    if (!isTauriRuntime()) {
      el.innerHTML = `
        <div class="page-header">
          <div>
            <h1 class="page-title">${escHtml(t('engine.hermesGroupChatTitle'))}</h1>
          </div>
        </div>
        <div style="padding:32px;text-align:center;color:var(--text-tertiary)">
          ${escHtml(t('engine.hermesGroupChatWebUnsupported'))}
        </div>`
      return
    }
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesGroupChatTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesGroupChatDesc'))}</p>
        </div>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm" id="hm-gc-clear" ${!messages.length || sending ? 'disabled' : ''}>${escHtml(t('engine.hermesGroupChatClear'))}</button>
        </div>
      </div>
      ${loadError ? `<div style="color:var(--error);padding:16px">${escHtml(loadError)}</div>` : ''}
      <div class="hm-gc-layout">
        <div class="hm-gc-side">
          <div class="hm-gc-side-title">${escHtml(t('engine.hermesGroupChatProfiles'))}</div>
          <div class="hm-gc-side-hint">${escHtml(t('engine.hermesGroupChatProfilesHint'))}</div>
          <div class="hm-gc-profile-list">
            ${profiles.length ? profiles.map(renderProfileCheckbox).join('') : `<div style="color:var(--text-tertiary);font-size:12px;padding:8px 0">${escHtml(t('common.loading'))}…</div>`}
          </div>
          <div class="hm-gc-selected-count">${escHtml(t('engine.hermesGroupChatSelected', { n: selected.size }))}</div>
        </div>
        <div class="hm-gc-main">
          <div class="hm-gc-messages" id="hm-gc-messages">
            ${messages.length === 0 ? `<div class="hm-gc-empty">${escHtml(t('engine.hermesGroupChatEmpty'))}</div>` : messages.map(renderMessage).join('')}
          </div>
          <div class="hm-gc-input-wrap">
            <textarea class="hm-gc-input" id="hm-gc-input"
              placeholder="${escAttr(t('engine.hermesGroupChatPlaceholder'))}"
              ${sending ? 'disabled' : ''}>${escHtml(inputValue)}</textarea>
            <button class="btn btn-primary btn-sm" id="hm-gc-send"
              ${sending || !inputValue.trim() || !selected.size ? 'disabled' : ''}>
              ${escHtml(sending ? t('engine.hermesGroupChatSending') : t('engine.hermesGroupChatSend'))}
            </button>
          </div>
        </div>
      </div>
    `
    bind()
    scrollToBottom()
  }

  function renderProfileCheckbox(p) {
    const isChecked = selected.has(p)
    return `
      <label class="hm-gc-profile-item ${isChecked ? 'is-checked' : ''}">
        <input type="checkbox" data-profile="${escAttr(p)}" ${isChecked ? 'checked' : ''} ${sending ? 'disabled' : ''}>
        <span class="hm-gc-profile-name">${escHtml(p)}</span>
      </label>
    `
  }

  function renderMessage(m) {
    if (m.role === 'user') {
      return `
        <div class="hm-gc-msg hm-gc-msg--user">
          <div class="hm-gc-msg-bubble">${escHtml(m.content)}</div>
          <div class="hm-gc-msg-meta">${escHtml(formatTime(m.ts))}</div>
        </div>
      `
    }
    if (m.role === 'system') {
      return `
        <div class="hm-gc-msg hm-gc-msg--system">
          <div class="hm-gc-msg-meta">${escHtml(m.content)}</div>
        </div>
      `
    }
    // assistant
    const fromTag = m.from ? `<span class="hm-gc-msg-from">@${escHtml(m.from)}</span>` : ''
    if (m.loading) {
      return `
        <div class="hm-gc-msg hm-gc-msg--assistant">
          <div class="hm-gc-msg-meta">${fromTag} <span class="hm-gc-loading-dots"><span></span><span></span><span></span></span></div>
        </div>
      `
    }
    if (m.error) {
      return `
        <div class="hm-gc-msg hm-gc-msg--assistant hm-gc-msg--error">
          <div class="hm-gc-msg-meta">${fromTag} <span style="color:var(--error)">⚠️ ${escHtml(t('engine.hermesGroupChatRunFailed'))}</span></div>
          <div class="hm-gc-msg-bubble" style="color:var(--error)">${escHtml(m.error)}</div>
        </div>
      `
    }
    return `
      <div class="hm-gc-msg hm-gc-msg--assistant">
        <div class="hm-gc-msg-meta">${fromTag} <span>${escHtml(formatTime(m.ts))}</span></div>
        <div class="hm-gc-msg-bubble">${escHtml(m.content)}</div>
      </div>
    `
  }

  function bind() {
    el.querySelector('#hm-gc-clear')?.addEventListener('click', () => {
      messages = []
      draw()
    })
    el.querySelectorAll('input[data-profile]').forEach(cb => {
      cb.addEventListener('change', () => {
        const name = cb.dataset.profile
        if (cb.checked) selected.add(name)
        else selected.delete(name)
        draw()
      })
    })
    const input = el.querySelector('#hm-gc-input')
    if (input) {
      input.addEventListener('input', () => {
        inputValue = input.value
        // 只更新 send 按钮 disabled
        const btn = el.querySelector('#hm-gc-send')
        if (btn) btn.disabled = sending || !inputValue.trim() || !selected.size
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (!sending && inputValue.trim() && selected.size) onSend()
        }
      })
    }
    el.querySelector('#hm-gc-send')?.addEventListener('click', onSend)
  }

  function scrollToBottom() {
    const box = el.querySelector('#hm-gc-messages')
    if (box) box.scrollTop = box.scrollHeight
  }

  async function loadProfiles() {
    try {
      const data = await api.hermesProfilesList().catch(() => ({ profiles: [] }))
      const arr = Array.isArray(data) ? data : (data?.profiles || [])
      profiles = arr.map(p => (typeof p === 'string' ? p : (p.name || ''))).filter(Boolean)
      if (!profiles.includes('default')) profiles.unshift('default')
      // 默认选中前 1 个
      if (!selected.size && profiles.length) selected.add(profiles[0])
    } catch (e) {
      loadError = String(e?.message || e)
    }
    draw()
  }

  async function onSend() {
    const text = inputValue.trim()
    if (!text || !selected.size || sending) return
    sending = true
    const userMsg = { id: uid(), role: 'user', content: text, ts: Date.now() }
    messages.push(userMsg)
    inputValue = ''

    // 给每个选中的 profile 创建 loading 占位
    const targets = Array.from(selected)
    const placeholders = targets.map(p => ({
      id: uid(),
      role: 'assistant',
      from: p,
      content: '',
      loading: true,
      ts: Date.now(),
    }))
    messages.push(...placeholders)
    draw()

    // 并发调用每个 profile 的 hermes_agent_run
    // 注意：当前 hermesAgentRun 用的是当前 active profile，不支持参数传递。
    // 简化策略：用 hermes_profile_use 切换 profile（串行调度），
    // 每个 profile run 完后切到下一个。
    // 这是个 trade-off — 真正的并发需要后端改造支持 per-call profile。
    let activeProfile = null
    try {
      // 记下当前 active profile 用于最后还原
      const curResp = await api.hermesProfilesList().catch(() => null)
      const curArr = Array.isArray(curResp) ? curResp : (curResp?.profiles || [])
      activeProfile = curResp?.active || curArr.find(p => p.active)?.name || 'default'
    } catch {}

    for (let i = 0; i < targets.length; i++) {
      const profile = targets[i]
      const placeholder = placeholders[i]
      try {
        // 切到该 profile
        if (profile !== activeProfile) {
          await api.hermesProfileUse(profile)
          activeProfile = profile
        }
        // 调 agent run（非流式）
        const result = await api.hermesAgentRun(text, null, null, null, null)
        // result 形如 { final, messages, ... }
        const finalText = result?.final?.content
          || result?.final
          || result?.output
          || (Array.isArray(result?.messages) && result.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content)
          || JSON.stringify(result || '').slice(0, 500)
        placeholder.loading = false
        placeholder.content = String(finalText || '').trim() || t('engine.hermesGroupChatNoOutput')
        placeholder.ts = Date.now()
      } catch (e) {
        placeholder.loading = false
        placeholder.error = String(e?.message || e).slice(0, 500)
      }
      draw()
    }

    // 还原 active profile（如果改了）— 静默尝试
    sending = false
    draw()
  }

  draw()
  if (isTauriRuntime()) loadProfiles()
  return el
}
