import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as backend from '../scripts/dev-api.js'

test('微信host只读探针识别真实npm物理入口，并保留standalone优先级/坏manifest拒绝', t => {
  assert.equal(typeof backend.readWeixinHostVersion, 'function')
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'weixin-host-manifest-'))
  t.after(() => {assert.equal(path.dirname(fs.realpathSync(root)),base);fs.rmSync(root,{recursive:true,force:true})})
  const fixture = (name, version, pkgName=name) => {
    const dir=path.join(root, name.replaceAll('/','-').replaceAll('@','')+String(version).replace(/[^\w.-]/g,''), 'node_modules', name)
    fs.mkdirSync(dir,{recursive:true})
    const cli=path.join(dir,'openclaw.mjs');fs.writeFileSync(cli,'// 不执行：真实 npm CLI 物理入口布局\n')
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:pkgName,version}))
    return cli
  }
  assert.equal(backend.readWeixinHostVersion(fixture('openclaw','2026.9.8')),'2026.9.8')
  assert.equal(backend.readWeixinHostVersion(fixture('@qingchencloud/openclaw-zh','2026.10.4-zh.1')),'2026.10.4-zh.1')
  assert.equal(backend.readWeixinHostVersion(fixture('openclaw','2026.10.4-beta.1')),'2026.10.4-beta.1', '读取原metadata，稳定性由共享兼容策略判定')
  const cli=fixture('openclaw','2026.9.4');fs.writeFileSync(path.join(path.dirname(cli),'VERSION'),'openclaw_version=2026.5.12\n')
  assert.equal(backend.readWeixinHostVersion(cli),'2026.5.12')
  assert.equal(backend.readWeixinHostVersion(fixture('openclaw','2026.9.8','unrelated-package')),null)
  for(const version of [null,{},'garbage','2026.9.8\npoison']) assert.equal(backend.readWeixinHostVersion(fixture('openclaw',version)),null)
  const bad=fixture('openclaw','corrupt');fs.writeFileSync(path.join(path.dirname(bad),'package.json'),'{bad')
  assert.equal(backend.readWeixinHostVersion(bad),null)
  assert.equal(backend.readWeixinHostVersion(path.join(root,'not-installed')),null)
})
