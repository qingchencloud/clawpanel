export interface Agent {
  id: string
  name: string
  model?: string
  identity?: { name: string; emoji?: string }
  workspace?: string
  createdAt?: string
}

export interface ModelConfig {
  provider: string
  models: string[]
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
}

export interface OpenClawConfig {
  agents?: Record<string, Agent>
  models?: ModelConfig[]
  gateway?: {
    port?: number
    token?: string
  }
  extensions?: Record<string, unknown>
  skills?: Record<string, unknown>
}

export interface VersionInfo {
  current: string | null
  latest: string | null
  recommended: string | null
  update_available: boolean
  panel_version: string
}
