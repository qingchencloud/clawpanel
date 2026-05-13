import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'
import { icon } from '../../../lib/icons.js'
import { getChatStore, getSourceLabel } from '../lib/chat-store.js'

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;')
}

function parseEpochMs(value) {
  if (!value) return 0
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const ts = Date.parse(String(value))
  return Number.isFinite(ts) ? ts : 0
}

function formatTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('engine.sessionsJustNow')
  if (diff < 3_600_000) return t('engine.sessionsMinutesAgo').replace('{n}', String(Math.max(1, Math.floor(diff / 60_000))))
  if (diff < 86_400_000) return t('engine.sessionsHoursAgo').replace('{n}', String(Math.max(1, Math.floor(diff / 3_600_000))))
  return d.toLocaleString()
}

function sessionKey(session) {
  return `${session.profile || 'default'}::${session.id}`
}

function sessionTitle(session) {
  return session?.title || session?.messages?.find(m => m.role === 'user')?.content?.slice(0, 64) || t('engine.sessionsUntitled')
}

function messagePreview(session) {
  const first = session?.messages?.find(m => m.role === 'user') || session?.messages?.[0]
  return first?.content ? String(first.content).replace(/\s+/g, ' ').slice(0, 180) : (session?.preview || t('engine.sessionsNoPreview'))
}

function tokenCount(session) {
  return Number(session?.inputTokens || 0) + Number(session?.outputTokens || 0)
}

function formatTokens(value) {
  const n = Number(value || 0)
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}

function normalizeMessage(m) {
  const raw = m?.content ?? m?.toolResult ?? m?.toolArgs ?? ''
  return {
    role: m?.role || 'message',
    content: typeof raw === 'string' ? raw : JSON.stringify(raw),
    timestamp: m?.timestamp || m?.created_at || '',
  }
}

function mapSessionSummary(s, profile) {
  return {
    id: s?.id || s?.session_id || '',
    profile: profile || 'default',
    title: s?.title || '',
    source: s?.source || '',
    model: s?.model || '',
    preview: s?.preview || '',
    lastActiveLabel: s?.last_active_label || '',
    messageCount: Number(s?.message_count || s?.messageCount || 0),
    createdAt: parseEpochMs(s?.created_at || s?.started_at || s?.createdAt),
    updatedAt: parseEpochMs(s?.updated_at || s?.last_active || s?.ended_at || s?.created_at || s?.started_at || s?.updatedAt),
    inputTokens: Number(s?.input_tokens || s?.inputTokens || 0),
    outputTokens: Number(s?.output_tokens || s?.outputTokens || 0),
    messages: Array.isArray(s?.messages) ? s.messages.map(normalizeMessage) : [],
    messagesLoaded: Array.isArray(s?.messages),
  }
}

function getFilteredSessions(rows, query, source) {
  const q = (query || '').trim().toLowerCase()
  let sessions = rows.slice()
  if (source !== '__all__') sessions = sessions.filter(s => (s.source || '') === source)
  if (q) {
    sessions = sessions.filter(s => {
      const hay = [s.id, s.profile, s.title, s.model, s.source, ...(s.messages || []).slice(0, 3).map(m => m.content)].join('\n').toLowerCase()
      return hay.includes(q)
    })
  }
  return sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
}

function uniqueSources(sessions) {
  return Array.from(new Set(sessions.map(s => s.source || ''))).sort((a, b) => getSourceLabel(a).localeCompare(getSourceLabel(b)))
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page hm-sessions-page'
  el.dataset.engine = 'hermes'

  const store = getChatStore()
  let query = ''
  let source = '__all__'
  let profileScope = store.state.activeProfile || 'default'
  let rows = []
  let selectedKey = null
  let selected = new Set()
  let loading = false
  let busy = false
  let detailLoadingKey = null

  const unsubscribe = store.subscribe(() => draw())

  function availableProfiles() {
    const profiles = store.state.profiles || []
    if (profiles.length) return profiles.map(p => p.name).filter(Boolean)
    return [store.state.activeProfile || 'default']
  }

  function targetProfiles() {
    return profileScope === '__all__' ? availableProfiles() : [profileScope]
  }

  function currentSessions() {
    return getFilteredSessions(rows, query, source)
  }

  function findByKey(key) {
    return rows.find(s => sessionKey(s) === key) || null
  }

  function currentSession() {
    return findByKey(selectedKey) || currentSessions()[0] || null
  }

  async function loadRows() {
    loading = true
    draw()
    try {
      const profiles = targetProfiles()
      const settled = await Promise.allSettled(profiles.map(async (profile) => {
        const list = await api.hermesSessionsSummaryList(null, 80, profile)
        return (Array.isArray(list) ? list : []).map(s => mapSessionSummary(s, profile)).filter(s => s.id)
      }))
      rows = settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      const failed = settled.filter(r => r.status === 'rejected').length
      if (failed) toast(t('engine.sessionsProfileLoadPartial').replace('{n}', String(failed)), 'warning')
      const visible = currentSessions()
      selected = new Set([...selected].filter(key => rows.some(s => sessionKey(s) === key)))
      selectedKey = selectedKey && rows.some(s => sessionKey(s) === selectedKey) ? selectedKey : (visible[0] ? sessionKey(visible[0]) : null)
    } catch (err) {
      toast(String(err?.message || err), 'error')
    } finally {
      loading = false
      draw()
    }
  }

  async function loadDetail(key, redraw = true) {
    const session = findByKey(key)
    if (!session || session.messagesLoaded || detailLoadingKey === key) return
    detailLoadingKey = key
    if (redraw) draw()
    try {
      const detail = await api.hermesSessionDetail(session.id, session.profile)
      session.messages = Array.isArray(detail?.messages) ? detail.messages.map(normalizeMessage) : []
      session.messagesLoaded = true
      session.title = session.title || detail?.title || ''
      session.model = session.model || detail?.model || ''
      session.source = session.source || detail?.source || ''
      session.messageCount = session.messageCount || session.messages.length
    } catch (err) {
      toast(t('engine.sessionsDetailLoadFailed') + ': ' + (err?.message || err), 'error')
    } finally {
      detailLoadingKey = null
      if (redraw) draw()
    }
  }

  function renderProfileBar() {
    const profiles = availableProfiles()
    return `
      <select class="hm-sessions-profile-select" id="hm-sessions-profile">
        <option value="__all__" ${profileScope === '__all__' ? 'selected' : ''}>${escHtml(t('engine.sessionsAllProfiles'))}</option>
        ${profiles.map(name => `<option value="${escAttr(name)}" ${profileScope === name ? 'selected' : ''}>${escHtml(name)}${name === store.state.activeProfile ? ' · active' : ''}</option>`).join('')}
      </select>
    `
  }

  function renderSessionRow(s) {
    const key = sessionKey(s)
    const checked = selected.has(key)
    const active = currentSession() && sessionKey(currentSession()) === key
    const pinned = s.profile === store.state.activeProfile && store.state.pinned.has(s.id)
    const tokens = tokenCount(s)
    return `
      <button class="hm-session-row ${active ? 'is-active' : ''} ${checked ? 'is-selected' : ''}" data-session-key="${escAttr(key)}">
        <span class="hm-session-row-check" data-check-id="${escAttr(key)}">${icon(checked ? 'check-circle' : 'circle', 16)}</span>
        <span class="hm-session-row-main">
          <span class="hm-session-row-title">${pinned ? icon('crown', 12) : ''}${escHtml(sessionTitle(s))}</span>
          <span class="hm-session-row-preview">${escHtml(messagePreview(s))}</span>
          <span class="hm-session-row-meta">
            <span>${escHtml(s.profile || 'default')}</span>
            <span>${escHtml(getSourceLabel(s.source || ''))}</span>
            ${s.model ? `<span>${escHtml(s.model)}</span>` : ''}
            <span>${formatTokens(tokens)} tok</span>
          </span>
        </span>
        <span class="hm-session-row-time">${escHtml(s.lastActiveLabel || formatTime(s.updatedAt || s.createdAt))}</span>
      </button>
    `
  }

  function renderDetail(session) {
    if (!session) {
      return `
        <section class="hm-session-detail is-empty">
          ${icon('message-square', 34)}
          <h3>${escHtml(t('engine.sessionsNoSelection'))}</h3>
          <p>${escHtml(t('engine.sessionsNoSelectionDesc'))}</p>
        </section>
      `
    }
    const key = sessionKey(session)
    const messages = (session.messages || []).slice(-30)
    const canPin = session.profile === store.state.activeProfile
    return `
      <section class="hm-session-detail">
        <div class="hm-session-detail-head">
          <div>
            <div class="hm-session-detail-kicker">${escHtml(session.profile || 'default')} · ${escHtml(getSourceLabel(session.source || ''))}</div>
            <h2>${escHtml(sessionTitle(session))}</h2>
            <div class="hm-session-detail-id">${escHtml(session.id)}</div>
          </div>
          <div class="hm-session-detail-actions">
            <button class="hm-sessions-btn" id="hm-session-open-chat">${icon('message-circle', 14)}${escHtml(t('engine.sessionsOpenChat'))}</button>
            ${canPin ? `<button class="hm-sessions-btn" id="hm-session-pin">${icon(store.state.pinned.has(session.id) ? 'crown' : 'target', 14)}${escHtml(store.state.pinned.has(session.id) ? t('engine.sessionsUnpin') : t('engine.sessionsPin'))}</button>` : ''}
            <button class="hm-sessions-btn" id="hm-session-export" data-session-id="${escAttr(session.id)}">${icon('download', 14)}${escHtml(t('engine.sessionsExport'))}</button>
            <button class="hm-sessions-btn is-danger" id="hm-session-delete" data-session-key="${escAttr(key)}">${icon('trash', 14)}${escHtml(t('engine.chatDeleteSession'))}</button>
          </div>
        </div>
        <div class="hm-session-stat-grid">
          <div><span>${escHtml(t('engine.sessionsMessages'))}</span><strong>${Number(session.messageCount || session.messages?.length || 0)}</strong></div>
          <div><span>${escHtml(t('engine.sessionsTokens'))}</span><strong>${formatTokens(tokenCount(session))}</strong></div>
          <div><span>${escHtml(t('engine.sessionsModel'))}</span><strong>${escHtml(session.model || '—')}</strong></div>
          <div><span>${escHtml(t('engine.sessionsUpdated'))}</span><strong>${escHtml(session.lastActiveLabel || formatTime(session.updatedAt || session.createdAt))}</strong></div>
        </div>
        <div class="hm-session-message-list">
          ${detailLoadingKey === key ? `<div class="hm-session-empty-messages">${escHtml(t('engine.chatLoadingMessages'))}</div>` : ''}
          ${detailLoadingKey !== key && messages.length ? messages.map(m => `
            <article class="hm-session-msg hm-session-msg--${escAttr(m.role || 'unknown')}">
              <div class="hm-session-msg-role">${escHtml(m.role || 'message')}</div>
              <div class="hm-session-msg-body">${escHtml(m.content || '')}</div>
            </article>
          `).join('') : ''}
          ${detailLoadingKey !== key && !messages.length ? `<div class="hm-session-empty-messages">${escHtml(t('engine.sessionsMessagesNotLoaded'))}</div>` : ''}
        </div>
      </section>
    `
  }

  function draw() {
    const sessions = currentSessions()
    const detail = currentSession()
    const sources = uniqueSources(rows)
    const allVisibleSelected = sessions.length > 0 && sessions.every(s => selected.has(sessionKey(s)))
    el.innerHTML = `
      <div class="hm-sessions-hero">
        <div>
          <div class="hm-sessions-eyebrow">HERMES · SESSIONS</div>
          <h1>${escHtml(t('engine.sessionsPageTitle'))}</h1>
          <p>${escHtml(t('engine.sessionsPageDesc'))}</p>
        </div>
        <div class="hm-sessions-hero-actions">
          ${renderProfileBar()}
          <button class="hm-sessions-btn" id="hm-sessions-refresh" ${busy || loading ? 'disabled' : ''}>${icon('refresh-cw', 14)}${escHtml(t('skills.refresh'))}</button>
          <button class="hm-sessions-btn is-ghost" id="hm-sessions-open-chat">${icon('message-circle', 14)}${escHtml(t('engine.chatSessions'))}</button>
        </div>
      </div>

      <div class="hm-sessions-stats">
        <div><span>${escHtml(t('engine.sessionsTotal'))}</span><strong>${rows.length}</strong></div>
        <div><span>${escHtml(t('engine.sessionsShown'))}</span><strong>${sessions.length}</strong></div>
        <div><span>${escHtml(t('engine.sessionsProfiles'))}</span><strong>${targetProfiles().length}</strong></div>
        <div><span>${escHtml(t('engine.sessionsSelected'))}</span><strong>${selected.size}</strong></div>
      </div>

      <div class="hm-sessions-shell">
        <aside class="hm-sessions-list-panel">
          <div class="hm-sessions-toolbar">
            <label class="hm-sessions-search">
              ${icon('search', 14)}
              <input id="hm-sessions-query" value="${escAttr(query)}" placeholder="${escAttr(t('engine.sessionsSearchPlaceholder'))}">
            </label>
            <select id="hm-sessions-source">
              <option value="__all__" ${source === '__all__' ? 'selected' : ''}>${escHtml(t('engine.sessionsAllSources'))}</option>
              ${sources.map(src => `<option value="${escAttr(src)}" ${source === src ? 'selected' : ''}>${escHtml(getSourceLabel(src))}</option>`).join('')}
            </select>
          </div>
          <div class="hm-sessions-bulkbar">
            <button id="hm-sessions-select-all">${icon(allVisibleSelected ? 'x' : 'check', 13)}${escHtml(allVisibleSelected ? t('engine.chatSelectNone') : t('engine.chatSelectAll'))}</button>
            <button id="hm-sessions-bulk-delete" class="is-danger" ${selected.size ? '' : 'disabled'}>${icon('trash', 13)}${escHtml(t('engine.chatBulkDelete'))}</button>
          </div>
          <div class="hm-sessions-list">
            ${loading ? `<div class="hm-sessions-loading">${escHtml(t('engine.chatLoading'))}</div>` : ''}
            ${!loading && !sessions.length ? `<div class="hm-sessions-empty">${escHtml(t('engine.sessionsEmpty'))}</div>` : ''}
            ${sessions.map(renderSessionRow).join('')}
          </div>
        </aside>
        ${renderDetail(detail)}
      </div>
    `
    bind()
  }

  async function openCurrentInChat() {
    const session = currentSession()
    if (!session) return
    try {
      busy = true
      draw()
      if (session.profile !== store.state.activeProfile) {
        await store.switchProfile(session.profile)
      }
      if (!store.state.sessions.some(s => s.id === session.id)) {
        await store.loadSessions()
      }
      await store.switchSession(session.id)
      window.location.hash = '#/h/chat'
    } catch (err) {
      toast(String(err?.message || err), 'error')
    } finally {
      busy = false
      draw()
    }
  }

  async function deleteOne(session) {
    if (!session) return
    const ok = await showConfirm(t('engine.chatConfirmDelete'))
    if (!ok) return
    try {
      if (session.profile === store.state.activeProfile && store.state.streaming && session.id === store.state.runningSessionId) {
        throw new Error('RUNNING_SESSION')
      }
      await api.hermesSessionDelete(session.id, session.profile)
      rows = rows.filter(s => sessionKey(s) !== sessionKey(session))
      selected.delete(sessionKey(session))
      selectedKey = null
      if (session.profile === store.state.activeProfile) await store.loadSessions()
      toast(t('engine.chatSessionDeleted'), 'success')
    } catch (err) {
      toast(t('engine.chatDeleteFailed') + ': ' + (err?.message || err), 'error')
    }
    draw()
  }

  function bind() {
    el.querySelector('#hm-sessions-refresh')?.addEventListener('click', async () => {
      busy = true
      draw()
      try { await loadRows() }
      finally { busy = false; draw() }
    })
    el.querySelector('#hm-sessions-open-chat')?.addEventListener('click', () => { window.location.hash = '#/h/chat' })
    el.querySelector('#hm-session-open-chat')?.addEventListener('click', openCurrentInChat)
    el.querySelector('#hm-sessions-query')?.addEventListener('input', (e) => {
      query = e.target.value
      selectedKey = currentSessions()[0] ? sessionKey(currentSessions()[0]) : null
      draw()
    })
    el.querySelector('#hm-sessions-source')?.addEventListener('change', (e) => {
      source = e.target.value
      selectedKey = currentSessions()[0] ? sessionKey(currentSessions()[0]) : null
      draw()
    })
    el.querySelector('#hm-sessions-profile')?.addEventListener('change', async (e) => {
      profileScope = e.target.value
      selected.clear()
      selectedKey = null
      await loadRows()
    })
    el.querySelectorAll('[data-session-key]').forEach(row => {
      row.addEventListener('click', async (e) => {
        const key = row.dataset.sessionKey
        if (!key) return
        if (e.target.closest('[data-check-id]')) {
          if (selected.has(key)) selected.delete(key)
          else selected.add(key)
          draw()
          return
        }
        selectedKey = key
        draw()
        await loadDetail(key)
      })
    })
    el.querySelector('#hm-sessions-select-all')?.addEventListener('click', () => {
      const sessions = currentSessions()
      const allVisibleSelected = sessions.length > 0 && sessions.every(s => selected.has(sessionKey(s)))
      if (allVisibleSelected) sessions.forEach(s => selected.delete(sessionKey(s)))
      else sessions.forEach(s => selected.add(sessionKey(s)))
      draw()
    })
    el.querySelector('#hm-sessions-bulk-delete')?.addEventListener('click', async () => {
      if (!selected.size) return
      const targets = [...selected].map(findByKey).filter(Boolean)
      const ok = await showConfirm(t('engine.chatConfirmBulkDelete').replace('{n}', String(targets.length)))
      if (!ok) return
      const deleted = []
      const failed = []
      for (const session of targets) {
        try {
          if (session.profile === store.state.activeProfile && store.state.streaming && session.id === store.state.runningSessionId) {
            throw new Error('RUNNING_SESSION')
          }
          await api.hermesSessionDelete(session.id, session.profile)
          deleted.push(sessionKey(session))
        } catch (err) {
          failed.push({ session, err })
        }
      }
      rows = rows.filter(s => !deleted.includes(sessionKey(s)))
      selected.clear()
      if (deleted.length && targets.some(s => s.profile === store.state.activeProfile)) await store.loadSessions()
      if (deleted.length && !failed.length) {
        toast(t('engine.chatBulkDeleted').replace('{n}', String(deleted.length)), 'success')
      } else if (deleted.length) {
        toast(t('engine.chatBulkPartial').replace('{n}', String(deleted.length)).replace('{f}', String(failed.length)), 'warning')
      } else {
        toast(t('engine.chatBulkFailed'), 'error')
      }
      draw()
    })
    el.querySelector('#hm-session-pin')?.addEventListener('click', () => {
      const session = currentSession()
      if (!session || session.profile !== store.state.activeProfile) return
      store.togglePinned(session.id)
      draw()
    })
    el.querySelector('#hm-session-delete')?.addEventListener('click', async () => {
      await deleteOne(currentSession())
    })

    // Batch 1 §E: 会话导出
    el.querySelector('#hm-session-export')?.addEventListener('click', async (e) => {
      const sid = e.currentTarget.dataset.sessionId
      if (!sid) return
      const btn = e.currentTarget
      btn.disabled = true
      try {
        const data = await api.hermesSessionExport(sid)
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `hermes-session-${sid}.json`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        toast(t('engine.sessionsExportSuccess'), 'success')
      } catch (err) {
        toast(t('engine.sessionsExportFailed') + ': ' + (err?.message || err), 'error')
      } finally {
        btn.disabled = false
      }
    })
  }

  async function init() {
    await store.loadProfiles().catch(() => {})
    profileScope = store.state.activeProfile || 'default'
    await loadRows()
  }

  requestAnimationFrame(() => { draw(); init() })
  const observer = new MutationObserver(() => {
    if (!el.isConnected) {
      unsubscribe()
      observer.disconnect()
    }
  })
  requestAnimationFrame(() => { if (el.parentNode) observer.observe(el.parentNode, { childList: true }) })
  return el
}
