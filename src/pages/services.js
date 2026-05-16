/**
 * 服务管理页面
 * 服务启停 + 更新检测 + 配置备份管理
 */
import { api, isTauriRuntime } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { humanizeError } from '../lib/humanize-error.js'
import { showConfirm, showModal, showUpgradeModal } from '../components/modal.js'
import { isMacPlatform, isInDocker, setUpgrading, setUserStopped, resetAutoRestart } from '../lib/app-state.js'
import { isForeignGatewayError, isForeignGatewayService, maybeShowForeignGatewayBindingPrompt, showGatewayConflictGuidance } from '../lib/gateway-ownership.js'
import { diagnoseInstallError } from '../lib/error-diagnosis.js'
import { icon, statusIcon } from '../lib/icons.js'
import { t } from '../lib/i18n.js'
import { wsClient } from '../lib/ws-client.js'

// HTML 转义，防止 XSS
function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('services.title')}</h1>
      <p class="page-desc">${t('services.desc')}</p>
    </div>
    <div id="version-bar"><div class="stat-card loading-placeholder" style="height:80px;margin-bottom:var(--space-lg)"></div></div>
    <div id="services-list"><div class="stat-card loading-placeholder" style="height:64px"></div></div>
    ${isTauriRuntime() ? '' : `
    <div class="config-section" id="docker-manager-section">
      <div class="config-section-title">${t('services.dockerManager')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-sm)">${t('services.dockerManagerHint')}</div>
      <div id="docker-manager-bar"><div class="stat-card loading-placeholder" style="height:96px"></div></div>
    </div>`}
    <div class="config-section" id="config-editor-section" style="display:none">
      <div class="config-section-title">${t('services.configEditor')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-sm)">${t('services.configEditorHint')}</div>
      <div style="display:flex;gap:8px;margin-bottom:var(--space-sm)">
        <button class="btn btn-primary btn-sm" data-action="save-config" disabled>${t('services.saveAndRestart')}</button>
        <button class="btn btn-secondary btn-sm" data-action="save-config-only" disabled>${t('services.saveOnly')}</button>
        <button class="btn btn-secondary btn-sm" data-action="reload-config">${t('services.reloadConfig')}</button>
      </div>
      <div id="config-editor-status" style="font-size:var(--font-size-xs);margin-bottom:6px;min-height:18px"></div>
      <textarea id="config-editor-area" class="form-input" style="font-family:var(--font-mono);font-size:12px;min-height:320px;resize:vertical;tab-size:2;white-space:pre;overflow-x:auto" spellcheck="false" disabled></textarea>
    </div>
    <div class="config-section" id="config-calibration-section">
      <div class="config-section-title">${t('services.configCalibration')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-sm)">${t('services.configCalibrationHint')}</div>
      <div style="display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-bottom:var(--space-sm)">
        <button class="btn btn-primary btn-sm" data-action="calibrate-config-inherit">${t('services.calibrateInherit')}</button>
        <button class="btn btn-secondary btn-sm" data-action="calibrate-config-reset">${t('services.calibrateReset')}</button>
      </div>
      <div style="display:grid;gap:8px;margin-bottom:var(--space-sm)">
        <div class="setup-inline-note">${t('services.calibrateInheritHint')}</div>
        <div class="setup-inline-note">${t('services.calibrateResetHint')}</div>
      </div>
      <div id="config-calibration-status" style="font-size:var(--font-size-xs);min-height:18px;color:var(--text-tertiary)"></div>
    </div>
    <div class="config-section" id="backup-section">
      <div class="config-section-title">${t('services.configBackup')}</div>
      <div class="form-hint" style="margin-bottom:var(--space-sm)">${t('services.configBackupHint')}</div>
      <div id="backup-actions" style="margin-bottom:var(--space-md)">
        <button class="btn btn-primary btn-sm" data-action="create-backup">${t('services.createBackup')}</button>
      </div>
      <div id="backup-list"><div class="stat-card loading-placeholder" style="height:48px"></div></div>
    </div>
  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  const tasks = [loadVersion(page), loadServices(page), loadDockerManager(page), loadBackups(page), loadConfigEditor(page)]
  await Promise.all(tasks)
}

// ===== 版本检测 =====

// 后端检测到的当前安装源
let detectedSource = 'chinese'
let lastVersionInfo = null

async function loadVersion(page) {
  const bar = page.querySelector('#version-bar')
  try {
    const [info, panelConfig] = await Promise.all([
      api.getVersionInfo(),
      api.readPanelConfig().catch(() => ({})),
    ])
    lastVersionInfo = info
    detectedSource = info.source || 'chinese'
    const ver = info.current || t('common.unknown')
    const hasRecommended = !!info.recommended
    const aheadOfRecommended = !!info.current && hasRecommended && !!info.ahead_of_recommended
    const driftFromRecommended = !!info.current && hasRecommended && !info.is_recommended && !aheadOfRecommended
    const canUpgradeLatest = !!info.latest_update_available && !!info.latest
    const isChinese = detectedSource === 'chinese'
    const sourceTag = isChinese ? t('services.chineseEdition') : t('services.officialEdition')
    const switchLabel = isChinese ? t('services.switchToOfficial') : t('services.switchToChinese')
    const switchTarget = isChinese ? 'official' : 'chinese'
    const dockerImage = (panelConfig?.dockerDefaultImage || '').trim() || 'ghcr.io/qingchencloud/openclaw'
    const policyNote = aheadOfRecommended
      ? t('services.policyAhead', { ver, recommended: info.recommended })
      : t('services.policyDefault')

    if (isInDocker()) {
      bar.innerHTML = `
        <div class="stat-cards" style="margin-bottom:var(--space-lg)">
          <div class="stat-card">
            <div class="stat-card-header">
              <span class="stat-card-label">${t('services.currentVersion')} · <span style="color:var(--accent)">${t('services.dockerDeploy')}</span></span>
            </div>
            <div class="stat-card-value">${ver}</div>
            <div class="stat-card-meta">${canUpgradeLatest ? t('services.latestUpstream', { version: info.latest }) + '（' + t('services.pullNewImage') + '）' : t('services.currentImageVer')}</div>
            ${canUpgradeLatest ? `<div style="margin-top:var(--space-sm)">
              <code style="font-size:var(--font-size-xs);background:var(--bg-tertiary);padding:4px 8px;border-radius:4px;user-select:all">${escapeHtml(`docker pull ${dockerImage}:latest`)}</code>
            </div>` : ''}
          </div>
        </div>
      `
    } else {
      bar.innerHTML = `
        <div class="stat-cards" style="margin-bottom:var(--space-lg)">
          <div class="stat-card">
            <div class="stat-card-header">
              <span class="stat-card-label">${t('services.currentVersion')} · <span style="color:var(--accent)">${sourceTag}</span></span>
            </div>
            <div class="stat-card-value">${ver}</div>
            <div class="stat-card-meta">
              ${hasRecommended
                ? (aheadOfRecommended ? t('services.aheadOfRecommended', { version: info.recommended }) : driftFromRecommended ? t('services.recommendedStable', { version: info.recommended }) : t('services.alignedRecommended', { version: info.recommended }))
                : t('services.noRecommended')}
              ${canUpgradeLatest ? ' · ' + t('services.latestUpstream', { version: info.latest }) : ''}
            </div>
            <div style="display:flex;gap:var(--space-sm);margin-top:var(--space-sm);flex-wrap:wrap">
              ${aheadOfRecommended ? `<button class="btn btn-primary btn-sm" data-action="upgrade">${t('services.rollbackToRecommended')}</button>` : driftFromRecommended ? `<button class="btn btn-primary btn-sm" data-action="upgrade">${t('services.switchToRecommended')}</button>` : ''}
              ${canUpgradeLatest ? `<button class="btn btn-primary btn-sm" data-action="upgrade-latest" data-version="${escapeHtml(info.latest)}">${t('services.upgradeToLatest')}</button>` : ''}
              <button class="btn btn-secondary btn-sm" data-action="switch-source" data-source="${switchTarget}">${switchLabel}</button>
            </div>
            <div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-tertiary);line-height:1.6">
              ${policyNote}
            </div>
          </div>
        </div>
      `
    }
  } catch (e) {
    bar.innerHTML = `<div class="stat-card" style="margin-bottom:var(--space-lg)"><div class="stat-card-label">${t('services.versionLoadFailed')}</div></div>`
  }
}

function configuredDockerImage(panelConfig) {
  return (panelConfig?.dockerDefaultImage || '').trim() || 'ghcr.io/qingchencloud/openclaw'
}

function formatDockerBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function parseOptionalPort(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const num = Number(raw)
  if (!Number.isInteger(num) || num < 1 || num > 65535) throw new Error(t('services.invalidPort', { value: raw }))
  return num
}

async function hasDockerManagerBackend() {
  try {
    const resp = await fetch('/__api/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const ct = (resp.headers.get('content-type') || '').toLowerCase()
    return resp.ok && !ct.includes('text/html') && !ct.includes('text/plain')
  } catch {
    return false
  }
}

async function loadDockerManager(page) {
  // Docker 多实例管理仅在 Web 部署模式（serve.js / dev-api）下有意义。
  // 桌面 Tauri 用户不需要管理多个 OpenClaw 容器，整段 UI 已在 render() 里跳过渲染。
  if (isTauriRuntime()) return
  const bar = page.querySelector('#docker-manager-bar')
  if (!bar) return
  const backendReady = await hasDockerManagerBackend()
  if (!backendReady) {
    bar.innerHTML = `<div class="stat-card"><div class="stat-card-meta">${t('services.dockerManagerUnavailable')}</div></div>`
    return
  }
  try {
    const [overview, panelConfig] = await Promise.all([
      api.dockerClusterOverview(),
      api.readPanelConfig().catch(() => ({})),
    ])
    const totalNodes = overview.length
    const onlineNodes = overview.filter(node => node.online).length
    const totalContainers = overview.reduce((sum, node) => sum + (node.containers?.length || 0), 0)
    const runningContainers = overview.reduce((sum, node) => sum + (node.containers?.filter?.(ct => ct.state === 'running').length || 0), 0)
    const onlyUnavailableLocal = overview.length === 1
      && overview[0]?.id === 'local'
      && !overview[0]?.online
      && !(overview[0]?.containers || []).length
    if (!overview.length || onlyUnavailableLocal) {
      bar.innerHTML = `
        <div class="stat-card" style="padding:16px">
          <div class="stat-card-label">${t('services.dockerOptionalTitle')}</div>
          <div class="stat-card-meta" style="line-height:1.7;margin-top:6px">${t('services.dockerOptionalDesc')}</div>
          ${onlyUnavailableLocal ? `<div class="form-hint" style="margin-top:8px">${escapeHtml(overview[0]?.error || '')}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button class="btn btn-secondary btn-sm" data-action="docker-refresh">${t('services.dockerRefresh')}</button>
            <button class="btn btn-primary btn-sm" data-action="docker-add-node">${t('services.dockerAddNode')}</button>
          </div>
        </div>
      `
      return
    }
    bar.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--space-sm);flex-wrap:wrap;margin-bottom:var(--space-md)">
        <div class="stat-card" style="padding:12px 16px;min-width:260px">
          <div class="stat-card-label">${t('services.dockerManager')}</div>
          <div class="stat-card-meta">${onlineNodes}/${totalNodes} ${t('services.dockerOnline')} · ${runningContainers}/${totalContainers} ${t('services.dockerContainersLabel')}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" data-action="docker-refresh">${t('services.dockerRefresh')}</button>
          <button class="btn btn-secondary btn-sm" data-action="docker-add-node">${t('services.dockerAddNode')}</button>
          <button class="btn btn-secondary btn-sm" data-action="docker-pull-image">${t('services.dockerPullAction')}</button>
          <button class="btn btn-primary btn-sm" data-action="docker-create-container">${t('services.dockerCreateContainer')}</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-md)">
        ${overview.map(node => {
          const containers = node.containers || []
          const nodeMeta = node.online
            ? `${escapeHtml(node.endpoint || '')} · Docker ${escapeHtml(node.dockerVersion || t('common.unknown'))} · ${formatDockerBytes(node.memory)} · CPU ${node.cpus || 0}`
            : `${escapeHtml(node.endpoint || '')} · ${escapeHtml(node.error || t('services.dockerOffline'))}`
          return `
            <div class="service-card" data-docker-node="${escapeHtml(node.id)}" style="display:block">
              <div style="display:flex;justify-content:space-between;gap:var(--space-sm);align-items:flex-start;flex-wrap:wrap">
                <div class="service-info">
                  <span class="status-dot ${node.online ? 'running' : 'stopped'}"></span>
                  <div>
                    <div class="service-name">${escapeHtml(node.name)}${node.id === 'local' ? ` <span class="clawhub-badge" style="margin-left:6px;background:rgba(99,102,241,0.14);color:#6366f1">${t('services.dockerLocalNode')}</span>` : ''}</div>
                    <div class="service-desc">${nodeMeta}</div>
                    <div class="service-desc">${node.online ? `${t('services.dockerContainersLabel')}: ${node.runningContainers || 0}/${node.totalContainers || containers.length}` : t('services.dockerOffline')}</div>
                  </div>
                </div>
                <div class="service-actions">
                  ${node.id !== 'local' ? `<button class="btn btn-danger btn-sm" data-action="docker-remove-node" data-node-id="${escapeHtml(node.id)}" data-name="${escapeHtml(node.name)}">${t('common.delete')}</button>` : ''}
                </div>
              </div>
              <div style="margin-top:var(--space-sm);display:flex;flex-direction:column;gap:8px">
                ${containers.length ? containers.map(ct => `
                  <div class="service-card" style="background:var(--bg-secondary);border:1px solid var(--border-primary)">
                    <div class="service-info">
                      <span class="status-dot ${ct.state === 'running' ? 'running' : 'stopped'}"></span>
                      <div>
                        <div class="service-name">${escapeHtml(ct.name)}</div>
                        <div class="service-desc">${escapeHtml(ct.image)} · ${escapeHtml(ct.status || ct.state || t('common.unknown'))}${ct.ports ? ` · ${escapeHtml(ct.ports)}` : ''}</div>
                      </div>
                    </div>
                    <div class="service-actions">
                      ${ct.state === 'running'
                        ? `<button class="btn btn-secondary btn-sm" data-action="docker-restart-container" data-node-id="${escapeHtml(node.id)}" data-container-id="${escapeHtml(ct.id)}" data-name="${escapeHtml(ct.name)}">${t('services.restart')}</button>
                           <button class="btn btn-secondary btn-sm" data-action="docker-stop-container" data-node-id="${escapeHtml(node.id)}" data-container-id="${escapeHtml(ct.id)}" data-name="${escapeHtml(ct.name)}">${t('services.stop')}</button>`
                        : `<button class="btn btn-primary btn-sm" data-action="docker-start-container" data-node-id="${escapeHtml(node.id)}" data-container-id="${escapeHtml(ct.id)}" data-name="${escapeHtml(ct.name)}">${t('services.start')}</button>`}
                      <button class="btn btn-danger btn-sm" data-action="docker-remove-container" data-node-id="${escapeHtml(node.id)}" data-container-id="${escapeHtml(ct.id)}" data-name="${escapeHtml(ct.name)}" data-running="${ct.state === 'running' ? '1' : ''}">${t('common.delete')}</button>
                    </div>
                  </div>
                `).join('') : `<div class="form-hint" style="padding:4px 0">${t('services.dockerNoContainers')}</div>`}
              </div>
            </div>
          `
        }).join('')}
      </div>
      <div class="form-hint" style="margin-top:var(--space-sm)">${t('services.dockerDefaultImageHint')} <code>${escapeHtml(configuredDockerImage(panelConfig))}</code></div>
    `
  } catch (e) {
    bar.innerHTML = `<div class="stat-card"><div class="stat-card-meta" style="color:var(--error)">${t('services.dockerManagerLoadFailed')}: ${escapeHtml(e?.message || e)}</div></div>`
  }
}

// ===== 服务列表 =====

async function loadServices(page) {
  const container = page.querySelector('#services-list')
  try {
    const services = await api.getServicesStatus()
    renderServices(container, services)
    const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
    if (gw) {
      maybeShowForeignGatewayBindingPrompt({
        service: gw,
        onRefresh: () => loadServices(page),
      }).catch(() => {})
    }
  } catch (e) {
    container.innerHTML = `<div style="color:var(--error)">${t('services.serviceLoadFailed')}: ${escapeHtml(String(e))}</div>`
  }
}

async function openDockerAddNode(page) {
  showModal({
    title: t('services.dockerAddNode'),
    fields: [
      { name: 'name', label: t('services.dockerNodeName'), value: '', placeholder: 'docker-node-1' },
      { name: 'endpoint', label: t('services.dockerNodeEndpoint'), value: '', placeholder: 'tcp://192.168.1.20:2375' },
    ],
    onConfirm: async ({ name, endpoint }) => {
      try {
        await api.dockerAddNode((name || '').trim(), (endpoint || '').trim())
        toast(t('services.dockerNodeAdded'), 'success')
        await loadDockerManager(page)
      } catch (e) {
        toast(e?.message || e, 'error')
      }
    },
  })
}

async function openDockerPullImage(page) {
  const [nodes, panelConfig] = await Promise.all([
    api.dockerListNodes(),
    api.readPanelConfig().catch(() => ({})),
  ])
  showModal({
    title: t('services.dockerPullTitle'),
    fields: [
      { name: 'nodeId', type: 'select', label: t('services.dockerNodeName'), value: nodes[0]?.id || 'local', options: nodes.map(node => ({ value: node.id, label: node.name })) },
      { name: 'image', label: t('services.dockerImageLabel'), value: configuredDockerImage(panelConfig), hint: t('services.dockerDefaultImageHint') },
      { name: 'tag', label: t('services.dockerTagLabel'), value: 'latest' },
    ],
    onConfirm: async ({ nodeId, image, tag }) => {
      const requestId = `pull-${Date.now()}`
      const modal = showUpgradeModal(t('services.dockerPullTitle'))
      let lastMessage = ''
      const timer = setInterval(async () => {
        try {
          const status = await api.dockerPullStatus(requestId)
          if (Number.isFinite(status?.percent)) modal.setProgress(status.percent)
          if (status?.message && status.message !== lastMessage) {
            lastMessage = status.message
            modal.appendLog(status.message)
          }
        } catch {}
      }, 800)

      try {
        const result = await api.dockerPullImage({
          nodeId: nodeId || null,
          image: (image || '').trim() || configuredDockerImage(panelConfig),
          tag: (tag || '').trim() || 'latest',
          requestId,
        })
        clearInterval(timer)
        modal.setProgress(100)
        if (result?.message) modal.appendLog(result.message)
        modal.setDone(t('services.dockerPullDone'))
        toast(t('services.dockerPullDone'), 'success')
        await loadDockerManager(page)
      } catch (e) {
        clearInterval(timer)
        modal.appendLog(e?.message || String(e))
        modal.setError(e?.message || String(e))
        toast(e?.message || e, 'error')
      }
    },
  })
}

async function openDockerCreateContainer(page) {
  const [nodes, panelConfig] = await Promise.all([
    api.dockerListNodes(),
    api.readPanelConfig().catch(() => ({})),
  ])
  showModal({
    title: t('services.dockerCreateTitle'),
    fields: [
      { name: 'nodeId', type: 'select', label: t('services.dockerNodeName'), value: nodes[0]?.id || 'local', options: nodes.map(node => ({ value: node.id, label: node.name })) },
      { name: 'name', label: t('services.dockerContainerNameLabel'), value: '', placeholder: 'openclaw-worker-1' },
      { name: 'image', label: t('services.dockerImageLabel'), value: configuredDockerImage(panelConfig), hint: t('services.dockerDefaultImageHint') },
      { name: 'tag', label: t('services.dockerTagLabel'), value: 'latest' },
      { name: 'panelPort', label: t('services.dockerPanelPortLabel'), value: '1420', hint: t('services.dockerPortOptionalHint') },
      { name: 'gatewayPort', label: t('services.dockerGatewayPortLabel'), value: '18789', hint: t('services.dockerPortOptionalHint') },
      { name: 'volume', type: 'checkbox', label: t('services.dockerUseVolume'), value: true },
    ],
    onConfirm: async ({ nodeId, name, image, tag, panelPort, gatewayPort, volume }) => {
      try {
        await api.dockerCreateContainer({
          nodeId: nodeId || null,
          name: (name || '').trim() || undefined,
          image: (image || '').trim() || configuredDockerImage(panelConfig),
          tag: (tag || '').trim() || 'latest',
          panelPort: parseOptionalPort(panelPort),
          gatewayPort: parseOptionalPort(gatewayPort),
          volume: !!volume,
        })
        toast(t('services.dockerContainerCreated'), 'success')
        await loadDockerManager(page)
      } catch (e) {
        toast(e?.message || e, 'error')
      }
    },
  })
}

async function handleDockerRemoveNode(btn, page) {
  const name = btn.dataset.name || btn.dataset.nodeId || ''
  const yes = await showConfirm(t('services.dockerRemoveNodeConfirm', { name }))
  if (!yes) return
  await api.dockerRemoveNode(btn.dataset.nodeId)
  toast(t('services.dockerNodeRemoved'), 'success')
  await loadDockerManager(page)
}

async function handleDockerContainerAction(action, btn, page) {
  const nodeId = btn.dataset.nodeId || null
  const containerId = btn.dataset.containerId
  const name = btn.dataset.name || containerId
  if (!containerId) throw new Error(t('services.missingContainerId'))
  if (action === 'docker-remove-container') {
    const yes = await showConfirm(t('services.dockerRemoveContainerConfirm', { name }))
    if (!yes) return
    await api.dockerRemoveContainer(nodeId, containerId, btn.dataset.running === '1')
    toast(t('services.dockerContainerRemoved'), 'success')
    await loadDockerManager(page)
    return
  }

  const label = {
    'docker-start-container': t('services.start'),
    'docker-stop-container': t('services.stop'),
    'docker-restart-container': t('services.restart'),
  }[action]
  const fn = {
    'docker-start-container': api.dockerStartContainer,
    'docker-stop-container': api.dockerStopContainer,
    'docker-restart-container': api.dockerRestartContainer,
  }[action]
  await fn(nodeId, containerId)
  toast(t('services.actionDone', { label: name, action: label }), 'success')
  await loadDockerManager(page)
}

async function openGatewayConflict(page, error = null) {
  const services = await api.getServicesStatus().catch(() => [])
  const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
  await showGatewayConflictGuidance({
    error,
    service: gw,
    onRefresh: async () => {
      await loadVersion(page)
      await loadServices(page)
    },
  })
}

function renderServices(container, services) {
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')

  let html = ''
  if (gw) {
    // 检测 CLI 是否安装
    const cliMissing = gw.cli_installed === false
    const foreignGateway = !cliMissing && isForeignGatewayService(gw)
    const foreignPidText = gw.pid ? ` (PID: ${gw.pid})` : ''
    // 协议版本徽章（仅在 Gateway 跑起来并完成 WS 握手时显示）
    const proto = wsClient.gatewayReady ? wsClient.negotiatedProtocol : null
    const protoBadge = proto ? `<span class="proto-badge" title="${t('services.protocolBadgeTitle', { proto })}">${t('services.protocolBadge', { proto })}</span>` : ''

    html += `
    <div class="service-card" data-label="${gw.label}">
      <div class="service-info">
        <span class="status-dot ${cliMissing ? 'stopped' : foreignGateway ? 'warning' : gw.running ? 'running' : 'stopped'}"></span>
        <div>
          <div class="service-name">${gw.label}${protoBadge}</div>
          <div class="service-desc">${cliMissing
            ? t('services.cliNotInstalled')
            : foreignGateway
              ? t('services.foreignGatewayDesc', { pid: foreignPidText, settings: t('sidebar.settings') })
            : (gw.description || '') + (gw.pid ? ' (PID: ' + gw.pid + ')' : '')
          }</div>
        </div>
      </div>
      <div class="service-actions">
        ${cliMissing
          ? `<div style="display:flex;flex-direction:column;gap:var(--space-xs);align-items:flex-end">
               <div style="color:var(--text-tertiary);font-size:var(--font-size-xs)">${t('services.installCliHint')}</div>
               <code style="font-size:var(--font-size-xs);background:var(--bg-tertiary);padding:2px 8px;border-radius:4px;user-select:all">npm install -g @qingchencloud/openclaw-zh</code>
               <button class="btn btn-secondary btn-sm" data-action="refresh-services" style="margin-top:4px">${t('services.refreshStatus')}</button>
             </div>`
          : foreignGateway
            ? `<div style="display:flex;flex-direction:column;gap:var(--space-xs);align-items:flex-end">
                 <div style="color:var(--warning);font-size:var(--font-size-xs);max-width:320px;text-align:right">${t('services.foreignGatewayHint')}</div>
                 <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                   <button class="btn btn-primary btn-sm" data-action="claim-gateway">${t('services.claimGateway')}</button>
                   <button class="btn btn-secondary btn-sm" data-action="resolve-foreign-gateway">${t('dashboard.viewGuidance')}</button>
                   <button class="btn btn-secondary btn-sm" data-action="refresh-services">${t('services.refreshStatus')}</button>
                 </div>
               </div>`
          : gw.running
            ? `<button class="btn btn-secondary btn-sm" data-action="restart" data-label="${gw.label}">${t('services.restart')}</button>
               <button class="btn btn-danger btn-sm" data-action="stop" data-label="${gw.label}">${t('services.stop')}</button>
               ${isMacPlatform() ? `<button class="btn btn-danger btn-sm" data-action="uninstall-gateway">${t('services.uninstall')}</button>` : ''}`
            : `<button class="btn btn-primary btn-sm" data-action="start" data-label="${gw.label}">${t('services.start')}</button>
               ${isMacPlatform() ? `<button class="btn btn-primary btn-sm" data-action="install-gateway">${t('services.install')}</button><button class="btn btn-danger btn-sm" data-action="uninstall-gateway">${t('services.uninstall')}</button>` : ''}`
        }
      </div>
    </div>`
  } else {
    html += `
    <div class="service-card">
      <div class="service-info">
        <span class="status-dot stopped"></span>
        <div>
          <div class="service-name">ai.openclaw.gateway</div>
          <div class="service-desc">${t('services.gwNotInstalled')}</div>
        </div>
      </div>
      <div class="service-actions">
        <button class="btn btn-primary btn-sm" data-action="install-gateway">${t('services.install')}</button>
      </div>
    </div>`
  }

  container.innerHTML = html
}

// ===== 备份管理 =====

async function loadBackups(page) {
  const list = page.querySelector('#backup-list')
  try {
    const backups = await api.listBackups()
    renderBackups(list, backups)
  } catch (e) {
    list.innerHTML = `<div style="color:var(--error)">${t('services.backupLoadFailed')}: ${e}</div>`
  }
}

function renderBackups(container, backups) {
  if (!backups || !backups.length) {
    container.innerHTML = `<div style="color:var(--text-tertiary);padding:var(--space-md) 0">${t('services.noBackup')}</div>`
    return
  }
  container.innerHTML = backups.map(b => {
    const date = b.created_at ? new Date(b.created_at * 1000).toLocaleString() : t('common.unknown')
    const size = b.size ? (b.size / 1024).toFixed(1) + ' KB' : ''
    return `
      <div class="service-card" data-backup="${b.name}">
        <div class="service-info">
          <div>
            <div class="service-name">${b.name}</div>
            <div class="service-desc">${date}${size ? ' · ' + size : ''}</div>
          </div>
        </div>
        <div class="service-actions">
          <button class="btn btn-primary btn-sm" data-action="restore-backup" data-name="${b.name}">${t('services.restore')}</button>
          <button class="btn btn-danger btn-sm" data-action="delete-backup" data-name="${b.name}">${t('common.delete')}</button>
        </div>
      </div>`
  }).join('')
}

// ===== 事件绑定（事件委托） =====

function bindEvents(page) {
  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    btn.disabled = true

    try {
      switch (action) {
        case 'start':
        case 'stop':
        case 'restart':
          await handleServiceAction(action, btn.dataset.label, page)
          break
        case 'save-config':
          await handleSaveConfig(page, true)
          break
        case 'save-config-only':
          await handleSaveConfig(page, false)
          break
        case 'reload-config':
          await loadConfigEditor(page)
          break
        case 'calibrate-config-inherit':
          await handleCalibrateConfig(page, 'inherit')
          break
        case 'calibrate-config-reset':
          await handleCalibrateConfig(page, 'reset')
          break
        case 'create-backup':
          await handleCreateBackup(page)
          break
        case 'restore-backup':
          await handleRestoreBackup(btn.dataset.name, page)
          break
        case 'delete-backup':
          await handleDeleteBackup(btn.dataset.name, page)
          break
        case 'upgrade':
          await handleUpgrade(btn, page)
          break
        case 'upgrade-latest':
          await handleUpgradeLatest(btn, page)
          break
        case 'switch-source':
          await handleSwitchSource(btn.dataset.source, page)
          break
        case 'install-gateway':
          await handleInstallGateway(btn, page)
          break
        case 'uninstall-gateway':
          await handleUninstallGateway(btn, page)
          break
        case 'refresh-services':
          await loadServices(page)
          break
        case 'claim-gateway':
          await handleClaimGateway(btn, page)
          break
        case 'resolve-foreign-gateway':
          await openGatewayConflict(page)
          break
        case 'docker-refresh':
          await loadDockerManager(page)
          break
        case 'docker-add-node':
          await openDockerAddNode(page)
          break
        case 'docker-pull-image':
          await openDockerPullImage(page)
          break
        case 'docker-create-container':
          await openDockerCreateContainer(page)
          break
        case 'docker-remove-node':
          await handleDockerRemoveNode(btn, page)
          break
        case 'docker-start-container':
        case 'docker-stop-container':
        case 'docker-restart-container':
        case 'docker-remove-container':
          await handleDockerContainerAction(action, btn, page)
          break
      }
    } catch (e) {
      toast(e.toString(), 'error')
    } finally {
      btn.disabled = false
    }
  })
}

// ===== 服务操作 =====

const ACTION_LABELS = { start: t('services.start'), stop: t('services.stop'), restart: t('services.restart') }
const POLL_INTERVAL = 1500  // 轮询间隔 ms
const POLL_TIMEOUT = 30000  // 最长等待 30s

async function handleServiceAction(action, label, page) {
  const fn = { start: api.startService, stop: api.stopService, restart: api.restartService }[action]
  const actionLabel = ACTION_LABELS[action]
  const expectRunning = action !== 'stop'

  // 通知守护模块：用户主动操作
  if (action === 'stop') setUserStopped(true)
  if (action === 'start') resetAutoRestart()

  // 找到触发按钮所在的 service-card，替换按钮区域为加载状态
  const card = page.querySelector(`.service-card[data-label="${label}"]`)
  const actionsEl = card?.querySelector('.service-actions')
  const origHtml = actionsEl?.innerHTML || ''

  let cancelled = false
  if (actionsEl) {
    actionsEl.innerHTML = `
      <div class="service-loading">
        <div class="service-spinner"></div>
        <span class="service-loading-text">${t('services.actionProgress', { action: actionLabel })}</span>
        <button class="btn btn-sm btn-ghost service-cancel-btn" style="display:none">${t('services.cancelWait')}</button>
      </div>`
    const cancelBtn = actionsEl.querySelector('.service-cancel-btn')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => { cancelled = true })
    }
  }

  // 更新状态点为加载中
  const dot = card?.querySelector('.status-dot')
  if (dot) { dot.className = 'status-dot loading' }

  try {
    await fn(label)
  } catch (e) {
    if (isForeignGatewayError(e)) {
      await openGatewayConflict(page, e)
    } else if (_looksLikeInvalidConfigError(e)) {
      // 上游 5.x doctor 增强：配置 schema 错误 → 直接给一键修复入口，
      // 而不是丢一个 toast 让小白对着 stderr 干瞪眼。
      await _promptDoctorFix(page, actionLabel, e)
    } else {
      toast(t('services.actionCmdFailed', { action: actionLabel, error: e.message || e }), 'error')
    }
    if (actionsEl) actionsEl.innerHTML = origHtml
    if (dot) dot.className = 'status-dot stopped'
    return
  }

  // 轮询等待实际状态变化
  const startTime = Date.now()
  let showedCancel = false
  const loadingText = actionsEl?.querySelector('.service-loading-text')
  const cancelBtn = actionsEl?.querySelector('.service-cancel-btn')

  while (!cancelled) {
    const elapsed = Date.now() - startTime

    // 5 秒后显示取消按钮
    if (!showedCancel && elapsed > 5000 && cancelBtn) {
      cancelBtn.style.display = ''
      showedCancel = true
    }

    // 更新等待时间
    if (loadingText) {
      const sec = Math.floor(elapsed / 1000)
      loadingText.textContent = t('services.actionProgressSec', { action: actionLabel, sec })
    }

    // 超时
    if (elapsed > POLL_TIMEOUT) {
      toast(t('services.actionTimeout', { action: actionLabel }), 'warning')
      break
    }

    // 检查实际状态
    try {
      const services = await api.getServicesStatus()
      const svc = services?.find?.(s => s.label === label) || services?.[0]
      if (svc && svc.running === expectRunning) {
        toast(t('services.actionDone', { label, action: actionLabel }) + (svc.pid ? ' (PID: ' + svc.pid + ')' : ''), 'success')
        // 立刻同步全局 Gateway 状态（顶部 banner + WS 连接）
        import('../lib/app-state.js').then(m => m.refreshGatewayStatus()).catch(() => {})
        await loadServices(page)
        return
      }
    } catch {}

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }

  if (cancelled) {
    toast(t('services.cancelled'), 'info')
  }
  await loadServices(page)
}

// ===== 备份操作 =====

async function handleCreateBackup(page) {
  const result = await api.createBackup()
  toast(t('services.backupCreated', { name: result.name }), 'success')
  await loadBackups(page)
}

async function handleRestoreBackup(name, page) {
  const yes = await showConfirm(t('services.restoreConfirm', { name }))
  if (!yes) return
  await api.restoreBackup(name)
  toast(t('services.restored'), 'success')
  await loadBackups(page)
}

async function handleDeleteBackup(name, page) {
  const yes = await showConfirm({
    title: t('services.deleteBackupTitle', { name }),
    message: t('services.deleteConfirm', { name }),
    impact: [t('services.deleteBackupImpact')],
    confirmText: t('services.deleteBackupBtn'),
    cancelText: t('services.deleteBackupCancel'),
  })
  if (!yes) return
  await api.deleteBackup(name)
  toast(t('services.backupDeleted'), 'success')
  await loadBackups(page)
}

function calibrationSourceLabel(source) {
  if (source === 'backup') return t('services.calibrationSourceBackup')
  if (source === 'current') return t('services.calibrationSourceCurrent')
  return t('services.calibrationSourceEmpty')
}

async function handleCalibrateConfig(page, mode) {
  const yes = await showConfirm(mode === 'reset'
    ? t('services.calibrateResetConfirm')
    : t('services.calibrateInheritConfirm'))
  if (!yes) return

  const status = page.querySelector('#config-calibration-status')
  if (status) status.innerHTML = `<span style="color:var(--text-tertiary)">${t('services.calibrating')}</span>`

  const result = await api.calibrateOpenclawConfig(mode)
  const summary = t('services.calibrationSummary', {
    mode: mode === 'reset' ? t('services.calibrateReset') : t('services.calibrateInherit'),
    source: calibrationSourceLabel(result?.source),
    count: String(result?.inheritedKeys?.length || 0),
  })
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : []

  if (status) status.innerHTML = `<span style="color:var(--success)">${escapeHtml(summary)}</span>${warnings.length ? `<br><span style="color:var(--warning)">${escapeHtml(warnings.join('；'))}</span>` : ''}`
  toast(t('services.calibrationDone') + ' · ' + summary, 'success')
  if (warnings.length) toast(warnings.join('；'), 'warning')

  await Promise.all([
    loadConfigEditor(page),
    loadBackups(page),
    loadServices(page),
  ])
}

// ===== 配置文件编辑器 =====

let _configOriginal = ''

async function loadConfigEditor(page) {
  const section = page.querySelector('#config-editor-section')
  const area = page.querySelector('#config-editor-area')
  const status = page.querySelector('#config-editor-status')
  const btnSave = page.querySelector('[data-action="save-config"]')
  const btnSaveOnly = page.querySelector('[data-action="save-config-only"]')

  try {
    const config = await api.readOpenclawConfig()
    const json = JSON.stringify(config, null, 2)
    _configOriginal = json
    area.value = json
    area.disabled = false
    btnSave.disabled = false
    btnSaveOnly.disabled = false
    section.style.display = ''
    status.innerHTML = `<span style="color:var(--text-tertiary)">${t('services.configLoaded')} · ${(json.length / 1024).toFixed(1)} KB</span>`

    // 实时检测 JSON 语法
    area.oninput = () => {
      try {
        JSON.parse(area.value)
        const changed = area.value !== _configOriginal
        status.innerHTML = changed
          ? `<span style="color:var(--warning)">● ${t('services.configUnsaved')}</span>`
          : `<span style="color:var(--text-tertiary)">${t('services.configNoChange')}</span>`
        btnSave.disabled = !changed
        btnSaveOnly.disabled = !changed
      } catch (e) {
        status.innerHTML = `<span style="color:var(--error)">${t('services.configJsonError')}: ${e.message.split(' at ')[0]}</span>`
        btnSave.disabled = true
        btnSaveOnly.disabled = true
      }
    }
  } catch {
    // openclaw.json 不存在，隐藏编辑器
    section.style.display = 'none'
  }
}

async function handleSaveConfig(page, restart) {
  const area = page.querySelector('#config-editor-area')
  const status = page.querySelector('#config-editor-status')

  let config
  try {
    config = JSON.parse(area.value)
  } catch (e) {
    toast(t('services.configSaveJsonError'), 'error')
    return
  }

  status.innerHTML = `<span style="color:var(--text-tertiary)">${t('services.autoBackingUp')}</span>`

  try {
    // 保存前自动备份
    await api.createBackup()
  } catch (e) {
    const yes = await showConfirm(t('services.autoBackupFailed') + ': ' + e + '\n\n' + t('services.continueWithoutBackup'))
    if (!yes) return
  }

  status.innerHTML = `<span style="color:var(--text-tertiary)">${t('services.saving')}</span>`

  try {
    await api.writeOpenclawConfig(config)
    _configOriginal = area.value
    toast(restart ? t('services.configSavedRestarting') : t('services.configSaved'), 'success')
    status.innerHTML = `<span style="color:var(--success)">${t('services.configSaved')}</span>`

    page.querySelector('[data-action="save-config"]').disabled = true
    page.querySelector('[data-action="save-config-only"]').disabled = true

    if (restart) {
      try {
        await api.restartGateway()
        toast(t('services.gwRestarted'), 'success')
      } catch (e) {
        toast(humanizeError(e, t('services.configSavedGwFailed')), 'warning')
      }
      await loadServices(page)
    }

    await loadBackups(page)
  } catch (e) {
    toast(humanizeError(e, t('common.saveFailed')), 'error')
    status.innerHTML = `<span style="color:var(--error)">${t('common.saveFailed')}: ${e}</span>`
  }
}

// ===== 升级操作 =====

async function doUpgradeWithModal(source, page, version = null, method = 'auto') {
  const modal = showUpgradeModal(t('services.upgradeTitle'))
  let unlistenLog, unlistenProgress, unlistenDone, unlistenError
  setUpgrading(true)

  // 清理所有监听
  const cleanup = () => {
    setUpgrading(false)
    unlistenLog?.()
    unlistenProgress?.()
    unlistenDone?.()
    unlistenError?.()
  }

  try {
    if (window.__TAURI_INTERNALS__) {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
      unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))

      // 后台任务完成事件
      unlistenDone = await listen('upgrade-done', (e) => {
        cleanup()
        modal.setDone(typeof e.payload === 'string' ? e.payload : t('services.taskDone'))
        loadVersion(page)
      })

      // 后台任务失败事件
      unlistenError = await listen('upgrade-error', (e) => {
        cleanup()
        const errStr = String(e.payload || t('common.error'))
        modal.appendLog(errStr)
        const fullLog = modal.getLogText() + '\n' + errStr
        const diagnosis = diagnoseInstallError(fullLog)
        modal.setError(diagnosis.title)
        if (diagnosis.hint) modal.appendLog('')
        if (diagnosis.hint) modal.appendHtmlLog(`${statusIcon('info', 14)} ${diagnosis.hint}`)
        if (diagnosis.command) modal.appendHtmlLog(`${icon('clipboard', 14)} ${diagnosis.command}`)
        if (window.__openAIDrawerWithError) {
          window.__openAIDrawerWithError({ title: diagnosis.title, error: fullLog, scene: t('services.upgradeScene'), hint: diagnosis.hint })
        }
      })

      // 发起后台任务（立即返回）
      await api.upgradeOpenclaw(source, version, method)
      modal.appendLog(t('services.taskStarted'))
    } else {
      // Web 模式：仍然同步等待（dev-api 后端没有 spawn）
      modal.appendLog(t('services.webModeNoLog'))
      const msg = await api.upgradeOpenclaw(source, version, method)
      modal.setDone(typeof msg === 'string' ? msg : (msg?.message || t('services.upgradeDone')))
      await loadVersion(page)
      cleanup()
    }
  } catch (e) {
    cleanup()
    const errStr = String(e)
    modal.appendLog(errStr)
    const fullLog = modal.getLogText() + '\n' + errStr
    const diagnosis = diagnoseInstallError(fullLog)
    modal.setError(diagnosis.title)
  }
}

async function handleUpgrade(btn, page) {
  const sourceLabel = detectedSource === 'official' ? t('services.officialEdition') : t('services.chineseEdition')
  const recommended = lastVersionInfo?.recommended
  const yes = await showConfirm(t('services.upgradeConfirm', { source: sourceLabel, version: recommended ? `（${recommended}）` : '' }))
  if (!yes) return
  await doUpgradeWithModal(detectedSource, page, recommended || null)
}

async function handleUpgradeLatest(btn, page) {
  const sourceLabel = detectedSource === 'official' ? t('services.officialEdition') : t('services.chineseEdition')
  const latest = btn.dataset.version || lastVersionInfo?.latest
  if (!latest) return
  const yes = await showConfirm(t('services.upgradeLatestConfirm', { source: sourceLabel, version: `（${latest}）` }))
  if (!yes) return
  await doUpgradeWithModal(detectedSource, page, latest)
}

async function handleSwitchSource(target, page) {
  const targetLabel = target === 'official' ? t('services.officialEdition') : t('services.chineseEdition')
  const recommended = target === 'official'
    ? (lastVersionInfo?.source === 'official' ? lastVersionInfo?.recommended : null)
    : (lastVersionInfo?.source === 'chinese' ? lastVersionInfo?.recommended : null)
  const yes = await showConfirm(t('services.switchSourceConfirm', { target: targetLabel, version: recommended ? `（${recommended}）` : '' }))
  if (!yes) return
  await doUpgradeWithModal(target, page, null)
}

// ===== 认领外部 Gateway =====

async function handleClaimGateway(btn, page) {
  btn.classList.add('btn-loading')
  btn.textContent = t('common.processing')
  try {
    await api.claimGateway()
    toast(t('services.claimSuccess'), 'success')
    // 立刻刷新全局 Gateway 状态
    const { refreshGatewayStatus } = await import('../lib/app-state.js')
    await refreshGatewayStatus()
    await loadServices(page)
  } catch (e) {
    toast(humanizeError(e, t('services.claimFailed')), 'error')
    btn.classList.remove('btn-loading')
    btn.textContent = t('services.claimGateway')
  }
}

// ===== Gateway 安装/卸载 =====

async function handleInstallGateway(btn, page) {
  btn.classList.add('btn-loading')
  btn.textContent = t('services.installing')
  try {
    await api.installGateway()
    toast(t('services.gwInstalled'), 'success')
    await loadServices(page)
  } catch (e) {
    toast(humanizeError(e, t('services.installFailed')), 'error')
    btn.classList.remove('btn-loading')
    btn.textContent = t('services.install')
  }
}

async function handleUninstallGateway(btn, page) {
  const yes = await showConfirm({
    title: t('services.uninstallTitle'),
    message: t('services.uninstallConfirm'),
    impact: [
      t('services.uninstallImpactStop'),
      t('services.uninstallImpactAutostart'),
      t('services.uninstallImpactConfig'),
    ],
    confirmText: t('services.uninstallBtn'),
    cancelText: t('services.uninstallCancelBtn'),
  })
  if (!yes) return
  btn.classList.add('btn-loading')
  btn.textContent = t('services.uninstalling')
  try {
    await api.uninstallGateway()
    toast(t('services.gwUninstalled'), 'success')
    await loadServices(page)
  } catch (e) {
    toast(humanizeError(e, t('services.uninstallFailed')), 'error')
    btn.classList.remove('btn-loading')
    btn.textContent = t('services.uninstall')
  }
}

// === 配置错误一键修复（上游 5.x doctor --fix 自动迁移多种 schema 问题） ===

/**
 * 判断错误是不是来自 OpenClaw 的配置 schema 校验失败。
 *
 * 命中关键词（覆盖中英文上游 stderr 模式）：
 *  - "invalid config" / "schema validation" / "schema error"
 *  - "unknown field" / "unrecognized key" / "extra fields"
 *  - "config validation" / "doctor --fix"
 *  - 中文："配置无效" / "配置校验失败" / "未知字段"
 */
function _looksLikeInvalidConfigError(e) {
  const msg = String(e?.message || e || '').toLowerCase()
  if (!msg) return false
  return (
    /invalid\s+config/.test(msg) ||
    /schema\s+(validation|error)/.test(msg) ||
    /config\s+validation/.test(msg) ||
    /(unknown|unrecognized)\s+(field|key)/.test(msg) ||
    /extra\s+fields/.test(msg) ||
    /doctor\s+--?fix/.test(msg) ||
    msg.includes('配置无效') ||
    msg.includes('配置校验失败') ||
    msg.includes('未知字段')
  )
}

/**
 * 弹出"检测到配置问题，要不要跑 doctor --fix"的引导。
 *
 * 这个交互替代单纯的红色 toast：
 *  - 让小白看到一个**可点击的修复路径**而不是无解的报错文本
 *  - 修复成功后自动重新加载服务列表
 *  - 修复失败再回退到原有的 toast 错误展示
 */
async function _promptDoctorFix(page, actionLabel, originalErr) {
  const errMsg = String(originalErr?.message || originalErr || '')
  const yes = await showConfirm(
    t('services.invalidConfigPrompt', { action: actionLabel, error: errMsg }),
    {
      title: t('services.invalidConfigTitle'),
      confirmText: t('services.runDoctorFix'),
      cancelText: t('common.cancel'),
      variant: 'primary',  // 修复是建设性操作，按钮用 primary 蓝色而非 danger 红色
    }
  )
  if (!yes) {
    toast(t('services.actionCmdFailed', { action: actionLabel, error: errMsg }), 'error')
    return
  }

  toast(t('services.runningDoctorFix'), 'info')
  try {
    await api.doctorFix()
    toast(t('services.doctorFixSuccess'), 'success')
    // doctor 改了配置，缓存可能脏 → 强制刷新
    invalidate('read_openclaw_config')
    await loadServices(page)
  } catch (e2) {
    toast(t('services.doctorFixFailed') + ': ' + (e2?.message || e2), 'error')
  }
}
