import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesModelAliasesConfigValues,
  mergeHermesModelAliasesConfig,
} from '../scripts/dev-api.js'

test('Hermes 模型别名配置读取会提供空对象默认值', () => {
  const values = buildHermesModelAliasesConfigValues({})

  assert.deepEqual(values, {
    modelAliasesJson: '{}',
  })
})

test('Hermes 模型别名配置读取会格式化已有映射', () => {
  const values = buildHermesModelAliasesConfigValues({
    model_aliases: {
      opus: {
        model: 'claude-opus-4-6',
        provider: 'anthropic',
      },
      qwen: {
        model: 'qwen3.5:397b',
        provider: 'custom',
        base_url: 'https://ollama.com/v1',
      },
    },
  })
  const mapping = JSON.parse(values.modelAliasesJson)

  assert.deepEqual(mapping.opus, {
    model: 'claude-opus-4-6',
    provider: 'anthropic',
  })
  assert.deepEqual(mapping.qwen, {
    model: 'qwen3.5:397b',
    provider: 'custom',
    base_url: 'https://ollama.com/v1',
  })
})

test('Hermes 模型别名配置保存会保留未知字段并写入 model_aliases', () => {
  const next = mergeHermesModelAliasesConfig({
    model: { provider: 'openrouter' },
    model_aliases: {
      opus: {
        model: 'old-opus',
        provider: 'anthropic',
        custom_flag: 'drop-with-replace',
      },
    },
    memory: { memory_enabled: true },
  }, {
    modelAliasesJson: JSON.stringify({
      opus: {
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        custom_flag: 'keep-alias',
      },
      qwen: {
        model: 'qwen3.5:397b',
        provider: 'custom',
        base_url: 'https://ollama.com/v1',
      },
    }),
  })

  assert.deepEqual(next.model, { provider: 'openrouter' })
  assert.deepEqual(next.memory, { memory_enabled: true })
  assert.deepEqual(next.model_aliases.opus, {
    model: 'claude-opus-4-6',
    provider: 'anthropic',
    custom_flag: 'keep-alias',
  })
  assert.deepEqual(next.model_aliases.qwen, {
    model: 'qwen3.5:397b',
    provider: 'custom',
    base_url: 'https://ollama.com/v1',
  })
})

test('Hermes 模型别名配置保存空对象会移除 model_aliases', () => {
  const next = mergeHermesModelAliasesConfig({
    model_aliases: {
      opus: { model: 'claude-opus-4-6', provider: 'anthropic' },
    },
    streaming: { enabled: true },
  }, {
    modelAliasesJson: '{}',
  })

  assert.equal(next.model_aliases, undefined)
  assert.deepEqual(next.streaming, { enabled: true })
})

test('Hermes 模型别名配置保存会拒绝非法 JSON、名称和字段类型', () => {
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: '[' }),
    /model_aliases JSON/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: '[]' }),
    /model_aliases/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: JSON.stringify({ 'bad alias': { model: 'm', provider: 'p' } }) }),
    /model_aliases\.bad alias/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: JSON.stringify({ opus: 'claude-opus-4-6' }) }),
    /model_aliases\.opus/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: JSON.stringify({ opus: { provider: 'anthropic' } }) }),
    /model_aliases\.opus\.model/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: JSON.stringify({ opus: { model: 'claude-opus-4-6', provider: 123 } }) }),
    /model_aliases\.opus\.provider/,
  )
  assert.throws(
    () => mergeHermesModelAliasesConfig({}, { modelAliasesJson: JSON.stringify({ qwen: { model: 'qwen3.5:397b', base_url: 123 } }) }),
    /model_aliases\.qwen\.base_url/,
  )
})
