import { api } from '../../../lib/tauri-api.js'
import { t } from '../../../lib/i18n.js'
import { renderMarkdown } from '../../../lib/markdown.js'
import { showConfirm } from '../../../components/modal.js'
import { icon } from '../../../lib/icons.js'
import { esc } from '../lib/view.js'
import { createPiState, applyPiEvent } from '../lib/session-state.js'
import { conversationEntries, modelOptions, toolPresentation } from '../lib/presentation.js'
import { createPiDraftStore, piRetryDelay, canRetryPiEvents } from '../lib/workspace-state.js'
import '../../../style/pi.css'

let teardown = () => {}
export function cleanup() { teardown() }

export function render() {
  const page = document.createElement('div')
  page.className = 'page pi-workspace-page'
  let disposed = false, generation = 0, rendering = null, operating = false, disconnected = false, composing = false
  let status = null, sessions = [], sessionId = '', cursor = 0, models = [], currentModel = '', draft = '', state = createPiState()
  const compact = window.matchMedia('(max-width: 900px)')
  const drafts = createPiDraftStore(sessionStorage)
  let search = '', visibleSessions = 100, retryWake = null, backgroundTimer = null, backgroundPending = false
  let historyOpen = !compact.matches
  const dialogDrafts = new Map()
  const resize = () => { historyOpen = !compact.matches; draw() }
  compact.addEventListener('change', resize)
  teardown = () => { disposed = true; generation++; clearTimeout(rendering); clearInterval(backgroundTimer); retryWake?.(); compact.removeEventListener('change', resize) }

  const sessionName = session => !session?.name || session.name === 'New session' ? t('pi.newSession') : session.name.replace(/\s+/g, ' ').trim()
  const sessionDate = session => {
    const date = new Date(session.updatedAt)
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
  }
  const sizeInput = () => {
    const input = page.querySelector('#pi-input')
    if (input) { input.style.height = '52px'; input.style.height = Math.min(150, Math.max(52, input.scrollHeight)) + 'px' }
  }

  const entryHtml = entry => {
    if (entry.kind === 'tool') return `<details class="pi-tool" data-detail="${esc(entry.key)}"><summary>${icon(entry.icon, 14)}<span>${esc(t('pi.' + entry.labelKey))}</span><span class="pi-tool-target">${esc(entry.target)}</span><span class="pi-tool-status ${entry.status}">${esc(t('pi.' + entry.status))}</span></summary><pre>${esc(JSON.stringify({ tool: entry.name, arguments: entry.args, result: entry.output }, null, 2))}</pre></details>`
    if (entry.message.role === 'user') return `<article class="pi-message pi-message-user" aria-label="${t('pi.user')}"><div class="pi-user-bubble">${esc(entry.text)}</div></article>`
    return `<article class="pi-message pi-message-assistant" aria-label="${t('pi.assistant')}"><div class="pi-message-heading"><span class="pi-avatar" aria-hidden="true">π</span>Pi</div><div class="pi-message-body">
      ${entry.thinking ? `<details class="pi-thinking" data-detail="${esc(entry.key)}-thinking"><summary>${t('pi.thinking')}</summary><pre>${esc(entry.thinking)}</pre></details>` : ''}
      ${renderMarkdown(entry.text)}${entry.aborted ? `<div class="pi-stopped">${icon('stop', 12)}${t('pi.stopped')}</div>` : entry.message.errorMessage ? `<p class="pi-error">${esc(entry.message.errorMessage)}</p>` : ''}</div></article>`
  }

  const emptyHtml = () => {
    const installed = status?.installed, hasModels = status?.providers?.length
    const subtitle = !status ? t('pi.busy') : !installed ? t('pi.installToStart') : !hasModels ? t('pi.noModels') : t('pi.workbenchIntro')
    return `<div class="pi-empty"><div class="pi-empty-mark" aria-hidden="true">π</div><h2>${t('pi.readyToWork')}</h2><p>${subtitle}</p>
      ${status && !installed ? `<a class="btn btn-primary" href="#/pi/dashboard">${t('pi.install')}</a>` : installed && !hasModels ? `<a class="btn btn-primary" href="#/model-channels">${t('pi.channels')}</a>` : installed ? `<div class="pi-suggestions">${['suggestExplore', 'suggestReview', 'suggestTest'].map(key => `<button class="pi-suggestion" data-action="suggest" data-prompt="${key}" ${operating ? 'disabled' : ''}>${t('pi.' + key)}</button>`).join('')}</div>` : ''}</div>`
  }

  const dialogHtml = dialog => {
    const guardedTool = dialog.method === 'confirm' && /^ClawPanel · (write|edit|bash|powershell)$/.test(dialog.title)
    const title = guardedTool ? `${t('pi.approval')} · ${t('pi.' + toolPresentation({ name: dialog.title.split(' · ')[1] }).labelKey)}` : dialog.title
    return `<section class="pi-dialog" data-dialog="${esc(dialog.id)}" role="group" aria-label="${esc(title)}">
    <div class="pi-dialog-heading">${icon(guardedTool ? 'lock' : 'message-square', 15)}<b>${esc(title)}</b></div>${dialog.message ? `<p>${esc(dialog.message)}</p>` : ''}
    ${dialog.method === 'select' ? `<select class="form-input" aria-label="${esc(dialog.title)}">${dialog.options.map(option => `<option value="${esc(option)}" ${dialogDrafts.get(dialog.id) === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>` : ''}
    ${['input', 'editor'].includes(dialog.method) ? `<textarea class="form-input" aria-label="${esc(dialog.title)}" placeholder="${esc(dialog.placeholder || '')}">${esc(dialogDrafts.get(dialog.id) ?? dialog.prefill ?? '')}</textarea>` : ''}
    <div class="pi-actions">${dialog.method === 'confirm' ? `<button class="btn btn-primary" data-action="confirm">${t('pi.yes')}</button><button class="btn btn-secondary" data-action="deny">${t('pi.no')}</button>` : `<button class="btn btn-primary" data-action="reply">${t('pi.reply')}</button>`}<button class="btn btn-secondary" data-action="cancel">${t('pi.cancel')}</button></div></section>`
  }

  const draw = () => {
    if (disposed) return
    // 流式更新暂缓到输入法合成结束，避免中文候选被整页重绘打断。
    if (composing) { schedule(); return }
    const focused = page.contains(document.activeElement) ? document.activeElement : null
    const focusId = focused?.id
    const focusAction = focused?.closest('[data-action]')?.dataset.action
    const focusSession = focused?.closest('[data-id]')?.dataset.id
    const focusDetail = focused?.closest('[data-detail]')?.dataset.detail
    const focusDialog = focused?.closest('[data-dialog]')?.dataset.dialog
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null
    const transcript = page.querySelector('.pi-transcript')
    const scroll = transcript?.scrollTop || 0
    const atBottom = !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
    const railScroll = page.querySelector('.pi-session-list')?.scrollTop || 0
    const dialogScroll = page.querySelector('.pi-dialogs')?.scrollTop || 0
    const expanded = new Set([...page.querySelectorAll('details[open][data-detail]')].map(element => element.dataset.detail))
    const entries = conversationEntries(state.messages, state.tools)
    const choices = modelOptions(models, status?.providers)
    const workspace = sessions.find(session => session.id === sessionId)?.workspace || status?.config?.workspace || ''
    const selectedSession = sessions.find(session => session.id === sessionId)
    const filteredSessions = sessions.filter(session => (sessionName(session) + ' ' + session.workspace).toLowerCase().includes(search.toLowerCase()))
    const awaiting = sessions.filter(session => session.id !== sessionId && session.pendingDialogs?.length)
    const readiness = disconnected ? 'offline' : state.dialogs.length ? 'waiting' : state.busy ? 'running' : 'idle'
    page.innerHTML = `<header class="pi-workspace-header">
      <button id="pi-history-toggle" class="pi-icon-button" data-action="history" title="${t('pi.toggleHistory')}" aria-label="${t('pi.toggleHistory')}" aria-controls="pi-history" aria-expanded="${historyOpen}">${icon('clock', 18)}</button>
      <div class="pi-workspace-title"><h1>Pi ${t('pi.workspace')}<span class="pi-preview-badge">${t('pi.experimental')}</span></h1><p title="${esc(workspace)}">${icon('folder', 12)}<span>${esc(workspace || t('pi.workingDirectory'))}</span></p></div>
      <div class="pi-header-actions"><button class="pi-icon-button" data-action="refresh" aria-label="${t('pi.refresh')}" title="${t('pi.refresh')}" ${operating ? 'disabled' : ''}>${icon('refresh-cw', 16)}</button><button class="pi-icon-button" data-action="close" aria-label="${t('pi.closeSession')}" title="${t('pi.closeSession')}" ${!sessionId || operating ? 'disabled' : ''}>${icon('x', 16)}</button><a class="pi-icon-button" href="#/pi/dashboard" aria-label="${t('pi.dashboard')}" title="${t('pi.dashboard')}">${icon('gear', 17)}</a></div></header>
      ${state.error ? `<div class="pi-workspace-alert pi-error" role="alert">${esc(state.error)}</div>` : ''}
      ${awaiting.length ? `<button class="pi-background-alert" data-action="session" data-id="${esc(awaiting[0].id)}">${esc(t('pi.backgroundApproval', { count: awaiting.length }))}</button>` : ''}
      <div class="pi-workbench"><button class="pi-rail-backdrop" data-action="hide-history" aria-label="${t('pi.hideHistory')}" ${historyOpen ? '' : 'hidden'}></button>
      <aside id="pi-history" class="pi-session-rail" aria-label="${t('pi.sessions')}" ${historyOpen ? '' : 'hidden'}>
        <button class="btn btn-primary pi-new-session" data-action="new" ${operating || !status?.installed || !status?.providers.length ? 'disabled' : ''}>${icon('plus-circle', 15)}${t('pi.newSession')}</button>
        <div class="pi-rail-caption"><span>${t('pi.recentSessions')}</span><span>${sessions.length}</span></div>
        <input id="pi-session-search" class="form-input pi-session-search" aria-label="${t('pi.searchSessions')}" placeholder="${t('pi.searchSessions')}" value="${esc(search)}">
        <div class="pi-session-list">${sessions.length ? filteredSessions.slice(0, visibleSessions).map(session => `<div class="pi-session-row"><button class="pi-session ${session.id === sessionId ? 'active' : ''}" data-action="session" data-id="${esc(session.id)}" aria-current="${session.id === sessionId ? 'true' : 'false'}" title="${esc(sessionName(session))}" ${operating ? 'disabled' : ''}>${icon('message-square', 14)}<span class="pi-session-copy"><span class="pi-session-name">${esc(sessionName(session))}</span><small>${esc(session.pendingDialogs?.length ? t('pi.waiting') : (session.id === sessionId ? state.busy : session.busy) ? t('pi.running') : sessionDate(session))}</small></span></button>${session.running ? `<button class="pi-icon-button" data-action="close-session" data-id="${esc(session.id)}" aria-label="${esc(t('pi.closeNamed', { name: sessionName(session) }))}" ${operating ? 'disabled' : ''}>${icon('x', 12)}</button>` : ''}</div>`).join('') : `<p class="pi-rail-empty">${t('pi.noSessions')}</p>`}${filteredSessions.length > visibleSessions ? `<button class="btn btn-secondary" data-action="more">${t('pi.moreSessions')}</button>` : ''}</div>
        <div class="pi-rail-footer"><span>${icon('lock', 12)}${t('pi.localHistory')}</span><p>${t('pi.historyHint')}</p></div>
      </aside>
      <section class="pi-chat" aria-label="${t('pi.workspace')}" ${compact.matches && historyOpen ? 'inert' : ''}>
        <div class="pi-transcript" role="log" aria-live="off" aria-label="${t('pi.conversation')}">${entries.length ? `<div class="pi-message-list">${entries.map(entryHtml).join('')}</div>` : emptyHtml()}</div>
        <div class="pi-chat-bottom"><div class="pi-status" role="status"><span class="pi-status-dot ${readiness}" aria-hidden="true"></span>${!status || operating ? t('pi.busy') : disconnected ? t('pi.connectionLost') : state.dialogs.length ? t('pi.waiting') : state.busy ? t('pi.running') : t('pi.idle')}</div>
        <div class="pi-dialogs">${state.dialogs.map(dialogHtml).join('')}</div>
        <form class="pi-composer"><textarea id="pi-input" rows="2" aria-label="${t('pi.input')}" placeholder="${t('pi.input')}" ${!sessionId ? 'disabled' : ''}>${esc(draft)}</textarea>
          <div class="pi-composer-footer"><label class="pi-model-picker" title="${t('pi.model')}">${icon('zap', 13)}<select id="pi-model" aria-label="${t('pi.model')}" ${!sessionId || state.busy || operating || disconnected ? 'disabled' : ''}>${choices.length ? choices.map(model => `<option value="${esc(model.value)}" ${currentModel === model.value ? 'selected' : ''}>${esc(model.label)}</option>`).join('') : `<option>${t('pi.selectModel')}</option>`}</select></label>
          ${state.busy ? `<button type="button" class="pi-send" data-action="stop" aria-label="${t('pi.stop')}" title="${t('pi.stop')}" ${operating || disconnected ? 'disabled' : ''}>${icon('stop', 17)}</button>` : `<button type="submit" class="pi-send" aria-label="${t('pi.send')}" title="${t('pi.send')}" ${!sessionId || operating || !models.length || disconnected || !draft.trim() ? 'disabled' : ''}>${icon('send', 17)}</button>`}</div>
        </form><div class="pi-composer-hint"><span>${icon('lock', 10)}${selectedSession?.allowTools ? t('pi.confirmTools') : t('pi.readOnlyTools')}</span><span class="pi-keyboard-hint">${t('pi.keyboardHint')}</span></div></div>
      </section></div>`
    for (const detail of page.querySelectorAll('details[data-detail]')) detail.open = expanded.has(detail.dataset.detail)
    sizeInput()
    const next = page.querySelector('.pi-transcript')
    next.scrollTop = atBottom ? next.scrollHeight : scroll
    page.querySelector('.pi-session-list').scrollTop = railScroll
    page.querySelector('.pi-dialogs').scrollTop = dialogScroll
    const dialogTarget = focusDialog ? [...page.querySelectorAll('[data-dialog]')].find(el => el.dataset.dialog === focusDialog) : null
    const target = focusId ? page.querySelector('#' + focusId)
      : focusDialog ? (focusAction ? dialogTarget?.querySelector(`[data-action="${focusAction}"]`) : dialogTarget?.querySelector('textarea, select'))
        : focusSession ? [...page.querySelectorAll('[data-id]')].find(element => element.dataset.id === focusSession)
          : focusDetail ? [...page.querySelectorAll('[data-detail]')].find(element => element.dataset.detail === focusDetail)?.querySelector('summary')
            : focusAction ? page.querySelector(`[data-action="${focusAction}"]`) : null
    target?.focus({ preventScroll: true })
    if (selection && target?.setSelectionRange) target.setSelectionRange(...selection)
  }
  const schedule = () => { if (!rendering) rendering = setTimeout(() => { rendering = null; draw() }, 80) }
  const applySnapshot = snapshot => {
    disconnected = false
    sessionId = snapshot.sessionId; cursor = snapshot.cursor
    state = createPiState(snapshot); models = snapshot.models
    currentModel = snapshot.state.model ? JSON.stringify([snapshot.state.model.provider, snapshot.state.model.id]) : ''
    if (state.busy && state.messages.at(-1)?.role === 'assistant') state.active = state.messages.length - 1
  }
  const poll = async token => {
    let failures = 0
    while (!disposed && token === generation && sessionId) {
      try {
        const result = await api.piCall('events', { sessionId, after: cursor })
        if (disposed || token !== generation) return
        const changed = disconnected || result.reset || result.events.length > 0 || state.busy !== result.busy || JSON.stringify(state.dialogs) !== JSON.stringify(result.pendingDialogs)
        if ((result.reset || disconnected) && !result.closed) {
          const snapshot = await api.piCall('session_state', { sessionId })
          if (disposed || token !== generation) return
          applySnapshot(snapshot)
          failures = 0
        }
        else {
          for (const record of result.events) applyPiEvent(state, record.event)
          cursor = result.cursor
          state.busy = result.busy
          state.dialogs = result.pendingDialogs
        }
        if (result.closed) { disconnected = true; state.error ||= t('pi.disconnected'); draw(); return }
        // 空长轮询不重绘，保留输入焦点、展开内容和原生选项菜单。
        if (changed) schedule()
      } catch (error) {
        if (disposed || token !== generation) return
        state.error = `${t('pi.disconnected')}\n${error?.message || error}`
        disconnected = true; draw()
        if (!canRetryPiEvents(error, failures)) return
        const delay = piRetryDelay(failures++)
        await new Promise(resolve => {
          const timer = setTimeout(() => { retryWake = null; resolve() }, delay)
          retryWake = () => { clearTimeout(timer); retryWake = null; resolve() }
        })
      }
    }
  }
  const open = async id => {
    generation++
    retryWake?.()
    const token = generation
    const snapshot = await api.piCall('open_session', id ? { sessionId: id } : {})
    if (disposed || token !== generation) return
    applySnapshot(snapshot)
    draft = drafts.get(status.root, sessionId)
    if (compact.matches) historyOpen = false
    drafts.last(status.root, sessionId)
    sessions = await api.piCall('sessions')
    if (disposed || token !== generation) return
    draw(); poll(token)
  }
  const refresh = async () => {
    const token = generation
    status = await api.piCall('status'); sessions = await api.piCall('sessions')
    if (disposed || token !== generation) return
    const previous = sessionId || drafts.last(status.root)
    if (previous && sessions.some(session => session.id === previous) && status.installed) await open(previous)
    else draw()
  }
  const perform = async operation => {
    if (operating) return
    operating = true; state.error = ''; draw()
    try { await operation() } catch (error) { state.error = error?.message || String(error) } finally { operating = false; draw() }
  }
  page.addEventListener('input', event => {
    if (event.target.id === 'pi-input') {
      draft = event.target.value; sizeInput()
      if (status) drafts.set(status.root, sessionId, draft)
      const sendButton = page.querySelector('button[type="submit"]')
      if (sendButton) sendButton.disabled = !sessionId || operating || !models.length || disconnected || !draft.trim()
    }
    if (event.target.id === 'pi-session-search') { search = event.target.value; visibleSessions = 100; schedule() }
    const id = event.target.closest('[data-dialog]')?.dataset.dialog
    if (id) dialogDrafts.set(id, event.target.value)
  })
  page.addEventListener('compositionstart', () => { composing = true })
  page.addEventListener('compositionend', () => { composing = false; schedule() })
  page.addEventListener('change', event => {
    if (event.target.id === 'pi-model') {
      const [provider, modelId] = JSON.parse(event.target.value)
      perform(async () => { await api.piCall('set_model', { sessionId, provider, modelId }); currentModel = JSON.stringify([provider, modelId]) })
    }
    const id = event.target.closest('[data-dialog]')?.dataset.dialog
    if (id) dialogDrafts.set(id, event.target.value)
  })
  const send = () => perform(async () => {
    if (!sessionId || !draft.trim() || state.busy || disconnected) return
    const message = draft, submittedId = sessionId, root = status.root, submission = drafts.begin(root, submittedId, message)
    draft = ''; state.busy = true; draw()
    try {
      await api.piCall('prompt', { sessionId: submittedId, message })
      drafts.settle(submission, true)
    } catch (error) {
      drafts.settle(submission, false)
      if (sessionId === submittedId) { draft = drafts.get(root, submittedId); state.busy = false }
      throw error
    }
    // 已接受的任务不因旁路列表读取失败而回退成“发送失败”。
    sessions = await api.piCall('sessions').catch(() => sessions)
  })
  page.addEventListener('submit', event => { event.preventDefault(); send() })
  page.addEventListener('keydown', event => {
    if (event.key === 'Escape' && compact.matches && historyOpen) { historyOpen = false; draw(); page.querySelector('#pi-history-toggle').focus() }
    if (event.target.id === 'pi-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send() }
  })
  page.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (!action) return
    const button = event.target.closest('[data-action]')
    if (button.disabled) return
    if (action === 'history' || action === 'hide-history') {
      historyOpen = action === 'history' ? !historyOpen : false
      draw(); page.querySelector('#pi-history-toggle').focus(); return
    }
    if (action === 'more') { visibleSessions += 100; draw(); return }
    const dialogEl = button.closest('[data-dialog]')
    perform(async () => {
      if (action === 'new') await open()
      else if (action === 'suggest') {
        if (!sessionId) await open()
        draft = t('pi.' + button.dataset.prompt + 'Prompt'); drafts.set(status.root, sessionId, draft); draw(); page.querySelector('#pi-input').focus()
      }
      else if (action === 'session') await open(button.dataset.id)
      else if (action === 'refresh') await refresh()
      else if (action === 'stop') { await api.piCall('abort', { sessionId }); state.busy = false }
      else if ((action === 'close' || action === 'close-session') && await showConfirm(t('pi.closeConfirm'))) {
        const closingId = button.dataset.id || sessionId
        await api.piCall('close_session', { sessionId: closingId })
        if (closingId === sessionId) {
          generation++; retryWake?.(); sessionId = ''; draft = ''; disconnected = false
          models = []; currentModel = ''; drafts.last(status.root, ''); state = createPiState()
        }
        sessions = await api.piCall('sessions')
      } else if (dialogEl) {
        const id = dialogEl.dataset.dialog
        await api.piCall('dialog_response', { sessionId, id, ...(action === 'cancel' ? { cancelled: true } : ['confirm', 'deny'].includes(action) ? { confirmed: action === 'confirm' } : { value: dialogEl.querySelector('select, textarea').value }) })
        dialogDrafts.delete(id); state.dialogs = state.dialogs.filter(dialog => dialog.id !== id)
      }
    })
  })
  draw(); refresh().catch(error => { state.error = error?.message || String(error); draw() })
  backgroundTimer = setInterval(async () => {
    if (disposed || operating || document.hidden || backgroundPending) return
    backgroundPending = true
    try {
      const updated = await api.piCall('sessions')
      if (disposed) return
      if (JSON.stringify(updated) !== JSON.stringify(sessions)) { sessions = updated; schedule() }
    } catch { /* 当前会话的事件链路负责显示连接故障；后台状态不覆盖正文错误。 */ }
    finally { backgroundPending = false }
  }, 5000)
  return page
}
