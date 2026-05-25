import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/engines/hermes/style/hermes.css', import.meta.url), 'utf8')

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

test('Hermes dashboard 原生面板入口必须满足移动端触控尺寸', () => {
  const block = cssBlock('[data-engine="hermes"] button.hm-native-dashboard-link')
  assert.match(block, /min-width:\s*44px/, '原生 Dashboard 入口宽度必须至少 44px')
  assert.match(block, /min-height:\s*44px/, '原生 Dashboard 入口高度必须至少 44px')
  assert.match(block, /inline-flex/, '原生 Dashboard 入口需要扩展可点区域并居中内容')
})

test('Hermes dashboard pill 选择器必须满足移动端触控尺寸', () => {
  const block = cssBlock('[data-engine="hermes"] button.hm-pill')
  assert.match(block, /min-height:\s*44px/, 'pill 选择器高度必须至少 44px')
})
