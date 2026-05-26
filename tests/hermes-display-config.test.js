import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesDisplayConfigValues,
  mergeHermesDisplayConfig,
} from '../scripts/dev-api.js'

test('Hermes 显示配置读取会提供上游默认值', () => {
  const values = buildHermesDisplayConfigValues({})

  assert.deepEqual(values, {
    displayToolProgress: 'all',
    displayCompact: false,
    displaySkin: 'default',
    displayToolPrefix: '┊',
    displayShowReasoning: false,
    displayToolPreviewLength: 0,
    displayCleanupProgress: false,
    displayToolProgressCommand: false,
    displayInterimAssistantMessages: true,
    displayRuntimeFooterEnabled: false,
    displayRuntimeFooterFields: 'model\ncontext_pct\ncwd',
    displayFileMutationVerifier: true,
    displayShowCost: false,
    dashboardShowTokenAnalytics: false,
    displayLanguage: 'en',
    displayResumeDisplay: 'full',
    displayBusyInputMode: 'interrupt',
    displayBackgroundProcessNotifications: 'all',
    displayFinalResponseMarkdown: 'strip',
    displayTimestamps: false,
    displayBellOnComplete: false,
    displayPersistentOutput: true,
    displayPersistentOutputMaxLines: 200,
    displayInlineDiffs: true,
    displayTuiAutoResumeRecent: false,
    displayTuiStatusIndicator: 'kaomoji',
    displayUserMessagePreviewFirstLines: 2,
    displayUserMessagePreviewLastLines: 2,
    displayEphemeralSystemTtl: 0,
    displayCopyShortcut: 'auto',
  })
})

test('Hermes 显示配置读取会规范化已有字段', () => {
  const values = buildHermesDisplayConfigValues({
    display: {
      tool_progress: 'VERBOSE',
      compact: true,
      skin: 'MONO',
      tool_prefix: '╎',
      show_reasoning: true,
      tool_preview_length: 80,
      cleanup_progress: true,
      tool_progress_command: true,
      interim_assistant_messages: false,
      runtime_footer: {
        enabled: true,
        fields: ['model', 'duration', 'cost'],
      },
      file_mutation_verifier: false,
      show_cost: true,
      language: 'ZH',
      resume_display: 'minimal',
      busy_input_mode: 'QUEUE',
      background_process_notifications: 'ERROR',
      final_response_markdown: 'RAW',
      timestamps: true,
      bell_on_complete: true,
      persistent_output: false,
      persistent_output_max_lines: 80,
      inline_diffs: false,
      tui_auto_resume_recent: true,
      tui_status_indicator: 'EMOJI',
      user_message_preview: {
        first_lines: 3,
        last_lines: 1,
      },
      ephemeral_system_ttl: 120,
      copy_shortcut: 'CTRL_SHIFT_C',
    },
    dashboard: {
      show_token_analytics: true,
    },
  })

  assert.equal(values.displayToolProgress, 'verbose')
  assert.equal(values.displayCompact, true)
  assert.equal(values.displaySkin, 'mono')
  assert.equal(values.displayToolPrefix, '╎')
  assert.equal(values.displayShowReasoning, true)
  assert.equal(values.displayToolPreviewLength, 80)
  assert.equal(values.displayCleanupProgress, true)
  assert.equal(values.displayToolProgressCommand, true)
  assert.equal(values.displayInterimAssistantMessages, false)
  assert.equal(values.displayRuntimeFooterEnabled, true)
  assert.equal(values.displayRuntimeFooterFields, 'model\nduration\ncost')
  assert.equal(values.displayFileMutationVerifier, false)
  assert.equal(values.displayShowCost, true)
  assert.equal(values.dashboardShowTokenAnalytics, true)
  assert.equal(values.displayLanguage, 'zh')
  assert.equal(values.displayResumeDisplay, 'minimal')
  assert.equal(values.displayBusyInputMode, 'queue')
  assert.equal(values.displayBackgroundProcessNotifications, 'error')
  assert.equal(values.displayFinalResponseMarkdown, 'raw')
  assert.equal(values.displayTimestamps, true)
  assert.equal(values.displayBellOnComplete, true)
  assert.equal(values.displayPersistentOutput, false)
  assert.equal(values.displayPersistentOutputMaxLines, 80)
  assert.equal(values.displayInlineDiffs, false)
  assert.equal(values.displayTuiAutoResumeRecent, true)
  assert.equal(values.displayTuiStatusIndicator, 'emoji')
  assert.equal(values.displayUserMessagePreviewFirstLines, 3)
  assert.equal(values.displayUserMessagePreviewLastLines, 1)
  assert.equal(values.displayEphemeralSystemTtl, 120)
  assert.equal(values.displayCopyShortcut, 'ctrl_shift_c')
})

test('Hermes 显示配置保存会保留未知 YAML 并写入 display', () => {
  const next = mergeHermesDisplayConfig({
    model: { provider: 'anthropic' },
    display: {
      skin: 'midnight',
      runtime_footer: {
        enabled: false,
        custom_flag: 'keep-footer',
      },
      user_message_preview: {
        custom_flag: 'keep-preview',
      },
      platforms: {
        telegram: { tool_progress: 'new' },
      },
      custom_flag: 'keep-display',
    },
    dashboard: {
      custom_flag: 'keep-dashboard',
    },
    memory: { memory_enabled: true },
  }, {
    displayToolProgress: 'off',
    displayCompact: true,
    displaySkin: 'slate',
    displayToolPrefix: '│',
    displayShowReasoning: true,
    displayToolPreviewLength: 120,
    displayCleanupProgress: true,
    displayToolProgressCommand: 'true',
    displayInterimAssistantMessages: false,
    displayRuntimeFooterEnabled: true,
    displayRuntimeFooterFields: 'model\ncontext_pct\nduration',
    displayFileMutationVerifier: true,
    displayShowCost: true,
    dashboardShowTokenAnalytics: true,
    displayLanguage: 'zh-hant',
    displayResumeDisplay: 'minimal',
    displayBusyInputMode: 'steer',
    displayBackgroundProcessNotifications: 'result',
    displayFinalResponseMarkdown: 'render',
    displayTimestamps: true,
    displayBellOnComplete: true,
    displayPersistentOutput: false,
    displayPersistentOutputMaxLines: 120,
    displayInlineDiffs: false,
    displayTuiAutoResumeRecent: true,
    displayTuiStatusIndicator: 'ascii',
    displayUserMessagePreviewFirstLines: 4,
    displayUserMessagePreviewLastLines: 0,
    displayEphemeralSystemTtl: 360,
    displayCopyShortcut: 'disabled',
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.memory, { memory_enabled: true })
  assert.equal(next.dashboard.custom_flag, 'keep-dashboard')
  assert.equal(next.dashboard.show_token_analytics, true)
  assert.equal(next.display.compact, true)
  assert.equal(next.display.skin, 'slate')
  assert.equal(next.display.tool_prefix, '│')
  assert.equal(next.display.show_reasoning, true)
  assert.equal(next.display.tool_preview_length, 120)
  assert.equal(next.display.cleanup_progress, true)
  assert.deepEqual(next.display.platforms.telegram, { tool_progress: 'new' })
  assert.equal(next.display.tool_progress, 'off')
  assert.equal(next.display.tool_progress_command, true)
  assert.equal(next.display.interim_assistant_messages, false)
  assert.equal(next.display.runtime_footer.enabled, true)
  assert.deepEqual(next.display.runtime_footer.fields, ['model', 'context_pct', 'duration'])
  assert.equal(next.display.runtime_footer.custom_flag, 'keep-footer')
  assert.equal(next.display.file_mutation_verifier, true)
  assert.equal(next.display.show_cost, true)
  assert.equal(next.display.language, 'zh-hant')
  assert.equal(next.display.resume_display, 'minimal')
  assert.equal(next.display.busy_input_mode, 'steer')
  assert.equal(next.display.background_process_notifications, 'result')
  assert.equal(next.display.final_response_markdown, 'render')
  assert.equal(next.display.timestamps, true)
  assert.equal(next.display.bell_on_complete, true)
  assert.equal(next.display.persistent_output, false)
  assert.equal(next.display.persistent_output_max_lines, 120)
  assert.equal(next.display.inline_diffs, false)
  assert.equal(next.display.tui_auto_resume_recent, true)
  assert.equal(next.display.tui_status_indicator, 'ascii')
  assert.equal(next.display.user_message_preview.first_lines, 4)
  assert.equal(next.display.user_message_preview.last_lines, 0)
  assert.equal(next.display.user_message_preview.custom_flag, 'keep-preview')
  assert.equal(next.display.ephemeral_system_ttl, 360)
  assert.equal(next.display.copy_shortcut, 'disabled')
  assert.equal(next.display.custom_flag, 'keep-display')
})

test('Hermes 显示配置保存会拒绝非法枚举和页脚字段', () => {
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayToolProgress: 'everything' }),
    /display\.tool_progress/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displaySkin: 'unknown' }),
    /display\.skin/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayToolPrefix: 'too-long-prefix' }),
    /display\.tool_prefix/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayResumeDisplay: 'compact' }),
    /display\.resume_display/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayLanguage: 'cn' }),
    /display\.language/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayRuntimeFooterFields: 'model\npassword' }),
    /display\.runtime_footer\.fields/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayBusyInputMode: 'replace' }),
    /display\.busy_input_mode/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayBackgroundProcessNotifications: 'silent' }),
    /display\.background_process_notifications/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayFinalResponseMarkdown: 'html' }),
    /display\.final_response_markdown/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayPersistentOutputMaxLines: '-1' }),
    /display\.persistent_output_max_lines/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayToolPreviewLength: '200001' }),
    /display\.tool_preview_length/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayTuiStatusIndicator: 'rainbow' }),
    /display\.tui_status_indicator/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayCopyShortcut: 'cmd_c' }),
    /display\.copy_shortcut/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayUserMessagePreviewFirstLines: '0' }),
    /display\.user_message_preview\.first_lines/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayUserMessagePreviewLastLines: '101' }),
    /display\.user_message_preview\.last_lines/,
  )
  assert.throws(
    () => mergeHermesDisplayConfig({}, { displayEphemeralSystemTtl: '86401' }),
    /display\.ephemeral_system_ttl/,
  )
})
