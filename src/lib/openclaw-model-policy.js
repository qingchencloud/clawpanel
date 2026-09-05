/**
 * OpenClaw 2026.8.1 将模型元数据与可切换模型白名单分离。
 * 只有配置已经显式拥有 modelPolicy.allow 时才同步，避免把 8.1 的 allow-any
 * 新语义误收紧；旧内核没有该字段时保持原有 defaults.models 行为。
 */
export function syncExplicitModelPolicyAllow(defaults) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return false
  const policy = defaults.modelPolicy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !Object.hasOwn(policy, 'allow')) {
    return false
  }
  const models = defaults.models && typeof defaults.models === 'object' && !Array.isArray(defaults.models)
    ? defaults.models
    : {}
  const next = Object.keys(models)
  if (JSON.stringify(policy.allow) === JSON.stringify(next)) return false
  policy.allow = next
  return true
}
