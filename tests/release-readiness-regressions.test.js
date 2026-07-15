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

test('当前待发布版本必须有正式更新日志且保留 Unreleased 入口', () => {
  const pkg = JSON.parse(read('package.json'))
  const changelog = read('CHANGELOG.md')
  const releaseHeading = new RegExp(`^## \\[${pkg.version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm')
  assert.match(changelog, releaseHeading)
  assert.doesNotMatch(changelog, new RegExp(`^## \\[${pkg.version.replaceAll('.', '\\.')} 候选\\]`, 'm'))
  assert.ok(changelog.indexOf('## [未发布 (Unreleased)]') < changelog.search(releaseHeading))
})

test('OpenClaw 7.1 发布与容器基线不低于 Node.js 22.22.3', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'Dockerfile',
    'docker-compose.yml',
    'README.md',
    'docs/docker-deploy.md',
    'docs/linux-deploy.md',
  ]) {
    assert.doesNotMatch(read(file), /node(?:-version:|:)\s*22\.19\.0/i, `${file} 仍引用旧 Node.js 基线`)
  }

  assert.match(read('.github/workflows/ci.yml'), /node-version:\s*22\.22\.3/)
  assert.match(read('.github/workflows/release.yml'), /node-version:\s*22\.22\.3/)
  assert.match(read('Dockerfile'), /FROM node:22\.22\.3-alpine AS production/)
})

test('macOS Gateway 服务操作保留 launchctl 所需的用户 UID helper', () => {
  const config = read('src-tauri/src/commands/config.rs')
  assert.match(config, /fn get_uid\(\) -> Result<u32, String>/)
  assert.match(config, /Command::new\("id"\)[\s\S]*?\.arg\("-u"\)/)
  assert.match(config, /format!\("gui\/\{uid\}\/ai\.openclaw\.gateway"\)/)
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
