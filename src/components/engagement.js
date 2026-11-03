/** 邀请与社区入口。本人链接只读，自动提示保持节制。 */
import { getLang, onLangChange, t } from '../lib/i18n.js'
import { isTauriRuntime } from '../lib/tauri-api.js'
import * as platformAccount from '../lib/platform-account.js'
import '../style/engagement.css'

const KEYS = {
  firstOpen: 'clawpanel_first_open', openCount: 'clawpanel_open_count',
  lastShown: 'clawpanel_engage_shown', never: 'clawpanel_engage_never', todayDismiss: 'clawpanel_engage_today',
}
const DAY = 86400000
const PROJECT_URL = 'https://claw.qt.cool'
const STAR_URL = 'https://github.com/qingchencloud/clawpanel'
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const read = key => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
let activeDialog = null

if (!read(KEYS.firstOpen)) write(KEYS.firstOpen, String(Date.now()))
write(KEYS.openCount, String((parseInt(read(KEYS.openCount) || '0') || 0) + 1))

function canShowAutomatically() {
  if (read(KEYS.never) === '1' || read(KEYS.todayDismiss) === today()) return false
  if (Number(read(KEYS.openCount)) < 2 || Date.now() - Number(read(KEYS.firstOpen)) < DAY) return false
  if (/\/(chat|assistant)(?:[/?#]|$)/.test(location.hash)) return false
  if (document.activeElement?.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false
  return !document.querySelector('.modal-overlay,[role="dialog"],.site-message-overlay,.engage-overlay')
}

// 链接与邀请码必须成对匹配；不能由成员ID或缺失的邀请码自行拼接。
function ownInvitation(state) {
  if (!isTauriRuntime() || !['logged_in', 'bound'].includes(state?.phase) || !state.member || state.benefits?.status !== 'ready') return null
  const { invite_code: code, invite_url: raw } = state.benefits.referrals || {}
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(code) || typeof raw !== 'string') return null
  try {
    const origin = new URL(state.origin)
    const url = new URL(raw)
    const query = [...url.searchParams.entries()]
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    if (url.origin !== origin.origin || url.pathname !== '/member' || url.username || url.password || url.hash) return null
    if (query.length !== 1 || query[0][0] !== 'invite' || query[0][1] !== code) return null
    return raw
  } catch { return null }
}

function identity(state) { return `${state?.epoch ?? ''}:${state?.member?.member_id ?? ''}` }
function invitationCopy(state) {
  const copy = state?.benefits?.invitationCopy
  const language = getLang().startsWith('zh') ? 'zh' : 'en'
  const title = typeof copy?.[`title_${language}`] === 'string' ? copy[`title_${language}`] : ''
  const subtitle = typeof copy?.[`subtitle_${language}`] === 'string' ? copy[`subtitle_${language}`] : ''
  return { title, subtitle }
}
function guestOffer(offer) {
  if (!offer) return t('engagement.offerLoading')
  if (offer.simulation === true) return t('engagement.offerSimulation')
  const amount = offer.offer?.amount_micro_cny
  const hasHours = offer.offer && Object.hasOwn(offer.offer, 'valid_hours')
  const duration = hasHours ? offer.offer.valid_hours : offer.offer?.valid_days
  if (offer.status !== 'offered' || offer.registration_rewards_enabled !== true || !/^\d+$/.test(String(amount ?? '')) || !Number.isSafeInteger(duration) || duration < 1 || duration > (hasHours ? 720 : 30)) return t('engagement.offerWebsite')
  if (BigInt(amount) === 0n) return t('engagement.offerZero')
  return t(hasHours ? 'engagement.offerAvailableHours' : 'engagement.offerAvailable', { credits: platformAccount.formatCredits(amount), hours: duration, days: duration })
}

// 摘要只读取当前招募活动；本人冻结规则、注册礼和累计收益不能替代当前面额。
function currentInvitationRewards(state) {
  const campaign = state.benefits?.currentCampaign
  const result = (status, key, inviter = null, invitee = null) => ({ state: status, key: `engagement.${key}`, inviter, invitee })
  if (state.benefits?.status !== 'ready') return result('unavailable', 'campaignUnavailable')
  if (campaign?.simulation === true || state.benefits?.referrals?.simulation === true || state.platformStatus?.fixture_mode === true) return result('simulation', 'rewardsSimulation')
  if (campaign?.reward_delivery_enabled === false || state.benefits?.referrals?.reward_delivery_enabled === false || state.platformStatus?.referral_rewards_enabled === false) return result('closed', 'rewardsClosed')
  if (!campaign || campaign.reward_delivery_enabled !== true) return result('unavailable', 'campaignUnavailable')
  const starts = Date.parse(campaign.starts_at), ends = Date.parse(campaign.ends_at), now = Date.now()
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends) return result('unavailable', 'campaignUnavailable')
  if (ends <= now || ['ended', 'expired'].includes(campaign.status)) return result('ended', 'campaignEnded')
  if (starts > now) return result('upcoming', 'campaignUpcoming')
  if (campaign.status !== 'active') return result('closed', 'rewardsClosed')
  const amount = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,32}$/.test(String(value)) ? BigInt(value).toString() : null
  const inviter = amount(campaign.inviter_credits), invitee = amount(campaign.invitee_credits)
  return inviter === null || invitee === null ? result('unavailable', 'campaignUnavailable') : result('active', 'campaignHint', inviter, invitee)
}

/** 手动入口不受“今日不再提醒”限制；不主动登录、报名或生成邀请码。 */
export function showInvitationDialog({ manual = true } = {}) {
  if (activeDialog?.isConnected) return activeDialog
  if (!manual && !canShowAutomatically()) return null
  const trigger = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'engage-overlay'
  overlay.dataset.invitationDialog = ''
  activeDialog = overlay
  let closed = false
  let feedback = null
  let busy = false
  let posterPanel = null, posterOpening = false
  const unsubscribers = []
  const disclosureState = { copy: false, community: false }
  write(KEYS.lastShown, String(Date.now()))
  write(KEYS.todayDismiss, today())

  function close(restoreFocus = true) {
    if (closed) return
    closed = true
    posterPanel?.dispose(); posterPanel = null
    for (const unsubscribe of unsubscribers) unsubscribe?.()
    overlay.remove()
    if (activeDialog === overlay) activeDialog = null
    if (restoreFocus && trigger?.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true })
  }

  function rememberDisclosures() {
    for (const details of overlay.querySelectorAll('details[data-invitation-disclosure]')) disclosureState[details.dataset.invitationDisclosure] = details.open;
  }

  function draw() {
    if (closed || posterPanel) return
    const state = platformAccount.getPlatformAccount()
    const ownUrl = ownInvitation(state)
    const copy = invitationCopy(state)
    const hasCopy = Boolean(copy.title.trim() || copy.subtitle.trim())
    const desktop = isTauriRuntime()
    const member = !!state.member
    const bound = state.phase === 'bound'
    const rewards = currentInvitationRewards(state)
    const focused = overlay.contains(document.activeElement) ? document.activeElement : null
    const focusHook = focused ? [...focused.attributes].find(attr => attr.name.startsWith('data-invitation-'))?.name : null
    const scrollTop = overlay.querySelector('.engage-modal')?.scrollTop || 0
    rememberDisclosures()
    let stateText = t('engagement.guestState')
    if (ownUrl) stateText = t(hasCopy ? 'engagement.personalState' : 'engagement.personalLinkState')
    else if (!desktop) stateText = t('engagement.webState')
    else if (member && !bound) stateText = t(['reauth_required', 'storage_error'].includes(state.phase) ? 'engagement.reauthorizeState' : 'engagement.connectState')
    else if (bound && state.benefits?.status === 'scope_required') stateText = t('engagement.scopeState')
    else if (bound && !ownUrl) stateText = t('engagement.unavailableState')
    const posterAction = desktop && member && ['logged_in', 'bound'].includes(state.phase) ? `<button type="button" class="btn btn-secondary" data-invitation-poster>${escape(t('engagement.posterEntry'))}</button>` : ''
    overlay.innerHTML = `
      <section class="engage-modal invitation-modal" role="dialog" aria-modal="true" aria-labelledby="invitation-title" aria-describedby="invitation-state" tabindex="-1">
        <button type="button" class="engage-close" data-invitation-close aria-label="${escape(t('common.close'))}">&times;</button>
        <header class="invitation-heading"><p class="invitation-eyebrow">ClawPanel</p><h2 id="invitation-title">${escape(t('engagement.inviteTitle'))}</h2></header>
        ${member ? `<p class="invitation-account">${escape(state.member.email_masked || t('engagement.connectedAccount'))}</p>` : ''}
        <p id="invitation-state" class="invitation-description" data-invitation-state>${escape(stateText)}</p>
        ${member ? `<section class="invitation-rewards" data-invitation-rewards data-campaign-state="${rewards.state}" aria-label="${escape(t('engagement.currentCampaign'))}">
          <div class="invitation-reward-grid">${[['inviter', 'forInviter'], ['invitee', 'forFriend']].map(([role, label]) => `<div class="invitation-reward-item" data-invitation-reward-item="${role}"><span>${escape(t(`engagement.${label}`))}</span><div class="invitation-reward-amount"><strong data-invitation-reward="${role}">${escape(rewards[role] ?? '—')}</strong>${rewards[role] !== null ? `<span>${escape(t('engagement.credits'))}</span>` : ''}</div>${rewards[role] === '0' ? `<small>${escape(t('engagement.noReward'))}</small>` : ''}</div>`).join('')}</div>
          <div class="invitation-campaign-guidance"><p class="${['simulation', 'closed'].includes(rewards.state) ? 'invitation-reward-restriction' : ''}" ${['simulation', 'closed'].includes(rewards.state) ? 'data-invitation-reward-restriction' : ''} data-invitation-campaign-hint>${escape(t(rewards.key))}</p>${desktop ? `<button type="button" class="invitation-rule-link" data-invitation-official>${escape(t('engagement.rulesProgress'))} ↗</button>` : ''}</div>
        </section>` : ''}
        ${ownUrl ? `
          <div class="invitation-personal">
            <label for="invitation-url">${escape(t('engagement.linkLabel'))}</label>
            <input id="invitation-url" data-invitation-url type="url" readonly spellcheck="false" value="${escape(ownUrl)}">
            <div class="invitation-primary-actions"><button type="button" class="btn btn-primary" data-invitation-copy-link>${escape(t(hasCopy ? 'engagement.copyLink' : 'engagement.copyInvitationLink'))}</button>${posterAction}${hasCopy ? `<button type="button" class="btn btn-secondary" data-invitation-copy-text>${escape(t('engagement.copyText'))}</button>` : ''}</div>
            ${hasCopy ? `<details class="invitation-copy-details" data-invitation-copy-details data-invitation-disclosure="copy" ${disclosureState.copy ? 'open' : ''}><summary data-invitation-copy-summary>${escape(t('engagement.copyDetails'))}</summary><div class="invitation-copy-preview">${copy.title.trim() ? `<strong data-invitation-copy-title>${escape(copy.title)}</strong>` : ''}${copy.subtitle.trim() ? `<p data-invitation-copy-subtitle>${escape(copy.subtitle)}</p>` : ''}</div></details>` : ''}
          </div>` : `
          ${desktop && !member ? `<p class="invitation-offer" data-invitation-offer>${escape(guestOffer(platformAccount.getPlatformPublicOffer?.()))}</p>` : ''}
          <div class="invitation-primary-actions">${desktop && (!member || !bound) ? `<a class="btn btn-primary" data-invitation-account href="#/account">${escape(t(member ? 'engagement.connectAccount' : 'engagement.loginRegister'))}</a>` : ''}${desktop && bound ? `<a class="btn btn-secondary" data-invitation-account href="#/account">${escape(t('engagement.manageAuthorization'))}</a>` : ''}${posterAction}</div>
        `}
        ${!member ? `<p class="invitation-reward-note">${escape(t('engagement.rewardNote'))}</p>` : ''}
        <p class="invitation-feedback" data-invitation-feedback data-state="${feedback?.state || ''}" role="status" aria-live="polite">${feedback ? escape(t(feedback.key)) : ''}</p>
        <section class="invitation-support-section"><h3>${escape(t('engagement.supportTitle'))}</h3><div class="invitation-support"><a data-invitation-star href="${STAR_URL}" target="_blank" rel="noopener noreferrer">☆ ${escape(t('engagement.starTitle'))} ↗</a></div>
        <p class="invitation-support-note">${escape(t('engagement.genericNote'))}</p>
        <div class="invitation-generic-share"><p class="invitation-generic-text">${escape(genericShareText())}</p><button type="button" class="btn btn-secondary btn-sm" data-invitation-generic-copy>${escape(t('engagement.genericCopy'))}</button></div>
        <details class="invitation-community" data-invitation-disclosure="community" ${disclosureState.community ? 'open' : ''}><summary data-invitation-community-summary>${escape(t('engagement.communityTitle'))}</summary><nav aria-label="${escape(t('engagement.communityTitle'))}">${[
          ['https://qt.cool/c/OpenClaw', 'qqLabel'], ['https://qt.cool/c/OpenClawWx', 'wechatLabel'],
          ['https://qt.cool/c/OpenClawDY', 'douyinLabel'], ['https://qt.cool/c/feishu', 'feishuLabel'],
          ['https://t.me/+rjRE3PgVL9tmOGZk', 'telegramLabel'],
        ].map(([url, key]) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${escape(t(`engagement.${key}`))} ↗</a>`).join('')}</nav></details></section>
        <footer class="invitation-footer"><button type="button" data-invitation-dismiss>${escape(t('engagement.dismissToday'))}</button></footer>
      </section>`
    overlay.querySelector('.engage-modal').scrollTop = scrollTop
    if (focused && focusHook) overlay.querySelector(`[${focusHook}]`)?.focus({ preventScroll: true })
  }

  async function openPoster() {
    if (closed || posterPanel || posterOpening || busy) return
    const before = identity(platformAccount.getPlatformAccount())
    posterOpening = true
    try {
      const { createInvitationPosterPanel } = await import('./invitation-poster.js')
      if (closed || before !== identity(platformAccount.getPlatformAccount())) return
      posterPanel = createInvitationPosterPanel({ onBack() {
        posterPanel?.dispose(); posterPanel = null
        draw()
        overlay.querySelector('[data-invitation-poster]')?.focus({ preventScroll: true })
      } })
      const modal = overlay.querySelector('.engage-modal')
      modal.classList.add('invitation-poster-host'); modal.setAttribute('aria-labelledby', 'invitation-poster-title'); modal.removeAttribute('aria-describedby')
      modal.replaceChildren()
      const closeButton = document.createElement('button')
      closeButton.type = 'button'; closeButton.className = 'engage-close'; closeButton.dataset.invitationClose = ''; closeButton.setAttribute('aria-label', t('common.close')); closeButton.textContent = '×'
      modal.append(closeButton, posterPanel.element); modal.scrollTop = 0
      posterPanel.element.querySelector('[data-poster-back]')?.focus({ preventScroll: true })
    } catch { if (!closed && before === identity(platformAccount.getPlatformAccount())) { feedback = { state: 'error', key: 'engagement.posterFailed' }; draw() } }
    finally { posterOpening = false }
  }

  const genericShareText = () => `${t('engagement.genericText')}\n${PROJECT_URL}`

  async function copyText(kind) {
    if (busy) return
    const state = platformAccount.getPlatformAccount()
    const before = identity(state)
    const url = ownInvitation(state)
    if (kind !== 'generic' && !url) { feedback = null; draw(); return }
    const copy = invitationCopy(state)
    const text = kind === 'link' ? url : kind === 'personal' ? [copy.title, copy.subtitle, url].filter(value => value.trim()).join('\n\n') : genericShareText()
    busy = true
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable')
      await navigator.clipboard.writeText(text)
      if (!closed && before === identity(platformAccount.getPlatformAccount())) feedback = { state: 'success', key: 'engagement.copySuccess' }
    } catch {
      if (!closed && before === identity(platformAccount.getPlatformAccount())) feedback = { state: 'error', key: 'engagement.copyFailure' }
    } finally { busy = false; draw() }
  }

  overlay.addEventListener('click', async event => {
    rememberDisclosures()
    const target = event.target.closest('button,a')
    if (event.target === overlay || target?.matches('[data-invitation-close],[data-invitation-dismiss]')) { close(); return }
    if (target?.matches('[data-invitation-account]')) { close(false); return }
    if (target?.matches('[data-invitation-poster]')) { await openPoster(); return }
    if (target?.matches('[data-invitation-copy-link]')) { await copyText('link'); return }
    if (target?.matches('[data-invitation-copy-text]')) { await copyText('personal'); return }
    if (target?.matches('[data-invitation-generic-copy]')) { await copyText('generic'); return }
    if (target?.matches('[data-invitation-official]') && !busy) {
      const before = identity(platformAccount.getPlatformAccount())
      busy = true
      try { await platformAccount.openPlatformMember('referrals') }
      catch { if (before === identity(platformAccount.getPlatformAccount())) feedback = { state: 'error', key: 'engagement.openFailure' } }
      finally { busy = false; draw() }
    }
  })
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...overlay.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(node => !node.disabled && node.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); overlay.querySelector('.engage-modal').focus(); return }
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus() }
  })
  unsubscribers.push(platformAccount.onPlatformAccountChange(() => { feedback = null; draw() }), onLangChange(() => { feedback = null; draw() }))
  if (platformAccount.onPlatformPublicOfferChange) unsubscribers.push(platformAccount.onPlatformPublicOfferChange(draw))
  draw()
  document.body.appendChild(overlay)
  requestAnimationFrame(() => { if (!closed) { overlay.classList.add('engage-visible'); overlay.querySelector('[data-invitation-close]')?.focus({ preventScroll: true }) } })
  if (isTauriRuntime() && !platformAccount.getPlatformAccount().member && platformAccount.loadPlatformPublicOffer) platformAccount.loadPlatformPublicOffer().catch(() => {})
  return overlay
}

/** 外部在成功保存配置、服务就绪等正向时机调用，避免打断用户任务。 */
export function tryShowEngagement() { return showInvitationDialog({ manual: false }) }
