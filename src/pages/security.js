/**
 * 安全设置页面 — 访问密码管理 & 无视风险模式
 * 支持 Web 部署模式和 Tauri 桌面端
 */
import { toast } from '../components/toast.js'
import { statusIcon } from '../lib/icons.js'

const isTauri = !!window.__TAURI_INTERNALS__
let _tauriApi = null

async function getTauriApi() {
  if (!_tauriApi) _tauriApi = (await import('../lib/tauri-api.js')).api
  return _tauriApi
}

async function apiCall(cmd, args = {}) {
  if (isTauri) {
    // 桌面端：通过 Tauri IPC 读写 clawpanel.json
    const api = await getTauriApi()
    const cfg = await api.readPanelConfig()

    if (cmd === 'auth_status') {
      const isDefault = cfg.accessPassword === '123456'
      const result = { hasPassword: !!cfg.accessPassword, mustChangePassword: isDefault, ignoreRisk: !!cfg.ignoreRisk }
      if (isDefault) result.defaultPassword = '123456'
      return result
    }
    if (cmd === 'auth_change_password') {
      if (cfg.accessPassword && args.oldPassword !== cfg.accessPassword) throw new Error('当前密码错误')
      const weakErr = checkPasswordStrengthLocal(args.newPassword)
      if (weakErr) throw new Error(weakErr)
      if (args.newPassword === cfg.accessPassword) throw new Error('新密码不能与旧密码相同')
      cfg.accessPassword = args.newPassword
      delete cfg.mustChangePassword
      delete cfg.ignoreRisk
      await api.writePanelConfig(cfg)
      sessionStorage.setItem('clawpanel_authed', '1')
      return { success: true }
    }
    if (cmd === 'auth_ignore_risk') {
      if (args.enable) {
        delete cfg.accessPassword
        delete cfg.mustChangePassword
        cfg.ignoreRisk = true
        sessionStorage.removeItem('clawpanel_authed')
      } else {
        delete cfg.ignoreRisk
      }
      await api.writePanelConfig(cfg)
      return { success: true }
    }
    throw new Error('未知命令: ' + cmd)
  }
  // Web 模式
  const resp = await fetch(`/__api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

function checkPasswordStrengthLocal(pw) {
  if (!pw || pw.length < 6) return '密码至少 6 位'
  if (pw.length > 64) return '密码不能超过 64 位'
  if (/^\d+$/.test(pw)) return '密码不能是纯数字'
  const weak = ['123456', '654321', 'password', 'admin', 'qwerty', 'abc123', '111111', '000000', 'letmein', 'welcome', 'clawpanel', 'openclaw']
  if (weak.includes(pw.toLowerCase())) return '密码太常见，请换一个更安全的密码'
  return null
}

function strengthLevel(pw) {
  if (!pw) return { level: 0, text: '', color: '' }
  if (pw.length < 6) return { level: 1, text: '太短', color: 'var(--error)' }
  if (/^\d+$/.test(pw)) return { level: 1, text: '纯数字太弱', color: 'var(--error)' }
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^a-zA-Z0-9]/.test(pw)) score++
  if (score <= 1) return { level: 2, text: '一般', color: 'var(--warning)' }
  if (score <= 3) return { level: 3, text: '良好', color: 'var(--primary)' }
  return { level: 4, text: '强', color: 'var(--success)' }
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header"><h1>安全设置</h1></div>
    <div id="security-content">
      <div class="config-section loading-placeholder" style="height:120px"></div>
    </div>
  `

  loadStatus(page)
  return page
}

async function loadStatus(page) {
  const container = page.querySelector('#security-content')
  try {
    const status = await apiCall('auth_status')
    renderContent(container, status)
  } catch (e) {
    container.innerHTML = `<div class="config-section"><p style="color:var(--error)">加载失败: ${e.message}</p></div>`
  }
}

function renderContent(container, status) {
  let html = ''

  // 当前状态
  const stateIcon = status.hasPassword ? statusIcon('ok', 20) : statusIcon('warn', 20)
  const stateText = status.hasPassword
    ? (status.mustChangePassword ? '使用默认密码（需修改）' : '已设置自定义密码')
    : (status.ignoreRisk ? '无视风险模式（无密码）' : '未设置密码')
  const stateColor = status.hasPassword && !status.mustChangePassword ? 'var(--success)' : 'var(--warning)'

  html += `
    <div class="config-section">
      <div class="config-section-title">访问密码状态</div>
      <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--bg-tertiary);border-radius:var(--radius-sm);border-left:3px solid ${stateColor}">
        <span style="font-size:20px">${stateIcon}</span>
        <div>
          <div style="font-weight:600;color:var(--text-primary)">${stateText}</div>
          <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:2px">
            ${status.hasPassword
              ? (isTauri ? '每次打开应用需输入密码' : '远程访问需输入密码才能进入面板')
              : (isTauri ? '任何人打开应用即可使用' : '任何人都可以直接访问面板')}
          </div>
        </div>
      </div>
    </div>
  `

  // 修改密码区域
  html += `
    <div class="config-section">
      <div class="config-section-title">${status.hasPassword ? '修改密码' : '设置密码'}</div>
      <form id="form-change-pw" style="max-width:400px">
        ${status.hasPassword ? `
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:4px">当前密码</label>
            <input type="password" id="sec-old-pw" class="form-input" placeholder="输入当前密码" autocomplete="current-password" style="width:100%"
              ${status.defaultPassword ? `value="${status.defaultPassword}"` : ''}>
            ${status.defaultPassword ? '<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">已自动填充默认密码，直接设置新密码即可</div>' : ''}
          </div>
        ` : ''}
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:4px">新密码</label>
          <input type="password" id="sec-new-pw" class="form-input" placeholder="至少 6 位，不能纯数字" autocomplete="new-password" style="width:100%">
          <div id="pw-strength" style="margin-top:6px;display:flex;align-items:center;gap:8px;min-height:20px"></div>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:var(--font-size-xs);color:var(--text-tertiary);margin-bottom:4px">确认新密码</label>
          <input type="password" id="sec-confirm-pw" class="form-input" placeholder="再次输入新密码" autocomplete="new-password" style="width:100%">
        </div>
        <button type="submit" class="btn btn-primary btn-sm">${status.hasPassword ? '确认修改' : '设置密码'}</button>
        <span id="change-pw-msg" style="margin-left:12px;font-size:var(--font-size-xs)"></span>
      </form>
    </div>
  `

  // 无视风险模式
  html += `
    <div class="config-section">
      <div class="config-section-title" style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        无视风险模式
      </div>
      <div style="padding:12px 16px;background:${status.ignoreRisk ? 'rgba(239,68,68,0.08)' : 'var(--bg-tertiary)'};border-radius:var(--radius-sm);border:1px solid ${status.ignoreRisk ? 'rgba(239,68,68,0.2)' : 'var(--border-primary)'}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:500;color:var(--text-primary)">关闭密码保护</div>
            <div style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-top:4px;line-height:1.5">
              开启后任何人都可以直接访问面板，无需输入密码。<br>
              <strong style="color:var(--error)">仅建议在受信任的内网环境中使用。</strong>
            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-ignore-risk" ${status.ignoreRisk ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div id="ignore-risk-confirm" style="display:none;margin-top:12px;padding:12px 16px;background:rgba(239,68,68,0.06);border-radius:var(--radius-sm);border:1px solid rgba(239,68,68,0.15)">
        <p style="font-size:var(--font-size-sm);color:var(--error);font-weight:600;margin-bottom:8px">确认关闭密码保护？</p>
        <p style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-bottom:12px;line-height:1.5">
          关闭后，<strong>任何能访问此服务器 IP 和端口的人</strong>都可以直接进入管理面板，查看和修改你的 AI 配置。
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" id="btn-confirm-ignore" style="background:var(--error);color:#fff;border:none">我了解风险，确认关闭</button>
          <button class="btn btn-secondary btn-sm" id="btn-cancel-ignore">取消</button>
        </div>
      </div>
    </div>
  `

  container.innerHTML = html
  bindSecurityEvents(container, status)
}

function bindSecurityEvents(container, status) {
  // 密码强度实时显示
  const newPwInput = container.querySelector('#sec-new-pw')
  const strengthEl = container.querySelector('#pw-strength')
  if (newPwInput && strengthEl) {
    newPwInput.addEventListener('input', () => {
      const s = strengthLevel(newPwInput.value)
      if (!newPwInput.value) { strengthEl.innerHTML = ''; return }
      const bars = [1,2,3,4].map(i =>
        `<div style="width:32px;height:4px;border-radius:2px;background:${i <= s.level ? s.color : 'var(--border-primary)'}"></div>`
      ).join('')
      strengthEl.innerHTML = `${bars}<span style="font-size:11px;color:${s.color};font-weight:500">${s.text}</span>`
    })
  }

  // 修改密码表单
  const form = container.querySelector('#form-change-pw')
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const oldPw = container.querySelector('#sec-old-pw')?.value || ''
      const newPw = container.querySelector('#sec-new-pw')?.value || ''
      const confirmPw = container.querySelector('#sec-confirm-pw')?.value || ''
      const msgEl = container.querySelector('#change-pw-msg')
      const btn = form.querySelector('button[type="submit"]')

      if (newPw !== confirmPw) { msgEl.textContent = '两次输入的密码不一致'; msgEl.style.color = 'var(--error)'; return }

      btn.disabled = true
      btn.textContent = '提交中...'
      msgEl.textContent = ''
      try {
        await apiCall('auth_change_password', { oldPassword: oldPw, newPassword: newPw })
        msgEl.textContent = '密码修改成功'
        msgEl.style.color = 'var(--success)'
        toast('密码已更新', 'success')
        // 清除默认密码横幅
        sessionStorage.removeItem('clawpanel_must_change_pw')
        const banner = document.getElementById('pw-change-banner')
        if (banner) banner.remove()
        setTimeout(() => loadStatus(container.closest('.page')), 1000)
      } catch (err) {
        msgEl.textContent = err.message
        msgEl.style.color = 'var(--error)'
        btn.disabled = false
        btn.textContent = status.hasPassword ? '确认修改' : '设置密码'
      }
    })
  }

  // 无视风险模式开关
  const toggle = container.querySelector('#toggle-ignore-risk')
  const confirmBox = container.querySelector('#ignore-risk-confirm')
  if (toggle && confirmBox) {
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        // 想开启无视风险 → 显示确认框
        confirmBox.style.display = 'block'
        toggle.checked = false // 先不改，等用户确认
      } else {
        // 想关闭无视风险 → 直接关闭，刷新页面引导设密码
        handleIgnoreRisk(container, false)
      }
    })

    container.querySelector('#btn-confirm-ignore')?.addEventListener('click', () => {
      handleIgnoreRisk(container, true)
    })
    container.querySelector('#btn-cancel-ignore')?.addEventListener('click', () => {
      confirmBox.style.display = 'none'
    })
  }
}

async function handleIgnoreRisk(container, enable) {
  try {
    await apiCall('auth_ignore_risk', { enable })
    if (enable) {
      toast('已开启无视风险模式，密码保护已关闭', 'warning')
    } else {
      toast('无视风险模式已关闭，请设置新密码', 'info')
    }
    setTimeout(() => loadStatus(container.closest('.page')), 500)
  } catch (e) {
    toast('操作失败: ' + e.message, 'error')
  }
}
