/**
 * OpenClaw CLI 检测结果展示辅助
 */

const PATH_SOURCE_LABELS = {
  panel: '固定路径（面板配置）',
  process: '运行中 Gateway 进程',
  where: 'PATH / where 检测',
  npm: '全局 npm 默认路径',
  path: 'PATH 检测',
  none: '未检测到',
}

export function getCliPathSourceLabel(source) {
  return PATH_SOURCE_LABELS[source] || source || '未检测到'
}

export function getCliVersionSourceLabel(meta) {
  if (!meta?.version) return '未检测到'
  return `通过当前 CLI 路径获取（${meta.pathSourceLabel}）`
}

export function buildOpenclawCliMeta(service, options = {}) {
  const overridePath = String(options.overridePath || '').trim()
  const path = String(service?.cli_path || '').trim()
  const version = String(service?.cli_version || '').trim()
  const pathSource = String(service?.cli_source || '').trim() || 'none'
  const installed = service?.cli_installed !== false && !!path
  const pinned = pathSource === 'panel' || !!overridePath
  const pathSourceLabel = getCliPathSourceLabel(pathSource)

  return {
    installed,
    path,
    version,
    pathSource,
    pathSourceLabel,
    versionSourceLabel: getCliVersionSourceLabel({ version, pathSourceLabel }),
    overridePath,
    pinned,
    statusLabel: installed ? '已检测到 OpenClaw CLI' : '未检测到 OpenClaw CLI',
    strategyLabel: pinned ? '固定路径' : '自动检测',
  }
}
