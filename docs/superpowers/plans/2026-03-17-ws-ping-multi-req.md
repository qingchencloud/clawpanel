# WS Ping Multi-Req Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send node.list, models.list, sessions.list, and chat.history every ping interval.

**Architecture:** Update `_startPing` in `src/lib/ws-client.js` to emit four req frames each interval.

**Tech Stack:** JS, Vite build

---

## Chunk 1: Ping multi-req

### Task 1: Update ping sender

**Files:**
- Modify: `src/lib/ws-client.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before ping multi req"
```

Note: This checkpoint is mandatory by policy before modifications.

- [ ] **Step 1: Replace ping payload with 4 req frames**

In `_startPing` interval:

```js
const frames = [
  { type: 'req', id: uuid(), method: 'node.list', params: {} },
  { type: 'req', id: uuid(), method: 'models.list', params: {} },
  { type: 'req', id: uuid(), method: 'sessions.list', params: { includeGlobal: true, includeUnknown: true } },
  { type: 'req', id: uuid(), method: 'chat.history', params: { sessionKey: 'agent:full-stack-architect:main', limit: 200 } },
]
frames.forEach(frame => this._ws.send(JSON.stringify(frame)))
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit（PowerShell）**

```powershell
git add src/lib/ws-client.js
git commit -m "fix: ping sends multi req"
```

- [ ] **Step 4: Push（PowerShell）**

```powershell
git push
```
