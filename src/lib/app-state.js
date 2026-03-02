/**
 * 全局应用状态
 * 管理 openclaw 安装状态，供各组件查询
 */
import { api } from './tauri-api.js'

let _openclawReady = false
let _gatewayRunning = false
let _listeners = []
let _gwListeners = []

/** openclaw 是否就绪（CLI 已安装 + 配置文件存在） */
export function isOpenclawReady() {
  return _openclawReady
}

/** Gateway 是否正在运行 */
export function isGatewayRunning() {
  return _gatewayRunning
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
  const changed = _gatewayRunning !== val
  _gatewayRunning = val
  if (changed) _gwListeners.forEach(fn => { try { fn(val) } catch {} })
}

/** 刷新 Gateway 运行状态（轻量，仅查服务状态） */
export async function refreshGatewayStatus() {
  try {
    const services = await api.getServicesStatus()
    if (services?.length > 0) _setGatewayRunning(services[0]?.running === true)
  } catch {}
  return _gatewayRunning
}

let _pollTimer = null
/** 启动 Gateway 状态轮询（每 15 秒，避免过于频繁） */
export function startGatewayPoll() {
  if (_pollTimer) return
  _pollTimer = setInterval(() => refreshGatewayStatus(), 15000)
}
export function stopGatewayPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

/** 监听状态变化 */
export function onReadyChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}
