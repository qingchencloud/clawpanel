import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { syncProvidersToAgentModels } from '../scripts/dev-api.js'

test('Web API write 会同步 openclaw.json providers 到 agent models.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-models-sync-'))
  try {
    const modelsPath = path.join(tmp, 'agents', 'main', 'agent', 'models.json')
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true })
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        a: { baseUrl: 'http://old-a', models: [{ id: 'm1' }] },
        b: { baseUrl: 'http://old-b', models: [{ id: 'm2' }] },
      },
    }, null, 2))

    syncProvidersToAgentModels({
      models: {
        providers: {
          a: { baseUrl: 'http://new-a', apiKey: 'key-a', models: [{ id: 'm1' }] },
        },
      },
    }, tmp)

    const synced = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
    assert.equal(synced.providers.a.baseUrl, 'http://new-a')
    assert.equal(synced.providers.a.apiKey, 'key-a')
    assert.equal(synced.providers.b, undefined)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Web API provider sync 保留 agent models.json 中用户手动添加的 provider 模型列表', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-models-sync-'))
  try {
    const modelsPath = path.join(tmp, 'agents', 'main', 'agent', 'models.json')
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true })
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        a: {
          baseUrl: 'http://old-a',
          models: [{ id: 'm1' }, { id: 'custom-model' }],
        },
      },
    }, null, 2))

    syncProvidersToAgentModels({
      models: {
        providers: {
          a: { baseUrl: 'http://new-a', models: [{ id: 'm1' }] },
        },
      },
    }, tmp)

    const synced = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
    assert.equal(synced.providers.a.baseUrl, 'http://new-a')
    assert.deepEqual(synced.providers.a.models, [{ id: 'm1' }, { id: 'custom-model' }])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
