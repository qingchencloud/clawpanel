/**
 * Markdown 渲染器 - markdown-it 版本
 * 支持代码高亮、下划线、剧透、@提及
 */

import MarkdownIt from 'markdown-it'

const KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','new','this','class','extends','import',
  'export','from','default','try','catch','finally','throw','async','await',
  'yield','of','in','typeof','instanceof','void','delete','true','false',
  'null','undefined','static','get','set','super','with','debugger',
  'def','print','self','elif','lambda','pass','raise','except','None','True','False',
  'fn','pub','mut','impl','struct','enum','match','use','mod','crate','trait',
  'int','string','bool','float','double','char','byte','long','short','unsigned',
  'package','main','fmt','go','chan','defer','select','type','interface','map','range',
])

function highlightCode(code, lang) {
  const escaped = escapeHtml(code)
  const S = '\x02', E = '\x03'
  const CLS = ['hl-number','hl-comment','hl-string','hl-type','hl-func','hl-keyword']
  return escaped
    .replace(/\b(\d+\.?\d*)\b/g, `${S}0${E}$1${S}c${E}`)
    .replace(/(\/\/.*$|#.*$)/gm, `${S}1${E}$1${S}c${E}`)
    .replace(/(\/\*[\s\S]*?\*\/)/g, `${S}1${E}$1${S}c${E}`)
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#x27;(?:[^&]|&(?!#x27;))*?&#x27;|`[^`]*`)/g,
      `${S}2${E}$1${S}c${E}`)
    .replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, (m, w) =>
      KEYWORDS.has(w) ? m : `${S}3${E}${w}${S}c${E}`)
    .replace(/\b(\w+)(?=\s*\()/g, (m, w) =>
      KEYWORDS.has(w) ? m : `${S}4${E}${w}${S}c${E}`)
    .replace(/\b(\w+)\b/g, (m, w) =>
      KEYWORDS.has(w) ? `${S}5${E}${w}${S}c${E}` : m)
    .replace(/\x02([0-5])\x03/g, (_, i) => `<span class="${CLS[+i]}">`)
    .replace(/\x02c\x03/g, '</span>')
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function escapeHtmlLite(str) {
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function stripAnsi(str) {
  if (!str) return ''
  return str.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

// 预加载 Tauri convertFileSrc
let _convertFileSrc = null
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  import('@tauri-apps/api/core').then(m => { _convertFileSrc = m.convertFileSrc }).catch(() => {})
}

function resolveImageSrc(src) {
  if (!src) return src
  if (/^(https?|data|blob):/.test(src)) return src
  const isWinPath = /^[A-Za-z]:[\\/]/.test(src)
  const isUnixPath = /^\/[^/]/.test(src)
  if (isWinPath || isUnixPath) {
    if (_convertFileSrc) {
      try { return _convertFileSrc(src) } catch {}
    }
    return src
  }
  return src
}

function spoilerPlugin(md) {
  md.inline.ruler.before('emphasis', 'spoiler', (state, silent) => {
    const src = state.src
    const pos = state.pos
    if (src.startsWith('||', pos)) {
      const end = src.indexOf('||', pos + 2)
      if (end === -1) return false
      if (!silent) {
        const tokenOpen = state.push('spoiler_open', 'span', 1)
        tokenOpen.markup = '||'
        const oldPos = state.pos
        const oldMax = state.posMax
        state.pos = pos + 2
        state.posMax = end
        state.md.inline.tokenize(state)
        state.pos = oldPos
        state.posMax = oldMax
        const tokenClose = state.push('spoiler_close', 'span', -1)
        tokenClose.markup = '||'
      }
      state.pos = end + 2
      return true
    }
    if (src.startsWith('>!', pos)) {
      const end = src.indexOf('!<', pos + 2)
      if (end === -1) return false
      if (!silent) {
        const tokenOpen = state.push('spoiler_open', 'span', 1)
        tokenOpen.markup = '>!'
        const oldPos = state.pos
        const oldMax = state.posMax
        state.pos = pos + 2
        state.posMax = end
        state.md.inline.tokenize(state)
        state.pos = oldPos
        state.posMax = oldMax
        const tokenClose = state.push('spoiler_close', 'span', -1)
        tokenClose.markup = '!<'
      }
      state.pos = end + 2
      return true
    }
    return false
  })

  md.renderer.rules.spoiler_open = () => '<span class="msg-spoiler">'
  md.renderer.rules.spoiler_close = () => '</span>'
}

function mentionPlugin(md) {
  md.inline.ruler.before('text', 'mention', (state, silent) => {
    const src = state.src
    const pos = state.pos
    if (src[pos] !== '@') return false
    if (pos > 0 && /[\w.]/.test(src[pos - 1])) return false
    const match = src.slice(pos + 1).match(/^[a-zA-Z0-9_]{1,32}/)
    if (!match) return false
    if (!silent) {
      const token = state.push('mention', '', 0)
      token.content = '@' + match[0]
    }
    state.pos += 1 + match[0].length
    return true
  })

  md.renderer.rules.mention = (tokens, idx) => {
    return `<span class="msg-mention">${escapeHtml(tokens[idx].content)}</span>`
  }
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (code, lang) => {
    const highlighted = highlightCode(code.trimEnd(), lang)
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
    return `<pre data-lang="${escapeHtml(lang)}">${langLabel}<button class="code-copy-btn" onclick="window.__copyCode(this)">Copy</button><code>${highlighted}</code></pre>`
  },
})

// __text__ -> <u>text</u>, keep ** for <strong>
md.renderer.rules.strong_open = (tokens, idx) => (tokens[idx].markup === '__' ? '<u>' : '<strong>')
md.renderer.rules.strong_close = (tokens, idx) => (tokens[idx].markup === '__' ? '</u>' : '</strong>')

// Link whitelist
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIdx = tokens[idx].attrIndex('href')
  if (hrefIdx >= 0) {
    const url = tokens[idx].attrs[hrefIdx][1] || ''
    const safe = /^(https?:|mailto:)/i.test(url.trim()) ? url : '#'
    tokens[idx].attrs[hrefIdx][1] = safe
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// Image renderer
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]
  const srcIdx = token.attrIndex('src')
  const rawSrc = srcIdx >= 0 ? token.attrs[srcIdx][1] : ''
  const safeSrc = resolveImageSrc((rawSrc || '').trim())
  const alt = escapeHtmlLite(token.content || '')
  const rawEscaped = escapeHtml(rawSrc || '')
  return `<img src="${safeSrc}" alt="${alt}" class="msg-img" onerror="this.onerror=null;this.style.display='none';this.insertAdjacentHTML('afterend','<span style=\\'color:var(--text-tertiary);font-size:12px\\'>[图片无法加载: ${rawEscaped}]</span>')" />`
}

md.use(spoilerPlugin)
md.use(mentionPlugin)

export function renderMarkdown(text) {
  if (!text) return ''
  const clean = stripAnsi(text)
  return md.render(clean)
}

window.__copyCode = function(btn) {
  const pre = btn.closest('pre')
  const code = pre.querySelector('code')
  navigator.clipboard.writeText(code.innerText).then(() => {
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  }).catch(() => {
    btn.textContent = '✗'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
}
