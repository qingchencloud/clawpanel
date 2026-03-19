import {
  HISTORY_OMITTED_IMAGES_NOTICE,
  hasRenderableHistoryMessage,
  toUserHistoryAttachments,
} from './history-view-model.js'

export function renderHistoryMessage(msg, sessionKey, handlers) {
  const msgTime = msg.timestamp ? new Date(msg.timestamp) : new Date()
  if (msg.role === 'user') {
    const attachments = toUserHistoryAttachments(msg)
    return {
      node: handlers.appendUserMessage(msg.text, attachments, msgTime),
      omittedImages: !!(msg.images?.length && !attachments.length),
    }
  }
  if (msg.role === 'assistant') {
    return {
      node: handlers.appendAiMessage(msg.text, msgTime, msg.images, msg.videos, msg.audios, msg.files, msg.tools, sessionKey),
      omittedImages: false,
    }
  }
  return {
    node: handlers.appendSystemMessage(msg.text || '', msgTime?.getTime?.() || Date.now()),
    omittedImages: false,
  }
}

export function renderHistoryList(messages = [], sessionKey, handlers) {
  let appended = 0
  let hasOmittedImages = false

  messages.forEach(msg => {
    if (!hasRenderableHistoryMessage(msg)) return
    const rendered = renderHistoryMessage(msg, sessionKey, handlers)
    if (!rendered?.node) return
    handlers.stampHistoryNode(rendered.node, msg)
    if (rendered.omittedImages) hasOmittedImages = true
    appended += 1
  })

  return { appended, hasOmittedImages }
}

export function appendOmittedImagesNotice(handlers) {
  const notice = handlers.appendSystemMessage(HISTORY_OMITTED_IMAGES_NOTICE)
  if (notice) notice.dataset.historyKey = 'system:omitted-images'
  return notice
}

export function renderIncrementalHistoryList(messages = [], sessionKey, handlers) {
  let appended = 0
  let hasOmittedImages = false

  messages.forEach(msg => {
    const entryKey = handlers.buildHistoryEntryKey(msg)
    if (handlers.renderedKeys.has(entryKey)) return
    const rendered = renderHistoryMessage(msg, sessionKey, handlers)
    if (!rendered?.node) return
    handlers.stampHistoryNode(rendered.node, msg)
    handlers.renderedKeys.add(entryKey)
    if (rendered.omittedImages) hasOmittedImages = true
    appended += 1
  })

  return { appended, hasOmittedImages }
}
