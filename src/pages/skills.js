/**
 * Skills 页面
 * 默认展示 ClawHub 热门推荐 + 已安装 + 搜索结果 + 详情 + 安装
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

const SKILLS_LOAD_TIMEOUT_MS = 10000
const SKILLS_AUTO_RETRY_DELAY_MS = 1200
const SKILLS_MAX_AUTO_RETRY = 1
let skillsLoadSeq = 0

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Skills</h1>
      <p class="page-desc">从 ClawHub 浏览热门推荐、搜索 Skill、查看详情并一键安装</p>
    </div>
    <div id="skills-content" class="config-section">
      <div class="stat-card loading-placeholder" style="height:96px"></div>
    </div>
  `

  bindEvents(page)
  loadSkills(page)
  return page
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, label = '请求') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s）`)), ms)
    }),
  ])
}

function setLoadingHint(page, text = '正在加载 Skills...') {
  const el = page.querySelector('#skills-content')
  if (!el) return
  el.innerHTML = `
    <div class="skills-loading-panel">
      <div class="stat-card loading-placeholder" style="height:96px"></div>
      <div class="form-hint" style="margin-top:8px">${escapeHtml(text)}</div>
    </div>
  `
}

function renderLoadError(el, message, canAutoRetry) {
  el.innerHTML = `
    <div class="skills-load-error">
      <div style="color:var(--error);margin-bottom:8px">加载失败：${escapeHtml(message)}</div>
      <div class="form-hint" style="margin-bottom:10px">${canAutoRetry ? '正在自动重试...' : '你可以手动重试'}</div>
      <div class="clawhub-toolbar" style="margin-bottom:0">
        <button class="btn btn-secondary btn-sm" data-action="skill-retry">立即重试</button>
      </div>
    </div>
  `
}

async function loadSkills(page, query = '', options = {}) {
  const el = page.querySelector('#skills-content')
  if (!el) return

  const silent = !!options.silent
  const retryCount = options.retryCount || 0
  const requestId = ++skillsLoadSeq

  if (!silent) {
    setLoadingHint(page, retryCount > 0 ? `正在重试加载（第 ${retryCount + 1} 次）...` : '正在加载 Skills...')
  }

  try {
    const [installed, trending, results] = await withTimeout(
      Promise.all([
        api.clawhubListInstalled(),
        api.clawhubTrending(),
        query ? api.clawhubSearch(query) : Promise.resolve([]),
      ]),
      SKILLS_LOAD_TIMEOUT_MS,
      'Skills 数据加载'
    )

    if (requestId !== skillsLoadSeq) return
    renderSkills(el, { installed, trending, results, query })
  } catch (e) {
    if (requestId !== skillsLoadSeq) return

    const message = (e?.message || String(e || '')).trim() || '未知错误'
    const canAutoRetry = retryCount < SKILLS_MAX_AUTO_RETRY

    renderLoadError(el, message, canAutoRetry)

    if (canAutoRetry) {
      await wait(SKILLS_AUTO_RETRY_DELAY_MS)
      if (requestId !== skillsLoadSeq) return
      await loadSkills(page, query, { silent: false, retryCount: retryCount + 1 })
    }
  }
}

function renderSkillItems(items, installedSet) {
  if (!items.length) return '<div class="clawhub-empty">暂无内容</div>'
  return items.map(item => `
    <div class="clawhub-item">
      <div class="clawhub-item-main">
        <div class="clawhub-item-title">${escapeHtml(item.displayName || item.slug)}</div>
        <div class="clawhub-item-meta">${escapeHtml(item.slug)}${item.author ? ` · @${escapeHtml(item.author)}` : ''}${item.downloadsText ? ` · ${escapeHtml(item.downloadsText)}` : ''}</div>
        <div class="clawhub-item-desc">${escapeHtml(item.summary || '暂无摘要，可点击查看详情')}</div>
      </div>
      <div class="clawhub-item-actions">
        <button class="btn btn-secondary btn-sm" data-action="skill-inspect" data-slug="${escapeHtml(item.slug)}">详情</button>
        ${installedSet.has(item.slug)
          ? '<span class="clawhub-badge installed">已安装</span>'
          : `<button class="btn btn-primary btn-sm" data-action="skill-install" data-slug="${escapeHtml(item.slug)}">安装</button>`}
      </div>
    </div>
  `).join('')
}

function renderTrendingCards(items, installedSet) {
  if (!items.length) return '<div class="clawhub-empty">暂无推荐内容</div>'
  return `
    <div class="skills-hero-grid">
      ${items.map(item => `
        <div class="skill-hero-card">
          <div class="skill-hero-top">
            <div>
              <div class="skill-hero-title">${escapeHtml(item.displayName || item.slug)}</div>
              <div class="skill-hero-meta">${escapeHtml(item.slug)}${item.author ? ` · @${escapeHtml(item.author)}` : ''}</div>
            </div>
            <div class="skill-hero-badges">
              ${item.downloadsText ? `<span class="clawhub-badge hot">${escapeHtml(item.downloadsText)}</span>` : ''}
              ${installedSet.has(item.slug) ? '<span class="clawhub-badge installed">已安装</span>' : ''}
            </div>
          </div>
          <div class="skill-hero-desc">${escapeHtml(item.summary || '暂无摘要')}</div>
          <div class="skill-hero-actions">
            <button class="btn btn-secondary btn-sm" data-action="skill-inspect" data-slug="${escapeHtml(item.slug)}">查看详情</button>
            ${installedSet.has(item.slug)
              ? '<span class="skill-hero-installed">已在本地可用</span>'
              : `<button class="btn btn-primary btn-sm" data-action="skill-install" data-slug="${escapeHtml(item.slug)}">一键安装</button>`}
          </div>
        </div>
      `).join('')}
    </div>
  `
}

function renderSkills(el, state) {
  const installed = state.installed || []
  const trending = state.trending || []
  const results = state.results || []
  const installedSet = new Set(installed.map(x => x.slug))

  el.innerHTML = `
    <div class="clawhub-toolbar">
      <input class="input clawhub-search-input" id="skill-search-input" placeholder="搜索 Skill，比如 weather / github / summarize" value="${escapeHtml(state.query || '')}">
      <button class="btn btn-primary btn-sm" data-action="skill-search">搜索</button>
      <button class="btn btn-secondary btn-sm" data-action="skill-refresh">刷新</button>
      <a class="btn btn-secondary btn-sm" href="https://clawhub.ai/skills?sort=downloads" target="_blank" rel="noopener">打开 ClawHub</a>
    </div>

    <div class="clawhub-panel skills-hero-panel">
      <div class="clawhub-panel-title">热门推荐</div>
      <div class="skills-scroll-area skills-trending-scroll">
        ${renderTrendingCards(trending, installedSet)}
      </div>
    </div>

    <div class="clawhub-grid" style="margin-top:var(--space-lg)">
      <div class="clawhub-panel">
        <div class="clawhub-panel-title">已安装 Skills</div>
        <div class="clawhub-list skills-scroll-area skills-installed-scroll">
          ${installed.length ? installed.map(item => `
            <div class="clawhub-item">
              <div>
                <div class="clawhub-item-title">${escapeHtml(item.slug)}</div>
                <div class="clawhub-item-desc">已安装到本地 Skills 目录</div>
              </div>
              <span class="clawhub-badge installed">已安装</span>
            </div>
          `).join('') : '<div class="clawhub-empty">还没有已安装的 Skill</div>'}
        </div>
      </div>
      <div class="clawhub-panel skills-tips-panel">
        <div class="clawhub-panel-title">使用提示</div>
        <div class="skills-tip-list">
          <div class="skills-tip-item"><strong>默认推荐</strong>：首屏展示 ClawHub 热门技能，方便直接浏览</div>
          <div class="skills-tip-item"><strong>搜索</strong>：输入关键词后会调用 ClawHub CLI 实时搜索</div>
          <div class="skills-tip-item"><strong>安装</strong>：安装受外部服务限流影响，失败时可稍后重试</div>
        </div>
      </div>
    </div>

    <div class="clawhub-panel" style="margin-top:var(--space-lg)">
      <div class="clawhub-panel-title">搜索结果</div>
      <div class="clawhub-list skills-scroll-area skills-search-scroll">
        ${state.query ? renderSkillItems(results, installedSet) : '<div class="clawhub-empty">输入关键词开始搜索</div>'}
      </div>
    </div>

    <div id="skill-detail-area"></div>
  `
}

async function handleInspect(page, slug) {
  const detail = page.querySelector('#skill-detail-area')
  if (!detail) return
  detail.innerHTML = '<div class="form-hint" style="margin-top:var(--space-md)">正在加载 Skill 详情...</div>'
  try {
    const data = await api.clawhubInspect(slug)
    const skill = data?.skill || {}
    const owner = data?.owner || {}
    const version = data?.latestVersion || {}
    detail.innerHTML = `
      <div class="clawhub-detail-card">
        <div class="clawhub-detail-title">${escapeHtml(skill.displayName || slug)}</div>
        <div class="clawhub-detail-meta">slug: ${escapeHtml(skill.slug || slug)} · 作者: @${escapeHtml(owner.handle || 'unknown')} · 版本: ${escapeHtml(version.version || 'latest')}</div>
        <div class="clawhub-detail-desc">${escapeHtml(skill.summary || '暂无摘要')}</div>
        <div class="clawhub-detail-stats">
          <span>下载 ${escapeHtml(skill?.stats?.downloads ?? '-')}</span>
          <span>当前安装 ${escapeHtml(skill?.stats?.installsCurrent ?? '-')}</span>
          <span>Star ${escapeHtml(skill?.stats?.stars ?? '-')}</span>
        </div>
      </div>
    `
  } catch (e) {
    detail.innerHTML = `<div style="color:var(--error);margin-top:var(--space-md)">加载详情失败: ${escapeHtml(e.message || e)}</div>`
  }
}

async function handleInstall(page, slug) {
  const btn = page.querySelector(`[data-action="skill-install"][data-slug="${slug}"]`)
  if (btn) {
    btn.disabled = true
    btn.textContent = '安装中...'
  }
  try {
    await api.clawhubInstall(slug)
    toast(`Skill ${slug} 安装成功`, 'success')
  } catch (e) {
    const message = (e?.message || String(e || '')).trim()
    const friendly = message.includes('Rate limit exceeded')
      ? 'ClawHub 当前限流了，稍后再试'
      : `安装失败: ${message || '未知错误'}`
    toast(friendly, 'error')
  }
  const query = page.querySelector('#skill-search-input')?.value?.trim() || ''
  await loadSkills(page, query)
}


function bindEvents(page) {
  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    switch (action) {
      case 'skill-search':
        await loadSkills(page, page.querySelector('#skill-search-input')?.value?.trim() || '')
        break
      case 'skill-refresh':
        await loadSkills(page, page.querySelector('#skill-search-input')?.value?.trim() || '')
        break
      case 'skill-retry':
        await loadSkills(page, page.querySelector('#skill-search-input')?.value?.trim() || '')
        break
      case 'skill-inspect':
        await handleInspect(page, btn.dataset.slug)
        break
      case 'skill-install':
        await handleInstall(page, btn.dataset.slug)
        break
    }
  })

  page.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target?.id === 'skill-search-input') {
      e.preventDefault()
      await loadSkills(page, e.target.value.trim())
    }
  })
}
