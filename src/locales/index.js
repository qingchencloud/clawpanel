/**
 * 语言包聚合入口
 * 从 modules/ 导入所有模块，按语言合并输出
 */
import { SUPPORTED_LANGS } from './helper.js'
import common from './modules/common.js'
import sidebar from './modules/sidebar.js'
import instance from './modules/instance.js'
import dashboard from './modules/dashboard.js'
import services from './modules/services.js'
import settings from './modules/settings.js'
import models from './modules/models.js'
import agents from './modules/agents.js'
import agentDetail from './modules/agentDetail.js'
import gateway from './modules/gateway.js'
import security from './modules/security.js'
import communication from './modules/communication.js'
import channels from './modules/channels.js'
import memory from './modules/memory.js'
import dreaming from './modules/dreaming.js'
import cron from './modules/cron.js'
import usage from './modules/usage.js'
import skills from './modules/skills.js'
import chat from './modules/chat.js'
import chatDebug from './modules/chat-debug.js'
import setup from './modules/setup.js'
import about from './modules/about.js'
import ext from './modules/ext.js'
import logs from './modules/logs.js'
import assistant from './modules/assistant.js'
import toast from './modules/toast.js'
import modal from './modules/modal.js'
import engagement from './modules/engagement.js'
import diagnose from './modules/diagnose.js'
import routeMap from './modules/routeMap.js'
import extensions from './modules/extensions.js'
import engine from './modules/engine.js'
import ciaoBug from './modules/ciaoBug.js'
import cliConflict from './modules/cliConflict.js'

const MODULES = {
  common, sidebar, instance, dashboard, services, settings,
  models, agents, agentDetail, gateway, security, communication, channels,
  memory, dreaming, cron, usage, skills, chat, chatDebug, setup, about,
  ext, logs, assistant, toast, modal, engagement, diagnose, routeMap, extensions,
  engine, ciaoBug, cliConflict,
}

/** 构建所有语言字典 { 'zh-CN': { common: {...}, sidebar: {...}, ... }, ... } */
export function buildLocales() {
  const result = {}
  for (const lang of SUPPORTED_LANGS) {
    result[lang] = {}
    for (const [mod, entries] of Object.entries(MODULES)) {
      result[lang][mod] = {}
      for (const [key, translations] of Object.entries(entries)) {
        result[lang][mod][key] = translations[lang] || translations['zh-CN'] || key
      }
    }
  }
  return result
}
