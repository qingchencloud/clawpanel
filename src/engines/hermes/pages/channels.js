/**
 * Hermes Agent 渠道配置
 */
import { t } from '../../../lib/i18n.js'

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'
  el.innerHTML = `
    <div class="page-header"><h1>${t('engine.hermesChannelsTitle')}</h1></div>
    <div class="card"><div class="card-body" style="padding:32px;text-align:center;color:var(--text-tertiary)">
      ${t('engine.comingSoonPhase2')}
    </div></div>
  `
  return el
}
