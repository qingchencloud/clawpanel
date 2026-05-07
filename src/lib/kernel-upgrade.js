/**
 * 一键升级内核
 *
 * 把 about 页升级流程的核心代码提取出来，让 sidebar / dashboard 也能复用。
 * 全程对小白透明：弹确认 → 进度展示 → 成功提示 / 失败提示，无需打开终端。
 */
import { api, isTauriRuntime } from './tauri-api.js'
import { showUpgradeModal, showConfirm } from '../components/modal.js'
import { setUpgrading } from './app-state.js'
import { toast } from '../components/toast.js'
import { t } from './i18n.js'
import { getKernelSnapshot } from './kernel.js'

/**
 * 触发一键升级。会自动检测当前内核 variant（官方/汉化）选择源，调推荐版本。
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.skipConfirm=false]  跳过确认对话框（不推荐）
 * @param {() => void} [opts.onDone]          升级成功完成时回调
 * @returns {Promise<boolean>} 启动了升级流程返回 true，用户取消返回 false
 */
export async function triggerKernelUpgrade(opts = {}) {
  const snap = getKernelSnapshot()
  if (!snap || snap.engine !== 'openclaw') {
    toast(t('common.unsupportedAction') || 'Unsupported', 'warning')
    return false
  }

  const variant = snap.variant === 'chinese' ? 'chinese' : 'official'
  const targetVersion = snap.target || ''

  // 1. 确认对话框
  if (!opts.skipConfirm) {
    const msg = t('kernel.upgrade.confirmMessage', {
      from: snap.versionLabel || snap.version || '?',
      to: targetVersion || t('kernel.badge.latest'),
    })
    const ok = await showConfirm(msg)
    if (!ok) return false
  }

  // 2. 进度弹窗
  const modal = showUpgradeModal(t('kernel.upgrade.title'))
  modal.onClose(() => { try { opts.onDone?.() } catch {} })
  let unlistenLog, unlistenProgress, unlistenDone, unlistenError
  setUpgrading(true)

  const cleanup = () => {
    unlistenLog?.()
    unlistenProgress?.()
    unlistenDone?.()
    unlistenError?.()
    setUpgrading(false)
  }

  try {
    if (isTauriRuntime() && window.__TAURI_INTERNALS__) {
      // 桌面端：订阅原生事件流
      const { listen } = await import('@tauri-apps/api/event')
      unlistenLog = await listen('upgrade-log', (e) => modal.appendLog(e.payload))
      unlistenProgress = await listen('upgrade-progress', (e) => modal.setProgress(e.payload))
      unlistenDone = await listen('upgrade-done', (e) => {
        cleanup()
        const msg = typeof e.payload === 'string'
          ? e.payload
          : t('kernel.upgrade.successMessage')
        modal.setDone(msg)
        toast(t('kernel.upgrade.successToast'), 'success')
      })
      unlistenError = await listen('upgrade-error', (e) => {
        cleanup()
        modal.setError(t('kernel.upgrade.failurePrefix') + ' ' + (e.payload || ''))
      })

      modal.appendLog(t('kernel.upgrade.starting', { version: targetVersion || t('common.recommended') }))
      // version=null 让后端按 openclaw-version-policy.json 自己挑推荐版
      await api.upgradeOpenclaw(variant, null, 'auto')
    } else {
      // Web 模式：单次同步调用，无进度事件
      modal.appendLog(t('kernel.upgrade.starting', { version: targetVersion || t('common.recommended') }))
      const result = await api.upgradeOpenclaw(variant, null, 'auto')
      modal.setProgress(100)
      modal.setDone(typeof result === 'string' ? result : t('kernel.upgrade.successMessage'))
      toast(t('kernel.upgrade.successToast'), 'success')
      cleanup()
    }
    return true
  } catch (e) {
    console.error('[kernel-upgrade] 升级失败', e)
    modal.setError(t('kernel.upgrade.failurePrefix') + ' ' + (e?.message || String(e)))
    cleanup()
    return false
  }
}
