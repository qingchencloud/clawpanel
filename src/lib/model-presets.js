/**
 * 共享模型预设配置
 * models.js 和 assistant.js 共用，只需维护一套数据
 */

// API 接口类型选项
export const API_TYPES = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (最常用)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chatgpt-responses', label: 'OpenAI ChatGPT Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
  { value: 'google-vertex', label: 'Google Vertex AI' },
  { value: 'github-copilot', label: 'GitHub Copilot' },
  { value: 'bedrock-converse-stream', label: 'AWS Bedrock' },
  { value: 'ollama', label: 'Ollama 本地模型' },
  { value: 'azure-openai-responses', label: 'Azure OpenAI Responses' },
]

const API_TYPE_ALIASES = new Map([
  ['openai-codex-responses', 'openai-chatgpt-responses'],
  ['google-gemini', 'google-generative-ai'],
  ['gemini', 'google-generative-ai'],
  ['google', 'google-generative-ai'],
  ['anthropic', 'anthropic-messages'],
  ['openai', 'openai-completions'],
  ['openai-chat', 'openai-completions'],
])

export function normalizeModelApiType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'openai-completions'
  return API_TYPE_ALIASES.get(normalized) || normalized
}

export function isSupportedModelApiType(value) {
  const normalized = normalizeModelApiType(value)
  return API_TYPES.some(item => item.value === normalized)
}

export function modelApiTypeOptions(value) {
  const normalized = normalizeModelApiType(value)
  if (isSupportedModelApiType(normalized)) return API_TYPES
  return [{ value: normalized, label: `${normalized} (OpenClaw)` }, ...API_TYPES]
}

export function splitModelReference(value) {
  const [provider, ...modelParts] = String(value || '').split('/')
  return [provider, modelParts.join('/')]
}

// 服务商快捷预设
export const PROVIDER_PRESETS = [
  { key: 'qtcool', label: '晴辰云', badge: '免费测试', baseUrl: 'https://gpt.qt.cool/v1', api: 'openai-completions', site: 'https://gpt.qt.cool/', desc: 'ClawPanel 配套免费签到测试平台，适合体验和功能验证' },
  { key: 'atlascloud', label: 'Atlas Cloud', baseUrl: 'https://api.atlascloud.ai/v1', api: 'openai-completions', site: 'https://www.atlascloud.ai/', desc: 'OpenAI-compatible model API' },
  { key: 'ciyapi', label: '词元 API', badge: '赞助', sponsored: true, baseUrl: 'https://ciyapi.79tian.com/v1', api: 'openai-completions', site: 'https://ciyapi.79tian.com/', desc: '支持 GPT、Claude 等主流前沿模型；充值 ¥1 到账 $1 平台额度，部分线路按折扣计费' },
  { key: 'shengsuanyun', label: '胜算云', baseUrl: 'https://router.shengsuanyun.com/api/v1', api: 'openai-completions', site: 'https://www.shengsuanyun.com/?from=CH_4BVI0BM2', desc: '国内知名 AI 模型聚合平台，支持多种主流模型' },
  { key: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', site: 'https://cloud.siliconflow.cn/i/PFrw2an5', desc: '高性价比推理平台，支持 DeepSeek、Qwen 等开源模型' },
  { key: 'volcengine', label: '火山引擎', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions', site: 'https://volcengine.com/L/Ph1OP5I3_GY', desc: '字节跳动旗下云平台，支持豆包等模型' },
  { key: 'aliyun', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', site: 'https://www.aliyun.com/benefit/ai/aistar?userCode=keahn2zr&clubBiz=subTask..12435175..10263..', desc: '阿里云 AI 大模型平台，支持通义千问全系列' },
  { key: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', site: 'https://www.bigmodel.cn/glm-coding?ic=3F6F9XYKTS', desc: '国产大模型领军企业，支持 GLM-4 全系列' },
  { key: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', api: 'openai-completions', site: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', desc: '国产多模态大模型，支持 MiniMax-M3 / M2.7 系列' },
  { key: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', site: 'https://platform.moonshot.ai/console/api-keys', desc: 'Kimi 大模型平台，支持超长上下文' },
  { key: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', site: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic', label: 'Anthropic 官方', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', site: 'https://console.anthropic.com/settings/keys' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', site: 'https://platform.deepseek.com/api_keys' },
  { key: 'google', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', site: 'https://aistudio.google.com/app/apikey' },
  { key: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', site: 'https://console.x.ai/', desc: 'Elon Musk 旗下 AI，支持 Grok 系列模型' },
  { key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', site: 'https://console.groq.com/keys', desc: '超快推理平台，支持 Llama、Mixtral 等开源模型' },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', site: 'https://openrouter.ai/keys', desc: '模型聚合路由，一个 Key 访问所有主流模型' },
  { key: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions', site: 'https://build.nvidia.com/models', desc: '英伟达推理平台，支持 Llama、Mistral 等模型' },
  { key: 'ollama', label: 'Ollama (本地)', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', site: 'https://ollama.com/' },
]

// 晴辰云免费签到测试平台配置
export const QTCOOL = {
  baseUrl: 'https://gpt.qt.cool/v1',
  defaultKey: '',
  site: 'https://gpt.qt.cool/',
  checkinUrl: 'https://gpt.qt.cool/checkin',
  keyUrl: 'https://gpt.qt.cool/user',
  docsUrl: 'https://gpt.qt.cool/api-doc.html',
  statusUrl: 'https://gpt.qt.cool/status.html',
  providerKey: 'qtcool',
  brandName: '晴辰云',
  api: 'openai-completions',
  models: []
}

// 词元 API 第三方赞助推广配置
export const CIYAPI = {
  baseUrl: 'https://ciyapi.79tian.com/v1',
  defaultKey: '',
  site: 'https://ciyapi.79tian.com/',
  signupUrl: 'https://ciyapi.79tian.com/sign-up',
  keyUrl: 'https://ciyapi.79tian.com/keys/',
  pricingUrl: 'https://ciyapi.79tian.com/pricing/',
  walletUrl: 'https://ciyapi.79tian.com/wallet/',
  docsUrl: 'https://ciyapi.com/docs/',
  providerKey: 'ciyapi',
  brandName: '词元 API',
  api: 'openai-completions',
  models: []  // 始终从 API 动态获取最新模型列表
}

// 胜算云推广配置
export const SHENGSUANYUN = {
  baseUrl: 'https://router.shengsuanyun.com/api/v1',
  site: 'https://www.shengsuanyun.com/?from=CH_4BVI0BM2',
  providerKey: 'shengsuanyun',
  brandName: '胜算云',
  api: 'openai-completions',
}

// 常用模型预设（按服务商分组）
export const MODEL_PRESETS = {
  atlascloud: [
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: true },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
    { id: 'o3-mini', name: 'o3 Mini', contextWindow: 200000, reasoning: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
    { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', contextWindow: 200000 },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 64000 },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1', contextWindow: 64000, reasoning: true },
  ],
  google: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, reasoning: true },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
  ],
  minimax: [
    { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 524288 },
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 1000000 },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', contextWindow: 1000000 },
  ],
  moonshot: [
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 131072 },
    { id: 'kimi-k2', name: 'Kimi K2', contextWindow: 131072 },
    { id: 'kimi-latest', name: 'Kimi Latest', contextWindow: 131072 },
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4', contextWindow: 131072 },
    { id: 'grok-4-fast', name: 'Grok 4 Fast', contextWindow: 131072 },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 32768 },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768 },
  ],
  ollama: [
    { id: 'qwen3:32b', name: 'Qwen 3 32B', contextWindow: 32768 },
    { id: 'llama3.3:70b', name: 'Llama 3.3 70B', contextWindow: 8192 },
    { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B', contextWindow: 32768, reasoning: true },
  ],
}

/**
 * 从 OpenAI Compatible 服务动态获取模型列表。
 * 密钥必须由当前操作显式传入，不从本地配置自动读取，避免旧密钥被静默复用。
 */
async function fetchCompatibleModels(provider, apiKey) {
  const key = (apiKey || provider.defaultKey || '').trim()
  if (!key) return provider.models
  try {
    const resp = await fetch(provider.baseUrl + '/models', {
      headers: { 'Authorization': 'Bearer ' + key },
      signal: AbortSignal.timeout(8000)
    })
    if (resp.ok) {
      const data = await resp.json()
      if (data.data && data.data.length) {
        return data.data.map(m => ({
          id: m.id, name: m.id, contextWindow: 128000,
          reasoning: /codex|thinking|reasoner|reasoning/i.test(m.id)
        })).sort((a, b) => b.id.localeCompare(a.id))
      }
    }
  } catch { /* use fallback */ }
  return provider.models
}

/**
 * 动态获取晴辰云模型列表。
 * @param {string} [apiKey]
 */
export function fetchQtcoolModels(apiKey) {
  return fetchCompatibleModels(QTCOOL, apiKey)
}

/**
 * 动态获取词元 API 模型列表。
 * @param {string} [apiKey]
 */
export function fetchCiyapiModels(apiKey) {
  return fetchCompatibleModels(CIYAPI, apiKey)
}
