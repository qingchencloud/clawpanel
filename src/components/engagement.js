/**
 * 社区引导浮窗 — 适时提醒用户加群 & Star
 *
 * 触发条件（全部满足才弹出）：
 *   1. 累计打开 ≥ 2 次
 *   2. 首次打开距今 ≥ 1 天
 *   3. 今天未关闭过（每天最多弹一次）
 *   4. 未被永久关闭
 *   5. 由外部在"正向时机"主动调用 tryShow()（如保存配置成功、Gateway 启动成功）
 *   6. 不在聊天/助手页面时触发（避免打断对话）
 */

const KEYS = {
  firstOpen: 'clawpanel_first_open',
  openCount: 'clawpanel_open_count',
  lastShown: 'clawpanel_engage_shown',
  never: 'clawpanel_engage_never',
  todayDismiss: 'clawpanel_engage_today',
}

const DAY = 86400000
const MIN_OPENS = 2
const MIN_DAYS = 1
const COOLDOWN_DAYS = 1
const AUTO_DISMISS_MS = 25000

// 启动时记录打开次数
function _track() {
  const now = Date.now()
  if (!localStorage.getItem(KEYS.firstOpen)) {
    localStorage.setItem(KEYS.firstOpen, String(now))
  }
  const count = parseInt(localStorage.getItem(KEYS.openCount) || '0') + 1
  localStorage.setItem(KEYS.openCount, String(count))
}
_track()

function _todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function _canShow() {
  if (localStorage.getItem(KEYS.never) === '1') return false
  const count = parseInt(localStorage.getItem(KEYS.openCount) || '0')
  if (count < MIN_OPENS) return false
  const first = parseInt(localStorage.getItem(KEYS.firstOpen) || '0')
  if (Date.now() - first < MIN_DAYS * DAY) return false
  // 今天已经弹过/关闭过 → 不再弹
  if (localStorage.getItem(KEYS.todayDismiss) === _todayKey()) return false
  // 避免在聊天/助手页面打断对话
  const hash = location.hash || ''
  if (hash.includes('/chat') || hash.includes('/assistant')) return false
  return true
}

let _showing = false

/**
 * 在正向时机调用（如 Gateway 启动成功、配置保存成功）
 * 满足条件才弹出，否则静默返回
 */
export function tryShowEngagement() {
  if (_showing || !_canShow()) return
  if (document.querySelector('.engage-overlay')) return
  _showing = true
  localStorage.setItem(KEYS.lastShown, String(Date.now()))

  const shareText = '推荐一个开源的 OpenClaw 管理面板 — ClawPanel，一键搭建、便捷管理模型和 Agent，还内置 AI 助手帮你排查问题，小白也能轻松上手：https://claw.qt.cool'

  const overlay = document.createElement('div')
  overlay.className = 'engage-overlay'
  overlay.innerHTML = `
    <div class="engage-modal">
      <button class="engage-close" title="关闭">&times;</button>

      <div class="engage-header">
        <div class="engage-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        </div>
        <div class="engage-title">感谢你使用 ClawPanel</div>
      </div>

      <div class="engage-message">
        ClawPanel 是一个<strong>完全开源、免费</strong>的项目，由晴辰云团队专职维护、持续更新。如果它帮到了你，对我们最大的鼓励就是：
      </div>

      <div class="engage-actions-grid">
        <a class="engage-action-card" href="https://github.com/qingchencloud/clawpanel" target="_blank" rel="noopener">
          <div class="engage-action-icon engage-action-star">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="#f59e0b" stroke="#f59e0b" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div class="engage-action-text">
            <div class="engage-action-title">GitHub Star</div>
            <div class="engage-action-desc">点个 Star 是最直接的支持</div>
          </div>
        </a>
        <div class="engage-action-card engage-action-share" data-action="copy-share">
          <div class="engage-action-icon engage-action-link">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </div>
          <div class="engage-action-text">
            <div class="engage-action-title">分享给朋友</div>
            <div class="engage-action-desc">复制推荐文案，让更多人知道</div>
          </div>
        </div>
      </div>

      <div class="engage-section-label">扫码加入社区交流群，第一时间获取更新和帮助</div>
      <div class="engage-qrcodes">
        <a class="engage-qr-item" href="https://qt.cool/c/OpenClaw" target="_blank" rel="noopener">
          <img src="/images/OpenClaw-QQ.png" alt="QQ 交流群" />
          <div class="engage-qr-label">QQ 群</div>
        </a>
        <a class="engage-qr-item" href="https://qt.cool/c/OpenClawWx" target="_blank" rel="noopener">
          <img src="/images/OpenClawWx.png" alt="微信交流群" />
          <div class="engage-qr-label">微信群</div>
        </a>
        <a class="engage-qr-item" href="https://qt.cool/c/OpenClawDY" target="_blank" rel="noopener">
          <img src="/images/OpenClaw-DY.png" alt="抖音交流群" />
          <div class="engage-qr-label">抖音群</div>
        </a>
        <a class="engage-qr-item" href="https://qt.cool/c/feishu" target="_blank" rel="noopener">
          <img src="https://qt.cool/c/feishu/qr.png" alt="飞书交流群" />
          <div class="engage-qr-label">飞书群</div>
        </a>
      </div>

      <div class="engage-footer">
        <span class="engage-today-dismiss">今日不再弹窗</span>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('engage-visible'))

  function dismiss(markToday = true) {
    if (markToday) localStorage.setItem(KEYS.todayDismiss, _todayKey())
    overlay.classList.remove('engage-visible')
    setTimeout(() => { overlay.remove(); _showing = false }, 250)
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss() })
  overlay.querySelector('.engage-close').onclick = () => dismiss()
  overlay.querySelector('.engage-today-dismiss').onclick = () => dismiss(true)
  overlay.querySelector('[data-action="copy-share"]').onclick = () => {
    navigator.clipboard.writeText(shareText).then(() => {
      const desc = overlay.querySelector('[data-action="copy-share"] .engage-action-desc')
      if (desc) { desc.textContent = '✅ 已复制，去分享吧！'; setTimeout(() => { desc.textContent = '复制推荐文案，让更多人知道' }, 2000) }
    })
  }
}

// 测试用：绕过条件直接弹出（浏览器控制台输入 __testEngagement()）
window.__testEngagement = function() {
  _showing = false
  document.querySelector('.engage-overlay')?.remove()
  localStorage.removeItem(KEYS.never)
  localStorage.setItem(KEYS.openCount, '99')
  localStorage.setItem(KEYS.firstOpen, '0')
  localStorage.removeItem(KEYS.lastShown)
  tryShowEngagement()
}
