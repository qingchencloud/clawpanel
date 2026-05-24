import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesHumanDelayConfigValues,
  mergeHermesHumanDelayConfig,
} from '../scripts/dev-api.js'

test('Hermes 响应节奏配置读取会提供上游默认值', () => {
  const values = buildHermesHumanDelayConfigValues({})

  assert.deepEqual(values, {
    humanDelayMode: 'off',
    humanDelayMinMs: 800,
    humanDelayMaxMs: 2500,
  })
})

test('Hermes 响应节奏配置读取会规范化已有字段', () => {
  const values = buildHermesHumanDelayConfigValues({
    human_delay: {
      mode: 'CUSTOM',
      min_ms: 1200,
      max_ms: 3600,
    },
  })

  assert.equal(values.humanDelayMode, 'custom')
  assert.equal(values.humanDelayMinMs, 1200)
  assert.equal(values.humanDelayMaxMs, 3600)
})

test('Hermes 响应节奏配置保存会保留无关 YAML 并写入 human_delay', () => {
  const next = mergeHermesHumanDelayConfig({
    model: { provider: 'anthropic' },
    human_delay: { mode: 'off', custom_flag: 'keep-delay' },
    streaming: { enabled: true },
  }, {
    humanDelayMode: 'custom',
    humanDelayMinMs: '900',
    humanDelayMaxMs: '2400',
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.human_delay.custom_flag, 'keep-delay')
  assert.equal(next.human_delay.mode, 'custom')
  assert.equal(next.human_delay.min_ms, 900)
  assert.equal(next.human_delay.max_ms, 2400)
})

test('Hermes 响应节奏配置保存会拒绝非法模式和反向范围', () => {
  assert.throws(
    () => mergeHermesHumanDelayConfig({}, { humanDelayMode: 'slow' }),
    /human_delay\.mode/,
  )
  assert.throws(
    () => mergeHermesHumanDelayConfig({}, {
      humanDelayMode: 'custom',
      humanDelayMinMs: 3000,
      humanDelayMaxMs: 1000,
    }),
    /human_delay\.max_ms/,
  )
})
