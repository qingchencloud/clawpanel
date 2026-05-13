/**
 * Agent 详情页
 * 概览 / 文件 / 渠道 三个 Tab
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showConfirm } from '../components/modal.js'
import { CHANNEL_LABELS } from '../lib/channel-labels.js'
import { t } from '../lib/i18n.js'
import { navigate } from '../router.js'

function esc(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function openChannelsBindingPage(agentId) {
  const params = new URLSearchParams()
  params.set('tab', 'agents')
  params.set('agent', agentId || 'main')
  params.set('action', 'bind')
  navigate(`/channels?${params.toString()}`)
}

export async function render() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  const agentId = params.get('id') || 'main'

  const page = document.createElement('div')
  page.className = 'page agent-detail-page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <a class="agent-back-link" href="#/agents">${t('agentDetail.back')}</a>
        <h1 class="page-title" id="agent-detail-title">Agent: ${esc(agentId)}</h1>
      </div>
    </div>
    <div class="tab-bar" id="agent-tabs">
      <div class="tab active" data-tab="overview">${t('agentDetail.tabOverview')}</div>
      <div class="tab" data-tab="files">${t('agentDetail.tabFiles')}</div>
      <div class="tab" data-tab="channels">${t('agentDetail.tabChannels')}</div>
      <div class="tab" data-tab="tools">${t('agentDetail.tabTools')}</div>
      <div class="tab" data-tab="skills">${t('agentDetail.tabSkills')}</div>
    </div>
    <div class="page-content">
      <div id="agent-tab-content"></div>
    </div>
  `

  const state = { agentId, detail: null, files: null, models: [], skillsCatalog: [] }

  // Tab 切换
  page.querySelector('#agent-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab')
    if (!tab) return
    page.querySelectorAll('#agent-tabs .tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    switchTab(page, state, tab.dataset.tab)
  })

  // 首次加载
  loadDetail(page, state)

  return page
}

async function loadDetail(page, state) {
  const content = page.querySelector('#agent-tab-content')
  content.innerHTML = '<div class="skeleton" style="width:100%;height:200px;border-radius:8px"></div>'
  try {
    const [detail, config, skillsResp] = await Promise.all([
      api.getAgentDetail(state.agentId),
      api.readOpenclawConfig().catch(() => null),
      api.skillsList().catch(() => ({ skills: [] })),
    ])
    state.detail = detail
    // 解析可用模型
    state.models = parseModelList(config)
    state.skillsCatalog = Array.isArray(skillsResp?.skills) ? skillsResp.skills : []
    // 更新标题
    const title = page.querySelector('#agent-detail-title')
    const name = detail.identity?.name || detail.name || detail.id
    const emoji = detail.identity?.emoji || ''
    title.textContent = `${emoji} ${name}`.trim()
    if (detail.isDefault) {
      title.insertAdjacentHTML('beforeend', ` <span class="badge badge-success">${t('agentDetail.defaultAgent')}</span>`)
    }
    switchTab(page, state, 'overview')
  } catch (e) {
    content.innerHTML = `<div style="color:var(--error);padding:20px">${t('agentDetail.loadFailed')}: ${esc(String(e))}</div>`
  }
}

function parseModelList(config) {
  const models = []
  const providers = config?.models?.providers || {}
  for (const [pk, pv] of Object.entries(providers)) {
    for (const m of (pv.models || [])) {
      const id = typeof m === 'string' ? m : m.id
      if (id) models.push(`${pk}/${id}`)
    }
  }
  return models
}

function switchTab(page, state, tab) {
  const content = page.querySelector('#agent-tab-content')
  if (tab === 'overview') renderOverview(content, state)
  else if (tab === 'files') renderFiles(content, state)
  else if (tab === 'channels') renderChannels(content, state)
  else if (tab === 'tools') renderTools(content, state)
  else if (tab === 'skills') renderSkills(content, state)
}

// ==================== 概览 Tab ====================

function renderOverview(container, state) {
  const d = state.detail
  if (!d) { container.innerHTML = ''; return }

  // 解析模型配置
  let primaryModel = ''
  let fallbacks = []
  if (d.model) {
    if (typeof d.model === 'string') {
      primaryModel = d.model
    } else if (typeof d.model === 'object') {
      primaryModel = d.model.primary || ''
      fallbacks = Array.isArray(d.model.fallbacks) ? [...d.model.fallbacks] : []
    }
  }

  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive']

  container.innerHTML = `
    <div class="agent-overview">
      <section class="agent-section">
        <h3 class="agent-section-title">${t('agentDetail.basicInfo')}</h3>
        <div class="agent-form-grid">
          <div class="form-group">
            <label class="form-label">${t('agentDetail.agentId')}</label>
            <input class="form-input" value="${esc(d.id)}" readonly style="opacity:0.6;cursor:not-allowed">
          </div>
          <div class="form-group">
            <label class="form-label">${t('agentDetail.name')}</label>
            <input class="form-input" id="ov-name" value="${esc(d.identity?.name || d.name || '')}" placeholder="${t('agentDetail.notSet')}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('agentDetail.emoji')}</label>
            <input class="form-input" id="ov-emoji" value="${esc(d.identity?.emoji || '')}" placeholder="🤖" style="max-width:80px">
          </div>
          <div class="form-group">
            <label class="form-label">${t('agentDetail.workspace')}</label>
            <input class="form-input" value="${esc(d.workspace || t('agentDetail.notSet'))}" readonly style="opacity:0.6;cursor:not-allowed;font-family:var(--font-mono);font-size:var(--font-size-xs)">
          </div>
        </div>
      </section>

      <section class="agent-section">
        <h3 class="agent-section-title">${t('agentDetail.modelConfig')}</h3>
        <div class="agent-form-grid">
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">${t('agentDetail.primaryModel')}</label>
            ${renderModelSelect('ov-primary-model', primaryModel, state.models)}
          </div>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label class="form-label">${t('agentDetail.fallbackModels')}</label>
          <div id="ov-fallbacks">${renderFallbackList(fallbacks, state.models)}</div>
          <button class="btn btn-sm btn-secondary" id="btn-add-fallback" style="margin-top:8px">${t('agentDetail.addFallback')}</button>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label class="form-label">${t('agentDetail.thinkingLevel')}</label>
          <select class="form-input" id="ov-thinking" style="max-width:200px">
            <option value="">${t('agentDetail.notSet')}</option>
            ${thinkingLevels.map(lv => `<option value="${lv}" ${d.thinkingDefault === lv ? 'selected' : ''}>${t('agentDetail.thinking' + lv.charAt(0).toUpperCase() + lv.slice(1))}</option>`).join('')}
          </select>
        </div>
      </section>

      <div class="agent-save-bar">
        <button class="btn btn-primary" id="btn-save-overview">${t('agentDetail.saveOverview')}</button>
      </div>
    </div>
  `

  // 添加备选模型
  container.querySelector('#btn-add-fallback').addEventListener('click', () => {
    const list = container.querySelector('#ov-fallbacks')
    const idx = list.querySelectorAll('.fallback-row').length
    list.insertAdjacentHTML('beforeend', renderFallbackRow('', state.models, idx))
  })

  // 移除备选模型（事件代理）
  container.querySelector('#ov-fallbacks').addEventListener('click', (e) => {
    if (e.target.closest('.btn-remove-fallback')) {
      e.target.closest('.fallback-row').remove()
    }
  })

  // 保存
  container.querySelector('#btn-save-overview').addEventListener('click', () => saveOverview(container, state))
}

function renderModelSelect(id, selected, models) {
  if (!models.length) {
    return `<input class="form-input" id="${id}" value="${esc(selected)}" placeholder="provider/model">`
  }
  // 如果当前值不在列表中，添加到选项
  const opts = [...models]
  if (selected && !opts.includes(selected)) opts.unshift(selected)
  return `
    <select class="form-input" id="${id}">
      <option value="">${t('agentDetail.notSet')}</option>
      ${opts.map(m => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')}
    </select>
  `
}

function renderFallbackList(fallbacks, models) {
  if (!fallbacks.length) {
    return `<div class="agent-hint">${t('agentDetail.noFallback')}</div>`
  }
  return fallbacks.map((fb, i) => renderFallbackRow(fb, models, i)).join('')
}

function renderFallbackRow(value, models, idx) {
  const opts = [...models]
  if (value && !opts.includes(value)) opts.unshift(value)
  return `
    <div class="fallback-row" style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <select class="form-input fallback-select" style="flex:1">
        <option value="">${t('agentDetail.notSet')}</option>
        ${opts.map(m => `<option value="${esc(m)}" ${m === value ? 'selected' : ''}>${esc(m)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-danger btn-remove-fallback">${t('agentDetail.removeFallback')}</button>
    </div>
  `
}

async function saveOverview(container, state) {
  const btn = container.querySelector('#btn-save-overview')
  btn.disabled = true
  btn.textContent = t('agentDetail.saving')

  try {
    const name = container.querySelector('#ov-name')?.value?.trim() || ''
    const emoji = container.querySelector('#ov-emoji')?.value?.trim() || ''
    const primaryEl = container.querySelector('#ov-primary-model')
    const primary = primaryEl?.value?.trim() || ''
    const thinkingDefault = container.querySelector('#ov-thinking')?.value || ''

    // 收集备选模型
    const fallbacks = []
    container.querySelectorAll('.fallback-select').forEach(sel => {
      const v = sel.value.trim()
      if (v) fallbacks.push(v)
    })

    // 构建模型配置
    let model = primary || undefined
    if (primary && fallbacks.length > 0) {
      model = { primary, fallbacks }
    }

    await api.updateAgentConfig(state.agentId, {
      identity: { name: name || undefined, emoji: emoji || undefined },
      model,
      thinkingDefault: thinkingDefault || undefined,
    })

    // 更新本地缓存
    invalidate('list_agents', 'get_agent_detail')
    state.detail = await api.getAgentDetail(state.agentId)

    toast(t('agentDetail.saveSuccess'), 'success')
  } catch (e) {
    toast(humanizeError(e, t('agentDetail.saveFailed')), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = t('agentDetail.saveOverview')
  }
}

// ==================== 工具 Tab ====================

function renderTools(container, state) {
  const tools = state.detail?.tools || {}
  const profile = tools.profile || ''
  const allow = Array.isArray(tools.allow) ? tools.allow.join(', ') : ''
  const alsoAllow = Array.isArray(tools.alsoAllow) ? tools.alsoAllow.join(', ') : ''
  const deny = Array.isArray(tools.deny) ? tools.deny.join(', ') : ''

  container.innerHTML = `
    <div class="agent-overview">
      <section class="agent-section">
        <h3 class="agent-section-title">${t('agentDetail.toolsTitle')}</h3>
        <p class="agent-section-desc">${t('agentDetail.toolsDesc')}</p>
        <div class="agent-form-grid">
          <div class="form-group">
            <label class="form-label">${t('agentDetail.toolProfile')}</label>
            <select class="form-input" id="tools-profile">
              <option value="">${t('agentDetail.notSet')}</option>
              <option value="minimal" ${profile === 'minimal' ? 'selected' : ''}>minimal</option>
              <option value="coding" ${profile === 'coding' ? 'selected' : ''}>coding</option>
              <option value="messaging" ${profile === 'messaging' ? 'selected' : ''}>messaging</option>
              <option value="full" ${profile === 'full' ? 'selected' : ''}>full</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label class="form-label">${t('agentDetail.toolAllow')}</label>
          <textarea class="form-input agent-multiline-input" id="tools-allow" placeholder="read_file, write_file, exec">${esc(allow)}</textarea>
          <div class="form-hint">${t('agentDetail.toolAllowHint')}</div>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label class="form-label">${t('agentDetail.toolAlsoAllow')}</label>
          <textarea class="form-input agent-multiline-input" id="tools-also-allow" placeholder="grep_search, apply_patch">${esc(alsoAllow)}</textarea>
          <div class="form-hint">${t('agentDetail.toolAlsoAllowHint')}</div>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label class="form-label">${t('agentDetail.toolDeny')}</label>
          <textarea class="form-input agent-multiline-input" id="tools-deny" placeholder="delete_file">${esc(deny)}</textarea>
          <div class="form-hint">${t('agentDetail.toolDenyHint')}</div>
        </div>
      </section>
      <div class="agent-save-bar">
        <button class="btn btn-primary" id="btn-save-tools">${t('agentDetail.saveTools')}</button>
      </div>
    </div>
  `

  container.querySelector('#btn-save-tools').addEventListener('click', () => saveTools(container, state))
}

async function saveTools(container, state) {
  const btn = container.querySelector('#btn-save-tools')
  btn.disabled = true
  btn.textContent = t('agentDetail.saving')
  try {
    const tools = {
      profile: container.querySelector('#tools-profile')?.value || undefined,
      allow: splitCsv(container.querySelector('#tools-allow')?.value),
      alsoAllow: splitCsv(container.querySelector('#tools-also-allow')?.value),
      deny: splitCsv(container.querySelector('#tools-deny')?.value),
    }
    await api.updateAgentConfig(state.agentId, { tools: compactObject(tools) })
    invalidate('get_agent_detail')
    state.detail = await api.getAgentDetail(state.agentId)
    toast(t('agentDetail.toolsSaved'), 'success')
  } catch (e) {
    toast(humanizeError(e, t('agentDetail.saveFailed')), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = t('agentDetail.saveTools')
  }
}

// ==================== 技能 Tab ====================

function renderSkills(container, state) {
  const selected = new Set(Array.isArray(state.detail?.skills) ? state.detail.skills : [])
  const skills = state.skillsCatalog || []

  container.innerHTML = `
    <div class="agent-overview">
      <section class="agent-section">
        <h3 class="agent-section-title">${t('agentDetail.skillsTitle')}</h3>
        <p class="agent-section-desc">${t('agentDetail.skillsDesc')}</p>
        <div class="agent-skills-list">
          ${skills.length ? skills.map(skill => renderSkillCard(skill, selected.has(skill.name))).join('') : `<div class="agent-hint">${t('agentDetail.noSkills')}</div>`}
        </div>
      </section>
      <div class="agent-save-bar">
        <button class="btn btn-primary" id="btn-save-skills">${t('agentDetail.saveSkills')}</button>
      </div>
    </div>
  `

  container.querySelector('#btn-save-skills').addEventListener('click', () => saveSkills(container, state))
}

function renderSkillCard(skill, checked) {
  const emoji = skill.emoji || '🧩'
  const desc = skill.description || ''
  const eligible = skill.eligible !== false
  const disabled = skill.disabled === true
  return `
    <label class="agent-skill-card ${!eligible || disabled ? 'is-muted' : ''}">
      <input type="checkbox" class="agent-skill-checkbox" data-skill-name="${esc(skill.name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <div class="agent-skill-main">
        <div class="agent-skill-head">
          <span class="agent-skill-name">${emoji} ${esc(skill.name)}</span>
          ${disabled ? `<span class="agent-skill-badge">${t('agentDetail.skillDisabled')}</span>` : ''}
          ${!eligible && !disabled ? `<span class="agent-skill-badge">${t('agentDetail.skillUnavailable')}</span>` : ''}
        </div>
        <div class="agent-skill-desc">${esc(desc)}</div>
      </div>
    </label>
  `
}

async function saveSkills(container, state) {
  const btn = container.querySelector('#btn-save-skills')
  btn.disabled = true
  btn.textContent = t('agentDetail.saving')
  try {
    const selected = []
    container.querySelectorAll('.agent-skill-checkbox:checked').forEach((el) => selected.push(el.dataset.skillName))
    await api.updateAgentConfig(state.agentId, { skills: selected })
    invalidate('get_agent_detail')
    state.detail = await api.getAgentDetail(state.agentId)
    toast(t('agentDetail.skillsSaved'), 'success')
  } catch (e) {
    toast(humanizeError(e, t('agentDetail.saveFailed')), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = t('agentDetail.saveSkills')
  }
}

function splitCsv(raw) {
  if (!raw) return undefined
  const values = String(raw)
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
  return values.length ? values : undefined
}

function compactObject(obj) {
  const next = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') next[key] = value
  }
  return Object.keys(next).length ? next : undefined
}

// ==================== 文件 Tab ====================

async function renderFiles(container, state) {
  container.innerHTML = `
    <div class="agent-files-section">
      <h3 class="agent-section-title">${t('agentDetail.filesTitle')}</h3>
      <p class="agent-section-desc">${t('agentDetail.filesDesc')}</p>
      <div id="agent-files-list"><div class="skeleton" style="width:100%;height:120px;border-radius:8px"></div></div>
    </div>
  `
  try {
    const files = await api.listAgentFiles(state.agentId)
    state.files = files
    renderFileList(container, state)
  } catch (e) {
    container.querySelector('#agent-files-list').innerHTML =
      `<div style="color:var(--error)">${t('agentDetail.loadFailed')}: ${esc(String(e))}</div>`
  }
}

function renderFileList(container, state) {
  const list = container.querySelector('#agent-files-list')
  const files = state.files || []
  if (!files.length) {
    list.innerHTML = `<div style="color:var(--text-tertiary)">${t('agentDetail.noFiles')}</div>`
    return
  }

  list.innerHTML = files.map(f => {
    const statusClass = f.exists ? 'file-exists' : 'file-missing'
    const statusText = f.exists ? t('agentDetail.fileExists') : t('agentDetail.fileMissing')
    const sizeText = f.exists ? formatSize(f.size) : '-'
    const timeText = f.exists && f.mtime ? new Date(f.mtime).toLocaleString('zh-CN') : '-'
    const actionBtn = f.exists
      ? `<button class="btn btn-sm btn-secondary" data-action="edit-file" data-name="${esc(f.name)}">${t('agentDetail.fileEdit')}</button>`
      : `<button class="btn btn-sm btn-primary" data-action="create-file" data-name="${esc(f.name)}">${t('agentDetail.fileCreate')}</button>`

    return `
      <div class="agent-file-card">
        <div class="agent-file-header">
          <div class="agent-file-info">
            <span class="agent-file-name">${esc(f.name)}</span>
            <span class="agent-file-status ${statusClass}">${statusText}</span>
          </div>
          <div class="agent-file-actions">${actionBtn}</div>
        </div>
        <div class="agent-file-desc">${esc(f.desc)}</div>
        ${f.exists ? `<div class="agent-file-meta">${t('agentDetail.fileSize')}: ${sizeText} · ${t('agentDetail.fileUpdated')}: ${timeText}</div>` : ''}
      </div>
    `
  }).join('')

  // 事件代理
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const name = btn.dataset.name
    if (btn.dataset.action === 'edit-file') openFileEditor(container, state, name)
    else if (btn.dataset.action === 'create-file') openFileEditor(container, state, name, true)
  })
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

async function openFileEditor(container, state, name, isNew = false) {
  let content = ''
  if (!isNew) {
    try {
      const res = await api.readAgentFile(state.agentId, name)
      content = res.content || ''
    } catch (e) {
      toast(humanizeError(e, t('agentDetail.loadFailed')), 'error')
      return
    }
  }

  // 用弹窗编辑器
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal agent-file-editor-modal">
      <div class="modal-title">${t('agentDetail.editFileTitle', { name })}</div>
      <textarea class="agent-file-editor" id="file-editor-textarea" spellcheck="false">${esc(content)}</textarea>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" data-action="save">${t('agentDetail.saveOverview')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const textarea = overlay.querySelector('#file-editor-textarea')
  textarea.focus()

  // Tab 键支持
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end)
      textarea.selectionStart = textarea.selectionEnd = start + 2
    }
  })

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="save"]').onclick = async () => {
    try {
      await api.writeAgentFile(state.agentId, name, textarea.value)
      toast(isNew ? t('agentDetail.fileCreated') : t('agentDetail.fileSaved'), 'success')
      overlay.remove()
      // 刷新文件列表
      renderFiles(container, state)
    } catch (e) {
      toast(humanizeError(e, t('agentDetail.fileSaveFailed')), 'error')
    }
  }

  // Ctrl+S 快捷保存
  overlay.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      overlay.querySelector('[data-action="save"]').click()
    }
    if (e.key === 'Escape') overlay.remove()
  })
}

// ==================== 渠道 Tab ====================

async function renderChannels(container, state) {
  const bindings = state.detail?.bindings || []

  container.innerHTML = `
    <div class="agent-channels-section">
      <div class="agent-section-header">
        <div>
          <h3 class="agent-section-title">${t('agentDetail.channelsTitle')}</h3>
          <p class="agent-section-desc">${t('agentDetail.channelsDesc')}</p>
        </div>
        <button class="btn btn-sm btn-primary" id="btn-add-binding">${t('agentDetail.manageChannels')}</button>
      </div>
      <div id="agent-bindings-list"></div>
    </div>
  `

  renderBindingsList(container, state, bindings)

  container.querySelector('#btn-add-binding').addEventListener('click', () => {
    openChannelsBindingPage(state.agentId)
  })
}

function renderBindingsList(container, state, bindings) {
  const list = container.querySelector('#agent-bindings-list')
  if (!bindings.length) {
    list.innerHTML = `<div class="agent-hint">${t('agentDetail.noBindings')}</div>`
    return
  }

  list.innerHTML = bindings.map((b, i) => {
    const channel = b.match?.channel || ''
    const label = CHANNEL_LABELS[channel] || channel
    const accountId = b.match?.accountId || ''
    const typeLabel = b.type === 'acp' ? 'ACP' : 'Route'
    return `
      <div class="agent-binding-card">
        <div class="agent-binding-info">
          <span class="agent-binding-channel">${esc(label)}</span>
          ${accountId ? `<span class="agent-binding-account">${esc(accountId)}</span>` : ''}
          <span class="badge" style="background:var(--info-muted);color:var(--info)">${typeLabel}</span>
        </div>
        <button class="btn btn-sm btn-danger" data-action="remove-binding" data-channel="${esc(channel)}" data-account="${esc(accountId)}" data-index="${i}">${t('agentDetail.removeBinding')}</button>
      </div>
    `
  }).join('')

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="remove-binding"]')
    if (!btn) return
    const channel = btn.dataset.channel
    const account = btn.dataset.account || null
    const binding = bindings[Number(btn.dataset.index)]
    const yes = await showConfirm({
      title: t('agentDetail.removeBindingTitle'),
      message: t('agentDetail.removeBindingConfirm', { channel: CHANNEL_LABELS[channel] || channel }),
      impact: [
        t('agentDetail.removeBindingImpactAgent'),
        t('agentDetail.removeBindingImpactChannel'),
      ],
      confirmText: t('agentDetail.removeBindingBtn'),
      cancelText: t('agentDetail.removeBindingCancel'),
    })
    if (!yes) return
    try {
      await api.deleteAgentBinding(state.agentId, channel, account, binding?.match || null)
      toast(t('agentDetail.bindingRemoved'), 'success')
      invalidate('get_agent_detail')
      state.detail = await api.getAgentDetail(state.agentId)
      renderBindingsList(container, state, state.detail.bindings || [])
    } catch (e) {
      toast(humanizeError(e, t('agentDetail.bindingFailed')), 'error')
    }
  })
}
