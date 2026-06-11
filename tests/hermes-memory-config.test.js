import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesMemoryConfigValues,
  mergeHermesMemoryConfig,
} from '../scripts/dev-api.js'

test('Hermes 记忆配置读取会提供上游默认值', () => {
  const values = buildHermesMemoryConfigValues({})

  assert.deepEqual(values, {
    memoryEnabled: true,
    userProfileEnabled: true,
    memoryCharLimit: 2200,
    userCharLimit: 1375,
    nudgeInterval: 10,
    flushMinTurns: 6,
    qmdRerank: true,
  })
})

test('Hermes 记忆配置读取会回显 YAML 中的记忆字段', () => {
  const values = buildHermesMemoryConfigValues({
    memory: {
      memory_enabled: false,
      user_profile_enabled: true,
      memory_char_limit: 3200,
      user_char_limit: 1800,
      nudge_interval: 12,
      flush_min_turns: 8,
      qmd: {
        rerank: false,
      },
    },
  })

  assert.equal(values.memoryEnabled, false)
  assert.equal(values.userProfileEnabled, true)
  assert.equal(values.memoryCharLimit, 3200)
  assert.equal(values.userCharLimit, 1800)
  assert.equal(values.nudgeInterval, 12)
  assert.equal(values.flushMinTurns, 8)
  assert.equal(values.qmdRerank, false)
})

test('Hermes 记忆配置保存会保留无关 YAML 并写入 snake_case 字段', () => {
  const next = mergeHermesMemoryConfig({
    model: { provider: 'anthropic' },
    memory: {
      memory_enabled: true,
      provider: 'honcho',
      custom_flag: 'keep-me',
      flush_min_turns: 9,
      qmd: {
        provider: 'qmd',
        rerank: true,
      },
    },
    streaming: { enabled: true },
  }, {
    memoryEnabled: false,
    userProfileEnabled: false,
    memoryCharLimit: '2600',
    userCharLimit: '1500',
    nudgeInterval: '0',
    flushMinTurns: '7',
    qmdRerank: false,
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.memory.memory_enabled, false)
  assert.equal(next.memory.user_profile_enabled, false)
  assert.equal(next.memory.memory_char_limit, 2600)
  assert.equal(next.memory.user_char_limit, 1500)
  assert.equal(next.memory.nudge_interval, 0)
  assert.equal(next.memory.flush_min_turns, 7)
  assert.equal(next.memory.qmd.rerank, false)
  assert.equal(next.memory.qmd.provider, 'qmd')
  assert.equal(next.memory.provider, 'honcho')
  assert.equal(next.memory.custom_flag, 'keep-me')
})

test('Hermes 记忆配置保存会拒绝越界字符上限和提醒间隔', () => {
  assert.throws(
    () => mergeHermesMemoryConfig({}, { memoryCharLimit: '99' }),
    /memory\.memory_char_limit/,
  )
  assert.throws(
    () => mergeHermesMemoryConfig({}, { userCharLimit: '200001' }),
    /memory\.user_char_limit/,
  )
  assert.throws(
    () => mergeHermesMemoryConfig({}, { nudgeInterval: '-1' }),
    /memory\.nudge_interval/,
  )
  assert.throws(
    () => mergeHermesMemoryConfig({}, { nudgeInterval: '1001' }),
    /memory\.nudge_interval/,
  )
  assert.throws(
    () => mergeHermesMemoryConfig({}, { flushMinTurns: '-1' }),
    /memory\.flush_min_turns/,
  )
  assert.throws(
    () => mergeHermesMemoryConfig({}, { flushMinTurns: '1001' }),
    /memory\.flush_min_turns/,
  )
})
