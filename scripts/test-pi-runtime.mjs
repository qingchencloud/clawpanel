/** CI 固定版本实测：安装受管 Pi，再执行只访问回环模拟模型的协议验收。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PiRuntime } from './pi-runtime.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(project, '.tmp', 'pi-ci')
fs.mkdirSync(path.dirname(root), { recursive: true })
const runtime = new PiRuntime({ root })
try { await runtime.install() } finally { await runtime.dispose() }
const result = spawnSync(process.execPath, ['--test', 'tests/pi-real-runtime.test.js'], {
  cwd: project, windowsHide: true, stdio: 'inherit', timeout: 150000,
  env: { ...process.env, PI_REAL_RUNTIME_ROOT: root },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
