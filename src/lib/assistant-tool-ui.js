export function buildAssistantAskUserCardHtml({ cardId, question, type, options, placeholder, escapeHtml }) {
  const optionsHtml = (options || []).map((opt) => {
    const inputType = type === 'multiple' ? 'checkbox' : 'radio'
    return `<label class="ast-ask-option">
      <input type="${inputType}" name="${cardId}" value="${escapeHtml(opt)}">
      <span>${escapeHtml(opt)}</span>
    </label>`
  }).join('')

  const textHtml = type === 'text' || !options?.length
    ? `<textarea class="ast-ask-text" placeholder="${escapeHtml(placeholder || '请输入...')}" rows="2"></textarea>`
    : ''

  const customHtml = type !== 'text' && options?.length
    ? `<div class="ast-ask-custom"><input type="text" class="ast-ask-custom-input" placeholder="或输入自定义内容..."></div>`
    : ''

  return `
    <div class="ast-ask-question">${escapeHtml(question)}</div>
    ${optionsHtml ? `<div class="ast-ask-options">${optionsHtml}</div>` : ''}
    ${customHtml}
    ${textHtml}
    <div class="ast-ask-actions">
      <button class="ast-ask-submit btn btn-primary btn-sm">确认</button>
      <button class="ast-ask-skip btn btn-secondary btn-sm">跳过</button>
    </div>
  `
}

export function resolveAssistantAskUserAnswer(card, type, options) {
  if (type === 'text' || (!options?.length)) {
    return card.querySelector('.ast-ask-text')?.value?.trim() || ''
  }
  if (type === 'multiple') {
    const checked = [...card.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value)
    const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
    if (custom) checked.push(custom)
    return checked.join('、') || '未选择'
  }
  const checked = card.querySelector('input[type="radio"]:checked')
  const custom = card.querySelector('.ast-ask-custom-input')?.value?.trim()
  return custom || checked?.value || '未选择'
}

export function buildAssistantAnsweredCardHtml({ question, answer, skip = false, escapeHtml, iconHtml = '' }) {
  if (skip) {
    return `<div class="ast-ask-answered">
      <div class="ast-ask-question">${escapeHtml(question)}</div>
      <div class="ast-ask-answer" style="color:var(--text-tertiary)">— 已跳过</div>
    </div>`
  }
  return `<div class="ast-ask-answered">
    <div class="ast-ask-question">${escapeHtml(question)}</div>
    <div class="ast-ask-answer">${iconHtml} ${escapeHtml(answer)}</div>
  </div>`
}

export function renderAssistantToolBlocks(toolHistory, helpers) {
  if (!toolHistory || toolHistory.length === 0) return ''
  return toolHistory.map(tc => {
    if (tc.name === 'ask_user') return ''
    const tcIcon = helpers.toolIcons[tc.name] || helpers.defaultToolIcon
    const label = helpers.toolLabels[tc.name] || tc.name
    const argsStr = helpers.getArgsPreview(tc)

    if (tc.pending) {
      return `<div class="ast-tool-block pending">
        <div class="ast-tool-summary">${tcIcon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status"><span class="ast-typing">执行中...</span></span></div>
      </div>`
    }

    const statusClass = tc.approved === false ? 'denied' : 'ok'
    const statusLabel = tc.approved === false ? '已拒绝' : '已执行'
    const resultPreview = (tc.result || '').length > 500 ? tc.result.slice(0, 500) + '...' : (tc.result || '')
    return `<details class="ast-tool-block ${statusClass}">
      <summary class="ast-tool-summary">${tcIcon} <strong>${label}</strong> <code>${argsStr}</code> <span class="ast-tool-status">${statusLabel}</span></summary>
      <pre class="ast-tool-result">${helpers.escapeHtml(resultPreview)}</pre>
    </details>`
  }).join('')
}
