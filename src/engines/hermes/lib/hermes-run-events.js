/**
 * Helpers for correlating global Tauri `hermes-run-*` events to a single run.
 * Events are process-wide; ignore payloads until our run_id is known.
 */
export function matchesHermesRun(runId, eventRunId) {
  return Boolean(runId && eventRunId && runId === eventRunId)
}
