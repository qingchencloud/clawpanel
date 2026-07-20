import test from 'node:test'
import assert from 'node:assert/strict'

import * as presets from '../src/lib/model-presets.js'

const { API_TYPES, PROVIDER_PRESETS, MODEL_PRESETS } = presets

test('OpenClaw 7.1 API 类型与上游契约一致', () => {
  assert.deepEqual(API_TYPES.map(item => item.value), [
    'openai-completions',
    'openai-responses',
    'openai-chatgpt-responses',
    'anthropic-messages',
    'google-generative-ai',
    'google-vertex',
    'github-copilot',
    'bedrock-converse-stream',
    'ollama',
    'azure-openai-responses',
  ])
})

test('旧 Codex Responses API 类型迁移到 7.1 正式名称', () => {
  assert.equal(typeof presets.normalizeModelApiType, 'function')
  assert.equal(presets.normalizeModelApiType('openai-codex-responses'), 'openai-chatgpt-responses')
  assert.equal(presets.normalizeModelApiType('openai-responses'), 'openai-responses')
  assert.equal(presets.normalizeModelApiType('future-adapter'), 'future-adapter')
})

test('编辑未知 OpenClaw API 类型时保留原值供用户选择', () => {
  const options = presets.modelApiTypeOptions('future-adapter')
  assert.equal(options[0].value, 'future-adapter')
  assert.equal(options.filter(item => item.value === 'future-adapter').length, 1)
  assert.ok(options.some(item => item.value === 'openai-completions'))
})

// ===== Provider Presets =====

test('PROVIDER_PRESETS contains MiniMax entry', () => {
  const minimax = PROVIDER_PRESETS.find(p => p.key === 'minimax')
  assert.ok(minimax, 'MiniMax provider preset should exist')
  assert.equal(minimax.label, 'MiniMax')
  assert.equal(minimax.api, 'openai-completions')
})

test('MiniMax provider preset uses correct API base URL', () => {
  const minimax = PROVIDER_PRESETS.find(p => p.key === 'minimax')
  assert.equal(minimax.baseUrl, 'https://api.minimax.io/v1')
})

test('MiniMax provider preset has site and description', () => {
  const minimax = PROVIDER_PRESETS.find(p => p.key === 'minimax')
  assert.equal(minimax.site, 'https://platform.minimax.io/docs/api-reference/api-overview')
  assert.ok(minimax.desc, 'MiniMax should have a description')
})

test('all provider presets have required fields', () => {
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.key, `preset missing key`)
    assert.ok(p.label, `preset ${p.key} missing label`)
    assert.ok(p.baseUrl, `preset ${p.key} missing baseUrl`)
    assert.ok(p.api, `preset ${p.key} missing api type`)
    const valid = API_TYPES.map(t => t.value)
    assert.ok(valid.includes(p.api), `preset ${p.key} has invalid api type: ${p.api}`)
  }
})

test('no duplicate provider preset keys', () => {
  const keys = PROVIDER_PRESETS.map(p => p.key)
  const unique = new Set(keys)
  assert.equal(keys.length, unique.size, 'provider preset keys must be unique')
})

// ===== Model Presets =====

test('MODEL_PRESETS contains MiniMax models', () => {
  assert.ok(MODEL_PRESETS.minimax, 'MODEL_PRESETS should have a minimax key')
  assert.ok(Array.isArray(MODEL_PRESETS.minimax), 'minimax presets should be an array')
  assert.ok(MODEL_PRESETS.minimax.length >= 2, 'should have at least 2 MiniMax models')
})

test('MiniMax model presets include M3 and M2.7 variants', () => {
  const ids = MODEL_PRESETS.minimax.map(m => m.id)
  assert.ok(ids.includes('MiniMax-M3'), 'should include MiniMax-M3')
  assert.ok(ids.includes('MiniMax-M2.7'), 'should include MiniMax-M2.7')
  assert.ok(ids.includes('MiniMax-M2.7-highspeed'), 'should include MiniMax-M2.7-highspeed')
})

test('MiniMax M3 is listed as the new default (first entry)', () => {
  assert.equal(MODEL_PRESETS.minimax[0].id, 'MiniMax-M3', 'MiniMax-M3 should be the first model')
})

test('MiniMax model presets have required fields', () => {
  for (const m of MODEL_PRESETS.minimax) {
    assert.ok(m.id, `model missing id`)
    assert.ok(m.name, `model ${m.id} missing name`)
    assert.ok(typeof m.contextWindow === 'number' && m.contextWindow > 0,
      `model ${m.id} should have a positive contextWindow`)
  }
})

test('MiniMax models use current context windows and metadata', () => {
  const m27 = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M2.7')
  assert.equal(m27.contextWindow, 204800)
  assert.deepEqual(m27.input, ['text'])
  assert.deepEqual(m27.cost, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 })
  const m3 = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M3')
  assert.equal(m3.contextWindow, 1000000)
  assert.deepEqual(m3.input, ['text', 'image', 'video'])
  assert.deepEqual(m3.cost, { input: 0.6, output: 2.4, cacheRead: 0.12 })
})

test('all model preset groups have valid structure', () => {
  for (const [group, models] of Object.entries(MODEL_PRESETS)) {
    assert.ok(Array.isArray(models), `${group} should be an array`)
    for (const m of models) {
      assert.ok(m.id, `model in ${group} missing id`)
      assert.ok(m.name, `model ${m.id} in ${group} missing name`)
    }
  }
})

// ===== Integration: Provider ↔ Model Presets alignment =====

test('each MODEL_PRESETS group has a matching PROVIDER_PRESETS entry', () => {
  const providerKeys = new Set(PROVIDER_PRESETS.map(p => p.key))
  for (const group of Object.keys(MODEL_PRESETS)) {
    assert.ok(providerKeys.has(group),
      `MODEL_PRESETS group "${group}" has no matching PROVIDER_PRESETS entry`)
  }
})
