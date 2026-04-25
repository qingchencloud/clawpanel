/**
 * Hermes Agent — Memory editor (three-section: MEMORY / USER / SOUL)
 *
 * Mirrors the data contract used by the official `hermes-web-ui`:
 *   GET  /api/hermes/memory            → { memory, user, soul, mtimes }
 *   POST /api/hermes/memory            → { section, content }
 *
 * ClawPanel calls the equivalent Rust/Web-stub commands (`hermes_memory_read_all`
 * + `hermes_memory_write`) so the page works on Tauri and Web modes.
 *
 * All three files live in `~/.hermes/memories/` and are plain Markdown.
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showContentModal } from '../../../components/modal.js'

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Markdown → HTML. Intentionally minimal (no external dep). Good enough for
 * short agent persona notes. Code blocks preserved. Tables NOT supported.
 */
function mdToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br>')
}

const ICONS = {
  memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  user:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  soul:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><path d="M12 6v6l4 2"/></svg>',
  edit:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  save:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
}

/** Format epoch-seconds → relative/short local time (serif-friendly). */
function fmtMtime(epoch) {
  if (!epoch) return ''
  const now = Date.now() / 1000
  const diff = now - epoch
  if (diff < 60) return t('engine.memoryJustNow')
  if (diff < 3600) return t('engine.memoryMinAgo').replace('{n}', Math.floor(diff / 60))
  if (diff < 86400) return t('engine.memoryHrAgo').replace('{n}', Math.floor(diff / 3600))
  const d = new Date(epoch * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Rough word + char count. CJK counted per character. */
function contentStats(text) {
  const t = text || ''
  const chars = t.length
  // Split on whitespace OR CJK character boundary
  const words = (t.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+/g) || []).length
  return { chars, words }
}

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-memory-page'
  el.dataset.engine = 'hermes'

  // --- State ---
  const SECTIONS = [
    { key: 'memory', titleKey: 'engine.memoryNotes',   icon: ICONS.memory, descKey: 'engine.memoryNotesDesc'   },
    { key: 'user',   titleKey: 'engine.memoryProfile', icon: ICONS.user,   descKey: 'engine.memoryProfileDesc' },
    { key: 'soul',   titleKey: 'engine.memorySoul',    icon: ICONS.soul,   descKey: 'engine.memorySoulDesc'    },
  ]
  const data = { memory: '', user: '', soul: '' }
  const mtimes = { memory: null, user: null, soul: null }
  let editing = null       // { key, buffer }
  let loading = true
  let saving = false
  let loadError = null

  async function loadAll() {
    loading = true
    loadError = null
    draw()
    try {
      const res = await api.hermesMemoryReadAll()
      data.memory = res?.memory || ''
      data.user = res?.user || ''
      data.soul = res?.soul || ''
      mtimes.memory = res?.memory_mtime ?? null
      mtimes.user = res?.user_mtime ?? null
      mtimes.soul = res?.soul_mtime ?? null
    } catch (e) {
      loadError = String(e?.message || e).replace(/^Error:\s*/, '')
    }
    loading = false
    draw()
  }

  function startEdit(key) {
    const section = SECTIONS.find(s => s.key === key)
    editing = { key, buffer: data[key] || '' }
    const { chars, words } = contentStats(editing.buffer)
    const overlay = showContentModal({
      title: `${t(section?.titleKey || 'engine.hermesMemoryTitle')} · ${t('engine.memoryEdit')}`,
      width: 920,
      content: `
        <div class="hm-mem-modal-wrap">
          <div class="hm-mem-desc">${t(section?.descKey || 'engine.memoryNotesDesc')}</div>
          <textarea id="hm-mem-modal-textarea" class="hm-input hm-mem-editor hm-mem-modal-editor" spellcheck="false" placeholder="${t('engine.memoryPlaceholder')}">${escHtml(editing.buffer)}</textarea>
          <div class="hm-mem-modal-foot">
            <span class="hm-mem-stats" id="hm-mem-modal-stats">
              <span>${words} ${t('engine.memoryWords')}</span>
              <span class="hm-mem-sep">·</span>
              <span>${chars} ${t('engine.memoryChars')}</span>
            </span>
            <span class="hm-spacer"></span>
            <span class="hm-muted">${t('engine.memorySaveHint')}</span>
          </div>
        </div>
      `,
      buttons: [{ id: 'hm-mem-modal-save', className: 'btn btn-primary btn-sm', label: t('engine.memorySave') }],
    })
    overlay.classList.add('hm-mem-modal-overlay')
    overlay.dataset.engine = 'hermes'
    const ta = overlay.querySelector('#hm-mem-modal-textarea')
    const cancelBtn = overlay.querySelector('[data-action="cancel"]')
    const saveBtn = overlay.querySelector('#hm-mem-modal-save')
    const closeWithConfirm = () => {
      if (!editing) {
        overlay.remove()
        return
      }
      const dirty = editing.buffer !== (data[editing.key] || '')
      if (dirty && !confirm(t('engine.memoryUnsaved'))) return
      editing = null
      overlay.remove()
    }
    cancelBtn.textContent = t('engine.memoryCancel')
    cancelBtn.onclick = closeWithConfirm
    saveBtn.onclick = save
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return
      e.stopImmediatePropagation()
      closeWithConfirm()
    }, true)
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        closeWithConfirm()
      }
    }, true)
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.addEventListener('input', (e) => {
      if (!editing) return
      editing.buffer = e.target.value
      const statsEl = overlay.querySelector('#hm-mem-modal-stats')
      const stats = contentStats(editing.buffer)
      if (statsEl) {
        statsEl.innerHTML = `
          <span>${stats.words} ${t('engine.memoryWords')}</span>
          <span class="hm-mem-sep">·</span>
          <span>${stats.chars} ${t('engine.memoryChars')}</span>
        `
      }
    })
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    })
  }

  function cancelEdit() {
    if (!editing) return
    const dirty = editing.buffer !== (data[editing.key] || '')
    if (dirty && !confirm(t('engine.memoryUnsaved'))) return
    editing = null
    document.querySelector('.hm-mem-modal-overlay')?.remove()
    draw()
  }

  async function save() {
    if (!editing || saving) return
    saving = true
    const saveBtn = document.querySelector('#hm-mem-modal-save')
    if (saveBtn) {
      saveBtn.disabled = true
      saveBtn.textContent = t('engine.memorySaving')
    }
    const { key, buffer } = editing
    try {
      await api.hermesMemoryWrite(key, buffer)
      data[key] = buffer
      mtimes[key] = Math.floor(Date.now() / 1000)
      editing = null
      document.querySelector('.hm-mem-modal-overlay')?.remove()
      toast(t('engine.memorySaved'), 'success')
    } catch (e) {
      if (saveBtn) {
        saveBtn.disabled = false
        saveBtn.textContent = t('engine.memorySave')
      }
      toast(t('engine.memorySaveFailed') + ': ' + (e?.message || e), 'error')
    }
    saving = false
    draw()
  }

  function renderSection(section) {
    const content = data[section.key] || ''
    const { chars, words } = contentStats(content)
    const mtime = mtimes[section.key]
    const statsMarkup = `<span class="hm-mem-stats">
      <span>${words} ${t('engine.memoryWords')}</span>
      <span class="hm-mem-sep">·</span>
      <span>${chars} ${t('engine.memoryChars')}</span>
      ${mtime ? `<span class="hm-mem-sep">·</span><span>${escHtml(fmtMtime(mtime))}</span>` : ''}
    </span>`

    return `
      <div class="hm-panel hm-mem-panel" data-key="${section.key}">
        <div class="hm-panel-header">
          <div class="hm-panel-title">
            <span class="hm-panel-title-icon">${section.icon}</span>
            ${t(section.titleKey)}
          </div>
          <div class="hm-panel-actions">
            ${statsMarkup}
            <button class="hm-btn hm-btn--ghost hm-btn--sm hm-mem-edit" data-key="${section.key}">${ICONS.edit} ${t('engine.memoryEdit')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          <div class="hm-mem-desc">${t(section.descKey)}</div>
          ${content.trim()
            ? `<div class="hm-mem-rendered markdown-body">${mdToHtml(content)}</div>`
            : `<div class="hm-mem-empty">
                <span class="hm-mem-empty-title">${t('engine.memoryEmpty')}</span>
                <span class="hm-muted">${t(section.descKey)}</span>
              </div>`}
        </div>
      </div>
    `
  }

  function draw() {
    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <span class="hm-dot hm-dot--run"></span>
            ${t('engine.memoryEyebrow')}
          </div>
          <h1 class="hm-hero-h1">${t('engine.hermesMemoryTitle')}</h1>
          <div class="hm-hero-sub">~/.hermes/memories/ · 3 files</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm hm-mem-refresh" ${loading ? 'disabled' : ''} title="${t('engine.logsRefresh')}">
            ${ICONS.refresh} ${t('engine.logsRefresh')}
          </button>
        </div>
      </div>

      ${loadError ? `
        <div class="hm-panel" style="margin-bottom:18px">
          <div class="hm-panel-body hm-panel-body--tight">
            <div style="color:var(--hm-error);font-family:var(--hm-font-mono);font-size:12.5px">
              ${escHtml(loadError)}
            </div>
          </div>
        </div>
      ` : ''}

      ${loading ? `
        <div class="hm-panel"><div class="hm-panel-body">
          <div class="hm-skel" style="width:40%;height:14px;margin-bottom:12px"></div>
          <div class="hm-skel" style="width:100%;height:80px"></div>
        </div></div>
        <div class="hm-panel"><div class="hm-panel-body">
          <div class="hm-skel" style="width:30%;height:14px;margin-bottom:12px"></div>
          <div class="hm-skel" style="width:100%;height:60px"></div>
        </div></div>
      ` : SECTIONS.map(renderSection).join('')}
    `
    bind()
  }

  function bind() {
    el.querySelector('.hm-mem-refresh')?.addEventListener('click', () => loadAll())
    el.querySelectorAll('.hm-mem-edit').forEach(btn => {
      btn.addEventListener('click', () => startEdit(btn.dataset.key))
    })
  }

  loadAll()
  return el
}
