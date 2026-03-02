/**
 * 服务管理页面
 * 服务启停 + 更新检测 + 配置备份管理
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm, showUpgradeModal } from '../components/modal.js'

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
      <h1 class="page-title">服务管理</h1>
      <p class="page-desc">管理 OpenClaw 服务、检查更新、配置备份</p>
    </div>
    <div id="version-bar"></div>
    <div id="services-list" class="loading-text">加载中...</div>
    <div class="config-section" id="registry-section">
      <div class="config-section-title">npm 源设置</div>
      <div id="registry-bar" class="loading-text">加载中...</div>
    </div>
    <div class="config-section" id="backup-section">
      <div class="config-section-title">配置备份</div>
      <div class="form-hint" style="margin-bottom:var(--space-sm)">备份范围：openclaw.json 主配置文件（含模型、Provider、Gateway 设置）。Agent 数据和记忆文件不在此备份范围内。</div>
      <div id="backup-actions" style="margin-bottom:var(--space-md)">
        <button class="btn btn-primary btn-sm" data-action="create-backup">创建备份</button>
      </div>
      <div id="backup-list" class="loading-text">加载中...</div>
    </div>
  `

  bindEvents(page)
  loadAll(page)
  return page
}

async function loadAll(page) {
  await Promise.all([
    loadVersion(page),
    loadServices(page),
    loadRegistry(page),
    loadBackups(page),
  ])
}

// ===== 版本检测 =====

// 后端检测到的当前安装源
let detectedSource = 'chinese'

async function loadVersion(page) {
  const bar = page.querySelector('#version-bar')
  try {
    const info = await api.getVersionInfo()
    detectedSource = info.source || 'chinese'
    const ver = info.current || '未知'
    const hasUpdate = info.update_available
    const isChinese = detectedSource === 'chinese'
    const sourceTag = isChinese ? '汉化优化版' : '官方原版'
    const switchLabel = isChinese ? '切换到官方版' : '切换到汉化版'
    const switchTarget = isChinese ? 'official' : 'chinese'
    bar.innerHTML = `
      <div class="stat-cards" style="margin-bottom:var(--space-lg)">
        <div class="stat-card">
          <div class="stat-card-header">
            <span class="stat-card-label">当前版本 · <span style="color:var(--accent)">${sourceTag}</span></span>
          </div>
          <div class="stat-card-value">${ver}</div>
          <div class="stat-card-meta">${hasUpdate ? '新版本: ' + info.latest : '已是最新版本'}</div>
          <div style="display:flex;gap:var(--space-sm);margin-top:var(--space-sm);flex-wrap:wrap">
            ${hasUpdate ? '<button class="btn btn-primary btn-sm" data-action="upgrade">升级到最新版</button>' : ''}
            <button class="btn btn-secondary btn-sm" data-action="switch-source" data-source="${switchTarget}">${switchLabel}</button>
          </div>
        </div>
      </div>
    `
  } catch (e) {
    bar.innerHTML = `<div class="stat-card" style="margin-bottom:var(--space-lg)"><div class="stat-card-label">版本信息加载失败</div></div>`
  }
}

// ===== npm 源设置 =====

const REGISTRIES = [
  { label: '淘宝镜像 (推荐)', value: 'https://registry.npmmirror.com' },
  { label: 'npm 官方源', value: 'https://registry.npmjs.org' },
  { label: '华为云镜像', value: 'https://repo.huaweicloud.com/repository/npm/' },
]

async function loadRegistry(page) {
  const bar = page.querySelector('#registry-bar')
  bar.innerHTML = '<div class="loading-text">加载中...</div>'
  try {
    const current = await api.getNpmRegistry()
    const isPreset = REGISTRIES.some(r => r.value === current)
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">
        <select class="form-input" data-name="registry" style="max-width:320px">
          ${REGISTRIES.map(r => `<option value="${r.value}" ${r.value === current ? 'selected' : ''}>${r.label}</option>`).join('')}
          <option value="custom" ${!isPreset ? 'selected' : ''}>自定义</option>
        </select>
        <input class="form-input" data-name="custom-registry" placeholder="https://..." value="${isPreset ? '' : escapeHtml(current)}" style="max-width:320px;${isPreset ? 'display:none' : ''}">
        <button class="btn btn-primary btn-sm" data-action="save-registry">保存</button>
      </div>
      <div class="form-hint" style="margin-top:var(--space-xs)">升级和版本检测使用此源下载 npm 包，国内用户推荐淘宝镜像</div>
    `
    // 切换预设/自定义
    const select = bar.querySelector('[data-name="registry"]')
    const customInput = bar.querySelector('[data-name="custom-registry"]')
    select.onchange = () => {
      customInput.style.display = select.value === 'custom' ? '' : 'none'
    }
  } catch (e) {
    bar.innerHTML = `<div style="color:var(--error)">加载失败: ${escapeHtml(String(e))}</div>`
  }
}

// ===== 服务列表 =====

async function loadServices(page) {
  const container = page.querySelector('#services-list')
  container.innerHTML = '<div class="loading-text">加载中...</div>'
  try {
    const services = await api.getServicesStatus()
    renderServices(container, services)
  } catch (e) {
    container.innerHTML = `<div style="color:var(--error)">加载服务列表失败: ${escapeHtml(String(e))}</div>`
  }
}

function renderServices(container, services) {
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')

  let html = ''
  if (gw) {
    // 检测 CLI 是否安装
    const cliMissing = gw.cli_installed === false

    html += `
    <div class="service-card" data-label="${gw.label}">
      <div class="service-info">
        <span class="status-dot ${cliMissing ? 'stopped' : gw.running ? 'running' : 'stopped'}"></span>
        <div>
          <div class="service-name">${gw.label}</div>
          <div class="service-desc">${cliMissing
            ? 'OpenClaw CLI 未安装'
            : (gw.description || '') + (gw.pid ? ' (PID: ' + gw.pid + ')' : '')
          }</div>
        </div>
      </div>
      <div class="service-actions">
        ${cliMissing
          ? `<div style="display:flex;flex-direction:column;gap:var(--space-xs);align-items:flex-end">
               <div style="color:var(--text-tertiary);font-size:var(--font-size-xs)">请先安装 OpenClaw CLI:</div>
               <code style="font-size:var(--font-size-xs);background:var(--bg-tertiary);padding:2px 8px;border-radius:4px;user-select:all">npm install -g @qingchencloud/openclaw-zh</code>
               <button class="btn btn-secondary btn-sm" data-action="refresh-services" style="margin-top:4px">刷新状态</button>
             </div>`
          : gw.running
            ? `<button class="btn btn-secondary btn-sm" data-action="restart" data-label="${gw.label}">重启</button>
               <button class="btn btn-danger btn-sm" data-action="stop" data-label="${gw.label}">停止</button>
               <button class="btn btn-danger btn-sm" data-action="uninstall-gateway">卸载</button>`
            : `<button class="btn btn-primary btn-sm" data-action="start" data-label="${gw.label}">启动</button>
               <button class="btn btn-primary btn-sm" data-action="install-gateway">安装</button>
               <button class="btn btn-danger btn-sm" data-action="uninstall-gateway">卸载</button>`
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
          <div class="service-desc">Gateway 服务未安装</div>
        </div>
      </div>
      <div class="service-actions">
        <button class="btn btn-primary btn-sm" data-action="install-gateway">安装</button>
      </div>
    </div>`
  }

  container.innerHTML = html
}

// ===== 备份管理 =====

async function loadBackups(page) {
  const list = page.querySelector('#backup-list')
  list.innerHTML = '<div class="loading-text">加载中...</div>'
  try {
    const backups = await api.listBackups()
    renderBackups(list, backups)
  } catch (e) {
    list.innerHTML = `<div style="color:var(--error)">加载备份列表失败: ${e}</div>`
  }
}

function renderBackups(container, backups) {
  if (!backups || !backups.length) {
    container.innerHTML = '<div style="color:var(--text-tertiary);padding:var(--space-md) 0">暂无备份</div>'
    return
  }
  container.innerHTML = backups.map(b => {
    const date = b.created_at ? new Date(b.created_at * 1000).toLocaleString('zh-CN') : '未知'
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
          <button class="btn btn-primary btn-sm" data-action="restore-backup" data-name="${b.name}">恢复</button>
          <button class="btn btn-danger btn-sm" data-action="delete-backup" data-name="${b.name}">删除</button>
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
        case 'save-registry':
          await handleSaveRegistry(btn, page)
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

const ACTION_LABELS = { start: '启动', stop: '停止', restart: '重启' }

async function handleServiceAction(action, label, page) {
  const fn = { start: api.startService, stop: api.stopService, restart: api.restartService }[action]
  await fn(label)
  toast(`${ACTION_LABELS[action]} ${label} 成功`, 'success')
  await loadServices(page)
}

// ===== 备份操作 =====

async function handleCreateBackup(page) {
  const result = await api.createBackup()
  toast(`备份已创建: ${result.name}`, 'success')
  await loadBackups(page)
}

async function handleRestoreBackup(name, page) {
  const yes = await showConfirm(`确定要恢复备份 "${name}" 吗？\n当前配置将自动备份后再恢复。`)
  if (!yes) return
  await api.restoreBackup(name)
  toast('配置已恢复', 'success')
  await loadBackups(page)
}

async function handleDeleteBackup(name, page) {
  const yes = await showConfirm(`确定要删除备份 "${name}" 吗？此操作不可撤销。`)
  if (!yes) return
  await api.deleteBackup(name)
  toast('备份已删除', 'success')
  await loadBackups(page)
}

// ===== 升级操作 =====

async function doUpgradeWithModal(source, page) {
  const modal = showUpgradeModal()
  let unlistenLog, unlistenProgress
  try {
    const { listen } = await import('@tauri-apps/api/event')
    unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
    unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))
    const msg = await api.upgradeOpenclaw(source)
    modal.setDone(msg)
    await loadVersion(page)
  } catch (e) {
    modal.appendLog(String(e))
    modal.setError('升级失败')
  } finally {
    unlistenLog?.()
    unlistenProgress?.()
  }
}

async function handleUpgrade(btn, page) {
  const sourceLabel = detectedSource === 'official' ? '官方原版' : '汉化优化版'
  const yes = await showConfirm(`确定要升级 OpenClaw 到最新${sourceLabel}吗？\n升级过程中 Gateway 会短暂中断。`)
  if (!yes) return
  await doUpgradeWithModal(detectedSource, page)
}

async function handleSwitchSource(target, page) {
  const targetLabel = target === 'official' ? '官方原版' : '汉化优化版'
  const yes = await showConfirm(`确定要切换到${targetLabel}吗？\n这会安装对应的 npm 包，配置数据不受影响。`)
  if (!yes) return
  await doUpgradeWithModal(target, page)
}

// ===== Gateway 安装/卸载 =====

async function handleInstallGateway(btn, page) {
  btn.textContent = '安装中...'
  await api.installGateway()
  toast('Gateway 服务已安装', 'success')
  await loadServices(page)
}

async function handleUninstallGateway(btn, page) {
  const yes = await showConfirm('确定要卸载 Gateway 服务吗？\n这会停止服务并移除 LaunchAgent。')
  if (!yes) return
  btn.textContent = '卸载中...'
  await api.uninstallGateway()
  toast('Gateway 服务已卸载', 'success')
  await loadServices(page)
}

async function handleSaveRegistry(btn, page) {
  const section = page.querySelector('#registry-section')
  const select = section.querySelector('[data-name="registry"]')
  const customInput = section.querySelector('[data-name="custom-registry"]')
  const registry = select.value === 'custom' ? customInput.value.trim() : select.value
  if (!registry) { toast('请输入源地址', 'error'); return }
  await api.setNpmRegistry(registry)
  toast('npm 源已保存', 'success')
}
