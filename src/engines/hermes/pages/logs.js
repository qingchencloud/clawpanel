/**
 * Hermes Agent — Log viewer
 *
 * Data contract:
 *   { files: [{ name, size, modified }] }
 *   { entries: [{ timestamp, level, logger, message, raw }, ...] }
 *
 * Extras:
 *   - Download entire log file to user's disk
 *   - Clear the currently rendered entries (local only)
 *   - Auto-refresh (polling tail) toggle — 2s tick
 *   - Access-log colouring: method / path / status are parsed and highlighted
 *   - Live regex search that also highlights matches inline
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const LOG_LEVELS = ['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
const LEVEL_TONE = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warn', WARN: 'warn',
  ERROR: 'error', CRITICAL: 'error', FATAL: 'error',
}

const ICONS = {
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
}

/** Extract HH:MM:SS from arbitrary timestamp string; fallback to the raw. */
function formatTime(ts) {
  if (!ts) return ''
  const match = String(ts).match(/\d{2}:\d{2}:\d{2}/)
  return match ? match[0] : String(ts)
}

/** Parse an HTTP access log message. Returns null on miss. */
function parseAccessLog(msg) {
  const match = String(msg || '').match(/"(\w+)\s+(\S+)\s+HTTP\/[^"]+"\s+(\d+)/)
  if (!match) return null
  return { method: match[1], path: match[2], status: match[3] }
}

function formatSize(bytes) {
  if (typeof bytes === 'string') return bytes
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Highlight substrings matching `query` in an HTML-escaped text. */
function highlight(text, query) {
  if (!query) return text
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')
  return text.replace(re, '<mark class="hm-log-hl">$1</mark>')
}

/** Trigger a browser file download of `content` as `filename`. */
function triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-logs-page'
  el.dataset.engine = 'hermes'

  // --- State ---
  let logFiles = []
  let activeFile = ''
  let entries = []
  let loading = false
  let levelFilter = 'ALL'
  let searchQuery = ''
  let lineLimit = 200
  let autoScroll = true
  let tailing = false          // auto-refresh tick active
  let downloading = false
  let tailTimer = null

  // --- Data ---
  async function loadFiles() {
    try {
      logFiles = await api.hermesLogsList()
      if (logFiles.length && !activeFile) activeFile = logFiles[0].name
    } catch (e) {
      console.error('[logs] Failed to load file list:', e)
      logFiles = []
    }
  }

  async function loadEntries({ silent = false } = {}) {
    if (!activeFile) { entries = []; if (!silent) draw(); return }
    if (!silent) { loading = true; draw() }
    try {
      entries = await api.hermesLogsRead(
        activeFile,
        lineLimit,
        levelFilter !== 'ALL' ? levelFilter : null,
      )
    } catch (e) {
      entries = [{ raw: `⚠️ ${t('engine.logsLoadFailed')}: ${e.message || e}` }]
    }
    loading = false
    draw()
  }

  function filteredEntries() {
    if (!searchQuery) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter(e => {
      const hay = [e.raw, e.message, e.logger].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }

  // --- Tailing (simple poll, 2s) ---
  function startTail() {
    if (tailTimer) return
    tailing = true
    tailTimer = setInterval(() => loadEntries({ silent: true }), 2000)
    draw()
  }
  function stopTail() {
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null }
    tailing = false
    draw()
  }
  function toggleTail() { tailing ? stopTail() : startTail() }

  // --- Actions ---
  async function doDownload() {
    if (!activeFile || downloading) return
    downloading = true
    draw()
    try {
      const result = await api.hermesLogsDownload(activeFile)
      if (typeof result === 'string') {
        triggerDownload(result, activeFile)
        toast(t('engine.logsDownloadBrowserOk'), 'success', { duration: 5000 })
      } else {
        const path = result?.path || ''
        toast(t('engine.logsDownloadOk').replace('{path}', path), 'success', { duration: 7000 })
      }
    } catch (e) {
      toast(t('engine.logsDownloadFailed') + ': ' + (e?.message || e), 'error')
    }
    downloading = false
    draw()
  }

  function doClearView() {
    // Local-only clear: drop rendered entries. The file on disk is untouched.
    entries = []
    draw()
  }

  // --- Rendering ---
  function renderLevelBadge(lvl, tone) {
    return `<span class="hm-log-level" data-tone="${tone || ''}">${escHtml(lvl || '-')}</span>`
  }

  function renderEntry(e) {
    const lvl = (e.level || '').toUpperCase()
    const tone = LEVEL_TONE[lvl] || ''
    const logger = e.logger || ''
    const time = formatTime(e.timestamp)
    const rawMsg = e.message || ''
    const access = parseAccessLog(rawMsg)

    // Raw (unparsed) fallback — preserve full line
    if (!e.timestamp && !lvl) {
      const raw = escHtml(e.raw || '')
      return `<div class="hm-log-entry hm-log-entry--raw">
        <span class="hm-log-msg">${highlight(raw, searchQuery)}</span>
      </div>`
    }

    let msgHtml
    if (access) {
      const statusClass = `hm-log-status--${access.status?.[0] || 'x'}xx`
      msgHtml = `
        <span class="hm-log-access">
          <span class="hm-log-method">${escHtml(access.method)}</span>
          <span class="hm-log-path">${escHtml(access.path)}</span>
          <span class="hm-log-status ${statusClass}">${escHtml(access.status)}</span>
        </span>
      `
    } else {
      msgHtml = `<span class="hm-log-msg">${highlight(escHtml(rawMsg), searchQuery)}</span>`
    }

    return `<div class="hm-log-entry" data-tone="${tone}">
      <span class="hm-log-time">${escHtml(time)}</span>
      ${renderLevelBadge(lvl, tone)}
      ${logger ? `<span class="hm-log-logger">${highlight(escHtml(logger), searchQuery)}</span>` : ''}
      ${msgHtml}
    </div>`
  }

  function draw() {
    const filtered = filteredEntries()
    const totalVisible = filtered.length
    const totalLoaded = entries.length

    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <span class="hm-dot hm-dot--${tailing ? 'run' : 'idle'}"></span>
            ${tailing ? t('engine.logsTailing') : t('engine.logsEyebrow')}
          </div>
          <h1 class="hm-hero-h1">${t('engine.hermesLogsTitle')}</h1>
          <div class="hm-hero-sub">~/.hermes/logs/${activeFile ? ' · ' + escHtml(activeFile) : ''}</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm hm-logs-tail ${tailing ? 'is-active' : ''}" title="${t('engine.logsToggleTail')}">
            ${tailing ? ICONS.pause : ICONS.play} ${tailing ? t('engine.logsTailStop') : t('engine.logsTailStart')}
          </button>
          <button class="hm-btn hm-btn--ghost hm-btn--sm hm-logs-download" ${!activeFile || downloading ? 'disabled' : ''} title="${t('engine.logsDownload')}">
            ${ICONS.download} ${downloading ? '…' : t('engine.logsDownload')}
          </button>
          <button class="hm-btn hm-btn--ghost hm-btn--sm hm-logs-refresh" ${loading ? 'disabled' : ''} title="${t('engine.logsRefresh')}">
            ${ICONS.refresh} ${t('engine.logsRefresh')}
          </button>
        </div>
      </div>

      <div class="hm-logs-layout">
        <aside class="hm-logs-sidebar">
          <div class="hm-panel-title hm-logs-sidebar-title">${t('engine.logsFiles')}</div>
          <div class="hm-logs-file-list">
            ${logFiles.length === 0
              ? `<div class="hm-logs-empty hm-muted">${t('engine.logsNoFiles')}</div>`
              : logFiles.map(f => `
                <button class="hm-logs-file-item ${f.name === activeFile ? 'is-active' : ''}" data-file="${escHtml(f.name)}">
                  <span class="hm-logs-file-name">${escHtml(f.name)}</span>
                  <span class="hm-logs-file-size">${formatSize(f.size)}</span>
                </button>
              `).join('')}
          </div>
        </aside>

        <section class="hm-logs-main">
          <div class="hm-logs-toolbar">
            <label class="hm-logs-toolbar-item">
              <span class="hm-field-label">${t('engine.logsLevel')}</span>
              <select id="hm-logs-level" class="hm-input hm-logs-select">
                ${LOG_LEVELS.map(l => `<option value="${l}" ${l === levelFilter ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
            <label class="hm-logs-toolbar-item">
              <span class="hm-field-label">${t('engine.logsLinesLabel')}</span>
              <select id="hm-logs-lines" class="hm-input hm-logs-select">
                ${[100, 200, 500, 1000].map(n => `<option value="${n}" ${n === lineLimit ? 'selected' : ''}>${n} ${t('engine.logsLines')}</option>`).join('')}
              </select>
            </label>
            <label class="hm-logs-toolbar-item hm-logs-toolbar-item--grow">
              <span class="hm-field-label">${t('engine.logsSearchLabel')}</span>
              <input type="text" id="hm-logs-search" class="hm-input" placeholder="${t('engine.logsSearch')}" value="${escHtml(searchQuery)}">
            </label>
            <div class="hm-logs-toolbar-item hm-logs-toolbar-actions">
              <button class="hm-btn hm-btn--ghost hm-btn--sm hm-logs-clear" ${!entries.length ? 'disabled' : ''} title="${t('engine.logsClear')}">
                ${ICONS.clear}
              </button>
            </div>
          </div>
          <div class="hm-logs-count hm-muted">
            ${totalVisible} / ${totalLoaded} ${t('engine.logsEntries')}
            ${searchQuery ? `· ${t('engine.logsFilteredBy')} "${escHtml(searchQuery)}"` : ''}
          </div>

          <div class="hm-logs-content" id="hm-logs-content">
            ${loading ? `
              <div class="hm-logs-loading">
                <div class="hm-skel" style="width:70%;height:14px;margin-bottom:10px"></div>
                <div class="hm-skel" style="width:80%;height:14px;margin-bottom:10px"></div>
                <div class="hm-skel" style="width:60%;height:14px"></div>
              </div>
            ` : ''}
            ${!loading && totalVisible === 0 ? `<div class="hm-logs-empty-content hm-muted">${t('engine.logsEmpty')}</div>` : ''}
            ${!loading ? filtered.map(renderEntry).join('') : ''}
          </div>
        </section>
      </div>
    `
    bind()
    if (autoScroll && !loading) {
      const content = el.querySelector('#hm-logs-content')
      if (content) content.scrollTop = content.scrollHeight
    }
  }

  // --- Event binding ---
  function bind() {
    el.querySelector('.hm-logs-refresh')?.addEventListener('click', () => loadEntries())
    el.querySelector('.hm-logs-tail')?.addEventListener('click', toggleTail)
    el.querySelector('.hm-logs-download')?.addEventListener('click', doDownload)
    el.querySelector('.hm-logs-clear')?.addEventListener('click', doClearView)

    el.querySelectorAll('.hm-logs-file-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.dataset.file === activeFile) return
        activeFile = item.dataset.file
        loadEntries()
      })
    })

    el.querySelector('#hm-logs-level')?.addEventListener('change', (e) => {
      levelFilter = e.target.value
      loadEntries()
    })

    el.querySelector('#hm-logs-lines')?.addEventListener('change', (e) => {
      lineLimit = parseInt(e.target.value) || 200
      loadEntries()
    })

    el.querySelector('#hm-logs-search')?.addEventListener('input', (e) => {
      searchQuery = e.target.value
      draw()
    })
  }

  // --- Lifecycle: stop tail when the page is detached ---
  const detachObserver = new MutationObserver(() => {
    if (!el.isConnected) {
      stopTail()
      detachObserver.disconnect()
    }
  })
  requestAnimationFrame(() => {
    if (el.parentNode) detachObserver.observe(el.parentNode, { childList: true })
  })

  // --- Init ---
  async function init() {
    await loadFiles()
    await loadEntries()
  }
  init()

  return el
}
