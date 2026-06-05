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
import { api, isTauriRuntime, safeTauriListen } from '../../../lib/tauri-api.js'
import { svgIcon } from '../lib/svg-icons.js'
import { matchesHermesRun } from '../lib/hermes-run-events.js'

/**
 * Hermes `hermes_agent_run` 是 streaming-with-events：它通过 SSE 消费 Hermes Gateway
 * 的 `/v1/runs/{id}/events` 并把每个事件用 `app.emit("hermes-run-*")` 派发到前端，
 * 命令本身 resolve 的是 *run_id 字符串*（不是 final 输出）。
 *
 * 群聊页之前把 run_id 当成回复直接展示出来（典型现象：消息气泡里只有 `"run_xxx..."`），
 * 是因为 onSend 把 `await api.hermesAgentRun(...)` 的返回值当成结果对象去解析。
 *
 * 这个 helper 串联两端：
 *   1. 注册 `hermes-run-{started,delta,done,error,cancelled}` listener
 *   2. 调用 `hermesAgentRun(input)` 触发 run；命令在 SSE 流结束后才 resolve，
 *      所以 done 事件一般已经先到了 — listener 即可拿到 `payload.output`。
 *   3. 兜底：done 没到时累积 delta 文本作为最终结果。
 *
 * 注意：并发场景下 listener 会全局收事件，因此用 run_id 过滤，
 * 串行模式（当前群聊调度方式）也能 race-safe。
 */
async function runHermesAgentAndWaitFinal(input) {
  if (!isTauriRuntime()) {
    throw new Error('Hermes group chat requires Tauri runtime')
  }
  return new Promise((resolve, reject) => {
    const unsubs = []
    let runId = null
    let accumulated = ''
    let settled = false
    const cleanup = () => {
      for (const u of unsubs) {
        try { u() } catch { /* listener already detached */ }
      }
    }
    const finish = (text) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(text)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    ;(async () => {
      try {
        unsubs.push(await safeTauriListen('hermes-run-started', (e) => {
          if (!runId && e?.payload?.run_id) runId = e.payload.run_id
        }))
        unsubs.push(await safeTauriListen('hermes-run-delta', (e) => {
          if (!matchesHermesRun(runId, e?.payload?.run_id)) return
          accumulated += e?.payload?.delta || ''
        }))
        unsubs.push(await safeTauriListen('hermes-run-done', (e) => {
          if (!matchesHermesRun(runId, e?.payload?.run_id)) return
          const out = (e?.payload?.output || accumulated || '').trim()
          finish(out)
        }))
        unsubs.push(await safeTauriListen('hermes-run-error', (e) => {
          if (!matchesHermesRun(runId, e?.payload?.run_id)) return
          fail(new Error(e?.payload?.error || 'unknown error'))
        }))
        unsubs.push(await safeTauriListen('hermes-run-cancelled', (e) => {
          if (!matchesHermesRun(runId, e?.payload?.run_id)) return
          finish(accumulated.trim() || '(cancelled)')
        }))

        // 触发 run。Rust 端 hermes_agent_run 内部消费 SSE 直到 [DONE] 才 resolve，
        // 因此 done 事件一般已经先到，listener 已经 finish 过；这里拿到的 run_id 仅作兜底。
        const ridFromAck = await api.hermesAgentRun(input, null, null, null, null)
        if (!runId) runId = ridFromAck

        // 防御：如果 done 事件因为顺序问题尚未派发（理论上不会发生），等一拍兜底
        setTimeout(() => {
          if (!settled) finish(accumulated.trim())
        }, 300)
      } catch (e) {
        fail(e)
      }
    })()
  })
}

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
          <div class="hm-gc-msg-meta">${fromTag} <span style="color:var(--error);display:inline-flex;align-items:center;gap:4px">${svgIcon('alert-triangle', { size: 12 })} ${escHtml(t('engine.hermesGroupChatRunFailed'))}</span></div>
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
    let initialProfile = null
    let activeProfile = null
    try {
      const curResp = await api.hermesProfilesList().catch(() => null)
      const curArr = Array.isArray(curResp) ? curResp : (curResp?.profiles || [])
      initialProfile = curResp?.active || curArr.find(p => p.active)?.name || 'default'
      activeProfile = initialProfile
    } catch {}

    for (let i = 0; i < targets.length; i++) {
      const profile = targets[i]
      const placeholder = placeholders[i]
      try {
        if (profile !== activeProfile) {
          await api.hermesProfileUse(profile)
          activeProfile = profile
        }
        // 触发 agent run，并通过 hermes-run-* 事件等真正的 final 输出。
        // 不能直接用 hermesAgentRun 的返回值，它只是 run_id 字符串，不是回复内容。
        const finalText = await runHermesAgentAndWaitFinal(text)
        placeholder.loading = false
        placeholder.content = finalText || t('engine.hermesGroupChatNoOutput')
        placeholder.ts = Date.now()
      } catch (e) {
        placeholder.loading = false
        placeholder.error = String(e?.message || e).slice(0, 500)
      }
      draw()
    }

    if (initialProfile && activeProfile !== initialProfile) {
      await api.hermesProfileUse(initialProfile).catch(() => {})
    }
    sending = false
    draw()
  }

  draw()
  if (isTauriRuntime()) loadProfiles()
  return el
}
