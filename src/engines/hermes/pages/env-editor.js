/**
 * Hermes ~/.hermes/.env 高级编辑器
 *
 * Managed keys (provider API keys, base URLs, GATEWAY_ALLOW_ALL_USERS,
 * API_SERVER_KEY) are hidden — those are surfaced on the setup page.
 *
 * Users can add/edit/delete custom env vars (TAVILY_API_KEY, HTTP_PROXY,
 * SKILL_*, etc.) which Hermes will pick up on Gateway restart.
 */
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'

// NOTE: i18n keys for this page are not yet wired up in src/locales; using
// inline Chinese copy (with occasional English fallback) for now. When the
// translation module lands, replace these literals with `t('hermesEnv.*')`.

const ICONS = {
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  cancel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'

  let rows = []            // [{ key, value, editing: false, draftValue: '', isNew: false }]
  let loading = true
  let loadError = null

  el.innerHTML = skeleton()

  function skeleton() {
    return `
      <div class="page-header" style="display:flex;align-items:center;gap:12px">
        <a href="#/h/dashboard" class="btn-text" style="display:inline-flex;align-items:center;gap:4px;font-size:13px">
          ${ICONS.back} 返回仪表盘
        </a>
        <h1 style="margin:0;font-size:20px">.env 高级编辑</h1>
      </div>
      <div style="max-width:860px">
        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="padding:20px">
            <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm,6px);font-size:12px;line-height:1.6;color:var(--text-secondary);margin-bottom:16px">
              以下环境变量由 ClawPanel 在 Hermes 配置页面管理：<code>OPENAI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> / <code>DEEPSEEK_API_KEY</code> 等 provider 密钥和 base URL，以及 <code>GATEWAY_ALLOW_ALL_USERS</code> / <code>API_SERVER_KEY</code>。请通过 Hermes 仪表盘的「模型配置」修改这些项——本页仅用于添加自定义环境变量（如 <code>TAVILY_API_KEY</code>、<code>HTTP_PROXY</code>、Skills 所需的自定义变量等）。
            </div>
            <div id="env-list"></div>
            <div id="env-empty" style="display:none;padding:18px 14px;text-align:center;color:var(--text-tertiary);font-size:13px"></div>
            <div id="env-error" style="display:none;padding:10px 14px;background:var(--error-bg, #fef2f2);border:1px solid var(--error, #ef4444);border-radius:var(--radius-sm,6px);color:var(--error, #ef4444);font-size:13px;margin-top:12px"></div>
          </div>
        </div>
      </div>
    `
  }

  function renderList() {
    const listEl = el.querySelector('#env-list')
    const emptyEl = el.querySelector('#env-empty')
    if (!listEl) return

    if (loading) {
      listEl.innerHTML = `<div style="padding:18px 14px;text-align:center;color:var(--text-tertiary);font-size:13px">加载中…</div>`
      if (emptyEl) emptyEl.style.display = 'none'
      return
    }

    if (!rows.length) {
      listEl.innerHTML = ''
      if (emptyEl) {
        emptyEl.textContent = '暂无自定义环境变量。点击下方「添加变量」新增一条。'
        emptyEl.style.display = 'block'
      }
      renderFooter()
      return
    }

    if (emptyEl) emptyEl.style.display = 'none'

    const header = `
      <div style="display:grid;grid-template-columns:1fr 2fr 88px;gap:10px;padding:6px 4px;font-size:11px;color:var(--text-tertiary);font-weight:500">
        <div>变量名</div>
        <div>值</div>
        <div style="text-align:right">操作</div>
      </div>
    `

    const body = rows.map((row, idx) => {
      if (row.editing) {
        return `
          <div class="env-row" data-idx="${idx}" style="display:grid;grid-template-columns:1fr 2fr 88px;gap:10px;align-items:center;padding:6px 4px;border-top:1px solid var(--border-primary)">
            <input type="text" class="input env-key-input" ${row.isNew ? '' : 'readonly'} value="${esc(row.key)}" placeholder="EXAMPLE_KEY" style="font-family:var(--font-mono, ui-monospace);font-size:12px;padding:4px 8px">
            <input type="text" class="input env-value-input" value="${esc(row.draftValue)}" placeholder="..." style="font-size:12px;padding:4px 8px">
            <div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-sm btn-primary env-save-btn" title="保存">${ICONS.save}</button>
              <button class="btn btn-sm btn-secondary env-cancel-btn" title="取消">${ICONS.cancel}</button>
            </div>
          </div>
        `
      }
      return `
        <div class="env-row" data-idx="${idx}" style="display:grid;grid-template-columns:1fr 2fr 88px;gap:10px;align-items:center;padding:6px 4px;border-top:1px solid var(--border-primary)">
          <code style="font-size:12px;color:var(--text-primary);word-break:break-all">${esc(row.key)}</code>
          <code style="font-size:12px;color:var(--text-secondary);word-break:break-all;opacity:0.8">${esc(maskValue(row.value))}</code>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-sm btn-secondary env-edit-btn" title="编辑">${ICONS.edit}</button>
            <button class="btn btn-sm btn-secondary env-delete-btn" title="删除" style="color:var(--error)">${ICONS.trash}</button>
          </div>
        </div>
      `
    }).join('')

    listEl.innerHTML = header + body
    renderFooter()
    bind()
  }

  function renderFooter() {
    const listEl = el.querySelector('#env-list')
    if (!listEl) return
    // Append footer after list contents
    const hasAddRow = rows.some(r => r.isNew)
    const footer = document.createElement('div')
    footer.style.cssText = 'margin-top:14px;display:flex;gap:10px'
    footer.innerHTML = hasAddRow
      ? ''
      : `<button class="btn btn-primary env-add-btn" style="display:inline-flex;align-items:center;gap:6px">${ICONS.plus} 添加变量</button>`
    // Remove existing footer
    const old = el.querySelector('.env-footer')
    if (old) old.remove()
    footer.className = 'env-footer'
    listEl.parentElement.appendChild(footer)

    footer.querySelector('.env-add-btn')?.addEventListener('click', () => {
      rows.push({ key: '', value: '', editing: true, draftValue: '', isNew: true })
      renderList()
      // Focus the newly created key input
      const inputs = el.querySelectorAll('.env-row')
      const last = inputs[inputs.length - 1]
      last?.querySelector('.env-key-input')?.focus()
    })
  }

  function bind() {
    el.querySelectorAll('.env-row').forEach((rowEl) => {
      const idx = Number(rowEl.dataset.idx)
      const row = rows[idx]
      if (!row) return

      rowEl.querySelector('.env-edit-btn')?.addEventListener('click', () => {
        row.editing = true
        row.draftValue = row.value
        renderList()
      })
      rowEl.querySelector('.env-cancel-btn')?.addEventListener('click', () => {
        if (row.isNew) {
          rows.splice(idx, 1)
        } else {
          row.editing = false
          row.draftValue = ''
        }
        renderList()
      })
      rowEl.querySelector('.env-save-btn')?.addEventListener('click', async () => {
        const keyInput = rowEl.querySelector('.env-key-input')
        const valueInput = rowEl.querySelector('.env-value-input')
        const newKey = (keyInput?.value || '').trim()
        const newValue = valueInput?.value || ''
        if (!newKey) {
          toast('变量名不能为空', 'warning')
          return
        }
        if (!/^[A-Z0-9_]+$/i.test(newKey)) {
          toast('变量名只能包含字母、数字和下划线', 'warning')
          return
        }
        try {
          await api.hermesEnvSet(newKey, newValue)
          row.key = newKey
          row.value = newValue
          row.editing = false
          row.isNew = false
          row.draftValue = ''
          toast('已保存', 'success')
          renderList()
        } catch (err) {
          toast(String(err).replace(/^Error:\s*/, ''), 'error')
        }
      })
      rowEl.querySelector('.env-delete-btn')?.addEventListener('click', async () => {
        if (!confirm(`确定删除 ${row.key} 吗？`)) return
        try {
          await api.hermesEnvDelete(row.key)
          rows.splice(idx, 1)
          toast('已删除', 'success')
          renderList()
        } catch (err) {
          toast(String(err).replace(/^Error:\s*/, ''), 'error')
        }
      })
    })
  }

  async function load() {
    loading = true
    loadError = null
    renderList()
    try {
      const list = await api.hermesEnvReadUnmanaged()
      // Rust returns Vec<(String, String)> serialized as [[k, v], ...]
      rows = (list || []).map(([k, v]) => ({
        key: k,
        value: v,
        editing: false,
        draftValue: '',
        isNew: false,
      }))
    } catch (err) {
      loadError = String(err).replace(/^Error:\s*/, '')
      const errEl = el.querySelector('#env-error')
      if (errEl) {
        errEl.textContent = loadError
        errEl.style.display = 'block'
      }
      rows = []
    } finally {
      loading = false
      renderList()
    }
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // Mask long values so sensitive secrets don't leak at a glance.
  function maskValue(v) {
    const s = String(v ?? '')
    if (s.length <= 12) return s
    return `${s.slice(0, 4)}…${s.slice(-4)}`
  }

  load()
  return el
}
