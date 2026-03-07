/**
 * ClawPanel 开发模式 API 插件
 * 在 Vite 开发服务器上提供真实 API 端点，替代 mock 数据
 * 使浏览器模式能真正管理 OpenClaw 实例
 */
import fs from 'fs'
import path from 'path'
import { homedir, networkInterfaces } from 'os'
import { execSync, spawn } from 'child_process'
import crypto from 'crypto'

const OPENCLAW_DIR = path.join(homedir(), '.openclaw')
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json')
const MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp.json')
const LOGS_DIR = path.join(OPENCLAW_DIR, 'logs')
const BACKUPS_DIR = path.join(OPENCLAW_DIR, 'backups')
const DEVICE_KEY_FILE = path.join(OPENCLAW_DIR, 'clawpanel-device-key.json')
const DEVICES_DIR = path.join(OPENCLAW_DIR, 'devices')
const PAIRED_PATH = path.join(DEVICES_DIR, 'paired.json')
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write']
const PANEL_CONFIG_PATH = path.join(OPENCLAW_DIR, 'clawpanel.json')

// === 访问密码 & Session 管理 ===

const _sessions = new Map() // token → { expires }
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24h
const AUTH_EXEMPT = new Set(['auth_check', 'auth_login', 'auth_logout'])

// 登录限速：防暴力破解（IP 级别，5次失败后锁定60秒）
const _loginAttempts = new Map() // ip → { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5
const LOCKOUT_DURATION = 60 * 1000 // 60s

function checkLoginRateLimit(ip) {
  const now = Date.now()
  const record = _loginAttempts.get(ip)
  if (!record) return null
  if (record.lockedUntil && now < record.lockedUntil) {
    const remaining = Math.ceil((record.lockedUntil - now) / 1000)
    return `登录失败次数过多，请 ${remaining} 秒后再试`
  }
  if (record.lockedUntil && now >= record.lockedUntil) {
    _loginAttempts.delete(ip)
  }
  return null
}

function recordLoginFailure(ip) {
  const record = _loginAttempts.get(ip) || { count: 0, lockedUntil: null }
  record.count++
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION
    record.count = 0
  }
  _loginAttempts.set(ip, record)
}

function clearLoginAttempts(ip) {
  _loginAttempts.delete(ip)
}

// 配置缓存：避免每次请求同步读磁盘（TTL 2秒，写入时立即失效）
let _panelConfigCache = null
let _panelConfigCacheTime = 0
const CONFIG_CACHE_TTL = 2000 // 2s

function readPanelConfig() {
  const now = Date.now()
  if (_panelConfigCache && (now - _panelConfigCacheTime) < CONFIG_CACHE_TTL) {
    return JSON.parse(JSON.stringify(_panelConfigCache))
  }
  try {
    if (fs.existsSync(PANEL_CONFIG_PATH)) {
      _panelConfigCache = JSON.parse(fs.readFileSync(PANEL_CONFIG_PATH, 'utf8'))
      _panelConfigCacheTime = now
      return JSON.parse(JSON.stringify(_panelConfigCache))
    }
  } catch {}
  return {}
}

function invalidateConfigCache() {
  _panelConfigCache = null
  _panelConfigCacheTime = 0
}

function getAccessPassword() {
  return readPanelConfig().accessPassword || ''
}

function parseCookies(req) {
  const obj = {}
  ;(req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=')
    if (k) obj[k] = decodeURIComponent(v.join('='))
  })
  return obj
}

function isAuthenticated(req) {
  const pw = getAccessPassword()
  if (!pw) return true // 未设密码，放行
  const cookies = parseCookies(req)
  const token = cookies.clawpanel_session
  if (!token) return false
  const session = _sessions.get(token)
  if (!session || Date.now() > session.expires) {
    _sessions.delete(token)
    return false
  }
  return true
}

function checkPasswordStrength(pw) {
  if (!pw || pw.length < 6) return '密码至少 6 位'
  if (pw.length > 64) return '密码不能超过 64 位'
  if (/^\d+$/.test(pw)) return '密码不能是纯数字'
  const weak = ['123456', '654321', 'password', 'admin', 'qwerty', 'abc123', '111111', '000000', 'letmein', 'welcome', 'clawpanel', 'openclaw']
  if (weak.includes(pw.toLowerCase())) return '密码太常见，请换一个更安全的密码'
  return null // 通过
}

function isUnsafePath(p) {
  return !p || p.includes('..') || p.includes('\0') || path.isAbsolute(p)
}

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) { req.destroy(); resolve({}); return }
      body += chunk
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch { resolve({}) }
    })
  })
}

function getUid() {
  if (!isMac) return 0
  return execSync('id -u').toString().trim()
}

function stripUiFields(config) {
  const providers = config?.models?.providers
  if (!providers) return config
  for (const p of Object.values(providers)) {
    if (!Array.isArray(p.models)) continue
    for (const m of p.models) {
      if (typeof m !== 'object') continue
      delete m.lastTestAt
      delete m.latency
      delete m.testStatus
      delete m.testError
      if (!m.name && m.id) m.name = m.id
    }
  }
  return config
}

// === Ed25519 设备密钥管理 ===

function getOrCreateDeviceKey() {
  if (fs.existsSync(DEVICE_KEY_FILE)) {
    const data = JSON.parse(fs.readFileSync(DEVICE_KEY_FILE, 'utf8'))
    // 从存储的 hex 密钥重建 Node.js KeyObject
    const privDer = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 header
      Buffer.from(data.secretKey, 'hex'),
    ])
    const privateKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' })
    return { deviceId: data.deviceId, publicKey: data.publicKey, privateKey }
  }
  // 生成新密钥对
  const keyPair = crypto.generateKeyPairSync('ed25519')
  const pubDer = keyPair.publicKey.export({ type: 'spki', format: 'der' })
  const privDer = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' })
  const pubRaw = pubDer.slice(-32)
  const privRaw = privDer.slice(-32)
  const deviceId = crypto.createHash('sha256').update(pubRaw).digest('hex')
  const publicKey = Buffer.from(pubRaw).toString('base64url')
  const secretHex = Buffer.from(privRaw).toString('hex')
  const keyData = { deviceId, publicKey, secretKey: secretHex }
  if (!fs.existsSync(OPENCLAW_DIR)) fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  fs.writeFileSync(DEVICE_KEY_FILE, JSON.stringify(keyData, null, 2))
  return { deviceId, publicKey, privateKey: keyPair.privateKey }
}

function getLocalIps() {
  const ips = []
  const ifaces = networkInterfaces()
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
}

function patchGatewayOrigins() {
  if (!fs.existsSync(CONFIG_PATH)) return false
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const origins = [
    'tauri://localhost',
    'https://tauri.localhost',
    'http://localhost',
    'http://localhost:1420',
    'http://127.0.0.1:1420',
  ]
  for (const ip of getLocalIps()) {
    origins.push(`http://${ip}:1420`)
  }
  const newOrigins = [...new Set(origins)]
  const existing = config?.gateway?.controlUi?.allowedOrigins || []
  // 幂等：已包含所有需要的 origin 时跳过写入
  if (newOrigins.every(o => existing.includes(o))) return false
  if (!config.gateway) config.gateway = {}
  if (!config.gateway.controlUi) config.gateway.controlUi = {}
  config.gateway.controlUi.allowedOrigins = newOrigins
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak')
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  return true
}

// === macOS 服务管理 ===

function macCheckService(label) {
  try {
    const uid = getUid()
    const output = execSync(`launchctl print gui/${uid}/${label} 2>&1`).toString()
    let state = '', pid = null
    for (const line of output.split('\n')) {
      if (!line.startsWith('\t') || line.startsWith('\t\t')) continue
      const trimmed = line.trim()
      if (trimmed.startsWith('pid = ')) pid = parseInt(trimmed.slice(6)) || null
      if (trimmed.startsWith('state = ')) state = trimmed.slice(8).trim()
    }
    // 有 PID 则用 kill -0 验证进程是否存活（比 state 字符串更可靠）
    if (pid) {
      try { execSync(`kill -0 ${pid} 2>&1`); return { running: true, pid } } catch {}
    }
    // 无 PID 时 fallback 到 pgrep（launchctl 可能还没刷出 PID）
    if (state === 'running' || state === 'waiting') {
      try {
        const pgrepOut = execSync(`pgrep -f "openclaw.*gateway" 2>/dev/null`).toString().trim()
        if (pgrepOut) {
          const fallbackPid = parseInt(pgrepOut.split('\n')[0]) || null
          if (fallbackPid) return { running: true, pid: fallbackPid }
        }
      } catch {}
    }
    return { running: state === 'running', pid }
  } catch {
    return { running: false, pid: null }
  }
}

function macStartService(label) {
  const uid = getUid()
  const plistPath = path.join(homedir(), `Library/LaunchAgents/${label}.plist`)
  if (!fs.existsSync(plistPath)) throw new Error(`plist 不存在: ${plistPath}`)
  try { execSync(`launchctl bootstrap gui/${uid} "${plistPath}" 2>&1`) } catch {}
  try { execSync(`launchctl kickstart gui/${uid}/${label} 2>&1`) } catch {}
}

function macStopService(label) {
  const uid = getUid()
  try { execSync(`launchctl bootout gui/${uid}/${label} 2>&1`) } catch {}
}

function macRestartService(label) {
  const uid = getUid()
  const plistPath = path.join(homedir(), `Library/LaunchAgents/${label}.plist`)
  try { execSync(`launchctl bootout gui/${uid}/${label} 2>&1`) } catch {}
  // 等待进程退出
  for (let i = 0; i < 15; i++) {
    const { running } = macCheckService(label)
    if (!running) break
    execSync('sleep 0.2')
  }
  try { execSync(`launchctl bootstrap gui/${uid} "${plistPath}" 2>&1`) } catch {}
  try { execSync(`launchctl kickstart -k gui/${uid}/${label} 2>&1`) } catch {}
}

// === Windows 服务管理 ===

function winStartGateway() {
  // 确保日志目录存在
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
  const logPath = path.join(LOGS_DIR, 'gateway.log')
  const errPath = path.join(LOGS_DIR, 'gateway.err.log')
  const out = fs.openSync(logPath, 'a')
  const err = fs.openSync(errPath, 'a')

  // 写入启动标记到日志
  const timestamp = new Date().toISOString()
  fs.appendFileSync(logPath, `\n[${timestamp}] [ClawPanel] Starting Gateway on Windows...\n`)

  const child = spawn('openclaw', ['gateway'], {
    detached: true,
    stdio: ['ignore', out, err],
    shell: true,
    windowsHide: true,
    cwd: homedir(),
  })
  child.unref()
}

function winStopGateway() {
  const { running, pid } = winCheckGateway()
  if (!running || !pid) throw new Error('Gateway 未运行')
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { timeout: 5000, windowsHide: true })
  } catch (e) {
    throw new Error('停止失败: ' + (e.message || e))
  }
}

function winCheckGateway() {
  const port = readGatewayPort()
  try {
    // 用 netstat 精确查找监听指定端口的进程 PID
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { timeout: 3000, windowsHide: true }).toString().trim()
    if (!out) return { running: false, pid: null }
    // 提取 PID（最后一列）
    const parts = out.split('\n')[0].trim().split(/\s+/)
    const pid = parseInt(parts[parts.length - 1]) || null
    if (!pid) return { running: false, pid: null }
    // 验证进程是否为 node/openclaw（排除其他程序碰巧占用同端口）
    try {
      const taskOut = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 3000, windowsHide: true }).toString().trim()
      const isGateway = /node|openclaw/i.test(taskOut)
      return { running: isGateway, pid: isGateway ? pid : null }
    } catch {
      return { running: true, pid }
    }
  } catch {
    return { running: false, pid: null }
  }
}

function readGatewayPort() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return config?.gateway?.port || 18789
  } catch {
    return 18789
  }
}

// === Linux 服务管理 ===

/**
 * 扫描常见 Node 版本管理器路径查找 openclaw 二进制文件。
 * 解决 systemd 服务环境中 PATH 不含 nvm/volta/fnm 路径的问题。
 */
function findOpenclawBin() {
  try {
    return execSync('which openclaw 2>/dev/null', { stdio: 'pipe' }).toString().trim()
  } catch {}

  const home = homedir()
  const candidates = [
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    '/snap/bin/openclaw',
    path.join(home, '.local/bin/openclaw'),
  ]

  // nvm
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm')
  const nvmVersions = path.join(nvmDir, 'versions/node')
  if (fs.existsSync(nvmVersions)) {
    try {
      for (const entry of fs.readdirSync(nvmVersions)) {
        candidates.push(path.join(nvmVersions, entry, 'bin/openclaw'))
      }
    } catch {}
  }

  // volta
  candidates.push(path.join(home, '.volta/bin/openclaw'))

  // nodenv
  candidates.push(path.join(home, '.nodenv/shims/openclaw'))

  // fnm
  const fnmDir = process.env.FNM_DIR || path.join(home, '.local/share/fnm')
  const fnmVersions = path.join(fnmDir, 'node-versions')
  if (fs.existsSync(fnmVersions)) {
    try {
      for (const entry of fs.readdirSync(fnmVersions)) {
        candidates.push(path.join(fnmVersions, entry, 'installation/bin/openclaw'))
      }
    } catch {}
  }

  // /usr/local/lib/nodejs（手动安装的 Node.js）
  const nodejsLib = '/usr/local/lib/nodejs'
  if (fs.existsSync(nodejsLib)) {
    try {
      for (const entry of fs.readdirSync(nodejsLib)) {
        candidates.push(path.join(nodejsLib, entry, 'bin/openclaw'))
      }
    } catch {}
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function linuxCheckGateway() {
  const port = readGatewayPort()
  // ss 查端口监听
  try {
    const out = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null`, { timeout: 3000 }).toString().trim()
    const pidMatch = out.match(/pid=(\d+)/)
    if (pidMatch) return { running: true, pid: parseInt(pidMatch[1]) }
    if (out.includes(`:${port}`)) return { running: true, pid: null }
  } catch {}
  // fallback: lsof
  try {
    const out = execSync(`lsof -i :${port} -t 2>/dev/null`, { timeout: 3000 }).toString().trim()
    if (out) {
      const pid = parseInt(out.split('\n')[0]) || null
      return { running: !!pid, pid }
    }
  } catch {}
  // fallback: /proc/net/tcp
  try {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
    const tcp = fs.readFileSync('/proc/net/tcp', 'utf8')
    if (tcp.includes(`:${hexPort}`)) return { running: true, pid: null }
  } catch {}
  return { running: false, pid: null }
}

function linuxStartGateway() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
  const logPath = path.join(LOGS_DIR, 'gateway.log')
  const errPath = path.join(LOGS_DIR, 'gateway.err.log')
  const out = fs.openSync(logPath, 'a')
  const err = fs.openSync(errPath, 'a')

  const timestamp = new Date().toISOString()
  fs.appendFileSync(logPath, `\n[${timestamp}] [ClawPanel] Starting Gateway on Linux...\n`)

  const bin = findOpenclawBin() || 'openclaw'
  const child = spawn(bin, ['gateway'], {
    detached: true,
    stdio: ['ignore', out, err],
    shell: false,
    cwd: homedir(),
  })
  child.unref()
}

function linuxStopGateway() {
  const { running, pid } = linuxCheckGateway()
  if (!running || !pid) throw new Error('Gateway 未运行')
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    throw new Error('停止失败: ' + (e.message || e))
  }
}

// === API Handlers ===

const handlers = {
  // 配置读写
  read_openclaw_config() {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在，请先安装 OpenClaw')
    const content = fs.readFileSync(CONFIG_PATH, 'utf8')
    return JSON.parse(content)
  },

  write_openclaw_config({ config }) {
    const bak = CONFIG_PATH + '.bak'
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, bak)
    const cleaned = stripUiFields(config)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2))
    return true
  },

  // 使用 openclaw CLI 安全地设置 fallbacks 配置
  set_fallbacks_config({ fallbacks }) {
    try {
      // 使用 openclaw config set 命令安全地设置配置
      const fallbacksJson = JSON.stringify(fallbacks)
      execSync(`openclaw config set agents.defaults.model.fallbacks '${fallbacksJson}'`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return true
    } catch (e) {
      throw new Error(`设置 fallbacks 配置失败: ${e.message}`)
    }
  },

  read_mcp_config() {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return {}
    return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'))
  },

  write_mcp_config({ config }) {
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2))
    return true
  },

  // 服务管理
  get_services_status() {
    const label = 'ai.openclaw.gateway'
    const { running, pid } = isMac ? macCheckService(label) : isLinux ? linuxCheckGateway() : winCheckGateway()

    let cliInstalled = false
    if (isMac) {
      cliInstalled = fs.existsSync('/opt/homebrew/bin/openclaw') || fs.existsSync('/usr/local/bin/openclaw')
    } else if (isWindows) {
      try { cliInstalled = fs.existsSync(path.join(process.env.APPDATA || '', 'npm', 'openclaw.cmd')) }
      catch { cliInstalled = false }
    } else {
      cliInstalled = !!findOpenclawBin()
    }

    return [{ label, running, pid, description: 'OpenClaw Gateway', cli_installed: cliInstalled }]
  },

  start_service({ label }) {
    if (isMac) { macStartService(label); return true }
    if (isLinux) { linuxStartGateway(); return true }
    winStartGateway()
    return true
  },

  stop_service({ label }) {
    if (isMac) { macStopService(label); return true }
    if (isLinux) { linuxStopGateway(); return true }
    winStopGateway()
    return true
  },

  async restart_service({ label }) {
    if (isMac) { macRestartService(label); return true }
    if (isLinux) {
      try { linuxStopGateway() } catch {}
      for (let i = 0; i < 10; i++) {
        const { running } = linuxCheckGateway()
        if (!running) break
        await new Promise(r => setTimeout(r, 500))
      }
      linuxStartGateway()
      return true
    }
    try { winStopGateway() } catch {}
    for (let i = 0; i < 10; i++) {
      const { running } = winCheckGateway()
      if (!running) break
      await new Promise(r => setTimeout(r, 500))
    }
    winStartGateway()
    return true
  },

  reload_gateway() {
    if (isMac) {
      macRestartService('ai.openclaw.gateway')
      return 'Gateway 已重启'
    } else if (isLinux) {
      try { linuxStopGateway() } catch {}
      linuxStartGateway()
      return 'Gateway 已重启'
    } else {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    }
  },

  restart_gateway() {
    if (isMac) {
      macRestartService('ai.openclaw.gateway')
      return 'Gateway 已重启'
    } else if (isLinux) {
      try { linuxStopGateway() } catch {}
      linuxStartGateway()
      return 'Gateway 已重启'
    } else {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    }
  },

  // 安装检测
  check_installation() {
    return { installed: fs.existsSync(CONFIG_PATH), path: OPENCLAW_DIR, platform: isMac ? 'macos' : process.platform }
  },

  check_node() {
    try {
      const ver = execSync('node --version 2>&1', { windowsHide: true }).toString().trim()
      return { installed: true, version: ver }
    } catch {
      return { installed: false, version: null }
    }
  },

  // 版本信息
  get_version_info() {
    let current = null
    if (isMac) {
      try {
        const target = fs.readlinkSync('/opt/homebrew/bin/openclaw')
        const pkgPath = path.resolve('/opt/homebrew/bin', target, '..', 'package.json')
        current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
      } catch {}
    }
    if (!current) {
      try { current = execSync('openclaw --version 2>&1', { windowsHide: true }).toString().trim().split(/\s+/).pop() } catch {}
    }
    return { current, latest: null, update_available: false, source: 'chinese' }
  },

  // 模型测试
  async test_model({ baseUrl, apiKey, modelId }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 16,
      stream: false
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
      clearTimeout(timeout)
      if (!resp.ok) {
        const text = await resp.text()
        let msg = `HTTP ${resp.status}`
        try { msg = JSON.parse(text).error?.message || msg } catch {}
        throw new Error(msg)
      }
      const data = await resp.json()
      const content = data.choices?.[0]?.message?.content
      const reasoning = data.choices?.[0]?.message?.reasoning_content
      return content || (reasoning ? `[reasoning] ${reasoning}` : '（无回复内容）')
    } catch (e) {
      clearTimeout(timeout)
      if (e.name === 'AbortError') throw new Error('请求超时 (30s)')
      throw e
    }
  },

  async list_remote_models({ baseUrl, apiKey }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`
    const headers = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timeout)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const ids = (data.data || []).map(m => m.id).sort()
      if (!ids.length) throw new Error('该服务商返回了空的模型列表')
      return ids
    } catch (e) {
      clearTimeout(timeout)
      if (e.name === 'AbortError') throw new Error('请求超时 (15s)')
      throw e
    }
  },

  // 日志
  read_log_tail({ logName, lines = 100 }) {
    const logFiles = {
      'gateway': 'gateway.log',
      'gateway-err': 'gateway.err.log',
      'guardian': 'guardian.log',
      'guardian-backup': 'guardian-backup.log',
      'config-audit': 'config-audit.log',
    }
    const file = logFiles[logName] || logFiles['gateway']
    const logPath = path.join(LOGS_DIR, file)
    if (!fs.existsSync(logPath)) return ''
    try {
      return execSync(`tail -${lines} "${logPath}" 2>&1`, { windowsHide: true }).toString()
    } catch {
      const content = fs.readFileSync(logPath, 'utf8')
      return content.split('\n').slice(-lines).join('\n')
    }
  },

  search_log({ logName, query, maxResults = 50 }) {
    const logFiles = {
      'gateway': 'gateway.log',
      'gateway-err': 'gateway.err.log',
    }
    const file = logFiles[logName] || logFiles['gateway']
    const logPath = path.join(LOGS_DIR, file)
    if (!fs.existsSync(logPath)) return []
    // 纯 JS 实现，避免 shell 命令注入
    const content = fs.readFileSync(logPath, 'utf8')
    const queryLower = (query || '').toLowerCase()
    const matched = content.split('\n').filter(line => line.toLowerCase().includes(queryLower))
    return matched.slice(-maxResults)
  },

  // Agent 管理
  list_agents() {
    const result = [{ id: 'main', isDefault: true, identityName: null, model: null, workspace: null }]
    const agentsDir = path.join(OPENCLAW_DIR, 'agents')
    if (fs.existsSync(agentsDir)) {
      try {
        for (const entry of fs.readdirSync(agentsDir)) {
          if (entry === 'main') continue
          const p = path.join(agentsDir, entry)
          if (fs.statSync(p).isDirectory()) {
            result.push({ id: entry, isDefault: false, identityName: null, model: null, workspace: null })
          }
        }
      } catch {}
    }
    return result
  },

  // 记忆文件
  list_memory_files({ category, agent_id }) {
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const dir = path.join(OPENCLAW_DIR, 'workspace' + suffix, category || 'memory')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(f => f.endsWith('.md'))
  },

  read_memory_file({ path: filePath, agent_id }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const full = path.join(OPENCLAW_DIR, 'workspace' + suffix, filePath)
    if (!fs.existsSync(full)) return ''
    return fs.readFileSync(full, 'utf8')
  },

  write_memory_file({ path: filePath, content, category, agent_id }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const full = path.join(OPENCLAW_DIR, 'workspace' + suffix, filePath)
    const dir = path.dirname(full)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(full, content)
    return true
  },

  delete_memory_file({ path: filePath, agent_id }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const full = path.join(OPENCLAW_DIR, 'workspace' + suffix, filePath)
    if (fs.existsSync(full)) fs.unlinkSync(full)
    return true
  },

  export_memory_zip({ category, agent_id }) {
    throw new Error('ZIP 导出仅在 Tauri 桌面应用中可用')
  },

  // 备份管理
  list_backups() {
    if (!fs.existsSync(BACKUPS_DIR)) return []
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(name => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, name))
        return { name, size: stat.size, created_at: Math.floor((stat.birthtimeMs || stat.mtimeMs) / 1000) }
      })
      .sort((a, b) => b.created_at - a.created_at)
  },

  create_backup() {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true })
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const name = `openclaw-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUPS_DIR, name))
    return { name, size: fs.statSync(path.join(BACKUPS_DIR, name)).size }
  },

  restore_backup({ name }) {
    if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('非法文件名')
    const src = path.join(BACKUPS_DIR, name)
    if (!fs.existsSync(src)) throw new Error('备份不存在')
    if (fs.existsSync(CONFIG_PATH)) handlers.create_backup()
    fs.copyFileSync(src, CONFIG_PATH)
    return true
  },

  delete_backup({ name }) {
    if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('非法文件名')
    const p = path.join(BACKUPS_DIR, name)
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return true
  },

  // Vision 补丁
  patch_model_vision() {
    if (!fs.existsSync(CONFIG_PATH)) return false
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    let changed = false
    const providers = config?.models?.providers
    if (providers) {
      for (const p of Object.values(providers)) {
        if (!Array.isArray(p.models)) continue
        for (const m of p.models) {
          if (typeof m === 'object' && !m.input) {
            m.input = ['text', 'image']
            changed = true
          }
        }
      }
    }
    if (changed) {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak')
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    }
    return changed
  },

  // Gateway 安装/卸载
  install_gateway() {
    try { execSync('openclaw --version 2>&1', { windowsHide: true }) } catch { throw new Error('openclaw CLI 未安装') }
    return execSync('openclaw gateway install 2>&1', { windowsHide: true }).toString() || 'Gateway 服务已安装'
  },

  upgrade_openclaw({ source = 'chinese' } = {}) {
    const OPENCLAW_DIR = path.join(homedir(), '.openclaw')
    const pkg = source === 'official' ? '@anthropic-ai/claw' : '@qingchencloud/openclaw-zh'
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    try {
      const out = execSync(`${npmBin} install ${pkg}@latest --prefix "${OPENCLAW_DIR}" 2>&1`, { timeout: 120000, windowsHide: true }).toString()
      return `升级完成 (${source})\n${out.slice(-200)}`
    } catch (e) {
      throw new Error('升级失败: ' + (e.stderr?.toString() || e.message).slice(-300))
    }
  },

  uninstall_gateway() {
    if (isMac) {
      const uid = getUid()
      try { execSync(`launchctl bootout gui/${uid}/ai.openclaw.gateway 2>&1`) } catch {}
      const plist = path.join(homedir(), 'Library/LaunchAgents/ai.openclaw.gateway.plist')
      if (fs.existsSync(plist)) fs.unlinkSync(plist)
    }
    return 'Gateway 服务已卸载'
  },

  // 自动初始化配置文件（CLI 已装但 openclaw.json 不存在时）
  init_openclaw_config() {
    if (fs.existsSync(CONFIG_PATH)) return { created: false, message: '配置文件已存在' }
    if (!fs.existsSync(OPENCLAW_DIR)) fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
    const defaultConfig = {
      "$schema": "https://openclaw.ai/schema/config.json",
      meta: { lastTouchedVersion: "2026.1.1" },
      models: { providers: {} },
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "none" },
        controlUi: { allowedOrigins: ["*"], allowInsecureAuth: true }
      },
      tools: { profile: "full", sessions: { visibility: "all" } }
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2))
    return { created: true, message: '配置文件已创建' }
  },

  get_deploy_config() {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const gw = config.gateway || {}
      return { gatewayUrl: `http://127.0.0.1:${gw.port || 18789}`, authToken: gw.auth?.token || '', version: null }
    } catch {
      return { gatewayUrl: 'http://127.0.0.1:18789', authToken: '', version: null }
    }
  },

  get_npm_registry() {
    const regFile = path.join(OPENCLAW_DIR, 'npm-registry.txt')
    if (fs.existsSync(regFile)) return fs.readFileSync(regFile, 'utf8').trim() || 'https://registry.npmmirror.com'
    return 'https://registry.npmmirror.com'
  },

  set_npm_registry({ registry }) {
    fs.writeFileSync(path.join(OPENCLAW_DIR, 'npm-registry.txt'), registry.trim())
    return true
  },

  // 扩展工具
  get_cftunnel_status() {
    if (!isMac) return { installed: false }
    try {
      const ver = execSync('cftunnel --version 2>&1').toString().trim()
      let running = false, pid = null
      try {
        const pgrepOut = execSync('pgrep -f cloudflared 2>/dev/null').toString().trim()
        if (pgrepOut) { running = true; pid = parseInt(pgrepOut.split('\n')[0]) || null }
      } catch {}
      // 读取 config.yml 获取 tunnel_name 和 routes
      let tunnel_name = '', routes = []
      const cfgPath = path.join(homedir(), '.cftunnel/config.yml')
      if (fs.existsSync(cfgPath)) {
        const cfgText = fs.readFileSync(cfgPath, 'utf8')
        const nameMatch = cfgText.match(/^\s+name:\s*(.+)$/m)
        if (nameMatch) tunnel_name = nameMatch[1].trim()
        // 解析 routes 数组
        const routeBlocks = cfgText.split(/^\s+-\s+name:/m).slice(1)
        routes = routeBlocks.map(block => {
          const lines = ('name:' + block).split('\n')
          const get = key => { const l = lines.find(x => x.trim().startsWith(key + ':')); return l ? l.split(':').slice(1).join(':').trim() : '' }
          return { name: get('name'), domain: get('hostname'), service: get('service') }
        }).filter(r => r.name)
      }
      return { installed: true, version: ver, running, pid, tunnel_name, routes }
    } catch {
      return { installed: false }
    }
  },

  get_clawapp_status() {
    if (!isMac) return { installed: false, running: false, pid: null, port: 3210, url: 'http://localhost:3210' }
    // 检测 ClawApp 进程是否运行（Node 服务监听 3210 端口）
    let running = false, pid = null, port = 3210
    try {
      const lsofOut = execSync('lsof -i :3210 -t 2>/dev/null').toString().trim()
      if (lsofOut) { running = true; pid = parseInt(lsofOut.split('\n')[0]) || null }
    } catch {}
    // 检测是否安装
    const clawappDir = path.join(homedir(), 'Desktop/clawapp')
    const installed = fs.existsSync(clawappDir)
    return { installed, running, pid, port, url: `http://localhost:${port}` }
  },

  // 设备配对 + Gateway 握手
  auto_pair_device() {
    const originsChanged = patchGatewayOrigins()
    const { deviceId, publicKey } = getOrCreateDeviceKey()
    if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR, { recursive: true })
    let paired = {}
    if (fs.existsSync(PAIRED_PATH)) paired = JSON.parse(fs.readFileSync(PAIRED_PATH, 'utf8'))
    const platform = process.platform === 'darwin' ? 'macos' : process.platform
    if (paired[deviceId]) {
      if (paired[deviceId].platform !== platform) {
        paired[deviceId].platform = platform
        paired[deviceId].deviceFamily = 'desktop'
        fs.writeFileSync(PAIRED_PATH, JSON.stringify(paired, null, 2))
        return { message: '设备已配对（已修正平台字段）', changed: true }
      }
      return { message: '设备已配对', changed: originsChanged }
    }
    const nowMs = Date.now()
    paired[deviceId] = {
      deviceId, publicKey, platform, deviceFamily: 'desktop',
      clientId: 'openclaw-control-ui', clientMode: 'ui',
      role: 'operator', roles: ['operator'],
      scopes: SCOPES, approvedScopes: SCOPES, tokens: {},
      createdAtMs: nowMs, approvedAtMs: nowMs,
    }
    fs.writeFileSync(PAIRED_PATH, JSON.stringify(paired, null, 2))
    return { message: '设备配对成功', changed: true }
  },

  check_pairing_status() {
    if (!fs.existsSync(DEVICE_KEY_FILE)) return { paired: false }
    const keyData = JSON.parse(fs.readFileSync(DEVICE_KEY_FILE, 'utf8'))
    if (!fs.existsSync(PAIRED_PATH)) return { paired: false }
    const paired = JSON.parse(fs.readFileSync(PAIRED_PATH, 'utf8'))
    return { paired: !!paired[keyData.deviceId] }
  },

  create_connect_frame({ nonce, gatewayToken }) {
    const { deviceId, publicKey, privateKey } = getOrCreateDeviceKey()
    const signedAt = Date.now()
    const platform = process.platform === 'darwin' ? 'macos' : process.platform
    const scopesStr = SCOPES.join(',')
    const payloadStr = `v3|${deviceId}|openclaw-control-ui|ui|operator|${scopesStr}|${signedAt}|${gatewayToken || ''}|${nonce || ''}|${platform}|desktop`
    const signature = crypto.sign(null, Buffer.from(payloadStr), privateKey)
    const sigB64 = Buffer.from(signature).toString('base64url')
    const idHex = (signedAt & 0xFFFFFFFF).toString(16).padStart(8, '0')
    const rndHex = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0')
    return {
      type: 'req',
      id: `connect-${idHex}-${rndHex}`,
      method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'openclaw-control-ui', version: '1.0.0', platform, deviceFamily: 'desktop', mode: 'ui' },
        role: 'operator', scopes: SCOPES, caps: [],
        auth: { token: gatewayToken || '' },
        device: { id: deviceId, publicKey, signedAt, nonce: nonce || '', signature: sigB64 },
        locale: 'zh-CN', userAgent: 'ClawPanel/1.0.0 (web)',
      },
    }
  },
  // 数据目录 & 图片存储
  assistant_ensure_data_dir() {
    const dataDir = path.join(OPENCLAW_DIR, 'clawpanel')
    for (const sub of ['images', 'sessions', 'cache']) {
      const dir = path.join(dataDir, sub)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
    return dataDir
  },

  assistant_save_image({ id, data }) {
    const dir = path.join(OPENCLAW_DIR, 'clawpanel', 'images')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const pureB64 = data.includes(',') ? data.split(',')[1] : data
    const ext = data.startsWith('data:image/png') ? 'png'
      : data.startsWith('data:image/gif') ? 'gif'
      : data.startsWith('data:image/webp') ? 'webp' : 'jpg'
    const filepath = path.join(dir, `${id}.${ext}`)
    fs.writeFileSync(filepath, Buffer.from(pureB64, 'base64'))
    return filepath
  },

  assistant_load_image({ id }) {
    const dir = path.join(OPENCLAW_DIR, 'clawpanel', 'images')
    for (const ext of ['jpg', 'png', 'gif', 'webp', 'jpeg']) {
      const filepath = path.join(dir, `${id}.${ext}`)
      if (fs.existsSync(filepath)) {
        const bytes = fs.readFileSync(filepath)
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        return `data:${mime};base64,${bytes.toString('base64')}`
      }
    }
    throw new Error(`图片 ${id} 不存在`)
  },

  assistant_delete_image({ id }) {
    const dir = path.join(OPENCLAW_DIR, 'clawpanel', 'images')
    for (const ext of ['jpg', 'png', 'gif', 'webp', 'jpeg']) {
      const filepath = path.join(dir, `${id}.${ext}`)
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
    }
    return null
  },

  // === 访问密码认证 ===
  auth_check() {
    const pw = getAccessPassword()
    return { required: !!pw, authenticated: false /* 由中间件覆写 */ }
  },
  auth_login() { throw new Error('由中间件处理') },
  auth_logout() { throw new Error('由中间件处理') },
  auth_set_password({ password }) {
    const cfg = readPanelConfig()
    cfg.accessPassword = password || ''
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    // 清除所有 session（密码变更后强制重新登录）
    _sessions.clear()
    return true
  },

  check_panel_update() { return { latest: null, url: 'https://github.com/qingchencloud/clawpanel/releases' } },
  write_env_file({ path: p, config }) {
    const expanded = p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
    if (!expanded.startsWith(OPENCLAW_DIR)) throw new Error('只允许写入 ~/.openclaw/ 下的文件')
    const dir = path.dirname(expanded)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(expanded, config)
    return true
  },
}

// === Vite 插件 ===

// 初始化：密码检测 + 启动日志 + 定时清理
function _initApi() {
  const cfg = readPanelConfig()
  if (!cfg.accessPassword && !cfg.ignoreRisk) {
    cfg.accessPassword = '123456'
    cfg.mustChangePassword = true
    if (!fs.existsSync(OPENCLAW_DIR)) fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    invalidateConfigCache()
    console.log('[api] ⚠️  首次启动，默认访问密码: 123456')
    console.log('[api] ⚠️  首次登录后将强制要求修改密码')
  }
  const pw = getAccessPassword()
  console.log('[api] API 已启动，配置目录:', OPENCLAW_DIR)
  console.log('[api] 平台:', isMac ? 'macOS' : process.platform)
  console.log('[api] 访问密码:', pw ? '已设置' : (cfg.ignoreRisk ? '无视风险模式（无密码）' : '未设置'))

  // 定时清理过期 session 和登录限速记录（每 10 分钟）
  setInterval(() => {
    const now = Date.now()
    for (const [token, session] of _sessions) {
      if (now > session.expires) _sessions.delete(token)
    }
    for (const [ip, record] of _loginAttempts) {
      if (record.lockedUntil && now >= record.lockedUntil) _loginAttempts.delete(ip)
    }
  }, 10 * 60 * 1000)
}

// API 中间件（dev server 和 preview server 共用）
async function _apiMiddleware(req, res, next) {
  if (!req.url?.startsWith('/__api/')) return next()

  const cmd = req.url.slice(7).split('?')[0]

  // --- 认证特殊处理 ---
  if (cmd === 'auth_check') {
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    const isDefault = pw === '123456'
    const resp = {
      required: !!pw,
      authenticated: !pw || isAuthenticated(req),
      mustChangePassword: isDefault,
    }
    if (isDefault) resp.defaultPassword = '123456'
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(resp))
    return
  }

  if (cmd === 'auth_login') {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || ''
    const rateLimitErr = checkLoginRateLimit(clientIp)
    if (rateLimitErr) {
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: rateLimitErr }))
      return
    }
    const args = await readBody(req)
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    if (!pw) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true }))
      return
    }
    if (args.password !== pw) {
      recordLoginFailure(clientIp)
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '密码错误' }))
      return
    }
    clearLoginAttempts(clientIp)
    const token = crypto.randomUUID()
    _sessions.set(token, { expires: Date.now() + SESSION_TTL })
    res.setHeader('Set-Cookie', `clawpanel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: true, mustChangePassword: !!cfg.mustChangePassword }))
    return
  }

  if (cmd === 'auth_change_password') {
    const args = await readBody(req)
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    if (pw && !isAuthenticated(req)) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '未登录' }))
      return
    }
    if (pw && args.oldPassword !== pw) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '当前密码错误' }))
      return
    }
    const weakErr = checkPasswordStrength(args.newPassword)
    if (weakErr) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: weakErr }))
      return
    }
    if (args.newPassword === pw) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '新密码不能与旧密码相同' }))
      return
    }
    cfg.accessPassword = args.newPassword
    delete cfg.mustChangePassword
    delete cfg.ignoreRisk
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    invalidateConfigCache()
    _sessions.clear()
    const token = crypto.randomUUID()
    _sessions.set(token, { expires: Date.now() + SESSION_TTL })
    res.setHeader('Set-Cookie', `clawpanel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: true }))
    return
  }

  if (cmd === 'auth_status') {
    const cfg = readPanelConfig()
    if (cfg.accessPassword && !isAuthenticated(req)) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '未登录' }))
      return
    }
    const isDefault = cfg.accessPassword === '123456'
    const result = {
      hasPassword: !!cfg.accessPassword,
      mustChangePassword: isDefault,
      ignoreRisk: !!cfg.ignoreRisk,
    }
    if (isDefault) {
      result.defaultPassword = '123456'
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(result))
    return
  }

  if (cmd === 'auth_ignore_risk') {
    if (!isAuthenticated(req)) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: '未登录' }))
      return
    }
    const args = await readBody(req)
    const cfg = readPanelConfig()
    if (args.enable) {
      delete cfg.accessPassword
      delete cfg.mustChangePassword
      cfg.ignoreRisk = true
      _sessions.clear()
    } else {
      delete cfg.ignoreRisk
    }
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    invalidateConfigCache()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: true }))
    return
  }

  if (cmd === 'auth_logout') {
    const cookies = parseCookies(req)
    if (cookies.clawpanel_session) _sessions.delete(cookies.clawpanel_session)
    res.setHeader('Set-Cookie', 'clawpanel_session=; Path=/; HttpOnly; Max-Age=0')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: true }))
    return
  }

  // --- 认证中间件：非豁免接口必须校验 ---
  if (!isAuthenticated(req)) {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: '未登录', code: 'AUTH_REQUIRED' }))
    return
  }

  const handler = handlers[cmd]

  if (!handler) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: `未实现的命令: ${cmd}` }))
    return
  }

  try {
    const args = await readBody(req)
    const result = await handler(args)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(result))
  } catch (e) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: e.message || String(e) }))
  }
}

export function devApiPlugin() {
  let _inited = false
  function ensureInit() {
    if (_inited) return
    _inited = true
    _initApi()
  }
  return {
    name: 'clawpanel-dev-api',
    configureServer(server) {
      ensureInit()
      server.middlewares.use(_apiMiddleware)
    },
    configurePreviewServer(server) {
      ensureInit()
      server.middlewares.use(_apiMiddleware)
    },
  }
}
