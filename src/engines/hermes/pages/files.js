/**
 * Hermes 文件管理器（Batch 3 §L）
 *
 * 自建（Hermes 没有 file HTTP API），走 Tauri fs 命令：
 *   - hermesFsList(path) → { path, entries: [{name, kind, size, modified}] }
 *   - hermesFsRead(path) → { path, size, text?, binary_b64? }
 *   - hermesFsWrite(path, content) → { path, size }
 *
 * 限制：所有路径必须在 hermes_home (~/.hermes) 子树内（Rust 验证）。
 *
 * UI：左侧面包屑 + 文件树，右侧编辑器（文本）/ 预览（二进制）。
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'
import { humanizeError } from '../../../lib/humanize-error.js'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(secs) {
  if (!secs) return ''
  const d = new Date(secs * 1000)
  return d.toLocaleString()
}

function iconForKind(kind, name) {
  if (kind === 'dir') return '📁'
  if (kind === 'symlink') return '🔗'
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️'
  if (['md', 'txt'].includes(ext)) return '📝'
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '⚙️'
  if (['py', 'js', 'ts', 'rs', 'go'].includes(ext)) return '📄'
  return '📄'
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  // 路径用相对路径（相对 hermes_home），空串 = 根
  let currentDir = ''
  let entries = []
  let dirLoading = true
  let dirError = ''

  // 选中文件状态
  let selectedRel = null  // 选中文件相对路径
  let fileData = null     // { path, size, text, binary_b64 }
  let fileLoading = false
  let fileError = ''
  let editorBuf = ''      // 编辑器当前内容
  let editorDirty = false

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesFilesTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesFilesDesc'))}</p>
        </div>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm" id="hm-fs-refresh">${escHtml(t('hermesLazyDeps.refresh'))}</button>
        </div>
      </div>
      <div class="hm-files-layout">
        <div class="hm-files-tree">
          ${renderBreadcrumb()}
          ${renderDirContent()}
        </div>
        <div class="hm-files-pane">
          ${renderFilePane()}
        </div>
      </div>
    `
    bind()
  }

  function renderBreadcrumb() {
    const parts = currentDir ? currentDir.split(/[\\/]/).filter(Boolean) : []
    let acc = ''
    const crumbs = [{ rel: '', label: '~/.hermes' }]
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p
      crumbs.push({ rel: acc, label: p })
    }
    return `
      <div class="hm-files-breadcrumb">
        ${crumbs.map((c, i) => `
          <a href="#" data-cd="${escAttr(c.rel)}" class="hm-files-crumb">${escHtml(c.label)}</a>
          ${i < crumbs.length - 1 ? '<span class="hm-files-crumb-sep">/</span>' : ''}
        `).join('')}
      </div>
    `
  }

  function renderDirContent() {
    if (dirLoading) {
      return `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>`
    }
    if (dirError) {
      return `<div style="padding:16px;color:var(--error)">${escHtml(dirError)}</div>`
    }
    if (!entries.length) {
      return `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('engine.hermesFilesEmptyDir'))}</div>`
    }
    return `
      <div class="hm-files-list">
        ${currentDir ? `<div class="hm-files-entry hm-files-entry--up" data-cd="${escAttr(parentDir(currentDir))}"><span class="hm-files-icon">📁</span><span class="hm-files-name">..</span></div>` : ''}
        ${entries.map(e => `
          <div class="hm-files-entry ${e.kind === 'dir' ? 'is-dir' : 'is-file'} ${selectedRel === joinRel(currentDir, e.name) ? 'is-selected' : ''}"
               data-kind="${escAttr(e.kind)}"
               data-name="${escAttr(e.name)}">
            <span class="hm-files-icon">${iconForKind(e.kind, e.name)}</span>
            <span class="hm-files-name" title="${escAttr(e.name)}">${escHtml(e.name)}</span>
            <span class="hm-files-meta">${e.kind === 'file' ? escHtml(formatSize(e.size)) : ''}</span>
          </div>
        `).join('')}
      </div>
    `
  }

  function renderFilePane() {
    if (!selectedRel) {
      return `<div class="hm-files-pane-empty">${escHtml(t('engine.hermesFilesSelectFile'))}</div>`
    }
    if (fileLoading) {
      return `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>`
    }
    if (fileError) {
      return `
        <div class="hm-files-pane-header">
          <div class="hm-files-pane-title">${escHtml(selectedRel)}</div>
        </div>
        <div style="padding:16px;color:var(--error)">${escHtml(fileError)}</div>
      `
    }
    if (!fileData) return ''

    return `
      <div class="hm-files-pane-header">
        <div class="hm-files-pane-title" title="${escAttr(fileData.path)}">${escHtml(selectedRel)}</div>
        <div class="hm-files-pane-actions">
          <span class="hm-files-pane-size">${escHtml(formatSize(fileData.size))}</span>
          ${fileData.text != null ? `
            <button class="btn btn-primary btn-sm" id="hm-fs-save" ${!editorDirty ? 'disabled' : ''}>
              ${escHtml(editorDirty ? t('engine.hermesFilesSaveDirty') : t('engine.hermesFilesSave'))}
            </button>` : ''}
        </div>
      </div>
      ${fileData.text != null
        ? `<textarea class="hm-files-editor" id="hm-fs-editor" spellcheck="false">${escHtml(editorBuf)}</textarea>`
        : fileData.binary_b64
          ? renderBinaryPreview(fileData)
          : `<div style="padding:32px;color:var(--text-tertiary);text-align:center">${escHtml(t('engine.hermesFilesUnreadable'))}</div>`}
    `
  }

  function renderBinaryPreview(d) {
    const ext = (selectedRel.split('.').pop() || '').toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext === 'svg' ? 'svg+xml' : ext}`
      return `<div class="hm-files-binary-preview"><img src="data:${mime};base64,${d.binary_b64}" alt=""></div>`
    }
    return `<div class="hm-files-binary-meta">${escHtml(t('engine.hermesFilesBinary'))} · ${escHtml(formatSize(d.size))}</div>`
  }

  function joinRel(a, b) {
    return a ? `${a}/${b}` : b
  }

  function parentDir(rel) {
    if (!rel) return ''
    const idx = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
    return idx > 0 ? rel.slice(0, idx) : ''
  }

  function bind() {
    el.querySelector('#hm-fs-refresh')?.addEventListener('click', () => loadDir(currentDir))
    el.querySelectorAll('[data-cd]').forEach(node => {
      node.addEventListener('click', (e) => {
        e.preventDefault()
        loadDir(node.dataset.cd)
      })
    })
    el.querySelectorAll('.hm-files-entry').forEach(node => {
      const kind = node.dataset.kind
      const name = node.dataset.name
      if (!kind || !name) return  // 跳过 ".." 已绑定的
      node.addEventListener('click', () => {
        if (kind === 'dir') {
          loadDir(joinRel(currentDir, name))
        } else {
          loadFile(joinRel(currentDir, name))
        }
      })
    })
    const editor = el.querySelector('#hm-fs-editor')
    editor?.addEventListener('input', () => {
      editorBuf = editor.value
      const wasDirty = editorDirty
      editorDirty = (editorBuf !== (fileData?.text || ''))
      if (wasDirty !== editorDirty) {
        // 只更新 save 按钮，避免重绘 textarea 失焦
        const btn = el.querySelector('#hm-fs-save')
        if (btn) {
          btn.disabled = !editorDirty
          btn.textContent = editorDirty ? t('engine.hermesFilesSaveDirty') : t('engine.hermesFilesSave')
        }
      }
    })
    el.querySelector('#hm-fs-save')?.addEventListener('click', onSave)
  }

  async function loadDir(rel) {
    if (editorDirty) {
      const ok = await showConfirm({
        message: t('engine.hermesFilesUnsavedConfirm'),
        confirmText: t('engine.hermesFilesDiscardChanges'),
        variant: 'danger',
      })
      if (!ok) return
    }
    currentDir = rel
    dirLoading = true
    dirError = ''
    selectedRel = null
    fileData = null
    editorBuf = ''
    editorDirty = false
    draw()
    try {
      const data = await api.hermesFsList(rel)
      entries = data?.entries || []
    } catch (e) {
      dirError = String(e?.message || e)
      entries = []
    } finally {
      dirLoading = false
      draw()
    }
  }

  async function loadFile(rel) {
    if (editorDirty) {
      const ok = await showConfirm({
        message: t('engine.hermesFilesUnsavedConfirm'),
        confirmText: t('engine.hermesFilesDiscardChanges'),
        variant: 'danger',
      })
      if (!ok) return
    }
    selectedRel = rel
    fileLoading = true
    fileError = ''
    fileData = null
    editorBuf = ''
    editorDirty = false
    draw()
    try {
      const data = await api.hermesFsRead(rel)
      fileData = data
      editorBuf = data?.text || ''
    } catch (e) {
      fileError = String(e?.message || e)
    } finally {
      fileLoading = false
      draw()
    }
  }

  async function onSave() {
    if (!selectedRel || !editorDirty) return
    try {
      await api.hermesFsWrite(selectedRel, editorBuf)
      toast(t('engine.hermesFilesSaved'), 'success')
      // 同步内存状态（不重读，避免失焦）
      if (fileData) fileData.text = editorBuf
      editorDirty = false
      const btn = el.querySelector('#hm-fs-save')
      if (btn) {
        btn.disabled = true
        btn.textContent = t('engine.hermesFilesSave')
      }
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesFilesSaveFailed')), 'error')
    }
  }

  draw()
  loadDir('')
  return el
}
