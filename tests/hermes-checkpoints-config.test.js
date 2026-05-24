import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesCheckpointsConfigValues,
  mergeHermesCheckpointsConfig,
} from '../scripts/dev-api.js'

test('Hermes 文件快照回滚配置读取会提供上游默认值', () => {
  const values = buildHermesCheckpointsConfigValues({})

  assert.deepEqual(values, {
    checkpointsEnabled: false,
    checkpointMaxSnapshots: 20,
    checkpointMaxTotalSizeMb: 500,
    checkpointMaxFileSizeMb: 10,
    checkpointAutoPrune: true,
    checkpointRetentionDays: 7,
    checkpointDeleteOrphans: true,
    checkpointMinIntervalHours: 24,
  })
})

test('Hermes 文件快照回滚配置读取会回显 YAML 字段', () => {
  const values = buildHermesCheckpointsConfigValues({
    checkpoints: {
      enabled: true,
      max_snapshots: 12,
      max_total_size_mb: 900,
      max_file_size_mb: 25,
      auto_prune: false,
      retention_days: 14,
      delete_orphans: false,
      min_interval_hours: 6,
    },
  })

  assert.equal(values.checkpointsEnabled, true)
  assert.equal(values.checkpointMaxSnapshots, 12)
  assert.equal(values.checkpointMaxTotalSizeMb, 900)
  assert.equal(values.checkpointMaxFileSizeMb, 25)
  assert.equal(values.checkpointAutoPrune, false)
  assert.equal(values.checkpointRetentionDays, 14)
  assert.equal(values.checkpointDeleteOrphans, false)
  assert.equal(values.checkpointMinIntervalHours, 6)
})

test('Hermes 文件快照回滚配置保存会保留未知字段并写入 checkpoints', () => {
  const next = mergeHermesCheckpointsConfig({
    model: { provider: 'anthropic' },
    checkpoints: {
      enabled: true,
      custom_flag: 'keep-checkpoints',
    },
    streaming: { enabled: true },
  }, {
    checkpointsEnabled: false,
    checkpointMaxSnapshots: '30',
    checkpointMaxTotalSizeMb: '0',
    checkpointMaxFileSizeMb: '0',
    checkpointAutoPrune: true,
    checkpointRetentionDays: '21',
    checkpointDeleteOrphans: true,
    checkpointMinIntervalHours: '12',
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.checkpoints.enabled, false)
  assert.equal(next.checkpoints.max_snapshots, 30)
  assert.equal(next.checkpoints.max_total_size_mb, 0)
  assert.equal(next.checkpoints.max_file_size_mb, 0)
  assert.equal(next.checkpoints.auto_prune, true)
  assert.equal(next.checkpoints.retention_days, 21)
  assert.equal(next.checkpoints.delete_orphans, true)
  assert.equal(next.checkpoints.min_interval_hours, 12)
  assert.equal(next.checkpoints.custom_flag, 'keep-checkpoints')
})

test('Hermes 文件快照回滚配置保存会拒绝越界值', () => {
  assert.throws(
    () => mergeHermesCheckpointsConfig({}, { checkpointMaxSnapshots: '0' }),
    /checkpoints\.max_snapshots/,
  )
  assert.throws(
    () => mergeHermesCheckpointsConfig({}, { checkpointMaxTotalSizeMb: '-1' }),
    /checkpoints\.max_total_size_mb/,
  )
  assert.throws(
    () => mergeHermesCheckpointsConfig({}, { checkpointMaxFileSizeMb: '-1' }),
    /checkpoints\.max_file_size_mb/,
  )
  assert.throws(
    () => mergeHermesCheckpointsConfig({}, { checkpointRetentionDays: '0' }),
    /checkpoints\.retention_days/,
  )
  assert.throws(
    () => mergeHermesCheckpointsConfig({}, { checkpointMinIntervalHours: '-1' }),
    /checkpoints\.min_interval_hours/,
  )
})
