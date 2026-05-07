/**
 * Agent 管理页面
 * Agent 增删改查 + 身份编辑
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'
import { CHANNEL_LABELS } from '../lib/channel-labels.js'
import { t } from '../lib/i18n.js'
import { listAgentsCompat } from '../lib/api-compat.js'
import { hasFeature } from '../lib/kernel.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${t('agents.title')}</h1>
        <p class="page-desc">${t('agents.desc')}</p>
        <p class="page-subhint">${t('agents.detailHint')}</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-add-agent">${t('agents.addAgent')}</button>
      </div>
    </div>
    <div class="page-content">
      <div id="agents-list"></div>
    </div>
  `

  const state = { agents: [], bindings: [] }
  // 非阻塞：先返回 DOM，后台加载数据
  loadAgents(page, state)

  page.querySelector('#btn-add-agent').addEventListener('click', () => showAddAgentDialog(page, state))

  return page
}

function renderSkeleton(container) {
  const item = () => `
    <div class="agent-card" style="pointer-events:none">
      <div class="agent-card-header">
        <div class="skeleton" style="width:40px;height:40px;border-radius:50%"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px">
          <div class="skeleton" style="width:45%;height:16px;border-radius:4px"></div>
          <div class="skeleton" style="width:60%;height:12px;border-radius:4px"></div>
        </div>
      </div>
    </div>`
  container.innerHTML = [item(), item(), item()].join('')
}

async function loadAgents(page, state) {
  const container = page.querySelector('#agents-list')
  renderSkeleton(container)
  try {
    const [agents, config] = await Promise.all([
      listAgentsCompat(),
      api.readOpenclawConfig().catch(() => null),
    ])
    state.agents = agents
    state.bindings = Array.isArray(config?.bindings) ? config.bindings : []
    renderAgents(page, state)

    // 只在第一次加载时绑定事件（避免重复绑定）
    if (!state.eventsAttached) {
      attachAgentEvents(page, state)
      state.eventsAttached = true
    }
  } catch (e) {
    container.innerHTML = '<div style="color:var(--error);padding:20px">' + t('agents.loadFailed') + ': ' + String(e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>'
    toast(t('agents.loadListFailed') + ': ' + e, 'error')
  }
}

/** 为指定 agent 生成绑定渠道的 badge HTML */
function renderBindingBadges(agentId, bindings) {
  const matched = (bindings || []).filter(b => (b.agentId || 'main') === agentId)
  if (!matched.length) {
    return `<span style="color:var(--text-tertiary)">${t('agents.noBinding')}</span>`
  }
  return matched.map(b => {
    const channel = b.match?.channel || ''
    const label = CHANNEL_LABELS[channel] || channel
    const accountId = b.match?.accountId
    const text = accountId ? `${label} · ${accountId}` : label
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    return `<span style="font-size:var(--font-size-xs);color:var(--accent);background:var(--accent-muted);padding:1px 6px;border-radius:10px;white-space:nowrap">${escaped}</span>`
  }).join(' ')
}

/**
 * 渲染 Agent Runtime 徽章。
 *
 * 上游 2026.5.2+ 会在 agents.list 返回 agentRuntime 元数据：
 *   - { id: 'pi' }     → 默认 Pi runtime（最常用，蓝色徽章）
 *   - { id: 'codex' }  → OpenAI Codex CLI runtime（紫色徽章）
 *   - { id: '其他' }   → 显示原始 id（灰色徽章）
 *
 * 老内核不会调用本函数（被 hasFeature('agents.runtime') 门控）。
 */
function _renderRuntimeBadge(runtime) {
  const id = (runtime && typeof runtime === 'object' ? runtime.id : runtime) || 'pi'
  const map = {
    pi: { label: 'Pi', cls: 'badge-info' },
    codex: { label: 'Codex CLI', cls: 'badge-purple' },
  }
  const meta = map[id] || { label: id, cls: 'badge-neutral' }
  return `<span class="badge ${meta.cls}" title="agentRuntime.id = ${id}">${meta.label}</span>`
}

function renderAgents(page, state) {
  const container = page.querySelector('#agents-list')
  if (!state.agents.length) {
    container.innerHTML = `<div style="color:var(--text-tertiary);padding:20px;text-align:center">${t('agents.noAgents')}</div>`
    return
  }

  container.innerHTML = state.agents.map(a => {
    const isDefault = a.isDefault || a.id === 'main'
    const name = a.identityName ? a.identityName.split(',')[0].trim() : t('agents.noDesc')
    return `
      <div class="agent-card" data-id="${a.id}">
        <div class="agent-card-header">
          <div class="agent-card-title">
            <span class="agent-id">${a.id}</span>
            ${isDefault ? `<span class="badge badge-success">${t('agents.default')}</span>` : ''}
          </div>
          <div class="agent-card-actions">
            <button class="btn btn-sm btn-primary" data-action="detail" data-id="${a.id}">${t('agents.detail')}</button>
            <button class="btn btn-sm btn-secondary" data-action="backup" data-id="${a.id}">${t('agents.backup')}</button>
            <button class="btn btn-sm btn-secondary" data-action="edit" data-id="${a.id}">${t('agents.edit')}</button>
            ${!isDefault ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${a.id}">${t('agents.delete')}</button>` : ''}
          </div>
        </div>
        <div class="agent-card-body">
          <div class="agent-info-row">
            <span class="agent-info-label">${t('agents.labelName')}</span>
            <span class="agent-info-value">${name}</span>
          </div>
          <div class="agent-info-row">
            <span class="agent-info-label">${t('agents.labelModel')}</span>
            <span class="agent-info-value">${typeof a.model === 'object' ? (a.model?.primary || a.model?.id || JSON.stringify(a.model)) : (a.model || t('agents.notSet'))}</span>
          </div>
          <div class="agent-info-row">
            <span class="agent-info-label">${t('agents.labelWorkspace')}</span>
            <span class="agent-info-value" style="font-family:var(--font-mono);font-size:var(--font-size-xs)">${a.workspace || t('agents.notSet')}</span>
          </div>
          ${hasFeature('agents.runtime') ? `
          <div class="agent-info-row">
            <span class="agent-info-label">${t('agents.labelRuntime')}</span>
            <span class="agent-info-value">${_renderRuntimeBadge(a.agentRuntime)}</span>
          </div>` : ''}
          <div class="agent-info-row">
            <span class="agent-info-label">${t('agents.labelBindings')}</span>
            <span class="agent-info-value">${renderBindingBadges(a.id, state.bindings)}</span>
          </div>
        </div>
      </div>
    `
  }).join('')
}

function attachAgentEvents(page, state) {
  const container = page.querySelector('#agents-list')
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (btn) {
      const action = btn.dataset.action
      const id = btn.dataset.id
      if (action === 'detail') location.hash = `#/agent-detail?id=${encodeURIComponent(id)}`
      else if (action === 'edit') showEditAgentDialog(page, state, id)
      else if (action === 'delete') await deleteAgent(page, state, id)
      else if (action === 'backup') await backupAgent(id)
      return
    }
    // 点击卡片空白区域 → 进入详情页
    const card = e.target.closest('.agent-card')
    if (card) {
      const id = card.dataset.id
      if (id) location.hash = `#/agent-detail?id=${encodeURIComponent(id)}`
    }
  })
}

async function showAddAgentDialog(page, state) {
  // 获取模型列表
  let models = []
  try {
    const config = await api.readOpenclawConfig()
    const providers = config?.models?.providers || {}
    for (const [pk, pv] of Object.entries(providers)) {
      for (const m of (pv.models || [])) {
        const id = typeof m === 'string' ? m : m.id
        if (id) models.push({ value: `${pk}/${id}`, label: `${pk}/${id}` })
      }
    }
  } catch { models = [{ value: 'newapi/claude-opus-4-6', label: 'newapi/claude-opus-4-6' }] }

  if (!models.length) {
    toast(t('agents.addModelsFirst'), 'warning')
    return
  }

  showModal({
    title: t('agents.addTitle'),
    fields: [
      { name: 'id', label: t('agents.agentId'), value: '', placeholder: t('agents.agentIdPlaceholder') },
      { name: 'name', label: t('agents.agentName'), value: '', placeholder: t('agents.agentNamePlaceholder') },
      { name: 'emoji', label: t('agents.agentEmoji'), value: '', placeholder: t('agents.agentEmojiPlaceholder') },
      { name: 'model', label: t('agents.agentModel'), type: 'select', value: models[0]?.value || '', options: models },
      { name: 'workspace', label: t('agents.agentWorkspace'), value: '', placeholder: t('agents.agentWorkspacePlaceholder') },
    ],
    onConfirm: async (result) => {
      const id = (result.id || '').trim()
      if (!id) { toast(t('agents.idRequired'), 'warning'); return }
      if (!/^[a-z0-9_-]+$/.test(id)) { toast(t('agents.idInvalid'), 'warning'); return }

      const name = (result.name || '').trim()
      const emoji = (result.emoji || '').trim()
      const model = result.model || models[0]?.value || ''
      const workspace = (result.workspace || '').trim()

      try {
        await api.addAgent(id, model, workspace || null)
        // 身份信息更新（非关键，失败不阻塞）
        if (name || emoji) {
          try {
            await api.updateAgentIdentity(id, name || null, emoji || null)
          } catch (identityErr) {
            console.warn('[Agent] 身份信息更新失败（Agent 已创建）:', identityErr)
            toast(t('agents.createdNameFailed'), 'warning')
          }
        }
        toast(t('agents.created'), 'success')

        // 强制清除缓存并重新加载
        invalidate('list_agents')
        await loadAgents(page, state)
      } catch (e) {
        toast(t('agents.createFailed') + ': ' + e, 'error')
      }
    }
  })
}

async function showEditAgentDialog(page, state, id) {
  const agent = state.agents.find(a => a.id === id)
  if (!agent) return

  const name = agent.identityName ? agent.identityName.split(',')[0].trim() : ''

  // 获取模型列表
  let models = []
  try {
    const config = await api.readOpenclawConfig()
    const providers = config?.models?.providers || {}
    for (const [pk, pv] of Object.entries(providers)) {
      for (const m of (pv.models || [])) {
        const mid = typeof m === 'string' ? m : m.id
        if (mid) models.push({ value: `${pk}/${mid}`, label: `${pk}/${mid}` })
      }
    }
    console.log('[Agent编辑] 获取到模型列表:', models.length, '个')
  } catch (e) {
    console.error('[Agent编辑] 获取模型列表失败:', e)
  }

  const fields = [
    { name: 'name', label: t('agents.agentName'), value: name, placeholder: t('agents.agentNamePlaceholder') },
    { name: 'emoji', label: t('agents.agentEmoji'), value: agent.identityEmoji || '', placeholder: t('agents.agentEmojiPlaceholder') },
  ]

  if (models.length) {
    const modelField = {
      name: 'model', label: t('agents.agentModel'), type: 'select',
      value: agent.model || models[0]?.value || '',
      options: models,
    }
    fields.push(modelField)
    console.log('[Agent编辑] 当前模型:', agent.model)
    console.log('[Agent编辑] 模型选项:', models)
  } else {
    console.warn('[Agent编辑] 模型列表为空，不显示模型选择器')
  }

  fields.push({
    name: 'workspace', label: t('agents.labelWorkspace').replace(':', ''),
    value: agent.workspace || t('agents.notSet'),
    placeholder: t('agents.workspaceReadonly'),
    readonly: true,
  })

  showModal({
    title: t('agents.editTitle', { id }),
    fields,
    onConfirm: async (result) => {
      console.log('[Agent编辑] 保存数据:', result)
      const newName = (result.name || '').trim()
      const emoji = (result.emoji || '').trim()
      const model = (result.model || '').trim()

      try {
        if (newName || emoji) {
          console.log('[Agent编辑] 更新身份信息...')
          await api.updateAgentIdentity(id, newName || null, emoji || null)
        }
        if (model && model !== agent.model) {
          console.log('[Agent编辑] 更新模型:', agent.model, '->', model)
          await api.updateAgentModel(id, model)
        }

        // 手动更新 state 并重新渲染，确保立即生效
        if (newName) agent.identityName = newName
        if (emoji) agent.identityEmoji = emoji
        if (model) agent.model = model
        renderAgents(page, state)

        toast(t('agents.updated'), 'success')
      } catch (e) {
        console.error('[Agent编辑] 保存失败:', e)
        toast(t('agents.updateFailed') + ': ' + e, 'error')
      }
    }
  })
}

async function deleteAgent(page, state, id) {
  const yes = await showConfirm(t('agents.confirmDelete', { id }))
  if (!yes) return

  try {
    await api.deleteAgent(id)
    toast(t('agents.deleted'), 'success')
    await loadAgents(page, state)
  } catch (e) {
    toast(t('agents.deleteFailed') + ': ' + e, 'error')
  }
}

async function backupAgent(id) {
  toast(t('agents.backingUp', { id }), 'info')
  try {
    const zipPath = await api.backupAgent(id)
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      const dir = zipPath.substring(0, zipPath.lastIndexOf('/')) || zipPath
      await open(dir)
    } catch { /* fallback */ }
    toast(t('agents.backupDone', { file: zipPath.split('/').pop() }), 'success')
  } catch (e) {
    toast(t('agents.backupFailed') + ': ' + e, 'error')
  }
}
