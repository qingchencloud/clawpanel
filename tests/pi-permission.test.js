import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { PI_PERMISSION_SOURCE } from '../scripts/pi-permission.js'

test('Pi 工具守卫：目录边界、私有目录、符号链接与逐次确认', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-pi-permission-'))
  try {
    const workspace = path.join(root, 'workspace'), external = path.join(root, 'external'), privateRoot = path.join(workspace, 'agent')
    for (const dir of [workspace, external, privateRoot]) fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(external, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(path.join(root, 'permission.mjs'), PI_PERMISSION_SOURCE)
    fs.writeFileSync(path.join(root, 'probe.mjs'), `
import setup from './permission.mjs'
let handler, asked = 0, confirmed = false
setup({ on: (name, fn) => { if (name === 'tool_call') handler = fn } })
const check = async (toolName, target) => (await handler({ toolName, input: { path: target } }, { ui: { confirm: async () => { asked++; return confirmed } } }))?.block === true
const results = []
results.push(await check('read', 'allowed.txt'))
results.push(await check('read', '../external/data.txt'))
results.push(await check('write', 'linked/new-file.txt'))
results.push(await check('read', 'agent/credentials.json'))
results.push(await check('write', 'disabled.txt'))
process.env.CLAWPANEL_PI_ALLOW_TOOLS = '1'
results.push(await check('write', 'denied.txt'))
confirmed = true
results.push(await check('write', 'confirmed.txt'))
console.log(JSON.stringify({ results, asked }))
`)
    const probe = spawnSync(process.execPath, [path.join(root, 'probe.mjs')], { cwd: workspace, env: { ...process.env, CLAWPANEL_PI_PRIVATE_ROOT: privateRoot, CLAWPANEL_PI_ALLOW_TOOLS: '0' }, windowsHide: true, encoding: 'utf8', timeout: 10000 })
    assert.equal(probe.status, 0, probe.stderr)
    assert.deepEqual(JSON.parse(probe.stdout), { results: [false, true, true, true, true, true, false], asked: 2 })
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
