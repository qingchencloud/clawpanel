/**
 * 关于页面
 * 版本信息、项目链接、相关项目、系统环境
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showUpgradeModal } from '../components/modal.js'
import { setUpgrading } from '../lib/app-state.js'
import { icon, statusIcon } from '../lib/icons.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header" style="display:flex;align-items:center;gap:16px">
      <img src="/images/logo-brand.png" alt="ClawPanel" style="height:48px;width:auto">
      <div>
        <h1 class="page-title" style="margin:0">ClawPanel</h1>
        <p class="page-desc" style="margin:0">OpenClaw 可视化管理面板 · <a href="https://claw.qt.cool" target="_blank" rel="noopener" style="color:var(--primary)">claw.qt.cool</a></p>
      </div>
    </div>
    <div class="stat-cards" id="version-cards">
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">社群交流</div>
      <div id="community-section"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">相关项目</div>
      <div id="projects-list"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">参与贡献</div>
      <div id="contribute-section"></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">快捷链接</div>
      <div id="links-list"></div>
    </div>
    <div class="config-section" style="color:var(--text-tertiary);font-size:var(--font-size-xs)">
      <p>ClawPanel 基于 Tauri v2 构建，前端 Vanilla JS + Vite，后端 Rust。</p>
      <p style="margin-top:8px">MIT License &copy; 2026 qingchencloud</p>
    </div>
  `

  loadData(page)
  renderCommunity(page)
  renderProjects(page)
  renderContribute(page)
  renderLinks(page)
  return page
}

async function loadData(page) {
  const cards = page.querySelector('#version-cards')
  try {
    const [version, install] = await Promise.all([
      api.getVersionInfo(),
      api.checkInstallation(),
    ])

    // 尝试从 Tauri API 获取 ClawPanel 自身版本号，失败则 fallback
    let panelVersion = '0.1.0'
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      panelVersion = await getVersion()
    } catch {
      // 非 Tauri 环境或 API 不可用，使用 fallback
    }

    // 异步检查 ClawPanel 自身更新
    let panelUpdateHtml = '<span style="color:var(--text-tertiary)">检查更新中...</span>'
    api.checkPanelUpdate().then(info => {
      const panelCard = cards.querySelector('#panel-update-meta')
      if (!panelCard) return
      if (info.latest && info.latest !== panelVersion && compareVersions(info.latest, panelVersion) > 0) {
        panelCard.innerHTML = `<span style="color:var(--accent)">新版本: ${info.latest}</span> <a class="btn btn-primary btn-sm" href="${info.url}" target="_blank" rel="noopener" style="padding:2px 8px;font-size:var(--font-size-xs)">下载更新</a>`
      } else {
        panelCard.innerHTML = '<span style="color:var(--success)">已是最新</span>'
      }
    }).catch((err) => {
      const panelCard = cards.querySelector('#panel-update-meta')
      if (!panelCard) return
      const msg = String(err?.message || err || '')
      if (msg.includes('403') || msg.includes('404') || msg.includes('rate limit')) {
        panelCard.innerHTML = '<span style="color:var(--text-tertiary)">仓库未公开，发布后可自动检测</span>'
      } else {
        panelCard.innerHTML = '<span style="color:var(--text-tertiary)">检查更新失败</span>'
      }
    })

    cards.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">ClawPanel</span></div>
        <div class="stat-card-value">${panelVersion}</div>
        <div class="stat-card-meta" id="panel-update-meta" style="display:flex;align-items:center;gap:8px">${panelUpdateHtml}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">OpenClaw · ${version.source === 'official' ? '官方版' : '汉化版'}</span></div>
        <div class="stat-card-value">${version.current || '未安装'}</div>
        <div class="stat-card-meta" style="display:flex;align-items:center;gap:8px">
          ${version.update_available
            ? `<span style="color:var(--accent)">新版本: ${version.latest}</span><button class="btn btn-primary btn-sm" id="btn-upgrade" style="padding:2px 8px;font-size:var(--font-size-xs)">升级</button>`
            : version.current ? '<span style="color:var(--success)">已是最新</span>' : '<span style="color:var(--error)">未检测到</span>'}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">安装路径</span></div>
        <div class="stat-card-value" style="font-size:var(--font-size-sm);word-break:break-all">${install.path || '未知'}</div>
        <div class="stat-card-meta">${install.installed ? '配置文件存在' : '未找到配置文件'}</div>
      </div>
    `

    // 绑定升级按钮
    const upgradeBtn = cards.querySelector('#btn-upgrade')
    if (upgradeBtn) {
      upgradeBtn.onclick = async () => {
        const modal = showUpgradeModal()
        let unlistenLog, unlistenProgress
        setUpgrading(true)
        try {
          if (window.__TAURI_INTERNALS__) {
            try {
              const { listen } = await import('@tauri-apps/api/event')
              unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
              unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))
            } catch { /* Web 模式无 Tauri event */ }
          } else {
            modal.appendLog('Web 模式：升级过程日志不可用，请等待完成...')
          }
          const msg = await api.upgradeOpenclaw()
          modal.setDone(typeof msg === 'string' ? msg : (msg?.message || '升级完成'))
          loadData(page)
        } catch (e) {
          const errStr = String(e)
          modal.appendLog(errStr)
          const { diagnoseInstallError } = await import('../lib/error-diagnosis.js')
          const fullLog = modal.getLogText() + '\n' + errStr
          const diagnosis = diagnoseInstallError(fullLog)
          modal.setError(diagnosis.title)
          if (diagnosis.hint) modal.appendLog('')
          if (diagnosis.hint) modal.appendHtmlLog(`${statusIcon('info', 14)} ${diagnosis.hint}`)
          if (diagnosis.command) modal.appendHtmlLog(`${icon('clipboard', 14)} ${diagnosis.command}`)
          if (window.__openAIDrawerWithError) {
            window.__openAIDrawerWithError({
              title: diagnosis.title,
              error: fullLog,
              scene: '升级 OpenClaw',
              hint: diagnosis.hint,
            })
          }
        } finally {
          setUpgrading(false)
          unlistenLog?.()
          unlistenProgress?.()
        }
      }
    }
  } catch {
    cards.innerHTML = '<div class="stat-card"><div class="stat-card-label">加载失败</div></div>'
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
        <img src="/images/OpenClaw-QQ.png" alt="QQ 交流群" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary)">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">QQ 交流群</div>
      </div>
      <div style="text-align:center">
        <img src="/images/OpenClawWx.png" alt="微信交流群" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary)">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">微信交流群</div>
      </div>
      <div style="text-align:center">
        <img src="https://qt.cool/c/OpenClawDY/qr.png" alt="抖音交流群" style="width:140px;height:140px;border-radius:var(--radius-md);border:1px solid var(--border-primary);object-fit:contain;background:#fff">
        <div style="font-size:var(--font-size-sm);margin-top:8px;color:var(--text-secondary)">抖音交流群</div>
      </div>
      <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px;padding-top:4px">
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary)">扫码或点击链接加入交流群，反馈问题、获取帮助</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClaw" target="_blank" rel="noopener">加入 QQ 群</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClawWx" target="_blank" rel="noopener">加入微信群</a>
          <a class="btn btn-primary btn-sm" href="https://qt.cool/c/OpenClawDY" target="_blank" rel="noopener">加入抖音群</a>
          <a class="btn btn-secondary btn-sm" href="https://yb.tencent.com/gp/i/LsvIw7mdR7Lb" target="_blank" rel="noopener">元宝派社群</a>
        </div>
        <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:8px">
          2000 人大群，满员自动切换 · 碰到问题可直接在群内反馈
        </div>
      </div>
    </div>
  `
}

const PROJECTS = [
  {
    name: 'OpenClaw',
    desc: 'AI Agent 框架，支持多模型协作、工具调用、记忆管理',
    url: 'https://github.com/openclaw/openclaw',
  },
  {
    name: 'OpenClaw-zh',
    desc: 'AI Agent 框架，支持多模型协作、工具调用、记忆管理-中文优化版',
    url: 'https://github.com/1186258278/OpenClawChineseTranslation',
  },
  {
    name: 'ClawApp',
    desc: '跨平台移动聊天客户端，H5 + 代理服务器架构，支持离线和流式传输',
    url: 'https://github.com/qingchencloud/clawapp',
  },
  {
    name: 'cftunnel',
    desc: '全协议内网穿透工具，Cloud 模式免费 HTTP/WS + Relay 模式自建中继',
    url: 'https://github.com/qingchencloud/cftunnel',
  },
  {
    name: 'ClawPanel',
    desc: 'OpenClaw 可视化管理面板，Tauri v2 桌面应用',
    url: 'https://github.com/qingchencloud/clawpanel',
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
      </div>
    </div>
  `).join('')
}

const LINKS = [
  { label: 'Claw 项目官网', url: 'https://claw.qt.cool', primary: true },
  { label: 'cftunnel 官网', url: 'https://cftunnel.qt.cool' },
  { label: 'cftunnel 桌面客户端', url: 'https://github.com/qingchencloud/cftunnel-app/releases' },
  { label: 'OpenClaw 中文翻译', url: 'https://github.com/1186258278/OpenClawChineseTranslation' },
  { label: 'ClawApp 文档', url: 'https://github.com/qingchencloud/clawapp#readme' },
]

function renderContribute(page) {
  const el = page.querySelector('#contribute-section')
  el.innerHTML = `
    <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:12px">
      ClawPanel 是开源项目，欢迎参与贡献！遇到问题请提 Issue，功能建议和代码改进欢迎提 PR。
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <a class="btn btn-primary btn-sm" href="https://github.com/qingchencloud/clawpanel/issues/new" target="_blank" rel="noopener">提交 Issue</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/pulls" target="_blank" rel="noopener">提交 PR</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">贡献指南</a>
      <a class="btn btn-secondary btn-sm" href="https://github.com/qingchencloud/clawpanel/issues" target="_blank" rel="noopener">查看 Issues</a>
    </div>
  `
}

function renderLinks(page) {
  const el = page.querySelector('#links-list')
  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:var(--space-sm)">
    ${LINKS.map(l => `<a class="btn ${l.primary ? 'btn-primary' : 'btn-secondary'} btn-sm" href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join('')}
  </div>`
}
