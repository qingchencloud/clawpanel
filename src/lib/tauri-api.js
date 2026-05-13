/**
 * Tauri API 封装层
 * Tauri 环境用 invoke，Web 模式走 dev-api 后端
 */

import { t } from './i18n.js'

export function isTauriRuntime() {
  return !!window.__TAURI_INTERNALS__ || !!window.__TAURI__ || window.location?.hostname === 'tauri.localhost'
}

// 仅在 Node.js 后端实现的命令（Tauri Rust 不处理），强制走 webInvoke
const WEB_ONLY_CMDS = new Set([
  'instance_list', 'instance_add', 'instance_remove', 'instance_set_active',
  'instance_health_check', 'instance_health_all',
  'docker_info', 'docker_list_containers', 'docker_create_container',
  'docker_start_container', 'docker_stop_container', 'docker_restart_container',
  'docker_remove_container', 'docker_pull_image', 'docker_pull_status',
  'docker_list_images', 'docker_list_nodes', 'docker_add_node',
  'docker_remove_node', 'docker_cluster_overview',
  'get_deploy_mode',
])

let _invokeReady = null

async function getTauriInvoke() {
  if (!isTauriRuntime()) return null
  if (!_invokeReady) {
    _invokeReady = import('@tauri-apps/api/core').then(m => m.invoke)
  }
  return _invokeReady
}

// 简单缓存：避免页面切换时重复请求后端
const _cache = new Map()
const _inflight = new Map() // in-flight 请求去重，防止缓存过期后同一命令并发 spawn 多个进程
const CACHE_TTL = 15000 // 15秒

// 网络请求日志（用于调试）
const _requestLogs = []
const MAX_LOGS = 100

function logRequest(cmd, args, duration, cached = false) {
  const log = {
    timestamp: Date.now(),
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3 }),
    cmd,
    args: JSON.stringify(args),
    duration: duration ? `${duration}ms` : '-',
    cached
  }
  _requestLogs.push(log)
  if (_requestLogs.length > MAX_LOGS) {
    _requestLogs.shift()
  }
}

// 导出日志供调试页面使用
export function getRequestLogs() {
  return _requestLogs.slice()
}

export function clearRequestLogs() {
  _requestLogs.length = 0
}

function cachedInvoke(cmd, args = {}, ttl = CACHE_TTL) {
  const key = cmd + JSON.stringify(args)
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < ttl) {
    logRequest(cmd, args, 0, true)
    return Promise.resolve(cached.val)
  }
  // in-flight 去重：同一个 key 的请求正在执行中，复用同一个 Promise
  // 避免缓存过期瞬间多个调用者同时 spawn 进程（ARM 设备上的 CPU 爆满根因）
  if (_inflight.has(key)) {
    return _inflight.get(key)
  }
  const p = invoke(cmd, args).then(val => {
    _cache.set(key, { val, ts: Date.now() })
    _inflight.delete(key)
    return val
  }).catch(err => {
    _inflight.delete(key)
    throw err
  })
  _inflight.set(key, p)
  return p
}

// 清除指定命令的缓存（写操作后调用）
function invalidate(...cmds) {
  if (!cmds.length) {
    _cache.clear()
    _inflight.clear()
    return
  }
  for (const [k] of _cache) {
    if (cmds.some(c => k.startsWith(c))) _cache.delete(k)
  }
  for (const [k] of _inflight) {
    if (cmds.some(c => k.startsWith(c))) _inflight.delete(k)
  }
}

// 导出 invalidate 供外部使用
export { invalidate }

async function invoke(cmd, args = {}) {
  const start = Date.now()
  const tauriInvoke = WEB_ONLY_CMDS.has(cmd) ? null : await getTauriInvoke()
  if (tauriInvoke) {
    const result = await tauriInvoke(cmd, args)
    const duration = Date.now() - start
    logRequest(cmd, args, duration, false)
    return result
  }
  // Web 模式：调用 dev-api 后端（真实数据）
  const result = await webInvoke(cmd, args)
  const duration = Date.now() - start
  logRequest(cmd, args, duration, false)
  return result
}

// Web 模式：通过 Vite 开发服务器的 API 端点调用真实后端
async function webInvoke(cmd, args) {
  const resp = await fetch(`/__api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (resp.status === 401) {
    // Tauri 模式下不触发登录浮层（Tauri 有自己的认证流程）
    if (!isTauriRuntime() && window.__clawpanel_show_login) window.__clawpanel_show_login()
    throw new Error(t('common.loginRequired'))
  }
  // 检测后端是否可用：如果返回的是 HTML（非 JSON），说明后端未运行
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('text/plain')) {
    throw new Error(t('common.backendWebModeRequired'))
  }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
    throw new Error(data.error || `HTTP ${resp.status}`)
  }
  return resp.json()
}

async function webStreamInvoke(cmd, args, onEvent, options = {}) {
  const resp = await fetch(`/__api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
    signal: options.signal,
  })
  if (resp.status === 401) {
    if (!isTauriRuntime() && window.__clawpanel_show_login) window.__clawpanel_show_login()
    throw new Error(t('common.loginRequired'))
  }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
    throw new Error(data.error || `HTTP ${resp.status}`)
  }
  if (!resp.body) throw new Error('Streaming response is not supported by this browser')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const event = JSON.parse(trimmed)
        if (typeof onEvent === 'function') onEvent(event)
      }
    }
    const tail = buffer.trim()
    if (tail && typeof onEvent === 'function') onEvent(JSON.parse(tail))
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// 后端连接状态
let _backendOnline = null // null=未检测, true=在线, false=离线
const _backendListeners = []

export function onBackendStatusChange(fn) {
  _backendListeners.push(fn)
  return () => { const i = _backendListeners.indexOf(fn); if (i >= 0) _backendListeners.splice(i, 1) }
}

export function isBackendOnline() { return _backendOnline }

function _setBackendOnline(v) {
  if (_backendOnline !== v) {
    _backendOnline = v
    _backendListeners.forEach(fn => { try { fn(v) } catch {} })
  }
}

// 后端健康检查
export async function checkBackendHealth() {
  if (isTauriRuntime()) { _setBackendOnline(true); return true }
  try {
    const resp = await fetch('/__api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const ok = resp.ok
    _setBackendOnline(ok)
    return ok
  } catch {
    _setBackendOnline(false)
    return false
  }
}

// 配置保存后防抖重载 Gateway（3 秒内多次写入只触发一次重载）
let _reloadTimer = null
function _debouncedReloadGateway() {
  clearTimeout(_reloadTimer)
  _reloadTimer = setTimeout(() => { invoke('reload_gateway').catch(() => {}) }, 3000)
}

// 导出 API
export const api = {
  // 服务管理（状态用短缓存，操作不缓存）
  getServicesStatus: () => cachedInvoke('get_services_status', {}, 10000),
  startService: (label) => { invalidate('get_services_status'); return invoke('start_service', { label }) },
  stopService: (label) => { invalidate('get_services_status'); return invoke('stop_service', { label }) },
  restartService: (label) => { invalidate('get_services_status'); return invoke('restart_service', { label }) },
  claimGateway: () => { invalidate('get_services_status'); return invoke('claim_gateway') },
  probeGatewayPort: () => invoke('probe_gateway_port'),
  diagnoseGatewayConnection: () => invoke('diagnose_gateway_connection'),
  guardianStatus: () => invoke('guardian_status'),
  checkCiaoWindowsHideBug: () => invoke('check_ciao_windowshide_bug'),

  // CLI 冲突检测与隔离（PATH 中残留的非 standalone openclaw）
  scanOpenclawPathConflicts: () => invoke('scan_openclaw_path_conflicts'),
  quarantineOpenclawPath: (path) => invoke('quarantine_openclaw_path', { path }),
  quarantineOpenclawPathsBulk: (paths) => invoke('quarantine_openclaw_paths_bulk', { paths }),
  listQuarantinedOpenclaw: () => invoke('list_quarantined_openclaw'),
  restoreQuarantinedOpenclaw: (quarantinedPath) => invoke('restore_quarantined_openclaw', { quarantinedPath }),

  // 配置（读缓存，写清缓存）
  getVersionInfo: () => cachedInvoke('get_version_info', {}, 30000),
  getStatusSummary: () => cachedInvoke('get_status_summary', {}, 60000),
  readOpenclawConfig: () => cachedInvoke('read_openclaw_config'),
  calibrateOpenclawConfig: (mode = 'inherit') => { invalidate('read_openclaw_config', 'check_installation', 'list_backups', 'get_services_status', 'get_status_summary'); return invoke('calibrate_openclaw_config', { mode }).then(r => { _debouncedReloadGateway(); return r }) },
  writeOpenclawConfig: (config, opts = {}) => { invalidate('read_openclaw_config'); return invoke('write_openclaw_config', { config }).then(r => { if (opts.noReload !== true) _debouncedReloadGateway(); return r }) },
  readMcpConfig: () => cachedInvoke('read_mcp_config'),
  writeMcpConfig: (config) => { invalidate('read_mcp_config'); return invoke('write_mcp_config', { config }) },
  reloadGateway: () => invoke('reload_gateway'),
  restartGateway: () => invoke('restart_gateway'),
  doctorCheck: () => invoke('doctor_check'),
  doctorFix: () => invoke('doctor_fix'),
  listOpenclawVersions: (source = 'chinese') => invoke('list_openclaw_versions', { source }),
  // #Compat-4: 升级/卸载后 CLI 路径/版本/服务状态都可能变，一次性清掉相关前端缓存；
  //           Rust 端已经在命令内部调用 refresh_enhanced_path + invalidate_cli_detection_cache。
  upgradeOpenclaw: (source = 'chinese', version = null, method = 'auto') => {
    invalidate('check_installation', 'check_node', 'check_git', 'get_services_status', 'get_status_summary', 'get_version_info')
    return invoke('upgrade_openclaw', { source, version, method })
  },
  uninstallOpenclaw: (cleanConfig = false) => {
    invalidate('check_installation', 'check_node', 'check_git', 'get_services_status', 'get_status_summary', 'get_version_info')
    return invoke('uninstall_openclaw', { cleanConfig })
  },
  installGateway: () => { invalidate('get_services_status', 'get_status_summary'); return invoke('install_gateway') },
  uninstallGateway: () => { invalidate('get_services_status', 'get_status_summary'); return invoke('uninstall_gateway') },
  getNpmRegistry: () => cachedInvoke('get_npm_registry', {}, 30000),
  setNpmRegistry: (registry) => { invalidate('get_npm_registry'); return invoke('set_npm_registry', { registry }) },
  testModel: (baseUrl, apiKey, modelId, apiType = null) => invoke('test_model', { baseUrl, apiKey, modelId, apiType }),
  testModelVerbose: (baseUrl, apiKey, modelId, apiType = null) => invoke('test_model_verbose', { baseUrl, apiKey, modelId, apiType }),
  listRemoteModels: (baseUrl, apiKey, apiType = null) => invoke('list_remote_models', { baseUrl, apiKey, apiType }),

  // Agent 管理
  listAgents: () => cachedInvoke('list_agents'),
  getAgentDetail: (id) => cachedInvoke('get_agent_detail', { id }, 5000),
  listAgentFiles: (id) => cachedInvoke('list_agent_files', { id }, 5000),
  readAgentFile: (id, name) => invoke('read_agent_file', { id, name }),
  writeAgentFile: (id, name, content) => { invalidate('list_agent_files', 'read_agent_file'); return invoke('write_agent_file', { id, name, content }) },
  getAgentWorkspaceInfo: (id) => cachedInvoke('get_agent_workspace_info', { id }, 5000),
  listAgentWorkspaceEntries: (id, relativePath) => cachedInvoke('list_agent_workspace_entries', { id, relativePath: relativePath || null }, 5000),
  readAgentWorkspaceFile: (id, relativePath) => cachedInvoke('read_agent_workspace_file', { id, relativePath }, 5000),
  writeAgentWorkspaceFile: (id, relativePath, content) => {
    invalidate('get_agent_workspace_info', 'list_agent_workspace_entries', 'read_agent_workspace_file', 'list_agent_files', 'read_agent_file')
    return invoke('write_agent_workspace_file', { id, relativePath, content })
  },
  updateAgentConfig: (id, config) => { invalidate('list_agents', 'get_agent_detail'); return invoke('update_agent_config', { id, config }) },
  addAgent: (name, model, workspace) => { invalidate('list_agents'); return invoke('add_agent', { name, model, workspace: workspace || null }) },
  deleteAgent: (id) => { invalidate('list_agents', 'get_agent_detail'); return invoke('delete_agent', { id }) },
  updateAgentIdentity: (id, name, emoji) => { invalidate('list_agents', 'get_agent_detail'); return invoke('update_agent_identity', { id, name, emoji }) },
  updateAgentModel: (id, model) => { invalidate('list_agents', 'get_agent_detail'); return invoke('update_agent_model', { id, model }) },
  backupAgent: (id) => invoke('backup_agent', { id }),

  // 日志（短缓存）
  readLogTail: (logName, lines = 100) => cachedInvoke('read_log_tail', { logName, lines }, 5000),
  searchLog: (logName, query, maxResults = 50) => invoke('search_log', { logName, query, maxResults }),

  // 记忆文件
  listMemoryFiles: (category, agentId) => cachedInvoke('list_memory_files', { category, agentId: agentId || null }),
  readMemoryFile: (path, agentId) => cachedInvoke('read_memory_file', { path, agentId: agentId || null }, 5000),
  writeMemoryFile: (path, content, category, agentId) => { invalidate('list_memory_files', 'read_memory_file'); return invoke('write_memory_file', { path, content, category: category || 'memory', agentId: agentId || null }) },
  deleteMemoryFile: (path, agentId) => { invalidate('list_memory_files'); return invoke('delete_memory_file', { path, agentId: agentId || null }) },
  exportMemoryZip: (category, agentId) => invoke('export_memory_zip', { category, agentId: agentId || null }),

  // 消息渠道管理
  readPlatformConfig: (platform, accountId) => invoke('read_platform_config', { platform, accountId: accountId || null }),
  saveMessagingPlatform: (platform, form, accountId, agentId) => { invalidate('list_configured_platforms', 'read_openclaw_config', 'read_platform_config'); return invoke('save_messaging_platform', { platform, form, accountId: accountId || null, agentId: agentId || null }) },
  removeMessagingPlatform: (platform, accountId) => { invalidate('list_configured_platforms', 'read_openclaw_config', 'read_platform_config'); return invoke('remove_messaging_platform', { platform, accountId: accountId || null }) },
  toggleMessagingPlatform: (platform, enabled) => { invalidate('list_configured_platforms', 'read_openclaw_config', 'read_platform_config'); return invoke('toggle_messaging_platform', { platform, enabled }) },
  verifyBotToken: (platform, form) => invoke('verify_bot_token', { platform, form }),
  diagnoseChannel: (platform, accountId) => invoke('diagnose_channel', { platform, accountId: accountId || null }),
  repairQqbotChannelSetup: () => {
    invalidate('list_configured_platforms', 'read_openclaw_config', 'read_platform_config')
    return invoke('repair_qqbot_channel_setup')
  },
  listConfiguredPlatforms: () => cachedInvoke('list_configured_platforms', {}, 5000),
  listAllPlugins: () => cachedInvoke('list_all_plugins', {}, 5000),
  togglePlugin: (pluginId, enabled) => { invalidate('list_all_plugins'); return invoke('toggle_plugin', { pluginId, enabled }) },
  installPlugin: (packageName) => { invalidate('list_all_plugins'); return invoke('install_plugin', { packageName }) },
  getChannelPluginStatus: (pluginId) => invoke('get_channel_plugin_status', { pluginId }),
  installQqbotPlugin: (version = null) => invoke('install_qqbot_plugin', { version }),
  installChannelPlugin: (packageName, pluginId, version = null) => invoke('install_channel_plugin', { packageName, pluginId, version }),
  runChannelAction: (platform, action, version = null) => invoke('run_channel_action', { platform, action, version }),
  checkWeixinPluginStatus: () => invoke('check_weixin_plugin_status'),

  // Agent 渠道绑定管理
  getAgentBindings: (agentId) => invoke('get_agent_bindings', { agentId }),
  listAllBindings: () => invoke('list_all_bindings'),
  saveAgentBinding: (agentId, channel, accountId, bindingConfig) => { invalidate('read_openclaw_config', 'list_configured_platforms'); return invoke('save_agent_binding', { agentId, channel, accountId: accountId || null, bindingConfig: bindingConfig || {} }) },
  deleteAgentBinding: (agentId, channel, accountId, bindingConfig) => { invalidate('read_openclaw_config', 'list_configured_platforms'); return invoke('delete_agent_binding', { agentId, channel, accountId: accountId || null, bindingConfig: bindingConfig || null }) },
  deleteAgentAllBindings: (agentId) => { invalidate('read_openclaw_config', 'list_configured_platforms'); return invoke('delete_agent_all_bindings', { agentId }) },

  // 面板配置 (clawpanel.json)
  getOpenclawDir: () => invoke('get_openclaw_dir'),
  // Tauri: 重启应用进程；Web: 没有应用进程概念，刷新浏览器即可拿到新状态
  relaunchApp: () => {
    if (!isTauriRuntime()) {
      try { window.location.reload() } catch {}
      return Promise.resolve({ ok: true, mode: 'web-reload' })
    }
    return invoke('relaunch_app')
  },
  readPanelConfig: () => invoke('read_panel_config'),
  writePanelConfig: (config) => { invalidate(); return invoke('write_panel_config', { config }).then(r => { invoke('invalidate_path_cache').catch(() => {}); return r }) },
  testProxy: (url) => invoke('test_proxy', { url: url || null }),

  // 安装/部署
  checkInstallation: () => cachedInvoke('check_installation', {}, 60000),
  initOpenclawConfig: () => { invalidate('check_installation'); return invoke('init_openclaw_config') },
  checkNode: () => cachedInvoke('check_node', {}, 60000),
  checkNodeAtPath: (nodeDir) => invoke('check_node_at_path', { nodeDir }),
  checkOpenclawAtPath: (cliPath) => invoke('check_openclaw_at_path', { cliPath }),
  scanNodePaths: () => invoke('scan_node_paths'),
  scanOpenclawPaths: () => invoke('scan_openclaw_paths'),
  saveCustomNodePath: (nodeDir) => invoke('save_custom_node_path', { nodeDir }).then(r => { invalidate('check_node', 'get_services_status'); invoke('invalidate_path_cache').catch(() => {}); return r }),
  invalidatePathCache: () => invoke('invalidate_path_cache'),
  checkGit: () => cachedInvoke('check_git', {}, 60000),
  scanGitPaths: () => invoke('scan_git_paths'),
  autoInstallGit: () => invoke('auto_install_git'),
  configureGitHttps: () => invoke('configure_git_https'),
  getDeployConfig: () => cachedInvoke('get_deploy_config'),
  patchModelVision: () => invoke('patch_model_vision'),
  checkPanelUpdate: () => invoke('check_panel_update'),
  writeEnvFile: (path, config) => invoke('write_env_file', { path, config }),

  // 备份管理
  listBackups: () => cachedInvoke('list_backups'),
  createBackup: () => { invalidate('list_backups'); return invoke('create_backup') },
  restoreBackup: (name) => invoke('restore_backup', { name }),
  deleteBackup: (name) => { invalidate('list_backups'); return invoke('delete_backup', { name }) },

  // 设备密钥 + Gateway 握手
  createConnectFrame: (nonce, gatewayToken, gatewayPassword) => invoke('create_connect_frame', { nonce, gatewayToken, gatewayPassword: gatewayPassword || null }),

  // 设备配对
  autoPairDevice: () => invoke('auto_pair_device'),
  checkPairingStatus: () => invoke('check_pairing_status'),
  pairingListChannel: (channel) => invoke('pairing_list_channel', { channel }),
  pairingApproveChannel: (channel, code, notify = false) => invoke('pairing_approve_channel', { channel, code, notify }),

  // AI 助手工具
  assistantExec: (command, cwd) => invoke('assistant_exec', { command, cwd: cwd || null }),
  assistantReadFile: (path) => invoke('assistant_read_file', { path }),
  assistantWriteFile: (path, content) => invoke('assistant_write_file', { path, content }),
  assistantListDir: (path) => invoke('assistant_list_dir', { path }),
  assistantSystemInfo: () => invoke('assistant_system_info'),
  assistantListProcesses: (filter) => invoke('assistant_list_processes', { filter: filter || null }),
  assistantCheckPort: (port) => invoke('assistant_check_port', { port }),
  assistantWebSearch: (query, maxResults) => invoke('assistant_web_search', { query, max_results: maxResults || 5 }),
  assistantFetchUrl: (url) => invoke('assistant_fetch_url', { url }),

  // Skills 管理
  skillsList: (agentId) => invoke('skills_list', { agent_id: agentId || null }),
  skillsInfo: (name, agentId) => invoke('skills_info', { name, agent_id: agentId || null }),
  skillsCheck: () => invoke('skills_check'),
  skillsInstallDep: (kind, spec) => invoke('skills_install_dep', { kind, spec }),
  skillsUninstall: (name, agentId) => invoke('skills_uninstall', { name, agent_id: agentId || null }),
  // SkillHub SDK（内置 HTTP，不依赖 CLI）
  skillhubSearch: (query, limit) => invoke('skillhub_search', { query, limit }),
  skillhubIndex: () => invoke('skillhub_index'),
  skillhubInstall: (slug, agentId) => invoke('skillhub_install', { slug, agent_id: agentId || null }),

  // 实例管理
  instanceList: () => cachedInvoke('instance_list', {}, 10000),
  instanceAdd: (instance) => { invalidate('instance_list'); return invoke('instance_add', instance) },
  instanceRemove: (id) => { invalidate('instance_list'); return invoke('instance_remove', { id }) },
  instanceSetActive: (id) => { invalidate('instance_list'); _cache.clear(); return invoke('instance_set_active', { id }) },
  instanceHealthCheck: (id) => invoke('instance_health_check', { id }),
  instanceHealthAll: () => invoke('instance_health_all'),

  // Docker 管理（当前由 Web/dev-api 提供）
  dockerInfo: (nodeId) => invoke('docker_info', { nodeId: nodeId || null }),
  dockerListContainers: (nodeId, all = true) => invoke('docker_list_containers', { nodeId: nodeId || null, all }),
  dockerCreateContainer: (payload) => invoke('docker_create_container', payload || {}),
  dockerStartContainer: (nodeId, containerId) => invoke('docker_start_container', { nodeId: nodeId || null, containerId }),
  dockerStopContainer: (nodeId, containerId) => invoke('docker_stop_container', { nodeId: nodeId || null, containerId }),
  dockerRestartContainer: (nodeId, containerId) => invoke('docker_restart_container', { nodeId: nodeId || null, containerId }),
  dockerRemoveContainer: (nodeId, containerId, force = false) => invoke('docker_remove_container', { nodeId: nodeId || null, containerId, force }),
  dockerPullImage: (payload) => invoke('docker_pull_image', payload || {}),
  dockerPullStatus: (requestId) => invoke('docker_pull_status', { requestId }),
  dockerListImages: (nodeId) => invoke('docker_list_images', { nodeId: nodeId || null }),
  dockerListNodes: () => invoke('docker_list_nodes', {}),
  dockerAddNode: (name, endpoint) => invoke('docker_add_node', { name, endpoint }),
  dockerRemoveNode: (nodeId) => invoke('docker_remove_node', { nodeId }),
  dockerClusterOverview: () => invoke('docker_cluster_overview', {}),


  // 前端热更新
  checkFrontendUpdate: () => invoke('check_frontend_update'),
  downloadFrontendUpdate: (url, expectedHash, version) => invoke('download_frontend_update', { url, expectedHash: expectedHash || '', version: version || '' }),
  rollbackFrontendUpdate: () => invoke('rollback_frontend_update'),
  getUpdateStatus: () => invoke('get_update_status'),

  // 数据目录 & 图片存储
  ensureDataDir: () => invoke('assistant_ensure_data_dir'),
  saveImage: (id, data) => invoke('assistant_save_image', { id, data }),
  loadImage: (id) => invoke('assistant_load_image', { id }),
  deleteImage: (id) => invoke('assistant_delete_image', { id }),

  // Hermes Agent 管理
  checkPython: () => cachedInvoke('check_python', {}, 60000),
  checkHermes: () => cachedInvoke('check_hermes', {}, 30000),
  installHermes: (method = 'uv-tool', extras = []) => invoke('install_hermes', { method, extras }),
  configureHermes: (provider, apiKey, model, baseUrl) => invoke('configure_hermes', { provider, apiKey, model: model || null, baseUrl: baseUrl || null }),
  hermesGatewayAction: (action) => invoke('hermes_gateway_action', { action }),
  hermesHealthCheck: () => invoke('hermes_health_check'),
  hermesApiProxy: (method, path, body, headers) => invoke('hermes_api_proxy', { method, path, body: body || null, headers: headers || null }),
  hermesAgentRun: (input, sessionId, conversationHistory, instructions) => invoke('hermes_agent_run', { input, sessionId: sessionId || null, conversationHistory: conversationHistory || null, instructions: instructions || null }),
  hermesAgentRunStream: (input, sessionId, conversationHistory, instructions, onEvent, options) => webStreamInvoke('hermes_agent_run_stream', { input, sessionId: sessionId || null, conversationHistory: conversationHistory || null, instructions: instructions || null }, onEvent, options),
  hermesReadConfig: () => invoke('hermes_read_config'),
  hermesFetchModels: (baseUrl, apiKey, apiType, provider) => invoke('hermes_fetch_models', { baseUrl, apiKey, apiType: apiType || null, provider: provider || null }),
  hermesUpdateModel: (model, provider) => invoke('hermes_update_model', { model, provider: provider || null }),
  hermesListProviders: () => cachedInvoke('hermes_list_providers', {}, 600000),
  hermesEnvReadUnmanaged: () => invoke('hermes_env_read_unmanaged'),
  hermesEnvSet: (key, value) => invoke('hermes_env_set', { key, value }),
  hermesEnvDelete: (key) => invoke('hermes_env_delete', { key }),
  hermesEnvReveal: (key) => invoke('hermes_env_reveal', { key }),
  hermesConfigRawRead: () => invoke('hermes_config_raw_read'),
  hermesConfigRawWrite: (yamlText) => invoke('hermes_config_raw_write', { yamlText }),
  hermesDetectEnvironments: () => invoke('hermes_detect_environments'),
  hermesSetGatewayUrl: (url) => invoke('hermes_set_gateway_url', { url: url || null }),
  updateHermes: () => invoke('update_hermes'),
  uninstallHermes: (cleanConfig = false) => invoke('uninstall_hermes', { cleanConfig }),

  // Hermes Sessions / Logs / Skills / Memory
  hermesSessionsList: (source, limit, profile) => invoke('hermes_sessions_list', { source: source || null, limit: limit || null, profile: profile || null }),
  hermesSessionsSummaryList: (source, limit, profile) => invoke('hermes_sessions_summary_list', { source: source || null, limit: limit || null, profile: profile || null }),
  hermesUsageAnalytics: (days, profile) => invoke('hermes_usage_analytics', { days: days || 30, profile: profile || null }),
  hermesSessionDetail: (sessionId, profile) => invoke('hermes_session_detail', { sessionId, profile: profile || null }),
  hermesSessionDelete: (sessionId, profile) => invoke('hermes_session_delete', { sessionId, profile: profile || null }),
  hermesSessionRename: (sessionId, title, profile) => invoke('hermes_session_rename', { sessionId, title, profile: profile || null }),
  hermesProfilesList: () => invoke('hermes_profiles_list'),
  hermesProfileUse: (name) => invoke('hermes_profile_use', { name }),
  hermesLogsList: () => invoke('hermes_logs_list'),
  hermesLogsRead: (name, lines, level) => invoke('hermes_logs_read', { name, lines: lines || 200, level: level || null }),
  hermesLogsDownload: (name, saveToDisk = isTauriRuntime()) => invoke('hermes_logs_download', { name, saveToDisk }),
  hermesDashboardThemes: () => invoke('hermes_dashboard_themes'),
  hermesDashboardThemeSet: (name) => invoke('hermes_dashboard_theme_set', { name }),
  hermesDashboardPlugins: () => invoke('hermes_dashboard_plugins'),
  hermesDashboardPluginsRescan: () => invoke('hermes_dashboard_plugins_rescan'),
  hermesDashboardProbe: () => invoke('hermes_dashboard_probe'),
  hermesDashboardStart: () => invoke('hermes_dashboard_start'),
  hermesDashboardStop: () => invoke('hermes_dashboard_stop'),
  hermesToolsetsList: () => invoke('hermes_toolsets_list'),
  hermesCronJobsList: () => invoke('hermes_cron_jobs_list'),
  hermesSkillsList: () => invoke('hermes_skills_list'),
  hermesSkillDetail: (filePath) => invoke('hermes_skill_detail', { filePath }),
  hermesSkillToggle: (name, enabled) => invoke('hermes_skill_toggle', { name, enabled }),
  hermesSkillFiles: (category, skill) => invoke('hermes_skill_files', { category, skill }),
  hermesSkillWrite: (filePath, content) => invoke('hermes_skill_write', { filePath, content }),
  hermesMemoryRead: (type) => invoke('hermes_memory_read', { type: type || 'memory' }),
  hermesMemoryWrite: (type, content) => invoke('hermes_memory_write', { type: type || 'memory', content }),
  hermesMemoryReadAll: () => invoke('hermes_memory_read_all'),
}
