import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { t } from '../lib/i18n.js'

let _workflows = []
let _runs = []
let _activeTab = 'templates'
let _selectedTemplateId = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('workflow.title')}</h1>
      <button class="btn btn-primary" id="btn-create-workflow">${t('workflow.createWorkflow')}</button>
    </div>
    <div class="workflow-tabs" style="display:flex;gap:8px;margin-bottom:16px">
      <button class="btn ${_activeTab === 'templates' ? 'btn-primary' : 'btn-secondary'}" data-tab="templates">${t('workflow.title')}</button>
      <button class="btn ${_activeTab === 'runs' ? 'btn-primary' : 'btn-secondary'}" data-tab="runs">${t('workflow.runs')}</button>
    </div>
    <div id="workflow-content">
      <div class="loading" style="text-align:center;padding:40px;color:var(--text-tertiary)">${t('common.loading')}</div>
    </div>
  `

  bindActions(page)
  loadData(page)

  return page
}

export function cleanup() {
  _workflows = []
  _runs = []
  _activeTab = 'templates'
  _selectedTemplateId = null
}

async function loadData(page) {
  try {
    if (_activeTab === 'templates') {
      _workflows = await api.listWorkflows()
      renderTemplates(page)
    } else {
      _runs = await api.listWorkflowRuns(_selectedTemplateId || null)
      renderRuns(page)
    }
  } catch (err) {
    const content = page.querySelector('#workflow-content')
    content.innerHTML = `<div class="error-state" style="text-align:center;padding:40px"><div style="color:var(--error)">${t('common.error')}: ${escapeHtml(err.message)}</div><button class="btn btn-secondary" onclick="location.reload()">${t('common.retry')}</button></div>`
  }
}

function renderTemplates(page) {
  const content = page.querySelector('#workflow-content')

  if (!_workflows || _workflows.length === 0) {
    content.innerHTML = `
      <div style="text-align:center;padding:60px 20px">
        <div style="font-size:48px;margin-bottom:16px">📋</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px">${t('workflow.noWorkflows')}</div>
        <div style="color:var(--text-tertiary);margin-bottom:24px">${t('workflow.createFirst')}</div>
        <button class="btn btn-primary" id="btn-create-first">${t('workflow.createWorkflow')}</button>
      </div>
    `
    content.querySelector('#btn-create-first')?.addEventListener('click', () => showCreateDialog(page))
    return
  }

  content.innerHTML = `<div class="workflow-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
    ${_workflows.map(wf => `
      <div class="workflow-card" data-id="${wf.id}" style="padding:16px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary)">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
          <h3 style="font-size:16px;font-weight:600;margin:0">${escapeHtml(wf.name)}</h3>
          <span style="font-size:12px;color:var(--text-tertiary)">${t('workflow.nodes')}: ${(wf.nodes || []).length}</span>
        </div>
        ${wf.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:8px 0">${escapeHtml(wf.description)}</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-sm btn-secondary" data-action="run" data-id="${wf.id}">${t('workflow.startRun')}</button>
          <button class="btn btn-sm btn-ghost" data-action="edit" data-id="${wf.id}">${t('workflow.editWorkflow')}</button>
          <button class="btn btn-sm btn-ghost" style="color:var(--error)" data-action="delete" data-id="${wf.id}">${t('workflow.deleteWorkflow')}</button>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">${new Date(wf.createdAt).toLocaleDateString()}</div>
      </div>
    `).join('')}
  </div>`
}

function renderRuns(page) {
  const content = page.querySelector('#workflow-content')

  if (!_runs || _runs.length === 0) {
    content.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--text-tertiary)">${t('workflow.noWorkflows')}</div>`
    return
  }

  const statusLabels = {
    pending: t('workflow.pending'),
    running: t('workflow.running'),
    completed: t('workflow.completed'),
    failed: t('workflow.failed'),
    paused: t('workflow.paused')
  }

  const statusColors = {
    pending: 'var(--text-tertiary)',
    running: 'var(--warning)',
    completed: 'var(--success)',
    failed: 'var(--error)',
    paused: 'var(--text-secondary)'
  }

  content.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
    ${_runs.map(run => `
      <div class="run-card" data-id="${run.id}" style="padding:12px 16px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary);display:flex;justify-content:space-between;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${escapeHtml(run.templateName || t('common.unknown'))}</div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">${new Date(run.createdAt).toLocaleString()}</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span style="padding:2px 8px;border-radius:12px;font-size:12px;font-weight:500;background:${statusColors[run.status] || 'var(--text-tertiary)'};color:#fff">${statusLabels[run.status] || run.status}</span>
          <button class="btn btn-sm btn-ghost" style="color:var(--error)" data-action="delete-run" data-id="${run.id}">${t('workflow.deleteRun')}</button>
        </div>
      </div>
    `).join('')}
  </div>`
}

function bindActions(page) {
  page.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]')
    if (!target) {
      const tabBtn = e.target.closest('[data-tab]')
      if (tabBtn) {
        _activeTab = tabBtn.dataset.tab
        page.querySelectorAll('[data-tab]').forEach(b => {
          b.className = `btn ${b.dataset.tab === _activeTab ? 'btn-primary' : 'btn-secondary'}`
        })
        loadData(page)
      }
      return
    }

    const action = target.dataset.action
    const id = target.dataset.id

    if (action === 'create') {
      showCreateDialog(page)
    } else if (action === 'edit') {
      showEditDialog(page, id)
    } else if (action === 'run') {
      startWorkflowRun(page, id)
    } else if (action === 'delete') {
      deleteWorkflow(page, id)
    } else if (action === 'delete-run') {
      deleteWorkflowRun(page, id)
    }
  })

  page.querySelector('#btn-create-workflow')?.addEventListener('click', () => {
    showCreateDialog(page)
  })
}

async function showCreateDialog(page) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-title">${t('workflow.createWorkflow')}</div>
      <form id="workflow-form" style="margin-top:16px">
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">${t('workflow.workflowName')}</label>
          <input class="login-input" type="text" id="wf-name" placeholder="My Workflow" required style="width:100%" />
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">${t('workflow.workflowDesc')}</label>
          <textarea id="wf-desc" rows="3" placeholder="Describe this workflow..." style="width:100%;padding:8px 12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;resize:vertical"></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">${t('common.close')}</button>
          <button type="submit" class="btn btn-primary btn-sm">${t('workflow.createWorkflow')}</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => overlay.remove())

  overlay.querySelector('#workflow-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = overlay.querySelector('#wf-name').value.trim()
    const description = overlay.querySelector('#wf-desc').value.trim()
    if (!name) return

    try {
      await api.createWorkflow({ name, description })
      toast('Workflow created', 'success')
      overlay.remove()
      loadData(page)
    } catch (err) {
      toast('Failed: ' + err.message, 'error')
    }
  })
}

async function showEditDialog(page, id) {
  const wf = _workflows.find(w => w.id === id)
  if (!wf) return

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-title">${t('workflow.editWorkflow')}</div>
      <form id="workflow-edit-form" style="margin-top:16px">
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">${t('workflow.workflowName')}</label>
          <input class="login-input" type="text" id="wf-edit-name" value="${escapeHtml(wf.name)}" required style="width:100%" />
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">${t('workflow.workflowDesc')}</label>
          <textarea id="wf-edit-desc" rows="3" style="width:100%;padding:8px 12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;resize:vertical">${escapeHtml(wf.description || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">${t('common.close')}</button>
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => overlay.remove())

  overlay.querySelector('#workflow-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = overlay.querySelector('#wf-edit-name').value.trim()
    const description = overlay.querySelector('#wf-edit-desc').value.trim()
    if (!name) return

    try {
      await api.updateWorkflow({ id, name, description })
      toast(t('common.save') + ' OK', 'success')
      overlay.remove()
      loadData(page)
    } catch (err) {
      toast('Failed: ' + err.message, 'error')
    }
  })
}

async function startWorkflowRun(page, id) {
  try {
    await api.startWorkflowRun(id)
    toast(t('workflow.startRun') + ' OK', 'success')
    _activeTab = 'runs'
    _selectedTemplateId = id
    page.querySelectorAll('[data-tab]').forEach(b => {
      b.className = `btn ${b.dataset.tab === 'runs' ? 'btn-primary' : 'btn-secondary'}`
    })
    loadData(page)
  } catch (err) {
    toast('Failed: ' + err.message, 'error')
  }
}

async function deleteWorkflow(page, id) {
  const confirmed = await showConfirm(t('workflow.confirmDelete'))
  if (!confirmed) return

  try {
    await api.deleteWorkflow(id)
    toast('Workflow deleted', 'success')
    loadData(page)
  } catch (err) {
    toast('Failed: ' + err.message, 'error')
  }
}

async function deleteWorkflowRun(page, id) {
  const confirmed = await showConfirm(t('workflow.confirmDeleteRun'))
  if (!confirmed) return

  try {
    await api.deleteWorkflowRun(id)
    toast('Run deleted', 'success')
    loadData(page)
  } catch (err) {
    toast('Failed: ' + err.message, 'error')
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
