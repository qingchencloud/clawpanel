/**
 * Hermes Agent Skills 浏览器
 * 从 ~/.hermes/skills/ 读取技能文件，按分类展示，支持搜索和详情查看
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br>')
}

export function render() {
  const el = document.createElement('div')
  el.className = 'hermes-skills-page'

  let categories = []
  let loading = true
  let searchQuery = ''
  let activeSkill = null // { category, file, name, path }
  let skillContent = ''
  let loadingDetail = false

  async function loadSkills() {
    loading = true
    draw()
    try {
      categories = await api.hermesSkillsList()
    } catch (e) {
      console.error('Failed to load skills:', e)
      categories = []
    }
    loading = false
    draw()
  }

  async function loadDetail(skill) {
    activeSkill = skill
    loadingDetail = true
    draw()
    try {
      skillContent = await api.hermesSkillDetail(skill.path)
    } catch (e) {
      skillContent = `⚠️ ${e.message || e}`
    }
    loadingDetail = false
    draw()
  }

  function filteredCategories() {
    if (!searchQuery) return categories
    const q = searchQuery.toLowerCase()
    return categories.map(cat => ({
      ...cat,
      skills: cat.skills.filter(s =>
        s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
      )
    })).filter(cat => cat.skills.length > 0)
  }

  function totalSkillCount() {
    return categories.reduce((sum, cat) => sum + cat.skills.length, 0)
  }

  function draw() {
    const filtered = filteredCategories()
    el.innerHTML = `
      <div class="hm-skills-header">
        <span class="hm-skills-header-title">${t('engine.hermesSkillsTitle')}</span>
        <div class="hm-skills-header-right">
          <input type="text" id="hm-skills-search" class="hm-skills-header-search" placeholder="${t('engine.skillsSearch')}" value="${escHtml(searchQuery)}">
          <span class="hm-skills-count">${totalSkillCount()} ${t('engine.skillsTotal')}</span>
        </div>
      </div>
      <div class="hm-skills-layout">
        <div class="hm-skills-list-panel">
          <div class="hm-skills-list-scroll">
            ${loading ? `<div class="hm-skills-loading">${t('engine.skillsLoading')}</div>` : ''}
            ${!loading && filtered.length === 0 ? `<div class="hm-skills-empty">${t('engine.skillsEmpty')}</div>` : ''}
            ${!loading ? filtered.map(cat => `
              <div class="hm-skills-category">
                <div class="hm-skills-cat-header">
                  <span class="hm-skills-cat-name">${escHtml(cat.category === '_root' ? t('engine.skillsUncategorized') : cat.category)}</span>
                  <span class="hm-skills-cat-count">${cat.skills.length}</span>
                </div>
                ${cat.skills.map(s => `
                  <div class="hm-skills-item ${activeSkill?.path === s.path ? 'active' : ''}" data-path="${escHtml(s.path)}">
                    <div class="hm-skills-item-name">${escHtml(s.name)}</div>
                    ${s.description ? `<div class="hm-skills-item-desc">${escHtml(s.description)}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            `).join('') : ''}
          </div>
        </div>
        <div class="hm-skills-detail-panel">
          ${!activeSkill ? `<div class="hm-skills-detail-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
            <span>${t('engine.skillsSelectHint')}</span>
          </div>` : ''}
          ${activeSkill && loadingDetail ? `<div class="hm-skills-detail-loading">${t('engine.skillsLoading')}</div>` : ''}
          ${activeSkill && !loadingDetail ? `
            <div class="hm-skills-detail-header">
              <h2>${escHtml(activeSkill.name)}</h2>
              <span class="hm-skills-detail-file">${escHtml(activeSkill.file)}</span>
            </div>
            <div class="hm-skills-detail-content markdown-body">${mdToHtml(skillContent)}</div>
          ` : ''}
        </div>
      </div>
    `
    bind()
  }

  function bind() {
    el.querySelector('#hm-skills-search')?.addEventListener('input', (e) => {
      searchQuery = e.target.value
      draw()
    })
    el.querySelectorAll('.hm-skills-item').forEach(item => {
      item.addEventListener('click', () => {
        const skillPath = item.dataset.path
        // Find the skill object
        for (const cat of categories) {
          const s = cat.skills.find(s => s.path === skillPath)
          if (s) { loadDetail(s); return }
        }
      })
    })
  }

  loadSkills()
  return el
}
