import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

// 此文件仅验证可接入前置，不把源码检查计入真实原生或浏览器验收。
test('官网原生 IPC 入口已注册且统一 API 有平台调用封装', () => {
  assert.ok(/platform_call/.test(read('src-tauri/src/lib.rs')), '缺少真实原生 platform_call 命令注册')
  assert.ok(/platform_call/.test(read('src/lib/tauri-api.js')), '统一 API 缺少官网调用封装')
})

test('官网账户具有可发现的账户页面入口', () => {
  assert.ok(/registerRoute\(['"]\/account['"]/.test(read('src/main.js')), '账户路由尚未实现')
  assert.ok(/data-platform-account|\/account/.test(read('src/components/sidebar.js')), '侧栏缺少账户入口')
})

test('助手不再推广旧 gpt.qt.cool 渠道，用户自有渠道由回归另验', () => {
  assert.doesNotMatch(read('src/pages/assistant.js'), /https?:\/\/gpt\.qt\.cool/, '仍存在旧推广入口')
})
