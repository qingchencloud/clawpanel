import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { t } from '../src/lib/i18n.js'

const source = readFileSync(new URL('../src/engines/hermes/pages/config.js', import.meta.url), 'utf8')

function extractEngineKeys() {
  return [...source.matchAll(/['"](engine\.[A-Za-z0-9_.-]+)['"]/g)].map(match => match[1])
}

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
    'hm-skills-external-dirs',
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
    'hm-display-tool-progress-command',
    'hm-display-interim-assistant-messages',
    'hm-display-runtime-footer-enabled',
    'hm-display-runtime-footer-fields',
    'hm-display-file-mutation-verifier',
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
    'hm-terminal-docker-mount-cwd-to-workspace',
    'hm-terminal-docker-run-as-host-user',
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
    key.includes('TerminalConfig') ||
    key.includes('SttConfig') ||
    key.includes('CheckpointsConfig') ||
    key.includes('ApprovalsConfig') ||
    key.includes('CronConfig') ||
    key.includes('LoggingConfig')
  )))

  assert.ok(keys.size > 0, '应能提取新增结构化配置用到的 engine 翻译 key')
  for (const key of keys) {
    assert.notEqual(t(key), key, `${key} 缺少运行时翻译`)
  }
})
