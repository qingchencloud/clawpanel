import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'

const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')

function productionFunction(name, next, context) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(next, start)
  assert.ok(start >= 0 && end > start, `实际生产函数 ${name} 未找到`)
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`, context)
}

for (const [name, next, method] of [
  ['spawnOpenclaw', '\nfunction spawnOpenclawSync(', 'spawn'],
  ['spawnOpenclawSync', '\nfunction runOpenclawCaptured(', 'spawnSync'],
]) {
  test(`${name}：未传或显式传 false 时，后台进程仍隐藏窗口且不改变参数环境`, () => {
    const calls = []
    const fn = productionFunction(name, next, {
      openclawProcessSpec: args => ({ command: 'fixture-cli', args }),
      process: { env: { PATH: 'fixture-path', KEEP: 'keep' } },
      [method]: (...args) => { calls.push(args); return 'fixture-child' },
    })
    for (const options of [{}, Object.freeze({ windowsHide: false, timeout: 5000, cwd: 'fixture-cwd', env: { PRIVATE: 'fixture' } })]) {
      const args = Object.freeze(['--version', '带 空格'])
      assert.equal(fn(args, options), 'fixture-child')
      const [command, actualArgs, actualOptions] = calls.at(-1)
      assert.equal(command, 'fixture-cli')
      assert.equal(actualArgs, args)
      assert.equal(actualOptions.windowsHide, true)
      assert.equal(actualOptions.env.KEEP, 'keep')
      if (options.timeout) {
        assert.equal(actualOptions.timeout, options.timeout)
        assert.equal(actualOptions.cwd, options.cwd)
        assert.equal(actualOptions.env.PRIVATE, 'fixture')
        assert.equal(options.windowsHide, false, '不得修改调用方原对象')
      }
    }
  })
}

test('Hermes 安装后台入口：隐藏窗口，保留输出与退出码，不覆盖原超时', async () => {
  let options
  const fn = productionFunction('runHermesInstallCommand', '\n// 判断输出', {
    Promise, setTimeout, clearTimeout,
    spawn(program, args, received) {
      assert.equal(program, 'fixture-installer')
      assert.equal(args[0], '含 空格')
      options = received
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('安装输出'))
        child.stderr.emit('data', Buffer.from('错误详情'))
        child.emit('close', 17)
      })
      return child
    },
  })
  const input = Object.freeze({ windowsHide: false, timeout: 15000, env: { PRIVATE: 'fixture' } })
  const result = await fn('fixture-installer', ['含 空格'], input)
  assert.equal(options.windowsHide, true)
  assert.equal(options.timeout, 15000)
  assert.equal(options.env, input.env)
  assert.equal(JSON.stringify(options.stdio), JSON.stringify(['ignore', 'pipe', 'pipe']))
  assert.equal(result.status, 17)
  assert.equal(result.stdout, '安装输出')
  assert.equal(result.stderr, '错误详情')
})

test('后台 Node 辅助操作：npm 目录查询、依赖安装和备份也不得显示窗口', () => {
  const prefixes = [...source.matchAll(/execSync\('npm config get prefix',\s*\{([^}]+)\}/g)]
  assert.ok(prefixes.length >= 4)
  for (const match of prefixes) assert.match(match[1], /windowsHide:\s*true/)
  const dependency = source.slice(source.indexOf('  skills_install_dep('), source.indexOf('  skills_uninstall('))
  assert.match(dependency, /execSync\(cmd,\s*\{[^}]*windowsHide:\s*true/)
  assert.match(source, /execSync\(`tar -cf[^\n]+windowsHide:\s*true/)
})

// 只运行自有 Node 夹具，不启动内核、安装器或桌面窗口。
test('实际生产启动入口：重复自有子进程的 stdout/stderr/退出码保持完整', async () => {
  const program = `process.stdout.write('完整输出\\n');process.stderr.write('错误输出\\n');process.exitCode=17`
  const spec = () => ({ command: process.execPath, args: ['-e', program] })
  const sync = productionFunction('spawnOpenclawSync', '\nfunction runOpenclawCaptured(', {
    openclawProcessSpec: spec, process: { env: { ...process.env, NODE_OPTIONS: '' } },
    spawnSync(command, args, options) {
      assert.equal(options.windowsHide, true, '确认隐藏选项后才启动真实自有夹具')
      return spawnSync(command, args, options)
    },
  })
  const async = productionFunction('spawnOpenclaw', '\nfunction spawnOpenclawSync(', {
    openclawProcessSpec: spec, process: { env: { ...process.env, NODE_OPTIONS: '' } },
    spawn(command, args, options) {
      assert.equal(options.windowsHide, true, '确认隐藏选项后才启动真实自有夹具')
      return spawn(command, args, options)
    },
  })
  for (let i = 0; i < 3; i++) {
    const result = sync([], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 17)
    assert.equal(result.stdout, '完整输出\n')
    assert.equal(result.stderr, '错误输出\n')
    const child = async([], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 17)
    assert.equal(stdout, '完整输出\n')
    assert.equal(stderr, '错误输出\n')
  }
})
