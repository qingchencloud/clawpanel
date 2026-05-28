/**
 * Predicate for Hermes `hermes-run-*` Tauri events.
 * Requires a known run_id so concurrent runs cannot leak output across listeners.
 */
export function matchesHermesRun(runId, eventRunId) {
  return runId != null && eventRunId === runId
}
