// src/lib/ws.ts (stub for Plan 1 — full implementation in Plan 4)
export const wsClient = {
  connect: async () => {},
  disconnect: () => {},
  onStatusChange: (fn: (status: string) => void) => fn('disconnected'),
  onReady: (fn: () => void) => {},
  onEvent: (fn: (event: unknown) => void) => {},
  chatSend: async () => ({}),
  chatHistory: async () => ({ messages: [] }),
  chatAbort: () => {},
}
