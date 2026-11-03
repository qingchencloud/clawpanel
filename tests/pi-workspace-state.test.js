import test from 'node:test'
import assert from 'node:assert/strict'
import { createPiDraftStore, piRetryDelay, canRetryPiEvents } from '../src/engines/pi/lib/workspace-state.js'

const fixture = () => {
  const data = new Map()
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }
}

test('Pi 草稿按实例/会话隔离，离页及刷新从 sessionStorage 恢复', () => {
  const storage = fixture(), drafts = createPiDraftStore(storage)
  drafts.set('root-one', 'A', 'A草稿'); drafts.set('root-one', 'B', 'B草稿')
  drafts.set('root-two', 'A', '另一实例'); drafts.last('root-one', 'B')
  const restored = createPiDraftStore(storage)
  assert.equal(restored.get('root-one', 'A'), 'A草稿')
  assert.equal(restored.get('root-one', 'B'), 'B草稿')
  assert.equal(restored.get('root-two', 'A'), '另一实例')
  assert.equal(restored.get('root-one', 'C'), '')
  assert.equal(restored.last('root-one'), 'B'); assert.equal(restored.last('root-two'), '')
})

test('Pi 提交期间不重复显示发送文本；失败恢复，成功仅清理本次提交', () => {
  const storage = fixture(), drafts = createPiDraftStore(storage)
  drafts.set('root', 'A', '待发送')
  const first = drafts.begin('root', 'A', '待发送')
  assert.equal(createPiDraftStore(storage).get('root', 'A'), '')
  drafts.settle(first, false); assert.equal(drafts.get('root', 'A'), '待发送')
  const second = drafts.begin('root', 'A', '待发送')
  drafts.set('root', 'A', '用户后来输入')
  drafts.settle(second, true); assert.equal(drafts.get('root', 'A'), '用户后来输入')
  const third = drafts.begin('root', 'A', '用户后来输入')
  drafts.set('root', 'A', '新内容'); drafts.settle(third, false)
  assert.equal(drafts.get('root', 'A'), '新内容')
  drafts.settle(first, false); assert.equal(drafts.get('root', 'A'), '新内容')
})

test('Pi 存储不可写时内存草稿不被旧持久记录覆盖', () => {
  const storage = { getItem: () => JSON.stringify({ text: '旧文本' }), setItem: () => { throw new Error('quota') } }
  const drafts = createPiDraftStore(storage)
  drafts.set('root', 'A', '新文本'); assert.equal(drafts.get('root', 'A'), '新文本')
  const submission = drafts.begin('root', 'A', '新文本')
  drafts.settle(submission, false); assert.equal(drafts.get('root', 'A'), '新文本')
})

test('Pi 重连有界退避，失效会话不无限重试，也不包含发送操作', () => {
  assert.deepEqual([0, 1, 2, 5, 6].map(piRetryDelay), [1000, 2000, 4000, 30000, 30000])
  assert.equal(canRetryPiEvents(new Error('fetch failed'), 5), true)
  assert.equal(canRetryPiEvents(new Error('fetch failed'), 6), false)
  assert.equal(canRetryPiEvents(new Error('Pi 会话未启动，请重新打开会话'), 0), false)
})
