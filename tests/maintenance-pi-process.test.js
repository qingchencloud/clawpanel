import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { isManagedRenamedPiProcess } from '../scripts/maintenance-pi-process.mjs'
const expected = { parentPid: 23, nodePath: '/usr/local/bin/node', workspace: '/isolated/workspace', agentPath: '/isolated/home/.openclaw/clawpanel/pi/agent' }
const process = { pid: 71, parentPid: 23, command: 'pi   ', executable: expected.nodePath, workspace: expected.workspace, agentPath: expected.agentPath }
test('真实 Linux Pi 改写进程标题后仍须同时绑定父进程、Node、工作区及私有配置', () => {
  assert.equal(isManagedRenamedPiProcess(process, expected), true)
  for (const change of [{ pid: 0 }, { parentPid: 24 }, { command: 'node' }, { command: 'pi evil' }, { executable: '/other/node' }, { workspace: '/other/workspace' }, { agentPath: '/other/agent' }]) {
    assert.equal(isManagedRenamedPiProcess({ ...process, ...change }, expected), false, JSON.stringify(change))
  }
  for (const key of Object.keys(process)) {
    const incomplete = { ...process }; delete incomplete[key]
    assert.equal(isManagedRenamedPiProcess(incomplete, expected), false, key)
  }
})
test('实际运行报告必须记录新增 PID 归属校验器的源码指纹', () => {
  const source = fs.readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('verifierDependencyHashes'))
  assert.ok(source.includes("'scripts/maintenance-pi-process.mjs'"))
})
