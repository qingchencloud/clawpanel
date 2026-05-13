/**
 * 记忆文件管理页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showModal } from '../components/modal.js'
import { t } from '../lib/i18n.js'

function CATEGORIES() {
  return [
    { key: 'memory', label: t('memory.catMemory'), desc: t('memory.catMemoryDesc') },
    { key: 'archive', label: t('memory.catArchive'), desc: t('memory.catArchiveDesc') },
    { key: 'core', label: t('memory.catCore'), desc: t('memory.catCoreDesc') },
  ]
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('memory.title')}</h1>
      <div class="page-actions" style="display:flex;align-items:center;gap:var(--space-sm)">
        <label style="font-size:var(--font-size-sm);color:var(--text-tertiary)">${t('memory.agentLabel')}</label>
        <select class="form-input" id="agent-select" style="width:auto;min-width:140px"><option value="main">main</option></select>
      </div>
    </div>
    <div class="tab-bar">
      ${CATEGORIES().map((c, i) => `<div class="tab${i === 0 ? ' active' : ''}" data-tab="${c.key}">${c.label}</div>`).join('')}
    </div>
    <div class="form-hint" id="category-desc" style="margin-bottom:var(--space-md)">${CATEGORIES()[0].desc}</div>
    <div class="memory-layout">
      <div class="memory-sidebar">
        <div style="padding:0 var(--space-sm) var(--space-sm);display:flex;gap:4px">
          <button class="btn btn-sm btn-secondary" id="btn-new-file" style="flex:1">${t('memory.newFile')}</button>
          <button class="btn btn-sm btn-danger" id="btn-del-file" disabled style="flex:1">${t('memory.deleteFile')}</button>
        </div>
        <div style="padding:0 var(--space-sm) var(--space-sm)">
          <button class="btn btn-sm btn-secondary" id="btn-export-zip" style="width:100%">${t('memory.exportZip')}</button>
        </div>
        <div id="file-tree"><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div></div>
      </div>
      <div class="memory-editor">
        <div class="editor-toolbar">
          <span id="current-file" style="font-size:var(--font-size-sm);color:var(--text-tertiary)">${t('memory.selectFile')}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-secondary" id="btn-download" disabled>${t('memory.download')}</button>
            <button class="btn btn-sm btn-secondary" id="btn-preview" disabled>${t('memory.preview')}</button>
            <button class="btn btn-sm btn-primary" id="btn-save-file" disabled>${t('memory.save')}</button>
          </div>
        </div>
        <textarea class="editor-area" id="file-editor" placeholder="${t('memory.editorPlaceholder')}" disabled></textarea>
      </div>
    </div>
  `

  const state = { category: 'memory', currentPath: null, agentId: 'main' }

  // 先用默认选项填充下拉框，立即显示页面
  const agentSelect = page.querySelector('#agent-select')
  agentSelect.innerHTML = '<option value="main">main</option>'

  // 异步加载 agent 列表并更新下拉框
  api.listAgents().then(agents => {
    if (!agentSelect) return
    const options = agents.map(a => {
      const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
      return `<option value="${a.id}">${a.id}${a.id !== label ? ' — ' + label : ''}</option>`
    }).join('')
    agentSelect.innerHTML = options
  }).catch(() => {})

  // Agent 切换
  page.querySelector('#agent-select').onchange = (e) => {
    state.agentId = e.target.value
    state.currentPath = null
    resetEditor(page)
    // 显示加载动画
    const tree = page.querySelector('#file-tree')
    tree.innerHTML = '<div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div>'
    loadFiles(page, state)
  }

  // Tab 切换
  page.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      page.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      state.category = tab.dataset.tab
      state.currentPath = null
      const cat = CATEGORIES().find(c => c.key === state.category)
      page.querySelector('#category-desc').textContent = cat?.desc || ''
      resetEditor(page)
      // 显示加载动画
      const tree = page.querySelector('#file-tree')
      tree.innerHTML = '<div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div><div class="stat-card loading-placeholder" style="height:32px;margin:8px"></div>'
      loadFiles(page, state)
    }
  })

  // 保存
  page.querySelector('#btn-save-file').onclick = () => saveFile(page, state)

  // 预览（简易 Markdown 渲染）
  page.querySelector('#btn-preview').onclick = () => togglePreview(page, state)

  // 新建文件
  page.querySelector('#btn-new-file').onclick = () => {
    showModal({
      title: t('memory.newFileTitle'),
      fields: [{ name: 'filename', label: t('memory.newFileLabel'), placeholder: t('memory.newFilePlaceholder'), hint: t('memory.newFileHint') }],
      onConfirm: async ({ filename }) => {
        if (!filename) return
        try {
          await api.writeMemoryFile(filename, `# ${filename}\n\n`, state.category, state.agentId)
          toast(t('memory.created', { name: filename }), 'success')
          loadFiles(page, state)
        } catch (e) {
          toast(humanizeError(e, t('memory.createFailed')), 'error')
        }
      },
    })
  }

  // 删除文件
  page.querySelector('#btn-del-file').onclick = async () => {
    if (!state.currentPath) return
    const name = state.currentPath.split('/').pop()
    const { showConfirm } = await import('../components/modal.js')
    const yes = await showConfirm({
      title: t('memory.deleteConfirmTitle', { name }),
      message: t('memory.confirmDelete', { name }),
      impact: [
        t('memory.deleteImpactPermanent'),
        t('memory.deleteImpactAgent'),
      ],
      confirmText: t('memory.deleteConfirmBtn'),
      cancelText: t('memory.deleteCancelBtn'),
    })
    if (!yes) return
    try {
      await api.deleteMemoryFile(state.currentPath, state.agentId)
      toast(t('memory.deleted', { name }), 'success')
      state.currentPath = null
      resetEditor(page)
      loadFiles(page, state)
    } catch (e) {
      toast(humanizeError(e, t('memory.deleteFailed')), 'error')
    }
  }

  // 单个下载
  page.querySelector('#btn-download').onclick = () => downloadCurrentFile(page, state)

  // 打包下载
  page.querySelector('#btn-export-zip').onclick = () => exportZip(state)

  loadFiles(page, state)
  return page
}

async function loadFiles(page, state) {
  const tree = page.querySelector('#file-tree')

  try {
    const files = await api.listMemoryFiles(state.category, state.agentId)
    if (!files || !files.length) {
      tree.innerHTML = `
        <div class="empty-state empty-compact">
          <div class="empty-icon">🧠</div>
          <div class="empty-desc">${t('memory.noFiles')}</div>
          <div class="empty-cta"><button class="btn btn-primary btn-sm" data-empty-cta="new-file">${t('memory.newFile')}</button></div>
        </div>
      `
      tree.querySelector('[data-empty-cta="new-file"]')?.addEventListener('click', () => {
        page.querySelector('#btn-new-file')?.click()
      })
      return
    }
    renderFileTree(page, state, files)
  } catch (e) {
    tree.innerHTML = `<div style="color:var(--error);padding:12px">${t('memory.loadFailed')}: ${e}</div>`
    toast(humanizeError(e, t('memory.loadListFailed')), 'error')
  }
}

function renderFileTree(page, state, files) {
  const tree = page.querySelector('#file-tree')
  tree.innerHTML = files.map(f => {
    const name = f.split('/').pop()
    const active = state.currentPath === f ? ' active' : ''
    return `<div class="file-item${active}" data-path="${f}">${name}</div>`
  }).join('')

  tree.querySelectorAll('.file-item').forEach(item => {
    item.onclick = () => {
      state.currentPath = item.dataset.path
      tree.querySelectorAll('.file-item').forEach(i => i.classList.remove('active'))
      item.classList.add('active')
      loadFileContent(page, state)
    }
  })
}

async function loadFileContent(page, state) {
  const editor = page.querySelector('#file-editor')
  const label = page.querySelector('#current-file')
  const btnSave = page.querySelector('#btn-save-file')
  const btnPreview = page.querySelector('#btn-preview')
  const btnDel = page.querySelector('#btn-del-file')
  const btnDl = page.querySelector('#btn-download')

  editor.disabled = true
  editor.value = t('memory.loading')
  label.textContent = state.currentPath

  // 退出预览模式
  editor.style.display = ''
  const previewEl = page.querySelector('#md-preview')
  if (previewEl) previewEl.remove()
  btnPreview.textContent = t('memory.preview')

  try {
    const content = await api.readMemoryFile(state.currentPath, state.agentId)
    editor.value = content || ''
    editor.disabled = false
    btnSave.disabled = false
    btnPreview.disabled = false
    btnDel.disabled = false
    btnDl.disabled = false
  } catch (e) {
    editor.value = t('memory.readFailed') + ': ' + e
    toast(humanizeError(e, t('memory.readFileFailed')), 'error')
  }
}

function resetEditor(page) {
  const editor = page.querySelector('#file-editor')
  editor.value = ''
  editor.disabled = true
  editor.style.display = ''
  const previewEl = page.querySelector('#md-preview')
  if (previewEl) previewEl.remove()
  page.querySelector('#current-file').textContent = t('memory.selectFile')
  page.querySelector('#btn-save-file').disabled = true
  page.querySelector('#btn-preview').disabled = true
  page.querySelector('#btn-preview').textContent = t('memory.preview')
  page.querySelector('#btn-del-file').disabled = true
  page.querySelector('#btn-download').disabled = true
}

async function saveFile(page, state) {
  if (!state.currentPath) return
  const content = page.querySelector('#file-editor').value
  try {
    await api.writeMemoryFile(state.currentPath, content, state.category, state.agentId)
    toast(t('memory.fileSaved'), 'success')
  } catch (e) {
    toast(humanizeError(e, t('memory.saveFailed')), 'error')
  }
}

function togglePreview(page) {
  const editor = page.querySelector('#file-editor')
  const btn = page.querySelector('#btn-preview')
  let previewEl = page.querySelector('#md-preview')

  if (previewEl) {
    // 退出预览
    previewEl.remove()
    editor.style.display = ''
    btn.textContent = t('memory.preview')
  } else {
    // 进入预览
    const md = editor.value
    previewEl = document.createElement('div')
    previewEl.id = 'md-preview'
    previewEl.style.cssText = 'flex:1;padding:var(--space-lg);overflow-y:auto;line-height:1.8;color:var(--text-primary)'
    previewEl.innerHTML = renderMarkdown(md)
    editor.style.display = 'none'
    editor.parentElement.appendChild(previewEl)
    btn.textContent = t('memory.edit')
  }
}

// 简易 Markdown 渲染
function renderMarkdown(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:var(--font-size-lg);font-weight:600;margin:16px 0 8px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:var(--font-size-xl);font-weight:600;margin:20px 0 8px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:var(--font-size-2xl);font-weight:700;margin:24px 0 12px">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:var(--font-size-xs)">$1</code>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:20px">$1</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')
}

// ===== 下载功能 =====

function triggerDownload(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadCurrentFile(page, state) {
  if (!state.currentPath) return
  try {
    const content = page.querySelector('#file-editor').value
    const filename = state.currentPath.split('/').pop()
    triggerDownload(filename, content)
    toast(t('memory.downloaded', { name: filename }), 'success')
  } catch (e) {
    toast(humanizeError(e, t('memory.downloadFailed')), 'error')
  }
}

async function exportZip(state) {
  try {
    const zipPath = await api.exportMemoryZip(state.category, state.agentId)
    const label = CATEGORIES().find(c => c.key === state.category)?.label || state.category
    // 尝试用 Tauri shell open 打开文件所在目录
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      const dir = zipPath.substring(0, zipPath.lastIndexOf('/')) || zipPath
      await open(dir)
      toast(t('memory.exported', { label, path: zipPath }), 'success')
    } catch {
      // fallback：仅显示路径
      toast(t('memory.exported', { label, path: zipPath }), 'success')
    }
  } catch (e) {
    toast(humanizeError(e, t('memory.exportFailed')), 'error')
  }
}
