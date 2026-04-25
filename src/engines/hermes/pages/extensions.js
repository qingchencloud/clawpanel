import { api } from '../../../lib/tauri-api.js'
import { icon } from '../../../lib/icons.js'
import { toast } from '../../../components/toast.js'
import { t } from '../../../lib/i18n.js'

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTokens(value) {
  const n = Number(value || 0)
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}

function formatCost(value) {
  const n = Number(value || 0)
  if (!n) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}

export function render() {
  const el = document.createElement('div')
  el.className = 'page hm-extensions-page'
  el.dataset.engine = 'hermes'

  let loading = true
  let themes = []
  let activeTheme = 'default'
  let plugins = []
  let analytics = null
  let error = ''

  const docs = [
    ['engine.extensionsDocGettingStarted', 'https://hermes-agent.nousresearch.com/docs/getting-started/installation/'],
    ['engine.extensionsDocCron', 'https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron/'],
    ['engine.extensionsDocSkills', 'https://hermes-agent.nousresearch.com/docs/guides/skills/'],
    ['engine.extensionsDocDashboard', 'http://127.0.0.1:9119/'],
  ]

  function draw() {
    const totals = analytics?.totals || {}
    const tokens = Number(totals.total_input || 0) + Number(totals.total_output || 0)
    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">${esc(t('engine.extensionsEyebrow'))}</div>
          <h1 class="hm-hero-h1">${esc(t('engine.extensionsTitle'))}</h1>
          <div class="hm-hero-sub">${esc(t('engine.extensionsDesc'))}</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-ext-refresh" ${loading ? 'disabled' : ''}>${icon('refresh-cw', 14)}${esc(t('engine.extensionsRefresh'))}</button>
          <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-ext-rescan" ${loading ? 'disabled' : ''}>${icon('package', 14)}${esc(t('engine.extensionsRescan'))}</button>
        </div>
      </div>

      ${error ? `<div class="hm-panel" style="margin-bottom:16px"><div class="hm-panel-body" style="color:var(--hm-error)">${esc(error)}</div></div>` : ''}

      <div class="hm-grid hm-grid--2" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;margin-bottom:18px">
        <section class="hm-panel">
          <div class="hm-panel-header"><div class="hm-panel-title">${esc(t('engine.extensionsDocs'))}</div></div>
          <div class="hm-panel-body" style="display:grid;gap:10px">
            ${docs.map(([labelKey, href]) => `<a class="hm-native-dashboard-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(t(labelKey))} <span>↗</span></a>`).join('')}
          </div>
        </section>

        <section class="hm-panel">
          <div class="hm-panel-header"><div class="hm-panel-title">${esc(t('engine.extensionsAnalytics'))}</div></div>
          <div class="hm-panel-body">
            <div class="hm-kpi-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
              <div class="hm-kpi"><div class="hm-kpi-label">${esc(t('engine.extensionsSessions'))}</div><div class="hm-kpi-value">${esc(totals.total_sessions || 0)}</div></div>
              <div class="hm-kpi"><div class="hm-kpi-label">${esc(t('engine.extensionsTokens'))}</div><div class="hm-kpi-value">${esc(formatTokens(tokens))}</div></div>
              <div class="hm-kpi"><div class="hm-kpi-label">${esc(t('engine.extensionsCost'))}</div><div class="hm-kpi-value">${esc(formatCost(totals.total_actual_cost || totals.total_estimated_cost))}</div></div>
            </div>
          </div>
        </section>
      </div>

      <div class="hm-grid hm-grid--2" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px">
        <section class="hm-panel">
          <div class="hm-panel-header">
            <div class="hm-panel-title">${esc(t('engine.extensionsThemes'))}</div>
            <div class="hm-panel-actions"><span class="hm-muted">${esc(t('engine.extensionsActive'))}: ${esc(activeTheme)}</span></div>
          </div>
          <div class="hm-panel-body" style="display:grid;gap:10px">
            ${themes.length ? themes.map(theme => `
              <button class="hm-btn ${theme.name === activeTheme ? 'hm-btn--cta' : 'hm-btn--ghost'} hm-theme-choice" data-theme="${esc(theme.name)}" style="justify-content:flex-start;text-align:left;height:auto;padding:12px 14px">
                <span style="display:grid;gap:3px">
                  <strong>${esc(theme.label || theme.name)}</strong>
                  <span class="hm-muted">${esc(theme.description || theme.name)}</span>
                </span>
              </button>
            `).join('') : `<div class="hm-muted">${esc(t('engine.extensionsNoThemes'))}</div>`}
          </div>
        </section>

        <section class="hm-panel">
          <div class="hm-panel-header">
            <div class="hm-panel-title">${esc(t('engine.extensionsPlugins'))}</div>
            <div class="hm-panel-actions"><span class="hm-muted">${esc(t('engine.extensionsManifestCount').replace('{n}', plugins.length))}</span></div>
          </div>
          <div class="hm-panel-body" style="display:grid;gap:10px">
            ${plugins.length ? plugins.map(plugin => `
              <article style="padding:12px 14px;border:1px solid var(--hm-border);border-radius:var(--hm-radius-sm);background:var(--hm-surface-0)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px">
                  <strong>${esc(plugin.label || plugin.name)}</strong>
                  <span class="hm-muted">v${esc(plugin.version || '0.0.0')}</span>
                </div>
                <div class="hm-muted" style="line-height:1.6">${esc(plugin.description || t('engine.extensionsNoDescription'))}</div>
                <div class="hm-muted" style="margin-top:6px;font-family:var(--hm-font-mono);font-size:11px">${esc(plugin.tab?.path || '')}${plugin.has_api ? ' · API' : ''}</div>
              </article>
            `).join('') : `<div class="hm-muted">${esc(t('engine.extensionsNoPlugins'))}</div>`}
          </div>
        </section>
      </div>
    `

    el.querySelector('#hm-ext-refresh')?.addEventListener('click', load)
    el.querySelector('#hm-ext-rescan')?.addEventListener('click', rescan)
    el.querySelectorAll('.hm-theme-choice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.theme
        if (!name || name === activeTheme) return
        try {
          await api.hermesDashboardThemeSet(name)
          activeTheme = name
          toast(t('engine.extensionsThemeSaved'), 'success')
          draw()
        } catch (err) {
          toast(String(err?.message || err).replace(/^Error:\s*/, ''), 'error')
        }
      })
    })
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      const [themeData, pluginData, usageData] = await Promise.all([
        api.hermesDashboardThemes(),
        api.hermesDashboardPlugins(),
        api.hermesUsageAnalytics(30),
      ])
      themes = Array.isArray(themeData?.themes) ? themeData.themes : []
      activeTheme = themeData?.active || 'default'
      plugins = Array.isArray(pluginData) ? pluginData : []
      analytics = usageData || null
    } catch (err) {
      error = String(err?.message || err).replace(/^Error:\s*/, '')
    } finally {
      loading = false
      draw()
    }
  }

  async function rescan() {
    try {
      await api.hermesDashboardPluginsRescan()
      await load()
      toast(t('engine.extensionsPluginsRescanned'), 'success')
    } catch (err) {
      toast(String(err?.message || err).replace(/^Error:\s*/, ''), 'error')
    }
  }

  draw()
  load()
  return el
}
