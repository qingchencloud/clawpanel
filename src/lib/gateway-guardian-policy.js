export const MAX_AUTO_RESTART = 3
export const RESTART_COOLDOWN = 60 * 1000
export const STABLE_RUNNING_MS = 5 * 60 * 1000

export function shouldResetAutoRestartCount({ autoRestartCount = 0, runningSince = 0, now = Date.now() } = {}) {
  if (autoRestartCount <= 0 || !runningSince) return false
  return now - runningSince >= STABLE_RUNNING_MS
}

export function evaluateAutoRestartAttempt({ now = Date.now(), lastRestartTime = 0, autoRestartCount = 0 } = {}) {
  if (autoRestartCount >= MAX_AUTO_RESTART) return { action: 'give_up' }
  if (now - lastRestartTime < RESTART_COOLDOWN) return { action: 'cooldown' }
  return {
    action: 'restart',
    autoRestartCount: autoRestartCount + 1,
    lastRestartTime: now,
  }
}
