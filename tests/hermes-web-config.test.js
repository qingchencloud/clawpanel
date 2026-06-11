import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesWebConfigValues,
  mergeHermesWebConfig,
} from '../scripts/dev-api.js'

test('Hermes Web 工具配置读取会提供上游默认值', () => {
  const values = buildHermesWebConfigValues({})

  assert.deepEqual(values, {
    webBackend: '',
    webSearchBackend: '',
    webExtractBackend: '',
  })
})

test('Hermes Web 工具配置读取会回显 YAML 字段', () => {
  const values = buildHermesWebConfigValues({
    web: {
      backend: 'tavily',
      search_backend: 'parallel-free',
      extract_backend: 'firecrawl',
    },
  })

  assert.equal(values.webBackend, 'tavily')
  assert.equal(values.webSearchBackend, 'parallel-free')
  assert.equal(values.webExtractBackend, 'firecrawl')
})

test('Hermes Web 工具配置保存会保留未知字段并写入上游结构', () => {
  const next = mergeHermesWebConfig({
    model: { provider: 'anthropic' },
    web: {
      backend: 'tavily',
      search_backend: 'searxng',
      extract_backend: 'firecrawl',
      custom_flag: 'keep-web',
    },
    streaming: { enabled: true },
  }, {
    webBackend: 'parallel-free',
    webSearchBackend: 'exa',
    webExtractBackend: 'native',
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.web.backend, 'parallel-free')
  assert.equal(next.web.search_backend, 'exa')
  assert.equal(next.web.extract_backend, 'native')
  assert.equal(next.web.custom_flag, 'keep-web')
})

test('Hermes Web 工具配置保存空值会移除可选字段', () => {
  const next = mergeHermesWebConfig({
    web: {
      backend: 'tavily',
      search_backend: 'searxng',
      extract_backend: 'firecrawl',
      custom_flag: 'keep-web',
    },
  }, {
    webBackend: '   ',
    webSearchBackend: '',
    webExtractBackend: '  ',
  })

  assert.equal(next.web.custom_flag, 'keep-web')
  assert.equal(Object.hasOwn(next.web, 'backend'), false)
  assert.equal(Object.hasOwn(next.web, 'search_backend'), false)
  assert.equal(Object.hasOwn(next.web, 'extract_backend'), false)
})

test('Hermes Web 工具配置保存会拒绝非法后端', () => {
  assert.throws(
    () => mergeHermesWebConfig({}, { webBackend: 'unsafe' }),
    /web\.backend/,
  )
  assert.throws(
    () => mergeHermesWebConfig({}, { webSearchBackend: 'unsafe' }),
    /web\.search_backend/,
  )
  assert.throws(
    () => mergeHermesWebConfig({}, { webExtractBackend: 'unsafe' }),
    /web\.extract_backend/,
  )
})
