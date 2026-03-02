/**
 * Tauri API 封装层
 * 开发阶段用 mock 数据，Tauri 环境用 invoke
 */

const isTauri = !!window.__TAURI_INTERNALS__

// 预加载 Tauri invoke，避免每次 API 调用都做动态 import
const _invokeReady = isTauri
  ? import('@tauri-apps/api/core').then(m => m.invoke)
  : null

// 简单缓存：避免页面切换时重复请求后端
const _cache = new Map()
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
  const start = Date.now()
  return invoke(cmd, args).then(val => {
    const duration = Date.now() - start
    logRequest(cmd, args, duration, false)
    _cache.set(key, { val, ts: Date.now() })
    return val
  })
}

// 清除指定命令的缓存（写操作后调用）
function invalidate(...cmds) {
  for (const [k] of _cache) {
    if (cmds.some(c => k.startsWith(c))) _cache.delete(k)
  }
}

async function invoke(cmd, args = {}) {
  const start = Date.now()
  if (_invokeReady) {
    const tauriInvoke = await _invokeReady
    const result = await tauriInvoke(cmd, args)
    const duration = Date.now() - start
    logRequest(cmd, args, duration, false)
    return result
  }
  const result = mockInvoke(cmd, args)
  const duration = Date.now() - start
  logRequest(cmd, args, duration, false)
  return result
}

// Mock 数据，方便纯浏览器开发调试
function mockInvoke(cmd, args) {
  const mocks = {
    get_services_status: () => [
      { label: 'ai.openclaw.gateway', pid: null, running: false, description: 'OpenClaw Gateway', cli_installed: true },
    ],
    get_version_info: () => ({
      current: '2026.2.23',
      latest: null,
      update_available: false,
    }),
    read_openclaw_config: () => ({
      meta: { lastTouchedVersion: '2026.2.23' },
      models: {
        mode: 'replace',
        providers: {
          'newapi-claude': {
            baseUrl: 'http://localhost:30080/v1',
            api: 'openai-completions',
            models: [
              { id: 'claude-opus-4-6' },
              { id: 'claude-sonnet-4-5' },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: 'newapi-claude/claude-opus-4-6', fallbacks: ['newapi-claude/claude-sonnet-4-5'] },
          maxConcurrent: 4,
          subagents: 2,
        },
      },
      gateway: { port: 18789, mode: 'local', bind: 'loopback', authToken: '' },
    }),
    write_openclaw_config: () => true,
    read_log_tail: ({ logName }) => {
      const logs = {
        'gateway': [
          '2026-02-26 13:29:01 [INFO] Gateway started on :18789',
          '2026-02-26 13:29:02 [INFO] Agent connected: claude-opus-4-6',
          '2026-02-26 13:29:05 [INFO] Request /v1/chat/completions → 200 (1.2s)',
          '2026-02-26 13:30:12 [INFO] Request /v1/chat/completions → 200 (3.8s)',
          '2026-02-26 13:31:00 [WARN] Rate limit approaching: 45/50 rpm',
          '2026-02-26 13:32:15 [INFO] Request /v1/chat/completions → 200 (2.1s)',
        ],
        'gateway-err': ['2026-02-26 12:00:01 [ERROR] Upstream 502: connection refused'],
        'guardian': ['2026-02-26 13:29:00 [INFO] Health check passed', '2026-02-26 13:30:00 [INFO] Health check passed'],
        'guardian-backup': ['2026-02-26 12:00:00 [INFO] Backup completed: openclaw.json.bak'],
        'config-audit': ['{"ts":"2026-02-26T13:29:00Z","action":"config.read","file":"openclaw.json"}'],
      }
      return (logs[logName] || logs['gateway']).join('\n')
    },
    search_log: ({ query }) => [
      `2026-02-26 13:29:01 [INFO] Match: ${query}`,
      `2026-02-26 13:30:12 [INFO] Found: ${query} in request`,
    ],
    list_memory_files: ({ category }) => {
      const files = {
        memory: ['active-context.md', 'decisions.md', 'progress.md'],
        archive: ['2026-02-sprint1.md', '2026-02-sprint2.md'],
        core: ['AGENTS.md', 'CLAUDE.md'],
      }
      return files[category] || files.memory
    },
    read_memory_file: ({ path }) => `# ${path}\n\n这是 ${path} 的内容示例。\n\n## 概述\n\n在此记录工作记忆...`,
    write_memory_file: () => true,
    delete_memory_file: () => true,
    export_memory_zip: ({ category }) => `/tmp/openclaw-${category}-20260226-160000.zip`,
    check_installation: () => ({ installed: true, path: '/usr/local/bin/openclaw', version: '2026.2.23' }),
    check_node: () => ({ installed: true, version: 'v20.11.0' }),
    get_deploy_config: () => ({ gatewayUrl: 'http://127.0.0.1:18789', authToken: '', version: '2026.2.23' }),
    read_mcp_config: () => ({
      mcpServers: {
        'exa': { command: 'npx', args: ['-y', '@anthropic/exa-mcp-server'], env: { EXA_API_KEY: '***' } },
        'web-reader': { command: 'npx', args: ['-y', '@anthropic/web-reader-mcp'], env: {} },
        'pal': { command: 'node', args: ['/opt/pal-mcp/index.js'], env: {} },
      },
    }),
    write_mcp_config: () => true,
    start_service: () => true,
    stop_service: () => true,
    restart_service: () => true,
    reload_gateway: () => 'Gateway 已重载',
    upgrade_openclaw: () => '升级成功，当前版本: 2026.2.26-zh.3 (mock)',
    install_gateway: () => 'Gateway 服务已安装 (mock)',
    uninstall_gateway: () => 'Gateway 服务已卸载 (mock)',
    get_npm_registry: () => 'https://registry.npmmirror.com',
    set_npm_registry: () => true,
    test_model: ({ modelId }) => `模型 ${modelId} 连通正常 (mock)`,
    list_remote_models: () => ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o3-mini', 'dall-e-3', 'text-embedding-3-small'],
    write_env_file: () => true,
    list_backups: () => [
      { name: 'openclaw-20260226-143000.json', size: 8542, created_at: 1740577800 },
      { name: 'openclaw-20260225-100000.json', size: 8210, created_at: 1740474000 },
    ],
    create_backup: () => ({ name: 'openclaw-20260226-160000.json', size: 8542 }),
    restore_backup: () => true,
    delete_backup: () => true,
    get_cftunnel_status: () => ({
      installed: true, version: 'cftunnel 0.7.0', running: true,
      tunnel_name: 'mac-home', pid: 73325,
      routes: [
        { name: 'webapp', domain: 'app.example.com', service: 'http://localhost:3210' },
        { name: 'api', domain: 'api.example.com', service: 'http://localhost:30080' },
        { name: 'webhook', domain: 'hook.example.com', service: 'http://localhost:9801' },
      ],
    }),
    cftunnel_action: () => true,
    get_cftunnel_logs: () => '2026-02-26 13:29:01 [INFO] Tunnel started\n2026-02-26 13:30:00 [INFO] Connection healthy',
    get_clawapp_status: () => ({ running: true, pid: 7752, port: 3210, url: 'http://localhost:3210' }),
  }
  const fn = mocks[cmd]
  return fn ? Promise.resolve(fn(args)) : Promise.reject(`未知命令: ${cmd}`)
}

// 导出 API
export const api = {
  // 服务管理（状态用短缓存，操作不缓存）
  getServicesStatus: () => cachedInvoke('get_services_status', {}, 3000),
  startService: (label) => { invalidate('get_services_status'); return invoke('start_service', { label }) },
  stopService: (label) => { invalidate('get_services_status'); return invoke('stop_service', { label }) },
  restartService: (label) => { invalidate('get_services_status'); return invoke('restart_service', { label }) },

  // 配置（读缓存，写清缓存）
  getVersionInfo: () => cachedInvoke('get_version_info', {}, 30000),
  readOpenclawConfig: () => cachedInvoke('read_openclaw_config'),
  writeOpenclawConfig: (config) => { invalidate('read_openclaw_config'); return invoke('write_openclaw_config', { config }) },
  readMcpConfig: () => cachedInvoke('read_mcp_config'),
  writeMcpConfig: (config) => { invalidate('read_mcp_config'); return invoke('write_mcp_config', { config }) },
  reloadGateway: () => invoke('reload_gateway'),
  upgradeOpenclaw: (source = 'chinese') => invoke('upgrade_openclaw', { source }),
  installGateway: () => invoke('install_gateway'),
  uninstallGateway: () => invoke('uninstall_gateway'),
  getNpmRegistry: () => cachedInvoke('get_npm_registry', {}, 30000),
  setNpmRegistry: (registry) => { invalidate('get_npm_registry'); return invoke('set_npm_registry', { registry }) },
  testModel: (baseUrl, apiKey, modelId) => invoke('test_model', { baseUrl, apiKey, modelId }),
  listRemoteModels: (baseUrl, apiKey) => invoke('list_remote_models', { baseUrl, apiKey }),

  // Agent 管理
  listAgents: () => cachedInvoke('list_agents'),
  addAgent: (name, model, workspace) => { invalidate('list_agents'); return invoke('add_agent', { name, model, workspace: workspace || null }) },
  deleteAgent: (id) => { invalidate('list_agents'); return invoke('delete_agent', { id }) },
  updateAgentIdentity: (id, name, emoji) => { invalidate('list_agents'); return invoke('update_agent_identity', { id, name, emoji }) },
  backupAgent: (id) => invoke('backup_agent', { id }),

  // 日志（短缓存）
  readLogTail: (logName, lines = 100) => cachedInvoke('read_log_tail', { logName, lines }, 5000),
  searchLog: (logName, query, maxResults = 50) => invoke('search_log', { logName, query, maxResults }),

  // 记忆文件
  listMemoryFiles: (category, agentId) => cachedInvoke('list_memory_files', { category, agent_id: agentId || null }),
  readMemoryFile: (path, agentId) => cachedInvoke('read_memory_file', { path, agent_id: agentId || null }, 5000),
  writeMemoryFile: (path, content, category, agentId) => { invalidate('list_memory_files', 'read_memory_file'); return invoke('write_memory_file', { path, content, category: category || 'memory', agent_id: agentId || null }) },
  deleteMemoryFile: (path, agentId) => { invalidate('list_memory_files'); return invoke('delete_memory_file', { path, agent_id: agentId || null }) },
  exportMemoryZip: (category, agentId) => invoke('export_memory_zip', { category, agent_id: agentId || null }),

  // 安装/部署
  checkInstallation: () => cachedInvoke('check_installation', {}, 60000),
  checkNode: () => cachedInvoke('check_node', {}, 60000),
  getDeployConfig: () => cachedInvoke('get_deploy_config'),
  writeEnvFile: (path, config) => invoke('write_env_file', { path, config }),

  // 备份管理
  listBackups: () => cachedInvoke('list_backups'),
  createBackup: () => { invalidate('list_backups'); return invoke('create_backup') },
  restoreBackup: (name) => invoke('restore_backup', { name }),
  deleteBackup: (name) => { invalidate('list_backups'); return invoke('delete_backup', { name }) },

  // 扩展工具
  getCftunnelStatus: () => cachedInvoke('get_cftunnel_status', {}, 10000),
  cftunnelAction: (action) => { invalidate('get_cftunnel_status'); return invoke('cftunnel_action', { action }) },
  getCftunnelLogs: (lines = 20) => cachedInvoke('get_cftunnel_logs', { lines }, 5000),
  getClawappStatus: () => cachedInvoke('get_clawapp_status', {}, 5000),
  installCftunnel: () => invoke('install_cftunnel'),

  // 设备密钥 + Gateway 握手
  createConnectFrame: (nonce, gatewayToken) => invoke('create_connect_frame', { nonce, gatewayToken }),

  // 设备配对
  autoPairDevice: () => invoke('auto_pair_device'),
  checkPairingStatus: () => invoke('check_pairing_status'),
}
