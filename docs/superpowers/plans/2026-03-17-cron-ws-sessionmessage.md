# Cron WS SessionMessage Replacement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace gateway patch–based cron sessionMessage with a client-side scheduler that sends user messages over the already-connected WSS only after the target session is idle/completed.

**Architecture:** Store scheduled jobs in panel config (local), run a lightweight scheduler in ClawPanel (cron.js) that waits for gatewayReady and session idle state, then dispatch wsClient.chatSend. Track run state and last-run time in panel config to avoid duplicate sends.

**Tech Stack:** Frontend JS (cron.js, ws-client.js), panel config (read/write via tauri-api), WebSocket RPC (sessions.list, sessions.get, chat events).

---

## File Structure

**Modify:**
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\src\pages\cron.js` (UI, local scheduler, local job storage)
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\src\lib\tauri-api.js` (panel config helpers)
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\src\lib\ws-client.js` (optional: expose session idle state helper)
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\src\pages\chat.js` (optional: emit idle status events)
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\src\main.js` (optional: start scheduler on boot)

**Create:**
- `C:\Users\34438\.openclaw\workspace\tools\clawpanel\docs\superpowers\plans\2026-03-17-cron-ws-sessionmessage.md` (this plan)

---

## Task 1: Define local cron job schema and storage

**Files:**
- Modify: `src/pages/cron.js`
- Modify: `src/lib/tauri-api.js`

- [ ] **Step 1: Add local job schema**

Define a new `localCronJobs` array in panel config, each job:
```
{
  id: "uuid",
  name: "string",
  schedule: { kind: "cron", expr: "* * * * *" },
  enabled: true,
  payload: {
    kind: "sessionMessage",
    label: "sessionLabel",
    message: "text",
    waitForIdle: true
  },
  state: { lastRunAtMs: 0, lastStatus: "ok|error|skipped", lastError: "" }
}
```

- [ ] **Step 2: Add API helpers for panel config**

In `tauri-api.js`, add helpers:
```
readPanelConfig()
writePanelConfig()
```
Ensure cron.js can read/write panel config locally without gateway.

- [ ] **Step 3: Implement load/save local jobs**

In cron.js:
- On render, load panel config and initialize local jobs list if missing.
- Use `localJobs` as a separate tab/section from gateway jobs.

---

## Task 2: Update Cron UI for sessionMessage-only mode

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: Replace task type selector**

Remove gateway cron payload kind selector. Only show “发送 user 消息（WSS）”.

- [ ] **Step 2: Show required fields**

Show inputs:
- name
- schedule (cron)
- sessionLabel (from sessions.list)
- message (textarea)
- enabled toggle
- waitForIdle toggle

- [ ] **Step 3: Save local job**

On save, write to panel config localCronJobs, update lastRun fields to defaults.

- [ ] **Step 4: Remove gateway cron create/update**

Delete calls to `wsClient.request('cron.add'|'cron.update')` for local jobs.

---

## Task 3: Implement WSS local scheduler

**Files:**
- Modify: `src/pages/cron.js`
- Modify: `src/main.js` (optional startup hook)

- [ ] **Step 1: Add scheduler loop**

Create an interval (e.g., 10s) to:
- Check wsClient.gatewayReady
- For each enabled local job, check next due time from cron expression
- If due and not run in current window, attempt send

- [ ] **Step 2: Determine session idle state**

Define idle as:
- No active runs for target session
- Or no “streaming” event in last N seconds

Approach:
- Use `sessions.list` or `sessions.get` via wsClient to read run state if available
- If not available, fallback to client-side tracking of last chat event timestamps for that session

- [ ] **Step 3: Send message only when idle**

Use:
```
wsClient.chatSend(sessionKey, message)
```
Only when idle.

- [ ] **Step 4: Update job state**

On send success:
- state.lastRunAtMs = Date.now()
- state.lastStatus = "ok"
On failure:
- state.lastStatus = "error"
- state.lastError = message

Persist to panel config after each run.

---

## Task 4: Session resolution by label

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: Build label→sessionKey map**

Use sessions.list to map label (parseSessionLabel) back to sessionKey.

- [ ] **Step 2: Validate session exists**

If session missing, mark lastStatus=error and lastError="session not found".

---

## Task 5: Visual status and monitoring

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: Show local cron jobs in UI**

Include status badges:
- last run time
- last status
- error message if any

- [ ] **Step 2: Add manual run button**

Trigger immediate send via scheduler path (same idle check).

---

## Task 6: Verification

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: Build**

Run:
```
npm run build
```
Expected: Success.

- [ ] **Step 2: Manual test**

1) Create a local cron job to send to main session.
2) Start a long-running agent task.
3) Verify scheduler waits until idle, then sends message.

---

## Notes
- This plan intentionally bypasses gateway cron schema and patching.
- Jobs are stored locally in panel config, so they only run while ClawPanel is open.
- If headless scheduling is required later, a separate gateway-side implementation will be needed.
