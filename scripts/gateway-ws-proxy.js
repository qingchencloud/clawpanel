/**
 * ClawPanel Web 到本机 Gateway 的 WebSocket 代理头策略。
 *
 * 浏览器访问远程 Web 面板时会携带面板的公网/局域网 Origin。OpenClaw
 * 2026.8.1 会严格校验 Control UI Origin，直接透传会在 connect 阶段返回
 * CONTROL_UI_ORIGIN_NOT_ALLOWED。这里把受 ClawPanel 认证保护的代理请求
 * 规范化为本机来源，避免要求用户把每个访问地址写入 OpenClaw 配置。
 */

export const GATEWAY_LOOPBACK_ORIGIN = 'http://localhost'

function cleanHeaderValue(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  return text.replace(/[\r\n]+/g, ' ').trim()
}

export function gatewayWebSocketUpstreamHeaders(inputHeaders = {}, gatewayPort = 18789) {
  const headers = {}
  for (const [name, value] of Object.entries(inputHeaders || {})) {
    const key = String(name).toLowerCase()
    if (key === 'host' || key === 'origin') continue
    const cleaned = cleanHeaderValue(value)
    if (cleaned) headers[key] = cleaned
  }

  headers.host = `127.0.0.1:${gatewayPort}`
  headers.origin = GATEWAY_LOOPBACK_ORIGIN
  return headers
}

export function serializeGatewayWebSocketHeaders(inputHeaders = {}, gatewayPort = 18789) {
  return Object.entries(gatewayWebSocketUpstreamHeaders(inputHeaders, gatewayPort))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')
}
