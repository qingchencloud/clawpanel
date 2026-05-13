//! Hermes Agent 安装与管理命令
//!
//! 通过 uv 实现零依赖安装：
//!   1. 下载 uv 单文件二进制
//!   2. uv tool install hermes-agent --python 3.11
//!   3. 写入 ~/.hermes/config.yaml + .env

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
fn hermes_gateway_custom_url() -> Option<String> {
    super::read_panel_config_value()
        .and_then(|v| {
            v.get("hermes")?
                .get("gatewayUrl")?
                .as_str()
                .map(String::from)
        })
        .filter(|s| !s.trim().is_empty())
        .map(|url| url.trim_end_matches('/').to_string())
}

fn is_loopback_gateway_url(url: &str) -> bool {
    let rest = url
        .trim()
        .strip_prefix("http://")
        .or_else(|| url.trim().strip_prefix("https://"))
        .unwrap_or(url.trim());
    let host = if let Some(stripped) = rest.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        rest.split('/')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
    };
    let lower = host.trim().to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    lower
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn hermes_gateway_url() -> String {
    if let Some(url) = hermes_gateway_custom_url() {
        return url;
    }
    let port = hermes_gateway_port();
    format!("http://127.0.0.1:{port}")
}

async fn ensure_managed_gateway_ready(app: &tauri::AppHandle, gw_url: &str) -> Result<(), String> {
    if let Some(url) = hermes_gateway_custom_url() {
        if !is_loopback_gateway_url(&url) {
            return Ok(());
        }
    }
    if gateway_quick_health_check().await {
        start_guardian(app);
        emit_gateway_status(true);
        return Ok(());
    }
    hermes_gateway_action(app.clone(), "start".into())
        .await
        .map(|_| ())
        .map_err(|e| {
            format!(
                "Gateway 未运行且自动启动失败: {e}\nGateway: {gw_url}\n{}",
                hermes_gateway_log_tail(20)
            )
        })
}

fn hermes_gateway_http_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("ClawPanel")
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

fn reqwest_error_detail(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut detail = error.to_string();
    let mut source = error.source();
    while let Some(item) = source {
        let text = item.to_string();
        if !text.is_empty() && !detail.contains(&text) {
            detail.push_str(": ");
            detail.push_str(&text);
        }
        source = item.source();
    }
    detail
}

fn hermes_gateway_log_tail(limit: usize) -> String {
    let log_path = hermes_home().join("gateway-run.log");
    let content = std::fs::read_to_string(log_path).unwrap_or_default();
    content
        .lines()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

async fn hermes_run_failure_message(action: &str, gw_url: &str, detail: String) -> String {
    let health_url = format!("{gw_url}/health");
    let health = match hermes_gateway_http_client(std::time::Duration::from_secs(3)) {
        Ok(client) => match client.get(&health_url).send().await {
            Ok(resp) => format!("HTTP {}", resp.status().as_u16()),
            Err(error) => format!("不可达 ({})", reqwest_error_detail(&error)),
        },
        Err(error) => format!("无法创建客户端 ({error})"),
    };
    let log_tail = hermes_gateway_log_tail(12);
    let log_block = if log_tail.trim().is_empty() {
        "最近 Gateway 日志为空".to_string()
    } else {
        format!("最近 Gateway 日志:\n{log_tail}")
    };
    format!(
        "{action}: {detail}\nGateway: {gw_url}\nHealth: {health}\n建议：在 Hermes 服务页点击“重启 Gateway”后重试；如果刚改过模型/API Key，必须重启 Gateway。\n{log_block}"
    )
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

    // 检测 git
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

/// Hermes Dashboard 端口 - 从 config.yaml 的 dashboard.port 读取，默认 9119
fn hermes_dashboard_port() -> u16 {
    let config_path = hermes_home().join("config.yaml");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        let mut in_dashboard = false;
        for line in content.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            let indent = line.len() - line.trim_start().len();
            if indent == 0 {
                in_dashboard = t == "dashboard:" || t.starts_with("dashboard:");
                continue;
            }
            if in_dashboard && t.starts_with("port:") {
                if let Ok(port) = t.trim_start_matches("port:").trim().parse::<u16>() {
                    if port > 0 {
                        return port;
                    }
                }
            }
        }
    }
    9119 // Hermes Dashboard 默认端口
}

fn hermes_dashboard_cli_status(port: u16) -> Option<(bool, String)> {
    let output = run_silent("hermes", &["dashboard", "--status"])
        .or_else(|_| run_silent("hermes", &["dashboard", "status"]))
        .ok()?;
    let lower = output.to_ascii_lowercase();
    if lower.contains("not running")
        || lower.contains("stopped")
        || lower.contains("inactive")
        || lower.contains("no dashboard")
    {
        return Some((false, output));
    }
    if lower.contains("running")
        || lower.contains("listening")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains(&port.to_string())
    {
        return Some((true, output));
    }
    None
}

fn hermes_dashboard_tcp_running(port: u16, timeout_ms: u64) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(socket_addr) = addr.parse::<std::net::SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&socket_addr, std::time::Duration::from_millis(timeout_ms))
        .is_ok()
}

fn hermes_dashboard_cli_stop() -> bool {
    run_silent("hermes", &["dashboard", "--stop"])
        .or_else(|_| run_silent("hermes", &["dashboard", "stop"]))
        .is_ok()
}

/// 探测 Hermes Dashboard 是否在运行（TCP 连接 127.0.0.1 上的 dashboard 端口）
/// 返回 { running: bool, port: u16 }，前端据此决定是否打开浏览器或提示用户启动
#[tauri::command]
pub async fn hermes_dashboard_probe() -> Result<Value, String> {
    let port = hermes_dashboard_port();
    let cli_status = hermes_dashboard_cli_status(port);
    let cli_running = cli_status.as_ref().map(|(running, _)| *running);
    let cli_output = cli_status.as_ref().map(|(_, output)| output.clone());
    let running = tokio::task::spawn_blocking(move || {
        let tcp_running = hermes_dashboard_tcp_running(port, 800);
        tcp_running || cli_running.unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    Ok(serde_json::json!({ "running": running, "port": port, "status": cli_output }))
}

/// 我们 spawn 的 Dashboard 进程 PID（0 = 没有）
static DASH_PID: AtomicU32 = AtomicU32::new(0);

/// 精准杀掉我们 spawn 的 Dashboard 进程（taskkill /F /PID）
fn kill_dashboard_pid() -> bool {
    let pid = DASH_PID.load(Ordering::SeqCst);
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
            DASH_PID.store(0, Ordering::SeqCst);
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
            DASH_PID.store(0, Ordering::SeqCst);
        }
        ok
    }
}

/// 启动 Hermes Dashboard 服务（`hermes dashboard`），idempotent
/// 行为：
///   1. 端口已可达 → 直接返回 `started: true, already_running: true`
///   2. 否则 spawn `hermes dashboard`，等最多 90s（首次会 npm build 前端）
///   3. 进程提前退出 → 读日志尾部检测 deps_missing / port_in_use
/// 返回 `{ started, kind?, port, pid?, exit_code?, log_tail? }`
#[tauri::command]
pub async fn hermes_dashboard_start() -> Result<Value, String> {
    let port = hermes_dashboard_port();
    // 1. 已运行？
    if hermes_dashboard_tcp_running(port, 500)
        || hermes_dashboard_cli_status(port)
            .map(|(running, _)| running)
            .unwrap_or(false)
    {
        return Ok(serde_json::json!({
            "started": true,
            "already_running": true,
            "port": port,
        }));
    }

    // 2. 清掉残留 PID（来自上一次 spawn）
    let _ = kill_dashboard_pid();

    let home = hermes_home();
    let log_path = home.join("dashboard-run.log");
    let log_file =
        std::fs::File::create(&log_path).map_err(|e| format!("创建日志文件失败: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("克隆日志句柄失败: {e}"))?;

    let enhanced = hermes_enhanced_path();
    let mut cmd = std::process::Command::new("hermes");
    cmd.args(["dashboard"])
        .current_dir(&home)
        .env("PATH", &enhanced)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 注入 .env（与 gateway 启动一致）
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn hermes dashboard failed: {e}"))?;
    let pid = child.id();
    DASH_PID.store(pid, Ordering::SeqCst);

    // 3. 等待 - 端口起来 / 进程提前死 / 超时
    // 90s 是为了覆盖首次启动的 npm build（dashboard 文档说前端没构建会 auto build on first launch）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    while std::time::Instant::now() < deadline {
        // 进程提前退出？
        match child.try_wait() {
            Ok(Some(status)) => {
                DASH_PID.store(0, Ordering::SeqCst);
                let log_raw = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail = log_raw
                    .lines()
                    .rev()
                    .take(40)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                let lower = log_raw.to_lowercase();
                let kind = if lower.contains("web ui dependencies not installed")
                    || lower.contains("no module named 'fastapi'")
                    || (lower.contains("import error") && lower.contains("fastapi"))
                {
                    "deps_missing"
                } else if lower.contains("address already in use")
                    || lower.contains("address in use")
                    || (lower.contains("port") && lower.contains("already in use"))
                {
                    "port_in_use"
                } else {
                    "spawn_failed"
                };
                return Ok(serde_json::json!({
                    "started": false,
                    "kind": kind,
                    "exit_code": status.code(),
                    "port": port,
                    "log_tail": tail,
                }));
            }
            Ok(None) => {
                // 还活着，探端口
                if hermes_dashboard_tcp_running(port, 300) {
                    // PID 仍记录在 DASH_PID，供后续 stop 使用
                    return Ok(serde_json::json!({
                        "started": true,
                        "already_running": false,
                        "port": port,
                        "pid": pid,
                    }));
                }
            }
            Err(e) => {
                // try_wait 异常：异常本身罕见，先记录并跳出
                let log_raw = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail = log_raw
                    .lines()
                    .rev()
                    .take(40)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                return Ok(serde_json::json!({
                    "started": false,
                    "kind": "spawn_failed",
                    "port": port,
                    "log_tail": tail,
                    "error": format!("try_wait error: {e}"),
                }));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // 4. 超时（进程还活着但端口没起来；常见于首次构建超过 90s）
    let log_raw = std::fs::read_to_string(&log_path).unwrap_or_default();
    let tail = log_raw
        .lines()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Ok(serde_json::json!({
        "started": false,
        "kind": "timeout",
        "port": port,
        "pid": pid,
        "log_tail": tail,
    }))
}

/// 停止我们 spawn 的 Dashboard 进程
#[tauri::command]
pub async fn hermes_dashboard_stop() -> Result<bool, String> {
    let port = hermes_dashboard_port();
    let cli_stopped = tokio::task::spawn_blocking(hermes_dashboard_cli_stop)
        .await
        .unwrap_or(false);
    let pid_stopped = kill_dashboard_pid();
    if cli_stopped || pid_stopped {
        for _ in 0..20 {
            if !hermes_dashboard_tcp_running(port, 200) {
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        return Ok(true);
    }
    Ok(false)
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

const HERMES_GIT_URL: &str = "git+https://github.com/NousResearch/hermes-agent.git";

fn sanitize_hermes_install_output(text: &str) -> String {
    let mut out = text.replace(HERMES_GIT_URL, "hermes-agent");
    out = out.replace(
        "https://github.com/NousResearch/hermes-agent.git",
        "hermes-agent",
    );
    out = out.replace(
        "https://github.com/NousResearch/hermes-agent",
        "hermes-agent",
    );
    out = out.replace("github.com/NousResearch/hermes-agent.git", "hermes-agent");
    out = out.replace("github.com/NousResearch/hermes-agent", "hermes-agent");
    out.replace("NousResearch/hermes-agent", "hermes-agent")
}

/// 从 panelConfig.gitMirror 读取镜像前缀（如 "https://ghproxy.com/"）。
/// 为空/未设置 → 不启用镜像。
fn git_mirror_prefix() -> Option<String> {
    super::read_panel_config_value()
        .and_then(|v| v.get("gitMirror")?.as_str().map(String::from))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 给 tokio::process::Command 注入 git insteadOf 重写 env，
/// 进程级别（不污染用户全局 ~/.gitconfig）。仅当配置了镜像时会动作。
fn apply_git_mirror_env(cmd: &mut tokio::process::Command) {
    let Some(mirror) = git_mirror_prefix() else {
        return;
    };
    let mirror = if mirror.ends_with('/') {
        mirror
    } else {
        format!("{mirror}/")
    };
    // git 读取 GIT_CONFIG_COUNT 个临时配置项，仅影响当前进程
    cmd.env("GIT_CONFIG_COUNT", "1");
    cmd.env(
        "GIT_CONFIG_KEY_0",
        format!("url.{mirror}https://github.com/.insteadOf"),
    );
    cmd.env("GIT_CONFIG_VALUE_0", "https://github.com/");
}

/// 诊断 Hermes 安装/升级输出是否命中「网络无法访问」类失败，
/// 命中返回建议文案（含「可在设置页启用 Git 镜像」提示）。
fn diagnose_install_network_error(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let hits = [
        "failed to connect to github.com",
        "could not connect to server",
        "failed to clone",
        "unable to access",
        "git operation failed",
        "connection timed out",
        "connection refused",
        "network is unreachable",
        "could not resolve host",
    ];
    if !hits.iter().any(|h| lower.contains(h)) {
        return None;
    }
    Some(
        "⚠ 检测到安装过程中无法访问外部 Git 服务。请任选一项重试：\
\n  1) 在「设置 → 网络代理」配置可用代理后重试；\
\n  2) 在「设置 → Hermes 安装镜像」填入可用的 Git 镜像前缀。"
            .to_string(),
    )
}

/// 通过 uv tool install 安装 Hermes Agent
async fn install_via_uv_tool(
    app: &tauri::AppHandle,
    uv_path: &str,
    extras: &[String],
) -> Result<(), String> {
    let _ = app.emit(
        "hermes-install-log",
        "📦 通过 uv tool install 安装 Hermes Agent...",
    );
    let _ = app.emit("hermes-install-progress", 25u32);

    // 构造安装规格
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
    // 用户配置了 Git 镜像（如 ghproxy）→ 进程级注入 insteadOf 重写
    apply_git_mirror_env(&mut cmd);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 捕获输出
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let _ = app.emit(
        "hermes-install-log",
        "uv tool install hermes-agent --python 3.11",
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
            let _ = app.emit(
                "hermes-install-log",
                sanitize_hermes_install_output(line.trim()),
            );
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
        let cleaned = sanitize_hermes_install_output(stderr.trim());
        // 命中 git/network 失败 → 在日志流尾部追加诊断 + 给最终错误消息加上提示
        if let Some(hint) = diagnose_install_network_error(&cleaned) {
            let _ = app.emit("hermes-install-log", &hint);
            return Err(format!(
                "安装失败 (exit {}): {}\n\n{}",
                output.status.code().unwrap_or(-1),
                cleaned,
                hint
            ));
        }
        Err(format!(
            "安装失败 (exit {}): {}",
            output.status.code().unwrap_or(-1),
            cleaned
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

    // pip install
    let pkg = if extras.is_empty() {
        format!("hermes-agent @ {}", HERMES_GIT_URL)
    } else {
        format!("hermes-agent[{}] @ {}", extras.join(","), HERMES_GIT_URL)
    };
    let _ = app.emit("hermes-install-log", "> uv pip install hermes-agent");

    let mut pip_cmd = tokio::process::Command::new(uv_path);
    pip_cmd.args(["pip", "install", &pkg]);
    pip_cmd.env("GIT_TERMINAL_PROMPT", "0");
    pip_cmd.env("VIRTUAL_ENV", &venv_str);
    if let Some(mirror) = pypi_mirror_url() {
        pip_cmd.args(["--index-url", &mirror]);
    }
    apply_git_mirror_env(&mut pip_cmd);
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
            let _ = app.emit(
                "hermes-install-log",
                sanitize_hermes_install_output(line.trim()),
            );
        }
    }

    if !pip_out.status.success() {
        return Err(format!(
            "pip install 失败: {}",
            sanitize_hermes_install_output(stderr.trim())
        ));
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
    // ClawPanel 根据内置 provider registry 决定 .env key 名和
    // config.yaml 的 model.provider 字段。
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
    // Provider 字段用于稳定选择凭证来源。
    // `custom` 不写 provider 行，让 Hermes Agent 从 base_url 自动推断。
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
// hermes_read_config_full — 解析整个 config.yaml 为 JSON 返回给前端
//
// 与轻量版 hermes_read_config（仅返回 5 个 model 相关字段）互补：
// 前者用于 model 配置页快速展示，本命令用于「高级配置编辑器」让用户能看到/改
// Gateway 端 14+ 个顶层配置项，比如 quick_commands / streaming / reset_triggers /
// stt_enabled / unauthorized_dm_behavior 等。
//
// 返回值结构：
//   {
//     "exists": true,                       // config.yaml 是否存在
//     "raw": "...yaml string...",            // 原文（给 yaml editor）
//     "config": { ...full json... },         // 整份 yaml 转成 JSON
//     "highlights": {                        // 14 个高价值字段单独抽出，前端直接 .x 访问
//       "streaming": {...}, "stt_enabled": true, "quick_commands": {...},
//       "reset_triggers": [...], "default_reset_policy": {...},
//       "unauthorized_dm_behavior": "pair", "session_store_max_age_days": 90,
//       "always_log_local": true,
//       "group_sessions_per_user": false, "thread_sessions_per_user": false,
//       ... 等
//     }
//   }
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_read_config_full() -> Result<Value, String> {
    let config_path = hermes_home().join("config.yaml");

    if !config_path.exists() {
        return Ok(serde_json::json!({
            "exists": false,
            "raw": "",
            "config": {},
            "highlights": {},
        }));
    }

    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {e}"))?;

    // 解析 YAML → JSON
    let yaml_value: serde_yaml::Value = serde_yaml::from_str(&raw)
        .map_err(|e| format!("Invalid YAML in config.yaml: {e}"))?;
    let config_json: Value = serde_json::to_value(&yaml_value)
        .map_err(|e| format!("YAML→JSON conversion failed: {e}"))?;

    // 抽取 14 个高价值顶层字段（如不存在保持 null，前端按需渲染）
    let highlight_keys = [
        "streaming",
        "stt_enabled",
        "quick_commands",
        "reset_triggers",
        "default_reset_policy",
        "unauthorized_dm_behavior",
        "session_store_max_age_days",
        "always_log_local",
        "group_sessions_per_user",
        "thread_sessions_per_user",
        "platforms",
        "dashboard",
        "memory",
        "skills",
    ];
    let highlights: serde_json::Map<String, Value> = highlight_keys
        .iter()
        .map(|k| {
            let v = config_json
                .get(*k)
                .cloned()
                .unwrap_or(Value::Null);
            ((*k).to_string(), v)
        })
        .collect();

    Ok(serde_json::json!({
        "exists": true,
        "raw": raw,
        "config": config_json,
        "highlights": Value::Object(highlights),
    }))
}

// ---------------------------------------------------------------------------
// P1-3: lazy_deps 预处理命令 — 让用户启用渠道时不再「首启 Gateway 卡 30 秒后崩」
//
// Hermes 内核 tools/lazy_deps.py 维护了一个 allowlist：每个 feature（如
// `platform.telegram` / `tts.elevenlabs`）对应一组 PyPI 包。原本只有 Gateway
// 启动 platform 模块时才会调 ensure() 装包，导致首次启动卡住甚至超时崩。
//
// 这里把 lazy_deps 暴露给 ClawPanel UI：
//   - hermes_lazy_deps_features() — 列所有可装的 feature（小白选）
//   - hermes_lazy_deps_status(features) — 批量查每个 feature 是否已安装
//   - hermes_lazy_deps_ensure(feature) — 主动预装
// ---------------------------------------------------------------------------

/// 找到 Hermes venv 的 Python 解释器路径
///
/// 优先级（P1-3 优化）：
/// 1. 环境变量 `HERMES_PYTHON` — 适配自定义 venv（brew / uv tool / 容器等非默认路径）
/// 2. ~/.hermes-venv/bin/python (Unix) 或 ~/.hermes-venv/Scripts/python.exe (Windows)
fn hermes_venv_python() -> Option<PathBuf> {
    // 1. HERMES_PYTHON 环境变量优先
    if let Ok(custom) = std::env::var("HERMES_PYTHON") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }
    // 2. 默认 venv 位置
    let venv_dir = dirs::home_dir()?.join(".hermes-venv");
    #[cfg(target_os = "windows")]
    let py = venv_dir.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let py = venv_dir.join("bin").join("python");
    if py.exists() {
        Some(py)
    } else {
        None
    }
}

/// 统一跑 venv python -c "<script>" 拿 JSON 结果。失败给可读错误。
async fn run_venv_python_json(script: &str) -> Result<Value, String> {
    let py = hermes_venv_python().ok_or_else(|| {
        "Hermes venv 未找到（~/.hermes-venv 不存在）。请先安装 Hermes。".to_string()
    })?;

    let mut cmd = tokio::process::Command::new(&py);
    cmd.arg("-c").arg(script);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PATH", super::enhanced_path());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("启动 Python 子进程失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stderr_trimmed = stderr.trim();
        return Err(if stderr_trimmed.is_empty() {
            format!("Python 进程退出码 {}，无 stderr 输出", output.status)
        } else {
            stderr_trimmed.to_string()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    // 取最后一行 JSON（避免被 Python 模块的 print 干扰）
    let last_line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    serde_json::from_str(last_line)
        .map_err(|e| format!("Python 输出解析失败: {e}\n原文: {stdout}"))
}

#[tauri::command]
pub async fn hermes_lazy_deps_features() -> Result<Value, String> {
    let script = r#"
import json
try:
    from tools.lazy_deps import LAZY_DEPS
    out = []
    for feat, specs in LAZY_DEPS.items():
        out.append({"feature": feat, "specs": list(specs)})
    print(json.dumps({"ok": True, "features": out}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
"#;
    run_venv_python_json(script).await
}

#[tauri::command]
pub async fn hermes_lazy_deps_status(features: Vec<String>) -> Result<Value, String> {
    // 把 features 列表序列化成 Python 合法的列表字面量
    // serde_json 的输出（如 ["platform.telegram","platform.discord"]）正好是 Python 合法字面量
    let features_literal = serde_json::to_string(&features)
        .map_err(|e| format!("features 序列化失败: {e}"))?;
    let script = format!(
        r#"
import json
try:
    from tools.lazy_deps import feature_missing, LAZY_DEPS
    targets = {features_literal}
    result = {{}}
    for f in targets:
        if f not in LAZY_DEPS:
            result[f] = {{"known": False, "satisfied": False, "missing": []}}
            continue
        miss = list(feature_missing(f))
        result[f] = {{"known": True, "satisfied": len(miss) == 0, "missing": miss}}
    print(json.dumps({{"ok": True, "status": result}}))
except Exception as e:
    print(json.dumps({{"ok": False, "error": str(e)}}))
"#
    );
    run_venv_python_json(&script).await
}

#[tauri::command]
pub async fn hermes_lazy_deps_ensure(feature: String) -> Result<Value, String> {
    // serde_json::to_string 把字符串包成 Python 合法的字符串字面量（已含引号 + escape）
    let feature_literal = serde_json::to_string(&feature)
        .map_err(|e| format!("feature 名序列化失败: {e}"))?;
    let script = format!(
        r#"
import json, sys
try:
    from tools.lazy_deps import ensure, feature_missing, FeatureUnavailable
    feat = {feature_literal}
    before_missing = list(feature_missing(feat))
    if not before_missing:
        print(json.dumps({{"ok": True, "alreadySatisfied": True, "installed": []}}))
        sys.exit(0)
    try:
        ensure(feat, prompt=False)
        print(json.dumps({{"ok": True, "alreadySatisfied": False, "installed": before_missing}}))
    except FeatureUnavailable as fe:
        print(json.dumps({{"ok": False, "error": str(fe), "missing": list(getattr(fe, "missing", []))}}))
except Exception as e:
    print(json.dumps({{"ok": False, "error": str(e)}}))
"#
    );
    run_venv_python_json(&script).await
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
            // 与 Hermes 内核 8ac351407 保持一致：切模型时清掉旧 context_length，
            // 否则新模型会沿用上一个模型的 context window（典型表现：context 报错
            // / 输出被截断）。删除该行即可，Hermes 会按新模型默认窗口生效。
            if trimmed.starts_with("context_length:") {
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
            // Guardian: ensure platforms.api_server.enabled:true is present
            // before every start. Auto-heal if missing (with a .bak backup).
            // See `ensure_api_server_enabled` for rationale.
            ensure_api_server_enabled(&app)?;

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

    let client = hermes_gateway_http_client(std::time::Duration::from_secs(5))
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
// hermes_capabilities — 探测 Gateway 暴露的 API 能力描述（GET /v1/capabilities）
//
// Hermes 内核 v2026.5.x 起暴露的「机器可读 capability 描述」，给外部 UI 用来
// 动态适配可用功能，避免在前端写死哪些 endpoint/feature 存在。例：
// 老版本的 Gateway 没有 `/v1/runs/{id}/approval`，新版有 → 用 capabilities 判
// 断而不是用版本号匹配。
//
// 不可达 / 老版 Gateway 没有该 endpoint → 返回 Err，调用方应优雅降级。
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_capabilities() -> Result<Value, String> {
    let url = format!("{}/v1/capabilities", hermes_gateway_url());

    let client = hermes_gateway_http_client(std::time::Duration::from_secs(5))
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
    let _ = app.emit("hermes-install-progress", 0u32);

    let uv_path = uv_bin_path();
    let uv = if uv_path.exists() {
        uv_path.to_string_lossy().to_string()
    } else {
        "uv".into()
    };

    let pkg = format!("hermes-agent[web] @ {}", HERMES_GIT_URL);
    let mut cmd = tokio::process::Command::new(&uv);
    cmd.args([
        "tool",
        "install",
        "--reinstall",
        &pkg,
        "--python",
        "3.11",
        "--with",
        "croniter",
    ]);
    let _ = app.emit("hermes-install-progress", 20u32);
    let _ = app.emit(
        "hermes-install-log",
        "uv tool install --reinstall hermes-agent --python 3.11 --with croniter",
    );
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(mirror) = pypi_mirror_url() {
        cmd.args(["--index-url", &mirror]);
    }
    apply_git_mirror_env(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    cmd.env("PATH", hermes_enhanced_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|e| format!("升级失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            let _ = app.emit(
                "hermes-install-log",
                sanitize_hermes_install_output(line.trim()),
            );
        }
    }

    if output.status.success() {
        let _ = app.emit("hermes-install-log", "✅ 升级完成");
        let _ = app.emit("hermes-install-progress", 100u32);
        Ok("升级完成".into())
    } else {
        let cleaned = sanitize_hermes_install_output(stderr.trim());
        if let Some(hint) = diagnose_install_network_error(&cleaned) {
            let _ = app.emit("hermes-install-log", &hint);
            return Err(format!("升级失败: {}\n\n{}", cleaned, hint));
        }
        Err(format!("升级失败: {}", cleaned))
    }
}

// ---------------------------------------------------------------------------
// uninstall_hermes — 卸载
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn uninstall_hermes(app: tauri::AppHandle, clean_config: bool) -> Result<String, String> {
    let _ = app.emit("hermes-install-log", "🗑️ 卸载 Hermes Agent...");
    let _ = app.emit("hermes-install-progress", 10u32);

    let uv_path = uv_bin_path();
    let uv = if uv_path.exists() {
        uv_path.to_string_lossy().to_string()
    } else {
        "uv".into()
    };

    // uv tool uninstall
    let mut cmd = tokio::process::Command::new(&uv);
    cmd.args(["tool", "uninstall", "hermes-agent"]);
    let _ = app.emit("hermes-install-log", "> uv tool uninstall hermes-agent");
    cmd.env("PATH", hermes_enhanced_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|e| format!("卸载失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            let _ = app.emit("hermes-install-log", line.trim());
        }
    }

    if !output.status.success() {
        return Err(format!("卸载失败: {}", stderr.trim()));
    }
    let _ = app.emit("hermes-install-progress", 65u32);

    // 清理 venv（如果存在）
    let venv_dir = dirs::home_dir().unwrap_or_default().join(".hermes-venv");
    if venv_dir.exists() {
        let _ = app.emit(
            "hermes-install-log",
            format!("清理虚拟环境: {}", venv_dir.display()),
        );
        let _ = std::fs::remove_dir_all(&venv_dir);
    }

    // 可选：清理配置
    if clean_config {
        let home = hermes_home();
        if home.exists() {
            let _ = app.emit(
                "hermes-install-log",
                format!("清理配置目录: {}", home.display()),
            );
            let _ = std::fs::remove_dir_all(&home);
        }
    }

    let _ = app.emit("hermes-install-log", "✅ Hermes Agent 已卸载");
    let _ = app.emit("hermes-install-progress", 100u32);
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
    let client =
        hermes_gateway_http_client(timeout).map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

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
// hermes_agent_run — streaming compatibility layer for Hermes Agent
// ---------------------------------------------------------------------------

fn hermes_response_text(value: &Value) -> String {
    let response = value.get("response").unwrap_or(value);
    if let Some(text) = response.get("output_text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(text) = response.get("text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    let mut out = String::new();
    if let Some(items) = response.get("output").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(parts) = item.get("content").and_then(|v| v.as_array()) {
                for part in parts {
                    let kind = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if matches!(kind, "output_text" | "text") {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            out.push_str(text);
                        }
                    }
                }
            }
        }
    }
    out
}

fn hermes_response_delta(evt: &Value) -> String {
    evt.get("delta")
        .and_then(|v| v.as_str())
        .or_else(|| evt.get("text").and_then(|v| v.as_str()))
        .or_else(|| evt.get("content").and_then(|v| v.as_str()))
        .or_else(|| {
            evt.get("delta")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            evt.get("delta")
                .and_then(|v| v.get("value"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string()
}

fn normalize_hermes_stream_event(
    evt: &Value,
    run_id: &str,
    session_id: Option<&str>,
) -> Option<Value> {
    let event_type = evt
        .get("event")
        .and_then(|v| v.as_str())
        .or_else(|| evt.get("type").and_then(|v| v.as_str()))
        .unwrap_or("");
    if event_type.is_empty() {
        return None;
    }
    let sid = session_id
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    match event_type {
        "message.delta" | "run.completed" | "run.failed" | "run.cancelled"
        | "tool.started" | "tool.completed" | "tool.progress" | "tool.error"
        | "reasoning.available" | "approval.request" | "approval.responded" => {
            let mut out = evt.clone();
            if out.get("run_id").is_none() {
                out["run_id"] = Value::String(run_id.to_string());
            }
            if out.get("session_id").is_none() {
                out["session_id"] = sid;
            }
            Some(out)
        }
        "response.output_text.delta" | "response.text.delta" => {
            let delta = hermes_response_delta(evt);
            if delta.is_empty() {
                None
            } else {
                Some(serde_json::json!({
                    "event": "message.delta",
                    "run_id": run_id,
                    "session_id": sid,
                    "delta": delta,
                }))
            }
        }
        "response.output_item.added" => {
            let item = evt
                .get("item")
                .or_else(|| evt.get("output_item"))
                .unwrap_or(&Value::Null);
            let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(kind, "function_call" | "tool_call") {
                return None;
            }
            let tool = item
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    item.get("function")
                        .and_then(|v| v.get("name"))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("tool");
            Some(serde_json::json!({
                "event": "tool.started",
                "run_id": run_id,
                "session_id": sid,
                "tool": tool,
                "input": item.get("arguments").or_else(|| item.get("input")).cloned().unwrap_or(Value::Null),
            }))
        }
        "response.function_call_arguments.delta" => Some(serde_json::json!({
            "event": "tool.progress",
            "run_id": run_id,
            "session_id": sid,
            "tool": evt.get("name").and_then(|v| v.as_str()).unwrap_or("tool"),
            "preview": hermes_response_delta(evt),
        })),
        "response.output_item.done" | "response.function_call_arguments.done" => {
            let item = evt
                .get("item")
                .or_else(|| evt.get("output_item"))
                .unwrap_or(&Value::Null);
            let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if event_type == "response.output_item.done"
                && !matches!(kind, "function_call" | "tool_call")
            {
                return None;
            }
            Some(serde_json::json!({
                "event": "tool.completed",
                "run_id": run_id,
                "session_id": sid,
                "tool": item.get("name").and_then(|v| v.as_str()).or_else(|| evt.get("name").and_then(|v| v.as_str())).unwrap_or("tool"),
                "input": item.get("arguments").or_else(|| evt.get("arguments")).cloned().unwrap_or(Value::Null),
            }))
        }
        "response.completed" => Some(serde_json::json!({
            "event": "run.completed",
            "run_id": run_id,
            "session_id": sid,
            "output": hermes_response_text(evt),
        })),
        "response.failed" | "response.error" => Some(serde_json::json!({
            "event": "run.failed",
            "run_id": run_id,
            "session_id": sid,
            "error": evt.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str())
                .or_else(|| evt.get("error").and_then(|v| v.as_str()))
                .or_else(|| evt.get("message").and_then(|v| v.as_str()))
                .unwrap_or("unknown error"),
        })),
        _ => {
            let mut out = evt.clone();
            out["event"] = Value::String(event_type.to_string());
            if out.get("run_id").is_none() {
                out["run_id"] = Value::String(run_id.to_string());
            }
            if out.get("session_id").is_none() {
                out["session_id"] = sid;
            }
            Some(out)
        }
    }
}

fn emit_hermes_stream_event(
    app: &tauri::AppHandle,
    evt: Value,
    run_id: &str,
    final_output: &mut String,
) -> Result<bool, String> {
    let event_type = evt["event"].as_str().unwrap_or("");
    match event_type {
        "message.delta" => {
            if let Some(delta) = evt["delta"].as_str() {
                final_output.push_str(delta);
                let _ = app.emit(
                    "hermes-run-delta",
                    serde_json::json!({
                        "run_id": run_id,
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
        // Batch 1 §C 新增：Approval Flow 4 类真实事件（已用源码 api_server.py 确认）
        "approval.request" => {
            let _ = app.emit("hermes-run-approval-request", evt.clone());
        }
        "approval.responded" => {
            let _ = app.emit("hermes-run-approval-responded", evt.clone());
        }
        "run.cancelled" => {
            let _ = app.emit("hermes-run-cancelled", evt.clone());
            // 中断也是终态 — 让流循环可以 return Ok(true) 结束读
            return Ok(true);
        }
        "run.completed" => {
            if let Some(output) = evt["output"].as_str() {
                if !output.is_empty() {
                    *final_output = output.to_string();
                }
            }
            let _ = app.emit(
                "hermes-run-done",
                serde_json::json!({
                    "run_id": run_id,
                    "output": final_output.as_str(),
                }),
            );
            return Ok(true);
        }
        "run.failed" => {
            let err = evt["error"].as_str().unwrap_or("unknown error");
            let _ = app.emit(
                "hermes-run-error",
                serde_json::json!({
                    "run_id": run_id,
                    "error": err,
                }),
            );
            return Err(format!("Agent run failed: {err}"));
        }
        _ => {
            let _ = app.emit("hermes-run-event", evt.clone());
        }
    }
    Ok(false)
}

async fn try_hermes_responses_run(
    app: &tauri::AppHandle,
    gw_url: &str,
    api_key: &str,
    payload: &Value,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let client = hermes_gateway_http_client(std::time::Duration::from_secs(300))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut response_payload = payload.clone();
    response_payload["stream"] = Value::Bool(true);
    let mut req = client
        .post(format!("{gw_url}/v1/responses"))
        .header("Content-Type", "application/json")
        .body(response_payload.to_string());
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(_) => return Ok(None),
    };
    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 401 || status.as_u16() == 403 {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {text}", status.as_u16()));
        }
        return Ok(None);
    }
    let run_id = resp
        .headers()
        .get("x-request-id")
        .or_else(|| resp.headers().get("x-response-id"))
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            format!("response-{now}")
        });
    let _ = app.emit(
        "hermes-run-started",
        serde_json::json!({ "run_id": &run_id }),
    );
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("application/json") {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let output = hermes_response_text(&body);
        let _ = app.emit(
            "hermes-run-done",
            serde_json::json!({
                "run_id": &run_id,
                "output": output,
            }),
        );
        return Ok(Some(run_id));
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut final_output = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("SSE 读取失败: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();
            let data = if let Some(rest) = line.strip_prefix("data:") {
                rest.trim()
            } else if line.starts_with('{') {
                line.as_str()
            } else {
                continue;
            };
            if data.is_empty() || data == "[DONE]" {
                let _ = app.emit(
                    "hermes-run-done",
                    serde_json::json!({
                        "run_id": &run_id,
                        "output": &final_output,
                    }),
                );
                return Ok(Some(run_id));
            }
            if let Ok(evt) = serde_json::from_str::<Value>(data) {
                if let Some(normalized) = normalize_hermes_stream_event(&evt, &run_id, session_id) {
                    if emit_hermes_stream_event(app, normalized, &run_id, &mut final_output)? {
                        return Ok(Some(run_id));
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
    Ok(Some(run_id))
}

/// 读取 Hermes API_SERVER_KEY（从 ~/.hermes/.env），与 hermes_agent_run 共用。
fn read_hermes_api_key() -> String {
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
}

// ---------------------------------------------------------------------------
// Batch 1 §D: hermes_run_stop — 真正中断 run（POST /v1/runs/{run_id}/stop）
//
// 原本 chat-store 的 stopStreaming() 只 abort 本地 SSE，后端 agent 继续跑完
// 「Stop 假停」问题：从 hermes 源码确认真实端点是 /v1/runs/{run_id}/stop（用 run_id 不是 session_id）。
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_run_stop(run_id: String) -> Result<Value, String> {
    if run_id.is_empty() {
        return Err("run_id 不能为空".to_string());
    }
    let gw_url = hermes_gateway_url();
    let url = format!("{gw_url}/v1/runs/{run_id}/stop");
    let api_key = read_hermes_api_key();
    let client = hermes_gateway_http_client(std::time::Duration::from_secs(5))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut req = client.post(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("stop 请求失败: {}", reqwest_error_detail(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("stop 失败 HTTP {}: {}", status.as_u16(), body));
    }
    Ok(resp.json::<Value>().await.unwrap_or(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Batch 1 §C-bis: hermes_run_approval — 批准/拒绝 Hermes 内核的工具调用
//
// Hermes 跑高危工具（terminal / code_execution）默认是 ask once 模式，
// 触发 approval.request SSE 事件，前端要弹给用户 4 个选项：
//   - "once"    一次性批准（默认）
//   - "session" 本 session 内都批准
//   - "always"  全局总是批准（极少用）
//   - "deny"    拒绝（run 会被 cancelled）
//
// 端点：POST /v1/runs/{run_id}/approval { choice }
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_run_approval(run_id: String, choice: String) -> Result<Value, String> {
    if run_id.is_empty() {
        return Err("run_id 不能为空".to_string());
    }
    let normalized_choice = match choice.as_str() {
        "once" | "session" | "always" | "deny" => choice,
        other => return Err(format!("approval choice 必须是 once/session/always/deny，收到 {other}")),
    };
    let gw_url = hermes_gateway_url();
    let url = format!("{gw_url}/v1/runs/{run_id}/approval");
    let api_key = read_hermes_api_key();
    let client = hermes_gateway_http_client(std::time::Duration::from_secs(5))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut req = client
        .post(&url)
        .json(&serde_json::json!({ "choice": normalized_choice }));
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("approval 请求失败: {}", reqwest_error_detail(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("approval 失败 HTTP {}: {}", status.as_u16(), body));
    }
    Ok(resp.json::<Value>().await.unwrap_or(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Batch 1 §E: hermes_session_export — 导出会话消息（走 dashboard 9119）
//
// 校对稿订正：不走 CLI `hermes sessions export`，直接调
// `GET http://127.0.0.1:{dashboard_port}/api/sessions/{session_id}/messages`
// 拿 JSON 后由前端打包下载（避免 CLI 子进程开销 + Web 模式不可达）。
//
// 注意：dashboard server 需要先启动（用户没启的话调 hermes_dashboard_start）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_session_export(session_id: String) -> Result<Value, String> {
    if session_id.is_empty() {
        return Err("session_id 不能为空".to_string());
    }
    let port = hermes_dashboard_port();
    let url = format!("http://127.0.0.1:{port}/api/sessions/{session_id}/messages");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("export 请求失败: {}（提示：请先启动 Dashboard）", reqwest_error_detail(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("export 失败 HTTP {}: {}", status.as_u16(), body));
    }
    // 让前端拿原始 JSON 自己打包下载（保留完整结构）
    resp.json::<Value>().await.map_err(|e| format!("解析 JSON 失败: {e}"))
}

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

    ensure_managed_gateway_ready(&app, &gw_url).await?;

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

    // 优先 /v1/runs：该端点显式支持 body.session_id，按 client 传的 session id 复用 session，
    // 避免 Hermes 服务端 `sessions list` 中每条消息生成一个新 session（issue #275）。
    // /v1/responses 会忽略 body.session_id 并对每次请求新建 session_id，所以不作为主路径。
    let client = hermes_gateway_http_client(std::time::Duration::from_secs(10))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    // 1. POST /v1/runs → 获取 run_id
    let mut req = client
        .post(&runs_url)
        .header("Content-Type", "application/json")
        .body(payload.to_string());
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(error) => {
            return Err(hermes_run_failure_message(
                "启动 run 失败",
                &gw_url,
                reqwest_error_detail(&error),
            )
            .await);
        }
    };
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // 404 → 老版本 Hermes Agent 没有 /v1/runs，降级到 /v1/responses 兼容
        // （代价：session 会暴增，但至少能用；建议用户升级 Hermes Agent）
        if status == 404 {
            if let Some(response_run_id) =
                try_hermes_responses_run(&app, &gw_url, &api_key, &payload, session_id.as_deref())
                    .await?
            {
                return Ok(response_run_id);
            }
        }
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
    let sse_client = hermes_gateway_http_client(std::time::Duration::from_secs(300))
        .map_err(|e| format!("SSE 客户端创建失败: {e}"))?;

    let mut sse_req = sse_client.get(&events_url);
    if !api_key.is_empty() {
        sse_req = sse_req.header("Authorization", format!("Bearer {api_key}"));
    }

    let sse_resp = match sse_req.send().await {
        Ok(resp) => resp,
        Err(error) => {
            return Err(hermes_run_failure_message(
                "SSE 连接失败",
                &gw_url,
                reqwest_error_detail(&error),
            )
            .await);
        }
    };

    if !sse_resp.status().is_success() {
        let status = sse_resp.status().as_u16();
        let text = sse_resp.text().await.unwrap_or_default();
        return Err(format!("SSE HTTP {status}: {text}"));
    }

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
            let data = if let Some(rest) = trimmed.strip_prefix("data:") {
                rest.trim()
            } else if trimmed.starts_with('{') {
                trimmed
            } else {
                continue;
            };
            if data.is_empty() || data == "[DONE]" {
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
                if let Some(normalized) =
                    normalize_hermes_stream_event(&evt, &run_id, session_id.as_deref())
                {
                    if emit_hermes_stream_event(&app, normalized, &run_id, &mut final_output)? {
                        return Ok(run_id);
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
    profile: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = profile.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--profile".into());
        args.push(p.to_string());
    }
    args.extend(["sessions", "export", "-"].iter().map(|s| s.to_string()));
    if let Some(s) = source.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--source".into());
        args.push(s.to_string());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = match run_silent("hermes", &refs) {
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
            // Extra numeric fields for Usage analytics. Carry through as-is so
            // the frontend can aggregate without another round-trip. Missing
            // fields fall back to 0 / null rather than breaking the shape.
            //
            // `started_at` is a POSIX seconds timestamp produced by the
            // official Hermes CLI export. We also surface it under that name
            // (matching the web UI contract) so the Usage store can group
            // sessions by day without needing a separate parse.
            let started_at = obj
                .get("started_at")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    // Fallback: parse `created_at` as ISO8601 → epoch seconds.
                    obj.get("created_at")
                        .and_then(|v| v.as_str())
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.timestamp() as u64)
                        .unwrap_or(0)
                });
            sessions.push(serde_json::json!({
                "id": obj.get("session_id").or(obj.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
                "title": obj.get("title").or(obj.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                "source": obj.get("source").and_then(|v| v.as_str()).unwrap_or(""),
                "model": obj.get("model").and_then(|v| v.as_str()).unwrap_or(""),
                "created_at": obj.get("created_at").or(obj.get("createdAt")).and_then(|v| v.as_str()).unwrap_or(""),
                "updated_at": obj.get("updated_at").or(obj.get("updatedAt")).and_then(|v| v.as_str()).unwrap_or(""),
                "message_count": obj.get("message_count").and_then(|v| v.as_u64()).unwrap_or(0),
                // --- Usage analytics fields ---
                "started_at": started_at,
                "input_tokens": obj.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "output_tokens": obj.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "cache_read_tokens": obj.get("cache_read_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "cache_write_tokens": obj.get("cache_write_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "estimated_cost_usd": obj.get("estimated_cost_usd").and_then(|v| v.as_f64()),
                "actual_cost_usd": obj.get("actual_cost_usd").and_then(|v| v.as_f64()),
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
pub async fn hermes_sessions_summary_list(
    source: Option<String>,
    limit: Option<usize>,
    profile: Option<String>,
) -> Result<Value, String> {
    let lim = limit.unwrap_or(80).clamp(1, 500);
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = profile.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--profile".into());
        args.push(p.to_string());
    }
    args.extend(
        ["sessions", "list", "--limit"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(lim.to_string());
    if let Some(s) = source.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--source".into());
        args.push(s.to_string());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = match run_silent("hermes", &refs) {
        Ok(s) => s,
        Err(_) => return Ok(serde_json::json!([])),
    };
    let sep = regex::Regex::new(r"\s{2,}").map_err(|e| e.to_string())?;
    let mut has_titles = false;
    let mut sessions: Vec<Value> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == "No sessions found." || trimmed.starts_with('─') {
            continue;
        }
        if trimmed.contains("Title") && trimmed.contains("Preview") && trimmed.contains("ID") {
            has_titles = true;
            continue;
        }
        if trimmed.contains("Preview") && trimmed.contains("Last Active") && trimmed.contains("ID")
        {
            has_titles = false;
            continue;
        }
        let cols: Vec<&str> = sep
            .split(trimmed)
            .filter(|s| !s.trim().is_empty())
            .collect();
        if cols.len() < 3 {
            continue;
        }
        let id = cols.last().copied().unwrap_or("").trim();
        if id.is_empty() {
            continue;
        }
        let (title, preview, last_active, parsed_source) = if has_titles {
            let title = cols.first().copied().unwrap_or("").trim();
            let preview = cols.get(1).copied().unwrap_or("").trim();
            let last_active = cols.get(2).copied().unwrap_or("").trim();
            (
                if title == "—" { "" } else { title },
                preview,
                last_active,
                source.as_deref().unwrap_or(""),
            )
        } else {
            let preview = cols.first().copied().unwrap_or("").trim();
            let last_active = cols.get(1).copied().unwrap_or("").trim();
            let parsed_source = cols
                .get(2)
                .copied()
                .unwrap_or(source.as_deref().unwrap_or(""))
                .trim();
            ("", preview, last_active, parsed_source)
        };
        sessions.push(serde_json::json!({
            "id": id,
            "title": title,
            "source": parsed_source,
            "model": "",
            "created_at": "",
            "updated_at": "",
            "last_active_label": last_active,
            "preview": preview,
            "message_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
        }));
    }
    Ok(Value::Array(sessions))
}

#[tauri::command]
pub async fn hermes_usage_analytics(
    days: Option<u64>,
    profile: Option<String>,
) -> Result<Value, String> {
    let days = days.unwrap_or(30).clamp(1, 365);
    let cutoff = chrono::Utc::now().timestamp() - (days as i64 * 86_400);
    let sessions = hermes_sessions_list(None, None, profile).await?;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_write: u64 = 0;
    let mut total_estimated_cost = 0.0_f64;
    let mut total_actual_cost = 0.0_f64;
    let mut total_sessions: u64 = 0;
    let mut daily: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        std::collections::BTreeMap::new();
    let mut by_model: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        std::collections::BTreeMap::new();
    if let Some(arr) = sessions.as_array() {
        for s in arr {
            let started = s.get("started_at").and_then(|v| v.as_i64()).unwrap_or(0);
            if started > 0 && started < cutoff {
                continue;
            }
            let input = s.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output = s.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let cache_read = s
                .get("cache_read_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_write = s
                .get("cache_write_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let estimated = s
                .get("estimated_cost_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let actual = s
                .get("actual_cost_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            total_input += input;
            total_output += output;
            total_cache_read += cache_read;
            total_cache_write += cache_write;
            total_estimated_cost += estimated;
            total_actual_cost += actual;
            total_sessions += 1;
            let day = if started > 0 {
                chrono::DateTime::from_timestamp(started, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| "unknown".into())
            } else {
                "unknown".into()
            };
            let d = daily.entry(day.clone()).or_insert_with(|| {
                let mut m = serde_json::Map::new();
                m.insert("day".into(), Value::String(day));
                m.insert("input_tokens".into(), Value::from(0_u64));
                m.insert("output_tokens".into(), Value::from(0_u64));
                m.insert("cache_read_tokens".into(), Value::from(0_u64));
                m.insert("estimated_cost".into(), Value::from(0.0));
                m.insert("actual_cost".into(), Value::from(0.0));
                m.insert("sessions".into(), Value::from(0_u64));
                m
            });
            *d.get_mut("input_tokens").unwrap() =
                Value::from(d["input_tokens"].as_u64().unwrap_or(0) + input);
            *d.get_mut("output_tokens").unwrap() =
                Value::from(d["output_tokens"].as_u64().unwrap_or(0) + output);
            *d.get_mut("cache_read_tokens").unwrap() =
                Value::from(d["cache_read_tokens"].as_u64().unwrap_or(0) + cache_read);
            *d.get_mut("estimated_cost").unwrap() =
                Value::from(d["estimated_cost"].as_f64().unwrap_or(0.0) + estimated);
            *d.get_mut("actual_cost").unwrap() =
                Value::from(d["actual_cost"].as_f64().unwrap_or(0.0) + actual);
            *d.get_mut("sessions").unwrap() = Value::from(d["sessions"].as_u64().unwrap_or(0) + 1);
            let model = s
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !model.is_empty() {
                let model_key = model.clone();
                let m = by_model.entry(model_key.clone()).or_insert_with(|| {
                    let mut row = serde_json::Map::new();
                    row.insert("model".into(), Value::String(model_key));
                    row.insert("input_tokens".into(), Value::from(0_u64));
                    row.insert("output_tokens".into(), Value::from(0_u64));
                    row.insert("estimated_cost".into(), Value::from(0.0));
                    row.insert("sessions".into(), Value::from(0_u64));
                    row
                });
                *m.get_mut("input_tokens").unwrap() =
                    Value::from(m["input_tokens"].as_u64().unwrap_or(0) + input);
                *m.get_mut("output_tokens").unwrap() =
                    Value::from(m["output_tokens"].as_u64().unwrap_or(0) + output);
                *m.get_mut("estimated_cost").unwrap() =
                    Value::from(m["estimated_cost"].as_f64().unwrap_or(0.0) + estimated);
                *m.get_mut("sessions").unwrap() =
                    Value::from(m["sessions"].as_u64().unwrap_or(0) + 1);
            }
        }
    }
    let mut models: Vec<Value> = by_model.into_values().map(Value::Object).collect();
    models.sort_by(|a, b| {
        let at = a["input_tokens"].as_u64().unwrap_or(0) + a["output_tokens"].as_u64().unwrap_or(0);
        let bt = b["input_tokens"].as_u64().unwrap_or(0) + b["output_tokens"].as_u64().unwrap_or(0);
        bt.cmp(&at)
    });
    Ok(serde_json::json!({
        "daily": daily.into_values().map(Value::Object).collect::<Vec<_>>(),
        "by_model": models,
        "totals": {
            "total_input": total_input,
            "total_output": total_output,
            "total_cache_read": total_cache_read,
            "total_cache_write": total_cache_write,
            "total_estimated_cost": total_estimated_cost,
            "total_actual_cost": total_actual_cost,
            "total_sessions": total_sessions,
            "total_api_calls": 0,
        },
        "period_days": days,
        "skills": {
            "summary": {
                "total_skill_loads": 0,
                "total_skill_edits": 0,
                "total_skill_actions": 0,
                "distinct_skills_used": 0,
            },
            "top_skills": [],
        },
    }))
}

#[tauri::command]
pub async fn hermes_session_detail(
    session_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = profile.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--profile".into());
        args.push(p.to_string());
    }
    args.extend(
        ["sessions", "export", "-", "--session-id"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(session_id.clone());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output =
        run_silent("hermes", &refs).map_err(|e| format!("Failed to read sessions: {e}"))?;
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
pub async fn hermes_session_delete(
    session_id: String,
    profile: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = profile.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--profile".into());
        args.push(p.to_string());
    }
    args.extend(["sessions", "delete"].iter().map(|s| s.to_string()));
    args.push(session_id);
    args.push("--yes".into());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_silent("hermes", &refs)?;
    Ok("ok".into())
}

#[tauri::command]
pub async fn hermes_session_rename(
    session_id: String,
    title: String,
    profile: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = profile.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--profile".into());
        args.push(p.to_string());
    }
    args.extend(["sessions", "rename"].iter().map(|s| s.to_string()));
    args.push(session_id);
    args.push(title);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_silent("hermes", &refs)?;
    Ok("ok".into())
}

#[tauri::command]
pub async fn hermes_profiles_list() -> Result<Value, String> {
    let output = match run_silent("hermes", &["profile", "list"]) {
        Ok(s) => s,
        Err(_) => return Ok(serde_json::json!({ "active": "default", "profiles": [] })),
    };
    let mut active = "default".to_string();
    let mut profiles: Vec<Value> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.contains("Profile")
            || trimmed.starts_with('─')
            || trimmed.starts_with('-')
        {
            continue;
        }
        let is_active = trimmed.starts_with('◆');
        let row = trimmed.trim_start_matches('◆').trim();
        let parts: Vec<&str> = row.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0];
        if name != "default"
            && !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        {
            continue;
        }
        let gateway_idx = parts
            .iter()
            .position(|p| *p == "running" || *p == "stopped")
            .unwrap_or(2);
        if gateway_idx <= 1 || gateway_idx >= parts.len() {
            continue;
        }
        let model = parts[1..gateway_idx].join(" ");
        let gateway = parts[gateway_idx];
        let alias = parts.get(gateway_idx + 1).copied().unwrap_or("—");
        if is_active {
            active = name.to_string();
        }
        profiles.push(serde_json::json!({
            "name": name,
            "active": is_active,
            "model": if model == "—" { "" } else { &model },
            "gatewayRunning": gateway == "running",
            "alias": if alias == "—" { "" } else { alias },
        }));
    }
    if !profiles
        .iter()
        .any(|p| p.get("active").and_then(|v| v.as_bool()).unwrap_or(false))
    {
        if let Some(p) = profiles
            .iter_mut()
            .find(|p| p.get("name").and_then(|v| v.as_str()) == Some("default"))
        {
            if let Some(obj) = p.as_object_mut() {
                obj.insert("active".to_string(), Value::Bool(true));
            }
        }
    }
    Ok(serde_json::json!({ "active": active, "profiles": profiles }))
}

#[tauri::command]
pub async fn hermes_profile_use(name: String) -> Result<String, String> {
    run_silent("hermes", &["profile", "use", &name])?;
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

/// Extract the first `# Heading` or the first long prose line from Markdown,
/// used as a skill's canonical name/description.
fn md_first_heading(content: &str) -> Option<String> {
    content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
}

fn md_first_description(content: &str) -> String {
    content
        .lines()
        .find(|l| !l.starts_with('#') && !l.trim().is_empty() && l.trim().len() > 10)
        .map(|l| {
            let s = l.trim();
            if s.len() > 200 {
                format!("{}...", &s[..200])
            } else {
                s.to_string()
            }
        })
        .unwrap_or_default()
}

/// Read `config.yaml` and return the list of `skills.disabled` entries.
/// Gracefully handles missing file / missing section → empty list.
///
/// The disable mechanism uses the `skills.disabled` list:
///
/// ```yaml
/// skills:
///   disabled:
///     - web_search
///     - file_tools
/// ```
fn read_disabled_skills() -> Vec<String> {
    let config_path = hermes_home().join("config.yaml");
    let raw = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut disabled: Vec<String> = Vec::new();
    let mut in_skills = false;
    let mut in_disabled = false;
    for line in raw.lines() {
        // Strip trailing comments.
        let line = match line.find('#') {
            Some(i) => &line[..i],
            None => line,
        };
        let trimmed_full = line.trim_end();
        if trimmed_full.is_empty() {
            continue;
        }
        let indent = trimmed_full.len() - trimmed_full.trim_start().len();
        let body = trimmed_full.trim_start();

        if indent == 0 {
            in_skills = body.starts_with("skills:");
            in_disabled = false;
        } else if in_skills && indent == 2 && body.starts_with("disabled:") {
            in_disabled = true;
        } else if in_skills && in_disabled && indent >= 4 && body.starts_with("- ") {
            // Strip the `- ` prefix and any surrounding quotes.
            let name = body
                .trim_start_matches("- ")
                .trim()
                .trim_matches('"')
                .trim_matches('\'');
            if !name.is_empty() {
                disabled.push(name.to_string());
            }
        } else if indent <= 2 {
            // Left the disabled list.
            in_disabled = false;
        }
    }
    disabled
}

/// Shape returned to the frontend.
#[tauri::command]
pub async fn hermes_skills_list() -> Result<Value, String> {
    let skills_dir = hermes_home().join("skills");
    if !skills_dir.exists() {
        return Ok(serde_json::json!([]));
    }
    let disabled_names = read_disabled_skills();
    let is_enabled = |name: &str| -> bool { !disabled_names.iter().any(|d| d == name) };

    let mut categories: Vec<Value> = Vec::new();
    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("Failed to read skills dir: {e}"))?;

    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let cat_name = entry.file_name().to_string_lossy().to_string();
        if cat_name.starts_with('.') {
            continue;
        }

        if ft.is_dir() {
            let cat_dir = skills_dir.join(&cat_name);

            // Category description from optional DESCRIPTION.md
            let cat_desc = std::fs::read_to_string(cat_dir.join("DESCRIPTION.md"))
                .ok()
                .map(|c| {
                    md_first_heading(&c)
                        .unwrap_or_else(|| c.trim().lines().next().unwrap_or("").to_string())
                })
                .unwrap_or_default();

            let mut skills: Vec<Value> = Vec::new();
            if let Ok(files) = std::fs::read_dir(&cat_dir) {
                for f in files.flatten() {
                    let fname = f.file_name().to_string_lossy().to_string();
                    let fpath = cat_dir.join(&fname);
                    let ftype = match f.file_type() {
                        Ok(t) => t,
                        Err(_) => continue,
                    };

                    // Structured skill: <category>/<skill>/SKILL.md
                    if ftype.is_dir() {
                        let skill_md = fpath.join("SKILL.md");
                        if !skill_md.exists() {
                            continue;
                        }
                        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
                        let display = md_first_heading(&content).unwrap_or_else(|| fname.clone());
                        let desc = md_first_description(&content);
                        skills.push(serde_json::json!({
                            "file": fname.clone(),
                            "name": display,
                            "slug": fname.clone(),
                            "description": desc,
                            "path": skill_md.to_string_lossy(),
                            "skill_dir": fpath.to_string_lossy(),
                            "isDir": true,
                            "enabled": is_enabled(&fname),
                        }));
                        continue;
                    }

                    // Legacy flat skill: <category>/<name>.md
                    if !fname.ends_with(".md") || fname == "DESCRIPTION.md" {
                        continue;
                    }
                    let content = std::fs::read_to_string(&fpath).unwrap_or_default();
                    let slug = fname.trim_end_matches(".md").to_string();
                    let display = md_first_heading(&content).unwrap_or_else(|| slug.clone());
                    let desc = md_first_description(&content);
                    skills.push(serde_json::json!({
                        "file": fname,
                        "name": display,
                        "slug": slug.clone(),
                        "description": desc,
                        "path": fpath.to_string_lossy(),
                        "isDir": false,
                        "enabled": is_enabled(&slug),
                    }));
                }
            }
            if !skills.is_empty() {
                skills.sort_by(|a, b| {
                    a["name"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["name"].as_str().unwrap_or(""))
                });
                categories.push(serde_json::json!({
                    "category": cat_name,
                    "description": cat_desc,
                    "skills": skills,
                }));
            }
        } else if cat_name.ends_with(".md") && cat_name != "DESCRIPTION.md" {
            // Uncategorized top-level skill file.
            let fpath = skills_dir.join(&cat_name);
            let content = std::fs::read_to_string(&fpath).unwrap_or_default();
            let slug = cat_name.trim_end_matches(".md").to_string();
            let display = md_first_heading(&content).unwrap_or_else(|| slug.clone());
            categories.push(serde_json::json!({
                "category": "_root",
                "description": "",
                "skills": [{
                    "file": cat_name,
                    "name": display,
                    "slug": slug.clone(),
                    "description": md_first_description(&content),
                    "path": fpath.to_string_lossy(),
                    "isDir": false,
                    "enabled": is_enabled(&slug),
                }],
            }));
        }
    }

    categories.sort_by(|a, b| {
        a["category"]
            .as_str()
            .unwrap_or("")
            .cmp(b["category"].as_str().unwrap_or(""))
    });

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

// ============================================================================
// Skills — enable/disable toggle (Phase 3)
// ============================================================================

/// Toggle a skill's enabled state by mutating `config.yaml`'s
/// `skills.disabled` list.
///
/// * `enabled = true`  → remove `name` from disabled list
/// * `enabled = false` → add `name` to disabled list
///
/// A `config.yaml.bak-<epoch>` backup is written before any mutation so
/// users can always recover a broken config.
#[tauri::command]
pub async fn hermes_skill_toggle(name: String, enabled: bool) -> Result<Value, String> {
    if name.is_empty() {
        return Err("Skill name is required".into());
    }
    let config_path = hermes_home().join("config.yaml");
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {e}"))?;

    // Write a timestamped backup before any mutation.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_path = hermes_home().join(format!("config.yaml.bak-{ts}"));
    let _ = std::fs::write(&backup_path, &raw);

    let patched = patch_yaml_toggle_skill(&raw, &name, enabled);
    std::fs::write(&config_path, &patched)
        .map_err(|e| format!("Failed to write config.yaml: {e}"))?;

    Ok(serde_json::json!({
        "ok": true,
        "skill": name,
        "enabled": enabled,
        "backup": backup_path.to_string_lossy(),
    }))
}

/// YAML patcher: add/remove `name` from `skills.disabled[]`.
///
/// Careful to preserve line ordering + indentation + other sections so that
/// user-edited comments and custom keys survive round-trips.
fn patch_yaml_toggle_skill(raw: &str, name: &str, enabled: bool) -> String {
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();

    // Find `skills:` top-level key.
    let skills_idx = lines.iter().position(|l| {
        let trimmed = l.trim_end();
        let indent = trimmed.len() - trimmed.trim_start().len();
        indent == 0 && trimmed.trim_start().starts_with("skills:")
    });

    // If no `skills:` block exists yet, synthesize one.
    if skills_idx.is_none() {
        if enabled {
            // Already enabled (not in any disabled list). Nothing to do.
            return raw.to_string();
        }
        // Append a new skills.disabled block.
        if !raw.is_empty() && !raw.ends_with('\n') {
            lines.push(String::new());
        }
        lines.push("skills:".to_string());
        lines.push("  disabled:".to_string());
        lines.push(format!("    - {name}"));
        lines.push(String::new());
        return lines.join("\n");
    }

    let skills_idx = skills_idx.unwrap();

    // Find `disabled:` under skills.
    let mut disabled_idx: Option<usize> = None;
    let mut i = skills_idx + 1;
    while i < lines.len() {
        let trimmed = lines[i].trim_end();
        let indent = trimmed.len() - trimmed.trim_start().len();
        if !trimmed.is_empty() && indent == 0 {
            break; // left the skills block
        }
        if indent == 2 && trimmed.trim_start().starts_with("disabled:") {
            disabled_idx = Some(i);
            break;
        }
        i += 1;
    }

    // Create a `disabled:` list if absent.
    if disabled_idx.is_none() {
        if enabled {
            // Already not disabled — nothing to do.
            return raw.to_string();
        }
        let insert_at = skills_idx + 1;
        lines.insert(insert_at, "  disabled:".to_string());
        lines.insert(insert_at + 1, format!("    - {name}"));
        return lines.join("\n");
    }

    let disabled_idx = disabled_idx.unwrap();

    // Collect existing list item line indices + their values.
    let mut item_rows: Vec<(usize, String)> = Vec::new();
    let mut j = disabled_idx + 1;
    while j < lines.len() {
        let trimmed = lines[j].trim_end();
        let indent = trimmed.len() - trimmed.trim_start().len();
        if !trimmed.is_empty() && indent < 4 {
            break;
        }
        let body = trimmed.trim_start();
        if body.starts_with("- ") {
            let v = body
                .trim_start_matches("- ")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            item_rows.push((j, v));
        }
        j += 1;
    }

    let has_item = item_rows.iter().any(|(_, v)| v == name);

    if enabled {
        // Remove all rows that match.
        if !has_item {
            return raw.to_string();
        }
        let to_remove: Vec<usize> = item_rows
            .iter()
            .filter(|(_, v)| v == name)
            .map(|(i, _)| *i)
            .collect();
        for idx in to_remove.iter().rev() {
            lines.remove(*idx);
        }
    } else {
        if has_item {
            return raw.to_string();
        }
        // Insert right after the `disabled:` key line or at the end of
        // existing items — whichever produces stable ordering.
        let insert_at = item_rows
            .last()
            .map(|(i, _)| *i + 1)
            .unwrap_or(disabled_idx + 1);
        lines.insert(insert_at, format!("    - {name}"));
    }

    lines.join("\n")
}

/// Recursively list all files inside a skill directory. Returns an array
/// of `{ path, name, isDir }` where `path` is relative to `~/.hermes/`.
/// Skips the top-level `SKILL.md` because the UI already renders it
/// separately in the detail pane.
#[tauri::command]
pub async fn hermes_skill_files(category: String, skill: String) -> Result<Value, String> {
    let skills_root = hermes_home().join("skills");
    let skill_dir = skills_root.join(&category).join(&skill);
    if !skill_dir.exists() || !skill_dir.is_dir() {
        return Ok(serde_json::json!([]));
    }

    let mut out: Vec<Value> = Vec::new();
    fn walk(root: &PathBuf, rel_base: &str, out: &mut Vec<Value>) {
        let entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if rel_base.is_empty() {
                name.clone()
            } else {
                format!("{rel_base}/{name}")
            };
            let full = root.join(&name);
            let is_dir = full.is_dir();
            // Skip the flagship SKILL.md at the root level.
            if rel_base.is_empty() && name == "SKILL.md" {
                continue;
            }
            out.push(serde_json::json!({
                "path": rel,
                "name": name,
                "isDir": is_dir,
            }));
            if is_dir {
                walk(&full, &rel, out);
            }
        }
    }
    walk(&skill_dir, "", &mut out);
    out.sort_by(|a, b| {
        a["path"]
            .as_str()
            .unwrap_or("")
            .cmp(b["path"].as_str().unwrap_or(""))
    });
    Ok(Value::Array(out))
}

/// Write (create/update) a skill file. Path must be inside
/// `~/.hermes/skills/`. Intermediate directories are auto-created.
#[tauri::command]
pub async fn hermes_skill_write(file_path: String, content: String) -> Result<String, String> {
    let skills_dir = hermes_home().join("skills");
    let target = PathBuf::from(&file_path);

    // Ensure the target lives under the skills directory. We compare
    // absolute-normalized paths to allow writing *new* files (which cannot
    // be canonicalized yet) while still rejecting traversal.
    let skills_canon = skills_dir
        .canonicalize()
        .map_err(|e| format!("Skills dir not accessible: {e}"))?;
    let target_abs = if target.is_absolute() {
        target.clone()
    } else {
        skills_dir.join(&target)
    };
    let parent = target_abs
        .parent()
        .ok_or_else(|| "Invalid target path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("Path error: {e}"))?;
    if !parent_canon.starts_with(&skills_canon) {
        return Err("Access denied".into());
    }
    std::fs::write(&target_abs, &content).map_err(|e| format!("Failed to write skill: {e}"))?;
    Ok("ok".into())
}

/// Resolve `memory|user|soul` to its filename inside `~/.hermes/memories/`.
fn memory_file_name(kind: &str) -> Option<&'static str> {
    match kind {
        "memory" => Some("MEMORY.md"),
        "user" => Some("USER.md"),
        "soul" => Some("SOUL.md"),
        _ => None,
    }
}

#[tauri::command]
pub async fn hermes_memory_read(r#type: Option<String>) -> Result<String, String> {
    let kind = r#type.as_deref().unwrap_or("memory");
    let file_name = memory_file_name(kind)
        .ok_or_else(|| format!("Invalid memory kind '{kind}' (expected memory|user|soul)"))?;
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
    let file_name = memory_file_name(kind)
        .ok_or_else(|| format!("Invalid memory kind '{kind}' (expected memory|user|soul)"))?;
    let mem_dir = hermes_home().join("memories");
    std::fs::create_dir_all(&mem_dir).map_err(|e| format!("Failed to create dir: {e}"))?;
    let file_path = mem_dir.join(file_name);
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write memory: {e}"))?;
    Ok("ok".into())
}

/// Read all memory sections (memory/user/soul) in one call, returning content
/// + last-modified UNIX timestamp (seconds) for each. A missing file yields an
/// empty string and `None` mtime — the caller shows "not yet written" state.
///
/// Shape is optimized for the frontend memory layout.
#[tauri::command]
pub async fn hermes_memory_read_all() -> Result<Value, String> {
    let mem_dir = hermes_home().join("memories");
    let section = |kind: &str| -> (String, Option<u64>) {
        let name = match memory_file_name(kind) {
            Some(n) => n,
            None => return (String::new(), None),
        };
        let path = mem_dir.join(name);
        if !path.exists() {
            return (String::new(), None);
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        (content, mtime)
    };
    let (memory, memory_mtime) = section("memory");
    let (user, user_mtime) = section("user");
    let (soul, soul_mtime) = section("soul");
    Ok(serde_json::json!({
        "memory": memory,
        "user": user,
        "soul": soul,
        "memory_mtime": memory_mtime,
        "user_mtime": user_mtime,
        "soul_mtime": soul_mtime,
    }))
}

fn downloads_dir_fallback() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn safe_download_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// Read an entire log file and save it to the user's Downloads/ClawPanel
/// directory. We refuse path traversal and only allow files whose canonical
/// path lives inside `~/.hermes/logs/`.
#[tauri::command]
pub async fn hermes_logs_download(name: String) -> Result<Value, String> {
    // Reject traversal before any disk access.
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("Invalid log file name".into());
    }
    let logs_dir = hermes_home().join("logs");
    let file_path = logs_dir.join(&name);
    // Canonicalize both sides to ensure symlinks/relative segments can't
    // escape the logs directory.
    let canon_dir = logs_dir
        .canonicalize()
        .map_err(|e| format!("Logs dir not found: {e}"))?;
    let canon_file = file_path
        .canonicalize()
        .map_err(|e| format!("Log file not found: {e}"))?;
    if !canon_file.starts_with(&canon_dir) {
        return Err("Access denied".into());
    }
    let content =
        std::fs::read_to_string(&canon_file).map_err(|e| format!("Failed to read log: {e}"))?;
    let out_dir = downloads_dir_fallback().join("ClawPanel");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create download dir: {e}"))?;
    let out_path = out_dir.join(safe_download_filename(&name));
    std::fs::write(&out_path, content).map_err(|e| format!("Failed to save log: {e}"))?;
    Ok(serde_json::json!({
        "path": out_path.to_string_lossy().to_string(),
    }))
}

// ============================================================================
// api_server guardian
//
// ClawPanel's Hermes integration requires `platforms.api_server.enabled: true`
// in ~/.hermes/config.yaml so that `hermes gateway run` exposes the
// /v1/runs endpoint we depend on. The setting is written once by
// `configure_hermes`, but config changes can remove it.
//   * Migration scripts accidentally drop the section.
//
// Rather than silently failing at Gateway start time with an opaque
// "endpoint not found" error, this guardian checks before every start and
// auto-heals the config. A timestamped backup (config.yaml.bak-<epoch>)
// is written before any mutation so users can always roll back.
// ============================================================================

/// Scan a YAML string for `platforms.api_server.enabled: true` and return
/// true only when that exact path exists with a truthy value.
fn config_has_api_server_enabled(raw: &str) -> bool {
    let mut in_platforms = false;
    let mut in_api_server = false;
    for line in raw.lines() {
        // Strip comments (crude, but matches the simple YAML we write).
        let line = match line.find('#') {
            Some(i) => &line[..i],
            None => line,
        };
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();

        if indent == 0 {
            in_platforms = trimmed.trim_start().starts_with("platforms:");
            in_api_server = false;
            continue;
        }
        if !in_platforms {
            continue;
        }
        // Inside platforms:
        if indent <= 2 {
            in_api_server = trimmed.trim_start().starts_with("api_server:");
            continue;
        }
        if !in_api_server {
            continue;
        }
        // Inside platforms.api_server:
        let t = trimmed.trim_start();
        if let Some(rest) = t.strip_prefix("enabled:") {
            let v = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            return matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1");
        }
    }
    false
}

/// Produce a patched YAML that guarantees
/// `platforms.api_server.enabled: true` is present, preserving everything
/// else verbatim. If the config already has the setting (as `true`) this
/// returns the original text unchanged.
fn patch_yaml_ensure_api_server(raw: &str) -> String {
    if config_has_api_server_enabled(raw) {
        return raw.to_string();
    }

    // Strategy:
    //   * If `platforms:` exists, inject / replace api_server subtree under it.
    //   * Otherwise append a new top-level `platforms:` block at EOF.
    let lines: Vec<&str> = raw.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 4);
    let mut platforms_found = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_end();
        let indent = trimmed.len() - trimmed.trim_start().len();

        if indent == 0 && trimmed.trim_start().starts_with("platforms:") {
            // Copy the platforms: header
            out.push(line.to_string());
            platforms_found = true;
            i += 1;
            // Accumulate children and drop the existing api_server subtree
            // (we'll rewrite it at the top of the block). Keep siblings.
            let mut accumulated_children: Vec<String> = Vec::new();
            let mut skipping_api_server = false;
            while i < lines.len() {
                let l = lines[i];
                let t = l.trim_end();
                let ind = t.len() - t.trim_start().len();
                if ind == 0 && !t.is_empty() {
                    break; // leaving platforms block
                }
                if ind <= 2 {
                    skipping_api_server = t.trim_start().starts_with("api_server:");
                }
                if !skipping_api_server {
                    accumulated_children.push(l.to_string());
                }
                i += 1;
            }
            // Inject a fresh api_server entry at the top of platforms:
            out.push("  api_server:".into());
            out.push("    enabled: true".into());
            out.extend(accumulated_children);
            continue;
        }
        out.push(line.to_string());
        i += 1;
    }

    if !platforms_found {
        if let Some(last) = out.last() {
            if !last.is_empty() {
                out.push(String::new());
            }
        }
        out.push("platforms:".into());
        out.push("  api_server:".into());
        out.push("    enabled: true".into());
    }

    let mut content = out.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content
}

/// Guardian called from `hermes_gateway_action` on every `start` request.
/// Returns Ok(()) when the config is healthy (either it was already correct
/// or the patch succeeded). Emits `hermes-config-patched` on auto-heal so
/// the frontend can display a transparent toast.
fn ensure_api_server_enabled(app: &tauri::AppHandle) -> Result<(), String> {
    let config_path = hermes_home().join("config.yaml");
    if !config_path.exists() {
        // Nothing to guard — configure_hermes will create a compliant file
        // on first run. Don't auto-create here; that's outside the guard's
        // responsibility.
        return Ok(());
    }
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {e}"))?;
    if config_has_api_server_enabled(&raw) {
        return Ok(());
    }

    // Back up with a timestamped filename so we never overwrite an earlier
    // .bak (rapid re-starts would lose history otherwise).
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_path = config_path.with_extension(format!("yaml.bak-{ts}"));
    let _ = std::fs::write(&backup_path, &raw);

    let patched = patch_yaml_ensure_api_server(&raw);
    std::fs::write(&config_path, &patched)
        .map_err(|e| format!("Failed to write config.yaml: {e}"))?;

    // Inform the frontend so it can surface a toast. Failure to emit is
    // non-fatal — the patch itself already succeeded.
    use tauri::Emitter;
    let _ = app.emit(
        "hermes-config-patched",
        serde_json::json!({
            "kind": "api_server_enabled",
            "backup": backup_path.to_string_lossy(),
            "message": "platforms.api_server.enabled 缺失，已自动修复并备份原文件",
        }),
    );
    Ok(())
}

// ============================================================================
// .env editor commands
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

#[tauri::command]
pub fn hermes_config_raw_read() -> Result<Value, String> {
    let path = hermes_home().join("config.yaml");
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(serde_json::json!({ "yaml": yaml }))
}

#[tauri::command]
pub fn hermes_config_raw_write(yaml_text: String) -> Result<Value, String> {
    let path = hermes_home().join("config.yaml");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_extension(format!("yaml.bak-{ts}"));
        let _ = std::fs::copy(&path, backup);
    }
    std::fs::write(&path, yaml_text).map_err(|e| format!("Failed to write config.yaml: {e}"))?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn hermes_env_reveal(key: String) -> Result<Value, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Key cannot be empty".into());
    }
    let env_path = hermes_home().join(".env");
    let raw =
        std::fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env: {e}"))?;
    for (k, v, _) in parse_env_file_lines(&raw) {
        if k == key {
            return Ok(serde_json::json!({ "key": key, "value": v }));
        }
    }
    Err(format!("{key} not found in .env"))
}

fn hermes_dashboard_theme_name(raw: &str) -> String {
    let mut in_dashboard = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_dashboard = t == "dashboard:" || t.starts_with("dashboard:");
            if t.starts_with("dashboard:") && t != "dashboard:" {
                return t
                    .trim_start_matches("dashboard:")
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
            }
            continue;
        }
        if in_dashboard && t.starts_with("theme:") {
            return t
                .trim_start_matches("theme:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
        }
    }
    "default".into()
}

fn patch_dashboard_theme(raw: &str, name: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_dashboard = false;
    let mut dashboard_seen = false;
    let mut theme_written = false;
    for line in raw.lines() {
        let t = line.trim();
        let indent = line.len() - line.trim_start().len();
        if indent == 0 && !t.is_empty() && !t.starts_with('#') {
            if in_dashboard && !theme_written {
                out.push(format!("  theme: {name}"));
                theme_written = true;
            }
            in_dashboard = t == "dashboard:" || t.starts_with("dashboard:");
            if in_dashboard {
                dashboard_seen = true;
            }
        }
        if in_dashboard && indent > 0 && t.starts_with("theme:") {
            out.push(format!("{}theme: {name}", " ".repeat(indent)));
            theme_written = true;
            continue;
        }
        out.push(line.to_string());
    }
    if in_dashboard && !theme_written {
        out.push(format!("  theme: {name}"));
    }
    if !dashboard_seen {
        if out.last().map(|s| !s.is_empty()).unwrap_or(false) {
            out.push(String::new());
        }
        out.push("dashboard:".into());
        out.push(format!("  theme: {name}"));
    }
    let mut content = out.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content
}

#[tauri::command]
pub fn hermes_dashboard_themes() -> Result<Value, String> {
    let config_raw = std::fs::read_to_string(hermes_home().join("config.yaml")).unwrap_or_default();
    let active = hermes_dashboard_theme_name(&config_raw);
    let mut themes = vec![
        serde_json::json!({ "name": "default", "label": "Default", "description": "Hermes default dashboard theme" }),
        serde_json::json!({ "name": "midnight", "label": "Midnight", "description": "Dark blue dashboard theme" }),
        serde_json::json!({ "name": "ember", "label": "Ember", "description": "Warm dashboard theme" }),
        serde_json::json!({ "name": "mono", "label": "Mono", "description": "Monochrome dashboard theme" }),
        serde_json::json!({ "name": "cyberpunk", "label": "Cyberpunk", "description": "Neon dashboard theme" }),
        serde_json::json!({ "name": "rose", "label": "Rose", "description": "Soft rose dashboard theme" }),
    ];
    let dir = hermes_home().join("dashboard-themes");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ext_ok = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("yaml") || s.eq_ignore_ascii_case("yml"))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                themes.push(serde_json::json!({
                    "name": name,
                    "label": name,
                    "description": "User dashboard theme",
                }));
            }
        }
    }
    Ok(serde_json::json!({ "themes": themes, "active": active }))
}

#[tauri::command]
pub fn hermes_dashboard_theme_set(name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Theme name cannot be empty".into());
    }
    let path = hermes_home().join("config.yaml");
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    std::fs::write(&path, patch_dashboard_theme(&raw, &name))
        .map_err(|e| format!("Failed to write config.yaml: {e}"))?;
    Ok(serde_json::json!({ "ok": true, "theme": name }))
}

fn scan_dashboard_plugins() -> Vec<Value> {
    let mut plugins = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let roots = [hermes_home().join("plugins")];
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let manifest = dir.join("dashboard").join("manifest.json");
                if !manifest.exists() {
                    continue;
                }
                let raw = match std::fs::read_to_string(&manifest) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let data: Value = match serde_json::from_str(&raw) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let name = data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| dir.file_name().and_then(|s| s.to_str()))
                    .unwrap_or("");
                if name.is_empty() || !seen.insert(name.to_string()) {
                    continue;
                }
                let tab = data.get("tab").cloned().unwrap_or_else(
                    || serde_json::json!({ "path": format!("/{name}"), "position": "end" }),
                );
                plugins.push(serde_json::json!({
                    "name": name,
                    "label": data.get("label").and_then(|v| v.as_str()).unwrap_or(name),
                    "description": data.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    "icon": data.get("icon").and_then(|v| v.as_str()).unwrap_or("Puzzle"),
                    "version": data.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0"),
                    "tab": tab,
                    "slots": data.get("slots").cloned().unwrap_or_else(|| serde_json::json!([])),
                    "entry": data.get("entry").and_then(|v| v.as_str()).unwrap_or("dist/index.js"),
                    "css": data.get("css").cloned().unwrap_or(Value::Null),
                    "has_api": data.get("api").is_some(),
                    "source": "user",
                }));
            }
        }
    }
    plugins
}

#[tauri::command]
pub fn hermes_dashboard_plugins() -> Result<Value, String> {
    Ok(Value::Array(scan_dashboard_plugins()))
}

#[tauri::command]
pub fn hermes_dashboard_plugins_rescan() -> Result<Value, String> {
    let plugins = scan_dashboard_plugins();
    Ok(serde_json::json!({ "ok": true, "count": plugins.len() }))
}

#[tauri::command]
pub fn hermes_toolsets_list() -> Result<Value, String> {
    let output = run_silent("hermes", &["tools", "list", "--platform", "cli"]).unwrap_or_default();
    Ok(serde_json::json!({ "raw": output }))
}

#[tauri::command]
pub fn hermes_cron_jobs_list() -> Result<Value, String> {
    let path = hermes_home().join("cron").join("jobs.json");
    if !path.exists() {
        return Ok(Value::Array(Vec::new()));
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read cron jobs: {e}"))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("Failed to parse cron jobs: {e}"))
}

// ============================================================================
// Unit tests for the pure YAML helpers (no filesystem I/O).
// ============================================================================

#[cfg(test)]
mod guardian_tests {
    use super::{config_has_api_server_enabled, patch_yaml_ensure_api_server};

    #[test]
    fn detects_enabled_variants() {
        let yaml = "\
model:
  default: deepseek-chat
platforms:
  api_server:
    enabled: true
";
        assert!(config_has_api_server_enabled(yaml));

        for v in ["true", "True", "TRUE", "yes", "on", "1"] {
            let y = format!("platforms:\n  api_server:\n    enabled: {v}\n");
            assert!(
                config_has_api_server_enabled(&y),
                "expected {v} to count as enabled"
            );
        }
    }

    #[test]
    fn detects_missing_or_disabled() {
        assert!(!config_has_api_server_enabled("model:\n  default: foo\n"));
        assert!(!config_has_api_server_enabled(
            "platforms:\n  other:\n    enabled: true\n"
        ));
        assert!(!config_has_api_server_enabled(
            "platforms:\n  api_server:\n    enabled: false\n"
        ));
        assert!(!config_has_api_server_enabled(
            "platforms:\n  api_server:\n    something: else\n"
        ));
    }

    #[test]
    fn ignores_commented_enabled() {
        let yaml = "platforms:\n  api_server:\n    # enabled: true\n";
        assert!(!config_has_api_server_enabled(yaml));
    }

    #[test]
    fn patch_is_noop_when_already_enabled() {
        let yaml = "\
model:
  default: x
platforms:
  api_server:
    enabled: true
";
        assert_eq!(patch_yaml_ensure_api_server(yaml), yaml);
    }

    #[test]
    fn patch_appends_when_no_platforms() {
        let yaml = "model:\n  default: x\n";
        let patched = patch_yaml_ensure_api_server(yaml);
        assert!(config_has_api_server_enabled(&patched));
        assert!(patched.contains("model:"));
        assert!(patched.contains("default: x"));
    }

    #[test]
    fn patch_injects_under_existing_platforms() {
        let yaml = "\
platforms:
  other:
    enabled: true
terminal:
  backend: local
";
        let patched = patch_yaml_ensure_api_server(yaml);
        assert!(config_has_api_server_enabled(&patched));
        assert!(patched.contains("other:"));
        assert!(patched.contains("terminal:"));
        assert!(patched.contains("backend: local"));
    }

    #[test]
    fn patch_replaces_disabled_api_server() {
        let yaml = "\
platforms:
  api_server:
    enabled: false
    extra: keepme
  other:
    enabled: true
";
        let patched = patch_yaml_ensure_api_server(yaml);
        assert!(config_has_api_server_enabled(&patched));
        assert!(patched.contains("other:"));
        assert!(
            !patched.contains("enabled: false"),
            "disabled marker should have been removed"
        );
    }
}
