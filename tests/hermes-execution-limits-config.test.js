import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesExecutionLimitsConfigValues,
  mergeHermesExecutionLimitsConfig,
} from '../scripts/dev-api.js'

test('Hermes 执行与委派限制读取会提供上游默认值', () => {
  const values = buildHermesExecutionLimitsConfigValues({})

  assert.deepEqual(values, {
    codeExecutionMode: 'project',
    codeExecutionTimeout: 300,
    codeExecutionMaxToolCalls: 50,
    delegationMaxIterations: 50,
    delegationChildTimeoutSeconds: 600,
    delegationMaxConcurrentChildren: 3,
    delegationMaxSpawnDepth: 1,
    delegationOrchestratorEnabled: true,
    delegationSubagentAutoApprove: false,
    delegationInheritMcpToolsets: true,
  })
})

test('Hermes 执行与委派限制读取会回显 YAML 字段', () => {
  const values = buildHermesExecutionLimitsConfigValues({
    code_execution: {
      mode: 'strict',
      timeout: 120,
      max_tool_calls: 12,
    },
    delegation: {
      max_iterations: 30,
      child_timeout_seconds: 900,
      max_concurrent_children: 5,
      max_spawn_depth: 2,
      orchestrator_enabled: false,
      subagent_auto_approve: true,
      inherit_mcp_toolsets: false,
    },
  })

  assert.equal(values.codeExecutionMode, 'strict')
  assert.equal(values.codeExecutionTimeout, 120)
  assert.equal(values.codeExecutionMaxToolCalls, 12)
  assert.equal(values.delegationMaxIterations, 30)
  assert.equal(values.delegationChildTimeoutSeconds, 900)
  assert.equal(values.delegationMaxConcurrentChildren, 5)
  assert.equal(values.delegationMaxSpawnDepth, 2)
  assert.equal(values.delegationOrchestratorEnabled, false)
  assert.equal(values.delegationSubagentAutoApprove, true)
  assert.equal(values.delegationInheritMcpToolsets, false)
})

test('Hermes 执行与委派限制保存会保留未知字段并写入上游结构', () => {
  const next = mergeHermesExecutionLimitsConfig({
    model: { provider: 'anthropic' },
    code_execution: {
      mode: 'project',
      custom_flag: 'keep-code',
    },
    delegation: {
      model: 'child-model',
      provider: 'openrouter',
      custom_flag: 'keep-delegation',
    },
    streaming: { enabled: true },
  }, {
    codeExecutionMode: 'strict',
    codeExecutionTimeout: '180',
    codeExecutionMaxToolCalls: '25',
    delegationMaxIterations: '40',
    delegationChildTimeoutSeconds: '1200',
    delegationMaxConcurrentChildren: '4',
    delegationMaxSpawnDepth: '2',
    delegationOrchestratorEnabled: false,
    delegationSubagentAutoApprove: true,
    delegationInheritMcpToolsets: false,
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.code_execution.mode, 'strict')
  assert.equal(next.code_execution.timeout, 180)
  assert.equal(next.code_execution.max_tool_calls, 25)
  assert.equal(next.code_execution.custom_flag, 'keep-code')
  assert.equal(next.delegation.max_iterations, 40)
  assert.equal(next.delegation.child_timeout_seconds, 1200)
  assert.equal(next.delegation.max_concurrent_children, 4)
  assert.equal(next.delegation.max_spawn_depth, 2)
  assert.equal(next.delegation.orchestrator_enabled, false)
  assert.equal(next.delegation.subagent_auto_approve, true)
  assert.equal(next.delegation.inherit_mcp_toolsets, false)
  assert.equal(next.delegation.model, 'child-model')
  assert.equal(next.delegation.provider, 'openrouter')
  assert.equal(next.delegation.custom_flag, 'keep-delegation')
})

test('Hermes 执行与委派限制保存会拒绝非法模式和越界值', () => {
  assert.throws(
    () => mergeHermesExecutionLimitsConfig({}, { codeExecutionMode: 'unsafe' }),
    /code_execution\.mode/,
  )
  assert.throws(
    () => mergeHermesExecutionLimitsConfig({}, { codeExecutionTimeout: '0' }),
    /code_execution\.timeout/,
  )
  assert.throws(
    () => mergeHermesExecutionLimitsConfig({}, { delegationMaxConcurrentChildren: '0' }),
    /delegation\.max_concurrent_children/,
  )
  assert.throws(
    () => mergeHermesExecutionLimitsConfig({}, { delegationMaxSpawnDepth: '4' }),
    /delegation\.max_spawn_depth/,
  )
  assert.throws(
    () => mergeHermesExecutionLimitsConfig({}, { delegationChildTimeoutSeconds: '29' }),
    /delegation\.child_timeout_seconds/,
  )
})
