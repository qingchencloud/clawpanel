/**
 * 运行：node --test tests/agent-default-model-normalize.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDefaultModelConfig } from '../src/lib/agent-default-model-normalize.js'

test('normalizeDefaultModelConfig keeps valid per-model blocks off the fallback chain', () => {
  const config = {
    models: {
      providers: {
        openai: { models: [{ id: 'gpt-4' }, { id: 'gpt-4o-mini' }] },
        anthropic: { models: [{ id: 'claude-3-5-sonnet' }] },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: 'openai/deleted-model',
          fallbacks: [],
        },
        models: {
          'openai/deleted-model': { temperature: 0.1 },
          'anthropic/claude-3-5-sonnet': { temperature: 0.7 },
        },
      },
    },
  }
  normalizeDefaultModelConfig(config)
  assert.equal(config.agents.defaults.model.primary, 'openai/gpt-4')
  assert.deepEqual(config.agents.defaults.models['anthropic/claude-3-5-sonnet'], { temperature: 0.7 })
  assert.equal(config.agents.defaults.models['openai/deleted-model'], undefined)
})

test('normalizeDefaultModelConfig still strips invalid model keys', () => {
  const config = {
    models: {
      providers: {
        openai: { models: [{ id: 'gpt-4' }] },
      },
    },
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-4', fallbacks: [] },
        models: {
          'openai/gpt-4': {},
          'ghost/missing': { temperature: 1 },
        },
      },
    },
  }
  normalizeDefaultModelConfig(config)
  assert.equal(config.agents.defaults.models['ghost/missing'], undefined)
  assert.ok(config.agents.defaults.models['openai/gpt-4'])
})
