/**
 * 术语表 — 让小白看懂面板里的技术词
 *
 * 设计原则：
 *   - 术语用「比喻 + 一句话」解释，避免循环引用其他术语
 *   - 每条术语标注「相关页面」，点击直达对应配置入口
 *   - 数据直接内嵌（非走 locales 模块），后期需要更多语言时再迁
 */
import { t, getLang } from '../lib/i18n.js'
import { navigate } from '../router.js'

// ── 25 个核心术语（zh-CN / en / zh-TW；其他语言后续补） ──

const GLOSSARY = [
  // 核心概念
  {
    id: 'agent', term: 'Agent', cat: 'core', route: '/agents',
    zhCN: { name: 'Agent（智能体）', desc: '面板里的「分身」—— 拥有独立身份、技能、记忆，能代你聊天和办事。每个 Agent 类似一个独立的 AI 角色，互不干扰。' },
    en: { name: 'Agent', desc: 'Your "alter ego" inside the panel — has its own identity, skills, and memory, and can chat or take actions on your behalf. Each Agent is an independent AI persona that does not interfere with others.' },
    zhTW: { name: 'Agent（智能體）', desc: '面板裡的「分身」—— 擁有獨立身分、技能、記憶，能代你聊天和辦事。每個 Agent 類似一個獨立的 AI 角色，互不干擾。' },
  },
  {
    id: 'gateway', term: 'Gateway', cat: 'core', route: '/services',
    zhCN: { name: 'Gateway（网关）', desc: '面板与 AI 模型之间的「翻译官」+「调度员」。所有对话、技能调用、消息收发都从它经过。Gateway 没启动 = 面板用不了。' },
    en: { name: 'Gateway', desc: 'The "translator" + "dispatcher" between the panel and your AI models. All chat, skill calls, and message routing pass through it. If Gateway is down, the panel can\'t do anything.' },
    zhTW: { name: 'Gateway（網關）', desc: '面板與 AI 模型之間的「翻譯官」+「調度員」。所有對話、技能呼叫、訊息收發都從它經過。Gateway 沒啟動 = 面板用不了。' },
  },
  {
    id: 'channel', term: 'Channel', cat: 'core', route: '/channels',
    zhCN: { name: 'Channel（消息渠道）', desc: '把 Agent 接入到外部的「窗口」—— 比如 Telegram、Discord、QQ、飞书等。配好渠道后，AI 就能通过这些应用收发消息。' },
    en: { name: 'Channel', desc: 'The "window" that connects an Agent to external apps — Telegram, Discord, QQ, Feishu, etc. Once configured, the AI can send/receive messages through these apps.' },
    zhTW: { name: 'Channel（訊息頻道）', desc: '把 Agent 接入到外部的「窗口」—— 例如 Telegram、Discord、QQ、飛書等。配好頻道後，AI 就能透過這些應用收發訊息。' },
  },
  {
    id: 'skill', term: 'Skill', cat: 'core', route: '/skills',
    zhCN: { name: 'Skill（技能）', desc: 'Agent 的「特长包」—— 给它装上「天气查询」「日历管理」「文件操作」等能力，它就能在对话中自动调用这些工具。' },
    en: { name: 'Skill', desc: 'A "talent pack" for the Agent — install abilities like "weather lookup", "calendar management", or "file ops", and the Agent will use them automatically during chat.' },
    zhTW: { name: 'Skill（技能）', desc: 'Agent 的「特長包」—— 給它裝上「天氣查詢」「行事曆管理」「檔案操作」等能力，它就能在對話中自動使用這些工具。' },
  },
  {
    id: 'memory', term: 'Memory', cat: 'core', route: '/memory',
    zhCN: { name: 'Memory（记忆）', desc: 'Agent 的「日记本」—— 把重要对话、用户偏好、长期信息存下来，下次聊天时它能记住你说过什么。' },
    en: { name: 'Memory', desc: 'The Agent\'s "journal" — saves important conversations, user preferences, and long-term info so it remembers what you said in past sessions.' },
    zhTW: { name: 'Memory（記憶）', desc: 'Agent 的「日記本」—— 把重要對話、使用者偏好、長期資訊存下來，下次聊天時它能記住你說過什麼。' },
  },
  {
    id: 'session', term: 'Session', cat: 'core', route: '/chat',
    zhCN: { name: 'Session（会话）', desc: '一次连续的对话上下文。同一个 Session 里 AI 记得你说过的所有话；切换或重置 Session 就相当于「翻篇」重新开始。' },
    en: { name: 'Session', desc: 'A continuous chat context. Within the same Session the AI remembers everything you said; switching or resetting starts fresh from a clean slate.' },
    zhTW: { name: 'Session（對話）', desc: '一次連續的對話上下文。同一個 Session 裡 AI 記得你說過的所有話；切換或重置就相當於「翻篇」重新開始。' },
  },
  {
    id: 'workspace', term: 'Workspace', cat: 'core', route: '/agents',
    zhCN: { name: 'Workspace（工作目录）', desc: 'Agent 用来读写文件的「文件夹」。每个 Agent 可以指定独立的工作目录，互不干扰，避免误删别的 Agent 的资料。' },
    en: { name: 'Workspace', desc: 'The "folder" the Agent reads/writes files in. Each Agent can have its own workspace so they don\'t accidentally touch each other\'s files.' },
    zhTW: { name: 'Workspace（工作目錄）', desc: 'Agent 用來讀寫檔案的「資料夾」。每個 Agent 可以指定獨立的工作目錄，互不干擾，避免誤刪別的 Agent 的資料。' },
  },
  {
    id: 'pairing', term: 'Pairing', cat: 'core', route: '/security',
    zhCN: { name: 'Pairing（设备配对）', desc: '把面板和你的手机/平板「认亲」的过程。配对成功后，移动端 App 就能直接连到面板，不需要每次输密码。' },
    en: { name: 'Pairing', desc: 'The process of "linking" the panel with your phone/tablet. Once paired, the mobile app connects directly without needing to log in each time.' },
    zhTW: { name: 'Pairing（裝置配對）', desc: '把面板和你的手機/平板「認親」的過程。配對成功後，行動裝置 App 就能直接連到面板，不需要每次輸密碼。' },
  },
  // 模型与服务
  {
    id: 'provider', term: 'Provider', cat: 'model', route: '/models',
    zhCN: { name: 'Provider（服务商）', desc: '给你提供 AI 模型的厂商 —— 比如 OpenAI（ChatGPT）、Anthropic（Claude）、DeepSeek、Qwen 等。每个 Provider 通常对应一个 API key。' },
    en: { name: 'Provider', desc: 'A company that supplies AI models — OpenAI (ChatGPT), Anthropic (Claude), DeepSeek, Qwen, etc. Each provider usually maps to one API key.' },
    zhTW: { name: 'Provider（服務商）', desc: '給你提供 AI 模型的廠商 —— 例如 OpenAI（ChatGPT）、Anthropic（Claude）、DeepSeek、Qwen 等。每個 Provider 通常對應一個 API key。' },
  },
  {
    id: 'apikey', term: 'API Key', cat: 'model', route: '/models',
    zhCN: { name: 'API Key（API 密钥）', desc: '类似服务商发的「会员卡密码」。AI 调用要扣费，凭这把钥匙服务商才知道是你在用，并按使用量计费。' },
    en: { name: 'API Key', desc: 'Like a "member-card password" issued by the provider. The AI calls cost money — this key tells the provider it\'s you so they can bill correctly.' },
    zhTW: { name: 'API Key（API 密鑰）', desc: '類似服務商發的「會員卡密碼」。AI 呼叫要扣費，憑這把鑰匙服務商才知道是你在用，並按使用量計費。' },
  },
  {
    id: 'token', term: 'Token', cat: 'model', route: '/models',
    zhCN: { name: 'Token（计费单位）', desc: 'AI 模型按「Token」收费 —— 大致相当于一个汉字、一个英文单词或半个标点。一次对话用 1000 Token = 大概 700 字。' },
    en: { name: 'Token', desc: 'The unit AI models bill in. Roughly equals one character (Chinese), one English word, or half a punctuation mark. 1000 tokens ≈ 750 English words.' },
    zhTW: { name: 'Token（計費單位）', desc: 'AI 模型按「Token」收費 —— 大致相當於一個中文字、一個英文單字或半個標點。一次對話用 1000 Token = 大概 700 字。' },
  },
  {
    id: 'streaming', term: 'Streaming', cat: 'model',
    zhCN: { name: 'Streaming（流式响应）', desc: 'AI 一边生成一边显示给你看（打字机效果），不用等它写完再显示。等待感好很多，但稍微费点带宽。' },
    en: { name: 'Streaming', desc: 'The AI shows tokens to you as it generates them (typewriter effect) instead of waiting for the whole response. Better UX, slightly more bandwidth.' },
    zhTW: { name: 'Streaming（串流回應）', desc: 'AI 一邊生成一邊顯示給你看（打字機效果），不用等它寫完再顯示。等待感好很多，但稍微費點頻寬。' },
  },
  {
    id: 'context', term: 'Context Window', cat: 'model',
    zhCN: { name: 'Context Window（上下文窗口）', desc: 'AI 一次对话能「记住」多少字。比如 32K = 大概 2 万汉字。超出窗口的早期对话 AI 会忘掉。' },
    en: { name: 'Context Window', desc: 'How much text the AI can "remember" in one chat. e.g. 32K ≈ 24K English words. Anything older than the window gets forgotten by the AI.' },
    zhTW: { name: 'Context Window（上下文視窗）', desc: 'AI 一次對話能「記住」多少字。例如 32K = 大概 2 萬中文字。超出視窗的早期對話 AI 會忘掉。' },
  },
  {
    id: 'profile', term: 'Profile', cat: 'model',
    zhCN: { name: 'Profile（配置档案）', desc: '一组配置的「快照」—— 比如「白天用 GPT-4，晚上用 Claude」可以存成两个 Profile，一键切换。' },
    en: { name: 'Profile', desc: 'A "snapshot" of settings — e.g. "GPT-4 by day, Claude by night" can be saved as two profiles and switched with one click.' },
    zhTW: { name: 'Profile（設定檔）', desc: '一組設定的「快照」—— 例如「白天用 GPT-4，晚上用 Claude」可以存成兩個 Profile，一鍵切換。' },
  },
  // 接入与协议
  {
    id: 'webhook', term: 'Webhook', cat: 'integration', route: '/channels',
    zhCN: { name: 'Webhook（回调地址）', desc: '一个外部应用「打你电话」的号码。比如 Discord 收到消息后就请求这个地址通知 ClawPanel，触发 AI 回复。' },
    en: { name: 'Webhook', desc: 'A URL external apps "call back" to. e.g. when Discord receives a message it pings this URL so ClawPanel knows and triggers the AI to respond.' },
    zhTW: { name: 'Webhook（回呼網址）', desc: '一個外部應用「打你電話」的號碼。例如 Discord 收到訊息後就請求這個位址通知 ClawPanel，觸發 AI 回覆。' },
  },
  {
    id: 'oauth', term: 'OAuth', cat: 'integration', route: '/channels',
    zhCN: { name: 'OAuth（第三方授权）', desc: '一种「不用给密码也能让别人代你登录」的协议。授权 ClawPanel 接入 Discord 时走的就是 OAuth，比直接给 token 更安全。' },
    en: { name: 'OAuth', desc: 'A protocol that lets services log in on your behalf without you sharing your password. ClawPanel uses OAuth when connecting Discord — safer than handing over a raw token.' },
    zhTW: { name: 'OAuth（第三方授權）', desc: '一種「不用給密碼也能讓別人代你登入」的協定。授權 ClawPanel 接入 Discord 時走的就是 OAuth，比直接給 token 更安全。' },
  },
  {
    id: 'bottoken', term: 'Bot Token', cat: 'integration', route: '/channels',
    zhCN: { name: 'Bot Token（机器人令牌）', desc: 'Telegram/Discord 等平台给你的机器人发的「身份卡」。把它配到 ClawPanel，AI 就能以这个机器人的身份说话。' },
    en: { name: 'Bot Token', desc: 'The "ID card" issued by Telegram/Discord/etc. to your bot. Once you put it in ClawPanel, the AI can speak as this bot identity.' },
    zhTW: { name: 'Bot Token（機器人權杖）', desc: 'Telegram/Discord 等平台給你的機器人發的「身分卡」。把它配到 ClawPanel，AI 就能以這個機器人的身分說話。' },
  },
  {
    id: 'binding', term: 'Binding', cat: 'integration', route: '/channels',
    zhCN: { name: 'Binding（绑定关系）', desc: '把「哪个 Agent」和「哪个渠道」配对的规则。比如「营销 Agent 接 Discord，技术 Agent 接 Slack」就是两条 Binding。' },
    en: { name: 'Binding', desc: 'A rule that pairs "which Agent" with "which Channel". e.g. "marketing Agent to Discord, technical Agent to Slack" is two bindings.' },
    zhTW: { name: 'Binding（綁定關係）', desc: '把「哪個 Agent」和「哪個頻道」配對的規則。例如「行銷 Agent 接 Discord，技術 Agent 接 Slack」就是兩條 Binding。' },
  },
  {
    id: 'mcp', term: 'MCP', cat: 'integration',
    zhCN: { name: 'MCP（模型上下文协议）', desc: '一种让 AI 模型能用「外部工具」的标准。配上 MCP server 后，AI 可以读你的数据库、调你的 API、操作你的应用。' },
    en: { name: 'MCP (Model Context Protocol)', desc: 'A standard that lets AI models call "external tools". Once you add MCP servers, the AI can query your databases, call your APIs, and operate your apps.' },
    zhTW: { name: 'MCP（模型上下文協定）', desc: '一種讓 AI 模型能用「外部工具」的標準。配上 MCP server 後，AI 可以讀你的資料庫、呼叫你的 API、操作你的應用。' },
  },
  // 进阶
  {
    id: 'cron', term: 'Cron', cat: 'advanced', route: '/cron',
    zhCN: { name: 'Cron（定时任务）', desc: '让 AI 在固定时间自动做事 —— 比如「每天早上 9 点推送当天会议安排」「每周一总结一次工作进度」。' },
    en: { name: 'Cron', desc: 'Schedule the AI to act on a fixed timetable — e.g. "every day at 9am push today\'s meetings", "every Monday summarize work progress".' },
    zhTW: { name: 'Cron（定時任務）', desc: '讓 AI 在固定時間自動做事 —— 例如「每天早上 9 點推送當天會議安排」「每週一總結一次工作進度」。' },
  },
  {
    id: 'dreaming', term: 'Dreaming', cat: 'advanced', route: '/dreaming',
    zhCN: { name: 'Dreaming（梦境模式）', desc: 'AI 在你不用它的时候自动「整理记忆」—— 把短期对话沉淀成长期记忆，类似人睡觉时大脑做梦消化白天的事。' },
    en: { name: 'Dreaming', desc: 'When you\'re not using the AI, it auto-consolidates memory — promoting short-term chat into long-term memory, like the brain processing the day during sleep.' },
    zhTW: { name: 'Dreaming（夢境模式）', desc: 'AI 在你不用它的時候自動「整理記憶」—— 把短期對話沉澱成長期記憶，類似人睡覺時大腦做夢消化白天的事。' },
  },
  {
    id: 'backup', term: 'Backup', cat: 'advanced', route: '/services',
    zhCN: { name: 'Backup（备份）', desc: '把当前面板配置（模型、Agent、渠道、技能等）保存一份「快照」。改坏了能一键还原，不会一夜回到解放前。' },
    en: { name: 'Backup', desc: 'A "snapshot" of your current panel config (models, agents, channels, skills, etc.). If you mess something up, restore in one click and you\'re safe.' },
    zhTW: { name: 'Backup（備份）', desc: '把目前面板設定（模型、Agent、頻道、技能等）儲存一份「快照」。改壞了能一鍵還原，不會一夜回到解放前。' },
  },
  {
    id: 'compaction', term: 'Compaction', cat: 'advanced',
    zhCN: { name: 'Compaction（会话压缩）', desc: '对话太长 Token 用太多时，AI 自动「总结早期内容」—— 把开头一长段聊天压成一句话，省 Token 也保留要点。' },
    en: { name: 'Compaction', desc: 'When a chat gets too long and uses too many tokens, the AI auto-summarizes the earlier parts — collapsing chunks into a sentence to save tokens while keeping the gist.' },
    zhTW: { name: 'Compaction（對話壓縮）', desc: '對話太長 Token 用太多時，AI 自動「總結早期內容」—— 把開頭一長段聊天壓成一句話，省 Token 也保留要點。' },
  },
  {
    id: 'sandbox', term: 'Sandbox', cat: 'advanced',
    zhCN: { name: 'Sandbox（沙箱）', desc: 'AI 执行命令的「安全屋」—— 在隔离环境里跑代码、装依赖，出问题不会影响你的主系统。' },
    en: { name: 'Sandbox', desc: 'A "safe room" for the AI to run commands — isolates code execution and dependency installs so problems can\'t harm your main system.' },
    zhTW: { name: 'Sandbox（沙箱）', desc: 'AI 執行命令的「安全屋」—— 在隔離環境裡跑程式碼、裝依賴，出問題不會影響你的主系統。' },
  },
  {
    id: 'plugin', term: 'Plugin', cat: 'advanced', route: '/plugin-hub',
    zhCN: { name: 'Plugin（插件）', desc: '给面板「装新功能」的扩展包 —— 第三方写好的渠道适配、特殊技能、UI 组件等都能通过插件加进来。' },
    en: { name: 'Plugin', desc: 'Add-ons that give the panel new abilities — third-party channel adapters, special skills, UI components, etc. can all be added via plugins.' },
    zhTW: { name: 'Plugin（外掛）', desc: '給面板「裝新功能」的擴充包 —— 第三方寫好的頻道介接、特殊技能、UI 元件等都能透過外掛加進來。' },
  },
]

const CATEGORIES = [
  { id: 'all', zhCN: '全部', en: 'All', zhTW: '全部' },
  { id: 'core', zhCN: '核心概念', en: 'Core Concepts', zhTW: '核心概念' },
  { id: 'model', zhCN: '模型与服务', en: 'Models & Providers', zhTW: '模型與服務' },
  { id: 'integration', zhCN: '接入与协议', en: 'Integration & Protocols', zhTW: '接入與協定' },
  { id: 'advanced', zhCN: '进阶概念', en: 'Advanced', zhTW: '進階概念' },
]

function pickLang(item) {
  const lang = getLang()
  if (lang.startsWith('zh-CN')) return item.zhCN
  if (lang.startsWith('zh-TW')) return item.zhTW || item.zhCN
  return item.en
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page glossary-page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${esc(t('glossary.title'))}</h1>
      <p class="page-desc">${esc(t('glossary.desc'))}</p>
    </div>

    <div class="glossary-toolbar">
      <input type="search" id="glossary-search" class="form-input" placeholder="${esc(t('glossary.searchPlaceholder'))}">
      <div class="glossary-tabs" id="glossary-tabs">
        ${CATEGORIES.map(c => `<button class="tab" data-cat="${c.id}">${esc(pickLang(c))}</button>`).join('')}
      </div>
    </div>

    <div id="glossary-list" class="glossary-list"></div>
  `

  const state = { cat: 'all', query: '' }

  function rerender() {
    const listEl = page.querySelector('#glossary-list')
    const q = state.query.trim().toLowerCase()
    const items = GLOSSARY.filter(item => {
      if (state.cat !== 'all' && item.cat !== state.cat) return false
      if (!q) return true
      const txt = pickLang(item)
      return item.term.toLowerCase().includes(q)
        || (txt?.name || '').toLowerCase().includes(q)
        || (txt?.desc || '').toLowerCase().includes(q)
    })
    if (!items.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-desc">${esc(t('glossary.noMatch'))}</div>
        </div>
      `
      return
    }
    listEl.innerHTML = items.map(item => {
      const txt = pickLang(item)
      const cta = item.route
        ? `<button class="btn btn-xs btn-secondary" data-glossary-route="${esc(item.route)}">${esc(t('glossary.openPage'))} →</button>`
        : ''
      return `
        <div class="glossary-card">
          <div class="glossary-card-head">
            <div class="glossary-term">${esc(txt.name)}</div>
            ${cta}
          </div>
          <div class="glossary-desc">${esc(txt.desc)}</div>
        </div>
      `
    }).join('')
    listEl.querySelectorAll('[data-glossary-route]').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.glossaryRoute))
    })
  }

  // Tab 切换
  page.querySelectorAll('#glossary-tabs .tab').forEach(tab => {
    if (tab.dataset.cat === 'all') tab.classList.add('active')
    tab.addEventListener('click', () => {
      page.querySelectorAll('#glossary-tabs .tab').forEach(x => x.classList.remove('active'))
      tab.classList.add('active')
      state.cat = tab.dataset.cat
      rerender()
    })
  })

  // 搜索
  const searchInput = page.querySelector('#glossary-search')
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value
    rerender()
  })

  rerender()
  return page
}
