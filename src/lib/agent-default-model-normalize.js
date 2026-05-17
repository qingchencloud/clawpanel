/**
 * Pure helpers for repairing agents.defaults.model + agents.defaults.models
 * when loading the dashboard. Kept in a standalone module so unit tests can
 * cover normalization without pulling in the full dashboard page.
 */

export function collectConfigModels(config) {
  const result = []
  const providers = config?.models?.providers || {}
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const model of (provider?.models || [])) {
      const id = typeof model === 'string' ? model : model?.id
      if (id) result.push(`${providerKey}/${id}`)
    }
  }
  return result
}

export function defaultModelNeedsNormalization(config) {
  const validModels = new Set(collectConfigModels(config))
  const modelConfig = config?.agents?.defaults?.model || {}
  const primary = modelConfig.primary || ''
  const fallbacks = Array.isArray(modelConfig.fallbacks) ? modelConfig.fallbacks : []
  if (!validModels.size) return !!primary || fallbacks.length > 0 || Object.keys(config?.agents?.defaults?.models || {}).length > 0
  if (!validModels.has(primary)) return true
  if (fallbacks.some(f => f === primary || !validModels.has(f))) return true
  return Object.keys(config?.agents?.defaults?.models || {}).some(key => !validModels.has(key))
}

/**
 * Align primary / fallbacks with configured providers and rebuild defaults.models.
 * Must preserve per-model blocks for any still-valid model id not on the chain
 * (same rule as models.js normalizeDefaultModelMap); otherwise dashboard
 * self-heal drops unrelated overrides when it only meant to fix a bad primary.
 */
export function normalizeDefaultModelConfig(config) {
  const allModels = collectConfigModels(config)
  const validModels = new Set(allModels)
  if (!config.agents) config.agents = {}
  if (!config.agents.defaults) config.agents.defaults = {}
  if (!config.agents.defaults.model) config.agents.defaults.model = {}
  const modelConfig = config.agents.defaults.model
  if (!Array.isArray(modelConfig.fallbacks)) modelConfig.fallbacks = []
  if (!allModels.length) {
    modelConfig.primary = ''
    modelConfig.fallbacks = []
    config.agents.defaults.models = {}
    return ''
  }
  if (!validModels.has(modelConfig.primary || '')) {
    modelConfig.primary = modelConfig.fallbacks.find(f => validModels.has(f)) || allModels[0]
  }
  const seen = new Set([modelConfig.primary])
  modelConfig.fallbacks = modelConfig.fallbacks
    .filter(f => validModels.has(f))
    .filter(f => {
      if (seen.has(f)) return false
      seen.add(f)
      return true
    })
  const currentMap = config.agents.defaults.models && typeof config.agents.defaults.models === 'object' && !Array.isArray(config.agents.defaults.models) ? config.agents.defaults.models : {}
  const nextMap = {}
  nextMap[modelConfig.primary] = currentMap[modelConfig.primary] && typeof currentMap[modelConfig.primary] === 'object' && !Array.isArray(currentMap[modelConfig.primary]) ? currentMap[modelConfig.primary] : {}
  for (const fallback of modelConfig.fallbacks) {
    nextMap[fallback] = currentMap[fallback] && typeof currentMap[fallback] === 'object' && !Array.isArray(currentMap[fallback]) ? currentMap[fallback] : {}
  }
  for (const [key, value] of Object.entries(currentMap)) {
    if (validModels.has(key) && !nextMap[key]) {
      nextMap[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
  }
  config.agents.defaults.models = nextMap
  return modelConfig.primary
}
