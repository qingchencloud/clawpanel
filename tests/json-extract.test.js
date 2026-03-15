import test from 'node:test'
import assert from 'node:assert/strict'

import { extractFirstJson } from '../src/lib/json-extract.js'

test('可直接解析纯 JSON 文本', () => {
  assert.deepEqual(extractFirstJson('{"ok":true,"count":2}'), {
    ok: true,
    count: 2,
  })
})

test('可提取前缀 warning 后的 JSON 对象', () => {
  const raw = [
    'npm warn deprecated something',
    'Node.js warning: test',
    '{"skills":[{"name":"github"}],"cliAvailable":true}',
  ].join('\n')

  assert.deepEqual(extractFirstJson(raw), {
    skills: [{ name: 'github' }],
    cliAvailable: true,
  })
})

test('可提取后缀提示前的 JSON 对象', () => {
  const raw = [
    '{"skills":[{"name":"weather"}],"cliAvailable":true}',
    'Update available: openclaw@latest',
  ].join('\n')

  assert.deepEqual(extractFirstJson(raw), {
    skills: [{ name: 'weather' }],
    cliAvailable: true,
  })
})

test('字符串里的花括号和方括号不应干扰边界识别', () => {
  const raw = '{"message":"keep {braces} and [brackets] in string","ok":true}\ntrailing text'

  assert.deepEqual(extractFirstJson(raw), {
    message: 'keep {braces} and [brackets] in string',
    ok: true,
  })
})

test('没有合法 JSON 时返回 null', () => {
  assert.equal(extractFirstJson('npm warn deprecated\nnot json here'), null)
})
