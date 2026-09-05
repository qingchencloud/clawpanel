import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  stripUiFields,
  resolveModelApiKey,
  validateModelProviderEnvRefs,
  writeJsonAtomic,
} from '../scripts/dev-api.js'

test('Web 保存前把旧字符串模型迁移为 OpenClaw 7.1 完整对象', () => {
  const config = {
    models: {
      providers: {
        legacy: {
          api: 'openai-codex-responses',
          headers: { 'x-tenant': 'keep-me' },
          models: ['legacy-string-model'],
        },
      },
    },
  }

  const cleaned = stripUiFields(config)
  assert.equal(cleaned.models.providers.legacy.api, 'openai-chatgpt-responses')
  assert.deepEqual(cleaned.models.providers.legacy.models, [
    { id: 'legacy-string-model', name: 'legacy-string-model' },
  ])
  assert.deepEqual(cleaned.models.providers.legacy.headers, { 'x-tenant': 'keep-me' })
})

test('Web JSON 原子写入保留最后有效备份并完成回读', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-config-write-'))
  const target = path.join(root, 'openclaw.json')
  try {
    fs.writeFileSync(target, JSON.stringify({ keep: 'old' }))
    writeJsonAtomic(target, { keep: 'new', nested: { ok: true } }, { backup: true })

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { keep: 'new', nested: { ok: true } })
    assert.deepEqual(JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8')), { keep: 'old' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Web JSON 原子写入在 POSIX 上保留现有所有者和权限', {
  skip: process.platform === 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-config-permission-'))
  const target = path.join(root, 'openclaw.json')
  try {
    fs.writeFileSync(target, JSON.stringify({ keep: 'old' }))
    fs.chmodSync(target, 0o640)
    if (process.getuid?.() === 0) fs.chownSync(target, 65534, 65534)
    const before = fs.statSync(target)

    writeJsonAtomic(target, { keep: 'new' }, { backup: true })

    const after = fs.statSync(target)
    assert.equal(after.uid, before.uid)
    assert.equal(after.gid, before.gid)
    assert.equal(after.mode & 0o777, before.mode & 0o777)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Web 保存无关配置时不阻断未改动的外部环境变量引用', () => {
  const previous = {
    models: { providers: { external: { apiKey: '${CLAWPANEL_TEST_EXTERNAL_ONLY}' } } },
  }
  const unchanged = {
    ...previous,
    gateway: { port: 18789 },
  }
  assert.doesNotThrow(() => validateModelProviderEnvRefs(unchanged, previous))

  const changed = {
    models: { providers: { external: { apiKey: '${CLAWPANEL_TEST_NEW_MISSING}' } } },
  }
  assert.throws(
    () => validateModelProviderEnvRefs(changed, previous),
    /CLAWPANEL_TEST_NEW_MISSING/,
  )
})

test('Web 模型测试在后端解析 env SecretRef 并拒绝 file/exec 伪明文', () => {
  process.env.CLAWPANEL_TEST_SECRET_REF = 'sk-secret-ref'
  try {
    assert.equal(resolveModelApiKey({
      source: 'env', provider: 'default', id: 'CLAWPANEL_TEST_SECRET_REF',
    }), 'sk-secret-ref')
  } finally {
    delete process.env.CLAWPANEL_TEST_SECRET_REF
  }
  assert.throws(
    () => resolveModelApiKey({ source: 'file', provider: 'default', id: 'providers/openai/apiKey' }),
    /OpenClaw.*运行时|runtime/i,
  )
})
