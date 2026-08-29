import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenClawChannelDiagnosis,
  buildMessagingPlatformFormValues,
  listPlatformAccounts,
  mergeOpenClawMessagingPlatformConfig,
  resolveMessagingCredentialValueForSave,
  resolvePlatformConfigEntry,
  normalizeMessagingPlatformForm,
} from '../scripts/dev-api.js'

test('渠道保存会为 Telegram 补齐新版 OpenClaw 必填访问策略', () => {
  const form = normalizeMessagingPlatformForm('telegram', {
    botToken: '123:token',
  })

  assert.equal(form.botToken, '123:token')
  assert.equal(form.dmPolicy, 'pairing')
  assert.equal(form.groupPolicy, 'allowlist')
})

test('渠道保存会把旧 UI 策略值转换为 OpenClaw 支持的枚举', () => {
  const form = normalizeMessagingPlatformForm('slack', {
    mode: 'socket',
    botToken: 'xoxb-token',
    appToken: 'xapp-token',
    dmPolicy: 'allow',
    groupPolicy: 'mentioned',
  })

  assert.equal(form.dmPolicy, 'open')
  assert.deepEqual(form.allowFrom, ['*'])
  assert.equal(form.groupPolicy, 'open')
  assert.equal(form.requireMention, true)
  assert.equal(form.webhookPath, '/slack/events')
  assert.equal(form.userTokenReadOnly, false)
})

test('渠道保存不会向不支持顶层 requireMention 的平台写入非法字段', () => {
  const form = normalizeMessagingPlatformForm('signal', {
    account: '+15551234567',
    dmPolicy: 'deny',
    groupPolicy: 'mentioned',
  })

  assert.equal(form.dmPolicy, 'disabled')
  assert.equal(form.groupPolicy, 'open')
  assert.equal(Object.hasOwn(form, 'requireMention'), false)
})

test('WhatsApp 渠道保存会写入扫码运行和访问策略字段并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'whatsapp',
    accountId: 'phone-a',
    form: {
      enabled: 'true',
      configWrites: 'true',
      sendReadReceipts: 'false',
      selfChatMode: 'true',
      dmPolicy: 'allowlist',
      allowFrom: '+15551234567, +15557654321',
      defaultTo: '+15550001111',
      groupPolicy: 'allowlist',
      groupAllowFrom: '120363@g.us, 120364@g.us',
      contextVisibility: 'allowlist_quote',
      historyLimit: '80',
      dmHistoryLimit: '20',
      mediaMaxMb: '50',
      debounceMs: '800',
      textChunkLimit: '1800',
      chunkMode: 'newline',
      blockStreaming: 'true',
      reactionLevel: 'ack',
      replyToMode: 'first',
      messagePrefix: '[WA]',
      responsePrefix: '[AI]',
      ackEmoji: '✅',
      ackDirect: 'true',
      ackGroup: 'mentions',
    },
  })

  const root = cfg.channels.whatsapp
  const account = root.accounts['phone-a']
  assert.equal(root.defaultAccount, 'phone-a')
  assert.equal(account.enabled, true)
  assert.equal(account.configWrites, true)
  assert.equal(account.sendReadReceipts, false)
  assert.equal(account.selfChatMode, true)
  assert.equal(account.dmPolicy, 'allowlist')
  assert.deepEqual(account.allowFrom, ['+15551234567', '+15557654321'])
  assert.equal(account.defaultTo, '+15550001111')
  assert.equal(account.groupPolicy, 'allowlist')
  assert.deepEqual(account.groupAllowFrom, ['120363@g.us', '120364@g.us'])
  assert.equal(account.contextVisibility, 'allowlist_quote')
  assert.equal(account.historyLimit, 80)
  assert.equal(account.dmHistoryLimit, 20)
  assert.equal(account.mediaMaxMb, 50)
  assert.equal(account.debounceMs, 800)
  assert.equal(account.textChunkLimit, 1800)
  assert.equal(account.chunkMode, 'newline')
  assert.equal(account.blockStreaming, true)
  assert.equal(account.reactionLevel, 'ack')
  assert.equal(account.replyToMode, 'first')
  assert.equal(account.messagePrefix, '[WA]')
  assert.equal(account.responsePrefix, '[AI]')
  assert.deepEqual(account.ackReaction, { emoji: '✅', direct: true, group: 'mentions' })
  assert.equal(cfg.plugins.entries.whatsapp.enabled, true)
})

test('WhatsApp 读取会回显扫码运行字段且诊断不要求 Bot Token', () => {
  const values = buildMessagingPlatformFormValues('whatsapp', {
    enabled: true,
    configWrites: true,
    sendReadReceipts: false,
    selfChatMode: true,
    dmPolicy: 'open',
    allowFrom: ['*'],
    groupPolicy: 'allowlist',
    groupAllowFrom: ['120363@g.us'],
    historyLimit: 50,
    debounceMs: 800,
    mediaMaxMb: 50,
    blockStreaming: true,
    ackReaction: { emoji: '✅', direct: true, group: 'mentions' },
  })
  const diagnosis = buildOpenClawChannelDiagnosis({
    platform: 'whatsapp',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.configWrites, 'true')
  assert.equal(values.sendReadReceipts, 'false')
  assert.equal(values.selfChatMode, 'true')
  assert.equal(values.allowFrom, '*')
  assert.equal(values.groupAllowFrom, '120363@g.us')
  assert.equal(values.historyLimit, '50')
  assert.equal(values.debounceMs, '800')
  assert.equal(values.mediaMaxMb, '50')
  assert.equal(values.blockStreaming, 'true')
  assert.equal(values.ackEmoji, '✅')
  assert.equal(values.ackDirect, 'true')
  assert.equal(values.ackGroup, 'mentions')
  assert.equal(diagnosis.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.match(diagnosis.checks.find(item => item.id === 'credentials')?.title || '', /扫码|会话/)
})

test('ClickClack 渠道保存会写入自托管运行字段并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'clickclack',
    accountId: 'work',
    form: {
      name: 'Ops Workspace',
      enabled: 'true',
      baseUrl: 'https://clickclack.example.com',
      token: 'clickclack-token',
      workspace: 'ops',
      botUserId: 'bot-1',
      agentId: 'agent-1',
      replyMode: 'model',
      model: 'claude-sonnet-4-5',
      systemPrompt: 'You are an ops assistant.',
      timeoutSeconds: '120',
      toolsAllow: 'shell, browser.search',
      senderIsOwner: 'true',
      defaultTo: 'channel:ops',
      allowFrom: 'channel:ops, dm:alice',
      reconnectMs: '2500',
    },
  })

  const root = cfg.channels.clickclack
  const account = root.accounts.work
  assert.equal(root.defaultAccount, 'work')
  assert.equal(account.enabled, true)
  assert.equal(account.name, 'Ops Workspace')
  assert.equal(account.baseUrl, 'https://clickclack.example.com')
  assert.equal(account.token, 'clickclack-token')
  assert.equal(account.workspace, 'ops')
  assert.equal(account.botUserId, 'bot-1')
  assert.equal(account.agentId, 'agent-1')
  assert.equal(account.replyMode, 'model')
  assert.equal(account.model, 'claude-sonnet-4-5')
  assert.equal(account.systemPrompt, 'You are an ops assistant.')
  assert.equal(account.timeoutSeconds, 120)
  assert.deepEqual(account.toolsAllow, ['shell', 'browser.search'])
  assert.equal(account.senderIsOwner, true)
  assert.equal(account.defaultTo, 'channel:ops')
  assert.deepEqual(account.allowFrom, ['channel:ops', 'dm:alice'])
  assert.equal(account.reconnectMs, 2500)
  assert.equal(cfg.plugins.entries.clickclack.enabled, true)
})

test('ClickClack 读取会回显运行字段且诊断要求 Base URL、Token 和 Workspace', () => {
  const values = buildMessagingPlatformFormValues('clickclack', {
    name: 'Ops Workspace',
    enabled: true,
    baseUrl: 'https://clickclack.example.com',
    token: 'clickclack-token',
    workspace: 'ops',
    botUserId: 'bot-1',
    agentId: 'agent-1',
    replyMode: 'agent',
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are an ops assistant.',
    timeoutSeconds: 90,
    toolsAllow: ['shell', 'browser.search'],
    senderIsOwner: false,
    defaultTo: 'channel:general',
    allowFrom: ['*'],
    reconnectMs: 1500,
  })
  const missingWorkspace = buildOpenClawChannelDiagnosis({
    platform: 'clickclack',
    configExists: true,
    channelEnabled: true,
    form: {
      baseUrl: 'https://clickclack.example.com',
      token: 'clickclack-token',
    },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'clickclack',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.baseUrl, 'https://clickclack.example.com')
  assert.equal(values.token, 'clickclack-token')
  assert.equal(values.workspace, 'ops')
  assert.equal(values.replyMode, 'agent')
  assert.equal(values.timeoutSeconds, '90')
  assert.equal(values.toolsAllow, 'shell, browser.search')
  assert.equal(values.senderIsOwner, 'false')
  assert.equal(values.allowFrom, '*')
  assert.equal(values.reconnectMs, '1500')
  assert.equal(missingWorkspace.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingWorkspace.checks.find(item => item.id === 'credentials')?.detail || '', /Workspace/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Nextcloud Talk 渠道保存会写入自托管 Talk 字段并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'nextcloud-talk',
    accountId: 'work',
    form: {
      enabled: 'true',
      name: 'Work Cloud',
      baseUrl: 'https://cloud.example.com',
      botSecret: 'bot-secret',
      apiUser: 'openclaw-bot',
      apiPassword: 'app-password',
      webhookPort: '8788',
      webhookHost: '0.0.0.0',
      webhookPath: '/nextcloud-talk-webhook',
      webhookPublicUrl: 'https://panel.example.com/nextcloud-talk-webhook',
      dmPolicy: 'allowlist',
      allowFrom: 'alice, bob',
      groupPolicy: 'mentioned',
      groupAllowFrom: 'room-token-1, room-token-2',
      historyLimit: '80',
      dmHistoryLimit: '20',
      mediaMaxMb: '50',
      textChunkLimit: '4000',
      chunkMode: 'newline',
      blockStreaming: 'true',
      responsePrefix: '[Talk]',
      dangerouslyAllowPrivateNetwork: 'true',
    },
  })

  const root = cfg.channels['nextcloud-talk']
  const account = root.accounts.work
  assert.equal(root.defaultAccount, 'work')
  assert.equal(account.enabled, true)
  assert.equal(account.name, 'Work Cloud')
  assert.equal(account.baseUrl, 'https://cloud.example.com')
  assert.equal(account.botSecret, 'bot-secret')
  assert.equal(account.apiUser, 'openclaw-bot')
  assert.equal(account.apiPassword, 'app-password')
  assert.equal(account.webhookPort, 8788)
  assert.equal(account.webhookHost, '0.0.0.0')
  assert.equal(account.webhookPath, '/nextcloud-talk-webhook')
  assert.equal(account.webhookPublicUrl, 'https://panel.example.com/nextcloud-talk-webhook')
  assert.equal(account.dmPolicy, 'allowlist')
  assert.deepEqual(account.allowFrom, ['alice', 'bob'])
  assert.equal(account.groupPolicy, 'open')
  assert.equal(account.requireMention, true)
  assert.deepEqual(account.groupAllowFrom, ['room-token-1', 'room-token-2'])
  assert.equal(account.historyLimit, 80)
  assert.equal(account.dmHistoryLimit, 20)
  assert.equal(account.mediaMaxMb, 50)
  assert.equal(account.textChunkLimit, 4000)
  assert.equal(account.chunkMode, 'newline')
  assert.equal(account.blockStreaming, true)
  assert.equal(account.responsePrefix, '[Talk]')
  assert.deepEqual(account.network, { dangerouslyAllowPrivateNetwork: true })
  assert.equal(cfg.plugins.entries['nextcloud-talk'].enabled, true)
})

test('Nextcloud Talk 读取和诊断支持 Bot Secret 或 Secret File 二选一', () => {
  const values = buildMessagingPlatformFormValues('nextcloud-talk', {
    enabled: true,
    baseUrl: 'https://cloud.example.com',
    botSecretFile: '/run/secrets/nextcloud-talk-secret',
    apiUser: 'openclaw-bot',
    allowFrom: ['alice'],
    groupPolicy: 'open',
    requireMention: true,
    groupAllowFrom: ['room-token-1'],
    webhookPort: 8788,
    historyLimit: 80,
    blockStreaming: true,
    network: { dangerouslyAllowPrivateNetwork: true },
  })
  const missingSecret = buildOpenClawChannelDiagnosis({
    platform: 'nextcloud-talk',
    configExists: true,
    channelEnabled: true,
    form: { baseUrl: 'https://cloud.example.com' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'nextcloud-talk',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.baseUrl, 'https://cloud.example.com')
  assert.equal(values.botSecretFile, '/run/secrets/nextcloud-talk-secret')
  assert.equal(values.groupPolicy, 'mentioned')
  assert.equal(values.groupAllowFrom, 'room-token-1')
  assert.equal(values.webhookPort, '8788')
  assert.equal(values.historyLimit, '80')
  assert.equal(values.blockStreaming, 'true')
  assert.equal(values.dangerouslyAllowPrivateNetwork, 'true')
  assert.equal(missingSecret.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingSecret.checks.find(item => item.id === 'credentials')?.detail || '', /Bot Secret.*Secret File/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Twitch 渠道保存会写入聊天账号字段并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'twitch',
    accountId: 'stream',
    form: {
      enabled: 'true',
      username: 'openclawbot',
      accessToken: 'oauth:access-token',
      clientId: 'client-id',
      channel: '#openclaw',
      allowFrom: '123456789, 987654321',
      allowedRoles: 'moderator, vip',
      requireMention: 'true',
      responsePrefix: '[Twitch]',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      expiresIn: '3600',
      obtainmentTimestamp: '1779490000',
    },
  })

  const root = cfg.channels.twitch
  const account = root.accounts.stream
  assert.equal(root.defaultAccount, 'stream')
  assert.equal(account.enabled, true)
  assert.equal(account.username, 'openclawbot')
  assert.equal(account.accessToken, 'oauth:access-token')
  assert.equal(account.clientId, 'client-id')
  assert.equal(account.channel, '#openclaw')
  assert.deepEqual(account.allowFrom, ['123456789', '987654321'])
  assert.deepEqual(account.allowedRoles, ['moderator', 'vip'])
  assert.equal(account.requireMention, true)
  assert.equal(account.responsePrefix, '[Twitch]')
  assert.equal(account.clientSecret, 'client-secret')
  assert.equal(account.refreshToken, 'refresh-token')
  assert.equal(account.expiresIn, 3600)
  assert.equal(account.obtainmentTimestamp, 1779490000)
  assert.equal(cfg.plugins.entries.twitch.enabled, true)
})

test('Twitch 读取和诊断会回显访问控制与刷新 Token 字段', () => {
  const values = buildMessagingPlatformFormValues('twitch', {
    enabled: true,
    username: 'openclawbot',
    accessToken: 'oauth:access-token',
    clientId: 'client-id',
    channel: '#openclaw',
    allowFrom: ['123456789'],
    allowedRoles: ['moderator', 'subscriber'],
    requireMention: true,
    responsePrefix: '[Twitch]',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    expiresIn: 3600,
    obtainmentTimestamp: 1779490000,
  })
  const missingToken = buildOpenClawChannelDiagnosis({
    platform: 'twitch',
    configExists: true,
    channelEnabled: true,
    form: { username: 'openclawbot', clientId: 'client-id', channel: '#openclaw' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'twitch',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.username, 'openclawbot')
  assert.equal(values.accessToken, 'oauth:access-token')
  assert.equal(values.clientId, 'client-id')
  assert.equal(values.channel, '#openclaw')
  assert.equal(values.allowFrom, '123456789')
  assert.equal(values.allowedRoles, 'moderator, subscriber')
  assert.equal(values.requireMention, 'true')
  assert.equal(values.refreshToken, 'refresh-token')
  assert.equal(values.expiresIn, '3600')
  assert.equal(values.obtainmentTimestamp, '1779490000')
  assert.equal(missingToken.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingToken.checks.find(item => item.id === 'credentials')?.detail || '', /Access Token/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Nostr 渠道保存会写入上游根节点配置并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'nostr',
    form: {
      enabled: 'true',
      name: 'nostr-bot',
      defaultAccount: 'default',
      privateKey: 'nsec1example',
      relays: 'wss://relay.damus.io, wss://nos.lol',
      dmPolicy: 'allowlist',
      allowFrom: 'npub1sender, 0123456789abcdef',
      profileName: 'openclaw',
      profileDisplayName: 'OpenClaw Bot',
      profileAbout: 'Nostr DM assistant',
      profilePicture: 'https://example.com/avatar.png',
      profileWebsite: 'https://example.com',
      profileNip05: 'openclaw@example.com',
      profileLud16: 'openclaw@example.com',
    },
  })

  const root = cfg.channels.nostr
  assert.equal(root.enabled, true)
  assert.equal(root.name, 'nostr-bot')
  assert.equal(root.defaultAccount, 'default')
  assert.equal(root.privateKey, 'nsec1example')
  assert.deepEqual(root.relays, ['wss://relay.damus.io', 'wss://nos.lol'])
  assert.equal(root.dmPolicy, 'allowlist')
  assert.deepEqual(root.allowFrom, ['npub1sender', '0123456789abcdef'])
  assert.equal(root.profile.name, 'openclaw')
  assert.equal(root.profile.displayName, 'OpenClaw Bot')
  assert.equal(root.profile.about, 'Nostr DM assistant')
  assert.equal(root.profile.picture, 'https://example.com/avatar.png')
  assert.equal(root.profile.website, 'https://example.com')
  assert.equal(root.profile.nip05, 'openclaw@example.com')
  assert.equal(root.profile.lud16, 'openclaw@example.com')
  assert.equal(Object.hasOwn(root, 'accounts'), false)
  assert.equal(cfg.plugins.entries.nostr.enabled, true)
})

test('Nostr 读取和诊断会回显 relay、访问控制和 profile 字段', () => {
  const values = buildMessagingPlatformFormValues('nostr', {
    enabled: true,
    name: 'nostr-bot',
    privateKey: 'nsec1example',
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    dmPolicy: 'allowlist',
    allowFrom: ['npub1sender'],
    profile: {
      name: 'openclaw',
      displayName: 'OpenClaw Bot',
      about: 'Nostr DM assistant',
      picture: 'https://example.com/avatar.png',
      website: 'https://example.com',
      nip05: 'openclaw@example.com',
      lud16: 'openclaw@example.com',
    },
  })
  const missingKey = buildOpenClawChannelDiagnosis({
    platform: 'nostr',
    configExists: true,
    channelEnabled: true,
    form: { relays: 'wss://relay.damus.io' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'nostr',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.name, 'nostr-bot')
  assert.equal(values.privateKey, 'nsec1example')
  assert.equal(values.relays, 'wss://relay.damus.io, wss://nos.lol')
  assert.equal(values.dmPolicy, 'allowlist')
  assert.equal(values.allowFrom, 'npub1sender')
  assert.equal(values.profileName, 'openclaw')
  assert.equal(values.profileDisplayName, 'OpenClaw Bot')
  assert.equal(values.profileAbout, 'Nostr DM assistant')
  assert.equal(values.profilePicture, 'https://example.com/avatar.png')
  assert.equal(values.profileWebsite, 'https://example.com')
  assert.equal(values.profileNip05, 'openclaw@example.com')
  assert.equal(values.profileLud16, 'openclaw@example.com')
  assert.equal(missingKey.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingKey.checks.find(item => item.id === 'credentials')?.detail || '', /Private Key/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('IRC 渠道保存会写入多账号服务器、NickServ 和频道访问结构并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'irc',
    accountId: 'libera',
    form: {
      enabled: 'true',
      name: 'Libera Ops',
      host: 'irc.libera.chat',
      port: '6697',
      tls: 'true',
      nick: 'openclaw-bot',
      username: 'openclaw',
      realname: 'OpenClaw Bot',
      password: 'server-password',
      passwordFile: '/run/secrets/irc-password',
      nickservEnabled: 'true',
      nickservService: 'NickServ',
      nickservPassword: 'nickserv-password',
      nickservPasswordFile: '/run/secrets/irc-nickserv',
      nickservRegister: 'false',
      nickservRegisterEmail: 'bot@example.com',
      channels: '#openclaw, #ops',
      dmPolicy: 'allowlist',
      allowFrom: 'alice!ident@example.org, bob',
      defaultTo: '#openclaw',
      groupPolicy: 'allowlist',
      groups: '#openclaw, #ops',
      groupAllowFrom: 'alice!ident@example.org',
      requireMention: 'false',
      mentionPatterns: 'openclaw:, @openclaw',
      historyLimit: '80',
      dmHistoryLimit: '20',
      mediaMaxMb: '25',
      textChunkLimit: '350',
      chunkMode: 'newline',
      blockStreaming: 'true',
      responsePrefix: '[IRC]',
      dangerouslyAllowNameMatching: 'true',
    },
  })

  const root = cfg.channels.irc
  const account = root.accounts.libera
  assert.equal(root.defaultAccount, 'libera')
  assert.equal(account.enabled, true)
  assert.equal(account.name, 'Libera Ops')
  assert.equal(account.host, 'irc.libera.chat')
  assert.equal(account.port, 6697)
  assert.equal(account.tls, true)
  assert.equal(account.nick, 'openclaw-bot')
  assert.equal(account.username, 'openclaw')
  assert.equal(account.realname, 'OpenClaw Bot')
  assert.equal(account.password, 'server-password')
  assert.equal(account.passwordFile, '/run/secrets/irc-password')
  assert.deepEqual(account.nickserv, {
    enabled: true,
    service: 'NickServ',
    password: 'nickserv-password',
    passwordFile: '/run/secrets/irc-nickserv',
    register: false,
    registerEmail: 'bot@example.com',
  })
  assert.deepEqual(account.channels, ['#openclaw', '#ops'])
  assert.equal(account.dmPolicy, 'allowlist')
  assert.deepEqual(account.allowFrom, ['alice!ident@example.org', 'bob'])
  assert.equal(account.defaultTo, '#openclaw')
  assert.equal(account.groupPolicy, 'allowlist')
  assert.deepEqual(Object.keys(account.groups), ['#openclaw', '#ops'])
  assert.equal(account.groups['#openclaw'].requireMention, false)
  assert.deepEqual(account.groupAllowFrom, ['alice!ident@example.org'])
  assert.deepEqual(account.mentionPatterns, ['openclaw:', '@openclaw'])
  assert.equal(account.historyLimit, 80)
  assert.equal(account.dmHistoryLimit, 20)
  assert.equal(account.mediaMaxMb, 25)
  assert.equal(account.textChunkLimit, 350)
  assert.equal(account.chunkMode, 'newline')
  assert.equal(account.blockStreaming, true)
  assert.equal(account.responsePrefix, '[IRC]')
  assert.equal(account.dangerouslyAllowNameMatching, true)
  assert.equal(cfg.plugins.entries.irc.enabled, true)
})

test('IRC 读取和诊断会回显服务器、NickServ 与频道字段', () => {
  const values = buildMessagingPlatformFormValues('irc', {
    enabled: true,
    name: 'Libera Ops',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'openclaw-bot',
    username: 'openclaw',
    realname: 'OpenClaw Bot',
    password: 'server-password',
    passwordFile: '/run/secrets/irc-password',
    nickserv: {
      enabled: true,
      service: 'NickServ',
      password: 'nickserv-password',
      passwordFile: '/run/secrets/irc-nickserv',
      register: false,
      registerEmail: 'bot@example.com',
    },
    channels: ['#openclaw', '#ops'],
    dmPolicy: 'allowlist',
    allowFrom: ['alice!ident@example.org'],
    defaultTo: '#openclaw',
    groupPolicy: 'allowlist',
    groups: {
      '#openclaw': { requireMention: false },
      '#ops': { requireMention: false },
    },
    groupAllowFrom: ['alice!ident@example.org'],
    mentionPatterns: ['openclaw:', '@openclaw'],
    historyLimit: 80,
    dmHistoryLimit: 20,
    mediaMaxMb: 25,
    textChunkLimit: 350,
    chunkMode: 'newline',
    blockStreaming: true,
    responsePrefix: '[IRC]',
    dangerouslyAllowNameMatching: true,
  })
  const missingNick = buildOpenClawChannelDiagnosis({
    platform: 'irc',
    configExists: true,
    channelEnabled: true,
    form: { host: 'irc.libera.chat' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'irc',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.name, 'Libera Ops')
  assert.equal(values.host, 'irc.libera.chat')
  assert.equal(values.port, '6697')
  assert.equal(values.tls, 'true')
  assert.equal(values.nick, 'openclaw-bot')
  assert.equal(values.nickservEnabled, 'true')
  assert.equal(values.nickservService, 'NickServ')
  assert.equal(values.nickservPassword, 'nickserv-password')
  assert.equal(values.nickservRegister, 'false')
  assert.equal(values.channels, '#openclaw, #ops')
  assert.equal(values.groups, '#openclaw, #ops')
  assert.equal(values.requireMention, 'false')
  assert.equal(values.groupAllowFrom, 'alice!ident@example.org')
  assert.equal(values.mentionPatterns, 'openclaw:, @openclaw')
  assert.equal(values.blockStreaming, 'true')
  assert.equal(values.dangerouslyAllowNameMatching, 'true')
  assert.equal(missingNick.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingNick.checks.find(item => item.id === 'credentials')?.detail || '', /Nick/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Tlon 默认账号保存会写入上游根节点配置并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'tlon',
    accountId: 'default',
    form: {
      enabled: 'true',
      name: 'Main Ship',
      ship: '~sampel-palnet',
      url: 'https://urbit.example.com',
      code: 'lidlut-tabwed-pillex-ridrup',
      dangerouslyAllowPrivateNetwork: 'true',
      groupChannels: 'chat/~host-ship/general, chat/~host-ship/support',
      dmAllowlist: 'zod, ~nec',
      groupInviteAllowlist: '~bus',
      autoDiscoverChannels: 'true',
      showModelSignature: 'false',
      responsePrefix: '[Tlon]',
      autoAcceptDmInvites: 'true',
      autoAcceptGroupInvites: 'false',
      ownerShip: '~sampel-palnet',
      defaultAuthorizedShips: '~zod, ~nec',
    },
  })

  const root = cfg.channels.tlon
  assert.equal(root.enabled, true)
  assert.equal(root.name, 'Main Ship')
  assert.equal(root.ship, '~sampel-palnet')
  assert.equal(root.url, 'https://urbit.example.com')
  assert.equal(root.code, 'lidlut-tabwed-pillex-ridrup')
  assert.deepEqual(root.network, { dangerouslyAllowPrivateNetwork: true })
  assert.deepEqual(root.groupChannels, ['chat/~host-ship/general', 'chat/~host-ship/support'])
  assert.deepEqual(root.dmAllowlist, ['zod', '~nec'])
  assert.deepEqual(root.groupInviteAllowlist, ['~bus'])
  assert.equal(root.autoDiscoverChannels, true)
  assert.equal(root.showModelSignature, false)
  assert.equal(root.responsePrefix, '[Tlon]')
  assert.equal(root.autoAcceptDmInvites, true)
  assert.equal(root.autoAcceptGroupInvites, false)
  assert.equal(root.ownerShip, '~sampel-palnet')
  assert.deepEqual(root.defaultAuthorizedShips, ['~zod', '~nec'])
  assert.equal(Object.hasOwn(root, 'accounts'), false)
  assert.equal(cfg.plugins.entries.tlon.enabled, true)
})

test('Tlon 命名账号保存会写入 accounts 并保留根节点共享字段', () => {
  const cfg = {
    channels: {
      tlon: {
        enabled: true,
        defaultAuthorizedShips: ['~zod'],
      },
    },
  }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'tlon',
    accountId: 'support',
    form: {
      enabled: 'true',
      ship: '~support-palnet',
      url: 'https://support.example.com',
      code: 'fodwyt-ragful-sivnys-nivlup',
      groupChannels: 'chat/~host-ship/support',
      dmAllowlist: '~zod',
      autoDiscoverChannels: 'false',
      ownerShip: '~support-palnet',
    },
  })

  const root = cfg.channels.tlon
  const account = root.accounts.support
  assert.deepEqual(root.defaultAuthorizedShips, ['~zod'])
  assert.equal(account.enabled, true)
  assert.equal(account.ship, '~support-palnet')
  assert.equal(account.url, 'https://support.example.com')
  assert.equal(account.code, 'fodwyt-ragful-sivnys-nivlup')
  assert.deepEqual(account.groupChannels, ['chat/~host-ship/support'])
  assert.deepEqual(account.dmAllowlist, ['~zod'])
  assert.equal(account.autoDiscoverChannels, false)
  assert.equal(account.ownerShip, '~support-palnet')
  assert.equal(cfg.plugins.entries.tlon.enabled, true)
})

test('Tlon 读取和诊断会回显 Ship、URL、登录码和安全配置', () => {
  const values = buildMessagingPlatformFormValues('tlon', {
    enabled: true,
    name: 'Main Ship',
    ship: '~sampel-palnet',
    url: 'https://urbit.example.com',
    code: 'lidlut-tabwed-pillex-ridrup',
    network: { dangerouslyAllowPrivateNetwork: true },
    groupChannels: ['chat/~host-ship/general', 'chat/~host-ship/support'],
    dmAllowlist: ['~zod', '~nec'],
    groupInviteAllowlist: ['~bus'],
    autoDiscoverChannels: true,
    showModelSignature: false,
    responsePrefix: '[Tlon]',
    autoAcceptDmInvites: true,
    autoAcceptGroupInvites: false,
    ownerShip: '~sampel-palnet',
    defaultAuthorizedShips: ['~zod', '~nec'],
  })
  const missingCode = buildOpenClawChannelDiagnosis({
    platform: 'tlon',
    configExists: true,
    channelEnabled: true,
    form: { ship: '~sampel-palnet', url: 'https://urbit.example.com' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'tlon',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.enabled, 'true')
  assert.equal(values.name, 'Main Ship')
  assert.equal(values.ship, '~sampel-palnet')
  assert.equal(values.url, 'https://urbit.example.com')
  assert.equal(values.code, 'lidlut-tabwed-pillex-ridrup')
  assert.equal(values.dangerouslyAllowPrivateNetwork, 'true')
  assert.equal(values.groupChannels, 'chat/~host-ship/general, chat/~host-ship/support')
  assert.equal(values.dmAllowlist, '~zod, ~nec')
  assert.equal(values.groupInviteAllowlist, '~bus')
  assert.equal(values.autoDiscoverChannels, 'true')
  assert.equal(values.showModelSignature, 'false')
  assert.equal(values.responsePrefix, '[Tlon]')
  assert.equal(values.autoAcceptDmInvites, 'true')
  assert.equal(values.autoAcceptGroupInvites, 'false')
  assert.equal(values.ownerShip, '~sampel-palnet')
  assert.equal(values.defaultAuthorizedShips, '~zod, ~nec')
  assert.equal(missingCode.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingCode.checks.find(item => item.id === 'credentials')?.detail || '', /Code/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Signal 渠道保存会保留多账号和上游运行字段', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'signal',
    accountId: 'phone-a',
    form: {
      account: '+15551234567',
      cliPath: 'signal-cli',
      httpUrl: 'http://127.0.0.1:8080',
      dmPolicy: 'allowlist',
      allowFrom: '+15550000001',
      groupPolicy: 'allowlist',
      groupAllowFrom: 'group-1, group-2',
      mediaMaxMb: '25',
      historyLimit: '80',
      dmHistoryLimit: '20',
      textChunkLimit: '1800',
      blockStreaming: 'true',
      responsePrefix: '[Signal]',
    },
  })

  const root = cfg.channels.signal
  const account = root.accounts['phone-a']
  assert.equal(root.defaultAccount, 'phone-a')
  assert.equal(account.account, '+15551234567')
  assert.equal(account.cliPath, 'signal-cli')
  assert.equal(account.httpUrl, 'http://127.0.0.1:8080')
  assert.equal(account.dmPolicy, 'allowlist')
  assert.deepEqual(account.allowFrom, ['+15550000001'])
  assert.equal(account.groupPolicy, 'allowlist')
  assert.deepEqual(account.groupAllowFrom, ['group-1', 'group-2'])
  assert.equal(account.mediaMaxMb, 25)
  assert.equal(account.historyLimit, 80)
  assert.equal(account.dmHistoryLimit, 20)
  assert.equal(account.textChunkLimit, 1800)
  assert.equal(account.blockStreaming, true)
  assert.equal(account.responsePrefix, '[Signal]')
})

test('Signal 渠道读取会回显群组和运行字段', () => {
  const values = buildMessagingPlatformFormValues('signal', {
    account: '+15551234567',
    groupAllowFrom: ['group-1', 'group-2'],
    mediaMaxMb: 25,
    historyLimit: 80,
    dmHistoryLimit: 20,
    textChunkLimit: 1800,
    blockStreaming: true,
    responsePrefix: '[Signal]',
  })

  assert.equal(values.account, '+15551234567')
  assert.equal(values.groupAllowFrom, 'group-1, group-2')
  assert.equal(values.mediaMaxMb, '25')
  assert.equal(values.historyLimit, '80')
  assert.equal(values.dmHistoryLimit, '20')
  assert.equal(values.textChunkLimit, '1800')
  assert.equal(values.blockStreaming, 'true')
  assert.equal(values.responsePrefix, '[Signal]')
})

test('渠道保存会为飞书补齐新版内核要求的默认字段', () => {
  const form = normalizeMessagingPlatformForm('feishu', {
    appId: 'cli_a',
    appSecret: 'secret',
    domain: '',
  })

  assert.equal(form.domain, 'feishu')
  assert.equal(form.connectionMode, 'websocket')
  assert.equal(form.webhookPath, '/feishu/events')
  assert.equal(form.dmPolicy, 'pairing')
  assert.equal(form.groupPolicy, 'allowlist')
  assert.equal(form.reactionNotifications, 'off')
  assert.equal(form.typingIndicator, true)
  assert.equal(form.resolveSenderNames, true)
})

test('渠道读取会把新版访问策略字段回显为表单可编辑值', () => {
  const values = buildMessagingPlatformFormValues('telegram', {
    botToken: '123:token',
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: ['u-1', 'u-2'],
  })

  assert.equal(values.botToken, '123:token')
  assert.equal(values.dmPolicy, 'allowlist')
  assert.equal(values.groupPolicy, 'disabled')
  assert.equal(values.allowFrom, 'u-1, u-2')
  assert.equal(values.allowedUsers, 'u-1, u-2')
})

test('渠道读取会合并飞书账号凭证和根节点共享策略字段', () => {
  const values = buildMessagingPlatformFormValues(
    'feishu',
    {
      appId: 'cli_a',
      appSecret: 'secret',
    },
    {
      channelRoot: {
        domain: 'lark',
        connectionMode: 'websocket',
        webhookPath: '/feishu/events',
        dmPolicy: 'pairing',
        groupPolicy: 'allowlist',
        reactionNotifications: 'off',
        typingIndicator: true,
        resolveSenderNames: false,
      },
    },
  )

  assert.equal(values.appId, 'cli_a')
  assert.equal(values.appSecret, 'secret')
  assert.equal(values.domain, 'lark')
  assert.equal(values.connectionMode, 'websocket')
  assert.equal(values.webhookPath, '/feishu/events')
  assert.equal(values.dmPolicy, 'pairing')
  assert.equal(values.groupPolicy, 'allowlist')
  assert.equal(values.reactionNotifications, 'off')
  assert.equal(values.typingIndicator, 'true')
  assert.equal(values.resolveSenderNames, 'false')
})

test('渠道读取飞书多账号时不会用根节点旧凭证覆盖账号凭证', () => {
  const values = buildMessagingPlatformFormValues(
    'feishu',
    {
      appId: 'account_app',
      appSecret: 'account_secret',
      dmPolicy: 'pairing',
    },
    {
      channelRoot: {
        appId: 'root_app',
        appSecret: 'root_secret',
        domain: 'lark',
        groupPolicy: 'allowlist',
      },
    },
  )

  assert.equal(values.appId, 'account_app')
  assert.equal(values.appSecret, 'account_secret')
  assert.equal(values.domain, 'lark')
  assert.equal(values.dmPolicy, 'pairing')
  assert.equal(values.groupPolicy, 'allowlist')
})

test('渠道读取会把 open + requireMention 反向回显为仅提及时策略', () => {
  const values = buildMessagingPlatformFormValues('slack', {
    mode: 'socket',
    botToken: 'xoxb-token',
    appToken: 'xapp-token',
    groupPolicy: 'open',
    requireMention: true,
  })

  assert.equal(values.groupPolicy, 'mentioned')
  assert.equal(values.requireMention, 'true')
})

test('Discord 渠道读取会回显 applicationId', () => {
  const values = buildMessagingPlatformFormValues('discord', {
    token: 'discord-token',
    applicationId: '123456789012345678',
  })

  assert.equal(values.token, 'discord-token')
  assert.equal(values.applicationId, '123456789012345678')
})

test('渠道保存会在用户改回所有群组时显式清除仅提及开关', () => {
  const form = normalizeMessagingPlatformForm('slack', {
    mode: 'socket',
    botToken: 'xoxb-token',
    appToken: 'xapp-token',
    groupPolicy: 'open',
  })

  assert.equal(form.groupPolicy, 'open')
  assert.equal(form.requireMention, false)
})

test('渠道读取会把 SecretRef 密钥显示为安全占位并携带原始对象', () => {
  const secretRef = { source: 'env', provider: 'default', id: 'TELEGRAM_BOT_TOKEN' }
  const values = buildMessagingPlatformFormValues('telegram', {
    botToken: secretRef,
    dmPolicy: 'pairing',
    groupPolicy: 'allowlist',
  })

  assert.equal(values.botToken, 'SecretRef(env:default:TELEGRAM_BOT_TOKEN)')
  assert.deepEqual(values.__secretRefs, { botToken: secretRef })
})

test('未知账号标识不会回落到渠道根配置', () => {
  const root = {
    enabled: true,
    botToken: { source: 'env', provider: 'default', id: 'TELEGRAM_BOT_TOKEN' },
    accounts: { default: { botToken: 'default-token' } },
  }
  assert.equal(resolvePlatformConfigEntry(root, 'telegram', 'work'), null)
})

test('渠道保存时用户未改动 SecretRef 占位会保留原始密钥引用', () => {
  const secretRef = { source: 'env', provider: 'default', id: 'SLACK_BOT_TOKEN' }
  const value = resolveMessagingCredentialValueForSave({
    form: { botToken: 'SecretRef(env:default:SLACK_BOT_TOKEN)' },
    current: { botToken: secretRef },
    key: 'botToken',
  })

  assert.deepEqual(value, secretRef)
})

test('渠道保存时用户输入新密钥会替换旧 SecretRef', () => {
  const secretRef = { source: 'env', provider: 'default', id: 'DISCORD_BOT_TOKEN' }
  const value = resolveMessagingCredentialValueForSave({
    form: { token: 'new-discord-token' },
    current: { token: secretRef },
    key: 'token',
  })

  assert.equal(value, 'new-discord-token')
})

test('渠道账号列表会把 SecretRef 标识显示为安全占位', () => {
  const accounts = listPlatformAccounts({
    accounts: {
      prod: {
        appId: { source: 'env', provider: 'default', id: 'FEISHU_APP_ID' },
      },
      backup: {
        clientId: { source: 'env', provider: 'default', id: 'DINGTALK_CLIENT_ID' },
      },
    },
  })

  assert.deepEqual(accounts, [
    { accountId: 'backup', appId: 'SecretRef(env:default:DINGTALK_CLIENT_ID)' },
    { accountId: 'prod', appId: 'SecretRef(env:default:FEISHU_APP_ID)' },
  ])
})

test('渠道账号列表会使用 IRC Nick 作为安全展示标识', () => {
  const accounts = listPlatformAccounts({
    accounts: {
      libera: {
        nick: 'openclaw-bot',
      },
    },
  })

  assert.deepEqual(accounts, [
    { accountId: 'libera', appId: 'openclaw-bot' },
  ])
})

test('渠道账号列表会使用 Tlon Ship 作为安全展示标识', () => {
  const accounts = listPlatformAccounts({
    accounts: {
      support: {
        ship: '~support-palnet',
      },
    },
  })

  assert.deepEqual(accounts, [
    { accountId: 'support', appId: '~support-palnet' },
  ])
})

test('渠道保存时 clientId 未改动 SecretRef 占位会保留原始引用', () => {
  const secretRef = { source: 'env', provider: 'default', id: 'DINGTALK_CLIENT_ID' }
  const value = resolveMessagingCredentialValueForSave({
    form: { clientId: 'SecretRef(env:default:DINGTALK_CLIENT_ID)' },
    current: { clientId: secretRef },
    key: 'clientId',
  })

  assert.deepEqual(value, secretRef)
})

test('OpenClaw 渠道保存带账号标识时会写入 accounts 而不是覆盖根配置', () => {
  const cfg = {
    channels: {
      telegram: {
        enabled: true,
        botToken: 'root-token',
        dmPolicy: 'pairing',
        groupPolicy: 'allowlist',
      },
      discord: {
        enabled: true,
        token: 'root-discord',
        groupPolicy: 'allowlist',
      },
      slack: {
        enabled: true,
        mode: 'socket',
        botToken: 'root-slack',
        appToken: 'root-app',
      },
    },
  }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'telegram',
    accountId: 'alerts',
    form: { botToken: 'alerts-token', dmPolicy: 'allowlist', groupPolicy: 'disabled' },
  })
  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'discord',
    accountId: 'ops',
    form: { token: 'ops-discord', guildId: 'guild-1', channelId: 'channel-1' },
  })
  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'slack',
    accountId: 'team-a',
    form: { mode: 'socket', botToken: 'team-slack', appToken: 'team-app' },
  })

  assert.equal(cfg.channels.telegram.botToken, 'root-token')
  assert.equal(cfg.channels.telegram.accounts.alerts.botToken, 'alerts-token')
  assert.equal(cfg.channels.telegram.accounts.alerts.dmPolicy, 'allowlist')
  assert.equal(cfg.channels.discord.token, 'root-discord')
  assert.equal(cfg.channels.discord.accounts.ops.token, 'ops-discord')
  assert.equal(cfg.channels.discord.accounts.ops.guilds['guild-1'].channels['channel-1'].allow, true)
  assert.equal(cfg.channels.slack.botToken, 'root-slack')
  assert.equal(cfg.channels.slack.accounts['team-a'].botToken, 'team-slack')
  assert.equal(cfg.channels.slack.accounts['team-a'].appToken, 'team-app')
})

test('通用渠道诊断会指出 Telegram 缺少 Bot Token', () => {
  const result = buildOpenClawChannelDiagnosis({
    platform: 'telegram',
    configExists: true,
    channelEnabled: true,
    form: {
      dmPolicy: 'pairing',
      groupPolicy: 'allowlist',
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.overallReady, false)
  assert.equal(result.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(result.checks.find(item => item.id === 'credentials')?.detail || '', /Bot Token/)
})

test('通用渠道诊断在缺少渠道配置时不会误报渠道已禁用', () => {
  const result = buildOpenClawChannelDiagnosis({
    platform: 'telegram',
    configExists: false,
    channelEnabled: true,
    form: {},
  })

  assert.equal(result.ok, false)
  assert.equal(result.checks.find(item => item.id === 'config_exists')?.ok, false)
  assert.equal(result.checks.find(item => item.id === 'channel_enabled')?.ok, true)
  assert.match(result.checks.find(item => item.id === 'channel_enabled')?.detail || '', /未被显式禁用/)
})

test('通用渠道诊断会按 Slack 模式检查动态必填凭证', () => {
  const socketResult = buildOpenClawChannelDiagnosis({
    platform: 'slack',
    configExists: true,
    channelEnabled: true,
    form: {
      mode: 'socket',
      botToken: 'xoxb-token',
    },
  })
  const httpResult = buildOpenClawChannelDiagnosis({
    platform: 'slack',
    configExists: true,
    channelEnabled: true,
    form: {
      mode: 'http',
      botToken: 'xoxb-token',
      signingSecret: 'secret',
    },
  })

  assert.equal(socketResult.ok, false)
  assert.match(socketResult.checks.find(item => item.id === 'credentials')?.detail || '', /App Token/)
  assert.equal(httpResult.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('通用渠道诊断会识别钉钉 Client ID 和 Client Secret', () => {
  const result = buildOpenClawChannelDiagnosis({
    platform: 'dingtalk',
    configExists: true,
    channelEnabled: true,
    form: {
      clientId: 'ding-app-key',
      clientSecret: 'ding-secret',
    },
    verifyResult: {
      valid: true,
      details: ['已通过 accessToken 接口校验'],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.overallReady, true)
  assert.equal(result.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(result.checks.find(item => item.id === 'online_verify')?.ok, true)
})

test('Zalo 渠道保存会补齐策略并保留 Bot Token 或 Token File', () => {
  const tokenForm = normalizeMessagingPlatformForm('zalo', {
    botToken: 'zalo-token',
    groupAllowFrom: 'group-1, group-2',
    mediaMaxMb: '25',
  })
  const tokenFileForm = normalizeMessagingPlatformForm('zalo', {
    tokenFile: '/run/secrets/zalo-token',
  })

  assert.equal(tokenForm.botToken, 'zalo-token')
  assert.equal(tokenForm.dmPolicy, 'pairing')
  assert.equal(tokenForm.groupPolicy, 'allowlist')
  assert.deepEqual(tokenForm.groupAllowFrom, ['group-1', 'group-2'])
  assert.equal(tokenForm.mediaMaxMb, 25)
  assert.equal(tokenFileForm.tokenFile, '/run/secrets/zalo-token')
})

test('OpenClaw 渠道保存会写入 Zalo 多账号配置', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'zalo',
    accountId: 'vn',
    form: {
      botToken: 'zalo-token',
      groupAllowFrom: 'thread-1',
      mediaMaxMb: '30',
    },
  })

  assert.equal(cfg.channels.zalo.defaultAccount, 'vn')
  assert.equal(cfg.channels.zalo.accounts.vn.botToken, 'zalo-token')
  assert.deepEqual(cfg.channels.zalo.accounts.vn.groupAllowFrom, ['thread-1'])
  assert.equal(cfg.channels.zalo.accounts.vn.mediaMaxMb, 30)
})

test('Zalo 诊断接受 Bot Token 或 Token File 二选一', () => {
  const tokenResult = buildOpenClawChannelDiagnosis({
    platform: 'zalo',
    configExists: true,
    channelEnabled: true,
    form: { botToken: 'zalo-token' },
  })
  const fileResult = buildOpenClawChannelDiagnosis({
    platform: 'zalo',
    configExists: true,
    channelEnabled: true,
    form: { tokenFile: '/run/secrets/zalo-token' },
  })
  const missingResult = buildOpenClawChannelDiagnosis({
    platform: 'zalo',
    configExists: true,
    channelEnabled: true,
    form: {},
  })

  assert.equal(tokenResult.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(fileResult.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(missingResult.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingResult.checks.find(item => item.id === 'credentials')?.detail || '', /Bot Token.*Token File/)
})

test('Zalo Personal 保存和诊断按二维码会话型渠道处理', () => {
  const form = normalizeMessagingPlatformForm('zalouser', {
    profile: 'work',
    dangerouslyAllowNameMatching: 'true',
    allowFrom: '12345, Alice',
    groupAllowFrom: 'group-1',
    historyLimit: '12',
  })
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'zalouser',
    accountId: 'work',
    form,
  })
  const result = buildOpenClawChannelDiagnosis({
    platform: 'zalouser',
    configExists: true,
    channelEnabled: true,
    form: buildMessagingPlatformFormValues('zalouser', cfg.channels.zalouser.accounts.work),
  })

  assert.equal(cfg.channels.zalouser.defaultAccount, 'work')
  assert.equal(cfg.channels.zalouser.accounts.work.profile, 'work')
  assert.equal(cfg.channels.zalouser.accounts.work.dangerouslyAllowNameMatching, true)
  assert.deepEqual(cfg.channels.zalouser.accounts.work.allowFrom, ['12345', 'Alice'])
  assert.deepEqual(cfg.channels.zalouser.accounts.work.groupAllowFrom, ['group-1'])
  assert.equal(cfg.channels.zalouser.accounts.work.historyLimit, 12)
  assert.equal(result.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(result.checks.find(item => item.id === 'credentials')?.title, '登录/会话配置')
})

test('LINE 渠道保存会写入双凭证组合并支持多账号', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'line',
    accountId: 'jp',
    form: {
      tokenFile: '/run/secrets/line-token',
      secretFile: '/run/secrets/line-secret',
      allowFrom: 'U123, U456',
      groupAllowFrom: 'C123',
      groupPolicy: 'open',
      mediaMaxMb: '25',
      webhookPath: '/line/webhook',
    },
  })

  const account = cfg.channels.line.accounts.jp
  assert.equal(cfg.channels.line.defaultAccount, 'jp')
  assert.equal(account.tokenFile, '/run/secrets/line-token')
  assert.equal(account.secretFile, '/run/secrets/line-secret')
  assert.deepEqual(account.allowFrom, ['U123', 'U456'])
  assert.deepEqual(account.groupAllowFrom, ['C123'])
  assert.equal(account.groupPolicy, 'open')
  assert.equal(account.mediaMaxMb, 25)
  assert.equal(account.webhookPath, '/line/webhook')
})

test('LINE 诊断要求 token 与 secret 两组凭证各满足一项', () => {
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'line',
    configExists: true,
    channelEnabled: true,
    form: {
      channelAccessToken: 'line-token',
      secretFile: '/run/secrets/line-secret',
    },
  })
  const missingSecret = buildOpenClawChannelDiagnosis({
    platform: 'line',
    configExists: true,
    channelEnabled: true,
    form: {
      channelAccessToken: 'line-token',
    },
  })

  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(missingSecret.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingSecret.checks.find(item => item.id === 'credentials')?.detail || '', /Channel Secret.*Secret File/)
})

test('Mattermost 渠道保存会写入嵌套命令和网络配置', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'mattermost',
    accountId: 'ops',
    form: {
      botToken: 'mattermost-token',
      baseUrl: 'https://mattermost.example.com/',
      groupPolicy: 'mentioned',
      allowFrom: '@alice, bob',
      groupAllowFrom: 'town-square',
      callbackPath: '/api/channels/mattermost/ops',
      callbackUrl: 'https://panel.example.com/api/channels/mattermost/ops',
      dangerouslyAllowNameMatching: 'true',
      dangerouslyAllowPrivateNetwork: 'true',
      replyToMode: 'all',
    },
  })

  const account = cfg.channels.mattermost.accounts.ops
  assert.equal(cfg.channels.mattermost.defaultAccount, 'ops')
  assert.equal(account.botToken, 'mattermost-token')
  assert.equal(account.baseUrl, 'https://mattermost.example.com/')
  assert.equal(account.groupPolicy, 'open')
  assert.equal(account.requireMention, true)
  assert.deepEqual(account.allowFrom, ['@alice', 'bob'])
  assert.deepEqual(account.groupAllowFrom, ['town-square'])
  assert.equal(account.commands.callbackPath, '/api/channels/mattermost/ops')
  assert.equal(account.commands.callbackUrl, 'https://panel.example.com/api/channels/mattermost/ops')
  assert.equal(account.network.dangerouslyAllowPrivateNetwork, true)
  assert.equal(account.dangerouslyAllowNameMatching, true)
  assert.equal(account.replyToMode, 'all')
})

test('Mattermost 诊断要求 Bot Token 和 Base URL', () => {
  const missingBaseUrl = buildOpenClawChannelDiagnosis({
    platform: 'mattermost',
    configExists: true,
    channelEnabled: true,
    form: { botToken: 'mattermost-token' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'mattermost',
    configExists: true,
    channelEnabled: true,
    form: {
      botToken: 'mattermost-token',
      baseUrl: 'https://mattermost.example.com',
    },
  })

  assert.equal(missingBaseUrl.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingBaseUrl.checks.find(item => item.id === 'credentials')?.detail || '', /Base URL/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Synology Chat 渠道保存会写入上游运行时字段并支持多账号', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'synology-chat',
    accountId: 'nas',
    form: {
      token: 'synology-token',
      incomingUrl: 'https://nas.example.com/webapi/entry.cgi',
      nasHost: 'https://nas.example.com',
      webhookPath: '/webhook/synology',
      dmPolicy: 'allowlist',
      allowedUserIds: 'alice, bob',
      rateLimitPerMinute: '45',
      botName: 'OpenClaw Ops',
      dangerouslyAllowNameMatching: 'true',
      dangerouslyAllowInheritedWebhookPath: 'true',
      allowInsecureSsl: 'true',
    },
  })

  const account = cfg.channels['synology-chat'].accounts.nas
  assert.equal(cfg.channels['synology-chat'].defaultAccount, 'nas')
  assert.equal(account.token, 'synology-token')
  assert.equal(account.incomingUrl, 'https://nas.example.com/webapi/entry.cgi')
  assert.equal(account.nasHost, 'https://nas.example.com')
  assert.equal(account.webhookPath, '/webhook/synology')
  assert.equal(account.dmPolicy, 'allowlist')
  assert.deepEqual(account.allowedUserIds, ['alice', 'bob'])
  assert.equal(account.rateLimitPerMinute, 45)
  assert.equal(account.botName, 'OpenClaw Ops')
  assert.equal(account.dangerouslyAllowNameMatching, true)
  assert.equal(account.dangerouslyAllowInheritedWebhookPath, true)
  assert.equal(account.allowInsecureSsl, true)
  assert.equal(cfg.plugins.entries['synology-chat'].enabled, true)
})

test('Synology Chat 诊断要求 Token 和 Incoming URL', () => {
  const missingUrl = buildOpenClawChannelDiagnosis({
    platform: 'synology-chat',
    configExists: true,
    channelEnabled: true,
    form: { token: 'synology-token' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'synology-chat',
    configExists: true,
    channelEnabled: true,
    form: {
      token: 'synology-token',
      incomingUrl: 'https://nas.example.com/webapi/entry.cgi',
    },
  })

  assert.equal(missingUrl.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingUrl.checks.find(item => item.id === 'credentials')?.detail || '', /Incoming URL/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Google Chat 渠道保存会写入 service account 与嵌套 DM 策略', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'googlechat',
    accountId: 'workspace',
    form: {
      serviceAccountFile: '/run/secrets/googlechat.json',
      audienceType: 'app-url',
      audience: 'https://panel.example.com/googlechat',
      webhookPath: '/googlechat',
      webhookUrl: 'https://panel.example.com/googlechat',
      dmPolicy: 'open',
      allowFrom: 'users/123',
      groupPolicy: 'mentioned',
      groupAllowFrom: 'spaces/AAA',
      dangerouslyAllowNameMatching: 'true',
      requireMention: 'true',
      mediaMaxMb: '20',
      responsePrefix: '[AI]',
    },
  })

  const account = cfg.channels.googlechat.accounts.workspace
  assert.equal(cfg.channels.googlechat.defaultAccount, 'workspace')
  assert.equal(account.serviceAccountFile, '/run/secrets/googlechat.json')
  assert.equal(account.audienceType, 'app-url')
  assert.equal(account.audience, 'https://panel.example.com/googlechat')
  assert.equal(account.webhookPath, '/googlechat')
  assert.equal(account.webhookUrl, 'https://panel.example.com/googlechat')
  assert.deepEqual(account.dm, { policy: 'open', allowFrom: ['users/123', '*'] })
  assert.equal(account.groupPolicy, 'open')
  assert.equal(account.requireMention, true)
  assert.deepEqual(account.groupAllowFrom, ['spaces/AAA'])
  assert.equal(account.dangerouslyAllowNameMatching, true)
  assert.equal(account.mediaMaxMb, 20)
  assert.equal(account.responsePrefix, '[AI]')
  assert.equal(cfg.plugins.entries.googlechat.enabled, true)
})

test('Google Chat 读取会把嵌套 DM 策略回显为表单字段', () => {
  const values = buildMessagingPlatformFormValues('googlechat', {
    serviceAccountFile: '/run/secrets/googlechat.json',
    audienceType: 'project-number',
    audience: '1234567890',
    dm: { policy: 'allowlist', allowFrom: ['users/123', 'name@example.com'] },
    groupPolicy: 'allowlist',
    groupAllowFrom: ['spaces/AAA'],
    requireMention: true,
    dangerouslyAllowNameMatching: true,
    mediaMaxMb: 20,
  })

  assert.equal(values.serviceAccountFile, '/run/secrets/googlechat.json')
  assert.equal(values.audienceType, 'project-number')
  assert.equal(values.audience, '1234567890')
  assert.equal(values.dmPolicy, 'allowlist')
  assert.equal(values.allowFrom, 'users/123, name@example.com')
  assert.equal(values.groupPolicy, 'allowlist')
  assert.equal(values.groupAllowFrom, 'spaces/AAA')
  assert.equal(values.requireMention, 'true')
  assert.equal(values.dangerouslyAllowNameMatching, 'true')
  assert.equal(values.mediaMaxMb, '20')
})

test('Google Chat 诊断要求 service account 文件或内联 JSON 其中一项', () => {
  const missingCredential = buildOpenClawChannelDiagnosis({
    platform: 'googlechat',
    configExists: true,
    channelEnabled: true,
    form: { audienceType: 'app-url', audience: 'https://panel.example.com/googlechat' },
  })
  const ready = buildOpenClawChannelDiagnosis({
    platform: 'googlechat',
    configExists: true,
    channelEnabled: true,
    form: { serviceAccountFile: '/run/secrets/googlechat.json' },
  })

  assert.equal(missingCredential.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingCredential.checks.find(item => item.id === 'credentials')?.detail || '', /Service Account/)
  assert.equal(ready.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('Microsoft Teams 渠道保存会写入新版认证和运行字段', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'msteams',
    form: {
      appId: 'teams-app-id',
      appPassword: 'teams-secret',
      tenantId: 'tenant-1',
      authType: 'federated',
      certificatePath: '/run/secrets/teams.pem',
      certificateThumbprint: 'thumbprint-1',
      useManagedIdentity: 'true',
      managedIdentityClientId: 'identity-client-id',
      webhookPort: '3978',
      webhookPath: '/api/teams/messages',
      dmPolicy: 'allowlist',
      allowFrom: 'user-a, user-b',
      groupPolicy: 'mentioned',
      groupAllowFrom: 'team-1, team-2',
      textChunkLimit: '1800',
      historyLimit: '80',
      dmHistoryLimit: '20',
      mediaMaxMb: '100',
      blockStreaming: 'true',
      typingIndicator: 'true',
      replyStyle: 'thread',
      sharePointSiteId: 'contoso.sharepoint.com,guid1,guid2',
      responsePrefix: '[Teams]',
      welcomeCard: 'true',
      promptStarters: 'help, status',
      delegatedAuthEnabled: 'true',
      delegatedAuthScopes: 'User.Read, offline_access',
      ssoEnabled: 'true',
      ssoConnectionName: 'teams-oauth',
    },
  })

  const entry = cfg.channels.msteams
  assert.equal(entry.appId, 'teams-app-id')
  assert.equal(entry.appPassword, 'teams-secret')
  assert.equal(entry.tenantId, 'tenant-1')
  assert.equal(entry.authType, 'federated')
  assert.equal(entry.certificatePath, '/run/secrets/teams.pem')
  assert.equal(entry.certificateThumbprint, 'thumbprint-1')
  assert.equal(entry.useManagedIdentity, true)
  assert.equal(entry.managedIdentityClientId, 'identity-client-id')
  assert.deepEqual(entry.webhook, { port: 3978, path: '/api/teams/messages' })
  assert.equal(entry.dmPolicy, 'allowlist')
  assert.deepEqual(entry.allowFrom, ['user-a', 'user-b'])
  assert.equal(entry.groupPolicy, 'open')
  assert.equal(entry.requireMention, true)
  assert.deepEqual(entry.groupAllowFrom, ['team-1', 'team-2'])
  assert.equal(entry.textChunkLimit, 1800)
  assert.equal(entry.historyLimit, 80)
  assert.equal(entry.dmHistoryLimit, 20)
  assert.equal(entry.mediaMaxMb, 100)
  assert.equal(entry.blockStreaming, true)
  assert.equal(entry.typingIndicator, true)
  assert.equal(entry.replyStyle, 'thread')
  assert.equal(entry.sharePointSiteId, 'contoso.sharepoint.com,guid1,guid2')
  assert.equal(entry.responsePrefix, '[Teams]')
  assert.equal(entry.welcomeCard, true)
  assert.deepEqual(entry.promptStarters, ['help', 'status'])
  assert.deepEqual(entry.delegatedAuth, { enabled: true, scopes: ['User.Read', 'offline_access'] })
  assert.deepEqual(entry.sso, { enabled: true, connectionName: 'teams-oauth' })
  assert.equal(cfg.plugins.entries.msteams.enabled, true)
})

test('Microsoft Teams 渠道读取会回显嵌套 webhook 和运行字段', () => {
  const values = buildMessagingPlatformFormValues('msteams', {
    appId: 'teams-app-id',
    appPassword: 'teams-secret',
    authType: 'federated',
    webhook: { port: 3978, path: '/api/teams/messages' },
    dmPolicy: 'allowlist',
    allowFrom: ['user-a', 'user-b'],
    groupPolicy: 'open',
    requireMention: true,
    groupAllowFrom: ['team-1', 'team-2'],
    textChunkLimit: 1800,
    mediaMaxMb: 100,
    blockStreaming: true,
    typingIndicator: true,
    welcomeCard: true,
    promptStarters: ['help', 'status'],
    delegatedAuth: { enabled: true, scopes: ['User.Read', 'offline_access'] },
    sso: { enabled: true, connectionName: 'teams-oauth' },
  })

  assert.equal(values.appId, 'teams-app-id')
  assert.equal(values.appPassword, 'teams-secret')
  assert.equal(values.authType, 'federated')
  assert.equal(values.webhookPort, '3978')
  assert.equal(values.webhookPath, '/api/teams/messages')
  assert.equal(values.groupPolicy, 'mentioned')
  assert.equal(values.groupAllowFrom, 'team-1, team-2')
  assert.equal(values.textChunkLimit, '1800')
  assert.equal(values.mediaMaxMb, '100')
  assert.equal(values.blockStreaming, 'true')
  assert.equal(values.typingIndicator, 'true')
  assert.equal(values.welcomeCard, 'true')
  assert.equal(values.promptStarters, 'help, status')
  assert.equal(values.delegatedAuthEnabled, 'true')
  assert.equal(values.delegatedAuthScopes, 'User.Read, offline_access')
  assert.equal(values.ssoEnabled, 'true')
  assert.equal(values.ssoConnectionName, 'teams-oauth')
})

test('Microsoft Teams 诊断会按认证模式检查动态必填凭证', () => {
  const missingSecret = buildOpenClawChannelDiagnosis({
    platform: 'msteams',
    configExists: true,
    channelEnabled: true,
    form: {
      appId: 'teams-app-id',
      authType: 'secret',
    },
  })
  const federatedCert = buildOpenClawChannelDiagnosis({
    platform: 'msteams',
    configExists: true,
    channelEnabled: true,
    form: {
      appId: 'teams-app-id',
      authType: 'federated',
      certificatePath: '/run/secrets/teams.pem',
    },
  })
  const managedIdentity = buildOpenClawChannelDiagnosis({
    platform: 'msteams',
    configExists: true,
    channelEnabled: true,
    form: {
      appId: 'teams-app-id',
      useManagedIdentity: 'true',
    },
  })

  assert.equal(missingSecret.checks.find(item => item.id === 'credentials')?.ok, false)
  assert.match(missingSecret.checks.find(item => item.id === 'credentials')?.detail || '', /App Password/)
  assert.equal(federatedCert.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.equal(managedIdentity.checks.find(item => item.id === 'credentials')?.ok, true)
})

test('iMessage 渠道保存会写入桥接运行字段并启用插件', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'imessage',
    form: {
      cliPath: '/usr/local/bin/imsg',
      dbPath: '~/Library/Messages/chat.db',
      remoteHost: 'mac-mini.local',
      service: 'auto',
      region: 'US',
      dmPolicy: 'allowlist',
      allowFrom: '+15551234567, +15557654321',
      defaultTo: '+15550001111',
      groupPolicy: 'allowlist',
      groupAllowFrom: 'chat-guid-1, chat-guid-2',
      historyLimit: '80',
      dmHistoryLimit: '20',
      mediaMaxMb: '25',
      probeTimeoutMs: '5000',
      textChunkLimit: '1800',
      includeAttachments: 'true',
      attachmentRoots: '/Users/me/Downloads, /tmp/imessage',
      remoteAttachmentRoots: '/mnt/messages',
      sendReadReceipts: 'false',
      coalesceSameSenderDms: 'true',
      reactionNotifications: 'own',
      responsePrefix: '[iMessage]',
    },
  })

  const entry = cfg.channels.imessage
  assert.equal(entry.cliPath, '/usr/local/bin/imsg')
  assert.equal(entry.dbPath, '~/Library/Messages/chat.db')
  assert.equal(entry.remoteHost, 'mac-mini.local')
  assert.equal(entry.service, 'auto')
  assert.equal(entry.region, 'US')
  assert.equal(entry.dmPolicy, 'allowlist')
  assert.deepEqual(entry.allowFrom, ['+15551234567', '+15557654321'])
  assert.equal(entry.defaultTo, '+15550001111')
  assert.equal(entry.groupPolicy, 'allowlist')
  assert.deepEqual(entry.groupAllowFrom, ['chat-guid-1', 'chat-guid-2'])
  assert.equal(entry.historyLimit, 80)
  assert.equal(entry.dmHistoryLimit, 20)
  assert.equal(entry.mediaMaxMb, 25)
  assert.equal(entry.probeTimeoutMs, 5000)
  assert.equal(entry.textChunkLimit, 1800)
  assert.equal(entry.includeAttachments, true)
  assert.deepEqual(entry.attachmentRoots, ['/Users/me/Downloads', '/tmp/imessage'])
  assert.deepEqual(entry.remoteAttachmentRoots, ['/mnt/messages'])
  assert.equal(entry.sendReadReceipts, false)
  assert.equal(entry.coalesceSameSenderDms, true)
  assert.equal(entry.reactionNotifications, 'own')
  assert.equal(entry.responsePrefix, '[iMessage]')
  assert.equal(cfg.plugins.entries.imessage.enabled, true)
})

test('iMessage 读取会回显桥接字段且诊断不要求 Bot Token', () => {
  const values = buildMessagingPlatformFormValues('imessage', {
    cliPath: '/usr/local/bin/imsg',
    dbPath: '~/Library/Messages/chat.db',
    remoteHost: 'mac-mini.local',
    service: 'sms',
    dmPolicy: 'open',
    allowFrom: ['*'],
    groupPolicy: 'allowlist',
    groupAllowFrom: ['chat-guid-1'],
    includeAttachments: true,
    attachmentRoots: ['/Users/me/Downloads'],
    sendReadReceipts: false,
    historyLimit: 50,
    responsePrefix: '[iMessage]',
  })
  const diagnosis = buildOpenClawChannelDiagnosis({
    platform: 'imessage',
    configExists: true,
    channelEnabled: true,
    form: values,
  })

  assert.equal(values.cliPath, '/usr/local/bin/imsg')
  assert.equal(values.service, 'sms')
  assert.equal(values.dmPolicy, 'open')
  assert.equal(values.allowFrom, '*')
  assert.equal(values.groupAllowFrom, 'chat-guid-1')
  assert.equal(values.includeAttachments, 'true')
  assert.equal(values.attachmentRoots, '/Users/me/Downloads')
  assert.equal(values.sendReadReceipts, 'false')
  assert.equal(values.historyLimit, '50')
  assert.equal(values.responsePrefix, '[iMessage]')
  assert.equal(diagnosis.checks.find(item => item.id === 'credentials')?.ok, true)
  assert.match(diagnosis.checks.find(item => item.id === 'credentials')?.title || '', /桥接/)
})

test('Discord 渠道保存会保留运行时需要的 applicationId', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'discord',
    form: {
      token: 'discord-token',
      applicationId: '123456789012345678',
    },
  })

  assert.equal(cfg.channels.discord.token, 'discord-token')
  assert.equal(cfg.channels.discord.applicationId, '123456789012345678')
})

test('OpenClaw 渠道保存第一个命名账号时会固定 defaultAccount', () => {
  const cfg = { channels: {} }

  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'telegram',
    accountId: 'alerts',
    form: { botToken: 'alerts-token' },
  })
  mergeOpenClawMessagingPlatformConfig(cfg, {
    platform: 'telegram',
    accountId: 'ops',
    form: { botToken: 'ops-token' },
  })

  assert.equal(cfg.channels.telegram.defaultAccount, 'alerts')
  assert.equal(cfg.channels.telegram.accounts.alerts.botToken, 'alerts-token')
  assert.equal(cfg.channels.telegram.accounts.ops.botToken, 'ops-token')
})

test('OpenClaw 渠道保存命名账号时不会覆盖已有默认账号或根凭证默认账号', () => {
  const explicitDefault = {
    channels: {
      discord: {
        defaultAccount: 'ops',
        accounts: { ops: { token: 'ops-token' } },
      },
    },
  }
  mergeOpenClawMessagingPlatformConfig(explicitDefault, {
    platform: 'discord',
    accountId: 'alerts',
    form: { token: 'alerts-token' },
  })

  const rootDefault = {
    channels: {
      slack: {
        mode: 'socket',
        botToken: 'root-bot',
        appToken: 'root-app',
      },
    },
  }
  mergeOpenClawMessagingPlatformConfig(rootDefault, {
    platform: 'slack',
    accountId: 'team-a',
    form: { mode: 'socket', botToken: 'team-bot', appToken: 'team-app' },
  })

  assert.equal(explicitDefault.channels.discord.defaultAccount, 'ops')
  assert.equal(explicitDefault.channels.discord.accounts.alerts.token, 'alerts-token')
  assert.equal(rootDefault.channels.slack.defaultAccount, undefined)
  assert.equal(rootDefault.channels.slack.accounts['team-a'].botToken, 'team-bot')
})
