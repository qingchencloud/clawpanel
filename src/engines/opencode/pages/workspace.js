import { api, isTauriRuntime } from '../../../lib/tauri-api.js'
import { getOpenCodePort } from '../../../lib/model-channels.js'
import { t } from '../../../lib/i18n.js'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function render() {
  const page = document.createElement('div')
  page.className = 'page oc-workspace-page'
  page.dataset.engine = 'opencode'

  const state = {
    loading: true,
    status: null,
    error: '',
    embedError: '',
    embedUrl: '',
    embedPort: null,
    embedExpiresAt: 0,
    port: getOpenCodePort(),
  }
  function draw() {
    const status = state.status || {}
    const desktopAuthRestart = Boolean(isTauriRuntime() && status.requiresManagedAuth)
    const ready = Boolean(status.running && status.managed && !desktopAuthRestart)
    const sandbox = isTauriRuntime()
      ? 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups'
      : 'allow-scripts allow-forms allow-downloads allow-modals allow-popups'
    page.innerHTML = `
      <style>
        .oc-workspace-page{--oc:#4f7cff;min-height:100%;padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
        .oc-workspace-toolbar{min-height:58px;padding:9px 12px;border:1px solid var(--border-primary);border-radius:13px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
        .oc-workspace-heading{display:flex;align-items:center;gap:11px;min-width:0}.oc-workspace-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4f7cff,#7857ff);box-shadow:0 8px 20px color-mix(in srgb,var(--oc) 24%,transparent)}
        .oc-workspace-heading>div:last-child{display:grid;gap:2px;min-width:0}.oc-workspace-heading strong{font-size:14px;color:var(--text-primary)}.oc-workspace-heading span{font-size:11px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oc-workspace-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.oc-workspace-status{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:color-mix(in srgb,var(--success) 10%,var(--bg-primary));color:var(--success);font-size:11px}.oc-workspace-status::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
        .oc-workspace-shell{flex:1;min-height:680px;border:1px solid var(--border-primary);border-radius:14px;overflow:hidden;background:var(--bg-primary);box-shadow:var(--shadow-sm);display:flex}.oc-workspace-frame{display:block;width:100%;min-height:680px;border:0;background:#fff;flex:1}.oc-workspace-center{flex:1;min-height:680px;padding:32px;display:grid;place-items:center;text-align:center}.oc-workspace-empty{max-width:520px;display:grid;justify-items:center;gap:12px}.oc-workspace-empty-icon{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;color:var(--oc);background:color-mix(in srgb,var(--oc) 10%,var(--bg-secondary));border:1px solid color-mix(in srgb,var(--oc) 24%,var(--border-primary))}.oc-workspace-empty h1{margin:2px 0 0;font-size:22px;color:var(--text-primary)}.oc-workspace-empty p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.7}.oc-workspace-error{width:100%;padding:12px 14px;border:1px solid color-mix(in srgb,var(--error) 40%,var(--border-primary));border-radius:10px;color:var(--error);background:color-mix(in srgb,var(--error) 7%,var(--bg-primary));white-space:pre-wrap;word-break:break-word}
        @media(max-width:720px){.oc-workspace-page{padding:8px;padding-bottom:88px}.oc-workspace-toolbar{align-items:flex-start}.oc-workspace-actions{width:100%}.oc-workspace-actions .btn{flex:1;justify-content:center}.oc-workspace-shell,.oc-workspace-frame,.oc-workspace-center{min-height:calc(100vh - 190px)}}
      </style>
      <header class="oc-workspace-toolbar">
        <div class="oc-workspace-heading">
          <div class="oc-workspace-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg></div>
          <div><strong>${esc(t('openCode.workspaceTitle'))}</strong><span>${esc(t('openCode.workspacePageDesc'))}</span></div>
        </div>
        <div class="oc-workspace-actions">
          ${ready ? `<span class="oc-workspace-status">${esc(t('openCode.running'))}</span>` : ''}
          <button class="btn btn-secondary btn-sm" data-action="refresh">${esc(t('openCode.refresh'))}</button>
          ${ready ? `<button class="btn btn-secondary btn-sm" data-action="reload-frame" ${!state.embedUrl ? 'disabled' : ''}>${esc(t('openCode.reloadWorkspace'))}</button><button class="btn btn-secondary btn-sm" data-action="fullscreen" ${!state.embedUrl ? 'disabled' : ''}>${esc(t('openCode.fullscreen'))}</button>` : ''}
          <a class="btn btn-secondary btn-sm" href="#/opencode/dashboard">${esc(t('openCode.openConfiguration'))}</a>
        </div>
      </header>
      ${state.error || state.embedError ? `<div class="oc-workspace-error">${esc(state.error || state.embedError)}</div>` : ''}
      <section class="oc-workspace-shell">
        ${state.loading && !state.status
          ? `<div class="oc-workspace-center">${esc(t('openCode.workspaceLoading'))}</div>`
          : ready && state.embedUrl
            ? `<iframe id="oc-workspace-frame" class="oc-workspace-frame" src="${esc(state.embedUrl)}" title="${esc(t('openCode.workspaceTitle'))}" sandbox="${sandbox}" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>`
            : `<div class="oc-workspace-center"><div class="oc-workspace-empty"><div class="oc-workspace-empty-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></div><h1>${esc(t('openCode.workspaceUnavailableTitle'))}</h1><p>${esc(desktopAuthRestart ? t('openCode.workspaceAuthRestart') : t('openCode.workspaceUnavailableDesc'))}</p><a class="btn btn-primary" href="#/opencode/dashboard">${esc(t('openCode.openConfiguration'))}</a></div></div>`}
      </section>
    `
  }

  async function refresh() {
    state.loading = true
    state.error = ''
    state.embedError = ''
    try {
      state.status = await api.openCodeStatus(state.port)
      if (state.status?.running && state.status?.managed) {
        if (isTauriRuntime()) {
          state.embedUrl = `${state.status.url}/`
          state.embedPort = state.status.port
          state.embedExpiresAt = 0
        } else if (!state.embedUrl || state.embedPort !== state.status.port || Date.now() > state.embedExpiresAt - 60000) {
          try {
            const session = await api.openCodeEmbedSession(state.status.port)
            state.embedUrl = session.src
            state.embedPort = state.status.port
            state.embedExpiresAt = Number(session.expiresAt) || 0
          } catch (error) {
            state.embedUrl = ''
            state.embedPort = null
            state.embedExpiresAt = 0
            state.embedError = `${t('openCode.workspaceFailed')}: ${error?.message || error}`
          }
        }
      } else {
        state.embedUrl = ''
        state.embedPort = null
        state.embedExpiresAt = 0
      }
    } catch (error) {
      state.status = null
      state.error = `${t('openCode.loadFailed')}: ${error?.message || error}`
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
        const frame = page.querySelector('#oc-workspace-frame')
        if (frame && state.status?.url) frame.src = `${state.status.url}/?clawpanelReload=${Date.now()}`
        return
      }
      state.embedUrl = ''
      state.embedExpiresAt = 0
      return refresh()
    }
    if (action === 'fullscreen') await page.querySelector('#oc-workspace-frame')?.requestFullscreen?.()
  })

  draw()
  refresh()
  return page
}
