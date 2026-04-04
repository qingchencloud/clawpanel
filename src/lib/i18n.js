import { buildLocales } from '../locales/index.js'

const STORAGE_KEY = 'clawpanel_lang'
const locales = buildLocales()

export function t(key) {
  const [mod, k] = key.split('.')
  const lang = getLang()
  const mappedLang = lang === 'zh' ? 'zh-CN' : lang
  
  if (locales[mappedLang] && locales[mappedLang][mod]) {
    return locales[mappedLang][mod][k] || k
  }
  return k || key
}

export function getLang() {
  return localStorage.getItem(STORAGE_KEY) || 'en'
}

export function setLang(lang) {
  localStorage.setItem(STORAGE_KEY, lang)
  location.reload()
}

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
    { code: 'de', label: 'Deutsch' }
  ]
}

export function initI18n() {}
export function onLangChange() {}
