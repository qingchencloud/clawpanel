import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('Web 发布同时生成完整服务端包与独立前端热更新包', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(workflow, /frontend-hot-update-\$\{VERSION\}\.zip/)
  assert.match(workflow, /web-\$\{VERSION\}\.zip/)
  assert.match(workflow, /node scripts\/prepare-web-bundle\.mjs/)
  assert.match(workflow, /完整 Web 服务端包/)
  assert.match(workflow, /仅供 ClawPanel 桌面端热更新/)
  assert.match(workflow, /DL_URL=.*frontend-hot-update-\$\{VERSION\}\.zip/)
})

test('完整 Web 服务端包包含运行后端和版本核验所需文件', () => {
  const temp = mkdtempSync(path.join(root, '.tmp-web-bundle-test-'))
  try {
    const sourceDist = path.join(temp, 'fixture-dist')
    const output = path.join(temp, 'output')
    mkdirSync(sourceDist, { recursive: true })
    writeFileSync(path.join(sourceDist, 'index.html'), '<!doctype html><title>fixture</title>')

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/prepare-web-bundle.mjs'),
      '--output',
      path.relative(root, output),
      '--dist-dir',
      path.relative(root, sourceDist),
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)

    for (const file of [
      'dist/index.html',
      'scripts/serve.js',
      'scripts/dev-api.js',
      'scripts/gateway-ws-proxy.js',
      'src/lib/openclaw-gateway-compat.js',
      'package.json',
      'package-lock.json',
      'openclaw-version-policy.json',
      'WEB-BUNDLE-README.txt',
    ]) {
      assert.ok(statSync(path.join(output, file)).isFile(), `${file} 未打入完整 Web 包`)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Web 健康检查暴露后端版本和 API 契约版本', () => {
  const backend = readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const frontend = readFileSync(path.join(root, 'src/lib/tauri-api.js'), 'utf8')
  assert.match(backend, /backendVersion:\s*PANEL_VERSION/)
  assert.match(backend, /apiContractVersion:\s*1/)
  assert.match(frontend, /data\?\.backendVersion === APP_VERSION/)
  assert.match(frontend, /data\?\.apiContractVersion === 1/)
})
