import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 晴辰助手 LLM 请求通道契约：Web 模式必须走服务端授权代理修复 CORS，Tauri 模式保持直连。
const source = readFileSync(new URL('../src/pages/assistant.js', import.meta.url), 'utf8')

test('助手 LLM 请求统一走服务端授权代理通道（Web 模式 CORS 修复）', () => {
  assert.match(source, /function useProxyTransport\(/, '必须定义 useProxyTransport 传输选择器')
  assert.match(source, /async function proxyFetch\(/, '必须定义 proxyFetch 代理通道')
  assert.match(source, /\/__api\/assistant_llm_proxy/, '代理端点必须是 /__api/assistant_llm_proxy')
})

test('Tauri 模式保持浏览器/Tauri 直连，不被代理劫持', () => {
  // useProxyTransport 依赖 isTauriRuntime 判断
  assert.match(source, /useProxyTransport[\s\S]{0,200}isTauriRuntime/, 'useProxyTransport 必须判断 Tauri 运行时')
  // 直连分支保留：每个调用点都有 fetch 直连 fallback
  const directBranches = source.match(/: fetch\(/g) || []
  assert.ok(directBranches.length >= 5, `至少 5 个直连 fallback 分支（实测 ${directBranches.length}）`)
})

test('本地服务（Ollama 等 localhost）不走代理', () => {
  assert.match(source, /function isLocalBaseUrl\(/, '必须定义 isLocalBaseUrl')
  assert.match(source, /host === 'localhost' \|\| host === '127\.0\.0\.1'/, 'localhost/127.0.0.1 必须识别为本地')
  assert.match(source, /return !isTauriRuntime\(\) && !isLocalBaseUrl\(baseUrl\)/, '代理条件 = 非Tauri 且 非本地')
})

test('所有 LLM API 调用点都接入代理选择器（useProxyTransport）', () => {
  // callChatCompletions / callResponsesAPI / callAnthropicMessages / callGeminiGenerate
  // + callAIWithTools 的 Anthropic/Gemini/OpenAI 分支 = 6 个调用点
  const count = (source.match(/useProxyTransport\(/g) || []).length
  // 1 定义 + 1 内部引用（isLocalBaseUrl 条件里） + 6 调用点 = 8
  assert.ok(count >= 8, `useProxyTransport 引用应 ≥8 处（实测 ${count}）`)
  for (const endpoint of ['/chat/completions', '/responses', '/messages', 'streamGenerateContent', ':generateContent']) {
    assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `端点 ${endpoint} 必须存在`)
  }
})

test('代理请求携带凭据参数由后端注入（浏览器不携带明文 Authorization 到代理）', () => {
  // proxyFetch 的 payload 组装：apiKey/apiType 由后端解析
  assert.match(source, /apiKey: options\.apiKey \|\| ''/, 'proxyFetch payload 必须携带 apiKey')
  assert.match(source, /apiType: options\.apiType \|\| ''/, 'proxyFetch payload 必须携带 apiType')
})

test('代理与直连共用 SSE 解析和取消信号（不改变流式行为）', () => {
  assert.match(source, /readSSEStream\(resp/, 'SSE 解析入口保持不变')
  assert.match(source, /signal: _abortController\.signal/, '所有请求必须绑定取消信号')
  assert.match(source, /async function readSSEStream\(/, 'SSE 流读取器保留')
})

test('代理自身错误（400/401/502）转换为可见异常而非空气泡', () => {
  assert.match(source, /代理请求失败: HTTP/, '代理 HTTP 错误必须抛出可读异常')
  assert.match(source, /data\?\.error\) throw new Error\(data\.error\)/, '后端 JSON 错误必须透传给用户')
})

test('调试信息记录传输通道（server-proxy / direct）', () => {
  assert.match(source, /transport: useProxyTransport\(base\) \? 'server-proxy' : 'direct'/, '调试面板必须展示实际传输通道')
})

test('fetchWithRetry 兼容工厂函数签名（每次重试重新发请求）', () => {
  assert.match(source, /async function fetchWithRetry\(makeRequest/, '签名改为工厂函数')
  assert.match(source, /const resp = await makeRequest\(\)/, '重试时调用工厂函数')
  // 兼容旧调用（字符串 url）
  assert.match(source, /typeof makeRequest === 'string'/, '保留字符串 URL 兼容分支')
})
