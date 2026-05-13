import { navigate } from '../router.js'
import { t } from '../lib/i18n.js'
import { applyEngineSelection } from '../lib/engine-manager.js'
import { toast } from '../components/toast.js'

const PRIMARY_OPTIONS = [
  {
    id: 'openclaw',
    activeEngineId: 'openclaw',
    enabledEngineIds: ['openclaw'],
    targetRoute: '/setup',
  },
  {
    id: 'hermes',
    activeEngineId: 'hermes',
    enabledEngineIds: ['hermes'],
    targetRoute: '/h/setup',
  },
]

const SECONDARY_OPTIONS = [
  {
    id: 'both',
    activeEngineId: 'openclaw',
    enabledEngineIds: ['openclaw', 'hermes'],
    engineMode: 'both',
    targetRoute: '/setup',
  },
  {
    id: 'later',
    activeEngineId: 'openclaw',
    enabledEngineIds: [],
    deferred: true,
    targetRoute: '/engine-select',
  },
]

const ICONS = {
  openclaw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  hermes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
}

let _busy = false
let _revealEl = null
let _homeEl = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page engine-select-page es-monolith'
  page.innerHTML = `
    <div class="es-stage">
      <div class="es-panel es-panel-openclaw" data-engine="openclaw">
        <div class="es-glow es-glow-openclaw"></div>
      </div>
      <div class="es-panel es-panel-hermes" data-engine="hermes">
        <div class="es-glow es-glow-hermes"></div>
      </div>
      <div class="es-divider"></div>

      <div class="es-top-banner">${esc(t('engine.choiceTopBanner'))}</div>
      <div class="es-corner-mark es-corner-tl">CLAWPANEL</div>
      <div class="es-corner-mark es-corner-br" data-version-tag>v—</div>

      ${renderContent('openclaw')}
      ${renderContent('hermes')}

      <div class="es-secondary">
        <button type="button" class="es-secondary-link" data-secondary="both">${esc(t('engine.choiceSecondaryBoth'))}</button>
        <span class="es-secondary-sep" aria-hidden="true">·</span>
        <button type="button" class="es-secondary-link" data-secondary="later">${esc(t('engine.choiceSecondaryLater'))}</button>
      </div>
    </div>
  `

  // 注入版本号（package.json 同步，Vite define 注入）
  try {
    const v = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
    const tag = page.querySelector('[data-version-tag]')
    if (tag && v) tag.textContent = `v${v}`
  } catch (_) {}

  bindHover(page)
  bindClick(page)

  return page
}

function renderContent(id) {
  const num = id === 'openclaw' ? '01' : '02'
  const cap = id === 'openclaw' ? 'OpenClaw' : 'Hermes'
  const cat = id === 'openclaw' ? t('engine.choiceOpenclawCategory') : t('engine.choiceHermesCategory')
  const tagline = id === 'openclaw' ? t('engine.choiceOpenclawTagline') : t('engine.choiceHermesTagline')
  const feats = id === 'openclaw'
    ? [t('engine.choiceOpenclawFeat1'), t('engine.choiceOpenclawFeat2'), t('engine.choiceOpenclawFeat3')]
    : [t('engine.choiceHermesFeat1'), t('engine.choiceHermesFeat2'), t('engine.choiceHermesFeat3')]
  const cta = `${t('engine.choiceCtaEnter')} ${cap}`

  // OpenClaw（左上）：序号在前 / Hermes（右下）：序号在后
  const productRow = id === 'openclaw'
    ? `<span class="es-product-icon">${ICONS[id]}</span><span class="es-product-tag">${esc(num)} · ${esc(cat)}</span>`
    : `<span class="es-product-tag">${esc(cat)} · ${esc(num)}</span><span class="es-product-icon">${ICONS[id]}</span>`

  return `
    <div class="es-content es-content-${id}" data-engine-content="${id}">
      <div class="es-product-row">${productRow}</div>
      <div class="es-title">${esc(cap)}</div>
      <div class="es-tagline">${esc(tagline)}</div>
      <ul class="es-feature-list">
        ${feats.map(f => `<li>${esc(f)}</li>`).join('')}
      </ul>
      <button type="button" class="es-cta" data-engine-cta="${id}" tabindex="-1">
        ${id === 'openclaw' ? `<span>${esc(cta)}</span><span class="es-cta-arrow">→</span>` : `<span class="es-cta-arrow">→</span><span>${esc(cta)}</span>`}
      </button>
    </div>
  `
}

function bindHover(page) {
  // 用 attribute 替代 :has() — 兼容性更好（旧 WebKit / Linux WebKitGTK）
  const stage = page.querySelector('.es-stage')
  page.querySelectorAll('.es-panel').forEach(panel => {
    const engine = panel.dataset.engine
    panel.addEventListener('mouseenter', () => {
      if (_busy) return
      stage.dataset.hover = engine
    })
    panel.addEventListener('mouseleave', () => {
      if (_busy) return
      delete stage.dataset.hover
    })
  })
}

function bindClick(page) {
  const stage = page.querySelector('.es-stage')

  // 主区：点击三角形选引擎
  stage.addEventListener('click', (event) => {
    if (_busy) return
    const panel = event.target.closest('.es-panel')
    if (!panel) return
    const engine = panel.dataset.engine
    const option = PRIMARY_OPTIONS.find(o => o.id === engine)
    if (option) chooseWithAnimation(page, panel, option, engine)
  })

  // 次级链接：两个都要 / 稍后再说（无对角线动画，直接走选择）
  page.querySelectorAll('[data-secondary]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation()
      if (_busy) return
      const id = btn.dataset.secondary
      const option = SECONDARY_OPTIONS.find(o => o.id === id)
      if (!option) return
      _busy = true
      btn.classList.add('loading')
      try {
        await applyEngineSelection({
          activeEngineId: option.activeEngineId,
          enabledEngineIds: option.enabledEngineIds,
          deferred: !!option.deferred,
          choice: option.id,
          engineMode: option.engineMode || '',
        })
        toast(t('engine.choiceSaved'), 'success')
        navigate(option.targetRoute)
      } catch (error) {
        console.error('[engine-select] secondary choose failed:', error)
        toast(t('engine.choiceSaveFailed'), 'error')
        _busy = false
        btn.classList.remove('loading')
      }
    })
  })
}

async function chooseWithAnimation(page, panel, option, engine) {
  _busy = true
  const stage = page.querySelector('.es-stage')
  delete stage.dataset.hover
  stage.dataset.expanding = engine

  // 先把 reveal / home mock 节点 attach 到 body — 路由切换时它们不会被销毁
  ensureRevealNodes()

  // 阶段 1: 三角形扩满（CSS 通过 [data-expanding] 触发 clip-path 变化）
  // 阶段 2: 600ms 后开始中心圆扩散
  setTimeout(() => {
    _revealEl.dataset.engine = engine
    _revealEl.classList.add('es-reveal-active')
  }, 600)

  // 阶段 3: 1300ms 后保存选择 + 切换路由
  setTimeout(async () => {
    try {
      await applyEngineSelection({
        activeEngineId: option.activeEngineId,
        enabledEngineIds: option.enabledEngineIds,
        deferred: !!option.deferred,
        choice: option.id,
        engineMode: option.engineMode || '',
      })
      navigate(option.targetRoute)
      // 给新页面一点渲染时间后淡出 reveal 层
      setTimeout(() => {
        if (_revealEl) {
          _revealEl.classList.add('es-reveal-fadeout')
          setTimeout(() => removeRevealNodes(), 600)
        }
      }, 280)
    } catch (error) {
      console.error('[engine-select] choose failed:', error)
      toast(t('engine.choiceSaveFailed'), 'error')
      // 失败回退：移除动画层 + 解除 busy
      removeRevealNodes()
      delete stage.dataset.expanding
      _busy = false
    }
  }, 1300)
}

function ensureRevealNodes() {
  if (!_revealEl) {
    _revealEl = document.createElement('div')
    _revealEl.className = 'es-reveal'
    document.body.appendChild(_revealEl)
  }
  if (!_homeEl) {
    _homeEl = document.createElement('div')
    _homeEl.className = 'es-reveal-home'
    document.body.appendChild(_homeEl)
  }
}

function removeRevealNodes() {
  if (_revealEl) { _revealEl.remove(); _revealEl = null }
  if (_homeEl) { _homeEl.remove(); _homeEl = null }
  _busy = false
}

export function cleanup() {
  // 路由切走时不主动销毁 reveal 节点（动画完成后会自行淡出）
  // 这里仅重置 busy（防卡死）
  _busy = false
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
