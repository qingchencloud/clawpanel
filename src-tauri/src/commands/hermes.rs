//! Hermes Agent 安装与管理命令
//!
//! 通过 uv (Astral) 实现零依赖安装：
//!   1. 下载 uv 单文件二进制
//!   2. uv tool install hermes-agent --python 3.11
//!   3. 写入 ~/.hermes/config.yaml + .env
//!
//! 参考：
//!   - uv docs: https://docs.astral.sh/uv/
//!   - Hermes 官方安装: https://hermes-agent.nousresearch.com/docs/getting-started/installation/

use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::Emitter;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ---------------------------------------------------------------------------
// Gateway Guardian — 进程守护 + 状态追踪
// ---------------------------------------------------------------------------

/// 我们 spawn 的 Gateway 进程 PID（0 表示没有）
static GW_PID: AtomicU32 = AtomicU32::new(0);
/// Guardian 是否正在运行
static GW_GUARDIAN_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 通知 guardian 停止的 flag
static GW_GUARDIAN_STOP: AtomicBool = AtomicBool::new(false);
/// 缓存 AppHandle 供 guardian 发送事件
static GW_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 获取 Gateway 的完整 URL（当前本地，未来可扩展为远程）
fn hermes_gateway_url() -> String {
    // 先检查 panel config 中是否配置了自定义 URL
    if let Some(url) = super::read_panel_config_value()
        .and_then(|v| {
            v.get("hermes")?
                .get("gatewayUrl")?
                .as_str()
                .map(String::from)
        })
        .filter(|s| !s.trim().is_empty())
    {
        return url.trim_end_matches('/').to_string();
    }
    let port = hermes_gateway_port();
    format!("http://127.0.0.1:{port}")
}

/// 精准杀掉我们 spawn 的 Gateway 进程
fn kill_gateway_pid() -> bool {
    let pid = GW_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/F", "/PID", &pid.to_string()]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let ok = cmd.output().map(|o| o.status.success()).unwrap_or(false);
        if ok {
            GW_PID.store(0, Ordering::SeqCst);
        }
        ok
    }
    #[cfg(not(target_os = "windows"))]
    {
        let ok = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            GW_PID.store(0, Ordering::SeqCst);
        }
        ok
    }
}

/// Guardian 后台任务：定期健康检查，失败时自动重启
async fn gateway_guardian_loop() {
    const CHECK_INTERVAL_SECS: u64 = 15;
    const MAX_FAIL_BEFORE_RESTART: u32 = 3;
    const MAX_RESTART_ATTEMPTS: u32 = 5;
    const RESTART_BACKOFF_BASE_SECS: u64 = 5;

    let mut consecutive_fails: u32 = 0;
    let mut restart_count: u32 = 0;
    let mut last_known_running = true;

    loop {
        // 检查是否被要求停止
        if GW_GUARDIAN_STOP.load(Ordering::SeqCst) {
            break;
        }

        tokio::time::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS)).await;

        if GW_GUARDIAN_STOP.load(Ordering::SeqCst) {
            break;
        }

        // 健康检查
        let healthy = gateway_quick_health_check().await;

        if healthy {
            if !last_known_running {
                // 状态恢复
                emit_gateway_status(true);
                last_known_running = true;
            }
            consecutive_fails = 0;
            restart_count = 0; // 稳定运行一段时间后重置重启计数
        } else {
            consecutive_fails += 1;

            if last_known_running && consecutive_fails >= 2 {
                // 状态变为离线
                emit_gateway_status(false);
                last_known_running = false;
            }

            if consecutive_fails >= MAX_FAIL_BEFORE_RESTART {
                if restart_count >= MAX_RESTART_ATTEMPTS {
                    // 超过最大重启次数，放弃
                    emit_guardian_log(&format!(
                        "Gateway 已连续重启 {} 次仍然失败，Guardian 停止自动恢复",
                        restart_count
                    ));
                    break;
                }

                // 指数退避重启
                let backoff = RESTART_BACKOFF_BASE_SECS * (1 << restart_count.min(4));
                emit_guardian_log(&format!(
                    "Gateway 连续 {} 次健康检查失败，{}s 后尝试重启 (第 {} 次)",
                    consecutive_fails,
                    backoff,
                    restart_count + 1
                ));
                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;

                if GW_GUARDIAN_STOP.load(Ordering::SeqCst) {
                    break;
                }

                // 尝试重启
                match do_restart_gateway().await {
                    Ok(_) => {
                        emit_guardian_log("Gateway 自动重启成功");
                        emit_gateway_status(true);
                        last_known_running = true;
                        consecutive_fails = 0;
                        restart_count += 1;
                    }
                    Err(e) => {
                        emit_guardian_log(&format!("Gateway 自动重启失败: {e}"));
                        restart_count += 1;
                    }
                }
            }
        }
    }

    GW_GUARDIAN_ACTIVE.store(false, Ordering::SeqCst);
}

/// 快速健康检查（TCP + HTTP，1s 超时）
async fn gateway_quick_health_check() -> bool {
    let url = hermes_gateway_url();
    let health_url = format!("{url}/health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .no_proxy()
        .build();
    match client {
        Ok(c) => c
            .get(&health_url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 重启 Gateway（kill 旧进程 → 启动新进程）
async fn do_restart_gateway() -> Result<(), String> {
    // 1. 杀掉旧进程
    kill_gateway_pid();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 2. 清理 PID 文件
    let home = hermes_home();
    let pid_file = home.join("gateway.pid");
    if pid_file.exists() {
        let _ = std::fs::remove_file(&pid_file);
    }

    // 3. 启动新进程
    let enhanced = hermes_enhanced_path();
    let log_path = home.join("gateway-run.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("打开日志失败: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("克隆日志句柄失败: {e}"))?;

    let mut cmd = std::process::Command::new("hermes");
    cmd.args(["gateway", "run"])
        .current_dir(&home)
        .env("PATH", &enhanced)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 注入 .env
    let env_path = home.join(".env");
    if let Ok(env_content) = std::fs::read_to_string(&env_path) {
        for line in env_content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, val)) = line.split_once('=') {
                cmd.env(key.trim(), val.trim());
            }
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 hermes gateway run 失败: {e}"))?;
    GW_PID.store(child.id(), Ordering::SeqCst);

    // 4. 等待端口可达（最多 15s）
    let port = hermes_gateway_port();
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500))
            .is_ok()
        {
            return Ok(());
        }
    }
    Err("Gateway 重启后端口未就绪".into())
}

/// 发送 Gateway 状态事件给前端
fn emit_gateway_status(running: bool) {
    if let Some(app) = GW_APP_HANDLE.get() {
        let port = hermes_gateway_port();
        let _ = app.emit(
            "hermes-gateway-status",
            serde_json::json!({
                "running": running,
                "port": port,
                "url": hermes_gateway_url(),
            }),
        );
    }
}

/// 发送 Guardian 日志事件给前端
fn emit_guardian_log(msg: &str) {
    if let Some(app) = GW_APP_HANDLE.get() {
        let _ = app.emit("hermes-guardian-log", msg);
    }
}

/// 启动 Guardian（如果尚未运行）
fn start_guardian(app: &tauri::AppHandle) {
    let _ = GW_APP_HANDLE.set(app.clone());
    if GW_GUARDIAN_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        GW_GUARDIAN_STOP.store(false, Ordering::SeqCst);
        tokio::spawn(gateway_guardian_loop());
    }
}

/// 停止 Guardian
fn stop_guardian() {
    GW_GUARDIAN_STOP.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/// Hermes 配置目录 (~/.hermes)
fn hermes_home() -> PathBuf {
    if let Ok(h) = std::env::var("HERMES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir().unwrap_or_default().join(".hermes")
}

/// ClawPanel 管理的 uv 二进制存放路径
fn uv_bin_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        if !appdata.is_empty() {
            return PathBuf::from(appdata).join("clawpanel").join("bin");
        }
        dirs::home_dir()
            .unwrap_or_default()
            .join(".clawpanel")
            .join("bin")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library")
            .join("Application Support")
            .join("clawpanel")
            .join("bin")
    }
    #[cfg(target_os = "linux")]
    {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local")
            .join("share")
            .join("clawpanel")
            .join("bin")
    }
}

/// uv 二进制完整路径
fn uv_bin_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        uv_bin_dir().join("uv.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        uv_bin_dir().join("uv")
    }
}

/// uv 下载 URL（按当前编译平台选择）
fn uv_download_url(version: &str) -> String {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    let filename = "uv-x86_64-pc-windows-msvc.zip";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let filename = "uv-aarch64-apple-darwin.tar.gz";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let filename = "uv-x86_64-apple-darwin.tar.gz";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let filename = "uv-x86_64-unknown-linux-gnu.tar.gz";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let filename = "uv-aarch64-unknown-linux-gnu.tar.gz";

    format!("https://github.com/astral-sh/uv/releases/download/{version}/{filename}")
}

/// 构建增强 PATH，确保能找到 uv、hermes、python 等
fn hermes_enhanced_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra: Vec<String> = vec![];

    // ClawPanel 管理的 uv 二进制目录
    extra.push(uv_bin_dir().to_string_lossy().to_string());

    // uv tool 安装的可执行文件目录
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        if !appdata.is_empty() {
            // uv 在 Windows 上的默认 tool bin 路径
            extra.push(format!(r"{}\uv\tools\bin", appdata));
        }
        extra.push(format!(r"{}\.local\bin", home.display()));
        // uv 自身的默认安装路径
        extra.push(format!(r"{}\.local\bin", home.display()));
        extra.push(format!(r"{}\.cargo\bin", home.display()));
    }
    #[cfg(not(target_os = "windows"))]
    {
        extra.push(format!("{}/.local/bin", home.display()));
        extra.push(format!("{}/.cargo/bin", home.display()));
        extra.push("/usr/local/bin".into());
    }

    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let mut parts: Vec<&str> = extra.iter().map(|s| s.as_str()).collect();
    if !current.is_empty() {
        parts.push(&current);
    }
    parts.join(sep)
}

/// 执行命令并获取 stdout（静默，无窗口）
fn run_silent(program: &str, args: &[&str]) -> Result<String, String> {
    let enhanced = hermes_enhanced_path();
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", &enhanced);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

/// 在指定路径上执行命令
fn run_at_path(program: &str, args: &[&str], path: &str) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 解析 Python 版本号 "Python X.Y.Z" → (X, Y, Z)
fn parse_python_version(raw: &str) -> Option<(u32, u32, u32)> {
    let version_str = raw.strip_prefix("Python ").unwrap_or(raw);
    let parts: Vec<&str> = version_str.trim().split('.').collect();
    if parts.len() >= 2 {
        let major = parts[0].parse().ok()?;
        let minor = parts[1].parse().ok()?;
        let patch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
        Some((major, minor, patch))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// check_python — 检测 Python 环境
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn check_python() -> Result<Value, String> {
    let enhanced = hermes_enhanced_path();
    let mut result = serde_json::Map::new();

    // 平台标识
    result.insert(
        "platform".into(),
        Value::String(current_platform_key().into()),
    );

    // 尝试多种 Python 命令
    let python_candidates: Vec<(&str, Vec<&str>)> = {
        #[cfg(target_os = "windows")]
        {
            vec![
                ("py", vec!["-3", "--version"]),
                ("python", vec!["--version"]),
                ("python3", vec!["--version"]),
            ]
        }
        #[cfg(not(target_os = "windows"))]
        {
            vec![
                ("python3", vec!["--version"]),
                ("python", vec!["--version"]),
            ]
        }
    };

    let mut found = false;
    for (cmd, args) in &python_candidates {
        if let Ok(ver_str) = run_at_path(cmd, args, &enhanced) {
            if let Some((major, minor, patch)) = parse_python_version(&ver_str) {
                let version = format!("{major}.{minor}.{patch}");
                let version_ok = major >= 3 && minor >= 11;
                result.insert("installed".into(), Value::Bool(true));
                result.insert("version".into(), Value::String(version));
                result.insert("versionOk".into(), Value::Bool(version_ok));
                result.insert("pythonCmd".into(), Value::String(cmd.to_string()));

                // 尝试获取 Python 路径
                let path_result = find_executable_path(cmd, &enhanced);
                result.insert(
                    "path".into(),
                    path_result.map(Value::String).unwrap_or(Value::Null),
                );

                found = true;
                break;
            }
        }
    }

    if !found {
        result.insert("installed".into(), Value::Bool(false));
        result.insert("version".into(), Value::Null);
        result.insert("versionOk".into(), Value::Bool(false));
        result.insert("path".into(), Value::Null);
        result.insert("pythonCmd".into(), Value::Null);
    }

    // 检测 pip
    let has_pip = run_at_path("pip", &["--version"], &enhanced).is_ok()
        || run_at_path("pip3", &["--version"], &enhanced).is_ok();
    result.insert("hasPip".into(), Value::Bool(has_pip));

    // 检测 pipx
    let has_pipx = run_at_path("pipx", &["--version"], &enhanced).is_ok();
    result.insert("hasPipx".into(), Value::Bool(has_pipx));

    // 检测 uv
    let uv_path = uv_bin_path();
    let has_uv = if uv_path.exists() {
        true
    } else {
        run_at_path("uv", &["--version"], &enhanced).is_ok()
    };
    result.insert("hasUv".into(), Value::Bool(has_uv));

    // 检测 git（从 GitHub 安装 hermes-agent 需要 git）
    let has_git = run_at_path("git", &["--version"], &enhanced).is_ok();
    result.insert("hasGit".into(), Value::Bool(has_git));

    // 检测 brew（macOS/Linux）
    #[cfg(not(target_os = "windows"))]
    {
        let has_brew = run_at_path("brew", &["--version"], &enhanced).is_ok();
        result.insert("hasBrew".into(), Value::Bool(has_brew));
    }
    #[cfg(target_os = "windows")]
    {
        result.insert("hasBrew".into(), Value::Bool(false));
    }

    Ok(Value::Object(result))
}

/// 查找可执行文件路径
fn find_executable_path(name: &str, enhanced_path: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("where");
        cmd.arg(name).env("PATH", enhanced_path);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return stdout.lines().next().map(|s| s.trim().to_string());
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("which");
        cmd.arg(name).env("PATH", enhanced_path);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Some(stdout.trim().to_string());
            }
        }
        None
    }
}

fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "mac-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "mac-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// check_hermes — 检测 Hermes Agent 安装状态
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn check_hermes() -> Result<Value, String> {
    let enhanced = hermes_enhanced_path();
    let mut result = serde_json::Map::new();
    let home = hermes_home();

    // 1. 检测 hermes CLI
    let hermes_version = run_at_path("hermes", &["version"], &enhanced)
        .or_else(|_| run_at_path("hermes", &["--version"], &enhanced));

    match hermes_version {
        Ok(ver_raw) => {
            // 提取版本号（格式可能是 "Hermes Agent v0.8.0" 或 "0.8.0"）
            let version = ver_raw
                .split_whitespace()
                .find(|s| {
                    s.starts_with('v') || s.chars().next().is_some_and(|c| c.is_ascii_digit())
                })
                .unwrap_or(&ver_raw)
                .trim_start_matches('v')
                .to_string();
            result.insert("installed".into(), Value::Bool(true));
            result.insert("version".into(), Value::String(version));

            // 获取 hermes 路径
            let path = find_executable_path("hermes", &enhanced);
            result.insert(
                "path".into(),
                path.map(Value::String).unwrap_or(Value::Null),
            );
        }
        Err(_) => {
            result.insert("installed".into(), Value::Bool(false));
            result.insert("version".into(), Value::Null);
            result.insert("path".into(), Value::Null);
        }
    }

    // 2. 检测安装方式（managed）
    let managed = if let Ok(raw) = std::env::var("HERMES_MANAGED") {
        let lower = raw.trim().to_lowercase();
        match lower.as_str() {
            "true" | "1" | "yes" | "nix" | "nixos" => Some("NixOS"),
            "brew" | "homebrew" => Some("Homebrew"),
            _ => Some("unknown"),
        }
    } else if home.join(".managed").exists() {
        Some("NixOS")
    } else {
        None
    };
    result.insert(
        "managed".into(),
        managed
            .map(|s| Value::String(s.into()))
            .unwrap_or(Value::Null),
    );

    // 3. 配置文件检测
    let config_path = home.join("config.yaml");
    let env_path = home.join(".env");
    result.insert("configExists".into(), Value::Bool(config_path.exists()));
    result.insert("envExists".into(), Value::Bool(env_path.exists()));
    result.insert(
        "hermesHome".into(),
        Value::String(home.to_string_lossy().to_string()),
    );

    // 4. 读取 model 配置（支持 string 和 dict 两种格式）
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        let mut found = false;
        let mut in_model_block = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("model:") {
                let val = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                if !val.is_empty() {
                    // model: some_string 格式
                    result.insert("model".into(), Value::String(val));
                    found = true;
                    break;
                }
                // model: (空) 后面是 dict 块
                in_model_block = true;
                continue;
            }
            if in_model_block {
                if !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.is_empty() {
                    break; // dict 块结束
                }
                if let Some(rest) = trimmed.strip_prefix("default:") {
                    let val = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !val.is_empty() {
                        result.insert("model".into(), Value::String(val));
                        found = true;
                    }
                }
            }
        }
        let _ = found; // suppress unused warning
    }

    // 5. Gateway 运行检测（非阻塞，快速超时）— 使用动态 URL 支持远程目标
    let gw_url = hermes_gateway_url();
    let gateway_port = hermes_gateway_port();
    // 从 URL 中提取 host:port 用于 TCP 探测
    let probe_addr = {
        let stripped = gw_url
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/');
        if stripped.contains(':') {
            stripped.to_string()
        } else {
            format!("{stripped}:{gateway_port}")
        }
    };
    let gateway_running = probe_addr
        .parse::<std::net::SocketAddr>()
        .map(|addr| {
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800))
                .is_ok()
        })
        .unwrap_or(false);
    result.insert("gatewayRunning".into(), Value::Bool(gateway_running));
    result.insert("gatewayPort".into(), Value::Number(gateway_port.into()));
    result.insert("gatewayUrl".into(), Value::String(gw_url));

    Ok(Value::Object(result))
}

/// Hermes Gateway 默认端口
fn hermes_gateway_port() -> u16 {
    // 尝试从 config.yaml 读取自定义端口
    let config_path = hermes_home().join("config.yaml");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        // 简单解析 YAML 中的 api_server_port 或 port
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("api_server_port:") {
                if let Ok(port) = rest.trim().parse::<u16>() {
                    if port > 0 {
                        return port;
                    }
                }
            }
        }
    }
    8642 // Hermes 默认端口
}

// ---------------------------------------------------------------------------
// install_hermes — 一键安装（下载 uv → uv tool install hermes-agent）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn install_hermes(
    app: tauri::AppHandle,
    method: String,
    extras: Vec<String>,
) -> Result<String, String> {
    let _ = app.emit("hermes-install-log", "🚀 开始安装 Hermes Agent...");
    let _ = app.emit("hermes-install-progress", 0u32);

    // Step 1: 确保 uv 可用
    let uv_path = ensure_uv(&app).await?;
    let _ = app.emit("hermes-install-progress", 20u32);

    // Step 2: 执行安装
    match method.as_str() {
        "uv-tool" | "" => install_via_uv_tool(&app, &uv_path, &extras).await?,
        "uv-pip" => install_via_uv_pip(&app, &uv_path, &extras).await?,
        other => return Err(format!("不支持的安装方式: {other}")),
    };

    let _ = app.emit("hermes-install-progress", 90u32);

    // Step 3: 验证安装
    let _ = app.emit("hermes-install-log", "🔍 验证安装...");
    let enhanced = hermes_enhanced_path();
    match run_at_path("hermes", &["version"], &enhanced) {
        Ok(ver) => {
            let _ = app.emit(
                "hermes-install-log",
                format!("✅ Hermes Agent 安装成功: {ver}"),
            );
            let _ = app.emit("hermes-install-progress", 100u32);
            let _ = app.emit(
                "hermes-install-done",
                serde_json::json!({ "success": true, "version": ver }),
            );
            Ok(ver)
        }
        Err(e) => {
            let msg = format!("⚠️ 安装完成但验证失败: {e}");
            let _ = app.emit("hermes-install-log", &msg);
            let _ = app.emit(
                "hermes-install-done",
                serde_json::json!({ "success": false, "error": msg }),
            );
            Err(msg)
        }
    }
}

/// 确保 uv 二进制可用，不存在则下载
async fn ensure_uv(app: &tauri::AppHandle) -> Result<String, String> {
    let uv_path = uv_bin_path();

    // 已有 uv
    if uv_path.exists() {
        let path_str = uv_path.to_string_lossy().to_string();
        if let Ok(ver) = run_silent(&path_str, &["--version"]) {
            let _ = app.emit("hermes-install-log", format!("✓ uv 已就绪: {ver}"));
            return Ok(path_str);
        }
    }

    // 系统 PATH 中有 uv
    let enhanced = hermes_enhanced_path();
    if let Ok(ver) = run_at_path("uv", &["--version"], &enhanced) {
        let _ = app.emit("hermes-install-log", format!("✓ 系统 uv 已就绪: {ver}"));
        if let Some(path) = find_executable_path("uv", &enhanced) {
            return Ok(path);
        }
        return Ok("uv".into());
    }

    // 需要下载 uv
    let _ = app.emit("hermes-install-log", "📦 下载 uv 包管理器...");
    let _ = app.emit("hermes-install-progress", 5u32);

    let version = "0.7.12"; // 稳定版本
    let url = uv_download_url(version);
    let _ = app.emit("hermes-install-log", format!("下载: {url}"));

    let client = super::build_http_client(std::time::Duration::from_secs(300), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("uv 下载失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("uv 下载失败 (HTTP {})", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("uv 下载读取失败: {e}"))?;

    let _ = app.emit(
        "hermes-install-log",
        format!(
            "下载完成 ({:.1}MB)，解压中...",
            bytes.len() as f64 / 1_048_576.0
        ),
    );
    let _ = app.emit("hermes-install-progress", 12u32);

    // 创建目标目录
    let bin_dir = uv_bin_dir();
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    // 解压
    #[cfg(target_os = "windows")]
    {
        extract_uv_zip(&bytes, &bin_dir)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        extract_uv_tar_gz(&bytes, &bin_dir)?;
    }

    // 验证
    let path_str = uv_path.to_string_lossy().to_string();
    if !uv_path.exists() {
        return Err(format!("uv 解压后未找到: {}", path_str));
    }

    // Unix: 确保可执行
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&uv_path, std::fs::Permissions::from_mode(0o755));
    }

    match run_silent(&path_str, &["--version"]) {
        Ok(ver) => {
            let _ = app.emit("hermes-install-log", format!("✓ uv 安装成功: {ver}"));
            Ok(path_str)
        }
        Err(e) => Err(format!("uv 安装后验证失败: {e}")),
    }
}

/// Windows: 解压 zip 格式的 uv 二进制
#[cfg(target_os = "windows")]
fn extract_uv_zip(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 解析失败: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("ZIP 条目读取失败: {e}"))?;
        let name = file.name().to_string();
        // 只提取 uv.exe（可能在子目录中）
        if name.ends_with("uv.exe") {
            let out_path = dest.join("uv.exe");
            let mut out_file =
                std::fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {e}"))?;
            std::io::copy(&mut file, &mut out_file).map_err(|e| format!("写入失败: {e}"))?;
            return Ok(());
        }
    }
    Err("ZIP 中未找到 uv.exe".into())
}

/// Unix: 解压 tar.gz 格式的 uv 二进制
#[cfg(not(target_os = "windows"))]
fn extract_uv_tar_gz(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
    let mut archive = tar::Archive::new(gz);
    for entry in archive
        .entries()
        .map_err(|e| format!("tar 解析失败: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("tar 条目读取失败: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("路径读取失败: {e}"))?
            .to_path_buf();
        if let Some(name) = path.file_name() {
            if name == "uv" {
                let out_path = dest.join("uv");
                let mut out_file =
                    std::fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut out_file).map_err(|e| format!("写入失败: {e}"))?;
                return Ok(());
            }
        }
    }
    Err("tar.gz 中未找到 uv".into())
}

/// Hermes Agent 的 GitHub 仓库地址（不在 PyPI 上发布，只能从 GitHub 安装）
const HERMES_GIT_URL: &str = "git+https://github.com/NousResearch/hermes-agent.git";

/// 通过 uv tool install 安装 Hermes Agent（从 GitHub）
async fn install_via_uv_tool(
    app: &tauri::AppHandle,
    uv_path: &str,
    extras: &[String],
) -> Result<(), String> {
    let _ = app.emit(
        "hermes-install-log",
        "📦 通过 uv tool install 从 GitHub 安装 Hermes Agent...",
    );
    let _ = app.emit("hermes-install-progress", 25u32);

    // 构造包名（PEP 508 格式: "pkg[extras] @ git+url"）
    // hermes-agent 未发布到 PyPI，必须从 GitHub 安装
    let pkg = if extras.is_empty() {
        format!("hermes-agent @ {}", HERMES_GIT_URL)
    } else {
        format!("hermes-agent[{}] @ {}", extras.join(","), HERMES_GIT_URL)
    };

    let mut cmd = tokio::process::Command::new(uv_path);
    cmd.args([
        "tool", "install", "--force", &pkg, "--python", "3.11", "--with", "croniter",
    ]);

    // 配置 PyPI 镜像（extras 的依赖仍从 PyPI 下载）
    if let Some(mirror) = pypi_mirror_url() {
        cmd.args(["--index-url", &mirror]);
    }

    // 代理
    super::apply_proxy_env_tokio(&mut cmd);
    cmd.env("PATH", hermes_enhanced_path());
    // uv 需要 git 来克隆仓库
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 捕获输出
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let _ = app.emit(
        "hermes-install-log",
        format!("> uv tool install \"{}\" --python 3.11", pkg),
    );

    let child = cmd.spawn().map_err(|e| format!("启动安装进程失败: {e}"))?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("等待安装进程失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // 逐行输出日志
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            let _ = app.emit("hermes-install-log", line.trim());
        }
    }

    if output.status.success() {
        let _ = app.emit("hermes-install-log", "✓ uv tool install 完成");
        // 更新 shell PATH
        let mut update_cmd = tokio::process::Command::new(uv_path);
        update_cmd.args(["tool", "update-shell"]);
        #[cfg(target_os = "windows")]
        update_cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = update_cmd.output().await;
        Ok(())
    } else {
        Err(format!(
            "安装失败 (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ))
    }
}

/// 通过 uv pip install 安装到 venv（备选方式）
async fn install_via_uv_pip(
    app: &tauri::AppHandle,
    uv_path: &str,
    extras: &[String],
) -> Result<(), String> {
    let _ = app.emit(
        "hermes-install-log",
        "📦 通过 uv venv + pip install 安装...",
    );
    let _ = app.emit("hermes-install-progress", 25u32);

    let home = dirs::home_dir().unwrap_or_default();
    let venv_dir = home.join(".hermes-venv");
    let venv_str = venv_dir.to_string_lossy().to_string();

    // 创建 venv
    let _ = app.emit(
        "hermes-install-log",
        format!("> uv venv {venv_str} --python 3.11"),
    );
    let mut venv_cmd = tokio::process::Command::new(uv_path);
    venv_cmd.args(["venv", &venv_str, "--python", "3.11"]);
    super::apply_proxy_env_tokio(&mut venv_cmd);
    #[cfg(target_os = "windows")]
    venv_cmd.creation_flags(CREATE_NO_WINDOW);
    let venv_out = venv_cmd
        .output()
        .await
        .map_err(|e| format!("创建 venv 失败: {e}"))?;
    if !venv_out.status.success() {
        let stderr = String::from_utf8_lossy(&venv_out.stderr);
        return Err(format!("创建 venv 失败: {stderr}"));
    }
    let _ = app.emit("hermes-install-log", "✓ Python 虚拟环境创建完成");
    let _ = app.emit("hermes-install-progress", 40u32);

    // pip install（从 GitHub）
    let pkg = if extras.is_empty() {
        format!("hermes-agent @ {}", HERMES_GIT_URL)
    } else {
        format!("hermes-agent[{}] @ {}", extras.join(","), HERMES_GIT_URL)
    };
    let _ = app.emit("hermes-install-log", format!("> uv pip install \"{pkg}\""));

    let mut pip_cmd = tokio::process::Command::new(uv_path);
    pip_cmd.args(["pip", "install", &pkg]);
    pip_cmd.env("GIT_TERMINAL_PROMPT", "0");
    pip_cmd.env("VIRTUAL_ENV", &venv_str);
    if let Some(mirror) = pypi_mirror_url() {
        pip_cmd.args(["--index-url", &mirror]);
    }
    super::apply_proxy_env_tokio(&mut pip_cmd);
    #[cfg(target_os = "windows")]
    pip_cmd.creation_flags(CREATE_NO_WINDOW);

    let pip_out = pip_cmd
        .output()
        .await
        .map_err(|e| format!("pip install 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&pip_out.stdout);
    let stderr = String::from_utf8_lossy(&pip_out.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            let _ = app.emit("hermes-install-log", line.trim());
        }
    }

    if !pip_out.status.success() {
        return Err(format!("pip install 失败: {}", stderr.trim()));
    }

    let _ = app.emit("hermes-install-log", "✓ pip install 完成");

    // 创建全局命令链接
    #[cfg(not(target_os = "windows"))]
    {
        let hermes_bin = venv_dir.join("bin").join("hermes");
        let link_dir = home.join(".local").join("bin");
        let _ = std::fs::create_dir_all(&link_dir);
        let link_path = link_dir.join("hermes");
        let _ = std::fs::remove_file(&link_path);
        if let Err(e) = std::os::unix::fs::symlink(&hermes_bin, &link_path) {
            let _ = app.emit(
                "hermes-install-log",
                format!("⚠️ 创建全局链接失败: {e}（hermes 仍可通过 {hermes_bin:?} 使用）"),
            );
        } else {
            let _ = app.emit("hermes-install-log", format!("✓ 全局链接: {link_path:?}"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows: 将 venv\Scripts 加入用户 PATH（通过注册表）
        let scripts_dir = venv_dir.join("Scripts");
        let _ = app.emit(
            "hermes-install-log",
            format!("提示：请将 {} 加入系统 PATH", scripts_dir.display()),
        );
    }

    Ok(())
}

/// 获取 PyPI 镜像 URL（如果配置了的话）
fn pypi_mirror_url() -> Option<String> {
    super::read_panel_config_value()
        .and_then(|v| v.get("pypiMirror")?.as_str().map(String::from))
        .filter(|s| !s.trim().is_empty())
}

// ---------------------------------------------------------------------------
// configure_hermes — 写入配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn configure_hermes(
    provider: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let home = hermes_home();
    std::fs::create_dir_all(&home).map_err(|e| format!("创建配置目录失败: {e}"))?;

    // 创建子目录
    for dir in &[
        "cron",
        "sessions",
        "logs",
        "memories",
        "skills",
        "pairing",
        "hooks",
        "image_cache",
        "audio_cache",
    ] {
        let _ = std::fs::create_dir_all(home.join(dir));
    }

    // ---- Provider-aware key routing ----
    // ClawPanel 使用 HERMES_PROVIDER_REGISTRY (22 providers) 决定 .env key 名和
    // config.yaml 的 model.provider 字段。详见 hermes_providers.rs 的文档。
    use super::hermes_providers;

    let pcfg = hermes_providers::get_provider(&provider);

    // 模型标识：优先使用调用方传入，否则用 provider 的首个已知模型；
    // aggregator 没有默认模型，要求调用方显式提供。
    let model_str = model.unwrap_or_else(|| {
        pcfg.and_then(|p| p.models.first().map(|s| s.to_string()))
            .unwrap_or_default()
    });
    if model_str.is_empty() {
        return Err(format!(
            "Provider '{provider}' has no default model; please pass an explicit model name"
        ));
    }

    // ---- 写入 config.yaml（合并模式：保留用户自定义的 hooks/skills/cron 等） ----
    let config_path = home.join("config.yaml");
    let base_url_line = match base_url.as_ref() {
        Some(url) if !url.trim().is_empty() => format!("  base_url: {}\n", url.trim()),
        _ => String::new(),
    };
    // Provider 字段：Hermes v0.14+ 的 model_switch 依赖该字段决定 env_var。
    // `custom` 不写 provider 行，让 Hermes 从 base_url 自动推断。
    let provider_line = if provider == "custom" || provider.is_empty() {
        String::new()
    } else {
        format!("  provider: {provider}\n")
    };

    let config_content = if config_path.exists() {
        // 读取现有配置，只更新 model 区块，保留其余内容
        let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
        merge_hermes_config_yaml(&existing, &model_str, &base_url_line, &provider_line)
    } else {
        // 首次创建：生成完整的基线配置
        format!(
            r#"# Hermes Agent configuration (managed by ClawPanel)
model:
  default: {model_str}
{provider_line}{base_url_line}platform_toolsets:
  api_server:
    - hermes-api-server
terminal:
  backend: local
platforms:
  api_server:
    enabled: true
"#
        )
    };
    std::fs::write(&config_path, &config_content)
        .map_err(|e| format!("写入 config.yaml 失败: {e}"))?;

    // ---- 写入 .env（合并模式：保留用户自定义的环境变量如 TAVILY_API_KEY 等） ----
    // 根据 provider 选择正确的 env var；OAuth/external_process 类没有 api_key_env_vars，
    // 此时跳过写 key（CLI 登录后 Hermes 会自行管理 auth.json）。
    let key_env = hermes_providers::primary_api_key_env(&provider);
    let url_env = hermes_providers::primary_base_url_env(&provider);

    // ClawPanel 管理的 key 列表：包含所有 provider 的 api_key_env_vars + base_url_env_vars
    // + ClawPanel 特定的两个 key。换 provider 时这些会被重写或清除。
    let managed_keys_owned = hermes_providers::all_managed_env_keys();
    let managed_keys: Vec<&str> = managed_keys_owned.to_vec();

    let mut new_pairs: Vec<(String, String)> = vec![
        ("GATEWAY_ALLOW_ALL_USERS".into(), "true".into()),
        ("API_SERVER_KEY".into(), "clawpanel-local".into()),
    ];

    if let Some(env) = key_env {
        if !api_key.trim().is_empty() {
            new_pairs.push((env.into(), api_key.trim().into()));
        }
    } else if !api_key.trim().is_empty() {
        // OAuth provider 传了 api_key —— 记日志，不落盘
        eprintln!("[configure_hermes] Provider '{provider}' uses OAuth; ignoring provided api_key");
    }

    if let (Some(env), Some(url)) = (url_env, base_url.as_ref()) {
        let u = url.trim();
        if !u.is_empty() {
            new_pairs.push((env.into(), u.into()));
        }
    }

    let env_path = home.join(".env");
    let env_content = if env_path.exists() {
        let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
        merge_env_file(&existing, &managed_keys, &new_pairs)
    } else {
        new_pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    };
    std::fs::write(&env_path, &env_content).map_err(|e| format!("写入 .env 失败: {e}"))?;

    // Unix: 设置 .env 文件权限为 600
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&env_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok("配置已保存".into())
}

// ---------------------------------------------------------------------------
// 配置合并帮助函数
// ---------------------------------------------------------------------------

/// 合并 Hermes config.yaml：只更新 model 区块（default/base_url），
/// 保留用户自定义的 hooks、skills、cron、session 等其他顶级 section。
fn merge_hermes_config_yaml(
    existing: &str,
    model_str: &str,
    base_url_line: &str,
    provider_line: &str,
) -> String {
    let mut result = Vec::new();
    let mut in_model_block = false;
    let mut model_block_written = false;
    let lines: Vec<&str> = existing.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed == "model:" || trimmed.starts_with("model:") {
            // 进入 model 区块，写入新的 model 配置
            in_model_block = true;
            model_block_written = true;
            result.push("model:".to_string());
            result.push(format!("  default: {model_str}"));
            if !base_url_line.is_empty() {
                // base_url_line 已包含 "  base_url: xxx\n" 格式
                result.push(base_url_line.trim_end().to_string());
            }
            // provider_line 仅在非空时写入（Hermes 不需要 provider 字段）
            if !provider_line.is_empty() {
                result.push(provider_line.trim_end().to_string());
            }
            i += 1;
            // 跳过旧 model 区块的缩进行
            while i < lines.len() {
                let next = lines[i];
                let next_trimmed = next.trim();
                // 空行或缩进行（属于 model 区块）继续跳过
                if next_trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                if next.starts_with("  ") || next.starts_with('\t') {
                    i += 1;
                    continue;
                }
                // 遇到新的顶级 key，停止跳过
                break;
            }
            continue;
        }

        if in_model_block
            && !trimmed.is_empty()
            && !line.starts_with("  ")
            && !line.starts_with('\t')
        {
            in_model_block = false;
        }

        if !in_model_block {
            result.push(line.to_string());
        }
        i += 1;
    }

    // 如果原文件没有 model: 区块（异常情况），追加
    if !model_block_written {
        result.push("model:".to_string());
        result.push(format!("  default: {model_str}"));
        if !base_url_line.is_empty() {
            result.push(base_url_line.trim_end().to_string());
        }
        if !provider_line.is_empty() {
            result.push(provider_line.trim_end().to_string());
        }
    }

    // 确保 platform_toolsets 和 platforms 存在（首次合并保底）
    let joined = result.join("\n");
    let mut final_content = joined.clone();
    if !final_content.contains("platform_toolsets:") {
        final_content.push_str("\nplatform_toolsets:\n  api_server:\n    - hermes-api-server\n");
    }
    if !final_content.contains("terminal:") {
        final_content.push_str("terminal:\n  backend: local\n");
    }
    if !final_content.contains("platforms:") {
        final_content.push_str("platforms:\n  api_server:\n    enabled: true\n");
    }
    if !final_content.ends_with('\n') {
        final_content.push('\n');
    }
    final_content
}

/// 合并 .env 文件：更新 managed_keys 对应的值，保留用户自定义的其他环境变量。
fn merge_env_file(existing: &str, managed_keys: &[&str], new_pairs: &[(String, String)]) -> String {
    let mut result = Vec::new();
    let _new_keys: std::collections::HashSet<&str> =
        new_pairs.iter().map(|(k, _)| k.as_str()).collect();

    // 保留非 managed 的行，跳过 managed 的行（后面追加新值）
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            result.push(line.to_string());
            continue;
        }
        if let Some(eq_pos) = trimmed.find('=') {
            let key = trimmed[..eq_pos].trim();
            if managed_keys.contains(&key) {
                // 跳过 managed key（后面追加新值）
                continue;
            }
        }
        result.push(line.to_string());
    }

    // 追加新的 managed key=value
    for (k, v) in new_pairs {
        result.push(format!("{k}={v}"));
    }

    let mut content = result.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content
}

// ---------------------------------------------------------------------------
// hermes_read_config — 读取 Hermes config.yaml + .env
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_read_config() -> Result<Value, String> {
    use super::hermes_providers;

    let home = hermes_home();
    let config_path = home.join("config.yaml");
    let env_path = home.join(".env");

    // 读取 config.yaml
    let config_raw = std::fs::read_to_string(&config_path).unwrap_or_default();
    let mut model_name = String::new();
    let mut base_url_from_yaml = String::new();
    let mut provider_from_yaml = String::new();
    let mut in_model = false;
    for line in config_raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model:") {
            in_model = true;
            // `model: "xxx"` 单行格式
            if let Some(v) = trimmed
                .strip_prefix("model:")
                .map(|s| s.trim().trim_matches('"'))
            {
                if !v.is_empty() && !v.contains(':') {
                    model_name = v.to_string();
                }
            }
            continue;
        }
        if in_model {
            if trimmed.starts_with("default:") {
                model_name = trimmed
                    .strip_prefix("default:")
                    .unwrap()
                    .trim()
                    .trim_matches('"')
                    .to_string();
            } else if trimmed.starts_with("base_url:") {
                base_url_from_yaml = trimmed
                    .strip_prefix("base_url:")
                    .unwrap()
                    .trim()
                    .trim_matches('"')
                    .to_string();
            } else if trimmed.starts_with("provider:") {
                provider_from_yaml = trimmed
                    .strip_prefix("provider:")
                    .unwrap()
                    .trim()
                    .trim_matches('"')
                    .to_string();
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with('-')
            {
                in_model = false;
            }
        }
    }

    // 读取 .env 到 key→value map
    let env_raw = std::fs::read_to_string(&env_path).unwrap_or_default();
    let env_map: std::collections::HashMap<String, String> = env_raw
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            t.split_once('=')
                .map(|(k, v)| (k.trim().to_string(), v.to_string()))
        })
        .collect();

    // 推断 provider：优先 config.yaml.model.provider，其次从 .env 反查
    let provider_id: String = if !provider_from_yaml.is_empty() {
        provider_from_yaml.clone()
    } else {
        let keys_refs: Vec<&str> = env_map.keys().map(|s| s.as_str()).collect();
        hermes_providers::infer_provider_from_env_keys(&keys_refs)
            .map(String::from)
            .unwrap_or_default()
    };

    // 按 provider 的 api_key_env_vars 顺序拿 api_key
    let api_key: String = hermes_providers::get_provider(&provider_id)
        .and_then(|p| {
            p.api_key_env_vars
                .iter()
                .find_map(|ev| env_map.get(*ev).cloned())
        })
        .unwrap_or_default();

    // 有效 base_url：优先 config.yaml.model.base_url，其次 provider 的 base_url_env_var
    let effective_base_url: String = if !base_url_from_yaml.is_empty() {
        base_url_from_yaml.clone()
    } else {
        hermes_providers::get_provider(&provider_id)
            .and_then(|p| {
                if p.base_url_env_var.is_empty() {
                    None
                } else {
                    env_map.get(p.base_url_env_var).cloned()
                }
            })
            .unwrap_or_default()
    };

    // UI 显示用短名（去掉 provider/ 前缀），如 openai/QC-S05 → QC-S05
    let display_model = if let Some(pos) = model_name.find('/') {
        model_name[pos + 1..].to_string()
    } else {
        model_name.clone()
    };

    Ok(serde_json::json!({
        "model": display_model,
        "model_raw": model_name,
        "base_url": effective_base_url,
        "provider": provider_id,
        "api_key": api_key,
        "config_exists": config_path.exists(),
    }))
}

// ---------------------------------------------------------------------------
// hermes_fetch_models — 从 API 获取模型列表（后端代理，避免 CORS）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_fetch_models(
    base_url: String,
    api_key: String,
    api_type: Option<String>,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    use super::hermes_providers;

    // 如果显式指定了 provider，优先走注册表决定 probe 方式 + fallback
    if let Some(pid) = provider.as_ref() {
        if let Some(pcfg) = hermes_providers::get_provider(pid) {
            // OAuth / external_process / copilot → 不能用 api_key 探测，
            // 直接返回静态 catalog
            if pcfg.models_probe == hermes_providers::PROBE_NONE {
                let mut models: Vec<String> = pcfg.models.iter().map(|s| s.to_string()).collect();
                models.sort();
                return Ok(models);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // api_type 优先级：调用方 api_type > provider.transport 推断 > 默认 openai
    let api = api_type.unwrap_or_else(|| {
        provider
            .as_ref()
            .and_then(|pid| hermes_providers::get_provider(pid))
            .map(|p| match p.transport {
                hermes_providers::TRANSPORT_ANTHROPIC => "anthropic-messages".to_string(),
                hermes_providers::TRANSPORT_GOOGLE => "google-generative-ai".to_string(),
                _ => "openai".to_string(),
            })
            .unwrap_or_else(|| "openai".into())
    });

    let mut base = base_url.trim_end_matches('/').to_string();
    // 移除尾部的 chat/completions 等路径
    for suffix in &[
        "/chat/completions",
        "/completions",
        "/responses",
        "/messages",
        "/models",
    ] {
        if base.ends_with(suffix) {
            base = base[..base.len() - suffix.len()].to_string();
        }
    }

    let resp = match api.as_str() {
        "anthropic-messages" => {
            if !base.ends_with("/v1") {
                base.push_str("/v1");
            }
            client
                .get(format!("{base}/models"))
                .header("anthropic-version", "2023-06-01")
                .header("x-api-key", &api_key)
                .send()
                .await
        }
        "google-generative-ai" | "google-gemini" => {
            client
                .get(format!("{base}/models?key={api_key}"))
                .send()
                .await
        }
        _ => {
            client
                .get(format!("{base}/models"))
                .header("Authorization", format!("Bearer {api_key}"))
                .send()
                .await
        }
    }
    .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let short = if body.len() > 200 {
            &body[..200]
        } else {
            &body
        };
        return Err(format!("HTTP {status}: {short}"));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON 解析失败: {e}"))?;

    let models: Vec<String> = if api.contains("google") {
        data.get("models")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        m.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.replace("models/", ""))
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        data.get("data")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut sorted = models;
    sorted.sort();
    Ok(sorted)
}

// ---------------------------------------------------------------------------
// hermes_update_model — 快速切换模型（只改 config.yaml 的 model.default）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_update_model(
    model: String,
    provider: Option<String>,
) -> Result<String, String> {
    use super::hermes_providers;

    let home = hermes_home();
    let config_path = home.join("config.yaml");
    let config_raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取 config.yaml 失败: {e}"))?;

    let model_str = model.clone();

    // Provider 决定策略：
    //   1. 调用方显式提供 → 直接使用
    //   2. 从静态 catalog 反查唯一匹配 → 使用反查结果
    //   3. 找不到 / 模糊 → 保持现有 provider（不改）
    let resolved_provider: Option<String> =
        provider.or_else(|| hermes_providers::find_provider_by_model(&model).map(String::from));

    // 一次性扫描并替换 model 区块中的 default / provider 字段。
    let lines: Vec<&str> = config_raw.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut in_model = false;
    let mut default_written = false;
    let mut provider_written = false;
    let mut default_indent: String = "  ".into();

    for line in lines.iter() {
        let trimmed = line.trim();
        if trimmed.starts_with("model:") {
            in_model = true;
            out.push(line.to_string());
            continue;
        }
        if in_model {
            let is_indented = line.starts_with("  ") || line.starts_with('\t');
            if !is_indented && !trimmed.is_empty() && !trimmed.starts_with('#') {
                // 离开 model 区块 —— 先补齐未写入的 provider 行
                if let Some(pid) = resolved_provider.as_ref() {
                    if !provider_written && !pid.is_empty() && pid != "custom" {
                        out.push(format!("{default_indent}provider: {pid}"));
                        provider_written = true;
                    }
                }
                in_model = false;
                out.push(line.to_string());
                continue;
            }

            if trimmed.starts_with("default:") {
                let indent_len = line.len() - line.trim_start().len();
                default_indent = " ".repeat(indent_len);
                out.push(format!("{default_indent}default: {model_str}"));
                default_written = true;
                continue;
            }
            if trimmed.starts_with("provider:") {
                if let Some(pid) = resolved_provider.as_ref() {
                    if !pid.is_empty() && pid != "custom" {
                        let indent_len = line.len() - line.trim_start().len();
                        let indent = " ".repeat(indent_len);
                        out.push(format!("{indent}provider: {pid}"));
                        provider_written = true;
                        continue;
                    }
                    // custom → 删除 provider 行
                    continue;
                }
                // 未提供新 provider，保留旧值
                out.push(line.to_string());
                provider_written = true;
                continue;
            }
        }
        out.push(line.to_string());
    }

    // 文件末尾还在 model 块里：补 provider 行
    if in_model {
        if let Some(pid) = resolved_provider.as_ref() {
            if !provider_written && !pid.is_empty() && pid != "custom" {
                out.push(format!("{default_indent}provider: {pid}"));
            }
        }
    }

    if !default_written {
        return Err("config.yaml 中未找到 model.default 字段".into());
    }

    let mut new_content = out.join("\n");
    if !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    std::fs::write(&config_path, new_content).map_err(|e| format!("写入 config.yaml 失败: {e}"))?;
    Ok(format!("模型已切换为 {model_str}"))
}

// ---------------------------------------------------------------------------
// hermes_gateway_action — Gateway 管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_gateway_action(
    app: tauri::AppHandle,
    action: String,
) -> Result<String, String> {
    let enhanced = hermes_enhanced_path();
    match action.as_str() {
        "start" => {
            #[cfg(target_os = "windows")]
            {
                let home = hermes_home();
                let port = hermes_gateway_port();
                let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

                // 1. 如果端口已经可达，说明 Gateway 已在运行
                if std::net::TcpStream::connect_timeout(
                    &addr,
                    std::time::Duration::from_millis(300),
                )
                .is_ok()
                {
                    // 即使已在运行也启动 Guardian 守护
                    start_guardian(&app);
                    emit_gateway_status(true);
                    return Ok("Gateway 已在运行".into());
                }

                // 2. 先精准杀掉之前我们 spawn 的进程
                kill_gateway_pid();
                // 如果仍有残留（非我们启动的），再 taskkill
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if std::net::TcpStream::connect_timeout(
                    &addr,
                    std::time::Duration::from_millis(200),
                )
                .is_ok()
                {
                    // 端口仍被占用，有残留进程
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/IM", "hermes.exe"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }

                // 3. 清理过期 PID 文件（绕过 Hermes Windows bug）
                let pid_file = home.join("gateway.pid");
                if pid_file.exists() {
                    let _ = std::fs::remove_file(&pid_file);
                }

                // 4. 启动 Gateway 进程
                let log_path = home.join("gateway-run.log");
                let log_file = std::fs::File::create(&log_path)
                    .map_err(|e| format!("创建日志文件失败: {e}"))?;
                let log_err = log_file
                    .try_clone()
                    .map_err(|e| format!("克隆日志句柄失败: {e}"))?;

                let mut cmd = std::process::Command::new("hermes");
                cmd.args(["gateway", "run"])
                    .current_dir(&home)
                    .env("PATH", &enhanced)
                    .stdin(std::process::Stdio::null())
                    .stdout(log_file)
                    .stderr(log_err)
                    .creation_flags(CREATE_NO_WINDOW);
                // 注入 .env 环境变量
                let env_path = home.join(".env");
                if let Ok(env_content) = std::fs::read_to_string(&env_path) {
                    for line in env_content.lines() {
                        let line = line.trim();
                        if line.is_empty() || line.starts_with('#') {
                            continue;
                        }
                        if let Some((key, val)) = line.split_once('=') {
                            cmd.env(key.trim(), val.trim());
                        }
                    }
                }
                match cmd.spawn() {
                    Ok(child) => {
                        // 记录 PID 供后续精准 kill
                        GW_PID.store(child.id(), Ordering::SeqCst);

                        // 5. 等待 Gateway 端口可达（最多 20s）
                        let mut ok = false;
                        for i in 0..40 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if std::net::TcpStream::connect_timeout(
                                &addr,
                                std::time::Duration::from_millis(500),
                            )
                            .is_ok()
                            {
                                ok = true;
                                break;
                            }
                            // 前 3 秒每次都检查，之后检查日志是否有错误
                            if i > 6 {
                                if let Ok(log) = std::fs::read_to_string(&log_path) {
                                    if log.contains("failed to connect")
                                        || log.contains("Port") && log.contains("already in use")
                                    {
                                        break; // 进程已报错，不再等待
                                    }
                                }
                            }
                        }
                        if ok {
                            // 启动 Guardian 后台守护
                            start_guardian(&app);
                            emit_gateway_status(true);
                            Ok("Gateway 已启动".into())
                        } else {
                            let log_tail = std::fs::read_to_string(&log_path).unwrap_or_default();
                            let tail: String = log_tail
                                .lines()
                                .rev()
                                .take(20)
                                .collect::<Vec<_>>()
                                .into_iter()
                                .rev()
                                .collect::<Vec<_>>()
                                .join("\n");
                            Err(format!(
                                "Gateway 启动失败。\n日志:\n{}",
                                if tail.is_empty() {
                                    "(日志为空)".to_string()
                                } else {
                                    tail
                                }
                            ))
                        }
                    }
                    Err(e) => Err(format!("启动 hermes gateway run 失败: {e}")),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let home = hermes_home();
                // 先精准杀掉之前我们 spawn 的进程
                kill_gateway_pid();

                let mut cmd = std::process::Command::new("hermes");
                cmd.args(["gateway", "run"])
                    .current_dir(&home)
                    .env("PATH", &enhanced)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());

                // 注入 .env 环境变量
                let env_path = home.join(".env");
                if let Ok(env_content) = std::fs::read_to_string(&env_path) {
                    for line in env_content.lines() {
                        let line = line.trim();
                        if line.is_empty() || line.starts_with('#') {
                            continue;
                        }
                        if let Some((key, val)) = line.split_once('=') {
                            cmd.env(key.trim(), val.trim());
                        }
                    }
                }

                match cmd.spawn() {
                    Ok(child) => {
                        GW_PID.store(child.id(), Ordering::SeqCst);
                        // 等待端口可达（最多 15s）
                        let port = hermes_gateway_port();
                        let addr: std::net::SocketAddr =
                            format!("127.0.0.1:{port}").parse().unwrap();
                        let mut ok = false;
                        for _ in 0..30 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if std::net::TcpStream::connect_timeout(
                                &addr,
                                std::time::Duration::from_millis(500),
                            )
                            .is_ok()
                            {
                                ok = true;
                                break;
                            }
                        }
                        if ok {
                            start_guardian(&app);
                            emit_gateway_status(true);
                            Ok("Gateway 已启动".into())
                        } else {
                            Err("Gateway 启动后端口未就绪".into())
                        }
                    }
                    Err(e) => {
                        // fallback: hermes gateway start
                        let mut fallback = tokio::process::Command::new("hermes");
                        fallback.args(["gateway", "start"]).env("PATH", &enhanced);
                        let out = fallback
                            .output()
                            .await
                            .map_err(|e2| format!("启动失败: {e} / fallback: {e2}"))?;
                        if out.status.success() {
                            start_guardian(&app);
                            emit_gateway_status(true);
                            Ok("Gateway 已启动".into())
                        } else {
                            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                            Err(if stderr.is_empty() {
                                format!(
                                    "Gateway 启动失败 (exit {})",
                                    out.status.code().unwrap_or(-1)
                                )
                            } else {
                                stderr
                            })
                        }
                    }
                }
            }
        }
        "stop" => {
            // 停止 Guardian 守护
            stop_guardian();

            // 1. 先精准杀掉我们 spawn 的进程
            let killed = kill_gateway_pid();

            // 2. 尝试 hermes gateway stop（作为补充）
            let mut cmd = tokio::process::Command::new("hermes");
            cmd.args(["gateway", "stop"]).env("PATH", &enhanced);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let stop_result = cmd.output().await;

            // 3. 如果以上都没成功，Windows 上 taskkill 兜底
            #[cfg(target_os = "windows")]
            if !killed {
                let port = hermes_gateway_port();
                let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if std::net::TcpStream::connect_timeout(
                    &addr,
                    std::time::Duration::from_millis(300),
                )
                .is_ok()
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/IM", "hermes.exe"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
            }

            emit_gateway_status(false);

            match stop_result {
                Ok(out) if out.status.success() || killed => Ok("Gateway 已停止".into()),
                Ok(_) if killed => Ok("Gateway 已停止".into()),
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if stderr.is_empty() {
                        Ok("Gateway 已停止".into())
                    } else {
                        Err(stderr)
                    }
                }
                Err(_) if killed => Ok("Gateway 已停止".into()),
                Err(e) => Err(format!("停止失败: {e}")),
            }
        }
        "status" => {
            let mut cmd = tokio::process::Command::new("hermes");
            cmd.args(["gateway", "status"]).env("PATH", &enhanced);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let out = cmd.output().await.map_err(|e| format!("查询失败: {e}"))?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(stdout)
        }
        "install" => {
            let mut cmd = tokio::process::Command::new("hermes");
            cmd.args(["gateway", "install"]).env("PATH", &enhanced);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let out = cmd.output().await.map_err(|e| format!("安装失败: {e}"))?;
            if out.status.success() {
                Ok("Gateway 服务已安装".into())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        "uninstall" => {
            let mut cmd = tokio::process::Command::new("hermes");
            cmd.args(["gateway", "uninstall"]).env("PATH", &enhanced);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let out = cmd.output().await.map_err(|e| format!("卸载失败: {e}"))?;
            if out.status.success() {
                Ok("Gateway 服务已卸载".into())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        _ => Err(format!("不支持的操作: {action}")),
    }
}

// ---------------------------------------------------------------------------
// hermes_health_check — Gateway 健康检查
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_health_check() -> Result<Value, String> {
    let url = format!("{}/health", hermes_gateway_url());

    let client = super::build_http_client(std::time::Duration::from_secs(5), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            Ok(body)
        }
        Ok(resp) => Err(format!("Gateway 返回 HTTP {}", resp.status())),
        Err(e) => Err(format!("Gateway 不可达: {e}")),
    }
}

// ---------------------------------------------------------------------------
// hermes_detect_environments — 检测 WSL2 / Docker 中的 Hermes Agent
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_detect_environments() -> Result<Value, String> {
    let mut result = serde_json::json!({
        "wsl2": { "available": false },
        "docker": { "available": false },
    });

    // --- WSL2 检测（仅 Windows）---
    #[cfg(target_os = "windows")]
    {
        // 1. 检测 WSL 是否安装
        let wsl_check = std::process::Command::new("wsl")
            .args(["--list", "--quiet"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = wsl_check {
            if out.status.success() {
                let distros_raw = String::from_utf8_lossy(&out.stdout);
                let distros: Vec<String> = distros_raw
                    .lines()
                    .map(|l| l.trim().replace('\0', "").trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();

                if !distros.is_empty() {
                    result["wsl2"]["available"] = serde_json::json!(true);
                    result["wsl2"]["distros"] = serde_json::json!(distros);

                    // 2. 获取默认 WSL2 IP
                    let ip_cmd = std::process::Command::new("wsl")
                        .args(["-e", "hostname", "-I"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    if let Ok(ip_out) = ip_cmd {
                        if ip_out.status.success() {
                            let ip_str = String::from_utf8_lossy(&ip_out.stdout);
                            let ip = ip_str.split_whitespace().next().unwrap_or("").to_string();
                            if !ip.is_empty() {
                                result["wsl2"]["ip"] = serde_json::json!(ip);
                            }
                        }
                    }

                    // 3. 检测 WSL 里是否安装了 hermes
                    let hermes_check = std::process::Command::new("wsl")
                        .args([
                            "-e",
                            "bash",
                            "-lc",
                            "command -v hermes && hermes --version 2>/dev/null || echo NOT_FOUND",
                        ])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    if let Ok(h_out) = hermes_check {
                        let h_str = String::from_utf8_lossy(&h_out.stdout).trim().to_string();
                        if !h_str.contains("NOT_FOUND") && !h_str.is_empty() {
                            result["wsl2"]["hermesInstalled"] = serde_json::json!(true);
                            result["wsl2"]["hermesInfo"] = serde_json::json!(h_str);
                        }
                    }

                    // 4. 探测 WSL 中 Gateway 是否正在运行
                    let wsl_ip = result["wsl2"]["ip"].as_str().map(String::from);
                    if let Some(ip) = wsl_ip {
                        let port = hermes_gateway_port();
                        let addr_str = format!("{ip}:{port}");
                        if let Ok(addr) = addr_str.parse::<std::net::SocketAddr>() {
                            let reachable = std::net::TcpStream::connect_timeout(
                                &addr,
                                std::time::Duration::from_millis(500),
                            )
                            .is_ok();
                            result["wsl2"]["gatewayRunning"] = serde_json::json!(reachable);
                            if reachable {
                                result["wsl2"]["gatewayUrl"] =
                                    serde_json::json!(format!("http://{ip}:{port}"));
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Docker 检测（所有平台）---
    {
        let docker_check = {
            let mut cmd = std::process::Command::new("docker");
            cmd.args(["info", "--format", "{{.ServerVersion}}"]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.output()
        };

        if let Ok(out) = docker_check {
            if out.status.success() {
                let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
                result["docker"]["available"] = serde_json::json!(true);
                result["docker"]["version"] = serde_json::json!(version);

                // 查找运行中的 hermes 相关容器
                let ps_cmd = {
                    let mut cmd = std::process::Command::new("docker");
                    cmd.args([
                        "ps",
                        "--format",
                        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}",
                        "--filter",
                        "status=running",
                    ]);
                    #[cfg(target_os = "windows")]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    cmd.output()
                };

                if let Ok(ps_out) = ps_cmd {
                    let ps_str = String::from_utf8_lossy(&ps_out.stdout);
                    let containers: Vec<Value> = ps_str
                        .lines()
                        .filter(|l| {
                            let lower = l.to_lowercase();
                            lower.contains("hermes") || lower.contains("8642")
                        })
                        .map(|l| {
                            let parts: Vec<&str> = l.split('\t').collect();
                            serde_json::json!({
                                "id": parts.first().unwrap_or(&""),
                                "name": parts.get(1).unwrap_or(&""),
                                "image": parts.get(2).unwrap_or(&""),
                                "ports": parts.get(3).unwrap_or(&""),
                                "status": parts.get(4).unwrap_or(&""),
                            })
                        })
                        .collect();

                    if !containers.is_empty() {
                        result["docker"]["hermesContainers"] = serde_json::json!(containers);
                    }
                }
            }
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// hermes_set_gateway_url — 设置自定义 Gateway URL（用于远程/WSL2/Docker）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_set_gateway_url(url: Option<String>) -> Result<String, String> {
    let config_paths = super::panel_config_candidate_paths();
    let config_path = config_paths.first().ok_or("找不到配置文件路径")?;

    let mut config = if config_path.exists() {
        let content =
            std::fs::read_to_string(config_path).map_err(|e| format!("读取配置失败: {e}"))?;
        serde_json::from_str::<Value>(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // 确保 hermes 对象存在
    if !config.get("hermes").is_some_and(|v| v.is_object()) {
        config["hermes"] = serde_json::json!({});
    }

    match &url {
        Some(u) if !u.trim().is_empty() => {
            config["hermes"]["gatewayUrl"] = serde_json::json!(u.trim());
        }
        _ => {
            // 清除自定义 URL，回退到本地
            if let Some(obj) = config["hermes"].as_object_mut() {
                obj.remove("gatewayUrl");
            }
        }
    }

    let json_str = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(config_path, json_str).map_err(|e| format!("写入配置失败: {e}"))?;

    let current_url = hermes_gateway_url();
    Ok(format!("Gateway URL 已设置: {current_url}"))
}

// ---------------------------------------------------------------------------
// update_hermes — 升级
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn update_hermes(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit("hermes-install-log", "📦 升级 Hermes Agent...");

    let uv_path = uv_bin_path();
    let uv = if uv_path.exists() {
        uv_path.to_string_lossy().to_string()
    } else {
        "uv".into()
    };

    // hermes-agent 从 GitHub 安装，upgrade 不可用，改用 reinstall
    let pkg = format!("hermes-agent @ {}", HERMES_GIT_URL);
    let mut cmd = tokio::process::Command::new(&uv);
    cmd.args(["tool", "install", "--reinstall", &pkg, "--python", "3.11"]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(mirror) = pypi_mirror_url() {
        cmd.args(["--index-url", &mirror]);
    }
    super::apply_proxy_env_tokio(&mut cmd);
    cmd.env("PATH", hermes_enhanced_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|e| format!("升级失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            let _ = app.emit("hermes-install-log", line.trim());
        }
    }

    if output.status.success() {
        let _ = app.emit("hermes-install-log", "✅ 升级完成");
        Ok("升级完成".into())
    } else {
        Err(format!("升级失败: {}", stderr.trim()))
    }
}

// ---------------------------------------------------------------------------
// uninstall_hermes — 卸载
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn uninstall_hermes(clean_config: bool) -> Result<String, String> {
    let uv_path = uv_bin_path();
    let uv = if uv_path.exists() {
        uv_path.to_string_lossy().to_string()
    } else {
        "uv".into()
    };

    // uv tool uninstall
    let mut cmd = tokio::process::Command::new(&uv);
    cmd.args(["tool", "uninstall", "hermes-agent"]);
    cmd.env("PATH", hermes_enhanced_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|e| format!("卸载失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("卸载失败: {}", stderr.trim()));
    }

    // 清理 venv（如果存在）
    let venv_dir = dirs::home_dir().unwrap_or_default().join(".hermes-venv");
    if venv_dir.exists() {
        let _ = std::fs::remove_dir_all(&venv_dir);
    }

    // 可选：清理配置
    if clean_config {
        let home = hermes_home();
        if home.exists() {
            let _ = std::fs::remove_dir_all(&home);
        }
    }

    Ok("Hermes Agent 已卸载".into())
}

// ---------------------------------------------------------------------------
// hermes_api_proxy — 代理前端对 Gateway REST API 的请求（绕过 CORS）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_api_proxy(
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}{path}", hermes_gateway_url());

    // 读取 API_SERVER_KEY
    let api_key = {
        let env_path = hermes_home().join(".env");
        let mut key = String::new();
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("API_SERVER_KEY=") {
                    key = val.trim().to_string();
                    break;
                }
            }
        }
        key
    };

    let timeout = if path.contains("/chat/completions") || path.contains("/responses") {
        std::time::Duration::from_secs(120)
    } else {
        std::time::Duration::from_secs(30)
    };
    let client = super::build_http_client(timeout, Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => {
            let mut r = client.post(&url);
            if let Some(b) = &body {
                r = r.header("Content-Type", "application/json").body(b.clone());
            }
            r
        }
        "PATCH" => {
            let mut r = client.patch(&url);
            if let Some(b) = &body {
                r = r.header("Content-Type", "application/json").body(b.clone());
            }
            r
        }
        "PUT" => {
            let mut r = client.put(&url);
            if let Some(b) = &body {
                r = r.header("Content-Type", "application/json").body(b.clone());
            }
            r
        }
        "DELETE" => {
            let mut r = client.delete(&url);
            if let Some(b) = &body {
                r = r.header("Content-Type", "application/json").body(b.clone());
            }
            r
        }
        _ => return Err(format!("不支持的方法: {method}")),
    };

    // 注入 API_SERVER_KEY 认证
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    // 注入自定义 headers（如 X-Hermes-Session-Id）
    if let Some(Value::Object(map)) = &headers {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                req = req.header(k.as_str(), s);
            }
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Gateway 请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    // 尝试解析为 JSON，否则包装为字符串
    let json_val: Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));

    if status >= 400 {
        // 提取错误信息：支持 {"error": "msg"} 和 {"error": {"message": "msg"}} 两种格式
        let err_msg = json_val
            .get("error")
            .and_then(|v| {
                v.as_str()
                    .map(String::from)
                    .or_else(|| v.get("message").and_then(|m| m.as_str()).map(String::from))
            })
            .unwrap_or_else(|| text.clone());
        return Err(err_msg);
    }

    Ok(json_val)
}

// ---------------------------------------------------------------------------
// hermes_agent_run — 通过 /v1/runs + SSE 事件流驱动 Agent（工具调用可见）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_agent_run(
    app: tauri::AppHandle,
    input: String,
    session_id: Option<String>,
    conversation_history: Option<Value>,
    instructions: Option<String>,
) -> Result<String, String> {
    let gw_url = hermes_gateway_url();
    let runs_url = format!("{gw_url}/v1/runs");

    // 读取 API_SERVER_KEY
    let home = hermes_home();
    let api_key = {
        let env_path = home.join(".env");
        let mut key = String::new();
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("API_SERVER_KEY=") {
                    key = val.trim().to_string();
                    break;
                }
            }
        }
        key
    };

    let mut payload = serde_json::json!({ "input": input });
    if let Some(sid) = &session_id {
        payload["session_id"] = Value::String(sid.clone());
    }
    if let Some(hist) = &conversation_history {
        payload["conversation_history"] = hist.clone();
    }
    if let Some(inst) = &instructions {
        payload["instructions"] = Value::String(inst.clone());
    }

    let client = super::build_http_client(std::time::Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    // 1. POST /v1/runs → 获取 run_id
    let mut req = client
        .post(&runs_url)
        .header("Content-Type", "application/json")
        .body(payload.to_string());
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("启动 run 失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    let run_id = body["run_id"]
        .as_str()
        .ok_or("响应中没有 run_id")?
        .to_string();

    let _ = app.emit(
        "hermes-run-started",
        serde_json::json!({ "run_id": &run_id }),
    );

    // 2. GET /v1/runs/{run_id}/events — SSE 事件流
    let events_url = format!("{gw_url}/v1/runs/{run_id}/events");
    let sse_client =
        super::build_http_client(std::time::Duration::from_secs(300), Some("ClawPanel"))
            .map_err(|e| format!("SSE 客户端创建失败: {e}"))?;

    let mut sse_req = sse_client.get(&events_url);
    if !api_key.is_empty() {
        sse_req = sse_req.header("Authorization", format!("Bearer {api_key}"));
    }

    let sse_resp = sse_req
        .send()
        .await
        .map_err(|e| format!("SSE 连接失败: {e}"))?;

    if !sse_resp.status().is_success() {
        let status = sse_resp.status().as_u16();
        let text = sse_resp.text().await.unwrap_or_default();
        return Err(format!("SSE HTTP {status}: {text}"));
    }

    // 流式读取 SSE 事件并转发到前端
    use futures_util::StreamExt;
    let mut stream = sse_resp.bytes_stream();
    let mut buffer = String::new();
    let mut final_output = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("SSE 读取失败: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            let trimmed = line.trim();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            let data = trimmed[6..].trim();
            if data == "[DONE]" {
                let _ = app.emit(
                    "hermes-run-done",
                    serde_json::json!({
                        "run_id": &run_id,
                        "output": &final_output,
                    }),
                );
                return Ok(run_id);
            }

            if let Ok(evt) = serde_json::from_str::<Value>(data) {
                let event_type = evt["event"].as_str().unwrap_or("");
                match event_type {
                    "message.delta" => {
                        if let Some(delta) = evt["delta"].as_str() {
                            final_output.push_str(delta);
                            let _ = app.emit(
                                "hermes-run-delta",
                                serde_json::json!({
                                    "run_id": &run_id,
                                    "delta": delta,
                                }),
                            );
                        }
                    }
                    "tool.started" | "tool.completed" | "tool.progress" | "tool.error" => {
                        let _ = app.emit("hermes-run-tool", evt.clone());
                    }
                    "reasoning.available" => {
                        let _ = app.emit("hermes-run-reasoning", evt.clone());
                    }
                    "run.completed" => {
                        if let Some(output) = evt["output"].as_str() {
                            final_output = output.to_string();
                        }
                        let _ = app.emit(
                            "hermes-run-done",
                            serde_json::json!({
                                "run_id": &run_id,
                                "output": &final_output,
                            }),
                        );
                        return Ok(run_id);
                    }
                    "run.failed" => {
                        let err = evt["error"].as_str().unwrap_or("unknown error");
                        let _ = app.emit(
                            "hermes-run-error",
                            serde_json::json!({
                                "run_id": &run_id,
                                "error": err,
                            }),
                        );
                        return Err(format!("Agent run failed: {err}"));
                    }
                    _ => {
                        // 其他事件类型也转发
                        let _ = app.emit("hermes-run-event", evt.clone());
                    }
                }
            }
        }
    }

    let _ = app.emit(
        "hermes-run-done",
        serde_json::json!({
            "run_id": &run_id,
            "output": &final_output,
        }),
    );
    Ok(run_id)
}

// ---------------------------------------------------------------------------
// Hermes Sessions / Logs / Skills / Memory — 文件系统 + CLI 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_sessions_list(
    source: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let mut args = vec!["sessions", "export", "-"];
    let source_owned;
    if let Some(s) = &source {
        source_owned = s.clone();
        args.push("--source");
        args.push(&source_owned);
    }
    let output = match run_silent("hermes", &args) {
        Ok(s) => s,
        Err(_) => return Ok(serde_json::json!([])),
    };
    let mut sessions: Vec<Value> = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(obj) = serde_json::from_str::<Value>(t) {
            sessions.push(serde_json::json!({
                "id": obj.get("session_id").or(obj.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
                "title": obj.get("title").or(obj.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                "source": obj.get("source").and_then(|v| v.as_str()).unwrap_or(""),
                "model": obj.get("model").and_then(|v| v.as_str()).unwrap_or(""),
                "created_at": obj.get("created_at").or(obj.get("createdAt")).and_then(|v| v.as_str()).unwrap_or(""),
                "updated_at": obj.get("updated_at").or(obj.get("updatedAt")).and_then(|v| v.as_str()).unwrap_or(""),
                "message_count": obj.get("message_count").and_then(|v| v.as_u64()).unwrap_or(0),
            }));
        }
    }
    sessions.sort_by(|a, b| {
        let ca = a["created_at"].as_str().unwrap_or("");
        let cb = b["created_at"].as_str().unwrap_or("");
        cb.cmp(ca)
    });
    if let Some(lim) = limit {
        if lim > 0 {
            sessions.truncate(lim);
        }
    }
    Ok(Value::Array(sessions))
}

#[tauri::command]
pub async fn hermes_session_detail(session_id: String) -> Result<Value, String> {
    let output = run_silent("hermes", &["sessions", "export", "-"])
        .map_err(|e| format!("Failed to read sessions: {e}"))?;
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(obj) = serde_json::from_str::<Value>(t) {
            let id = obj
                .get("session_id")
                .or(obj.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if id == session_id {
                let messages = obj
                    .get("messages")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .map(|m| {
                                serde_json::json!({
                                    "role": m.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                                    "content": m.get("content").map(|c| {
                                        if let Some(s) = c.as_str() { s.to_string() }
                                        else { c.to_string() }
                                    }).unwrap_or_default(),
                                    "timestamp": m.get("timestamp").or(m.get("created_at")).and_then(|v| v.as_str()).unwrap_or(""),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                return Ok(serde_json::json!({
                    "id": id,
                    "title": obj.get("title").or(obj.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                    "source": obj.get("source").and_then(|v| v.as_str()).unwrap_or(""),
                    "model": obj.get("model").and_then(|v| v.as_str()).unwrap_or(""),
                    "created_at": obj.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                    "messages": messages,
                }));
            }
        }
    }
    Err("Session not found".into())
}

#[tauri::command]
pub async fn hermes_session_delete(session_id: String) -> Result<String, String> {
    run_silent("hermes", &["sessions", "delete", &session_id, "--yes"])?;
    Ok("ok".into())
}

#[tauri::command]
pub async fn hermes_session_rename(session_id: String, title: String) -> Result<String, String> {
    run_silent("hermes", &["sessions", "rename", &session_id, &title])?;
    Ok("ok".into())
}

#[tauri::command]
pub async fn hermes_logs_list() -> Result<Value, String> {
    let logs_dir = hermes_home().join("logs");
    if !logs_dir.exists() {
        return Ok(serde_json::json!([]));
    }
    let mut files: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&logs_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".log") && !name.ends_with(".txt") && !name.ends_with(".jsonl") {
                continue;
            }
            let (size, modified) = if let Ok(meta) = entry.metadata() {
                let sz = meta.len();
                let mt = meta
                    .modified()
                    .ok()
                    .and_then(|t| {
                        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| {
                            let secs = d.as_secs() as i64;
                            // Simple ISO-ish format
                            chrono_simple(secs)
                        })
                    })
                    .unwrap_or_default();
                (sz, mt)
            } else {
                (0, String::new())
            };
            files.push(serde_json::json!({
                "name": name,
                "size": size,
                "modified": modified,
            }));
        }
    }
    files.sort_by(|a, b| {
        let ma = a["modified"].as_str().unwrap_or("");
        let mb = b["modified"].as_str().unwrap_or("");
        mb.cmp(ma)
    });
    Ok(Value::Array(files))
}

/// Simple timestamp formatter (no chrono crate dependency)
fn chrono_simple(epoch_secs: i64) -> String {
    // Use system time formatting via std
    let d = std::time::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs as u64);
    // Format as ISO string via debug (rough but functional)
    format!("{d:?}")
}

#[tauri::command]
pub async fn hermes_logs_read(
    name: String,
    lines: Option<usize>,
    level: Option<String>,
) -> Result<Value, String> {
    let max_lines = lines.unwrap_or(200);
    let log_path = hermes_home().join("logs").join(&name);
    if !log_path.exists() {
        return Err(format!("Log file not found: {name}"));
    }
    // Security: ensure path is within logs dir
    let logs_dir = hermes_home().join("logs");
    let canonical = log_path
        .canonicalize()
        .map_err(|e| format!("Path error: {e}"))?;
    let canonical_dir = logs_dir
        .canonicalize()
        .map_err(|e| format!("Path error: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("Access denied".into());
    }

    let content =
        std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read log: {e}"))?;
    let all_lines: Vec<&str> = content.lines().collect();
    let start = if all_lines.len() > max_lines {
        all_lines.len() - max_lines
    } else {
        0
    };
    let tail = &all_lines[start..];

    let level_upper = level.as_deref().unwrap_or("").to_uppercase();
    let mut entries: Vec<Value> = Vec::new();
    // Regex-like manual parsing: "TIMESTAMP LEVEL MESSAGE"
    for line in tail {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // Try to parse structured log: "2024-01-01 12:00:00 INFO message..."
        let parsed = parse_log_line(t);
        if !level_upper.is_empty() && level_upper != "ALL" {
            if let Some(ref lvl) = parsed.level {
                if lvl.to_uppercase() != level_upper {
                    continue;
                }
            } else {
                continue; // skip raw lines when filtering by level
            }
        }
        entries.push(match (parsed.timestamp, parsed.level, parsed.message) {
            (Some(ts), Some(lvl), Some(msg)) => serde_json::json!({
                "timestamp": ts,
                "level": lvl,
                "message": msg,
                "raw": t,
            }),
            _ => serde_json::json!({ "raw": t }),
        });
    }
    Ok(Value::Array(entries))
}

struct ParsedLogLine {
    timestamp: Option<String>,
    level: Option<String>,
    message: Option<String>,
}

fn parse_log_line(line: &str) -> ParsedLogLine {
    // Pattern: "YYYY-MM-DD HH:MM:SS LEVEL rest..." or "HH:MM:SS LEVEL rest..."
    let parts: Vec<&str> = line.splitn(4, char::is_whitespace).collect();
    if parts.len() >= 3 {
        // Check if first two parts look like a timestamp
        let maybe_date = parts[0];
        let maybe_time = parts[1];
        if (maybe_date.len() == 10 && maybe_date.contains('-'))
            && (maybe_time.len() >= 8 && maybe_time.contains(':'))
        {
            let ts = format!("{maybe_date} {maybe_time}");
            let lvl = parts[2].to_string();
            let msg = if parts.len() > 3 {
                parts[3].to_string()
            } else {
                String::new()
            };
            return ParsedLogLine {
                timestamp: Some(ts),
                level: Some(lvl),
                message: Some(msg),
            };
        }
    }
    // Fallback: check if first part is time-like
    if parts.len() >= 2 && parts[0].contains(':') && parts[0].len() >= 8 {
        let ts = parts[0].to_string();
        let lvl = parts[1].to_string();
        let msg = parts[2..].join(" ");
        return ParsedLogLine {
            timestamp: Some(ts),
            level: Some(lvl),
            message: Some(msg),
        };
    }
    ParsedLogLine {
        timestamp: None,
        level: None,
        message: None,
    }
}

#[tauri::command]
pub async fn hermes_skills_list() -> Result<Value, String> {
    let skills_dir = hermes_home().join("skills");
    if !skills_dir.exists() {
        return Ok(serde_json::json!([]));
    }
    let mut categories: Vec<Value> = Vec::new();
    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("Failed to read skills dir: {e}"))?;
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            let cat_dir = skills_dir.join(&name);
            let mut skills: Vec<Value> = Vec::new();
            if let Ok(files) = std::fs::read_dir(&cat_dir) {
                for f in files.flatten() {
                    let fname = f.file_name().to_string_lossy().to_string();
                    if !fname.ends_with(".md") {
                        continue;
                    }
                    let fpath = cat_dir.join(&fname);
                    let content = std::fs::read_to_string(&fpath).unwrap_or_default();
                    let skill_name = content
                        .lines()
                        .find(|l| l.starts_with("# "))
                        .map(|l| l[2..].trim().to_string())
                        .unwrap_or_else(|| fname.trim_end_matches(".md").to_string());
                    let description = content
                        .lines()
                        .find(|l| {
                            !l.starts_with('#') && !l.trim().is_empty() && l.trim().len() > 10
                        })
                        .map(|l| {
                            let s = l.trim();
                            if s.len() > 200 {
                                format!("{}...", &s[..200])
                            } else {
                                s.to_string()
                            }
                        })
                        .unwrap_or_default();
                    skills.push(serde_json::json!({
                        "file": fname,
                        "name": skill_name,
                        "description": description,
                        "path": fpath.to_string_lossy(),
                    }));
                }
            }
            if !skills.is_empty() {
                categories.push(serde_json::json!({
                    "category": name,
                    "skills": skills,
                }));
            }
        } else if name.ends_with(".md") {
            let fpath = skills_dir.join(&name);
            let content = std::fs::read_to_string(&fpath).unwrap_or_default();
            let skill_name = content
                .lines()
                .find(|l| l.starts_with("# "))
                .map(|l| l[2..].trim().to_string())
                .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
            categories.push(serde_json::json!({
                "category": "_root",
                "skills": [{
                    "file": name,
                    "name": skill_name,
                    "description": "",
                    "path": fpath.to_string_lossy(),
                }],
            }));
        }
    }
    Ok(Value::Array(categories))
}

#[tauri::command]
pub async fn hermes_skill_detail(file_path: String) -> Result<String, String> {
    let skills_dir = hermes_home().join("skills");
    let resolved = PathBuf::from(&file_path);
    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("Path error: {e}"))?;
    let canonical_dir = skills_dir
        .canonicalize()
        .map_err(|e| format!("Path error: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("Access denied".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read skill: {e}"))
}

#[tauri::command]
pub async fn hermes_memory_read(r#type: Option<String>) -> Result<String, String> {
    let kind = r#type.as_deref().unwrap_or("memory");
    let file_name = if kind == "user" {
        "USER.md"
    } else {
        "MEMORY.md"
    };
    let file_path = hermes_home().join("memories").join(file_name);
    if !file_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read memory: {e}"))
}

#[tauri::command]
pub async fn hermes_memory_write(
    r#type: Option<String>,
    content: String,
) -> Result<String, String> {
    let kind = r#type.as_deref().unwrap_or("memory");
    let mem_dir = hermes_home().join("memories");
    std::fs::create_dir_all(&mem_dir).map_err(|e| format!("Failed to create dir: {e}"))?;
    let file_name = if kind == "user" {
        "USER.md"
    } else {
        "MEMORY.md"
    };
    let file_path = mem_dir.join(file_name);
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write memory: {e}"))?;
    Ok("ok".into())
}

// ============================================================================
// .env editor commands (Step 4 / G6)
//
// Users may need to set custom environment variables for Hermes (e.g.
// `TAVILY_API_KEY` for the tavily skill, `HTTP_PROXY`, etc.). These keys
// live in ~/.hermes/.env alongside the ClawPanel-managed provider keys.
//
// The three commands below:
//   * `hermes_env_read_unmanaged` — returns every key in .env that is NOT
//      managed by ClawPanel (i.e. not in `hermes_providers::all_managed_env_keys`)
//   * `hermes_env_set`            — writes or updates an unmanaged key
//   * `hermes_env_delete`         — removes an unmanaged key
//
// All three refuse to touch `all_managed_env_keys` to prevent users from
// accidentally clobbering provider keys from the editor UI (those should
// be configured via the setup page / configure_hermes).
// ============================================================================

/// Lenient .env parser shared by the three commands below.
/// Returns a Vec of (key, value, original_line_index) for every `KEY=VALUE`
/// pair. Comments and blanks are preserved by line index but not returned.
fn parse_env_file_lines(raw: &str) -> Vec<(String, String, usize)> {
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            let k = k.trim().to_string();
            if k.is_empty() {
                continue;
            }
            out.push((k, v.to_string(), i));
        }
    }
    out
}

/// Return every non-managed `KEY=VALUE` pair from ~/.hermes/.env.
///
/// Output is ordered by the order of appearance in the file. Managed keys
/// (provider API keys, base URLs, `GATEWAY_ALLOW_ALL_USERS`, `API_SERVER_KEY`)
/// are filtered out — those are surfaced separately in the config UI.
#[tauri::command]
pub fn hermes_env_read_unmanaged() -> Result<Vec<(String, String)>, String> {
    use super::hermes_providers;

    let env_path = hermes_home().join(".env");
    if !env_path.exists() {
        return Ok(Vec::new());
    }

    let raw =
        std::fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env: {e}"))?;

    let managed = hermes_providers::all_managed_env_keys();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    for (k, v, _) in parse_env_file_lines(&raw) {
        if managed.contains(&k.as_str()) {
            continue;
        }
        if seen.insert(k.clone()) {
            out.push((k, v));
        }
    }
    Ok(out)
}

/// Write or update a single unmanaged env var in ~/.hermes/.env.
///
/// Refuses to write keys in `hermes_providers::all_managed_env_keys`.
/// Creates the file (and parent dir) if missing.
#[tauri::command]
pub fn hermes_env_set(key: String, value: String) -> Result<(), String> {
    use super::hermes_providers;

    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Key cannot be empty".into());
    }
    // Basic sanity: env var keys are typically A-Z0-9_
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!(
            "Invalid env var key '{key}': only [A-Z0-9_] are allowed"
        ));
    }
    let managed = hermes_providers::all_managed_env_keys();
    if managed.contains(&key.as_str()) {
        return Err(format!(
            "'{key}' is managed by ClawPanel; please configure it via the provider setup page"
        ));
    }

    let env_path = hermes_home().join(".env");
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .hermes dir: {e}"))?;
    }

    let raw = if env_path.exists() {
        std::fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env: {e}"))?
    } else {
        String::new()
    };

    // Preserve file structure: if the key already exists, update the first
    // occurrence and leave the rest (which would be dead code anyway for
    // dotenv loaders) alone. Otherwise append a new line.
    let lines: Vec<&str> = raw.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;
    for line in lines.iter() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() {
            out.push(line.to_string());
            continue;
        }
        if let Some((k, _)) = t.split_once('=') {
            if k.trim() == key && !replaced {
                out.push(format!("{key}={value}"));
                replaced = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if !replaced {
        out.push(format!("{key}={value}"));
    }
    let mut content = out.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    std::fs::write(&env_path, content).map_err(|e| format!("Failed to write .env: {e}"))?;
    Ok(())
}

/// Remove an unmanaged env var from ~/.hermes/.env.
///
/// Refuses to delete keys in `hermes_providers::all_managed_env_keys`.
/// No-op if the key doesn't exist.
#[tauri::command]
pub fn hermes_env_delete(key: String) -> Result<(), String> {
    use super::hermes_providers;

    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Key cannot be empty".into());
    }
    let managed = hermes_providers::all_managed_env_keys();
    if managed.contains(&key.as_str()) {
        return Err(format!(
            "'{key}' is managed by ClawPanel; please configure it via the provider setup page"
        ));
    }

    let env_path = hermes_home().join(".env");
    if !env_path.exists() {
        return Ok(());
    }
    let raw =
        std::fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env: {e}"))?;

    let lines: Vec<&str> = raw.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines.iter() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() {
            out.push(line.to_string());
            continue;
        }
        if let Some((k, _)) = t.split_once('=') {
            if k.trim() == key {
                continue; // drop
            }
        }
        out.push(line.to_string());
    }
    let mut content = out.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    std::fs::write(&env_path, content).map_err(|e| format!("Failed to write .env: {e}"))?;
    Ok(())
}
