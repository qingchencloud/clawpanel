import { api } from './tauri-api.js'

const SKILLS_CACHE_TTL_MS = 20_000

let _skillsCache = {
  data: null,
  expiresAt: 0,
  pending: null,
}

function normalizeSkillsData(data) {
  return {
    ...data,
    skills: Array.isArray(data?.skills) ? data.skills : [],
  }
}

export function summarizeSkillsCatalog(data) {
  const skills = Array.isArray(data?.skills) ? data.skills : []
  const eligible = skills.filter(s => s.eligible && !s.disabled)
  const missing = skills.filter(s => !s.eligible && !s.disabled && !s.blockedByAllowlist)
  const disabled = skills.filter(s => s.disabled)
  const blocked = skills.filter(s => s.blockedByAllowlist && !s.disabled)
  return {
    total: skills.length,
    eligible: eligible.length,
    missing: missing.length,
    disabled: disabled.length,
    blocked: blocked.length,
  }
}

export function getCachedSkillsCatalog() {
  if (!_skillsCache.data) return null
  if (Date.now() > _skillsCache.expiresAt) return null
  return _skillsCache.data
}

export function invalidateSkillsCatalog() {
  _skillsCache.expiresAt = 0
}

export async function loadSkillsCatalog(options = {}) {
  const force = !!options.force
  const now = Date.now()
  if (!force && _skillsCache.data && now <= _skillsCache.expiresAt) {
    return _skillsCache.data
  }
  if (!force && _skillsCache.pending) {
    return _skillsCache.pending
  }
  const request = api.skillsList()
    .then(normalizeSkillsData)
    .then(data => {
      _skillsCache.data = data
      _skillsCache.expiresAt = Date.now() + SKILLS_CACHE_TTL_MS
      return data
    })
    .finally(() => {
      if (_skillsCache.pending === request) _skillsCache.pending = null
    })
  _skillsCache.pending = request
  return request
}
