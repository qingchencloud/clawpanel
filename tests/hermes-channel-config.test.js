import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesChannelEnvUpdates,
  buildHermesChannelConfigValues,
  mergeHermesChannelConfig,
} from '../scripts/dev-api.js'

test('Hermes 渠道读取会从 platforms 平台配置生成稳定表单值', () => {
  const values = buildHermesChannelConfigValues({
    platforms: {
      telegram: {
        enabled: true,
        token: '123:token',
        extra: {
          dm_policy: 'pair',
          group_policy: 'allowlist',
          allow_from: ['1001', '1002'],
          require_mention: true,
          reply_to_mode: 'all',
          guest_mode: true,
          disable_link_previews: true,
        },
      },
    },
  })

  assert.equal(values.telegram.enabled, true)
  assert.equal(values.telegram.botToken, '123:token')
  assert.equal(values.telegram.dmPolicy, 'pair')
  assert.equal(values.telegram.groupPolicy, 'allowlist')
  assert.equal(values.telegram.allowFrom, '1001, 1002')
  assert.equal(values.telegram.requireMention, true)
  assert.equal(values.telegram.replyToMode, 'all')
  assert.equal(values.telegram.guestMode, true)
  assert.equal(values.telegram.disableLinkPreviews, true)
})

test('Hermes 渠道读取会按运行时优先级合并 .env 凭证', () => {
  const values = buildHermesChannelConfigValues({
    platforms: {
      telegram: {
        enabled: true,
        token: 'yaml-token',
        extra: {
          allow_from: ['1001'],
        },
      },
      feishu: {
        enabled: true,
        extra: {
          app_id: 'yaml-app-id',
          app_secret: 'yaml-secret',
          domain: 'lark',
          connection_mode: 'webhook',
        },
      },
      dingtalk: {
        enabled: true,
        extra: {
          client_id: 'yaml-client-id',
          client_secret: 'yaml-client-secret',
          allowed_users: ['staff-1'],
          allowed_chats: ['cid-1'],
        },
      },
    },
  }, {
    TELEGRAM_BOT_TOKEN: 'env-token',
    FEISHU_APP_ID: 'env-app-id',
    FEISHU_APP_SECRET: 'env-secret',
    FEISHU_DOMAIN: 'feishu',
    FEISHU_CONNECTION_MODE: 'websocket',
    DINGTALK_CLIENT_ID: 'env-client-id',
    DINGTALK_CLIENT_SECRET: 'env-client-secret',
  })

  assert.equal(values.telegram.botToken, 'env-token')
  assert.equal(values.telegram.allowFrom, '1001')
  assert.equal(values.feishu.appId, 'env-app-id')
  assert.equal(values.feishu.appSecret, 'env-secret')
  assert.equal(values.feishu.domain, 'feishu')
  assert.equal(values.feishu.connectionMode, 'websocket')
  assert.equal(values.dingtalk.clientId, 'env-client-id')
  assert.equal(values.dingtalk.clientSecret, 'env-client-secret')
  assert.equal(values.dingtalk.allowFrom, 'staff-1')
  assert.equal(values.dingtalk.groupAllowFrom, 'cid-1')
})

test('Hermes 渠道保存会写入 Hermes 最新 platforms 配置并保留无关配置', () => {
  const next = mergeHermesChannelConfig({
    model: { provider: 'anthropic', default: 'claude-sonnet-4-6' },
    platforms: {
      telegram: {
        enabled: false,
        token: 'old',
        extra: {
          unknown_option: 'keep-me',
        },
      },
    },
  }, 'telegram', {
    enabled: true,
    botToken: '123:token',
    dmPolicy: 'pair',
    groupPolicy: 'allowlist',
    allowFrom: '1001, 1002',
    requireMention: true,
    replyToMode: 'off',
    guestMode: true,
    disableLinkPreviews: true,
  })

  assert.deepEqual(next.model, { provider: 'anthropic', default: 'claude-sonnet-4-6' })
  assert.equal(next.platforms.telegram.enabled, true)
  assert.equal(next.platforms.telegram.token, undefined)
  assert.equal(next.platforms.telegram.extra.dm_policy, 'pair')
  assert.equal(next.platforms.telegram.extra.group_policy, 'allowlist')
  assert.deepEqual(next.platforms.telegram.extra.allow_from, ['1001', '1002'])
  assert.equal(next.platforms.telegram.extra.require_mention, true)
  assert.equal(next.platforms.telegram.extra.reply_to_mode, 'off')
  assert.equal(next.platforms.telegram.extra.guest_mode, true)
  assert.equal(next.platforms.telegram.extra.disable_link_previews, true)
  assert.equal(next.platforms.telegram.extra.unknown_option, 'keep-me')
})

test('Hermes Telegram 保存会校验回复模式选项', () => {
  assert.throws(() => mergeHermesChannelConfig({}, 'telegram', {
    enabled: true,
    replyToMode: 'sometimes',
  }), /platforms\.telegram\.extra\.reply_to_mode/)
})

test('Hermes 飞书保存会补齐可运行默认项并使用 Hermes snake_case 字段', () => {
  const next = mergeHermesChannelConfig({}, 'feishu', {
    enabled: true,
    appId: 'cli_xxx',
    appSecret: 'secret',
    domain: '',
    connectionMode: '',
    webhookPath: '',
    reactionNotifications: '',
    typingIndicator: true,
    resolveSenderNames: true,
  })

  assert.equal(next.platforms.feishu.enabled, true)
  assert.equal(next.platforms.feishu.extra.app_id, undefined)
  assert.equal(next.platforms.feishu.extra.app_secret, undefined)
  assert.equal(next.platforms.feishu.extra.domain, 'feishu')
  assert.equal(next.platforms.feishu.extra.connection_mode, 'websocket')
  assert.equal(next.platforms.feishu.extra.webhook_path, '/feishu/webhook')
  assert.equal(next.platforms.feishu.extra.reaction_notifications, 'off')
  assert.equal(next.platforms.feishu.extra.typing_indicator, true)
  assert.equal(next.platforms.feishu.extra.resolve_sender_names, true)
})

test('Hermes 渠道保存会生成运行时仍会读取的环境变量', () => {
  const telegramEnv = buildHermesChannelEnvUpdates('telegram', {
    botToken: '123:token',
    allowFrom: '1001, 1002',
    groupAllowFrom: 'group-a\ngroup-b',
    requireMention: true,
    replyToMode: 'off',
    guestMode: true,
    disableLinkPreviews: true,
  })

  assert.equal(telegramEnv.TELEGRAM_BOT_TOKEN, '123:token')
  assert.equal(telegramEnv.TELEGRAM_ALLOWED_USERS, '1001,1002')
  assert.equal(telegramEnv.TELEGRAM_GROUP_ALLOWED_USERS, 'group-a,group-b')
  assert.equal(telegramEnv.TELEGRAM_REQUIRE_MENTION, 'true')
  assert.equal(telegramEnv.TELEGRAM_REPLY_TO_MODE, 'off')
  assert.equal(telegramEnv.TELEGRAM_GUEST_MODE, 'true')
  assert.equal(telegramEnv.TELEGRAM_DISABLE_LINK_PREVIEWS, 'true')

  const feishuEnv = buildHermesChannelEnvUpdates('feishu', {
    appId: 'cli_xxx',
    appSecret: 'secret',
    domain: '',
    connectionMode: '',
    webhookPath: '',
    groupPolicy: 'allowlist',
    reactionNotifications: 'off',
  })

  assert.equal(feishuEnv.FEISHU_APP_ID, 'cli_xxx')
  assert.equal(feishuEnv.FEISHU_APP_SECRET, 'secret')
  assert.equal(feishuEnv.FEISHU_DOMAIN, 'feishu')
  assert.equal(feishuEnv.FEISHU_CONNECTION_MODE, 'websocket')
  assert.equal(feishuEnv.FEISHU_WEBHOOK_PATH, '/feishu/webhook')
  assert.equal(feishuEnv.FEISHU_GROUP_POLICY, 'allowlist')
  assert.equal(feishuEnv.FEISHU_REACTIONS, 'false')

  const dingTalkEnv = buildHermesChannelEnvUpdates('dingtalk', {
    clientId: 'ding-app-key',
    clientSecret: 'ding-secret',
    allowFrom: 'staff-1, staff-2',
    groupAllowFrom: 'cid-1\ncid-2',
    requireMention: true,
  })

  assert.equal(dingTalkEnv.DINGTALK_CLIENT_ID, 'ding-app-key')
  assert.equal(dingTalkEnv.DINGTALK_CLIENT_SECRET, 'ding-secret')
  assert.equal(dingTalkEnv.DINGTALK_ALLOWED_USERS, 'staff-1,staff-2')
  assert.equal(dingTalkEnv.DINGTALK_ALLOWED_CHATS, 'cid-1,cid-2')
  assert.equal(dingTalkEnv.DINGTALK_REQUIRE_MENTION, 'true')
})

test('Hermes Discord 读取会回显新版插件运行字段并优先使用环境变量', () => {
  const values = buildHermesChannelConfigValues({
    platforms: {
      discord: {
        enabled: true,
        extra: {
          require_mention: true,
          thread_require_mention: true,
          free_response_channels: ['free-a', 'free-b'],
          allowed_channels: ['allow-a'],
          ignored_channels: ['ignore-a'],
          no_thread_channels: ['plain-a'],
          auto_thread: true,
          reactions: false,
          history_backfill: true,
          history_backfill_limit: '12',
          reply_to_mode: 'all',
        },
      },
    },
  }, {
    DISCORD_BOT_TOKEN: 'env-discord-token',
    DISCORD_HOME_CHANNEL: 'home-1',
    DISCORD_HOME_CHANNEL_NAME: 'ops-home',
    DISCORD_FREE_RESPONSE_CHANNELS: 'env-free',
    DISCORD_AUTO_THREAD: 'false',
  })

  assert.equal(values.discord.enabled, true)
  assert.equal(values.discord.token, 'env-discord-token')
  assert.equal(values.discord.freeResponseChannels, 'env-free')
  assert.equal(values.discord.allowedChannels, 'allow-a')
  assert.equal(values.discord.ignoredChannels, 'ignore-a')
  assert.equal(values.discord.noThreadChannels, 'plain-a')
  assert.equal(values.discord.autoThread, false)
  assert.equal(values.discord.reactions, false)
  assert.equal(values.discord.threadRequireMention, true)
  assert.equal(values.discord.historyBackfill, true)
  assert.equal(values.discord.historyBackfillLimit, '12')
  assert.equal(values.discord.replyToMode, 'all')
  assert.equal(values.discord.homeChannel, 'home-1')
  assert.equal(values.discord.homeChannelName, 'ops-home')
})

test('Hermes Discord 保存会写入新版插件 YAML 字段和运行时环境变量', () => {
  const next = mergeHermesChannelConfig({
    platforms: {
      discord: {
        enabled: true,
        token: 'old-token',
        extra: {
          unknown_option: 'keep-me',
        },
      },
    },
  }, 'discord', {
    enabled: true,
    token: 'discord-token',
    allowFrom: '1001, 1002',
    requireMention: true,
    freeResponseChannels: 'free-a\nfree-b',
    allowedChannels: 'allow-a',
    ignoredChannels: 'ignore-a',
    noThreadChannels: 'plain-a',
    autoThread: false,
    reactions: true,
    threadRequireMention: true,
    historyBackfill: true,
    historyBackfillLimit: '12',
    replyToMode: 'off',
    homeChannel: 'home-1',
    homeChannelName: 'ops-home',
  })

  assert.equal(next.platforms.discord.enabled, true)
  assert.equal(next.platforms.discord.token, undefined)
  assert.deepEqual(next.platforms.discord.extra.allow_from, ['1001', '1002'])
  assert.deepEqual(next.platforms.discord.extra.free_response_channels, ['free-a', 'free-b'])
  assert.deepEqual(next.platforms.discord.extra.allowed_channels, ['allow-a'])
  assert.deepEqual(next.platforms.discord.extra.ignored_channels, ['ignore-a'])
  assert.deepEqual(next.platforms.discord.extra.no_thread_channels, ['plain-a'])
  assert.equal(next.platforms.discord.extra.auto_thread, false)
  assert.equal(next.platforms.discord.extra.reactions, true)
  assert.equal(next.platforms.discord.extra.thread_require_mention, true)
  assert.equal(next.platforms.discord.extra.history_backfill, true)
  assert.equal(next.platforms.discord.extra.history_backfill_limit, '12')
  assert.equal(next.platforms.discord.extra.reply_to_mode, 'off')
  assert.equal(next.platforms.discord.extra.unknown_option, 'keep-me')

  const env = buildHermesChannelEnvUpdates('discord', {
    token: 'discord-token',
    allowFrom: '1001, 1002',
    requireMention: true,
    freeResponseChannels: 'free-a\nfree-b',
    allowedChannels: 'allow-a',
    ignoredChannels: 'ignore-a',
    noThreadChannels: 'plain-a',
    autoThread: false,
    reactions: true,
    threadRequireMention: true,
    historyBackfill: true,
    historyBackfillLimit: '12',
    replyToMode: 'off',
    homeChannel: 'home-1',
    homeChannelName: 'ops-home',
  })

  assert.equal(env.DISCORD_BOT_TOKEN, 'discord-token')
  assert.equal(env.DISCORD_ALLOWED_USERS, '1001,1002')
  assert.equal(env.DISCORD_FREE_RESPONSE_CHANNELS, 'free-a,free-b')
  assert.equal(env.DISCORD_ALLOWED_CHANNELS, 'allow-a')
  assert.equal(env.DISCORD_IGNORED_CHANNELS, 'ignore-a')
  assert.equal(env.DISCORD_NO_THREAD_CHANNELS, 'plain-a')
  assert.equal(env.DISCORD_AUTO_THREAD, 'false')
  assert.equal(env.DISCORD_REACTIONS, 'true')
  assert.equal(env.DISCORD_THREAD_REQUIRE_MENTION, 'true')
  assert.equal(env.DISCORD_HISTORY_BACKFILL, 'true')
  assert.equal(env.DISCORD_HISTORY_BACKFILL_LIMIT, '12')
  assert.equal(env.DISCORD_REPLY_TO_MODE, 'off')
  assert.equal(env.DISCORD_HOME_CHANNEL, 'home-1')
  assert.equal(env.DISCORD_HOME_CHANNEL_NAME, 'ops-home')
})

test('Hermes 渠道保存会从 YAML 清理旧凭证，避免覆盖 .env 运行时值', () => {
  const next = mergeHermesChannelConfig({
    platforms: {
      slack: {
        enabled: true,
        token: 'old-bot-token',
        extra: {
          app_token: 'old-app-token',
          signing_secret: 'old-signing-secret',
          webhook_path: '/old/events',
          unknown_option: 'keep-me',
        },
      },
    },
  }, 'slack', {
    enabled: true,
    botToken: 'xoxb-new',
    appToken: 'xapp-new',
    signingSecret: 'new-signing-secret',
    webhookPath: '/slack/events',
  })

  assert.equal(next.platforms.slack.token, undefined)
  assert.equal(next.platforms.slack.extra.app_token, undefined)
  assert.equal(next.platforms.slack.extra.signing_secret, undefined)
  assert.equal(next.platforms.slack.extra.webhook_path, '/slack/events')
  assert.equal(next.platforms.slack.extra.unknown_option, 'keep-me')
})

test('Hermes Slack 保存会将 signingSecret 写入 SLACK_SIGNING_SECRET 环境变量', () => {
  const env = buildHermesChannelEnvUpdates('slack', {
    botToken: 'xoxb-new',
    appToken: 'xapp-new',
    signingSecret: 'new-signing-secret',
    allowFrom: ['U1'],
    requireMention: true,
  })

  assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-new')
  assert.equal(env.SLACK_APP_TOKEN, 'xapp-new')
  assert.equal(env.SLACK_SIGNING_SECRET, 'new-signing-secret')
  assert.equal(env.SLACK_ALLOWED_USERS, 'U1')
  assert.equal(env.SLACK_REQUIRE_MENTION, 'true')
})

test('Hermes Slack 读取会从 SLACK_SIGNING_SECRET 环境变量回填 signingSecret', () => {
  const values = buildHermesChannelConfigValues({
    platforms: {
      slack: {
        enabled: true,
        extra: {
          webhook_path: '/slack/events',
        },
      },
    },
  }, {
    SLACK_BOT_TOKEN: 'xoxb-env',
    SLACK_APP_TOKEN: 'xapp-env',
    SLACK_SIGNING_SECRET: 'signing-from-env',
  })

  assert.equal(values.slack.botToken, 'xoxb-env')
  assert.equal(values.slack.appToken, 'xapp-env')
  assert.equal(values.slack.signingSecret, 'signing-from-env')
})

test('Hermes 钉钉保存会使用运行时实际读取的字段', () => {
  const next = mergeHermesChannelConfig({
    platforms: {
      dingtalk: {
        enabled: true,
        extra: {
          client_id: 'old-client-id',
          client_secret: 'old-client-secret',
          group_allow_from: ['legacy-chat'],
          unknown_option: 'keep-me',
        },
      },
    },
  }, 'dingtalk', {
    enabled: true,
    clientId: 'ding-app-key',
    clientSecret: 'ding-secret',
    allowFrom: 'staff-1, staff-2',
    groupAllowFrom: 'cid-1\ncid-2',
    requireMention: true,
  })

  assert.equal(next.platforms.dingtalk.enabled, true)
  assert.equal(next.platforms.dingtalk.extra.client_id, undefined)
  assert.equal(next.platforms.dingtalk.extra.client_secret, undefined)
  assert.equal(next.platforms.dingtalk.extra.group_allow_from, undefined)
  assert.deepEqual(next.platforms.dingtalk.extra.allowed_users, ['staff-1', 'staff-2'])
  assert.deepEqual(next.platforms.dingtalk.extra.allowed_chats, ['cid-1', 'cid-2'])
  assert.equal(next.platforms.dingtalk.extra.require_mention, true)
  assert.equal(next.platforms.dingtalk.extra.unknown_option, 'keep-me')
})

test('Hermes 插件平台读取会回显上游运行字段并优先使用环境变量', () => {
  const values = buildHermesChannelConfigValues({
    platforms: {
      teams: {
        enabled: true,
        extra: {
          client_id: 'yaml-teams-client',
          client_secret: 'yaml-teams-secret',
          tenant_id: 'yaml-tenant',
          port: 3978,
          service_url: 'https://smba.trafficmanager.net/teams/',
          allow_from: ['aad-1'],
        },
      },
      google_chat: {
        enabled: true,
        extra: {
          project_id: 'yaml-project',
          subscription_name: 'projects/yaml-project/subscriptions/hermes',
          service_account_json: 'yaml-sa.json',
          allow_from: ['user@example.com'],
        },
      },
      irc: {
        enabled: true,
        extra: {
          server: 'irc.libera.chat',
          channel: '#hermes',
          nickname: 'hermes-bot',
          use_tls: true,
          allowed_users: ['alice'],
        },
      },
      line: {
        enabled: true,
        extra: {
          channel_access_token: 'yaml-line-token',
          channel_secret: 'yaml-line-secret',
          host: '0.0.0.0',
          port: 8646,
          public_url: 'https://line.example.com',
          allowed_users: ['U1'],
          allowed_groups: ['C1'],
          allowed_rooms: ['R1'],
          slow_response_threshold: '45',
        },
      },
      simplex: {
        enabled: true,
        extra: {
          ws_url: 'ws://127.0.0.1:5225',
          allowed_users: ['contact-1'],
        },
      },
    },
  }, {
    TEAMS_CLIENT_ID: 'env-teams-client',
    TEAMS_CLIENT_SECRET: 'env-teams-secret',
    TEAMS_TENANT_ID: 'env-tenant',
    TEAMS_HOME_CHANNEL: 'teams-home',
    TEAMS_HOME_CHANNEL_NAME: 'Ops',
    GOOGLE_CHAT_PROJECT_ID: 'env-project',
    GOOGLE_CHAT_SUBSCRIPTION_NAME: 'projects/env-project/subscriptions/hermes',
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: 'env-sa.json',
    GOOGLE_CHAT_HOME_CHANNEL: 'spaces/AAA',
    IRC_SERVER: 'irc.oftc.net',
    IRC_CHANNEL: '#ops',
    IRC_NICKNAME: 'ops-bot',
    IRC_HOME_CHANNEL: '#reports',
    LINE_CHANNEL_ACCESS_TOKEN: 'env-line-token',
    LINE_CHANNEL_SECRET: 'env-line-secret',
    LINE_HOME_CHANNEL: 'U-home',
    SIMPLEX_WS_URL: 'ws://127.0.0.1:5226',
    SIMPLEX_HOME_CHANNEL: 'contact-home',
  })

  assert.equal(values.teams.clientId, 'env-teams-client')
  assert.equal(values.teams.clientSecret, 'env-teams-secret')
  assert.equal(values.teams.tenantId, 'env-tenant')
  assert.equal(values.teams.homeChannel, 'teams-home')
  assert.equal(values.teams.allowFrom, 'aad-1')
  assert.equal(values.google_chat.projectId, 'env-project')
  assert.equal(values.google_chat.subscriptionName, 'projects/env-project/subscriptions/hermes')
  assert.equal(values.google_chat.serviceAccountJson, 'env-sa.json')
  assert.equal(values.google_chat.homeChannel, 'spaces/AAA')
  assert.equal(values.irc.server, 'irc.oftc.net')
  assert.equal(values.irc.channel, '#ops')
  assert.equal(values.irc.nickname, 'ops-bot')
  assert.equal(values.irc.homeChannel, '#reports')
  assert.equal(values.irc.useTls, true)
  assert.equal(values.irc.allowFrom, 'alice')
  assert.equal(values.line.channelAccessToken, 'env-line-token')
  assert.equal(values.line.channelSecret, 'env-line-secret')
  assert.equal(values.line.homeChannel, 'U-home')
  assert.equal(values.line.allowedGroups, 'C1')
  assert.equal(values.line.allowedRooms, 'R1')
  assert.equal(values.simplex.wsUrl, 'ws://127.0.0.1:5226')
  assert.equal(values.simplex.homeChannel, 'contact-home')
  assert.equal(values.simplex.allowFrom, 'contact-1')
})

test('Hermes 插件平台保存会写入运行时读取的 YAML 字段和环境变量', () => {
  const teams = mergeHermesChannelConfig({
    platforms: {
      teams: {
        enabled: true,
        extra: {
          client_id: 'old-client',
          client_secret: 'old-secret',
          tenant_id: 'old-tenant',
          unknown_option: 'keep-me',
        },
      },
    },
  }, 'teams', {
    enabled: true,
    clientId: 'teams-client',
    clientSecret: 'teams-secret',
    tenantId: 'tenant-1',
    port: '3978',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    allowFrom: 'aad-1, aad-2',
    allowAllUsers: false,
    homeChannel: '19:abc@thread.tacv2',
    homeChannelName: 'Ops',
  })

  assert.equal(teams.platforms.teams.extra.client_id, undefined)
  assert.equal(teams.platforms.teams.extra.client_secret, undefined)
  assert.equal(teams.platforms.teams.extra.tenant_id, undefined)
  assert.equal(teams.platforms.teams.extra.port, 3978)
  assert.equal(teams.platforms.teams.extra.service_url, 'https://smba.trafficmanager.net/teams/')
  assert.deepEqual(teams.platforms.teams.extra.allow_from, ['aad-1', 'aad-2'])
  assert.equal(teams.platforms.teams.extra.unknown_option, 'keep-me')

  const googleChat = mergeHermesChannelConfig({}, 'google_chat', {
    enabled: true,
    projectId: 'project-1',
    subscriptionName: 'projects/project-1/subscriptions/hermes',
    serviceAccountJson: 'C:\\keys\\sa.json',
    allowFrom: 'user@example.com',
    allowAllUsers: true,
    homeChannel: 'spaces/AAA',
    homeChannelName: 'Ops Space',
  })

  assert.equal(googleChat.platforms.google_chat.enabled, true)
  assert.equal(googleChat.platforms.google_chat.extra.project_id, 'project-1')
  assert.equal(googleChat.platforms.google_chat.extra.subscription_name, 'projects/project-1/subscriptions/hermes')
  assert.equal(googleChat.platforms.google_chat.extra.service_account_json, undefined)
  assert.deepEqual(googleChat.platforms.google_chat.extra.allow_from, ['user@example.com'])

  const irc = mergeHermesChannelConfig({}, 'irc', {
    enabled: true,
    server: 'irc.libera.chat',
    port: '6697',
    nickname: 'hermes-bot',
    channel: '#hermes',
    useTls: true,
    serverPassword: 'server-secret',
    nickservPassword: 'nick-secret',
    allowFrom: 'alice, bob',
    allowAllUsers: false,
    homeChannel: '#reports',
    homeChannelName: 'reports',
  })

  assert.equal(irc.platforms.irc.extra.server, 'irc.libera.chat')
  assert.equal(irc.platforms.irc.extra.port, 6697)
  assert.equal(irc.platforms.irc.extra.nickname, 'hermes-bot')
  assert.equal(irc.platforms.irc.extra.channel, '#hermes')
  assert.equal(irc.platforms.irc.extra.use_tls, true)
  assert.equal(irc.platforms.irc.extra.server_password, undefined)
  assert.equal(irc.platforms.irc.extra.nickserv_password, undefined)
  assert.deepEqual(irc.platforms.irc.extra.allowed_users, ['alice', 'bob'])

  const line = mergeHermesChannelConfig({}, 'line', {
    enabled: true,
    channelAccessToken: 'line-token',
    channelSecret: 'line-secret',
    port: '8646',
    host: '0.0.0.0',
    publicUrl: 'https://line.example.com',
    allowFrom: 'U1',
    allowedGroups: 'C1',
    allowedRooms: 'R1',
    allowAllUsers: false,
    homeChannel: 'U-home',
    slowResponseThreshold: '45',
  })

  assert.equal(line.platforms.line.extra.channel_access_token, undefined)
  assert.equal(line.platforms.line.extra.channel_secret, undefined)
  assert.equal(line.platforms.line.extra.port, 8646)
  assert.equal(line.platforms.line.extra.host, '0.0.0.0')
  assert.equal(line.platforms.line.extra.public_url, 'https://line.example.com')
  assert.deepEqual(line.platforms.line.extra.allowed_users, ['U1'])
  assert.deepEqual(line.platforms.line.extra.allowed_groups, ['C1'])
  assert.deepEqual(line.platforms.line.extra.allowed_rooms, ['R1'])
  assert.equal(line.platforms.line.extra.slow_response_threshold, '45')

  const simplex = mergeHermesChannelConfig({}, 'simplex', {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:5225',
    allowFrom: 'contact-1',
    allowAllUsers: true,
    homeChannel: 'group:ops',
    homeChannelName: 'Ops',
  })

  assert.equal(simplex.platforms.simplex.extra.ws_url, 'ws://127.0.0.1:5225')
  assert.deepEqual(simplex.platforms.simplex.extra.allowed_users, ['contact-1'])

  const env = {
    ...buildHermesChannelEnvUpdates('teams', {
      clientId: 'teams-client',
      clientSecret: 'teams-secret',
      tenantId: 'tenant-1',
      port: '3978',
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      allowFrom: 'aad-1, aad-2',
      allowAllUsers: false,
      homeChannel: '19:abc@thread.tacv2',
      homeChannelName: 'Ops',
    }),
    ...buildHermesChannelEnvUpdates('google_chat', {
      projectId: 'project-1',
      subscriptionName: 'projects/project-1/subscriptions/hermes',
      serviceAccountJson: 'C:\\keys\\sa.json',
      allowFrom: 'user@example.com',
      allowAllUsers: true,
      homeChannel: 'spaces/AAA',
      homeChannelName: 'Ops Space',
    }),
    ...buildHermesChannelEnvUpdates('irc', {
      server: 'irc.libera.chat',
      port: '6697',
      nickname: 'hermes-bot',
      channel: '#hermes',
      useTls: true,
      serverPassword: 'server-secret',
      nickservPassword: 'nick-secret',
      allowFrom: 'alice, bob',
      allowAllUsers: false,
      homeChannel: '#reports',
      homeChannelName: 'reports',
    }),
    ...buildHermesChannelEnvUpdates('line', {
      channelAccessToken: 'line-token',
      channelSecret: 'line-secret',
      port: '8646',
      host: '0.0.0.0',
      publicUrl: 'https://line.example.com',
      allowFrom: 'U1',
      allowedGroups: 'C1',
      allowedRooms: 'R1',
      allowAllUsers: false,
      homeChannel: 'U-home',
      slowResponseThreshold: '45',
    }),
    ...buildHermesChannelEnvUpdates('simplex', {
      wsUrl: 'ws://127.0.0.1:5225',
      allowFrom: 'contact-1',
      allowAllUsers: true,
      homeChannel: 'group:ops',
      homeChannelName: 'Ops',
    }),
  }

  assert.equal(env.TEAMS_CLIENT_ID, 'teams-client')
  assert.equal(env.TEAMS_CLIENT_SECRET, 'teams-secret')
  assert.equal(env.TEAMS_TENANT_ID, 'tenant-1')
  assert.equal(env.TEAMS_ALLOWED_USERS, 'aad-1,aad-2')
  assert.equal(env.TEAMS_ALLOW_ALL_USERS, 'false')
  assert.equal(env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON, 'C:\\keys\\sa.json')
  assert.equal(env.GOOGLE_CHAT_ALLOW_ALL_USERS, 'true')
  assert.equal(env.IRC_USE_TLS, 'true')
  assert.equal(env.IRC_SERVER_PASSWORD, 'server-secret')
  assert.equal(env.IRC_NICKSERV_PASSWORD, 'nick-secret')
  assert.equal(env.LINE_CHANNEL_ACCESS_TOKEN, 'line-token')
  assert.equal(env.LINE_ALLOWED_GROUPS, 'C1')
  assert.equal(env.SIMPLEX_WS_URL, 'ws://127.0.0.1:5225')
  assert.equal(env.SIMPLEX_ALLOW_ALL_USERS, 'true')
})

test('Hermes 渠道读取会回显平台级显示和进度策略', () => {
  const values = buildHermesChannelConfigValues({
    display: {
      tool_progress: 'all',
      show_reasoning: false,
      cleanup_progress: false,
      tool_progress_overrides: {
        discord: 'off',
      },
      platforms: {
        telegram: {
          tool_progress: 'new',
          show_reasoning: true,
          tool_preview_length: 80,
          streaming: false,
          cleanup_progress: true,
          custom_flag: 'keep-me',
        },
      },
    },
  })

  assert.equal(values.telegram.displayToolProgress, 'new')
  assert.equal(values.telegram.displayShowReasoning, true)
  assert.equal(values.telegram.displayToolPreviewLength, 80)
  assert.equal(values.telegram.displayStreaming, 'false')
  assert.equal(values.telegram.displayCleanupProgress, true)
  assert.equal(values.discord.displayToolProgress, 'off')
  assert.equal(values.discord.displayStreaming, 'inherit')
})

test('Hermes 渠道保存会写入 display.platforms 平台覆盖并保留未知字段', () => {
  const next = mergeHermesChannelConfig({
    display: {
      tool_progress: 'all',
      tool_progress_overrides: {
        telegram: 'off',
      },
      platforms: {
        telegram: {
          tool_progress: 'new',
          streaming: false,
          custom_flag: 'keep-me',
          runtime_footer: {
            enabled: true,
          },
        },
      },
    },
    platforms: {
      telegram: {
        enabled: true,
        extra: {
          unknown_option: 'keep-platform',
        },
      },
    },
  }, 'telegram', {
    enabled: true,
    botToken: '',
    displayToolProgress: 'verbose',
    displayShowReasoning: false,
    displayToolPreviewLength: '120',
    displayStreaming: 'inherit',
    displayCleanupProgress: false,
  })

  assert.equal(next.display.tool_progress, 'all')
  assert.equal(next.display.tool_progress_overrides.telegram, 'off')
  assert.equal(next.display.platforms.telegram.tool_progress, 'verbose')
  assert.equal(next.display.platforms.telegram.show_reasoning, false)
  assert.equal(next.display.platforms.telegram.tool_preview_length, 120)
  assert.equal(next.display.platforms.telegram.streaming, undefined)
  assert.equal(next.display.platforms.telegram.cleanup_progress, false)
  assert.equal(next.display.platforms.telegram.custom_flag, 'keep-me')
  assert.deepEqual(next.display.platforms.telegram.runtime_footer, { enabled: true })
  assert.equal(next.platforms.telegram.extra.unknown_option, 'keep-platform')
})

test('Hermes 渠道显示策略保存会拒绝无效选项和越界预览长度', () => {
  assert.throws(() => mergeHermesChannelConfig({}, 'telegram', {
    enabled: true,
    displayToolProgress: 'everything',
    displayToolPreviewLength: 80,
    displayStreaming: 'inherit',
  }), /display\.platforms\.telegram\.tool_progress/)

  assert.throws(() => mergeHermesChannelConfig({}, 'telegram', {
    enabled: true,
    displayToolProgress: 'all',
    displayToolPreviewLength: 200001,
    displayStreaming: 'inherit',
  }), /display\.platforms\.telegram\.tool_preview_length/)

  assert.throws(() => mergeHermesChannelConfig({}, 'telegram', {
    enabled: true,
    displayToolProgress: 'all',
    displayToolPreviewLength: 80,
    displayStreaming: 'global',
  }), /display\.platforms\.telegram\.streaming/)
})
