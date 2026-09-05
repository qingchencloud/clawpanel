import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import { t } from '../lib/i18n.js'
import { PROVIDER_PRESETS, API_TYPES } from '../lib/model-presets.js'
import {
  channelFingerprint,
  channelProviderKey,
  hermesSyncSupported,
  dshSyncSupported,
  openCodeSyncSupported,
  assistantSyncSupported,
  getDshPort,
  resolveHermesTarget,
  syncChannelToOpenclaw,
  syncChannelToHermes,
  syncChannelToDsh,
  syncChannelToOpenCode,
  syncChannelToAssistant,
  importChannelsFromOpenclaw,
} from '../lib/model-channels.js'

function esc(value) {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function attr(value) {
  return esc(value).replace(/'/g, '&#39;')
}

function newChannelId() {
  return `ch-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

// apiType 值 → 用户可读标签（卡片与芯片展示用）
function apiTypeLabel(value) {
  return API_TYPES.find(item => item.value === value)?.label || value
}

// 编辑器内的内核适配性提示：该 API 类型能同步到哪些目标
function renderCompatHint(apiType) {
  const fake = { apiType }
  const targets = [
    { label: t('modelChannels.targetOpenclaw'), ok: true, hint: '' },
    { label: t('modelChannels.targetHermes'), ok: hermesSyncSupported(fake), hint: t('modelChannels.syncHermesUnsupported') },
    { label: t('modelChannels.targetDsh'), ok: dshSyncSupported(fake), hint: t('modelChannels.syncDshUnsupported') },
    { label: t('modelChannels.targetOpenCode'), ok: openCodeSyncSupported(fake), hint: t('modelChannels.syncOpenCodeUnsupported') },
    { label: t('modelChannels.targetAssistant'), ok: assistantSyncSupported(fake), hint: t('modelChannels.syncAssistantUnsupported') },
  ]
  const parts = targets.map(item => item.ok
    ? `<span style="color:var(--success)">✓ ${esc(item.label)}</span>`
    : `<span style="color:var(--text-tertiary)" title="${attr(item.hint)}">— ${esc(item.label)}</span>`)
  return `${esc(t('modelChannels.compatLabel'))}: ${parts.join(' · ')}`
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page channels-hub-page'
  const state = {
    doc: { version: 1, channels: [], syncState: {} },
    loaded: false,
    editing: null, // 编辑中的渠道草稿（null = 未打开编辑器）
    fetchBusy: false,
    syncBusy: '',
  }

  page.innerHTML = `
    <style>
      .channels-hub-page .mch-header-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .channels-hub-page .mch-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border-primary);border-radius:8px;background:var(--bg-secondary);color:var(--text-secondary);font-size:12px}
      .channels-hub-page .mch-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
      .channels-hub-page .mch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
      .channels-hub-page .mch-card{border:1px solid var(--border-primary);border-radius:10px;background:var(--bg-primary);padding:16px;display:grid;gap:10px;min-width:0}
      .channels-hub-page .mch-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
      .channels-hub-page .mch-card-title{font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;min-width:0}
      .channels-hub-page .mch-card-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .channels-hub-page .mch-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border-primary);border-radius:999px;padding:2px 8px;font-size:11px;color:var(--text-tertiary);white-space:nowrap}
      .channels-hub-page .mch-url{font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .channels-hub-page .mch-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-tertiary)}
      .channels-hub-page .mch-sync-row{display:grid;gap:6px;border-top:1px solid var(--border-primary);padding-top:10px}
      .channels-hub-page .mch-sync-line{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .channels-hub-page .mch-sync-target{font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;min-width:0}
      .channels-hub-page .mch-state{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--border-primary);color:var(--text-tertiary);white-space:nowrap}
      .channels-hub-page .mch-state.synced{color:var(--success);border-color:color-mix(in srgb,var(--success) 35%,var(--border-primary))}
      .channels-hub-page .mch-state.drift{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 35%,var(--border-primary))}
      .channels-hub-page .mch-actions{display:flex;gap:6px;flex-wrap:wrap}
      .channels-hub-page .mch-empty{border:1px dashed var(--border-primary);border-radius:10px;background:var(--bg-secondary);padding:40px 20px;display:grid;justify-items:center;gap:14px;color:var(--text-tertiary);text-align:center;line-height:1.7}
      .channels-hub-page .mch-how{border:1px solid var(--border-primary);border-radius:10px;background:var(--bg-secondary);padding:14px 16px;margin-bottom:16px}
      .channels-hub-page .mch-how ol{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:6px}
      .channels-hub-page .mch-how li{display:flex;gap:8px;align-items:flex-start;color:var(--text-secondary);font-size:13px}
      .channels-hub-page .mch-how b{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:var(--primary);color:#fff;font-size:11px;flex:0 0 auto;margin-top:1px}
      .channels-hub-page .mch-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .channels-hub-page .mch-editor .wide{grid-column:1/-1}
      .channels-hub-page .mch-editor textarea.form-input{min-height:120px;resize:vertical;font-family:var(--font-mono);font-size:12px;line-height:1.6}
      @media (max-width:700px){
        .channels-hub-page .mch-grid{grid-template-columns:1fr}
        .channels-hub-page .mch-editor{grid-template-columns:1fr}
      }
    </style>
    <div class="page-header">
      <div class="mch-header-row">
        <div>
          <h1 class="page-title">${t('modelChannels.title')}</h1>
          <p class="page-desc">${t('modelChannels.desc')}</p>
        </div>
        <div class="mch-badge">${icon('lock', 14)} ${t('modelChannels.localOnlyHint')}</div>
      </div>
    </div>
    <div id="mch-body">
      <div class="stat-card loading-placeholder" style="height:120px"></div>
    </div>
  `

  bindEvents(page, state)
  loadInitial(page, state)
  return page
}

async function loadInitial(page, state) {
  try {
    state.doc = await api.readModelChannels()
    state.loaded = true
    renderBody(page, state)
  } catch (error) {
    console.error('[model-channels] load failed', error)
    page.querySelector('#mch-body').innerHTML = `<div class="mch-empty">${esc(error?.message || String(error))}</div>`
  }
}

function syncStateOf(state, target, channel) {
  const record = state.doc?.syncState?.[target]?.[channel.id]
  if (!record) return 'never'
  if (record.verified === true) {
    return record.hash === channelFingerprint(channel) ? 'synced' : 'drift'
  }
  return 'never'
}

function renderBody(page, state) {
  const body = page.querySelector('#mch-body')
  const channels = state.doc?.channels || []
  body.innerHTML = `
    ${channels.length ? '' : renderHow()}
    <div class="mch-toolbar">
      <button class="btn btn-primary" type="button" data-action="add">${icon('plus-circle', 14)} ${t('modelChannels.addChannel')}</button>
      <button class="btn btn-secondary" type="button" data-action="import">${icon('download', 14)} ${t('modelChannels.importExisting')}</button>
    </div>
    ${channels.length
      ? `<div class="mch-grid">${channels.map(ch => renderChannelCard(state, ch)).join('')}</div>`
      : `<div class="mch-empty">${icon('plug', 28)}<div>${t('modelChannels.empty')}</div></div>`}
    ${state.editing ? renderEditor(state) : ''}
  `
}

function renderHow() {
  return `
    <div class="mch-how">
      <div style="font-weight:700;color:var(--text-primary)">${icon('lightbulb', 14)} ${t('modelChannels.howTitle')}</div>
      <ol>
        <li><b>1</b><span>${t('modelChannels.how1')}</span></li>
        <li><b>2</b><span>${t('modelChannels.how2')}</span></li>
        <li><b>3</b><span>${t('modelChannels.how3')}</span></li>
      </ol>
    </div>
  `
}

function renderSyncLine(state, channel, target, label, supported, unsupportedHint, syncLabel) {
  if (!supported) {
    return `
      <div class="mch-sync-line">
        <div class="mch-sync-target">${label}</div>
        <span class="mch-state" title="${attr(unsupportedHint)}">${t('modelChannels.stateUnsupported')}</span>
      </div>
    `
  }
  const stateKey = syncStateOf(state, target, channel)
  const stateLabel = stateKey === 'synced' ? t('modelChannels.stateSynced')
    : stateKey === 'drift' ? t('modelChannels.stateDrift') : t('modelChannels.stateNever')
  return `
    <div class="mch-sync-line">
      <div class="mch-sync-target">${label} <span class="mch-state ${stateKey}">${stateLabel}</span></div>
      <button class="btn btn-xs ${stateKey === 'synced' ? 'btn-secondary' : 'btn-primary'}" type="button"
        data-action="sync" data-target="${target}" data-channel-id="${attr(channel.id)}"
        ${state.syncBusy ? 'disabled' : ''}>${icon('upload', 12)} ${syncLabel}</button>
    </div>
  `
}

function renderChannelCard(state, channel) {
  const presetLabel = PROVIDER_PRESETS.find(p => p.key === channel.presetKey)?.label || t('modelChannels.presetCustom')
  const keyInfo = channel.apiKeySaved
    ? t('modelChannels.keySaved', { mask: channel.apiKeyMask || '***' })
    : t('modelChannels.keyMissing')
  return `
    <div class="mch-card" data-channel-id="${attr(channel.id)}">
      <div class="mch-card-head">
        <div class="mch-card-title">${icon('plug', 16)} <span title="${attr(channel.name)}">${esc(channel.name)}</span></div>
        <span class="mch-chip">${esc(presetLabel)}</span>
      </div>
      <div class="mch-url" title="${attr(channel.baseUrl)}">${esc(channel.baseUrl || '-')}</div>
      <div class="mch-meta">
        <span class="mch-chip">${esc(apiTypeLabel(channel.apiType))}</span>
        <span class="mch-chip">${icon('box', 11)} ${t('modelChannels.modelCount', { count: (channel.models || []).length })}</span>
        <span class="mch-chip ${channel.apiKeySaved ? '' : 'mch-chip-warn'}">${icon('key', 11)} ${esc(keyInfo)}</span>
        ${channel.defaultModel ? `<span class="mch-chip">${icon('check', 11)} ${esc(channel.defaultModel)}</span>` : ''}
      </div>
      <div class="mch-sync-row">
        <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);letter-spacing:0.3px">${t('modelChannels.bindings')}</div>
        ${renderSyncLine(state, channel, 'openclaw', t('modelChannels.targetOpenclaw'), true, '', t('modelChannels.syncOpenclaw'))}
        ${renderSyncLine(state, channel, 'hermes', t('modelChannels.targetHermes'), hermesSyncSupported(channel), t('modelChannels.syncHermesUnsupported'), t('modelChannels.syncHermes'))}
        ${renderSyncLine(state, channel, 'dsh', t('modelChannels.targetDsh'), dshSyncSupported(channel), t('modelChannels.syncDshUnsupported'), t('modelChannels.syncDsh'))}
        ${renderSyncLine(state, channel, 'opencode', t('modelChannels.targetOpenCode'), openCodeSyncSupported(channel), t('modelChannels.syncOpenCodeUnsupported'), t('modelChannels.syncOpenCode'))}
        ${renderSyncLine(state, channel, 'assistant', t('modelChannels.targetAssistant'), assistantSyncSupported(channel), t('modelChannels.syncAssistantUnsupported'), t('modelChannels.syncAssistant'))}
      </div>
      <div class="mch-actions">
        <button class="btn btn-xs btn-secondary" type="button" data-action="edit" data-channel-id="${attr(channel.id)}">${icon('edit', 12)} ${t('common.edit')}</button>
        <button class="btn btn-xs btn-secondary" type="button" data-action="delete" data-channel-id="${attr(channel.id)}">${icon('trash', 12)} ${t('common.delete')}</button>
      </div>
    </div>
  `
}

function renderEditor(state) {
  const draft = state.editing
  const presetOptions = [
    `<option value="" ${draft.presetKey ? '' : 'selected'}>${t('modelChannels.presetCustom')}</option>`,
    ...PROVIDER_PRESETS.map(p => `<option value="${attr(p.key)}" ${p.key === draft.presetKey ? 'selected' : ''}>${esc(p.label)}</option>`),
  ].join('')
  const modelLines = (draft.models || []).map(m => m.id).join('\n')
  const modelIds = (draft.models || []).map(m => m.id)
  const uniformValue = key => {
    const values = [...new Set((draft.models || []).map(model => Number(model?.[key]) || 0).filter(Boolean))]
    return values.length === 1 ? values[0] : ''
  }
  const contextWindow = uniformValue('contextWindow') || uniformValue('contextTokens')
  const maxTokens = uniformValue('maxTokens')
  return `
    <div class="modal-overlay" id="mch-editor-overlay">
      <div class="modal" style="max-width:640px;max-height:86vh;overflow:auto">
        <div class="modal-title">${draft.isNew ? t('modelChannels.addChannel') : t('modelChannels.editChannel')}</div>
        <form id="mch-editor-form" class="mch-editor">
          <div class="form-group">
            <label class="form-label" for="mch-name">${t('modelChannels.name')}</label>
            <input class="form-input" id="mch-name" value="${attr(draft.name)}" placeholder="${attr(t('modelChannels.namePlaceholder'))}">
          </div>
          <div class="form-group">
            <label class="form-label" for="mch-preset">${t('modelChannels.preset')}</label>
            <select class="form-input" id="mch-preset">${presetOptions}</select>
            <div class="form-hint">${t('modelChannels.presetHint')}</div>
          </div>
          <div class="form-group wide">
            <label class="form-label" for="mch-base-url">${t('modelChannels.baseUrl')}</label>
            <input class="form-input" id="mch-base-url" spellcheck="false" value="${attr(draft.baseUrl)}" placeholder="https://api.example.com/v1">
          </div>
          <div class="form-group">
            <label class="form-label" for="mch-api-type">${t('modelChannels.apiType')}</label>
            <select class="form-input" id="mch-api-type">
              ${API_TYPES.map(item => `<option value="${attr(item.value)}" ${item.value === draft.apiType ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
            </select>
            <div class="form-hint" id="mch-compat">${renderCompatHint(draft.apiType)}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="mch-api-key">${t('modelChannels.apiKey')}</label>
            <input class="form-input" id="mch-api-key" type="password" autocomplete="new-password" spellcheck="false"
              placeholder="${draft.apiKeySaved ? attr(t('modelChannels.keySaved', { mask: draft.apiKeyMask || '***' })) : 'sk-...'}">
            <div class="form-hint">${draft.apiKeySaved ? t('modelChannels.apiKeyHint') : ''}</div>
          </div>
          <div class="form-group wide">
            <label class="form-label" for="mch-models">${t('modelChannels.models')}</label>
            <textarea class="form-input" id="mch-models" spellcheck="false" placeholder="gpt-4o&#10;gpt-4o-mini">${esc(modelLines)}</textarea>
            <div class="form-hint" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <span>${t('modelChannels.modelsHint')}</span>
              <button class="btn btn-xs btn-secondary" type="button" data-action="fetch-models" ${state.fetchBusy ? 'disabled' : ''}>
                ${icon('refresh-cw', 12)} ${state.fetchBusy ? t('modelChannels.fetching') : t('modelChannels.fetchModels')}
              </button>
            </div>
          </div>
          <div class="form-group wide">
            <label class="form-label" for="mch-default-model">${t('modelChannels.defaultModel')}</label>
            <select class="form-input" id="mch-default-model">
              <option value="">${t('modelChannels.defaultModelNone')}</option>
              ${modelIds.map(id => `<option value="${attr(id)}" ${id === draft.defaultModel ? 'selected' : ''}>${esc(id)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="mch-context-window">${t('modelChannels.contextWindow')}</label>
            <input class="form-input" id="mch-context-window" type="number" min="1" step="1" value="${attr(contextWindow)}" placeholder="131072">
            <div class="form-hint">${t('modelChannels.contextWindowHint')}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="mch-max-tokens">${t('modelChannels.maxTokens')}</label>
            <input class="form-input" id="mch-max-tokens" type="number" min="1" step="1" value="${attr(maxTokens)}" placeholder="8192">
            <div class="form-hint">${t('modelChannels.maxTokensHint')}</div>
          </div>
        </form>
        <div class="modal-actions" style="margin-top:14px">
          <button class="btn btn-secondary" type="button" data-action="editor-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" type="button" data-action="editor-save">${icon('check', 14)} ${t('modelChannels.save')}</button>
        </div>
      </div>
    </div>
  `
}

// 从编辑器 DOM 收集草稿（保存 / 拉取模型共用）
function collectDraft(page, state) {
  const draft = state.editing
  if (!draft) return null
  draft.name = page.querySelector('#mch-name')?.value?.trim() || ''
  draft.presetKey = page.querySelector('#mch-preset')?.value || ''
  draft.baseUrl = (page.querySelector('#mch-base-url')?.value || '').trim().replace(/\/+$/, '')
  draft.apiType = page.querySelector('#mch-api-type')?.value || 'openai-completions'
  draft.typedKey = page.querySelector('#mch-api-key')?.value?.trim() || ''
  const lines = (page.querySelector('#mch-models')?.value || '')
    .split('\n').map(line => line.trim()).filter(Boolean)
  const seen = new Set()
  const previousModels = new Map((draft.models || []).map(model => [model.id, model]))
  draft.models = lines
    .filter(id => (seen.has(id) ? false : seen.add(id)))
    .map(id => ({ ...(previousModels.get(id) || {}), id }))
  const contextWindow = Number(page.querySelector('#mch-context-window')?.value || 0)
  const maxTokens = Number(page.querySelector('#mch-max-tokens')?.value || 0)
  if (Number.isInteger(contextWindow) && contextWindow > 0) {
    draft.models = draft.models.map(model => ({ ...model, contextWindow }))
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) {
    draft.models = draft.models.map(model => ({ ...model, maxTokens }))
  }
  draft.defaultModel = page.querySelector('#mch-default-model')?.value || ''
  return draft
}

function bindEvents(page, state) {
  page.addEventListener('change', (event) => {
    // 选择预设 → 自动填 Base URL + API 类型（自定义则不动现有值）
    if (event.target.id === 'mch-preset' && state.editing) {
      const preset = PROVIDER_PRESETS.find(p => p.key === event.target.value)
      if (preset) {
        const baseUrlInput = page.querySelector('#mch-base-url')
        const apiTypeSelect = page.querySelector('#mch-api-type')
        if (baseUrlInput && preset.baseUrl) baseUrlInput.value = preset.baseUrl
        if (apiTypeSelect && preset.api) apiTypeSelect.value = preset.api
        const nameInput = page.querySelector('#mch-name')
        if (nameInput && !nameInput.value.trim()) nameInput.value = preset.label
        const compat = page.querySelector('#mch-compat')
        if (compat && preset.api) compat.innerHTML = renderCompatHint(preset.api)
      }
    }
    // API 类型变化 → 实时刷新内核适配性提示
    if (event.target.id === 'mch-api-type' && state.editing) {
      const compat = page.querySelector('#mch-compat')
      if (compat) compat.innerHTML = renderCompatHint(event.target.value)
    }
  })

  // 模型列表变化时同步默认模型下拉选项
  page.addEventListener('input', (event) => {
    if (event.target.id === 'mch-models' && state.editing) {
      const select = page.querySelector('#mch-default-model')
      if (!select) return
      const current = select.value
      const ids = event.target.value.split('\n').map(v => v.trim()).filter(Boolean)
      select.innerHTML = `<option value="">${t('modelChannels.defaultModelNone')}</option>`
        + ids.map(id => `<option value="${attr(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`).join('')
    }
  })

  page.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]')
    if (!actionEl) return
    const action = actionEl.dataset.action
    try {
      if (action === 'add') {
        state.editing = {
          id: newChannelId(), isNew: true, name: '', presetKey: '', baseUrl: '',
          apiType: 'openai-completions', apiKeySaved: false, apiKeyMask: '',
          credentialVersion: 0, providerConfig: {}, models: [], defaultModel: '', typedKey: '',
        }
        renderBody(page, state)
      } else if (action === 'edit') {
        const channel = (state.doc.channels || []).find(c => c.id === actionEl.dataset.channelId)
        if (channel) {
          state.editing = { ...channel, models: (channel.models || []).map(m => ({ ...m })), isNew: false, typedKey: '' }
          renderBody(page, state)
        }
      } else if (action === 'editor-cancel') {
        state.editing = null
        renderBody(page, state)
      } else if (action === 'editor-save') {
        await saveEditor(page, state)
      } else if (action === 'fetch-models') {
        await fetchModelsIntoEditor(page, state)
      } else if (action === 'delete') {
        await deleteChannel(page, state, actionEl.dataset.channelId)
      } else if (action === 'import') {
        await importExisting(page, state)
      } else if (action === 'sync') {
        await syncChannel(page, state, actionEl.dataset.channelId, actionEl.dataset.target)
      }
    } catch (error) {
      toast(error?.message || String(error), 'error')
    }
  })
}

async function persistDoc(state) {
  state.doc = await api.writeModelChannels(state.doc)
}

async function saveEditor(page, state) {
  const draft = collectDraft(page, state)
  if (!draft) return
  if (!draft.name) { toast(t('modelChannels.nameRequired'), 'warning'); return }
  if (!/^https?:\/\//.test(draft.baseUrl)) { toast(t('modelChannels.baseUrlRequired'), 'warning'); return }
  const channel = {
    id: draft.id,
    name: draft.name,
    presetKey: draft.presetKey,
    baseUrl: draft.baseUrl,
    apiType: draft.apiType,
    // 留空 = 保持已保存 Key（后端 __KEEP__ 语义）
    apiKey: draft.typedKey || '',
    credentialVersion: draft.credentialVersion || 0,
    providerConfig: draft.providerConfig || {},
    models: draft.models,
    defaultModel: draft.defaultModel,
    enabled: true,
  }
  const channels = [...(state.doc.channels || [])]
  const index = channels.findIndex(c => c.id === channel.id)
  if (index >= 0) channels[index] = channel
  else channels.push(channel)
  state.doc = { ...state.doc, channels }
  await persistDoc(state)
  state.editing = null
  toast(t('modelChannels.saved'), 'success')
  renderBody(page, state)
}

async function fetchModelsIntoEditor(page, state) {
  const draft = collectDraft(page, state)
  if (!draft) return
  // 明文 Key：优先编辑框输入，其次已保存渠道 reveal
  let apiKey = draft.typedKey
  if (!apiKey && draft.apiKeySaved) {
    apiKey = await api.revealModelChannelKey(draft.id).catch(() => '')
  }
  if (!/^https?:\/\//.test(draft.baseUrl) || !apiKey) {
    toast(t('modelChannels.fetchNeedInput'), 'warning')
    return
  }
  state.fetchBusy = true
  renderBody(page, state)
  try {
    const ids = await api.listRemoteModels(draft.baseUrl, apiKey, draft.apiType)
    const merged = [...new Set([...(draft.models || []).map(m => m.id), ...(Array.isArray(ids) ? ids : [])])]
    const previousModels = new Map((draft.models || []).map(item => [item.id, item]))
    state.editing.models = merged.map(id => ({ ...(previousModels.get(id) || {}), id }))
    toast(merged.length ? t('modelChannels.fetchOk', { count: (Array.isArray(ids) ? ids : []).length }) : t('modelChannels.fetchEmpty'), merged.length ? 'success' : 'info')
  } finally {
    state.fetchBusy = false
    renderBody(page, state)
  }
}

async function deleteChannel(page, state, channelId) {
  const channel = (state.doc.channels || []).find(c => c.id === channelId)
  if (!channel) return
  const ok = await showConfirm(t('modelChannels.deleteConfirm', { name: channel.name }))
  if (!ok) return
  state.doc = { ...state.doc, channels: (state.doc.channels || []).filter(c => c.id !== channelId) }
  for (const target of ['openclaw', 'hermes', 'dsh', 'opencode', 'assistant']) {
    if (state.doc.syncState?.[target]) delete state.doc.syncState[target][channelId]
  }
  await persistDoc(state)
  toast(t('modelChannels.deleted'), 'success')
  renderBody(page, state)
}

async function importExisting(page, state) {
  const imported = await importChannelsFromOpenclaw(state.doc.channels || [])
  if (!imported.length) {
    toast(t('modelChannels.importNone'), 'info')
    return
  }
  state.doc = { ...state.doc, channels: [...(state.doc.channels || []), ...imported] }
  await persistDoc(state)
  toast(t('modelChannels.importDone', { count: imported.length }), 'success')
  renderBody(page, state)
}

function recordSync(state, target, channel, extra = {}) {
  state.doc.syncState = state.doc.syncState && typeof state.doc.syncState === 'object' ? state.doc.syncState : {}
  state.doc.syncState[target] = state.doc.syncState[target] || {}
  state.doc.syncState[target][channel.id] = {
    hash: channelFingerprint(channel),
    at: new Date().toISOString(),
    ...extra,
  }
}

async function syncChannel(page, state, channelId, target) {
  const channel = (state.doc.channels || []).find(c => c.id === channelId)
  if (!channel || state.syncBusy) return
  if (!channel.apiKeySaved) { toast(t('modelChannels.noKeyForSync'), 'warning'); return }

  state.syncBusy = target
  renderBody(page, state)
  try {
    if (target === 'openclaw') {
      const providerKey = channelProviderKey(channel)
      const ok = await showConfirm(t('modelChannels.syncOpenclawConfirm', { key: providerKey, count: (channel.models || []).length }), { variant: 'primary' })
      if (!ok) return
      let setDefault = false
      if (channel.defaultModel) {
        setDefault = await showConfirm(t('modelChannels.syncSetDefaultAsk', { model: channel.defaultModel }), { variant: 'primary' })
      }
      const result = await syncChannelToOpenclaw(channel, { setDefault })
      recordSync(state, target, channel, { providerKey: result.providerKey, verified: result.verified })
      await persistDoc(state)
      toast(t('modelChannels.syncDone', { target: t('modelChannels.targetOpenclaw') }), 'success')
    } else if (target === 'hermes') {
      const hermesTarget = await resolveHermesTarget(channel)
      if (!hermesTarget) { toast(t('modelChannels.syncHermesUnsupported'), 'warning'); return }
      const ok = await showConfirm(t('modelChannels.syncHermesConfirm', { env: hermesTarget.apiKeyEnvVars[0], provider: hermesTarget.id }), { variant: 'primary' })
      if (!ok) return
      let setDefault = false
      if (channel.defaultModel) {
        setDefault = await showConfirm(t('modelChannels.syncSetDefaultAsk', { model: channel.defaultModel }), { variant: 'primary' })
      }
      const result = await syncChannelToHermes(channel, { setDefault })
      recordSync(state, target, channel, { providerId: result.providerId, verified: result.verified })
      await persistDoc(state)
      toast(t('modelChannels.syncDone', { target: t('modelChannels.targetHermes') }), 'success')
    } else if (target === 'dsh') {
      if (!dshSyncSupported(channel)) { toast(t('modelChannels.syncDshUnsupported'), 'warning'); return }
      const port = getDshPort()
      const ok = await showConfirm(t('modelChannels.syncDshConfirm', { port, count: (channel.models || []).length }), { variant: 'primary' })
      if (!ok) return
      let setDefault = false
      if (channel.defaultModel) {
        setDefault = await showConfirm(t('modelChannels.syncSetDefaultAsk', { model: channel.defaultModel }), { variant: 'primary' })
      }
      const result = await syncChannelToDsh(channel, { setDefault, port })
      recordSync(state, target, channel, { providerId: result.providerId, verified: result.verified })
      await persistDoc(state)
      toast(t('modelChannels.syncDone', { target: t('modelChannels.targetDsh') }), 'success')
    } else if (target === 'opencode') {
      if (!openCodeSyncSupported(channel)) { toast(t('modelChannels.syncOpenCodeUnsupported'), 'warning'); return }
      const ok = await showConfirm(t('modelChannels.syncOpenCodeConfirm', { count: (channel.models || []).length }), { variant: 'primary' })
      if (!ok) return
      let setDefault = false
      if (channel.defaultModel) {
        setDefault = await showConfirm(t('modelChannels.syncSetDefaultAsk', { model: channel.defaultModel }), { variant: 'primary' })
      }
      const result = await syncChannelToOpenCode(channel, { setDefault })
      recordSync(state, target, channel, { providerId: result.providerId, verified: result.verified })
      await persistDoc(state)
      toast(t('modelChannels.syncDone', { target: t('modelChannels.targetOpenCode') }), 'success')
    } else if (target === 'assistant') {
      const model = channel.defaultModel || channel.models?.[0]?.id || ''
      const ok = await showConfirm(t('modelChannels.syncAssistantConfirm', { model: model || '-' }), { variant: 'primary' })
      if (!ok) return
      const apiKey = await api.revealModelChannelKey(channel.id)
      if (!apiKey) { toast(t('modelChannels.noKeyForSync'), 'warning'); return }
      const result = syncChannelToAssistant(channel, apiKey, model)
      recordSync(state, target, channel, { model: result.model, verified: result.verified })
      await persistDoc(state)
      toast(t('modelChannels.syncDone', { target: t('modelChannels.targetAssistant') }), 'success')
    }
  } catch (error) {
    if (error?.message === 'unsupported') toast(t('modelChannels.syncHermesUnsupported'), 'warning')
    else if (error?.message === 'unsupported-dsh') toast(t('modelChannels.syncDshUnsupported'), 'warning')
    else if (error?.message === 'unsupported-opencode') toast(t('modelChannels.syncOpenCodeUnsupported'), 'warning')
    else if (error?.message === 'no-key') toast(t('modelChannels.noKeyForSync'), 'warning')
    else throw error
  } finally {
    state.syncBusy = ''
    renderBody(page, state)
  }
}
