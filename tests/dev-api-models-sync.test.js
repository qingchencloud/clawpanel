import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { syncProvidersToAgentModels } from '../scripts/dev-api.js'

function writeAgentModels(root, agentId, value) {
  const file = path.join(root, 'agents', agentId, 'agent', 'models.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('Web API 同步 providers 时会更新每个 Agent 的连接信息和上下文元数据', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-models-sync-'))
  try {
    const oldModels = {
      providers: {
        lmstudio: {
          baseUrl: 'http://127.0.0.1:1234/v1-old',
          apiKey: 'old-key',
          api: 'openai-completions',
          models: [{
            id: 'qwen-local',
            name: 'Qwen Local',
            contextWindow: 50000,
            contextTokens: 50000,
            maxTokens: 4096,
            customRuntimeFlag: true,
          }],
          modelOverrides: {
            'qwen-local': { contextWindow: 50000, contextTokens: 50000 },
          },
        },
        stale: { baseUrl: 'http://stale.example/v1', models: [{ id: 'old' }] },
      },
    }
    const mainPath = writeAgentModels(tmp, 'main', oldModels)
    const workerPath = writeAgentModels(tmp, 'worker', oldModels)

    const result = syncProvidersToAgentModels({
      agents: { list: [{ id: 'worker' }] },
      models: {
        providers: {
          lmstudio: {
            baseUrl: 'http://127.0.0.1:1234/v1',
            apiKey: 'new-key',
            api: 'openai-completions',
            models: [{
              id: 'qwen-local',
              name: 'Qwen Local',
              contextWindow: 131072,
              contextTokens: 131072,
              maxTokens: 8192,
            }, { id: 'new-local', name: 'New Local', contextWindow: 65536 }],
          },
        },
      },
    }, tmp)

    assert.deepEqual(result.updated.sort(), [mainPath, workerPath].sort())
    for (const file of [mainPath, workerPath]) {
      const synced = readJson(file)
      assert.equal(synced.providers.lmstudio.baseUrl, 'http://127.0.0.1:1234/v1')
      assert.equal(synced.providers.lmstudio.apiKey, 'new-key')
      assert.equal(synced.providers.stale, undefined)
      const local = synced.providers.lmstudio.models.find(model => model.id === 'qwen-local')
      assert.equal(local.contextWindow, 131072)
      assert.equal(local.contextTokens, 131072)
      assert.equal(local.maxTokens, 8192)
      assert.equal(local.customRuntimeFlag, true)
      assert.equal(synced.providers.lmstudio.modelOverrides['qwen-local'].contextWindow, 131072)
      assert.equal(synced.providers.lmstudio.modelOverrides['qwen-local'].contextTokens, 131072)
      assert.equal(synced.providers.lmstudio.models.some(model => model.id === 'new-local'), true)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Web API 同步保留 Agent 运行时手动添加的模型', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-models-sync-'))
  try {
    const modelsPath = writeAgentModels(tmp, 'main', {
      providers: {
        lmstudio: {
          models: [
            { id: 'qwen-local', contextWindow: 50000 },
            { id: 'manual-only', contextWindow: 32768 },
          ],
        },
      },
    })

    syncProvidersToAgentModels({
      models: {
        providers: {
          lmstudio: {
            models: [{ id: 'qwen-local', contextWindow: 65536 }],
          },
        },
      },
    }, tmp)

    const synced = readJson(modelsPath)
    assert.equal(synced.providers.lmstudio.models.find(model => model.id === 'qwen-local').contextWindow, 65536)
    assert.equal(synced.providers.lmstudio.models.some(model => model.id === 'manual-only'), true)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Web API 在 OpenClaw 8.1 entries 注册表下同步全部 Agent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-models-sync-'))
  try {
    const workerPath = writeAgentModels(tmp, 'worker', { providers: {} })
    const result = syncProvidersToAgentModels({
      agents: { entries: { main: {}, worker: {} }, ownership: 'explicit' },
      models: {
        providers: {
          lmstudio: {
            baseUrl: 'http://127.0.0.1:1234/v1',
            models: [{ id: 'qwen-local', contextWindow: 131072 }],
          },
        },
      },
    }, tmp)

    assert.deepEqual(result.updated, [workerPath])
    assert.equal(readJson(workerPath).providers.lmstudio.models[0].contextWindow, 131072)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
