import fs from 'node:fs'
import path from 'node:path'
import { buildChannelPluginSpec, validateChannelPluginId } from '../src/lib/channel-plugin-spec.js'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function pluginMatches(dir, id) {
  const manifest = readJson(path.join(dir, 'openclaw.plugin.json'))
  if (manifest?.id) return manifest.id === id
  return path.basename(dir) === id && fs.existsSync(path.join(dir, 'package.json'))
}

function findPlugin(root, id) {
  if (!root || !fs.existsSync(root)) return null
  const direct = path.join(root, id)
  if (pluginMatches(direct, id)) return direct
  // 包目录名与运行时 ID 不总相同，例如 openclaw-qqbot / qqbot。
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (pluginMatches(dir, id)) return dir
    if (entry.name.startsWith('@')) {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        if (child.isDirectory() && pluginMatches(path.join(dir, child.name), id)) return path.join(dir, child.name)
      }
    }
  }
  return null
}

export function channelPluginStatusAt(root, pluginId, packageRoot = null, config = {}) {
  const id = validateChannelPluginId(pluginId)
  const installedPath = findPlugin(path.join(root, 'extensions'), id)
    || findPlugin(path.join(root, 'plugins', 'node_modules'), id)
  const builtinPath = packageRoot && (findPlugin(path.join(packageRoot, 'extensions'), id)
    || findPlugin(path.join(packageRoot, 'dist', 'extensions'), id)
    || findPlugin(path.join(packageRoot, 'node_modules'), id))
  return {
    installed: !!installedPath, builtin: !!builtinPath,
    path: installedPath || builtinPath || path.join(root, 'extensions', id),
    allowed: Array.isArray(config.plugins?.allow) && config.plugins.allow.includes(id),
    enabled: config.plugins?.entries?.[id]?.enabled === true,
    legacyBackupDetected: fs.existsSync(path.join(root, 'extensions', `${id}.bak`)),
  }
}

export function redactPluginOutput(value) {
  return String(value || '').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
}

export function channelPluginStatusFromInventory(status, pluginId, inventory) {
  const id = validateChannelPluginId(pluginId)
  const doc = typeof inventory === 'string' ? JSON.parse(inventory) : inventory
  const entry = doc?.plugins?.find(p => p.id === id)
  // 注册记录不是安装成功的充分条件，仍核对实际目录和插件 manifest。
  if (!entry?.rootDir || !pluginMatches(entry.rootDir, id)) return status
  return { ...status, installed: entry.origin !== 'bundled', builtin: entry.origin === 'bundled', path: entry.rootDir, enabled: entry.enabled === true }
}

const running = new Set()

export async function installChannelPluginAt({ root, packageName, pluginId, version, hostVersion, updateExisting = false, replaceExisting = false, expectedVersion, run, status, enable, onEvent = () => {} }) {
  const id = validateChannelPluginId(pluginId)
  const spec = buildChannelPluginSpec(packageName, version)
  const key = path.resolve(root)
  if (running.has(key)) throw new Error('已有渠道插件正在安装，请等待完成后再试')
  running.add(key)
  try {
    const before = await status(id)
    const updating = before.installed && updateExisting
    if (before.builtin || (before.installed && !updating)) {
      await enable(id)
      return '插件已就绪'
    }
    onEvent({ event: 'plugin-log', payload: updating ? `更新已安装插件: ${id}` : `安装规格: ${spec}` })
    const args = updating && !replaceExisting ? ['plugins', 'update', id] : ['plugins', 'install', spec]
    // 9.4 对显式 npm 源要求确认；仅在首次安装时确认来源，不覆盖已有插件，保留安全策略检查。
    const v = String(hostVersion || '').match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!updating && v && (Number(v[1]) > 2026 || (Number(v[1]) === 2026 && (Number(v[2]) > 9 || (Number(v[2]) === 9 && Number(v[3]) >= 4))))) args.push('--force')
    // 明确的微信兼容版本替换不能沿用历史 latest 安装记录；由 CLI 完成事务，不预删目录。
    if (updating && replaceExisting) args.push('--force')
    const result = await run(args, text => onEvent({ event: 'plugin-log', payload: redactPluginOutput(text) }))
    const output = redactPluginOutput([result.stdout, result.stderr].filter(Boolean).join('\n')).slice(-12000)
    if (result.status !== 0) throw new Error(`插件 ${id} 安装失败（退出码 ${result.status ?? 'unknown'}）\n${output}`)
    const after = await status(id)
    if (!after.installed && !after.builtin) throw new Error(`插件 ${id} 安装进程已结束，但未检测到插件文件，请检查安装日志\n${output}`)
    if (expectedVersion && readJson(path.join(after.path || '', 'package.json'))?.version !== expectedVersion) {
      throw new Error(`插件 ${id} 版本回读不一致（预期 ${expectedVersion}），请检查安装日志\n${output}`)
    }
    await enable(id)
    onEvent({ event: 'plugin-progress', payload: 100 })
    return updating ? '插件更新完成' : '安装成功'
  } finally {
    running.delete(key)
  }
}
