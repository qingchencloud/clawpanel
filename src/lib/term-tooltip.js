/**
 * 术语提示 — 在页面中嵌入「ⓘ」按钮，点击弹出术语解释小卡片
 *
 * 用法：
 *   import { termHelpHtml, attachTermTooltips } from '../lib/term-tooltip.js'
 *
 *   // 在页面 HTML 中插入按钮：
 *   <label>${t('webhook')} ${termHelpHtml('webhook')}</label>
 *
 *   // 渲染完成后绑定 click：
 *   attachTermTooltips(rootEl)
 *
 * 数据源：内嵌一份精简的术语映射表（仅高频术语），
 *         与 `pages/glossary.js` 完整术语表互补。
 */
import { t, getLang } from './i18n.js'
import { showContentModal } from '../components/modal.js'
import { navigate } from '../router.js'

// 高频术语精简映射（与 glossary.js 数据保持一致；仅纳入页面 ⓘ 旁要弹出的）
const TERMS = {
  oauth: {
    zhCN: { name: 'OAuth', desc: '一种「不用给密码也能让别人代你登录」的协议。授权 ClawPanel 接入 Discord 时走的就是 OAuth，比直接给 token 更安全。' },
    en: { name: 'OAuth', desc: 'A protocol that lets services log in on your behalf without sharing your password. ClawPanel uses OAuth when connecting Discord — safer than handing over a raw token.' },
    zhTW: { name: 'OAuth', desc: '一種「不用給密碼也能讓別人代你登入」的協定。授權 ClawPanel 接入 Discord 時走的就是 OAuth，比直接給 token 更安全。' },
  },
  webhook: {
    zhCN: { name: 'Webhook', desc: '一个外部应用「打你电话」的号码。比如 Discord 收到消息后就请求这个地址通知 ClawPanel，触发 AI 回复。' },
    en: { name: 'Webhook', desc: 'A URL external apps "call back" to. e.g. when Discord receives a message it pings this URL so ClawPanel knows and triggers the AI to respond.' },
    zhTW: { name: 'Webhook', desc: '一個外部應用「打你電話」的號碼。例如 Discord 收到訊息後就請求這個位址通知 ClawPanel，觸發 AI 回覆。' },
  },
  bottoken: {
    zhCN: { name: 'Bot Token', desc: 'Telegram/Discord 等平台给你的机器人发的「身份卡」。把它配到 ClawPanel，AI 就能以这个机器人的身份说话。' },
    en: { name: 'Bot Token', desc: 'The "ID card" issued by Telegram/Discord/etc. to your bot. Once you put it in ClawPanel, the AI can speak as this bot identity.' },
    zhTW: { name: 'Bot Token', desc: 'Telegram/Discord 等平台給你的機器人發的「身分卡」。把它配到 ClawPanel，AI 就能以這個機器人的身分說話。' },
  },
  apikey: {
    zhCN: { name: 'API Key', desc: '类似服务商发的「会员卡密码」。AI 调用要扣费，凭这把钥匙服务商才知道是你在用，并按使用量计费。' },
    en: { name: 'API Key', desc: 'Like a "member-card password" issued by the provider. AI calls cost money — this key tells the provider it\'s you so they can bill correctly.' },
    zhTW: { name: 'API Key', desc: '類似服務商發的「會員卡密碼」。AI 呼叫要扣費，憑這把鑰匙服務商才知道是你在用，並按使用量計費。' },
  },
  token: {
    zhCN: { name: 'Token（计费单位）', desc: 'AI 模型按「Token」收费 —— 大致相当于一个汉字、一个英文单词或半个标点。一次对话用 1000 Token = 大概 700 字。' },
    en: { name: 'Token', desc: 'The unit AI models bill in. Roughly equals one character (Chinese), one English word, or half a punctuation mark. 1000 tokens ≈ 750 English words.' },
    zhTW: { name: 'Token（計費單位）', desc: 'AI 模型按「Token」收費 —— 大致相當於一個中文字、一個英文單字或半個標點。一次對話用 1000 Token = 大概 700 字。' },
  },
  context: {
    zhCN: { name: '上下文窗口', desc: 'AI 一次对话能「记住」多少字。比如 32K = 大概 2 万汉字。超出窗口的早期对话 AI 会忘掉。' },
    en: { name: 'Context Window', desc: 'How much text the AI can "remember" in one chat. e.g. 32K ≈ 24K English words. Anything older than the window gets forgotten.' },
    zhTW: { name: '上下文視窗', desc: 'AI 一次對話能「記住」多少字。例如 32K = 大概 2 萬中文字。超出視窗的早期對話 AI 會忘掉。' },
  },
  binding: {
    zhCN: { name: '绑定', desc: '把「哪个 Agent」和「哪个渠道」配对的规则。比如「营销 Agent 接 Discord，技术 Agent 接 Slack」就是两条 Binding。' },
    en: { name: 'Binding', desc: 'A rule pairing "which Agent" with "which Channel". e.g. "marketing Agent to Discord, technical Agent to Slack" is two bindings.' },
    zhTW: { name: '綁定', desc: '把「哪個 Agent」和「哪個頻道」配對的規則。' },
  },
  scope: {
    zhCN: { name: '权限范围（Scope）', desc: '机器人能做什么的「白名单」—— 比如读消息、发消息、改群成员等。Scope 给少了功能不足，给多了有安全风险。' },
    en: { name: 'Scope (Permissions)', desc: 'A whitelist of what the bot is allowed to do — read messages, send messages, manage members, etc. Too few = missing features; too many = security risk.' },
    zhTW: { name: '權限範圍（Scope）', desc: '機器人能做什麼的「白名單」—— 例如讀訊息、發訊息、改群成員等。Scope 給少了功能不足，給多了有安全風險。' },
  },
}

function pickLang(item) {
  const lang = getLang()
  if (lang.startsWith('zh-CN')) return item.zhCN
  if (lang.startsWith('zh-TW')) return item.zhTW || item.zhCN
  return item.en
}

/**
 * 返回一个 ⓘ 按钮的 HTML 字符串。点击后弹出术语解释 modal。
 * @param {string} termId
 * @returns {string} HTML
 */
export function termHelpHtml(termId) {
  if (!TERMS[termId]) return ''
  return `<button type="button" class="term-help" data-term-help="${termId}" aria-label="${t('glossary.title')}" tabindex="-1">ⓘ</button>`
}

/**
 * 在容器里扫描所有 [data-term-help] 按钮，给加 click handler 弹 modal。
 * 重复调用安全（用 dataset 标记防重复绑定）。
 * @param {HTMLElement} root
 */
export function attachTermTooltips(root) {
  if (!root) return
  root.querySelectorAll('[data-term-help]').forEach(btn => {
    if (btn.dataset.termHelpBound === '1') return
    btn.dataset.termHelpBound = '1'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const termId = btn.dataset.termHelp
      const term = TERMS[termId]
      if (!term) return
      const txt = pickLang(term)
      const overlay = showContentModal({
        title: txt.name,
        content: `<p style="font-size:var(--font-size-sm);color:var(--text-secondary);line-height:1.7;margin:0">${escapeHtml(txt.desc)}</p>`,
        buttons: [{ label: t('glossary.title') + ' →', className: 'btn btn-primary btn-sm', id: 'btn-go-glossary' }],
        width: 420,
      })
      overlay.querySelector('#btn-go-glossary')?.addEventListener('click', () => {
        overlay.close?.()
        navigate('/glossary')
      })
    })
  })
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
