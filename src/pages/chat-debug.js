/**
 * 系统诊断页面
 * 全面检测 ClawPanel 各项功能状态，快速定位问题
 */
import { api, getRequestLogs, clearRequestLogs } from '../lib/tauri-api.js'
import { wsClient } from '../lib/ws-client.js'
import { isOpenclawReady, isGatewayRunning } from '../lib/app-state.js'
import { icon, statusIcon } from '../lib/icons.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">系统诊断</h1>
      <p class="page-desc">全面检测系统状态，快速定位问题</p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-refresh">刷新状态</button>
        <button class="btn btn-secondary btn-sm" id="btn-test-ws">测试 WebSocket</button>
        <button class="btn btn-secondary btn-sm" id="btn-network-log">网络日志</button>
        <button class="btn btn-warning btn-sm" id="btn-fix-pairing">一键修复配对</button>
      </div>
    </div>
    <div id="debug-content"></div>
    <div id="ws-test-log" style="display:none;margin-top:16px;background:var(--bg-secondary);border-radius:6px;padding:12px">
      <div style="font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <span>WebSocket 连接测试</span>
        <button class="btn btn-sm" id="btn-clear-log" style="padding:4px 8px;font-size:11px">清空</button>
      </div>
      <pre id="ws-log-content" style="font-size:11px;line-height:1.5;max-height:400px;overflow:auto;margin:0;color:var(--text-primary)"></pre>
    </div>
    <div id="network-log" style="display:none;margin-top:16px;background:var(--bg-secondary);border-radius:6px;padding:12px">
      <div style="font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <span>网络请求日志（最近 100 条）</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" id="btn-refresh-network" style="padding:4px 8px;font-size:11px">刷新</button>
          <button class="btn btn-sm" id="btn-clear-network" style="padding:4px 8px;font-size:11px">清空</button>
        </div>
      </div>
      <div id="network-log-content" style="font-size:11px;line-height:1.5;max-height:400px;overflow:auto"></div>
    </div>
  `

  page.querySelector('#btn-refresh').addEventListener('click', () => loadDebugInfo(page))
  page.querySelector('#btn-test-ws').addEventListener('click', () => testWebSocket(page))
  page.querySelector('#btn-network-log').addEventListener('click', () => toggleNetworkLog(page))
  page.querySelector('#btn-fix-pairing').addEventListener('click', () => fixPairing(page))
  loadDebugInfo(page)
  return page
}

async function loadDebugInfo(page) {
  const el = page.querySelector('#debug-content')

  const info = {
    timestamp: new Date().toLocaleString('zh-CN'),
    // 应用状态
    appState: {
      openclawReady: isOpenclawReady(),
      gatewayRunning: isGatewayRunning(),
    },
    // WebSocket 状态
    wsClient: {
      connected: wsClient.connected,
      gatewayReady: wsClient.gatewayReady,
      sessionKey: wsClient.sessionKey,
    },
    // 配置文件
    config: null,
    configError: null,
    // 服务状态
    services: null,
    servicesError: null,
    // 版本信息
    version: null,
    versionError: null,
    // Node.js 环境
    node: null,
    nodeError: null,
    // 设备密钥
    connectFrame: null,
    connectFrameError: null,
  }

  // 并行检测所有项目
  await Promise.allSettled([
    // 配置文件
    api.readOpenclawConfig().then(r => { info.config = r }).catch(e => { info.configError = String(e) }),
    // 服务状态
    api.getServicesStatus().then(r => { info.services = r }).catch(e => { info.servicesError = String(e) }),
    // 版本信息
    api.getVersionInfo().then(r => { info.version = r }).catch(e => { info.versionError = String(e) }),
    // Node.js
    api.checkNode().then(r => { info.node = r }).catch(e => { info.nodeError = String(e) }),
  ])

  // 设备密钥检测（需要等配置加载完成）
  try {
    const token = info.config?.gateway?.auth?.token || ''
    info.connectFrame = await api.createConnectFrame('test-nonce', token)
  } catch (e) {
    info.connectFrameError = String(e)
  }

  // 移除 loading 状态并渲染结果
  renderDebugInfo(el, info)
}

function renderDebugInfo(el, info) {
  let html = `<div style="font-family:monospace;font-size:12px;line-height:1.6">`

  // 总体状态概览
  const allOk = info.appState.openclawReady && info.appState.gatewayRunning && info.wsClient.gatewayReady
  html += `<div class="config-section" style="background:${allOk ? 'var(--success-bg)' : 'var(--warning-bg)'};border-left:3px solid ${allOk ? 'var(--success)' : 'var(--warning)'}">
    <div style="font-size:16px;font-weight:600;margin-bottom:8px">${allOk ? `${statusIcon('ok')} 系统正常` : `${statusIcon('warn')} 发现问题`}</div>
    <div style="color:var(--text-secondary);font-size:13px">${allOk ? '所有核心功能运行正常' : '部分功能异常，请查看下方详情'}</div>
  </div>`

  // 应用状态
  html += `<div class="config-section">
    <div class="config-section-title">应用状态</div>
    <table class="debug-table">
      <tr><td>OpenClaw 就绪</td><td>${info.appState.openclawReady ? statusIcon('ok') : statusIcon('err')}</td></tr>
      <tr><td>Gateway 运行中</td><td>${info.appState.gatewayRunning ? statusIcon('ok') : statusIcon('err')}</td></tr>
    </table>
  </div>`

  // WebSocket 状态
  html += `<div class="config-section">
    <div class="config-section-title">WebSocket 连接</div>
    <table class="debug-table">
      <tr><td>连接状态</td><td>${info.wsClient.connected ? `${statusIcon('ok')} 已连接` : `${statusIcon('err')} 未连接`}</td></tr>
      <tr><td>握手状态</td><td>${info.wsClient.gatewayReady ? `${statusIcon('ok')} 已完成` : `${statusIcon('err')} 未完成`}</td></tr>
      <tr><td>会话密钥</td><td>${info.wsClient.sessionKey || '(空)'}</td></tr>
    </table>
  </div>`

  // Node.js 环境
  html += `<div class="config-section">
    <div class="config-section-title">Node.js 环境</div>`
  if (info.nodeError) {
    html += `<div style="color:var(--error)">${statusIcon('err')} ${escapeHtml(info.nodeError)}</div>`
  } else if (info.node) {
    html += `<table class="debug-table">
      <tr><td>安装状态</td><td>${info.node.installed ? `${statusIcon('ok')} 已安装` : `${statusIcon('err')} 未安装`}</td></tr>
      <tr><td>版本</td><td>${info.node.version || '(未知)'}</td></tr>
    </table>`
  }
  html += `</div>`

  // 版本信息
  html += `<div class="config-section">
    <div class="config-section-title">版本信息</div>`
  if (info.versionError) {
    html += `<div style="color:var(--error)">${statusIcon('err')} ${escapeHtml(info.versionError)}</div>`
  } else if (info.version) {
    html += `<table class="debug-table">
      <tr><td>当前版本</td><td>${info.version.current || '(未知)'}</td></tr>
      <tr><td>最新版本</td><td>${info.version.latest || '(未检测)'}</td></tr>
      <tr><td>更新可用</td><td>${info.version.update_available ? `${statusIcon('warn')} 有新版本` : `${statusIcon('ok')} 已是最新`}</td></tr>
    </table>`
  }
  html += `</div>`

  // 配置文件
  html += `<div class="config-section">
    <div class="config-section-title">配置文件</div>`
  if (info.configError) {
    html += `<div style="color:var(--error)">${statusIcon('err')} ${escapeHtml(info.configError)}</div>`
  } else if (info.config) {
    const gw = info.config.gateway || {}
    html += `<table class="debug-table">
      <tr><td>gateway.port</td><td>${gw.port || '(未设置)'}</td></tr>
      <tr><td>gateway.auth.token</td><td>${gw.auth?.token ? `${statusIcon('ok')} 已设置` : `${statusIcon('warn')} 未设置`}</td></tr>
      <tr><td>gateway.enabled</td><td>${gw.enabled !== false ? statusIcon('ok') : statusIcon('err')}</td></tr>
      <tr><td>gateway.mode</td><td>${gw.mode || 'local'}</td></tr>
    </table>`
  }
  html += `</div>`

  // 服务状态
  html += `<div class="config-section">
    <div class="config-section-title">服务状态</div>`
  if (info.servicesError) {
    html += `<div style="color:var(--error)">${statusIcon('err')} ${escapeHtml(info.servicesError)}</div>`
  } else if (info.services?.length > 0) {
    const svc = info.services[0]
    html += `<table class="debug-table">
      <tr><td>CLI 安装</td><td>${svc.cli_installed !== false ? `${statusIcon('ok')} 已安装` : `${statusIcon('err')} 未安装`}</td></tr>
      <tr><td>运行状态</td><td>${svc.running ? `${statusIcon('ok')} 运行中` : `${statusIcon('err')} 已停止`}</td></tr>
      <tr><td>进程 PID</td><td>${svc.pid || '(无)'}</td></tr>
      <tr><td>服务标签</td><td>${svc.label || '(未知)'}</td></tr>
    </table>`
  }
  html += `</div>`

  // 设备密钥
  html += `<div class="config-section">
    <div class="config-section-title">设备密钥 & 握手签名</div>`
  if (info.connectFrameError) {
    html += `<div style="color:var(--error)">${statusIcon('err')} ${escapeHtml(info.connectFrameError)}</div>`
  } else if (info.connectFrame) {
    const device = info.connectFrame.params?.device
    html += `<div style="color:var(--success);margin-bottom:8px">${statusIcon('ok')} 设备密钥生成成功</div>
    <table class="debug-table">
      <tr><td>设备 ID</td><td style="font-size:10px;word-break:break-all">${device?.id || '(无)'}</td></tr>
      <tr><td>公钥</td><td style="font-size:10px;word-break:break-all">${device?.publicKey ? device.publicKey.substring(0, 32) + '...' : '(无)'}</td></tr>
      <tr><td>签名时间</td><td>${device?.signedAt || '(无)'}</td></tr>
    </table>
    <details style="margin-top:8px">
      <summary style="cursor:pointer;color:var(--text-secondary);font-size:12px">查看完整 Connect Frame</summary>
      <pre style="background:var(--bg-secondary);padding:8px;border-radius:4px;overflow:auto;max-height:300px;font-size:11px">${escapeHtml(JSON.stringify(info.connectFrame, null, 2))}</pre>
    </details>`
  }
  html += `</div>`

  // 诊断建议
  html += `<div class="config-section">
    <div class="config-section-title">诊断建议</div>
    <ul style="margin:0;padding-left:20px;color:var(--text-secondary);font-size:13px">`

  if (!info.node?.installed) {
    html += `<li style="color:var(--error);margin-bottom:6px">${statusIcon('err')} Node.js 未安装，请先安装 Node.js（<a href="https://nodejs.org/" target="_blank" rel="noopener">下载地址</a>）</li>`
  }
  if (info.configError) {
    html += `<li style="color:var(--error);margin-bottom:6px">${statusIcon('err')} 配置文件不存在或损坏，请前往"初始设置"页面完成配置</li>`
  }
  if (info.servicesError || !info.services?.length || info.services[0]?.cli_installed === false) {
    html += `<li style="color:var(--error);margin-bottom:6px">${statusIcon('err')} OpenClaw CLI 未安装，请前往"初始设置"页面安装</li>`
  }
  if (info.services?.length > 0 && !info.services[0]?.running) {
    html += `<li style="color:var(--warning);margin-bottom:6px">${statusIcon('warn')} Gateway 未启动，请前往"服务管理"页面启动服务</li>`
  }
  if (info.config && !info.config.gateway?.auth?.token) {
    html += `<li style="color:var(--warning);margin-bottom:6px">${statusIcon('warn')} Gateway token 未设置（本地开发可选，生产环境建议设置）</li>`
  }
  if (info.connectFrameError) {
    html += `<li style="color:var(--error);margin-bottom:6px">${statusIcon('err')} 设备密钥生成失败，请检查 Rust 后端日志</li>`
  }
  if (!info.wsClient.connected && info.services?.length > 0 && info.services[0]?.running) {
    html += `<li style="color:var(--warning);margin-bottom:6px">${statusIcon('warn')} Gateway 运行中但 WebSocket 未连接，常见原因：<strong>origin not allowed</strong>（Tauri origin 未在白名单）或端口 ${info.config?.gateway?.port || 18789} 被占用。点击“一键修复配对”可自动修复 origin 问题</li>`
  }
  if (info.wsClient.connected && !info.wsClient.gatewayReady) {
    html += `<li style="color:var(--warning);margin-bottom:6px">${statusIcon('warn')} WebSocket 已连接但握手未完成，请检查 token 是否正确</li>`
  }
  if (allOk) {
    html += `<li style="color:var(--success);margin-bottom:6px">${statusIcon('ok')} 所有检测项正常，系统运行良好</li>`
  }

  html += `</ul></div>`
  html += `<div style="margin-top:16px;padding:8px;background:var(--bg-secondary);border-radius:4px;font-size:11px;color:var(--text-tertiary)">检测时间: ${info.timestamp}</div>`
  html += `</div>`

  el.innerHTML = html
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// WebSocket 连接测试
let testWs = null
let testLogs = []

function testWebSocket(page) {
  const logEl = page.querySelector('#ws-test-log')
  const contentEl = page.querySelector('#ws-log-content')
  const clearBtn = page.querySelector('#btn-clear-log')

  logEl.style.display = 'block'
  testLogs = []

  clearBtn.onclick = () => {
    testLogs = []
    contentEl.innerHTML = ''
  }

  addLog(`${icon('search', 14)} 开始 WebSocket 连接测试...`)

  // 关闭旧连接
  if (testWs) {
    testWs.close()
    testWs = null
  }

  // 读取配置
  api.readOpenclawConfig().then(config => {
    const port = config?.gateway?.port || 18789
    const token = config?.gateway?.auth?.token || ''
    const wsHost = window.__TAURI_INTERNALS__ ? `127.0.0.1:${port}` : location.host
    const url = `ws://${wsHost}/ws?token=${encodeURIComponent(token)}`

    addLog(`${icon('radio', 14)} 连接地址: ${url}`)
    addLog(`${icon('key', 14)} Token: ${token ? token.substring(0, 20) + '...' : '(空)'}`)
    addLog(`${icon('clock', 14)} 正在连接...`)

    try {
      testWs = new WebSocket(url)

      testWs.onopen = () => {
        addLog(`${statusIcon('ok', 14)} WebSocket 连接成功`)
        addLog(`${icon('clock', 14)} 等待 Gateway 发送 connect.challenge...`)
      }

      testWs.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          addLog(`${icon('inbox', 14)} 收到消息: ${escapeHtml(JSON.stringify(msg, null, 2))}`)

          // 如果收到 challenge，尝试发送 connect frame
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce || ''
            addLog(`${icon('lock', 14)} 收到 challenge, nonce: ${nonce}`)
            addLog(`${icon('clock', 14)} 生成 connect frame...`)

            api.createConnectFrame(nonce, token).then(frame => {
              addLog(`${statusIcon('ok', 14)} Connect frame 生成成功`)
              addLog(`${icon('send', 14)} 发送 connect frame: ${escapeHtml(JSON.stringify(frame, null, 2))}`)
              testWs.send(JSON.stringify(frame))
            }).catch(e => {
              addLog(`${statusIcon('err', 14)} 生成 connect frame 失败: ${e}`)
            })
          }

          // 如果收到 connect 响应
          if (msg.type === 'res' && msg.id?.startsWith('connect-')) {
            if (msg.ok) {
              addLog(`${statusIcon('ok', 14)} 握手成功！`)
              addLog(`${icon('bar-chart', 14)} Snapshot: ${escapeHtml(JSON.stringify(msg.payload, null, 2))}`)
              const sessionKey = msg.payload?.snapshot?.sessionDefaults?.mainSessionKey
              if (sessionKey) {
                addLog(`${icon('key', 14)} Session Key: ${sessionKey}`)
              }
            } else {
              addLog(`${statusIcon('err', 14)} 握手失败: ${msg.error?.message || msg.error?.code || '未知错误'}`)
            }
          }
        } catch (e) {
          addLog(`${statusIcon('warn', 14)} 解析消息失败: ${e}`)
          addLog(`${icon('inbox', 14)} 原始数据: ${escapeHtml(evt.data)}`)
        }
      }

      testWs.onerror = (e) => {
        addLog(`${statusIcon('err', 14)} WebSocket 错误: ${e.type}`)
      }

      testWs.onclose = (e) => {
        addLog(`${icon('plug', 14)} 连接关闭 - Code: ${e.code}, Reason: ${e.reason || '(空)'}`)
        if (e.code === 1008) {
          addLog(`${statusIcon('err', 14)} origin not allowed (1008) - Gateway 拒绝了当前应用的 origin`)
          addLog(`${icon('lightbulb', 14)} 解决方法：点击“一键修复配对”，将自动将 tauri://localhost 加入白名单并重启 Gateway`)
        } else if (e.code === 4001) {
          addLog(`${statusIcon('err', 14)} 认证失败 (4001) - Token 可能不正确`)
        } else if (e.code === 1006) {
          addLog(`${statusIcon('warn', 14)} 异常关闭 (1006) - 可能是网络问题或 Gateway 主动断开`)
        }
        testWs = null
      }

    } catch (e) {
      addLog(`${statusIcon('err', 14)} 创建 WebSocket 失败: ${e}`)
    }
  }).catch(e => {
    addLog(`${statusIcon('err', 14)} 读取配置失败: ${e}`)
  })

  function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const div = document.createElement('div')
    div.style.cssText = 'display:flex;gap:4px;align-items:flex-start;padding:1px 0;white-space:pre-wrap;word-break:break-all'
    div.innerHTML = `<span style="color:var(--text-tertiary);flex-shrink:0">[${timestamp}]</span> ${msg}`
    testLogs.push(div.textContent)
    contentEl.appendChild(div)
    contentEl.scrollTop = contentEl.scrollHeight
  }
}

// 网络日志功能
function toggleNetworkLog(page) {
  const logEl = page.querySelector('#network-log')
  const contentEl = page.querySelector('#network-log-content')
  const refreshBtn = page.querySelector('#btn-refresh-network')
  const clearBtn = page.querySelector('#btn-clear-network')

  if (logEl.style.display === 'none') {
    logEl.style.display = 'block'
    renderNetworkLog(contentEl)
  } else {
    logEl.style.display = 'none'
  }

  refreshBtn.onclick = () => renderNetworkLog(contentEl)
  clearBtn.onclick = () => {
    clearRequestLogs()
    renderNetworkLog(contentEl)
  }
}

function renderNetworkLog(contentEl) {
  const logs = getRequestLogs()

  if (logs.length === 0) {
    contentEl.innerHTML = '<div style="color:var(--text-secondary);padding:8px">暂无请求记录</div>'
    return
  }

  // 统计信息
  const total = logs.length
  const cached = logs.filter(l => l.cached).length
  const avgDuration = logs.filter(l => !l.cached).reduce((sum, l) => {
    const ms = parseInt(l.duration)
    return sum + (isNaN(ms) ? 0 : ms)
  }, 0) / (total - cached || 1)

  let html = `
    <div style="padding:8px;background:var(--bg-primary);border-radius:4px;margin-bottom:8px;font-size:12px">
      <div style="display:flex;gap:16px">
        <span>总请求: <strong>${total}</strong></span>
        <span>缓存命中: <strong>${cached}</strong></span>
        <span>平均耗时: <strong>${avgDuration.toFixed(0)}ms</strong></span>
      </div>
    </div>
    <table class="debug-table" style="width:100%;font-size:11px">
      <thead>
        <tr style="background:var(--bg-primary)">
          <th style="padding:6px;text-align:left;width:80px">时间</th>
          <th style="padding:6px;text-align:left">命令</th>
          <th style="padding:6px;text-align:left;max-width:200px">参数</th>
          <th style="padding:6px;text-align:right;width:80px">耗时</th>
          <th style="padding:6px;text-align:center;width:60px">缓存</th>
        </tr>
      </thead>
      <tbody>
  `

  // 倒序显示（最新的在上面）
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]
    const cachedIcon = log.cached ? statusIcon('ok', 12) : '-'
    const durationColor = log.cached ? 'var(--text-tertiary)' :
                          (parseInt(log.duration) > 1000 ? 'var(--error)' :
                          (parseInt(log.duration) > 500 ? 'var(--warning)' : 'var(--text-primary)'))

    html += `
      <tr>
        <td style="padding:4px;color:var(--text-tertiary)">${log.time}</td>
        <td style="padding:4px;font-family:monospace">${escapeHtml(log.cmd)}</td>
        <td style="padding:4px;font-family:monospace;font-size:10px;color:var(--text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(log.args)}">${escapeHtml(log.args)}</td>
        <td style="padding:4px;text-align:right;color:${durationColor}">${log.duration}</td>
        <td style="padding:4px;text-align:center">${cachedIcon}</td>
      </tr>
    `
  }

  html += `</tbody></table>`
  contentEl.innerHTML = html
}

// 一键修复配对问题
async function fixPairing(page) {
  const logEl = page.querySelector('#ws-test-log')
  const contentEl = page.querySelector('#ws-log-content')
  const fixBtn = page.querySelector('#btn-fix-pairing')

  if (fixBtn) { fixBtn.disabled = true; fixBtn.textContent = '修复中...' }
  logEl.style.display = 'block'
  testLogs = []
  logEl.scrollIntoView({ behavior: 'smooth', block: 'start' })

  function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const line = `[${timestamp}] ${msg}`
    testLogs.push(line)
    contentEl.textContent = testLogs.join('\n')
    contentEl.scrollTop = contentEl.scrollHeight
  }

  try {
    addLog(`${icon('wrench', 14)} 开始修复配对问题...`)

    // 1. 写入 paired.json + controlUi.allowedOrigins
    addLog(`${icon('edit', 14)} 正在写入设备配对信息 + Gateway origin 白名单...`)
    const result = await api.autoPairDevice()
    addLog(`${statusIcon('ok', 14)} ${result}`)
    addLog(`${statusIcon('ok', 14)} 已将 tauri://localhost 加入 gateway.controlUi.allowedOrigins`)

    // 2. 重启 Gateway
    addLog(`${icon('zap', 14)} 重启 Gateway 服务...`)
    await api.restartService('ai.openclaw.gateway')
    addLog(`${statusIcon('ok', 14)} Gateway 重启命令已发送`)

    // 3. 等待 Gateway 启动
    addLog(`${icon('clock', 14)} 等待 Gateway 启动（8秒）...`)
    await new Promise(resolve => setTimeout(resolve, 8000))

    // 4. 检查 Gateway 状态
    addLog(`${icon('search', 14)} 检查 Gateway 状态...`)
    const services = await api.getServicesStatus()
    const running = services?.[0]?.running

    if (running) {
      addLog(`${statusIcon('ok', 14)} Gateway 已启动`)
    } else {
      addLog(`${statusIcon('warn', 14)} Gateway 可能还在启动中，请稍后手动测试`)
    }

    // 5. 测试 WebSocket 连接
    addLog(`${icon('plug', 14)} 测试 WebSocket 连接...`)
    const config = await api.readOpenclawConfig()
    const port = config?.gateway?.port || 18789
    const token = config?.gateway?.auth?.token || ''
    const wsHost = window.__TAURI_INTERNALS__ ? `127.0.0.1:${port}` : location.host
    const url = `ws://${wsHost}/ws?token=${encodeURIComponent(token)}`

    const ws = new WebSocket(url)

    ws.onopen = () => {
      addLog(`${statusIcon('ok', 14)} WebSocket 连接成功`)
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          addLog(`${statusIcon('ok', 14)} 收到 connect.challenge`)
          const nonce = msg.payload?.nonce || ''

          api.createConnectFrame(nonce, token).then(frame => {
            ws.send(JSON.stringify(frame))
            addLog(`${icon('send', 14)} 已发送 connect frame`)
          })
        }

        if (msg.type === 'res' && msg.id?.startsWith('connect-')) {
          if (msg.ok) {
            addLog(`${statusIcon('ok', 14)} 握手成功！配对问题已修复！`)
            addLog(`${icon('lightbulb', 14)} 正在重新建立主应用 WebSocket 连接...`)
            ws.close(1000)
            // 触发主应用的 wsClient 重连，让主界面正常工作
            wsClient.reconnect()
            setTimeout(() => loadDebugInfo(page), 2000)
          } else {
            const errMsg = msg.error?.message || msg.error?.code || '未知错误'
            addLog(`${statusIcon('err', 14)} 握手失败: ${errMsg}`)
            if (errMsg.includes('origin not allowed')) {
              addLog(`${icon('lightbulb', 14)} 原因：Gateway 拒绝了当前应用的 origin，需要重启 Gateway 再试`)
            } else {
              addLog(`${icon('lightbulb', 14)} 建议：请手动前往“服务管理”页面重启 Gateway`)
            }
          }
        }
      } catch (e) {
        addLog(`${statusIcon('warn', 14)} 解析消息失败: ${e}`)
      }
    }

    ws.onerror = () => {
      addLog(`${statusIcon('err', 14)} WebSocket 连接失败，请确认 Gateway 已在运行`)
    }

    ws.onclose = (e) => {
      if (e.code === 1008) {
        addLog(`${statusIcon('warn', 14)} 连接被拒绝 (1008) - Gateway 拒绝了当前 origin`)
        addLog(`${icon('lightbulb', 14)} 该问题应已被本次修复流程处理，请再次点击“一键修复配对”`)
      } else if (e.code !== 1000) {
        addLog(`${statusIcon('warn', 14)} 连接关闭 - Code: ${e.code}`)
      }
    }

  } catch (e) {
    addLog(`${statusIcon('err', 14)} 修复失败: ${e}`)
    addLog(`${icon('lightbulb', 14)} 建议：请手动前往"服务管理"页面重启 Gateway`)
  } finally {
    if (fixBtn) { fixBtn.disabled = false; fixBtn.textContent = '一键修复配对' }
  }
}

