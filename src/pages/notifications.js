/**
 * 推送通知设置（P1-0）
 *
 * 对接 OpenClaw 内核 push.web.* RPC：
 *   - 启用/关闭浏览器系统级推送
 *   - 展示当前订阅状态（含端点摘要）
 *   - 发测试通知（让用户立刻确认链路通了）
 *
 * 即使 ClawPanel 关掉，系统通知中心依然能收到 Agent / Cron / 渠道消息。
 */
import { t } from '../lib/i18n.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import {
  isPushSupported,
  pushPermission,
  getCurrentSubscription,
  subscribePush,
  unsubscribePush,
  sendTestPush,
} from '../lib/push-web.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(t('notifications.title'))}</h1>
        <p class="page-desc">${escapeHtml(t('notifications.desc'))}</p>
      </div>
    </div>
    <div id="push-content">
      <div style="padding:32px;text-align:center;color:var(--text-tertiary)">${escapeHtml(t('common.loading'))}…</div>
    </div>
  `

  loadAndRender(page)
  return page
}

async function loadAndRender(page) {
  const content = page.querySelector('#push-content')

  if (!isPushSupported()) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🚫</div>
        <div class="empty-title">${escapeHtml(t('notifications.unsupportedTitle'))}</div>
        <div class="empty-desc">${escapeHtml(t('notifications.unsupportedDesc'))}</div>
      </div>
    `
    return
  }

  const perm = pushPermission()
  let sub = null
  try { sub = await getCurrentSubscription() } catch {}

  content.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">${escapeHtml(t('notifications.statusTitle'))}</div>
      <div class="push-status-row">
        <div class="push-status-item">
          <div class="push-status-label">${escapeHtml(t('notifications.permissionLabel'))}</div>
          <div class="push-status-value">${renderPermBadge(perm)}</div>
        </div>
        <div class="push-status-item">
          <div class="push-status-label">${escapeHtml(t('notifications.subscriptionLabel'))}</div>
          <div class="push-status-value">${
            sub
              ? `<span class="lazy-deps-badge ok">✓ ${escapeHtml(t('notifications.subscribed'))}</span>`
              : `<span class="lazy-deps-badge warn">${escapeHtml(t('notifications.notSubscribed'))}</span>`
          }</div>
        </div>
      </div>
      ${sub ? `
        <div class="form-hint" style="margin-top:var(--space-md);word-break:break-all">
          <strong>${escapeHtml(t('notifications.endpointLabel'))}</strong>
          <code style="display:inline-block;font-size:11px;margin-left:8px;color:var(--text-tertiary)">${escapeHtml(truncateEndpoint(sub.endpoint))}</code>
        </div>
      ` : ''}
    </div>

    <div class="config-section">
      <div class="config-section-title">${escapeHtml(t('notifications.actionsTitle'))}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${sub
          ? `<button class="btn btn-secondary btn-sm" id="btn-unsub">${escapeHtml(t('notifications.unsubscribeBtn'))}</button>
             <button class="btn btn-primary btn-sm" id="btn-test">${escapeHtml(t('notifications.testBtn'))}</button>`
          : `<button class="btn btn-primary btn-sm" id="btn-sub">${escapeHtml(t('notifications.subscribeBtn'))}</button>`
        }
      </div>
      <div class="form-hint" style="margin-top:var(--space-sm)">${escapeHtml(t('notifications.hint'))}</div>
    </div>
  `

  // 绑定按钮
  page.querySelector('#btn-sub')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = t('notifications.subscribing') + '…'
    try {
      await subscribePush()
      toast(t('notifications.subscribeSuccess'), 'success')
      loadAndRender(page)
    } catch (err) {
      toast(humanizeError(err, t('notifications.subscribeFailed')), 'error')
    } finally {
      btn.disabled = false
      btn.textContent = orig
    }
  })

  page.querySelector('#btn-unsub')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      await unsubscribePush()
      toast(t('notifications.unsubscribeSuccess'), 'success')
      loadAndRender(page)
    } catch (err) {
      toast(humanizeError(err, t('notifications.unsubscribeFailed')), 'error')
    } finally {
      btn.disabled = false
    }
  })

  page.querySelector('#btn-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = t('notifications.sending') + '…'
    try {
      const resp = await sendTestPush(
        t('notifications.testTitle'),
        t('notifications.testBody')
      )
      const count = Array.isArray(resp?.results) ? resp.results.length : 0
      toast({
        message: t('notifications.testSent'),
        hint: count ? t('notifications.testDelivered', { n: count }) : '',
      }, 'success')
    } catch (err) {
      toast(humanizeError(err, t('notifications.testFailed')), 'error')
    } finally {
      btn.disabled = false
      btn.textContent = orig
    }
  })
}

function renderPermBadge(perm) {
  if (perm === 'granted') return `<span class="lazy-deps-badge ok">✓ ${escapeHtml(t('notifications.permGranted'))}</span>`
  if (perm === 'denied')  return `<span class="lazy-deps-badge warn">${escapeHtml(t('notifications.permDenied'))}</span>`
  if (perm === 'default') return `<span class="lazy-deps-badge unknown">${escapeHtml(t('notifications.permDefault'))}</span>`
  return `<span class="lazy-deps-badge unknown">${escapeHtml(t('notifications.permUnsupported'))}</span>`
}

function truncateEndpoint(ep) {
  if (!ep) return ''
  if (ep.length <= 80) return ep
  return ep.slice(0, 40) + '…' + ep.slice(-30)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
