/**
 * Hermes Agent 配置编辑
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { humanizeError } from '../../../lib/humanize-error.js'

const SESSION_RUNTIME_DEFAULTS = {
  sessionResetMode: 'both',
  idleMinutes: 1440,
  atHour: 4,
  groupSessionsPerUser: true,
  threadSessionsPerUser: false,
}

const COMPRESSION_DEFAULTS = {
  enabled: true,
  threshold: 0.5,
  targetRatio: 0.2,
  protectLastN: 20,
  protectFirstN: 3,
  abortOnSummaryFailure: false,
}

const TOOL_GUARDRAILS_DEFAULTS = {
  warningsEnabled: true,
  hardStopEnabled: false,
  warnExactFailure: 2,
  warnSameToolFailure: 3,
  warnNoProgress: 2,
  hardStopExactFailure: 5,
  hardStopSameToolFailure: 8,
  hardStopNoProgress: 5,
}

const MEMORY_DEFAULTS = {
  memoryEnabled: true,
  userProfileEnabled: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  nudgeInterval: 10,
  flushMinTurns: 6,
}

const SKILLS_DEFAULTS = {
  creationNudgeInterval: 15,
  externalDirs: '',
}

const QUICK_COMMANDS_DEFAULTS = {
  quickCommandsJson: '{}',
}

const UNAUTHORIZED_DM_DEFAULTS = {
  unauthorizedDmBehavior: 'pair',
}

const SECURITY_DEFAULTS = {
  tirithEnabled: true,
  tirithPath: 'tirith',
  tirithTimeout: 5,
  tirithFailOpen: true,
}

const HUMAN_DELAY_DEFAULTS = {
  humanDelayMode: 'off',
  humanDelayMinMs: 800,
  humanDelayMaxMs: 2500,
}

const STREAMING_DEFAULTS = {
  enabled: false,
  transport: 'edit',
  editInterval: 0.8,
  bufferThreshold: 24,
  cursor: ' ▉',
  freshFinalAfterSeconds: 60,
}

const EXECUTION_LIMITS_DEFAULTS = {
  codeExecutionMode: 'project',
  codeExecutionTimeout: 300,
  codeExecutionMaxToolCalls: 50,
  delegationMaxIterations: 50,
  delegationChildTimeoutSeconds: 600,
  delegationMaxConcurrentChildren: 3,
  delegationMaxSpawnDepth: 1,
  delegationOrchestratorEnabled: true,
  delegationSubagentAutoApprove: false,
  delegationInheritMcpToolsets: true,
}

const TERMINAL_DEFAULTS = {
  terminalBackend: 'local',
  terminalCwd: '.',
  terminalTimeout: 180,
  terminalLifetimeSeconds: 300,
  terminalDockerMountCwdToWorkspace: false,
  terminalDockerRunAsHostUser: false,
  terminalContainerCpu: 1,
  terminalContainerMemory: 5120,
  terminalContainerDisk: 51200,
  terminalContainerPersistent: true,
}

const SESSION_RESET_MODES = ['both', 'idle', 'daily', 'none']
const STREAMING_TRANSPORTS = ['edit', 'auto', 'draft', 'off']
const CODE_EXECUTION_MODES = ['project', 'strict']
const TERMINAL_BACKENDS = ['local', 'ssh', 'docker', 'singularity', 'modal', 'daytona', 'vercel_sandbox']
const UNAUTHORIZED_DM_BEHAVIORS = ['pair', 'ignore']
const HUMAN_DELAY_MODES = ['off', 'natural', 'custom']

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'
  let yaml = ''
  let runtimeValues = { ...SESSION_RUNTIME_DEFAULTS }
  let compressionValues = { ...COMPRESSION_DEFAULTS }
  let toolGuardrailsValues = { ...TOOL_GUARDRAILS_DEFAULTS }
  let memoryValues = { ...MEMORY_DEFAULTS }
  let skillsValues = { ...SKILLS_DEFAULTS }
  let quickCommandsValues = { ...QUICK_COMMANDS_DEFAULTS }
  let unauthorizedDmValues = { ...UNAUTHORIZED_DM_DEFAULTS }
  let securityValues = { ...SECURITY_DEFAULTS }
  let humanDelayValues = { ...HUMAN_DELAY_DEFAULTS }
  let streamingValues = { ...STREAMING_DEFAULTS }
  let executionLimitsValues = { ...EXECUTION_LIMITS_DEFAULTS }
  let terminalValues = { ...TERMINAL_DEFAULTS }
  let loading = true
  let runtimeLoading = true
  let compressionLoading = true
  let toolGuardrailsLoading = true
  let memoryLoading = true
  let skillsLoading = true
  let quickCommandsLoading = true
  let unauthorizedDmLoading = true
  let securityLoading = true
  let humanDelayLoading = true
  let streamingLoading = true
  let executionLimitsLoading = true
  let terminalLoading = true
  let saving = false
  let runtimeSaving = false
  let compressionSaving = false
  let toolGuardrailsSaving = false
  let memorySaving = false
  let skillsSaving = false
  let quickCommandsSaving = false
  let unauthorizedDmSaving = false
  let securitySaving = false
  let humanDelaySaving = false
  let streamingSaving = false
  let executionLimitsSaving = false
  let terminalSaving = false
  let error = null
  let runtimeError = null
  let compressionError = null
  let toolGuardrailsError = null
  let memoryError = null
  let skillsError = null
  let quickCommandsError = null
  let unauthorizedDmError = null
  let securityError = null
  let humanDelayError = null
  let streamingError = null
  let executionLimitsError = null
  let terminalError = null

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function isBusy() {
    return loading || runtimeLoading || compressionLoading || toolGuardrailsLoading || memoryLoading || skillsLoading || quickCommandsLoading || unauthorizedDmLoading || securityLoading || humanDelayLoading || streamingLoading || executionLimitsLoading || terminalLoading || saving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || securitySaving || humanDelaySaving || streamingSaving || executionLimitsSaving || terminalSaving
  }

  function option(labelKey, value, selected) {
    return `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(t(labelKey))}</option>`
  }

  function renderError(err) {
    if (!err) return ''
    return `<div class="hm-config-alert is-error">
      <div>${esc(err.message || err)}</div>
      ${err.hint ? `<div class="hm-config-alert-hint">${esc(err.hint)}</div>` : ''}
      ${err.raw ? `<details><summary>${esc(t('common.errorRawLabel'))}</summary><pre>${esc(err.raw)}</pre></details>` : ''}
    </div>`
  }

  function renderRuntimePanel() {
    const disabled = loading || saving || runtimeLoading || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesSessionRuntimeTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesSessionRuntimeDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${runtimeSaving ? t('engine.hermesConfigStatusSaving') : runtimeLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesSessionRuntimeStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-runtime-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesSessionRuntimeSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(runtimeError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSessionResetMode')}</span>
              <select id="hm-session-reset-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${SESSION_RESET_MODES.map(mode => option(`engine.hermesSessionResetMode_${mode}`, mode, runtimeValues.sessionResetMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSessionIdleMinutes')}</span>
              <input id="hm-session-idle-minutes" class="hm-input" type="number" inputmode="numeric" min="1" max="525600" step="1" value="${esc(runtimeValues.idleMinutes)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSessionAtHour')}</span>
              <input id="hm-session-at-hour" class="hm-input" type="number" inputmode="numeric" min="0" max="23" step="1" value="${esc(runtimeValues.atHour)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-group-sessions-per-user" type="checkbox" ${runtimeValues.groupSessionsPerUser ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesGroupSessionsPerUser')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-thread-sessions-per-user" type="checkbox" ${runtimeValues.threadSessionsPerUser ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesThreadSessionsPerUser')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSessionRuntimeFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderCompressionPanel() {
    const disabled = loading || saving || compressionLoading || compressionSaving || runtimeSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-compression-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesCompressionTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesCompressionDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${compressionSaving ? t('engine.hermesConfigStatusSaving') : compressionLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesCompressionStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-compression-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesCompressionSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(compressionError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-compression-enabled" type="checkbox" ${compressionValues.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCompressionEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-compression-abort-on-summary-failure" type="checkbox" ${compressionValues.abortOnSummaryFailure ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCompressionAbortOnSummaryFailure')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-compression-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCompressionThreshold')}</span>
              <input id="hm-compression-threshold" class="hm-input" type="number" inputmode="decimal" min="0.1" max="0.95" step="0.05" value="${esc(compressionValues.threshold)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCompressionTargetRatio')}</span>
              <input id="hm-compression-target-ratio" class="hm-input" type="number" inputmode="decimal" min="0.1" max="0.8" step="0.05" value="${esc(compressionValues.targetRatio)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCompressionProtectLastN')}</span>
              <input id="hm-compression-protect-last-n" class="hm-input" type="number" inputmode="numeric" min="1" max="500" step="1" value="${esc(compressionValues.protectLastN)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCompressionProtectFirstN')}</span>
              <input id="hm-compression-protect-first-n" class="hm-input" type="number" inputmode="numeric" min="0" max="100" step="1" value="${esc(compressionValues.protectFirstN)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesCompressionFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderToolGuardrailsPanel() {
    const disabled = loading || saving || toolGuardrailsLoading || toolGuardrailsSaving || runtimeSaving || compressionSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-guardrails-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesToolGuardrailsTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesToolGuardrailsDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${toolGuardrailsSaving ? t('engine.hermesConfigStatusSaving') : toolGuardrailsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesToolGuardrailsStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-tool-guardrails-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesToolGuardrailsSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(toolGuardrailsError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-tool-guardrails-warnings-enabled" type="checkbox" ${toolGuardrailsValues.warningsEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesToolGuardrailsWarningsEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-tool-guardrails-hard-stop-enabled" type="checkbox" ${toolGuardrailsValues.hardStopEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesToolGuardrailsHardStopEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesToolGuardrailsWarnAfterTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-guardrails-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsWarnExactFailure')}</span>
              <input id="hm-tool-guardrails-warn-exact-failure" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.warnExactFailure)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsWarnSameToolFailure')}</span>
              <input id="hm-tool-guardrails-warn-same-tool-failure" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.warnSameToolFailure)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsWarnNoProgress')}</span>
              <input id="hm-tool-guardrails-warn-no-progress" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.warnNoProgress)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesToolGuardrailsHardStopAfterTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-guardrails-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsHardStopExactFailure')}</span>
              <input id="hm-tool-guardrails-hard-stop-exact-failure" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.hardStopExactFailure)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsHardStopSameToolFailure')}</span>
              <input id="hm-tool-guardrails-hard-stop-same-tool-failure" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.hardStopSameToolFailure)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesToolGuardrailsHardStopNoProgress')}</span>
              <input id="hm-tool-guardrails-hard-stop-no-progress" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(toolGuardrailsValues.hardStopNoProgress)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesToolGuardrailsFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderMemoryPanel() {
    const disabled = loading || saving || memoryLoading || memorySaving || skillsSaving || quickCommandsSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-memory-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesMemoryConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesMemoryConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${memorySaving ? t('engine.hermesConfigStatusSaving') : memoryLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesMemoryConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-memory-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesMemoryConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(memoryError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-memory-enabled" type="checkbox" ${memoryValues.memoryEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesMemoryConfigMemoryEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-memory-user-profile-enabled" type="checkbox" ${memoryValues.userProfileEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesMemoryConfigUserProfileEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-memory-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesMemoryConfigMemoryCharLimit')}</span>
              <input id="hm-memory-char-limit" class="hm-input" type="number" inputmode="numeric" min="100" max="200000" step="100" value="${esc(memoryValues.memoryCharLimit)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesMemoryConfigUserCharLimit')}</span>
              <input id="hm-memory-user-char-limit" class="hm-input" type="number" inputmode="numeric" min="100" max="200000" step="100" value="${esc(memoryValues.userCharLimit)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesMemoryConfigNudgeInterval')}</span>
              <input id="hm-memory-nudge-interval" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(memoryValues.nudgeInterval)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesMemoryConfigFlushMinTurns')}</span>
              <input id="hm-memory-flush-min-turns" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(memoryValues.flushMinTurns)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesMemoryConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderSkillsConfigPanel() {
    const disabled = loading || saving || skillsLoading || skillsSaving || quickCommandsSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-skills-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesSkillsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesSkillsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${skillsSaving ? t('engine.hermesConfigStatusSaving') : skillsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesSkillsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-skills-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesSkillsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(skillsError)}
          <div class="hm-config-runtime-grid hm-config-skills-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSkillsConfigCreationNudgeInterval')}</span>
              <input id="hm-skills-creation-nudge-interval" class="hm-input" type="number" inputmode="numeric" min="0" max="10000" step="1" value="${esc(skillsValues.creationNudgeInterval)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesSkillsConfigExternalDirs')}</span>
              <textarea id="hm-skills-external-dirs" class="hm-input" spellcheck="false" rows="3" ${disabled ? 'disabled' : ''}>${esc(skillsValues.externalDirs)}</textarea>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSkillsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderQuickCommandsConfigPanel() {
    const disabled = loading || saving || quickCommandsLoading || quickCommandsSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-quick-commands-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesQuickCommandsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesQuickCommandsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${quickCommandsSaving ? t('engine.hermesConfigStatusSaving') : quickCommandsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesQuickCommandsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-quick-commands-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesQuickCommandsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(quickCommandsError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesQuickCommandsConfigJson')}</span>
            <textarea id="hm-quick-commands-json" class="hm-input" spellcheck="false" rows="8" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:220px">${esc(quickCommandsValues.quickCommandsJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesQuickCommandsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderUnauthorizedDmConfigPanel() {
    const disabled = loading || saving || unauthorizedDmLoading || unauthorizedDmSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || securitySaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-unauthorized-dm-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesUnauthorizedDmConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesUnauthorizedDmConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${unauthorizedDmSaving ? t('engine.hermesConfigStatusSaving') : unauthorizedDmLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesUnauthorizedDmConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-unauthorized-dm-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesUnauthorizedDmConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(unauthorizedDmError)}
          <div class="hm-config-runtime-grid hm-config-unauthorized-dm-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesUnauthorizedDmConfigBehavior')}</span>
              <select id="hm-unauthorized-dm-behavior" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${UNAUTHORIZED_DM_BEHAVIORS.map(mode => option(`engine.hermesUnauthorizedDmConfigBehavior_${mode}`, mode, unauthorizedDmValues.unauthorizedDmBehavior)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesUnauthorizedDmConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderSecurityConfigPanel() {
    const disabled = loading || saving || securityLoading || securitySaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-security-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesSecurityConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesSecurityConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${securitySaving ? t('engine.hermesConfigStatusSaving') : securityLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesSecurityConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-security-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesSecurityConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(securityError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-security-tirith-enabled" type="checkbox" ${securityValues.tirithEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSecurityConfigTirithEnabled')}</span>
            </label>
            <label class="hm-channel-check hm-channel-check--danger">
              <input id="hm-security-tirith-fail-open" type="checkbox" ${securityValues.tirithFailOpen ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSecurityConfigTirithFailOpen')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-security-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSecurityConfigTirithPath')}</span>
              <input id="hm-security-tirith-path" class="hm-input" value="${esc(securityValues.tirithPath)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSecurityConfigTirithTimeout')}</span>
              <input id="hm-security-tirith-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="300" step="1" value="${esc(securityValues.tirithTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSecurityConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderHumanDelayConfigPanel() {
    const disabled = loading || saving || humanDelayLoading || humanDelaySaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || securitySaving || streamingSaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-human-delay-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesHumanDelayConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesHumanDelayConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${humanDelaySaving ? t('engine.hermesConfigStatusSaving') : humanDelayLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesHumanDelayConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-human-delay-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesHumanDelayConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(humanDelayError)}
          <div class="hm-config-runtime-grid hm-config-human-delay-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesHumanDelayConfigMode')}</span>
              <select id="hm-human-delay-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${HUMAN_DELAY_MODES.map(mode => option(`engine.hermesHumanDelayConfigMode_${mode}`, mode, humanDelayValues.humanDelayMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesHumanDelayConfigMinMs')}</span>
              <input id="hm-human-delay-min-ms" class="hm-input" type="number" inputmode="numeric" min="0" max="60000" step="100" value="${esc(humanDelayValues.humanDelayMinMs)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesHumanDelayConfigMaxMs')}</span>
              <input id="hm-human-delay-max-ms" class="hm-input" type="number" inputmode="numeric" min="0" max="60000" step="100" value="${esc(humanDelayValues.humanDelayMaxMs)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesHumanDelayConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderStreamingPanel() {
    const disabled = loading || saving || streamingLoading || streamingSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || securitySaving || executionLimitsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-streaming-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesStreamingConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesStreamingConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${streamingSaving ? t('engine.hermesConfigStatusSaving') : streamingLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesStreamingConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-streaming-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesStreamingConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(streamingError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-streaming-enabled" type="checkbox" ${streamingValues.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesStreamingConfigEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-streaming-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesStreamingConfigTransport')}</span>
              <select id="hm-streaming-transport" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${STREAMING_TRANSPORTS.map(mode => option(`engine.hermesStreamingConfigTransport_${mode}`, mode, streamingValues.transport)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesStreamingConfigEditInterval')}</span>
              <input id="hm-streaming-edit-interval" class="hm-input" type="number" inputmode="decimal" min="0.05" max="60" step="0.05" value="${esc(streamingValues.editInterval)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesStreamingConfigBufferThreshold')}</span>
              <input id="hm-streaming-buffer-threshold" class="hm-input" type="number" inputmode="numeric" min="1" max="5000" step="1" value="${esc(streamingValues.bufferThreshold)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesStreamingConfigFreshFinalAfterSeconds')}</span>
              <input id="hm-streaming-fresh-final-after-seconds" class="hm-input" type="number" inputmode="decimal" min="0" max="86400" step="1" value="${esc(streamingValues.freshFinalAfterSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesStreamingConfigCursor')}</span>
              <input id="hm-streaming-cursor" class="hm-input" value="${esc(streamingValues.cursor)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesStreamingConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderExecutionLimitsPanel() {
    const disabled = loading || saving || executionLimitsLoading || executionLimitsSaving || terminalSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-execution-limits-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesExecutionLimitsTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesExecutionLimitsDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${executionLimitsSaving ? t('engine.hermesConfigStatusSaving') : executionLimitsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesExecutionLimitsStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-execution-limits-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesExecutionLimitsSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(executionLimitsError)}
          <div class="hm-config-subtitle">${t('engine.hermesExecutionLimitsCodeTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-execution-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsCodeMode')}</span>
              <select id="hm-code-execution-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${CODE_EXECUTION_MODES.map(mode => option(`engine.hermesExecutionLimitsCodeMode_${mode}`, mode, executionLimitsValues.codeExecutionMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsCodeTimeout')}</span>
              <input id="hm-code-execution-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(executionLimitsValues.codeExecutionTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsCodeMaxToolCalls')}</span>
              <input id="hm-code-execution-max-tool-calls" class="hm-input" type="number" inputmode="numeric" min="1" max="10000" step="1" value="${esc(executionLimitsValues.codeExecutionMaxToolCalls)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesExecutionLimitsDelegationTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-delegation-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationMaxIterations')}</span>
              <input id="hm-delegation-max-iterations" class="hm-input" type="number" inputmode="numeric" min="1" max="1000" step="1" value="${esc(executionLimitsValues.delegationMaxIterations)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationChildTimeout')}</span>
              <input id="hm-delegation-child-timeout-seconds" class="hm-input" type="number" inputmode="numeric" min="30" max="86400" step="1" value="${esc(executionLimitsValues.delegationChildTimeoutSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationMaxConcurrent')}</span>
              <input id="hm-delegation-max-concurrent-children" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(executionLimitsValues.delegationMaxConcurrentChildren)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationMaxSpawnDepth')}</span>
              <input id="hm-delegation-max-spawn-depth" class="hm-input" type="number" inputmode="numeric" min="1" max="3" step="1" value="${esc(executionLimitsValues.delegationMaxSpawnDepth)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-delegation-orchestrator-enabled" type="checkbox" ${executionLimitsValues.delegationOrchestratorEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesExecutionLimitsDelegationOrchestratorEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-delegation-inherit-mcp-toolsets" type="checkbox" ${executionLimitsValues.delegationInheritMcpToolsets ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesExecutionLimitsDelegationInheritMcp')}</span>
            </label>
            <label class="hm-channel-check hm-channel-check--danger">
              <input id="hm-delegation-subagent-auto-approve" type="checkbox" ${executionLimitsValues.delegationSubagentAutoApprove ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesExecutionLimitsDelegationAutoApprove')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesExecutionLimitsFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderTerminalPanel() {
    const disabled = loading || saving || terminalLoading || terminalSaving || runtimeSaving || compressionSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-terminal-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesTerminalConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesTerminalConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${terminalSaving ? t('engine.hermesConfigStatusSaving') : terminalLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesTerminalConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-terminal-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesTerminalConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(terminalError)}
          <div class="hm-config-runtime-grid hm-config-terminal-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigBackend')}</span>
              <select id="hm-terminal-backend" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${TERMINAL_BACKENDS.map(mode => option(`engine.hermesTerminalConfigBackend_${mode}`, mode, terminalValues.terminalBackend)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigCwd')}</span>
              <input id="hm-terminal-cwd" class="hm-input" value="${esc(terminalValues.terminalCwd)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigTimeout')}</span>
              <input id="hm-terminal-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(terminalValues.terminalTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigLifetimeSeconds')}</span>
              <input id="hm-terminal-lifetime-seconds" class="hm-input" type="number" inputmode="numeric" min="0" max="86400" step="1" value="${esc(terminalValues.terminalLifetimeSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check hm-channel-check--danger">
              <input id="hm-terminal-docker-mount-cwd-to-workspace" type="checkbox" ${terminalValues.terminalDockerMountCwdToWorkspace ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesTerminalConfigDockerMountCwd')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-terminal-docker-run-as-host-user" type="checkbox" ${terminalValues.terminalDockerRunAsHostUser ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesTerminalConfigDockerRunAsHostUser')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-terminal-container-persistent" type="checkbox" ${terminalValues.terminalContainerPersistent ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesTerminalConfigContainerPersistent')}</span>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesTerminalConfigContainerTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-terminal-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigContainerCpu')}</span>
              <input id="hm-terminal-container-cpu" class="hm-input" type="number" inputmode="numeric" min="1" max="64" step="1" value="${esc(terminalValues.terminalContainerCpu)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigContainerMemory')}</span>
              <input id="hm-terminal-container-memory" class="hm-input" type="number" inputmode="numeric" min="128" max="1048576" step="128" value="${esc(terminalValues.terminalContainerMemory)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigContainerDisk')}</span>
              <input id="hm-terminal-container-disk" class="hm-input" type="number" inputmode="numeric" min="1024" max="10485760" step="1024" value="${esc(terminalValues.terminalContainerDisk)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesTerminalConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function draw() {
    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">${t('engine.hermesConfigEyebrow')}</div>
          <h1 class="hm-hero-h1">${t('engine.hermesConfigTitle')}</h1>
          <div class="hm-hero-sub">~/.hermes/config.yaml</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-config-reload" ${isBusy() ? 'disabled' : ''}>${t('engine.hermesConfigReload')}</button>
          <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-config-save" ${isBusy() ? 'disabled' : ''}>${t('engine.hermesConfigSave')}</button>
        </div>
      </div>

      ${renderRuntimePanel()}
      ${renderTerminalPanel()}
      ${renderStreamingPanel()}
      ${renderExecutionLimitsPanel()}
      ${renderCompressionPanel()}
      ${renderToolGuardrailsPanel()}
      ${renderMemoryPanel()}
      ${renderSkillsConfigPanel()}
      ${renderQuickCommandsConfigPanel()}
      ${renderUnauthorizedDmConfigPanel()}
      ${renderSecurityConfigPanel()}
      ${renderHumanDelayConfigPanel()}

      <div class="hm-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">config.yaml</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesConfigRawDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${saving ? t('engine.hermesConfigStatusSaving') : loading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesConfigStatusReady')}</span>
          </div>
        </div>
        <div class="hm-panel-body" style="padding:0">
          ${renderError(error)}
          <textarea id="hm-config-yaml" class="hm-input" spellcheck="false" ${isBusy() ? 'disabled' : ''} style="width:100%;min-height:560px;border:0;border-radius:0;background:var(--hm-surface-0);font-family:var(--hm-font-mono);font-size:12px;line-height:1.7;padding:18px 20px;resize:vertical">${esc(yaml)}</textarea>
        </div>
      </div>
    `
    el.querySelector('#hm-config-reload')?.addEventListener('click', load)
    el.querySelector('#hm-config-save')?.addEventListener('click', save)
    el.querySelector('#hm-runtime-save')?.addEventListener('click', saveRuntime)
    el.querySelector('#hm-compression-save')?.addEventListener('click', saveCompression)
    el.querySelector('#hm-tool-guardrails-save')?.addEventListener('click', saveToolGuardrails)
    el.querySelector('#hm-memory-save')?.addEventListener('click', saveMemory)
    el.querySelector('#hm-skills-config-save')?.addEventListener('click', saveSkillsConfig)
    el.querySelector('#hm-quick-commands-save')?.addEventListener('click', saveQuickCommandsConfig)
    el.querySelector('#hm-unauthorized-dm-save')?.addEventListener('click', saveUnauthorizedDmConfig)
    el.querySelector('#hm-security-save')?.addEventListener('click', saveSecurityConfig)
    el.querySelector('#hm-human-delay-save')?.addEventListener('click', saveHumanDelayConfig)
    el.querySelector('#hm-streaming-save')?.addEventListener('click', saveStreaming)
    el.querySelector('#hm-execution-limits-save')?.addEventListener('click', saveExecutionLimits)
    el.querySelector('#hm-terminal-save')?.addEventListener('click', saveTerminal)
  }

  async function loadRaw() {
    const data = await api.hermesConfigRawRead()
    yaml = data?.yaml || ''
  }

  async function loadRuntime() {
    const data = await api.hermesSessionRuntimeConfigRead()
    runtimeValues = { ...SESSION_RUNTIME_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadCompression() {
    const data = await api.hermesCompressionConfigRead()
    compressionValues = { ...COMPRESSION_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadToolGuardrails() {
    const data = await api.hermesToolLoopGuardrailsConfigRead()
    toolGuardrailsValues = { ...TOOL_GUARDRAILS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadMemory() {
    const data = await api.hermesMemoryConfigRead()
    memoryValues = { ...MEMORY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadSkillsConfig() {
    const data = await api.hermesSkillsConfigRead()
    skillsValues = { ...SKILLS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadQuickCommandsConfig() {
    const data = await api.hermesQuickCommandsConfigRead()
    quickCommandsValues = { ...QUICK_COMMANDS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadUnauthorizedDmConfig() {
    const data = await api.hermesUnauthorizedDmConfigRead()
    unauthorizedDmValues = { ...UNAUTHORIZED_DM_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadSecurityConfig() {
    const data = await api.hermesSecurityConfigRead()
    securityValues = { ...SECURITY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadHumanDelayConfig() {
    const data = await api.hermesHumanDelayConfigRead()
    humanDelayValues = { ...HUMAN_DELAY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadStreaming() {
    const data = await api.hermesStreamingConfigRead()
    streamingValues = { ...STREAMING_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadExecutionLimits() {
    const data = await api.hermesExecutionLimitsConfigRead()
    executionLimitsValues = { ...EXECUTION_LIMITS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadTerminal() {
    const data = await api.hermesTerminalConfigRead()
    terminalValues = { ...TERMINAL_DEFAULTS, ...(data?.values || {}) }
  }

  async function load() {
    loading = true
    runtimeLoading = true
    compressionLoading = true
    toolGuardrailsLoading = true
    memoryLoading = true
    skillsLoading = true
    quickCommandsLoading = true
    unauthorizedDmLoading = true
    securityLoading = true
    humanDelayLoading = true
    streamingLoading = true
    executionLimitsLoading = true
    terminalLoading = true
    error = null
    runtimeError = null
    compressionError = null
    toolGuardrailsError = null
    memoryError = null
    skillsError = null
    quickCommandsError = null
    unauthorizedDmError = null
    securityError = null
    humanDelayError = null
    streamingError = null
    executionLimitsError = null
    terminalError = null
    draw()
    try {
      await loadRaw()
    } catch (err) {
      error = humanizeError(err, t('engine.hermesConfigLoadFailed') || 'Load config failed')
    } finally {
      loading = false
    }
    try {
      await loadRuntime()
    } catch (err) {
      runtimeError = humanizeError(err, t('engine.hermesSessionRuntimeLoadFailed') || 'Load runtime config failed')
    } finally {
      runtimeLoading = false
      draw()
    }
    try {
      await loadCompression()
    } catch (err) {
      compressionError = humanizeError(err, t('engine.hermesCompressionLoadFailed') || 'Load compression config failed')
    } finally {
      compressionLoading = false
      draw()
    }
    try {
      await loadToolGuardrails()
    } catch (err) {
      toolGuardrailsError = humanizeError(err, t('engine.hermesToolGuardrailsLoadFailed') || 'Load tool guardrail config failed')
    } finally {
      toolGuardrailsLoading = false
      draw()
    }
    try {
      await loadStreaming()
    } catch (err) {
      streamingError = humanizeError(err, t('engine.hermesStreamingConfigLoadFailed') || 'Load streaming config failed')
    } finally {
      streamingLoading = false
      draw()
    }
    try {
      await loadExecutionLimits()
    } catch (err) {
      executionLimitsError = humanizeError(err, t('engine.hermesExecutionLimitsLoadFailed') || 'Load execution limit config failed')
    } finally {
      executionLimitsLoading = false
      draw()
    }
    try {
      await loadTerminal()
    } catch (err) {
      terminalError = humanizeError(err, t('engine.hermesTerminalConfigLoadFailed') || 'Load terminal config failed')
    } finally {
      terminalLoading = false
      draw()
    }
    try {
      await loadMemory()
    } catch (err) {
      memoryError = humanizeError(err, t('engine.hermesMemoryConfigLoadFailed') || 'Load memory config failed')
    } finally {
      memoryLoading = false
      draw()
    }
    try {
      await loadSkillsConfig()
    } catch (err) {
      skillsError = humanizeError(err, t('engine.hermesSkillsConfigLoadFailed') || 'Load skills config failed')
    } finally {
      skillsLoading = false
      draw()
    }
    try {
      await loadQuickCommandsConfig()
    } catch (err) {
      quickCommandsError = humanizeError(err, t('engine.hermesQuickCommandsConfigLoadFailed') || 'Load quick commands config failed')
    } finally {
      quickCommandsLoading = false
      draw()
    }
    try {
      await loadUnauthorizedDmConfig()
    } catch (err) {
      unauthorizedDmError = humanizeError(err, t('engine.hermesUnauthorizedDmConfigLoadFailed') || 'Load unauthorized DM config failed')
    } finally {
      unauthorizedDmLoading = false
      draw()
    }
    try {
      await loadSecurityConfig()
    } catch (err) {
      securityError = humanizeError(err, t('engine.hermesSecurityConfigLoadFailed') || 'Load security config failed')
    } finally {
      securityLoading = false
      draw()
    }
    try {
      await loadHumanDelayConfig()
    } catch (err) {
      humanDelayError = humanizeError(err, t('engine.hermesHumanDelayConfigLoadFailed') || 'Load human delay config failed')
    } finally {
      humanDelayLoading = false
      draw()
    }
  }

  async function refreshRawAfterStructuredSave() {
    try {
      await loadRaw()
    } catch {}
  }

  async function save() {
    const textarea = el.querySelector('#hm-config-yaml')
    yaml = textarea?.value || ''
    saving = true
    error = null
    draw()
    try {
      const result = await api.hermesConfigRawWrite(yaml)
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
      try {
        await loadRuntime()
      } catch {}
      try {
        await loadCompression()
      } catch {}
      try {
        await loadToolGuardrails()
      } catch {}
      try {
        await loadMemory()
      } catch {}
      try {
        await loadSkillsConfig()
      } catch {}
      try {
        await loadQuickCommandsConfig()
      } catch {}
      try {
        await loadUnauthorizedDmConfig()
      } catch {}
      try {
        await loadSecurityConfig()
      } catch {}
      try {
        await loadHumanDelayConfig()
      } catch {}
      try {
        await loadStreaming()
      } catch {}
      try {
        await loadExecutionLimits()
      } catch {}
      try {
        await loadTerminal()
      } catch {}
    } catch (err) {
      error = humanizeError(err, t('engine.hermesConfigSaveFailed') || 'Save failed')
      toast(error, 'error')
    } finally {
      saving = false
      draw()
    }
  }

  async function saveRuntime() {
    const form = {
      sessionResetMode: el.querySelector('#hm-session-reset-mode')?.value || 'both',
      idleMinutes: el.querySelector('#hm-session-idle-minutes')?.value || '1440',
      atHour: el.querySelector('#hm-session-at-hour')?.value || '4',
      groupSessionsPerUser: !!el.querySelector('#hm-group-sessions-per-user')?.checked,
      threadSessionsPerUser: !!el.querySelector('#hm-thread-sessions-per-user')?.checked,
    }
    runtimeSaving = true
    runtimeError = null
    draw()
    try {
      const result = await api.hermesSessionRuntimeConfigSave(form)
      runtimeValues = { ...SESSION_RUNTIME_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesSessionRuntimeSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      runtimeError = humanizeError(err, t('engine.hermesSessionRuntimeSaveFailed') || 'Save runtime config failed')
      toast(runtimeError, 'error')
    } finally {
      runtimeSaving = false
      draw()
    }
  }

  async function saveCompression() {
    const form = {
      enabled: !!el.querySelector('#hm-compression-enabled')?.checked,
      threshold: el.querySelector('#hm-compression-threshold')?.value || '0.5',
      targetRatio: el.querySelector('#hm-compression-target-ratio')?.value || '0.2',
      protectLastN: el.querySelector('#hm-compression-protect-last-n')?.value || '20',
      protectFirstN: el.querySelector('#hm-compression-protect-first-n')?.value || '3',
      abortOnSummaryFailure: !!el.querySelector('#hm-compression-abort-on-summary-failure')?.checked,
    }
    compressionSaving = true
    compressionError = null
    draw()
    try {
      const result = await api.hermesCompressionConfigSave(form)
      compressionValues = { ...COMPRESSION_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesCompressionSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      compressionError = humanizeError(err, t('engine.hermesCompressionSaveFailed') || 'Save compression config failed')
      toast(compressionError, 'error')
    } finally {
      compressionSaving = false
      draw()
    }
  }

  async function saveToolGuardrails() {
    const form = {
      warningsEnabled: !!el.querySelector('#hm-tool-guardrails-warnings-enabled')?.checked,
      hardStopEnabled: !!el.querySelector('#hm-tool-guardrails-hard-stop-enabled')?.checked,
      warnExactFailure: el.querySelector('#hm-tool-guardrails-warn-exact-failure')?.value || '2',
      warnSameToolFailure: el.querySelector('#hm-tool-guardrails-warn-same-tool-failure')?.value || '3',
      warnNoProgress: el.querySelector('#hm-tool-guardrails-warn-no-progress')?.value || '2',
      hardStopExactFailure: el.querySelector('#hm-tool-guardrails-hard-stop-exact-failure')?.value || '5',
      hardStopSameToolFailure: el.querySelector('#hm-tool-guardrails-hard-stop-same-tool-failure')?.value || '8',
      hardStopNoProgress: el.querySelector('#hm-tool-guardrails-hard-stop-no-progress')?.value || '5',
    }
    toolGuardrailsSaving = true
    toolGuardrailsError = null
    draw()
    try {
      const result = await api.hermesToolLoopGuardrailsConfigSave(form)
      toolGuardrailsValues = { ...TOOL_GUARDRAILS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesToolGuardrailsSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      toolGuardrailsError = humanizeError(err, t('engine.hermesToolGuardrailsSaveFailed') || 'Save tool guardrail config failed')
      toast(toolGuardrailsError, 'error')
    } finally {
      toolGuardrailsSaving = false
      draw()
    }
  }

  async function saveMemory() {
    const form = {
      memoryEnabled: !!el.querySelector('#hm-memory-enabled')?.checked,
      userProfileEnabled: !!el.querySelector('#hm-memory-user-profile-enabled')?.checked,
      memoryCharLimit: el.querySelector('#hm-memory-char-limit')?.value || '2200',
      userCharLimit: el.querySelector('#hm-memory-user-char-limit')?.value || '1375',
      nudgeInterval: el.querySelector('#hm-memory-nudge-interval')?.value || '10',
      flushMinTurns: el.querySelector('#hm-memory-flush-min-turns')?.value || '6',
    }
    memorySaving = true
    memoryError = null
    draw()
    try {
      const result = await api.hermesMemoryConfigSave(form)
      memoryValues = { ...MEMORY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesMemoryConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      memoryError = humanizeError(err, t('engine.hermesMemoryConfigSaveFailed') || 'Save memory config failed')
      toast(memoryError, 'error')
    } finally {
      memorySaving = false
      draw()
    }
  }

  async function saveSkillsConfig() {
    const form = {
      creationNudgeInterval: el.querySelector('#hm-skills-creation-nudge-interval')?.value || '15',
      externalDirs: el.querySelector('#hm-skills-external-dirs')?.value || '',
    }
    skillsSaving = true
    skillsError = null
    draw()
    try {
      const result = await api.hermesSkillsConfigSave(form)
      skillsValues = { ...SKILLS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesSkillsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      skillsError = humanizeError(err, t('engine.hermesSkillsConfigSaveFailed') || 'Save skills config failed')
      toast(skillsError, 'error')
    } finally {
      skillsSaving = false
      draw()
    }
  }

  async function saveQuickCommandsConfig() {
    const form = {
      quickCommandsJson: el.querySelector('#hm-quick-commands-json')?.value || '{}',
    }
    quickCommandsSaving = true
    quickCommandsError = null
    draw()
    try {
      const result = await api.hermesQuickCommandsConfigSave(form)
      quickCommandsValues = { ...QUICK_COMMANDS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesQuickCommandsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      quickCommandsError = humanizeError(err, t('engine.hermesQuickCommandsConfigSaveFailed') || 'Save quick commands config failed')
      toast(quickCommandsError, 'error')
    } finally {
      quickCommandsSaving = false
      draw()
    }
  }

  async function saveUnauthorizedDmConfig() {
    const form = {
      unauthorizedDmBehavior: el.querySelector('#hm-unauthorized-dm-behavior')?.value || 'pair',
    }
    unauthorizedDmSaving = true
    unauthorizedDmError = null
    draw()
    try {
      const result = await api.hermesUnauthorizedDmConfigSave(form)
      unauthorizedDmValues = { ...UNAUTHORIZED_DM_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesUnauthorizedDmConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      unauthorizedDmError = humanizeError(err, t('engine.hermesUnauthorizedDmConfigSaveFailed') || 'Save unauthorized DM config failed')
      toast(unauthorizedDmError, 'error')
    } finally {
      unauthorizedDmSaving = false
      draw()
    }
  }

  async function saveSecurityConfig() {
    const form = {
      tirithEnabled: !!el.querySelector('#hm-security-tirith-enabled')?.checked,
      tirithPath: el.querySelector('#hm-security-tirith-path')?.value || 'tirith',
      tirithTimeout: el.querySelector('#hm-security-tirith-timeout')?.value || '5',
      tirithFailOpen: !!el.querySelector('#hm-security-tirith-fail-open')?.checked,
    }
    securitySaving = true
    securityError = null
    draw()
    try {
      const result = await api.hermesSecurityConfigSave(form)
      securityValues = { ...SECURITY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesSecurityConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      securityError = humanizeError(err, t('engine.hermesSecurityConfigSaveFailed') || 'Save security config failed')
      toast(securityError, 'error')
    } finally {
      securitySaving = false
      draw()
    }
  }

  async function saveHumanDelayConfig() {
    const form = {
      humanDelayMode: el.querySelector('#hm-human-delay-mode')?.value || 'off',
      humanDelayMinMs: el.querySelector('#hm-human-delay-min-ms')?.value || '800',
      humanDelayMaxMs: el.querySelector('#hm-human-delay-max-ms')?.value || '2500',
    }
    humanDelaySaving = true
    humanDelayError = null
    draw()
    try {
      const result = await api.hermesHumanDelayConfigSave(form)
      humanDelayValues = { ...HUMAN_DELAY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesHumanDelayConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      humanDelayError = humanizeError(err, t('engine.hermesHumanDelayConfigSaveFailed') || 'Save human delay config failed')
      toast(humanDelayError, 'error')
    } finally {
      humanDelaySaving = false
      draw()
    }
  }

  async function saveStreaming() {
    const form = {
      enabled: !!el.querySelector('#hm-streaming-enabled')?.checked,
      transport: el.querySelector('#hm-streaming-transport')?.value || 'edit',
      editInterval: el.querySelector('#hm-streaming-edit-interval')?.value || '0.8',
      bufferThreshold: el.querySelector('#hm-streaming-buffer-threshold')?.value || '24',
      cursor: el.querySelector('#hm-streaming-cursor')?.value ?? ' ▉',
      freshFinalAfterSeconds: el.querySelector('#hm-streaming-fresh-final-after-seconds')?.value || '60',
    }
    streamingSaving = true
    streamingError = null
    draw()
    try {
      const result = await api.hermesStreamingConfigSave(form)
      streamingValues = { ...STREAMING_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesStreamingConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      streamingError = humanizeError(err, t('engine.hermesStreamingConfigSaveFailed') || 'Save streaming config failed')
      toast(streamingError, 'error')
    } finally {
      streamingSaving = false
      draw()
    }
  }

  async function saveExecutionLimits() {
    const form = {
      codeExecutionMode: el.querySelector('#hm-code-execution-mode')?.value || 'project',
      codeExecutionTimeout: el.querySelector('#hm-code-execution-timeout')?.value || '300',
      codeExecutionMaxToolCalls: el.querySelector('#hm-code-execution-max-tool-calls')?.value || '50',
      delegationMaxIterations: el.querySelector('#hm-delegation-max-iterations')?.value || '50',
      delegationChildTimeoutSeconds: el.querySelector('#hm-delegation-child-timeout-seconds')?.value || '600',
      delegationMaxConcurrentChildren: el.querySelector('#hm-delegation-max-concurrent-children')?.value || '3',
      delegationMaxSpawnDepth: el.querySelector('#hm-delegation-max-spawn-depth')?.value || '1',
      delegationOrchestratorEnabled: !!el.querySelector('#hm-delegation-orchestrator-enabled')?.checked,
      delegationSubagentAutoApprove: !!el.querySelector('#hm-delegation-subagent-auto-approve')?.checked,
      delegationInheritMcpToolsets: !!el.querySelector('#hm-delegation-inherit-mcp-toolsets')?.checked,
    }
    executionLimitsSaving = true
    executionLimitsError = null
    draw()
    try {
      const result = await api.hermesExecutionLimitsConfigSave(form)
      executionLimitsValues = { ...EXECUTION_LIMITS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesExecutionLimitsSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      executionLimitsError = humanizeError(err, t('engine.hermesExecutionLimitsSaveFailed') || 'Save execution limit config failed')
      toast(executionLimitsError, 'error')
    } finally {
      executionLimitsSaving = false
      draw()
    }
  }

  async function saveTerminal() {
    const form = {
      terminalBackend: el.querySelector('#hm-terminal-backend')?.value || 'local',
      terminalCwd: el.querySelector('#hm-terminal-cwd')?.value || '.',
      terminalTimeout: el.querySelector('#hm-terminal-timeout')?.value || '180',
      terminalLifetimeSeconds: el.querySelector('#hm-terminal-lifetime-seconds')?.value || '300',
      terminalDockerMountCwdToWorkspace: !!el.querySelector('#hm-terminal-docker-mount-cwd-to-workspace')?.checked,
      terminalDockerRunAsHostUser: !!el.querySelector('#hm-terminal-docker-run-as-host-user')?.checked,
      terminalContainerCpu: el.querySelector('#hm-terminal-container-cpu')?.value || '1',
      terminalContainerMemory: el.querySelector('#hm-terminal-container-memory')?.value || '5120',
      terminalContainerDisk: el.querySelector('#hm-terminal-container-disk')?.value || '51200',
      terminalContainerPersistent: !!el.querySelector('#hm-terminal-container-persistent')?.checked,
    }
    terminalSaving = true
    terminalError = null
    draw()
    try {
      const result = await api.hermesTerminalConfigSave(form)
      terminalValues = { ...TERMINAL_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesTerminalConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      terminalError = humanizeError(err, t('engine.hermesTerminalConfigSaveFailed') || 'Save terminal config failed')
      toast(terminalError, 'error')
    } finally {
      terminalSaving = false
      draw()
    }
  }

  draw()
  load()
  return el
}
