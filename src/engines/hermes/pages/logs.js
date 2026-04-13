/**
 * Hermes Agent 日志查看器
 * 支持按文件/级别/关键字过滤，实时查看 Agent 运行日志
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

const LOG_LEVELS = ['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
const LEVEL_CLASS = { DEBUG: 'debug', INFO: 'info', WARNING: 'warn', WARN: 'warn', ERROR: 'error', CRITICAL: 'error', FATAL: 'error' }

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-logs-page'

  let logFiles = []
  let activeFile = ''
  let entries = []
  let loading = false
  let levelFilter = 'ALL'
  let searchQuery = ''
  let lineLimit = 200
  let autoScroll = true

  async function loadFiles() {
    try {
      logFiles = await api.hermesLogsList()
      if (logFiles.length && !activeFile) activeFile = logFiles[0].name
    } catch (e) {
      console.error('Failed to load log files:', e)
      logFiles = []
    }
  }

  async function loadEntries() {
    if (!activeFile) { entries = []; draw(); return }
    loading = true
    draw()
    try {
      entries = await api.hermesLogsRead(activeFile, lineLimit, levelFilter !== 'ALL' ? levelFilter : null)
    } catch (e) {
      entries = [{ raw: `⚠️ ${t('engine.logsLoadFailed')}: ${e.message || e}` }]
    }
    loading = false
    draw()
  }

  function filteredEntries() {
    if (!searchQuery) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter(e => (e.raw || e.message || '').toLowerCase().includes(q))
  }

  function formatSize(bytes) {
    if (typeof bytes === 'string') return bytes
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  function draw() {
    const filtered = filteredEntries()
    el.innerHTML = `
      <div class="hm-logs-header">
        <span class="hm-logs-header-title">${t('engine.hermesLogsTitle')}</span>
        <div class="hm-logs-header-actions">
          <select id="hm-logs-level" class="hm-logs-select">
            ${LOG_LEVELS.map(l => `<option value="${l}" ${l === levelFilter ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <select id="hm-logs-lines" class="hm-logs-select">
            ${[100, 200, 500, 1000].map(n => `<option value="${n}" ${n === lineLimit ? 'selected' : ''}>${n} ${t('engine.logsLines')}</option>`).join('')}
          </select>
          <input type="text" id="hm-logs-search" class="hm-logs-search" placeholder="${t('engine.logsSearch')}" value="${escHtml(searchQuery)}">
          <button class="btn btn-sm" id="hm-logs-refresh">${t('engine.logsRefresh')}</button>
        </div>
      </div>
      <div class="hm-logs-layout">
        <div class="hm-logs-sidebar">
          <div class="hm-logs-sidebar-title">${t('engine.logsFiles')}</div>
          ${logFiles.length === 0 ? `<div class="hm-logs-empty">${t('engine.logsNoFiles')}</div>` : ''}
          ${logFiles.map(f => `
            <div class="hm-logs-file-item ${f.name === activeFile ? 'active' : ''}" data-file="${escHtml(f.name)}">
              <span class="hm-logs-file-name">${escHtml(f.name)}</span>
              <span class="hm-logs-file-size">${formatSize(f.size)}</span>
            </div>
          `).join('')}
        </div>
        <div class="hm-logs-main">
          <div class="hm-logs-toolbar">
            <div class="hm-logs-count">${filtered.length} ${t('engine.logsEntries')}</div>
          </div>
          <div class="hm-logs-content" id="hm-logs-content">
            ${loading ? `<div class="hm-logs-loading">${t('engine.logsLoading')}</div>` : ''}
            ${!loading && filtered.length === 0 ? `<div class="hm-logs-empty-content">${t('engine.logsEmpty')}</div>` : ''}
            ${!loading ? filtered.map(e => renderEntry(e)).join('') : ''}
          </div>
        </div>
      </div>
    `
    bind()
    if (autoScroll && !loading) {
      const content = el.querySelector('#hm-logs-content')
      if (content) content.scrollTop = content.scrollHeight
    }
  }

  function renderEntry(e) {
    const lvl = (e.level || '').toUpperCase()
    const cls = LEVEL_CLASS[lvl] || ''
    if (e.timestamp) {
      const time = e.timestamp.replace(/^.*?(\d{2}:\d{2}:\d{2}).*$/, '$1') || e.timestamp
      return `<div class="hm-log-entry ${cls}">
        <span class="hm-log-time">${escHtml(time)}</span>
        <span class="hm-log-level ${cls}">${escHtml(lvl || '-')}</span>
        <span class="hm-log-msg">${escHtml(e.message || '')}</span>
      </div>`
    }
    return `<div class="hm-log-entry raw"><span class="hm-log-msg">${escHtml(e.raw || '')}</span></div>`
  }

  function bind() {
    el.querySelector('#hm-logs-refresh')?.addEventListener('click', () => loadEntries())

    el.querySelectorAll('.hm-logs-file-item').forEach(item => {
      item.addEventListener('click', () => {
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

  // Init
  async function init() {
    await loadFiles()
    await loadEntries()
  }
  init()

  return el
}
