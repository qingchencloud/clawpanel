import { showUpgradeModal } from '../components/modal.js'
import { setUpgrading } from './app-state.js'
import { api, isTauriRuntime, safeTauriListen } from './tauri-api.js'
import { t } from './i18n.js'

function sourceFromVersionInfo(info, fallback) {
  const source = String(info?.source || '').toLowerCase()
  const cliSource = String(info?.cli_source || '').toLowerCase()
  if (source === 'chinese' || cliSource === 'npm-zh' || cliSource === 'standalone' || cliSource === 'portable') return 'chinese'
  if (source === 'official' || cliSource === 'npm-official' || cliSource === 'npm-global') return 'official'
  return fallback === 'official' ? 'official' : 'chinese'
}

function methodFromVersionInfo(info, fallback) {
  const cliSource = String(info?.cli_source || '').toLowerCase()
  if (cliSource === 'standalone' || cliSource === 'portable') return 'auto'
  if (cliSource.startsWith('npm')) return 'npm'
  return fallback === 'auto' ? 'auto' : 'npm'
}

/**
 * 强制重装当前 OpenClaw 稳定版，后端会校验主包版本和全部运行依赖；
 * 修复完成后自动重试启动 Gateway。
 */
export async function triggerOpenclawRuntimeRepair(issue = {}) {
  const modal = showUpgradeModal(t('services.gatewayDiagnosticsRepairTitle'))
  let unlistenLog, unlistenProgress, unlistenDone, unlistenError
  let finished = false
  setUpgrading(true)

  const cleanup = () => {
    unlistenLog?.()
    unlistenProgress?.()
    unlistenDone?.()
    unlistenError?.()
    setUpgrading(false)
  }

  const fail = (error) => {
    if (finished) return
    finished = true
    cleanup()
    modal.setError(`${t('services.gatewayDiagnosticsRepairFailed')}: ${error?.message || error}`)
  }

  const finish = async (message) => {
    if (finished) return
    finished = true
    cleanup()
    modal.appendLog(t('services.gatewayDiagnosticsRestarting'))
    try {
      await api.startService('gateway')
      modal.setDone(`${message || t('services.gatewayDiagnosticsRepairDone')}\n${t('services.gatewayDiagnosticsRestarted')}`)
    } catch (error) {
      modal.setError(`${t('services.gatewayDiagnosticsRepairInstalledButStartFailed')}: ${error?.message || error}`)
    }
  }

  try {
    const info = await api.getVersionInfo().catch(() => null)
    const source = sourceFromVersionInfo(info, issue.source)
    const method = methodFromVersionInfo(info, issue.method)
    modal.appendLog(t('services.gatewayDiagnosticsRepairStarting', {
      dependency: issue.missingPackage || '@openclaw/ai',
    }))

    if (isTauriRuntime()) {
      unlistenLog = await safeTauriListen('upgrade-log', event => modal.appendLog(event.payload))
      unlistenProgress = await safeTauriListen('upgrade-progress', event => modal.setProgress(event.payload))
      unlistenDone = await safeTauriListen('upgrade-done', event => finish(event.payload))
      unlistenError = await safeTauriListen('upgrade-error', event => fail(event.payload))
      await api.upgradeOpenclaw(source, null, method)
    } else {
      const result = await api.upgradeOpenclaw(source, null, method)
      modal.setProgress(100)
      await finish(typeof result === 'string' ? result : result?.message)
    }
    return true
  } catch (error) {
    fail(error)
    return false
  }
}
