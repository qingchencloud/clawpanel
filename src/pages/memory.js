/**
 * 记忆文件管理页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal } from '../components/modal.js'

const CATEGORIES = [
  { key: 'memory', label: '工作记忆', desc: '当前活跃的工作上下文、决策记录和进度追踪' },
  { key: 'archive', label: '记忆归档', desc: '已归档的历史记忆文件，按时间周期整理' },
  { key: 'core', label: '核心文件', desc: 'Agent 核心配置文件，如 AGENTS.md、CLAUDE.md 等' },
]

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">记忆文件</h1>
      <div class="page-actions" style="display:flex;align-items:center;gap:var(--space-sm)">
        <label style="font-size:var(--font-size-sm);color:var(--text-tertiary)">Agent:</label>
        <select class="form-input" id="agent-select" style="width:auto;min-width:140px"><option value="main">main</option></select>
      </div>
    </div>
    <div class="tab-bar">
      ${CATEGORIES.map((c, i) => `<div class="tab${i === 0 ? ' active' : ''}" data-tab="${c.key}">${c.label}</div>`).join('')}
    </div>
    <div class="form-hint" id="category-desc" style="margin-bottom:var(--space-md)">${CATEGORIES[0].desc}</div>
    <div class="memory-layout">
      <div class="memory-sidebar">
        <div style="padding:0 var(--space-sm) var(--space-sm);display:flex;gap:4px">
          <button class="btn btn-sm btn-secondary" id="btn-new-file" style="flex:1">+ 新建</button>
          <button class="btn btn-sm btn-danger" id="btn-del-file" disabled style="flex:1">删除</button>
        </div>
        <div style="padding:0 var(--space-sm) var(--space-sm)">
          <button class="btn btn-sm btn-secondary" id="btn-export-zip" style="width:100%">打包下载全部</button>
        </div>
        <div id="file-tree" class="loading-text">加载中...</div>
      </div>
      <div class="memory-editor">
        <div class="editor-toolbar">
          <span id="current-file" style="font-size:var(--font-size-sm);color:var(--text-tertiary)">选择文件查看</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-secondary" id="btn-download" disabled>下载</button>
            <button class="btn btn-sm btn-secondary" id="btn-preview" disabled>预览</button>
            <button class="btn btn-sm btn-primary" id="btn-save-file" disabled>保存</button>
          </div>
        </div>
        <textarea class="editor-area" id="file-editor" placeholder="选择左侧文件进行编辑..." disabled></textarea>
      </div>
    </div>
  `

  const state = { category: 'memory', currentPath: null, agentId: 'main' }

  // 非阻塞加载 agent 列表，然后填充下拉框
  api.listAgents().then(agents => {
    const select = page.querySelector('#agent-select')
    if (!select) return
    const options = agents.map(a => {
      const label = a.identityName ? a.identityName.split(',')[0].trim() : a.id
      return `<option value="${a.id}">${a.id}${a.id !== label ? ' — ' + label : ''}</option>`
    }).join('')
    select.innerHTML = options
  }).catch(() => {})

  // Agent 切换
  page.querySelector('#agent-select').onchange = (e) => {
    state.agentId = e.target.value
    state.currentPath = null
    resetEditor(page)
    loadFiles(page, state)
  }

  // Tab 切换
  page.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      page.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      state.category = tab.dataset.tab
      state.currentPath = null
      const cat = CATEGORIES.find(c => c.key === state.category)
      page.querySelector('#category-desc').textContent = cat?.desc || ''
      resetEditor(page)
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
      title: '新建记忆文件',
      fields: [{ name: 'filename', label: '文件名', placeholder: '如 notes.md', hint: '建议使用 .md 格式，文件将保存到当前分类目录下' }],
      onConfirm: async ({ filename }) => {
        if (!filename) return
        try {
          await api.writeMemoryFile(filename, `# ${filename}\n\n`, state.category, state.agentId)
          toast(`已创建 ${filename}`, 'success')
          loadFiles(page, state)
        } catch (e) {
          toast('创建失败: ' + e, 'error')
        }
      },
    })
  }

  // 删除文件
  page.querySelector('#btn-del-file').onclick = async () => {
    if (!state.currentPath) return
    const name = state.currentPath.split('/').pop()
    const { showConfirm } = await import('../components/modal.js')
    const yes = await showConfirm(`确定删除 ${name}？`)
    if (!yes) return
    try {
      await api.deleteMemoryFile(state.currentPath, state.agentId)
      toast(`已删除 ${name}`, 'success')
      state.currentPath = null
      resetEditor(page)
      loadFiles(page, state)
    } catch (e) {
      toast('删除失败: ' + e, 'error')
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
  tree.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">加载中...</div>'

  try {
    const files = await api.listMemoryFiles(state.category, state.agentId)
    if (!files || !files.length) {
      tree.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">暂无文件</div>'
      return
    }
    renderFileTree(page, state, files)
  } catch (e) {
    tree.innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + e + '</div>'
    toast('加载文件列表失败: ' + e, 'error')
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
  editor.value = '加载中...'
  label.textContent = state.currentPath

  // 退出预览模式
  editor.style.display = ''
  const previewEl = page.querySelector('#md-preview')
  if (previewEl) previewEl.remove()
  btnPreview.textContent = '预览'

  try {
    const content = await api.readMemoryFile(state.currentPath, state.agentId)
    editor.value = content || ''
    editor.disabled = false
    btnSave.disabled = false
    btnPreview.disabled = false
    btnDel.disabled = false
    btnDl.disabled = false
  } catch (e) {
    editor.value = '读取失败: ' + e
    toast('读取文件失败: ' + e, 'error')
  }
}

function resetEditor(page) {
  const editor = page.querySelector('#file-editor')
  editor.value = ''
  editor.disabled = true
  editor.style.display = ''
  const previewEl = page.querySelector('#md-preview')
  if (previewEl) previewEl.remove()
  page.querySelector('#current-file').textContent = '选择文件查看'
  page.querySelector('#btn-save-file').disabled = true
  page.querySelector('#btn-preview').disabled = true
  page.querySelector('#btn-preview').textContent = '预览'
  page.querySelector('#btn-del-file').disabled = true
  page.querySelector('#btn-download').disabled = true
}

async function saveFile(page, state) {
  if (!state.currentPath) return
  const content = page.querySelector('#file-editor').value
  try {
    await api.writeMemoryFile(state.currentPath, content, null, state.agentId)
    toast('文件已保存', 'success')
  } catch (e) {
    toast('保存失败: ' + e, 'error')
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
    btn.textContent = '预览'
  } else {
    // 进入预览
    const md = editor.value
    previewEl = document.createElement('div')
    previewEl.id = 'md-preview'
    previewEl.style.cssText = 'flex:1;padding:var(--space-lg);overflow-y:auto;line-height:1.8;color:var(--text-primary)'
    previewEl.innerHTML = renderMarkdown(md)
    editor.style.display = 'none'
    editor.parentElement.appendChild(previewEl)
    btn.textContent = '编辑'
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
    toast(`已下载 ${filename}`, 'success')
  } catch (e) {
    toast('下载失败: ' + e, 'error')
  }
}

async function exportZip(state) {
  try {
    const zipPath = await api.exportMemoryZip(state.category, state.agentId)
    const label = CATEGORIES.find(c => c.key === state.category)?.label || state.category
    // 尝试用 Tauri shell open 打开文件所在目录
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      const dir = zipPath.substring(0, zipPath.lastIndexOf('/')) || zipPath
      await open(dir)
      toast(`已导出: ${label} → ${zipPath}`, 'success')
    } catch {
      // fallback：仅显示路径
      toast(`已导出: ${label} → ${zipPath}`, 'success')
    }
  } catch (e) {
    toast('打包下载失败: ' + e, 'error')
  }
}
