/**
 * i18n 国际化核心模块
 * 模块化多语言架构。首屏只加载当前语言，避免启动时解析并构建 11 套完整字典。
 */
import zhCN from '../locales/zh-CN.json' with { type: 'json' }

const LANG_KEY = 'clawpanel_lang'
const FALLBACK = 'zh-CN'
const LOCALE_LOADERS = {
  'zh-CN': async () => zhCN,
  'zh-TW': async () => (await import('../locales/zh-TW.json', { with: { type: 'json' } })).default,
  en: async () => (await import('../locales/en.json', { with: { type: 'json' } })).default,
  ja: async () => (await import('../locales/ja.json', { with: { type: 'json' } })).default,
  ko: async () => (await import('../locales/ko.json', { with: { type: 'json' } })).default,
  vi: async () => (await import('../locales/vi.json', { with: { type: 'json' } })).default,
  es: async () => (await import('../locales/es.json', { with: { type: 'json' } })).default,
  pt: async () => (await import('../locales/pt.json', { with: { type: 'json' } })).default,
  ru: async () => (await import('../locales/ru.json', { with: { type: 'json' } })).default,
  fr: async () => (await import('../locales/fr.json', { with: { type: 'json' } })).default,
  de: async () => (await import('../locales/de.json', { with: { type: 'json' } })).default,
}
const LOCALE_CACHE = new Map([[FALLBACK, zhCN]])

let _lang = FALLBACK
let _dict = zhCN
let _listeners = []
let _splashBridgeReady = false

function _syncDocumentLang(lang) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang
  }
}

/**
 * 翻译函数
 * @param {string} key - 点分隔路径，如 'sidebar.dashboard'
 * @param {object} [params] - 插值参数，如 { count: 3 } 替换 {count}
 * @returns {string}
 */
export function t(key, params) {
  let val = _resolve(_dict, key)
  if (val === undefined) {
    // fallback 到中文
    val = _resolve(zhCN, key)
  }
  if (val === undefined) return key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return val
}

function _resolve(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return typeof cur === 'string' ? cur : undefined
}

/** 获取当前语言 */
export function getLang() { return _lang }

/** 获取所有可用语言 */
export function getAvailableLangs() {
  return [
    { code: 'zh-CN', label: '简体中文' },
    { code: 'zh-TW', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'ru', label: 'Русский' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
  ]
}

async function _loadLocale(lang) {
  if (!LOCALE_LOADERS[lang]) return null
  if (LOCALE_CACHE.has(lang)) return LOCALE_CACHE.get(lang)
  const dict = await LOCALE_LOADERS[lang]()
  LOCALE_CACHE.set(lang, dict)
  return dict
}

/** 切换语言。语言包按需加载，调用方应等待完成后再重渲染页面。 */
export async function setLang(lang) {
  const dict = await _loadLocale(lang)
  if (!dict) return false
  _lang = lang
  _dict = dict
  _syncDocumentLang(lang)
  if (typeof localStorage !== 'undefined') localStorage.setItem(LANG_KEY, lang)
  _listeners.forEach(fn => { try { fn(lang) } catch {} })
  return true
}

/** 监听语言变化 */
export function onLangChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}

function _bindSplashLanguageBridge() {
  if (_splashBridgeReady || typeof window === 'undefined') return
  _splashBridgeReady = true
  window.addEventListener('clawpanel-lang-change', async (e) => {
    const next = e?.detail
    if (next && LOCALE_LOADERS[next] && next !== _lang) await setLang(next)
  })
}

/** 初始化：localStorage > navigator.language > fallback */
export async function initI18n() {
  _bindSplashLanguageBridge()
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : ''
  if (saved && LOCALE_LOADERS[saved]) {
    await setLang(saved)
    return
  }
  // 自动检测浏览器语言
  const nav = typeof navigator !== 'undefined'
    ? (navigator.language || navigator.languages?.[0] || '')
    : ''
  if (nav === 'zh-TW' || nav === 'zh-HK') {
    _lang = 'zh-TW'
  } else if (nav.startsWith('zh')) {
    _lang = 'zh-CN'
  } else if (nav.startsWith('ja')) {
    _lang = 'ja'
  } else if (nav.startsWith('ko')) {
    _lang = 'ko'
  } else if (nav.startsWith('vi')) {
    _lang = 'vi'
  } else if (nav.startsWith('es')) {
    _lang = 'es'
  } else if (nav.startsWith('pt')) {
    _lang = 'pt'
  } else if (nav.startsWith('ru')) {
    _lang = 'ru'
  } else if (nav.startsWith('fr')) {
    _lang = 'fr'
  } else if (nav.startsWith('de')) {
    _lang = 'de'
  } else if (nav.startsWith('en')) {
    _lang = 'en'
  }
  _dict = await _loadLocale(_lang) || zhCN
  _syncDocumentLang(_lang)
}
