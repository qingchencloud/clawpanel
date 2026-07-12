import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('移动端页面为全局 AI FAB 预留底部滚动空间', () => {
  const css = read('src/style/layout.css')
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.page\s*\{[\s\S]*padding-bottom:\s*(?:8[0-9]|9[0-9]|1\d\d)px/)
  const hermesCss = read('src/engines/hermes/style/hermes.css')
  assert.match(hermesCss, /@media\s*\(max-width:\s*480px\)[\s\S]*\[data-engine="hermes"\]\.page\s*\{[\s\S]*padding:\s*20px\s+16px\s+96px/)
})

test('Vite 使用修复开发服务器漏洞的 6.4.3 或更高 6.x 版本', () => {
  const pkg = JSON.parse(read('package.json'))
  const match = String(pkg.devDependencies?.vite || '').match(/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(match)
  const [, major, minor, patch] = match.map(Number)
  assert.equal(major, 6)
  assert.ok(minor > 4 || (minor === 4 && patch >= 3))
})

test('未打标签前 0.18.6 不伪装成已发布版本', () => {
  const changelog = read('CHANGELOG.md')
  assert.doesNotMatch(changelog, /^## \[0\.18\.6\] - \d{4}-\d{2}-\d{2}$/m)
  assert.match(changelog, /^## \[0\.18\.6 候选\] - 尚未发布$/m)
})

test('Hermes Rust 与 Web 关键 Provider 注册表保持一致', () => {
  const rust = read('src-tauri/src/commands/hermes_providers.rs')
  const web = read('scripts/dev-api.js')
  for (const model of ['glm-5.2', 'kimi-k2.7-code']) {
    assert.match(rust, new RegExp(`"${model.replace('.', '\\.') }"`))
    assert.match(web, new RegExp(`'${model.replace('.', '\\.') }'`))
  }
  assert.match(rust, /id:\s*"alibaba",[\s\S]*?name:\s*"Qwen Cloud"/)
  assert.match(web, /hermesProvider\('alibaba',\s*'Qwen Cloud'/)
})

test('Hermes 配置事务的私密权限标记可跨平台编译', () => {
  const rust = read('src-tauri/src/commands/hermes.rs')
  assert.match(rust, /for \(file, content, private\) in entries/)
  assert.match(rust, /#\[cfg\(unix\)\][\s\S]*?if \*private/)
  assert.match(rust, /#\[cfg\(not\(unix\)\)\][\s\S]*?let _ = private;/)
})
