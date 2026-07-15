import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/engines/hermes/style/hermes.css', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../src/engines/hermes/pages/dashboard.js', import.meta.url), 'utf8')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('Hermes dashboard 图标按钮必须满足移动端触控尺寸', () => {
  const block = cssBlock('[data-engine="hermes"] .hm-btn--icon')
  assert.match(block, /width:\s*44px/, '图标按钮宽度必须至少 44px')
  assert.match(block, /height:\s*44px/, '图标按钮高度必须至少 44px')
  assert.match(block, /min-width:\s*44px/, '图标按钮需要显式保留 44px 最小宽度')
  assert.match(block, /min-height:\s*44px/, '图标按钮需要显式保留 44px 最小高度')
})

test('Hermes dashboard 不展示未默认运行的 9119 外部入口', () => {
  assert.doesNotMatch(dashboard, /<div class="hm-native-dashboard-hint">/)
  assert.doesNotMatch(dashboard, /<button class="hm-native-dashboard-link/)
})

test('Hermes dashboard pill 选择器必须满足移动端触控尺寸', () => {
  const block = cssBlock('[data-engine="hermes"] button.hm-pill')
  assert.match(block, /min-height:\s*44px/, 'pill 选择器高度必须至少 44px')
})
