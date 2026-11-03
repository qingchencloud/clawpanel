import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/commands/service.rs'), 'utf8')

test('Windows 启动优先使用 OpenClaw 官方 gateway 服务', () => {
  assert.match(rust, /fn start_service_official\(/)
  assert.match(rust, /"gateway", "status", "--json", "--no-probe"/)
  assert.match(rust, /"gateway", "install", "--json", "--port"/)
  assert.match(rust, /"gateway", "start", "--json"/)
  assert.match(rust, /start_service_official\(port, before_pid\)/)
  assert.match(rust, /\[官方服务启动失败\]/)
})

test('官方服务不可用时保留旧启动回退', () => {
  assert.match(rust, /clawpanel-gateway\.cmd/)
  assert.match(rust, /write_gateway_terminal_runner/)
  assert.match(rust, /gateway_start_log_tail/)
})

test('停止流程优先调用官方服务 stop 并保留 PID 兜底', () => {
  assert.match(rust, /"gateway", "stop", "--json"/)
  assert.match(rust, /kill_process_tree/)
})

test('官方日志路径来自 CLI 状态并复用统一解码', () => {
  assert.match(rust, /fn official_gateway_log_excerpt/)
  assert.match(rust, /super::read_file_excerpt_since/)
  assert.match(rust, /crate::utils::decode_text/)
})
