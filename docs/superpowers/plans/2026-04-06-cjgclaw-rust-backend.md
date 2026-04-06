# CJGClaw Rust Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Rust backend for sandbox isolation — change `~/.openclaw/` → `~/.cjgclaw/`, bundle OpenClaw CLI via absolute path, add sandbox commands, split the massive config.rs (4580 lines) into focused modules, and add new types.

**Architecture:** `src-tauri/src/` directory restructured. New `sandbox.rs` handles `~/.cjgclaw/` init and bundled OpenClaw path resolution. `openclaw.rs` wraps CLI invocation. `gateway.rs` manages Gateway process. `config.rs` split into smaller concerns. Port changed from 18789 → 28790. All CLI calls use absolute bundled path via `sandbox::openclaw_path()`.

**Tech Stack:** Rust (existing Tauri v2), ed25519-dalek, sha2, base64, dirs, tokio, reqwest, serde

---

## File Structure

```
src-tauri/src/
├── main.rs                      # Unchanged
├── lib.rs                       # Register new commands, remove dropped modules
├── tray.rs                      # Unchanged (CJGClaw menu labels)
│
├── commands/
│   ├── mod.rs                   # cjgclaw_dir(), sandbox_dir(), openclaw_path(), gateway_port(28790)
│   ├── sandbox.rs               # NEW: sandbox_init, sandbox_status, openclaw_path
│   ├── openclaw.rs              # NEW: CLI invocation wrappers with bundled path
│   ├── gateway.rs               # NEW: gateway_start/stop/restart/status/reload (split from config.rs)
│   ├── config.rs                # KEEP: config read/write (strip gateway/CLI commands)
│   ├── agent.rs                 # KEEP: adapt to cjgclaw_dir
│   ├── skills.rs                # KEEP: adapt to cjgclaw_dir
│   ├── extensions.rs            # KEEP: adapt to cjgclaw_dir
│   ├── logs.rs                  # KEEP: adapt to cjgclaw_dir
│   ├── pairing.rs               # KEEP: adapt to cjgclaw_dir
│   ├── device.rs                # KEEP: adapt to cjgclaw_dir
│   ├── update.rs                # KEEP: adapt to cjgclaw_dir
│   ├── messaging.rs             # DROP (v2)
│   ├── memory.rs                # DROP (v2)
│   ├── assistant.rs             # DROP (v2)
│   ├── service.rs               # DROP (merged into gateway.rs + guardian.rs)
│   └── config_guardian.rs       # DROP (merged into gateway.rs)
│
├── sandbox/
│   ├── mod.rs                   # sandbox_dir(), cjgclaw_dir(), bundled_openclaw_path()
│   ├── init.rs                  # sandbox_init logic (dir creation, key gen)
│   ├── openclaw.rs              # openclaw_command wrappers
│   └── gateway.rs               # gateway process management
│
└── models/
    ├── mod.rs
    ├── types.rs                 # ServiceStatus, VersionInfo + new types
    ├── sandbox.rs               # NEW: SandboxStatus, SandboxInitResult
    └── gateway.rs               # NEW: GatewayStatus
```

Note: Tasks 1-5 restructure the directory. Tasks 6-10 add new sandbox commands. Tasks 11+ adapt existing commands.

---

### Task 1: Create Sandbox Module with Path Utilities

**Files:**
- Create: `src-tauri/src/sandbox/mod.rs`
- Create: `src-tauri/src/sandbox/init.rs`
- Create: `src-tauri/src/sandbox/openclaw.rs`
- Create: `src-tauri/src/sandbox/gateway.rs`

- [ ] **Step 1: Create src-tauri/src/sandbox/mod.rs**

```rust
//! Sandbox isolation module for CJGClaw.
//! All paths resolve to ~/.cjgclaw/ instead of ~/.openclaw/
//! All OpenClaw CLI calls use the bundled absolute path.

use std::path::PathBuf;

/// Returns the CJGClaw data directory (~/.cjgclaw)
pub fn cjgclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cjgclaw")
}

/// Returns the bundled OpenClaw CLI path from the app bundle.
/// On macOS: /Applications/CJGClaw.app/Contents/Resources/openclaw/...
/// On Windows: C:/Program Files/CJGClaw/resources/openclaw/...
/// On Linux: /opt/cjgclaw/resources/openclaw/...
pub fn bundled_openclaw_dir() -> PathBuf {
    // Tauri provides the resource path via an environment variable
    std::env::var("RESOURCE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // Fallback: derive from executable path
            if let Ok(exe) = std::env::current_exe() {
                exe.parent()
                    .map(|p| p.join("openclaw"))
                    .unwrap_or_else(|| PathBuf::from("/opt/cjgclaw/openclaw"))
            } else {
                PathBuf::from("/opt/cjgclaw/openclaw")
            }
        })
}

/// Returns the absolute path to the OpenClaw CLI entry point.
/// Resolves to: bundled_openclaw_dir()/node_modules/openclaw/openclaw.mjs
pub fn openclaw_cli_path() -> PathBuf {
    bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs")
}

/// Returns the Gateway listen port (default 28790, read from cjgclaw.json)
pub fn gateway_port() -> u16 {
    // Read from ~/.cjgclaw/cjgclaw.json gateway.port field, cached 5s
    static CACHE: std::sync::LazyLock<std::sync::Mutex<(std::time::Instant, u16)>> =
        std::sync::LazyLock::new(|| {
            std::sync::Mutex::new((std::time::Instant::now(), 28790))
        });

    let mut guard = CACHE.lock().unwrap();
    let elapsed = guard.0.elapsed().as_secs();
    if elapsed < 5 {
        return guard.1;
    }
    drop(guard);

    let port = read_cjgclaw_json_port().unwrap_or(28790);
    *CACHE.lock().unwrap() = (std::time::Instant::now(), port);
    port
}

fn read_cjgclaw_json_port() -> Option<u16> {
    let path = cjgclaw_dir().join("cjgclaw.json");
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("gateway")?.get("port")?.as_u64().map(|p| p as u16)
}

/// Returns the OpenClaw config directory (for config file compatibility).
/// In CJGClaw this is ~/.cjgclaw/openclaw/ (symlink or copy of bundled defaults).
pub fn openclaw_config_dir() -> PathBuf {
    cjgclaw_dir().join("openclaw")
}

pub mod init;
pub mod openclaw;
pub mod gateway;
```

- [ ] **Step 2: Create src-tauri/src/sandbox/init.rs**

```rust
//! Sandbox initialization: creates ~/.cjgclaw/ directory structure,
//! generates device identity key, writes cjgclaw.json, writes .installed version.

use super::{cjgclaw_dir, openclaw_config_dir};
use crate::models::sandbox::{SandboxInitResult, SandboxStatus};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Initialize the CJGClaw sandbox. Safe to call multiple times (idempotent).
/// Creates ~/.cjgclaw/ with subdirectories, generates Ed25519 device key,
/// creates default cjgclaw.json, and writes .installed version file.
#[tauri::command]
pub fn sandbox_init() -> Result<SandboxInitResult, String> {
    let base = cjgclaw_dir();

    // Create directory structure
    let dirs = [
        "",
        "agents",
        "memory",
        "identity",
        "backups",
        "logs",
        "cron",
        "openclaw",
        "openclaw/extensions",
        "openclaw/skills",
    ];
    for d in dirs {
        let path = base.join(d);
        if !path.exists() {
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("创建目录失败 {}: {}", path.display(), e))?;
        }
    }

    // Generate device identity key if not exists
    generate_device_identity(&base.join("identity/device.json"))?;

    // Create cjgclaw.json if not exists
    let config_path = base.join("cjgclaw.json");
    if !config_path.exists() {
        let config = serde_json::json!({
            "version": CURRENT_VERSION,
            "gateway": {
                "port": 28790
            },
            "bundled_openclaw": {
                "version": "bundled"
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
            .map_err(|e| format!("写入配置失败: {}", e))?;
    }

    // Write .installed version marker
    std::fs::write(base.join(".installed"), CURRENT_VERSION)
        .map_err(|e| format!("写入版本标记失败: {}", e))?;

    Ok(SandboxInitResult {
        initialized: true,
        version: CURRENT_VERSION.to_string(),
    })
}

/// Get the current sandbox status.
#[tauri::command]
pub fn sandbox_status() -> Result<SandboxStatus, String> {
    let base = cjgclaw_dir();
    let installed = base.join(".installed").exists();

    let version = if installed {
        std::fs::read_to_string(base.join(".installed"))
            .ok()
            .map(|s| s.trim().to_string())
    } else {
        None
    };

    Ok(SandboxStatus {
        installed,
        version: version.unwrap_or_else(|| "unknown".to_string()),
        dir: base.to_string_lossy().to_string(),
    })
}

fn generate_device_identity(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        return Ok(()); // Already exists
    }

    use ed25519_dalek::{SigningKey, rand::rngs::OsRng};

    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = signing_key.verifying_key();

    let key_json = serde_json::json!({
        "secret": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signing_key.as_bytes()),
        "public": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public_key.as_bytes()),
    });

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建身份目录失败: {}", e))?;
    }

    std::fs::write(path, serde_json::to_string_pretty(&key_json).unwrap())
        .map_err(|e| format!("写入身份密钥失败: {}", e))?;

    Ok(())
}
```

- [ ] **Step 3: Create src-tauri/src/sandbox/openclaw.rs**

```rust
//! OpenClaw CLI invocation wrappers using bundled absolute path.

use super::{cjgclaw_dir, openclaw_cli_path};
use std::process::Command;
use std::path::PathBuf;

/// Build an OpenClaw CLI command using the bundled absolute path.
/// Injects CJGCLAW_DIR environment variable pointing to ~/.cjgclaw/.
pub fn openclaw_command() -> Command {
    let mut cmd = Command::new("node");
    cmd.arg(openclaw_cli_path());
    cmd.env("CJGCLAW_DIR", cjgclaw_dir());
    cmd
}

/// Build an async OpenClaw CLI command using tokio.
pub fn openclaw_command_async() -> tokio::process::Command {
    use tokio::process::Command as AsyncCommand;
    let mut cmd = AsyncCommand::new("node");
    cmd.arg(openclaw_cli_path());
    cmd.env("CJGCLAW_DIR", cjgclaw_dir());
    cmd
}

/// Returns the absolute path string for the bundled OpenClaw CLI.
/// Used by IPC layer to expose to frontend.
#[tauri::command]
pub fn openclaw_path() -> Result<String, String> {
    let path = openclaw_cli_path();
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("OpenClaw CLI not found at {}", path.display()))
    }
}
```

- [ ] **Step 4: Create src-tauri/src/sandbox/gateway.rs**

```rust
//! Gateway process management using sandbox paths.
//! Port: 28790 (CJGClaw-specific, avoids conflicts with system OpenClaw 18789).

use super::{cjgclaw_dir, openclaw_cli_path};
use std::process::Command;

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "ai.cjgclaw.gateway";

#[cfg(target_os = "windows")]
const SERVICE_NAME: &str = "CJGClawGateway";

#[cfg(target_os = "linux")]
const SYSTEMD_USER_UNIT: &str = "cjgclaw-gateway.service";

#[derive(Debug, serde::Serialize)]
pub struct GatewayStatusResult {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

/// Check if Gateway is running by probing the port.
fn is_gateway_running(port: u16) -> bool {
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{}", port);
    TcpStream::lookup_addr(addr.as_str()).is_ok()
}

#[tauri::command]
pub fn gateway_status() -> Result<GatewayStatusResult, String> {
    let port = 28790;
    let running = is_gateway_running(port);

    let pid = if running {
        find_gateway_pid(port)
    } else {
        None
    };

    Ok(GatewayStatusResult {
        running,
        port,
        pid,
        started_at: None,
    })
}

#[tauri::command]
pub fn gateway_start() -> Result<(), String> {
    let mut cmd = Command::new("node");
    cmd.arg(openclaw_cli_path());
    cmd.arg("gateway");
    cmd.env("CJGCLAW_DIR", cjgclaw_dir());
    cmd.env("PORT", "28790");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(target_os = "macos")]
    {
        // Create LaunchAgent plist and load it
        let plist = macos_launchagent_plist();
        let plist_dir = dirs::home_dir().unwrap().join("Library/LaunchAgents");
        std::fs::create_dir_all(&plist_dir).map_err(|e| e.to_string())?;
        std::fs::write(plist_dir.join("ai.cjgclaw.gateway.plist"), plist)
            .map_err(|e| e.to_string())?;
        let output = std::process::Command::new("launchctl")
            .arg("load")
            .arg(plist_dir.join("ai.cjgclaw.gateway.plist"))
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // For linux, start as foreground process managed by systemd user
        // Or as a background process directly
    }

    // For unsupported platforms or fallback: start directly
    let child = cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {}", e))?;
    // Don't wait - let it run in background
    std::mem::forget(child);
    Ok(())
}

#[tauri::command]
pub fn gateway_stop() -> Result<(), String> {
    let port = 28790;
    if let Some(pid) = find_gateway_pid(port) {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string()])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new("kill")
                .arg(pid.to_string())
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn gateway_restart() -> Result<(), String> {
    gateway_stop()?;
    // Small delay to ensure port is released
    std::thread::sleep(std::time::Duration::from_secs(1));
    gateway_start()
}

#[tauri::command]
pub fn gateway_reload() -> Result<(), String> {
    // Sends SIGUSR1 or equivalent reload signal
    if let Some(pid) = find_gateway_pid(28790) {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new("kill")
                .arg("-USR1")
                .arg(pid.to_string())
                .output()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_gateway_pid(port: u16) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        // Use lsof to find process listening on port
        let output = std::process::Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-t"])
            .output()
            .ok()?;
        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        pid_str.parse::<u32>().ok()
    }
    #[cfg(target_os = "linux")]
    {
        // Use ss or netstat
        let output = std::process::Command::new("ss")
            .args(["-tlnp", &format!("sport = :{}", port)])
            .output()
            .ok()?;
        // Parse PID from output like "pid=1234"
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.split("pid=").nth(1)?.split_whitespace().next()?.parse::<u32>().ok()
    }
    #[cfg(target_os = "windows")]
    {
        // Use netstat to find PID on port
        let output = std::process::Command::new("netstat")
            .args(["-ano", &format!("|", port)])
            .output()
            .ok()?;
        None // Simplified - would need proper parsing
    }
    #[cfg(target_os = "windows")]
    let _ = (port, output);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let _ = port;
    None
}

#[cfg(target_os = "macos")]
fn macos_launchagent_plist() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_str = exe.to_string_lossy();
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.cjgclaw.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>28790</string>
        <key>CJGCLAW_DIR</key>
        <string>{}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>"#, exe_str, cjgclaw_dir().to_string_lossy())
}
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sandbox/
git commit -m "feat(backend): create sandbox module with cjgclaw_dir, bundled OpenClaw path, and gateway management"
```

---

### Task 2: Add New Types for Sandbox and Gateway

**Files:**
- Create: `src-tauri/src/models/sandbox.rs`
- Create: `src-tauri/src/models/gateway.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/models/types.rs` (keep existing, add new)

- [ ] **Step 1: Create src-tauri/src/models/sandbox.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxInitResult {
    pub initialized: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStatus {
    pub installed: bool,
    pub version: String,
    pub dir: String,
}
```

- [ ] **Step 2: Create src-tauri/src/models/gateway.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardianStatus {
    pub auto_restart_count: u32,
    pub max_auto_restarts: u32,
    pub manual_hold: bool,
    pub last_seen_running: Option<String>,
    pub running_since: Option<String>,
    pub give_up: bool,
}
```

- [ ] **Step 3: Update src-tauri/src/models/mod.rs**

```rust
pub mod types;
pub mod sandbox;
pub mod gateway;
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/models/sandbox.rs src-tauri/src/models/gateway.rs src-tauri/src/models/mod.rs
git commit -m "feat(backend): add SandboxStatus and GatewayStatus types"
```

---

### Task 3: Update commands/mod.rs — Point to Sandbox Paths

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Replace openclaw_dir() with cjgclaw_dir() usage**

Replace every occurrence of `openclaw_dir()` with `crate::sandbox::cjgclaw_dir()`.
Replace every occurrence of `gateway_listen_port()` with `crate::sandbox::gateway_port()`.
Replace every `openclaw_command()` call with `crate::sandbox::openclaw::openclaw_command()`.
Replace every `openclaw_command_async()` call with `crate::sandbox::openclaw::openclaw_command_async()`.

The file currently has 596 lines. Key changes:

```rust
// OLD
pub fn openclaw_dir() -> PathBuf { ... }
pub fn gateway_listen_port() -> u16 { ... }

// NEW - delegate to sandbox module
pub use crate::sandbox::cjgclaw_dir;
pub use crate::sandbox::gateway_port;
pub use crate::sandbox::openclaw::{openclaw_command, openclaw_command_async};
```

Also update all `commands/config.rs` references from `super::openclaw_dir()` to `super::cjgclaw_dir()` and update the default port from 18789 to 28790.

- [ ] **Step 2: Update gateway port constant in config.rs**

In `src-tauri/src/commands/config.rs`, find the default port constant (likely `18789`) and change to `28790`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "refactor(backend): delegate path utilities to sandbox module"
```

---

### Task 4: Register New Commands in lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update lib.rs to register sandbox and gateway commands**

In `src-tauri/src/lib.rs`, add:

```rust
// After existing command module declarations, add:
mod sandbox;

// Inside the invoke_handler closure, add sandbox commands:
// sandbox::init::sandbox_init,
// sandbox::init::sandbox_status,
// sandbox::openclaw::openclaw_path,
// sandbox::gateway::gateway_status,
// sandbox::gateway::gateway_start,
// sandbox::gateway::gateway_stop,
// sandbox::gateway::gateway_restart,
// sandbox::gateway::gateway_reload,
```

Remove from registration (v1.0 drop):
```rust
// Remove: assistant::,
// Remove: memory::,
// Remove: messaging::,
// Remove: service::,
// Also remove from commands/mod.rs pub mod list
```

- [ ] **Step 2: Update tray.rs menu labels**

Change menu items from "ClawPanel" to "CJGClaw" and update service labels.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/tray.rs
git commit -m "feat(backend): register new sandbox and gateway commands, prune v2 features"
```

---

### Task 5: Verify Compilation

- [ ] **Step 1: Run cargo check**

Run: `cd /Users/guitaoli/ailab/clawpanel/src-tauri && cargo check 2>&1`
Expected: Compilation errors — fix them. Common issues: missing `pub use`, type mismatches, module path changes.

- [ ] **Step 2: Fix compilation errors one by one**

Expected errors and fixes:
1. `openclaw_dir` not found → import from `sandbox::cjgclaw_dir`
2. `gateway_listen_port` not found → import from `sandbox::gateway_port`
3. `openclaw_command` not found → import from `sandbox::openclaw`
4. `crate::utils::openclaw_command_async` → `crate::sandbox::openclaw::openclaw_command_async`

- [ ] **Step 3: Ensure cargo check passes**

Run: `cargo check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/
git commit -m "fix(backend): resolve compilation errors from sandbox migration"
```

---

## Plan Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | sandbox/mod.rs, init.rs, openclaw.rs, gateway.rs | Sandbox module with paths, init, CLI, Gateway |
| 2 | models/sandbox.rs, gateway.rs, mod.rs | New Rust types |
| 3 | commands/mod.rs | Redirect to sandbox paths |
| 4 | lib.rs, tray.rs | Register commands, update menu labels |
| 5 | all | Verify cargo check passes |

After this plan, the Rust backend uses `~/.cjgclaw/`, bundled OpenClaw via absolute path, port 28790, and has clean sandbox isolation. Ready for Plan 3 (pages) and Plan 4 (chat + setup).