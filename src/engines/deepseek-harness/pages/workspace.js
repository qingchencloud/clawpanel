import { api, isTauriRuntime } from '../../../lib/tauri-api.js'
import { getDshPort } from '../../../lib/model-channels.js'
import { t } from '../../../lib/i18n.js'

const DSH_WEB_STORAGE_KEY = 'clawpanel-dsh-web-storage-v1'
const DSH_WEB_STORAGE_MAX_CHARS = 2 * 1024 * 1024
let _cleanupCurrent = null

function readDshWebStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DSH_WEB_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function bindDshStorageBridge(page) {
  const onMessage = event => {
    const frame = page.querySelector('#dsh-workspace-frame')
    if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return
    const message = event.data
    if (!message || message.type !== 'clawpanel-dsh-storage') return
    const values = readDshWebStorage()
    if (message.op === 'clear') {
      for (const key of Object.keys(values)) delete values[key]
    } else {
      const key = typeof message.key === 'string' ? message.key : ''
      if (!key || key.length > 256) return
      if (message.op === 'remove') delete values[key]
      else if (message.op === 'set' && typeof message.value === 'string' && message.value.length <= 512 * 1024) values[key] = message.value
      else return
    }
    try {
      const serialized = JSON.stringify(values)
      if (serialized.length <= DSH_WEB_STORAGE_MAX_CHARS) localStorage.setItem(DSH_WEB_STORAGE_KEY, serialized)
    } catch {}
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function render() {
  _cleanupCurrent?.()
  _cleanupCurrent = null
  const page = document.createElement('div')
  page.className = 'page dsh-workspace-page'
  page.dataset.engine = 'deepseek-harness'

  const state = {
    loading: true,
    status: null,
    error: '',
    embedError: '',
    embedUrl: '',
    embedPort: null,
    embedExpiresAt: 0,
    port: getDshPort(),
  }
  if (!isTauriRuntime()) _cleanupCurrent = bindDshStorageBridge(page)

  function draw() {
    const status = state.status || {}
    const ready = Boolean(status.running && status.managed)
    const sandbox = isTauriRuntime()
      ? 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups'
      : 'allow-scripts allow-forms allow-downloads allow-modals allow-popups'
    page.innerHTML = `
      <style>
        .dsh-workspace-page{--dsh:#4f7cff;min-height:100%;padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
        .dsh-workspace-toolbar{min-height:58px;padding:9px 12px;border:1px solid var(--border-primary);border-radius:13px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
        .dsh-workspace-heading{display:flex;align-items:center;gap:11px;min-width:0}.dsh-workspace-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4f7cff,#7857ff);box-shadow:0 8px 20px color-mix(in srgb,var(--dsh) 24%,transparent)}
        .dsh-workspace-heading>div:last-child{display:grid;gap:2px;min-width:0}.dsh-workspace-heading strong{font-size:14px;color:var(--text-primary)}.dsh-workspace-heading span{font-size:11px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-workspace-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-workspace-status{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:color-mix(in srgb,var(--success) 10%,var(--bg-primary));color:var(--success);font-size:11px}.dsh-workspace-status::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
        .dsh-workspace-shell{flex:1;min-height:680px;border:1px solid var(--border-primary);border-radius:14px;overflow:hidden;background:var(--bg-primary);box-shadow:var(--shadow-sm);display:flex}.dsh-workspace-frame{display:block;width:100%;min-height:680px;border:0;background:#fff;flex:1}.dsh-workspace-center{flex:1;min-height:680px;padding:32px;display:grid;place-items:center;text-align:center}.dsh-workspace-empty{max-width:520px;display:grid;justify-items:center;gap:12px}.dsh-workspace-empty-icon{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;color:var(--dsh);background:color-mix(in srgb,var(--dsh) 10%,var(--bg-secondary));border:1px solid color-mix(in srgb,var(--dsh) 24%,var(--border-primary))}.dsh-workspace-empty h1{margin:2px 0 0;font-size:22px;color:var(--text-primary)}.dsh-workspace-empty p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.7}.dsh-workspace-error{width:100%;padding:12px 14px;border:1px solid color-mix(in srgb,var(--error) 40%,var(--border-primary));border-radius:10px;color:var(--error);background:color-mix(in srgb,var(--error) 7%,var(--bg-primary));white-space:pre-wrap;word-break:break-word}
        @media(max-width:720px){.dsh-workspace-page{padding:8px;padding-bottom:88px}.dsh-workspace-toolbar{align-items:flex-start}.dsh-workspace-actions{width:100%}.dsh-workspace-actions .btn{flex:1;justify-content:center}.dsh-workspace-shell,.dsh-workspace-frame,.dsh-workspace-center{min-height:calc(100vh - 190px)}}
      </style>
      <header class="dsh-workspace-toolbar">
        <div class="dsh-workspace-heading">
          <div class="dsh-workspace-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg></div>
          <div><strong>${esc(t('deepseekHarness.workspaceTitle'))}</strong><span>${esc(t('deepseekHarness.workspacePageDesc'))}</span></div>
        </div>
        <div class="dsh-workspace-actions">
          ${ready ? `<span class="dsh-workspace-status">${esc(t('deepseekHarness.running'))}</span>` : ''}
          <button class="btn btn-secondary btn-sm" data-action="refresh">${esc(t('deepseekHarness.refresh'))}</button>
          ${ready ? `<button class="btn btn-secondary btn-sm" data-action="reload-frame" ${!state.embedUrl ? 'disabled' : ''}>${esc(t('deepseekHarness.reloadWorkspace'))}</button><button class="btn btn-secondary btn-sm" data-action="fullscreen" ${!state.embedUrl ? 'disabled' : ''}>${esc(t('deepseekHarness.fullscreen'))}</button>` : ''}
          <a class="btn btn-secondary btn-sm" href="#/dsh/dashboard">${esc(t('deepseekHarness.openConfiguration'))}</a>
        </div>
      </header>
      ${state.error || state.embedError ? `<div class="dsh-workspace-error">${esc(state.error || state.embedError)}</div>` : ''}
      <section class="dsh-workspace-shell">
        ${state.loading && !state.status
          ? `<div class="dsh-workspace-center">${esc(t('deepseekHarness.workspaceLoading'))}</div>`
          : ready && state.embedUrl
            ? `<iframe id="dsh-workspace-frame" class="dsh-workspace-frame" src="${esc(state.embedUrl)}" title="${esc(t('deepseekHarness.workspaceTitle'))}" sandbox="${sandbox}" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>`
            : `<div class="dsh-workspace-center"><div class="dsh-workspace-empty"><div class="dsh-workspace-empty-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></div><h1>${esc(t('deepseekHarness.workspaceUnavailableTitle'))}</h1><p>${esc(t('deepseekHarness.workspaceUnavailableDesc'))}</p><a class="btn btn-primary" href="#/dsh/dashboard">${esc(t('deepseekHarness.openConfiguration'))}</a></div></div>`}
      </section>
    `
  }

  async function refresh() {
    state.loading = true
    state.error = ''
    state.embedError = ''
    try {
      state.status = await api.dshStatus(state.port)
      if (state.status?.running && state.status?.managed) {
        if (isTauriRuntime()) {
          state.embedUrl = `${state.status.url}/`
          state.embedPort = state.status.port
          state.embedExpiresAt = 0
        } else if (!state.embedUrl || state.embedPort !== state.status.port || Date.now() > state.embedExpiresAt - 60000) {
          try {
            const session = await api.dshEmbedSession(state.status.port, readDshWebStorage())
            state.embedUrl = session.src
            state.embedPort = state.status.port
            state.embedExpiresAt = Number(session.expiresAt) || 0
          } catch (error) {
            state.embedUrl = ''
            state.embedPort = null
            state.embedExpiresAt = 0
            state.embedError = `${t('deepseekHarness.workspaceFailed')}: ${error?.message || error}`
          }
        }
      } else {
        state.embedUrl = ''
        state.embedPort = null
        state.embedExpiresAt = 0
      }
    } catch (error) {
      state.status = null
      state.error = `${t('deepseekHarness.loadFailed')}: ${error?.message || error}`
    } finally {
      state.loading = false
      draw()
    }
  }

  page.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    const action = button.dataset.action
    if (action === 'refresh') return refresh()
    if (action === 'reload-frame') {
      if (isTauriRuntime()) {
        const frame = page.querySelector('#dsh-workspace-frame')
        if (frame && state.status?.url) frame.src = `${state.status.url}/?clawpanelReload=${Date.now()}`
        return
      }
      state.embedUrl = ''
      state.embedExpiresAt = 0
      return refresh()
    }
    if (action === 'fullscreen') await page.querySelector('#dsh-workspace-frame')?.requestFullscreen?.()
  })

  draw()
  refresh()
  return page
}

export function cleanup() {
  _cleanupCurrent?.()
  _cleanupCurrent = null
}
