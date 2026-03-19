/**
 * 聊天页面 - 完整版，对接 OpenClaw Gateway
 * 支持：流式响应、Markdown 渲染、会话管理、Agent 选择、快捷指令
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { navigate } from '../router.js'
import { wsClient, uuid } from '../lib/ws-client.js'
import { renderMarkdown } from '../lib/markdown.js'
import { buildPrefixHeights, findStartIndex, getSpacerHeights } from '../lib/virtual-scroll.js'
import { saveMessage, saveMessages, getLocalMessages, isStorageAvailable } from '../lib/message-db.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm, showContentModal } from '../components/modal.js'
import { icon as svgIcon } from '../lib/icons.js'
import { callAIWithTools, getEnabledTools } from '../lib/assistant-core.js'
import { OPENCLAW_KB } from '../lib/openclaw-kb.js'
import {
  HOSTED_DEFAULTS,
  HOSTED_FIXED_SYSTEM_PROMPT,
  HOSTED_GLOBAL_KEY,
  HOSTED_RUNTIME_DEFAULT,
  HOSTED_SESSIONS_KEY,
  HOSTED_STATUS,
  extractHostedAskUser,
  extractHostedInstruction,
  formatHostedActionLabel,
  parseHostedResponse,
  renderHostedTemplate,
} from '../lib/hosted-agent.js'
import {
  applyHostedDisconnectedPause,
  buildHostedTargetHash,
  prepareHostedRunTrigger,
  resumeHostedAfterReconnect,
  shouldAutoTriggerHostedRun,
  shouldPauseHostedForDisconnect,
} from '../lib/hosted-runtime-service.js'
import {
  buildHostedMessages as buildHostedMessagesCore,
  buildSeededHostedHistory,
  normalizeHostedRole,
  pushHostedHistoryEntry as pushHostedHistoryEntryCore,
  shouldCaptureHostedTarget as shouldCaptureHostedTargetCore,
} from '../lib/hosted-history-service.js'
import {
  applyHostedSelfStop,
  applyHostedStepFailure,
  applyHostedStepSuccess,
  applyHostedTemplateError,
  beginHostedStep,
  getHostedStepDelay,
  markHostedGenerating,
  validateHostedStepStart,
} from '../lib/hosted-step-service.js'
import {
  buildHostedOptimisticUserMessage,
  prepareHostedOutput,
} from '../lib/hosted-output-service.js'
import {
  buildHistoryEntryKey,
  buildHistoryHash,
  extractHistoryMessages,
  maxHistoryTimestamp,
  normalizeHistoryPayload,
} from '../lib/history-domain.js'
import {
  toHostedSeedHistory,
  toStoredHistoryMessages,
} from '../lib/history-view-model.js'
import {
  appendOmittedImagesNotice,
  renderHistoryList,
  renderIncrementalHistoryList,
} from '../lib/history-render-service.js'
import {
  renderLocalHistoryMessages,
  takePendingHistoryPayload,
} from '../lib/history-loader-service.js'
import {
  seedHostedHistoryIfNeeded,
  updateHistoryApplyState,
} from '../lib/history-apply-service.js'

const RENDER_THROTTLE = 30
const STORAGE_SESSION_KEY = 'clawpanel-last-session'
const STORAGE_MODEL_KEY = 'clawpanel-chat-selected-model'
const STORAGE_SIDEBAR_KEY = 'clawpanel-chat-sidebar-open'
const STORAGE_SESSION_NAMES_KEY = 'clawpanel-chat-session-names'

const HOSTED_CONTEXT_MAX = 100
const HOSTED_CONTEXT_TOKEN_LIMIT = 200000
const HOSTED_RECONNECT_GRACE_MS = 12000
let _hostedSeeded = false

const COMMANDS = [
  { title: '会话', commands: [
    { cmd: '/new', desc: '新建会话', action: 'exec' },
    { cmd: '/reset', desc: '重置当前会话', action: 'exec' },
    { cmd: '/stop', desc: '停止生成', action: 'exec' },
  ]},
  { title: '模型', commands: [
    { cmd: '/model ', desc: '切换模型（输入模型名）', action: 'fill' },
    { cmd: '/model list', desc: '查看可用模型', action: 'exec' },
    { cmd: '/model status', desc: '当前模型状态', action: 'exec' },
  ]},
  { title: '思考模式', commands: [
    { cmd: '/think off', desc: '关闭深度思考', action: 'exec' },
    { cmd: '/think low', desc: '轻度思考', action: 'exec' },
    { cmd: '/think medium', desc: '中度思考', action: 'exec' },
    { cmd: '/think high', desc: '深度思考', action: 'exec' },
  ]},
  { title: '快速模式', commands: [
    { cmd: '/fast', desc: '切换快速模式（开/关）', action: 'exec' },
    { cmd: '/fast on', desc: '开启快速模式（低延迟）', action: 'exec' },
    { cmd: '/fast off', desc: '关闭快速模式', action: 'exec' },
  ]},
  { title: '详细/推理', commands: [
    { cmd: '/verbose off', desc: '关闭详细模式', action: 'exec' },
    { cmd: '/verbose low', desc: '低详细度', action: 'exec' },
    { cmd: '/verbose high', desc: '高详细度', action: 'exec' },
    { cmd: '/reasoning off', desc: '关闭推理模式', action: 'exec' },
    { cmd: '/reasoning low', desc: '轻度推理', action: 'exec' },
    { cmd: '/reasoning medium', desc: '中度推理', action: 'exec' },
    { cmd: '/reasoning high', desc: '深度推理', action: 'exec' },
  ]},
  { title: '信息', commands: [
    { cmd: '/help', desc: '帮助信息', action: 'exec' },
    { cmd: '/status', desc: '系统状态', action: 'exec' },
    { cmd: '/context', desc: '上下文信息', action: 'exec' },
  ]},
]

let _sessionKey = null, _page = null, _messagesEl = null, _textarea = null
let _sendBtn = null, _statusDot = null, _typingEl = null, _scrollBtn = null
let _sessionListEl = null, _cmdPanelEl = null, _attachPreviewEl = null, _fileInputEl = null, _attachBtnEl = null
let _modelSelectEl = null
let _hostedBtn = null, _hostedPanelEl = null, _hostedBadgeEl = null
let _hostedPromptEl = null, _hostedEnableEl = null, _hostedMaxStepsEl = null, _hostedContextLimitEl = null
let _hostedSaveBtn = null, _hostedPauseBtn = null, _hostedStopBtn = null, _hostedCloseBtn = null
let _hostedGlobalSyncEl = null
let _hostedDefaults = null
let _hostedSessionConfig = null
let _hostedRuntime = { ...HOSTED_RUNTIME_DEFAULT }
let _hostedAutoTimer = null
let _hostedDisconnectTimer = null
let _hostedLastTargetTs = 0
let _hostedLastTargetHash = ''
let _hostedBusy = false
let _hostedAbort = null
let _hostedLastCompletionRunId = ''
let _hostedLastSentHash = ''
const _hostedHistoryRefreshKeys = new Set()
const _hostedStates = new Map()
let _askUserBlockedNotice = false
const _askUserToolHandled = new Set()
let _currentAiBubble = null, _currentAiText = '', _currentAiImages = [], _currentAiVideos = [], _currentAiAudios = [], _currentAiFiles = [], _currentAiTools = [], _currentRunId = null
let _isStreaming = false, _isSending = false, _messageQueue = [], _streamStartTime = 0
let _lastRenderTime = 0, _renderPending = false
let _isLoadingHistory = false

const VIRTUAL_WINDOW = 40
const VIRTUAL_OVERSCAN = 20
let _virtualEnabled = false
let _virtualHeights = new Map()
let _virtualAvgHeight = 64
let _virtualRange = { start: 0, end: 0, prefix: [] }
let _virtualItems = []
let _virtualPrefix = [0]
let _virtualPrefixDirty = true
let _virtualTopSpacer = null
let _virtualBottomSpacer = null
let _virtualRenderPending = false
let _virtualObserver = null

let _streamSafetyTimer = null, _unsubEvent = null, _unsubReady = null, _unsubStatus = null
let _pageActive = false
const _sessionStates = new Map()
let _errorTimer = null, _lastErrorMsg = null
let _attachments = []

function _normalizeSessionKey(key) {
  if (typeof key === 'string' && key.trim()) return key.trim()
  if (_sessionKey) return _sessionKey
  return 'default'
}

function getSessionState(sessionKey) {
  const key = _normalizeSessionKey(sessionKey)
  if (!_sessionStates.has(key)) {
    _sessionStates.set(key, {
      lastHistoryHash: '',
      lastHistoryAppliedTs: 0,
      pendingHistoryPayload: null,
      pendingHistoryTs: 0,
      seenRunIds: new Set(),
      toolEventTimes: new Map(),
      toolEventData: new Map(),
      toolRunIndex: new Map(),
      toolEventSeen: new Set(),
    })
  }
  return _sessionStates.get(key)
}

function clearHostedDisconnectTimer() {
  if (_hostedDisconnectTimer) {
    clearTimeout(_hostedDisconnectTimer)
    _hostedDisconnectTimer = null
  }
}

function pauseHostedForDisconnect(reason = 'disconnected') {
  if (!shouldPauseHostedForDisconnect(_hostedSessionConfig, _hostedRuntime)) return
  clearHostedDisconnectTimer()
  _hostedDisconnectTimer = setTimeout(() => {
    _hostedDisconnectTimer = null
    if (!wsClient.gatewayReady && _hostedSessionConfig?.enabled) {
      applyHostedDisconnectedPause(_hostedRuntime)
      persistHostedRuntime()
      updateHostedBadge()
      markHostedHistoryStale()
      updateHostedInputLock()
    }
  }, HOSTED_RECONNECT_GRACE_MS)
}

function resumeHostedFromReconnect() {
  clearHostedDisconnectTimer()
  const resumed = resumeHostedAfterReconnect(_hostedSessionConfig, _hostedRuntime)
  if (resumed) {
    persistHostedRuntime()
    updateHostedBadge()
    refreshHostedHistoryIfNeeded({ limit: 100, force: true })
  }
  updateHostedInputLock()
}

let _hasEverConnected = false
let _availableModels = []
let _primaryModel = ''
let _selectedModel = ''
let _isApplyingModel = false

export async function render() {
  const page = document.createElement('div')
  page.className = 'page chat-page'
  _pageActive = true
  _page = page

  page.innerHTML = `
    <div class="chat-sidebar" id="chat-sidebar">
      <div class="chat-sidebar-header">
        <span>会话列表</span>
        <div class="chat-sidebar-header-actions">
          <button class="chat-sidebar-btn" id="btn-toggle-sidebar" title="会话列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <button class="chat-sidebar-btn" id="btn-new-session" title="新建会话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        </div>
      </div>
      <div class="chat-session-list" id="chat-session-list"></div>
    </div>
    <div class="chat-main">
      <div class="chat-header">
        <div class="chat-status">
          <button class="chat-toggle-sidebar" id="btn-toggle-sidebar-main" title="会话列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span class="status-dot" id="chat-status-dot"></span>
          <span class="chat-title" id="chat-title">聊天</span>
        </div>
        <div class="chat-header-actions">
          <div class="chat-model-group" style="display:flex;align-items:center;gap:6px;min-width:0">
            <select class="form-input" id="chat-model-select" title="切换当前会话模型" style="width:auto;min-width:160px;max-width:28vw;flex:1 1 auto;padding:6px 10px;font-size:var(--font-size-xs)">
              <option value="">加载模型中...</option>
            </select>
            <button class="btn btn-sm btn-ghost" id="btn-refresh-models" title="刷新模型列表" style="flex:0 0 auto">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>
          </div>
          <button class="btn btn-sm btn-ghost" id="btn-cmd" title="快捷指令">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z"/></svg>
          </button>
          <button class="btn btn-sm btn-ghost" id="btn-reset-session" title="重置会话">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          </button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="typing-indicator" id="typing-indicator" style="display:none">
          <span></span><span></span><span></span>
        </div>
      </div>
      <button class="chat-scroll-btn" id="chat-scroll-btn" style="display:none">↓</button>
      <div class="chat-cmd-panel" id="chat-cmd-panel" style="display:none"></div>
      <div class="chat-attachments-preview" id="chat-attachments-preview" style="display:none"></div>
      <div class="chat-input-area">
        <input type="file" id="chat-file-input" accept="image/*" multiple style="display:none">
        <button class="chat-attach-btn" id="chat-attach-btn" title="上传图片">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div class="chat-input-wrapper">
          <textarea id="chat-input" rows="1" placeholder="输入消息，Enter 发送，/ 打开指令"></textarea>
        </div>
        <button class="chat-send-btn" id="chat-send-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
        <button class="chat-hosted-btn" id="chat-hosted-btn" title="托管 Agent">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
          <span class="chat-hosted-label">托管</span>
          <span class="chat-hosted-badge" id="chat-hosted-badge">未启用</span>
        </button>
      </div>
      <div class="hosted-agent-panel" id="hosted-agent-panel" style="display:none">
        <div class="hosted-agent-header">
          <div class="hosted-agent-title">托管 Agent</div>
          <button class="hosted-agent-close" id="hosted-agent-close" title="关闭">×</button>
        </div>
        <div class="hosted-agent-body">
          <div class="form-group">
            <label class="form-label">初始提示词</label>
            <textarea class="form-input hosted-agent-prompt" id="hosted-agent-prompt" rows="3" placeholder="请输入托管 Agent 的初始提示词..." ></textarea>
            <div class="form-hint">托管 Agent 仅基于该提示词 + 对面回复自动生成下一步指令</div>
          </div>
          <label class="hosted-agent-switch">
            <span>启用托管 Agent</span>
            <input type="checkbox" id="hosted-agent-enabled">
            <span class="hosted-agent-track"></span>
          </label>
          <div class="hosted-agent-row">
            <div class="hosted-agent-tag">运行模式</div>
            <div class="hosted-agent-value">对面回复后自动继续</div>
          </div>
          <div class="hosted-agent-row">
            <div class="hosted-agent-tag">停止策略</div>
            <div class="hosted-agent-value">托管 Agent 自评停止</div>
          </div>
          <div class="hosted-agent-advanced">
            <div class="hosted-agent-advanced-title">高级选项</div>
            <div class="hosted-agent-grid">
              <div class="form-group">
                <label class="form-label">最大步数</label>
                <input class="form-input" id="hosted-agent-max-steps" type="number" min="1" max="200" step="1">
              </div>
              <div class="form-group">
                <label class="form-label">上下文上限 (tokens)</label>
                <input class="form-input" id="hosted-agent-context-limit" type="number" min="1000" max="2000000" step="1000">
              </div>
            </div>
          </div>
          <label class="hosted-agent-switch">
            <span>同步为全局默认</span>
            <input type="checkbox" id="hosted-agent-sync-global">
            <span class="hosted-agent-track"></span>
          </label>
          <div class="hosted-agent-actions">
            <button class="btn btn-primary btn-sm" id="hosted-agent-save">保存并启用</button>
            <button class="btn btn-secondary btn-sm" id="hosted-agent-pause">暂停</button>
            <button class="btn btn-ghost btn-sm" id="hosted-agent-stop">立即停止</button>
          </div>
        </div>
        <div class="hosted-agent-footer" id="hosted-agent-status"></div>
        <div class="hosted-agent-footer" id="hosted-agent-bound"></div>
      </div>
      <div class="chat-disconnect-bar" id="chat-disconnect-bar" style="display:none">连接已断开，正在重连...</div>
      <div class="chat-connect-overlay" id="chat-connect-overlay" style="display:none">
        <div class="chat-connect-card">
          <div class="chat-connect-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"/></svg>
          </div>
          <div class="chat-connect-title">Gateway 连接未就绪</div>
          <div class="chat-connect-desc" id="chat-connect-desc">正在连接 Gateway...</div>
          <div class="chat-connect-actions">
            <button class="btn btn-primary btn-sm" id="btn-fix-connect">修复并重连</button>
            <button class="btn btn-secondary btn-sm" id="btn-goto-gateway">Gateway 设置</button>
          </div>
          <div class="chat-connect-hint">首次使用？请确保 Gateway 已启动，或点击「修复并重连」自动修复配置</div>
        </div>
      </div>
    </div>
  `

  _messagesEl = page.querySelector('#chat-messages')
  _textarea = page.querySelector('#chat-input')
  _sendBtn = page.querySelector('#chat-send-btn')
  _statusDot = page.querySelector('#chat-status-dot')
  _typingEl = page.querySelector('#typing-indicator')
  _scrollBtn = page.querySelector('#chat-scroll-btn')
  _sessionListEl = page.querySelector('#chat-session-list')
  _cmdPanelEl = page.querySelector('#chat-cmd-panel')
  _attachPreviewEl = page.querySelector('#chat-attachments-preview')
  _fileInputEl = page.querySelector('#chat-file-input')
  _attachBtnEl = page.querySelector('#chat-attach-btn')
  _modelSelectEl = page.querySelector('#chat-model-select')
  _hostedBtn = page.querySelector('#chat-hosted-btn')
  _hostedBadgeEl = page.querySelector('#chat-hosted-badge')
  _hostedPanelEl = page.querySelector('#hosted-agent-panel')
  _hostedPromptEl = page.querySelector('#hosted-agent-prompt')
  _hostedEnableEl = page.querySelector('#hosted-agent-enabled')
  _hostedMaxStepsEl = page.querySelector('#hosted-agent-max-steps')
  _hostedContextLimitEl = page.querySelector('#hosted-agent-context-limit')
  _hostedSaveBtn = page.querySelector('#hosted-agent-save')
  _hostedPauseBtn = page.querySelector('#hosted-agent-pause')
  _hostedStopBtn = page.querySelector('#hosted-agent-stop')
  _hostedCloseBtn = page.querySelector('#hosted-agent-close')
  _hostedGlobalSyncEl = page.querySelector('#hosted-agent-sync-global')
  page.querySelector('#chat-sidebar')?.classList.toggle('open', getSidebarOpen())

  bindEvents(page)
  bindConnectOverlay(page)

  // 首次使用引导提示
  showPageGuide(_messagesEl)

  loadHostedDefaults().then(() => {
    loadHostedSessionConfig()
    renderHostedPanel()
    updateHostedBadge()
  })

  loadModelOptions()
  // 非阻塞：先返回 DOM，后台连接 Gateway
  connectGateway()
  return page
}

const GUIDE_KEY = 'clawpanel-guide-chat-dismissed'

function showPageGuide(container) {
  if (localStorage.getItem(GUIDE_KEY)) return
  if (!container || container.querySelector('.chat-page-guide')) return
  const guide = document.createElement('div')
  guide.className = 'chat-page-guide'
  guide.innerHTML = `
    <div class="chat-guide-inner">
      <div class="chat-guide-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
      </div>
      <div class="chat-guide-content">
        <b>你正在使用「实时聊天」</b>
        <p>此页面通过 <b>Gateway</b> 连接 OpenClaw 的 AI Agent，对话由你部署的 OpenClaw 服务处理。</p>
        <p style="opacity:0.7;font-size:11px">如需使用 ClawPanel 内置 AI 助手（独立于 OpenClaw），请前往左侧菜单「AI 助手」页面。</p>
      </div>
      <button class="chat-guide-close" title="知道了">&times;</button>
    </div>
  `
  guide.querySelector('.chat-guide-close').onclick = () => {
    localStorage.setItem(GUIDE_KEY, '1')
    guide.remove()
  }
  container.insertBefore(guide, container.firstChild)
}

// ── 事件绑定 ──

function bindEvents(page) {
  if (_modelSelectEl) {
    _modelSelectEl.addEventListener('change', () => {
      _selectedModel = _modelSelectEl.value
      if (_selectedModel) localStorage.setItem(STORAGE_MODEL_KEY, _selectedModel)
      else localStorage.removeItem(STORAGE_MODEL_KEY)
      applySelectedModel()
    })
  }

  _textarea.addEventListener('input', () => {
    _textarea.style.height = 'auto'
    _textarea.style.height = Math.min(_textarea.scrollHeight, 150) + 'px'
    updateSendState()
    // 输入 / 时显示指令面板
    if (_textarea.value === '/') showCmdPanel()
    else if (!_textarea.value.startsWith('/')) hideCmdPanel()
  })

  _textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
    if (e.key === 'Escape') hideCmdPanel()
  })

  _sendBtn.addEventListener('click', () => {
    if (_hostedSessionConfig?.enabled) { toast('托管 Agent 已启用，用户输入已锁定', 'warning'); return }
    if (_isStreaming) stopGeneration()
    else sendMessage()
  })

  if (_hostedBtn) {
    _hostedBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleHostedPanel()
    })
  }
  if (_hostedCloseBtn) {
    _hostedCloseBtn.addEventListener('click', () => hideHostedPanel())
  }
  if (_hostedSaveBtn) {
    _hostedSaveBtn.addEventListener('click', () => saveHostedConfig())
  }
  if (_hostedPauseBtn) {
    _hostedPauseBtn.addEventListener('click', () => pauseHostedAgent())
  }
  if (_hostedStopBtn) {
    _hostedStopBtn.addEventListener('click', () => stopHostedAgent())
  }

  const toggleSidebar = () => {
    const sidebar = page.querySelector('#chat-sidebar')
    if (!sidebar) return
    const nextOpen = !sidebar.classList.contains('open')
    sidebar.classList.toggle('open', nextOpen)
    setSidebarOpen(nextOpen)
  }
  page.querySelector('#btn-toggle-sidebar')?.addEventListener('click', toggleSidebar)
  page.querySelector('#btn-toggle-sidebar-main')?.addEventListener('click', toggleSidebar)
  page.querySelector('#btn-new-session').addEventListener('click', () => showNewSessionDialog())
  page.querySelector('#btn-cmd').addEventListener('click', () => toggleCmdPanel())
  page.querySelector('#btn-reset-session').addEventListener('click', () => resetCurrentSession())
  page.querySelector('#btn-refresh-models')?.addEventListener('click', () => loadModelOptions(true))

  // 文件上传
  page.querySelector('#chat-attach-btn').addEventListener('click', () => _fileInputEl.click())
  _fileInputEl.addEventListener('change', handleFileSelect)
  // 粘贴图片（Ctrl+V）
  _textarea.addEventListener('paste', handlePaste)

  _messagesEl.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = _messagesEl
    _scrollBtn.style.display = (scrollHeight - scrollTop - clientHeight < 80) ? 'none' : 'flex'
  })
  _scrollBtn.addEventListener('click', () => {
    scrollToBottom(true)
  })
  _messagesEl.addEventListener('click', () => { hideCmdPanel(); hideHostedPanel() })
  _messagesEl.addEventListener('click', (e) => {
    const target = e.target?.closest?.('.msg-spoiler')
    if (!target) return
    if (target.closest('code, pre')) return
    target.classList.toggle('revealed')
  })
}

async function loadModelOptions(showToast = false) {
  if (!_modelSelectEl) return
  // 显示加载状态
  _modelSelectEl.innerHTML = '<option value="">加载模型中...</option>'
  _modelSelectEl.disabled = true
  try {
    invalidate('read_openclaw_config')
    const configPromise = api.readOpenclawConfig()
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('读取超时(8s)，请检查配置文件')), 8000))
    const config = await Promise.race([configPromise, timeoutPromise])
    const providers = config?.models?.providers || {}
    _primaryModel = config?.agents?.defaults?.model?.primary || ''
    const models = []
    const seen = new Set()
    if (_primaryModel) {
      seen.add(_primaryModel)
      models.push(_primaryModel)
    }
    for (const [providerKey, provider] of Object.entries(providers)) {
      for (const item of (provider?.models || [])) {
        const modelId = typeof item === 'string' ? item : item?.id
        if (!modelId) continue
        const full = `${providerKey}/${modelId}`
        if (seen.has(full)) continue
        seen.add(full)
        models.push(full)
      }
    }
    _availableModels = models
    const saved = localStorage.getItem(STORAGE_MODEL_KEY) || ''
    _selectedModel = models.includes(saved) ? saved : (_primaryModel || models[0] || '')
    renderModelSelect()
    if (showToast) toast(`已刷新，共 ${models.length} 个模型`, 'success')
  } catch (e) {
    _availableModels = []
    _primaryModel = ''
    _selectedModel = ''
    renderModelSelect(`加载失败: ${e.message || e}`)
    if (showToast) toast('加载模型失败: ' + (e.message || e), 'error')
  }
}

function renderModelSelect(errorText = '') {
  if (!_modelSelectEl) return
  if (!_availableModels.length) {
    _modelSelectEl.innerHTML = `<option value="">${escapeAttr(errorText || '未配置模型')}</option>`
    _modelSelectEl.disabled = true
    _modelSelectEl.title = errorText || '请先到模型配置页面添加模型'
    return
  }
  _modelSelectEl.disabled = _isApplyingModel
  _modelSelectEl.innerHTML = _availableModels.map(full => {
    const suffix = full === _primaryModel ? '（主模型）' : ''
    return `<option value="${escapeAttr(full)}" ${full === _selectedModel ? 'selected' : ''}>${full}${suffix}</option>`
  }).join('')
  _modelSelectEl.title = _selectedModel ? `切换当前会话模型：${_selectedModel}` : '切换当前会话模型'
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 本地会话别名缓存 */
function getSessionNames() {
  try { return JSON.parse(localStorage.getItem(STORAGE_SESSION_NAMES_KEY) || '{}') } catch { return {} }
}
function setSessionName(key, name) {
  const names = getSessionNames()
  if (name) names[key] = name
  else delete names[key]
  localStorage.setItem(STORAGE_SESSION_NAMES_KEY, JSON.stringify(names))
}
function getDisplayLabel(key) {
  const custom = getSessionNames()[key]
  return custom || parseSessionLabel(key)
}

function getSidebarOpen() {
  return localStorage.getItem(STORAGE_SIDEBAR_KEY) === '1'
}

function setSidebarOpen(open) {
  localStorage.setItem(STORAGE_SIDEBAR_KEY, open ? '1' : '0')
}

async function applySelectedModel() {
  if (!_selectedModel) {
    toast('请先选择模型', 'warning')
    return
  }
  if (!wsClient.gatewayReady || !_sessionKey) {
    toast('Gateway 未就绪，连接成功后再切换模型', 'warning')
    return
  }
  _isApplyingModel = true
  renderModelSelect()
  try {
    await wsClient.chatSend(_sessionKey, `/model ${_selectedModel}`)
    toast(`已切换当前会话模型为 ${_selectedModel}`, 'success')
  } catch (e) {
    toast('切换模型失败: ' + (e.message || e), 'error')
  } finally {
    _isApplyingModel = false
    renderModelSelect()
  }
}

// ── 连接引导遮罩 ──

function bindConnectOverlay(page) {
  const fixBtn = page.querySelector('#btn-fix-connect')
  const gwBtn = page.querySelector('#btn-goto-gateway')

  if (fixBtn) {
    fixBtn.addEventListener('click', async () => {
      fixBtn.disabled = true
      fixBtn.textContent = '修复中...'
      const desc = document.getElementById('chat-connect-desc')
      try {
        if (desc) desc.textContent = '正在写入配置并重载 Gateway...'
        await api.autoPairDevice()
        await api.reloadGateway()
        if (desc) desc.textContent = '修复完成，正在重连...'
        // 断开旧连接，重新发起
        wsClient.disconnect()
        setTimeout(() => connectGateway(), 3000)
      } catch (e) {
        if (desc) desc.textContent = '修复失败: ' + (e.message || e)
      } finally {
        fixBtn.disabled = false
        fixBtn.textContent = '修复并重连'
      }
    })
  }

  if (gwBtn) {
    gwBtn.addEventListener('click', () => navigate('/gateway'))
  }
}

// ── 文件上传 ──

async function handleFileSelect(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return

  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      toast('仅支持图片文件', 'warning')
      continue
    }
    if (file.size > 5 * 1024 * 1024) {
      toast(`${file.name} 超过 5MB 限制`, 'warning')
      continue
    }

    try {
      const base64 = await fileToBase64(file)
      _attachments.push({
        type: 'image',
        mimeType: file.type,
        fileName: file.name,
        content: base64,
      })
      renderAttachments()
    } catch (e) {
      toast(`读取 ${file.name} 失败`, 'error')
    }
  }
  _fileInputEl.value = ''
}

async function handlePaste(e) {
  const items = Array.from(e.clipboardData?.items || [])
  const imageItems = items.filter(item => item.type.startsWith('image/'))
  if (!imageItems.length) return
  e.preventDefault()
  for (const item of imageItems) {
    const file = item.getAsFile()
    if (!file) continue
    if (file.size > 5 * 1024 * 1024) { toast('粘贴的图片超过 5MB 限制', 'warning'); continue }
    try {
      const base64 = await fileToBase64(file)
      _attachments.push({ type: 'image', mimeType: file.type || 'image/png', fileName: `paste-${Date.now()}.png`, content: base64 })
      renderAttachments()
    } catch (_) { toast('读取粘贴图片失败', 'error') }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      const match = /^data:[^;]+;base64,(.+)$/.exec(dataUrl)
      if (!match) { reject(new Error('无效的数据 URL')); return }
      resolve(match[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function renderAttachments() {
  if (!_attachPreviewEl) return
  if (!_attachments.length) {
    _attachPreviewEl.style.display = 'none'
    return
  }
  _attachPreviewEl.style.display = 'flex'
  _attachPreviewEl.innerHTML = _attachments.map((att, idx) => `
    <div class="chat-attachment-item">
      <img src="data:${att.mimeType};base64,${att.content}" alt="${att.fileName}">
      <button class="chat-attachment-del" data-idx="${idx}">×</button>
    </div>
  `).join('')

  _attachPreviewEl.querySelectorAll('.chat-attachment-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx)
      _attachments.splice(idx, 1)
      renderAttachments()
    })
  })
  updateSendState()
}

// ── Gateway 连接 ──

async function connectGateway() {
  try {
    // 清理旧的订阅，避免重复监听
    if (_unsubStatus) { _unsubStatus(); _unsubStatus = null }
    if (_unsubReady) { _unsubReady(); _unsubReady = null }
    if (_unsubEvent) { _unsubEvent(); _unsubEvent = null }

    // 订阅状态变化（订阅式，返回 unsub）
    _unsubStatus = wsClient.onStatusChange((status, errorMsg) => {
      if (!_pageActive) return
      updateStatusDot(status)
      const bar = document.getElementById('chat-disconnect-bar')
      const overlay = document.getElementById('chat-connect-overlay')
      const desc = document.getElementById('chat-connect-desc')
      if (status === 'ready' || status === 'connected') {
        _hasEverConnected = true
        if (bar) bar.style.display = 'none'
        if (overlay) overlay.style.display = 'none'
        resumeHostedFromReconnect()
      } else if (status === 'error') {
        clearHostedDisconnectTimer()
        // 连接错误：显示引导遮罩而非底部条
        if (bar) bar.style.display = 'none'
        if (overlay) {
          overlay.style.display = 'flex'
          if (desc) desc.textContent = errorMsg || '连接 Gateway 失败'
        }
        if (_hostedRuntime.status !== HOSTED_STATUS.PAUSED) {
          _hostedRuntime.status = HOSTED_STATUS.PAUSED
          _hostedRuntime.pending = false
          _hostedRuntime.lastAction = 'paused'
          persistHostedRuntime()
          updateHostedBadge()
        }
        markHostedHistoryStale()
        updateHostedInputLock()
      } else if (status === 'reconnecting' || status === 'disconnected') {
        // 首次连接或多次重连失败时，显示引导遮罩而非底部小条
        if (!_hasEverConnected) {
          if (overlay) { overlay.style.display = 'flex'; if (desc) desc.textContent = '正在连接 Gateway...' }
        } else {
          if (bar) { bar.textContent = '连接已断开，正在重连...'; bar.style.display = 'flex' }
        }
        pauseHostedForDisconnect(status)
        markHostedHistoryStale()
        updateHostedInputLock()
      } else {
        if (bar) bar.style.display = 'none'
        updateHostedInputLock()
      }
    })

    _unsubReady = wsClient.onReady((hello, sessionKey, err) => {
      if (!_pageActive) return
      const overlay = document.getElementById('chat-connect-overlay')
      if (err?.error) {
        if (overlay) {
          overlay.style.display = 'flex'
          const desc = document.getElementById('chat-connect-desc')
          if (desc) desc.textContent = err.message || '连接失败'
        }
        return
      }
      if (overlay) overlay.style.display = 'none'
      showTyping(false)  // Gateway 就绪后关闭加载动画
      // 重连后恢复：保留当前 sessionKey，不重复加载历史
      if (!_sessionKey) {
        const saved = localStorage.getItem(STORAGE_SESSION_KEY)
        _sessionKey = saved || sessionKey
        wsClient.setSessionKey(_sessionKey)
        updateSessionTitle()
        loadHistory()
      }
      // 始终刷新会话列表（无论是否有 sessionKey）
      refreshSessionList()
    })

    _unsubEvent = wsClient.onEvent((msg) => {
      if (!_pageActive) return
      handleEvent(msg)
    })

    // 如果已连接且 Gateway 就绪，直接复用
    if (wsClient.connected && wsClient.gatewayReady) {
      const saved = localStorage.getItem(STORAGE_SESSION_KEY)
      _sessionKey = saved || wsClient.sessionKey
      wsClient.setSessionKey(_sessionKey)
      updateStatusDot('ready')
      showTyping(false)  // 确保关闭加载动画
      updateSessionTitle()
      loadHistory()
      refreshSessionList()
      return
    }

    // 如果正在连接中（重连等），等待 onReady 回调即可
    if (wsClient.connected || wsClient.connecting || wsClient.gatewayReady) return

    // 未连接，发起新连接
    const config = await api.readOpenclawConfig()
    const gw = config?.gateway || {}
    const host = window.__TAURI_INTERNALS__ ? `127.0.0.1:${gw.port || 18789}` : location.host
    const token = gw.auth?.token || gw.authToken || ''
    wsClient.connect(host, token)
  } catch (e) {
    toast('读取配置失败: ' + e.message, 'error')
  }
}

// ── 会话管理 ──

async function refreshSessionList() {
  if (!_sessionListEl || !wsClient.gatewayReady) return
  try {
    const result = await wsClient.sessionsList(50)
    const sessions = result?.sessions || result || []
    renderSessionList(sessions)
  } catch (e) {
    console.error('[chat] refreshSessionList error:', e)
  }
}

function renderSessionList(sessions) {
  if (!_sessionListEl) return
  if (!sessions.length) {
    _sessionListEl.innerHTML = '<div class="chat-session-empty">暂无会话</div>'
    return
  }
  sessions.sort((a, b) => (b.updatedAt || b.lastActivity || 0) - (a.updatedAt || a.lastActivity || 0))
  _sessionListEl.innerHTML = sessions.map(s => {
    const key = s.sessionKey || s.key || ''
    const active = key === _sessionKey ? ' active' : ''
    const label = parseSessionLabel(key)
    const ts = s.updatedAt || s.lastActivity || s.createdAt || 0
    const timeStr = ts ? formatSessionTime(ts) : ''
    const msgCount = s.messageCount || s.messages || 0
    const agentId = parseSessionAgent(key)
    const displayLabel = getDisplayLabel(key) || label
    return `<div class="chat-session-card${active}" data-key="${escapeAttr(key)}">
      <div class="chat-session-card-header">
        <span class="chat-session-label" title="双击重命名">${escapeAttr(displayLabel)}</span>
        <button class="chat-session-del" data-del="${escapeAttr(key)}" title="删除">×</button>
      </div>
      <div class="chat-session-card-meta">
        ${agentId && agentId !== 'main' ? `<span class="chat-session-agent">${escapeAttr(agentId)}</span>` : ''}
        ${msgCount > 0 ? `<span>${msgCount} 条消息</span>` : ''}
        ${timeStr ? `<span>${timeStr}</span>` : ''}
      </div>
    </div>`
  }).join('')

  _sessionListEl.onclick = (e) => {
    const delBtn = e.target.closest('[data-del]')
    if (delBtn) { e.stopPropagation(); deleteSession(delBtn.dataset.del); return }
    const item = e.target.closest('[data-key]')
    if (item) switchSession(item.dataset.key)
  }
  _sessionListEl.ondblclick = (e) => {
    const labelEl = e.target.closest('.chat-session-label')
    if (!labelEl) return
    const card = labelEl.closest('[data-key]')
    if (!card) return
    e.stopPropagation()
    renameSession(card.dataset.key, labelEl)
  }
}

function formatSessionTime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now - d
  if (diffMs < 60000) return '刚刚'
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + ' 分钟前'
  if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + ' 小时前'
  if (diffMs < 604800000) return Math.floor(diffMs / 86400000) + ' 天前'
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

function parseSessionAgent(key) {
  const parts = (key || '').split(':')
  return parts.length >= 2 ? parts[1] : ''
}

function parseSessionLabel(key) {
  const parts = (key || '').split(':')
  if (parts.length < 3) return key || '未知'
  const agent = parts[1] || 'main'
  const channel = parts.slice(2).join(':')
  if (agent === 'main' && channel === 'main') return '主会话'
  if (agent === 'main') return channel
  return `${agent} / ${channel}`
}

function switchSession(newKey) {
  if (newKey === _sessionKey) return
  _sessionKey = newKey
  localStorage.setItem(STORAGE_SESSION_KEY, newKey)
  wsClient.setSessionKey(newKey)
  const state = getSessionState(_sessionKey)
  state.lastHistoryHash = ''
  resetStreamState()
  updateSessionTitle()
  clearMessages()
  loadHistory()
  refreshSessionList()
  loadHostedSessionConfig()
  renderHostedPanel()
  updateHostedBadge()
  updateHostedInputLock()
}

async function showNewSessionDialog() {
  const defaultAgent = wsClient.snapshot?.sessionDefaults?.defaultAgentId || 'main'

  // 先用默认选项立即显示弹窗
  const initialOptions = [
    { value: 'main', label: 'main (默认)' },
    { value: '__new__', label: '+ 新建 Agent' }
  ]

  showModal({
    title: '新建会话',
    fields: [
      { name: 'name', label: '会话名称', value: '', placeholder: '例如：翻译助手' },
      { name: 'agent', label: 'Agent', type: 'select', value: defaultAgent, options: initialOptions },
    ],
    onConfirm: (result) => {
      const name = (result.name || '').trim()
      if (!name) { toast('请输入会话名称', 'warning'); return }
      const agent = result.agent || defaultAgent
      if (agent === '__new__') {
        navigate('/agents')
        toast('请在 Agent 管理页面创建新 Agent', 'info')
        return
      }
      switchSession(`agent:${agent}:${name}`)
      toast('会话已创建', 'success')
    }
  })

  // 异步加载完整 Agent 列表并更新下拉框
  try {
    const agents = await api.listAgents()
    const agentOptions = agents.map(a => ({
      value: a.id,
      label: `${a.id}${a.isDefault ? ' (默认)' : ''}${a.identityName ? ' — ' + a.identityName.split(',')[0] : ''}`
    }))
    agentOptions.push({ value: '__new__', label: '+ 新建 Agent' })

    // 更新弹窗中的下拉框选项
    const selectEl = document.querySelector('.modal-overlay [data-name="agent"]')
    if (selectEl) {
      const currentValue = selectEl.value
      selectEl.innerHTML = agentOptions.map(o =>
        `<option value="${o.value}" ${o.value === currentValue ? 'selected' : ''}>${o.label}</option>`
      ).join('')
    }
  } catch (e) {
    console.warn('[chat] 加载 Agent 列表失败:', e)
  }
}

async function deleteSession(key) {
  const mainKey = wsClient.snapshot?.sessionDefaults?.mainSessionKey || 'agent:main:main'
  if (key === mainKey) { toast('主会话不能删除', 'warning'); return }
  const label = parseSessionLabel(key)
  const yes = await showConfirm(`确定删除会话「${label}」？`)
  if (!yes) return
  try {
    await wsClient.sessionsDelete(key)
    toast('会话已删除', 'success')
    if (key === _sessionKey) switchSession(mainKey)
    else refreshSessionList()
  } catch (e) {
    toast('删除失败: ' + e.message, 'error')
  }
}

async function resetCurrentSession() {
  if (!_sessionKey) return
  const label = getDisplayLabel(_sessionKey)
  const yes = await showConfirm(`确定要重置会话「${label}」吗？\n\n重置后将清空该会话的所有聊天记录，此操作不可撤销。`)
  if (!yes) return
  try {
    await wsClient.sessionsReset(_sessionKey)
    clearMessages()
    const state = getSessionState(_sessionKey)
    state.lastHistoryHash = ''
    appendSystemMessage('会话已重置')
    toast('会话已重置', 'success')
  } catch (e) {
    toast('重置失败: ' + e.message, 'error')
  }
}

function updateSessionTitle() {
  const el = _page?.querySelector('#chat-title')
  if (el) el.textContent = getDisplayLabel(_sessionKey)
}

function renameSession(key, labelEl) {
  const current = getDisplayLabel(key)
  const input = document.createElement('input')
  input.type = 'text'
  input.value = current
  input.className = 'chat-session-rename-input'
  input.style.cssText = 'width:100%;padding:2px 6px;border:1px solid var(--accent);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:12px;outline:none'
  const originalText = labelEl.textContent
  labelEl.textContent = ''
  labelEl.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const finish = () => {
    if (done) return
    done = true
    const newName = input.value.trim()
    if (newName && newName !== parseSessionLabel(key)) {
      setSessionName(key, newName)
      toast('会话已重命名', 'success')
    } else if (!newName || newName === parseSessionLabel(key)) {
      setSessionName(key, '') // clear custom name
    }
    labelEl.textContent = getDisplayLabel(key)
    // 如果是当前会话，同步更新顶部标题
    if (key === _sessionKey) updateSessionTitle()
  }
  input.addEventListener('blur', finish)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    if (e.key === 'Escape') { input.value = originalText; input.blur() }
  })
}

// ── 快捷指令面板 ──

function showCmdPanel() {
  if (!_cmdPanelEl) return
  let html = ''
  for (const group of COMMANDS) {
    html += `<div class="cmd-group-title">${group.title}</div>`
    for (const c of group.commands) {
      html += `<div class="cmd-item" data-cmd="${c.cmd}" data-action="${c.action}">
        <span class="cmd-name">${c.cmd}</span>
        <span class="cmd-desc">${c.desc}</span>
      </div>`
    }
  }
  _cmdPanelEl.innerHTML = html
  _cmdPanelEl.style.display = 'block'
  _cmdPanelEl.onclick = (e) => {
    const item = e.target.closest('.cmd-item')
    if (!item) return
    hideCmdPanel()
    if (item.dataset.action === 'fill') {
      _textarea.value = item.dataset.cmd
      _textarea.focus()
      updateSendState()
    } else {
      _textarea.value = item.dataset.cmd
      sendMessage()
    }
  }
}

function hideCmdPanel() {
  if (_cmdPanelEl) _cmdPanelEl.style.display = 'none'
}

function toggleHostedPanel() {
  if (!_hostedPanelEl) return
  const next = _hostedPanelEl.style.display !== 'block'
  _hostedPanelEl.style.display = next ? 'block' : 'none'
  if (next) renderHostedPanel()
}

function hideHostedPanel() {
  if (_hostedPanelEl) _hostedPanelEl.style.display = 'none'
}

function toggleCmdPanel() {
  if (_cmdPanelEl?.style.display === 'block') hideCmdPanel()
  else { _textarea.value = '/'; showCmdPanel(); _textarea.focus() }
}

// ── 消息发送 ──

function sendMessage() {
  if (_hostedSessionConfig?.enabled) {
    toast('托管 Agent 已启用，用户输入已锁定', 'warning')
    return
  }
  const text = _textarea.value.trim()
  if (!text && !_attachments.length) return
  if (!wsClient.gatewayReady || !_sessionKey) {
    toast('Gateway 未就绪，连接成功后再发送', 'warning')
    return
  }
  hideCmdPanel()
  _textarea.value = ''
  _textarea.style.height = 'auto'
  updateSendState()
  const attachments = [..._attachments]
  _attachments = []
  renderAttachments()
  if (_isSending || _isStreaming) { _messageQueue.push({ text, attachments }); return }
  doSend(text, attachments)
}

async function doSend(text, attachments = []) {
  if (!wsClient.gatewayReady || !_sessionKey) {
    toast('Gateway 未就绪，连接成功后再发送', 'warning')
    return
  }
  appendUserMessage(text, attachments)
  saveMessage({
    id: uuid(), sessionKey: _sessionKey, role: 'user', content: text, timestamp: Date.now(),
    attachments: attachments?.length ? attachments.map(a => ({ category: a.category || 'image', mimeType: a.mimeType || '', content: a.content || '', url: a.url || '' })) : undefined
  })
  showTyping(true)
  _isSending = true
  try {
    await wsClient.chatSend(_sessionKey, text, attachments.length ? attachments : undefined)
  } catch (err) {
    showTyping(false)
    appendSystemMessage('发送失败: ' + err.message)
  } finally {
    _isSending = false
    updateSendState()
  }
}

function processMessageQueue() {
  if (_messageQueue.length === 0 || _isSending || _isStreaming) return
  const msg = _messageQueue.shift()
  if (typeof msg === 'string') doSend(msg, [])
  else doSend(msg.text, msg.attachments || [])
}

function stopGeneration() {
  if (_currentRunId) wsClient.chatAbort(_sessionKey, _currentRunId).catch(() => {})
}

// ── 事件处理（参照 clawapp 实现） ──

function handleEvent(msg) {
  const { event, payload } = msg
  if (!payload) return
  const sessionKey = _normalizeSessionKey(payload?.sessionKey || payload?._req?.sessionKey || _sessionKey)
  const state = getSessionState(sessionKey)

  if (event === 'agent' && payload?.stream === 'tool' && payload?.data?.toolCallId) {
    const ts = payload.ts
    const toolCallId = payload.data.toolCallId
    const runId = payload.runId || ''
    const runKey = runId ? `${runId}:${toolCallId}` : toolCallId
    if (state.toolEventSeen.has(runKey)) return
    state.toolEventSeen.add(runKey)
    if (ts) state.toolEventTimes.set(runKey, ts)
    const current = state.toolEventData.get(runKey) || {}
    if (payload.data?.args && current.input == null) current.input = payload.data.args
    if (payload.data?.meta && current.output == null) current.output = payload.data.meta
    if (typeof payload.data?.isError === 'boolean' && current.status == null) current.status = payload.data.isError ? 'error' : 'ok'
    if (current.time == null) current.time = ts || null
    state.toolEventData.set(runKey, current)
    if (runId) {
      const list = state.toolRunIndex.get(runId) || []
      if (!list.includes(toolCallId)) list.push(toolCallId)
      state.toolRunIndex.set(runId, list)
    }
  }

  if (event === 'chat.history') {
    const { sessionKey: historyKey, result: historyResult } = normalizeHistoryPayload(payload, sessionKey, _normalizeSessionKey)
    const boundKey = getHostedBoundSessionKey()
    const isUiHistory = !!(historyKey && historyKey === _sessionKey)
    const isBoundHistory = !!(historyKey && boundKey && historyKey === boundKey)
    if (!historyKey || !historyResult || (!isUiHistory && !isBoundHistory)) return
    const historyState = getSessionState(historyKey)
    if (!_messagesEl || !isUiHistory) {
      historyState.pendingHistoryPayload = historyResult
      historyState.pendingHistoryTs = Date.now()
      return
    }
    const hasExisting = !!_messagesEl?.querySelector?.('.msg')
    if (_isSending || _isStreaming || _messageQueue.length > 0) {
      historyState.pendingHistoryPayload = historyResult
      historyState.pendingHistoryTs = Date.now()
      return
    }
    if (hasExisting) applyIncrementalHistoryResult(historyResult, historyKey)
    else applyHistoryResult(historyResult, false, historyKey)
    return
  }

  if (event === 'chat') handleChatEvent(payload)

  if ((event === 'status' || event === 'gateway.status') && payload?.state === 'disconnected') {
    pauseHostedForDisconnect('disconnected')
    markHostedHistoryStale()
  }

  // Compaction 状态指示：上游 2026.3.12 新增 status_reaction 事件
  if (event === 'chat.status_reaction' || event === 'status_reaction') {
    const reaction = payload.reaction || payload.emoji || ''
    if (reaction.includes('compact')) {
      showCompactionHint(true)
    } else if (!reaction || reaction === 'thinking') {
      showCompactionHint(false)
    }
  }
}

function handleChatEvent(payload) {
  const boundKey = getHostedBoundSessionKey()
  const isBoundSession = !!(payload.sessionKey && boundKey && payload.sessionKey === boundKey)
  // sessionKey 过滤：非当前 UI 且非绑定会话直接忽略
  if (payload.sessionKey && payload.sessionKey !== _sessionKey && !isBoundSession) return

  const { state } = payload
  const runId = payload.runId
  const sessionKey = _normalizeSessionKey(payload.sessionKey || _sessionKey)
  const sessionState = getSessionState(sessionKey)

  const isUiSession = !payload.sessionKey || payload.sessionKey === _sessionKey

  // 重复 run 过滤：跳过已完成的 runId 的后续事件（Gateway 可能对同一消息触发多个 run）
  if (runId && state === 'final' && sessionState.seenRunIds.has(runId)) {
    console.log('[chat] 跳过重复 final, runId:', runId)
    return
  }
  if (runId && state === 'delta' && sessionState.seenRunIds.has(runId) && !_isStreaming) {
    console.log('[chat] 跳过已完成 run 的 delta, runId:', runId)
    return
  }

  if (!isUiSession) {
    if (state === 'final') {
      if (runId) {
        sessionState.seenRunIds.add(runId)
        if (sessionState.seenRunIds.size > 200) {
          const first = sessionState.seenRunIds.values().next().value
          sessionState.seenRunIds.delete(first)
        }
      }
      return withHostedState(payload.sessionKey, () => {
        const c = extractChatContent(payload.message, sessionKey)
        const finalText = c?.text || ''
        if (finalText && shouldCaptureHostedTarget(payload)) {
          appendHostedTarget(finalText, payload.timestamp || Date.now())
          maybeTriggerHostedRun()
        }
      })
    }
    return
  }

  if (state === 'delta') {
    const c = extractChatContent(payload.message, sessionKey)
    if (c?.images?.length) _currentAiImages = c.images
    if (c?.videos?.length) _currentAiVideos = c.videos
    if (c?.audios?.length) _currentAiAudios = c.audios
    if (c?.files?.length) _currentAiFiles = c.files
    if (c?.tools?.length) _currentAiTools = c.tools
    if (c?.text && c.text.length > _currentAiText.length) {
      showTyping(false)
      if (!_currentAiBubble) {
        _currentAiBubble = createStreamBubble()
        _currentRunId = payload.runId
        _isStreaming = true
        _streamStartTime = Date.now()
        updateSendState()
      }
      _currentAiText = c.text
      // 每次收到 delta 重置安全超时（90s 无新 delta 则强制结束）
      clearTimeout(_streamSafetyTimer)
      _streamSafetyTimer = setTimeout(() => {
        if (_isStreaming) {
          console.warn('[chat] 流式输出超时（90s 无新数据），强制结束')
          if (_currentAiBubble && _currentAiText) {
            _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
          }
          appendSystemMessage('输出超时，已自动结束')
          resetStreamState()
          processMessageQueue()
        }
      }, 90000)
      throttledRender()
    }
    return
  }

  if (state === 'final') {
    const c = extractChatContent(payload.message, sessionKey)
    const finalText = c?.text || ''
    const finalImages = c?.images || []
    const finalVideos = c?.videos || []
    const finalAudios = c?.audios || []
    const finalFiles = c?.files || []
    let finalTools = c?.tools || []
    if (!finalTools.length && runId) {
      const ids = sessionState.toolRunIndex.get(runId) || []
      finalTools = ids.map(id => mergeToolEventData({ id, name: '工具' }, sessionKey)).filter(Boolean)
    }

    // 托管 Agent：记录对面回复并触发下一步（绑定会话亦可）
    if (finalText && shouldCaptureHostedTarget(payload)) {
      appendHostedTarget(finalText, payload.timestamp || Date.now())
      maybeTriggerHostedRun()
    }
    if (finalImages.length) _currentAiImages = finalImages
    if (finalVideos.length) _currentAiVideos = finalVideos
    if (finalAudios.length) _currentAiAudios = finalAudios
    if (finalFiles.length) _currentAiFiles = finalFiles
    if (finalTools.length) _currentAiTools = finalTools
    const hasContent = finalText || _currentAiImages.length || _currentAiVideos.length || _currentAiAudios.length || _currentAiFiles.length || _currentAiTools.length
    // 忽略空 final（Gateway 会为一条消息触发多个 run，部分是空 final）
    if (!_currentAiBubble && !hasContent) return
    // 标记 runId 为已处理，防止重复
    if (runId) {
      sessionState.seenRunIds.add(runId)
      if (sessionState.seenRunIds.size > 200) {
        const first = sessionState.seenRunIds.values().next().value
        sessionState.seenRunIds.delete(first)
      }
    }
    showTyping(false)
    // 如果流式阶段没有创建 bubble，从 final message 中提取
    if (!_currentAiBubble && hasContent) {
      _currentAiBubble = createStreamBubble()
      _currentAiText = finalText
    }
    if (_currentAiBubble) {
      if (_currentAiText) _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
      appendImagesToEl(_currentAiBubble, _currentAiImages)
      appendVideosToEl(_currentAiBubble, _currentAiVideos)
      appendAudiosToEl(_currentAiBubble, _currentAiAudios)
      appendFilesToEl(_currentAiBubble, _currentAiFiles)
      appendToolsToEl(_currentAiBubble, finalTools.length ? finalTools : _currentAiTools, sessionKey)
    }

    if (runId) {
      const ids = sessionState.toolRunIndex.get(runId) || []
      ids.forEach(id => {
        const key = `${runId}:${id}`
        sessionState.toolEventTimes.delete(key)
        sessionState.toolEventData.delete(key)
        sessionState.toolEventSeen.delete(key)
      })
      sessionState.toolRunIndex.delete(runId)
    }
    // 添加时间戳 + 耗时 + token 消耗
    const wrapper = _currentAiBubble?.parentElement
    if (wrapper) {
      const meta = document.createElement('div')
      meta.className = 'msg-meta'
      let parts = [`<span class="msg-time">${formatTime(new Date())}</span>`]
      // 计算响应耗时
      let durStr = ''
      if (payload.durationMs) {
        durStr = (payload.durationMs / 1000).toFixed(1) + 's'
      } else if (_streamStartTime) {
        durStr = ((Date.now() - _streamStartTime) / 1000).toFixed(1) + 's'
      }
      if (durStr) parts.push(`<span class="meta-sep">·</span><span class="msg-duration">⏱ ${durStr}</span>`)
      // token 消耗（从 payload.usage 或 payload.message.usage 提取）
      const usage = payload.usage || payload.message?.usage || null
      if (usage) {
        const inp = usage.input_tokens || usage.prompt_tokens || 0
        const out = usage.output_tokens || usage.completion_tokens || 0
        const total = usage.total_tokens || (inp + out)
        if (total > 0) {
          let tokenStr = `${total} tokens`
          if (inp && out) tokenStr = `↑${inp} ↓${out}`
          parts.push(`<span class="meta-sep">·</span><span class="msg-tokens">${tokenStr}</span>`)
        }
      }
      meta.innerHTML = parts.join('')
      wrapper.appendChild(meta)
    }
    if (_currentAiText || _currentAiImages.length) {
      saveMessage({
        id: payload.runId || uuid(), sessionKey: _sessionKey, role: 'assistant',
        content: _currentAiText, timestamp: Date.now(),
        attachments: _currentAiImages.map(i => ({ category: 'image', mimeType: i.mediaType || 'image/png', url: i.url, content: i.data })).filter(a => a.url || a.content)
      })
    }
    resetStreamState()
    processMessageQueue()
    return
  }

  if (state === 'aborted') {
    showTyping(false)
    if (_currentAiBubble && _currentAiText) {
      _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
    }
    appendSystemMessage('生成已停止')
    resetStreamState()
    processMessageQueue()
    return
  }

  if (state === 'error') {
    const errMsg = payload.errorMessage || payload.error?.message || '未知错误'

    // 连接级错误（origin/pairing/auth）拦截，不作为聊天消息显示
    if (/origin not allowed|NOT_PAIRED|PAIRING_REQUIRED|auth.*fail/i.test(errMsg)) {
      console.warn('[chat] 拦截连接级错误，不显示为聊天消息:', errMsg)
      const overlay = document.getElementById('chat-connect-overlay')
      if (overlay) {
        overlay.style.display = 'flex'
        const desc = document.getElementById('chat-connect-desc')
        if (desc) desc.textContent = '连接被 Gateway 拒绝，请点击「修复并重连」'
      }
      return
    }

    // 防抖：如果是相同错误且在 2 秒内，忽略（避免重复显示）
    const now = Date.now()
    if (_lastErrorMsg === errMsg && _errorTimer && (now - _errorTimer < 2000)) {
      console.warn('[chat] 忽略重复错误:', errMsg)
      return
    }
    _lastErrorMsg = errMsg
    _errorTimer = now

    // 如果正在流式输出，说明消息已经部分成功，不显示错误
    if (_isStreaming || _currentAiBubble) {
      console.warn('[chat] 流式中收到错误，但消息已部分成功，忽略错误提示:', errMsg)
      return
    }

    showTyping(false)
    appendSystemMessage('错误: ' + errMsg)
    resetStreamState()
    processMessageQueue()
    return
  }
}

/** 从 Gateway message 对象提取文本和所有媒体（参照 clawapp extractContent） */
function extractChatContent(message, sessionKey) {
  if (!message || typeof message !== 'object') return null
  const tools = []
  collectToolsFromMessage(message, tools, sessionKey)
  if (message.role === 'tool' || message.role === 'toolResult') {
    const output = typeof message.content === 'string' ? message.content : null
    if (!tools.length) {
      tools.push({
        name: message.name || message.tool || message.tool_name || message.toolName || message.tool?.name || message.meta?.toolName || '工具',
        input: message.input || message.args || message.parameters || message.arguments || message.tool_input || message.toolInput || message.tool?.input || message.tool?.args || message.meta?.input || message.meta?.args || null,
        output: output || message.output || message.result || message.content || message.tool_output || message.output_text || message.result_text || message.tool?.output || message.meta?.output || null,
        status: message.status || 'ok',
      })
    } else if (output && !tools[0].output) {
      tools[0].output = output
    }
    return { text: '', images: [], videos: [], audios: [], files: [], tools }
  }
  const content = message.content
  if (typeof content === 'string') return { text: stripThinkingTags(content), images: [], videos: [], audios: [], files: [], tools }
  if (Array.isArray(content)) {
    const texts = [], images = [], videos = [], audios = [], files = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image' && !block.omitted) {
        if (block.data) images.push({ mediaType: block.mimeType || 'image/png', data: block.data })
        else if (block.source?.type === 'base64' && block.source.data) images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data })
        else if (block.url || block.source?.url) images.push({ url: block.url || block.source.url, mediaType: block.mimeType || 'image/png' })
      }
      else if (block.type === 'image_url' && block.image_url?.url) images.push({ url: block.image_url.url, mediaType: 'image/png' })
      else if (block.type === 'video') {
        if (block.data) videos.push({ mediaType: block.mimeType || 'video/mp4', data: block.data })
        else if (block.url) videos.push({ url: block.url, mediaType: block.mimeType || 'video/mp4' })
      }
      else if (block.type === 'audio' || block.type === 'voice') {
        if (block.data) audios.push({ mediaType: block.mimeType || 'audio/mpeg', data: block.data, duration: block.duration })
        else if (block.url) audios.push({ url: block.url, mediaType: block.mimeType || 'audio/mpeg', duration: block.duration })
      }
      else if (block.type === 'file' || block.type === 'document') {
        files.push({ url: block.url || '', name: block.fileName || block.name || '文件', mimeType: block.mimeType || '', size: block.size, data: block.data })
      }
      else if (block.type === 'tool' || block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'toolCall') {
        const callId = block.id || block.tool_call_id || block.toolCallId || block.tool_use_id || block.toolUseId
        upsertTool(tools, {
          id: callId,
          name: block.name || block.tool || block.tool_name || block.toolName || block.tool?.name || block.meta?.toolName || '工具',
          input: block.input || block.args || block.parameters || block.arguments || block.tool_input || block.toolInput || block.tool?.input || block.tool?.args || block.meta?.input || block.meta?.args || null,
          output: null,
          status: block.status || 'ok',
          time: resolveToolTime(callId, message.timestamp, message.runId, sessionKey),
          runId: message.runId,
          messageTimestamp: message.timestamp,
        }, sessionKey)
      }
      else if (block.type === 'tool_result' || block.type === 'toolResult') {
        const resId = block.id || block.tool_call_id || block.toolCallId || block.result_id || block.resultId
        upsertTool(tools, {
          id: resId,
          name: block.name || block.tool || block.tool_name || block.toolName || block.tool?.name || block.meta?.toolName || '工具',
          input: block.input || block.args || block.tool_input || block.toolInput || block.tool?.input || block.tool?.args || block.meta?.input || block.meta?.args || null,
          output: block.output || block.result || block.content || block.tool_output || block.output_text || block.result_text || block.tool?.output || block.meta?.output || null,
          status: block.status || 'ok',
          time: resolveToolTime(resId, message.timestamp, message.runId, sessionKey),
          runId: message.runId,
          messageTimestamp: message.timestamp,
        }, sessionKey)
      }
    }
    if (tools.length) {
      tools.forEach(t => {
        if (typeof t.input === 'string') t.input = stripAnsi(t.input)
        if (typeof t.output === 'string') t.output = stripAnsi(t.output)
      })
    }
    // 从 mediaUrl/mediaUrls 提取
    const mediaUrls = message.mediaUrls || (message.mediaUrl ? [message.mediaUrl] : [])
    for (const url of mediaUrls) {
      if (!url) continue
      if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) videos.push({ url, mediaType: 'video/mp4' })
      else if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(url)) audios.push({ url, mediaType: 'audio/mpeg' })
      else if (/\.(jpe?g|png|gif|webp|heic|svg)(\?|$)/i.test(url)) images.push({ url, mediaType: 'image/png' })
      else files.push({ url, name: url.split('/').pop().split('?')[0] || '文件', mimeType: '' })
    }
    const text = texts.length ? stripThinkingTags(texts.join('\n')) : ''
    return { text, images, videos, audios, files, tools }
  }
  if (typeof message.text === 'string') return { text: stripThinkingTags(message.text), images: [], videos: [], audios: [], files: [], tools: [] }
  return null
}

function stripAnsi(text) {
  if (!text) return ''
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function stripThinkingTags(text) {
  const safe = stripAnsi(text)
  return safe
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, '')
    .replace(/\[Queued messages while agent was busy\]\s*---\s*Queued #\d+\s*/gi, '')
    .trim()
}

function normalizeTime(raw) {
  if (!raw) return null
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'string') {
    const num = Number(raw)
    if (!Number.isNaN(num)) raw = num
    else {
      const parsed = Date.parse(raw)
      return Number.isNaN(parsed) ? null : parsed
    }
  }
  if (typeof raw === 'number' && raw < 1e12) return raw * 1000
  return raw
}

function resolveToolTime(toolId, messageTimestamp, runId, sessionKey) {
  const state = getSessionState(sessionKey)
  const key = runId ? `${runId}:${toolId}` : toolId
  let eventTs = toolId ? state.toolEventTimes.get(key) : null
  if (!eventTs && runId) {
    for (const [k, v] of state.toolEventTimes.entries()) {
      if (k.endsWith(`:${toolId}`)) { eventTs = v; break }
    }
  }
  return normalizeTime(eventTs) || normalizeTime(messageTimestamp) || null
}

function getToolTime(tool) {
  const raw = tool?.end_time || tool?.endTime || tool?.timestamp || tool?.time || tool?.started_at || tool?.startedAt || null
  return normalizeTime(raw)
}

function safeStringify(value) {
  if (value == null) return ''
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    }, 2)
  } catch {
    try { return String(value) } catch { return '' }
  }
}

function formatTime(date) {
  const now = new Date()
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (isToday) return `${h}:${m}`
  const mon = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${mon}-${day} ${h}:${m}`
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 创建流式 AI 气泡 */
function createStreamBubble() {
  if (!_messagesEl || !_typingEl) return null
  showTyping(false)
  const wrap = document.createElement('div')
  wrap.className = 'msg msg-ai'
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'
  bubble.innerHTML = '<span class="stream-cursor"></span>'
  wrap.appendChild(bubble)
  insertMessageByTime(wrap, Date.now())
  scrollToBottom()
  return bubble
}

// ── 流式渲染（节流） ──

function throttledRender() {
  if (_renderPending) return
  const now = performance.now()
  if (now - _lastRenderTime >= RENDER_THROTTLE) {
    doRender()
  } else {
    _renderPending = true
    requestAnimationFrame(() => { _renderPending = false; doRender() })
  }
}

function doRender() {
  _lastRenderTime = performance.now()
  if (_currentAiBubble && _currentAiText) {
    _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
    scrollToBottom()
  }
}

// ensureAiBubble 已被 createStreamBubble 替代

function resetStreamState() {
  clearTimeout(_streamSafetyTimer)
  if (_currentAiBubble && (_currentAiText || _currentAiImages.length || _currentAiVideos.length || _currentAiAudios.length || _currentAiFiles.length || _currentAiTools.length)) {
    _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
    appendImagesToEl(_currentAiBubble, _currentAiImages)
    appendVideosToEl(_currentAiBubble, _currentAiVideos)
    appendAudiosToEl(_currentAiBubble, _currentAiAudios)
    appendFilesToEl(_currentAiBubble, _currentAiFiles)
    appendToolsToEl(_currentAiBubble, _currentAiTools, _sessionKey)
  }
  _renderPending = false
  _lastRenderTime = 0
  _currentAiBubble = null
  _currentAiText = ''
  _currentAiImages = []
  _currentAiVideos = []
  _currentAiAudios = []
  _currentAiFiles = []
  _currentAiTools = []
  _currentRunId = null
  _isStreaming = false
  _streamStartTime = 0
  _lastErrorMsg = null
  _errorTimer = null
  showTyping(false)
  updateSendState()
  flushPendingHistory()
}

// ── 历史消息加载 ──


function flushPendingHistory(sessionKey = _sessionKey) {
  const key = _normalizeSessionKey(sessionKey)
  const state = getSessionState(key)
  const payload = takePendingHistoryPayload(state, {
    hasMessagesEl: !!_messagesEl,
    isBusy: _isSending || _isStreaming || _messageQueue.length > 0,
    maxHistoryTimestamp,
  })
  if (!payload) return
  applyIncrementalHistoryResult(payload, key)
}

function getRenderedHistoryKeys() {
  const keys = new Set()
  if (!_messagesEl) return keys
  _messagesEl.querySelectorAll('.msg[data-history-key]').forEach(node => {
    if (node.dataset.historyKey) keys.add(node.dataset.historyKey)
  })
  return keys
}

function stampHistoryNode(node, msg) {
  if (!node) return
  node.dataset.historyKey = buildHistoryEntryKey(msg)
  node.dataset.historyRole = msg?.role || 'system'
  if (msg?.statusKey || msg?.statusType) node.dataset.statusKey = msg?.statusKey || msg?.statusType || ''
  node.dataset.ts = String(Number(msg?.timestamp || Date.now()))
}

function upsertStableSystemBubble({
  statusKey,
  text,
  statusType = 'system',
  sessionKey = _sessionKey,
  ts = Date.now(),
  active = true,
}) {
  if (!_messagesEl || !statusKey || sessionKey !== _sessionKey) return null
  let node = _messagesEl.querySelector(`.msg-system[data-status-key="${statusKey}"]`)
  if (!active) {
    node?.remove()
    return null
  }
  if (!node) {
    node = document.createElement('div')
    node.className = 'msg msg-system msg-hosted'
    node.dataset.statusKey = statusKey
    insertMessageByTime(node, ts)
  }
  node.dataset.statusType = statusType
  node.dataset.historyRole = 'system'
  node.dataset.historyKey = buildHistoryEntryKey({ role: 'system', text, timestamp: ts, statusKey, statusType })
  node.dataset.ts = String(Number(ts || Date.now()))
  node.textContent = text || ''
  return node
}

function applyIncrementalHistoryResult(result, sessionKey) {
  if (!_messagesEl || !result?.messages?.length) return
  const deduped = dedupeHistory(result.messages, sessionKey)
  const state = getSessionState(sessionKey)
  state.lastHistoryAppliedTs = Math.max(Number(state.lastHistoryAppliedTs || 0), maxHistoryTimestamp(result.messages))
  const renderedKeys = getRenderedHistoryKeys()
  const { appended, hasOmittedImages } = renderIncrementalHistoryList(deduped, sessionKey, {
    renderedKeys,
    buildHistoryEntryKey,
    appendUserMessage,
    appendAiMessage,
    appendSystemMessage,
    stampHistoryNode,
  })

  if (hasOmittedImages) appendOmittedImagesNotice({ appendSystemMessage })

  saveMessages(toStoredHistoryMessages(result.messages, sessionKey, extractContent, uuid))

  if (appended > 0) scrollToBottom()
}

function applyHistoryResult(result, hasExisting, sessionKey) {
  if (!result?.messages?.length) {
    if (_messagesEl && !_messagesEl.querySelector('.msg')) appendSystemMessage('还没有消息，开始聊天吧')
    return
  }
  const deduped = dedupeHistory(result.messages, sessionKey)
  const state = getSessionState(sessionKey)
  const applyMeta = updateHistoryApplyState(state, result.messages, hasExisting, {
    maxHistoryTimestamp,
    buildHistoryHash,
  })
  if (applyMeta.shouldSkip) return

  _hostedSeeded = seedHostedHistoryIfNeeded({
    sessionKey,
    hostedBoundSessionKey: getHostedBoundSessionKey(),
    hostedSeeded: _hostedSeeded,
    hostedSessionConfig: _hostedSessionConfig,
    deduped,
    toHostedSeedHistory,
    trimHostedHistoryByTokens,
    persistHostedRuntime,
  })

  // 正在发送/流式输出时不全量重绘，避免覆盖本地乐观渲染
  if (hasExisting && (_isSending || _isStreaming || _messageQueue.length > 0)) {
    saveMessages(toStoredHistoryMessages(result.messages, sessionKey, extractContent, uuid))
    return
  }

  clearMessages()
  const { hasOmittedImages } = renderHistoryList(deduped, sessionKey, {
    appendUserMessage,
    appendAiMessage,
    appendSystemMessage,
    stampHistoryNode,
  })
  if (hasOmittedImages) appendOmittedImagesNotice({ appendSystemMessage })
  saveMessages(toStoredHistoryMessages(result.messages, sessionKey, extractContent, uuid))
  scrollToBottom(true)
}

async function loadHistory() {
  if (!_sessionKey || !_messagesEl) return
  _isLoadingHistory = true
  const hasExisting = _messagesEl.querySelector('.msg')
  if (!hasExisting && isStorageAvailable()) {
    const local = await getLocalMessages(_sessionKey, 200)
    if (local.length) {
      clearMessages()
      renderLocalHistoryMessages(local, {
        appendUserMessage,
        appendAiMessage,
        appendSystemMessage,
      })
      scrollToBottom(true)
    }
  }
  if (!wsClient.gatewayReady) { _isLoadingHistory = false; return }
  try {
    const result = await wsClient.chatHistory(_sessionKey, 200)
    applyHistoryResult(result, hasExisting, _sessionKey)
  } catch (e) {
    console.error('[chat] loadHistory error:', e)
    if (_messagesEl && !_messagesEl.querySelector('.msg')) appendSystemMessage('加载历史失败: ' + e.message)
  } finally {
    _isLoadingHistory = false
    flushPendingHistory()
  }
}

function dedupeHistory(messages, sessionKey) {
  const deduped = []
  for (const msg of messages) {
    const role = (msg.role === 'tool' || msg.role === 'toolResult') ? 'assistant' : msg.role
    const c = extractContent(msg, sessionKey)
    if (!c.text && !c.images.length && !c.videos.length && !c.audios.length && !c.files.length && !c.tools.length) continue
    const tools = (c.tools || []).map(t => {
      const id = t.id || t.tool_call_id
      const time = t.time || resolveToolTime(id, msg.timestamp, msg.runId, sessionKey)
      return { ...t, time, messageTimestamp: msg.timestamp, runId: msg.runId }
    })
    const last = deduped[deduped.length - 1]
    if (last && last.role === role) {
      if (role === 'user' && last.text === c.text) continue
      if (role === 'assistant') {
        // 同文本去重（Gateway 重试产生的重复回复）
        if (c.text && last.text === c.text) continue
        // 不同文本则合并
        last.text = [last.text, c.text].filter(Boolean).join('\n')
        last.images = [...(last.images || []), ...c.images]
        last.videos = [...(last.videos || []), ...c.videos]
        last.audios = [...(last.audios || []), ...c.audios]
        last.files = [...(last.files || []), ...c.files]
        tools.forEach(t => upsertTool(last.tools, t, sessionKey))
        continue
      }
    }
    deduped.push({ role, text: c.text, images: c.images, videos: c.videos, audios: c.audios, files: c.files, tools, timestamp: msg.timestamp })
  }
  return deduped
}

function extractContent(msg, sessionKey) {
  const tools = []
  collectToolsFromMessage(msg, tools, sessionKey)
  if (msg.role === 'tool' || msg.role === 'toolResult') {
    const output = typeof msg.content === 'string' ? msg.content : null
    if (!tools.length) {
      upsertTool(tools, {
        id: msg.id || msg.tool_call_id || msg.toolCallId,
        name: msg.name || msg.tool || msg.tool_name || '工具',
        input: msg.input || msg.args || msg.parameters || null,
        output: output || msg.output || msg.result || null,
        status: msg.status || 'ok',
        time: resolveToolTime(msg.tool_call_id || msg.toolCallId || msg.id, msg.timestamp, msg.runId, sessionKey),
        runId: msg.runId,
        messageTimestamp: msg.timestamp,
      }, sessionKey)
    } else if (output && !tools[0].output) {
      tools[0].output = output
    }
    return { text: '', images: [], videos: [], audios: [], files: [], tools }
  }
  if (Array.isArray(msg.content)) {
    const texts = [], images = [], videos = [], audios = [], files = []
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image' && !block.omitted) {
        if (block.data) images.push({ mediaType: block.mimeType || 'image/png', data: block.data })
        else if (block.source?.type === 'base64' && block.source.data) images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data })
        else if (block.url || block.source?.url) images.push({ url: block.url || block.source.url, mediaType: block.mimeType || 'image/png' })
      }
      else if (block.type === 'image_url' && block.image_url?.url) images.push({ url: block.image_url.url, mediaType: 'image/png' })
      else if (block.type === 'video') {
        if (block.data) videos.push({ mediaType: block.mimeType || 'video/mp4', data: block.data })
        else if (block.url) videos.push({ url: block.url, mediaType: block.mimeType || 'video/mp4' })
      }
      else if (block.type === 'audio' || block.type === 'voice') {
        if (block.data) audios.push({ mediaType: block.mimeType || 'audio/mpeg', data: block.data, duration: block.duration })
        else if (block.url) audios.push({ url: block.url, mediaType: block.mimeType || 'audio/mpeg', duration: block.duration })
      }
      else if (block.type === 'file' || block.type === 'document') {
        files.push({ url: block.url || '', name: block.fileName || block.name || '文件', mimeType: block.mimeType || '', size: block.size, data: block.data })
      }
      else if (block.type === 'tool' || block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'toolCall') {
        const callId = block.id || block.tool_call_id || block.toolCallId || block.tool_use_id || block.toolUseId
        upsertTool(tools, {
          id: callId,
          name: block.name || block.tool || block.tool_name || block.toolName || block.tool?.name || block.meta?.toolName || '工具',
          input: block.input || block.args || block.parameters || block.arguments || block.tool_input || block.toolInput || block.tool?.input || block.tool?.args || block.meta?.input || block.meta?.args || null,
          output: null,
          status: block.status || 'ok',
          time: resolveToolTime(callId, msg.timestamp, msg.runId, sessionKey),
        }, sessionKey)
      }
      else if (block.type === 'tool_result' || block.type === 'toolResult') {
        const resId = block.id || block.tool_call_id || block.toolCallId || block.result_id || block.resultId
        upsertTool(tools, {
          id: resId,
          name: block.name || block.tool || block.tool_name || block.toolName || block.tool?.name || block.meta?.toolName || '工具',
          input: block.input || block.args || block.tool_input || block.toolInput || block.tool?.input || block.tool?.args || block.meta?.input || block.meta?.args || null,
          output: block.output || block.result || block.content || block.tool_output || block.output_text || block.result_text || block.tool?.output || block.meta?.output || null,
          status: block.status || 'ok',
          time: resolveToolTime(resId, msg.timestamp, msg.runId, sessionKey),
        }, sessionKey)
      }
    }
    if (tools.length) {
      tools.forEach(t => {
        if (typeof t.input === 'string') t.input = stripAnsi(t.input)
        if (typeof t.output === 'string') t.output = stripAnsi(t.output)
      })
    }
    const mediaUrls = msg.mediaUrls || (msg.mediaUrl ? [msg.mediaUrl] : [])
    for (const url of mediaUrls) {
      if (!url) continue
      if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) videos.push({ url, mediaType: 'video/mp4' })
      else if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(url)) audios.push({ url, mediaType: 'audio/mpeg' })
      else if (/\.(jpe?g|png|gif|webp|heic|svg)(\?|$)/i.test(url)) images.push({ url, mediaType: 'image/png' })
      else files.push({ url, name: url.split('/').pop().split('?')[0] || '文件', mimeType: '' })
    }
    return { text: stripThinkingTags(texts.join('\n')), images, videos, audios, files, tools }
  }
  let text = ''
  if (typeof msg.text === 'string') text = msg.text
  else if (typeof msg.content === 'string') text = msg.content
  else if (msg.content && typeof msg.content === 'object') text = safeStringify(msg.content)
  return { text: stripThinkingTags(text), images: [], videos: [], audios: [], files: [], tools }
}

// ── DOM 操作 ──

function appendUserMessage(text, attachments = [], msgTime) {
  const wrap = document.createElement('div')
  wrap.className = 'msg msg-user'
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'

  if (attachments && attachments.length > 0) {
    const mediaContainer = document.createElement('div')
    mediaContainer.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap'
    attachments.forEach(att => {
      const cat = att.category || att.type || 'image'
      const src = att.data ? `data:${att.mimeType || att.mediaType || 'image/png'};base64,${att.data}`
        : att.content ? `data:${att.mimeType || 'image/png'};base64,${att.content}`
        : att.url || ''
      if (cat === 'image' && src) {
        const img = document.createElement('img')
        img.src = src
        img.className = 'msg-img'
        img.onclick = () => showLightbox(img.src)
        mediaContainer.appendChild(img)
      } else if (cat === 'video' && src) {
        const video = document.createElement('video')
        video.src = src
        video.className = 'msg-video'
        video.controls = true
        video.preload = 'metadata'
        video.playsInline = true
        mediaContainer.appendChild(video)
      } else if (cat === 'audio' && src) {
        const audio = document.createElement('audio')
        audio.src = src
        audio.className = 'msg-audio'
        audio.controls = true
        audio.preload = 'metadata'
        mediaContainer.appendChild(audio)
      } else if (att.fileName || att.name) {
        const card = document.createElement('div')
        card.className = 'msg-file-card'
        card.innerHTML = `<span class="msg-file-icon">${svgIcon('paperclip', 16)}</span><span class="msg-file-name">${att.fileName || att.name}</span>`
        mediaContainer.appendChild(card)
      }
    })
    if (mediaContainer.children.length) bubble.appendChild(mediaContainer)
  }

  if (text) {
    const textNode = document.createElement('div')
    textNode.textContent = text
    bubble.appendChild(textNode)
  }

  const meta = document.createElement('div')
  meta.className = 'msg-meta'
  meta.innerHTML = `<span class="msg-time">${formatTime(msgTime || new Date())}</span>`

  wrap.appendChild(bubble)
  wrap.appendChild(meta)
  insertMessageByTime(wrap, msgTime?.getTime?.() || Date.now())
  scrollToBottom()
  return wrap
}

function appendAiMessage(text, msgTime, images, videos, audios, files, tools, sessionKey = _sessionKey) {
  const wrap = document.createElement('div')
  wrap.className = 'msg msg-ai'
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'
  appendToolsToEl(bubble, tools, sessionKey)
  const textEl = document.createElement('div')
  textEl.className = 'msg-text'
  textEl.innerHTML = renderMarkdown(text || '')
  bubble.appendChild(textEl)
  appendImagesToEl(bubble, images)
  appendVideosToEl(bubble, videos)
  appendAudiosToEl(bubble, audios)
  appendFilesToEl(bubble, files)
  // 图片点击灯箱
  bubble.querySelectorAll('img').forEach(img => { if (!img.onclick) img.onclick = () => showLightbox(img.src) })

  const meta = document.createElement('div')
  meta.className = 'msg-meta'
  meta.innerHTML = `<span class="msg-time">${formatTime(msgTime || new Date())}</span>`

  wrap.appendChild(bubble)
  wrap.appendChild(meta)
  insertMessageByTime(wrap, msgTime?.getTime?.() || Date.now())
  scrollToBottom()
  return wrap
}

/** 渲染图片到消息气泡（支持 Anthropic/OpenAI/直接格式） */
function appendImagesToEl(el, images) {
  if (!images?.length) return
  const container = document.createElement('div')
  container.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap'
  images.forEach(img => {
    const imgEl = document.createElement('img')
    // Anthropic 格式: { type: 'image', source: { data, media_type } }
    if (img.source?.data) {
      imgEl.src = `data:${img.source.media_type || 'image/png'};base64,${img.source.data}`
    // 直接格式: { data, mediaType }
    } else if (img.data) {
      imgEl.src = `data:${img.mediaType || img.media_type || 'image/png'};base64,${img.data}`
    // OpenAI 格式: { type: 'image_url', image_url: { url } }
    } else if (img.image_url?.url) {
      imgEl.src = img.image_url.url
    // URL 格式
    } else if (img.url) {
      imgEl.src = img.url
    } else {
      return
    }
    imgEl.style.cssText = 'max-width:300px;max-height:300px;border-radius:6px;cursor:pointer'
    imgEl.onclick = () => showLightbox(imgEl.src)
    container.appendChild(imgEl)
  })
  if (container.children.length) el.appendChild(container)
}

/** 渲染视频到消息气泡 */
function appendVideosToEl(el, videos) {
  if (!videos?.length) return
  videos.forEach(vid => {
    const videoEl = document.createElement('video')
    videoEl.className = 'msg-video'
    videoEl.controls = true
    videoEl.preload = 'metadata'
    videoEl.playsInline = true
    if (vid.data) videoEl.src = `data:${vid.mediaType};base64,${vid.data}`
    else if (vid.url) videoEl.src = vid.url
    el.appendChild(videoEl)
  })
}

/** 渲染音频到消息气泡 */
function appendAudiosToEl(el, audios) {
  if (!audios?.length) return
  audios.forEach(aud => {
    const audioEl = document.createElement('audio')
    audioEl.className = 'msg-audio'
    audioEl.controls = true
    audioEl.preload = 'metadata'
    if (aud.data) audioEl.src = `data:${aud.mediaType};base64,${aud.data}`
    else if (aud.url) audioEl.src = aud.url
    el.appendChild(audioEl)
  })
}

/** 渲染文件卡片到消息气泡 */
function appendFilesToEl(el, files) {
  if (!files?.length) return
  files.forEach(f => {
    const card = document.createElement('div')
    card.className = 'msg-file-card'
    const ext = (f.name || '').split('.').pop().toLowerCase()
    const fileIconMap = { pdf: 'file', doc: 'file-text', docx: 'file-text', txt: 'file-plain', md: 'file-plain', json: 'clipboard', csv: 'bar-chart', zip: 'package', rar: 'package' }
    const fileIcon = svgIcon(fileIconMap[ext] || 'paperclip', 16)
    const size = f.size ? formatFileSize(f.size) : ''
    card.innerHTML = `<span class="msg-file-icon">${fileIcon}</span><div class="msg-file-info"><span class="msg-file-name">${f.name || '文件'}</span>${size ? `<span class="msg-file-size">${size}</span>` : ''}</div>`
    if (f.url) {
      card.style.cursor = 'pointer'
      card.onclick = () => window.open(f.url, '_blank')
    } else if (f.data) {
      card.style.cursor = 'pointer'
      card.onclick = () => {
        const a = document.createElement('a')
        a.href = `data:${f.mimeType || 'application/octet-stream'};base64,${f.data}`
        a.download = f.name || '文件'
        a.click()
      }
    }
    el.appendChild(card)
  })
}

function mergeToolEventData(entry, sessionKey) {
  const id = entry?.id || entry?.tool_call_id
  if (!id) return entry
  const state = getSessionState(sessionKey)
  const runId = entry?.runId || entry?.run_id || entry?.run || ''
  const key = runId ? `${runId}:${id}` : id
  let extra = state.toolEventData.get(key)
  if (!extra && runId) {
    for (const [k, v] of state.toolEventData.entries()) {
      if (k.endsWith(`:${id}`)) { extra = v; break }
    }
  }
  if (!extra) return entry
  if (entry.input == null && extra.input != null) entry.input = extra.input
  if (entry.output == null && extra.output != null) entry.output = extra.output
  if (entry.status == null && extra.status != null) entry.status = extra.status
  if (entry.time == null) entry.time = extra.time || state.toolEventTimes.get(key) || null
  return entry
}

function upsertTool(tools, entry, sessionKey) {
  if (!entry) return
  const id = entry.id || entry.tool_call_id
  let target = null
  if (id) target = tools.find(t => t.id === id || t.tool_call_id === id)
  if (!target && entry.name && entry.runId) {
    target = tools.find(t => t.name === entry.name && t.runId === entry.runId && !t.output)
  }
  if (!target && entry.name && entry.messageTimestamp) {
    target = tools.find(t => t.name === entry.name && t.messageTimestamp === entry.messageTimestamp && !t.output)
  }
  if (target) {
    if (entry.input != null && target.input == null) target.input = entry.input
    if (entry.output != null && target.output == null) target.output = entry.output
    if (entry.status && target.status == null) target.status = entry.status
    if (entry.time && target.time == null) target.time = entry.time
    return
  }
  tools.push(mergeToolEventData(entry, sessionKey))
}

function collectToolsFromMessage(message, tools, sessionKey) {
  if (!message || !tools) return
  const toolCalls = message.tool_calls || message.toolCalls || message.tools
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach(call => {
      const fn = call.function || null
      const name = call.name || call.tool || call.tool_name || call.toolName || call.tool?.name || call.meta?.toolName || fn?.name
      const input = call.input || call.args || call.parameters || call.arguments || call.tool_input || call.toolInput || call.tool?.input || call.tool?.args || call.meta?.input || call.meta?.args || fn?.arguments || null
      const callId = call.id || call.tool_call_id || call.tool_use_id || call.toolUseId
      upsertTool(tools, {
        id: callId,
        name: name || '工具',
        input: input || call.meta?.input || null,
        output: null,
        status: call.status || 'ok',
        time: resolveToolTime(callId, message?.timestamp, message?.runId, sessionKey),
        runId: message?.runId,
        messageTimestamp: message?.timestamp,
      }, sessionKey)
    })
  }
  const toolResults = message.tool_results || message.toolResults
  if (Array.isArray(toolResults)) {
    toolResults.forEach(res => {
      const resId = res.id || res.tool_call_id || res.result_id || res.resultId
      upsertTool(tools, {
        id: resId,
        name: res.name || res.tool || res.tool_name || res.toolName || res.tool?.name || res.meta?.toolName || '工具',
        input: res.input || res.args || res.tool_input || res.toolInput || res.tool?.input || res.tool?.args || res.meta?.input || res.meta?.args || null,
        output: res.output || res.result || res.content || res.tool_output || res.output_text || res.result_text || res.tool?.output || res.meta?.output || null,
        status: res.status || 'ok',
        time: resolveToolTime(resId, message?.timestamp, message?.runId, sessionKey),
        runId: message?.runId,
        messageTimestamp: message?.timestamp,
      }, sessionKey)
    })
  }
}

/** 渲染工具调用到消息气泡 */
function appendToolsToEl(el, tools, sessionKey) {
  if (!el) return
  const existing = el.querySelector?.('.msg-tool')
  if (!tools?.length) {
    if (existing) existing.remove()
    return
  }

  let filtered = tools
  const askUserTools = tools.filter(t => (t.name || '').toLowerCase() === 'ask_user')
  if (!_hostedSessionConfig?.enabled) {
    if (askUserTools.length) {
      filtered = tools.filter(t => (t.name || '').toLowerCase() !== 'ask_user')
      if (!_askUserBlockedNotice) {
        _askUserBlockedNotice = true
        appendSystemMessage('已拦截 ask_user：仅托管 Agent 允许调用用户交互工具')
      }
    }
  } else if (askUserTools.length) {
    filtered = tools.filter(t => (t.name || '').toLowerCase() !== 'ask_user')
    if (!_askUserBlockedNotice) {
      _askUserBlockedNotice = true
      appendSystemMessage('托管模式已禁用 ask_user 工具卡片，交互请求不会再弹给用户。')
    }
  }

  if (!filtered.length) {
    if (existing) existing.remove()
    return
  }

  const container = document.createElement('div')
  container.className = 'msg-tool'
  filtered.forEach(tool => {
    const details = document.createElement('details')
    details.className = 'msg-tool-item'
    const summary = document.createElement('summary')
    const status = tool.status === 'error' ? '失败' : '成功'
    const timeValue = getToolTime(tool) || resolveToolTime(tool.id || tool.tool_call_id, tool.messageTimestamp, tool.runId, sessionKey)
    const timeText = timeValue ? formatTime(new Date(timeValue)) : ''
    summary.innerHTML = `${escapeHtml(tool.name || '工具')} · ${status}${timeText ? ' · ' + timeText : ''}`
    const body = document.createElement('div')
    body.className = 'msg-tool-body'
    const inputJson = stripAnsi(safeStringify(tool.input))
    const outputJson = stripAnsi(safeStringify(tool.output))
    body.innerHTML = `<div class="msg-tool-block"><div class="msg-tool-title">参数</div><pre>${escapeHtml(inputJson || '无参数')}</pre></div>`
      + `<div class="msg-tool-block"><div class="msg-tool-title">结果</div><pre>${escapeHtml(outputJson || '无结果')}</pre></div>`
    details.appendChild(summary)
    details.appendChild(body)
    container.appendChild(details)
  })
  if (existing) existing.remove()
  el.insertBefore(container, el.firstChild)
}

/** 图片灯箱查看 */
function showLightbox(src) {
  const existing = document.querySelector('.chat-lightbox')
  if (existing) existing.remove()
  const lb = document.createElement('div')
  lb.className = 'chat-lightbox'
  lb.innerHTML = `<img src="${src}" class="chat-lightbox-img" />`
  lb.onclick = (e) => { if (e.target === lb || e.target.tagName !== 'IMG') lb.remove() }
  document.body.appendChild(lb)
  // ESC 关闭
  const onKey = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)
}

function ensureVirtualObserver() {
  if (_virtualObserver || typeof ResizeObserver === 'undefined') return
  _virtualObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const el = entry.target
      const id = el?.dataset?.vid
      if (!id) continue
      const h = Math.max(1, Math.ceil(entry.contentRect?.height || el.getBoundingClientRect().height))
      _virtualHeights.set(id, h)
      _virtualPrefixDirty = true
    }
  })
}

function insertMessageByTime(wrap, ts) {
  const tsValue = Number(ts || Date.now())
  wrap.dataset.ts = String(tsValue)

  if (!_virtualEnabled) {
    const items = Array.from(_messagesEl.querySelectorAll('.msg'))
    for (const node of items) {
      const nodeTs = parseInt(node.dataset.ts || '0', 10)
      if (nodeTs > tsValue) {
        _messagesEl.insertBefore(wrap, node)
        return
      }
    }
    _messagesEl.insertBefore(wrap, _typingEl)
    return
  }

  if (!wrap.dataset.vid) wrap.dataset.vid = uuid()
  ensureVirtualObserver()
  if (_virtualObserver) _virtualObserver.observe(wrap)
  const vid = wrap.dataset.vid
  const existingIdx = _virtualItems.findIndex(item => item.id === vid)
  const entry = { id: vid, ts: tsValue, node: wrap }
  if (existingIdx >= 0) _virtualItems.splice(existingIdx, 1)
  let insertIdx = _virtualItems.findIndex(item => item.ts > tsValue)
  if (insertIdx < 0) insertIdx = _virtualItems.length
  _virtualItems.splice(insertIdx, 0, entry)
  _virtualPrefixDirty = true
  requestVirtualRender(true)
}

function appendSystemMessage(text, ts) {
  const wrap = document.createElement('div')
  wrap.className = 'msg msg-system'
  wrap.textContent = text
  insertMessageByTime(wrap, ts)
  scrollToBottom()
  return wrap
}

function clearMessages() {
  _messagesEl.querySelectorAll('.msg').forEach(m => m.remove())
  _virtualItems = []
  _virtualHeights = new Map()
  _virtualAvgHeight = 64
  _virtualRange = { start: 0, end: 0, prefix: [0] }
  _virtualPrefix = [0]
  _virtualPrefixDirty = true
  if (_virtualObserver) { _virtualObserver.disconnect(); _virtualObserver = null }
  const state = getSessionState(_sessionKey)
  state.toolEventTimes.clear()
  state.toolEventData.clear()
  state.toolRunIndex.clear()
  state.toolEventSeen.clear()
  if (_virtualTopSpacer) { _virtualTopSpacer.remove(); _virtualTopSpacer = null }
  if (_virtualBottomSpacer) { _virtualBottomSpacer.remove(); _virtualBottomSpacer = null }
}

function showTyping(show) {
  if (_typingEl) _typingEl.style.display = show ? 'flex' : 'none'
  if (show) scrollToBottom()
}

function showCompactionHint(show) {
  let hint = _page?.querySelector('#compaction-hint')
  if (show && !hint && _messagesEl) {
    hint = document.createElement('div')
    hint.id = 'compaction-hint'
    hint.className = 'msg msg-system compaction-hint'
    hint.innerHTML = '正在整理上下文（Compaction）…'
    _messagesEl.insertBefore(hint, _typingEl)
    scrollToBottom()
  } else if (!show && hint) {
    hint.remove()
  }
}

function scrollToBottom(force = false) {
  if (!_messagesEl || !force) return
  if (_virtualEnabled) requestVirtualRender(true)
  requestAnimationFrame(() => {
    if (!_messagesEl) return
    _messagesEl.scrollTop = _messagesEl.scrollHeight
    requestAnimationFrame(() => {
      if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight
    })
  })
}

function ensureVirtualSpacers() {
  if (!_messagesEl) return
  if (!_virtualTopSpacer || _virtualTopSpacer.parentNode !== _messagesEl) {
    _virtualTopSpacer = document.createElement('div')
    _virtualTopSpacer.className = 'msg-virtual-spacer'
    _messagesEl.insertBefore(_virtualTopSpacer, _messagesEl.firstChild)
  }
  if (!_virtualBottomSpacer || _virtualBottomSpacer.parentNode !== _messagesEl) {
    _virtualBottomSpacer = document.createElement('div')
    _virtualBottomSpacer.className = 'msg-virtual-spacer'
    if (_typingEl && _typingEl.parentNode === _messagesEl) {
      _messagesEl.insertBefore(_virtualBottomSpacer, _typingEl)
    } else {
      _messagesEl.appendChild(_virtualBottomSpacer)
    }
  }
}

function requestVirtualRender(force = false) {
  if (!_virtualEnabled || !_messagesEl) return
  if (_virtualRenderPending && !force) return
  _virtualRenderPending = true
  requestAnimationFrame(() => {
    _virtualRenderPending = false
    doVirtualRender()
  })
}

function doVirtualRender() {
  if (!_virtualEnabled || !_messagesEl) return
  ensureVirtualSpacers()
  const scrollTop = _messagesEl.scrollTop
  const viewport = _messagesEl.clientHeight
  const items = _virtualItems
  if (_virtualPrefixDirty) {
    _virtualPrefix = buildPrefixHeights(items, _virtualHeights, _virtualAvgHeight)
    _virtualPrefixDirty = false
  }
  const prefix = _virtualPrefix
  const start = Math.max(0, findStartIndex(prefix, scrollTop) - VIRTUAL_OVERSCAN)
  const end = Math.min(items.length, start + VIRTUAL_WINDOW + VIRTUAL_OVERSCAN * 2)
  _virtualRange = { start, end, prefix }
  const { top, bottom } = getSpacerHeights(prefix, start, end)
  _virtualTopSpacer.style.height = `${top}px`
  _virtualBottomSpacer.style.height = `${bottom}px`

  const visibleIds = new Set(items.slice(start, end).map(i => i.id))
  _messagesEl.querySelectorAll('.msg').forEach(node => {
    const vid = node.dataset.vid
    if (!vid) return
    if (!visibleIds.has(vid)) node.remove()
  })

  const anchor = _virtualTopSpacer.nextSibling
  let refNode = anchor
  for (let i = start; i < end; i++) {
    const item = items[i]
    if (!item?.node) continue
    if (refNode && refNode.parentNode !== _messagesEl) refNode = _virtualBottomSpacer
    if (_virtualBottomSpacer && _virtualBottomSpacer.parentNode !== _messagesEl) {
      _messagesEl.appendChild(_virtualBottomSpacer)
    }
    if (item.node.parentNode !== _messagesEl) {
      _messagesEl.insertBefore(item.node, refNode || _virtualBottomSpacer)
    }
    refNode = item.node.nextSibling
  }

  requestAnimationFrame(() => {
    let total = 0
    let count = 0
    items.slice(start, end).forEach(item => {
      if (_virtualHeights.has(item.id)) return
      const el = item.node
      if (!el || !el.getBoundingClientRect) return
      const h = Math.max(1, Math.ceil(el.getBoundingClientRect().height))
      if (h) {
        _virtualHeights.set(item.id, h)
        _virtualPrefixDirty = true
        total += h
        count += 1
      }
    })
    if (count) _virtualAvgHeight = Math.max(24, Math.round(total / count))

    const newTop = _virtualTopSpacer.offsetHeight
    const delta = newTop - top
    if (delta !== 0) _messagesEl.scrollTop = scrollTop + delta
  })
}

function updateSendState() {
  if (!_sendBtn || !_textarea) return
  if (_isStreaming) {
    _sendBtn.disabled = false
    _sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    _sendBtn.title = '停止生成'
  } else {
    const locked = !!_hostedSessionConfig?.enabled && _hostedRuntime?.status !== HOSTED_STATUS.PAUSED
    _sendBtn.disabled = locked || (!_textarea.value.trim() && !_attachments.length)
    _sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
    _sendBtn.title = '发送'
  }
}

function updateStatusDot(status) {
  if (!_statusDot) return
  _statusDot.className = 'status-dot'
  if (status === 'ready' || status === 'connected') _statusDot.classList.add('online')
  else if (status === 'connecting' || status === 'reconnecting') _statusDot.classList.add('connecting')
  else _statusDot.classList.add('offline')
}

function resolveHostedSystemPrompt() {
  const base = (_hostedSessionConfig?.systemPrompt || _hostedDefaults?.systemPrompt || '').trim()
  if (base && HOSTED_FIXED_SYSTEM_PROMPT) return `${HOSTED_FIXED_SYSTEM_PROMPT}\n\n${base}`
  return HOSTED_FIXED_SYSTEM_PROMPT || base
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4))
}

function trimHostedHistoryByTokens(limit) {
  if (!_hostedSessionConfig?.history) return
  const systemPrompt = resolveHostedSystemPrompt()
  let items = _hostedSessionConfig.history.filter(m => m.role !== 'system')
  const maxItems = HOSTED_CONTEXT_MAX || 100
  if (items.length > maxItems) {
    items = items.slice(-maxItems)
  }
  const maxLimit = limit || _hostedSessionConfig.contextTokenLimit || HOSTED_DEFAULTS.contextTokenLimit || HOSTED_CONTEXT_TOKEN_LIMIT
  let tokens = systemPrompt ? estimateTokens(systemPrompt) : 0
  for (const item of items) tokens += estimateTokens(item.content)

  if (tokens > maxLimit) {
    let trimmed = [...items]
    while (trimmed.length && tokens > maxLimit) {
      const removed = trimmed.shift()
      tokens -= estimateTokens(removed?.content)
    }
    items = trimmed
  }

  _hostedSessionConfig.history = items
  _hostedRuntime.contextTokens = tokens
  _hostedRuntime.lastTrimAt = Date.now()
}

async function loadHostedDefaults() {
  _hostedDefaults = { ...HOSTED_DEFAULTS }
  try {
    const panel = await api.readPanelConfig()
    const stored = panel?.hostedAgent?.default || null
    if (stored) _hostedDefaults = { ..._hostedDefaults, ...stored }
    if (_hostedDefaults.prompt && !_hostedDefaults.systemPrompt) {
      _hostedDefaults.systemPrompt = _hostedDefaults.prompt
    }
    if (_hostedDefaults.systemPrompt && !_hostedDefaults.prompt) {
      _hostedDefaults.prompt = _hostedDefaults.systemPrompt
    }
  } catch (e) {
    console.warn('[chat][hosted] 读取 panel 配置失败:', e)
  }
}

function getHostedSessionKey() {
  return _sessionKey || localStorage.getItem(STORAGE_SESSION_KEY) || 'agent:main:main'
}

function getHostedBoundSessionKey() {
  return _hostedSessionConfig?.boundSessionKey || getHostedSessionKey()
}

function saveHostedSessionConfigForKey(key, nextConfig) {
  let data = {}
  try { data = JSON.parse(localStorage.getItem(HOSTED_SESSIONS_KEY) || '{}') } catch { data = {} }
  data[key] = nextConfig
  localStorage.setItem(HOSTED_SESSIONS_KEY, JSON.stringify(data))
}

function buildHostedStateFromStorage(key) {
  let data = {}
  try { data = JSON.parse(localStorage.getItem(HOSTED_SESSIONS_KEY) || '{}') } catch { data = {} }
  const current = data[key] || {}
  const config = { ...HOSTED_DEFAULTS, ..._hostedDefaults, ...current }
  if (!config.boundSessionKey) config.boundSessionKey = key
  if (!config.systemPrompt && config.prompt) config.systemPrompt = config.prompt
  if (!config.prompt && config.systemPrompt) config.prompt = config.systemPrompt
  if (!config.contextTokenLimit) config.contextTokenLimit = _hostedDefaults?.contextTokenLimit || HOSTED_DEFAULTS.contextTokenLimit
  if (!config.state) config.state = { ...HOSTED_RUNTIME_DEFAULT }
  if (!config.history) config.history = []
  config.history = config.history.filter(m => m.role !== 'system')
  const runtime = { ...HOSTED_RUNTIME_DEFAULT, ...config.state }
  return {
    sessionKey: key,
    config,
    runtime,
    seeded: config.history.length > 0,
    busy: false,
    lastTargetTs: 0,
    lastTargetHash: '',
    lastSentHash: '',
    lastCompletionRunId: '',
  }
}

function syncHostedGlobalsFromState(state) {
  _hostedSessionConfig = state.config
  _hostedRuntime = state.runtime
  _hostedSeeded = state.seeded
  _hostedBusy = state.busy
  _hostedLastTargetTs = state.lastTargetTs
  _hostedLastTargetHash = state.lastTargetHash || ''
  _hostedLastSentHash = state.lastSentHash
  _hostedLastCompletionRunId = state.lastCompletionRunId
}

function syncHostedStateFromGlobals(state) {
  state.config = _hostedSessionConfig
  state.runtime = _hostedRuntime
  state.seeded = _hostedSeeded
  state.busy = _hostedBusy
  state.lastTargetTs = _hostedLastTargetTs
  state.lastTargetHash = _hostedLastTargetHash
  state.lastSentHash = _hostedLastSentHash
  state.lastCompletionRunId = _hostedLastCompletionRunId
}

function withHostedState(sessionKey, fn) {
  const prev = {
    config: _hostedSessionConfig,
    runtime: _hostedRuntime,
    seeded: _hostedSeeded,
    busy: _hostedBusy,
    lastTargetTs: _hostedLastTargetTs,
    lastTargetHash: _hostedLastTargetHash,
    lastSentHash: _hostedLastSentHash,
    lastCompletionRunId: _hostedLastCompletionRunId,
  }
  const key = sessionKey || getHostedSessionKey()
  const state = getHostedState(key)
  syncHostedGlobalsFromState(state)
  try {
    return fn()
  } finally {
    syncHostedStateFromGlobals(state)
    _hostedStates.set(key, state)
    saveHostedSessionConfigForKey(key, state.config)
    _hostedSessionConfig = prev.config
    _hostedRuntime = prev.runtime
    _hostedSeeded = prev.seeded
    _hostedBusy = prev.busy
    _hostedLastTargetTs = prev.lastTargetTs
    _hostedLastTargetHash = prev.lastTargetHash
    _hostedLastSentHash = prev.lastSentHash
    _hostedLastCompletionRunId = prev.lastCompletionRunId
  }
}

async function withHostedStateAsync(sessionKey, fn) {
  const prev = {
    config: _hostedSessionConfig,
    runtime: _hostedRuntime,
    seeded: _hostedSeeded,
    busy: _hostedBusy,
    lastTargetTs: _hostedLastTargetTs,
    lastTargetHash: _hostedLastTargetHash,
    lastSentHash: _hostedLastSentHash,
    lastCompletionRunId: _hostedLastCompletionRunId,
  }
  const key = sessionKey || getHostedSessionKey()
  const state = getHostedState(key)
  syncHostedGlobalsFromState(state)
  try {
    return await fn()
  } finally {
    syncHostedStateFromGlobals(state)
    _hostedStates.set(key, state)
    saveHostedSessionConfigForKey(key, state.config)
    _hostedSessionConfig = prev.config
    _hostedRuntime = prev.runtime
    _hostedSeeded = prev.seeded
    _hostedBusy = prev.busy
    _hostedLastTargetTs = prev.lastTargetTs
    _hostedLastTargetHash = prev.lastTargetHash
    _hostedLastSentHash = prev.lastSentHash
    _hostedLastCompletionRunId = prev.lastCompletionRunId
  }
}

function getHostedState(sessionKey) {
  const key = sessionKey || getHostedSessionKey()
  if (_hostedStates.has(key)) return _hostedStates.get(key)
  const state = buildHostedStateFromStorage(key)
  _hostedStates.set(key, state)
  return state
}

function markHostedHistoryStale(sessionKey = getHostedBoundSessionKey()) {
  const key = sessionKey || getHostedBoundSessionKey()
  if (!key) return
  _hostedHistoryRefreshKeys.add(key)
}

async function refreshHostedHistoryIfNeeded(options = {}) {
  const { limit = 100, force = false, sessionKey } = options
  const key = sessionKey || getHostedBoundSessionKey()
  if (!key || !wsClient.gatewayReady) return
  if (!force && !_hostedHistoryRefreshKeys.has(key)) return
  try {
    await ensureHostedHistorySeeded(key, limit, true)
    _hostedHistoryRefreshKeys.delete(key)
  } catch (e) {
    console.warn('[chat][hosted] 刷新历史失败:', e)
    _hostedHistoryRefreshKeys.add(key)
  }
}

function loadHostedSessionConfig() {
  const key = getHostedSessionKey()
  const state = getHostedState(key)
  syncHostedGlobalsFromState(state)
  trimHostedHistoryByTokens()
  updateHostedBadge()
}

function saveHostedSessionConfig(nextConfig) {
  saveHostedSessionConfigForKey(getHostedSessionKey(), nextConfig)
}

function persistHostedRuntime(sessionKey) {
  const key = sessionKey || getHostedSessionKey()
  const state = getHostedState(key)
  syncHostedStateFromGlobals(state)
  state.config.state = { ...state.runtime }
  _hostedStates.set(key, state)
  saveHostedSessionConfigForKey(key, state.config)
}

function syncHostedSpecialBubble() {
  const boundKey = getHostedBoundSessionKey()
  if (!_hostedSessionConfig?.enabled || boundKey !== _sessionKey) {
    if (_messagesEl) upsertStableSystemBubble({ statusKey: 'hosted-special', active: false })
    return
  }
  const specialText = String(_hostedRuntime?.lastSpecialText || '').trim()
  if (!specialText) {
    if (_messagesEl) upsertStableSystemBubble({ statusKey: 'hosted-special', active: false })
    return
  }
  upsertStableSystemBubble({
    statusKey: 'hosted-special',
    text: specialText,
    statusType: 'hosted-special',
    ts: _hostedRuntime?.lastSpecialTs || Date.now(),
    active: true,
  })
}

function updateHostedBadge() {
  if (!_hostedBadgeEl || !_hostedSessionConfig) return
  const status = _hostedRuntime.status || HOSTED_STATUS.IDLE
  const enabled = _hostedSessionConfig.enabled
  let text = '未启用'
  let cls = 'chat-hosted-badge'
  if (!enabled) {
    text = '未启用'
    cls += ' idle'
  } else if (status === HOSTED_STATUS.RUNNING) {
    text = _hostedRuntime.lastAction === 'generating-reply' ? '生成回复中' : '运行中'
    cls += ' running'
  } else if (status === HOSTED_STATUS.WAITING) {
    text = '等待回复'
    cls += ' waiting'
  } else if (status === HOSTED_STATUS.PAUSED) {
    text = _hostedRuntime.lastAction === 'disconnected' ? '等待重连' : '已暂停'
    cls += ' paused'
  } else if (status === HOSTED_STATUS.ERROR) {
    text = '异常'
    cls += ' error'
  } else {
    text = '待命'
    cls += ' idle'
  }
  _hostedBadgeEl.className = cls
  _hostedBadgeEl.textContent = text
  syncHostedStatusBubble(text)
  syncHostedSpecialBubble()
}

function syncHostedStatusBubble(label) {
  if (!_hostedSessionConfig?.enabled || getHostedBoundSessionKey() !== _sessionKey) {
    if (_messagesEl) upsertStableSystemBubble({ statusKey: 'hosted-status', active: false })
    return
  }
  const status = _hostedRuntime.status || HOSTED_STATUS.IDLE
  const active = status === HOSTED_STATUS.RUNNING || status === HOSTED_STATUS.WAITING || status === HOSTED_STATUS.ERROR || status === HOSTED_STATUS.PAUSED
  if (!active) {
    upsertStableSystemBubble({ statusKey: 'hosted-status', active: false })
    return
  }
  const reasons = []
  if (_hostedRuntime.stepCount) reasons.push(`步数 ${_hostedRuntime.stepCount}`)
  const actionLabel = formatHostedActionLabel(_hostedRuntime.lastAction)
  if (actionLabel) reasons.push(`最近动作 ${actionLabel}`)
  if (_hostedRuntime.pending) reasons.push('等待下一步触发')
  if (status === HOSTED_STATUS.WAITING) reasons.push('等待对面回复')
  if (_hostedRuntime.lastError && status === HOSTED_STATUS.ERROR) reasons.push(`错误 ${_hostedRuntime.lastError}`)
  let text = `托管 Agent 状态：${label}`
  if (reasons.length) text += ` | ${reasons.join(' | ')}`
  const node = upsertStableSystemBubble({
    statusKey: 'hosted-status',
    text,
    statusType: 'hosted-status',
    ts: _hostedRuntime.lastRunAt || Date.now(),
    active: true,
  })
  if (node) node.dataset.hostedStatus = status
}

function renderHostedPanel() {
  if (!_hostedPanelEl || !_hostedSessionConfig) return
  if (_hostedPromptEl) _hostedPromptEl.value = _hostedSessionConfig.prompt || ''
  if (_hostedEnableEl) _hostedEnableEl.checked = !!_hostedSessionConfig.enabled
  const boundEl = _hostedPanelEl.querySelector('#hosted-agent-bound')
  if (boundEl) boundEl.textContent = `绑定会话：${_hostedSessionConfig.boundSessionKey || '未知'}`
  if (_hostedMaxStepsEl) _hostedMaxStepsEl.value = _hostedSessionConfig.maxSteps || HOSTED_DEFAULTS.maxSteps
  if (_hostedContextLimitEl) _hostedContextLimitEl.value = _hostedSessionConfig.contextTokenLimit || HOSTED_DEFAULTS.contextTokenLimit
  const statusEl = _hostedPanelEl.querySelector('#hosted-agent-status')
  if (statusEl) {
    let msg = '状态正常'
    if (_hostedRuntime.status === HOSTED_STATUS.RUNNING && _hostedRuntime.lastAction === 'generating-reply') msg = '正在生成回复'
    else if (_hostedRuntime.lastAction === 'resume-latest-target') msg = '已接管最新回复，准备继续'
    else if (_hostedRuntime.status === HOSTED_STATUS.WAITING) msg = '等待对端下一条回复'
    else if (_hostedRuntime.status === HOSTED_STATUS.PAUSED && _hostedRuntime.lastAction === 'disconnected') msg = '连接断开，等待重连'
    else if (_hostedRuntime.status === HOSTED_STATUS.PAUSED) msg = '已暂停，历史保留'
    else if (_hostedRuntime.lastAction === 'stopped') msg = '已停止，历史已清空'
    if (_hostedRuntime.status === HOSTED_STATUS.ERROR) msg = `异常: ${_hostedRuntime.lastError || '未知错误'}`
    if (_hostedRuntime.lastError && _hostedRuntime.status !== HOSTED_STATUS.ERROR) msg = `上次错误: ${_hostedRuntime.lastError}`
    statusEl.textContent = msg
  }
  syncHostedSpecialBubble()
}

async function saveHostedConfig() {
  if (!_hostedSessionConfig) return
  const prompt = (_hostedPromptEl?.value || '').trim()
  const enabled = !!_hostedEnableEl?.checked
  const maxSteps = Math.max(1, parseInt(_hostedMaxStepsEl?.value || HOSTED_DEFAULTS.maxSteps, 10))
  const contextTokenLimit = Math.max(1000, parseInt(_hostedContextLimitEl?.value || HOSTED_DEFAULTS.contextTokenLimit, 10))
  const stepDelayMs = _hostedSessionConfig.stepDelayMs ?? HOSTED_DEFAULTS.stepDelayMs
  const retryLimit = _hostedSessionConfig.retryLimit ?? HOSTED_DEFAULTS.retryLimit

  if (!prompt && enabled) { toast('请输入初始提示词', 'warning'); return }

  _hostedSessionConfig = {
    ..._hostedSessionConfig,
    prompt,
    systemPrompt: prompt,
    contextTokenLimit,
    enabled,
    autoRunAfterTarget: true,
    stopPolicy: 'self',
    maxSteps,
    stepDelayMs,
    retryLimit,
    boundSessionKey: _sessionKey,
  }

  if (!_hostedSessionConfig.history) _hostedSessionConfig.history = []
  _hostedSessionConfig.history = _hostedSessionConfig.history.filter(m => m.role !== 'system')

  if (!_hostedSessionConfig.state) _hostedSessionConfig.state = { ...HOSTED_RUNTIME_DEFAULT }
  _hostedRuntime = { ...HOSTED_RUNTIME_DEFAULT, ..._hostedSessionConfig.state }
  if (enabled && _hostedRuntime.status === HOSTED_STATUS.PAUSED) _hostedRuntime.status = HOSTED_STATUS.IDLE
  _hostedRuntime.lastAction = enabled ? '' : _hostedRuntime.lastAction
  persistHostedRuntime()
  renderHostedPanel()
  updateHostedBadge()
  updateHostedInputLock()

  if (enabled && _hostedRuntime.status === HOSTED_STATUS.IDLE) {
    if (!wsClient.gatewayReady || !_sessionKey) {
      toast('Gateway 未就绪，暂不启动', 'warning')
    } else {
      const hostedKey = getHostedBoundSessionKey()
      markHostedHistoryStale(hostedKey)
      await refreshHostedHistoryIfNeeded({ limit: 100, force: true, sessionKey: hostedKey })
      const latestExternal = [...(_hostedSessionConfig.history || [])].reverse().find(item => item && (item.role === 'assistant' || item.role === 'user') && String(item.content || '').trim())
      const canResumeFromAssistant = latestExternal?.role === 'assistant'
      if (canResumeFromAssistant) {
        _hostedLastTargetTs = Number(latestExternal.ts || Date.now())
        _hostedLastTargetHash = buildHostedTargetHash(latestExternal.content, _hostedLastTargetTs)
        _hostedRuntime.status = HOSTED_STATUS.IDLE
        _hostedRuntime.lastAction = 'resume-latest-target'
        persistHostedRuntime()
        updateHostedBadge()
        updateHostedInputLock()
        appendHostedOutput(`检测到对端最新回复，立即从当前上下文继续${formatHostedSummary()}`)
        runHostedAgentStepForSession(hostedKey)
      } else {
        _hostedRuntime.status = HOSTED_STATUS.WAITING
        _hostedRuntime.lastAction = 'waiting-target'
        persistHostedRuntime()
        updateHostedBadge()
        updateHostedInputLock()
        appendHostedOutput(`等待对端新回复后再继续${formatHostedSummary()}`)
      }
    }
  }

  if (_hostedGlobalSyncEl?.checked) {
    try {
      const panel = await api.readPanelConfig()
      const nextPanel = { ...(panel || {}) }
      if (!nextPanel.hostedAgent) nextPanel.hostedAgent = {}
      nextPanel.hostedAgent.default = {
        ...HOSTED_DEFAULTS,
        prompt,
        systemPrompt: prompt,
        contextTokenLimit,
        enabled,
        maxSteps,
        stepDelayMs,
        retryLimit,
      }
      await api.writePanelConfig(nextPanel)
      toast('已同步为全局默认', 'success')
    } catch (e) {
      toast('同步全局默认失败: ' + (e.message || e), 'error')
    }
  }

  if (enabled) toast('托管 Agent 已启用', 'success')
  else toast('托管 Agent 已保存', 'info')
}

function pauseHostedAgent() {
  if (!_hostedSessionConfig) return
  _hostedRuntime.status = HOSTED_STATUS.PAUSED
  _hostedRuntime.pending = false
  _hostedRuntime.lastAction = 'paused'
  persistHostedRuntime()
  updateHostedBadge()
  markHostedHistoryStale()
  updateHostedInputLock()
  toast('托管 Agent 已暂停', 'info')
}

function stopHostedAgent() {
  if (!_hostedSessionConfig) return
  _hostedRuntime.status = HOSTED_STATUS.IDLE
  _hostedRuntime.pending = false
  _hostedRuntime.stepCount = 0
  _hostedRuntime.lastError = ''
  _hostedRuntime.errorCount = 0
  _hostedRuntime.contextTokens = 0
  _hostedRuntime.lastTrimAt = 0
  _hostedRuntime.lastRunId = ''
  _hostedRuntime.lastRunAt = 0
  _hostedRuntime.lastAction = 'stopped'
  _hostedRuntime.lastSpecialText = ''
  _hostedRuntime.lastSpecialTs = 0
  _hostedSessionConfig.history = []
  _hostedSessionConfig.enabled = false
  _hostedSeeded = false
  _hostedLastTargetTs = 0
  _hostedLastTargetHash = ''
  _hostedLastSentHash = ''
  _askUserBlockedNotice = false
  persistHostedRuntime()
  updateHostedBadge()
  updateHostedInputLock()
  toast('托管 Agent 已停止', 'info')
}

function shouldCaptureHostedTarget(payload) {
  const result = shouldCaptureHostedTargetCore(payload, {
    hostedSessionConfig: _hostedSessionConfig,
    hostedRuntime: _hostedRuntime,
    boundSessionKey: getHostedBoundSessionKey(),
    extractChatContent,
    buildHostedTargetHash,
    lastTargetHash: _hostedLastTargetHash,
  })
  if (!result.capture) return false
  _hostedLastTargetTs = result.ts
  _hostedLastTargetHash = result.hash
  return true
}

function appendHostedTarget(text, ts) {
  pushHostedHistoryEntry('assistant', text, ts)
}

function maybeTriggerHostedRun() {
  if (!shouldAutoTriggerHostedRun(_hostedSessionConfig, _hostedRuntime)) return
  const action = prepareHostedRunTrigger(_hostedRuntime, wsClient.gatewayReady)
  if (!action.run) {
    if (action.needsPersist) {
      persistHostedRuntime()
      updateHostedBadge()
      updateHostedInputLock()
    }
    return
  }
  runHostedAgentStepForSession(getHostedBoundSessionKey())
}

function pushHostedHistoryEntry(role, content, ts = Date.now(), options = {}) {
  if (!_hostedSessionConfig) return false
  if (!_hostedSessionConfig.history) _hostedSessionConfig.history = []
  const result = pushHostedHistoryEntryCore(_hostedSessionConfig.history, role, content, ts, options)
  _hostedSessionConfig.history = result.history
  trimHostedHistoryByTokens()
  if (options.persist !== false) persistHostedRuntime(options.sessionKey)
  return result.changed
}

function buildHostedMessages() {
  trimHostedHistoryByTokens()
  return buildHostedMessagesCore(
    _hostedSessionConfig?.history || [],
    resolveHostedSystemPrompt(),
    HOSTED_CONTEXT_MAX || 100,
  )
}

function detectStopFromText(text) {
  if (!text) return false
  return /\b(完成|无需继续|结束|停止|done|stop|final)\b/i.test(text)
}

async function ensureHostedHistorySeeded(sessionKey, limit = 200, force = false) {
  const key = sessionKey || getHostedBoundSessionKey()
  if (!key || !wsClient.gatewayReady) return
  if (!force && _hostedSeeded && _hostedSessionConfig?.history?.length) return
  try {
    const result = await wsClient.chatHistory(key, limit)
    const messages = result?.messages || []
    const deduped = dedupeHistory(messages)
    const seeded = buildSeededHostedHistory(deduped, HOSTED_CONTEXT_MAX || 100)
    if (seeded.length) {
      const remoteLastTs = seeded.reduce((max, item) => Math.max(max, Number(item.ts || 0)), 0)
      const localHistory = Array.isArray(_hostedSessionConfig.history) ? _hostedSessionConfig.history : []
      const localLastTs = localHistory.reduce((max, item) => Math.max(max, Number(item?.ts || 0)), 0)
      const shouldReplace = force || !localHistory.length || remoteLastTs >= localLastTs
      if (shouldReplace) {
        _hostedSessionConfig.history = seeded
        trimHostedHistoryByTokens()
        persistHostedRuntime(key)
      }
    }
    _hostedSeeded = true
  } catch (e) {
    console.warn('[chat][hosted] 历史注入失败:', e)
  }
}

async function runHostedAgentStepForSession(sessionKey) {
  const key = sessionKey || getHostedBoundSessionKey()
  if (!key) return
  if (key === getHostedSessionKey()) {
    await refreshHostedHistoryIfNeeded({ limit: 100, force: true, sessionKey: key })
    await ensureHostedHistorySeeded(key)
    return runHostedAgentStep()
  }
  return withHostedStateAsync(key, async () => {
    if (_hostedSessionConfig?.boundSessionKey !== key) {
      _hostedSessionConfig.boundSessionKey = key
    }
    await refreshHostedHistoryIfNeeded({ limit: 100, force: true, sessionKey: key })
    await ensureHostedHistorySeeded(key)
    return runHostedAgentStep()
  })
}

async function runHostedAgentStep() {
  if (!_hostedSessionConfig) {
    loadHostedSessionConfig()
    if (!_hostedSessionConfig) return
  }
  if (_hostedBusy || !_hostedSessionConfig.enabled) return
  const boundKey = getHostedBoundSessionKey()
  const start = validateHostedStepStart(_hostedSessionConfig, _hostedRuntime, wsClient.gatewayReady, boundKey)
  if (!start.ok) {
    persistHostedRuntime()
    updateHostedBadge()
    if (start.reason === 'gateway') {
      appendHostedOutput(`需要人工介入: Gateway 未就绪或 sessionKey 缺失${formatHostedSummary()}`)
    } else if (start.reason === 'retry-limit') {
      appendHostedOutput(`需要人工介入: 连续错误超过阈值${formatHostedSummary()}`)
    }
    return
  }

  _hostedBusy = true
  _currentRunId = beginHostedStep(_hostedRuntime, uuid)
  persistHostedRuntime()
  updateHostedBadge()

  const delay = getHostedStepDelay(_hostedSessionConfig)
  if (delay > 0) {
    await new Promise(r => setTimeout(r, delay))
  }

  try {
    markHostedGenerating(_hostedRuntime)
    persistHostedRuntime()
    updateHostedBadge()
    const messages = buildHostedMessages()
    const result = await callHostedAI(messages)
    const resultText = result?.text || ''
    const parsed = parseHostedTemplate(resultText)
    if (!parsed) {
      applyHostedTemplateError(_hostedRuntime)
      persistHostedRuntime()
      updateHostedBadge()
      updateHostedInputLock()
      appendHostedOutput(`托管 Agent 输出未符合模板${formatHostedSummary()}`)
      return
    }

    applyHostedStepSuccess(_hostedRuntime)

    const rendered = renderHostedTemplate(parsed)
    pushHostedHistoryEntry('developer', rendered, Date.now())

    appendHostedOutput(`${rendered}${formatHostedSummary()}`)

    persistHostedRuntime()
    updateHostedBadge()

    if (_hostedSessionConfig.stopPolicy === 'self' && detectStopFromText(rendered)) {
      applyHostedSelfStop(_hostedRuntime)
      persistHostedRuntime()
      updateHostedBadge()
      if (_hostedRuntime.lastRunId && _hostedLastCompletionRunId !== _hostedRuntime.lastRunId) {
        _hostedLastCompletionRunId = _hostedRuntime.lastRunId
        showHostedCompletionModal(formatHostedSummary(), rendered)
      }
    }
  } catch (e) {
    _hostedRuntime.lastError = e.message || String(e)
    const failure = applyHostedStepFailure(_hostedRuntime, _hostedSessionConfig.retryLimit)
    if (failure.terminal) {
      updateHostedBadge()
      persistHostedRuntime()
      appendHostedOutput(`需要人工介入: 连续错误超过阈值${formatHostedSummary()}`)
      return
    }
    persistHostedRuntime()
    updateHostedBadge()
    const retryDelay = getHostedStepDelay(_hostedSessionConfig)
    setTimeout(() => {
      _hostedBusy = false
      runHostedAgentStepForSession(getHostedBoundSessionKey())
    }, retryDelay)
    return
  } finally {
    _hostedBusy = false
  }
}

function resolveHostedTools(config) {
  const policy = _hostedSessionConfig?.toolPolicy || 'inherit'
  if (policy === 'off') return []
  const mode = policy === 'readonly' ? 'plan' : 'execute'
  return getEnabledTools({ config, mode }).filter(tool => tool?.name !== 'ask_user')
}

async function hostedExecTool({ name, args }) {
  switch (name) {
    case 'run_command':
      return await api.assistantExec(args.command, args.cwd)
    case 'read_file':
      return await api.assistantReadFile(args.path)
    case 'write_file':
      return await api.assistantWriteFile(args.path, args.content)
    case 'list_directory':
      return await api.assistantListDir(args.path)
    case 'get_system_info':
      return await api.assistantSystemInfo()
    case 'list_processes':
      return await api.assistantListProcesses(args.filter)
    case 'check_port':
      return await api.assistantCheckPort(args.port)
    case 'web_search':
      return await api.assistantWebSearch(args.query, args.max_results)
    case 'fetch_url':
      return await api.assistantFetchUrl(args.url)
    case 'skills_list': {
      const data = await api.skillsList()
      const skills = data?.skills || []
      const eligible = skills.filter(s => s.eligible && !s.disabled)
      const missing = skills.filter(s => !s.eligible && !s.disabled)
      const disabled = skills.filter(s => s.disabled)
      let summary = `共 ${skills.length} 个 Skills: ${eligible.length} 可用, ${missing.length} 缺依赖, ${disabled.length} 已禁用\n\n`
      if (eligible.length) summary += `## 可用 (${eligible.length})\n` + eligible.map(s => `- ${s.emoji || ''} **${s.name}**: ${s.description || ''}${s.bundled ? ' [内置]' : ''}`.trim()).join('\n') + '\n\n'
      if (missing.length) summary += `## 缺依赖 (${missing.length})\n` + missing.map(s => {
        const m = s.missing || {}
        const deps = [...(m.bins||[]), ...(m.env||[]).map(e=>'$'+e), ...(m.config||[])].join(', ')
        const installs = (s.install||[]).map(i => i.label).join(' / ')
        return `- ${s.emoji || ''} **${s.name}**: 缺少 ${deps}${installs ? ' · 可用安装: ' + installs : ''}`.trim()
      }).join('\n') + '\n\n'
      if (disabled.length) summary += `## 已禁用 (${disabled.length})\n` + disabled.map(s => `- ${s.emoji || ''} **${s.name}**: ${s.description || ''}`.trim()).join('\n') + '\n'
      return summary
    }
    case 'skills_info':
      return JSON.stringify(await api.skillsInfo(args.name), null, 2)
    case 'skills_check':
      return JSON.stringify(await api.skillsCheck(), null, 2)
    case 'skills_install_dep':
      return JSON.stringify(await api.skillsInstallDep(args.kind, args.spec), null, 2)
    case 'skills_clawhub_search':
      return JSON.stringify(await api.skillsClawhubSearch(args.query), null, 2)
    default:
      return `未支持的工具: ${name}`
  }
}

function appendHostedUserReplyToHistory(answer, ts = Date.now()) {
  pushHostedHistoryEntry('user', answer || '', ts, { sessionKey: getHostedBoundSessionKey() })
}

async function commitHostedUserReply(answer, sessionKey, ts = Date.now()) {
  const targetSessionKey = sessionKey || getHostedBoundSessionKey() || _sessionKey
  const finalAnswer = answer || ''
  const optimistic = buildHostedOptimisticUserMessage(finalAnswer, ts)
  const optimisticWrap = appendUserMessage(finalAnswer, [], new Date(ts))
  stampHistoryNode(optimisticWrap, optimistic.message)
  if (targetSessionKey) {
    saveMessage({
      id: uuid(),
      sessionKey: targetSessionKey,
      ...optimistic.storage,
    })
  }
  appendHostedUserReplyToHistory(finalAnswer, ts)
  if (targetSessionKey && wsClient.gatewayReady) {
    try {
      await wsClient.chatSend(targetSessionKey, finalAnswer)
    } catch {}
  }
}

function createAskUserBubble({ question, type, options, placeholder, toolId, sessionKey, skipLabel = '跳过', skipValue = '用户跳过了该问题', onSubmit }) {
  return new Promise((resolve) => {
    if (!_messagesEl) { resolve(''); return }
    if (toolId && _askUserToolHandled.has(toolId)) { resolve(''); return }
    if (toolId) _askUserToolHandled.add(toolId)
    const targetSessionKey = sessionKey || _sessionKey
    const ts = Date.now()
    const promptWrap = appendAiMessage(question || '请提供信息', new Date(ts), [], [], [], [], [], targetSessionKey)
    promptWrap.classList.add('msg-hosted')
    const bubble = promptWrap.querySelector('.msg-bubble') || promptWrap
    const cardId = 'chat-ask-user-' + ts
    const optionsHtml = (options || []).map((opt) => {
      const inputType = type === 'multiple' ? 'checkbox' : 'radio'
      return `<label class="ast-ask-option"><input type="${inputType}" name="${cardId}" value="${escapeHtml(opt)}"><span>${escapeHtml(opt)}</span></label>`
    }).join('')
    const textHtml = type === 'text' || !options?.length
      ? `<textarea class="ast-ask-text" placeholder="${escapeHtml(placeholder || '请输入...')}" rows="2"></textarea>`
      : ''
    const customHtml = type !== 'text' && options?.length
      ? `<div class="ast-ask-custom"><input type="text" class="ast-ask-custom-input" placeholder="请输入自定义内容..."></div>`
      : ''
    const card = document.createElement('div')
    card.className = 'ast-ask-card'
    card.id = cardId
    card.innerHTML = `
      ${optionsHtml ? `<div class="ast-ask-options">${optionsHtml}</div>` : ''}
      ${customHtml}
      ${textHtml}
      <div class="ast-ask-actions">
        <button class="ast-ask-submit btn btn-primary btn-sm">确认</button>
        <button class="ast-ask-skip btn btn-secondary btn-sm">${escapeHtml(skipLabel)}</button>
      </div>
    `
    bubble.appendChild(card)
    scrollToBottom()
    const buildAnswer = () => {
      if (type === 'text' || (!options?.length)) {
        return card.querySelector('.ast-ask-text')?.value?.trim() || ''
      }
      if (type === 'multiple') {
        const checked = [...card.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value)
        const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
        if (custom) checked.push(custom)
        return checked.join('、') || '未选择'
      }
      const checked = card.querySelector('input[type="radio"]:checked')
      const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
      return custom || checked?.value || '未选择'
    }
    const submit = async (answer) => {
      const finalAnswer = answer || ''
      card.remove()
      try {
        await commitHostedUserReply(finalAnswer, targetSessionKey, Date.now())
        if (typeof onSubmit === 'function') {
          await onSubmit({ answer: finalAnswer, sessionKey: targetSessionKey, wrap: promptWrap, card: bubble })
        }
      } finally {
        resolve(finalAnswer)
      }
    }
    card.querySelector('.ast-ask-submit').addEventListener('click', () => { void submit(buildAnswer()) })
    card.querySelector('.ast-ask-skip').addEventListener('click', () => { void submit(skipValue) })
  })
}

function showAskUserCardChatAsync({ question, type, options, placeholder, toolId, sessionKey, skipLabel = '跳过', skipValue = '用户跳过了该问题', onSubmit }) {
  return createAskUserBubble({ question, type, options, placeholder, toolId, sessionKey, skipLabel, skipValue, onSubmit })
}

async function callHostedAI(messages) {
  const config = await loadHostedAssistantConfig()
  const apiType = normalizeApiType(config.apiType)
  if (!config.baseUrl || !config.model || (requiresApiKey(apiType) && !config.apiKey)) {
    throw new Error('托管 Agent 未配置模型（请在 AI 助手页面配置）')
  }
  const tools = resolveHostedTools(config)
  const adapters = {
    execTool: hostedExecTool,
    confirm: async () => true,
    askUser: async () => ({ message: '托管模式已启用自动执行，不再向用户发起确认或补充询问。请基于现有上下文继续执行。' }),
    knowledgeBase: OPENCLAW_KB,
  }
  if (_hostedAbort) { _hostedAbort.abort(); _hostedAbort = null }
  _hostedAbort = new AbortController()
  const timeout = setTimeout(() => {
    if (_hostedAbort) _hostedAbort.abort()
  }, 120000)
  try {
    return await callAIWithTools({ config, messages, tools, adapters, mode: 'execute' })
  } finally {
    clearTimeout(timeout)
    _hostedAbort = null
  }
}

async function loadHostedAssistantConfig() {
  try {
    const raw = localStorage.getItem('clawpanel-assistant')
    const stored = raw ? JSON.parse(raw) : {}
    return {
      baseUrl: stored.baseUrl || '',
      apiKey: stored.apiKey || '',
      model: stored.model || '',
      temperature: stored.temperature || 0.7,
      apiType: stored.apiType || 'openai-completions',
    }
  } catch {
    return { baseUrl: '', apiKey: '', model: '', temperature: 0.7, apiType: 'openai-completions' }
  }
}

function normalizeApiType(raw) {
  const type = (raw || '').trim()
  if (type === 'anthropic' || type === 'anthropic-messages') return 'anthropic-messages'
  if (type === 'google-gemini') return 'google-gemini'
  if (type === 'openai' || type === 'openai-completions' || type === 'openai-responses') return 'openai-completions'
  return 'openai-completions'
}

function requiresApiKey(apiType) {
  const type = normalizeApiType(apiType)
  return type === 'anthropic-messages' || type === 'google-gemini'
}

function cleanBaseUrl(raw, apiType) {
  let base = (raw || '').replace(/\/+$/, '')
  base = base.replace(/\/api\/chat\/?$/, '')
  base = base.replace(/\/api\/generate\/?$/, '')
  base = base.replace(/\/api\/tags\/?$/, '')
  base = base.replace(/\/api\/?$/, '')
  base = base.replace(/\/chat\/completions\/?$/, '')
  base = base.replace(/\/completions\/?$/, '')
  base = base.replace(/\/responses\/?$/, '')
  base = base.replace(/\/messages\/?$/, '')
  base = base.replace(/\/models\/?$/, '')
  const type = normalizeApiType(apiType)
  if (type === 'anthropic-messages') {
    if (!base.endsWith('/v1')) base += '/v1'
    return base
  }
  if (type === 'google-gemini') return base
  if (/:(11434)$/i.test(base) && !base.endsWith('/v1')) return `${base}/v1`
  return base
}

function authHeaders(apiType, apiKey) {
  const type = normalizeApiType(apiType)
  if (type === 'anthropic-messages') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (apiKey) headers['x-api-key'] = apiKey
    return headers
  }
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

async function fetchWithRetry(url, options, retries = 2) {
  const delays = [800, 1600, 3200]
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, options)
      if (resp.ok || resp.status < 500 || i >= retries) return resp
      await new Promise(r => setTimeout(r, delays[i]))
    } catch (err) {
      if (options?.signal?.aborted) throw err
      if (i >= retries) throw err
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
}

async function readSSEStream(resp, onEvent, signal) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let aborted = false
  const onAbort = () => { aborted = true }
  if (signal) signal.addEventListener('abort', onAbort)
  try {
    while (true) {
      if (aborted) throw new Error('托管流式请求已中止')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return
        try { onEvent(JSON.parse(data)) } catch {}
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    try { reader.cancel() } catch {}
  }
}

async function callChatCompletionsHosted(base, systemPrompt, messages, config, onChunk, signal) {
  const body = {
    model: config.model,
    messages: [systemPrompt ? { role: 'system', content: systemPrompt } : null, ...messages].filter(Boolean),
    stream: true,
    temperature: config.temperature || 0.7,
  }
  const resp = await fetchWithRetry(base + '/chat/completions', {
    method: 'POST',
    headers: authHeaders(config.apiType, config.apiKey),
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  await readSSEStream(resp, (json) => {
    const delta = json.choices?.[0]?.delta
    if (delta?.content) onChunk(delta.content)
  }, signal)
}

async function callAnthropicHosted(base, systemPrompt, messages, config, onChunk, signal) {
  const body = {
    model: config.model,
    max_tokens: 4096,
    stream: true,
    temperature: config.temperature || 0.7,
    messages,
  }
  if (systemPrompt) body.system = systemPrompt
  const resp = await fetchWithRetry(base + '/messages', {
    method: 'POST',
    headers: authHeaders(config.apiType, config.apiKey),
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  await readSSEStream(resp, (json) => {
    if (json.type === 'content_block_delta') {
      const delta = json.delta
      if (delta?.type === 'text_delta' && delta.text) onChunk(delta.text)
    }
  }, signal)
}

async function callGeminiHosted(base, systemPrompt, messages, config, onChunk, signal) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }))
  const body = {
    contents,
    generationConfig: { temperature: config.temperature || 0.7 },
  }
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] }
  const url = `${base}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    let errMsg = `API 错误 ${resp.status}`
    try { errMsg = JSON.parse(errText).error?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  await readSSEStream(resp, (json) => {
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) onChunk(text)
  }, signal)
}

function formatHostedSummary(extra) {
  const parts = []
  if (_currentRunId) parts.push(`runId=${_currentRunId}`)
  if (_hostedRuntime.stepCount != null) parts.push(`step=${_hostedRuntime.stepCount}`)
  if (_hostedRuntime.lastError) parts.push(`error=${_hostedRuntime.lastError}`)
  if (extra) parts.push(extra)
  return parts.length ? ` | ${parts.join(' | ')}` : ''
}

function parseHostedTemplate(text) {
  const raw = (text || '').trim()
  if (!raw) return null
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const goals = []
  const suggestions = []
  const risks = []
  let section = ''
  for (const line of lines) {
    if (/^目标[:：]/i.test(line)) { section = 'goal'; const v = line.replace(/^目标[:：]\s*/i, ''); if (v) goals.push(v); continue }
    if (/^建议[:：]/i.test(line)) { section = 'suggest'; const v = line.replace(/^建议[:：]\s*/i, ''); if (v) suggestions.push(v); continue }
    if (/^风险[:：]/i.test(line)) { section = 'risk'; const v = line.replace(/^风险[:：]\s*/i, ''); if (v) risks.push(v); continue }
    if (section === 'goal') goals.push(line)
    else if (section === 'suggest') suggestions.push(line.replace(/^[\-*\d\.\s]+/, ''))
    else if (section === 'risk') risks.push(line.replace(/^[\-*\d\.\s]+/, ''))
  }

  if (!goals.length && !suggestions.length) {
    return {
      goal: '',
      suggestions: [raw],
      risks: [],
    }
  }

  return {
    goal: goals.join(' '),
    suggestions: suggestions.filter(Boolean).length ? suggestions.filter(Boolean) : [raw],
    risks: risks.filter(Boolean),
  }
}

function showHostedCompletionModal(summary, content) {
  const safeSummary = escapeHtml(summary || '')
  const safeContent = escapeHtml(content || '')
  const html = `
    <div style="font-size:12px;line-height:1.6;color:var(--text-secondary)">
      <div style="margin-bottom:10px"><strong>任务完结摘要</strong></div>
      <div style="white-space:pre-wrap;background:var(--bg-tertiary);padding:10px 12px;border-radius:8px;font-family:var(--font-mono)">${safeSummary || '无'}</div>
      <div style="margin-top:12px"><strong>最终输出</strong></div>
      <div style="white-space:pre-wrap;background:var(--bg-tertiary);padding:10px 12px;border-radius:8px;font-family:var(--font-mono)">${safeContent || '无'}</div>
    </div>
  `
  showContentModal({
    title: '托管 Agent 任务完结',
    content: html,
    buttons: [{ label: '确定', className: 'btn btn-primary btn-sm', id: 'hosted-done' }],
    width: 520,
  })
}

function updateHostedInputLock() {
  const boundKey = getHostedBoundSessionKey()
  const locked = !!_hostedSessionConfig?.enabled
    && ( _hostedRuntime?.status === HOSTED_STATUS.RUNNING || _hostedRuntime?.status === HOSTED_STATUS.WAITING )
    && boundKey === _sessionKey
  if (_textarea) {
    _textarea.disabled = locked
    _textarea.placeholder = locked ? '托管 Agent 已启用，用户输入已锁定' : '输入消息，Enter 发送，/ 打开指令'
  }
  if (_sendBtn && !_isStreaming) _sendBtn.disabled = locked || (!_textarea?.value?.trim() && !_attachments.length)
  if (_attachBtnEl) _attachBtnEl.disabled = locked
  if (_fileInputEl) _fileInputEl.disabled = locked
}

function showAskUserCardChat({ question, type, options, placeholder, toolId, sessionKey }) {
  void createAskUserBubble({
    question,
    type,
    options,
    placeholder,
    toolId,
    sessionKey,
    skipLabel: '跳过',
    skipValue: '用户跳过了此问题',
  })
}

function appendHostedOutput(text) {
  const prepared = prepareHostedOutput(text, {
    extractHostedAskUser,
    extractHostedInstruction,
  }, _hostedLastSentHash)
  if (!prepared) return

  const specialTs = Date.now()
  _hostedRuntime.lastSpecialText = prepared.displayText
  _hostedRuntime.lastSpecialTs = specialTs
  persistHostedRuntime(getHostedBoundSessionKey())
  const boundKey = getHostedBoundSessionKey()
  if (boundKey === _sessionKey) {
    upsertStableSystemBubble({
      statusKey: 'hosted-special',
      text: prepared.displayText,
      statusType: 'hosted-special',
      ts: specialTs,
      active: true,
    })
    scrollToBottom()
    if (prepared.extracted.askUser && !_askUserBlockedNotice) {
      _askUserBlockedNotice = true
      appendSystemMessage('托管模式已忽略 ask_user 交互请求，等待自动流程继续或人工手动介入。')
    }
  }

  if (!prepared.instruction || !prepared.shouldSendInstruction) return
  _hostedLastSentHash = prepared.instructionHash
  if (boundKey && wsClient.gatewayReady) {
    wsClient.chatSend(boundKey, prepared.instruction).catch(() => {})
  }
}

// ── 页面离开清理 ──

export function cleanup() {
  _pageActive = false
  if (_unsubEvent) { _unsubEvent(); _unsubEvent = null }
  if (_unsubReady) { _unsubReady(); _unsubReady = null }
  if (_unsubStatus) { _unsubStatus(); _unsubStatus = null }
  clearTimeout(_streamSafetyTimer)
  if (_hostedAbort) { _hostedAbort.abort(); _hostedAbort = null }
  if (_hostedDisconnectTimer) { clearTimeout(_hostedDisconnectTimer); _hostedDisconnectTimer = null }
  // 不断开 wsClient —— 它是全局单例，保持连接供下次进入复用
  _sessionKey = null
  _page = null
  _messagesEl = null
  _textarea = null
  _sendBtn = null
  _statusDot = null
  _typingEl = null
  _scrollBtn = null
  _sessionListEl = null
  _cmdPanelEl = null
  _currentAiBubble = null
  _currentAiText = ''
  _currentAiImages = []
  _currentAiVideos = []
  _currentAiAudios = []
  _currentAiFiles = []
  _currentAiTools = []
  _currentRunId = null
  _isStreaming = false
  _isSending = false
  _messageQueue = []
  _hostedBtn = null
  _hostedPanelEl = null
  _hostedBadgeEl = null
  _hostedPromptEl = null
  _hostedEnableEl = null
  _hostedMaxStepsEl = null
  _hostedContextLimitEl = null
  _hostedSaveBtn = null
  _hostedPauseBtn = null
  _hostedStopBtn = null
  _hostedCloseBtn = null
  _hostedGlobalSyncEl = null
  _hostedSessionConfig = null
  _hostedDefaults = null
  _hostedRuntime = { ...HOSTED_RUNTIME_DEFAULT }
  _hostedBusy = false
  _hostedSeeded = false
  _hostedLastCompletionRunId = ''
  _hostedLastSentHash = ''
  _hostedLastTargetHash = ''
  _askUserBlockedNotice = false
  _hostedHistoryRefreshKeys.clear()
  _sessionStates.clear()
}
