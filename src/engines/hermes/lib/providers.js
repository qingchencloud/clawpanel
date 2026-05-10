/**
 * Hermes provider registry (frontend mirror).
 *
 * This module:
 *   1. Loads providers once per session (cached)
 *   2. Groups them by auth type and region for UI rendering
 *   3. Provides small lookup helpers (by id, by model, etc.)
 *
 * Never hardcode provider data here — always call `loadHermesProviders()`
 * so we stay in sync with the Rust side.
 */

import { api } from '../../../lib/tauri-api.js'

// Auth type constants (must match Rust side)
export const AUTH_API_KEY = 'api_key'
export const AUTH_OAUTH_DEVICE = 'oauth_device_code'
export const AUTH_OAUTH_EXTERNAL = 'oauth_external'
export const AUTH_EXTERNAL_PROCESS = 'external_process'
export const AUTH_AWS_SDK = 'aws_sdk'
export const AUTH_OAUTH_MINIMAX = 'oauth_minimax'

// Transport constants
export const TRANSPORT_OPENAI_CHAT = 'openai_chat'
export const TRANSPORT_ANTHROPIC = 'anthropic_messages'
export const TRANSPORT_GOOGLE = 'google_gemini'
export const TRANSPORT_CODEX = 'codex_responses'

// China-region provider ids (for UI sub-grouping). Everything else is
// considered "International" by default.
const CN_PROVIDER_IDS = new Set([
  'zai',
  'kimi-coding',
  'kimi-coding-cn',
  'alibaba',
  'alibaba-coding-plan',
  'minimax-cn',
  'xiaomi',
])

// Aggregator ids (also tagged via `isAggregator` on the data).
const AGGREGATOR_IDS = new Set([
  'openrouter',
  'ai-gateway',
  'opencode-zen',
  'opencode-go',
  'kilocode',
  'huggingface',
  'nous',
  'azure-foundry',
])

let _cached = null
let _loadPromise = null

/**
 * Fetch the full provider list from Rust (cached for the session).
 * Returns [] if the backend is unreachable — callers should degrade gracefully.
 */
export async function loadHermesProviders() {
  if (_cached) return _cached
  if (_loadPromise) return _loadPromise

  _loadPromise = (async () => {
    try {
      const list = await api.hermesListProviders()
      _cached = Array.isArray(list) ? list : []
      return _cached
    } catch (err) {
      console.warn('[hermes/providers] failed to load registry:', err)
      _cached = []
      return _cached
    } finally {
      _loadPromise = null
    }
  })()

  return _loadPromise
}

/** Look up a provider by stable id; returns undefined if unknown. */
export function findProviderById(list, id) {
  return list?.find(p => p.id === id)
}

/** Case-insensitive search by display name or id. */
export function searchProviders(list, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return list
  return list.filter(p =>
    p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  )
}

/**
 * Group providers by auth type, with api_key further split into region
 * buckets for UI rendering. Returns:
 *   {
 *     apiKeyIntl:   HermesProvider[],
 *     apiKeyCn:     HermesProvider[],
 *     aggregators:  HermesProvider[],
 *     oauth:        HermesProvider[],
 *     externalProc: HermesProvider[],
 *     custom:       HermesProvider[],
 *   }
 */
export function groupProviders(list) {
  const groups = {
    apiKeyIntl: [],
    apiKeyCn: [],
    aggregators: [],
    oauth: [],
    externalProc: [],
    custom: [],
  }

  for (const p of list || []) {
    if (p.id === 'custom') {
      groups.custom.push(p)
      continue
    }
    if (p.authType === AUTH_EXTERNAL_PROCESS || p.authType === AUTH_AWS_SDK) {
      groups.externalProc.push(p)
      continue
    }
    if (p.authType === AUTH_OAUTH_DEVICE || p.authType === AUTH_OAUTH_EXTERNAL || p.authType === AUTH_OAUTH_MINIMAX) {
      groups.oauth.push(p)
      continue
    }
    if (p.isAggregator || AGGREGATOR_IDS.has(p.id)) {
      groups.aggregators.push(p)
      continue
    }
    if (CN_PROVIDER_IDS.has(p.id)) {
      groups.apiKeyCn.push(p)
      continue
    }
    groups.apiKeyIntl.push(p)
  }

  return groups
}

/**
 * Given a freshly entered base URL, guess which provider best matches.
 * Used by setup/dashboard forms to auto-highlight the preset button.
 */
export function inferProviderByBaseUrl(list, rawBaseUrl) {
  const normalize = (u) => (u || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|responses|messages|models)$/, '')
  const target = normalize(rawBaseUrl)
  if (!target) return null
  for (const p of list || []) {
    if (normalize(p.baseUrl) === target) return p
  }
  return null
}

/**
 * Return a sensible default model for a provider.
 * Aggregators may have empty `models` — callers must handle null.
 */
export function defaultModelFor(provider) {
  if (!provider || !provider.models || !provider.models.length) return null
  return provider.models[0]
}

/** Synchronous accessor for already-loaded registry. */
export function getCachedProviders() {
  return _cached || []
}

/** Force a reload on next call (e.g. after dev hot-reload). */
export function clearProviderCache() {
  _cached = null
  _loadPromise = null
}
