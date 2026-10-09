/** 草稿按实例和会话隔离；提交中的文本不是可再次发送的草稿。 */
export function createPiDraftStore(storage) {
  const memory = new Map()
  let sequence = 0
  const key = (root, id = '') => 'clawpanel-pi-draft:' + JSON.stringify([root, id])
  const read = name => {
    if (memory.has(name)) return memory.get(name)
    try { return JSON.parse(storage?.getItem(name) || 'null') || memory.get(name) || {} } catch { return memory.get(name) || {} }
  }
  const write = (name, value) => {
    memory.set(name, value)
    try { storage?.setItem(name, JSON.stringify(value)) } catch { /* 配额不足时保留当前页面内存草稿。 */ }
  }
  return {
    get: (root, id) => read(key(root, id)).text || '',
    set(root, id, text) { const name = key(root, id); write(name, { ...read(name), text, revision: Date.now() + ':' + ++sequence }) },
    begin(root, id, text) {
      const name = key(root, id), token = Date.now() + ':' + ++sequence
      write(name, { text: '', revision: token, pending: { token, text } })
      return { name, token }
    },
    settle(submission, accepted) {
      const value = read(submission.name)
      if (value.pending?.token !== submission.token) return
      const text = !accepted && value.revision === submission.token ? value.pending.text : value.text || ''
      write(submission.name, { text, revision: value.revision })
    },
    last(root, id) {
      const name = 'clawpanel-pi-last:' + root
      if (id !== undefined) write(name, { id })
      return read(name).id || ''
    },
  }
}

/** 短暂网络错误最多恢复六次；不存在的会话需要显式重新打开，绝不重放 prompt。 */
export const piRetryDelay = attempt => Math.min(30000, 1000 * 2 ** attempt)
export function canRetryPiEvents(error, attempt) {
  return attempt < 6 && !/会话未启动|会话不存在|会话 ID 无效|交互请求已失效/.test(String(error?.message || error))
}
