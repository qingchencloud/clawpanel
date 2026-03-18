# Tool Call Meta Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show tool call time in the tool card header and ensure expanded sections display input/output placeholders when data is empty.

**Architecture:** Update tool rendering in `src/pages/chat.js` to compute display time and placeholders; optional minor CSS tweaks if needed.

**Tech Stack:** Vanilla JS, CSS, Vite build

---

## Chunk 1: Tool header time + placeholders

### Task 1: Add tool time display

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before tool meta"
```

Note: This checkpoint is required by policy; final functional commit occurs after build.

- [ ] **Step 1: Add helper to get tool time**

Add a function near other helpers in `src/pages/chat.js` (below `stripThinkingTags`):

```js
function getToolTime(tool) {
  const raw = tool?.end_time || tool?.endTime || tool?.timestamp || tool?.time || tool?.started_at || tool?.startedAt || null
  if (!raw) return null
  if (typeof raw === 'number' && raw < 1e12) return raw * 1000
  return raw
}
```

Note: `formatTime` and `escapeHtml` already exist in `chat.js`.

- [ ] **Step 1.5: Capture tool event timestamps**

Add a map at top-level in `src/pages/chat.js`:

```js
const _toolEventTimes = new Map()
```

In `handleEvent`, before `handleChatEvent`, capture tool events:

```js
if (event === 'agent' && payload?.stream === 'tool' && payload?.data?.toolCallId) {
  const ts = payload.ts
  if (ts) _toolEventTimes.set(payload.data.toolCallId, ts)
}
```

In `collectToolsFromMessage`, when constructing tool entries, set `time` when absent:

```js
const callId = call.id || call.tool_call_id
const fallbackTime = callId ? _toolEventTimes.get(callId) : null
... time: call.time || fallbackTime ...
```

- [ ] **Step 2: Render header with time**

In `appendToolsToEl`, reuse the existing `summary` node created there and update header:

```js
const time = getToolTime(tool)
const timeText = time ? formatTime(new Date(time)) : '时间未知'
summary.innerHTML = `${escapeHtml(tool.name || '工具')} · ${status} · ${timeText}`
```

- [ ] **Step 3: Add placeholders**

Use the exact block structure already used in tool body:

```js
const input = inputJson
  ? `<div class="msg-tool-block"><div class="msg-tool-title">参数</div><pre>${escapeHtml(inputJson)}</pre></div>`
  : `<div class="msg-tool-block"><div class="msg-tool-title">参数</div><pre>无参数</pre></div>`
const output = outputJson
  ? `<div class="msg-tool-block"><div class="msg-tool-title">结果</div><pre>${escapeHtml(outputJson)}</pre></div>`
  : `<div class="msg-tool-block"><div class="msg-tool-title">结果</div><pre>无结果</pre></div>`
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 5: Commit（PowerShell）**

```powershell
git add src/pages/chat.js
git commit -m "fix: show tool time and placeholders"
```

- [ ] **Step 6: Push（PowerShell）**

```powershell
git push
```
