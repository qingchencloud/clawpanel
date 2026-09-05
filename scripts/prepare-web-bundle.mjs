#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function argValue(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const output = path.resolve(root, argValue('--output', '.tmp/web-bundle'))
const sourceDist = path.resolve(root, argValue('--dist-dir', 'dist'))

if (output === root || !output.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Web bundle 输出目录必须位于项目目录内且不能是项目根目录: ${output}`)
}
if (!sourceDist.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Web bundle 前端目录必须位于项目目录内: ${sourceDist}`)
}
if (!fs.existsSync(path.join(sourceDist, 'index.html'))) {
  throw new Error('缺少 dist/index.html，请先运行 npm run build')
}

fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })

fs.cpSync(sourceDist, path.join(output, 'dist'), { recursive: true })
for (const dir of ['scripts', 'src']) {
  fs.cpSync(path.join(root, dir), path.join(output, dir), { recursive: true })
}
for (const file of [
  'package.json',
  'package-lock.json',
  'openclaw-version-policy.json',
  'LICENSE',
  'README.md',
]) {
  fs.copyFileSync(path.join(root, file), path.join(output, file))
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(output, 'WEB-BUNDLE-README.txt'), [
  `ClawPanel Web ${pkg.version}`,
  '',
  '安装/升级：',
  '1. 解压完整压缩包（不要只复制 dist 目录）。',
  '2. 运行 npm ci --omit=dev。',
  '3. 运行 npm run serve，或重启已有 clawpanel systemd 服务。',
  '4. 打开 /__api/health，确认 backendVersion 与页面版本一致。',
  '',
].join('\n'))

console.log(`[web-bundle] ${pkg.version} -> ${output}`)
