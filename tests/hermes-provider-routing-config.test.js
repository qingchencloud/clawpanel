import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesProviderRoutingConfigValues,
  mergeHermesProviderRoutingConfig,
} from '../scripts/dev-api.js'

test('Hermes Provider Routing 配置读取会提供上游默认值', () => {
  const values = buildHermesProviderRoutingConfigValues({})

  assert.deepEqual(values, {
    providerRoutingSort: 'price',
    providerRoutingOnly: '',
    providerRoutingIgnore: '',
    providerRoutingOrder: '',
    providerRoutingRequireParameters: false,
    providerRoutingDataCollection: 'allow',
  })
})

test('Hermes Provider Routing 配置读取会回显 YAML 字段', () => {
  const values = buildHermesProviderRoutingConfigValues({
    provider_routing: {
      sort: 'throughput',
      only: ['anthropic', 'google'],
      ignore: ['deepinfra'],
      order: ['anthropic', 'google', 'together'],
      require_parameters: true,
      data_collection: 'deny',
    },
  })

  assert.equal(values.providerRoutingSort, 'throughput')
  assert.equal(values.providerRoutingOnly, 'anthropic\ngoogle')
  assert.equal(values.providerRoutingIgnore, 'deepinfra')
  assert.equal(values.providerRoutingOrder, 'anthropic\ngoogle\ntogether')
  assert.equal(values.providerRoutingRequireParameters, true)
  assert.equal(values.providerRoutingDataCollection, 'deny')
})

test('Hermes Provider Routing 配置保存会保留未知字段并写入上游结构', () => {
  const next = mergeHermesProviderRoutingConfig({
    model: { provider: 'openrouter' },
    provider_routing: {
      sort: 'price',
      only: ['anthropic'],
      custom_flag: 'keep-routing',
    },
    openrouter: {
      response_cache: true,
    },
  }, {
    providerRoutingSort: 'latency',
    providerRoutingOnly: ' anthropic \n google \n anthropic ',
    providerRoutingIgnore: 'deepinfra\nfireworks',
    providerRoutingOrder: 'google\nanthropic',
    providerRoutingRequireParameters: true,
    providerRoutingDataCollection: 'deny',
  })

  assert.deepEqual(next.model, { provider: 'openrouter' })
  assert.deepEqual(next.openrouter, { response_cache: true })
  assert.equal(next.provider_routing.sort, 'latency')
  assert.deepEqual(next.provider_routing.only, ['anthropic', 'google'])
  assert.deepEqual(next.provider_routing.ignore, ['deepinfra', 'fireworks'])
  assert.deepEqual(next.provider_routing.order, ['google', 'anthropic'])
  assert.equal(next.provider_routing.require_parameters, true)
  assert.equal(next.provider_routing.data_collection, 'deny')
  assert.equal(next.provider_routing.custom_flag, 'keep-routing')
})

test('Hermes Provider Routing 配置保存会移除空列表并保留基础策略', () => {
  const next = mergeHermesProviderRoutingConfig({
    provider_routing: {
      only: ['anthropic'],
      ignore: ['deepinfra'],
      order: ['google'],
    },
  }, {
    providerRoutingOnly: '',
    providerRoutingIgnore: '  \n ',
    providerRoutingOrder: '',
    providerRoutingRequireParameters: false,
    providerRoutingDataCollection: 'allow',
  })

  assert.equal(next.provider_routing.sort, 'price')
  assert.equal(next.provider_routing.require_parameters, false)
  assert.equal(next.provider_routing.data_collection, 'allow')
  assert.equal(Object.hasOwn(next.provider_routing, 'only'), false)
  assert.equal(Object.hasOwn(next.provider_routing, 'ignore'), false)
  assert.equal(Object.hasOwn(next.provider_routing, 'order'), false)
})

test('Hermes Provider Routing 配置保存会拒绝非法枚举和 provider slug', () => {
  assert.throws(
    () => mergeHermesProviderRoutingConfig({}, { providerRoutingSort: 'random' }),
    /provider_routing\.sort/,
  )
  assert.throws(
    () => mergeHermesProviderRoutingConfig({}, { providerRoutingDataCollection: 'maybe' }),
    /provider_routing\.data_collection/,
  )
  assert.throws(
    () => mergeHermesProviderRoutingConfig({}, { providerRoutingOnly: 'bad provider' }),
    /provider_routing\.only/,
  )
  assert.throws(
    () => mergeHermesProviderRoutingConfig({}, { providerRoutingOrder: '../secret' }),
    /provider_routing\.order/,
  )
})
