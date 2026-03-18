import { describe, it, expect } from 'vitest'

import {
  MAX_AUTO_RESTART,
  RESTART_COOLDOWN,
  STABLE_RUNNING_MS,
  evaluateAutoRestartAttempt,
  shouldResetAutoRestartCount,
} from '../src/lib/gateway-guardian-policy.js'

describe('gateway-guardian-policy', () => {
  it('短暂恢复运行不应立即清零自动重启计数', () => {
    expect(
      shouldResetAutoRestartCount({
        autoRestartCount: 2,
        runningSince: 10_000,
        now: 10_000 + STABLE_RUNNING_MS - 1,
      }),
    ).toBe(false)
  })

  it('稳定运行超过阈值后才允许清零自动重启计数', () => {
    expect(
      shouldResetAutoRestartCount({
        autoRestartCount: 2,
        runningSince: 10_000,
        now: 10_000 + STABLE_RUNNING_MS,
      }),
    ).toBe(true)
  })

  it('达到最大自动重启次数后必须停止守护', () => {
    expect(
      evaluateAutoRestartAttempt({
        now: 90_000,
        lastRestartTime: 0,
        autoRestartCount: MAX_AUTO_RESTART,
      }),
    ).toEqual({ action: 'give_up' })
  })

  it('冷却时间内不应重复自动重启', () => {
    expect(
      evaluateAutoRestartAttempt({
        now: RESTART_COOLDOWN - 1,
        lastRestartTime: 0,
        autoRestartCount: 1,
      }),
    ).toEqual({ action: 'cooldown' })
  })

  it('满足条件时应增加自动重启计数并记录重启时间', () => {
    expect(
      evaluateAutoRestartAttempt({
        now: 120_000,
        lastRestartTime: 0,
        autoRestartCount: 1,
      }),
    ).toEqual({
      action: 'restart',
      autoRestartCount: 2,
      lastRestartTime: 120_000,
    })
  })
})
