// 渠道安装只接收 npm 包规格，不接收路径或 Shell 片段。
export function buildChannelPluginSpec(packageName, version = null) {
  const match = String(packageName || '').trim().match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._+-]*))?$/)
  if (!match) throw new Error('插件 npm 包名或版本格式无效')
  const selected = version == null || version === '' ? match[2] : String(version).trim()
  if (selected && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(selected)) throw new Error('插件版本格式无效')
  return match[1] + (selected ? `@${selected}` : '')
}

export function channelPluginHostVersion(version) {
  // 汉化后缀不是 npm 官方插件版本；保留官方本身的 -1/-2 修订号。
  return String(version || '').trim().replace(/^v/, '').replace(/-zh\..*$/, '') || null
}

export function validateChannelPluginId(value) {
  const id = String(value || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.includes('..')) throw new Error('插件 ID 格式无效')
  return id
}
