/**
 * humanize-error.js — 把后端原始 Error / Tauri Result 字符串映射成小白能看懂的友好文案。
 *
 * 用法：
 *   import { humanizeError } from '../lib/humanize-error.js'
 *   try { ... } catch (e) {
 *     toast(humanizeError(e, t('channels.loadFailed')), 'error')
 *   }
 *
 * 返回值：
 *   {
 *     message: string  // 用户主行（默认走 context 或匹配到的友好键）
 *     hint:    string  // 副行小灰字行动建议
 *     raw:     string  // 原始错误字符串（折叠在「技术详情」里）
 *   }
 *
 * 设计原则：
 *   - 永远返回对象（toast 组件需要稳定 shape）
 *   - 永远保留 raw 给开发者排查
 *   - hint 不强制覆盖 context；context 已含「做什么 + 失败」时 message 用 context
 */

import { t } from './i18n.js'

const PATTERNS = [
  // 网络
  {
    key: 'network',
    re: /(failed to fetch|networkerror|networkfailure|enetunreach|econnreset|econnrefused|ehostunreach|err_network|fetch failed|connection refused|connection reset|getaddrinfo|dns error|no route to host|aborted|broken pipe|connect timed out|tcp connect)/i,
  },
  // Gateway 未启动（特殊的 connection refused / port not listen 情况）
  {
    key: 'gatewayDown',
    re: /(gateway[^a-z]*(not[^a-z]*(running|ready|reachable)|down|offline|未启动)|managed gateway|未运行|gateway[^a-z]*未就绪)/i,
  },
  // 命令未找到 / 二进制丢失
  {
    key: 'cmdMissing',
    re: /(command not found|not recognized as|no such file or directory|enoent|不是.*命令|未找到.*命令|cannot find|missing executable|exec format error)/i,
  },
  // 权限
  {
    key: 'permission',
    re: /(permission denied|eacces|operation not permitted|access is denied|拒绝访问|无权限|权限不足|forbidden)/i,
  },
  // 鉴权（401/403/无效 token/api key）
  {
    key: 'auth',
    re: /(401|unauthori[sz]ed|invalid (api[_ ]?key|token|credentials)|authentication[^a-z]*(failed|required)|signature.*verification.*failed|身份验证|未授权)/i,
  },
  // 限流
  {
    key: 'rateLimit',
    re: /(429|too many requests|rate[_ ]?limit|quota[^a-z]*(exceeded|reached)|limit.*reached|流量限制|超过.*配额)/i,
  },
  // 超时
  {
    key: 'timeout',
    re: /(timeout|timed out|deadline exceeded|超时)/i,
  },
  // 资源不存在（404）
  {
    key: 'notFound',
    re: /(\b404\b|not found|does not exist|未找到|不存在|no such)/i,
  },
  // 服务繁忙（500-504 / "busy" / "unavailable"）
  {
    key: 'busy',
    re: /(\b5\d\d\b|service unavailable|server error|internal server|temporarily unavailable|busy|繁忙)/i,
  },
]

const RAW_MAX = 240 // 原始错误字符串保留长度（折叠区显示用，过长截断防止 toast 撑大）

/**
 * 把任意 error / 字符串 / Tauri Result 转成原始字符串。
 */
function toRawString(e) {
  if (e == null) return ''
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message || e.stack || String(e)
  if (typeof e === 'object') {
    // Tauri invoke 失败时通常是字符串；如果是 object，看常见字段
    if (typeof e.message === 'string') return e.message
    if (typeof e.error === 'string') return e.error
    try { return JSON.stringify(e) } catch { return String(e) }
  }
  return String(e)
}

/**
 * @param {unknown} e          - 原始错误（Error / string / Tauri Result）
 * @param {string}  [context]  - 操作上下文文案（如 t('channels.saveFailed')）
 * @returns {{ message: string, hint: string, raw: string }}
 */
export function humanizeError(e, context) {
  const raw = toRawString(e).trim()
  const rawTruncated = raw.length > RAW_MAX ? raw.slice(0, RAW_MAX) + '…' : raw

  // 1) 用 context 作为主行（已经是用户视角文案，比如「保存失败」）
  //    没有 context 时用通用「操作未完成」
  // 2) 匹配关键字定位具体原因 → 生成 hint
  const ctx = (context && String(context).trim()) || ''
  let kind = 'generic'
  for (const p of PATTERNS) {
    if (p.re.test(raw)) {
      kind = p.key
      break
    }
  }

  const message = ctx || t(`common.error.${kind}`)
  const hint = t(`common.errorHint.${kind}`)

  return { message, hint, raw: rawTruncated }
}

/**
 * 便捷帮手：直接拿格式化后的字符串（无 hint 折叠 UI，给老 API 兼容）。
 *   humanizeErrorText(e, ctx) -> "保存失败 · 网络不通"
 */
export function humanizeErrorText(e, context) {
  const h = humanizeError(e, context)
  return h.hint ? `${h.message} · ${h.hint}` : h.message
}
