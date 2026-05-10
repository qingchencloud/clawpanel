/**
 * 引擎管理器
 * 管理多引擎（OpenClaw / Hermes Agent / ...）的注册、切换和状态
 */
import { api, invalidate } from './tauri-api.js'
import { registerRoute, setDefaultRoute } from '../router.js'

const _engines = {}
let _activeEngine = null
let _listeners = []
let _needsInitialEngineChoice = false
let _engineSetupDeferred = false

/** 注册引擎 */
export function registerEngine(engine) {
  _engines[engine.id] = engine
}

/** 获取所有已注册引擎 */
export function listEngines() {
  return Object.values(_engines).map(e => ({
    id: e.id,
    name: e.name,
    icon: e.icon || '',
    description: e.description || '',
  }))
}

/** 获取当前激活的引擎 */
export function getActiveEngine() {
  return _activeEngine
}

/** 获取引擎 ID */
export function getActiveEngineId() {
  return _activeEngine?.id || 'openclaw'
}

export function needsInitialEngineChoice() {
  return _needsInitialEngineChoice
}

export function isEngineSetupDeferred() {
  return _engineSetupDeferred
}

/** 按 ID 获取引擎 */
export function getEngine(id) {
  return _engines[id] || null
}

/** 监听引擎切换事件 */
export function onEngineChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}

/**
 * 初始化引擎管理器：读取 clawpanel.json 中的 engineMode，激活对应引擎
 * 在 main.js boot() 中调用
 */
export async function initEngineManager() {
  let mode = 'openclaw'
  _engineSetupDeferred = false
  let hasChoice = false
  try {
    const cfg = await api.readPanelConfig()
    hasChoice = !!cfg?.engineSetupChoice
    if (cfg?.engineMode === 'deferred') {
      _engineSetupDeferred = true
    } else if (cfg?.engineMode === 'both') {
      mode = 'openclaw'
    } else if (cfg?.engineMode && _engines[cfg.engineMode]) {
      mode = cfg.engineMode
    }
  } catch {}
  // “是否需要走首次选择”仅取决于用户有没有真正点过 /engine-select 或引擎切换器；
  // 单纯有 engineMode 但没有 engineSetupChoice（旧版本/历史数据）依然视为未选择，
  // 这样 OpenClaw 没装好的情况下能走到选择页，而不是被默认拉到 /setup。
  _needsInitialEngineChoice = !hasChoice
  await activateEngine(mode, false)
}

export async function applyEngineSelection({ activeEngineId = 'openclaw', enabledEngineIds = [], deferred = false, choice = '', engineMode = '' } = {}) {
  const mode = deferred ? 'openclaw' : activeEngineId
  if (!_engines[mode]) {
    throw new Error(`unknown engine: ${mode}`)
  }
  const enabled = Array.isArray(enabledEngineIds)
    ? enabledEngineIds.filter((id, idx, arr) => _engines[id] && arr.indexOf(id) === idx)
    : []
  const cfg = await api.readPanelConfig().catch(() => ({}))
  cfg.engineMode = deferred ? 'deferred' : (engineMode || mode)
  cfg.enabledEngines = deferred ? [] : (enabled.length ? enabled : [mode])
  if (choice) cfg.engineSetupChoice = choice
  await api.writePanelConfig(cfg)
  _needsInitialEngineChoice = false
  _engineSetupDeferred = !!deferred
  await activateEngine(mode, false)
  if (_activeEngine?.boot) {
    try {
      await Promise.race([
        _activeEngine.boot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('engine boot timeout')), 10000))
      ])
    } catch (e) {
      console.warn('[engine-manager] boot 失败或超时:', e)
    }
  }
}

export async function adoptActiveEngineSelection({ enabledEngineIds = [], choice = '' } = {}) {
  const engine = _activeEngine
  if (!engine) return
  const enabled = Array.isArray(enabledEngineIds)
    ? enabledEngineIds.filter((id, idx, arr) => _engines[id] && arr.indexOf(id) === idx)
    : []
  const cfg = await api.readPanelConfig().catch(() => ({}))
  if (!cfg.engineMode) {
    cfg.engineMode = engine.id
    cfg.enabledEngines = enabled.length ? enabled : [engine.id]
    if (choice) cfg.engineSetupChoice = choice
    await api.writePanelConfig(cfg)
  }
  _needsInitialEngineChoice = false
  _engineSetupDeferred = false
}

/**
 * 激活指定引擎（注册路由 + 启动）
 * @param {string} id 引擎 ID
 * @param {boolean} persist 是否写入 clawpanel.json
 */
export async function activateEngine(id, persist = true) {
  const engine = _engines[id]
  if (!engine) {
    console.error(`[engine-manager] 未知引擎: ${id}`)
    return
  }

  // 清理旧引擎 + 重置 API 缓存与 in-flight，避免旧引擎 pending 请求阻塞新引擎页面
  if (_activeEngine && _activeEngine.id !== id) {
    if (_activeEngine.cleanup) {
      try { _activeEngine.cleanup() } catch {}
    }
    try { invalidate() } catch {}
  }

  _activeEngine = engine

  // 给 <body> 设置 data-active-engine 属性，供全局组件（sidebar 等）做
  // 引擎级样式切换（e.g. Hermes 激活时 sidebar 套 editorial luxury 主题）
  try { document.body.dataset.activeEngine = engine.id } catch {}

  // 注册引擎路由 + 设置默认路由
  const routes = engine.getRoutes()
  for (const r of routes) {
    registerRoute(r.path, r.loader)
  }
  if (engine.getDefaultRoute) {
    setDefaultRoute(engine.getDefaultRoute())
  }

  // 切换时启动新引擎（检测安装状态等），初始化由 main.js 处理
  if (persist && engine.boot) {
    try {
      await Promise.race([
        engine.boot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('engine boot timeout')), 10000))
      ])
    } catch (e) {
      console.warn('[engine-manager] boot 失败或超时:', e)
    }
  }

  // 持久化到 clawpanel.json
  if (persist) {
    try {
      const cfg = await api.readPanelConfig()
      let dirty = false
      if (cfg.engineMode !== id) {
        cfg.engineMode = id
        dirty = true
      }
      // 通过侧栏切换器走到这里时，也补一个 engineSetupChoice，避免下次启动
      // 又被判定为“未选择”。已有值（例如 'both'/'later'）则保留不覆盖。
      if (!cfg.engineSetupChoice) {
        cfg.engineSetupChoice = id
        dirty = true
      }
      if (dirty) await api.writePanelConfig(cfg)
      _needsInitialEngineChoice = false
      _engineSetupDeferred = false
    } catch (e) {
      console.warn('[engine-manager] 保存 engineMode 失败:', e)
    }
  }

  // 通知监听者
  _listeners.forEach(fn => { try { fn(engine) } catch {} })
}

/**
 * 切换引擎（带 UI 跳转）
 */
export async function switchEngine(id) {
  if (_activeEngine?.id === id) return
  await activateEngine(id, true)
}
