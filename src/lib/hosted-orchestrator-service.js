export function shouldReplaceHostedSeed(localHistory, seeded, force = false) {
  const local = Array.isArray(localHistory) ? localHistory : []
  if (force || !local.length) return true
  const remoteLastTs = seeded.reduce((max, item) => Math.max(max, Number(item?.ts || 0)), 0)
  const localLastTs = local.reduce((max, item) => Math.max(max, Number(item?.ts || 0)), 0)
  return remoteLastTs >= localLastTs
}

export function resolveHostedSessionRunMode(targetSessionKey, currentSessionKey) {
  if (!targetSessionKey) return { kind: 'skip' }
  if (targetSessionKey === currentSessionKey) return { kind: 'current', sessionKey: targetSessionKey }
  return { kind: 'foreign', sessionKey: targetSessionKey }
}

export function ensureHostedBoundSession(config, sessionKey) {
  if (!config || !sessionKey) return false
  if (config.boundSessionKey === sessionKey) return false
  config.boundSessionKey = sessionKey
  return true
}
