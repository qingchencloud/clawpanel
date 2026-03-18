# Gateway Patch Auto-Detect Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect global OpenClaw version changes at app start and settings entry, then reapply the gateway patch silently; show errors only in settings.

**Architecture:** Add a small patch auto-detect runner in settings (client-side) and app bootstrap (Tauri setup) that calls gateway_patch_status and, on version mismatch, triggers gateway_patch_apply(force=true). Use in-memory throttle and 5-minute cooldown to avoid repeated runs.

**Tech Stack:** Tauri (Rust), Vite/JS, ClawPanel config

---

## Chunk 1: Backend status extensions

### Task 1: Extend gateway_patch_status output

**Files:**
- Modify: `src-tauri/src/commands/gateway_patch.rs`

- [ ] **Step 1: Add version mismatch helper**

Add a helper to compute `needs_repatch` by comparing `installed_version` with stored `gatewayPatch.openclawVersion` and include it in status output if desired.

- [ ] **Step 2: Ensure force apply uses backup detection**

If force=true and backups missing, return a clear error string: "缺少备份，建议先一键补丁".

- [ ] **Step 3: Commit**

```
git add src-tauri/src/commands/gateway_patch.rs

git commit -m "feat: add patch auto-detect helpers"
```

## Chunk 2: Frontend auto-detect logic

### Task 2: App startup auto-detect

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add one-time auto-detect**

Create a lightweight timer guard (module-scoped) and call `api.gatewayPatchStatus()` then `api.gatewayPatchApply(true)` when version mismatch is detected. Cooldown 5 minutes.

- [ ] **Step 2: Commit**

```
git add src/main.js

git commit -m "feat: auto-detect gateway patch at startup"
```

### Task 3: Settings page auto-detect

**Files:**
- Modify: `src/pages/settings.js`

- [ ] **Step 1: Add auto-detect on loadAll**

After `loadGatewayPatch`, run auto-detect handler with a shared cooldown guard; update UI based on result. Do not show toast on success; show error in the card only.

- [ ] **Step 2: Commit**

```
git add src/pages/settings.js

git commit -m "feat: auto-detect gateway patch in settings"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-03-16-gateway-patch-auto-detect.md`. Ready to execute?
