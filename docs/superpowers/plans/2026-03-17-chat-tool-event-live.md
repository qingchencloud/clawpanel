# Chat Tool Event Live Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display tool events as live system messages ordered by payload.ts and de-duplicated by payload.runId + toolCallId.

**Architecture:** Extend chat event handling to create tool-event system messages and insert into DOM by timestamp; add dedupe map keyed by ts+toolCallId.

**Tech Stack:** Vanilla JS, CSS, Vite build

---

## Chunk 1: Tool event live insertion

### Task 1: Add dedupe and insert-by-time

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before tool event live"
```

Note: This checkpoint is required by policy; final functional commit occurs after build.

- [ ] **Step 1: Add maps for dedupe and event list**

Add near top-level state:

```js
const _toolEventSeen = new Set()
```

- [ ] **Step 2: Insert helper for ordered messages**

Add a helper to insert a message wrapper by timestamp:

```js
function insertMessageByTime(wrap, ts) {
  const tsValue = Number(ts || Date.now())
  wrap.dataset.ts = String(tsValue)
  const items = Array.from(_messagesEl.querySelectorAll('.msg'))
  for (const node of items) {
    const nodeTs = parseInt(node.dataset.ts || '0', 10)
    if (nodeTs > tsValue) {
      _messagesEl.insertBefore(wrap, node)
      return
    }
  }
  _messagesEl.insertBefore(wrap, _typingEl)
}
```

- [ ] **Step 3: Add tool-event system message builder**

```js
function appendToolEventMessage(name, phase, ts, isError) {
  const wrap = document.createElement('div')
  wrap.className = 'msg msg-system'
  wrap.textContent = `${name} · ${phase}${isError ? ' · 失败' : ''}`
  insertMessageByTime(wrap, ts)
}
```

- [ ] **Step 4: Handle tool events in handleEvent**

```js
if (event === 'agent' && payload?.stream === 'tool' && payload?.data?.toolCallId) {
  const key = `${payload.runId}:${payload.data.toolCallId}`
  if (_toolEventSeen.has(key)) return
  _toolEventSeen.add(key)
  const name = payload.data.name || '工具'
  const phase = payload.data.phase || 'unknown'
  appendToolEventMessage(name, phase, payload.ts, payload.data.isError)
}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 6: Commit（PowerShell）**

```powershell
git add src/pages/chat.js
git commit -m "fix: show live tool events"
```

- [ ] **Step 7: Push（PowerShell）**

```powershell
git push
```
