# Chat History Tool Merge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix chat history parsing so tool cards merge by toolCallId, show above text, and sort by time with correct fallback.

**Architecture:** Merge tool blocks via upsertTool, resolve tool time from event ts or message timestamp, and suppress tool system messages during history parsing. Render tools and text as entries sorted by time (tools first when time ties).

**Tech Stack:** React, JS

---

## Chunk 1: Parsing + ordering adjustments

### Task 1: Add time resolver + merge tool entries

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before history tool merge"
```

- [ ] **Step 1: Add tool time resolver**

Add helper near tool utilities:

```js
function resolveToolTime(toolId, messageTimestamp) {
  const eventTs = toolId ? _toolEventTimes.get(toolId) : null
  return eventTs || messageTimestamp || null
}
```

- [ ] **Step 2: Use upsertTool in history parsing**

In `extractChatContent` and `extractContent`, replace `tools.push` with `upsertTool` for toolCall/toolResult blocks so toolCallId merges.

- [ ] **Step 3: Apply time fallback to tools**

When building tool entries, set `time: resolveToolTime(id, message.timestamp)`.

- [ ] **Step 4: Suppress tool system messages in history**

When processing history responses, skip `appendSystemMessage` for tool events, only render tool cards.

- [ ] **Step 5: Sort entries by time with tool-first tie**

In rendering pipeline, build `entries` combining tools and text, then sort:

```js
entries.sort((a, b) => {
  const ta = a.time ?? 0
  const tb = b.time ?? 0
  if (ta !== tb) return ta - tb
  if (a.kind === 'tool' && b.kind !== 'tool') return -1
  if (a.kind !== 'tool' && b.kind === 'tool') return 1
  return 0
})
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 7: Commit**

```powershell
git add src\pages\chat.js
git commit -m "fix: history tool merge and ordering"
```

- [ ] **Step 8: Push**

```powershell
git push
```
