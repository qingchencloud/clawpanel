import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const lock = fs.readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8')
const packages = lock.split('[[package]]').slice(1).map(block => ({
  name: block.match(/^name = "([^"]+)"/m)?.[1],
  version: block.match(/^version = "([^"]+)"/m)?.[1],
  checksum: block.match(/^checksum = "([a-f0-9]+)"/m)?.[1],
}))

test('实际Cargo锁中的Rustls不落入GHSA-2mjx-qc3c-rqvc加密层边界漏洞区间', () => {
  const versions = packages.filter(pkg => pkg.name === 'rustls')
  assert.equal(versions.length, 1, '只核实际产品锁，不用另外安装的安全库替代')
  const version = versions[0].version.match(/^0\.23\.(\d+)$/)
  assert.ok(version, '其它Rustls分支需要重新审查，不盲目按latest放行')
  assert.ok(Number(version[1]) >= 45, `实际rustls ${versions[0].version}未达到官方首次修复0.23.45`)
  assert.match(versions[0].checksum, /^[a-f0-9]{64}$/)
})
