import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesHermesRun } from '../src/engines/hermes/lib/hermes-run-events.js'

test('matchesHermesRun rejects events before run_id is known', () => {
  assert.equal(matchesHermesRun(null, 'run_abc'), false)
  assert.equal(matchesHermesRun(undefined, 'run_abc'), false)
})

test('matchesHermesRun rejects events from a different run', () => {
  assert.equal(matchesHermesRun('run_a', 'run_b'), false)
})

test('matchesHermesRun accepts events for the active run', () => {
  assert.equal(matchesHermesRun('run_a', 'run_a'), true)
})
