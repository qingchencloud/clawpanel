/**
 * 内核版本与特性门控的单元测试
 *
 * 运行：node --test tests/kernel.test.js
 *
 * 注意：本测试只覆盖 kernel.js 中的 **纯函数**（parseVersion / versionGte / buildSnapshot）。
 * 涉及 wsClient 订阅 / DOM 的状态函数无法在 node 环境直接测试，留给 e2e。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseVersion, versionGte, buildSnapshot } from '../src/lib/kernel.js'
import { FEATURE_CATALOG, KERNEL_FLOOR } from '../src/lib/feature-catalog.js'

// ============================================================================
// parseVersion
// ============================================================================

test('parseVersion handles standard semver', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('0.0.1'), [0, 0, 1])
  assert.deepEqual(parseVersion('2026.5.6'), [2026, 5, 6])
})

test('parseVersion strips -zh / -beta suffix', () => {
  assert.deepEqual(parseVersion('2026.5.6-zh.2'), [2026, 5, 6])
  assert.deepEqual(parseVersion('2026.5.6-beta.1'), [2026, 5, 6])
  assert.deepEqual(parseVersion('1.0.0-rc.1'), [1, 0, 0])
})

test('parseVersion pads short version', () => {
  assert.deepEqual(parseVersion('1'), [1, 0, 0])
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0])
})

test('parseVersion returns null on invalid input', () => {
  assert.equal(parseVersion(null), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion('a.b.c'), null)
})

test('parseVersion only takes first 3 segments', () => {
  assert.deepEqual(parseVersion('1.2.3.4.5'), [1, 2, 3])
})

// ============================================================================
// versionGte
// ============================================================================

test('versionGte returns true for equal versions', () => {
  assert.equal(versionGte('1.0.0', '1.0.0'), true)
  assert.equal(versionGte('2026.5.6', '2026.5.6'), true)
})

test('versionGte returns true for higher major', () => {
  assert.equal(versionGte('2.0.0', '1.99.99'), true)
  assert.equal(versionGte('2026.0.0', '2025.99.99'), true)
})

test('versionGte returns true for higher minor when major equal', () => {
  assert.equal(versionGte('1.5.0', '1.4.99'), true)
  assert.equal(versionGte('2026.5.0', '2026.4.21'), true)
})

test('versionGte returns true for higher patch when major+minor equal', () => {
  assert.equal(versionGte('1.0.5', '1.0.4'), true)
  assert.equal(versionGte('2026.5.6', '2026.5.5'), true)
})

test('versionGte returns false for lower versions', () => {
  assert.equal(versionGte('1.0.0', '2.0.0'), false)
  assert.equal(versionGte('2026.4.9', '2026.5.6'), false)
  assert.equal(versionGte('2026.3.2', '2026.5.6'), false)
})

test('versionGte ignores -zh suffix correctly', () => {
  assert.equal(versionGte('2026.5.6-zh.2', '2026.5.6'), true)
  assert.equal(versionGte('2026.5.6', '2026.5.6-zh.2'), true)
  assert.equal(versionGte('2026.4.9-zh.2', '2026.5.6'), false)
})

test('versionGte returns false when input is unparseable', () => {
  assert.equal(versionGte(null, '1.0.0'), false)
  assert.equal(versionGte('1.0.0', null), false)
  assert.equal(versionGte('foo', 'bar'), false)
})

// ============================================================================
// buildSnapshot
// ============================================================================

test('buildSnapshot constructs correct shape for known engine + version', () => {
  const snap = buildSnapshot('openclaw', '2026.5.6')
  assert.equal(snap.engine, 'openclaw')
  assert.equal(snap.version, '2026.5.6')
  assert.equal(snap.versionBase, '2026.5.6')
  assert.equal(snap.variant, 'official')
  assert.equal(snap.aboveFloor, true)
  assert.equal(snap.floor, KERNEL_FLOOR.openclaw)
  assert.ok(snap.features instanceof Set)
})

test('buildSnapshot detects chinese variant', () => {
  const snap = buildSnapshot('openclaw', '2026.5.6-zh.2')
  assert.equal(snap.variant, 'chinese')
  assert.equal(snap.versionBase, '2026.5.6')
  assert.equal(snap.versionLabel, '2026.5.6 汉化')
})

test('buildSnapshot.features contains 5.6 features for 5.6 kernel', () => {
  const snap = buildSnapshot('openclaw', '2026.5.6')
  assert.ok(snap.features.has('sessions.truncation'),    'sessions.truncation should be enabled on 5.6')
  assert.ok(snap.features.has('agents.runtime'),         'agents.runtime should be enabled on 5.6')
  assert.ok(snap.features.has('memory.statusDeepSplit'), 'memory.statusDeepSplit should be enabled on 5.6')
  assert.ok(snap.features.has('doctor.deepSupervisor'),  'doctor.deepSupervisor should be enabled on 5.6')
})

test('buildSnapshot.features excludes 5.6 features on 4.9 kernel', () => {
  const snap = buildSnapshot('openclaw', '2026.4.9')
  assert.equal(snap.features.has('sessions.truncation'), false, 'sessions.truncation should NOT be enabled on 4.9')
  assert.equal(snap.features.has('agents.runtime'), false,      'agents.runtime should NOT be enabled on 4.9')
  assert.equal(snap.features.has('memory.statusDeepSplit'), false)
  assert.equal(snap.features.has('doctor.deepSupervisor'), false)
})

test('buildSnapshot.aboveFloor is false for kernel below floor', () => {
  const snap = buildSnapshot('openclaw', '2026.2.0')
  assert.equal(snap.aboveFloor, false, '2026.2.0 should be below floor 2026.3.2')
})

test('buildSnapshot.aboveFloor is true at exactly floor', () => {
  const snap = buildSnapshot('openclaw', KERNEL_FLOOR.openclaw)
  assert.equal(snap.aboveFloor, true)
})

test('buildSnapshot returns null version when input is null', () => {
  const snap = buildSnapshot('openclaw', null)
  assert.equal(snap.version, null)
  assert.equal(snap.aboveFloor, false)
  assert.equal(snap.features.size, 0, 'no features enabled when version unknown')
})

test('buildSnapshot.features only includes current engine', () => {
  const snap = buildSnapshot('hermes', '0.13.0')
  // openclaw 特性应该全部被排除
  for (const id of snap.features) {
    const def = FEATURE_CATALOG[id]
    assert.equal(def.engine, 'hermes', `${id} should belong to hermes engine`)
  }
})

test('buildSnapshot edge case: version slightly below 5.6 feature requirement', () => {
  // sessions.truncation requires 2026.5.4
  const at = buildSnapshot('openclaw', '2026.5.4')
  const below = buildSnapshot('openclaw', '2026.5.3')
  assert.equal(at.features.has('sessions.truncation'), true)
  assert.equal(below.features.has('sessions.truncation'), false)
})

test('buildSnapshot.isLatest works against KERNEL_TARGET', () => {
  const at_target = buildSnapshot('openclaw', '2026.5.12')
  const at_target_zh = buildSnapshot('openclaw', '2026.5.12-zh.2')
  const above_target = buildSnapshot('openclaw', '2026.6.0')
  const below_target = buildSnapshot('openclaw', '2026.5.11')
  assert.equal(at_target.isLatest, true)
  assert.equal(at_target_zh.isLatest, true)
  assert.equal(above_target.isLatest, true)
  assert.equal(below_target.isLatest, false)
})

// ============================================================================
// FEATURE_CATALOG sanity
// ============================================================================

test('FEATURE_CATALOG: every entry has engine and minVersion', () => {
  for (const [id, def] of Object.entries(FEATURE_CATALOG)) {
    assert.ok(def.engine, `${id} missing engine`)
    assert.ok(def.minVersion, `${id} missing minVersion`)
    assert.ok(parseVersion(def.minVersion), `${id} has unparseable minVersion: ${def.minVersion}`)
  }
})

test('FEATURE_CATALOG: id format is <area>.<feature> camelCase', () => {
  for (const id of Object.keys(FEATURE_CATALOG)) {
    assert.match(id, /^[a-z]+\.[a-zA-Z0-9]+$/, `${id} should match <area>.<featureCamelCase>`)
  }
})

test('FEATURE_CATALOG: all openclaw features minVersion >= floor', () => {
  for (const [id, def] of Object.entries(FEATURE_CATALOG)) {
    if (def.engine !== 'openclaw') continue
    assert.equal(
      versionGte(def.minVersion, KERNEL_FLOOR.openclaw),
      true,
      `${id} minVersion ${def.minVersion} is below floor ${KERNEL_FLOOR.openclaw}`,
    )
  }
})
