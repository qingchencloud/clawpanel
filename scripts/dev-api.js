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
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write']

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => body += chunk)
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
    cwd: homedir(),
  })
  child.unref()
}

function winStopGateway() {
  const { running, pid } = winCheckGateway()
  if (!running || !pid) throw new Error('Gateway 未运行')
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { timeout: 5000 })
  } catch (e) {
    throw new Error('停止失败: ' + (e.message || e))
  }
}

function winCheckGateway() {
  const port = readGatewayPort()
  try {
    // 用 netstat 精确查找监听指定端口的进程 PID
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { timeout: 3000 }).toString().trim()
    if (!out) return { running: false, pid: null }
    // 提取 PID（最后一列）
    const parts = out.split('\n')[0].trim().split(/\s+/)
    const pid = parseInt(parts[parts.length - 1]) || null
    if (!pid) return { running: false, pid: null }
    // 验证进程是否为 node/openclaw（排除其他程序碰巧占用同端口）
    try {
      const taskOut = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 3000 }).toString().trim()
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
    const { running, pid } = isMac ? macCheckService(label) : winCheckGateway()

    let cliInstalled = false
    if (isMac) {
      cliInstalled = fs.existsSync('/opt/homebrew/bin/openclaw') || fs.existsSync('/usr/local/bin/openclaw')
    } else if (isWindows) {
      try { cliInstalled = fs.existsSync(path.join(process.env.APPDATA || '', 'npm', 'openclaw.cmd')) }
      catch { cliInstalled = false }
    } else {
      // Linux - 使用 which 命令动态查找
      try {
        execSync('which openclaw', { stdio: 'pipe' })
        cliInstalled = true
      } catch {
        cliInstalled = false
      }
    }

    return [{ label, running, pid, description: 'OpenClaw Gateway', cli_installed: cliInstalled }]
  },

  start_service({ label }) {
    if (isMac) { macStartService(label); return true }
    winStartGateway()
    return true
  },

  stop_service({ label }) {
    if (isMac) { macStopService(label); return true }
    winStopGateway()
    return true
  },

  async restart_service({ label }) {
    if (isMac) { macRestartService(label); return true }
    try { winStopGateway() } catch {}
    // 等待进程退出
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
    } else if (isWindows) {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    } else {
      // Linux
      try {
        execSync('systemctl restart clawpanel', { stdio: 'inherit' })
        return 'Gateway 已重启'
      } catch (err) {
        throw new Error(`重启失败: ${err.message}`)
      }
    }
  },

  restart_gateway() {
    if (isMac) {
      macRestartService('ai.openclaw.gateway')
      return 'Gateway 已重启'
    } else if (isWindows) {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    } else {
      // Linux
      try {
        execSync('systemctl restart clawpanel', { stdio: 'inherit' })
        return 'Gateway 已重启'
      } catch (err) {
        throw new Error(`重启失败: ${err.message}`)
      }
    }
  },

  // 安装检测
  check_installation() {
    return { installed: fs.existsSync(CONFIG_PATH), path: OPENCLAW_DIR, platform: isMac ? 'macos' : process.platform }
  },

  check_node() {
    try {
      const ver = execSync('node --version 2>&1').toString().trim()
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
      try { current = execSync('openclaw --version 2>&1').toString().trim().split(/\s+/).pop() } catch {}
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
      return execSync(`tail -${lines} "${logPath}" 2>&1`).toString()
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
    try {
      const output = execSync(`grep -i "${query.replace(/"/g, '\\"')}" "${logPath}" | tail -${maxResults} 2>&1`).toString()
      return output.split('\n').filter(Boolean)
    } catch {
      return []
    }
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
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const full = path.join(OPENCLAW_DIR, 'workspace' + suffix, filePath)
    if (!fs.existsSync(full)) return ''
    return fs.readFileSync(full, 'utf8')
  },

  write_memory_file({ path: filePath, content, category, agent_id }) {
    const suffix = agent_id && agent_id !== 'main' ? `/agents/${agent_id}` : ''
    const full = path.join(OPENCLAW_DIR, 'workspace' + suffix, filePath)
    const dir = path.dirname(full)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(full, content)
    return true
  },

  delete_memory_file({ path: filePath, agent_id }) {
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
    try { execSync('openclaw --version 2>&1') } catch { throw new Error('openclaw CLI 未安装') }
    return execSync('openclaw gateway install 2>&1').toString() || 'Gateway 服务已安装'
  },

  upgrade_openclaw({ source = 'chinese' } = {}) {
    const OPENCLAW_DIR = path.join(homedir(), '.openclaw')
    const pkg = source === 'official' ? '@anthropic-ai/claw' : '@qingchencloud/openclaw-zh'
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    try {
      const out = execSync(`${npmBin} install ${pkg}@latest --prefix "${OPENCLAW_DIR}" 2>&1`, { timeout: 120000 }).toString()
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

  clawhub_trending() {
    const fallback = [
      { slug: 'agent-browser', displayName: 'Agent Browser', summary: '浏览器自动化 CLI，支持点击、输入、抓取和截图。', author: 'TheSethRose', downloadsText: '73.9k', url: 'https://clawhub.ai/TheSethRose/agent-browser', source: 'clawhub' },
      { slug: 'github', displayName: 'Github', summary: '通过 gh CLI 与 GitHub issues、PR、CI 交互。', author: 'steipete', downloadsText: '72.5k', url: 'https://clawhub.ai/steipete/github', source: 'clawhub' },
      { slug: 'weather', displayName: 'Weather', summary: '获取当前天气和预报，无需 API Key。', author: 'steipete', downloadsText: '61.9k', url: 'https://clawhub.ai/steipete/weather', source: 'clawhub' },
      { slug: 'find-skills', displayName: 'Find Skills', summary: '帮助用户发现并安装合适的 skills。', author: 'JimLiuxinghai', downloadsText: '99.3k', url: 'https://clawhub.ai/JimLiuxinghai/find-skills', source: 'clawhub' },
      { slug: 'summarize', displayName: 'Summarize', summary: '总结网页、PDF、图片、音频等内容。', author: 'steipete', downloadsText: '82.7k', url: 'https://clawhub.ai/steipete/summarize', source: 'clawhub' },
      { slug: 'brave-search', displayName: 'Brave Search', summary: '轻量网页搜索和内容提取。', author: 'steipete', downloadsText: '29.4k', url: 'https://clawhub.ai/steipete/brave-search', source: 'clawhub' },
    ]
    try {
      const out = execSync('npx -y clawhub explore --sort downloads --limit 12 --json', { encoding: 'utf8', timeout: 30000 })
      const data = JSON.parse(out)
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      const normalized = items
        .map(item => ({
          slug: String(item?.slug || '').trim(),
          displayName: String(item?.displayName || item?.name || item?.slug || '').trim(),
          summary: String(item?.summary || item?.description || '').trim(),
          author: String(item?.author?.handle || item?.author || '').trim(),
          downloadsText: String(item?.stats?.downloadsText || item?.downloadsText || item?.downloads || '').trim(),
          url: String(item?.url || item?.canonicalUrl || '').trim(),
          source: 'clawhub'
        }))
        .filter(item => item.slug)
      return normalized.length ? normalized : fallback
    } catch {
      return fallback
    }
  },

  clawhub_search({ query }) {
    const q = String(query || '').trim()
    if (!q) return []
    try {
      const out = execSync(`npx -y clawhub search ${JSON.stringify(q)} --limit 12`, { encoding: 'utf8', timeout: 30000 })
      return out.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('-'))
        .map(line => {
          const parts = line.split(/\s{2,}/).filter(Boolean)
          return {
            slug: parts[0] || '',
            displayName: parts[1] || parts[0] || '',
            summary: '',
            source: 'clawhub'
          }
        })
    } catch (e) {
      console.warn('[dev-api] clawhub search failed:', e.message)
      return []
    }
  },

  clawhub_list_installed() {
    const skillsDir = path.join(OPENCLAW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const out = execSync('npx -y clawhub list', { cwd: homedir(), encoding: 'utf8', timeout: 30000 })
      const fromCli = out.split('\n')
        .map(line => line.trim())
        .filter(line => line && line !== 'No installed skills.')
        .map(line => ({ slug: line.split(/\s+/)[0], installed: true }))
      if (fromCli.length) return fromCli
    } catch {}

    // 兜底：直接扫描 ~/.openclaw/skills 目录，避免 CLI 输出格式变化导致空列表
    try {
      return fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => ({ slug: entry.name, installed: true }))
    } catch {
      return []
    }
  },

  clawhub_inspect({ slug }) {
    try {
      const out = execSync(`npx -y clawhub inspect ${JSON.stringify(slug)} --json`, { encoding: 'utf8', timeout: 30000 })
      return JSON.parse(out)
    } catch (e) {
      throw new Error(`clawhub inspect 失败: ${e.message}`)
    }
  },

  clawhub_install({ slug }) {
    const skillsDir = path.join(OPENCLAW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const out = execSync(`npx -y clawhub install ${JSON.stringify(slug)} --workdir .openclaw --dir skills`, { cwd: homedir(), encoding: 'utf8', timeout: 120000 })
      return { success: true, slug, output: out.trim() }
    } catch (e) {
      throw new Error(`clawhub install 失败: ${e.message}`)
    }
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

export function devApiPlugin() {
  return {
    name: 'clawpanel-dev-api',
    configureServer(server) {
      console.log('[dev-api] 开发 API 已启动，配置目录:', OPENCLAW_DIR)
      console.log('[dev-api] 平台:', isMac ? 'macOS' : process.platform)

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__api/')) return next()

        const cmd = req.url.slice(7).split('?')[0]
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
      })
    }
  }
}
