import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/engines/hermes/pages/chat.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/engines/hermes/style/hermes.css', import.meta.url), 'utf8')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('Hermes 聊天页健康提示使用 svgIcon 时必须导入图标工具', () => {
  assert.match(source, /svgIcon\('alert-triangle'/, '缺少健康提示图标渲染')
  assert.match(
    source,
    /import\s+\{\s*svgIcon\s*\}\s+from\s+['"]\.\.\/lib\/svg-icons\.js['"]/,
    'chat.js 使用 svgIcon 前必须导入 Hermes 图标工具',
  )
})

test('Hermes 聊天页健康提示操作入口必须满足移动端触控尺寸', () => {
  const block = cssBlock('[data-engine="hermes"] .hm-chat-health-action')
  assert.match(block, /min-height:\s*44px/, '健康提示操作入口高度必须至少 44px')
  assert.match(block, /min-width:\s*44px/, '健康提示操作入口宽度必须至少 44px')
})

test('输入正文轻量更新发送按钮，不依赖整体重绘或健康轮询', () => {
 assert.match(source,/function updateSendButton\(\)/)
 const start=source.indexOf("input.addEventListener('input'")
 assert.ok(start>=0);assert.match(source.slice(start,source.indexOf("el.querySelector('#hm-chat-send')",start)),/updateSendButton\(\)/)
})
