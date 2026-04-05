/**
 * ClawPanel 开发模式 API 插件
 * 在 Vite 开发服务器上提供真实 API 端点，替代 mock 数据
 * 使浏览器模式能真正管理 OpenClaw 实例
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { homedir, networkInterfaces } from 'os'
import { execSync, spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import net from 'net'
import http from 'http'
import crypto from 'crypto'
const DOCKER_TASK_TIMEOUT_MS = 10 * 60 * 1000

const __dev_dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OPENCLAW_DIR = path.join(homedir(), '.openclaw')
let OPENCLAW_DIR = DEFAULT_OPENCLAW_DIR
let CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json')
let MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp.json')
let LOGS_DIR = path.join(OPENCLAW_DIR, 'logs')
let BACKUPS_DIR = path.join(OPENCLAW_DIR, 'backups')
let DEVICE_KEY_FILE = path.join(OPENCLAW_DIR, 'clawpanel-device-key.json')
let DEVICES_DIR = path.join(OPENCLAW_DIR, 'devices')
let PAIRED_PATH = path.join(DEVICES_DIR, 'paired.json')
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write']
const CLUSTER_TOKEN = 'clawpanel-cluster-secret-2026'
const PANEL_CONFIG_PATH = path.join(DEFAULT_OPENCLAW_DIR, 'clawpanel.json')
const PANEL_STATE_DIR = path.dirname(PANEL_CONFIG_PATH)
const DOCKER_NODES_PATH = path.join(PANEL_STATE_DIR, 'docker-nodes.json')
const INSTANCES_PATH = path.join(PANEL_STATE_DIR, 'instances.json')
const DEFAULT_DOCKER_SOCKET = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'
const DEFAULT_OPENCLAW_IMAGE = 'ghcr.io/qingchencloud/openclaw'
const PANEL_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dev_dirname, '..', 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const VERSION_POLICY_PATH = path.join(__dev_dirname, '..', 'openclaw-version-policy.json')
function normalizeCustomOpenclawDir(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const expanded = trimmed.startsWith('~/') ? path.join(homedir(), trimmed.slice(2)) : trimmed
  return path.resolve(expanded)
}

function applyOpenclawPathConfig(panelConfig) {
  const customDir = normalizeCustomOpenclawDir(panelConfig?.openclawDir)
  OPENCLAW_DIR = customDir || DEFAULT_OPENCLAW_DIR
  CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json')
  MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp.json')
  LOGS_DIR = path.join(OPENCLAW_DIR, 'logs')
  BACKUPS_DIR = path.join(OPENCLAW_DIR, 'backups')
  DEVICE_KEY_FILE = path.join(OPENCLAW_DIR, 'clawpanel-device-key.json')
  DEVICES_DIR = path.join(OPENCLAW_DIR, 'devices')
  PAIRED_PATH = path.join(DEVICES_DIR, 'paired.json')
  process.env.OPENCLAW_HOME = OPENCLAW_DIR
  process.env.OPENCLAW_STATE_DIR = OPENCLAW_DIR
  process.env.OPENCLAW_CONFIG_PATH = CONFIG_PATH
  return { path: OPENCLAW_DIR, isCustom: !!customDir }
}

function normalizeCliPath(raw) {
  if (typeof raw !== 'string') return null
  const expanded = expandHomePath(raw.trim())
  if (!expanded) return null
  return path.resolve(expanded)
}

function canonicalCliPath(raw) {
  const normalized = normalizeCliPath(raw)
  if (!normalized) return null
  try {
    return fs.realpathSync.native(normalized)
  } catch {
    return normalized
  }
}

function scanCliIdentity(rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized) return null
  let identityPath = normalized
  if (isWindows) {
    const base = path.basename(normalized).toLowerCase()
    if (base === 'openclaw' || base === 'openclaw.exe' || base === 'openclaw.ps1') {
      const cmdPath = path.join(path.dirname(normalized), 'openclaw.cmd')
      if (fs.existsSync(cmdPath)) identityPath = cmdPath
    }
  }
  return canonicalCliPath(identityPath) || identityPath
}

function isRejectedCliPath(cliPath) {
  const lower = String(cliPath || '').replace(/\\/g, '/').toLowerCase()
  return lower.includes('/.cherrystudio/') || lower.includes('cherry-studio')
}

function addCliCandidate(candidates, seen, rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized || !fs.existsSync(normalized) || isRejectedCliPath(normalized)) return
  const identity = scanCliIdentity(normalized) || normalized
  const key = isWindows ? identity.toLowerCase() : identity
  if (seen.has(key)) return
  seen.add(key)
  candidates.push(normalized)
}

function findCommandPath(command) {
  try {
    const output = execSync(isWindows ? `where ${command}` : `which ${command} 2>/dev/null`, {
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!output) return null
    const first = output.split(/\r?\n/).map(line => line.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

function normalizeCommandPath(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const expanded = expandHomePath(trimmed)
  if (!expanded) return null
  const looksLikePath =
    trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.') || /^~[\\/]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
  return looksLikePath ? path.resolve(expanded) : expanded
}

function readConfiguredGitPath() {
  return normalizeCommandPath(readPanelConfig()?.gitPath || '')
}

function resolveGitExecutable() {
  const gitPath = readConfiguredGitPath()
  const isCustom = !!gitPath
  const isPathLike = !!gitPath && (gitPath.includes('/') || gitPath.includes('\\') || /^[A-Za-z]:[\\/]/.test(gitPath))
  return { gitPath: gitPath || 'git', isCustom, isPathLike }
}

function buildGitCommandEnv(extraEnv = {}, resolved = resolveGitExecutable()) {
  const env = { ...process.env, ...(extraEnv || {}) }
  if (resolved.isCustom && resolved.isPathLike) {
    const dir = path.dirname(resolved.gitPath)
    env.PATH = [dir, env.PATH || ''].filter(Boolean).join(path.delimiter)
  }
  if (resolved.isCustom) env.GIT = resolved.gitPath
  return env
}

function runGitSync(args, options = {}) {
  const resolved = resolveGitExecutable()
  const env = buildGitCommandEnv(options.env, resolved)
  const result = spawnSync(resolved.gitPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
    env,
  })
  return { ...resolved, result }
}

function readConfiguredOpenclawSearchPaths() {
  const entries = readPanelConfig()?.openclawSearchPaths
  if (!Array.isArray(entries)) return []
  const paths = []
  const seen = new Set()
  for (const entry of entries) {
    const normalized = normalizeCustomOpenclawDir(entry)
    if (!normalized) continue
    const key = isWindows ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(normalized)
  }
  return paths
}

function addConfiguredOpenclawCandidates(candidates, seen) {
  for (const configured of readConfiguredOpenclawSearchPaths()) {
    const resolved = resolveOpenclawCliInput(configured)
    if (resolved) addCliCandidate(candidates, seen, resolved)
  }
}

function detectWindowsShimSource(cliPath) {
  if (!isWindows) return null
  const normalized = normalizeCliPath(cliPath)
  if (!normalized || !fs.existsSync(normalized)) return null
  try {
    const lower = fs.readFileSync(normalized, 'utf8').toLowerCase()
    if (lower.includes('@qingchencloud') || lower.includes('openclaw-zh')) return 'npm-zh'
    if (lower.includes('/node_modules/openclaw/') || lower.includes('\\node_modules\\openclaw\\')) return 'npm-official'
  } catch {}
  return null
}

function classifyCliSource(cliPath) {
  const normalized = normalizeCliPath(cliPath)
  if (!normalized) return null
  const lower = normalized.replace(/\\/g, '/').toLowerCase()
  if (lower.includes('/programs/openclaw/') || lower.includes('/openclaw-bin/') || lower.includes('/opt/openclaw/')) return 'standalone'
  if (lower.includes('openclaw-zh') || lower.includes('@qingchencloud')) return 'npm-zh'
  if (isWindows) {
    const shimSource = detectWindowsShimSource(normalized)
    if (shimSource) return shimSource
  }
  if (lower.includes('/npm/') || lower.includes('/node_modules/')) return 'npm-official'
  if (lower.includes('/homebrew/') || lower.includes('/usr/local/bin/') || lower.includes('/usr/bin/')) return 'npm-global'
  return 'unknown'
}

function normalizeCliInstallSource(cliSource) {
  if (cliSource === 'standalone' || cliSource === 'npm-zh') return 'chinese'
  if (cliSource === 'npm-official' || cliSource === 'npm-global') return 'official'
  return 'unknown'
}

function readVersionFromInstallation(cliPath) {
  const resolved = canonicalCliPath(cliPath)
  if (!resolved || !fs.existsSync(resolved)) return null
  const dir = path.dirname(resolved)
  const versionFile = path.join(dir, 'VERSION')
  try {
    if (fs.existsSync(versionFile)) {
      const lines = fs.readFileSync(versionFile, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        if (line.startsWith('openclaw_version=')) {
          const version = line.split('=').slice(1).join('=').trim()
          if (version) return version
        }
      }
    }
  } catch {}
  const cliSource = classifyCliSource(resolved)
  const pkgNames = (cliSource === 'standalone' || cliSource === 'npm-zh')
    ? [path.join('@qingchencloud', 'openclaw-zh'), 'openclaw']
    : ['openclaw', path.join('@qingchencloud', 'openclaw-zh')]
  const pkgRoots = [path.join(dir, 'node_modules')]
  const parentDir = path.dirname(dir)
  if (parentDir && parentDir !== dir) pkgRoots.push(path.join(parentDir, 'node_modules'))
  for (const root of pkgRoots) {
    for (const pkgName of pkgNames) {
      const pkgPath = path.join(root, pkgName, 'package.json')
      try {
        if (!fs.existsSync(pkgPath)) continue
        const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
        if (version) return version
      } catch {}
    }
  }
  return null
}

function readWhereWhichOpenclawCandidates() {
  try {
    const cmd = isWindows ? 'where openclaw' : 'which -a openclaw 2>/dev/null'
    const output = execSync(cmd, { timeout: 3000, windowsHide: true, encoding: 'utf8' }).trim()
    if (!output) return []
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function readWindowsNpmGlobalPrefix() {
  if (!isWindows) return null
  const envPrefix = String(process.env.NPM_CONFIG_PREFIX || '').trim()
  if (envPrefix && envPrefix.toLowerCase() !== 'undefined') return envPrefix
  try {
    const prefix = execSync('npm config get prefix', { timeout: 5000, windowsHide: true, encoding: 'utf8' }).trim()
    if (prefix && prefix.toLowerCase() !== 'undefined') return prefix
  } catch {}
  return null
}

function addCommonOpenclawCandidates(candidates, seen) {
  if (isWindows) {
    const appdata = process.env.APPDATA || ''
    const localappdata = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.ProgramFiles || ''
    const programFilesX86 = process.env['ProgramFiles(x86)'] || ''
    const userProfile = process.env.USERPROFILE || homedir()
    const standaloneDir = standaloneInstallDir()
    if (appdata) {
      addCliCandidate(candidates, seen, path.join(appdata, 'npm', 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(appdata, 'npm', 'openclaw'))
    }
    const customPrefix = readWindowsNpmGlobalPrefix()
    if (customPrefix) {
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.exe'))
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw'))
    }
    if (localappdata) {
      addCliCandidate(candidates, seen, path.join(localappdata, 'Programs', 'OpenClaw', 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(localappdata, 'OpenClaw', 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(localappdata, 'Programs', 'nodejs', 'openclaw.cmd'))
    }
    addCliCandidate(candidates, seen, path.join(standaloneDir, 'openclaw.cmd'))
    addCliCandidate(candidates, seen, path.join(standaloneDir, 'openclaw.exe'))
    addCliCandidate(candidates, seen, path.join(userProfile, '.openclaw-bin', 'openclaw.cmd'))
    if (programFiles) {
      addCliCandidate(candidates, seen, path.join(programFiles, 'nodejs', 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(programFiles, 'OpenClaw', 'openclaw.cmd'))
    }
    if (programFilesX86) {
      addCliCandidate(candidates, seen, path.join(programFilesX86, 'nodejs', 'openclaw.cmd'))
    }
    for (const drive of ['C', 'D', 'E', 'F', 'G']) {
      addCliCandidate(candidates, seen, `${drive}:\\OpenClaw\\openclaw.cmd`)
      addCliCandidate(candidates, seen, `${drive}:\\AI\\OpenClaw\\openclaw.cmd`)
    }
    return
  }

  const home = homedir()
  addCliCandidate(candidates, seen, path.join(home, '.openclaw-bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, '.npm-global', 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, '.local', 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, '.nvm', 'current', 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, '.volta', 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, '.fnm', 'current', 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, path.join(home, 'bin', 'openclaw'))
  addCliCandidate(candidates, seen, '/opt/openclaw/openclaw')
  addCliCandidate(candidates, seen, '/opt/homebrew/bin/openclaw')
  addCliCandidate(candidates, seen, '/usr/local/bin/openclaw')
  addCliCandidate(candidates, seen, '/usr/bin/openclaw')
  addCliCandidate(candidates, seen, '/snap/bin/openclaw')
}

function collectPreferredCliCandidates() {
  const candidates = []
  const seen = new Set()
  addConfiguredOpenclawCandidates(candidates, seen)
  for (const candidate of readWhereWhichOpenclawCandidates()) addCliCandidate(candidates, seen, candidate)
  const envPath = process.env.PATH || ''
  for (const dir of envPath.split(path.delimiter)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    if (isWindows) {
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw'))
    } else {
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw'))
    }
  }
  if (!isWindows) addCliCandidate(candidates, seen, findOpenclawBin())
  addCommonOpenclawCandidates(candidates, seen)
  return candidates
}

function collectAllCliCandidates() {
  const candidates = []
  const seen = new Set()
  addConfiguredOpenclawCandidates(candidates, seen)
  addCommonOpenclawCandidates(candidates, seen)
  for (const candidate of collectPreferredCliCandidates()) addCliCandidate(candidates, seen, candidate)
  return candidates
}

function readBoundOpenclawCliPath() {
  const normalized = normalizeCliPath(readPanelConfig()?.openclawCliPath || '')
  if (!normalized || !fs.existsSync(normalized) || isRejectedCliPath(normalized)) return null
  return normalized
}

function resolveOpenclawCliPath() {
  const bound = readBoundOpenclawCliPath()
  if (bound) return bound
  return collectPreferredCliCandidates()[0] || null
}

function scanAllOpenclawInstallations(activePath = resolveOpenclawCliPath()) {
  const activeIdentity = scanCliIdentity(activePath)
  return collectAllCliCandidates().map(candidate => ({
    path: candidate,
    source: classifyCliSource(candidate) || 'unknown',
    version: readVersionFromInstallation(candidate),
    active: !!activeIdentity && scanCliIdentity(candidate) === activeIdentity,
  })).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    const sourceCmp = String(a.source || '').localeCompare(String(b.source || ''))
    if (sourceCmp !== 0) return sourceCmp
    return String(a.path || '').localeCompare(String(b.path || ''))
  })
}

function resolveOpenclawCliInput(rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized) return null
  if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
    const candidates = isWindows
      ? [path.join(normalized, 'openclaw.cmd'), path.join(normalized, 'openclaw.exe'), path.join(normalized, 'openclaw')]
      : [path.join(normalized, 'openclaw')]
    for (const candidate of candidates) {
      const resolved = normalizeCliPath(candidate)
      if (resolved && fs.existsSync(resolved) && !isRejectedCliPath(resolved)) return resolved
    }
    return null
  }
  if (!fs.existsSync(normalized) || isRejectedCliPath(normalized)) return null
  return normalized
}

function openclawProcessSpec(args = []) {
  const cliPath = resolveOpenclawCliPath()
  if (!cliPath) throw new Error('openclaw CLI 未安装')
  if (isWindows) {
    const cliArg = /[\s&()]/.test(cliPath) ? `"${cliPath}"` : cliPath
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', cliArg, ...args],
    }
  }
  return { command: cliPath, args }
}

function spawnOpenclaw(args, options = {}) {
  const spec = openclawProcessSpec(args)
  const { env, ...rest } = options
  return spawn(spec.command, spec.args, {
    ...rest,
    env: { ...process.env, ...(env || {}) },
  })
}

function spawnOpenclawSync(args, options = {}) {
  const spec = openclawProcessSpec(args)
  const { env, ...rest } = options
  return spawnSync(spec.command, spec.args, {
    ...rest,
    env: { ...process.env, ...(env || {}) },
  })
}

function openclawResultOutput(result) {
  return [result?.stdout, result?.stderr].map(value => value == null ? '' : String(value)).join('').trim()
}

function ensureSuccessfulOpenclaw(result, action) {
  if (result?.error) throw new Error(`${action}: ${result.error.message || result.error}`)
  if (typeof result?.status === 'number' && result.status !== 0) {
    throw new Error(`${action}: ${openclawResultOutput(result) || `exit code ${result.status}`}`)
  }
  return result
}

function execOpenclawSync(args, options = {}, action = `执行 openclaw ${args.join(' ')} 失败`) {
  const result = spawnOpenclawSync(args, { encoding: 'utf8', ...options })
  return openclawResultOutput(ensureSuccessfulOpenclaw(result, action))
}

const GIT_HTTPS_REWRITES = [
  'ssh://git@github.com/',
  'ssh://git@github.com',
  'ssh://git@://github.com/',
  'git@github.com:',
  'git://github.com/',
  'git+ssh://git@github.com/'
]

// === 异步任务存储 ===
const _taskStore = new Map()   // taskId → task object
const MAX_TASK_HISTORY = 50
const _agentScriptSyncCache = new Map() // `${endpoint}:${containerId}` → 脚本 hash

function createTask(containerId, containerName, nodeId, message) {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const task = {
    id,
    containerId,
    containerName: containerName || containerId.slice(0, 12),
    nodeId: nodeId || null,
    message,
    status: 'running',   // running | completed | error
    result: null,
    error: null,
    events: [],
    startedAt: Date.now(),
    completedAt: null,
  }
  _taskStore.set(id, task)
  // 清理旧任务
  if (_taskStore.size > MAX_TASK_HISTORY) {
    const oldest = [..._taskStore.keys()].slice(0, _taskStore.size - MAX_TASK_HISTORY)
    oldest.forEach(k => _taskStore.delete(k))
  }
  return task
}

// 语义化版本比较
function parseVersion(value) {
  return String(value || '').split(/[^0-9]/).filter(Boolean).map(Number)
}
function versionCompare(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}
function versionGe(a, b) {
  return versionCompare(a, b) >= 0
}
function versionGt(a, b) {
  return versionCompare(a, b) > 0
}

// 提取基础版本号（去掉 -zh.x / -nightly.xxx 等后缀）
function baseVersion(v) {
  return String(v || '').split('-')[0]
}

// 判断 CLI 版本是否与推荐版匹配（考虑汉化版 -zh.x 后缀差异）
function versionsMatch(cliVer, recommended) {
  if (cliVer === recommended) return true
  return baseVersion(cliVer) === baseVersion(recommended)
}

// 判断推荐版是否真的比当前版本更新（忽略 -zh.x 后缀）
function recommendedIsNewer(recommended, current) {
  return versionGt(baseVersion(recommended), baseVersion(current))
}

function loadVersionPolicy() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_POLICY_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function r2Config() {
  const policy = loadVersionPolicy()
  return policy?.r2 || { enabled: false }
}

function standaloneConfig() {
  const policy = loadVersionPolicy()
  return policy?.standalone || { enabled: false }
}

function findPanelPolicyEntry(policy, currentVersion) {
  const exact = policy?.panels?.[currentVersion]
  if (exact) return exact

  const currentParts = parseVersion(currentVersion)
  if (currentParts.length < 2) return null

  let matched = null
  let matchedParts = null
  for (const [version, entry] of Object.entries(policy?.panels || {})) {
    const parts = parseVersion(version)
    if (parts.length < 2) continue
    if (parts[0] !== currentParts[0] || parts[1] !== currentParts[1]) continue
    if (versionCompare(version, currentVersion) > 0) continue
    if (!matchedParts || compareParsedVersion(parts, matchedParts) > 0) {
      matched = entry
      matchedParts = parts
    }
  }
  return matched
}

function compareParsedVersion(a = [], b = []) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = Number(a[i] || 0)
    const bv = Number(b[i] || 0)
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}

function standalonePlatformKey() {
  const arch = process.arch
  const plat = process.platform
  if (plat === 'win32' && arch === 'x64') return 'win-x64'
  if (plat === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (plat === 'darwin' && arch === 'x64') return 'mac-x64'
  if (plat === 'linux' && arch === 'x64') return 'linux-x64'
  if (plat === 'linux' && arch === 'arm64') return 'linux-arm64'
  return 'unknown'
}

function standaloneInstallDir() {
  if (isWindows) return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenClaw')
  return path.join(os.homedir(), '.openclaw-bin')
}

async function _tryStandaloneInstall(version, logs, overrideBaseUrl = null) {
  const cfg = standaloneConfig()
  if (!cfg.enabled || !cfg.baseUrl) return false
  const platform = standalonePlatformKey()
  if (platform === 'unknown') throw new Error('当前平台不支持 standalone 安装包')
  const installDir = standaloneInstallDir()

  logs.push('📦 尝试 standalone 独立安装包（汉化版专属，自带 Node.js 运行时，无需 npm）')
  logs.push('查询最新版本...')
  const manifestUrl = `${cfg.baseUrl}/latest.json`
  const resp = await globalThis.fetch(manifestUrl, { signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new Error(`standalone 清单不可用 (HTTP ${resp.status})`)
  const manifest = await resp.json()

  const remoteVersion = manifest.version
  if (!remoteVersion) throw new Error('standalone 清单缺少 version 字段')
  if (version !== 'latest' && !versionsMatch(remoteVersion, version)) {
    throw new Error(`standalone 版本 ${remoteVersion} 与请求版本 ${version} 不匹配`)
  }

  const remoteBase = overrideBaseUrl || manifest.base_url || `${cfg.baseUrl}/${remoteVersion}`
  const ext = isWindows ? 'zip' : 'tar.gz'
  const filename = `openclaw-${remoteVersion}-${platform}.${ext}`
  const downloadUrl = `${remoteBase}/${filename}`

  logs.push(`从 CDN 下载: ${filename}`)

  const tmpPath = path.join(os.tmpdir(), filename)
  const dlResp = await globalThis.fetch(downloadUrl, { signal: AbortSignal.timeout(600000) })
  if (!dlResp.ok) throw new Error(`standalone 下载失败 (HTTP ${dlResp.status})`)
  const buffer = Buffer.from(await dlResp.arrayBuffer())
  const sizeMb = (buffer.length / 1048576).toFixed(0)
  logs.push(`下载完成 (${sizeMb}MB)，解压安装中...`)
  fs.writeFileSync(tmpPath, buffer)

  // 清理旧安装 & 解压
  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true })
  }
  fs.mkdirSync(installDir, { recursive: true })

  if (isWindows) {
    // Windows: 用 PowerShell 解压 zip
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpPath}' -DestinationPath '${installDir}' -Force"`, { windowsHide: true })
    // 处理嵌套 openclaw/ 目录
    const nested = path.join(installDir, 'openclaw')
    if (fs.existsSync(nested) && fs.existsSync(path.join(nested, 'node.exe'))) {
      for (const entry of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, entry), path.join(installDir, entry))
      }
      fs.rmSync(nested, { recursive: true, force: true })
    }
  } else {
    // Unix: tar 解压
    execSync(`tar -xzf "${tmpPath}" -C "${installDir}" --strip-components=1`, { windowsHide: true })
  }

  try { fs.unlinkSync(tmpPath) } catch {}

  // 验证
  const binFile = isWindows ? 'openclaw.cmd' : 'openclaw'
  if (!fs.existsSync(path.join(installDir, binFile))) {
    throw new Error('standalone 解压后未找到 openclaw 可执行文件')
  }

  logs.push(`✅ standalone 安装完成 (${remoteVersion})`)
  logs.push(`安装目录: ${installDir}`)
  return true
}

function r2PlatformKey() {
  const arch = process.arch // x64, arm64, etc.
  const plat = process.platform // linux, darwin, win32
  if (plat === 'win32' && arch === 'x64') return 'win-x64'
  if (plat === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (plat === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (plat === 'linux' && arch === 'x64') return 'linux-x64'
  if (plat === 'linux' && arch === 'arm64') return 'linux-arm64'
  return 'unknown'
}

async function _tryR2Install(version, source, logs) {
  const r2 = r2Config()
  if (!r2.enabled || !r2.baseUrl) return false
  const platform = r2PlatformKey()

  logs.push('尝试从 CDN 加速下载...')
  const manifestUrl = `${r2.baseUrl}/latest.json`
  const resp = await globalThis.fetch(manifestUrl, { signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new Error(`CDN 清单不可用 (HTTP ${resp.status})`)
  const manifest = await resp.json()

  const sourceKey = source === 'official' ? 'official' : 'chinese'
  const sourceObj = manifest?.[sourceKey]
  if (!sourceObj) throw new Error(`CDN 无 ${sourceKey} 配置`)

  const cdnVersion = sourceObj.version || version
  if (version !== 'latest' && !versionsMatch(cdnVersion, version)) {
    throw new Error(`CDN 版本 ${cdnVersion} 与请求版本 ${version} 不匹配`)
  }

  // 优先平台特定预装归档（直接解压，零网络依赖），其次通用 tarball（需要 npm install）
  const asset = (platform !== 'unknown') ? sourceObj.assets?.[platform] : null
  const tarball = sourceObj.tarball
  const useAsset = !!asset?.url
  const useTarball = !useAsset && !!tarball?.url

  if (!useAsset && !useTarball) {
    throw new Error(`CDN 无 ${sourceKey} 可用归档（平台: ${platform}）`)
  }

  const archiveUrl = useAsset ? asset.url : tarball.url
  const expectedSha = useAsset ? (asset.sha256 || '') : (tarball.sha256 || '')
  const expectedSize = useAsset ? (asset.size || 0) : (tarball.size || 0)
  const sizeMb = expectedSize ? `${(expectedSize / 1048576).toFixed(0)}MB` : '未知大小'
  const mode = useAsset ? `${platform} 预装归档` : '通用 tarball'
  logs.push(`CDN 下载: ${cdnVersion} (${mode}, ${sizeMb})`)

  // 下载到临时文件
  const tmpPath = path.join(os.tmpdir(), `openclaw-cdn.tgz`)
  const dlResp = await globalThis.fetch(archiveUrl, { signal: AbortSignal.timeout(300000) })
  if (!dlResp.ok) throw new Error(`CDN 下载失败 (HTTP ${dlResp.status})`)
  const buffer = Buffer.from(await dlResp.arrayBuffer())
  fs.writeFileSync(tmpPath, buffer)

  // SHA256 校验
  if (expectedSha) {
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    if (hash !== expectedSha) {
      fs.unlinkSync(tmpPath)
      throw new Error(`SHA256 校验失败: 期望 ${expectedSha}, 实际 ${hash}`)
    }
    logs.push('SHA256 校验通过 ✓')
  }

  if (useTarball) {
    // 通用 tarball 模式：npm install -g ./file.tgz（全平台通用，npm 自动处理原生模块）
    logs.push('通用 tarball 模式，执行 npm install...')
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    try {
      execSync(`${npmBin} install -g "${tmpPath}" --force 2>&1`, { timeout: 120000, windowsHide: true })
      logs.push('npm install 完成 ✓')
    } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch {}
      throw new Error('npm install -g tarball 失败: ' + (e.stderr?.toString() || e.message).slice(-300))
    }
  } else {
    // 平台特定归档模式：直接解压到 npm 全局 node_modules
    let modulesDir
    if (isWindows) {
      const prefix = readWindowsNpmGlobalPrefix() || path.join(process.env.APPDATA || '', 'npm')
      modulesDir = path.join(prefix, 'node_modules')
    } else if (isMac) {
      modulesDir = fs.existsSync('/opt/homebrew/lib/node_modules')
        ? '/opt/homebrew/lib/node_modules'
        : '/usr/local/lib/node_modules'
    } else {
      try {
        const prefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim()
        modulesDir = path.join(prefix, 'lib', 'node_modules')
      } catch {
        modulesDir = '/usr/local/lib/node_modules'
      }
    }
    if (!fs.existsSync(modulesDir)) fs.mkdirSync(modulesDir, { recursive: true })

    const qcDir = path.join(modulesDir, '@qingchencloud')
    if (fs.existsSync(qcDir)) fs.rmSync(qcDir, { recursive: true, force: true })

    logs.push(`解压到 ${modulesDir}`)
    execSync(`tar -xzf "${tmpPath}" -C "${modulesDir}"`, { timeout: 60000, windowsHide: true })

    // 归档内目录可能是 qingchencloud/（Windows tar 不支持 @ 前缀），需要重命名
    const noAtDir = path.join(modulesDir, 'qingchencloud')
    if (fs.existsSync(noAtDir) && !fs.existsSync(qcDir)) {
      fs.renameSync(noAtDir, qcDir)
      logs.push('目录已修正: qingchencloud → @qingchencloud')
    }

    // 创建 bin 链接
    let binDir
    if (isWindows) {
      binDir = readWindowsNpmGlobalPrefix() || path.join(process.env.APPDATA || '', 'npm')
    } else if (isMac) {
      binDir = fs.existsSync('/opt/homebrew/bin') ? '/opt/homebrew/bin' : '/usr/local/bin'
    } else {
      try {
        const prefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim()
        binDir = path.join(prefix, 'bin')
      } catch {
        binDir = '/usr/local/bin'
      }
    }
    const openclawJs = path.join(modulesDir, '@qingchencloud', 'openclaw-zh', 'bin', 'openclaw.js')
    if (fs.existsSync(openclawJs)) {
      if (isWindows) {
        const cmdContent = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${openclawJs}" %*\r\n`
        fs.writeFileSync(path.join(binDir, 'openclaw.cmd'), cmdContent)
      } else {
        const linkPath = path.join(binDir, 'openclaw')
        try { fs.unlinkSync(linkPath) } catch {}
        fs.symlinkSync(openclawJs, linkPath)
        try { fs.chmodSync(openclawJs, 0o755) } catch {}
        try { fs.chmodSync(linkPath, 0o755) } catch {}
      }
      logs.push('bin 链接已创建 ✓')
    }
  }

  // 清理临时文件
  try { fs.unlinkSync(tmpPath) } catch {}

  logs.push(`✅ CDN 加速安装完成，当前版本: ${cdnVersion}`)
  return true
}

function recommendedVersionFor(source = 'chinese') {
  const policy = loadVersionPolicy()
  const panelEntry = findPanelPolicyEntry(policy, PANEL_VERSION)
  return panelEntry?.[source]?.recommended
    || policy?.default?.[source]?.recommended
    || null
}

function npmPackageName(source = 'chinese') {
  return source === 'official' ? 'openclaw' : '@qingchencloud/openclaw-zh'
}

function getConfiguredNpmRegistry() {
  const regFile = path.join(OPENCLAW_DIR, 'npm-registry.txt')
  try {
    if (fs.existsSync(regFile)) {
      const value = fs.readFileSync(regFile, 'utf8').trim()
      if (value) return value
    }
  } catch {}
  return 'https://registry.npmmirror.com'
}

function pickRegistryForPackage(pkg) {
  const configured = getConfiguredNpmRegistry()
  if (pkg.includes('openclaw-zh')) {
    // 汉化版优先用配置的源（通常是 npmmirror.com），不再默认 fallback 到海外 npmjs.org
    // Docker 容器内网络受限时，海外源会 ETIMEDOUT
    return configured
  }
  return configured
}

function configureGitHttpsRules() {
  try { runGitSync(['config', '--global', '--unset-all', 'url.https://github.com/.insteadOf'], { timeout: 5000 }) } catch {}
  let success = 0
  for (const from of GIT_HTTPS_REWRITES) {
    try {
      const { result } = runGitSync(['config', '--global', '--add', 'url.https://github.com/.insteadOf', from], { timeout: 5000 })
      if (!result?.error && result?.status === 0) success++
    } catch {}
  }
  return success
}

function buildGitInstallEnv() {
  const env = buildGitCommandEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes',
    GIT_ALLOW_PROTOCOL: 'https:http:file',
    GIT_CONFIG_COUNT: String(GIT_HTTPS_REWRITES.length),
  })
  GIT_HTTPS_REWRITES.forEach((from, idx) => {
    env[`GIT_CONFIG_KEY_${idx}`] = 'url.https://github.com/.insteadOf'
    env[`GIT_CONFIG_VALUE_${idx}`] = from
  })
  return env
}

function parseSkillFrontmatterFile(skillMdPath) {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8').replace(/\r\n/g, '\n')
    if (!raw.startsWith('---\n')) return {}
    const end = raw.indexOf('\n---\n', 4)
    if (end < 0) return {}
    const frontmatter = raw.slice(4, end)
    const result = {}
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
      if (!match) continue
      result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
    }
    return result
  } catch {
    return {}
  }
}

function collectLocalSkillRoots() {
  const roots = []
  const seen = new Set()
  const pushRoot = (dir, source, bundled = false) => {
    if (!dir) return
    const normalized = path.resolve(dir)
    const key = isWindows ? normalized.toLowerCase() : normalized
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ dir: normalized, source, bundled })
  }

  pushRoot(path.join(OPENCLAW_DIR, 'skills'), 'OpenClaw 自定义', false)
  pushRoot(path.join(homedir(), '.claude', 'skills'), 'Claude 自定义', false)

  const cliPath = resolveOpenclawCliPath()
  if (cliPath) {
    const resolvedCli = canonicalCliPath(cliPath) || cliPath
    const cliDir = path.dirname(resolvedCli)
    const pkgRoots = [cliDir, path.dirname(cliDir)]
    for (const pkgRoot of pkgRoots) {
      const bundledDir = path.join(pkgRoot, 'skills')
      if (fs.existsSync(bundledDir) && fs.statSync(bundledDir).isDirectory()) {
        pushRoot(bundledDir, 'openclaw-bundled', true)
        break
      }
    }
  }

  if (isWindows) {
    const prefix = readWindowsNpmGlobalPrefix() || path.join(process.env.APPDATA || '', 'npm')
    for (const pkg of ['openclaw', path.join('@qingchencloud', 'openclaw-zh')]) {
      const bundledDir = path.join(prefix, 'node_modules', pkg, 'skills')
      if (fs.existsSync(bundledDir) && fs.statSync(bundledDir).isDirectory()) {
        pushRoot(bundledDir, 'openclaw-bundled', true)
      }
    }
  }

  return roots
}

function scanSingleSkill(root, name) {
  const skillPath = path.join(root.dir, name)
  const skillMd = path.join(skillPath, 'SKILL.md')
  const packageJson = path.join(skillPath, 'package.json')
  if (!fs.existsSync(skillMd) && !fs.existsSync(packageJson)) return null

  const result = {
    name,
    source: root.source,
    bundled: !!root.bundled,
    filePath: skillPath,
    description: '',
    eligible: true,
    disabled: false,
    blockedByAllowlist: false,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    install: [],
  }

  try {
    if (fs.existsSync(packageJson)) {
      const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'))
      if (pkg.description) result.description = pkg.description
      if (pkg.homepage) result.homepage = pkg.homepage
      if (pkg.version) result.version = pkg.version
      if (pkg.author) result.author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || '')
    }
  } catch {}

  const frontmatter = parseSkillFrontmatterFile(skillMd)
  if (frontmatter.description) result.description = frontmatter.description
  if (frontmatter.fullPath) result.fullPath = frontmatter.fullPath
  if (frontmatter.emoji) result.emoji = frontmatter.emoji

  return result
}

function scanLocalSkillsFallback(cliError = null) {
  const roots = collectLocalSkillRoots()
  const skills = []
  const seen = new Set()
  const scannedRoots = []

  for (const root of roots) {
    if (!fs.existsSync(root.dir) || !fs.statSync(root.dir).isDirectory()) continue
    scannedRoots.push(root.dir)
    for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const key = isWindows ? entry.name.toLowerCase() : entry.name
      if (seen.has(key)) continue
      const skill = scanSingleSkill(root, entry.name)
      if (!skill) continue
      seen.add(key)
      skills.push(skill)
    }
  }

  skills.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  const eligible = skills.filter(s => s.eligible && !s.disabled)
  const missingRequirements = skills.filter(s => !s.eligible && !s.disabled && !s.blockedByAllowlist)
  const disabled = skills.filter(s => s.disabled)
  const blocked = skills.filter(s => s.blockedByAllowlist && !s.disabled)

  return {
    skills,
    source: 'local-scan',
    cliAvailable: false,
    summary: {
      total: skills.length,
      eligible: eligible.length,
      disabled: disabled.length,
      blocked: blocked.length,
      missingRequirements: missingRequirements.length,
    },
    eligible,
    disabled,
    blocked,
    missingRequirements,
    diagnostic: {
      status: 'scanned',
      scannedAt: new Date().toISOString(),
      scannedRoots,
      cli: cliError ? { status: 'exec-failed', message: String(cliError?.message || cliError) } : null,
    },
  }
}

function detectInstalledSource() {
  const activeCliPath = resolveOpenclawCliPath()
  const activeCliSource = classifyCliSource(activeCliPath)
  const activeSource = normalizeCliInstallSource(activeCliSource)
  if (activeSource !== 'unknown') return activeSource
  if (isMac) {
    // ARM Homebrew
    try {
      const target = fs.readlinkSync('/opt/homebrew/bin/openclaw')
      if (String(target).includes('openclaw-zh')) return 'chinese'
      return 'official'
    } catch {}
    // Intel Homebrew
    try {
      const target = fs.readlinkSync('/usr/local/bin/openclaw')
      if (String(target).includes('openclaw-zh')) return 'chinese'
      return 'official'
    } catch {}
    // standalone
    const saDir = standaloneInstallDir()
    if (fs.existsSync(path.join(saDir, 'openclaw')) || fs.existsSync(path.join(saDir, 'VERSION'))) return 'chinese'
    if (fs.existsSync('/opt/openclaw/openclaw')) return 'chinese'
    // findOpenclawBin fallback
    const bin = findOpenclawBin()
    if (bin) {
      const lower = bin.replace(/\\/g, '/').toLowerCase()
      if (lower.includes('openclaw-zh') || lower.includes('@qingchencloud') || lower.includes('/openclaw-bin/') || lower.includes('/opt/openclaw/')) return 'chinese'
      return 'official'
    }
    return 'official'
  }
  if (isWindows) {
    try {
      const npmPrefix = readWindowsNpmGlobalPrefix()
      if (npmPrefix) {
        const shimSource = detectWindowsShimSource(path.join(npmPrefix, 'openclaw.cmd'))
        if (shimSource) return normalizeCliInstallSource(shimSource)
        const zhDir = path.join(npmPrefix, 'node_modules', '@qingchencloud', 'openclaw-zh')
        if (fs.existsSync(zhDir)) return 'chinese'
      }
    } catch {}
    return 'official'
  }
  try {
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    const out = execSync(`${npmBin} list -g @qingchencloud/openclaw-zh --depth=0 2>&1`, { timeout: 10000, windowsHide: true }).toString()
    if (out.includes('openclaw-zh@')) return 'chinese'
  } catch {}
  return 'official'
}

function getLocalOpenclawVersion() {
  let current = readVersionFromInstallation(resolveOpenclawCliPath())
  if (isMac) {
    // ARM Homebrew
    try {
      const target = fs.readlinkSync('/opt/homebrew/bin/openclaw')
      const pkgPath = path.resolve('/opt/homebrew/bin', target, '..', 'package.json')
      current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
    } catch {}
    // Intel Homebrew
    if (!current) {
      try {
        const target = fs.readlinkSync('/usr/local/bin/openclaw')
        const pkgPath = path.resolve('/usr/local/bin', target, '..', 'package.json')
        current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
      } catch {}
    }
    // standalone
    if (!current) {
      try {
        const saDir = standaloneInstallDir()
        const vf = path.join(saDir, 'VERSION')
        if (fs.existsSync(vf)) {
          const lines = fs.readFileSync(vf, 'utf8').split('\n')
          for (const l of lines) { if (l.startsWith('openclaw_version=')) { current = l.split('=')[1]?.trim(); break } }
        }
        if (!current) {
          const pkg = path.join(saDir, 'node_modules', '@qingchencloud', 'openclaw-zh', 'package.json')
          if (fs.existsSync(pkg)) current = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
        }
      } catch {}
    }
  }
  if (!current && isWindows) {
    try {
      const npmPrefix = readWindowsNpmGlobalPrefix()
      if (npmPrefix) {
        for (const pkg of [path.join('@qingchencloud', 'openclaw-zh'), 'openclaw']) {
          const pkgPath = path.join(npmPrefix, 'node_modules', pkg, 'package.json')
          if (fs.existsSync(pkgPath)) {
            current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
            if (current) break
          }
        }
      }
    } catch {}
  }
  if (!current) {
    try {
      const result = spawnOpenclawSync(['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8', cwd: homedir() })
      const output = openclawResultOutput(result)
      current = output.trim().split(/\s+/).find(w => /^\d/.test(w)) || null
    } catch {}
  }
  return current || null
}

async function getLatestVersionFor(source = 'chinese') {
  const pkg = npmPackageName(source)
  const encodedPkg = pkg.replace('/', '%2F').replace('@', '%40')
  const firstRegistry = pickRegistryForPackage(pkg)
  const registries = [...new Set([firstRegistry, 'https://registry.npmjs.org'])]
  for (const registry of registries) {
    try {
      const resp = await fetch(`${registry}/${encodedPkg}/latest`, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!resp.ok) continue
      const data = await resp.json()
      if (data?.version) return data.version
    } catch {}
  }
  return null
}

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

// 从 CLI 输出中提取 JSON（跳过 Node 警告、npm 更新提示等非 JSON 行）
function extractCliJson(text) {
  // 快速路径：整个文本就是合法 JSON
  try { return JSON.parse(text) } catch {}
  // 找到第一个 { 或 [ 开始尝试解析
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      // 找到匹配的闭合位置
      let depth = 0, end = -1
      const close = ch === '{' ? '}' : ']'
      let inStr = false, esc = false
      for (let j = i; j < text.length; j++) {
        const c = text[j]
        if (esc) { esc = false; continue }
        if (c === '\\' && inStr) { esc = true; continue }
        if (c === '"' && !esc) { inStr = !inStr; continue }
        if (inStr) continue
        if (c === ch) depth++
        else if (c === close) { depth--; if (depth === 0) { end = j; break } }
      }
      if (end > i) {
        try { return JSON.parse(text.slice(i, end + 1)) } catch {}
      }
    }
  }
  throw new Error('解析失败: 输出中未找到有效 JSON')
}

// 配置缓存：避免每次请求同步读磁盘（TTL 2秒，写入时立即失效）
let _panelConfigCache = null
let _panelConfigCacheTime = 0
const CONFIG_CACHE_TTL = 2000 // 2s

function readPanelConfig() {
  const now = Date.now()
  if (_panelConfigCache && (now - _panelConfigCacheTime) < CONFIG_CACHE_TTL) {
    applyOpenclawPathConfig(_panelConfigCache)
    return JSON.parse(JSON.stringify(_panelConfigCache))
  }
  try {
    if (fs.existsSync(PANEL_CONFIG_PATH)) {
      _panelConfigCache = JSON.parse(fs.readFileSync(PANEL_CONFIG_PATH, 'utf8'))
      _panelConfigCacheTime = now
      applyOpenclawPathConfig(_panelConfigCache)
      return JSON.parse(JSON.stringify(_panelConfigCache))
    }
  } catch {}
  applyOpenclawPathConfig({})
  return {}
}

function normalizeDockerEndpoint(raw) {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (!value) return null
  if (/^http:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return `tcp://${parsed.host}`
    } catch {
      return null
    }
  }
  if (/^tcp:\/\//i.test(value)) return value
  if (/^unix:\/\//i.test(value)) value = value.replace(/^unix:\/\//i, '')
  if (/^npipe:\/\//i.test(value)) value = value.replace(/^npipe:/i, '').replace(/^\/{2,}/, '//')
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  if (isWindows && /^\\\\\.\\pipe\\/.test(value)) {
    return value.replace(/^\\\\\.\\pipe\\/, '//./pipe/').replace(/\\/g, '/')
  }
  return value
}

function readDockerRuntimeConfig() {
  const panelConfig = readPanelConfig()
  const endpoint = normalizeDockerEndpoint(
    typeof panelConfig?.dockerEndpoint === 'string' && panelConfig.dockerEndpoint.trim()
      ? panelConfig.dockerEndpoint
      : (process.env.DOCKER_HOST || DEFAULT_DOCKER_SOCKET)
  ) || DEFAULT_DOCKER_SOCKET
  const configuredImage = typeof panelConfig?.dockerDefaultImage === 'string'
    ? panelConfig.dockerDefaultImage.trim()
    : ''
  const envImage = (process.env.OPENCLAW_DOCKER_IMAGE || '').trim()
  return {
    endpoint,
    image: configuredImage || envImage || DEFAULT_OPENCLAW_IMAGE,
  }
}

function defaultDockerEndpoint() {
  return readDockerRuntimeConfig().endpoint
}

function defaultDockerImage() {
  return readDockerRuntimeConfig().image
}

function defaultLocalDockerNode() {
  const endpoint = defaultDockerEndpoint()
  return {
    id: 'local',
    name: '本机',
    type: endpoint.startsWith('tcp://') ? 'tcp' : 'socket',
    endpoint,
  }
}

function invalidateConfigCache() {
  _panelConfigCache = null
  _panelConfigCacheTime = 0
}

applyOpenclawPathConfig(readPanelConfig())

function getAccessPassword() {
  return readPanelConfig().accessPassword || ''
}

function parseCookies(req) {
  const obj = {}
  ;(req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=')
    if (k) try { obj[k] = decodeURIComponent(v.join('=')) } catch (_) { obj[k] = v.join('=') }
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
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  // 清理根层级 ClawPanel 内部字段（version info 等），避免污染 openclaw.json
  // Issue #89: 这些字段被写入 openclaw.json 后导致 Gateway 无法启动（Unknown config keys）
  const uiRootKeys = [
    'current', 'latest', 'recommended', 'update_available',
    'latest_update_available', 'is_recommended', 'ahead_of_recommended',
    'panel_version', 'source', 'qqbot', 'profiles',
  ]
  for (const key of uiRootKeys) {
    delete config[key]
  }
  if (config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)) {
    delete config.auth.profiles
  }
  if (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
    delete config.agents.profiles
    if (Array.isArray(config.agents.list)) {
      for (const agent of config.agents.list) {
        if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue
        delete agent.current
        delete agent.latest
        delete agent.update_available
      }
    }
  }
  // 清理模型测试相关的临时字段
  const providers = config?.models?.providers
  if (providers) {
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
  }
  return config
}

function cleanLoadedConfig(config) {
  const before = JSON.stringify(config)
  const cleaned = stripUiFields(config)
  if (fs.existsSync(CONFIG_PATH) && JSON.stringify(cleaned) !== before) {
    writeOpenclawConfigFile(cleaned)
  }
  return cleaned
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

const CALIBRATION_RESET_INHERIT_KEYS = [
  'agents',
  'auth',
  'bindings',
  'browser',
  'channels',
  'commands',
  'env',
  'hooks',
  'models',
  'plugins',
  'session',
  'skills',
  'wizard',
]

function requiredControlUiOrigins() {
  const origins = [
    'tauri://localhost',
    'https://tauri.localhost',
    'http://tauri.localhost',
    'http://localhost',
    'http://localhost:1420',
    'http://127.0.0.1:1420',
    'http://localhost:18777',
    'http://127.0.0.1:18777',
  ]
  for (const ip of getLocalIps()) {
    origins.push(`http://${ip}:1420`)
    origins.push(`http://${ip}:18777`)
  }
  return [...new Set(origins)]
}

function calibrationLastTouchedVersion() {
  return recommendedVersionFor('chinese') || '2026.1.1'
}

function calibrationDefaultWorkspace() {
  return path.join(OPENCLAW_DIR, 'workspace')
}

function generateCalibrationToken() {
  return `cp-${crypto.randomBytes(16).toString('hex')}`
}

function decodeJsonFileContent(filePath) {
  const raw = fs.readFileSync(filePath)
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    return raw.subarray(3).toString('utf8')
  }
  return raw.toString('utf8')
}

function readJsonFileRelaxed(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(decodeJsonFileContent(filePath))
  } catch {
    return null
  }
}

function calibrationHasUsableGatewayAuth(auth) {
  const mode = auth?.mode
  if (mode === 'token') return !!String(auth?.token || '').trim()
  if (mode === 'password') return !!String(auth?.password || '').trim()
  return false
}

function calibrationRichnessScore(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 0
  let score = 0
  if (config.models?.providers && Object.keys(config.models.providers).length) score += 4
  if (config.agents?.defaults) score += 2
  if (Array.isArray(config.agents?.list) && config.agents.list.length) score += 3
  if (config.channels && Object.keys(config.channels).length) score += 2
  if (Array.isArray(config.bindings) && config.bindings.length) score += 2
  if (config.plugins?.entries && Object.keys(config.plugins.entries).length) score += 2
  if (config.plugins?.installs && Object.keys(config.plugins.installs).length) score += 2
  if (config.env && Object.keys(config.env).length) score += 1
  if (calibrationHasUsableGatewayAuth(config.gateway?.auth)) score += 3
  if (Array.isArray(config.gateway?.controlUi?.allowedOrigins) && config.gateway.controlUi.allowedOrigins.length) score += 1
  return score
}

function selectCalibrationSource(current, backup) {
  if (current && backup) {
    return calibrationRichnessScore(backup) > calibrationRichnessScore(current)
      ? ['backup', backup]
      : ['current', current]
  }
  if (current) return ['current', current]
  if (backup) return ['backup', backup]
  return ['empty', {}]
}

function buildCalibrationBaseline() {
  return {
    $schema: 'https://openclaw.ai/schema/config.json',
    meta: { lastTouchedVersion: calibrationLastTouchedVersion() },
    models: { providers: {} },
    agents: {
      defaults: { workspace: calibrationDefaultWorkspace() },
      list: [],
    },
    bindings: [],
    channels: {},
    commands: {
      native: 'auto',
      nativeSkills: 'auto',
      ownerDisplay: 'raw',
      restart: true,
    },
    plugins: {},
    session: { dmScope: 'per-channel-peer' },
    skills: { entries: {} },
    tools: {
      profile: 'full',
      sessions: { visibility: 'all' },
    },
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port: 18789,
      auth: {
        mode: 'token',
        token: generateCalibrationToken(),
      },
      controlUi: {
        enabled: true,
        allowedOrigins: requiredControlUiOrigins(),
        allowInsecureAuth: true,
      },
    },
  }
}

function applyResetInheritance(baseConfig, seed) {
  const config = { ...baseConfig }
  const inheritedKeys = []
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return [config, inheritedKeys]
  for (const key of CALIBRATION_RESET_INHERIT_KEYS) {
    if (key in seed) {
      config[key] = seed[key]
      inheritedKeys.push(key)
    }
  }
  if (seed.tools?.web) {
    config.tools = config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools) ? config.tools : {}
    config.tools.web = seed.tools.web
    inheritedKeys.push('tools.web')
  }
  return [config, inheritedKeys]
}

function normalizeCalibratedConfig(input) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? input : buildCalibrationBaseline()
  const origins = requiredControlUiOrigins()
  config.$schema = 'https://openclaw.ai/schema/config.json'
  config.meta = config.meta && typeof config.meta === 'object' && !Array.isArray(config.meta) ? config.meta : {}
  config.meta.lastTouchedVersion = calibrationLastTouchedVersion()
  config.meta.lastTouchedAt = new Date().toISOString()

  config.models = config.models && typeof config.models === 'object' && !Array.isArray(config.models) ? config.models : {}
  config.models.providers = config.models.providers && typeof config.models.providers === 'object' && !Array.isArray(config.models.providers) ? config.models.providers : {}

  config.agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents) ? config.agents : {}
  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' && !Array.isArray(config.agents.defaults) ? config.agents.defaults : {}
  if (!String(config.agents.defaults.workspace || '').trim()) config.agents.defaults.workspace = calibrationDefaultWorkspace()
  if (!Array.isArray(config.agents.list)) config.agents.list = []

  if (!Array.isArray(config.bindings)) config.bindings = []
  config.channels = config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels) ? config.channels : {}
  config.commands = config.commands && typeof config.commands === 'object' && !Array.isArray(config.commands) ? config.commands : {}
  if (!String(config.commands.native || '').trim()) config.commands.native = 'auto'
  if (!String(config.commands.nativeSkills || '').trim()) config.commands.nativeSkills = 'auto'
  if (!String(config.commands.ownerDisplay || '').trim()) config.commands.ownerDisplay = 'raw'
  if (typeof config.commands.restart !== 'boolean') config.commands.restart = true
  config.plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins) ? config.plugins : {}
  config.session = config.session && typeof config.session === 'object' && !Array.isArray(config.session) ? config.session : {}
  if (!String(config.session.dmScope || '').trim()) config.session.dmScope = 'per-channel-peer'
  config.skills = config.skills && typeof config.skills === 'object' && !Array.isArray(config.skills) ? config.skills : {}
  config.skills.entries = config.skills.entries && typeof config.skills.entries === 'object' && !Array.isArray(config.skills.entries) ? config.skills.entries : {}

  config.tools = config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools) ? config.tools : {}
  if (!String(config.tools.profile || '').trim()) config.tools.profile = 'full'
  config.tools.sessions = config.tools.sessions && typeof config.tools.sessions === 'object' && !Array.isArray(config.tools.sessions) ? config.tools.sessions : {}
  if (!String(config.tools.sessions.visibility || '').trim()) config.tools.sessions.visibility = 'all'

  config.gateway = config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway) ? config.gateway : {}
  if (!String(config.gateway.mode || '').trim()) config.gateway.mode = 'local'
  const port = Number(config.gateway.port)
  config.gateway.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 18789
  if (!String(config.gateway.bind || '').trim()) config.gateway.bind = 'loopback'
  if (!calibrationHasUsableGatewayAuth(config.gateway.auth)) {
    config.gateway.auth = {
      mode: 'token',
      token: generateCalibrationToken(),
    }
  }
  config.gateway.controlUi = config.gateway.controlUi && typeof config.gateway.controlUi === 'object' && !Array.isArray(config.gateway.controlUi) ? config.gateway.controlUi : {}
  const existingOrigins = Array.isArray(config.gateway.controlUi.allowedOrigins) ? config.gateway.controlUi.allowedOrigins.filter(Boolean) : []
  config.gateway.controlUi.allowedOrigins = [...new Set([...existingOrigins, ...origins])]
  config.gateway.controlUi.enabled = true
  config.gateway.controlUi.allowInsecureAuth = true

  return config
}

function calibrateOpenclawConfig(mode = 'inherit') {
  const normalizedMode = mode === 'reinitialize' ? 'reset' : String(mode || 'inherit').trim()
  if (normalizedMode !== 'inherit' && normalizedMode !== 'reset') {
    throw new Error('mode 必须是 inherit 或 reset')
  }
  if (!fs.existsSync(OPENCLAW_DIR)) fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  const warnings = []
  let preBackup = null
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      preBackup = handlers.create_backup().name || null
    } catch (error) {
      warnings.push(`修复前备份失败: ${error?.message || error}`)
    }
  }
  const current = readJsonFileRelaxed(CONFIG_PATH)
  const backup = readJsonFileRelaxed(CONFIG_PATH + '.bak')
  const [source, seed] = selectCalibrationSource(current, backup)

  let calibrated
  let inheritedKeys
  if (normalizedMode === 'inherit') {
    inheritedKeys = seed && typeof seed === 'object' && !Array.isArray(seed) ? Object.keys(seed) : []
    calibrated = mergeConfigsPreservingFields(buildCalibrationBaseline(), seed || {})
  } else {
    ;[calibrated, inheritedKeys] = applyResetInheritance(buildCalibrationBaseline(), seed || {})
  }
  inheritedKeys = [...new Set(inheritedKeys)].sort()
  calibrated = stripUiFields(normalizeCalibratedConfig(calibrated))
  const serialized = JSON.stringify(calibrated, null, 2)
  fs.writeFileSync(CONFIG_PATH, serialized)
  fs.writeFileSync(CONFIG_PATH + '.bak', serialized)
  return {
    mode: normalizedMode,
    source,
    backup: preBackup,
    inheritedKeys,
    warnings,
    message: normalizedMode === 'inherit' ? '配置已按继承模式校准' : '配置已按完全初始化修复模式校准',
  }
}

// === Raw WebSocket（支持 Origin header，绕过 Gateway origin 检查）===
function rawWsConnect(host, port, wsPath) {
  return new Promise((ok, no) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({ hostname: host, port, path: wsPath, method: 'GET', headers: {
      'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key, 'Origin': 'http://localhost',
    } })
    req.on('upgrade', (_, socket) => ok(socket))
    req.on('response', (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => no(new Error(`HTTP ${res.statusCode}`))) })
    req.on('error', no)
    req.setTimeout(5000, () => { req.destroy(); no(new Error('ws connect timeout')) })
    req.end()
  })
}

function wsReadFrame(socket, timeout = 8000) {
  return new Promise((ok, no) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(t)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const finish = (fn) => (value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const t = setTimeout(finish(no), timeout, new Error('ws read timeout'))
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]); if (buf.length < 2) return
      let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + len) return
      finish(ok)(buf.slice(off, off + len).toString('utf8'))
    }
    const onError = finish(no)
    const onClose = finish(no)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', () => onClose(new Error('ws closed')))
  })
}

function wsSendFrame(socket, text) {
  const p = Buffer.from(text, 'utf8'), mask = crypto.randomBytes(4)
  let h
  if (p.length < 126) { h = Buffer.alloc(2); h[0] = 0x81; h[1] = 0x80 | p.length }
  else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2) }
  const m = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4]
  socket.write(Buffer.concat([h, mask, m]))
}

function wsReadLoop(socket, onMessage, timeoutMs = DOCKER_TASK_TIMEOUT_MS) {
  let buf = Buffer.alloc(0), done = false
  const timer = setTimeout(() => { done = true; socket.destroy() }, timeoutMs)
  const cancel = () => { done = true; clearTimeout(timer); try { socket.destroy() } catch {} }
  socket.on('data', (chunk) => {
    if (done) return
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f
      let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + len) return
      const payload = buf.slice(off, off + len)
      buf = buf.slice(off + len)
      if (opcode === 0x08) { done = true; clearTimeout(timer); socket.destroy(); return } // close
      if (opcode === 0x09) { // ping → 回 pong
        const mask = crypto.randomBytes(4)
        const h = Buffer.alloc(2); h[0] = 0x8A; h[1] = 0x80 | payload.length
        const m = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) m[i] = payload[i] ^ mask[i % 4]
        try { socket.write(Buffer.concat([h, mask, m])) } catch {}
        continue
      }
      if (opcode === 0x01) onMessage(payload.toString('utf8')) // text
    }
  })
  socket.on('error', () => { done = true; clearTimeout(timer) })
  socket.on('close', () => { done = true; clearTimeout(timer) })
  return cancel
}

function patchGatewayOrigins() {
  if (!fs.existsSync(CONFIG_PATH)) return false
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const origins = requiredControlUiOrigins()
  const existing = config?.gateway?.controlUi?.allowedOrigins || []
  // 合并：保留用户已有的 origins，只追加 ClawPanel 需要的
  const merged = [...new Set([...existing, ...origins])]
  // 幂等：已包含所有需要的 origin 时跳过写入
  if (origins.every(o => existing.includes(o))) return false
  if (!config.gateway) config.gateway = {}
  if (!config.gateway.controlUi) config.gateway.controlUi = {}
  config.gateway.controlUi.allowedOrigins = merged
  writeOpenclawConfigFile(config)
  return true
}

function readOpenclawConfigOptional() {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  return cleanLoadedConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
}

function readOpenclawConfigRequired() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
  return cleanLoadedConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
}

function mergeConfigsPreservingFields(existing, next) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return next
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next
  const merged = { ...existing }
  for (const [key, value] of Object.entries(next)) {
    const prev = existing[key]
    if (prev && typeof prev === 'object' && !Array.isArray(prev) && value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeConfigsPreservingFields(prev, value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

function writeOpenclawConfigFile(config) {
  const cleaned = stripUiFields(config)
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak')
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2))
}

function ensureAgentsList(config) {
  if (!config.agents) config.agents = {}
  if (!Array.isArray(config.agents.list)) config.agents.list = []
  return config.agents.list
}

function expandHomePath(input) {
  return typeof input === 'string' && input.startsWith('~/')
    ? path.join(homedir(), input.slice(2))
    : input
}

function findAgentConfig(config, id) {
  const agentsList = Array.isArray(config.agents?.list) ? config.agents.list : []
  return agentsList.find(a => (a?.id || 'main').trim() === id) || null
}

function resolveDefaultWorkspace(config) {
  return expandHomePath(config.agents?.defaults?.workspace) || path.join(OPENCLAW_DIR, 'workspace')
}

function resolveAgentDir(config, id) {
  const agent = findAgentConfig(config, id)
  const customDir = expandHomePath(agent?.agentDir || null)
  if (customDir) return customDir
  return id === 'main' ? OPENCLAW_DIR : path.join(OPENCLAW_DIR, 'agents', id)
}

function resolveAgentWorkspace(config, id) {
  const agent = findAgentConfig(config, id)
  const workspace = expandHomePath(agent?.workspace || null)
  if (workspace) return workspace
  return id === 'main' ? resolveDefaultWorkspace(config) : path.join(resolveAgentDir(config, id), 'workspace')
}

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'csv', 'env', 'gitignore', 'gitattributes', 'editorconfig', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'html', 'htm', 'css', 'scss', 'less', 'rs', 'py', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'cmd', 'sql', 'xml', 'java', 'kt', 'go', 'rb', 'php', 'c', 'cc', 'cpp', 'h',
  'hpp', 'vue', 'svelte', 'lock', 'sample'
])

const WORKSPACE_TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  '.env',
  '.env.local',
  '.env.example',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc'
])

const WORKSPACE_PREVIEW_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const MAX_WORKSPACE_FILE_SIZE = 1024 * 1024

function normalizeWorkspaceRelativePath(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  if (path.isAbsolute(trimmed)) throw new Error('不允许使用绝对路径')
  const normalized = path.normalize(trimmed).replace(/\\/g, '/')
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('不允许访问工作区外部路径')
  }
  return normalized.split('/').filter(part => part && part !== '.').join('/')
}

function resolveAgentWorkspaceChild(config, id, relativePath = '') {
  const root = resolveAgentWorkspace(config, id)
  const normalized = normalizeWorkspaceRelativePath(relativePath)
  return {
    root,
    relativePath: normalized,
    fullPath: normalized ? path.join(root, normalized) : root,
  }
}

function isWorkspaceTextFile(filePath) {
  const base = path.basename(filePath).toLowerCase()
  const ext = path.extname(base).replace(/^\./, '')
  return WORKSPACE_TEXT_EXTENSIONS.has(ext) || WORKSPACE_TEXT_BASENAMES.has(base)
}

function isWorkspacePreviewableFile(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  return WORKSPACE_PREVIEW_EXTENSIONS.has(ext)
}

function looksBinaryBuffer(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 512)).includes(0)
}

function toWorkspaceRelativePath(root, fullPath) {
  return path.relative(root, fullPath).split(path.sep).join('/')
}

function resolveMemoryDir(config, agentId, category) {
  const workspace = resolveAgentWorkspace(config, agentId || 'main')
  if (category === 'archive') return path.join(path.dirname(workspace), 'workspace-memory')
  if (category === 'core') return workspace
  return path.join(workspace, category || 'memory')
}

function resolveMemoryPathCandidates(config, agentId, filePath) {
  return ['memory', 'archive', 'core'].map(category => path.join(resolveMemoryDir(config, agentId || 'main', category), filePath))
}

function isManagedMemoryFile(name) {
  return /\.(md|txt|json|jsonl)$/i.test(name)
}

function collectMemoryFiles(baseDir, currentDir, files, category) {
  if (!fs.existsSync(currentDir)) return
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      if (category !== 'core') collectMemoryFiles(baseDir, full, files, category)
      continue
    }
    if (!isManagedMemoryFile(entry.name)) continue
    files.push(path.relative(baseDir, full).replace(/\\/g, '/'))
  }
}

const QQBOT_DEFAULT_ACCOUNT_ID = 'default'

function platformStorageKey(platform) {
  switch (platform) {
    case 'dingtalk':
    case 'dingtalk-connector':
      return 'dingtalk-connector'
    case 'weixin':
      return 'openclaw-weixin'
    default:
      return platform
  }
}

function platformListId(platform) {
  switch (platform) {
    case 'dingtalk-connector':
      return 'dingtalk'
    case 'openclaw-weixin':
      return 'weixin'
    default:
      return platform
  }
}

function platformBindingChannel(platform) {
  const storageKey = platformStorageKey(platform)
  if (storageKey === 'dingtalk-connector') return 'dingtalk-connector'
  if (storageKey === 'openclaw-weixin') return 'openclaw-weixin'
  return platformListId(storageKey)
}

function channelHasQqbotCredentials(entry) {
  return !!(entry && typeof entry === 'object' && (entry.appId || entry.clientSecret || entry.appSecret || entry.token))
}

function resolvePlatformConfigEntry(channelRoot, platform, accountId) {
  if (!channelRoot || typeof channelRoot !== 'object') return null
  const accountKey = typeof accountId === 'string' ? accountId.trim() : ''
  if (accountKey) return channelRoot.accounts?.[accountKey] || channelRoot
  if (platformStorageKey(platform) === 'qqbot' && !channelHasQqbotCredentials(channelRoot)) {
    return channelRoot.accounts?.[QQBOT_DEFAULT_ACCOUNT_ID] || channelRoot
  }
  return channelRoot
}

function listPlatformAccounts(channelRoot) {
  if (!channelRoot || typeof channelRoot !== 'object' || !channelRoot.accounts || typeof channelRoot.accounts !== 'object') {
    return []
  }
  return Object.entries(channelRoot.accounts)
    .map(([accountId, value]) => {
      const entry = { accountId }
      const displayId = value?.appId || value?.clientId || value?.account || null
      if (displayId) entry.appId = displayId
      return entry
    })
    .sort((a, b) => (a.accountId || '').localeCompare(b.accountId || ''))
}

function normalizeBindingMatchValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeBindingMatchValue(item)).filter(item => item !== undefined)
    if (normalized.every(item => typeof item === 'string')) return [...normalized].sort()
    return normalized
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) {
      if (key === 'peer') {
        const peer = value[key]
        if (typeof peer === 'string' && peer.trim()) {
          result.peer = { kind: 'direct', id: peer.trim() }
        } else if (peer && typeof peer === 'object' && typeof peer.id === 'string' && peer.id.trim()) {
          result.peer = {
            kind: typeof peer.kind === 'string' && peer.kind.trim() ? peer.kind.trim() : 'direct',
            id: peer.id.trim(),
          }
        }
        continue
      }
      const normalized = normalizeBindingMatchValue(value[key])
      if (normalized === undefined) continue
      if (key === 'accountId' && (normalized === '' || normalized === null)) continue
      if (typeof normalized === 'string' && !normalized.trim()) continue
      result[key] = normalized
    }
    return result
  }
  if (typeof value === 'string') return value.trim()
  return value
}

function jsonValueEquals(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => jsonValueEquals(item, right[index]))
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && jsonValueEquals(left[key], right[key]))
  }
  return false
}

function buildBindingMatch(channel, accountId, bindingConfig) {
  const match = {
    channel,
    ...(accountId ? { accountId } : {}),
  }
  if (bindingConfig && typeof bindingConfig === 'object') {
    for (const [key, value] of Object.entries(bindingConfig)) {
      if (key === 'peer') {
        if (typeof value === 'string' && value.trim()) {
          match.peer = { kind: 'direct', id: value.trim() }
        } else if (value && typeof value === 'object' && value.id) {
          match.peer = { kind: value.kind || 'direct', id: value.id }
        }
      } else if (key !== 'accountId' && key !== 'channel' && value !== undefined && value !== null) {
        match[key] = value
      }
    }
  }
  return normalizeBindingMatchValue(match)
}

function bindingIdentityMatches(binding, agentId, targetMatch) {
  if ((binding?.agentId || 'main') !== (agentId || 'main')) return false
  return jsonValueEquals(
    normalizeBindingMatchValue(binding?.match || {}),
    normalizeBindingMatchValue(targetMatch || {}),
  )
}

function triggerGatewayReloadNonBlocking(reason) {
  setTimeout(() => {
    try {
      handlers.reload_gateway()
    } catch (e) {
      console.warn(`[dev-api] Gateway reload skipped after ${reason}: ${e.message || e}`)
    }
  }, 0)
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

function parseWindowsListeningPids(output, port) {
  const portSuffix = `:${port}`
  const pids = new Set()
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (!line.includes('LISTENING') && !line.includes('侦听')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 5) continue
    if (!parts[1]?.endsWith(portSuffix)) continue
    const pid = Number.parseInt(parts[4], 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids].sort((a, b) => a - b)
}

function looksLikeGatewayCommandLine(commandLine) {
  const text = String(commandLine || '').toLowerCase()
  return text.includes('openclaw') && text.includes('gateway')
}

function readWindowsProcessCommandLine(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { [Console]::Out.Write($p.CommandLine) }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0) return ''
  return String(result.stdout || '').trim()
}

function inspectWindowsPortOwners(port = readGatewayPort()) {
  const output = execSync('netstat -ano', { windowsHide: true }).toString()
  const listeningPids = parseWindowsListeningPids(output, port)
  const gatewayPids = []
  const foreignPids = []

  for (const pid of listeningPids) {
    const commandLine = readWindowsProcessCommandLine(pid)
    if (looksLikeGatewayCommandLine(commandLine)) gatewayPids.push(pid)
    else if (commandLine) foreignPids.push(pid)  // 只有确实读到非 Gateway 命令行时才归为 foreign
    else gatewayPids.push(pid)  // 命令行读不到时，假定为 Gateway（避免权限问题导致误报）
  }

  return {
    gatewayPids: [...new Set(gatewayPids)].sort((a, b) => a - b),
    foreignPids: [...new Set(foreignPids)].sort((a, b) => a - b),
  }
}

function formatPidList(pids) {
  return pids.map(String).join(', ')
}

function winStartGateway() {
  const port = readGatewayPort()
  const { gatewayPids, foreignPids } = inspectWindowsPortOwners(port)
  if (gatewayPids.length) {
    ensureOwnedGatewayOrThrow(gatewayPids[0])
    writeGatewayOwner(gatewayPids[0])
    return
  }
  if (foreignPids.length) {
    throw new Error(`端口 ${port} 已被非 Gateway 进程占用 (PID: ${formatPidList(foreignPids)})，已阻止启动`)
  }

  // 确保日志目录存在
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
  const logPath = path.join(LOGS_DIR, 'gateway.log')
  const errPath = path.join(LOGS_DIR, 'gateway.err.log')
  const out = fs.openSync(logPath, 'a')
  const err = fs.openSync(errPath, 'a')

  // 写入启动标记到日志
  const timestamp = new Date().toISOString()
  fs.appendFileSync(logPath, `\n[${timestamp}] [ClawPanel] Starting Gateway on Windows...\n`)

  // 用 cmd.exe /c 启动，不用 shell: true（避免额外 cmd.exe 进程链导致终端闪烁）
  const child = spawnOpenclaw(['gateway'], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    cwd: homedir(),
  })
  child.unref()
}

async function winStopGateway() {
  const port = readGatewayPort()
  const { gatewayPids, foreignPids } = inspectWindowsPortOwners(port)
  if (!gatewayPids.length) {
    if (foreignPids.length) {
      throw new Error(`端口 ${port} 当前由非 Gateway 进程占用 (PID: ${formatPidList(foreignPids)})，已拒绝停止以避免误杀`)
    }
    return
  }

  spawnOpenclawSync(['gateway', 'stop'], {
    windowsHide: true,
    cwd: homedir(),
    encoding: 'utf8',
  })

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300))
    if (!(await winCheckGateway()).running) return
  }

  for (const pid of gatewayPids) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true })
    } catch {}
  }

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300))
    if (!(await winCheckGateway()).running) return
  }

  throw new Error(`停止失败：Gateway 仍占用端口 ${port}`)
}

// 仅当占用端口的确实是 OpenClaw Gateway 时才视为运行
async function winCheckGateway() {
  const port = readGatewayPort()
  const { gatewayPids } = inspectWindowsPortOwners(port)
  return {
    running: gatewayPids.length > 0,
    pid: gatewayPids[0] || null,
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

function gatewayOwnerFilePath() {
  return path.join(OPENCLAW_DIR, 'gateway-owner.json')
}

function readGatewayOwner() {
  try {
    const ownerPath = gatewayOwnerFilePath()
    if (!fs.existsSync(ownerPath)) return null
    return JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
  } catch {
    return null
  }
}

function currentGatewayOwnerSignature() {
  return {
    port: readGatewayPort(),
    cliPath: canonicalCliPath(resolveOpenclawCliPath()),
    openclawDir: path.resolve(OPENCLAW_DIR),
  }
}

function matchesCurrentGatewayOwnerSignature(owner) {
  if (!owner || owner.startedBy !== 'clawpanel') return false
  const current = currentGatewayOwnerSignature()
  if (Number(owner.port || 0) !== current.port) return false
  if (!current.cliPath) return false
  const ownerCliPath = canonicalCliPath(owner.cliPath)
  if (!ownerCliPath || ownerCliPath !== current.cliPath) return false
  if (!owner.openclawDir || path.resolve(owner.openclawDir) !== current.openclawDir) return false
  return true
}

function gatewayOwnerPidNeedsRefresh(owner, pid = null) {
  if (!matchesCurrentGatewayOwnerSignature(owner)) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  return !Number.isInteger(owner?.pid) || Number(owner.pid) !== Number(pid)
}

function isCurrentGatewayOwner(owner, pid = null) {
  return matchesCurrentGatewayOwnerSignature(owner)
}

function writeGatewayOwner(pid = null) {
  const ownerPath = gatewayOwnerFilePath()
  const ownerDir = path.dirname(ownerPath)
  if (!fs.existsSync(ownerDir)) fs.mkdirSync(ownerDir, { recursive: true })
  const current = currentGatewayOwnerSignature()
  fs.writeFileSync(ownerPath, JSON.stringify({
    ...current,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    startedAt: new Date().toISOString(),
    startedBy: 'clawpanel',
  }, null, 2))
}

function clearGatewayOwner() {
  try {
    const ownerPath = gatewayOwnerFilePath()
    if (fs.existsSync(ownerPath)) fs.unlinkSync(ownerPath)
  } catch {}
}

function foreignGatewayError(pid = null) {
  const port = readGatewayPort()
  const pidText = pid ? ` (PID: ${pid})` : ''
  return new Error(`检测到端口 ${port} 上已有其他 OpenClaw Gateway 正在运行${pidText}，且不属于当前面板实例。为避免误接管，请先关闭该实例，或将当前 CLI/目录绑定到它对应的安装。`)
}

function ensureOwnedGatewayOrThrow(pid = null) {
  const owner = readGatewayOwner()
  if (isCurrentGatewayOwner(owner, pid)) {
    if (gatewayOwnerPidNeedsRefresh(owner, pid)) writeGatewayOwner(pid)
    return true
  }
  throw foreignGatewayError(pid)
}

async function getLocalGatewayRuntime(label = 'ai.openclaw.gateway') {
  if (isMac) return macCheckService(label)
  if (isLinux) return linuxCheckGateway()
  return winCheckGateway()
}

async function waitForGatewayRunning(label = 'ai.openclaw.gateway', timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await getLocalGatewayRuntime(label)
    if (status?.running) {
      writeGatewayOwner(status.pid || null)
      return status
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Gateway 启动超时，请查看 ${path.join(LOGS_DIR, 'gateway.err.log')}`)
}

async function waitForGatewayStopped(label = 'ai.openclaw.gateway', timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await getLocalGatewayRuntime(label)
    if (!status?.running) {
      clearGatewayOwner()
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
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
    // npm 全局安装路径（修复 #156：systemd 服务缺少 PATH 时 which 失败）
    path.join(home, '.npm-global/bin/openclaw'),
    path.join(home, '.npm/bin/openclaw'),
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
    if (pidMatch) {
      const pid = parseInt(pidMatch[1])
      // 修复 #151: 验证进程是否是 OpenClaw，避免与其他占用同端口的程序冲突
      let isOpenClaw = false
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
        isOpenClaw = /openclaw/i.test(cmdline)
      } catch {
        isOpenClaw = true // 无法读取进程信息时保守认为是
      }
      return { running: true, pid, manageable: isOpenClaw }
    }
    if (out.includes(`:${port}`)) return { running: true, pid: null, manageable: false }
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

  const child = spawnOpenclaw(['gateway'], {
    detached: true,
    stdio: ['ignore', out, err],
    shell: false,
    cwd: homedir(),
  })
  child.unref()
}

function linuxStopGateway() {
  const { running, pid, manageable } = linuxCheckGateway()
  if (!running || !pid) throw new Error('Gateway 未运行')
  // 修复 #151: 检测到非 OpenClaw 进程占用端口时拒绝操作
  if (manageable === false) throw new Error(`端口已被其他进程 (PID ${pid}) 占用，无法操作`)
  ensureOwnedGatewayOrThrow(pid)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    throw new Error('停止失败: ' + (e.message || e))
  }
}

// === Docker Socket 通信 ===

function dockerRequest(method, apiPath, body = null, endpoint = null) {
  return new Promise((resolve, reject) => {
    const opts = { path: apiPath, method, headers: { 'Content-Type': 'application/json' } }
    const target = normalizeDockerEndpoint(endpoint) || defaultDockerEndpoint()
    if (target.startsWith('tcp://')) {
      const url = new URL(target.replace('tcp://', 'http://'))
      opts.hostname = url.hostname
      opts.port = parseInt(url.port) || 2375
    } else {
      opts.socketPath = target
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', (e) => reject(new Error('Docker 连接失败: ' + e.message)))
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Docker API 超时')) })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Docker exec 附着模式：运行命令并捕获 stdout/stderr（解析多路复用流）
function dockerExecRun(containerId, cmd, endpoint = null, timeout = DOCKER_TASK_TIMEOUT_MS) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. 创建 exec
      const createResp = await dockerRequest('POST', `/containers/${containerId}/exec`, {
        AttachStdout: true, AttachStderr: true, Cmd: cmd,
      }, endpoint)
      if (createResp.status >= 400) return reject(new Error(`exec create: ${createResp.status} ${createResp.data?.message || ''}`))
      const execId = createResp.data?.Id
      if (!execId) return reject(new Error('no exec ID'))

      // 2. 启动 exec（附着模式，捕获输出流）
      const opts = {
        path: `/exec/${execId}/start`, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
      const target = normalizeDockerEndpoint(endpoint) || defaultDockerEndpoint()
      if (target.startsWith('tcp://')) {
        const url = new URL(target.replace('tcp://', 'http://'))
        opts.hostname = url.hostname
        opts.port = parseInt(url.port) || 2375
      } else {
        opts.socketPath = target
      }

      const req = http.request(opts, (res) => {
        let stdout = '', stderr = ''
        let buf = Buffer.alloc(0)

        res.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk])
          // 解析 Docker 多路复用流：[type(1), 0(3), size(4)] + payload
          while (buf.length >= 8) {
            const streamType = buf[0] // 1=stdout, 2=stderr
            const size = buf.readUInt32BE(4)
            if (buf.length < 8 + size) break
            const payload = buf.slice(8, 8 + size).toString('utf8')
            buf = buf.slice(8 + size)
            if (streamType === 1) stdout += payload
            else if (streamType === 2) stderr += payload
          }
        })

        res.on('end', () => resolve({ stdout, stderr }))
        res.on('error', reject)
      })

      req.on('error', reject)
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('exec timeout')) })
      req.write(JSON.stringify({ Detach: false, Tty: false }))
      req.end()
    } catch (e) { reject(e) }
  })
}

// 查找 clawpanel-agent.cjs 脚本并注入到容器（.cjs 避免容器内 ESM 冲突）
function findAgentScript() {
  const candidates = [
    path.resolve(__dev_dirname, '../openclaw-docker/full/clawpanel-agent.cjs'),
    path.resolve(__dev_dirname, '../openclaw-docker/full/clawpanel-agent.js'),
    path.resolve(__dev_dirname, '../../openclaw-docker/full/clawpanel-agent.cjs'),
    path.resolve(__dev_dirname, '../../openclaw-docker/full/clawpanel-agent.js'),
    path.resolve(__dev_dirname, '../clawpanel-agent.cjs'),
    path.resolve(__dev_dirname, '../clawpanel-agent.js'),
    path.resolve(__dev_dirname, 'clawpanel-agent.cjs'),
    path.resolve(__dev_dirname, 'clawpanel-agent.js'),
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const content = fs.readFileSync(p, 'utf8')
    return {
      path: p,
      content,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
    }
  }
  return null
}

function getAgentSyncCacheKey(containerId, endpoint) {
  return `${normalizeDockerEndpoint(endpoint) || defaultDockerEndpoint()}:${containerId}`
}

function createContainerShellExec(containerId, endpoint) {
  return async (shellCmd) => {
    const createResp = await dockerRequest('POST', `/containers/${containerId}/exec`, {
      AttachStdout: true, AttachStderr: true, Cmd: ['sh', '-c', shellCmd],
    }, endpoint)
    if (createResp.status >= 400) throw new Error(`exec 失败: ${createResp.status}`)
    const execId = createResp.data?.Id
    if (!execId) throw new Error('exec ID 缺失')
    await dockerRequest('POST', `/exec/${execId}/start`, { Detach: true }, endpoint)
    await new Promise(r => setTimeout(r, 300))
  }
}

async function injectAgentToContainer(containerId, endpoint, cExecFn, agentScript = null) {
  const source = agentScript || findAgentScript()
  if (!source) {
    console.warn('[agent] clawpanel-agent.cjs 未找到，跳过注入')
    return false
  }
  const b64 = Buffer.from(source.content, 'utf8').toString('base64')
  await cExecFn(`echo '${b64}' | base64 -d > /app/clawpanel-agent.cjs`)
  console.log(`[agent] agent 已同步 → ${containerId.slice(0, 12)} (${source.hash.slice(0, 8)})`)
  _agentScriptSyncCache.set(getAgentSyncCacheKey(containerId, endpoint), source.hash)
  return true
}

async function syncAgentToContainerIfNeeded(containerId, endpoint, cExecFn) {
  const source = findAgentScript()
  if (!source) {
    console.warn('[agent] 本地 agent 脚本缺失，跳过自动同步')
    return false
  }

  const cacheKey = getAgentSyncCacheKey(containerId, endpoint)
  if (_agentScriptSyncCache.get(cacheKey) === source.hash) {
    return true
  }

  return injectAgentToContainer(containerId, endpoint, cExecFn, source)
}

function withLocalDockerNode(nodes) {
  const list = Array.isArray(nodes)
    ? nodes.filter(Boolean).map(node => {
      const endpoint = node?.id === 'local'
        ? defaultDockerEndpoint()
        : (normalizeDockerEndpoint(node?.endpoint) || node?.endpoint)
      if (!endpoint) return { ...node }
      return {
        ...node,
        endpoint,
        type: endpoint.startsWith('tcp://') ? 'tcp' : 'socket',
      }
    })
    : []
  const local = defaultLocalDockerNode()
  const index = list.findIndex(node => node.id === 'local')
  if (index >= 0) list[index] = { ...list[index], ...local }
  else list.unshift(local)
  return list
}

function readDockerNodes() {
  if (!fs.existsSync(DOCKER_NODES_PATH)) {
    return withLocalDockerNode([])
  }
  try {
    const data = JSON.parse(fs.readFileSync(DOCKER_NODES_PATH, 'utf8'))
    return withLocalDockerNode(data.nodes || [])
  } catch {
    return withLocalDockerNode([])
  }
}

function saveDockerNodes(nodes) {
  const panelDir = path.dirname(DOCKER_NODES_PATH)
  if (!fs.existsSync(panelDir)) fs.mkdirSync(panelDir, { recursive: true })
  const persisted = (Array.isArray(nodes) ? nodes : [])
    .filter(node => node && node.id !== 'local')
    .map(node => {
      const endpoint = normalizeDockerEndpoint(node.endpoint) || node.endpoint
      return {
        ...node,
        endpoint,
        type: String(endpoint || '').startsWith('tcp://') ? 'tcp' : 'socket',
      }
    })
  fs.writeFileSync(DOCKER_NODES_PATH, JSON.stringify({ nodes: persisted }, null, 2))
}

function isDockerAvailable() {
  const endpoint = defaultDockerEndpoint()
  if (isWindows || endpoint.startsWith('tcp://')) return true // named pipe / TCP 端点无法直接 stat
  return fs.existsSync(endpoint)
}

// === 镜像拉取进度追踪 ===
const _pullProgress = new Map()

// === 实例注册表 ===

const DEFAULT_LOCAL_INSTANCE = { id: 'local', name: '本机', type: 'local', endpoint: null, gatewayPort: 18789, addedAt: 0, note: '' }

function readInstances() {
  if (!fs.existsSync(INSTANCES_PATH)) {
    return { activeId: 'local', instances: [{ ...DEFAULT_LOCAL_INSTANCE }] }
  }
  try {
    const data = JSON.parse(fs.readFileSync(INSTANCES_PATH, 'utf8'))
    if (!data.instances?.length) data.instances = [{ ...DEFAULT_LOCAL_INSTANCE }]
    if (!data.instances.find(i => i.id === 'local')) data.instances.unshift({ ...DEFAULT_LOCAL_INSTANCE })
    if (!data.activeId || !data.instances.find(i => i.id === data.activeId)) data.activeId = 'local'
    return data
  } catch {
    return { activeId: 'local', instances: [{ ...DEFAULT_LOCAL_INSTANCE }] }
  }
}

function saveInstances(data) {
  const panelDir = path.dirname(INSTANCES_PATH)
  if (!fs.existsSync(panelDir)) fs.mkdirSync(panelDir, { recursive: true })
  fs.writeFileSync(INSTANCES_PATH, JSON.stringify(data, null, 2))
}

function getActiveInstance() {
  const data = readInstances()
  return data.instances.find(i => i.id === data.activeId) || data.instances[0]
}

async function proxyToInstance(instance, cmd, body) {
  const url = `${instance.endpoint}/__api/${cmd}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  try { return JSON.parse(text) }
  catch { return text }
}

async function instanceHealthCheck(instance) {
  const result = { id: instance.id, online: false, version: null, gatewayRunning: false, lastCheck: Date.now() }
  if (instance.type === 'local') {
    result.online = true
    try {
      const services = await handlers.get_services_status()
      result.gatewayRunning = services?.[0]?.running === true
    } catch {}
    try {
      const ver = await handlers.get_version_info()
      result.version = ver?.current
    } catch {}
    return result
  }
  // Docker 类型实例：通过 Docker API 检查容器状态
  if (instance.type === 'docker' && instance.containerId) {
    try {
      const nodes = readDockerNodes()
      const node = instance.nodeId ? nodes.find(n => n.id === instance.nodeId) : nodes[0]
      if (node) {
        const resp = await dockerRequest('GET', `/containers/${instance.containerId}/json`, null, node.endpoint)
        if (resp.status < 400 && resp.data?.State?.Running) {
          result.online = true
          result.gatewayRunning = true
        }
      }
    } catch {}
    return result
  }

  if (!instance.endpoint) return result
  try {
    const resp = await fetch(`${instance.endpoint}/__api/check_installation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
    if (resp.ok) {
      const data = await resp.json()
      result.online = true
      result.version = data?.version || null
    }
  } catch {}
  if (result.online) {
    try {
      const resp = await fetch(`${instance.endpoint}/__api/get_services_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      })
      if (resp.ok) {
        const services = await resp.json()
        result.gatewayRunning = services?.[0]?.running === true
      }
    } catch {}
  }
  return result
}

// 始终在本机处理的命令（不代理到远程实例）
const ALWAYS_LOCAL = new Set([
  'instance_list', 'instance_add', 'instance_remove', 'instance_set_active',
  'instance_health_check', 'instance_health_all',
  'docker_info', 'docker_list_containers', 'docker_create_container',
  'docker_start_container', 'docker_stop_container', 'docker_restart_container',
  'docker_remove_container', 'docker_rebuild_container', 'docker_container_logs', 'docker_container_exec', 'docker_init_worker', 'docker_gateway_chat', 'docker_agent', 'docker_agent_broadcast', 'docker_dispatch_task', 'docker_dispatch_broadcast', 'docker_task_status', 'docker_task_list', 'docker_pull_image', 'docker_pull_status',
  'docker_list_images', 'docker_list_nodes', 'docker_add_node', 'docker_remove_node',
  'docker_cluster_overview',
  'auth_check', 'auth_login', 'auth_logout',
  'read_panel_config', 'write_panel_config',
  'get_deploy_mode',
  'assistant_exec', 'assistant_read_file', 'assistant_write_file',
  'assistant_list_dir', 'assistant_system_info', 'assistant_list_processes',
  'assistant_check_port', 'assistant_web_search', 'assistant_fetch_url',
  'assistant_ensure_data_dir', 'assistant_save_image', 'assistant_load_image', 'assistant_delete_image',
])

// === 工具函数 ===

// 清理 base URL：去掉尾部斜杠和已知端点路径，防止路径重复
function _normalizeBaseUrl(raw) {
  let base = (raw || '').replace(/\/+$/, '')
  base = base.replace(/\/(api\/chat|api\/generate|api\/tags|api|chat\/completions|completions|responses|messages|models)\/?$/, '')
  base = base.replace(/\/+$/, '')
  if (/:11434$/i.test(base)) return `${base}/v1`
  return base
}

// === 后端内存缓存（ARM 设备性能优化）===
// 防止短时间内重复 spawn CLI 进程，显著降低 CPU 占用
const _serverCache = new Map()
function serverCached(key, ttlMs, fn) {
  const entry = _serverCache.get(key)
  if (entry && Date.now() - entry.ts < ttlMs) return entry.val
  // in-flight 去重：同一 key 正在执行中，复用 Promise
  if (entry && entry.pending) return entry.pending
  const result = fn()
  if (result && typeof result.then === 'function') {
    // async
    const pending = result.then(val => {
      _serverCache.set(key, { val, ts: Date.now() })
      return val
    }).catch(err => {
      _serverCache.delete(key)
      throw err
    })
    _serverCache.set(key, { ...(entry || {}), pending })
    return pending
  }
  // sync
  _serverCache.set(key, { val: result, ts: Date.now() })
  return result
}

// === API Handlers ===

const handlers = {
  // 配置读写
  read_openclaw_config() {
    return readOpenclawConfigRequired()
  },

  calibrate_openclaw_config({ mode } = {}) {
    return calibrateOpenclawConfig(mode)
  },

  write_openclaw_config({ config }) {
    const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null
    const merged = existing ? mergeConfigsPreservingFields(existing, config) : config
    const cleaned = stripUiFields(merged)
    writeOpenclawConfigFile(cleaned)
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

  // 服务管理（10s 服务端缓存 + in-flight 去重，ARM 设备关键优化）
  get_services_status() {
    return serverCached('svc_status', 10000, async () => {
      const label = 'ai.openclaw.gateway'
      let { running, pid } = isMac ? macCheckService(label) : isLinux ? linuxCheckGateway() : await winCheckGateway()

      // 通用兜底：进程检测说没运行，但端口实际在监听 → Gateway 已在运行
      if (!running) {
        const port = readGatewayPort()
        const portOpen = await new Promise(resolve => {
          const sock = net.createConnection(port, '127.0.0.1', () => { sock.destroy(); resolve(true) })
          sock.on('error', () => resolve(false))
          sock.setTimeout(2000, () => { sock.destroy(); resolve(false) })
        })
        if (portOpen) { running = true }
      }

      const cliInstalled = !!resolveOpenclawCliPath()
      const owner = readGatewayOwner()
      const ownedByCurrentInstance = !!running && isCurrentGatewayOwner(owner, pid || null)
      if (ownedByCurrentInstance && gatewayOwnerPidNeedsRefresh(owner, pid || null)) {
        writeGatewayOwner(pid || null)
      }
      const ownership = !running ? 'stopped' : ownedByCurrentInstance ? 'owned' : 'foreign'

      return [{ label, running, pid, description: 'OpenClaw Gateway', cli_installed: cliInstalled, ownership, owned_by_current_instance: ownedByCurrentInstance }]
    })
  },

  async start_service({ label }) {
    // 修复 #159: Docker 双容器模式下禁止本地启动 Gateway
    if (process.env.DISABLE_GATEWAY_SPAWN === '1' || process.env.DISABLE_GATEWAY_SPAWN === 'true') {
      throw new Error('本地 Gateway 启动已禁用（DISABLE_GATEWAY_SPAWN=1），请使用远程 Gateway')
    }
    const status = await getLocalGatewayRuntime(label)
    if (status?.running) {
      if (status.manageable === false) {
        throw new Error(`端口 ${readGatewayPort()} 已被其他进程 (PID ${status.pid}) 占用，无法操作`)
      }
      ensureOwnedGatewayOrThrow(status.pid || null)
      writeGatewayOwner(status.pid || null)
      return true
    }
    if (isMac) {
      macStartService(label)
      await waitForGatewayRunning(label)
      return true
    }
    if (isLinux) {
      linuxStartGateway()
      await waitForGatewayRunning(label)
      return true
    }
    winStartGateway()
    await waitForGatewayRunning(label)
    return true
  },

  async stop_service({ label }) {
    const status = await getLocalGatewayRuntime(label)
    if (status?.running) {
      if (status.manageable === false) {
        throw new Error(`端口 ${readGatewayPort()} 已被其他进程 (PID ${status.pid}) 占用，无法操作`)
      }
      ensureOwnedGatewayOrThrow(status.pid || null)
    }
    if (isMac) {
      macStopService(label)
      if (!(await waitForGatewayStopped(label))) throw new Error('Gateway 停止超时')
      return true
    }
    if (isLinux) {
      linuxStopGateway()
      if (!(await waitForGatewayStopped(label))) throw new Error('Gateway 停止超时')
      return true
    }
    await winStopGateway()
    clearGatewayOwner()
    return true
  },

  async restart_service({ label }) {
    const status = await getLocalGatewayRuntime(label)
    if (status?.running) {
      if (status.manageable === false) {
        throw new Error(`端口 ${readGatewayPort()} 已被其他进程 (PID ${status.pid}) 占用，无法操作`)
      }
      ensureOwnedGatewayOrThrow(status.pid || null)
    }
    await handlers.stop_service({ label })
    await handlers.start_service({ label })
    return true
  },

  async reload_gateway() {
    if (process.env.DISABLE_GATEWAY_SPAWN === '1' || process.env.DISABLE_GATEWAY_SPAWN === 'true') {
      throw new Error('本地 Gateway 启动已禁用（DISABLE_GATEWAY_SPAWN=1）')
    }
    if (!isMac && !isLinux) {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    }
    await handlers.restart_service({ label: 'ai.openclaw.gateway' })
    return 'Gateway 已重启'
  },

  async restart_gateway() {
    if (process.env.DISABLE_GATEWAY_SPAWN === '1' || process.env.DISABLE_GATEWAY_SPAWN === 'true') {
      throw new Error('本地 Gateway 启动已禁用（DISABLE_GATEWAY_SPAWN=1）')
    }
    if (!isMac && !isLinux) {
      throw new Error('Windows 请使用 Tauri 桌面应用')
    }
    await handlers.restart_service({ label: 'ai.openclaw.gateway' })
    return 'Gateway 已重启'
  },

  // === 消息渠道管理 ===

  list_configured_platforms() {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const cfg = readOpenclawConfigOptional()
    const channels = cfg.channels || {}
    return Object.entries(channels).map(([id, val]) => ({
      id: platformListId(id),
      enabled: val?.enabled !== false,
      accounts: listPlatformAccounts(val),
    }))
  },

  read_platform_config({ platform, accountId }) {
    if (!fs.existsSync(CONFIG_PATH)) return { exists: false }
    const cfg = readOpenclawConfigOptional()
    const storageKey = platformStorageKey(platform)
    const channelRoot = cfg.channels?.[storageKey]
    const saved = resolvePlatformConfigEntry(channelRoot, platform, accountId)
    if (!saved) return { exists: false }
    const form = {}
    if (platform === 'qqbot') {
      const t = saved.token || ''
      const [appIdFromToken, ...rest] = t.split(':')
      const appId = saved.appId || appIdFromToken || ''
      const clientSecret = saved.clientSecret || saved.appSecret || (rest.length ? rest.join(':') : '')
      if (!appId && !clientSecret) return { exists: false }
      if (appId) form.appId = appId
      if (clientSecret) form.clientSecret = clientSecret
    } else if (platform === 'telegram') {
      if (saved.botToken) form.botToken = saved.botToken
      if (saved.allowFrom) form.allowedUsers = saved.allowFrom.join(', ')
    } else if (platform === 'discord') {
      if (saved.token) form.token = saved.token
      const gid = saved.guilds && Object.keys(saved.guilds)[0]
      if (gid) form.guildId = gid
    } else if (platform === 'feishu') {
      if (saved.appId) form.appId = saved.appId
      if (saved.appSecret) form.appSecret = saved.appSecret
      if (saved.domain) form.domain = saved.domain
    } else {
      for (const [k, v] of Object.entries(saved)) {
        if (k !== 'enabled' && k !== 'accounts' && typeof v === 'string') form[k] = v
      }
    }
    return { exists: true, values: form }
  },

  save_messaging_platform({ platform, form, accountId }) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
    const cfg = readOpenclawConfigRequired()
    if (!cfg.channels) cfg.channels = {}
    const storageKey = platformStorageKey(platform)
    const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''
    const setRootChannelEntry = (entry) => {
      const current = cfg.channels?.[storageKey]
      if (current && typeof current === 'object' && current.accounts && typeof current.accounts === 'object') {
        entry.accounts = current.accounts
      }
      cfg.channels[storageKey] = entry
    }
    const setAccountChannelEntry = (entry) => {
      const current = cfg.channels?.[storageKey] && typeof cfg.channels[storageKey] === 'object'
        ? cfg.channels[storageKey]
        : { enabled: true }
      current.enabled = true
      if (!current.accounts || typeof current.accounts !== 'object') current.accounts = {}
      current.accounts[normalizedAccountId] = entry
      cfg.channels[storageKey] = current
    }
    const entry = { enabled: true }
    if (platform === 'qqbot') {
      const clientSecret = form.clientSecret || form.appSecret
      if (!form.appId || !clientSecret) throw new Error('AppID 和 ClientSecret 不能为空')
      const current = cfg.channels.qqbot && typeof cfg.channels.qqbot === 'object' ? cfg.channels.qqbot : { enabled: true }
      current.enabled = true
      delete current.appId
      delete current.clientSecret
      delete current.appSecret
      delete current.token
      if (!current.accounts || typeof current.accounts !== 'object') current.accounts = {}
      const accountKey = normalizedAccountId || QQBOT_DEFAULT_ACCOUNT_ID
      current.accounts[accountKey] = {
        appId: form.appId,
        clientSecret,
        token: `${form.appId}:${clientSecret}`,
        enabled: true,
      }
      cfg.channels.qqbot = current
    } else if (platform === 'telegram') {
      entry.botToken = form.botToken
      if (form.allowedUsers) entry.allowFrom = form.allowedUsers.split(',').map(s => s.trim()).filter(Boolean)
    } else if (platform === 'discord') {
      entry.token = form.token
      entry.groupPolicy = 'allowlist'
      if (form.guildId) {
        const ck = form.channelId || '*'
        entry.guilds = { [form.guildId]: { users: ['*'], requireMention: true, channels: { [ck]: { allow: true, requireMention: true } } } }
      }
    } else if (platform === 'feishu') {
      entry.appId = form.appId
      entry.appSecret = form.appSecret
      entry.connectionMode = 'websocket'
      if (form.domain) entry.domain = form.domain
      if (normalizedAccountId) {
        setAccountChannelEntry(entry)
      } else {
        setRootChannelEntry(entry)
      }
    } else if (platform === 'dingtalk' || platform === 'dingtalk-connector') {
      Object.assign(entry, form)
      if (normalizedAccountId) {
        setAccountChannelEntry(entry)
      } else {
        setRootChannelEntry(entry)
      }
    } else {
      Object.assign(entry, form)
      setRootChannelEntry(entry)
    }

    if (platform !== 'qqbot' && platform !== 'feishu' && platform !== 'dingtalk' && platform !== 'dingtalk-connector') {
      cfg.channels[storageKey] = entry
    }

    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('save_messaging_platform')
    return { ok: true }
  },

  remove_messaging_platform({ platform, accountId }) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
    const cfg = readOpenclawConfigRequired()
    const storageKey = platformStorageKey(platform)
    const bindingChannel = platformBindingChannel(platform)
    const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''

    if (normalizedAccountId) {
      if (cfg.channels?.[storageKey]?.accounts && typeof cfg.channels[storageKey].accounts === 'object') {
        delete cfg.channels[storageKey].accounts[normalizedAccountId]
      }
    } else if (cfg.channels) {
      delete cfg.channels[storageKey]
    }

    if (Array.isArray(cfg.bindings)) {
      cfg.bindings = cfg.bindings.filter(b => {
        if (b.match?.channel !== bindingChannel) return true
        if (normalizedAccountId) return (b.match?.accountId || '') !== normalizedAccountId
        return false
      })
    }

    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('remove_messaging_platform')
    return { ok: true }
  },

  toggle_messaging_platform({ platform, enabled }) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
    const cfg = readOpenclawConfigRequired()
    const storageKey = platformStorageKey(platform)
    if (!cfg.channels?.[storageKey]) throw new Error(`平台 ${platform} 未配置`)
    cfg.channels[storageKey].enabled = enabled
    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('toggle_messaging_platform')
    return { ok: true }
  },

  async verify_bot_token({ platform, form }) {
    if (platform === 'feishu') {
      const domain = (form.domain || '').trim()
      const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
      try {
        const resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: form.appId, app_secret: form.appSecret }),
          signal: AbortSignal.timeout(15000),
        })
        const body = await resp.json()
        if (body.code === 0) return { valid: true, errors: [], details: [`App ID: ${form.appId}`] }
        return { valid: false, errors: [body.msg || '凭证无效'] }
      } catch (e) {
        return { valid: false, errors: [`飞书 API 连接失败: ${e.message}`] }
      }
    }
    if (platform === 'qqbot') {
      try {
        const clientSecret = form.clientSecret || form.appSecret
        const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: form.appId, clientSecret }),
          signal: AbortSignal.timeout(15000),
        })
        const body = await resp.json()
        if (body.access_token) return { valid: true, errors: [], details: [`AppID: ${form.appId}`] }
        return { valid: false, errors: [body.message || body.msg || '凭证无效'] }
      } catch (e) {
        return { valid: false, errors: [`QQ Bot API 连接失败: ${e.message}`] }
      }
    }
    if (platform === 'telegram') {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${form.botToken}/getMe`, { signal: AbortSignal.timeout(15000) })
        const body = await resp.json()
        if (body.ok) return { valid: true, errors: [], details: [`Bot: @${body.result?.username}`] }
        return { valid: false, errors: [body.description || 'Token 无效'] }
      } catch (e) {
        return { valid: false, errors: [`Telegram API 连接失败: ${e.message}`] }
      }
    }
    if (platform === 'discord') {
      try {
        const resp = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${form.token}` },
          signal: AbortSignal.timeout(15000),
        })
        if (resp.status === 401) return { valid: false, errors: ['Bot Token 无效'] }
        const body = await resp.json()
        if (body.bot) return { valid: true, errors: [], details: [`Bot: @${body.username}`] }
        return { valid: false, errors: ['提供的 Token 不属于 Bot 账号'] }
      } catch (e) {
        return { valid: false, errors: [`Discord API 连接失败: ${e.message}`] }
      }
    }
    return { valid: true, warnings: ['该平台暂不支持在线校验'] }
  },

  install_qqbot_plugin({ version } = {}) {
    const spec = version ? `@tencent-connect/openclaw-qqbot@${version}` : '@tencent-connect/openclaw-qqbot@latest'
    try {
      execOpenclawSync(['plugins', 'install', spec], { timeout: 600000, cwd: homedir(), windowsHide: true }, 'QQBot 插件安装失败')
      return '安装成功'
    } catch (e) {
      throw new Error('QQBot 插件安装失败: ' + (e.message || e))
    }
  },

  get_channel_plugin_status({ pluginId }) {
    if (!pluginId || !pluginId.trim()) throw new Error('pluginId 不能为空')
    const pid = pluginId.trim()
    const pluginDir = path.join(OPENCLAW_DIR, 'plugins', 'node_modules', pid)
    const installed = fs.existsSync(pluginDir) && fs.existsSync(path.join(pluginDir, 'package.json'))
    // 检测是否为内置插件
    let builtin = false
    try {
      const result = spawnOpenclawSync(['plugins', 'list'], { timeout: 10000, encoding: 'utf8', cwd: homedir(), windowsHide: true })
      const output = (result.stdout || '') + (result.stderr || '')
      if (result.status === 0 && output.includes(pid) && output.includes('built-in')) builtin = true
    } catch {}
    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
    const allowArr = cfg.plugins?.allow || []
    const allowed = allowArr.includes(pid)
    const enabled = !!cfg.plugins?.entries?.[pid]?.enabled
    const backupDir = path.join(OPENCLAW_DIR, 'plugin-backups', pid)
    const legacyBackup = path.join(OPENCLAW_DIR, 'plugins', 'node_modules', `${pid}.bak`)
    return {
      installed, builtin, path: pluginDir,
      allowed, enabled,
      legacyBackupDetected: fs.existsSync(backupDir) || fs.existsSync(legacyBackup),
    }
  },

  install_channel_plugin({ packageName, pluginId, version }) {
    if (!packageName || !pluginId) throw new Error('packageName 和 pluginId 不能为空')
    const spec = version ? `${packageName.trim()}@${version}` : packageName.trim()
    try {
      execOpenclawSync(['plugins', 'install', spec], { timeout: 120000, cwd: homedir(), windowsHide: true }, `插件 ${pluginId} 安装失败`)
      return '安装成功'
    } catch (e) {
      throw new Error(`插件 ${pluginId} 安装失败: ` + (e.message || e))
    }
  },

  async pairing_list_channel({ channel }) {
    if (!channel || !channel.trim()) throw new Error('channel 不能为空')
    try {
      const output = execOpenclawSync(['pairing', 'list', channel.trim()], { timeout: 15000, encoding: 'utf8', cwd: homedir(), windowsHide: true }, '执行 openclaw pairing list 失败')
      return output.trim() || '暂无待审批请求'
    } catch (e) {
      throw new Error('执行 openclaw pairing list 失败: ' + (e.stderr || e.message || e))
    }
  },

  async pairing_approve_channel({ channel, code, notify }) {
    if (!channel || !channel.trim()) throw new Error('channel 不能为空')
    if (!code || !code.trim()) throw new Error('配对码不能为空')
    const args = ['pairing', 'approve', channel.trim(), code.trim().toUpperCase()]
    if (notify) args.push('--notify')
    try {
      const output = execOpenclawSync(args, { timeout: 15000, encoding: 'utf8', cwd: homedir(), windowsHide: true }, '执行 openclaw pairing approve 失败')
      return output.trim() || '操作完成'
    } catch (e) {
      throw new Error('执行 openclaw pairing approve 失败: ' + (e.stderr || e.message || e))
    }
  },

  // === 实例管理 ===

  instance_list() {
    const data = readInstances()
    return data
  },

  instance_add({ name, type, endpoint, gatewayPort, containerId, nodeId, note }) {
    if (!name) throw new Error('实例名称不能为空')
    if (!endpoint) throw new Error('端点地址不能为空')
    const data = readInstances()
    const id = type === 'docker' ? `docker-${(containerId || Date.now().toString(36)).slice(0, 12)}` : `remote-${Date.now().toString(36)}`
    if (data.instances.find(i => i.endpoint === endpoint)) throw new Error('该端点已存在')
    data.instances.push({
      id, name, type: type || 'remote', endpoint,
      gatewayPort: gatewayPort || 18789,
      containerId: containerId || null,
      nodeId: nodeId || null,
      addedAt: Math.floor(Date.now() / 1000),
      note: note || '',
    })
    saveInstances(data)
    return { id, name }
  },

  instance_remove({ id }) {
    if (id === 'local') throw new Error('本机实例不可删除')
    const data = readInstances()
    data.instances = data.instances.filter(i => i.id !== id)
    if (data.activeId === id) data.activeId = 'local'
    saveInstances(data)
    return true
  },

  instance_set_active({ id }) {
    const data = readInstances()
    if (!data.instances.find(i => i.id === id)) throw new Error('实例不存在')
    data.activeId = id
    saveInstances(data)
    return { activeId: id }
  },

  async instance_health_check({ id }) {
    const data = readInstances()
    const instance = data.instances.find(i => i.id === id)
    if (!instance) throw new Error('实例不存在')
    return instanceHealthCheck(instance)
  },

  async instance_health_all() {
    const data = readInstances()
    const results = await Promise.allSettled(data.instances.map(i => instanceHealthCheck(i)))
    return results.map((r, idx) => r.status === 'fulfilled' ? r.value : { id: data.instances[idx].id, online: false, lastCheck: Date.now() })
  },

  // === Docker 集群管理 ===

  async docker_test_endpoint({ endpoint } = {}) {
    if (!endpoint) throw new Error('请提供端点地址')
    const resp = await dockerRequest('GET', '/info', null, endpoint)
    if (resp.status !== 200) throw new Error('Docker 守护进程未响应')
    const d = resp.data
    return {
      ServerVersion: d.ServerVersion,
      Containers: d.Containers,
      Images: d.Images,
      OS: d.OperatingSystem,
    }
  },

  async docker_info({ nodeId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('GET', '/info', null, node.endpoint)
    if (resp.status !== 200) throw new Error('Docker 守护进程未响应')
    const d = resp.data
    return {
      nodeId: node.id, nodeName: node.name,
      containers: d.Containers, containersRunning: d.ContainersRunning,
      containersPaused: d.ContainersPaused, containersStopped: d.ContainersStopped,
      images: d.Images, serverVersion: d.ServerVersion,
      os: d.OperatingSystem, arch: d.Architecture,
      cpus: d.NCPU, memory: d.MemTotal,
    }
  },

  async docker_list_containers({ nodeId, all = true } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const query = all ? '?all=true' : ''
    const resp = await dockerRequest('GET', `/containers/json${query}`, null, node.endpoint)
    if (resp.status !== 200) throw new Error('获取容器列表失败')
    return (resp.data || []).map(c => ({
      id: c.Id?.slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}` : `${p.PrivatePort}`).join(', '),
      created: c.Created,
      nodeId: node.id, nodeName: node.name,
    }))
  },

  async docker_create_container({ nodeId, name, image, tag = 'latest', panelPort = 1420, gatewayPort = 18789, envVars = {}, volume = true } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const imgFull = `${image || defaultDockerImage()}:${tag}`
    const containerName = name || `openclaw-${Date.now().toString(36)}`
    const env = Object.entries(envVars).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)
    const portBindings = {}
    const exposedPorts = {}
    if (panelPort) {
      portBindings['1420/tcp'] = [{ HostPort: String(panelPort) }]
      exposedPorts['1420/tcp'] = {}
    }
    if (gatewayPort) {
      portBindings['18789/tcp'] = [{ HostPort: String(gatewayPort) }]
      exposedPorts['18789/tcp'] = {}
    }
    const config = {
      Image: imgFull,
      Env: env,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: volume ? [`openclaw-data-${containerName}:/root/.openclaw`] : [],
      },
    }
    const query = `?name=${encodeURIComponent(containerName)}`
    const resp = await dockerRequest('POST', `/containers/create${query}`, config, node.endpoint)
    if (resp.status === 404) {
      // Image not found, need to pull first
      throw new Error(`镜像 ${imgFull} 不存在，请先拉取`)
    }
    if (resp.status !== 201) throw new Error(resp.data?.message || '创建容器失败')
    // Auto-start
    const startResp = await dockerRequest('POST', `/containers/${resp.data.Id}/start`, null, node.endpoint)
    if (startResp.status !== 204 && startResp.status !== 304) {
      throw new Error('容器已创建但启动失败')
    }
    const containerId = resp.data.Id?.slice(0, 12)

    // 自动注册为可管理实例
    if (panelPort) {
      const endpoint = `http://127.0.0.1:${panelPort}`
      const instData = readInstances()
      if (!instData.instances.find(i => i.endpoint === endpoint)) {
        instData.instances.push({
          id: `docker-${containerId}`,
          name: containerName,
          type: 'docker',
          endpoint,
          gatewayPort: gatewayPort || 18789,
          containerId,
          nodeId: node.id,
          addedAt: Math.floor(Date.now() / 1000),
          note: `Image: ${imgFull}`,
        })
        saveInstances(instData)
      }
    }

    return { id: containerId, name: containerName, started: true, instanceId: `docker-${containerId}` }
  },

  async docker_start_container({ nodeId, containerId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('POST', `/containers/${containerId}/start`, null, node.endpoint)
    if (resp.status !== 204 && resp.status !== 304) throw new Error(resp.data?.message || '启动失败')
    return true
  },

  async docker_stop_container({ nodeId, containerId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('POST', `/containers/${containerId}/stop`, null, node.endpoint)
    if (resp.status !== 204 && resp.status !== 304) throw new Error(resp.data?.message || '停止失败')
    return true
  },

  async docker_restart_container({ nodeId, containerId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('POST', `/containers/${containerId}/restart`, null, node.endpoint)
    if (resp.status !== 204) throw new Error(resp.data?.message || '重启失败')
    return true
  },

  async docker_remove_container({ nodeId, containerId, force = false } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const query = force ? '?force=true&v=true' : '?v=true'
    const resp = await dockerRequest('DELETE', `/containers/${containerId}${query}`, null, node.endpoint)
    if (resp.status !== 204) throw new Error(resp.data?.message || '删除失败')

    // 自动移除对应的实例注册
    const instData = readInstances()
    const instId = `docker-${containerId}`
    const before = instData.instances.length
    instData.instances = instData.instances.filter(i => i.id !== instId && i.containerId !== containerId)
    if (instData.instances.length < before) {
      if (instData.activeId === instId) instData.activeId = 'local'
      saveInstances(instData)
    }

    return true
  },

  // 重建容器（保留配置，拉取最新镜像重新创建）
  async docker_rebuild_container({ nodeId, containerId, pullLatest = true } = {}) {
    if (!containerId) throw new Error('缺少 containerId')
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')

    // 1. 检查容器详情
    const inspectResp = await dockerRequest('GET', `/containers/${containerId}/json`, null, node.endpoint)
    if (inspectResp.status >= 400) throw new Error('容器不存在或无法访问')
    const info = inspectResp.data
    const oldName = (info.Name || '').replace(/^\//, '')
    const oldImage = info.Config?.Image || ''
    const oldEnv = info.Config?.Env || []
    const oldPortBindings = info.HostConfig?.PortBindings || {}
    const oldBinds = info.HostConfig?.Binds || []
    const oldRestartPolicy = info.HostConfig?.RestartPolicy || { Name: 'unless-stopped' }
    const oldExposedPorts = info.Config?.ExposedPorts || {}

    // 从名字推断角色
    const role = (() => {
      const n = oldName.toLowerCase()
      for (const r of ['coder', 'translator', 'writer', 'analyst', 'custom']) {
        if (n.includes(r)) return r
      }
      return 'general'
    })()

    console.log(`[rebuild] ${oldName} (${containerId.slice(0, 12)}) — image: ${oldImage}`)

    // 2. 拉取最新镜像（可选）
    if (pullLatest && oldImage) {
      const [img, tag] = oldImage.includes(':') ? oldImage.split(':') : [oldImage, 'latest']
      try {
        const pullResp = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(img)}&tag=${encodeURIComponent(tag)}`, null, node.endpoint)
        if (pullResp.status < 300) console.log(`[rebuild] 镜像已更新: ${oldImage}`)
      } catch (e) {
        console.warn(`[rebuild] 镜像拉取失败(继续使用本地): ${e.message}`)
      }
    }

    // 3. 停止并移除旧容器
    await dockerRequest('POST', `/containers/${containerId}/stop`, null, node.endpoint).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
    const rmResp = await dockerRequest('DELETE', `/containers/${containerId}?force=true`, null, node.endpoint)
    if (rmResp.status !== 204 && rmResp.status !== 404) {
      throw new Error(`移除旧容器失败: ${rmResp.data?.message || rmResp.status}`)
    }

    // 移除旧实例注册
    const instData = readInstances()
    const instId = `docker-${containerId.slice(0, 12)}`
    instData.instances = instData.instances.filter(i => i.id !== instId && i.containerId !== containerId)
    saveInstances(instData)

    // 4. 创建新容器（相同配置）
    const newConfig = {
      Image: oldImage,
      Env: oldEnv,
      ExposedPorts: oldExposedPorts,
      HostConfig: {
        PortBindings: oldPortBindings,
        RestartPolicy: oldRestartPolicy,
        Binds: oldBinds,
      },
    }
    const query = `?name=${encodeURIComponent(oldName)}`
    const createResp = await dockerRequest('POST', `/containers/create${query}`, newConfig, node.endpoint)
    if (createResp.status !== 201) throw new Error(`创建新容器失败: ${createResp.data?.message || createResp.status}`)
    const newId = createResp.data?.Id

    // 5. 启动新容器
    const startResp = await dockerRequest('POST', `/containers/${newId}/start`, null, node.endpoint)
    if (startResp.status !== 204 && startResp.status !== 304) throw new Error('新容器启动失败')

    const newCid = newId?.slice(0, 12) || newId

    // 6. 注册实例
    const panelPort = oldPortBindings['1420/tcp']?.[0]?.HostPort
    if (panelPort) {
      const endpoint = `http://127.0.0.1:${panelPort}`
      if (!instData.instances.find(i => i.endpoint === endpoint)) {
        instData.instances.push({
          id: `docker-${newCid}`, name: oldName, type: 'docker',
          endpoint, gatewayPort: oldPortBindings['18789/tcp']?.[0]?.HostPort || 18789,
          containerId: newCid, nodeId: node.id,
          addedAt: Math.floor(Date.now() / 1000), note: `Rebuilt: ${oldImage}`,
        })
        saveInstances(instData)
      }
    }

    // 7. 初始化（同步配置 + 注入 agent）
    await new Promise(r => setTimeout(r, 3000))
    try {
      await handlers.docker_init_worker({ nodeId, containerId: newId, role })
    } catch (e) {
      console.warn(`[rebuild] 初始化警告: ${e.message}`)
    }

    console.log(`[rebuild] ${oldName} 重建完成: ${containerId.slice(0, 12)} → ${newCid}`)
    return { id: newCid, name: oldName, rebuilt: true, role }
  },

  async docker_gateway_chat({ nodeId, containerId, message, timeout = DOCKER_TASK_TIMEOUT_MS } = {}) {
    if (!containerId || !message) throw new Error('缺少 containerId 或 message')
    // 1. 查找容器的 Gateway 端口
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('GET', `/containers/${containerId}/json`, null, node.endpoint)
    if (resp.status >= 400) throw new Error('容器不存在或无法访问')
    const ports = resp.data?.NetworkSettings?.Ports || {}
    const gwBinding = ports['18789/tcp']
    if (!gwBinding || !gwBinding[0]?.HostPort) throw new Error('该容器没有暴露 Gateway 端口 (18789)')
    const gwPort = gwBinding[0].HostPort

    // 2. TCP 端口预检 — 快速判断 Gateway 是否在监听，失败则自动修复
    const containerName = resp.data?.Name?.replace(/^\//, '') || containerId.slice(0, 12)
    const tcpCheck = (port) => new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 5000 })
      sock.on('connect', () => { sock.destroy(); resolve() })
      sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')) })
      sock.on('error', (e) => reject(e))
    })
    try {
      await tcpCheck(gwPort)
    } catch {
      // Gateway 未运行 → 自动修复：同步配置 + 重启 Gateway
      console.log(`[gateway-chat] ${containerName}: Gateway 未响应，自动修复中...`)
      try {
        await handlers.docker_init_worker({ nodeId, containerId, role: 'general' })
        // 等待 Gateway 启动
        await new Promise(r => setTimeout(r, 8000))
        await tcpCheck(gwPort)
        console.log(`[gateway-chat] ${containerName}: 自动修复成功`)
      } catch (e2) {
        throw new Error(`${containerName}: Gateway 自动修复失败 — ${e2.message}`)
      }
    }

    // 3. Raw WebSocket 连接 Gateway（带 Origin header + 固定 CLUSTER_TOKEN，含重试）
    let socket
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        socket = await rawWsConnect('127.0.0.1', parseInt(gwPort), '/ws')
        break
      } catch (e) {
        if (attempt === 3) throw new Error(`${containerName}: WebSocket 连接失败 — ${e.message}`)
        console.log(`[gateway-chat] ${containerName}: WS 连接失败(${attempt}/3)，${attempt * 2}s 后重试...`)
        await new Promise(r => setTimeout(r, attempt * 2000))
      }
    }
    console.log(`[gateway-chat] WebSocket 已连接 ws://127.0.0.1:${gwPort}/ws`)

    // 3a. 读取 connect.challenge
    const challengeRaw = await wsReadFrame(socket, 8000)
    const challenge = JSON.parse(challengeRaw)
    if (challenge.event !== 'connect.challenge') throw new Error('Gateway 未发送 challenge')

    // 3b. 发送 connect 帧（固定 token + 完整设备签名）
    const connectFrame = handlers.create_connect_frame({ nonce: challenge.payload?.nonce || '', gatewayToken: CLUSTER_TOKEN })
    wsSendFrame(socket, JSON.stringify(connectFrame))

    // 3c. 读取 connect 响应
    const connectRespRaw = await wsReadFrame(socket, 8000)
    const connectResp = JSON.parse(connectRespRaw)
    if (!connectResp.ok) {
      socket.destroy()
      const errMsg = connectResp.error?.message || 'Gateway 握手失败'
      throw new Error(`${containerName}: ${errMsg}`)
    }
    console.log(`[gateway-chat] 握手成功: ${containerName}`)
    const defaults = connectResp.payload?.snapshot?.sessionDefaults
    const sessionKey = defaults?.mainSessionKey || `agent:${defaults?.defaultAgentId || 'main'}:cluster-task`

    // 4. 发送聊天消息
    const chatId = `chat-${Date.now().toString(36)}`
    wsSendFrame(socket, JSON.stringify({
      type: 'req', id: chatId, method: 'chat.send',
      params: { sessionKey, message, deliver: false, idempotencyKey: chatId }
    }))

    // 5. 读取聊天回复流
    console.log(`[gateway-chat] 消息已发送，等待 AI 回复: ${containerName}`)
    return new Promise((resolve, reject) => {
      let result = '', done = false
      const cancel = wsReadLoop(socket, (data) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }
        // 诊断日志：显示所有收到的消息类型
        const msgInfo = msg.type === 'event' ? `event:${msg.event} state=${msg.payload?.state || ''}` : `${msg.type} id=${msg.id} ok=${msg.ok}`
        console.log(`[gateway-chat] ${containerName} ← ${msgInfo}`)
        if (msg.type === 'event' && msg.event === 'chat') {
          const p = msg.payload
          if (p?.state === 'delta') {
            const content = p.message?.content
            if (typeof content === 'string' && content.length > result.length) result = content
          }
          if (p?.state === 'final') {
            const content = p.message?.content
            if (typeof content === 'string' && content) result = content
            done = true; cancel()
            resolve({ ok: true, result })
          }
          if (p?.state === 'error') {
            done = true; cancel()
            const errDetail = p.error?.message || p.message?.content || p.errorMessage || JSON.stringify(p).slice(0, 300)
            console.error(`[gateway-chat] ${containerName} AI error payload:`, JSON.stringify(p).slice(0, 500))
            reject(new Error(`${containerName}: AI 错误 — ${errDetail}`))
          }
        }
        if (msg.type === 'res' && !msg.ok) {
          done = true; cancel()
          const errMsg = msg.error?.message || '任务发送失败'
          if (errMsg.includes('no model') || errMsg.includes('model'))
            reject(new Error(`${containerName}: 未配置模型 — 请先在容器面板中配置 AI 模型`))
          else
            reject(new Error(`${containerName}: ${errMsg}`))
        }
      }, timeout)
      // 超时兜底
      setTimeout(() => {
        if (!done) { done = true; cancel(); resolve({ ok: true, result: result || '（无回复）' }) }
      }, timeout)
    })
  },

  // === Docker Agent 通道（容器内专属控制代理）===
  async docker_agent({ nodeId, containerId, cmd } = {}) {
    if (!containerId) throw new Error('缺少 containerId')
    if (!cmd || !cmd.cmd) throw new Error('缺少 cmd')
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')

    const cmdJson = JSON.stringify(cmd)
    const timeout = cmd.timeout || (cmd.cmd === 'task.run' ? DOCKER_TASK_TIMEOUT_MS : 30000)
    const cid12 = containerId.slice(0, 12)

    const runAgent = async () => {
      const execResult = await dockerExecRun(
        containerId,
        ['node', '/app/clawpanel-agent.cjs', cmdJson],
        node.endpoint,
        timeout,
      )
      return execResult
    }

    const cExec = createContainerShellExec(containerId, node.endpoint)

    console.log(`[agent] ${cid12} → ${cmd.cmd}`)
    let execResult
    try {
      await syncAgentToContainerIfNeeded(containerId, node.endpoint, cExec)
      execResult = await runAgent()
    } catch (e) {
      // exec 本身失败（如 node 未找到模块），尝试自动注入
      throw new Error(`容器代理执行失败: ${e.message}`)
    }

    // 检查 agent 是否缺失（stdout 空 + stderr 含 "Cannot find module"）
    if (!execResult.stdout.trim() && execResult.stderr.includes('Cannot find module')) {
      console.log(`[agent] ${cid12}: agent 未安装，自动注入中...`)
      const injected = await injectAgentToContainer(containerId, node.endpoint, cExec)
      if (!injected) throw new Error('容器代理未安装且无法自动注入 — 请先执行征召(init-worker)')
      execResult = await runAgent()
    }

    // 解析 NDJSON 输出
    const lines = execResult.stdout.split('\n').filter(l => l.trim())
    const events = []
    for (const line of lines) {
      try { events.push(JSON.parse(line)) } catch {}
    }

    if (execResult.stderr) {
      console.warn(`[agent] ${cid12} stderr: ${execResult.stderr.slice(0, 300)}`)
    }

    // 提取最终结果
    const error = events.find(e => e.type === 'error')
    if (error) {
      const err = new Error(error.message || '容器代理执行失败')
      err.events = events
      throw err
    }

    const final = events.find(e => e.type === 'final')
    const result = events.find(e => e.type === 'result')

    if (final) return { ok: true, result: final.text, events }
    if (result) {
      if (result.ok) return { ok: true, ...result, events }
      const err = new Error(result.message || '容器代理执行失败')
      err.events = events
      throw err
    }

    const tailTypes = events.slice(-3).map(e => e.type || 'unknown').join(', ')
    const err = new Error(
      tailTypes
        ? `容器代理未返回最终结果（最后事件: ${tailTypes}）`
        : '容器代理未返回任何结果',
    )
    err.events = events
    throw err
  },

  // === Docker Agent 批量广播 ===
  async docker_agent_broadcast({ nodeId, containerIds, message, timeout = DOCKER_TASK_TIMEOUT_MS } = {}) {
    if (!containerIds || !containerIds.length) throw new Error('缺少 containerIds')
    if (!message) throw new Error('缺少 message')

    const cmd = { cmd: 'task.run', message, timeout }
    const results = await Promise.allSettled(
      containerIds.map(cid =>
        handlers.docker_agent({ nodeId, containerId: cid, cmd })
          .then(r => ({ containerId: cid, ...r }))
      )
    )

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return { containerId: containerIds[i], ok: false, error: r.reason?.message || '未知错误' }
    })
  },

  // === 异步任务派发（非阻塞，立即返回 taskId） ===
  async docker_dispatch_task({ nodeId, containerId, containerName, message, timeout = DOCKER_TASK_TIMEOUT_MS } = {}) {
    if (!containerId) throw new Error('缺少 containerId')
    if (!message) throw new Error('缺少 message')

    const task = createTask(containerId, containerName, nodeId, message)
    console.log(`[dispatch] 任务已派发 → ${task.containerName} (${task.id})`)

    // 后台异步执行，不阻塞返回
    const cmd = { cmd: 'task.run', message, timeout }
    handlers.docker_agent({ nodeId, containerId, cmd })
      .then(r => {
        task.status = 'completed'
        task.result = r
        task.events = r.events || []
        task.completedAt = Date.now()
        console.log(`[dispatch] 任务完成 ✓ ${task.containerName} (${task.id}) — ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`)
      })
      .catch(e => {
        task.status = 'error'
        task.error = e.message || String(e)
        task.events = e.events || []
        task.completedAt = Date.now()
        console.error(`[dispatch] 任务失败 ✗ ${task.containerName} (${task.id}): ${task.error}`)
      })

    return { taskId: task.id, containerId, containerName: task.containerName, status: 'running' }
  },

  // 批量异步派发（多个容器）
  async docker_dispatch_broadcast({ nodeId, targets, message, timeout = DOCKER_TASK_TIMEOUT_MS } = {}) {
    if (!targets || !targets.length) throw new Error('缺少 targets')
    if (!message) throw new Error('缺少 message')

    const taskIds = []
    for (const t of targets) {
      const result = await handlers.docker_dispatch_task({
        nodeId: t.nodeId || nodeId,
        containerId: t.containerId,
        containerName: t.containerName,
        message,
        timeout,
      })
      taskIds.push(result)
    }
    return taskIds
  },

  // 查询单个任务状态
  docker_task_status({ taskId } = {}) {
    if (!taskId) throw new Error('缺少 taskId')
    const task = _taskStore.get(taskId)
    if (!task) throw new Error('任务不存在')
    return {
      id: task.id,
      containerId: task.containerId,
      containerName: task.containerName,
      message: task.message,
      status: task.status,
      result: task.result,
      error: task.error,
      events: task.events,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      elapsed: task.completedAt ? task.completedAt - task.startedAt : Date.now() - task.startedAt,
    }
  },

  // 查询所有任务列表
  docker_task_list({ containerId, status } = {}) {
    let tasks = [..._taskStore.values()]
    if (containerId) tasks = tasks.filter(t => t.containerId === containerId)
    if (status) tasks = tasks.filter(t => t.status === status)
    // 按时间倒序
    tasks.sort((a, b) => b.startedAt - a.startedAt)
    return tasks.map(t => ({
      id: t.id,
      containerId: t.containerId,
      containerName: t.containerName,
      message: t.message,
      status: t.status,
      error: t.error,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      elapsed: t.completedAt ? t.completedAt - t.startedAt : Date.now() - t.startedAt,
      hasResult: !!t.result,
    }))
  },

  async docker_init_worker({ nodeId, containerId, role = 'general' } = {}) {
    if (!containerId) throw new Error('缺少 containerId')
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')

    const results = { config: false, personality: false, files: [] }

    // helper: base64 encode string
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

    // helper: exec command in container
    const cExec = async (cmd) => {
      const createResp = await dockerRequest('POST', `/containers/${containerId}/exec`, {
        AttachStdout: true, AttachStderr: true, Cmd: ['sh', '-c', cmd]
      }, node.endpoint)
      if (createResp.status >= 400) throw new Error(`exec 失败: ${createResp.status}`)
      const execId = createResp.data?.Id
      if (!execId) return
      await dockerRequest('POST', `/exec/${execId}/start`, { Detach: true }, node.endpoint)
      // 给 exec 一点时间完成
      await new Promise(r => setTimeout(r, 300))
    }

    // 1. 同步 openclaw.json（模型 + API Key 配置）
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const localConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        // 只同步 OpenClaw 认识的字段，避免 Unrecognized key 导致 Gateway 崩溃
        const syncConfig = {}
        if (localConfig.meta) syncConfig.meta = localConfig.meta // 保持原始 meta，不加自定义字段
        if (localConfig.env) syncConfig.env = localConfig.env
        if (localConfig.models) {
          // 容器内 127.0.0.1/localhost 指向容器自身，需替换为 host.docker.internal 访问宿主机
          syncConfig.models = JSON.parse(JSON.stringify(localConfig.models, (k, v) => {
            if (k === 'baseUrl' && typeof v === 'string') {
              return v.replace(/\/\/127\.0\.0\.1([:/])/g, '//host.docker.internal$1')
                      .replace(/\/\/localhost([:/])/g, '//host.docker.internal$1')
            }
            return v
          }))
        }
        if (localConfig.auth) syncConfig.auth = localConfig.auth
        // Gateway 配置：只设置 controlUi（允许连接），不复制 host/bind 等本机特定字段
        syncConfig.gateway = {
          port: 18789,
          mode: 'local',
          bind: 'lan',
          auth: { mode: 'token', token: CLUSTER_TOKEN },
          controlUi: { allowedOrigins: ['*'], allowInsecureAuth: true },
        }

        const configB64 = b64(JSON.stringify(syncConfig, null, 2))
        await cExec(`mkdir -p /root/.openclaw && echo '${configB64}' | base64 -d > /root/.openclaw/openclaw.json`)
        results.config = true
        results.files.push('openclaw.json')
        console.log(`[init-worker] 配置已同步 → ${containerId.slice(0, 12)}`)
      }
    } catch (e) {
      console.warn(`[init-worker] 配置同步失败: ${e.message}`)
    }

    // 2. 注入设备配对信息（绕过 Gateway 手动配对要求）
    try {
      const { deviceId, publicKey } = getOrCreateDeviceKey()
      const platform = process.platform === 'darwin' ? 'macos' : process.platform
      const nowMs = Date.now()
      const pairedData = {}
      pairedData[deviceId] = {
        deviceId, publicKey, platform, deviceFamily: 'desktop',
        clientId: 'openclaw-control-ui', clientMode: 'ui',
        role: 'operator', roles: ['operator'],
        scopes: SCOPES, approvedScopes: SCOPES, tokens: {},
        createdAtMs: nowMs, approvedAtMs: nowMs,
      }
      const pairedB64 = b64(JSON.stringify(pairedData, null, 2))
      await cExec(`mkdir -p /root/.openclaw/devices && echo '${pairedB64}' | base64 -d > /root/.openclaw/devices/paired.json`)
      results.files.push('devices/paired.json')
      console.log(`[init-worker] 设备配对已注入 → ${containerId.slice(0, 12)}`)
    } catch (e) {
      console.warn(`[init-worker] 设备配对注入失败: ${e.message}`)
    }

    // 3. 角色性格注入（SOUL.md + IDENTITY.md + AGENTS.md）
    try {
      // 角色性格模板
      const ROLE_SOULS = {
        general: { identity: '# 龙虾步兵\n通用作战单位，隶属统帅龙虾军团', soul: '# 龙虾步兵 · 性格\n\n## 核心\n- 忠诚可靠，执行力强\n- 能处理各类任务：写作、编程、翻译、分析\n- 回复简洁专业\n- 主动报告任务进展\n\n## 边界\n- 尊重隐私，不泄露信息\n- 不确定时先询问统帅\n- 每次回复聚焦任务本身' },
        coder: { identity: '# 龙虾突击兵\n编程作战专家，隶属统帅龙虾军团', soul: '# 龙虾突击兵 · 性格\n\n## 核心\n- 精通多种编程语言和框架\n- 代码质量第一，回复包含可运行示例\n- 擅长调试、重构、Code Review\n- 主动提示潜在问题和最佳实践\n\n## 边界\n- 修改文件前先理解上下文\n- 不跳过测试\n- 不引入不必要的依赖' },
        translator: { identity: '# 龙虾翻译官\n多语言作战专家，隶属统帅龙虾军团', soul: '# 龙虾翻译官 · 性格\n\n## 核心\n- 精通中英日韩法德西等主流语言互译\n- 追求信达雅，翻译精准\n- 保留原文语境和风格\n- 对专业术语严格把关\n\n## 边界\n- 不确定的术语标注原文\n- 不过度意译\n- 保持文体一致性' },
        writer: { identity: '# 龙虾文书官\n写作任务专家，隶属统帅龙虾军团', soul: '# 龙虾文书官 · 性格\n\n## 核心\n- 文思敏捷，创意丰富\n- 能调整语气适应不同场景\n- 精通博客、技术文档、营销文案等\n- 善于讲故事，引人入胜\n\n## 边界\n- 不抄袭\n- 保持原创性\n- 注重可读性和准确性' },
        analyst: { identity: '# 龙虾参谋\n数据分析专家，隶属统帅龙虾军团', soul: '# 龙虾参谋 · 性格\n\n## 核心\n- 逻辑清晰，善用数据说话\n- 结论有理有据，给出可行建议\n- 善用图表和结构化格式呈现\n- 擅长统计分析、商业分析、竞品分析\n\n## 边界\n- 不编造数据\n- 区分相关性和因果性\n- 标注不确定性' },
        custom: { identity: '# 龙虾特种兵\n特殊任务执行者，隶属统帅龙虾军团', soul: '# 龙虾特种兵 · 性格\n\n## 核心\n- 灵活多变，适应力强\n- 按需配置技能\n- 不拘泥形式，主动寻找最优解\n\n## 边界\n- 行动前确认方向\n- 不超出授权范围' },
      }

      const roleSoul = ROLE_SOULS[role] || ROLE_SOULS.general

      // 每个兵种独立的 AGENTS.md（操作指令）
      const ROLE_AGENTS = {
        general: '# 操作指令\n\n你是龙虾军团的步兵，接受统帅通过 ClawPanel 下达的任务指令。\n\n## 规则\n- 收到任务后立即执行，完成后简要汇报结果\n- 如果任务不清楚，先确认再行动\n- 保持回复简洁，重点突出\n- 你有独立的记忆空间，会自动记录重要信息',
        coder: '# 操作指令\n\n你是龙虾军团的突击兵，专精编程作战。\n\n## 规则\n- 收到编程任务后，先分析需求再写代码\n- 代码必须可运行，包含必要的注释\n- 主动进行错误处理和边界检查\n- 如果涉及多个文件，说明修改顺序\n- 完成后给出测试建议\n\n## 专长\n- 全栈开发、API 设计、数据库优化\n- Bug 定位与修复、代码重构\n- 性能优化、安全审计',
        translator: '# 操作指令\n\n你是龙虾军团的翻译官，专精多语言互译。\n\n## 规则\n- 翻译要信达雅，保持原文风格\n- 专业术语保留原文标注\n- 长文分段翻译，保持上下文一致\n- 文学作品注重意境传达\n- 技术文档注重准确性\n\n## 专长\n- 中英日韩法德西等主流语言\n- 技术文档、文学作品、商务邮件',
        writer: '# 操作指令\n\n你是龙虾军团的文书官，专精写作任务。\n\n## 规则\n- 根据场景调整语气和风格\n- 注重结构清晰、逻辑连贯\n- 创意写作要有个性和亮点\n- 技术文档要准确严谨\n- 营销文案要抓住痛点\n\n## 专长\n- 博客文章、技术文档、营销文案\n- 故事创作、剧本、诗歌\n- SEO 优化、社交媒体内容',
        analyst: '# 操作指令\n\n你是龙虾军团的参谋，专精数据分析和战略规划。\n\n## 规则\n- 用数据说话，结论必须有依据\n- 区分事实、推断和假设\n- 善用表格和结构化格式呈现\n- 给出可执行的建议\n- 标注不确定性和风险\n\n## 专长\n- 市场分析、竞品研究、用户画像\n- 数据可视化、统计分析\n- 商业计划、策略建议',
        custom: '# 操作指令\n\n你是龙虾军团的特种兵，执行特殊任务。\n\n## 规则\n- 灵活应对各类非标准任务\n- 行动前确认方向\n- 不超出授权范围\n- 主动寻找最优解决方案',
      }

      const wsFiles = {
        'SOUL.md': roleSoul.soul,
        'IDENTITY.md': roleSoul.identity,
        'AGENTS.md': ROLE_AGENTS[role] || ROLE_AGENTS.general,
      }

      // 写入兵种专属文件（不复制本机的 TOOLS.md/USER.md/记忆，每个士兵独立发展）
      await cExec('mkdir -p /root/.openclaw/workspace')
      for (const [fname, content] of Object.entries(wsFiles)) {
        const encoded = b64(content)
        await cExec(`echo '${encoded}' | base64 -d > /root/.openclaw/workspace/${fname}`)
        results.files.push(`workspace/${fname}`)
      }
      results.personality = true
      console.log(`[init-worker] 兵种配置注入完成 (${role}) → ${containerId.slice(0, 12)}`)
    } catch (e) {
      console.warn(`[init-worker] 兵种配置注入失败: ${e.message}`)
    }

    // 4.5 注入 ClawPanel Agent（容器内专属控制代理）
    try {
      await injectAgentToContainer(containerId, node.endpoint, cExec)
      results.files.push('clawpanel-agent.cjs')
    } catch (e) {
      console.warn(`[init-worker] Agent 注入失败: ${e.message}`)
    }

    // 5. 重启 Gateway
    try {
      // 停止旧 Gateway
      await cExec('pkill -f openclaw-gateway 2>/dev/null; pkill -f "openclaw gateway" 2>/dev/null; sleep 1')
      // 启动新 Gateway — 作为独立 Detach exec 的主进程（不能 nohup &，shell 退出会 SIGTERM 杀子进程）
      // --force 确保端口被占用时也能启动
      await cExec('mkdir -p /root/.openclaw/logs && exec openclaw gateway --force >> /root/.openclaw/logs/gateway.log 2>&1')
      console.log(`[init-worker] Gateway 已重启 → ${containerId.slice(0, 12)}`)
    } catch (e) {
      console.warn(`[init-worker] Gateway 重启失败: ${e.message}`)
    }

    return results
  },

  async docker_container_exec({ nodeId, containerId, cmd } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    if (!containerId) throw new Error('缺少 containerId')
    if (!cmd || !Array.isArray(cmd)) throw new Error('cmd 必须是字符串数组')
    // Step 1: 创建 exec 实例
    const createResp = await dockerRequest('POST', `/containers/${containerId}/exec`, {
      AttachStdout: true, AttachStderr: true, Cmd: cmd
    }, node.endpoint)
    if (createResp.status >= 400) throw new Error(`exec 创建失败: ${JSON.stringify(createResp.data)}`)
    const execId = createResp.data?.Id
    if (!execId) throw new Error('exec 创建失败: 无 ID')
    // Step 2: 启动 exec
    const startResp = await dockerRequest('POST', `/exec/${execId}/start`, { Detach: true }, node.endpoint)
    if (startResp.status >= 400) throw new Error(`exec 启动失败: ${JSON.stringify(startResp.data)}`)
    return { ok: true, execId }
  },

  async docker_container_logs({ nodeId, containerId, tail = 200 } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('GET', `/containers/${containerId}/logs?stdout=true&stderr=true&tail=${tail}`, null, node.endpoint)
    // Docker logs 返回带 stream header 的原始字节，简单清理
    let logs = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
    // 去除 Docker stream 帧头（每 8 字节一个 header）
    logs = logs.replace(/[\x00-\x08]/g, '').replace(/\r/g, '')
    return logs
  },

  async docker_pull_image({ nodeId, image, tag = 'latest', requestId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const baseImage = image || defaultDockerImage()
    const imgFull = `${baseImage}:${tag}`
    const rid = requestId || `pull-${Date.now()}`
    _pullProgress.set(rid, { status: 'connecting', image: imgFull, layers: {}, message: '连接 Docker...', percent: 0 })
    const endpoint = normalizeDockerEndpoint(node.endpoint) || defaultDockerEndpoint()
    const apiPath = `/images/create?fromImage=${encodeURIComponent(baseImage)}&tag=${tag}`
    try {
      await new Promise((resolve, reject) => {
        const opts = { path: apiPath, method: 'POST', headers: { 'Content-Type': 'application/json' } }
        if (endpoint && endpoint.startsWith('tcp://')) {
          const url = new URL(endpoint.replace('tcp://', 'http://'))
          opts.hostname = url.hostname
          opts.port = parseInt(url.port) || 2375
        } else {
          opts.socketPath = endpoint
        }
        const req = http.request(opts, (res) => {
          if (res.statusCode !== 200) {
            let errData = ''
            res.on('data', chunk => errData += chunk)
            res.on('end', () => {
              const err = (() => { try { return JSON.parse(errData).message } catch { return `HTTP ${res.statusCode}` } })()
              _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'error', message: err })
              reject(new Error(err))
            })
            return
          }
          _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'pulling', message: '正在拉取镜像层...' })
          let lastError = null
          res.on('data', (chunk) => {
            const text = chunk.toString()
            for (const line of text.split('\n').filter(Boolean)) {
              try {
                const obj = JSON.parse(line)
                if (obj.error) { lastError = obj.error; continue }
                const p = _pullProgress.get(rid)
                if (obj.id && obj.progressDetail) {
                  p.layers[obj.id] = {
                    status: obj.status || '',
                    current: obj.progressDetail.current || 0,
                    total: obj.progressDetail.total || 0,
                  }
                }
                if (obj.status) p.message = obj.id ? `${obj.id}: ${obj.status}` : obj.status
                // 计算总体进度
                const layers = Object.values(p.layers)
                if (layers.length > 0) {
                  const totalBytes = layers.reduce((s, l) => s + (l.total || 0), 0)
                  const currentBytes = layers.reduce((s, l) => s + (l.current || 0), 0)
                  p.percent = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0
                  p.layerCount = layers.length
                  p.completedLayers = layers.filter(l => l.status === 'Pull complete' || l.status === 'Already exists').length
                }
                _pullProgress.set(rid, p)
              } catch {}
            }
          })
          res.on('end', () => {
            if (lastError) {
              _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'error', message: lastError })
              reject(new Error(lastError))
            } else {
              _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'done', message: '拉取完成', percent: 100 })
              resolve()
            }
          })
        })
        req.on('error', (e) => {
          _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'error', message: e.message })
          reject(new Error('Docker 连接失败: ' + e.message))
        })
        req.setTimeout(600000, () => {
          _pullProgress.set(rid, { ..._pullProgress.get(rid), status: 'error', message: '超时' })
          req.destroy()
          reject(new Error('镜像拉取超时（10分钟）'))
        })
        req.end()
      })
    } finally {
      // 30秒后清理进度数据
      setTimeout(() => _pullProgress.delete(rid), 30000)
    }
    return { message: `镜像 ${imgFull} 拉取完成`, requestId: rid }
  },

  docker_pull_status({ requestId } = {}) {
    if (!requestId) return { status: 'unknown' }
    return _pullProgress.get(requestId) || { status: 'unknown' }
  },

  async docker_list_images({ nodeId } = {}) {
    const nodes = readDockerNodes()
    const node = nodeId ? nodes.find(n => n.id === nodeId) : nodes[0]
    if (!node) throw new Error('节点不存在')
    const resp = await dockerRequest('GET', '/images/json', null, node.endpoint)
    if (resp.status !== 200) throw new Error('获取镜像列表失败')
    return (resp.data || [])
      .filter(img => (img.RepoTags || []).some(t => t.includes('openclaw')))
      .map(img => ({
        id: img.Id?.replace('sha256:', '').slice(0, 12),
        tags: img.RepoTags || [],
        size: img.Size,
        created: img.Created,
      }))
  },

  // Docker 节点管理
  docker_list_nodes() {
    return readDockerNodes()
  },

  async docker_add_node({ name, endpoint }) {
    if (!name || !endpoint) throw new Error('节点名称和地址不能为空')
    const normalizedEndpoint = normalizeDockerEndpoint(endpoint)
    if (!normalizedEndpoint) throw new Error('Docker 节点地址格式无效')
    // 验证连接
    try {
      await dockerRequest('GET', '/info', null, normalizedEndpoint)
    } catch (e) {
      throw new Error(`无法连接到 ${endpoint}: ${e.message}`)
    }
    const nodes = readDockerNodes()
    const id = 'node-' + Date.now().toString(36)
    const type = normalizedEndpoint.startsWith('tcp://') ? 'tcp' : 'socket'
    nodes.push({ id, name, type, endpoint: normalizedEndpoint })
    saveDockerNodes(nodes)
    return { id, name, type, endpoint: normalizedEndpoint }
  },

  docker_remove_node({ nodeId }) {
    if (nodeId === 'local') throw new Error('不能删除本机节点')
    const nodes = readDockerNodes().filter(n => n.id !== nodeId)
    saveDockerNodes(nodes)
    return true
  },

  // 集群概览（聚合所有节点）
  async docker_cluster_overview() {
    const nodes = readDockerNodes()
    const results = []
    for (const node of nodes) {
      try {
        const infoResp = await dockerRequest('GET', '/info', null, node.endpoint)
        const ctResp = await dockerRequest('GET', '/containers/json?all=true', null, node.endpoint)
        const containers = (ctResp.data || []).map(c => ({
          id: c.Id?.slice(0, 12),
          name: (c.Names?.[0] || '').replace(/^\//, ''),
          image: c.Image, state: c.State, status: c.Status,
          ports: (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}` : `${p.PrivatePort}`).join(', '),
        }))
        const d = infoResp.data || {}
        results.push({
          ...node, online: true,
          dockerVersion: d.ServerVersion, os: d.OperatingSystem,
          cpus: d.NCPU, memory: d.MemTotal,
          totalContainers: d.Containers, runningContainers: d.ContainersRunning,
          stoppedContainers: d.ContainersStopped,
          containers,
        })
      } catch (e) {
        results.push({ ...node, online: false, error: e.message, containers: [] })
      }
    }
    return results
  },

  // 部署模式检测
  get_deploy_mode() {
    const inDocker = fs.existsSync('/.dockerenv') || (process.env.CLAWPANEL_MODE === 'docker')
    const dockerAvailable = isDockerAvailable()
    return { inDocker, dockerAvailable, mode: inDocker ? 'docker' : 'local' }
  },

  // 安装检测
  check_installation() {
    const inDocker = fs.existsSync('/.dockerenv')
    return { installed: fs.existsSync(CONFIG_PATH), path: OPENCLAW_DIR, platform: isMac ? 'macos' : process.platform, inDocker }
  },

  check_git() {
    const { gitPath, isCustom, result } = runGitSync(['--version'], { timeout: 5000 })
    const detectedPath = isCustom ? gitPath : findCommandPath('git')
    try {
      if (result?.error || result?.status !== 0) throw new Error(result?.error?.message || result?.stderr || result?.stdout || 'git not found')
      const ver = String(result.stdout || result.stderr || '').trim()
      const match = ver.match(/(\d+\.\d+[\.\d]*)/)
      return { installed: true, version: match ? match[1] : ver, path: detectedPath, isCustom }
    } catch {
      return { installed: false, version: null, path: detectedPath, isCustom }
    }
  },

  auto_install_git() {
    // Web 模式下不自动安装系统软件，返回指引
    throw new Error('Web 部署模式下请手动安装 Git：\n- Ubuntu/Debian: sudo apt install git\n- CentOS/RHEL: sudo yum install git\n- macOS: xcode-select --install')
  },

  configure_git_https() {
    try {
      const success = configureGitHttpsRules()
      if (!success) throw new Error('Git 未安装或写入失败')
      return `已配置 Git HTTPS 替代 SSH（${success}/${GIT_HTTPS_REWRITES.length} 条规则）`
    } catch (e) {
      throw new Error('配置失败: ' + (e.message || e))
    }
  },

  guardian_status() {
    // Web 模式没有 Guardian 守护进程
    return { enabled: false, giveUp: false }
  },

  invalidate_path_cache() {
    return true
  },

  check_node() {
    try {
      const ver = execSync('node --version 2>&1', { windowsHide: true }).toString().trim()
      return { installed: true, version: ver, path: findCommandPath('node') }
    } catch {
      return { installed: false, version: null, path: null }
    }
  },

  // 运行时状态摘要（轻量实现：直接读 openclaw.json + 端口检测，不 spawn CLI 进程）
  // ARM 设备上 `openclaw status --json` 是最大 CPU 消耗源（每次 spawn ~380M Node.js 进程）
  get_status_summary() {
    return serverCached('status_summary', 60000, () => {
      try {
        if (!fs.existsSync(CONFIG_PATH)) return { error: 'openclaw.json 不存在' }
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        const channels = cfg.channels || {}
        const channelSummary = Object.entries(channels).map(([id, val]) =>
          `${id}: ${val?.enabled !== false ? 'configured' : 'disabled'}`
        )
        const agents = cfg.agents?.list || []
        const defaultModel = cfg.agents?.defaults?.model?.primary || ''
        const version = (() => {
          // 尝试读取本地安装的 package.json 获取版本号（不 spawn CLI）
          try {
            for (const pkgName of ['@qingchencloud/openclaw-zh', 'openclaw']) {
              const winNodeModules = readWindowsNpmGlobalPrefix()
                ? [path.join(readWindowsNpmGlobalPrefix(), 'node_modules')]
                : [path.join(process.env.APPDATA || '', 'npm', 'node_modules')]
              const candidates = isMac
                ? ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
                : isWindows
                  ? winNodeModules
                  : ['/usr/local/lib/node_modules']
              for (const base of candidates) {
                const pkgJson = path.join(base, pkgName, 'package.json')
                if (fs.existsSync(pkgJson)) {
                  return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version || null
                }
              }
            }
          } catch {}
          return null
        })()
        return {
          runtimeVersion: version,
          heartbeat: {
            defaultAgentId: 'main',
            agents: [
              { agentId: 'main', enabled: true },
              ...agents.map(a => ({ agentId: a.id || a, enabled: true }))
            ]
          },
          channelSummary,
          sessions: {
            defaults: { model: defaultModel }
          },
          source: 'file-read'
        }
      } catch (e) {
        return { error: e.message || String(e) }
      }
    })
  },

  // 版本信息
  async get_version_info() {
    let source = detectInstalledSource()
    const current = getLocalOpenclawVersion()
    // 兜底：版本号含 -zh 则一定是汉化版
    if (current && current.includes('-zh') && source !== 'chinese') source = 'chinese'
    const cli_path = resolveOpenclawCliPath()
    const cli_source = classifyCliSource(cli_path) || null
    if (source === 'unknown') {
      const cliInstallSource = normalizeCliInstallSource(cli_source)
      if (cliInstallSource !== 'unknown') source = cliInstallSource
    }
    const latest = source === 'unknown' ? null : await getLatestVersionFor(source)
    const recommended = source === 'unknown' ? null : recommendedVersionFor(source)
    const all_installations = scanAllOpenclawInstallations(cli_path)

    return {
      current,
      latest,
      recommended,
      update_available: current && recommended ? recommendedIsNewer(recommended, current) : !!recommended,
      latest_update_available: current && latest ? recommendedIsNewer(latest, current) : !!latest,
      is_recommended: !!current && !!recommended && versionsMatch(current, recommended),
      ahead_of_recommended: !!current && !!recommended && recommendedIsNewer(current, recommended),
      panel_version: PANEL_VERSION,
      source,
      cli_path,
      cli_source,
      all_installations
    }
  },

  // 模型测试
  async test_model({ baseUrl, apiKey, modelId, apiType = 'openai-completions' }) {
    const type = ['anthropic', 'anthropic-messages'].includes(apiType) ? 'anthropic-messages'
      : apiType === 'google-gemini' ? 'google-gemini'
      : 'openai-completions'
    let base = _normalizeBaseUrl(baseUrl)
    // 仅 Anthropic 强制补 /v1，OpenAI 兼容类不强制（火山引擎等用 /v3）
    if (type === 'anthropic-messages' && !/\/v1$/i.test(base)) base += '/v1'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      let resp
      if (type === 'anthropic-messages') {
        const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
        if (apiKey) headers['x-api-key'] = apiKey
        resp = await fetch(`${base}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 16,
          }),
          signal: controller.signal
        })
      } else if (type === 'google-gemini') {
        resp = await fetch(`${base}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey || '')}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }),
          signal: controller.signal
        })
      } else {
        const headers = { 'Content-Type': 'application/json' }
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        resp = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 16,
            stream: false
          }),
          signal: controller.signal
        })
      }
      clearTimeout(timeout)
      if (!resp.ok) {
        const text = await resp.text()
        let msg = `HTTP ${resp.status}`
        try {
          const parsed = JSON.parse(text)
          msg = parsed.error?.message || parsed.message || msg
        } catch {}
        if (resp.status === 401 || resp.status === 403) throw new Error(msg)
        return `⚠ 连接正常（API 返回 ${resp.status}，部分模型对简单测试不兼容，不影响实际使用）`
      }
      const data = await resp.json()
      const anthropicText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      const geminiText = data.candidates?.[0]?.content?.parts?.map?.(p => p.text).filter(Boolean).join('') || ''
      const content = data.choices?.[0]?.message?.content
      const reasoning = data.choices?.[0]?.message?.reasoning_content
      return anthropicText || geminiText || content || (reasoning ? `[reasoning] ${reasoning}` : '（无回复内容）')
    } catch (e) {
      clearTimeout(timeout)
      if (e.name === 'AbortError') throw new Error('请求超时 (30s)')
      throw e
    }
  },

  async list_remote_models({ baseUrl, apiKey, apiType = 'openai-completions' }) {
    const type = ['anthropic', 'anthropic-messages'].includes(apiType) ? 'anthropic-messages'
      : apiType === 'google-gemini' ? 'google-gemini'
      : 'openai-completions'
    let base = _normalizeBaseUrl(baseUrl)
    // 仅 Anthropic 强制补 /v1，OpenAI 兼容类不强制（火山引擎等用 /v3）
    if (type === 'anthropic-messages' && !/\/v1$/i.test(base)) base += '/v1'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      let resp
      if (type === 'anthropic-messages') {
        const headers = { 'anthropic-version': '2023-06-01' }
        if (apiKey) headers['x-api-key'] = apiKey
        resp = await fetch(`${base}/models`, { headers, signal: controller.signal })
      } else if (type === 'google-gemini') {
        resp = await fetch(`${base}/models?key=${encodeURIComponent(apiKey || '')}`, { signal: controller.signal })
      } else {
        const headers = {}
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        resp = await fetch(`${base}/models`, { headers, signal: controller.signal })
      }
      clearTimeout(timeout)
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        let msg = `HTTP ${resp.status}`
        try {
          const parsed = JSON.parse(text)
          msg = parsed.error?.message || parsed.message || msg
        } catch {}
        throw new Error(msg)
      }
      const data = await resp.json()
      const ids = (data.data || []).map(m => m.id)
        .concat((data.models || []).map(m => (m.name || '').replace(/^models\//, '')))
        .filter(Boolean)
        .sort()
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
    // 从 openclaw.json 的 agents.list[] 读取完整配置
    const cfg = readOpenclawConfigOptional()
    const agentsList = Array.isArray(cfg.agents?.list) ? cfg.agents.list : []
    const defaults = cfg.agents?.defaults || {}

    if (agentsList.length === 0) {
      // 无 agents.list 配置 → 回退扫描目录模式
      const result = [{ id: 'main', isDefault: true, identityName: null, identityEmoji: null, model: null, workspace: resolveDefaultWorkspace(cfg) }]
      const agentsDir = path.join(OPENCLAW_DIR, 'agents')
      if (fs.existsSync(agentsDir)) {
        try {
          for (const entry of fs.readdirSync(agentsDir)) {
            if (entry === 'main') continue
            const p = path.join(agentsDir, entry)
            if (fs.statSync(p).isDirectory()) {
              result.push({ id: entry, isDefault: false, identityName: null, identityEmoji: null, model: null, workspace: path.join(agentsDir, entry, 'workspace') })
            }
          }
        } catch {}
      }
      return result
    }

    // 从 agents.list[] 读取
    const hasMain = agentsList.some(a => (a?.id || 'main').trim() === 'main')
    const allAgents = hasMain
      ? agentsList
      : [{ id: 'main', default: true, workspace: resolveDefaultWorkspace(cfg) }, ...agentsList]

    return allAgents.filter(a => a && typeof a === 'object').map((a, idx) => {
      const id = (a.id || 'main').trim()
      const isDefault = a.default === true || id === 'main' || (idx === 0 && !allAgents.some(x => x.default === true))
      // 模型：可以是 string 或 { primary, fallbacks }
      let model = a.model || defaults.model || null
      if (model && typeof model === 'object') model = model.primary || JSON.stringify(model)
      return {
        id,
        isDefault,
        identityName: a.identity?.name || a.name || null,
        identityEmoji: a.identity?.emoji || null,
        model,
        workspace: expandHomePath(a.workspace) || resolveAgentWorkspace(cfg, id),
        thinkingDefault: a.thinkingDefault || defaults.thinkingDefault || null,
      }
    })
  },

  // Agent 详情（完整配置）
  get_agent_detail({ id }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const defaults = cfg.agents?.defaults || {}
    const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : []

    // 查找 agent 配置
    let agent = findAgentConfig(cfg, id)
    if (!agent && id === 'main') {
      // main agent 可能不在 list 中
      agent = { id: 'main', default: true }
    }
    if (!agent) throw new Error(`Agent "${id}" 不存在`)

    // 解析工作区路径
    const actualWorkspace = resolveAgentWorkspace(cfg, id)

    // 获取绑定
    const agentBindings = bindings.filter(b => (b.agentId || 'main') === id)

    return {
      id,
      isDefault: agent.default === true || id === 'main',
      name: agent.name || null,
      identity: agent.identity || null,
      model: agent.model || defaults.model || null,
      workspace: actualWorkspace,
      workspaceRaw: agent.workspace || null,
      thinkingDefault: agent.thinkingDefault || defaults.thinkingDefault || null,
      reasoningDefault: agent.reasoningDefault || defaults.reasoningDefault || null,
      fastModeDefault: agent.fastModeDefault ?? null,
      skills: agent.skills || null,
      heartbeat: agent.heartbeat || null,
      groupChat: agent.groupChat || null,
      subagents: agent.subagents || null,
      sandbox: agent.sandbox || null,
      tools: agent.tools || null,
      params: agent.params || null,
      runtime: agent.runtime || null,
      bindings: agentBindings,
      defaults,
    }
  },

  // Agent 工作区文件列表
  list_agent_files({ id }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const workspaceDir = resolveAgentWorkspace(cfg, id)

    // Bootstrap 文件列表
    const BOOTSTRAP_FILES = [
      { name: 'AGENTS.md', desc: 'Agent 规则' },
      { name: 'SOUL.md', desc: '灵魂/人格' },
      { name: 'TOOLS.md', desc: '工具白名单' },
      { name: 'IDENTITY.md', desc: '身份信息' },
      { name: 'USER.md', desc: '用户上下文' },
      { name: 'HEARTBEAT.md', desc: '心跳指令' },
      { name: 'BOOTSTRAP.md', desc: '初始化引导' },
      { name: 'MEMORY.md', desc: '记忆存储' },
    ]

    return BOOTSTRAP_FILES.map(f => {
      const filePath = path.join(workspaceDir, f.name)
      const exists = fs.existsSync(filePath)
      let size = 0, mtime = null
      if (exists) {
        try {
          const stat = fs.statSync(filePath)
          size = stat.size
          mtime = stat.mtime.toISOString()
        } catch {}
      }
      return { name: f.name, desc: f.desc, exists, size, mtime, path: filePath }
    })
  },

  // 读取 Agent 工作区文件
  read_agent_file({ id, name }) {
    if (!id) throw new Error('Agent ID 不能为空')
    if (!name) throw new Error('文件名不能为空')
    // 安全性：只允许读取预定义的 bootstrap 文件
    const ALLOWED = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md']
    if (!ALLOWED.includes(name)) throw new Error('不允许读取此文件')

    const cfg = readOpenclawConfigOptional()
    const workspaceDir = resolveAgentWorkspace(cfg, id)

    const filePath = path.join(workspaceDir, name)
    if (!fs.existsSync(filePath)) return { exists: false, content: '' }
    return { exists: true, content: fs.readFileSync(filePath, 'utf8') }
  },

  // 写入 Agent 工作区文件
  write_agent_file({ id, name, content }) {
    if (!id) throw new Error('Agent ID 不能为空')
    if (!name) throw new Error('文件名不能为空')
    const ALLOWED = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md']
    if (!ALLOWED.includes(name)) throw new Error('不允许写入此文件')
    if (typeof content !== 'string') throw new Error('内容必须是字符串')

    const cfg = readOpenclawConfigOptional()
    const workspaceDir = resolveAgentWorkspace(cfg, id)

    // 确保目录存在
    if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, name), content, 'utf8')
    return { ok: true }
  },

  get_agent_workspace_info({ id }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const workspaceDir = resolveAgentWorkspace(cfg, id)
    return {
      agentId: id,
      workspacePath: workspaceDir,
      exists: fs.existsSync(workspaceDir),
      isDefault: id === 'main',
    }
  },

  list_agent_workspace_entries({ id, relativePath }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const { root, fullPath } = resolveAgentWorkspaceChild(cfg, id, relativePath || '')
    if (!fs.existsSync(root)) return []
    if (!fs.existsSync(fullPath)) throw new Error('目录不存在')
    const stat = fs.statSync(fullPath)
    if (!stat.isDirectory()) throw new Error('目标不是目录')

    return fs.readdirSync(fullPath, { withFileTypes: true })
      .map(entry => {
        const absPath = path.join(fullPath, entry.name)
        const meta = fs.statSync(absPath)
        const isDir = meta.isDirectory()
        return {
          name: entry.name,
          relativePath: toWorkspaceRelativePath(root, absPath),
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : meta.size,
          mtime: meta.mtime?.toISOString?.() || null,
          editable: !isDir && isWorkspaceTextFile(absPath),
          previewable: !isDir && isWorkspacePreviewableFile(absPath),
        }
      })
      .sort((a, b) => {
        const rankA = a.type === 'dir' ? 0 : 1
        const rankB = b.type === 'dir' ? 0 : 1
        return rankA - rankB || a.name.localeCompare(b.name)
      })
  },

  read_agent_workspace_file({ id, relativePath }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const { relativePath: normalized, fullPath } = resolveAgentWorkspaceChild(cfg, id, relativePath || '')
    if (!normalized) throw new Error('文件路径不能为空')
    if (!fs.existsSync(fullPath)) throw new Error('文件不存在')
    const stat = fs.statSync(fullPath)
    if (!stat.isFile()) throw new Error('目标不是文件')
    if (stat.size > MAX_WORKSPACE_FILE_SIZE) throw new Error('文件过大，暂不支持在面板中打开')
    const buffer = fs.readFileSync(fullPath)
    if (looksBinaryBuffer(buffer)) throw new Error('暂不支持在面板中打开二进制文件')
    return {
      relativePath: normalized,
      path: fullPath,
      size: stat.size,
      mtime: stat.mtime?.toISOString?.() || null,
      editable: true,
      previewable: isWorkspacePreviewableFile(fullPath),
      content: buffer.toString('utf8'),
    }
  },

  write_agent_workspace_file({ id, relativePath, content }) {
    if (!id) throw new Error('Agent ID 不能为空')
    if (typeof content !== 'string') throw new Error('内容必须是字符串')
    const cfg = readOpenclawConfigOptional()
    const { relativePath: normalized, fullPath } = resolveAgentWorkspaceChild(cfg, id, relativePath || '')
    if (!normalized) throw new Error('文件路径不能为空')
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
    return { ok: true, relativePath: normalized, size: Buffer.byteLength(content, 'utf8') }
  },

  // 更新 Agent 概览配置（写入 openclaw.json agents.list[]）
  update_agent_config({ id, config }) {
    if (!id) throw new Error('Agent ID 不能为空')
    if (!config || typeof config !== 'object') throw new Error('配置不能为空')
    const cfg = readOpenclawConfigRequired()
    const agentsList = ensureAgentsList(cfg)

    let agentIdx = agentsList.findIndex(a => (a.id || 'main').trim() === id)
    if (agentIdx < 0 && id === 'main') {
      // main agent 不存在则创建
      agentsList.unshift({ id: 'main' })
      agentIdx = 0
    }
    if (agentIdx < 0) throw new Error(`Agent "${id}" 不存在于配置中`)

    const agent = agentsList[agentIdx]

    // 合并允许修改的字段
    if (config.name !== undefined) {
      if (config.name == null || config.name === '') delete agent.name
      else agent.name = config.name
    }
    if (config.identity !== undefined) {
      if (config.identity == null) {
        delete agent.identity
      } else {
        if (!agent.identity || typeof agent.identity !== 'object') agent.identity = {}
        if (config.identity.name !== undefined) {
          if (config.identity.name == null || config.identity.name === '') delete agent.identity.name
          else agent.identity.name = config.identity.name
        }
        if (config.identity.emoji !== undefined) {
          if (config.identity.emoji == null || config.identity.emoji === '') delete agent.identity.emoji
          else agent.identity.emoji = config.identity.emoji
        }
        if (!Object.keys(agent.identity).length) delete agent.identity
      }
    }
    if (config.model !== undefined) {
      if (config.model == null) delete agent.model
      else agent.model = config.model
    }
    if (config.thinkingDefault !== undefined) {
      if (config.thinkingDefault == null || config.thinkingDefault === '') delete agent.thinkingDefault
      else agent.thinkingDefault = config.thinkingDefault
    }
    if (config.reasoningDefault !== undefined) {
      if (config.reasoningDefault == null || config.reasoningDefault === '') delete agent.reasoningDefault
      else agent.reasoningDefault = config.reasoningDefault
    }
    if (config.skills !== undefined) {
      if (config.skills == null) delete agent.skills
      else agent.skills = config.skills
    }
    if (config.tools !== undefined) {
      if (config.tools == null) delete agent.tools
      else agent.tools = config.tools
    }

    // 写入
    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('update_agent_config')
    return { ok: true }
  },

  // Agent 渠道绑定管理
  list_all_bindings() {
    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
    const bindings = cfg.bindings || []
    return { bindings }
  },

  save_agent_binding({ agentId, channel, accountId, bindingConfig }) {
    const cfg = readOpenclawConfigOptional()
    if (!cfg.bindings) cfg.bindings = []
    const bindings = cfg.bindings

    const targetMatch = buildBindingMatch(channel, accountId, bindingConfig)
    const newBinding = {
      type: 'route',
      agentId,
      match: targetMatch,
    }

    let found = false
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i]
      if (bindingIdentityMatches(b, agentId, targetMatch)) {
        bindings[i] = newBinding
        found = true
        break
      }
    }
    if (!found) {
      bindings.push(newBinding)
    }

    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('save_agent_binding')
    return { ok: true }
  },

  delete_agent_binding({ agentId, channel, accountId, bindingConfig }) {
    const cfg = readOpenclawConfigOptional()
    if (!cfg.bindings) cfg.bindings = []
    const bindings = cfg.bindings
    const targetMatch = buildBindingMatch(channel, accountId, bindingConfig)

    const before = bindings.length
    cfg.bindings = bindings.filter(b => !bindingIdentityMatches(b, agentId, targetMatch))

    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('delete_agent_binding')
    return { ok: true, removed: before - cfg.bindings.length }
  },

  // 记忆文件
  list_memory_files({ category, agent_id, agentId }) {
    const cfg = readOpenclawConfigOptional()
    const targetAgentId = agent_id || agentId || 'main'
    const dir = resolveMemoryDir(cfg, targetAgentId, category)
    if (!fs.existsSync(dir)) return []
    const files = []
    collectMemoryFiles(dir, dir, files, category || 'memory')
    files.sort()
    return files
  },

  read_memory_file({ path: filePath, agent_id, agentId }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const cfg = readOpenclawConfigOptional()
    const targetAgentId = agent_id || agentId || 'main'
    const full = resolveMemoryPathCandidates(cfg, targetAgentId, filePath).find(candidate => fs.existsSync(candidate))
    if (!full) return ''
    return fs.readFileSync(full, 'utf8')
  },

  write_memory_file({ path: filePath, content, category, agent_id, agentId }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const cfg = readOpenclawConfigOptional()
    const targetAgentId = agent_id || agentId || 'main'
    const full = category
      ? path.join(resolveMemoryDir(cfg, targetAgentId, category), filePath)
      : (resolveMemoryPathCandidates(cfg, targetAgentId, filePath).find(candidate => fs.existsSync(candidate))
          || path.join(resolveMemoryDir(cfg, targetAgentId, 'memory'), filePath))
    const dir = path.dirname(full)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(full, content)
    return true
  },

  delete_memory_file({ path: filePath, agent_id, agentId }) {
    if (isUnsafePath(filePath)) throw new Error('非法路径')
    const cfg = readOpenclawConfigOptional()
    const targetAgentId = agent_id || agentId || 'main'
    const full = resolveMemoryPathCandidates(cfg, targetAgentId, filePath).find(candidate => fs.existsSync(candidate))
    if (!full) return true
    if (fs.existsSync(full)) fs.unlinkSync(full)
    return true
  },

  export_memory_zip({ category, agent_id, agentId }) {
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
    writeOpenclawConfigFile(JSON.parse(fs.readFileSync(src, 'utf8')))
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
      writeOpenclawConfigFile(config)
    }
    return changed
  },

  // Gateway 安装/卸载
  install_gateway() {
    if (!resolveOpenclawCliPath()) throw new Error('openclaw CLI 未安装')
    return execOpenclawSync(['gateway', 'install'], { windowsHide: true, cwd: homedir() }, 'Gateway 服务安装失败') || 'Gateway 服务已安装'
  },

  async list_openclaw_versions({ source = 'chinese' } = {}) {
    const pkg = npmPackageName(source)
    const encodedPkg = pkg.replace('/', '%2F').replace('@', '%40')
    const firstRegistry = pickRegistryForPackage(pkg)
    const registries = [...new Set([firstRegistry, 'https://registry.npmjs.org'])]
    let lastError = null
    for (const registry of registries) {
      try {
        const resp = await fetch(`${registry}/${encodedPkg}`, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const data = await resp.json()
        const versions = Object.keys(data.versions || {})
        versions.sort((a, b) => versionCompare(b, a))
        const recommended = recommendedVersionFor(source)
        if (recommended) {
          const pos = versions.indexOf(recommended)
          if (pos >= 0) {
            versions.splice(pos, 1)
            versions.unshift(recommended)
          } else {
            versions.unshift(recommended)
          }
        }
        return versions
      } catch (e) {
        lastError = e
      }
    }
    throw new Error('查询版本失败: ' + (lastError?.message || lastError || 'unknown error'))
  },

  async upgrade_openclaw({ source = 'chinese', version, method = 'auto' } = {}) {
    const currentSource = detectInstalledSource()
    const pkg = npmPackageName(source)
    const recommended = recommendedVersionFor(source)
    const ver = version || recommended || 'latest'
    const oldPkg = npmPackageName(currentSource)
    const needUninstallOld = currentSource !== source
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    const registry = pickRegistryForPackage(pkg)
    const logs = []

    // ── standalone 安装（auto / standalone-r2 / standalone-github） ──
    const tryStandalone = source !== 'official' && ['auto', 'standalone-r2', 'standalone-github'].includes(method)
    if (tryStandalone) {
      try {
        const githubBase = method === 'standalone-github'
          ? `https://github.com/qingchencloud/openclaw-standalone/releases/download/v${ver}`
          : null
        const saResult = await _tryStandaloneInstall(ver, logs, githubBase)
        if (saResult) {
          const label = method === 'standalone-github' ? 'GitHub' : 'CDN'
          logs.push(`✅ standalone (${label}) 安装完成`)
          return logs.join('\n')
        }
      } catch (e) {
        if (method === 'auto') {
          logs.push(`standalone 不可用（${e.message}），降级到 npm 安装...`)
        } else {
          throw new Error(`standalone 安装失败: ${e.message}`)
        }
      }
    }

    // ── npm install（兜底或用户明确选择） ──

    if (!version && recommended) {
      logs.push(`ClawPanel ${PANEL_VERSION} 默认绑定 OpenClaw 稳定版: ${recommended}`)
    }
    const gitConfigured = configureGitHttpsRules()
    const gitEnv = buildGitInstallEnv()
    logs.push(`Git HTTPS 规则已就绪 (${gitConfigured}/${GIT_HTTPS_REWRITES.length})`)
    const runInstall = (targetRegistry) => execSync(
      `${npmBin} install -g ${pkg}@${ver} --force --registry ${targetRegistry} --verbose 2>&1`,
      { timeout: 120000, windowsHide: true, env: gitEnv }
    ).toString()
    try {
      let out
      try {
        out = runInstall(registry)
      } catch (e) {
        if (registry !== 'https://registry.npmjs.org') {
          logs.push('镜像源安装失败，自动切换到 npm 官方源重试...')
          out = runInstall('https://registry.npmjs.org')
        } else {
          throw e
        }
      }
      if (needUninstallOld) {
        try { execSync(`${npmBin} uninstall -g ${oldPkg} 2>&1`, { timeout: 60000, windowsHide: true }) } catch {}
      }
      logs.push(`安装完成 (${pkg}@${ver})`)
      return `${logs.join('\n')}\n${out.slice(-400)}`
    } catch (e) {
      throw new Error('安装失败: ' + (e.stderr?.toString() || e.message).slice(-300))
    }
  },

  uninstall_openclaw({ cleanConfig = false } = {}) {
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    // 清理 standalone 安装
    const saDir = standaloneInstallDir()
    if (fs.existsSync(saDir)) {
      try { fs.rmSync(saDir, { recursive: true, force: true }) } catch {}
    }
    // 清理 npm 安装
    try { execSync(`${npmBin} uninstall -g openclaw 2>&1`, { timeout: 60000, windowsHide: true }) } catch {}
    try { execSync(`${npmBin} uninstall -g @qingchencloud/openclaw-zh 2>&1`, { timeout: 60000, windowsHide: true }) } catch {}
    if (cleanConfig && fs.existsSync(OPENCLAW_DIR)) {
      try { fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true }) } catch {}
    }
    return cleanConfig ? 'OpenClaw 已完全卸载（包括配置文件）' : 'OpenClaw 已卸载（配置文件保留）'
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
    const backupPath = CONFIG_PATH + '.bak'
    if (fs.existsSync(backupPath)) {
      const backupContent = fs.readFileSync(backupPath, 'utf8')
      writeOpenclawConfigFile(JSON.parse(backupContent))
      return { created: false, restored: true, message: '已从 openclaw.json.bak 恢复配置文件' }
    }
    const defaultConfig = stripUiFields(normalizeCalibratedConfig(buildCalibrationBaseline()))
    writeOpenclawConfigFile(defaultConfig)
    return { created: true, restored: false, message: '配置文件已创建' }
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

  // Skills 管理（模拟 openclaw skills CLI JSON 输出）
  skills_list() {
    try {
      const out = execOpenclawSync(['skills', 'list', '--json'], { encoding: 'utf8', timeout: 30000, cwd: homedir(), windowsHide: true }, '读取 Skills 列表失败')
      return extractCliJson(out)
    } catch (e) {
      return scanLocalSkillsFallback(e)
    }
  },
  skills_info({ name }) {
    try {
      const out = execOpenclawSync(['skills', 'info', String(name || '').trim(), '--json'], { encoding: 'utf8', timeout: 30000, cwd: homedir(), windowsHide: true }, '查看 Skill 详情失败')
      return extractCliJson(out)
    } catch (e) {
      const fallback = scanLocalSkillsFallback(e).skills.find(skill => skill.name === String(name || '').trim())
      if (fallback) return fallback
      throw new Error('查看详情失败: ' + (e.message || e))
    }
  },
  skills_check() {
    try {
      const out = execOpenclawSync(['skills', 'check', '--json'], { encoding: 'utf8', timeout: 30000, cwd: homedir(), windowsHide: true }, '检查 Skills 依赖失败')
      return extractCliJson(out)
    } catch (e) {
      const fallback = scanLocalSkillsFallback(e)
      return {
        summary: fallback.summary,
        eligible: fallback.eligible,
        disabled: fallback.disabled,
        blocked: fallback.blocked,
        missingRequirements: fallback.missingRequirements,
      }
    }
  },
  skills_install_dep({ kind, spec }) {
    const cmds = {
      brew: `brew install ${spec?.formula || ''}`,
      node: `npm install -g ${spec?.package || ''}`,
      go: `go install ${spec?.module || ''}`,
      uv: `uv tool install ${spec?.package || ''}`,
    }
    const cmd = cmds[kind]
    if (!cmd) throw new Error(`不支持的安装类型: ${kind}`)
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 120000 })
      return { success: true, output: out.trim() }
    } catch (e) {
      throw new Error(`安装失败: ${e.message || e}`)
    }
  },
  skills_skillhub_check() {
    try {
      const out = execSync('skillhub --cli-version', { encoding: 'utf8', timeout: 5000 })
      return { installed: true, version: out.trim() }
    } catch {
      return { installed: false }
    }
  },
  skills_skillhub_setup({ cliOnly }) {
    const flag = cliOnly ? '--cli-only' : '--no-skills'
    try {
      const out = execSync(
        `curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash -s -- ${flag}`,
        { encoding: 'utf8', timeout: 120000 }
      )
      return { success: true, output: out.trim() }
    } catch (e) {
      throw new Error('SkillHub 安装失败: ' + (e.message || e))
    }
  },
  skills_skillhub_search({ query }) {
    const q = String(query || '').trim()
    if (!q) return []
    try {
      const out = execSync(`skillhub search ${JSON.stringify(q)}`, { encoding: 'utf8', timeout: 30000 })
      // 解析格式: [N]   owner/repo/name   状态\n     统计  描述...
      const lines = out.split('\n')
      const items = []
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed.startsWith('[')) continue
        const bracketEnd = trimmed.indexOf(']')
        if (bracketEnd < 0) continue
        const afterBracket = trimmed.slice(bracketEnd + 1).trim()
        const slug = (afterBracket.split(/\s/)[0] || '').trim()
        if (!slug.includes('/')) continue
        let desc = ''
        if (i + 1 < lines.length) {
          const next = lines[i + 1].trim()
          const starIdx = next.indexOf('⭐')
          if (starIdx >= 0) {
            const afterStar = next.slice(starIdx + 2).trim()
            desc = afterStar.replace(/^[\d.]+[kKmM]?\s*/, '').trim()
          }
        }
        items.push({ slug, description: desc, source: 'skillhub' })
      }
      return items
    } catch (e) {
      throw new Error('搜索失败: ' + (e.message || e) + '。请先安装 SkillHub CLI')
    }
  },
  skills_skillhub_install({ slug }) {
    const skillsDir = path.join(OPENCLAW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const out = execSync(`skillhub install ${JSON.stringify(slug)} --force`, { cwd: homedir(), encoding: 'utf8', timeout: 120000 })
      return { success: true, slug, output: out.trim() }
    } catch (e) {
      throw new Error('安装失败: ' + (e.message || e) + '。请先安装 SkillHub CLI')
    }
  },

  skills_uninstall({ name }) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('无效的 Skill 名称')
    const skillDir = path.join(OPENCLAW_DIR, 'skills', name)
    if (!fs.existsSync(skillDir)) throw new Error(`Skill「${name}」不存在`)
    fs.rmSync(skillDir, { recursive: true, force: true })
    return { success: true, name }
  },
  skills_clawhub_search({ query }) {
    const q = String(query || '').trim()
    if (!q) return []
    try {
      const out = execSync(`npx -y clawhub search ${JSON.stringify(q)}`, { encoding: 'utf8', timeout: 30000 })
      return out.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('-') && !line.startsWith('Search'))
        .map(line => {
          const parts = line.split(/\s{2,}/).filter(Boolean)
          return { slug: parts[0] || '', description: parts.slice(1).join(' ').trim(), source: 'clawhub' }
        })
        .filter(item => item.slug)
    } catch (e) {
      throw new Error('搜索失败: ' + (e.message || e))
    }
  },
  skills_clawhub_install({ slug }) {
    const skillsDir = path.join(OPENCLAW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const out = execSync(`npx -y clawhub install ${JSON.stringify(slug)}`, { cwd: homedir(), encoding: 'utf8', timeout: 120000 })
      return { success: true, slug, output: out.trim() }
    } catch (e) {
      throw new Error('安装失败: ' + (e.message || e))
    }
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

  // === AI 助手工具（Web 模式真实执行） ===

  assistant_exec({ command, cwd }) {
    if (!command) throw new Error('命令不能为空')
    // 安全限制：禁止危险命令
    const dangerous = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'format ', 'del /f /s /q C:']
    if (dangerous.some(d => command.includes(d))) throw new Error('危险命令已被拦截')
    const opts = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }
    if (cwd) opts.cwd = cwd
    try {
      const output = execSync(command, opts).toString()
      return output || '（命令已执行，无输出）'
    } catch (e) {
      const stderr = e.stderr?.toString() || ''
      const stdout = e.stdout?.toString() || ''
      return `退出码: ${e.status || 1}\n${stdout}${stderr ? '\n[stderr] ' + stderr : ''}`
    }
  },

  assistant_read_file({ path: filePath }) {
    if (!filePath) throw new Error('路径不能为空')
    const expanded = filePath.startsWith('~/') ? path.join(homedir(), filePath.slice(2)) : filePath
    if (!fs.existsSync(expanded)) throw new Error(`文件不存在: ${filePath}`)
    const stat = fs.statSync(expanded)
    if (stat.size > 1024 * 1024) throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大 1MB`)
    return fs.readFileSync(expanded, 'utf8')
  },

  assistant_write_file({ path: filePath, content }) {
    if (!filePath) throw new Error('路径不能为空')
    const expanded = filePath.startsWith('~/') ? path.join(homedir(), filePath.slice(2)) : filePath
    const dir = path.dirname(expanded)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(expanded, content || '')
    return `已写入 ${filePath} (${Buffer.byteLength(content || '', 'utf8')} 字节)`
  },

  assistant_list_dir({ path: dirPath }) {
    if (!dirPath) throw new Error('路径不能为空')
    const expanded = dirPath.startsWith('~/') ? path.join(homedir(), dirPath.slice(2)) : dirPath
    if (!fs.existsSync(expanded)) throw new Error(`目录不存在: ${dirPath}`)
    const entries = fs.readdirSync(expanded, { withFileTypes: true })
    return entries.map(e => {
      if (e.isDirectory()) return `[DIR]  ${e.name}/`
      try {
        const stat = fs.statSync(path.join(expanded, e.name))
        const size = stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`
        return `[FILE] ${e.name} (${size})`
      } catch {
        return `[FILE] ${e.name}`
      }
    }).join('\n') || '（空目录）'
  },

  assistant_system_info() {
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    const arch = process.arch
    const home = homedir()
    const hostname = os.hostname()
    const shell = process.platform === 'win32' ? 'powershell / cmd' : (process.env.SHELL || '/bin/bash')
    const sep = path.sep
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
    const cpus = os.cpus()
    const cpuModel = cpus[0]?.model || '未知'
    const lines = [
      `OS: ${platform}`,
      `Arch: ${arch}`,
      `Home: ${home}`,
      `Hostname: ${hostname}`,
      `Shell: ${shell}`,
      `Path separator: ${sep}`,
      `CPU: ${cpuModel} (${cpus.length} 核)`,
      `Memory: ${freeMem}GB free / ${totalMem}GB total`,
    ]
    // Node.js 版本
    try {
      const nodeVer = execSync('node --version 2>&1', { windowsHide: true }).toString().trim()
      lines.push(`Node.js: ${nodeVer}`)
    } catch {}
    return lines.join('\n')
  },

  assistant_list_processes({ filter }) {
    try {
      if (isWindows) {
        const cmd = filter
          ? `tasklist /FI "IMAGENAME eq ${filter}*" /FO CSV /NH 2>nul`
          : 'tasklist /FO CSV /NH 2>nul | more +1'
        const output = execSync(cmd, { timeout: 5000, windowsHide: true }).toString().trim()
        return output || '（无匹配进程）'
      } else {
        const cmd = filter
          ? `ps aux | head -1 && ps aux | grep -i "${filter}" | grep -v grep`
          : 'ps aux | head -20'
        const output = execSync(cmd, { timeout: 5000 }).toString().trim()
        return output || '（无匹配进程）'
      }
    } catch (e) {
      return e.stdout?.toString() || '（无匹配进程）'
    }
  },

  assistant_check_port({ port }) {
    if (!port) throw new Error('端口号不能为空')
    try {
      if (isWindows) {
        const output = execSync(`netstat -ano | findstr :${port}`, { timeout: 5000, windowsHide: true }).toString().trim()
        return output ? `端口 ${port} 已被占用（正在监听）\n${output}` : `端口 ${port} 未被占用（空闲）`
      } else {
        const output = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null || lsof -i :${port} 2>/dev/null`, { timeout: 5000 }).toString().trim()
        // ss 输出第一行是表头，需要检查是否有第二行
        const lines = output.split('\n').filter(l => l.trim())
        if (lines.length > 1 || output.includes(`:${port}`)) {
          return `端口 ${port} 已被占用（正在监听）\n${output}`
        }
        return `端口 ${port} 未被占用（空闲）`
      }
    } catch {
      return `端口 ${port} 未被占用（空闲）`
    }
  },

  // === AI 助手联网搜索工具 ===

  async assistant_web_search({ query, max_results = 5 }) {
    if (!query) throw new Error('搜索关键词不能为空')
    try {
      // 使用 DuckDuckGo HTML 搜索
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const https = require('https')
      const http = require('http')
      const fetchModule = url.startsWith('https') ? https : http
      const html = await new Promise((resolve, reject) => {
        const req = fetchModule.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // 跟随重定向
            const rUrl = res.headers.location.startsWith('http') ? res.headers.location : `https://html.duckduckgo.com${res.headers.location}`
            fetchModule.get(rUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (res2) => {
              let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d))
            }).on('error', reject)
            return
          }
          let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data))
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('搜索超时')) })
      })

      // 解析搜索结果
      const results = []
      const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
      let match
      while ((match = regex.exec(html)) !== null && results.length < max_results) {
        const rawUrl = match[1]
        const title = match[2].replace(/<[^>]+>/g, '').trim()
        const snippet = match[3].replace(/<[^>]+>/g, '').trim()
        // DuckDuckGo 的 URL 需要解码
        let finalUrl = rawUrl
        try {
          const uddg = new URL(rawUrl, 'https://duckduckgo.com').searchParams.get('uddg')
          if (uddg) finalUrl = decodeURIComponent(uddg)
        } catch {}
        if (title && finalUrl) {
          results.push({ title, url: finalUrl, snippet })
        }
      }

      if (results.length === 0) {
        return `搜索「${query}」未找到相关结果。`
      }

      let output = `搜索「${query}」找到 ${results.length} 条结果：\n\n`
      results.forEach((r, i) => {
        output += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`
      })
      return output
    } catch (err) {
      return `搜索失败: ${err.message}。请检查网络连接。`
    }
  },

  async assistant_fetch_url({ url }) {
    if (!url) throw new Error('URL 不能为空')
    if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('URL 必须以 http:// 或 https:// 开头')

    try {
      // 优先使用 Jina Reader API（免费，返回 Markdown）
      const jinaUrl = 'https://r.jina.ai/' + url
      const https = require('https')
      const content = await new Promise((resolve, reject) => {
        const req = https.get(jinaUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain' },
          timeout: 15000,
        }, (res) => {
          let data = ''
          res.on('data', c => {
            data += c
            if (data.length > 100000) { req.destroy(); resolve(data.slice(0, 100000) + '\n\n[内容已截断，超过 100KB 限制]') }
          })
          res.on('end', () => resolve(data))
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('抓取超时')) })
      })

      return content || '（页面内容为空）'
    } catch (err) {
      return `抓取失败: ${err.message}`
    }
  },

  // === 面板配置（Web 模式） ===

  get_openclaw_dir() {
    const panelConfig = readPanelConfig()
    const info = applyOpenclawPathConfig(panelConfig)
    return {
      path: info.path,
      isCustom: info.isCustom,
      configExists: fs.existsSync(CONFIG_PATH),
    }
  },

  read_panel_config() {
    return readPanelConfig()
  },

  write_panel_config({ config }) {
    const nextConfig = config && typeof config === 'object' ? { ...config } : {}
    if (typeof nextConfig.openclawDir === 'string') {
      const trimmed = nextConfig.openclawDir.trim()
      if (trimmed) nextConfig.openclawDir = trimmed
      else delete nextConfig.openclawDir
    } else if (nextConfig.openclawDir == null) {
      delete nextConfig.openclawDir
    }
    for (const key of ['dockerEndpoint', 'dockerDefaultImage']) {
      if (typeof nextConfig[key] === 'string') {
        const trimmed = nextConfig[key].trim()
        if (trimmed) nextConfig[key] = trimmed
        else delete nextConfig[key]
      } else if (nextConfig[key] == null) {
        delete nextConfig[key]
      }
    }
    const panelDir = path.dirname(PANEL_CONFIG_PATH)
    if (!fs.existsSync(panelDir)) fs.mkdirSync(panelDir, { recursive: true })
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(nextConfig, null, 2))
    invalidateConfigCache()
    applyOpenclawPathConfig(nextConfig)
    return true
  },

  test_proxy({ url }) {
    const cfg = readPanelConfig()
    const proxyUrl = cfg?.networkProxy?.url
    if (!proxyUrl) throw new Error('未配置代理地址')
    return { ok: true, status: 200, elapsed_ms: 0, proxy: proxyUrl, target: url || 'N/A (Web模式不支持代理测试)' }
  },

  // === Agent 管理（Web 模式） ===

  add_agent({ name, model, workspace }) {
    if (!name) throw new Error('Agent 名称不能为空')
    const cfg = readOpenclawConfigRequired()
    const agentsList = ensureAgentsList(cfg)
    if (agentsList.some(a => (a?.id || 'main').trim() === name)) throw new Error(`Agent "${name}" 已存在`)

    const agentDir = path.join(OPENCLAW_DIR, 'agents', name)
    const workspacePath = expandHomePath(workspace || null) || path.join(agentDir, 'workspace')
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true })
    if (!fs.existsSync(workspacePath)) fs.mkdirSync(workspacePath, { recursive: true })

    const entry = { id: name, workspace: workspacePath }
    if (model) entry.model = { primary: model }
    agentsList.push(entry)

    writeOpenclawConfigFile(cfg)
    triggerGatewayReloadNonBlocking('add_agent')
    return handlers.list_agents()
  },

  delete_agent({ id }) {
    if (!id || id === 'main') throw new Error('不能删除默认 Agent')
    const cfg = readOpenclawConfigRequired()
    const agentDir = resolveAgentDir(cfg, id)
    const agentsList = ensureAgentsList(cfg)
    const before = agentsList.length
    cfg.agents.list = agentsList.filter(a => (a?.id || 'main').trim() !== id)
    if (before === cfg.agents.list.length) throw new Error(`Agent "${id}" 不存在`)
    if (cfg.agents?.profiles && typeof cfg.agents.profiles === 'object') delete cfg.agents.profiles[id]

    writeOpenclawConfigFile(cfg)
    if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true })
    triggerGatewayReloadNonBlocking('delete_agent')
    return true
  },

  update_agent_identity({ id, name, emoji }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const config = readOpenclawConfigRequired()
    const agentsList = ensureAgentsList(config)

    let agent = agentsList.find(a => (a.id || 'main').trim() === id)
    if (!agent) {
      // 不存在则新建条目
      agent = { id }
      agentsList.push(agent)
    }
    if (!agent.identity || typeof agent.identity !== 'object') agent.identity = {}
    if (name !== undefined) {
      if (name) agent.identity.name = name
      else delete agent.identity.name
    }
    if (emoji !== undefined) {
      if (emoji) agent.identity.emoji = emoji
      else delete agent.identity.emoji
    }
    if (!Object.keys(agent.identity).length) delete agent.identity

    writeOpenclawConfigFile(config)

    const identityFile = path.join(resolveAgentWorkspace(config, id), 'IDENTITY.md')
    if (fs.existsSync(identityFile)) {
      try { fs.unlinkSync(identityFile) } catch {}
    }

    triggerGatewayReloadNonBlocking('update_agent_identity')
    return true
  },

  update_agent_model({ id, model }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const config = readOpenclawConfigRequired()
    const agentsList = ensureAgentsList(config)

    let agent = agentsList.find(a => (a.id || 'main').trim() === id)
    if (!agent) {
      agent = { id }
      agentsList.push(agent)
    }
    if (model) agent.model = { primary: model }
    else delete agent.model

    writeOpenclawConfigFile(config)
    triggerGatewayReloadNonBlocking('update_agent_model')
    return true
  },

  backup_agent({ id }) {
    if (!id) throw new Error('Agent ID 不能为空')
    const cfg = readOpenclawConfigOptional()
    const primaryDir = id === 'main' ? resolveAgentWorkspace(cfg, id) : resolveAgentDir(cfg, id)
    const fallbackDir = resolveAgentWorkspace(cfg, id)
    const sourceDir = fs.existsSync(primaryDir) ? primaryDir : fallbackDir
    if (!fs.existsSync(sourceDir)) return '工作区为空，无需备份'
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true })
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const name = `agent-${id}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.tar`
    const archivePath = path.join(BACKUPS_DIR, name)
    try {
      execSync(`tar -cf "${archivePath}" -C "${sourceDir}" .`, { timeout: 30000 })
      return archivePath
    } catch (e) {
      throw new Error('备份失败: ' + (e.message || e))
    }
  },

  // === 初始设置工具（Web 模式） ===

  check_node_at_path({ nodeDir }) {
    const nodeBin = path.join(nodeDir, isWindows ? 'node.exe' : 'node')
    if (!fs.existsSync(nodeBin)) throw new Error(`未在 ${nodeDir} 找到 node`)
    try {
      const ver = execSync(`"${nodeBin}" --version 2>&1`, { timeout: 5000, windowsHide: true }).toString().trim()
      return { installed: true, version: ver, path: nodeBin }
    } catch (e) {
      throw new Error('node 检测失败: ' + e.message)
    }
  },

  scan_node_paths() {
    const results = []
    const candidates = isWindows
      ? ['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs']
      : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', path.join(homedir(), '.nvm/versions/node'), path.join(homedir(), '.volta/bin')]
    for (const p of candidates) {
      const nodeBin = path.join(p, isWindows ? 'node.exe' : 'node')
      if (fs.existsSync(nodeBin)) {
        try {
          const ver = execSync(`"${nodeBin}" --version 2>&1`, { timeout: 5000, windowsHide: true }).toString().trim()
          results.push({ path: p, version: ver })
        } catch {}
      }
    }
    return results
  },

  scan_openclaw_paths() {
    return scanAllOpenclawInstallations()
  },

  check_openclaw_at_path({ cliPath }) {
    const resolved = resolveOpenclawCliInput(cliPath)
    if (!resolved) {
      return { installed: false, path: null, version: null, source: null }
    }
    return {
      installed: true,
      path: resolved,
      version: readVersionFromInstallation(resolved),
      source: classifyCliSource(resolved) || 'unknown',
    }
  },

  save_custom_node_path({ nodeDir }) {
    const cfg = readPanelConfig()
    cfg.customNodePath = nodeDir
    if (!fs.existsSync(OPENCLAW_DIR)) fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    invalidateConfigCache()
    return true
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

  // 前端热更新
  async check_frontend_update() {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const currentVersion = pkg.version

    try {
      const resp = await globalThis.fetch('https://claw.qt.cool/update/latest.json', {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'ClawPanel-Web' },
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const manifest = await resp.json()
      const latestVersion = manifest.version || ''
      const minAppVersion = manifest.minAppVersion || '0.0.0'
      const compatible = versionGe(currentVersion, minAppVersion)
      const hasUpdate = !!latestVersion && latestVersion !== currentVersion && compatible && versionGt(latestVersion, currentVersion)
      return { currentVersion, latestVersion, hasUpdate, compatible, updateReady: false, manifest }
    } catch {
      return { currentVersion, latestVersion: currentVersion, hasUpdate: false, compatible: true, updateReady: false, manifest: { version: currentVersion } }
    }
  },
  download_frontend_update() { return { success: true, files: 12, path: path.join(OPENCLAW_DIR, 'clawpanel', 'web-update') } },
  rollback_frontend_update() { return { success: true } },
  get_update_status() {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return { currentVersion: pkg.version, updateReady: false, updateVersion: '', updateDir: path.join(OPENCLAW_DIR, 'clawpanel', 'web-update') }
  },
  write_env_file({ path: p, config }) {
    const expanded = p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
    if (!expanded.startsWith(OPENCLAW_DIR)) throw new Error(`只允许写入 ${OPENCLAW_DIR} 下的文件`)
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

  // --- 健康检查（前端用于检测后端是否在线） ---
  if (cmd === 'health') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, ts: Date.now() }))
    return
  }

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

  // --- 实例代理：非 ALWAYS_LOCAL 命令，活跃实例非本机时代理转发 ---
  const activeInst = getActiveInstance()
  if (activeInst.type !== 'local' && activeInst.endpoint && !ALWAYS_LOCAL.has(cmd)) {
    try {
      const args = await readBody(req)
      const result = await proxyToInstance(activeInst, cmd, args)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (e) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: `实例「${activeInst.name}」不可达: ${e.message}` }))
    }
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

// 导出供 serve.js 独立部署使用
export { _initApi, _apiMiddleware }

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
