/**
 * Hermes Chat — editorial luxury re-write (Phase 4).
 *
 * Layout:
 *   ┌────────────────┬──────────────────────────────────────────────┐
 *   │ SessionList    │ Header: title · source · new-chat button     │
 *   │ (groups +      ├──────────────────────────────────────────────┤
 *   │  pinned +      │ MessageList (user / assistant / tool)         │
 *   │  live badge)   │                                              │
 *   │                ├──────────────────────────────────────────────┤
 *   │                │ ChatInput (textarea + slash menu + send)      │
 *   └────────────────┴──────────────────────────────────────────────┘
 *
 * State lives in `chat-store.js`; this module only does DOM + events.
 */
import { t } from '../../../lib/i18n.js'
import { api, invalidate } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'
import { getChatStore, getSourceLabel } from '../lib/chat-store.js'

// ----------------------------------------------------------- helpers

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sanitizeMarkdownUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return '#'
  if (raw.startsWith('#')) return raw
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  try {
    const u = new URL(raw, window.location.origin)
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) return raw
  } catch {}
  return '#'
}

/** Minimal Markdown → HTML (supports fenced code, bold/italic, headings, lists, links). */
function mdToHtml(text) {
  if (!text) return ''
  const blocks = []
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.push({ lang, code }) - 1
    return `\u0000CB_${idx}\u0000`
  })
  out = out
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/^#### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^(?:\s*[-*]\s+(.+))(?:\n\s*[-*]\s+(.+))*/gm, (m) =>
      '<ul>' + m.trim().split(/\n\s*[-*]\s+/).map(li => `<li>${li.replace(/^[-*]\s+/, '')}</li>`).join('') + '</ul>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `<a href="${escAttr(sanitizeMarkdownUrl(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
  out = out.replace(/\u0000CB_(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[Number(i)]
    return `<pre class="hm-chat-code-block"><button type="button" class="hm-chat-code-copy" title="${escAttr(t('engine.chatCopyCode'))}">${escHtml(t('engine.chatCopyMessageShort'))}</button><code class="lang-${escHtml(lang)}">${escHtml(code)}</code></pre>`
  })
  return `<p>${out}</p>`
}

/** Pretty-print JSON-ish tool payload; fallback to raw string. */
function prettyJson(val) {
  if (val == null || val === '') return ''
  if (typeof val === 'string') {
    const s = val.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return JSON.stringify(JSON.parse(s), null, 2) } catch {}
    }
    return val
  }
  try { return JSON.stringify(val, null, 2) } catch { return String(val) }
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const mo = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return mo
}

function sessionDisplayTitle(s) {
  return s.title || t('engine.chatNewSession')
}

/** Compact token formatter — `1234567 → "1.2M"`, `12345 → "12.3k"`, `42 → "42"`. */
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/** USD cost formatter — `0.0042 → "$0.0042"`, `0.51 → "$0.51"`, `12.3 → "$12.30"`. */
function formatCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return ''
  if (usd < 0.01) return '$' + usd.toFixed(4)
  if (usd < 1) return '$' + usd.toFixed(3)
  return '$' + usd.toFixed(2)
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

// ----------------------------------------------------------- icons

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="10" height="10"><polyline points="9 18 15 12 9 6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M5 8h14"/><path d="M8 3h8v5l3 5H5l3-5z"/></svg>',
  spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" stroke-linecap="round"><circle cx="12" cy="12" r="8" opacity="0.25"/><path d="M20 12a8 8 0 0 0-8-8"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="11" height="11"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="12" height="12" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg>',
  checkboxOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
  checkboxOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" opacity="0.18"/><polyline points="7 12 11 16 17 8"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="11" height="11"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
}

const SLASH_COMMANDS = [
  { cmd: '/help',    desc: 'chatSlashHelpDesc' },
  { cmd: '/status',  desc: 'chatSlashStatusDesc' },
  { cmd: '/memory',  desc: 'chatSlashMemoryDesc' },
  { cmd: '/skills',  desc: 'chatSlashSkillsDesc' },
  { cmd: '/clear',   desc: 'chatSlashClearDesc' },
  { cmd: '/new',     desc: 'chatSlashNewDesc' },
]

// ----------------------------------------------------------- rename modal

/**
 * Lightweight rename modal (used by sidebar context menu). Returns the new
 * title on confirm, or `null` on cancel. Mirrors `showConfirm`'s pattern
 * so we don't need Vue-style reactivity.
 */
function showRenameModal(current) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal hm-chat-rename-modal" style="max-width:420px">
        <div class="modal-title">${escHtml(t('engine.chatRenameSession'))}</div>
        <div class="modal-body">
          <input type="text" class="hm-input hm-chat-rename-input"
                 value="${escAttr(current || '')}"
                 placeholder="${escHtml(t('engine.chatEnterNewTitle'))}"/>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary btn-sm" data-act="cancel">${escHtml(t('common.cancel'))}</button>
          <button class="btn btn-primary btn-sm" data-act="ok">${escHtml(t('common.confirm'))}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const input = overlay.querySelector('.hm-chat-rename-input')
    input?.focus()
    input?.select()

    const close = (v) => { overlay.remove(); resolve(v) }
    const confirm = () => {
      const v = input?.value.trim() || ''
      if (!v) { input?.focus(); return }
      close(v)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null)
    })
    overlay.querySelector('[data-act="cancel"]').onclick = () => close(null)
    overlay.querySelector('[data-act="ok"]').onclick = confirm
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm() }
      else if (e.key === 'Escape') close(null)
    })
  })
}

// ----------------------------------------------------------- context menu

function showContextMenu(x, y, items) {
  const existing = document.querySelector('.hm-chat-ctxmenu')
  if (existing) existing.remove()
  const menu = document.createElement('div')
  menu.className = 'hm-chat-ctxmenu'
  menu.innerHTML = items.map((it, i) => `
    <button class="hm-chat-ctxmenu-item ${it.danger ? 'is-danger' : ''}" data-idx="${i}">
      ${it.icon || ''}<span>${escHtml(it.label)}</span>
    </button>
  `).join('')

  document.body.appendChild(menu)
  // Position + clamp to viewport.
  const rect = menu.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  menu.style.left = Math.min(x, vw - rect.width - 8) + 'px'
  menu.style.top = Math.min(y, vh - rect.height - 8) + 'px'

  const close = () => {
    menu.remove()
    document.removeEventListener('click', onDocClick, true)
    document.removeEventListener('keydown', onKey)
  }
  const onDocClick = (e) => {
    if (!menu.contains(e.target)) close()
  }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKey)
  }, 0)
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.hm-chat-ctxmenu-item')
    if (!btn) return
    const idx = Number(btn.dataset.idx)
    close()
    items[idx]?.action?.()
  })
}

// ----------------------------------------------------------- main render

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-chat-page'
  el.dataset.engine = 'hermes'

  const store = getChatStore()

  // Local UI-only state (not in store).
  let sidebarOpen = !window.matchMedia('(max-width: 768px)').matches
  const expandedToolIds = new Set()   // tool message ids (persist across redraws)
  let showSlash = false
  let slashFilter = ''
  let gwOnline = false
  // null = 仍在加载首次 check，先不显示 banner 防首屏闪烁
  let hermesInstalled = null
  let currentModel = ''
  const mobileQuery = window.matchMedia('(max-width: 720px)')

  // Input state must live outside the textarea DOM node because every draw()
  // rebuilds innerHTML. Without this, typing `/` would wipe the composed text
  // when the slash menu triggers a redraw.
  let inputValue = ''
  let inputFocused = false
  let inputCaret = 0                  // caret position restored after re-render
  let lastActiveSessionId = store.state.activeSessionId
  let forceScrollBottom = true

  // Multi-select for batch session deletion. When non-null, the sidebar
  // switches into "selection mode": a checkbox appears on every row and
  // selecting items doesn't switch sessions.
  let selectionMode = false
  const selected = new Set()

  // Profile switcher dropdown (for Hermes multi-profile / multi-agent).
  let profileMenuOpen = false

  // Session search modal state. `null` means closed.
  // { query: string, selectedIdx: number }
  let searchState = null

  // --- initial session load + model meta ---
  store.loadSessions().then(() => draw())
  store.loadProfiles().then(() => draw()).catch(() => {})
  // 强制刷新安装/Gateway 状态缓存，避免用户刚在仪表盘启动 Gateway 后
  // 进聊天页看到 30s 过期的「未启动」误判。
  invalidate('check_hermes')
  api.checkHermes().then(info => {
    hermesInstalled = !!info?.installed
    gwOnline = !!info?.gatewayRunning
    currentModel = info?.model || ''
    draw()
  }).catch(() => {
    hermesInstalled = false
    gwOnline = false
    draw()
  })

  // ----------------------------------------------------------- subscription

  // Store subscription → `draw()` on mutation. rAF-batched inside the store
  // so a burst of events (streaming deltas) collapses into a single redraw.
  const unsubscribe = store.subscribe(() => draw())

  // Teardown + mount-observer are set up near the end of render() (after
  // `onGlobalKey` is defined). We avoid attaching a MutationObserver here
  // to prevent a double-teardown path.

  // ----------------------------------------------------------- rendering

  function renderSessionItem(s) {
    const isActive = s.id === store.state.activeSessionId
    const isLive = store.isSessionLive(s.id)
    const isPinned = store.state.pinned.has(s.id)
    const isSelected = selected.has(s.id)
    // IMPORTANT: outer wrapper is a `<div role="button">`, NOT a `<button>`.
    // Nesting a real <button class="hm-chat-session-del"> inside another
    // <button> is invalid HTML — the parser silently closes the outer
    // button at the inner button's start tag, hoisting the delete control
    // out of the row. That's why delete clicks did nothing in the wild.
    return `
      <div class="hm-chat-session-item ${isActive ? 'is-active' : ''} ${isLive ? 'is-live' : ''} ${isSelected ? 'is-selected' : ''}"
           role="button" tabindex="0"
           data-sid="${escAttr(s.id)}">
        ${selectionMode ? `
          <button class="hm-chat-session-check hm-chat-session-action ${isSelected ? 'is-on' : ''}"
                  data-sid-check="${escAttr(s.id)}"
                  aria-pressed="${isSelected ? 'true' : 'false'}"
                  title="${escHtml(t(isSelected ? 'engine.chatDeselect' : 'engine.chatSelect'))}">
            ${isSelected ? ICONS.checkboxOn : ICONS.checkboxOff}
          </button>
        ` : ''}
        <div class="hm-chat-session-main">
          <div class="hm-chat-session-title-row">
            ${isLive ? `<span class="hm-chat-session-spinner" aria-hidden="true">${ICONS.spinner}</span>` : ''}
            ${isPinned ? `<span class="hm-chat-session-pin" aria-hidden="true">${ICONS.pin}</span>` : ''}
            <span class="hm-chat-session-title">${escHtml(sessionDisplayTitle(s))}</span>
            ${isLive ? `<span class="hm-chat-session-live"><span class="hm-chat-live-dot"></span>${escHtml(t('engine.chatLive'))}</span>` : ''}
          </div>
          <div class="hm-chat-session-meta">
            ${s.model ? `<span class="hm-chat-session-model">${escHtml(s.model)}</span>` : ''}
            <span class="hm-chat-session-time">${escHtml(formatTime(s.updatedAt || s.createdAt))}</span>
          </div>
        </div>
        ${selectionMode ? '' : `
          <div class="hm-chat-session-actions" aria-label="${escAttr(t('engine.chatSessionActions'))}">
            <button class="hm-chat-session-menu hm-chat-session-action"
                    data-sid-menu="${escAttr(s.id)}"
                    title="${escHtml(t('engine.chatMoreActions'))}">
              ${ICONS.more}
            </button>
            <button class="hm-chat-session-del hm-chat-session-action"
                    data-sid-del="${escAttr(s.id)}"
                    title="${escHtml(t('engine.chatDeleteSession'))}">
              ${ICONS.trash}<span>${escHtml(t('engine.chatDeleteShort'))}</span>
            </button>
          </div>
        `}
      </div>
    `
  }

  function visibleSessionIds() {
    return store.state.sessions.map(s => s.id)
  }

  function renderProfileSwitcher() {
    const profiles = store.state.profiles || []
    const active = store.state.activeProfile || 'default'
    if (!profiles.length) {
      // Fallback: even when CLI doesn't expose profiles, surface the active
      // one so the user knows what they're talking to.
      return `
        <button class="hm-chat-profile-toggle" id="hm-chat-profile-toggle" type="button" disabled
                title="${escHtml(t('engine.chatProfileSingle'))}">
          ${ICONS.layers}
          <span class="hm-chat-profile-name">${escHtml(active)}</span>
        </button>
      `
    }
    return `
      <button class="hm-chat-profile-toggle ${profileMenuOpen ? 'is-open' : ''}" id="hm-chat-profile-toggle" type="button"
              aria-haspopup="menu" aria-expanded="${profileMenuOpen ? 'true' : 'false'}"
              title="${escHtml(t('engine.chatProfileTooltip'))}">
        ${ICONS.layers}
        <span class="hm-chat-profile-name">${escHtml(active)}</span>
        <span class="hm-chat-profile-caret">${ICONS.chevron}</span>
      </button>
      ${profileMenuOpen ? `
        <div class="hm-chat-profile-menu" role="menu">
          <div class="hm-chat-profile-menu-head">${escHtml(t('engine.chatProfileMenuHead'))}</div>
          ${profiles.map(p => `
            <button class="hm-chat-profile-item ${p.name === active ? 'is-active' : ''}"
                    role="menuitem"
                    data-profile="${escAttr(p.name)}"
                    ${store.state.streaming ? 'disabled' : ''}
                    title="${escHtml(p.model || '')}">
              <span class="hm-chat-profile-item-name">${escHtml(p.name)}</span>
              ${p.gatewayRunning ? `<span class="hm-chat-profile-item-badge">${escHtml(t('engine.chatProfileRunning'))}</span>` : ''}
              ${p.name === active ? `<span class="hm-chat-profile-item-active" aria-hidden="true">${ICONS.check}</span>` : ''}
            </button>
          `).join('')}
          <div class="hm-chat-profile-menu-foot">${escHtml(t('engine.chatProfileMenuFoot'))}</div>
        </div>
      ` : ''}
    `
  }

  function renderSidebar() {
    const { pinned, groups } = store.groupedSessions()
    const sessionsEmpty = store.state.sessions.length === 0
    const allIds = visibleSessionIds()
    const allSelected = selectionMode && allIds.length > 0 && allIds.every(id => selected.has(id))
    return `
      <aside class="hm-chat-sidebar ${sidebarOpen ? '' : 'is-collapsed'} ${selectionMode ? 'is-select-mode' : ''}">
        <div class="hm-chat-sidebar-profile">
          ${renderProfileSwitcher()}
        </div>
        <div class="hm-chat-sidebar-head">
          <span class="hm-chat-sidebar-title">${escHtml(t('engine.chatSessions'))}</span>
          <div class="hm-chat-sidebar-head-actions">
            <button class="hm-chat-select-toggle ${selectionMode ? 'is-active' : ''}" id="hm-chat-select-toggle"
                    title="${escHtml(t(selectionMode ? 'engine.chatExitSelect' : 'engine.chatBulkSelect'))}"
                    aria-pressed="${selectionMode ? 'true' : 'false'}">
              ${selectionMode ? ICONS.close : ICONS.check}
            </button>
            <button class="hm-chat-new-btn" title="${escHtml(t('engine.chatNewChat'))}" ${selectionMode ? 'disabled' : ''}>
              ${ICONS.plus}
            </button>
          </div>
        </div>
        ${selectionMode ? `
          <div class="hm-chat-bulkbar">
            <button class="hm-chat-bulkbar-select-all" id="hm-chat-bulk-select-all"
                    aria-pressed="${allSelected ? 'true' : 'false'}">
              ${allSelected ? ICONS.checkboxOn : ICONS.checkboxOff}
              <span>${escHtml(t(allSelected ? 'engine.chatSelectNone' : 'engine.chatSelectAll'))}</span>
            </button>
            <span class="hm-chat-bulkbar-count">${escHtml(t('engine.chatSelectedCount').replace('{n}', String(selected.size)))}</span>
            <button class="hm-chat-bulkbar-delete" id="hm-chat-bulk-delete" ${selected.size === 0 ? 'disabled' : ''}>
              ${ICONS.trash}<span>${escHtml(t('engine.chatBulkDelete'))}</span>
            </button>
          </div>
        ` : `<div class="hm-chat-sidebar-tip">${escHtml(t('engine.chatSessionManageHint'))}</div>`}
        <div class="hm-chat-sidebar-body">
          ${store.state.loading && sessionsEmpty ? `<div class="hm-chat-sidebar-loading">${escHtml(t('engine.chatLoading'))}</div>` : ''}
          ${!store.state.loading && sessionsEmpty ? `<div class="hm-chat-sidebar-empty">${escHtml(t('engine.chatNoSessions'))}</div>` : ''}
          ${pinned.length ? `
            <div class="hm-chat-group">
              <div class="hm-chat-group-head hm-chat-group-head--static">
                <span class="hm-chat-group-label">${escHtml(t('engine.chatPinned'))}</span>
                <span class="hm-chat-group-count">${pinned.length}</span>
              </div>
              ${pinned.map(renderSessionItem).join('')}
            </div>
          ` : ''}
          ${groups.map(g => {
            const isCollapsed = store.state.collapsed.has(g.source)
            return `
              <div class="hm-chat-group">
                <button class="hm-chat-group-head ${isCollapsed ? 'is-collapsed' : ''}" data-group="${escAttr(g.source)}">
                  <span class="hm-chat-group-arrow">${ICONS.chevron}</span>
                  <span class="hm-chat-group-label">${escHtml(g.label)}</span>
                  <span class="hm-chat-group-count">${g.sessions.length}</span>
                </button>
                ${!isCollapsed ? g.sessions.map(renderSessionItem).join('') : ''}
              </div>
            `
          }).join('')}
        </div>
      </aside>
    `
  }

  function renderToolMessage(m) {
    const expanded = expandedToolIds.has(m.id)
    const hasDetails = !!(m.toolArgs || m.toolResult)
    return `
      <div class="hm-chat-msg hm-chat-msg--tool" data-mid="${escAttr(m.id)}">
        <div class="hm-chat-tool-line ${hasDetails ? 'is-expandable' : ''}" data-tool-toggle="${escAttr(m.id)}">
          ${hasDetails
            ? `<span class="hm-chat-tool-chevron ${expanded ? 'is-open' : ''}">${ICONS.chevron}</span>`
            : `<span class="hm-chat-tool-icon">${ICONS.tool}</span>`}
          <span class="hm-chat-tool-name">${escHtml(m.toolName || 'tool')}</span>
          ${!expanded && m.toolPreview ? `<span class="hm-chat-tool-preview">${escHtml(m.toolPreview)}</span>` : ''}
          ${m.toolStatus === 'running' ? `<span class="hm-chat-tool-spinner"></span>` : ''}
          ${m.toolStatus === 'error' ? `<span class="hm-chat-tool-err">${escHtml(t('engine.chatErrorBadge'))}</span>` : ''}
        </div>
        ${expanded && hasDetails ? `
          <div class="hm-chat-tool-details">
            ${m.toolArgs ? `
              <div class="hm-chat-tool-section">
                <div class="hm-chat-tool-label">${escHtml(t('engine.chatArguments'))}</div>
                <pre class="hm-chat-tool-code">${escHtml(prettyJson(m.toolArgs))}</pre>
              </div>
            ` : ''}
            ${m.toolResult ? `
              <div class="hm-chat-tool-section">
                <div class="hm-chat-tool-label">${escHtml(t('engine.chatResult'))}</div>
                <pre class="hm-chat-tool-code">${escHtml(prettyJson(m.toolResult))}</pre>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `
  }

  function renderMessage(m) {
    if (m.role === 'tool') return renderToolMessage(m)
    if (m.role === 'system') {
      return `
        <div class="hm-chat-msg hm-chat-msg--system" data-mid="${escAttr(m.id)}">
          <div class="hm-chat-msg-bubble">
            <div class="hm-chat-msg-content">${mdToHtml(m.content)}</div>
          </div>
        </div>
      `
    }
    const isUser = m.role === 'user'
    const canCopy = !!(m.content || '').trim()
    return `
      <div class="hm-chat-msg hm-chat-msg--${escHtml(m.role)}" data-mid="${escAttr(m.id)}">
        <div class="hm-chat-msg-body">
          ${!isUser ? `<div class="hm-chat-msg-avatar" aria-hidden="true">H</div>` : ''}
          <div class="hm-chat-msg-content-wrap">
            <div class="hm-chat-msg-bubble">
              <div class="hm-chat-msg-content">${mdToHtml(m.content)}${m.isStreaming && !m.content ? '<span class="hm-chat-streaming-dots"><span></span><span></span><span></span></span>' : ''}</div>
            </div>
            <div class="hm-chat-msg-footer">
              <span class="hm-chat-msg-time">${escHtml(formatTime(m.timestamp))}</span>
              ${canCopy ? `
                <button class="hm-chat-msg-copy" data-copy-mid="${escAttr(m.id)}" title="${escHtml(t('engine.chatCopyMessage'))}">
                  ${ICONS.copy}<span>${escHtml(t('engine.chatCopyMessageShort'))}</span>
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function renderLiveTools() {
    if (!store.state.streaming) return ''
    const tools = store.state.liveTools
    return `
      <div class="hm-chat-streaming">
        <div class="hm-chat-streaming-mark">
          <span class="hm-chat-streaming-pulse"></span>
          <span class="hm-chat-streaming-label">${escHtml(t('engine.chatThinking'))}</span>
        </div>
        ${tools.length ? `
          <div class="hm-chat-live-tools">
            ${tools.slice().reverse().map(tc => `
              <div class="hm-chat-live-tool">
                <span class="hm-chat-live-tool-icon">${ICONS.tool}</span>
                <span class="hm-chat-live-tool-name">${escHtml(tc.name)}</span>
                ${tc.preview ? `<span class="hm-chat-live-tool-preview">${escHtml(tc.preview)}</span>` : ''}
                ${tc.status === 'running' ? `<span class="hm-chat-tool-spinner"></span>` : ''}
                ${tc.status === 'error' ? `<span class="hm-chat-tool-err">${escHtml(t('engine.chatErrorBadge'))}</span>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `
  }

  function renderMessages() {
    const s = store.activeSession()
    if (!s) {
      return `<div class="hm-chat-messages-empty">${escHtml(t('engine.chatNewSession'))}</div>`
    }
    if (store.state.loadingMessages) {
      return `
        <div class="hm-chat-messages-empty">
          <div class="hm-chat-empty-title">${escHtml(t('engine.chatLoadingMessages'))}</div>
          <div class="hm-chat-empty-sub">${escHtml(t('engine.chatLoadingMessagesSub'))}</div>
        </div>
      `
    }
    if (!s.messages.length && !store.state.streaming) {
      return `
        <div class="hm-chat-messages-empty">
          <div class="hm-chat-empty-title">${escHtml(t('engine.chatEmptyTitle'))}</div>
          <div class="hm-chat-empty-sub">${escHtml(t('engine.chatEmptySub'))}</div>
        </div>
      `
    }
    return s.messages.map(renderMessage).join('') + renderLiveTools()
  }

  function renderSlashMenu() {
    if (!showSlash) return ''
    const filtered = SLASH_COMMANDS.filter(c => !slashFilter || c.cmd.includes(slashFilter))
    if (!filtered.length) return ''
    return `
      <div class="hm-chat-slash-menu">
        ${filtered.map(c => `
          <button class="hm-chat-slash-item" data-cmd="${escAttr(c.cmd)}">
            <span class="hm-chat-slash-cmd">${escHtml(c.cmd)}</span>
            <span class="hm-chat-slash-desc">${escHtml(t('engine.' + c.desc))}</span>
          </button>
        `).join('')}
      </div>
    `
  }

  function renderInput() {
    const active = store.activeSession()
    const streaming = store.state.streaming
    const placeholder = streaming
      ? t('engine.chatStreamingPlaceholder')
      : t('engine.chatInputPlaceholder')
    // NOTE: textarea is NOT disabled during streaming — the user should still
    // be able to compose the next message while the agent is thinking. The
    // Send button is hidden/swapped instead.
    // The keyboard shortcut hint now lives inside the placeholder so we
    // don't render a duplicate row beneath the textarea (the prior layout
    // looked like "套娃" — same hint shown twice). Slash menu still pops
    // up above when the user types `/`.
    //
    // Token usage strip — only when there's an active session with real
    // usage.
    const totalIn = active?.inputTokens || 0
    const totalOut = active?.outputTokens || 0
    const totalCache = (active?.cacheReadTokens || 0) + (active?.cacheWriteTokens || 0)
    const cost = active?.estimatedCostUsd
    const showUsage = !!active && (totalIn + totalOut + totalCache) > 0
    return `
      <div class="hm-chat-input-area">
        ${renderSlashMenu()}
        ${showUsage ? `
          <div class="hm-chat-usage-bar" title="${escAttr(t('engine.chatUsageTooltip'))}">
            <span class="hm-chat-usage-pill" data-kind="in">
              <span class="hm-chat-usage-label">${escHtml(t('engine.chatUsageIn'))}</span>
              <span class="hm-chat-usage-value">${formatTokens(totalIn)}</span>
            </span>
            <span class="hm-chat-usage-pill" data-kind="out">
              <span class="hm-chat-usage-label">${escHtml(t('engine.chatUsageOut'))}</span>
              <span class="hm-chat-usage-value">${formatTokens(totalOut)}</span>
            </span>
            ${totalCache > 0 ? `
              <span class="hm-chat-usage-pill" data-kind="cache">
                <span class="hm-chat-usage-label">${escHtml(t('engine.chatUsageCache'))}</span>
                <span class="hm-chat-usage-value">${formatTokens(totalCache)}</span>
              </span>` : ''}
            ${cost ? `
              <span class="hm-chat-usage-pill" data-kind="cost">
                <span class="hm-chat-usage-value">${escHtml(formatCost(cost))}</span>
              </span>` : ''}
          </div>` : ''}
        <div class="hm-chat-input-wrap ${streaming ? 'is-streaming' : ''}">
          <textarea id="hm-chat-input" class="hm-chat-input"
                    placeholder="${escAttr(placeholder)}"
                    rows="1">${escHtml(inputValue)}</textarea>
          <div class="hm-chat-input-actions">
            ${streaming
              ? `<button class="hm-chat-stop-btn" id="hm-chat-stop" title="${escHtml(t('engine.chatStop'))}">
                   ${ICONS.stop}
                 </button>`
              : `<button class="hm-chat-send-btn" id="hm-chat-send"
                         ${(!active || !inputValue.trim() || hermesInstalled === false || !gwOnline) ? 'disabled' : ''}
                         title="${escHtml(hermesInstalled === false ? t('engine.chatHealthInstallMissing') : !gwOnline ? t('engine.chatHealthGatewayDown') : t('engine.chatSend'))}">
                   ${ICONS.send}
                 </button>`}
          </div>
        </div>
      </div>
    `
  }

  function renderHeader() {
    const active = store.activeSession()
    const title = active ? sessionDisplayTitle(active) : t('engine.chatNewSession')
    const source = active?.source && active.source !== '__local__' ? getSourceLabel(active.source) : ''
    return `
      <header class="hm-chat-header">
        <div class="hm-chat-header-left">
          <button class="hm-chat-toggle-sidebar ${sidebarOpen ? '' : 'is-collapsed'}" id="hm-chat-toggle-sidebar"
                  aria-pressed="${sidebarOpen ? 'true' : 'false'}"
                  title="${escHtml(sidebarOpen ? t('engine.chatHideSessions') : t('engine.chatShowSessions'))}">
            ${ICONS.sidebar}
            <span>${escHtml(sidebarOpen ? t('engine.chatHideSessions') : t('engine.chatShowSessions'))}</span>
          </button>
          <div class="hm-chat-header-title-wrap">
            <span class="hm-chat-header-title">${escHtml(title)}</span>
            ${source ? `<span class="hm-chat-source-badge">${escHtml(source)}</span>` : ''}
          </div>
        </div>
        <div class="hm-chat-header-right">
          <div class="hm-chat-gw-status ${gwOnline ? 'is-online' : 'is-offline'}"
               title="${escHtml(gwOnline ? t('engine.chatGatewayOnline') : t('engine.chatGatewayOffline'))}">
            <span class="hm-chat-gw-dot"></span>
            <span class="hm-chat-gw-label">GATEWAY</span>
            <span class="hm-chat-gw-text">${escHtml(gwOnline ? t('engine.chatGatewayOnlineShort') : t('engine.chatGatewayOfflineShort'))}</span>
            ${currentModel ? `<span class="hm-chat-gw-model">${escHtml(currentModel)}</span>` : ''}
          </div>
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-chat-search-open"
                  title="${escHtml(t('engine.chatSearchShortcut'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-chat-copy-id"
                  ${!active ? 'disabled' : ''}
                  title="${escHtml(t('engine.chatCopySessionId'))}">
            ${ICONS.copy}
          </button>
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-chat-new-chat">
            ${ICONS.plus}<span>${escHtml(t('engine.chatNewChat'))}</span>
          </button>
        </div>
      </header>
    `
  }

  // 健康状态 banner：未装/未启动 → 在输入区上方显示一条警告 + 「去仪表盘」按钮。
  // 首次 fetch 完成前返回空字符串，避免首屏闪烁。
  function renderHealthBanner() {
    if (hermesInstalled === null) return ''
    if (hermesInstalled === false) {
      return `
        <div class="hm-chat-health-banner is-error">
          <span class="hm-chat-health-icon" aria-hidden="true">⚠</span>
          <span class="hm-chat-health-msg">${escHtml(t('engine.chatHealthInstallMissing'))}</span>
          <a class="hm-chat-health-action" href="#/h/dashboard">${escHtml(t('engine.chatHealthGoDashboard'))}</a>
        </div>
      `
    }
    if (!gwOnline) {
      return `
        <div class="hm-chat-health-banner is-warn">
          <span class="hm-chat-health-icon" aria-hidden="true">⚠</span>
          <span class="hm-chat-health-msg">${escHtml(t('engine.chatHealthGatewayDown'))}</span>
          <a class="hm-chat-health-action" href="#/h/dashboard">${escHtml(t('engine.chatHealthGoDashboard'))}</a>
        </div>
      `
    }
    return ''
  }

  // ----------------------------------------------------------- draw

  function draw() {
    const scrollTop = el.querySelector('.hm-chat-messages')?.scrollTop
    const wasNearBottom = isMessagesNearBottom()
    const activeSessionId = store.state.activeSessionId
    const activeChanged = activeSessionId !== lastActiveSessionId
    if (activeChanged) {
      lastActiveSessionId = activeSessionId
      forceScrollBottom = true
    }

    el.innerHTML = `
      <div class="hm-chat-shell ${sidebarOpen ? '' : 'is-sidebar-collapsed'}">
        <div class="hm-chat-sidebar-backdrop" id="hm-chat-sidebar-backdrop"></div>
        ${renderSidebar()}
        <section class="hm-chat-main">
          ${renderHeader()}
          ${renderHealthBanner()}
          <div class="hm-chat-messages" id="hm-chat-messages">
            ${renderMessages()}
          </div>
          <button class="hm-chat-jump-bottom" id="hm-chat-jump-bottom" type="button">
            <span>↓</span>${escHtml(t('engine.chatJumpBottom'))}
          </button>
          ${renderInput()}
        </section>
      </div>
    `
    bind()

    // Restore / auto-scroll.
    const msgsEl = el.querySelector('.hm-chat-messages')
    if (msgsEl) {
      if (forceScrollBottom || wasNearBottom) {
        msgsEl.scrollTop = msgsEl.scrollHeight
        forceScrollBottom = false
      } else if (scrollTop != null) {
        msgsEl.scrollTop = scrollTop
      }
      updateJumpButton()
    }

    // Restore textarea focus + caret position after every redraw so typing
    // remains smooth even when store mutations trigger a full DOM rebuild.
    const input = el.querySelector('#hm-chat-input')
    if (input) {
      if (inputFocused) {
        input.focus()
        try {
          const pos = Math.min(inputCaret, inputValue.length)
          input.setSelectionRange(pos, pos)
        } catch { /* selection unsupported for the current state */ }
      }
      autoResize(input)
    }

    // Draw search modal on top if open.
    drawSearchModal()
  }

  function isMessagesNearBottom(threshold = 120) {
    const m = el.querySelector('.hm-chat-messages')
    if (!m) return true
    return m.scrollHeight - m.scrollTop - m.clientHeight < threshold
  }

  function updateJumpButton() {
    const btn = el.querySelector('#hm-chat-jump-bottom')
    if (!btn) return
    btn.classList.toggle('is-visible', !isMessagesNearBottom(180))
  }

  // ----------------------------------------------------------- event binding

  function toggleSelected(sid) {
    if (!sid) return
    if (selected.has(sid)) selected.delete(sid)
    else selected.add(sid)
    draw()
  }

  function bind() {
    // --- Sidebar header ---
    el.querySelector('.hm-chat-new-btn')?.addEventListener('click', () => {
      store.newChat()
    })
    el.querySelector('#hm-chat-toggle-sidebar')?.addEventListener('click', () => {
      sidebarOpen = !sidebarOpen
      draw()
    })
    el.querySelector('#hm-chat-sidebar-backdrop')?.addEventListener('click', () => {
      sidebarOpen = false
      draw()
    })
    const msgsEl = el.querySelector('#hm-chat-messages')
    msgsEl?.addEventListener('scroll', updateJumpButton)
    el.querySelector('#hm-chat-jump-bottom')?.addEventListener('click', () => {
      if (!msgsEl) return
      msgsEl.scrollTop = msgsEl.scrollHeight
      updateJumpButton()
    })

    // --- Group collapse ---
    el.querySelectorAll('.hm-chat-group-head[data-group]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Don't collapse when clicking static-header style.
        if (btn.classList.contains('hm-chat-group-head--static')) return
        const src = btn.dataset.group
        store.toggleCollapsed(src)
      })
    })

    // --- Session select ---
    el.querySelectorAll('.hm-chat-session-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.hm-chat-session-action')) return
        const sid = item.dataset.sid
        if (!sid) return
        if (selectionMode) {
          toggleSelected(sid)
          return
        }
        if (sid !== store.state.activeSessionId) {
          forceScrollBottom = true
          store.switchSession(sid)
          if (mobileQuery.matches) sidebarOpen = false
        }
      })
      item.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        if (e.target.closest('.hm-chat-session-action')) return
        e.preventDefault()
        const sid = item.dataset.sid
        if (!sid) return
        if (selectionMode) {
          toggleSelected(sid)
          return
        }
        if (sid !== store.state.activeSessionId) {
          forceScrollBottom = true
          store.switchSession(sid)
          if (mobileQuery.matches) sidebarOpen = false
        }
      })
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sid = item.dataset.sid
        openSessionContextMenu(e.clientX, e.clientY, sid)
      })
    })

    // --- Selection mode controls ---
    el.querySelector('#hm-chat-select-toggle')?.addEventListener('click', () => {
      selectionMode = !selectionMode
      if (!selectionMode) selected.clear()
      profileMenuOpen = false
      draw()
    })
    el.querySelectorAll('[data-sid-check]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        toggleSelected(btn.dataset.sidCheck)
      })
    })
    el.querySelector('#hm-chat-bulk-select-all')?.addEventListener('click', () => {
      const ids = visibleSessionIds()
      const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
      if (allSelected) selected.clear()
      else for (const id of ids) selected.add(id)
      draw()
    })
    el.querySelector('#hm-chat-bulk-delete')?.addEventListener('click', async () => {
      if (selected.size === 0) return
      const ok = await showConfirm(t('engine.chatConfirmBulkDelete').replace('{n}', String(selected.size)))
      if (!ok) return
      const ids = Array.from(selected)
      const result = await store.bulkDeleteSessions(ids)
      selected.clear()
      const skipped = result.skipped.length
      const failed = result.failed.length
      const deleted = result.deleted.length
      if (deleted > 0 && failed === 0 && skipped === 0) {
        toast(t('engine.chatBulkDeleted').replace('{n}', String(deleted)), 'success')
      } else if (deleted > 0) {
        toast(t('engine.chatBulkPartial')
          .replace('{n}', String(deleted))
          .replace('{f}', String(failed + skipped)), 'success')
      } else {
        toast(t('engine.chatBulkFailed'), 'error')
      }
      if (failed === 0) selectionMode = false
      draw()
    })

    // --- Profile switcher ---
    el.querySelector('#hm-chat-profile-toggle')?.addEventListener('click', (e) => {
      const btn = e.currentTarget
      if (btn?.disabled) return
      profileMenuOpen = !profileMenuOpen
      draw()
    })
    el.querySelectorAll('[data-profile]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const name = btn.dataset.profile
        profileMenuOpen = false
        if (!name || name === store.state.activeProfile) {
          draw()
          return
        }
        if (store.state.streaming) {
          toast(t('engine.chatProfileSwitchBlocked'), 'error')
          draw()
          return
        }
        try {
          await store.switchProfile(name)
          toast(t('engine.chatProfileSwitched').replace('{name}', name), 'success')
        } catch (err) {
          toast((err?.message || String(err)), 'error')
        }
      })
    })

    el.querySelectorAll('.hm-chat-session-menu').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const sid = btn.dataset.sidMenu
        const rect = btn.getBoundingClientRect()
        openSessionContextMenu(rect.left, rect.bottom + 4, sid)
      })
    })

    // --- Session delete ---
    el.querySelectorAll('.hm-chat-session-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const sid = btn.dataset.sidDel
        const ok = await showConfirm(t('engine.chatConfirmDelete'))
        if (!ok) return
        try {
          await store.deleteSession(sid)
          toast(t('engine.chatSessionDeleted'), 'success')
        } catch (err) {
          const msg = err?.message === 'RUNNING_SESSION' ? t('engine.chatDeleteRunningBlocked') : (err?.message || err)
          toast(t('engine.chatDeleteFailed') + ': ' + msg, 'error')
        }
      })
    })

    el.querySelectorAll('[data-copy-mid]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const mid = btn.dataset.copyMid
        const s = store.activeSession()
        const msg = s?.messages.find(m => m.id === mid)
        if (!msg?.content) return
        const ok = await copyText(msg.content)
        toast(ok ? t('common.copied') : t('engine.chatCopyFailed'), ok ? 'success' : 'error')
      })
    })

    el.querySelectorAll('.hm-chat-code-copy').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const code = btn.closest('pre')?.querySelector('code')?.textContent || ''
        if (!code) return
        const ok = await copyText(code)
        toast(ok ? t('common.copied') : t('engine.chatCopyFailed'), ok ? 'success' : 'error')
      })
    })

    // --- Tool message expand ---
    el.querySelectorAll('[data-tool-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.toolToggle
        if (expandedToolIds.has(id)) expandedToolIds.delete(id)
        else expandedToolIds.add(id)
        draw()
      })
    })

    // --- Header actions ---
    el.querySelector('#hm-chat-new-chat')?.addEventListener('click', () => {
      forceScrollBottom = true
      store.newChat()
    })
    el.querySelector('#hm-chat-search-open')?.addEventListener('click', () => openSearch())
    el.querySelector('#hm-chat-copy-id')?.addEventListener('click', async () => {
      const s = store.activeSession()
      if (!s) return
      try {
        const ok = await copyText(s.id)
        toast(ok ? t('common.copied') : t('engine.chatCopyFailed'), ok ? 'success' : 'error')
      } catch { toast(t('engine.chatCopyFailed'), 'error') }
    })

    // --- Input ---
    //
    // We track the composed text in `inputValue` (outside the DOM) so it
    // survives redraws triggered by streaming updates or slash-menu toggles.
    // The textarea's `value` is authoritative only between events; on the
    // next draw() the markup re-seeds it from `inputValue`.
    const input = el.querySelector('#hm-chat-input')
    if (input) {
      // Event ordering: focus / blur → keydown → input. We update the state
      // on BOTH input (value) and selectionchange proxies (keydown/keyup) to
      // keep caret restore accurate.
      input.addEventListener('focus', () => { inputFocused = true })
      input.addEventListener('blur', () => { inputFocused = false })
      input.addEventListener('keyup', () => { inputCaret = input.selectionStart || 0 })
      input.addEventListener('click', () => { inputCaret = input.selectionStart || 0 })

      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
          return
        }
        if (e.key === 'Escape' && showSlash) {
          showSlash = false
          draw()
        }
      })

      input.addEventListener('input', () => {
        inputValue = input.value
        inputCaret = input.selectionStart || inputValue.length
        const wasShowing = showSlash
        if (inputValue.startsWith('/') && !inputValue.includes(' ')) {
          showSlash = true
          slashFilter = inputValue
        } else if (showSlash) {
          showSlash = false
        }
        // Only call draw() when the slash menu visibility actually changes —
        // otherwise a plain keystroke would trigger an expensive full rebuild.
        if (wasShowing !== showSlash || (showSlash && slashFilter !== inputValue)) {
          draw()
        } else {
          autoResize(input)
        }
      })
    }

    el.querySelector('#hm-chat-send')?.addEventListener('click', handleSend)
    el.querySelector('#hm-chat-stop')?.addEventListener('click', () => {
      store.stopStreaming()
      toast(t('engine.chatStopped'), 'success')
    })

    el.querySelectorAll('.hm-chat-slash-item').forEach(item => {
      item.addEventListener('click', () => {
        const cmd = item.dataset.cmd
        inputValue = cmd + ' '
        inputCaret = inputValue.length
        inputFocused = true
        showSlash = false
        draw()
      })
    })
  }

  function autoResize(input) {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 160) + 'px'
  }

  function openSessionContextMenu(x, y, sid) {
    const s = store.state.sessions.find(sess => sess.id === sid)
    if (!s) return
    const isPinned = store.state.pinned.has(sid)
    showContextMenu(x, y, [
      {
        label: isPinned ? t('engine.chatUnpin') : t('engine.chatPin'),
        icon: ICONS.pin,
        action: () => store.togglePinned(sid),
      },
      {
        label: t('engine.chatRename'),
        action: async () => {
          const next = await showRenameModal(s.title)
          if (next == null) return
          const ok = await store.renameSession(sid, next)
          if (ok) toast(t('engine.chatRenamed'), 'success')
          else toast(t('engine.chatRenameFailed'), 'error')
        },
      },
      {
        label: t('engine.chatCopySessionId'),
        icon: ICONS.copy,
        action: async () => {
          try {
            const ok = await copyText(sid)
            toast(ok ? t('common.copied') : t('engine.chatCopyFailed'), ok ? 'success' : 'error')
          } catch { toast(t('engine.chatCopyFailed'), 'error') }
        },
      },
      {
        label: t('engine.chatDeleteSession'),
        icon: ICONS.trash,
        danger: true,
        action: async () => {
          const ok = await showConfirm(t('engine.chatConfirmDelete'))
          if (!ok) return
          try {
            await store.deleteSession(sid)
            toast(t('engine.chatSessionDeleted'), 'success')
          } catch (err) {
            const msg = err?.message === 'RUNNING_SESSION' ? t('engine.chatDeleteRunningBlocked') : (err?.message || err)
            toast(t('engine.chatDeleteFailed') + ': ' + msg, 'error')
          }
        },
      },
    ])
  }

  // ----------------------------------------------------------- slash handlers

  /**
   * Reset the composed input state and redraw. Called after a send, slash
   * command, or `/clear`, `/new` shortcut.
   */
  function resetInput() {
    inputValue = ''
    inputCaret = 0
    showSlash = false
    slashFilter = ''
  }

  async function handleSend() {
    const text = inputValue.trim()
    if (!text || store.state.streaming) return

    // Local slash commands short-circuit before going to the agent.
    if (text === '/clear') {
      store.clearActive()
      resetInput(); draw(); return
    }
    if (text === '/new') {
      store.newChat()
      resetInput(); draw(); return
    }
    if (text === '/help') {
      store.pushLocalUser(text)
      store.pushLocalAssistant(
        [
          `**${t('engine.chatSlashTitle')}**`,
          '',
          '`/help` — ' + t('engine.chatSlashHelpDesc'),
          '`/status` — ' + t('engine.chatSlashStatusDesc'),
          '`/memory` — ' + t('engine.chatSlashMemoryDesc'),
          '`/skills` — ' + t('engine.chatSlashSkillsDesc'),
          '`/clear` — ' + t('engine.chatSlashClearDesc'),
          '`/new` — ' + t('engine.chatSlashNewDesc'),
        ].join('\n')
      )
      resetInput(); draw(); return
    }
    if (text === '/status') {
      store.pushLocalUser(text)
      try {
        const info = await api.checkHermes()
        const gw = info?.gatewayRunning ? '✅' : '❌'
        const port = info?.gatewayPort || 8642
        const model = info?.model || '—'
        store.pushLocalAssistant([
          `**${t('engine.chatSlashStatusTitle')}**`,
          '',
          `- ${t('engine.chatSlashGateway')}: ${gw}`,
          `- ${t('engine.chatSlashPort')}: \`${port}\``,
          `- ${t('engine.chatSlashModel')}: \`${model}\``,
        ].join('\n'))
      } catch (e) {
        store.pushLocalAssistant('⚠️ ' + (e?.message || e))
      }
      resetInput(); draw(); return
    }
    if (text === '/memory' || text === '/skills') {
      store.pushLocalUser(text)
      const target = text === '/memory' ? '/h/memory' : '/h/skills'
      store.pushLocalAssistant(
        t('engine.chatSlashRedirect').replace('{page}', `\`${target}\``)
      )
      window.location.hash = '#' + target
      resetInput(); draw(); return
    }

    // Normal user message → start agent run.
    forceScrollBottom = true
    resetInput()
    draw()
    await store.sendMessage(text)
  }

  // ----------------------------------------------------------- search modal
  //
  // Triggered by Ctrl/Cmd + K anywhere on the chat page (or header button).
  // Lives as a detached overlay rendered into `document.body` so it survives
  // the main chat redraws and is easy to dismiss with outside clicks.

  let searchOverlay = null

  function openSearch() {
    if (searchState) return
    searchState = { query: '', selectedIdx: 0 }
    draw()
  }

  function closeSearch() {
    searchState = null
    if (searchOverlay) {
      searchOverlay.remove()
      searchOverlay = null
    }
  }

  function searchResults() {
    if (!searchState) return []
    const q = searchState.query.trim()
    // Empty query → show recent sessions (first 15) so the modal isn't blank.
    if (!q) {
      return store.state.sessions.slice(0, 15).map(session => ({
        session,
        score: 0,
        snippet: session.title || t('engine.chatNewSession'),
      }))
    }
    return store.searchSessions(q, 20)
  }

  function drawSearchModal() {
    if (!searchState) {
      if (searchOverlay) { searchOverlay.remove(); searchOverlay = null }
      return
    }
    const results = searchResults()
    const idx = Math.min(searchState.selectedIdx, Math.max(0, results.length - 1))
    searchState.selectedIdx = idx

    if (!searchOverlay) {
      searchOverlay = document.createElement('div')
      searchOverlay.className = 'hm-chat-search-overlay'
      document.body.appendChild(searchOverlay)
    }

    searchOverlay.innerHTML = `
      <div class="hm-chat-search-panel" data-engine="hermes">
        <div class="hm-chat-search-head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="hm-chat-search-icon">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text" class="hm-chat-search-input" id="hm-chat-search-input"
                 value="${escAttr(searchState.query)}"
                 placeholder="${escAttr(t('engine.chatSearchPlaceholder'))}"/>
          <kbd class="hm-chat-search-kbd">Esc</kbd>
        </div>
        <div class="hm-chat-search-results" id="hm-chat-search-results">
          ${results.length === 0 ? `
            <div class="hm-chat-search-empty">${escHtml(t('engine.chatSearchEmpty'))}</div>
          ` : results.map((r, i) => {
            const s = r.session
            const src = s.source && s.source !== '__local__' ? getSourceLabel(s.source) : ''
            return `
              <button class="hm-chat-search-item ${i === idx ? 'is-active' : ''}" data-sid="${escAttr(s.id)}" data-idx="${i}">
                <div class="hm-chat-search-item-main">
                  <div class="hm-chat-search-item-title">
                    ${escHtml(s.title || t('engine.chatNewSession'))}
                    ${src ? `<span class="hm-chat-search-item-src">${escHtml(src)}</span>` : ''}
                  </div>
                  ${r.snippet && r.snippet !== s.title ? `
                    <div class="hm-chat-search-item-snippet">${escHtml(r.snippet)}</div>
                  ` : ''}
                </div>
                <div class="hm-chat-search-item-meta">
                  ${s.model ? `<span class="hm-chat-search-item-model">${escHtml(s.model)}</span>` : ''}
                  <span class="hm-chat-search-item-time">${escHtml(formatTime(s.updatedAt))}</span>
                </div>
              </button>
            `
          }).join('')}
        </div>
        <div class="hm-chat-search-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> ${escHtml(t('engine.chatSearchNavigate'))}</span>
          <span><kbd>Enter</kbd> ${escHtml(t('engine.chatSearchOpen'))}</span>
        </div>
      </div>
    `

    const inputEl = searchOverlay.querySelector('#hm-chat-search-input')
    inputEl?.focus()
    try {
      const pos = searchState.query.length
      inputEl?.setSelectionRange(pos, pos)
    } catch {}

    inputEl?.addEventListener('input', () => {
      searchState.query = inputEl.value
      searchState.selectedIdx = 0
      drawSearchModal()
    })

    searchOverlay.addEventListener('mousedown', (e) => {
      if (e.target === searchOverlay) closeSearch()
    }, { once: true })

    searchOverlay.querySelectorAll('.hm-chat-search-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid = btn.dataset.sid
        selectSearchResult(sid)
      })
      btn.addEventListener('mouseenter', () => {
        searchState.selectedIdx = Number(btn.dataset.idx)
        // Cheap class swap instead of full redraw.
        searchOverlay.querySelectorAll('.hm-chat-search-item').forEach(b =>
          b.classList.toggle('is-active', Number(b.dataset.idx) === searchState.selectedIdx))
      })
    })
  }

  function selectSearchResult(sid) {
    if (!sid) return
    forceScrollBottom = true
    store.switchSession(sid)
    if (mobileQuery.matches) sidebarOpen = false
    closeSearch()
  }

  // --- Global keyboard: Ctrl/Cmd+K opens search, keys navigate when open ---
  function onGlobalKey(e) {
    if (!el.isConnected) return
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform)
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      if (searchState) closeSearch()
      else openSearch()
      return
    }
    if (!searchState) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const results = searchResults()
      if (!results.length) return
      searchState.selectedIdx = (searchState.selectedIdx + 1) % results.length
      drawSearchModal()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const results = searchResults()
      if (!results.length) return
      searchState.selectedIdx = (searchState.selectedIdx - 1 + results.length) % results.length
      drawSearchModal()
    } else if (e.key === 'Enter') {
      const results = searchResults()
      const hit = results[searchState.selectedIdx]
      if (hit) {
        e.preventDefault()
        selectSearchResult(hit.session.id)
      }
    }
  }
  document.addEventListener('keydown', onGlobalKey)

  // Close profile menu on outside click (capture so menu's own click handlers
  // still get to run before we close).
  function onGlobalClick(e) {
    if (!profileMenuOpen) return
    if (!el.isConnected) return
    const wrap = el.querySelector('.hm-chat-sidebar-profile')
    if (wrap && wrap.contains(e.target)) return
    profileMenuOpen = false
    draw()
  }
  document.addEventListener('click', onGlobalClick)

  // Detach the global listener + close modal on unmount. A single
  // MutationObserver watches our parent; when `el` is detached, we run the
  // full teardown (stream listeners, subscription, search modal, keydown).
  const teardown = () => {
    document.removeEventListener('keydown', onGlobalKey)
    document.removeEventListener('click', onGlobalClick)
    closeSearch()
    unsubscribe()
    store.detachStreamListeners()
  }
  const mountObserver = new MutationObserver(() => {
    if (!el.isConnected) { teardown(); mountObserver.disconnect() }
  })
  requestAnimationFrame(() => {
    if (el.parentNode) mountObserver.observe(el.parentNode, { childList: true })
  })

  // Seed the initial draw (before store load resolves).
  draw()
  return el
}
