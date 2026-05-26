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
  worktreeEnabled: false,
}

const SESSIONS_MAINTENANCE_DEFAULTS = {
  sessionsAutoPrune: false,
  sessionsRetentionDays: 90,
  sessionsVacuumAfterPrune: true,
  sessionsMinIntervalHours: 24,
  sessionsWriteJsonSnapshots: false,
}

const UPDATES_DEFAULTS = {
  updatesPreUpdateBackup: false,
  updatesBackupKeep: 5,
}

const COMPRESSION_DEFAULTS = {
  enabled: true,
  threshold: 0.5,
  targetRatio: 0.2,
  protectLastN: 20,
  protectFirstN: 3,
  abortOnSummaryFailure: false,
}

const PROMPT_CACHING_DEFAULTS = {
  promptCacheTtl: '5m',
}

const OPENROUTER_CACHE_DEFAULTS = {
  openrouterResponseCache: true,
  openrouterResponseCacheTtl: 300,
}

const PROVIDER_ROUTING_DEFAULTS = {
  providerRoutingSort: 'price',
  providerRoutingOnly: '',
  providerRoutingIgnore: '',
  providerRoutingOrder: '',
  providerRoutingRequireParameters: false,
  providerRoutingDataCollection: 'allow',
}

const AUXILIARY_DEFAULTS = {
  auxiliaryVisionProvider: 'auto',
  auxiliaryVisionModel: '',
  auxiliaryVisionTimeout: 30,
  auxiliaryVisionDownloadTimeout: 30,
  auxiliaryWebExtractProvider: 'auto',
  auxiliaryWebExtractModel: '',
  auxiliarySessionSearchProvider: 'auto',
  auxiliarySessionSearchModel: '',
  auxiliarySessionSearchTimeout: 30,
  auxiliarySessionSearchMaxConcurrency: 3,
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
  templateVars: true,
  inlineShell: false,
  inlineShellTimeout: 10,
  guardAgentCreated: false,
}

const CURATOR_DEFAULTS = {
  curatorEnabled: true,
  curatorIntervalHours: 168,
  curatorMinIdleHours: 2,
  curatorStaleAfterDays: 30,
  curatorArchiveAfterDays: 90,
  curatorBackupEnabled: true,
  curatorBackupKeep: 5,
}

const QUICK_COMMANDS_DEFAULTS = {
  quickCommandsJson: '{}',
}

const MODEL_DEFAULTS = {
  modelDefault: '',
  modelProvider: 'auto',
  modelBaseUrl: '',
  modelContextLength: '',
  modelMaxTokens: '',
}

const MODEL_CATALOG_DEFAULTS = {
  modelCatalogEnabled: true,
  modelCatalogUrl: 'https://hermes-agent.nousresearch.com/docs/api/model-catalog.json',
  modelCatalogTtlHours: 24,
  modelCatalogProvidersJson: '{}',
}

const X_SEARCH_DEFAULTS = {
  xSearchModel: 'grok-4.20-reasoning',
  xSearchTimeoutSeconds: 180,
  xSearchRetries: 2,
}

const CONTEXT_DEFAULTS = {
  contextEngine: 'compressor',
}

const MODEL_ALIASES_DEFAULTS = {
  modelAliasesJson: '{}',
}

const HOOKS_DEFAULTS = {
  hooksAutoAccept: false,
  hooksJson: '{}',
}

const PROVIDER_OVERRIDES_DEFAULTS = {
  providerOverridesJson: '{}',
}

const MCP_SERVERS_DEFAULTS = {
  mcpServersJson: '{}',
}

const AGENT_TOOLSETS_DEFAULTS = {
  disabledToolsets: '',
}

const PLATFORM_TOOLSETS_DEFAULTS = {
  platformToolsetsJson: '{}',
}

const AGENT_RUNTIME_DEFAULTS = {
  agentMaxTurns: 90,
  gatewayTimeout: 1800,
  restartDrainTimeout: 180,
  apiMaxRetries: 3,
  gatewayTimeoutWarning: 900,
  clarifyTimeout: 600,
  gatewayNotifyInterval: 180,
  gatewayAutoContinueFreshness: 3600,
  imageInputMode: 'auto',
  agentVerbose: false,
  reasoningEffort: 'medium',
  personalitiesJson: '{}',
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

const DISPLAY_DEFAULTS = {
  displayToolProgress: 'all',
  displayCompact: false,
  displaySkin: 'default',
  displayToolPrefix: '┊',
  displayShowReasoning: false,
  displayToolPreviewLength: 0,
  displayCleanupProgress: false,
  displayToolProgressCommand: false,
  displayInterimAssistantMessages: true,
  displayRuntimeFooterEnabled: false,
  displayRuntimeFooterFields: 'model\ncontext_pct\ncwd',
  displayFileMutationVerifier: true,
  displayShowCost: false,
  dashboardShowTokenAnalytics: false,
  displayLanguage: 'en',
  displayResumeDisplay: 'full',
  displayBusyInputMode: 'interrupt',
  displayBackgroundProcessNotifications: 'all',
  displayFinalResponseMarkdown: 'strip',
  displayTimestamps: false,
  displayBellOnComplete: false,
  displayPersistentOutput: true,
  displayPersistentOutputMaxLines: 200,
  displayInlineDiffs: true,
  displayTuiAutoResumeRecent: false,
  displayTuiStatusIndicator: 'kaomoji',
  displayUserMessagePreviewFirstLines: 2,
  displayUserMessagePreviewLastLines: 2,
  displayEphemeralSystemTtl: 0,
  displayCopyShortcut: 'auto',
}

const HUMAN_DELAY_DEFAULTS = {
  humanDelayMode: 'off',
  humanDelayMinMs: 800,
  humanDelayMaxMs: 2500,
}

const KANBAN_DEFAULTS = {
  dispatchInGateway: true,
  dispatchIntervalSeconds: 60,
  maxSpawn: 0,
  maxInProgress: 0,
  failureLimit: 2,
  autoDecompose: true,
  autoDecomposePerTick: 3,
  workerLogRotateBytes: 2097152,
  workerLogBackupCount: 1,
  orchestratorProfile: '',
  defaultAssignee: '',
  dispatchStaleTimeoutSeconds: 14400,
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
  delegationModel: '',
  delegationProvider: '',
}

const IO_SAFETY_DEFAULTS = {
  fileReadMaxChars: 100000,
  toolOutputMaxBytes: 50000,
  toolOutputMaxLines: 2000,
  toolOutputMaxLineLength: 2000,
}

const CHECKPOINTS_DEFAULTS = {
  checkpointsEnabled: false,
  checkpointMaxSnapshots: 20,
  checkpointMaxTotalSizeMb: 500,
  checkpointMaxFileSizeMb: 10,
  checkpointAutoPrune: true,
  checkpointRetentionDays: 7,
  checkpointDeleteOrphans: true,
  checkpointMinIntervalHours: 24,
}

const CRON_DEFAULTS = {
  cronWrapResponse: true,
  cronMaxParallelJobs: 0,
}

const LOGGING_DEFAULTS = {
  loggingLevel: 'INFO',
  loggingMaxSizeMb: 5,
  loggingBackupCount: 3,
  loggingMemoryMonitorEnabled: true,
  loggingMemoryMonitorIntervalSeconds: 300,
}

const APPROVALS_DEFAULTS = {
  approvalMode: 'manual',
  approvalTimeout: 60,
  approvalCronMode: 'deny',
  approvalMcpReloadConfirm: true,
  approvalDestructiveSlashConfirm: true,
}

const PRIVACY_DEFAULTS = {
  redactPii: false,
}

const BROWSER_DEFAULTS = {
  browserInactivityTimeout: 120,
  browserCommandTimeout: 30,
  browserRecordSessions: false,
  browserEngine: 'auto',
  browserAllowPrivateUrls: false,
  browserAutoLocalForPrivateUrls: true,
  browserCdpUrl: '',
  browserCamofoxManagedPersistence: false,
  browserCamofoxUserId: '',
  browserCamofoxSessionKey: '',
  browserCamofoxAdoptExistingTab: false,
  browserDialogPolicy: 'must_respond',
  browserDialogTimeout: 300,
}

const WEB_DEFAULTS = {
  webBackend: '',
  webSearchBackend: '',
  webExtractBackend: '',
}

const LSP_DEFAULTS = {
  lspEnabled: true,
  lspWaitMode: 'document',
  lspWaitTimeout: 5,
  lspInstallStrategy: 'auto',
}

const STT_DEFAULTS = {
  sttEnabled: true,
  sttProvider: 'auto',
  sttLocalModel: 'base',
  sttLocalLanguage: '',
  sttOpenaiModel: 'whisper-1',
  sttMistralModel: 'voxtral-mini-latest',
}

const TTS_VOICE_DEFAULTS = {
  ttsProvider: 'edge',
  ttsEdgeVoice: 'en-US-AriaNeural',
  ttsOpenaiModel: 'gpt-4o-mini-tts',
  ttsOpenaiVoice: 'alloy',
  ttsElevenlabsVoiceId: 'pNInz6obpgDQGcFmaJgB',
  ttsElevenlabsModelId: 'eleven_multilingual_v2',
  ttsXaiVoiceId: 'eve',
  ttsXaiLanguage: 'en',
  ttsXaiSampleRate: 24000,
  ttsXaiBitRate: 128000,
  ttsMistralModel: 'voxtral-mini-tts-2603',
  ttsMistralVoiceId: 'c69964a6-ab8b-4f8a-9465-ec0925096ec8',
  ttsPiperVoice: 'en_US-lessac-medium',
  voiceRecordKey: 'ctrl+b',
  voiceMaxRecordingSeconds: 120,
  voiceAutoTts: false,
  voiceBeepEnabled: true,
  voiceSilenceThreshold: 200,
  voiceSilenceDuration: 3,
}

const TERMINAL_DEFAULTS = {
  terminalBackend: 'local',
  terminalCwd: '.',
  terminalTimeout: 180,
  terminalLifetimeSeconds: 300,
  terminalShellInitFiles: '',
  terminalAutoSourceBashrc: true,
  terminalPersistentShell: true,
  terminalEnvPassthrough: '',
  terminalDockerMountCwdToWorkspace: false,
  terminalDockerRunAsHostUser: false,
  terminalDockerImage: '',
  terminalDockerEnvJson: '{}',
  terminalDockerVolumes: '',
  terminalDockerExtraArgs: '',
  terminalSingularityImage: '',
  terminalModalImage: '',
  terminalModalMode: 'auto',
  terminalVercelRuntime: 'node24',
  terminalDaytonaImage: '',
  terminalDockerForwardEnv: '',
  terminalSshHost: '',
  terminalSshUser: '',
  terminalSshPort: 22,
  terminalSshKey: '',
  terminalContainerCpu: 1,
  terminalContainerMemory: 5120,
  terminalContainerDisk: 51200,
  terminalContainerPersistent: true,
}

const SESSION_RESET_MODES = ['both', 'idle', 'daily', 'none']
const STREAMING_TRANSPORTS = ['edit', 'auto', 'draft', 'off']
const CODE_EXECUTION_MODES = ['project', 'strict']
const TERMINAL_BACKENDS = ['local', 'ssh', 'docker', 'singularity', 'modal', 'daytona', 'vercel_sandbox']
const TERMINAL_MODAL_MODES = ['auto', 'managed', 'direct']
const TERMINAL_VERCEL_RUNTIMES = ['node24', 'node22', 'python3.13']
const BROWSER_ENGINES = ['auto', 'lightpanda', 'chrome']
const BROWSER_DIALOG_POLICIES = ['must_respond', 'auto_dismiss', 'auto_accept']
const WEB_BACKENDS = ['', 'tavily', 'firecrawl', 'parallel', 'exa', 'searxng', 'brave', 'brave_free', 'ddgs', 'xai', 'native']
const LSP_WAIT_MODES = ['document', 'full']
const LSP_INSTALL_STRATEGIES = ['auto', 'manual', 'off']
const STT_PROVIDERS = ['auto', 'local', 'groq', 'openai', 'mistral']
const STT_LOCAL_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo']
const STT_OPENAI_MODELS = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe']
const STT_MISTRAL_MODELS = ['voxtral-mini-latest', 'voxtral-mini-2602']
const TTS_PROVIDERS = ['edge', 'elevenlabs', 'openai', 'xai', 'minimax', 'mistral', 'gemini', 'neutts', 'kittentts', 'piper']
const TTS_OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
const UNAUTHORIZED_DM_BEHAVIORS = ['pair', 'ignore']
const IMAGE_INPUT_MODES = ['auto', 'native', 'text']
const REASONING_EFFORTS = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none']
const DISPLAY_TOOL_PROGRESS_VALUES = ['off', 'new', 'all', 'verbose']
const DISPLAY_SKINS = ['default', 'ares', 'mono', 'slate', 'daylight', 'warm-lightmode', 'poseidon', 'sisyphus', 'charizard']
const DISPLAY_LANGUAGE_VALUES = ['en', 'zh', 'zh-hant', 'ja', 'de', 'es', 'fr', 'tr', 'uk', 'af', 'ko', 'it', 'ga', 'pt', 'ru', 'hu']
const DISPLAY_RESUME_VALUES = ['full', 'minimal']
const DISPLAY_BUSY_INPUT_MODES = ['interrupt', 'queue', 'steer']
const DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS = ['off', 'result', 'error', 'all']
const DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES = ['render', 'strip', 'raw']
const DISPLAY_TUI_STATUS_INDICATORS = ['kaomoji', 'emoji', 'unicode', 'ascii']
const DISPLAY_COPY_SHORTCUTS = ['auto', 'ctrl_c', 'ctrl_shift_c', 'disabled']
const HUMAN_DELAY_MODES = ['off', 'natural', 'custom']
const APPROVAL_MODES = ['manual', 'smart', 'off']
const APPROVAL_CRON_MODES = ['deny', 'approve']
const LOGGING_LEVELS = ['DEBUG', 'INFO', 'WARNING']
const PROMPT_CACHE_TTLS = ['5m', '1h']
const PROVIDER_ROUTING_SORTS = ['price', 'throughput', 'latency']
const PROVIDER_ROUTING_DATA_COLLECTION = ['allow', 'deny']
const AUXILIARY_PROVIDERS = ['auto', 'openrouter', 'nous', 'gemini', 'ollama-cloud', 'codex', 'main']

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'
    let yaml = ''
    let runtimeValues = { ...SESSION_RUNTIME_DEFAULTS }
    let sessionsMaintenanceValues = { ...SESSIONS_MAINTENANCE_DEFAULTS }
    let updatesValues = { ...UPDATES_DEFAULTS }
    let compressionValues = { ...COMPRESSION_DEFAULTS }
  let promptCachingValues = { ...PROMPT_CACHING_DEFAULTS }
  let openrouterCacheValues = { ...OPENROUTER_CACHE_DEFAULTS }
  let providerRoutingValues = { ...PROVIDER_ROUTING_DEFAULTS }
  let auxiliaryValues = { ...AUXILIARY_DEFAULTS }
  let toolGuardrailsValues = { ...TOOL_GUARDRAILS_DEFAULTS }
  let memoryValues = { ...MEMORY_DEFAULTS }
  let skillsValues = { ...SKILLS_DEFAULTS }
  let curatorValues = { ...CURATOR_DEFAULTS }
  let quickCommandsValues = { ...QUICK_COMMANDS_DEFAULTS }
  let modelValues = { ...MODEL_DEFAULTS }
  let modelCatalogValues = { ...MODEL_CATALOG_DEFAULTS }
  let xSearchValues = { ...X_SEARCH_DEFAULTS }
  let contextValues = { ...CONTEXT_DEFAULTS }
  let modelAliasesValues = { ...MODEL_ALIASES_DEFAULTS }
  let hooksValues = { ...HOOKS_DEFAULTS }
  let providerOverridesValues = { ...PROVIDER_OVERRIDES_DEFAULTS }
  let mcpServersValues = { ...MCP_SERVERS_DEFAULTS }
  let agentToolsetsValues = { ...AGENT_TOOLSETS_DEFAULTS }
  let platformToolsetsValues = { ...PLATFORM_TOOLSETS_DEFAULTS }
  let agentRuntimeValues = { ...AGENT_RUNTIME_DEFAULTS }
  let unauthorizedDmValues = { ...UNAUTHORIZED_DM_DEFAULTS }
  let securityValues = { ...SECURITY_DEFAULTS }
  let displayValues = { ...DISPLAY_DEFAULTS }
  let humanDelayValues = { ...HUMAN_DELAY_DEFAULTS }
  let kanbanValues = { ...KANBAN_DEFAULTS }
  let streamingValues = { ...STREAMING_DEFAULTS }
  let executionLimitsValues = { ...EXECUTION_LIMITS_DEFAULTS }
  let ioSafetyValues = { ...IO_SAFETY_DEFAULTS }
  let checkpointsValues = { ...CHECKPOINTS_DEFAULTS }
  let cronValues = { ...CRON_DEFAULTS }
  let loggingValues = { ...LOGGING_DEFAULTS }
  let approvalsValues = { ...APPROVALS_DEFAULTS }
  let privacyValues = { ...PRIVACY_DEFAULTS }
  let browserValues = { ...BROWSER_DEFAULTS }
  let webValues = { ...WEB_DEFAULTS }
  let lspValues = { ...LSP_DEFAULTS }
  let sttValues = { ...STT_DEFAULTS }
  let ttsVoiceValues = { ...TTS_VOICE_DEFAULTS }
  let terminalValues = { ...TERMINAL_DEFAULTS }
    let loading = true
    let runtimeLoading = true
    let sessionsMaintenanceLoading = true
    let updatesLoading = true
    let compressionLoading = true
  let promptCachingLoading = true
  let openrouterCacheLoading = true
  let providerRoutingLoading = true
  let auxiliaryLoading = true
  let toolGuardrailsLoading = true
  let memoryLoading = true
  let skillsLoading = true
  let curatorLoading = true
  let quickCommandsLoading = true
  let modelLoading = true
  let modelCatalogLoading = true
  let xSearchLoading = true
  let contextLoading = true
  let modelAliasesLoading = true
  let hooksLoading = true
  let providerOverridesLoading = true
  let mcpServersLoading = true
  let agentToolsetsLoading = true
  let platformToolsetsLoading = true
  let agentRuntimeLoading = true
  let unauthorizedDmLoading = true
  let securityLoading = true
  let displayLoading = true
  let humanDelayLoading = true
  let kanbanLoading = true
  let streamingLoading = true
  let executionLimitsLoading = true
  let ioSafetyLoading = true
  let checkpointsLoading = true
  let cronLoading = true
  let loggingLoading = true
  let approvalsLoading = true
  let privacyLoading = true
  let browserLoading = true
  let webLoading = true
  let lspLoading = true
  let sttLoading = true
  let ttsVoiceLoading = true
  let terminalLoading = true
    let saving = false
    let runtimeSaving = false
    let sessionsMaintenanceSaving = false
    let updatesSaving = false
    let compressionSaving = false
  let promptCachingSaving = false
  let openrouterCacheSaving = false
  let providerRoutingSaving = false
  let auxiliarySaving = false
  let toolGuardrailsSaving = false
  let memorySaving = false
  let skillsSaving = false
  let curatorSaving = false
  let quickCommandsSaving = false
  let modelSaving = false
  let modelCatalogSaving = false
  let xSearchSaving = false
  let contextSaving = false
  let modelAliasesSaving = false
  let hooksSaving = false
  let providerOverridesSaving = false
  let mcpServersSaving = false
  let agentToolsetsSaving = false
  let platformToolsetsSaving = false
  let agentRuntimeSaving = false
  let unauthorizedDmSaving = false
  let securitySaving = false
  let displaySaving = false
  let humanDelaySaving = false
  let kanbanSaving = false
  let streamingSaving = false
  let executionLimitsSaving = false
  let ioSafetySaving = false
  let checkpointsSaving = false
  let cronSaving = false
  let loggingSaving = false
  let approvalsSaving = false
  let privacySaving = false
  let browserSaving = false
  let webSaving = false
  let lspSaving = false
  let sttSaving = false
  let ttsVoiceSaving = false
  let terminalSaving = false
    let error = null
    let runtimeError = null
    let sessionsMaintenanceError = null
    let updatesError = null
    let compressionError = null
  let promptCachingError = null
  let openrouterCacheError = null
  let providerRoutingError = null
  let auxiliaryError = null
  let toolGuardrailsError = null
  let memoryError = null
  let skillsError = null
  let curatorError = null
  let quickCommandsError = null
  let modelError = null
  let modelCatalogError = null
  let xSearchError = null
  let contextError = null
  let modelAliasesError = null
  let hooksError = null
  let providerOverridesError = null
  let mcpServersError = null
  let agentToolsetsError = null
  let platformToolsetsError = null
  let agentRuntimeError = null
  let unauthorizedDmError = null
  let securityError = null
  let displayError = null
  let humanDelayError = null
  let kanbanError = null
  let streamingError = null
  let executionLimitsError = null
  let ioSafetyError = null
  let checkpointsError = null
  let cronError = null
  let loggingError = null
  let approvalsError = null
  let privacyError = null
  let browserError = null
  let webError = null
  let lspError = null
  let sttError = null
  let ttsVoiceError = null
  let terminalError = null

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function isBusy() {
    return loading || runtimeLoading || sessionsMaintenanceLoading || updatesLoading || compressionLoading || promptCachingLoading || openrouterCacheLoading || providerRoutingLoading || auxiliaryLoading || toolGuardrailsLoading || memoryLoading || skillsLoading || curatorLoading || quickCommandsLoading || modelLoading || modelCatalogLoading || xSearchLoading || contextLoading || modelAliasesLoading || hooksLoading || providerOverridesLoading || mcpServersLoading || agentToolsetsLoading || platformToolsetsLoading || agentRuntimeLoading || unauthorizedDmLoading || securityLoading || displayLoading || humanDelayLoading || kanbanLoading || streamingLoading || executionLimitsLoading || ioSafetyLoading || checkpointsLoading || cronLoading || loggingLoading || approvalsLoading || privacyLoading || browserLoading || webLoading || lspLoading || sttLoading || ttsVoiceLoading || terminalLoading || saving || runtimeSaving || sessionsMaintenanceSaving || updatesSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || curatorSaving || quickCommandsSaving || modelSaving || modelCatalogSaving || xSearchSaving || contextSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || platformToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || securitySaving || displaySaving || humanDelaySaving || kanbanSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || privacySaving || browserSaving || webSaving || lspSaving || sttSaving || ttsVoiceSaving || terminalSaving
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
    const disabled = loading || saving || runtimeLoading || runtimeSaving || sessionsMaintenanceSaving || updatesSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
            <label class="hm-channel-check">
              <input id="hm-worktree-enabled" type="checkbox" ${runtimeValues.worktreeEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesWorktreeEnabled')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSessionRuntimeFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderSessionsMaintenancePanel() {
    const disabled = loading || saving || sessionsMaintenanceLoading || sessionsMaintenanceSaving || runtimeSaving || updatesSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesSessionsMaintenanceTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesSessionsMaintenanceDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${sessionsMaintenanceSaving ? t('engine.hermesConfigStatusSaving') : sessionsMaintenanceLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesSessionsMaintenanceStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-sessions-maintenance-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesSessionsMaintenanceSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(sessionsMaintenanceError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-sessions-auto-prune" type="checkbox" ${sessionsMaintenanceValues.sessionsAutoPrune ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSessionsMaintenanceAutoPrune')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-sessions-vacuum-after-prune" type="checkbox" ${sessionsMaintenanceValues.sessionsVacuumAfterPrune ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSessionsMaintenanceVacuumAfterPrune')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-sessions-write-json-snapshots" type="checkbox" ${sessionsMaintenanceValues.sessionsWriteJsonSnapshots ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSessionsMaintenanceWriteJsonSnapshots')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSessionsMaintenanceRetentionDays')}</span>
              <input id="hm-sessions-retention-days" class="hm-input" type="number" inputmode="numeric" min="1" max="36500" step="1" value="${esc(sessionsMaintenanceValues.sessionsRetentionDays)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSessionsMaintenanceMinIntervalHours')}</span>
              <input id="hm-sessions-min-interval-hours" class="hm-input" type="number" inputmode="numeric" min="0" max="87600" step="1" value="${esc(sessionsMaintenanceValues.sessionsMinIntervalHours)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSessionsMaintenanceFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderUpdatesPanel() {
    const disabled = loading || saving || updatesLoading || updatesSaving || runtimeSaving || sessionsMaintenanceSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesUpdatesConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesUpdatesConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${updatesSaving ? t('engine.hermesConfigStatusSaving') : updatesLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesUpdatesConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-updates-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesUpdatesConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(updatesError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-updates-pre-update-backup" type="checkbox" ${updatesValues.updatesPreUpdateBackup ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesUpdatesConfigPreUpdateBackup')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesUpdatesConfigBackupKeep')}</span>
              <input id="hm-updates-backup-keep" class="hm-input" type="number" inputmode="numeric" min="1" max="1000" step="1" value="${esc(updatesValues.updatesBackupKeep)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesUpdatesConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderCompressionPanel() {
    const disabled = loading || saving || compressionLoading || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || runtimeSaving || updatesSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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

  function renderPromptCachingPanel() {
    const disabled = loading || saving || promptCachingLoading || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || runtimeSaving || compressionSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-prompt-caching-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesPromptCachingConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesPromptCachingConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${promptCachingSaving ? t('engine.hermesConfigStatusSaving') : promptCachingLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesPromptCachingConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-prompt-caching-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesPromptCachingConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(promptCachingError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesPromptCachingConfigCacheTtl')}</span>
              <select id="hm-prompt-cache-ttl" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${PROMPT_CACHE_TTLS.map(ttl => option(`engine.hermesPromptCachingConfigCacheTtl_${ttl}`, ttl, promptCachingValues.promptCacheTtl)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesPromptCachingConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderOpenrouterCachePanel() {
    const disabled = loading || saving || openrouterCacheLoading || openrouterCacheSaving || providerRoutingSaving || runtimeSaving || compressionSaving || promptCachingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-openrouter-cache-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesOpenrouterCacheConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesOpenrouterCacheConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${openrouterCacheSaving ? t('engine.hermesConfigStatusSaving') : openrouterCacheLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesOpenrouterCacheConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-openrouter-cache-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesOpenrouterCacheConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(openrouterCacheError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-openrouter-response-cache" type="checkbox" ${openrouterCacheValues.openrouterResponseCache ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesOpenrouterCacheConfigResponseCache')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesOpenrouterCacheConfigResponseCacheTtl')}</span>
              <input id="hm-openrouter-response-cache-ttl" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(openrouterCacheValues.openrouterResponseCacheTtl)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesOpenrouterCacheConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderProviderRoutingPanel() {
    const disabled = loading || saving || providerRoutingLoading || providerRoutingSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-provider-routing-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesProviderRoutingConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesProviderRoutingConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${providerRoutingSaving ? t('engine.hermesConfigStatusSaving') : providerRoutingLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesProviderRoutingConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-provider-routing-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesProviderRoutingConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(providerRoutingError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesProviderRoutingConfigSort')}</span>
              <select id="hm-provider-routing-sort" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${PROVIDER_ROUTING_SORTS.map(sort => option(`engine.hermesProviderRoutingConfigSort_${sort}`, sort, providerRoutingValues.providerRoutingSort)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesProviderRoutingConfigDataCollection')}</span>
              <select id="hm-provider-routing-data-collection" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${PROVIDER_ROUTING_DATA_COLLECTION.map(value => option(`engine.hermesProviderRoutingConfigDataCollection_${value}`, value, providerRoutingValues.providerRoutingDataCollection)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-provider-routing-require-parameters" type="checkbox" ${providerRoutingValues.providerRoutingRequireParameters ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesProviderRoutingConfigRequireParameters')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-provider-routing-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesProviderRoutingConfigOnly')}</span>
              <textarea id="hm-provider-routing-only" class="hm-input" spellcheck="false" rows="4" placeholder="anthropic&#10;google" ${disabled ? 'disabled' : ''}>${esc(providerRoutingValues.providerRoutingOnly)}</textarea>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesProviderRoutingConfigIgnore')}</span>
              <textarea id="hm-provider-routing-ignore" class="hm-input" spellcheck="false" rows="4" placeholder="deepinfra&#10;fireworks" ${disabled ? 'disabled' : ''}>${esc(providerRoutingValues.providerRoutingIgnore)}</textarea>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesProviderRoutingConfigOrder')}</span>
              <textarea id="hm-provider-routing-order" class="hm-input" spellcheck="false" rows="4" placeholder="google&#10;anthropic" ${disabled ? 'disabled' : ''}>${esc(providerRoutingValues.providerRoutingOrder)}</textarea>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesProviderRoutingConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function auxiliaryProviderOptions(selected) {
    return AUXILIARY_PROVIDERS
      .map(provider => option(`engine.hermesAuxiliaryConfigProvider_${provider}`, provider, selected))
      .join('')
  }

  function renderAuxiliaryConfigPanel() {
    const disabled = loading || saving || auxiliaryLoading || auxiliarySaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-auxiliary-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesAuxiliaryConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesAuxiliaryConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${auxiliarySaving ? t('engine.hermesConfigStatusSaving') : auxiliaryLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesAuxiliaryConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-auxiliary-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesAuxiliaryConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(auxiliaryError)}
          <div class="hm-config-subtitle">${t('engine.hermesAuxiliaryConfigVisionTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-auxiliary-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigVisionProvider')}</span>
              <select id="hm-auxiliary-vision-provider" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${auxiliaryProviderOptions(auxiliaryValues.auxiliaryVisionProvider)}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigVisionModel')}</span>
              <input id="hm-auxiliary-vision-model" class="hm-input" type="text" value="${esc(auxiliaryValues.auxiliaryVisionModel)}" placeholder="google/gemini-2.5-flash" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigVisionTimeout')}</span>
              <input id="hm-auxiliary-vision-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="3600" step="1" value="${esc(auxiliaryValues.auxiliaryVisionTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigVisionDownloadTimeout')}</span>
              <input id="hm-auxiliary-vision-download-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="3600" step="1" value="${esc(auxiliaryValues.auxiliaryVisionDownloadTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesAuxiliaryConfigWebExtractTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-auxiliary-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigWebExtractProvider')}</span>
              <select id="hm-auxiliary-web-extract-provider" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${auxiliaryProviderOptions(auxiliaryValues.auxiliaryWebExtractProvider)}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigWebExtractModel')}</span>
              <input id="hm-auxiliary-web-extract-model" class="hm-input" type="text" value="${esc(auxiliaryValues.auxiliaryWebExtractModel)}" placeholder="local-summary" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesAuxiliaryConfigSessionSearchTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-auxiliary-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigSessionSearchProvider')}</span>
              <select id="hm-auxiliary-session-search-provider" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${auxiliaryProviderOptions(auxiliaryValues.auxiliarySessionSearchProvider)}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigSessionSearchModel')}</span>
              <input id="hm-auxiliary-session-search-model" class="hm-input" type="text" value="${esc(auxiliaryValues.auxiliarySessionSearchModel)}" placeholder="gemini-3-flash" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigSessionSearchTimeout')}</span>
              <input id="hm-auxiliary-session-search-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="3600" step="1" value="${esc(auxiliaryValues.auxiliarySessionSearchTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAuxiliaryConfigSessionSearchMaxConcurrency')}</span>
              <input id="hm-auxiliary-session-search-max-concurrency" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(auxiliaryValues.auxiliarySessionSearchMaxConcurrency)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesAuxiliaryConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderToolGuardrailsPanel() {
    const disabled = loading || saving || toolGuardrailsLoading || toolGuardrailsSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
    const disabled = loading || saving || memoryLoading || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
    const disabled = loading || saving || skillsLoading || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSkillsConfigInlineShellTimeout')}</span>
              <input id="hm-skills-inline-shell-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(skillsValues.inlineShellTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesSkillsConfigExternalDirs')}</span>
              <textarea id="hm-skills-external-dirs" class="hm-input" spellcheck="false" rows="3" ${disabled ? 'disabled' : ''}>${esc(skillsValues.externalDirs)}</textarea>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-skills-template-vars" type="checkbox" ${skillsValues.templateVars ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSkillsConfigTemplateVars')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-skills-inline-shell" type="checkbox" ${skillsValues.inlineShell ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSkillsConfigInlineShell')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-skills-guard-agent-created" type="checkbox" ${skillsValues.guardAgentCreated ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSkillsConfigGuardAgentCreated')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSkillsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderCuratorConfigPanel() {
    const disabled = loading || saving || curatorLoading || curatorSaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-curator-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesCuratorConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesCuratorConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${curatorSaving ? t('engine.hermesConfigStatusSaving') : curatorLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesCuratorConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-curator-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesCuratorConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(curatorError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-curator-enabled" type="checkbox" ${curatorValues.curatorEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCuratorConfigEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-curator-backup-enabled" type="checkbox" ${curatorValues.curatorBackupEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCuratorConfigBackupEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-curator-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCuratorConfigIntervalHours')}</span>
              <input id="hm-curator-interval-hours" class="hm-input" type="number" inputmode="numeric" min="1" max="87600" step="1" value="${esc(curatorValues.curatorIntervalHours)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCuratorConfigMinIdleHours')}</span>
              <input id="hm-curator-min-idle-hours" class="hm-input" type="number" inputmode="numeric" min="0" max="87600" step="1" value="${esc(curatorValues.curatorMinIdleHours)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCuratorConfigStaleAfterDays')}</span>
              <input id="hm-curator-stale-after-days" class="hm-input" type="number" inputmode="numeric" min="1" max="36500" step="1" value="${esc(curatorValues.curatorStaleAfterDays)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCuratorConfigArchiveAfterDays')}</span>
              <input id="hm-curator-archive-after-days" class="hm-input" type="number" inputmode="numeric" min="1" max="36500" step="1" value="${esc(curatorValues.curatorArchiveAfterDays)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCuratorConfigBackupKeep')}</span>
              <input id="hm-curator-backup-keep" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(curatorValues.curatorBackupKeep)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesCuratorConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderQuickCommandsConfigPanel() {
    const disabled = loading || saving || quickCommandsLoading || quickCommandsSaving || modelSaving || xSearchSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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

  function renderModelConfigPanel() {
    const disabled = loading || saving || modelLoading || modelSaving || modelCatalogSaving || xSearchSaving || quickCommandsSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-model-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesModelConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesModelConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${modelSaving ? t('engine.hermesConfigStatusSaving') : modelLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesModelConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-model-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesModelConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(modelError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesModelConfigDefault')}</span>
              <input id="hm-model-default" class="hm-input" value="${esc(modelValues.modelDefault)}" placeholder="anthropic/claude-opus-4.6" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesModelConfigProvider')}</span>
              <input id="hm-model-provider" class="hm-input" value="${esc(modelValues.modelProvider)}" placeholder="auto" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesModelConfigBaseUrl')}</span>
              <input id="hm-model-base-url" class="hm-input" value="${esc(modelValues.modelBaseUrl)}" placeholder="https://openrouter.ai/api/v1" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesModelConfigContextLength')}</span>
              <input id="hm-model-context-length" class="hm-input" type="number" inputmode="numeric" min="1" max="10000000" step="1" value="${esc(modelValues.modelContextLength)}" placeholder="131072" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesModelConfigMaxTokens')}</span>
              <input id="hm-model-max-tokens" class="hm-input" type="number" inputmode="numeric" min="1" max="10000000" step="1" value="${esc(modelValues.modelMaxTokens)}" placeholder="8192" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesModelConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderModelCatalogConfigPanel() {
    const disabled = loading || saving || modelCatalogLoading || modelCatalogSaving || modelSaving || xSearchSaving || quickCommandsSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-model-catalog-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesModelCatalogConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesModelCatalogConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${modelCatalogSaving ? t('engine.hermesConfigStatusSaving') : modelCatalogLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesModelCatalogConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-model-catalog-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesModelCatalogConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(modelCatalogError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-model-catalog-enabled" type="checkbox" ${modelCatalogValues.modelCatalogEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesModelCatalogConfigEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid">
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesModelCatalogConfigUrl')}</span>
              <input id="hm-model-catalog-url" class="hm-input" type="url" value="${esc(modelCatalogValues.modelCatalogUrl)}" placeholder="https://hermes-agent.nousresearch.com/docs/api/model-catalog.json" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesModelCatalogConfigTtlHours')}</span>
              <input id="hm-model-catalog-ttl-hours" class="hm-input" type="number" inputmode="numeric" min="1" max="8760" step="1" value="${esc(modelCatalogValues.modelCatalogTtlHours)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesModelCatalogConfigProvidersJson')}</span>
              <textarea id="hm-model-catalog-providers-json" class="hm-input" spellcheck="false" rows="8" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:220px">${esc(modelCatalogValues.modelCatalogProvidersJson)}</textarea>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesModelCatalogConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderXSearchConfigPanel() {
    const disabled = loading || saving || xSearchLoading || xSearchSaving || modelSaving || modelCatalogSaving || quickCommandsSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-x-search-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesXSearchConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesXSearchConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${xSearchSaving ? t('engine.hermesConfigStatusSaving') : xSearchLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesXSearchConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-x-search-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesXSearchConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(xSearchError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesXSearchConfigModel')}</span>
              <input id="hm-x-search-model" class="hm-input" value="${esc(xSearchValues.xSearchModel)}" placeholder="grok-4.20-reasoning" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesXSearchConfigTimeoutSeconds')}</span>
              <input id="hm-x-search-timeout-seconds" class="hm-input" type="number" inputmode="numeric" min="30" max="3600" step="1" value="${esc(xSearchValues.xSearchTimeoutSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesXSearchConfigRetries')}</span>
              <input id="hm-x-search-retries" class="hm-input" type="number" inputmode="numeric" min="0" max="20" step="1" value="${esc(xSearchValues.xSearchRetries)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesXSearchConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderContextConfigPanel() {
    const disabled = loading || saving || contextLoading || contextSaving || modelSaving || modelCatalogSaving || xSearchSaving || quickCommandsSaving || modelAliasesSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-context-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesContextConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesContextConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${contextSaving ? t('engine.hermesConfigStatusSaving') : contextLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesContextConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-context-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesContextConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(contextError)}
          <div class="hm-config-runtime-grid">
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesContextConfigEngine')}</span>
              <input id="hm-context-engine" class="hm-input" value="${esc(contextValues.contextEngine)}" placeholder="compressor" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesContextConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderModelAliasesConfigPanel() {
    const disabled = loading || saving || modelAliasesLoading || modelAliasesSaving || quickCommandsSaving || modelSaving || modelCatalogSaving || xSearchSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-model-aliases-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesModelAliasesConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesModelAliasesConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${modelAliasesSaving ? t('engine.hermesConfigStatusSaving') : modelAliasesLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesModelAliasesConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-model-aliases-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesModelAliasesConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(modelAliasesError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesModelAliasesConfigJson')}</span>
            <textarea id="hm-model-aliases-json" class="hm-input" spellcheck="false" rows="8" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:220px">${esc(modelAliasesValues.modelAliasesJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesModelAliasesConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderHooksConfigPanel() {
    const disabled = loading || saving || hooksLoading || hooksSaving || quickCommandsSaving || modelAliasesSaving || providerOverridesSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-hooks-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesHooksConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesHooksConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${hooksSaving ? t('engine.hermesConfigStatusSaving') : hooksLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesHooksConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-hooks-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesHooksConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(hooksError)}
          <label class="hm-channel-check">
            <input id="hm-hooks-auto-accept" type="checkbox" ${hooksValues.hooksAutoAccept ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span>${t('engine.hermesHooksConfigAutoAccept')}</span>
          </label>
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesHooksConfigJson')}</span>
            <textarea id="hm-hooks-json" class="hm-input" spellcheck="false" rows="9" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:260px">${esc(hooksValues.hooksJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesHooksConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderProviderOverridesConfigPanel() {
    const disabled = loading || saving || providerOverridesLoading || providerOverridesSaving || quickCommandsSaving || hooksSaving || mcpServersSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-provider-overrides-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesProviderOverridesConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesProviderOverridesConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${providerOverridesSaving ? t('engine.hermesConfigStatusSaving') : providerOverridesLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesProviderOverridesConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-provider-overrides-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesProviderOverridesConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(providerOverridesError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesProviderOverridesConfigJson')}</span>
            <textarea id="hm-provider-overrides-json" class="hm-input" spellcheck="false" rows="9" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:260px">${esc(providerOverridesValues.providerOverridesJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesProviderOverridesConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderMcpServersConfigPanel() {
    const disabled = loading || saving || mcpServersLoading || mcpServersSaving || quickCommandsSaving || hooksSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-mcp-servers-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesMcpServersConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesMcpServersConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${mcpServersSaving ? t('engine.hermesConfigStatusSaving') : mcpServersLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesMcpServersConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-mcp-servers-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesMcpServersConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(mcpServersError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesMcpServersConfigJson')}</span>
            <textarea id="hm-mcp-servers-json" class="hm-input" spellcheck="false" rows="9" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:260px">${esc(mcpServersValues.mcpServersJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesMcpServersConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderAgentToolsetsConfigPanel() {
    const disabled = loading || saving || agentToolsetsLoading || agentToolsetsSaving || platformToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || hooksSaving || providerOverridesSaving || mcpServersSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-agent-toolsets-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesAgentToolsetsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesAgentToolsetsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${agentToolsetsSaving ? t('engine.hermesConfigStatusSaving') : agentToolsetsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesAgentToolsetsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-agent-toolsets-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesAgentToolsetsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(agentToolsetsError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesAgentToolsetsConfigDisabledToolsets')}</span>
            <textarea id="hm-agent-disabled-toolsets" class="hm-input" spellcheck="false" rows="4" ${disabled ? 'disabled' : ''}>${esc(agentToolsetsValues.disabledToolsets)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesAgentToolsetsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderPlatformToolsetsConfigPanel() {
    const disabled = loading || saving || platformToolsetsLoading || platformToolsetsSaving || agentToolsetsSaving || agentRuntimeSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || mcpServersSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-platform-toolsets-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesPlatformToolsetsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesPlatformToolsetsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${platformToolsetsSaving ? t('engine.hermesConfigStatusSaving') : platformToolsetsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesPlatformToolsetsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-platform-toolsets-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesPlatformToolsetsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(platformToolsetsError)}
          <label class="hm-field hm-field--wide">
            <span class="hm-field-label">${t('engine.hermesPlatformToolsetsConfigJson')}</span>
            <textarea id="hm-platform-toolsets-json" class="hm-input" spellcheck="false" rows="9" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:260px">${esc(platformToolsetsValues.platformToolsetsJson)}</textarea>
          </label>
          <div class="hm-channel-footnote">${t('engine.hermesPlatformToolsetsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderAgentRuntimeConfigPanel() {
    const disabled = loading || saving || agentRuntimeLoading || agentRuntimeSaving || agentToolsetsSaving || platformToolsetsSaving || unauthorizedDmSaving || securitySaving || displaySaving || humanDelaySaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || privacySaving || browserSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-agent-runtime-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesAgentRuntimeConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesAgentRuntimeConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${agentRuntimeSaving ? t('engine.hermesConfigStatusSaving') : agentRuntimeLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesAgentRuntimeConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-agent-runtime-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesAgentRuntimeConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(agentRuntimeError)}
          <div class="hm-config-runtime-grid hm-config-agent-runtime-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigMaxTurns')}</span>
              <input id="hm-agent-max-turns" class="hm-input" type="number" inputmode="numeric" min="1" max="10000" step="1" value="${esc(agentRuntimeValues.agentMaxTurns)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigGatewayTimeout')}</span>
              <input id="hm-agent-gateway-timeout" class="hm-input" type="number" inputmode="numeric" min="0" max="604800" step="1" value="${esc(agentRuntimeValues.gatewayTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigRestartDrainTimeout')}</span>
              <input id="hm-agent-restart-drain-timeout" class="hm-input" type="number" inputmode="numeric" min="0" max="86400" step="1" value="${esc(agentRuntimeValues.restartDrainTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigApiMaxRetries')}</span>
              <input id="hm-agent-api-max-retries" class="hm-input" type="number" inputmode="numeric" min="1" max="20" step="1" value="${esc(agentRuntimeValues.apiMaxRetries)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigGatewayTimeoutWarning')}</span>
              <input id="hm-agent-gateway-timeout-warning" class="hm-input" type="number" inputmode="numeric" min="0" max="604800" step="1" value="${esc(agentRuntimeValues.gatewayTimeoutWarning)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigClarifyTimeout')}</span>
              <input id="hm-agent-clarify-timeout" class="hm-input" type="number" inputmode="numeric" min="0" max="86400" step="1" value="${esc(agentRuntimeValues.clarifyTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigGatewayNotifyInterval')}</span>
              <input id="hm-agent-gateway-notify-interval" class="hm-input" type="number" inputmode="numeric" min="0" max="86400" step="1" value="${esc(agentRuntimeValues.gatewayNotifyInterval)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigGatewayAutoContinueFreshness')}</span>
              <input id="hm-agent-gateway-auto-continue-freshness" class="hm-input" type="number" inputmode="numeric" min="0" max="604800" step="1" value="${esc(agentRuntimeValues.gatewayAutoContinueFreshness)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigImageInputMode')}</span>
              <select id="hm-agent-image-input-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${IMAGE_INPUT_MODES.map(mode => option(`engine.hermesAgentRuntimeConfigImageInputMode_${mode}`, mode, agentRuntimeValues.imageInputMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigReasoningEffort')}</span>
              <select id="hm-agent-reasoning-effort" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${REASONING_EFFORTS.map(effort => option(`engine.hermesAgentRuntimeConfigReasoningEffort_${effort}`, effort, agentRuntimeValues.reasoningEffort)).join('')}
              </select>
            </label>
            <label class="hm-channel-check">
              <input id="hm-agent-verbose" type="checkbox" ${agentRuntimeValues.agentVerbose ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesAgentRuntimeConfigVerbose')}</span>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesAgentRuntimeConfigPersonalities')}</span>
              <textarea id="hm-agent-personalities-json" class="hm-input" spellcheck="false" rows="7" ${disabled ? 'disabled' : ''} style="font-family:var(--hm-font-mono);line-height:1.65;min-height:190px">${esc(agentRuntimeValues.personalitiesJson)}</textarea>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesAgentRuntimeConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderUnauthorizedDmConfigPanel() {
    const disabled = loading || saving || unauthorizedDmLoading || unauthorizedDmSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || securitySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
    const disabled = loading || saving || securityLoading || securitySaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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

  function renderDisplayConfigPanel() {
    const disabled = loading || saving || displayLoading || displaySaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || securitySaving || humanDelaySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-display-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesDisplayConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesDisplayConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${displaySaving ? t('engine.hermesConfigStatusSaving') : displayLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesDisplayConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-display-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesDisplayConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(displayError)}
          <div class="hm-config-runtime-grid hm-config-display-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigToolProgress')}</span>
              <select id="hm-display-tool-progress" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_TOOL_PROGRESS_VALUES.map(mode => option(`engine.hermesDisplayConfigToolProgress_${mode}`, mode, displayValues.displayToolProgress)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigSkin')}</span>
              <select id="hm-display-skin" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_SKINS.map(mode => option(`engine.hermesDisplayConfigSkin_${mode}`, mode, displayValues.displaySkin)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigToolPrefix')}</span>
              <input id="hm-display-tool-prefix" class="hm-input" maxlength="8" value="${esc(displayValues.displayToolPrefix)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigLanguage')}</span>
              <select id="hm-display-language" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_LANGUAGE_VALUES.map(mode => option(`engine.hermesDisplayConfigLanguage_${mode}`, mode, displayValues.displayLanguage)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigResumeDisplay')}</span>
              <select id="hm-display-resume-display" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_RESUME_VALUES.map(mode => option(`engine.hermesDisplayConfigResumeDisplay_${mode}`, mode, displayValues.displayResumeDisplay)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigBusyInputMode')}</span>
              <select id="hm-display-busy-input-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_BUSY_INPUT_MODES.map(mode => option(`engine.hermesDisplayConfigBusyInputMode_${mode}`, mode, displayValues.displayBusyInputMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigBackgroundProcessNotifications')}</span>
              <select id="hm-display-background-process-notifications" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS.map(mode => option(`engine.hermesDisplayConfigBackgroundProcessNotifications_${mode}`, mode, displayValues.displayBackgroundProcessNotifications)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigFinalResponseMarkdown')}</span>
              <select id="hm-display-final-response-markdown" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES.map(mode => option(`engine.hermesDisplayConfigFinalResponseMarkdown_${mode}`, mode, displayValues.displayFinalResponseMarkdown)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigPersistentOutputMaxLines')}</span>
              <input id="hm-display-persistent-output-max-lines" class="hm-input" type="number" inputmode="numeric" min="0" max="100000" step="1" value="${esc(displayValues.displayPersistentOutputMaxLines)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigTuiStatusIndicator')}</span>
              <select id="hm-display-tui-status-indicator" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_TUI_STATUS_INDICATORS.map(mode => option(`engine.hermesDisplayConfigTuiStatusIndicator_${mode}`, mode, displayValues.displayTuiStatusIndicator)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigUserMessagePreviewFirstLines')}</span>
              <input id="hm-display-user-message-preview-first-lines" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(displayValues.displayUserMessagePreviewFirstLines)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigUserMessagePreviewLastLines')}</span>
              <input id="hm-display-user-message-preview-last-lines" class="hm-input" type="number" inputmode="numeric" min="0" max="100" step="1" value="${esc(displayValues.displayUserMessagePreviewLastLines)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigEphemeralSystemTtl')}</span>
              <input id="hm-display-ephemeral-system-ttl" class="hm-input" type="number" inputmode="numeric" min="0" max="86400" step="1" value="${esc(displayValues.displayEphemeralSystemTtl)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigCopyShortcut')}</span>
              <select id="hm-display-copy-shortcut" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${DISPLAY_COPY_SHORTCUTS.map(mode => option(`engine.hermesDisplayConfigCopyShortcut_${mode}`, mode, displayValues.displayCopyShortcut)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigToolPreviewLength')}</span>
              <input id="hm-display-tool-preview-length" class="hm-input" type="number" inputmode="numeric" min="0" max="200000" step="1" value="${esc(displayValues.displayToolPreviewLength)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesDisplayConfigRuntimeFooterFields')}</span>
              <textarea id="hm-display-runtime-footer-fields" class="hm-input" ${disabled ? 'disabled' : ''} style="min-height:96px;resize:vertical">${esc(displayValues.displayRuntimeFooterFields)}</textarea>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-display-compact" type="checkbox" ${displayValues.displayCompact ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigCompact')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-show-reasoning" type="checkbox" ${displayValues.displayShowReasoning ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigShowReasoning')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-cleanup-progress" type="checkbox" ${displayValues.displayCleanupProgress ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigCleanupProgress')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-tool-progress-command" type="checkbox" ${displayValues.displayToolProgressCommand ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigToolProgressCommand')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-interim-assistant-messages" type="checkbox" ${displayValues.displayInterimAssistantMessages ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigInterimAssistantMessages')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-runtime-footer-enabled" type="checkbox" ${displayValues.displayRuntimeFooterEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigRuntimeFooterEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-file-mutation-verifier" type="checkbox" ${displayValues.displayFileMutationVerifier ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigFileMutationVerifier')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-show-cost" type="checkbox" ${displayValues.displayShowCost ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigShowCost')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-dashboard-show-token-analytics" type="checkbox" ${displayValues.dashboardShowTokenAnalytics ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigShowTokenAnalytics')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-timestamps" type="checkbox" ${displayValues.displayTimestamps ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigTimestamps')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-bell-on-complete" type="checkbox" ${displayValues.displayBellOnComplete ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigBellOnComplete')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-persistent-output" type="checkbox" ${displayValues.displayPersistentOutput ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigPersistentOutput')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-inline-diffs" type="checkbox" ${displayValues.displayInlineDiffs ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigInlineDiffs')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-display-tui-auto-resume-recent" type="checkbox" ${displayValues.displayTuiAutoResumeRecent ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesDisplayConfigTuiAutoResumeRecent')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesDisplayConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderHumanDelayConfigPanel() {
    const disabled = loading || saving || humanDelayLoading || humanDelaySaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || securitySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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

  function renderKanbanConfigPanel() {
    const disabled = loading || saving || kanbanLoading || kanbanSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || securitySaving || displaySaving || humanDelaySaving || streamingSaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-kanban-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesKanbanConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesKanbanConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${kanbanSaving ? t('engine.hermesConfigStatusSaving') : kanbanLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesKanbanConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-kanban-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesKanbanConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(kanbanError)}
          <div class="hm-config-runtime-grid hm-config-kanban-grid">
            <label class="hm-field hm-field--checkbox">
              <input id="hm-kanban-dispatch-in-gateway" type="checkbox" ${kanbanValues.dispatchInGateway ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>
                <span class="hm-field-label">${t('engine.hermesKanbanConfigDispatchInGateway')}</span>
              </span>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigDispatchIntervalSeconds')}</span>
              <input id="hm-kanban-dispatch-interval-seconds" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(kanbanValues.dispatchIntervalSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigMaxSpawn')}</span>
              <input id="hm-kanban-max-spawn" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(kanbanValues.maxSpawn)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigMaxInProgress')}</span>
              <input id="hm-kanban-max-in-progress" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(kanbanValues.maxInProgress)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigFailureLimit')}</span>
              <input id="hm-kanban-failure-limit" class="hm-input" type="number" inputmode="numeric" min="1" max="100" step="1" value="${esc(kanbanValues.failureLimit)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--checkbox">
              <input id="hm-kanban-auto-decompose" type="checkbox" ${kanbanValues.autoDecompose ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>
                <span class="hm-field-label">${t('engine.hermesKanbanConfigAutoDecompose')}</span>
              </span>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigAutoDecomposePerTick')}</span>
              <input id="hm-kanban-auto-decompose-per-tick" class="hm-input" type="number" inputmode="numeric" min="1" max="1000" step="1" value="${esc(kanbanValues.autoDecomposePerTick)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigWorkerLogRotateBytes')}</span>
              <input id="hm-kanban-worker-log-rotate-bytes" class="hm-input" type="number" inputmode="numeric" min="1" max="1073741824" step="1024" value="${esc(kanbanValues.workerLogRotateBytes)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigWorkerLogBackupCount')}</span>
              <input id="hm-kanban-worker-log-backup-count" class="hm-input" type="number" inputmode="numeric" min="0" max="100" step="1" value="${esc(kanbanValues.workerLogBackupCount)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigOrchestratorProfile')}</span>
              <input id="hm-kanban-orchestrator-profile" class="hm-input" type="text" value="${esc(kanbanValues.orchestratorProfile)}" placeholder="${t('engine.hermesKanbanConfigProfileDefault')}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigDefaultAssignee')}</span>
              <input id="hm-kanban-default-assignee" class="hm-input" type="text" value="${esc(kanbanValues.defaultAssignee)}" placeholder="${t('engine.hermesKanbanConfigProfileDefault')}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesKanbanConfigDispatchStaleTimeoutSeconds')}</span>
              <input id="hm-kanban-dispatch-stale-timeout-seconds" class="hm-input" type="number" inputmode="numeric" min="0" max="604800" step="60" value="${esc(kanbanValues.dispatchStaleTimeoutSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesKanbanConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderStreamingPanel() {
    const disabled = loading || saving || streamingLoading || streamingSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || securitySaving || executionLimitsSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving
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
    const disabled = loading || saving || executionLimitsLoading || executionLimitsSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving
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
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationModel')}</span>
              <input id="hm-delegation-model" class="hm-input" value="${esc(executionLimitsValues.delegationModel)}" placeholder="google/gemini-3-flash-preview" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesExecutionLimitsDelegationProvider')}</span>
              <input id="hm-delegation-provider" class="hm-input" value="${esc(executionLimitsValues.delegationProvider)}" placeholder="openrouter" ${disabled ? 'disabled' : ''}>
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

  function renderIoSafetyPanel() {
    const disabled = loading || saving || ioSafetyLoading || ioSafetySaving || checkpointsSaving || cronSaving || loggingSaving || approvalsSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-io-safety-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesIoSafetyTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesIoSafetyDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${ioSafetySaving ? t('engine.hermesConfigStatusSaving') : ioSafetyLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesIoSafetyStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-io-safety-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesIoSafetySave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(ioSafetyError)}
          <div class="hm-config-runtime-grid hm-config-io-safety-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesIoSafetyFileReadMaxChars')}</span>
              <input id="hm-file-read-max-chars" class="hm-input" type="number" inputmode="numeric" min="1000" max="1000000" step="1000" value="${esc(ioSafetyValues.fileReadMaxChars)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesIoSafetyToolOutputMaxBytes')}</span>
              <input id="hm-tool-output-max-bytes" class="hm-input" type="number" inputmode="numeric" min="1000" max="1000000" step="1000" value="${esc(ioSafetyValues.toolOutputMaxBytes)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesIoSafetyToolOutputMaxLines')}</span>
              <input id="hm-tool-output-max-lines" class="hm-input" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${esc(ioSafetyValues.toolOutputMaxLines)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesIoSafetyToolOutputMaxLineLength')}</span>
              <input id="hm-tool-output-max-line-length" class="hm-input" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${esc(ioSafetyValues.toolOutputMaxLineLength)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesIoSafetyFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderCheckpointsPanel() {
    const disabled = loading || saving || checkpointsLoading || checkpointsSaving || ioSafetySaving || cronSaving || loggingSaving || approvalsSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-checkpoints-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesCheckpointsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesCheckpointsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${checkpointsSaving ? t('engine.hermesConfigStatusSaving') : checkpointsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesCheckpointsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-checkpoints-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesCheckpointsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(checkpointsError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-checkpoints-enabled" type="checkbox" ${checkpointsValues.checkpointsEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCheckpointsConfigEnabled')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-checkpoints-auto-prune" type="checkbox" ${checkpointsValues.checkpointAutoPrune ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCheckpointsConfigAutoPrune')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-checkpoints-delete-orphans" type="checkbox" ${checkpointsValues.checkpointDeleteOrphans ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCheckpointsConfigDeleteOrphans')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-checkpoints-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCheckpointsConfigMaxSnapshots')}</span>
              <input id="hm-checkpoints-max-snapshots" class="hm-input" type="number" inputmode="numeric" min="1" max="10000" step="1" value="${esc(checkpointsValues.checkpointMaxSnapshots)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCheckpointsConfigMaxTotalSizeMb')}</span>
              <input id="hm-checkpoints-max-total-size-mb" class="hm-input" type="number" inputmode="numeric" min="0" max="10485760" step="100" value="${esc(checkpointsValues.checkpointMaxTotalSizeMb)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCheckpointsConfigMaxFileSizeMb')}</span>
              <input id="hm-checkpoints-max-file-size-mb" class="hm-input" type="number" inputmode="numeric" min="0" max="1048576" step="1" value="${esc(checkpointsValues.checkpointMaxFileSizeMb)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCheckpointsConfigRetentionDays')}</span>
              <input id="hm-checkpoints-retention-days" class="hm-input" type="number" inputmode="numeric" min="1" max="3650" step="1" value="${esc(checkpointsValues.checkpointRetentionDays)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCheckpointsConfigMinIntervalHours')}</span>
              <input id="hm-checkpoints-min-interval-hours" class="hm-input" type="number" inputmode="numeric" min="0" max="8760" step="1" value="${esc(checkpointsValues.checkpointMinIntervalHours)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesCheckpointsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderCronPanel() {
    const disabled = loading || saving || cronLoading || cronSaving || checkpointsSaving || loggingSaving || approvalsSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-cron-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesCronConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesCronConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${cronSaving ? t('engine.hermesConfigStatusSaving') : cronLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesCronConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-cron-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesCronConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(cronError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-cron-wrap-response" type="checkbox" ${cronValues.cronWrapResponse ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesCronConfigWrapResponse')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-cron-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesCronConfigMaxParallelJobs')}</span>
              <input id="hm-cron-max-parallel-jobs" class="hm-input" type="number" inputmode="numeric" min="0" max="10000" step="1" value="${esc(cronValues.cronMaxParallelJobs)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesCronConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderLoggingPanel() {
    const disabled = loading || saving || loggingLoading || loggingSaving || checkpointsSaving || cronSaving || approvalsSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-logging-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesLoggingConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesLoggingConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${loggingSaving ? t('engine.hermesConfigStatusSaving') : loggingLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesLoggingConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-logging-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesLoggingConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(loggingError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-logging-memory-monitor-enabled" type="checkbox" ${loggingValues.loggingMemoryMonitorEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesLoggingConfigMemoryMonitorEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-logging-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLoggingConfigLevel')}</span>
              <select id="hm-logging-level" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${LOGGING_LEVELS.map(level => option(`engine.hermesLoggingConfigLevel_${level}`, level, loggingValues.loggingLevel)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLoggingConfigMaxSizeMb')}</span>
              <input id="hm-logging-max-size-mb" class="hm-input" type="number" inputmode="numeric" min="1" max="102400" step="1" value="${esc(loggingValues.loggingMaxSizeMb)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLoggingConfigBackupCount')}</span>
              <input id="hm-logging-backup-count" class="hm-input" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(loggingValues.loggingBackupCount)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLoggingConfigMemoryMonitorIntervalSeconds')}</span>
              <input id="hm-logging-memory-monitor-interval-seconds" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(loggingValues.loggingMemoryMonitorIntervalSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesLoggingConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderApprovalsPanel() {
    const disabled = loading || saving || approvalsLoading || approvalsSaving || checkpointsSaving || cronSaving || loggingSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-approvals-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesApprovalsConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesApprovalsConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${approvalsSaving ? t('engine.hermesConfigStatusSaving') : approvalsLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesApprovalsConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-approvals-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesApprovalsConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(approvalsError)}
          <div class="hm-config-runtime-grid hm-config-approvals-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesApprovalsConfigMode')}</span>
              <select id="hm-approval-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${APPROVAL_MODES.map(mode => option(`engine.hermesApprovalsConfigMode_${mode}`, mode, approvalsValues.approvalMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesApprovalsConfigTimeout')}</span>
              <input id="hm-approval-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(approvalsValues.approvalTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesApprovalsConfigCronMode')}</span>
              <select id="hm-approval-cron-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${APPROVAL_CRON_MODES.map(mode => option(`engine.hermesApprovalsConfigCronMode_${mode}`, mode, approvalsValues.approvalCronMode)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-approval-mcp-reload-confirm" type="checkbox" ${approvalsValues.approvalMcpReloadConfirm ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesApprovalsConfigMcpReloadConfirm')}</span>
            </label>
            <label class="hm-channel-check hm-channel-check--danger">
              <input id="hm-approval-destructive-slash-confirm" type="checkbox" ${approvalsValues.approvalDestructiveSlashConfirm ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesApprovalsConfigDestructiveSlashConfirm')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesApprovalsConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderPrivacyPanel() {
    const disabled = loading || saving || privacyLoading || privacySaving || approvalsSaving || cronSaving || loggingSaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-privacy-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesPrivacyConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesPrivacyConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${privacySaving ? t('engine.hermesConfigStatusSaving') : privacyLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesPrivacyConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-privacy-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesPrivacyConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(privacyError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-privacy-redact-pii" type="checkbox" ${privacyValues.redactPii ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesPrivacyConfigRedactPii')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesPrivacyConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderBrowserPanel() {
    const disabled = loading || saving || browserLoading || browserSaving || webSaving || approvalsSaving || cronSaving || loggingSaving || privacySaving || sttSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-browser-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesBrowserConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesBrowserConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${browserSaving ? t('engine.hermesConfigStatusSaving') : browserLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesBrowserConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-browser-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesBrowserConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(browserError)}
          <div class="hm-config-runtime-grid hm-config-browser-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigEngine')}</span>
              <select id="hm-browser-engine" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${BROWSER_ENGINES.map(mode => option(`engine.hermesBrowserConfigEngine_${mode}`, mode, browserValues.browserEngine)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigInactivityTimeout')}</span>
              <input id="hm-browser-inactivity-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(browserValues.browserInactivityTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigCommandTimeout')}</span>
              <input id="hm-browser-command-timeout" class="hm-input" type="number" inputmode="numeric" min="5" max="3600" step="1" value="${esc(browserValues.browserCommandTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigCdpUrl')}</span>
              <input id="hm-browser-cdp-url" class="hm-input" type="text" value="${esc(browserValues.browserCdpUrl)}" placeholder="${t('engine.hermesBrowserConfigCdpUrlPlaceholder')}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigDialogPolicy')}</span>
              <select id="hm-browser-dialog-policy" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${BROWSER_DIALOG_POLICIES.map(policy => option(`engine.hermesBrowserConfigDialogPolicy_${policy}`, policy, browserValues.browserDialogPolicy)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigDialogTimeout')}</span>
              <input id="hm-browser-dialog-timeout" class="hm-input" type="number" inputmode="numeric" min="1" max="86400" step="1" value="${esc(browserValues.browserDialogTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-browser-record-sessions" type="checkbox" ${browserValues.browserRecordSessions ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesBrowserConfigRecordSessions')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-browser-allow-private-urls" type="checkbox" ${browserValues.browserAllowPrivateUrls ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesBrowserConfigAllowPrivateUrls')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-browser-auto-local-for-private-urls" type="checkbox" ${browserValues.browserAutoLocalForPrivateUrls ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesBrowserConfigAutoLocalForPrivateUrls')}</span>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesBrowserConfigCamofoxTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-browser-camofox-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigCamofoxUserId')}</span>
              <input id="hm-browser-camofox-user-id" class="hm-input" type="text" autocomplete="off" spellcheck="false" value="${esc(browserValues.browserCamofoxUserId)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesBrowserConfigCamofoxSessionKey')}</span>
              <input id="hm-browser-camofox-session-key" class="hm-input" type="text" autocomplete="off" spellcheck="false" value="${esc(browserValues.browserCamofoxSessionKey)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-browser-camofox-managed-persistence" type="checkbox" ${browserValues.browserCamofoxManagedPersistence ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesBrowserConfigCamofoxManagedPersistence')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-browser-camofox-adopt-existing-tab" type="checkbox" ${browserValues.browserCamofoxAdoptExistingTab ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesBrowserConfigCamofoxAdoptExistingTab')}</span>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesBrowserConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderWebConfigPanel() {
    const disabled = loading || saving || webLoading || webSaving || browserSaving || lspSaving || approvalsSaving || cronSaving || loggingSaving || privacySaving || sttSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-web-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesWebConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesWebConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${webSaving ? t('engine.hermesConfigStatusSaving') : webLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesWebConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-web-config-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesWebConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(webError)}
          <div class="hm-config-runtime-grid hm-config-web-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesWebConfigBackend')}</span>
              <select id="hm-web-backend" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${WEB_BACKENDS.map(backend => option(`engine.hermesWebConfigBackend_${backend || 'auto'}`, backend, webValues.webBackend)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesWebConfigSearchBackend')}</span>
              <select id="hm-web-search-backend" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${WEB_BACKENDS.map(backend => option(`engine.hermesWebConfigBackend_${backend || 'auto'}`, backend, webValues.webSearchBackend)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesWebConfigExtractBackend')}</span>
              <select id="hm-web-extract-backend" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${WEB_BACKENDS.map(backend => option(`engine.hermesWebConfigBackend_${backend || 'auto'}`, backend, webValues.webExtractBackend)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesWebConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderLspConfigPanel() {
    const disabled = loading || saving || lspLoading || lspSaving || webSaving || browserSaving || approvalsSaving || cronSaving || loggingSaving || privacySaving || sttSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-lsp-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesLspConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesLspConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${lspSaving ? t('engine.hermesConfigStatusSaving') : lspLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesLspConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-lsp-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesLspConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(lspError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-lsp-enabled" type="checkbox" ${lspValues.lspEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesLspConfigEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-lsp-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLspConfigWaitMode')}</span>
              <select id="hm-lsp-wait-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${LSP_WAIT_MODES.map(mode => option(`engine.hermesLspConfigWaitMode_${mode}`, mode, lspValues.lspWaitMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLspConfigWaitTimeout')}</span>
              <input id="hm-lsp-wait-timeout" class="hm-input" type="number" inputmode="decimal" min="0.1" max="120" step="0.1" value="${esc(lspValues.lspWaitTimeout)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesLspConfigInstallStrategy')}</span>
              <select id="hm-lsp-install-strategy" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${LSP_INSTALL_STRATEGIES.map(strategy => option(`engine.hermesLspConfigInstallStrategy_${strategy}`, strategy, lspValues.lspInstallStrategy)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesLspConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderSttPanel() {
    const disabled = loading || saving || sttLoading || sttSaving || webSaving || lspSaving || approvalsSaving || cronSaving || loggingSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-stt-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesSttConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesSttConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${sttSaving ? t('engine.hermesConfigStatusSaving') : sttLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesSttConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-stt-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesSttConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(sttError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-stt-enabled" type="checkbox" ${sttValues.sttEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesSttConfigEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-stt-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSttConfigProvider')}</span>
              <select id="hm-stt-provider" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${STT_PROVIDERS.map(mode => option(`engine.hermesSttConfigProvider_${mode}`, mode, sttValues.sttProvider)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSttConfigLocalModel')}</span>
              <select id="hm-stt-local-model" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${STT_LOCAL_MODELS.map(model => option(`engine.hermesSttConfigLocalModel_${model}`, model, sttValues.sttLocalModel)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSttConfigLocalLanguage')}</span>
              <input id="hm-stt-local-language" class="hm-input" placeholder="zh" value="${esc(sttValues.sttLocalLanguage)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSttConfigOpenaiModel')}</span>
              <select id="hm-stt-openai-model" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${STT_OPENAI_MODELS.map(model => option(`engine.hermesSttConfigOpenaiModel_${model}`, model, sttValues.sttOpenaiModel)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesSttConfigMistralModel')}</span>
              <select id="hm-stt-mistral-model" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${STT_MISTRAL_MODELS.map(model => option(`engine.hermesSttConfigMistralModel_${model}`, model, sttValues.sttMistralModel)).join('')}
              </select>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesSttConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderTtsVoicePanel() {
    const disabled = loading || saving || ttsVoiceLoading || ttsVoiceSaving || sttSaving || approvalsSaving || cronSaving || loggingSaving || privacySaving || browserSaving || terminalSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || ioSafetySaving || checkpointsSaving
    return `
      <div class="hm-panel hm-config-runtime-panel hm-config-tts-voice-panel">
        <div class="hm-panel-header">
          <div>
            <div class="hm-panel-title">${t('engine.hermesTtsVoiceConfigTitle')}</div>
            <div class="hm-channel-panel-desc">${t('engine.hermesTtsVoiceConfigDesc')}</div>
          </div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${ttsVoiceSaving ? t('engine.hermesConfigStatusSaving') : ttsVoiceLoading ? t('engine.hermesConfigStatusLoading') : t('engine.hermesTtsVoiceConfigStatusReady')}</span>
            <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-tts-voice-save" ${disabled ? 'disabled' : ''}>${t('engine.hermesTtsVoiceConfigSave')}</button>
          </div>
        </div>
        <div class="hm-panel-body">
          ${renderError(ttsVoiceError)}
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-voice-auto-tts" type="checkbox" ${ttsVoiceValues.voiceAutoTts ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesVoiceConfigAutoTts')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-voice-beep-enabled" type="checkbox" ${ttsVoiceValues.voiceBeepEnabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesVoiceConfigBeepEnabled')}</span>
            </label>
          </div>
          <div class="hm-config-runtime-grid hm-config-tts-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigProvider')}</span>
              <select id="hm-tts-provider" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${TTS_PROVIDERS.map(provider => option(`engine.hermesTtsConfigProvider_${provider}`, provider, ttsVoiceValues.ttsProvider)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigEdgeVoice')}</span>
              <input id="hm-tts-edge-voice" class="hm-input" placeholder="en-US-AriaNeural" value="${esc(ttsVoiceValues.ttsEdgeVoice)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigOpenaiModel')}</span>
              <input id="hm-tts-openai-model" class="hm-input" placeholder="gpt-4o-mini-tts" value="${esc(ttsVoiceValues.ttsOpenaiModel)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigOpenaiVoice')}</span>
              <select id="hm-tts-openai-voice" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${TTS_OPENAI_VOICES.map(voice => option(`engine.hermesTtsConfigOpenaiVoice_${voice}`, voice, ttsVoiceValues.ttsOpenaiVoice)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigElevenlabsVoiceId')}</span>
              <input id="hm-tts-elevenlabs-voice-id" class="hm-input" placeholder="pNInz6obpgDQGcFmaJgB" value="${esc(ttsVoiceValues.ttsElevenlabsVoiceId)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigElevenlabsModelId')}</span>
              <input id="hm-tts-elevenlabs-model-id" class="hm-input" placeholder="eleven_multilingual_v2" value="${esc(ttsVoiceValues.ttsElevenlabsModelId)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigXaiVoiceId')}</span>
              <input id="hm-tts-xai-voice-id" class="hm-input" placeholder="eve" value="${esc(ttsVoiceValues.ttsXaiVoiceId)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigXaiLanguage')}</span>
              <input id="hm-tts-xai-language" class="hm-input" placeholder="en" value="${esc(ttsVoiceValues.ttsXaiLanguage)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigXaiSampleRate')}</span>
              <input id="hm-tts-xai-sample-rate" class="hm-input" type="number" inputmode="numeric" min="8000" max="192000" step="1000" value="${esc(ttsVoiceValues.ttsXaiSampleRate)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigXaiBitRate')}</span>
              <input id="hm-tts-xai-bit-rate" class="hm-input" type="number" inputmode="numeric" min="16000" max="512000" step="1000" value="${esc(ttsVoiceValues.ttsXaiBitRate)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigMistralModel')}</span>
              <input id="hm-tts-mistral-model" class="hm-input" placeholder="voxtral-mini-tts-2603" value="${esc(ttsVoiceValues.ttsMistralModel)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigMistralVoiceId')}</span>
              <input id="hm-tts-mistral-voice-id" class="hm-input" placeholder="c69964a6-ab8b-4f8a-9465-ec0925096ec8" value="${esc(ttsVoiceValues.ttsMistralVoiceId)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTtsConfigPiperVoice')}</span>
              <input id="hm-tts-piper-voice" class="hm-input" placeholder="en_US-lessac-medium" value="${esc(ttsVoiceValues.ttsPiperVoice)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesVoiceConfigRecordKey')}</span>
              <input id="hm-voice-record-key" class="hm-input" placeholder="ctrl+b" value="${esc(ttsVoiceValues.voiceRecordKey)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesVoiceConfigMaxRecordingSeconds')}</span>
              <input id="hm-voice-max-recording-seconds" class="hm-input" type="number" inputmode="numeric" min="1" max="3600" step="1" value="${esc(ttsVoiceValues.voiceMaxRecordingSeconds)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesVoiceConfigSilenceThreshold')}</span>
              <input id="hm-voice-silence-threshold" class="hm-input" type="number" inputmode="numeric" min="0" max="32767" step="1" value="${esc(ttsVoiceValues.voiceSilenceThreshold)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesVoiceConfigSilenceDuration')}</span>
              <input id="hm-voice-silence-duration" class="hm-input" type="number" inputmode="decimal" min="0.1" max="60" step="0.1" value="${esc(ttsVoiceValues.voiceSilenceDuration)}" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-channel-footnote">${t('engine.hermesTtsVoiceConfigFootnote')}</div>
        </div>
      </div>
    `
  }

  function renderTerminalPanel() {
    const disabled = loading || saving || terminalLoading || terminalSaving || approvalsSaving || cronSaving || loggingSaving || browserSaving || sttSaving || runtimeSaving || compressionSaving || promptCachingSaving || openrouterCacheSaving || providerRoutingSaving || auxiliarySaving || toolGuardrailsSaving || memorySaving || skillsSaving || quickCommandsSaving || providerOverridesSaving || agentToolsetsSaving || agentRuntimeSaving || unauthorizedDmSaving || streamingSaving || executionLimitsSaving || checkpointsSaving
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
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigShellInitFiles')}</span>
              <textarea id="hm-terminal-shell-init-files" class="hm-input hm-textarea" rows="3" placeholder="~/.bashrc&#10;\${HOME}/.config/hermes/env.sh" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalShellInitFiles)}</textarea>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigEnvPassthrough')}</span>
              <textarea id="hm-terminal-env-passthrough" class="hm-input hm-textarea" rows="3" placeholder="OPENROUTER_API_KEY&#10;GITHUB_TOKEN" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalEnvPassthrough)}</textarea>
            </label>
          </div>
          <div class="hm-config-check-grid">
            <label class="hm-channel-check">
              <input id="hm-terminal-auto-source-bashrc" type="checkbox" ${terminalValues.terminalAutoSourceBashrc ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesTerminalConfigAutoSourceBashrc')}</span>
            </label>
            <label class="hm-channel-check">
              <input id="hm-terminal-persistent-shell" type="checkbox" ${terminalValues.terminalPersistentShell ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${t('engine.hermesTerminalConfigPersistentShell')}</span>
            </label>
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
          <div class="hm-config-subtitle">${t('engine.hermesTerminalConfigSshTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-terminal-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigSshHost')}</span>
              <input id="hm-terminal-ssh-host" class="hm-input" value="${esc(terminalValues.terminalSshHost)}" placeholder="my-server.example.com" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigSshUser')}</span>
              <input id="hm-terminal-ssh-user" class="hm-input" value="${esc(terminalValues.terminalSshUser)}" placeholder="deploy" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigSshPort')}</span>
              <input id="hm-terminal-ssh-port" class="hm-input" type="number" inputmode="numeric" min="1" max="65535" step="1" value="${esc(terminalValues.terminalSshPort)}" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigSshKey')}</span>
              <input id="hm-terminal-ssh-key" class="hm-input" value="${esc(terminalValues.terminalSshKey)}" placeholder="~/.ssh/id_ed25519" ${disabled ? 'disabled' : ''}>
            </label>
          </div>
          <div class="hm-config-subtitle">${t('engine.hermesTerminalConfigContainerTitle')}</div>
          <div class="hm-config-runtime-grid hm-config-terminal-grid">
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDockerImage')}</span>
              <input id="hm-terminal-docker-image" class="hm-input" value="${esc(terminalValues.terminalDockerImage)}" placeholder="nikolaik/python-nodejs:python3.11-nodejs20" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDockerForwardEnv')}</span>
              <textarea id="hm-terminal-docker-forward-env" class="hm-input hm-textarea" rows="3" placeholder="GITHUB_TOKEN&#10;NPM_TOKEN" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalDockerForwardEnv)}</textarea>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDockerEnvJson')}</span>
              <textarea id="hm-terminal-docker-env-json" class="hm-input hm-textarea" rows="4" placeholder="{&#10;  &quot;PLAYWRIGHT_BROWSERS_PATH&quot;: &quot;/ms-playwright&quot;&#10;}" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalDockerEnvJson)}</textarea>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDockerVolumes')}</span>
              <textarea id="hm-terminal-docker-volumes" class="hm-input hm-textarea" rows="3" placeholder="/data/projects:/workspace/projects&#10;/data/cache:/cache" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalDockerVolumes)}</textarea>
            </label>
            <label class="hm-field hm-field--wide">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDockerExtraArgs')}</span>
              <textarea id="hm-terminal-docker-extra-args" class="hm-input hm-textarea" rows="3" placeholder="--network=host&#10;--add-host=host.docker.internal:host-gateway" ${disabled ? 'disabled' : ''}>${esc(terminalValues.terminalDockerExtraArgs)}</textarea>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigSingularityImage')}</span>
              <input id="hm-terminal-singularity-image" class="hm-input" value="${esc(terminalValues.terminalSingularityImage)}" placeholder="docker://nikolaik/python-nodejs:python3.11-nodejs20" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigModalImage')}</span>
              <input id="hm-terminal-modal-image" class="hm-input" value="${esc(terminalValues.terminalModalImage)}" placeholder="nikolaik/python-nodejs:python3.11-nodejs20" ${disabled ? 'disabled' : ''}>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigModalMode')}</span>
              <select id="hm-terminal-modal-mode" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${TERMINAL_MODAL_MODES.map(mode => option(`engine.hermesTerminalConfigModalMode_${mode}`, mode, terminalValues.terminalModalMode)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigVercelRuntime')}</span>
              <select id="hm-terminal-vercel-runtime" class="hm-input" ${disabled ? 'disabled' : ''}>
                ${TERMINAL_VERCEL_RUNTIMES.map(runtime => option(`engine.hermesTerminalConfigVercelRuntime_${runtime.replace('.', '_')}`, runtime, terminalValues.terminalVercelRuntime)).join('')}
              </select>
            </label>
            <label class="hm-field">
              <span class="hm-field-label">${t('engine.hermesTerminalConfigDaytonaImage')}</span>
              <input id="hm-terminal-daytona-image" class="hm-input" value="${esc(terminalValues.terminalDaytonaImage)}" placeholder="nikolaik/python-nodejs:python3.11-nodejs20" ${disabled ? 'disabled' : ''}>
            </label>
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
      ${renderSessionsMaintenancePanel()}
      ${renderUpdatesPanel()}
      ${renderTerminalPanel()}
      ${renderStreamingPanel()}
      ${renderExecutionLimitsPanel()}
      ${renderIoSafetyPanel()}
      ${renderCheckpointsPanel()}
      ${renderCronPanel()}
      ${renderLoggingPanel()}
      ${renderApprovalsPanel()}
      ${renderPrivacyPanel()}
      ${renderBrowserPanel()}
      ${renderWebConfigPanel()}
      ${renderLspConfigPanel()}
      ${renderSttPanel()}
      ${renderTtsVoicePanel()}
      ${renderCompressionPanel()}
      ${renderPromptCachingPanel()}
      ${renderOpenrouterCachePanel()}
      ${renderProviderRoutingPanel()}
      ${renderAuxiliaryConfigPanel()}
      ${renderToolGuardrailsPanel()}
      ${renderMemoryPanel()}
      ${renderSkillsConfigPanel()}
      ${renderCuratorConfigPanel()}
      ${renderQuickCommandsConfigPanel()}
      ${renderModelConfigPanel()}
      ${renderModelCatalogConfigPanel()}
      ${renderXSearchConfigPanel()}
      ${renderContextConfigPanel()}
      ${renderModelAliasesConfigPanel()}
      ${renderHooksConfigPanel()}
      ${renderProviderOverridesConfigPanel()}
      ${renderMcpServersConfigPanel()}
      ${renderAgentToolsetsConfigPanel()}
      ${renderPlatformToolsetsConfigPanel()}
      ${renderAgentRuntimeConfigPanel()}
      ${renderUnauthorizedDmConfigPanel()}
      ${renderSecurityConfigPanel()}
      ${renderDisplayConfigPanel()}
      ${renderHumanDelayConfigPanel()}
      ${renderKanbanConfigPanel()}

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
    el.querySelector('#hm-sessions-maintenance-save')?.addEventListener('click', saveSessionsMaintenance)
    el.querySelector('#hm-updates-save')?.addEventListener('click', saveUpdatesConfig)
    el.querySelector('#hm-compression-save')?.addEventListener('click', saveCompression)
    el.querySelector('#hm-prompt-caching-save')?.addEventListener('click', savePromptCaching)
    el.querySelector('#hm-openrouter-cache-save')?.addEventListener('click', saveOpenrouterCache)
    el.querySelector('#hm-provider-routing-save')?.addEventListener('click', saveProviderRouting)
    el.querySelector('#hm-auxiliary-save')?.addEventListener('click', saveAuxiliaryConfig)
    el.querySelector('#hm-tool-guardrails-save')?.addEventListener('click', saveToolGuardrails)
    el.querySelector('#hm-memory-save')?.addEventListener('click', saveMemory)
    el.querySelector('#hm-skills-config-save')?.addEventListener('click', saveSkillsConfig)
    el.querySelector('#hm-curator-config-save')?.addEventListener('click', saveCuratorConfig)
    el.querySelector('#hm-quick-commands-save')?.addEventListener('click', saveQuickCommandsConfig)
    el.querySelector('#hm-model-config-save')?.addEventListener('click', saveModelConfig)
    el.querySelector('#hm-model-catalog-save')?.addEventListener('click', saveModelCatalogConfig)
    el.querySelector('#hm-x-search-save')?.addEventListener('click', saveXSearchConfig)
    el.querySelector('#hm-context-config-save')?.addEventListener('click', saveContextConfig)
    el.querySelector('#hm-model-aliases-save')?.addEventListener('click', saveModelAliasesConfig)
    el.querySelector('#hm-hooks-save')?.addEventListener('click', saveHooksConfig)
    el.querySelector('#hm-provider-overrides-save')?.addEventListener('click', saveProviderOverridesConfig)
    el.querySelector('#hm-mcp-servers-save')?.addEventListener('click', saveMcpServersConfig)
    el.querySelector('#hm-agent-toolsets-save')?.addEventListener('click', saveAgentToolsetsConfig)
    el.querySelector('#hm-platform-toolsets-save')?.addEventListener('click', savePlatformToolsetsConfig)
    el.querySelector('#hm-agent-runtime-save')?.addEventListener('click', saveAgentRuntimeConfig)
    el.querySelector('#hm-unauthorized-dm-save')?.addEventListener('click', saveUnauthorizedDmConfig)
    el.querySelector('#hm-security-save')?.addEventListener('click', saveSecurityConfig)
    el.querySelector('#hm-display-save')?.addEventListener('click', saveDisplayConfig)
    el.querySelector('#hm-human-delay-save')?.addEventListener('click', saveHumanDelayConfig)
    el.querySelector('#hm-kanban-config-save')?.addEventListener('click', saveKanbanConfig)
    el.querySelector('#hm-streaming-save')?.addEventListener('click', saveStreaming)
    el.querySelector('#hm-execution-limits-save')?.addEventListener('click', saveExecutionLimits)
    el.querySelector('#hm-io-safety-save')?.addEventListener('click', saveIoSafety)
    el.querySelector('#hm-checkpoints-save')?.addEventListener('click', saveCheckpoints)
    el.querySelector('#hm-cron-save')?.addEventListener('click', saveCronConfig)
    el.querySelector('#hm-logging-save')?.addEventListener('click', saveLoggingConfig)
    el.querySelector('#hm-approvals-save')?.addEventListener('click', saveApprovalsConfig)
    el.querySelector('#hm-privacy-save')?.addEventListener('click', savePrivacyConfig)
    el.querySelector('#hm-browser-save')?.addEventListener('click', saveBrowserConfig)
    el.querySelector('#hm-web-config-save')?.addEventListener('click', saveWebConfig)
    el.querySelector('#hm-lsp-save')?.addEventListener('click', saveLspConfig)
    el.querySelector('#hm-stt-save')?.addEventListener('click', saveSttConfig)
    el.querySelector('#hm-tts-voice-save')?.addEventListener('click', saveTtsVoiceConfig)
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

  async function loadSessionsMaintenance() {
    const data = await api.hermesSessionsMaintenanceConfigRead()
    sessionsMaintenanceValues = { ...SESSIONS_MAINTENANCE_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadUpdatesConfig() {
    const data = await api.hermesUpdatesConfigRead()
    updatesValues = { ...UPDATES_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadCompression() {
    const data = await api.hermesCompressionConfigRead()
    compressionValues = { ...COMPRESSION_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadPromptCaching() {
    const data = await api.hermesPromptCachingConfigRead()
    promptCachingValues = { ...PROMPT_CACHING_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadOpenrouterCache() {
    const data = await api.hermesOpenrouterCacheConfigRead()
    openrouterCacheValues = { ...OPENROUTER_CACHE_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadProviderRouting() {
    const data = await api.hermesProviderRoutingConfigRead()
    providerRoutingValues = { ...PROVIDER_ROUTING_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadAuxiliaryConfig() {
    const data = await api.hermesAuxiliaryConfigRead()
    auxiliaryValues = { ...AUXILIARY_DEFAULTS, ...(data?.values || {}) }
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

  async function loadCuratorConfig() {
    const data = await api.hermesCuratorConfigRead()
    curatorValues = { ...CURATOR_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadQuickCommandsConfig() {
    const data = await api.hermesQuickCommandsConfigRead()
    quickCommandsValues = { ...QUICK_COMMANDS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadModelConfig() {
    const data = await api.hermesModelConfigRead()
    modelValues = { ...MODEL_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadModelCatalogConfig() {
    const data = await api.hermesModelCatalogConfigRead()
    modelCatalogValues = { ...MODEL_CATALOG_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadXSearchConfig() {
    const data = await api.hermesXSearchConfigRead()
    xSearchValues = { ...X_SEARCH_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadContextConfig() {
    const data = await api.hermesContextConfigRead()
    contextValues = { ...CONTEXT_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadModelAliasesConfig() {
    const data = await api.hermesModelAliasesConfigRead()
    modelAliasesValues = { ...MODEL_ALIASES_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadHooksConfig() {
    const data = await api.hermesHooksConfigRead()
    hooksValues = { ...HOOKS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadProviderOverridesConfig() {
    const data = await api.hermesProviderOverridesConfigRead()
    providerOverridesValues = { ...PROVIDER_OVERRIDES_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadMcpServersConfig() {
    const data = await api.hermesMcpServersConfigRead()
    mcpServersValues = { ...MCP_SERVERS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadAgentToolsetsConfig() {
    const data = await api.hermesAgentToolsetsConfigRead()
    agentToolsetsValues = { ...AGENT_TOOLSETS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadPlatformToolsetsConfig() {
    const data = await api.hermesPlatformToolsetsConfigRead()
    platformToolsetsValues = { ...PLATFORM_TOOLSETS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadAgentRuntimeConfig() {
    const data = await api.hermesAgentRuntimeConfigRead()
    agentRuntimeValues = { ...AGENT_RUNTIME_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadUnauthorizedDmConfig() {
    const data = await api.hermesUnauthorizedDmConfigRead()
    unauthorizedDmValues = { ...UNAUTHORIZED_DM_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadSecurityConfig() {
    const data = await api.hermesSecurityConfigRead()
    securityValues = { ...SECURITY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadDisplayConfig() {
    const data = await api.hermesDisplayConfigRead()
    displayValues = { ...DISPLAY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadHumanDelayConfig() {
    const data = await api.hermesHumanDelayConfigRead()
    humanDelayValues = { ...HUMAN_DELAY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadKanbanConfig() {
    const data = await api.hermesKanbanConfigRead()
    kanbanValues = { ...KANBAN_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadStreaming() {
    const data = await api.hermesStreamingConfigRead()
    streamingValues = { ...STREAMING_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadExecutionLimits() {
    const data = await api.hermesExecutionLimitsConfigRead()
    executionLimitsValues = { ...EXECUTION_LIMITS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadIoSafety() {
    const data = await api.hermesIoSafetyConfigRead()
    ioSafetyValues = { ...IO_SAFETY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadCheckpoints() {
    const data = await api.hermesCheckpointsConfigRead()
    checkpointsValues = { ...CHECKPOINTS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadCronConfig() {
    const data = await api.hermesCronConfigRead()
    cronValues = { ...CRON_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadLoggingConfig() {
    const data = await api.hermesLoggingConfigRead()
    loggingValues = { ...LOGGING_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadApprovalsConfig() {
    const data = await api.hermesApprovalsConfigRead()
    approvalsValues = { ...APPROVALS_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadPrivacyConfig() {
    const data = await api.hermesPrivacyConfigRead()
    privacyValues = { ...PRIVACY_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadBrowserConfig() {
    const data = await api.hermesBrowserConfigRead()
    browserValues = { ...BROWSER_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadWebConfig() {
    const data = await api.hermesWebConfigRead()
    webValues = { ...WEB_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadLspConfig() {
    const data = await api.hermesLspConfigRead()
    lspValues = { ...LSP_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadSttConfig() {
    const data = await api.hermesSttConfigRead()
    sttValues = { ...STT_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadTtsVoiceConfig() {
    const data = await api.hermesTtsVoiceConfigRead()
    ttsVoiceValues = { ...TTS_VOICE_DEFAULTS, ...(data?.values || {}) }
  }

  async function loadTerminal() {
    const data = await api.hermesTerminalConfigRead()
    terminalValues = { ...TERMINAL_DEFAULTS, ...(data?.values || {}) }
  }

  async function load() {
    loading = true
    runtimeLoading = true
    sessionsMaintenanceLoading = true
    updatesLoading = true
    compressionLoading = true
    promptCachingLoading = true
    openrouterCacheLoading = true
    providerRoutingLoading = true
    auxiliaryLoading = true
    toolGuardrailsLoading = true
    memoryLoading = true
    skillsLoading = true
    curatorLoading = true
    quickCommandsLoading = true
    modelLoading = true
    modelCatalogLoading = true
    xSearchLoading = true
    contextLoading = true
    modelAliasesLoading = true
    hooksLoading = true
    providerOverridesLoading = true
    mcpServersLoading = true
    agentToolsetsLoading = true
    platformToolsetsLoading = true
    agentRuntimeLoading = true
    unauthorizedDmLoading = true
    securityLoading = true
    displayLoading = true
    humanDelayLoading = true
    kanbanLoading = true
    streamingLoading = true
    executionLimitsLoading = true
    ioSafetyLoading = true
    checkpointsLoading = true
    cronLoading = true
    loggingLoading = true
    approvalsLoading = true
    privacyLoading = true
    browserLoading = true
    webLoading = true
    lspLoading = true
    sttLoading = true
    ttsVoiceLoading = true
    terminalLoading = true
    error = null
    runtimeError = null
    sessionsMaintenanceError = null
    updatesError = null
    compressionError = null
    promptCachingError = null
    openrouterCacheError = null
    providerRoutingError = null
    auxiliaryError = null
    toolGuardrailsError = null
    memoryError = null
    skillsError = null
    curatorError = null
    quickCommandsError = null
    modelError = null
    modelCatalogError = null
    xSearchError = null
    contextError = null
    modelAliasesError = null
    hooksError = null
    providerOverridesError = null
    mcpServersError = null
    agentToolsetsError = null
    platformToolsetsError = null
    agentRuntimeError = null
    unauthorizedDmError = null
    securityError = null
    displayError = null
    humanDelayError = null
    streamingError = null
    executionLimitsError = null
    ioSafetyError = null
    checkpointsError = null
    cronError = null
    loggingError = null
    approvalsError = null
    privacyError = null
    browserError = null
    webError = null
    lspError = null
    sttError = null
    ttsVoiceError = null
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
      await loadSessionsMaintenance()
    } catch (err) {
      sessionsMaintenanceError = humanizeError(err, t('engine.hermesSessionsMaintenanceLoadFailed') || 'Load session maintenance config failed')
    } finally {
      sessionsMaintenanceLoading = false
      draw()
    }
    try {
      await loadUpdatesConfig()
    } catch (err) {
      updatesError = humanizeError(err, t('engine.hermesUpdatesConfigLoadFailed') || 'Load updates config failed')
    } finally {
      updatesLoading = false
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
      await loadPromptCaching()
    } catch (err) {
      promptCachingError = humanizeError(err, t('engine.hermesPromptCachingConfigLoadFailed') || 'Load prompt caching config failed')
    } finally {
      promptCachingLoading = false
      draw()
    }
    try {
      await loadOpenrouterCache()
    } catch (err) {
      openrouterCacheError = humanizeError(err, t('engine.hermesOpenrouterCacheConfigLoadFailed') || 'Load OpenRouter cache config failed')
    } finally {
      openrouterCacheLoading = false
      draw()
    }
    try {
      await loadProviderRouting()
    } catch (err) {
      providerRoutingError = humanizeError(err, t('engine.hermesProviderRoutingConfigLoadFailed') || 'Load provider routing config failed')
    } finally {
      providerRoutingLoading = false
      draw()
    }
    try {
      await loadAuxiliaryConfig()
    } catch (err) {
      auxiliaryError = humanizeError(err, t('engine.hermesAuxiliaryConfigLoadFailed') || 'Load auxiliary config failed')
    } finally {
      auxiliaryLoading = false
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
      await loadIoSafety()
    } catch (err) {
      ioSafetyError = humanizeError(err, t('engine.hermesIoSafetyLoadFailed') || 'Load input/output safety config failed')
    } finally {
      ioSafetyLoading = false
      draw()
    }
    try {
      await loadCheckpoints()
    } catch (err) {
      checkpointsError = humanizeError(err, t('engine.hermesCheckpointsConfigLoadFailed') || 'Load checkpoints config failed')
    } finally {
      checkpointsLoading = false
      draw()
    }
    try {
      await loadCronConfig()
    } catch (err) {
      cronError = humanizeError(err, t('engine.hermesCronConfigLoadFailed') || 'Load cron config failed')
    } finally {
      cronLoading = false
      draw()
    }
    try {
      await loadLoggingConfig()
    } catch (err) {
      loggingError = humanizeError(err, t('engine.hermesLoggingConfigLoadFailed') || 'Load logging config failed')
    } finally {
      loggingLoading = false
      draw()
    }
    try {
      await loadApprovalsConfig()
    } catch (err) {
      approvalsError = humanizeError(err, t('engine.hermesApprovalsConfigLoadFailed') || 'Load approvals config failed')
    } finally {
      approvalsLoading = false
      draw()
    }
    try {
      await loadPrivacyConfig()
    } catch (err) {
      privacyError = humanizeError(err, t('engine.hermesPrivacyConfigLoadFailed') || 'Load privacy config failed')
    } finally {
      privacyLoading = false
      draw()
    }
    try {
      await loadBrowserConfig()
    } catch (err) {
      browserError = humanizeError(err, t('engine.hermesBrowserConfigLoadFailed') || 'Load browser config failed')
    } finally {
      browserLoading = false
      draw()
    }
    try {
      await loadWebConfig()
    } catch (err) {
      webError = humanizeError(err, t('engine.hermesWebConfigLoadFailed') || 'Load web tool config failed')
    } finally {
      webLoading = false
      draw()
    }
    try {
      await loadLspConfig()
    } catch (err) {
      lspError = humanizeError(err, t('engine.hermesLspConfigLoadFailed') || 'Load LSP config failed')
    } finally {
      lspLoading = false
      draw()
    }
    try {
      await loadSttConfig()
    } catch (err) {
      sttError = humanizeError(err, t('engine.hermesSttConfigLoadFailed') || 'Load speech transcription config failed')
    } finally {
      sttLoading = false
      draw()
    }
    try {
      await loadTtsVoiceConfig()
    } catch (err) {
      ttsVoiceError = humanizeError(err, t('engine.hermesTtsVoiceConfigLoadFailed') || 'Load speech output config failed')
    } finally {
      ttsVoiceLoading = false
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
      await loadCuratorConfig()
    } catch (err) {
      curatorError = humanizeError(err, t('engine.hermesCuratorConfigLoadFailed') || 'Load curator config failed')
    } finally {
      curatorLoading = false
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
      await loadModelConfig()
    } catch (err) {
      modelError = humanizeError(err, t('engine.hermesModelConfigLoadFailed') || 'Load model config failed')
    } finally {
      modelLoading = false
      draw()
    }
    try {
      await loadModelCatalogConfig()
    } catch (err) {
      modelCatalogError = humanizeError(err, t('engine.hermesModelCatalogConfigLoadFailed') || 'Load model catalog config failed')
    } finally {
      modelCatalogLoading = false
      draw()
    }
    try {
      await loadXSearchConfig()
    } catch (err) {
      xSearchError = humanizeError(err, t('engine.hermesXSearchConfigLoadFailed') || 'Load X search config failed')
    } finally {
      xSearchLoading = false
      draw()
    }
    try {
      await loadContextConfig()
    } catch (err) {
      contextError = humanizeError(err, t('engine.hermesContextConfigLoadFailed') || 'Load context config failed')
    } finally {
      contextLoading = false
      draw()
    }
    try {
      await loadModelAliasesConfig()
    } catch (err) {
      modelAliasesError = humanizeError(err, t('engine.hermesModelAliasesConfigLoadFailed') || 'Load model aliases config failed')
    } finally {
      modelAliasesLoading = false
      draw()
    }
    try {
      await loadHooksConfig()
    } catch (err) {
      hooksError = humanizeError(err, t('engine.hermesHooksConfigLoadFailed') || 'Load hooks config failed')
    } finally {
      hooksLoading = false
      draw()
    }
    try {
      await loadProviderOverridesConfig()
    } catch (err) {
      providerOverridesError = humanizeError(err, t('engine.hermesProviderOverridesConfigLoadFailed') || 'Load provider override config failed')
    } finally {
      providerOverridesLoading = false
      draw()
    }
    try {
      await loadMcpServersConfig()
    } catch (err) {
      mcpServersError = humanizeError(err, t('engine.hermesMcpServersConfigLoadFailed') || 'Load MCP servers config failed')
    } finally {
      mcpServersLoading = false
      draw()
    }
    try {
      await loadAgentToolsetsConfig()
    } catch (err) {
      agentToolsetsError = humanizeError(err, t('engine.hermesAgentToolsetsConfigLoadFailed') || 'Load agent toolsets config failed')
    } finally {
      agentToolsetsLoading = false
      draw()
    }
    try {
      await loadPlatformToolsetsConfig()
    } catch (err) {
      platformToolsetsError = humanizeError(err, t('engine.hermesPlatformToolsetsConfigLoadFailed') || 'Load platform toolsets config failed')
    } finally {
      platformToolsetsLoading = false
      draw()
    }
    try {
      await loadAgentRuntimeConfig()
    } catch (err) {
      agentRuntimeError = humanizeError(err, t('engine.hermesAgentRuntimeConfigLoadFailed') || 'Load agent runtime config failed')
    } finally {
      agentRuntimeLoading = false
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
      await loadDisplayConfig()
    } catch (err) {
      displayError = humanizeError(err, t('engine.hermesDisplayConfigLoadFailed') || 'Load display config failed')
    } finally {
      displayLoading = false
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
    try {
      await loadKanbanConfig()
    } catch (err) {
      kanbanError = humanizeError(err, t('engine.hermesKanbanConfigLoadFailed') || 'Load Kanban config failed')
    } finally {
      kanbanLoading = false
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
        await loadSessionsMaintenance()
      } catch {}
      try {
        await loadUpdatesConfig()
      } catch {}
      try {
        await loadCompression()
      } catch {}
      try {
        await loadPromptCaching()
      } catch {}
      try {
        await loadOpenrouterCache()
      } catch {}
      try {
        await loadProviderRouting()
      } catch {}
      try {
        await loadAuxiliaryConfig()
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
        await loadCuratorConfig()
      } catch {}
      try {
        await loadQuickCommandsConfig()
      } catch {}
      try {
        await loadModelAliasesConfig()
      } catch {}
      try {
        await loadHooksConfig()
      } catch {}
      try {
        await loadProviderOverridesConfig()
      } catch {}
      try {
        await loadMcpServersConfig()
      } catch {}
      try {
        await loadAgentToolsetsConfig()
      } catch {}
      try {
        await loadPlatformToolsetsConfig()
      } catch {}
      try {
        await loadAgentRuntimeConfig()
      } catch {}
      try {
        await loadUnauthorizedDmConfig()
      } catch {}
      try {
        await loadSecurityConfig()
      } catch {}
      try {
        await loadDisplayConfig()
      } catch {}
      try {
        await loadHumanDelayConfig()
      } catch {}
      try {
        await loadKanbanConfig()
      } catch {}
      try {
        await loadStreaming()
      } catch {}
      try {
        await loadExecutionLimits()
      } catch {}
      try {
        await loadIoSafety()
      } catch {}
      try {
        await loadCheckpoints()
      } catch {}
      try {
        await loadCronConfig()
      } catch {}
      try {
        await loadLoggingConfig()
      } catch {}
      try {
        await loadApprovalsConfig()
      } catch {}
      try {
        await loadPrivacyConfig()
      } catch {}
      try {
        await loadBrowserConfig()
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
      worktreeEnabled: !!el.querySelector('#hm-worktree-enabled')?.checked,
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

  async function saveSessionsMaintenance() {
    const form = {
      sessionsAutoPrune: !!el.querySelector('#hm-sessions-auto-prune')?.checked,
      sessionsRetentionDays: el.querySelector('#hm-sessions-retention-days')?.value || '90',
      sessionsVacuumAfterPrune: !!el.querySelector('#hm-sessions-vacuum-after-prune')?.checked,
      sessionsMinIntervalHours: el.querySelector('#hm-sessions-min-interval-hours')?.value || '24',
      sessionsWriteJsonSnapshots: !!el.querySelector('#hm-sessions-write-json-snapshots')?.checked,
    }
    sessionsMaintenanceSaving = true
    sessionsMaintenanceError = null
    draw()
    try {
      const result = await api.hermesSessionsMaintenanceConfigSave(form)
      sessionsMaintenanceValues = { ...SESSIONS_MAINTENANCE_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesSessionsMaintenanceSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      sessionsMaintenanceError = humanizeError(err, t('engine.hermesSessionsMaintenanceSaveFailed') || 'Save session maintenance config failed')
      toast(sessionsMaintenanceError, 'error')
    } finally {
      sessionsMaintenanceSaving = false
      draw()
    }
  }

  async function saveUpdatesConfig() {
    const form = {
      updatesPreUpdateBackup: !!el.querySelector('#hm-updates-pre-update-backup')?.checked,
      updatesBackupKeep: el.querySelector('#hm-updates-backup-keep')?.value || '5',
    }
    updatesSaving = true
    updatesError = null
    draw()
    try {
      const result = await api.hermesUpdatesConfigSave(form)
      updatesValues = { ...UPDATES_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesUpdatesConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      updatesError = humanizeError(err, t('engine.hermesUpdatesConfigSaveFailed') || 'Save updates config failed')
      toast(updatesError, 'error')
    } finally {
      updatesSaving = false
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

  async function savePromptCaching() {
    const form = {
      promptCacheTtl: el.querySelector('#hm-prompt-cache-ttl')?.value || '5m',
    }
    promptCachingSaving = true
    promptCachingError = null
    draw()
    try {
      const result = await api.hermesPromptCachingConfigSave(form)
      promptCachingValues = { ...PROMPT_CACHING_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesPromptCachingConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      promptCachingError = humanizeError(err, t('engine.hermesPromptCachingConfigSaveFailed') || 'Save prompt caching config failed')
      toast(promptCachingError, 'error')
    } finally {
      promptCachingSaving = false
      draw()
    }
  }

  async function saveOpenrouterCache() {
    const form = {
      openrouterResponseCache: !!el.querySelector('#hm-openrouter-response-cache')?.checked,
      openrouterResponseCacheTtl: el.querySelector('#hm-openrouter-response-cache-ttl')?.value || '300',
    }
    openrouterCacheSaving = true
    openrouterCacheError = null
    draw()
    try {
      const result = await api.hermesOpenrouterCacheConfigSave(form)
      openrouterCacheValues = { ...OPENROUTER_CACHE_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesOpenrouterCacheConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      openrouterCacheError = humanizeError(err, t('engine.hermesOpenrouterCacheConfigSaveFailed') || 'Save OpenRouter cache config failed')
      toast(openrouterCacheError, 'error')
    } finally {
      openrouterCacheSaving = false
      draw()
    }
  }

  async function saveProviderRouting() {
    const form = {
      providerRoutingSort: el.querySelector('#hm-provider-routing-sort')?.value || 'price',
      providerRoutingOnly: el.querySelector('#hm-provider-routing-only')?.value || '',
      providerRoutingIgnore: el.querySelector('#hm-provider-routing-ignore')?.value || '',
      providerRoutingOrder: el.querySelector('#hm-provider-routing-order')?.value || '',
      providerRoutingRequireParameters: !!el.querySelector('#hm-provider-routing-require-parameters')?.checked,
      providerRoutingDataCollection: el.querySelector('#hm-provider-routing-data-collection')?.value || 'allow',
    }
    providerRoutingSaving = true
    providerRoutingError = null
    draw()
    try {
      const result = await api.hermesProviderRoutingConfigSave(form)
      providerRoutingValues = { ...PROVIDER_ROUTING_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesProviderRoutingConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      providerRoutingError = humanizeError(err, t('engine.hermesProviderRoutingConfigSaveFailed') || 'Save provider routing config failed')
      toast(providerRoutingError, 'error')
    } finally {
      providerRoutingSaving = false
      draw()
    }
  }

  async function saveAuxiliaryConfig() {
    const form = {
      auxiliaryVisionProvider: el.querySelector('#hm-auxiliary-vision-provider')?.value || 'auto',
      auxiliaryVisionModel: el.querySelector('#hm-auxiliary-vision-model')?.value || '',
      auxiliaryVisionTimeout: el.querySelector('#hm-auxiliary-vision-timeout')?.value || '30',
      auxiliaryVisionDownloadTimeout: el.querySelector('#hm-auxiliary-vision-download-timeout')?.value || '30',
      auxiliaryWebExtractProvider: el.querySelector('#hm-auxiliary-web-extract-provider')?.value || 'auto',
      auxiliaryWebExtractModel: el.querySelector('#hm-auxiliary-web-extract-model')?.value || '',
      auxiliarySessionSearchProvider: el.querySelector('#hm-auxiliary-session-search-provider')?.value || 'auto',
      auxiliarySessionSearchModel: el.querySelector('#hm-auxiliary-session-search-model')?.value || '',
      auxiliarySessionSearchTimeout: el.querySelector('#hm-auxiliary-session-search-timeout')?.value || '30',
      auxiliarySessionSearchMaxConcurrency: el.querySelector('#hm-auxiliary-session-search-max-concurrency')?.value || '3',
    }
    auxiliarySaving = true
    auxiliaryError = null
    draw()
    try {
      const result = await api.hermesAuxiliaryConfigSave(form)
      auxiliaryValues = { ...AUXILIARY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesAuxiliaryConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      auxiliaryError = humanizeError(err, t('engine.hermesAuxiliaryConfigSaveFailed') || 'Save auxiliary config failed')
      toast(auxiliaryError, 'error')
    } finally {
      auxiliarySaving = false
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
      templateVars: !!el.querySelector('#hm-skills-template-vars')?.checked,
      inlineShell: !!el.querySelector('#hm-skills-inline-shell')?.checked,
      inlineShellTimeout: el.querySelector('#hm-skills-inline-shell-timeout')?.value || '10',
      guardAgentCreated: !!el.querySelector('#hm-skills-guard-agent-created')?.checked,
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

  async function saveCuratorConfig() {
    const form = {
      curatorEnabled: !!el.querySelector('#hm-curator-enabled')?.checked,
      curatorIntervalHours: el.querySelector('#hm-curator-interval-hours')?.value || '168',
      curatorMinIdleHours: el.querySelector('#hm-curator-min-idle-hours')?.value || '2',
      curatorStaleAfterDays: el.querySelector('#hm-curator-stale-after-days')?.value || '30',
      curatorArchiveAfterDays: el.querySelector('#hm-curator-archive-after-days')?.value || '90',
      curatorBackupEnabled: !!el.querySelector('#hm-curator-backup-enabled')?.checked,
      curatorBackupKeep: el.querySelector('#hm-curator-backup-keep')?.value || '5',
    }
    curatorSaving = true
    curatorError = null
    draw()
    try {
      const result = await api.hermesCuratorConfigSave(form)
      curatorValues = { ...CURATOR_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesCuratorConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      curatorError = humanizeError(err, t('engine.hermesCuratorConfigSaveFailed') || 'Save curator config failed')
      toast(curatorError, 'error')
    } finally {
      curatorSaving = false
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

  async function saveModelConfig() {
    const form = {
      modelDefault: el.querySelector('#hm-model-default')?.value || '',
      modelProvider: el.querySelector('#hm-model-provider')?.value || 'auto',
      modelBaseUrl: el.querySelector('#hm-model-base-url')?.value || '',
      modelContextLength: el.querySelector('#hm-model-context-length')?.value || '',
      modelMaxTokens: el.querySelector('#hm-model-max-tokens')?.value || '',
    }
    modelSaving = true
    modelError = null
    draw()
    try {
      const result = await api.hermesModelConfigSave(form)
      modelValues = { ...MODEL_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesModelConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      modelError = humanizeError(err, t('engine.hermesModelConfigSaveFailed') || 'Save model config failed')
      toast(modelError, 'error')
    } finally {
      modelSaving = false
      draw()
    }
  }

  async function saveModelCatalogConfig() {
    const form = {
      modelCatalogEnabled: !!el.querySelector('#hm-model-catalog-enabled')?.checked,
      modelCatalogUrl: el.querySelector('#hm-model-catalog-url')?.value || MODEL_CATALOG_DEFAULTS.modelCatalogUrl,
      modelCatalogTtlHours: el.querySelector('#hm-model-catalog-ttl-hours')?.value || '24',
      modelCatalogProvidersJson: el.querySelector('#hm-model-catalog-providers-json')?.value || '{}',
    }
    modelCatalogSaving = true
    modelCatalogError = null
    draw()
    try {
      const result = await api.hermesModelCatalogConfigSave(form)
      modelCatalogValues = { ...MODEL_CATALOG_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesModelCatalogConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      modelCatalogError = humanizeError(err, t('engine.hermesModelCatalogConfigSaveFailed') || 'Save model catalog config failed')
      toast(modelCatalogError, 'error')
    } finally {
      modelCatalogSaving = false
      draw()
    }
  }

  async function saveXSearchConfig() {
    const form = {
      xSearchModel: el.querySelector('#hm-x-search-model')?.value || X_SEARCH_DEFAULTS.xSearchModel,
      xSearchTimeoutSeconds: el.querySelector('#hm-x-search-timeout-seconds')?.value || String(X_SEARCH_DEFAULTS.xSearchTimeoutSeconds),
      xSearchRetries: el.querySelector('#hm-x-search-retries')?.value || String(X_SEARCH_DEFAULTS.xSearchRetries),
    }
    xSearchSaving = true
    xSearchError = null
    draw()
    try {
      const result = await api.hermesXSearchConfigSave(form)
      xSearchValues = { ...X_SEARCH_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesXSearchConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      xSearchError = humanizeError(err, t('engine.hermesXSearchConfigSaveFailed') || 'Save X search config failed')
      toast(xSearchError, 'error')
    } finally {
      xSearchSaving = false
      draw()
    }
  }

  async function saveContextConfig() {
    const form = {
      contextEngine: el.querySelector('#hm-context-engine')?.value || CONTEXT_DEFAULTS.contextEngine,
    }
    contextSaving = true
    contextError = null
    draw()
    try {
      const result = await api.hermesContextConfigSave(form)
      contextValues = { ...CONTEXT_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesContextConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      contextError = humanizeError(err, t('engine.hermesContextConfigSaveFailed') || 'Save context config failed')
      toast(contextError, 'error')
    } finally {
      contextSaving = false
      draw()
    }
  }

  async function saveModelAliasesConfig() {
    const form = {
      modelAliasesJson: el.querySelector('#hm-model-aliases-json')?.value || '{}',
    }
    modelAliasesSaving = true
    modelAliasesError = null
    draw()
    try {
      const result = await api.hermesModelAliasesConfigSave(form)
      modelAliasesValues = { ...MODEL_ALIASES_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesModelAliasesConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      modelAliasesError = humanizeError(err, t('engine.hermesModelAliasesConfigSaveFailed') || 'Save model aliases config failed')
      toast(modelAliasesError, 'error')
    } finally {
      modelAliasesSaving = false
      draw()
    }
  }

  async function saveHooksConfig() {
    const form = {
      hooksAutoAccept: !!el.querySelector('#hm-hooks-auto-accept')?.checked,
      hooksJson: el.querySelector('#hm-hooks-json')?.value || '{}',
    }
    hooksSaving = true
    hooksError = null
    draw()
    try {
      const result = await api.hermesHooksConfigSave(form)
      hooksValues = { ...HOOKS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesHooksConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      hooksError = humanizeError(err, t('engine.hermesHooksConfigSaveFailed') || 'Save hooks config failed')
      toast(hooksError, 'error')
    } finally {
      hooksSaving = false
      draw()
    }
  }

  async function saveProviderOverridesConfig() {
    const form = {
      providerOverridesJson: el.querySelector('#hm-provider-overrides-json')?.value || '{}',
    }
    providerOverridesSaving = true
    providerOverridesError = null
    draw()
    try {
      const result = await api.hermesProviderOverridesConfigSave(form)
      providerOverridesValues = { ...PROVIDER_OVERRIDES_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesProviderOverridesConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      providerOverridesError = humanizeError(err, t('engine.hermesProviderOverridesConfigSaveFailed') || 'Save provider override config failed')
      toast(providerOverridesError, 'error')
    } finally {
      providerOverridesSaving = false
      draw()
    }
  }

  async function saveMcpServersConfig() {
    const form = {
      mcpServersJson: el.querySelector('#hm-mcp-servers-json')?.value || '{}',
    }
    mcpServersSaving = true
    mcpServersError = null
    draw()
    try {
      const result = await api.hermesMcpServersConfigSave(form)
      mcpServersValues = { ...MCP_SERVERS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesMcpServersConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      mcpServersError = humanizeError(err, t('engine.hermesMcpServersConfigSaveFailed') || 'Save MCP servers config failed')
      toast(mcpServersError, 'error')
    } finally {
      mcpServersSaving = false
      draw()
    }
  }

  async function saveAgentToolsetsConfig() {
    const form = {
      disabledToolsets: el.querySelector('#hm-agent-disabled-toolsets')?.value || '',
    }
    agentToolsetsSaving = true
    agentToolsetsError = null
    draw()
    try {
      const result = await api.hermesAgentToolsetsConfigSave(form)
      agentToolsetsValues = { ...AGENT_TOOLSETS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesAgentToolsetsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      agentToolsetsError = humanizeError(err, t('engine.hermesAgentToolsetsConfigSaveFailed') || 'Save agent toolsets config failed')
      toast(agentToolsetsError, 'error')
    } finally {
      agentToolsetsSaving = false
      draw()
    }
  }

  async function savePlatformToolsetsConfig() {
    const form = {
      platformToolsetsJson: el.querySelector('#hm-platform-toolsets-json')?.value || '{}',
    }
    platformToolsetsSaving = true
    platformToolsetsError = null
    draw()
    try {
      const result = await api.hermesPlatformToolsetsConfigSave(form)
      platformToolsetsValues = { ...PLATFORM_TOOLSETS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesPlatformToolsetsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      platformToolsetsError = humanizeError(err, t('engine.hermesPlatformToolsetsConfigSaveFailed') || 'Save platform toolsets config failed')
      toast(platformToolsetsError, 'error')
    } finally {
      platformToolsetsSaving = false
      draw()
    }
  }

  async function saveAgentRuntimeConfig() {
    const form = {
      agentMaxTurns: el.querySelector('#hm-agent-max-turns')?.value || '90',
      gatewayTimeout: el.querySelector('#hm-agent-gateway-timeout')?.value || '1800',
      restartDrainTimeout: el.querySelector('#hm-agent-restart-drain-timeout')?.value || '180',
      apiMaxRetries: el.querySelector('#hm-agent-api-max-retries')?.value || '3',
      gatewayTimeoutWarning: el.querySelector('#hm-agent-gateway-timeout-warning')?.value || '900',
      clarifyTimeout: el.querySelector('#hm-agent-clarify-timeout')?.value || '600',
      gatewayNotifyInterval: el.querySelector('#hm-agent-gateway-notify-interval')?.value || '180',
      gatewayAutoContinueFreshness: el.querySelector('#hm-agent-gateway-auto-continue-freshness')?.value || '3600',
      imageInputMode: el.querySelector('#hm-agent-image-input-mode')?.value || 'auto',
      reasoningEffort: el.querySelector('#hm-agent-reasoning-effort')?.value || 'medium',
      agentVerbose: !!el.querySelector('#hm-agent-verbose')?.checked,
      personalitiesJson: el.querySelector('#hm-agent-personalities-json')?.value || '{}',
    }
    agentRuntimeSaving = true
    agentRuntimeError = null
    draw()
    try {
      const result = await api.hermesAgentRuntimeConfigSave(form)
      agentRuntimeValues = { ...AGENT_RUNTIME_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesAgentRuntimeConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      agentRuntimeError = humanizeError(err, t('engine.hermesAgentRuntimeConfigSaveFailed') || 'Save agent runtime config failed')
      toast(agentRuntimeError, 'error')
    } finally {
      agentRuntimeSaving = false
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

  async function saveDisplayConfig() {
    const form = {
      displayToolProgress: el.querySelector('#hm-display-tool-progress')?.value || 'all',
      displayCompact: !!el.querySelector('#hm-display-compact')?.checked,
      displaySkin: el.querySelector('#hm-display-skin')?.value || 'default',
      displayToolPrefix: el.querySelector('#hm-display-tool-prefix')?.value || '┊',
      displayShowReasoning: !!el.querySelector('#hm-display-show-reasoning')?.checked,
      displayToolPreviewLength: el.querySelector('#hm-display-tool-preview-length')?.value || '0',
      displayCleanupProgress: !!el.querySelector('#hm-display-cleanup-progress')?.checked,
      displayToolProgressCommand: !!el.querySelector('#hm-display-tool-progress-command')?.checked,
      displayInterimAssistantMessages: !!el.querySelector('#hm-display-interim-assistant-messages')?.checked,
      displayRuntimeFooterEnabled: !!el.querySelector('#hm-display-runtime-footer-enabled')?.checked,
      displayRuntimeFooterFields: el.querySelector('#hm-display-runtime-footer-fields')?.value || 'model\ncontext_pct\ncwd',
      displayFileMutationVerifier: !!el.querySelector('#hm-display-file-mutation-verifier')?.checked,
      displayShowCost: !!el.querySelector('#hm-display-show-cost')?.checked,
      dashboardShowTokenAnalytics: !!el.querySelector('#hm-dashboard-show-token-analytics')?.checked,
      displayLanguage: el.querySelector('#hm-display-language')?.value || 'en',
      displayResumeDisplay: el.querySelector('#hm-display-resume-display')?.value || 'full',
      displayBusyInputMode: el.querySelector('#hm-display-busy-input-mode')?.value || 'interrupt',
      displayBackgroundProcessNotifications: el.querySelector('#hm-display-background-process-notifications')?.value || 'all',
      displayFinalResponseMarkdown: el.querySelector('#hm-display-final-response-markdown')?.value || 'strip',
      displayTimestamps: !!el.querySelector('#hm-display-timestamps')?.checked,
      displayBellOnComplete: !!el.querySelector('#hm-display-bell-on-complete')?.checked,
      displayPersistentOutput: !!el.querySelector('#hm-display-persistent-output')?.checked,
      displayPersistentOutputMaxLines: el.querySelector('#hm-display-persistent-output-max-lines')?.value || '200',
      displayInlineDiffs: !!el.querySelector('#hm-display-inline-diffs')?.checked,
      displayTuiAutoResumeRecent: !!el.querySelector('#hm-display-tui-auto-resume-recent')?.checked,
      displayTuiStatusIndicator: el.querySelector('#hm-display-tui-status-indicator')?.value || 'kaomoji',
      displayUserMessagePreviewFirstLines: el.querySelector('#hm-display-user-message-preview-first-lines')?.value || '2',
      displayUserMessagePreviewLastLines: el.querySelector('#hm-display-user-message-preview-last-lines')?.value || '2',
      displayEphemeralSystemTtl: el.querySelector('#hm-display-ephemeral-system-ttl')?.value || '0',
      displayCopyShortcut: el.querySelector('#hm-display-copy-shortcut')?.value || 'auto',
    }
    displaySaving = true
    displayError = null
    draw()
    try {
      const result = await api.hermesDisplayConfigSave(form)
      displayValues = { ...DISPLAY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesDisplayConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      displayError = humanizeError(err, t('engine.hermesDisplayConfigSaveFailed') || 'Save display config failed')
      toast(displayError, 'error')
    } finally {
      displaySaving = false
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

  async function saveKanbanConfig() {
    const form = {
      dispatchInGateway: el.querySelector('#hm-kanban-dispatch-in-gateway')?.checked ?? true,
      dispatchIntervalSeconds: el.querySelector('#hm-kanban-dispatch-interval-seconds')?.value || '60',
      maxSpawn: el.querySelector('#hm-kanban-max-spawn')?.value || '0',
      maxInProgress: el.querySelector('#hm-kanban-max-in-progress')?.value || '0',
      failureLimit: el.querySelector('#hm-kanban-failure-limit')?.value || '2',
      autoDecompose: el.querySelector('#hm-kanban-auto-decompose')?.checked ?? true,
      autoDecomposePerTick: el.querySelector('#hm-kanban-auto-decompose-per-tick')?.value || '3',
      workerLogRotateBytes: el.querySelector('#hm-kanban-worker-log-rotate-bytes')?.value || '2097152',
      workerLogBackupCount: el.querySelector('#hm-kanban-worker-log-backup-count')?.value || '1',
      orchestratorProfile: el.querySelector('#hm-kanban-orchestrator-profile')?.value || '',
      defaultAssignee: el.querySelector('#hm-kanban-default-assignee')?.value || '',
      dispatchStaleTimeoutSeconds: el.querySelector('#hm-kanban-dispatch-stale-timeout-seconds')?.value || '14400',
    }
    kanbanSaving = true
    kanbanError = null
    draw()
    try {
      const result = await api.hermesKanbanConfigSave(form)
      kanbanValues = { ...KANBAN_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesKanbanConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      kanbanError = humanizeError(err, t('engine.hermesKanbanConfigSaveFailed') || 'Save Kanban config failed')
      toast(kanbanError, 'error')
    } finally {
      kanbanSaving = false
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
      delegationModel: el.querySelector('#hm-delegation-model')?.value || '',
      delegationProvider: el.querySelector('#hm-delegation-provider')?.value || '',
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

  async function saveIoSafety() {
    const form = {
      fileReadMaxChars: el.querySelector('#hm-file-read-max-chars')?.value || '100000',
      toolOutputMaxBytes: el.querySelector('#hm-tool-output-max-bytes')?.value || '50000',
      toolOutputMaxLines: el.querySelector('#hm-tool-output-max-lines')?.value || '2000',
      toolOutputMaxLineLength: el.querySelector('#hm-tool-output-max-line-length')?.value || '2000',
    }
    ioSafetySaving = true
    ioSafetyError = null
    draw()
    try {
      const result = await api.hermesIoSafetyConfigSave(form)
      ioSafetyValues = { ...IO_SAFETY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesIoSafetySaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      ioSafetyError = humanizeError(err, t('engine.hermesIoSafetySaveFailed') || 'Save input/output safety config failed')
      toast(ioSafetyError, 'error')
    } finally {
      ioSafetySaving = false
      draw()
    }
  }

  async function saveCheckpoints() {
    const form = {
      checkpointsEnabled: !!el.querySelector('#hm-checkpoints-enabled')?.checked,
      checkpointMaxSnapshots: el.querySelector('#hm-checkpoints-max-snapshots')?.value || '20',
      checkpointMaxTotalSizeMb: el.querySelector('#hm-checkpoints-max-total-size-mb')?.value || '500',
      checkpointMaxFileSizeMb: el.querySelector('#hm-checkpoints-max-file-size-mb')?.value || '10',
      checkpointAutoPrune: !!el.querySelector('#hm-checkpoints-auto-prune')?.checked,
      checkpointRetentionDays: el.querySelector('#hm-checkpoints-retention-days')?.value || '7',
      checkpointDeleteOrphans: !!el.querySelector('#hm-checkpoints-delete-orphans')?.checked,
      checkpointMinIntervalHours: el.querySelector('#hm-checkpoints-min-interval-hours')?.value || '24',
    }
    checkpointsSaving = true
    checkpointsError = null
    draw()
    try {
      const result = await api.hermesCheckpointsConfigSave(form)
      checkpointsValues = { ...CHECKPOINTS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesCheckpointsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      checkpointsError = humanizeError(err, t('engine.hermesCheckpointsConfigSaveFailed') || 'Save checkpoints config failed')
      toast(checkpointsError, 'error')
    } finally {
      checkpointsSaving = false
      draw()
    }
  }

  async function saveCronConfig() {
    const form = {
      cronWrapResponse: !!el.querySelector('#hm-cron-wrap-response')?.checked,
      cronMaxParallelJobs: el.querySelector('#hm-cron-max-parallel-jobs')?.value || '0',
    }
    cronSaving = true
    cronError = null
    draw()
    try {
      const result = await api.hermesCronConfigSave(form)
      cronValues = { ...CRON_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesCronConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      cronError = humanizeError(err, t('engine.hermesCronConfigSaveFailed') || 'Save cron config failed')
      toast(cronError, 'error')
    } finally {
      cronSaving = false
      draw()
    }
  }

  async function saveLoggingConfig() {
    const form = {
      loggingLevel: el.querySelector('#hm-logging-level')?.value || 'INFO',
      loggingMaxSizeMb: el.querySelector('#hm-logging-max-size-mb')?.value || '5',
      loggingBackupCount: el.querySelector('#hm-logging-backup-count')?.value || '3',
      loggingMemoryMonitorEnabled: !!el.querySelector('#hm-logging-memory-monitor-enabled')?.checked,
      loggingMemoryMonitorIntervalSeconds: el.querySelector('#hm-logging-memory-monitor-interval-seconds')?.value || '300',
    }
    loggingSaving = true
    loggingError = null
    draw()
    try {
      const result = await api.hermesLoggingConfigSave(form)
      loggingValues = { ...LOGGING_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesLoggingConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      loggingError = humanizeError(err, t('engine.hermesLoggingConfigSaveFailed') || 'Save logging config failed')
      toast(loggingError, 'error')
    } finally {
      loggingSaving = false
      draw()
    }
  }

  async function saveApprovalsConfig() {
    const form = {
      approvalMode: el.querySelector('#hm-approval-mode')?.value || 'manual',
      approvalTimeout: el.querySelector('#hm-approval-timeout')?.value || '60',
      approvalCronMode: el.querySelector('#hm-approval-cron-mode')?.value || 'deny',
      approvalMcpReloadConfirm: !!el.querySelector('#hm-approval-mcp-reload-confirm')?.checked,
      approvalDestructiveSlashConfirm: !!el.querySelector('#hm-approval-destructive-slash-confirm')?.checked,
    }
    approvalsSaving = true
    approvalsError = null
    draw()
    try {
      const result = await api.hermesApprovalsConfigSave(form)
      approvalsValues = { ...APPROVALS_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesApprovalsConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      approvalsError = humanizeError(err, t('engine.hermesApprovalsConfigSaveFailed') || 'Save approvals config failed')
      toast(approvalsError, 'error')
    } finally {
      approvalsSaving = false
      draw()
    }
  }

  async function savePrivacyConfig() {
    const form = {
      redactPii: !!el.querySelector('#hm-privacy-redact-pii')?.checked,
    }
    privacySaving = true
    privacyError = null
    draw()
    try {
      const result = await api.hermesPrivacyConfigSave(form)
      privacyValues = { ...PRIVACY_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesPrivacyConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      privacyError = humanizeError(err, t('engine.hermesPrivacyConfigSaveFailed') || 'Save privacy config failed')
      toast(privacyError, 'error')
    } finally {
      privacySaving = false
      draw()
    }
  }

  async function saveBrowserConfig() {
    const form = {
      browserInactivityTimeout: el.querySelector('#hm-browser-inactivity-timeout')?.value || '120',
      browserCommandTimeout: el.querySelector('#hm-browser-command-timeout')?.value || '30',
      browserRecordSessions: !!el.querySelector('#hm-browser-record-sessions')?.checked,
      browserEngine: el.querySelector('#hm-browser-engine')?.value || 'auto',
      browserAllowPrivateUrls: !!el.querySelector('#hm-browser-allow-private-urls')?.checked,
      browserAutoLocalForPrivateUrls: !!el.querySelector('#hm-browser-auto-local-for-private-urls')?.checked,
      browserCdpUrl: el.querySelector('#hm-browser-cdp-url')?.value || '',
      browserCamofoxManagedPersistence: !!el.querySelector('#hm-browser-camofox-managed-persistence')?.checked,
      browserCamofoxUserId: el.querySelector('#hm-browser-camofox-user-id')?.value || '',
      browserCamofoxSessionKey: el.querySelector('#hm-browser-camofox-session-key')?.value || '',
      browserCamofoxAdoptExistingTab: !!el.querySelector('#hm-browser-camofox-adopt-existing-tab')?.checked,
      browserDialogPolicy: el.querySelector('#hm-browser-dialog-policy')?.value || 'must_respond',
      browserDialogTimeout: el.querySelector('#hm-browser-dialog-timeout')?.value || '300',
    }
    browserSaving = true
    browserError = null
    draw()
    try {
      const result = await api.hermesBrowserConfigSave(form)
      browserValues = { ...BROWSER_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesBrowserConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      browserError = humanizeError(err, t('engine.hermesBrowserConfigSaveFailed') || 'Save browser config failed')
      toast(browserError, 'error')
    } finally {
      browserSaving = false
      draw()
    }
  }

  async function saveWebConfig() {
    const form = {
      webBackend: el.querySelector('#hm-web-backend')?.value || '',
      webSearchBackend: el.querySelector('#hm-web-search-backend')?.value || '',
      webExtractBackend: el.querySelector('#hm-web-extract-backend')?.value || '',
    }
    webSaving = true
    webError = null
    draw()
    try {
      const result = await api.hermesWebConfigSave(form)
      webValues = { ...WEB_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesWebConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      webError = humanizeError(err, t('engine.hermesWebConfigSaveFailed') || 'Save web tool config failed')
      toast(webError, 'error')
    } finally {
      webSaving = false
      draw()
    }
  }

  async function saveLspConfig() {
    const form = {
      lspEnabled: !!el.querySelector('#hm-lsp-enabled')?.checked,
      lspWaitMode: el.querySelector('#hm-lsp-wait-mode')?.value || 'document',
      lspWaitTimeout: el.querySelector('#hm-lsp-wait-timeout')?.value || '5',
      lspInstallStrategy: el.querySelector('#hm-lsp-install-strategy')?.value || 'auto',
    }
    lspSaving = true
    lspError = null
    draw()
    try {
      const result = await api.hermesLspConfigSave(form)
      lspValues = { ...LSP_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesLspConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      lspError = humanizeError(err, t('engine.hermesLspConfigSaveFailed') || 'Save LSP config failed')
      toast(lspError, 'error')
    } finally {
      lspSaving = false
      draw()
    }
  }

  async function saveSttConfig() {
    const form = {
      sttEnabled: !!el.querySelector('#hm-stt-enabled')?.checked,
      sttProvider: el.querySelector('#hm-stt-provider')?.value || 'auto',
      sttLocalModel: el.querySelector('#hm-stt-local-model')?.value || 'base',
      sttLocalLanguage: el.querySelector('#hm-stt-local-language')?.value || '',
      sttOpenaiModel: el.querySelector('#hm-stt-openai-model')?.value || 'whisper-1',
      sttMistralModel: el.querySelector('#hm-stt-mistral-model')?.value || 'voxtral-mini-latest',
    }
    sttSaving = true
    sttError = null
    draw()
    try {
      const result = await api.hermesSttConfigSave(form)
      sttValues = { ...STT_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesSttConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      sttError = humanizeError(err, t('engine.hermesSttConfigSaveFailed') || 'Save speech transcription config failed')
      toast(sttError, 'error')
    } finally {
      sttSaving = false
      draw()
    }
  }

  async function saveTtsVoiceConfig() {
    const form = {
      ttsProvider: el.querySelector('#hm-tts-provider')?.value || 'edge',
      ttsEdgeVoice: el.querySelector('#hm-tts-edge-voice')?.value || '',
      ttsOpenaiModel: el.querySelector('#hm-tts-openai-model')?.value || 'gpt-4o-mini-tts',
      ttsOpenaiVoice: el.querySelector('#hm-tts-openai-voice')?.value || 'alloy',
      ttsElevenlabsVoiceId: el.querySelector('#hm-tts-elevenlabs-voice-id')?.value || '',
      ttsElevenlabsModelId: el.querySelector('#hm-tts-elevenlabs-model-id')?.value || '',
      ttsXaiVoiceId: el.querySelector('#hm-tts-xai-voice-id')?.value || 'eve',
      ttsXaiLanguage: el.querySelector('#hm-tts-xai-language')?.value || 'en',
      ttsXaiSampleRate: el.querySelector('#hm-tts-xai-sample-rate')?.value || '24000',
      ttsXaiBitRate: el.querySelector('#hm-tts-xai-bit-rate')?.value || '128000',
      ttsMistralModel: el.querySelector('#hm-tts-mistral-model')?.value || 'voxtral-mini-tts-2603',
      ttsMistralVoiceId: el.querySelector('#hm-tts-mistral-voice-id')?.value || '',
      ttsPiperVoice: el.querySelector('#hm-tts-piper-voice')?.value || '',
      voiceRecordKey: el.querySelector('#hm-voice-record-key')?.value || '',
      voiceMaxRecordingSeconds: el.querySelector('#hm-voice-max-recording-seconds')?.value || '120',
      voiceAutoTts: !!el.querySelector('#hm-voice-auto-tts')?.checked,
      voiceBeepEnabled: !!el.querySelector('#hm-voice-beep-enabled')?.checked,
      voiceSilenceThreshold: el.querySelector('#hm-voice-silence-threshold')?.value || '200',
      voiceSilenceDuration: el.querySelector('#hm-voice-silence-duration')?.value || '3',
    }
    ttsVoiceSaving = true
    ttsVoiceError = null
    draw()
    try {
      const result = await api.hermesTtsVoiceConfigSave(form)
      ttsVoiceValues = { ...TTS_VOICE_DEFAULTS, ...(result?.values || form) }
      await refreshRawAfterStructuredSave()
      const backup = result?.backup || ''
      toast({
        message: t('engine.hermesTtsVoiceConfigSaveSuccess'),
        hint: backup ? t('engine.hermesConfigBackupHint', { path: backup }) : '',
      }, 'success')
    } catch (err) {
      ttsVoiceError = humanizeError(err, t('engine.hermesTtsVoiceConfigSaveFailed') || 'Save speech output config failed')
      toast(ttsVoiceError, 'error')
    } finally {
      ttsVoiceSaving = false
      draw()
    }
  }

  async function saveTerminal() {
    const form = {
      terminalBackend: el.querySelector('#hm-terminal-backend')?.value || 'local',
      terminalCwd: el.querySelector('#hm-terminal-cwd')?.value || '.',
      terminalTimeout: el.querySelector('#hm-terminal-timeout')?.value || '180',
      terminalLifetimeSeconds: el.querySelector('#hm-terminal-lifetime-seconds')?.value || '300',
      terminalShellInitFiles: el.querySelector('#hm-terminal-shell-init-files')?.value || '',
      terminalAutoSourceBashrc: !!el.querySelector('#hm-terminal-auto-source-bashrc')?.checked,
      terminalPersistentShell: !!el.querySelector('#hm-terminal-persistent-shell')?.checked,
      terminalEnvPassthrough: el.querySelector('#hm-terminal-env-passthrough')?.value || '',
      terminalDockerMountCwdToWorkspace: !!el.querySelector('#hm-terminal-docker-mount-cwd-to-workspace')?.checked,
        terminalDockerRunAsHostUser: !!el.querySelector('#hm-terminal-docker-run-as-host-user')?.checked,
        terminalDockerImage: el.querySelector('#hm-terminal-docker-image')?.value || '',
        terminalDockerForwardEnv: el.querySelector('#hm-terminal-docker-forward-env')?.value || '',
        terminalDockerEnvJson: el.querySelector('#hm-terminal-docker-env-json')?.value || '{}',
        terminalDockerVolumes: el.querySelector('#hm-terminal-docker-volumes')?.value || '',
        terminalDockerExtraArgs: el.querySelector('#hm-terminal-docker-extra-args')?.value || '',
        terminalSingularityImage: el.querySelector('#hm-terminal-singularity-image')?.value || '',
      terminalModalImage: el.querySelector('#hm-terminal-modal-image')?.value || '',
      terminalModalMode: el.querySelector('#hm-terminal-modal-mode')?.value || 'auto',
      terminalVercelRuntime: el.querySelector('#hm-terminal-vercel-runtime')?.value || 'node24',
      terminalDaytonaImage: el.querySelector('#hm-terminal-daytona-image')?.value || '',
      terminalSshHost: el.querySelector('#hm-terminal-ssh-host')?.value || '',
      terminalSshUser: el.querySelector('#hm-terminal-ssh-user')?.value || '',
      terminalSshPort: el.querySelector('#hm-terminal-ssh-port')?.value || '22',
      terminalSshKey: el.querySelector('#hm-terminal-ssh-key')?.value || '',
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
