/**
 * 全局应用状态
 * 管理 openclaw 安装状态，供各组件查询
 */
import { api } from './tauri-api.js'
import {
  evaluateAutoRestartAttempt,
  shouldResetAutoRestartCount,
} from './gateway-guardian-policy.js'

const isTauri = !!window.__TAURI_INTERNALS__

let _openclawReady = false
let _gatewayRunning = false
let _platform = ''  // 'macos' | 'win32' | ...
let _deployMode = 'local' // 'local' | 'docker'
let _inDocker = false
let _dockerAvailable = false
let _listeners = []
let _gwListeners = []
let _gwStopCount = 0  // 连续检测到"停止"的次数，防抖用
let _isUpgrading = false // 升级/切换版本期间，阻止 setup 跳转
let _userStopped = false // 用户主动停止，不自动拉起
let _autoRestartCount = 0 // 自动重启次数
let _lastRestartTime = 0  // 上次重启时间
let _gatewayRunningSince = 0 // Gateway 最近一次进入稳定运行状态的时间
let _guardianListeners = [] // 守护放弃时的回调

/** openclaw 是否就绪（CLI 已安装 + 配置文件存在） */
export function isOpenclawReady() {
  // 升级期间视为就绪，避免跳转到 setup
  if (_isUpgrading) return true
  return _openclawReady
}

/** 标记升级中（阻止 setup 跳转） */
export function setUpgrading(v) { _isUpgrading = !!v }
export function isUpgrading() { return _isUpgrading }

/** 标记用户主动停止 Gateway（不触发自动重启） */
export function setUserStopped(v) { _userStopped = !!v }

/** 重置自动重启计数（用户手动启动后重置） */
export function resetAutoRestart() {
  _autoRestartCount = 0
  _lastRestartTime = 0
  _gatewayRunningSince = 0
  _userStopped = false
}

/** 监听守护放弃事件（连续重启失败后触发，UI 可弹出恢复选项） */
export function onGuardianGiveUp(fn) {
  _guardianListeners.push(fn)
  return () => { _guardianListeners = _guardianListeners.filter(cb => cb !== fn) }
}

/** Gateway 是否正在运行 */
export function isGatewayRunning() {
  return _gatewayRunning
}

/** 获取后端平台 ('macos' | 'win32') */
export function getPlatform() {
  return _platform
}
export function isMacPlatform() {
  return _platform === 'macos'
}

/** 部署模式 */
export function getDeployMode() { return _deployMode }
export function isInDocker() { return _inDocker }
export function isDockerAvailable() { return _dockerAvailable }

/** 实例管理 */
let _activeInstance = { id: 'local', name: '本机', type: 'local' }
let _instanceListeners = []

export function getActiveInstance() { return _activeInstance }
export function isLocalInstance() { return _activeInstance.type === 'local' }

export function onInstanceChange(fn) {
  _instanceListeners.push(fn)
  return () => { _instanceListeners = _instanceListeners.filter(cb => cb !== fn) }
}

export async function switchInstance(id) {
  // instanceSetActive 内部已调用 _cache.clear()，切换后所有缓存自动失效
  await api.instanceSetActive(id)
  const data = await api.instanceList()
  _activeInstance = data.instances.find(i => i.id === id) || data.instances[0]
  _instanceListeners.forEach(fn => { try { fn(_activeInstance) } catch {} })
}

export async function loadActiveInstance() {
  try {
    const data = await api.instanceList()
    _activeInstance = data.instances.find(i => i.id === data.activeId) || data.instances[0]
  } catch {
    _activeInstance = { id: 'local', name: '本机', type: 'local' }
  }
}

/** 监听 Gateway 状态变化 */
export function onGatewayChange(fn) {
  _gwListeners.push(fn)
  return () => { _gwListeners = _gwListeners.filter(cb => cb !== fn) }
}

/** 检测 openclaw 安装状态 */
export async function detectOpenclawStatus() {
  try {
    const [installation, services] = await Promise.allSettled([
      api.checkInstallation(),
      api.getServicesStatus(),
    ])
    const configExists = installation.status === 'fulfilled' && installation.value?.installed
    if (installation.status === 'fulfilled' && installation.value?.platform) {
      _platform = installation.value.platform
    }
    if (installation.status === 'fulfilled' && installation.value?.inDocker) {
      _inDocker = true
      _deployMode = 'docker'
    }
    const cliInstalled = services.status === 'fulfilled'
      && services.value?.length > 0
      && services.value[0]?.cli_installed !== false
    _openclawReady = configExists && cliInstalled

    // 顺便检测 Gateway 运行状态
    if (services.status === 'fulfilled' && services.value?.length > 0) {
      _setGatewayRunning(services.value[0]?.running === true)
    }
  } catch {
    _openclawReady = false
  }
  _listeners.forEach(fn => { try { fn(_openclawReady) } catch {} })
  return _openclawReady
}

function _setGatewayRunning(val) {
  const wasRunning = _gatewayRunning
  const changed = wasRunning !== val
  _gatewayRunning = val
  if (changed) {
    if (val) {
      // 仅记录恢复运行时间，避免短暂存活就把重启计数清零
      _gatewayRunningSince = Date.now()
    } else if (!isTauri && wasRunning && !_userStopped && !_isUpgrading && _openclawReady) {
      _gatewayRunningSince = 0
      // Gateway 意外停止，尝试自动重启
      _tryAutoRestart()
    } else if (!val) {
      _gatewayRunningSince = 0
    }
    _gwListeners.forEach(fn => { try { fn(val) } catch {} })
  }
}

async function _tryAutoRestart() {
  const now = Date.now()
  const decision = evaluateAutoRestartAttempt({
    now,
    lastRestartTime: _lastRestartTime,
    autoRestartCount: _autoRestartCount,
  })

  if (decision.action === 'cooldown') return

  if (decision.action === 'give_up') {
    console.warn('[guardian] Gateway 已达到自动重启上限，停止守护，请手动检查')
    _guardianListeners.forEach(fn => { try { fn() } catch {} })
    return
  }

  _autoRestartCount = decision.autoRestartCount
  _lastRestartTime = decision.lastRestartTime
  console.log(`[guardian] Gateway 意外停止，自动重启 (${_autoRestartCount}/3)...`)
  try {
    await api.startService('ai.openclaw.gateway')
    console.log('[guardian] Gateway 自动重启成功')
  } catch (e) {
    console.error('[guardian] Gateway 自动重启失败:', e)
  }
}

/** 刷新 Gateway 运行状态（轻量，仅查服务状态）
 *  防抖：running→stopped 需要连续 2 次检测才切换，避免瞬态误判 */
export async function refreshGatewayStatus() {
  try {
    const services = await api.getServicesStatus()
    if (services?.length > 0) {
      const nowRunning = services[0]?.running === true
      if (nowRunning) {
        _gwStopCount = 0
        if (!_gatewayRunning) {
          _setGatewayRunning(true)
        } else if (shouldResetAutoRestartCount({
          autoRestartCount: _autoRestartCount,
          runningSince: _gatewayRunningSince,
          now: Date.now(),
        })) {
          _autoRestartCount = 0
        }
      } else {
        _gwStopCount++
        if (_gwStopCount >= 2 || !_gatewayRunning) {
          _setGatewayRunning(false)
        }
      }
    }
  } catch {
    _gwStopCount++
    if (_gwStopCount >= 2) _setGatewayRunning(false)
  }
  return _gatewayRunning
}

let _pollTimer = null
/** 启动 Gateway 状态轮询（每 15 秒，避免过于频繁） */
export function startGatewayPoll() {
  if (_pollTimer) return
  _pollTimer = setInterval(() => refreshGatewayStatus(), 30000)
}
export function stopGatewayPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

/** 监听状态变化 */
export function onReadyChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}
