/**
 * Markdown 渲染器 - 轻量级，支持代码高亮
 * 从 clawapp 移植，去掉 MEDIA 路径处理
 */

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
  // Two-phase: mark with control chars first, convert to HTML last
  // Prevents keyword regex from matching "class" inside <span class="..."> attributes
  const S = '\x02', E = '\x03'
  const CLS = ['hl-number','hl-comment','hl-string','hl-type','hl-func','hl-keyword']
  return escaped
    .replace(/\b(\d+\.?\d*)\b/g, `${S}0${E}$1${S}c${E}`)
    .replace(/(\/\/.*$|#.*$)/gm, `${S}1${E}$1${S}c${E}`)
    .replace(/(\/\*[\s\S]*?\*\/)/g, `${S}1${E}$1${S}c${E}`)
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'[^'\n]*'|`[^`]*`)/g,
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
}

// 预加载 Tauri convertFileSrc
let _convertFileSrc = null
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  import('@tauri-apps/api/core').then(m => { _convertFileSrc = m.convertFileSrc }).catch(() => {})
}

/** 将本地文件路径转换为可加载的 URL */
function resolveImageSrc(src) {
  if (!src) return src
  // 已经是 http/https/data URL → 直接返回
  if (/^(https?|data|blob):/.test(src)) return src
  // Windows 绝对路径 (C:\... or C:/...)
  const isWinPath = /^[A-Za-z]:[\\/]/.test(src)
  // Unix 绝对路径 (/Users/... /home/... /tmp/...)
  const isUnixPath = /^\/[^/]/.test(src)
  if (isWinPath || isUnixPath) {
    // Tauri 环境：使用 convertFileSrc 转换为 asset protocol URL
    if (_convertFileSrc) {
      try { return _convertFileSrc(src) } catch {}
    }
    // Tauri 未就绪或 Web 模式：返回原始路径（onerror 会处理显示）
    return src
  }
  return src
}

export function renderMarkdown(text) {
  if (!text) return ''
  let html = text

  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const highlighted = highlightCode(code.trimEnd(), lang)
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
    return `<pre data-lang="${escapeHtml(lang)}">${langLabel}<button class="code-copy-btn" onclick="window.__copyCode(this)">Copy</button><code>${highlighted}</code></pre>`
  })

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`)

  const lines = html.split('\n')
  const result = []
  let inList = false
  let listType = ''
  let inTable = false
  let tableRows = []

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]

    // 跳过 pre 块内容
    if (line.startsWith('<pre')) {
      result.push(line)
      while (i < lines.length - 1 && !lines[i].includes('</pre>')) { i++; result.push(lines[i]) }
      continue
    }

    // 表格检测：表头分隔行 (|---|...|)
    const isTableSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(line) || 
                             /^\s*[\-:]+(\s*\|\s*[\-:]+)+\s*$/.test(line)
    
    // 检测是否可能是表格行
    const isTableRow = /^\s*\|.*\|\s*$/.test(line) || 
                       /^\s*[^\|]+\s*\|\s*[^\|]+/.test(line)
    
    // 如果在表格中，继续收集行
    if (inTable) {
      if (isTableRow && line.trim() !== '') {
        tableRows.push(line)
        continue
      } else {
        // 表格结束，渲染表格
        result.push(renderTable(tableRows))
        inTable = false
        tableRows = []
      }
    }
    
    // 检测表格开始：当前行是表格行，且下一行是分隔行
    if (!inTable && isTableRow && i + 1 < lines.length) {
      const nextLine = lines[i + 1]
      if (/^\s*\|[\s\-:|]+\|\s*$/.test(nextLine) || 
          /^\s*[\-:]+(\s*\|\s*[\-:]+)+\s*$/.test(nextLine)) {
        inTable = true
        tableRows.push(line)
        continue
      }
    }

    // 标题
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      if (inList) { result.push(`</${listType}>`); inList = false }
      const level = headingMatch[1].length
      result.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`)
      continue
    }

    // 无序列表
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/)
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ul>'); inList = true; listType = 'ul'
      }
      result.push(`<li>${inlineFormat(ulMatch[1])}</li>`)
      continue
    }

    // 有序列表
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/)
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ol>'); inList = true; listType = 'ol'
      }
      result.push(`<li>${inlineFormat(olMatch[1])}</li>`)
      continue
    }

    if (inList) { result.push(`</${listType}>`); inList = false }
    if (line.trim() === '') { result.push(''); continue }
    if (!line.startsWith('<')) { result.push(`<p>${inlineFormat(line)}</p>`) }
    else { result.push(line) }
  }

  if (inList) result.push(`</${listType}>`)
  // 处理剩余的表格
  if (inTable && tableRows.length > 0) {
    result.push(renderTable(tableRows))
  }
  return result.join('\n')
}

/**
 * 渲染 Markdown 表格
 * @param {string[]} rows - 表格行数组
 * @returns {string} HTML 表格
 */
function renderTable(rows) {
  if (!rows || rows.length < 2) return ''
  
  const table = ['<table>']
  let isHeaderRow = true
  let hasSeparator = false
  
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i].trim()
    
    // 跳过空行
    if (!row) continue
    // 检测分隔行 (|---|...|)
    const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(row) || 
                        /^\s*[\-:]+(\s*\|\s*[\-:]+)+\s*$/.test(row)
    if (isSeparator) {
      hasSeparator = true
      continue
    }
    
    // 解析单元格
    let cells = []
    if (row.startsWith('|') && row.endsWith('|')) {
      // 标准格式: | cell1 | cell2 |
      cells = row.slice(1, -1).split('|')
    } else {
      // 简化格式: cell1 | cell2
      cells = row.split('|')
    }
    // 清理单元格内容
    cells = cells.map(cell => inlineFormat(cell.trim()))
    if (cells.length === 0) continue
    
    // 渲染行
    const tag = isHeaderRow && !hasSeparator && i === 0 ? 'th' : 'td'
    table.push('  <tr>')
    cells.forEach(cell => {
      table.push(`    <${tag}>${cell}</${tag}>`)
    })
    table.push('  </tr>')
    
    // 第一行后切换到数据行（如果有分隔行）
    if (hasSeparator && i === 0) {
      isHeaderRow = false
    }
  }
  
  table.push('</table>')
  return table.join('\n')
}

function inlineFormat(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    // 避免 (?<!\w) 负向后查找：旧版 Safari / 部分 WebView 会报 invalid group specifier name
    .replace(/(^|[^A-Za-z0-9_])_(.+?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const safeSrc = resolveImageSrc(src.trim())
      const escapedSrc = escapeHtml(src).replace(/\\/g, '&#x5c;')
      return `<img src="${safeSrc}" alt="${alt}" class="msg-img" onerror="this.onerror=null;this.style.display='none';this.insertAdjacentHTML('afterend','<span style=\\'color:var(--text-tertiary);font-size:12px\\'>[图片无法加载: ${escapedSrc}]</span>')" />`
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = /^https?:|^mailto:/i.test(url.trim()) ? url : '#'
      return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`
    })
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
