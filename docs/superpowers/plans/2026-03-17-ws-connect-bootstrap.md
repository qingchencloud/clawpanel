# WS Connect Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On each websocket connect success, send the official 8-request bootstrap batch; set ping interval to 5s (bootstrap may duplicate the first ping batch).

**Architecture:** Add `_sendBootstrapRequests()` to `WsClient`, call it from `_handleConnectSuccess`, update `PING_INTERVAL` constant to 5000.

**Tech Stack:** JS, Vite build

---

## Chunk 1: Bootstrap batch + ping interval

### Task 1: Implement bootstrap batch

**Files:**
- Modify: `src/lib/ws-client.js`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before ws bootstrap"
```

Note: This checkpoint is mandatory by policy before modifications.

- [ ] **Step 1: Add helper to send bootstrap batch**

Add method inside `WsClient`:

```js
_sendBootstrapRequests() {
  if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
  const sessionKey = this._sessionKey || 'agent:full-stack-architect:main'
  // Note: responses are fire-and-forget in this batch
  const frames = [
    { type: 'req', id: uuid(), method: 'agent.identity.get', params: { sessionKey } },
    { type: 'req', id: uuid(), method: 'agents.list', params: {} },
    { type: 'req', id: uuid(), method: 'health', params: {} },
    { type: 'req', id: uuid(), method: 'node.list', params: {} },
    { type: 'req', id: uuid(), method: 'device.pair.list', params: {} },
    { type: 'req', id: uuid(), method: 'chat.history', params: { sessionKey, limit: 200 } },
    { type: 'req', id: uuid(), method: 'sessions.list', params: { includeGlobal: true, includeUnknown: true } },
    { type: 'req', id: uuid(), method: 'models.list', params: {} },
  ]
  frames.forEach(frame => this._ws.send(JSON.stringify(frame)))
}
```

- [ ] **Step 2: Call bootstrap on connect success**

In `_handleConnectSuccess` add:

```js
this._sendBootstrapRequests()
```

- [ ] **Step 3: Set ping interval to 5s**

Change constant:

```js
const PING_INTERVAL = 5000
```

Note: With 5s interval and multi-req pings, load increases. This matches the requested behavior.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 5: Commit（PowerShell）**

```powershell
git add src/lib/ws-client.js
git commit -m "fix: ws bootstrap batch"
```

- [ ] **Step 6: Push（PowerShell）**

```powershell
git push
```
