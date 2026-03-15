/**
 * 从混杂输出中提取第一个合法 JSON 对象或数组。
 * 用于处理 CLI 在 JSON 前后输出 warning / 提示文本的场景。
 */

export function extractFirstJson(text) {
  if (text == null) return null

  const input = String(text)
  if (!input.trim()) return null

  try {
    return JSON.parse(input)
  } catch {
    // 继续尝试从混杂文本中提取 JSON 片段
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch !== '{' && ch !== '[') continue

    const end = findJsonEnd(input, i)
    if (end === -1) continue

    try {
      return JSON.parse(input.slice(i, end + 1))
    } catch {
      // 当前候选不是合法 JSON，继续向后扫描
    }
  }

  return null
}

function findJsonEnd(text, start) {
  const stack = []
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      stack.push('}')
      continue
    }

    if (ch === '[') {
      stack.push(']')
      continue
    }

    if (ch === '}' || ch === ']') {
      if (!stack.length || stack.pop() !== ch) {
        return -1
      }
      if (!stack.length) {
        return i
      }
    }
  }

  return -1
}
