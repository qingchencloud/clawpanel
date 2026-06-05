import test from 'node:test'
import assert from 'node:assert/strict'

import { matchesHermesRun } from '../src/engines/hermes/lib/hermes-run-events.js'

test('matchesHermesRun ignores events before run_id is known', () => {
  assert.equal(matchesHermesRun(null, 'run_other'), false)
  assert.equal(matchesHermesRun('', 'run_other'), false)
})

test('matchesHermesRun rejects cross-run events once run_id is set', () => {
  assert.equal(matchesHermesRun('run_a', 'run_b'), false)
  assert.equal(matchesHermesRun('run_a', 'run_a'), true)
})
