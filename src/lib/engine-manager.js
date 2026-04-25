/**
 * 引擎管理器
 * 管理多引擎（OpenClaw / Hermes Agent / ...）的注册、切换和状态
 */
import { api, invalidate } from './tauri-api.js'
import { registerRoute, setDefaultRoute } from '../router.js'

const _engines = {}
let _activeEngine = null
let _listeners = []

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
  try {
    const cfg = await api.readPanelConfig()
    if (cfg?.engineMode && _engines[cfg.engineMode]) {
      mode = cfg.engineMode
    }
  } catch {}
  await activateEngine(mode, false)
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
      if (cfg.engineMode !== id) {
        cfg.engineMode = id
        await api.writePanelConfig(cfg)
      }
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
