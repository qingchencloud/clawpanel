/**
 * 使用情况页面 — 对接 OpenClaw Gateway sessions.usage API
 * 展示 Token 用量、费用、Top Models/Providers/Tools/Agents 等分析数据
 */
import { wsClient } from '../lib/ws-client.js'
import { toast } from '../components/toast.js'
import { icon } from '../lib/icons.js'

let _page = null, _unsubReady = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  _page = page

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">使用情况</h1>
      <p class="page-desc">查看 Token 消耗、API 费用和模型使用统计</p>
    </div>
    <div class="usage-toolbar" style="display:flex;gap:8px;align-items:center;margin-bottom:var(--space-lg);flex-wrap:wrap">
      <button class="btn btn-sm ${_days === 1 ? 'btn-primary' : 'btn-secondary'}" data-days="1">今天</button>
      <button class="btn btn-sm ${_days === 7 ? 'btn-primary' : 'btn-secondary'}" data-days="7">7天</button>
      <button class="btn btn-sm ${_days === 30 ? 'btn-primary' : 'btn-secondary'}" data-days="30">30天</button>
      <button class="btn btn-sm btn-secondary" id="btn-usage-refresh">${icon('refresh-cw', 14)} 刷新</button>
    </div>
    <div id="usage-content">
      <div class="stat-card loading-placeholder" style="height:120px"></div>
    </div>
  `

  page.querySelectorAll('[data-days]').forEach(btn => {
    btn.onclick = () => {
      _days = parseInt(btn.dataset.days)
      page.querySelectorAll('[data-days]').forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-secondary') })
      btn.classList.remove('btn-secondary'); btn.classList.add('btn-primary')
      loadUsage(page)
    }
  })
  page.querySelector('#btn-usage-refresh')?.addEventListener('click', () => loadUsage(page))

  loadUsage(page)
  return page
}

export function cleanup() {
  _page = null
  if (_unsubReady) { _unsubReady(); _unsubReady = null }
}

let _days = 7

async function loadUsage(page) {
  const el = page.querySelector('#usage-content')
  el.innerHTML = `<div class="usage-loading-stack"><div class="stat-card loading-placeholder" style="height:120px"></div>
    <div class="stat-card loading-placeholder" style="height:200px"></div></div>`

  if (!wsClient.connected) {
    el.innerHTML = `<div class="usage-empty">
      <div style="color:var(--text-tertiary);margin-bottom:8px">Gateway 连接中...</div>
      <div class="form-hint">等待 Gateway 连接就绪后自动加载</div>
    </div>`
    // 自动等待连接就绪后重试
    if (_unsubReady) _unsubReady()
    _unsubReady = wsClient.onReady(() => {
      if (_unsubReady) { _unsubReady(); _unsubReady = null }
      if (_page) loadUsage(_page)
    })
    return
  }

  try {
    const now = new Date()
    const end = now.toISOString().slice(0, 10)
    const start = new Date(now.getTime() - (_days - 1) * 86400000).toISOString().slice(0, 10)
    const data = await wsClient.request('sessions.usage', { startDate: start, endDate: end, limit: 20 })
    renderUsage(el, data)
  } catch (e) {
    el.innerHTML = `<div class="usage-empty">
      <div class="usage-error-title">加载失败: ${esc(e?.message || e)}</div>
      <div class="form-hint">可能需要更新 OpenClaw 到 2026.3.11+ 以支持 Usage API</div>
      <button class="btn btn-secondary btn-sm usage-retry-btn" onclick="this.closest('.page').querySelector('#btn-usage-refresh').click()">重试</button>
    </div>`
  }
}

function renderUsage(el, data) {
  if (!data) { el.innerHTML = '<div class="usage-empty">暂无数据</div>'; return }

  const t = data.totals || {}
  const a = data.aggregates || {}
  const msgs = a.messages || {}
  const tools = a.tools || {}

  const fmtTokens = (n) => {
    if (n == null || n === 0) return '0'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return String(n)
  }
  const fmtCost = (n) => n != null && n > 0 ? '$' + n.toFixed(4) : '$0'
  const fmtRate = (errors, total) => {
    if (!total) return '—'
    const pct = (errors / total * 100).toFixed(1)
    return pct + '%'
  }

  // ── 概览卡片 ──
  const overviewHtml = `
    <div class="stat-cards" style="margin-bottom:var(--space-lg)">
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">消息</span></div>
        <div class="stat-card-value">${msgs.total || 0}</div>
        <div class="stat-card-meta">${msgs.user || 0} 用户 · ${msgs.assistant || 0} 助手</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">工具调用</span></div>
        <div class="stat-card-value">${tools.totalCalls || 0}</div>
        <div class="stat-card-meta">${tools.uniqueTools || 0} 种工具</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">错误</span></div>
        <div class="stat-card-value">${msgs.errors || 0}</div>
        <div class="stat-card-meta">错误率 ${fmtRate(msgs.errors, msgs.total)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Token 总量</span></div>
        <div class="stat-card-value">${fmtTokens(t.totalTokens)}</div>
        <div class="stat-card-meta">${fmtTokens(t.input)} 输入 · ${fmtTokens(t.output)} 输出</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">费用</span></div>
        <div class="stat-card-value">${fmtCost(t.totalCost)}</div>
        <div class="stat-card-meta">${fmtCost(t.inputCost)} 输入 · ${fmtCost(t.outputCost)} 输出</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">会话</span></div>
        <div class="stat-card-value">${(data.sessions || []).length}</div>
        <div class="stat-card-meta">${data.startDate || ''} ~ ${data.endDate || ''}</div>
      </div>
    </div>
  `

  // ── Top 排行 ──
  const renderTop = (title, items, keyFn, valueFn, metaFn) => {
    if (!items || !items.length) return ''
    const rows = items.slice(0, 5).map(item => `
      <div class="usage-top-row">
        <span class="usage-top-key">${esc(keyFn(item))}</span>
        <span class="usage-top-value">${valueFn(item)}</span>
      </div>
    `).join('')
    return `
      <div class="usage-top-card">
        <div class="usage-top-title">${title}</div>
        ${rows}
      </div>
    `
  }

  const topModels = renderTop('热门模型',
    a.byModel, m => m.model || '未知', m => fmtCost(m.totals?.totalCost) + ' · ' + fmtTokens(m.totals?.totalTokens))
  const topProviders = renderTop('热门服务商',
    a.byProvider, p => p.provider || '未知', p => fmtCost(p.totals?.totalCost) + ' · ' + p.count + ' 次')
  const topTools = renderTop('热门工具',
    (tools.tools || []), t => t.name, t => t.count + ' 次调用')
  const topAgents = renderTop('热门 Agent',
    a.byAgent, a => a.agentId || 'main', a => fmtCost(a.totals?.totalCost))
  const topChannels = renderTop('热门渠道',
    a.byChannel, c => c.channel || 'webchat', c => fmtCost(c.totals?.totalCost))

  const topsHtml = `<div class="usage-tops-grid">${topModels}${topProviders}${topTools}${topAgents}${topChannels}</div>`

  // ── Token 分类 ──
  const tokenBreakdownHtml = `
    <div class="config-section usage-section">
      <div class="config-section-title">Token 分类</div>
      <div class="usage-token-breakdown">
        <div class="usage-token-item"><span class="usage-token-dot" style="background:var(--error)"></span>输出 ${fmtTokens(t.output)}</div>
        <div class="usage-token-item"><span class="usage-token-dot" style="background:var(--accent)"></span>输入 ${fmtTokens(t.input)}</div>
        <div class="usage-token-item"><span class="usage-token-dot" style="background:var(--success)"></span>缓存读取 ${fmtTokens(t.cacheRead)}</div>
        <div class="usage-token-item"><span class="usage-token-dot" style="background:var(--warning)"></span>缓存写入 ${fmtTokens(t.cacheWrite)}</div>
      </div>
    </div>
  `

  // ── 每日用量 ──
  const daily = a.daily || []
  let dailyHtml = ''
  if (daily.length > 0) {
    const maxTokens = Math.max(...daily.map(d => d.tokens || 0), 1)
    const bars = daily.map(d => {
      const pct = Math.max(1, Math.round((d.tokens || 0) / maxTokens * 100))
      const date = (d.date || '').slice(5) // MM-DD
      return `<div class="usage-daily-bar-wrap" title="${d.date}: ${fmtTokens(d.tokens)} tokens · ${d.messages || 0} msgs">
        <div class="usage-daily-bar" style="height:${pct}%"></div>
        <div class="usage-daily-label">${date}</div>
      </div>`
    }).join('')
    dailyHtml = `
      <div class="config-section" style="margin-top:var(--space-lg)">
        <div class="config-section-title">每日用量</div>
        <div class="usage-daily-chart">${bars}</div>
      </div>
    `
  }

  // ── 会话列表 ──
  const sessions = (data.sessions || []).slice(0, 10)
  let sessionsHtml = ''
  if (sessions.length > 0) {
    const rows = sessions.map(s => {
      const u = s.usage || {}
      const key = esc(s.key || '').replace(/^agent:main:/, '')
      const model = s.model || u.modelUsage?.[0]?.model || ''
      const provider = u.modelUsage?.[0]?.provider || s.modelProvider || ''
      return `<div class="session-row">
        <div class="session-row-header">
          <span class="session-key" title="${esc(s.key || '')}">${key || s.sessionId?.slice(0, 12) || '—'}</span>
          ${s.agentId ? `<span class="session-flag">${esc(s.agentId)}</span>` : ''}
          ${model ? `<span class="session-model">${esc(model)}</span>` : ''}
          ${provider ? `<span class="session-flag">${esc(provider)}</span>` : ''}
        </div>
        <div class="session-row-meta">${fmtTokens(u.totalTokens)} tokens · ${fmtCost(u.totalCost)} · ${(u.messageCounts?.total || 0)} msgs${u.messageCounts?.errors ? ' · ' + u.messageCounts.errors + ' err' : ''}</div>
      </div>`
    }).join('')
    sessionsHtml = `
      <div class="config-section usage-section-block">
        <div class="config-section-title">会话明细 <span class="usage-section-note">最近 ${sessions.length} 个</span></div>
        <div class="session-list">${rows}</div>
      </div>
    `
  }

  el.innerHTML = overviewHtml + topsHtml + tokenBreakdownHtml + dailyHtml + sessionsHtml
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
