/**
 * Batch 3 §P: TTS — 浏览器 Web Speech API（100% 离线，无需后端）
 *
 * 校对发现：Hermes 内核没有 HTTP TTS 端点（只有 lazy_deps 注册的 tts.edge / tts.elevenlabs 包），
 * 浏览器原生 speechSynthesis 已经够用，跨平台 + 无延迟 + 无成本。
 *
 * 用法：
 *   speak('Hello world')          // 自动检测语言
 *   speak('你好', 'zh-CN')        // 指定语言
 *   stopSpeaking()                // 停止当前播放
 *   isSpeaking()                  // 查询状态
 *   isSupported()                 // 浏览器是否支持
 */

let currentUtterance = null

/**
 * 自动检测语言（最简启发式）— 中文/英文/日韩
 */
function detectLang(text) {
  const s = String(text || '').slice(0, 200)
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh-CN'  // 简中
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja-JP'
  if (/[\uac00-\ud7af]/.test(s)) return 'ko-KR'
  return 'en-US'
}

/**
 * 选择最合适的 voice
 */
function pickVoice(lang) {
  if (typeof speechSynthesis === 'undefined') return null
  const voices = speechSynthesis.getVoices()
  if (!voices?.length) return null
  // 精确匹配 > 前缀匹配 > 默认
  return voices.find(v => v.lang === lang)
      || voices.find(v => v.lang.startsWith(lang.split('-')[0]))
      || voices.find(v => v.default)
      || voices[0]
}

export function isSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

export function isSpeaking() {
  return isSupported() && (speechSynthesis.speaking || speechSynthesis.pending)
}

export function stopSpeaking() {
  if (!isSupported()) return
  try {
    speechSynthesis.cancel()
  } catch {}
  currentUtterance = null
}

/**
 * 播放文本。返回 Promise 在播放结束/失败/取消时 resolve。
 * 重复调用会先 cancel 之前的。
 */
export function speak(text, lang = null) {
  if (!isSupported()) return Promise.reject(new Error('TTS_NOT_SUPPORTED'))
  const cleaned = String(text || '').trim()
  if (!cleaned) return Promise.resolve()

  // 取消之前的
  stopSpeaking()

  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(cleaned)
    u.lang = lang || detectLang(cleaned)
    const voice = pickVoice(u.lang)
    if (voice) u.voice = voice
    u.rate = 1.0
    u.pitch = 1.0
    u.volume = 1.0
    u.onend = () => { currentUtterance = null; resolve() }
    u.onerror = (e) => { currentUtterance = null; reject(e?.error || new Error('TTS_ERROR')) }
    currentUtterance = u

    // Chrome bug：voices 异步加载，第一次可能空。先触发加载。
    if (!speechSynthesis.getVoices().length) {
      const onChange = () => {
        speechSynthesis.removeEventListener('voiceschanged', onChange)
        const v = pickVoice(u.lang)
        if (v) u.voice = v
        speechSynthesis.speak(u)
      }
      speechSynthesis.addEventListener('voiceschanged', onChange)
      // 兜底：100ms 后无论如何 speak（有些浏览器不触发 voiceschanged）
      setTimeout(() => {
        if (currentUtterance === u && !isSpeaking()) {
          speechSynthesis.removeEventListener('voiceschanged', onChange)
          speechSynthesis.speak(u)
        }
      }, 100)
    } else {
      speechSynthesis.speak(u)
    }
  })
}

/**
 * 切换播放：相同文本再按 → 停止；否则 → 播放
 */
export function toggle(text, lang = null) {
  if (isSpeaking() && currentUtterance && currentUtterance.text === text) {
    stopSpeaking()
    return Promise.resolve()
  }
  return speak(text, lang)
}
