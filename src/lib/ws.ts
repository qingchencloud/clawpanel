// src/lib/ws.ts (stub for Plan 1 — full implementation in Plan 4)
export const wsClient = {
  connect: async (_host: string, _token: string) => {},
  disconnect: () => {},
  onStatusChange: (fn: (status: string) => void) => { fn('disconnected'); return () => {} },
  onReady: (_fn: () => void) => { return () => {} },
  onEvent: (_fn: (event: unknown) => void) => { return () => {} },
  chatSend: async () => ({}),
  chatHistory: async () => ({ messages: [] }),
  chatAbort: () => {},
}
