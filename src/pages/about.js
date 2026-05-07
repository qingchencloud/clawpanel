/**
 * 关于页面
 * 版本信息、项目链接、相关项目、系统环境
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showUpgradeModal, showConfirm, showContentModal } from '../components/modal.js'
import { setUpgrading } from '../lib/app-state.js'
import { icon, statusIcon } from '../lib/icons.js'
import { t, getLang } from '../lib/i18n.js'
import { getActiveEngineId } from '../lib/engine-manager.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header" style="display:flex;align-items:center;gap:16px">
      <img src="/images/logo-brand.png" alt="ClawPanel" style="height:48px;width:auto">
      <div>
        <h1 class="page-title" style="margin:0">ClawPanel</h1>
        <p class="page-desc" style="margin:0">${t('about.subtitle')} · <a href="https://claw.qt.cool" target="_blank" rel="noopener" style="color:var(--primary)">claw.qt.cool</a></p>
      </div>
    </div>
    <div class="stat-cards" id="version-cards">
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('about.sectionCommunity')}</div>
      <div id="community-section"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('about.sectionProjects')}</div>
      <div id="projects-list"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('about.sectionContribute')}</div>
      <div id="contribute-section"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('about.sectionLinks')}</div>
      <div id="links-list"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('about.sectionAboutUs')}</div>
      <div id="company-section"></div>
    </div>
    <div class="config-section" style="color:var(--text-tertiary);font-size:var(--font-size-xs)">
      <p>${t('about.techStack')}</p>
      <p style="margin-top:8px">${t('about.copyright')}</p>
    </div>
  `

  const activeEngineId = getActiveEngineId()

  if (activeEngineId === 'xintian') {
    // 心甜Claw 是产品宣传入口，不展示 OpenClaw/Hermes 的版本、安装路径与社群信息
    loadXintianData(page)
  } else if (activeEngineId === 'hermes') {
    loadHermesData(page)
  } else {
    loadData(page)
  }

  // 社群二维码是 OpenClaw 专属渠道，对 xintian 用户不相关
  if (activeEngineId === 'xintian') {
    page.querySelector('#community-section')?.closest('.config-section')?.remove()
  } else {
    renderCommunity(page)
  }

  renderProjects(page)
  renderContribute(page)
  renderLinks(page)
  renderCompany(page)
  return page
}

/**
 * 心甜Claw 模式下的 about 页面：只展示 ClawPanel 自身版本 + 产品卡片，
 * 不涉及 OpenClaw 的版本切换与安装路径。
 */
async function loadXintianData(page) {
  const cards = page.querySelector('#version-cards')
  const panelVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'
  const panelUpdateHtml = `<span style="color:var(--text-tertiary)">${t('about.checkingUpdate')}</span>`
  checkNewVersion(cards, panelVersion)

  cards.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">ClawPanel</span></div>
      <div class="stat-card-value">${panelVersion}</div>
      <div class="stat-card-meta" id="panel-update-meta" style="display:flex;align-items:center;gap:8px">${panelUpdateHtml}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">心甜Claw</span></div>
      <div class="stat-card-value" style="font-size:var(--font-size-md)">Windows</div>
      <div class="stat-card-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <a class="btn btn-primary btn-sm" href="https://xtclaw.xtnet.cc/download" target="_blank" rel="noopener" style="padding:2px 8px;font-size:var(--font-size-xs)">${t('engine.xtCtaDownloadWin')}</a>
        <a class="btn btn-secondary btn-sm" href="https://xtclaw.xtnet.cc/" target="_blank" rel="noopener" style="padding:2px 8px;font-size:var(--font-size-xs)">${t('engine.xtCtaVisitSite')}</a>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header"><span class="stat-card-label">${t('about.sectionLinks')}</span></div>
      <div class="stat-card-value" style="font-size:var(--font-size-md)">xtclaw.xtnet.cc</div>
      <div class="stat-card-meta">
        <a href="https://xtclaw.xtnet.cc/articles" target="_blank" rel="noopener" style="color:var(--accent)">${t('engine.xtFootSupport')}</a>
      </div>
    </div>
  `
}

async function loadHermesData(page) {
  const cards = page.querySelector('#version-cards')
  try {
    const [hermesInfo, pythonInfo] = await Promise.all([
      api.checkHermes().catch(() => null),
      api.checkPython().catch(() => null),
    ])

    const panelVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'

    let panelUpdateHtml = `<span style="color:var(--text-tertiary)">${t('about.checkingUpdate')}</span>`
    checkNewVersion(cards, panelVersion)

    const installed = !!hermesInfo?.installed
    const gwRunning = !!hermesInfo?.gatewayRunning
    const version = hermesInfo?.hermesVersion || hermesInfo?.version || ''
    const model = hermesInfo?.model || ''
    const port = hermesInfo?.gatewayPort || 8642
    const pyVer = pythonInfo?.version || ''
    const pyPath = pythonInfo?.path || ''

    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const btnSm = 'padding:2px 8px;font-size:var(--font-size-xs)'

    cards.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">ClawPanel</span></div>
        <div class="stat-card-value">${panelVersion}</div>
        <div class="stat-card-meta" id="panel-update-meta" style="display:flex;align-items:center;gap:8px">${panelUpdateHtml}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Hermes Agent</span></div>
        <div class="stat-card-value">${installed ? (version || t('about.installed')) : t('about.notInstalled')}</div>
        <div class="stat-card-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${gwRunning
            ? `<span style="color:var(--success)">● Gateway ${t('engine.dashRunning')} · :${port}</span>`
            : `<span style="color:var(--text-tertiary)">○ Gateway ${t('engine.dashStopped')}</span>`}
          ${model ? `<span style="color:var(--text-secondary)">${t('engine.dashModel')}: ${esc(model)}</span>` : ''}
          ${!installed ? `<a class="btn btn-primary btn-sm" href="#/h/setup" style="${btnSm}">${t('about.hermesSetup')}</a>` : ''}
          ${installed ? `
            <button class="btn btn-secondary btn-sm" id="btn-hermes-config" style="${btnSm}">${t('about.hermesConfig')}</button>
            <button class="btn btn-primary btn-sm" id="btn-hermes-services" style="${btnSm}">${t('engine.hermesServicesTitle')}</button>
          ` : ''}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Python</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm)">${pyVer || t('about.notInstalled')}</div>
        <div class="stat-card-meta" style="word-break:break-all">${esc(pyPath)}</div>
      </div>
    `

    // Hermes 管理按钮事件
    if (installed) {
      // --- 配置模态框 ---
      cards.querySelector('#btn-hermes-config')?.addEventListener('click', async () => {
        try {
          const cfg = await api.hermesReadConfig()
          const maskedKey = cfg.api_key ? cfg.api_key.slice(0, 6) + '••••' + cfg.api_key.slice(-4) : t('about.notSet')
          const overlay = showContentModal({
            title: `Hermes Agent ${t('about.hermesConfig')}`,
            width: 480,
            content: `
              <div style="display:grid;gap:12px;font-size:13px;line-height:1.6">
                <div style="display:flex;gap:8px"><span style="color:var(--text-tertiary);min-width:90px">${t('engine.configProvider')}:</span><span style="word-break:break-all">${esc(cfg.provider || '-')}</span></div>
                <div style="display:flex;gap:8px"><span style="color:var(--text-tertiary);min-width:90px">Base URL:</span><span style="word-break:break-all">${esc(cfg.base_url || '-')}</span></div>
                <div style="display:flex;gap:8px"><span style="color:var(--text-tertiary);min-width:90px">API Key:</span><span style="font-family:monospace">${esc(maskedKey)}</span></div>
                <div style="display:flex;gap:8px"><span style="color:var(--text-tertiary);min-width:90px">${t('engine.configModel')}:</span><span style="word-break:break-all">${esc(cfg.model_raw || cfg.model || '-')}</span></div>
                <div style="display:flex;gap:8px"><span style="color:var(--text-tertiary);min-width:90px">${t('about.hermesConfigFile')}:</span><span style="color:${cfg.config_exists ? 'var(--success)' : 'var(--warning)'}">${cfg.config_exists ? '✓' : '✗'}</span></div>
              </div>
            `,
            buttons: [
              { label: t('about.hermesGoSetup'), className: 'btn btn-primary btn-sm', id: 'btn-goto-setup' },
            ],
          })
          overlay.querySelector('#btn-goto-setup')?.addEventListener('click', () => {
            overlay.close()
            window.location.hash = '#/h/setup'
          })
        } catch (e) {
          toast(t('common.loadFailed') + ': ' + (e.message || e), 'error')
        }
      })

      cards.querySelector('#btn-hermes-services')?.addEventListener('click', () => {
        window.location.hash = '#/h/services'
      })

      // --- 升级模态框（带实时日志） ---
      cards.querySelector('#btn-hermes-upgrade')?.addEventListener('click', async () => {
        const confirmed = await showConfirm(t('about.hermesUpgradeConfirm'))
        if (!confirmed) return

        const modal = showUpgradeModal(t('about.hermesUpgrade') + ' Hermes Agent')
        modal.setProgressLabels({
          preparing: t('about.upgrading'),
          downloading: t('about.upgrading'),
          installing: t('about.upgrading'),
          done: t('about.hermesUpgradeOk', { version: '' }),
        })
        modal.setProgress(10)

        let unlisten = null
        try {
          const { listen } = await import('@tauri-apps/api/event')
          unlisten = await listen('hermes-install-log', (e) => {
            modal.appendLog(String(e.payload))
          })
        } catch (_) {}

        modal.setProgress(20)
        try {
          const ver = await api.updateHermes()
          modal.setProgress(100)
          modal.setDone(t('about.hermesUpgradeOk', { version: ver || '' }))
          modal.onClose(() => loadHermesData(page))
        } catch (e) {
          modal.appendLog(`❌ ${e.message || e}`)
          modal.setError(t('about.hermesUpgradeFail', { error: e.message || e }))
          modal.onClose(() => loadHermesData(page))
        } finally {
          if (unlisten) unlisten()
        }
      })

      // --- 卸载模态框（确认 + 实时日志） ---
      cards.querySelector('#btn-hermes-uninstall')?.addEventListener('click', async () => {
        const confirmed = await showConfirm(t('about.hermesUninstallConfirm'))
        if (!confirmed) return
        const cleanConfig = await showConfirm(t('about.hermesUninstallCleanConfig'))

        const modal = showUpgradeModal(t('about.hermesUninstall') + ' Hermes Agent')
        modal.setProgressLabels({
          preparing: t('about.uninstalling'),
          downloading: t('about.uninstalling'),
          installing: t('about.uninstalling'),
          done: t('about.hermesUninstallOk'),
        })
        modal.appendLog('🗑️ ' + t('about.uninstalling'))
        if (cleanConfig) modal.appendLog('📁 ' + t('about.hermesUninstallCleanConfigHint'))
        modal.setProgress(30)

        try {
          const result = await api.uninstallHermes(cleanConfig)
          modal.appendLog('✅ ' + (result || t('about.hermesUninstallOk')))
          modal.setProgress(100)
          modal.setDone(t('about.hermesUninstallOk'))
          modal.onClose(() => loadHermesData(page))
        } catch (e) {
          modal.appendLog(`❌ ${e.message || e}`)
          modal.setError(t('about.hermesUninstallFail', { error: e.message || e }))
          modal.onClose(() => loadHermesData(page))
        }
      })
    }
  } catch {
    cards.innerHTML = `<div class="stat-card"><div class="stat-card-label">${t('common.loadFailed')}</div></div>`
  }
}

async function loadData(page) {
  const cards = page.querySelector('#version-cards')
  try {
    const [version, install] = await Promise.all([
      api.getVersionInfo(),
      api.checkInstallation(),
    ])

    // 尝试从 Tauri API 获取 ClawPanel 自身版本号，失败则 fallback
    const panelVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'

    let panelUpdateHtml = `<span style="color:var(--text-tertiary)">${t('about.checkingUpdate')}</span>`
    checkNewVersion(cards, panelVersion)

    const isInstalled = !!version.current
    const sourceLabel = version.source === 'official' ? t('about.official') : version.source === 'chinese' ? t('about.chinese') : t('about.unknownSource')
    const btnSm = 'padding:2px 8px;font-size:var(--font-size-xs)'
    const hasRecommended = !!version.recommended
    const aheadOfRecommended = isInstalled && hasRecommended && !!version.ahead_of_recommended
    const driftFromRecommended = isInstalled && hasRecommended && !version.is_recommended && !aheadOfRecommended
    const policyRiskHint = aheadOfRecommended
      ? t('about.policyAhead', { current: version.current, recommended: version.recommended })
      : t('about.policyDefault')

    cards.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">ClawPanel</span></div>
        <div class="stat-card-value">${panelVersion}</div>
        <div class="stat-card-meta" id="panel-update-meta" style="display:flex;align-items:center;gap:8px">${panelUpdateHtml}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">OpenClaw · ${sourceLabel}</span></div>
        <div class="stat-card-value">${version.current || t('about.notInstalled')}</div>
        <div class="stat-card-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${isInstalled && hasRecommended
            ? (aheadOfRecommended
              ? `<span style="color:var(--warning,#f59e0b)">${t('about.aheadOfRecommended', { ver: version.recommended })}</span>
                 <button class="btn btn-primary btn-sm" id="btn-apply-recommended" style="${btnSm}">${t('about.rollbackToRecommended')}</button>`
              : driftFromRecommended
              ? `<span style="color:var(--accent)">${t('about.recommendedStable', { ver: version.recommended })}</span>
                 <button class="btn btn-primary btn-sm" id="btn-apply-recommended" style="${btnSm}">${t('about.switchToRecommended')}</button>`
              : `<span style="color:var(--success)">${t('about.isRecommended')}</span>`)
            : ''}
          ${version.latest_update_available && version.latest ? `<span style="color:var(--text-tertiary)">${t('about.latestUpstream', { ver: version.latest })}</span>` : ''}
          <button class="btn btn-${isInstalled ? 'secondary' : 'primary'} btn-sm" id="btn-version-mgmt" style="${btnSm}">
            ${isInstalled ? t('about.switchVersion') : t('about.installOpenclaw')}
          </button>
          ${isInstalled ? `<button class="btn btn-secondary btn-sm" id="btn-uninstall" style="${btnSm};color:var(--error)">${t('about.uninstall')}</button>` : ''}
        </div>
        <div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary);line-height:1.6">
          ${policyRiskHint}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">${t('about.installPath')}</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm);word-break:break-all">${install.path || t('common.unknown')}</div>
        <div class="stat-card-meta">${install.installed ? t('about.configExists') : t('about.configNotFound')}</div>
      </div>
    `

    const applyRecommendedBtn = cards.querySelector('#btn-apply-recommended')
    if (applyRecommendedBtn && version.recommended) {
      applyRecommendedBtn.onclick = () => doInstall(page, aheadOfRecommended ? t('about.rollbackToRecommendedStable') : t('about.switchToRecommendedStable'), version.source, version.recommended)
    }

    // 版本管理 / 安装
    const versionMgmtBtn = cards.querySelector('#btn-version-mgmt')
    if (versionMgmtBtn) {
      versionMgmtBtn.onclick = () => showVersionPicker(page, version)
    }

    // 卸载
    const uninstallBtn = cards.querySelector('#btn-uninstall')
    if (uninstallBtn) {
      uninstallBtn.onclick = async () => {
        const confirmed = await showConfirm(t('about.confirmUninstall'))
        if (!confirmed) return
        const modal = showUpgradeModal(t('about.uninstallTitle'))
        modal.setProgressLabels({
          preparing: t('about.uninstallStopping'),
          downloading: t('about.uninstallRemoving'),
          installing: t('about.uninstallCleaning'),
          done: t('about.uninstallDone'),
        })
        modal.onClose(() => loadData(page))
        modal.appendLog(t('about.uninstallStarting'))
        let unlistenLog, unlistenProgress, unlistenDone, unlistenError
        const cleanup = () => { unlistenLog?.(); unlistenProgress?.(); unlistenDone?.(); unlistenError?.() }
        try {
          if (window.__TAURI_INTERNALS__) {
            const { listen } = await import('@tauri-apps/api/event')
            unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
            unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))
            unlistenDone = await listen('upgrade-done', (e) => { cleanup(); modal.setDone(typeof e.payload === 'string' ? e.payload : t('about.uninstallDone')) })
            unlistenError = await listen('upgrade-error', (e) => { cleanup(); modal.setError(t('about.uninstallFailed') + (e.payload || t('common.unknown'))) })
            await api.uninstallOpenclaw(false)
            modal.appendLog(t('about.uninstallTaskStarted'))
          } else {
            const msg = await api.uninstallOpenclaw(false)
            modal.setDone(typeof msg === 'string' ? msg : t('about.uninstallDone'))
            cleanup()
          }
        } catch (e) {
          cleanup()
          modal.setError(t('about.uninstallFailed') + (e?.message || e))
        }
      }
    }
  } catch {
    cards.innerHTML = `<div class="stat-card"><div class="stat-card-label">${t('common.loadFailed')}</div></div>`
  }
}

/**
 * 版本选择器弹窗 — 选择版本（汉化版/原版）+ 版本号
 */
async function showVersionPicker(page, currentVersion) {
  const isInstalled = !!currentVersion.current
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-title">${isInstalled ? t('about.switchVersion') : t('about.installOpenclaw')}</div>
      <div style="display:flex;flex-direction:column;gap:16px;margin:16px 0">
        <div>
          <label style="font-size:var(--font-size-sm);color:var(--text-secondary);display:block;margin-bottom:8px">${t('about.versionLabel')}</label>
          <div style="display:flex;gap:8px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid var(--border);font-size:var(--font-size-sm);flex:1;justify-content:center;transition:all .15s" id="lbl-official">
              <input type="radio" name="oc-source" value="official" ${currentVersion.source !== 'chinese' ? 'checked' : ''} style="accent-color:var(--primary)">
              ${t('about.official')}
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid var(--border);font-size:var(--font-size-sm);flex:1;justify-content:center;transition:all .15s" id="lbl-chinese">
              <input type="radio" name="oc-source" value="chinese" ${currentVersion.source === 'chinese' ? 'checked' : ''} style="accent-color:var(--primary)">
              ${t('about.chinese')}
            </label>
          </div>
        </div>
        <div>
          <label style="font-size:var(--font-size-sm);color:var(--text-secondary);display:block;margin-bottom:8px">${t('about.selectVersion')}</label>
          <select id="oc-version-select" class="input" style="width:100%;padding:8px 12px;font-size:var(--font-size-sm)">
            <option value="">${t('common.loading')}</option>
          </select>
        </div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);line-height:1.6;padding:10px 12px;border-radius:8px;background:var(--bg-tertiary)">
          ${t('about.versionPickerHint')}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;min-height:18px">
          <div id="oc-action-hint" style="font-size:var(--font-size-xs);color:var(--text-tertiary)"></div>
          <div id="nightly-toggle" style="display:none"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" data-action="confirm" disabled id="oc-confirm-btn">${isInstalled ? t('about.btnSwitch') : t('about.btnInstall')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const select = overlay.querySelector('#oc-version-select')
  const confirmBtn = overlay.querySelector('#oc-confirm-btn')
  const hintEl = overlay.querySelector('#oc-action-hint')
  const radios = overlay.querySelectorAll('input[name="oc-source"]')
  const lblChinese = overlay.querySelector('#lbl-chinese')
  const lblOfficial = overlay.querySelector('#lbl-official')

  const close = () => overlay.remove()
  overlay.querySelector('[data-action="cancel"]').onclick = close
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  let versionsCache = {}
  let currentSelect = currentVersion.source === 'chinese' ? 'chinese' : 'official'

  function updateRadioStyle() {
    const sel = currentSelect
    lblChinese.style.borderColor = sel !== 'official' ? 'var(--primary)' : 'var(--border)'
    lblChinese.style.background = sel !== 'official' ? 'var(--primary-bg, rgba(99,102,241,0.06))' : ''
    lblOfficial.style.borderColor = sel === 'official' ? 'var(--primary)' : 'var(--border)'
    lblOfficial.style.background = sel === 'official' ? 'var(--primary-bg, rgba(99,102,241,0.06))' : ''
  }

  function updateHint() {
    const targetSource = currentSelect
    const targetVer = select.value
    if (!targetVer || targetVer === '') { hintEl.textContent = ''; confirmBtn.disabled = true; return }
    const targetTag = select.selectedIndex === 0 ? t('about.tagRecommended') : t('about.tagNeedTest')

    const sameSource = targetSource === currentVersion.source

    if (!isInstalled) {
      confirmBtn.textContent = t('about.btnInstall')
      hintEl.textContent = t('about.hintInstall', { source: targetSource === 'official' ? t('about.official') : targetSource === 'chinese' ? t('about.chinese') : t('about.unknownSource'), ver: targetVer, tag: targetTag })
      confirmBtn.disabled = false
      return
    }

    if (!sameSource) {
      confirmBtn.textContent = t('about.btnSwitch')
      hintEl.innerHTML = `${t('about.hintCurrent')}: <strong>${currentVersion.source === 'official' ? t('about.official') : currentVersion.source === 'chinese' ? t('about.chinese') : t('about.unknownSource')} ${currentVersion.current}</strong> → <strong>${targetSource === 'official' ? t('about.official') : targetSource === 'chinese' ? t('about.chinese') : t('about.unknownSource')} ${targetVer}</strong>${targetTag}`
      confirmBtn.disabled = false
      return
    }

    // 同源，比较版本
    const parseVer = v => v.split(/[^0-9]/).filter(Boolean).map(Number)
    const cur = parseVer(currentVersion.current)
    const tgt = parseVer(targetVer)
    let cmp = 0
    for (let i = 0; i < Math.max(cur.length, tgt.length); i++) {
      if ((tgt[i] || 0) > (cur[i] || 0)) { cmp = 1; break }
      if ((tgt[i] || 0) < (cur[i] || 0)) { cmp = -1; break }
    }

    if (cmp === 0) {
      confirmBtn.textContent = t('about.btnReinstall')
      hintEl.textContent = t('about.hintAlreadyVersion', { ver: targetVer, tag: targetTag })
      confirmBtn.disabled = false
    } else if (cmp > 0) {
      confirmBtn.textContent = t('about.btnUpgrade')
      hintEl.innerHTML = `<span style="color:var(--accent)">${currentVersion.current} → ${targetVer}${targetTag}</span>`
      confirmBtn.disabled = false
    } else {
      confirmBtn.textContent = t('about.btnDowngrade')
      hintEl.innerHTML = `<span style="color:var(--warning,#f59e0b)">${currentVersion.current} → ${targetVer}${targetTag}</span>`
      confirmBtn.disabled = false
    }
  }

  let showNightly = false

  async function loadVersions(source) {
    select.innerHTML = `<option value="">${t('common.loading')}</option>`
    confirmBtn.disabled = true
    hintEl.textContent = ''
    try {
      if (!versionsCache[source]) {
        versionsCache[source] = await api.listOpenclawVersions(source)
      }
      const allVersions = versionsCache[source]
      if (!allVersions.length) {
        select.innerHTML = `<option value="">${t('about.noVersions')}</option>`
        return
      }
      const stable = allVersions.filter(v => !v.includes('nightly') && !v.includes('canary') && !v.includes('alpha') && !v.includes('beta') && !v.includes('rc') && !v.includes('dev') && !v.includes('next'))
      const versions = showNightly ? allVersions : (stable.length > 0 ? stable : allVersions)
      const nightlyCount = allVersions.length - stable.length
      select.innerHTML = versions.map((v, idx) => {
        const isCurrent = isInstalled && v === currentVersion.current && source === currentVersion.source
        return `<option value="${v}">${v}${idx === 0 ? ` (${t('about.recommended')})` : ''}${isCurrent ? ` (${t('about.current')})` : ''}</option>`
      }).join('')
      // nightly 切换提示
      const toggleEl = overlay.querySelector('#nightly-toggle')
      if (toggleEl) {
        if (nightlyCount > 0) {
          toggleEl.style.display = ''
          toggleEl.innerHTML = showNightly
            ? `<a href="#" id="btn-toggle-nightly" style="color:var(--primary);text-decoration:none;font-size:var(--font-size-xs)">${t('about.hidePreview', { count: nightlyCount })}</a>`
            : `<a href="#" id="btn-toggle-nightly" style="color:var(--text-tertiary);text-decoration:none;font-size:var(--font-size-xs)">${t('about.showPreview', { count: nightlyCount })}</a>`
          toggleEl.querySelector('#btn-toggle-nightly').onclick = (e) => { e.preventDefault(); showNightly = !showNightly; loadVersions(source) }
        } else {
          toggleEl.style.display = 'none'
        }
      }
      updateHint()
    } catch (e) {
      select.innerHTML = `<option value="">${t('common.loadFailed')}: ${e.message || e}</option>`
    }
  }

  radios.forEach(radio => {
    radio.addEventListener('change', () => {
      currentSelect = radio.value
      updateRadioStyle()
      loadVersions(currentSelect)
    })
  })

  select.addEventListener('change', updateHint)

  confirmBtn.onclick = () => {
    const source = currentSelect
    const ver = select.value
    const action = confirmBtn.textContent
    close()
    doInstall(page, `${action} OpenClaw`, source, ver)
  }

  updateRadioStyle()
  loadVersions(currentSelect)
}

/**
 * 执行安装/升级/降级/切换操作（带进度弹窗）
 */
async function doInstall(page, title, source, version) {
  const modal = showUpgradeModal(title)
  modal.onClose(() => loadData(page))
  let unlistenLog, unlistenProgress, unlistenDone, unlistenError
  setUpgrading(true)

  const cleanup = () => {
    setUpgrading(false)
    unlistenLog?.(); unlistenProgress?.(); unlistenDone?.(); unlistenError?.()
  }

  try {
    if (window.__TAURI_INTERNALS__) {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
      unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))

      unlistenDone = await listen('upgrade-done', (e) => {
        cleanup()
        modal.setDone(typeof e.payload === 'string' ? e.payload : t('about.operationDone'))
      })

      unlistenError = await listen('upgrade-error', async (e) => {
        cleanup()
        const errStr = String(e.payload || t('common.unknown'))
        modal.appendLog(errStr)
        const { diagnoseInstallError } = await import('../lib/error-diagnosis.js')
        const fullLog = modal.getLogText() + '\n' + errStr
        const diagnosis = diagnoseInstallError(fullLog)
        modal.setError(diagnosis.title)
        if (diagnosis.hint) modal.appendLog('')
        if (diagnosis.hint) modal.appendHtmlLog(`${statusIcon('info', 14)} ${diagnosis.hint}`)
        if (diagnosis.command) modal.appendHtmlLog(`${icon('clipboard', 14)} ${diagnosis.command}`)
        if (window.__openAIDrawerWithError) {
          window.__openAIDrawerWithError({ title: diagnosis.title, error: fullLog, scene: title, hint: diagnosis.hint })
        }
      })

      await api.upgradeOpenclaw(source, version)
      modal.appendLog(t('about.taskStarted'))
    } else {
      modal.appendLog(t('about.webModeNoLog'))
      const msg = await api.upgradeOpenclaw(source, version)
      modal.setDone(typeof msg === 'string' ? msg : (msg?.message || t('about.operationDone')))
      cleanup()
    }
  } catch (e) {
    cleanup()
    const errStr = String(e)
    modal.appendLog(errStr)
    const { diagnoseInstallError } = await import('../lib/error-diagnosis.js')
    const fullLog = modal.getLogText() + '\n' + errStr
    const diagnosis = diagnoseInstallError(fullLog)
    modal.setError(diagnosis.title)
  }
}

async function checkNewVersion(cards, panelVersion) {
  const el = () => cards.querySelector('#panel-update-meta')
  const btnSm = 'padding:2px 8px;font-size:var(--font-size-xs)'

  // 尝试获取 Tauri 二进制版本，检测「假更新」：
  // 前端通过热更新升级到 v0.13.0，但 Tauri 二进制仍是 v0.9.9
  let binaryVersion = panelVersion
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    binaryVersion = await getVersion()
  } catch {}

  // 前端版本 > 二进制版本 = 热更新导致版本不一致
  const isFakeUpdate = binaryVersion !== panelVersion && compareVersions(panelVersion, binaryVersion) > 0

  try {
    const info = await api.checkPanelUpdate()
    const meta = el()
    if (!meta) return

    const latest = info?.latest || ''
    // 用二进制版本（真实应用版本）做比较，避免假更新导致误判为「已是最新」
    const effectiveVersion = isFakeUpdate ? binaryVersion : panelVersion

    if (isFakeUpdate) {
      meta.innerHTML = `
        <span style="color:var(--warning)">⚠️ ${t('about.versionMismatch', { frontend: panelVersion, binary: binaryVersion })}</span>
        <span style="color:var(--text-tertiary);font-size:var(--font-size-xs)">${t('about.hotUpdateDeprecated')}</span>
        <a class="btn btn-primary btn-sm" href="https://claw.qt.cool" target="_blank" rel="noopener" style="${btnSm}">${t('about.downloadFullInstaller')}</a>
        <a class="btn btn-secondary btn-sm" href="${info.url || 'https://github.com/qingchencloud/clawpanel/releases'}" target="_blank" rel="noopener" style="${btnSm}">${t('about.downloadFromGitHub')}</a>
      `
    } else if (latest && latest !== effectiveVersion && compareVersions(latest, effectiveVersion) > 0) {
      meta.innerHTML = `
        <span style="color:var(--accent)">${t('about.newVersionAvailable', { version: latest })}</span>
        <a class="btn btn-primary btn-sm" href="https://claw.qt.cool" target="_blank" rel="noopener" style="${btnSm}">${t('about.downloadFromWebsite')}</a>
        <a class="btn btn-secondary btn-sm" href="${info.url || 'https://github.com/qingchencloud/clawpanel/releases'}" target="_blank" rel="noopener" style="${btnSm}">${t('about.downloadFromGitHub')}</a>
      `
    } else {
      meta.innerHTML = `<span style="color:var(--success)">${t('about.upToDate')}</span>`
    }
  } catch (err) {
    const meta = el()
    if (!meta) return
    if (isFakeUpdate) {
      meta.innerHTML = `<span style="color:var(--warning)">⚠️ ${t('about.versionMismatch', { frontend: panelVersion, binary: binaryVersion })}</span> <a class="btn btn-primary btn-sm" href="https://claw.qt.cool" target="_blank" rel="noopener" style="${btnSm}">${t('about.downloadFullInstaller')}</a>`
    } else {
      meta.innerHTML = `<span style="color:var(--text-tertiary)">${t('about.checkUpdateFailed')}</span> <a class="btn btn-secondary btn-sm" href="https://claw.qt.cool" target="_blank" rel="noopener" style="${btnSm}">${t('about.goToWebsite')}</a>`
    }
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

function renderCommunity(page) {
  const el = page.querySelector('#community-section')
  el.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
      <div style="text-align:center">
        <img src="/images/OpenClaw-QQ.png" alt="${t('about.qqGroup')}" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary)">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">${t('about.qqGroup')}</div>
      </div>
      <div style="text-align:center">
        <img src="/images/OpenClawWx.png" alt="${t('about.wechatGroup')}" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary)">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">${t('about.wechatGroup')}</div>
      </div>
      <div style="text-align:center">
        <img src="https://qt.cool/c/OpenClawDY/qr.png" alt="${t('about.douyinGroup')}" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary);object-fit:contain;background:#fff">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">${t('about.douyinGroup')}</div>
      </div>
      <div style="text-align:center">
        <img src="https://qt.cool/c/feishu/qr.png" alt="${t('about.feishuGroup')}" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary);object-fit:contain;background:#fff">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">${t('about.feishuGroup')}</div>
      </div>
      <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px;padding-top:4px">
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary)">${t('about.communityWelcome')}</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);font-style:italic">${t('about.communityWelcomeIntl')}</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-top:4px">${t('about.communityDesc')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
          <a class="btn btn-sm" href="https://discord.gg/U9AttmsNHh" target="_blank" rel="noopener" style="background:#5865F2;color:#fff;display:inline-flex;align-items:center;gap:4px;border:none">${icon('message-circle', 14)} ${t('about.joinDiscord')}</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClaw" target="_blank" rel="noopener">${t('about.joinQQ')}</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClawWx" target="_blank" rel="noopener">${t('about.joinWechat')}</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClawDY" target="_blank" rel="noopener">${t('about.joinDouyin')}</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/feishu" target="_blank" rel="noopener">${t('about.joinFeishu')}</a>
          <a class="btn btn-secondary btn-sm" href="https://yb.tencent.com/gp/i/IIGXzcMcdh84" target="_blank" rel="noopener">${t('about.joinYuanbao')}</a>
        </div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:8px">
          ${t('about.communityNote')}
        </div>
      </div>
    </div>
  `
}

const PROJECTS = [
  {
    name: 'OpenClaw',
    desc: t('about.projectOpenClaw'),
    url: 'https://github.com/openclaw/openclaw',
  },
  {
    name: 'OpenClaw-zh',
    desc: t('about.projectOpenClawZh'),
    url: 'https://github.com/1186258278/OpenClawChineseTranslation',
  },
  {
    name: 'ClawPanel',
    desc: t('about.projectClawPanel'),
    url: 'https://github.com/qingchencloud/clawpanel',
    gitee: 'https://gitee.com/QtCodeCreators/clawpanel',
  },
  {
    name: 'ClawApp',
    desc: t('about.projectClawApp'),
    url: 'https://github.com/qingchencloud/clawapp',
  },
  {
    name: 'cftunnel',
    desc: t('about.projectCftunnel'),
    url: 'https://github.com/qingchencloud/cftunnel',
  },
]

function renderProjects(page) {
  const el = page.querySelector('#projects-list')
  el.innerHTML = PROJECTS.map(p => `
    <div class="service-card">
      <div class="service-info">
        <div>
          <div class="service-name">${p.name}</div>
          <div class="service-desc">${p.desc}</div>
        </div>
      </div>
      <div class="service-actions">
        <a class="btn btn-secondary btn-sm" href="${p.url}" target="_blank" rel="noopener">GitHub</a>
        ${p.gitee ? `<a class="btn btn-secondary btn-sm" href="${p.gitee}" target="_blank" rel="noopener">${t('about.domesticMirror')}</a>` : ''}
      </div>
    </div>
  `).join('')
}

const LINKS = [
  { label: t('about.linkWebsite'), url: 'https://claw.qt.cool', primary: true },
  { label: t('about.linkOpenClawZh'), url: 'https://github.com/1186258278/OpenClawChineseTranslation' },
  { label: t('about.linkClawApp'), url: 'https://clawapp.qt.cool' },
  { label: t('about.linkCftunnel'), url: 'https://cftunnel.qt.cool' },
]

function renderContribute(page) {
  const el = page.querySelector('#contribute-section')
  el.innerHTML = `
    <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:12px">
      ${t('about.contributeDesc')}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <a class="btn btn-primary btn-sm" href="https://github.com/qingchencloud/clawpanel/issues/new" target="_blank" rel="noopener">${t('about.submitIssue')}</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/pulls" target="_blank" rel="noopener">${t('about.submitPR')}</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">${t('about.contributeGuide')}</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/issues" target="_blank" rel="noopener">${t('about.viewIssues')}</a>
    </div>
    <div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary)">
      ${t('about.domesticMirrorHint')}
    </div>
  `
}

function renderLinks(page) {
  const el = page.querySelector('#links-list')
  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:var(--space-sm)">
    ${LINKS.map(l => `<a class="btn ${l.primary ? 'btn-primary' : 'btn-secondary'} btn-sm" href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join('')}
  </div>`
}

function renderCompany(page) {
  const el = page.querySelector('#company-section')
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="/images/logo-brand.png" alt="QingchenCloud" style="width:40px;height:40px;border-radius:10px;flex-shrink:0">
        <div>
          <div style="font-weight:700;font-size:var(--font-size-md)">${t('about.companyName')}</div>
          <div style="font-size:var(--font-size-sm);color:var(--text-secondary)">QingchenCloud</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;font-size:var(--font-size-sm)">
        <div style="padding:12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary)">
          <div style="color:var(--text-tertiary);font-size:var(--font-size-xs);margin-bottom:4px">${t('about.officialWebsite')}</div>
          <a href="https://qingchencloud.com" target="_blank" rel="noopener" style="color:var(--accent)">qingchencloud.com</a>
        </div>
        <div style="padding:12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary)">
          <div style="color:var(--text-tertiary);font-size:var(--font-size-xs);margin-bottom:4px">${t('about.productWebsite')}</div>
          <a href="https://claw.qt.cool" target="_blank" rel="noopener" style="color:var(--accent)">claw.qt.cool</a>
        </div>
        <div style="padding:12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary)">
          <div style="color:var(--text-tertiary);font-size:var(--font-size-xs);margin-bottom:4px">${t('about.openSourceRepo')}</div>
          <a href="https://github.com/qingchencloud" target="_blank" rel="noopener" style="color:var(--accent)">github.com/qingchencloud</a>
        </div>
        <div style="padding:12px;border-radius:var(--radius-md);border:1px solid var(--border-primary);background:var(--bg-secondary)">
          <div style="color:var(--text-tertiary);font-size:var(--font-size-xs);margin-bottom:4px">${t('about.businessCoop')}</div>
          <a href="mailto:support@qctx.net" style="color:var(--accent)">support@qctx.net</a>
        </div>
      </div>
      <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);line-height:1.6">
        ${t('about.companyDesc')}
      </div>
      ${!getLang().startsWith('zh') ? `<div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-md);border:1px dashed var(--border-primary);background:var(--bg-secondary);font-size:var(--font-size-xs);color:var(--text-tertiary)">
        <div style="display:flex;align-items:center;gap:12px">
          <img src="/images/bnbqr.jpg" alt="Sponsor QR" width="64" height="64" style="border-radius:6px;flex-shrink:0;background:#fff;padding:2px;cursor:pointer" loading="lazy" id="sponsor-qr-thumb" title="Click to enlarge">
          <div style="min-width:0">
            <div style="font-weight:600;color:var(--text-secondary);margin-bottom:4px">${t('about.sponsorProject') || 'Sponsor This Project'} <span style="opacity:0.5">· USDT (BNB Smart Chain)</span></div>
            <code style="font-size:10px;background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;user-select:all;word-break:break-all;display:block;line-height:1.6">0xbdd7ebdf2b30d873e556799711021c6671ffe88f</code>
            <div style="margin-top:4px;opacity:0.6">${t('about.sponsorDesc') || 'Your support helps us maintain and improve this open-source project.'}</div>
          </div>
        </div>
      </div>` : ''}
    </div>
  `
  // QR 点击预览大图
  el.querySelector('#sponsor-qr-thumb')?.addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px;text-align:center">
        <div class="modal-title">${t('about.sponsorProject') || 'Sponsor This Project'}</div>
        <img src="/images/bnbqr.jpg" alt="Sponsor QR" style="width:240px;height:240px;border-radius:8px;margin:12px auto;display:block">
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:8px 0">USDT · BNB Smart Chain</div>
        <code style="font-size:11px;background:var(--bg-tertiary);padding:4px 8px;border-radius:4px;user-select:all;word-break:break-all;display:block;line-height:1.6">0xbdd7ebdf2b30d873e556799711021c6671ffe88f</code>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:8px">${t('about.sponsorDesc') || 'Your support helps us maintain and improve this open-source project.'}</div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-secondary btn-sm" data-action="close">${t('common.close')}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('[data-action="close"]').onclick = () => overlay.remove()
  })
}
