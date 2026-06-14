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
import * as YAML from 'yaml'
import * as skillhubSdk from './lib/skillhub-sdk.js'
const DOCKER_TASK_TIMEOUT_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Hermes Agent — 路径 / 工具函数
// ---------------------------------------------------------------------------
const HERMES_HOME = path.join(homedir(), '.hermes')
const HERMES_DEFAULT_PORT = 8642

function hermesProvider(id, name, authType, baseUrl, baseUrlEnvVar, apiKeyEnvVars, transport, modelsProbe, models, isAggregator = false, cliAuthHint = '') {
  return { id, name, authType, baseUrl, baseUrlEnvVar, apiKeyEnvVars, transport, modelsProbe, models, isAggregator, cliAuthHint }
}

const HERMES_PROVIDER_REGISTRY = [
  hermesProvider('anthropic', 'Anthropic', 'api_key', 'https://api.anthropic.com', '', ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], 'anthropic_messages', 'anthropic', ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001']),
  hermesProvider('gemini', 'Google AI Studio', 'api_key', 'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_BASE_URL', ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], 'openai_chat', 'openai', ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-it']),
  hermesProvider('deepseek', 'DeepSeek', 'api_key', 'https://api.deepseek.com', 'DEEPSEEK_BASE_URL', ['DEEPSEEK_API_KEY'], 'openai_chat', 'openai', ['deepseek-chat', 'deepseek-reasoner']),
  hermesProvider('xai', 'xAI', 'api_key', 'https://api.x.ai/v1', 'XAI_BASE_URL', ['XAI_API_KEY'], 'openai_chat', 'openai', ['grok-4.20-reasoning', 'grok-4-1-fast-reasoning']),
  hermesProvider('minimax', 'MiniMax (International)', 'api_key', 'https://api.minimax.io/anthropic/v1', 'MINIMAX_BASE_URL', ['MINIMAX_API_KEY'], 'anthropic_messages', 'anthropic', ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed']),
  hermesProvider('huggingface', 'Hugging Face', 'api_key', 'https://router.huggingface.co/v1', 'HF_BASE_URL', ['HF_TOKEN'], 'openai_chat', 'openai', ['Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'deepseek-ai/DeepSeek-V3.2', 'moonshotai/Kimi-K2.5', 'MiniMaxAI/MiniMax-M2.5', 'zai-org/GLM-5', 'XiaomiMiMo/MiMo-V2-Flash', 'moonshotai/Kimi-K2-Thinking'], true),
  hermesProvider('arcee', 'Arcee AI', 'api_key', 'https://api.arcee.ai/api/v1', 'ARCEE_BASE_URL', ['ARCEEAI_API_KEY'], 'openai_chat', 'openai', []),
  hermesProvider('azure-foundry', 'Azure Foundry', 'api_key', '', 'AZURE_FOUNDRY_BASE_URL', ['AZURE_FOUNDRY_API_KEY'], 'openai_chat', 'openai', [], true),
  hermesProvider('gmi', 'GMI Cloud', 'api_key', 'https://api.gmi-serving.com/v1', 'GMI_BASE_URL', ['GMI_API_KEY'], 'openai_chat', 'openai', []),
  hermesProvider('lmstudio', 'LM Studio', 'api_key', 'http://127.0.0.1:1234/v1', 'LM_BASE_URL', ['LM_API_KEY'], 'openai_chat', 'openai', []),
  hermesProvider('nvidia', 'NVIDIA NIM', 'api_key', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_BASE_URL', ['NVIDIA_API_KEY'], 'openai_chat', 'openai', []),
  hermesProvider('ollama-cloud', 'Ollama Cloud', 'api_key', 'https://ollama.com/v1', 'OLLAMA_BASE_URL', ['OLLAMA_API_KEY'], 'openai_chat', 'openai', []),
  hermesProvider('copilot', 'GitHub Copilot (PAT)', 'api_key', 'https://api.githubcopilot.com', '', ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'], 'openai_chat', 'none', ['gpt-4o', 'gpt-4.1', 'claude-3.5-sonnet', 'claude-3.7-sonnet', 'claude-sonnet-4-5', 'o1', 'o1-mini', 'gemini-2.5-pro']),
  hermesProvider('zai', 'Z.AI / GLM', 'api_key', 'https://api.z.ai/api/paas/v4', 'GLM_BASE_URL', ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'], 'openai_chat', 'openai', ['glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5-turbo', 'glm-4.7', 'glm-4.5', 'glm-4.5-flash']),
  hermesProvider('kimi-coding', 'Kimi / Moonshot', 'api_key', 'https://api.moonshot.ai/v1', 'KIMI_BASE_URL', ['KIMI_API_KEY'], 'openai_chat', 'openai', ['kimi-for-coding', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview', 'kimi-k2-0905-preview']),
  hermesProvider('kimi-coding-cn', 'Kimi / Moonshot (China)', 'api_key', 'https://api.moonshot.cn/v1', '', ['KIMI_CN_API_KEY'], 'openai_chat', 'openai', ['kimi-for-coding', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview']),
  hermesProvider('alibaba', 'Alibaba Cloud (DashScope)', 'api_key', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_BASE_URL', ['DASHSCOPE_API_KEY'], 'openai_chat', 'openai', ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next', 'glm-5', 'glm-4.7', 'kimi-k2.5', 'MiniMax-M2.5']),
  hermesProvider('alibaba-coding-plan', 'Alibaba Cloud (Coding Plan)', 'api_key', 'https://coding-intl.dashscope.aliyuncs.com/v1', 'ALIBABA_CODING_PLAN_BASE_URL', ['ALIBABA_CODING_PLAN_API_KEY', 'DASHSCOPE_API_KEY'], 'openai_chat', 'openai', ['qwen3-coder-plus', 'qwen3-coder-next', 'qwen3.5-plus', 'qwen3.5-coder']),
  hermesProvider('minimax-cn', 'MiniMax (China)', 'api_key', 'https://api.minimaxi.com/v1', 'MINIMAX_CN_BASE_URL', ['MINIMAX_CN_API_KEY'], 'anthropic_messages', 'anthropic', ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed']),
  hermesProvider('xiaomi', 'Xiaomi MiMo', 'api_key', 'https://api.xiaomimimo.com/v1', 'XIAOMI_BASE_URL', ['XIAOMI_API_KEY'], 'openai_chat', 'openai', ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash']),
  hermesProvider('bedrock', 'AWS Bedrock', 'aws_sdk', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'BEDROCK_BASE_URL', [], 'anthropic_messages', 'none', []),
  hermesProvider('openrouter', 'OpenRouter', 'api_key', 'https://openrouter.ai/api/v1', 'OPENAI_BASE_URL', ['OPENROUTER_API_KEY'], 'openai_chat', 'openai', [], true),
  hermesProvider('ai-gateway', 'Vercel AI Gateway', 'api_key', 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_BASE_URL', ['AI_GATEWAY_API_KEY'], 'openai_chat', 'openai', ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5', 'openai/gpt-5', 'openai/gpt-4.1', 'openai/gpt-4.1-mini', 'google/gemini-3-pro-preview', 'google/gemini-3-flash', 'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v3.2'], true),
  hermesProvider('opencode-zen', 'OpenCode Zen', 'api_key', 'https://opencode.ai/zen/v1', 'OPENCODE_ZEN_BASE_URL', ['OPENCODE_ZEN_API_KEY'], 'openai_chat', 'openai', ['gpt-5.4-pro', 'gpt-5.4', 'gpt-5.3-codex', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gemini-3.1-pro', 'gemini-3-pro', 'minimax-m2.7', 'glm-5', 'kimi-k2.5', 'qwen3-coder'], true),
  hermesProvider('opencode-go', 'OpenCode Go', 'api_key', 'https://opencode.ai/zen/go/v1', 'OPENCODE_GO_BASE_URL', ['OPENCODE_GO_API_KEY'], 'openai_chat', 'openai', ['glm-5.1', 'glm-5', 'kimi-k2.5', 'mimo-v2-pro', 'mimo-v2-omni', 'minimax-m2.7', 'minimax-m2.5'], true),
  hermesProvider('kilocode', 'Kilo Code', 'api_key', 'https://api.kilo.ai/api/gateway', 'KILOCODE_BASE_URL', ['KILOCODE_API_KEY'], 'openai_chat', 'openai', ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.4', 'google/gemini-3-pro-preview', 'google/gemini-3-flash-preview'], true),
  hermesProvider('nous', 'Nous Portal', 'oauth_device_code', 'https://inference-api.nousresearch.com/v1', '', [], 'openai_chat', 'none', ['moonshotai/kimi-k2.6', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.4', 'google/gemini-3-pro-preview', 'qwen/qwen3.5-plus-02-15', 'minimax/minimax-m2.7', 'z-ai/glm-5.1', 'x-ai/grok-4.20-beta'], true, 'hermes auth login nous'),
  hermesProvider('openai-codex', 'OpenAI Codex', 'oauth_external', 'https://chatgpt.com/backend-api/codex', '', [], 'codex_responses', 'none', ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'], false, 'hermes auth login openai-codex'),
  hermesProvider('qwen-oauth', 'Qwen OAuth', 'oauth_external', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', '', [], 'openai_chat', 'none', ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next'], false, 'hermes auth login qwen-oauth'),
  hermesProvider('google-gemini-cli', 'Google Gemini (OAuth)', 'oauth_external', 'https://generativelanguage.googleapis.com/v1beta/openai', '', [], 'openai_chat', 'none', ['gemini-2.5-pro', 'gemini-2.5-flash'], false, 'hermes auth login google-gemini-cli'),
  hermesProvider('minimax-oauth', 'MiniMax (OAuth)', 'oauth_minimax', 'https://api.minimax.io/anthropic', '', [], 'anthropic_messages', 'none', ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'], false, 'hermes auth login minimax-oauth'),
  hermesProvider('copilot-acp', 'GitHub Copilot ACP', 'external_process', 'http://127.0.0.1:0', 'COPILOT_ACP_BASE_URL', [], 'openai_chat', 'none', ['gpt-4o', 'gpt-4.1', 'claude-3.5-sonnet', 'claude-3.7-sonnet'], false, 'hermes auth login copilot-acp'),
  hermesProvider('custom', 'Custom OpenAI-Compatible', 'api_key', '', 'OPENAI_BASE_URL', ['OPENAI_API_KEY', 'CUSTOM_API_KEY'], 'openai_chat', 'openai', [], true),
]

function hermesHome() {
  return process.env.HERMES_HOME || HERMES_HOME
}

export function validateHermesConfigYamlText(yamlText = '') {
  const raw = String(yamlText || '')
  if (!raw.trim()) return {}

  let parsed
  try {
    parsed = YAML.parse(raw)
  } catch (err) {
    throw new Error(`config.yaml YAML 格式错误: ${err?.message || String(err)}`)
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.yaml 顶层必须是对象')
  }
  return parsed
}

/** Resolve memory kind (memory|user|soul) → markdown file name. */
function memoryFileName(kind) {
  switch (kind) {
    case 'memory': return 'MEMORY.md'
    case 'user':   return 'USER.md'
    case 'soul':   return 'SOUL.md'
    default:       return null
  }
}

function uvBinDir() {
  if (isWindows) {
    const appdata = process.env.APPDATA
    if (appdata) return path.join(appdata, 'clawpanel', 'bin')
    return path.join(homedir(), '.clawpanel', 'bin')
  }
  if (isMac) return path.join(homedir(), 'Library', 'Application Support', 'clawpanel', 'bin')
  return path.join(homedir(), '.local', 'share', 'clawpanel', 'bin')
}

function hermesEnhancedPath() {
  const current = process.env.PATH || ''
  const home = homedir()
  const extra = [uvBinDir()]
  if (isWindows) {
    const appdata = process.env.APPDATA || ''
    if (appdata) extra.push(path.join(appdata, 'uv', 'tools', 'bin'))
    extra.push(path.join(home, '.local', 'bin'))
    extra.push(path.join(home, '.cargo', 'bin'))
  } else {
    extra.push(path.join(home, '.local', 'bin'))
    extra.push(path.join(home, '.cargo', 'bin'))
    extra.push('/usr/local/bin')
  }
  const sep = isWindows ? ';' : ':'
  return [...extra, current].filter(Boolean).join(sep)
}

function hermesGatewayPort() {
  const configPath = path.join(hermesHome(), 'config.yaml')
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.trim().match(/^api_server_port:\s*(\d+)/)
      if (m) { const p = parseInt(m[1], 10); if (p > 0) return p }
    }
  } catch {}
  return HERMES_DEFAULT_PORT
}

function hermesGatewayUrl() {
  try {
    const cfg = readPanelConfig()
    const url = cfg?.hermes?.gatewayUrl
    if (url && typeof url === 'string' && url.trim()) return url.trim().replace(/\/+$/, '')
  } catch {}
  return `http://127.0.0.1:${hermesGatewayPort()}`
}

function hermesGatewayCustomUrl() {
  try {
    const cfg = readPanelConfig()
    const url = cfg?.hermes?.gatewayUrl
    if (url && typeof url === 'string' && url.trim()) return url.trim().replace(/\/+$/, '')
  } catch {}
  return ''
}

function isLoopbackGatewayUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
  } catch {
    return false
  }
}

function runHermesSilent(program, args) {
  try {
    const result = spawnSync(program, args, {
      env: { ...process.env, PATH: hermesEnhancedPath() },
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status === 0) return { ok: true, stdout: (result.stdout || '').trim() }
    return { ok: false, stderr: (result.stderr || '').trim() }
  } catch (e) {
    return { ok: false, stderr: String(e) }
  }
}

function sanitizeHermesInstallOutput(text = '') {
  return String(text || '')
    .replaceAll('git+https://github.com/NousResearch/hermes-agent.git', 'hermes-agent')
    .replaceAll('https://github.com/NousResearch/hermes-agent.git', 'hermes-agent')
    .replaceAll('https://github.com/NousResearch/hermes-agent', 'hermes-agent')
    .replaceAll('github.com/NousResearch/hermes-agent.git', 'hermes-agent')
    .replaceAll('github.com/NousResearch/hermes-agent', 'hermes-agent')
    .replaceAll('NousResearch/hermes-agent', 'hermes-agent')
}

// 读取 panel config (~/.openclaw/clawpanel.json) 中的 gitMirror 前缀。
// 为空/未设置 → 返回 '' 不启用镜像。
function gitMirrorPrefix() {
  try {
    const cfgPath = path.join(DEFAULT_OPENCLAW_DIR, 'clawpanel.json')
    if (!fs.existsSync(cfgPath)) return ''
    const raw = fs.readFileSync(cfgPath, 'utf8')
    const cfg = JSON.parse(raw)
    const v = String(cfg?.gitMirror || '').trim()
    return v
  } catch {
    return ''
  }
}

// 返回一个 env 添加包，含 GIT_CONFIG_COUNT/KEY/VALUE 临时重写。
// 未配置镜像 → 返回空对象。
function gitMirrorEnv() {
  let mirror = gitMirrorPrefix()
  if (!mirror) return {}
  if (!mirror.endsWith('/')) mirror += '/'
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${mirror}https://github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

// 判断输出是否命中 「网络无法访问」 类失败，命中返回建议文案。
function diagnoseHermesInstallError(text = '') {
  const lower = String(text || '').toLowerCase()
  const hits = [
    'failed to connect to github.com',
    'could not connect to server',
    'failed to clone',
    'unable to access',
    'git operation failed',
    'connection timed out',
    'connection refused',
    'network is unreachable',
    'could not resolve host',
  ]
  if (!hits.some(h => lower.includes(h))) return null
  return '⚠ 检测到安装过程中无法访问外部 Git 服务。请任选一项重试：'
    + '\n  1) 在「设置 → 网络代理」配置可用代理后重试；'
    + '\n  2) 在「设置 → Hermes 安装镜像」填入可用的 Git 镜像前缀。'
}

let _hermesGwProcess = null
let _hermesGwStarting = null

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
const SITE_BASE_URL = 'https://claw.qt.cool'
const VERSION_POLICY_PATH = path.join(__dev_dirname, '..', 'openclaw-version-policy.json')
const OPENCLAW_NODE_REQUIREMENT_VERSION_FLOOR = '2026.6.5'
const OPENCLAW_NODE_REQUIREMENT_FOR_NEWER_RUNTIME = '>=22.19.0'

function ensureArrayContains(value, required) {
  const current = Array.isArray(value)
    ? value.filter(item => typeof item === 'string')
    : []
  let changed = !Array.isArray(value) || current.length !== value.length
  for (const item of required) {
    if (!current.includes(item)) {
      current.push(item)
      changed = true
    }
  }
  return { value: current, changed }
}

function generatePairingToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function operatorTokenIsUsable(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (entry.revokedAtMs != null) return false
  if (entry.role !== 'operator') return false
  if (typeof entry.token !== 'string' || !entry.token.trim()) return false
  if (!Array.isArray(entry.scopes)) return false
  return SCOPES.every(scope => entry.scopes.includes(scope))
}

function ensureOperatorToken(entry, nowMs = Date.now()) {
  if (!entry.tokens || typeof entry.tokens !== 'object' || Array.isArray(entry.tokens)) {
    entry.tokens = {}
  }
  if (operatorTokenIsUsable(entry.tokens.operator)) return false

  const existing = entry.tokens.operator && typeof entry.tokens.operator === 'object' && !Array.isArray(entry.tokens.operator)
    ? entry.tokens.operator
    : null
  entry.tokens.operator = {
    token: typeof existing?.token === 'string' && existing.token.trim() ? existing.token : generatePairingToken(),
    role: 'operator',
    scopes: SCOPES,
    createdAtMs: Number.isFinite(Number(existing?.createdAtMs)) && Number(existing.createdAtMs) > 0
      ? Number(existing.createdAtMs)
      : nowMs,
    rotatedAtMs: nowMs,
  }
  if (Number.isFinite(Number(existing?.lastUsedAtMs)) && Number(existing.lastUsedAtMs) > 0) {
    entry.tokens.operator.lastUsedAtMs = Number(existing.lastUsedAtMs)
  }
  return true
}

function normalizeControlUiPairingEntry(entry, deviceId, publicKey, platform, nowMs = Date.now()) {
  const next = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  let changed = next !== entry
  const setString = (key, value) => {
    if (next[key] === value) return
    next[key] = value
    changed = true
  }

  setString('deviceId', deviceId)
  setString('publicKey', publicKey)
  setString('platform', platform)
  setString('deviceFamily', 'desktop')
  setString('clientId', 'openclaw-control-ui')
  setString('clientMode', 'ui')
  setString('role', 'operator')

  for (const [key, required] of [['roles', ['operator']], ['scopes', SCOPES], ['approvedScopes', SCOPES]]) {
    const normalized = ensureArrayContains(next[key], required)
    if (normalized.changed) {
      next[key] = normalized.value
      changed = true
    }
  }

  changed = ensureOperatorToken(next, nowMs) || changed
  if (!Number.isFinite(Number(next.createdAtMs)) || Number(next.createdAtMs) <= 0) {
    next.createdAtMs = nowMs
    changed = true
  }
  if (changed || !Number.isFinite(Number(next.approvedAtMs)) || Number(next.approvedAtMs) <= 0) {
    next.approvedAtMs = nowMs
    changed = true
  }

  return { entry: next, changed }
}

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

function isWindowsLaunchableOpenclawPath(rawPath) {
  if (!isWindows) return true
  const normalized = normalizeCliPath(rawPath)
  if (!normalized) return false
  const base = path.basename(normalized).toLowerCase()
  return ['openclaw.cmd', 'openclaw.exe', 'openclaw.bat', 'openclaw.js'].includes(base)
}

export function canonicalWindowsOpenclawCliPath(rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized || !isWindows) return normalized
  const base = path.basename(normalized).toLowerCase()
  if (['openclaw', 'openclaw.exe', 'openclaw.ps1'].includes(base)) {
    for (const name of ['openclaw.cmd', 'openclaw.exe', 'openclaw.bat', 'openclaw.js']) {
      const candidate = path.join(path.dirname(normalized), name)
      if (fs.existsSync(candidate) && !isRejectedCliPath(candidate)) return candidate
    }
  }
  if (fs.existsSync(normalized) && isWindowsLaunchableOpenclawPath(normalized) && !isRejectedCliPath(normalized)) {
    return normalized
  }
  return null
}

function isRejectedCliPath(cliPath) {
  const lower = String(cliPath || '').replace(/\\/g, '/').toLowerCase()
  return lower.includes('/.cherrystudio/') || lower.includes('cherry-studio')
}

function addCliCandidate(candidates, seen, rawPath) {
  const normalized = isWindows ? canonicalWindowsOpenclawCliPath(rawPath) : normalizeCliPath(rawPath)
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
  if (lower.includes('/npm/') || lower.includes('/npm-global/') || lower.includes('/node_modules/')) return 'npm-official'
  if (lower.includes('/homebrew/') || lower.includes('/usr/local/bin/') || lower.includes('/usr/bin/')) return 'npm-global'
  return 'unknown'
}

function normalizeCliInstallSource(cliSource) {
  if (cliSource === 'standalone' || cliSource === 'npm-zh') return 'chinese'
  if (cliSource === 'npm-official' || cliSource === 'npm-global') return 'official'
  return 'unknown'
}

function detectStandaloneSourceFromDir(dir) {
  try {
    const versionFile = path.join(dir, 'VERSION')
    if (fs.existsSync(versionFile)) {
      const pairs = Object.create(null)
      for (const line of fs.readFileSync(versionFile, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=')
        if (eq > 0) pairs[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim().toLowerCase()
      }
      const pkg = pairs.package || ''
      const edition = pairs.edition || ''
      if (pkg.includes('openclaw-zh') || pkg.includes('@qingchencloud')) return 'chinese'
      if (pkg === 'openclaw') return 'official'
      if (['zh', 'zh-cn', 'chinese', 'cn'].includes(edition)) return 'chinese'
      if (['en', 'official'].includes(edition)) return 'official'
    }
  } catch {}
  if (fs.existsSync(path.join(dir, 'node_modules', '@qingchencloud', 'openclaw-zh', 'package.json'))) return 'chinese'
  if (fs.existsSync(path.join(dir, 'node_modules', 'openclaw', 'package.json'))) return 'official'
  return null
}

function detectStandaloneSourceFromCliPath(cliPath) {
  const normalized = normalizeCliPath(cliPath)
  return normalized ? detectStandaloneSourceFromDir(path.dirname(normalized)) : null
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

function findOpenclawPackageJson(cliPath) {
  const resolved = canonicalCliPath(cliPath)
  if (!resolved || !fs.existsSync(resolved)) return null
  const dir = path.dirname(resolved)
  const ownPackageCandidates = []
  let current = dir
  while (current && current !== path.dirname(current)) {
    ownPackageCandidates.push(path.join(current, 'package.json'))
    current = path.dirname(current)
  }
  for (const pkgPath of ownPackageCandidates) {
    try {
      if (!fs.existsSync(pkgPath)) continue
      const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.name
      if (name === 'openclaw' || name === '@qingchencloud/openclaw-zh') return pkgPath
    } catch {}
  }

  const cliSource = classifyCliSource(resolved)
  const pkgNames = (cliSource === 'standalone' || cliSource === 'npm-zh')
    ? [path.join('@qingchencloud', 'openclaw-zh'), 'openclaw']
    : ['openclaw', path.join('@qingchencloud', 'openclaw-zh')]
  const bases = [dir, path.dirname(dir)].filter(Boolean)
  for (const base of bases) {
    for (const pkgName of pkgNames) {
      const pkgPath = path.join(base, 'node_modules', pkgName, 'package.json')
      if (fs.existsSync(pkgPath)) return pkgPath
    }
  }
  return null
}

function openclawNodeRequirement() {
  const cliPath = resolveOpenclawCliPath()
  const pkgPath = cliPath ? findOpenclawPackageJson(cliPath) : null
  let installedVersion = null
  if (pkgPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const requirement = pkg?.engines?.node
      if (typeof requirement === 'string' && requirement.trim()) return requirement.trim()
      installedVersion = typeof pkg?.version === 'string' ? pkg.version : null
    } catch {
      installedVersion = null
    }
  }
  if (!installedVersion && cliPath) installedVersion = readVersionFromInstallation(cliPath)
  return installedVersion && versionGe(baseVersion(installedVersion), OPENCLAW_NODE_REQUIREMENT_VERSION_FLOOR)
    ? OPENCLAW_NODE_REQUIREMENT_FOR_NEWER_RUNTIME
    : null
}

function parseNodeVersionTriplet(value) {
  const match = String(value || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)]
}

function compareVersionTriplet(left, right) {
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) > (right[i] || 0)) return 1
    if ((left[i] || 0) < (right[i] || 0)) return -1
  }
  return 0
}

function nodeVersionSatisfiesClause(version, clause) {
  const raw = String(clause || '').trim()
  if (!raw || raw === '*') return true
  if (raw.startsWith('>=')) {
    const min = parseNodeVersionTriplet(raw.slice(2))
    return !!min && compareVersionTriplet(version, min) >= 0
  }
  if (raw.startsWith('>')) {
    const min = parseNodeVersionTriplet(raw.slice(1))
    return !!min && compareVersionTriplet(version, min) > 0
  }
  if (raw.startsWith('^')) {
    const min = parseNodeVersionTriplet(raw.slice(1))
    if (!min) return false
    const max = [min[0] + 1, 0, 0]
    return compareVersionTriplet(version, min) >= 0 && compareVersionTriplet(version, max) < 0
  }
  const target = parseNodeVersionTriplet(raw)
  return !!target && compareVersionTriplet(version, target) === 0
}

function nodeVersionSatisfiesRequirement(versionText, requirementText) {
  const version = parseNodeVersionTriplet(versionText)
  if (!version) return false
  const requirement = String(requirementText || '').trim()
  if (!requirement) return true
  return requirement.split('||').some(range =>
    range.trim().split(/\s+/).filter(Boolean).every(clause => nodeVersionSatisfiesClause(version, clause))
  )
}

function decorateNodeDetection(base) {
  const requirement = openclawNodeRequirement()
  const installed = !!base?.installed
  const compatible = installed && requirement ? nodeVersionSatisfiesRequirement(base.version, requirement) : installed && !requirement
  return {
    ...base,
    compatible,
    requiredVersion: requirement,
  }
}

function standaloneBundledNodePath(cliPath) {
  if (!cliPath) return null
  const nodeBin = path.join(path.dirname(cliPath), isWindows ? 'node.exe' : 'node')
  return fs.existsSync(nodeBin) ? nodeBin : null
}

function ensureNodeRuntimeCompatibleWeb() {
  const node = handlers.check_node()
  if (!node.installed) throw new Error('Node.js 未安装或未检测到，请先安装 Node.js 后重新检测')
  if (node.compatible === false) {
    throw new Error(`Node.js 版本过低：当前检测到 ${node.version || 'unknown'}，当前 OpenClaw 要求 ${node.requiredVersion || '当前 OpenClaw 要求的版本'}。请升级 Node.js 后重新检测。检测路径：${node.path || ''}`)
  }
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

function npmOpenclawCliPath() {
  const binDir = isWindows
    ? (readWindowsNpmGlobalPrefix() || (process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null))
    : (() => {
        try {
          const prefix = execSync('npm config get prefix', { timeout: 5000, windowsHide: true, encoding: 'utf8' }).trim()
          if (prefix && prefix.toLowerCase() !== 'undefined') return path.join(prefix, 'bin')
        } catch {}
        return '/usr/local/bin'
      })()
  if (!binDir) return null
  const names = isWindows
    ? ['openclaw.cmd', 'openclaw.exe', 'openclaw.bat', 'openclaw.js']
    : ['openclaw']
  for (const name of names) {
    const candidate = path.join(binDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(binDir, names[0])
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
      addCliCandidate(candidates, seen, path.join(appdata, 'npm', 'openclaw.exe'))
      addCliCandidate(candidates, seen, path.join(appdata, 'npm', 'openclaw.bat'))
      addCliCandidate(candidates, seen, path.join(appdata, 'npm', 'openclaw.js'))
    }
    const customPrefix = readWindowsNpmGlobalPrefix()
    if (customPrefix) {
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.cmd'))
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.exe'))
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.bat'))
      addCliCandidate(candidates, seen, path.join(customPrefix, 'openclaw.js'))
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
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw.exe'))
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw.bat'))
      addCliCandidate(candidates, seen, path.join(trimmed, 'openclaw.js'))
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
  const normalized = resolveOpenclawCliInput(readPanelConfig()?.openclawCliPath || '')
  if (!normalized || !fs.existsSync(normalized) || isRejectedCliPath(normalized)) return null
  return normalized
}

function resolveOpenclawCliPath() {
  const bound = readBoundOpenclawCliPath()
  if (bound) return bound
  return collectPreferredCliCandidates()[0] || null
}

function scanAllOpenclawInstallations(activePath = resolveOpenclawCliPath()) {
  const activeIdentity = cliIdentityKey(activePath)
  return collectAllCliCandidates().map(candidate => ({
    path: candidate,
    source: classifyCliSource(candidate) || 'unknown',
    version: readVersionFromInstallation(candidate),
    active: !!activeIdentity && cliIdentityKey(candidate) === activeIdentity,
  })).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    const sourceCmp = String(a.source || '').localeCompare(String(b.source || ''))
    if (sourceCmp !== 0) return sourceCmp
    return String(a.path || '').localeCompare(String(b.path || ''))
  })
}

function sourceLabelForCliConflict(source) {
  switch (source) {
    case 'cherrystudio': return 'Cherry Studio 内嵌'
    case 'cursor': return 'Cursor 内嵌'
    case 'npm-zh': return 'npm 汉化版安装'
    case 'npm-official':
    case 'npm-global': return 'npm 官方/全局安装'
    case 'standalone': return 'ClawPanel standalone'
    default: return '未识别来源'
  }
}

function canonicalLowerPathForConflict(rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized) return ''
  let resolved = normalized
  try { resolved = fs.realpathSync.native(normalized) } catch {}
  let text = resolved.replace(/\\/g, '/').toLowerCase()
  if (text.startsWith('//?/')) text = text.slice(4)
  while (text.endsWith('/')) text = text.slice(0, -1)
  return text
}

function cliIdentityKey(rawPath) {
  const identity = scanCliIdentity(rawPath)
  return identity ? canonicalLowerPathForConflict(identity) : ''
}

function standaloneConflictDirs() {
  const dirs = []
  try { dirs.push(standaloneInstallDir()) } catch {}
  dirs.push(path.join(homedir(), '.openclaw-bin'))
  return dirs.map(canonicalLowerPathForConflict).filter(Boolean)
}

function isStandaloneConflictPath(cliPath, source = '') {
  if (source === 'standalone') return true
  const canon = canonicalLowerPathForConflict(cliPath)
  if (!canon) return false
  return standaloneConflictDirs().some(dir => canon === dir || canon.startsWith(`${dir}/`))
}

function gatewayOwnerProtectedCliPath() {
  const owner = readGatewayOwner()
  if (!owner) return null
  const startedBy = owner.startedBy || owner.started_by
  if (startedBy && startedBy !== 'clawpanel') return null
  const ownerDir = owner.openclawDir || owner.openclaw_dir
  if (ownerDir && path.resolve(ownerDir) !== path.resolve(OPENCLAW_DIR)) return null
  const ownerPort = Number(owner.port || 0)
  if (ownerPort && ownerPort !== readGatewayPort()) return null
  return owner.cliPath || owner.cli_path || null
}

function activeOpenclawCliIdentityKeys(options = {}) {
  const identities = new Set()
  const add = rawPath => {
    const key = cliIdentityKey(rawPath)
    if (key) identities.add(key)
  }
  add(resolveOpenclawCliPath())
  add(gatewayOwnerProtectedCliPath())
  for (const rawPath of Array.isArray(options.activeCliPaths) ? options.activeCliPaths : []) {
    add(rawPath)
  }
  return identities
}

function isActiveOpenclawCliPath(cliPath, options = {}) {
  const key = cliIdentityKey(cliPath)
  return !!key && activeOpenclawCliIdentityKeys(options).has(key)
}

export function buildOpenclawPathConflictRecords(installations = scanAllOpenclawInstallations()) {
  const seen = new Set()
  const records = []
  const activeIdentities = activeOpenclawCliIdentityKeys()
  for (const item of Array.isArray(installations) ? installations : []) {
    const cliPath = item?.path
    if (!cliPath || isStandaloneConflictPath(cliPath, item.source)) continue
    const cliIdentity = cliIdentityKey(cliPath)
    if (item.active || (cliIdentity && activeIdentities.has(cliIdentity))) continue
    const key = canonicalLowerPathForConflict(cliPath) || String(cliPath)
    if (seen.has(key)) continue
    seen.add(key)
    const stat = (() => {
      try { return fs.statSync(cliPath) } catch { return null }
    })()
    records.push({
      path: cliPath,
      source: item.source || classifyCliSource(cliPath) || 'unknown',
      sourceLabel: sourceLabelForCliConflict(item.source || classifyCliSource(cliPath) || 'unknown'),
      version: item.version || readVersionFromInstallation(cliPath) || null,
      sizeBytes: stat?.isFile() ? stat.size : null,
    })
  }
  return records
}

function formatConflictTimestamp(now = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function quarantineOpenclawPathForWeb(rawPath, options = {}) {
  const original = normalizeCliPath(rawPath)
  if (!original || !fs.existsSync(original)) throw new Error(`文件不存在: ${rawPath}`)
  const stat = fs.statSync(original)
  if (!stat.isFile()) throw new Error(`不是文件: ${rawPath}`)
  if (isStandaloneConflictPath(original, classifyCliSource(original))) {
    throw new Error('拒绝隔离 standalone 安装目录下的 OpenClaw（这是当前运行版本）')
  }
  if (isActiveOpenclawCliPath(original, options)) {
    throw new Error('拒绝隔离正在被 Gateway 使用的 OpenClaw（请先停止 Gateway 或切换 CLI 路径）')
  }
  const fileName = path.basename(original)
  if (!fileName.toLowerCase().startsWith('openclaw')) {
    throw new Error(`拒绝隔离非 openclaw 文件: ${fileName}`)
  }
  const ts = formatConflictTimestamp(options.now || new Date())
  const quarantinedPath = path.join(path.dirname(original), `${fileName}.disabled-by-clawpanel-${ts}.bak`)
  if (fs.existsSync(quarantinedPath)) {
    throw new Error(`目标文件已存在，请稍后再试: ${quarantinedPath}`)
  }
  fs.renameSync(original, quarantinedPath)
  return {
    originalPath: original,
    quarantinedPath,
    quarantinedAt: new Date().toISOString(),
  }
}

export function resolveOpenclawCliInput(rawPath) {
  const normalized = normalizeCliPath(rawPath)
  if (!normalized) return null
  if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
    const candidates = isWindows
      ? [path.join(normalized, 'openclaw.cmd'), path.join(normalized, 'openclaw.exe'), path.join(normalized, 'openclaw.bat'), path.join(normalized, 'openclaw.js')]
      : [path.join(normalized, 'openclaw')]
    for (const candidate of candidates) {
      const resolved = normalizeCliPath(candidate)
      if (resolved && fs.existsSync(resolved) && !isRejectedCliPath(resolved)) return resolved
    }
    return null
  }
  if (isWindows) return canonicalWindowsOpenclawCliPath(normalized)
  if (!fs.existsSync(normalized) || isRejectedCliPath(normalized)) return null
  return normalized
}

function openclawProcessSpec(args = []) {
  const cliPath = resolveOpenclawCliPath()
  if (!cliPath) throw new Error('openclaw CLI 未安装')
  if (isWindows) {
    const cliArg = /[\s&()]/.test(cliPath) ? `"${cliPath}"` : cliPath
    if (path.extname(cliPath).toLowerCase() === '.js') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'node', cliArg, ...args],
      }
    }
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

function hasVersionSuffix(v) {
  return String(v || '').includes('-')
}

// 判断 CLI 版本是否与推荐版匹配（考虑汉化版 -zh.x 后缀差异）
function versionsMatch(cliVer, recommended) {
  if (cliVer === recommended) return true
  if (baseVersion(cliVer) !== baseVersion(recommended)) return false
  return !hasVersionSuffix(cliVer)
}

// 判断推荐版是否真的比当前版本更新（忽略 -zh.x 后缀）
function recommendedIsNewer(recommended, current) {
  const baseCmp = versionCompare(baseVersion(recommended), baseVersion(current))
  if (baseCmp !== 0) return baseCmp > 0
  if (hasVersionSuffix(recommended) && hasVersionSuffix(current)) {
    return versionGt(recommended, current)
  }
  return false
}

function cacheBustedSiteUrl(pathname, params = {}) {
  const url = new URL(pathname, SITE_BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    const normalized = String(value || '').trim()
    if (normalized) url.searchParams.set(key, normalized)
  }
  url.searchParams.set('_t', Date.now().toString())
  return url.toString()
}

function normalizeSiteLocale(locale) {
  const value = String(locale || '').trim().toLowerCase()
  return value.startsWith('zh') ? 'zh-CN' : 'en'
}

function normalizePublicUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  let url
  try {
    url = value.startsWith('/') ? new URL(value, SITE_BASE_URL) : new URL(value)
  } catch {
    return ''
  }
  const host = url.hostname.toLowerCase()
  if (host === 'claw.qt.cool') {
    url.protocol = 'https:'
    return url.toString()
  }
  if ((host === 'github.com' || host === 'api.github.com') && url.protocol === 'https:') {
    return url.toString()
  }
  return ''
}

function normalizeSiteUrlFields(value) {
  if (Array.isArray(value)) {
    value.forEach(normalizeSiteUrlFields)
    return value
  }
  if (!value || typeof value !== 'object') return value
  for (const key of ['downloadUrl', 'url', 'ctaUrl']) {
    if (typeof value[key] === 'string') {
      const normalized = normalizePublicUrl(value[key])
      if (normalized || value[key].trim()) value[key] = normalized
    }
  }
  for (const child of Object.values(value)) normalizeSiteUrlFields(child)
  return value
}

function assetDownloadable(asset) {
  return asset?.source !== 'unavailable' && typeof asset?.downloadUrl === 'string' && asset.downloadUrl.trim()
}

function assetMatches(asset, key, expected) {
  return String(asset?.[key] || '').toLowerCase() === expected
}

function selectRecommendedSiteAsset(assets = []) {
  const targetPlatform = isWindows ? 'windows' : isMac ? 'macos' : isLinux ? 'linux' : ''
  const targetArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const platformCandidates = assets.filter(asset => assetDownloadable(asset) && assetMatches(asset, 'platform', targetPlatform))
  const archMatches = (asset) => assetMatches(asset, 'arch', targetArch) || assetMatches(asset, 'arch', 'any')

  const remoteRecommended = platformCandidates.find(asset => asset?.recommended === true && archMatches(asset))
    || platformCandidates.find(asset => asset?.recommended === true)
  if (remoteRecommended) return remoteRecommended

  const candidates = assets.filter(assetDownloadable)
  if (isWindows) {
    const lightSetup = platformCandidates.find(asset => {
      const name = String(asset?.name || '').toLowerCase()
      return archMatches(asset)
        && assetMatches(asset, 'fileType', 'exe')
        && name.includes('x64-setup.exe')
        && !name.includes('full')
    })
    if (lightSetup) return lightSetup
    return platformCandidates.find(asset => archMatches(asset) && assetMatches(asset, 'fileType', 'exe')) || platformCandidates[0] || null
  }
  if (isMac) {
    return platformCandidates.find(asset => archMatches(asset) && assetMatches(asset, 'fileType', 'dmg')) || platformCandidates[0] || null
  }
  if (isLinux) {
    for (const fileType of ['appimage', 'deb', 'rpm']) {
      const hit = platformCandidates.find(asset => assetMatches(asset, 'fileType', fileType))
      if (hit) return hit
    }
  }
  return platformCandidates[0] || candidates[0] || null
}

async function getSitePanelUpdate() {
  const resp = await globalThis.fetch(cacheBustedSiteUrl('/api/v1/latest'), {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'ClawPanel' },
  })
  if (!resp.ok) throw new Error(`site: HTTP ${resp.status}`)
  const json = normalizeSiteUrlFields(await resp.json())
  const latest = String(json.version || json.tagName || '').replace(/^v/, '').trim()
  if (!latest) throw new Error('site: 未找到版本号')
  const assets = Array.isArray(json.assets) ? json.assets : []
  const recommendedAsset = selectRecommendedSiteAsset(assets)
  return {
    latest,
    url: SITE_BASE_URL,
    source: 'site',
    downloadUrl: recommendedAsset?.downloadUrl || SITE_BASE_URL,
    assets,
    recommendedAsset: recommendedAsset || null,
    releaseNotes: json.releaseNotes || '',
    publishedAt: json.publishedAt || '',
    tagName: json.tagName || '',
    downloads: json.downloads || null,
    telemetry: json.telemetry || null,
    update: json.update || null,
  }
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

  // 兼容两种 latest.json 格式：
  // 新格式（CI 生成）: { "editions": { "zh": { "version": "...", "base_url": "..." } } }
  // 旧格式（兼容）:   { "version": "...", "base_url": "..." }
  const editionObj = manifest?.editions?.zh
  const remoteVersion = editionObj?.version || manifest.version
  if (!remoteVersion) throw new Error('standalone 清单缺少 version 字段')
  if (version !== 'latest' && !versionsMatch(remoteVersion, version)) {
    throw new Error(`standalone 版本 ${remoteVersion} 与请求版本 ${version} 不匹配`)
  }

  const archivePrefix = editionObj ? 'openclaw-zh' : 'openclaw'
  const manifestBaseUrl = editionObj?.base_url || manifest.base_url
  const remoteBase = overrideBaseUrl || manifestBaseUrl || `${cfg.baseUrl}/${remoteVersion}`
  const ext = isWindows ? 'zip' : 'tar.gz'
  const filename = `${archivePrefix}-${remoteVersion}-${platform}.${ext}`
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

  const cliPath = path.join(installDir, binFile)
  const verifiedVersion = readVersionFromInstallation(cliPath)
  if (!verifiedVersion) {
    throw new Error('standalone 安装后无法读取目标 CLI 版本，已保留旧绑定')
  }
  if (!versionsMatch(verifiedVersion, remoteVersion)) {
    throw new Error(`standalone 安装校验失败：目标 CLI 版本为 ${verifiedVersion}，清单版本为 ${remoteVersion}，已保留旧绑定`)
  }
  logs.push(`目标 CLI 验证通过: ${cliPath} (${verifiedVersion})`)
  try {
    bindOpenclawCliPath(cliPath)
    logs.push(`已切换当前 CLI: ${cliPath}`)
  } catch (e) {
    logs.push(`⚠️ 自动绑定当前 CLI 失败: ${e.message || e}`)
  }

  logs.push(`✅ standalone 安装完成 (${verifiedVersion})`)
  logs.push(`安装目录: ${installDir}`)
  logs.push('旧安装已保留。如需清理，请在“安装管理与清理”里确认后处理。')
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

function resolveAgentSkillsDir(agentId) {
  const id = (agentId || '').trim()
  if (!id || id === 'main') return null
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ws = resolveAgentWorkspace(config, id)
    return path.join(ws, 'skills')
  } catch {
    return path.join(OPENCLAW_DIR, 'agents', id, 'workspace', 'skills')
  }
}

function collectLocalSkillRoots(agentSkillsDir) {
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

  if (agentSkillsDir) {
    pushRoot(agentSkillsDir, 'Agent 自定义', false)
  } else {
    pushRoot(path.join(OPENCLAW_DIR, 'skills'), 'OpenClaw 自定义', false)
  }
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

function scanLocalSkillsFallback(agentSkillsDir = null) {
  const roots = collectLocalSkillRoots(agentSkillsDir)
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
      cli: null,
    },
  }
}

function detectInstalledSource() {
  const activeCliPath = resolveOpenclawCliPath()
  const activeCliSource = classifyCliSource(activeCliPath)
  if (activeCliSource === 'standalone') return detectStandaloneSourceFromCliPath(activeCliPath) || 'chinese'
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
    if (fs.existsSync(path.join(saDir, 'openclaw')) || fs.existsSync(path.join(saDir, 'VERSION'))) return detectStandaloneSourceFromDir(saDir) || 'chinese'
    if (fs.existsSync('/opt/openclaw/openclaw')) return detectStandaloneSourceFromDir('/opt/openclaw') || 'chinese'
    // findOpenclawBin fallback
    const bin = findOpenclawBin()
    if (bin) {
      const lower = bin.replace(/\\/g, '/').toLowerCase()
      if (lower.includes('/openclaw-bin/') || lower.includes('/opt/openclaw/')) return detectStandaloneSourceFromCliPath(bin) || 'chinese'
      if (lower.includes('openclaw-zh') || lower.includes('@qingchencloud')) return 'chinese'
      return 'official'
    }
    return 'official'
  }
  if (isWindows) {
    const saDir = standaloneInstallDir()
    if (fs.existsSync(path.join(saDir, 'openclaw.cmd')) || fs.existsSync(path.join(saDir, 'VERSION'))) return detectStandaloneSourceFromDir(saDir) || 'chinese'
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

function detectActiveCliInstallMode() {
  const activeCliPath = resolveOpenclawCliPath()
  const activeCliSource = classifyCliSource(activeCliPath)
  if (activeCliSource === 'standalone') return 'standalone'
  if (['npm-zh', 'npm-official', 'npm-global'].includes(activeCliSource)) return 'npm'
  return 'unknown'
}

export function shouldFallbackStandaloneToNpm({ currentInstallMode = 'unknown', method = 'auto' } = {}) {
  return method === 'auto' && currentInstallMode !== 'standalone'
}

function getLocalOpenclawVersion() {
  let current = readVersionFromInstallation(resolveOpenclawCliPath())
  if (!current) {
    try {
      const saDir = standaloneInstallDir()
      const bin = isWindows ? path.join(saDir, 'openclaw.cmd') : path.join(saDir, 'openclaw')
      if (fs.existsSync(bin) || fs.existsSync(path.join(saDir, 'VERSION'))) {
        current = readVersionFromInstallation(bin)
      }
    } catch {}
  }
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
      const result = spawnOpenclawSync(['status', '--json'], { timeout: 2000, windowsHide: true, encoding: 'utf8', cwd: homedir() })
      const output = openclawResultOutput(result)
      const parsed = JSON.parse(output.slice(output.indexOf('{')))
      current = parsed?.runtimeVersion || null
    } catch {}
  }
  if (!current) {
    try {
      const result = spawnOpenclawSync(['--version'], { timeout: 3000, windowsHide: true, encoding: 'utf8', cwd: homedir() })
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
      _panelConfigCache = readJsonFileRelaxed(PANEL_CONFIG_PATH)
      if (!_panelConfigCache || typeof _panelConfigCache !== 'object' || Array.isArray(_panelConfigCache)) {
        throw new Error('clawpanel.json 格式错误')
      }
      _panelConfigCacheTime = now
      applyOpenclawPathConfig(_panelConfigCache)
      return JSON.parse(JSON.stringify(_panelConfigCache))
    }
  } catch {}
  applyOpenclawPathConfig({})
  return {}
}

function writePanelConfigFile(config) {
  const nextConfig = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {}
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
}

function bindOpenclawCliPath(cliPath) {
  const resolved = resolveOpenclawCliInput(cliPath) || cliPath
  const cfg = readPanelConfig()
  cfg.openclawCliPath = resolved
  writePanelConfigFile(cfg)
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
  'memory',
  'models',
  'plugins',
  'security',
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

export function decodeJsonFileContent(filePath) {
  const raw = fs.readFileSync(filePath)
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    return raw.subarray(3).toString('utf8')
  }
  return raw.toString('utf8')
}

export function readJsonFileRelaxed(filePath) {
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
    const currentScore = calibrationRichnessScore(current)
    if (currentScore === 0 && calibrationRichnessScore(backup) > 0) {
      return ['backup', backup]
    }
    return ['current', current]
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
  const config = readOpenclawConfigRequired()
  const origins = requiredControlUiOrigins()
  const existing = config?.gateway?.controlUi?.allowedOrigins || []
  // 合并：保留用户已有的 origins，只追加 ClawPanel 需要的
  const merged = [...new Set([...existing, ...origins])]
  // 幂等：已包含所有需要的 origin 时跳过写入
  if (origins.every(o => existing.includes(o))) return false
  // 只写入 allowedOrigins 增量，避免用陈旧全量快照覆盖并发保存的其它配置字段。
  const latest = readJsonFileRelaxed(CONFIG_PATH)
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return false
  const partial = {
    gateway: {
      controlUi: {
        allowedOrigins: merged,
      },
    },
  }
  const mergedConfig = mergeConfigsPreservingFields(latest, partial)
  writeOpenclawConfigFile(mergedConfig)
  return true
}

function readOpenclawConfigOptional() {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  const config = readJsonFileRelaxed(CONFIG_PATH)
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return cleanLoadedConfig(config)
}

function readOpenclawConfigRequired() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
  const config = readJsonFileRelaxed(CONFIG_PATH)
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('openclaw.json 格式错误')
  }
  return cleanLoadedConfig(config)
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

function modelEnvValuesForConfig(config) {
  const values = {}
  if (config?.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!isValidEnvKey(key)) continue
      if (typeof value === 'string') values[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value)
    }
  }
  const envPath = path.join(OPENCLAW_DIR, '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const parsed = parseDotenvLine(line)
      if (parsed && values[parsed[0]] === undefined) values[parsed[0]] = parsed[1]
    }
  }
  return values
}

function validateModelProviderEnvRefs(config) {
  const providers = config?.models?.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return
  const values = modelEnvValuesForConfig(config)
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue
    const envKey = modelApiKeyEnvRef(provider.apiKey)
    if (!envKey) continue
    const configured = values[envKey] !== undefined && String(values[envKey]).trim()
    const processEnv = process.env[envKey] !== undefined && String(process.env[envKey]).trim()
    if (!configured && !processEnv) {
      throw new Error(`模型服务商 "${providerName}" 的 API Key 引用了缺失的环境变量 "${envKey}"。请先在 OpenClaw env、~/.openclaw/.env 或当前进程环境中补齐，或删除该服务商后再保存。`)
    }
  }
}

function writeOpenclawConfigFile(config) {
  const cleaned = stripUiFields(config)
  validateModelProviderEnvRefs(cleaned)
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

function csvToStringArray(raw) {
  if (Array.isArray(raw)) return raw.map(item => String(item).trim()).filter(Boolean)
  if (typeof raw !== 'string') return []
  return raw.split(/[,;\n]/).map(item => item.trim()).filter(Boolean)
}

function normalizeDmPolicy(raw, fallback = 'pairing') {
  const value = String(raw || '').trim()
  if (!value) return fallback
  if (value === 'allow') return 'open'
  if (value === 'deny') return 'disabled'
  if (['pairing', 'allowlist', 'open', 'disabled'].includes(value)) return value
  return fallback
}

function normalizeGroupPolicy(raw, fallback = 'allowlist') {
  const value = String(raw || '').trim()
  if (!value) return fallback
  if (value === 'all') return 'open'
  if (value === 'mentioned') return 'open'
  if (value === 'deny') return 'disabled'
  if (['open', 'allowlist', 'disabled'].includes(value)) return value
  return fallback
}

function putWildcardAllowFromWhenOpen(entry, previousAllowFrom) {
  if (entry.dmPolicy !== 'open') return
  const allowFrom = csvToStringArray(previousAllowFrom)
  if (!allowFrom.includes('*')) allowFrom.push('*')
  entry.allowFrom = allowFrom
}

function platformSupportsTopLevelRequireMention(platform) {
  return ['feishu', 'slack', 'msteams', 'mattermost', 'googlechat', 'nextcloud-talk', 'twitch'].includes(platformStorageKey(platform))
}

function buildIrcGroupsFromForm(form = {}) {
  const groupIds = csvToStringArray(form.groups)
  if (!groupIds.length) return null
  const groups = {}
  for (const groupId of groupIds) {
    groups[groupId] = {}
    if (typeof form.requireMention === 'boolean') groups[groupId].requireMention = form.requireMention
  }
  return groups
}

function putIrcGroupFormValues(form, saved = {}) {
  const groups = saved?.groups && typeof saved.groups === 'object' && !Array.isArray(saved.groups)
    ? saved.groups
    : null
  if (!groups) return
  const groupIds = Object.keys(groups).filter(Boolean)
  if (groupIds.length) form.groups = groupIds.join(', ')
  const mentionValues = groupIds
    .map(groupId => groups[groupId]?.requireMention)
    .filter(value => typeof value === 'boolean')
  if (mentionValues.length && mentionValues.every(value => value === mentionValues[0])) {
    form.requireMention = mentionValues[0] ? 'true' : 'false'
  }
}

export function normalizeMessagingPlatformForm(platform, form = {}) {
  const storageKey = platformStorageKey(platform)
  const normalized = { ...(form || {}) }
  if (!Object.hasOwn(normalized, 'allowFrom') && Object.hasOwn(normalized, 'allowedUsers')) {
    normalized.allowFrom = normalized.allowedUsers
  }
  const needsAccessDefaults = ['telegram', 'discord', 'feishu', 'slack', 'signal', 'msteams', 'whatsapp', 'zalo', 'zalouser', 'line', 'mattermost', 'googlechat', 'nextcloud-talk', 'imessage', 'irc'].includes(storageKey)
  const hasDmField = Object.hasOwn(normalized, 'dmPolicy') || needsAccessDefaults
  const hasGroupField = Object.hasOwn(normalized, 'groupPolicy') || needsAccessDefaults

  if (hasDmField) {
    normalized.dmPolicy = normalizeDmPolicy(normalized.dmPolicy)
    if (Object.hasOwn(normalized, 'allowFrom')) normalized.allowFrom = csvToStringArray(normalized.allowFrom)
    putWildcardAllowFromWhenOpen(normalized, normalized.allowFrom)
  } else if (Object.hasOwn(normalized, 'allowFrom')) {
    normalized.allowFrom = csvToStringArray(normalized.allowFrom)
  }

  if (hasGroupField) {
    const requestedGroupPolicy = String(normalized.groupPolicy || '').trim()
    normalized.groupPolicy = normalizeGroupPolicy(requestedGroupPolicy)
    if (requestedGroupPolicy === 'mentioned' && platformSupportsTopLevelRequireMention(storageKey)) {
      normalized.requireMention = true
    } else if (requestedGroupPolicy !== 'mentioned') {
      if (platformSupportsTopLevelRequireMention(storageKey)) {
        normalized.requireMention = false
      } else if (Object.hasOwn(normalized, 'requireMention')) {
        normalized.requireMention = normalized.requireMention === true || normalized.requireMention === 'true'
      }
    }
  }

  if (Object.hasOwn(normalized, 'groupAllowFrom')) {
    normalized.groupAllowFrom = csvToStringArray(normalized.groupAllowFrom)
  }

  if (Object.hasOwn(normalized, 'allowedUserIds')) {
    normalized.allowedUserIds = csvToStringArray(normalized.allowedUserIds)
  }

  for (const key of ['promptStarters', 'delegatedAuthScopes', 'attachmentRoots', 'remoteAttachmentRoots', 'toolsAllow', 'allowedRoles', 'relays', 'channels', 'groups', 'mentionPatterns', 'groupChannels', 'dmAllowlist', 'groupInviteAllowlist', 'defaultAuthorizedShips']) {
    if (Object.hasOwn(normalized, key)) normalized[key] = csvToStringArray(normalized[key])
  }

  for (const key of ['mediaMaxMb', 'historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'probeTimeoutMs', 'debounceMs', 'rateLimitPerMinute', 'httpPort', 'webhookPort', 'feedbackReflectionCooldownMs', 'timeoutSeconds', 'reconnectMs', 'expiresIn', 'obtainmentTimestamp', 'port']) {
    if (!Object.hasOwn(normalized, key)) continue
    const value = String(normalized[key] || '').trim()
    if (!value) {
      delete normalized[key]
      continue
    }
    const numberValue = Number(value)
    if (Number.isFinite(numberValue) && numberValue >= 0) {
      normalized[key] = numberValue
    }
  }

  for (const key of ['dangerouslyAllowNameMatching', 'dangerouslyAllowPrivateNetwork', 'dangerouslyAllowInheritedWebhookPath', 'allowInsecureSsl', 'enabled', 'allowBots', 'blockStreaming', 'useManagedIdentity', 'typingIndicator', 'welcomeCard', 'groupWelcomeCard', 'feedbackEnabled', 'feedbackReflection', 'delegatedAuthEnabled', 'ssoEnabled', 'configWrites', 'includeAttachments', 'sendReadReceipts', 'coalesceSameSenderDms', 'selfChatMode', 'ackDirect', 'senderIsOwner', 'requireMention', 'tls', 'nickservEnabled', 'nickservRegister', 'autoDiscoverChannels', 'showModelSignature', 'autoAcceptDmInvites', 'autoAcceptGroupInvites']) {
    if (Object.hasOwn(normalized, key)) {
      const value = typeof normalized[key] === 'boolean'
        ? String(normalized[key])
        : String(normalized[key] || '').trim()
      if (!value) {
        delete normalized[key]
      } else {
        normalized[key] = value === 'true'
      }
    }
  }

  if (storageKey === 'feishu') {
    normalized.domain = String(normalized.domain || '').trim() || 'feishu'
    normalized.connectionMode = normalized.connectionMode || 'websocket'
    normalized.webhookPath = normalized.webhookPath || '/feishu/events'
    normalized.reactionNotifications = normalized.reactionNotifications || 'off'
    if (!Object.hasOwn(normalized, 'typingIndicator')) normalized.typingIndicator = true
    if (!Object.hasOwn(normalized, 'resolveSenderNames')) normalized.resolveSenderNames = true
  }

  if (storageKey === 'slack') {
    normalized.mode = normalized.mode || 'socket'
    normalized.webhookPath = normalized.webhookPath || '/slack/events'
    if (!Object.hasOwn(normalized, 'userTokenReadOnly')) normalized.userTokenReadOnly = false
  }

  return normalized
}

function csvForForm(raw) {
  return csvToStringArray(raw).join(', ')
}

function putStringFormValue(form, source, key) {
  if (typeof source?.[key] === 'string') form[key] = source[key]
}

function putBoolFormValue(form, source, key) {
  if (typeof source?.[key] === 'boolean') form[key] = source[key] ? 'true' : 'false'
}

function putCsvFormValue(form, source, key) {
  const value = csvForForm(source?.[key])
  if (value) form[key] = value
}

function putAccessPolicyFormValues(form, source, { telegramCompat = false, mentionCompat = false } = {}) {
  putStringFormValue(form, source, 'dmPolicy')
  putStringFormValue(form, source, 'groupPolicy')
  if (mentionCompat && form.groupPolicy === 'open' && source?.requireMention === true) {
    form.groupPolicy = 'mentioned'
  }
  putCsvFormValue(form, source, 'allowFrom')
  if (telegramCompat && form.allowFrom) form.allowedUsers = form.allowFrom
}

function normalizeSecretRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = String(value.source || '').trim()
  if (!['env', 'file', 'exec'].includes(source)) return null
  const provider = String(value.provider || 'default').trim() || 'default'
  const id = String(value.id || '').trim()
  if (!id) return null
  return { source, provider, id }
}

function formatSecretRefPlaceholder(ref) {
  const normalized = normalizeSecretRef(ref)
  if (!normalized) return ''
  return `SecretRef(${normalized.source}:${normalized.provider}:${normalized.id})`
}

function putSecretAwareFormValue(form, source, key) {
  if (typeof source?.[key] === 'string') {
    form[key] = source[key]
    return
  }
  const ref = normalizeSecretRef(source?.[key])
  if (!ref) return
  form[key] = formatSecretRefPlaceholder(ref)
  form.__secretRefs = {
    ...(form.__secretRefs || {}),
    [key]: ref,
  }
}

function putSecretAwareFormAlias(form, source, sourceKey, formKey) {
  if (typeof source?.[sourceKey] === 'string') {
    form[formKey] = source[sourceKey]
    return
  }
  const ref = normalizeSecretRef(source?.[sourceKey])
  if (!ref) return
  form[formKey] = formatSecretRefPlaceholder(ref)
  form.__secretRefs = {
    ...(form.__secretRefs || {}),
    [formKey]: ref,
  }
}

function resolveMessagingCredentialFormValueForSave({ form = {}, current = {}, formKey, currentKey = formKey }) {
  const rawValue = form?.[formKey]
  if (typeof rawValue !== 'string') return rawValue
  const value = rawValue.trim()
  const currentRef = normalizeSecretRef(current?.[currentKey])
  if (currentRef && (!value || value === formatSecretRefPlaceholder(currentRef))) {
    return currentRef
  }
  return value || undefined
}

export function resolveMessagingCredentialValueForSave({ form = {}, current = {}, key }) {
  return resolveMessagingCredentialFormValueForSave({ form, current, formKey: key })
}

const MESSAGING_CREDENTIAL_FIELDS = [
  'accessToken',
  'appId',
  'appPassword',
  'appSecret',
  'appToken',
  'apiPassword',
  'apiPasswordFile',
  'botSecret',
  'botSecretFile',
  'botToken',
  'channelAccessToken',
  'channelSecret',
  'code',
  'clientId',
  'clientSecret',
  'refreshToken',
  'gatewayPassword',
  'gatewayToken',
  'password',
  'passwordFile',
  'privateKey',
  'secretFile',
  'serviceAccount',
  'serviceAccountFile',
  'serviceAccountRef',
  'signingSecret',
  'token',
  'tokenFile',
  'webhookSecret',
]

function hasConfiguredMessagingValue(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (normalizeSecretRef(value)) return true
  return value !== undefined && value !== null
}

function isEnabledFormFlag(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase())
  }
  return false
}

function msteamsCredentialMissingLabels(form = {}) {
  const missing = []
  if (!hasConfiguredMessagingValue(form?.appId)) missing.push('App ID')
  if (missing.length) return missing

  if (hasConfiguredMessagingValue(form?.appPassword)) return []
  if (isEnabledFormFlag(form?.useManagedIdentity)) return []

  const authType = String(form?.authType || '').trim().toLowerCase()
  const hasFederatedCredential = hasConfiguredMessagingValue(form?.certificatePath) || hasConfiguredMessagingValue(form?.certificateThumbprint)
  if (authType === 'federated' && hasFederatedCredential) return []

  if (authType === 'federated') {
    return ['Certificate Path / Certificate Thumbprint / Managed Identity / App Password']
  }
  return ['App Password']
}

function channelRootHasMessagingCredential(root) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false
  return MESSAGING_CREDENTIAL_FIELDS.some(key => hasConfiguredMessagingValue(root[key]))
}

function channelAnyCredentialFields(platform) {
  const storageKey = platformStorageKey(platform)
  if (storageKey === 'zalo') {
    return [['botToken', 'Bot Token'], ['tokenFile', 'Token File']]
  }
  if (storageKey === 'googlechat') {
    return [
      ['serviceAccountFile', 'Service Account File'],
      ['serviceAccount', 'Service Account JSON'],
      ['serviceAccountRef', 'Service Account SecretRef'],
    ]
  }
  return []
}

function channelAnyCredentialGroups(platform) {
  const storageKey = platformStorageKey(platform)
  if (storageKey === 'line') {
    return [
      { label: 'Channel Access Token 或 Token File', fields: [['channelAccessToken', 'Channel Access Token'], ['tokenFile', 'Token File']] },
      { label: 'Channel Secret 或 Secret File', fields: [['channelSecret', 'Channel Secret'], ['secretFile', 'Secret File']] },
    ]
  }
  if (storageKey === 'nextcloud-talk') {
    return [
      { label: 'Bot Secret 或 Secret File', fields: [['botSecret', 'Bot Secret'], ['botSecretFile', 'Secret File']] },
    ]
  }
  return []
}

const CHANNEL_DIAG_REQUIRED_FIELDS = {
  telegram: [['botToken', 'Bot Token']],
  discord: [['token', 'Bot Token']],
  feishu: [['appId', 'App ID'], ['appSecret', 'App Secret']],
  dingtalk: [['clientId', 'Client ID'], ['clientSecret', 'Client Secret']],
  'dingtalk-connector': [['clientId', 'Client ID'], ['clientSecret', 'Client Secret']],
  mattermost: [['botToken', 'Bot Token'], ['baseUrl', 'Base URL']],
  'synology-chat': [['token', 'Token'], ['incomingUrl', 'Incoming URL']],
  clickclack: [['baseUrl', 'Base URL'], ['token', 'Token'], ['workspace', 'Workspace']],
  'nextcloud-talk': [['baseUrl', 'Base URL']],
  nostr: [['privateKey', 'Private Key']],
  irc: [['host', 'Host'], ['nick', 'Nick']],
  tlon: [['ship', 'Ship'], ['url', 'URL'], ['code', 'Code']],
  twitch: [['username', 'Username'], ['accessToken', 'Access Token'], ['clientId', 'Client ID'], ['channel', 'Channel']],
  signal: [['account', 'Signal 账号']],
}

function requiredChannelCredentialFields(platform, form = {}) {
  const storageKey = platformStorageKey(platform)
  if (storageKey === 'slack') {
    const mode = String(form.mode || 'socket').trim() || 'socket'
    return [
      ['botToken', 'Bot Token'],
      mode === 'http' ? ['signingSecret', 'Signing Secret'] : ['appToken', 'App Token'],
    ]
  }
  if (storageKey === 'matrix') {
    if (form.accessToken) return [['accessToken', 'Access Token']]
    return [['homeserver', 'Homeserver'], ['userId', 'User ID'], ['password', 'Password']]
  }
  if (storageKey === 'msteams') {
    return msteamsCredentialMissingLabels(form).map(label => [label === 'App ID' ? 'appId' : '__msteamsAuth', label])
  }
  return CHANNEL_DIAG_REQUIRED_FIELDS[storageKey] || []
}

function channelDiagnosisCredentialsReady(platform, form = {}) {
  if (['zalouser', 'whatsapp'].includes(platformStorageKey(platform))) return true
  if (platformStorageKey(platform) === 'msteams') return msteamsCredentialMissingLabels(form).length === 0
  const requiredFields = requiredChannelCredentialFields(platform, form)
  const anyGroups = channelAnyCredentialGroups(platform)
  if (requiredFields.length) {
    return requiredFields.every(([key]) => hasConfiguredMessagingValue(form?.[key]))
      && anyGroups.every(group => group.fields.some(([key]) => hasConfiguredMessagingValue(form?.[key])))
  }
  if (anyGroups.length) {
    return anyGroups.every(group => group.fields.some(([key]) => hasConfiguredMessagingValue(form?.[key])))
  }
  const anyFields = channelAnyCredentialFields(platform)
  if (anyFields.length) {
    return anyFields.some(([key]) => hasConfiguredMessagingValue(form?.[key]))
  }
  return channelRootHasMessagingCredential(form)
}

function compactDiagnosticDetails(values = []) {
  return values.map(value => String(value || '').trim()).filter(Boolean).join('；')
}

export function buildOpenClawChannelDiagnosis({
  platform,
  accountId = '',
  configExists = false,
  channelEnabled = true,
  form = {},
  verifyResult = null,
  verifyError = '',
} = {}) {
  const storageKey = platformStorageKey(platform)
  const displayPlatform = platformListId(storageKey)
  const checks = []

  checks.push({
    id: 'config_exists',
    ok: !!configExists,
    title: '渠道配置已保存',
    detail: configExists
      ? `已读取 channels.${storageKey}${accountId ? `.accounts.${accountId}` : ''} 的配置。`
      : `未在 openclaw.json 中找到 ${displayPlatform} 渠道配置，请先在「渠道列表」接入并保存。`,
  })

  checks.push({
    id: 'channel_enabled',
    ok: !!channelEnabled,
    title: '渠道已启用',
    detail: channelEnabled
      ? '渠道未被显式禁用，Gateway 重启/重载后会尝试加载。'
      : `channels.${storageKey}.enabled 为 false，请先在渠道列表中启用该渠道。`,
  })

  const requiredFields = requiredChannelCredentialFields(storageKey, form)
  const anyFields = channelAnyCredentialFields(storageKey)
  const anyGroups = channelAnyCredentialGroups(storageKey)
  const missing = storageKey === 'msteams'
    ? msteamsCredentialMissingLabels(form)
    : requiredFields
        .filter(([key]) => !hasConfiguredMessagingValue(form?.[key]))
        .map(([, label]) => label)
  const missingGroups = anyGroups
    .filter(group => !group.fields.some(([key]) => hasConfiguredMessagingValue(form?.[key])))
    .map(group => group.label)
  const hasAnyCredential = channelRootHasMessagingCredential(form)
  const anyCredentialOk = anyFields.length ? anyFields.some(([key]) => hasConfiguredMessagingValue(form?.[key])) : false
  const credentialOk = ['zalouser', 'imessage', 'whatsapp'].includes(storageKey)
    ? !!configExists
    : (requiredFields.length
        ? missing.length === 0 && missingGroups.length === 0
        : (anyGroups.length
            ? missingGroups.length === 0
            : (anyFields.length ? anyCredentialOk : hasAnyCredential)))
  const anyLabels = anyFields.map(([, label]) => label).join(' / ')
  checks.push({
    id: 'credentials',
    ok: credentialOk,
    title: storageKey === 'zalouser'
      ? '登录/会话配置'
      : (storageKey === 'imessage'
          ? '桥接运行配置'
          : (storageKey === 'whatsapp' ? '扫码/会话配置' : '必要凭证字段')),
    detail: storageKey === 'zalouser'
      ? 'Zalo Personal 通过二维码登录保存本地会话；配置已保存后，请按手动命令完成或刷新登录。'
      : storageKey === 'imessage'
        ? (configExists
            ? 'iMessage 使用本机或远端桥接运行，不需要 Bot Token；已保存基础运行配置。'
            : '尚未保存 iMessage 渠道配置，请先填写并保存。')
      : storageKey === 'whatsapp'
        ? (configExists
            ? 'WhatsApp 通过扫码登录保存本地会话，不需要 Bot Token；请使用扫码登录完成设备连接。'
            : '尚未保存 WhatsApp 渠道配置，请先填写并保存。')
      : (credentialOk
          ? (requiredFields.length
              ? `已填写 ${requiredFields.map(([, label]) => label).join(' / ')}${anyGroups.length ? `；${anyGroups.map(group => group.label).join('；')}` : ''}。`
              : (anyGroups.length
                  ? `已填写 ${anyGroups.map(group => group.label).join('；')}。`
                  : (anyFields.length ? `已填写 ${anyLabels} 其中一项。` : '已检测到可用凭证字段。')))
          : (missing.length
              ? `缺少 ${missing.join(' / ')}，请补齐后保存。`
              : (missingGroups.length
                  ? `缺少 ${missingGroups.join('；')}，请补齐后保存。`
                  : (anyFields.length ? `缺少 ${anyLabels}，至少填写一项后保存。` : '未检测到可用凭证字段，请检查渠道配置。')))),
  })

  if (verifyError) {
    checks.push({
      id: 'online_verify',
      ok: false,
      title: '平台在线校验',
      detail: verifyError,
    })
  } else if (verifyResult) {
    const valid = verifyResult.valid === true
    const errors = Array.isArray(verifyResult.errors) ? verifyResult.errors : []
    const warnings = Array.isArray(verifyResult.warnings) ? verifyResult.warnings : []
    const details = Array.isArray(verifyResult.details) ? verifyResult.details : []
    checks.push({
      id: 'online_verify',
      ok: valid || (!valid && warnings.length > 0 && errors.length === 0),
      title: '平台在线校验',
      detail: valid
        ? (compactDiagnosticDetails(details) || '平台 API 已接受当前凭证。')
        : (compactDiagnosticDetails(errors) || compactDiagnosticDetails(warnings) || '该平台暂不支持在线校验。'),
    })
  } else {
    checks.push({
      id: 'online_verify',
      ok: true,
      title: '平台在线校验',
      detail: '未执行在线校验，仅完成本地配置检查。',
    })
  }

  const failed = checks.filter(check => !check.ok)
  return {
    ok: failed.length === 0,
    overallReady: failed.length === 0,
    platform: displayPlatform,
    accountId: accountId || null,
    checks,
    userHints: failed.length
      ? [
          '先修复未通过的检查项，保存渠道后重启或重载 Gateway。',
          '在线校验只能证明平台凭证可用；群聊白名单、机器人邀请和平台回调仍需在对应平台控制台确认。',
        ]
      : [
          '配置侧检查已通过。若仍收不到消息，请确认 Gateway 已重启、机器人已加入目标会话，并检查 Gateway 日志。',
        ],
  }
}

function preserveMessagingCredentialRefs(entry, form, current) {
  delete entry.__secretRefs
  for (const key of MESSAGING_CREDENTIAL_FIELDS) {
    if (!Object.hasOwn(form || {}, key)) continue
    const value = resolveMessagingCredentialValueForSave({ form, current, key })
    if (value === undefined) {
      delete entry[key]
    } else {
      entry[key] = value
    }
  }
  return entry
}

export function buildMessagingPlatformFormValues(platform, saved = {}, options = {}) {
  if (!saved || typeof saved !== 'object') return {}
  const form = {}
  const storageKey = platformStorageKey(platform)

  if (storageKey === 'telegram') {
    putSecretAwareFormValue(form, saved, 'botToken')
    putAccessPolicyFormValues(form, saved, { telegramCompat: true })
    return form
  }

  if (storageKey === 'discord') {
    putSecretAwareFormValue(form, saved, 'token')
    putStringFormValue(form, saved, 'applicationId')
    putAccessPolicyFormValues(form, saved)
    const guilds = saved.guilds && typeof saved.guilds === 'object' ? saved.guilds : null
    const guildId = guilds ? Object.keys(guilds)[0] : ''
    if (guildId) {
      form.guildId = guildId
      const channels = guilds[guildId]?.channels && typeof guilds[guildId].channels === 'object'
        ? guilds[guildId].channels
        : null
      const channelId = channels ? Object.keys(channels).find(id => id !== '*') : ''
      if (channelId) form.channelId = channelId
    }
    return form
  }

  if (storageKey === 'feishu') {
    putSecretAwareFormValue(form, saved, 'appId')
    putSecretAwareFormValue(form, saved, 'appSecret')
    const shared = options.channelRoot && typeof options.channelRoot === 'object'
      ? { ...saved, ...options.channelRoot }
      : saved
    for (const key of ['domain', 'connectionMode', 'webhookPath', 'reactionNotifications', 'textChunkLimit', 'mediaMaxMb']) {
      putStringFormValue(form, shared, key)
    }
    putAccessPolicyFormValues(form, shared, { mentionCompat: true })
    putBoolFormValue(form, shared, 'typingIndicator')
    putBoolFormValue(form, shared, 'resolveSenderNames')
    putBoolFormValue(form, shared, 'requireMention')
    return form
  }

  if (storageKey === 'slack') {
    for (const key of ['mode', 'botToken', 'appToken', 'signingSecret', 'webhookPath', 'teamId', 'appId', 'socketMode']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putAccessPolicyFormValues(form, saved, { mentionCompat: true })
    putBoolFormValue(form, saved, 'userTokenReadOnly')
    putBoolFormValue(form, saved, 'requireMention')
    return form
  }

  if (storageKey === 'whatsapp') {
    putAccessPolicyFormValues(form, saved)
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'enabled')
    for (const key of ['configWrites', 'sendReadReceipts', 'selfChatMode', 'blockStreaming']) {
      putBoolFormValue(form, saved, key)
    }
    for (const key of ['defaultTo', 'contextVisibility', 'chunkMode', 'reactionLevel', 'replyToMode', 'messagePrefix', 'responsePrefix']) {
      putStringFormValue(form, saved, key)
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'debounceMs', 'textChunkLimit']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    if (saved?.ackReaction && typeof saved.ackReaction === 'object') {
      putStringFormValue(form, saved.ackReaction, 'emoji')
      if (form.emoji) {
        form.ackEmoji = form.emoji
        delete form.emoji
      }
      putBoolFormValue(form, saved.ackReaction, 'direct')
      if (form.direct) {
        form.ackDirect = form.direct
        delete form.direct
      }
      putStringFormValue(form, saved.ackReaction, 'group')
      if (form.group) {
        form.ackGroup = form.group
        delete form.group
      }
    }
    return form
  }

  if (storageKey === 'signal') {
    for (const key of ['account', 'cliPath', 'httpUrl', 'httpHost', 'httpPort', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putAccessPolicyFormValues(form, saved)
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'blockStreaming')
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    return form
  }

  if (storageKey === 'matrix') {
    for (const key of ['homeserver', 'accessToken', 'userId', 'password', 'deviceId']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putAccessPolicyFormValues(form, saved)
    putBoolFormValue(form, saved, 'e2ee')
    if (form.accessToken) form.authMode = 'token'
    else if (form.userId || form.password) form.authMode = 'password'
    return form
  }

  if (storageKey === 'msteams') {
    for (const key of ['appId', 'appPassword', 'tenantId', 'authType', 'certificatePath', 'certificateThumbprint', 'managedIdentityClientId', 'botEndpoint', 'replyStyle', 'sharePointSiteId', 'responsePrefix', 'ssoConnectionName']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putStringFormValue(form, saved?.webhook, 'path')
    if (form.path) {
      form.webhookPath = form.path
      delete form.path
    }
    if (typeof saved?.webhook?.port === 'number') form.webhookPort = String(saved.webhook.port)
    putAccessPolicyFormValues(form, saved, { mentionCompat: true })
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'requireMention')
    for (const key of ['useManagedIdentity', 'blockStreaming', 'typingIndicator', 'welcomeCard', 'groupWelcomeCard', 'feedbackEnabled', 'feedbackReflection']) {
      putBoolFormValue(form, saved, key)
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb', 'feedbackReflectionCooldownMs']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    putCsvFormValue(form, saved, 'promptStarters')
    putBoolFormValue(form, saved?.delegatedAuth, 'enabled')
    if (form.enabled) {
      form.delegatedAuthEnabled = form.enabled
      delete form.enabled
    }
    putCsvFormValue(form, saved?.delegatedAuth, 'scopes')
    if (form.scopes) {
      form.delegatedAuthScopes = form.scopes
      delete form.scopes
    }
    putBoolFormValue(form, saved?.sso, 'enabled')
    if (form.enabled) {
      form.ssoEnabled = form.enabled
      delete form.enabled
    }
    putStringFormValue(form, saved?.sso, 'connectionName')
    if (form.connectionName) {
      form.ssoConnectionName = form.connectionName
      delete form.connectionName
    }
    return form
  }

  if (storageKey === 'line') {
    for (const key of ['channelAccessToken', 'tokenFile', 'channelSecret', 'secretFile', 'webhookPath', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putAccessPolicyFormValues(form, saved)
    putCsvFormValue(form, saved, 'groupAllowFrom')
    if (typeof saved.mediaMaxMb === 'number') form.mediaMaxMb = String(saved.mediaMaxMb)
    return form
  }

  if (storageKey === 'mattermost') {
    for (const key of ['botToken', 'baseUrl', 'name', 'replyToMode', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putAccessPolicyFormValues(form, saved, { mentionCompat: true })
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'dangerouslyAllowNameMatching')
    putBoolFormValue(form, saved?.network, 'dangerouslyAllowPrivateNetwork')
    putStringFormValue(form, saved?.commands, 'callbackPath')
    putStringFormValue(form, saved?.commands, 'callbackUrl')
    return form
  }

  if (storageKey === 'clickclack') {
    for (const key of ['name', 'baseUrl', 'token', 'workspace', 'botUserId', 'agentId', 'replyMode', 'model', 'systemPrompt', 'defaultTo']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putBoolFormValue(form, saved, 'enabled')
    putBoolFormValue(form, saved, 'senderIsOwner')
    putCsvFormValue(form, saved, 'toolsAllow')
    putCsvFormValue(form, saved, 'allowFrom')
    for (const key of ['timeoutSeconds', 'reconnectMs']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    return form
  }

  if (storageKey === 'nextcloud-talk') {
    for (const key of ['name', 'baseUrl', 'botSecret', 'botSecretFile', 'apiUser', 'apiPassword', 'apiPasswordFile', 'webhookHost', 'webhookPath', 'webhookPublicUrl', 'chunkMode', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putBoolFormValue(form, saved, 'enabled')
    putAccessPolicyFormValues(form, saved, { mentionCompat: true })
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'blockStreaming')
    putBoolFormValue(form, saved?.network, 'dangerouslyAllowPrivateNetwork')
    for (const key of ['webhookPort', 'historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'textChunkLimit']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    return form
  }

  if (storageKey === 'twitch') {
    for (const key of ['username', 'accessToken', 'clientId', 'channel', 'responsePrefix', 'clientSecret', 'refreshToken']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putBoolFormValue(form, saved, 'enabled')
    putCsvFormValue(form, saved, 'allowFrom')
    putCsvFormValue(form, saved, 'allowedRoles')
    putBoolFormValue(form, saved, 'requireMention')
    for (const key of ['expiresIn', 'obtainmentTimestamp']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    return form
  }

  if (storageKey === 'nostr') {
    putSecretAwareFormValue(form, saved, 'privateKey')
    for (const key of ['name', 'defaultAccount', 'dmPolicy']) {
      putStringFormValue(form, saved, key)
    }
    putBoolFormValue(form, saved, 'enabled')
    putCsvFormValue(form, saved, 'relays')
    putCsvFormValue(form, saved, 'allowFrom')
    const profile = saved.profile && typeof saved.profile === 'object' ? saved.profile : {}
    const profileMap = {
      name: 'profileName',
      displayName: 'profileDisplayName',
      about: 'profileAbout',
      picture: 'profilePicture',
      banner: 'profileBanner',
      website: 'profileWebsite',
      nip05: 'profileNip05',
      lud16: 'profileLud16',
    }
    for (const [sourceKey, formKey] of Object.entries(profileMap)) {
      if (typeof profile[sourceKey] === 'string') form[formKey] = profile[sourceKey]
    }
    return form
  }

  if (storageKey === 'irc') {
    for (const key of ['name', 'host', 'nick', 'username', 'realname', 'password', 'passwordFile', 'defaultTo', 'chunkMode', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putBoolFormValue(form, saved, 'enabled')
    putBoolFormValue(form, saved, 'tls')
    putBoolFormValue(form, saved, 'blockStreaming')
    putBoolFormValue(form, saved, 'dangerouslyAllowNameMatching')
    putAccessPolicyFormValues(form, saved)
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putCsvFormValue(form, saved, 'channels')
    putCsvFormValue(form, saved, 'mentionPatterns')
    putIrcGroupFormValues(form, saved)
    for (const key of ['port', 'historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'textChunkLimit']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    const nickserv = saved.nickserv && typeof saved.nickserv === 'object' ? saved.nickserv : {}
    if (typeof nickserv.enabled === 'boolean') {
      form.nickservEnabled = nickserv.enabled ? 'true' : 'false'
    }
    putSecretAwareFormAlias(form, nickserv, 'service', 'nickservService')
    putSecretAwareFormAlias(form, nickserv, 'password', 'nickservPassword')
    putSecretAwareFormAlias(form, nickserv, 'passwordFile', 'nickservPasswordFile')
    if (typeof nickserv.register === 'boolean') {
      form.nickservRegister = nickserv.register ? 'true' : 'false'
    }
    if (typeof nickserv.registerEmail === 'string') {
      form.nickservRegisterEmail = nickserv.registerEmail
    }
    return form
  }

  if (storageKey === 'tlon') {
    const shared = options.channelRoot && typeof options.channelRoot === 'object'
      ? { ...options.channelRoot, ...saved }
      : saved
    if (options.channelRoot?.network && !saved.network) shared.network = options.channelRoot.network
    for (const key of ['name', 'ship', 'url', 'code', 'responsePrefix', 'ownerShip']) {
      putSecretAwareFormValue(form, shared, key)
    }
    putBoolFormValue(form, shared, 'enabled')
    putBoolFormValue(form, shared?.network, 'dangerouslyAllowPrivateNetwork')
    putCsvFormValue(form, shared, 'groupChannels')
    putCsvFormValue(form, shared, 'dmAllowlist')
    putCsvFormValue(form, shared, 'groupInviteAllowlist')
    putCsvFormValue(form, shared, 'defaultAuthorizedShips')
    for (const key of ['autoDiscoverChannels', 'showModelSignature', 'autoAcceptDmInvites', 'autoAcceptGroupInvites']) {
      putBoolFormValue(form, shared, key)
    }
    return form
  }

  if (storageKey === 'synology-chat') {
    for (const key of ['token', 'incomingUrl', 'nasHost', 'webhookPath', 'botName']) {
      putSecretAwareFormValue(form, saved, key)
    }
    putStringFormValue(form, saved, 'dmPolicy')
    putCsvFormValue(form, saved, 'allowedUserIds')
    if (typeof saved.rateLimitPerMinute === 'number') form.rateLimitPerMinute = String(saved.rateLimitPerMinute)
    putBoolFormValue(form, saved, 'dangerouslyAllowNameMatching')
    putBoolFormValue(form, saved, 'dangerouslyAllowInheritedWebhookPath')
    putBoolFormValue(form, saved, 'allowInsecureSsl')
    return form
  }

  if (storageKey === 'googlechat') {
    for (const key of ['serviceAccount', 'serviceAccountFile', 'serviceAccountRef', 'audienceType', 'audience', 'appPrincipal', 'webhookPath', 'webhookUrl', 'botUser', 'chunkMode', 'replyToMode', 'typingIndicator', 'responsePrefix']) {
      putSecretAwareFormValue(form, saved, key)
    }
    const dm = saved.dm && typeof saved.dm === 'object' ? saved.dm : {}
    putStringFormValue(form, dm, 'policy')
    if (form.policy && !form.dmPolicy) {
      form.dmPolicy = form.policy
      delete form.policy
    }
    putCsvFormValue(form, dm, 'allowFrom')
    putStringFormValue(form, saved, 'groupPolicy')
    putCsvFormValue(form, saved, 'groupAllowFrom')
    putBoolFormValue(form, saved, 'requireMention')
    putBoolFormValue(form, saved, 'dangerouslyAllowNameMatching')
    putBoolFormValue(form, saved, 'allowBots')
    putBoolFormValue(form, saved, 'blockStreaming')
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb']) {
      if (typeof saved[key] === 'number') form[key] = String(saved[key])
    }
    return form
  }

  for (const [key, value] of Object.entries(saved)) {
    if (key === 'enabled' || key === 'accounts') continue
    if (typeof value === 'string') form[key] = value
    else if (normalizeSecretRef(value)) putSecretAwareFormValue(form, saved, key)
    else if (Array.isArray(value)) {
      const csv = csvForForm(value)
      if (csv) form[key] = csv
    } else if (typeof value === 'boolean') {
      form[key] = value ? 'true' : 'false'
    } else if (typeof value === 'number') {
      form[key] = String(value)
    }
  }
  return form
}

const HERMES_CHANNEL_PLATFORMS = [
  'telegram',
  'discord',
  'slack',
  'feishu',
  'dingtalk',
  'teams',
  'google_chat',
  'irc',
  'line',
  'simplex',
]

function normalizeHermesPlatform(platform) {
  const p = String(platform || '').trim().toLowerCase()
  return HERMES_CHANNEL_PLATFORMS.includes(p) ? p : ''
}

const HERMES_SESSION_RESET_MODES = new Set(['both', 'idle', 'daily', 'none'])
const HERMES_STREAMING_TRANSPORTS = new Set(['auto', 'draft', 'edit', 'off'])
const HERMES_CODE_EXECUTION_MODES = new Set(['project', 'strict'])
const HERMES_TERMINAL_BACKENDS = new Set(['local', 'ssh', 'docker', 'singularity', 'modal', 'daytona', 'vercel_sandbox'])
const HERMES_TERMINAL_MODAL_MODES = new Set(['auto', 'managed', 'direct'])
const HERMES_TERMINAL_VERCEL_RUNTIMES = new Set(['node24', 'node22', 'python3.13'])
const HERMES_BROWSER_ENGINES = new Set(['auto', 'lightpanda', 'chrome'])
const HERMES_BROWSER_DIALOG_POLICIES = new Set(['must_respond', 'auto_dismiss', 'auto_accept'])
const HERMES_WEB_BACKENDS = new Set(['tavily', 'firecrawl', 'parallel-free', 'parallel', 'exa', 'searxng', 'brave', 'brave_free', 'ddgs', 'xai', 'native'])
const HERMES_LSP_WAIT_MODES = new Set(['document', 'full'])
const HERMES_LSP_INSTALL_STRATEGIES = new Set(['auto', 'manual', 'off'])
const HERMES_MODEL_CATALOG_DEFAULT_URL = 'https://hermes-agent.nousresearch.com/docs/api/model-catalog.json'
const HERMES_STT_PROVIDERS = new Set(['auto', 'local', 'groq', 'openai', 'mistral'])
const HERMES_STT_LOCAL_MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'])
const HERMES_STT_OPENAI_MODELS = new Set(['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'])
const HERMES_STT_MISTRAL_MODELS = new Set(['voxtral-mini-latest', 'voxtral-mini-2602'])
const HERMES_TTS_PROVIDERS = new Set(['edge', 'elevenlabs', 'openai', 'xai', 'minimax', 'mistral', 'gemini', 'neutts', 'kittentts', 'piper'])
const HERMES_TTS_OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
const HERMES_AUXILIARY_PROVIDERS = new Set(['auto', 'openrouter', 'nous', 'gemini', 'ollama-cloud', 'codex', 'main'])
const HERMES_APPROVAL_MODES = new Set(['manual', 'smart', 'off'])
const HERMES_APPROVAL_CRON_MODES = new Set(['deny', 'approve'])
const HERMES_LOGGING_LEVELS = new Set(['DEBUG', 'INFO', 'WARNING'])
const HERMES_AGENT_IMAGE_INPUT_MODES = new Set(['auto', 'native', 'text'])
const HERMES_AGENT_REASONING_EFFORTS = new Set(['xhigh', 'high', 'medium', 'low', 'minimal', 'none'])
const HERMES_PROMPT_CACHE_TTLS = new Set(['5m', '1h'])
const HERMES_PROVIDER_ROUTING_SORTS = new Set(['price', 'throughput', 'latency'])
const HERMES_PROVIDER_ROUTING_DATA_COLLECTION = new Set(['allow', 'deny'])
const HERMES_DISPLAY_TOOL_PROGRESS_VALUES = new Set(['off', 'new', 'all', 'verbose'])
const HERMES_DISPLAY_STREAMING_VALUES = new Set(['inherit', 'true', 'false'])
const HERMES_TELEGRAM_REPLY_TO_MODE_VALUES = new Set(['off', 'first', 'all'])
const HERMES_DISPLAY_RESUME_VALUES = new Set(['full', 'minimal'])
const HERMES_DISPLAY_BUSY_INPUT_MODES = new Set(['interrupt', 'queue', 'steer'])
const HERMES_DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS = new Set(['off', 'result', 'error', 'all'])
const HERMES_DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES = new Set(['render', 'strip', 'raw'])
const HERMES_DISPLAY_LANGUAGE_VALUES = new Set(['en', 'zh', 'zh-hant', 'ja', 'de', 'es', 'fr', 'tr', 'uk', 'af', 'ko', 'it', 'ga', 'pt', 'ru', 'hu'])
const HERMES_DISPLAY_SKINS = new Set(['default', 'ares', 'mono', 'slate', 'daylight', 'warm-lightmode', 'poseidon', 'sisyphus', 'charizard'])
const HERMES_RUNTIME_FOOTER_FIELDS = new Set(['model', 'context_pct', 'cwd', 'duration', 'tokens', 'cost'])
const HERMES_TUI_STATUS_INDICATORS = new Set(['kaomoji', 'emoji', 'unicode', 'ascii'])
const HERMES_COPY_SHORTCUTS = new Set(['auto', 'ctrl_c', 'ctrl_shift_c', 'disabled'])
const HERMES_HOOK_EVENTS = new Set([
  'pre_tool_call',
  'post_tool_call',
  'pre_llm_call',
  'post_llm_call',
  'pre_api_request',
  'post_api_request',
  'on_session_start',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'subagent_stop',
])
const HERMES_DEFAULT_PLATFORM_TOOLSETS = {
  cli: ['hermes-cli'],
  telegram: ['hermes-telegram'],
  discord: ['hermes-discord'],
  whatsapp: ['hermes-whatsapp'],
  slack: ['hermes-slack'],
  signal: ['hermes-signal'],
  homeassistant: ['hermes-homeassistant'],
  qqbot: ['hermes-qqbot'],
  yuanbao: ['hermes-yuanbao'],
  teams: ['hermes-teams'],
  google_chat: ['hermes-google_chat'],
}

function parseHermesInteger(value, key, fallback, min, max, strict = false) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    if (strict) throw new Error(`${key} 不能为空`)
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || String(parsed) !== raw.replace(/^\+/, '')) {
    if (strict) throw new Error(`${key} 必须是整数`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    if (strict) throw new Error(`${key} 必须在 ${min}-${max} 范围内`)
    return fallback
  }
  return parsed
}

function parseHermesFloat(value, key, fallback, min, max, strict = false) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    if (strict) throw new Error(`${key} 不能为空`)
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) {
    if (strict) throw new Error(`${key} 必须是数字`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    if (strict) throw new Error(`${key} 必须在 ${min}-${max} 范围内`)
    return fallback
  }
  return Number(parsed.toFixed(4))
}

function readHermesBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function formHermesBool(form, key, fallback) {
  return readHermesBool(form?.[key], fallback)
}

function normalizeHermesKanbanOptionalString(value, key, strict = false) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    if (strict) throw new Error(`${key} must be a string`)
    return ''
  }
  return value.trim()
}

function normalizeHermesStreamingTransport(value, strict = false) {
  const transport = String(value ?? '').trim().toLowerCase() || 'edit'
  if (HERMES_STREAMING_TRANSPORTS.has(transport)) return transport
  if (strict) throw new Error('streaming.transport 必须是 auto、draft、edit 或 off')
  return 'edit'
}

function normalizeHermesCodeExecutionMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'project'
  if (HERMES_CODE_EXECUTION_MODES.has(mode)) return mode
  if (strict) throw new Error('code_execution.mode 必须是 project 或 strict')
  return 'project'
}

function normalizeHermesTerminalBackend(value, strict = false) {
  const backend = String(value ?? '').trim().toLowerCase() || 'local'
  if (HERMES_TERMINAL_BACKENDS.has(backend)) return backend
  if (strict) throw new Error('terminal.backend 必须是 local、ssh、docker、singularity、modal、daytona 或 vercel_sandbox')
  return 'local'
}

function normalizeHermesTerminalModalMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_TERMINAL_MODAL_MODES.has(mode)) return mode
  if (strict) throw new Error('terminal.modal_mode 必须是 auto、managed 或 direct')
  return 'auto'
}

function normalizeHermesTerminalVercelRuntime(value, strict = false) {
  const runtime = String(value ?? '').trim().toLowerCase() || 'node24'
  if (HERMES_TERMINAL_VERCEL_RUNTIMES.has(runtime)) return runtime
  if (strict) throw new Error('terminal.vercel_runtime 必须是 node24、node22 或 python3.13')
  return 'node24'
}

function normalizeHermesBrowserEngine(value, strict = false) {
  const engine = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_BROWSER_ENGINES.has(engine)) return engine
  if (strict) throw new Error('browser.engine 必须是 auto、lightpanda 或 chrome')
  return 'auto'
}

function normalizeHermesBrowserDialogPolicy(value, strict = false) {
  const policy = String(value ?? '').trim().toLowerCase() || 'must_respond'
  if (HERMES_BROWSER_DIALOG_POLICIES.has(policy)) return policy
  if (strict) throw new Error('browser.dialog_policy 必须是 must_respond、auto_dismiss 或 auto_accept')
  return 'must_respond'
}

function normalizeHermesWebBackend(value, key, strict = false) {
  const backend = String(value ?? '').trim().toLowerCase()
  if (!backend) return ''
  if (HERMES_WEB_BACKENDS.has(backend)) return backend
  if (strict) throw new Error(`${key} 必须为空或 tavily、firecrawl、parallel-free、parallel、exa、searxng、brave、brave_free、ddgs、xai、native`)
  return ''
}

function normalizeHermesHttpUrl(value, key, fallback = '', strict = false) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    if (strict && !fallback) throw new Error(`${key} 不能为空`)
    return fallback
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw
  } catch (_) {
    // 统一在下面抛出可读错误
  }
  if (strict) throw new Error(`${key} 必须是 http:// 或 https:// URL`)
  return fallback
}

function normalizeHermesLspWaitMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'document'
  if (HERMES_LSP_WAIT_MODES.has(mode)) return mode
  if (strict) throw new Error('lsp.wait_mode 必须是 document 或 full')
  return 'document'
}

function normalizeHermesLspInstallStrategy(value, strict = false) {
  const strategy = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_LSP_INSTALL_STRATEGIES.has(strategy)) return strategy
  if (strict) throw new Error('lsp.install_strategy 必须是 auto、manual 或 off')
  return 'auto'
}

function normalizeHermesSttProvider(value, strict = false) {
  const provider = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_STT_PROVIDERS.has(provider)) return provider
  if (strict) throw new Error('stt.provider 必须是 auto、local、groq、openai 或 mistral')
  return 'auto'
}

function normalizeHermesSttLocalModel(value, strict = false) {
  const model = String(value ?? '').trim().toLowerCase() || 'base'
  if (HERMES_STT_LOCAL_MODELS.has(model)) return model
  if (strict) throw new Error('stt.local.model 必须是 tiny、base、small、medium、large-v3 或 turbo')
  return 'base'
}

function normalizeHermesSttOpenaiModel(value, strict = false) {
  const model = String(value ?? '').trim() || 'whisper-1'
  if (HERMES_STT_OPENAI_MODELS.has(model)) return model
  if (strict) throw new Error('stt.openai.model 必须是 whisper-1、gpt-4o-mini-transcribe 或 gpt-4o-transcribe')
  return 'whisper-1'
}

function normalizeHermesSttMistralModel(value, strict = false) {
  const model = String(value ?? '').trim() || 'voxtral-mini-latest'
  if (HERMES_STT_MISTRAL_MODELS.has(model)) return model
  if (strict) throw new Error('stt.mistral.model 必须是 voxtral-mini-latest 或 voxtral-mini-2602')
  return 'voxtral-mini-latest'
}

function normalizeHermesSttLanguage(value, strict = false) {
  const language = String(value ?? '').trim()
  if (!language) return ''
  if (/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(language)) return language
  if (strict) throw new Error('stt.local.language 必须为空或合法语言标签，例如 zh、en、pt-BR')
  return ''
}

function normalizeHermesTtsProvider(value, strict = false) {
  const provider = String(value ?? '').trim().toLowerCase() || 'edge'
  if (HERMES_TTS_PROVIDERS.has(provider)) return provider
  if (strict) throw new Error('tts.provider 必须是 edge、elevenlabs、openai、xai、minimax、mistral、gemini、neutts、kittentts 或 piper')
  return 'edge'
}

function normalizeHermesTtsOpenaiVoice(value, strict = false) {
  const voice = String(value ?? '').trim().toLowerCase() || 'alloy'
  if (HERMES_TTS_OPENAI_VOICES.has(voice)) return voice
  if (strict) throw new Error('tts.openai.voice 必须是 alloy、echo、fable、onyx、nova 或 shimmer')
  return 'alloy'
}

function normalizeHermesVoiceLanguage(value, strict = false, key = 'tts.xai.language') {
  const language = String(value ?? '').trim()
  if (!language) return 'en'
  if (/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(language)) return language
  if (strict) throw new Error(`${key} 必须是合法语言标签，例如 en、zh、pt-BR`)
  return 'en'
}

function normalizeHermesApprovalMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'manual'
  if (HERMES_APPROVAL_MODES.has(mode)) return mode
  if (strict) throw new Error('approvals.mode 必须是 manual、smart 或 off')
  return 'manual'
}

function normalizeHermesApprovalCronMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'deny'
  if (HERMES_APPROVAL_CRON_MODES.has(mode)) return mode
  if (strict) throw new Error('approvals.cron_mode 必须是 deny 或 approve')
  return 'deny'
}

function normalizeHermesLoggingLevel(value, strict = false) {
  const level = String(value ?? '').trim().toUpperCase() || 'INFO'
  if (HERMES_LOGGING_LEVELS.has(level)) return level
  if (strict) throw new Error('logging.level 必须是 DEBUG、INFO 或 WARNING')
  return 'INFO'
}

function normalizeHermesImageInputMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_AGENT_IMAGE_INPUT_MODES.has(mode)) return mode
  if (strict) throw new Error('agent.image_input_mode 必须是 auto、native 或 text')
  return 'auto'
}

function normalizeHermesReasoningEffort(value, strict = false) {
  const effort = String(value ?? '').trim().toLowerCase() || 'medium'
  if (HERMES_AGENT_REASONING_EFFORTS.has(effort)) return effort
  if (strict) throw new Error('agent.reasoning_effort 必须是 xhigh、high、medium、low、minimal 或 none')
  return 'medium'
}

function normalizeHermesPromptCacheTtl(value, strict = false) {
  const ttl = String(value ?? '').trim().toLowerCase() || '5m'
  if (HERMES_PROMPT_CACHE_TTLS.has(ttl)) return ttl
  if (strict) throw new Error('prompt_caching.cache_ttl 必须是 5m 或 1h')
  return '5m'
}

function normalizeHermesProviderRoutingSort(value, strict = false) {
  const sort = String(value ?? '').trim().toLowerCase() || 'price'
  if (HERMES_PROVIDER_ROUTING_SORTS.has(sort)) return sort
  if (strict) throw new Error('provider_routing.sort 必须是 price、throughput 或 latency')
  return 'price'
}

function normalizeHermesProviderRoutingDataCollection(value, strict = false) {
  const policy = String(value ?? '').trim().toLowerCase() || 'allow'
  if (HERMES_PROVIDER_ROUTING_DATA_COLLECTION.has(policy)) return policy
  if (strict) throw new Error('provider_routing.data_collection 必须是 allow 或 deny')
  return 'allow'
}

function normalizeHermesProviderRoutingList(value, key) {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    const provider = String(item ?? '').trim().toLowerCase()
    if (!/^[a-zA-Z0-9_.-]+$/.test(provider)) {
      throw new Error(`${key} 只能包含字母、数字、下划线、点和短横线`)
    }
    if (!seen.has(provider)) {
      seen.add(provider)
      normalized.push(provider)
    }
  }
  return normalized
}

function normalizeHermesEnvNameList(value, key) {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    const name = String(item ?? '').trim()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`${key} 只能填写环境变量名，每行一个，例如 GITHUB_TOKEN`)
    }
    if (!seen.has(name)) {
      seen.add(name)
      normalized.push(name)
    }
  }
  return normalized
}

function normalizeHermesShellInitFileList(value, key) {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    const path = String(item ?? '').trim()
    if (!path || /[\u0000-\u001f\u007f]/.test(path) || /\s/.test(path)) {
      throw new Error(`${key} 每行只能填写一个 shell 初始化文件路径，路径不能包含空白字符`)
    }
    if (!/^[~$%{}A-Za-z0-9_./:\\-]+$/.test(path)) {
      throw new Error(`${key} 只能包含路径字符、~、环境变量占位、点、斜杠、冒号和短横线`)
    }
    if (!seen.has(path)) {
      seen.add(path)
      normalized.push(path)
    }
  }
  return normalized
}

function normalizeHermesDockerEnvJson(value, key) {
  let object = value
  if (typeof value === 'string') {
    const text = value.trim()
    object = text ? JSON.parse(text) : {}
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error(`${key} 必须是 JSON object，例如 {"PLAYWRIGHT_BROWSERS_PATH":"/ms-playwright"}`)
  }
  const normalized = {}
  for (const [name, rawValue] of Object.entries(object)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`${key} 只能使用合法环境变量名作为 key`)
    }
    if (rawValue === null || (typeof rawValue === 'object' && !Array.isArray(rawValue))) {
      throw new Error(`${key}.${name} 只能是字符串、数字或布尔值`)
    }
    if (Array.isArray(rawValue)) {
      throw new Error(`${key}.${name} 不能是数组`)
    }
    normalized[name] = String(rawValue)
  }
  return normalized
}

function normalizeHermesDockerVolumeList(value, key) {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    const volume = String(item ?? '').trim()
    if (!volume.includes(':') || /[\u0000-\u001f\u007f\s]/.test(volume)) {
      throw new Error(`${key} 每行一个 Docker volume 映射，例如 /host/path:/container/path`)
    }
    if (!seen.has(volume)) {
      seen.add(volume)
      normalized.push(volume)
    }
  }
  return normalized
}

function normalizeHermesDockerExtraArgsList(value, key) {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    const arg = String(item ?? '').trim()
    if (!arg.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(arg)) {
      throw new Error(`${key} 每行一个 Docker 参数，必须以 - 开头，例如 --network=host`)
    }
    if (!seen.has(arg)) {
      seen.add(arg)
      normalized.push(arg)
    }
  }
  return normalized
}

function normalizeHermesAuxiliaryProvider(value, key, strict = false) {
  const provider = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_AUXILIARY_PROVIDERS.has(provider)) return provider
  if (strict) throw new Error(`${key} 必须是 auto、openrouter、nous、gemini、ollama-cloud、codex 或 main`)
  return 'auto'
}

function normalizeHermesAuxiliaryModel(value, key, strict = false) {
  const model = String(value ?? '').trim()
  if (!model) return ''
  if (/^[a-zA-Z0-9_./:@+-]+$/.test(model) && !model.split('/').includes('..')) return model
  if (strict) throw new Error(`${key} 只能包含字母、数字、下划线、点、斜杠、冒号、@、加号和短横线`)
  return ''
}

function normalizeHermesDisplayToolProgress(value, strict = false, key = 'display.tool_progress') {
  const progress = String(value ?? '').trim().toLowerCase() || 'all'
  if (HERMES_DISPLAY_TOOL_PROGRESS_VALUES.has(progress)) return progress
  if (strict) throw new Error(`${key} 必须是 off、new、all 或 verbose`)
  return 'all'
}

function normalizeHermesDisplayToolPrefix(value, strict = false) {
  const prefix = String(value ?? '').trim() || '┊'
  if (prefix.length <= 8 && !/[\r\n\t]/.test(prefix)) return prefix
  if (strict) throw new Error('display.tool_prefix 必须是 1 到 8 个字符，且不能包含换行或制表符')
  return '┊'
}

function normalizeHermesDisplayStreaming(value, strict = false, key = 'display.streaming') {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const streaming = String(value ?? '').trim().toLowerCase() || 'inherit'
  if (HERMES_DISPLAY_STREAMING_VALUES.has(streaming)) return streaming
  if (strict) throw new Error(`${key} 必须是 inherit、true 或 false`)
  return 'inherit'
}

function normalizeHermesDisplayResume(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'full'
  if (HERMES_DISPLAY_RESUME_VALUES.has(mode)) return mode
  if (strict) throw new Error('display.resume_display 必须是 full 或 minimal')
  return 'full'
}

function normalizeHermesDisplayBusyInputMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'interrupt'
  if (HERMES_DISPLAY_BUSY_INPUT_MODES.has(mode)) return mode
  if (strict) throw new Error('display.busy_input_mode 必须是 interrupt、queue 或 steer')
  return 'interrupt'
}

function normalizeHermesDisplayBackgroundProcessNotifications(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'all'
  if (HERMES_DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS.has(mode)) return mode
  if (strict) throw new Error('display.background_process_notifications 必须是 off、result、error 或 all')
  return 'all'
}

function normalizeHermesDisplayFinalResponseMarkdown(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'strip'
  if (HERMES_DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES.has(mode)) return mode
  if (strict) throw new Error('display.final_response_markdown 必须是 render、strip 或 raw')
  return 'strip'
}

function normalizeHermesTuiStatusIndicator(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'kaomoji'
  if (HERMES_TUI_STATUS_INDICATORS.has(mode)) return mode
  if (strict) throw new Error('display.tui_status_indicator 必须是 kaomoji、emoji、unicode 或 ascii')
  return 'kaomoji'
}

function normalizeHermesCopyShortcut(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'auto'
  if (HERMES_COPY_SHORTCUTS.has(mode)) return mode
  if (strict) throw new Error('display.copy_shortcut 必须是 auto、ctrl_c、ctrl_shift_c 或 disabled')
  return 'auto'
}

function normalizeHermesDisplayLanguage(value, strict = false) {
  const language = String(value ?? '').trim().toLowerCase() || 'en'
  if (HERMES_DISPLAY_LANGUAGE_VALUES.has(language)) return language
  if (strict) throw new Error('display.language 不在支持列表中')
  return 'en'
}

function normalizeHermesDisplaySkin(value, strict = false) {
  const skin = String(value ?? '').trim().toLowerCase() || 'default'
  if (HERMES_DISPLAY_SKINS.has(skin)) return skin
  if (strict) throw new Error('display.skin 必须是内置皮肤 default、ares、mono、slate、daylight、warm-lightmode、poseidon、sisyphus 或 charizard')
  return 'default'
}

function normalizeHermesRuntimeFooterFields(value, strict = false) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? '').split(/\r?\n|,/)
  const normalized = [...new Set(items.map(item => String(item ?? '').trim()).filter(Boolean))]
  if (!normalized.length) return ['model', 'context_pct', 'cwd']
  const invalid = normalized.find(item => !HERMES_RUNTIME_FOOTER_FIELDS.has(item))
  if (invalid) {
    if (strict) throw new Error(`display.runtime_footer.fields 包含不支持的字段: ${invalid}`)
    return ['model', 'context_pct', 'cwd']
  }
  return normalized
}

function hermesDisplayConfigParts(config = {}, platform = '') {
  const display = config?.display && typeof config.display === 'object' && !Array.isArray(config.display)
    ? config.display
    : {}
  const platforms = display.platforms && typeof display.platforms === 'object' && !Array.isArray(display.platforms)
    ? display.platforms
    : {}
  const platformDisplay = platforms[platform] && typeof platforms[platform] === 'object' && !Array.isArray(platforms[platform])
    ? platforms[platform]
    : {}
  return { display, platformDisplay }
}

export function buildHermesDisplayConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const display = root.display && typeof root.display === 'object' && !Array.isArray(root.display)
    ? root.display
    : {}
  const dashboard = root.dashboard && typeof root.dashboard === 'object' && !Array.isArray(root.dashboard)
    ? root.dashboard
    : {}
  const runtimeFooter = display.runtime_footer && typeof display.runtime_footer === 'object' && !Array.isArray(display.runtime_footer)
    ? display.runtime_footer
    : {}
  const userMessagePreview = display.user_message_preview && typeof display.user_message_preview === 'object' && !Array.isArray(display.user_message_preview)
    ? display.user_message_preview
    : {}
  return {
    displayCompact: readHermesBool(display.compact, false),
    displaySkin: normalizeHermesDisplaySkin(display.skin, false),
    displayToolPrefix: normalizeHermesDisplayToolPrefix(display.tool_prefix, false),
    displayToolProgress: normalizeHermesDisplayToolProgress(display.tool_progress, false),
    displayShowReasoning: readHermesBool(display.show_reasoning, false),
    displayToolPreviewLength: parseHermesInteger(display.tool_preview_length, 'display.tool_preview_length', 0, 0, 200000, false),
    displayCleanupProgress: readHermesBool(display.cleanup_progress, false),
    displayToolProgressCommand: readHermesBool(display.tool_progress_command, false),
    displayInterimAssistantMessages: readHermesBool(display.interim_assistant_messages, true),
    displayRuntimeFooterEnabled: readHermesBool(runtimeFooter.enabled, false),
    displayRuntimeFooterFields: normalizeHermesRuntimeFooterFields(runtimeFooter.fields, false).join('\n'),
    displayFileMutationVerifier: readHermesBool(display.file_mutation_verifier, true),
    displayShowCost: readHermesBool(display.show_cost, false),
    dashboardShowTokenAnalytics: readHermesBool(dashboard.show_token_analytics, false),
    displayLanguage: normalizeHermesDisplayLanguage(display.language, false),
    displayResumeDisplay: normalizeHermesDisplayResume(display.resume_display, false),
    displayBusyInputMode: normalizeHermesDisplayBusyInputMode(display.busy_input_mode, false),
    displayBackgroundProcessNotifications: normalizeHermesDisplayBackgroundProcessNotifications(display.background_process_notifications, false),
    displayFinalResponseMarkdown: normalizeHermesDisplayFinalResponseMarkdown(display.final_response_markdown, false),
    displayTimestamps: readHermesBool(display.timestamps, false),
    displayBellOnComplete: readHermesBool(display.bell_on_complete, false),
    displayPersistentOutput: readHermesBool(display.persistent_output, true),
    displayPersistentOutputMaxLines: parseHermesInteger(display.persistent_output_max_lines, 'display.persistent_output_max_lines', 200, 0, 100000, false),
    displayInlineDiffs: readHermesBool(display.inline_diffs, true),
    displayTuiAutoResumeRecent: readHermesBool(display.tui_auto_resume_recent, false),
    displayTuiStatusIndicator: normalizeHermesTuiStatusIndicator(display.tui_status_indicator, false),
    displayUserMessagePreviewFirstLines: parseHermesInteger(userMessagePreview.first_lines, 'display.user_message_preview.first_lines', 2, 1, 100, false),
    displayUserMessagePreviewLastLines: parseHermesInteger(userMessagePreview.last_lines, 'display.user_message_preview.last_lines', 2, 0, 100, false),
    displayEphemeralSystemTtl: parseHermesInteger(display.ephemeral_system_ttl, 'display.ephemeral_system_ttl', 0, 0, 86400, false),
    displayCopyShortcut: normalizeHermesCopyShortcut(display.copy_shortcut, false),
  }
}

export function mergeHermesDisplayConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesDisplayConfigValues(next)
  const display = next.display && typeof next.display === 'object' && !Array.isArray(next.display)
    ? mergeConfigsPreservingFields(next.display, {})
    : {}
  const runtimeFooter = display.runtime_footer && typeof display.runtime_footer === 'object' && !Array.isArray(display.runtime_footer)
    ? mergeConfigsPreservingFields(display.runtime_footer, {})
    : {}
  const userMessagePreview = display.user_message_preview && typeof display.user_message_preview === 'object' && !Array.isArray(display.user_message_preview)
    ? mergeConfigsPreservingFields(display.user_message_preview, {})
    : {}

  display.compact = formHermesBool(form, 'displayCompact', currentValues.displayCompact)
  display.skin = normalizeHermesDisplaySkin(Object.hasOwn(form, 'displaySkin') ? form.displaySkin : currentValues.displaySkin, true)
  display.tool_prefix = normalizeHermesDisplayToolPrefix(Object.hasOwn(form, 'displayToolPrefix') ? form.displayToolPrefix : currentValues.displayToolPrefix, true)
  display.tool_progress = normalizeHermesDisplayToolProgress(Object.hasOwn(form, 'displayToolProgress') ? form.displayToolProgress : currentValues.displayToolProgress, true, 'display.tool_progress')
  display.show_reasoning = formHermesBool(form, 'displayShowReasoning', currentValues.displayShowReasoning)
  display.tool_preview_length = parseHermesInteger(Object.hasOwn(form, 'displayToolPreviewLength') ? form.displayToolPreviewLength : currentValues.displayToolPreviewLength, 'display.tool_preview_length', 0, 0, 200000, true)
  display.cleanup_progress = formHermesBool(form, 'displayCleanupProgress', currentValues.displayCleanupProgress)
  display.tool_progress_command = formHermesBool(form, 'displayToolProgressCommand', currentValues.displayToolProgressCommand)
  display.interim_assistant_messages = formHermesBool(form, 'displayInterimAssistantMessages', currentValues.displayInterimAssistantMessages)
  runtimeFooter.enabled = formHermesBool(form, 'displayRuntimeFooterEnabled', currentValues.displayRuntimeFooterEnabled)
  runtimeFooter.fields = normalizeHermesRuntimeFooterFields(Object.hasOwn(form, 'displayRuntimeFooterFields') ? form.displayRuntimeFooterFields : currentValues.displayRuntimeFooterFields, true)
  display.runtime_footer = runtimeFooter
  display.file_mutation_verifier = formHermesBool(form, 'displayFileMutationVerifier', currentValues.displayFileMutationVerifier)
  display.show_cost = formHermesBool(form, 'displayShowCost', currentValues.displayShowCost)
  display.language = normalizeHermesDisplayLanguage(Object.hasOwn(form, 'displayLanguage') ? form.displayLanguage : currentValues.displayLanguage, true)
  display.resume_display = normalizeHermesDisplayResume(Object.hasOwn(form, 'displayResumeDisplay') ? form.displayResumeDisplay : currentValues.displayResumeDisplay, true)
  display.busy_input_mode = normalizeHermesDisplayBusyInputMode(Object.hasOwn(form, 'displayBusyInputMode') ? form.displayBusyInputMode : currentValues.displayBusyInputMode, true)
  display.background_process_notifications = normalizeHermesDisplayBackgroundProcessNotifications(Object.hasOwn(form, 'displayBackgroundProcessNotifications') ? form.displayBackgroundProcessNotifications : currentValues.displayBackgroundProcessNotifications, true)
  display.final_response_markdown = normalizeHermesDisplayFinalResponseMarkdown(Object.hasOwn(form, 'displayFinalResponseMarkdown') ? form.displayFinalResponseMarkdown : currentValues.displayFinalResponseMarkdown, true)
  display.timestamps = formHermesBool(form, 'displayTimestamps', currentValues.displayTimestamps)
  display.bell_on_complete = formHermesBool(form, 'displayBellOnComplete', currentValues.displayBellOnComplete)
  display.persistent_output = formHermesBool(form, 'displayPersistentOutput', currentValues.displayPersistentOutput)
  display.persistent_output_max_lines = parseHermesInteger(Object.hasOwn(form, 'displayPersistentOutputMaxLines') ? form.displayPersistentOutputMaxLines : currentValues.displayPersistentOutputMaxLines, 'display.persistent_output_max_lines', 200, 0, 100000, true)
  display.inline_diffs = formHermesBool(form, 'displayInlineDiffs', currentValues.displayInlineDiffs)
  display.tui_auto_resume_recent = formHermesBool(form, 'displayTuiAutoResumeRecent', currentValues.displayTuiAutoResumeRecent)
  display.tui_status_indicator = normalizeHermesTuiStatusIndicator(Object.hasOwn(form, 'displayTuiStatusIndicator') ? form.displayTuiStatusIndicator : currentValues.displayTuiStatusIndicator, true)
  userMessagePreview.first_lines = parseHermesInteger(Object.hasOwn(form, 'displayUserMessagePreviewFirstLines') ? form.displayUserMessagePreviewFirstLines : currentValues.displayUserMessagePreviewFirstLines, 'display.user_message_preview.first_lines', 2, 1, 100, true)
  userMessagePreview.last_lines = parseHermesInteger(Object.hasOwn(form, 'displayUserMessagePreviewLastLines') ? form.displayUserMessagePreviewLastLines : currentValues.displayUserMessagePreviewLastLines, 'display.user_message_preview.last_lines', 2, 0, 100, true)
  display.user_message_preview = userMessagePreview
  display.ephemeral_system_ttl = parseHermesInteger(Object.hasOwn(form, 'displayEphemeralSystemTtl') ? form.displayEphemeralSystemTtl : currentValues.displayEphemeralSystemTtl, 'display.ephemeral_system_ttl', 0, 0, 86400, true)
  display.copy_shortcut = normalizeHermesCopyShortcut(Object.hasOwn(form, 'displayCopyShortcut') ? form.displayCopyShortcut : currentValues.displayCopyShortcut, true)
  next.display = display
  const dashboard = next.dashboard && typeof next.dashboard === 'object' && !Array.isArray(next.dashboard)
    ? mergeConfigsPreservingFields(next.dashboard, {})
    : {}
  dashboard.show_token_analytics = formHermesBool(form, 'dashboardShowTokenAnalytics', currentValues.dashboardShowTokenAnalytics)
  next.dashboard = dashboard
  return next
}

export function buildHermesKanbanConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const kanban = root.kanban && typeof root.kanban === 'object' && !Array.isArray(root.kanban)
    ? root.kanban
    : {}
  return {
    dispatchInGateway: readHermesBool(kanban.dispatch_in_gateway, true),
    dispatchIntervalSeconds: parseHermesInteger(
      kanban.dispatch_interval_seconds,
      'kanban.dispatch_interval_seconds',
      60,
      1,
      86400,
      false,
    ),
    maxSpawn: parseHermesInteger(
      kanban.max_spawn,
      'kanban.max_spawn',
      0,
      0,
      1000,
      false,
    ),
    maxInProgress: parseHermesInteger(
      kanban.max_in_progress,
      'kanban.max_in_progress',
      0,
      0,
      1000,
      false,
    ),
    failureLimit: parseHermesInteger(
      kanban.failure_limit,
      'kanban.failure_limit',
      2,
      1,
      100,
      false,
    ),
    autoDecompose: readHermesBool(kanban.auto_decompose, true),
    autoDecomposePerTick: parseHermesInteger(
      kanban.auto_decompose_per_tick,
      'kanban.auto_decompose_per_tick',
      3,
      1,
      1000,
      false,
    ),
    workerLogRotateBytes: parseHermesInteger(
      kanban.worker_log_rotate_bytes,
      'kanban.worker_log_rotate_bytes',
      2097152,
      1,
      1073741824,
      false,
    ),
    workerLogBackupCount: parseHermesInteger(
      kanban.worker_log_backup_count,
      'kanban.worker_log_backup_count',
      1,
      0,
      100,
      false,
    ),
    orchestratorProfile: normalizeHermesKanbanOptionalString(
      kanban.orchestrator_profile,
      'kanban.orchestrator_profile',
      false,
    ),
    defaultAssignee: normalizeHermesKanbanOptionalString(
      kanban.default_assignee,
      'kanban.default_assignee',
      false,
    ),
    dispatchStaleTimeoutSeconds: parseHermesInteger(
      kanban.dispatch_stale_timeout_seconds,
      'kanban.dispatch_stale_timeout_seconds',
      14400,
      0,
      604800,
      false,
    ),
  }
}

export function mergeHermesKanbanConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesKanbanConfigValues(next)
  const kanban = next.kanban && typeof next.kanban === 'object' && !Array.isArray(next.kanban)
    ? mergeConfigsPreservingFields(next.kanban, {})
    : {}

  kanban.dispatch_in_gateway = formHermesBool(form, 'dispatchInGateway', currentValues.dispatchInGateway)
  kanban.dispatch_interval_seconds = parseHermesInteger(
    Object.hasOwn(form, 'dispatchIntervalSeconds') ? form.dispatchIntervalSeconds : currentValues.dispatchIntervalSeconds,
    'kanban.dispatch_interval_seconds',
    60,
    1,
    86400,
    true,
  )
  const maxSpawn = parseHermesInteger(
    Object.hasOwn(form, 'maxSpawn') ? form.maxSpawn : currentValues.maxSpawn,
    'kanban.max_spawn',
    0,
    0,
    1000,
    true,
  )
  if (maxSpawn > 0) kanban.max_spawn = maxSpawn
  else delete kanban.max_spawn
  const maxInProgress = parseHermesInteger(
    Object.hasOwn(form, 'maxInProgress') ? form.maxInProgress : currentValues.maxInProgress,
    'kanban.max_in_progress',
    0,
    0,
    1000,
    true,
  )
  if (maxInProgress > 0) kanban.max_in_progress = maxInProgress
  else delete kanban.max_in_progress
  kanban.failure_limit = parseHermesInteger(
    Object.hasOwn(form, 'failureLimit') ? form.failureLimit : currentValues.failureLimit,
    'kanban.failure_limit',
    2,
    1,
    100,
    true,
  )
  kanban.auto_decompose = formHermesBool(form, 'autoDecompose', currentValues.autoDecompose)
  kanban.auto_decompose_per_tick = parseHermesInteger(
    Object.hasOwn(form, 'autoDecomposePerTick') ? form.autoDecomposePerTick : currentValues.autoDecomposePerTick,
    'kanban.auto_decompose_per_tick',
    3,
    1,
    1000,
    true,
  )
  kanban.worker_log_rotate_bytes = parseHermesInteger(
    Object.hasOwn(form, 'workerLogRotateBytes') ? form.workerLogRotateBytes : currentValues.workerLogRotateBytes,
    'kanban.worker_log_rotate_bytes',
    2097152,
    1,
    1073741824,
    true,
  )
  kanban.worker_log_backup_count = parseHermesInteger(
    Object.hasOwn(form, 'workerLogBackupCount') ? form.workerLogBackupCount : currentValues.workerLogBackupCount,
    'kanban.worker_log_backup_count',
    1,
    0,
    100,
    true,
  )
  const orchestratorProfile = normalizeHermesKanbanOptionalString(
    Object.hasOwn(form, 'orchestratorProfile') ? form.orchestratorProfile : currentValues.orchestratorProfile,
    'kanban.orchestrator_profile',
    true,
  )
  if (orchestratorProfile) kanban.orchestrator_profile = orchestratorProfile
  else delete kanban.orchestrator_profile
  const defaultAssignee = normalizeHermesKanbanOptionalString(
    Object.hasOwn(form, 'defaultAssignee') ? form.defaultAssignee : currentValues.defaultAssignee,
    'kanban.default_assignee',
    true,
  )
  if (defaultAssignee) kanban.default_assignee = defaultAssignee
  else delete kanban.default_assignee
  kanban.dispatch_stale_timeout_seconds = parseHermesInteger(
    Object.hasOwn(form, 'dispatchStaleTimeoutSeconds') ? form.dispatchStaleTimeoutSeconds : currentValues.dispatchStaleTimeoutSeconds,
    'kanban.dispatch_stale_timeout_seconds',
    14400,
    0,
    604800,
    true,
  )
  next.kanban = kanban
  return next
}

function putHermesChannelDisplayFields(form, config, platform) {
  const { display, platformDisplay } = hermesDisplayConfigParts(config, platform)
  const legacyToolProgress = display.tool_progress_overrides && typeof display.tool_progress_overrides === 'object' && !Array.isArray(display.tool_progress_overrides)
    ? display.tool_progress_overrides[platform]
    : undefined
  form.displayToolProgress = normalizeHermesDisplayToolProgress(
    platformDisplay.tool_progress ?? legacyToolProgress ?? display.tool_progress ?? 'all',
    false,
  )
  form.displayShowReasoning = readHermesBool(platformDisplay.show_reasoning ?? display.show_reasoning, false)
  form.displayToolPreviewLength = parseHermesInteger(
    platformDisplay.tool_preview_length ?? display.tool_preview_length,
    `display.platforms.${platform}.tool_preview_length`,
    0,
    0,
    200000,
    false,
  )
  form.displayStreaming = Object.hasOwn(platformDisplay, 'streaming')
    ? normalizeHermesDisplayStreaming(platformDisplay.streaming, false)
    : 'inherit'
  form.displayCleanupProgress = readHermesBool(platformDisplay.cleanup_progress ?? display.cleanup_progress, false)
}

function hermesStreamingConfigSource(root) {
  if (root.streaming && typeof root.streaming === 'object' && !Array.isArray(root.streaming)) {
    return root.streaming
  }
  const gateway = root.gateway && typeof root.gateway === 'object' && !Array.isArray(root.gateway)
    ? root.gateway
    : {}
  return gateway.streaming && typeof gateway.streaming === 'object' && !Array.isArray(gateway.streaming)
    ? gateway.streaming
    : {}
}

export function buildHermesCompressionConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const compression = root.compression && typeof root.compression === 'object' && !Array.isArray(root.compression)
    ? root.compression
    : {}
  return {
    enabled: readHermesBool(compression.enabled, true),
    threshold: parseHermesFloat(compression.threshold, 'compression.threshold', 0.5, 0.1, 0.95, false),
    targetRatio: parseHermesFloat(compression.target_ratio, 'compression.target_ratio', 0.2, 0.1, 0.8, false),
    protectLastN: parseHermesInteger(compression.protect_last_n, 'compression.protect_last_n', 20, 1, 500, false),
    protectFirstN: parseHermesInteger(compression.protect_first_n, 'compression.protect_first_n', 3, 0, 100, false),
    abortOnSummaryFailure: readHermesBool(compression.abort_on_summary_failure, false),
  }
}

export function mergeHermesCompressionConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesCompressionConfigValues(next)
  const compression = next.compression && typeof next.compression === 'object' && !Array.isArray(next.compression)
    ? mergeConfigsPreservingFields(next.compression, {})
    : {}
  compression.enabled = formHermesBool(form, 'enabled', currentValues.enabled)
  compression.threshold = parseHermesFloat(Object.hasOwn(form, 'threshold') ? form.threshold : currentValues.threshold, 'compression.threshold', 0.5, 0.1, 0.95, true)
  compression.target_ratio = parseHermesFloat(Object.hasOwn(form, 'targetRatio') ? form.targetRatio : currentValues.targetRatio, 'compression.target_ratio', 0.2, 0.1, 0.8, true)
  compression.protect_last_n = parseHermesInteger(Object.hasOwn(form, 'protectLastN') ? form.protectLastN : currentValues.protectLastN, 'compression.protect_last_n', 20, 1, 500, true)
  compression.protect_first_n = parseHermesInteger(Object.hasOwn(form, 'protectFirstN') ? form.protectFirstN : currentValues.protectFirstN, 'compression.protect_first_n', 3, 0, 100, true)
  compression.abort_on_summary_failure = formHermesBool(form, 'abortOnSummaryFailure', currentValues.abortOnSummaryFailure)
  next.compression = compression
  return next
}

export function buildHermesPromptCachingConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const promptCaching = root.prompt_caching && typeof root.prompt_caching === 'object' && !Array.isArray(root.prompt_caching)
    ? root.prompt_caching
    : {}
  return {
    promptCacheTtl: normalizeHermesPromptCacheTtl(promptCaching.cache_ttl, false),
  }
}

export function mergeHermesPromptCachingConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesPromptCachingConfigValues(next)
  const promptCaching = next.prompt_caching && typeof next.prompt_caching === 'object' && !Array.isArray(next.prompt_caching)
    ? mergeConfigsPreservingFields(next.prompt_caching, {})
    : {}
  promptCaching.cache_ttl = normalizeHermesPromptCacheTtl(Object.hasOwn(form, 'promptCacheTtl') ? form.promptCacheTtl : currentValues.promptCacheTtl, true)
  next.prompt_caching = promptCaching
  return next
}

export function buildHermesOpenrouterCacheConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const openrouter = root.openrouter && typeof root.openrouter === 'object' && !Array.isArray(root.openrouter)
    ? root.openrouter
    : {}
  return {
    openrouterResponseCache: readHermesBool(openrouter.response_cache, true),
    openrouterResponseCacheTtl: parseHermesInteger(openrouter.response_cache_ttl, 'openrouter.response_cache_ttl', 300, 1, 86400, false),
  }
}

export function mergeHermesOpenrouterCacheConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesOpenrouterCacheConfigValues(next)
  const openrouter = next.openrouter && typeof next.openrouter === 'object' && !Array.isArray(next.openrouter)
    ? mergeConfigsPreservingFields(next.openrouter, {})
    : {}
  openrouter.response_cache = formHermesBool(form, 'openrouterResponseCache', currentValues.openrouterResponseCache)
  openrouter.response_cache_ttl = parseHermesInteger(Object.hasOwn(form, 'openrouterResponseCacheTtl') ? form.openrouterResponseCacheTtl : currentValues.openrouterResponseCacheTtl, 'openrouter.response_cache_ttl', 300, 1, 86400, true)
  next.openrouter = openrouter
  return next
}

export function buildHermesProviderRoutingConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const providerRouting = root.provider_routing && typeof root.provider_routing === 'object' && !Array.isArray(root.provider_routing)
    ? root.provider_routing
    : {}
  return {
    providerRoutingSort: normalizeHermesProviderRoutingSort(providerRouting.sort, false),
    providerRoutingOnly: normalizeHermesProviderRoutingList(providerRouting.only || [], 'provider_routing.only').join('\n'),
    providerRoutingIgnore: normalizeHermesProviderRoutingList(providerRouting.ignore || [], 'provider_routing.ignore').join('\n'),
    providerRoutingOrder: normalizeHermesProviderRoutingList(providerRouting.order || [], 'provider_routing.order').join('\n'),
    providerRoutingRequireParameters: readHermesBool(providerRouting.require_parameters, false),
    providerRoutingDataCollection: normalizeHermesProviderRoutingDataCollection(providerRouting.data_collection, false),
  }
}

export function mergeHermesProviderRoutingConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesProviderRoutingConfigValues(next)
  const providerRouting = next.provider_routing && typeof next.provider_routing === 'object' && !Array.isArray(next.provider_routing)
    ? mergeConfigsPreservingFields(next.provider_routing, {})
    : {}
  providerRouting.sort = normalizeHermesProviderRoutingSort(Object.hasOwn(form, 'providerRoutingSort') ? form.providerRoutingSort : currentValues.providerRoutingSort, true)
  providerRouting.require_parameters = formHermesBool(form, 'providerRoutingRequireParameters', currentValues.providerRoutingRequireParameters)
  providerRouting.data_collection = normalizeHermesProviderRoutingDataCollection(Object.hasOwn(form, 'providerRoutingDataCollection') ? form.providerRoutingDataCollection : currentValues.providerRoutingDataCollection, true)

  for (const [field, formKey] of [
    ['only', 'providerRoutingOnly'],
    ['ignore', 'providerRoutingIgnore'],
    ['order', 'providerRoutingOrder'],
  ]) {
    const values = normalizeHermesProviderRoutingList(Object.hasOwn(form, formKey) ? form[formKey] : currentValues[formKey], `provider_routing.${field}`)
    if (values.length) providerRouting[field] = values
    else delete providerRouting[field]
  }

  next.provider_routing = providerRouting
  return next
}

function hermesAuxiliaryTask(root, key) {
  const auxiliary = root.auxiliary && typeof root.auxiliary === 'object' && !Array.isArray(root.auxiliary)
    ? root.auxiliary
    : {}
  return auxiliary[key] && typeof auxiliary[key] === 'object' && !Array.isArray(auxiliary[key])
    ? auxiliary[key]
    : {}
}

export function buildHermesAuxiliaryConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const vision = hermesAuxiliaryTask(root, 'vision')
  const webExtract = hermesAuxiliaryTask(root, 'web_extract')
  const sessionSearch = hermesAuxiliaryTask(root, 'session_search')
  return {
    auxiliaryVisionProvider: normalizeHermesAuxiliaryProvider(vision.provider, 'auxiliary.vision.provider', false),
    auxiliaryVisionModel: normalizeHermesAuxiliaryModel(vision.model, 'auxiliary.vision.model', false),
    auxiliaryVisionTimeout: parseHermesInteger(vision.timeout, 'auxiliary.vision.timeout', 30, 1, 3600, false),
    auxiliaryVisionDownloadTimeout: parseHermesInteger(vision.download_timeout, 'auxiliary.vision.download_timeout', 30, 1, 3600, false),
    auxiliaryWebExtractProvider: normalizeHermesAuxiliaryProvider(webExtract.provider, 'auxiliary.web_extract.provider', false),
    auxiliaryWebExtractModel: normalizeHermesAuxiliaryModel(webExtract.model, 'auxiliary.web_extract.model', false),
    auxiliarySessionSearchProvider: normalizeHermesAuxiliaryProvider(sessionSearch.provider, 'auxiliary.session_search.provider', false),
    auxiliarySessionSearchModel: normalizeHermesAuxiliaryModel(sessionSearch.model, 'auxiliary.session_search.model', false),
    auxiliarySessionSearchTimeout: parseHermesInteger(sessionSearch.timeout, 'auxiliary.session_search.timeout', 30, 1, 3600, false),
    auxiliarySessionSearchMaxConcurrency: parseHermesInteger(sessionSearch.max_concurrency, 'auxiliary.session_search.max_concurrency', 3, 1, 100, false),
  }
}

export function mergeHermesAuxiliaryConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesAuxiliaryConfigValues(next)
  const auxiliary = next.auxiliary && typeof next.auxiliary === 'object' && !Array.isArray(next.auxiliary)
    ? mergeConfigsPreservingFields(next.auxiliary, {})
    : {}
  const vision = auxiliary.vision && typeof auxiliary.vision === 'object' && !Array.isArray(auxiliary.vision)
    ? mergeConfigsPreservingFields(auxiliary.vision, {})
    : {}
  const webExtract = auxiliary.web_extract && typeof auxiliary.web_extract === 'object' && !Array.isArray(auxiliary.web_extract)
    ? mergeConfigsPreservingFields(auxiliary.web_extract, {})
    : {}
  const sessionSearch = auxiliary.session_search && typeof auxiliary.session_search === 'object' && !Array.isArray(auxiliary.session_search)
    ? mergeConfigsPreservingFields(auxiliary.session_search, {})
    : {}

  vision.provider = normalizeHermesAuxiliaryProvider(Object.hasOwn(form, 'auxiliaryVisionProvider') ? form.auxiliaryVisionProvider : currentValues.auxiliaryVisionProvider, 'auxiliary.vision.provider', true)
  vision.model = normalizeHermesAuxiliaryModel(Object.hasOwn(form, 'auxiliaryVisionModel') ? form.auxiliaryVisionModel : currentValues.auxiliaryVisionModel, 'auxiliary.vision.model', true)
  vision.timeout = parseHermesInteger(Object.hasOwn(form, 'auxiliaryVisionTimeout') ? form.auxiliaryVisionTimeout : currentValues.auxiliaryVisionTimeout, 'auxiliary.vision.timeout', 30, 1, 3600, true)
  vision.download_timeout = parseHermesInteger(Object.hasOwn(form, 'auxiliaryVisionDownloadTimeout') ? form.auxiliaryVisionDownloadTimeout : currentValues.auxiliaryVisionDownloadTimeout, 'auxiliary.vision.download_timeout', 30, 1, 3600, true)
  webExtract.provider = normalizeHermesAuxiliaryProvider(Object.hasOwn(form, 'auxiliaryWebExtractProvider') ? form.auxiliaryWebExtractProvider : currentValues.auxiliaryWebExtractProvider, 'auxiliary.web_extract.provider', true)
  webExtract.model = normalizeHermesAuxiliaryModel(Object.hasOwn(form, 'auxiliaryWebExtractModel') ? form.auxiliaryWebExtractModel : currentValues.auxiliaryWebExtractModel, 'auxiliary.web_extract.model', true)
  sessionSearch.provider = normalizeHermesAuxiliaryProvider(Object.hasOwn(form, 'auxiliarySessionSearchProvider') ? form.auxiliarySessionSearchProvider : currentValues.auxiliarySessionSearchProvider, 'auxiliary.session_search.provider', true)
  sessionSearch.model = normalizeHermesAuxiliaryModel(Object.hasOwn(form, 'auxiliarySessionSearchModel') ? form.auxiliarySessionSearchModel : currentValues.auxiliarySessionSearchModel, 'auxiliary.session_search.model', true)
  sessionSearch.timeout = parseHermesInteger(Object.hasOwn(form, 'auxiliarySessionSearchTimeout') ? form.auxiliarySessionSearchTimeout : currentValues.auxiliarySessionSearchTimeout, 'auxiliary.session_search.timeout', 30, 1, 3600, true)
  sessionSearch.max_concurrency = parseHermesInteger(Object.hasOwn(form, 'auxiliarySessionSearchMaxConcurrency') ? form.auxiliarySessionSearchMaxConcurrency : currentValues.auxiliarySessionSearchMaxConcurrency, 'auxiliary.session_search.max_concurrency', 3, 1, 100, true)

  auxiliary.vision = vision
  auxiliary.web_extract = webExtract
  auxiliary.session_search = sessionSearch
  next.auxiliary = auxiliary
  return next
}

export function buildHermesToolLoopGuardrailsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const guardrails = root.tool_loop_guardrails && typeof root.tool_loop_guardrails === 'object' && !Array.isArray(root.tool_loop_guardrails)
    ? root.tool_loop_guardrails
    : {}
  const warnAfter = guardrails.warn_after && typeof guardrails.warn_after === 'object' && !Array.isArray(guardrails.warn_after)
    ? guardrails.warn_after
    : {}
  const hardStopAfter = guardrails.hard_stop_after && typeof guardrails.hard_stop_after === 'object' && !Array.isArray(guardrails.hard_stop_after)
    ? guardrails.hard_stop_after
    : {}
  return {
    warningsEnabled: readHermesBool(guardrails.warnings_enabled, true),
    hardStopEnabled: readHermesBool(guardrails.hard_stop_enabled, false),
    warnExactFailure: parseHermesInteger(warnAfter.exact_failure ?? guardrails.exact_failure_warn_after, 'tool_loop_guardrails.warn_after.exact_failure', 2, 1, 100, false),
    warnSameToolFailure: parseHermesInteger(warnAfter.same_tool_failure ?? guardrails.same_tool_failure_warn_after, 'tool_loop_guardrails.warn_after.same_tool_failure', 3, 1, 100, false),
    warnNoProgress: parseHermesInteger(warnAfter.idempotent_no_progress ?? guardrails.no_progress_warn_after, 'tool_loop_guardrails.warn_after.idempotent_no_progress', 2, 1, 100, false),
    hardStopExactFailure: parseHermesInteger(hardStopAfter.exact_failure ?? guardrails.exact_failure_block_after, 'tool_loop_guardrails.hard_stop_after.exact_failure', 5, 1, 100, false),
    hardStopSameToolFailure: parseHermesInteger(hardStopAfter.same_tool_failure ?? guardrails.same_tool_failure_halt_after, 'tool_loop_guardrails.hard_stop_after.same_tool_failure', 8, 1, 100, false),
    hardStopNoProgress: parseHermesInteger(hardStopAfter.idempotent_no_progress ?? guardrails.no_progress_block_after, 'tool_loop_guardrails.hard_stop_after.idempotent_no_progress', 5, 1, 100, false),
  }
}

export function mergeHermesToolLoopGuardrailsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesToolLoopGuardrailsConfigValues(next)
  const guardrails = next.tool_loop_guardrails && typeof next.tool_loop_guardrails === 'object' && !Array.isArray(next.tool_loop_guardrails)
    ? mergeConfigsPreservingFields(next.tool_loop_guardrails, {})
    : {}
  const warnAfter = guardrails.warn_after && typeof guardrails.warn_after === 'object' && !Array.isArray(guardrails.warn_after)
    ? mergeConfigsPreservingFields(guardrails.warn_after, {})
    : {}
  const hardStopAfter = guardrails.hard_stop_after && typeof guardrails.hard_stop_after === 'object' && !Array.isArray(guardrails.hard_stop_after)
    ? mergeConfigsPreservingFields(guardrails.hard_stop_after, {})
    : {}

  guardrails.warnings_enabled = formHermesBool(form, 'warningsEnabled', currentValues.warningsEnabled)
  guardrails.hard_stop_enabled = formHermesBool(form, 'hardStopEnabled', currentValues.hardStopEnabled)
  warnAfter.exact_failure = parseHermesInteger(Object.hasOwn(form, 'warnExactFailure') ? form.warnExactFailure : currentValues.warnExactFailure, 'tool_loop_guardrails.warn_after.exact_failure', 2, 1, 100, true)
  warnAfter.same_tool_failure = parseHermesInteger(Object.hasOwn(form, 'warnSameToolFailure') ? form.warnSameToolFailure : currentValues.warnSameToolFailure, 'tool_loop_guardrails.warn_after.same_tool_failure', 3, 1, 100, true)
  warnAfter.idempotent_no_progress = parseHermesInteger(Object.hasOwn(form, 'warnNoProgress') ? form.warnNoProgress : currentValues.warnNoProgress, 'tool_loop_guardrails.warn_after.idempotent_no_progress', 2, 1, 100, true)
  hardStopAfter.exact_failure = parseHermesInteger(Object.hasOwn(form, 'hardStopExactFailure') ? form.hardStopExactFailure : currentValues.hardStopExactFailure, 'tool_loop_guardrails.hard_stop_after.exact_failure', 5, 1, 100, true)
  hardStopAfter.same_tool_failure = parseHermesInteger(Object.hasOwn(form, 'hardStopSameToolFailure') ? form.hardStopSameToolFailure : currentValues.hardStopSameToolFailure, 'tool_loop_guardrails.hard_stop_after.same_tool_failure', 8, 1, 100, true)
  hardStopAfter.idempotent_no_progress = parseHermesInteger(Object.hasOwn(form, 'hardStopNoProgress') ? form.hardStopNoProgress : currentValues.hardStopNoProgress, 'tool_loop_guardrails.hard_stop_after.idempotent_no_progress', 5, 1, 100, true)
  guardrails.warn_after = warnAfter
  guardrails.hard_stop_after = hardStopAfter
  next.tool_loop_guardrails = guardrails
  return next
}

export function buildHermesMemoryConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const memory = root.memory && typeof root.memory === 'object' && !Array.isArray(root.memory)
    ? root.memory
    : {}
  const qmd = memory.qmd && typeof memory.qmd === 'object' && !Array.isArray(memory.qmd)
    ? memory.qmd
    : {}
  return {
    memoryEnabled: readHermesBool(memory.memory_enabled, true),
    userProfileEnabled: readHermesBool(memory.user_profile_enabled, true),
    memoryCharLimit: parseHermesInteger(memory.memory_char_limit, 'memory.memory_char_limit', 2200, 100, 200000, false),
    userCharLimit: parseHermesInteger(memory.user_char_limit, 'memory.user_char_limit', 1375, 100, 200000, false),
    nudgeInterval: parseHermesInteger(memory.nudge_interval, 'memory.nudge_interval', 10, 0, 1000, false),
    flushMinTurns: parseHermesInteger(memory.flush_min_turns, 'memory.flush_min_turns', 6, 0, 1000, false),
    qmdRerank: readHermesBool(qmd.rerank, true),
  }
}

export function mergeHermesMemoryConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesMemoryConfigValues(next)
  const memory = next.memory && typeof next.memory === 'object' && !Array.isArray(next.memory)
    ? mergeConfigsPreservingFields(next.memory, {})
    : {}
  memory.memory_enabled = formHermesBool(form, 'memoryEnabled', currentValues.memoryEnabled)
  memory.user_profile_enabled = formHermesBool(form, 'userProfileEnabled', currentValues.userProfileEnabled)
  memory.memory_char_limit = parseHermesInteger(Object.hasOwn(form, 'memoryCharLimit') ? form.memoryCharLimit : currentValues.memoryCharLimit, 'memory.memory_char_limit', 2200, 100, 200000, true)
  memory.user_char_limit = parseHermesInteger(Object.hasOwn(form, 'userCharLimit') ? form.userCharLimit : currentValues.userCharLimit, 'memory.user_char_limit', 1375, 100, 200000, true)
  memory.nudge_interval = parseHermesInteger(Object.hasOwn(form, 'nudgeInterval') ? form.nudgeInterval : currentValues.nudgeInterval, 'memory.nudge_interval', 10, 0, 1000, true)
  memory.flush_min_turns = parseHermesInteger(Object.hasOwn(form, 'flushMinTurns') ? form.flushMinTurns : currentValues.flushMinTurns, 'memory.flush_min_turns', 6, 0, 1000, true)
  const qmd = memory.qmd && typeof memory.qmd === 'object' && !Array.isArray(memory.qmd)
    ? mergeConfigsPreservingFields(memory.qmd, {})
    : {}
  qmd.rerank = formHermesBool(form, 'qmdRerank', currentValues.qmdRerank)
  memory.qmd = qmd
  next.memory = memory
  return next
}

function normalizeHermesMultilineList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean)
  }
  return String(value ?? '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeHermesToolsetList(value, fieldName = 'agent.disabled_toolsets') {
  const seen = new Set()
  const normalized = []
  for (const item of normalizeHermesMultilineList(value)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(item)) {
      throw new Error(`${fieldName} 只能包含字母、数字、下划线、点和短横线`)
    }
    if (!seen.has(item)) {
      seen.add(item)
      normalized.push(item)
    }
  }
  return normalized
}

function validateHermesPersonalities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent.personalities 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawName, rawPrompt] of Object.entries(value)) {
    const name = String(rawName || '').trim()
    if (!name) throw new Error('agent.personalities 名称不能为空')
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`agent.personalities.${name} 名称只能包含字母、数字、下划线、点和短横线`)
    }
    if (typeof rawPrompt !== 'string') {
      throw new Error(`agent.personalities.${name} 必须是字符串`)
    }
    const prompt = rawPrompt.trim()
    if (!prompt) throw new Error(`agent.personalities.${name} 不能为空`)
    normalized[name] = prompt
  }
  return normalized
}

function parseHermesPersonalitiesJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`agent.personalities JSON 格式错误: ${err.message}`)
  }
  return validateHermesPersonalities(value)
}

function validateHermesPlatformToolsets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('platform_toolsets 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawPlatform, rawToolsets] of Object.entries(value)) {
    const platform = String(rawPlatform || '').trim()
    if (!platform || !/^[a-zA-Z0-9_.-]+$/.test(platform)) {
      throw new Error(`platform_toolsets.${platform || '<empty>'} 平台名只能包含字母、数字、下划线、点和短横线`)
    }
    if (!Array.isArray(rawToolsets)) {
      throw new Error(`platform_toolsets.${platform} 必须是工具集数组`)
    }
    const toolsets = normalizeHermesToolsetList(rawToolsets, `platform_toolsets.${platform}`)
    if (!toolsets.length) {
      throw new Error(`platform_toolsets.${platform} 至少需要一个工具集`)
    }
    normalized[platform] = toolsets
  }
  return normalized
}

function parseHermesPlatformToolsetsJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`platform_toolsets JSON 格式错误: ${err.message}`)
  }
  return validateHermesPlatformToolsets(value)
}

export function buildHermesSkillsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const skills = root.skills && typeof root.skills === 'object' && !Array.isArray(root.skills)
    ? root.skills
    : {}
  const externalDirs = Array.isArray(skills.external_dirs)
    ? skills.external_dirs.map(item => String(item ?? '').trim()).filter(Boolean).join('\n')
    : ''
  return {
    creationNudgeInterval: parseHermesInteger(skills.creation_nudge_interval, 'skills.creation_nudge_interval', 15, 0, 10000, false),
    externalDirs,
    templateVars: readHermesBool(skills.template_vars, true),
    inlineShell: readHermesBool(skills.inline_shell, false),
    inlineShellTimeout: parseHermesInteger(skills.inline_shell_timeout, 'skills.inline_shell_timeout', 10, 1, 86400, false),
    guardAgentCreated: readHermesBool(skills.guard_agent_created, false),
  }
}

export function mergeHermesSkillsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesSkillsConfigValues(next)
  const skills = next.skills && typeof next.skills === 'object' && !Array.isArray(next.skills)
    ? mergeConfigsPreservingFields(next.skills, {})
    : {}
  skills.creation_nudge_interval = parseHermesInteger(Object.hasOwn(form, 'creationNudgeInterval') ? form.creationNudgeInterval : currentValues.creationNudgeInterval, 'skills.creation_nudge_interval', 15, 0, 10000, true)
  skills.template_vars = formHermesBool(form, 'templateVars', currentValues.templateVars)
  skills.inline_shell = formHermesBool(form, 'inlineShell', currentValues.inlineShell)
  skills.inline_shell_timeout = parseHermesInteger(Object.hasOwn(form, 'inlineShellTimeout') ? form.inlineShellTimeout : currentValues.inlineShellTimeout, 'skills.inline_shell_timeout', 10, 1, 86400, true)
  skills.guard_agent_created = formHermesBool(form, 'guardAgentCreated', currentValues.guardAgentCreated)
  const externalDirs = normalizeHermesMultilineList(Object.hasOwn(form, 'externalDirs') ? form.externalDirs : currentValues.externalDirs)
  if (externalDirs.length) skills.external_dirs = externalDirs
  else delete skills.external_dirs
  next.skills = skills
  return next
}

export function buildHermesCuratorConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const curator = root.curator && typeof root.curator === 'object' && !Array.isArray(root.curator)
    ? root.curator
    : {}
  const backup = curator.backup && typeof curator.backup === 'object' && !Array.isArray(curator.backup)
    ? curator.backup
    : {}
  return {
    curatorEnabled: readHermesBool(curator.enabled, true),
    curatorIntervalHours: parseHermesInteger(curator.interval_hours, 'curator.interval_hours', 168, 1, 87600, false),
    curatorMinIdleHours: parseHermesInteger(curator.min_idle_hours, 'curator.min_idle_hours', 2, 0, 87600, false),
    curatorStaleAfterDays: parseHermesInteger(curator.stale_after_days, 'curator.stale_after_days', 30, 1, 36500, false),
    curatorArchiveAfterDays: parseHermesInteger(curator.archive_after_days, 'curator.archive_after_days', 90, 1, 36500, false),
    curatorBackupEnabled: readHermesBool(backup.enabled, true),
    curatorBackupKeep: parseHermesInteger(backup.keep, 'curator.backup.keep', 5, 0, 1000, false),
  }
}

export function mergeHermesCuratorConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesCuratorConfigValues(next)
  const curator = next.curator && typeof next.curator === 'object' && !Array.isArray(next.curator)
    ? mergeConfigsPreservingFields(next.curator, {})
    : {}
  const backup = curator.backup && typeof curator.backup === 'object' && !Array.isArray(curator.backup)
    ? mergeConfigsPreservingFields(curator.backup, {})
    : {}

  curator.enabled = formHermesBool(form, 'curatorEnabled', currentValues.curatorEnabled)
  curator.interval_hours = parseHermesInteger(Object.hasOwn(form, 'curatorIntervalHours') ? form.curatorIntervalHours : currentValues.curatorIntervalHours, 'curator.interval_hours', 168, 1, 87600, true)
  curator.min_idle_hours = parseHermesInteger(Object.hasOwn(form, 'curatorMinIdleHours') ? form.curatorMinIdleHours : currentValues.curatorMinIdleHours, 'curator.min_idle_hours', 2, 0, 87600, true)
  curator.stale_after_days = parseHermesInteger(Object.hasOwn(form, 'curatorStaleAfterDays') ? form.curatorStaleAfterDays : currentValues.curatorStaleAfterDays, 'curator.stale_after_days', 30, 1, 36500, true)
  curator.archive_after_days = parseHermesInteger(Object.hasOwn(form, 'curatorArchiveAfterDays') ? form.curatorArchiveAfterDays : currentValues.curatorArchiveAfterDays, 'curator.archive_after_days', 90, 1, 36500, true)
  if (curator.archive_after_days < curator.stale_after_days) {
    throw new Error('curator.archive_after_days 必须大于或等于 curator.stale_after_days')
  }
  backup.enabled = formHermesBool(form, 'curatorBackupEnabled', currentValues.curatorBackupEnabled)
  backup.keep = parseHermesInteger(Object.hasOwn(form, 'curatorBackupKeep') ? form.curatorBackupKeep : currentValues.curatorBackupKeep, 'curator.backup.keep', 5, 0, 1000, true)
  curator.backup = backup
  next.curator = curator
  return next
}

export function buildHermesAgentToolsetsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const agent = root.agent && typeof root.agent === 'object' && !Array.isArray(root.agent)
    ? root.agent
    : {}
  const disabledToolsets = Array.isArray(agent.disabled_toolsets)
    ? normalizeHermesMultilineList(agent.disabled_toolsets).join('\n')
    : ''
  return {
    disabledToolsets,
  }
}

export function mergeHermesAgentToolsetsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesAgentToolsetsConfigValues(next)
  const agent = next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)
    ? mergeConfigsPreservingFields(next.agent, {})
    : {}
  agent.disabled_toolsets = normalizeHermesToolsetList(Object.hasOwn(form, 'disabledToolsets') ? form.disabledToolsets : currentValues.disabledToolsets)
  next.agent = agent
  return next
}

export function buildHermesPlatformToolsetsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const platformToolsets = root.platform_toolsets && typeof root.platform_toolsets === 'object' && !Array.isArray(root.platform_toolsets)
    ? validateHermesPlatformToolsets(root.platform_toolsets)
    : HERMES_DEFAULT_PLATFORM_TOOLSETS
  return {
    platformToolsetsJson: JSON.stringify(platformToolsets, null, 2),
  }
}

export function mergeHermesPlatformToolsetsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesPlatformToolsetsConfigValues(next)
  const platformToolsets = parseHermesPlatformToolsetsJson(Object.hasOwn(form, 'platformToolsetsJson') ? form.platformToolsetsJson : currentValues.platformToolsetsJson)
  next.platform_toolsets = platformToolsets
  return next
}

export function buildHermesAgentRuntimeConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const agent = root.agent && typeof root.agent === 'object' && !Array.isArray(root.agent)
    ? root.agent
    : {}
  const personalities = agent.personalities && typeof agent.personalities === 'object' && !Array.isArray(agent.personalities)
    ? validateHermesPersonalities(agent.personalities)
    : {}
  return {
    agentMaxTurns: parseHermesInteger(agent.max_turns, 'agent.max_turns', 90, 1, 10000, false),
    gatewayTimeout: parseHermesInteger(agent.gateway_timeout, 'agent.gateway_timeout', 1800, 0, 604800, false),
    restartDrainTimeout: parseHermesInteger(agent.restart_drain_timeout, 'agent.restart_drain_timeout', 180, 0, 86400, false),
    apiMaxRetries: parseHermesInteger(agent.api_max_retries, 'agent.api_max_retries', 3, 1, 20, false),
    gatewayTimeoutWarning: parseHermesInteger(agent.gateway_timeout_warning, 'agent.gateway_timeout_warning', 900, 0, 604800, false),
    clarifyTimeout: parseHermesInteger(agent.clarify_timeout, 'agent.clarify_timeout', 600, 0, 86400, false),
    gatewayNotifyInterval: parseHermesInteger(agent.gateway_notify_interval, 'agent.gateway_notify_interval', 180, 0, 86400, false),
    gatewayAutoContinueFreshness: parseHermesInteger(agent.gateway_auto_continue_freshness, 'agent.gateway_auto_continue_freshness', 3600, 0, 604800, false),
    imageInputMode: normalizeHermesImageInputMode(agent.image_input_mode, false),
    agentVerbose: readHermesBool(agent.verbose, false),
    reasoningEffort: normalizeHermesReasoningEffort(agent.reasoning_effort, false),
    personalitiesJson: JSON.stringify(personalities, null, 2),
  }
}

export function mergeHermesAgentRuntimeConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesAgentRuntimeConfigValues(next)
  const agent = next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)
    ? mergeConfigsPreservingFields(next.agent, {})
    : {}
  agent.max_turns = parseHermesInteger(Object.hasOwn(form, 'agentMaxTurns') ? form.agentMaxTurns : currentValues.agentMaxTurns, 'agent.max_turns', 90, 1, 10000, true)
  agent.gateway_timeout = parseHermesInteger(Object.hasOwn(form, 'gatewayTimeout') ? form.gatewayTimeout : currentValues.gatewayTimeout, 'agent.gateway_timeout', 1800, 0, 604800, true)
  agent.restart_drain_timeout = parseHermesInteger(Object.hasOwn(form, 'restartDrainTimeout') ? form.restartDrainTimeout : currentValues.restartDrainTimeout, 'agent.restart_drain_timeout', 180, 0, 86400, true)
  agent.api_max_retries = parseHermesInteger(Object.hasOwn(form, 'apiMaxRetries') ? form.apiMaxRetries : currentValues.apiMaxRetries, 'agent.api_max_retries', 3, 1, 20, true)
  agent.gateway_timeout_warning = parseHermesInteger(Object.hasOwn(form, 'gatewayTimeoutWarning') ? form.gatewayTimeoutWarning : currentValues.gatewayTimeoutWarning, 'agent.gateway_timeout_warning', 900, 0, 604800, true)
  agent.clarify_timeout = parseHermesInteger(Object.hasOwn(form, 'clarifyTimeout') ? form.clarifyTimeout : currentValues.clarifyTimeout, 'agent.clarify_timeout', 600, 0, 86400, true)
  agent.gateway_notify_interval = parseHermesInteger(Object.hasOwn(form, 'gatewayNotifyInterval') ? form.gatewayNotifyInterval : currentValues.gatewayNotifyInterval, 'agent.gateway_notify_interval', 180, 0, 86400, true)
  agent.gateway_auto_continue_freshness = parseHermesInteger(Object.hasOwn(form, 'gatewayAutoContinueFreshness') ? form.gatewayAutoContinueFreshness : currentValues.gatewayAutoContinueFreshness, 'agent.gateway_auto_continue_freshness', 3600, 0, 604800, true)
  agent.image_input_mode = normalizeHermesImageInputMode(Object.hasOwn(form, 'imageInputMode') ? form.imageInputMode : currentValues.imageInputMode, true)
  agent.verbose = formHermesBool(form, 'agentVerbose', currentValues.agentVerbose)
  agent.reasoning_effort = normalizeHermesReasoningEffort(Object.hasOwn(form, 'reasoningEffort') ? form.reasoningEffort : currentValues.reasoningEffort, true)
  const personalities = parseHermesPersonalitiesJson(Object.hasOwn(form, 'personalitiesJson') ? form.personalitiesJson : currentValues.personalitiesJson)
  if (Object.keys(personalities).length) agent.personalities = personalities
  else delete agent.personalities
  next.agent = agent
  return next
}

function validateHermesQuickCommands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('quick_commands 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawName, rawCommand] of Object.entries(value)) {
    const name = String(rawName || '').trim().replace(/^\/+/, '')
    if (!name) throw new Error('quick_commands 命令名不能为空')
    if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
      throw new Error(`quick_commands.${name} 必须是对象`)
    }
    const command = mergeConfigsPreservingFields(rawCommand, {})
    const type = String(command.type || '').trim().toLowerCase()
    if (!['exec', 'alias'].includes(type)) {
      throw new Error(`quick_commands.${name}.type 必须是 exec 或 alias`)
    }
    command.type = type
    if (type === 'exec') {
      const shellCommand = String(command.command || '').trim()
      if (!shellCommand) throw new Error(`quick_commands.${name}.command 不能为空`)
      command.command = shellCommand
    }
    if (type === 'alias') {
      const target = String(command.target || '').trim()
      if (!target.startsWith('/')) throw new Error(`quick_commands.${name}.target 必须以 / 开头`)
      command.target = target
    }
    normalized[name] = command
  }
  return normalized
}

function parseHermesQuickCommandsJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`quick_commands JSON 格式错误: ${err.message}`)
  }
  return validateHermesQuickCommands(value)
}

export function buildHermesQuickCommandsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const quickCommands = root.quick_commands && typeof root.quick_commands === 'object' && !Array.isArray(root.quick_commands)
    ? validateHermesQuickCommands(root.quick_commands)
    : {}
  return {
    quickCommandsJson: JSON.stringify(quickCommands, null, 2),
  }
}

export function mergeHermesQuickCommandsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesQuickCommandsConfigValues(next)
  const quickCommands = parseHermesQuickCommandsJson(Object.hasOwn(form, 'quickCommandsJson') ? form.quickCommandsJson : currentValues.quickCommandsJson)
  if (Object.keys(quickCommands).length) next.quick_commands = quickCommands
  else delete next.quick_commands
  return next
}

function normalizeHermesModelConfigString(value, key, required = false) {
  if (value == null || value === '') {
    if (required) throw new Error(`${key} 不能为空`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  const text = value.trim()
  if (!text && required) throw new Error(`${key} 不能为空`)
  return text
}

function normalizeHermesXSearchModel(value, strict = false) {
  const text = String(value ?? '').trim()
  if (!text) {
    if (strict) throw new Error('x_search.model 不能为空')
    return 'grok-4.20-reasoning'
  }
  if (/^[a-zA-Z0-9_.:/-]+$/.test(text)) return text
  if (strict) throw new Error('x_search.model 只能包含字母、数字、下划线、点、斜杠、冒号和短横线')
  return 'grok-4.20-reasoning'
}

function normalizeHermesOptionalModelInteger(value, key) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return parseHermesInteger(raw, key, 0, 1, 10000000, true)
}

function normalizeHermesOptionalString(value, key) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  return value.trim()
}

function normalizeHermesCamofoxIdentity(value, key) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  const text = value.trim()
  if (!text) return ''
  if (!/^[A-Za-z0-9_.:@+-]+$/.test(text)) {
    throw new Error(`${key} 只能包含字母、数字、下划线、点、冒号、@、加号和短横线`)
  }
  return text
}

export function buildHermesModelConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const model = root.model && typeof root.model === 'object' && !Array.isArray(root.model) ? root.model : {}
  const defaultModel = typeof model.default === 'string' ? model.default : model.model
  return {
    modelDefault: typeof defaultModel === 'string' ? defaultModel.trim() : '',
    modelProvider: typeof model.provider === 'string' && model.provider.trim() ? model.provider.trim() : 'auto',
    modelBaseUrl: typeof model.base_url === 'string' ? model.base_url.trim() : '',
    modelContextLength: Number.isInteger(model.context_length) && model.context_length > 0 ? String(model.context_length) : '',
    modelMaxTokens: Number.isInteger(model.max_tokens) && model.max_tokens > 0 ? String(model.max_tokens) : '',
  }
}

export function mergeHermesModelConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesModelConfigValues(next)
  const model = next.model && typeof next.model === 'object' && !Array.isArray(next.model)
    ? mergeConfigsPreservingFields(next.model, {})
    : {}
  model.default = normalizeHermesModelConfigString(Object.hasOwn(form, 'modelDefault') ? form.modelDefault : currentValues.modelDefault, 'model.default', true)
  model.provider = normalizeHermesModelConfigString(Object.hasOwn(form, 'modelProvider') ? form.modelProvider : currentValues.modelProvider, 'model.provider', true) || 'auto'
  const baseUrl = normalizeHermesModelConfigString(Object.hasOwn(form, 'modelBaseUrl') ? form.modelBaseUrl : currentValues.modelBaseUrl, 'model.base_url')
  if (baseUrl) model.base_url = baseUrl
  else delete model.base_url
  const contextLength = normalizeHermesOptionalModelInteger(Object.hasOwn(form, 'modelContextLength') ? form.modelContextLength : currentValues.modelContextLength, 'model.context_length')
  if (contextLength) model.context_length = contextLength
  else delete model.context_length
  const maxTokens = normalizeHermesOptionalModelInteger(Object.hasOwn(form, 'modelMaxTokens') ? form.modelMaxTokens : currentValues.modelMaxTokens, 'model.max_tokens')
  if (maxTokens) model.max_tokens = maxTokens
  else delete model.max_tokens
  delete model.model
  next.model = model
  return next
}

export function buildHermesXSearchConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const xSearch = root.x_search && typeof root.x_search === 'object' && !Array.isArray(root.x_search)
    ? root.x_search
    : {}
  return {
    xSearchModel: normalizeHermesXSearchModel(xSearch.model, false),
    xSearchTimeoutSeconds: parseHermesInteger(xSearch.timeout_seconds, 'x_search.timeout_seconds', 180, 30, 3600, false),
    xSearchRetries: parseHermesInteger(xSearch.retries, 'x_search.retries', 2, 0, 20, false),
  }
}

export function mergeHermesXSearchConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesXSearchConfigValues(next)
  const xSearch = next.x_search && typeof next.x_search === 'object' && !Array.isArray(next.x_search)
    ? mergeConfigsPreservingFields(next.x_search, {})
    : {}
  xSearch.model = normalizeHermesXSearchModel(Object.hasOwn(form, 'xSearchModel') ? form.xSearchModel : currentValues.xSearchModel, true)
  xSearch.timeout_seconds = parseHermesInteger(Object.hasOwn(form, 'xSearchTimeoutSeconds') ? form.xSearchTimeoutSeconds : currentValues.xSearchTimeoutSeconds, 'x_search.timeout_seconds', 180, 30, 3600, true)
  xSearch.retries = parseHermesInteger(Object.hasOwn(form, 'xSearchRetries') ? form.xSearchRetries : currentValues.xSearchRetries, 'x_search.retries', 2, 0, 20, true)
  next.x_search = xSearch
  return next
}

function normalizeHermesContextEngine(value, strict = false) {
  const text = String(value ?? '').trim()
  if (!text) {
    if (strict) throw new Error('context.engine 不能为空')
    return 'compressor'
  }
  if (/^[a-zA-Z0-9_.-]+$/.test(text)) return text
  if (strict) throw new Error('context.engine 只能包含字母、数字、下划线、点和短横线')
  return 'compressor'
}

export function buildHermesContextConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const context = root.context && typeof root.context === 'object' && !Array.isArray(root.context)
    ? root.context
    : {}
  return {
    contextEngine: normalizeHermesContextEngine(context.engine, false),
  }
}

export function mergeHermesContextConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesContextConfigValues(next)
  const context = next.context && typeof next.context === 'object' && !Array.isArray(next.context)
    ? mergeConfigsPreservingFields(next.context, {})
    : {}
  context.engine = normalizeHermesContextEngine(Object.hasOwn(form, 'contextEngine') ? form.contextEngine : currentValues.contextEngine, true)
  next.context = context
  return next
}

function isHermesModelAliasName(value) {
  return /^[a-zA-Z0-9_.-]+$/.test(String(value || '').trim())
}

function normalizeHermesModelAliasString(entry, field, key, required = false) {
  if (!Object.hasOwn(entry, field) || entry[field] == null || entry[field] === '') {
    if (required) throw new Error(`${key}.${field} 不能为空`)
    delete entry[field]
    return
  }
  if (typeof entry[field] !== 'string') throw new Error(`${key}.${field} 必须是字符串`)
  const value = entry[field].trim()
  if (!value && required) throw new Error(`${key}.${field} 不能为空`)
  if (value) entry[field] = value
  else delete entry[field]
}

function validateHermesModelAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model_aliases 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawAlias, rawConfig] of Object.entries(value)) {
    const alias = String(rawAlias || '').trim()
    if (!alias || !isHermesModelAliasName(alias)) {
      throw new Error(`model_aliases.${rawAlias || '<empty>'} 别名只能包含字母、数字、下划线、点和短横线`)
    }
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(`model_aliases.${alias} 必须是 JSON 对象`)
    }
    const entry = mergeConfigsPreservingFields(rawConfig, {})
    normalizeHermesModelAliasString(entry, 'model', `model_aliases.${alias}`, true)
    normalizeHermesModelAliasString(entry, 'provider', `model_aliases.${alias}`)
    normalizeHermesModelAliasString(entry, 'base_url', `model_aliases.${alias}`)
    normalized[alias] = entry
  }
  return normalized
}

function parseHermesModelAliasesJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`model_aliases JSON 格式错误: ${err.message}`)
  }
  return validateHermesModelAliases(value)
}

export function buildHermesModelAliasesConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const modelAliases = root.model_aliases && typeof root.model_aliases === 'object' && !Array.isArray(root.model_aliases)
    ? validateHermesModelAliases(root.model_aliases)
    : {}
  return {
    modelAliasesJson: JSON.stringify(modelAliases, null, 2),
  }
}

export function mergeHermesModelAliasesConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesModelAliasesConfigValues(next)
  const modelAliases = parseHermesModelAliasesJson(Object.hasOwn(form, 'modelAliasesJson') ? form.modelAliasesJson : currentValues.modelAliasesJson)
  if (Object.keys(modelAliases).length) next.model_aliases = modelAliases
  else delete next.model_aliases
  return next
}

function normalizeHermesHookTimeout(entry, key) {
  if (!Object.hasOwn(entry, 'timeout') || entry.timeout == null || entry.timeout === '') {
    delete entry.timeout
    return
  }
  entry.timeout = parseHermesInteger(entry.timeout, `${key}.timeout`, 30, 1, 86400, true)
}

function validateHermesHooks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hooks 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawEvent, rawEntries] of Object.entries(value)) {
    const event = String(rawEvent || '').trim()
    if (!HERMES_HOOK_EVENTS.has(event)) {
      throw new Error(`hooks.${event || '<empty>'} 事件名不受支持`)
    }
    if (!Array.isArray(rawEntries)) {
      throw new Error(`hooks.${event} 必须是数组`)
    }
    const entries = rawEntries.map((rawEntry, index) => {
      const key = `hooks.${event}.${index}`
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error(`${key} 必须是 JSON 对象`)
      }
      const entry = mergeConfigsPreservingFields(rawEntry, {})
      const command = typeof entry.command === 'string' ? entry.command.trim() : ''
      if (!command) throw new Error(`${key}.command 不能为空`)
      entry.command = command
      if (Object.hasOwn(entry, 'matcher') && entry.matcher != null) {
        if (typeof entry.matcher !== 'string') throw new Error(`${key}.matcher 必须是字符串`)
        entry.matcher = entry.matcher.trim()
      }
      normalizeHermesHookTimeout(entry, key)
      return entry
    })
    if (entries.length) normalized[event] = entries
  }
  return normalized
}

function parseHermesHooksJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`hooks JSON 格式错误: ${err.message}`)
  }
  return validateHermesHooks(value)
}

export function buildHermesHooksConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const hooks = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
    ? validateHermesHooks(root.hooks)
    : {}
  return {
    hooksAutoAccept: readHermesBool(root.hooks_auto_accept, false),
    hooksJson: JSON.stringify(hooks, null, 2),
  }
}

export function mergeHermesHooksConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesHooksConfigValues(next)
  const hooks = parseHermesHooksJson(Object.hasOwn(form, 'hooksJson') ? form.hooksJson : currentValues.hooksJson)
  next.hooks_auto_accept = formHermesBool(form, 'hooksAutoAccept', currentValues.hooksAutoAccept)
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  return next
}

function normalizeHermesMcpServerName(value) {
  const name = String(value ?? '').trim()
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(`mcp_servers.${name || '<empty>'} 服务名只能包含字母、数字、下划线、点和短横线`)
  }
  return name
}

function normalizeHermesStringArray(value, key) {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${key} 必须是字符串数组`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${key}.${index} 必须是字符串`)
    return item
  })
}

function normalizeHermesStringMap(value, key) {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} 必须是 JSON 对象`)
  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const itemKey = String(rawKey || '').trim()
    if (!itemKey) throw new Error(`${key} 键名不能为空`)
    if (typeof rawValue !== 'string') throw new Error(`${key}.${itemKey} 必须是字符串`)
    normalized[itemKey] = rawValue
  }
  return normalized
}

function normalizeHermesMcpTimeout(entry, field, key) {
  if (!Object.hasOwn(entry, field) || entry[field] == null || entry[field] === '') {
    delete entry[field]
    return
  }
  entry[field] = parseHermesInteger(entry[field], key, 120, 1, 86400, true)
}

function normalizeHermesMcpSampling(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} 必须是 JSON 对象`)
  }
  const sampling = mergeConfigsPreservingFields(value, {})
  if (Object.hasOwn(sampling, 'enabled')) {
    if (typeof sampling.enabled !== 'boolean') throw new Error(`${key}.enabled 必须是布尔值`)
  }
  if (Object.hasOwn(sampling, 'model')) {
    if (sampling.model == null || sampling.model === '') {
      delete sampling.model
    } else if (typeof sampling.model !== 'string') {
      throw new Error(`${key}.model 必须是字符串`)
    } else {
      const model = sampling.model.trim()
      if (model) sampling.model = model
      else delete sampling.model
    }
  }
  if (Object.hasOwn(sampling, 'max_tokens_cap')) {
    sampling.max_tokens_cap = parseHermesInteger(sampling.max_tokens_cap, `${key}.max_tokens_cap`, 4096, 1, 1000000, true)
  }
  if (Object.hasOwn(sampling, 'timeout')) {
    sampling.timeout = parseHermesInteger(sampling.timeout, `${key}.timeout`, 30, 1, 86400, true)
  }
  if (Object.hasOwn(sampling, 'max_rpm')) {
    sampling.max_rpm = parseHermesInteger(sampling.max_rpm, `${key}.max_rpm`, 10, 1, 100000, true)
  }
  if (Object.hasOwn(sampling, 'allowed_models')) {
    sampling.allowed_models = normalizeHermesStringArray(sampling.allowed_models, `${key}.allowed_models`)
  }
  if (Object.hasOwn(sampling, 'max_tool_rounds')) {
    sampling.max_tool_rounds = parseHermesInteger(sampling.max_tool_rounds, `${key}.max_tool_rounds`, 5, 0, 1000, true)
  }
  if (Object.hasOwn(sampling, 'log_level')) {
    if (sampling.log_level == null || sampling.log_level === '') {
      delete sampling.log_level
    } else if (typeof sampling.log_level !== 'string') {
      throw new Error(`${key}.log_level 必须是字符串`)
    } else {
      const level = sampling.log_level.trim().toLowerCase()
      if (!['debug', 'info', 'warning', 'error'].includes(level)) {
        throw new Error(`${key}.log_level 必须是 debug、info、warning 或 error`)
      }
      sampling.log_level = level
    }
  }
  return sampling
}

function validateHermesMcpServers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mcp_servers 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawName, rawConfig] of Object.entries(value)) {
    const name = normalizeHermesMcpServerName(rawName)
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(`mcp_servers.${name} 必须是 JSON 对象`)
    }
    const entry = mergeConfigsPreservingFields(rawConfig, {})
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (Object.hasOwn(entry, 'command')) {
      if (!command) throw new Error(`mcp_servers.${name}.command 不能为空`)
      entry.command = command
    }
    if (Object.hasOwn(entry, 'url')) {
      if (!/^https?:\/\//i.test(url)) throw new Error(`mcp_servers.${name}.url 必须以 http:// 或 https:// 开头`)
      entry.url = url
    }
    if (!command && !url) throw new Error(`mcp_servers.${name} 需要 command 或 url`)
    if (Object.hasOwn(entry, 'args')) entry.args = normalizeHermesStringArray(entry.args, `mcp_servers.${name}.args`)
    if (Object.hasOwn(entry, 'env')) entry.env = normalizeHermesStringMap(entry.env, `mcp_servers.${name}.env`)
    if (Object.hasOwn(entry, 'headers')) entry.headers = normalizeHermesStringMap(entry.headers, `mcp_servers.${name}.headers`)
    normalizeHermesMcpTimeout(entry, 'timeout', `mcp_servers.${name}.timeout`)
    normalizeHermesMcpTimeout(entry, 'connect_timeout', `mcp_servers.${name}.connect_timeout`)
    if (Object.hasOwn(entry, 'sampling')) entry.sampling = normalizeHermesMcpSampling(entry.sampling, `mcp_servers.${name}.sampling`)
    normalized[name] = entry
  }
  return normalized
}

function parseHermesMcpServersJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`mcp_servers JSON 格式错误: ${err.message}`)
  }
  return validateHermesMcpServers(value)
}

export function buildHermesMcpServersConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const mcpServers = root.mcp_servers && typeof root.mcp_servers === 'object' && !Array.isArray(root.mcp_servers)
    ? validateHermesMcpServers(root.mcp_servers)
    : {}
  return {
    mcpServersJson: JSON.stringify(mcpServers, null, 2),
  }
}

export function mergeHermesMcpServersConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesMcpServersConfigValues(next)
  const mcpServers = parseHermesMcpServersJson(Object.hasOwn(form, 'mcpServersJson') ? form.mcpServersJson : currentValues.mcpServersJson)
  if (Object.keys(mcpServers).length) next.mcp_servers = mcpServers
  else delete next.mcp_servers
  return next
}

function isHermesProviderOverrideName(value) {
  return /^[a-zA-Z0-9_.-]+$/.test(String(value || '').trim())
}

function isHermesProviderModelName(value) {
  const text = String(value || '').trim()
  return !!text && !text.split('/').includes('..') && /^[a-zA-Z0-9_.:/@+-]+$/.test(text)
}

function normalizeHermesProviderTimeout(value, key) {
  if (value === undefined || value === null || value === '') return undefined
  return parseHermesInteger(value, key, 0, 1, 86400, true)
}

function normalizeHermesProviderModelOverrides(value, key) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} 必须是 JSON 对象`)
  }
  const normalized = {}
  for (const [rawModel, rawConfig] of Object.entries(value)) {
    const model = String(rawModel || '').trim()
    if (!isHermesProviderModelName(model)) {
      throw new Error(`${key}.${model || '<empty>'} 模型名只能包含字母、数字、下划线、点、斜杠、冒号、@、加号和短横线`)
    }
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(`${key}.${model} 必须是 JSON 对象`)
    }
    const entry = mergeConfigsPreservingFields(rawConfig, {})
    for (const field of ['timeout_seconds', 'stale_timeout_seconds']) {
      const parsed = normalizeHermesProviderTimeout(entry[field], `${key}.${model}.${field}`)
      if (parsed === undefined) delete entry[field]
      else entry[field] = parsed
    }
    normalized[model] = entry
  }
  return normalized
}

function validateHermesProviderOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('providers 必须是 JSON 对象')
  }
  const normalized = {}
  for (const [rawProvider, rawConfig] of Object.entries(value)) {
    const provider = String(rawProvider || '').trim().toLowerCase()
    if (!provider || !isHermesProviderOverrideName(provider)) {
      throw new Error(`providers.${rawProvider || '<empty>'} provider 名只能包含字母、数字、下划线、点和短横线`)
    }
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(`providers.${provider} 必须是 JSON 对象`)
    }
    const entry = mergeConfigsPreservingFields(rawConfig, {})
    for (const field of ['request_timeout_seconds', 'stale_timeout_seconds']) {
      const parsed = normalizeHermesProviderTimeout(entry[field], `providers.${provider}.${field}`)
      if (parsed === undefined) delete entry[field]
      else entry[field] = parsed
    }
    if (Object.hasOwn(entry, 'models')) {
      entry.models = normalizeHermesProviderModelOverrides(entry.models, `providers.${provider}.models`)
    }
    normalized[provider] = entry
  }
  return normalized
}

function parseHermesProviderOverridesJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`providers JSON 格式错误: ${err.message}`)
  }
  return validateHermesProviderOverrides(value)
}

export function buildHermesProviderOverridesConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const providers = root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
    ? validateHermesProviderOverrides(root.providers)
    : {}
  return {
    providerOverridesJson: JSON.stringify(providers, null, 2),
  }
}

export function mergeHermesProviderOverridesConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesProviderOverridesConfigValues(next)
  const providers = parseHermesProviderOverridesJson(Object.hasOwn(form, 'providerOverridesJson') ? form.providerOverridesJson : currentValues.providerOverridesJson)
  if (Object.keys(providers).length) next.providers = providers
  else delete next.providers
  return next
}

function normalizeHermesUnauthorizedDmBehavior(value, strict = false) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['pair', 'ignore'].includes(normalized)) return normalized
  if (strict) throw new Error('unauthorized_dm_behavior 必须是 pair 或 ignore')
  return 'pair'
}

export function buildHermesUnauthorizedDmConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return {
    unauthorizedDmBehavior: normalizeHermesUnauthorizedDmBehavior(root.unauthorized_dm_behavior, false),
  }
}

export function mergeHermesUnauthorizedDmConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesUnauthorizedDmConfigValues(next)
  next.unauthorized_dm_behavior = normalizeHermesUnauthorizedDmBehavior(
    Object.hasOwn(form, 'unauthorizedDmBehavior') ? form.unauthorizedDmBehavior : currentValues.unauthorizedDmBehavior,
    true,
  )
  return next
}

export function buildHermesSecurityConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const security = root.security && typeof root.security === 'object' && !Array.isArray(root.security)
    ? root.security
    : {}
  const tirithPath = typeof security.tirith_path === 'string' && security.tirith_path.trim()
    ? security.tirith_path.trim()
    : 'tirith'
  return {
    tirithEnabled: readHermesBool(security.tirith_enabled, true),
    tirithPath,
    tirithTimeout: parseHermesInteger(security.tirith_timeout, 'security.tirith_timeout', 5, 1, 300, false),
    tirithFailOpen: readHermesBool(security.tirith_fail_open, true),
    installPolicyJson: security.installPolicy && typeof security.installPolicy === 'object' && !Array.isArray(security.installPolicy)
      ? JSON.stringify(security.installPolicy, null, 2)
      : '',
  }
}

function parseHermesInstallPolicyJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`security.installPolicy JSON 格式错误: ${err.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('security.installPolicy 必须是 JSON 对象')
  }
  return value
}

export function mergeHermesSecurityConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesSecurityConfigValues(next)
  const security = next.security && typeof next.security === 'object' && !Array.isArray(next.security)
    ? mergeConfigsPreservingFields(next.security, {})
    : {}
  const tirithPath = String(Object.hasOwn(form, 'tirithPath') ? form.tirithPath : currentValues.tirithPath).trim()
  if (!tirithPath) throw new Error('security.tirith_path 不能为空')
  security.tirith_enabled = formHermesBool(form, 'tirithEnabled', currentValues.tirithEnabled)
  security.tirith_path = tirithPath
  security.tirith_timeout = parseHermesInteger(Object.hasOwn(form, 'tirithTimeout') ? form.tirithTimeout : currentValues.tirithTimeout, 'security.tirith_timeout', 5, 1, 300, true)
  security.tirith_fail_open = formHermesBool(form, 'tirithFailOpen', currentValues.tirithFailOpen)
  const installPolicy = parseHermesInstallPolicyJson(Object.hasOwn(form, 'installPolicyJson') ? form.installPolicyJson : currentValues.installPolicyJson)
  if (installPolicy) security.installPolicy = installPolicy
  else delete security.installPolicy
  next.security = security
  return next
}

function normalizeHermesHumanDelayMode(value, strict = false) {
  const mode = String(value ?? '').trim().toLowerCase() || 'off'
  if (['off', 'natural', 'custom'].includes(mode)) return mode
  if (strict) throw new Error('human_delay.mode 必须是 off、natural 或 custom')
  return 'off'
}

export function buildHermesHumanDelayConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const humanDelay = root.human_delay && typeof root.human_delay === 'object' && !Array.isArray(root.human_delay)
    ? root.human_delay
    : {}
  const minMs = parseHermesInteger(humanDelay.min_ms, 'human_delay.min_ms', 800, 0, 60000, false)
  const maxMs = parseHermesInteger(humanDelay.max_ms, 'human_delay.max_ms', 2500, 0, 60000, false)
  return {
    humanDelayMode: normalizeHermesHumanDelayMode(humanDelay.mode, false),
    humanDelayMinMs: minMs,
    humanDelayMaxMs: Math.max(maxMs, minMs),
  }
}

export function mergeHermesHumanDelayConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesHumanDelayConfigValues(next)
  const humanDelay = next.human_delay && typeof next.human_delay === 'object' && !Array.isArray(next.human_delay)
    ? mergeConfigsPreservingFields(next.human_delay, {})
    : {}
  const mode = normalizeHermesHumanDelayMode(Object.hasOwn(form, 'humanDelayMode') ? form.humanDelayMode : currentValues.humanDelayMode, true)
  const minMs = parseHermesInteger(Object.hasOwn(form, 'humanDelayMinMs') ? form.humanDelayMinMs : currentValues.humanDelayMinMs, 'human_delay.min_ms', 800, 0, 60000, true)
  const maxMs = parseHermesInteger(Object.hasOwn(form, 'humanDelayMaxMs') ? form.humanDelayMaxMs : currentValues.humanDelayMaxMs, 'human_delay.max_ms', 2500, 0, 60000, true)
  if (maxMs < minMs) throw new Error('human_delay.max_ms 不能小于 min_ms')
  humanDelay.mode = mode
  humanDelay.min_ms = minMs
  humanDelay.max_ms = maxMs
  next.human_delay = humanDelay
  return next
}

export function buildHermesStreamingConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const streaming = hermesStreamingConfigSource(root)
  return {
    enabled: readHermesBool(streaming.enabled, false),
    transport: normalizeHermesStreamingTransport(streaming.transport, false),
    editInterval: parseHermesFloat(streaming.edit_interval, 'streaming.edit_interval', 0.8, 0.05, 60, false),
    bufferThreshold: parseHermesInteger(streaming.buffer_threshold, 'streaming.buffer_threshold', 24, 1, 5000, false),
    cursor: typeof streaming.cursor === 'string' ? streaming.cursor : ' ▉',
    freshFinalAfterSeconds: parseHermesFloat(streaming.fresh_final_after_seconds, 'streaming.fresh_final_after_seconds', 60, 0, 86400, false),
  }
}

export function mergeHermesStreamingConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesStreamingConfigValues(next)
  const streaming = next.streaming && typeof next.streaming === 'object' && !Array.isArray(next.streaming)
    ? mergeConfigsPreservingFields(next.streaming, {})
    : {}
  streaming.enabled = formHermesBool(form, 'enabled', currentValues.enabled)
  streaming.transport = normalizeHermesStreamingTransport(Object.hasOwn(form, 'transport') ? form.transport : currentValues.transport, true)
  streaming.edit_interval = parseHermesFloat(Object.hasOwn(form, 'editInterval') ? form.editInterval : currentValues.editInterval, 'streaming.edit_interval', 0.8, 0.05, 60, true)
  streaming.buffer_threshold = parseHermesInteger(Object.hasOwn(form, 'bufferThreshold') ? form.bufferThreshold : currentValues.bufferThreshold, 'streaming.buffer_threshold', 24, 1, 5000, true)
  streaming.cursor = Object.hasOwn(form, 'cursor') ? String(form.cursor ?? '') : currentValues.cursor
  streaming.fresh_final_after_seconds = parseHermesFloat(Object.hasOwn(form, 'freshFinalAfterSeconds') ? form.freshFinalAfterSeconds : currentValues.freshFinalAfterSeconds, 'streaming.fresh_final_after_seconds', 60, 0, 86400, true)
  next.streaming = streaming
  return next
}

export function buildHermesExecutionLimitsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const codeExecution = root.code_execution && typeof root.code_execution === 'object' && !Array.isArray(root.code_execution)
    ? root.code_execution
    : {}
  const delegation = root.delegation && typeof root.delegation === 'object' && !Array.isArray(root.delegation)
    ? root.delegation
    : {}
  return {
    codeExecutionMode: normalizeHermesCodeExecutionMode(codeExecution.mode, false),
    codeExecutionTimeout: parseHermesInteger(codeExecution.timeout, 'code_execution.timeout', 300, 1, 86400, false),
    codeExecutionMaxToolCalls: parseHermesInteger(codeExecution.max_tool_calls, 'code_execution.max_tool_calls', 50, 1, 10000, false),
    delegationMaxIterations: parseHermesInteger(delegation.max_iterations, 'delegation.max_iterations', 50, 1, 1000, false),
    delegationChildTimeoutSeconds: parseHermesInteger(delegation.child_timeout_seconds, 'delegation.child_timeout_seconds', 600, 30, 86400, false),
    delegationMaxConcurrentChildren: parseHermesInteger(delegation.max_concurrent_children, 'delegation.max_concurrent_children', 3, 1, 100, false),
    delegationMaxSpawnDepth: parseHermesInteger(delegation.max_spawn_depth, 'delegation.max_spawn_depth', 1, 1, 3, false),
    delegationOrchestratorEnabled: readHermesBool(delegation.orchestrator_enabled, true),
    delegationSubagentAutoApprove: readHermesBool(delegation.subagent_auto_approve, false),
    delegationInheritMcpToolsets: readHermesBool(delegation.inherit_mcp_toolsets, true),
    delegationModel: typeof delegation.model === 'string' ? delegation.model.trim() : '',
    delegationProvider: typeof delegation.provider === 'string' ? delegation.provider.trim() : '',
  }
}

export function buildHermesIoSafetyConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const toolOutput = root.tool_output && typeof root.tool_output === 'object' && !Array.isArray(root.tool_output)
    ? root.tool_output
    : {}
  return {
    fileReadMaxChars: parseHermesInteger(root.file_read_max_chars, 'file_read_max_chars', 100000, 1000, 1000000, false),
    toolOutputMaxBytes: parseHermesInteger(toolOutput.max_bytes, 'tool_output.max_bytes', 50000, 1000, 1000000, false),
    toolOutputMaxLines: parseHermesInteger(toolOutput.max_lines, 'tool_output.max_lines', 2000, 1, 100000, false),
    toolOutputMaxLineLength: parseHermesInteger(toolOutput.max_line_length, 'tool_output.max_line_length', 2000, 1, 100000, false),
  }
}

export function mergeHermesIoSafetyConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesIoSafetyConfigValues(next)
  const toolOutput = next.tool_output && typeof next.tool_output === 'object' && !Array.isArray(next.tool_output)
    ? mergeConfigsPreservingFields(next.tool_output, {})
    : {}

  next.file_read_max_chars = parseHermesInteger(Object.hasOwn(form, 'fileReadMaxChars') ? form.fileReadMaxChars : currentValues.fileReadMaxChars, 'file_read_max_chars', 100000, 1000, 1000000, true)
  toolOutput.max_bytes = parseHermesInteger(Object.hasOwn(form, 'toolOutputMaxBytes') ? form.toolOutputMaxBytes : currentValues.toolOutputMaxBytes, 'tool_output.max_bytes', 50000, 1000, 1000000, true)
  toolOutput.max_lines = parseHermesInteger(Object.hasOwn(form, 'toolOutputMaxLines') ? form.toolOutputMaxLines : currentValues.toolOutputMaxLines, 'tool_output.max_lines', 2000, 1, 100000, true)
  toolOutput.max_line_length = parseHermesInteger(Object.hasOwn(form, 'toolOutputMaxLineLength') ? form.toolOutputMaxLineLength : currentValues.toolOutputMaxLineLength, 'tool_output.max_line_length', 2000, 1, 100000, true)
  next.tool_output = toolOutput
  return next
}

export function buildHermesCheckpointsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const checkpoints = root.checkpoints && typeof root.checkpoints === 'object' && !Array.isArray(root.checkpoints)
    ? root.checkpoints
    : {}
  return {
    checkpointsEnabled: readHermesBool(checkpoints.enabled, false),
    checkpointMaxSnapshots: parseHermesInteger(checkpoints.max_snapshots, 'checkpoints.max_snapshots', 20, 1, 10000, false),
    checkpointMaxTotalSizeMb: parseHermesInteger(checkpoints.max_total_size_mb, 'checkpoints.max_total_size_mb', 500, 0, 10485760, false),
    checkpointMaxFileSizeMb: parseHermesInteger(checkpoints.max_file_size_mb, 'checkpoints.max_file_size_mb', 10, 0, 1048576, false),
    checkpointAutoPrune: readHermesBool(checkpoints.auto_prune, true),
    checkpointRetentionDays: parseHermesInteger(checkpoints.retention_days, 'checkpoints.retention_days', 7, 1, 3650, false),
    checkpointDeleteOrphans: readHermesBool(checkpoints.delete_orphans, true),
    checkpointMinIntervalHours: parseHermesInteger(checkpoints.min_interval_hours, 'checkpoints.min_interval_hours', 24, 0, 8760, false),
  }
}

export function mergeHermesCheckpointsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesCheckpointsConfigValues(next)
  const checkpoints = next.checkpoints && typeof next.checkpoints === 'object' && !Array.isArray(next.checkpoints)
    ? mergeConfigsPreservingFields(next.checkpoints, {})
    : {}

  checkpoints.enabled = formHermesBool(form, 'checkpointsEnabled', currentValues.checkpointsEnabled)
  checkpoints.max_snapshots = parseHermesInteger(Object.hasOwn(form, 'checkpointMaxSnapshots') ? form.checkpointMaxSnapshots : currentValues.checkpointMaxSnapshots, 'checkpoints.max_snapshots', 20, 1, 10000, true)
  checkpoints.max_total_size_mb = parseHermesInteger(Object.hasOwn(form, 'checkpointMaxTotalSizeMb') ? form.checkpointMaxTotalSizeMb : currentValues.checkpointMaxTotalSizeMb, 'checkpoints.max_total_size_mb', 500, 0, 10485760, true)
  checkpoints.max_file_size_mb = parseHermesInteger(Object.hasOwn(form, 'checkpointMaxFileSizeMb') ? form.checkpointMaxFileSizeMb : currentValues.checkpointMaxFileSizeMb, 'checkpoints.max_file_size_mb', 10, 0, 1048576, true)
  checkpoints.auto_prune = formHermesBool(form, 'checkpointAutoPrune', currentValues.checkpointAutoPrune)
  checkpoints.retention_days = parseHermesInteger(Object.hasOwn(form, 'checkpointRetentionDays') ? form.checkpointRetentionDays : currentValues.checkpointRetentionDays, 'checkpoints.retention_days', 7, 1, 3650, true)
  checkpoints.delete_orphans = formHermesBool(form, 'checkpointDeleteOrphans', currentValues.checkpointDeleteOrphans)
  checkpoints.min_interval_hours = parseHermesInteger(Object.hasOwn(form, 'checkpointMinIntervalHours') ? form.checkpointMinIntervalHours : currentValues.checkpointMinIntervalHours, 'checkpoints.min_interval_hours', 24, 0, 8760, true)
  next.checkpoints = checkpoints
  return next
}

export function buildHermesCronConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const cron = root.cron && typeof root.cron === 'object' && !Array.isArray(root.cron)
    ? root.cron
    : {}
  return {
    cronWrapResponse: readHermesBool(cron.wrap_response, true),
    cronMaxParallelJobs: parseHermesInteger(cron.max_parallel_jobs, 'cron.max_parallel_jobs', 0, 0, 10000, false),
  }
}

export function mergeHermesCronConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesCronConfigValues(next)
  const cron = next.cron && typeof next.cron === 'object' && !Array.isArray(next.cron)
    ? mergeConfigsPreservingFields(next.cron, {})
    : {}

  cron.wrap_response = formHermesBool(form, 'cronWrapResponse', currentValues.cronWrapResponse)
  const maxParallelJobs = parseHermesInteger(Object.hasOwn(form, 'cronMaxParallelJobs') ? form.cronMaxParallelJobs : currentValues.cronMaxParallelJobs, 'cron.max_parallel_jobs', 0, 0, 10000, true)
  cron.max_parallel_jobs = maxParallelJobs === 0 ? null : maxParallelJobs
  next.cron = cron
  return next
}

export function buildHermesSessionsMaintenanceConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const sessions = root.sessions && typeof root.sessions === 'object' && !Array.isArray(root.sessions)
    ? root.sessions
    : {}
  return {
    sessionsAutoPrune: readHermesBool(sessions.auto_prune, false),
    sessionsRetentionDays: parseHermesInteger(sessions.retention_days, 'sessions.retention_days', 90, 1, 36500, false),
    sessionsVacuumAfterPrune: readHermesBool(sessions.vacuum_after_prune, true),
    sessionsMinIntervalHours: parseHermesInteger(sessions.min_interval_hours, 'sessions.min_interval_hours', 24, 0, 87600, false),
    sessionsWriteJsonSnapshots: readHermesBool(sessions.write_json_snapshots, false),
  }
}

export function mergeHermesSessionsMaintenanceConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesSessionsMaintenanceConfigValues(next)
  const sessions = next.sessions && typeof next.sessions === 'object' && !Array.isArray(next.sessions)
    ? mergeConfigsPreservingFields(next.sessions, {})
    : {}

  sessions.auto_prune = formHermesBool(form, 'sessionsAutoPrune', currentValues.sessionsAutoPrune)
  sessions.retention_days = parseHermesInteger(Object.hasOwn(form, 'sessionsRetentionDays') ? form.sessionsRetentionDays : currentValues.sessionsRetentionDays, 'sessions.retention_days', 90, 1, 36500, true)
  sessions.vacuum_after_prune = formHermesBool(form, 'sessionsVacuumAfterPrune', currentValues.sessionsVacuumAfterPrune)
  sessions.min_interval_hours = parseHermesInteger(Object.hasOwn(form, 'sessionsMinIntervalHours') ? form.sessionsMinIntervalHours : currentValues.sessionsMinIntervalHours, 'sessions.min_interval_hours', 24, 0, 87600, true)
  sessions.write_json_snapshots = formHermesBool(form, 'sessionsWriteJsonSnapshots', currentValues.sessionsWriteJsonSnapshots)
  next.sessions = sessions
  return next
}

export function buildHermesUpdatesConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const updates = root.updates && typeof root.updates === 'object' && !Array.isArray(root.updates)
    ? root.updates
    : {}
  return {
    updatesPreUpdateBackup: readHermesBool(updates.pre_update_backup, false),
    updatesBackupKeep: parseHermesInteger(updates.backup_keep, 'updates.backup_keep', 5, 1, 1000, false),
  }
}

export function mergeHermesUpdatesConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesUpdatesConfigValues(next)
  const updates = next.updates && typeof next.updates === 'object' && !Array.isArray(next.updates)
    ? mergeConfigsPreservingFields(next.updates, {})
    : {}

  updates.pre_update_backup = formHermesBool(form, 'updatesPreUpdateBackup', currentValues.updatesPreUpdateBackup)
  updates.backup_keep = parseHermesInteger(Object.hasOwn(form, 'updatesBackupKeep') ? form.updatesBackupKeep : currentValues.updatesBackupKeep, 'updates.backup_keep', 5, 1, 1000, true)
  next.updates = updates
  return next
}

export function buildHermesLoggingConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const logging = root.logging && typeof root.logging === 'object' && !Array.isArray(root.logging)
    ? root.logging
    : {}
  const memoryMonitor = logging.memory_monitor && typeof logging.memory_monitor === 'object' && !Array.isArray(logging.memory_monitor)
    ? logging.memory_monitor
    : {}
  return {
    loggingLevel: normalizeHermesLoggingLevel(logging.level, false),
    loggingMaxSizeMb: parseHermesInteger(logging.max_size_mb, 'logging.max_size_mb', 5, 1, 102400, false),
    loggingBackupCount: parseHermesInteger(logging.backup_count, 'logging.backup_count', 3, 0, 1000, false),
    loggingMemoryMonitorEnabled: readHermesBool(memoryMonitor.enabled, true),
    loggingMemoryMonitorIntervalSeconds: parseHermesInteger(memoryMonitor.interval_seconds, 'logging.memory_monitor.interval_seconds', 300, 1, 86400, false),
  }
}

export function mergeHermesLoggingConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesLoggingConfigValues(next)
  const logging = next.logging && typeof next.logging === 'object' && !Array.isArray(next.logging)
    ? mergeConfigsPreservingFields(next.logging, {})
    : {}
  const memoryMonitor = logging.memory_monitor && typeof logging.memory_monitor === 'object' && !Array.isArray(logging.memory_monitor)
    ? mergeConfigsPreservingFields(logging.memory_monitor, {})
    : {}

  logging.level = normalizeHermesLoggingLevel(Object.hasOwn(form, 'loggingLevel') ? form.loggingLevel : currentValues.loggingLevel, true)
  logging.max_size_mb = parseHermesInteger(Object.hasOwn(form, 'loggingMaxSizeMb') ? form.loggingMaxSizeMb : currentValues.loggingMaxSizeMb, 'logging.max_size_mb', 5, 1, 102400, true)
  logging.backup_count = parseHermesInteger(Object.hasOwn(form, 'loggingBackupCount') ? form.loggingBackupCount : currentValues.loggingBackupCount, 'logging.backup_count', 3, 0, 1000, true)
  memoryMonitor.enabled = formHermesBool(form, 'loggingMemoryMonitorEnabled', currentValues.loggingMemoryMonitorEnabled)
  memoryMonitor.interval_seconds = parseHermesInteger(Object.hasOwn(form, 'loggingMemoryMonitorIntervalSeconds') ? form.loggingMemoryMonitorIntervalSeconds : currentValues.loggingMemoryMonitorIntervalSeconds, 'logging.memory_monitor.interval_seconds', 300, 1, 86400, true)
  logging.memory_monitor = memoryMonitor
  next.logging = logging
  return next
}

export function buildHermesApprovalsConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const approvals = root.approvals && typeof root.approvals === 'object' && !Array.isArray(root.approvals)
    ? root.approvals
    : {}
  return {
    approvalMode: normalizeHermesApprovalMode(approvals.mode, false),
    approvalTimeout: parseHermesInteger(approvals.timeout, 'approvals.timeout', 60, 1, 86400, false),
    approvalCronMode: normalizeHermesApprovalCronMode(approvals.cron_mode, false),
    approvalMcpReloadConfirm: readHermesBool(approvals.mcp_reload_confirm, true),
    approvalDestructiveSlashConfirm: readHermesBool(approvals.destructive_slash_confirm, true),
  }
}

export function mergeHermesApprovalsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesApprovalsConfigValues(next)
  const approvals = next.approvals && typeof next.approvals === 'object' && !Array.isArray(next.approvals)
    ? mergeConfigsPreservingFields(next.approvals, {})
    : {}

  approvals.mode = normalizeHermesApprovalMode(Object.hasOwn(form, 'approvalMode') ? form.approvalMode : currentValues.approvalMode, true)
  approvals.timeout = parseHermesInteger(Object.hasOwn(form, 'approvalTimeout') ? form.approvalTimeout : currentValues.approvalTimeout, 'approvals.timeout', 60, 1, 86400, true)
  approvals.cron_mode = normalizeHermesApprovalCronMode(Object.hasOwn(form, 'approvalCronMode') ? form.approvalCronMode : currentValues.approvalCronMode, true)
  approvals.mcp_reload_confirm = formHermesBool(form, 'approvalMcpReloadConfirm', currentValues.approvalMcpReloadConfirm)
  approvals.destructive_slash_confirm = formHermesBool(form, 'approvalDestructiveSlashConfirm', currentValues.approvalDestructiveSlashConfirm)
  next.approvals = approvals
  return next
}

export function buildHermesPrivacyConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const privacy = root.privacy && typeof root.privacy === 'object' && !Array.isArray(root.privacy)
    ? root.privacy
    : {}
  return {
    redactPii: readHermesBool(privacy.redact_pii, false),
  }
}

export function mergeHermesPrivacyConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesPrivacyConfigValues(next)
  const privacy = next.privacy && typeof next.privacy === 'object' && !Array.isArray(next.privacy)
    ? mergeConfigsPreservingFields(next.privacy, {})
    : {}
  privacy.redact_pii = formHermesBool(form, 'redactPii', currentValues.redactPii)
  next.privacy = privacy
  return next
}

export function buildHermesBrowserConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const browser = root.browser && typeof root.browser === 'object' && !Array.isArray(root.browser)
    ? root.browser
    : {}
  const camofox = browser.camofox && typeof browser.camofox === 'object' && !Array.isArray(browser.camofox)
    ? browser.camofox
    : {}
  return {
    browserInactivityTimeout: parseHermesInteger(browser.inactivity_timeout, 'browser.inactivity_timeout', 120, 1, 86400, false),
    browserCommandTimeout: parseHermesInteger(browser.command_timeout, 'browser.command_timeout', 30, 5, 3600, false),
    browserRecordSessions: readHermesBool(browser.record_sessions, false),
    browserEngine: normalizeHermesBrowserEngine(browser.engine, false),
    browserAllowPrivateUrls: readHermesBool(browser.allow_private_urls, false),
    browserAutoLocalForPrivateUrls: readHermesBool(browser.auto_local_for_private_urls, true),
    browserCdpUrl: normalizeHermesOptionalString(browser.cdp_url, 'browser.cdp_url'),
    browserCamofoxManagedPersistence: readHermesBool(camofox.managed_persistence, false),
    browserCamofoxUserId: normalizeHermesCamofoxIdentity(camofox.user_id, 'browser.camofox.user_id'),
    browserCamofoxSessionKey: normalizeHermesCamofoxIdentity(camofox.session_key, 'browser.camofox.session_key'),
    browserCamofoxAdoptExistingTab: readHermesBool(camofox.adopt_existing_tab, false),
    browserDialogPolicy: normalizeHermesBrowserDialogPolicy(browser.dialog_policy, false),
    browserDialogTimeout: parseHermesInteger(browser.dialog_timeout_s, 'browser.dialog_timeout_s', 300, 1, 86400, false),
  }
}

export function mergeHermesBrowserConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesBrowserConfigValues(next)
  const browser = next.browser && typeof next.browser === 'object' && !Array.isArray(next.browser)
    ? mergeConfigsPreservingFields(next.browser, {})
    : {}
  browser.inactivity_timeout = parseHermesInteger(Object.hasOwn(form, 'browserInactivityTimeout') ? form.browserInactivityTimeout : currentValues.browserInactivityTimeout, 'browser.inactivity_timeout', 120, 1, 86400, true)
  browser.command_timeout = parseHermesInteger(Object.hasOwn(form, 'browserCommandTimeout') ? form.browserCommandTimeout : currentValues.browserCommandTimeout, 'browser.command_timeout', 30, 5, 3600, true)
  browser.record_sessions = formHermesBool(form, 'browserRecordSessions', currentValues.browserRecordSessions)
  browser.engine = normalizeHermesBrowserEngine(Object.hasOwn(form, 'browserEngine') ? form.browserEngine : currentValues.browserEngine, true)
  browser.allow_private_urls = formHermesBool(form, 'browserAllowPrivateUrls', currentValues.browserAllowPrivateUrls)
  browser.auto_local_for_private_urls = formHermesBool(form, 'browserAutoLocalForPrivateUrls', currentValues.browserAutoLocalForPrivateUrls)
  const cdpUrl = normalizeHermesOptionalString(Object.hasOwn(form, 'browserCdpUrl') ? form.browserCdpUrl : currentValues.browserCdpUrl, 'browser.cdp_url')
  if (cdpUrl) browser.cdp_url = cdpUrl
  else delete browser.cdp_url
  const camofox = browser.camofox && typeof browser.camofox === 'object' && !Array.isArray(browser.camofox)
    ? mergeConfigsPreservingFields(browser.camofox, {})
    : {}
  camofox.managed_persistence = formHermesBool(form, 'browserCamofoxManagedPersistence', currentValues.browserCamofoxManagedPersistence)
  const camofoxUserId = normalizeHermesCamofoxIdentity(Object.hasOwn(form, 'browserCamofoxUserId') ? form.browserCamofoxUserId : currentValues.browserCamofoxUserId, 'browser.camofox.user_id')
  if (camofoxUserId) camofox.user_id = camofoxUserId
  else delete camofox.user_id
  const camofoxSessionKey = normalizeHermesCamofoxIdentity(Object.hasOwn(form, 'browserCamofoxSessionKey') ? form.browserCamofoxSessionKey : currentValues.browserCamofoxSessionKey, 'browser.camofox.session_key')
  if (camofoxSessionKey) camofox.session_key = camofoxSessionKey
  else delete camofox.session_key
  camofox.adopt_existing_tab = formHermesBool(form, 'browserCamofoxAdoptExistingTab', currentValues.browserCamofoxAdoptExistingTab)
  browser.camofox = camofox
  browser.dialog_policy = normalizeHermesBrowserDialogPolicy(Object.hasOwn(form, 'browserDialogPolicy') ? form.browserDialogPolicy : currentValues.browserDialogPolicy, true)
  browser.dialog_timeout_s = parseHermesInteger(Object.hasOwn(form, 'browserDialogTimeout') ? form.browserDialogTimeout : currentValues.browserDialogTimeout, 'browser.dialog_timeout_s', 300, 1, 86400, true)
  next.browser = browser
  return next
}

export function buildHermesWebConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const web = root.web && typeof root.web === 'object' && !Array.isArray(root.web)
    ? root.web
    : {}
  return {
    webBackend: normalizeHermesWebBackend(web.backend, 'web.backend', false),
    webSearchBackend: normalizeHermesWebBackend(web.search_backend, 'web.search_backend', false),
    webExtractBackend: normalizeHermesWebBackend(web.extract_backend, 'web.extract_backend', false),
  }
}

export function mergeHermesWebConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesWebConfigValues(next)
  const web = next.web && typeof next.web === 'object' && !Array.isArray(next.web)
    ? mergeConfigsPreservingFields(next.web, {})
    : {}
  const backend = normalizeHermesWebBackend(Object.hasOwn(form, 'webBackend') ? form.webBackend : currentValues.webBackend, 'web.backend', true)
  const searchBackend = normalizeHermesWebBackend(Object.hasOwn(form, 'webSearchBackend') ? form.webSearchBackend : currentValues.webSearchBackend, 'web.search_backend', true)
  const extractBackend = normalizeHermesWebBackend(Object.hasOwn(form, 'webExtractBackend') ? form.webExtractBackend : currentValues.webExtractBackend, 'web.extract_backend', true)
  if (backend) web.backend = backend
  else delete web.backend
  if (searchBackend) web.search_backend = searchBackend
  else delete web.search_backend
  if (extractBackend) web.extract_backend = extractBackend
  else delete web.extract_backend
  next.web = web
  return next
}

function validateHermesModelCatalogProviders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model_catalog.providers 必须是 JSON object')
  }
  const normalized = {}
  for (const [provider, rawEntry] of Object.entries(value)) {
    const name = String(provider || '').trim()
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error(`model_catalog.providers.${provider} 名称只能包含字母、数字、下划线、点和短横线`)
    }
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`model_catalog.providers.${name} 必须是 object`)
    }
    const entry = mergeConfigsPreservingFields({}, rawEntry)
    if (Object.hasOwn(entry, 'url')) {
      const url = normalizeHermesHttpUrl(entry.url, `model_catalog.providers.${name}.url`, '', true)
      if (url) entry.url = url
      else delete entry.url
    }
    normalized[name] = entry
  }
  return normalized
}

function parseHermesModelCatalogProvidersJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`model_catalog.providers JSON 格式错误: ${err.message}`)
  }
  return validateHermesModelCatalogProviders(value)
}

export function buildHermesModelCatalogConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const modelCatalog = root.model_catalog && typeof root.model_catalog === 'object' && !Array.isArray(root.model_catalog)
    ? root.model_catalog
    : {}
  const providers = modelCatalog.providers && typeof modelCatalog.providers === 'object' && !Array.isArray(modelCatalog.providers)
    ? validateHermesModelCatalogProviders(modelCatalog.providers)
    : {}
  return {
    modelCatalogEnabled: readHermesBool(modelCatalog.enabled, true),
    modelCatalogUrl: normalizeHermesHttpUrl(modelCatalog.url, 'model_catalog.url', HERMES_MODEL_CATALOG_DEFAULT_URL, false),
    modelCatalogTtlHours: parseHermesInteger(modelCatalog.ttl_hours, 'model_catalog.ttl_hours', 24, 1, 8760, false),
    modelCatalogProvidersJson: JSON.stringify(providers, null, 2),
  }
}

export function mergeHermesModelCatalogConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesModelCatalogConfigValues(next)
  const modelCatalog = next.model_catalog && typeof next.model_catalog === 'object' && !Array.isArray(next.model_catalog)
    ? mergeConfigsPreservingFields(next.model_catalog, {})
    : {}
  modelCatalog.enabled = formHermesBool(form, 'modelCatalogEnabled', currentValues.modelCatalogEnabled)
  modelCatalog.url = normalizeHermesHttpUrl(Object.hasOwn(form, 'modelCatalogUrl') ? form.modelCatalogUrl : currentValues.modelCatalogUrl, 'model_catalog.url', HERMES_MODEL_CATALOG_DEFAULT_URL, true)
  modelCatalog.ttl_hours = parseHermesInteger(Object.hasOwn(form, 'modelCatalogTtlHours') ? form.modelCatalogTtlHours : currentValues.modelCatalogTtlHours, 'model_catalog.ttl_hours', 24, 1, 8760, true)
  const providers = parseHermesModelCatalogProvidersJson(Object.hasOwn(form, 'modelCatalogProvidersJson') ? form.modelCatalogProvidersJson : currentValues.modelCatalogProvidersJson)
  if (Object.keys(providers).length) modelCatalog.providers = providers
  else delete modelCatalog.providers
  next.model_catalog = modelCatalog
  return next
}

export function buildHermesLspConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const lsp = root.lsp && typeof root.lsp === 'object' && !Array.isArray(root.lsp)
    ? root.lsp
    : {}
  return {
    lspEnabled: readHermesBool(lsp.enabled, true),
    lspWaitMode: normalizeHermesLspWaitMode(lsp.wait_mode, false),
    lspWaitTimeout: parseHermesFloat(lsp.wait_timeout, 'lsp.wait_timeout', 5, 0.1, 120, false),
    lspInstallStrategy: normalizeHermesLspInstallStrategy(lsp.install_strategy, false),
  }
}

export function mergeHermesLspConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesLspConfigValues(next)
  const lsp = next.lsp && typeof next.lsp === 'object' && !Array.isArray(next.lsp)
    ? mergeConfigsPreservingFields(next.lsp, {})
    : {}
  lsp.enabled = formHermesBool(form, 'lspEnabled', currentValues.lspEnabled)
  lsp.wait_mode = normalizeHermesLspWaitMode(Object.hasOwn(form, 'lspWaitMode') ? form.lspWaitMode : currentValues.lspWaitMode, true)
  lsp.wait_timeout = parseHermesFloat(Object.hasOwn(form, 'lspWaitTimeout') ? form.lspWaitTimeout : currentValues.lspWaitTimeout, 'lsp.wait_timeout', 5, 0.1, 120, true)
  lsp.install_strategy = normalizeHermesLspInstallStrategy(Object.hasOwn(form, 'lspInstallStrategy') ? form.lspInstallStrategy : currentValues.lspInstallStrategy, true)
  next.lsp = lsp
  return next
}

export function buildHermesSttConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const stt = root.stt && typeof root.stt === 'object' && !Array.isArray(root.stt)
    ? root.stt
    : {}
  const local = stt.local && typeof stt.local === 'object' && !Array.isArray(stt.local)
    ? stt.local
    : {}
  const openai = stt.openai && typeof stt.openai === 'object' && !Array.isArray(stt.openai)
    ? stt.openai
    : {}
  const mistral = stt.mistral && typeof stt.mistral === 'object' && !Array.isArray(stt.mistral)
    ? stt.mistral
    : {}
  return {
    sttEnabled: readHermesBool(stt.enabled, true),
    sttProvider: normalizeHermesSttProvider(stt.provider, false),
    sttLocalModel: normalizeHermesSttLocalModel(local.model, false),
    sttLocalLanguage: normalizeHermesSttLanguage(local.language, false),
    sttOpenaiModel: normalizeHermesSttOpenaiModel(openai.model, false),
    sttMistralModel: normalizeHermesSttMistralModel(mistral.model, false),
  }
}

export function buildHermesTtsVoiceConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const tts = root.tts && typeof root.tts === 'object' && !Array.isArray(root.tts) ? root.tts : {}
  const edge = tts.edge && typeof tts.edge === 'object' && !Array.isArray(tts.edge) ? tts.edge : {}
  const openai = tts.openai && typeof tts.openai === 'object' && !Array.isArray(tts.openai) ? tts.openai : {}
  const elevenlabs = tts.elevenlabs && typeof tts.elevenlabs === 'object' && !Array.isArray(tts.elevenlabs) ? tts.elevenlabs : {}
  const xai = tts.xai && typeof tts.xai === 'object' && !Array.isArray(tts.xai) ? tts.xai : {}
  const mistral = tts.mistral && typeof tts.mistral === 'object' && !Array.isArray(tts.mistral) ? tts.mistral : {}
  const piper = tts.piper && typeof tts.piper === 'object' && !Array.isArray(tts.piper) ? tts.piper : {}
  const voice = root.voice && typeof root.voice === 'object' && !Array.isArray(root.voice) ? root.voice : {}
  return {
    ttsProvider: normalizeHermesTtsProvider(tts.provider, false),
    ttsEdgeVoice: typeof edge.voice === 'string' ? edge.voice.trim() : 'en-US-AriaNeural',
    ttsOpenaiModel: typeof openai.model === 'string' && openai.model.trim() ? openai.model.trim() : 'gpt-4o-mini-tts',
    ttsOpenaiVoice: normalizeHermesTtsOpenaiVoice(openai.voice, false),
    ttsElevenlabsVoiceId: typeof elevenlabs.voice_id === 'string' ? elevenlabs.voice_id.trim() : 'pNInz6obpgDQGcFmaJgB',
    ttsElevenlabsModelId: typeof elevenlabs.model_id === 'string' ? elevenlabs.model_id.trim() : 'eleven_multilingual_v2',
    ttsXaiVoiceId: typeof xai.voice_id === 'string' && xai.voice_id.trim() ? xai.voice_id.trim() : 'eve',
    ttsXaiLanguage: normalizeHermesVoiceLanguage(xai.language, false, 'tts.xai.language'),
    ttsXaiSampleRate: parseHermesInteger(xai.sample_rate, 'tts.xai.sample_rate', 24000, 8000, 192000, false),
    ttsXaiBitRate: parseHermesInteger(xai.bit_rate, 'tts.xai.bit_rate', 128000, 16000, 512000, false),
    ttsMistralModel: typeof mistral.model === 'string' && mistral.model.trim() ? mistral.model.trim() : 'voxtral-mini-tts-2603',
    ttsMistralVoiceId: typeof mistral.voice_id === 'string' ? mistral.voice_id.trim() : 'c69964a6-ab8b-4f8a-9465-ec0925096ec8',
    ttsPiperVoice: typeof piper.voice === 'string' ? piper.voice.trim() : 'en_US-lessac-medium',
    voiceRecordKey: typeof voice.record_key === 'string' ? voice.record_key.trim() : 'ctrl+b',
    voiceMaxRecordingSeconds: parseHermesInteger(voice.max_recording_seconds, 'voice.max_recording_seconds', 120, 1, 3600, false),
    voiceAutoTts: readHermesBool(voice.auto_tts, false),
    voiceBeepEnabled: readHermesBool(voice.beep_enabled, true),
    voiceSilenceThreshold: parseHermesInteger(voice.silence_threshold, 'voice.silence_threshold', 200, 0, 32767, false),
    voiceSilenceDuration: parseHermesFloat(voice.silence_duration, 'voice.silence_duration', 3, 0.1, 60, false),
  }
}

export function mergeHermesTtsVoiceConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesTtsVoiceConfigValues(next)
  const tts = next.tts && typeof next.tts === 'object' && !Array.isArray(next.tts) ? mergeConfigsPreservingFields(next.tts, {}) : {}
  const edge = tts.edge && typeof tts.edge === 'object' && !Array.isArray(tts.edge) ? mergeConfigsPreservingFields(tts.edge, {}) : {}
  const openai = tts.openai && typeof tts.openai === 'object' && !Array.isArray(tts.openai) ? mergeConfigsPreservingFields(tts.openai, {}) : {}
  const elevenlabs = tts.elevenlabs && typeof tts.elevenlabs === 'object' && !Array.isArray(tts.elevenlabs) ? mergeConfigsPreservingFields(tts.elevenlabs, {}) : {}
  const xai = tts.xai && typeof tts.xai === 'object' && !Array.isArray(tts.xai) ? mergeConfigsPreservingFields(tts.xai, {}) : {}
  const mistral = tts.mistral && typeof tts.mistral === 'object' && !Array.isArray(tts.mistral) ? mergeConfigsPreservingFields(tts.mistral, {}) : {}
  const piper = tts.piper && typeof tts.piper === 'object' && !Array.isArray(tts.piper) ? mergeConfigsPreservingFields(tts.piper, {}) : {}
  const voice = next.voice && typeof next.voice === 'object' && !Array.isArray(next.voice) ? mergeConfigsPreservingFields(next.voice, {}) : {}
  tts.provider = normalizeHermesTtsProvider(Object.hasOwn(form, 'ttsProvider') ? form.ttsProvider : currentValues.ttsProvider, true)
  const edgeVoice = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsEdgeVoice') ? form.ttsEdgeVoice : currentValues.ttsEdgeVoice, 'tts.edge.voice')
  if (edgeVoice) edge.voice = edgeVoice
  else delete edge.voice
  openai.model = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsOpenaiModel') ? form.ttsOpenaiModel : currentValues.ttsOpenaiModel, 'tts.openai.model') || 'gpt-4o-mini-tts'
  openai.voice = normalizeHermesTtsOpenaiVoice(Object.hasOwn(form, 'ttsOpenaiVoice') ? form.ttsOpenaiVoice : currentValues.ttsOpenaiVoice, true)
  const elevenlabsVoiceId = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsElevenlabsVoiceId') ? form.ttsElevenlabsVoiceId : currentValues.ttsElevenlabsVoiceId, 'tts.elevenlabs.voice_id')
  if (elevenlabsVoiceId) elevenlabs.voice_id = elevenlabsVoiceId
  else delete elevenlabs.voice_id
  const elevenlabsModelId = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsElevenlabsModelId') ? form.ttsElevenlabsModelId : currentValues.ttsElevenlabsModelId, 'tts.elevenlabs.model_id')
  if (elevenlabsModelId) elevenlabs.model_id = elevenlabsModelId
  else delete elevenlabs.model_id
  xai.voice_id = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsXaiVoiceId') ? form.ttsXaiVoiceId : currentValues.ttsXaiVoiceId, 'tts.xai.voice_id') || 'eve'
  xai.language = normalizeHermesVoiceLanguage(Object.hasOwn(form, 'ttsXaiLanguage') ? form.ttsXaiLanguage : currentValues.ttsXaiLanguage, true, 'tts.xai.language')
  xai.sample_rate = parseHermesInteger(Object.hasOwn(form, 'ttsXaiSampleRate') ? form.ttsXaiSampleRate : currentValues.ttsXaiSampleRate, 'tts.xai.sample_rate', 24000, 8000, 192000, true)
  xai.bit_rate = parseHermesInteger(Object.hasOwn(form, 'ttsXaiBitRate') ? form.ttsXaiBitRate : currentValues.ttsXaiBitRate, 'tts.xai.bit_rate', 128000, 16000, 512000, true)
  mistral.model = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsMistralModel') ? form.ttsMistralModel : currentValues.ttsMistralModel, 'tts.mistral.model') || 'voxtral-mini-tts-2603'
  const mistralVoiceId = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsMistralVoiceId') ? form.ttsMistralVoiceId : currentValues.ttsMistralVoiceId, 'tts.mistral.voice_id')
  if (mistralVoiceId) mistral.voice_id = mistralVoiceId
  else delete mistral.voice_id
  const piperVoice = normalizeHermesOptionalString(Object.hasOwn(form, 'ttsPiperVoice') ? form.ttsPiperVoice : currentValues.ttsPiperVoice, 'tts.piper.voice')
  if (piperVoice) piper.voice = piperVoice
  else delete piper.voice
  const recordKey = normalizeHermesOptionalString(Object.hasOwn(form, 'voiceRecordKey') ? form.voiceRecordKey : currentValues.voiceRecordKey, 'voice.record_key')
  if (recordKey) voice.record_key = recordKey
  else delete voice.record_key
  voice.max_recording_seconds = parseHermesInteger(Object.hasOwn(form, 'voiceMaxRecordingSeconds') ? form.voiceMaxRecordingSeconds : currentValues.voiceMaxRecordingSeconds, 'voice.max_recording_seconds', 120, 1, 3600, true)
  voice.auto_tts = formHermesBool(form, 'voiceAutoTts', currentValues.voiceAutoTts)
  voice.beep_enabled = formHermesBool(form, 'voiceBeepEnabled', currentValues.voiceBeepEnabled)
  voice.silence_threshold = parseHermesInteger(Object.hasOwn(form, 'voiceSilenceThreshold') ? form.voiceSilenceThreshold : currentValues.voiceSilenceThreshold, 'voice.silence_threshold', 200, 0, 32767, true)
  voice.silence_duration = parseHermesFloat(Object.hasOwn(form, 'voiceSilenceDuration') ? form.voiceSilenceDuration : currentValues.voiceSilenceDuration, 'voice.silence_duration', 3, 0.1, 60, true)
  tts.edge = edge
  tts.openai = openai
  tts.elevenlabs = elevenlabs
  tts.xai = xai
  tts.mistral = mistral
  tts.piper = piper
  next.tts = tts
  next.voice = voice
  return next
}

export function mergeHermesSttConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesSttConfigValues(next)
  const stt = next.stt && typeof next.stt === 'object' && !Array.isArray(next.stt)
    ? mergeConfigsPreservingFields(next.stt, {})
    : {}
  const local = stt.local && typeof stt.local === 'object' && !Array.isArray(stt.local)
    ? mergeConfigsPreservingFields(stt.local, {})
    : {}
  const openai = stt.openai && typeof stt.openai === 'object' && !Array.isArray(stt.openai)
    ? mergeConfigsPreservingFields(stt.openai, {})
    : {}
  const mistral = stt.mistral && typeof stt.mistral === 'object' && !Array.isArray(stt.mistral)
    ? mergeConfigsPreservingFields(stt.mistral, {})
    : {}
  stt.enabled = formHermesBool(form, 'sttEnabled', currentValues.sttEnabled)
  stt.provider = normalizeHermesSttProvider(Object.hasOwn(form, 'sttProvider') ? form.sttProvider : currentValues.sttProvider, true)
  local.model = normalizeHermesSttLocalModel(Object.hasOwn(form, 'sttLocalModel') ? form.sttLocalModel : currentValues.sttLocalModel, true)
  local.language = normalizeHermesSttLanguage(Object.hasOwn(form, 'sttLocalLanguage') ? form.sttLocalLanguage : currentValues.sttLocalLanguage, true)
  openai.model = normalizeHermesSttOpenaiModel(Object.hasOwn(form, 'sttOpenaiModel') ? form.sttOpenaiModel : currentValues.sttOpenaiModel, true)
  mistral.model = normalizeHermesSttMistralModel(Object.hasOwn(form, 'sttMistralModel') ? form.sttMistralModel : currentValues.sttMistralModel, true)
  stt.local = local
  stt.openai = openai
  stt.mistral = mistral
  next.stt = stt
  return next
}

export function buildHermesTerminalConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const terminal = root.terminal && typeof root.terminal === 'object' && !Array.isArray(root.terminal)
    ? root.terminal
    : {}
  return {
    terminalBackend: normalizeHermesTerminalBackend(terminal.backend, false),
    terminalCwd: typeof terminal.cwd === 'string' && terminal.cwd.trim() ? terminal.cwd : '.',
    terminalTimeout: parseHermesInteger(terminal.timeout, 'terminal.timeout', 180, 1, 86400, false),
    terminalLifetimeSeconds: parseHermesInteger(terminal.lifetime_seconds, 'terminal.lifetime_seconds', 300, 0, 86400, false),
    terminalShellInitFiles: normalizeHermesShellInitFileList(terminal.shell_init_files || [], 'terminal.shell_init_files').join('\n'),
    terminalAutoSourceBashrc: readHermesBool(terminal.auto_source_bashrc, true),
    terminalPersistentShell: readHermesBool(terminal.persistent_shell, true),
    terminalEnvPassthrough: normalizeHermesEnvNameList(terminal.env_passthrough || [], 'terminal.env_passthrough').join('\n'),
    terminalDockerMountCwdToWorkspace: readHermesBool(terminal.docker_mount_cwd_to_workspace, false),
    terminalDockerRunAsHostUser: readHermesBool(terminal.docker_run_as_host_user, false),
    terminalDockerImage: typeof terminal.docker_image === 'string' ? terminal.docker_image.trim() : '',
    terminalDockerEnvJson: JSON.stringify(normalizeHermesDockerEnvJson(terminal.docker_env || {}, 'terminal.docker_env'), null, 2),
    terminalDockerVolumes: normalizeHermesDockerVolumeList(terminal.docker_volumes || [], 'terminal.docker_volumes').join('\n'),
    terminalDockerExtraArgs: normalizeHermesDockerExtraArgsList(terminal.docker_extra_args || [], 'terminal.docker_extra_args').join('\n'),
    terminalSingularityImage: typeof terminal.singularity_image === 'string' ? terminal.singularity_image.trim() : '',
    terminalModalImage: typeof terminal.modal_image === 'string' ? terminal.modal_image.trim() : '',
    terminalModalMode: normalizeHermesTerminalModalMode(terminal.modal_mode, false),
    terminalVercelRuntime: normalizeHermesTerminalVercelRuntime(terminal.vercel_runtime, false),
    terminalDaytonaImage: typeof terminal.daytona_image === 'string' ? terminal.daytona_image.trim() : '',
    terminalDockerForwardEnv: normalizeHermesEnvNameList(terminal.docker_forward_env || [], 'terminal.docker_forward_env').join('\n'),
    terminalSshHost: typeof terminal.ssh_host === 'string' ? terminal.ssh_host.trim() : '',
    terminalSshUser: typeof terminal.ssh_user === 'string' ? terminal.ssh_user.trim() : '',
    terminalSshPort: parseHermesInteger(terminal.ssh_port, 'terminal.ssh_port', 22, 1, 65535, false),
    terminalSshKey: typeof terminal.ssh_key === 'string' ? terminal.ssh_key.trim() : '',
    terminalContainerCpu: parseHermesInteger(terminal.container_cpu, 'terminal.container_cpu', 1, 1, 64, false),
    terminalContainerMemory: parseHermesInteger(terminal.container_memory, 'terminal.container_memory', 5120, 128, 1048576, false),
    terminalContainerDisk: parseHermesInteger(terminal.container_disk, 'terminal.container_disk', 51200, 1024, 10485760, false),
    terminalContainerPersistent: readHermesBool(terminal.container_persistent, true),
  }
}

export function mergeHermesTerminalConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesTerminalConfigValues(next)
  const terminal = next.terminal && typeof next.terminal === 'object' && !Array.isArray(next.terminal)
    ? mergeConfigsPreservingFields(next.terminal, {})
    : {}
  terminal.backend = normalizeHermesTerminalBackend(Object.hasOwn(form, 'terminalBackend') ? form.terminalBackend : currentValues.terminalBackend, true)
  terminal.cwd = String(Object.hasOwn(form, 'terminalCwd') ? form.terminalCwd : currentValues.terminalCwd).trim() || '.'
  terminal.timeout = parseHermesInteger(Object.hasOwn(form, 'terminalTimeout') ? form.terminalTimeout : currentValues.terminalTimeout, 'terminal.timeout', 180, 1, 86400, true)
  terminal.lifetime_seconds = parseHermesInteger(Object.hasOwn(form, 'terminalLifetimeSeconds') ? form.terminalLifetimeSeconds : currentValues.terminalLifetimeSeconds, 'terminal.lifetime_seconds', 300, 0, 86400, true)
  const shellInitFiles = normalizeHermesShellInitFileList(Object.hasOwn(form, 'terminalShellInitFiles') ? form.terminalShellInitFiles : currentValues.terminalShellInitFiles, 'terminal.shell_init_files')
  if (shellInitFiles.length) terminal.shell_init_files = shellInitFiles
  else delete terminal.shell_init_files
  terminal.auto_source_bashrc = formHermesBool(form, 'terminalAutoSourceBashrc', currentValues.terminalAutoSourceBashrc)
  terminal.persistent_shell = formHermesBool(form, 'terminalPersistentShell', currentValues.terminalPersistentShell)
  const envPassthrough = normalizeHermesEnvNameList(Object.hasOwn(form, 'terminalEnvPassthrough') ? form.terminalEnvPassthrough : currentValues.terminalEnvPassthrough, 'terminal.env_passthrough')
  if (envPassthrough.length) terminal.env_passthrough = envPassthrough
  else delete terminal.env_passthrough
  terminal.docker_mount_cwd_to_workspace = formHermesBool(form, 'terminalDockerMountCwdToWorkspace', currentValues.terminalDockerMountCwdToWorkspace)
  terminal.docker_run_as_host_user = formHermesBool(form, 'terminalDockerRunAsHostUser', currentValues.terminalDockerRunAsHostUser)
  terminal.modal_mode = normalizeHermesTerminalModalMode(Object.hasOwn(form, 'terminalModalMode') ? form.terminalModalMode : currentValues.terminalModalMode, true)
  terminal.vercel_runtime = normalizeHermesTerminalVercelRuntime(Object.hasOwn(form, 'terminalVercelRuntime') ? form.terminalVercelRuntime : currentValues.terminalVercelRuntime, true)
  for (const [formKey, yamlKey] of [
    ['terminalDockerImage', 'docker_image'],
    ['terminalSingularityImage', 'singularity_image'],
    ['terminalModalImage', 'modal_image'],
    ['terminalDaytonaImage', 'daytona_image'],
  ]) {
    const image = normalizeHermesOptionalString(Object.hasOwn(form, formKey) ? form[formKey] : currentValues[formKey], `terminal.${yamlKey}`)
    if (image) terminal[yamlKey] = image
    else delete terminal[yamlKey]
  }
  const dockerForwardEnv = normalizeHermesEnvNameList(Object.hasOwn(form, 'terminalDockerForwardEnv') ? form.terminalDockerForwardEnv : currentValues.terminalDockerForwardEnv, 'terminal.docker_forward_env')
  if (dockerForwardEnv.length) terminal.docker_forward_env = dockerForwardEnv
  else delete terminal.docker_forward_env
  const dockerEnv = normalizeHermesDockerEnvJson(Object.hasOwn(form, 'terminalDockerEnvJson') ? form.terminalDockerEnvJson : currentValues.terminalDockerEnvJson, 'terminal.docker_env')
  if (Object.keys(dockerEnv).length) terminal.docker_env = dockerEnv
  else delete terminal.docker_env
  const dockerVolumes = normalizeHermesDockerVolumeList(Object.hasOwn(form, 'terminalDockerVolumes') ? form.terminalDockerVolumes : currentValues.terminalDockerVolumes, 'terminal.docker_volumes')
  if (dockerVolumes.length) terminal.docker_volumes = dockerVolumes
  else delete terminal.docker_volumes
  const dockerExtraArgs = normalizeHermesDockerExtraArgsList(Object.hasOwn(form, 'terminalDockerExtraArgs') ? form.terminalDockerExtraArgs : currentValues.terminalDockerExtraArgs, 'terminal.docker_extra_args')
  if (dockerExtraArgs.length) terminal.docker_extra_args = dockerExtraArgs
  else delete terminal.docker_extra_args
  for (const [formKey, yamlKey] of [
    ['terminalSshHost', 'ssh_host'],
    ['terminalSshUser', 'ssh_user'],
    ['terminalSshKey', 'ssh_key'],
  ]) {
    const value = normalizeHermesOptionalString(Object.hasOwn(form, formKey) ? form[formKey] : currentValues[formKey], `terminal.${yamlKey}`)
    if (value) terminal[yamlKey] = value
    else delete terminal[yamlKey]
  }
  terminal.ssh_port = parseHermesInteger(Object.hasOwn(form, 'terminalSshPort') ? form.terminalSshPort : currentValues.terminalSshPort, 'terminal.ssh_port', 22, 1, 65535, true)
  terminal.container_cpu = parseHermesInteger(Object.hasOwn(form, 'terminalContainerCpu') ? form.terminalContainerCpu : currentValues.terminalContainerCpu, 'terminal.container_cpu', 1, 1, 64, true)
  terminal.container_memory = parseHermesInteger(Object.hasOwn(form, 'terminalContainerMemory') ? form.terminalContainerMemory : currentValues.terminalContainerMemory, 'terminal.container_memory', 5120, 128, 1048576, true)
  terminal.container_disk = parseHermesInteger(Object.hasOwn(form, 'terminalContainerDisk') ? form.terminalContainerDisk : currentValues.terminalContainerDisk, 'terminal.container_disk', 51200, 1024, 10485760, true)
  terminal.container_persistent = formHermesBool(form, 'terminalContainerPersistent', currentValues.terminalContainerPersistent)
  next.terminal = terminal
  return next
}

export function mergeHermesExecutionLimitsConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesExecutionLimitsConfigValues(next)
  const codeExecution = next.code_execution && typeof next.code_execution === 'object' && !Array.isArray(next.code_execution)
    ? mergeConfigsPreservingFields(next.code_execution, {})
    : {}
  const delegation = next.delegation && typeof next.delegation === 'object' && !Array.isArray(next.delegation)
    ? mergeConfigsPreservingFields(next.delegation, {})
    : {}

  codeExecution.mode = normalizeHermesCodeExecutionMode(Object.hasOwn(form, 'codeExecutionMode') ? form.codeExecutionMode : currentValues.codeExecutionMode, true)
  codeExecution.timeout = parseHermesInteger(Object.hasOwn(form, 'codeExecutionTimeout') ? form.codeExecutionTimeout : currentValues.codeExecutionTimeout, 'code_execution.timeout', 300, 1, 86400, true)
  codeExecution.max_tool_calls = parseHermesInteger(Object.hasOwn(form, 'codeExecutionMaxToolCalls') ? form.codeExecutionMaxToolCalls : currentValues.codeExecutionMaxToolCalls, 'code_execution.max_tool_calls', 50, 1, 10000, true)
  delegation.max_iterations = parseHermesInteger(Object.hasOwn(form, 'delegationMaxIterations') ? form.delegationMaxIterations : currentValues.delegationMaxIterations, 'delegation.max_iterations', 50, 1, 1000, true)
  delegation.child_timeout_seconds = parseHermesInteger(Object.hasOwn(form, 'delegationChildTimeoutSeconds') ? form.delegationChildTimeoutSeconds : currentValues.delegationChildTimeoutSeconds, 'delegation.child_timeout_seconds', 600, 30, 86400, true)
  delegation.max_concurrent_children = parseHermesInteger(Object.hasOwn(form, 'delegationMaxConcurrentChildren') ? form.delegationMaxConcurrentChildren : currentValues.delegationMaxConcurrentChildren, 'delegation.max_concurrent_children', 3, 1, 100, true)
  delegation.max_spawn_depth = parseHermesInteger(Object.hasOwn(form, 'delegationMaxSpawnDepth') ? form.delegationMaxSpawnDepth : currentValues.delegationMaxSpawnDepth, 'delegation.max_spawn_depth', 1, 1, 3, true)
  delegation.orchestrator_enabled = formHermesBool(form, 'delegationOrchestratorEnabled', currentValues.delegationOrchestratorEnabled)
  delegation.subagent_auto_approve = formHermesBool(form, 'delegationSubagentAutoApprove', currentValues.delegationSubagentAutoApprove)
  delegation.inherit_mcp_toolsets = formHermesBool(form, 'delegationInheritMcpToolsets', currentValues.delegationInheritMcpToolsets)
  const delegationModel = normalizeHermesModelConfigString(Object.hasOwn(form, 'delegationModel') ? form.delegationModel : currentValues.delegationModel, 'delegation.model')
  if (delegationModel) delegation.model = delegationModel
  else delete delegation.model
  const delegationProvider = normalizeHermesModelConfigString(Object.hasOwn(form, 'delegationProvider') ? form.delegationProvider : currentValues.delegationProvider, 'delegation.provider')
  if (delegationProvider) delegation.provider = delegationProvider
  else delete delegation.provider
  next.code_execution = codeExecution
  next.delegation = delegation
  return next
}

export function buildHermesSessionRuntimeConfigValues(config = {}) {
  const root = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const sessionReset = root.session_reset && typeof root.session_reset === 'object' && !Array.isArray(root.session_reset)
    ? root.session_reset
    : {}
  const mode = HERMES_SESSION_RESET_MODES.has(String(sessionReset.mode || '').trim())
    ? String(sessionReset.mode).trim()
    : 'both'
  return {
    sessionResetMode: mode,
    idleMinutes: parseHermesInteger(sessionReset.idle_minutes, 'idle_minutes', 1440, 1, 525600, false),
    atHour: parseHermesInteger(sessionReset.at_hour, 'at_hour', 4, 0, 23, false),
    groupSessionsPerUser: readHermesBool(root.group_sessions_per_user, true),
    threadSessionsPerUser: readHermesBool(root.thread_sessions_per_user, false),
    worktreeEnabled: readHermesBool(root.worktree, false),
  }
}

export function mergeHermesSessionRuntimeConfig(config = {}, form = {}) {
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' && !Array.isArray(config) ? config : {})
  const currentValues = buildHermesSessionRuntimeConfigValues(next)
  const mode = String(Object.hasOwn(form, 'sessionResetMode') ? form.sessionResetMode : currentValues.sessionResetMode).trim()
  if (!HERMES_SESSION_RESET_MODES.has(mode)) {
    throw new Error('session_reset.mode 必须是 both、idle、daily 或 none')
  }
  const idleMinutes = parseHermesInteger(Object.hasOwn(form, 'idleMinutes') ? form.idleMinutes : currentValues.idleMinutes, 'idle_minutes', 1440, 1, 525600, true)
  const atHour = parseHermesInteger(Object.hasOwn(form, 'atHour') ? form.atHour : currentValues.atHour, 'at_hour', 4, 0, 23, true)
  const sessionReset = next.session_reset && typeof next.session_reset === 'object' && !Array.isArray(next.session_reset)
    ? mergeConfigsPreservingFields(next.session_reset, {})
    : {}
  sessionReset.mode = mode
  sessionReset.idle_minutes = idleMinutes
  sessionReset.at_hour = atHour
  next.session_reset = sessionReset
  next.group_sessions_per_user = formHermesBool(form, 'groupSessionsPerUser', currentValues.groupSessionsPerUser)
  next.thread_sessions_per_user = formHermesBool(form, 'threadSessionsPerUser', currentValues.threadSessionsPerUser)
  next.worktree = formHermesBool(form, 'worktreeEnabled', currentValues.worktreeEnabled)
  return next
}

function toCamelCaseKey(key) {
  return String(key || '').replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function putHermesString(form, source, key) {
  const value = source?.[key]
  if (typeof value === 'string') form[toCamelCaseKey(key)] = value
}

function putHermesScalarString(form, source, key) {
  const value = source?.[key]
  if (typeof value === 'string' || typeof value === 'number') form[toCamelCaseKey(key)] = String(value)
}

function putHermesBool(form, source, key) {
  const value = source?.[key]
  if (typeof value === 'boolean') form[toCamelCaseKey(key)] = value
}

function putHermesCsv(form, source, key) {
  const value = csvForForm(source?.[key])
  if (value) form[toCamelCaseKey(key)] = value
}

function hermesEnvValue(envValues, key) {
  const value = envValues && Object.hasOwn(envValues, key) ? envValues[key] : undefined
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function hermesEnvBoolValue(envValues, key) {
  const value = hermesEnvValue(envValues, key)
  if (!value) return undefined
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
}

function putHermesEnvString(form, envValues, envKey, formKey) {
  const value = hermesEnvValue(envValues, envKey)
  if (value) form[formKey] = value
}

function putHermesEnvBool(form, envValues, envKey, formKey) {
  const value = hermesEnvBoolValue(envValues, envKey)
  if (value !== undefined) form[formKey] = value
}

function putHermesHomeChannel(form, entry) {
  const home = entry?.home_channel && typeof entry.home_channel === 'object' ? entry.home_channel : null
  if (!home) return
  if (typeof home.chat_id === 'string') form.homeChannel = home.chat_id
  if (typeof home.name === 'string') form.homeChannelName = home.name
}

function readHermesEnvValues() {
  const envPath = path.join(hermesHome(), '.env')
  const values = {}
  if (!fs.existsSync(envPath)) return values
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const parsed = parseDotenvLine(line)
    if (parsed && values[parsed[0]] === undefined) values[parsed[0]] = parsed[1]
  }
  return values
}

function normalizeHermesDmPolicy(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'pairing') return 'pair'
  if (value === 'allow') return 'open'
  if (value === 'deny') return 'disabled'
  if (['pair', 'open', 'allowlist', 'disabled'].includes(value)) return value
  return 'pair'
}

function normalizeHermesGroupPolicy(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'all') return 'open'
  if (value === 'mentioned') return 'open'
  if (value === 'deny') return 'disabled'
  if (['open', 'allowlist', 'disabled'].includes(value)) return value
  return 'allowlist'
}

function normalizeHermesTelegramReplyToMode(raw, strict = false) {
  const value = String(raw || '').trim().toLowerCase() || 'first'
  if (HERMES_TELEGRAM_REPLY_TO_MODE_VALUES.has(value)) return value
  if (strict) throw new Error('platforms.telegram.extra.reply_to_mode 必须是 off、first 或 all')
  return 'first'
}

function readHermesPlatform(config, platform) {
  const platforms = config?.platforms && typeof config.platforms === 'object' ? config.platforms : {}
  const entry = platforms?.[platform] && typeof platforms[platform] === 'object' ? platforms[platform] : {}
  const extra = entry?.extra && typeof entry.extra === 'object' ? entry.extra : {}
  return { entry, extra }
}

export function buildHermesChannelConfigValues(config = {}, envValues = {}) {
  const values = {}
  for (const platform of HERMES_CHANNEL_PLATFORMS) {
    const { entry, extra } = readHermesPlatform(config, platform)
    const form = { enabled: entry.enabled === true }
    if (platform === 'telegram') {
      form.botToken = hermesEnvValue(envValues, 'TELEGRAM_BOT_TOKEN') || (typeof entry.token === 'string' ? entry.token : '')
      putHermesString(form, extra, 'reply_to_mode')
      putHermesBool(form, extra, 'guest_mode')
      putHermesBool(form, extra, 'disable_link_previews')
      form.replyToMode = normalizeHermesTelegramReplyToMode(hermesEnvValue(envValues, 'TELEGRAM_REPLY_TO_MODE') || form.replyToMode, false)
      putHermesEnvBool(form, envValues, 'TELEGRAM_GUEST_MODE', 'guestMode')
      putHermesEnvBool(form, envValues, 'TELEGRAM_DISABLE_LINK_PREVIEWS', 'disableLinkPreviews')
    } else if (platform === 'discord') {
      form.token = hermesEnvValue(envValues, 'DISCORD_BOT_TOKEN') || (typeof entry.token === 'string' ? entry.token : '')
      for (const [yamlKey, formKey] of [
        ['free_response_channels', 'freeResponseChannels'],
        ['allowed_channels', 'allowedChannels'],
        ['ignored_channels', 'ignoredChannels'],
        ['no_thread_channels', 'noThreadChannels'],
      ]) {
        putHermesCsv(form, extra, yamlKey)
        putHermesEnvString(form, envValues, `DISCORD_${yamlKey.toUpperCase()}`, formKey)
      }
      for (const [yamlKey, formKey] of [
        ['auto_thread', 'autoThread'],
        ['reactions', 'reactions'],
        ['thread_require_mention', 'threadRequireMention'],
        ['history_backfill', 'historyBackfill'],
      ]) {
        putHermesBool(form, extra, yamlKey)
        putHermesEnvBool(form, envValues, `DISCORD_${yamlKey.toUpperCase()}`, formKey)
      }
      putHermesString(form, extra, 'history_backfill_limit')
      putHermesEnvString(form, envValues, 'DISCORD_HISTORY_BACKFILL_LIMIT', 'historyBackfillLimit')
      putHermesString(form, extra, 'reply_to_mode')
      putHermesEnvString(form, envValues, 'DISCORD_REPLY_TO_MODE', 'replyToMode')
      putHermesEnvString(form, envValues, 'DISCORD_HOME_CHANNEL', 'homeChannel')
      putHermesEnvString(form, envValues, 'DISCORD_HOME_CHANNEL_NAME', 'homeChannelName')
    } else if (platform === 'slack') {
      form.botToken = hermesEnvValue(envValues, 'SLACK_BOT_TOKEN') || (typeof entry.token === 'string' ? entry.token : '')
      putHermesString(form, extra, 'app_token')
      form.appToken = hermesEnvValue(envValues, 'SLACK_APP_TOKEN') || form.appToken || ''
      putHermesString(form, extra, 'signing_secret')
      putHermesString(form, extra, 'webhook_path')
    } else if (platform === 'feishu') {
      for (const key of ['app_id', 'app_secret', 'domain', 'connection_mode', 'webhook_path', 'reaction_notifications']) {
        putHermesString(form, extra, key)
      }
      form.appId = hermesEnvValue(envValues, 'FEISHU_APP_ID') || form.appId || ''
      form.appSecret = hermesEnvValue(envValues, 'FEISHU_APP_SECRET') || form.appSecret || ''
      form.domain = hermesEnvValue(envValues, 'FEISHU_DOMAIN') || form.domain || ''
      form.connectionMode = hermesEnvValue(envValues, 'FEISHU_CONNECTION_MODE') || form.connectionMode || ''
      form.webhookPath = hermesEnvValue(envValues, 'FEISHU_WEBHOOK_PATH') || form.webhookPath || ''
      for (const key of ['typing_indicator', 'resolve_sender_names']) {
        putHermesBool(form, extra, key)
      }
    } else if (platform === 'dingtalk') {
      putHermesString(form, extra, 'client_id')
      putHermesString(form, extra, 'client_secret')
      form.clientId = hermesEnvValue(envValues, 'DINGTALK_CLIENT_ID') || form.clientId || ''
      form.clientSecret = hermesEnvValue(envValues, 'DINGTALK_CLIENT_SECRET') || form.clientSecret || ''
    } else if (platform === 'teams') {
      for (const key of ['client_id', 'client_secret', 'tenant_id', 'service_url']) putHermesString(form, extra, key)
      putHermesScalarString(form, extra, 'port')
      putHermesHomeChannel(form, entry)
      form.clientId = hermesEnvValue(envValues, 'TEAMS_CLIENT_ID') || form.clientId || ''
      form.clientSecret = hermesEnvValue(envValues, 'TEAMS_CLIENT_SECRET') || form.clientSecret || ''
      form.tenantId = hermesEnvValue(envValues, 'TEAMS_TENANT_ID') || form.tenantId || ''
      form.port = hermesEnvValue(envValues, 'TEAMS_PORT') || form.port || ''
      form.serviceUrl = hermesEnvValue(envValues, 'TEAMS_SERVICE_URL') || form.serviceUrl || ''
      putHermesEnvString(form, envValues, 'TEAMS_ALLOWED_USERS', 'allowFrom')
      putHermesEnvBool(form, envValues, 'TEAMS_ALLOW_ALL_USERS', 'allowAllUsers')
      putHermesEnvString(form, envValues, 'TEAMS_HOME_CHANNEL', 'homeChannel')
      putHermesEnvString(form, envValues, 'TEAMS_HOME_CHANNEL_NAME', 'homeChannelName')
    } else if (platform === 'google_chat') {
      for (const key of ['project_id', 'subscription_name', 'service_account_json']) putHermesString(form, extra, key)
      putHermesHomeChannel(form, entry)
      form.projectId = hermesEnvValue(envValues, 'GOOGLE_CHAT_PROJECT_ID') || hermesEnvValue(envValues, 'GOOGLE_CLOUD_PROJECT') || form.projectId || ''
      form.subscriptionName = hermesEnvValue(envValues, 'GOOGLE_CHAT_SUBSCRIPTION_NAME') || hermesEnvValue(envValues, 'GOOGLE_CHAT_SUBSCRIPTION') || form.subscriptionName || ''
      form.serviceAccountJson = hermesEnvValue(envValues, 'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON') || hermesEnvValue(envValues, 'GOOGLE_APPLICATION_CREDENTIALS') || form.serviceAccountJson || ''
      putHermesEnvString(form, envValues, 'GOOGLE_CHAT_ALLOWED_USERS', 'allowFrom')
      putHermesEnvBool(form, envValues, 'GOOGLE_CHAT_ALLOW_ALL_USERS', 'allowAllUsers')
      putHermesEnvString(form, envValues, 'GOOGLE_CHAT_HOME_CHANNEL', 'homeChannel')
      putHermesEnvString(form, envValues, 'GOOGLE_CHAT_HOME_CHANNEL_NAME', 'homeChannelName')
    } else if (platform === 'irc') {
      for (const key of ['server', 'channel', 'nickname', 'server_password', 'nickserv_password']) putHermesString(form, extra, key)
      putHermesScalarString(form, extra, 'port')
      putHermesBool(form, extra, 'use_tls')
      putHermesCsv(form, extra, 'allowed_users')
      if (form.allowedUsers && !form.allowFrom) form.allowFrom = form.allowedUsers
      delete form.allowedUsers
      putHermesHomeChannel(form, entry)
      form.server = hermesEnvValue(envValues, 'IRC_SERVER') || form.server || ''
      form.channel = hermesEnvValue(envValues, 'IRC_CHANNEL') || form.channel || ''
      form.nickname = hermesEnvValue(envValues, 'IRC_NICKNAME') || form.nickname || ''
      form.port = hermesEnvValue(envValues, 'IRC_PORT') || form.port || ''
      putHermesEnvBool(form, envValues, 'IRC_USE_TLS', 'useTls')
      form.serverPassword = hermesEnvValue(envValues, 'IRC_SERVER_PASSWORD') || form.serverPassword || ''
      form.nickservPassword = hermesEnvValue(envValues, 'IRC_NICKSERV_PASSWORD') || form.nickservPassword || ''
      putHermesEnvString(form, envValues, 'IRC_ALLOWED_USERS', 'allowFrom')
      putHermesEnvBool(form, envValues, 'IRC_ALLOW_ALL_USERS', 'allowAllUsers')
      putHermesEnvString(form, envValues, 'IRC_HOME_CHANNEL', 'homeChannel')
      putHermesEnvString(form, envValues, 'IRC_HOME_CHANNEL_NAME', 'homeChannelName')
    } else if (platform === 'line') {
      for (const key of ['channel_access_token', 'channel_secret', 'host', 'public_url', 'slow_response_threshold']) putHermesString(form, extra, key)
      putHermesScalarString(form, extra, 'port')
      putHermesCsv(form, extra, 'allowed_users')
      if (form.allowedUsers && !form.allowFrom) form.allowFrom = form.allowedUsers
      delete form.allowedUsers
      putHermesCsv(form, extra, 'allowed_groups')
      putHermesCsv(form, extra, 'allowed_rooms')
      putHermesHomeChannel(form, entry)
      form.channelAccessToken = hermesEnvValue(envValues, 'LINE_CHANNEL_ACCESS_TOKEN') || form.channelAccessToken || ''
      form.channelSecret = hermesEnvValue(envValues, 'LINE_CHANNEL_SECRET') || form.channelSecret || ''
      form.port = hermesEnvValue(envValues, 'LINE_PORT') || form.port || ''
      form.host = hermesEnvValue(envValues, 'LINE_HOST') || form.host || ''
      form.publicUrl = hermesEnvValue(envValues, 'LINE_PUBLIC_URL') || form.publicUrl || ''
      putHermesEnvString(form, envValues, 'LINE_ALLOWED_USERS', 'allowFrom')
      putHermesEnvString(form, envValues, 'LINE_ALLOWED_GROUPS', 'allowedGroups')
      putHermesEnvString(form, envValues, 'LINE_ALLOWED_ROOMS', 'allowedRooms')
      putHermesEnvBool(form, envValues, 'LINE_ALLOW_ALL_USERS', 'allowAllUsers')
      putHermesEnvString(form, envValues, 'LINE_HOME_CHANNEL', 'homeChannel')
      form.slowResponseThreshold = hermesEnvValue(envValues, 'LINE_SLOW_RESPONSE_THRESHOLD') || form.slowResponseThreshold || ''
    } else if (platform === 'simplex') {
      putHermesString(form, extra, 'ws_url')
      putHermesCsv(form, extra, 'allowed_users')
      if (form.allowedUsers && !form.allowFrom) form.allowFrom = form.allowedUsers
      delete form.allowedUsers
      putHermesHomeChannel(form, entry)
      form.wsUrl = hermesEnvValue(envValues, 'SIMPLEX_WS_URL') || form.wsUrl || ''
      putHermesEnvString(form, envValues, 'SIMPLEX_ALLOWED_USERS', 'allowFrom')
      putHermesEnvBool(form, envValues, 'SIMPLEX_ALLOW_ALL_USERS', 'allowAllUsers')
      putHermesEnvString(form, envValues, 'SIMPLEX_HOME_CHANNEL', 'homeChannel')
      putHermesEnvString(form, envValues, 'SIMPLEX_HOME_CHANNEL_NAME', 'homeChannelName')
    }
    putHermesString(form, extra, 'dm_policy')
    putHermesString(form, extra, 'group_policy')
    putHermesBool(form, extra, 'require_mention')
    if (platform === 'dingtalk') {
      putHermesCsv(form, extra, 'allowed_users')
      if (form.allowedUsers && !form.allowFrom) form.allowFrom = form.allowedUsers
      delete form.allowedUsers
      putHermesCsv(form, extra, 'allowed_chats')
      if (form.allowedChats && !form.groupAllowFrom) form.groupAllowFrom = form.allowedChats
      delete form.allowedChats
    } else {
      putHermesCsv(form, extra, 'allow_from')
      putHermesCsv(form, extra, 'group_allow_from')
    }
    putHermesChannelDisplayFields(form, config, platform)
    values[platform] = form
  }
  return values
}

function setHermesExtra(entry, key, value) {
  if (!entry.extra || typeof entry.extra !== 'object' || Array.isArray(entry.extra)) entry.extra = {}
  if (value === undefined || value === null || value === '') return
  entry.extra[key] = value
}

function setHermesExtraInteger(entry, key, value) {
  const raw = String(value ?? '').trim()
  if (!raw) return
  const parsed = Number.parseInt(raw, 10)
  if (Number.isFinite(parsed)) setHermesExtra(entry, key, parsed)
}

function setHermesHomeChannel(entry, form = {}) {
  if (!Object.hasOwn(form, 'homeChannel')) return
  const chatId = String(form.homeChannel || '').trim()
  if (!chatId) {
    deleteHermesEntryKey(entry, 'home_channel')
    return
  }
  entry.home_channel = {
    chat_id: chatId,
    name: String(form.homeChannelName || '').trim() || chatId,
  }
}

function deleteHermesEntryKey(entry, key) {
  if (entry && typeof entry === 'object') delete entry[key]
}

function deleteHermesExtraKey(entry, key) {
  if (entry?.extra && typeof entry.extra === 'object' && !Array.isArray(entry.extra)) delete entry.extra[key]
}

function normalizeHermesChannelForm(platform, form = {}) {
  const normalized = { ...(form || {}) }
  normalized.enabled = normalized.enabled === true || normalized.enabled === 'true' || normalized.enabled === 'on'
  if (Object.hasOwn(normalized, 'dmPolicy')) normalized.dmPolicy = normalizeHermesDmPolicy(normalized.dmPolicy)
  if (Object.hasOwn(normalized, 'groupPolicy')) normalized.groupPolicy = normalizeHermesGroupPolicy(normalized.groupPolicy)
  if (Object.hasOwn(normalized, 'allowFrom')) normalized.allowFrom = csvToStringArray(normalized.allowFrom)
  if (Object.hasOwn(normalized, 'groupAllowFrom')) normalized.groupAllowFrom = csvToStringArray(normalized.groupAllowFrom)
  if (Object.hasOwn(normalized, 'requireMention')) {
    normalized.requireMention = normalized.requireMention === true || normalized.requireMention === 'true' || normalized.requireMention === 'on'
  }
  if (Object.hasOwn(normalized, 'allowAllUsers')) {
    normalized.allowAllUsers = normalized.allowAllUsers === true || normalized.allowAllUsers === 'true' || normalized.allowAllUsers === 'on'
  }
  if (platform === 'feishu') {
    normalized.domain = String(normalized.domain || '').trim() || 'feishu'
    normalized.connectionMode = String(normalized.connectionMode || '').trim() || 'websocket'
    normalized.webhookPath = String(normalized.webhookPath || '').trim() || '/feishu/webhook'
    normalized.reactionNotifications = String(normalized.reactionNotifications || '').trim() || 'off'
    if (!Object.hasOwn(normalized, 'typingIndicator')) normalized.typingIndicator = true
    if (!Object.hasOwn(normalized, 'resolveSenderNames')) normalized.resolveSenderNames = true
  }
  if (platform === 'slack') {
    normalized.webhookPath = String(normalized.webhookPath || '').trim() || '/slack/events'
  }
  if (platform === 'discord') {
    for (const key of ['freeResponseChannels', 'allowedChannels', 'ignoredChannels', 'noThreadChannels']) {
      if (Object.hasOwn(normalized, key)) normalized[key] = csvToStringArray(normalized[key])
    }
    for (const key of ['autoThread', 'reactions', 'threadRequireMention', 'historyBackfill']) {
      if (Object.hasOwn(normalized, key)) normalized[key] = normalized[key] === true || normalized[key] === 'true' || normalized[key] === 'on'
    }
    normalized.historyBackfillLimit = String(normalized.historyBackfillLimit || '').trim()
    normalized.replyToMode = String(normalized.replyToMode || '').trim()
  }
  if (platform === 'telegram') {
    normalized.replyToMode = normalizeHermesTelegramReplyToMode(normalized.replyToMode, true)
    if (Object.hasOwn(normalized, 'guestMode')) normalized.guestMode = normalized.guestMode === true || normalized.guestMode === 'true' || normalized.guestMode === 'on'
    if (Object.hasOwn(normalized, 'disableLinkPreviews')) normalized.disableLinkPreviews = normalized.disableLinkPreviews === true || normalized.disableLinkPreviews === 'true' || normalized.disableLinkPreviews === 'on'
  }
  if (platform === 'irc') {
    if (Object.hasOwn(normalized, 'useTls')) normalized.useTls = normalized.useTls === true || normalized.useTls === 'true' || normalized.useTls === 'on'
  }
  if (platform === 'line') {
    for (const key of ['allowedGroups', 'allowedRooms']) {
      if (Object.hasOwn(normalized, key)) normalized[key] = csvToStringArray(normalized[key])
    }
  }
  if (Object.hasOwn(normalized, 'displayToolProgress')) {
    normalized.displayToolProgress = normalizeHermesDisplayToolProgress(
      normalized.displayToolProgress,
      true,
      `display.platforms.${platform}.tool_progress`,
    )
  }
  if (Object.hasOwn(normalized, 'displayShowReasoning')) {
    normalized.displayShowReasoning = normalized.displayShowReasoning === true || normalized.displayShowReasoning === 'true' || normalized.displayShowReasoning === 'on'
  }
  if (Object.hasOwn(normalized, 'displayToolPreviewLength')) {
    normalized.displayToolPreviewLength = parseHermesInteger(
      normalized.displayToolPreviewLength,
      `display.platforms.${platform}.tool_preview_length`,
      0,
      0,
      200000,
      true,
    )
  }
  if (Object.hasOwn(normalized, 'displayStreaming')) {
    normalized.displayStreaming = normalizeHermesDisplayStreaming(
      normalized.displayStreaming,
      true,
      `display.platforms.${platform}.streaming`,
    )
  }
  if (Object.hasOwn(normalized, 'displayCleanupProgress')) {
    normalized.displayCleanupProgress = normalized.displayCleanupProgress === true || normalized.displayCleanupProgress === 'true' || normalized.displayCleanupProgress === 'on'
  }
  return normalized
}

function mergeHermesChannelDisplayConfig(next, platform, normalized) {
  const hasDisplayFields = [
    'displayToolProgress',
    'displayShowReasoning',
    'displayToolPreviewLength',
    'displayStreaming',
    'displayCleanupProgress',
  ].some(key => Object.hasOwn(normalized, key))
  if (!hasDisplayFields) return
  const display = next.display && typeof next.display === 'object' && !Array.isArray(next.display)
    ? mergeConfigsPreservingFields(next.display, {})
    : {}
  const platforms = display.platforms && typeof display.platforms === 'object' && !Array.isArray(display.platforms)
    ? mergeConfigsPreservingFields(display.platforms, {})
    : {}
  const current = platforms[platform] && typeof platforms[platform] === 'object' && !Array.isArray(platforms[platform])
    ? platforms[platform]
    : {}
  const platformDisplay = mergeConfigsPreservingFields(current, {})
  if (Object.hasOwn(normalized, 'displayToolProgress')) platformDisplay.tool_progress = normalized.displayToolProgress
  if (Object.hasOwn(normalized, 'displayShowReasoning')) platformDisplay.show_reasoning = !!normalized.displayShowReasoning
  if (Object.hasOwn(normalized, 'displayToolPreviewLength')) platformDisplay.tool_preview_length = normalized.displayToolPreviewLength
  if (Object.hasOwn(normalized, 'displayStreaming')) {
    if (normalized.displayStreaming === 'inherit') delete platformDisplay.streaming
    else platformDisplay.streaming = normalized.displayStreaming === 'true'
  }
  if (Object.hasOwn(normalized, 'displayCleanupProgress')) platformDisplay.cleanup_progress = !!normalized.displayCleanupProgress
  platforms[platform] = platformDisplay
  display.platforms = platforms
  next.display = display
}

export function mergeHermesChannelConfig(config = {}, platform, form = {}) {
  const normalizedPlatform = normalizeHermesPlatform(platform)
  if (!normalizedPlatform) throw new Error(`不支持的 Hermes 渠道: ${platform}`)
  const next = mergeConfigsPreservingFields({}, config && typeof config === 'object' ? config : {})
  if (!next.platforms || typeof next.platforms !== 'object' || Array.isArray(next.platforms)) next.platforms = {}
  const current = next.platforms[normalizedPlatform] && typeof next.platforms[normalizedPlatform] === 'object'
    ? next.platforms[normalizedPlatform]
    : {}
  const entry = mergeConfigsPreservingFields(current, {})
  const normalized = normalizeHermesChannelForm(normalizedPlatform, form)
  entry.enabled = normalized.enabled
  if (normalizedPlatform === 'telegram') {
    deleteHermesEntryKey(entry, 'token')
    setHermesExtra(entry, 'reply_to_mode', normalized.replyToMode)
    if (Object.hasOwn(normalized, 'guestMode')) setHermesExtra(entry, 'guest_mode', !!normalized.guestMode)
    if (Object.hasOwn(normalized, 'disableLinkPreviews')) setHermesExtra(entry, 'disable_link_previews', !!normalized.disableLinkPreviews)
  } else if (normalizedPlatform === 'discord') {
    deleteHermesEntryKey(entry, 'token')
    for (const [formKey, extraKey] of [
      ['freeResponseChannels', 'free_response_channels'],
      ['allowedChannels', 'allowed_channels'],
      ['ignoredChannels', 'ignored_channels'],
      ['noThreadChannels', 'no_thread_channels'],
    ]) {
      if (Array.isArray(normalized[formKey])) setHermesExtra(entry, extraKey, normalized[formKey])
    }
    for (const [formKey, extraKey] of [
      ['autoThread', 'auto_thread'],
      ['reactions', 'reactions'],
      ['threadRequireMention', 'thread_require_mention'],
      ['historyBackfill', 'history_backfill'],
    ]) {
      if (Object.hasOwn(normalized, formKey)) setHermesExtra(entry, extraKey, !!normalized[formKey])
    }
    setHermesExtra(entry, 'history_backfill_limit', normalized.historyBackfillLimit)
    setHermesExtra(entry, 'reply_to_mode', normalized.replyToMode)
  } else if (normalizedPlatform === 'slack') {
    deleteHermesEntryKey(entry, 'token')
    deleteHermesExtraKey(entry, 'app_token')
    deleteHermesExtraKey(entry, 'signing_secret')
    setHermesExtra(entry, 'webhook_path', String(normalized.webhookPath || '').trim())
  } else if (normalizedPlatform === 'feishu') {
    deleteHermesExtraKey(entry, 'app_id')
    deleteHermesExtraKey(entry, 'app_secret')
    setHermesExtra(entry, 'domain', normalized.domain)
    setHermesExtra(entry, 'connection_mode', normalized.connectionMode)
    setHermesExtra(entry, 'webhook_path', normalized.webhookPath)
    setHermesExtra(entry, 'reaction_notifications', normalized.reactionNotifications)
    setHermesExtra(entry, 'typing_indicator', !!normalized.typingIndicator)
    setHermesExtra(entry, 'resolve_sender_names', !!normalized.resolveSenderNames)
  } else if (normalizedPlatform === 'dingtalk') {
    deleteHermesExtraKey(entry, 'client_id')
    deleteHermesExtraKey(entry, 'client_secret')
    deleteHermesExtraKey(entry, 'allow_from')
    deleteHermesExtraKey(entry, 'group_allow_from')
  } else if (normalizedPlatform === 'teams') {
    deleteHermesExtraKey(entry, 'client_id')
    deleteHermesExtraKey(entry, 'client_secret')
    deleteHermesExtraKey(entry, 'tenant_id')
    setHermesExtraInteger(entry, 'port', normalized.port)
    setHermesExtra(entry, 'service_url', String(normalized.serviceUrl || '').trim())
    setHermesHomeChannel(entry, normalized)
  } else if (normalizedPlatform === 'google_chat') {
    setHermesExtra(entry, 'project_id', String(normalized.projectId || '').trim())
    setHermesExtra(entry, 'subscription_name', String(normalized.subscriptionName || '').trim())
    deleteHermesExtraKey(entry, 'service_account_json')
    setHermesHomeChannel(entry, normalized)
  } else if (normalizedPlatform === 'irc') {
    setHermesExtra(entry, 'server', String(normalized.server || '').trim())
    setHermesExtraInteger(entry, 'port', normalized.port)
    setHermesExtra(entry, 'nickname', String(normalized.nickname || '').trim())
    setHermesExtra(entry, 'channel', String(normalized.channel || '').trim())
    if (Object.hasOwn(normalized, 'useTls')) setHermesExtra(entry, 'use_tls', !!normalized.useTls)
    deleteHermesExtraKey(entry, 'server_password')
    deleteHermesExtraKey(entry, 'nickserv_password')
    setHermesHomeChannel(entry, normalized)
  } else if (normalizedPlatform === 'line') {
    deleteHermesExtraKey(entry, 'channel_access_token')
    deleteHermesExtraKey(entry, 'channel_secret')
    setHermesExtraInteger(entry, 'port', normalized.port)
    setHermesExtra(entry, 'host', String(normalized.host || '').trim())
    setHermesExtra(entry, 'public_url', String(normalized.publicUrl || '').trim())
    if (Array.isArray(normalized.allowedGroups)) setHermesExtra(entry, 'allowed_groups', normalized.allowedGroups)
    if (Array.isArray(normalized.allowedRooms)) setHermesExtra(entry, 'allowed_rooms', normalized.allowedRooms)
    setHermesExtra(entry, 'slow_response_threshold', String(normalized.slowResponseThreshold || '').trim())
    setHermesHomeChannel(entry, normalized)
  } else if (normalizedPlatform === 'simplex') {
    setHermesExtra(entry, 'ws_url', String(normalized.wsUrl || '').trim())
    setHermesHomeChannel(entry, normalized)
  }
  if (Object.hasOwn(normalized, 'dmPolicy')) setHermesExtra(entry, 'dm_policy', normalized.dmPolicy)
  if (Object.hasOwn(normalized, 'groupPolicy')) {
    setHermesExtra(entry, 'group_policy', normalized.groupPolicy)
    if (normalizedPlatform === 'feishu') setHermesExtra(entry, 'default_group_policy', normalized.groupPolicy)
  }
  if (Object.hasOwn(normalized, 'requireMention')) setHermesExtra(entry, 'require_mention', !!normalized.requireMention)
  if (Array.isArray(normalized.allowFrom)) {
    const allowKey = ['dingtalk', 'irc', 'line', 'simplex'].includes(normalizedPlatform) ? 'allowed_users' : 'allow_from'
    setHermesExtra(entry, allowKey, normalized.allowFrom)
  }
  if (Array.isArray(normalized.groupAllowFrom)) {
    setHermesExtra(entry, normalizedPlatform === 'dingtalk' ? 'allowed_chats' : 'group_allow_from', normalized.groupAllowFrom)
  }
  next.platforms[normalizedPlatform] = entry
  mergeHermesChannelDisplayConfig(next, normalizedPlatform, normalized)
  return next
}

function readHermesConfigYamlObject() {
  const configPath = path.join(hermesHome(), 'config.yaml')
  if (!fs.existsSync(configPath)) return { configPath, exists: false, config: {} }
  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = raw.trim() ? YAML.parse(raw) : {}
  if (parsed && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('config.yaml 顶层必须是对象')
  }
  return { configPath, exists: true, config: parsed || {} }
}

function writeHermesConfigYamlObject(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let backup = ''
  if (fs.existsSync(configPath)) {
    backup = `${configPath}.bak-${Math.floor(Date.now() / 1000)}`
    fs.copyFileSync(configPath, backup)
  }
  fs.writeFileSync(configPath, YAML.stringify(config || {}, { lineWidth: 0 }), 'utf8')
  return backup
}

function writeHermesEnvValues(updates = {}) {
  const envPath = path.join(hermesHome(), '.env')
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const lines = raw.split('\n')
  const remaining = new Set(Object.keys(updates))
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line)
      continue
    }
    const eq = trimmed.indexOf('=')
    const key = eq > 0 ? trimmed.slice(0, eq).trim() : ''
    if (key && Object.hasOwn(updates, key)) {
      const value = updates[key]
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        out.push(`${key}=${value}`)
      }
      remaining.delete(key)
      continue
    }
    out.push(line)
  }
  for (const key of remaining) {
    const value = updates[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') out.push(`${key}=${value}`)
  }
  let content = out.join('\n').replace(/\n+$/, '')
  if (content) content += '\n'
  fs.writeFileSync(envPath, content, 'utf8')
}

function csvEnvValue(value) {
  return csvToStringArray(value).join(',')
}

function boolEnvValue(value) {
  return value === true || value === 'true' || value === 'on' ? 'true' : 'false'
}

export function buildHermesChannelEnvUpdates(platform, form = {}) {
  const updates = {}
  if (platform === 'telegram') {
    updates.TELEGRAM_BOT_TOKEN = String(form.botToken || '').trim()
    updates.TELEGRAM_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    updates.TELEGRAM_GROUP_ALLOWED_USERS = csvEnvValue(form.groupAllowFrom)
    if (Object.hasOwn(form, 'requireMention')) updates.TELEGRAM_REQUIRE_MENTION = boolEnvValue(form.requireMention)
    updates.TELEGRAM_REPLY_TO_MODE = normalizeHermesTelegramReplyToMode(form.replyToMode, true)
    if (Object.hasOwn(form, 'guestMode')) updates.TELEGRAM_GUEST_MODE = boolEnvValue(form.guestMode)
    if (Object.hasOwn(form, 'disableLinkPreviews')) updates.TELEGRAM_DISABLE_LINK_PREVIEWS = boolEnvValue(form.disableLinkPreviews)
  } else if (platform === 'discord') {
    updates.DISCORD_BOT_TOKEN = String(form.token || '').trim()
    updates.DISCORD_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'requireMention')) updates.DISCORD_REQUIRE_MENTION = boolEnvValue(form.requireMention)
    updates.DISCORD_FREE_RESPONSE_CHANNELS = csvEnvValue(form.freeResponseChannels)
    updates.DISCORD_ALLOWED_CHANNELS = csvEnvValue(form.allowedChannels)
    updates.DISCORD_IGNORED_CHANNELS = csvEnvValue(form.ignoredChannels)
    updates.DISCORD_NO_THREAD_CHANNELS = csvEnvValue(form.noThreadChannels)
    if (Object.hasOwn(form, 'autoThread')) updates.DISCORD_AUTO_THREAD = boolEnvValue(form.autoThread)
    if (Object.hasOwn(form, 'reactions')) updates.DISCORD_REACTIONS = boolEnvValue(form.reactions)
    if (Object.hasOwn(form, 'threadRequireMention')) updates.DISCORD_THREAD_REQUIRE_MENTION = boolEnvValue(form.threadRequireMention)
    if (Object.hasOwn(form, 'historyBackfill')) updates.DISCORD_HISTORY_BACKFILL = boolEnvValue(form.historyBackfill)
    updates.DISCORD_HISTORY_BACKFILL_LIMIT = String(form.historyBackfillLimit || '').trim()
    updates.DISCORD_REPLY_TO_MODE = String(form.replyToMode || '').trim()
    updates.DISCORD_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.DISCORD_HOME_CHANNEL_NAME = String(form.homeChannelName || '').trim()
  } else if (platform === 'slack') {
    updates.SLACK_BOT_TOKEN = String(form.botToken || '').trim()
    updates.SLACK_APP_TOKEN = String(form.appToken || '').trim()
    updates.SLACK_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'requireMention')) updates.SLACK_REQUIRE_MENTION = boolEnvValue(form.requireMention)
  } else if (platform === 'feishu') {
    updates.FEISHU_APP_ID = String(form.appId || '').trim()
    updates.FEISHU_APP_SECRET = String(form.appSecret || '').trim()
    updates.FEISHU_DOMAIN = String(form.domain || 'feishu').trim()
    updates.FEISHU_CONNECTION_MODE = String(form.connectionMode || 'websocket').trim()
    updates.FEISHU_WEBHOOK_PATH = String(form.webhookPath || '/feishu/webhook').trim()
    updates.FEISHU_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    updates.FEISHU_GROUP_POLICY = String(form.groupPolicy || 'allowlist').trim()
    updates.FEISHU_REQUIRE_MENTION = Object.hasOwn(form, 'requireMention') ? boolEnvValue(form.requireMention) : 'true'
    updates.FEISHU_REACTIONS = String(form.reactionNotifications || '').trim() === 'off' ? 'false' : 'true'
  } else if (platform === 'dingtalk') {
    updates.DINGTALK_CLIENT_ID = String(form.clientId || '').trim()
    updates.DINGTALK_CLIENT_SECRET = String(form.clientSecret || '').trim()
    updates.DINGTALK_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    updates.DINGTALK_ALLOWED_CHATS = csvEnvValue(form.groupAllowFrom)
    if (Object.hasOwn(form, 'requireMention')) updates.DINGTALK_REQUIRE_MENTION = boolEnvValue(form.requireMention)
  } else if (platform === 'teams') {
    updates.TEAMS_CLIENT_ID = String(form.clientId || '').trim()
    updates.TEAMS_CLIENT_SECRET = String(form.clientSecret || '').trim()
    updates.TEAMS_TENANT_ID = String(form.tenantId || '').trim()
    updates.TEAMS_PORT = String(form.port || '').trim()
    updates.TEAMS_SERVICE_URL = String(form.serviceUrl || '').trim()
    updates.TEAMS_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'allowAllUsers')) updates.TEAMS_ALLOW_ALL_USERS = boolEnvValue(form.allowAllUsers)
    updates.TEAMS_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.TEAMS_HOME_CHANNEL_NAME = String(form.homeChannelName || '').trim()
  } else if (platform === 'google_chat') {
    updates.GOOGLE_CHAT_PROJECT_ID = String(form.projectId || '').trim()
    updates.GOOGLE_CHAT_SUBSCRIPTION_NAME = String(form.subscriptionName || '').trim()
    updates.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = String(form.serviceAccountJson || '').trim()
    updates.GOOGLE_CHAT_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'allowAllUsers')) updates.GOOGLE_CHAT_ALLOW_ALL_USERS = boolEnvValue(form.allowAllUsers)
    updates.GOOGLE_CHAT_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.GOOGLE_CHAT_HOME_CHANNEL_NAME = String(form.homeChannelName || '').trim()
  } else if (platform === 'irc') {
    updates.IRC_SERVER = String(form.server || '').trim()
    updates.IRC_PORT = String(form.port || '').trim()
    updates.IRC_NICKNAME = String(form.nickname || '').trim()
    updates.IRC_CHANNEL = String(form.channel || '').trim()
    if (Object.hasOwn(form, 'useTls')) updates.IRC_USE_TLS = boolEnvValue(form.useTls)
    updates.IRC_SERVER_PASSWORD = String(form.serverPassword || '').trim()
    updates.IRC_NICKSERV_PASSWORD = String(form.nickservPassword || '').trim()
    updates.IRC_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'allowAllUsers')) updates.IRC_ALLOW_ALL_USERS = boolEnvValue(form.allowAllUsers)
    updates.IRC_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.IRC_HOME_CHANNEL_NAME = String(form.homeChannelName || '').trim()
  } else if (platform === 'line') {
    updates.LINE_CHANNEL_ACCESS_TOKEN = String(form.channelAccessToken || '').trim()
    updates.LINE_CHANNEL_SECRET = String(form.channelSecret || '').trim()
    updates.LINE_PORT = String(form.port || '').trim()
    updates.LINE_HOST = String(form.host || '').trim()
    updates.LINE_PUBLIC_URL = String(form.publicUrl || '').trim()
    updates.LINE_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    updates.LINE_ALLOWED_GROUPS = csvEnvValue(form.allowedGroups)
    updates.LINE_ALLOWED_ROOMS = csvEnvValue(form.allowedRooms)
    if (Object.hasOwn(form, 'allowAllUsers')) updates.LINE_ALLOW_ALL_USERS = boolEnvValue(form.allowAllUsers)
    updates.LINE_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.LINE_SLOW_RESPONSE_THRESHOLD = String(form.slowResponseThreshold || '').trim()
  } else if (platform === 'simplex') {
    updates.SIMPLEX_WS_URL = String(form.wsUrl || '').trim()
    updates.SIMPLEX_ALLOWED_USERS = csvEnvValue(form.allowFrom)
    if (Object.hasOwn(form, 'allowAllUsers')) updates.SIMPLEX_ALLOW_ALL_USERS = boolEnvValue(form.allowAllUsers)
    updates.SIMPLEX_HOME_CHANNEL = String(form.homeChannel || '').trim()
    updates.SIMPLEX_HOME_CHANNEL_NAME = String(form.homeChannelName || '').trim()
  }
  return updates
}

function channelHasQqbotCredentials(entry) {
  return !!(entry && typeof entry === 'object' && (entry.appId || entry.clientSecret || entry.appSecret || entry.token))
}

function secretAwareAccountDisplayValue(value) {
  if (typeof value === 'string') return value.trim()
  return formatSecretRefPlaceholder(value)
}

function resolvePlatformConfigEntry(channelRoot, platform, accountId) {
  if (!channelRoot || typeof channelRoot !== 'object') return null
  const accountKey = typeof accountId === 'string' ? accountId.trim() : ''
  if (platformStorageKey(platform) === 'tlon' && accountKey === QQBOT_DEFAULT_ACCOUNT_ID) return channelRoot
  if (accountKey) return channelRoot.accounts?.[accountKey] || channelRoot
  if (platformStorageKey(platform) === 'qqbot' && !channelHasQqbotCredentials(channelRoot)) {
    return channelRoot.accounts?.[QQBOT_DEFAULT_ACCOUNT_ID] || channelRoot
  }
  return channelRoot
}

export function listPlatformAccounts(channelRoot) {
  if (!channelRoot || typeof channelRoot !== 'object' || !channelRoot.accounts || typeof channelRoot.accounts !== 'object') {
    return []
  }
  return Object.entries(channelRoot.accounts)
    .map(([accountId, value]) => {
      const entry = { accountId }
      const displayId = ['appId', 'clientId', 'account', 'nick', 'ship']
        .map(key => secretAwareAccountDisplayValue(value?.[key]))
        .find(Boolean)
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

function mergeMessagingRootEntry(cfg, storageKey, entry) {
  if (!cfg.channels || typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) cfg.channels = {}
  const existing = cfg.channels[storageKey]
  cfg.channels[storageKey] = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing, ...entry }
    : entry
}

function mergeMessagingAccountEntry(cfg, storageKey, accountId, entry) {
  if (!cfg.channels || typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) cfg.channels = {}
  const existingRoot = cfg.channels[storageKey]
  const root = existingRoot && typeof existingRoot === 'object' && !Array.isArray(existingRoot)
    ? existingRoot
    : { enabled: true }
  const accountsBefore = root.accounts && typeof root.accounts === 'object' && !Array.isArray(root.accounts)
    ? Object.keys(root.accounts).filter(Boolean)
    : []
  const shouldSetDefaultAccount = !String(root.defaultAccount || '').trim()
    && !channelRootHasMessagingCredential(root)
    && accountsBefore.length === 0
  root.enabled = true
  if (!root.accounts || typeof root.accounts !== 'object' || Array.isArray(root.accounts)) root.accounts = {}
  const existingAccount = root.accounts[accountId]
  root.accounts[accountId] = existingAccount && typeof existingAccount === 'object' && !Array.isArray(existingAccount)
    ? { ...existingAccount, ...entry }
    : entry
  if (shouldSetDefaultAccount) root.defaultAccount = accountId
  cfg.channels[storageKey] = root
}

function applyMessagingPlatformEntry(cfg, storageKey, accountId, entry) {
  const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''
  if (normalizedAccountId) {
    mergeMessagingAccountEntry(cfg, storageKey, normalizedAccountId, entry)
  } else {
    mergeMessagingRootEntry(cfg, storageKey, entry)
  }
}

function ensureMessagingPluginAllowed(cfg, pluginId) {
  if (!pluginId || !pluginId.trim()) return
  const pid = pluginId.trim()
  if (!cfg.plugins || typeof cfg.plugins !== 'object' || Array.isArray(cfg.plugins)) cfg.plugins = {}
  if (!cfg.plugins.entries || typeof cfg.plugins.entries !== 'object' || Array.isArray(cfg.plugins.entries)) cfg.plugins.entries = {}
  if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = []
  if (!cfg.plugins.allow.includes(pid)) cfg.plugins.allow.push(pid)
  if (!cfg.plugins.entries[pid] || typeof cfg.plugins.entries[pid] !== 'object' || Array.isArray(cfg.plugins.entries[pid])) {
    cfg.plugins.entries[pid] = {}
  }
  cfg.plugins.entries[pid].enabled = true
}

function buildOpenClawMessagingPlatformEntry(platform, form, currentSaved = {}) {
  const entry = { enabled: true }
  const storageKey = platformStorageKey(platform)
  if (storageKey === 'telegram') {
    entry.botToken = form.botToken
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
  } else if (storageKey === 'discord') {
    entry.token = form.token
    if (form.applicationId) entry.applicationId = form.applicationId
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (form.guildId) {
      const ck = form.channelId || '*'
      entry.guilds = { [form.guildId]: { users: ['*'], requireMention: true, channels: { [ck]: { allow: true, requireMention: true } } } }
    }
  } else if (storageKey === 'feishu') {
    entry.appId = form.appId
    entry.appSecret = form.appSecret
    entry.connectionMode = 'websocket'
    entry.domain = form.domain
    entry.webhookPath = form.webhookPath
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Object.hasOwn(form, 'requireMention')) entry.requireMention = !!form.requireMention
    entry.reactionNotifications = form.reactionNotifications
    entry.typingIndicator = form.typingIndicator
    entry.resolveSenderNames = form.resolveSenderNames
  } else if (storageKey === 'zalo') {
    for (const key of ['botToken', 'tokenFile', 'webhookUrl', 'webhookSecret', 'webhookPath', 'proxy', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.mediaMaxMb === 'number') entry.mediaMaxMb = form.mediaMaxMb
  } else if (storageKey === 'whatsapp') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['defaultTo', 'contextVisibility', 'chunkMode', 'reactionLevel', 'replyToMode', 'messagePrefix', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    for (const key of ['configWrites', 'sendReadReceipts', 'selfChatMode', 'blockStreaming']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'debounceMs', 'textChunkLimit']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
    const ackReaction = { ...(currentSaved?.ackReaction && typeof currentSaved.ackReaction === 'object' ? currentSaved.ackReaction : {}) }
    if (form.ackEmoji) ackReaction.emoji = form.ackEmoji
    if (typeof form.ackDirect === 'boolean') ackReaction.direct = form.ackDirect
    if (form.ackGroup) ackReaction.group = form.ackGroup
    if (Object.keys(ackReaction).length) entry.ackReaction = ackReaction
  } else if (storageKey === 'signal') {
    for (const key of ['account', 'cliPath', 'httpUrl', 'httpHost', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    if (typeof form.httpPort === 'number') entry.httpPort = form.httpPort
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.blockStreaming === 'boolean') entry.blockStreaming = form.blockStreaming
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else if (storageKey === 'imessage') {
    for (const key of ['cliPath', 'dbPath', 'remoteHost', 'service', 'region', 'defaultTo', 'contextVisibility', 'chunkMode', 'reactionNotifications', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (Array.isArray(form.attachmentRoots) && form.attachmentRoots.length) entry.attachmentRoots = form.attachmentRoots
    if (Array.isArray(form.remoteAttachmentRoots) && form.remoteAttachmentRoots.length) entry.remoteAttachmentRoots = form.remoteAttachmentRoots
    for (const key of ['configWrites', 'includeAttachments', 'blockStreaming', 'sendReadReceipts', 'coalesceSameSenderDms']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'probeTimeoutMs', 'textChunkLimit']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else if (storageKey === 'msteams') {
    for (const key of ['appId', 'appPassword', 'tenantId', 'authType', 'certificatePath', 'certificateThumbprint', 'managedIdentityClientId', 'replyStyle', 'sharePointSiteId', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    const webhook = { ...(currentSaved?.webhook && typeof currentSaved.webhook === 'object' ? currentSaved.webhook : {}) }
    if (typeof form.webhookPort === 'number') webhook.port = form.webhookPort
    if (form.webhookPath) webhook.path = form.webhookPath
    if (Object.keys(webhook).length) entry.webhook = webhook
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    for (const key of ['useManagedIdentity', 'requireMention', 'blockStreaming', 'typingIndicator', 'welcomeCard', 'groupWelcomeCard', 'feedbackEnabled', 'feedbackReflection']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb', 'feedbackReflectionCooldownMs']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
    if (Array.isArray(form.promptStarters) && form.promptStarters.length) entry.promptStarters = form.promptStarters
    const delegatedAuth = { ...(currentSaved?.delegatedAuth && typeof currentSaved.delegatedAuth === 'object' ? currentSaved.delegatedAuth : {}) }
    if (typeof form.delegatedAuthEnabled === 'boolean') delegatedAuth.enabled = form.delegatedAuthEnabled
    if (Array.isArray(form.delegatedAuthScopes) && form.delegatedAuthScopes.length) delegatedAuth.scopes = form.delegatedAuthScopes
    if (Object.keys(delegatedAuth).length) entry.delegatedAuth = delegatedAuth
    const sso = { ...(currentSaved?.sso && typeof currentSaved.sso === 'object' ? currentSaved.sso : {}) }
    if (typeof form.ssoEnabled === 'boolean') sso.enabled = form.ssoEnabled
    if (form.ssoConnectionName) sso.connectionName = form.ssoConnectionName
    if (Object.keys(sso).length) entry.sso = sso
  } else if (storageKey === 'zalouser') {
    for (const key of ['profile', 'messagePrefix', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.historyLimit === 'number') entry.historyLimit = form.historyLimit
    if (typeof form.dangerouslyAllowNameMatching === 'boolean') entry.dangerouslyAllowNameMatching = form.dangerouslyAllowNameMatching
  } else if (storageKey === 'line') {
    for (const key of ['channelAccessToken', 'tokenFile', 'channelSecret', 'secretFile', 'webhookPath', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.mediaMaxMb === 'number') entry.mediaMaxMb = form.mediaMaxMb
  } else if (storageKey === 'mattermost') {
    for (const key of ['botToken', 'baseUrl', 'name', 'replyToMode', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Object.hasOwn(form, 'requireMention')) entry.requireMention = !!form.requireMention
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.dangerouslyAllowNameMatching === 'boolean') entry.dangerouslyAllowNameMatching = form.dangerouslyAllowNameMatching
    if (typeof form.dangerouslyAllowPrivateNetwork === 'boolean') {
      entry.network = { ...(currentSaved?.network || {}), dangerouslyAllowPrivateNetwork: form.dangerouslyAllowPrivateNetwork }
    }
    const commands = {}
    if (form.callbackPath) commands.callbackPath = form.callbackPath
    if (form.callbackUrl) commands.callbackUrl = form.callbackUrl
    if (Object.keys(commands).length) entry.commands = { ...(currentSaved?.commands || {}), ...commands }
  } else if (storageKey === 'clickclack') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['name', 'baseUrl', 'token', 'workspace', 'botUserId', 'agentId', 'replyMode', 'model', 'systemPrompt', 'defaultTo']) {
      if (form[key]) entry[key] = form[key]
    }
    if (Array.isArray(form.toolsAllow) && form.toolsAllow.length) entry.toolsAllow = form.toolsAllow
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (typeof form.senderIsOwner === 'boolean') entry.senderIsOwner = form.senderIsOwner
    for (const key of ['timeoutSeconds', 'reconnectMs']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else if (storageKey === 'nextcloud-talk') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['name', 'baseUrl', 'botSecret', 'botSecretFile', 'apiUser', 'apiPassword', 'apiPasswordFile', 'webhookHost', 'webhookPath', 'webhookPublicUrl', 'chunkMode', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Object.hasOwn(form, 'requireMention')) entry.requireMention = !!form.requireMention
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (typeof form.blockStreaming === 'boolean') entry.blockStreaming = form.blockStreaming
    if (typeof form.dangerouslyAllowPrivateNetwork === 'boolean') {
      entry.network = { ...(currentSaved?.network || {}), dangerouslyAllowPrivateNetwork: form.dangerouslyAllowPrivateNetwork }
    }
    for (const key of ['webhookPort', 'historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'textChunkLimit']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else if (storageKey === 'twitch') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['username', 'accessToken', 'clientId', 'channel', 'responsePrefix', 'clientSecret', 'refreshToken']) {
      if (form[key]) entry[key] = form[key]
    }
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.allowedRoles) && form.allowedRoles.length) entry.allowedRoles = form.allowedRoles
    if (typeof form.requireMention === 'boolean') entry.requireMention = form.requireMention
    for (const key of ['expiresIn', 'obtainmentTimestamp']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else if (storageKey === 'nostr') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['name', 'defaultAccount', 'privateKey', 'dmPolicy']) {
      if (form[key]) entry[key] = form[key]
    }
    if (Array.isArray(form.relays) && form.relays.length) entry.relays = form.relays
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    const profileMap = {
      profileName: 'name',
      profileDisplayName: 'displayName',
      profileAbout: 'about',
      profilePicture: 'picture',
      profileBanner: 'banner',
      profileWebsite: 'website',
      profileNip05: 'nip05',
      profileLud16: 'lud16',
    }
    const profile = {}
    for (const [formKey, targetKey] of Object.entries(profileMap)) {
      if (form[formKey]) profile[targetKey] = form[formKey]
    }
    if (Object.keys(profile).length) entry.profile = profile
  } else if (storageKey === 'irc') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['name', 'host', 'nick', 'username', 'realname', 'password', 'passwordFile', 'defaultTo', 'chunkMode', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    if (Array.isArray(form.channels) && form.channels.length) entry.channels = form.channels
    if (Array.isArray(form.mentionPatterns) && form.mentionPatterns.length) entry.mentionPatterns = form.mentionPatterns
    const groups = buildIrcGroupsFromForm(form)
    if (groups) entry.groups = groups
    for (const key of ['tls', 'blockStreaming', 'dangerouslyAllowNameMatching']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    for (const key of ['port', 'historyLimit', 'dmHistoryLimit', 'mediaMaxMb', 'textChunkLimit']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
    const nickserv = { ...(currentSaved?.nickserv && typeof currentSaved.nickserv === 'object' ? currentSaved.nickserv : {}) }
    if (typeof form.nickservEnabled === 'boolean') nickserv.enabled = form.nickservEnabled
    if (form.nickservService) nickserv.service = form.nickservService
    const nickservPassword = resolveMessagingCredentialFormValueForSave({ form, current: currentSaved?.nickserv || {}, formKey: 'nickservPassword', currentKey: 'password' })
    if (nickservPassword === undefined) delete nickserv.password
    else nickserv.password = nickservPassword
    const nickservPasswordFile = resolveMessagingCredentialFormValueForSave({ form, current: currentSaved?.nickserv || {}, formKey: 'nickservPasswordFile', currentKey: 'passwordFile' })
    if (nickservPasswordFile === undefined) delete nickserv.passwordFile
    else nickserv.passwordFile = nickservPasswordFile
    if (typeof form.nickservRegister === 'boolean') nickserv.register = form.nickservRegister
    if (form.nickservRegisterEmail) nickserv.registerEmail = form.nickservRegisterEmail
    if (Object.keys(nickserv).length) entry.nickserv = nickserv
  } else if (storageKey === 'tlon') {
    entry.enabled = typeof form.enabled === 'boolean' ? form.enabled : true
    for (const key of ['name', 'ship', 'url', 'responsePrefix', 'ownerShip']) {
      if (form[key]) entry[key] = form[key]
    }
    const code = resolveMessagingCredentialFormValueForSave({ form, current: currentSaved, formKey: 'code' })
    if (code === undefined) delete entry.code
    else entry.code = code
    if (Array.isArray(form.groupChannels) && form.groupChannels.length) entry.groupChannels = form.groupChannels
    if (Array.isArray(form.dmAllowlist) && form.dmAllowlist.length) entry.dmAllowlist = form.dmAllowlist
    if (Array.isArray(form.groupInviteAllowlist) && form.groupInviteAllowlist.length) entry.groupInviteAllowlist = form.groupInviteAllowlist
    if (Array.isArray(form.defaultAuthorizedShips) && form.defaultAuthorizedShips.length) entry.defaultAuthorizedShips = form.defaultAuthorizedShips
    for (const key of ['autoDiscoverChannels', 'showModelSignature', 'autoAcceptDmInvites', 'autoAcceptGroupInvites']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    if (typeof form.dangerouslyAllowPrivateNetwork === 'boolean') {
      entry.network = { ...(currentSaved?.network || {}), dangerouslyAllowPrivateNetwork: form.dangerouslyAllowPrivateNetwork }
    }
  } else if (storageKey === 'synology-chat') {
    for (const key of ['token', 'incomingUrl', 'nasHost', 'webhookPath', 'botName']) {
      if (form[key]) entry[key] = form[key]
    }
    entry.dmPolicy = form.dmPolicy || 'allowlist'
    if (Array.isArray(form.allowedUserIds) && form.allowedUserIds.length) entry.allowedUserIds = form.allowedUserIds
    if (typeof form.rateLimitPerMinute === 'number') entry.rateLimitPerMinute = form.rateLimitPerMinute
    for (const key of ['dangerouslyAllowNameMatching', 'dangerouslyAllowInheritedWebhookPath', 'allowInsecureSsl']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
  } else if (storageKey === 'googlechat') {
    for (const key of ['serviceAccount', 'serviceAccountFile', 'serviceAccountRef', 'audienceType', 'audience', 'appPrincipal', 'webhookPath', 'webhookUrl', 'botUser', 'chunkMode', 'replyToMode', 'typingIndicator', 'responsePrefix']) {
      if (form[key]) entry[key] = form[key]
    }
    const dm = { ...(currentSaved?.dm && typeof currentSaved.dm === 'object' ? currentSaved.dm : {}) }
    if (form.dmPolicy) dm.policy = form.dmPolicy
    if (Array.isArray(form.allowFrom)) dm.allowFrom = form.allowFrom
    if (Object.keys(dm).length) entry.dm = dm
    entry.groupPolicy = form.groupPolicy
    if (Array.isArray(form.groupAllowFrom) && form.groupAllowFrom.length) entry.groupAllowFrom = form.groupAllowFrom
    for (const key of ['dangerouslyAllowNameMatching', 'requireMention', 'allowBots', 'blockStreaming']) {
      if (typeof form[key] === 'boolean') entry[key] = form[key]
    }
    for (const key of ['historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'mediaMaxMb']) {
      if (typeof form[key] === 'number') entry[key] = form[key]
    }
  } else {
    Object.assign(entry, form)
  }
  preserveMessagingCredentialRefs(entry, form, currentSaved)
  return entry
}

export function mergeOpenClawMessagingPlatformConfig(cfg, { platform, form, accountId } = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('openclaw.json 顶层必须是对象')
  const storageKey = platformStorageKey(platform)
  const normalizedForm = normalizeMessagingPlatformForm(platform, form || {})
  const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''
  const currentSaved = resolvePlatformConfigEntry(cfg.channels?.[storageKey], platform, normalizedAccountId) || {}
  const entry = buildOpenClawMessagingPlatformEntry(platform, normalizedForm, currentSaved)
  const targetAccountId = storageKey === 'nostr' || (storageKey === 'tlon' && normalizedAccountId === QQBOT_DEFAULT_ACCOUNT_ID)
    ? ''
    : normalizedAccountId
  applyMessagingPlatformEntry(cfg, storageKey, targetAccountId, entry)
  if (['zalo', 'zalouser', 'line', 'mattermost', 'clickclack', 'nextcloud-talk', 'twitch', 'nostr', 'irc', 'tlon', 'synology-chat', 'googlechat', 'msteams', 'imessage', 'whatsapp'].includes(storageKey)) {
    ensureMessagingPluginAllowed(cfg, storageKey)
  }
  return { entry, accountId: normalizedAccountId, storageKey }
}

function triggerGatewayReloadNonBlocking(reason) {
  setTimeout(() => {
    try {
      Promise.resolve(handlers.reload_gateway()).catch((e) => {
        console.warn(`[dev-api] Gateway reload skipped after ${reason}: ${e.message || e}`)
      })
    } catch (e) {
      console.warn(`[dev-api] Gateway reload skipped after ${reason}: ${e.message || e}`)
    }
  }, 0)
}

// Gateway 重启的单飞行锁 + 2s 冷却（配合前端 gateway-restart-queue.js 的 3s 防抖）
// 避免 issue #243 / #240：前端穿透节流时，后端也能合并重复请求
let _gwRestartInflight = null
let _gwRestartLastFinishedAt = 0
const GW_RESTART_COOLDOWN_MS = 2000

async function guardedGatewayRestart(source = 'unknown') {
  if (process.env.DISABLE_GATEWAY_SPAWN === '1' || process.env.DISABLE_GATEWAY_SPAWN === 'true') {
    throw new Error('本地 Gateway 启动已禁用（DISABLE_GATEWAY_SPAWN=1）')
  }
  if (!isMac && !isLinux) {
    throw new Error('Windows 请使用 Tauri 桌面应用')
  }

  // 进行中的调用：复用同一个 Promise，不重复执行
  if (_gwRestartInflight) {
    return _gwRestartInflight
  }

  // 冷却期：刚重启完 2 秒内直接返回合并提示
  if (Date.now() - _gwRestartLastFinishedAt < GW_RESTART_COOLDOWN_MS) {
    return 'Gateway 刚重启过，本次请求已合并（冷却中）'
  }

  _gwRestartInflight = (async () => {
    try {
      await handlers.restart_service({ label: 'ai.openclaw.gateway' })
      return 'Gateway 已重启'
    } finally {
      _gwRestartLastFinishedAt = Date.now()
      _gwRestartInflight = null
    }
  })()

  return _gwRestartInflight
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
  if (!owner.openclawDir || path.resolve(owner.openclawDir) !== current.openclawDir) return false
  // 仅当双方都有 cliPath 且不同时才视为不匹配；任一侧缺失时放宽为兼容（向后兼容旧记录/未绑定 CLI）
  const ownerCliPath = canonicalCliPath(owner.cliPath)
  if (ownerCliPath && current.cliPath && ownerCliPath !== current.cliPath) return false
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

function shouldAutoClaimGateway(owner) {
  const current = currentGatewayOwnerSignature()
  if (!owner) return true // 无 owner 文件 → 自动认领
  // owner 文件存在但签名不完全匹配 → 仅按 port + openclaw_dir 判断
  return Number(owner.port || 0) === current.port
    && !!owner.openclawDir && path.resolve(owner.openclawDir) === current.openclawDir
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
  // 无有效 owner 或签名不匹配 → 尝试自动认领（端口 + 数据目录匹配即可）
  if (shouldAutoClaimGateway(owner)) {
    writeGatewayOwner(pid)
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

async function proxyStreamToInstance(instance, cmd, body, req, res) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  const upstream = await fetch(`${instance.endpoint}/__api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  res.statusCode = upstream.status
  const contentType = upstream.headers.get('content-type') || 'application/x-ndjson; charset=utf-8'
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  if (!upstream.body) {
    res.end(await upstream.text())
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
  } finally {
    try { reader.releaseLock() } catch {}
    if (!res.writableEnded && !res.destroyed) res.end()
  }
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
  'get_deploy_mode', 'scan_model_client_configs',
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
  base = base.replace(/\/(api\/chat|api\/generate|api\/tags|api|chat\/completions|completions|responses|messages|models)\/?$/, '')
  base = base.replace(/\/+$/, '')
  if (/:11434$/i.test(base)) return `${base}/v1`
  return base
}

function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key || '')
}

function modelApiKeyEnvRef(raw) {
  const value = String(raw || '').trim()
  if (value.startsWith('${') && value.endsWith('}')) {
    const key = value.slice(2, -1)
    if (isValidEnvKey(key)) return key
    throw new Error(`无效的环境变量引用: ${value}`)
  }
  if (value.startsWith('$')) {
    const key = value.slice(1)
    if (isValidEnvKey(key)) return key
  }
  return null
}

function parseDotenvLine(line) {
  let text = String(line || '').trim().replace(/^\uFEFF/, '')
  if (!text || text.startsWith('#')) return null
  if (text.startsWith('export ')) text = text.slice(7).trim()
  const eq = text.indexOf('=')
  if (eq < 0) return null
  const key = text.slice(0, eq).trim()
  if (!isValidEnvKey(key)) return null
  let value = text.slice(eq + 1).trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      value = value.slice(1, -1)
    }
  }
  return [key, value]
}

function modelEnvValues() {
  const values = {}
  const cfg = readOpenclawConfigOptional()
  if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
    for (const [key, value] of Object.entries(cfg.env)) {
      if (!isValidEnvKey(key)) continue
      if (typeof value === 'string') values[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value)
    }
  }
  const envPath = path.join(OPENCLAW_DIR, '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const parsed = parseDotenvLine(line)
      if (parsed && values[parsed[0]] === undefined) values[parsed[0]] = parsed[1]
    }
  }
  return values
}

function resolveModelApiKey(apiKey) {
  const key = modelApiKeyEnvRef(apiKey)
  if (!key) return apiKey || ''
  const values = modelEnvValues()
  if (values[key]) return values[key]
  if (process.env[key]) return process.env[key]
  throw new Error(`API Key 引用了环境变量 ${key}，但未在 openclaw.json env、~/.openclaw/.env 或当前进程环境中找到`)
}

function _homePath(...parts) {
  return path.join(homedir(), ...parts)
}

function _stripConfigValue(raw) {
  let out = ''
  let quote = ''
  for (const ch of String(raw || '').trim()) {
    if (ch === '"' || ch === "'") {
      quote = quote === ch ? '' : (!quote ? ch : quote)
      out += ch
      continue
    }
    if (ch === '#' && !quote) break
    out += ch
  }
  let value = out.trim().replace(/,+$/, '').trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
  }
  return value
}

function _parseSimpleConfigBlocks(raw) {
  const blocks = { '': {} }
  let current = ''
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      current = trimmed.slice(1, -1).trim()
      if (!blocks[current]) blocks[current] = {}
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    blocks[current][trimmed.slice(0, eq).trim()] = _stripConfigValue(trimmed.slice(eq + 1))
  }
  return blocks
}

function _firstEnvRef(keys) {
  for (const key of keys) {
    if (process.env[key] && String(process.env[key]).trim()) return [`\${${key}}`, 'found']
  }
  return keys.length ? [`\${${keys[0]}}`, 'missing'] : ['', 'none']
}

function _findJsonString(value, keys, depth = 0) {
  if (!value || depth > 5) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = _findJsonString(item, keys, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of keys) {
      const v = value[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    for (const item of Object.values(value)) {
      const found = _findJsonString(item, keys, depth + 1)
      if (found) return found
    }
  }
  return ''
}

function _pushClientCandidate(out, data) {
  out.push({
    id: data.id,
    source: data.source,
    sourcePath: data.sourcePath || '',
    providerKey: data.providerKey,
    displayName: data.displayName,
    baseUrl: data.baseUrl || '',
    api: data.api || 'openai-completions',
    apiKey: data.apiKey || '',
    apiKeyStatus: data.apiKeyStatus || 'none',
    models: Array.isArray(data.models) ? data.models.filter(Boolean) : [],
    importable: data.importable !== false,
    authHint: data.authHint || '',
    warning: data.warning || '',
  })
}

function _scanJsonClientFile(out, data) {
  const filePath = _homePath(...data.parts)
  if (!fs.existsSync(filePath)) return
  let model = data.defaultModel
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    model = _findJsonString(parsed, ['model', 'defaultModel', 'modelName']) || model
  } catch {}
  const [apiKey, apiKeyStatus] = _firstEnvRef(data.envKeys)
  _pushClientCandidate(out, {
    ...data,
    sourcePath: filePath,
    apiKey,
    apiKeyStatus,
    models: [model],
    importable: apiKeyStatus !== 'missing',
    warning: apiKeyStatus === 'missing' ? '未在当前进程环境中检测到对应 API Key 环境变量。请先在 OpenClaw env 或 .env 中补齐后再导入。' : '',
  })
}

function scanModelClientConfigs() {
  const candidates = []
  const codexPath = _homePath('.codex', 'config.toml')
  if (fs.existsSync(codexPath)) {
    try {
      const blocks = _parseSimpleConfigBlocks(fs.readFileSync(codexPath, 'utf8'))
      const root = blocks[''] || {}
      const providerId = root.model_provider || 'openai'
      const section = blocks[`model_providers.${providerId}`] || {}
      const model = root.model || 'gpt-5.1-codex-mini'
      const baseUrl = section.base_url || (providerId.includes('codex') ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1')
      const explicitEnvKey = isValidEnvKey(section.env_key) ? section.env_key : ''
      const envKey = explicitEnvKey || (providerId === 'openai' ? 'OPENAI_API_KEY' : '')
      const isExternalCodex = providerId.includes('codex') || baseUrl.includes('chatgpt.com/backend-api/codex')
      const api = isExternalCodex ? 'openai-codex-responses' : (String(section.wire_api || '').includes('responses') ? 'openai-responses' : 'openai-completions')
      const apiKeyStatus = envKey ? (process.env[envKey] && String(process.env[envKey]).trim() ? 'found' : 'missing') : 'none'
      const warning = isExternalCodex
        ? 'ChatGPT/Codex OAuth 令牌不会导入到 OpenClaw。请优先使用 Hermes 的 openai-codex 登录。'
        : (apiKeyStatus === 'none'
          ? 'Codex 配置没有声明可安全引用的 env_key，无法自动导入 API Key。请在 Codex 配置中添加 env_key，或在 OpenClaw 中手动配置服务商密钥。'
          : (apiKeyStatus === 'missing' ? '未在当前进程环境中检测到 Codex 配置引用的 API Key 环境变量。请先在 OpenClaw env 或 .env 中补齐后再导入。' : ''))
      _pushClientCandidate(candidates, {
        id: 'codex-cli',
        source: 'Codex CLI',
        sourcePath: codexPath,
        providerKey: providerId === 'openai' ? 'codex-openai' : `codex-${providerId}`,
        displayName: `Codex CLI / ${providerId}`,
        baseUrl,
        api,
        apiKey: envKey ? `\${${envKey}}` : '',
        apiKeyStatus,
        models: [model],
        importable: !isExternalCodex && apiKeyStatus !== 'none' && apiKeyStatus !== 'missing',
        authHint: isExternalCodex ? 'hermes auth login openai-codex' : '',
        warning,
      })
    } catch {}
  }
  _scanJsonClientFile(candidates, {
    id: 'claude-code',
    source: 'Claude Code',
    parts: ['.claude', 'settings.json'],
    providerKey: 'anthropic',
    displayName: 'Anthropic / Claude Code',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
    defaultModel: 'claude-sonnet-4-5-20250514',
  })
  _scanJsonClientFile(candidates, {
    id: 'gemini-cli',
    source: 'Gemini CLI',
    parts: ['.gemini', 'settings.json'],
    providerKey: 'google',
    displayName: 'Google Gemini CLI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-pro',
  })
  for (const item of [
    ['OPENAI_API_KEY', 'openai-env', 'OpenAI 环境变量', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', 'openai-completions', process.env.OPENAI_MODEL || 'gpt-4o'],
    ['ANTHROPIC_API_KEY', 'anthropic-env', 'Anthropic 环境变量', 'https://api.anthropic.com/v1', 'anthropic-messages', process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250514'],
    ['GEMINI_API_KEY', 'gemini-env', 'Gemini 环境变量', 'https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai', process.env.GEMINI_MODEL || 'gemini-2.5-pro'],
  ]) {
    const [envKey, providerKey, displayName, baseUrl, api, model] = item
    if (!process.env[envKey] || !String(process.env[envKey]).trim()) continue
    _pushClientCandidate(candidates, {
      id: providerKey,
      source: 'Environment',
      sourcePath: envKey,
      providerKey,
      displayName,
      baseUrl,
      api,
      apiKey: `\${${envKey}}`,
      apiKeyStatus: 'found',
      models: [model],
    })
  }
  return { candidates }
}

// 从 SSE 流文本中累积 OpenAI 风格的 delta.content / delta.reasoning_content
// 同时兼容 Anthropic streaming (content_block_delta)
// 格式示例：
//   data: {"choices":[{"delta":{"content":"你好"}}]}
//   data: {"choices":[{"delta":{"content":"，"}}]}
//   data: [DONE]
function _extractSseReply(text) {
  if (!text) return ''
  let content = ''
  let reasoning = ''
  let sawDataLine = false
  for (const line of text.split('\n')) {
    let data
    if (line.startsWith('data: ')) data = line.slice(6)
    else if (line.startsWith('data:')) data = line.slice(5)
    else continue
    sawDataLine = true
    data = data.trim()
    if (!data || data === '[DONE]') continue
    try {
      const v = JSON.parse(data)
      // OpenAI / 兼容后端：choices[0].delta.content
      const delta = v?.choices?.[0]?.delta
      if (delta) {
        if (typeof delta.content === 'string') content += delta.content
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      }
      // Anthropic streaming: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
      if (v?.type === 'content_block_delta' && typeof v?.delta?.text === 'string') {
        content += v.delta.text
      }
    } catch {}
  }
  if (!sawDataLine) return ''
  if (content) return content
  if (reasoning) return `[reasoning] ${reasoning}`
  return ''
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
      let ownedByCurrentInstance = !!running && isCurrentGatewayOwner(owner, pid || null)
      if (ownedByCurrentInstance && gatewayOwnerPidNeedsRefresh(owner, pid || null)) {
        writeGatewayOwner(pid || null)
      }
      // 自动认领：Gateway 在运行但无有效 owner，且端口 + 数据目录匹配
      if (running && !ownedByCurrentInstance && shouldAutoClaimGateway(owner)) {
        writeGatewayOwner(pid || null)
        ownedByCurrentInstance = true
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
    ensureNodeRuntimeCompatibleWeb()
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

  async claim_gateway() {
    const label = 'ai.openclaw.gateway'
    const status = await getLocalGatewayRuntime(label)
    if (!status?.running) throw new Error('Gateway 未运行，无需认领')
    writeGatewayOwner(status.pid || null)
    serverCacheInvalidate('svc_status')
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
    return guardedGatewayRestart('reload_gateway')
  },

  async restart_gateway() {
    return guardedGatewayRestart('restart_gateway')
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
    } else {
      Object.assign(form, buildMessagingPlatformFormValues(platform, saved, { channelRoot }))
    }
    return { exists: true, values: form }
  },

  save_messaging_platform({ platform, form, accountId }) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('openclaw.json 不存在')
    const cfg = readOpenclawConfigRequired()
    form = normalizeMessagingPlatformForm(platform, form || {})
    if (!cfg.channels) cfg.channels = {}
    const storageKey = platformStorageKey(platform)
    const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''
    const currentSaved = resolvePlatformConfigEntry(cfg.channels?.[storageKey], platform, normalizedAccountId) || {}
    const setRootChannelEntry = (entry) => {
      mergeMessagingRootEntry(cfg, storageKey, entry)
    }
    const setAccountChannelEntry = (entry) => {
      mergeMessagingAccountEntry(cfg, storageKey, normalizedAccountId, entry)
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
      entry.dmPolicy = form.dmPolicy
      entry.groupPolicy = form.groupPolicy
      if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
    } else if (platform === 'discord') {
      entry.token = form.token
      if (form.applicationId) entry.applicationId = form.applicationId
      entry.dmPolicy = form.dmPolicy
      entry.groupPolicy = form.groupPolicy
      if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
      if (form.guildId) {
        const ck = form.channelId || '*'
        entry.guilds = { [form.guildId]: { users: ['*'], requireMention: true, channels: { [ck]: { allow: true, requireMention: true } } } }
      }
    } else if (platform === 'feishu') {
      entry.appId = form.appId
      entry.appSecret = form.appSecret
      entry.connectionMode = 'websocket'
      entry.domain = form.domain
      entry.webhookPath = form.webhookPath
      entry.dmPolicy = form.dmPolicy
      entry.groupPolicy = form.groupPolicy
      if (Array.isArray(form.allowFrom) && form.allowFrom.length) entry.allowFrom = form.allowFrom
      if (Object.hasOwn(form, 'requireMention')) entry.requireMention = !!form.requireMention
      entry.reactionNotifications = form.reactionNotifications
      entry.typingIndicator = form.typingIndicator
      entry.resolveSenderNames = form.resolveSenderNames
      preserveMessagingCredentialRefs(entry, form, currentSaved)
      if (normalizedAccountId) {
        setAccountChannelEntry(entry)
      } else {
        setRootChannelEntry(entry)
      }
    } else if (platform === 'dingtalk' || platform === 'dingtalk-connector') {
      Object.assign(entry, form)
      preserveMessagingCredentialRefs(entry, form, currentSaved)
      if (normalizedAccountId) {
        setAccountChannelEntry(entry)
      } else {
        setRootChannelEntry(entry)
      }
    } else if (['line', 'mattermost', 'clickclack', 'nextcloud-talk', 'twitch', 'nostr', 'irc', 'tlon', 'synology-chat', 'googlechat', 'msteams', 'whatsapp'].includes(storageKey)) {
      const built = buildOpenClawMessagingPlatformEntry(platform, form, currentSaved)
      const targetAccountId = storageKey === 'nostr' || (storageKey === 'tlon' && normalizedAccountId === QQBOT_DEFAULT_ACCOUNT_ID)
        ? ''
        : normalizedAccountId
      applyMessagingPlatformEntry(cfg, storageKey, targetAccountId, built)
      ensureMessagingPluginAllowed(cfg, storageKey)
    } else {
      Object.assign(entry, form)
      preserveMessagingCredentialRefs(entry, form, currentSaved)
    }

    if (platform !== 'qqbot' && platform !== 'feishu' && platform !== 'dingtalk' && platform !== 'dingtalk-connector' && !['line', 'mattermost', 'clickclack', 'nextcloud-talk', 'twitch', 'nostr', 'irc', 'tlon', 'synology-chat', 'googlechat', 'msteams', 'whatsapp'].includes(storageKey)) {
      preserveMessagingCredentialRefs(entry, form, currentSaved)
      // 合并模式：保留用户通过 CLI 或手动编辑的自定义字段
      applyMessagingPlatformEntry(cfg, storageKey, normalizedAccountId, entry)
      // Discord: 仅在首次创建时设置默认值，不覆盖用户已有的设置
      if (platform === 'discord') {
        const d = cfg.channels[storageKey]
        if (!d.groupPolicy) d.groupPolicy = 'allowlist'
        if (!d.dm) d.dm = { enabled: false }
        if (!d.retry) d.retry = { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.1 }
      }
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
    if (platform === 'zalo') {
      if (form.botToken) {
        try {
          const resp = await fetch(`https://bot-api.zaloplatforms.com/bot${form.botToken}/getMe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
          })
          const body = await resp.json()
          if (body.ok) return { valid: true, errors: [], details: ['Zalo Bot Token 已通过 getMe 校验'] }
          return { valid: false, errors: [body.description || body.message || 'Zalo Bot Token 无效'] }
        } catch (e) {
          return { valid: false, errors: [`Zalo API 连接失败: ${e.message}`] }
        }
      }
      if (form.tokenFile) return { valid: true, warnings: ['已配置 Token File；Web 模式不会读取外部文件做在线校验'] }
      return { valid: false, errors: ['请填写 Bot Token 或 Token File'] }
    }
    if (platform === 'zalouser') {
      return { valid: true, warnings: ['Zalo Personal 通过二维码登录维护本地会话；请使用 openclaw channels status --probe 检查登录状态'] }
    }
    if (platform === 'whatsapp') {
      return { valid: true, warnings: ['WhatsApp 使用扫码登录维护本地会话，无需在线校验 Bot Token；请通过「启动扫码登录」完成配对。'] }
    }
    if (platform === 'clickclack') {
      return { valid: true, warnings: ['ClickClack 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
    }
    if (platform === 'nextcloud-talk') {
      return { valid: true, warnings: ['Nextcloud Talk 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
    }
    if (platform === 'twitch') {
      return { valid: true, warnings: ['Twitch 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
    }
    if (platform === 'nostr') {
      return { valid: true, warnings: ['Nostr 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
    }
    if (platform === 'irc') {
      return { valid: true, warnings: ['IRC 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
    }
    if (platform === 'tlon') {
      return { valid: true, warnings: ['Tlon 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'] }
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
    if (platform === 'msteams') {
      const missing = msteamsCredentialMissingLabels(form)
      if (missing.length) return { valid: false, errors: [`缺少 ${missing.join(' / ')}`] }
      if (!hasConfiguredMessagingValue(form.appPassword)) {
        return {
          valid: true,
          warnings: ['当前 Teams 认证模式不使用 Client Secret；面板已完成结构校验，实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。'],
          details: [`App ID: ${String(form.appId || '').trim()}`],
        }
      }
      const tenantId = String(form.tenantId || 'botframework.com').trim() || 'botframework.com'
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: String(form.appId || '').trim(),
          client_secret: String(form.appPassword || '').trim(),
          scope: 'https://api.botframework.com/.default',
        })
        const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(15000),
        })
        const result = await resp.json()
        if (result.access_token) {
          return { valid: true, errors: [], details: [`App ID: ${form.appId}`, `Tenant: ${tenantId}`, `Token 有效期: ${result.expires_in || 0}s`] }
        }
        return { valid: false, errors: [result.error_description || result.error || '凭证无效，请检查 App ID 和 App Password'] }
      } catch (e) {
        return { valid: false, errors: [`Azure AD 连接失败: ${e.message}`] }
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

  list_all_plugins() {
    const cfg = readOpenclawConfigOptional()
    const entries = cfg.plugins?.entries || {}
    const allowArr = cfg.plugins?.allow || []
    const extDir = path.join(OPENCLAW_DIR, 'extensions')
    const plugins = []
    const seen = new Set()

    // Scan extensions directory
    if (fs.existsSync(extDir)) {
      for (const name of fs.readdirSync(extDir)) {
        if (name.startsWith('.')) continue
        const p = path.join(extDir, name)
        if (!fs.statSync(p).isDirectory()) continue
        const hasMarker = fs.existsSync(path.join(p, 'package.json')) || fs.existsSync(path.join(p, 'plugin.ts')) || fs.existsSync(path.join(p, 'index.js'))
        if (!hasMarker) continue
        seen.add(name)
        const entryCfg = entries[name]
        const enabled = !!entryCfg?.enabled
        const allowed = allowArr.includes(name)
        let version = null, description = null
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))
          version = pkg.version || null
          description = pkg.description || null
        } catch {}
        plugins.push({ id: name, installed: true, builtin: false, enabled, allowed, version, description, config: entryCfg?.config || null })
      }
    }

    // Include entries from config not found in extensions dir
    for (const [pid, val] of Object.entries(entries)) {
      if (seen.has(pid)) continue
      seen.add(pid)
      plugins.push({ id: pid, installed: false, builtin: false, enabled: !!val?.enabled, allowed: allowArr.includes(pid), version: null, description: null, config: val?.config || null })
    }

    plugins.sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) || a.id.localeCompare(b.id))
    return { plugins }
  },

  toggle_plugin({ pluginId, enabled }) {
    if (!pluginId || !pluginId.trim()) throw new Error('pluginId 不能为空')
    const pid = pluginId.trim()
    const cfg = readOpenclawConfigOptional()
    if (!cfg.plugins) cfg.plugins = {}
    if (!cfg.plugins.entries) cfg.plugins.entries = {}
    if (!cfg.plugins.allow) cfg.plugins.allow = []

    if (enabled) {
      if (!cfg.plugins.allow.includes(pid)) cfg.plugins.allow.push(pid)
      if (!cfg.plugins.entries[pid]) cfg.plugins.entries[pid] = {}
      cfg.plugins.entries[pid].enabled = true
    } else {
      cfg.plugins.allow = cfg.plugins.allow.filter(v => v !== pid)
      if (cfg.plugins.entries[pid]) cfg.plugins.entries[pid].enabled = false
    }

    writeOpenclawConfigFile(cfg)
    return { ok: true, enabled, pluginId: pid }
  },

  install_plugin({ packageName }) {
    if (!packageName || !packageName.trim()) throw new Error('包名不能为空')
    const spec = packageName.trim()
    try {
      execOpenclawSync(['plugins', 'install', spec], { timeout: 120000, cwd: homedir(), windowsHide: true }, `插件 ${spec} 安装失败`)
      return { ok: true, output: '安装成功' }
    } catch (e) {
      throw new Error(`插件安装失败: ${e.message || e}`)
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
    const cfg = readOpenclawConfigOptional()
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

  scan_git_paths() {
    const candidates = [
      ['/usr/bin/git', 'SYSTEM'],
      ['/usr/local/bin/git', 'SYSTEM'],
      ['/opt/homebrew/bin/git', 'BREW'],
      ['/Library/Developer/CommandLineTools/usr/bin/git', 'XCODE_CLT'],
      ['/snap/bin/git', 'SNAP'],
    ]
    const found = []
    const seen = new Set()
    for (const [p, source] of candidates) {
      if (!fs.existsSync(p) || seen.has(p)) continue
      seen.add(p)
      try {
        const ver = cp.execSync(`"${p}" --version`, { timeout: 5000 }).toString().trim()
        found.push({ path: p, version: ver, source })
      } catch {}
    }
    return found
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

  async probe_gateway_port() {
    const port = readGatewayPort()
    return new Promise(resolve => {
      const net = require('net')
      const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 3000 })
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => resolve(false))
      sock.on('timeout', () => { sock.destroy(); resolve(false) })
    })
  },

  // @homebridge/ciao windowsHide bug — Windows only. Linux/macOS stubs return false.
  // See https://github.com/homebridge/ciao/issues/64 and PR #65.
  check_ciao_windowshide_bug() {
    const platform = process.platform
    if (platform !== 'win32') {
      return {
        affected: false,
        platform,
        version: null,
        networkManagerPath: null,
        detail: 'Non-Windows platform — bug does not manifest here.',
      }
    }
    // Web 模式极少跑在 Windows 上，这里提供最小桩实现保持接口一致
    return {
      affected: false,
      platform,
      version: null,
      networkManagerPath: null,
      detail: 'Ciao bug detection is only performed in the Tauri desktop build.',
    }
  },

  async diagnose_gateway_connection() {
    const steps = []
    const ocDir = openclawDir()
    const configPath = path.join(ocDir, 'openclaw.json')
    const port = readGatewayPort()

    // 1. 配置文件
    const t1 = Date.now()
    try {
      const content = fs.readFileSync(configPath, 'utf-8')
      const val = JSON.parse(content)
      steps.push({ name: 'config', ok: !!val.gateway, message: val.gateway ? '配置文件有效，含 gateway 配置' : '配置文件缺少 gateway 段', durationMs: Date.now() - t1 })
    } catch (e) {
      steps.push({ name: 'config', ok: false, message: `配置文件异常: ${e.message}`, durationMs: Date.now() - t1 })
    }

    // 2. 设备密钥
    const t2 = Date.now()
    const keyPath = path.join(ocDir, 'clawpanel-device-key.json')
    const keyExists = fs.existsSync(keyPath)
    steps.push({ name: 'device_key', ok: keyExists, message: keyExists ? '设备密钥存在' : '设备密钥不存在', durationMs: Date.now() - t2 })

    // 3. allowedOrigins
    const t3 = Date.now()
    try {
      const val = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const origins = val?.gateway?.controlUi?.allowedOrigins
      if (Array.isArray(origins) && origins.length > 0) {
        steps.push({ name: 'allowed_origins', ok: true, message: `allowedOrigins: ${JSON.stringify(origins)}`, durationMs: Date.now() - t3 })
      } else {
        steps.push({ name: 'allowed_origins', ok: false, message: '未配置 allowedOrigins', durationMs: Date.now() - t3 })
      }
    } catch {
      steps.push({ name: 'allowed_origins', ok: false, message: '配置文件不可读', durationMs: Date.now() - t3 })
    }

    // 4. TCP 端口
    const t4 = Date.now()
    const tcpOk = await new Promise(resolve => {
      const net = require('net')
      const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 3000 })
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => resolve(false))
      sock.on('timeout', () => { sock.destroy(); resolve(false) })
    })
    steps.push({ name: 'tcp_port', ok: tcpOk, message: tcpOk ? `端口 ${port} 可达` : `端口 ${port} 不可达`, durationMs: Date.now() - t4 })

    // 5. HTTP /health
    const t5 = Date.now()
    let httpOk = false
    let httpMsg = ''
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })
      httpOk = resp.ok
      httpMsg = `HTTP /health 返回 ${resp.status}`
    } catch (e) {
      httpMsg = `HTTP /health 请求失败: ${e.message}`
    }
    steps.push({ name: 'http_health', ok: httpOk, message: httpMsg, durationMs: Date.now() - t5 })

    // 6. 错误日志
    const t6 = Date.now()
    const errLogPath = path.join(ocDir, 'logs', 'gateway.err.log')
    if (fs.existsSync(errLogPath)) {
      const stat = fs.statSync(errLogPath)
      if (stat.size === 0) {
        steps.push({ name: 'err_log', ok: true, message: '错误日志为空（正常）', durationMs: Date.now() - t6 })
      } else {
        const buf = Buffer.alloc(Math.min(1024, stat.size))
        const fd = fs.openSync(errLogPath, 'r')
        fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length))
        fs.closeSync(fd)
        const tail = buf.toString('utf-8').toLowerCase()
        const hasFatal = tail.includes('fatal') || tail.includes('eaddrinuse') || tail.includes('config invalid')
        steps.push({ name: 'err_log', ok: !hasFatal, message: hasFatal ? `错误日志含关键错误 (${stat.size} bytes)` : `错误日志存在但无致命错误 (${stat.size} bytes)`, durationMs: Date.now() - t6 })
      }
    } else {
      steps.push({ name: 'err_log', ok: true, message: '无错误日志（正常）', durationMs: Date.now() - t6 })
    }

    // env
    let authMode = 'none'
    try {
      const val = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const auth = val?.gateway?.auth
      if (auth?.token) authMode = 'token'
      else if (auth?.password) authMode = 'password'
    } catch {}
    let errLogExcerpt = ''
    try {
      const buf = fs.readFileSync(errLogPath)
      errLogExcerpt = buf.slice(Math.max(0, buf.length - 2048)).toString('utf-8')
    } catch {}

    const overallOk = steps.every(s => s.ok)
    const failed = steps.filter(s => !s.ok).map(s => s.name)
    return {
      steps,
      env: {
        openclawDir: ocDir,
        configExists: fs.existsSync(configPath),
        port,
        authMode,
        deviceKeyExists: keyExists,
        gatewayOwner: null,
        errLogExcerpt,
      },
      overallOk,
      summary: overallOk ? '所有检查项通过' : `以下检查未通过: ${failed.join(', ')}`,
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
      const cliPath = resolveOpenclawCliPath()
      if (cliPath && classifyCliSource(cliPath) === 'standalone') {
        const bundled = standaloneBundledNodePath(cliPath)
        if (bundled) {
          const result = spawnSync(bundled, ['--version'], { windowsHide: true, encoding: 'utf8' })
          if (result.status === 0) {
            return decorateNodeDetection({
              installed: true,
              version: String(result.stdout || '').trim(),
              path: bundled,
              detectedFrom: 'standalone-bundled',
            })
          }
        }
      }
      const ver = execSync('node --version 2>&1', { windowsHide: true }).toString().trim()
      return decorateNodeDetection({ installed: true, version: ver, path: findCommandPath('node') })
    } catch {
      return decorateNodeDetection({ installed: false, version: null, path: null })
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
        return { ok: false, error: e.message || String(e) }
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
      const cliInstallSource = cli_source === 'standalone'
        ? (detectStandaloneSourceFromCliPath(cli_path) || 'chinese')
        : normalizeCliInstallSource(cli_source)
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
    apiKey = resolveModelApiKey(apiKey)
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

  // 模型测试（详细版 #Compat-1）：返回 {success, status, reqUrl, reqBody, respBody, reply, error, elapsedMs, usedApi}
  async test_model_verbose({ baseUrl, apiKey, modelId, apiType = 'openai-completions' }) {
    const type = ['anthropic', 'anthropic-messages'].includes(apiType) ? 'anthropic-messages'
      : apiType === 'google-gemini' ? 'google-gemini'
      : 'openai-completions'
    apiKey = resolveModelApiKey(apiKey)
    let base = _normalizeBaseUrl(baseUrl)
    if (type === 'anthropic-messages' && !/\/v1$/i.test(base)) base += '/v1'
    const t0 = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)

    // Accept-Encoding: identity 禁止响应压缩，规避 Node fetch 对某些压缩格式的解码异常
    // （和 Rust test_model_verbose 保持行为一致）
    let usedApi, reqUrl, reqBody, headers, realUrl
    if (type === 'anthropic-messages') {
      usedApi = 'Anthropic Messages'
      reqUrl = `${base}/messages`
      realUrl = reqUrl
      reqBody = { model: modelId, messages: [{ role: 'user', content: '你好，请用一句话回复' }], max_tokens: 200 }
      headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'Accept-Encoding': 'identity' }
      if (apiKey) headers['x-api-key'] = apiKey
    } else if (type === 'google-gemini') {
      usedApi = 'Gemini'
      reqUrl = `${base}/models/${encodeURIComponent(modelId)}:generateContent?key=***`
      realUrl = `${base}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey || '')}`
      reqBody = { contents: [{ role: 'user', parts: [{ text: '你好，请用一句话回复' }] }] }
      headers = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
    } else {
      // OpenAI 兼容路径用 stream:true：部分兼容网关的 non-streaming 分支对某些模型
      // 会返回 200 + 空 body，而 streaming 分支所有 provider 都稳定支持，与真实对话一致
      usedApi = 'Chat Completions (SSE)'
      reqUrl = `${base}/chat/completions`
      realUrl = reqUrl
      reqBody = { model: modelId, messages: [{ role: 'user', content: '你好，请用一句话回复' }], max_tokens: 200, stream: true }
      headers = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'Accept': 'text/event-stream' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    }

    let resp
    try {
      resp = await fetch(realUrl, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: controller.signal })
    } catch (e) {
      clearTimeout(timer)
      const elapsedMs = Date.now() - t0
      const error = e.name === 'AbortError' ? '请求超时 (30s)' : (e.message || String(e))
      return { success: false, status: 0, reqUrl, reqBody, respHeaders: null, respBody: '', respRawHex: '', respByteCount: 0, reply: '', error, elapsedMs, usedApi }
    }
    clearTimeout(timer)
    const elapsedMs = Date.now() - t0
    const status = resp.status
    // 抓取响应头
    const respHeaders = {}
    for (const [k, v] of resp.headers.entries()) respHeaders[k] = v
    // 先拿字节，再自己 UTF-8 decode，失败时给 hex dump
    let respBody = ''
    let respRawHex = ''
    let respByteCount = 0
    let decodeErr = null
    try {
      const buf = new Uint8Array(await resp.arrayBuffer())
      respByteCount = buf.length
      respRawHex = Array.from(buf.slice(0, 200)).map(b => b.toString(16).padStart(2, '0')).join(' ')
      try {
        respBody = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch (e) {
        // UTF-8 严格解码失败，给 lossy 版本
        respBody = new TextDecoder('utf-8').decode(buf)
        decodeErr = `响应体 UTF-8 解码失败: ${e.message} | 字节数=${respByteCount}`
      }
    } catch (e) {
      decodeErr = `读取响应字节失败: ${e.message}`
    }

    // 先尝试 SSE 累积（OpenAI stream:true / Anthropic streaming），再回退到单 JSON
    let reply = _extractSseReply(respBody)
    if (!reply) {
      try {
        const v = JSON.parse(respBody)
        if (Array.isArray(v.content)) {
          reply = v.content.filter(b => b.type === 'text').map(b => b.text).join('')
        }
        if (!reply && v.candidates?.[0]?.content?.parts) {
          reply = v.candidates[0].content.parts.map(p => p.text).filter(Boolean).join('')
        }
        if (!reply && v.choices?.[0]?.message) {
          const msg = v.choices[0].message
          reply = msg.content || (msg.reasoning_content ? `[reasoning] ${msg.reasoning_content}` : '')
        }
        if (!reply && v.output?.text) reply = v.output.text
      } catch {}
    }

    const success = resp.ok && !!reply && !decodeErr
    let error = null
    if (decodeErr) {
      error = decodeErr
    } else if (!resp.ok) {
      try {
        const v = JSON.parse(respBody)
        error = v.error?.message || v.message || `HTTP ${status}`
      } catch { error = `HTTP ${status}` }
    } else if (!reply) {
      error = 'API 已响应但未解析出内容'
    }
    return { success, status, reqUrl, reqBody, respHeaders, respBody, respRawHex, respByteCount, reply, error, elapsedMs, usedApi }
  },

  async list_remote_models({ baseUrl, apiKey, apiType = 'openai-completions' }) {
    const type = ['anthropic', 'anthropic-messages'].includes(apiType) ? 'anthropic-messages'
      : apiType === 'google-gemini' ? 'google-gemini'
      : 'openai-completions'
    apiKey = resolveModelApiKey(apiKey)
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
        // 404/405/501 = 服务商不支持 /models 接口，给用户友好提示
        const code = resp.status
        if (code === 404 || code === 405 || code === 501) {
          throw new Error('[NOT_SUPPORTED] 该服务商不支持自动获取模型列表，请手动输入模型 ID')
        }
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
    const cfg = readOpenclawConfigOptional()
    const bindings = cfg.bindings || []
    return { bindings }
  },

  get_agent_bindings({ agentId } = {}) {
    const cfg = readOpenclawConfigOptional()
    const all = Array.isArray(cfg.bindings) ? cfg.bindings : []
    const bindings = agentId ? all.filter(b => b?.agentId === agentId) : all
    return { bindings }
  },

  delete_agent_all_bindings({ agentId } = {}) {
    if (!agentId) throw new Error('agentId required')
    const cfg = readOpenclawConfigOptional()
    const before = Array.isArray(cfg.bindings) ? cfg.bindings.length : 0
    cfg.bindings = (cfg.bindings || []).filter(b => b?.agentId !== agentId)
    const removed = before - cfg.bindings.length
    if (removed > 0) {
      writeOpenclawConfigFile(cfg)
      triggerGatewayReloadNonBlocking('delete_agent_all_bindings')
    }
    return { ok: true, removed }
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

  scan_model_client_configs() {
    return scanModelClientConfigs()
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
    const currentInstallMode = detectActiveCliInstallMode()
    const pkg = npmPackageName(source)
    const recommended = recommendedVersionFor(source)
    const ver = version || recommended || 'latest'
    const oldPkg = npmPackageName(currentSource)
    const needUninstallOld = currentSource !== source && oldPkg !== pkg
    const npmBin = isWindows ? 'npm.cmd' : 'npm'
    const registry = pickRegistryForPackage(pkg)
    const logs = []
    const activeCliBefore = resolveOpenclawCliPath()
    const currentVersionBefore = getLocalOpenclawVersion()
    const installationsBefore = scanAllOpenclawInstallations(activeCliBefore)
    logs.push('升级前扫描当前 OpenClaw 安装...')
    logs.push(`当前使用: ${activeCliBefore || '未检测到 openclaw CLI'}${currentVersionBefore ? ` (${currentVersionBefore})` : ''}`)
    if (installationsBefore.length > 1) {
      logs.push(`检测到 ${installationsBefore.length} 个 OpenClaw 安装；升级成功后会切换到新版，旧安装不会自动删除。`)
    }

    // ── standalone 安装（auto / standalone-r2 / standalone-github） ──
    const tryStandalone = source !== 'official' && ['auto', 'standalone-r2', 'standalone-github'].includes(method)
    if (tryStandalone) {
      const githubReleaseBase = `https://github.com/qingchencloud/openclaw-standalone/releases/download/v${ver}`
      if (method === 'standalone-github') {
        // standalone-github 模式：只走 GitHub
        try {
          const saResult = await _tryStandaloneInstall(ver, logs, githubReleaseBase)
          if (saResult) {
            logs.push('✅ standalone (GitHub) 安装完成')
            return logs.join('\n')
          }
        } catch (e) {
          throw new Error(`standalone 安装失败: ${e.message}`)
        }
      } else {
        // auto / standalone-r2 模式：R2 CDN → GitHub Releases fallback
        let cdnErr = null
        try {
          const saResult = await _tryStandaloneInstall(ver, logs, null)
          if (saResult) {
            logs.push('✅ standalone (CDN) 安装完成')
            return logs.join('\n')
          }
        } catch (e) {
          cdnErr = e.message
          logs.push(`CDN 下载失败（${cdnErr}），尝试从 GitHub Releases 下载...`)
        }
        // Fallback: GitHub Releases
        if (cdnErr) {
          try {
            const saResult = await _tryStandaloneInstall(ver, logs, githubReleaseBase)
            if (saResult) {
              logs.push('✅ standalone (GitHub) 安装完成')
              return logs.join('\n')
            }
          } catch (e) {
            if (shouldFallbackStandaloneToNpm({ currentInstallMode, method })) {
              logs.push(`standalone 不可用（GitHub: ${e.message}），降级到 npm 安装...`)
            } else if (method === 'auto') {
              throw new Error(`当前 OpenClaw 使用 standalone 独立包模式，已阻止自动降级到 npm 全局安装。请稍后重试独立包升级，或在升级方式中手动选择 npm。standalone 安装失败: CDN=${cdnErr}, GitHub=${e.message}`)
            } else {
              throw new Error(`standalone 安装失败: CDN=${cdnErr}, GitHub=${e.message}`)
            }
          }
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

      if (needUninstallOld) {
        logs.push('正在修复 npm CLI 入口（避免旧包卸载删除 openclaw.cmd）...')
        try {
          runInstall(registry)
          logs.push('npm CLI 入口已确认')
        } catch (e) {
          throw new Error(`安装完成但修复 npm CLI 入口失败: ${e.stderr?.toString() || e.message || e}`)
        }
      }

      const npmCli = npmOpenclawCliPath()
      const installedVersion = npmCli
        ? (readVersionFromInstallation(npmCli) || getLocalOpenclawVersion())
        : getLocalOpenclawVersion()
      if (!npmCli || !installedVersion) {
        throw new Error(`安装完成但无法读取 OpenClaw 版本${npmCli ? `: ${npmCli}` : ''}`)
      }
      if (ver !== 'latest' && !versionsMatch(installedVersion, ver)) {
        throw new Error(`安装校验失败：目标 CLI 版本为 ${installedVersion}，期望版本为 ${ver}`)
      }
      bindOpenclawCliPath(npmCli)
      logs.push(`已切换当前 CLI: ${npmCli} (${installedVersion})`)
      logs.push(`安装完成 (${pkg}@${installedVersion})`)
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

  // Skills 管理（纯本地扫描，不依赖 CLI）
  skills_list({ agent_id } = {}) {
    const agentDir = resolveAgentSkillsDir(agent_id)
    return scanLocalSkillsFallback(agentDir)
  },
  skills_info({ name, agent_id } = {}) {
    const n = String(name || '').trim()
    const agentDir = resolveAgentSkillsDir(agent_id)
    const fallback = scanLocalSkillsFallback(agentDir).skills.find(skill => skill.name === n)
    if (fallback) return fallback
    throw new Error(`Skill「${n}」不存在`)
  },
  skills_check() {
    const data = scanLocalSkillsFallback()
    return {
      total: data.skills.length,
      ready: (data.eligible || []).length,
      missingDeps: (data.missingRequirements || []).length,
      skills: data.skills,
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
  skills_uninstall({ name, agent_id } = {}) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('无效的 Skill 名称')
    const agentDir = resolveAgentSkillsDir(agent_id)
    const baseDir = agentDir || path.join(OPENCLAW_DIR, 'skills')
    const skillDir = path.join(baseDir, name)
    if (!fs.existsSync(skillDir)) throw new Error(`Skill「${name}」不存在`)
    fs.rmSync(skillDir, { recursive: true, force: true })
    return { success: true, name }
  },
  // SkillHub SDK（内置 HTTP，不依赖 CLI）
  async skillhub_search({ query, limit }) {
    return await skillhubSdk.search(query, limit || 20)
  },
  async skillhub_index() {
    return await skillhubSdk.fetchIndex()
  },
  async skillhub_install({ slug, agent_id } = {}) {
    const agentDir = resolveAgentSkillsDir(agent_id)
    const skillsDir = agentDir || path.join(OPENCLAW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    const installedPath = await skillhubSdk.install(slug, skillsDir)
    return { success: true, slug, path: installedPath }
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
      const normalized = normalizeControlUiPairingEntry(paired[deviceId], deviceId, publicKey, platform)
      if (normalized.changed) {
        paired[deviceId] = normalized.entry
        fs.writeFileSync(PAIRED_PATH, JSON.stringify(paired, null, 2))
        return { message: '设备已配对（已修正权限字段）', changed: true }
      }
      return { message: '设备已配对', changed: originsChanged }
    }
    const nowMs = Date.now()
    paired[deviceId] = {
      deviceId, publicKey, platform, deviceFamily: 'desktop',
      clientId: 'openclaw-control-ui', clientMode: 'ui',
      role: 'operator', roles: ['operator'],
      scopes: SCOPES, approvedScopes: SCOPES,
      tokens: {
        operator: {
          token: generatePairingToken(),
          role: 'operator',
          scopes: SCOPES,
          createdAtMs: nowMs,
        },
      },
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
    // 设备签名 payload 字符串格式：以 `v3|` 开头标识 payload schema 版本（device signature payload format = v3）。
    // 注意：这里的 `v3` 是 **设备签名 payload 字符串的 schema 版本**，与下面 `minProtocol/maxProtocol` 协商的
    // **Gateway WebSocket 握手帧协议版本**（v3 / v4）是两套独立的版本号。即使在 v4 握手协议下，
    // 签名 payload 仍以 `v3|` 开头，两者互不影响。详见 src/lib/feature-catalog.js KERNEL_TARGET 注释。
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
        // 协议握手范围声明：下限 3 用于继续兼容历史内核，上限 4 启用新版增量 delta 协议。
        minProtocol: 3, maxProtocol: 4,
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
    writePanelConfigFile(config)
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
      return decorateNodeDetection({ installed: true, version: ver, path: nodeBin })
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
          results.push(decorateNodeDetection({ installed: true, path: nodeBin, dir: p, version: ver }))
        } catch {}
      }
    }
    return results
  },

  scan_openclaw_paths() {
    return scanAllOpenclawInstallations()
  },

  scan_openclaw_path_conflicts() {
    return buildOpenclawPathConflictRecords()
  },

  quarantine_openclaw_path({ path: targetPath } = {}) {
    return quarantineOpenclawPathForWeb(targetPath)
  },

  quarantine_openclaw_paths_bulk({ paths = [] } = {}) {
    const records = []
    const failed = []
    for (const targetPath of Array.isArray(paths) ? paths : []) {
      try {
        records.push(quarantineOpenclawPathForWeb(targetPath))
      } catch (e) {
        failed.push({ path: targetPath, error: e?.message || String(e) })
      }
    }
    return { records, failed }
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
    const detected = handlers.check_node_at_path({ nodeDir })
    if (!detected.installed) throw new Error('该目录下未找到 node 可执行文件，请确认路径正确。')
    if (detected.compatible === false) {
      throw new Error(`Node.js 版本过低：当前 ${detected.version || 'unknown'}，要求 ${detected.requiredVersion || '当前 OpenClaw 要求的版本'}。请升级 Node.js 后再使用该路径。`)
    }
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

  async check_panel_update() {
    try {
      return await getSitePanelUpdate()
    } catch (e) {
      return {
        latest: null,
        url: SITE_BASE_URL,
        source: 'site',
        downloadUrl: SITE_BASE_URL,
        error: `site: ${e.message || e}`,
      }
    }
  },

  async check_site_announcements({ locale } = {}) {
    const resp = await globalThis.fetch(cacheBustedSiteUrl('/api/v1/announcements', {
      app: 'ClawPanel',
      version: PANEL_VERSION,
      locale: normalizeSiteLocale(locale),
      surface: 'client',
    }), {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'ClawPanel' },
    })
    if (!resp.ok) throw new Error(`公告服务器返回 ${resp.status}`)
    return normalizeSiteUrlFields(await resp.json())
  },

  write_env_file({ path: p, config }) {
    const expanded = p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
    if (!expanded.startsWith(OPENCLAW_DIR)) throw new Error(`只允许写入 ${OPENCLAW_DIR} 下的文件`)
    const dir = path.dirname(expanded)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(expanded, config)
    return true
  },

  // =========================================================================
  // Hermes Agent 命令
  // =========================================================================

  check_python() {
    const enhanced = hermesEnhancedPath()
    const result = { platform: isWindows ? 'win-x64' : isMac ? 'mac-arm64' : 'linux-x64' }
    const candidates = isWindows
      ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
      : [['python3', ['--version']], ['python', ['--version']]]
    let found = false
    for (const [cmd, args] of candidates) {
      const r = runHermesSilent(cmd, args)
      if (r.ok) {
        const m = r.stdout.match(/(\d+)\.(\d+)\.(\d+)/)
        if (m) {
          const [, maj, min, pat] = m.map(Number)
          result.installed = true
          result.version = `${maj}.${min}.${pat}`
          result.versionOk = maj >= 3 && min >= 11
          result.pythonCmd = cmd
          result.path = findCommandPath(cmd)
          found = true
          break
        }
      }
    }
    if (!found) {
      result.installed = false; result.version = null; result.versionOk = false; result.path = null; result.pythonCmd = null
    }
    result.hasPip = runHermesSilent('pip', ['--version']).ok || runHermesSilent('pip3', ['--version']).ok
    result.hasPipx = runHermesSilent('pipx', ['--version']).ok
    const uvPath = path.join(uvBinDir(), isWindows ? 'uv.exe' : 'uv')
    result.hasUv = fs.existsSync(uvPath) || runHermesSilent('uv', ['--version']).ok
    result.hasGit = runHermesSilent('git', ['--version']).ok
    result.hasBrew = !isWindows && runHermesSilent('brew', ['--version']).ok
    return result
  },

  async check_hermes() {
    const home = hermesHome()
    const result = {}
    // 1. 检测 hermes CLI
    let r = runHermesSilent('hermes', ['version'])
    if (!r.ok) r = runHermesSilent('hermes', ['--version'])
    if (r.ok) {
      const verMatch = r.stdout.split(/\s+/).find(s => /^v?\d/.test(s)) || r.stdout
      result.installed = true
      result.version = verMatch.replace(/^v/, '')
      result.path = findCommandPath('hermes')
    } else {
      result.installed = false; result.version = null; result.path = null
    }
    // 2. managed
    const managed = process.env.HERMES_MANAGED
    if (managed) {
      const l = managed.trim().toLowerCase()
      result.managed = ['true','1','yes','nix','nixos'].includes(l) ? 'NixOS' : ['brew','homebrew'].includes(l) ? 'Homebrew' : 'unknown'
    } else {
      result.managed = fs.existsSync(path.join(home, '.managed')) ? 'NixOS' : null
    }
    // 3. 配置文件
    const configPath = path.join(home, 'config.yaml')
    const envPath = path.join(home, '.env')
    result.configExists = fs.existsSync(configPath)
    result.envExists = fs.existsSync(envPath)
    result.hermesHome = home
    // 4. 读取 model
    try {
      const content = fs.readFileSync(configPath, 'utf8')
      let inModel = false
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('model:')) {
          const val = trimmed.slice(6).trim().replace(/^["']|["']$/g, '')
          if (val) { result.model = val; break }
          inModel = true; continue
        }
        if (inModel) {
          if (!/^\s/.test(line) && trimmed) break
          if (trimmed.startsWith('default:')) {
            result.model = trimmed.slice(8).trim().replace(/^["']|["']$/g, '')
          }
        }
      }
    } catch {}
    // 5. Gateway 运行检测
    const port = hermesGatewayPort()
    const gwUrl = hermesGatewayUrl()
    let gatewayRunning = false
    try {
      const sock = new net.Socket()
      gatewayRunning = await new Promise(resolve => {
        sock.setTimeout(800)
        sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true) })
        sock.on('error', () => { sock.destroy(); resolve(false) })
        sock.on('timeout', () => { sock.destroy(); resolve(false) })
      })
    } catch { gatewayRunning = false }
    result.gatewayRunning = gatewayRunning
    result.gatewayPort = port
    result.gatewayUrl = gwUrl
    return result
  },

  async install_hermes({ method = 'uv-tool', extras = [] } = {}) {
    // 1. 查找 uv
    const uvPath = path.join(uvBinDir(), isWindows ? 'uv.exe' : 'uv')
    let uv = fs.existsSync(uvPath) ? uvPath : null
    if (!uv && runHermesSilent('uv', ['--version']).ok) uv = 'uv'
    if (!uv) throw new Error('uv 未安装。请先安装 uv 或使用 Tauri 桌面版自动下载')
    // 2. 安装
    const pkg = extras.length
      ? `hermes-agent[${extras.join(',')}] @ git+https://github.com/NousResearch/hermes-agent.git`
      : 'hermes-agent @ git+https://github.com/NousResearch/hermes-agent.git'
    const installArgs = method === 'uv-pip'
      ? ['pip', 'install', pkg]
      : ['tool', 'install', '--force', pkg, '--python', '3.11', '--with', 'croniter', '--with', 'httpx', '--with', 'openai', '--with', 'aiohttp', '--with', 'websockets']
    const result = spawnSync(uv, installArgs, {
      env: { ...process.env, PATH: hermesEnhancedPath(), GIT_TERMINAL_PROMPT: '0', ...gitMirrorEnv() },
      timeout: 600000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) {
      const cleaned = sanitizeHermesInstallOutput((result.stderr || '').trim())
      const hint = diagnoseHermesInstallError(cleaned)
      if (hint) throw new Error(`安装失败: ${cleaned}\n\n${hint}`)
      throw new Error(`安装失败: ${cleaned}`)
    }
    // 3. 验证
    const ver = runHermesSilent('hermes', ['version'])
    if (ver.ok) return ver.stdout
    throw new Error('安装完成但验证失败: hermes version 不可用')
  },

  async configure_hermes({ provider, apiKey, model, baseUrl } = {}) {
    const home = hermesHome()
    fs.mkdirSync(home, { recursive: true })
    for (const d of ['cron','sessions','logs','memories','skills','pairing','hooks','image_cache','audio_cache']) {
      fs.mkdirSync(path.join(home, d), { recursive: true })
    }
    const providerId = _normalizeHermesProviderForBaseUrl(provider, baseUrl)
    const pcfg = HERMES_PROVIDER_REGISTRY.find(p => p.id === providerId)
    const modelStr = (model || pcfg?.models?.[0] || '').trim()
    if (!modelStr) throw new Error(`Provider '${providerId || 'custom'}' has no default model; please pass an explicit model name`)
    const baseUrlValue = baseUrl && baseUrl.trim() ? baseUrl.trim() : ''
    const baseUrlLine = baseUrlValue ? `  base_url: ${baseUrlValue}\n` : ''
    const providerLine = providerId ? `  provider: ${providerId}\n` : ''
    const configPath = path.join(home, 'config.yaml')
    let configContent
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf8')
      configContent = _mergeHermesConfigYaml(existing, modelStr, baseUrlLine, providerLine)
    } else {
      configContent = `# Hermes Agent configuration (managed by ClawPanel)\nmodel:\n  default: ${modelStr}\n${providerLine}${baseUrlLine}platform_toolsets:\n  api_server:\n    - hermes-api-server\nterminal:\n  backend: local\nplatforms:\n  api_server:\n    enabled: true\n`
    }
    fs.writeFileSync(configPath, configContent)
    const envKey = pcfg?.apiKeyEnvVars?.[0] || ''
    const urlEnv = pcfg?.baseUrlEnvVar || ''
    const managedKeys = handlers._hermesManagedEnvKeys()
    const newPairs = [['GATEWAY_ALLOW_ALL_USERS', 'true'], ['API_SERVER_KEY', 'clawpanel-local']]
    if (envKey && apiKey && apiKey.trim()) {
      newPairs.push([envKey, apiKey.trim()])
      if (providerId === 'custom' && envKey !== 'CUSTOM_API_KEY') newPairs.push(['CUSTOM_API_KEY', apiKey.trim()])
    }
    if (urlEnv && baseUrlValue) newPairs.push([urlEnv, baseUrlValue])
    const envPath = path.join(home, '.env')
    let envContent
    if (fs.existsSync(envPath)) {
      const existing = fs.readFileSync(envPath, 'utf8')
      envContent = _mergeEnvFile(existing, managedKeys, newPairs)
    } else {
      envContent = newPairs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
    }
    fs.writeFileSync(envPath, envContent)
    return '配置已保存'
  },

  async hermes_gateway_action({ action } = {}) {
    const enhanced = hermesEnhancedPath()
    const port = hermesGatewayPort()
    if (action === 'start') {
      // Guardian: ensure platforms.api_server.enabled:true before start.
      // Mirrors Rust's ensure_api_server_enabled (see hermes.rs).
      try { this._hermesEnsureApiServerEnabled() } catch (e) {
        console.warn('[hermes guardian] patch failed:', e.message || e)
      }
      try { _sanitizeHermesOpenrouterCustomMismatch() } catch (e) {
        console.warn('[hermes guardian] provider/base_url sanitize failed:', e.message || e)
      }
      // 检测是否已运行
      const alive = await _tcpProbe('127.0.0.1', port, 300)
      if (alive) return 'Gateway 已在运行'
      if (_hermesGwStarting) return await _hermesGwStarting
      _hermesGwStarting = (async () => {
        const aliveAfterWait = await _tcpProbe('127.0.0.1', port, 500)
        if (aliveAfterWait) return 'Gateway 已在运行'
        // 启动
        const home = hermesHome()
        const envVars = { ...process.env, PATH: enhanced }
        const envPath = path.join(home, '.env')
        if (fs.existsSync(envPath)) {
          for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const t = line.trim()
            if (!t || t.startsWith('#')) continue
            const eq = t.indexOf('=')
            if (eq > 0) envVars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
          }
        }
        const logPath = path.join(home, 'gateway-run.log')
        const logFd = fs.openSync(logPath, 'a')
        const child = spawn('hermes', ['gateway', 'run'], {
          cwd: home, env: envVars, stdio: ['ignore', logFd, logFd],
          detached: true, windowsHide: true,
        })
        child.unref()
        _hermesGwProcess = child
        // 等端口可达
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 500))
          if (await _tcpProbe('127.0.0.1', port, 500)) {
            fs.closeSync(logFd)
            return 'Gateway 已启动'
          }
        }
        fs.closeSync(logFd)
        throw new Error('Gateway 启动后端口未就绪')
      })().finally(() => { _hermesGwStarting = null })
      return await _hermesGwStarting
    }
    if (action === 'stop') {
      if (_hermesGwProcess) { try { _hermesGwProcess.kill() } catch {} _hermesGwProcess = null }
      const r = runHermesSilent('hermes', ['gateway', 'stop'])
      if (isWindows) {
        try { spawnSync('taskkill', ['/F', '/IM', 'hermes.exe'], { windowsHide: true, timeout: 5000 }) } catch {}
      }
      return 'Gateway 已停止'
    }
    if (action === 'status') {
      const r = runHermesSilent('hermes', ['gateway', 'status'])
      return r.ok ? r.stdout : 'unknown'
    }
    throw new Error(`不支持的操作: ${action}`)
  },

  async _hermesEnsureGatewayReady() {
    const customUrl = hermesGatewayCustomUrl()
    if (customUrl && !isLoopbackGatewayUrl(customUrl)) return
    try { _sanitizeHermesOpenrouterCustomMismatch() } catch {}
    const port = hermesGatewayPort()
    if (await _tcpProbe('127.0.0.1', port, 300)) return
    await this.hermes_gateway_action({ action: 'start' })
  },

  async hermes_health_check() {
    const url = `${hermesGatewayUrl()}/health`
    const resp = await globalThis.fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ClawPanel-Web' } })
    if (!resp.ok) throw new Error(`Gateway 返回 HTTP ${resp.status}`)
    return await resp.json()
  },

  async hermes_capabilities() {
    const url = `${hermesGatewayUrl()}/v1/capabilities`
    const resp = await globalThis.fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ClawPanel-Web' } })
    if (!resp.ok) throw new Error(`Gateway 返回 HTTP ${resp.status}`)
    return await resp.json()
  },

  async hermes_api_proxy({ method, path: reqPath, body, headers: customHeaders } = {}) {
    const url = `${hermesGatewayUrl()}${reqPath}`
    const opts = { method: method || 'GET', headers: { 'User-Agent': 'ClawPanel-Web' } }
    const timeout = (reqPath.includes('/chat/completions') || reqPath.includes('/responses')) ? 120000 : 30000
    opts.signal = AbortSignal.timeout(timeout)
    // Auto-inject API_SERVER_KEY from .env if available
    try {
      const envContent = fs.readFileSync(path.join(hermesHome(), '.env'), 'utf8')
      const m = envContent.match(/^API_SERVER_KEY=(.+)$/m)
      if (m) opts.headers['Authorization'] = `Bearer ${m[1].trim()}`
    } catch {}
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body)
      opts.headers['Content-Type'] = 'application/json'
    }
    if (customHeaders && typeof customHeaders === 'object') {
      for (const [k, v] of Object.entries(customHeaders)) { if (typeof v === 'string') opts.headers[k] = v }
    }
    const resp = await globalThis.fetch(url, opts)
    const text = await resp.text()
    let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
    if (resp.status >= 400) throw new Error(json?.error?.message || json?.error || text)
    return json
  },

  async hermes_agent_run({ input, sessionId, conversationHistory, instructions } = {}) {
    // Web 模式下简化实现：POST /v1/runs 然后轮询或直接返回
    await this._hermesEnsureGatewayReady()
    const gwUrl = hermesGatewayUrl()
    const home = hermesHome()
    let apiKey = ''
    try {
      const envContent = fs.readFileSync(path.join(home, '.env'), 'utf8')
      const m = envContent.match(/^API_SERVER_KEY=(.+)$/m)
      if (m) apiKey = m[1].trim()
    } catch {}
    const payload = { input }
    if (sessionId) payload.session_id = sessionId
    if (conversationHistory) payload.conversation_history = conversationHistory
    if (instructions) payload.instructions = instructions
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ClawPanel-Web' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const resp = await globalThis.fetch(`${gwUrl}/v1/runs`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) { const t = await resp.text(); throw new Error(`HTTP ${resp.status}: ${t}`) }
    const body = await resp.json()
    return body.run_id || JSON.stringify(body)
  },

  hermes_read_config() {
    const home = hermesHome()
    const configPath = path.join(home, 'config.yaml')
    const envPath = path.join(home, '.env')
    try { _sanitizeHermesOpenrouterCustomMismatch() } catch {}
    let modelName = '', baseUrl = '', provider = '', apiKey = ''
    try {
      const content = fs.readFileSync(configPath, 'utf8')
      let inModel = false
      for (const line of content.split('\n')) {
        const t = line.trim()
        if (t.startsWith('model:')) {
          inModel = true
          const v = t.slice(6).trim().replace(/^["']|["']$/g, '')
          if (v && !v.includes(':')) modelName = v
          continue
        }
        if (inModel) {
          if (t.startsWith('default:')) modelName = t.slice(8).trim().replace(/^["']|["']$/g, '')
          else if (t.startsWith('base_url:')) baseUrl = t.slice(9).trim().replace(/^["']|["']$/g, '')
          else if (t.startsWith('provider:')) provider = t.slice(9).trim().replace(/^["']|["']$/g, '')
          else if (t && !t.startsWith('#') && !t.startsWith('-') && !/^\s/.test(line)) inModel = false
        }
      }
    } catch {}
    try {
      const envContent = fs.readFileSync(envPath, 'utf8')
      for (const line of envContent.split('\n')) {
        const t = line.trim()
        if (t.startsWith('OPENAI_API_KEY=')) apiKey = t.slice(15)
        else if (t.startsWith('ANTHROPIC_API_KEY=') && !apiKey) apiKey = t.slice(18)
        else if (t.startsWith('OPENROUTER_API_KEY=') && !apiKey) apiKey = t.slice(19)
        if (t.startsWith('OPENAI_BASE_URL=') && !baseUrl) baseUrl = t.slice(16)
        else if (t.startsWith('ANTHROPIC_BASE_URL=') && !baseUrl) baseUrl = t.slice(19)
      }
    } catch {}
    const displayModel = modelName.includes('/') ? modelName.slice(modelName.indexOf('/') + 1) : modelName
    return { model: displayModel, model_raw: modelName, base_url: baseUrl, provider, api_key: apiKey, config_exists: fs.existsSync(configPath) }
  },

  hermes_channel_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    const envValues = readHermesEnvValues()
    return {
      exists,
      configPath,
      values: buildHermesChannelConfigValues(config, envValues),
    }
  },

  hermes_channel_config_save({ platform, form } = {}) {
    const normalizedPlatform = normalizeHermesPlatform(platform)
    if (!normalizedPlatform) throw new Error(`不支持的 Hermes 渠道: ${platform || ''}`)
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesChannelConfig(config, normalizedPlatform, form || {})
    writeHermesConfigYamlObject(configPath, next)
    writeHermesEnvValues(buildHermesChannelEnvUpdates(normalizedPlatform, form || {}))
    const envValues = { ...readHermesEnvValues(), ...buildHermesChannelEnvUpdates(normalizedPlatform, form || {}) }
    return {
      ok: true,
      configPath,
      values: buildHermesChannelConfigValues(next, envValues)[normalizedPlatform],
    }
  },

  hermes_session_runtime_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesSessionRuntimeConfigValues(config),
    }
  },

  hermes_session_runtime_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesSessionRuntimeConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesSessionRuntimeConfigValues(next),
    }
  },

  hermes_compression_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesCompressionConfigValues(config),
    }
  },

  hermes_compression_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesCompressionConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesCompressionConfigValues(next),
    }
  },

  hermes_prompt_caching_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesPromptCachingConfigValues(config),
    }
  },

  hermes_prompt_caching_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesPromptCachingConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesPromptCachingConfigValues(next),
    }
  },

  hermes_openrouter_cache_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesOpenrouterCacheConfigValues(config),
    }
  },

  hermes_openrouter_cache_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesOpenrouterCacheConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesOpenrouterCacheConfigValues(next),
    }
  },

  hermes_provider_routing_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesProviderRoutingConfigValues(config),
    }
  },

  hermes_provider_routing_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesProviderRoutingConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesProviderRoutingConfigValues(next),
    }
  },

  hermes_auxiliary_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesAuxiliaryConfigValues(config),
    }
  },

  hermes_auxiliary_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesAuxiliaryConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesAuxiliaryConfigValues(next),
    }
  },

  hermes_tool_loop_guardrails_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesToolLoopGuardrailsConfigValues(config),
    }
  },

  hermes_tool_loop_guardrails_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesToolLoopGuardrailsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesToolLoopGuardrailsConfigValues(next),
    }
  },

  hermes_memory_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesMemoryConfigValues(config),
    }
  },

  hermes_memory_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesMemoryConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesMemoryConfigValues(next),
    }
  },

  hermes_skills_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesSkillsConfigValues(config),
    }
  },

  hermes_skills_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesSkillsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesSkillsConfigValues(next),
    }
  },

  hermes_curator_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesCuratorConfigValues(config),
    }
  },

  hermes_curator_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesCuratorConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesCuratorConfigValues(next),
    }
  },

  hermes_quick_commands_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesQuickCommandsConfigValues(config),
    }
  },

  hermes_quick_commands_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesQuickCommandsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesQuickCommandsConfigValues(next),
    }
  },

  hermes_model_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesModelConfigValues(config),
    }
  },

  hermes_model_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesModelConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesModelConfigValues(next),
    }
  },

  hermes_x_search_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesXSearchConfigValues(config),
    }
  },

  hermes_x_search_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesXSearchConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesXSearchConfigValues(next),
    }
  },

  hermes_context_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesContextConfigValues(config),
    }
  },

  hermes_context_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesContextConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesContextConfigValues(next),
    }
  },

  hermes_model_aliases_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesModelAliasesConfigValues(config),
    }
  },

  hermes_model_aliases_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesModelAliasesConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesModelAliasesConfigValues(next),
    }
  },

  hermes_hooks_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesHooksConfigValues(config),
    }
  },

  hermes_hooks_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesHooksConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesHooksConfigValues(next),
    }
  },

  hermes_provider_overrides_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesProviderOverridesConfigValues(config),
    }
  },

  hermes_provider_overrides_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesProviderOverridesConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesProviderOverridesConfigValues(next),
    }
  },

  hermes_mcp_servers_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesMcpServersConfigValues(config),
    }
  },

  hermes_mcp_servers_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesMcpServersConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesMcpServersConfigValues(next),
    }
  },

  hermes_agent_toolsets_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesAgentToolsetsConfigValues(config),
    }
  },

  hermes_agent_toolsets_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesAgentToolsetsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesAgentToolsetsConfigValues(next),
    }
  },

  hermes_platform_toolsets_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesPlatformToolsetsConfigValues(config),
    }
  },

  hermes_platform_toolsets_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesPlatformToolsetsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesPlatformToolsetsConfigValues(next),
    }
  },

  hermes_agent_runtime_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesAgentRuntimeConfigValues(config),
    }
  },

  hermes_agent_runtime_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesAgentRuntimeConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesAgentRuntimeConfigValues(next),
    }
  },

  hermes_unauthorized_dm_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesUnauthorizedDmConfigValues(config),
    }
  },

  hermes_unauthorized_dm_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesUnauthorizedDmConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesUnauthorizedDmConfigValues(next),
    }
  },

  hermes_security_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesSecurityConfigValues(config),
    }
  },

  hermes_security_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesSecurityConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesSecurityConfigValues(next),
    }
  },

  hermes_human_delay_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesHumanDelayConfigValues(config),
    }
  },

  hermes_human_delay_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesHumanDelayConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesHumanDelayConfigValues(next),
    }
  },

  hermes_display_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesDisplayConfigValues(config),
    }
  },

  hermes_display_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesDisplayConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesDisplayConfigValues(next),
    }
  },

  hermes_kanban_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesKanbanConfigValues(config),
    }
  },

  hermes_kanban_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesKanbanConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesKanbanConfigValues(next),
    }
  },

  hermes_streaming_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesStreamingConfigValues(config),
    }
  },

  hermes_streaming_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesStreamingConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesStreamingConfigValues(next),
    }
  },

  hermes_execution_limits_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesExecutionLimitsConfigValues(config),
    }
  },

  hermes_execution_limits_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesExecutionLimitsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesExecutionLimitsConfigValues(next),
    }
  },

  hermes_io_safety_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesIoSafetyConfigValues(config),
    }
  },

  hermes_io_safety_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesIoSafetyConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesIoSafetyConfigValues(next),
    }
  },

  hermes_checkpoints_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesCheckpointsConfigValues(config),
    }
  },

  hermes_checkpoints_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesCheckpointsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesCheckpointsConfigValues(next),
    }
  },

  hermes_cron_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesCronConfigValues(config),
    }
  },

  hermes_cron_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesCronConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesCronConfigValues(next),
    }
  },

  hermes_sessions_maintenance_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesSessionsMaintenanceConfigValues(config),
    }
  },

  hermes_sessions_maintenance_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesSessionsMaintenanceConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesSessionsMaintenanceConfigValues(next),
    }
  },

  hermes_updates_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesUpdatesConfigValues(config),
    }
  },

  hermes_updates_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesUpdatesConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesUpdatesConfigValues(next),
    }
  },

  hermes_logging_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesLoggingConfigValues(config),
    }
  },

  hermes_logging_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesLoggingConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesLoggingConfigValues(next),
    }
  },

  hermes_approvals_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesApprovalsConfigValues(config),
    }
  },

  hermes_approvals_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesApprovalsConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesApprovalsConfigValues(next),
    }
  },

  hermes_privacy_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesPrivacyConfigValues(config),
    }
  },

  hermes_privacy_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesPrivacyConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesPrivacyConfigValues(next),
    }
  },

  hermes_browser_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesBrowserConfigValues(config),
    }
  },

  hermes_browser_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesBrowserConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesBrowserConfigValues(next),
    }
  },

  hermes_web_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesWebConfigValues(config),
    }
  },

  hermes_web_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesWebConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesWebConfigValues(next),
    }
  },

  hermes_lsp_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesLspConfigValues(config),
    }
  },

  hermes_lsp_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesLspConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesLspConfigValues(next),
    }
  },

  hermes_model_catalog_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesModelCatalogConfigValues(config),
    }
  },

  hermes_model_catalog_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesModelCatalogConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesModelCatalogConfigValues(next),
    }
  },

  hermes_stt_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesSttConfigValues(config),
    }
  },

  hermes_stt_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesSttConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesSttConfigValues(next),
    }
  },

  hermes_tts_voice_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesTtsVoiceConfigValues(config),
    }
  },

  hermes_tts_voice_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesTtsVoiceConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesTtsVoiceConfigValues(next),
    }
  },

  hermes_terminal_config_read() {
    const { configPath, exists, config } = readHermesConfigYamlObject()
    return {
      exists,
      configPath,
      values: buildHermesTerminalConfigValues(config),
    }
  },

  hermes_terminal_config_save({ form } = {}) {
    const { configPath, config } = readHermesConfigYamlObject()
    const next = mergeHermesTerminalConfig(config, form || {})
    const backup = writeHermesConfigYamlObject(configPath, next)
    return {
      ok: true,
      configPath,
      backup,
      values: buildHermesTerminalConfigValues(next),
    }
  },

  // P1-3 lazy_deps: Web 模式下不能调 venv python，但仍提供 feature 列表 + 提示用户走桌面端装
  hermes_lazy_deps_features() {
    const features = [
      { feature: 'platform.telegram', specs: ['python-telegram-bot[webhooks]==22.6'] },
      { feature: 'platform.discord', specs: ['discord.py[voice]==2.7.1'] },
      { feature: 'platform.slack', specs: ['slack-bolt==1.27.0', 'slack-sdk==3.40.1', 'aiohttp==3.13.3'] },
      { feature: 'platform.matrix', specs: ['matrix-nio[e2e]'] },
      { feature: 'platform.dingtalk', specs: ['dingtalk-stream'] },
      { feature: 'platform.feishu', specs: ['lark-oapi'] },
      { feature: 'tts.edge', specs: ['edge-tts==7.2.7'] },
      { feature: 'tts.elevenlabs', specs: ['elevenlabs==1.59.0'] },
      { feature: 'stt.faster_whisper', specs: ['faster-whisper==1.2.1', 'sounddevice==0.5.5', 'numpy==2.4.3'] },
      { feature: 'search.exa', specs: ['exa-py==2.10.2'] },
      { feature: 'search.firecrawl', specs: ['firecrawl-py==4.17.0'] },
      { feature: 'search.parallel', specs: ['parallel-web==0.4.2'] },
      { feature: 'provider.anthropic', specs: ['anthropic==0.86.0'] },
      { feature: 'provider.bedrock', specs: ['boto3==1.42.89'] },
      { feature: 'memory.honcho', specs: ['honcho-ai==2.0.1'] },
      { feature: 'memory.hindsight', specs: ['hindsight-client==0.6.1'] },
      { feature: 'image.fal', specs: ['fal-client==0.13.1'] },
    ]
    return { ok: true, features }
  },

  hermes_lazy_deps_status({ features }) {
    // Web 模式无法实际查询 venv，全部标 unknown
    const status = {}
    for (const f of features || []) status[f] = { known: true, satisfied: false, missing: [] }
    return { ok: true, status }
  },

  hermes_lazy_deps_ensure({ feature }) {
    return { ok: false, error: `Web 模式下无法预装依赖。请在桌面端 ClawPanel 完成 ${feature} 安装。` }
  },

  // Batch 2 §I: 流恢复 — GET /v1/runs/{run_id}
  async hermes_run_status({ runId } = {}) {
    if (!runId) throw new Error('run_id 不能为空')
    const url = `${hermesGatewayUrl()}/v1/runs/${encodeURIComponent(runId)}`
    const apiKey = _readHermesApiServerKey()
    const headers = { 'User-Agent': 'ClawPanel-Web' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const resp = await globalThis.fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    if (resp.status === 404) return { run_id: runId, status: 'not_found' }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`status 失败 HTTP ${resp.status}: ${body}`)
    }
    return await resp.json()
  },

  // Batch 1 §D: 真正中断 — POST /v1/runs/{run_id}/stop
  async hermes_run_stop({ runId } = {}) {
    if (!runId) throw new Error('run_id 不能为空')
    const url = `${hermesGatewayUrl()}/v1/runs/${encodeURIComponent(runId)}/stop`
    const apiKey = _readHermesApiServerKey()
    const headers = { 'User-Agent': 'ClawPanel-Web' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const resp = await globalThis.fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(5000) })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`stop 失败 HTTP ${resp.status}: ${body}`)
    }
    return await resp.json().catch(() => ({ ok: true }))
  },

  // Batch 3 §L: 文件管理器（Web 模式走 Node fs，限定 hermes_home 子树）
  _hermesHome() {
    if (process.env.HERMES_HOME) return process.env.HERMES_HOME
    return path.join(os.homedir(), '.hermes')
  },
  _validateFsPath(rel) {
    const root = handlers._hermesHome()
    const target = rel ? path.resolve(root, rel) : root
    const canonRoot = fs.realpathSync.native?.(root) || root
    if (!target.startsWith(canonRoot)) throw new Error(`路径不能跳出 ${root}`)
    return target
  },
  async hermes_fs_list({ path: p = '' } = {}) {
    const target = handlers._validateFsPath(p)
    if (!fs.existsSync(target)) throw new Error(`目录不存在: ${target}`)
    const stat = fs.statSync(target)
    if (!stat.isDirectory()) throw new Error(`不是目录: ${target}`)
    let entries = fs.readdirSync(target, { withFileTypes: true }).filter(e => !e.name.startsWith('.') || e.name === '.env')
    entries = entries.slice(0, 2000).map(e => {
      const sub = path.join(target, e.name)
      const m = fs.statSync(sub)
      return {
        name: e.name,
        kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
        size: e.isFile() ? m.size : null,
        modified: Math.floor(m.mtimeMs / 1000),
      }
    })
    entries.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return { path: target, entries }
  },
  async hermes_fs_read({ path: p } = {}) {
    const target = handlers._validateFsPath(p)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`不是文件: ${target}`)
    const stat = fs.statSync(target)
    if (stat.size > 5 * 1024 * 1024) throw new Error(`文件过大 (${stat.size} bytes)`)
    const buf = fs.readFileSync(target)
    let text = null, binary_b64 = null
    try { text = buf.toString('utf8'); if (text.includes('\u0000')) { text = null; binary_b64 = buf.toString('base64') } }
    catch { binary_b64 = buf.toString('base64') }
    return { path: target, size: stat.size, text, binary_b64 }
  },
  async hermes_fs_write({ path: p, content } = {}) {
    const target = handlers._validateFsPath(p)
    if (Buffer.byteLength(content || '', 'utf8') > 5 * 1024 * 1024) throw new Error('内容过大')
    fs.writeFileSync(target, content || '', 'utf8')
    return { path: target, size: fs.statSync(target).size }
  },

  // Batch 2 §G: 多 Gateway（Web 模式不支持本地进程管理）
  hermes_multi_gateway_list() { return [] },
  hermes_multi_gateway_add() { throw new Error('Web 模式不支持多 Gateway 管理（请使用桌面客户端）') },
  hermes_multi_gateway_remove() { throw new Error('Web 模式不支持多 Gateway 管理') },
  hermes_multi_gateway_start() { throw new Error('Web 模式不支持多 Gateway 管理') },
  hermes_multi_gateway_stop() { throw new Error('Web 模式不支持多 Gateway 管理') },

  // Batch 2 §H 基础设施: 通用 Dashboard 9119 HTTP 代理（含 session token 注入）
  // _dashboardToken 模块级缓存；401 时刷新重试
  async _fetchDashboardToken(port) {
    const resp = await globalThis.fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) throw new Error(`dashboard 首页 HTTP ${resp.status}`)
    const html = await resp.text()
    const m = html.match(/window\.__HERMES_SESSION_TOKEN__="([^"]+)"/)
    if (!m) throw new Error('无法从 dashboard HTML 提取 session token')
    handlers._dashboardToken = m[1]
    return m[1]
  },
  async _getDashboardToken(port, forceRefresh = false) {
    if (!forceRefresh && handlers._dashboardToken) return handlers._dashboardToken
    return await handlers._fetchDashboardToken(port)
  },
  async hermes_dashboard_api_proxy({ method = 'GET', path: reqPath = '/', body = null, headers: customHeaders } = {}) {
    const port = handlers._hermesDashboardPort()
    const url = `http://127.0.0.1:${port}${reqPath}`
    const buildOpts = (token) => {
      const opts = { method: String(method).toUpperCase(), headers: { 'User-Agent': 'ClawPanel-Web' } }
      opts.signal = AbortSignal.timeout(30000)
      if (token) opts.headers['X-Hermes-Session-Token'] = token
      if (customHeaders && typeof customHeaders === 'object') Object.assign(opts.headers, customHeaders)
      if (body != null && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(opts.method)) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = typeof body === 'string' ? body : JSON.stringify(body)
      }
      return opts
    }
    // 把网络错误（fetch failed / ECONNREFUSED）转成友好错，方便前端 humanizeError 归类
    const friendly = (err) => {
      const msg = String(err?.message || err || '')
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted/i.test(msg)) {
        return new Error(`Hermes Dashboard 未运行（端口 ${port} 无服务）。请在桌面端 ClawPanel 启动 Hermes Agent，或在 Settings 中配置远端 Dashboard 地址`)
      }
      return err instanceof Error ? err : new Error(msg)
    }
    let token = await handlers._getDashboardToken(port, false).catch(() => null)
    let resp
    try {
      resp = await globalThis.fetch(url, buildOpts(token))
    } catch (err) {
      throw friendly(err)
    }
    if (resp.status === 401) {
      // 强制刷新 + 重试
      try {
        token = await handlers._getDashboardToken(port, true)
        resp = await globalThis.fetch(url, buildOpts(token))
      } catch (err) {
        throw friendly(err)
      }
    }
    const text = await resp.text().catch(() => '')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text}（提示：请先启动 Dashboard）`)
    try { return JSON.parse(text) } catch { return text }
  },

  // Batch 1 §E: Sessions 导出（走 dashboard 9119）
  async hermes_session_export({ sessionId } = {}) {
    if (!sessionId) throw new Error('session_id 不能为空')
    const port = handlers._hermesDashboardPort()
    const url = `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/messages`
    const resp = await globalThis.fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`export 失败 HTTP ${resp.status}: ${body}（提示：请先启动 Dashboard）`)
    }
    return await resp.json()
  },

  // Batch 1 §C-bis: Approval Flow — POST /v1/runs/{run_id}/approval { choice }
  async hermes_run_approval({ runId, choice } = {}) {
    if (!runId) throw new Error('run_id 不能为空')
    if (!['once', 'session', 'always', 'deny'].includes(choice)) {
      throw new Error(`approval choice 必须是 once/session/always/deny，收到 ${choice}`)
    }
    const url = `${hermesGatewayUrl()}/v1/runs/${encodeURIComponent(runId)}/approval`
    const apiKey = _readHermesApiServerKey()
    const headers = { 'User-Agent': 'ClawPanel-Web', 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const resp = await globalThis.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ choice }),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`approval 失败 HTTP ${resp.status}: ${body}`)
    }
    return await resp.json().catch(() => ({ ok: true }))
  },

  // P1-4：完整解析 config.yaml，让前端能读 14+ 高价值字段
  // Web 模式不引入 yaml 依赖，简单返回 raw + null highlights（前端按需渲染）
  hermes_read_config_full() {
    const configPath = path.join(hermesHome(), 'config.yaml')
    if (!fs.existsSync(configPath)) {
      return { exists: false, raw: '', config: {}, highlights: {} }
    }
    let raw = ''
    try { raw = fs.readFileSync(configPath, 'utf8') } catch {}
    // Web 模式下不强制 yaml 解析（避免新增依赖），前端可走 raw 自己 parse 或者 fallback 到桌面端
    const highlightKeys = [
      'streaming', 'stt_enabled', 'quick_commands', 'reset_triggers',
      'default_reset_policy', 'unauthorized_dm_behavior',
      'session_store_max_age_days', 'always_log_local',
      'group_sessions_per_user', 'thread_sessions_per_user',
      'platforms', 'dashboard', 'memory', 'skills',
    ]
    const highlights = {}
    highlightKeys.forEach(k => { highlights[k] = null })
    return { exists: true, raw, config: {}, highlights }
  },

  hermes_list_providers() {
    return HERMES_PROVIDER_REGISTRY.map(p => ({
      ...p,
      apiKeyEnvVars: [...p.apiKeyEnvVars],
      models: [...p.models],
    }))
  },

  // -----------------------------------------------------------------------
  // api_server guardian (Step 5) — mirror of Rust's config_has_api_server_enabled
  // + patch_yaml_ensure_api_server + ensure_api_server_enabled. Called before
  // every `hermes gateway run` so that an upgrade / manual edit that drops
  // `platforms.api_server.enabled: true` is auto-healed.
  // -----------------------------------------------------------------------
  _hermesConfigHasApiServerEnabled(raw) {
    let inPlatforms = false
    let inApiServer = false
    for (const origLine of raw.split('\n')) {
      const hash = origLine.indexOf('#')
      const line = hash >= 0 ? origLine.slice(0, hash) : origLine
      const trimmed = line.replace(/\s+$/, '')
      if (!trimmed) continue
      const indent = trimmed.length - trimmed.trimStart().length
      if (indent === 0) {
        inPlatforms = trimmed.trimStart().startsWith('platforms:')
        inApiServer = false
        continue
      }
      if (!inPlatforms) continue
      if (indent <= 2) {
        inApiServer = trimmed.trimStart().startsWith('api_server:')
        continue
      }
      if (!inApiServer) continue
      const t = trimmed.trimStart()
      if (t.startsWith('enabled:')) {
        const v = t.slice(8).trim().replace(/^['"]|['"]$/g, '').toLowerCase()
        return ['true', 'yes', 'on', '1'].includes(v)
      }
    }
    return false
  },

  _hermesPatchYamlEnsureApiServer(raw) {
    if (this._hermesConfigHasApiServerEnabled(raw)) return raw
    const lines = raw.split('\n')
    const out = []
    let platformsFound = false
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.replace(/\s+$/, '')
      const indent = trimmed.length - trimmed.trimStart().length
      if (indent === 0 && trimmed.trimStart().startsWith('platforms:')) {
        out.push(line)
        platformsFound = true
        i++
        const accumulated = []
        let skipping = false
        while (i < lines.length) {
          const l = lines[i]
          const t = l.replace(/\s+$/, '')
          const ind = t.length - t.trimStart().length
          if (ind === 0 && t !== '') break
          if (ind <= 2) skipping = t.trimStart().startsWith('api_server:')
          if (!skipping) accumulated.push(l)
          i++
        }
        out.push('  api_server:')
        out.push('    enabled: true')
        out.push(...accumulated)
        continue
      }
      out.push(line)
      i++
    }
    if (!platformsFound) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      out.push('platforms:')
      out.push('  api_server:')
      out.push('    enabled: true')
    }
    let content = out.join('\n')
    if (!content.endsWith('\n')) content += '\n'
    return content
  },

  _hermesEnsureApiServerEnabled() {
    const configPath = path.join(hermesHome(), 'config.yaml')
    if (!fs.existsSync(configPath)) return
    const raw = fs.readFileSync(configPath, 'utf8')
    if (this._hermesConfigHasApiServerEnabled(raw)) return
    const ts = Math.floor(Date.now() / 1000)
    const backupPath = configPath + `.bak-${ts}`
    try { fs.writeFileSync(backupPath, raw) } catch {}
    const patched = this._hermesPatchYamlEnsureApiServer(raw)
    fs.writeFileSync(configPath, patched)
    console.warn(`[hermes guardian] patched config.yaml (api_server.enabled). Backup: ${backupPath}`)
  },

  _hermesManagedEnvKeys() {
    const out = []
    const add = key => {
      if (key && !out.includes(key)) out.push(key)
    }
    for (const provider of HERMES_PROVIDER_REGISTRY) {
      for (const key of provider.apiKeyEnvVars || []) add(key)
      add(provider.baseUrlEnvVar)
    }
    add('GATEWAY_ALLOW_ALL_USERS')
    add('API_SERVER_KEY')
    return out
  },

  hermes_env_read_unmanaged() {
    const envPath = path.join(hermesHome(), '.env')
    if (!fs.existsSync(envPath)) return []
    const raw = fs.readFileSync(envPath, 'utf8')
    const managed = new Set(handlers._hermesManagedEnvKeys())
    const seen = new Set()
    const out = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      if (!key || managed.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push([key, t.slice(eq + 1)])
    }
    return out
  },

  hermes_env_set({ key, value } = {}) {
    key = (key || '').trim()
    if (!key) throw new Error('Key cannot be empty')
    if (!/^[A-Z0-9_]+$/i.test(key)) {
      throw new Error(`Invalid env var key '${key}': only [A-Z0-9_] are allowed`)
    }
    const managed = new Set(handlers._hermesManagedEnvKeys())
    if (managed.has(key)) {
      throw new Error(`'${key}' is managed by ClawPanel; please configure it via the provider setup page`)
    }
    const envPath = path.join(hermesHome(), '.env')
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    const lines = raw.split('\n')
    const out = []
    let replaced = false
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) { out.push(line); continue }
      const eq = t.indexOf('=')
      if (eq > 0 && t.slice(0, eq).trim() === key && !replaced) {
        out.push(`${key}=${value == null ? '' : value}`)
        replaced = true
        continue
      }
      out.push(line)
    }
    if (!replaced) out.push(`${key}=${value == null ? '' : value}`)
    let content = out.join('\n')
    if (!content.endsWith('\n')) content += '\n'
    fs.writeFileSync(envPath, content)
    return null
  },

  hermes_env_delete({ key } = {}) {
    key = (key || '').trim()
    if (!key) throw new Error('Key cannot be empty')
    const managed = new Set(handlers._hermesManagedEnvKeys())
    if (managed.has(key)) {
      throw new Error(`'${key}' is managed by ClawPanel; please configure it via the provider setup page`)
    }
    const envPath = path.join(hermesHome(), '.env')
    if (!fs.existsSync(envPath)) return null
    const raw = fs.readFileSync(envPath, 'utf8')
    const lines = raw.split('\n')
    const out = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) { out.push(line); continue }
      const eq = t.indexOf('=')
      if (eq > 0 && t.slice(0, eq).trim() === key) continue
      out.push(line)
    }
    let content = out.join('\n')
    if (!content.endsWith('\n')) content += '\n'
    fs.writeFileSync(envPath, content)
    return null
  },

  hermes_env_reveal({ key } = {}) {
    key = (key || '').trim()
    if (!key) throw new Error('Key cannot be empty')
    const envPath = path.join(hermesHome(), '.env')
    if (!fs.existsSync(envPath)) throw new Error('.env not found')
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq > 0 && t.slice(0, eq).trim() === key) return { key, value: t.slice(eq + 1) }
    }
    throw new Error(`${key} not found in .env`)
  },

  hermes_config_raw_read() {
    const configPath = path.join(hermesHome(), 'config.yaml')
    return { yaml: fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '' }
  },

  hermes_config_raw_write({ yamlText } = {}) {
    const configPath = path.join(hermesHome(), 'config.yaml')
    const content = String(yamlText || '')
    validateHermesConfigYamlText(content)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    let backup = ''
    if (fs.existsSync(configPath)) {
      backup = `${configPath}.bak-${Math.floor(Date.now() / 1000)}`
      fs.copyFileSync(configPath, backup)
    }
    fs.writeFileSync(configPath, content)
    return { ok: true, backup }
  },

  hermes_dashboard_themes() {
    const configPath = path.join(hermesHome(), 'config.yaml')
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    const active = (raw.match(/^\s*theme:\s*["']?([^"'\n#]+)["']?/m)?.[1] || 'default').trim()
    const themes = [
      { name: 'default', label: 'Default', description: 'Hermes default dashboard theme' },
      { name: 'midnight', label: 'Midnight', description: 'Dark blue dashboard theme' },
      { name: 'ember', label: 'Ember', description: 'Warm dashboard theme' },
      { name: 'mono', label: 'Mono', description: 'Monochrome dashboard theme' },
      { name: 'cyberpunk', label: 'Cyberpunk', description: 'Neon dashboard theme' },
      { name: 'rose', label: 'Rose', description: 'Soft rose dashboard theme' },
    ]
    const dir = path.join(hermesHome(), 'dashboard-themes')
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (!/\.ya?ml$/i.test(file)) continue
        const name = path.basename(file).replace(/\.ya?ml$/i, '')
        if (!themes.some(t => t.name === name)) themes.push({ name, label: name, description: 'User dashboard theme' })
      }
    }
    return { themes, active }
  },

  hermes_dashboard_theme_set({ name } = {}) {
    name = (name || '').trim()
    if (!name) throw new Error('Theme name cannot be empty')
    const configPath = path.join(hermesHome(), 'config.yaml')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    let content
    if (/^dashboard:\s*$/m.test(raw)) {
      content = /^\s+theme:/m.test(raw)
        ? raw.replace(/^(\s+)theme:.*$/m, `$1theme: ${name}`)
        : raw.replace(/^dashboard:\s*$/m, `dashboard:\n  theme: ${name}`)
    } else {
      content = `${raw.replace(/\s*$/, '')}\n\ndashboard:\n  theme: ${name}\n`
    }
    fs.writeFileSync(configPath, content)
    return { ok: true, theme: name }
  },

  hermes_dashboard_plugins() {
    const root = path.join(hermesHome(), 'plugins')
    if (!fs.existsSync(root)) return []
    const out = []
    const seen = new Set()
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name)
      const manifest = path.join(dir, 'dashboard', 'manifest.json')
      if (!fs.existsSync(manifest)) continue
      try {
        const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        const id = data.name || name
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push({
          name: id,
          label: data.label || id,
          description: data.description || '',
          icon: data.icon || 'Puzzle',
          version: data.version || '0.0.0',
          tab: data.tab || { path: `/${id}`, position: 'end' },
          slots: data.slots || [],
          entry: data.entry || 'dist/index.js',
          css: data.css || null,
          has_api: !!data.api,
          source: 'user',
        })
      } catch {}
    }
    return out
  },

  hermes_dashboard_plugins_rescan() {
    return { ok: true, count: handlers.hermes_dashboard_plugins().length }
  },

  async hermes_dashboard_probe() {
    const port = handlers._hermesDashboardPort()
    const cli = handlers._hermesDashboardCliStatus(port)
    const running = cli?.running || await _tcpProbe('127.0.0.1', port, 800)
    return { running, port, status: cli?.output || null }
  },

  // 共用：解析 dashboard.port（缩进感知，避免误匹配 gateway 块的 port）
  _hermesDashboardPort() {
    let port = 9119
    try {
      const cfg = path.join(hermesHome(), 'config.yaml')
      if (fs.existsSync(cfg)) {
        const raw = fs.readFileSync(cfg, 'utf8')
        let inDashboard = false
        for (const line of raw.split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('#')) continue
          const indent = line.length - line.trimStart().length
          if (indent === 0) { inDashboard = t === 'dashboard:' || t.startsWith('dashboard:'); continue }
          if (inDashboard && t.startsWith('port:')) {
            const p = parseInt(t.replace(/^port:/, '').trim(), 10)
            if (Number.isFinite(p) && p > 0) { port = p; break }
          }
        }
      }
    } catch {}
    return port
  },

  _hermesDashboardCliStatus(port) {
    const attempts = [
      runHermesSilent('hermes', ['dashboard', '--status']),
      runHermesSilent('hermes', ['dashboard', 'status']),
    ]
    for (const result of attempts) {
      if (!result.ok) continue
      const output = result.stdout || ''
      const lower = output.toLowerCase()
      if (lower.includes('not running') || lower.includes('stopped') || lower.includes('inactive') || lower.includes('no dashboard')) {
        return { running: false, output }
      }
      if (lower.includes('running') || lower.includes('listening') || lower.includes('http://') || lower.includes('https://') || lower.includes(String(port))) {
        return { running: true, output }
      }
    }
    return null
  },

  _hermesDashboardCliStop() {
    return runHermesSilent('hermes', ['dashboard', '--stop']).ok
      || runHermesSilent('hermes', ['dashboard', 'stop']).ok
  },

  async hermes_dashboard_start() {
    const port = handlers._hermesDashboardPort()
    // 1. 已运行？
    const cli = handlers._hermesDashboardCliStatus(port)
    if (cli?.running || await _tcpProbe('127.0.0.1', port, 500)) {
      return { started: true, already_running: true, port }
    }
    // 2. 清残留 PID
    if (handlers._dashPid) {
      try { process.kill(handlers._dashPid, 'SIGKILL') } catch {}
      handlers._dashPid = 0
    }
    const home = hermesHome()
    const logPath = path.join(home, 'dashboard-run.log')
    let out, err
    try {
      out = fs.openSync(logPath, 'w')
      err = fs.openSync(logPath, 'a')
    } catch (e) {
      throw new Error(`创建日志文件失败: ${e.message || e}`)
    }
    // 注入 .env
    const envVars = { ...process.env, PATH: hermesEnhancedPath() }
    const envPath = path.join(home, '.env')
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const eq = t.indexOf('=')
        if (eq > 0) envVars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
      }
    }
    const child = spawn('hermes', ['dashboard'], {
      cwd: home,
      env: envVars,
      stdio: ['ignore', out, err],
      detached: true,
      windowsHide: true,
    })
    child.unref()
    const pid = child.pid
    handlers._dashPid = pid

    let earlyExitCode = null
    let earlyExitFlag = false
    child.once('exit', (code) => { earlyExitCode = code; earlyExitFlag = true })

    // 3. 等待 - 端口起来 / 进程提前死 / 超时（90s 覆盖首次 npm build）
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      if (earlyExitFlag) {
        handlers._dashPid = 0
        const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
        const tail = raw.split('\n').slice(-40).join('\n')
        const lower = raw.toLowerCase()
        let kind = 'spawn_failed'
        if (lower.includes('web ui dependencies not installed')
          || lower.includes("no module named 'fastapi'")
          || (lower.includes('import error') && lower.includes('fastapi'))) {
          kind = 'deps_missing'
        } else if (lower.includes('address already in use')
          || lower.includes('address in use')
          || (lower.includes('port') && lower.includes('already in use'))) {
          kind = 'port_in_use'
        }
        return { started: false, kind, exit_code: earlyExitCode, port, log_tail: tail }
      }
      if (await _tcpProbe('127.0.0.1', port, 300)) {
        return { started: true, already_running: false, port, pid }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    // 超时
    const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const tail = raw.split('\n').slice(-40).join('\n')
    return { started: false, kind: 'timeout', port, pid, log_tail: tail }
  },

  async hermes_dashboard_stop() {
    const port = handlers._hermesDashboardPort()
    const cliStopped = handlers._hermesDashboardCliStop()
    if (!handlers._dashPid) {
      if (cliStopped) {
        for (let i = 0; i < 20; i++) {
          if (!await _tcpProbe('127.0.0.1', port, 200)) return true
          await new Promise(r => setTimeout(r, 250))
        }
        return true
      }
      return false
    }
    try {
      if (isWindows) {
        spawnSync('taskkill', ['/F', '/PID', String(handlers._dashPid)], { windowsHide: true })
      } else {
        process.kill(handlers._dashPid, 'SIGKILL')
      }
      handlers._dashPid = 0
      for (let i = 0; i < 20; i++) {
        if (!await _tcpProbe('127.0.0.1', port, 200)) return true
        await new Promise(r => setTimeout(r, 250))
      }
      return true
    } catch {
      handlers._dashPid = 0
      return cliStopped
    }
  },

  hermes_toolsets_list() {
    const r = runHermesSilent('hermes', ['tools', 'list', '--platform', 'cli'])
    return { raw: r.ok ? r.stdout : '' }
  },

  hermes_cron_jobs_list() {
    const jobsPath = path.join(hermesHome(), 'cron', 'jobs.json')
    if (!fs.existsSync(jobsPath)) return []
    return JSON.parse(fs.readFileSync(jobsPath, 'utf8'))
  },

  async hermes_fetch_models({ baseUrl, apiKey, apiType, provider: _provider } = {}) {
    const api = apiType || 'openai'
    let base = baseUrl.replace(/\/+$/, '')
    for (const suffix of ['/chat/completions', '/completions', '/responses', '/messages', '/models']) {
      if (base.endsWith(suffix)) base = base.slice(0, -suffix.length)
    }
    const headers = { 'User-Agent': 'ClawPanel-Web' }
    let url
    if (api.includes('anthropic')) {
      if (!base.endsWith('/v1')) base += '/v1'
      url = `${base}/models`
      headers['anthropic-version'] = '2023-06-01'
      headers['x-api-key'] = apiKey
    } else if (api.includes('google')) {
      url = `${base}/models?key=${apiKey}`
    } else {
      url = `${base}/models`
      headers['Authorization'] = `Bearer ${apiKey}`
    }
    const resp = await globalThis.fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (!resp.ok) { const t = await resp.text(); throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`) }
    const data = await resp.json()
    let models
    if (api.includes('google')) {
      models = (data.models || []).map(m => (m.name || '').replace('models/', '')).filter(Boolean)
    } else {
      models = (data.data || []).map(m => m.id).filter(Boolean)
    }
    return models.sort()
  },

  hermes_update_model({ model, provider } = {}) {
    const configPath = path.join(hermesHome(), 'config.yaml')
    const content = fs.readFileSync(configPath, 'utf8')
    const lines = content.split('\n')
    const out = []
    let inModel = false
    let defaultWritten = false
    let providerWritten = false
    let defaultIndent = '  '

    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('model:')) {
        inModel = true
        out.push(line)
        continue
      }
      if (inModel) {
        const isIndented = line.startsWith('  ') || line.startsWith('\t')
        if (!isIndented && t && !t.startsWith('#')) {
          // leaving model block — flush provider if needed
          if (provider && provider !== 'custom' && !providerWritten) {
            out.push(`${defaultIndent}provider: ${provider}`)
            providerWritten = true
          }
          inModel = false
          out.push(line)
          continue
        }
        if (t.startsWith('default:')) {
          const indentLen = line.length - line.trimStart().length
          defaultIndent = ' '.repeat(indentLen)
          out.push(`${defaultIndent}default: ${model}`)
          defaultWritten = true
          continue
        }
        if (t.startsWith('provider:')) {
          if (provider && provider !== 'custom') {
            const indentLen = line.length - line.trimStart().length
            out.push(`${' '.repeat(indentLen)}provider: ${provider}`)
            providerWritten = true
            continue
          }
          if (provider === 'custom') continue  // drop
          // no new provider → keep old
          out.push(line)
          providerWritten = true
          continue
        }
      }
      out.push(line)
    }

    // still in model block at EOF
    if (inModel && provider && provider !== 'custom' && !providerWritten) {
      out.push(`${defaultIndent}provider: ${provider}`)
    }

    if (!defaultWritten) throw new Error('config.yaml 中未找到 model.default 字段')

    let newContent = out.join('\n')
    if (!newContent.endsWith('\n')) newContent += '\n'
    fs.writeFileSync(configPath, newContent)
    return `模型已切换为 ${model}`
  },

  async hermes_detect_environments() {
    const result = { wsl2: { available: false }, docker: { available: false } }
    // Docker
    const dockerR = runHermesSilent('docker', ['info', '--format', '{{.ServerVersion}}'])
    if (dockerR.ok) {
      result.docker.available = true
      result.docker.version = dockerR.stdout
    }
    return result
  },

  hermes_set_gateway_url({ url } = {}) {
    const cfg = readPanelConfig()
    if (!cfg.hermes || typeof cfg.hermes !== 'object') cfg.hermes = {}
    if (url && url.trim()) {
      cfg.hermes.gatewayUrl = url.trim()
    } else {
      delete cfg.hermes.gatewayUrl
    }
    if (!fs.existsSync(path.dirname(PANEL_CONFIG_PATH))) fs.mkdirSync(path.dirname(PANEL_CONFIG_PATH), { recursive: true })
    fs.writeFileSync(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2))
    return `Gateway URL 已设置: ${hermesGatewayUrl()}`
  },

  // =========================================================================
  // Hermes Sessions / Logs / Skills / Memory
  // =========================================================================

  hermes_sessions_list({ source, limit, profile } = {}) {
    const args = []
    if (profile) args.push('--profile', profile)
    args.push('sessions', 'export', '-')
    if (source) args.push('--source', source)
    const r = runHermesSilent('hermes', args)
    if (!r.ok) return []
    const sessions = []
    for (const line of r.stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t)
        // `started_at` may arrive as POSIX seconds from the Hermes CLI. Fall
        // back to parsing `created_at` as ISO8601 so the Usage view can group
        // sessions by day even on older Hermes builds.
        let startedAt = typeof obj.started_at === 'number' ? obj.started_at : 0
        if (!startedAt && obj.created_at) {
          const ms = Date.parse(obj.created_at)
          if (!Number.isNaN(ms)) startedAt = Math.floor(ms / 1000)
        }
        sessions.push({
          id: obj.session_id || obj.id || '',
          title: obj.title || obj.name || '',
          source: obj.source || '',
          model: obj.model || '',
          created_at: obj.created_at || obj.createdAt || '',
          updated_at: obj.updated_at || obj.updatedAt || '',
          message_count: obj.message_count || (obj.messages ? obj.messages.length : 0),
          // Usage analytics fields (match Rust backend shape).
          started_at: startedAt,
          input_tokens: Number(obj.input_tokens || 0),
          output_tokens: Number(obj.output_tokens || 0),
          cache_read_tokens: Number(obj.cache_read_tokens || 0),
          cache_write_tokens: Number(obj.cache_write_tokens || 0),
          estimated_cost_usd: typeof obj.estimated_cost_usd === 'number' ? obj.estimated_cost_usd : null,
          actual_cost_usd: typeof obj.actual_cost_usd === 'number' ? obj.actual_cost_usd : null,
        })
      } catch {}
    }
    sessions.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (limit && limit > 0) return sessions.slice(0, limit)
    return sessions
  },

  hermes_sessions_summary_list({ source, limit, profile } = {}) {
    const lim = Math.max(1, Math.min(Number(limit || 80), 500))
    const args = []
    if (profile) args.push('--profile', profile)
    args.push('sessions', 'list', '--limit', String(lim))
    if (source) args.push('--source', source)
    const r = runHermesSilent('hermes', args)
    if (!r.ok) return []
    const sessions = []
    let hasTitles = false
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'No sessions found.' || trimmed.startsWith('─')) continue
      if (trimmed.includes('Title') && trimmed.includes('Preview') && trimmed.includes('ID')) { hasTitles = true; continue }
      if (trimmed.includes('Preview') && trimmed.includes('Last Active') && trimmed.includes('ID')) { hasTitles = false; continue }
      const cols = trimmed.split(/\s{2,}/).filter(Boolean)
      if (cols.length < 3) continue
      const id = cols[cols.length - 1]
      if (!id) continue
      if (hasTitles) {
        sessions.push({
          id,
          title: cols[0] === '—' ? '' : cols[0],
          source: source || '',
          model: '',
          created_at: '',
          updated_at: '',
          last_active_label: cols[2] || '',
          preview: cols[1] || '',
          message_count: 0,
          input_tokens: 0,
          output_tokens: 0,
        })
      } else {
        sessions.push({
          id,
          title: '',
          source: cols[2] || source || '',
          model: '',
          created_at: '',
          updated_at: '',
          last_active_label: cols[1] || '',
          preview: cols[0] || '',
          message_count: 0,
          input_tokens: 0,
          output_tokens: 0,
        })
      }
    }
    return sessions
  },

  async hermes_usage_analytics({ days = 30, profile } = {}) {
    days = Math.max(1, Math.min(Number(days || 30), 365))
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400
    const sessions = await handlers.hermes_sessions_list({ profile })
    const daily = new Map()
    const byModel = new Map()
    const totals = {
      total_input: 0,
      total_output: 0,
      total_cache_read: 0,
      total_cache_write: 0,
      total_estimated_cost: 0,
      total_actual_cost: 0,
      total_sessions: 0,
      total_api_calls: 0,
    }
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const started = Number(s.started_at || 0)
      if (started > 0 && started < cutoff) continue
      const input = Number(s.input_tokens || 0)
      const output = Number(s.output_tokens || 0)
      const cacheRead = Number(s.cache_read_tokens || 0)
      const cacheWrite = Number(s.cache_write_tokens || 0)
      const estimated = Number(s.estimated_cost_usd || 0)
      const actual = Number(s.actual_cost_usd || 0)
      totals.total_input += input
      totals.total_output += output
      totals.total_cache_read += cacheRead
      totals.total_cache_write += cacheWrite
      totals.total_estimated_cost += estimated
      totals.total_actual_cost += actual
      totals.total_sessions += 1
      const day = started > 0 ? new Date(started * 1000).toISOString().slice(0, 10) : 'unknown'
      if (!daily.has(day)) daily.set(day, { day, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated_cost: 0, actual_cost: 0, sessions: 0 })
      const d = daily.get(day)
      d.input_tokens += input
      d.output_tokens += output
      d.cache_read_tokens += cacheRead
      d.estimated_cost += estimated
      d.actual_cost += actual
      d.sessions += 1
      const model = s.model || ''
      if (model) {
        if (!byModel.has(model)) byModel.set(model, { model, input_tokens: 0, output_tokens: 0, estimated_cost: 0, sessions: 0 })
        const m = byModel.get(model)
        m.input_tokens += input
        m.output_tokens += output
        m.estimated_cost += estimated
        m.sessions += 1
      }
    }
    return {
      daily: [...daily.values()],
      by_model: [...byModel.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
      totals,
      period_days: days,
      skills: {
        summary: { total_skill_loads: 0, total_skill_edits: 0, total_skill_actions: 0, distinct_skills_used: 0 },
        top_skills: [],
      },
    }
  },

  hermes_session_detail({ sessionId, profile } = {}) {
    if (!sessionId) throw new Error('sessionId is required')
    const args = []
    if (profile) args.push('--profile', profile)
    args.push('sessions', 'export', '-', '--session-id', sessionId)
    const r = runHermesSilent('hermes', args)
    if (!r.ok) throw new Error('Failed to read sessions')
    for (const line of r.stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t)
        if ((obj.session_id || obj.id) === sessionId) {
          return {
            id: obj.session_id || obj.id,
            title: obj.title || obj.name || '',
            source: obj.source || '',
            model: obj.model || '',
            created_at: obj.created_at || '',
            messages: (obj.messages || []).map(m => ({
              role: m.role || '',
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
              timestamp: m.timestamp || m.created_at || '',
            })),
          }
        }
      } catch {}
    }
    throw new Error('Session not found')
  },

  hermes_session_delete({ sessionId, profile } = {}) {
    if (!sessionId) throw new Error('sessionId is required')
    const args = []
    if (profile) args.push('--profile', profile)
    args.push('sessions', 'delete', sessionId, '--yes')
    const r = runHermesSilent('hermes', args)
    if (!r.ok) throw new Error(`Failed to delete session: ${r.stderr || 'unknown error'}`)
    return 'ok'
  },

  hermes_session_rename({ sessionId, title, profile } = {}) {
    if (!sessionId || !title) throw new Error('sessionId and title are required')
    const args = []
    if (profile) args.push('--profile', profile)
    args.push('sessions', 'rename', sessionId, title)
    const r = runHermesSilent('hermes', args)
    if (!r.ok) throw new Error(`Failed to rename session: ${r.stderr || 'unknown error'}`)
    return 'ok'
  },

  hermes_profiles_list() {
    const r = runHermesSilent('hermes', ['profile', 'list'])
    if (!r.ok) return { active: 'default', profiles: [] }
    let active = 'default'
    const profiles = []
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.includes('Profile') || trimmed.startsWith('─') || trimmed.startsWith('-')) continue
      const isActive = trimmed.startsWith('◆')
      const row = trimmed.replace(/^◆/, '').trim()
      const parts = row.split(/\s+/)
      if (parts.length < 3) continue
      const name = parts[0]
      if (name !== 'default' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue
      const gatewayIdx = parts.findIndex(p => p === 'running' || p === 'stopped')
      if (gatewayIdx <= 1) continue
      const model = parts.slice(1, gatewayIdx).join(' ')
      const alias = parts[gatewayIdx + 1] || ''
      if (isActive) active = name
      profiles.push({
        name,
        active: isActive,
        model: model === '—' ? '' : model,
        gatewayRunning: parts[gatewayIdx] === 'running',
        alias: alias === '—' ? '' : alias,
      })
    }
    if (!profiles.some(p => p.active)) {
      const d = profiles.find(p => p.name === 'default')
      if (d) d.active = true
    }
    return { active, profiles }
  },

  hermes_profile_use({ name } = {}) {
    if (!name) throw new Error('name is required')
    const r = runHermesSilent('hermes', ['profile', 'use', name])
    if (!r.ok) throw new Error(`Failed to switch profile: ${r.stderr || 'unknown error'}`)
    return 'ok'
  },

  hermes_logs_list() {
    const r = runHermesSilent('hermes', ['logs', 'list'])
    if (!r.ok) {
      // Fallback: read log files from ~/.hermes/logs/
      const logsDir = path.join(hermesHome(), 'logs')
      if (!fs.existsSync(logsDir)) return []
      try {
        return fs.readdirSync(logsDir)
          .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
          .map(f => {
            const stat = fs.statSync(path.join(logsDir, f))
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() }
          })
          .sort((a, b) => b.modified.localeCompare(a.modified))
      } catch { return [] }
    }
    // Parse CLI output
    const files = []
    for (const line of r.stdout.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('─') || t.startsWith('Name') || t.startsWith('=')) continue
      const parts = t.split(/\s{2,}/)
      if (parts.length >= 1) files.push({ name: parts[0], size: parts[1] || '', modified: parts[2] || '' })
    }
    return files
  },

  hermes_logs_read({ name, lines = 200, level } = {}) {
    if (!name) throw new Error('log file name is required')
    const args = ['logs', name, '-n', String(lines)]
    if (level) args.push('--level', level)
    const r = runHermesSilent('hermes', args)
    if (!r.ok) {
      // Fallback: direct file read
      const logPath = path.join(hermesHome(), 'logs', name)
      if (!fs.existsSync(logPath)) throw new Error(`Log file not found: ${name}`)
      const content = fs.readFileSync(logPath, 'utf8')
      const allLines = content.split('\n')
      const tail = allLines.slice(-lines)
      return tail.map(line => {
        const m = line.match(/^(\S+\s+\S+)\s+(\w+)\s+(.*)/)
        return m ? { timestamp: m[1], level: m[2], message: m[3], raw: line } : { raw: line }
      }).filter(e => e.raw.trim())
    }
    return r.stdout.split('\n').filter(l => l.trim()).map(line => {
      const m = line.match(/^(\S+\s+\S+)\s+(\w+)\s+(.*)/)
      return m ? { timestamp: m[1], level: m[2], message: m[3], raw: line } : { raw: line }
    })
  },

  // 解析 ~/.hermes/config.yaml 中 `skills.disabled` 列表（与 Rust 端
  // commands/hermes.rs:read_disabled_skills 同语义；缩进感知）
  _readHermesDisabledSkills() {
    const configPath = path.join(hermesHome(), 'config.yaml')
    if (!fs.existsSync(configPath)) return []
    let raw
    try { raw = fs.readFileSync(configPath, 'utf8') } catch { return [] }
    const out = []
    let inSkills = false
    let inDisabled = false
    for (let line of raw.split('\n')) {
      // 去掉行内注释
      const hash = line.indexOf('#')
      if (hash >= 0) line = line.slice(0, hash)
      const trimmedFull = line.replace(/\s+$/, '')
      if (!trimmedFull) continue
      const indent = trimmedFull.length - trimmedFull.trimStart().length
      const body = trimmedFull.trimStart()
      if (indent === 0) {
        inSkills = body.startsWith('skills:')
        inDisabled = false
      } else if (inSkills && indent === 2 && body.startsWith('disabled:')) {
        inDisabled = true
      } else if (inSkills && inDisabled && indent >= 4 && body.startsWith('- ')) {
        const name = body.replace(/^-\s+/, '').trim().replace(/^["']|["']$/g, '')
        if (name) out.push(name)
      }
    }
    return out
  },

  hermes_skills_list() {
    const skillsDir = path.join(hermesHome(), 'skills')
    if (!fs.existsSync(skillsDir)) return []
    const disabled = handlers._readHermesDisabledSkills()
    const isEnabled = (name) => !disabled.includes(name)

    const categories = []
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          const catDir = path.join(skillsDir, entry.name)
          // Category description from DESCRIPTION.md if present
          let catDesc = ''
          try {
            const dmPath = path.join(catDir, 'DESCRIPTION.md')
            if (fs.existsSync(dmPath)) {
              const raw = fs.readFileSync(dmPath, 'utf8')
              const heading = raw.match(/^#\s+(.+)/m)
              catDesc = (heading ? heading[1] : raw.trim().split('\n')[0] || '').trim().slice(0, 200)
            }
          } catch {}

          const skills = []
          for (const sub of fs.readdirSync(catDir, { withFileTypes: true })) {
            if (sub.name === 'DESCRIPTION.md') continue

            // v0.14.1 structured skill: SKILL.md inside a directory
            if (sub.isDirectory()) {
              const skillMd = path.join(catDir, sub.name, 'SKILL.md')
              if (!fs.existsSync(skillMd)) continue
              const content = fs.readFileSync(skillMd, 'utf8')
              const nameMatch = content.match(/^#\s+(.+)/m)
              const descMatch = content.match(/^[^#\n].{10,}/m)
              skills.push({
                file: sub.name,
                name: nameMatch ? nameMatch[1].trim() : sub.name,
                slug: sub.name,
                description: descMatch ? descMatch[0].trim().slice(0, 200) : '',
                path: skillMd,
                skill_dir: path.join(catDir, sub.name),
                isDir: true,
                enabled: isEnabled(sub.name),
              })
              continue
            }

            if (!sub.name.endsWith('.md')) continue
            const filePath = path.join(catDir, sub.name)
            const content = fs.readFileSync(filePath, 'utf8')
            const nameMatch = content.match(/^#\s+(.+)/m)
            const descMatch = content.match(/^[^#\n].{10,}/m)
            const slug = sub.name.replace(/\.md$/, '')
            skills.push({
              file: sub.name,
              name: nameMatch ? nameMatch[1].trim() : slug,
              slug,
              description: descMatch ? descMatch[0].trim().slice(0, 200) : '',
              path: filePath,
              isDir: false,
              enabled: isEnabled(slug),
            })
          }

          if (skills.length > 0) {
            skills.sort((a, b) => a.name.localeCompare(b.name))
            categories.push({ category: entry.name, description: catDesc, skills })
          }
        } else if (entry.name.endsWith('.md') && entry.name !== 'DESCRIPTION.md') {
          const filePath = path.join(skillsDir, entry.name)
          const content = fs.readFileSync(filePath, 'utf8')
          const nameMatch = content.match(/^#\s+(.+)/m)
          const slug = entry.name.replace(/\.md$/, '')
          categories.push({
            category: '_root',
            description: '',
            skills: [{
              file: entry.name,
              name: nameMatch ? nameMatch[1].trim() : slug,
              slug,
              description: '',
              path: filePath,
              isDir: false,
              enabled: isEnabled(slug),
            }],
          })
        }
      }
    } catch {}
    categories.sort((a, b) => a.category.localeCompare(b.category))
    return categories
  },

  hermes_skill_detail({ filePath } = {}) {
    if (!filePath) throw new Error('filePath is required')
    const skillsDir = path.join(hermesHome(), 'skills')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(skillsDir)) throw new Error('Access denied')
    if (!fs.existsSync(resolved)) throw new Error('Skill file not found')
    return fs.readFileSync(resolved, 'utf8')
  },

  hermes_skill_toggle({ name, enabled } = {}) {
    if (!name) throw new Error('Skill name is required')
    const configPath = path.join(hermesHome(), 'config.yaml')
    if (!fs.existsSync(configPath)) throw new Error('config.yaml not found')
    const raw = fs.readFileSync(configPath, 'utf8')
    // Backup
    const backup = path.join(hermesHome(), `config.yaml.bak-${Math.floor(Date.now() / 1000)}`)
    try { fs.writeFileSync(backup, raw) } catch {}
    const patched = patchHermesYamlToggleSkill(raw, name, !!enabled)
    fs.writeFileSync(configPath, patched)
    return { ok: true, skill: name, enabled: !!enabled, backup }
  },

  hermes_skill_files({ category, skill } = {}) {
    if (!category || !skill) throw new Error('category and skill are required')
    const skillDir = path.join(hermesHome(), 'skills', category, skill)
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) return []
    const out = []
    const walk = (root, relBase) => {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (relBase === '' && entry.name === 'SKILL.md') continue
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name
        const full = path.join(root, entry.name)
        const isDir = entry.isDirectory()
        out.push({ path: rel, name: entry.name, isDir })
        if (isDir) walk(full, rel)
      }
    }
    walk(skillDir, '')
    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  },

  hermes_skill_write({ filePath, content } = {}) {
    if (!filePath) throw new Error('filePath is required')
    if (content == null) throw new Error('content is required')
    const skillsDir = path.join(hermesHome(), 'skills')
    const targetAbs = path.isAbsolute(filePath) ? filePath : path.join(skillsDir, filePath)
    const parent = path.dirname(targetAbs)
    fs.mkdirSync(parent, { recursive: true })
    const parentReal = fs.realpathSync(parent)
    const skillsReal = fs.realpathSync(skillsDir)
    if (!parentReal.startsWith(skillsReal)) throw new Error('Access denied')
    fs.writeFileSync(targetAbs, content, 'utf8')
    return 'ok'
  },

  hermes_memory_read({ type = 'memory' } = {}) {
    const home = hermesHome()
    const fileName = memoryFileName(type)
    if (!fileName) throw new Error(`Invalid memory kind '${type}' (expected memory|user|soul)`)
    const filePath = path.join(home, 'memories', fileName)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf8')
  },

  hermes_memory_write({ type = 'memory', content } = {}) {
    if (content == null) throw new Error('content is required')
    const home = hermesHome()
    const fileName = memoryFileName(type)
    if (!fileName) throw new Error(`Invalid memory kind '${type}' (expected memory|user|soul)`)
    const memDir = path.join(home, 'memories')
    fs.mkdirSync(memDir, { recursive: true })
    const filePath = path.join(memDir, fileName)
    fs.writeFileSync(filePath, content, 'utf8')
    return 'ok'
  },

  hermes_memory_read_all() {
    const home = hermesHome()
    const memDir = path.join(home, 'memories')
    const readSection = (kind) => {
      const name = memoryFileName(kind)
      if (!name) return ['', null]
      const p = path.join(memDir, name)
      if (!fs.existsSync(p)) return ['', null]
      const content = fs.readFileSync(p, 'utf8')
      const mtime = Math.floor(fs.statSync(p).mtimeMs / 1000)
      return [content, mtime]
    }
    const [memory, memory_mtime] = readSection('memory')
    const [user, user_mtime] = readSection('user')
    const [soul, soul_mtime] = readSection('soul')
    return { memory, user, soul, memory_mtime, user_mtime, soul_mtime }
  },

  hermes_logs_download({ name, saveToDisk = false } = {}) {
    if (!name) throw new Error('log file name is required')
    // Reject traversal (mirror the Rust-side check)
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new Error('Invalid log file name')
    }
    const logsDir = path.join(hermesHome(), 'logs')
    const filePath = path.join(logsDir, name)
    const resolved = fs.realpathSync(filePath)
    const canonDir = fs.realpathSync(logsDir)
    if (!resolved.startsWith(canonDir)) throw new Error('Access denied')
    const content = fs.readFileSync(resolved, 'utf8')
    if (!saveToDisk) return content
    const outDir = path.join(os.homedir(), 'Downloads', 'ClawPanel')
    fs.mkdirSync(outDir, { recursive: true })
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_')
    const outPath = path.join(outDir, safeName)
    fs.writeFileSync(outPath, content)
    return { path: outPath }
  },

  async update_hermes() {
    const uvPath = path.join(uvBinDir(), isWindows ? 'uv.exe' : 'uv')
    const uv = fs.existsSync(uvPath) ? uvPath : 'uv'
    const pkg = 'hermes-agent[web] @ git+https://github.com/NousResearch/hermes-agent.git'
    const result = spawnSync(uv, ['tool', 'install', '--reinstall', pkg, '--python', '3.11', '--with', 'croniter'], {
      env: { ...process.env, PATH: hermesEnhancedPath(), GIT_TERMINAL_PROMPT: '0', ...gitMirrorEnv() },
      timeout: 600000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) {
      const cleaned = sanitizeHermesInstallOutput((result.stderr || '').trim())
      const hint = diagnoseHermesInstallError(cleaned)
      if (hint) throw new Error(`升级失败: ${cleaned}\n\n${hint}`)
      throw new Error(`升级失败: ${cleaned}`)
    }
    return '升级完成'
  },

  async uninstall_hermes({ cleanConfig = false } = {}) {
    const uvPath = path.join(uvBinDir(), isWindows ? 'uv.exe' : 'uv')
    const uv = fs.existsSync(uvPath) ? uvPath : 'uv'
    const result = spawnSync(uv, ['tool', 'uninstall', 'hermes-agent'], {
      env: { ...process.env, PATH: hermesEnhancedPath() },
      timeout: 60000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) throw new Error(`卸载失败: ${(result.stderr || '').trim()}`)
    // 清理 venv
    const venvDir = path.join(homedir(), '.hermes-venv')
    if (fs.existsSync(venvDir)) fs.rmSync(venvDir, { recursive: true, force: true })
    if (cleanConfig) {
      const home = hermesHome()
      if (fs.existsSync(home)) fs.rmSync(home, { recursive: true, force: true })
    }
    return 'Hermes Agent 已卸载'
  },

  // ============================================================================
  // Web 模式兼容 stub —— 桌面专属或尚未移植的命令
  // ----------------------------------------------------------------------------
  // 返回安全默认值（避免 UI 报错）或抛出明确错误（仅在用户主动触发时显示）。
  // 这些命令的 Rust 端实现位于 src-tauri/src/commands/* ，移植后请删除对应 stub。
  // ============================================================================

  // —— 前端热更新（Tauri 桌面专属，浏览器刷新即得最新）——
  check_frontend_update() { return { hasUpdate: false } },
  download_frontend_update() { throw new Error('Web 模式无需前端热更新，刷新浏览器即可') },
  rollback_frontend_update() { throw new Error('Web 模式不支持前端热更新回滚') },
  get_update_status() { return { status: 'idle', mode: 'web' } },
  // 注意：check_panel_update 的真实实现在前面 —— 只走官网 API。
  // 这里不能再 stub，否则 object literal 的后定义会覆盖前者，导致 Web 模式永远看不到新版。

  // —— 应用重启（Web 端由 tauri-api.js 包装层直接调 location.reload，到这里说明绕过了包装）——
  relaunch_app() { throw new Error('Web 模式请直接刷新浏览器') },

  // —— Cloudflare Tunnel / ClawApp 安装（Tauri 桌面专属）——
  install_cftunnel() { throw new Error('Web 模式不支持安装 Cloudflare Tunnel，请使用桌面客户端') },
  cftunnel_action() { throw new Error('Web 模式不支持操作 Cloudflare Tunnel，请使用桌面客户端') },
  get_cftunnel_status() { return { installed: false, running: false, mode: 'web' } },
  get_cftunnel_logs() { return '' },
  install_clawapp() { throw new Error('Web 模式不支持安装 ClawApp 移动端，请使用桌面客户端') },
  get_clawapp_status() { return { installed: false, mode: 'web' } },

  // —— 渠道插件状态/操作（暂未在 Node 实现，先抛友好错误）——
  check_weixin_plugin_status() {
    // 静默返回未安装即可，UI 会显示"未安装"
    return { installed: false, version: null, plugin: null }
  },
  async diagnose_channel({ platform, accountId } = {}) {
    if (!platform || !String(platform).trim()) throw new Error('platform 不能为空')
    const platformId = String(platform).trim()
    const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''
    const storageKey = platformStorageKey(platformId)
    const cfg = readOpenclawConfigOptional()
    const channelRoot = cfg.channels?.[storageKey]
    const saved = handlers.read_platform_config({ platform: platformId, accountId: normalizedAccountId || null })
    const form = saved?.values || {}
    const configExists = !!saved?.exists
    const channelEnabled = !channelRoot || channelRoot.enabled !== false
    const credentialsReady = channelDiagnosisCredentialsReady(platformId, form)
    let verifyResult = null
    let verifyError = ''

    if (configExists && credentialsReady) {
      try {
        verifyResult = await handlers.verify_bot_token({ platform: platformId, form })
      } catch (e) {
        verifyError = e?.message || String(e)
      }
    }

    const result = buildOpenClawChannelDiagnosis({
      platform: platformId,
      accountId: normalizedAccountId,
      configExists,
      channelEnabled,
      form,
      verifyResult,
      verifyError,
    })
    if (storageKey === 'qqbot') {
      result.userHints = [
        'Web 模式已完成配置级检查；QQ 插件、Gateway TCP 和 chatCompletions 深度诊断需要在桌面客户端执行。',
        ...(result.userHints || []),
      ]
      result.faqUrl = 'https://q.qq.com/qqbot/openclaw/faq.html'
    }
    return result
  },
  run_channel_action() {
    throw new Error('Web 模式暂未实现渠道操作，请使用桌面客户端')
  },
  repair_qqbot_channel_setup() {
    throw new Error('Web 模式暂未实现 QQ Bot 自动修复，请使用桌面客户端')
  },

  // —— 系统体检（暂未在 Node 实现）——
  doctor_check() {
    return { success: false, output: '', errors: 'Web 模式暂未实现 openclaw doctor，请使用桌面客户端' }
  },
  doctor_fix() {
    return { success: false, output: '', errors: 'Web 模式暂未实现 openclaw doctor --fix，请使用桌面客户端' }
  },

  // —— 配置/Skills 校验（暂未在 Node 实现）——
  validate_openclaw_config() {
    // 至少做一次基本 JSON 形状校验
    try {
      const cfg = readOpenclawConfigOptional()
      if (!cfg || typeof cfg !== 'object') throw new Error('配置文件为空或格式错误')
      return { ok: true, warnings: [] }
    } catch (e) {
      return { ok: false, errors: [String(e?.message || e)] }
    }
  },
  skills_validate() {
    throw new Error('Web 模式暂未实现 Skills 校验，请使用桌面客户端')
  },
}

// Hermes 配置合并辅助函数
function _mergeHermesConfigYaml(existing, modelStr, baseUrlLine, providerLine = '') {
  const lines = existing.split('\n')
  const result = []
  let inModel = false, written = false, i = 0
  while (i < lines.length) {
    const line = lines[i], t = line.trim()
    if (t === 'model:' || t.startsWith('model:')) {
      inModel = true; written = true
      result.push('model:')
      result.push(`  default: ${modelStr}`)
      if (providerLine) result.push(providerLine.trimEnd())
      if (baseUrlLine) result.push(baseUrlLine.trimEnd())
      i++
      while (i < lines.length) {
        const next = lines[i], nt = next.trim()
        if (!nt) { i++; continue }
        if (next.startsWith('  ') || next.startsWith('\t')) { i++; continue }
        break
      }
      continue
    }
    if (inModel && t && !line.startsWith('  ') && !line.startsWith('\t')) inModel = false
    if (!inModel) result.push(line)
    i++
  }
  if (!written) {
    result.push('model:')
    result.push(`  default: ${modelStr}`)
    if (providerLine) result.push(providerLine.trimEnd())
    if (baseUrlLine) result.push(baseUrlLine.trimEnd())
  }
  let final = result.join('\n')
  if (!final.includes('platform_toolsets:')) final += '\nplatform_toolsets:\n  api_server:\n    - hermes-api-server\n'
  if (!final.includes('terminal:')) final += 'terminal:\n  backend: local\n'
  if (!final.includes('platforms:')) final += 'platforms:\n  api_server:\n    enabled: true\n'
  if (!final.endsWith('\n')) final += '\n'
  return final
}

function _mergeEnvFile(existing, managedKeys, newPairs) {
  const result = []
  for (const line of existing.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) { result.push(line); continue }
    const eq = t.indexOf('=')
    if (eq > 0 && managedKeys.includes(t.slice(0, eq).trim())) continue
    result.push(line)
  }
  for (const [k, v] of newPairs) result.push(`${k}=${v}`)
  let content = result.join('\n')
  if (!content.endsWith('\n')) content += '\n'
  return content
}

function _normalizeProviderUrl(raw) {
  let out = String(raw || '').trim().replace(/\/+$/, '').toLowerCase()
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/messages', '/models']) {
    if (out.endsWith(suffix)) {
      out = out.slice(0, -suffix.length)
      break
    }
  }
  return out
}

function _normalizeHermesProviderForBaseUrl(provider, baseUrl) {
  const pid = String(provider || '').trim()
  if (pid === 'openrouter') {
    const base = _normalizeProviderUrl(baseUrl)
    const expected = _normalizeProviderUrl('https://openrouter.ai/api/v1')
    if (base && base !== expected) return 'custom'
  }
  return pid
}

function _envHasValue(raw, key) {
  return String(raw || '').split('\n').some(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return false
    const eq = t.indexOf('=')
    return eq > 0 && t.slice(0, eq).trim() === key && t.slice(eq + 1).trim()
  })
}

function _envValue(raw, key) {
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0 && t.slice(0, eq).trim() === key) {
      const value = t.slice(eq + 1).trim()
      if (value) return value
    }
  }
  return ''
}

function _ensureCustomOpenAIKeyAlias() {
  const envPath = path.join(hermesHome(), '.env')
  if (!fs.existsSync(envPath)) return false
  let raw = fs.readFileSync(envPath, 'utf8')
  if (_envHasValue(raw, 'OPENAI_API_KEY')) return false
  const customKey = _envValue(raw, 'CUSTOM_API_KEY')
  if (!customKey) return false
  if (!raw.endsWith('\n')) raw += '\n'
  fs.writeFileSync(envPath, `${raw}OPENAI_API_KEY=${customKey}\n`)
  return true
}

function _sanitizeHermesOpenrouterCustomMismatch() {
  const home = hermesHome()
  const configPath = path.join(home, 'config.yaml')
  if (!fs.existsSync(configPath)) return false
  const raw = fs.readFileSync(configPath, 'utf8')
  let provider = ''
  let baseUrl = ''
  let inModel = false
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('model:')) { inModel = true; continue }
    if (inModel) {
      const indented = line.startsWith(' ') || line.startsWith('\t')
      if (!indented && t && !t.startsWith('#')) break
      if (t.startsWith('provider:')) provider = t.slice(9).trim().replace(/^['"]|['"]$/g, '')
      else if (t.startsWith('base_url:')) baseUrl = t.slice(9).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  const base = _normalizeProviderUrl(baseUrl)
  const expected = _normalizeProviderUrl('https://openrouter.ai/api/v1')
  const usesCustomEndpoint = base && base !== expected
  const aliasChanged = (!provider || provider === 'custom' || usesCustomEndpoint) ? _ensureCustomOpenAIKeyAlias() : false
  if (!usesCustomEndpoint) return aliasChanged
  if (provider === 'custom') return aliasChanged
  const out = []
  inModel = false
  let providerWritten = false
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('model:')) {
      inModel = true
      providerWritten = false
      out.push(line)
      continue
    }
    if (inModel) {
      const indented = line.startsWith(' ') || line.startsWith('\t')
      if (!indented && t && !t.startsWith('#')) {
        inModel = false
        if (!providerWritten) {
          out.push('  provider: custom')
          providerWritten = true
        }
      }
      else if (t.startsWith('provider:')) {
        out.push('  provider: custom')
        providerWritten = true
        continue
      }
    }
    out.push(line)
  }
  if (inModel && !providerWritten) out.push('  provider: custom')
  let fixed = out.join('\n')
  if (!fixed.endsWith('\n')) fixed += '\n'
  fs.writeFileSync(configPath, fixed)
  return true
}

function _tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = new net.Socket()
    sock.setTimeout(timeoutMs)
    sock.connect(port, host, () => { sock.destroy(); resolve(true) })
    sock.on('error', () => { sock.destroy(); resolve(false) })
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
  })
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

function _readHermesApiServerKey() {
  try {
    const envContent = fs.readFileSync(path.join(hermesHome(), '.env'), 'utf8')
    const m = envContent.match(/^API_SERVER_KEY=(.+)$/m)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

function _writeStreamEvent(res, event) {
  if (res.writableEnded || res.destroyed) return
  res.write(JSON.stringify(event) + '\n')
}

function _endStream(res) {
  if (!res.writableEnded && !res.destroyed) res.end()
}

function _startHermesNdjsonStream(res) {
  if (res.headersSent) return
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function _hermesStreamHeaders(apiKey, json = false) {
  const headers = { 'User-Agent': 'ClawPanel-Web' }
  if (json) headers['Content-Type'] = 'application/json'
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function _hermesTextFromResponse(value) {
  const response = value?.response || value
  if (typeof response?.output_text === 'string') return response.output_text
  if (typeof response?.text === 'string') return response.text
  let out = ''
  const outputs = Array.isArray(response?.output) ? response.output : []
  for (const item of outputs) {
    const parts = Array.isArray(item?.content) ? item.content : []
    for (const part of parts) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') {
        out += part.text
      }
    }
  }
  return out
}

function _hermesDeltaFromResponseEvent(evt) {
  if (typeof evt?.delta === 'string') return evt.delta
  if (typeof evt?.text === 'string') return evt.text
  if (typeof evt?.content === 'string') return evt.content
  if (typeof evt?.delta?.text === 'string') return evt.delta.text
  if (typeof evt?.delta?.value === 'string') return evt.delta.value
  return ''
}

function _normalizeHermesStreamEvent(evt, runId, sessionId) {
  const eventType = evt?.event || evt?.type || ''
  if (!eventType) return null
  if (eventType === 'message.delta') return { ...evt, run_id: evt.run_id || runId, session_id: evt.session_id || sessionId || null }
  if (eventType === 'run.completed' || eventType === 'run.failed') return { ...evt, run_id: evt.run_id || runId, session_id: evt.session_id || sessionId || null }
  if (eventType === 'tool.started' || eventType === 'tool.completed' || eventType === 'tool.progress' || eventType === 'tool.error') {
    return { ...evt, run_id: evt.run_id || runId, session_id: evt.session_id || sessionId || null }
  }
  if (eventType === 'response.output_text.delta' || eventType === 'response.text.delta') {
    const delta = _hermesDeltaFromResponseEvent(evt)
    return delta ? { event: 'message.delta', run_id: runId, session_id: sessionId || null, delta } : null
  }
  if (eventType === 'response.output_item.added') {
    const item = evt.item || evt.output_item || {}
    if (item.type === 'function_call' || item.type === 'tool_call') {
      return { event: 'tool.started', run_id: runId, session_id: sessionId || null, tool: item.name || item.function?.name || 'tool', input: item.arguments || item.input || null }
    }
  }
  if (eventType === 'response.function_call_arguments.delta') {
    return { event: 'tool.progress', run_id: runId, session_id: sessionId || null, tool: evt.name || evt.item?.name || 'tool', preview: _hermesDeltaFromResponseEvent(evt) }
  }
  if (eventType === 'response.output_item.done' || eventType === 'response.function_call_arguments.done') {
    const item = evt.item || evt.output_item || {}
    if (item.type === 'function_call' || item.type === 'tool_call' || eventType === 'response.function_call_arguments.done') {
      return { event: 'tool.completed', run_id: runId, session_id: sessionId || null, tool: item.name || evt.name || 'tool', input: item.arguments || evt.arguments || null }
    }
  }
  if (eventType === 'response.completed') {
    return { event: 'run.completed', run_id: runId, session_id: sessionId || null, output: _hermesTextFromResponse(evt) }
  }
  if (eventType === 'response.failed' || eventType === 'response.error') {
    const error = evt.error?.message || evt.error || evt.message || 'unknown error'
    return { event: 'run.failed', run_id: runId, session_id: sessionId || null, error }
  }
  return { ...evt, event: eventType, run_id: evt.run_id || runId, session_id: evt.session_id || sessionId || null }
}

async function _streamHermesEventBody(streamResp, res, args, runId) {
  const sessionId = args.sessionId || null
  const reader = streamResp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalOutput = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        let data = ''
        if (line.startsWith('data:')) data = line.slice(5).trim()
        else if (line.startsWith('{')) data = line
        else continue
        if (!data || data === '[DONE]') {
          _writeStreamEvent(res, { event: 'run.completed', run_id: runId, output: finalOutput, session_id: sessionId })
          _endStream(res)
          return true
        }
        let evt
        try { evt = JSON.parse(data) } catch { continue }
        const normalized = _normalizeHermesStreamEvent(evt, runId, sessionId)
        if (!normalized) continue
        if (normalized.event === 'message.delta' && typeof normalized.delta === 'string') finalOutput += normalized.delta
        if (normalized.event === 'run.completed' && typeof normalized.output === 'string') finalOutput = normalized.output || finalOutput
        _writeStreamEvent(res, normalized)
        if (normalized.event === 'run.completed' || normalized.event === 'run.failed') {
          _endStream(res)
          return true
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  _writeStreamEvent(res, { event: 'run.completed', run_id: runId, output: finalOutput, session_id: sessionId })
  _endStream(res)
  return true
}

async function _tryHermesResponsesStream(gwUrl, apiKey, payload, args, controller, res) {
  const responsePayload = { ...payload, stream: true }
  const resp = await globalThis.fetch(`${gwUrl}/v1/responses`, {
    method: 'POST',
    headers: _hermesStreamHeaders(apiKey, true),
    body: JSON.stringify(responsePayload),
    signal: controller.signal,
  })
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      const text = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${text}`)
    }
    try { await resp.body?.cancel() } catch {}
    return false
  }
  const runId = resp.headers.get('x-request-id') || resp.headers.get('x-response-id') || `response-${Date.now()}`
  _startHermesNdjsonStream(res)
  _writeStreamEvent(res, { event: 'run.started', run_id: runId, session_id: args.sessionId || null })
  const contentType = (resp.headers.get('content-type') || '').toLowerCase()
  if (resp.body && !contentType.includes('application/json')) return await _streamHermesEventBody(resp, res, args, runId)
  const body = await resp.json().catch(() => ({}))
  const output = _hermesTextFromResponse(body)
  _writeStreamEvent(res, { event: 'run.completed', run_id: body.id || runId, output, session_id: args.sessionId || null })
  _endStream(res)
  return true
}

async function _handleHermesAgentRunStream(req, res, args = {}) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let runId = ''
  let finalOutput = ''
  try {
    const gwUrl = hermesGatewayUrl()
    await handlers._hermesEnsureGatewayReady()
    const apiKey = _readHermesApiServerKey()
    const headers = _hermesStreamHeaders(apiKey, true)

    const payload = { input: args.input || '' }
    if (args.sessionId) payload.session_id = args.sessionId
    if (args.conversationHistory) payload.conversation_history = args.conversationHistory
    if (args.instructions) payload.instructions = args.instructions

    // 优先 /v1/runs：支持 body.session_id 复用，避免 Hermes session 暴增（#275）。
    // /v1/responses 上游强制每次生成新 UUID 作 session id，只作为老版本兼容的 fallback。
    const startedResp = await globalThis.fetch(`${gwUrl}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!startedResp.ok) {
      // 404 → 老版本 Hermes Agent 没 /v1/runs，降级 /v1/responses
      if (startedResp.status === 404) {
        try { await startedResp.body?.cancel() } catch {}
        const handledByResponses = await _tryHermesResponsesStream(gwUrl, apiKey, payload, args, controller, res)
        if (handledByResponses) return
        throw new Error('HTTP 404: /v1/runs 不存在，且 /v1/responses fallback 失败')
      }
      const text = await startedResp.text()
      throw new Error(`HTTP ${startedResp.status}: ${text}`)
    }
    const started = await startedResp.json()
    runId = started.run_id || started.id || ''
    if (!runId) throw new Error('响应中没有 run_id')

    _startHermesNdjsonStream(res)
    _writeStreamEvent(res, { event: 'run.started', run_id: runId, session_id: args.sessionId || null })

    const eventsResp = await globalThis.fetch(`${gwUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: _hermesStreamHeaders(apiKey),
      signal: controller.signal,
    })
    if (!eventsResp.ok || !eventsResp.body) {
      const text = await eventsResp.text().catch(() => '')
      throw new Error(`SSE HTTP ${eventsResp.status}: ${text}`)
    }

    const reader = eventsResp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') {
            _writeStreamEvent(res, { event: 'run.completed', run_id: runId, output: finalOutput, session_id: args.sessionId || null })
            _endStream(res)
            return
          }
          let evt
          try { evt = JSON.parse(data) } catch { continue }
          if (!evt.run_id) evt.run_id = runId
          if (!evt.session_id && args.sessionId) evt.session_id = args.sessionId
          if (evt.event === 'message.delta' && typeof evt.delta === 'string') finalOutput += evt.delta
          if (evt.event === 'run.completed' && typeof evt.output === 'string') finalOutput = evt.output
          _writeStreamEvent(res, evt)
          if (evt.event === 'run.completed' || evt.event === 'run.failed') {
            _endStream(res)
            return
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }

    _writeStreamEvent(res, { event: 'run.completed', run_id: runId, output: finalOutput, session_id: args.sessionId || null })
    _endStream(res)
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: e.message || String(e) }))
      return
    }
    _writeStreamEvent(res, {
      event: 'run.failed',
      run_id: runId || null,
      session_id: args.sessionId || null,
      error: e.name === 'AbortError' ? 'aborted' : (e.message || String(e)),
    })
    _endStream(res)
  }
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

  const activeInst = getActiveInstance()

  if (cmd === 'hermes_agent_run_stream') {
    const args = await readBody(req)
    if (activeInst.type !== 'local' && activeInst.endpoint && !ALWAYS_LOCAL.has(cmd)) {
      await proxyStreamToInstance(activeInst, cmd, args, req, res)
    } else {
      await _handleHermesAgentRunStream(req, res, args)
    }
    return
  }

  // --- 实例代理：非 ALWAYS_LOCAL 命令，活跃实例非本机时代理转发 ---
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
