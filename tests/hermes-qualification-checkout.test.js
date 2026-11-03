import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('资格源相对参数在改用导出目录cwd前固化为绝对路径，真实Git始终读取原checkout', async () => {
  const q = await import('../scripts/test-hermes-windows-qualification.mjs')
  assert.equal(typeof q.resolveQualificationCheckout, 'function')
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-checkout-'))
  const root = path.join(dir, 'candidate'), exported = path.join(dir, 'evidence/source')
  try {
    fs.mkdirSync(root); fs.mkdirSync(exported, { recursive: true })
    const git = (args, cwd = dir) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
    assert.equal(git(['init', root]).status, 0)
    fs.writeFileSync(path.join(root, 'marker.txt'), '真实候选\n')
    assert.equal(git(['-C', root, 'add', 'marker.txt']).status, 0)
    assert.equal(git(['-C', root, '-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', 'commit', '-m', 'fixture']).status, 0)
    const expected = git(['-C', root, 'rev-parse', 'HEAD']).stdout.trim()
    assert.notEqual(git(['-C', 'candidate', 'rev-parse', 'HEAD'], exported).status, 0, '保留真实原失败对照')
    const actual = q.resolveQualificationCheckout('candidate', dir)
    assert.equal(actual, root); assert.ok(path.isAbsolute(actual))
    assert.equal(git(['-C', actual, 'rev-parse', 'HEAD'], exported).stdout.trim(), expected)
    assert.equal(git(['-C', actual, 'show', expected + ':marker.txt'], exported).stdout, '真实候选\n')
    const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')
    assert.match(source, /checkout = resolveQualificationCheckout\(o\['--root'\]\)/)
    assert.doesNotMatch(source, /\['-C', o\['--root'\]/)
    assert.match(source, /within\(physical\(process.env.GITHUB_WORKSPACE\), checkout\)/)
  } finally {
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
