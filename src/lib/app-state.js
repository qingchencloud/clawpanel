/**
 * 全局应用状态
 * 管理 openclaw 安装状态，供各组件查询
 */
import { api } from './tauri-api.js'

const isTauri = false

let _openclawReady = false
let _gatewayRunning = false
let _gatewayForeign = false
let _platform = ''  // 'macos' | 'win32' | ...
let _deployMode = 'local' // 'local' | 'docker'
let _inDocker = false
let _dockerAvailable = false
let _listeners = []
let _gwListeners = []
let _gwStopCount = 0  // 连续检测到"停止"的次数，防抖用
let _isUpgrading = false // 升级/切换版本期间，阻止 setup 跳转
let _userStopped = false // 用户主动停止，不自动拉起
let _gatewayRunningSince = 0 // Gateway 最近一次进入稳定运行状态的时间
let _guardianListeners = [] // 守护放弃时的回调（后端 guardian-event 触发）
let _statusStream = null

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

/** 重置守护状态（用户手动启动后重置） */
export function resetAutoRestart() {
  _gatewayRunningSince = 0
  _userStopped = false
}

/** 监听守护放弃事件（连续重启失败后触发，UI 可弹出恢复选项） */
export function onGuardianGiveUp(fn) {
  _guardianListeners.push(fn)
  return () => { _guardianListeners = _guardianListeners.filter(cb => cb !== fn) }
}

/** Gateway 是否正在运行（仅 owned） */
export function isGatewayRunning() {
  return _gatewayRunning
}

/** Gateway 是否在运行但属于外部实例 */
export function isGatewayForeign() {
  return _gatewayForeign
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
      const gw = services.value.find?.(s => s.label === 'ai.openclaw.gateway') || services.value[0]
      const foreign = gw?.running === true && gw?.owned_by_current_instance === false
      _setGatewayRunning(gw?.running === true && !foreign, foreign)
    }
  } catch {
    _openclawReady = false
  }
  _listeners.forEach(fn => { try { fn(_openclawReady) } catch {} })
  return _openclawReady
}

function _setGatewayRunning(val, foreign = false) {
  const wasRunning = _gatewayRunning
  const wasForeign = _gatewayForeign
  const changed = wasRunning !== val || wasForeign !== foreign
  _gatewayRunning = val
  _gatewayForeign = foreign
  if (changed) {
    if (val) {
      // 仅记录恢复运行时间，避免短暂存活就把重启计数清零
      _gatewayRunningSince = Date.now()
    } else if (wasRunning && !_userStopped && !_isUpgrading && _openclawReady && !foreign) {
      _gatewayRunningSince = 0
      // Gateway 意外停止 → 后端 Rust guardian 负责自动重启，前端仅更新 UI 状态
      console.log('[app-state] Gateway 意外停止，等待后端 guardian 重启...')
    } else if (!val) {
      _gatewayRunningSince = 0
    }
    _gwListeners.forEach(fn => { try { fn(val, foreign) } catch {} })
  }
}

function _applyGatewayServices(services) {
  try {
    if (services?.length > 0) {
      const gw = services.find?.(s => s.label === 'ai.openclaw.gateway') || services[0]
      const ownedRunning = gw?.running === true && gw?.owned_by_current_instance !== false
      const foreignRunning = gw?.running === true && gw?.owned_by_current_instance === false
      const nowRunning = ownedRunning
      if (nowRunning) {
        _gwStopCount = 0
        if (!_gatewayRunning) {
          _setGatewayRunning(true, false)
        }
      } else {
        if (foreignRunning) {
          _gwStopCount = 0
        } else {
          _gwStopCount++
        }
        if (foreignRunning || _gwStopCount >= 3 || !_gatewayRunning) {
          _setGatewayRunning(false, foreignRunning)
        }
      }
    }
  } catch {
    _gwStopCount++
    if (_gwStopCount >= 3) _setGatewayRunning(false)
  }
  return _gatewayRunning
}

/** 刷新 Gateway 运行状态（轻量，仅查服务状态）
 *  防抖：running→stopped 需要连续 3 次检测才切换，避免瞬态误判 */
export async function refreshGatewayStatus() {
  try {
    const services = await api.getServicesStatus()
    return _applyGatewayServices(services)
  } catch {
    _gwStopCount++
    if (_gwStopCount >= 3) _setGatewayRunning(false)
    return _gatewayRunning
  }
}

let _pollTimer = null
/** 启动 Gateway 状态轮询（每 15 秒检测一次） */
export function startGatewayPoll() {
  if (_pollTimer || _statusStream) return
  if (!isTauri && typeof EventSource !== 'undefined') {
    try {
      const stream = new EventSource('/__api/gateway_status_stream')
      _statusStream = stream
      stream.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data || '{}')
          _applyGatewayServices(payload.services || [])
        } catch {}
      }
      stream.onerror = () => {
        try { stream.close() } catch {}
        if (_statusStream === stream) _statusStream = null
        if (!_pollTimer) _pollTimer = setInterval(() => refreshGatewayStatus(), 15000)
      }
      return
    } catch {
      _statusStream = null
    }
  }
  _pollTimer = setInterval(() => refreshGatewayStatus(), 15000)
}
export function stopGatewayPoll() {
  if (_statusStream) {
    try { _statusStream.close() } catch {}
    _statusStream = null
  }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

/** 监听状态变化 */
export function onReadyChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}
