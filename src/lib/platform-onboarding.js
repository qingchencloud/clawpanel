/** 按官网公开条件或本人状态呈现下一步，不用本地标记判断新老用户。 */
import { t } from './i18n.js'
import { formatCredits } from './platform-account.js'

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const text = (key, values) => escape(t(`platform.onboarding.${key}`, values))
const amount = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value).toString() : null

function registrationStatus(trial) {
  if (trial?.status === 'issued') {
    const issued = amount(trial.amount_micro_cny)
    return issued === null ? text('registrationUnknown') : issued === '0' ? text('registrationZero') : text('registrationIssued', { amount: formatCredits(issued) })
  }
  if (trial?.status === 'expired') return text('registrationExpired')
  if (['pending_delivery', 'pending_budget', 'pending_review', 'configuration_unavailable'].includes(trial?.status)) return text('registrationPending')
  if (['not_eligible', 'disabled', 'delivery_disabled'].includes(trial?.status)) return text('registrationNotEligible')
  return text('registrationUnknown')
}

/** 已连接后的说明默认折叠，避免长文案铺满账户页。 */
export function renderPlatformOnboardingCompact(state) {
  const next = state.phase === 'logged_in' ? 'connectNext' : state.phase === 'bound' ? 'assistantNext'
    : ['binding', 'reauthorizing', 'authorizing'].includes(state.phase) ? 'authorizationNext' : 'signInAgain'
  return `<details class="card platform-note platform-section" data-platform-onboarding="member"><summary>${text('nextTitle')}</summary><div class="platform-note-body"><p data-platform-onboarding-next>${text(next)}</p><p data-platform-registration-guidance>${registrationStatus(state.trial)}</p><p class="form-hint" data-platform-installation-guidance>${text('oneConnection')} ${text('assistantScope')}</p></div></details>`
}

export function renderPlatformOnboarding(state, publicOffer) {
  if (state.member) {
    const next = state.phase === 'logged_in' ? 'connectNext' : state.phase === 'bound' ? 'assistantNext'
      : ['binding', 'reauthorizing', 'authorizing'].includes(state.phase) ? 'authorizationNext' : 'signInAgain'
    return `<section class="platform-onboarding card platform-section" data-platform-onboarding="member"><h3>${text('nextTitle')}</h3><p data-platform-onboarding-next>${text(next)}</p><p data-platform-registration-guidance>${registrationStatus(state.trial)}</p><p class="form-hint" data-platform-installation-guidance>${text('oneConnection')} ${text('assistantScope')}</p></section>`
  }
  if (state.phase !== 'guest') return `<section class="platform-onboarding card" data-platform-onboarding="resume"><h3>${text('nextTitle')}</h3><p>${text(['authorizing', 'binding', 'reauthorizing'].includes(state.phase) ? 'authorizationNext' : 'signInAgain')}</p><p class="form-hint">${text('assistantScope')}</p></section>`
  const current = publicOffer?.status === 'offered' && (publicOffer.registration_rewards_enabled || publicOffer.simulation) ? publicOffer.offer : null
  const value = amount(current?.amount_micro_cny)
  const message = !publicOffer ? text('publicLoading') : current && value !== null
    ? value === '0' ? text('publicZero') : Object.hasOwn(current, 'valid_hours') ? text('publicOfferedHours', { amount: formatCredits(value), hours: current.valid_hours }) : text('publicOffered', { amount: formatCredits(value), days: current.valid_days })
    : text(publicOffer.status === 'not_open' ? 'publicClosed' : 'publicUnavailable')
  return `<section class="platform-onboarding card" data-platform-onboarding="guest"><h3>${text('publicTitle')}</h3><p data-platform-public-offer ${!publicOffer ? 'data-platform-onboarding-loading' : ''}>${message}</p>${publicOffer?.simulation ? `<p class="platform-onboarding-notice">${text('publicSimulated')}</p>` : ''}${current && value !== '0' && current.models.length ? `<p class="form-hint" data-platform-public-models>${text('publicModels')}: ${current.models.map(model => escape(model.display_name)).join(' · ')}</p>` : ''}<p class="form-hint">${text('existingAccount')} ${text('registrationSeparate')}</p></section>`
}
