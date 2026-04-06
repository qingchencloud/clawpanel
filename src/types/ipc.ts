// IPC 命令请求/响应类型联合

// sandbox
export interface SandboxInitResult { initialized: boolean; version: string }
export interface SandboxStatus { installed: boolean; version: string; dir: string }

// gateway
export interface GatewayStartResult { success: boolean }
export interface GatewayStopResult { success: boolean }
export interface GatewayReloadResult { success: boolean }

// config
export type ReadConfigResult = Record<string, unknown>
export interface WriteConfigResult { success: boolean }

// agent
export type ListAgentsResult = import('./openclaw').Agent[]
export interface AddAgentParams { name: string; model?: string }
export interface DeleteAgentParams { id: string }
export interface UpdateAgentModelParams { id: string; model: string }
export interface UpdateAgentIdentityParams { id: string; name?: string; emoji?: string }

// model
export interface TestModelParams { baseUrl: string; model: string; apiKey?: string; messages?: unknown[] }
export interface TestModelResult { success: boolean; latency_ms: number; error?: string }
export interface ListRemoteModelsParams { baseUrl: string; apiKey: string }
export interface ListRemoteModelsResult { models: string[] }

// skills
export interface SkillInfo { name: string; version?: string; description?: string; installed: boolean }
export interface SkillsListResult { skills: SkillInfo[] }
export interface SkillsSearchResult { results: Array<{ slug: string; name: string; description: string }> }

// extensions
export interface CftunnelStatus { running: boolean; tunnel_url?: string }
export interface ClawappStatus { installed: boolean; version?: string }
