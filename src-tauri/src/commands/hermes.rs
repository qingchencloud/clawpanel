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
static GW_STARTING: AtomicBool = AtomicBool::new(false);
/// 缓存 AppHandle 供 guardian 发送事件
static GW_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

struct GatewayStartGuard;

impl Drop for GatewayStartGuard {
    fn drop(&mut self) {
        GW_STARTING.store(false, Ordering::SeqCst);
    }
}

fn try_gateway_start_guard() -> Option<GatewayStartGuard> {
    GW_STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| GatewayStartGuard)
}

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
    let _ = sanitize_hermes_openrouter_custom_mismatch()?;
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

fn normalize_provider_url(raw: &str) -> String {
    let mut out = raw.trim().trim_end_matches('/').to_ascii_lowercase();
    for suffix in [
        "/chat/completions",
        "/completions",
        "/responses",
        "/messages",
        "/models",
    ] {
        if out.ends_with(suffix) {
            out.truncate(out.len() - suffix.len());
            break;
        }
    }
    out
}

fn normalize_hermes_provider_for_base_url(provider: &str, base_url: Option<&str>) -> String {
    let pid = provider.trim();
    if pid == "openrouter" {
        if let Some(url) = base_url {
            let base = normalize_provider_url(url);
            let expected = normalize_provider_url("https://openrouter.ai/api/v1");
            if !base.is_empty() && base != expected {
                return "custom".into();
            }
        }
    }
    pid.to_string()
}

fn env_file_has_value(raw: &str, key: &str) -> bool {
    raw.lines().any(|line| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return false;
        }
        t.split_once('=')
            .map(|(k, v)| k.trim() == key && !v.trim().is_empty())
            .unwrap_or(false)
    })
}

fn env_file_value(raw: &str, key: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return None;
        }
        t.split_once('=').and_then(|(k, v)| {
            if k.trim() == key {
                let value = v.trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            } else {
                None
            }
        })
    })
}

fn ensure_custom_openai_key_alias() -> Result<bool, String> {
    let env_path = hermes_home().join(".env");
    if !env_path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(&env_path).map_err(|e| format!("读取 .env 失败: {e}"))?;
    if env_file_has_value(&raw, "OPENAI_API_KEY") {
        return Ok(false);
    }
    let Some(custom_key) = env_file_value(&raw, "CUSTOM_API_KEY") else {
        return Ok(false);
    };
    let mut fixed = raw;
    if !fixed.ends_with('\n') {
        fixed.push('\n');
    }
    fixed.push_str(&format!("OPENAI_API_KEY={custom_key}\n"));
    std::fs::write(&env_path, fixed).map_err(|e| format!("写入 .env 失败: {e}"))?;
    Ok(true)
}

fn sanitize_hermes_openrouter_custom_mismatch() -> Result<bool, String> {
    let home = hermes_home();
    let config_path = home.join("config.yaml");
    if !config_path.exists() {
        return Ok(false);
    }

    let raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取 config.yaml 失败: {e}"))?;
    let mut provider = String::new();
    let mut base_url = String::new();
    let mut in_model = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model:") {
            in_model = true;
            continue;
        }
        if in_model {
            let indented = line.starts_with(' ') || line.starts_with('\t');
            if !indented && !trimmed.is_empty() && !trimmed.starts_with('#') {
                break;
            }
            if let Some(v) = trimmed.strip_prefix("provider:") {
                provider = v.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(v) = trimmed.strip_prefix("base_url:") {
                base_url = v.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
    }

    let base = normalize_provider_url(&base_url);
    let expected = normalize_provider_url("https://openrouter.ai/api/v1");
    let uses_custom_endpoint = !base.is_empty() && base != expected;
    let alias_changed = if provider.is_empty() || provider == "custom" || uses_custom_endpoint {
        ensure_custom_openai_key_alias()?
    } else {
        false
    };
    if !uses_custom_endpoint {
        return Ok(alias_changed);
    }
    if provider == "custom" {
        return Ok(alias_changed);
    }

    let mut out = Vec::new();
    let mut in_model = false;
    let mut provider_written = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model:") {
            in_model = true;
            provider_written = false;
            out.push(line.to_string());
            continue;
        }
        if in_model {
            let indented = line.starts_with(' ') || line.starts_with('\t');
            if !indented && !trimmed.is_empty() && !trimmed.starts_with('#') {
                in_model = false;
                if !provider_written {
                    out.push("  provider: custom".to_string());
                    provider_written = true;
                }
            } else if trimmed.starts_with("provider:") {
                out.push("  provider: custom".to_string());
                provider_written = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if in_model && !provider_written {
        out.push("  provider: custom".to_string());
    }
    let mut fixed = out.join("\n");
    if !fixed.ends_with('\n') {
        fixed.push('\n');
    }
    std::fs::write(&config_path, fixed).map_err(|e| format!("写入 config.yaml 失败: {e}"))?;
    Ok(true)
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
        "tool",
        "install",
        "--force",
        &pkg,
        "--python",
        "3.11",
        "--with",
        "croniter",
        "--with",
        "httpx",
        "--with",
        "openai",
        "--with",
        "aiohttp",
        "--with",
        "websockets",
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
        "uv tool install hermes-agent --python 3.11 --with croniter --with httpx --with openai --with aiohttp --with websockets",
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

    let provider = normalize_hermes_provider_for_base_url(&provider, base_url.as_deref());
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
    // `custom` 也需要显式写入，避免自定义端点被默认路由接管。
    let provider_line = if provider.is_empty() {
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
            if provider == "custom" && env != "CUSTOM_API_KEY" {
                new_pairs.push(("CUSTOM_API_KEY".into(), api_key.trim().into()));
            }
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
            // provider_line 仅在非空时写入，确保模型路由稳定。
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
// Hermes 渠道配置 — 读写 ~/.hermes/config.yaml 的 platforms.<platform>，
// 并同步 Hermes 运行时仍会读取的 .env 变量。
// ---------------------------------------------------------------------------

const HERMES_CHANNEL_PLATFORMS: [&str; 10] = [
    "telegram",
    "discord",
    "slack",
    "feishu",
    "dingtalk",
    "teams",
    "google_chat",
    "irc",
    "line",
    "simplex",
];

const HERMES_DISPLAY_TOOL_PROGRESS_VALUES: [&str; 4] = ["off", "new", "all", "verbose"];
const HERMES_DISPLAY_STREAMING_VALUES: [&str; 3] = ["inherit", "true", "false"];

fn normalize_hermes_channel_platform(platform: &str) -> Option<&'static str> {
    let platform = platform.trim().to_ascii_lowercase();
    HERMES_CHANNEL_PLATFORMS
        .iter()
        .copied()
        .find(|item| *item == platform)
}

fn normalize_hermes_display_tool_progress(
    value: Option<String>,
    strict: bool,
    key: &str,
) -> Result<String, String> {
    let progress = value.unwrap_or_default().trim().to_ascii_lowercase();
    let progress = if progress.is_empty() {
        "all".to_string()
    } else {
        progress
    };
    if HERMES_DISPLAY_TOOL_PROGRESS_VALUES.contains(&progress.as_str()) {
        Ok(progress)
    } else if strict {
        Err(format!("{key} 必须是 off、new、all 或 verbose"))
    } else {
        Ok("all".to_string())
    }
}

fn normalize_hermes_display_streaming_text(
    value: Option<String>,
    strict: bool,
    key: &str,
) -> Result<String, String> {
    let streaming = value.unwrap_or_default().trim().to_ascii_lowercase();
    let streaming = if streaming.is_empty() {
        "inherit".to_string()
    } else {
        streaming
    };
    if HERMES_DISPLAY_STREAMING_VALUES.contains(&streaming.as_str()) {
        Ok(streaming)
    } else if strict {
        Err(format!("{key} 必须是 inherit、true 或 false"))
    } else {
        Ok("inherit".to_string())
    }
}

fn normalize_hermes_display_streaming_yaml(
    value: Option<&serde_yaml::Value>,
    strict: bool,
    key: &str,
) -> Result<String, String> {
    if let Some(value) = value {
        if let Some(value) = value.as_bool() {
            return Ok(if value { "true" } else { "false" }.to_string());
        }
        if let Some(value) = value.as_str() {
            return normalize_hermes_display_streaming_text(Some(value.to_string()), strict, key);
        }
    }
    normalize_hermes_display_streaming_text(None, strict, key)
}

fn normalize_hermes_display_streaming_json(
    value: Option<&Value>,
    strict: bool,
    key: &str,
) -> Result<String, String> {
    if let Some(value) = value {
        if let Some(value) = value.as_bool() {
            return Ok(if value { "true" } else { "false" }.to_string());
        }
        if let Some(value) = value.as_str() {
            return normalize_hermes_display_streaming_text(Some(value.to_string()), strict, key);
        }
    }
    normalize_hermes_display_streaming_text(None, strict, key)
}

fn yaml_key(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_string())
}

fn yaml_get<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a serde_yaml::Value> {
    map.get(yaml_key(key))
}

fn yaml_get_mapping<'a>(
    map: &'a serde_yaml::Mapping,
    key: &str,
) -> Option<&'a serde_yaml::Mapping> {
    yaml_get(map, key).and_then(|v| v.as_mapping())
}

fn yaml_string_field(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    yaml_get(map, key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn yaml_string_sequence_field(map: &serde_yaml::Mapping, key: &str) -> Vec<String> {
    yaml_get(map, key)
        .and_then(|value| value.as_sequence())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn yaml_scalar_string_field(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    let value = yaml_get(map, key)?;
    if let Some(value) = value.as_str() {
        Some(value.to_string())
    } else if let Some(value) = value.as_i64() {
        Some(value.to_string())
    } else if let Some(value) = value.as_u64() {
        Some(value.to_string())
    } else {
        value.as_f64().map(|value| {
            if value.fract() == 0.0 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        })
    }
}

fn yaml_bool_field(map: &serde_yaml::Mapping, key: &str) -> Option<bool> {
    yaml_get(map, key).and_then(|v| v.as_bool())
}

fn yaml_csv_field(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    let value = yaml_get(map, key)?;
    if let Some(items) = value.as_sequence() {
        let joined = items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    } else {
        value
            .as_str()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

fn insert_json_string_if_present(
    form: &mut serde_json::Map<String, Value>,
    source: &serde_yaml::Mapping,
    yaml_key: &str,
    json_key: &str,
) {
    if let Some(value) = yaml_string_field(source, yaml_key) {
        form.insert(json_key.to_string(), Value::String(value));
    }
}

fn insert_json_scalar_string_if_present(
    form: &mut serde_json::Map<String, Value>,
    source: &serde_yaml::Mapping,
    yaml_key: &str,
    json_key: &str,
) {
    if let Some(value) = yaml_scalar_string_field(source, yaml_key) {
        form.insert(json_key.to_string(), Value::String(value));
    }
}

fn insert_json_bool_if_present(
    form: &mut serde_json::Map<String, Value>,
    source: &serde_yaml::Mapping,
    yaml_key: &str,
    json_key: &str,
) {
    if let Some(value) = yaml_bool_field(source, yaml_key) {
        form.insert(json_key.to_string(), Value::Bool(value));
    }
}

fn insert_json_csv_if_present(
    form: &mut serde_json::Map<String, Value>,
    source: &serde_yaml::Mapping,
    yaml_key: &str,
    json_key: &str,
) {
    if let Some(value) = yaml_csv_field(source, yaml_key) {
        form.insert(json_key.to_string(), Value::String(value));
    }
}

fn hermes_env_value(
    env_values: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<String> {
    env_values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_hermes_channel_env_values() -> std::collections::HashMap<String, String> {
    let env_path = hermes_home().join(".env");
    let raw = std::fs::read_to_string(&env_path).unwrap_or_default();
    let mut values = std::collections::HashMap::new();
    for (key, value, _) in parse_env_file_lines(&raw) {
        values.entry(key).or_insert(value);
    }
    values
}

fn json_form_string(form: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    form.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn put_json_string_from_env(
    form: &mut serde_json::Map<String, Value>,
    env_values: &std::collections::HashMap<String, String>,
    env_key: &str,
    json_key: &str,
) {
    if let Some(value) = hermes_env_value(env_values, env_key) {
        form.insert(json_key.to_string(), Value::String(value));
    }
}

fn put_json_bool_from_env(
    form: &mut serde_json::Map<String, Value>,
    env_values: &std::collections::HashMap<String, String>,
    env_key: &str,
    json_key: &str,
) {
    if let Some(value) = hermes_env_value(env_values, env_key) {
        let enabled = matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        );
        form.insert(json_key.to_string(), Value::Bool(enabled));
    }
}

fn insert_hermes_home_channel_if_present(
    form: &mut serde_json::Map<String, Value>,
    entry: &serde_yaml::Mapping,
) {
    let Some(home) = yaml_get_mapping(entry, "home_channel") else {
        return;
    };
    if let Some(value) = yaml_string_field(home, "chat_id") {
        form.insert("homeChannel".to_string(), Value::String(value));
    }
    if let Some(value) = yaml_string_field(home, "name") {
        form.insert("homeChannelName".to_string(), Value::String(value));
    }
}

fn insert_hermes_channel_display_fields(
    form: &mut serde_json::Map<String, Value>,
    config: &serde_yaml::Value,
    platform: &str,
) {
    let display = config
        .as_mapping()
        .and_then(|map| yaml_get_mapping(map, "display"));
    let platform_display = display
        .and_then(|map| yaml_get_mapping(map, "platforms"))
        .and_then(|map| yaml_get_mapping(map, platform));
    let legacy_tool_progress = display
        .and_then(|map| yaml_get_mapping(map, "tool_progress_overrides"))
        .and_then(|map| yaml_string_field(map, platform));
    let tool_progress = normalize_hermes_display_tool_progress(
        platform_display
            .and_then(|map| yaml_string_field(map, "tool_progress"))
            .or(legacy_tool_progress)
            .or_else(|| display.and_then(|map| yaml_string_field(map, "tool_progress"))),
        false,
        "display.tool_progress",
    )
    .unwrap_or_else(|_| "all".to_string());
    let show_reasoning = platform_display
        .and_then(|map| yaml_bool_field(map, "show_reasoning"))
        .or_else(|| display.and_then(|map| yaml_bool_field(map, "show_reasoning")))
        .unwrap_or(false);
    let tool_preview_length = bounded_hermes_i64(
        platform_display
            .and_then(|map| yaml_i64_field(map, "tool_preview_length"))
            .or_else(|| display.and_then(|map| yaml_i64_field(map, "tool_preview_length"))),
        0,
        0,
        200000,
    );
    let streaming = if let Some(platform_display) = platform_display {
        if let Some(value) = yaml_get(platform_display, "streaming") {
            normalize_hermes_display_streaming_yaml(
                Some(value),
                false,
                "display.platforms.streaming",
            )
            .unwrap_or_else(|_| "inherit".to_string())
        } else {
            "inherit".to_string()
        }
    } else {
        "inherit".to_string()
    };
    let cleanup_progress = platform_display
        .and_then(|map| yaml_bool_field(map, "cleanup_progress"))
        .or_else(|| display.and_then(|map| yaml_bool_field(map, "cleanup_progress")))
        .unwrap_or(false);

    form.insert(
        "displayToolProgress".to_string(),
        Value::String(tool_progress),
    );
    form.insert(
        "displayShowReasoning".to_string(),
        Value::Bool(show_reasoning),
    );
    form.insert(
        "displayToolPreviewLength".to_string(),
        Value::Number(tool_preview_length.into()),
    );
    form.insert("displayStreaming".to_string(), Value::String(streaming));
    form.insert(
        "displayCleanupProgress".to_string(),
        Value::Bool(cleanup_progress),
    );
}

fn build_hermes_channel_config_values(
    config: &serde_yaml::Value,
    env_values: &std::collections::HashMap<String, String>,
) -> Value {
    let mut values = serde_json::Map::new();
    let root = config.as_mapping();
    let platforms = root.and_then(|map| yaml_get_mapping(map, "platforms"));

    for platform in HERMES_CHANNEL_PLATFORMS {
        let entry = platforms
            .and_then(|map| yaml_get_mapping(map, platform))
            .cloned()
            .unwrap_or_default();
        let extra = yaml_get_mapping(&entry, "extra")
            .cloned()
            .unwrap_or_default();
        let mut form = serde_json::Map::new();
        form.insert(
            "enabled".to_string(),
            Value::Bool(yaml_bool_field(&entry, "enabled").unwrap_or(false)),
        );

        match platform {
            "telegram" => {
                let token = hermes_env_value(env_values, "TELEGRAM_BOT_TOKEN")
                    .or_else(|| yaml_string_field(&entry, "token"))
                    .unwrap_or_default();
                form.insert("botToken".to_string(), Value::String(token));
            }
            "discord" => {
                let token = hermes_env_value(env_values, "DISCORD_BOT_TOKEN")
                    .or_else(|| yaml_string_field(&entry, "token"))
                    .unwrap_or_default();
                form.insert("token".to_string(), Value::String(token));
                for (yaml_key_name, json_key_name, env_key_name) in [
                    (
                        "free_response_channels",
                        "freeResponseChannels",
                        "DISCORD_FREE_RESPONSE_CHANNELS",
                    ),
                    (
                        "allowed_channels",
                        "allowedChannels",
                        "DISCORD_ALLOWED_CHANNELS",
                    ),
                    (
                        "ignored_channels",
                        "ignoredChannels",
                        "DISCORD_IGNORED_CHANNELS",
                    ),
                    (
                        "no_thread_channels",
                        "noThreadChannels",
                        "DISCORD_NO_THREAD_CHANNELS",
                    ),
                ] {
                    insert_json_csv_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                    put_json_string_from_env(&mut form, env_values, env_key_name, json_key_name);
                }
                for (yaml_key_name, json_key_name, env_key_name) in [
                    ("auto_thread", "autoThread", "DISCORD_AUTO_THREAD"),
                    ("reactions", "reactions", "DISCORD_REACTIONS"),
                    (
                        "thread_require_mention",
                        "threadRequireMention",
                        "DISCORD_THREAD_REQUIRE_MENTION",
                    ),
                    (
                        "history_backfill",
                        "historyBackfill",
                        "DISCORD_HISTORY_BACKFILL",
                    ),
                ] {
                    insert_json_bool_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                    put_json_bool_from_env(&mut form, env_values, env_key_name, json_key_name);
                }
                insert_json_string_if_present(
                    &mut form,
                    &extra,
                    "history_backfill_limit",
                    "historyBackfillLimit",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "DISCORD_HISTORY_BACKFILL_LIMIT",
                    "historyBackfillLimit",
                );
                insert_json_string_if_present(&mut form, &extra, "reply_to_mode", "replyToMode");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "DISCORD_REPLY_TO_MODE",
                    "replyToMode",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "DISCORD_HOME_CHANNEL",
                    "homeChannel",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "DISCORD_HOME_CHANNEL_NAME",
                    "homeChannelName",
                );
            }
            "slack" => {
                let bot_token = hermes_env_value(env_values, "SLACK_BOT_TOKEN")
                    .or_else(|| yaml_string_field(&entry, "token"))
                    .unwrap_or_default();
                form.insert("botToken".to_string(), Value::String(bot_token));
                insert_json_string_if_present(&mut form, &extra, "app_token", "appToken");
                let app_token = hermes_env_value(env_values, "SLACK_APP_TOKEN")
                    .or_else(|| json_form_string(&form, "appToken"))
                    .unwrap_or_default();
                form.insert("appToken".to_string(), Value::String(app_token));
                insert_json_string_if_present(&mut form, &extra, "signing_secret", "signingSecret");
                insert_json_string_if_present(&mut form, &extra, "webhook_path", "webhookPath");
            }
            "feishu" => {
                insert_json_string_if_present(&mut form, &extra, "app_id", "appId");
                insert_json_string_if_present(&mut form, &extra, "app_secret", "appSecret");
                insert_json_string_if_present(&mut form, &extra, "domain", "domain");
                insert_json_string_if_present(
                    &mut form,
                    &extra,
                    "connection_mode",
                    "connectionMode",
                );
                insert_json_string_if_present(&mut form, &extra, "webhook_path", "webhookPath");
                insert_json_string_if_present(
                    &mut form,
                    &extra,
                    "reaction_notifications",
                    "reactionNotifications",
                );
                put_json_string_from_env(&mut form, env_values, "FEISHU_APP_ID", "appId");
                put_json_string_from_env(&mut form, env_values, "FEISHU_APP_SECRET", "appSecret");
                put_json_string_from_env(&mut form, env_values, "FEISHU_DOMAIN", "domain");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "FEISHU_CONNECTION_MODE",
                    "connectionMode",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "FEISHU_WEBHOOK_PATH",
                    "webhookPath",
                );
                insert_json_bool_if_present(
                    &mut form,
                    &extra,
                    "typing_indicator",
                    "typingIndicator",
                );
                insert_json_bool_if_present(
                    &mut form,
                    &extra,
                    "resolve_sender_names",
                    "resolveSenderNames",
                );
            }
            "dingtalk" => {
                insert_json_string_if_present(&mut form, &extra, "client_id", "clientId");
                insert_json_string_if_present(&mut form, &extra, "client_secret", "clientSecret");
                put_json_string_from_env(&mut form, env_values, "DINGTALK_CLIENT_ID", "clientId");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "DINGTALK_CLIENT_SECRET",
                    "clientSecret",
                );
            }
            "teams" => {
                for (yaml_key_name, json_key_name) in [
                    ("client_id", "clientId"),
                    ("client_secret", "clientSecret"),
                    ("tenant_id", "tenantId"),
                    ("service_url", "serviceUrl"),
                ] {
                    insert_json_string_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                }
                insert_json_scalar_string_if_present(&mut form, &extra, "port", "port");
                insert_hermes_home_channel_if_present(&mut form, &entry);
                put_json_string_from_env(&mut form, env_values, "TEAMS_CLIENT_ID", "clientId");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "TEAMS_CLIENT_SECRET",
                    "clientSecret",
                );
                put_json_string_from_env(&mut form, env_values, "TEAMS_TENANT_ID", "tenantId");
                put_json_string_from_env(&mut form, env_values, "TEAMS_PORT", "port");
                put_json_string_from_env(&mut form, env_values, "TEAMS_SERVICE_URL", "serviceUrl");
                put_json_string_from_env(&mut form, env_values, "TEAMS_ALLOWED_USERS", "allowFrom");
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "TEAMS_ALLOW_ALL_USERS",
                    "allowAllUsers",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "TEAMS_HOME_CHANNEL",
                    "homeChannel",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "TEAMS_HOME_CHANNEL_NAME",
                    "homeChannelName",
                );
            }
            "google_chat" => {
                for (yaml_key_name, json_key_name) in [
                    ("project_id", "projectId"),
                    ("subscription_name", "subscriptionName"),
                    ("service_account_json", "serviceAccountJson"),
                ] {
                    insert_json_string_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                }
                insert_hermes_home_channel_if_present(&mut form, &entry);
                if let Some(value) = hermes_env_value(env_values, "GOOGLE_CHAT_PROJECT_ID")
                    .or_else(|| hermes_env_value(env_values, "GOOGLE_CLOUD_PROJECT"))
                {
                    form.insert("projectId".to_string(), Value::String(value));
                }
                if let Some(value) = hermes_env_value(env_values, "GOOGLE_CHAT_SUBSCRIPTION_NAME")
                    .or_else(|| hermes_env_value(env_values, "GOOGLE_CHAT_SUBSCRIPTION"))
                {
                    form.insert("subscriptionName".to_string(), Value::String(value));
                }
                if let Some(value) =
                    hermes_env_value(env_values, "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON")
                        .or_else(|| hermes_env_value(env_values, "GOOGLE_APPLICATION_CREDENTIALS"))
                {
                    form.insert("serviceAccountJson".to_string(), Value::String(value));
                }
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "GOOGLE_CHAT_ALLOWED_USERS",
                    "allowFrom",
                );
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "GOOGLE_CHAT_ALLOW_ALL_USERS",
                    "allowAllUsers",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "GOOGLE_CHAT_HOME_CHANNEL",
                    "homeChannel",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "GOOGLE_CHAT_HOME_CHANNEL_NAME",
                    "homeChannelName",
                );
            }
            "irc" => {
                for (yaml_key_name, json_key_name) in [
                    ("server", "server"),
                    ("channel", "channel"),
                    ("nickname", "nickname"),
                    ("server_password", "serverPassword"),
                    ("nickserv_password", "nickservPassword"),
                ] {
                    insert_json_string_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                }
                insert_json_scalar_string_if_present(&mut form, &extra, "port", "port");
                insert_json_bool_if_present(&mut form, &extra, "use_tls", "useTls");
                insert_json_csv_if_present(&mut form, &extra, "allowed_users", "allowFrom");
                insert_hermes_home_channel_if_present(&mut form, &entry);
                put_json_string_from_env(&mut form, env_values, "IRC_SERVER", "server");
                put_json_string_from_env(&mut form, env_values, "IRC_CHANNEL", "channel");
                put_json_string_from_env(&mut form, env_values, "IRC_NICKNAME", "nickname");
                put_json_string_from_env(&mut form, env_values, "IRC_PORT", "port");
                put_json_bool_from_env(&mut form, env_values, "IRC_USE_TLS", "useTls");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "IRC_SERVER_PASSWORD",
                    "serverPassword",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "IRC_NICKSERV_PASSWORD",
                    "nickservPassword",
                );
                put_json_string_from_env(&mut form, env_values, "IRC_ALLOWED_USERS", "allowFrom");
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "IRC_ALLOW_ALL_USERS",
                    "allowAllUsers",
                );
                put_json_string_from_env(&mut form, env_values, "IRC_HOME_CHANNEL", "homeChannel");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "IRC_HOME_CHANNEL_NAME",
                    "homeChannelName",
                );
            }
            "line" => {
                for (yaml_key_name, json_key_name) in [
                    ("channel_access_token", "channelAccessToken"),
                    ("channel_secret", "channelSecret"),
                    ("host", "host"),
                    ("public_url", "publicUrl"),
                    ("slow_response_threshold", "slowResponseThreshold"),
                ] {
                    insert_json_string_if_present(&mut form, &extra, yaml_key_name, json_key_name);
                }
                insert_json_scalar_string_if_present(&mut form, &extra, "port", "port");
                insert_json_csv_if_present(&mut form, &extra, "allowed_users", "allowFrom");
                insert_json_csv_if_present(&mut form, &extra, "allowed_groups", "allowedGroups");
                insert_json_csv_if_present(&mut form, &extra, "allowed_rooms", "allowedRooms");
                insert_hermes_home_channel_if_present(&mut form, &entry);
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "LINE_CHANNEL_ACCESS_TOKEN",
                    "channelAccessToken",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "LINE_CHANNEL_SECRET",
                    "channelSecret",
                );
                put_json_string_from_env(&mut form, env_values, "LINE_PORT", "port");
                put_json_string_from_env(&mut form, env_values, "LINE_HOST", "host");
                put_json_string_from_env(&mut form, env_values, "LINE_PUBLIC_URL", "publicUrl");
                put_json_string_from_env(&mut form, env_values, "LINE_ALLOWED_USERS", "allowFrom");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "LINE_ALLOWED_GROUPS",
                    "allowedGroups",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "LINE_ALLOWED_ROOMS",
                    "allowedRooms",
                );
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "LINE_ALLOW_ALL_USERS",
                    "allowAllUsers",
                );
                put_json_string_from_env(&mut form, env_values, "LINE_HOME_CHANNEL", "homeChannel");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "LINE_SLOW_RESPONSE_THRESHOLD",
                    "slowResponseThreshold",
                );
            }
            "simplex" => {
                insert_json_string_if_present(&mut form, &extra, "ws_url", "wsUrl");
                insert_json_csv_if_present(&mut form, &extra, "allowed_users", "allowFrom");
                insert_hermes_home_channel_if_present(&mut form, &entry);
                put_json_string_from_env(&mut form, env_values, "SIMPLEX_WS_URL", "wsUrl");
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "SIMPLEX_ALLOWED_USERS",
                    "allowFrom",
                );
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "SIMPLEX_ALLOW_ALL_USERS",
                    "allowAllUsers",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "SIMPLEX_HOME_CHANNEL",
                    "homeChannel",
                );
                put_json_string_from_env(
                    &mut form,
                    env_values,
                    "SIMPLEX_HOME_CHANNEL_NAME",
                    "homeChannelName",
                );
            }
            _ => {}
        }

        insert_json_string_if_present(&mut form, &extra, "dm_policy", "dmPolicy");
        insert_json_string_if_present(&mut form, &extra, "group_policy", "groupPolicy");
        insert_json_bool_if_present(&mut form, &extra, "require_mention", "requireMention");
        if platform == "dingtalk" {
            insert_json_csv_if_present(&mut form, &extra, "allowed_users", "allowFrom");
            insert_json_csv_if_present(&mut form, &extra, "allowed_chats", "groupAllowFrom");
        } else if ["irc", "line", "simplex"].contains(&platform) {
            insert_json_csv_if_present(&mut form, &extra, "allowed_users", "allowFrom");
        } else {
            insert_json_csv_if_present(&mut form, &extra, "allow_from", "allowFrom");
            insert_json_csv_if_present(&mut form, &extra, "group_allow_from", "groupAllowFrom");
        }
        insert_hermes_channel_display_fields(&mut form, config, platform);
        values.insert(platform.to_string(), Value::Object(form));
    }

    Value::Object(values)
}

fn ensure_yaml_object(value: &mut serde_yaml::Value) -> Result<&mut serde_yaml::Mapping, String> {
    if value.is_null() {
        *value = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    value
        .as_mapping_mut()
        .ok_or_else(|| "config.yaml 顶层必须是对象".to_string())
}

fn yaml_child_object<'a>(
    parent: &'a mut serde_yaml::Mapping,
    key: &str,
) -> Result<&'a mut serde_yaml::Mapping, String> {
    let key_value = yaml_key(key);
    if !parent
        .get(&key_value)
        .map(|value| value.is_mapping())
        .unwrap_or(false)
    {
        parent.insert(
            key_value.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    parent
        .get_mut(&key_value)
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| format!("{key} 必须是对象"))
}

fn set_extra_string_if_present(entry: &mut serde_yaml::Mapping, key: &str, value: Option<String>) {
    if let Some(value) = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        if let Ok(extra) = yaml_child_object(entry, "extra") {
            extra.insert(yaml_key(key), serde_yaml::Value::String(value));
        }
    }
}

fn set_extra_integer_if_present(entry: &mut serde_yaml::Mapping, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        if let Ok(extra) = yaml_child_object(entry, "extra") {
            extra.insert(yaml_key(key), serde_yaml::Value::Number(value.into()));
        }
    }
}

fn delete_yaml_key(entry: &mut serde_yaml::Mapping, key: &str) {
    entry.remove(yaml_key(key));
}

fn delete_extra_key(entry: &mut serde_yaml::Mapping, key: &str) {
    if let Some(extra) = entry
        .get_mut(yaml_key("extra"))
        .and_then(|value| value.as_mapping_mut())
    {
        extra.remove(yaml_key(key));
    }
}

fn set_extra_bool(entry: &mut serde_yaml::Mapping, key: &str, value: bool) {
    if let Ok(extra) = yaml_child_object(entry, "extra") {
        extra.insert(yaml_key(key), serde_yaml::Value::Bool(value));
    }
}

fn set_extra_string_array(entry: &mut serde_yaml::Mapping, key: &str, values: Vec<String>) {
    if let Ok(extra) = yaml_child_object(entry, "extra") {
        extra.insert(
            yaml_key(key),
            serde_yaml::Value::Sequence(
                values
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect::<Vec<_>>(),
            ),
        );
    }
}

fn form_string(form: &Value, key: &str) -> Option<String> {
    form.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn form_i64(form: &Value, key: &str) -> Option<i64> {
    let value = form.get(key)?;
    if let Some(value) = value.as_i64() {
        Some(value)
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).ok()
    } else if let Some(value) = value.as_f64() {
        if value.is_finite() {
            Some(value as i64)
        } else {
            None
        }
    } else {
        value
            .as_str()
            .and_then(|value| value.trim().parse::<i64>().ok())
    }
}

fn form_f64(form: &Value, key: &str) -> Option<f64> {
    let value = form.get(key)?;
    if let Some(value) = value.as_f64() {
        value.is_finite().then_some(value)
    } else {
        value
            .as_str()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
    }
}

fn form_string_or_default(form: &Value, key: &str, default_value: &str) -> String {
    form_string(form, key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_value.to_string())
}

fn form_bool(form: &Value, key: &str) -> Option<bool> {
    form.get(key).and_then(|value| {
        if let Some(b) = value.as_bool() {
            Some(b)
        } else {
            value.as_str().map(|s| {
                matches!(
                    s.trim().to_ascii_lowercase().as_str(),
                    "true" | "on" | "1" | "yes"
                )
            })
        }
    })
}

fn form_string_array(form: &Value, key: &str) -> Option<Vec<String>> {
    let value = form.get(key)?;
    let items = if let Some(values) = value.as_array() {
        values
            .iter()
            .filter_map(|item| item.as_str())
            .flat_map(split_csv_items)
            .collect()
    } else if let Some(value) = value.as_str() {
        split_csv_items(value)
    } else {
        Vec::new()
    };
    Some(items)
}

fn set_hermes_home_channel(entry: &mut serde_yaml::Mapping, form: &Value) {
    if form.get("homeChannel").is_none() {
        return;
    }
    let chat_id = form_string(form, "homeChannel")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(chat_id) = chat_id else {
        delete_yaml_key(entry, "home_channel");
        return;
    };
    let name = form_string(form, "homeChannelName")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| chat_id.clone());
    let mut home = serde_yaml::Mapping::new();
    home.insert(yaml_key("chat_id"), serde_yaml::Value::String(chat_id));
    home.insert(yaml_key("name"), serde_yaml::Value::String(name));
    entry.insert(yaml_key("home_channel"), serde_yaml::Value::Mapping(home));
}

fn merge_hermes_channel_display_config(
    root: &mut serde_yaml::Mapping,
    platform: &str,
    form: &Value,
) -> Result<(), String> {
    let has_display_fields = [
        "displayToolProgress",
        "displayShowReasoning",
        "displayToolPreviewLength",
        "displayStreaming",
        "displayCleanupProgress",
    ]
    .iter()
    .any(|key| form.get(*key).is_some());
    if !has_display_fields {
        return Ok(());
    }

    let tool_progress = if form.get("displayToolProgress").is_some() {
        Some(normalize_hermes_display_tool_progress(
            form_string(form, "displayToolProgress"),
            true,
            &format!("display.platforms.{platform}.tool_progress"),
        )?)
    } else {
        None
    };
    let show_reasoning = if form.get("displayShowReasoning").is_some() {
        Some(form_bool(form, "displayShowReasoning").unwrap_or(false))
    } else {
        None
    };
    let tool_preview_length = if form.get("displayToolPreviewLength").is_some() {
        Some(validate_hermes_i64(
            form_i64(form, "displayToolPreviewLength"),
            &format!("display.platforms.{platform}.tool_preview_length"),
            0,
            0,
            200000,
        )?)
    } else {
        None
    };
    let streaming = if form.get("displayStreaming").is_some() {
        Some(normalize_hermes_display_streaming_json(
            form.get("displayStreaming"),
            true,
            &format!("display.platforms.{platform}.streaming"),
        )?)
    } else {
        None
    };
    let cleanup_progress = if form.get("displayCleanupProgress").is_some() {
        Some(form_bool(form, "displayCleanupProgress").unwrap_or(false))
    } else {
        None
    };

    let display = yaml_child_object(root, "display")?;
    let platforms = yaml_child_object(display, "platforms")?;
    let platform_display = yaml_child_object(platforms, platform)?;
    if let Some(value) = tool_progress {
        platform_display.insert(yaml_key("tool_progress"), serde_yaml::Value::String(value));
    }
    if let Some(value) = show_reasoning {
        platform_display.insert(yaml_key("show_reasoning"), serde_yaml::Value::Bool(value));
    }
    if let Some(value) = tool_preview_length {
        platform_display.insert(
            yaml_key("tool_preview_length"),
            serde_yaml::Value::Number(value.into()),
        );
    }
    if let Some(value) = streaming {
        if value == "inherit" {
            platform_display.remove(yaml_key("streaming"));
        } else {
            platform_display.insert(
                yaml_key("streaming"),
                serde_yaml::Value::Bool(value == "true"),
            );
        }
    }
    if let Some(value) = cleanup_progress {
        platform_display.insert(yaml_key("cleanup_progress"), serde_yaml::Value::Bool(value));
    }
    Ok(())
}

fn split_csv_items(value: &str) -> Vec<String> {
    value
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn normalize_hermes_dm_policy(value: Option<String>) -> String {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    match value.as_str() {
        "pairing" => "pair".to_string(),
        "allow" => "open".to_string(),
        "deny" => "disabled".to_string(),
        "pair" | "open" | "allowlist" | "disabled" => value,
        _ => "pair".to_string(),
    }
}

fn normalize_hermes_group_policy(value: Option<String>) -> String {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    match value.as_str() {
        "all" | "mentioned" => "open".to_string(),
        "deny" => "disabled".to_string(),
        "open" | "allowlist" | "disabled" => value,
        _ => "allowlist".to_string(),
    }
}

fn yaml_i64_field(map: &serde_yaml::Mapping, key: &str) -> Option<i64> {
    let value = yaml_get(map, key)?;
    if let Some(value) = value.as_i64() {
        Some(value)
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).ok()
    } else if let Some(value) = value.as_f64() {
        if value.is_finite() {
            Some(value as i64)
        } else {
            None
        }
    } else {
        value
            .as_str()
            .and_then(|value| value.trim().parse::<i64>().ok())
    }
}

fn yaml_f64_field(map: &serde_yaml::Mapping, key: &str) -> Option<f64> {
    let value = yaml_get(map, key)?;
    if let Some(value) = value.as_f64() {
        value.is_finite().then_some(value)
    } else {
        value
            .as_str()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
    }
}

fn bounded_hermes_i64(value: Option<i64>, fallback: i64, min: i64, max: i64) -> i64 {
    value
        .filter(|value| *value >= min && *value <= max)
        .unwrap_or(fallback)
}

fn bounded_hermes_f64(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    value
        .filter(|value| value.is_finite() && *value >= min && *value <= max)
        .unwrap_or(fallback)
}

fn validate_hermes_i64(
    value: Option<i64>,
    key: &str,
    fallback: i64,
    min: i64,
    max: i64,
) -> Result<i64, String> {
    let value = value.unwrap_or(fallback);
    if value < min || value > max {
        return Err(format!("{key} 必须在 {min}-{max} 范围内"));
    }
    Ok(value)
}

fn validate_hermes_f64(
    value: Option<f64>,
    key: &str,
    fallback: f64,
    min: f64,
    max: f64,
) -> Result<f64, String> {
    let value = value.unwrap_or(fallback);
    if !value.is_finite() || value < min || value > max {
        return Err(format!("{key} 必须在 {min}-{max} 范围内"));
    }
    Ok((value * 10_000.0).round() / 10_000.0)
}

fn build_hermes_compression_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let compression = root.and_then(|map| yaml_get_mapping(map, "compression"));
    let enabled = compression
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(true);
    let threshold = compression
        .map(|map| bounded_hermes_f64(yaml_f64_field(map, "threshold"), 0.5, 0.1, 0.95))
        .unwrap_or(0.5);
    let target_ratio = compression
        .map(|map| bounded_hermes_f64(yaml_f64_field(map, "target_ratio"), 0.2, 0.1, 0.8))
        .unwrap_or(0.2);
    let protect_last_n = compression
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "protect_last_n"), 20, 1, 500))
        .unwrap_or(20);
    let protect_first_n = compression
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "protect_first_n"), 3, 0, 100))
        .unwrap_or(3);
    let abort_on_summary_failure = compression
        .and_then(|map| yaml_bool_field(map, "abort_on_summary_failure"))
        .unwrap_or(false);

    serde_json::json!({
        "enabled": enabled,
        "threshold": threshold,
        "targetRatio": target_ratio,
        "protectLastN": protect_last_n,
        "protectFirstN": protect_first_n,
        "abortOnSummaryFailure": abort_on_summary_failure,
    })
}

fn merge_hermes_compression_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_compression_config_values(config);
    let enabled =
        form_bool(form, "enabled").unwrap_or_else(|| current["enabled"].as_bool().unwrap_or(true));
    let threshold = validate_hermes_f64(
        if form.get("threshold").is_some() {
            form_f64(form, "threshold")
        } else {
            Some(current["threshold"].as_f64().unwrap_or(0.5))
        },
        "compression.threshold",
        0.5,
        0.1,
        0.95,
    )?;
    let target_ratio = validate_hermes_f64(
        if form.get("targetRatio").is_some() {
            form_f64(form, "targetRatio")
        } else {
            Some(current["targetRatio"].as_f64().unwrap_or(0.2))
        },
        "compression.target_ratio",
        0.2,
        0.1,
        0.8,
    )?;
    let protect_last_n = validate_hermes_i64(
        if form.get("protectLastN").is_some() {
            form_i64(form, "protectLastN")
        } else {
            Some(current["protectLastN"].as_i64().unwrap_or(20))
        },
        "compression.protect_last_n",
        20,
        1,
        500,
    )?;
    let protect_first_n = validate_hermes_i64(
        if form.get("protectFirstN").is_some() {
            form_i64(form, "protectFirstN")
        } else {
            Some(current["protectFirstN"].as_i64().unwrap_or(3))
        },
        "compression.protect_first_n",
        3,
        0,
        100,
    )?;
    let abort_on_summary_failure = form_bool(form, "abortOnSummaryFailure")
        .unwrap_or_else(|| current["abortOnSummaryFailure"].as_bool().unwrap_or(false));

    let root = ensure_yaml_object(config)?;
    let compression = yaml_child_object(root, "compression")?;
    compression.insert(yaml_key("enabled"), serde_yaml::Value::Bool(enabled));
    compression.insert(
        yaml_key("threshold"),
        serde_yaml::Value::Number(threshold.into()),
    );
    compression.insert(
        yaml_key("target_ratio"),
        serde_yaml::Value::Number(target_ratio.into()),
    );
    compression.insert(
        yaml_key("protect_last_n"),
        serde_yaml::Value::Number(protect_last_n.into()),
    );
    compression.insert(
        yaml_key("protect_first_n"),
        serde_yaml::Value::Number(protect_first_n.into()),
    );
    compression.insert(
        yaml_key("abort_on_summary_failure"),
        serde_yaml::Value::Bool(abort_on_summary_failure),
    );
    Ok(())
}

fn build_hermes_tool_loop_guardrails_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let guardrails = root.and_then(|map| yaml_get_mapping(map, "tool_loop_guardrails"));
    let warn_after = guardrails.and_then(|map| yaml_get_mapping(map, "warn_after"));
    let hard_stop_after = guardrails.and_then(|map| yaml_get_mapping(map, "hard_stop_after"));

    let warnings_enabled = guardrails
        .and_then(|map| yaml_bool_field(map, "warnings_enabled"))
        .unwrap_or(true);
    let hard_stop_enabled = guardrails
        .and_then(|map| yaml_bool_field(map, "hard_stop_enabled"))
        .unwrap_or(false);
    let warn_exact_failure = warn_after
        .and_then(|map| yaml_i64_field(map, "exact_failure"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "exact_failure_warn_after")));
    let warn_same_tool_failure = warn_after
        .and_then(|map| yaml_i64_field(map, "same_tool_failure"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "same_tool_failure_warn_after")));
    let warn_no_progress = warn_after
        .and_then(|map| yaml_i64_field(map, "idempotent_no_progress"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "no_progress_warn_after")));
    let hard_stop_exact_failure = hard_stop_after
        .and_then(|map| yaml_i64_field(map, "exact_failure"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "exact_failure_block_after")));
    let hard_stop_same_tool_failure = hard_stop_after
        .and_then(|map| yaml_i64_field(map, "same_tool_failure"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "same_tool_failure_halt_after")));
    let hard_stop_no_progress = hard_stop_after
        .and_then(|map| yaml_i64_field(map, "idempotent_no_progress"))
        .or_else(|| guardrails.and_then(|map| yaml_i64_field(map, "no_progress_block_after")));

    serde_json::json!({
        "warningsEnabled": warnings_enabled,
        "hardStopEnabled": hard_stop_enabled,
        "warnExactFailure": bounded_hermes_i64(warn_exact_failure, 2, 1, 100),
        "warnSameToolFailure": bounded_hermes_i64(warn_same_tool_failure, 3, 1, 100),
        "warnNoProgress": bounded_hermes_i64(warn_no_progress, 2, 1, 100),
        "hardStopExactFailure": bounded_hermes_i64(hard_stop_exact_failure, 5, 1, 100),
        "hardStopSameToolFailure": bounded_hermes_i64(hard_stop_same_tool_failure, 8, 1, 100),
        "hardStopNoProgress": bounded_hermes_i64(hard_stop_no_progress, 5, 1, 100),
    })
}

fn merge_hermes_tool_loop_guardrails_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_tool_loop_guardrails_config_values(config);
    let warnings_enabled = form_bool(form, "warningsEnabled")
        .unwrap_or_else(|| current["warningsEnabled"].as_bool().unwrap_or(true));
    let hard_stop_enabled = form_bool(form, "hardStopEnabled")
        .unwrap_or_else(|| current["hardStopEnabled"].as_bool().unwrap_or(false));
    let warn_exact_failure = validate_hermes_i64(
        if form.get("warnExactFailure").is_some() {
            form_i64(form, "warnExactFailure")
        } else {
            Some(current["warnExactFailure"].as_i64().unwrap_or(2))
        },
        "tool_loop_guardrails.warn_after.exact_failure",
        2,
        1,
        100,
    )?;
    let warn_same_tool_failure = validate_hermes_i64(
        if form.get("warnSameToolFailure").is_some() {
            form_i64(form, "warnSameToolFailure")
        } else {
            Some(current["warnSameToolFailure"].as_i64().unwrap_or(3))
        },
        "tool_loop_guardrails.warn_after.same_tool_failure",
        3,
        1,
        100,
    )?;
    let warn_no_progress = validate_hermes_i64(
        if form.get("warnNoProgress").is_some() {
            form_i64(form, "warnNoProgress")
        } else {
            Some(current["warnNoProgress"].as_i64().unwrap_or(2))
        },
        "tool_loop_guardrails.warn_after.idempotent_no_progress",
        2,
        1,
        100,
    )?;
    let hard_stop_exact_failure = validate_hermes_i64(
        if form.get("hardStopExactFailure").is_some() {
            form_i64(form, "hardStopExactFailure")
        } else {
            Some(current["hardStopExactFailure"].as_i64().unwrap_or(5))
        },
        "tool_loop_guardrails.hard_stop_after.exact_failure",
        5,
        1,
        100,
    )?;
    let hard_stop_same_tool_failure = validate_hermes_i64(
        if form.get("hardStopSameToolFailure").is_some() {
            form_i64(form, "hardStopSameToolFailure")
        } else {
            Some(current["hardStopSameToolFailure"].as_i64().unwrap_or(8))
        },
        "tool_loop_guardrails.hard_stop_after.same_tool_failure",
        8,
        1,
        100,
    )?;
    let hard_stop_no_progress = validate_hermes_i64(
        if form.get("hardStopNoProgress").is_some() {
            form_i64(form, "hardStopNoProgress")
        } else {
            Some(current["hardStopNoProgress"].as_i64().unwrap_or(5))
        },
        "tool_loop_guardrails.hard_stop_after.idempotent_no_progress",
        5,
        1,
        100,
    )?;

    let root = ensure_yaml_object(config)?;
    let guardrails = yaml_child_object(root, "tool_loop_guardrails")?;
    guardrails.insert(
        yaml_key("warnings_enabled"),
        serde_yaml::Value::Bool(warnings_enabled),
    );
    guardrails.insert(
        yaml_key("hard_stop_enabled"),
        serde_yaml::Value::Bool(hard_stop_enabled),
    );
    let warn_after = yaml_child_object(guardrails, "warn_after")?;
    warn_after.insert(
        yaml_key("exact_failure"),
        serde_yaml::Value::Number(warn_exact_failure.into()),
    );
    warn_after.insert(
        yaml_key("same_tool_failure"),
        serde_yaml::Value::Number(warn_same_tool_failure.into()),
    );
    warn_after.insert(
        yaml_key("idempotent_no_progress"),
        serde_yaml::Value::Number(warn_no_progress.into()),
    );
    let hard_stop_after = yaml_child_object(guardrails, "hard_stop_after")?;
    hard_stop_after.insert(
        yaml_key("exact_failure"),
        serde_yaml::Value::Number(hard_stop_exact_failure.into()),
    );
    hard_stop_after.insert(
        yaml_key("same_tool_failure"),
        serde_yaml::Value::Number(hard_stop_same_tool_failure.into()),
    );
    hard_stop_after.insert(
        yaml_key("idempotent_no_progress"),
        serde_yaml::Value::Number(hard_stop_no_progress.into()),
    );
    Ok(())
}

fn build_hermes_memory_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let memory = root.and_then(|map| yaml_get_mapping(map, "memory"));
    let memory_enabled = memory
        .and_then(|map| yaml_bool_field(map, "memory_enabled"))
        .unwrap_or(true);
    let user_profile_enabled = memory
        .and_then(|map| yaml_bool_field(map, "user_profile_enabled"))
        .unwrap_or(true);
    let memory_char_limit = memory
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "memory_char_limit"), 2200, 100, 200000))
        .unwrap_or(2200);
    let user_char_limit = memory
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "user_char_limit"), 1375, 100, 200000))
        .unwrap_or(1375);
    let nudge_interval = memory
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "nudge_interval"), 10, 0, 1000))
        .unwrap_or(10);
    let flush_min_turns = memory
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "flush_min_turns"), 6, 0, 1000))
        .unwrap_or(6);

    serde_json::json!({
        "memoryEnabled": memory_enabled,
        "userProfileEnabled": user_profile_enabled,
        "memoryCharLimit": memory_char_limit,
        "userCharLimit": user_char_limit,
        "nudgeInterval": nudge_interval,
        "flushMinTurns": flush_min_turns,
    })
}

fn merge_hermes_memory_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_memory_config_values(config);
    let memory_enabled = form_bool(form, "memoryEnabled")
        .unwrap_or_else(|| current["memoryEnabled"].as_bool().unwrap_or(true));
    let user_profile_enabled = form_bool(form, "userProfileEnabled")
        .unwrap_or_else(|| current["userProfileEnabled"].as_bool().unwrap_or(true));
    let memory_char_limit = validate_hermes_i64(
        if form.get("memoryCharLimit").is_some() {
            form_i64(form, "memoryCharLimit")
        } else {
            Some(current["memoryCharLimit"].as_i64().unwrap_or(2200))
        },
        "memory.memory_char_limit",
        2200,
        100,
        200000,
    )?;
    let user_char_limit = validate_hermes_i64(
        if form.get("userCharLimit").is_some() {
            form_i64(form, "userCharLimit")
        } else {
            Some(current["userCharLimit"].as_i64().unwrap_or(1375))
        },
        "memory.user_char_limit",
        1375,
        100,
        200000,
    )?;
    let nudge_interval = validate_hermes_i64(
        if form.get("nudgeInterval").is_some() {
            form_i64(form, "nudgeInterval")
        } else {
            Some(current["nudgeInterval"].as_i64().unwrap_or(10))
        },
        "memory.nudge_interval",
        10,
        0,
        1000,
    )?;
    let flush_min_turns = validate_hermes_i64(
        if form.get("flushMinTurns").is_some() {
            form_i64(form, "flushMinTurns")
        } else {
            Some(current["flushMinTurns"].as_i64().unwrap_or(6))
        },
        "memory.flush_min_turns",
        6,
        0,
        1000,
    )?;

    let root = ensure_yaml_object(config)?;
    let memory = yaml_child_object(root, "memory")?;
    memory.insert(
        yaml_key("memory_enabled"),
        serde_yaml::Value::Bool(memory_enabled),
    );
    memory.insert(
        yaml_key("user_profile_enabled"),
        serde_yaml::Value::Bool(user_profile_enabled),
    );
    memory.insert(
        yaml_key("memory_char_limit"),
        serde_yaml::Value::Number(memory_char_limit.into()),
    );
    memory.insert(
        yaml_key("user_char_limit"),
        serde_yaml::Value::Number(user_char_limit.into()),
    );
    memory.insert(
        yaml_key("nudge_interval"),
        serde_yaml::Value::Number(nudge_interval.into()),
    );
    memory.insert(
        yaml_key("flush_min_turns"),
        serde_yaml::Value::Number(flush_min_turns.into()),
    );
    Ok(())
}

fn normalize_hermes_multiline_list(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn build_hermes_skills_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let skills = root.and_then(|map| yaml_get_mapping(map, "skills"));
    let creation_nudge_interval = skills
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "creation_nudge_interval"), 15, 0, 10000))
        .unwrap_or(15);
    let external_dirs = skills
        .map(|map| yaml_string_sequence_field(map, "external_dirs").join("\n"))
        .unwrap_or_default();

    serde_json::json!({
        "creationNudgeInterval": creation_nudge_interval,
        "externalDirs": external_dirs,
    })
}

fn merge_hermes_skills_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_skills_config_values(config);
    let creation_nudge_interval = validate_hermes_i64(
        if form.get("creationNudgeInterval").is_some() {
            form_i64(form, "creationNudgeInterval")
        } else {
            Some(current["creationNudgeInterval"].as_i64().unwrap_or(15))
        },
        "skills.creation_nudge_interval",
        15,
        0,
        10000,
    )?;
    let external_dirs = normalize_hermes_multiline_list(
        form_string(form, "externalDirs")
            .or_else(|| current["externalDirs"].as_str().map(ToString::to_string)),
    );

    let root = ensure_yaml_object(config)?;
    let skills = yaml_child_object(root, "skills")?;
    skills.insert(
        yaml_key("creation_nudge_interval"),
        serde_yaml::Value::Number(creation_nudge_interval.into()),
    );
    if external_dirs.is_empty() {
        skills.remove(yaml_key("external_dirs"));
    } else {
        skills.insert(
            yaml_key("external_dirs"),
            serde_yaml::Value::Sequence(
                external_dirs
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    Ok(())
}

fn build_hermes_quick_commands_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let quick_commands = root
        .and_then(|map| yaml_get(map, "quick_commands"))
        .and_then(|value| value.as_mapping())
        .and_then(|mapping| serde_json::to_value(mapping).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let quick_commands_json =
        serde_json::to_string_pretty(&quick_commands).unwrap_or_else(|_| "{}".to_string());

    serde_json::json!({
        "quickCommandsJson": quick_commands_json,
    })
}

fn validate_hermes_quick_commands(value: Value) -> Result<serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "quick_commands 必须是 JSON 对象".to_string())?;
    let mut normalized = serde_json::Map::new();
    for (raw_name, raw_command) in object {
        let name = raw_name.trim().trim_start_matches('/').to_string();
        if name.is_empty() {
            return Err("quick_commands 命令名不能为空".to_string());
        }
        let command_object = raw_command
            .as_object()
            .ok_or_else(|| format!("quick_commands.{name} 必须是对象"))?;
        let mut command = command_object.clone();
        let command_type = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !matches!(command_type.as_str(), "exec" | "alias") {
            return Err(format!("quick_commands.{name}.type 必须是 exec 或 alias"));
        }
        command.insert("type".to_string(), Value::String(command_type.clone()));
        if command_type == "exec" {
            let shell_command = command
                .get("command")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if shell_command.is_empty() {
                return Err(format!("quick_commands.{name}.command 不能为空"));
            }
            command.insert("command".to_string(), Value::String(shell_command));
        }
        if command_type == "alias" {
            let target = command
                .get("target")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if !target.starts_with('/') {
                return Err(format!("quick_commands.{name}.target 必须以 / 开头"));
            }
            command.insert("target".to_string(), Value::String(target));
        }
        normalized.insert(name, Value::Object(command));
    }
    Ok(normalized)
}

fn parse_hermes_quick_commands_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(text).map_err(|err| format!("quick_commands JSON 格式错误: {err}"))?;
    validate_hermes_quick_commands(value)
}

fn merge_hermes_quick_commands_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_quick_commands_config_values(config);
    let quick_commands =
        parse_hermes_quick_commands_json(form_string(form, "quickCommandsJson").or_else(|| {
            current["quickCommandsJson"]
                .as_str()
                .map(ToString::to_string)
        }))?;

    let root = ensure_yaml_object(config)?;
    if quick_commands.is_empty() {
        root.remove(yaml_key("quick_commands"));
    } else {
        let json_value = Value::Object(quick_commands);
        let yaml_value = serde_yaml::to_value(json_value)
            .map_err(|err| format!("quick_commands 转换 YAML 失败: {err}"))?;
        root.insert(yaml_key("quick_commands"), yaml_value);
    }
    Ok(())
}

fn normalize_hermes_unauthorized_dm_behavior(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let behavior = value.unwrap_or_default().trim().to_ascii_lowercase();
    if matches!(behavior.as_str(), "pair" | "ignore") {
        return Ok(behavior);
    }
    if strict {
        Err("unauthorized_dm_behavior 必须是 pair 或 ignore".to_string())
    } else {
        Ok("pair".to_string())
    }
}

fn build_hermes_unauthorized_dm_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let behavior = root
        .and_then(|map| yaml_string_field(map, "unauthorized_dm_behavior"))
        .and_then(|value| normalize_hermes_unauthorized_dm_behavior(Some(value), false).ok())
        .unwrap_or_else(|| "pair".to_string());

    serde_json::json!({
        "unauthorizedDmBehavior": behavior,
    })
}

fn merge_hermes_unauthorized_dm_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_unauthorized_dm_config_values(config);
    let behavior = normalize_hermes_unauthorized_dm_behavior(
        form_string(form, "unauthorizedDmBehavior").or_else(|| {
            current["unauthorizedDmBehavior"]
                .as_str()
                .map(ToString::to_string)
        }),
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    root.insert(
        yaml_key("unauthorized_dm_behavior"),
        serde_yaml::Value::String(behavior),
    );
    Ok(())
}

fn build_hermes_security_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let security = root.and_then(|map| yaml_get_mapping(map, "security"));

    let tirith_enabled = security
        .and_then(|map| yaml_bool_field(map, "tirith_enabled"))
        .unwrap_or(true);
    let tirith_path = security
        .and_then(|map| yaml_string_field(map, "tirith_path"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "tirith".to_string());
    let tirith_timeout = security
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "tirith_timeout"), 5, 1, 300))
        .unwrap_or(5);
    let tirith_fail_open = security
        .and_then(|map| yaml_bool_field(map, "tirith_fail_open"))
        .unwrap_or(true);

    serde_json::json!({
        "tirithEnabled": tirith_enabled,
        "tirithPath": tirith_path,
        "tirithTimeout": tirith_timeout,
        "tirithFailOpen": tirith_fail_open,
    })
}

fn merge_hermes_security_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_security_config_values(config);
    let tirith_path = form_string(form, "tirithPath")
        .or_else(|| current["tirithPath"].as_str().map(ToString::to_string))
        .unwrap_or_else(|| "tirith".to_string())
        .trim()
        .to_string();
    if tirith_path.is_empty() {
        return Err("security.tirith_path 不能为空".to_string());
    }

    let root = ensure_yaml_object(config)?;
    let tirith_timeout = validate_hermes_i64(
        if form.get("tirithTimeout").is_some() {
            form_i64(form, "tirithTimeout")
        } else {
            Some(current["tirithTimeout"].as_i64().unwrap_or(5))
        },
        "security.tirith_timeout",
        5,
        1,
        300,
    )?;
    let security = yaml_child_object(root, "security")?;
    security.insert(
        yaml_key("tirith_enabled"),
        serde_yaml::Value::Bool(
            form_bool(form, "tirithEnabled")
                .unwrap_or_else(|| current["tirithEnabled"].as_bool().unwrap_or(true)),
        ),
    );
    security.insert(
        yaml_key("tirith_path"),
        serde_yaml::Value::String(tirith_path),
    );
    security.insert(
        yaml_key("tirith_timeout"),
        serde_yaml::Value::Number(tirith_timeout.into()),
    );
    security.insert(
        yaml_key("tirith_fail_open"),
        serde_yaml::Value::Bool(
            form_bool(form, "tirithFailOpen")
                .unwrap_or_else(|| current["tirithFailOpen"].as_bool().unwrap_or(true)),
        ),
    );
    Ok(())
}

fn normalize_hermes_human_delay_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "off".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "off" | "natural" | "custom") {
        return Ok(mode);
    }
    if strict {
        Err("human_delay.mode 必须是 off、natural 或 custom".to_string())
    } else {
        Ok("off".to_string())
    }
}

fn build_hermes_human_delay_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let human_delay = root.and_then(|map| yaml_get_mapping(map, "human_delay"));
    let mode = human_delay
        .and_then(|map| yaml_string_field(map, "mode"))
        .and_then(|value| normalize_hermes_human_delay_mode(Some(value), false).ok())
        .unwrap_or_else(|| "off".to_string());
    let min_ms = human_delay
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "min_ms"), 800, 0, 60000))
        .unwrap_or(800);
    let max_ms = human_delay
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_ms"), 2500, 0, 60000))
        .unwrap_or(2500)
        .max(min_ms);

    serde_json::json!({
        "humanDelayMode": mode,
        "humanDelayMinMs": min_ms,
        "humanDelayMaxMs": max_ms,
    })
}

fn merge_hermes_human_delay_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_human_delay_config_values(config);
    let mode = normalize_hermes_human_delay_mode(
        form_string(form, "humanDelayMode")
            .or_else(|| current["humanDelayMode"].as_str().map(ToString::to_string)),
        true,
    )?;
    let min_ms = validate_hermes_i64(
        if form.get("humanDelayMinMs").is_some() {
            form_i64(form, "humanDelayMinMs")
        } else {
            Some(current["humanDelayMinMs"].as_i64().unwrap_or(800))
        },
        "human_delay.min_ms",
        800,
        0,
        60000,
    )?;
    let max_ms = validate_hermes_i64(
        if form.get("humanDelayMaxMs").is_some() {
            form_i64(form, "humanDelayMaxMs")
        } else {
            Some(current["humanDelayMaxMs"].as_i64().unwrap_or(2500))
        },
        "human_delay.max_ms",
        2500,
        0,
        60000,
    )?;
    if max_ms < min_ms {
        return Err("human_delay.max_ms 不能小于 min_ms".to_string());
    }

    let root = ensure_yaml_object(config)?;
    let human_delay = yaml_child_object(root, "human_delay")?;
    human_delay.insert(yaml_key("mode"), serde_yaml::Value::String(mode));
    human_delay.insert(yaml_key("min_ms"), serde_yaml::Value::Number(min_ms.into()));
    human_delay.insert(yaml_key("max_ms"), serde_yaml::Value::Number(max_ms.into()));
    Ok(())
}

fn normalize_hermes_streaming_transport(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let transport = value.unwrap_or_default().trim().to_ascii_lowercase();
    let transport = if transport.is_empty() {
        "edit".to_string()
    } else {
        transport
    };
    if matches!(transport.as_str(), "auto" | "draft" | "edit" | "off") {
        return Ok(transport);
    }
    if strict {
        Err("streaming.transport 必须是 auto、draft、edit 或 off".to_string())
    } else {
        Ok("edit".to_string())
    }
}

fn normalize_hermes_code_execution_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "project".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "project" | "strict") {
        return Ok(mode);
    }
    if strict {
        Err("code_execution.mode 必须是 project 或 strict".to_string())
    } else {
        Ok("project".to_string())
    }
}

fn normalize_hermes_terminal_backend(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let backend = value.unwrap_or_default().trim().to_ascii_lowercase();
    let backend = if backend.is_empty() {
        "local".to_string()
    } else {
        backend
    };
    if matches!(
        backend.as_str(),
        "local" | "ssh" | "docker" | "singularity" | "modal" | "daytona" | "vercel_sandbox"
    ) {
        return Ok(backend);
    }
    if strict {
        Err("terminal.backend 必须是 local、ssh、docker、singularity、modal、daytona 或 vercel_sandbox"
            .to_string())
    } else {
        Ok("local".to_string())
    }
}

fn hermes_streaming_config_source(config: &serde_yaml::Value) -> Option<&serde_yaml::Mapping> {
    let root = config.as_mapping()?;
    if let Some(streaming) = yaml_get_mapping(root, "streaming") {
        return Some(streaming);
    }
    let gateway = yaml_get_mapping(root, "gateway")?;
    yaml_get_mapping(gateway, "streaming")
}

fn build_hermes_streaming_config_values(config: &serde_yaml::Value) -> Value {
    let streaming = hermes_streaming_config_source(config);
    let enabled = streaming
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(false);
    let transport = normalize_hermes_streaming_transport(
        streaming.and_then(|map| yaml_string_field(map, "transport")),
        false,
    )
    .unwrap_or_else(|_| "edit".to_string());
    let edit_interval = streaming
        .map(|map| bounded_hermes_f64(yaml_f64_field(map, "edit_interval"), 0.8, 0.05, 60.0))
        .unwrap_or(0.8);
    let buffer_threshold = streaming
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "buffer_threshold"), 24, 1, 5000))
        .unwrap_or(24);
    let cursor = streaming
        .and_then(|map| yaml_string_field(map, "cursor"))
        .unwrap_or_else(|| " ▉".to_string());
    let fresh_final_after_seconds = streaming
        .map(|map| {
            bounded_hermes_f64(
                yaml_f64_field(map, "fresh_final_after_seconds"),
                60.0,
                0.0,
                86400.0,
            )
        })
        .unwrap_or(60.0);

    serde_json::json!({
        "enabled": enabled,
        "transport": transport,
        "editInterval": edit_interval,
        "bufferThreshold": buffer_threshold,
        "cursor": cursor,
        "freshFinalAfterSeconds": fresh_final_after_seconds,
    })
}

fn merge_hermes_streaming_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_streaming_config_values(config);
    let enabled =
        form_bool(form, "enabled").unwrap_or_else(|| current["enabled"].as_bool().unwrap_or(false));
    let transport = normalize_hermes_streaming_transport(
        if form.get("transport").is_some() {
            form_string(form, "transport")
        } else {
            current["transport"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let edit_interval = validate_hermes_f64(
        if form.get("editInterval").is_some() {
            form_f64(form, "editInterval")
        } else {
            Some(current["editInterval"].as_f64().unwrap_or(0.8))
        },
        "streaming.edit_interval",
        0.8,
        0.05,
        60.0,
    )?;
    let buffer_threshold = validate_hermes_i64(
        if form.get("bufferThreshold").is_some() {
            form_i64(form, "bufferThreshold")
        } else {
            Some(current["bufferThreshold"].as_i64().unwrap_or(24))
        },
        "streaming.buffer_threshold",
        24,
        1,
        5000,
    )?;
    let cursor = if form.get("cursor").is_some() {
        form_string(form, "cursor").unwrap_or_default()
    } else {
        current["cursor"].as_str().unwrap_or(" ▉").to_string()
    };
    let fresh_final_after_seconds = validate_hermes_f64(
        if form.get("freshFinalAfterSeconds").is_some() {
            form_f64(form, "freshFinalAfterSeconds")
        } else {
            Some(current["freshFinalAfterSeconds"].as_f64().unwrap_or(60.0))
        },
        "streaming.fresh_final_after_seconds",
        60.0,
        0.0,
        86400.0,
    )?;

    let root = ensure_yaml_object(config)?;
    let streaming = yaml_child_object(root, "streaming")?;
    streaming.insert(yaml_key("enabled"), serde_yaml::Value::Bool(enabled));
    streaming.insert(yaml_key("transport"), serde_yaml::Value::String(transport));
    streaming.insert(
        yaml_key("edit_interval"),
        serde_yaml::Value::Number(edit_interval.into()),
    );
    streaming.insert(
        yaml_key("buffer_threshold"),
        serde_yaml::Value::Number(buffer_threshold.into()),
    );
    streaming.insert(yaml_key("cursor"), serde_yaml::Value::String(cursor));
    streaming.insert(
        yaml_key("fresh_final_after_seconds"),
        serde_yaml::Value::Number(fresh_final_after_seconds.into()),
    );
    Ok(())
}

fn build_hermes_execution_limits_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let code_execution = root.and_then(|map| yaml_get_mapping(map, "code_execution"));
    let delegation = root.and_then(|map| yaml_get_mapping(map, "delegation"));
    let code_execution_mode = normalize_hermes_code_execution_mode(
        code_execution.and_then(|map| yaml_string_field(map, "mode")),
        false,
    )
    .unwrap_or_else(|_| "project".to_string());
    let code_execution_timeout = code_execution
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout"), 300, 1, 86400))
        .unwrap_or(300);
    let code_execution_max_tool_calls = code_execution
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_tool_calls"), 50, 1, 10000))
        .unwrap_or(50);
    let delegation_max_iterations = delegation
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_iterations"), 50, 1, 1000))
        .unwrap_or(50);
    let delegation_child_timeout_seconds = delegation
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "child_timeout_seconds"), 600, 30, 86400))
        .unwrap_or(600);
    let delegation_max_concurrent_children = delegation
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_concurrent_children"), 3, 1, 100))
        .unwrap_or(3);
    let delegation_max_spawn_depth = delegation
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_spawn_depth"), 1, 1, 3))
        .unwrap_or(1);
    let delegation_orchestrator_enabled = delegation
        .and_then(|map| yaml_bool_field(map, "orchestrator_enabled"))
        .unwrap_or(true);
    let delegation_subagent_auto_approve = delegation
        .and_then(|map| yaml_bool_field(map, "subagent_auto_approve"))
        .unwrap_or(false);
    let delegation_inherit_mcp_toolsets = delegation
        .and_then(|map| yaml_bool_field(map, "inherit_mcp_toolsets"))
        .unwrap_or(true);

    serde_json::json!({
        "codeExecutionMode": code_execution_mode,
        "codeExecutionTimeout": code_execution_timeout,
        "codeExecutionMaxToolCalls": code_execution_max_tool_calls,
        "delegationMaxIterations": delegation_max_iterations,
        "delegationChildTimeoutSeconds": delegation_child_timeout_seconds,
        "delegationMaxConcurrentChildren": delegation_max_concurrent_children,
        "delegationMaxSpawnDepth": delegation_max_spawn_depth,
        "delegationOrchestratorEnabled": delegation_orchestrator_enabled,
        "delegationSubagentAutoApprove": delegation_subagent_auto_approve,
        "delegationInheritMcpToolsets": delegation_inherit_mcp_toolsets,
    })
}

fn merge_hermes_execution_limits_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_execution_limits_config_values(config);
    let code_execution_mode = normalize_hermes_code_execution_mode(
        if form.get("codeExecutionMode").is_some() {
            form_string(form, "codeExecutionMode")
        } else {
            current["codeExecutionMode"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let code_execution_timeout = validate_hermes_i64(
        if form.get("codeExecutionTimeout").is_some() {
            form_i64(form, "codeExecutionTimeout")
        } else {
            Some(current["codeExecutionTimeout"].as_i64().unwrap_or(300))
        },
        "code_execution.timeout",
        300,
        1,
        86400,
    )?;
    let code_execution_max_tool_calls = validate_hermes_i64(
        if form.get("codeExecutionMaxToolCalls").is_some() {
            form_i64(form, "codeExecutionMaxToolCalls")
        } else {
            Some(current["codeExecutionMaxToolCalls"].as_i64().unwrap_or(50))
        },
        "code_execution.max_tool_calls",
        50,
        1,
        10000,
    )?;
    let delegation_max_iterations = validate_hermes_i64(
        if form.get("delegationMaxIterations").is_some() {
            form_i64(form, "delegationMaxIterations")
        } else {
            Some(current["delegationMaxIterations"].as_i64().unwrap_or(50))
        },
        "delegation.max_iterations",
        50,
        1,
        1000,
    )?;
    let delegation_child_timeout_seconds = validate_hermes_i64(
        if form.get("delegationChildTimeoutSeconds").is_some() {
            form_i64(form, "delegationChildTimeoutSeconds")
        } else {
            Some(
                current["delegationChildTimeoutSeconds"]
                    .as_i64()
                    .unwrap_or(600),
            )
        },
        "delegation.child_timeout_seconds",
        600,
        30,
        86400,
    )?;
    let delegation_max_concurrent_children = validate_hermes_i64(
        if form.get("delegationMaxConcurrentChildren").is_some() {
            form_i64(form, "delegationMaxConcurrentChildren")
        } else {
            Some(
                current["delegationMaxConcurrentChildren"]
                    .as_i64()
                    .unwrap_or(3),
            )
        },
        "delegation.max_concurrent_children",
        3,
        1,
        100,
    )?;
    let delegation_max_spawn_depth = validate_hermes_i64(
        if form.get("delegationMaxSpawnDepth").is_some() {
            form_i64(form, "delegationMaxSpawnDepth")
        } else {
            Some(current["delegationMaxSpawnDepth"].as_i64().unwrap_or(1))
        },
        "delegation.max_spawn_depth",
        1,
        1,
        3,
    )?;
    let delegation_orchestrator_enabled = form_bool(form, "delegationOrchestratorEnabled")
        .unwrap_or_else(|| {
            current["delegationOrchestratorEnabled"]
                .as_bool()
                .unwrap_or(true)
        });
    let delegation_subagent_auto_approve = form_bool(form, "delegationSubagentAutoApprove")
        .unwrap_or_else(|| {
            current["delegationSubagentAutoApprove"]
                .as_bool()
                .unwrap_or(false)
        });
    let delegation_inherit_mcp_toolsets = form_bool(form, "delegationInheritMcpToolsets")
        .unwrap_or_else(|| {
            current["delegationInheritMcpToolsets"]
                .as_bool()
                .unwrap_or(true)
        });

    let root = ensure_yaml_object(config)?;
    let code_execution = yaml_child_object(root, "code_execution")?;
    code_execution.insert(
        yaml_key("mode"),
        serde_yaml::Value::String(code_execution_mode),
    );
    code_execution.insert(
        yaml_key("timeout"),
        serde_yaml::Value::Number(code_execution_timeout.into()),
    );
    code_execution.insert(
        yaml_key("max_tool_calls"),
        serde_yaml::Value::Number(code_execution_max_tool_calls.into()),
    );

    let delegation = yaml_child_object(root, "delegation")?;
    delegation.insert(
        yaml_key("max_iterations"),
        serde_yaml::Value::Number(delegation_max_iterations.into()),
    );
    delegation.insert(
        yaml_key("child_timeout_seconds"),
        serde_yaml::Value::Number(delegation_child_timeout_seconds.into()),
    );
    delegation.insert(
        yaml_key("max_concurrent_children"),
        serde_yaml::Value::Number(delegation_max_concurrent_children.into()),
    );
    delegation.insert(
        yaml_key("max_spawn_depth"),
        serde_yaml::Value::Number(delegation_max_spawn_depth.into()),
    );
    delegation.insert(
        yaml_key("orchestrator_enabled"),
        serde_yaml::Value::Bool(delegation_orchestrator_enabled),
    );
    delegation.insert(
        yaml_key("subagent_auto_approve"),
        serde_yaml::Value::Bool(delegation_subagent_auto_approve),
    );
    delegation.insert(
        yaml_key("inherit_mcp_toolsets"),
        serde_yaml::Value::Bool(delegation_inherit_mcp_toolsets),
    );
    Ok(())
}

fn build_hermes_terminal_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let terminal = root.and_then(|map| yaml_get_mapping(map, "terminal"));
    let terminal_backend = normalize_hermes_terminal_backend(
        terminal.and_then(|map| yaml_string_field(map, "backend")),
        false,
    )
    .unwrap_or_else(|_| "local".to_string());
    let terminal_cwd = terminal
        .and_then(|map| yaml_string_field(map, "cwd"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let terminal_timeout = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout"), 180, 1, 86400))
        .unwrap_or(180);
    let terminal_lifetime_seconds = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "lifetime_seconds"), 300, 0, 86400))
        .unwrap_or(300);
    let terminal_docker_mount_cwd_to_workspace = terminal
        .and_then(|map| yaml_bool_field(map, "docker_mount_cwd_to_workspace"))
        .unwrap_or(false);
    let terminal_docker_run_as_host_user = terminal
        .and_then(|map| yaml_bool_field(map, "docker_run_as_host_user"))
        .unwrap_or(false);
    let terminal_container_cpu = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "container_cpu"), 1, 1, 64))
        .unwrap_or(1);
    let terminal_container_memory = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "container_memory"), 5120, 128, 1048576))
        .unwrap_or(5120);
    let terminal_container_disk = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "container_disk"), 51200, 1024, 10485760))
        .unwrap_or(51200);
    let terminal_container_persistent = terminal
        .and_then(|map| yaml_bool_field(map, "container_persistent"))
        .unwrap_or(true);

    serde_json::json!({
        "terminalBackend": terminal_backend,
        "terminalCwd": terminal_cwd,
        "terminalTimeout": terminal_timeout,
        "terminalLifetimeSeconds": terminal_lifetime_seconds,
        "terminalDockerMountCwdToWorkspace": terminal_docker_mount_cwd_to_workspace,
        "terminalDockerRunAsHostUser": terminal_docker_run_as_host_user,
        "terminalContainerCpu": terminal_container_cpu,
        "terminalContainerMemory": terminal_container_memory,
        "terminalContainerDisk": terminal_container_disk,
        "terminalContainerPersistent": terminal_container_persistent,
    })
}

fn merge_hermes_terminal_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_terminal_config_values(config);
    let terminal_backend = normalize_hermes_terminal_backend(
        if form.get("terminalBackend").is_some() {
            form_string(form, "terminalBackend")
        } else {
            current["terminalBackend"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let terminal_cwd = if form.get("terminalCwd").is_some() {
        form_string(form, "terminalCwd")
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        current["terminalCwd"].as_str().unwrap_or(".").to_string()
    };
    let terminal_cwd = if terminal_cwd.trim().is_empty() {
        ".".to_string()
    } else {
        terminal_cwd
    };
    let terminal_timeout = validate_hermes_i64(
        if form.get("terminalTimeout").is_some() {
            form_i64(form, "terminalTimeout")
        } else {
            Some(current["terminalTimeout"].as_i64().unwrap_or(180))
        },
        "terminal.timeout",
        180,
        1,
        86400,
    )?;
    let terminal_lifetime_seconds = validate_hermes_i64(
        if form.get("terminalLifetimeSeconds").is_some() {
            form_i64(form, "terminalLifetimeSeconds")
        } else {
            Some(current["terminalLifetimeSeconds"].as_i64().unwrap_or(300))
        },
        "terminal.lifetime_seconds",
        300,
        0,
        86400,
    )?;
    let terminal_docker_mount_cwd_to_workspace =
        form_bool(form, "terminalDockerMountCwdToWorkspace").unwrap_or_else(|| {
            current["terminalDockerMountCwdToWorkspace"]
                .as_bool()
                .unwrap_or(false)
        });
    let terminal_docker_run_as_host_user = form_bool(form, "terminalDockerRunAsHostUser")
        .unwrap_or_else(|| {
            current["terminalDockerRunAsHostUser"]
                .as_bool()
                .unwrap_or(false)
        });
    let terminal_container_cpu = validate_hermes_i64(
        if form.get("terminalContainerCpu").is_some() {
            form_i64(form, "terminalContainerCpu")
        } else {
            Some(current["terminalContainerCpu"].as_i64().unwrap_or(1))
        },
        "terminal.container_cpu",
        1,
        1,
        64,
    )?;
    let terminal_container_memory = validate_hermes_i64(
        if form.get("terminalContainerMemory").is_some() {
            form_i64(form, "terminalContainerMemory")
        } else {
            Some(current["terminalContainerMemory"].as_i64().unwrap_or(5120))
        },
        "terminal.container_memory",
        5120,
        128,
        1048576,
    )?;
    let terminal_container_disk = validate_hermes_i64(
        if form.get("terminalContainerDisk").is_some() {
            form_i64(form, "terminalContainerDisk")
        } else {
            Some(current["terminalContainerDisk"].as_i64().unwrap_or(51200))
        },
        "terminal.container_disk",
        51200,
        1024,
        10485760,
    )?;
    let terminal_container_persistent = form_bool(form, "terminalContainerPersistent")
        .unwrap_or_else(|| {
            current["terminalContainerPersistent"]
                .as_bool()
                .unwrap_or(true)
        });

    let root = ensure_yaml_object(config)?;
    let terminal = yaml_child_object(root, "terminal")?;
    terminal.insert(
        yaml_key("backend"),
        serde_yaml::Value::String(terminal_backend),
    );
    terminal.insert(yaml_key("cwd"), serde_yaml::Value::String(terminal_cwd));
    terminal.insert(
        yaml_key("timeout"),
        serde_yaml::Value::Number(terminal_timeout.into()),
    );
    terminal.insert(
        yaml_key("lifetime_seconds"),
        serde_yaml::Value::Number(terminal_lifetime_seconds.into()),
    );
    terminal.insert(
        yaml_key("docker_mount_cwd_to_workspace"),
        serde_yaml::Value::Bool(terminal_docker_mount_cwd_to_workspace),
    );
    terminal.insert(
        yaml_key("docker_run_as_host_user"),
        serde_yaml::Value::Bool(terminal_docker_run_as_host_user),
    );
    terminal.insert(
        yaml_key("container_cpu"),
        serde_yaml::Value::Number(terminal_container_cpu.into()),
    );
    terminal.insert(
        yaml_key("container_memory"),
        serde_yaml::Value::Number(terminal_container_memory.into()),
    );
    terminal.insert(
        yaml_key("container_disk"),
        serde_yaml::Value::Number(terminal_container_disk.into()),
    );
    terminal.insert(
        yaml_key("container_persistent"),
        serde_yaml::Value::Bool(terminal_container_persistent),
    );
    Ok(())
}

fn build_hermes_session_runtime_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let session_reset = root.and_then(|map| yaml_get_mapping(map, "session_reset"));
    let mode = session_reset
        .and_then(|map| yaml_string_field(map, "mode"))
        .map(|value| value.trim().to_string())
        .filter(|value| matches!(value.as_str(), "both" | "idle" | "daily" | "none"))
        .unwrap_or_else(|| "both".to_string());
    let idle_minutes = session_reset
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "idle_minutes"), 1440, 1, 525600))
        .unwrap_or(1440);
    let at_hour = session_reset
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "at_hour"), 4, 0, 23))
        .unwrap_or(4);
    let group_sessions_per_user = root
        .and_then(|map| yaml_bool_field(map, "group_sessions_per_user"))
        .unwrap_or(true);
    let thread_sessions_per_user = root
        .and_then(|map| yaml_bool_field(map, "thread_sessions_per_user"))
        .unwrap_or(false);

    serde_json::json!({
        "sessionResetMode": mode,
        "idleMinutes": idle_minutes,
        "atHour": at_hour,
        "groupSessionsPerUser": group_sessions_per_user,
        "threadSessionsPerUser": thread_sessions_per_user,
    })
}

fn merge_hermes_session_runtime_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_session_runtime_config_values(config);
    let current_mode = current["sessionResetMode"].as_str().unwrap_or("both");
    let mode = if form.get("sessionResetMode").is_some() {
        form_string(form, "sessionResetMode")
            .map(|value| value.trim().to_string())
            .filter(|value| matches!(value.as_str(), "both" | "idle" | "daily" | "none"))
            .ok_or_else(|| "session_reset.mode 必须是 both、idle、daily 或 none".to_string())?
    } else {
        current_mode.to_string()
    };
    let current_idle_minutes = current["idleMinutes"].as_i64().unwrap_or(1440);
    let idle_minutes = validate_hermes_i64(
        if form.get("idleMinutes").is_some() {
            form_i64(form, "idleMinutes")
        } else {
            Some(current_idle_minutes)
        },
        "idle_minutes",
        1440,
        1,
        525600,
    )?;
    let current_at_hour = current["atHour"].as_i64().unwrap_or(4);
    let at_hour = validate_hermes_i64(
        if form.get("atHour").is_some() {
            form_i64(form, "atHour")
        } else {
            Some(current_at_hour)
        },
        "at_hour",
        4,
        0,
        23,
    )?;
    let group_sessions_per_user = form_bool(form, "groupSessionsPerUser")
        .unwrap_or_else(|| current["groupSessionsPerUser"].as_bool().unwrap_or(true));
    let thread_sessions_per_user = form_bool(form, "threadSessionsPerUser")
        .unwrap_or_else(|| current["threadSessionsPerUser"].as_bool().unwrap_or(false));

    let root = ensure_yaml_object(config)?;
    let session_reset = yaml_child_object(root, "session_reset")?;
    session_reset.insert(yaml_key("mode"), serde_yaml::Value::String(mode));
    session_reset.insert(
        yaml_key("idle_minutes"),
        serde_yaml::Value::Number(idle_minutes.into()),
    );
    session_reset.insert(
        yaml_key("at_hour"),
        serde_yaml::Value::Number(at_hour.into()),
    );
    root.insert(
        yaml_key("group_sessions_per_user"),
        serde_yaml::Value::Bool(group_sessions_per_user),
    );
    root.insert(
        yaml_key("thread_sessions_per_user"),
        serde_yaml::Value::Bool(thread_sessions_per_user),
    );
    Ok(())
}

fn merge_hermes_channel_config(
    config: &mut serde_yaml::Value,
    platform: &str,
    form: &Value,
) -> Result<(), String> {
    let platform = normalize_hermes_channel_platform(platform)
        .ok_or_else(|| format!("不支持的 Hermes 渠道: {platform}"))?;
    let root = ensure_yaml_object(config)?;
    merge_hermes_channel_display_config(root, platform, form)?;
    let platforms = yaml_child_object(root, "platforms")?;
    let entry = yaml_child_object(platforms, platform)?;

    entry.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(form_bool(form, "enabled").unwrap_or(false)),
    );

    match platform {
        "telegram" => delete_yaml_key(entry, "token"),
        "discord" => {
            delete_yaml_key(entry, "token");
            for (form_key_name, extra_key_name) in [
                ("freeResponseChannels", "free_response_channels"),
                ("allowedChannels", "allowed_channels"),
                ("ignoredChannels", "ignored_channels"),
                ("noThreadChannels", "no_thread_channels"),
            ] {
                if let Some(values) = form_string_array(form, form_key_name) {
                    set_extra_string_array(entry, extra_key_name, values);
                }
            }
            for (form_key_name, extra_key_name) in [
                ("autoThread", "auto_thread"),
                ("reactions", "reactions"),
                ("threadRequireMention", "thread_require_mention"),
                ("historyBackfill", "history_backfill"),
            ] {
                if let Some(value) = form_bool(form, form_key_name) {
                    set_extra_bool(entry, extra_key_name, value);
                }
            }
            set_extra_string_if_present(
                entry,
                "history_backfill_limit",
                form_string(form, "historyBackfillLimit"),
            );
            set_extra_string_if_present(entry, "reply_to_mode", form_string(form, "replyToMode"));
        }
        "slack" => {
            delete_yaml_key(entry, "token");
            delete_extra_key(entry, "app_token");
            delete_extra_key(entry, "signing_secret");
            set_extra_string_if_present(
                entry,
                "webhook_path",
                Some(form_string_or_default(form, "webhookPath", "/slack/events")),
            );
        }
        "feishu" => {
            delete_extra_key(entry, "app_id");
            delete_extra_key(entry, "app_secret");
            set_extra_string_if_present(
                entry,
                "domain",
                Some(form_string_or_default(form, "domain", "feishu")),
            );
            set_extra_string_if_present(
                entry,
                "connection_mode",
                Some(form_string_or_default(form, "connectionMode", "websocket")),
            );
            set_extra_string_if_present(
                entry,
                "webhook_path",
                Some(form_string_or_default(
                    form,
                    "webhookPath",
                    "/feishu/webhook",
                )),
            );
            set_extra_string_if_present(
                entry,
                "reaction_notifications",
                Some(form_string_or_default(form, "reactionNotifications", "off")),
            );
            set_extra_bool(
                entry,
                "typing_indicator",
                form_bool(form, "typingIndicator").unwrap_or(true),
            );
            set_extra_bool(
                entry,
                "resolve_sender_names",
                form_bool(form, "resolveSenderNames").unwrap_or(true),
            );
        }
        "dingtalk" => {
            delete_extra_key(entry, "client_id");
            delete_extra_key(entry, "client_secret");
            delete_extra_key(entry, "allow_from");
            delete_extra_key(entry, "group_allow_from");
        }
        "teams" => {
            delete_extra_key(entry, "client_id");
            delete_extra_key(entry, "client_secret");
            delete_extra_key(entry, "tenant_id");
            set_extra_integer_if_present(entry, "port", form_i64(form, "port"));
            set_extra_string_if_present(entry, "service_url", form_string(form, "serviceUrl"));
            set_hermes_home_channel(entry, form);
        }
        "google_chat" => {
            set_extra_string_if_present(entry, "project_id", form_string(form, "projectId"));
            set_extra_string_if_present(
                entry,
                "subscription_name",
                form_string(form, "subscriptionName"),
            );
            delete_extra_key(entry, "service_account_json");
            set_hermes_home_channel(entry, form);
        }
        "irc" => {
            set_extra_string_if_present(entry, "server", form_string(form, "server"));
            set_extra_integer_if_present(entry, "port", form_i64(form, "port"));
            set_extra_string_if_present(entry, "nickname", form_string(form, "nickname"));
            set_extra_string_if_present(entry, "channel", form_string(form, "channel"));
            if let Some(value) = form_bool(form, "useTls") {
                set_extra_bool(entry, "use_tls", value);
            }
            delete_extra_key(entry, "server_password");
            delete_extra_key(entry, "nickserv_password");
            set_hermes_home_channel(entry, form);
        }
        "line" => {
            delete_extra_key(entry, "channel_access_token");
            delete_extra_key(entry, "channel_secret");
            set_extra_integer_if_present(entry, "port", form_i64(form, "port"));
            set_extra_string_if_present(entry, "host", form_string(form, "host"));
            set_extra_string_if_present(entry, "public_url", form_string(form, "publicUrl"));
            if let Some(values) = form_string_array(form, "allowedGroups") {
                set_extra_string_array(entry, "allowed_groups", values);
            }
            if let Some(values) = form_string_array(form, "allowedRooms") {
                set_extra_string_array(entry, "allowed_rooms", values);
            }
            set_extra_string_if_present(
                entry,
                "slow_response_threshold",
                form_string(form, "slowResponseThreshold"),
            );
            set_hermes_home_channel(entry, form);
        }
        "simplex" => {
            set_extra_string_if_present(entry, "ws_url", form_string(form, "wsUrl"));
            set_hermes_home_channel(entry, form);
        }
        _ => {}
    }

    if form.get("dmPolicy").is_some() {
        set_extra_string_if_present(
            entry,
            "dm_policy",
            Some(normalize_hermes_dm_policy(form_string(form, "dmPolicy"))),
        );
    }
    if form.get("groupPolicy").is_some() {
        let group_policy = normalize_hermes_group_policy(form_string(form, "groupPolicy"));
        set_extra_string_if_present(entry, "group_policy", Some(group_policy.clone()));
        if platform == "feishu" {
            set_extra_string_if_present(entry, "default_group_policy", Some(group_policy));
        }
    }
    if let Some(value) = form_bool(form, "requireMention") {
        set_extra_bool(entry, "require_mention", value);
    }
    if let Some(values) = form_string_array(form, "allowFrom") {
        let key = if ["dingtalk", "irc", "line", "simplex"].contains(&platform) {
            "allowed_users"
        } else {
            "allow_from"
        };
        set_extra_string_array(entry, key, values);
    }
    if let Some(values) = form_string_array(form, "groupAllowFrom") {
        let key = if platform == "dingtalk" {
            "allowed_chats"
        } else {
            "group_allow_from"
        };
        set_extra_string_array(entry, key, values);
    }

    Ok(())
}

fn read_hermes_channel_yaml_config() -> Result<(PathBuf, bool, serde_yaml::Value), String> {
    let config_path = hermes_home().join("config.yaml");
    if !config_path.exists() {
        return Ok((
            config_path,
            false,
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        ));
    }
    let raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取 config.yaml 失败: {e}"))?;
    let config = if raw.trim().is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(&raw).map_err(|e| format!("解析 config.yaml 失败: {e}"))?
    };
    Ok((config_path, true, config))
}

fn write_hermes_yaml_config(path: &PathBuf, config: &serde_yaml::Value) -> Result<String, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Hermes 配置目录失败: {e}"))?;
    }
    let mut backup_path = String::new();
    if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_extension(format!("yaml.bak-{ts}"));
        if std::fs::copy(path, &backup).is_ok() {
            backup_path = backup.to_string_lossy().to_string();
        }
    }
    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("序列化 config.yaml 失败: {e}"))?;
    std::fs::write(path, yaml).map_err(|e| format!("写入 config.yaml 失败: {e}"))?;
    Ok(backup_path)
}

fn csv_env_value(form: &Value, key: &str) -> String {
    form_string_array(form, key).unwrap_or_default().join(",")
}

fn bool_env_value(value: bool) -> String {
    if value { "true" } else { "false" }.to_string()
}

fn build_hermes_channel_env_updates(platform: &str, form: &Value) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut push = |key: &str, value: String| {
        let value = value.trim().to_string();
        if !value.is_empty() {
            pairs.push((key.to_string(), value));
        }
    };

    match platform {
        "telegram" => {
            push(
                "TELEGRAM_BOT_TOKEN",
                form_string(form, "botToken").unwrap_or_default(),
            );
            push("TELEGRAM_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            push(
                "TELEGRAM_GROUP_ALLOWED_USERS",
                csv_env_value(form, "groupAllowFrom"),
            );
            if let Some(value) = form_bool(form, "requireMention") {
                push("TELEGRAM_REQUIRE_MENTION", bool_env_value(value));
            }
        }
        "discord" => {
            push(
                "DISCORD_BOT_TOKEN",
                form_string(form, "token").unwrap_or_default(),
            );
            push("DISCORD_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            if let Some(value) = form_bool(form, "requireMention") {
                push("DISCORD_REQUIRE_MENTION", bool_env_value(value));
            }
            push(
                "DISCORD_FREE_RESPONSE_CHANNELS",
                csv_env_value(form, "freeResponseChannels"),
            );
            push(
                "DISCORD_ALLOWED_CHANNELS",
                csv_env_value(form, "allowedChannels"),
            );
            push(
                "DISCORD_IGNORED_CHANNELS",
                csv_env_value(form, "ignoredChannels"),
            );
            push(
                "DISCORD_NO_THREAD_CHANNELS",
                csv_env_value(form, "noThreadChannels"),
            );
            if let Some(value) = form_bool(form, "autoThread") {
                push("DISCORD_AUTO_THREAD", bool_env_value(value));
            }
            if let Some(value) = form_bool(form, "reactions") {
                push("DISCORD_REACTIONS", bool_env_value(value));
            }
            if let Some(value) = form_bool(form, "threadRequireMention") {
                push("DISCORD_THREAD_REQUIRE_MENTION", bool_env_value(value));
            }
            if let Some(value) = form_bool(form, "historyBackfill") {
                push("DISCORD_HISTORY_BACKFILL", bool_env_value(value));
            }
            push(
                "DISCORD_HISTORY_BACKFILL_LIMIT",
                form_string(form, "historyBackfillLimit").unwrap_or_default(),
            );
            push(
                "DISCORD_REPLY_TO_MODE",
                form_string(form, "replyToMode").unwrap_or_default(),
            );
            push(
                "DISCORD_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "DISCORD_HOME_CHANNEL_NAME",
                form_string(form, "homeChannelName").unwrap_or_default(),
            );
        }
        "slack" => {
            push(
                "SLACK_BOT_TOKEN",
                form_string(form, "botToken").unwrap_or_default(),
            );
            push(
                "SLACK_APP_TOKEN",
                form_string(form, "appToken").unwrap_or_default(),
            );
            push("SLACK_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            if let Some(value) = form_bool(form, "requireMention") {
                push("SLACK_REQUIRE_MENTION", bool_env_value(value));
            }
        }
        "feishu" => {
            push(
                "FEISHU_APP_ID",
                form_string(form, "appId").unwrap_or_default(),
            );
            push(
                "FEISHU_APP_SECRET",
                form_string(form, "appSecret").unwrap_or_default(),
            );
            push(
                "FEISHU_DOMAIN",
                form_string_or_default(form, "domain", "feishu"),
            );
            push(
                "FEISHU_CONNECTION_MODE",
                form_string_or_default(form, "connectionMode", "websocket"),
            );
            push(
                "FEISHU_WEBHOOK_PATH",
                form_string_or_default(form, "webhookPath", "/feishu/webhook"),
            );
            push("FEISHU_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            push(
                "FEISHU_GROUP_POLICY",
                normalize_hermes_group_policy(form_string(form, "groupPolicy")),
            );
            push(
                "FEISHU_REQUIRE_MENTION",
                bool_env_value(form_bool(form, "requireMention").unwrap_or(true)),
            );
            let reactions = form_string(form, "reactionNotifications").unwrap_or_default();
            push(
                "FEISHU_REACTIONS",
                if reactions.trim() == "off" {
                    "false"
                } else {
                    "true"
                }
                .to_string(),
            );
        }
        "dingtalk" => {
            push(
                "DINGTALK_CLIENT_ID",
                form_string(form, "clientId").unwrap_or_default(),
            );
            push(
                "DINGTALK_CLIENT_SECRET",
                form_string(form, "clientSecret").unwrap_or_default(),
            );
            push("DINGTALK_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            push(
                "DINGTALK_ALLOWED_CHATS",
                csv_env_value(form, "groupAllowFrom"),
            );
            if let Some(value) = form_bool(form, "requireMention") {
                push("DINGTALK_REQUIRE_MENTION", bool_env_value(value));
            }
        }
        "teams" => {
            push(
                "TEAMS_CLIENT_ID",
                form_string(form, "clientId").unwrap_or_default(),
            );
            push(
                "TEAMS_CLIENT_SECRET",
                form_string(form, "clientSecret").unwrap_or_default(),
            );
            push(
                "TEAMS_TENANT_ID",
                form_string(form, "tenantId").unwrap_or_default(),
            );
            push("TEAMS_PORT", form_string(form, "port").unwrap_or_default());
            push(
                "TEAMS_SERVICE_URL",
                form_string(form, "serviceUrl").unwrap_or_default(),
            );
            push("TEAMS_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            if let Some(value) = form_bool(form, "allowAllUsers") {
                push("TEAMS_ALLOW_ALL_USERS", bool_env_value(value));
            }
            push(
                "TEAMS_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "TEAMS_HOME_CHANNEL_NAME",
                form_string(form, "homeChannelName").unwrap_or_default(),
            );
        }
        "google_chat" => {
            push(
                "GOOGLE_CHAT_PROJECT_ID",
                form_string(form, "projectId").unwrap_or_default(),
            );
            push(
                "GOOGLE_CHAT_SUBSCRIPTION_NAME",
                form_string(form, "subscriptionName").unwrap_or_default(),
            );
            push(
                "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON",
                form_string(form, "serviceAccountJson").unwrap_or_default(),
            );
            push(
                "GOOGLE_CHAT_ALLOWED_USERS",
                csv_env_value(form, "allowFrom"),
            );
            if let Some(value) = form_bool(form, "allowAllUsers") {
                push("GOOGLE_CHAT_ALLOW_ALL_USERS", bool_env_value(value));
            }
            push(
                "GOOGLE_CHAT_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "GOOGLE_CHAT_HOME_CHANNEL_NAME",
                form_string(form, "homeChannelName").unwrap_or_default(),
            );
        }
        "irc" => {
            push(
                "IRC_SERVER",
                form_string(form, "server").unwrap_or_default(),
            );
            push("IRC_PORT", form_string(form, "port").unwrap_or_default());
            push(
                "IRC_NICKNAME",
                form_string(form, "nickname").unwrap_or_default(),
            );
            push(
                "IRC_CHANNEL",
                form_string(form, "channel").unwrap_or_default(),
            );
            if let Some(value) = form_bool(form, "useTls") {
                push("IRC_USE_TLS", bool_env_value(value));
            }
            push(
                "IRC_SERVER_PASSWORD",
                form_string(form, "serverPassword").unwrap_or_default(),
            );
            push(
                "IRC_NICKSERV_PASSWORD",
                form_string(form, "nickservPassword").unwrap_or_default(),
            );
            push("IRC_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            if let Some(value) = form_bool(form, "allowAllUsers") {
                push("IRC_ALLOW_ALL_USERS", bool_env_value(value));
            }
            push(
                "IRC_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "IRC_HOME_CHANNEL_NAME",
                form_string(form, "homeChannelName").unwrap_or_default(),
            );
        }
        "line" => {
            push(
                "LINE_CHANNEL_ACCESS_TOKEN",
                form_string(form, "channelAccessToken").unwrap_or_default(),
            );
            push(
                "LINE_CHANNEL_SECRET",
                form_string(form, "channelSecret").unwrap_or_default(),
            );
            push("LINE_PORT", form_string(form, "port").unwrap_or_default());
            push("LINE_HOST", form_string(form, "host").unwrap_or_default());
            push(
                "LINE_PUBLIC_URL",
                form_string(form, "publicUrl").unwrap_or_default(),
            );
            push("LINE_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            push("LINE_ALLOWED_GROUPS", csv_env_value(form, "allowedGroups"));
            push("LINE_ALLOWED_ROOMS", csv_env_value(form, "allowedRooms"));
            if let Some(value) = form_bool(form, "allowAllUsers") {
                push("LINE_ALLOW_ALL_USERS", bool_env_value(value));
            }
            push(
                "LINE_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "LINE_SLOW_RESPONSE_THRESHOLD",
                form_string(form, "slowResponseThreshold").unwrap_or_default(),
            );
        }
        "simplex" => {
            push(
                "SIMPLEX_WS_URL",
                form_string(form, "wsUrl").unwrap_or_default(),
            );
            push("SIMPLEX_ALLOWED_USERS", csv_env_value(form, "allowFrom"));
            if let Some(value) = form_bool(form, "allowAllUsers") {
                push("SIMPLEX_ALLOW_ALL_USERS", bool_env_value(value));
            }
            push(
                "SIMPLEX_HOME_CHANNEL",
                form_string(form, "homeChannel").unwrap_or_default(),
            );
            push(
                "SIMPLEX_HOME_CHANNEL_NAME",
                form_string(form, "homeChannelName").unwrap_or_default(),
            );
        }
        _ => {}
    }

    pairs
}

fn write_hermes_channel_env(platform: &str, form: &Value) -> Result<(), String> {
    let env_path = hermes_home().join(".env");
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Hermes 配置目录失败: {e}"))?;
    }
    let raw = std::fs::read_to_string(&env_path).unwrap_or_default();
    let managed_keys: Vec<&str> = match platform {
        "telegram" => vec![
            "TELEGRAM_BOT_TOKEN",
            "TELEGRAM_ALLOWED_USERS",
            "TELEGRAM_GROUP_ALLOWED_USERS",
            "TELEGRAM_REQUIRE_MENTION",
        ],
        "discord" => vec![
            "DISCORD_BOT_TOKEN",
            "DISCORD_ALLOWED_USERS",
            "DISCORD_REQUIRE_MENTION",
            "DISCORD_FREE_RESPONSE_CHANNELS",
            "DISCORD_ALLOWED_CHANNELS",
            "DISCORD_IGNORED_CHANNELS",
            "DISCORD_NO_THREAD_CHANNELS",
            "DISCORD_AUTO_THREAD",
            "DISCORD_REACTIONS",
            "DISCORD_THREAD_REQUIRE_MENTION",
            "DISCORD_HISTORY_BACKFILL",
            "DISCORD_HISTORY_BACKFILL_LIMIT",
            "DISCORD_REPLY_TO_MODE",
            "DISCORD_HOME_CHANNEL",
            "DISCORD_HOME_CHANNEL_NAME",
        ],
        "slack" => vec![
            "SLACK_BOT_TOKEN",
            "SLACK_APP_TOKEN",
            "SLACK_ALLOWED_USERS",
            "SLACK_REQUIRE_MENTION",
        ],
        "feishu" => vec![
            "FEISHU_APP_ID",
            "FEISHU_APP_SECRET",
            "FEISHU_DOMAIN",
            "FEISHU_CONNECTION_MODE",
            "FEISHU_WEBHOOK_PATH",
            "FEISHU_ALLOWED_USERS",
            "FEISHU_GROUP_POLICY",
            "FEISHU_REQUIRE_MENTION",
            "FEISHU_REACTIONS",
        ],
        "dingtalk" => vec![
            "DINGTALK_CLIENT_ID",
            "DINGTALK_CLIENT_SECRET",
            "DINGTALK_ALLOWED_USERS",
            "DINGTALK_ALLOWED_CHATS",
            "DINGTALK_REQUIRE_MENTION",
        ],
        "teams" => vec![
            "TEAMS_CLIENT_ID",
            "TEAMS_CLIENT_SECRET",
            "TEAMS_TENANT_ID",
            "TEAMS_PORT",
            "TEAMS_SERVICE_URL",
            "TEAMS_ALLOWED_USERS",
            "TEAMS_ALLOW_ALL_USERS",
            "TEAMS_HOME_CHANNEL",
            "TEAMS_HOME_CHANNEL_NAME",
        ],
        "google_chat" => vec![
            "GOOGLE_CHAT_PROJECT_ID",
            "GOOGLE_CHAT_SUBSCRIPTION_NAME",
            "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON",
            "GOOGLE_CHAT_ALLOWED_USERS",
            "GOOGLE_CHAT_ALLOW_ALL_USERS",
            "GOOGLE_CHAT_HOME_CHANNEL",
            "GOOGLE_CHAT_HOME_CHANNEL_NAME",
        ],
        "irc" => vec![
            "IRC_SERVER",
            "IRC_PORT",
            "IRC_NICKNAME",
            "IRC_CHANNEL",
            "IRC_USE_TLS",
            "IRC_SERVER_PASSWORD",
            "IRC_NICKSERV_PASSWORD",
            "IRC_ALLOWED_USERS",
            "IRC_ALLOW_ALL_USERS",
            "IRC_HOME_CHANNEL",
            "IRC_HOME_CHANNEL_NAME",
        ],
        "line" => vec![
            "LINE_CHANNEL_ACCESS_TOKEN",
            "LINE_CHANNEL_SECRET",
            "LINE_PORT",
            "LINE_HOST",
            "LINE_PUBLIC_URL",
            "LINE_ALLOWED_USERS",
            "LINE_ALLOWED_GROUPS",
            "LINE_ALLOWED_ROOMS",
            "LINE_ALLOW_ALL_USERS",
            "LINE_HOME_CHANNEL",
            "LINE_SLOW_RESPONSE_THRESHOLD",
        ],
        "simplex" => vec![
            "SIMPLEX_WS_URL",
            "SIMPLEX_ALLOWED_USERS",
            "SIMPLEX_ALLOW_ALL_USERS",
            "SIMPLEX_HOME_CHANNEL",
            "SIMPLEX_HOME_CHANNEL_NAME",
        ],
        _ => Vec::new(),
    };
    let pairs = build_hermes_channel_env_updates(platform, form);
    let content = merge_env_file(&raw, &managed_keys, &pairs);
    std::fs::write(&env_path, content).map_err(|e| format!("写入 .env 失败: {e}"))
}

#[tauri::command]
pub fn hermes_channel_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    let env_values = read_hermes_channel_env_values();
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_channel_config_values(&config, &env_values),
    }))
}

#[tauri::command]
pub fn hermes_channel_config_save(platform: String, form: Value) -> Result<Value, String> {
    let platform = normalize_hermes_channel_platform(&platform)
        .ok_or_else(|| format!("不支持的 Hermes 渠道: {}", platform.trim()))?;
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_channel_config(&mut config, platform, &form)?;
    write_hermes_yaml_config(&config_path, &config)?;
    write_hermes_channel_env(platform, &form)?;
    let mut env_values = read_hermes_channel_env_values();
    for (key, value) in build_hermes_channel_env_updates(platform, &form) {
        env_values.insert(key, value);
    }
    let values = build_hermes_channel_config_values(&config, &env_values);
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "values": values.get(platform).cloned().unwrap_or(Value::Null),
    }))
}

#[tauri::command]
pub fn hermes_session_runtime_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_session_runtime_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_session_runtime_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_session_runtime_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_session_runtime_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_compression_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_compression_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_compression_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_compression_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_compression_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_tool_loop_guardrails_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_tool_loop_guardrails_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_tool_loop_guardrails_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_tool_loop_guardrails_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_tool_loop_guardrails_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_memory_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_memory_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_memory_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_memory_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_memory_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_skills_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_skills_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_skills_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_skills_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_skills_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_quick_commands_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_quick_commands_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_quick_commands_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_quick_commands_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_quick_commands_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_unauthorized_dm_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_unauthorized_dm_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_unauthorized_dm_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_unauthorized_dm_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_unauthorized_dm_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_security_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_security_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_security_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_security_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_security_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_human_delay_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_human_delay_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_human_delay_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_human_delay_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_human_delay_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_streaming_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_streaming_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_streaming_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_streaming_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_streaming_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_execution_limits_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_execution_limits_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_execution_limits_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_execution_limits_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_execution_limits_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_terminal_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_terminal_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_terminal_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_terminal_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_terminal_config_values(&config),
    }))
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
    let _ = sanitize_hermes_openrouter_custom_mismatch();

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
    let yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&raw).map_err(|e| format!("Invalid YAML in config.yaml: {e}"))?;
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
            let v = config_json.get(*k).cloned().unwrap_or(Value::Null);
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
    serde_json::from_str(last_line).map_err(|e| format!("Python 输出解析失败: {e}\n原文: {stdout}"))
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
    let features_literal =
        serde_json::to_string(&features).map_err(|e| format!("features 序列化失败: {e}"))?;
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
    let feature_literal =
        serde_json::to_string(&feature).map_err(|e| format!("feature 名序列化失败: {e}"))?;
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
    let _ = sanitize_hermes_openrouter_custom_mismatch()?;
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
            let _ = sanitize_hermes_openrouter_custom_mismatch()?;
            if gateway_quick_health_check().await {
                start_guardian(&app);
                emit_gateway_status(true);
                return Ok("Gateway 已在运行".into());
            }
            let _start_guard = if let Some(guard) = try_gateway_start_guard() {
                guard
            } else {
                for _ in 0..40 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if gateway_quick_health_check().await {
                        start_guardian(&app);
                        emit_gateway_status(true);
                        return Ok("Gateway 已在运行".into());
                    }
                }
                return Err("Gateway 正在启动中，请稍后重试".into());
            };
            if gateway_quick_health_check().await {
                start_guardian(&app);
                emit_gateway_status(true);
                return Ok("Gateway 已在运行".into());
            }

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
        "message.delta"
        | "run.completed"
        | "run.failed"
        | "run.cancelled"
        | "tool.started"
        | "tool.completed"
        | "tool.progress"
        | "tool.error"
        | "reasoning.available"
        | "approval.request"
        | "approval.responded" => {
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
    Ok(resp
        .json::<Value>()
        .await
        .unwrap_or(serde_json::json!({ "ok": true })))
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
        other => {
            return Err(format!(
                "approval choice 必须是 once/session/always/deny，收到 {other}"
            ))
        }
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
    Ok(resp
        .json::<Value>()
        .await
        .unwrap_or(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Batch 2 §I: hermes_run_status — 查 run 当前状态（流恢复用）
//
// GET /v1/runs/{run_id} 返回 { run_id, status, last_event, output?, ... }
// status 取值：running / stopping / completed / failed / cancelled / waiting_for_approval
// 切页 / 刷新后用这个判断是否还需要重连 SSE 事件流
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hermes_run_status(run_id: String) -> Result<Value, String> {
    if run_id.is_empty() {
        return Err("run_id 不能为空".to_string());
    }
    let gw_url = hermes_gateway_url();
    let url = format!("{gw_url}/v1/runs/{run_id}");
    let api_key = read_hermes_api_key();
    let client = hermes_gateway_http_client(std::time::Duration::from_secs(5))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("status 请求失败: {}", reqwest_error_detail(&e)))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        // run 已过期或不存在 — 返回明确状态而不是错
        return Ok(serde_json::json!({ "run_id": run_id, "status": "not_found" }));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("status 失败 HTTP {}: {}", status.as_u16(), body));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("解析 JSON 失败: {e}"))
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

    let resp = client.get(&url).send().await.map_err(|e| {
        format!(
            "export 请求失败: {}（提示：请先启动 Dashboard）",
            reqwest_error_detail(&e)
        )
    })?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("export 失败 HTTP {}: {}", status.as_u16(), body));
    }
    // 让前端拿原始 JSON 自己打包下载（保留完整结构）
    resp.json::<Value>()
        .await
        .map_err(|e| format!("解析 JSON 失败: {e}"))
}

// ---------------------------------------------------------------------------
// Batch 2 §H 基础设施: hermes_dashboard_api_proxy
//
// 通用 Dashboard 9119 HTTP 代理 — 让前端直接调任意 /api/* 端点。
// Profiles / Kanban / OAuth / Sessions（高级）等都走这一个入口，
// 避免给每个端点都写专属 Tauri 命令。
//
// 与 hermes_api_proxy 区别：
//   - hermes_api_proxy 走 Gateway 8642（含 API_SERVER_KEY 认证）
//   - hermes_dashboard_api_proxy 走 Dashboard 9119（无需 token，本地绑定）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard session token 缓存
//
// Hermes Dashboard 9119 大部分 /api/* 端点需要 token 鉴权（_require_token）。
// token 来源：进程启动时 secrets.token_urlsafe(32) 生成，注入到 SPA HTML 的
//   <script>window.__HERMES_SESSION_TOKEN__="..."</script>
// 没有公开获取 API，只能 GET / 抓 HTML 提取。
//
// 缓存策略：
//   - 全局静态 Mutex<Option<String>> 保存
//   - 401 时 invalidate 重抓一次（dashboard 进程重启会重生成 token）
// ---------------------------------------------------------------------------

use std::sync::Mutex;
static DASHBOARD_SESSION_TOKEN: Mutex<Option<String>> = Mutex::new(None);

async fn fetch_dashboard_session_token(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("拉 dashboard 首页失败: {}", reqwest_error_detail(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("dashboard 首页 HTTP {}", resp.status().as_u16()));
    }
    let html = resp.text().await.unwrap_or_default();
    // 正则匹配 window.__HERMES_SESSION_TOKEN__="..."
    // 用简单的字符串搜索避免引入 regex crate（已有 regex 依赖但保持简单）
    let needle = "window.__HERMES_SESSION_TOKEN__=\"";
    if let Some(start) = html.find(needle) {
        let after = &html[start + needle.len()..];
        if let Some(end) = after.find('"') {
            let token = &after[..end];
            if !token.is_empty() {
                return Ok(token.to_string());
            }
        }
    }
    Err("无法从 dashboard HTML 提取 session token（dashboard 可能未启动）".to_string())
}

async fn dashboard_session_token(port: u16, force_refresh: bool) -> Result<String, String> {
    if !force_refresh {
        if let Ok(guard) = DASHBOARD_SESSION_TOKEN.lock() {
            if let Some(t) = guard.as_ref() {
                return Ok(t.clone());
            }
        }
    }
    let token = fetch_dashboard_session_token(port).await?;
    if let Ok(mut guard) = DASHBOARD_SESSION_TOKEN.lock() {
        *guard = Some(token.clone());
    }
    Ok(token)
}

#[tauri::command]
pub async fn hermes_dashboard_api_proxy(
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<Value>,
) -> Result<Value, String> {
    let port = hermes_dashboard_port();
    let url = format!("http://127.0.0.1:{port}{path}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let build_request = |token_opt: Option<&str>| -> Result<reqwest::RequestBuilder, String> {
        let mut req = match method.to_uppercase().as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            _ => return Err(format!("不支持的方法: {method}")),
        };
        // 自动注入 session token
        if let Some(tok) = token_opt {
            req = req.header("X-Hermes-Session-Token", tok);
        }
        // 自定义 headers
        if let Some(Value::Object(map)) = headers.as_ref() {
            for (k, v) in map.iter() {
                if let Some(s) = v.as_str() {
                    req = req.header(k, s);
                }
            }
        }
        // body
        if let Some(b) = body.as_ref() {
            req = req
                .header("Content-Type", "application/json")
                .body(b.clone());
        }
        Ok(req)
    };

    // 拿缓存的 token（首次为空，让 send 触发 401 再抓）
    let mut token = dashboard_session_token(port, false).await.ok();
    let resp = build_request(token.as_deref())?.send().await.map_err(|e| {
        format!(
            "Dashboard 请求失败: {}（提示：请先启动 Dashboard）",
            reqwest_error_detail(&e)
        )
    })?;

    let status = resp.status();
    if status.as_u16() == 401 {
        // token 失效或没拿到 — 强制刷新 + 重试一次
        token = Some(dashboard_session_token(port, true).await?);
        let retry = build_request(token.as_deref())?
            .send()
            .await
            .map_err(|e| format!("Dashboard 重试失败: {}", reqwest_error_detail(&e)))?;
        let retry_status = retry.status();
        let body = retry.text().await.unwrap_or_default();
        if !retry_status.is_success() {
            return Err(format!("HTTP {}: {}", retry_status.as_u16(), body));
        }
        return Ok(serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body)));
    }

    let resp_body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), resp_body));
    }
    Ok(serde_json::from_str::<Value>(&resp_body).unwrap_or(Value::String(resp_body)))
}

/// Batch 3 §K: 多模态附件结构
///
/// 前端传过来的附件描述（图片用 base64 直传）。
/// 支持 kind="image"（暂时只接图片，文件附件留作后续）。
#[derive(serde::Deserialize, Clone)]
pub struct HermesAttachment {
    pub kind: String,
    pub mime: String,
    /// 原始文件名（前端可选传入，用于日志/调试展示）— 当前未读取，保留供后续展开附件清单 UI 使用
    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
    /// base64 编码的内容（不含 data:image/...,base64, 前缀，仅纯 base64）
    pub data_base64: String,
}

/// 构造 OpenAI 多模态 content：[{type:"text"}, {type:"image_url"}, ...]
fn build_multimodal_input(text: &str, attachments: &[HermesAttachment]) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    parts.push(serde_json::json!({ "type": "text", "text": text }));
    for a in attachments {
        if a.kind == "image" {
            let url = format!("data:{};base64,{}", a.mime, a.data_base64);
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url },
            }));
        }
    }
    Value::Array(parts)
}

#[tauri::command]
pub async fn hermes_agent_run(
    app: tauri::AppHandle,
    input: String,
    session_id: Option<String>,
    conversation_history: Option<Value>,
    instructions: Option<String>,
    attachments: Option<Vec<HermesAttachment>>,
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

    // Batch 3 §K: 有 attachments 时 input 改成多模态格式
    let mut payload = if let Some(atts) = attachments.as_ref().filter(|v| !v.is_empty()) {
        serde_json::json!({ "input": build_multimodal_input(&input, atts) })
    } else {
        serde_json::json!({ "input": input })
    };
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

fn validate_hermes_config_raw_yaml(yaml_text: &str) -> Result<(), String> {
    if yaml_text.trim().is_empty() {
        return Ok(());
    }
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(yaml_text).map_err(|e| format!("config.yaml YAML 格式错误: {e}"))?;
    if parsed.as_mapping().is_none() {
        return Err("config.yaml 顶层必须是对象".into());
    }
    Ok(())
}

#[tauri::command]
pub fn hermes_config_raw_write(yaml_text: String) -> Result<Value, String> {
    validate_hermes_config_raw_yaml(&yaml_text)?;
    let path = hermes_home().join("config.yaml");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let mut backup_path: Option<String> = None;
    if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_extension(format!("yaml.bak-{ts}"));
        if std::fs::copy(&path, &backup).is_ok() {
            backup_path = Some(backup.to_string_lossy().to_string());
        }
    }
    std::fs::write(&path, yaml_text).map_err(|e| format!("Failed to write config.yaml: {e}"))?;
    Ok(serde_json::json!({ "ok": true, "backup": backup_path.unwrap_or_default() }))
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
// Batch 2 §G: 多 Gateway 看板
//
// 让用户同时运行多个 Hermes Gateway 实例（每个绑不同 profile）。
// 用 `hermes --profile <name> gateway run` 启动，PID 跟踪在内存里。
//
// 持久化：~/.openclaw/clawpanel.json 的 hermes.multiGateways 数组
//   [{ name: "main", profile: "default" }, { name: "coder", profile: "coder" }]
//
// 端口：从 profile 的 config.yaml 读 model.gateway.port（每个 profile 独立配置）。
//
// 状态：TCP 探测每个端口 + 检查 PID 是否仍活着。
// ============================================================================

use std::collections::HashMap;
static MULTI_GW_PIDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn multi_gw_pids_get(name: &str) -> Option<u32> {
    MULTI_GW_PIDS
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref()?.get(name).copied())
}

fn multi_gw_pids_set(name: &str, pid: u32) {
    if let Ok(mut guard) = MULTI_GW_PIDS.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(name.to_string(), pid);
    }
}

fn multi_gw_pids_remove(name: &str) {
    if let Ok(mut guard) = MULTI_GW_PIDS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(name);
        }
    }
}

/// 读取 panel config 的 multiGateways 列表
fn read_multi_gateways_config() -> Vec<Value> {
    super::read_panel_config_value()
        .and_then(|v| v.get("hermes")?.get("multiGateways").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// 写入 panel config 的 multiGateways 列表（保留其他字段）
fn write_multi_gateways_config(gateways: Vec<Value>) -> Result<(), String> {
    let config_path = super::panel_config_path();
    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut root: serde_json::Map<String, Value> = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取 panel 配置失败: {e}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    // root.hermes.multiGateways = gateways
    let mut hermes_obj = root
        .get("hermes")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    hermes_obj.insert("multiGateways".into(), Value::Array(gateways));
    root.insert("hermes".into(), Value::Object(hermes_obj));
    let json = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&config_path, json).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

/// 读 profile config.yaml 的 model.gateway.port（缩进感知）
fn read_profile_gateway_port(profile: &str) -> u16 {
    let home = if profile == "default" {
        hermes_home()
    } else {
        hermes_home().join("profiles").join(profile)
    };
    let config_path = home.join("config.yaml");
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return 8642;
    };
    // 简单缩进感知解析：model: → gateway: → port:
    let mut in_model = false;
    let mut in_gateway = false;
    for line in content.lines() {
        let raw_indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if raw_indent == 0 {
            in_model = trimmed.starts_with("model:");
            in_gateway = false;
        } else if in_model && raw_indent == 2 {
            in_gateway = trimmed.starts_with("gateway:");
        } else if in_model && in_gateway && raw_indent == 4 {
            if let Some(p) = trimmed.strip_prefix("port:") {
                if let Ok(n) = p.trim().parse::<u16>() {
                    return n;
                }
            }
        }
    }
    8642
}

/// 检测 PID 是否仍然存活
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                s.lines().any(|l| l.contains(&pid.to_string()))
            }
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // kill -0 signal 0 不杀进程，只检查存在性
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

#[tauri::command]
pub async fn hermes_multi_gateway_list() -> Result<Value, String> {
    let configs = read_multi_gateways_config();
    let mut result = Vec::new();
    for cfg in configs {
        let name = cfg
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let profile = cfg
            .get("profile")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let port = read_profile_gateway_port(&profile);
        // PID-based liveness
        let pid_opt = multi_gw_pids_get(&name);
        let pid_alive = pid_opt.map(pid_is_alive).unwrap_or(false);
        // TCP probe（即使 PID 死了，也可能其他进程占着端口）
        let addr = format!("127.0.0.1:{port}");
        let tcp_running = addr
            .parse::<std::net::SocketAddr>()
            .ok()
            .and_then(|sa| {
                std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(300))
                    .ok()
            })
            .is_some();
        result.push(serde_json::json!({
            "name": name,
            "profile": profile,
            "port": port,
            "running": pid_alive || tcp_running,
            "pid": pid_opt.unwrap_or(0),
            "owned": pid_alive,  // 是否是 ClawPanel spawn 的
        }));
    }
    Ok(Value::Array(result))
}

#[tauri::command]
pub async fn hermes_multi_gateway_add(name: String, profile: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    let profile = profile.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if profile.is_empty() {
        return Err("Profile 不能为空".into());
    }
    // 名称合法性检查（同 hermes profile 规则）
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("名称只能含字母/数字/下划线/连字符".into());
    }
    let mut configs = read_multi_gateways_config();
    if configs
        .iter()
        .any(|c| c.get("name").and_then(|v| v.as_str()) == Some(&name))
    {
        return Err(format!("名称 \"{name}\" 已存在"));
    }
    configs.push(serde_json::json!({ "name": name, "profile": profile }));
    write_multi_gateways_config(configs)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn hermes_multi_gateway_remove(name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    // 先停掉（如果在跑）
    let _ = hermes_multi_gateway_stop(name.clone()).await;
    let configs: Vec<Value> = read_multi_gateways_config()
        .into_iter()
        .filter(|c| c.get("name").and_then(|v| v.as_str()) != Some(&name))
        .collect();
    write_multi_gateways_config(configs)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn hermes_multi_gateway_start(
    app: tauri::AppHandle,
    name: String,
) -> Result<Value, String> {
    let name = name.trim().to_string();
    let configs = read_multi_gateways_config();
    let cfg = configs
        .iter()
        .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(&name))
        .ok_or_else(|| format!("Gateway \"{name}\" 未配置"))?;
    let profile = cfg
        .get("profile")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let port = read_profile_gateway_port(&profile);

    // 已运行？
    if let Some(pid) = multi_gw_pids_get(&name) {
        if pid_is_alive(pid) {
            return Ok(serde_json::json!({
                "started": true, "already_running": true, "pid": pid, "port": port
            }));
        }
    }
    let addr = format!("127.0.0.1:{port}");
    if let Ok(sa) = addr.parse::<std::net::SocketAddr>() {
        if std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(300)).is_ok()
        {
            return Err(format!(
                "端口 {port} 已被占用（非 ClawPanel spawn 的进程，无法接管。请用 services 页停掉默认 Gateway 后重试）"
            ));
        }
    }

    let enhanced = hermes_enhanced_path();
    let home = hermes_home();
    let log_path = home.join(format!("gateway-{name}-run.log"));
    let log_file =
        std::fs::File::create(&log_path).map_err(|e| format!("创建日志文件失败: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("克隆日志句柄失败: {e}"))?;

    let mut cmd = std::process::Command::new("hermes");
    cmd.args(["--profile", &profile, "gateway", "run"])
        .current_dir(&home)
        .env("PATH", &enhanced)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 注入 profile 的 .env
    let profile_env = if profile == "default" {
        home.join(".env")
    } else {
        home.join("profiles").join(&profile).join(".env")
    };
    if let Ok(env_content) = std::fs::read_to_string(&profile_env) {
        for line in env_content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                cmd.env(k.trim(), v.trim());
            }
        }
    }

    let child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let pid = child.id();
    std::mem::forget(child); // 不等待进程，由 PID 跟踪
    multi_gw_pids_set(&name, pid);

    let _ = app.emit(
        "hermes-multi-gateway-changed",
        serde_json::json!({ "name": &name, "action": "started" }),
    );

    // 等端口起来（最多 8 秒）
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(sa) = addr.parse::<std::net::SocketAddr>() {
            if std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(200))
                .is_ok()
            {
                return Ok(serde_json::json!({
                    "started": true, "pid": pid, "port": port
                }));
            }
        }
    }
    Ok(serde_json::json!({
        "started": true, "pid": pid, "port": port, "warning": "端口未在 8 秒内可达，可能仍在初始化"
    }))
}

#[tauri::command]
pub async fn hermes_multi_gateway_stop(name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    let pid = multi_gw_pids_get(&name);
    if pid.is_none() || !pid_is_alive(pid.unwrap()) {
        multi_gw_pids_remove(&name);
        return Ok(serde_json::json!({ "stopped": true, "was_running": false }));
    }
    let pid = pid.unwrap();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if pid_is_alive(pid) {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }
    multi_gw_pids_remove(&name);
    Ok(serde_json::json!({ "stopped": true, "was_running": true, "pid": pid }))
}

// ============================================================================
// Batch 3 §L: 文件管理器（基础 fs 命令）
//
// 限制：所有路径必须在 hermes_home() (~/.hermes) 子树内（防 path traversal）。
// 提供：list / read / write 三个基础命令，前端组合成文件管理器 UI。
// ============================================================================

const FS_MAX_READ_BYTES: u64 = 5 * 1024 * 1024; // 5 MB
const FS_MAX_LIST_ENTRIES: usize = 2000; // 单次最多返回 2000 条

/// 验证路径在 hermes_home 子树内（防 path traversal）。
/// 返回安全的绝对路径，或 Err。
fn validate_hermes_fs_path(rel_path: &str) -> Result<PathBuf, String> {
    let root = hermes_home();
    // 空 = 根目录
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        // 拒绝绝对路径输入（必须相对于 hermes_home）
        let p = std::path::Path::new(rel_path);
        if p.is_absolute() {
            // 允许绝对路径，但必须以 root 开头（用 starts_with 检查）
            let canonical_root = root.canonicalize().unwrap_or(root.clone());
            let canonical_target = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            if !canonical_target.starts_with(&canonical_root) {
                return Err(format!("路径必须在 {} 子树内", root.to_string_lossy()));
            }
            canonical_target
        } else {
            // 相对路径：拼到 root 下，再 canonicalize 防 ..
            let joined = root.join(p);
            // 父目录必须存在才能 canonicalize；对不存在的新文件 fallback 到 joined
            let canon = joined.canonicalize().unwrap_or(joined.clone());
            let canonical_root = root.canonicalize().unwrap_or(root.clone());
            if !canon.starts_with(&canonical_root) {
                return Err(format!("路径不能跳出 {} 目录", root.to_string_lossy()));
            }
            canon
        }
    };
    Ok(target)
}

#[tauri::command]
pub async fn hermes_fs_list(path: String) -> Result<Value, String> {
    let target = validate_hermes_fs_path(&path)?;
    if !target.exists() {
        return Err(format!("目录不存在: {}", target.to_string_lossy()));
    }
    if !target.is_dir() {
        return Err(format!("不是目录: {}", target.to_string_lossy()));
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&target).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in read_dir.flatten().take(FS_MAX_LIST_ENTRIES) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" && name != ".hermes" {
            continue; // 隐藏文件默认不显示（.env 除外因为 Hermes 用它）
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let meta = entry.metadata().ok();
        let size = meta
            .as_ref()
            .and_then(|m| if m.is_file() { Some(m.len()) } else { None });
        let modified = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        });
        entries.push(serde_json::json!({
            "name": name,
            "kind": if ft.is_dir() { "dir" } else if ft.is_symlink() { "symlink" } else { "file" },
            "size": size,
            "modified": modified,
        }));
    }
    // 目录在前，文件在后，每组按名字排序
    entries.sort_by(|a, b| {
        let ak = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let bk = b.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if ak != bk {
            return if ak == "dir" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.to_lowercase().cmp(&bn.to_lowercase())
    });
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "entries": entries,
    }))
}

#[tauri::command]
pub async fn hermes_fs_read(path: String) -> Result<Value, String> {
    let target = validate_hermes_fs_path(&path)?;
    if !target.exists() {
        return Err(format!("文件不存在: {}", target.to_string_lossy()));
    }
    if !target.is_file() {
        return Err(format!("不是文件: {}", target.to_string_lossy()));
    }
    let meta = target
        .metadata()
        .map_err(|e| format!("读元数据失败: {e}"))?;
    if meta.len() > FS_MAX_READ_BYTES {
        return Err(format!(
            "文件过大（{} bytes），最大 {} bytes",
            meta.len(),
            FS_MAX_READ_BYTES
        ));
    }
    let content = std::fs::read(&target).map_err(|e| format!("读取失败: {e}"))?;
    // 尝试当作 UTF-8 文本；失败 → 二进制（用 base64）
    let (text_content, binary_b64) = match std::str::from_utf8(&content) {
        Ok(s) => (Some(s.to_string()), None),
        Err(_) => {
            // 简单的非文本判定（包含 null byte 即认为是二进制）
            (None, Some(base64_encode(&content)))
        }
    };
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "size": meta.len(),
        "text": text_content,
        "binary_b64": binary_b64,
    }))
}

/// 简单的 base64 编码（不引新依赖）
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n =
            (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8) | u32::from(bytes[i + 2]);
        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        out.push(CHARS[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = u32::from(bytes[i]) << 16;
        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8);
        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

#[tauri::command]
pub async fn hermes_fs_write(path: String, content: String) -> Result<Value, String> {
    let target = validate_hermes_fs_path(&path)?;
    // 父目录必须存在
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            return Err(format!("父目录不存在: {}", parent.to_string_lossy()));
        }
    }
    // 写入大小限制（防止巨型文件意外写入）
    if content.len() as u64 > FS_MAX_READ_BYTES {
        return Err(format!(
            "内容过大（{} bytes），最大 {} bytes",
            content.len(),
            FS_MAX_READ_BYTES
        ));
    }
    std::fs::write(&target, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    let meta = target.metadata().ok();
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "size": meta.map(|m| m.len()).unwrap_or(0),
    }))
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

#[cfg(test)]
mod hermes_config_raw_tests {
    use super::validate_hermes_config_raw_yaml;

    #[test]
    fn rejects_invalid_raw_config_yaml_before_write() {
        let err =
            validate_hermes_config_raw_yaml("model:\n  default: gpt-4o\n    provider: openai\n")
                .unwrap_err();
        assert!(err.contains("config.yaml YAML 格式错误"));
    }

    #[test]
    fn rejects_non_object_raw_config_yaml_before_write() {
        let err = validate_hermes_config_raw_yaml("- model\n- display\n").unwrap_err();
        assert!(err.contains("config.yaml 顶层必须是对象"));
    }

    #[test]
    fn accepts_empty_and_mapping_raw_config_yaml() {
        validate_hermes_config_raw_yaml("").unwrap();
        validate_hermes_config_raw_yaml("model:\n  default: gpt-4o\n").unwrap();
    }
}

#[cfg(test)]
mod hermes_session_runtime_config_tests {
    use super::{build_hermes_session_runtime_config_values, merge_hermes_session_runtime_config};
    use serde_json::json;

    #[test]
    fn session_runtime_values_have_safe_defaults() {
        let config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let values = build_hermes_session_runtime_config_values(&config);

        assert_eq!(values["sessionResetMode"], "both");
        assert_eq!(values["idleMinutes"], 1440);
        assert_eq!(values["atHour"], 4);
        assert_eq!(values["groupSessionsPerUser"], true);
        assert_eq!(values["threadSessionsPerUser"], false);
    }

    #[test]
    fn merge_session_runtime_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
  default: claude-sonnet-4-6
session_reset:
  mode: idle
  idle_minutes: 60
  custom_flag: keep-me
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_session_runtime_config(
            &mut config,
            &json!({
                "sessionResetMode": "both",
                "idleMinutes": "90",
                "atHour": "6",
                "groupSessionsPerUser": false,
                "threadSessionsPerUser": true,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["session_reset"]["mode"].as_str(), Some("both"));
        assert_eq!(config["session_reset"]["idle_minutes"].as_i64(), Some(90));
        assert_eq!(config["session_reset"]["at_hour"].as_i64(), Some(6));
        assert_eq!(
            config["session_reset"]["custom_flag"].as_str(),
            Some("keep-me")
        );
        assert_eq!(config["group_sessions_per_user"].as_bool(), Some(false));
        assert_eq!(config["thread_sessions_per_user"].as_bool(), Some(true));
    }

    #[test]
    fn merge_session_runtime_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_session_runtime_config(
            &mut config,
            &json!({ "sessionResetMode": "weekly" }),
        )
        .unwrap_err();
        assert!(err.contains("session_reset.mode"));

        let err = merge_hermes_session_runtime_config(&mut config, &json!({ "idleMinutes": 0 }))
            .unwrap_err();
        assert!(err.contains("idle_minutes"));

        let err =
            merge_hermes_session_runtime_config(&mut config, &json!({ "atHour": 24 })).unwrap_err();
        assert!(err.contains("at_hour"));
    }
}

#[cfg(test)]
mod hermes_compression_config_tests {
    use super::{build_hermes_compression_config_values, merge_hermes_compression_config};
    use serde_json::json;

    #[test]
    fn compression_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_compression_config_values(&config);
        assert_eq!(values["enabled"], true);
        assert_eq!(values["threshold"], 0.5);
        assert_eq!(values["targetRatio"], 0.2);
        assert_eq!(values["protectLastN"], 20);
        assert_eq!(values["protectFirstN"], 3);
        assert_eq!(values["abortOnSummaryFailure"], false);
    }

    #[test]
    fn merge_compression_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
compression:
  enabled: true
  threshold: 0.5
  custom_flag: keep-me
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_compression_config(
            &mut config,
            &json!({
                "enabled": false,
                "threshold": "0.7",
                "targetRatio": "0.4",
                "protectLastN": "28",
                "protectFirstN": "0",
                "abortOnSummaryFailure": true,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["compression"]["enabled"].as_bool(), Some(false));
        assert_eq!(config["compression"]["threshold"].as_f64(), Some(0.7));
        assert_eq!(config["compression"]["target_ratio"].as_f64(), Some(0.4));
        assert_eq!(config["compression"]["protect_last_n"].as_i64(), Some(28));
        assert_eq!(config["compression"]["protect_first_n"].as_i64(), Some(0));
        assert_eq!(
            config["compression"]["abort_on_summary_failure"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["compression"]["custom_flag"].as_str(),
            Some("keep-me")
        );
    }

    #[test]
    fn merge_compression_config_rejects_invalid_values() {
        let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let err =
            merge_hermes_compression_config(&mut config, &json!({ "threshold": 0 })).unwrap_err();
        assert!(err.contains("compression.threshold"));
        let err = merge_hermes_compression_config(&mut config, &json!({ "targetRatio": 0.05 }))
            .unwrap_err();
        assert!(err.contains("compression.target_ratio"));
        let err = merge_hermes_compression_config(&mut config, &json!({ "protectLastN": 0 }))
            .unwrap_err();
        assert!(err.contains("compression.protect_last_n"));
        let err = merge_hermes_compression_config(&mut config, &json!({ "protectFirstN": -1 }))
            .unwrap_err();
        assert!(err.contains("compression.protect_first_n"));
    }
}

#[cfg(test)]
mod hermes_tool_loop_guardrails_config_tests {
    use super::{
        build_hermes_tool_loop_guardrails_config_values, merge_hermes_tool_loop_guardrails_config,
    };
    use serde_json::json;

    #[test]
    fn tool_loop_guardrails_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_tool_loop_guardrails_config_values(&config);
        assert_eq!(values["warningsEnabled"], true);
        assert_eq!(values["hardStopEnabled"], false);
        assert_eq!(values["warnExactFailure"], 2);
        assert_eq!(values["warnSameToolFailure"], 3);
        assert_eq!(values["warnNoProgress"], 2);
        assert_eq!(values["hardStopExactFailure"], 5);
        assert_eq!(values["hardStopSameToolFailure"], 8);
        assert_eq!(values["hardStopNoProgress"], 5);
    }

    #[test]
    fn merge_tool_loop_guardrails_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
tool_loop_guardrails:
  warnings_enabled: true
  custom_flag: keep-me
  warn_after:
    exact_failure: 2
    custom_warn: 99
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_tool_loop_guardrails_config(
            &mut config,
            &json!({
                "warningsEnabled": false,
                "hardStopEnabled": true,
                "warnExactFailure": "3",
                "warnSameToolFailure": "4",
                "warnNoProgress": "5",
                "hardStopExactFailure": "6",
                "hardStopSameToolFailure": "7",
                "hardStopNoProgress": "8",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(
            config["tool_loop_guardrails"]["warnings_enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["hard_stop_enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["custom_flag"].as_str(),
            Some("keep-me")
        );
        assert_eq!(
            config["tool_loop_guardrails"]["warn_after"]["exact_failure"].as_i64(),
            Some(3)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["warn_after"]["same_tool_failure"].as_i64(),
            Some(4)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["warn_after"]["idempotent_no_progress"].as_i64(),
            Some(5)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["warn_after"]["custom_warn"].as_i64(),
            Some(99)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["hard_stop_after"]["exact_failure"].as_i64(),
            Some(6)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["hard_stop_after"]["same_tool_failure"].as_i64(),
            Some(7)
        );
        assert_eq!(
            config["tool_loop_guardrails"]["hard_stop_after"]["idempotent_no_progress"].as_i64(),
            Some(8)
        );
    }

    #[test]
    fn merge_tool_loop_guardrails_config_rejects_invalid_values() {
        let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let err = merge_hermes_tool_loop_guardrails_config(
            &mut config,
            &json!({ "warnExactFailure": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("tool_loop_guardrails.warn_after.exact_failure"));
        let err = merge_hermes_tool_loop_guardrails_config(
            &mut config,
            &json!({ "warnSameToolFailure": 101 }),
        )
        .unwrap_err();
        assert!(err.contains("tool_loop_guardrails.warn_after.same_tool_failure"));
        let err = merge_hermes_tool_loop_guardrails_config(
            &mut config,
            &json!({ "hardStopExactFailure": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("tool_loop_guardrails.hard_stop_after.exact_failure"));
        let err = merge_hermes_tool_loop_guardrails_config(
            &mut config,
            &json!({ "hardStopNoProgress": 101 }),
        )
        .unwrap_err();
        assert!(err.contains("tool_loop_guardrails.hard_stop_after.idempotent_no_progress"));
    }
}

#[cfg(test)]
mod hermes_streaming_config_tests {
    use super::{build_hermes_streaming_config_values, merge_hermes_streaming_config};
    use serde_json::json;

    #[test]
    fn streaming_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_streaming_config_values(&config);
        assert_eq!(values["enabled"], false);
        assert_eq!(values["transport"], "edit");
        assert_eq!(values["editInterval"], 0.8);
        assert_eq!(values["bufferThreshold"], 24);
        assert_eq!(values["cursor"], " ▉");
        assert_eq!(values["freshFinalAfterSeconds"], 60.0);
    }

    #[test]
    fn streaming_values_prefer_top_level_and_fallback_to_gateway() {
        let fallback: serde_yaml::Value = serde_yaml::from_str(
            r#"
gateway:
  streaming:
    enabled: true
    transport: draft
    edit_interval: 0.25
    buffer_threshold: 11
    cursor: "..."
    fresh_final_after_seconds: 0
"#,
        )
        .unwrap();
        let values = build_hermes_streaming_config_values(&fallback);
        assert_eq!(values["enabled"], true);
        assert_eq!(values["transport"], "draft");
        assert_eq!(values["editInterval"], 0.25);
        assert_eq!(values["bufferThreshold"], 11);
        assert_eq!(values["cursor"], "...");
        assert_eq!(values["freshFinalAfterSeconds"], 0.0);

        let top_level: serde_yaml::Value = serde_yaml::from_str(
            r#"
streaming:
  enabled: false
  transport: auto
  edit_interval: 0.5
  buffer_threshold: 40
  cursor: ">"
  fresh_final_after_seconds: 120
gateway:
  streaming:
    enabled: true
    transport: draft
"#,
        )
        .unwrap();
        let values = build_hermes_streaming_config_values(&top_level);
        assert_eq!(values["enabled"], false);
        assert_eq!(values["transport"], "auto");
        assert_eq!(values["editInterval"], 0.5);
        assert_eq!(values["bufferThreshold"], 40);
        assert_eq!(values["cursor"], ">");
        assert_eq!(values["freshFinalAfterSeconds"], 120.0);
    }

    #[test]
    fn merge_streaming_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
streaming:
  enabled: false
  custom_flag: keep-me
gateway:
  streaming:
    enabled: false
    legacy_flag: keep-nested
display:
  streaming: true
"#,
        )
        .unwrap();

        merge_hermes_streaming_config(
            &mut config,
            &json!({
                "enabled": true,
                "transport": "draft",
                "editInterval": "0.35",
                "bufferThreshold": "48",
                "cursor": "",
                "freshFinalAfterSeconds": "0",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["display"]["streaming"].as_bool(), Some(true));
        assert_eq!(
            config["gateway"]["streaming"]["legacy_flag"].as_str(),
            Some("keep-nested")
        );
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["streaming"]["transport"].as_str(), Some("draft"));
        assert_eq!(config["streaming"]["edit_interval"].as_f64(), Some(0.35));
        assert_eq!(config["streaming"]["buffer_threshold"].as_i64(), Some(48));
        assert_eq!(config["streaming"]["cursor"].as_str(), Some(""));
        assert_eq!(
            config["streaming"]["fresh_final_after_seconds"].as_f64(),
            Some(0.0)
        );
        assert_eq!(config["streaming"]["custom_flag"].as_str(), Some("keep-me"));
    }

    #[test]
    fn merge_streaming_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_streaming_config(&mut config, &json!({ "transport": "invalid" }))
            .unwrap_err();
        assert!(err.contains("streaming.transport"));
        let err = merge_hermes_streaming_config(&mut config, &json!({ "editInterval": 0.01 }))
            .unwrap_err();
        assert!(err.contains("streaming.edit_interval"));
        let err = merge_hermes_streaming_config(&mut config, &json!({ "bufferThreshold": 0 }))
            .unwrap_err();
        assert!(err.contains("streaming.buffer_threshold"));
        let err =
            merge_hermes_streaming_config(&mut config, &json!({ "freshFinalAfterSeconds": -1 }))
                .unwrap_err();
        assert!(err.contains("streaming.fresh_final_after_seconds"));
    }
}

#[cfg(test)]
mod hermes_execution_limits_config_tests {
    use super::{
        build_hermes_execution_limits_config_values, merge_hermes_execution_limits_config,
    };
    use serde_json::json;

    #[test]
    fn execution_limits_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_execution_limits_config_values(&config);
        assert_eq!(values["codeExecutionMode"], "project");
        assert_eq!(values["codeExecutionTimeout"], 300);
        assert_eq!(values["codeExecutionMaxToolCalls"], 50);
        assert_eq!(values["delegationMaxIterations"], 50);
        assert_eq!(values["delegationChildTimeoutSeconds"], 600);
        assert_eq!(values["delegationMaxConcurrentChildren"], 3);
        assert_eq!(values["delegationMaxSpawnDepth"], 1);
        assert_eq!(values["delegationOrchestratorEnabled"], true);
        assert_eq!(values["delegationSubagentAutoApprove"], false);
        assert_eq!(values["delegationInheritMcpToolsets"], true);
    }

    #[test]
    fn execution_limits_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
code_execution:
  mode: strict
  timeout: 120
  max_tool_calls: 12
delegation:
  max_iterations: 30
  child_timeout_seconds: 900
  max_concurrent_children: 5
  max_spawn_depth: 2
  orchestrator_enabled: false
  subagent_auto_approve: true
  inherit_mcp_toolsets: false
"#,
        )
        .unwrap();
        let values = build_hermes_execution_limits_config_values(&config);
        assert_eq!(values["codeExecutionMode"], "strict");
        assert_eq!(values["codeExecutionTimeout"], 120);
        assert_eq!(values["codeExecutionMaxToolCalls"], 12);
        assert_eq!(values["delegationMaxIterations"], 30);
        assert_eq!(values["delegationChildTimeoutSeconds"], 900);
        assert_eq!(values["delegationMaxConcurrentChildren"], 5);
        assert_eq!(values["delegationMaxSpawnDepth"], 2);
        assert_eq!(values["delegationOrchestratorEnabled"], false);
        assert_eq!(values["delegationSubagentAutoApprove"], true);
        assert_eq!(values["delegationInheritMcpToolsets"], false);
    }

    #[test]
    fn merge_execution_limits_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
code_execution:
  mode: project
  custom_flag: keep-code
delegation:
  model: child-model
  provider: openrouter
  custom_flag: keep-delegation
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_execution_limits_config(
            &mut config,
            &json!({
                "codeExecutionMode": "strict",
                "codeExecutionTimeout": "180",
                "codeExecutionMaxToolCalls": "25",
                "delegationMaxIterations": "40",
                "delegationChildTimeoutSeconds": "1200",
                "delegationMaxConcurrentChildren": "4",
                "delegationMaxSpawnDepth": "2",
                "delegationOrchestratorEnabled": false,
                "delegationSubagentAutoApprove": true,
                "delegationInheritMcpToolsets": false,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["code_execution"]["mode"].as_str(), Some("strict"));
        assert_eq!(config["code_execution"]["timeout"].as_i64(), Some(180));
        assert_eq!(
            config["code_execution"]["max_tool_calls"].as_i64(),
            Some(25)
        );
        assert_eq!(
            config["code_execution"]["custom_flag"].as_str(),
            Some("keep-code")
        );
        assert_eq!(config["delegation"]["max_iterations"].as_i64(), Some(40));
        assert_eq!(
            config["delegation"]["child_timeout_seconds"].as_i64(),
            Some(1200)
        );
        assert_eq!(
            config["delegation"]["max_concurrent_children"].as_i64(),
            Some(4)
        );
        assert_eq!(config["delegation"]["max_spawn_depth"].as_i64(), Some(2));
        assert_eq!(
            config["delegation"]["orchestrator_enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["delegation"]["subagent_auto_approve"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["delegation"]["inherit_mcp_toolsets"].as_bool(),
            Some(false)
        );
        assert_eq!(config["delegation"]["model"].as_str(), Some("child-model"));
        assert_eq!(
            config["delegation"]["provider"].as_str(),
            Some("openrouter")
        );
        assert_eq!(
            config["delegation"]["custom_flag"].as_str(),
            Some("keep-delegation")
        );
    }

    #[test]
    fn merge_execution_limits_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_execution_limits_config(
            &mut config,
            &json!({ "codeExecutionMode": "unsafe" }),
        )
        .unwrap_err();
        assert!(err.contains("code_execution.mode"));
        let err = merge_hermes_execution_limits_config(
            &mut config,
            &json!({ "codeExecutionTimeout": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("code_execution.timeout"));
        let err = merge_hermes_execution_limits_config(
            &mut config,
            &json!({ "delegationMaxConcurrentChildren": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("delegation.max_concurrent_children"));
        let err = merge_hermes_execution_limits_config(
            &mut config,
            &json!({ "delegationMaxSpawnDepth": 4 }),
        )
        .unwrap_err();
        assert!(err.contains("delegation.max_spawn_depth"));
        let err = merge_hermes_execution_limits_config(
            &mut config,
            &json!({ "delegationChildTimeoutSeconds": 29 }),
        )
        .unwrap_err();
        assert!(err.contains("delegation.child_timeout_seconds"));
    }
}

#[cfg(test)]
mod hermes_terminal_config_tests {
    use super::{build_hermes_terminal_config_values, merge_hermes_terminal_config};
    use serde_json::json;

    #[test]
    fn terminal_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_terminal_config_values(&config);
        assert_eq!(values["terminalBackend"], "local");
        assert_eq!(values["terminalCwd"], ".");
        assert_eq!(values["terminalTimeout"], 180);
        assert_eq!(values["terminalLifetimeSeconds"], 300);
        assert_eq!(values["terminalDockerMountCwdToWorkspace"], false);
        assert_eq!(values["terminalDockerRunAsHostUser"], false);
        assert_eq!(values["terminalContainerCpu"], 1);
        assert_eq!(values["terminalContainerMemory"], 5120);
        assert_eq!(values["terminalContainerDisk"], 51200);
        assert_eq!(values["terminalContainerPersistent"], true);
    }

    #[test]
    fn terminal_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  backend: docker
  cwd: /workspace
  timeout: 600
  lifetime_seconds: 1800
  docker_mount_cwd_to_workspace: true
  docker_run_as_host_user: true
  container_cpu: 4
  container_memory: 8192
  container_disk: 102400
  container_persistent: false
"#,
        )
        .unwrap();
        let values = build_hermes_terminal_config_values(&config);
        assert_eq!(values["terminalBackend"], "docker");
        assert_eq!(values["terminalCwd"], "/workspace");
        assert_eq!(values["terminalTimeout"], 600);
        assert_eq!(values["terminalLifetimeSeconds"], 1800);
        assert_eq!(values["terminalDockerMountCwdToWorkspace"], true);
        assert_eq!(values["terminalDockerRunAsHostUser"], true);
        assert_eq!(values["terminalContainerCpu"], 4);
        assert_eq!(values["terminalContainerMemory"], 8192);
        assert_eq!(values["terminalContainerDisk"], 102400);
        assert_eq!(values["terminalContainerPersistent"], false);
    }

    #[test]
    fn merge_terminal_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
terminal:
  backend: local
  docker_image: custom/python-node
  docker_forward_env:
    - GITHUB_TOKEN
  custom_flag: keep-terminal
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalBackend": "docker",
                "terminalCwd": "/workspace",
                "terminalTimeout": "900",
                "terminalLifetimeSeconds": "1200",
                "terminalDockerMountCwdToWorkspace": true,
                "terminalDockerRunAsHostUser": true,
                "terminalContainerCpu": "2",
                "terminalContainerMemory": "6144",
                "terminalContainerDisk": "20480",
                "terminalContainerPersistent": false,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["terminal"]["backend"].as_str(), Some("docker"));
        assert_eq!(config["terminal"]["cwd"].as_str(), Some("/workspace"));
        assert_eq!(config["terminal"]["timeout"].as_i64(), Some(900));
        assert_eq!(config["terminal"]["lifetime_seconds"].as_i64(), Some(1200));
        assert_eq!(
            config["terminal"]["docker_mount_cwd_to_workspace"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["terminal"]["docker_run_as_host_user"].as_bool(),
            Some(true)
        );
        assert_eq!(config["terminal"]["container_cpu"].as_i64(), Some(2));
        assert_eq!(config["terminal"]["container_memory"].as_i64(), Some(6144));
        assert_eq!(config["terminal"]["container_disk"].as_i64(), Some(20480));
        assert_eq!(
            config["terminal"]["container_persistent"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["docker_image"].as_str(),
            Some("custom/python-node")
        );
        assert_eq!(
            config["terminal"]["docker_forward_env"][0].as_str(),
            Some("GITHUB_TOKEN")
        );
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalBackend": "unsafe" }))
                .unwrap_err();
        assert!(err.contains("terminal.backend"));
        let err = merge_hermes_terminal_config(&mut config, &json!({ "terminalTimeout": 0 }))
            .unwrap_err();
        assert!(err.contains("terminal.timeout"));
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalLifetimeSeconds": -1 }))
                .unwrap_err();
        assert!(err.contains("terminal.lifetime_seconds"));
        let err = merge_hermes_terminal_config(&mut config, &json!({ "terminalContainerCpu": 0 }))
            .unwrap_err();
        assert!(err.contains("terminal.container_cpu"));
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalContainerMemory": 127 }))
                .unwrap_err();
        assert!(err.contains("terminal.container_memory"));
    }
}

#[cfg(test)]
mod hermes_memory_config_tests {
    use super::{build_hermes_memory_config_values, merge_hermes_memory_config};
    use serde_json::json;

    #[test]
    fn memory_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_memory_config_values(&config);
        assert_eq!(values["memoryEnabled"], true);
        assert_eq!(values["userProfileEnabled"], true);
        assert_eq!(values["memoryCharLimit"], 2200);
        assert_eq!(values["userCharLimit"], 1375);
        assert_eq!(values["nudgeInterval"], 10);
        assert_eq!(values["flushMinTurns"], 6);
    }

    #[test]
    fn merge_memory_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
memory:
  memory_enabled: true
  provider: honcho
  custom_flag: keep-me
  flush_min_turns: 9
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_memory_config(
            &mut config,
            &json!({
                "memoryEnabled": false,
                "userProfileEnabled": false,
                "memoryCharLimit": "2600",
                "userCharLimit": "1500",
                "nudgeInterval": "0",
                "flushMinTurns": "7",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(false));
        assert_eq!(
            config["memory"]["user_profile_enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(config["memory"]["memory_char_limit"].as_i64(), Some(2600));
        assert_eq!(config["memory"]["user_char_limit"].as_i64(), Some(1500));
        assert_eq!(config["memory"]["nudge_interval"].as_i64(), Some(0));
        assert_eq!(config["memory"]["flush_min_turns"].as_i64(), Some(7));
        assert_eq!(config["memory"]["provider"].as_str(), Some("honcho"));
        assert_eq!(config["memory"]["custom_flag"].as_str(), Some("keep-me"));
    }

    #[test]
    fn merge_memory_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_memory_config(&mut config, &json!({ "memoryCharLimit": 99 })).unwrap_err();
        assert!(err.contains("memory.memory_char_limit"));
        let err = merge_hermes_memory_config(&mut config, &json!({ "userCharLimit": 200001 }))
            .unwrap_err();
        assert!(err.contains("memory.user_char_limit"));
        let err =
            merge_hermes_memory_config(&mut config, &json!({ "nudgeInterval": -1 })).unwrap_err();
        assert!(err.contains("memory.nudge_interval"));
        let err =
            merge_hermes_memory_config(&mut config, &json!({ "nudgeInterval": 1001 })).unwrap_err();
        assert!(err.contains("memory.nudge_interval"));
        let err =
            merge_hermes_memory_config(&mut config, &json!({ "flushMinTurns": -1 })).unwrap_err();
        assert!(err.contains("memory.flush_min_turns"));
        let err =
            merge_hermes_memory_config(&mut config, &json!({ "flushMinTurns": 1001 })).unwrap_err();
        assert!(err.contains("memory.flush_min_turns"));
    }
}

#[cfg(test)]
mod hermes_skills_config_tests {
    use super::{build_hermes_skills_config_values, merge_hermes_skills_config};
    use serde_json::json;

    #[test]
    fn skills_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_skills_config_values(&config);
        assert_eq!(values["creationNudgeInterval"], 15);
        assert_eq!(values["externalDirs"], "");
    }

    #[test]
    fn skills_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
skills:
  creation_nudge_interval: 30
  external_dirs:
    - ~/.agents/skills
    - /home/shared/team-skills
"#,
        )
        .unwrap();

        let values = build_hermes_skills_config_values(&config);
        assert_eq!(values["creationNudgeInterval"], 30);
        assert_eq!(
            values["externalDirs"],
            "~/.agents/skills\n/home/shared/team-skills"
        );
    }

    #[test]
    fn merge_skills_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
skills:
  creation_nudge_interval: 15
  disabled:
    - legacy-skill
  custom_flag: keep-skills
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_skills_config(
            &mut config,
            &json!({
                "creationNudgeInterval": "0",
                "externalDirs": " ~/.agents/skills \n\n /home/shared/team-skills ",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["skills"]["creation_nudge_interval"].as_i64(),
            Some(0)
        );
        assert_eq!(
            config["skills"]["external_dirs"][0].as_str(),
            Some("~/.agents/skills")
        );
        assert_eq!(
            config["skills"]["external_dirs"][1].as_str(),
            Some("/home/shared/team-skills")
        );
        assert_eq!(
            config["skills"]["disabled"][0].as_str(),
            Some("legacy-skill")
        );
        assert_eq!(
            config["skills"]["custom_flag"].as_str(),
            Some("keep-skills")
        );
    }

    #[test]
    fn merge_skills_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_skills_config(&mut config, &json!({ "creationNudgeInterval": -1 }))
            .unwrap_err();
        assert!(err.contains("skills.creation_nudge_interval"));
        let err =
            merge_hermes_skills_config(&mut config, &json!({ "creationNudgeInterval": 10001 }))
                .unwrap_err();
        assert!(err.contains("skills.creation_nudge_interval"));
    }
}

#[cfg(test)]
mod hermes_quick_commands_config_tests {
    use super::{build_hermes_quick_commands_config_values, merge_hermes_quick_commands_config};
    use serde_json::json;

    #[test]
    fn quick_commands_values_have_empty_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_quick_commands_config_values(&config);
        assert_eq!(values["quickCommandsJson"], "{}");
    }

    #[test]
    fn quick_commands_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
quick_commands:
  status:
    type: exec
    command: systemctl status hermes-agent
  restart:
    type: alias
    target: /gateway restart
"#,
        )
        .unwrap();

        let values = build_hermes_quick_commands_config_values(&config);
        let parsed: serde_json::Value =
            serde_json::from_str(values["quickCommandsJson"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["status"]["command"], "systemctl status hermes-agent");
        assert_eq!(parsed["restart"]["target"], "/gateway restart");
    }

    #[test]
    fn merge_quick_commands_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
quick_commands:
  old:
    type: exec
    command: uptime
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_quick_commands_config(
            &mut config,
            &json!({
                "quickCommandsJson": r#"{
                  "status": { "type": "exec", "command": "systemctl status hermes-agent", "timeout": 10 },
                  "restart": { "type": "alias", "target": "/gateway restart" }
                }"#,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["quick_commands"]["status"]["command"].as_str(),
            Some("systemctl status hermes-agent")
        );
        assert_eq!(
            config["quick_commands"]["status"]["timeout"].as_i64(),
            Some(10)
        );
        assert_eq!(
            config["quick_commands"]["restart"]["target"].as_str(),
            Some("/gateway restart")
        );
        assert!(config["quick_commands"]["old"].is_null());
    }

    #[test]
    fn merge_quick_commands_config_removes_empty_mapping() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
quick_commands:
  status:
    type: exec
    command: uptime
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_quick_commands_config(&mut config, &json!({ "quickCommandsJson": "{}" }))
            .unwrap();

        assert!(config["quick_commands"].is_null());
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_quick_commands_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_quick_commands_config(&mut config, &json!({ "quickCommandsJson": "[" }))
                .unwrap_err();
        assert!(err.contains("quick_commands"));
        let err =
            merge_hermes_quick_commands_config(&mut config, &json!({ "quickCommandsJson": "[]" }))
                .unwrap_err();
        assert!(err.contains("quick_commands"));
        let err = merge_hermes_quick_commands_config(
            &mut config,
            &json!({ "quickCommandsJson": r#"{ "bad": "uptime" }"# }),
        )
        .unwrap_err();
        assert!(err.contains("quick_commands.bad"));
        let err = merge_hermes_quick_commands_config(
            &mut config,
            &json!({ "quickCommandsJson": r#"{ "status": { "type": "exec", "command": "" } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("quick_commands.status.command"));
        let err = merge_hermes_quick_commands_config(
            &mut config,
            &json!({ "quickCommandsJson": r#"{ "restart": { "type": "alias", "target": "gateway restart" } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("quick_commands.restart.target"));
    }
}

#[cfg(test)]
mod hermes_unauthorized_dm_config_tests {
    use super::{build_hermes_unauthorized_dm_config_values, merge_hermes_unauthorized_dm_config};
    use serde_json::json;

    #[test]
    fn unauthorized_dm_values_have_pair_default() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_unauthorized_dm_config_values(&config);
        assert_eq!(values["unauthorizedDmBehavior"], "pair");
    }

    #[test]
    fn unauthorized_dm_values_normalize_existing_behavior() {
        let config: serde_yaml::Value =
            serde_yaml::from_str("unauthorized_dm_behavior: IGNORE").unwrap();
        let values = build_hermes_unauthorized_dm_config_values(&config);
        assert_eq!(values["unauthorizedDmBehavior"], "ignore");

        let config: serde_yaml::Value =
            serde_yaml::from_str("unauthorized_dm_behavior: silent").unwrap();
        let values = build_hermes_unauthorized_dm_config_values(&config);
        assert_eq!(values["unauthorizedDmBehavior"], "pair");
    }

    #[test]
    fn merge_unauthorized_dm_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
unauthorized_dm_behavior: pair
platforms:
  telegram:
    enabled: true
    custom_flag: keep-platform
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_unauthorized_dm_config(
            &mut config,
            &json!({ "unauthorizedDmBehavior": "ignore" }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["platforms"]["telegram"]["custom_flag"].as_str(),
            Some("keep-platform")
        );
        assert_eq!(config["unauthorized_dm_behavior"].as_str(), Some("ignore"));
    }

    #[test]
    fn merge_unauthorized_dm_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_unauthorized_dm_config(
            &mut config,
            &json!({ "unauthorizedDmBehavior": "silent" }),
        )
        .unwrap_err();
        assert!(err.contains("unauthorized_dm_behavior"));
    }
}

#[cfg(test)]
mod hermes_human_delay_config_tests {
    use super::{build_hermes_human_delay_config_values, merge_hermes_human_delay_config};
    use serde_json::json;

    #[test]
    fn human_delay_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_human_delay_config_values(&config);
        assert_eq!(values["humanDelayMode"], "off");
        assert_eq!(values["humanDelayMinMs"], 800);
        assert_eq!(values["humanDelayMaxMs"], 2500);
    }

    #[test]
    fn human_delay_values_normalize_existing_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
human_delay:
  mode: CUSTOM
  min_ms: 1200
  max_ms: 3600
"#,
        )
        .unwrap();
        let values = build_hermes_human_delay_config_values(&config);
        assert_eq!(values["humanDelayMode"], "custom");
        assert_eq!(values["humanDelayMinMs"], 1200);
        assert_eq!(values["humanDelayMaxMs"], 3600);
    }

    #[test]
    fn merge_human_delay_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
human_delay:
  mode: off
  custom_flag: keep-delay
streaming:
  enabled: true
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_human_delay_config(
            &mut config,
            &json!({
                "humanDelayMode": "custom",
                "humanDelayMinMs": "900",
                "humanDelayMaxMs": "2400",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["human_delay"]["custom_flag"].as_str(),
            Some("keep-delay")
        );
        assert_eq!(config["human_delay"]["mode"].as_str(), Some("custom"));
        assert_eq!(config["human_delay"]["min_ms"].as_i64(), Some(900));
        assert_eq!(config["human_delay"]["max_ms"].as_i64(), Some(2400));
    }

    #[test]
    fn merge_human_delay_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_human_delay_config(&mut config, &json!({ "humanDelayMode": "slow" }))
                .unwrap_err();
        assert!(err.contains("human_delay.mode"));

        let err = merge_hermes_human_delay_config(
            &mut config,
            &json!({
                "humanDelayMode": "custom",
                "humanDelayMinMs": 3000,
                "humanDelayMaxMs": 1000,
            }),
        )
        .unwrap_err();
        assert!(err.contains("human_delay.max_ms"));
    }
}

#[cfg(test)]
mod hermes_security_config_tests {
    use super::{build_hermes_security_config_values, merge_hermes_security_config};
    use serde_json::json;

    #[test]
    fn security_values_have_tirith_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_security_config_values(&config);
        assert_eq!(values["tirithEnabled"], true);
        assert_eq!(values["tirithPath"], "tirith");
        assert_eq!(values["tirithTimeout"], 5);
        assert_eq!(values["tirithFailOpen"], true);
    }

    #[test]
    fn security_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
security:
  tirith_enabled: false
  tirith_path: C:/tools/tirith.exe
  tirith_timeout: 12
  tirith_fail_open: false
"#,
        )
        .unwrap();
        let values = build_hermes_security_config_values(&config);
        assert_eq!(values["tirithEnabled"], false);
        assert_eq!(values["tirithPath"], "C:/tools/tirith.exe");
        assert_eq!(values["tirithTimeout"], 12);
        assert_eq!(values["tirithFailOpen"], false);
    }

    #[test]
    fn merge_security_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
security:
  allow_private_urls: false
  website_blocklist:
    enabled: true
    domains:
      - example.com
  custom_flag: keep-security
terminal:
  backend: docker
"#,
        )
        .unwrap();

        merge_hermes_security_config(
            &mut config,
            &json!({
                "tirithEnabled": false,
                "tirithPath": "~/bin/tirith",
                "tirithTimeout": 9,
                "tirithFailOpen": false,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["terminal"]["backend"].as_str(), Some("docker"));
        assert_eq!(
            config["security"]["custom_flag"].as_str(),
            Some("keep-security")
        );
        assert_eq!(config["security"]["tirith_enabled"].as_bool(), Some(false));
        assert_eq!(
            config["security"]["tirith_path"].as_str(),
            Some("~/bin/tirith")
        );
        assert_eq!(config["security"]["tirith_timeout"].as_i64(), Some(9));
        assert_eq!(
            config["security"]["tirith_fail_open"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn merge_security_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_security_config(&mut config, &json!({ "tirithTimeout": 0 })).unwrap_err();
        assert!(err.contains("security.tirith_timeout"));

        let err =
            merge_hermes_security_config(&mut config, &json!({ "tirithPath": "" })).unwrap_err();
        assert!(err.contains("security.tirith_path"));
    }
}

#[cfg(test)]
mod hermes_channel_tests {
    use super::{
        build_hermes_channel_config_values, build_hermes_channel_env_updates,
        merge_hermes_channel_config,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn merge_telegram_channel_keeps_unknown_extra_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
  default: claude-sonnet-4-6
platforms:
  telegram:
    enabled: false
    token: old
    extra:
      unknown_option: keep-me
"#,
        )
        .unwrap();

        merge_hermes_channel_config(
            &mut config,
            "telegram",
            &json!({
                "enabled": true,
                "botToken": "123:token",
                "dmPolicy": "pair",
                "groupPolicy": "allowlist",
                "allowFrom": "1001, 1002",
                "requireMention": true,
            }),
        )
        .unwrap();

        let values = build_hermes_channel_config_values(&config, &HashMap::new());
        assert_eq!(values["telegram"]["enabled"], true);
        assert_eq!(values["telegram"]["botToken"], "");
        assert_eq!(values["telegram"]["allowFrom"], "1001, 1002");
        assert_eq!(
            config["platforms"]["telegram"]["token"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["telegram"]["extra"]["unknown_option"].as_str(),
            Some("keep-me")
        );
        let env = build_hermes_channel_env_updates(
            "telegram",
            &json!({
                "botToken": "123:token",
                "allowFrom": "1001, 1002",
                "requireMention": true,
            }),
        );
        assert!(env.contains(&("TELEGRAM_BOT_TOKEN".to_string(), "123:token".to_string())));
    }

    #[test]
    fn build_channel_values_prefers_runtime_env_credentials() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
platforms:
  telegram:
    enabled: true
    token: yaml-token
    extra:
      allow_from: ["1001"]
  feishu:
    enabled: true
    extra:
      app_id: yaml-app-id
      app_secret: yaml-secret
      domain: lark
      connection_mode: webhook
  dingtalk:
    enabled: true
    extra:
      client_id: yaml-client-id
      client_secret: yaml-client-secret
      allowed_users: ["staff-1"]
      allowed_chats: ["cid-1"]
"#,
        )
        .unwrap();
        let mut env = HashMap::new();
        env.insert("TELEGRAM_BOT_TOKEN".to_string(), "env-token".to_string());
        env.insert("FEISHU_APP_ID".to_string(), "env-app-id".to_string());
        env.insert("FEISHU_APP_SECRET".to_string(), "env-secret".to_string());
        env.insert("FEISHU_DOMAIN".to_string(), "feishu".to_string());
        env.insert(
            "FEISHU_CONNECTION_MODE".to_string(),
            "websocket".to_string(),
        );
        env.insert(
            "DINGTALK_CLIENT_ID".to_string(),
            "env-client-id".to_string(),
        );
        env.insert(
            "DINGTALK_CLIENT_SECRET".to_string(),
            "env-client-secret".to_string(),
        );

        let values = build_hermes_channel_config_values(&config, &env);

        assert_eq!(values["telegram"]["botToken"], "env-token");
        assert_eq!(values["telegram"]["allowFrom"], "1001");
        assert_eq!(values["feishu"]["appId"], "env-app-id");
        assert_eq!(values["feishu"]["appSecret"], "env-secret");
        assert_eq!(values["feishu"]["domain"], "feishu");
        assert_eq!(values["feishu"]["connectionMode"], "websocket");
        assert_eq!(values["dingtalk"]["clientId"], "env-client-id");
        assert_eq!(values["dingtalk"]["clientSecret"], "env-client-secret");
        assert_eq!(values["dingtalk"]["allowFrom"], "staff-1");
        assert_eq!(values["dingtalk"]["groupAllowFrom"], "cid-1");
    }

    #[test]
    fn merge_feishu_channel_fills_runtime_defaults() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());

        merge_hermes_channel_config(
            &mut config,
            "feishu",
            &json!({
                "enabled": true,
                "appId": "cli_xxx",
                "appSecret": "secret",
                "domain": "",
                "connectionMode": "",
                "webhookPath": "",
                "reactionNotifications": "",
                "typingIndicator": true,
                "resolveSenderNames": true,
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["feishu"]["extra"]["app_id"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["feishu"]["extra"]["app_secret"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["feishu"]["extra"]["domain"].as_str(),
            Some("feishu")
        );
        assert_eq!(
            config["platforms"]["feishu"]["extra"]["connection_mode"].as_str(),
            Some("websocket")
        );
        assert_eq!(
            config["platforms"]["feishu"]["extra"]["webhook_path"].as_str(),
            Some("/feishu/webhook")
        );
        assert_eq!(
            config["platforms"]["feishu"]["extra"]["reaction_notifications"].as_str(),
            Some("off")
        );

        let env = build_hermes_channel_env_updates(
            "feishu",
            &json!({
                "appId": "cli_xxx",
                "appSecret": "secret",
                "domain": "",
                "connectionMode": "",
                "webhookPath": "",
                "groupPolicy": "allowlist",
            }),
        );
        assert!(env.contains(&("FEISHU_DOMAIN".to_string(), "feishu".to_string())));
        assert!(env.contains(&(
            "FEISHU_CONNECTION_MODE".to_string(),
            "websocket".to_string()
        )));
        assert!(env.contains(&(
            "FEISHU_WEBHOOK_PATH".to_string(),
            "/feishu/webhook".to_string()
        )));
    }

    #[test]
    fn discord_channel_supports_plugin_runtime_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
platforms:
  discord:
    enabled: true
    token: old-token
    extra:
      unknown_option: keep-me
      free_response_channels: ["yaml-free"]
      auto_thread: true
"#,
        )
        .unwrap();
        let mut env = HashMap::new();
        env.insert(
            "DISCORD_BOT_TOKEN".to_string(),
            "env-discord-token".to_string(),
        );
        env.insert(
            "DISCORD_FREE_RESPONSE_CHANNELS".to_string(),
            "env-free".to_string(),
        );
        env.insert("DISCORD_AUTO_THREAD".to_string(), "false".to_string());
        env.insert("DISCORD_HOME_CHANNEL".to_string(), "home-1".to_string());

        let values = build_hermes_channel_config_values(&config, &env);
        assert_eq!(values["discord"]["token"], "env-discord-token");
        assert_eq!(values["discord"]["freeResponseChannels"], "env-free");
        assert_eq!(values["discord"]["autoThread"], false);
        assert_eq!(values["discord"]["homeChannel"], "home-1");

        merge_hermes_channel_config(
            &mut config,
            "discord",
            &json!({
                "enabled": true,
                "token": "discord-token",
                "allowFrom": "1001, 1002",
                "requireMention": true,
                "freeResponseChannels": "free-a\nfree-b",
                "allowedChannels": "allow-a",
                "ignoredChannels": "ignore-a",
                "noThreadChannels": "plain-a",
                "autoThread": false,
                "reactions": true,
                "threadRequireMention": true,
                "historyBackfill": true,
                "historyBackfillLimit": "12",
                "replyToMode": "off",
                "homeChannel": "home-1",
                "homeChannelName": "ops-home",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["discord"]["token"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["free_response_channels"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["free-a", "free-b"]
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["allowed_channels"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["allow-a"]
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["auto_thread"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["reactions"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["thread_require_mention"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["history_backfill"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["history_backfill_limit"].as_str(),
            Some("12")
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["reply_to_mode"].as_str(),
            Some("off")
        );
        assert_eq!(
            config["platforms"]["discord"]["extra"]["unknown_option"].as_str(),
            Some("keep-me")
        );

        let env_updates = build_hermes_channel_env_updates(
            "discord",
            &json!({
                "token": "discord-token",
                "allowFrom": "1001, 1002",
                "requireMention": true,
                "freeResponseChannels": "free-a\nfree-b",
                "allowedChannels": "allow-a",
                "ignoredChannels": "ignore-a",
                "noThreadChannels": "plain-a",
                "autoThread": false,
                "reactions": true,
                "threadRequireMention": true,
                "historyBackfill": true,
                "historyBackfillLimit": "12",
                "replyToMode": "off",
                "homeChannel": "home-1",
                "homeChannelName": "ops-home",
            }),
        );

        assert!(
            env_updates.contains(&("DISCORD_BOT_TOKEN".to_string(), "discord-token".to_string()))
        );
        assert!(env_updates.contains(&(
            "DISCORD_FREE_RESPONSE_CHANNELS".to_string(),
            "free-a,free-b".to_string()
        )));
        assert!(env_updates.contains(&("DISCORD_AUTO_THREAD".to_string(), "false".to_string())));
        assert!(env_updates.contains(&(
            "DISCORD_THREAD_REQUIRE_MENTION".to_string(),
            "true".to_string()
        )));
        assert!(env_updates.contains(&("DISCORD_HOME_CHANNEL".to_string(), "home-1".to_string())));
    }

    #[test]
    fn merge_dingtalk_channel_uses_runtime_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
platforms:
  dingtalk:
    enabled: true
    extra:
      client_id: old-client-id
      client_secret: old-client-secret
      group_allow_from: ["legacy-chat"]
      unknown_option: keep-me
"#,
        )
        .unwrap();

        merge_hermes_channel_config(
            &mut config,
            "dingtalk",
            &json!({
                "enabled": true,
                "clientId": "ding-app-key",
                "clientSecret": "ding-secret",
                "allowFrom": "staff-1, staff-2",
                "groupAllowFrom": "cid-1\ncid-2",
                "requireMention": true,
            }),
        )
        .unwrap();

        assert_eq!(config["platforms"]["dingtalk"]["enabled"], true);
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["client_id"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["client_secret"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["group_allow_from"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["allowed_users"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["staff-1", "staff-2"]
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["allowed_chats"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["cid-1", "cid-2"]
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["require_mention"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["dingtalk"]["extra"]["unknown_option"].as_str(),
            Some("keep-me")
        );

        let env = build_hermes_channel_env_updates(
            "dingtalk",
            &json!({
                "clientId": "ding-app-key",
                "clientSecret": "ding-secret",
                "allowFrom": "staff-1, staff-2",
                "groupAllowFrom": "cid-1\ncid-2",
                "requireMention": true,
            }),
        );

        assert!(env.contains(&("DINGTALK_CLIENT_ID".to_string(), "ding-app-key".to_string())));
        assert!(env.contains(&(
            "DINGTALK_CLIENT_SECRET".to_string(),
            "ding-secret".to_string()
        )));
        assert!(env.contains(&(
            "DINGTALK_ALLOWED_USERS".to_string(),
            "staff-1,staff-2".to_string()
        )));
        assert!(env.contains(&(
            "DINGTALK_ALLOWED_CHATS".to_string(),
            "cid-1,cid-2".to_string()
        )));
        assert!(env.contains(&("DINGTALK_REQUIRE_MENTION".to_string(), "true".to_string())));
    }

    #[test]
    fn merge_channel_config_removes_yaml_secrets() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
platforms:
  slack:
    enabled: true
    token: old-bot-token
    extra:
      app_token: old-app-token
      signing_secret: old-signing-secret
      webhook_path: /old/events
      unknown_option: keep-me
"#,
        )
        .unwrap();

        merge_hermes_channel_config(
            &mut config,
            "slack",
            &json!({
                "enabled": true,
                "botToken": "xoxb-new",
                "appToken": "xapp-new",
                "signingSecret": "new-signing-secret",
                "webhookPath": "/slack/events",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["slack"]["token"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["slack"]["extra"]["app_token"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["slack"]["extra"]["signing_secret"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["slack"]["extra"]["webhook_path"].as_str(),
            Some("/slack/events")
        );
        assert_eq!(
            config["platforms"]["slack"]["extra"]["unknown_option"].as_str(),
            Some("keep-me")
        );
    }

    #[test]
    fn plugin_platform_values_prefer_env_and_preserve_yaml_runtime_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r##"
platforms:
  teams:
    enabled: true
    extra:
      client_id: yaml-teams-client
      client_secret: yaml-teams-secret
      tenant_id: yaml-tenant
      port: 3978
      service_url: https://smba.trafficmanager.net/teams/
      allow_from: ["aad-1"]
  google_chat:
    enabled: true
    extra:
      project_id: yaml-project
      subscription_name: projects/yaml-project/subscriptions/hermes
      service_account_json: yaml-sa.json
      allow_from: ["user@example.com"]
  irc:
    enabled: true
    extra:
      server: irc.libera.chat
      channel: "#hermes"
      nickname: hermes-bot
      use_tls: true
      allowed_users: ["alice"]
  line:
    enabled: true
    extra:
      channel_access_token: yaml-line-token
      channel_secret: yaml-line-secret
      host: 0.0.0.0
      port: 8646
      public_url: https://line.example.com
      allowed_users: ["U1"]
      allowed_groups: ["C1"]
      allowed_rooms: ["R1"]
      slow_response_threshold: "45"
  simplex:
    enabled: true
    extra:
      ws_url: ws://127.0.0.1:5225
      allowed_users: ["contact-1"]
"##,
        )
        .unwrap();
        let mut env = HashMap::new();
        env.insert(
            "TEAMS_CLIENT_ID".to_string(),
            "env-teams-client".to_string(),
        );
        env.insert(
            "TEAMS_CLIENT_SECRET".to_string(),
            "env-teams-secret".to_string(),
        );
        env.insert("TEAMS_TENANT_ID".to_string(), "env-tenant".to_string());
        env.insert("TEAMS_HOME_CHANNEL".to_string(), "teams-home".to_string());
        env.insert(
            "GOOGLE_CHAT_PROJECT_ID".to_string(),
            "env-project".to_string(),
        );
        env.insert(
            "GOOGLE_CHAT_SUBSCRIPTION_NAME".to_string(),
            "projects/env-project/subscriptions/hermes".to_string(),
        );
        env.insert(
            "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON".to_string(),
            "env-sa.json".to_string(),
        );
        env.insert(
            "GOOGLE_CHAT_HOME_CHANNEL".to_string(),
            "spaces/AAA".to_string(),
        );
        env.insert("IRC_SERVER".to_string(), "irc.oftc.net".to_string());
        env.insert("IRC_CHANNEL".to_string(), "#ops".to_string());
        env.insert("IRC_NICKNAME".to_string(), "ops-bot".to_string());
        env.insert("IRC_HOME_CHANNEL".to_string(), "#reports".to_string());
        env.insert(
            "LINE_CHANNEL_ACCESS_TOKEN".to_string(),
            "env-line-token".to_string(),
        );
        env.insert(
            "LINE_CHANNEL_SECRET".to_string(),
            "env-line-secret".to_string(),
        );
        env.insert("LINE_HOME_CHANNEL".to_string(), "U-home".to_string());
        env.insert(
            "SIMPLEX_WS_URL".to_string(),
            "ws://127.0.0.1:5226".to_string(),
        );
        env.insert(
            "SIMPLEX_HOME_CHANNEL".to_string(),
            "contact-home".to_string(),
        );

        let values = build_hermes_channel_config_values(&config, &env);

        assert_eq!(values["teams"]["clientId"], "env-teams-client");
        assert_eq!(values["teams"]["clientSecret"], "env-teams-secret");
        assert_eq!(values["teams"]["tenantId"], "env-tenant");
        assert_eq!(values["teams"]["homeChannel"], "teams-home");
        assert_eq!(values["teams"]["allowFrom"], "aad-1");
        assert_eq!(values["google_chat"]["projectId"], "env-project");
        assert_eq!(
            values["google_chat"]["subscriptionName"],
            "projects/env-project/subscriptions/hermes"
        );
        assert_eq!(values["google_chat"]["serviceAccountJson"], "env-sa.json");
        assert_eq!(values["google_chat"]["homeChannel"], "spaces/AAA");
        assert_eq!(values["irc"]["server"], "irc.oftc.net");
        assert_eq!(values["irc"]["channel"], "#ops");
        assert_eq!(values["irc"]["nickname"], "ops-bot");
        assert_eq!(values["irc"]["homeChannel"], "#reports");
        assert_eq!(values["irc"]["useTls"], true);
        assert_eq!(values["irc"]["allowFrom"], "alice");
        assert_eq!(values["line"]["channelAccessToken"], "env-line-token");
        assert_eq!(values["line"]["channelSecret"], "env-line-secret");
        assert_eq!(values["line"]["homeChannel"], "U-home");
        assert_eq!(values["line"]["allowedGroups"], "C1");
        assert_eq!(values["line"]["allowedRooms"], "R1");
        assert_eq!(values["simplex"]["wsUrl"], "ws://127.0.0.1:5226");
        assert_eq!(values["simplex"]["homeChannel"], "contact-home");
        assert_eq!(values["simplex"]["allowFrom"], "contact-1");
    }

    #[test]
    fn plugin_platform_save_writes_runtime_fields_and_env() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());

        merge_hermes_channel_config(
            &mut config,
            "teams",
            &json!({
                "enabled": true,
                "clientId": "teams-client",
                "clientSecret": "teams-secret",
                "tenantId": "tenant-1",
                "port": "3978",
                "serviceUrl": "https://smba.trafficmanager.net/teams/",
                "allowFrom": "aad-1, aad-2",
                "allowAllUsers": false,
                "homeChannel": "19:abc@thread.tacv2",
                "homeChannelName": "Ops",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["teams"]["extra"]["client_id"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["teams"]["extra"]["client_secret"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["teams"]["extra"]["tenant_id"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["teams"]["extra"]["port"].as_i64(),
            Some(3978)
        );
        assert_eq!(
            config["platforms"]["teams"]["extra"]["service_url"].as_str(),
            Some("https://smba.trafficmanager.net/teams/")
        );
        assert_eq!(
            config["platforms"]["teams"]["extra"]["allow_from"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["aad-1", "aad-2"]
        );

        merge_hermes_channel_config(
            &mut config,
            "google_chat",
            &json!({
                "enabled": true,
                "projectId": "project-1",
                "subscriptionName": "projects/project-1/subscriptions/hermes",
                "serviceAccountJson": "C:\\keys\\sa.json",
                "allowFrom": "user@example.com",
                "allowAllUsers": true,
                "homeChannel": "spaces/AAA",
                "homeChannelName": "Ops Space",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["google_chat"]["extra"]["project_id"].as_str(),
            Some("project-1")
        );
        assert_eq!(
            config["platforms"]["google_chat"]["extra"]["subscription_name"].as_str(),
            Some("projects/project-1/subscriptions/hermes")
        );
        assert_eq!(
            config["platforms"]["google_chat"]["extra"]["service_account_json"],
            serde_yaml::Value::Null
        );

        merge_hermes_channel_config(
            &mut config,
            "irc",
            &json!({
                "enabled": true,
                "server": "irc.libera.chat",
                "port": "6697",
                "nickname": "hermes-bot",
                "channel": "#hermes",
                "useTls": true,
                "serverPassword": "server-secret",
                "nickservPassword": "nick-secret",
                "allowFrom": "alice, bob",
                "allowAllUsers": false,
                "homeChannel": "#reports",
                "homeChannelName": "reports",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["irc"]["extra"]["server"].as_str(),
            Some("irc.libera.chat")
        );
        assert_eq!(
            config["platforms"]["irc"]["extra"]["port"].as_i64(),
            Some(6697)
        );
        assert_eq!(
            config["platforms"]["irc"]["extra"]["use_tls"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["irc"]["extra"]["server_password"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["irc"]["extra"]["nickserv_password"],
            serde_yaml::Value::Null
        );

        merge_hermes_channel_config(
            &mut config,
            "line",
            &json!({
                "enabled": true,
                "channelAccessToken": "line-token",
                "channelSecret": "line-secret",
                "port": "8646",
                "host": "0.0.0.0",
                "publicUrl": "https://line.example.com",
                "allowFrom": "U1",
                "allowedGroups": "C1",
                "allowedRooms": "R1",
                "allowAllUsers": false,
                "homeChannel": "U-home",
                "slowResponseThreshold": "45",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["line"]["extra"]["channel_access_token"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["line"]["extra"]["channel_secret"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["platforms"]["line"]["extra"]["port"].as_i64(),
            Some(8646)
        );
        assert_eq!(
            config["platforms"]["line"]["extra"]["allowed_groups"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["C1"]
        );

        merge_hermes_channel_config(
            &mut config,
            "simplex",
            &json!({
                "enabled": true,
                "wsUrl": "ws://127.0.0.1:5225",
                "allowFrom": "contact-1",
                "allowAllUsers": true,
                "homeChannel": "group:ops",
                "homeChannelName": "Ops",
            }),
        )
        .unwrap();

        assert_eq!(
            config["platforms"]["simplex"]["extra"]["ws_url"].as_str(),
            Some("ws://127.0.0.1:5225")
        );

        let env = build_hermes_channel_env_updates(
            "line",
            &json!({
                "channelAccessToken": "line-token",
                "channelSecret": "line-secret",
                "port": "8646",
                "host": "0.0.0.0",
                "publicUrl": "https://line.example.com",
                "allowFrom": "U1",
                "allowedGroups": "C1",
                "allowedRooms": "R1",
                "allowAllUsers": false,
                "homeChannel": "U-home",
                "slowResponseThreshold": "45",
            }),
        );

        assert!(env.contains(&(
            "LINE_CHANNEL_ACCESS_TOKEN".to_string(),
            "line-token".to_string()
        )));
        assert!(env.contains(&("LINE_ALLOWED_GROUPS".to_string(), "C1".to_string())));
        assert!(env.contains(&("LINE_HOME_CHANNEL".to_string(), "U-home".to_string())));
    }

    #[test]
    fn channel_display_values_read_platform_overrides_and_legacy_fallback() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
display:
  tool_progress: all
  show_reasoning: false
  cleanup_progress: false
  tool_progress_overrides:
    discord: off
  platforms:
    telegram:
      tool_progress: new
      show_reasoning: true
      tool_preview_length: 80
      streaming: false
      cleanup_progress: true
      custom_flag: keep-me
"#,
        )
        .unwrap();

        let values = build_hermes_channel_config_values(&config, &HashMap::new());

        assert_eq!(values["telegram"]["displayToolProgress"], "new");
        assert_eq!(values["telegram"]["displayShowReasoning"], true);
        assert_eq!(values["telegram"]["displayToolPreviewLength"], 80);
        assert_eq!(values["telegram"]["displayStreaming"], "false");
        assert_eq!(values["telegram"]["displayCleanupProgress"], true);
        assert_eq!(values["discord"]["displayToolProgress"], "off");
        assert_eq!(values["discord"]["displayStreaming"], "inherit");
    }

    #[test]
    fn merge_channel_display_writes_platform_overrides_and_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
display:
  tool_progress: all
  tool_progress_overrides:
    telegram: off
  platforms:
    telegram:
      tool_progress: new
      streaming: false
      custom_flag: keep-me
      runtime_footer:
        enabled: true
platforms:
  telegram:
    enabled: true
    extra:
      unknown_option: keep-platform
"#,
        )
        .unwrap();

        merge_hermes_channel_config(
            &mut config,
            "telegram",
            &json!({
                "enabled": true,
                "botToken": "",
                "displayToolProgress": "verbose",
                "displayShowReasoning": false,
                "displayToolPreviewLength": "120",
                "displayStreaming": "inherit",
                "displayCleanupProgress": false,
            }),
        )
        .unwrap();

        assert_eq!(config["display"]["tool_progress"].as_str(), Some("all"));
        assert_eq!(
            config["display"]["tool_progress_overrides"]["telegram"].as_str(),
            Some("off")
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["tool_progress"].as_str(),
            Some("verbose")
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["show_reasoning"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["tool_preview_length"].as_i64(),
            Some(120)
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["streaming"],
            serde_yaml::Value::Null
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["cleanup_progress"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["custom_flag"].as_str(),
            Some("keep-me")
        );
        assert_eq!(
            config["display"]["platforms"]["telegram"]["runtime_footer"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["telegram"]["extra"]["unknown_option"].as_str(),
            Some("keep-platform")
        );
    }

    #[test]
    fn merge_channel_display_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_channel_config(
            &mut config,
            "telegram",
            &json!({
                "enabled": true,
                "displayToolProgress": "everything",
                "displayToolPreviewLength": 80,
                "displayStreaming": "inherit",
            }),
        )
        .unwrap_err();
        assert!(err.contains("display.platforms.telegram.tool_progress"));

        let err = merge_hermes_channel_config(
            &mut config,
            "telegram",
            &json!({
                "enabled": true,
                "displayToolProgress": "all",
                "displayToolPreviewLength": 200001,
                "displayStreaming": "inherit",
            }),
        )
        .unwrap_err();
        assert!(err.contains("display.platforms.telegram.tool_preview_length"));

        let err = merge_hermes_channel_config(
            &mut config,
            "telegram",
            &json!({
                "enabled": true,
                "displayToolProgress": "all",
                "displayToolPreviewLength": 80,
                "displayStreaming": "global",
            }),
        )
        .unwrap_err();
        assert!(err.contains("display.platforms.telegram.streaming"));
    }
}
