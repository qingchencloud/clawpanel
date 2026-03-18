import { describe, it, expect } from 'vitest'

import {
  DOCKER_TASK_TIMEOUT_MS,
  buildDockerDispatchTargets,
  buildDockerInstanceSwitchContext,
} from '../src/lib/docker-tasking.js'

describe('docker-tasking', () => {
  it('Docker 异步任务默认超时提升到 10 分钟', () => {
    expect(DOCKER_TASK_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })

  it('Docker 派发目标会保留容器和节点信息', () => {
    const targets = buildDockerDispatchTargets([
      { id: 'container-1234567890ab', name: 'openclaw-coder', nodeId: 'node-a' },
      { id: 'container-bbbbbbbbbbbb', name: 'openclaw-writer', nodeId: 'node-b' },
    ])

    expect(targets).toEqual([
      { containerId: 'container-1234567890ab', containerName: 'openclaw-coder', nodeId: 'node-a' },
      { containerId: 'container-bbbbbbbbbbbb', containerName: 'openclaw-writer', nodeId: 'node-b' },
    ])
  })

  it('Docker 实例切换上下文会要求整页重载并生成正确注册参数', () => {
    const ctx = buildDockerInstanceSwitchContext({
      containerId: 'abcdef1234567890',
      name: 'openclaw-coder',
      port: '21420',
      gatewayPort: '28789',
      nodeId: 'node-a',
    })

    expect(ctx.instanceId).toBe('docker-abcdef123456')
    expect(ctx.reloadRoute).toBe(true)
    expect(ctx.registration).toEqual({
      name: 'openclaw-coder',
      type: 'docker',
      endpoint: 'http://127.0.0.1:21420',
      gatewayPort: 28789,
      containerId: 'abcdef1234567890',
      nodeId: 'node-a',
      note: 'Added from Docker page',
    })
  })
})
