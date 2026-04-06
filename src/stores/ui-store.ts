import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  gatewayOfflineDismissed: boolean
  setGatewayOfflineDismissed: (v: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      gatewayOfflineDismissed: false,
      setGatewayOfflineDismissed: (v) => set({ gatewayOfflineDismissed: v }),
    }),
    { name: 'cjgclaw-ui' },
  ),
)
