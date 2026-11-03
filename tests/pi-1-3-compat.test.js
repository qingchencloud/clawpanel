import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PI_PACKAGE_VERSION } from '../scripts/pi-models.js'
test('Pi 1.3.0 推荐保持离线隔离、受限工具与面板审批桥', () => {
  assert.equal(PI_PACKAGE_VERSION, '1.3.0')
  const source = fs.readFileSync(new URL('../scripts/pi-runtime.js', import.meta.url), 'utf8')
  for (const flag of ['--no-approve', '--offline', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(source.includes(flag), flag)
  assert.ok(source.includes("this.file('permission.mjs')"))
  assert.ok(source.includes("this.agentFile('credentials.json')"))
})
