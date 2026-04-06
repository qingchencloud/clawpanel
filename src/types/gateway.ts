export interface GatewayStatus {
  running: boolean
  port: number
  pid?: number
  startedAt?: string
}

export interface ServiceStatus {
  label: string
  pid: number | null
  running: boolean
  description: string
  cli_installed: boolean
}

export interface GuardianStatus {
  auto_restart_count: number
  max_auto_restarts: number
  manual_hold: boolean
  last_seen_running: string | null
  running_since: string | null
  give_up: boolean
}
