import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { t } from '../src/lib/i18n.js'

const source = readFileSync(new URL('../src/engines/hermes/pages/config.js', import.meta.url), 'utf8')

function extractEngineKeys() {
  return [...source.matchAll(/['"](engine\.[A-Za-z0-9_.-]+)['"]/g)].map(match => match[1])
}

test('Hermes 配置页会暴露会话安全结构化配置字段', () => {
  for (const id of [
    'hm-runtime-save',
    'hm-session-reset-mode',
    'hm-session-idle-minutes',
    'hm-session-at-hour',
    'hm-group-sessions-per-user',
    'hm-thread-sessions-per-user',
    'hm-worktree-enabled',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露会话维护结构化配置字段', () => {
  for (const id of [
    'hm-sessions-maintenance-save',
    'hm-sessions-auto-prune',
    'hm-sessions-retention-days',
    'hm-sessions-vacuum-after-prune',
    'hm-sessions-min-interval-hours',
    'hm-sessions-write-json-snapshots',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露更新备份结构化配置字段', () => {
  for (const id of [
    'hm-updates-save',
    'hm-updates-pre-update-backup',
    'hm-updates-backup-keep',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露工具循环防护结构化配置字段', () => {
  for (const id of [
    'hm-tool-guardrails-save',
    'hm-tool-guardrails-warnings-enabled',
    'hm-tool-guardrails-hard-stop-enabled',
    'hm-tool-guardrails-warn-exact-failure',
    'hm-tool-guardrails-warn-same-tool-failure',
    'hm-tool-guardrails-warn-no-progress',
    'hm-tool-guardrails-hard-stop-exact-failure',
    'hm-tool-guardrails-hard-stop-same-tool-failure',
    'hm-tool-guardrails-hard-stop-no-progress',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露记忆结构化配置字段', () => {
  for (const id of [
    'hm-memory-save',
    'hm-memory-enabled',
    'hm-memory-user-profile-enabled',
    'hm-memory-char-limit',
    'hm-memory-user-char-limit',
    'hm-memory-nudge-interval',
    'hm-memory-flush-min-turns',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Skills 结构化配置字段', () => {
  for (const id of [
    'hm-skills-config-save',
    'hm-skills-creation-nudge-interval',
    'hm-skills-template-vars',
    'hm-skills-inline-shell',
    'hm-skills-inline-shell-timeout',
    'hm-skills-guard-agent-created',
    'hm-skills-external-dirs',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Curator 结构化配置字段', () => {
  for (const id of [
    'hm-curator-config-save',
    'hm-curator-enabled',
    'hm-curator-interval-hours',
    'hm-curator-min-idle-hours',
    'hm-curator-stale-after-days',
    'hm-curator-archive-after-days',
    'hm-curator-backup-enabled',
    'hm-curator-backup-keep',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露快捷命令结构化配置字段', () => {
  for (const id of [
    'hm-quick-commands-save',
    'hm-quick-commands-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露基础模型结构化配置字段', () => {
  for (const id of [
    'hm-model-config-save',
    'hm-model-default',
    'hm-model-provider',
    'hm-model-base-url',
    'hm-model-context-length',
    'hm-model-max-tokens',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露模型目录结构化配置字段', () => {
  for (const id of [
    'hm-model-catalog-save',
    'hm-model-catalog-enabled',
    'hm-model-catalog-url',
    'hm-model-catalog-ttl-hours',
    'hm-model-catalog-providers-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 X 搜索结构化配置字段', () => {
  for (const id of [
    'hm-x-search-save',
    'hm-x-search-model',
    'hm-x-search-timeout-seconds',
    'hm-x-search-retries',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露上下文引擎结构化配置字段', () => {
  for (const id of [
    'hm-context-config-save',
    'hm-context-engine',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 provider 超时覆盖结构化配置字段', () => {
  for (const id of [
    'hm-provider-overrides-save',
    'hm-provider-overrides-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 MCP 服务结构化配置字段', () => {
  for (const id of [
    'hm-mcp-servers-save',
    'hm-mcp-servers-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Hooks 结构化配置字段', () => {
  for (const id of [
    'hm-hooks-save',
    'hm-hooks-auto-accept',
    'hm-hooks-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露模型别名结构化配置字段', () => {
  for (const id of [
    'hm-model-aliases-save',
    'hm-model-aliases-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露全局禁用工具集结构化配置字段', () => {
  for (const id of [
    'hm-agent-toolsets-save',
    'hm-agent-disabled-toolsets',
    'hm-platform-toolsets-save',
    'hm-platform-toolsets-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Agent 长跑保护结构化配置字段', () => {
  for (const id of [
    'hm-agent-runtime-save',
    'hm-agent-max-turns',
    'hm-agent-gateway-timeout',
    'hm-agent-restart-drain-timeout',
    'hm-agent-api-max-retries',
    'hm-agent-gateway-timeout-warning',
    'hm-agent-clarify-timeout',
    'hm-agent-gateway-notify-interval',
    'hm-agent-gateway-auto-continue-freshness',
    'hm-agent-image-input-mode',
    'hm-agent-reasoning-effort',
    'hm-agent-verbose',
    'hm-agent-personalities-json',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露未授权 DM 全局策略字段', () => {
  for (const id of [
    'hm-unauthorized-dm-save',
    'hm-unauthorized-dm-behavior',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Tirith 安全扫描结构化配置字段', () => {
  for (const id of [
    'hm-security-save',
    'hm-security-tirith-enabled',
    'hm-security-tirith-path',
    'hm-security-tirith-timeout',
    'hm-security-tirith-fail-open',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露响应节奏结构化配置字段', () => {
  for (const id of [
    'hm-human-delay-save',
    'hm-human-delay-mode',
    'hm-human-delay-min-ms',
    'hm-human-delay-max-ms',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露全局显示与可靠性结构化配置字段', () => {
  for (const id of [
    'hm-display-save',
    'hm-display-tool-progress',
    'hm-display-compact',
    'hm-display-skin',
    'hm-display-tool-prefix',
    'hm-display-show-reasoning',
    'hm-display-tool-preview-length',
    'hm-display-cleanup-progress',
    'hm-display-tool-progress-command',
    'hm-display-interim-assistant-messages',
    'hm-display-runtime-footer-enabled',
    'hm-display-runtime-footer-fields',
    'hm-display-file-mutation-verifier',
    'hm-display-show-cost',
    'hm-dashboard-show-token-analytics',
    'hm-display-language',
    'hm-display-resume-display',
    'hm-display-busy-input-mode',
    'hm-display-background-process-notifications',
    'hm-display-final-response-markdown',
    'hm-display-persistent-output-max-lines',
    'hm-display-timestamps',
    'hm-display-bell-on-complete',
    'hm-display-persistent-output',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露提示缓存结构化配置字段', () => {
  for (const id of [
    'hm-prompt-caching-save',
    'hm-prompt-cache-ttl',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 OpenRouter 响应缓存结构化配置字段', () => {
  for (const id of [
    'hm-openrouter-cache-save',
    'hm-openrouter-response-cache',
    'hm-openrouter-response-cache-ttl',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 OpenRouter Provider Routing 结构化配置字段', () => {
  for (const id of [
    'hm-provider-routing-save',
    'hm-provider-routing-sort',
    'hm-provider-routing-only',
    'hm-provider-routing-ignore',
    'hm-provider-routing-order',
    'hm-provider-routing-require-parameters',
    'hm-provider-routing-data-collection',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露辅助模型结构化配置字段', () => {
  for (const id of [
    'hm-auxiliary-save',
    'hm-auxiliary-vision-provider',
    'hm-auxiliary-vision-model',
    'hm-auxiliary-vision-timeout',
    'hm-auxiliary-vision-download-timeout',
    'hm-auxiliary-web-extract-provider',
    'hm-auxiliary-web-extract-model',
    'hm-auxiliary-session-search-provider',
    'hm-auxiliary-session-search-model',
    'hm-auxiliary-session-search-timeout',
    'hm-auxiliary-session-search-max-concurrency',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露网关流式结构化配置字段', () => {
  for (const id of [
    'hm-streaming-save',
    'hm-streaming-enabled',
    'hm-streaming-transport',
    'hm-streaming-edit-interval',
    'hm-streaming-buffer-threshold',
    'hm-streaming-cursor',
    'hm-streaming-fresh-final-after-seconds',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露执行与委派限制结构化配置字段', () => {
  for (const id of [
    'hm-execution-limits-save',
    'hm-code-execution-mode',
    'hm-code-execution-timeout',
    'hm-code-execution-max-tool-calls',
    'hm-delegation-max-iterations',
    'hm-delegation-child-timeout-seconds',
    'hm-delegation-max-concurrent-children',
    'hm-delegation-max-spawn-depth',
    'hm-delegation-model',
    'hm-delegation-provider',
    'hm-delegation-orchestrator-enabled',
    'hm-delegation-subagent-auto-approve',
    'hm-delegation-inherit-mcp-toolsets',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露输入输出保护结构化配置字段', () => {
  for (const id of [
    'hm-io-safety-save',
    'hm-file-read-max-chars',
    'hm-tool-output-max-bytes',
    'hm-tool-output-max-lines',
    'hm-tool-output-max-line-length',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露文件快照回滚结构化配置字段', () => {
  for (const id of [
    'hm-checkpoints-save',
    'hm-checkpoints-enabled',
    'hm-checkpoints-max-snapshots',
    'hm-checkpoints-max-total-size-mb',
    'hm-checkpoints-max-file-size-mb',
    'hm-checkpoints-auto-prune',
    'hm-checkpoints-retention-days',
    'hm-checkpoints-delete-orphans',
    'hm-checkpoints-min-interval-hours',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露审批安全结构化配置字段', () => {
  for (const id of [
    'hm-approvals-save',
    'hm-approval-mode',
    'hm-approval-timeout',
    'hm-approval-cron-mode',
    'hm-approval-mcp-reload-confirm',
    'hm-approval-destructive-slash-confirm',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露定时任务结构化配置字段', () => {
  for (const id of [
    'hm-cron-save',
    'hm-cron-wrap-response',
    'hm-cron-max-parallel-jobs',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露运行日志结构化配置字段', () => {
  for (const id of [
    'hm-logging-save',
    'hm-logging-level',
    'hm-logging-max-size-mb',
    'hm-logging-backup-count',
    'hm-logging-memory-monitor-enabled',
    'hm-logging-memory-monitor-interval-seconds',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露隐私脱敏结构化配置字段', () => {
  for (const id of [
    'hm-privacy-save',
    'hm-privacy-redact-pii',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露浏览器基础结构化配置字段', () => {
  for (const id of [
    'hm-browser-save',
    'hm-browser-inactivity-timeout',
    'hm-browser-command-timeout',
    'hm-browser-record-sessions',
    'hm-browser-engine',
    'hm-browser-allow-private-urls',
    'hm-browser-auto-local-for-private-urls',
    'hm-browser-cdp-url',
    'hm-browser-dialog-policy',
    'hm-browser-dialog-timeout',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Web 工具后端结构化配置字段', () => {
  for (const id of [
    'hm-web-config-save',
    'hm-web-backend',
    'hm-web-search-backend',
    'hm-web-extract-backend',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 LSP 语义诊断结构化配置字段', () => {
  for (const id of [
    'hm-lsp-save',
    'hm-lsp-enabled',
    'hm-lsp-wait-mode',
    'hm-lsp-wait-timeout',
    'hm-lsp-install-strategy',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露终端执行结构化配置字段', () => {
  for (const id of [
    'hm-terminal-save',
    'hm-terminal-backend',
    'hm-terminal-cwd',
    'hm-terminal-timeout',
    'hm-terminal-lifetime-seconds',
    'hm-terminal-shell-init-files',
    'hm-terminal-auto-source-bashrc',
    'hm-terminal-persistent-shell',
    'hm-terminal-env-passthrough',
    'hm-terminal-docker-mount-cwd-to-workspace',
    'hm-terminal-docker-run-as-host-user',
    'hm-terminal-docker-image',
    'hm-terminal-docker-forward-env',
    'hm-terminal-docker-env-json',
    'hm-terminal-docker-volumes',
    'hm-terminal-docker-extra-args',
    'hm-terminal-singularity-image',
    'hm-terminal-modal-image',
    'hm-terminal-modal-mode',
    'hm-terminal-vercel-runtime',
    'hm-terminal-daytona-image',
    'hm-terminal-ssh-host',
    'hm-terminal-ssh-user',
    'hm-terminal-ssh-port',
    'hm-terminal-ssh-key',
    'hm-terminal-container-cpu',
    'hm-terminal-container-memory',
    'hm-terminal-container-disk',
    'hm-terminal-container-persistent',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露语音转写结构化配置字段', () => {
  for (const id of [
    'hm-stt-save',
    'hm-stt-enabled',
    'hm-stt-provider',
    'hm-stt-local-model',
    'hm-stt-local-language',
    'hm-stt-openai-model',
    'hm-stt-mistral-model',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露语音输出与录音结构化配置字段', () => {
  for (const id of [
    'hm-tts-voice-save',
    'hm-tts-provider',
    'hm-tts-edge-voice',
    'hm-tts-openai-model',
    'hm-tts-openai-voice',
    'hm-tts-elevenlabs-voice-id',
    'hm-tts-elevenlabs-model-id',
    'hm-tts-xai-voice-id',
    'hm-tts-xai-language',
    'hm-tts-xai-sample-rate',
    'hm-tts-xai-bit-rate',
    'hm-tts-mistral-model',
    'hm-tts-mistral-voice-id',
    'hm-tts-piper-voice',
    'hm-voice-record-key',
    'hm-voice-max-recording-seconds',
    'hm-voice-auto-tts',
    'hm-voice-beep-enabled',
    'hm-voice-silence-threshold',
    'hm-voice-silence-duration',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页会暴露 Kanban 调度稳定性结构化配置字段', () => {
  for (const id of [
    'hm-kanban-config-save',
    'hm-kanban-dispatch-in-gateway',
    'hm-kanban-dispatch-interval-seconds',
    'hm-kanban-max-spawn',
    'hm-kanban-max-in-progress',
    'hm-kanban-failure-limit',
    'hm-kanban-auto-decompose',
    'hm-kanban-auto-decompose-per-tick',
    'hm-kanban-worker-log-rotate-bytes',
    'hm-kanban-worker-log-backup-count',
    'hm-kanban-orchestrator-profile',
    'hm-kanban-default-assignee',
    'hm-kanban-dispatch-stale-timeout-seconds',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `缺少 ${id}`)
  }
})

test('Hermes 配置页数值输入会保留 0 值显示', () => {
  assert.doesNotMatch(source, /String\(value \|\| ''\)/, 'esc(value) 不能把合法 0 渲染为空字符串')
})

test('Hermes 配置页新增结构化配置不会暴露翻译 key', () => {
  const keys = new Set(extractEngineKeys().filter(key => (
    key.includes('ToolGuardrails') ||
    key.includes('MemoryConfig') ||
    key.includes('SkillsConfig') ||
    key.includes('QuickCommandsConfig') ||
    key.includes('ProviderOverridesConfig') ||
    key.includes('McpServersConfig') ||
    key.includes('HooksConfig') ||
    key.includes('ModelAliasesConfig') ||
    key.includes('AgentToolsetsConfig') ||
    key.includes('AgentRuntimeConfig') ||
    key.includes('UnauthorizedDmConfig') ||
    key.includes('SecurityConfig') ||
    key.includes('HumanDelayConfig') ||
    key.includes('DisplayConfig') ||
    key.includes('PromptCachingConfig') ||
    key.includes('OpenrouterCacheConfig') ||
    key.includes('ProviderRoutingConfig') ||
    key.includes('AuxiliaryConfig') ||
    key.includes('StreamingConfig') ||
    key.includes('ExecutionLimits') ||
    key.includes('PrivacyConfig') ||
    key.includes('BrowserConfig') ||
    key.includes('WebConfig') ||
    key.includes('TerminalConfig') ||
    key.includes('SttConfig') ||
    key.includes('KanbanConfig') ||
    key.includes('CheckpointsConfig') ||
    key.includes('UpdatesConfig') ||
    key.includes('ApprovalsConfig') ||
    key.includes('CronConfig') ||
    key.includes('LoggingConfig') ||
    key.includes('Worktree')
  )))

  assert.ok(keys.size > 0, '应能提取新增结构化配置用到的 engine 翻译 key')
  for (const key of keys) {
    assert.notEqual(t(key), key, `${key} 缺少运行时翻译`)
  }
})
