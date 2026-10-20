import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const web = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
const body = web.match(/(?:async )?function runHermesVersionSilent\(\) \{[^]*?\n\}/)?.[0]

function probe(run) {
  assert.ok(body, '生产版本探针必须存在')
  return new Function('runHermesSilent', `${body}\nreturn runHermesVersionSilent()`)(run)
}

test('已有 --version 的内核只调用快速入口，不先进入完整 CLI 启动', async () => {
  const calls = []
  const result = await probe((program, args) => {
    calls.push([program, ...args])
    assert.deepEqual(args, ['--version'])
    return { ok: true, stdout: 'Hermes Agent v0.21.5' }
  })
  assert.deepEqual(calls, [['hermes', '--version']])
  assert.equal(result.stdout, 'Hermes Agent v0.21.5')
})

test('仅旧 version 子命令可用时仍保留一次兼容回退', async () => {
  const calls = []
  const result = await probe((_program, args) => {
    calls.push(args)
    return args[0] === '--version'
      ? { ok: false, stderr: 'unknown option' }
      : { ok: true, stdout: 'legacy Hermes' }
  })
  assert.deepEqual(calls, [['--version'], ['version']])
  assert.equal(result.stdout, 'legacy Hermes')
})

test('两种入口失败时传播实际错误，不伪造已安装', async () => {
  const calls = []
  const result = await probe((_program, args) => {
    calls.push(args)
    return { ok: false, stderr: args[0] + ' failed' }
  })
  assert.deepEqual(calls, [['--version'], ['version']])
  assert.deepEqual(result, { ok: false, stderr: 'version failed' })
})

test('Rust 与 Web 的快速入口及回退顺序一致', async () => {
  const rustBody = rust.match(/fn hermes_version_at_path\(path: &str\)[^]*?\n\}/)?.[0]
  assert.match(rustBody || '', /run_at_path\("hermes", &\["--version"\], path\)[\s\S]*\.or_else\(\|_\| run_at_path\("hermes", &\["version"\], path\)\)/)
})
