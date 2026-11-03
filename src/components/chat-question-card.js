import { t } from '../lib/i18n.js'

function element(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

// 保持同一请求的 DOM，状态刷新不清空草稿，也不抢走输入焦点。
export function createQuestionPanel(host, store) {
  const cards = new Map()
  const notice = element('div', 'chat-question-notice')
  notice.setAttribute('role', 'status')
  const retry = element('button', 'btn btn-sm btn-secondary', t('chat.questionRefresh'))
  retry.type = 'button'
  retry.onclick = () => store.refresh()
  host.append(notice, retry)

  function createCard(record) {
    const card = element('section', 'chat-question-card')
    const status = element('div', 'chat-question-status')
    status.setAttribute('role', 'status')
    const form = element('form', 'chat-question-form')
    const error = element('div', 'chat-question-error')
    error.setAttribute('role', 'alert')
    const pages = [], readers = []
    let index = 0
    const secret = record.questions.some(q => q.isSecret || q.secretStore)
    const title = element('strong', '', t('chat.questionTitle'))
    card.append(title, status, form, error)
    if (secret) form.append(element('p', '', t('chat.questionSecretHint')))
    else for (const q of record.questions) {
      const field = element('fieldset', 'chat-question-fields')
      field.append(element('legend', '', q.question))
      const options = []
      for (const [i, option] of q.options.entries()) {
        const label = element('label', 'chat-question-option')
        const input = element('input')
        input.type = q.multiSelect ? 'checkbox' : 'radio'
        input.name = q.questionId
        input.value = String(i)
        const detail = element('span')
        detail.append(element('strong', '', option.label))
        if (option.description) detail.append(element('small', '', option.description))
        label.append(input, detail)
        field.append(label)
        options.push({ input, value: option.label })
      }
      let other, text
      if (!q.options.length || q.isOther) {
        const label = element('label', 'chat-question-option')
        if (q.options.length) {
          other = element('input')
          other.type = q.multiSelect ? 'checkbox' : 'radio'
          other.name = q.questionId
          other.value = 'other'
          other.setAttribute('aria-label', t('chat.questionOther'))
          label.append(other)
        }
        text = element('textarea', 'form-input')
        text.rows = 2
        text.placeholder = t('chat.questionOther')
        text.setAttribute('aria-label', t('chat.questionOther'))
        text.oninput = () => { if (other) other.checked = true }
        label.append(text)
        field.append(label)
      }
      readers.push(() => {
        const values = options.filter(o => o.input.checked).map(o => o.value)
        if (text && (!other || other.checked) && text.value.trim()) values.push(text.value.trim())
        return values
      })
      pages.push(field)
      form.append(field)
    }
    const actions = element('div', 'chat-question-actions')
    const cancel = element('button', 'btn btn-sm btn-ghost', t('chat.questionCancel'))
    cancel.type = 'button'
    cancel.onclick = () => store.resolve(record.id, {}, true)
    const previous = element('button', 'btn btn-sm btn-secondary', t('chat.questionPrevious'))
    previous.type = 'button'
    previous.onclick = () => { index = Math.max(0, index - 1); updatePages(); pages[index]?.querySelector('input,textarea')?.focus() }
    const next = element('button', 'btn btn-sm btn-primary')
    next.type = 'submit'
    actions.append(cancel, previous, next)
    form.append(actions)
    function updatePages() {
      pages.forEach((field, i) => { field.hidden = i !== index })
      previous.hidden = index === 0 || secret
      next.hidden = secret
      next.textContent = t(index === pages.length - 1 ? 'chat.questionSubmit' : 'chat.questionNext')
      status.textContent = `${t('chat.questionWaiting')} · ${index + 1}/${record.questions.length}`
    }
    form.onsubmit = async e => {
      e.preventDefault()
      if (secret || !store.connected || !store.ready || store.busy.has(record.id)) return
      if (!readers[index]().length) { error.textContent = t('chat.questionRequired'); return }
      error.textContent = ''
      if (index < pages.length - 1) {
        index++
        updatePages()
        pages[index]?.querySelector('input,textarea')?.focus()
        return
      }
      const values = Object.fromEntries(record.questions.map((q, i) => [q.questionId, readers[i]()]))
      await store.resolve(record.id, values)
    }
    updatePages()
    return {
      card,
      update(current) {
        const pending = current.status === 'pending'
        if (!pending) {
          // 终态销毁输入内容，避免敏感文本在已完成的卡片上继续保留。
          form.replaceChildren()
          form.hidden = true
          error.textContent = ''
          status.textContent = t(`chat.questionStatus_${current.status}`)
          return
        }
        const disabled = !store.connected || !store.ready || store.busy.has(current.id)
        for (const input of form.querySelectorAll('input,textarea,button')) input.disabled = disabled
        error.textContent = store.errors.has(current.id) ? t(`chat.${store.errors.get(current.id)}`) : ''
        if (store.busy.has(current.id)) status.textContent = t('chat.questionSubmitting')
        else updatePages()
      },
    }
  }

  return {
    render(sessionKey) {
      const records = store.forSession(sessionKey)
      const ids = new Set(records.map(r => r.id))
      for (const [id, view] of cards) if (!ids.has(id)) { view.card.remove(); cards.delete(id) }
      for (const record of records) {
        if (!cards.has(record.id)) { const view = createCard(record); cards.set(record.id, view); host.append(view.card) }
        cards.get(record.id).update(record)
      }
      const message = store.error || (!store.connected && records.some(r => r.status === 'pending') ? 'questionDisconnected' : '')
      notice.textContent = message ? t(`chat.${message}`) : ''
      notice.hidden = !message
      retry.hidden = !store.error
      retry.disabled = !store.connected
      host.hidden = !records.length && !message
    },
    dispose() { cards.clear(); host.replaceChildren() },
  }
}
