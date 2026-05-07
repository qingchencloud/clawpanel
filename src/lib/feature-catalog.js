/**
 * 特性目录 — 声明每个可选特性需要的最低内核版本
 *
 * 这是 ClawPanel 跨多版本内核的「唯一真相源」：
 * - 当上游引入一个新特性而我们想在面板中使用时，在这里加一行
 * - 页面通过 kernel.js 的 hasFeature(id) 同步查询，不要硬编码版本号比较
 * - 命名规范: <area>.<feature>，例如 sessions.truncation, models.cooldownScope
 *
 * @see .tmp/multi-kernel-compat-design.md §4.1 为详细设计文档
 */

/**
 * @typedef {Object} FeatureDef
 * @property {string} engine    引擎 id，当前仅 'openclaw' 或 'hermes'
 * @property {string} minVersion 最低内核版本号（不含 -zh 后缀）
 * @property {string} [desc]    特性说明，仅调试用
 */

/** @type {Record<string, FeatureDef>} */
export const FEATURE_CATALOG = {
  // ===== 协议层 =====
  'gateway.backendSelfPair': {
    engine: 'openclaw',
    minVersion: '2026.3.2',
    desc: 'gateway-client backend 模式可省略 device 字段',
  },
  'ws.startupSidecarsErr': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'connect 期间返回 startup-sidecars 错误码 + retryAfterMs',
  },

  // ===== Sessions / Chat =====
  'sessions.truncation': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'sessions.list 返回 truncated/cursor 分页元数据',
  },
  'sessions.cleanupTranscript': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'sessions cleanup 修剪孤立 transcript / checkpoint / trajectory',
  },
  'chat.replyRunGuard': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: '连续 chat.send 不再 ReplyRunAlreadyActiveError',
  },

  // ===== Agents =====
  'agents.runtime': {
    engine: 'openclaw',
    minVersion: '2026.5.2',
    desc: 'agents.list 返回 agentRuntime 元数据',
  },
  'agents.toolProgressDetail': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'agents.defaults.toolProgressDetail: "raw"',
  },
  'agents.contextLimits': {
    engine: 'openclaw',
    minVersion: '2026.4.10',
    desc: 'agents.defaults.contextLimits.* (4 字段)',
  },
  'agents.skillsLimits': {
    engine: 'openclaw',
    minVersion: '2026.4.15',
    desc: 'agents.list[].skillsLimits.maxSkillsPromptChars',
  },

  // ===== Models =====
  'models.probeStatus': {
    engine: 'openclaw',
    minVersion: '2026.5.2',
    desc: '/model status 返回 excluded_by_auth_order / no_model 状态',
  },
  'models.cooldownScope': {
    engine: 'openclaw',
    minVersion: '2026.5.3',
    desc: 'auth profile cooldown 改为 model-scoped',
  },
  'models.codexRouteMigrated': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'doctor 自动迁移 openai-codex/* → openai/* + agentRuntime: codex',
  },

  // ===== Memory =====
  'memory.statusDeepSplit': {
    engine: 'openclaw',
    minVersion: '2026.5.3',
    desc: 'memory status --deep 分离 sqlite-vec 与 embedding-provider 就绪',
  },
  'memory.activeMemoryGraceful': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: '无 memory plugin 时优雅跳过，不打 allowlist 错',
  },
  'memory.dreamingTabs': {
    engine: 'openclaw',
    minVersion: '2026.4.11',
    desc: 'Dreaming Wiki / Imported Insights / Memory Palace 子标签',
  },

  // ===== Cron =====
  'cron.toolPolicyError': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'cron show 返回真实 tool-policy 失败原因',
  },
  'cron.timeoutSecondsDual': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'cron timeoutSeconds 同时驱动 CLI 和 LLM watchdog',
  },

  // ===== Doctor / Update =====
  'doctor.deepSupervisor': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'doctor --deep 报告 supervisor restart handoff',
  },
  'doctor.heartbeatRecovery': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'doctor --fix 修复 agent:main:main heartbeat 中毒',
  },
  'doctor.failClosedConfig': {
    engine: 'openclaw',
    minVersion: '2026.5.3',
    desc: 'Gateway 启动 fail-closed 无效配置，由 doctor --fix 修复',
  },

  // ===== Channels =====
  'channels.lineOpenValidate': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'LINE dmPolicy:"open" 校验 allowFrom 通配',
  },
  'channels.mattermostUrlWizard': {
    engine: 'openclaw',
    minVersion: '2026.5.5',
    desc: 'Mattermost setup wizard 收集 httpUrl',
  },
  'channels.toolProgressRaw': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: '渠道进度草稿 honor toolProgressDetail: raw',
  },

  // ===== Plugins =====
  'plugins.installHints': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'doctor 输出 catalog-backed install hints',
  },
  'plugins.clawhubRateLimit': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'ClawHub 429 错误带 Retry-After',
  },

  // ===== Gateway 配置（我们一般不改，但读取时需容错） =====
  'gateway.embedSandbox': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'gateway.controlUi.embedSandbox 字段',
  },
  'gateway.allowExternalEmbedUrls': {
    engine: 'openclaw',
    minVersion: '2026.5.4',
    desc: 'gateway.controlUi.allowExternalEmbedUrls 字段',
  },
}

/**
 * 硬地板：低于此版本的内核，ClawPanel 会弹出全屏拦截。
 * 选择 2026.3.2 是因为 gateway-client backend 模式从此引入，是我们长期对接路径根基。
 */
export const KERNEL_FLOOR = {
  openclaw: '2026.3.2',
  hermes: '0.8.0',
}

/**
 * 推荐目标版本：默认安装/升级使用。
 * 真正的推荐版由 openclaw-version-policy.json 控制，这里仅作 fallback / 展示用。
 */
export const KERNEL_TARGET = {
  openclaw: {
    official: '2026.5.6',
    chinese: '2026.5.6-zh.2',
  },
  hermes: {
    default: '0.13.x',
  },
}
