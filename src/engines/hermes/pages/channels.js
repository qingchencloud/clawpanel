/**
 * Hermes Agent 渠道配置
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { humanizeErrorText } from '../../../lib/humanize-error.js'
import { icon } from '../../../lib/icons.js'

const CHANNELS = [
  {
    id: 'telegram',
    icon: 'message-circle',
    titleKey: 'engine.hermesChannelTelegram',
    descKey: 'engine.hermesChannelTelegramDesc',
    secretFields: ['botToken'],
    fields: [
      { key: 'botToken', labelKey: 'engine.hermesChannelBotToken', type: 'password', placeholder: '123456:ABC-DEF...' },
    ],
  },
  {
    id: 'discord',
    icon: 'message-square',
    titleKey: 'engine.hermesChannelDiscord',
    descKey: 'engine.hermesChannelDiscordDesc',
    secretFields: ['token'],
    fields: [
      { key: 'token', labelKey: 'engine.hermesChannelBotToken', type: 'password', placeholder: 'MTA...' },
    ],
  },
  {
    id: 'slack',
    icon: 'hash',
    titleKey: 'engine.hermesChannelSlack',
    descKey: 'engine.hermesChannelSlackDesc',
    secretFields: ['botToken', 'appToken', 'signingSecret'],
    fields: [
      { key: 'botToken', labelKey: 'engine.hermesChannelSlackBotToken', type: 'password', placeholder: 'xoxb-...' },
      { key: 'appToken', labelKey: 'engine.hermesChannelSlackAppToken', type: 'password', placeholder: 'xapp-...' },
      { key: 'signingSecret', labelKey: 'engine.hermesChannelSigningSecret', type: 'password', placeholder: 'optional' },
      { key: 'webhookPath', labelKey: 'engine.hermesChannelWebhookPath', type: 'text', placeholder: '/slack/events' },
    ],
  },
  {
    id: 'feishu',
    icon: 'send',
    titleKey: 'engine.hermesChannelFeishu',
    descKey: 'engine.hermesChannelFeishuDesc',
    secretFields: ['appSecret'],
    fields: [
      { key: 'appId', labelKey: 'engine.hermesChannelFeishuAppId', type: 'text', placeholder: 'cli_xxx' },
      { key: 'appSecret', labelKey: 'engine.hermesChannelFeishuAppSecret', type: 'password', placeholder: 'app secret' },
      { key: 'domain', labelKey: 'engine.hermesChannelFeishuDomain', type: 'select', options: [['feishu', 'engine.hermesChannelFeishuDomainCn'], ['lark', 'engine.hermesChannelFeishuDomainIntl']] },
      { key: 'connectionMode', labelKey: 'engine.hermesChannelConnectionMode', type: 'select', options: [['websocket', 'WebSocket'], ['webhook', 'Webhook']] },
      { key: 'webhookPath', labelKey: 'engine.hermesChannelWebhookPath', type: 'text', placeholder: '/feishu/webhook' },
      { key: 'reactionNotifications', labelKey: 'engine.hermesChannelReactions', type: 'select', options: [['off', 'engine.hermesChannelReactionsOff'], ['basic', 'engine.hermesChannelReactionsBasic']] },
    ],
    toggles: [
      { key: 'typingIndicator', labelKey: 'engine.hermesChannelTypingIndicator' },
      { key: 'resolveSenderNames', labelKey: 'engine.hermesChannelResolveSenderNames' },
    ],
  },
]

const COMMON_FIELDS = [
  { key: 'dmPolicy', labelKey: 'engine.hermesChannelDmPolicy', type: 'select', options: [['pair', 'engine.hermesChannelPolicyPair'], ['open', 'engine.hermesChannelPolicyOpen'], ['allowlist', 'engine.hermesChannelPolicyAllowlist'], ['disabled', 'engine.hermesChannelPolicyDisabled']] },
  { key: 'groupPolicy', labelKey: 'engine.hermesChannelGroupPolicy', type: 'select', options: [['allowlist', 'engine.hermesChannelPolicyAllowlist'], ['open', 'engine.hermesChannelPolicyOpen'], ['disabled', 'engine.hermesChannelPolicyDisabled']] },
  { key: 'allowFrom', labelKey: 'engine.hermesChannelAllowFrom', type: 'textarea', placeholderKey: 'engine.hermesChannelAllowFromPlaceholder' },
  { key: 'groupAllowFrom', labelKey: 'engine.hermesChannelGroupAllowFrom', type: 'textarea', placeholderKey: 'engine.hermesChannelGroupAllowFromPlaceholder' },
]

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function channelMeta(id) {
  return CHANNELS.find(channel => channel.id === id) || CHANNELS[0]
}

function defaultForm(platform) {
  const form = {
    enabled: false,
    dmPolicy: 'pair',
    groupPolicy: 'allowlist',
    allowFrom: '',
    groupAllowFrom: '',
    requireMention: true,
  }
  if (platform === 'feishu') {
    form.domain = 'feishu'
    form.connectionMode = 'websocket'
    form.webhookPath = '/feishu/webhook'
    form.reactionNotifications = 'off'
    form.typingIndicator = true
    form.resolveSenderNames = true
  }
  if (platform === 'slack') form.webhookPath = '/slack/events'
  return form
}

function normalizeForm(platform, form = {}) {
  return { ...defaultForm(platform), ...(form || {}) }
}

function valueOf(form, key) {
  const value = form?.[key]
  return value == null ? '' : String(value)
}

function isConfigured(channel, form) {
  return channel.secretFields.some(key => valueOf(form, key).trim())
}

function renderField(field, form, disabled) {
  const value = valueOf(form, field.key)
  const label = esc(t(field.labelKey))
  if (field.type === 'select') {
    return `
      <label class="hm-field">
        <span class="hm-field-label">${label}</span>
        <select class="hm-input hm-channel-input" data-key="${esc(field.key)}" ${disabled ? 'disabled' : ''}>
          ${(field.options || []).map(([optionValue, optionLabel]) => `
            <option value="${esc(optionValue)}" ${value === optionValue ? 'selected' : ''}>${esc(optionLabel.startsWith('engine.') ? t(optionLabel) : optionLabel)}</option>
          `).join('')}
        </select>
      </label>
    `
  }
  if (field.type === 'textarea') {
    return `
      <label class="hm-field">
        <span class="hm-field-label">${label}</span>
        <textarea class="hm-input hm-channel-input hm-channel-textarea" data-key="${esc(field.key)}" ${disabled ? 'disabled' : ''} placeholder="${esc(t(field.placeholderKey))}">${esc(value)}</textarea>
      </label>
    `
  }
  return `
    <label class="hm-field">
      <span class="hm-field-label">${label}</span>
      <input class="hm-input hm-channel-input" data-key="${esc(field.key)}" type="${esc(field.type || 'text')}" value="${esc(value)}" ${disabled ? 'disabled' : ''} placeholder="${esc(field.placeholder || '')}" autocomplete="off">
    </label>
  `
}

function collectForm(el, platform) {
  const form = normalizeForm(platform, {})
  el.querySelectorAll('.hm-channel-input').forEach(input => {
    const key = input.dataset.key
    if (!key) return
    if (input.type === 'checkbox') form[key] = input.checked
    else form[key] = input.value
  })
  return form
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page hm-channels-page'
  el.dataset.engine = 'hermes'

  let active = 'telegram'
  let values = {}
  let configPath = ''
  let loading = true
  let saving = false
  let error = ''
  let success = ''

  function draw() {
    const channel = channelMeta(active)
    const form = normalizeForm(active, values[active])
    const disabled = loading || saving
    const enabledCount = CHANNELS.filter(item => normalizeForm(item.id, values[item.id]).enabled).length
    const configuredCount = CHANNELS.filter(item => isConfigured(item, normalizeForm(item.id, values[item.id]))).length

    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">${esc(t('engine.hermesChannelsEyebrow'))}</div>
          <h1 class="hm-hero-h1">${esc(t('engine.hermesChannelsTitle'))}</h1>
          <div class="hm-hero-sub">${esc(configPath || '~/.hermes/config.yaml')}</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-channels-reload" ${disabled ? 'disabled' : ''}>${icon('refresh-cw', 14)}${esc(t('engine.hermesConfigReload'))}</button>
          <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-channels-save" ${disabled ? 'disabled' : ''}>${saving ? esc(t('engine.hermesChannelSaving')) : esc(t('engine.hermesChannelSave'))}</button>
        </div>
      </div>

      <section class="hm-channel-summary" aria-label="${esc(t('engine.hermesChannelSummary'))}">
        <div class="hm-channel-stat"><span>${esc(t('engine.hermesChannelEnabledCount'))}</span><strong>${enabledCount}</strong></div>
        <div class="hm-channel-stat"><span>${esc(t('engine.hermesChannelConfiguredCount'))}</span><strong>${configuredCount}</strong></div>
        <div class="hm-channel-stat"><span>${esc(t('engine.hermesChannelRuntimeWrite'))}</span><strong>${esc(t('engine.hermesChannelRuntimeWriteValue'))}</strong></div>
      </section>

      ${(error || success) ? `
        <div class="hm-channel-alert ${error ? 'is-error' : 'is-success'}">
          ${icon(error ? 'alert-triangle' : 'check-circle', 15)}
          <span>${esc(error || success)}</span>
        </div>
      ` : ''}

      <div class="hm-channel-layout">
        <section class="hm-panel hm-channel-list-panel">
          <div class="hm-panel-header">
            <div class="hm-panel-title">${esc(t('engine.hermesChannelPlatforms'))}</div>
          </div>
          <div class="hm-panel-body hm-panel-body--tight">
            <div class="hm-channel-list" role="tablist" aria-label="${esc(t('engine.hermesChannelPlatforms'))}">
              ${CHANNELS.map(item => {
                const itemForm = normalizeForm(item.id, values[item.id])
                return `
                  <button class="hm-channel-tab ${item.id === active ? 'is-active' : ''}" data-channel="${esc(item.id)}" role="tab" aria-selected="${item.id === active ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>
                    <span class="hm-channel-tab-icon">${icon(item.icon, 16)}</span>
                    <span class="hm-channel-tab-main">
                      <strong>${esc(t(item.titleKey))}</strong>
                      <small>${esc(itemForm.enabled ? t('engine.hermesChannelEnabled') : t('engine.hermesChannelDisabled'))}</small>
                    </span>
                    <span class="hm-channel-dot ${itemForm.enabled ? 'is-on' : ''}" aria-hidden="true"></span>
                  </button>
                `
              }).join('')}
            </div>
          </div>
        </section>

        <section class="hm-panel hm-channel-form-panel">
          <div class="hm-panel-header">
            <div>
              <div class="hm-panel-title">${icon(channel.icon, 15)}${esc(t(channel.titleKey))}</div>
              <div class="hm-channel-panel-desc">${esc(t(channel.descKey))}</div>
            </div>
            <label class="hm-channel-switch">
              <input class="hm-channel-input" data-key="enabled" type="checkbox" ${form.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${esc(form.enabled ? t('engine.hermesChannelEnabled') : t('engine.hermesChannelDisabled'))}</span>
            </label>
          </div>
          <div class="hm-panel-body">
            ${loading ? `
              <div class="hm-channel-loading">${esc(t('common.loading'))}...</div>
            ` : `
              <div class="hm-channel-section">
                <div class="hm-channel-section-title">${esc(t('engine.hermesChannelCredentials'))}</div>
                <div class="hm-field-row">
                  ${channel.fields.map(field => renderField(field, form, disabled)).join('')}
                </div>
                ${(channel.toggles || []).length ? `
                  <div class="hm-channel-toggle-grid">
                    ${channel.toggles.map(toggle => `
                      <label class="hm-channel-check">
                        <input class="hm-channel-input" data-key="${esc(toggle.key)}" type="checkbox" ${form[toggle.key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                        <span>${esc(t(toggle.labelKey))}</span>
                      </label>
                    `).join('')}
                  </div>
                ` : ''}
              </div>

              <div class="hm-channel-section">
                <div class="hm-channel-section-title">${esc(t('engine.hermesChannelAccessPolicy'))}</div>
                <div class="hm-field-row">
                  ${COMMON_FIELDS.slice(0, 2).map(field => renderField(field, form, disabled)).join('')}
                </div>
                <label class="hm-channel-check hm-channel-check--wide">
                  <input class="hm-channel-input" data-key="requireMention" type="checkbox" ${form.requireMention ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                  <span>${esc(t('engine.hermesChannelRequireMention'))}</span>
                </label>
                <div class="hm-field-row">
                  ${COMMON_FIELDS.slice(2).map(field => renderField(field, form, disabled)).join('')}
                </div>
              </div>

              <div class="hm-channel-footnote">
                ${icon('info', 14)}
                <span>${esc(t('engine.hermesChannelRestartHint'))}</span>
              </div>
            `}
          </div>
        </section>
      </div>
    `

    el.querySelector('#hm-channels-reload')?.addEventListener('click', load)
    el.querySelector('#hm-channels-save')?.addEventListener('click', save)
    el.querySelectorAll('.hm-channel-tab').forEach(button => {
      button.addEventListener('click', () => {
        if (!loading && !saving) values = { ...values, [active]: collectForm(el, active) }
        active = button.dataset.channel || active
        error = ''
        success = ''
        draw()
      })
    })
  }

  async function load() {
    loading = true
    error = ''
    success = ''
    draw()
    try {
      const data = await api.hermesChannelConfigRead()
      values = data?.values || {}
      configPath = data?.configPath || ''
    } catch (err) {
      error = humanizeErrorText(err, t('engine.hermesChannelLoadFailed'))
    } finally {
      loading = false
      draw()
    }
  }

  async function save() {
    const form = collectForm(el, active)
    values = { ...values, [active]: form }
    saving = true
    error = ''
    success = ''
    draw()
    try {
      const result = await api.hermesChannelConfigSave(active, form)
      values = { ...values, [active]: result?.values || form }
      success = t('engine.hermesChannelSaved')
      toast(success, 'success')
    } catch (err) {
      error = humanizeErrorText(err, t('engine.hermesChannelSaveFailed'))
      toast(error, 'error')
    } finally {
      saving = false
      draw()
    }
  }

  draw()
  load()
  return el
}
