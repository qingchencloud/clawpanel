/**
 * Hermes OAuth 三种登录（Batch 3 §Q）
 *
 * 全部走 dashboard 9119（hermes_dashboard_api_proxy 自动注入 session token）：
 *   - GET    /api/providers/oauth                            - 列表 + 状态
 *   - POST   /api/providers/oauth/{id}/start                 - 启动
 *     · PKCE: 返回 { session_id, flow:"pkce", auth_url }
 *     · device_code: 返回 { session_id, flow:"device_code", user_code, verification_url }
 *   - POST   /api/providers/oauth/{id}/submit { session_id, code }  - PKCE 提交回调
 *   - GET    /api/providers/oauth/{id}/poll/{session_id}     - 公开轮询（device_code）
 *   - DELETE /api/providers/oauth/{id}                       - 断开
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { showModal, showContentModal } from '../../../components/modal.js'
import { humanizeError } from '../../../lib/humanize-error.js'
import { svgIcon } from '../lib/svg-icons.js'

const OAUTH_BASE = '/api/providers/oauth'

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(s) { return escHtml(s) }

function renderInlineError(err) {
  const h = humanizeError(err, t('engine.hermesOAuthTitle'))
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

  let providers = []
  let loading = true
  let error = ''

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escHtml(t('engine.hermesOAuthTitle'))}</h1>
          <p class="page-desc">${escHtml(t('engine.hermesOAuthDesc'))}</p>
        </div>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm" id="hm-oauth-refresh">${escHtml(t('hermesLazyDeps.refresh'))}</button>
        </div>
      </div>
      <div id="hm-oauth-content">
        ${loading ? `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escHtml(t('common.loading'))}…</div>` : ''}
        ${error ? renderInlineError(error) : ''}
        ${(!loading && !error && !providers.length) ? `
          <div class="empty-state empty-compact">
            <div class="empty-icon">${svgIcon('lock', { size: 32 })}</div>
            <div class="empty-title">${escHtml(t('engine.hermesOAuthEmpty'))}</div>
          </div>` : ''}
        ${(!loading && providers.length) ? `
          <div class="lazy-deps-grid">
            ${providers.map(renderProviderCard).join('')}
          </div>` : ''}
      </div>
    `
    bind()
  }

  function renderProviderCard(p) {
    const loggedIn = !!p.status?.logged_in
    const flowLabel = {
      pkce: t('engine.hermesOAuthFlowPkce'),
      device_code: t('engine.hermesOAuthFlowDevice'),
      external: t('engine.hermesOAuthFlowExternal'),
    }[p.flow] || p.flow
    const sourceLabel = p.status?.source_label || ''
    const tokenPrev = p.status?.token_preview || ''
    const expires = p.status?.expires_at || ''
    return `
      <div class="lazy-deps-card">
        <div class="lazy-deps-card-head">
          <div class="lazy-deps-card-title" title="${escAttr(p.id)}">${escHtml(p.name)}</div>
          ${loggedIn ? `<span class="lazy-deps-badge ok">${escHtml(t('engine.hermesOAuthConnected'))}</span>` : `<span class="lazy-deps-badge">${escHtml(t('engine.hermesOAuthDisconnected'))}</span>`}
        </div>
        <div class="lazy-deps-card-meta">${escHtml(flowLabel)}</div>
        ${loggedIn && sourceLabel ? `<div class="lazy-deps-card-meta" title="${escAttr(sourceLabel)}">${escHtml(sourceLabel)}</div>` : ''}
        ${loggedIn && tokenPrev ? `<div class="lazy-deps-card-meta" style="font-family:var(--font-mono);font-size:11px">…${escHtml(tokenPrev)}</div>` : ''}
        ${loggedIn && expires ? `<div class="lazy-deps-card-meta">${escHtml(t('engine.hermesOAuthExpires'))}: ${escHtml(expires)}</div>` : ''}
        <div class="lazy-deps-card-actions" style="gap:6px">
          ${loggedIn
            ? `<button class="btn btn-secondary btn-sm" data-action="disconnect" data-id="${escAttr(p.id)}" style="color:var(--error)">${escHtml(t('engine.hermesOAuthDisconnect'))}</button>`
            : `<button class="btn btn-primary btn-sm" data-action="connect" data-id="${escAttr(p.id)}" data-flow="${escAttr(p.flow)}" data-cli="${escAttr(p.cli_command || '')}">${escHtml(t('engine.hermesOAuthConnect'))}</button>`}
          ${p.docs_url ? `<a class="btn btn-secondary btn-sm" href="${escAttr(p.docs_url)}" target="_blank" rel="noopener">${escHtml(t('engine.hermesOAuthDocs'))}</a>` : ''}
        </div>
      </div>
    `
  }

  function bind() {
    el.querySelector('#hm-oauth-refresh')?.addEventListener('click', load)
    el.querySelectorAll('[data-action]').forEach(btn => {
      const action = btn.dataset.action
      btn.addEventListener('click', () => {
        if (action === 'connect') {
          onConnect(btn.dataset.id, btn.dataset.flow, btn.dataset.cli || '')
        } else if (action === 'disconnect') {
          onDisconnect(btn.dataset.id)
        }
      })
    })
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      const data = await api.hermesDashboardApi('GET', OAUTH_BASE)
      providers = data?.providers || []
    } catch (e) {
      error = e
    } finally {
      loading = false
      draw()
    }
  }

  async function onConnect(providerId, flow, cliCommand) {
    if (flow === 'external') {
      showContentModal({
        title: t('engine.hermesOAuthExternalTitle', { id: providerId }),
        content: `
          <p>${escHtml(t('engine.hermesOAuthExternalHint'))}</p>
          <pre style="background:var(--surface-1);padding:12px;border-radius:6px;font-family:var(--font-mono);font-size:12px">${escHtml(cliCommand || 'hermes auth add ' + providerId)}</pre>
          <p style="color:var(--text-tertiary);font-size:12px;margin-top:12px">${escHtml(t('engine.hermesOAuthExternalRefresh'))}</p>
        `,
        buttons: [{ label: t('common.close'), className: 'btn-secondary' }],
        width: 520,
      })
      return
    }

    try {
      const resp = await api.hermesDashboardApi('POST', `${OAUTH_BASE}/${encodeURIComponent(providerId)}/start`)
      if (flow === 'pkce') {
        await runPkceFlow(providerId, resp)
      } else if (flow === 'device_code') {
        await runDeviceCodeFlow(providerId, resp)
      } else {
        toast(t('engine.hermesOAuthUnknownFlow', { flow }), 'error')
      }
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesOAuthStartFailed')), 'error')
    }
  }

  async function runPkceFlow(providerId, resp) {
    const authUrl = resp?.auth_url
    const sessionId = resp?.session_id
    if (!authUrl || !sessionId) {
      toast(t('engine.hermesOAuthBadResponse'), 'error')
      return
    }
    // 打开浏览器（系统默认）
    try { window.open(authUrl, '_blank', 'noopener') } catch {}
    // 显示弹窗让用户填回调 code
    showModal({
      title: t('engine.hermesOAuthPkceTitle'),
      fields: [
        {
          name: 'url',
          label: t('engine.hermesOAuthPkceAuthLink'),
          value: authUrl,
          readonly: true,
          hint: t('engine.hermesOAuthPkceUrlHint'),
        },
        {
          name: 'code',
          label: t('engine.hermesOAuthPkceCodeLabel'),
          value: '',
          placeholder: 'authorization_code',
          hint: t('engine.hermesOAuthPkceCodeHint'),
        },
      ],
      onConfirm: async (data) => {
        const code = (data.code || '').trim()
        if (!code) {
          toast(t('engine.hermesOAuthCodeRequired'), 'error')
          return
        }
        try {
          await api.hermesDashboardApi('POST', `${OAUTH_BASE}/${encodeURIComponent(providerId)}/submit`, {
            session_id: sessionId,
            code,
          })
          toast(t('engine.hermesOAuthConnected'), 'success')
          await load()
        } catch (e) {
          toast(humanizeError(e, t('engine.hermesOAuthSubmitFailed')), 'error')
        }
      },
    })
  }

  async function runDeviceCodeFlow(providerId, resp) {
    const userCode = resp?.user_code
    const verifUrl = resp?.verification_url
    const sessionId = resp?.session_id
    if (!userCode || !verifUrl || !sessionId) {
      toast(t('engine.hermesOAuthBadResponse'), 'error')
      return
    }
    // 打开浏览器
    try { window.open(verifUrl, '_blank', 'noopener') } catch {}
    // 显示 user_code + 自动轮询
    const modal = showContentModal({
      title: t('engine.hermesOAuthDeviceTitle'),
      content: `
        <p>${escHtml(t('engine.hermesOAuthDeviceHint'))}</p>
        <div style="text-align:center;margin:16px 0">
          <div style="font-size:28px;font-weight:600;letter-spacing:4px;font-family:var(--font-mono);background:var(--surface-1);padding:14px 20px;border-radius:8px;display:inline-block">${escHtml(userCode)}</div>
        </div>
        <p style="font-size:12px;color:var(--text-tertiary);text-align:center">${escHtml(verifUrl)}</p>
        <div id="hm-oauth-device-status" style="margin-top:16px;padding:12px;background:var(--surface-1);border-radius:6px;font-size:13px;color:var(--text-secondary);text-align:center">${escHtml(t('engine.hermesOAuthDeviceWaiting'))}</div>
      `,
      buttons: [{ label: t('common.close'), className: 'btn-secondary' }],
      width: 520,
    })

    // 轮询
    let stopped = false
    modal.addEventListener?.('click', (e) => {
      if (e.target.dataset?.action === 'close' || e.target.closest?.('[data-action="close"]')) stopped = true
    })
    // 兜底：modal 移除时停轮询
    const observer = new MutationObserver(() => {
      if (!modal.isConnected) {
        stopped = true
        observer.disconnect()
      }
    })
    if (modal.parentNode) observer.observe(modal.parentNode, { childList: true })

    const startTime = Date.now()
    const TIMEOUT_MS = 10 * 60 * 1000  // 10 min
    while (!stopped) {
      await new Promise(r => setTimeout(r, 2500))
      if (stopped) break
      if (Date.now() - startTime > TIMEOUT_MS) {
        const statusEl = modal.querySelector?.('#hm-oauth-device-status')
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--error)">${escHtml(t('engine.hermesOAuthDeviceTimeout'))}</span>`
        break
      }
      try {
        const st = await api.hermesDashboardApi('GET', `${OAUTH_BASE}/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`)
        const status = String(st?.status || '')
        if (status === 'success') {
          toast(t('engine.hermesOAuthConnected'), 'success')
          modal.remove?.()
          await load()
          break
        }
        if (status === 'failed' || status === 'expired') {
          const statusEl = modal.querySelector?.('#hm-oauth-device-status')
          if (statusEl) {
            const errMsg = st?.error_message || t('engine.hermesOAuthDeviceFailed')
            statusEl.innerHTML = `<span style="color:var(--error)">${escHtml(errMsg)}</span>`
          }
          break
        }
        // 仍 pending — 继续轮询
      } catch (e) {
        // 404 = session 已 GC，停轮询
        if (String(e?.message).includes('404')) break
        // 其他错误：继续轮询（短暂网络问题）
      }
    }
  }

  async function onDisconnect(providerId) {
    try {
      await api.hermesDashboardApi('DELETE', `${OAUTH_BASE}/${encodeURIComponent(providerId)}`)
      toast(t('engine.hermesOAuthDisconnected'), 'success')
      await load()
    } catch (e) {
      toast(humanizeError(e, t('engine.hermesOAuthDisconnectFailed')), 'error')
    }
  }

  draw()
  load()
  return el
}
