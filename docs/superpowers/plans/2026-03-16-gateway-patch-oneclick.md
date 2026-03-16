# Gateway One-Click Patch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click gateway patch flow in ClawPanel settings to apply/rollback sessionMessage patch for global npm OpenClaw installs.

**Architecture:** Add a Tauri command that locates global npm OpenClaw, backs up dist files, applies patch, records status in clawpanel.json, and exposes status to the UI. Settings UI uses tauri-api bridge to render current patch status and provide apply/redo/rollback actions.

**Tech Stack:** Tauri (Rust), Vite/JS, ClawPanel config (clawpanel.json)

---

## Chunk 1: Backend patch command + config persistence

### Task 1: Add gateway patch command

**Files:**
- Create: `src-tauri/src/commands/gateway_patch.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create gateway_patch.rs skeleton**

```rust
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Serialize, Deserialize)]
pub struct GatewayPatchStatus {
    pub installed_version: Option<String>,
    pub patched: bool,
    pub patched_version: Option<String>,
    pub patched_at: Option<String>,
    pub files: Vec<String>,
    pub last_error: Option<String>,
}

#[command]
pub async fn gateway_patch_status() -> Result<GatewayPatchStatus, String> {
    Ok(GatewayPatchStatus {
        installed_version: None,
        patched: false,
        patched_version: None,
        patched_at: None,
        files: vec![],
        last_error: None,
    })
}

#[command]
pub async fn gateway_patch_apply() -> Result<GatewayPatchStatus, String> {
    gateway_patch_status().await
}

#[command]
pub async fn gateway_patch_rollback() -> Result<GatewayPatchStatus, String> {
    gateway_patch_status().await
}
```

- [ ] **Step 2: Register commands**

Update `src-tauri/src/commands/mod.rs` to export the new functions, and `src-tauri/src/lib.rs` to include them in `invoke_handler`.

- [ ] **Step 3: Locate global npm root**

Implement helper in `gateway_patch.rs`:
- Run `npm root -g`
- Join `openclaw/dist`
- Detect `reply-*.js` and `gateway-cli-*.js` (choose latest by modified time)
- Return errors if not found

- [ ] **Step 4: Apply patch with backup**

Implement:
- Copy `reply-*.js` -> `.bak`
- Copy `gateway-cli-*.js` -> `.bak`
- Apply string-replace patches (same patterns used in manual patch)
- Validate file content contains `sessionMessage` post patch

- [ ] **Step 5: Persist status in clawpanel.json**

Use existing panel config read/write to store:

```json
"gatewayPatch": {
  "version": "sessionMessage-v1",
  "patchedAt": "<ISO>",
  "openclawVersion": "<semver>",
  "files": ["reply-*.js", "gateway-cli-*.js"],
  "lastError": null
}
```

- [ ] **Step 6: Implement rollback**

Restore from `.bak` files and update status.

- [ ] **Step 7: Manual verification**

Run:
```
openclaw gateway status
```
Expect: Gateway runs normally.

- [ ] **Step 8: Commit**

```
git add src-tauri/src/commands/gateway_patch.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs

git commit -m "feat: add gateway patch commands"
```

## Chunk 2: UI + API bridge

### Task 2: Add API bridge

**Files:**
- Modify: `src/lib/tauri-api.js`

- [ ] **Step 1: Add methods**

```js
export const api = {
  // ...
  gatewayPatchStatus: () => invoke('gateway_patch_status'),
  gatewayPatchApply: () => invoke('gateway_patch_apply'),
  gatewayPatchRollback: () => invoke('gateway_patch_rollback')
}
```

- [ ] **Step 2: Commit**

```
git add src/lib/tauri-api.js

git commit -m "feat: add gateway patch api bridge"
```

### Task 3: Settings UI

**Files:**
- Modify: `src/pages/settings.js` (or `src/pages/settings-cloudflared.js` if the setting block lives there)
- Modify: `src/style/settings.css` (if needed)

- [ ] **Step 1: Add Gateway 补丁卡片**
- Add status area: installed version, patched state, patched time
- Buttons: 一键补丁 / 重打补丁 / 回滚

- [ ] **Step 2: Wire buttons**
- Call `api.gatewayPatchApply()` / `api.gatewayPatchRollback()`
- Refresh status via `api.gatewayPatchStatus()`

- [ ] **Step 3: Manual verification**
- Open settings page, ensure card renders
- Apply patch and verify status changes

- [ ] **Step 4: Commit**

```
git add src/pages/settings.js src/style/settings.css

git commit -m "feat: add gateway patch ui"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-03-16-gateway-patch-oneclick.md`. Ready to execute?
