import fs from 'node:fs'

// 与桌面端共用已核实的发布包边界，不跟随可变 latest 将旧内核升级到不兼容插件。
const policy = JSON.parse(fs.readFileSync(new URL('../src/lib/weixin-compat-policy.json', import.meta.url), 'utf8'))
function versionParts(value) {
  // 汉化后缀同样必须是已知的数字修订，不能截掉未知 preview 后把它当稳定版。
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?(?:-zh\.(\d+))?$/)
  if (!match) return null
  const parts = match.slice(1).filter(part => part !== undefined).map(Number)
  return parts.every(n => Number.isSafeInteger(n) && n <= 0xffffffff) ? parts.slice(0, 3) : null
}
function pluginParts(value) {
  const text = String(value || '').trim()
  return /^\d+\.\d+\.\d+$/.test(text) ? versionParts(text) : null
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
function hostFits(host, line) {
  return compare(host, versionParts(line.hostMin)) >= 0 && (!line.hostBefore || compare(host, versionParts(line.hostBefore)) < 0)
}

const unknownHostError = '未识别 OpenClaw 稳定版本，请先安装或检查内核版本，再安装微信插件。'
function unknownPluginError(version) {
  const plugin = pluginParts(version)
  const prefix = plugin && compare(plugin, pluginParts(policy.reviewedVersion)) > 0 ? '检测到更高版本微信插件' : '微信插件'
  return `${prefix} ${String(version || '版本未知').trim()} 尚未纳入已核实兼容矩阵（最高 ${policy.reviewedVersion}）；请保留现有插件，不会自动更新或降级。`
}

export function weixinCompatibility(hostVersion, pluginVersion) {
  const host = versionParts(hostVersion), plugin = pluginParts(pluginVersion)
  const line = plugin && policy.lines.find(l => compare(plugin, versionParts(l.pluginMin)) >= 0 && compare(plugin, versionParts(l.pluginMax)) <= 0)
  if (!host) return { compatible: null, compatError: unknownHostError }
  if (!line) return { compatible: null, compatError: unknownPluginError(pluginVersion) }
  const range = `>=${line.hostMin}${line.hostBefore ? ` <${line.hostBefore}` : ''}`
  const compatible = hostFits(host, line)
  return { compatible, compatError: compatible ? '' : `微信插件 ${pluginVersion} 要求 OpenClaw ${range}，当前为 ${hostVersion}。` }
}

export function resolveWeixinInstallVersion(hostVersion, requestedVersion) {
  const host = versionParts(hostVersion)
  if (!host) throw new Error(unknownHostError)
  const line = [...policy.lines].reverse().find(l => hostFits(host, l))
  if (!requestedVersion && !line) throw new Error(`当前 OpenClaw ${hostVersion} 低于已核实微信插件的最低要求 >=${policy.lines[0].hostMin}；请先升级内核，不会自动安装或降级插件。`)
  const version = requestedVersion || line?.target
  const check = weixinCompatibility(hostVersion, version)
  if (check.compatible !== true) throw new Error(check.compatError)
  return version
}

export function buildWeixinCompatibilityStatus(hostVersion, installedVersion) {
  let recommendedVersion = null, installError = ''
  try { recommendedVersion = resolveWeixinInstallVersion(hostVersion) } catch (error) { installError = error.message }
  const installed = weixinCompatibility(hostVersion, installedVersion)
  // 新于已核实版本时不提供自动降级，需人工复核新版本契约。
  const known = !installedVersion || installed.compatible !== null
  if (!known) recommendedVersion = null
  return {
    ...installed, hostVersion, recommendedVersion,
    installAllowed: !!recommendedVersion && known,
    installError: installError || (!known ? installed.compatError : ''),
    updateAvailable: !!installedVersion && known && !!recommendedVersion && compare(versionParts(installedVersion), versionParts(recommendedVersion)) < 0,
  }
}
