import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const script = read('scripts/linux-deploy.sh')
const readme = read('README.md')
const linuxGuide = read('docs/linux-deploy.md')

test('Linux Web 升级失败必须中止并保留完整 Git 错误', () => {
  assert.doesNotMatch(script, /git pull origin main 2>\/dev\/null \|\| true/)
  assert.match(script, /git pull --ff-only origin main/)
  assert.match(script, /源码更新失败/)
})

test('Linux Web 升级必须识别已有 systemd 工作目录并阻止权限模式错位', () => {
  assert.match(script, /select_install_context\(\)/)
  assert.match(script, /systemctl show clawpanel[^\n]*WorkingDirectory/)
  assert.match(script, /检测到系统级 ClawPanel 安装/)
  assert.match(script, /curl -fsSL[^\n]*\| sudo bash/)
})

test('Linux Web 构建后必须重启已有服务并输出实际版本', () => {
  assert.match(script, /systemctl restart clawpanel/)
  assert.match(script, /systemctl --user restart clawpanel/)
  assert.doesNotMatch(script, /systemctl start clawpanel/)
  assert.doesNotMatch(script, /systemctl --user start clawpanel/)
  assert.match(script, /ClawPanel 版本:.*PANEL_VERSION/)
})

test('Linux Web 升级文档必须区分 system 与 user 服务并提供可诊断命令', () => {
  for (const [name, content] of [
    ['README.md', readme],
    ['docs/linux-deploy.md', linuxGuide],
  ]) {
    assert.match(content, /curl -fsSL[^\n]*\| sudo bash/, `${name} 缺少系统级升级命令`)
    assert.match(content, /git pull --ff-only origin main/, `${name} 仍使用不可诊断的 git pull`)
    assert.match(content, /node -p [^\n]*package\.json/, `${name} 缺少升级后版本核验`)
  }
})
