/** 官网账户权益页；登录、批准与邀请在系统浏览器中完成。 */
import { isTauriRuntime } from '../lib/tauri-api.js'
import { t, getLang, onLangChange } from '../lib/i18n.js'
import { icon } from '../lib/icons.js'
import { showConfirm } from '../components/modal.js'
import { showInvitationDialog } from '../components/engagement.js'
import { renderPlatformOnboarding, renderPlatformOnboardingCompact } from '../lib/platform-onboarding.js'
import { createPlatformEngineAccessCard } from '../components/platform-engine-access.js'
import { createOfficialProviderCard } from '../components/official-provider-card.js'
import { getPlatformAccount, initPlatformAccount, restorePlatformAccount, refreshPlatformAccount, onPlatformAccountChange, platformAccountAction, openPlatformMember, formatCredits, displayPlanName, trialPresentation, platformErrorText, recoverPlatformRequest, getPlatformPublicOffer, loadPlatformPublicOffer, onPlatformPublicOfferChange } from '../lib/platform-account.js'
import '../style/platform-onboarding.css'

let dispose = null
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getLang()) : '—'
// 账户页积分按千分位展示，最多保留两位小数；其余明细仍用原始精度。
const pointsText = value => {
  const formatted = formatCredits(value)
  if (formatted === '—') return formatted
  const amount = Number(formatted)
  if (!Number.isFinite(amount)) return formatted
  return new Intl.NumberFormat(getLang(), { maximumFractionDigits: 2 }).format(amount)
}
const button = (action, key, primary = false, extra = '') => `<button type="button" class="btn btn-${primary ? 'primary' : 'secondary'} btn-sm" data-platform-action="${action}" ${extra}>${escape(t(`platform.${key}`))}</button>`
const textButton = (action, key) => `<button type="button" class="platform-text-button" data-platform-action="${action}">${escape(t(`platform.${key}`))}</button>`
const assistantLink = (primary = true, guest = false) => `<a class="btn btn-${primary ? 'primary' : 'secondary'}" href="#/assistant" data-platform-open-assistant ${guest ? 'data-platform-guest-primary' : ''}>${icon('message-square', 16)}${t('platform.openAssistant')}</a>`

// 活动积分与钱包金额使用不同单位；缺失或不安全的数值不猜默认赠额。
const offerCredits = value => (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) && /^\d+$/.test(String(value)) ? BigInt(value).toString() : null
const validCount = value => Number.isSafeInteger(value) && value > 0 ? value : null
function observationDuration(seconds) {
  for (const [unit, divisor] of [['Days', 86400], ['Hours', 3600], ['Minutes', 60], ['Seconds', 1]]) if (seconds % divisor === 0) return t(`platform.benefits.observation${unit}`, { count: seconds / divisor })
  return ''
}
function benefitRules(state) {
  const benefits = state.benefits, participation = benefits?.referrals?.participation
  if (benefits?.status !== 'ready' || !participation) return null
  if (participation.qualification_status !== 'not_enrolled') {
    const rules = participation.rules
    return participation.campaign_id && participation.rules_version && rules?.campaign_id === participation.campaign_id && rules?.rules_version === participation.rules_version ? rules : null
  }
  return benefits.currentCampaign || null
}
function rewardProgressView(participation, rules, progressKey) {
  if (!progressKey) return ''
  const requirements = participation?.requirements
  const validProgress = (value, required, frozen) => Number.isSafeInteger(value) && value >= 0 && validCount(required) && required === frozen
  const hasCounts = rules && validProgress(participation.successful_requests, requirements?.successful_requests_required, rules.successful_requests_required)
    && validProgress(participation.distinct_utc_dates, requirements?.distinct_utc_dates_required, rules.distinct_utc_dates_required)
  const counts = hasCounts ? `<span data-platform-reward-count="requests" data-remaining="${Math.max(0, requirements.successful_requests_required - participation.successful_requests)}">${escape(t('platform.benefits.progressRequests', { current: participation.successful_requests, required: requirements.successful_requests_required, remaining: Math.max(0, requirements.successful_requests_required - participation.successful_requests) }))}</span> · <span data-platform-reward-count="utc-dates" data-remaining="${Math.max(0, requirements.distinct_utc_dates_required - participation.distinct_utc_dates)}">${escape(t('platform.benefits.progressDates', { current: participation.distinct_utc_dates, required: requirements.distinct_utc_dates_required, remaining: Math.max(0, requirements.distinct_utc_dates_required - participation.distinct_utc_dates) }))}</span>` : escape(t('platform.benefits.progressUnavailable'))
  const deadline = (kind, value, label) => value && Number.isFinite(Date.parse(value)) ? `<br>${t(`platform.benefits.${label}`)}: <time data-platform-${kind}-deadline datetime="${escape(value)}">${escape(date(value))}</time>` : ''
  return `<p class="platform-benefit-progress" data-platform-reward-progress>${t('platform.benefits.progressLabel')} · ${escape(t(`platform.benefits.progress.${progressKey}`))}<br>${counts}${deadline('qualification', participation.qualification_deadline_at, 'qualificationDeadline')}${progressKey === 'observing' ? deadline('observation', participation.observation_ends_at, 'observationDeadline') : ''}</p>`
}
function inviteeRewardView(state, participation) {
  if (!state.member) return ''
  // 只展示本人的实际奖励事件；规则面额、资格状态和邀请人收益都不能替代到账事实。
  const reward = state.benefits?.status === 'ready' ? participation?.invitee_reward : undefined
  const labels = { paused: 'inviteeUnissued', pending: 'inviteePending', pending_delivery: 'inviteePending', pending_budget: 'inviteePending', review: 'inviteeReview', pending_review: 'inviteeReview', expired: 'inviteeExpired', rejected: 'inviteeRejected', configuration_unavailable: 'inviteeUnknown' }
  const status = reward === null ? 'none' : reward?.status === 'issued' || Object.hasOwn(labels, reward?.status) ? reward.status : 'unknown'
  let message = t(`platform.benefits.${reward === null ? 'inviteeNone' : labels[status] || 'inviteeUnknown'}`)
  if (status === 'issued') {
    const amount = offerCredits(reward.amount_micro_cny)
    const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    if (amount !== null && validTime(reward.issued_at) && validTime(reward.expires_at)) {
      message = t(`platform.benefits.${amount === '0' ? 'inviteeZero' : 'inviteeIssued'}`, { amount: formatCredits(amount), expires: date(reward.expires_at) })
    }
  }
  return `<div class="platform-binding-benefit" data-platform-invitee-reward data-platform-invitee-status="${status}"><h3>${t('platform.benefits.inviteeTitle')}</h3><p>${escape(message)}</p></div>`
}
function benefitsView(state) {
  const benefits = state.benefits, referrals = benefits?.referrals, participation = referrals?.participation
  const rules = benefitRules(state), copy = benefits?.invitationCopy
  const language = getLang().startsWith('zh') ? 'zh' : 'en'
  const copyField = (field, fallback) => typeof copy?.[`${field}_${language}`] === 'string' && copy[`${field}_${language}`].trim() ? copy[`${field}_${language}`].trim() : t(`platform.benefits.${fallback}`)
  const simulated = referrals?.simulation === true || rules?.simulation === true || state.platformStatus?.fixture_mode === true
  const restricted = simulated || referrals?.reward_delivery_enabled === false || rules?.reward_delivery_enabled === false || state.platformStatus?.referral_rewards_enabled === false
  const inviter = offerCredits(rules?.inviter_credits), invitee = offerCredits(rules?.invitee_credits)
  const rewardDays = validCount(rules?.referral_valid_days), qualificationDays = validCount(rules?.qualification_days)
  const referralLimit = validCount(rules?.per_member_daily_referral_limit)
  const expiryFromIssuance = rules?.reward_expiry_from_issuance
  const expiryText = rewardDays && expiryFromIssuance === true && Number.isSafeInteger(rewardDays * 24)
    ? t('platform.benefits.rewardExpiryIssued', { hours: rewardDays * 24 })
    : rewardDays && (expiryFromIssuance === false || !Object.hasOwn(rules || {}, 'reward_expiry_from_issuance')) ? t('platform.benefits.rewardExpiry', { days: rewardDays }) : ''
  const requests = validCount(rules?.successful_requests_required), dates = validCount(rules?.distinct_utc_dates_required), observation = validCount(rules?.observation_seconds)
  const reward = participation?.newcomer_reward, newcomer = offerCredits(rules?.newcomer_credits), newcomerDays = validCount(rules?.newcomer_valid_days)
  let binding = t('platform.benefits.bindingUnknown')
  if (reward?.status === 'issued') {
    const amount = offerCredits(reward.amount_micro_cny)
    if (amount === '0') binding = t('platform.benefits.bindingIssuedZero')
    else if (amount !== null) binding = t('platform.benefits.bindingIssued', { amount: formatCredits(amount), expires: date(reward.expires_at) })
  }
  else if (reward?.status === 'expired') binding = t('platform.benefits.bindingExpired')
  else if (newcomer === '0') binding = t('platform.benefits.bindingZero')
  else if (newcomer && newcomerDays) binding = t('platform.benefits.bindingOffer', { amount: newcomer, days: newcomerDays })
  const qualification = participation?.qualification_status
  const progressKey = ['pending_binding', 'pending_usage', 'observing', 'qualified', 'expired', 'rejected'].includes(qualification) ? qualification : null
  return `<section class="card platform-benefit-guide" data-platform-benefits>
    <div class="platform-benefit-heading"><h2>${t('platform.benefits.title')}</h2><p data-platform-benefits-howto>${t('platform.benefits.howto')}</p></div>
    <ol class="platform-howto"><li><span>1</span>${t('platform.benefits.stepSignIn')}</li><li><span>2</span>${t('platform.benefits.stepConnect')}</li><li><span>3</span>${t('platform.benefits.stepAssistant')}</li></ol>
    <div class="platform-invitation-benefit"><div class="platform-invitation-heading"><div><h3 data-platform-invitation-title>${escape(copyField('title', 'invitationTitle'))}</h3><p data-platform-invitation-subtitle>${escape(copyField('subtitle', 'invitationSubtitle'))}</p></div>${state.member ? button('invite', 'benefits.inviteAction') : ''}</div>
      ${restricted ? `<p class="platform-benefit-notice" data-platform-rewards-restricted>${escape(t(simulated ? 'platform.benefits.simulated' : 'platform.benefits.closed'))}</p>` : ''}
      ${rules && (inviter !== null || invitee !== null) ? `<div class="platform-reward-offers" data-platform-reward-rules="${participation?.qualification_status !== 'not_enrolled' ? 'enrolled' : 'current'}"><div><span>${t('platform.benefits.forYou')}</span><strong>${inviter === null ? t('platform.benefits.toConfirm') : `<span data-platform-reward-value="inviter">${inviter}</span> <small>${t('platform.credits')}</small>`}</strong>${inviter === '0' ? `<p>${t('platform.benefits.noReward')}</p>` : ''}</div><div><span>${t('platform.benefits.forFriend')}</span><strong>${invitee === null ? t('platform.benefits.toConfirm') : `<span data-platform-reward-value="invitee">${invitee}</span> <small>${t('platform.credits')}</small>`}</strong>${invitee === '0' ? `<p>${t('platform.benefits.noReward')}</p>` : ''}</div></div>` : `<p class="platform-benefit-empty" data-platform-reward-rules="unavailable">${t(benefits?.status === 'scope_required' ? 'platform.benefits.scopeRequired' : 'platform.benefits.rulesUnavailable')}</p>`}
      <p class="platform-invitation-steps" data-platform-invitation-steps>${t('platform.benefits.invitationSteps')}</p>
      ${qualificationDays && requests && dates && observation || expiryText || referralLimit ? `<details class="platform-reward-rule-details" data-platform-reward-conditions><summary>${t('platform.benefits.ruleDetails')}</summary>${qualificationDays && requests && dates && observation ? `<p class="platform-reward-conditions">${escape(t('platform.benefits.conditions', { days: qualificationDays, requests, dates, duration: observationDuration(observation) }))}</p>` : ''}${expiryText ? `<p class="platform-reward-conditions" data-platform-reward-expiry>${escape(expiryText)}</p>` : ''}${referralLimit ? `<p class="platform-reward-conditions" data-platform-referral-daily-limit>${escape(t('platform.benefits.referralDailyLimit', { count: referralLimit }))}</p>` : ''}</details>` : ''}
      ${rewardProgressView(participation, rules, progressKey)}
      ${inviteeRewardView(state, participation)}
      <p class="form-hint">${t('platform.benefits.rewardTruth')}</p>
    </div>
    <div class="platform-binding-benefit" data-platform-binding-benefit><h3>${t('platform.benefits.bindingTitle')}</h3><p>${t('platform.benefits.bindingBase')}</p><p>${escape(binding)}</p>${newcomer && newcomer !== '0' && participation?.qualification_status === 'not_enrolled' ? `<p data-platform-binding-ineligible>${t('platform.benefits.bindingNotEnrolled')}</p>` : ''}${newcomer && newcomer !== '0' && reward && !['issued', 'expired'].includes(reward.status) ? `<p data-platform-binding-reward-status>${t('platform.benefits.bindingPending')}</p>` : ''}</div>
    ${!state.member ? `<div class="platform-registration-intro" data-platform-registration-benefit><h3>${t('platform.trialTitle')}</h3><p>${t('platform.benefits.registrationGuest')}</p></div>` : ''}
  </section>`
}

function guestView(state, phase) {
  const waiting = ['authorizing', 'binding', 'reauthorizing'].includes(state.phase)
  return `${renderPlatformOnboarding(state, getPlatformPublicOffer())}<section class="card platform-welcome platform-section" data-platform-guest>
    <div class="platform-welcome-main"><span class="platform-assistant-mark" aria-hidden="true">${icon('message-square', 23)}</span><h2>${t('platform.guestTitle')}</h2><p>${t('platform.guestIntro')}</p>
      <div class="platform-login-actions">${waiting ? `<span class="platform-state" data-state="${escape(state.phase)}"><span class="platform-state-dot" aria-hidden="true"></span>${escape(phase)}</span>${button('login-cancel', 'cancel')}` : `<button type="button" class="btn btn-primary platform-login-cta" data-platform-action="login">${escape(t('platform.login'))}</button>`}</div>
      <div class="platform-welcome-secondary">${assistantLink(false, true)}<span class="form-hint">${t('platform.ownKeyHint')}</span></div></div>
    <div class="platform-welcome-account"><ul class="platform-benefits">
      <li>${icon('sparkles', 17)}<div><strong>${t('platform.official')}</strong><p>${t('platform.modelsBenefit')}</p></div></li>
      <li>${icon('bar-chart', 17)}<div><strong>${t('platform.walletTitle')}</strong><p>${t('platform.walletBenefit')}</p></div></li>
      <li>${icon('gift', 17)}<div><strong>${t('platform.invitationTitle')}</strong><p>${t('platform.invitationBenefit')}</p></div></li>
    </ul><p>${t('platform.signInHint')}</p></div>
  </section><details class="platform-guest-rewards platform-section" data-platform-guest-rewards><summary>${t('platform.onboarding.otherRewards')}</summary>${benefitsView(state)}</details><div class="platform-section"><span class="platform-state" data-platform-account-status data-state="${escape(state.phase)}"><span class="platform-state-dot" aria-hidden="true"></span>${escape(phase)}</span></div>`
}

function bindingView(state) {
  if (!state.binding || !['binding', 'reauthorizing'].includes(state.phase)) return ''
  return `<section class="card platform-binding"><h3>${t('platform.verifyDevice')}</h3><p>${t('platform.verifyDeviceHint')}</p><strong class="platform-display-code">${escape(state.binding.display_code)}</strong><dl><dt>${t('platform.installation')}</dt><dd>${escape(state.binding.device_name)}</dd><dt>${t('platform.fingerprint')}</dt><dd>${escape(state.binding.jwk_thumbprint)}</dd><dt>${t('platform.expires')}</dt><dd>${escape(date(state.binding.expires_at))}</dd></dl></section>`
}

function connectionView(state) {
  if (!state.connection || state.phase !== 'authorizing') return ''
  const approved = ['approved', 'redeemed'].includes(state.connection.status)
  return `<section class="platform-feedback platform-connection" data-platform-connection="${approved ? 'finishing' : 'pending'}" role="status" aria-live="polite">${icon(approved ? 'refresh-cw' : 'external-link', 16)}<div><strong>${t(approved ? 'platform.connection.finishing' : 'platform.connection.waiting')}</strong><p>${t(approved ? 'platform.connection.finishingHint' : 'platform.connection.waitingHint')}</p><p class="form-hint">${t('platform.expires')}: ${escape(date(state.connection.expires_at))}</p></div></section>`
}

function memberView(state, phase) {
  const member = state.member, entitlements = state.entitlements || {}, wallet = state.wallet
  const serviceLabel = entitlements.control_state === 'active' && state.platformStatus?.fixture_mode === false && state.platformStatus?.real_upstream_enabled === false
    ? t('platform.errors.upstream_disabled') : t(`platform.control.${['active', 'binding_required', 'restricted'].includes(entitlements.control_state) ? entitlements.control_state : 'unavailable'}`)
  const trial = trialPresentation(state.trial)
  const grants = Array.isArray(state.grants) ? state.grants : state.grants?.items || []
  const pending = (state.pendingRequests || []).filter(item => !['settled', 'released'].includes(item.state) || item.state === 'settled' && item.replyComplete === false)
  const days = state.usage?.days
  const total = Array.isArray(days) ? days.reduce((sum, day) => sum + (Number.isSafeInteger(day.admitted_requests) ? day.admitted_requests : 0), 0) : '—'
  const consumed = Array.isArray(days) ? days.reduce((sum, day) => /^\d+$/.test(day.consumed_micro_cny || '') ? sum + BigInt(day.consumed_micro_cny) : sum, 0n).toString() : null
  const needsLogin = ['reauth_required', 'storage_error'].includes(state.phase)
  const waiting = ['authorizing', 'binding', 'reauthorizing'].includes(state.phase)
  const mainAction = needsLogin ? button('login', 'login', true) : state.phase === 'logged_in' ? button('bind', 'bind', true) : assistantLink(!waiting)
  const trialPending = ['pending_delivery', 'pending_budget', 'pending_review', 'configuration_unavailable'].includes(trial.status)
  const avatar = String(member.email_masked || '?').trim().charAt(0).toUpperCase()
  const reserved = formatCredits(wallet?.summary?.reserved_micro_cny)
  return `<section class="card platform-member" data-platform-member ${state.phase === 'bound' ? 'data-platform-bound' : ''}>
    <div class="platform-member-head">
      <span class="platform-avatar" aria-hidden="true">${escape(avatar)}</span>
      <div class="platform-member-meta"><h2>${escape(member.email_masked)}</h2><div class="platform-pills"><span class="platform-pill platform-pill-ok" data-platform-account-status data-state="${escape(state.phase)}"><span class="platform-pill-dot" aria-hidden="true"></span>${escape(phase)}</span>${wallet?.simulated ? `<span class="platform-pill">${t('platform.simulated')}</span>` : ''}</div></div>
      <div class="platform-member-actions">${mainAction}${state.phase === 'logged_in' || needsLogin ? assistantLink(false) : ''}${waiting ? button('login-cancel', 'cancel') : ''}${button('refresh', 'refresh')}${button('invite', 'invite')}</div>
    </div>
    <div class="platform-metrics">
      <div class="platform-metric"><span class="platform-metric-label">${t('platform.available')}</span><strong class="platform-metric-value" data-platform-balance>${pointsText(wallet?.summary?.available_micro_cny)}<small>${t('platform.credits')}</small></strong><span class="platform-metric-sub">${t('platform.creditUnit')}</span></div>
      <div class="platform-metric"><span class="platform-metric-label">${t('platform.reserved')}</span><strong class="platform-metric-value">${reserved}<small>${t('platform.credits')}</small></strong></div>
      <div class="platform-metric"><span class="platform-metric-label">${t('platform.group')}</span><strong class="platform-metric-value platform-metric-plan" data-platform-plan>${escape(displayPlanName(member))}</strong><span class="platform-metric-sub">${escape(serviceLabel)}</span></div>
    </div>
  </section>
  ${bindingView(state)}
  ${renderPlatformOnboardingCompact(state)}
  <div data-platform-official-provider-slot></div>
  <div data-platform-engine-access-slot></div>
  ${benefitsView(state)}
  <div class="platform-detail-grid"><section class="card" data-platform-registration-benefit><h3>${t('platform.trialTitle')}</h3><h2 data-platform-trial>${escape(trial.label)}</h2>${trial.issued ? `<dl><dt>${t('platform.originalAmount')}</dt><dd><span data-platform-trial-amount>${trial.amount}</span> ${t('platform.credits')}</dd><dt>${t('platform.expires')}</dt><dd>${escape(date(state.trial.expires_at))}</dd></dl>${trial.simulated ? `<span class="platform-tag platform-section">${t('platform.simulated')}</span>` : ''}<p class="form-hint">${t('platform.trialHint')}</p>` : trialPending ? `<p class="form-hint" data-platform-trial-pending>${t('platform.trialNotReceived')}</p>` : ''}<p class="form-hint">${t('platform.benefits.registrationOnce')}</p></section>
    <section class="card"><h3>${t('platform.models')}</h3><div class="platform-models">${(member.eligible_model_ids || []).map(id => `<span class="platform-tag">${escape(id)}</span>`).join('') || `<p>${t('platform.noModels')}</p>`}</div><p class="form-hint">${t('platform.modelsHint')}</p></section></div>
  <div class="platform-records-grid"><section class="card"><h3>${t('platform.expiryTitle')}</h3>${grants.length ? `<div class="platform-grants">${grants.map(grant => `<div><span>${escape(t(`platform.source.${grant.source}`) === `platform.source.${grant.source}` ? t('platform.source.other') : t(`platform.source.${grant.source}`))}${grant.simulated ? ` · ${t('platform.simulated')}` : ''}</span><strong>${formatCredits(grant.available_micro_cny)} ${t('platform.credits')}</strong><span>${t('platform.expires')}: ${escape(date(grant.expires_at))}</span></div>`).join('')}</div><p class="form-hint">${t('platform.firstPage')}</p>` : `<p>${t('platform.noGrants')}</p>`}</section>
    <details class="card platform-technical-details" data-platform-technical-details><summary>${t('platform.benefits.technicalDetails')}</summary><dl class="platform-section"><dt>${t('platform.concurrent')}</dt><dd>${escape(entitlements.active_requests ?? '—')} / ${escape(entitlements.max_concurrent_requests ?? '—')}</dd><dt>${t('platform.remainingDaily')}</dt><dd>${escape(entitlements.remaining_daily_requests ?? '—')}</dd></dl><div class="platform-section" data-platform-usage><h3>${t('platform.usage')}</h3>${Array.isArray(days) ? `<div class="platform-usage-stats"><div><span>${t('platform.requests')}</span><strong>${total}</strong></div><div><span>${t('platform.consumed')} · ${t('platform.credits')}</span><strong>${formatCredits(consumed)}</strong></div></div><p class="platform-usage-range">${escape(state.usage.from_date || '—')} – ${escape(state.usage.to_date || '—')} UTC</p>` : `<p>${t('platform.noUsage')}</p>`}</div></details></div>
  ${pending.length ? `<section class="card platform-section"><h3>${t('platform.pendingTitle')}</h3>${pending.map(item => `<div class="platform-request"><span>${escape(t(`platform.request.${item.state}`) === `platform.request.${item.state}` ? t('platform.errors.outcome_unknown') : t(`platform.request.${item.state}`))}${item.replyComplete === false && item.state === 'settled' ? ` · ${t('platform.errors.reply_incomplete')}` : ''}</span><button class="btn btn-secondary btn-sm" data-platform-recover="${escape(item.operationId)}">${t('platform.recover')}</button></div>`).join('')}</section>` : ''}
  <div class="platform-access"><span>${t('platform.accountDetails')}</span><div class="platform-actions">${textButton('member', 'member')}${textButton('logout', 'logout')}${member.device_id ? textButton('unlink', 'unlink') : ''}${textButton('logout-local', 'logoutLocal')}</div></div>`
}

export function render() {
  const page = document.createElement('div')
  page.className = 'page platform-account-page'
  let busy = false, loading = true, actionVersion = 0, activeAction = ''
  let error = '', notice = ''
  let focusSelector = '', viewIdentity = ''
  const engineAccess = createPlatformEngineAccessCard()
  const officialProvider = createOfficialProviderCard()
  function draw() {
    const state = getPlatformAccount()
    const identity = JSON.stringify([state.epoch, state.member?.member_id ?? null])
    const sameIdentity = identity === viewIdentity
    viewIdentity = identity
    if (!sameIdentity) focusSelector = ''
    const focused = sameIdentity && page.contains(document.activeElement) ? document.activeElement : null
    // 刷新重绘保留用户展开的内容，以及暂时禁用按钮前的键盘位置。
    const details = ['data-platform-reward-conditions', 'data-platform-technical-details', 'data-platform-guest-rewards']
    const expanded = sameIdentity ? details.map(attribute => [attribute, page.querySelector(`[${attribute}]`)?.open]) : []
    if (focused) {
      const action = focused.dataset.platformAction, request = focused.dataset.platformRecover
      const summary = focused.matches('summary') && details.find(attribute => focused.parentElement?.hasAttribute(attribute))
      focusSelector = action ? `[data-platform-action="${CSS.escape(action)}"]` : request ? `[data-platform-recover="${CSS.escape(request)}"]` : summary ? `[${summary}]>summary` : ''
    } else if (document.activeElement !== document.body) focusSelector = ''
    const phaseKey = `platform.phase.${state.phase}`
    const phase = t(phaseKey) === phaseKey ? t('platform.phase.reauth_required') : t(phaseKey)
    // 撤销待确认属于状态提示，已有独立黄色横幅，不再重复显示为红色错误。
    const errorCode = typeof state.error === 'string' ? state.error : ''
    const visibleError = error || (state.error && errorCode !== 'platform_revocation_pending' ? platformErrorText(state.error) : '')
    page.dataset.platformAccountState = state.phase
    page.setAttribute('aria-busy', String(loading || busy))
    page.innerHTML = `<div class="page-header"><h1 class="page-title">${t('platform.title')}</h1><p class="page-desc">${t('platform.description')}</p></div>
      ${!isTauriRuntime() ? `<section class="card"><p>${t('platform.desktopOnly')}</p><div class="platform-actions platform-section">${assistantLink()}</div></section>` : (state.member ? memberView(state, phase) : guestView(state, phase) + bindingView(state)) + connectionView(state)}
      ${visibleError ? `<div class="platform-feedback platform-error" role="alert">${icon('alert-triangle', 16)}<p>${escape(visibleError)}</p><button type="button" class="btn btn-secondary btn-sm" data-platform-action="retry" ${busy ? 'disabled' : ''}>${t('common.retry')}</button></div>` : ''}
      ${state.revocationPending ? `<div class="platform-feedback platform-feedback-warning" role="status">${icon('info', 16)}<p>${t('platform.revocationPending')}</p></div>` : ''}
      ${notice ? `<div class="platform-feedback" role="status">${icon('info', 16)}<p>${escape(notice)}</p></div>` : ''}
      <footer class="platform-account-footer"><p class="platform-scope">${t('platform.scopeHint')}</p>${loading || busy ? `<p class="platform-loading" role="status" data-platform-account-loading>${icon('refresh-cw', 13)}${t(busy ? 'platform.refreshing' : 'platform.checkingAccount')}</p>` : state.member && state.updatedAt ? `<span class="platform-updated">${t('platform.updated')}: ${escape(date(state.updatedAt))}</span>` : ''}</footer>`
    page.querySelector('[data-platform-official-provider-slot]')?.replaceWith(officialProvider.element)
    page.querySelector('[data-platform-engine-access-slot]')?.replaceWith(engineAccess.element)
    // 取消授权不被后台刷新占用；等待中不并发切号、解绑或刷新账号。
    const waiting = ['authorizing', 'binding', 'reauthorizing'].includes(state.phase)
    page.querySelectorAll('button').forEach(element => { if (!engineAccess.element.contains(element) && !officialProvider.element.contains(element)) element.disabled = (busy || waiting) && (element.dataset.platformAction !== 'login-cancel' || activeAction === 'login-cancel') })
    expanded.forEach(([attribute, open]) => { const element = page.querySelector(`[${attribute}]`); if (element && open !== undefined) element.open = open })
    const restoreFocus = (focusSelector ? page.querySelector(focusSelector) : null) || (focusSelector === '[data-platform-action="login-cancel"]' ? page.querySelector('[data-platform-action="login"], [data-platform-action="bind"], [data-platform-open-assistant]') : null)
    if (restoreFocus && !restoreFocus.disabled) restoreFocus.focus({ preventScroll: true })
    else if (!restoreFocus) focusSelector = ''
  }
  page.addEventListener('click', async event => {
    const recover = event.target.closest('[data-platform-recover]')
    const action = event.target.closest('[data-platform-action]')?.dataset.platformAction
    if ((!action && !recover) || busy && (action !== 'login-cancel' || activeAction === 'login-cancel')) return
    if (['logout', 'logout-local', 'unlink'].includes(action)) {
      const { epoch, member } = getPlatformAccount()
      const memberId = member?.member_id
      const confirmed = await showConfirm(t(action === 'unlink' ? 'platform.unlinkConfirm' : action === 'logout-local' ? 'platform.localLogoutConfirm' : 'platform.logoutConfirm'))
      const current = getPlatformAccount()
      if (current.epoch !== epoch || current.member?.member_id !== memberId) return
      // 确认期间账户可能收到正常刷新，原节点被替换时回到同一账户操作。
      page.querySelector(`[data-platform-action="${CSS.escape(action)}"]`)?.focus({ preventScroll: true })
      if (!confirmed) return
    }
    // 邀请弹窗只展示信息，保留入口节点供关闭后恢复焦点。
    if (action === 'invite') { showInvitationDialog({ manual: true }); return }
    const version = ++actionVersion
    busy = true; activeAction = action || 'recover'; error = ''; notice = ''; draw()
    try {
      if (recover) await recoverPlatformRequest(recover.dataset.platformRecover)
      else if (action === 'retry') {
        await restorePlatformAccount()
        if (version === actionVersion) error = ''
      }
      else if (action === 'refresh') await refreshPlatformAccount({ force: true })
      else if (action === 'member') {
        await openPlatformMember('account')
        if (version === actionVersion) notice = t('platform.browserAccountHint')
      } else {
        await platformAccountAction(action === 'logout-local' ? 'logout' : action, { localOnly: action === 'logout-local' })
        if (version === actionVersion && action === 'logout-local') notice = t('platform.localLogoutNotice')
      }
    } catch (failure) { if (version === actionVersion) error = platformErrorText(failure) }
    finally {
      if (version === actionVersion) {
        busy = false; activeAction = ''
        if (page.isConnected) {
          draw()
          // 取消会推进原生 epoch；等按钮恢复可用后再落键盘焦点。
          if (action === 'login-cancel' && !['authorizing', 'binding', 'reauthorizing'].includes(getPlatformAccount().phase)) {
            const next = page.querySelector('[data-platform-action="login"]:not(:disabled)') || page.querySelector('[data-platform-action="bind"]:not(:disabled)') || page.querySelector('[data-platform-open-assistant]')
            next?.focus({ preventScroll: true })
          }
        }
      }
    }
  })
  let previousPhase = getPlatformAccount().phase
  const offState = onPlatformAccountChange(state => {
    const enteredGuest = state.phase === 'guest' && previousPhase !== 'guest'
    previousPhase = state.phase
    if (enteredGuest) void loadPlatformPublicOffer()
    draw()
  })
  const offLang = onLangChange(draw)
  const offPublicOffer = onPlatformPublicOfferChange(() => { if (page.isConnected) draw() })
  dispose = () => { offState(); offLang(); offPublicOffer(); engineAccess.destroy(); officialProvider.destroy() }
  draw()
  if (isTauriRuntime() && !getPlatformAccount().member) void loadPlatformPublicOffer()
  initPlatformAccount().then(() => refreshPlatformAccount()).catch(failure => { error = platformErrorText(failure) }).finally(() => { loading = false; if (page.isConnected) draw() })
  return page
}

export function cleanup() { dispose?.(); dispose = null }
