/**
 * Agent 管理页面
 * Agent 增删改查 + 身份编辑
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'
import { CHANNEL_LABELS } from '../lib/channel-labels.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent 管理</h1>
        <p class="page-desc">创建和管理 OpenClaw Agent，配置身份、模型和工作区</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-add-agent">+ 新建 Agent</button>
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
      api.listAgents(),
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
    container.innerHTML = '<div style="color:var(--error);padding:20px">加载失败: ' + String(e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>'
    toast('加载 Agent 列表失败: ' + e, 'error')
  }
}

/** 为指定 agent 生成绑定渠道的 badge HTML */
function renderBindingBadges(agentId, bindings) {
  const matched = (bindings || []).filter(b => (b.agentId || 'main') === agentId)
  if (!matched.length) {
    return '<span style="color:var(--text-tertiary)">未绑定渠道</span>'
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

function renderAgents(page, state) {
  const container = page.querySelector('#agents-list')
  if (!state.agents.length) {
    container.innerHTML = '<div style="color:var(--text-tertiary);padding:20px;text-align:center">暂无 Agent</div>'
    return
  }

  container.innerHTML = state.agents.map(a => {
    const isDefault = a.isDefault || a.id === 'main'
    const name = a.identityName ? a.identityName.split(',')[0].trim() : '无描述'
    return `
      <div class="agent-card" data-id="${a.id}">
        <div class="agent-card-header">
          <div class="agent-card-title">
            <span class="agent-id">${a.id}</span>
            ${isDefault ? '<span class="badge badge-success">默认</span>' : ''}
          </div>
          <div class="agent-card-actions">
            <button class="btn btn-sm btn-secondary" data-action="backup" data-id="${a.id}">备份</button>
            <button class="btn btn-sm btn-secondary" data-action="edit" data-id="${a.id}">编辑</button>
            ${!isDefault ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${a.id}">删除</button>` : ''}
          </div>
        </div>
        <div class="agent-card-body">
          <div class="agent-info-row">
            <span class="agent-info-label">名称:</span>
            <span class="agent-info-value">${name}</span>
          </div>
          <div class="agent-info-row">
            <span class="agent-info-label">模型:</span>
            <span class="agent-info-value">${typeof a.model === 'object' ? (a.model?.primary || a.model?.id || JSON.stringify(a.model)) : (a.model || '未设置')}</span>
          </div>
          <div class="agent-info-row">
            <span class="agent-info-label">工作区:</span>
            <span class="agent-info-value" style="font-family:var(--font-mono);font-size:var(--font-size-xs)">${a.workspace || '未设置'}</span>
          </div>
          <div class="agent-info-row">
            <span class="agent-info-label">绑定渠道:</span>
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
    if (!btn) return
    const action = btn.dataset.action
    const id = btn.dataset.id

    if (action === 'edit') showEditAgentDialog(page, state, id)
    else if (action === 'delete') await deleteAgent(page, state, id)
    else if (action === 'backup') await backupAgent(id)
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
    toast('请先在模型配置页面添加模型', 'warning')
    return
  }

  showModal({
    title: '新建 Agent',
    fields: [
      { name: 'id', label: 'Agent ID', value: '', placeholder: '例如：translator（小写字母、数字、下划线、连字符）' },
      { name: 'name', label: '名称', value: '', placeholder: '例如：翻译助手' },
      { name: 'emoji', label: 'Emoji', value: '', placeholder: '例如：🌐（可选）' },
      { name: 'model', label: '模型', type: 'select', value: models[0]?.value || '', options: models },
      { name: 'workspace', label: '工作区路径', value: '', placeholder: '留空则自动创建（可选，绝对路径）' },
    ],
    onConfirm: async (result) => {
      const id = (result.id || '').trim()
      if (!id) { toast('请输入 Agent ID', 'warning'); return }
      if (!/^[a-z0-9_-]+$/.test(id)) { toast('Agent ID 只能包含小写字母、数字、下划线和连字符', 'warning'); return }

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
            toast('Agent 已创建，但名称设置失败，可稍后编辑', 'warning')
          }
        }
        toast('Agent 已创建', 'success')

        // 强制清除缓存并重新加载
        invalidate('list_agents')
        await loadAgents(page, state)
      } catch (e) {
        toast('创建失败: ' + e, 'error')
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
    { name: 'name', label: '名称', value: name, placeholder: '例如：翻译助手' },
    { name: 'emoji', label: 'Emoji', value: agent.identityEmoji || '', placeholder: '例如：🌐' },
  ]

  if (models.length) {
    const modelField = {
      name: 'model', label: '模型', type: 'select',
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
    name: 'workspace', label: '工作区',
    value: agent.workspace || '未设置',
    placeholder: '创建时指定，不可修改',
    readonly: true,
  })

  showModal({
    title: `编辑 Agent — ${id}`,
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

        toast('已更新', 'success')
      } catch (e) {
        console.error('[Agent编辑] 保存失败:', e)
        toast('更新失败: ' + e, 'error')
      }
    }
  })
}

async function deleteAgent(page, state, id) {
  const yes = await showConfirm(`确定删除 Agent「${id}」？\n\n此操作将删除该 Agent 的所有数据和会话。`)
  if (!yes) return

  try {
    await api.deleteAgent(id)
    toast('已删除', 'success')
    await loadAgents(page, state)
  } catch (e) {
    toast('删除失败: ' + e, 'error')
  }
}

async function backupAgent(id) {
  toast(`正在备份 Agent「${id}」...`, 'info')
  try {
    const zipPath = await api.backupAgent(id)
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      const dir = zipPath.substring(0, zipPath.lastIndexOf('/')) || zipPath
      await open(dir)
    } catch { /* fallback */ }
    toast(`备份完成: ${zipPath.split('/').pop()}`, 'success')
  } catch (e) {
    toast('备份失败: ' + e, 'error')
  }
}
