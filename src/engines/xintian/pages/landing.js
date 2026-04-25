/**
 * 心甜Claw · 产品落地页
 * ------------------------------------------------------------------
 * 面向 Windows 桌面客户端的产品宣传 + 下载引导页。
 * 所有可见文本走 i18n（engine.xt*），对外链接统一经过 openExternal()
 * 在 Tauri 桌面端走 @tauri-apps/plugin-shell，Web 端回退到 window.open。
 */
import { t } from '../../../lib/i18n.js'

const WEBSITE_URL  = 'https://xtclaw.xtnet.cc/'
const DOWNLOAD_URL = 'https://xtclaw.xtnet.cc/download'
const HELP_URL     = 'https://xtclaw.xtnet.cc/articles'
// 新版六边形品牌图标（和 xintian-claw 桌面端同源）
const LOGO_SRC     = '/images/xintian/logo-icon-128.png'
const LOGO_SRC_2X  = '/images/xintian/logo-icon-256.png'
const LOGO_SRC_SM  = '/images/xintian/logo-icon-64.png'

// -------- 图标库（统一 stroke 风格，对齐编辑风品牌） --------
const ICON = {
  heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.8 15.9 9 18.75 8.2 15.9a4.5 4.5 0 0 0-3.1-3.1L2.25 12l2.85-.8a4.5 4.5 0 0 0 3.1-3.1L9 5.25l.8 2.85a4.5 4.5 0 0 0 3.1 3.1L15.75 12l-2.85.8a4.5 4.5 0 0 0-3.1 3.1z"/><path d="M18.26 8.72 18 9.75l-.26-1.03a3.38 3.38 0 0 0-2.46-2.46L14.25 6l1.03-.26a3.38 3.38 0 0 0 2.46-2.46L18 2.25l.26 1.03a3.38 3.38 0 0 0 2.46 2.46L21.75 6l-1.03.26a3.38 3.38 0 0 0-2.46 2.46z"/></svg>`,
  brain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3 3 3 0 0 0-3 3v1a3 3 0 0 0-2 5.5A3 3 0 0 0 7 19a3 3 0 0 0 5 1.5 3 3 0 0 0 5-1.5 3 3 0 0 0 3-4.5A3 3 0 0 0 18 9V8a3 3 0 0 0-3-3 3 3 0 0 0-3-3z"/><path d="M12 5v15"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/><path d="M20 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h7"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 7 12 12 15 14"/></svg>`,
  skills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  channels: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  windows: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.47 10.5 4.45v7.02H3V5.47zM10.5 12.53v7.02L3 18.53v-6zm1.12-8.24L22 3v8.47H11.62V4.29zM22 12.53V21l-10.38-1.3v-7.17H22z"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  arrowRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
}

function esc(s) { return String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

async function openExternal(url) {
  if (!url) return
  try {
    if (window.__TAURI_INTERNALS__) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
      return
    }
  } catch (_) { /* fallback */ }
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch (_) {}
}

/** 核心能力（8 张卡片） */
function getFeatures() {
  return [
    { icon: ICON.sparkles, title: t('engine.xtFeatChatTitle'), desc: t('engine.xtFeatChatDesc') },
    { icon: ICON.agent,    title: t('engine.xtFeatAgentTitle'), desc: t('engine.xtFeatAgentDesc') },
    { icon: ICON.brain,    title: t('engine.xtFeatMemoryTitle'), desc: t('engine.xtFeatMemoryDesc') },
    { icon: ICON.book,     title: t('engine.xtFeatRagTitle'), desc: t('engine.xtFeatRagDesc') },
    { icon: ICON.clock,    title: t('engine.xtFeatCronTitle'), desc: t('engine.xtFeatCronDesc') },
    { icon: ICON.skills,   title: t('engine.xtFeatSkillsTitle'), desc: t('engine.xtFeatSkillsDesc') },
    { icon: ICON.channels, title: t('engine.xtFeatChannelTitle'), desc: t('engine.xtFeatChannelDesc') },
    { icon: ICON.shield,   title: t('engine.xtFeatOfflineTitle'), desc: t('engine.xtFeatOfflineDesc') },
  ]
}

/** 定位对比（3 张卡） */
function getCompareCards() {
  return [
    {
      id: 'openclaw',
      eyebrow: t('engine.xtComparePosA'),
      title: 'OpenClaw',
      desc: t('engine.xtCompareADesc'),
      tag: t('engine.xtCompareAForWho'),
    },
    {
      id: 'hermes',
      eyebrow: t('engine.xtComparePosB'),
      title: 'Hermes Agent',
      desc: t('engine.xtCompareBDesc'),
      tag: t('engine.xtCompareBForWho'),
    },
    {
      id: 'xintian',
      eyebrow: t('engine.xtComparePosC'),
      title: t('engine.xtCompareCTitle'),
      desc: t('engine.xtCompareCDesc'),
      tag: t('engine.xtCompareCForWho'),
      highlight: true,
    },
  ]
}

/** 亮点清单（CTA 区下方） */
function getChecklist() {
  return [
    t('engine.xtBulletInstall'),
    t('engine.xtBulletLogin'),
    t('engine.xtBulletSync'),
    t('engine.xtBulletSafe'),
  ]
}

// -------- 渲染 --------

export async function render() {
  const root = document.createElement('div')
  root.className = 'page'
  // Scope xintian editorial styling to this subtree only.
  root.dataset.engine = 'xintian'

  const features = getFeatures()
    .map((f, i) => `
      <article class="xt-feat" style="--xt-i:${i}">
        <div class="xt-feat-ico">${f.icon}</div>
        <div class="xt-feat-body">
          <h3 class="xt-feat-title">${esc(f.title)}</h3>
          <p class="xt-feat-desc">${esc(f.desc)}</p>
        </div>
      </article>
    `).join('')

  const compareCards = getCompareCards()
    .map(c => `
      <div class="xt-cmp-card${c.highlight ? ' xt-cmp-card--highlight' : ''}" data-card="${c.id}">
        <div class="xt-cmp-eyebrow">${esc(c.eyebrow)}</div>
        <div class="xt-cmp-title">${esc(c.title)}</div>
        <p class="xt-cmp-desc">${esc(c.desc)}</p>
        <div class="xt-cmp-tag">
          <span class="xt-cmp-tag-dot"></span>
          <span>${esc(c.tag)}</span>
        </div>
        ${c.highlight ? `<div class="xt-cmp-ribbon">${esc(t('engine.xtCompareRecommend'))}</div>` : ''}
      </div>
    `).join('')

  const bullets = getChecklist()
    .map(b => `<li class="xt-bullet">${ICON.check}<span>${esc(b)}</span></li>`).join('')

  root.innerHTML = `
    <div class="xt-stage">
      <!-- Decorative aurora background -->
      <div class="xt-bg" aria-hidden="true">
        <div class="xt-bg-blob xt-bg-blob--1"></div>
        <div class="xt-bg-blob xt-bg-blob--2"></div>
        <div class="xt-bg-blob xt-bg-blob--3"></div>
        <div class="xt-bg-grid"></div>
      </div>

      <!-- 1 · Hero -->
      <section class="xt-hero">
        <div class="xt-hero-badge">
          <span class="xt-hero-badge-dot"></span>
          <span>${esc(t('engine.xtHeroEyebrow'))}</span>
        </div>
        <h1 class="xt-hero-title">
          <span class="xt-hero-title-lead">${esc(t('engine.xtHeroTitleLead'))}</span>
          <span class="xt-hero-title-main">${esc(t('engine.xtHeroTitleA'))}<em>${esc(t('engine.xtHeroTitleB'))}</em>${esc(t('engine.xtHeroTitleC'))}</span>
        </h1>
        <p class="xt-hero-sub">${esc(t('engine.xtHeroSub'))}</p>
        <div class="xt-hero-actions">
          <button class="xt-btn xt-btn--primary" data-xt-action="download">
            ${ICON.windows}
            <span>${esc(t('engine.xtCtaDownloadWin'))}</span>
          </button>
          <button class="xt-btn xt-btn--ghost" data-xt-action="website">
            <span>${esc(t('engine.xtCtaVisitSite'))}</span>
            ${ICON.external}
          </button>
        </div>
        <div class="xt-hero-meta">
          <span class="xt-hero-meta-item">${esc(t('engine.xtHeroPlatformWin'))}</span>
          <span class="xt-hero-meta-sep">·</span>
          <span class="xt-hero-meta-item">${esc(t('engine.xtHeroPlatformRest'))}</span>
          <span class="xt-hero-meta-sep">·</span>
          <span class="xt-hero-meta-item">${esc(t('engine.xtHeroFreeTrial'))}</span>
        </div>
      </section>

      <!-- 2 · Features -->
      <section class="xt-section">
        <div class="xt-section-head">
          <span class="xt-eyebrow">${esc(t('engine.xtFeaturesEyebrow'))}</span>
          <h2 class="xt-section-title">${esc(t('engine.xtFeaturesTitle'))}</h2>
          <p class="xt-section-sub">${esc(t('engine.xtFeaturesSub'))}</p>
        </div>
        <div class="xt-feat-grid">${features}</div>
      </section>

      <!-- 3 · Compare -->
      <section class="xt-section xt-section--compare">
        <div class="xt-section-head">
          <span class="xt-eyebrow">${esc(t('engine.xtCompareEyebrow'))}</span>
          <h2 class="xt-section-title">${esc(t('engine.xtCompareTitle'))}</h2>
          <p class="xt-section-sub">${esc(t('engine.xtCompareSub'))}</p>
        </div>
        <div class="xt-cmp-grid">${compareCards}</div>
      </section>

      <!-- 4 · CTA block -->
      <section class="xt-cta">
        <div class="xt-cta-inner">
          <div class="xt-cta-left">
            <span class="xt-eyebrow xt-eyebrow--on-dark">${esc(t('engine.xtCtaEyebrow'))}</span>
            <h2 class="xt-cta-title">${esc(t('engine.xtCtaTitle'))}</h2>
            <p class="xt-cta-sub">${esc(t('engine.xtCtaSub'))}</p>
            <ul class="xt-cta-bullets">${bullets}</ul>
            <div class="xt-cta-actions">
              <button class="xt-btn xt-btn--primary xt-btn--lg" data-xt-action="download">
                ${ICON.download}
                <span>${esc(t('engine.xtCtaPrimary'))}</span>
              </button>
              <button class="xt-btn xt-btn--ghost xt-btn--ghost-dark xt-btn--lg" data-xt-action="website">
                <span>${esc(t('engine.xtCtaSecondary'))}</span>
                ${ICON.arrowRight}
              </button>
            </div>
            <div class="xt-cta-link" data-xt-action="website">
              <span class="xt-cta-link-label">${esc(t('engine.xtCtaLinkLabel'))}</span>
              <span class="xt-cta-link-url">xtclaw.xtnet.cc</span>
              ${ICON.external}
            </div>
          </div>

          <!-- Decorative product preview card -->
          <div class="xt-cta-right" aria-hidden="true">
            <div class="xt-preview">
              <div class="xt-preview-chrome">
                <span class="xt-preview-dot"></span>
                <span class="xt-preview-dot"></span>
                <span class="xt-preview-dot"></span>
                <span class="xt-preview-title">心甜Claw</span>
              </div>
              <div class="xt-preview-body">
                <div class="xt-preview-msg xt-preview-msg--bot">
                  <div class="xt-preview-avatar"><img src="${LOGO_SRC_SM}" srcset="${LOGO_SRC_SM} 1x, ${LOGO_SRC} 2x" alt="Xintian" width="28" height="28"></div>
                  <div class="xt-preview-bubble">${esc(t('engine.xtPreviewGreet'))}</div>
                </div>
                <div class="xt-preview-msg xt-preview-msg--user">
                  <div class="xt-preview-bubble xt-preview-bubble--user">${esc(t('engine.xtPreviewUserAsk'))}</div>
                </div>
                <div class="xt-preview-msg xt-preview-msg--bot">
                  <div class="xt-preview-avatar"><img src="${LOGO_SRC_SM}" srcset="${LOGO_SRC_SM} 1x, ${LOGO_SRC} 2x" alt="Xintian" width="28" height="28"></div>
                  <div class="xt-preview-bubble">
                    <div class="xt-preview-bubble-line">${esc(t('engine.xtPreviewAnswer1'))}</div>
                    <div class="xt-preview-bubble-line xt-preview-bubble-line--muted">${esc(t('engine.xtPreviewAnswer2'))}</div>
                    <div class="xt-preview-typing"><span></span><span></span><span></span></div>
                  </div>
                </div>
              </div>
              <div class="xt-preview-foot">
                <span>${ICON.sparkles}</span>
                <span>${esc(t('engine.xtPreviewFoot'))}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 5 · Footer -->
      <footer class="xt-foot">
        <div class="xt-foot-brand">
          <img class="xt-foot-logo" src="${LOGO_SRC_SM}" srcset="${LOGO_SRC_SM} 1x, ${LOGO_SRC} 2x" alt="Xintian Claw" width="18" height="18">
          <span>${esc(t('engine.xtFootBrand'))}</span>
        </div>
        <div class="xt-foot-links">
          <a class="xt-foot-link" data-xt-action="website">${esc(t('engine.xtFootHome'))}</a>
          <span class="xt-foot-sep">·</span>
          <a class="xt-foot-link" data-xt-action="download">${esc(t('engine.xtFootDownload'))}</a>
          <span class="xt-foot-sep">·</span>
          <a class="xt-foot-link" data-xt-action="help">${esc(t('engine.xtFootSupport'))}</a>
        </div>
      </footer>
    </div>
  `

  // 事件委托：所有 [data-xt-action] 元素
  root.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-xt-action]')
    if (!trigger) return
    const action = trigger.dataset.xtAction
    if (action === 'download') {
      openExternal(DOWNLOAD_URL)
    } else if (action === 'help') {
      openExternal(HELP_URL)
    } else if (action === 'website') {
      openExternal(WEBSITE_URL)
    }
  })

  return root
}

export default { render }
