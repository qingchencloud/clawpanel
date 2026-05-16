/**
 * Hermes lazy_deps 依赖管理（P1-3）
 *
 * 列出 Hermes 内核 LAZY_DEPS allowlist 的所有 feature（platform.* / tts.* / stt.* /
 * search.* / provider.* / memory.* / image.*），显示安装状态，提供「装」按钮。
 *
 * 解决「用户配好渠道首次启动 Gateway 卡 30 秒后崩」的常见 bug ——
 * 让用户能在「启动 Gateway 之前」主动预装。
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import { humanizeError } from '../../../lib/humanize-error.js'
import { svgIcon } from '../lib/svg-icons.js'

// feature 分类配置（决定分组顺序 + 图标 + 文案）
const CATEGORIES = [
  { prefix: 'platform.', icon: 'message-square', titleKey: 'hermesLazyDeps.catPlatform' },
  { prefix: 'tts.',      icon: 'volume',         titleKey: 'hermesLazyDeps.catTts' },
  { prefix: 'stt.',      icon: 'mic',            titleKey: 'hermesLazyDeps.catStt' },
  { prefix: 'search.',   icon: 'search',         titleKey: 'hermesLazyDeps.catSearch' },
  { prefix: 'provider.', icon: 'shield',         titleKey: 'hermesLazyDeps.catProvider' },
  { prefix: 'memory.',   icon: 'inbox',          titleKey: 'hermesLazyDeps.catMemory' },
  { prefix: 'image.',    icon: 'image',          titleKey: 'hermesLazyDeps.catImage' },
]

const DESC_OVERRIDE_KEY = 'hermesLazyDeps.descOverride'  // i18n.key 下的 feature → 描述

// 把 feature 按分类分组
function groupByCategory(features) {
  const groups = CATEGORIES.map(c => ({ ...c, items: [] }))
  const other = { prefix: '', icon: 'file', titleKey: 'hermesLazyDeps.catOther', items: [] }
  for (const f of features) {
    const cat = groups.find(g => f.feature.startsWith(g.prefix))
    if (cat) cat.items.push(f)
    else other.items.push(f)
  }
  return [...groups.filter(g => g.items.length > 0), ...(other.items.length ? [other] : [])]
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.dataset.engine = 'hermes'
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${t('hermesLazyDeps.title')}</h1>
        <p class="page-desc">${t('hermesLazyDeps.desc')}</p>
      </div>
      <div class="config-actions">
        <button class="btn btn-secondary btn-sm" id="btn-refresh">${t('hermesLazyDeps.refresh')}</button>
      </div>
    </div>
    <div id="lazy-deps-content">
      <div style="padding:32px;text-align:center;color:var(--text-tertiary)">
        ${t('common.loading')}…
      </div>
    </div>
  `

  loadAndRender(page)
  page.querySelector('#btn-refresh').onclick = () => loadAndRender(page)
  return page
}

async function loadAndRender(page) {
  const content = page.querySelector('#lazy-deps-content')
  content.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-tertiary)">${t('common.loading')}…</div>`

  let featuresResp
  try {
    featuresResp = await api.hermesLazyDepsFeatures()
  } catch (e) {
    // 这里 Rust 端通常会给非常具体的中文提示（如「Hermes venv 未找到（~/.hermes-venv 不存在）。请先安装 Hermes。」），
    // 但 humanize-error 看到「未找到」三个字会把它归类为 notFound 并用通用模板「请确认目标资源是否仍存在」替代——
    // 反而把真正可操作的安装提示遮住了。这里优先展示 raw（原始消息），让用户看到「请先安装 Hermes」。
    const h = humanizeError(e, t('hermesLazyDeps.loadFailed'))
    const detail = h.raw || h.hint || ''
    content.innerHTML = `
      <div style="color:var(--error);padding:20px;line-height:1.6">
        <div style="font-weight:500">${escapeHtml(h.message)}</div>
        ${detail ? `<div style="margin-top:6px;font-size:12px;opacity:0.85;white-space:pre-wrap">${escapeHtml(detail)}</div>` : ''}
      </div>
    `
    return
  }

  if (!featuresResp?.ok) {
    content.innerHTML = `<div style="color:var(--error);padding:20px">${escapeHtml(t('hermesLazyDeps.loadFailed'))}: ${escapeHtml(featuresResp?.error || 'unknown')}</div>`
    return
  }

  const features = featuresResp.features || []
  if (!features.length) {
    content.innerHTML = `<div class="empty-state empty-compact">
      <div class="empty-icon">${svgIcon('inbox', { size: 32 })}</div>
      <div class="empty-title">${escapeHtml(t('hermesLazyDeps.emptyTitle'))}</div>
    </div>`
    return
  }

  // 批量查状态
  let status = {}
  try {
    const statusResp = await api.hermesLazyDepsStatus(features.map(f => f.feature))
    status = statusResp?.ok ? (statusResp.status || {}) : {}
  } catch (e) {
    // 状态查询失败也允许渲染（按未知处理）
    console.warn('lazy_deps status failed:', e)
  }

  const groups = groupByCategory(features)
  content.innerHTML = groups.map(g => renderGroup(g, status)).join('')

  // 绑定每个 feature 的「装」按钮
  content.querySelectorAll('button[data-feature]').forEach(btn => {
    btn.onclick = () => onEnsureClick(page, btn.dataset.feature, btn)
  })
}

function renderGroup(group, status) {
  const items = group.items.map(f => renderItem(f, status[f.feature])).join('')
  return `
    <div class="config-section">
      <div class="config-section-title">
        <span style="display:inline-flex;align-items:center;color:var(--accent);margin-right:8px">${svgIcon(group.icon, { size: 18 })}</span>
        ${escapeHtml(t(group.titleKey))}
      </div>
      <div class="lazy-deps-grid">
        ${items}
      </div>
    </div>
  `
}

function renderItem(f, st) {
  const satisfied = st && st.satisfied
  const known = st ? st.known : true
  const missing = st?.missing || []
  const specsTitle = (f.specs || []).join('\n')
  const featureLabel = featureDisplayName(f.feature)
  const stateBadge = satisfied
    ? `<span class="lazy-deps-badge ok">${svgIcon('check', { size: 11 })} ${escapeHtml(t('hermesLazyDeps.installed'))}</span>`
    : (known
      ? `<span class="lazy-deps-badge warn">${escapeHtml(t('hermesLazyDeps.notInstalled'))}</span>`
      : `<span class="lazy-deps-badge unknown">?</span>`)
  const installBtn = satisfied
    ? `<button class="btn btn-sm btn-secondary" data-feature="${escapeAttr(f.feature)}" data-action="reinstall">${escapeHtml(t('hermesLazyDeps.reinstall'))}</button>`
    : `<button class="btn btn-sm btn-primary" data-feature="${escapeAttr(f.feature)}" data-action="install">${escapeHtml(t('hermesLazyDeps.install'))}</button>`
  const missingHint = !satisfied && missing.length
    ? `<div class="lazy-deps-missing" title="${escapeAttr(missing.join('\n'))}">${escapeHtml(t('hermesLazyDeps.missingCount', { n: missing.length }))}</div>`
    : ''
  return `
    <div class="lazy-deps-card">
      <div class="lazy-deps-card-head">
        <div class="lazy-deps-card-title" title="${escapeAttr(f.feature)}">${escapeHtml(featureLabel)}</div>
        ${stateBadge}
      </div>
      <div class="lazy-deps-card-meta" title="${escapeAttr(specsTitle)}">${escapeHtml((f.specs || []).join(', '))}</div>
      ${missingHint}
      <div class="lazy-deps-card-actions">
        ${installBtn}
      </div>
    </div>
  `
}

// 映射 feature → 友好显示名（兼容 i18n 缺词时 fallback 到原名）
function featureDisplayName(feature) {
  const friendly = t('hermesLazyDeps.featureName.' + feature)
  // i18n 没翻译时 t() 返回 key 本身，做 fallback
  if (friendly && !friendly.endsWith('.' + feature)) return friendly
  return feature
}

async function onEnsureClick(page, feature, btn) {
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('hermesLazyDeps.installing') + '…'
  try {
    const resp = await api.hermesLazyDepsEnsure(feature)
    if (resp?.ok) {
      const installed = resp.installed || []
      if (resp.alreadySatisfied) {
        toast(t('hermesLazyDeps.alreadyInstalled', { feature }), 'success')
      } else {
        toast({
          message: t('hermesLazyDeps.installSuccess', { feature }),
          hint: installed.length
            ? t('hermesLazyDeps.installedSpecs', { specs: installed.join(', ') })
            : '',
        }, 'success')
      }
    } else {
      toast(humanizeError(resp?.error || 'unknown', t('hermesLazyDeps.installFailed', { feature })), 'error')
    }
  } catch (e) {
    toast(humanizeError(e, t('hermesLazyDeps.installFailed', { feature })), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = origText
    // 装完刷新整张页面状态
    setTimeout(() => loadAndRender(page), 600)
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escapeAttr(s) { return escapeHtml(s) }
