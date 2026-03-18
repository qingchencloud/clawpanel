export function renderAssistantSettingsModal({
  config,
  assistantName,
  apiTypes,
  providerPresets,
  qtcool,
  defaultName,
  defaultPersonality,
  normalizeApiType,
  apiBasePlaceholder,
  apiKeyPlaceholder,
  apiHintText,
  escHtml,
  icon,
}) {
  const c = config
  return `
    <div class="modal" style="max-width:500px">
      <div class="modal-title" style="margin-bottom:0">${assistantName || defaultName} — 设置</div>
      <div class="ast-settings-tabs">
        <button class="ast-tab active" data-tab="api">模型配置</button>
        <button class="ast-tab" data-tab="tools">工具权限</button>
        <button class="ast-tab" data-tab="persona">助手人设</button>
        <button class="ast-tab" data-tab="knowledge">知识库</button>
      </div>
      <div class="modal-body">
      <div class="ast-settings-form">
        <div class="ast-tab-panel active" data-panel="api">
          <div class="form-group" style="margin-bottom:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <label class="form-label" style="margin:0">快捷选择</label>
              <button class="btn btn-sm btn-secondary" id="ast-import-openclaw">从 openclaw 导入</button>
            </div>
            <div id="ast-provider-presets" style="display:flex;flex-wrap:wrap;gap:6px">
              ${providerPresets.filter(p => !p.hidden).map(p => `<button class="btn btn-sm btn-secondary ast-preset-btn" data-key="${p.key}" data-url="${escHtml(p.baseUrl)}" data-api="${p.api}" style="font-size:12px;padding:3px 10px">${p.label}${p.badge ? ' <span style="font-size:9px;background:var(--accent);color:#fff;padding:1px 4px;border-radius:6px;margin-left:3px">' + p.badge + '</span>' : ''}</button>`).join('')}
            </div>
            <div id="ast-preset-detail" style="display:none;margin-top:6px;padding:8px 12px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:12px"></div>
          </div>
          <div style="display:flex;gap:10px">
            <div class="form-group" style="flex:1">
              <label class="form-label">API Base URL</label>
              <input class="form-input" id="ast-baseurl" value="${escHtml(c.baseUrl)}" placeholder="${escHtml(apiBasePlaceholder(c.apiType))}">
            </div>
            <div class="form-group" style="width:170px">
              <label class="form-label">API 类型</label>
              <select class="form-input" id="ast-apitype">
                ${apiTypes.map(t => `<option value="${t.value}" ${c.apiType === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1;margin-bottom:0">
              <label class="form-label">API Key</label>
              <input class="form-input" id="ast-apikey" type="password" value="${escHtml(c.apiKey)}" placeholder="${escHtml(apiKeyPlaceholder(c.apiType))}">
            </div>
            <div style="display:flex;gap:6px;padding-bottom:1px">
              <button class="btn btn-sm btn-secondary" id="ast-btn-test" title="测试连通性">测试</button>
              <button class="btn btn-sm btn-secondary" id="ast-btn-models" title="从 API 获取可用模型">拉取</button>
              <button class="btn btn-sm btn-secondary" id="ast-btn-import" title="从 OpenClaw 导入模型配置">${icon('download', 14)} 导入</button>
            </div>
          </div>
          <div id="ast-test-result" style="margin:6px 0 2px;font-size:12px;min-height:16px"></div>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div class="form-group" style="flex:1">
              <label class="form-label">模型</label>
              <div style="position:relative">
                <input class="form-input" id="ast-model" value="${escHtml(c.model)}" placeholder="gpt-4o / deepseek-chat" autocomplete="off">
                <div id="ast-model-dropdown" class="ast-model-dropdown" style="display:none"></div>
              </div>
            </div>
            <div class="form-group" style="width:80px">
              <label class="form-label">温度</label>
              <input class="form-input" id="ast-temp" type="number" value="${c.temperature || 0.7}" min="0" max="2" step="0.1">
            </div>
          </div>
          <div class="form-hint" id="ast-api-hint" style="margin-top:-4px">${apiHintText(c.apiType)}</div>

          <div id="ast-qtcool-promo" style="margin-top:14px;border-radius:var(--radius-lg);background:var(--bg-tertiary);border:1px solid var(--border-primary);overflow:hidden">
            <div style="padding:14px 16px 10px">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                ${icon('zap', 16)}
                <span style="font-weight:600;font-size:var(--font-size-sm)">晴辰云快捷接入</span>
                <span style="font-size:10px;background:var(--primary);color:#fff;padding:1px 6px;border-radius:8px">推荐</span>
              </div>
              <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.5;margin-bottom:10px">
                面板用户免费使用部分模型，付费用户享全系列顶级模型，全部低至 2-3 折。选择模型后一键接入。
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <select id="ast-qtcool-model" class="form-input" style="font-size:12px;padding:5px 10px;min-width:140px;flex:1">
                  <option value="" disabled selected>加载模型列表...</option>
                </select>
                <button class="btn btn-sm btn-secondary" id="ast-qtcool-test">${icon('search', 12)} 测试</button>
                <button class="btn btn-sm btn-primary" id="ast-qtcool-apply">${icon('zap', 12)} 接入</button>
              </div>
              <div id="ast-qtcool-status" style="margin-top:8px;font-size:11px;min-height:16px;line-height:1.5"></div>
            </div>
            <div style="border-top:1px solid var(--border-primary);padding:8px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;background:var(--bg-secondary)">
              <label style="cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-tertiary)">
                <input type="checkbox" id="ast-qtcool-customkey" style="accent-color:var(--primary);width:13px;height:13px"> 使用自定义密钥
              </label>
              <div style="display:flex;gap:12px;font-size:11px">
                <a href="${qtcool.site}" target="_blank" style="color:var(--primary);text-decoration:none">${icon('external-link', 12)} 了解更多</a>
              </div>
            </div>
            <div id="ast-qtcool-keyrow" style="display:none;border-top:1px solid var(--border-primary);padding:8px 16px;background:var(--bg-tertiary)">
              <input class="form-input" id="ast-qtcool-key" placeholder="粘贴你的密钥" style="font-size:12px;padding:6px 10px">
            </div>
          </div>
        </div>
        <div class="ast-tab-panel" data-panel="tools">
          <div class="form-hint" style="margin-bottom:10px">工具开关优先级高于模式设置。关闭的工具在任何模式下都不可用。</div>
          <label class="ast-switch-row">
            <span>终端工具 <span style="color:var(--text-tertiary);font-size:11px">— 允许执行 Shell 命令</span></span>
            <input type="checkbox" id="ast-tool-terminal" ${c.tools?.terminal !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>文件工具 <span style="color:var(--text-tertiary);font-size:11px">— 允许读写文件和浏览目录</span></span>
            <input type="checkbox" id="ast-tool-fileops" ${c.tools?.fileOps !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <label class="ast-switch-row">
            <span>联网搜索 <span style="color:var(--text-tertiary);font-size:11px">— 允许搜索互联网和抓取网页</span></span>
            <input type="checkbox" id="ast-tool-websearch" ${c.tools?.webSearch !== false ? 'checked' : ''}>
            <span class="ast-switch-track"></span>
          </label>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color)">
            <div class="form-group" style="margin-bottom:4px">
              <label class="form-label">工具连续执行轮次 <span style="color:var(--text-tertiary);font-size:11px">— 超过该轮次后暂停并询问</span></label>
              <select class="form-input" id="ast-auto-rounds" style="width:100%">
                <option value="0" ${(c.autoRounds ?? 8) === 0 ? 'selected' : ''}>∞ 无限制（一直执行，不中断）</option>
                <option value="8" ${(c.autoRounds ?? 8) === 8 ? 'selected' : ''}>8 轮（默认）</option>
                <option value="15" ${(c.autoRounds ?? 8) === 15 ? 'selected' : ''}>15 轮</option>
                <option value="30" ${(c.autoRounds ?? 8) === 30 ? 'selected' : ''}>30 轮</option>
                <option value="50" ${(c.autoRounds ?? 8) === 50 ? 'selected' : ''}>50 轮</option>
              </select>
            </div>
            <div class="form-hint">设为「无限制」时 AI 将不会中断执行，适合复杂任务。随时可点停止按钮手动中止。</div>
          </div>
          <div class="form-hint" style="margin-top:10px">进程列表、端口检测、系统信息工具始终可用（非聊天模式下）。</div>
        </div>
        <div class="ast-tab-panel" data-panel="persona">
          <div class="form-group">
            <label class="form-label">身份来源</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="default" ${!c.soulSource || c.soulSource === 'default' ? 'checked' : ''}>
                <span>ClawPanel 默认人设</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="ast-soul-source" value="openclaw" ${c.soulSource?.startsWith('openclaw:') ? 'checked' : ''}>
                <span>OpenClaw Agent 身份 <span style="font-size:11px;color:var(--text-tertiary)">（借尸还魂）</span></span>
              </label>
            </div>
          </div>
          <div id="ast-soul-default" style="${c.soulSource?.startsWith('openclaw:') ? 'display:none' : ''}">
            <div class="form-group">
              <label class="form-label">助手名称</label>
              <input class="form-input" id="ast-name" value="${escHtml(c.assistantName || defaultName)}" placeholder="${defaultName}">
            </div>
            <div class="form-group">
              <label class="form-label">助手性格</label>
              <textarea class="form-input" id="ast-personality" rows="3" placeholder="${defaultPersonality}" style="resize:vertical">${escHtml(c.assistantPersonality || defaultPersonality)}</textarea>
              <div class="form-hint">描述助手的说话风格和行为方式，会注入到系统提示词中</div>
            </div>
          </div>
          <div id="ast-soul-openclaw" style="${c.soulSource?.startsWith('openclaw:') ? '' : 'display:none'}">
            <div class="form-group" style="margin-top:4px">
              <label class="form-label">选择 Agent</label>
              <div style="display:flex;gap:6px;align-items:center">
                <select class="form-input" id="ast-soul-agent" style="flex:1;font-family:var(--font-mono);font-size:13px">
                  <option value="" disabled>扫描中...</option>
                </select>
                <button class="btn btn-sm btn-primary" id="ast-btn-load-soul" style="gap:4px;white-space:nowrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
                  加载灵魂
                </button>
                <button class="btn btn-sm btn-ghost" id="ast-btn-refresh-soul" style="gap:4px;white-space:nowrap" title="重新扫描 Agent 列表">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
              </div>
            </div>
            <div id="ast-soul-status" class="ast-soul-card" style="margin-top:8px">
              <div style="text-align:center;padding:16px 0;color:var(--text-tertiary);font-size:12px">
                选择 Agent 后点击「加载灵魂」读取身份文件
              </div>
            </div>
            <div class="form-hint" style="margin-top:8px">附身后助手将继承 Agent 的人格、记忆和用户偏好，同时保留 ClawPanel 的工具能力。</div>
          </div>
        </div>
        <div class="ast-tab-panel" data-panel="knowledge">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div class="form-hint" style="margin:0">为助手添加自定义知识，对话时会自动注入到系统提示词中。</div>
            <button class="btn btn-sm btn-primary" id="ast-kb-add" style="gap:4px;white-space:nowrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              添加
            </button>
          </div>
          <div id="ast-kb-editor" style="display:none;margin-bottom:10px">
            <div class="form-group" style="margin-bottom:6px">
              <input class="form-input" id="ast-kb-name" placeholder="知识名称，如：产品文档、API参考" style="font-size:13px">
            </div>
            <div class="form-group" style="margin-bottom:6px">
              <textarea class="form-input" id="ast-kb-content" rows="6" placeholder="粘贴知识内容（支持 Markdown 格式）..." style="resize:vertical;font-size:12px;font-family:var(--font-mono)"></textarea>
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-sm btn-secondary" id="ast-kb-cancel">取消</button>
              <button class="btn btn-sm btn-primary" id="ast-kb-save">保存知识</button>
            </div>
          </div>
          <div class="ast-soul-card" id="ast-kb-list"></div>
          <div class="form-hint" style="margin-top:8px" id="ast-kb-hint"></div>
        </div>
      </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">保存</button>
      </div>
    </div>
  `
}

export function renderAssistantKnowledgeList({ kbFiles, kbListEl, kbHintEl, escHtml }) {
  if (kbFiles.length === 0) {
    kbListEl.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--text-tertiary);font-size:12px">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:6px;opacity:0.4"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <div>点击「添加」按钮添加知识文件</div></div>`
    kbHintEl.textContent = ''
    return
  }
  const totalSize = kbFiles.reduce((sum, file) => sum + (file.content?.length || 0), 0)
  const sizeStr = totalSize > 1024 ? (totalSize / 1024).toFixed(1) + ' KB' : totalSize + ' B'
  const enabledCount = kbFiles.filter(file => file.enabled !== false).length
  kbHintEl.textContent = `共 ${kbFiles.length} 个知识文件（${enabledCount} 个启用，${sizeStr}），保存后生效。`

  let html = '<div class="ast-soul-files">'
  kbFiles.forEach((file, index) => {
    const fileSize = file.content?.length > 1024 ? (file.content.length / 1024).toFixed(1) + ' KB' : (file.content?.length || 0) + ' B'
    const enabled = file.enabled !== false
    html += `<div class="ast-soul-file ${enabled ? 'loaded' : 'missing'}" data-kb-idx="${index}" style="cursor:pointer" title="点击编辑">
      <button style="padding:2px;background:none;border:none;cursor:pointer;flex-shrink:0" data-kb-toggle="${index}" title="${enabled ? '点击禁用' : '点击启用'}">
        <div class="ast-soul-file-icon">${enabled ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>'}</div>
      </button>
      <div class="ast-soul-file-info">
        <span class="ast-soul-file-name">${escHtml(file.name)}</span>
        <span class="ast-soul-file-desc">${file.content?.split('\n').length || 0} 行 · 点击编辑</span>
      </div>
      <span class="ast-soul-file-size">${fileSize}</span>
      <button class="btn btn-sm" style="padding:2px 6px;font-size:11px;color:var(--error);background:none;border:none;cursor:pointer" data-kb-del="${index}" title="删除">✕</button>
    </div>`
  })
  html += '</div>'
  kbListEl.innerHTML = html
}

export function updateAssistantTitleFromSettings({ page, config, soulCache }) {
  const titleEl = page?.querySelector('.ast-title')
  if (!titleEl) return

  let displayName = config.assistantName
  if (config.soulSource?.startsWith('openclaw:') && soulCache?.identity) {
    const nameMatch = soulCache.identity.match(/\*\*Name:\*\*\s*(.+)/i) || soulCache.identity.match(/名[字称][:：]\s*(.+)/i)
    const extracted = nameMatch?.[1]?.trim()
    if (extracted && !extracted.startsWith('_') && !extracted.startsWith('（') && extracted.length < 30) {
      displayName = extracted
    }
  }

  titleEl.textContent = displayName
}
