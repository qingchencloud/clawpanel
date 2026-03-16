# WS Ping Node List Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace websocket ping with a periodic node.list request.

**Architecture:** Modify `_startPing` in `src/lib/ws-client.js` to send a req frame rather than a ping frame.

**Tech Stack:** JS, Vite build

---

## Chunk 1: Replace ping payload

### Task 1: Update ping sender

**Files:**
- Modify: `src/lib/ws-client.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before ping change"
```

Note: This checkpoint is required by policy; final functional commit occurs after build.

- [ ] **Step 1: Replace ping payload**

In `_startPing` interval:

```js
const frame = { type: 'req', id: uuid(), method: 'node.list', params: {} }
this._ws.send(JSON.stringify(frame))
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit（PowerShell）**

```powershell
git add src/lib/ws-client.js
git commit -m "fix: ping uses node.list"
```

- [ ] **Step 4: Push（PowerShell）**

```powershell
git push
```
