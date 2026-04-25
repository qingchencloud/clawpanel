import { api } from '../../../lib/tauri-api.js'
import { t } from '../../../lib/i18n.js'
import { icon } from '../../../lib/icons.js'

const DAY_MS = 24 * 60 * 60 * 1000

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toNumber(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n : 0
}

function formatTokens(value) {
  const n = toNumber(value)
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.round(n))
}

function formatCost(value) {
  const n = toNumber(value)
  if (!n) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}

function toTimestamp(session) {
  const direct = toNumber(session?.started_at)
  if (direct > 0) return direct
  const raw = session?.created_at || session?.updated_at || ''
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

function toDateKey(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10)
}

function aggregateSessions(sessions) {
  const rows = Array.isArray(sessions) ? sessions.slice() : []
  const totalInputTokens = rows.reduce((sum, s) => sum + toNumber(s.input_tokens), 0)
  const totalOutputTokens = rows.reduce((sum, s) => sum + toNumber(s.output_tokens), 0)
  const totalTokens = totalInputTokens + totalOutputTokens
  const totalCacheTokens = rows.reduce((sum, s) => sum + toNumber(s.cache_read_tokens), 0)
  const estimatedCost = rows.reduce((sum, s) => {
    const cost = s.actual_cost_usd ?? s.estimated_cost_usd ?? 0
    return sum + toNumber(cost)
  }, 0)

  const modelMap = new Map()
  let oldestTs = 0
  for (const s of rows) {
    const model = s.model || t('usage.unknownModel')
    if (!modelMap.has(model)) {
      modelMap.set(model, {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        sessions: 0,
      })
    }
    const entry = modelMap.get(model)
    entry.inputTokens += toNumber(s.input_tokens)
    entry.outputTokens += toNumber(s.output_tokens)
    entry.cacheTokens += toNumber(s.cache_read_tokens)
    entry.totalTokens += toNumber(s.input_tokens) + toNumber(s.output_tokens)
    entry.sessions += 1

    const ts = toTimestamp(s)
    if (ts > 0 && (!oldestTs || ts < oldestTs)) oldestTs = ts
  }

  const now = new Date()
  const dailyMap = new Map()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dailyMap.set(key, { date: key, tokens: 0, cache: 0, sessions: 0, cost: 0 })
  }

  for (const s of rows) {
    const ts = toTimestamp(s)
    if (!ts) continue
    const key = toDateKey(ts)
    const entry = dailyMap.get(key)
    if (!entry) continue
    entry.tokens += toNumber(s.input_tokens) + toNumber(s.output_tokens)
    entry.cache += toNumber(s.cache_read_tokens)
    entry.sessions += 1
    entry.cost += toNumber(s.actual_cost_usd ?? s.estimated_cost_usd ?? 0)
  }

  const dailyUsage = [...dailyMap.values()]
  const modelUsage = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const days = oldestTs ? Math.max(1, Math.ceil((Date.now() - oldestTs * 1000) / DAY_MS)) : 1

  return {
    sessions: rows,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalSessions: rows.length,
    totalCacheTokens,
    cacheHitRate: totalInputTokens > 0 ? (totalCacheTokens / totalInputTokens) * 100 : null,
    estimatedCost,
    modelUsage,
    dailyUsage,
    avgSessionsPerDay: rows.length / days,
  }
}

function analyticsToUsage(data) {
  const totals = data?.totals || {}
  const totalInputTokens = toNumber(totals.total_input)
  const totalOutputTokens = toNumber(totals.total_output)
  const totalTokens = totalInputTokens + totalOutputTokens
  const totalCacheTokens = toNumber(totals.total_cache_read) + toNumber(totals.total_cache_write)
  const totalSessions = toNumber(totals.total_sessions)
  const estimatedCost = toNumber(totals.total_actual_cost || totals.total_estimated_cost)
  const periodDays = Math.max(1, toNumber(data?.period_days) || 30)
  const modelUsage = (Array.isArray(data?.by_model) ? data.by_model : []).map(model => {
    const inputTokens = toNumber(model.input_tokens)
    const outputTokens = toNumber(model.output_tokens)
    return {
      model: model.model || t('usage.unknownModel'),
      inputTokens,
      outputTokens,
      cacheTokens: toNumber(model.cache_read_tokens),
      totalTokens: inputTokens + outputTokens,
      sessions: toNumber(model.sessions),
    }
  }).sort((a, b) => b.totalTokens - a.totalTokens)
  const dailyUsage = (Array.isArray(data?.daily) ? data.daily : []).map(day => ({
    date: day.day || day.date || '',
    tokens: toNumber(day.input_tokens) + toNumber(day.output_tokens),
    cache: toNumber(day.cache_read_tokens),
    sessions: toNumber(day.sessions),
    cost: toNumber(day.actual_cost || day.estimated_cost),
  })).filter(day => day.date)
  return {
    sessions: [],
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalSessions,
    totalCacheTokens,
    cacheHitRate: totalInputTokens > 0 ? (totalCacheTokens / totalInputTokens) * 100 : null,
    estimatedCost,
    modelUsage,
    dailyUsage,
    avgSessionsPerDay: totalSessions / periodDays,
  }
}

function renderTrendSvg(dailyUsage) {
  if (!dailyUsage.length) return ''
  const width = 780
  const height = 220
  const padLeft = 12
  const padRight = 12
  const padTop = 12
  const padBottom = 28
  const usableWidth = width - padLeft - padRight
  const usableHeight = height - padTop - padBottom
  const maxTokens = Math.max(...dailyUsage.map(d => d.tokens), 1)
  const stepX = dailyUsage.length > 1 ? usableWidth / (dailyUsage.length - 1) : usableWidth
  const baseline = height - padBottom
  const barWidth = Math.max(8, Math.min(18, usableWidth / Math.max(dailyUsage.length, 1) - 5))

  const points = dailyUsage.map((d, index) => {
    const x = padLeft + stepX * index
    const y = baseline - (d.tokens / maxTokens) * usableHeight
    return { x, y, d }
  })

  const grid = [0.25, 0.5, 0.75, 1].map(scale => {
    const y = baseline - usableHeight * scale
    return `<line x1="${padLeft}" y1="${y.toFixed(2)}" x2="${width - padRight}" y2="${y.toFixed(2)}" class="hm-usage-trend-grid" />`
  }).join('')

  const areaPath = points.length
    ? `M ${points[0].x.toFixed(2)} ${baseline.toFixed(2)} L ${points.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')} L ${points[points.length - 1].x.toFixed(2)} ${baseline.toFixed(2)} Z`
    : ''
  const linePoints = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const bars = points.map(point => {
    const h = Math.max(2, baseline - point.y)
    return `<rect class="hm-usage-trend-bar" x="${(point.x - barWidth / 2).toFixed(2)}" y="${point.y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" rx="3">
      <title>${escHtml(point.d.date)} · ${formatTokens(point.d.tokens)} ${escHtml(t('usage.tokens'))} · ${point.d.sessions} ${escHtml(t('usage.sessions'))}</title>
    </rect>`
  }).join('')
  const dots = points.map(point => `<circle class="hm-usage-trend-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.6" />`).join('')

  return `
    <svg class="hm-usage-trend-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="hm-usage-trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(202, 138, 4, 0.34)" />
          <stop offset="100%" stop-color="rgba(202, 138, 4, 0.02)" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaPath}" class="hm-usage-trend-area" />
      ${bars}
      <polyline class="hm-usage-trend-line" points="${linePoints}" />
      ${dots}
    </svg>
  `
}

function renderStatCard(label, value, sub, tone = '') {
  return `
    <article class="hm-usage-stat-card ${tone}">
      <div class="hm-usage-stat-label">${escHtml(label)}</div>
      <div class="hm-usage-stat-value">${escHtml(value)}</div>
      <div class="hm-usage-stat-sub">${escHtml(sub || '')}</div>
    </article>
  `
}

function renderContent(usage) {
  const strongestModel = usage.modelUsage[0]?.totalTokens || 1
  const modelRows = usage.modelUsage.length
    ? usage.modelUsage.slice(0, 10).map(model => `
        <div class="hm-usage-model-row">
          <div class="hm-usage-model-name" title="${escHtml(model.model)}">${escHtml(model.model)}</div>
          <div class="hm-usage-model-track">
            <div class="hm-usage-model-bar" style="width:${Math.max(2, (model.totalTokens / strongestModel) * 100).toFixed(2)}%"></div>
          </div>
          <div class="hm-usage-model-meta">${escHtml(formatTokens(model.totalTokens))}</div>
        </div>
      `).join('')
    : `<div class="hm-usage-empty-inline">${escHtml(t('usage.noData'))}</div>`

  const trendRows = [...usage.dailyUsage].reverse().slice(0, 30).map(day => `
    <tr>
      <td>${escHtml(day.date)}</td>
      <td>${escHtml(formatTokens(day.tokens))}</td>
      <td>${escHtml(formatTokens(day.cache))}</td>
      <td>${escHtml(String(day.sessions))}</td>
      <td>${escHtml(formatCost(day.cost))}</td>
    </tr>
  `).join('')

  const rangeStart = usage.dailyUsage[0]?.date.slice(5) || '—'
  const rangeEnd = usage.dailyUsage[usage.dailyUsage.length - 1]?.date.slice(5) || '—'

  return `
    <div class="hm-usage-stat-grid">
      ${renderStatCard(
        t('usage.totalTokens'),
        formatTokens(usage.totalTokens),
        `${formatTokens(usage.totalInputTokens)} ${t('usage.inputTokens')} / ${formatTokens(usage.totalOutputTokens)} ${t('usage.outputTokens')}`,
        'is-accent'
      )}
      ${renderStatCard(
        t('usage.totalSessions'),
        String(usage.totalSessions),
        t('usage.avgPerDay').replace('{n}', usage.avgSessionsPerDay.toFixed(1))
      )}
      ${renderStatCard(
        t('usage.estimatedCost'),
        formatCost(usage.estimatedCost),
        usage.modelUsage[0]?.model || t('usage.unknownModel')
      )}
      ${renderStatCard(
        t('usage.cacheHitRate'),
        usage.cacheHitRate == null ? '--' : usage.cacheHitRate.toFixed(1) + '%',
        `${formatTokens(usage.totalCacheTokens)} ${t('usage.tokens')}`,
        'is-muted'
      )}
    </div>

    <section class="hm-usage-card">
      <div class="hm-usage-card-head">
        <h2 class="hm-usage-card-title">${escHtml(t('usage.modelBreakdown'))}</h2>
      </div>
      <div class="hm-usage-model-list">${modelRows}</div>
    </section>

    <section class="hm-usage-card hm-usage-card--trend">
      <div class="hm-usage-card-head">
        <h2 class="hm-usage-card-title">${escHtml(t('usage.dailyTrend'))}</h2>
      </div>
      <div class="hm-usage-trend-wrap">${renderTrendSvg(usage.dailyUsage)}</div>
      <div class="hm-usage-trend-range">
        <span>${escHtml(rangeStart)}</span>
        <span>${escHtml(rangeEnd)}</span>
      </div>
      <div class="hm-usage-table-wrap">
        <table class="hm-usage-table">
          <thead>
            <tr>
              <th>${escHtml(t('usage.date'))}</th>
              <th>${escHtml(t('usage.tokens'))}</th>
              <th>${escHtml(t('usage.cache'))}</th>
              <th>${escHtml(t('usage.sessions'))}</th>
              <th>${escHtml(t('usage.cost'))}</th>
            </tr>
          </thead>
          <tbody>${trendRows}</tbody>
        </table>
      </div>
    </section>
  `
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page hm-usage-page'
  el.dataset.engine = 'hermes'

  let loading = true
  let sessions = []
  let analytics = null
  let error = ''
  let alive = true

  function draw() {
    const usage = analytics ? analyticsToUsage(analytics) : aggregateSessions(sessions)
    el.innerHTML = `
      <section class="hm-usage-hero">
        <div class="hm-usage-hero-copy">
          <div class="hm-usage-eyebrow">HERMES AGENT · ANALYTICS</div>
          <h1 class="hm-usage-title">${escHtml(t('usage.title'))}</h1>
          <p class="hm-usage-desc">${escHtml(t('usage.desc'))}</p>
        </div>
        <button class="hm-btn hm-btn--ghost hm-btn--sm hm-usage-refresh" id="hm-usage-refresh" ${loading ? 'disabled' : ''}>
          ${icon('refresh-cw', 14)}
          <span>${escHtml(t('usage.refresh'))}</span>
        </button>
      </section>

      <div class="hm-usage-body">
        ${loading && !usage.totalSessions ? `
          <div class="hm-usage-loading">${escHtml(t('common.loading'))}</div>
        ` : error ? `
          <div class="hm-usage-error-card">
            <div class="hm-usage-error-title">${escHtml(t('usage.loadFailed'))}</div>
            <div class="hm-usage-error-text">${escHtml(error)}</div>
            <button class="hm-btn hm-btn--primary hm-btn--sm" id="hm-usage-retry">${escHtml(t('usage.retry'))}</button>
          </div>
        ` : !usage.totalSessions ? `
          <div class="hm-usage-empty">${escHtml(t('usage.noData'))}</div>
        ` : renderContent(usage)}
      </div>
    `

    el.querySelector('#hm-usage-refresh')?.addEventListener('click', load)
    el.querySelector('#hm-usage-retry')?.addEventListener('click', load)
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      analytics = await api.hermesUsageAnalytics(30)
      if (!alive) return
      sessions = []
    } catch (err) {
      if (!alive) return
      try {
        const rows = await api.hermesSessionsList(null, null)
        if (!alive) return
        sessions = Array.isArray(rows) ? rows : []
        analytics = null
      } catch (_) {
        error = err?.message || String(err)
      }
    } finally {
      if (!alive) return
      loading = false
      draw()
    }
  }

  const mo = new MutationObserver(() => {
    if (!el.isConnected) {
      alive = false
      mo.disconnect()
    }
  })

  requestAnimationFrame(() => {
    if (el.parentNode) mo.observe(el.parentNode, { childList: true })
  })

  draw()
  load()
  return el
}
