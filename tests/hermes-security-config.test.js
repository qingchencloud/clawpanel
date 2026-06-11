import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesSecurityConfigValues,
  mergeHermesSecurityConfig,
} from '../scripts/dev-api.js'

test('Hermes 安全扫描配置读取会提供 Tirith 默认值', () => {
  const values = buildHermesSecurityConfigValues({})

  assert.deepEqual(values, {
    tirithEnabled: true,
    tirithPath: 'tirith',
    tirithTimeout: 5,
    tirithFailOpen: true,
    installPolicyJson: '',
  })
})

test('Hermes 安全扫描配置读取会规范化已有值', () => {
  const values = buildHermesSecurityConfigValues({
    security: {
      tirith_enabled: false,
      tirith_path: 'C:/tools/tirith.exe',
      tirith_timeout: 12,
      tirith_fail_open: false,
      installPolicy: {
        enabled: true,
        targets: ['skill', 'plugin'],
      },
    },
  })

  assert.equal(values.tirithEnabled, false)
  assert.equal(values.tirithPath, 'C:/tools/tirith.exe')
  assert.equal(values.tirithTimeout, 12)
  assert.equal(values.tirithFailOpen, false)
  assert.deepEqual(JSON.parse(values.installPolicyJson), {
    enabled: true,
    targets: ['skill', 'plugin'],
  })
})

test('Hermes 安全扫描配置保存会保留未知字段并写入 security.tirith', () => {
  const next = mergeHermesSecurityConfig({
    model: { provider: 'anthropic' },
    security: {
      allow_private_urls: false,
      website_blocklist: { enabled: true, domains: ['example.com'] },
      installPolicy: {
        enabled: false,
        targets: ['skill'],
      },
      custom_flag: 'keep-security',
    },
    terminal: { backend: 'docker' },
  }, {
    tirithEnabled: false,
    tirithPath: '~/bin/tirith',
    tirithTimeout: '9',
    tirithFailOpen: false,
    installPolicyJson: JSON.stringify({
      enabled: true,
      targets: ['skill', 'plugin'],
      exec: {
        source: 'exec',
        command: 'tirith',
        args: ['scan'],
      },
    }),
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.terminal, { backend: 'docker' })
  assert.equal(next.security.allow_private_urls, false)
  assert.deepEqual(next.security.website_blocklist, { enabled: true, domains: ['example.com'] })
  assert.equal(next.security.custom_flag, 'keep-security')
  assert.deepEqual(next.security.installPolicy, {
    enabled: true,
    targets: ['skill', 'plugin'],
    exec: {
      source: 'exec',
      command: 'tirith',
      args: ['scan'],
    },
  })
  assert.equal(next.security.tirith_enabled, false)
  assert.equal(next.security.tirith_path, '~/bin/tirith')
  assert.equal(next.security.tirith_timeout, 9)
  assert.equal(next.security.tirith_fail_open, false)
})

test('Hermes 安全扫描配置保存会拒绝非法超时和空路径', () => {
  assert.throws(
    () => mergeHermesSecurityConfig({}, { tirithTimeout: '0' }),
    /security\.tirith_timeout/,
  )
  assert.throws(
    () => mergeHermesSecurityConfig({}, { tirithPath: '' }),
    /security\.tirith_path/,
  )
  assert.throws(
    () => mergeHermesSecurityConfig({}, { installPolicyJson: '[]' }),
    /security\.installPolicy/,
  )
})
