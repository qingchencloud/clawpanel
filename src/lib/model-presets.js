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

// 服务商快捷预设
export const PROVIDER_PRESETS = [
  { key: 'shengsuanyun', label: '胜算云', baseUrl: 'https://router.shengsuanyun.com/api/v1', api: 'openai-completions', site: 'https://www.shengsuanyun.com/', desc: '国内知名 AI 模型聚合平台，支持多种主流模型' },
  { key: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', site: 'https://cloud.siliconflow.cn/', desc: '高性价比推理平台，支持 DeepSeek、Qwen 等开源模型' },
  { key: 'volcengine', label: '火山引擎', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions', site: 'https://www.volcengine.com/', desc: '字节跳动旗下云平台，支持豆包等模型' },
  { key: 'aliyun', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', site: 'https://www.aliyun.com/', desc: '阿里云 AI 大模型平台，支持通义千问全系列' },
  { key: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', site: 'https://www.bigmodel.cn/', desc: '国产大模型领军企业，支持 GLM-4 全系列' },
  { key: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', api: 'openai-completions', site: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', desc: '国产多模态大模型，支持 MiniMax-M3 / M2.7 系列' },
  { key: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', site: 'https://platform.moonshot.ai/console/api-keys', desc: 'Kimi 大模型平台，支持超长上下文' },
  { key: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', site: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic', label: 'Anthropic 官方', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', site: 'https://console.anthropic.com/settings/keys' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', site: 'https://platform.deepseek.com/api_keys' },
  { key: 'google', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', site: 'https://aistudio.google.com/app/apikey' },
  { key: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', site: 'https://console.x.ai/', desc: 'Elon Musk 旗下 AI，支持 Grok 系列模型' },
  { key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', site: 'https://console.groq.com/keys', desc: '超快推理平台，支持 Llama、Mixtral 等开源模型' },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', site: 'https://openrouter.ai/keys', desc: '模型聚合路由，一个 Key 访问所有主流模型' },
  { key: 'runcrate', label: 'Runcrate', baseUrl: 'https://api.runcrate.ai/v1', api: 'openai-completions', site: 'https://www.runcrate.ai/dashboard/api-keys', desc: 'OpenAI 兼容推理接口，支持 DeepSeek、GLM、Qwen、Kimi 等开源模型' },
  { key: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions', site: 'https://build.nvidia.com/models', desc: '英伟达推理平台，支持 Llama、Mistral 等模型' },
  { key: 'ollama', label: 'Ollama (本地)', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', site: 'https://ollama.com/' },
]

// 胜算云服务商配置
export const SHENGSUANYUN = {
  baseUrl: 'https://router.shengsuanyun.com/api/v1',
  site: 'https://www.shengsuanyun.com/',
  providerKey: 'shengsuanyun',
  brandName: '胜算云',
  api: 'openai-completions',
}

// 常用模型预设（按服务商分组）
export const MODEL_PRESETS = {
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
  runcrate: [
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576 },
    { id: 'zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash', contextWindow: 1048576 },
    { id: 'zai-org/GLM-5.3', name: 'GLM 5.3', contextWindow: 1048576 },
    { id: 'Qwen/Qwen3.8-Flash', name: 'Qwen3.8 Flash', contextWindow: 1000000 },
    { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', contextWindow: 262144 },
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
