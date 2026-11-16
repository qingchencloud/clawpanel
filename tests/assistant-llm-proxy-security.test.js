import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

// SSRF 防护与助手 LLM 授权代理（CORS 修复）
import { assertPublicHttpUrl, isPrivateIp, isPrivateIpv4, isPrivateIpv6 } from '../scripts/dev-api.js'

test('内网 IPv4 地址全部被识别（SSRF 防护）', () => {
  for (const ip of [
    '127.0.0.1', '127.8.8.8',            // loopback
    '10.0.0.1', '10.255.255.255',        // 10/8
    '172.16.0.1', '172.31.255.255',      // 172.16/12
    '192.168.1.1',                       // 192.168/16
    '169.254.169.254',                   // 云元数据（AWS/GCP 链路本地）
    '0.0.0.0', '0.1.2.3',                // 未指定地址
    '100.64.0.1', '100.127.255.255',     // CGNAT（Tailscale 等 100.64/10）
    '192.0.0.1',                         // IETF 协议保留
    '198.18.0.1', '198.19.255.255',      // 基准测试保留
    '224.0.0.1', '239.255.255.255',      // 组播
    '240.0.0.1', '255.255.255.255',      // 保留/广播
  ]) {
    assert.equal(isPrivateIpv4(ip), true, `${ip} 应识别为内网/保留地址`)
  }
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '104.18.32.7',
    '172.15.255.255',                    // 172.16/12 之外
    '172.32.0.1',                        // 172.16/12 之外
    '100.63.255.255', '100.128.0.1',     // CGNAT 范围之外
    '198.20.0.1',                        // 198.18/15 之外
    '223.255.255.1',                     // 组播之前最后一个可用段
  ]) {
    assert.equal(isPrivateIpv4(ip), false, `${ip} 是公网地址`)
  }
})

test('内网 IPv6 地址全部被识别（SSRF 防护）', () => {
  for (const ip of [
    '::1', '::',                         // loopback / 未指定
    'fc00::1', 'fd12:3456:789a::1',      // fc00::/7 唯一本地
    'fe80::1', 'febf::1',                // fe80::/10 链路本地
    '::ffff:127.0.0.1',                  // IPv4-mapped loopback
    '::ffff:169.254.169.254',            // IPv4-mapped 元数据地址
  ]) {
    assert.equal(isPrivateIpv6(ip), true, `${ip} 应识别为内网地址`)
  }
  for (const ip of ['2606:4700::1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIpv6(ip), false, `${ip} 是公网地址`)
  }
})

test('isPrivateIp 同时接受 IPv4/IPv6', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true)
  assert.equal(isPrivateIp('::1'), true)
  assert.equal(isPrivateIp('8.8.8.8'), false)
})

test('assertPublicHttpUrl 拒绝非 http(s) 协议', async () => {
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /不支持的协议/)
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com/v1'), /不支持的协议/)
  await assert.rejects(() => assertPublicHttpUrl('gopher://example.com'), /不支持的协议/)
})

test('assertPublicHttpUrl 拒绝环回与内网字面量 IP', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1:11434/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://10.0.0.5/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.1.10/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://172.16.0.9/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://[::1]:11434/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://[fe80::1]/v1'), /内网地址/)
  await assert.rejects(() => assertPublicHttpUrl('http://0.0.0.0/v1'), /内网地址/)
})

test('assertPublicHttpUrl 拒绝 localhost 与内网域名后缀', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://localhost:11434/v1'), /内网主机/)
  await assert.rejects(() => assertPublicHttpUrl('http://api.localhost/v1'), /内网主机/)
  await assert.rejects(() => assertPublicHttpUrl('http://panel.internal/v1'), /内网主机/)
  await assert.rejects(() => assertPublicHttpUrl('http://printer.local/v1'), /内网主机/)
})

test('assertPublicHttpUrl 放行公网 URL 并保留查询串', async () => {
  const ok = await assertPublicHttpUrl('https://api.openai.com/v1/chat/completions?x=1')
  assert.equal(ok, 'https://api.openai.com/v1/chat/completions?x=1')
  const gemini = await assertPublicHttpUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?alt=sse')
  assert.match(gemini, /alt=sse/)
})

test('assertPublicHttpUrl 拒绝解析到内网地址的域名（DNS rebinding 防护）', async () => {
  // 专用测试主机名，在公共 DNS 中解析到 127.0.0.1（RFC 8305 / DNS rebinding 教科书案例）
  await assert.rejects(
    () => assertPublicHttpUrl('http://127-0-0-1.nip.io/v1'),
    err => /内网地址|解析失败/.test(err.message),
    'nip.io 通配解析到 127.0.0.1 必须被拦截（离线环境允许解析失败报错）',
  )
})

test('assertPublicHttpUrl 拒绝无法解析的域名', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://this-domain-definitely-does-not-exist-clawpanel-ssrf-test.invalid/v1'),
    /域名解析失败|内网地址/,
  )
})

test('公网字面量 IP URL 放行', async () => {
  const ok = await assertPublicHttpUrl('https://8.8.8.8/v1')
  assert.equal(ok, 'https://8.8.8.8/v1')
})
