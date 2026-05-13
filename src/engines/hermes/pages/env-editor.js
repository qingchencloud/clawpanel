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
import { humanizeError } from '../../../lib/humanize-error.js'

// NOTE: i18n keys for this page are not yet wired up in src/locales; using
// inline Chinese copy (with occasional English fallback) for now. When the
// translation module lands, replace these literals with `t('hermesEnv.*')`.

const ICONS = {
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  cancel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'

  let rows = []            // [{ key, value, editing: false, draftValue: '', isNew: false }]
  let loading = true
  let loadError = null

  el.innerHTML = skeleton()

  function skeleton() {
    return `
      <!-- Hero: editorial title + back link -->
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">
            <a href="#/h/dashboard" style="color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px">
              ${ICONS.back} back to dashboard
            </a>
          </div>
          <h1 class="hm-hero-h1">.env editor</h1>
          <div class="hm-hero-sub">custom environment variables · ~/.hermes/.env</div>
        </div>
      </div>

      <!-- Notice panel: which keys are managed elsewhere -->
      <div class="hm-panel" style="margin-bottom:18px">
        <div class="hm-panel-body hm-panel-body--tight">
          <div style="font-family:var(--hm-font-serif);font-style:italic;font-size:13px;color:var(--hm-text-tertiary);line-height:1.75">
            以下变量由 ClawPanel 在仪表盘「模型配置」中托管：
            <code class="hm-code">OPENAI_API_KEY</code>
            <code class="hm-code">ANTHROPIC_API_KEY</code>
            <code class="hm-code">DEEPSEEK_API_KEY</code>
            等 provider 密钥及 base URL，以及
            <code class="hm-code">GATEWAY_ALLOW_ALL_USERS</code>
            <code class="hm-code">API_SERVER_KEY</code>。
            请通过仪表盘修改这些项——本页仅管理你的自定义变量（如
            <code class="hm-code">TAVILY_API_KEY</code>、
            <code class="hm-code">HTTP_PROXY</code>、
            skills 自定义变量等）。
          </div>
        </div>
      </div>

      <!-- Variables panel -->
      <div class="hm-panel">
        <div class="hm-panel-header">
          <div class="hm-panel-title">
            <svg class="hm-panel-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            custom.env
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted" id="env-row-count"></span>
          </div>
        </div>
        <div class="hm-panel-body hm-panel-body--none">
          <div id="env-list"></div>
          <div id="env-empty" style="display:none;padding:32px 28px;text-align:center">
            <div style="font-family:var(--hm-font-serif);font-style:italic;font-size:14px;color:var(--hm-text-tertiary);margin-bottom:6px">no custom variables yet</div>
            <div class="hm-muted">click "add variable" below to create one</div>
          </div>
          <div id="env-error" style="display:none;margin:14px 28px;padding:10px 14px;background:var(--hm-error-soft);border-radius:var(--hm-radius-sm);color:var(--hm-error);font-family:var(--hm-font-mono);font-size:12px"></div>
        </div>
      </div>
    `
  }

  function renderList() {
    const listEl = el.querySelector('#env-list')
    const emptyEl = el.querySelector('#env-empty')
    if (!listEl) return

    // update count badge in panel header
    const countEl = el.querySelector('#env-row-count')
    if (countEl) {
      countEl.textContent = loading ? '' : (rows.length ? `${rows.length} variable${rows.length > 1 ? 's' : ''}` : '')
    }

    if (loading) {
      listEl.innerHTML = `
        <div style="padding:28px 28px;text-align:center">
          <div class="hm-skel" style="width:60%;height:14px;margin:0 auto 10px"></div>
          <div class="hm-skel" style="width:40%;height:12px;margin:0 auto"></div>
        </div>
      `
      if (emptyEl) emptyEl.style.display = 'none'
      return
    }

    if (!rows.length) {
      listEl.innerHTML = ''
      if (emptyEl) emptyEl.style.display = 'block'
      renderFooter()
      return
    }

    if (emptyEl) emptyEl.style.display = 'none'

    // Table-style header
    const header = `
      <div style="display:grid;grid-template-columns:1fr 2fr 148px;gap:14px;padding:14px 28px;font-family:var(--hm-font-serif);font-style:italic;font-size:12px;color:var(--hm-text-tertiary);background:var(--hm-surface-0);border-bottom:1px solid var(--hm-border)">
        <div>variable</div>
        <div>value</div>
        <div style="text-align:right">action</div>
      </div>
    `

    const body = rows.map((row, idx) => {
      if (row.editing) {
        return `
          <div class="env-row" data-idx="${idx}" style="display:grid;grid-template-columns:1fr 2fr 148px;gap:14px;align-items:center;padding:12px 28px;border-bottom:1px solid var(--hm-border-subtle);background:var(--hm-accent-soft)">
            <input type="text" class="hm-input env-key-input" ${row.isNew ? '' : 'readonly'} value="${esc(row.key)}" placeholder="EXAMPLE_KEY" style="height:32px;font-size:12px">
            <input type="text" class="hm-input env-value-input" value="${esc(row.draftValue)}" placeholder="value..." style="height:32px;font-size:12px">
            <div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="hm-btn hm-btn--cta hm-btn--sm env-save-btn" title="保存">${ICONS.save}</button>
              <button class="hm-btn hm-btn--sm env-cancel-btn" title="取消">${ICONS.cancel}</button>
            </div>
          </div>
        `
      }
      return `
        <div class="env-row" data-idx="${idx}" style="display:grid;grid-template-columns:1fr 2fr 148px;gap:14px;align-items:center;padding:14px 28px;border-bottom:1px solid var(--hm-border-subtle);transition:background 180ms ease">
          <code class="hm-code" style="background:transparent;border:none;padding:0;font-size:12px;color:var(--hm-text-primary);word-break:break-all">${esc(row.key)}</code>
          <code class="hm-code" style="background:transparent;border:none;padding:0;font-size:12px;color:var(--hm-text-tertiary);word-break:break-all">${esc(row.revealed ? row.value : maskValue(row.value))}</code>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="hm-btn hm-btn--icon env-reveal-btn" title="${row.revealed ? '隐藏' : '明文'}">${ICONS.eye}</button>
            <button class="hm-btn hm-btn--icon env-edit-btn" title="编辑">${ICONS.edit}</button>
            <button class="hm-btn hm-btn--icon env-delete-btn" title="删除" style="color:var(--hm-error)">${ICONS.trash}</button>
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
    footer.style.cssText = 'padding:18px 28px;border-top:1px solid var(--hm-border);display:flex;gap:10px;align-items:center'
    footer.innerHTML = hasAddRow
      ? '<span class="hm-muted">editing new variable…</span>'
      : `<button class="hm-btn hm-btn--cta env-add-btn">${ICONS.plus} 添加变量</button>
         <span class="hm-spacer"></span>
         <span class="hm-muted">changes take effect on next gateway restart</span>`
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
      rowEl.querySelector('.env-reveal-btn')?.addEventListener('click', async () => {
        if (row.revealed) {
          row.revealed = false
          renderList()
          return
        }
        try {
          const data = await api.hermesEnvReveal(row.key)
          row.value = data?.value ?? row.value
          row.revealed = true
          renderList()
        } catch (err) {
          toast(humanizeError(err, '读取失败'), 'error')
        }
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
          toast(humanizeError(err, '保存失败'), 'error')
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
          toast(humanizeError(err, '删除失败'), 'error')
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
        revealed: false,
        isNew: false,
      }))
    } catch (err) {
      loadError = humanizeError(err, '加载失败')
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
