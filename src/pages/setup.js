/**
 * 初始设置页面 — openclaw 未安装时的引导
 * 自动检测环境 → 版本选择 → 一键安装 → 自动跳转
 */
import { api } from '../lib/tauri-api.js'
import { showUpgradeModal } from '../components/modal.js'
import { toast } from '../components/toast.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div style="max-width:560px;margin:48px auto;text-align:center">
      <div style="margin-bottom:var(--space-lg)">
        <img src="/images/logo-brand.png" alt="ClawPanel" style="max-width:160px;width:100%;height:auto">
      </div>
      <h1 style="font-size:var(--font-size-xl);margin-bottom:var(--space-xs)">欢迎使用 ClawPanel</h1>
      <p style="color:var(--text-secondary);margin-bottom:var(--space-xl);line-height:1.6">
        OpenClaw AI Agent 框架的桌面管理面板
      </p>

      <div id="setup-steps"></div>

      <div style="margin-top:var(--space-lg)">
        <button class="btn btn-secondary btn-sm" id="btn-recheck" style="min-width:120px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="margin-right:4px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          重新检测
        </button>
      </div>
    </div>
  `

  page.querySelector('#btn-recheck').addEventListener('click', () => runDetect(page))
  runDetect(page)
  return page
}

async function runDetect(page) {
  const stepsEl = page.querySelector('#setup-steps')
  stepsEl.innerHTML = `
    <div class="stat-card loading-placeholder" style="height:48px"></div>
    <div class="stat-card loading-placeholder" style="height:48px;margin-top:8px"></div>
    <div class="stat-card loading-placeholder" style="height:48px;margin-top:8px"></div>
  `
  // 并行检测 Node.js、OpenClaw CLI、配置文件
  const [nodeRes, clawRes, configRes] = await Promise.allSettled([
    api.checkNode(),
    api.getServicesStatus(),
    api.checkInstallation(),
  ])

  const node = nodeRes.status === 'fulfilled' ? nodeRes.value : { installed: false }
  const cliOk = clawRes.status === 'fulfilled'
    && clawRes.value?.length > 0
    && clawRes.value[0]?.cli_installed !== false
  const config = configRes.status === 'fulfilled' ? configRes.value : { installed: false }

  renderSteps(page, { node, cliOk, config })
}

function stepIcon(ok) {
  const color = ok ? 'var(--success)' : 'var(--text-tertiary)'
  return `<span style="color:${color};font-weight:700;width:18px;display:inline-block">${ok ? '✓' : '✗'}</span>`
}

function renderSteps(page, { node, cliOk, config }) {
  const stepsEl = page.querySelector('#setup-steps')
  const nodeOk = node.installed
  const allOk = nodeOk && cliOk && config.installed

  let html = ''

  // 第一步：Node.js
  html += `
    <div class="config-section" style="text-align:left">
      <div class="config-section-title" style="display:flex;align-items:center;gap:4px">
        ${stepIcon(nodeOk)} Node.js 环境
      </div>
      ${nodeOk
        ? `<p style="color:var(--success);font-size:var(--font-size-sm)">已安装 ${node.version || ''}</p>`
        : `<p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:var(--space-sm)">
            OpenClaw 基于 Node.js 运行，请先安装。
          </p>
          <a class="btn btn-primary btn-sm" href="https://nodejs.org/" target="_blank" rel="noopener">下载 Node.js</a>
          <span class="form-hint" style="margin-left:8px">安装后点击「重新检测」</span>`
      }
    </div>
  `

  // 第二步：OpenClaw CLI
  html += `
    <div class="config-section" style="text-align:left;${nodeOk ? '' : 'opacity:0.4;pointer-events:none'}">
      <div class="config-section-title" style="display:flex;align-items:center;gap:4px">
        ${stepIcon(cliOk)} OpenClaw CLI
      </div>
      ${cliOk
        ? `<p style="color:var(--success);font-size:var(--font-size-sm)">CLI 可用</p>`
        : renderInstallSection()
      }
    </div>
  `
  // 第三步：配置文件
  html += `
    <div class="config-section" style="text-align:left;${cliOk ? '' : 'opacity:0.4;pointer-events:none'}">
      <div class="config-section-title" style="display:flex;align-items:center;gap:4px">
        ${stepIcon(config.installed)} 配置文件
      </div>
      ${config.installed
        ? `<p style="color:var(--success);font-size:var(--font-size-sm)">配置文件位于 ${config.path || ''}</p>`
        : `<p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:var(--space-sm)">
            安装 CLI 后会自动生成配置，也可手动执行 <code>openclaw configure</code>
          </p>`
      }
    </div>
  `

  // 全部就绪 → 进入面板
  if (allOk) {
    html += `
      <div style="margin-top:var(--space-lg)">
        <button class="btn btn-primary" id="btn-enter" style="min-width:200px">进入面板</button>
      </div>
    `
  }

  stepsEl.innerHTML = html
  bindEvents(page, nodeOk)
}

function renderInstallSection() {
  return `
    <p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:var(--space-sm)">
      选择版本后点击安装，将自动执行 npm 全局安装。
    </p>
    <div style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-sm)">
      <label class="setup-source-option" style="flex:1;cursor:pointer">
        <input type="radio" name="install-source" value="chinese" checked style="margin-right:6px">
        <div>
          <div style="font-weight:600;font-size:var(--font-size-sm)">汉化优化版（推荐）</div>
          <div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">@qingchencloud/openclaw-zh</div>
        </div>
      </label>
      <label class="setup-source-option" style="flex:1;cursor:pointer">
        <input type="radio" name="install-source" value="official" style="margin-right:6px">
        <div>
          <div style="font-weight:600;font-size:var(--font-size-sm)">官方原版</div>
          <div style="font-size:var(--font-size-xs);color:var(--text-tertiary)">openclaw</div>
        </div>
      </label>
    </div>
    <div style="margin-bottom:var(--space-sm)">
      <label style="font-size:var(--font-size-xs);color:var(--text-tertiary);display:block;margin-bottom:4px">npm 镜像源</label>
      <select id="registry-select" style="width:100%;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--border-primary);background:var(--bg-secondary);color:var(--text-primary);font-size:var(--font-size-sm)">
        <option value="https://registry.npmmirror.com">淘宝镜像（推荐国内用户）</option>
        <option value="https://registry.npmjs.org">npm 官方源</option>
        <option value="https://repo.huaweicloud.com/repository/npm/">华为云镜像</option>
      </select>
    </div>
    <button class="btn btn-primary btn-sm" id="btn-install">一键安装</button>
  `
}

function bindEvents(page, nodeOk) {
  // 进入面板
  page.querySelector('#btn-enter')?.addEventListener('click', () => {
    window.location.hash = '/dashboard'
  })

  // 一键安装
  const installBtn = page.querySelector('#btn-install')
  if (!installBtn || !nodeOk) return

  installBtn.addEventListener('click', async () => {
    const source = page.querySelector('input[name="install-source"]:checked')?.value || 'chinese'
    const registry = page.querySelector('#registry-select')?.value
    const modal = showUpgradeModal()
    let unlistenLog, unlistenProgress

    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
      unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))

      // 先设置镜像源
      if (registry) {
        modal.appendLog(`设置 npm 镜像源: ${registry}`)
        try { await api.setNpmRegistry(registry) } catch {}
      }

      const msg = await api.upgradeOpenclaw(source)
      modal.setDone(msg)

      // 安装成功后自动安装 Gateway
      modal.appendLog('正在安装 Gateway 服务...')
      try {
        await api.installGateway()
        modal.appendLog('✅ Gateway 服务已安装')
      } catch (e) {
        modal.appendLog('⚠️ Gateway 安装失败: ' + e)
      }

      toast('OpenClaw 安装成功', 'success')
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) {
      modal.appendLog(String(e))
      modal.setError('安装失败')
    } finally {
      unlistenLog?.()
      unlistenProgress?.()
    }
  })
}


