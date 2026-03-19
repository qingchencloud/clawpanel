/**
 * Skills 页面
 * 基于 openclaw skills CLI，按状态分组展示所有 Skills
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { invalidateSkillsCatalog, getCachedSkillsCatalog, loadSkillsCatalog } from '../lib/skills-catalog.js'

let _loadSeq = 0

function esc(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Skills</h1>
      <p class="page-desc">管理已安装的 Skills，或从社区搜索安装新技能</p>
    </div>
    <div class="tab-bar" id="skills-main-tabs">
      <div class="tab active" data-main-tab="installed">已安装</div>
      <div class="tab" data-main-tab="store">搜索安装</div>
    </div>
    <div id="skills-tab-installed" class="config-section">
      <div class="stat-card loading-placeholder" style="height:96px"></div>
    </div>
    <div id="skills-tab-store" class="config-section" style="display:none">
      <div class="clawhub-toolbar" style="margin-bottom:var(--space-sm)">
        <select class="form-input" id="install-source-select" style="width:auto;min-width:160px">
          <option value="skillhub">SkillHub（国内加速）</option>
          <option value="clawhub">ClawHub（原版海外）</option>
        </select>
        <input class="input clawhub-search-input" id="skill-install-search" placeholder="搜索技能，如 weather / github / tavily" type="text" style="flex:1">
        <button class="btn btn-primary btn-sm" data-action="install-source-search">搜索</button>
        <button class="btn btn-secondary btn-sm" data-action="skillhub-setup" id="btn-skillhub-setup" style="display:none">安装 CLI</button>
        <a class="btn btn-secondary btn-sm" id="btn-browse-source" href="https://skillhub.tencent.com" target="_blank" rel="noopener">浏览</a>
      </div>
      <div class="form-hint" id="store-hint" style="margin-bottom:var(--space-sm);display:flex;align-items:center;gap:var(--space-xs)">
        <span id="skillhub-status"></span>
      </div>
      <div id="install-source-results" class="clawhub-list" style="max-height:calc(100vh - 320px);overflow-y:auto">
        <div class="clawhub-empty" style="padding:var(--space-xl);text-align:center">输入关键词搜索社区 Skills，然后一键安装</div>
      </div>
    </div>
  `
  bindEvents(page)
  loadSkills(page)
  return page
}

async function loadSkills(page, options = {}) {
  const el = page.querySelector('#skills-tab-installed')
  if (!el) return
  const seq = ++_loadSeq
  const force = !!options.force
  const cached = !force ? getCachedSkillsCatalog() : null

  if (cached) {
    renderSkills(el, cached)
  } else {
    el.innerHTML = `<div class="skills-loading-panel">
      <div class="stat-card loading-placeholder" style="height:96px"></div>
      <div class="form-hint" style="margin-top:8px">正在加载 Skills...</div>
    </div>`
  }

  try {
    const data = await loadSkillsCatalog({ force })
    if (seq !== _loadSeq) return
    renderSkills(el, data)
  } catch (e) {
    if (seq !== _loadSeq) return
    if (cached) return
    el.innerHTML = `<div class="skills-load-error">
      <div style="color:var(--error);margin-bottom:8px">加载失败: ${esc(e?.message || e)}</div>
      <div class="form-hint" style="margin-bottom:10px">请确认 OpenClaw 已安装并可用</div>
      <button class="btn btn-secondary btn-sm" data-action="skill-retry">重试</button>
    </div>`
  }
}

function renderSkills(el, data) {
  const skills = data?.skills || []
  const cliAvailable = data?.cliAvailable !== false
  const eligible = skills.filter(s => s.eligible && !s.disabled)
  const missing = skills.filter(s => !s.eligible && !s.disabled && !s.blockedByAllowlist)
  const disabled = skills.filter(s => s.disabled)
  const blocked = skills.filter(s => s.blockedByAllowlist && !s.disabled)

  const summary = `${eligible.length} 可用 / ${missing.length} 缺依赖 / ${disabled.length} 已禁用 / ${blocked.length} 已阻止`

  el.innerHTML = `
    <div class="clawhub-toolbar">
      <input class="input clawhub-search-input" id="skill-filter-input" placeholder="过滤 Skills..." type="text">
      <button class="btn btn-secondary btn-sm" data-action="skill-retry">刷新</button>
      <a class="btn btn-secondary btn-sm" href="https://clawhub.ai/skills" target="_blank" rel="noopener">ClawHub</a>
      ${!cliAvailable ? '<span class="form-hint" style="margin-left:auto;color:var(--warning)">CLI 不可用，仅显示本地扫描结果</span>' : ''}
    </div>

    <div class="stat-cards" style="margin-bottom:var(--space-md)">
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Skills 总数</span></div>
        <div class="stat-card-value">${skills.length}</div>
        <div class="stat-card-meta">已扫描本地可见技能</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">可直接使用</span></div>
        <div class="stat-card-value">${eligible.length}</div>
        <div class="stat-card-meta">环境与依赖已满足</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">待处理</span></div>
        <div class="stat-card-value">${missing.length + blocked.length}</div>
        <div class="stat-card-meta">${missing.length} 缺依赖 · ${blocked.length} 已阻止</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">不可用</span></div>
        <div class="stat-card-value">${disabled.length}</div>
        <div class="stat-card-meta">当前已禁用</div>
      </div>
    </div>

    <div class="skills-summary" style="margin-bottom:var(--space-lg);color:var(--text-secondary);font-size:var(--font-size-sm)">
      共 ${skills.length} 个 Skills: ${summary}
    </div>

    <div class="clawhub-empty" id="skill-filter-empty" style="display:none;margin-bottom:var(--space-lg);text-align:center;padding:var(--space-lg)">
      当前过滤条件下没有匹配的 Skills
    </div>

    ${eligible.length ? `
    <div class="clawhub-panel" style="margin-bottom:var(--space-lg)">
      <div class="clawhub-panel-title" style="color:var(--success)">✓ 可用 (${eligible.length})</div>
      <div class="clawhub-list skills-scroll-area skills-trending-scroll" id="skills-eligible">
        ${eligible.map(s => renderSkillCard(s, 'eligible')).join('')}
      </div>
    </div>` : ''}

    ${missing.length ? `
    <div class="clawhub-panel" style="margin-bottom:var(--space-lg)">
      <div class="clawhub-panel-title" style="color:var(--warning);display:flex;align-items:center;gap:var(--space-sm)">
        <span>✗ 缺少依赖 (${missing.length})</span>
        <button class="btn btn-secondary btn-sm" data-action="skill-ai-fix" style="font-size:var(--font-size-xs);padding:2px 8px">让 AI 助手帮我安装</button>
      </div>
      <div class="clawhub-list skills-scroll-area skills-installed-scroll" id="skills-missing">
        ${missing.map(s => renderSkillCard(s, 'missing')).join('')}
      </div>
    </div>` : ''}

    ${disabled.length ? `
    <div class="clawhub-panel" style="margin-bottom:var(--space-lg)">
      <div class="clawhub-panel-title" style="color:var(--text-tertiary)">⏸ 已禁用 (${disabled.length})</div>
      <div class="clawhub-list skills-scroll-area skills-search-scroll" id="skills-disabled">
        ${disabled.map(s => renderSkillCard(s, 'disabled')).join('')}
      </div>
    </div>` : ''}

    ${blocked.length ? `
    <div class="clawhub-panel" style="margin-bottom:var(--space-lg)">
      <div class="clawhub-panel-title" style="color:var(--text-tertiary)">🚫 白名单阻止 (${blocked.length})</div>
      <div class="clawhub-list">
        ${blocked.map(s => renderSkillCard(s, 'blocked')).join('')}
      </div>
    </div>` : ''}

    ${!skills.length ? `
    <div class="clawhub-panel">
      <div class="clawhub-empty" style="text-align:center;padding:var(--space-xl)">
        <div style="margin-bottom:var(--space-sm)">未检测到任何 Skills</div>
        <div class="form-hint">请确认 OpenClaw 已正确安装。Skills 随 OpenClaw 捆绑提供，也可自定义放置在 <code>~/.openclaw/skills/</code> 目录下。</div>
      </div>
    </div>` : ''}

    <div id="skill-detail-area"></div>
  `

  // 实时过滤
  const input = el.querySelector('#skill-filter-input')
  const emptyEl = el.querySelector('#skill-filter-empty')
  if (input) {
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase()
      let visibleCount = 0
      el.querySelectorAll('.skill-card-item').forEach(card => {
        const name = (card.dataset.name || '').toLowerCase()
        const desc = (card.dataset.desc || '').toLowerCase()
        const visible = !q || name.includes(q) || desc.includes(q)
        card.style.display = visible ? '' : 'none'
        if (visible) visibleCount += 1
      })
      if (emptyEl) emptyEl.style.display = q && visibleCount === 0 ? '' : 'none'
    })
  }
}

function renderSkillCard(skill, status) {
  const emoji = skill.emoji || '📦'
  const name = skill.name || ''
  const desc = skill.description || ''
  const source = skill.bundled ? '捆绑' : (skill.source || '自定义')
  const missingBins = skill.missing?.bins || []
  const missingEnv = skill.missing?.env || []
  const missingConfig = skill.missing?.config || []
  const installOpts = skill.install || []

  let statusBadge = ''
  if (status === 'eligible') statusBadge = '<span class="clawhub-badge installed">可用</span>'
  else if (status === 'missing') statusBadge = '<span class="clawhub-badge" style="background:rgba(245,158,11,0.14);color:#d97706">缺依赖</span>'
  else if (status === 'disabled') statusBadge = '<span class="clawhub-badge" style="background:rgba(107,114,128,0.14);color:#6b7280">已禁用</span>'
  else if (status === 'blocked') statusBadge = '<span class="clawhub-badge" style="background:rgba(239,68,68,0.14);color:#ef4444">已阻止</span>'

  let missingHtml = ''
  if (missingBins.length) missingHtml += `<div class="form-hint" style="margin-top:4px">缺少命令: ${missingBins.map(b => `<code>${esc(b)}</code>`).join(', ')}</div>`
  if (missingEnv.length) missingHtml += `<div class="form-hint" style="margin-top:4px">缺少环境变量: ${missingEnv.map(e => `<code>${esc(e)}</code>`).join(', ')} <span style="color:var(--text-tertiary);font-size:var(--font-size-xs)">— 需在系统环境变量中配置</span></div>`
  if (missingConfig.length) missingHtml += `<div class="form-hint" style="margin-top:4px">缺少配置: ${missingConfig.map(c => `<code>${esc(c)}</code>`).join(', ')} <span style="color:var(--text-tertiary);font-size:var(--font-size-xs)">— 需在 openclaw.json 中配置</span></div>`

  let installHtml = ''
  if (status === 'missing') {
    if (installOpts.length) {
      installHtml = `<div style="margin-top:6px">${installOpts.map(opt =>
        `<button class="btn btn-primary btn-sm" style="margin-right:6px;margin-top:4px" data-action="skill-install-dep" data-kind="${esc(opt.kind)}" data-install='${esc(JSON.stringify(opt))}' data-skill-name="${esc(name)}">${esc(opt.label)}</button>`
      ).join('')}</div>`
    } else if (missingBins.length && !missingEnv.length && !missingConfig.length) {
      installHtml = `<div class="form-hint" style="margin-top:6px;color:var(--text-tertiary);font-size:var(--font-size-xs)">无自动安装选项，请手动安装: ${missingBins.map(b => `<code>brew install ${esc(b)}</code> 或 <code>npm i -g ${esc(b)}</code>`).join(' / ')}</div>`
    }
  }

  return `
    <div class="clawhub-item skill-card-item" data-name="${esc(name)}" data-desc="${esc(desc)}">
      <div class="clawhub-item-main">
        <div class="clawhub-item-title">${emoji} ${esc(name)}</div>
        <div class="clawhub-item-meta">${esc(source)}${skill.homepage ? ` · <a href="${esc(skill.homepage)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(skill.homepage)}</a>` : ''}</div>
        <div class="clawhub-item-desc">${esc(desc)}</div>
        ${missingHtml}
        ${installHtml}
      </div>
      <div class="clawhub-item-actions">
        <button class="btn btn-secondary btn-sm" data-action="skill-info" data-name="${esc(name)}">详情</button>
        ${!skill.bundled ? `<button class="btn btn-sm" style="color:var(--error);border:1px solid var(--error);background:transparent;font-size:var(--font-size-xs)" data-action="skill-uninstall" data-name="${esc(name)}">卸载</button>` : ''}
        ${statusBadge}
      </div>
    </div>
  `
}

async function handleInfo(page, name) {
  const detail = page.querySelector('#skill-detail-area')
  if (!detail) return
  detail.innerHTML = '<div class="form-hint" style="margin-top:var(--space-md)">正在加载详情...</div>'
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  try {
    const skill = await api.skillsInfo(name)
    const s = skill || {}
    const reqs = s.requirements || {}
    const miss = s.missing || {}

    let reqsHtml = ''
    if (reqs.bins?.length) {
      reqsHtml += `<div style="margin-top:8px"><strong>需要命令:</strong> ${reqs.bins.map(b => {
        const ok = !(miss.bins || []).includes(b)
        return `<code style="color:var(--${ok ? 'success' : 'error'})">${ok ? '✓' : '✗'} ${esc(b)}</code>`
      }).join(' ')}</div>`
    }
    if (reqs.env?.length) {
      reqsHtml += `<div style="margin-top:4px"><strong>环境变量:</strong> ${reqs.env.map(e => {
        const ok = !(miss.env || []).includes(e)
        return `<code style="color:var(--${ok ? 'success' : 'error'})">${ok ? '✓' : '✗'} ${esc(e)}</code>`
      }).join(' ')}</div>`
    }

    detail.innerHTML = `
      <div class="clawhub-detail-card">
        <div class="clawhub-detail-title">${esc(s.emoji || '📦')} ${esc(s.name || name)}</div>
        <div class="clawhub-detail-meta">
          来源: ${esc(s.source || '')} · 路径: <code>${esc(s.filePath || '')}</code>
          ${s.homepage ? ` · <a href="${esc(s.homepage)}" target="_blank" rel="noopener">${esc(s.homepage)}</a>` : ''}
        </div>
        <div class="clawhub-detail-desc" style="margin-top:8px">${esc(s.description || '')}</div>
        ${reqsHtml}
        ${(s.install || []).length && !s.eligible ? `<div style="margin-top:8px"><strong>安装选项:</strong> ${s.install.map(i => `<span class="form-hint">→ ${esc(i.label)}</span>`).join(' ')}</div>` : ''}
      </div>
    `
  } catch (e) {
    detail.innerHTML = `<div style="color:var(--error);margin-top:var(--space-md)">加载详情失败: ${esc(e?.message || e)}</div>`
  }
}

async function handleInstallDep(page, btn) {
  const kind = btn.dataset.kind
  let spec
  try { spec = JSON.parse(btn.dataset.install) } catch { spec = {} }
  const skillName = btn.dataset.skillName || ''
  btn.disabled = true
  btn.textContent = '安装中...'
  try {
    await api.skillsInstallDep(kind, spec)
    toast(`${skillName} 依赖安装成功`, 'success')
    await loadSkills(page)
  } catch (e) {
    toast(`安装失败: ${e?.message || e}`, 'error')
    btn.disabled = false
    btn.textContent = spec.label || '重试'
  }
}

// ===== 统一源搜索/安装系统 =====
let _installSource = 'skillhub' // 当前选中的安装源
let _skillhubInstalled = false // SkillHub CLI 是否已安装

function getInstallSource() { return _installSource }

async function handleSourceSearch(page) {
  const input = page.querySelector('#skill-install-search')
  const results = page.querySelector('#install-source-results')
  if (!input || !results) return
  const q = input.value.trim()
  if (!q) { results.innerHTML = '<div class="clawhub-empty">输入关键词搜索社区 Skills</div>'; return }
  const source = getInstallSource()
  // SkillHub 未安装时友好提示
  if (source === 'skillhub' && !_skillhubInstalled) {
    results.innerHTML = `<div style="padding:var(--space-lg);text-align:center">
      <div style="color:var(--warning);margin-bottom:8px">⚠️ 请先安装 SkillHub CLI</div>
      <div class="form-hint" style="margin-bottom:12px">点击上方「安装 CLI」按钮，或切换到 ClawHub 源搜索</div>
      <button class="btn btn-primary btn-sm" data-action="skillhub-setup">一键安装 SkillHub CLI</button>
    </div>`
    return
  }
  results.innerHTML = '<div class="form-hint">正在搜索...</div>'
  try {
    const items = source === 'skillhub' ? await api.skillsSkillHubSearch(q) : await api.skillsClawHubSearch(q)
    if (!items?.length) { results.innerHTML = '<div class="clawhub-empty">没有找到匹配的 Skill</div>'; return }
    const installAction = source === 'skillhub' ? 'source-install-skillhub' : 'source-install-clawhub'
    results.innerHTML = items.map(item => `
      <div class="clawhub-item">
        <div class="clawhub-item-main">
          <div class="clawhub-item-title">${esc(item.slug || item.name || '')}</div>
          <div class="clawhub-item-desc">${esc(item.description || item.summary || '')}</div>
        </div>
        <div class="clawhub-item-actions">
          <button class="btn btn-primary btn-sm" data-action="${installAction}" data-slug="${esc(item.slug || item.name || '')}">安装</button>
        </div>
      </div>
    `).join('')
  } catch (e) {
    const errMsg = String(e?.message || e)
    const isRateLimit = /rate.?limit|429|too many/i.test(errMsg)
    if (isRateLimit) {
      results.innerHTML = `<div style="padding:var(--space-lg);text-align:center">
        <div style="color:var(--warning);margin-bottom:8px">⚠️ 请求频率超限</div>
        <div class="form-hint">${source === 'clawhub' ? 'ClawHub 海外源限流，建议切换到 SkillHub（国内加速）' : '请稍后再试'}</div>
      </div>`
    } else {
      results.innerHTML = `<div style="color:var(--error);padding:var(--space-sm)">搜索失败: ${esc(errMsg)}</div>`
    }
  }
}

async function handleSourceInstall(page, btn, source) {
  const slug = btn.dataset.slug
  btn.disabled = true
  btn.textContent = '安装中...'
  try {
    if (source === 'skillhub') await api.skillsSkillHubInstall(slug)
    else await api.skillsClawHubInstall(slug)
    toast(`Skill ${slug} 安装成功`, 'success')
    btn.textContent = '已安装'
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-secondary')
    // 后台刷新已安装列表（不阻塞 UI）
    loadSkills(page).catch(() => {})
  } catch (e) {
    toast(`安装失败: ${e?.message || e}`, 'error')
    btn.disabled = false
    btn.textContent = '安装'
  }
}

async function handleSkillUninstall(page, btn) {
  const name = btn.dataset.name
  if (!name) return
  if (!confirm(`确定卸载 Skill「${name}」？`)) return
  btn.disabled = true
  btn.textContent = '卸载中...'
  try {
    await api.skillsUninstall(name)
    toast(`已卸载 ${name}`, 'success')
    await loadSkills(page)
  } catch (e) {
    toast(`卸载失败: ${e?.message || e}`, 'error')
    btn.disabled = false
    btn.textContent = '卸载'
  }
}

async function handleSkillHubSetup(page) {
  const statusEl = page.querySelector('#skillhub-status')
  if (statusEl) statusEl.textContent = '正在安装 SkillHub CLI...'
  try {
    await api.skillsSkillHubSetup(true)
    toast('SkillHub CLI 安装成功', 'success')
    if (statusEl) statusEl.textContent = '✅ 已安装'
    // 隐藏安装按钮
    const setupBtn = page.querySelector('#btn-skillhub-setup')
    if (setupBtn) setupBtn.style.display = 'none'
  } catch (e) {
    toast(`SkillHub CLI 安装失败: ${e?.message || e}`, 'error')
    if (statusEl) statusEl.textContent = '❌ 安装失败'
  }
}

async function checkSkillHubStatus(page) {
  const statusEl = page.querySelector('#skillhub-status')
  const setupBtn = page.querySelector('#btn-skillhub-setup')
  if (!statusEl) return
  try {
    const info = await api.skillsSkillHubCheck()
    _skillhubInstalled = !!info.installed
    if (info.installed) {
      statusEl.innerHTML = `<span style="color:var(--success)">✅ v${info.version}</span>`
      if (setupBtn) setupBtn.style.display = 'none'
    } else {
      statusEl.innerHTML = '<span style="color:var(--warning)">⚠️ 未安装 CLI</span>'
      if (setupBtn && _installSource === 'skillhub') setupBtn.style.display = ''
    }
  } catch {
    statusEl.textContent = ''
  }
}

function switchInstallSource(page, source) {
  _installSource = source
  const results = page.querySelector('#install-source-results')
  const setupBtn = page.querySelector('#btn-skillhub-setup')
  const browseBtn = page.querySelector('#btn-browse-source')
  if (results) results.innerHTML = '<div class="clawhub-empty">输入关键词搜索社区 Skills</div>'
  if (source === 'skillhub') {
    if (browseBtn) browseBtn.href = 'https://skillhub.tencent.com'
    checkSkillHubStatus(page)
  } else {
    if (setupBtn) setupBtn.style.display = 'none'
    if (browseBtn) browseBtn.href = 'https://clawhub.ai/skills'
  }
}

function bindEvents(page) {
  // 主 Tab 切换（已安装 / 搜索安装）
  page.querySelectorAll('#skills-main-tabs .tab').forEach(tab => {
    tab.onclick = () => {
      page.querySelectorAll('#skills-main-tabs .tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const key = tab.dataset.mainTab
      page.querySelector('#skills-tab-installed').style.display = key === 'installed' ? '' : 'none'
      page.querySelector('#skills-tab-store').style.display = key === 'store' ? '' : 'none'
      // 切到商店 tab 时检测 SkillHub 状态
      if (key === 'store') checkSkillHubStatus(page)
    }
  })

  // 安装源下拉切换
  const sourceSelect = page.querySelector('#install-source-select')
  if (sourceSelect) {
    sourceSelect.onchange = () => switchInstallSource(page, sourceSelect.value)
  }

  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    switch (btn.dataset.action) {
      case 'skill-retry':
        invalidateSkillsCatalog()
        await loadSkills(page, { force: true })
        break
      case 'skill-info':
        await handleInfo(page, btn.dataset.name)
        break
      case 'skill-install-dep':
        await handleInstallDep(page, btn)
        break
      case 'install-source-search':
        await handleSourceSearch(page)
        break
      case 'source-install-skillhub':
        await handleSourceInstall(page, btn, 'skillhub')
        break
      case 'source-install-clawhub':
        await handleSourceInstall(page, btn, 'clawhub')
        break
      case 'skillhub-setup':
        await handleSkillHubSetup(page)
        break
      case 'skill-uninstall':
        await handleSkillUninstall(page, btn)
        break
      case 'skill-ai-fix':
        window.location.hash = '#/assistant'
        setTimeout(() => {
          const skillBtn = document.querySelector('.ast-skill-card[data-skill="skills-manager"]')
          if (skillBtn) skillBtn.click()
        }, 500)
        break
    }
  })

  page.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target?.id === 'skill-install-search') {
      e.preventDefault()
      await handleSourceSearch(page)
    }
  })
}
