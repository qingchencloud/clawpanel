/**
 * Config Schema 工具（P1-6）
 *
 * 对接 OpenClaw 内核的 config.schema / config.schema.lookup RPC：
 *   - 让前端写入前能做基础字段校验（类型/枚举/范围/必填/正则）
 *   - 让前端能感知内核新版加的字段（动态 UI 渲染基础）
 *
 * 设计原则：
 *   - 不引入 ajv 等重型 schema validator，保持 vanilla JS 体积
 *   - 只做最常见的 6 种校验（type/enum/minimum/maximum/pattern/required）
 *   - 内核仍然是最终守门人（config.set/patch 会再校验一次）
 *   - 本模块的价值是「**立即反馈**」：用户改完字段立刻看到错误，不必等点保存
 *
 * 用法：
 *   import { validateField } from './config-schema.js'
 *   const result = await validateField('gateway.port', 'abc')
 *   // { ok: false, message: 'Gateway 端口应该是数字（当前：abc）' }
 */
import { wsClient } from './ws-client.js'
import { t } from './i18n.js'

// schema.lookup 结果缓存（5 分钟，避免每次按键都重查）
const _cache = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 拿指定 path 的字段 schema（带缓存 + 容错）
 *
 * @param {string} path 配置字段路径，如 'gateway.port'
 * @returns {Promise<object|null>} schema 子树；不可用 / 不支持 / 不存在时返回 null
 */
export async function getFieldSchema(path) {
  if (!path) return null
  const cached = _cache.get(path)
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) return cached.v

  try {
    const result = await wsClient.request('config.schema.lookup', { path })
    _cache.set(path, { t: Date.now(), v: result || null })
    return result || null
  } catch (e) {
    // 内核版本太老 / 不支持该方法时静默 fallback
    _cache.set(path, { t: Date.now(), v: null })
    return null
  }
}

/**
 * 清缓存（极少需要 — 内核 schema 在 ClawPanel 一次会话内不会变）
 */
export function clearSchemaCache(path) {
  if (path) _cache.delete(path)
  else _cache.clear()
}

/**
 * 校验一个字段值是否符合 schema。
 *
 * @param {string} path 字段路径
 * @param {unknown} value 要校验的值
 * @returns {Promise<{ok: boolean, message?: string, code?: string}>}
 *   - ok=true 通过（或无法校验 — schema 不可用时降级放行）
 *   - ok=false 含 message（友好 i18n 文案）和 code（类型识别）
 */
export async function validateField(path, value) {
  const schema = await getFieldSchema(path)
  if (!schema) return { ok: true }  // 无 schema 不阻止用户保存（降级放行）

  // schema.lookup 返回结构：{ schema: {...}, type: '...', ... }
  // 实际字段约束通常在 schema.schema 子对象里，也兼容直接放在根上
  const constraints = schema.schema || schema

  return checkConstraints(constraints, value, path)
}

/**
 * 同步版校验（已有 schema 时用，避免重复 await）
 */
export function validateFieldSync(schema, value, path = '') {
  if (!schema) return { ok: true }
  const constraints = schema.schema || schema
  return checkConstraints(constraints, value, path)
}

function checkConstraints(c, value, path) {
  if (!c || typeof c !== 'object') return { ok: true }

  // required (空值检查 — undefined/null/空串)
  if (c.required && (value === undefined || value === null || value === '')) {
    return { ok: false, code: 'required', message: t('common.error.schemaRequired', { path }) }
  }

  // 跳过空值的其它校验
  if (value === undefined || value === null || value === '') return { ok: true }

  // type
  if (c.type) {
    const types = Array.isArray(c.type) ? c.type : [c.type]
    const actual = jsType(value)
    const ok = types.some(t => typeMatches(t, value, actual))
    if (!ok) {
      return {
        ok: false,
        code: 'type',
        message: t('common.error.schemaType', { path, expected: types.join('/'), actual }),
      }
    }
  }

  // enum
  if (Array.isArray(c.enum) && c.enum.length) {
    if (!c.enum.includes(value)) {
      return {
        ok: false,
        code: 'enum',
        message: t('common.error.schemaEnum', { path, allowed: c.enum.join(' / ') }),
      }
    }
  }

  // minimum / maximum
  if (typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)))) {
    const num = Number(value)
    if (typeof c.minimum === 'number' && num < c.minimum) {
      return {
        ok: false,
        code: 'minimum',
        message: t('common.error.schemaMin', { path, min: c.minimum }),
      }
    }
    if (typeof c.maximum === 'number' && num > c.maximum) {
      return {
        ok: false,
        code: 'maximum',
        message: t('common.error.schemaMax', { path, max: c.maximum }),
      }
    }
  }

  // pattern (string regex)
  if (c.pattern && typeof value === 'string') {
    try {
      const re = new RegExp(c.pattern)
      if (!re.test(value)) {
        return {
          ok: false,
          code: 'pattern',
          message: t('common.error.schemaPattern', { path }),
        }
      }
    } catch {
      // 非法 pattern，忽略
    }
  }

  return { ok: true }
}

function jsType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function typeMatches(schemaType, value, actual) {
  switch (schemaType) {
    case 'integer':
      return Number.isInteger(value) || (typeof value === 'string' && /^-?\d+$/.test(value))
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)))
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return actual === 'object'
    case 'null':
      return value === null
    default:
      return true
  }
}
