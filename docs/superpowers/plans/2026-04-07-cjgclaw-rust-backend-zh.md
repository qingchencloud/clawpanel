# CJGClaw Rust 后端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 重构 Rust 后端以实现沙箱隔离 —— 将 `~/.openclaw/` 改为 `~/.cjgclaw/`，通过绝对路径捆绑 OpenClaw CLI，添加沙箱命令，将大型 config.rs（4580 行）拆分为专注的模块，添加新类型。

**架构：** 重构 `src-tauri/src/` 目录。新 `sandbox.rs` 处理 `~/.cjgclaw/` 初始化和捆绑 OpenClaw 路径解析。`openclaw.rs` 包装 CLI 调用。`gateway.rs` 管理 Gateway 进程。`config.rs` 拆分为更小的关注点。端口从 18789 改为 28790。所有 CLI 调用通过 `sandbox::openclaw_path()` 使用绝对捆绑路径。

**技术栈：** Rust（现有 Tauri v2）, ed25519-dalek, sha2, base64, dirs, tokio, reqwest, serde

---

## 文件结构

```
src-tauri/src/
├── main.rs                      # 不变
├── lib.rs                       # 注册新命令，移除已删除模块
├── tray.rs                      # 不变（ CJGClaw 菜单标签）
│
├── commands/
│   ├── mod.rs                   # cjgclaw_dir(), sandbox_dir(), openclaw_path(), gateway_port(28790)
│   ├── sandbox.rs               # 新增: sandbox_init, sandbox_status, openclaw_path
│   ├── openclaw.rs              # 新增: CLI 调用包装器，使用捆绑路径
│   ├── gateway.rs               # 新增: gateway_start/stop/restart/status/reload（从 config.rs 拆分）
│   ├── config.rs                # 保留: 配置读写（剥离 gateway/CLI 命令）
│   ├── agent.rs                 # 保留: 适配 cjgclaw_dir
│   ├── skills.rs                # 保留: 适配 cjgclaw_dir
│   ├── extensions.rs            # 保留: 适配 cjgclaw_dir
│   ├── logs.rs                  # 保留: 适配 cjgclaw_dir
│   ├── pairing.rs               # 保留: 适配 cjgclaw_dir
│   ├── device.rs                # 保留: 适配 cjgclaw_dir
│   ├── update.rs                # 保留: 适配 cjgclaw_dir
│   ├── messaging.rs             # 删除（v2）
│   ├── memory.rs                # 删除（v2）
│   ├── assistant.rs             # 删除（v2）
│   ├── service.rs               # 删除（合并到 gateway.rs + guardian.rs）
│   └── config_guardian.rs       # 删除（合并到 gateway.rs）
│
├── sandbox/
│   ├── mod.rs                   # sandbox_dir(), cjgclaw_dir(), bundled_openclaw_path()
│   ├── init.rs                  # sandbox_init 逻辑（目录创建、密钥生成）
│   ├── openclaw.rs              # openclaw_command 包装器
│   └── gateway.rs               # gateway 进程管理
│
└── models/
    ├── mod.rs
    ├── types.rs                 # ServiceStatus, VersionInfo + 新类型
    ├── sandbox.rs               # 新增: SandboxStatus, SandboxInitResult
    └── gateway.rs               # 新增: GatewayStatus
```

---

## 任务 1：创建沙箱模块与路径工具

**涉及文件：**
- 创建: `src-tauri/src/sandbox/mod.rs`
- 创建: `src-tauri/src/sandbox/init.rs`
- 创建: `src-tauri/src/sandbox/openclaw.rs`
- 创建: `src-tauri/src/sandbox/gateway.rs`

- [ ] **步骤 1：创建 src-tauri/src/sandbox/mod.rs**

```rust
//! CJGClaw 沙箱隔离模块。
//! 所有路径解析到 ~/.cjgclaw/ 而不是 ~/.openclaw/
//! 所有 OpenClaw CLI 调用使用捆绑的绝对路径。

use std::path::PathBuf;

/// 返回 CJGClaw 数据目录（~/.cjgclaw）
pub fn cjgclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cjgclaw")
}

/// 返回从应用包中捆绑的 OpenClaw CLI 路径。
/// macOS: /Applications/CJGClaw.app/Contents/Resources/openclaw/...
/// Windows: C:/Program Files/CJGClaw/resources/openclaw/...
/// Linux: /opt/cjgclaw/resources/openclaw/...
pub fn bundled_openclaw_dir() -> PathBuf {
    // Tauri 通过环境变量提供资源路径
    std::env::var("RESOURCE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // 后备：从可执行文件路径推导
            if let Ok(exe) = std::env::current_exe() {
                exe.parent()
                    .map(|p| p.join("openclaw"))
                    .unwrap_or_else(|| PathBuf::from("/opt/cjgclaw/openclaw"))
            } else {
                PathBuf::from("/opt/cjgclaw/openclaw")
            }
        })
}

/// 返回 OpenClaw CLI 入口点的绝对路径。
/// 解析到: bundled_openclaw_dir()/node_modules/openclaw/openclaw.mjs
pub fn openclaw_cli_path() -> PathBuf {
    bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs")
}

/// 返回 Gateway 监听端口（默认 28790，从 cjgclaw.json 读取）
pub fn gateway_port() -> u16 {
    // 从 ~/.cjgclaw/cjgclaw.json gateway.port 字段读取，缓存 5 秒
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

/// 返回 OpenClaw 配置目录（用于配置文件兼容性）。
/// CJGClaw 中为 ~/.cjgclaw/openclaw/（符号链接或捆绑默认值的副本）。
pub fn openclaw_config_dir() -> PathBuf {
    cjgclaw_dir().join("openclaw")
}

pub mod init;
pub mod openclaw;
pub mod gateway;
```

- [ ] **步骤 2：创建 src-tauri/src/sandbox/init.rs**

```rust
//! 沙箱初始化：创建 ~/.cjgclaw/ 目录结构，
//! 生成设备身份密钥，写入 cjgclaw.json，写入 .installed 版本文件。

use super::{cjgclaw_dir, openclaw_config_dir};
use crate::models::sandbox::{SandboxInitResult, SandboxStatus};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 初始化 CJGClaw 沙箱。可多次调用（幂等）。
/// 创建 ~/.cjgclaw/ 及其子目录，生成 Ed25519 设备密钥，
/// 创建默认 cjgclaw.json，写入 .installed 版本文件。
#[tauri::command]
pub fn sandbox_init() -> Result<SandboxInitResult, String> {
    let base = cjgclaw_dir();

    // 创建目录结构
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

    // 生成设备身份密钥（如果不存在）
    generate_device_identity(&base.join("identity/device.json"))?;

    // 如果不存在则创建 cjgclaw.json
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

    // 写入 .installed 版本标记
    std::fs::write(base.join(".installed"), CURRENT_VERSION)
        .map_err(|e| format!("写入版本标记失败: {}", e))?;

    Ok(SandboxInitResult {
        initialized: true,
        version: CURRENT_VERSION.to_string(),
    })
}

/// 获取当前沙箱状态。
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
        return Ok(()); // 已存在
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

- [ ] **步骤 3：创建 src-tauri/src/sandbox/openclaw.rs**

```rust
//! OpenClaw CLI 调用包装器，使用捆绑的绝对路径。

use super::{cjgclaw_dir, openclaw_cli_path};
use std::process::Command;
use std::path::PathBuf;

/// 使用捆绑的绝对路径构建 OpenClaw CLI 命令。
/// 注入 CJGCLAW_DIR 环境变量指向 ~/.cjgclaw/。
pub fn openclaw_command() -> Command {
    let mut cmd = Command::new("node");
    cmd.arg(openclaw_cli_path());
    cmd.env("CJGCLAW_DIR", cjgclaw_dir());
    cmd
}

/// 使用 tokio 构建异步 OpenClaw CLI 命令。
pub fn openclaw_command_async() -> tokio::process::Command {
    use tokio::process::Command as AsyncCommand;
    let mut cmd = AsyncCommand::new("node");
    cmd.arg(openclaw_cli_path());
    cmd.env("CJGCLAW_DIR", cjgclaw_dir());
    cmd
}

/// 返回捆绑 OpenClaw CLI 的绝对路径字符串。
/// 供 IPC 层暴露给前端。
#[tauri::command]
pub fn openclaw_path() -> Result<String, String> {
    let path = openclaw_cli_path();
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("OpenClaw CLI 未找到于 {}", path.display()))
    }
}
```

- [ ] **步骤 4：创建 src-tauri/src/sandbox/gateway.rs**

```rust
//! Gateway 进程管理，使用沙箱路径。
//! 端口：28790（ CJGClaw 专用，避免与系统 OpenClaw 18789 冲突）。

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

/// 通过探测端口检查 Gateway 是否运行。
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
        // 创建 LaunchAgent plist 并加载
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
        // 对于 linux，启动为前台进程由 systemd user 管理
        // 或作为后台进程直接启动
    }

    // 对于不支持的平台或后备：直接启动
    let child = cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {}", e))?;
    // 不等待 —— 让它在后台运行
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
    // 小延迟确保端口释放
    std::thread::sleep(std::time::Duration::from_secs(1));
    gateway_start()
}

#[tauri::command]
pub fn gateway_reload() -> Result<(), String> {
    // 发送 SIGUSR1 或等效的重载信号
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
        // 使用 lsof 查找监听端口的进程
        let output = std::process::Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-t"])
            .output()
            .ok()?;
        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        pid_str.parse::<u32>().ok()
    }
    #[cfg(target_os = "linux")]
    {
        // 使用 ss 或 netstat
        let output = std::process::Command::new("ss")
            .args(["-tlnp", &format!("sport = :{}", port)])
            .output()
            .ok()?;
        // 从输出解析 PID，如 "pid=1234"
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.split("pid=").nth(1)?.split_whitespace().next()?.parse::<u32>().ok()
    }
    #[cfg(target_os = "windows")]
    {
        // 使用 netstat 查找端口上的 PID
        let output = std::process::Command::new("netstat")
            .args(["-ano", &format!("|", port)])
            .output()
            .ok()?;
        None // 简化版 —— 需要正确的解析
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

- [ ] **步骤 5：提交**

```bash
git add src-tauri/src/sandbox/
git commit -m "feat(backend): create sandbox module with cjgclaw_dir, bundled OpenClaw path, and gateway management"
```

---

## 任务 2：添加沙箱和 Gateway 的新类型

**涉及文件：**
- 创建: `src-tauri/src/models/sandbox.rs`
- 创建: `src-tauri/src/models/gateway.rs`
- 修改: `src-tauri/src/models/mod.rs`
- 修改: `src-tauri/src/models/types.rs`（保留现有，添加新类型）

- [ ] **步骤 1：创建 src-tauri/src/models/sandbox.rs**

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

- [ ] **步骤 2：创建 src-tauri/src/models/gateway.rs**

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

- [ ] **步骤 3：更新 src-tauri/src/models/mod.rs**

```rust
pub mod types;
pub mod sandbox;
pub mod gateway;
```

- [ ] **步骤 4：提交**

```bash
git add src-tauri/src/models/sandbox.rs src-tauri/src/models/gateway.rs src-tauri/src/models/mod.rs
git commit -m "feat(backend): add SandboxStatus and GatewayStatus types"
```

---

## 任务 3：更新 commands/mod.rs —— 指向沙箱路径

**涉及文件：**
- 修改: `src-tauri/src/commands/mod.rs`

- [ ] **步骤 1：用 cjgclaw_dir() 替换 openclaw_dir() 使用**

将每个 `openclaw_dir()` 替换为 `crate::sandbox::cjgclaw_dir()`。
将每个 `gateway_listen_port()` 替换为 `crate::sandbox::gateway_port()`。
将每个 `openclaw_command()` 调用替换为 `crate::sandbox::openclaw::openclaw_command()`。
将每个 `openclaw_command_async()` 调用替换为 `crate::sandbox::openclaw::openclaw_command_async()`。

该文件当前有 596 行。关键变更：

```rust
// 旧
pub fn openclaw_dir() -> PathBuf { ... }
pub fn gateway_listen_port() -> u16 { ... }

// 新 —— 委托给沙箱模块
pub use crate::sandbox::cjgclaw_dir;
pub use crate::sandbox::gateway_port;
pub use crate::sandbox::openclaw::{openclaw_command, openclaw_command_async};
```

同时更新所有 `commands/config.rs` 中的引用，从 `super::openclaw_dir()` 改为 `super::cjgclaw_dir()`，并将默认端口从 18789 改为 28790。

- [ ] **步骤 2：在 config.rs 中更新 gateway 端口常量**

在 `src-tauri/src/commands/config.rs` 中，找到默认端口常量（可能是 `18789`）并改为 `28790`。

- [ ] **步骤 3：提交**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "refactor(backend): delegate path utilities to sandbox module"
```

---

## 任务 4：在 lib.rs 中注册新命令

**涉及文件：**
- 修改: `src-tauri/src/lib.rs`

- [ ] **步骤 1：更新 lib.rs 注册沙箱和 gateway 命令**

在 `src-tauri/src/lib.rs` 中，添加：

```rust
// 在现有命令模块声明之后，添加：
mod sandbox;

// 在 invoke_handler 闭包内，添加沙箱命令：
// sandbox::init::sandbox_init,
// sandbox::init::sandbox_status,
// sandbox::openclaw::openclaw_path,
// sandbox::gateway::gateway_status,
// sandbox::gateway::gateway_start,
// sandbox::gateway::gateway_stop,
// sandbox::gateway::gateway_restart,
// sandbox::gateway::gateway_reload,
```

从注册中移除（v1.0 删除）：
```rust
// 移除: assistant::,
// 移除: memory::,
// 移除: messaging::,
// 移除: service::,
// 也从 commands/mod.rs pub mod 列表中移除
```

- [ ] **步骤 2：更新 tray.rs 菜单标签**

将菜单项从 "ClawPanel" 改为 "CJGClaw" 并更新服务标签。

- [ ] **步骤 3：提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/tray.rs
git commit -m "feat(backend): register new sandbox and gateway commands, prune v2 features"
```

---

## 任务 5：验证编译

- [ ] **步骤 1：运行 cargo check**

运行: `cd /Users/guitaoli/ailab/clawpanel/src-tauri && cargo check 2>&1`
预期：编译错误 —— 逐个修复。常见问题：缺少 `pub use`、类型不匹配、模块路径变更。

- [ ] **步骤 2：逐个修复编译错误**

预期错误及修复：
1. `openclaw_dir` 未找到 → 从 `sandbox::cjgclaw_dir` 导入
2. `gateway_listen_port` 未找到 → 从 `sandbox::gateway_port` 导入
3. `openclaw_command` 未找到 → 从 `sandbox::openclaw` 导入
4. `crate::utils::openclaw_command_async` → `crate::sandbox::openclaw::openclaw_command_async`

- [ ] **步骤 3：确保 cargo check 通过**

运行: `cargo check`
预期：无错误

- [ ] **步骤 4：提交**

```bash
git add src-tauri/src/
git commit -m "fix(backend): resolve compilation errors from sandbox migration"
```

---

## 计划总结

| 任务 | 文件 | 描述 |
|------|-------|------|
| 1 | sandbox/mod.rs, init.rs, openclaw.rs, gateway.rs | 沙箱模块，含路径、初始化、CLI、Gateway |
| 2 | models/sandbox.rs, gateway.rs, mod.rs | 新 Rust 类型 |
| 3 | commands/mod.rs | 重定向到沙箱路径 |
| 4 | lib.rs, tray.rs | 注册命令，更新菜单标签 |
| 5 | all | 验证 cargo check 通过 |

完成此计划后，Rust 后端使用 `~/.cjgclaw/`、通过绝对路径捆绑 OpenClaw、端口 28790，并具有干净的沙箱隔离。可开始计划 3（页面）和计划 4（聊天 + 设置）。
