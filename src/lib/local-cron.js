/**
 * 本地定时任务调度器（ClawPanel 内部）
 * 仅用于发送 user 消息到指定 sessionKey
 */
import { api } from './tauri-api.js'
import { wsClient } from './ws-client.js'

let _started = false
let _timer = null
let _busySessions = new Map()
let _pendingBySession = new Map()

function ensureCronConfig(cfg) {
  if (!cfg.cronLocal || typeof cfg.cronLocal !== 'object') {
    cfg.cronLocal = { jobs: [] }
  }
  if (!Array.isArray(cfg.cronLocal.jobs)) cfg.cronLocal.jobs = []
  return cfg
}

export async function loadLocalCronJobs() {
  const cfg = await api.readPanelConfig()
  ensureCronConfig(cfg)
  return cfg.cronLocal.jobs
}

export async function saveLocalCronJobs(jobs) {
  const cfg = await api.readPanelConfig()
  ensureCronConfig(cfg)
  cfg.cronLocal.jobs = jobs
  await api.writePanelConfig(cfg)
}

export async function addLocalCronJob(job) {
  const jobs = await loadLocalCronJobs()
  jobs.push(job)
  await saveLocalCronJobs(jobs)
}

export async function updateLocalCronJob(id, patch) {
  const jobs = await loadLocalCronJobs()
  const idx = jobs.findIndex(j => j.id === id)
  if (idx >= 0) {
    jobs[idx] = { ...jobs[idx], ...patch }
    await saveLocalCronJobs(jobs)
  }
}

export async function removeLocalCronJob(id) {
  const jobs = await loadLocalCronJobs()
  const next = jobs.filter(j => j.id !== id)
  await saveLocalCronJobs(next)
}

function parseCronField(field, min, max, current) {
  if (field === '*') return true
  if (field.includes('/')) {
    const [base, stepStr] = field.split('/')
    const step = Number(stepStr)
    if (!step || step <= 0) return false
    const start = base === '*' ? min : Number(base)
    if (Number.isNaN(start)) return false
    return (current - start) % step === 0
  }
  const num = Number(field)
  if (Number.isNaN(num)) return false
  return current === num
}

function cronMatch(expr, date) {
  const parts = String(expr || '').trim().split(' ')
  if (parts.length !== 5) return false
  const [min, hr, dom, mon, dow] = parts
  const m = date.getMinutes()
  const h = date.getHours()
  const d = date.getDate()
  const mo = date.getMonth() + 1
  const w = date.getDay()
  return (
    parseCronField(min, 0, 59, m) &&
    parseCronField(hr, 0, 23, h) &&
    parseCronField(dom, 1, 31, d) &&
    parseCronField(mon, 1, 12, mo) &&
    parseCronField(dow, 0, 6, w)
  )
}

function minuteKey(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function sendUserMessage(sessionKey, message) {
  if (!wsClient || !wsClient.gatewayReady) throw new Error('Gateway 未连接')
  await wsClient.chatSend(sessionKey, message)
}

async function flushPending(sessionKey) {
  const queue = _pendingBySession.get(sessionKey) || []
  if (!queue.length) return
  _pendingBySession.set(sessionKey, [])
  for (const item of queue) {
    try {
      await sendUserMessage(item.sessionKey, item.message)
      await updateLocalCronJob(item.jobId, { lastRunAtMs: Date.now(), lastStatus: 'success' })
    } catch (e) {
      await updateLocalCronJob(item.jobId, { lastRunAtMs: Date.now(), lastStatus: 'error', lastError: String(e) })
    }
  }
}

function markBusy(sessionKey, busy) {
  if (!sessionKey) return
  _busySessions.set(sessionKey, !!busy)
  if (!busy) flushPending(sessionKey)
}

export function startLocalCronScheduler() {
  if (_started) return
  _started = true

  wsClient.onEvent((msg) => {
    if (msg?.event !== 'chat') return
    const payload = msg.payload || {}
    const key = payload.sessionKey
    const state = payload.state
    if (!key || !state) return
    if (state === 'delta') markBusy(key, true)
    if (state === 'final') markBusy(key, false)
  })

  _timer = setInterval(async () => {
    try {
      const jobs = await loadLocalCronJobs()
      if (!jobs.length) return
      const now = new Date()
      const key = minuteKey(now)
      for (const job of jobs) {
        if (job.enabled === false) continue
        if (job.scheduleKind !== 'cron') continue
        if (!cronMatch(job.scheduleExpr, now)) continue
        if (job.lastRunKey === key) continue
        job.lastRunKey = key
        const sessionKey = job.sessionKey
        if (!sessionKey || !job.message) continue
        const busy = _busySessions.get(sessionKey)
        if (busy) {
          const queue = _pendingBySession.get(sessionKey) || []
          queue.push({ jobId: job.id, sessionKey, message: job.message })
          _pendingBySession.set(sessionKey, queue)
        } else {
          try {
            await sendUserMessage(sessionKey, job.message)
            job.lastRunAtMs = Date.now()
            job.lastStatus = 'success'
          } catch (e) {
            job.lastRunAtMs = Date.now()
            job.lastStatus = 'error'
            job.lastError = String(e)
          }
        }
      }
      await saveLocalCronJobs(jobs)
    } catch {}
  }, 60000)
}

export function stopLocalCronScheduler() {
  if (_timer) clearInterval(_timer)
  _timer = null
  _started = false
}
