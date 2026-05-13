/**
 * Hermes Kanban 看板（Batch 3 §M）
 *
 * Hermes 已内置 kanban 系统（plugins/kanban/dashboard/plugin_api.py），
 * ClawPanel 直接调 Dashboard 9119 的 plugin API：
 *   - GET    /api/plugins/kanban/board       - 拿当前 board 全部 columns + tasks
 *   - GET    /api/plugins/kanban/boards      - 列所有 board
 *   - POST   /api/plugins/kanban/boards      - 创建 board
 *   - POST   /api/plugins/kanban/boards/{slug}/switch - 切换 active board
 *   - POST   /api/plugins/kanban/tasks       - 创建任务
 *   - PATCH  /api/plugins/kanban/tasks/{id}  - 改任务（含 status 切换）
 *   - GET    /api/plugins/kanban/tasks/{id}  - 任务详情
 *
 * 设计稿原本是「自建本地存储」(~800 行)，复用 Hermes 内置后大幅缩减。
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showModal, showContentModal } from '../../../components/modal.js'
import { humanizeError } from '../../../lib/humanize-error.js'
import { svgIcon } from '../lib/svg-icons.js'

const KANBAN_BASE = '/api/plugins/kanban'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

function renderInlineError(err) {
  const h = humanizeError(err, t('engine.hermesKanbanTaskLoadFailed'))
  return `
    <div class="page-inline-error">
      <div class="page-inline-error-icon">${svgIcon('alert-triangle', { size: 20 })}</div>
      <div class="page-inline-error-body">
        <div class="page-inline-error-message">${escHtml(h.message)}</div>
        ${h.hint ? `<div class="page-inline-error-hint">${escHtml(h.hint)}</div>` : ''}
        ${h.raw ? `<details class="page-inline-error-details"><summary>${escHtml(t('common.errorRawLabel'))}</summary><pre>${escHtml(h.raw)}</pre></details>` : ''}
      </div>
    </div>
  `
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let board = null  // { columns: [{name, tasks: []}], ... }
  let boards = []
  let loading = true
  let error = ''

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesKanbanTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesKanbanDesc'))}</p>
        </div>
        <div class="config-actions">
          ${boards.length > 1 ? `
            <select class="form-input" id="hm-kanban-board-switch" style="max-width:200px">
              ${boards.map(b => `<option value="${escAttr(b.slug || b.name)}" ${b.is_current ? 'selected' : ''}>${escHtml(b.name || b.slug)}</option>`).join('')}
            </select>` : ''}
          <button class="btn btn-secondary btn-sm" id="hm-kanban-refresh">${escHtml(t('hermesLazyDeps.refresh'))}</button>
          <button class="btn btn-primary btn-sm" id="hm-kanban-new-task">+ ${escHtml(t('engine.hermesKanbanNewTask'))}</button>
        </div>
      </div>
      <div id="hm-kanban-content">
        ${loading ? `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>` : ''}
        ${error ? renderInlineError(error) : ''}
        ${(!loading && !error && board) ? renderBoard() : ''}
      </div>
    `
    bind()
  }

  function renderBoard() {
    if (!board?.columns?.length) {
      return `<div class="empty-state empty-compact"><div class="empty-icon">${svgIcon('clipboard-list', { size: 32 })}</div><div class="empty-title">${escHtml(t('engine.hermesKanbanEmpty'))}</div></div>`
    }
    return `
      <div class="hm-kanban-board">
        ${board.columns.map(col => `
          <div class="hm-kanban-col" data-col="${escAttr(col.name)}">
            <div class="hm-kanban-col-head">
              <span class="hm-kanban-col-name">${escHtml(colLabel(col.name))}</span>
              <span class="hm-kanban-col-count">${col.tasks?.length || 0}</span>
            </div>
            <div class="hm-kanban-col-body">
              ${(col.tasks || []).map(renderTask).join('')}
              ${!col.tasks?.length ? `<div class="hm-kanban-col-empty">${escHtml(t('engine.hermesKanbanColEmpty'))}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `
  }

  function renderTask(task) {
    const priorityBadge = task.priority > 1 ? `<span class="hm-kanban-task-prio">P${escHtml(task.priority)}</span>` : ''
    const assignee = task.assignee ? `<span class="hm-kanban-task-assignee">@${escHtml(task.assignee)}</span>` : ''
    return `
      <div class="hm-kanban-task" data-task-id="${escAttr(task.id)}">
        <div class="hm-kanban-task-title">${escHtml(task.title)}</div>
        ${task.summary ? `<div class="hm-kanban-task-summary">${escHtml(task.summary)}</div>` : ''}
        <div class="hm-kanban-task-meta">
          ${priorityBadge}
          ${assignee}
          ${task.comment_count ? `<span class="hm-kanban-task-meta-item">${svgIcon('message-square', { size: 12 })} ${task.comment_count}</span>` : ''}
        </div>
      </div>
    `
  }

  function colLabel(name) {
    const map = {
      todo: t('engine.hermesKanbanColTodo'),
      'in_progress': t('engine.hermesKanbanColInProgress'),
      blocked: t('engine.hermesKanbanColBlocked'),
      done: t('engine.hermesKanbanColDone'),
      archived: t('engine.hermesKanbanColArchived'),
    }
    return map[name] || name
  }

  function bind() {
    el.querySelector('#hm-kanban-refresh')?.addEventListener('click', load)
    el.querySelector('#hm-kanban-new-task')?.addEventListener('click', onCreateTask)
    el.querySelector('#hm-kanban-board-switch')?.addEventListener('change', async (e) => {
      const slug = e.target.value
      try {
        await api.hermesDashboardApi('POST', `${KANBAN_BASE}/boards/${encodeURIComponent(slug)}/switch`)
        toast(t('engine.hermesKanbanBoardSwitched', { name: slug }), 'success')
        await load()
      } catch (err) {
        toast(humanizeError(err, t('engine.hermesKanbanBoardSwitchFailed')), 'error')
      }
    })
    el.querySelectorAll('.hm-kanban-task').forEach(card => {
      card.addEventListener('click', () => onTaskClick(card.dataset.taskId))
    })
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      const [boardData, boardsData] = await Promise.all([
        api.hermesDashboardApi('GET', `${KANBAN_BASE}/board`),
        api.hermesDashboardApi('GET', `${KANBAN_BASE}/boards`).catch(() => ({ boards: [] })),
      ])
      board = boardData
      boards = Array.isArray(boardsData) ? boardsData : (boardsData?.boards || [])
    } catch (e) {
      error = e
    } finally {
      loading = false
      draw()
    }
  }

  function onCreateTask() {
    const statusOpts = ['todo', 'in_progress', 'blocked', 'done'].map(s => ({ value: s, label: colLabel(s) }))
    showModal({
      title: t('engine.hermesKanbanNewTaskTitle'),
      fields: [
        { name: 'title', label: t('engine.hermesKanbanTitleLabel'), value: '', placeholder: '...' },
        { name: 'summary', label: t('engine.hermesKanbanSummaryLabel'), value: '', placeholder: '' },
        { name: 'status', label: t('engine.hermesKanbanStatusLabel'), type: 'select', options: statusOpts, value: 'todo' },
        { name: 'priority', label: t('engine.hermesKanbanPriorityLabel'), value: '1', placeholder: '1-5' },
      ],
      onConfirm: async (data) => {
        const title = (data.title || '').trim()
        if (!title) {
          toast(t('engine.hermesKanbanTitleRequired'), 'error')
          return
        }
        try {
          await api.hermesDashboardApi('POST', `${KANBAN_BASE}/tasks`, {
            title,
            summary: (data.summary || '').trim() || undefined,
            status: data.status,
            priority: parseInt(data.priority, 10) || 1,
          })
          toast(t('engine.hermesKanbanTaskCreated'), 'success')
          await load()
        } catch (err) {
          toast(humanizeError(err, t('engine.hermesKanbanTaskCreateFailed')), 'error')
        }
      },
    })
  }

  async function onTaskClick(taskId) {
    if (!taskId) return
    try {
      const task = await api.hermesDashboardApi('GET', `${KANBAN_BASE}/tasks/${encodeURIComponent(taskId)}`)
      showContentModal({
        title: task.title || taskId,
        content: `
          <div class="hm-kanban-detail">
            <div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanStatusLabel'))}:</b> ${escHtml(colLabel(task.status))}</div>
            ${task.priority ? `<div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanPriorityLabel'))}:</b> P${escHtml(task.priority)}</div>` : ''}
            ${task.assignee ? `<div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanAssigneeLabel'))}:</b> @${escHtml(task.assignee)}</div>` : ''}
            ${task.summary ? `<div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanSummaryLabel'))}:</b><br>${escHtml(task.summary)}</div>` : ''}
            ${task.description ? `<div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanDescLabel'))}:</b><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;margin:6px 0 0">${escHtml(task.description)}</pre></div>` : ''}
            ${task.latest_summary ? `<div class="hm-kanban-detail-row"><b>${escHtml(t('engine.hermesKanbanRunSummary'))}:</b><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11px;margin:6px 0 0;max-height:160px;overflow:auto">${escHtml(task.latest_summary)}</pre></div>` : ''}
          </div>`,
        buttons: [
          { label: t('engine.hermesKanbanMoveStatus'), className: 'btn-secondary', id: 'kanban-move-' + taskId },
          { label: t('common.close'), className: 'btn-secondary' },
        ],
        width: 560,
      })
      // 「修改状态」按钮点击 → 弹小窗选 status
      setTimeout(() => {
        document.getElementById('kanban-move-' + taskId)?.addEventListener('click', () => {
          showModal({
            title: t('engine.hermesKanbanMoveStatusTitle'),
            fields: [
              { name: 'status', label: t('engine.hermesKanbanStatusLabel'), type: 'select',
                options: ['todo', 'in_progress', 'blocked', 'done', 'archived'].map(s => ({ value: s, label: colLabel(s) })),
                value: task.status },
            ],
            onConfirm: async (d) => {
              try {
                await api.hermesDashboardApi('PATCH', `${KANBAN_BASE}/tasks/${encodeURIComponent(taskId)}`, { status: d.status })
                toast(t('engine.hermesKanbanTaskUpdated'), 'success')
                await load()
                // 关掉详情模态
                document.querySelectorAll('.modal-overlay').forEach(o => o.remove())
              } catch (err) {
                toast(humanizeError(err, t('engine.hermesKanbanTaskUpdateFailed')), 'error')
              }
            },
          })
        })
      }, 10)
    } catch (err) {
      toast(humanizeError(err, t('engine.hermesKanbanTaskLoadFailed')), 'error')
    }
  }

  draw()
  load()
  return el
}
