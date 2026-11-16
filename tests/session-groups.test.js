import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import {
  normalizeSessionRows,
  isChildSession,
  resolveOwnerAgent,
  sessionActivityTs,
  sortSessionsByActivity,
  groupSessions,
  extractSessionRows,
  isInvalidParamsError,
  splitSessionKey,
  shortenSessionLabel,
  toTimestamp,
} from '../src/lib/chat-session-groups.js'

const main = (extra = {}) => ({
  key: 'agent:main:main',
  agentId: 'main',
  classification: 'main',
  isMain: true,
  createdVia: 'run',
  createdAt: 1000,
  updatedAt: 5000,
  ...extra,
})

const child = (extra = {}) => ({
  key: 'agent:coder:subagent:6530ded3-6776-43cc-8eb6-f607cad66a88',
  agentId: 'coder',
  classification: 'subagent',
  spawnedBy: 'agent:orchestrator:subagent:ce942dbc',
  parentSessionKey: 'agent:orchestrator:subagent:ce942dbc',
  spawnDepth: 2,
  subagentRole: 'leaf',
  createdVia: 'spawn',
  owner: { actor: { id: 'orchestrator', type: 'agent' } },
  createdAt: 2000,
  ...extra,
})

test('splitSessionKey: 解析 agent 与 channel', () => {
  assert.deepEqual(splitSessionKey('agent:main:main'), { agentId: 'main', channel: 'main' })
  assert.deepEqual(splitSessionKey('agent:coder:subagent:uuid'), { agentId: 'coder', channel: 'subagent:uuid' })
  assert.deepEqual(splitSessionKey('broken'), { agentId: '', channel: 'broken' })
})

test('toTimestamp: 归一化秒/毫秒/字符串', () => {
  assert.equal(toTimestamp(1700000000000), 1700000000000)
  assert.equal(toTimestamp(1700000000), 1700000000000)
  assert.equal(toTimestamp('1700000000000'), 1700000000000)
  assert.equal(toTimestamp('2024-01-01T00:00:00.000Z'), Date.parse('2024-01-01T00:00:00.000Z'))
  assert.equal(toTimestamp(null), 0)
  assert.equal(toTimestamp('nonsense'), 0)
})

test('sessionActivityTs: 优先级 lastActivityAt → updatedAt → lastInteractionAt → createdAt', () => {
  assert.equal(sessionActivityTs({ lastActivityAt: 4, updatedAt: 3, lastInteractionAt: 2, createdAt: 1 }), 4)
  assert.equal(sessionActivityTs({ updatedAt: 3, lastInteractionAt: 2, createdAt: 1 }), 3)
  assert.equal(sessionActivityTs({ lastInteractionAt: 2, createdAt: 1 }), 2)
  assert.equal(sessionActivityTs({ createdAt: 1 }), 1)
  assert.equal(sessionActivityTs({}), 0)
  assert.equal(sessionActivityTs(null), 0)
})

test('isChildSession: 任一子会话标记命中即为子会话', () => {
  assert.equal(isChildSession(child()), true)
  assert.equal(isChildSession({ spawnedBy: 'agent:main:main' }), true)
  assert.equal(isChildSession({ parentSessionKey: 'agent:main:main' }), true)
  assert.equal(isChildSession({ spawnDepth: 1 }), true)
  assert.equal(isChildSession({ subagentRole: 'orchestrator' }), true)
  assert.equal(isChildSession({ createdVia: 'spawn' }), true)
  assert.equal(isChildSession(main()), false)
  // classification 不能作为唯一依据
  assert.equal(isChildSession({ classification: 'subagent' }), false)
  assert.equal(isChildSession({ classification: 'direct', spawnedBy: 'agent:main:main' }), true)
  assert.equal(isChildSession(null), false)
})

test('resolveOwnerAgent: owner.actor.id 优先，其次父会话 agent，最后自身', () => {
  assert.equal(resolveOwnerAgent(child()), 'orchestrator')
  assert.equal(resolveOwnerAgent({ createdActor: { id: 'assistant' } }), 'assistant')
  assert.equal(resolveOwnerAgent({ parentSessionKey: 'agent:assistant:main' }), 'assistant')
  assert.equal(resolveOwnerAgent({ key: 'agent:coder:subagent:x' }), 'coder')
  assert.equal(resolveOwnerAgent({}), '')
})

test('normalizeSessionRows: 过滤无 key 的脏数据并补全字段', () => {
  const rows = normalizeSessionRows([
    main(),
    child(),
    { agentId: 'x' },
    null,
    'string-row',
    { key: 'agent:main:second', createdAt: 10 },
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].key, 'agent:main:main')
  assert.equal(rows[0].isChild, false)
  assert.equal(rows[1].isChild, true)
  assert.equal(rows[1].ownerAgent, 'orchestrator')
  assert.equal(rows[1].spawnDepth, 2)
  assert.equal(rows[2].activityTs, 10)
  assert.deepEqual(normalizeSessionRows(null), [])
  assert.deepEqual(normalizeSessionRows('nope'), [])
})

test('sortSessionsByActivity: 新的在上，同时间按 key 稳定排序', () => {
  const rows = normalizeSessionRows([
    { key: 'agent:main:a', updatedAt: 100 },
    { key: 'agent:main:c', updatedAt: 300 },
    { key: 'agent:main:b', updatedAt: 300 },
    { key: 'agent:main:d' },
  ])
  const sorted = sortSessionsByActivity(rows)
  assert.deepEqual(sorted.map(r => r.key), ['agent:main:b', 'agent:main:c', 'agent:main:a', 'agent:main:d'])
  assert.deepEqual(sortSessionsByActivity(null), [])
})

test('groupSessions: 主会话 / 按 owner 聚合子会话 / 归档分组', () => {
  const result = groupSessions([
    main({ updatedAt: 900 }),
    { key: 'agent:assistant:main', agentId: 'assistant', classification: 'main', createdAt: 500 },
    child({ updatedAt: 800 }),
    child({ key: 'agent:coder2:subagent:bbb', owner: { actor: { id: 'orchestrator' } }, updatedAt: 700 }),
    { key: 'agent:orchestrator:main', agentId: 'orchestrator', createdAt: 300 },
    { key: 'agent:coder:old', agentId: 'coder', archived: true, archivedAt: 111, archiveReason: 'age-retention', updatedAt: 950 },
  ])

  assert.equal(result.total, 6)
  assert.equal(result.childCount, 2)
  assert.equal(result.archivedCount, 1)
  assert.equal(result.mains.length, 3)
  assert.deepEqual(result.mains.map(r => r.key), ['agent:main:main', 'agent:assistant:main', 'agent:orchestrator:main'])

  assert.equal(result.ownerGroups.length, 1)
  const group = result.ownerGroups[0]
  assert.equal(group.ownerAgent, 'orchestrator')
  assert.equal(group.id, 'owner:orchestrator')
  assert.equal(group.sessions.length, 2)
  assert.deepEqual(group.sessions.map(r => r.key), [
    'agent:coder:subagent:6530ded3-6776-43cc-8eb6-f607cad66a88',
    'agent:coder2:subagent:bbb',
  ])

  assert.ok(result.archivedGroup)
  assert.equal(result.archivedGroup.id, 'archived')
  assert.equal(result.archivedGroup.sessions.length, 1)
  assert.equal(result.archivedGroup.sessions[0].archiveReason, 'age-retention')
})

test('groupSessions: 空输入与只有主会话', () => {
  const empty = groupSessions([])
  assert.equal(empty.total, 0)
  assert.equal(empty.mains.length, 0)
  assert.equal(empty.ownerGroups.length, 0)
  assert.equal(empty.archivedGroup, null)

  const onlyMain = groupSessions([main()])
  assert.equal(onlyMain.mains.length, 1)
  assert.equal(onlyMain.ownerGroups.length, 0)
})

test('groupSessions: 多个 owner 分组按组内最大活跃时间排序', () => {
  const result = groupSessions([
    child({ key: 'agent:coder:subagent:a', owner: { actor: { id: 'alpha' } }, updatedAt: 100 }),
    child({ key: 'agent:coder:subagent:b', owner: { actor: { id: 'beta' } }, updatedAt: 900 }),
    child({ key: 'agent:coder:subagent:c', owner: { actor: { id: 'beta' } }, updatedAt: 950 }),
  ])
  assert.deepEqual(result.ownerGroups.map(g => g.ownerAgent), ['beta', 'alpha'])
})

test('extractSessionRows: 兼容数组 / { sessions } / { items }', () => {
  assert.deepEqual(extractSessionRows([{ key: 'a' }]), [{ key: 'a' }])
  assert.deepEqual(extractSessionRows({ sessions: [{ key: 'b' }] }), [{ key: 'b' }])
  assert.deepEqual(extractSessionRows({ items: [{ key: 'c' }] }), [{ key: 'c' }])
  assert.deepEqual(extractSessionRows(null), [])
  assert.deepEqual(extractSessionRows({}), [])
})

test('isInvalidParamsError: 识别旧内核对 archived 参数的拒绝', () => {
  assert.equal(isInvalidParamsError({ code: 'INVALID_REQUEST' }), true)
  assert.equal(isInvalidParamsError({ message: "invalid sessions.list params: at root: unexpected property 'archived'" }), true)
  assert.equal(isInvalidParamsError({ code: 'METHOD_NOT_FOUND' }), false)
  assert.equal(isInvalidParamsError(null), false)
})

test('shortenSessionLabel: 超长标签截断', () => {
  assert.equal(shortenSessionLabel('short'), 'short')
  const long = 'coder / subagent:6530ded3-6776-43cc-8eb6-f607cad66a88'
  assert.ok(shortenSessionLabel(long).length <= 28)
  assert.ok(shortenSessionLabel(long).endsWith('…'))
})

// ── 渲染层（vm 沙箱加载真实 chat.js，验证分组 DOM 输出） ──

function chatRenderHarness() {
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  const context = vm.createContext({
    console, localStorage, store, t: key => key,
    // chat.js 的 import 行在沙箱里被剥离，这里显式注入分组模块的纯函数
    groupSessions, extractSessionRows, isInvalidParamsError, shortenSessionLabel,
    isGatewayOfficialAgent: () => false,
    toast: () => {},
    showModal: () => {}, showConfirm: async () => true,
    switchSession: async () => true,
    deleteSession: () => {}, showCompactionHistory: () => {}, renameSession: () => {},
    formatSessionTime: () => 'now',
    setTimeout, clearTimeout, Date,
  })
  const source = readFileSync(new URL('../src/pages/chat.js', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  vm.runInContext(source + `
    _sessionListEl = { innerHTML: '', onclick: null, ondblclick: null };
    _gatewayOfficialRequested = false;
    _sessionKey = 'agent:main:main';
    globalThis.api = {
      render: (rows) => { renderSessionList(rows); return _sessionListEl.innerHTML },
      html: () => _sessionListEl.innerHTML,
      setMode: (m) => { setSessionViewMode(m); renderSessionList(_lastSessionRows) },
      toggleGroup: (id) => toggleGroupCollapsed(id),
      mode: () => getSessionViewMode(),
      collapsed: () => [...getCollapsedGroups()],
      storageKey: k => store.get(k),
    };
  `, context)
  return context.api
}

const liveRows = [
  { key: 'agent:main:main', agentId: 'main', classification: 'main', isMain: true, updatedAt: 1794541922117 },
  { key: 'agent:assistant:main', agentId: 'assistant', classification: 'main', updatedAt: 1794542050000 },
  {
    key: 'agent:coder:subagent:6530ded3-6776-43cc-8eb6-f607cad66a88', agentId: 'coder',
    classification: 'subagent', spawnedBy: 'agent:orchestrator:subagent:x', parentSessionKey: 'agent:orchestrator:subagent:x',
    spawnDepth: 2, subagentRole: 'leaf', createdVia: 'spawn', owner: { actor: { id: 'orchestrator' } },
    updatedAt: 1794543791181, label: 'ClawPanel sessions patch',
  },
  { key: 'agent:coder:old', agentId: 'coder', archived: true, archiveReason: 'age-retention', updatedAt: 1794543000000 },
]

test('渲染：分组视图输出分组头、计数与 owner 徽章', () => {
  const api = chatRenderHarness()
  const html = api.render(liveRows)
  assert.ok(html.includes('chat-session-group-owner'), '应有 owner 分组')
  assert.ok(html.includes('chat-session-group-archived'), '应有归档分组')
  assert.ok(html.includes('data-group-toggle="owner:orchestrator"'), '分组头应可折叠')
  assert.ok(html.includes('data-session-view="groups"'), '应有视图切换按钮')
  assert.ok(html.includes('data-session-view="all"'), '应有全部视图按钮')
  assert.ok(html.includes('chat-session-count-missing') === false, '不应出现占位类名')
  // 主会话卡片 + 子会话卡片都渲染
  // 2 主会话 + 1 子会话 + 1 归档会话 = 4 张卡片
  assert.equal((html.match(/class="chat-session-card[ "]/g) || []).length, 4)
  // 子会话显示 owner 徽章
  assert.ok(html.includes('chat-session-owner'), '子会话应显示 owner 徽章')
  // 归档分组计数
  assert.ok(html.includes('>1</span>'), '归档分组应显示计数')
})

test('渲染：全部视图输出单个列表且按活跃时间倒序', () => {
  const api = chatRenderHarness()
  api.render(liveRows)
  api.setMode('all')
  const html = api.html()
  assert.ok(html.includes('chat-session-group-flat'), '应为扁平列表')
  assert.ok(!html.includes('data-group-toggle'), '扁平列表没有折叠头')
  const order = [...html.matchAll(/data-key="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(order, [
    'agent:coder:subagent:6530ded3-6776-43cc-8eb6-f607cad66a88',
    'agent:coder:old',
    'agent:assistant:main',
    'agent:main:main',
  ])
})

test('渲染：视图模式与折叠状态写入 localStorage 并可恢复', () => {
  const api = chatRenderHarness()
  api.render(liveRows)
  api.setMode('all')
  assert.equal(api.mode(), 'all')
  assert.equal(api.storageKey('clawpanel-chat-session-view'), 'all')
  api.setMode('groups')
  assert.equal(api.mode(), 'groups')
  api.toggleGroup('owner:orchestrator')
  assert.deepEqual([...api.collapsed()], ['owner:orchestrator'])
  assert.ok(api.storageKey('clawpanel-chat-session-collapsed').includes('owner:orchestrator'))
  const html = api.html()
  assert.ok(html.includes('aria-expanded="false"'), '折叠后分组头标记为已折叠')
  api.toggleGroup('owner:orchestrator')
  assert.deepEqual([...api.collapsed()], [])
})
