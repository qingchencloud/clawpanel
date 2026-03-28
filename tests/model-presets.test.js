import test from 'node:test'
import assert from 'node:assert/strict'

import {
  API_TYPES,
  PROVIDER_PRESETS,
  MODEL_PRESETS,
} from '../src/lib/model-presets.js'

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
  assert.ok(minimax.site, 'MiniMax should have a site URL')
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

test('MiniMax model presets include M2.7 and M2.5 variants', () => {
  const ids = MODEL_PRESETS.minimax.map(m => m.id)
  assert.ok(ids.includes('MiniMax-M2.7'), 'should include MiniMax-M2.7')
  assert.ok(ids.includes('MiniMax-M2.7-highspeed'), 'should include MiniMax-M2.7-highspeed')
  assert.ok(ids.includes('MiniMax-M2.5'), 'should include MiniMax-M2.5')
  assert.ok(ids.includes('MiniMax-M2.5-highspeed'), 'should include MiniMax-M2.5-highspeed')
})

test('MiniMax model presets have required fields', () => {
  for (const m of MODEL_PRESETS.minimax) {
    assert.ok(m.id, `model missing id`)
    assert.ok(m.name, `model ${m.id} missing name`)
    assert.ok(typeof m.contextWindow === 'number' && m.contextWindow > 0,
      `model ${m.id} should have a positive contextWindow`)
  }
})

test('MiniMax M2.7 models have 1M context window', () => {
  const m27 = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M2.7')
  assert.equal(m27.contextWindow, 1000000)
  const m27hs = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M2.7-highspeed')
  assert.equal(m27hs.contextWindow, 1000000)
})

test('MiniMax M2.5 models have 204K context window', () => {
  const m25 = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M2.5')
  assert.equal(m25.contextWindow, 204000)
  const m25hs = MODEL_PRESETS.minimax.find(m => m.id === 'MiniMax-M2.5-highspeed')
  assert.equal(m25hs.contextWindow, 204000)
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
