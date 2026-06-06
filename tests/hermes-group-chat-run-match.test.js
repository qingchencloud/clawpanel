import test from 'node:test'
import assert from 'node:assert/strict'

import { matchesHermesRun } from '../src/engines/hermes/pages/group-chat.js'

test('matchesHermesRun rejects events before run_id is known', () => {
  assert.equal(matchesHermesRun(null, 'run_other'), false)
  assert.equal(matchesHermesRun(undefined, 'run_other'), false)
  assert.equal(matchesHermesRun('', 'run_other'), false)
})

test('matchesHermesRun rejects foreign run_id', () => {
  assert.equal(matchesHermesRun('run_a', 'run_b'), false)
  assert.equal(matchesHermesRun('run_a', null), false)
})

test('matchesHermesRun accepts only the same run_id', () => {
  assert.equal(matchesHermesRun('run_a', 'run_a'), true)
})
