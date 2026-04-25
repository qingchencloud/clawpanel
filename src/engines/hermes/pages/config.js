/**
 * Hermes Agent 配置编辑
 */
import { t } from '../../../lib/i18n.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'

export function render() {
  const el = document.createElement('div')
  el.className = 'page'
  el.dataset.engine = 'hermes'
  let yaml = ''
  let loading = true
  let saving = false
  let error = ''

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function draw() {
    el.innerHTML = `
      <div class="hm-hero">
        <div class="hm-hero-title">
          <div class="hm-hero-eyebrow">HERMES AGENT · CONFIG</div>
          <h1 class="hm-hero-h1">${t('engine.hermesConfigTitle')}</h1>
          <div class="hm-hero-sub">~/.hermes/config.yaml</div>
        </div>
        <div class="hm-hero-actions">
          <button class="hm-btn hm-btn--ghost hm-btn--sm" id="hm-config-reload" ${loading || saving ? 'disabled' : ''}>重新加载</button>
          <button class="hm-btn hm-btn--cta hm-btn--sm" id="hm-config-save" ${loading || saving ? 'disabled' : ''}>保存配置</button>
        </div>
      </div>

      <div class="hm-panel">
        <div class="hm-panel-header">
          <div class="hm-panel-title">config.yaml</div>
          <div class="hm-panel-actions">
            <span class="hm-muted">${saving ? 'saving…' : loading ? 'loading…' : 'raw yaml editor'}</span>
          </div>
        </div>
        <div class="hm-panel-body" style="padding:0">
          ${error ? `<div style="margin:16px 18px;padding:10px 14px;border-radius:var(--hm-radius-sm);background:var(--hm-error-soft);color:var(--hm-error);font-family:var(--hm-font-mono);font-size:12px">${esc(error)}</div>` : ''}
          <textarea id="hm-config-yaml" class="hm-input" spellcheck="false" ${loading || saving ? 'disabled' : ''} style="width:100%;min-height:560px;border:0;border-radius:0;background:var(--hm-surface-0);font-family:var(--hm-font-mono);font-size:12px;line-height:1.7;padding:18px 20px;resize:vertical">${esc(yaml)}</textarea>
        </div>
      </div>
    `
    el.querySelector('#hm-config-reload')?.addEventListener('click', load)
    el.querySelector('#hm-config-save')?.addEventListener('click', save)
  }

  async function load() {
    loading = true
    error = ''
    draw()
    try {
      const data = await api.hermesConfigRawRead()
      yaml = data?.yaml || ''
    } catch (err) {
      error = String(err?.message || err).replace(/^Error:\s*/, '')
    } finally {
      loading = false
      draw()
    }
  }

  async function save() {
    const textarea = el.querySelector('#hm-config-yaml')
    yaml = textarea?.value || ''
    saving = true
    error = ''
    draw()
    try {
      await api.hermesConfigRawWrite(yaml)
      toast('配置已保存，建议重启 Hermes Gateway 生效', 'success')
    } catch (err) {
      error = String(err?.message || err).replace(/^Error:\s*/, '')
      toast(error, 'error')
    } finally {
      saving = false
      draw()
    }
  }

  draw()
  load()
  return el
}
