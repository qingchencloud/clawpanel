import { api, invalidate } from './tauri-api.js'
import { showConfirm, showContentModal } from '../components/modal.js'
import { navigate } from '../router.js'
import { t } from './i18n.js'
import { diagnoseGatewayStartFailure } from './gateway-start-diagnosis.js'
import { triggerOpenclawRuntimeRepair } from './openclaw-runtime-repair.js'

function errorText(error) {
  return String(error?.message || error || '').trim()
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1***')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1***')
}

function fulfilledText(result) {
  return result.status === 'fulfilled' ? String(result.value || '').trim() : ''
}

export async function collectGatewayStartDiagnostics(error) {
  invalidate('read_log_tail')
  const [stderrResult, stdoutResult, guardianResult] = await Promise.allSettled([
    api.readLogTail('gateway-err', 80),
    api.readLogTail('gateway', 50),
    api.readLogTail('guardian', 30),
  ])
  return {
    reason: redactSecrets(errorText(error)),
    stderr: redactSecrets(fulfilledText(stderrResult)),
    stdout: redactSecrets(fulfilledText(stdoutResult)),
    guardian: redactSecrets(fulfilledText(guardianResult)),
  }
}

function renderDiagnosticText(diagnostics, diagnosis = null) {
  const sections = []
  if (diagnosis?.code === 'missing-runtime-dependency') {
    sections.push(`${t('services.gatewayDiagnosticsDiagnosis')}\n${t('services.gatewayDiagnosticsMissingDependency', { dependency: diagnosis.missingPackage })}`)
  }
  if (diagnostics.reason) sections.push(`${t('services.gatewayDiagnosticsReason')}\n${diagnostics.reason}`)
  if (diagnostics.stderr) sections.push(`${t('services.gatewayDiagnosticsErrorLog')}\n${diagnostics.stderr}`)
  if (diagnostics.stdout) sections.push(`${t('services.gatewayDiagnosticsOutputLog')}\n${diagnostics.stdout}`)
  if (diagnostics.guardian) sections.push(`${t('services.gatewayDiagnosticsGuardianLog')}\n${diagnostics.guardian}`)
  return sections.join('\n\n') || t('services.gatewayDiagnosticsNoLogs')
}

/**
 * 显示持久的 Gateway 启动诊断，不再只依赖数秒后消失的 toast。
 * 内容通过 textContent 写入，避免日志中的任意文本被当作 HTML 执行。
 */
export async function showGatewayStartDiagnostics(error) {
  const overlay = showContentModal({
    title: t('services.gatewayDiagnosticsTitle'),
    content: `
      <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:12px">
        ${t('services.gatewayDiagnosticsHint')}
      </div>
      <pre data-gateway-diagnostics style="margin:0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.55 var(--font-mono);background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:12px">${t('common.loading')}</pre>
    `,
    width: 720,
    buttons: [
      { id: 'gateway-diagnostics-logs', label: t('sidebar.logs'), className: 'btn btn-secondary btn-sm' },
      { id: 'gateway-diagnostics-repair', label: t('sidebar.chatDebug'), className: 'btn btn-primary btn-sm' },
      { id: 'gateway-diagnostics-runtime-repair', label: t('services.gatewayDiagnosticsRepair'), className: 'btn btn-primary btn-sm' },
    ],
  })
  const runtimeRepairButton = overlay.querySelector('#gateway-diagnostics-runtime-repair')
  if (runtimeRepairButton) runtimeRepairButton.hidden = true
  let detectedIssue = null
  overlay.querySelector('#gateway-diagnostics-logs')?.addEventListener('click', () => {
    overlay.close()
    navigate('/logs')
  })
  overlay.querySelector('#gateway-diagnostics-repair')?.addEventListener('click', () => {
    overlay.close()
    navigate('/chat-debug')
  })
  runtimeRepairButton?.addEventListener('click', async () => {
    if (!detectedIssue) return
    const confirmed = await showConfirm(t('services.gatewayDiagnosticsRepairConfirm', {
      dependency: detectedIssue.missingPackage,
    }))
    if (!confirmed) return
    overlay.close()
    await triggerOpenclawRuntimeRepair(detectedIssue)
  })

  const target = overlay.querySelector('[data-gateway-diagnostics]')
  try {
    const diagnostics = await collectGatewayStartDiagnostics(error)
    detectedIssue = diagnoseGatewayStartFailure(diagnostics)
    if (runtimeRepairButton) runtimeRepairButton.hidden = !detectedIssue?.repairable
    if (target) target.textContent = renderDiagnosticText(diagnostics, detectedIssue)
  } catch (diagnosticError) {
    if (target) target.textContent = redactSecrets(errorText(error) || errorText(diagnosticError))
  }
  return overlay
}
