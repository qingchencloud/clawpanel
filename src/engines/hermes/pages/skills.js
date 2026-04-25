/**
 * Hermes Agent — Skills browser (editorial luxury re-write)
 *
 * Mirrors the official `hermes-web-ui` Skills view:
 *   GET    /api/hermes/skills                       → { categories: [...] }
 *   PUT    /api/hermes/skills/toggle                → enable/disable
 *   GET    /api/hermes/skills/:cat/:skill/files     → attached files
 *   GET    /api/hermes/skills/<path>                → file content
 *
 * Layout:
 *   ┌ hero ───────────────────────────────────────────────────┐
 *   │ eyebrow + big-serif title + search + skill count         │
 *   ├─ sidebar (categories + skills) ┬─ detail (markdown + files)
 *   │ collapsible, toggle switches   │   breadcrumb when viewing
 *   │                                │   an attached file
 *   └────────────────────────────────┴──────────────────────────┘
 *
 * Extras beyond the official UI:
 *   - Collapsible categories (persist in memory only)
 *   - File browser with breadcrumb + back button (Vue parity)
 *   - Inline toggle switches use stable loading state per skill
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Minimal, dependency-free Markdown renderer. Matches the feature-set used
 * across Hermes pages (memory/skills) so the look is consistent. Supports:
 *   - fenced code blocks (```lang\ncode```)
 *   - inline `code`, **bold**, *italic*
 *   - `# / ## / ### / ####` headings
 *   - unordered list (`- item`) → `<li>`
 *   - `[text](url)` → `<a>`
 * Anything else is escaped and rendered as plain text with `<br>` for newlines.
 */
function mdToHtml(text) {
  if (!text) return ''
  // First pass: extract code blocks so inner contents aren't mangled by other
  // replacers. We keep a placeholder token and restore at the end.
  const blocks = []
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.push({ lang, code }) - 1
    return `\u0000CODEBLOCK_${idx}\u0000`
  })
  out = out
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^#### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^(?:\s*[-*]\s+(.+))(?:\n\s*[-*]\s+(.+))*/gm, (m) =>
      '<ul>' + m.trim().split(/\n\s*[-*]\s+/).map(li => `<li>${li.replace(/^[-*]\s+/, '')}</li>`).join('') + '</ul>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
  // Restore code blocks.
  out = out.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[Number(i)]
    return `<pre><code class="lang-${escHtml(lang)}">${escHtml(code)}</code></pre>`
  })
  return `<p>${out}</p>`
}

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="11" height="11"><polyline points="6 9 12 15 18 9"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="15 18 9 12 15 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="13" height="13"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
  empty: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.35"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
}

/** Cross-platform basename (handles `/` and `\\`). */
function basename(p) {
  if (!p) return ''
  const s = String(p).replace(/\\/g, '/')
  const idx = s.lastIndexOf('/')
  return idx >= 0 ? s.slice(idx + 1) : s
}

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-skills-page'
  el.dataset.engine = 'hermes'

  // --- State ---
  let categories = []          // [{ category, description, skills: [...] }]
  let loading = true
  let searchQuery = ''
  let collapsed = new Set()    // collapsed category names
  let toggling = new Set()     // slugs currently being toggled

  let activeSkill = null       // the selected `{ category, file, name, slug, description, path, isDir, enabled }`
  let skillContent = ''
  let loadingDetail = false

  let files = []               // attached files (excluding SKILL.md)
  let viewingFile = null       // relative path when browsing an attached file
  let fileContent = ''
  let loadingFile = false

  // ============================================================ loaders

  async function loadSkills() {
    loading = true
    draw()
    try {
      categories = await api.hermesSkillsList()
    } catch (e) {
      console.error('Failed to load skills:', e)
      categories = []
      toast(t('engine.skillsLoadFailed') + ': ' + (e?.message || e), 'error')
    }
    loading = false
    draw()
  }

  async function loadDetail(skill) {
    activeSkill = skill
    loadingDetail = true
    viewingFile = null
    fileContent = ''
    files = []
    skillContent = ''
    draw()

    // Kick off attached-file listing in parallel when the skill lives in a
    // directory (`isDir = true`). Legacy flat skills have no attached files.
    const contentPromise = api.hermesSkillDetail(skill.path)
      .then(c => { skillContent = c })
      .catch(e => { skillContent = `⚠️ ${t('engine.skillsLoadFailed')}: ${e?.message || e}` })
    const filesPromise = skill.isDir && skill.category && skill.category !== '_root'
      ? api.hermesSkillFiles(skill.category, skill.slug || skill.file)
          .then(list => { files = (list || []).filter(f => !f.isDir) })
          .catch(() => { files = [] })
      : Promise.resolve()

    await Promise.all([contentPromise, filesPromise])
    loadingDetail = false
    draw()
  }

  async function openFile(relPath) {
    if (!activeSkill?.isDir || !activeSkill.category) return
    viewingFile = relPath
    loadingFile = true
    fileContent = ''
    draw()
    try {
      const dir = activeSkill.skill_dir ||
        (activeSkill.path ? activeSkill.path.replace(/[\\/]SKILL\.md$/i, '') : '')
      const sep = /\\/.test(dir) && !/\//.test(dir) ? '\\' : '/'
      const full = dir ? `${dir}${sep}${relPath.replace(/\//g, sep)}` : relPath
      fileContent = await api.hermesSkillDetail(full)
    } catch (e) {
      fileContent = `⚠️ ${t('engine.skillsFileLoadFailed')}: ${e?.message || e}`
    }
    loadingFile = false
    draw()
  }

  function backToSkill() {
    viewingFile = null
    fileContent = ''
    draw()
  }

  async function handleToggle(skill, nextEnabled) {
    if (toggling.has(skill.slug)) return
    toggling.add(skill.slug)
    draw()
    try {
      await api.hermesSkillToggle(skill.slug, nextEnabled)
      skill.enabled = nextEnabled
      toast(
        nextEnabled ? t('engine.skillsEnabled') : t('engine.skillsDisabled'),
        'success',
      )
    } catch (e) {
      toast(t('engine.skillsToggleFailed') + ': ' + (e?.message || e), 'error')
    } finally {
      toggling.delete(skill.slug)
      draw()
    }
  }

  // ============================================================ derived

  function filteredCategories() {
    if (!searchQuery) return categories
    const q = searchQuery.toLowerCase()
    return categories.map(cat => ({
      ...cat,
      skills: cat.skills.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.slug || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q),
      ),
    })).filter(cat => cat.skills.length > 0 || (cat.category || '').toLowerCase().includes(q))
  }

  function totalSkillCount() {
    return categories.reduce((sum, cat) => sum + cat.skills.length, 0)
  }

  function enabledSkillCount() {
    return categories.reduce(
      (sum, cat) => sum + cat.skills.filter(s => s.enabled !== false).length,
      0,
    )
  }

  // ============================================================ render

  function renderSkillItem(cat, s) {
    const isActive = activeSkill?.path === s.path
    const isToggling = toggling.has(s.slug)
    const isEnabled = s.enabled !== false
    return `
      <button class="hm-skill-item ${isActive ? 'is-active' : ''} ${!isEnabled ? 'is-disabled' : ''}"
              data-path="${escHtml(s.path)}">
        <div class="hm-skill-info">
          <div class="hm-skill-name">${escHtml(s.name)}</div>
          ${s.description ? `<div class="hm-skill-desc">${escHtml(s.description)}</div>` : ''}
        </div>
        <label class="hm-switch ${isEnabled ? 'is-on' : ''} ${isToggling ? 'is-busy' : ''}"
               data-slug="${escHtml(s.slug)}" data-category="${escHtml(cat.category)}"
               title="${isEnabled ? t('engine.skillsDisable') : t('engine.skillsEnable')}">
          <span class="hm-switch-track"></span>
          <span class="hm-switch-thumb"></span>
        </label>
      </button>
    `
  }

  function renderCategory(cat) {
    const name = cat.category === '_root' ? t('engine.skillsUncategorized') : cat.category
    const isCollapsed = collapsed.has(cat.category)
    return `
      <div class="hm-skill-category">
        <button class="hm-skill-cat-header ${isCollapsed ? 'is-collapsed' : ''}" data-cat="${escHtml(cat.category)}">
          <span class="hm-skill-cat-arrow">${ICONS.chevron}</span>
          <span class="hm-skill-cat-name">${escHtml(name)}</span>
          <span class="hm-skill-cat-count">${cat.skills.length}</span>
        </button>
        ${!isCollapsed ? `
          ${cat.description ? `<div class="hm-skill-cat-desc">${escHtml(cat.description)}</div>` : ''}
          <div class="hm-skill-cat-items">
            ${cat.skills.map(s => renderSkillItem(cat, s)).join('')}
          </div>
        ` : ''}
      </div>
    `
  }

  function renderSidebar() {
    const filtered = filteredCategories()
    return `
      <aside class="hm-skills-sidebar">
        <div class="hm-skills-sidebar-search">
          <span class="hm-skills-search-icon">${ICONS.search}</span>
          <input type="text" id="hm-skills-search" class="hm-skills-search-input"
                 placeholder="${t('engine.skillsSearch')}" value="${escHtml(searchQuery)}">
        </div>
        <div class="hm-skills-sidebar-scroll">
          ${loading ? `
            <div class="hm-skills-loading">
              <div class="hm-skel" style="height:18px;width:60%;margin-bottom:10px"></div>
              <div class="hm-skel" style="height:14px;width:85%;margin-bottom:6px"></div>
              <div class="hm-skel" style="height:14px;width:70%;margin-bottom:6px"></div>
              <div class="hm-skel" style="height:14px;width:90%"></div>
            </div>
          ` : ''}
          ${!loading && filtered.length === 0 ? `
            <div class="hm-skills-empty">
              ${searchQuery ? t('engine.skillsNoMatch') : t('engine.skillsEmpty')}
            </div>
          ` : ''}
          ${!loading ? filtered.map(renderCategory).join('') : ''}
        </div>
      </aside>
    `
  }

  function renderEmpty() {
    return `
      <div class="hm-skills-detail-empty">
        ${ICONS.empty}
        <div class="hm-skills-detail-empty-title">${t('engine.skillsSelectHint')}</div>
        <div class="hm-skills-detail-empty-sub">${t('engine.skillsSelectSub')}</div>
      </div>
    `
  }

  function renderDetail() {
    if (!activeSkill) return renderEmpty()
    if (loadingDetail) {
      return `
        <div class="hm-skills-detail-body">
          <div class="hm-skel" style="height:24px;width:40%;margin-bottom:18px"></div>
          <div class="hm-skel" style="height:14px;width:100%;margin-bottom:8px"></div>
          <div class="hm-skel" style="height:14px;width:95%;margin-bottom:8px"></div>
          <div class="hm-skel" style="height:14px;width:70%"></div>
        </div>
      `
    }

    // --- File view (attached file of a skill) ---
    if (viewingFile) {
      return `
        <div class="hm-skills-detail-breadcrumb">
          <button class="hm-skills-back-btn" id="hm-skills-back">
            ${ICONS.back}<span>${t('engine.skillsBackTo')} ${escHtml(activeSkill.name)}</span>
          </button>
          <span class="hm-skills-breadcrumb-sep">/</span>
          <span class="hm-skills-breadcrumb-path">${escHtml(viewingFile)}</span>
        </div>
        <div class="hm-skills-detail-body">
          ${loadingFile
            ? `<div class="hm-skills-loading">${t('engine.skillsLoading')}</div>`
            : `<div class="hm-skills-markdown">${mdToHtml(fileContent)}</div>`}
        </div>
      `
    }

    // --- Skill content view ---
    return `
      <div class="hm-skills-detail-head">
        <div class="hm-skills-detail-title">
          ${activeSkill.category && activeSkill.category !== '_root' ? `
            <span class="hm-skills-title-cat">${escHtml(activeSkill.category)}</span>
            <span class="hm-skills-title-sep">/</span>
          ` : ''}
          <span class="hm-skills-title-name">${escHtml(activeSkill.name)}</span>
          ${activeSkill.enabled === false
            ? `<span class="hm-pill hm-pill--muted hm-skills-status">${t('engine.skillsDisabledTag')}</span>`
            : `<span class="hm-pill hm-pill--ok hm-skills-status">${t('engine.skillsEnabledTag')}</span>`}
        </div>
        <div class="hm-skills-detail-sub">
          ${activeSkill.isDir ? ICONS.folder : ICONS.file}
          <span>${escHtml(activeSkill.file)}</span>
        </div>
      </div>
      <div class="hm-skills-detail-body">
        <div class="hm-skills-markdown">${mdToHtml(skillContent)}</div>
      </div>
      ${files.length > 0 ? `
        <div class="hm-skills-files">
          <div class="hm-skills-files-header">
            <span class="hm-skills-files-label">${t('engine.skillsAttachedFiles')}</span>
            <span class="hm-skills-files-count">${files.length}</span>
          </div>
          <div class="hm-skills-files-list">
            ${files.map(f => `
              <button class="hm-skills-file-chip" data-file="${escHtml(f.path)}" title="${escHtml(f.path)}">
                ${f.isDir ? ICONS.folder : ICONS.file}
                <span>${escHtml(basename(f.path))}</span>
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `
  }

  function draw() {
    const enabled = enabledSkillCount()
    const total = totalSkillCount()
    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <span class="hm-dot hm-dot--idle"></span>
            ${t('engine.skillsEyebrow')}
          </div>
          <h1 class="hm-hero-h1">${t('engine.hermesSkillsTitle')}</h1>
          <div class="hm-hero-sub">~/.hermes/skills/
            ${!loading ? `<span class="hm-skills-count-inline"> · ${enabled}/${total} ${t('engine.skillsActive')}</span>` : ''}
          </div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-skills-refresh" ${loading ? 'disabled' : ''}>
            ${ICONS.refresh} ${t('engine.skillsRefresh')}
          </button>
        </div>
      </div>

      <div class="hm-skills-layout">
        ${renderSidebar()}
        <section class="hm-skills-main">${renderDetail()}</section>
      </div>
    `
    bind()
  }

  // ============================================================ bindings

  function bind() {
    el.querySelector('#hm-skills-search')?.addEventListener('input', (e) => {
      searchQuery = e.target.value
      draw()
    })

    el.querySelector('#hm-skills-refresh')?.addEventListener('click', () => loadSkills())

    el.querySelectorAll('.hm-skill-cat-header').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat
        if (collapsed.has(cat)) collapsed.delete(cat)
        else collapsed.add(cat)
        draw()
      })
    })

    el.querySelectorAll('.hm-skill-item').forEach(item => {
      item.addEventListener('click', (evt) => {
        // Toggle switch clicks should NOT open the skill detail.
        if (evt.target.closest('.hm-switch')) return
        const skillPath = item.dataset.path
        for (const cat of categories) {
          const s = cat.skills.find(x => x.path === skillPath)
          if (s) { loadDetail({ ...s, category: cat.category }); return }
        }
      })
    })

    el.querySelectorAll('.hm-switch').forEach(sw => {
      sw.addEventListener('click', (evt) => {
        evt.stopPropagation()
        if (sw.classList.contains('is-busy')) return
        const slug = sw.dataset.slug
        const catName = sw.dataset.category
        const cat = categories.find(c => c.category === catName)
        const skill = cat?.skills.find(s => s.slug === slug)
        if (!skill) return
        handleToggle(skill, skill.enabled === false)
      })
    })

    el.querySelector('#hm-skills-back')?.addEventListener('click', backToSkill)

    el.querySelectorAll('.hm-skills-file-chip').forEach(chip => {
      chip.addEventListener('click', () => openFile(chip.dataset.file))
    })
  }

  loadSkills()
  return el
}
