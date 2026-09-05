/**
 * 从 Gateway 启动返回和日志中提取可直接处理的问题。
 * 保持为纯函数，便于在 Node 测试中覆盖真实错误样本。
 */
export function diagnoseGatewayStartFailure(diagnostics = {}) {
  const text = [
    diagnostics.reason,
    diagnostics.stderr,
    diagnostics.stdout,
    diagnostics.guardian,
  ].filter(Boolean).join('\n')

  const missingPackage = text.match(/cannot find package\s+['"]([^'"]+)['"]/i)?.[1]
  const moduleNotFound = /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|cannot find (?:package|module))/i.test(text)
  if (!missingPackage || !moduleNotFound) return null

  const normalized = text.replace(/\\/g, '/').toLowerCase()
  const source = normalized.includes('@qingchencloud/openclaw-zh') ? 'chinese' : 'official'
  const method = normalized.includes('/npm/node_modules/') || normalized.includes('/roaming/npm/')
    ? 'npm'
    : 'auto'

  return {
    code: 'missing-runtime-dependency',
    missingPackage,
    source,
    method,
    repairable: true,
  }
}
