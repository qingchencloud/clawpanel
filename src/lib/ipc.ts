import { invoke } from '@tauri-apps/api/core'

// ── Sandbox ────────────────────────────────────────────────
export const sandbox = {
  init: () => invoke<{ initialized: boolean; version: string }>('sandbox_init'),
  status: () => invoke<{ installed: boolean; version: string; dir: string }>('sandbox_status'),
}

// ── Gateway ────────────────────────────────────────────────
export const gateway = {
  start: () => invoke<void>('gateway_start'),
  stop: () => invoke<void>('gateway_stop'),
  restart: () => invoke<void>('gateway_restart'),
  reload: () => invoke<void>('gateway_reload'),
  status: () => invoke<{ running: boolean; port: number; pid?: number }>('gateway_status'),
}

// ── Config ────────────────────────────────────────────────
export const config = {
  read: () => invoke<Record<string, unknown>>('read_openclaw_config'),
  write: (cfg: Record<string, unknown>) => invoke<void>('write_openclaw_config', { config: cfg }),
  readMcp: () => invoke<Record<string, unknown>>('read_mcp_config'),
  writeMcp: (cfg: Record<string, unknown>) => invoke<void>('write_mcp_config', { config: cfg }),
  getVersionInfo: () => invoke<import('@/types/openclaw').VersionInfo>('get_version_info'),
  getStatusSummary: () => invoke<Record<string, unknown>>('get_status_summary'),
}

// ── Agent ─────────────────────────────────────────────────
export const agent = {
  list: () => invoke<import('@/types/openclaw').Agent[]>('list_agents'),
  create: (params: { name: string; model?: string }) =>
    invoke<import('@/types/openclaw').Agent>('add_agent', params),
  delete: (id: string) => invoke<string>('delete_agent', { id }),
  updateIdentity: (id: string, name?: string, emoji?: string) =>
    invoke<string>('update_agent_identity', { id, name, emoji }),
  updateModel: (id: string, model: string) =>
    invoke<string>('update_agent_model', { id, model }),
  backup: (id: string) => invoke<string>('backup_agent', { id }),
}

// ── Model ──────────────────────────────────────────────────
export const model = {
  test: (params: { baseUrl: string; model: string; apiKey?: string; messages?: unknown[] }) =>
    invoke<{ success: boolean; latency_ms: number; error?: string }>('test_model', params),
  listRemote: (params: { baseUrl: string; apiKey: string }) =>
    invoke<{ models: string[] }>('list_remote_models', params),
}

// ── Skills ────────────────────────────────────────────────
export const skills = {
  list: () => invoke<{ skills: Array<{ name: string; version?: string; description?: string; installed: boolean }> }>('skills_list'),
  info: (name: string) => invoke<Record<string, unknown>>('skills_info', { name }),
  check: () => invoke<Record<string, unknown>>('skills_check'),
  uninstall: (name: string) => invoke<Record<string, unknown>>('skills_uninstall', { name }),
  skillhubSearch: (query: string) => invoke<{ results: Array<{ slug: string; name: string; description: string }> }>('skills_skillhub_search', { query }),
  skillhubInstall: (slug: string) => invoke<Record<string, unknown>>('skills_skillhub_install', { slug }),
  clawhubSearch: (query: string) => invoke<{ results: Array<{ slug: string; name: string; description: string }> }>('skills_clawhub_search', { query }),
  clawhubInstall: (slug: string) => invoke<Record<string, unknown>>('skills_clawhub_install', { slug }),
}

// ── Extensions ─────────────────────────────────────────────
export const extensions = {
  cftunnelStatus: () => invoke<{ running: boolean; tunnel_url?: string }>('get_cftunnel_status'),
  cftunnelAction: (action: 'start' | 'stop') => invoke<void>('cftunnel_action', { action }),
  clawappStatus: () => invoke<{ installed: boolean; version?: string }>('get_clawapp_status'),
  installCftunnel: () => invoke<string>('install_cftunnel'),
  installClawapp: () => invoke<string>('install_clawapp'),
}

// ── Service ───────────────────────────────────────────────
export const service = {
  list: () => invoke<Array<{ label: string; pid: number | null; running: boolean; description: string }>>('get_services_status'),
  start: (label: string) => invoke<void>('start_service', { label }),
  stop: (label: string) => invoke<void>('stop_service', { label }),
  restart: (label: string) => invoke<void>('restart_service', { label }),
  guardianStatus: () => invoke<import('@/types/gateway').GuardianStatus>('guardian_status'),
}
