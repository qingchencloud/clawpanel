//! Hermes Agent 安装与管理命令
//!
//! 通过 uv 实现零依赖安装：
//!   1. 下载 uv 单文件二进制
//!   2. uv tool install hermes-agent --python 3.11
//!   3. 写入 Hermes Home 下的 config.yaml + .env

use serde_json::Value;
use std::path::{Path, PathBuf};
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

fn is_openai_codex_endpoint(base_url: &str) -> bool {
    normalize_provider_url(base_url)
        == normalize_provider_url("https://chatgpt.com/backend-api/codex")
}

fn normalize_hermes_provider_for_base_url(provider: &str, base_url: Option<&str>) -> String {
    let pid = provider.trim();
    if pid.eq_ignore_ascii_case("openai-codex") {
        return "openai-codex".into();
    }
    if base_url.map(is_openai_codex_endpoint).unwrap_or(false) {
        return "openai-codex".into();
    }
    if pid.eq_ignore_ascii_case("openrouter") {
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

#[derive(Default, Debug, Clone, PartialEq, Eq)]
struct HermesModelFields {
    default_model: String,
    provider: String,
    base_url: String,
}

fn read_top_level_hermes_model_fields(raw: &str) -> Result<HermesModelFields, String> {
    let config: serde_yaml::Value =
        serde_yaml::from_str(raw).map_err(|e| format!("config.yaml YAML 格式错误: {e}"))?;
    let root = config
        .as_mapping()
        .ok_or_else(|| "config.yaml 顶层必须是对象".to_string())?;
    let Some(model_value) = yaml_get(root, "model") else {
        return Ok(HermesModelFields::default());
    };
    let Some(model) = model_value.as_mapping() else {
        return Ok(HermesModelFields {
            default_model: model_value.as_str().unwrap_or_default().to_string(),
            provider: String::new(),
            base_url: String::new(),
        });
    };
    Ok(HermesModelFields {
        default_model: yaml_string_field(model, "default").unwrap_or_default(),
        provider: yaml_string_field(model, "provider").unwrap_or_default(),
        base_url: yaml_string_field(model, "base_url").unwrap_or_default(),
    })
}

fn rewrite_top_level_hermes_model_provider(raw: &str, provider: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let mut in_model = false;
    let mut provider_written = false;
    let mut saw_model = false;
    let mut model_indent = 0usize;
    let mut child_prefix: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        let indent = line.len() - line.trim_start_matches([' ', '\t']).len();

        if !in_model && indent == 0 && trimmed.starts_with("model:") {
            in_model = true;
            saw_model = true;
            provider_written = false;
            model_indent = indent;
            child_prefix = None;
            out.push(line.to_string());
            continue;
        }

        if in_model {
            if indent <= model_indent && !trimmed.is_empty() && !trimmed.starts_with('#') {
                if !provider_written {
                    let prefix = child_prefix
                        .clone()
                        .unwrap_or_else(|| " ".repeat(model_indent + 2));
                    out.push(format!("{prefix}provider: {provider}"));
                    provider_written = true;
                }
                in_model = false;
            } else if indent > model_indent && trimmed.starts_with("provider:") {
                let prefix: String = line
                    .chars()
                    .take_while(|c| *c == ' ' || *c == '\t')
                    .collect();
                out.push(format!("{prefix}provider: {provider}"));
                provider_written = true;
                continue;
            } else if indent > model_indent
                && child_prefix.is_none()
                && !trimmed.is_empty()
                && !trimmed.starts_with('#')
            {
                child_prefix = Some(
                    line.chars()
                        .take_while(|c| *c == ' ' || *c == '\t')
                        .collect(),
                );
            }
        }

        out.push(line.to_string());
    }

    if !saw_model {
        return Err("config.yaml 中未找到顶层 model 字段".into());
    }
    if in_model && !provider_written {
        let prefix = child_prefix.unwrap_or_else(|| " ".repeat(model_indent + 2));
        out.push(format!("{prefix}provider: {provider}"));
    }

    let mut fixed = out.join("\n");
    if !fixed.ends_with('\n') {
        fixed.push('\n');
    }
    Ok(fixed)
}

fn should_alias_custom_openai_key(fields: &HermesModelFields) -> bool {
    let provider = fields.provider.trim();
    let base = normalize_provider_url(&fields.base_url);
    let expected = normalize_provider_url("https://openrouter.ai/api/v1");
    !is_openai_codex_endpoint(&fields.base_url)
        && (provider.is_empty() || provider.eq_ignore_ascii_case("custom"))
        && !base.is_empty()
        && base != expected
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
    let changed = sanitize_hermes_openrouter_custom_mismatch_at(&config_path)?;
    let raw =
        std::fs::read_to_string(config_path).map_err(|e| format!("读取 config.yaml 失败: {e}"))?;
    let fields = read_top_level_hermes_model_fields(&raw)?;
    let alias_changed = if should_alias_custom_openai_key(&fields) {
        ensure_custom_openai_key_alias()?
    } else {
        false
    };
    Ok(changed || alias_changed)
}

fn sanitize_hermes_openrouter_custom_mismatch_at(
    config_path: &std::path::Path,
) -> Result<bool, String> {
    if !config_path.exists() {
        return Ok(false);
    }

    let raw =
        std::fs::read_to_string(config_path).map_err(|e| format!("读取 config.yaml 失败: {e}"))?;
    let fields = read_top_level_hermes_model_fields(&raw)?;
    let provider = fields.provider.trim();
    let base = normalize_provider_url(&fields.base_url);
    let expected = normalize_provider_url("https://openrouter.ai/api/v1");
    let desired_provider = if provider.eq_ignore_ascii_case("openai-codex")
        || is_openai_codex_endpoint(&fields.base_url)
    {
        "openai-codex"
    } else if provider.eq_ignore_ascii_case("openrouter") && !base.is_empty() && base != expected {
        "custom"
    } else {
        return Ok(false);
    };

    if provider.eq_ignore_ascii_case(desired_provider) {
        return Ok(false);
    }

    let fixed = rewrite_top_level_hermes_model_provider(&raw, desired_provider)?;
    std::fs::write(config_path, fixed).map_err(|e| format!("写入 config.yaml 失败: {e}"))?;
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

    let mut cmd = std::process::Command::new(hermes_program_for_spawn()?);
    cmd.args(["gateway", "run"])
        .current_dir(&home)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    apply_hermes_runtime_env(&mut cmd, &enhanced);
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

/// Hermes 配置目录
fn hermes_home() -> PathBuf {
    if let Some(ctx) = crate::commands::portable::portable_context() {
        return ctx.hermes_home.clone();
    }
    local_hermes_home_default()
}

/// 本机（非便携）Hermes 数据目录默认值；便携模式迁移回本机时也用它定位目标
pub(crate) fn local_hermes_home_default() -> PathBuf {
    if let Ok(h) = std::env::var("HERMES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir().unwrap_or_default().join(".hermes")
}

pub(crate) fn hermes_home_path() -> PathBuf {
    hermes_home()
}

/// ClawPanel 管理的 uv 二进制存放路径
fn uv_bin_dir() -> PathBuf {
    if let Some(ctx) = crate::commands::portable::portable_context() {
        return ctx.root.join("runtimes").join("uv").join("bin");
    }
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

fn hermes_tool_dir() -> Option<PathBuf> {
    crate::commands::portable::portable_context().map(|ctx| ctx.engines_hermes_dir.clone())
}

fn hermes_tool_bin_dir() -> Option<PathBuf> {
    hermes_tool_dir().map(|dir| dir.join("bin"))
}

fn hermes_uv_cache_dir() -> Option<PathBuf> {
    crate::commands::portable::portable_context()
        .map(|ctx| ctx.root.join("runtimes").join("uv").join("cache"))
}

fn hermes_uv_python_dir() -> Option<PathBuf> {
    crate::commands::portable::portable_context()
        .map(|ctx| ctx.root.join("runtimes").join("uv").join("python"))
}

fn hermes_venv_dir() -> PathBuf {
    if let Some(ctx) = crate::commands::portable::portable_context() {
        return ctx.engines_hermes_dir.join("venv");
    }
    dirs::home_dir().unwrap_or_default().join(".hermes-venv")
}

fn ensure_hermes_portable_dirs() -> Result<(), String> {
    let Some(ctx) = crate::commands::portable::portable_context() else {
        return Ok(());
    };
    for dir in [
        ctx.hermes_home.clone(),
        ctx.engines_hermes_dir.clone(),
        ctx.engines_hermes_dir.join("bin"),
        ctx.root.join("runtimes").join("uv").join("bin"),
        ctx.root.join("runtimes").join("uv").join("cache"),
        ctx.root.join("runtimes").join("uv").join("python"),
    ] {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建便携目录 {} 失败: {e}", dir.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn portable_git_exe() -> Option<PathBuf> {
    crate::commands::portable::portable_context().map(|ctx| {
        ctx.root
            .join("runtimes")
            .join("git")
            .join("cmd")
            .join("git.exe")
    })
}

#[cfg(target_os = "windows")]
fn zip_entry_safe_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.contains(':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(normalized.split('/').collect())
}

#[cfg(target_os = "windows")]
fn extract_zip_archive(data: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 解析失败: {e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目录 {} 失败: {e}", dest.display()))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("ZIP 条目读取失败: {e}"))?;
        let Some(rel_path) = zip_entry_safe_path(file.name()) else {
            continue;
        };
        let out_path = dest.join(rel_path);
        if file.is_dir() || file.name().ends_with('/') {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("创建目录 {} 失败: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("创建文件 {} 失败: {e}", out_path.display()))?;
        std::io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("写入文件 {} 失败: {e}", out_path.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn mingit_asset_url(release: &Value) -> Option<String> {
    let assets = release.get("assets")?.as_array()?;
    assets
        .iter()
        .filter_map(|asset| {
            let name = asset.get("name")?.as_str()?;
            let url = asset.get("browser_download_url")?.as_str()?;
            Some((name, url))
        })
        .find(|(name, _)| {
            name.starts_with("MinGit-")
                && name.ends_with("-64-bit.zip")
                && !name.to_ascii_lowercase().contains("busybox")
        })
        .map(|(_, url)| url.to_string())
}

#[cfg(target_os = "windows")]
async fn ensure_portable_git(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(ctx) = crate::commands::portable::portable_context() else {
        return Ok(());
    };
    let Some(git_exe) = portable_git_exe() else {
        return Ok(());
    };
    if git_exe.is_file() {
        let _ = app.emit(
            "hermes-install-log",
            format!("✓ 便携 Git 已就绪: {}", git_exe.display()),
        );
        return Ok(());
    }

    let _ = app.emit("hermes-install-log", "📦 便携模式：下载 MinGit 到 U 盘...");
    let client = super::build_http_client(std::time::Duration::from_secs(300), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let release: Value = client
        .get("https://api.github.com/repos/git-for-windows/git/releases/latest")
        .send()
        .await
        .map_err(|e| format!("查询 MinGit 最新版本失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析 MinGit 最新版本失败: {e}"))?;
    let url =
        mingit_asset_url(&release).ok_or("未在 Git for Windows 最新版本中找到 MinGit 64-bit 包")?;
    let _ = app.emit("hermes-install-log", format!("下载: {url}"));
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("MinGit 下载失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("MinGit 下载读取失败: {e}"))?;

    let git_root = ctx.root.join("runtimes").join("git");
    if git_root.exists() {
        std::fs::remove_dir_all(&git_root).map_err(|e| format!("清理旧便携 Git 目录失败: {e}"))?;
    }
    extract_zip_archive(&bytes, &git_root)?;
    if !git_exe.is_file() {
        return Err(format!("MinGit 解压后未找到 {}", git_exe.display()));
    }
    let _ = app.emit(
        "hermes-install-log",
        format!("✓ 便携 Git 已安装: {}", git_exe.display()),
    );
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn ensure_portable_git(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

fn portable_hermes_cli_candidates() -> Vec<PathBuf> {
    let Some(tool_dir) = hermes_tool_dir() else {
        return Vec::new();
    };
    let bin_dir = tool_dir.join("bin");
    let root = tool_dir.join("hermes-agent");
    let mut paths = vec![
        bin_dir.join("hermes.cmd"),
        bin_dir.join("hermes.exe"),
        bin_dir.join("hermes.bat"),
        bin_dir.join("hermes"),
    ];
    if cfg!(target_os = "windows") {
        paths.push(root.join("Scripts").join("hermes.exe"));
        paths.push(root.join("Scripts").join("hermes.cmd"));
    } else {
        paths.push(root.join("bin").join("hermes"));
    }
    paths
}

fn portable_hermes_cli_path() -> Option<PathBuf> {
    portable_hermes_cli_candidates()
        .into_iter()
        .find(|p| p.is_file())
}

fn hermes_program_for_spawn() -> Result<PathBuf, String> {
    if crate::commands::portable::portable_context().is_some() {
        return portable_hermes_cli_path().ok_or_else(|| {
            "便携模式未找到 U 盘内 Hermes CLI，请先在 Hermes 服务页安装或修复 Hermes".to_string()
        });
    }
    Ok(PathBuf::from("hermes"))
}

fn command_program(program: &str) -> Result<PathBuf, String> {
    if program == "hermes" {
        hermes_program_for_spawn()
    } else {
        Ok(PathBuf::from(program))
    }
}

fn append_existing_path(extra: &mut Vec<String>, path: impl AsRef<Path>) {
    let path = path.as_ref();
    if path.exists() {
        extra.push(path.to_string_lossy().to_string());
    }
}

fn apply_hermes_runtime_env(cmd: &mut Command, path: &str) {
    cmd.env("PATH", path);
    if let Some(ctx) = crate::commands::portable::portable_context() {
        let tool_bin_dir =
            hermes_tool_bin_dir().unwrap_or_else(|| ctx.engines_hermes_dir.join("bin"));
        let cache_dir = hermes_uv_cache_dir()
            .unwrap_or_else(|| ctx.root.join("runtimes").join("uv").join("cache"));
        let python_dir = hermes_uv_python_dir()
            .unwrap_or_else(|| ctx.root.join("runtimes").join("uv").join("python"));
        cmd.env("HERMES_HOME", &ctx.hermes_home);
        cmd.env("UV_TOOL_DIR", &ctx.engines_hermes_dir);
        cmd.env("UV_TOOL_BIN_DIR", tool_bin_dir);
        cmd.env("UV_CACHE_DIR", cache_dir);
        cmd.env("UV_PYTHON_INSTALL_DIR", python_dir);
        cmd.env("UV_LINK_MODE", "copy");
    }
}

fn apply_hermes_runtime_env_tokio(cmd: &mut tokio::process::Command, path: &str) {
    cmd.env("PATH", path);
    if let Some(ctx) = crate::commands::portable::portable_context() {
        let tool_bin_dir =
            hermes_tool_bin_dir().unwrap_or_else(|| ctx.engines_hermes_dir.join("bin"));
        let cache_dir = hermes_uv_cache_dir()
            .unwrap_or_else(|| ctx.root.join("runtimes").join("uv").join("cache"));
        let python_dir = hermes_uv_python_dir()
            .unwrap_or_else(|| ctx.root.join("runtimes").join("uv").join("python"));
        cmd.env("HERMES_HOME", &ctx.hermes_home);
        cmd.env("UV_TOOL_DIR", &ctx.engines_hermes_dir);
        cmd.env("UV_TOOL_BIN_DIR", tool_bin_dir);
        cmd.env("UV_CACHE_DIR", cache_dir);
        cmd.env("UV_PYTHON_INSTALL_DIR", python_dir);
        cmd.env("UV_LINK_MODE", "copy");
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
    if let Some(ctx) = crate::commands::portable::portable_context() {
        extra.push(
            ctx.engines_hermes_dir
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
        let tool_root = ctx.engines_hermes_dir.join("hermes-agent");
        if cfg!(target_os = "windows") {
            extra.push(tool_root.join("Scripts").to_string_lossy().to_string());
            append_existing_path(
                &mut extra,
                ctx.root.join("runtimes").join("git").join("cmd"),
            );
            append_existing_path(
                &mut extra,
                ctx.root
                    .join("runtimes")
                    .join("git")
                    .join("usr")
                    .join("bin"),
            );
        } else {
            extra.push(tool_root.join("bin").to_string_lossy().to_string());
            append_existing_path(
                &mut extra,
                ctx.root.join("runtimes").join("git").join("bin"),
            );
        }
        if let Some(node_dir) = &ctx.node_dir {
            extra.push(node_dir.to_string_lossy().to_string());
        }
        append_existing_path(
            &mut extra,
            ctx.root.join("runtimes").join("ffmpeg").join("bin"),
        );
        append_existing_path(&mut extra, ctx.root.join("runtimes").join("rg"));
    }

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
    let mut cmd = Command::new(command_program(program)?);
    cmd.args(args);
    apply_hermes_runtime_env(&mut cmd, &enhanced);
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
    let mut cmd = Command::new(command_program(program)?);
    cmd.args(args);
    apply_hermes_runtime_env(&mut cmd, path);
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
    if let Some(ctx) = crate::commands::portable::portable_context() {
        let hermes_cli_path = portable_hermes_cli_candidates()
            .into_iter()
            .find(|p| p.is_file());
        result.insert("portable".into(), Value::Bool(true));
        result.insert(
            "portableRoot".into(),
            Value::String(ctx.root.to_string_lossy().to_string()),
        );
        result.insert(
            "enginesHermesDir".into(),
            Value::String(ctx.engines_hermes_dir.to_string_lossy().to_string()),
        );
        result.insert(
            "uvBinPath".into(),
            Value::String(uv_bin_path().to_string_lossy().to_string()),
        );
        result.insert(
            "uvToolBinDir".into(),
            Value::String(
                hermes_tool_bin_dir()
                    .unwrap_or_else(|| ctx.engines_hermes_dir.join("bin"))
                    .to_string_lossy()
                    .to_string(),
            ),
        );
        result.insert(
            "portableHermesCliPath".into(),
            hermes_cli_path
                .map(|p| Value::String(p.to_string_lossy().to_string()))
                .unwrap_or(Value::Null),
        );
        #[cfg(target_os = "windows")]
        {
            let git_path = portable_git_exe();
            result.insert(
                "portableGitPath".into(),
                git_path
                    .as_ref()
                    .map(|p| Value::String(p.to_string_lossy().to_string()))
                    .unwrap_or(Value::Null),
            );
            result.insert(
                "portableGitReady".into(),
                Value::Bool(git_path.as_ref().is_some_and(|p| p.is_file())),
            );
        }
    } else {
        result.insert("portable".into(), Value::Bool(false));
    }

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
pub async fn hermes_dashboard_start(app: tauri::AppHandle) -> Result<Value, String> {
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

    // 2b. 上游 wheel 漏装 dashboard_auth + web_dist 时，dashboard 进程会直接崩。
    // 在 spawn 前先做一次幂等 stub 注入，覆盖既有用户（从早期版本升上来、没走过 install_hermes
    // 的新代码路径）也能立即恢复。已存在的真实文件不会被覆盖。
    inject_hermes_dashboard_compat_stub(&app);

    let home = hermes_home();
    let log_path = home.join("dashboard-run.log");
    let log_file =
        std::fs::File::create(&log_path).map_err(|e| format!("创建日志文件失败: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("克隆日志句柄失败: {e}"))?;

    let enhanced = hermes_enhanced_path();
    let mut cmd = std::process::Command::new(hermes_program_for_spawn()?);
    cmd.args(["dashboard"])
        .current_dir(&home)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    apply_hermes_runtime_env(&mut cmd, &enhanced);
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

    // Step 2b: 注入 dashboard 兼容 stub（弥补上游 wheel 漏装 dashboard_auth + web_dist）
    inject_hermes_dashboard_compat_stub(&app);

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
    ensure_hermes_portable_dirs()?;
    let uv_path = uv_bin_path();
    let portable_mode = crate::commands::portable::portable_context().is_some();

    // 已有 uv
    if uv_path.exists() {
        let path_str = uv_path.to_string_lossy().to_string();
        if let Ok(ver) = run_silent(&path_str, &["--version"]) {
            let _ = app.emit("hermes-install-log", format!("✓ uv 已就绪: {ver}"));
            return Ok(path_str);
        }
    }

    if portable_mode {
        let _ = app.emit(
            "hermes-install-log",
            format!("💾 便携模式：uv 将安装到 {}", uv_path.display()),
        );
    } else {
        // 系统 PATH 中有 uv
        let enhanced = hermes_enhanced_path();
        if let Ok(ver) = run_at_path("uv", &["--version"], &enhanced) {
            let _ = app.emit("hermes-install-log", format!("✓ 系统 uv 已就绪: {ver}"));
            if let Some(path) = find_executable_path("uv", &enhanced) {
                return Ok(path);
            }
            return Ok("uv".into());
        }
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

const HERMES_STABLE_VERSION: &str = "0.18.0";
const HERMES_STABLE_TAG: &str = "v2026.7.1";
const HERMES_GIT_REPO_URL: &str = "https://github.com/NousResearch/hermes-agent.git";

/// Runtime Python deps that `hermes-agent` needs at runtime but are NOT declared as
/// install-time dependencies in its `[project].dependencies` (e.g. lazy-loaded
/// platform adapters). Without these, `hermes gateway run` starts but cannot bring
/// up the API server. Keep in sync between fresh install and upgrade paths.
const HERMES_RUNTIME_EXTRA_DEPS: &[&str] =
    &["croniter", "httpx", "openai", "aiohttp", "websockets"];

/// Append `--with <dep>` for every required runtime extra to the given command.
fn append_hermes_runtime_extras(cmd: &mut tokio::process::Command) {
    for dep in HERMES_RUNTIME_EXTRA_DEPS {
        cmd.args(["--with", dep]);
    }
}

/// Human-readable `--with X --with Y ...` segment for log lines so users see the
/// exact command we ran.
fn hermes_runtime_extras_log_segment() -> String {
    HERMES_RUNTIME_EXTRA_DEPS
        .iter()
        .map(|d| format!("--with {d}"))
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Hermes Dashboard compat stubs
//
// Older hermes-agent 0.14.x distributions shipped
// `hermes_cli/web_server.py` with hard imports of `hermes_cli.dashboard_auth.*`
// submodules whose source files were NOT included in the distribution. They also
// omitted the built dashboard SPA (`hermes_cli/web_dist/`). On Windows in
// particular, the missing dashboard_auth subpackage breaks `hermes dashboard`
// completely, taking down every ClawPanel page that talks to port 9119
// (Profile, Kanban, OAuth, Channels, Sessions detail).
// Current stable Hermes v0.18.0 / v2026.7.1 ships these files; this remains a
// no-op compatibility fallback for users upgrading from older broken installs.
//
// To stay self-sufficient (per project policy: do not patch upstream), we
// inject a minimal pass-through stub into the installed venv:
//   - `hermes_cli/dashboard_auth/{__init__,audit,middleware,prefix,routes,ws_tickets}.py`
//     so all `from hermes_cli.dashboard_auth.* import ...` lines resolve.
//     Auth is a no-op; valid for loopback (127.0.0.1) bindings where the
//     auth gate is intentionally disabled.
//   - `hermes_cli/web_dist/index.html` so `mount_spa()` takes the
//     token-injecting branch instead of the `Frontend not built` 404 branch.
//     Without this, the panel's `dashboard_session_token` scrape returns
//     404 and all `/api/*` calls fail with 401.
//
// The injection is idempotent: if upstream eventually ships either piece,
// the corresponding stub write is skipped so the real implementation wins.
// ---------------------------------------------------------------------------

const HERMES_DASHBOARD_AUTH_INIT_PY: &str = r#""""ClawPanel-injected stub for hermes_cli.dashboard_auth.

Upstream hermes-agent ships web_server.py with imports referencing this
subpackage, but the actual source files are NOT included in the wheel or
the public git repo. To keep Hermes Dashboard usable in loopback
(127.0.0.1) mode, ClawPanel injects this minimal pass-through stub at
install/upgrade time.

When upstream eventually ships the real module, delete this directory
and reinstall hermes-agent; the real implementation will be picked up.
"""
from __future__ import annotations

from typing import Iterable, List


class DashboardAuthProvider:
    """Stub base class. Real providers inherit from this."""

    name: str = ""


_REGISTERED: List["DashboardAuthProvider"] = []


def register_provider(provider: "DashboardAuthProvider") -> None:
    """No-op stub. ClawPanel binds to 127.0.0.1 so the gate is disabled."""
    if isinstance(provider, DashboardAuthProvider):
        _REGISTERED.append(provider)


def list_providers() -> Iterable["DashboardAuthProvider"]:
    """Return registered providers (empty on loopback)."""
    return list(_REGISTERED)


__all__ = ["DashboardAuthProvider", "register_provider", "list_providers"]
"#;

const HERMES_DASHBOARD_AUTH_AUDIT_PY: &str = r#""""ClawPanel stub: hermes_cli.dashboard_auth.audit"""
from __future__ import annotations

from enum import Enum
from typing import Any


class AuditEvent(str, Enum):
    LOGIN = "login"
    LOGOUT = "logout"
    LOGIN_FAILED = "login_failed"
    WS_TICKET_MINTED = "ws_ticket_minted"
    WS_TICKET_REJECTED = "ws_ticket_rejected"
    PROVIDER_REGISTERED = "provider_registered"


def audit_log(event: Any, **fields: Any) -> None:
    """No-op stub. Real implementation appends to an audit log file."""
    return None


__all__ = ["AuditEvent", "audit_log"]
"#;

const HERMES_DASHBOARD_AUTH_MIDDLEWARE_PY: &str = r#""""ClawPanel stub: hermes_cli.dashboard_auth.middleware"""
from __future__ import annotations


async def gated_auth_middleware(request, call_next):
    """Pass-through ASGI middleware. Real one enforces JWT on non-loopback."""
    return await call_next(request)


__all__ = ["gated_auth_middleware"]
"#;

const HERMES_DASHBOARD_AUTH_PREFIX_PY: &str = r#""""ClawPanel stub: hermes_cli.dashboard_auth.prefix"""
from __future__ import annotations


def normalise_prefix(prefix: str) -> str:
    """Normalise X-Forwarded-Prefix style values to a leading-slash form."""
    if not prefix:
        return ""
    return "/" + prefix.strip("/")


__all__ = ["normalise_prefix"]
"#;

const HERMES_DASHBOARD_AUTH_ROUTES_PY: &str = r#""""ClawPanel stub: hermes_cli.dashboard_auth.routes"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


__all__ = ["router"]
"#;

const HERMES_DASHBOARD_AUTH_WS_TICKETS_PY: &str = r#""""ClawPanel stub: hermes_cli.dashboard_auth.ws_tickets"""
from __future__ import annotations


class TicketInvalid(Exception):
    """Raised when a WS ticket is rejected. Stub never raises."""


def mint_ticket(*args, **kwargs) -> str:
    """Stub. Real one mints short-lived JWTs."""
    return "stub-loopback-ticket"


def consume_ticket(*args, **kwargs) -> None:
    """Stub. Real one validates signature + expiry. Never raises here."""
    return None


__all__ = ["TicketInvalid", "mint_ticket", "consume_ticket"]
"#;

const HERMES_DASHBOARD_WEB_DIST_INDEX_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hermes Dashboard (ClawPanel stub)</title>
    <meta name="generator" content="clawpanel-dashboard-spa-stub">
  </head>
  <body>
    <main style="font-family:system-ui,-apple-system,sans-serif;padding:32px;color:#333">
      <h1 style="margin:0 0 16px">Hermes Dashboard</h1>
      <p>This SPA placeholder is injected by ClawPanel so the dashboard backend
         emits a session token. ClawPanel provides its own UI; the upstream
         SPA is not shipped with the wheel.</p>
    </main>
  </body>
</html>
"#;

/// Resolve `<uv tool dir>/hermes-agent` — the venv root that `uv tool install`
/// creates. Returns `None` if `uv` is unavailable or hermes-agent isn't installed
/// via the uv-tool path (e.g. user is on the legacy `~/.hermes-venv` uv-pip path).
fn hermes_uv_tool_root() -> Option<std::path::PathBuf> {
    if let Some(tool_dir) = hermes_tool_dir() {
        let root = tool_dir.join("hermes-agent");
        return root.exists().then_some(root);
    }
    let uv_path = uv_bin_path();
    let uv_cmd = if uv_path.exists() {
        uv_path.to_string_lossy().to_string()
    } else {
        "uv".into()
    };
    let mut cmd = std::process::Command::new(&uv_cmd);
    cmd.args(["tool", "dir"]);
    let enhanced = hermes_enhanced_path();
    apply_hermes_runtime_env(&mut cmd, &enhanced);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return None;
    }
    let root = std::path::PathBuf::from(&stdout).join("hermes-agent");
    if root.exists() {
        Some(root)
    } else {
        None
    }
}

/// Locate the Python interpreter inside the uv-tool hermes-agent venv.
///
/// Layouts vary by platform:
///   - Windows: `<uv tool dir>/hermes-agent/Scripts/python.exe`
///   - macOS / Linux: `<uv tool dir>/hermes-agent/bin/python`
fn hermes_uv_tool_python() -> Option<std::path::PathBuf> {
    let root = hermes_uv_tool_root()?;
    #[cfg(target_os = "windows")]
    let py = root.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let py = root.join("bin").join("python");
    if py.exists() {
        Some(py)
    } else {
        None
    }
}

/// Locate the installed `hermes_cli` package directory inside the uv tool venv.
///
/// Layouts vary by platform:
///   - Windows: `<uv tool dir>/hermes-agent/Lib/site-packages/hermes_cli`
///   - macOS / Linux: `<uv tool dir>/hermes-agent/lib/python3.X/site-packages/hermes_cli`
///
/// Returns `None` if uv is unavailable or hermes-agent is not installed.
fn locate_hermes_cli_package_dir() -> Option<std::path::PathBuf> {
    let hermes_root = hermes_uv_tool_root()?;

    let windows_path = hermes_root
        .join("Lib")
        .join("site-packages")
        .join("hermes_cli");
    if windows_path.exists() {
        return Some(windows_path);
    }
    let lib_dir = hermes_root.join("lib");
    if let Ok(entries) = std::fs::read_dir(&lib_dir) {
        for entry in entries.flatten() {
            let pkg = entry.path().join("site-packages").join("hermes_cli");
            if pkg.exists() {
                return Some(pkg);
            }
        }
    }
    None
}

/// Inject the dashboard_auth and web_dist stubs into the installed hermes-agent
/// venv if upstream did not ship them. Idempotent: existing files are never
/// overwritten so the real implementation, if/when it lands, wins.
///
/// Stub injection failures are logged and swallowed — install/upgrade succeeds
/// regardless so users aren't blocked by best-effort compatibility patches.
fn inject_hermes_dashboard_compat_stub(app: &tauri::AppHandle) {
    let hermes_cli = match locate_hermes_cli_package_dir() {
        Some(p) => p,
        None => {
            let _ = app.emit(
                "hermes-install-log",
                "⚠ 跳过 dashboard 兼容 stub 注入：未找到 hermes_cli 包目录",
            );
            return;
        }
    };

    let mut wrote_auth = false;
    let auth_dir = hermes_cli.join("dashboard_auth");
    if !auth_dir.join("__init__.py").exists() {
        if let Err(e) = std::fs::create_dir_all(&auth_dir) {
            let _ = app.emit(
                "hermes-install-log",
                format!("⚠ 无法创建 dashboard_auth 目录: {e}"),
            );
            return;
        }
        let files: [(&str, &str); 6] = [
            ("__init__.py", HERMES_DASHBOARD_AUTH_INIT_PY),
            ("audit.py", HERMES_DASHBOARD_AUTH_AUDIT_PY),
            ("middleware.py", HERMES_DASHBOARD_AUTH_MIDDLEWARE_PY),
            ("prefix.py", HERMES_DASHBOARD_AUTH_PREFIX_PY),
            ("routes.py", HERMES_DASHBOARD_AUTH_ROUTES_PY),
            ("ws_tickets.py", HERMES_DASHBOARD_AUTH_WS_TICKETS_PY),
        ];
        for (name, content) in files {
            let path = auth_dir.join(name);
            if let Err(e) = std::fs::write(&path, content) {
                let _ = app.emit(
                    "hermes-install-log",
                    format!("⚠ 写入 dashboard_auth/{name} 失败: {e}"),
                );
                return;
            }
        }
        wrote_auth = true;
    }

    let mut wrote_dist = false;
    let dist_dir = hermes_cli.join("web_dist");
    let index_path = dist_dir.join("index.html");
    if !index_path.exists() {
        if let Err(e) = std::fs::create_dir_all(dist_dir.join("assets")) {
            let _ = app.emit(
                "hermes-install-log",
                format!("⚠ 无法创建 web_dist 目录: {e}"),
            );
            return;
        }
        if let Err(e) = std::fs::write(&index_path, HERMES_DASHBOARD_WEB_DIST_INDEX_HTML) {
            let _ = app.emit(
                "hermes-install-log",
                format!("⚠ 写入 web_dist/index.html 失败: {e}"),
            );
            return;
        }
        wrote_dist = true;
    }

    if wrote_auth || wrote_dist {
        let mut parts: Vec<&str> = Vec::new();
        if wrote_auth {
            parts.push("dashboard_auth");
        }
        if wrote_dist {
            parts.push("web_dist");
        }
        let _ = app.emit(
            "hermes-install-log",
            format!("📦 已注入 Hermes Dashboard 兼容 stub: {}", parts.join(", ")),
        );
    } else {
        let _ = app.emit(
            "hermes-install-log",
            "✓ Hermes Dashboard 兼容 stub 已存在，无需注入",
        );
    }
}

fn sanitize_hermes_install_output(text: &str) -> String {
    let hermes_git_url = hermes_git_url();
    let mut out = text.replace(&hermes_git_url, "hermes-agent");
    out = out.replace(
        &format!("{HERMES_GIT_REPO_URL}@{HERMES_STABLE_TAG}"),
        "hermes-agent",
    );
    out = out.replace(&format!("git+{HERMES_GIT_REPO_URL}"), "hermes-agent");
    out = out.replace(HERMES_GIT_REPO_URL, "hermes-agent");
    out = out.replace(
        "https://github.com/NousResearch/hermes-agent",
        "hermes-agent",
    );
    out = out.replace("github.com/NousResearch/hermes-agent.git", "hermes-agent");
    out = out.replace("github.com/NousResearch/hermes-agent", "hermes-agent");
    out.replace("NousResearch/hermes-agent", "hermes-agent")
}

fn hermes_git_url() -> String {
    format!("git+{HERMES_GIT_REPO_URL}@{HERMES_STABLE_TAG}")
}

fn hermes_package_spec(extras: &[String]) -> String {
    let hermes_git_url = hermes_git_url();
    if extras.is_empty() {
        format!("hermes-agent @ {hermes_git_url}")
    } else {
        format!("hermes-agent[{}] @ {hermes_git_url}", extras.join(","))
    }
}

fn emit_hermes_stable_version_log(app: &tauri::AppHandle) {
    let _ = app.emit(
        "hermes-install-log",
        format!("📌 Hermes 稳定版: {HERMES_STABLE_VERSION} ({HERMES_STABLE_TAG})"),
    );
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
    // PyPI / 通用网络类失败：下载依赖超时、SSL、解析失败等（国内环境高频）
    let pypi_hits = [
        "pypi.org",
        "files.pythonhosted.org",
        "read timed out",
        "operation timed out",
        "request timeout",
        "tls handshake",
        "ssl",
        "certificate",
        "proxy",
        "error sending request",
        "failed to fetch",
        "failed to download",
        "name resolution",
    ];
    let git_hits = [
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
    if git_hits.iter().any(|h| lower.contains(h)) {
        return Some(
            "⚠ 检测到安装过程中无法访问外部 Git 服务。请任选一项重试：\
\n  1) 在「设置 → 网络代理」配置可用代理后重试；\
\n  2) 在「设置 → Hermes 安装镜像」填入可用的 Git 镜像前缀。"
                .to_string(),
        );
    }
    if pypi_hits.iter().any(|h| lower.contains(h)) {
        return Some(
            "⚠ 检测到下载 Python 依赖失败（PyPI 网络问题）。请任选一项重试：\
\n  1) 在安装页「网络与镜像」选择国内 PyPI 镜像（清华 / 阿里云）后重试；\
\n  2) 在「设置 → 网络代理」配置可用代理后重试。"
                .to_string(),
        );
    }
    None
}

/// 以流式方式运行安装类子进程：stdout / stderr 逐行实时 emit 到前端日志，
/// 返回退出状态与 stderr 尾部内容（用于失败诊断）。
/// 修复旧实现 wait_with_output 等进程结束才发日志、用户长时间只见转圈的问题
async fn run_install_command_streaming(
    app: &tauri::AppHandle,
    mut cmd: tokio::process::Command,
) -> Result<(std::process::ExitStatus, String), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    const STDERR_KEEP_BYTES: usize = 8 * 1024;

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动安装进程失败: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
        let Some(stdout) = stdout else { return };
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let _ = app_out.emit(
                    "hermes-install-log",
                    sanitize_hermes_install_output(trimmed),
                );
            }
        }
    });

    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        let mut collected = String::new();
        let Some(stderr) = stderr else {
            return collected;
        };
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let _ = app_err.emit(
                "hermes-install-log",
                sanitize_hermes_install_output(trimmed),
            );
            collected.push_str(trimmed);
            collected.push('\n');
            // 只保留尾部：uv 输出可能很长，错误信息几乎都在最后
            if collected.len() > STDERR_KEEP_BYTES * 2 {
                let mut cut = collected.len() - STDERR_KEEP_BYTES;
                while !collected.is_char_boundary(cut) {
                    cut += 1;
                }
                collected.drain(..cut);
            }
        }
        collected
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待安装进程失败: {e}"))?;
    let _ = out_task.await;
    let stderr_text = err_task.await.unwrap_or_default();
    Ok((status, stderr_text))
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
    emit_hermes_stable_version_log(app);
    let _ = app.emit("hermes-install-progress", 25u32);
    ensure_hermes_portable_dirs()?;
    ensure_portable_git(app).await?;
    if let Some(tool_dir) = hermes_tool_dir() {
        let _ = app.emit(
            "hermes-install-log",
            format!("💾 便携模式：Hermes 将安装到 {}", tool_dir.display()),
        );
    }

    let pkg = hermes_package_spec(extras);

    let mut cmd = tokio::process::Command::new(uv_path);
    cmd.args(["tool", "install", "--force", &pkg, "--python", "3.11"]);
    append_hermes_runtime_extras(&mut cmd);

    // 配置 PyPI 镜像（extras 的依赖仍从 PyPI 下载）
    if let Some(mirror) = pypi_mirror_url() {
        cmd.args(["--index-url", &mirror]);
    }

    // 代理
    super::apply_proxy_env_tokio(&mut cmd);
    let enhanced = hermes_enhanced_path();
    apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
    // uv 需要 git 来克隆仓库
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // 用户配置了 Git 镜像（如 ghproxy）→ 进程级注入 insteadOf 重写
    apply_git_mirror_env(&mut cmd);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let _ = app.emit(
        "hermes-install-log",
        format!(
            "uv tool install hermes-agent@{HERMES_STABLE_TAG} --python 3.11 {}",
            hermes_runtime_extras_log_segment()
        ),
    );

    // 流式执行：安装输出逐行实时显示，不再等进程结束
    let (status, stderr_text) = run_install_command_streaming(app, cmd).await?;

    if status.success() {
        let _ = app.emit("hermes-install-log", "✓ uv tool install 完成");
        if crate::commands::portable::portable_context().is_some() {
            let _ = app.emit(
                "hermes-install-log",
                "💾 便携模式：已跳过写入用户 Shell PATH",
            );
        } else {
            // 更新 shell PATH
            let mut update_cmd = tokio::process::Command::new(uv_path);
            update_cmd.args(["tool", "update-shell"]);
            let enhanced = hermes_enhanced_path();
            apply_hermes_runtime_env_tokio(&mut update_cmd, &enhanced);
            #[cfg(target_os = "windows")]
            update_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = update_cmd.output().await;
        }
        Ok(())
    } else {
        let cleaned = sanitize_hermes_install_output(stderr_text.trim());
        // 命中 git/network 失败 → 在日志流尾部追加诊断 + 给最终错误消息加上提示
        if let Some(hint) = diagnose_install_network_error(&cleaned) {
            let _ = app.emit("hermes-install-log", &hint);
            return Err(format!(
                "安装失败 (exit {}): {}\n\n{}",
                status.code().unwrap_or(-1),
                cleaned,
                hint
            ));
        }
        Err(format!(
            "安装失败 (exit {}): {}",
            status.code().unwrap_or(-1),
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
    emit_hermes_stable_version_log(app);
    let _ = app.emit("hermes-install-progress", 25u32);

    ensure_hermes_portable_dirs()?;
    ensure_portable_git(app).await?;
    let venv_dir = hermes_venv_dir();
    let venv_str = venv_dir.to_string_lossy().to_string();

    // 创建 venv
    let _ = app.emit(
        "hermes-install-log",
        format!("> uv venv {venv_str} --python 3.11"),
    );
    let mut venv_cmd = tokio::process::Command::new(uv_path);
    venv_cmd.args(["venv", &venv_str, "--python", "3.11"]);
    let enhanced = hermes_enhanced_path();
    apply_hermes_runtime_env_tokio(&mut venv_cmd, &enhanced);
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
    let pkg = hermes_package_spec(extras);
    let _ = app.emit(
        "hermes-install-log",
        format!("> uv pip install hermes-agent@{HERMES_STABLE_TAG}"),
    );

    let mut pip_cmd = tokio::process::Command::new(uv_path);
    pip_cmd.args(["pip", "install", &pkg]);
    pip_cmd.env("GIT_TERMINAL_PROMPT", "0");
    pip_cmd.env("VIRTUAL_ENV", &venv_str);
    apply_hermes_runtime_env_tokio(&mut pip_cmd, &enhanced);
    if let Some(mirror) = pypi_mirror_url() {
        pip_cmd.args(["--index-url", &mirror]);
    }
    apply_git_mirror_env(&mut pip_cmd);
    super::apply_proxy_env_tokio(&mut pip_cmd);
    #[cfg(target_os = "windows")]
    pip_cmd.creation_flags(CREATE_NO_WINDOW);

    // 流式执行：pip 下载/构建输出逐行实时显示
    let (pip_status, pip_stderr) = run_install_command_streaming(app, pip_cmd).await?;

    if !pip_status.success() {
        let cleaned = sanitize_hermes_install_output(pip_stderr.trim());
        if let Some(hint) = diagnose_install_network_error(&cleaned) {
            let _ = app.emit("hermes-install-log", &hint);
            return Err(format!("pip install 失败: {cleaned}\n\n{hint}"));
        }
        return Err(format!("pip install 失败: {cleaned}"));
    }

    let _ = app.emit("hermes-install-log", "✓ pip install 完成");

    if crate::commands::portable::portable_context().is_some() {
        let _ = app.emit(
            "hermes-install-log",
            "💾 便携模式：已跳过写入用户 PATH / 全局链接",
        );
        return Ok(());
    }

    // 创建全局命令链接
    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().unwrap_or_default();
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
const HERMES_TELEGRAM_REPLY_TO_MODE_VALUES: [&str; 3] = ["off", "first", "all"];
const HERMES_PROMPT_CACHE_TTLS: [&str; 2] = ["5m", "1h"];
const HERMES_PROVIDER_ROUTING_SORTS: [&str; 3] = ["price", "throughput", "latency"];
const HERMES_PROVIDER_ROUTING_DATA_COLLECTION: [&str; 2] = ["allow", "deny"];
const HERMES_AUXILIARY_PROVIDERS: [&str; 7] = [
    "auto",
    "openrouter",
    "nous",
    "gemini",
    "ollama-cloud",
    "codex",
    "main",
];

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

fn normalize_hermes_display_tool_prefix(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let prefix = value.unwrap_or_default().trim().to_string();
    let prefix = if prefix.is_empty() {
        "┊".to_string()
    } else {
        prefix
    };
    if prefix.chars().count() <= 8 && !prefix.contains(['\r', '\n', '\t']) {
        Ok(prefix)
    } else if strict {
        Err("display.tool_prefix 必须是 1 到 8 个字符，且不能包含换行或制表符".to_string())
    } else {
        Ok("┊".to_string())
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

fn normalize_hermes_telegram_reply_to_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "first".to_string()
    } else {
        mode
    };
    if HERMES_TELEGRAM_REPLY_TO_MODE_VALUES.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("platforms.telegram.extra.reply_to_mode 必须是 off、first 或 all".to_string())
    } else {
        Ok("first".to_string())
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

fn normalize_hermes_prompt_cache_ttl(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let ttl = value.unwrap_or_default().trim().to_ascii_lowercase();
    let ttl = if ttl.is_empty() {
        "5m".to_string()
    } else {
        ttl
    };
    if HERMES_PROMPT_CACHE_TTLS.contains(&ttl.as_str()) {
        Ok(ttl)
    } else if strict {
        Err("prompt_caching.cache_ttl 必须是 5m 或 1h".to_string())
    } else {
        Ok("5m".to_string())
    }
}

fn normalize_hermes_provider_routing_sort(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let sort = value.unwrap_or_default().trim().to_ascii_lowercase();
    let sort = if sort.is_empty() {
        "price".to_string()
    } else {
        sort
    };
    if HERMES_PROVIDER_ROUTING_SORTS.contains(&sort.as_str()) {
        Ok(sort)
    } else if strict {
        Err("provider_routing.sort 必须是 price、throughput 或 latency".to_string())
    } else {
        Ok("price".to_string())
    }
}

fn normalize_hermes_provider_routing_data_collection(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let data_collection = value.unwrap_or_default().trim().to_ascii_lowercase();
    let data_collection = if data_collection.is_empty() {
        "allow".to_string()
    } else {
        data_collection
    };
    if HERMES_PROVIDER_ROUTING_DATA_COLLECTION.contains(&data_collection.as_str()) {
        Ok(data_collection)
    } else if strict {
        Err("provider_routing.data_collection 必须是 allow 或 deny".to_string())
    } else {
        Ok("allow".to_string())
    }
}

fn normalize_hermes_provider_routing_list(
    raw: Option<String>,
    key: &str,
) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        let provider = item.trim().to_ascii_lowercase();
        if provider.is_empty() {
            continue;
        }
        if !provider
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(format!("{key} 只能包含 provider slug，每行一个"));
        }
        if !values.contains(&provider) {
            values.push(provider);
        }
    }
    Ok(values)
}

fn normalize_hermes_env_name_list(raw: Option<String>, key: &str) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        let name = item.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut chars = name.chars();
        let valid_first = chars
            .next()
            .map(|ch| ch.is_ascii_alphabetic() || ch == '_')
            .unwrap_or(false);
        let valid_rest = chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
        if !valid_first || !valid_rest {
            return Err(format!(
                "{key} 只能填写环境变量名，每行一个，例如 GITHUB_TOKEN"
            ));
        }
        if !values.contains(&name) {
            values.push(name);
        }
    }
    Ok(values)
}

fn normalize_hermes_shell_init_file_list(
    raw: Option<String>,
    key: &str,
) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        let path = item.trim().to_string();
        if path.is_empty() {
            continue;
        }
        if path.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
            return Err(format!(
                "{key} 每行只能填写一个 shell 初始化文件路径，路径不能包含空白字符"
            ));
        }
        if !path.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(
                    ch,
                    '~' | '$' | '%' | '{' | '}' | '_' | '.' | '/' | '\\' | ':' | '-'
                )
        }) {
            return Err(format!(
                "{key} 只能包含路径字符、~、环境变量占位、点、斜杠、冒号和短横线"
            ));
        }
        if !values.contains(&path) {
            values.push(path);
        }
    }
    Ok(values)
}

fn validate_hermes_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let valid_first = chars
        .next()
        .map(|ch| ch.is_ascii_alphabetic() || ch == '_')
        .unwrap_or(false);
    valid_first && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn normalize_hermes_docker_env_json(
    raw: Option<String>,
    key: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("{key} JSON 格式错误: {err}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("{key} 必须是 JSON object"))?;
    let mut normalized = serde_json::Map::new();
    for (name, raw_value) in object {
        if !validate_hermes_env_name(name) {
            return Err(format!("{key} 只能使用合法环境变量名作为 key"));
        }
        let value = if let Some(value) = raw_value.as_str() {
            value.to_string()
        } else if let Some(value) = raw_value.as_i64() {
            value.to_string()
        } else if let Some(value) = raw_value.as_u64() {
            value.to_string()
        } else if let Some(value) = raw_value.as_f64() {
            if value.is_finite() {
                value.to_string()
            } else {
                return Err(format!("{key}.{name} 只能是字符串、数字或布尔值"));
            }
        } else if let Some(value) = raw_value.as_bool() {
            value.to_string()
        } else {
            return Err(format!("{key}.{name} 只能是字符串、数字或布尔值"));
        };
        normalized.insert(name.to_string(), Value::String(value));
    }
    Ok(normalized)
}

fn normalize_hermes_docker_volume_list(
    raw: Option<String>,
    key: &str,
) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        let volume = item.trim().to_string();
        if !volume.contains(':')
            || volume
                .chars()
                .any(|ch| ch.is_control() || ch.is_whitespace())
        {
            return Err(format!(
                "{key} 每行一个 Docker volume 映射，例如 /host/path:/container/path"
            ));
        }
        if !values.contains(&volume) {
            values.push(volume);
        }
    }
    Ok(values)
}

fn normalize_hermes_docker_extra_args_list(
    raw: Option<String>,
    key: &str,
) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        let arg = item.trim().to_string();
        if !arg.starts_with('-') || arg.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
            return Err(format!(
                "{key} 每行一个 Docker 参数，必须以 - 开头，例如 --network=host"
            ));
        }
        if !values.contains(&arg) {
            values.push(arg);
        }
    }
    Ok(values)
}

fn normalize_hermes_auxiliary_provider(
    value: Option<String>,
    key: &str,
    strict: bool,
) -> Result<String, String> {
    let provider = value.unwrap_or_default().trim().to_ascii_lowercase();
    let provider = if provider.is_empty() {
        "auto".to_string()
    } else {
        provider
    };
    if HERMES_AUXILIARY_PROVIDERS.contains(&provider.as_str()) {
        Ok(provider)
    } else if strict {
        Err(format!(
            "{key} 必须是 auto、openrouter、nous、gemini、ollama-cloud、codex 或 main"
        ))
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_auxiliary_model(
    value: Option<String>,
    key: &str,
    strict: bool,
) -> Result<String, String> {
    let model = value.unwrap_or_default().trim().to_string();
    if model.is_empty() {
        return Ok(String::new());
    }
    if !model.split('/').any(|part| part == "..")
        && model.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | ':' | '@' | '+' | '-')
        })
    {
        Ok(model)
    } else if strict {
        Err(format!(
            "{key} 只能包含字母、数字、下划线、点、斜杠、冒号、@、加号和短横线"
        ))
    } else {
        Ok(String::new())
    }
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

fn set_optional_yaml_string(map: &mut serde_yaml::Mapping, key: &str, value: String) {
    if value.is_empty() {
        map.remove(yaml_key(key));
    } else {
        map.insert(yaml_key(key), serde_yaml::Value::String(value));
    }
}

fn normalize_hermes_camofox_identity(value: Option<String>, key: &str) -> Result<String, String> {
    let text = value.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    if text
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '@' | '+' | '-'))
    {
        Ok(text)
    } else {
        Err(format!(
            "{key} 只能包含字母、数字、下划线、点、冒号、@、加号和短横线"
        ))
    }
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

fn yaml_docker_env_json_field(map: Option<&serde_yaml::Mapping>, key: &str) -> String {
    let Some(env_map) = map
        .and_then(|map| yaml_get(map, key))
        .and_then(|value| value.as_mapping())
    else {
        return "{}".to_string();
    };
    let mut lines = Vec::new();
    for (raw_key, raw_value) in env_map {
        let Some(name) = raw_key.as_str() else {
            continue;
        };
        if !validate_hermes_env_name(name) {
            continue;
        }
        let value = if let Some(value) = raw_value.as_str() {
            value.to_string()
        } else if let Some(value) = raw_value.as_i64() {
            value.to_string()
        } else if let Some(value) = raw_value.as_u64() {
            value.to_string()
        } else if let Some(value) = raw_value.as_f64() {
            if value.is_finite() {
                value.to_string()
            } else {
                continue;
            }
        } else if let Some(value) = raw_value.as_bool() {
            value.to_string()
        } else {
            continue;
        };
        let encoded_name = serde_json::to_string(name).unwrap_or_else(|_| "\"\"".to_string());
        let encoded_value = serde_json::to_string(&value).unwrap_or_else(|_| "\"\"".to_string());
        lines.push(format!("  {encoded_name}: {encoded_value}"));
    }
    if lines.is_empty() {
        "{}".to_string()
    } else {
        format!("{{\n{}\n}}", lines.join(",\n"))
    }
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
                let reply_to_mode = normalize_hermes_telegram_reply_to_mode(
                    hermes_env_value(env_values, "TELEGRAM_REPLY_TO_MODE")
                        .or_else(|| yaml_string_field(&extra, "reply_to_mode")),
                    false,
                )
                .unwrap_or_else(|_| "first".to_string());
                form.insert("replyToMode".to_string(), Value::String(reply_to_mode));
                insert_json_bool_if_present(&mut form, &extra, "guest_mode", "guestMode");
                insert_json_bool_if_present(
                    &mut form,
                    &extra,
                    "disable_link_previews",
                    "disableLinkPreviews",
                );
                put_json_bool_from_env(&mut form, env_values, "TELEGRAM_GUEST_MODE", "guestMode");
                put_json_bool_from_env(
                    &mut form,
                    env_values,
                    "TELEGRAM_DISABLE_LINK_PREVIEWS",
                    "disableLinkPreviews",
                );
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

const HERMES_MODEL_CATALOG_DEFAULT_URL: &str =
    "https://hermes-agent.nousresearch.com/docs/api/model-catalog.json";

fn normalize_hermes_http_url(
    value: Option<String>,
    key: &str,
    fallback: &str,
    strict: bool,
) -> Result<String, String> {
    let raw = value.unwrap_or_default().trim().to_string();
    if raw.is_empty() {
        if strict && fallback.is_empty() {
            return Err(format!("{key} 不能为空"));
        }
        return Ok(fallback.to_string());
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(raw);
    }
    if strict {
        return Err(format!("{key} 必须是 http:// 或 https:// URL"));
    }
    Ok(fallback.to_string())
}

fn validate_hermes_model_catalog_providers(
    value: &Value,
) -> Result<serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "model_catalog.providers 必须是 JSON object".to_string())?;
    let mut normalized = serde_json::Map::new();
    for (provider, raw_entry) in object {
        if provider.is_empty()
            || !provider
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(format!(
                "model_catalog.providers.{provider} 名称只能包含字母、数字、下划线、点和短横线"
            ));
        }
        let mut entry = raw_entry
            .as_object()
            .cloned()
            .ok_or_else(|| format!("model_catalog.providers.{provider} 必须是 object"))?;
        if entry.contains_key("url") {
            let url = normalize_hermes_http_url(
                entry
                    .get("url")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                &format!("model_catalog.providers.{provider}.url"),
                "",
                true,
            )?;
            if url.is_empty() {
                entry.remove("url");
            } else {
                entry.insert("url".to_string(), Value::String(url));
            }
        }
        normalized.insert(provider.to_string(), Value::Object(entry));
    }
    Ok(normalized)
}

fn parse_hermes_model_catalog_providers_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("model_catalog.providers JSON 格式错误: {err}"))?;
    validate_hermes_model_catalog_providers(&value)
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

fn build_hermes_prompt_caching_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let prompt_caching = root.and_then(|map| yaml_get_mapping(map, "prompt_caching"));
    serde_json::json!({
        "promptCacheTtl": normalize_hermes_prompt_cache_ttl(
            prompt_caching.and_then(|map| yaml_string_field(map, "cache_ttl")),
            false,
        ).unwrap_or_else(|_| "5m".to_string()),
    })
}

fn merge_hermes_prompt_caching_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_prompt_caching_config_values(config);
    let cache_ttl = normalize_hermes_prompt_cache_ttl(
        form_string(form, "promptCacheTtl")
            .or_else(|| current["promptCacheTtl"].as_str().map(ToString::to_string)),
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    let prompt_caching = yaml_child_object(root, "prompt_caching")?;
    prompt_caching.insert(yaml_key("cache_ttl"), serde_yaml::Value::String(cache_ttl));
    Ok(())
}

fn build_hermes_openrouter_cache_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let openrouter = root.and_then(|map| yaml_get_mapping(map, "openrouter"));
    serde_json::json!({
        "openrouterResponseCache": openrouter.and_then(|map| yaml_bool_field(map, "response_cache")).unwrap_or(true),
        "openrouterResponseCacheTtl": openrouter.map(|map| bounded_hermes_i64(yaml_i64_field(map, "response_cache_ttl"), 300, 1, 86400)).unwrap_or(300),
    })
}

fn merge_hermes_openrouter_cache_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_openrouter_cache_config_values(config);
    let response_cache = form_bool(form, "openrouterResponseCache")
        .unwrap_or_else(|| current["openrouterResponseCache"].as_bool().unwrap_or(true));
    let response_cache_ttl_input = if form.get("openrouterResponseCacheTtl").is_some() {
        Some(
            form_i64(form, "openrouterResponseCacheTtl")
                .ok_or_else(|| "openrouter.response_cache_ttl 必须是整数".to_string())?,
        )
    } else {
        Some(
            current["openrouterResponseCacheTtl"]
                .as_i64()
                .unwrap_or(300),
        )
    };
    let response_cache_ttl = validate_hermes_i64(
        response_cache_ttl_input,
        "openrouter.response_cache_ttl",
        300,
        1,
        86400,
    )?;

    let root = ensure_yaml_object(config)?;
    let openrouter = yaml_child_object(root, "openrouter")?;
    openrouter.insert(
        yaml_key("response_cache"),
        serde_yaml::Value::Bool(response_cache),
    );
    openrouter.insert(
        yaml_key("response_cache_ttl"),
        serde_yaml::Value::Number(response_cache_ttl.into()),
    );
    Ok(())
}

fn provider_routing_list_from_yaml(
    map: Option<&serde_yaml::Mapping>,
    key: &str,
) -> Result<Vec<String>, String> {
    let raw = map
        .map(|map| yaml_string_sequence_field(map, key).join("\n"))
        .unwrap_or_default();
    normalize_hermes_provider_routing_list(Some(raw), &format!("provider_routing.{key}"))
}

fn build_hermes_provider_routing_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let provider_routing = root.and_then(|map| yaml_get_mapping(map, "provider_routing"));
    let sort = normalize_hermes_provider_routing_sort(
        provider_routing.and_then(|map| yaml_string_field(map, "sort")),
        false,
    )
    .unwrap_or_else(|_| "price".to_string());
    let data_collection = normalize_hermes_provider_routing_data_collection(
        provider_routing.and_then(|map| yaml_string_field(map, "data_collection")),
        false,
    )
    .unwrap_or_else(|_| "allow".to_string());
    let only = provider_routing_list_from_yaml(provider_routing, "only").unwrap_or_default();
    let ignore = provider_routing_list_from_yaml(provider_routing, "ignore").unwrap_or_default();
    let order = provider_routing_list_from_yaml(provider_routing, "order").unwrap_or_default();

    serde_json::json!({
        "providerRoutingSort": sort,
        "providerRoutingOnly": only.join("\n"),
        "providerRoutingIgnore": ignore.join("\n"),
        "providerRoutingOrder": order.join("\n"),
        "providerRoutingRequireParameters": provider_routing.and_then(|map| yaml_bool_field(map, "require_parameters")).unwrap_or(false),
        "providerRoutingDataCollection": data_collection,
    })
}

fn merge_hermes_provider_routing_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_provider_routing_config_values(config);
    let sort = normalize_hermes_provider_routing_sort(
        if form.get("providerRoutingSort").is_some() {
            form_string(form, "providerRoutingSort")
        } else {
            current["providerRoutingSort"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let data_collection = normalize_hermes_provider_routing_data_collection(
        if form.get("providerRoutingDataCollection").is_some() {
            form_string(form, "providerRoutingDataCollection")
        } else {
            current["providerRoutingDataCollection"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let require_parameters =
        form_bool(form, "providerRoutingRequireParameters").unwrap_or_else(|| {
            current["providerRoutingRequireParameters"]
                .as_bool()
                .unwrap_or(false)
        });

    let only = normalize_hermes_provider_routing_list(
        form_string(form, "providerRoutingOnly").or_else(|| {
            current["providerRoutingOnly"]
                .as_str()
                .map(ToString::to_string)
        }),
        "provider_routing.only",
    )?;
    let ignore = normalize_hermes_provider_routing_list(
        form_string(form, "providerRoutingIgnore").or_else(|| {
            current["providerRoutingIgnore"]
                .as_str()
                .map(ToString::to_string)
        }),
        "provider_routing.ignore",
    )?;
    let order = normalize_hermes_provider_routing_list(
        form_string(form, "providerRoutingOrder").or_else(|| {
            current["providerRoutingOrder"]
                .as_str()
                .map(ToString::to_string)
        }),
        "provider_routing.order",
    )?;

    let root = ensure_yaml_object(config)?;
    let provider_routing = yaml_child_object(root, "provider_routing")?;
    provider_routing.insert(yaml_key("sort"), serde_yaml::Value::String(sort));
    provider_routing.insert(
        yaml_key("require_parameters"),
        serde_yaml::Value::Bool(require_parameters),
    );
    provider_routing.insert(
        yaml_key("data_collection"),
        serde_yaml::Value::String(data_collection),
    );

    for (key, values) in [("only", only), ("ignore", ignore), ("order", order)] {
        if values.is_empty() {
            provider_routing.remove(yaml_key(key));
        } else {
            provider_routing.insert(
                yaml_key(key),
                serde_yaml::Value::Sequence(
                    values.into_iter().map(serde_yaml::Value::String).collect(),
                ),
            );
        }
    }
    Ok(())
}

fn hermes_auxiliary_task<'a>(
    root: Option<&'a serde_yaml::Mapping>,
    key: &str,
) -> Option<&'a serde_yaml::Mapping> {
    root.and_then(|map| yaml_get_mapping(map, "auxiliary"))
        .and_then(|map| yaml_get_mapping(map, key))
}

fn build_hermes_auxiliary_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let vision = hermes_auxiliary_task(root, "vision");
    let web_extract = hermes_auxiliary_task(root, "web_extract");
    let session_search = hermes_auxiliary_task(root, "session_search");

    serde_json::json!({
        "auxiliaryVisionProvider": normalize_hermes_auxiliary_provider(
            vision.and_then(|map| yaml_string_field(map, "provider")),
            "auxiliary.vision.provider",
            false,
        ).unwrap_or_else(|_| "auto".to_string()),
        "auxiliaryVisionModel": normalize_hermes_auxiliary_model(
            vision.and_then(|map| yaml_string_field(map, "model")),
            "auxiliary.vision.model",
            false,
        ).unwrap_or_default(),
        "auxiliaryVisionTimeout": vision.map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout"), 30, 1, 3600)).unwrap_or(30),
        "auxiliaryVisionDownloadTimeout": vision.map(|map| bounded_hermes_i64(yaml_i64_field(map, "download_timeout"), 30, 1, 3600)).unwrap_or(30),
        "auxiliaryWebExtractProvider": normalize_hermes_auxiliary_provider(
            web_extract.and_then(|map| yaml_string_field(map, "provider")),
            "auxiliary.web_extract.provider",
            false,
        ).unwrap_or_else(|_| "auto".to_string()),
        "auxiliaryWebExtractModel": normalize_hermes_auxiliary_model(
            web_extract.and_then(|map| yaml_string_field(map, "model")),
            "auxiliary.web_extract.model",
            false,
        ).unwrap_or_default(),
        "auxiliarySessionSearchProvider": normalize_hermes_auxiliary_provider(
            session_search.and_then(|map| yaml_string_field(map, "provider")),
            "auxiliary.session_search.provider",
            false,
        ).unwrap_or_else(|_| "auto".to_string()),
        "auxiliarySessionSearchModel": normalize_hermes_auxiliary_model(
            session_search.and_then(|map| yaml_string_field(map, "model")),
            "auxiliary.session_search.model",
            false,
        ).unwrap_or_default(),
        "auxiliarySessionSearchTimeout": session_search.map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout"), 30, 1, 3600)).unwrap_or(30),
        "auxiliarySessionSearchMaxConcurrency": session_search.map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_concurrency"), 3, 1, 100)).unwrap_or(3),
    })
}

fn merge_hermes_auxiliary_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_auxiliary_config_values(config);
    let vision_provider = normalize_hermes_auxiliary_provider(
        form_string(form, "auxiliaryVisionProvider").or_else(|| {
            current["auxiliaryVisionProvider"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.vision.provider",
        true,
    )?;
    let vision_model = normalize_hermes_auxiliary_model(
        form_string(form, "auxiliaryVisionModel").or_else(|| {
            current["auxiliaryVisionModel"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.vision.model",
        true,
    )?;
    let vision_timeout = validate_hermes_i64(
        if form.get("auxiliaryVisionTimeout").is_some() {
            form_i64(form, "auxiliaryVisionTimeout")
        } else {
            Some(current["auxiliaryVisionTimeout"].as_i64().unwrap_or(30))
        },
        "auxiliary.vision.timeout",
        30,
        1,
        3600,
    )?;
    let vision_download_timeout = validate_hermes_i64(
        if form.get("auxiliaryVisionDownloadTimeout").is_some() {
            form_i64(form, "auxiliaryVisionDownloadTimeout")
        } else {
            Some(
                current["auxiliaryVisionDownloadTimeout"]
                    .as_i64()
                    .unwrap_or(30),
            )
        },
        "auxiliary.vision.download_timeout",
        30,
        1,
        3600,
    )?;
    let web_extract_provider = normalize_hermes_auxiliary_provider(
        form_string(form, "auxiliaryWebExtractProvider").or_else(|| {
            current["auxiliaryWebExtractProvider"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.web_extract.provider",
        true,
    )?;
    let web_extract_model = normalize_hermes_auxiliary_model(
        form_string(form, "auxiliaryWebExtractModel").or_else(|| {
            current["auxiliaryWebExtractModel"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.web_extract.model",
        true,
    )?;
    let session_search_provider = normalize_hermes_auxiliary_provider(
        form_string(form, "auxiliarySessionSearchProvider").or_else(|| {
            current["auxiliarySessionSearchProvider"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.session_search.provider",
        true,
    )?;
    let session_search_model = normalize_hermes_auxiliary_model(
        form_string(form, "auxiliarySessionSearchModel").or_else(|| {
            current["auxiliarySessionSearchModel"]
                .as_str()
                .map(ToString::to_string)
        }),
        "auxiliary.session_search.model",
        true,
    )?;
    let session_search_timeout = validate_hermes_i64(
        if form.get("auxiliarySessionSearchTimeout").is_some() {
            form_i64(form, "auxiliarySessionSearchTimeout")
        } else {
            Some(
                current["auxiliarySessionSearchTimeout"]
                    .as_i64()
                    .unwrap_or(30),
            )
        },
        "auxiliary.session_search.timeout",
        30,
        1,
        3600,
    )?;
    let session_search_max_concurrency = validate_hermes_i64(
        if form.get("auxiliarySessionSearchMaxConcurrency").is_some() {
            form_i64(form, "auxiliarySessionSearchMaxConcurrency")
        } else {
            Some(
                current["auxiliarySessionSearchMaxConcurrency"]
                    .as_i64()
                    .unwrap_or(3),
            )
        },
        "auxiliary.session_search.max_concurrency",
        3,
        1,
        100,
    )?;

    let root = ensure_yaml_object(config)?;
    let auxiliary = yaml_child_object(root, "auxiliary")?;
    let vision = yaml_child_object(auxiliary, "vision")?;
    vision.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(vision_provider),
    );
    vision.insert(yaml_key("model"), serde_yaml::Value::String(vision_model));
    vision.insert(
        yaml_key("timeout"),
        serde_yaml::Value::Number(vision_timeout.into()),
    );
    vision.insert(
        yaml_key("download_timeout"),
        serde_yaml::Value::Number(vision_download_timeout.into()),
    );

    let web_extract = yaml_child_object(auxiliary, "web_extract")?;
    web_extract.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(web_extract_provider),
    );
    web_extract.insert(
        yaml_key("model"),
        serde_yaml::Value::String(web_extract_model),
    );

    let session_search = yaml_child_object(auxiliary, "session_search")?;
    session_search.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(session_search_provider),
    );
    session_search.insert(
        yaml_key("model"),
        serde_yaml::Value::String(session_search_model),
    );
    session_search.insert(
        yaml_key("timeout"),
        serde_yaml::Value::Number(session_search_timeout.into()),
    );
    session_search.insert(
        yaml_key("max_concurrency"),
        serde_yaml::Value::Number(session_search_max_concurrency.into()),
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
    let qmd = memory.and_then(|map| yaml_get_mapping(map, "qmd"));
    let qmd_rerank = qmd
        .and_then(|map| yaml_bool_field(map, "rerank"))
        .unwrap_or(true);

    serde_json::json!({
        "memoryEnabled": memory_enabled,
        "userProfileEnabled": user_profile_enabled,
        "memoryCharLimit": memory_char_limit,
        "userCharLimit": user_char_limit,
        "nudgeInterval": nudge_interval,
        "flushMinTurns": flush_min_turns,
        "qmdRerank": qmd_rerank,
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
    let qmd_rerank = form_bool(form, "qmdRerank")
        .unwrap_or_else(|| current["qmdRerank"].as_bool().unwrap_or(true));

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
    let qmd = yaml_child_object(memory, "qmd")?;
    qmd.insert(yaml_key("rerank"), serde_yaml::Value::Bool(qmd_rerank));
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
        "templateVars": skills.and_then(|map| yaml_bool_field(map, "template_vars")).unwrap_or(true),
        "inlineShell": skills.and_then(|map| yaml_bool_field(map, "inline_shell")).unwrap_or(false),
        "inlineShellTimeout": skills
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "inline_shell_timeout"), 10, 1, 86400))
            .unwrap_or(10),
        "guardAgentCreated": skills.and_then(|map| yaml_bool_field(map, "guard_agent_created")).unwrap_or(false),
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
    let inline_shell_timeout = validate_hermes_i64(
        if form.get("inlineShellTimeout").is_some() {
            form_i64(form, "inlineShellTimeout")
        } else {
            Some(current["inlineShellTimeout"].as_i64().unwrap_or(10))
        },
        "skills.inline_shell_timeout",
        10,
        1,
        86400,
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
    skills.insert(
        yaml_key("template_vars"),
        serde_yaml::Value::Bool(
            form_bool(form, "templateVars")
                .unwrap_or_else(|| current["templateVars"].as_bool().unwrap_or(true)),
        ),
    );
    skills.insert(
        yaml_key("inline_shell"),
        serde_yaml::Value::Bool(
            form_bool(form, "inlineShell")
                .unwrap_or_else(|| current["inlineShell"].as_bool().unwrap_or(false)),
        ),
    );
    skills.insert(
        yaml_key("inline_shell_timeout"),
        serde_yaml::Value::Number(inline_shell_timeout.into()),
    );
    skills.insert(
        yaml_key("guard_agent_created"),
        serde_yaml::Value::Bool(
            form_bool(form, "guardAgentCreated")
                .unwrap_or_else(|| current["guardAgentCreated"].as_bool().unwrap_or(false)),
        ),
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

fn build_hermes_curator_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let curator = root.and_then(|map| yaml_get_mapping(map, "curator"));
    let backup = curator.and_then(|map| yaml_get_mapping(map, "backup"));

    serde_json::json!({
        "curatorEnabled": curator.and_then(|map| yaml_bool_field(map, "enabled")).unwrap_or(true),
        "curatorIntervalHours": curator
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "interval_hours"), 168, 1, 87600))
            .unwrap_or(168),
        "curatorMinIdleHours": curator
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "min_idle_hours"), 2, 0, 87600))
            .unwrap_or(2),
        "curatorStaleAfterDays": curator
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "stale_after_days"), 30, 1, 36500))
            .unwrap_or(30),
        "curatorArchiveAfterDays": curator
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "archive_after_days"), 90, 1, 36500))
            .unwrap_or(90),
        "curatorBackupEnabled": backup.and_then(|map| yaml_bool_field(map, "enabled")).unwrap_or(true),
        "curatorBackupKeep": backup
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "keep"), 5, 0, 1000))
            .unwrap_or(5),
    })
}

fn merge_hermes_curator_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_curator_config_values(config);
    let curator_interval_hours = validate_hermes_i64(
        if form.get("curatorIntervalHours").is_some() {
            form_i64(form, "curatorIntervalHours")
        } else {
            Some(current["curatorIntervalHours"].as_i64().unwrap_or(168))
        },
        "curator.interval_hours",
        168,
        1,
        87600,
    )?;
    let curator_min_idle_hours = validate_hermes_i64(
        if form.get("curatorMinIdleHours").is_some() {
            form_i64(form, "curatorMinIdleHours")
        } else {
            Some(current["curatorMinIdleHours"].as_i64().unwrap_or(2))
        },
        "curator.min_idle_hours",
        2,
        0,
        87600,
    )?;
    let curator_stale_after_days = validate_hermes_i64(
        if form.get("curatorStaleAfterDays").is_some() {
            form_i64(form, "curatorStaleAfterDays")
        } else {
            Some(current["curatorStaleAfterDays"].as_i64().unwrap_or(30))
        },
        "curator.stale_after_days",
        30,
        1,
        36500,
    )?;
    let curator_archive_after_days = validate_hermes_i64(
        if form.get("curatorArchiveAfterDays").is_some() {
            form_i64(form, "curatorArchiveAfterDays")
        } else {
            Some(current["curatorArchiveAfterDays"].as_i64().unwrap_or(90))
        },
        "curator.archive_after_days",
        90,
        1,
        36500,
    )?;
    if curator_archive_after_days < curator_stale_after_days {
        return Err(
            "curator.archive_after_days 必须大于或等于 curator.stale_after_days".to_string(),
        );
    }
    let curator_backup_keep = validate_hermes_i64(
        if form.get("curatorBackupKeep").is_some() {
            form_i64(form, "curatorBackupKeep")
        } else {
            Some(current["curatorBackupKeep"].as_i64().unwrap_or(5))
        },
        "curator.backup.keep",
        5,
        0,
        1000,
    )?;

    let root = ensure_yaml_object(config)?;
    let curator = yaml_child_object(root, "curator")?;
    curator.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(
            form_bool(form, "curatorEnabled")
                .unwrap_or_else(|| current["curatorEnabled"].as_bool().unwrap_or(true)),
        ),
    );
    curator.insert(
        yaml_key("interval_hours"),
        serde_yaml::Value::Number(curator_interval_hours.into()),
    );
    curator.insert(
        yaml_key("min_idle_hours"),
        serde_yaml::Value::Number(curator_min_idle_hours.into()),
    );
    curator.insert(
        yaml_key("stale_after_days"),
        serde_yaml::Value::Number(curator_stale_after_days.into()),
    );
    curator.insert(
        yaml_key("archive_after_days"),
        serde_yaml::Value::Number(curator_archive_after_days.into()),
    );
    let backup = yaml_child_object(curator, "backup")?;
    backup.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(
            form_bool(form, "curatorBackupEnabled")
                .unwrap_or_else(|| current["curatorBackupEnabled"].as_bool().unwrap_or(true)),
        ),
    );
    backup.insert(
        yaml_key("keep"),
        serde_yaml::Value::Number(curator_backup_keep.into()),
    );
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

fn normalize_hermes_model_config_string(
    value: Option<String>,
    key: &str,
    required: bool,
) -> Result<String, String> {
    let text = value.unwrap_or_default().trim().to_string();
    if text.is_empty() && required {
        return Err(format!("{key} 不能为空"));
    }
    Ok(text)
}

fn hermes_model_form_string(
    form: &Value,
    form_key: &str,
    yaml_key: &str,
    current: &Value,
) -> Result<Option<String>, String> {
    if let Some(value) = form.get(form_key) {
        if let Some(text) = value.as_str() {
            return Ok(Some(text.to_string()));
        }
        return Err(format!("{yaml_key} 必须是字符串"));
    }
    Ok(current.as_str().map(ToString::to_string))
}

fn optional_hermes_model_i64_field(
    form: &Value,
    form_key: &str,
    yaml_key_name: &str,
    current: &Value,
) -> Result<Option<i64>, String> {
    let raw = if let Some(value) = form.get(form_key) {
        if value.is_null() {
            None
        } else if let Some(text) = value.as_str() {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(
                    text.parse::<i64>()
                        .map_err(|_| format!("{yaml_key_name} 必须是整数"))?,
                )
            }
        } else if let Some(value) = value.as_i64() {
            Some(value)
        } else if let Some(value) = value.as_u64() {
            Some(i64::try_from(value).map_err(|_| format!("{yaml_key_name} 必须是整数"))?)
        } else {
            return Err(format!("{yaml_key_name} 必须是整数"));
        }
    } else if let Some(text) = current.as_str() {
        let text = text.trim();
        if text.is_empty() {
            None
        } else {
            Some(
                text.parse::<i64>()
                    .map_err(|_| format!("{yaml_key_name} 必须是整数"))?,
            )
        }
    } else {
        None
    };

    match raw {
        Some(value) if (1..=10_000_000).contains(&value) => Ok(Some(value)),
        Some(_) => Err(format!("{yaml_key_name} 必须在 1-10000000 范围内")),
        None => Ok(None),
    }
}

fn build_hermes_model_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let model = root
        .and_then(|map| map.get(yaml_key("model")))
        .and_then(|value| value.as_mapping());
    let model_default = model
        .and_then(|map| {
            map.get(yaml_key("default"))
                .or_else(|| map.get(yaml_key("model")))
        })
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let provider = model
        .and_then(|map| map.get(yaml_key("provider")))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    let base_url = model
        .and_then(|map| map.get(yaml_key("base_url")))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let context_length = model
        .and_then(|map| yaml_i64_field(map, "context_length"))
        .filter(|value| *value > 0)
        .map(|value| value.to_string())
        .unwrap_or_default();
    let max_tokens = model
        .and_then(|map| yaml_i64_field(map, "max_tokens"))
        .filter(|value| *value > 0)
        .map(|value| value.to_string())
        .unwrap_or_default();

    serde_json::json!({
        "modelDefault": model_default,
        "modelProvider": provider,
        "modelBaseUrl": base_url,
        "modelContextLength": context_length,
        "modelMaxTokens": max_tokens,
    })
}

fn merge_hermes_model_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_model_config_values(config);
    let model_default = normalize_hermes_model_config_string(
        hermes_model_form_string(
            form,
            "modelDefault",
            "model.default",
            &current["modelDefault"],
        )?,
        "model.default",
        true,
    )?;
    let provider = normalize_hermes_model_config_string(
        hermes_model_form_string(
            form,
            "modelProvider",
            "model.provider",
            &current["modelProvider"],
        )?,
        "model.provider",
        true,
    )?;
    let base_url = normalize_hermes_model_config_string(
        hermes_model_form_string(
            form,
            "modelBaseUrl",
            "model.base_url",
            &current["modelBaseUrl"],
        )?,
        "model.base_url",
        false,
    )?;
    let context_length = optional_hermes_model_i64_field(
        form,
        "modelContextLength",
        "model.context_length",
        &current["modelContextLength"],
    )?;
    let max_tokens = optional_hermes_model_i64_field(
        form,
        "modelMaxTokens",
        "model.max_tokens",
        &current["modelMaxTokens"],
    )?;

    let root = ensure_yaml_object(config)?;
    let mut model = root
        .get(yaml_key("model"))
        .and_then(|value| value.as_mapping())
        .cloned()
        .unwrap_or_default();
    model.insert(
        yaml_key("default"),
        serde_yaml::Value::String(model_default),
    );
    model.insert(yaml_key("provider"), serde_yaml::Value::String(provider));
    if base_url.is_empty() {
        model.remove(yaml_key("base_url"));
    } else {
        model.insert(yaml_key("base_url"), serde_yaml::Value::String(base_url));
    }
    if let Some(context_length) = context_length {
        model.insert(
            yaml_key("context_length"),
            serde_yaml::Value::Number(context_length.into()),
        );
    } else {
        model.remove(yaml_key("context_length"));
    }
    if let Some(max_tokens) = max_tokens {
        model.insert(
            yaml_key("max_tokens"),
            serde_yaml::Value::Number(max_tokens.into()),
        );
    } else {
        model.remove(yaml_key("max_tokens"));
    }
    model.remove(yaml_key("model"));
    root.insert(yaml_key("model"), serde_yaml::Value::Mapping(model));
    Ok(())
}

fn is_hermes_model_alias_name(value: &str) -> bool {
    let text = value.trim();
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn normalize_hermes_model_alias_string(
    entry: &mut serde_json::Map<String, Value>,
    field: &str,
    key: &str,
    required: bool,
) -> Result<(), String> {
    let empty = entry.get(field).is_none_or(|value| {
        value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
    });
    if empty {
        if required {
            return Err(format!("{key}.{field} 不能为空"));
        }
        entry.remove(field);
        return Ok(());
    }
    let Some(value) = entry.get(field).and_then(|value| value.as_str()) else {
        return Err(format!("{key}.{field} 必须是字符串"));
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        if required {
            return Err(format!("{key}.{field} 不能为空"));
        }
        entry.remove(field);
    } else {
        entry.insert(field.to_string(), Value::String(value));
    }
    Ok(())
}

fn validate_hermes_model_aliases(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(object) = value.as_object() else {
        return Err("model_aliases 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (raw_alias, raw_config) in object {
        let alias = raw_alias.trim();
        if !is_hermes_model_alias_name(alias) {
            return Err(format!(
                "model_aliases.{} 别名只能包含字母、数字、下划线、点和短横线",
                if raw_alias.is_empty() {
                    "<empty>"
                } else {
                    raw_alias
                }
            ));
        }
        let Some(config) = raw_config.as_object() else {
            return Err(format!("model_aliases.{alias} 必须是 JSON 对象"));
        };
        let mut entry = config.clone();
        let key = format!("model_aliases.{alias}");
        normalize_hermes_model_alias_string(&mut entry, "model", &key, true)?;
        normalize_hermes_model_alias_string(&mut entry, "provider", &key, false)?;
        normalize_hermes_model_alias_string(&mut entry, "base_url", &key, false)?;
        normalized.insert(alias.to_string(), Value::Object(entry));
    }
    Ok(normalized)
}

fn parse_hermes_model_aliases_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("model_aliases JSON 格式错误: {err}"))?;
    validate_hermes_model_aliases(&value)
}

fn build_hermes_model_aliases_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let model_aliases = root
        .and_then(|map| map.get(yaml_key("model_aliases")))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_model_aliases(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "modelAliasesJson": serde_json::to_string_pretty(&Value::Object(model_aliases)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_model_aliases_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_model_aliases_config_values(config);
    let model_aliases =
        parse_hermes_model_aliases_json(form_string(form, "modelAliasesJson").or_else(|| {
            current["modelAliasesJson"]
                .as_str()
                .map(ToString::to_string)
        }))?;

    let root = ensure_yaml_object(config)?;
    if model_aliases.is_empty() {
        root.remove(yaml_key("model_aliases"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(model_aliases))
            .map_err(|err| format!("model_aliases 转换 YAML 失败: {err}"))?;
        root.insert(yaml_key("model_aliases"), yaml_value);
    }
    Ok(())
}

fn is_hermes_hook_event(value: &str) -> bool {
    matches!(
        value,
        "pre_tool_call"
            | "post_tool_call"
            | "pre_llm_call"
            | "post_llm_call"
            | "pre_api_request"
            | "post_api_request"
            | "on_session_start"
            | "on_session_end"
            | "on_session_finalize"
            | "on_session_reset"
            | "subagent_stop"
    )
}

fn normalize_hermes_hook_timeout(
    entry: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    if !entry.contains_key("timeout")
        || entry.get("timeout").is_some_and(|value| {
            value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
        })
    {
        entry.remove("timeout");
        return Ok(());
    }
    let value = entry.get("timeout").cloned().unwrap_or(Value::Null);
    let parsed = if let Some(value) = value.as_i64() {
        Some(value)
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).ok()
    } else if let Some(value) = value.as_str() {
        value.trim().parse::<i64>().ok()
    } else {
        None
    };
    let parsed = parsed.ok_or_else(|| format!("{key}.timeout 必须是整数"))?;
    let parsed = validate_hermes_i64(Some(parsed), &format!("{key}.timeout"), 30, 1, 86400)?;
    entry.insert("timeout".to_string(), Value::Number(parsed.into()));
    Ok(())
}

fn validate_hermes_hooks(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err("hooks 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (raw_event, raw_entries) in map {
        let event = raw_event.trim();
        if !is_hermes_hook_event(event) {
            return Err(format!(
                "hooks.{} 事件名不受支持",
                if event.is_empty() {
                    "<empty>"
                } else {
                    raw_event
                }
            ));
        }
        let Some(entries) = raw_entries.as_array() else {
            return Err(format!("hooks.{event} 必须是数组"));
        };
        let mut normalized_entries = Vec::new();
        for (index, raw_entry) in entries.iter().enumerate() {
            let key = format!("hooks.{event}.{index}");
            let Some(config) = raw_entry.as_object() else {
                return Err(format!("{key} 必须是 JSON 对象"));
            };
            let mut entry = config.clone();
            let command = entry
                .get("command")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if command.is_empty() {
                return Err(format!("{key}.command 不能为空"));
            }
            entry.insert("command".to_string(), Value::String(command));
            if let Some(matcher) = entry.get("matcher") {
                let Some(matcher) = matcher.as_str() else {
                    return Err(format!("{key}.matcher 必须是字符串"));
                };
                entry.insert(
                    "matcher".to_string(),
                    Value::String(matcher.trim().to_string()),
                );
            }
            normalize_hermes_hook_timeout(&mut entry, &key)?;
            normalized_entries.push(Value::Object(entry));
        }
        if !normalized_entries.is_empty() {
            normalized.insert(event.to_string(), Value::Array(normalized_entries));
        }
    }
    Ok(normalized)
}

fn parse_hermes_hooks_json(raw: Option<String>) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("hooks JSON 格式错误: {err}"))?;
    validate_hermes_hooks(&value)
}

fn build_hermes_hooks_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let hooks = root
        .and_then(|map| map.get(yaml_key("hooks")))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_hooks(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "hooksAutoAccept": root.and_then(|map| yaml_bool_field(map, "hooks_auto_accept")).unwrap_or(false),
        "hooksJson": serde_json::to_string_pretty(&Value::Object(hooks)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_hooks_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_hooks_config_values(config);
    let hooks = parse_hermes_hooks_json(
        form_string(form, "hooksJson")
            .or_else(|| current["hooksJson"].as_str().map(ToString::to_string)),
    )?;
    let hooks_auto_accept = form_bool(form, "hooksAutoAccept")
        .unwrap_or_else(|| current["hooksAutoAccept"].as_bool().unwrap_or(false));

    let root = ensure_yaml_object(config)?;
    root.insert(
        yaml_key("hooks_auto_accept"),
        serde_yaml::Value::Bool(hooks_auto_accept),
    );
    if hooks.is_empty() {
        root.remove(yaml_key("hooks"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(hooks))
            .map_err(|err| format!("hooks 转换 YAML 失败: {err}"))?;
        root.insert(yaml_key("hooks"), yaml_value);
    }
    Ok(())
}

fn is_hermes_mcp_server_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn normalize_hermes_json_string_array(value: &Value, key: &str) -> Result<Vec<Value>, String> {
    let Some(items) = value.as_array() else {
        return Err(format!("{key} 必须是字符串数组"));
    };
    let mut normalized = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(text) = item.as_str() else {
            return Err(format!("{key}.{index} 必须是字符串"));
        };
        normalized.push(Value::String(text.to_string()));
    }
    Ok(normalized)
}

fn normalize_hermes_json_string_map(
    value: &Value,
    key: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(items) = value.as_object() else {
        return Err(format!("{key} 必须是 JSON 对象"));
    };
    let mut normalized = serde_json::Map::new();
    for (raw_key, raw_value) in items {
        let item_key = raw_key.trim();
        if item_key.is_empty() {
            return Err(format!("{key} 键名不能为空"));
        }
        let Some(text) = raw_value.as_str() else {
            return Err(format!("{key}.{item_key} 必须是字符串"));
        };
        normalized.insert(item_key.to_string(), Value::String(text.to_string()));
    }
    Ok(normalized)
}

fn normalize_hermes_mcp_timeout(
    entry: &mut serde_json::Map<String, Value>,
    field: &str,
    key: &str,
) -> Result<(), String> {
    if !entry.contains_key(field)
        || entry.get(field).is_some_and(|value| {
            value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
        })
    {
        entry.remove(field);
        return Ok(());
    }
    let value = entry.get(field).cloned().unwrap_or(Value::Null);
    let parsed = if let Some(value) = value.as_i64() {
        Some(value)
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).ok()
    } else if let Some(value) = value.as_str() {
        value.trim().parse::<i64>().ok()
    } else {
        None
    };
    let parsed = parsed.ok_or_else(|| format!("{key} 必须是整数"))?;
    let parsed = validate_hermes_i64(Some(parsed), key, 120, 1, 86400)?;
    entry.insert(field.to_string(), Value::Number(parsed.into()));
    Ok(())
}

fn normalize_hermes_mcp_sampling(value: &Value, key: &str) -> Result<Value, String> {
    let Some(config) = value.as_object() else {
        return Err(format!("{key} 必须是 JSON 对象"));
    };
    let mut sampling = config.clone();

    if let Some(enabled) = sampling.get("enabled") {
        if !enabled.is_boolean() {
            return Err(format!("{key}.enabled 必须是布尔值"));
        }
    }

    if sampling.contains_key("model") {
        let empty = sampling.get("model").is_some_and(|value| {
            value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
        });
        if empty {
            sampling.remove("model");
        } else {
            let Some(model) = sampling.get("model").and_then(|value| value.as_str()) else {
                return Err(format!("{key}.model 必须是字符串"));
            };
            sampling.insert("model".to_string(), Value::String(model.trim().to_string()));
        }
    }

    for (field, fallback, min, max) in [
        ("max_tokens_cap", 4096, 1, 1_000_000),
        ("timeout", 30, 1, 86400),
        ("max_rpm", 10, 1, 100000),
        ("max_tool_rounds", 5, 0, 1000),
    ] {
        if let Some(raw) = sampling.get(field).cloned() {
            let parsed = if let Some(value) = raw.as_i64() {
                Some(value)
            } else if let Some(value) = raw.as_u64() {
                i64::try_from(value).ok()
            } else if let Some(value) = raw.as_str() {
                value.trim().parse::<i64>().ok()
            } else {
                None
            };
            let parsed = parsed.ok_or_else(|| format!("{key}.{field} 必须是整数"))?;
            let parsed =
                validate_hermes_i64(Some(parsed), &format!("{key}.{field}"), fallback, min, max)?;
            sampling.insert(field.to_string(), Value::Number(parsed.into()));
        }
    }

    if let Some(allowed_models) = sampling.get("allowed_models") {
        let allowed_models =
            normalize_hermes_json_string_array(allowed_models, &format!("{key}.allowed_models"))?;
        sampling.insert("allowed_models".to_string(), Value::Array(allowed_models));
    }

    if sampling.contains_key("log_level") {
        let empty = sampling.get("log_level").is_some_and(|value| {
            value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
        });
        if empty {
            sampling.remove("log_level");
        } else {
            let Some(level) = sampling.get("log_level").and_then(|value| value.as_str()) else {
                return Err(format!("{key}.log_level 必须是字符串"));
            };
            let level = level.trim().to_ascii_lowercase();
            if !matches!(level.as_str(), "debug" | "info" | "warning" | "error") {
                return Err(format!(
                    "{key}.log_level 必须是 debug、info、warning 或 error"
                ));
            }
            sampling.insert("log_level".to_string(), Value::String(level));
        }
    }

    Ok(Value::Object(sampling))
}

fn validate_hermes_mcp_servers(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err("mcp_servers 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (raw_name, raw_config) in map {
        let name = raw_name.trim();
        if !is_hermes_mcp_server_name(name) {
            return Err(format!(
                "mcp_servers.{} 服务名只能包含字母、数字、下划线、点和短横线",
                if name.is_empty() { "<empty>" } else { raw_name }
            ));
        }
        let Some(config) = raw_config.as_object() else {
            return Err(format!("mcp_servers.{name} 必须是 JSON 对象"));
        };
        let mut entry = config.clone();
        let command = entry
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let url = entry
            .get("url")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let command_is_empty = command.is_empty();
        let url_is_empty = url.is_empty();
        if entry.contains_key("command") {
            if command_is_empty {
                return Err(format!("mcp_servers.{name}.command 不能为空"));
            }
            entry.insert("command".to_string(), Value::String(command));
        }
        if entry.contains_key("url") {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(format!(
                    "mcp_servers.{name}.url 必须以 http:// 或 https:// 开头"
                ));
            }
            entry.insert("url".to_string(), Value::String(url));
        }
        if command_is_empty && url_is_empty {
            return Err(format!("mcp_servers.{name} 需要 command 或 url"));
        }
        if let Some(args) = entry.get("args") {
            let args =
                normalize_hermes_json_string_array(args, &format!("mcp_servers.{name}.args"))?;
            entry.insert("args".to_string(), Value::Array(args));
        }
        if let Some(env) = entry.get("env") {
            let env = normalize_hermes_json_string_map(env, &format!("mcp_servers.{name}.env"))?;
            entry.insert("env".to_string(), Value::Object(env));
        }
        if let Some(headers) = entry.get("headers") {
            let headers =
                normalize_hermes_json_string_map(headers, &format!("mcp_servers.{name}.headers"))?;
            entry.insert("headers".to_string(), Value::Object(headers));
        }
        normalize_hermes_mcp_timeout(
            &mut entry,
            "timeout",
            &format!("mcp_servers.{name}.timeout"),
        )?;
        normalize_hermes_mcp_timeout(
            &mut entry,
            "connect_timeout",
            &format!("mcp_servers.{name}.connect_timeout"),
        )?;
        if let Some(sampling) = entry.get("sampling").cloned() {
            let sampling =
                normalize_hermes_mcp_sampling(&sampling, &format!("mcp_servers.{name}.sampling"))?;
            entry.insert("sampling".to_string(), sampling);
        }
        normalized.insert(name.to_string(), Value::Object(entry));
    }
    Ok(normalized)
}

fn parse_hermes_mcp_servers_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("mcp_servers JSON 格式错误: {err}"))?;
    validate_hermes_mcp_servers(&value)
}

fn build_hermes_mcp_servers_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let mcp_servers = root
        .and_then(|map| map.get(yaml_key("mcp_servers")))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_mcp_servers(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "mcpServersJson": serde_json::to_string_pretty(&Value::Object(mcp_servers)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_mcp_servers_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_mcp_servers_config_values(config);
    let mcp_servers = parse_hermes_mcp_servers_json(
        form_string(form, "mcpServersJson")
            .or_else(|| current["mcpServersJson"].as_str().map(ToString::to_string)),
    )?;

    let root = ensure_yaml_object(config)?;
    if mcp_servers.is_empty() {
        root.remove(yaml_key("mcp_servers"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(mcp_servers))
            .map_err(|err| format!("mcp_servers 转换 YAML 失败: {err}"))?;
        root.insert(yaml_key("mcp_servers"), yaml_value);
    }
    Ok(())
}

fn is_hermes_provider_override_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn is_hermes_provider_model_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && !value.split('/').any(|part| part == "..")
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | ':' | '@' | '+' | '-')
        })
}

fn normalize_hermes_provider_timeout(
    entry: &mut serde_json::Map<String, Value>,
    field: &str,
    key: &str,
) -> Result<(), String> {
    if !entry.contains_key(field) || entry.get(field).is_some_and(|value| value.is_null()) {
        entry.remove(field);
        return Ok(());
    }
    let value = entry.get(field).cloned().unwrap_or(Value::Null);
    let parsed = if let Some(value) = value.as_i64() {
        Some(value)
    } else if let Some(value) = value.as_u64() {
        i64::try_from(value).ok()
    } else if let Some(value) = value.as_str() {
        let text = value.trim();
        if text.is_empty() {
            None
        } else {
            text.parse::<i64>().ok()
        }
    } else {
        None
    };
    let parsed = parsed.ok_or_else(|| format!("{key} 必须是整数"))?;
    let parsed = validate_hermes_i64(Some(parsed), key, 300, 1, 86400)?;
    entry.insert(field.to_string(), Value::Number(parsed.into()));
    Ok(())
}

fn validate_hermes_provider_model_overrides(
    value: &Value,
    key: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err(format!("{key} 必须是 JSON 对象"));
    };
    let mut normalized = serde_json::Map::new();
    for (raw_model, raw_config) in map {
        let model = raw_model.trim();
        if !is_hermes_provider_model_name(model) {
            return Err(format!(
                "{key}.{model} 模型名只能包含字母、数字、下划线、点、斜杠、冒号、@、加号和短横线"
            ));
        }
        let Some(config) = raw_config.as_object() else {
            return Err(format!("{key}.{model} 必须是 JSON 对象"));
        };
        let mut entry = config.clone();
        normalize_hermes_provider_timeout(
            &mut entry,
            "timeout_seconds",
            &format!("{key}.{model}.timeout_seconds"),
        )?;
        normalize_hermes_provider_timeout(
            &mut entry,
            "stale_timeout_seconds",
            &format!("{key}.{model}.stale_timeout_seconds"),
        )?;
        normalized.insert(model.to_string(), Value::Object(entry));
    }
    Ok(normalized)
}

fn validate_hermes_provider_overrides(
    value: &Value,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err("providers 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (raw_provider, raw_config) in map {
        let provider = raw_provider.trim().to_ascii_lowercase();
        if !is_hermes_provider_override_name(&provider) {
            return Err(format!(
                "providers.{raw_provider} provider 名只能包含字母、数字、下划线、点和短横线"
            ));
        }
        let Some(config) = raw_config.as_object() else {
            return Err(format!("providers.{provider} 必须是 JSON 对象"));
        };
        let mut entry = config.clone();
        normalize_hermes_provider_timeout(
            &mut entry,
            "request_timeout_seconds",
            &format!("providers.{provider}.request_timeout_seconds"),
        )?;
        normalize_hermes_provider_timeout(
            &mut entry,
            "stale_timeout_seconds",
            &format!("providers.{provider}.stale_timeout_seconds"),
        )?;
        if let Some(models) = entry.get("models") {
            let models = validate_hermes_provider_model_overrides(
                models,
                &format!("providers.{provider}.models"),
            )?;
            entry.insert("models".to_string(), Value::Object(models));
        }
        normalized.insert(provider, Value::Object(entry));
    }
    Ok(normalized)
}

fn parse_hermes_provider_overrides_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("providers JSON 格式错误: {err}"))?;
    validate_hermes_provider_overrides(&value)
}

fn build_hermes_provider_overrides_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let providers = root
        .and_then(|map| map.get(yaml_key("providers")))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_provider_overrides(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "providerOverridesJson": serde_json::to_string_pretty(&Value::Object(providers)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_provider_overrides_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_provider_overrides_config_values(config);
    let providers = parse_hermes_provider_overrides_json(
        form_string(form, "providerOverridesJson").or_else(|| {
            current["providerOverridesJson"]
                .as_str()
                .map(ToString::to_string)
        }),
    )?;

    let root = ensure_yaml_object(config)?;
    if providers.is_empty() {
        root.remove(yaml_key("providers"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(providers))
            .map_err(|err| format!("providers 转换 YAML 失败: {err}"))?;
        root.insert(yaml_key("providers"), yaml_value);
    }
    Ok(())
}

fn normalize_hermes_toolset_list(raw: Option<String>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for item in normalize_hermes_multiline_list(raw) {
        if !item
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(
                "agent.disabled_toolsets 只能包含字母、数字、下划线、点和短横线".to_string(),
            );
        }
        if !normalized.iter().any(|existing| existing == &item) {
            normalized.push(item);
        }
    }
    Ok(normalized)
}

fn default_hermes_platform_toolsets() -> serde_json::Map<String, Value> {
    let defaults = [
        ("cli", "hermes-cli"),
        ("telegram", "hermes-telegram"),
        ("discord", "hermes-discord"),
        ("whatsapp", "hermes-whatsapp"),
        ("slack", "hermes-slack"),
        ("signal", "hermes-signal"),
        ("homeassistant", "hermes-homeassistant"),
        ("qqbot", "hermes-qqbot"),
        ("yuanbao", "hermes-yuanbao"),
        ("teams", "hermes-teams"),
        ("google_chat", "hermes-google_chat"),
    ];
    defaults
        .into_iter()
        .map(|(platform, toolset)| {
            (
                platform.to_string(),
                Value::Array(vec![Value::String(toolset.to_string())]),
            )
        })
        .collect()
}

fn normalize_hermes_toolset_values(value: &Value, field_name: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(format!("{field_name} 必须是工具集数组"));
    };
    let mut normalized = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(format!("{field_name} 只能包含字符串工具集"));
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if !text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(format!(
                "{field_name} 只能包含字母、数字、下划线、点和短横线"
            ));
        }
        if !normalized.iter().any(|existing| existing == text) {
            normalized.push(text.to_string());
        }
    }
    if normalized.is_empty() {
        return Err(format!("{field_name} 至少需要一个工具集"));
    }
    Ok(normalized)
}

fn validate_hermes_platform_toolsets(
    value: &Value,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err("platform_toolsets 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (platform, toolsets) in map {
        if platform.is_empty()
            || !platform
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(format!(
                "platform_toolsets.{platform} 平台名只能包含字母、数字、下划线、点和短横线"
            ));
        }
        let values =
            normalize_hermes_toolset_values(toolsets, &format!("platform_toolsets.{platform}"))?;
        normalized.insert(
            platform.clone(),
            Value::Array(values.into_iter().map(Value::String).collect()),
        );
    }
    Ok(normalized)
}

fn parse_hermes_platform_toolsets_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("platform_toolsets JSON 格式错误: {err}"))?;
    validate_hermes_platform_toolsets(&value)
}

fn build_hermes_agent_toolsets_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let disabled_toolsets = root
        .and_then(|map| yaml_get_mapping(map, "agent"))
        .map(|map| yaml_string_sequence_field(map, "disabled_toolsets").join("\n"))
        .unwrap_or_default();

    serde_json::json!({
        "disabledToolsets": disabled_toolsets,
    })
}

fn build_hermes_platform_toolsets_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let platform_toolsets = root
        .and_then(|map| map.get(yaml_key("platform_toolsets")))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_platform_toolsets(&value).ok())
        .unwrap_or_else(default_hermes_platform_toolsets);

    serde_json::json!({
        "platformToolsetsJson": serde_json::to_string_pretty(&Value::Object(platform_toolsets)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_platform_toolsets_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_platform_toolsets_config_values(config);
    let platform_toolsets = parse_hermes_platform_toolsets_json(
        form_string(form, "platformToolsetsJson").or_else(|| {
            current["platformToolsetsJson"]
                .as_str()
                .map(ToString::to_string)
        }),
    )?;
    let yaml_value = serde_yaml::to_value(Value::Object(platform_toolsets))
        .map_err(|err| format!("platform_toolsets 转换 YAML 失败: {err}"))?;

    let root = ensure_yaml_object(config)?;
    root.insert(yaml_key("platform_toolsets"), yaml_value);
    Ok(())
}

fn merge_hermes_agent_toolsets_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_agent_toolsets_config_values(config);
    let disabled_toolsets =
        normalize_hermes_toolset_list(form_string(form, "disabledToolsets").or_else(|| {
            current["disabledToolsets"]
                .as_str()
                .map(ToString::to_string)
        }))?;

    let root = ensure_yaml_object(config)?;
    let agent = yaml_child_object(root, "agent")?;
    agent.insert(
        yaml_key("disabled_toolsets"),
        serde_yaml::Value::Sequence(
            disabled_toolsets
                .into_iter()
                .map(serde_yaml::Value::String)
                .collect(),
        ),
    );
    Ok(())
}

fn normalize_hermes_image_input_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "auto".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "auto" | "native" | "text") {
        return Ok(mode);
    }
    if strict {
        Err("agent.image_input_mode 必须是 auto、native 或 text".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_reasoning_effort(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let effort = value.unwrap_or_default().trim().to_ascii_lowercase();
    let effort = if effort.is_empty() {
        "medium".to_string()
    } else {
        effort
    };
    if matches!(
        effort.as_str(),
        "xhigh" | "high" | "medium" | "low" | "minimal" | "none"
    ) {
        return Ok(effort);
    }
    if strict {
        Err("agent.reasoning_effort 必须是 xhigh、high、medium、low、minimal 或 none".to_string())
    } else {
        Ok("medium".to_string())
    }
}

fn validate_hermes_personalities(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let Some(map) = value.as_object() else {
        return Err("agent.personalities 必须是 JSON 对象".to_string());
    };
    let mut normalized = serde_json::Map::new();
    for (raw_name, raw_prompt) in map {
        let name = raw_name.trim();
        if name.is_empty() {
            return Err("agent.personalities 名称不能为空".to_string());
        }
        if !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return Err(format!(
                "agent.personalities.{name} 名称只能包含字母、数字、下划线、点和短横线"
            ));
        }
        let Some(prompt) = raw_prompt.as_str() else {
            return Err(format!("agent.personalities.{name} 必须是字符串"));
        };
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(format!("agent.personalities.{name} 不能为空"));
        }
        normalized.insert(name.to_string(), Value::String(prompt.to_string()));
    }
    Ok(normalized)
}

fn parse_hermes_personalities_json(
    raw: Option<String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("agent.personalities JSON 格式错误: {err}"))?;
    validate_hermes_personalities(&value)
}

fn build_hermes_agent_runtime_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let agent = root.and_then(|map| yaml_get_mapping(map, "agent"));

    let image_input_mode = normalize_hermes_image_input_mode(
        agent.and_then(|map| yaml_string_field(map, "image_input_mode")),
        false,
    )
    .unwrap_or_else(|_| "auto".to_string());
    let reasoning_effort = normalize_hermes_reasoning_effort(
        agent.and_then(|map| yaml_string_field(map, "reasoning_effort")),
        false,
    )
    .unwrap_or_else(|_| "medium".to_string());
    let personalities = agent
        .and_then(|map| yaml_get(map, "personalities"))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_personalities(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "agentMaxTurns": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_turns"), 90, 1, 10000)).unwrap_or(90),
        "gatewayTimeout": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "gateway_timeout"), 1800, 0, 604800)).unwrap_or(1800),
        "restartDrainTimeout": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "restart_drain_timeout"), 180, 0, 86400)).unwrap_or(180),
        "apiMaxRetries": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "api_max_retries"), 3, 1, 20)).unwrap_or(3),
        "gatewayTimeoutWarning": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "gateway_timeout_warning"), 900, 0, 604800)).unwrap_or(900),
        "clarifyTimeout": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "clarify_timeout"), 600, 0, 86400)).unwrap_or(600),
        "gatewayNotifyInterval": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "gateway_notify_interval"), 180, 0, 86400)).unwrap_or(180),
        "gatewayAutoContinueFreshness": agent.map(|map| bounded_hermes_i64(yaml_i64_field(map, "gateway_auto_continue_freshness"), 3600, 0, 604800)).unwrap_or(3600),
        "imageInputMode": image_input_mode,
        "agentVerbose": agent.and_then(|map| yaml_bool_field(map, "verbose")).unwrap_or(false),
        "reasoningEffort": reasoning_effort,
        "personalitiesJson": serde_json::to_string_pretty(&Value::Object(personalities)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn agent_runtime_i64_value(
    form: &Value,
    current: &Value,
    form_key: &str,
    default_value: i64,
) -> Option<i64> {
    if form.get(form_key).is_some() {
        form_i64(form, form_key)
    } else {
        Some(current[form_key].as_i64().unwrap_or(default_value))
    }
}

fn merge_hermes_agent_runtime_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_agent_runtime_config_values(config);
    let agent_max_turns = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "agentMaxTurns", 90),
        "agent.max_turns",
        90,
        1,
        10000,
    )?;
    let gateway_timeout = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "gatewayTimeout", 1800),
        "agent.gateway_timeout",
        1800,
        0,
        604800,
    )?;
    let restart_drain_timeout = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "restartDrainTimeout", 180),
        "agent.restart_drain_timeout",
        180,
        0,
        86400,
    )?;
    let api_max_retries = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "apiMaxRetries", 3),
        "agent.api_max_retries",
        3,
        1,
        20,
    )?;
    let gateway_timeout_warning = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "gatewayTimeoutWarning", 900),
        "agent.gateway_timeout_warning",
        900,
        0,
        604800,
    )?;
    let clarify_timeout = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "clarifyTimeout", 600),
        "agent.clarify_timeout",
        600,
        0,
        86400,
    )?;
    let gateway_notify_interval = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "gatewayNotifyInterval", 180),
        "agent.gateway_notify_interval",
        180,
        0,
        86400,
    )?;
    let gateway_auto_continue_freshness = validate_hermes_i64(
        agent_runtime_i64_value(form, &current, "gatewayAutoContinueFreshness", 3600),
        "agent.gateway_auto_continue_freshness",
        3600,
        0,
        604800,
    )?;
    let image_input_mode = normalize_hermes_image_input_mode(
        if form.get("imageInputMode").is_some() {
            form_string(form, "imageInputMode")
        } else {
            current["imageInputMode"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let agent_verbose = form_bool(form, "agentVerbose")
        .unwrap_or_else(|| current["agentVerbose"].as_bool().unwrap_or(false));
    let reasoning_effort = normalize_hermes_reasoning_effort(
        if form.get("reasoningEffort").is_some() {
            form_string(form, "reasoningEffort")
        } else {
            current["reasoningEffort"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let personalities =
        parse_hermes_personalities_json(form_string(form, "personalitiesJson").or_else(|| {
            current["personalitiesJson"]
                .as_str()
                .map(ToString::to_string)
        }))?;

    let root = ensure_yaml_object(config)?;
    let agent = yaml_child_object(root, "agent")?;
    agent.insert(
        yaml_key("max_turns"),
        serde_yaml::Value::Number(agent_max_turns.into()),
    );
    agent.insert(
        yaml_key("gateway_timeout"),
        serde_yaml::Value::Number(gateway_timeout.into()),
    );
    agent.insert(
        yaml_key("restart_drain_timeout"),
        serde_yaml::Value::Number(restart_drain_timeout.into()),
    );
    agent.insert(
        yaml_key("api_max_retries"),
        serde_yaml::Value::Number(api_max_retries.into()),
    );
    agent.insert(
        yaml_key("gateway_timeout_warning"),
        serde_yaml::Value::Number(gateway_timeout_warning.into()),
    );
    agent.insert(
        yaml_key("clarify_timeout"),
        serde_yaml::Value::Number(clarify_timeout.into()),
    );
    agent.insert(
        yaml_key("gateway_notify_interval"),
        serde_yaml::Value::Number(gateway_notify_interval.into()),
    );
    agent.insert(
        yaml_key("gateway_auto_continue_freshness"),
        serde_yaml::Value::Number(gateway_auto_continue_freshness.into()),
    );
    agent.insert(
        yaml_key("image_input_mode"),
        serde_yaml::Value::String(image_input_mode),
    );
    agent.insert(yaml_key("verbose"), serde_yaml::Value::Bool(agent_verbose));
    agent.insert(
        yaml_key("reasoning_effort"),
        serde_yaml::Value::String(reasoning_effort),
    );
    if personalities.is_empty() {
        agent.remove(yaml_key("personalities"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(personalities))
            .map_err(|err| format!("agent.personalities 转换 YAML 失败: {err}"))?;
        agent.insert(yaml_key("personalities"), yaml_value);
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
    let install_policy_json = security
        .and_then(|map| yaml_get(map, "installPolicy"))
        .and_then(|value| serde_json::to_value(value).ok())
        .filter(|value| value.is_object())
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_default();

    serde_json::json!({
        "tirithEnabled": tirith_enabled,
        "tirithPath": tirith_path,
        "tirithTimeout": tirith_timeout,
        "tirithFailOpen": tirith_fail_open,
        "installPolicyJson": install_policy_json,
    })
}

fn parse_hermes_install_policy_json(
    raw: Option<String>,
) -> Result<Option<serde_yaml::Value>, String> {
    let text = raw.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("security.installPolicy JSON 格式错误: {err}"))?;
    if !value.is_object() {
        return Err("security.installPolicy 必须是 JSON 对象".to_string());
    }
    serde_yaml::to_value(value)
        .map(Some)
        .map_err(|err| format!("security.installPolicy 转换 YAML 失败: {err}"))
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
    let install_policy =
        parse_hermes_install_policy_json(if form.get("installPolicyJson").is_some() {
            form_string(form, "installPolicyJson")
        } else {
            current["installPolicyJson"]
                .as_str()
                .map(ToString::to_string)
        })?;
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
    if let Some(install_policy) = install_policy {
        security.insert(yaml_key("installPolicy"), install_policy);
    } else {
        security.remove(yaml_key("installPolicy"));
    }
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

const HERMES_DISPLAY_LANGUAGE_VALUES: &[&str] = &[
    "en", "zh", "zh-hant", "ja", "de", "es", "fr", "tr", "uk", "af", "ko", "it", "ga", "pt", "ru",
    "hu",
];

const HERMES_DISPLAY_BUSY_INPUT_MODES: &[&str] = &["interrupt", "queue", "steer"];
const HERMES_DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS: &[&str] = &["off", "result", "error", "all"];
const HERMES_DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES: &[&str] = &["render", "strip", "raw"];
const HERMES_TUI_STATUS_INDICATORS: &[&str] = &["kaomoji", "emoji", "unicode", "ascii"];
const HERMES_COPY_SHORTCUTS: &[&str] = &["auto", "ctrl_c", "ctrl_shift_c", "disabled"];
const HERMES_DISPLAY_SKINS: &[&str] = &[
    "default",
    "ares",
    "mono",
    "slate",
    "daylight",
    "warm-lightmode",
    "poseidon",
    "sisyphus",
    "charizard",
];

const HERMES_RUNTIME_FOOTER_FIELDS: &[&str] =
    &["model", "context_pct", "cwd", "duration", "tokens", "cost"];

fn normalize_hermes_display_language(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let language = value.unwrap_or_default().trim().to_ascii_lowercase();
    let language = if language.is_empty() {
        "en".to_string()
    } else {
        language
    };
    if HERMES_DISPLAY_LANGUAGE_VALUES.contains(&language.as_str()) {
        Ok(language)
    } else if strict {
        Err("display.language 不在支持列表中".to_string())
    } else {
        Ok("en".to_string())
    }
}

fn normalize_hermes_display_skin(value: Option<String>, strict: bool) -> Result<String, String> {
    let skin = value.unwrap_or_default().trim().to_ascii_lowercase();
    let skin = if skin.is_empty() {
        "default".to_string()
    } else {
        skin
    };
    if HERMES_DISPLAY_SKINS.contains(&skin.as_str()) {
        Ok(skin)
    } else if strict {
        Err("display.skin 必须是内置皮肤 default、ares、mono、slate、daylight、warm-lightmode、poseidon、sisyphus 或 charizard".to_string())
    } else {
        Ok("default".to_string())
    }
}

fn normalize_hermes_display_resume(value: Option<String>, strict: bool) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "full".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "full" | "minimal") {
        Ok(mode)
    } else if strict {
        Err("display.resume_display 必须是 full 或 minimal".to_string())
    } else {
        Ok("full".to_string())
    }
}

fn normalize_hermes_display_busy_input_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "interrupt".to_string()
    } else {
        mode
    };
    if HERMES_DISPLAY_BUSY_INPUT_MODES.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("display.busy_input_mode 必须是 interrupt、queue 或 steer".to_string())
    } else {
        Ok("interrupt".to_string())
    }
}

fn normalize_hermes_display_background_process_notifications(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "all".to_string()
    } else {
        mode
    };
    if HERMES_DISPLAY_BACKGROUND_PROCESS_NOTIFICATIONS.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("display.background_process_notifications 必须是 off、result、error 或 all".to_string())
    } else {
        Ok("all".to_string())
    }
}

fn normalize_hermes_display_final_response_markdown(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "strip".to_string()
    } else {
        mode
    };
    if HERMES_DISPLAY_FINAL_RESPONSE_MARKDOWN_VALUES.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("display.final_response_markdown 必须是 render、strip 或 raw".to_string())
    } else {
        Ok("strip".to_string())
    }
}

fn normalize_hermes_tui_status_indicator(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "kaomoji".to_string()
    } else {
        mode
    };
    if HERMES_TUI_STATUS_INDICATORS.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("display.tui_status_indicator 必须是 kaomoji、emoji、unicode 或 ascii".to_string())
    } else {
        Ok("kaomoji".to_string())
    }
}

fn normalize_hermes_copy_shortcut(value: Option<String>, strict: bool) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "auto".to_string()
    } else {
        mode
    };
    if HERMES_COPY_SHORTCUTS.contains(&mode.as_str()) {
        Ok(mode)
    } else if strict {
        Err("display.copy_shortcut 必须是 auto、ctrl_c、ctrl_shift_c 或 disabled".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_runtime_footer_fields_text(
    value: Option<String>,
    strict: bool,
) -> Result<Vec<String>, String> {
    let fields = match value {
        Some(value) => {
            let text = value.trim().to_string();
            if text.contains('\n') || text.contains(',') {
                text.split(['\n', ','])
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            } else if text.is_empty() {
                Vec::new()
            } else {
                vec![text]
            }
        }
        None => Vec::new(),
    };
    let fields = if fields.is_empty() {
        vec![
            "model".to_string(),
            "context_pct".to_string(),
            "cwd".to_string(),
        ]
    } else {
        fields
    };
    if let Some(invalid) = fields
        .iter()
        .find(|item| !HERMES_RUNTIME_FOOTER_FIELDS.contains(&item.as_str()))
    {
        if strict {
            return Err(format!(
                "display.runtime_footer.fields 包含不支持的字段: {invalid}"
            ));
        }
        return Ok(vec![
            "model".to_string(),
            "context_pct".to_string(),
            "cwd".to_string(),
        ]);
    }
    Ok(fields)
}

fn normalize_hermes_runtime_footer_fields(
    value: Option<&serde_yaml::Value>,
    strict: bool,
) -> Result<Vec<String>, String> {
    let fields = match value {
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        Some(serde_yaml::Value::String(text)) => text
            .split(['\n', ','])
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    normalize_hermes_runtime_footer_fields_text(
        if fields.is_empty() {
            None
        } else {
            Some(fields.join("\n"))
        },
        strict,
    )
}

fn build_hermes_display_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let display = root.and_then(|map| yaml_get_mapping(map, "display"));
    let dashboard = root.and_then(|map| yaml_get_mapping(map, "dashboard"));
    let runtime_footer = display.and_then(|map| yaml_get_mapping(map, "runtime_footer"));
    let user_message_preview =
        display.and_then(|map| yaml_get_mapping(map, "user_message_preview"));
    let runtime_footer_fields = normalize_hermes_runtime_footer_fields(
        runtime_footer.and_then(|map| yaml_get(map, "fields")),
        false,
    )
    .unwrap_or_else(|_| {
        vec![
            "model".to_string(),
            "context_pct".to_string(),
            "cwd".to_string(),
        ]
    });

    serde_json::json!({
        "displayCompact": display.and_then(|map| yaml_bool_field(map, "compact")).unwrap_or(false),
        "displaySkin": normalize_hermes_display_skin(
            display.and_then(|map| yaml_string_field(map, "skin")),
            false,
        ).unwrap_or_else(|_| "default".to_string()),
        "displayToolPrefix": normalize_hermes_display_tool_prefix(
            display.and_then(|map| yaml_string_field(map, "tool_prefix")),
            false,
        ).unwrap_or_else(|_| "┊".to_string()),
        "displayToolProgress": normalize_hermes_display_tool_progress(
            display.and_then(|map| yaml_string_field(map, "tool_progress")),
            false,
            "display.tool_progress",
        ).unwrap_or_else(|_| "all".to_string()),
        "displayShowReasoning": display.and_then(|map| yaml_bool_field(map, "show_reasoning")).unwrap_or(false),
        "displayToolPreviewLength": display
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "tool_preview_length"), 0, 0, 200000))
            .unwrap_or(0),
        "displayCleanupProgress": display.and_then(|map| yaml_bool_field(map, "cleanup_progress")).unwrap_or(false),
        "displayToolProgressCommand": display.and_then(|map| yaml_bool_field(map, "tool_progress_command")).unwrap_or(false),
        "displayInterimAssistantMessages": display.and_then(|map| yaml_bool_field(map, "interim_assistant_messages")).unwrap_or(true),
        "displayRuntimeFooterEnabled": runtime_footer.and_then(|map| yaml_bool_field(map, "enabled")).unwrap_or(false),
        "displayRuntimeFooterFields": runtime_footer_fields.join("\n"),
        "displayFileMutationVerifier": display.and_then(|map| yaml_bool_field(map, "file_mutation_verifier")).unwrap_or(true),
        "displayShowCost": display.and_then(|map| yaml_bool_field(map, "show_cost")).unwrap_or(false),
        "dashboardShowTokenAnalytics": dashboard.and_then(|map| yaml_bool_field(map, "show_token_analytics")).unwrap_or(false),
        "displayLanguage": normalize_hermes_display_language(
            display.and_then(|map| yaml_string_field(map, "language")),
            false,
        ).unwrap_or_else(|_| "en".to_string()),
        "displayResumeDisplay": normalize_hermes_display_resume(
            display.and_then(|map| yaml_string_field(map, "resume_display")),
            false,
        ).unwrap_or_else(|_| "full".to_string()),
        "displayBusyInputMode": normalize_hermes_display_busy_input_mode(
            display.and_then(|map| yaml_string_field(map, "busy_input_mode")),
            false,
        ).unwrap_or_else(|_| "interrupt".to_string()),
        "displayBackgroundProcessNotifications": normalize_hermes_display_background_process_notifications(
            display.and_then(|map| yaml_string_field(map, "background_process_notifications")),
            false,
        ).unwrap_or_else(|_| "all".to_string()),
        "displayFinalResponseMarkdown": normalize_hermes_display_final_response_markdown(
            display.and_then(|map| yaml_string_field(map, "final_response_markdown")),
            false,
        ).unwrap_or_else(|_| "strip".to_string()),
        "displayTimestamps": display.and_then(|map| yaml_bool_field(map, "timestamps")).unwrap_or(false),
        "displayBellOnComplete": display.and_then(|map| yaml_bool_field(map, "bell_on_complete")).unwrap_or(false),
        "displayPersistentOutput": display.and_then(|map| yaml_bool_field(map, "persistent_output")).unwrap_or(true),
        "displayPersistentOutputMaxLines": display
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "persistent_output_max_lines"), 200, 0, 100000))
            .unwrap_or(200),
        "displayInlineDiffs": display.and_then(|map| yaml_bool_field(map, "inline_diffs")).unwrap_or(true),
        "displayTuiAutoResumeRecent": display.and_then(|map| yaml_bool_field(map, "tui_auto_resume_recent")).unwrap_or(false),
        "displayTuiStatusIndicator": normalize_hermes_tui_status_indicator(
            display.and_then(|map| yaml_string_field(map, "tui_status_indicator")),
            false,
        ).unwrap_or_else(|_| "kaomoji".to_string()),
        "displayUserMessagePreviewFirstLines": user_message_preview
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "first_lines"), 2, 1, 100))
            .unwrap_or(2),
        "displayUserMessagePreviewLastLines": user_message_preview
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "last_lines"), 2, 0, 100))
            .unwrap_or(2),
        "displayEphemeralSystemTtl": display
            .map(|map| bounded_hermes_i64(yaml_i64_field(map, "ephemeral_system_ttl"), 0, 0, 86400))
            .unwrap_or(0),
        "displayCopyShortcut": normalize_hermes_copy_shortcut(
            display.and_then(|map| yaml_string_field(map, "copy_shortcut")),
            false,
        ).unwrap_or_else(|_| "auto".to_string()),
    })
}

fn merge_hermes_display_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_display_config_values(config);
    let tool_progress = normalize_hermes_display_tool_progress(
        form_string(form, "displayToolProgress").or_else(|| {
            current["displayToolProgress"]
                .as_str()
                .map(ToString::to_string)
        }),
        true,
        "display.tool_progress",
    )?;
    let runtime_footer_fields = normalize_hermes_runtime_footer_fields_text(
        form.get("displayRuntimeFooterFields")
            .and_then(|value| value.as_str().map(ToString::to_string))
            .or_else(|| {
                current["displayRuntimeFooterFields"]
                    .as_str()
                    .map(ToString::to_string)
            }),
        true,
    )?;
    let final_response_markdown = normalize_hermes_display_final_response_markdown(
        form_string(form, "displayFinalResponseMarkdown").or_else(|| {
            current["displayFinalResponseMarkdown"]
                .as_str()
                .map(ToString::to_string)
        }),
        true,
    )?;
    let persistent_output_max_lines = validate_hermes_i64(
        form_i64(form, "displayPersistentOutputMaxLines")
            .or_else(|| current["displayPersistentOutputMaxLines"].as_i64()),
        "display.persistent_output_max_lines",
        200,
        0,
        100000,
    )?;
    let user_message_preview_first_lines = validate_hermes_i64(
        form_i64(form, "displayUserMessagePreviewFirstLines")
            .or_else(|| current["displayUserMessagePreviewFirstLines"].as_i64()),
        "display.user_message_preview.first_lines",
        2,
        1,
        100,
    )?;
    let user_message_preview_last_lines = validate_hermes_i64(
        form_i64(form, "displayUserMessagePreviewLastLines")
            .or_else(|| current["displayUserMessagePreviewLastLines"].as_i64()),
        "display.user_message_preview.last_lines",
        2,
        0,
        100,
    )?;
    let ephemeral_system_ttl = validate_hermes_i64(
        form_i64(form, "displayEphemeralSystemTtl")
            .or_else(|| current["displayEphemeralSystemTtl"].as_i64()),
        "display.ephemeral_system_ttl",
        0,
        0,
        86400,
    )?;
    let tool_preview_length = validate_hermes_i64(
        form_i64(form, "displayToolPreviewLength")
            .or_else(|| current["displayToolPreviewLength"].as_i64()),
        "display.tool_preview_length",
        0,
        0,
        200000,
    )?;

    let display = yaml_child_object(ensure_yaml_object(config)?, "display")?;
    display.insert(
        yaml_key("compact"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayCompact")
                .unwrap_or_else(|| current["displayCompact"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("skin"),
        serde_yaml::Value::String(normalize_hermes_display_skin(
            form_string(form, "displaySkin")
                .or_else(|| current["displaySkin"].as_str().map(ToString::to_string)),
            true,
        )?),
    );
    display.insert(
        yaml_key("tool_prefix"),
        serde_yaml::Value::String(normalize_hermes_display_tool_prefix(
            form_string(form, "displayToolPrefix").or_else(|| {
                current["displayToolPrefix"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    display.insert(
        yaml_key("tool_progress"),
        serde_yaml::Value::String(tool_progress),
    );
    display.insert(
        yaml_key("show_reasoning"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayShowReasoning")
                .unwrap_or_else(|| current["displayShowReasoning"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("tool_preview_length"),
        serde_yaml::Value::Number(serde_yaml::Number::from(tool_preview_length)),
    );
    display.insert(
        yaml_key("cleanup_progress"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayCleanupProgress")
                .unwrap_or_else(|| current["displayCleanupProgress"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("tool_progress_command"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayToolProgressCommand").unwrap_or_else(|| {
                current["displayToolProgressCommand"]
                    .as_bool()
                    .unwrap_or(false)
            }),
        ),
    );
    display.insert(
        yaml_key("interim_assistant_messages"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayInterimAssistantMessages").unwrap_or_else(|| {
                current["displayInterimAssistantMessages"]
                    .as_bool()
                    .unwrap_or(true)
            }),
        ),
    );
    display.insert(
        yaml_key("file_mutation_verifier"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayFileMutationVerifier").unwrap_or_else(|| {
                current["displayFileMutationVerifier"]
                    .as_bool()
                    .unwrap_or(true)
            }),
        ),
    );
    display.insert(
        yaml_key("show_cost"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayShowCost")
                .unwrap_or_else(|| current["displayShowCost"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("language"),
        serde_yaml::Value::String(normalize_hermes_display_language(
            form_string(form, "displayLanguage")
                .or_else(|| current["displayLanguage"].as_str().map(ToString::to_string)),
            true,
        )?),
    );
    display.insert(
        yaml_key("resume_display"),
        serde_yaml::Value::String(normalize_hermes_display_resume(
            form_string(form, "displayResumeDisplay").or_else(|| {
                current["displayResumeDisplay"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    display.insert(
        yaml_key("busy_input_mode"),
        serde_yaml::Value::String(normalize_hermes_display_busy_input_mode(
            form_string(form, "displayBusyInputMode").or_else(|| {
                current["displayBusyInputMode"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    display.insert(
        yaml_key("background_process_notifications"),
        serde_yaml::Value::String(normalize_hermes_display_background_process_notifications(
            form_string(form, "displayBackgroundProcessNotifications").or_else(|| {
                current["displayBackgroundProcessNotifications"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    display.insert(
        yaml_key("final_response_markdown"),
        serde_yaml::Value::String(final_response_markdown),
    );
    display.insert(
        yaml_key("timestamps"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayTimestamps")
                .unwrap_or_else(|| current["displayTimestamps"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("bell_on_complete"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayBellOnComplete")
                .unwrap_or_else(|| current["displayBellOnComplete"].as_bool().unwrap_or(false)),
        ),
    );
    display.insert(
        yaml_key("persistent_output"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayPersistentOutput")
                .unwrap_or_else(|| current["displayPersistentOutput"].as_bool().unwrap_or(true)),
        ),
    );
    display.insert(
        yaml_key("persistent_output_max_lines"),
        serde_yaml::Value::Number(serde_yaml::Number::from(persistent_output_max_lines)),
    );
    display.insert(
        yaml_key("inline_diffs"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayInlineDiffs")
                .unwrap_or_else(|| current["displayInlineDiffs"].as_bool().unwrap_or(true)),
        ),
    );
    display.insert(
        yaml_key("tui_auto_resume_recent"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayTuiAutoResumeRecent").unwrap_or_else(|| {
                current["displayTuiAutoResumeRecent"]
                    .as_bool()
                    .unwrap_or(false)
            }),
        ),
    );
    display.insert(
        yaml_key("tui_status_indicator"),
        serde_yaml::Value::String(normalize_hermes_tui_status_indicator(
            form_string(form, "displayTuiStatusIndicator").or_else(|| {
                current["displayTuiStatusIndicator"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    display.insert(
        yaml_key("ephemeral_system_ttl"),
        serde_yaml::Value::Number(serde_yaml::Number::from(ephemeral_system_ttl)),
    );
    display.insert(
        yaml_key("copy_shortcut"),
        serde_yaml::Value::String(normalize_hermes_copy_shortcut(
            form_string(form, "displayCopyShortcut").or_else(|| {
                current["displayCopyShortcut"]
                    .as_str()
                    .map(ToString::to_string)
            }),
            true,
        )?),
    );
    let user_message_preview = yaml_child_object(display, "user_message_preview")?;
    user_message_preview.insert(
        yaml_key("first_lines"),
        serde_yaml::Value::Number(serde_yaml::Number::from(user_message_preview_first_lines)),
    );
    user_message_preview.insert(
        yaml_key("last_lines"),
        serde_yaml::Value::Number(serde_yaml::Number::from(user_message_preview_last_lines)),
    );
    let runtime_footer = yaml_child_object(display, "runtime_footer")?;
    runtime_footer.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(
            form_bool(form, "displayRuntimeFooterEnabled").unwrap_or_else(|| {
                current["displayRuntimeFooterEnabled"]
                    .as_bool()
                    .unwrap_or(false)
            }),
        ),
    );
    runtime_footer.insert(
        yaml_key("fields"),
        serde_yaml::Value::Sequence(
            runtime_footer_fields
                .into_iter()
                .map(serde_yaml::Value::String)
                .collect(),
        ),
    );
    let dashboard = yaml_child_object(ensure_yaml_object(config)?, "dashboard")?;
    dashboard.insert(
        yaml_key("show_token_analytics"),
        serde_yaml::Value::Bool(
            form_bool(form, "dashboardShowTokenAnalytics").unwrap_or_else(|| {
                current["dashboardShowTokenAnalytics"]
                    .as_bool()
                    .unwrap_or(false)
            }),
        ),
    );
    Ok(())
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

fn build_hermes_kanban_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let kanban = root.and_then(|map| yaml_get_mapping(map, "kanban"));
    serde_json::json!({
        "dispatchInGateway": kanban
            .and_then(|map| yaml_bool_field(map, "dispatch_in_gateway"))
            .unwrap_or(true),
        "dispatchIntervalSeconds": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "dispatch_interval_seconds"),
                60,
                1,
                86400,
            ))
            .unwrap_or(60),
        "maxSpawn": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "max_spawn"),
                0,
                0,
                1000,
            ))
            .unwrap_or(0),
        "maxInProgress": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "max_in_progress"),
                0,
                0,
                1000,
            ))
            .unwrap_or(0),
        "failureLimit": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "failure_limit"),
                2,
                1,
                100,
            ))
            .unwrap_or(2),
        "autoDecompose": kanban
            .and_then(|map| yaml_bool_field(map, "auto_decompose"))
            .unwrap_or(true),
        "autoDecomposePerTick": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "auto_decompose_per_tick"),
                3,
                1,
                1000,
            ))
            .unwrap_or(3),
        "workerLogRotateBytes": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "worker_log_rotate_bytes"),
                2097152,
                1,
                1073741824,
            ))
            .unwrap_or(2097152),
        "workerLogBackupCount": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "worker_log_backup_count"),
                1,
                0,
                100,
            ))
            .unwrap_or(1),
        "orchestratorProfile": kanban
            .and_then(|map| yaml_string_field(map, "orchestrator_profile"))
            .unwrap_or_default(),
        "defaultAssignee": kanban
            .and_then(|map| yaml_string_field(map, "default_assignee"))
            .unwrap_or_default(),
        "dispatchStaleTimeoutSeconds": kanban
            .map(|map| bounded_hermes_i64(
                yaml_i64_field(map, "dispatch_stale_timeout_seconds"),
                14400,
                0,
                604800,
            ))
            .unwrap_or(14400),
    })
}

fn merge_hermes_kanban_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_kanban_config_values(config);
    let dispatch_in_gateway = form_bool(form, "dispatchInGateway")
        .or_else(|| current["dispatchInGateway"].as_bool())
        .unwrap_or(true);
    let dispatch_interval_seconds = validate_hermes_i64(
        form_i64(form, "dispatchIntervalSeconds")
            .or_else(|| current["dispatchIntervalSeconds"].as_i64()),
        "kanban.dispatch_interval_seconds",
        60,
        1,
        86400,
    )?;
    let max_spawn = validate_hermes_i64(
        form_i64(form, "maxSpawn").or_else(|| current["maxSpawn"].as_i64()),
        "kanban.max_spawn",
        0,
        0,
        1000,
    )?;
    let max_in_progress = validate_hermes_i64(
        form_i64(form, "maxInProgress").or_else(|| current["maxInProgress"].as_i64()),
        "kanban.max_in_progress",
        0,
        0,
        1000,
    )?;
    let failure_limit = validate_hermes_i64(
        form_i64(form, "failureLimit").or_else(|| current["failureLimit"].as_i64()),
        "kanban.failure_limit",
        2,
        1,
        100,
    )?;
    let auto_decompose = form_bool(form, "autoDecompose")
        .or_else(|| current["autoDecompose"].as_bool())
        .unwrap_or(true);
    let auto_decompose_per_tick = validate_hermes_i64(
        form_i64(form, "autoDecomposePerTick").or_else(|| current["autoDecomposePerTick"].as_i64()),
        "kanban.auto_decompose_per_tick",
        3,
        1,
        1000,
    )?;
    let worker_log_rotate_bytes = validate_hermes_i64(
        form_i64(form, "workerLogRotateBytes").or_else(|| current["workerLogRotateBytes"].as_i64()),
        "kanban.worker_log_rotate_bytes",
        2097152,
        1,
        1073741824,
    )?;
    let worker_log_backup_count = validate_hermes_i64(
        form_i64(form, "workerLogBackupCount").or_else(|| current["workerLogBackupCount"].as_i64()),
        "kanban.worker_log_backup_count",
        1,
        0,
        100,
    )?;
    let orchestrator_profile = if form.get("orchestratorProfile").is_some() {
        form_string(form, "orchestratorProfile")
            .ok_or_else(|| "kanban.orchestrator_profile must be a string".to_string())?
            .trim()
            .to_string()
    } else {
        current["orchestratorProfile"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let default_assignee = if form.get("defaultAssignee").is_some() {
        form_string(form, "defaultAssignee")
            .ok_or_else(|| "kanban.default_assignee must be a string".to_string())?
            .trim()
            .to_string()
    } else {
        current["defaultAssignee"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let stale_timeout = validate_hermes_i64(
        form_i64(form, "dispatchStaleTimeoutSeconds")
            .or_else(|| current["dispatchStaleTimeoutSeconds"].as_i64()),
        "kanban.dispatch_stale_timeout_seconds",
        14400,
        0,
        604800,
    )?;

    let kanban = yaml_child_object(ensure_yaml_object(config)?, "kanban")?;
    kanban.insert(
        yaml_key("dispatch_in_gateway"),
        serde_yaml::Value::Bool(dispatch_in_gateway),
    );
    kanban.insert(
        yaml_key("dispatch_interval_seconds"),
        serde_yaml::Value::Number(serde_yaml::Number::from(dispatch_interval_seconds)),
    );
    if max_spawn > 0 {
        kanban.insert(
            yaml_key("max_spawn"),
            serde_yaml::Value::Number(serde_yaml::Number::from(max_spawn)),
        );
    } else {
        kanban.remove(yaml_key("max_spawn"));
    }
    if max_in_progress > 0 {
        kanban.insert(
            yaml_key("max_in_progress"),
            serde_yaml::Value::Number(serde_yaml::Number::from(max_in_progress)),
        );
    } else {
        kanban.remove(yaml_key("max_in_progress"));
    }
    kanban.insert(
        yaml_key("failure_limit"),
        serde_yaml::Value::Number(serde_yaml::Number::from(failure_limit)),
    );
    kanban.insert(
        yaml_key("auto_decompose"),
        serde_yaml::Value::Bool(auto_decompose),
    );
    kanban.insert(
        yaml_key("auto_decompose_per_tick"),
        serde_yaml::Value::Number(serde_yaml::Number::from(auto_decompose_per_tick)),
    );
    kanban.insert(
        yaml_key("worker_log_rotate_bytes"),
        serde_yaml::Value::Number(serde_yaml::Number::from(worker_log_rotate_bytes)),
    );
    kanban.insert(
        yaml_key("worker_log_backup_count"),
        serde_yaml::Value::Number(serde_yaml::Number::from(worker_log_backup_count)),
    );
    set_optional_yaml_string(kanban, "orchestrator_profile", orchestrator_profile);
    set_optional_yaml_string(kanban, "default_assignee", default_assignee);
    kanban.insert(
        yaml_key("dispatch_stale_timeout_seconds"),
        serde_yaml::Value::Number(serde_yaml::Number::from(stale_timeout)),
    );
    Ok(())
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

fn normalize_hermes_terminal_modal_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "auto".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "auto" | "managed" | "direct") {
        return Ok(mode);
    }
    if strict {
        Err("terminal.modal_mode 必须是 auto、managed 或 direct".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_terminal_vercel_runtime(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let runtime = value.unwrap_or_default().trim().to_ascii_lowercase();
    let runtime = if runtime.is_empty() {
        "node24".to_string()
    } else {
        runtime
    };
    if matches!(runtime.as_str(), "node24" | "node22" | "python3.13") {
        return Ok(runtime);
    }
    if strict {
        Err("terminal.vercel_runtime 必须是 node24、node22 或 python3.13".to_string())
    } else {
        Ok("node24".to_string())
    }
}

fn normalize_hermes_browser_engine(value: Option<String>, strict: bool) -> Result<String, String> {
    let engine = value.unwrap_or_default().trim().to_ascii_lowercase();
    let engine = if engine.is_empty() {
        "auto".to_string()
    } else {
        engine
    };
    if matches!(engine.as_str(), "auto" | "lightpanda" | "chrome") {
        return Ok(engine);
    }
    if strict {
        Err("browser.engine 必须是 auto、lightpanda 或 chrome".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_browser_dialog_policy(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let policy = value.unwrap_or_default().trim().to_ascii_lowercase();
    let policy = if policy.is_empty() {
        "must_respond".to_string()
    } else {
        policy
    };
    if matches!(
        policy.as_str(),
        "must_respond" | "auto_dismiss" | "auto_accept"
    ) {
        return Ok(policy);
    }
    if strict {
        Err("browser.dialog_policy 必须是 must_respond、auto_dismiss 或 auto_accept".to_string())
    } else {
        Ok("must_respond".to_string())
    }
}

fn normalize_hermes_web_backend(
    value: Option<String>,
    key: &str,
    strict: bool,
) -> Result<String, String> {
    let backend = value.unwrap_or_default().trim().to_ascii_lowercase();
    if backend.is_empty() {
        return Ok(String::new());
    }
    if matches!(
        backend.as_str(),
        "tavily"
            | "firecrawl"
            | "parallel"
            | "exa"
            | "searxng"
            | "brave"
            | "brave_free"
            | "ddgs"
            | "xai"
            | "native"
    ) {
        return Ok(backend);
    }
    if strict {
        Err(format!("{key} 必须为空或 tavily、firecrawl、parallel、exa、searxng、brave、brave_free、ddgs、xai、native"))
    } else {
        Ok(String::new())
    }
}

fn normalize_hermes_lsp_wait_mode(value: Option<String>, strict: bool) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "document".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "document" | "full") {
        return Ok(mode);
    }
    if strict {
        Err("lsp.wait_mode 必须是 document 或 full".to_string())
    } else {
        Ok("document".to_string())
    }
}

fn normalize_hermes_lsp_install_strategy(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let strategy = value.unwrap_or_default().trim().to_ascii_lowercase();
    let strategy = if strategy.is_empty() {
        "auto".to_string()
    } else {
        strategy
    };
    if matches!(strategy.as_str(), "auto" | "manual" | "off") {
        return Ok(strategy);
    }
    if strict {
        Err("lsp.install_strategy 必须是 auto、manual 或 off".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_stt_provider(value: Option<String>, strict: bool) -> Result<String, String> {
    let provider = value.unwrap_or_default().trim().to_ascii_lowercase();
    let provider = if provider.is_empty() {
        "auto".to_string()
    } else {
        provider
    };
    if matches!(
        provider.as_str(),
        "auto" | "local" | "groq" | "openai" | "mistral"
    ) {
        return Ok(provider);
    }
    if strict {
        Err("stt.provider 必须是 auto、local、groq、openai 或 mistral".to_string())
    } else {
        Ok("auto".to_string())
    }
}

fn normalize_hermes_stt_local_model(value: Option<String>, strict: bool) -> Result<String, String> {
    let model = value.unwrap_or_default().trim().to_ascii_lowercase();
    let model = if model.is_empty() {
        "base".to_string()
    } else {
        model
    };
    if matches!(
        model.as_str(),
        "tiny" | "base" | "small" | "medium" | "large-v3" | "turbo"
    ) {
        return Ok(model);
    }
    if strict {
        Err("stt.local.model 必须是 tiny、base、small、medium、large-v3 或 turbo".to_string())
    } else {
        Ok("base".to_string())
    }
}

fn normalize_hermes_stt_openai_model(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let model = value.unwrap_or_default().trim().to_string();
    let model = if model.is_empty() {
        "whisper-1".to_string()
    } else {
        model
    };
    if matches!(
        model.as_str(),
        "whisper-1" | "gpt-4o-mini-transcribe" | "gpt-4o-transcribe"
    ) {
        return Ok(model);
    }
    if strict {
        Err(
            "stt.openai.model 必须是 whisper-1、gpt-4o-mini-transcribe 或 gpt-4o-transcribe"
                .to_string(),
        )
    } else {
        Ok("whisper-1".to_string())
    }
}

fn normalize_hermes_stt_mistral_model(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let model = value.unwrap_or_default().trim().to_string();
    let model = if model.is_empty() {
        "voxtral-mini-latest".to_string()
    } else {
        model
    };
    if matches!(model.as_str(), "voxtral-mini-latest" | "voxtral-mini-2602") {
        return Ok(model);
    }
    if strict {
        Err("stt.mistral.model 必须是 voxtral-mini-latest 或 voxtral-mini-2602".to_string())
    } else {
        Ok("voxtral-mini-latest".to_string())
    }
}

fn normalize_hermes_stt_language(value: Option<String>, strict: bool) -> Result<String, String> {
    let language = value.unwrap_or_default().trim().to_string();
    if language.is_empty() {
        return Ok(String::new());
    }
    let mut parts = language.split('-');
    let Some(first) = parts.next() else {
        return Ok(String::new());
    };
    let first_valid =
        (2..=3).contains(&first.len()) && first.chars().all(|ch| ch.is_ascii_lowercase());
    let rest_valid =
        parts.all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric()));
    if first_valid && rest_valid {
        return Ok(language);
    }
    if strict {
        Err("stt.local.language 必须为空或合法语言标签，例如 zh、en、pt-BR".to_string())
    } else {
        Ok(String::new())
    }
}

fn normalize_hermes_tts_provider(value: Option<String>, strict: bool) -> Result<String, String> {
    let provider = value.unwrap_or_default().trim().to_ascii_lowercase();
    let provider = if provider.is_empty() {
        "edge".to_string()
    } else {
        provider
    };
    if matches!(
        provider.as_str(),
        "edge"
            | "elevenlabs"
            | "openai"
            | "xai"
            | "minimax"
            | "mistral"
            | "gemini"
            | "neutts"
            | "kittentts"
            | "piper"
    ) {
        return Ok(provider);
    }
    if strict {
        Err("tts.provider 必须是 edge、elevenlabs、openai、xai、minimax、mistral、gemini、neutts、kittentts 或 piper".to_string())
    } else {
        Ok("edge".to_string())
    }
}

fn normalize_hermes_tts_openai_voice(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let voice = value.unwrap_or_default().trim().to_ascii_lowercase();
    let voice = if voice.is_empty() {
        "alloy".to_string()
    } else {
        voice
    };
    if matches!(
        voice.as_str(),
        "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
    ) {
        return Ok(voice);
    }
    if strict {
        Err("tts.openai.voice 必须是 alloy、echo、fable、onyx、nova 或 shimmer".to_string())
    } else {
        Ok("alloy".to_string())
    }
}

fn normalize_hermes_voice_language(
    value: Option<String>,
    strict: bool,
    key: &str,
) -> Result<String, String> {
    let language = value.unwrap_or_default().trim().to_string();
    if language.is_empty() {
        return Ok("en".to_string());
    }
    let mut parts = language.split('-');
    let Some(first) = parts.next() else {
        return Ok("en".to_string());
    };
    let first_valid =
        (2..=3).contains(&first.len()) && first.chars().all(|ch| ch.is_ascii_lowercase());
    let rest_valid =
        parts.all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric()));
    if first_valid && rest_valid {
        return Ok(language);
    }
    if strict {
        Err(format!("{key} 必须是合法语言标签，例如 en、zh、pt-BR"))
    } else {
        Ok("en".to_string())
    }
}

fn normalize_hermes_approval_mode(value: Option<String>, strict: bool) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "manual".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "manual" | "smart" | "off") {
        return Ok(mode);
    }
    if strict {
        Err("approvals.mode 必须是 manual、smart 或 off".to_string())
    } else {
        Ok("manual".to_string())
    }
}

fn normalize_hermes_approval_cron_mode(
    value: Option<String>,
    strict: bool,
) -> Result<String, String> {
    let mode = value.unwrap_or_default().trim().to_ascii_lowercase();
    let mode = if mode.is_empty() {
        "deny".to_string()
    } else {
        mode
    };
    if matches!(mode.as_str(), "deny" | "approve") {
        return Ok(mode);
    }
    if strict {
        Err("approvals.cron_mode 必须是 deny 或 approve".to_string())
    } else {
        Ok("deny".to_string())
    }
}

fn normalize_hermes_logging_level(value: Option<String>, strict: bool) -> Result<String, String> {
    let level = value.unwrap_or_default().trim().to_ascii_uppercase();
    let level = if level.is_empty() {
        "INFO".to_string()
    } else {
        level
    };
    if matches!(level.as_str(), "DEBUG" | "INFO" | "WARNING") {
        return Ok(level);
    }
    if strict {
        Err("logging.level 必须是 DEBUG、INFO 或 WARNING".to_string())
    } else {
        Ok("INFO".to_string())
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
    let delegation_model = delegation
        .and_then(|map| yaml_string_field(map, "model"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let delegation_provider = delegation
        .and_then(|map| yaml_string_field(map, "provider"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();

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
        "delegationModel": delegation_model,
        "delegationProvider": delegation_provider,
    })
}

fn build_hermes_io_safety_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let tool_output = root.and_then(|map| yaml_get_mapping(map, "tool_output"));
    let file_read_max_chars = root
        .map(|map| {
            bounded_hermes_i64(
                yaml_i64_field(map, "file_read_max_chars"),
                100000,
                1000,
                1000000,
            )
        })
        .unwrap_or(100000);
    let tool_output_max_bytes = tool_output
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_bytes"), 50000, 1000, 1000000))
        .unwrap_or(50000);
    let tool_output_max_lines = tool_output
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_lines"), 2000, 1, 100000))
        .unwrap_or(2000);
    let tool_output_max_line_length = tool_output
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_line_length"), 2000, 1, 100000))
        .unwrap_or(2000);

    serde_json::json!({
        "fileReadMaxChars": file_read_max_chars,
        "toolOutputMaxBytes": tool_output_max_bytes,
        "toolOutputMaxLines": tool_output_max_lines,
        "toolOutputMaxLineLength": tool_output_max_line_length,
    })
}

fn merge_hermes_io_safety_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_io_safety_config_values(config);
    let file_read_max_chars = validate_hermes_i64(
        if form.get("fileReadMaxChars").is_some() {
            form_i64(form, "fileReadMaxChars")
        } else {
            Some(current["fileReadMaxChars"].as_i64().unwrap_or(100000))
        },
        "file_read_max_chars",
        100000,
        1000,
        1000000,
    )?;
    let tool_output_max_bytes = validate_hermes_i64(
        if form.get("toolOutputMaxBytes").is_some() {
            form_i64(form, "toolOutputMaxBytes")
        } else {
            Some(current["toolOutputMaxBytes"].as_i64().unwrap_or(50000))
        },
        "tool_output.max_bytes",
        50000,
        1000,
        1000000,
    )?;
    let tool_output_max_lines = validate_hermes_i64(
        if form.get("toolOutputMaxLines").is_some() {
            form_i64(form, "toolOutputMaxLines")
        } else {
            Some(current["toolOutputMaxLines"].as_i64().unwrap_or(2000))
        },
        "tool_output.max_lines",
        2000,
        1,
        100000,
    )?;
    let tool_output_max_line_length = validate_hermes_i64(
        if form.get("toolOutputMaxLineLength").is_some() {
            form_i64(form, "toolOutputMaxLineLength")
        } else {
            Some(current["toolOutputMaxLineLength"].as_i64().unwrap_or(2000))
        },
        "tool_output.max_line_length",
        2000,
        1,
        100000,
    )?;

    let root = ensure_yaml_object(config)?;
    root.insert(
        yaml_key("file_read_max_chars"),
        serde_yaml::Value::Number(file_read_max_chars.into()),
    );
    let tool_output = yaml_child_object(root, "tool_output")?;
    tool_output.insert(
        yaml_key("max_bytes"),
        serde_yaml::Value::Number(tool_output_max_bytes.into()),
    );
    tool_output.insert(
        yaml_key("max_lines"),
        serde_yaml::Value::Number(tool_output_max_lines.into()),
    );
    tool_output.insert(
        yaml_key("max_line_length"),
        serde_yaml::Value::Number(tool_output_max_line_length.into()),
    );
    Ok(())
}

fn build_hermes_checkpoints_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let checkpoints = root.and_then(|map| yaml_get_mapping(map, "checkpoints"));
    let checkpoints_enabled = checkpoints
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(false);
    let checkpoint_max_snapshots = checkpoints
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_snapshots"), 20, 1, 10000))
        .unwrap_or(20);
    let checkpoint_max_total_size_mb = checkpoints
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_total_size_mb"), 500, 0, 10485760))
        .unwrap_or(500);
    let checkpoint_max_file_size_mb = checkpoints
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_file_size_mb"), 10, 0, 1048576))
        .unwrap_or(10);
    let checkpoint_auto_prune = checkpoints
        .and_then(|map| yaml_bool_field(map, "auto_prune"))
        .unwrap_or(true);
    let checkpoint_retention_days = checkpoints
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "retention_days"), 7, 1, 3650))
        .unwrap_or(7);
    let checkpoint_delete_orphans = checkpoints
        .and_then(|map| yaml_bool_field(map, "delete_orphans"))
        .unwrap_or(true);
    let checkpoint_min_interval_hours = checkpoints
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "min_interval_hours"), 24, 0, 8760))
        .unwrap_or(24);

    serde_json::json!({
        "checkpointsEnabled": checkpoints_enabled,
        "checkpointMaxSnapshots": checkpoint_max_snapshots,
        "checkpointMaxTotalSizeMb": checkpoint_max_total_size_mb,
        "checkpointMaxFileSizeMb": checkpoint_max_file_size_mb,
        "checkpointAutoPrune": checkpoint_auto_prune,
        "checkpointRetentionDays": checkpoint_retention_days,
        "checkpointDeleteOrphans": checkpoint_delete_orphans,
        "checkpointMinIntervalHours": checkpoint_min_interval_hours,
    })
}

fn merge_hermes_checkpoints_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_checkpoints_config_values(config);
    let checkpoints_enabled = form_bool(form, "checkpointsEnabled")
        .unwrap_or_else(|| current["checkpointsEnabled"].as_bool().unwrap_or(false));
    let checkpoint_max_snapshots = validate_hermes_i64(
        if form.get("checkpointMaxSnapshots").is_some() {
            form_i64(form, "checkpointMaxSnapshots")
        } else {
            Some(current["checkpointMaxSnapshots"].as_i64().unwrap_or(20))
        },
        "checkpoints.max_snapshots",
        20,
        1,
        10000,
    )?;
    let checkpoint_max_total_size_mb = validate_hermes_i64(
        if form.get("checkpointMaxTotalSizeMb").is_some() {
            form_i64(form, "checkpointMaxTotalSizeMb")
        } else {
            Some(current["checkpointMaxTotalSizeMb"].as_i64().unwrap_or(500))
        },
        "checkpoints.max_total_size_mb",
        500,
        0,
        10485760,
    )?;
    let checkpoint_max_file_size_mb = validate_hermes_i64(
        if form.get("checkpointMaxFileSizeMb").is_some() {
            form_i64(form, "checkpointMaxFileSizeMb")
        } else {
            Some(current["checkpointMaxFileSizeMb"].as_i64().unwrap_or(10))
        },
        "checkpoints.max_file_size_mb",
        10,
        0,
        1048576,
    )?;
    let checkpoint_auto_prune = form_bool(form, "checkpointAutoPrune")
        .unwrap_or_else(|| current["checkpointAutoPrune"].as_bool().unwrap_or(true));
    let checkpoint_retention_days = validate_hermes_i64(
        if form.get("checkpointRetentionDays").is_some() {
            form_i64(form, "checkpointRetentionDays")
        } else {
            Some(current["checkpointRetentionDays"].as_i64().unwrap_or(7))
        },
        "checkpoints.retention_days",
        7,
        1,
        3650,
    )?;
    let checkpoint_delete_orphans = form_bool(form, "checkpointDeleteOrphans")
        .unwrap_or_else(|| current["checkpointDeleteOrphans"].as_bool().unwrap_or(true));
    let checkpoint_min_interval_hours = validate_hermes_i64(
        if form.get("checkpointMinIntervalHours").is_some() {
            form_i64(form, "checkpointMinIntervalHours")
        } else {
            Some(current["checkpointMinIntervalHours"].as_i64().unwrap_or(24))
        },
        "checkpoints.min_interval_hours",
        24,
        0,
        8760,
    )?;

    let root = ensure_yaml_object(config)?;
    let checkpoints = yaml_child_object(root, "checkpoints")?;
    checkpoints.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(checkpoints_enabled),
    );
    checkpoints.insert(
        yaml_key("max_snapshots"),
        serde_yaml::Value::Number(checkpoint_max_snapshots.into()),
    );
    checkpoints.insert(
        yaml_key("max_total_size_mb"),
        serde_yaml::Value::Number(checkpoint_max_total_size_mb.into()),
    );
    checkpoints.insert(
        yaml_key("max_file_size_mb"),
        serde_yaml::Value::Number(checkpoint_max_file_size_mb.into()),
    );
    checkpoints.insert(
        yaml_key("auto_prune"),
        serde_yaml::Value::Bool(checkpoint_auto_prune),
    );
    checkpoints.insert(
        yaml_key("retention_days"),
        serde_yaml::Value::Number(checkpoint_retention_days.into()),
    );
    checkpoints.insert(
        yaml_key("delete_orphans"),
        serde_yaml::Value::Bool(checkpoint_delete_orphans),
    );
    checkpoints.insert(
        yaml_key("min_interval_hours"),
        serde_yaml::Value::Number(checkpoint_min_interval_hours.into()),
    );
    Ok(())
}

fn build_hermes_cron_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let cron = root.and_then(|map| yaml_get_mapping(map, "cron"));
    let cron_wrap_response = cron
        .and_then(|map| yaml_bool_field(map, "wrap_response"))
        .unwrap_or(true);
    let cron_max_parallel_jobs = cron
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_parallel_jobs"), 0, 0, 10000))
        .unwrap_or(0);

    serde_json::json!({
        "cronWrapResponse": cron_wrap_response,
        "cronMaxParallelJobs": cron_max_parallel_jobs,
    })
}

fn merge_hermes_cron_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_cron_config_values(config);
    let cron_wrap_response = form_bool(form, "cronWrapResponse")
        .unwrap_or_else(|| current["cronWrapResponse"].as_bool().unwrap_or(true));
    let cron_max_parallel_jobs = validate_hermes_i64(
        if form.get("cronMaxParallelJobs").is_some() {
            form_i64(form, "cronMaxParallelJobs")
        } else {
            Some(current["cronMaxParallelJobs"].as_i64().unwrap_or(0))
        },
        "cron.max_parallel_jobs",
        0,
        0,
        10000,
    )?;

    let root = ensure_yaml_object(config)?;
    let cron = yaml_child_object(root, "cron")?;
    cron.insert(
        yaml_key("wrap_response"),
        serde_yaml::Value::Bool(cron_wrap_response),
    );
    cron.insert(
        yaml_key("max_parallel_jobs"),
        if cron_max_parallel_jobs == 0 {
            serde_yaml::Value::Null
        } else {
            serde_yaml::Value::Number(cron_max_parallel_jobs.into())
        },
    );
    Ok(())
}

fn build_hermes_sessions_maintenance_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let sessions = root.and_then(|map| yaml_get_mapping(map, "sessions"));
    let sessions_auto_prune = sessions
        .and_then(|map| yaml_bool_field(map, "auto_prune"))
        .unwrap_or(false);
    let sessions_retention_days = sessions
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "retention_days"), 90, 1, 36500))
        .unwrap_or(90);
    let sessions_vacuum_after_prune = sessions
        .and_then(|map| yaml_bool_field(map, "vacuum_after_prune"))
        .unwrap_or(true);
    let sessions_min_interval_hours = sessions
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "min_interval_hours"), 24, 0, 87600))
        .unwrap_or(24);
    let sessions_write_json_snapshots = sessions
        .and_then(|map| yaml_bool_field(map, "write_json_snapshots"))
        .unwrap_or(false);

    serde_json::json!({
        "sessionsAutoPrune": sessions_auto_prune,
        "sessionsRetentionDays": sessions_retention_days,
        "sessionsVacuumAfterPrune": sessions_vacuum_after_prune,
        "sessionsMinIntervalHours": sessions_min_interval_hours,
        "sessionsWriteJsonSnapshots": sessions_write_json_snapshots,
    })
}

fn merge_hermes_sessions_maintenance_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_sessions_maintenance_config_values(config);
    let sessions_retention_days = validate_hermes_i64(
        if form.get("sessionsRetentionDays").is_some() {
            form_i64(form, "sessionsRetentionDays")
        } else {
            Some(current["sessionsRetentionDays"].as_i64().unwrap_or(90))
        },
        "sessions.retention_days",
        90,
        1,
        36500,
    )?;
    let sessions_min_interval_hours = validate_hermes_i64(
        if form.get("sessionsMinIntervalHours").is_some() {
            form_i64(form, "sessionsMinIntervalHours")
        } else {
            Some(current["sessionsMinIntervalHours"].as_i64().unwrap_or(24))
        },
        "sessions.min_interval_hours",
        24,
        0,
        87600,
    )?;

    let root = ensure_yaml_object(config)?;
    let sessions = yaml_child_object(root, "sessions")?;
    sessions.insert(
        yaml_key("auto_prune"),
        serde_yaml::Value::Bool(
            form_bool(form, "sessionsAutoPrune")
                .unwrap_or_else(|| current["sessionsAutoPrune"].as_bool().unwrap_or(false)),
        ),
    );
    sessions.insert(
        yaml_key("retention_days"),
        serde_yaml::Value::Number(sessions_retention_days.into()),
    );
    sessions.insert(
        yaml_key("vacuum_after_prune"),
        serde_yaml::Value::Bool(
            form_bool(form, "sessionsVacuumAfterPrune").unwrap_or_else(|| {
                current["sessionsVacuumAfterPrune"]
                    .as_bool()
                    .unwrap_or(true)
            }),
        ),
    );
    sessions.insert(
        yaml_key("min_interval_hours"),
        serde_yaml::Value::Number(sessions_min_interval_hours.into()),
    );
    sessions.insert(
        yaml_key("write_json_snapshots"),
        serde_yaml::Value::Bool(
            form_bool(form, "sessionsWriteJsonSnapshots").unwrap_or_else(|| {
                current["sessionsWriteJsonSnapshots"]
                    .as_bool()
                    .unwrap_or(false)
            }),
        ),
    );
    Ok(())
}

fn build_hermes_updates_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let updates = root.and_then(|map| yaml_get_mapping(map, "updates"));
    let updates_pre_update_backup = updates
        .and_then(|map| yaml_bool_field(map, "pre_update_backup"))
        .unwrap_or(false);
    let updates_backup_keep = updates
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "backup_keep"), 5, 1, 1000))
        .unwrap_or(5);

    serde_json::json!({
        "updatesPreUpdateBackup": updates_pre_update_backup,
        "updatesBackupKeep": updates_backup_keep,
    })
}

fn merge_hermes_updates_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_updates_config_values(config);
    let updates_pre_update_backup = form_bool(form, "updatesPreUpdateBackup")
        .unwrap_or_else(|| current["updatesPreUpdateBackup"].as_bool().unwrap_or(false));
    let updates_backup_keep = validate_hermes_i64(
        if form.get("updatesBackupKeep").is_some() {
            form_i64(form, "updatesBackupKeep")
        } else {
            Some(current["updatesBackupKeep"].as_i64().unwrap_or(5))
        },
        "updates.backup_keep",
        5,
        1,
        1000,
    )?;

    let root = ensure_yaml_object(config)?;
    let updates = yaml_child_object(root, "updates")?;
    updates.insert(
        yaml_key("pre_update_backup"),
        serde_yaml::Value::Bool(updates_pre_update_backup),
    );
    updates.insert(
        yaml_key("backup_keep"),
        serde_yaml::Value::Number(updates_backup_keep.into()),
    );
    Ok(())
}

fn build_hermes_logging_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let logging = root.and_then(|map| yaml_get_mapping(map, "logging"));
    let memory_monitor = logging.and_then(|map| yaml_get_mapping(map, "memory_monitor"));
    let logging_level = normalize_hermes_logging_level(
        logging.and_then(|map| yaml_string_field(map, "level")),
        false,
    )
    .unwrap_or_else(|_| "INFO".to_string());
    let logging_max_size_mb = logging
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_size_mb"), 5, 1, 102400))
        .unwrap_or(5);
    let logging_backup_count = logging
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "backup_count"), 3, 0, 1000))
        .unwrap_or(3);
    let logging_memory_monitor_enabled = memory_monitor
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(true);
    let logging_memory_monitor_interval_seconds = memory_monitor
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "interval_seconds"), 300, 1, 86400))
        .unwrap_or(300);

    serde_json::json!({
        "loggingLevel": logging_level,
        "loggingMaxSizeMb": logging_max_size_mb,
        "loggingBackupCount": logging_backup_count,
        "loggingMemoryMonitorEnabled": logging_memory_monitor_enabled,
        "loggingMemoryMonitorIntervalSeconds": logging_memory_monitor_interval_seconds,
    })
}

fn merge_hermes_logging_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_logging_config_values(config);
    let logging_level = normalize_hermes_logging_level(
        if form.get("loggingLevel").is_some() {
            form_string(form, "loggingLevel")
        } else {
            current["loggingLevel"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let logging_max_size_mb = validate_hermes_i64(
        if form.get("loggingMaxSizeMb").is_some() {
            form_i64(form, "loggingMaxSizeMb")
        } else {
            Some(current["loggingMaxSizeMb"].as_i64().unwrap_or(5))
        },
        "logging.max_size_mb",
        5,
        1,
        102400,
    )?;
    let logging_backup_count = validate_hermes_i64(
        if form.get("loggingBackupCount").is_some() {
            form_i64(form, "loggingBackupCount")
        } else {
            Some(current["loggingBackupCount"].as_i64().unwrap_or(3))
        },
        "logging.backup_count",
        3,
        0,
        1000,
    )?;
    let logging_memory_monitor_enabled = form_bool(form, "loggingMemoryMonitorEnabled")
        .unwrap_or_else(|| {
            current["loggingMemoryMonitorEnabled"]
                .as_bool()
                .unwrap_or(true)
        });
    let logging_memory_monitor_interval_seconds = validate_hermes_i64(
        if form.get("loggingMemoryMonitorIntervalSeconds").is_some() {
            form_i64(form, "loggingMemoryMonitorIntervalSeconds")
        } else {
            Some(
                current["loggingMemoryMonitorIntervalSeconds"]
                    .as_i64()
                    .unwrap_or(300),
            )
        },
        "logging.memory_monitor.interval_seconds",
        300,
        1,
        86400,
    )?;

    let root = ensure_yaml_object(config)?;
    let logging = yaml_child_object(root, "logging")?;
    logging.insert(yaml_key("level"), serde_yaml::Value::String(logging_level));
    logging.insert(
        yaml_key("max_size_mb"),
        serde_yaml::Value::Number(logging_max_size_mb.into()),
    );
    logging.insert(
        yaml_key("backup_count"),
        serde_yaml::Value::Number(logging_backup_count.into()),
    );
    let memory_monitor = yaml_child_object(logging, "memory_monitor")?;
    memory_monitor.insert(
        yaml_key("enabled"),
        serde_yaml::Value::Bool(logging_memory_monitor_enabled),
    );
    memory_monitor.insert(
        yaml_key("interval_seconds"),
        serde_yaml::Value::Number(logging_memory_monitor_interval_seconds.into()),
    );
    Ok(())
}

fn build_hermes_approvals_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let approvals = root.and_then(|map| yaml_get_mapping(map, "approvals"));
    let approval_mode = normalize_hermes_approval_mode(
        approvals.and_then(|map| yaml_string_field(map, "mode")),
        false,
    )
    .unwrap_or_else(|_| "manual".to_string());
    let approval_timeout = approvals
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout"), 60, 1, 86400))
        .unwrap_or(60);
    let approval_cron_mode = normalize_hermes_approval_cron_mode(
        approvals.and_then(|map| yaml_string_field(map, "cron_mode")),
        false,
    )
    .unwrap_or_else(|_| "deny".to_string());
    let approval_mcp_reload_confirm = approvals
        .and_then(|map| yaml_bool_field(map, "mcp_reload_confirm"))
        .unwrap_or(true);
    let approval_destructive_slash_confirm = approvals
        .and_then(|map| yaml_bool_field(map, "destructive_slash_confirm"))
        .unwrap_or(true);

    serde_json::json!({
        "approvalMode": approval_mode,
        "approvalTimeout": approval_timeout,
        "approvalCronMode": approval_cron_mode,
        "approvalMcpReloadConfirm": approval_mcp_reload_confirm,
        "approvalDestructiveSlashConfirm": approval_destructive_slash_confirm,
    })
}

fn merge_hermes_approvals_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_approvals_config_values(config);
    let approval_mode = normalize_hermes_approval_mode(
        if form.get("approvalMode").is_some() {
            form_string(form, "approvalMode")
        } else {
            current["approvalMode"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let approval_timeout = validate_hermes_i64(
        if form.get("approvalTimeout").is_some() {
            form_i64(form, "approvalTimeout")
        } else {
            Some(current["approvalTimeout"].as_i64().unwrap_or(60))
        },
        "approvals.timeout",
        60,
        1,
        86400,
    )?;
    let approval_cron_mode = normalize_hermes_approval_cron_mode(
        if form.get("approvalCronMode").is_some() {
            form_string(form, "approvalCronMode")
        } else {
            current["approvalCronMode"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let approval_mcp_reload_confirm =
        form_bool(form, "approvalMcpReloadConfirm").unwrap_or_else(|| {
            current["approvalMcpReloadConfirm"]
                .as_bool()
                .unwrap_or(true)
        });
    let approval_destructive_slash_confirm = form_bool(form, "approvalDestructiveSlashConfirm")
        .unwrap_or_else(|| {
            current["approvalDestructiveSlashConfirm"]
                .as_bool()
                .unwrap_or(true)
        });

    let root = ensure_yaml_object(config)?;
    let approvals = yaml_child_object(root, "approvals")?;
    approvals.insert(yaml_key("mode"), serde_yaml::Value::String(approval_mode));
    approvals.insert(
        yaml_key("timeout"),
        serde_yaml::Value::Number(approval_timeout.into()),
    );
    approvals.insert(
        yaml_key("cron_mode"),
        serde_yaml::Value::String(approval_cron_mode),
    );
    approvals.insert(
        yaml_key("mcp_reload_confirm"),
        serde_yaml::Value::Bool(approval_mcp_reload_confirm),
    );
    approvals.insert(
        yaml_key("destructive_slash_confirm"),
        serde_yaml::Value::Bool(approval_destructive_slash_confirm),
    );
    Ok(())
}

fn build_hermes_privacy_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let privacy = root.and_then(|map| yaml_get_mapping(map, "privacy"));
    let redact_pii = privacy
        .and_then(|map| yaml_bool_field(map, "redact_pii"))
        .unwrap_or(false);

    serde_json::json!({
        "redactPii": redact_pii,
    })
}

fn merge_hermes_privacy_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_privacy_config_values(config);
    let redact_pii = form_bool(form, "redactPii")
        .unwrap_or_else(|| current["redactPii"].as_bool().unwrap_or(false));

    let root = ensure_yaml_object(config)?;
    let privacy = yaml_child_object(root, "privacy")?;
    privacy.insert(yaml_key("redact_pii"), serde_yaml::Value::Bool(redact_pii));
    Ok(())
}

fn build_hermes_browser_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let browser = root.and_then(|map| yaml_get_mapping(map, "browser"));
    let browser_inactivity_timeout = browser
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "inactivity_timeout"), 120, 1, 86400))
        .unwrap_or(120);
    let browser_command_timeout = browser
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "command_timeout"), 30, 5, 3600))
        .unwrap_or(30);
    let browser_record_sessions = browser
        .and_then(|map| yaml_bool_field(map, "record_sessions"))
        .unwrap_or(false);
    let browser_engine = normalize_hermes_browser_engine(
        browser.and_then(|map| yaml_string_field(map, "engine")),
        false,
    )
    .unwrap_or_else(|_| "auto".to_string());
    let browser_allow_private_urls = browser
        .and_then(|map| yaml_bool_field(map, "allow_private_urls"))
        .unwrap_or(false);
    let browser_auto_local_for_private_urls = browser
        .and_then(|map| yaml_bool_field(map, "auto_local_for_private_urls"))
        .unwrap_or(true);
    let browser_cdp_url = browser
        .and_then(|map| yaml_string_field(map, "cdp_url"))
        .unwrap_or_default();
    let camofox = browser.and_then(|map| yaml_get_mapping(map, "camofox"));
    let browser_camofox_managed_persistence = camofox
        .and_then(|map| yaml_bool_field(map, "managed_persistence"))
        .unwrap_or(false);
    let browser_camofox_user_id = normalize_hermes_camofox_identity(
        camofox.and_then(|map| yaml_string_field(map, "user_id")),
        "browser.camofox.user_id",
    )
    .unwrap_or_default();
    let browser_camofox_session_key = normalize_hermes_camofox_identity(
        camofox.and_then(|map| yaml_string_field(map, "session_key")),
        "browser.camofox.session_key",
    )
    .unwrap_or_default();
    let browser_camofox_adopt_existing_tab = camofox
        .and_then(|map| yaml_bool_field(map, "adopt_existing_tab"))
        .unwrap_or(false);
    let browser_dialog_policy = normalize_hermes_browser_dialog_policy(
        browser.and_then(|map| yaml_string_field(map, "dialog_policy")),
        false,
    )
    .unwrap_or_else(|_| "must_respond".to_string());
    let browser_dialog_timeout = browser
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "dialog_timeout_s"), 300, 1, 86400))
        .unwrap_or(300);

    serde_json::json!({
        "browserInactivityTimeout": browser_inactivity_timeout,
        "browserCommandTimeout": browser_command_timeout,
        "browserRecordSessions": browser_record_sessions,
        "browserEngine": browser_engine,
        "browserAllowPrivateUrls": browser_allow_private_urls,
        "browserAutoLocalForPrivateUrls": browser_auto_local_for_private_urls,
        "browserCdpUrl": browser_cdp_url,
        "browserCamofoxManagedPersistence": browser_camofox_managed_persistence,
        "browserCamofoxUserId": browser_camofox_user_id,
        "browserCamofoxSessionKey": browser_camofox_session_key,
        "browserCamofoxAdoptExistingTab": browser_camofox_adopt_existing_tab,
        "browserDialogPolicy": browser_dialog_policy,
        "browserDialogTimeout": browser_dialog_timeout,
    })
}

fn merge_hermes_browser_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_browser_config_values(config);
    let browser_inactivity_timeout = validate_hermes_i64(
        if form.get("browserInactivityTimeout").is_some() {
            form_i64(form, "browserInactivityTimeout")
        } else {
            Some(current["browserInactivityTimeout"].as_i64().unwrap_or(120))
        },
        "browser.inactivity_timeout",
        120,
        1,
        86400,
    )?;
    let browser_command_timeout = validate_hermes_i64(
        if form.get("browserCommandTimeout").is_some() {
            form_i64(form, "browserCommandTimeout")
        } else {
            Some(current["browserCommandTimeout"].as_i64().unwrap_or(30))
        },
        "browser.command_timeout",
        30,
        5,
        3600,
    )?;
    let browser_record_sessions = form_bool(form, "browserRecordSessions")
        .unwrap_or_else(|| current["browserRecordSessions"].as_bool().unwrap_or(false));
    let browser_engine = normalize_hermes_browser_engine(
        if form.get("browserEngine").is_some() {
            form_string(form, "browserEngine")
        } else {
            current["browserEngine"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let browser_allow_private_urls =
        form_bool(form, "browserAllowPrivateUrls").unwrap_or_else(|| {
            current["browserAllowPrivateUrls"]
                .as_bool()
                .unwrap_or(false)
        });
    let browser_auto_local_for_private_urls = form_bool(form, "browserAutoLocalForPrivateUrls")
        .unwrap_or_else(|| {
            current["browserAutoLocalForPrivateUrls"]
                .as_bool()
                .unwrap_or(true)
        });
    let browser_cdp_url = if form.get("browserCdpUrl").is_some() {
        form_string(form, "browserCdpUrl")
            .ok_or_else(|| "browser.cdp_url 必须是字符串".to_string())?
            .trim()
            .to_string()
    } else {
        current["browserCdpUrl"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let browser_camofox_managed_persistence = form_bool(form, "browserCamofoxManagedPersistence")
        .unwrap_or_else(|| {
            current["browserCamofoxManagedPersistence"]
                .as_bool()
                .unwrap_or(false)
        });
    let browser_camofox_user_id = normalize_hermes_camofox_identity(
        if form.get("browserCamofoxUserId").is_some() {
            Some(
                form_string(form, "browserCamofoxUserId")
                    .ok_or_else(|| "browser.camofox.user_id 必须是字符串".to_string())?,
            )
        } else {
            current["browserCamofoxUserId"]
                .as_str()
                .map(ToString::to_string)
        },
        "browser.camofox.user_id",
    )?;
    let browser_camofox_session_key = normalize_hermes_camofox_identity(
        if form.get("browserCamofoxSessionKey").is_some() {
            Some(
                form_string(form, "browserCamofoxSessionKey")
                    .ok_or_else(|| "browser.camofox.session_key 必须是字符串".to_string())?,
            )
        } else {
            current["browserCamofoxSessionKey"]
                .as_str()
                .map(ToString::to_string)
        },
        "browser.camofox.session_key",
    )?;
    let browser_camofox_adopt_existing_tab = form_bool(form, "browserCamofoxAdoptExistingTab")
        .unwrap_or_else(|| {
            current["browserCamofoxAdoptExistingTab"]
                .as_bool()
                .unwrap_or(false)
        });
    let browser_dialog_policy = normalize_hermes_browser_dialog_policy(
        if form.get("browserDialogPolicy").is_some() {
            form_string(form, "browserDialogPolicy")
        } else {
            current["browserDialogPolicy"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let browser_dialog_timeout = validate_hermes_i64(
        if form.get("browserDialogTimeout").is_some() {
            form_i64(form, "browserDialogTimeout")
        } else {
            Some(current["browserDialogTimeout"].as_i64().unwrap_or(300))
        },
        "browser.dialog_timeout_s",
        300,
        1,
        86400,
    )?;

    let root = ensure_yaml_object(config)?;
    let browser = yaml_child_object(root, "browser")?;
    browser.insert(
        yaml_key("inactivity_timeout"),
        serde_yaml::Value::Number(browser_inactivity_timeout.into()),
    );
    browser.insert(
        yaml_key("command_timeout"),
        serde_yaml::Value::Number(browser_command_timeout.into()),
    );
    browser.insert(
        yaml_key("record_sessions"),
        serde_yaml::Value::Bool(browser_record_sessions),
    );
    browser.insert(
        yaml_key("engine"),
        serde_yaml::Value::String(browser_engine),
    );
    browser.insert(
        yaml_key("allow_private_urls"),
        serde_yaml::Value::Bool(browser_allow_private_urls),
    );
    browser.insert(
        yaml_key("auto_local_for_private_urls"),
        serde_yaml::Value::Bool(browser_auto_local_for_private_urls),
    );
    set_optional_yaml_string(browser, "cdp_url", browser_cdp_url);
    let camofox = yaml_child_object(browser, "camofox")?;
    camofox.insert(
        yaml_key("managed_persistence"),
        serde_yaml::Value::Bool(browser_camofox_managed_persistence),
    );
    set_optional_yaml_string(camofox, "user_id", browser_camofox_user_id);
    set_optional_yaml_string(camofox, "session_key", browser_camofox_session_key);
    camofox.insert(
        yaml_key("adopt_existing_tab"),
        serde_yaml::Value::Bool(browser_camofox_adopt_existing_tab),
    );
    browser.insert(
        yaml_key("dialog_policy"),
        serde_yaml::Value::String(browser_dialog_policy),
    );
    browser.insert(
        yaml_key("dialog_timeout_s"),
        serde_yaml::Value::Number(browser_dialog_timeout.into()),
    );
    Ok(())
}

fn build_hermes_web_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let web = root.and_then(|map| yaml_get_mapping(map, "web"));
    let web_backend = normalize_hermes_web_backend(
        web.and_then(|map| yaml_string_field(map, "backend")),
        "web.backend",
        false,
    )
    .unwrap_or_default();
    let web_search_backend = normalize_hermes_web_backend(
        web.and_then(|map| yaml_string_field(map, "search_backend")),
        "web.search_backend",
        false,
    )
    .unwrap_or_default();
    let web_extract_backend = normalize_hermes_web_backend(
        web.and_then(|map| yaml_string_field(map, "extract_backend")),
        "web.extract_backend",
        false,
    )
    .unwrap_or_default();

    serde_json::json!({
        "webBackend": web_backend,
        "webSearchBackend": web_search_backend,
        "webExtractBackend": web_extract_backend,
    })
}

fn merge_hermes_web_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_web_config_values(config);
    let web_backend = normalize_hermes_web_backend(
        if form.get("webBackend").is_some() {
            form_string(form, "webBackend")
        } else {
            current["webBackend"].as_str().map(ToString::to_string)
        },
        "web.backend",
        true,
    )?;
    let web_search_backend = normalize_hermes_web_backend(
        if form.get("webSearchBackend").is_some() {
            form_string(form, "webSearchBackend")
        } else {
            current["webSearchBackend"]
                .as_str()
                .map(ToString::to_string)
        },
        "web.search_backend",
        true,
    )?;
    let web_extract_backend = normalize_hermes_web_backend(
        if form.get("webExtractBackend").is_some() {
            form_string(form, "webExtractBackend")
        } else {
            current["webExtractBackend"]
                .as_str()
                .map(ToString::to_string)
        },
        "web.extract_backend",
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    let web = yaml_child_object(root, "web")?;
    set_optional_yaml_string(web, "backend", web_backend);
    set_optional_yaml_string(web, "search_backend", web_search_backend);
    set_optional_yaml_string(web, "extract_backend", web_extract_backend);
    Ok(())
}

fn build_hermes_model_catalog_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let model_catalog = root.and_then(|map| yaml_get_mapping(map, "model_catalog"));
    let enabled = model_catalog
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(true);
    let url = normalize_hermes_http_url(
        model_catalog.and_then(|map| yaml_string_field(map, "url")),
        "model_catalog.url",
        HERMES_MODEL_CATALOG_DEFAULT_URL,
        false,
    )
    .unwrap_or_else(|_| HERMES_MODEL_CATALOG_DEFAULT_URL.to_string());
    let ttl_hours = model_catalog
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "ttl_hours"), 24, 1, 8760))
        .unwrap_or(24);
    let providers = model_catalog
        .and_then(|map| yaml_get(map, "providers"))
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| validate_hermes_model_catalog_providers(&value).ok())
        .unwrap_or_default();
    serde_json::json!({
        "modelCatalogEnabled": enabled,
        "modelCatalogUrl": url,
        "modelCatalogTtlHours": ttl_hours,
        "modelCatalogProvidersJson": serde_json::to_string_pretty(&Value::Object(providers)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn merge_hermes_model_catalog_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_model_catalog_config_values(config);
    let enabled = form_bool(form, "modelCatalogEnabled")
        .unwrap_or_else(|| current["modelCatalogEnabled"].as_bool().unwrap_or(true));
    let url = normalize_hermes_http_url(
        if form.get("modelCatalogUrl").is_some() {
            form_string(form, "modelCatalogUrl")
        } else {
            current["modelCatalogUrl"].as_str().map(ToString::to_string)
        },
        "model_catalog.url",
        HERMES_MODEL_CATALOG_DEFAULT_URL,
        true,
    )?;
    let ttl_hours = validate_hermes_i64(
        if form.get("modelCatalogTtlHours").is_some() {
            form_i64(form, "modelCatalogTtlHours")
        } else {
            current["modelCatalogTtlHours"].as_i64()
        },
        "model_catalog.ttl_hours",
        24,
        1,
        8760,
    )?;
    let providers = parse_hermes_model_catalog_providers_json(
        if form.get("modelCatalogProvidersJson").is_some() {
            form_string(form, "modelCatalogProvidersJson")
        } else {
            current["modelCatalogProvidersJson"]
                .as_str()
                .map(ToString::to_string)
        },
    )?;

    let root = ensure_yaml_object(config)?;
    let model_catalog = yaml_child_object(root, "model_catalog")?;
    model_catalog.insert(yaml_key("enabled"), serde_yaml::Value::Bool(enabled));
    model_catalog.insert(yaml_key("url"), serde_yaml::Value::String(url));
    model_catalog.insert(
        yaml_key("ttl_hours"),
        serde_yaml::Value::Number(serde_yaml::Number::from(ttl_hours)),
    );
    if providers.is_empty() {
        model_catalog.remove(yaml_key("providers"));
    } else {
        let yaml_value = serde_yaml::to_value(Value::Object(providers))
            .map_err(|err| format!("model_catalog.providers 序列化失败: {err}"))?;
        model_catalog.insert(yaml_key("providers"), yaml_value);
    }
    Ok(())
}

fn normalize_hermes_x_search_model(value: Option<String>, strict: bool) -> Result<String, String> {
    let text = value.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        if strict {
            return Err("x_search.model 不能为空".to_string());
        }
        return Ok("grok-4.20-reasoning".to_string());
    }
    if text
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-'))
    {
        return Ok(text);
    }
    if strict {
        return Err(
            "x_search.model 只能包含字母、数字、下划线、点、斜杠、冒号和短横线".to_string(),
        );
    }
    Ok("grok-4.20-reasoning".to_string())
}

fn build_hermes_x_search_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let x_search = root.and_then(|map| yaml_get_mapping(map, "x_search"));
    let model = normalize_hermes_x_search_model(
        x_search.and_then(|map| yaml_string_field(map, "model")),
        false,
    )
    .unwrap_or_else(|_| "grok-4.20-reasoning".to_string());
    let timeout_seconds = x_search
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "timeout_seconds"), 180, 30, 3600))
        .unwrap_or(180);
    let retries = x_search
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "retries"), 2, 0, 20))
        .unwrap_or(2);

    serde_json::json!({
        "xSearchModel": model,
        "xSearchTimeoutSeconds": timeout_seconds,
        "xSearchRetries": retries,
    })
}

fn merge_hermes_x_search_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_x_search_config_values(config);
    let model = normalize_hermes_x_search_model(
        if form.get("xSearchModel").is_some() {
            form_string(form, "xSearchModel")
        } else {
            current["xSearchModel"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let timeout_seconds = validate_hermes_i64(
        if form.get("xSearchTimeoutSeconds").is_some() {
            form_i64(form, "xSearchTimeoutSeconds")
        } else {
            current["xSearchTimeoutSeconds"].as_i64()
        },
        "x_search.timeout_seconds",
        180,
        30,
        3600,
    )?;
    let retries = validate_hermes_i64(
        if form.get("xSearchRetries").is_some() {
            form_i64(form, "xSearchRetries")
        } else {
            current["xSearchRetries"].as_i64()
        },
        "x_search.retries",
        2,
        0,
        20,
    )?;

    let root = ensure_yaml_object(config)?;
    let x_search = yaml_child_object(root, "x_search")?;
    x_search.insert(yaml_key("model"), serde_yaml::Value::String(model));
    x_search.insert(
        yaml_key("timeout_seconds"),
        serde_yaml::Value::Number(serde_yaml::Number::from(timeout_seconds)),
    );
    x_search.insert(
        yaml_key("retries"),
        serde_yaml::Value::Number(serde_yaml::Number::from(retries)),
    );
    Ok(())
}

fn normalize_hermes_context_engine(value: Option<String>, strict: bool) -> Result<String, String> {
    let text = value.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        if strict {
            return Err("context.engine 不能为空".to_string());
        }
        return Ok("compressor".to_string());
    }
    if text
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
    {
        return Ok(text);
    }
    if strict {
        return Err("context.engine 只能包含字母、数字、下划线、点和短横线".to_string());
    }
    Ok("compressor".to_string())
}

fn build_hermes_context_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let context = root.and_then(|map| yaml_get_mapping(map, "context"));
    let engine = normalize_hermes_context_engine(
        context.and_then(|map| yaml_string_field(map, "engine")),
        false,
    )
    .unwrap_or_else(|_| "compressor".to_string());

    serde_json::json!({
        "contextEngine": engine,
    })
}

fn merge_hermes_context_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_context_config_values(config);
    let engine = normalize_hermes_context_engine(
        if form.get("contextEngine").is_some() {
            form_string(form, "contextEngine")
        } else {
            current["contextEngine"].as_str().map(ToString::to_string)
        },
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    let context = yaml_child_object(root, "context")?;
    context.insert(yaml_key("engine"), serde_yaml::Value::String(engine));
    Ok(())
}

fn build_hermes_lsp_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let lsp = root.and_then(|map| yaml_get_mapping(map, "lsp"));
    let lsp_enabled = lsp
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(true);
    let lsp_wait_mode = normalize_hermes_lsp_wait_mode(
        lsp.and_then(|map| yaml_string_field(map, "wait_mode")),
        false,
    )
    .unwrap_or_else(|_| "document".to_string());
    let lsp_wait_timeout = lsp
        .map(|map| bounded_hermes_f64(yaml_f64_field(map, "wait_timeout"), 5.0, 0.1, 120.0))
        .unwrap_or(5.0);
    let lsp_install_strategy = normalize_hermes_lsp_install_strategy(
        lsp.and_then(|map| yaml_string_field(map, "install_strategy")),
        false,
    )
    .unwrap_or_else(|_| "auto".to_string());

    serde_json::json!({
        "lspEnabled": lsp_enabled,
        "lspWaitMode": lsp_wait_mode,
        "lspWaitTimeout": lsp_wait_timeout,
        "lspInstallStrategy": lsp_install_strategy,
    })
}

fn merge_hermes_lsp_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_lsp_config_values(config);
    let lsp_enabled = form_bool(form, "lspEnabled")
        .unwrap_or_else(|| current["lspEnabled"].as_bool().unwrap_or(true));
    let lsp_wait_mode = normalize_hermes_lsp_wait_mode(
        if form.get("lspWaitMode").is_some() {
            form_string(form, "lspWaitMode")
        } else {
            current["lspWaitMode"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let lsp_wait_timeout = validate_hermes_f64(
        if form.get("lspWaitTimeout").is_some() {
            form_f64(form, "lspWaitTimeout")
        } else {
            current["lspWaitTimeout"].as_f64()
        },
        "lsp.wait_timeout",
        5.0,
        0.1,
        120.0,
    )?;
    let lsp_install_strategy = normalize_hermes_lsp_install_strategy(
        if form.get("lspInstallStrategy").is_some() {
            form_string(form, "lspInstallStrategy")
        } else {
            current["lspInstallStrategy"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    let lsp = yaml_child_object(root, "lsp")?;
    lsp.insert(yaml_key("enabled"), serde_yaml::Value::Bool(lsp_enabled));
    lsp.insert(
        yaml_key("wait_mode"),
        serde_yaml::Value::String(lsp_wait_mode),
    );
    lsp.insert(
        yaml_key("wait_timeout"),
        serde_yaml::Value::Number(serde_yaml::Number::from(lsp_wait_timeout)),
    );
    lsp.insert(
        yaml_key("install_strategy"),
        serde_yaml::Value::String(lsp_install_strategy),
    );
    Ok(())
}

fn build_hermes_stt_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let stt = root.and_then(|map| yaml_get_mapping(map, "stt"));
    let local = stt.and_then(|map| yaml_get_mapping(map, "local"));
    let openai = stt.and_then(|map| yaml_get_mapping(map, "openai"));
    let mistral = stt.and_then(|map| yaml_get_mapping(map, "mistral"));
    let stt_enabled = stt
        .and_then(|map| yaml_bool_field(map, "enabled"))
        .unwrap_or(true);
    let stt_provider = normalize_hermes_stt_provider(
        stt.and_then(|map| yaml_string_field(map, "provider")),
        false,
    )
    .unwrap_or_else(|_| "auto".to_string());
    let stt_local_model = normalize_hermes_stt_local_model(
        local.and_then(|map| yaml_string_field(map, "model")),
        false,
    )
    .unwrap_or_else(|_| "base".to_string());
    let stt_local_language = normalize_hermes_stt_language(
        local.and_then(|map| yaml_string_field(map, "language")),
        false,
    )
    .unwrap_or_else(|_| String::new());
    let stt_openai_model = normalize_hermes_stt_openai_model(
        openai.and_then(|map| yaml_string_field(map, "model")),
        false,
    )
    .unwrap_or_else(|_| "whisper-1".to_string());
    let stt_mistral_model = normalize_hermes_stt_mistral_model(
        mistral.and_then(|map| yaml_string_field(map, "model")),
        false,
    )
    .unwrap_or_else(|_| "voxtral-mini-latest".to_string());

    serde_json::json!({
        "sttEnabled": stt_enabled,
        "sttProvider": stt_provider,
        "sttLocalModel": stt_local_model,
        "sttLocalLanguage": stt_local_language,
        "sttOpenaiModel": stt_openai_model,
        "sttMistralModel": stt_mistral_model,
    })
}

fn merge_hermes_stt_config(config: &mut serde_yaml::Value, form: &Value) -> Result<(), String> {
    let current = build_hermes_stt_config_values(config);
    let stt_enabled = form_bool(form, "sttEnabled")
        .unwrap_or_else(|| current["sttEnabled"].as_bool().unwrap_or(true));
    let stt_provider = normalize_hermes_stt_provider(
        if form.get("sttProvider").is_some() {
            form_string(form, "sttProvider")
        } else {
            current["sttProvider"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let stt_local_model = normalize_hermes_stt_local_model(
        if form.get("sttLocalModel").is_some() {
            form_string(form, "sttLocalModel")
        } else {
            current["sttLocalModel"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let stt_local_language = normalize_hermes_stt_language(
        if form.get("sttLocalLanguage").is_some() {
            form_string(form, "sttLocalLanguage")
        } else {
            current["sttLocalLanguage"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let stt_openai_model = normalize_hermes_stt_openai_model(
        if form.get("sttOpenaiModel").is_some() {
            form_string(form, "sttOpenaiModel")
        } else {
            current["sttOpenaiModel"].as_str().map(ToString::to_string)
        },
        true,
    )?;
    let stt_mistral_model = normalize_hermes_stt_mistral_model(
        if form.get("sttMistralModel").is_some() {
            form_string(form, "sttMistralModel")
        } else {
            current["sttMistralModel"].as_str().map(ToString::to_string)
        },
        true,
    )?;

    let root = ensure_yaml_object(config)?;
    let stt = yaml_child_object(root, "stt")?;
    stt.insert(yaml_key("enabled"), serde_yaml::Value::Bool(stt_enabled));
    stt.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(stt_provider),
    );

    let local = yaml_child_object(stt, "local")?;
    local.insert(
        yaml_key("model"),
        serde_yaml::Value::String(stt_local_model),
    );
    local.insert(
        yaml_key("language"),
        serde_yaml::Value::String(stt_local_language),
    );

    let openai = yaml_child_object(stt, "openai")?;
    openai.insert(
        yaml_key("model"),
        serde_yaml::Value::String(stt_openai_model),
    );

    let mistral = yaml_child_object(stt, "mistral")?;
    mistral.insert(
        yaml_key("model"),
        serde_yaml::Value::String(stt_mistral_model),
    );
    Ok(())
}

fn build_hermes_tts_voice_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let tts = root.and_then(|map| yaml_get_mapping(map, "tts"));
    let edge = tts.and_then(|map| yaml_get_mapping(map, "edge"));
    let openai = tts.and_then(|map| yaml_get_mapping(map, "openai"));
    let elevenlabs = tts.and_then(|map| yaml_get_mapping(map, "elevenlabs"));
    let xai = tts.and_then(|map| yaml_get_mapping(map, "xai"));
    let mistral = tts.and_then(|map| yaml_get_mapping(map, "mistral"));
    let piper = tts.and_then(|map| yaml_get_mapping(map, "piper"));
    let voice = root.and_then(|map| yaml_get_mapping(map, "voice"));
    let tts_string = |section: Option<&serde_yaml::Mapping>, key: &str, fallback: &str| {
        section
            .and_then(|map| yaml_string_field(map, key))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    serde_json::json!({
        "ttsProvider": normalize_hermes_tts_provider(tts.and_then(|map| yaml_string_field(map, "provider")), false).unwrap_or_else(|_| "edge".to_string()),
        "ttsEdgeVoice": tts_string(edge, "voice", "en-US-AriaNeural"),
        "ttsOpenaiModel": tts_string(openai, "model", "gpt-4o-mini-tts"),
        "ttsOpenaiVoice": normalize_hermes_tts_openai_voice(openai.and_then(|map| yaml_string_field(map, "voice")), false).unwrap_or_else(|_| "alloy".to_string()),
        "ttsElevenlabsVoiceId": tts_string(elevenlabs, "voice_id", "pNInz6obpgDQGcFmaJgB"),
        "ttsElevenlabsModelId": tts_string(elevenlabs, "model_id", "eleven_multilingual_v2"),
        "ttsXaiVoiceId": tts_string(xai, "voice_id", "eve"),
        "ttsXaiLanguage": normalize_hermes_voice_language(xai.and_then(|map| yaml_string_field(map, "language")), false, "tts.xai.language").unwrap_or_else(|_| "en".to_string()),
        "ttsXaiSampleRate": xai.map(|map| bounded_hermes_i64(yaml_i64_field(map, "sample_rate"), 24000, 8000, 192000)).unwrap_or(24000),
        "ttsXaiBitRate": xai.map(|map| bounded_hermes_i64(yaml_i64_field(map, "bit_rate"), 128000, 16000, 512000)).unwrap_or(128000),
        "ttsMistralModel": tts_string(mistral, "model", "voxtral-mini-tts-2603"),
        "ttsMistralVoiceId": tts_string(mistral, "voice_id", "c69964a6-ab8b-4f8a-9465-ec0925096ec8"),
        "ttsPiperVoice": tts_string(piper, "voice", "en_US-lessac-medium"),
        "voiceRecordKey": voice.and_then(|map| yaml_string_field(map, "record_key")).map(|value| value.trim().to_string()).unwrap_or_else(|| "ctrl+b".to_string()),
        "voiceMaxRecordingSeconds": voice.map(|map| bounded_hermes_i64(yaml_i64_field(map, "max_recording_seconds"), 120, 1, 3600)).unwrap_or(120),
        "voiceAutoTts": voice.and_then(|map| yaml_bool_field(map, "auto_tts")).unwrap_or(false),
        "voiceBeepEnabled": voice.and_then(|map| yaml_bool_field(map, "beep_enabled")).unwrap_or(true),
        "voiceSilenceThreshold": voice.map(|map| bounded_hermes_i64(yaml_i64_field(map, "silence_threshold"), 200, 0, 32767)).unwrap_or(200),
        "voiceSilenceDuration": voice.map(|map| bounded_hermes_f64(yaml_f64_field(map, "silence_duration"), 3.0, 0.1, 60.0)).unwrap_or(3.0),
    })
}

fn merge_hermes_tts_voice_config(
    config: &mut serde_yaml::Value,
    form: &Value,
) -> Result<(), String> {
    let current = build_hermes_tts_voice_config_values(config);
    let form_or_current_string = |key: &str| {
        if form.get(key).is_some() {
            form_string(form, key)
        } else {
            current[key].as_str().map(ToString::to_string)
        }
    };
    let tts_provider = normalize_hermes_tts_provider(form_or_current_string("ttsProvider"), true)?;
    let tts_edge_voice = form_or_current_string("ttsEdgeVoice")
        .unwrap_or_default()
        .trim()
        .to_string();
    let tts_openai_model = form_or_current_string("ttsOpenaiModel")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini-tts".to_string());
    let tts_openai_voice =
        normalize_hermes_tts_openai_voice(form_or_current_string("ttsOpenaiVoice"), true)?;
    let tts_elevenlabs_voice_id = form_or_current_string("ttsElevenlabsVoiceId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let tts_elevenlabs_model_id = form_or_current_string("ttsElevenlabsModelId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let tts_xai_voice_id = form_or_current_string("ttsXaiVoiceId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "eve".to_string());
    let tts_xai_language = normalize_hermes_voice_language(
        form_or_current_string("ttsXaiLanguage"),
        true,
        "tts.xai.language",
    )?;
    let tts_xai_sample_rate = validate_hermes_i64(
        if form.get("ttsXaiSampleRate").is_some() {
            form_i64(form, "ttsXaiSampleRate")
        } else {
            current["ttsXaiSampleRate"].as_i64()
        },
        "tts.xai.sample_rate",
        24000,
        8000,
        192000,
    )?;
    let tts_xai_bit_rate = validate_hermes_i64(
        if form.get("ttsXaiBitRate").is_some() {
            form_i64(form, "ttsXaiBitRate")
        } else {
            current["ttsXaiBitRate"].as_i64()
        },
        "tts.xai.bit_rate",
        128000,
        16000,
        512000,
    )?;
    let tts_mistral_model = form_or_current_string("ttsMistralModel")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "voxtral-mini-tts-2603".to_string());
    let tts_mistral_voice_id = form_or_current_string("ttsMistralVoiceId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let tts_piper_voice = form_or_current_string("ttsPiperVoice")
        .unwrap_or_default()
        .trim()
        .to_string();
    let voice_record_key = form_or_current_string("voiceRecordKey")
        .unwrap_or_default()
        .trim()
        .to_string();
    let voice_max_recording_seconds = validate_hermes_i64(
        if form.get("voiceMaxRecordingSeconds").is_some() {
            form_i64(form, "voiceMaxRecordingSeconds")
        } else {
            current["voiceMaxRecordingSeconds"].as_i64()
        },
        "voice.max_recording_seconds",
        120,
        1,
        3600,
    )?;
    let voice_auto_tts = form_bool(form, "voiceAutoTts")
        .unwrap_or_else(|| current["voiceAutoTts"].as_bool().unwrap_or(false));
    let voice_beep_enabled = form_bool(form, "voiceBeepEnabled")
        .unwrap_or_else(|| current["voiceBeepEnabled"].as_bool().unwrap_or(true));
    let voice_silence_threshold = validate_hermes_i64(
        if form.get("voiceSilenceThreshold").is_some() {
            form_i64(form, "voiceSilenceThreshold")
        } else {
            current["voiceSilenceThreshold"].as_i64()
        },
        "voice.silence_threshold",
        200,
        0,
        32767,
    )?;
    let voice_silence_duration = validate_hermes_f64(
        if form.get("voiceSilenceDuration").is_some() {
            form_f64(form, "voiceSilenceDuration")
        } else {
            current["voiceSilenceDuration"].as_f64()
        },
        "voice.silence_duration",
        3.0,
        0.1,
        60.0,
    )?;

    let root = ensure_yaml_object(config)?;
    let tts = yaml_child_object(root, "tts")?;
    tts.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(tts_provider),
    );
    let edge = yaml_child_object(tts, "edge")?;
    set_optional_yaml_string(edge, "voice", tts_edge_voice);
    let openai = yaml_child_object(tts, "openai")?;
    openai.insert(
        yaml_key("model"),
        serde_yaml::Value::String(tts_openai_model),
    );
    openai.insert(
        yaml_key("voice"),
        serde_yaml::Value::String(tts_openai_voice),
    );
    let elevenlabs = yaml_child_object(tts, "elevenlabs")?;
    set_optional_yaml_string(elevenlabs, "voice_id", tts_elevenlabs_voice_id);
    set_optional_yaml_string(elevenlabs, "model_id", tts_elevenlabs_model_id);
    let xai = yaml_child_object(tts, "xai")?;
    xai.insert(
        yaml_key("voice_id"),
        serde_yaml::Value::String(tts_xai_voice_id),
    );
    xai.insert(
        yaml_key("language"),
        serde_yaml::Value::String(tts_xai_language),
    );
    xai.insert(
        yaml_key("sample_rate"),
        serde_yaml::Value::Number(tts_xai_sample_rate.into()),
    );
    xai.insert(
        yaml_key("bit_rate"),
        serde_yaml::Value::Number(tts_xai_bit_rate.into()),
    );
    let mistral = yaml_child_object(tts, "mistral")?;
    mistral.insert(
        yaml_key("model"),
        serde_yaml::Value::String(tts_mistral_model),
    );
    set_optional_yaml_string(mistral, "voice_id", tts_mistral_voice_id);
    let piper = yaml_child_object(tts, "piper")?;
    set_optional_yaml_string(piper, "voice", tts_piper_voice);

    let voice = yaml_child_object(root, "voice")?;
    set_optional_yaml_string(voice, "record_key", voice_record_key);
    voice.insert(
        yaml_key("max_recording_seconds"),
        serde_yaml::Value::Number(voice_max_recording_seconds.into()),
    );
    voice.insert(
        yaml_key("auto_tts"),
        serde_yaml::Value::Bool(voice_auto_tts),
    );
    voice.insert(
        yaml_key("beep_enabled"),
        serde_yaml::Value::Bool(voice_beep_enabled),
    );
    voice.insert(
        yaml_key("silence_threshold"),
        serde_yaml::Value::Number(voice_silence_threshold.into()),
    );
    voice.insert(
        yaml_key("silence_duration"),
        serde_yaml::to_value(voice_silence_duration).map_err(|err| err.to_string())?,
    );
    Ok(())
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
    let delegation_model = form_string(form, "delegationModel")
        .or_else(|| current["delegationModel"].as_str().map(ToString::to_string))
        .unwrap_or_default()
        .trim()
        .to_string();
    let delegation_provider = form_string(form, "delegationProvider")
        .or_else(|| {
            current["delegationProvider"]
                .as_str()
                .map(ToString::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();

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
    if delegation_model.is_empty() {
        delegation.remove(yaml_key("model"));
    } else {
        delegation.insert(
            yaml_key("model"),
            serde_yaml::Value::String(delegation_model),
        );
    }
    if delegation_provider.is_empty() {
        delegation.remove(yaml_key("provider"));
    } else {
        delegation.insert(
            yaml_key("provider"),
            serde_yaml::Value::String(delegation_provider),
        );
    }
    Ok(())
}

fn build_hermes_terminal_config_values(config: &serde_yaml::Value) -> Value {
    let root = config.as_mapping();
    let terminal = root.and_then(|map| yaml_get_mapping(map, "terminal"));
    let terminal_string = |key: &str| {
        terminal
            .and_then(|map| yaml_string_field(map, key))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
    };
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
    let terminal_shell_init_files = terminal
        .map(|map| yaml_string_sequence_field(map, "shell_init_files").join("\n"))
        .unwrap_or_default();
    let terminal_auto_source_bashrc = terminal
        .and_then(|map| yaml_bool_field(map, "auto_source_bashrc"))
        .unwrap_or(true);
    let terminal_persistent_shell = terminal
        .and_then(|map| yaml_bool_field(map, "persistent_shell"))
        .unwrap_or(true);
    let terminal_env_passthrough = terminal
        .map(|map| yaml_string_sequence_field(map, "env_passthrough").join("\n"))
        .unwrap_or_default();
    let terminal_docker_mount_cwd_to_workspace = terminal
        .and_then(|map| yaml_bool_field(map, "docker_mount_cwd_to_workspace"))
        .unwrap_or(false);
    let terminal_docker_run_as_host_user = terminal
        .and_then(|map| yaml_bool_field(map, "docker_run_as_host_user"))
        .unwrap_or(false);
    let terminal_docker_image = terminal_string("docker_image");
    let terminal_singularity_image = terminal_string("singularity_image");
    let terminal_modal_image = terminal_string("modal_image");
    let terminal_modal_mode = normalize_hermes_terminal_modal_mode(
        terminal.and_then(|map| yaml_string_field(map, "modal_mode")),
        false,
    )
    .unwrap_or_else(|_| "auto".to_string());
    let terminal_vercel_runtime = normalize_hermes_terminal_vercel_runtime(
        terminal.and_then(|map| yaml_string_field(map, "vercel_runtime")),
        false,
    )
    .unwrap_or_else(|_| "node24".to_string());
    let terminal_daytona_image = terminal_string("daytona_image");
    let terminal_docker_forward_env = terminal
        .map(|map| yaml_string_sequence_field(map, "docker_forward_env").join("\n"))
        .unwrap_or_default();
    let terminal_docker_env_json = yaml_docker_env_json_field(terminal, "docker_env");
    let terminal_docker_volumes = terminal
        .map(|map| yaml_string_sequence_field(map, "docker_volumes").join("\n"))
        .unwrap_or_default();
    let terminal_docker_extra_args = terminal
        .map(|map| yaml_string_sequence_field(map, "docker_extra_args").join("\n"))
        .unwrap_or_default();
    let terminal_ssh_host = terminal_string("ssh_host");
    let terminal_ssh_user = terminal_string("ssh_user");
    let terminal_ssh_port = terminal
        .map(|map| bounded_hermes_i64(yaml_i64_field(map, "ssh_port"), 22, 1, 65535))
        .unwrap_or(22);
    let terminal_ssh_key = terminal_string("ssh_key");
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
        "terminalShellInitFiles": terminal_shell_init_files,
        "terminalAutoSourceBashrc": terminal_auto_source_bashrc,
        "terminalPersistentShell": terminal_persistent_shell,
        "terminalEnvPassthrough": terminal_env_passthrough,
        "terminalDockerMountCwdToWorkspace": terminal_docker_mount_cwd_to_workspace,
        "terminalDockerRunAsHostUser": terminal_docker_run_as_host_user,
        "terminalDockerImage": terminal_docker_image,
        "terminalSingularityImage": terminal_singularity_image,
        "terminalModalImage": terminal_modal_image,
        "terminalModalMode": terminal_modal_mode,
        "terminalVercelRuntime": terminal_vercel_runtime,
        "terminalDaytonaImage": terminal_daytona_image,
        "terminalDockerForwardEnv": terminal_docker_forward_env,
        "terminalDockerEnvJson": terminal_docker_env_json,
        "terminalDockerVolumes": terminal_docker_volumes,
        "terminalDockerExtraArgs": terminal_docker_extra_args,
        "terminalSshHost": terminal_ssh_host,
        "terminalSshUser": terminal_ssh_user,
        "terminalSshPort": terminal_ssh_port,
        "terminalSshKey": terminal_ssh_key,
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
    let terminal_shell_init_files = normalize_hermes_shell_init_file_list(
        form_string(form, "terminalShellInitFiles").or_else(|| {
            current["terminalShellInitFiles"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.shell_init_files",
    )?;
    let terminal_auto_source_bashrc =
        form_bool(form, "terminalAutoSourceBashrc").unwrap_or_else(|| {
            current["terminalAutoSourceBashrc"]
                .as_bool()
                .unwrap_or(true)
        });
    let terminal_persistent_shell = form_bool(form, "terminalPersistentShell")
        .unwrap_or_else(|| current["terminalPersistentShell"].as_bool().unwrap_or(true));
    let terminal_env_passthrough = normalize_hermes_env_name_list(
        form_string(form, "terminalEnvPassthrough").or_else(|| {
            current["terminalEnvPassthrough"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.env_passthrough",
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
    let terminal_modal_mode = normalize_hermes_terminal_modal_mode(
        if form.get("terminalModalMode").is_some() {
            form_string(form, "terminalModalMode")
        } else {
            current["terminalModalMode"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let terminal_vercel_runtime = normalize_hermes_terminal_vercel_runtime(
        if form.get("terminalVercelRuntime").is_some() {
            form_string(form, "terminalVercelRuntime")
        } else {
            current["terminalVercelRuntime"]
                .as_str()
                .map(ToString::to_string)
        },
        true,
    )?;
    let terminal_docker_image = form_string(form, "terminalDockerImage")
        .or_else(|| {
            current["terminalDockerImage"]
                .as_str()
                .map(ToString::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_singularity_image = form_string(form, "terminalSingularityImage")
        .or_else(|| {
            current["terminalSingularityImage"]
                .as_str()
                .map(ToString::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_modal_image = form_string(form, "terminalModalImage")
        .or_else(|| {
            current["terminalModalImage"]
                .as_str()
                .map(ToString::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_daytona_image = form_string(form, "terminalDaytonaImage")
        .or_else(|| {
            current["terminalDaytonaImage"]
                .as_str()
                .map(ToString::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_docker_forward_env = normalize_hermes_env_name_list(
        form_string(form, "terminalDockerForwardEnv").or_else(|| {
            current["terminalDockerForwardEnv"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.docker_forward_env",
    )?;
    let terminal_docker_env = normalize_hermes_docker_env_json(
        form_string(form, "terminalDockerEnvJson").or_else(|| {
            current["terminalDockerEnvJson"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.docker_env",
    )?;
    let terminal_docker_volumes = normalize_hermes_docker_volume_list(
        form_string(form, "terminalDockerVolumes").or_else(|| {
            current["terminalDockerVolumes"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.docker_volumes",
    )?;
    let terminal_docker_extra_args = normalize_hermes_docker_extra_args_list(
        form_string(form, "terminalDockerExtraArgs").or_else(|| {
            current["terminalDockerExtraArgs"]
                .as_str()
                .map(ToString::to_string)
        }),
        "terminal.docker_extra_args",
    )?;
    let terminal_ssh_host = form_string(form, "terminalSshHost")
        .or_else(|| current["terminalSshHost"].as_str().map(ToString::to_string))
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_ssh_user = form_string(form, "terminalSshUser")
        .or_else(|| current["terminalSshUser"].as_str().map(ToString::to_string))
        .unwrap_or_default()
        .trim()
        .to_string();
    let terminal_ssh_port = validate_hermes_i64(
        if form.get("terminalSshPort").is_some() {
            form_i64(form, "terminalSshPort")
        } else {
            Some(current["terminalSshPort"].as_i64().unwrap_or(22))
        },
        "terminal.ssh_port",
        22,
        1,
        65535,
    )?;
    let terminal_ssh_key = form_string(form, "terminalSshKey")
        .or_else(|| current["terminalSshKey"].as_str().map(ToString::to_string))
        .unwrap_or_default()
        .trim()
        .to_string();
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
    if terminal_shell_init_files.is_empty() {
        terminal.remove(yaml_key("shell_init_files"));
    } else {
        terminal.insert(
            yaml_key("shell_init_files"),
            serde_yaml::Value::Sequence(
                terminal_shell_init_files
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    terminal.insert(
        yaml_key("auto_source_bashrc"),
        serde_yaml::Value::Bool(terminal_auto_source_bashrc),
    );
    terminal.insert(
        yaml_key("persistent_shell"),
        serde_yaml::Value::Bool(terminal_persistent_shell),
    );
    if terminal_env_passthrough.is_empty() {
        terminal.remove(yaml_key("env_passthrough"));
    } else {
        terminal.insert(
            yaml_key("env_passthrough"),
            serde_yaml::Value::Sequence(
                terminal_env_passthrough
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    terminal.insert(
        yaml_key("docker_mount_cwd_to_workspace"),
        serde_yaml::Value::Bool(terminal_docker_mount_cwd_to_workspace),
    );
    terminal.insert(
        yaml_key("docker_run_as_host_user"),
        serde_yaml::Value::Bool(terminal_docker_run_as_host_user),
    );
    set_optional_yaml_string(terminal, "docker_image", terminal_docker_image);
    set_optional_yaml_string(terminal, "singularity_image", terminal_singularity_image);
    set_optional_yaml_string(terminal, "modal_image", terminal_modal_image);
    terminal.insert(
        yaml_key("modal_mode"),
        serde_yaml::Value::String(terminal_modal_mode),
    );
    terminal.insert(
        yaml_key("vercel_runtime"),
        serde_yaml::Value::String(terminal_vercel_runtime),
    );
    set_optional_yaml_string(terminal, "daytona_image", terminal_daytona_image);
    if terminal_docker_forward_env.is_empty() {
        terminal.remove(yaml_key("docker_forward_env"));
    } else {
        terminal.insert(
            yaml_key("docker_forward_env"),
            serde_yaml::Value::Sequence(
                terminal_docker_forward_env
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    if terminal_docker_env.is_empty() {
        terminal.remove(yaml_key("docker_env"));
    } else {
        let mut docker_env = serde_yaml::Mapping::new();
        for (name, value) in terminal_docker_env {
            let value = value.as_str().unwrap_or_default().to_string();
            docker_env.insert(yaml_key(&name), serde_yaml::Value::String(value));
        }
        terminal.insert(
            yaml_key("docker_env"),
            serde_yaml::Value::Mapping(docker_env),
        );
    }
    if terminal_docker_volumes.is_empty() {
        terminal.remove(yaml_key("docker_volumes"));
    } else {
        terminal.insert(
            yaml_key("docker_volumes"),
            serde_yaml::Value::Sequence(
                terminal_docker_volumes
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    if terminal_docker_extra_args.is_empty() {
        terminal.remove(yaml_key("docker_extra_args"));
    } else {
        terminal.insert(
            yaml_key("docker_extra_args"),
            serde_yaml::Value::Sequence(
                terminal_docker_extra_args
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    set_optional_yaml_string(terminal, "ssh_host", terminal_ssh_host);
    set_optional_yaml_string(terminal, "ssh_user", terminal_ssh_user);
    terminal.insert(
        yaml_key("ssh_port"),
        serde_yaml::Value::Number(terminal_ssh_port.into()),
    );
    set_optional_yaml_string(terminal, "ssh_key", terminal_ssh_key);
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
    let worktree_enabled = root
        .and_then(|map| yaml_bool_field(map, "worktree"))
        .unwrap_or(false);

    serde_json::json!({
        "sessionResetMode": mode,
        "idleMinutes": idle_minutes,
        "atHour": at_hour,
        "groupSessionsPerUser": group_sessions_per_user,
        "threadSessionsPerUser": thread_sessions_per_user,
        "worktreeEnabled": worktree_enabled,
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
    let worktree_enabled = form_bool(form, "worktreeEnabled")
        .unwrap_or_else(|| current["worktreeEnabled"].as_bool().unwrap_or(false));

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
    root.insert(
        yaml_key("worktree"),
        serde_yaml::Value::Bool(worktree_enabled),
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
        "telegram" => {
            delete_yaml_key(entry, "token");
            set_extra_string_if_present(
                entry,
                "reply_to_mode",
                Some(normalize_hermes_telegram_reply_to_mode(
                    form_string(form, "replyToMode"),
                    true,
                )?),
            );
            if let Some(value) = form_bool(form, "guestMode") {
                set_extra_bool(entry, "guest_mode", value);
            }
            if let Some(value) = form_bool(form, "disableLinkPreviews") {
                set_extra_bool(entry, "disable_link_previews", value);
            }
        }
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
            push(
                "TELEGRAM_REPLY_TO_MODE",
                normalize_hermes_telegram_reply_to_mode(form_string(form, "replyToMode"), true)
                    .unwrap_or_else(|_| "first".to_string()),
            );
            if let Some(value) = form_bool(form, "guestMode") {
                push("TELEGRAM_GUEST_MODE", bool_env_value(value));
            }
            if let Some(value) = form_bool(form, "disableLinkPreviews") {
                push("TELEGRAM_DISABLE_LINK_PREVIEWS", bool_env_value(value));
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
pub fn hermes_prompt_caching_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_prompt_caching_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_prompt_caching_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_prompt_caching_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_prompt_caching_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_openrouter_cache_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_openrouter_cache_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_openrouter_cache_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_openrouter_cache_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_openrouter_cache_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_provider_routing_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_provider_routing_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_provider_routing_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_provider_routing_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_provider_routing_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_auxiliary_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_auxiliary_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_auxiliary_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_auxiliary_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_auxiliary_config_values(&config),
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
pub fn hermes_curator_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_curator_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_curator_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_curator_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_curator_config_values(&config),
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
pub fn hermes_model_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_model_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_model_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_model_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_model_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_model_aliases_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_model_aliases_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_model_aliases_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_model_aliases_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_model_aliases_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_hooks_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_hooks_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_hooks_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_hooks_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_hooks_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_provider_overrides_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_provider_overrides_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_provider_overrides_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_provider_overrides_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_provider_overrides_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_mcp_servers_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_mcp_servers_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_mcp_servers_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_mcp_servers_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_mcp_servers_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_agent_toolsets_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_agent_toolsets_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_agent_toolsets_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_agent_toolsets_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_agent_toolsets_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_platform_toolsets_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_platform_toolsets_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_platform_toolsets_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_platform_toolsets_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_platform_toolsets_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_agent_runtime_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_agent_runtime_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_agent_runtime_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_agent_runtime_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_agent_runtime_config_values(&config),
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
pub fn hermes_display_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_display_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_display_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_display_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_display_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_kanban_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_kanban_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_kanban_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_kanban_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_kanban_config_values(&config),
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
pub fn hermes_io_safety_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_io_safety_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_io_safety_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_io_safety_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_io_safety_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_checkpoints_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_checkpoints_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_checkpoints_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_checkpoints_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_checkpoints_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_cron_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_cron_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_cron_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_cron_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_cron_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_sessions_maintenance_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_sessions_maintenance_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_sessions_maintenance_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_sessions_maintenance_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_sessions_maintenance_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_updates_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_updates_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_updates_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_updates_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_updates_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_logging_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_logging_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_logging_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_logging_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_logging_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_approvals_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_approvals_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_approvals_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_approvals_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_approvals_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_privacy_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_privacy_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_privacy_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_privacy_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_privacy_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_browser_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_browser_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_browser_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_browser_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_browser_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_web_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_web_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_web_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_web_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_web_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_lsp_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_lsp_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_lsp_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_lsp_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_lsp_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_model_catalog_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_model_catalog_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_model_catalog_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_model_catalog_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_model_catalog_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_x_search_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_x_search_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_x_search_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_x_search_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_x_search_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_context_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_context_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_context_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_context_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_context_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_stt_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_stt_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_stt_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_stt_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_stt_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_tts_voice_config_read() -> Result<Value, String> {
    let (config_path, exists, config) = read_hermes_channel_yaml_config()?;
    ensure_yaml_object(&mut config.clone())?;
    Ok(serde_json::json!({
        "exists": exists,
        "configPath": config_path.to_string_lossy(),
        "values": build_hermes_tts_voice_config_values(&config),
    }))
}

#[tauri::command]
pub fn hermes_tts_voice_config_save(form: Value) -> Result<Value, String> {
    let (config_path, _exists, mut config) = read_hermes_channel_yaml_config()?;
    merge_hermes_tts_voice_config(&mut config, &form)?;
    let backup = write_hermes_yaml_config(&config_path, &config)?;
    Ok(serde_json::json!({
        "ok": true,
        "configPath": config_path.to_string_lossy(),
        "backup": backup,
        "values": build_hermes_tts_voice_config_values(&config),
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
    sanitize_hermes_openrouter_custom_mismatch()?;

    // 读取顶层 model 配置；不要让 auxiliary/x_search 等子配置污染仪表盘显示。
    let model_fields = if config_path.exists() {
        let config_raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取 config.yaml 失败: {e}"))?;
        read_top_level_hermes_model_fields(&config_raw)?
    } else {
        HermesModelFields::default()
    };
    let model_name = model_fields.default_model;
    let base_url_from_yaml = model_fields.base_url;
    let provider_from_yaml = model_fields.provider;

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
/// 优先级：
/// 1. 环境变量 `HERMES_PYTHON` — 适配自定义 venv（brew / 容器 / 任何非默认布局）
/// 2. `~/.hermes-venv/{Scripts,bin}/python` — `uv pip install` 备选安装路径
/// 3. `<uv tool dir>/hermes-agent/{Scripts,bin}/python` — `uv tool install` 默认路径
///    （ClawPanel `install_hermes` 默认走此分支，所以这里的 fallback 必不可少；
///    早期实现只查路径 #2 导致「可选依赖管理」等页面对绝大多数用户都误报「未安装」）
fn hermes_venv_python() -> Option<PathBuf> {
    // 1. HERMES_PYTHON 环境变量优先
    if let Ok(custom) = std::env::var("HERMES_PYTHON") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }
    // 2. 旧的 ~/.hermes-venv 位置（uv pip install 路径）
    if let Some(home) = dirs::home_dir() {
        let venv_dir = home.join(".hermes-venv");
        #[cfg(target_os = "windows")]
        let py = venv_dir.join("Scripts").join("python.exe");
        #[cfg(not(target_os = "windows"))]
        let py = venv_dir.join("bin").join("python");
        if py.exists() {
            return Some(py);
        }
    }
    // 3. uv tool 默认路径（ClawPanel 默认安装方式）
    hermes_uv_tool_python()
}

/// 统一跑 venv python -c "<script>" 拿 JSON 结果。失败给可读错误。
async fn run_venv_python_json(script: &str) -> Result<Value, String> {
    let py = hermes_venv_python().ok_or_else(|| {
        "Hermes Python 解释器未找到（已尝试 HERMES_PYTHON、~/.hermes-venv 与 uv tool 路径）。请先安装 Hermes。".to_string()
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

                let mut cmd = std::process::Command::new(hermes_program_for_spawn()?);
                cmd.args(["gateway", "run"])
                    .current_dir(&home)
                    .stdin(std::process::Stdio::null())
                    .stdout(log_file)
                    .stderr(log_err)
                    .creation_flags(CREATE_NO_WINDOW);
                apply_hermes_runtime_env(&mut cmd, &enhanced);
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

                let mut cmd = std::process::Command::new(hermes_program_for_spawn()?);
                cmd.args(["gateway", "run"])
                    .current_dir(&home)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                apply_hermes_runtime_env(&mut cmd, &enhanced);

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
                        let mut fallback =
                            tokio::process::Command::new(hermes_program_for_spawn()?);
                        fallback.args(["gateway", "start"]);
                        apply_hermes_runtime_env_tokio(&mut fallback, &enhanced);
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
            let mut cmd = tokio::process::Command::new(hermes_program_for_spawn()?);
            cmd.args(["gateway", "stop"]);
            apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
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
            let mut cmd = tokio::process::Command::new(hermes_program_for_spawn()?);
            cmd.args(["gateway", "status"]);
            apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let out = cmd.output().await.map_err(|e| format!("查询失败: {e}"))?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(stdout)
        }
        "install" => {
            let mut cmd = tokio::process::Command::new(hermes_program_for_spawn()?);
            cmd.args(["gateway", "install"]);
            apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
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
            let mut cmd = tokio::process::Command::new(hermes_program_for_spawn()?);
            cmd.args(["gateway", "uninstall"]);
            apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
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
    emit_hermes_stable_version_log(&app);
    let _ = app.emit("hermes-install-progress", 0u32);
    ensure_hermes_portable_dirs()?;
    ensure_portable_git(&app).await?;

    let uv = ensure_uv(&app).await?;

    let pkg = hermes_package_spec(&["web".to_string()]);
    let mut cmd = tokio::process::Command::new(&uv);
    cmd.args(["tool", "install", "--reinstall", &pkg, "--python", "3.11"]);
    append_hermes_runtime_extras(&mut cmd);
    let _ = app.emit("hermes-install-progress", 20u32);
    let _ = app.emit(
        "hermes-install-log",
        format!(
            "uv tool install --reinstall hermes-agent@{HERMES_STABLE_TAG} --python 3.11 {}",
            hermes_runtime_extras_log_segment()
        ),
    );
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(mirror) = pypi_mirror_url() {
        cmd.args(["--index-url", &mirror]);
    }
    apply_git_mirror_env(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    let enhanced = hermes_enhanced_path();
    apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
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
        // 注入 dashboard 兼容 stub（升级路径与安装路径保持一致，避免上游 wheel 漏装的子包再次缺失）
        inject_hermes_dashboard_compat_stub(&app);
        let _ = app.emit("hermes-install-log", "✅ 升级完成");
        let _ = app.emit("hermes-install-progress", 100u32);
        Ok(format!(
            "升级完成，当前稳定版: Hermes Agent {HERMES_STABLE_VERSION} ({HERMES_STABLE_TAG})"
        ))
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
    let portable_mode = crate::commands::portable::portable_context().is_some();

    let uv_path = uv_bin_path();
    if portable_mode && !uv_path.exists() {
        let _ = app.emit(
            "hermes-install-log",
            "💾 便携模式：未找到 U 盘 uv，跳过 uv tool uninstall",
        );
    } else {
        let uv = if uv_path.exists() {
            uv_path.to_string_lossy().to_string()
        } else {
            "uv".into()
        };

        // uv tool uninstall
        let mut cmd = tokio::process::Command::new(&uv);
        cmd.args(["tool", "uninstall", "hermes-agent"]);
        let _ = app.emit("hermes-install-log", "> uv tool uninstall hermes-agent");
        let enhanced = hermes_enhanced_path();
        apply_hermes_runtime_env_tokio(&mut cmd, &enhanced);
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

        if !output.status.success() && !portable_mode {
            return Err(format!("卸载失败: {}", stderr.trim()));
        }
    }
    let _ = app.emit("hermes-install-progress", 65u32);

    // 清理 venv（如果存在）
    let venv_dir = hermes_venv_dir();
    if venv_dir.exists() {
        let _ = app.emit(
            "hermes-install-log",
            format!("清理虚拟环境: {}", venv_dir.display()),
        );
        let _ = std::fs::remove_dir_all(&venv_dir);
    }

    if let Some(ctx) = crate::commands::portable::portable_context() {
        for dir in [
            ctx.engines_hermes_dir.join("hermes-agent"),
            ctx.engines_hermes_dir.join("bin"),
        ] {
            if dir.exists() {
                let _ = app.emit(
                    "hermes-install-log",
                    format!("清理便携引擎目录: {}", dir.display()),
                );
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
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

    let mut cmd = std::process::Command::new(hermes_program_for_spawn()?);
    cmd.args(["--profile", &profile, "gateway", "run"])
        .current_dir(&home)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    apply_hermes_runtime_env(&mut cmd, &enhanced);
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
    validate_hermes_fs_path_under(&root, rel_path)
}

fn validate_hermes_fs_path_under(
    root: &std::path::Path,
    rel_path: &str,
) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Hermes 目录不存在: {e}"))?;
    if rel_path.trim().is_empty() {
        return Ok(canonical_root);
    }

    let p = std::path::Path::new(rel_path);
    if p.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("路径不能包含 ..".into());
    }

    let target = if p.is_absolute() {
        p.to_path_buf()
    } else {
        canonical_root.join(p)
    };
    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("解析路径失败: {e}"))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| "路径缺少父目录".to_string())?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("父目录不存在或不可访问: {e}"))?;
        let Some(name) = target.file_name() else {
            return Err("路径缺少文件名".into());
        };
        canonical_parent.join(name)
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "路径不能跳出 {} 目录",
            canonical_root.to_string_lossy()
        ));
    }
    Ok(canonical_target)
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

#[cfg(test)]
mod hermes_fs_path_tests {
    use super::validate_hermes_fs_path_under;

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn rejects_parent_dir_segments() {
        let root = unique_temp_dir("hermes-fs-path");
        std::fs::create_dir_all(&root).unwrap();

        let err = validate_hermes_fs_path_under(&root, "../outside.txt").unwrap_err();

        let _ = std::fs::remove_dir_all(&root);
        assert!(err.contains(".."));
    }

    #[test]
    fn allows_new_file_under_root() {
        let root = unique_temp_dir("hermes-fs-path-new");
        std::fs::create_dir_all(root.join("notes")).unwrap();

        let target = validate_hermes_fs_path_under(&root, "notes/new.md").unwrap();

        let _ = std::fs::remove_dir_all(&root);
        assert!(target.ends_with(std::path::Path::new("notes").join("new.md")));
    }
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
mod hermes_dashboard_config_read_tests {
    use super::read_top_level_hermes_model_fields;

    #[test]
    fn dashboard_reader_uses_only_top_level_model_mapping() {
        let raw = "\
model:
  provider: openai-codex
  base_url: https://chatgpt.com/backend-api/codex
  default: gpt-5.5
auxiliary:
  web_extract:
    provider: custom
    model: ''
x_search:
  model: grok-4.20-reasoning
  provider: custom
";

        let fields = read_top_level_hermes_model_fields(raw).unwrap();

        assert_eq!(fields.default_model, "gpt-5.5");
        assert_eq!(fields.provider, "openai-codex");
        assert_eq!(fields.base_url, "https://chatgpt.com/backend-api/codex");
    }

    #[test]
    fn dashboard_reader_keeps_scalar_model_compatibility() {
        let raw = "\
model: gpt-5.5
x_search:
  model: grok-4.20-reasoning
  provider: custom
";

        let fields = read_top_level_hermes_model_fields(raw).unwrap();

        assert_eq!(fields.default_model, "gpt-5.5");
        assert!(fields.provider.is_empty());
        assert!(fields.base_url.is_empty());
    }

    #[test]
    fn dashboard_reader_rejects_invalid_yaml() {
        let raw = "\
model:
  provider: openai-codex
    default: gpt-5.5
";

        let err = read_top_level_hermes_model_fields(raw).unwrap_err();

        assert!(err.contains("config.yaml YAML 格式错误"));
    }
}

#[cfg(test)]
mod hermes_sanitizer_tests {
    use super::{
        normalize_hermes_provider_for_base_url, sanitize_hermes_openrouter_custom_mismatch_at,
        yaml_key,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_config(name: &str, raw: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("clawpanel-hermes-sanitizer-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        fs::write(&path, raw).unwrap();
        path
    }

    fn top_level_section(raw: &str, key: &str) -> String {
        let mut out = String::new();
        let mut in_section = false;
        for line in raw.lines() {
            let trimmed = line.trim();
            let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
            if indent == 0 && trimmed.starts_with(&format!("{key}:")) {
                in_section = true;
            } else if in_section && indent == 0 && !trimmed.is_empty() && !trimmed.starts_with('#')
            {
                break;
            }
            if in_section {
                out.push_str(line);
                out.push('\n');
            }
        }
        out
    }

    fn top_level_model_provider(raw: &str) -> Option<String> {
        let config: serde_yaml::Value = serde_yaml::from_str(raw).unwrap();
        let root = config.as_mapping().unwrap();
        root.get(yaml_key("model"))
            .and_then(|model| model.as_mapping())
            .and_then(|model| model.get(yaml_key("provider")))
            .and_then(|provider| provider.as_str())
            .map(ToString::to_string)
    }

    #[test]
    fn sanitizer_keeps_openai_codex_with_codex_endpoint_unchanged() {
        let raw = "\
model:
  provider: openai-codex
  base_url: https://chatgpt.com/backend-api/codex
  default: gpt-5.5
auxiliary:
  web_extract:
    provider: custom
    model: ''
";
        let path = write_config("codex-noop", raw);

        assert!(!sanitize_hermes_openrouter_custom_mismatch_at(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        assert_eq!(
            normalize_hermes_provider_for_base_url(
                "openrouter",
                Some("https://chatgpt.com/backend-api/codex"),
            ),
            "openai-codex"
        );
    }

    #[test]
    fn sanitizer_repairs_custom_codex_endpoint_without_touching_auxiliary() {
        let raw = "\
model:
  provider: custom
  base_url: https://chatgpt.com/backend-api/codex
  default: gpt-5.5
auxiliary:
  vision:
    provider: auto
    model: ''
  web_extract:
    provider: custom
    model: ''
display:
  theme: system
";
        let path = write_config("custom-codex", raw);
        let auxiliary_before = top_level_section(raw, "auxiliary");

        assert!(sanitize_hermes_openrouter_custom_mismatch_at(&path).unwrap());
        let fixed = fs::read_to_string(&path).unwrap();

        serde_yaml::from_str::<serde_yaml::Value>(&fixed).unwrap();
        assert_eq!(
            top_level_model_provider(&fixed).as_deref(),
            Some("openai-codex")
        );
        assert_eq!(top_level_section(&fixed, "auxiliary"), auxiliary_before);
    }

    #[test]
    fn sanitizer_rewrites_openrouter_custom_endpoint_only_at_top_level() {
        let raw = "\
model:
  provider: openrouter
  base_url: https://example.invalid/v1
  default: gpt-5.5
auxiliary:
  compression:
    provider: openrouter
    model: ''
";
        let path = write_config("openrouter-custom", raw);
        let auxiliary_before = top_level_section(raw, "auxiliary");

        assert!(sanitize_hermes_openrouter_custom_mismatch_at(&path).unwrap());
        let fixed = fs::read_to_string(&path).unwrap();

        serde_yaml::from_str::<serde_yaml::Value>(&fixed).unwrap();
        assert_eq!(top_level_model_provider(&fixed).as_deref(), Some("custom"));
        assert_eq!(top_level_section(&fixed, "auxiliary"), auxiliary_before);
    }

    #[test]
    fn sanitizer_leaves_custom_non_codex_endpoint_unchanged() {
        let raw = "\
model:
  provider: custom
  base_url: https://example.invalid/v1
  default: gpt-5.5
";
        let path = write_config("custom-non-codex", raw);

        assert!(!sanitize_hermes_openrouter_custom_mismatch_at(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn sanitizer_rejects_invalid_yaml_without_writing() {
        let raw = "\
model:
  provider: openrouter
  base_url: https://example.invalid/v1
auxiliary:
  web_extract:
  provider: custom
    model: ''
";
        let path = write_config("invalid-yaml", raw);
        let err = sanitize_hermes_openrouter_custom_mismatch_at(&path).unwrap_err();

        assert!(err.contains("config.yaml YAML 格式错误"));
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
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
        assert_eq!(values["worktreeEnabled"], false);
    }

    #[test]
    fn session_runtime_values_read_worktree_flag() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
session_reset:
  mode: daily
  idle_minutes: 720
  at_hour: 3
group_sessions_per_user: false
thread_sessions_per_user: true
worktree: true
"#,
        )
        .unwrap();
        let values = build_hermes_session_runtime_config_values(&config);

        assert_eq!(values["sessionResetMode"], "daily");
        assert_eq!(values["idleMinutes"], 720);
        assert_eq!(values["atHour"], 3);
        assert_eq!(values["groupSessionsPerUser"], false);
        assert_eq!(values["threadSessionsPerUser"], true);
        assert_eq!(values["worktreeEnabled"], true);
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
                "worktreeEnabled": true,
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
        assert_eq!(config["worktree"].as_bool(), Some(true));
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
mod hermes_prompt_caching_config_tests {
    use super::{build_hermes_prompt_caching_config_values, merge_hermes_prompt_caching_config};
    use serde_json::json;

    #[test]
    fn prompt_caching_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_prompt_caching_config_values(&config);
        assert_eq!(values["promptCacheTtl"], "5m");
    }

    #[test]
    fn prompt_caching_values_normalize_existing_ttl() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
prompt_caching:
  cache_ttl: "1H"
"#,
        )
        .unwrap();

        let values = build_hermes_prompt_caching_config_values(&config);
        assert_eq!(values["promptCacheTtl"], "1h");
    }

    #[test]
    fn merge_prompt_caching_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
prompt_caching:
  cache_ttl: 5m
  custom_flag: keep-prompt-cache
compression:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_prompt_caching_config(
            &mut config,
            &json!({
                "promptCacheTtl": "1h",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["compression"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["prompt_caching"]["cache_ttl"].as_str(), Some("1h"));
        assert_eq!(
            config["prompt_caching"]["custom_flag"].as_str(),
            Some("keep-prompt-cache")
        );
    }

    #[test]
    fn merge_prompt_caching_config_rejects_invalid_ttl() {
        let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let err =
            merge_hermes_prompt_caching_config(&mut config, &json!({ "promptCacheTtl": "30m" }))
                .unwrap_err();
        assert!(err.contains("prompt_caching.cache_ttl"));
    }
}

#[cfg(test)]
mod hermes_openrouter_cache_config_tests {
    use super::{
        build_hermes_openrouter_cache_config_values, merge_hermes_openrouter_cache_config,
    };
    use serde_json::json;

    #[test]
    fn openrouter_cache_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_openrouter_cache_config_values(&config);
        assert_eq!(values["openrouterResponseCache"], true);
        assert_eq!(values["openrouterResponseCacheTtl"], 300);
    }

    #[test]
    fn openrouter_cache_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
openrouter:
  response_cache: false
  response_cache_ttl: 900
"#,
        )
        .unwrap();

        let values = build_hermes_openrouter_cache_config_values(&config);
        assert_eq!(values["openrouterResponseCache"], false);
        assert_eq!(values["openrouterResponseCacheTtl"], 900);
    }

    #[test]
    fn merge_openrouter_cache_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
openrouter:
  response_cache: false
  response_cache_ttl: 900
  custom_flag: keep-openrouter
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_openrouter_cache_config(
            &mut config,
            &json!({
                "openrouterResponseCache": true,
                "openrouterResponseCacheTtl": "600",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["openrouter"]["response_cache"].as_bool(), Some(true));
        assert_eq!(
            config["openrouter"]["response_cache_ttl"].as_i64(),
            Some(600)
        );
        assert_eq!(
            config["openrouter"]["custom_flag"].as_str(),
            Some("keep-openrouter")
        );
    }

    #[test]
    fn merge_openrouter_cache_config_rejects_invalid_ttl() {
        let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        for ttl in ["0", "86401", "1.5"] {
            let err = merge_hermes_openrouter_cache_config(
                &mut config,
                &json!({ "openrouterResponseCacheTtl": ttl }),
            )
            .unwrap_err();
            assert!(err.contains("openrouter.response_cache_ttl"));
        }
    }
}

#[cfg(test)]
mod hermes_provider_routing_config_tests {
    use super::{
        build_hermes_provider_routing_config_values, merge_hermes_provider_routing_config,
    };
    use serde_json::json;

    #[test]
    fn provider_routing_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_provider_routing_config_values(&config);
        assert_eq!(values["providerRoutingSort"], "price");
        assert_eq!(values["providerRoutingOnly"], "");
        assert_eq!(values["providerRoutingIgnore"], "");
        assert_eq!(values["providerRoutingOrder"], "");
        assert_eq!(values["providerRoutingRequireParameters"], false);
        assert_eq!(values["providerRoutingDataCollection"], "allow");
    }

    #[test]
    fn provider_routing_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
provider_routing:
  sort: throughput
  only:
    - anthropic
    - google
  ignore:
    - deepinfra
  order:
    - anthropic
    - google
    - together
  require_parameters: true
  data_collection: deny
"#,
        )
        .unwrap();

        let values = build_hermes_provider_routing_config_values(&config);
        assert_eq!(values["providerRoutingSort"], "throughput");
        assert_eq!(values["providerRoutingOnly"], "anthropic\ngoogle");
        assert_eq!(values["providerRoutingIgnore"], "deepinfra");
        assert_eq!(
            values["providerRoutingOrder"],
            "anthropic\ngoogle\ntogether"
        );
        assert_eq!(values["providerRoutingRequireParameters"], true);
        assert_eq!(values["providerRoutingDataCollection"], "deny");
    }

    #[test]
    fn merge_provider_routing_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
openrouter:
  response_cache: true
provider_routing:
  sort: price
  custom_flag: keep-routing
"#,
        )
        .unwrap();

        merge_hermes_provider_routing_config(
            &mut config,
            &json!({
                "providerRoutingSort": "latency",
                "providerRoutingOnly": " anthropic \n google \n anthropic ",
                "providerRoutingIgnore": "deepinfra\nfireworks",
                "providerRoutingOrder": "google\nanthropic",
                "providerRoutingRequireParameters": true,
                "providerRoutingDataCollection": "deny",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["openrouter"]["response_cache"].as_bool(), Some(true));
        assert_eq!(config["provider_routing"]["sort"].as_str(), Some("latency"));
        assert_eq!(
            config["provider_routing"]["only"].as_sequence().unwrap(),
            &vec![
                serde_yaml::Value::String("anthropic".to_string()),
                serde_yaml::Value::String("google".to_string()),
            ]
        );
        assert_eq!(
            config["provider_routing"]["ignore"].as_sequence().unwrap(),
            &vec![
                serde_yaml::Value::String("deepinfra".to_string()),
                serde_yaml::Value::String("fireworks".to_string()),
            ]
        );
        assert_eq!(
            config["provider_routing"]["order"].as_sequence().unwrap(),
            &vec![
                serde_yaml::Value::String("google".to_string()),
                serde_yaml::Value::String("anthropic".to_string()),
            ]
        );
        assert_eq!(
            config["provider_routing"]["require_parameters"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["provider_routing"]["data_collection"].as_str(),
            Some("deny")
        );
        assert_eq!(
            config["provider_routing"]["custom_flag"].as_str(),
            Some("keep-routing")
        );
    }

    #[test]
    fn merge_provider_routing_config_removes_empty_lists() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
provider_routing:
  only:
    - anthropic
  ignore:
    - deepinfra
  order:
    - google
"#,
        )
        .unwrap();

        merge_hermes_provider_routing_config(
            &mut config,
            &json!({
                "providerRoutingOnly": "",
                "providerRoutingIgnore": "  \n ",
                "providerRoutingOrder": "",
                "providerRoutingRequireParameters": false,
                "providerRoutingDataCollection": "allow",
            }),
        )
        .unwrap();

        assert_eq!(config["provider_routing"]["sort"].as_str(), Some("price"));
        assert_eq!(
            config["provider_routing"]["require_parameters"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["provider_routing"]["data_collection"].as_str(),
            Some("allow")
        );
        let provider_routing = config["provider_routing"].as_mapping().unwrap();
        assert!(!provider_routing.contains_key(super::yaml_key("only")));
        assert!(!provider_routing.contains_key(super::yaml_key("ignore")));
        assert!(!provider_routing.contains_key(super::yaml_key("order")));
    }

    #[test]
    fn merge_provider_routing_config_rejects_invalid_values() {
        for (form, expected) in [
            (
                json!({ "providerRoutingSort": "random" }),
                "provider_routing.sort",
            ),
            (
                json!({ "providerRoutingDataCollection": "maybe" }),
                "provider_routing.data_collection",
            ),
            (
                json!({ "providerRoutingOnly": "bad provider" }),
                "provider_routing.only",
            ),
            (
                json!({ "providerRoutingOrder": "../secret" }),
                "provider_routing.order",
            ),
        ] {
            let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
            let err = merge_hermes_provider_routing_config(&mut config, &form).unwrap_err();
            assert!(err.contains(expected), "{err}");
        }
    }
}

#[cfg(test)]
mod hermes_auxiliary_config_tests {
    use super::{build_hermes_auxiliary_config_values, merge_hermes_auxiliary_config};
    use serde_json::json;

    #[test]
    fn auxiliary_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_auxiliary_config_values(&config);
        assert_eq!(values["auxiliaryVisionProvider"], "auto");
        assert_eq!(values["auxiliaryVisionModel"], "");
        assert_eq!(values["auxiliaryVisionTimeout"], 30);
        assert_eq!(values["auxiliaryVisionDownloadTimeout"], 30);
        assert_eq!(values["auxiliaryWebExtractProvider"], "auto");
        assert_eq!(values["auxiliaryWebExtractModel"], "");
        assert_eq!(values["auxiliarySessionSearchProvider"], "auto");
        assert_eq!(values["auxiliarySessionSearchModel"], "");
        assert_eq!(values["auxiliarySessionSearchTimeout"], 30);
        assert_eq!(values["auxiliarySessionSearchMaxConcurrency"], 3);
    }

    #[test]
    fn auxiliary_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
auxiliary:
  vision:
    provider: openrouter
    model: google/gemini-2.5-flash
    timeout: 45
    download_timeout: 60
  web_extract:
    provider: main
    model: local-summary
  session_search:
    provider: nous
    model: gemini-3-flash
    timeout: 50
    max_concurrency: 5
"#,
        )
        .unwrap();

        let values = build_hermes_auxiliary_config_values(&config);
        assert_eq!(values["auxiliaryVisionProvider"], "openrouter");
        assert_eq!(values["auxiliaryVisionModel"], "google/gemini-2.5-flash");
        assert_eq!(values["auxiliaryVisionTimeout"], 45);
        assert_eq!(values["auxiliaryVisionDownloadTimeout"], 60);
        assert_eq!(values["auxiliaryWebExtractProvider"], "main");
        assert_eq!(values["auxiliaryWebExtractModel"], "local-summary");
        assert_eq!(values["auxiliarySessionSearchProvider"], "nous");
        assert_eq!(values["auxiliarySessionSearchModel"], "gemini-3-flash");
        assert_eq!(values["auxiliarySessionSearchTimeout"], 50);
        assert_eq!(values["auxiliarySessionSearchMaxConcurrency"], 5);
    }

    #[test]
    fn merge_auxiliary_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
auxiliary:
  vision:
    provider: auto
    custom_flag: keep-vision
  web_extract:
    custom_flag: keep-web
  session_search:
    extra_body:
      enable_thinking: false
    custom_flag: keep-search
  custom_task:
    provider: main
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_auxiliary_config(
            &mut config,
            &json!({
                "auxiliaryVisionProvider": "codex",
                "auxiliaryVisionModel": "gpt-5.3-codex",
                "auxiliaryVisionTimeout": "40",
                "auxiliaryVisionDownloadTimeout": "55",
                "auxiliaryWebExtractProvider": "gemini",
                "auxiliaryWebExtractModel": "gemini-3-flash",
                "auxiliarySessionSearchProvider": "ollama-cloud",
                "auxiliarySessionSearchModel": "gpt-oss:20b",
                "auxiliarySessionSearchTimeout": "70",
                "auxiliarySessionSearchMaxConcurrency": "6",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(
            config["auxiliary"]["vision"]["provider"].as_str(),
            Some("codex")
        );
        assert_eq!(
            config["auxiliary"]["vision"]["model"].as_str(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(config["auxiliary"]["vision"]["timeout"].as_i64(), Some(40));
        assert_eq!(
            config["auxiliary"]["vision"]["download_timeout"].as_i64(),
            Some(55)
        );
        assert_eq!(
            config["auxiliary"]["vision"]["custom_flag"].as_str(),
            Some("keep-vision")
        );
        assert_eq!(
            config["auxiliary"]["web_extract"]["provider"].as_str(),
            Some("gemini")
        );
        assert_eq!(
            config["auxiliary"]["web_extract"]["model"].as_str(),
            Some("gemini-3-flash")
        );
        assert_eq!(
            config["auxiliary"]["web_extract"]["custom_flag"].as_str(),
            Some("keep-web")
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["provider"].as_str(),
            Some("ollama-cloud")
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["model"].as_str(),
            Some("gpt-oss:20b")
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["timeout"].as_i64(),
            Some(70)
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["max_concurrency"].as_i64(),
            Some(6)
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["extra_body"]["enable_thinking"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["auxiliary"]["session_search"]["custom_flag"].as_str(),
            Some("keep-search")
        );
        assert_eq!(
            config["auxiliary"]["custom_task"]["provider"].as_str(),
            Some("main")
        );
    }

    #[test]
    fn merge_auxiliary_config_rejects_invalid_values() {
        let mut config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let err = merge_hermes_auxiliary_config(
            &mut config,
            &json!({ "auxiliaryVisionProvider": "bad-provider" }),
        )
        .unwrap_err();
        assert!(err.contains("auxiliary.vision.provider"));

        let err = merge_hermes_auxiliary_config(
            &mut config,
            &json!({ "auxiliaryVisionModel": "../secret" }),
        )
        .unwrap_err();
        assert!(err.contains("auxiliary.vision.model"));

        let err =
            merge_hermes_auxiliary_config(&mut config, &json!({ "auxiliaryVisionTimeout": 0 }))
                .unwrap_err();
        assert!(err.contains("auxiliary.vision.timeout"));

        let err = merge_hermes_auxiliary_config(
            &mut config,
            &json!({ "auxiliaryVisionDownloadTimeout": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("auxiliary.vision.download_timeout"));

        let err = merge_hermes_auxiliary_config(
            &mut config,
            &json!({ "auxiliarySessionSearchMaxConcurrency": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("auxiliary.session_search.max_concurrency"));
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
        assert_eq!(values["delegationModel"], "");
        assert_eq!(values["delegationProvider"], "");
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
  model: google/gemini-3-flash-preview
  provider: openrouter
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
        assert_eq!(values["delegationModel"], "google/gemini-3-flash-preview");
        assert_eq!(values["delegationProvider"], "openrouter");
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
                "delegationModel": "anthropic/claude-haiku-4.6",
                "delegationProvider": "anthropic",
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
        assert_eq!(
            config["delegation"]["model"].as_str(),
            Some("anthropic/claude-haiku-4.6")
        );
        assert_eq!(config["delegation"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(
            config["delegation"]["custom_flag"].as_str(),
            Some("keep-delegation")
        );
    }

    #[test]
    fn merge_execution_limits_config_removes_empty_child_model_overrides() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
delegation:
  model: child-model
  provider: openrouter
  custom_flag: keep-delegation
"#,
        )
        .unwrap();

        merge_hermes_execution_limits_config(
            &mut config,
            &json!({
                "delegationModel": "  ",
                "delegationProvider": "",
            }),
        )
        .unwrap();

        assert!(config["delegation"]["model"].is_null());
        assert!(config["delegation"]["provider"].is_null());
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
mod hermes_io_safety_config_tests {
    use super::{build_hermes_io_safety_config_values, merge_hermes_io_safety_config};
    use serde_json::json;

    #[test]
    fn io_safety_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_io_safety_config_values(&config);
        assert_eq!(values["fileReadMaxChars"], 100000);
        assert_eq!(values["toolOutputMaxBytes"], 50000);
        assert_eq!(values["toolOutputMaxLines"], 2000);
        assert_eq!(values["toolOutputMaxLineLength"], 2000);
    }

    #[test]
    fn io_safety_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
file_read_max_chars: 200000
tool_output:
  max_bytes: 150000
  max_lines: 5000
  max_line_length: 4000
"#,
        )
        .unwrap();
        let values = build_hermes_io_safety_config_values(&config);
        assert_eq!(values["fileReadMaxChars"], 200000);
        assert_eq!(values["toolOutputMaxBytes"], 150000);
        assert_eq!(values["toolOutputMaxLines"], 5000);
        assert_eq!(values["toolOutputMaxLineLength"], 4000);
    }

    #[test]
    fn merge_io_safety_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
file_read_max_chars: 100000
tool_output:
  max_bytes: 50000
  custom_flag: keep-output
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_io_safety_config(
            &mut config,
            &json!({
                "fileReadMaxChars": "120000",
                "toolOutputMaxBytes": "80000",
                "toolOutputMaxLines": "3000",
                "toolOutputMaxLineLength": "2500",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["file_read_max_chars"].as_i64(), Some(120000));
        assert_eq!(config["tool_output"]["max_bytes"].as_i64(), Some(80000));
        assert_eq!(config["tool_output"]["max_lines"].as_i64(), Some(3000));
        assert_eq!(
            config["tool_output"]["max_line_length"].as_i64(),
            Some(2500)
        );
        assert_eq!(
            config["tool_output"]["custom_flag"].as_str(),
            Some("keep-output")
        );
    }

    #[test]
    fn merge_io_safety_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_io_safety_config(&mut config, &json!({ "fileReadMaxChars": 999 }))
            .unwrap_err();
        assert!(err.contains("file_read_max_chars"));
        let err = merge_hermes_io_safety_config(&mut config, &json!({ "toolOutputMaxBytes": 999 }))
            .unwrap_err();
        assert!(err.contains("tool_output.max_bytes"));
        let err = merge_hermes_io_safety_config(&mut config, &json!({ "toolOutputMaxLines": 0 }))
            .unwrap_err();
        assert!(err.contains("tool_output.max_lines"));
        let err =
            merge_hermes_io_safety_config(&mut config, &json!({ "toolOutputMaxLineLength": 0 }))
                .unwrap_err();
        assert!(err.contains("tool_output.max_line_length"));
    }
}

#[cfg(test)]
mod hermes_privacy_config_tests {
    use super::{build_hermes_privacy_config_values, merge_hermes_privacy_config};
    use serde_json::json;

    #[test]
    fn privacy_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_privacy_config_values(&config);
        assert_eq!(values["redactPii"], false);
    }

    #[test]
    fn privacy_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
privacy:
  redact_pii: true
"#,
        )
        .unwrap();
        let values = build_hermes_privacy_config_values(&config);
        assert_eq!(values["redactPii"], true);
    }

    #[test]
    fn merge_privacy_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
privacy:
  redact_pii: false
  custom_flag: keep-privacy
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_privacy_config(
            &mut config,
            &json!({
                "redactPii": true,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["privacy"]["redact_pii"].as_bool(), Some(true));
        assert_eq!(
            config["privacy"]["custom_flag"].as_str(),
            Some("keep-privacy")
        );
    }
}

#[cfg(test)]
mod hermes_browser_config_tests {
    use super::{build_hermes_browser_config_values, merge_hermes_browser_config};
    use serde_json::json;

    #[test]
    fn browser_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_browser_config_values(&config);
        assert_eq!(values["browserInactivityTimeout"], 120);
        assert_eq!(values["browserCommandTimeout"], 30);
        assert_eq!(values["browserRecordSessions"], false);
        assert_eq!(values["browserEngine"], "auto");
        assert_eq!(values["browserAllowPrivateUrls"], false);
        assert_eq!(values["browserAutoLocalForPrivateUrls"], true);
        assert_eq!(values["browserCdpUrl"], "");
        assert_eq!(values["browserCamofoxManagedPersistence"], false);
        assert_eq!(values["browserCamofoxUserId"], "");
        assert_eq!(values["browserCamofoxSessionKey"], "");
        assert_eq!(values["browserCamofoxAdoptExistingTab"], false);
        assert_eq!(values["browserDialogPolicy"], "must_respond");
        assert_eq!(values["browserDialogTimeout"], 300);
    }

    #[test]
    fn browser_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
browser:
  inactivity_timeout: 300
  command_timeout: 45
  record_sessions: true
  engine: lightpanda
  allow_private_urls: true
  auto_local_for_private_urls: false
  cdp_url: ws://127.0.0.1:9222/devtools/browser/demo
  camofox:
    managed_persistence: true
    user_id: shared-camofox-user
    session_key: shared-session-key
    adopt_existing_tab: true
  dialog_policy: auto_accept
  dialog_timeout_s: 120
"#,
        )
        .unwrap();
        let values = build_hermes_browser_config_values(&config);
        assert_eq!(values["browserInactivityTimeout"], 300);
        assert_eq!(values["browserCommandTimeout"], 45);
        assert_eq!(values["browserRecordSessions"], true);
        assert_eq!(values["browserEngine"], "lightpanda");
        assert_eq!(values["browserAllowPrivateUrls"], true);
        assert_eq!(values["browserAutoLocalForPrivateUrls"], false);
        assert_eq!(
            values["browserCdpUrl"],
            "ws://127.0.0.1:9222/devtools/browser/demo"
        );
        assert_eq!(values["browserCamofoxManagedPersistence"], true);
        assert_eq!(values["browserCamofoxUserId"], "shared-camofox-user");
        assert_eq!(values["browserCamofoxSessionKey"], "shared-session-key");
        assert_eq!(values["browserCamofoxAdoptExistingTab"], true);
        assert_eq!(values["browserDialogPolicy"], "auto_accept");
        assert_eq!(values["browserDialogTimeout"], 120);
    }

    #[test]
    fn merge_browser_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
browser:
  inactivity_timeout: 120
  command_timeout: 30
  record_sessions: false
  engine: auto
  cdp_url: ws://127.0.0.1:9222/devtools/browser/demo
  camofox:
    managed_persistence: false
    user_id: old-user
    session_key: old-session
    adopt_existing_tab: false
    custom_flag: keep-camofox
  custom_flag: keep-browser
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_browser_config(
            &mut config,
            &json!({
                "browserInactivityTimeout": "180",
                "browserCommandTimeout": "60",
                "browserRecordSessions": true,
                "browserEngine": "chrome",
                "browserAllowPrivateUrls": true,
                "browserAutoLocalForPrivateUrls": false,
                "browserCdpUrl": "http://127.0.0.1:9222",
                "browserCamofoxManagedPersistence": true,
                "browserCamofoxUserId": "shared-camofox-user",
                "browserCamofoxSessionKey": "shared-session-key",
                "browserCamofoxAdoptExistingTab": true,
                "browserDialogPolicy": "auto_dismiss",
                "browserDialogTimeout": "45",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["browser"]["inactivity_timeout"].as_i64(), Some(180));
        assert_eq!(config["browser"]["command_timeout"].as_i64(), Some(60));
        assert_eq!(config["browser"]["record_sessions"].as_bool(), Some(true));
        assert_eq!(config["browser"]["engine"].as_str(), Some("chrome"));
        assert_eq!(
            config["browser"]["allow_private_urls"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["browser"]["auto_local_for_private_urls"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["browser"]["cdp_url"].as_str(),
            Some("http://127.0.0.1:9222")
        );
        assert_eq!(
            config["browser"]["dialog_policy"].as_str(),
            Some("auto_dismiss")
        );
        assert_eq!(config["browser"]["dialog_timeout_s"].as_i64(), Some(45));
        assert_eq!(
            config["browser"]["camofox"]["managed_persistence"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["browser"]["camofox"]["user_id"].as_str(),
            Some("shared-camofox-user")
        );
        assert_eq!(
            config["browser"]["camofox"]["session_key"].as_str(),
            Some("shared-session-key")
        );
        assert_eq!(
            config["browser"]["camofox"]["adopt_existing_tab"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["browser"]["camofox"]["custom_flag"].as_str(),
            Some("keep-camofox")
        );
        assert_eq!(
            config["browser"]["custom_flag"].as_str(),
            Some("keep-browser")
        );
    }

    #[test]
    fn merge_browser_config_removes_empty_camofox_identity_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
browser:
  camofox:
    managed_persistence: true
    user_id: old-user
    session_key: old-session
    adopt_existing_tab: true
    custom_flag: keep-camofox
  custom_flag: keep-browser
"#,
        )
        .unwrap();

        merge_hermes_browser_config(
            &mut config,
            &json!({
                "browserCamofoxManagedPersistence": false,
                "browserCamofoxUserId": "  ",
                "browserCamofoxSessionKey": "",
                "browserCamofoxAdoptExistingTab": false,
            }),
        )
        .unwrap();

        assert_eq!(
            config["browser"]["camofox"]["managed_persistence"].as_bool(),
            Some(false)
        );
        assert!(config["browser"]["camofox"]["user_id"].is_null());
        assert!(config["browser"]["camofox"]["session_key"].is_null());
        assert_eq!(
            config["browser"]["camofox"]["adopt_existing_tab"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["browser"]["camofox"]["custom_flag"].as_str(),
            Some("keep-camofox")
        );
        assert_eq!(
            config["browser"]["custom_flag"].as_str(),
            Some("keep-browser")
        );
    }

    #[test]
    fn merge_browser_config_removes_empty_cdp_url() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
browser:
  cdp_url: ws://127.0.0.1:9222/devtools/browser/demo
  custom_flag: keep-browser
"#,
        )
        .unwrap();

        merge_hermes_browser_config(&mut config, &json!({ "browserCdpUrl": "   " })).unwrap();

        assert_eq!(
            config["browser"]["custom_flag"].as_str(),
            Some("keep-browser")
        );
        assert!(config["browser"]["cdp_url"].is_null());
    }

    #[test]
    fn merge_browser_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_browser_config(&mut config, &json!({ "browserEngine": "firefox" }))
            .unwrap_err();
        assert!(err.contains("browser.engine"));
        let err =
            merge_hermes_browser_config(&mut config, &json!({ "browserInactivityTimeout": 0 }))
                .unwrap_err();
        assert!(err.contains("browser.inactivity_timeout"));
        let err = merge_hermes_browser_config(&mut config, &json!({ "browserCommandTimeout": 4 }))
            .unwrap_err();
        assert!(err.contains("browser.command_timeout"));
        let err =
            merge_hermes_browser_config(&mut config, &json!({ "browserDialogPolicy": "ignore" }))
                .unwrap_err();
        assert!(err.contains("browser.dialog_policy"));
        let err = merge_hermes_browser_config(&mut config, &json!({ "browserDialogTimeout": 0 }))
            .unwrap_err();
        assert!(err.contains("browser.dialog_timeout_s"));
        let err =
            merge_hermes_browser_config(&mut config, &json!({ "browserCdpUrl": 123 })).unwrap_err();
        assert!(err.contains("browser.cdp_url"));
        let err = merge_hermes_browser_config(&mut config, &json!({ "browserCamofoxUserId": 123 }))
            .unwrap_err();
        assert!(err.contains("browser.camofox.user_id"));
        let err = merge_hermes_browser_config(
            &mut config,
            &json!({ "browserCamofoxUserId": "bad user" }),
        )
        .unwrap_err();
        assert!(err.contains("browser.camofox.user_id"));
        let err = merge_hermes_browser_config(
            &mut config,
            &json!({ "browserCamofoxSessionKey": "bad session" }),
        )
        .unwrap_err();
        assert!(err.contains("browser.camofox.session_key"));
    }
}

#[cfg(test)]
mod hermes_web_config_tests {
    use super::{build_hermes_web_config_values, merge_hermes_web_config};
    use serde_json::json;

    #[test]
    fn web_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_web_config_values(&config);
        assert_eq!(values["webBackend"], "");
        assert_eq!(values["webSearchBackend"], "");
        assert_eq!(values["webExtractBackend"], "");
    }

    #[test]
    fn web_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
web:
  backend: tavily
  search_backend: searxng
  extract_backend: firecrawl
"#,
        )
        .unwrap();
        let values = build_hermes_web_config_values(&config);
        assert_eq!(values["webBackend"], "tavily");
        assert_eq!(values["webSearchBackend"], "searxng");
        assert_eq!(values["webExtractBackend"], "firecrawl");
    }

    #[test]
    fn merge_web_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
web:
  backend: tavily
  search_backend: searxng
  extract_backend: firecrawl
  custom_flag: keep-web
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_web_config(
            &mut config,
            &json!({
                "webBackend": "parallel",
                "webSearchBackend": "exa",
                "webExtractBackend": "native",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["web"]["backend"].as_str(), Some("parallel"));
        assert_eq!(config["web"]["search_backend"].as_str(), Some("exa"));
        assert_eq!(config["web"]["extract_backend"].as_str(), Some("native"));
        assert_eq!(config["web"]["custom_flag"].as_str(), Some("keep-web"));
    }

    #[test]
    fn merge_web_config_removes_empty_optional_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
web:
  backend: tavily
  search_backend: searxng
  extract_backend: firecrawl
  custom_flag: keep-web
"#,
        )
        .unwrap();

        merge_hermes_web_config(
            &mut config,
            &json!({
                "webBackend": "   ",
                "webSearchBackend": "",
                "webExtractBackend": "  ",
            }),
        )
        .unwrap();

        assert_eq!(config["web"]["custom_flag"].as_str(), Some("keep-web"));
        assert!(config["web"].get("backend").is_none());
        assert!(config["web"].get("search_backend").is_none());
        assert!(config["web"].get("extract_backend").is_none());
    }

    #[test]
    fn merge_web_config_rejects_invalid_backends() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_web_config(&mut config, &json!({ "webBackend": "unsafe" })).unwrap_err();
        assert!(err.contains("web.backend"));
        let err = merge_hermes_web_config(&mut config, &json!({ "webSearchBackend": "unsafe" }))
            .unwrap_err();
        assert!(err.contains("web.search_backend"));
        let err = merge_hermes_web_config(&mut config, &json!({ "webExtractBackend": "unsafe" }))
            .unwrap_err();
        assert!(err.contains("web.extract_backend"));
    }
}

#[cfg(test)]
mod hermes_model_catalog_config_tests {
    use super::{
        build_hermes_model_catalog_config_values, merge_hermes_model_catalog_config,
        HERMES_MODEL_CATALOG_DEFAULT_URL,
    };
    use serde_json::json;

    #[test]
    fn model_catalog_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_model_catalog_config_values(&config);
        assert_eq!(values["modelCatalogEnabled"], true);
        assert_eq!(values["modelCatalogUrl"], HERMES_MODEL_CATALOG_DEFAULT_URL);
        assert_eq!(values["modelCatalogTtlHours"], 24);
        assert_eq!(values["modelCatalogProvidersJson"], "{}");
    }

    #[test]
    fn model_catalog_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model_catalog:
  enabled: false
  url: https://example.com/catalog.json
  ttl_hours: 6
  providers:
    openrouter:
      url: https://mirror.example.com/openrouter.json
    nous:
      url: https://mirror.example.com/nous.json
"#,
        )
        .unwrap();
        let values = build_hermes_model_catalog_config_values(&config);
        assert_eq!(values["modelCatalogEnabled"], false);
        assert_eq!(
            values["modelCatalogUrl"],
            "https://example.com/catalog.json"
        );
        assert_eq!(values["modelCatalogTtlHours"], 6);
        let providers: serde_json::Value =
            serde_json::from_str(values["modelCatalogProvidersJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            providers["openrouter"]["url"],
            "https://mirror.example.com/openrouter.json"
        );
        assert_eq!(
            providers["nous"]["url"],
            "https://mirror.example.com/nous.json"
        );
    }

    #[test]
    fn merge_model_catalog_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
model_catalog:
  enabled: false
  url: https://old.example.com/catalog.json
  ttl_hours: 12
  providers:
    openrouter:
      url: https://old.example.com/openrouter.json
  custom_flag: keep-catalog
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_model_catalog_config(
            &mut config,
            &json!({
                "modelCatalogEnabled": true,
                "modelCatalogUrl": "https://catalog.example.com/model-catalog.json",
                "modelCatalogTtlHours": 48,
                "modelCatalogProvidersJson": serde_json::to_string(&json!({
                    "openrouter": { "url": "https://catalog.example.com/openrouter.json" },
                    "nous": { "url": "https://catalog.example.com/nous.json" },
                })).unwrap(),
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["model_catalog"]["enabled"].as_bool(), Some(true));
        assert_eq!(
            config["model_catalog"]["url"].as_str(),
            Some("https://catalog.example.com/model-catalog.json")
        );
        assert_eq!(config["model_catalog"]["ttl_hours"].as_i64(), Some(48));
        assert_eq!(
            config["model_catalog"]["providers"]["openrouter"]["url"].as_str(),
            Some("https://catalog.example.com/openrouter.json")
        );
        assert_eq!(
            config["model_catalog"]["providers"]["nous"]["url"].as_str(),
            Some("https://catalog.example.com/nous.json")
        );
        assert_eq!(
            config["model_catalog"]["custom_flag"].as_str(),
            Some("keep-catalog")
        );
    }

    #[test]
    fn merge_model_catalog_config_removes_empty_providers() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model_catalog:
  providers:
    openrouter:
      url: https://old.example.com/openrouter.json
  custom_flag: keep-catalog
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_model_catalog_config(
            &mut config,
            &json!({
                "modelCatalogProvidersJson": "{}",
            }),
        )
        .unwrap();

        assert_eq!(
            config["model_catalog"]["custom_flag"].as_str(),
            Some("keep-catalog")
        );
        assert!(config["model_catalog"].get("providers").is_none());
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_model_catalog_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_model_catalog_config(
            &mut config,
            &json!({ "modelCatalogUrl": "ftp://example.com/catalog.json" }),
        )
        .unwrap_err();
        assert!(err.contains("model_catalog.url"));
        let err =
            merge_hermes_model_catalog_config(&mut config, &json!({ "modelCatalogTtlHours": 0 }))
                .unwrap_err();
        assert!(err.contains("model_catalog.ttl_hours"));
        let err = merge_hermes_model_catalog_config(
            &mut config,
            &json!({ "modelCatalogProvidersJson": "[" }),
        )
        .unwrap_err();
        assert!(err.contains("model_catalog.providers"));
        let err = merge_hermes_model_catalog_config(
            &mut config,
            &json!({ "modelCatalogProvidersJson": serde_json::to_string(&json!({
                "bad provider": { "url": "https://example.com/catalog.json" }
            })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("model_catalog.providers.bad provider"));
        let err = merge_hermes_model_catalog_config(
            &mut config,
            &json!({ "modelCatalogProvidersJson": serde_json::to_string(&json!({
                "openrouter": { "url": "file:///tmp/catalog.json" }
            })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("model_catalog.providers.openrouter.url"));
    }
}

#[cfg(test)]
mod hermes_x_search_config_tests {
    use super::{build_hermes_x_search_config_values, merge_hermes_x_search_config};
    use serde_json::json;

    #[test]
    fn x_search_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_x_search_config_values(&config);
        assert_eq!(values["xSearchModel"], "grok-4.20-reasoning");
        assert_eq!(values["xSearchTimeoutSeconds"], 180);
        assert_eq!(values["xSearchRetries"], 2);
    }

    #[test]
    fn x_search_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
x_search:
  model: grok-4.20-fast
  timeout_seconds: 90
  retries: 4
"#,
        )
        .unwrap();
        let values = build_hermes_x_search_config_values(&config);
        assert_eq!(values["xSearchModel"], "grok-4.20-fast");
        assert_eq!(values["xSearchTimeoutSeconds"], 90);
        assert_eq!(values["xSearchRetries"], 4);
    }

    #[test]
    fn merge_x_search_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: xai
x_search:
  model: old-grok
  timeout_seconds: 60
  retries: 1
  custom_flag: keep-x-search
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_x_search_config(
            &mut config,
            &json!({
                "xSearchModel": "grok-4.20-reasoning",
                "xSearchTimeoutSeconds": 240,
                "xSearchRetries": 3,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("xai"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(
            config["x_search"]["model"].as_str(),
            Some("grok-4.20-reasoning")
        );
        assert_eq!(config["x_search"]["timeout_seconds"].as_i64(), Some(240));
        assert_eq!(config["x_search"]["retries"].as_i64(), Some(3));
        assert_eq!(
            config["x_search"]["custom_flag"].as_str(),
            Some("keep-x-search")
        );
    }

    #[test]
    fn merge_x_search_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_x_search_config(&mut config, &json!({ "xSearchModel": "" })).unwrap_err();
        assert!(err.contains("x_search.model"));
        let err =
            merge_hermes_x_search_config(&mut config, &json!({ "xSearchModel": "bad model" }))
                .unwrap_err();
        assert!(err.contains("x_search.model"));
        let err =
            merge_hermes_x_search_config(&mut config, &json!({ "xSearchTimeoutSeconds": 29 }))
                .unwrap_err();
        assert!(err.contains("x_search.timeout_seconds"));
        let err = merge_hermes_x_search_config(&mut config, &json!({ "xSearchRetries": -1 }))
            .unwrap_err();
        assert!(err.contains("x_search.retries"));
        let err = merge_hermes_x_search_config(&mut config, &json!({ "xSearchRetries": 21 }))
            .unwrap_err();
        assert!(err.contains("x_search.retries"));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod hermes_portable_runtime_tests {
    use super::{mingit_asset_url, zip_entry_safe_path};
    use serde_json::json;

    #[test]
    fn mingit_asset_url_prefers_non_busybox_64_bit_zip() {
        let release = json!({
            "assets": [
                { "name": "Git-2.50.1-64-bit.exe", "browser_download_url": "https://example.invalid/git.exe" },
                { "name": "MinGit-2.50.1-busybox-64-bit.zip", "browser_download_url": "https://example.invalid/busybox.zip" },
                { "name": "MinGit-2.50.1-64-bit.zip", "browser_download_url": "https://example.invalid/mingit.zip" }
            ]
        });
        assert_eq!(
            mingit_asset_url(&release).as_deref(),
            Some("https://example.invalid/mingit.zip")
        );
    }

    #[test]
    fn zip_entry_safe_path_rejects_traversal_and_absolute_paths() {
        assert!(zip_entry_safe_path("cmd/git.exe").is_some());
        assert!(zip_entry_safe_path("../evil.exe").is_none());
        assert!(zip_entry_safe_path("/evil.exe").is_none());
        assert!(zip_entry_safe_path("C:/evil.exe").is_none());
        assert!(zip_entry_safe_path("cmd//git.exe").is_none());
    }
}

#[cfg(test)]
mod hermes_context_config_tests {
    use super::{build_hermes_context_config_values, merge_hermes_context_config};
    use serde_json::json;

    #[test]
    fn context_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_context_config_values(&config);
        assert_eq!(values["contextEngine"], "compressor");
    }

    #[test]
    fn context_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
context:
  engine: lcm
"#,
        )
        .unwrap();
        let values = build_hermes_context_config_values(&config);
        assert_eq!(values["contextEngine"], "lcm");
    }

    #[test]
    fn merge_context_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
context:
  engine: compressor
  custom_flag: keep-context
model:
  provider: anthropic
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_context_config(&mut config, &json!({ "contextEngine": "lcm" })).unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["context"]["engine"].as_str(), Some("lcm"));
        assert_eq!(
            config["context"]["custom_flag"].as_str(),
            Some("keep-context")
        );
    }

    #[test]
    fn merge_context_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_context_config(&mut config, &json!({ "contextEngine": "" })).unwrap_err();
        assert!(err.contains("context.engine"));
        let err =
            merge_hermes_context_config(&mut config, &json!({ "contextEngine": "bad engine" }))
                .unwrap_err();
        assert!(err.contains("context.engine"));
        let err = merge_hermes_context_config(&mut config, &json!({ "contextEngine": "中文" }))
            .unwrap_err();
        assert!(err.contains("context.engine"));
    }
}

#[cfg(test)]
mod hermes_lsp_config_tests {
    use super::{build_hermes_lsp_config_values, merge_hermes_lsp_config};
    use serde_json::json;

    #[test]
    fn lsp_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_lsp_config_values(&config);
        assert_eq!(values["lspEnabled"], true);
        assert_eq!(values["lspWaitMode"], "document");
        assert_eq!(values["lspWaitTimeout"], 5.0);
        assert_eq!(values["lspInstallStrategy"], "auto");
    }

    #[test]
    fn lsp_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
lsp:
  enabled: false
  wait_mode: full
  wait_timeout: 12.5
  install_strategy: manual
  servers:
    pyright:
      disabled: true
"#,
        )
        .unwrap();
        let values = build_hermes_lsp_config_values(&config);
        assert_eq!(values["lspEnabled"], false);
        assert_eq!(values["lspWaitMode"], "full");
        assert_eq!(values["lspWaitTimeout"], 12.5);
        assert_eq!(values["lspInstallStrategy"], "manual");
    }

    #[test]
    fn merge_lsp_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
lsp:
  enabled: false
  wait_mode: full
  wait_timeout: 12.5
  install_strategy: manual
  servers:
    pyright:
      disabled: true
  custom_flag: keep-lsp
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_lsp_config(
            &mut config,
            &json!({
                "lspEnabled": true,
                "lspWaitMode": "document",
                "lspWaitTimeout": 7.5,
                "lspInstallStrategy": "off",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["lsp"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["lsp"]["wait_mode"].as_str(), Some("document"));
        assert_eq!(config["lsp"]["wait_timeout"].as_f64(), Some(7.5));
        assert_eq!(config["lsp"]["install_strategy"].as_str(), Some("off"));
        assert_eq!(
            config["lsp"]["servers"]["pyright"]["disabled"].as_bool(),
            Some(true)
        );
        assert_eq!(config["lsp"]["custom_flag"].as_str(), Some("keep-lsp"));
    }

    #[test]
    fn merge_lsp_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_lsp_config(&mut config, &json!({ "lspWaitMode": "workspace" }))
            .unwrap_err();
        assert!(err.contains("lsp.wait_mode"));
        let err = merge_hermes_lsp_config(&mut config, &json!({ "lspInstallStrategy": "unsafe" }))
            .unwrap_err();
        assert!(err.contains("lsp.install_strategy"));
        let err =
            merge_hermes_lsp_config(&mut config, &json!({ "lspWaitTimeout": 0 })).unwrap_err();
        assert!(err.contains("lsp.wait_timeout"));
        let err =
            merge_hermes_lsp_config(&mut config, &json!({ "lspWaitTimeout": 120.5 })).unwrap_err();
        assert!(err.contains("lsp.wait_timeout"));
    }
}

#[cfg(test)]
mod hermes_stt_config_tests {
    use super::{build_hermes_stt_config_values, merge_hermes_stt_config};
    use serde_json::json;

    #[test]
    fn stt_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_stt_config_values(&config);
        assert_eq!(values["sttEnabled"], true);
        assert_eq!(values["sttProvider"], "auto");
        assert_eq!(values["sttLocalModel"], "base");
        assert_eq!(values["sttLocalLanguage"], "");
        assert_eq!(values["sttOpenaiModel"], "whisper-1");
        assert_eq!(values["sttMistralModel"], "voxtral-mini-latest");
    }

    #[test]
    fn stt_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
stt:
  enabled: false
  provider: openai
  local:
    model: small
    language: zh
  openai:
    model: gpt-4o-mini-transcribe
  mistral:
    model: voxtral-mini-2602
"#,
        )
        .unwrap();
        let values = build_hermes_stt_config_values(&config);
        assert_eq!(values["sttEnabled"], false);
        assert_eq!(values["sttProvider"], "openai");
        assert_eq!(values["sttLocalModel"], "small");
        assert_eq!(values["sttLocalLanguage"], "zh");
        assert_eq!(values["sttOpenaiModel"], "gpt-4o-mini-transcribe");
        assert_eq!(values["sttMistralModel"], "voxtral-mini-2602");
    }

    #[test]
    fn merge_stt_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
stt:
  enabled: true
  provider: auto
  custom_flag: keep-stt
  local:
    model: base
    custom_flag: keep-local
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_stt_config(
            &mut config,
            &json!({
                "sttEnabled": false,
                "sttProvider": "openai",
                "sttLocalModel": "small",
                "sttLocalLanguage": "zh",
                "sttOpenaiModel": "gpt-4o-mini-transcribe",
                "sttMistralModel": "voxtral-mini-2602",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(config["stt"]["enabled"].as_bool(), Some(false));
        assert_eq!(config["stt"]["provider"].as_str(), Some("openai"));
        assert_eq!(config["stt"]["local"]["model"].as_str(), Some("small"));
        assert_eq!(config["stt"]["local"]["language"].as_str(), Some("zh"));
        assert_eq!(
            config["stt"]["openai"]["model"].as_str(),
            Some("gpt-4o-mini-transcribe")
        );
        assert_eq!(
            config["stt"]["mistral"]["model"].as_str(),
            Some("voxtral-mini-2602")
        );
        assert_eq!(config["stt"]["custom_flag"].as_str(), Some("keep-stt"));
        assert_eq!(
            config["stt"]["local"]["custom_flag"].as_str(),
            Some("keep-local")
        );
    }

    #[test]
    fn merge_stt_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_stt_config(&mut config, &json!({ "sttProvider": "bad" })).unwrap_err();
        assert!(err.contains("stt.provider"));
        let err =
            merge_hermes_stt_config(&mut config, &json!({ "sttLocalModel": "giant" })).unwrap_err();
        assert!(err.contains("stt.local.model"));
        let err = merge_hermes_stt_config(&mut config, &json!({ "sttOpenaiModel": "gpt-4.1" }))
            .unwrap_err();
        assert!(err.contains("stt.openai.model"));
        let err =
            merge_hermes_stt_config(&mut config, &json!({ "sttMistralModel": "voxtral-large" }))
                .unwrap_err();
        assert!(err.contains("stt.mistral.model"));
        let err = merge_hermes_stt_config(&mut config, &json!({ "sttLocalLanguage": "中文" }))
            .unwrap_err();
        assert!(err.contains("stt.local.language"));
    }
}

#[cfg(test)]
mod hermes_tts_voice_config_tests {
    use super::{build_hermes_tts_voice_config_values, merge_hermes_tts_voice_config};
    use serde_json::json;

    #[test]
    fn tts_voice_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_tts_voice_config_values(&config);
        assert_eq!(values["ttsProvider"], "edge");
        assert_eq!(values["ttsEdgeVoice"], "en-US-AriaNeural");
        assert_eq!(values["ttsOpenaiModel"], "gpt-4o-mini-tts");
        assert_eq!(values["ttsOpenaiVoice"], "alloy");
        assert_eq!(values["ttsElevenlabsVoiceId"], "pNInz6obpgDQGcFmaJgB");
        assert_eq!(values["ttsElevenlabsModelId"], "eleven_multilingual_v2");
        assert_eq!(values["ttsXaiVoiceId"], "eve");
        assert_eq!(values["ttsXaiLanguage"], "en");
        assert_eq!(values["ttsXaiSampleRate"], 24000);
        assert_eq!(values["ttsXaiBitRate"], 128000);
        assert_eq!(values["ttsMistralModel"], "voxtral-mini-tts-2603");
        assert_eq!(
            values["ttsMistralVoiceId"],
            "c69964a6-ab8b-4f8a-9465-ec0925096ec8"
        );
        assert_eq!(values["ttsPiperVoice"], "en_US-lessac-medium");
        assert_eq!(values["voiceRecordKey"], "ctrl+b");
        assert_eq!(values["voiceMaxRecordingSeconds"], 120);
        assert_eq!(values["voiceAutoTts"], false);
        assert_eq!(values["voiceBeepEnabled"], true);
        assert_eq!(values["voiceSilenceThreshold"], 200);
        assert_eq!(values["voiceSilenceDuration"], 3.0);
    }

    #[test]
    fn tts_voice_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
tts:
  provider: openai
  edge:
    voice: zh-CN-XiaoxiaoNeural
  openai:
    model: gpt-4o-mini-tts
    voice: nova
  elevenlabs:
    voice_id: voice-123
    model_id: eleven_turbo_v2_5
  xai:
    voice_id: custom-eve
    language: zh
    sample_rate: 48000
    bit_rate: 192000
  mistral:
    model: voxtral-mini-tts-2603
    voice_id: mistral-voice
  piper:
    voice: zh_CN-huayan-medium
voice:
  record_key: ctrl+shift+v
  max_recording_seconds: 240
  auto_tts: true
  beep_enabled: false
  silence_threshold: 350
  silence_duration: 1.5
"#,
        )
        .unwrap();
        let values = build_hermes_tts_voice_config_values(&config);
        assert_eq!(values["ttsProvider"], "openai");
        assert_eq!(values["ttsEdgeVoice"], "zh-CN-XiaoxiaoNeural");
        assert_eq!(values["ttsOpenaiVoice"], "nova");
        assert_eq!(values["ttsElevenlabsVoiceId"], "voice-123");
        assert_eq!(values["ttsXaiLanguage"], "zh");
        assert_eq!(values["ttsXaiSampleRate"], 48000);
        assert_eq!(values["ttsMistralVoiceId"], "mistral-voice");
        assert_eq!(values["ttsPiperVoice"], "zh_CN-huayan-medium");
        assert_eq!(values["voiceRecordKey"], "ctrl+shift+v");
        assert_eq!(values["voiceAutoTts"], true);
        assert_eq!(values["voiceBeepEnabled"], false);
        assert_eq!(values["voiceSilenceDuration"], 1.5);
    }

    #[test]
    fn merge_tts_voice_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
tts:
  provider: edge
  custom_flag: keep-tts
  openai:
    custom_flag: keep-openai
  piper:
    voices_dir: /cache/piper
voice:
  custom_flag: keep-voice
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_tts_voice_config(
            &mut config,
            &json!({
                "ttsProvider": "openai",
                "ttsEdgeVoice": "zh-CN-XiaoxiaoNeural",
                "ttsOpenaiModel": "gpt-4o-mini-tts",
                "ttsOpenaiVoice": "nova",
                "ttsElevenlabsVoiceId": "voice-123",
                "ttsElevenlabsModelId": "eleven_turbo_v2_5",
                "ttsXaiVoiceId": "eve-pro",
                "ttsXaiLanguage": "zh",
                "ttsXaiSampleRate": "48000",
                "ttsXaiBitRate": "192000",
                "ttsMistralModel": "voxtral-mini-tts-2603",
                "ttsMistralVoiceId": "mistral-voice",
                "ttsPiperVoice": "zh_CN-huayan-medium",
                "voiceRecordKey": "ctrl+shift+v",
                "voiceMaxRecordingSeconds": "240",
                "voiceAutoTts": true,
                "voiceBeepEnabled": false,
                "voiceSilenceThreshold": "350",
                "voiceSilenceDuration": "1.5",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["tts"]["provider"].as_str(), Some("openai"));
        assert_eq!(
            config["tts"]["edge"]["voice"].as_str(),
            Some("zh-CN-XiaoxiaoNeural")
        );
        assert_eq!(config["tts"]["openai"]["voice"].as_str(), Some("nova"));
        assert_eq!(
            config["tts"]["openai"]["custom_flag"].as_str(),
            Some("keep-openai")
        );
        assert_eq!(
            config["tts"]["elevenlabs"]["voice_id"].as_str(),
            Some("voice-123")
        );
        assert_eq!(config["tts"]["xai"]["sample_rate"].as_i64(), Some(48000));
        assert_eq!(config["tts"]["xai"]["bit_rate"].as_i64(), Some(192000));
        assert_eq!(
            config["tts"]["mistral"]["voice_id"].as_str(),
            Some("mistral-voice")
        );
        assert_eq!(
            config["tts"]["piper"]["voice"].as_str(),
            Some("zh_CN-huayan-medium")
        );
        assert_eq!(
            config["tts"]["piper"]["voices_dir"].as_str(),
            Some("/cache/piper")
        );
        assert_eq!(config["tts"]["custom_flag"].as_str(), Some("keep-tts"));
        assert_eq!(config["voice"]["record_key"].as_str(), Some("ctrl+shift+v"));
        assert_eq!(config["voice"]["max_recording_seconds"].as_i64(), Some(240));
        assert_eq!(config["voice"]["auto_tts"].as_bool(), Some(true));
        assert_eq!(config["voice"]["beep_enabled"].as_bool(), Some(false));
        assert_eq!(config["voice"]["silence_threshold"].as_i64(), Some(350));
        assert_eq!(config["voice"]["silence_duration"].as_f64(), Some(1.5));
        assert_eq!(config["voice"]["custom_flag"].as_str(), Some("keep-voice"));
    }

    #[test]
    fn merge_tts_voice_config_removes_empty_optional_overrides() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
tts:
  edge:
    voice: custom-edge
  elevenlabs:
    voice_id: voice-123
    model_id: model-123
  piper:
    voice: custom-piper
    voices_dir: /cache/piper
voice:
  record_key: ctrl+shift+v
  custom_flag: keep-voice
"#,
        )
        .unwrap();

        merge_hermes_tts_voice_config(
            &mut config,
            &json!({
                "ttsEdgeVoice": "",
                "ttsElevenlabsVoiceId": " ",
                "ttsElevenlabsModelId": "",
                "ttsPiperVoice": "",
                "voiceRecordKey": "",
            }),
        )
        .unwrap();

        assert!(config["tts"]["edge"]["voice"].is_null());
        assert!(config["tts"]["elevenlabs"]["voice_id"].is_null());
        assert!(config["tts"]["elevenlabs"]["model_id"].is_null());
        assert!(config["tts"]["piper"]["voice"].is_null());
        assert_eq!(
            config["tts"]["piper"]["voices_dir"].as_str(),
            Some("/cache/piper")
        );
        assert!(config["voice"]["record_key"].is_null());
        assert_eq!(config["voice"]["custom_flag"].as_str(), Some("keep-voice"));
    }

    #[test]
    fn merge_tts_voice_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_tts_voice_config(&mut config, &json!({ "ttsProvider": "bad" }))
            .unwrap_err();
        assert!(err.contains("tts.provider"));
        let err = merge_hermes_tts_voice_config(&mut config, &json!({ "ttsOpenaiVoice": "robot" }))
            .unwrap_err();
        assert!(err.contains("tts.openai.voice"));
        let err = merge_hermes_tts_voice_config(&mut config, &json!({ "ttsXaiSampleRate": "0" }))
            .unwrap_err();
        assert!(err.contains("tts.xai.sample_rate"));
        let err =
            merge_hermes_tts_voice_config(&mut config, &json!({ "voiceMaxRecordingSeconds": "0" }))
                .unwrap_err();
        assert!(err.contains("voice.max_recording_seconds"));
        let err =
            merge_hermes_tts_voice_config(&mut config, &json!({ "voiceSilenceDuration": "-1" }))
                .unwrap_err();
        assert!(err.contains("voice.silence_duration"));
    }
}

#[cfg(test)]
mod hermes_checkpoints_config_tests {
    use super::{build_hermes_checkpoints_config_values, merge_hermes_checkpoints_config};
    use serde_json::json;

    #[test]
    fn checkpoints_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_checkpoints_config_values(&config);
        assert_eq!(values["checkpointsEnabled"], false);
        assert_eq!(values["checkpointMaxSnapshots"], 20);
        assert_eq!(values["checkpointMaxTotalSizeMb"], 500);
        assert_eq!(values["checkpointMaxFileSizeMb"], 10);
        assert_eq!(values["checkpointAutoPrune"], true);
        assert_eq!(values["checkpointRetentionDays"], 7);
        assert_eq!(values["checkpointDeleteOrphans"], true);
        assert_eq!(values["checkpointMinIntervalHours"], 24);
    }

    #[test]
    fn checkpoints_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
checkpoints:
  enabled: true
  max_snapshots: 12
  max_total_size_mb: 900
  max_file_size_mb: 25
  auto_prune: false
  retention_days: 14
  delete_orphans: false
  min_interval_hours: 6
"#,
        )
        .unwrap();
        let values = build_hermes_checkpoints_config_values(&config);
        assert_eq!(values["checkpointsEnabled"], true);
        assert_eq!(values["checkpointMaxSnapshots"], 12);
        assert_eq!(values["checkpointMaxTotalSizeMb"], 900);
        assert_eq!(values["checkpointMaxFileSizeMb"], 25);
        assert_eq!(values["checkpointAutoPrune"], false);
        assert_eq!(values["checkpointRetentionDays"], 14);
        assert_eq!(values["checkpointDeleteOrphans"], false);
        assert_eq!(values["checkpointMinIntervalHours"], 6);
    }

    #[test]
    fn merge_checkpoints_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
checkpoints:
  enabled: true
  custom_flag: keep-checkpoints
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_checkpoints_config(
            &mut config,
            &json!({
                "checkpointsEnabled": false,
                "checkpointMaxSnapshots": "30",
                "checkpointMaxTotalSizeMb": "0",
                "checkpointMaxFileSizeMb": "0",
                "checkpointAutoPrune": true,
                "checkpointRetentionDays": "21",
                "checkpointDeleteOrphans": true,
                "checkpointMinIntervalHours": "12",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["checkpoints"]["enabled"].as_bool(), Some(false));
        assert_eq!(config["checkpoints"]["max_snapshots"].as_i64(), Some(30));
        assert_eq!(config["checkpoints"]["max_total_size_mb"].as_i64(), Some(0));
        assert_eq!(config["checkpoints"]["max_file_size_mb"].as_i64(), Some(0));
        assert_eq!(config["checkpoints"]["auto_prune"].as_bool(), Some(true));
        assert_eq!(config["checkpoints"]["retention_days"].as_i64(), Some(21));
        assert_eq!(
            config["checkpoints"]["delete_orphans"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["checkpoints"]["min_interval_hours"].as_i64(),
            Some(12)
        );
        assert_eq!(
            config["checkpoints"]["custom_flag"].as_str(),
            Some("keep-checkpoints")
        );
    }

    #[test]
    fn merge_checkpoints_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_checkpoints_config(&mut config, &json!({ "checkpointMaxSnapshots": 0 }))
                .unwrap_err();
        assert!(err.contains("checkpoints.max_snapshots"));
        let err = merge_hermes_checkpoints_config(
            &mut config,
            &json!({ "checkpointMaxTotalSizeMb": -1 }),
        )
        .unwrap_err();
        assert!(err.contains("checkpoints.max_total_size_mb"));
        let err =
            merge_hermes_checkpoints_config(&mut config, &json!({ "checkpointMaxFileSizeMb": -1 }))
                .unwrap_err();
        assert!(err.contains("checkpoints.max_file_size_mb"));
        let err =
            merge_hermes_checkpoints_config(&mut config, &json!({ "checkpointRetentionDays": 0 }))
                .unwrap_err();
        assert!(err.contains("checkpoints.retention_days"));
        let err = merge_hermes_checkpoints_config(
            &mut config,
            &json!({ "checkpointMinIntervalHours": -1 }),
        )
        .unwrap_err();
        assert!(err.contains("checkpoints.min_interval_hours"));
    }
}

#[cfg(test)]
mod hermes_cron_config_tests {
    use super::{build_hermes_cron_config_values, merge_hermes_cron_config};
    use serde_json::json;

    #[test]
    fn cron_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_cron_config_values(&config);
        assert_eq!(values["cronWrapResponse"], true);
        assert_eq!(values["cronMaxParallelJobs"], 0);
    }

    #[test]
    fn cron_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
cron:
  wrap_response: false
  max_parallel_jobs: 4
"#,
        )
        .unwrap();
        let values = build_hermes_cron_config_values(&config);
        assert_eq!(values["cronWrapResponse"], false);
        assert_eq!(values["cronMaxParallelJobs"], 4);
    }

    #[test]
    fn merge_cron_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
cron:
  wrap_response: true
  custom_flag: keep-cron
approvals:
  cron_mode: deny
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_cron_config(
            &mut config,
            &json!({
                "cronWrapResponse": false,
                "cronMaxParallelJobs": "3",
            }),
        )
        .unwrap();

        assert_eq!(config["approvals"]["cron_mode"].as_str(), Some("deny"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["cron"]["wrap_response"].as_bool(), Some(false));
        assert_eq!(config["cron"]["max_parallel_jobs"].as_i64(), Some(3));
        assert_eq!(config["cron"]["custom_flag"].as_str(), Some("keep-cron"));
    }

    #[test]
    fn merge_cron_config_writes_unbounded_null_and_rejects_invalid_values() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
cron:
  max_parallel_jobs: 8
"#,
        )
        .unwrap();

        merge_hermes_cron_config(
            &mut config,
            &json!({
                "cronMaxParallelJobs": "0",
            }),
        )
        .unwrap();
        assert_eq!(config["cron"]["max_parallel_jobs"], serde_yaml::Value::Null);

        let err = merge_hermes_cron_config(&mut config, &json!({ "cronMaxParallelJobs": -1 }))
            .unwrap_err();
        assert!(err.contains("cron.max_parallel_jobs"));
        let err = merge_hermes_cron_config(&mut config, &json!({ "cronMaxParallelJobs": 10001 }))
            .unwrap_err();
        assert!(err.contains("cron.max_parallel_jobs"));
    }
}

#[cfg(test)]
mod hermes_sessions_maintenance_config_tests {
    use super::{
        build_hermes_sessions_maintenance_config_values, merge_hermes_sessions_maintenance_config,
    };
    use serde_json::json;

    #[test]
    fn sessions_maintenance_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_sessions_maintenance_config_values(&config);
        assert_eq!(values["sessionsAutoPrune"], false);
        assert_eq!(values["sessionsRetentionDays"], 90);
        assert_eq!(values["sessionsVacuumAfterPrune"], true);
        assert_eq!(values["sessionsMinIntervalHours"], 24);
        assert_eq!(values["sessionsWriteJsonSnapshots"], false);
    }

    #[test]
    fn sessions_maintenance_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
sessions:
  auto_prune: true
  retention_days: 14
  vacuum_after_prune: false
  min_interval_hours: 6
  write_json_snapshots: true
"#,
        )
        .unwrap();
        let values = build_hermes_sessions_maintenance_config_values(&config);
        assert_eq!(values["sessionsAutoPrune"], true);
        assert_eq!(values["sessionsRetentionDays"], 14);
        assert_eq!(values["sessionsVacuumAfterPrune"], false);
        assert_eq!(values["sessionsMinIntervalHours"], 6);
        assert_eq!(values["sessionsWriteJsonSnapshots"], true);
    }

    #[test]
    fn merge_sessions_maintenance_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
sessions:
  auto_prune: false
  custom_flag: keep-sessions
model:
  provider: anthropic
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_sessions_maintenance_config(
            &mut config,
            &json!({
                "sessionsAutoPrune": true,
                "sessionsRetentionDays": "30",
                "sessionsVacuumAfterPrune": false,
                "sessionsMinIntervalHours": "12",
                "sessionsWriteJsonSnapshots": true,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["sessions"]["auto_prune"].as_bool(), Some(true));
        assert_eq!(config["sessions"]["retention_days"].as_i64(), Some(30));
        assert_eq!(
            config["sessions"]["vacuum_after_prune"].as_bool(),
            Some(false)
        );
        assert_eq!(config["sessions"]["min_interval_hours"].as_i64(), Some(12));
        assert_eq!(
            config["sessions"]["write_json_snapshots"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["sessions"]["custom_flag"].as_str(),
            Some("keep-sessions")
        );
    }

    #[test]
    fn merge_sessions_maintenance_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_sessions_maintenance_config(
            &mut config,
            &json!({ "sessionsRetentionDays": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("sessions.retention_days"));
        let err = merge_hermes_sessions_maintenance_config(
            &mut config,
            &json!({ "sessionsRetentionDays": 36501 }),
        )
        .unwrap_err();
        assert!(err.contains("sessions.retention_days"));
        let err = merge_hermes_sessions_maintenance_config(
            &mut config,
            &json!({ "sessionsMinIntervalHours": -1 }),
        )
        .unwrap_err();
        assert!(err.contains("sessions.min_interval_hours"));
        let err = merge_hermes_sessions_maintenance_config(
            &mut config,
            &json!({ "sessionsMinIntervalHours": 87601 }),
        )
        .unwrap_err();
        assert!(err.contains("sessions.min_interval_hours"));
    }
}

#[cfg(test)]
mod hermes_updates_config_tests {
    use super::{build_hermes_updates_config_values, merge_hermes_updates_config};
    use serde_json::json;

    #[test]
    fn updates_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_updates_config_values(&config);
        assert_eq!(values["updatesPreUpdateBackup"], false);
        assert_eq!(values["updatesBackupKeep"], 5);
    }

    #[test]
    fn updates_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
updates:
  pre_update_backup: true
  backup_keep: 9
"#,
        )
        .unwrap();
        let values = build_hermes_updates_config_values(&config);
        assert_eq!(values["updatesPreUpdateBackup"], true);
        assert_eq!(values["updatesBackupKeep"], 9);
    }

    #[test]
    fn merge_updates_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
updates:
  pre_update_backup: false
  custom_flag: keep-updates
sessions:
  auto_prune: true
model:
  provider: anthropic
"#,
        )
        .unwrap();

        merge_hermes_updates_config(
            &mut config,
            &json!({
                "updatesPreUpdateBackup": true,
                "updatesBackupKeep": "7",
            }),
        )
        .unwrap();

        assert_eq!(config["sessions"]["auto_prune"].as_bool(), Some(true));
        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["updates"]["pre_update_backup"].as_bool(), Some(true));
        assert_eq!(config["updates"]["backup_keep"].as_i64(), Some(7));
        assert_eq!(
            config["updates"]["custom_flag"].as_str(),
            Some("keep-updates")
        );
    }

    #[test]
    fn merge_updates_config_rejects_invalid_backup_keep() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_updates_config(&mut config, &json!({ "updatesBackupKeep": 0 }))
            .unwrap_err();
        assert!(err.contains("updates.backup_keep"));
        let err = merge_hermes_updates_config(&mut config, &json!({ "updatesBackupKeep": 1001 }))
            .unwrap_err();
        assert!(err.contains("updates.backup_keep"));
    }
}

#[cfg(test)]
mod hermes_logging_config_tests {
    use super::{build_hermes_logging_config_values, merge_hermes_logging_config};
    use serde_json::json;

    #[test]
    fn logging_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_logging_config_values(&config);
        assert_eq!(values["loggingLevel"], "INFO");
        assert_eq!(values["loggingMaxSizeMb"], 5);
        assert_eq!(values["loggingBackupCount"], 3);
        assert_eq!(values["loggingMemoryMonitorEnabled"], true);
        assert_eq!(values["loggingMemoryMonitorIntervalSeconds"], 300);
    }

    #[test]
    fn logging_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
logging:
  level: DEBUG
  max_size_mb: 12
  backup_count: 7
  memory_monitor:
    enabled: false
    interval_seconds: 120
"#,
        )
        .unwrap();
        let values = build_hermes_logging_config_values(&config);
        assert_eq!(values["loggingLevel"], "DEBUG");
        assert_eq!(values["loggingMaxSizeMb"], 12);
        assert_eq!(values["loggingBackupCount"], 7);
        assert_eq!(values["loggingMemoryMonitorEnabled"], false);
        assert_eq!(values["loggingMemoryMonitorIntervalSeconds"], 120);
    }

    #[test]
    fn merge_logging_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
logging:
  level: INFO
  custom_flag: keep-logging
  memory_monitor:
    custom_flag: keep-memory-monitor
cron:
  wrap_response: true
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_logging_config(
            &mut config,
            &json!({
                "loggingLevel": "WARNING",
                "loggingMaxSizeMb": "20",
                "loggingBackupCount": "5",
                "loggingMemoryMonitorEnabled": true,
                "loggingMemoryMonitorIntervalSeconds": "180",
            }),
        )
        .unwrap();

        assert_eq!(config["cron"]["wrap_response"].as_bool(), Some(true));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["logging"]["level"].as_str(), Some("WARNING"));
        assert_eq!(config["logging"]["max_size_mb"].as_i64(), Some(20));
        assert_eq!(config["logging"]["backup_count"].as_i64(), Some(5));
        assert_eq!(
            config["logging"]["memory_monitor"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["logging"]["memory_monitor"]["interval_seconds"].as_i64(),
            Some(180)
        );
        assert_eq!(
            config["logging"]["custom_flag"].as_str(),
            Some("keep-logging")
        );
        assert_eq!(
            config["logging"]["memory_monitor"]["custom_flag"].as_str(),
            Some("keep-memory-monitor")
        );
    }

    #[test]
    fn merge_logging_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_logging_config(&mut config, &json!({ "loggingLevel": "TRACE" }))
            .unwrap_err();
        assert!(err.contains("logging.level"));
        let err = merge_hermes_logging_config(&mut config, &json!({ "loggingMaxSizeMb": 0 }))
            .unwrap_err();
        assert!(err.contains("logging.max_size_mb"));
        let err = merge_hermes_logging_config(&mut config, &json!({ "loggingBackupCount": -1 }))
            .unwrap_err();
        assert!(err.contains("logging.backup_count"));
        let err = merge_hermes_logging_config(
            &mut config,
            &json!({ "loggingMemoryMonitorIntervalSeconds": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("logging.memory_monitor.interval_seconds"));
    }
}

#[cfg(test)]
mod hermes_approvals_config_tests {
    use super::{build_hermes_approvals_config_values, merge_hermes_approvals_config};
    use serde_json::json;

    #[test]
    fn approvals_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_approvals_config_values(&config);
        assert_eq!(values["approvalMode"], "manual");
        assert_eq!(values["approvalTimeout"], 60);
        assert_eq!(values["approvalCronMode"], "deny");
        assert_eq!(values["approvalMcpReloadConfirm"], true);
        assert_eq!(values["approvalDestructiveSlashConfirm"], true);
    }

    #[test]
    fn approvals_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
approvals:
  mode: smart
  timeout: 120
  cron_mode: approve
  mcp_reload_confirm: false
  destructive_slash_confirm: false
"#,
        )
        .unwrap();
        let values = build_hermes_approvals_config_values(&config);
        assert_eq!(values["approvalMode"], "smart");
        assert_eq!(values["approvalTimeout"], 120);
        assert_eq!(values["approvalCronMode"], "approve");
        assert_eq!(values["approvalMcpReloadConfirm"], false);
        assert_eq!(values["approvalDestructiveSlashConfirm"], false);
    }

    #[test]
    fn merge_approvals_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
approvals:
  mode: manual
  custom_flag: keep-approvals
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_approvals_config(
            &mut config,
            &json!({
                "approvalMode": "off",
                "approvalTimeout": "15",
                "approvalCronMode": "approve",
                "approvalMcpReloadConfirm": false,
                "approvalDestructiveSlashConfirm": false,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["approvals"]["mode"].as_str(), Some("off"));
        assert_eq!(config["approvals"]["timeout"].as_i64(), Some(15));
        assert_eq!(config["approvals"]["cron_mode"].as_str(), Some("approve"));
        assert_eq!(
            config["approvals"]["mcp_reload_confirm"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["approvals"]["destructive_slash_confirm"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["approvals"]["custom_flag"].as_str(),
            Some("keep-approvals")
        );
    }

    #[test]
    fn merge_approvals_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_approvals_config(&mut config, &json!({ "approvalMode": "always" }))
            .unwrap_err();
        assert!(err.contains("approvals.mode"));
        let err =
            merge_hermes_approvals_config(&mut config, &json!({ "approvalCronMode": "prompt" }))
                .unwrap_err();
        assert!(err.contains("approvals.cron_mode"));
        let err = merge_hermes_approvals_config(&mut config, &json!({ "approvalTimeout": 0 }))
            .unwrap_err();
        assert!(err.contains("approvals.timeout"));
        let err = merge_hermes_approvals_config(&mut config, &json!({ "approvalTimeout": 86401 }))
            .unwrap_err();
        assert!(err.contains("approvals.timeout"));
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
        assert_eq!(values["terminalShellInitFiles"], "");
        assert_eq!(values["terminalAutoSourceBashrc"], true);
        assert_eq!(values["terminalPersistentShell"], true);
        assert_eq!(values["terminalEnvPassthrough"], "");
        assert_eq!(values["terminalDockerMountCwdToWorkspace"], false);
        assert_eq!(values["terminalDockerRunAsHostUser"], false);
        assert_eq!(values["terminalContainerCpu"], 1);
        assert_eq!(values["terminalContainerMemory"], 5120);
        assert_eq!(values["terminalContainerDisk"], 51200);
        assert_eq!(values["terminalContainerPersistent"], true);
        assert_eq!(values["terminalDockerImage"], "");
        assert_eq!(values["terminalSingularityImage"], "");
        assert_eq!(values["terminalModalImage"], "");
        assert_eq!(values["terminalModalMode"], "auto");
        assert_eq!(values["terminalVercelRuntime"], "node24");
        assert_eq!(values["terminalDaytonaImage"], "");
        assert_eq!(values["terminalDockerForwardEnv"], "");
        assert_eq!(values["terminalDockerEnvJson"], "{}");
        assert_eq!(values["terminalDockerVolumes"], "");
        assert_eq!(values["terminalDockerExtraArgs"], "");
        assert_eq!(values["terminalSshHost"], "");
        assert_eq!(values["terminalSshUser"], "");
        assert_eq!(values["terminalSshPort"], 22);
        assert_eq!(values["terminalSshKey"], "");
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
  shell_init_files:
    - ~/.zshrc
    - ${HOME}/.config/hermes/env.sh
  auto_source_bashrc: false
  persistent_shell: false
  env_passthrough:
    - OPENROUTER_API_KEY
    - GITHUB_TOKEN
  docker_mount_cwd_to_workspace: true
  docker_run_as_host_user: true
  docker_image: nikolaik/python-nodejs:python3.11-nodejs20
  docker_forward_env:
    - GITHUB_TOKEN
    - NPM_TOKEN
  docker_env:
    PLAYWRIGHT_BROWSERS_PATH: /ms-playwright
    PIP_CACHE_DIR: /workspace/.cache/pip
  docker_volumes:
    - /data/projects:/workspace/projects
    - /data/cache:/cache
  docker_extra_args:
    - --network=host
    - --add-host=host.docker.internal:host-gateway
  singularity_image: docker://nikolaik/python-nodejs:python3.11-nodejs20
  modal_image: python:3.12
  modal_mode: managed
  vercel_runtime: python3.13
  daytona_image: ubuntu:24.04
  ssh_host: build.example.com
  ssh_user: deploy
  ssh_port: 2222
  ssh_key: ~/.ssh/hermes_ed25519
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
        assert_eq!(
            values["terminalShellInitFiles"],
            "~/.zshrc\n${HOME}/.config/hermes/env.sh"
        );
        assert_eq!(values["terminalAutoSourceBashrc"], false);
        assert_eq!(values["terminalPersistentShell"], false);
        assert_eq!(
            values["terminalEnvPassthrough"],
            "OPENROUTER_API_KEY\nGITHUB_TOKEN"
        );
        assert_eq!(values["terminalDockerMountCwdToWorkspace"], true);
        assert_eq!(values["terminalDockerRunAsHostUser"], true);
        assert_eq!(
            values["terminalDockerImage"],
            "nikolaik/python-nodejs:python3.11-nodejs20"
        );
        assert_eq!(
            values["terminalDockerForwardEnv"],
            "GITHUB_TOKEN\nNPM_TOKEN"
        );
        assert_eq!(
            values["terminalDockerEnvJson"],
            "{\n  \"PLAYWRIGHT_BROWSERS_PATH\": \"/ms-playwright\",\n  \"PIP_CACHE_DIR\": \"/workspace/.cache/pip\"\n}"
        );
        assert_eq!(
            values["terminalDockerVolumes"],
            "/data/projects:/workspace/projects\n/data/cache:/cache"
        );
        assert_eq!(
            values["terminalDockerExtraArgs"],
            "--network=host\n--add-host=host.docker.internal:host-gateway"
        );
        assert_eq!(
            values["terminalSingularityImage"],
            "docker://nikolaik/python-nodejs:python3.11-nodejs20"
        );
        assert_eq!(values["terminalModalImage"], "python:3.12");
        assert_eq!(values["terminalModalMode"], "managed");
        assert_eq!(values["terminalVercelRuntime"], "python3.13");
        assert_eq!(values["terminalDaytonaImage"], "ubuntu:24.04");
        assert_eq!(values["terminalSshHost"], "build.example.com");
        assert_eq!(values["terminalSshUser"], "deploy");
        assert_eq!(values["terminalSshPort"], 2222);
        assert_eq!(values["terminalSshKey"], "~/.ssh/hermes_ed25519");
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
  shell_init_files:
    - ~/.profile
  env_passthrough:
    - OLD_TOKEN
  docker_image: custom/python-node
  docker_forward_env:
    - OLD_TOKEN
  docker_env:
    OLD_FLAG: keep-old
  docker_volumes:
    - /old:/old
  docker_extra_args:
    - --old
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
                "terminalShellInitFiles": "~/.zshrc\n${HOME}/.config/hermes/env.sh\n~/.zshrc",
                "terminalAutoSourceBashrc": false,
                "terminalPersistentShell": false,
                "terminalEnvPassthrough": "OPENROUTER_API_KEY\nGITHUB_TOKEN\nOPENROUTER_API_KEY",
                "terminalDockerMountCwdToWorkspace": true,
                "terminalDockerRunAsHostUser": true,
                "terminalDockerImage": "nikolaik/python-nodejs:python3.12-nodejs22",
                "terminalDockerForwardEnv": "GITHUB_TOKEN\nNPM_TOKEN\nGITHUB_TOKEN",
                "terminalDockerEnvJson": "{ \"PLAYWRIGHT_BROWSERS_PATH\": \"/ms-playwright\", \"PIP_CACHE_DIR\": \"/workspace/.cache/pip\" }",
                "terminalDockerVolumes": "/data/projects:/workspace/projects\n/data/cache:/cache\n/data/projects:/workspace/projects",
                "terminalDockerExtraArgs": "--network=host\n--add-host=host.docker.internal:host-gateway\n--network=host",
                "terminalSingularityImage": "docker://ubuntu:24.04",
                "terminalModalImage": "debian:bookworm",
                "terminalModalMode": "direct",
                "terminalVercelRuntime": "node22",
                "terminalDaytonaImage": "ubuntu:22.04",
                "terminalSshHost": "ssh.example.com",
                "terminalSshUser": "hermes",
                "terminalSshPort": "2200",
                "terminalSshKey": "~/.ssh/id_ed25519",
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
            config["terminal"]["shell_init_files"][0].as_str(),
            Some("~/.zshrc")
        );
        assert_eq!(
            config["terminal"]["shell_init_files"][1].as_str(),
            Some("${HOME}/.config/hermes/env.sh")
        );
        assert_eq!(
            config["terminal"]["shell_init_files"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            config["terminal"]["auto_source_bashrc"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["persistent_shell"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["env_passthrough"][0].as_str(),
            Some("OPENROUTER_API_KEY")
        );
        assert_eq!(
            config["terminal"]["env_passthrough"][1].as_str(),
            Some("GITHUB_TOKEN")
        );
        assert_eq!(
            config["terminal"]["env_passthrough"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            config["terminal"]["docker_mount_cwd_to_workspace"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["terminal"]["docker_run_as_host_user"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["terminal"]["docker_image"].as_str(),
            Some("nikolaik/python-nodejs:python3.12-nodejs22")
        );
        assert_eq!(
            config["terminal"]["singularity_image"].as_str(),
            Some("docker://ubuntu:24.04")
        );
        assert_eq!(
            config["terminal"]["modal_image"].as_str(),
            Some("debian:bookworm")
        );
        assert_eq!(config["terminal"]["modal_mode"].as_str(), Some("direct"));
        assert_eq!(
            config["terminal"]["vercel_runtime"].as_str(),
            Some("node22")
        );
        assert_eq!(
            config["terminal"]["daytona_image"].as_str(),
            Some("ubuntu:22.04")
        );
        assert_eq!(
            config["terminal"]["ssh_host"].as_str(),
            Some("ssh.example.com")
        );
        assert_eq!(config["terminal"]["ssh_user"].as_str(), Some("hermes"));
        assert_eq!(config["terminal"]["ssh_port"].as_i64(), Some(2200));
        assert_eq!(
            config["terminal"]["ssh_key"].as_str(),
            Some("~/.ssh/id_ed25519")
        );
        assert_eq!(config["terminal"]["container_cpu"].as_i64(), Some(2));
        assert_eq!(config["terminal"]["container_memory"].as_i64(), Some(6144));
        assert_eq!(config["terminal"]["container_disk"].as_i64(), Some(20480));
        assert_eq!(
            config["terminal"]["container_persistent"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["docker_forward_env"][0].as_str(),
            Some("GITHUB_TOKEN")
        );
        assert_eq!(
            config["terminal"]["docker_forward_env"][1].as_str(),
            Some("NPM_TOKEN")
        );
        assert_eq!(
            config["terminal"]["docker_forward_env"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            config["terminal"]["docker_env"]["PLAYWRIGHT_BROWSERS_PATH"].as_str(),
            Some("/ms-playwright")
        );
        assert_eq!(
            config["terminal"]["docker_env"]["PIP_CACHE_DIR"].as_str(),
            Some("/workspace/.cache/pip")
        );
        assert_eq!(
            config["terminal"]["docker_volumes"][0].as_str(),
            Some("/data/projects:/workspace/projects")
        );
        assert_eq!(
            config["terminal"]["docker_volumes"][1].as_str(),
            Some("/data/cache:/cache")
        );
        assert_eq!(
            config["terminal"]["docker_volumes"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            config["terminal"]["docker_extra_args"][0].as_str(),
            Some("--network=host")
        );
        assert_eq!(
            config["terminal"]["docker_extra_args"][1].as_str(),
            Some("--add-host=host.docker.internal:host-gateway")
        );
        assert_eq!(
            config["terminal"]["docker_extra_args"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_docker_advanced_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  docker_env:
    OLD_FLAG: "1"
  docker_volumes:
    - /old:/old
  docker_extra_args:
    - --old
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalDockerEnvJson": "{}",
                "terminalDockerVolumes": "  \n",
                "terminalDockerExtraArgs": "  \n",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["docker_env"].is_null());
        assert!(config["terminal"]["docker_volumes"].is_null());
        assert!(config["terminal"]["docker_extra_args"].is_null());
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_docker_forward_env() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  docker_forward_env:
    - GITHUB_TOKEN
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalDockerForwardEnv": "  \n",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["docker_forward_env"].is_null());
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_shell_init_files() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  shell_init_files:
    - ~/.bashrc
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalShellInitFiles": "  \n",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["shell_init_files"].is_null());
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_env_passthrough() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  env_passthrough:
    - OPENROUTER_API_KEY
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalEnvPassthrough": "  \n",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["env_passthrough"].is_null());
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_images() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  docker_image: old-docker
  singularity_image: old-singularity
  modal_image: old-modal
  daytona_image: old-daytona
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalDockerImage": "",
                "terminalSingularityImage": "  ",
                "terminalModalImage": "",
                "terminalDaytonaImage": " ",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["docker_image"].is_null());
        assert!(config["terminal"]["singularity_image"].is_null());
        assert!(config["terminal"]["modal_image"].is_null());
        assert!(config["terminal"]["daytona_image"].is_null());
        assert_eq!(
            config["terminal"]["custom_flag"].as_str(),
            Some("keep-terminal")
        );
    }

    #[test]
    fn merge_terminal_config_removes_empty_ssh_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
terminal:
  ssh_host: old-host
  ssh_user: old-user
  ssh_port: 2200
  ssh_key: ~/.ssh/old
  custom_flag: keep-terminal
"#,
        )
        .unwrap();

        merge_hermes_terminal_config(
            &mut config,
            &json!({
                "terminalSshHost": "",
                "terminalSshUser": "  ",
                "terminalSshPort": "22",
                "terminalSshKey": "",
            }),
        )
        .unwrap();

        assert!(config["terminal"]["ssh_host"].is_null());
        assert!(config["terminal"]["ssh_user"].is_null());
        assert!(config["terminal"]["ssh_key"].is_null());
        assert_eq!(config["terminal"]["ssh_port"].as_i64(), Some(22));
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
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalModalMode": "unsafe" }))
                .unwrap_err();
        assert!(err.contains("terminal.modal_mode"));
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalVercelRuntime": "ruby" }))
                .unwrap_err();
        assert!(err.contains("terminal.vercel_runtime"));
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
        let err = merge_hermes_terminal_config(&mut config, &json!({ "terminalSshPort": 0 }))
            .unwrap_err();
        assert!(err.contains("terminal.ssh_port"));
        let err = merge_hermes_terminal_config(&mut config, &json!({ "terminalSshPort": 65536 }))
            .unwrap_err();
        assert!(err.contains("terminal.ssh_port"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalDockerForwardEnv": "GOOD_TOKEN\nBAD TOKEN" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.docker_forward_env"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalShellInitFiles": "valid.sh\nbad path.sh" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.shell_init_files"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalEnvPassthrough": "GOOD_TOKEN\nBAD TOKEN" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.env_passthrough"));
        let err =
            merge_hermes_terminal_config(&mut config, &json!({ "terminalDockerEnvJson": "[]" }))
                .unwrap_err();
        assert!(err.contains("terminal.docker_env"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalDockerEnvJson": "{ \"BAD KEY\": \"value\" }" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.docker_env"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalDockerVolumes": "/host only" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.docker_volumes"));
        let err = merge_hermes_terminal_config(
            &mut config,
            &json!({ "terminalDockerExtraArgs": "bad arg" }),
        )
        .unwrap_err();
        assert!(err.contains("terminal.docker_extra_args"));
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
        assert_eq!(values["qmdRerank"], true);
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
  qmd:
    provider: qmd
    rerank: true
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
                "qmdRerank": false,
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
        assert_eq!(config["memory"]["qmd"]["rerank"].as_bool(), Some(false));
        assert_eq!(config["memory"]["qmd"]["provider"].as_str(), Some("qmd"));
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
        assert_eq!(values["templateVars"], true);
        assert_eq!(values["inlineShell"], false);
        assert_eq!(values["inlineShellTimeout"], 10);
        assert_eq!(values["guardAgentCreated"], false);
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
  template_vars: false
  inline_shell: true
  inline_shell_timeout: 25
  guard_agent_created: true
"#,
        )
        .unwrap();

        let values = build_hermes_skills_config_values(&config);
        assert_eq!(values["creationNudgeInterval"], 30);
        assert_eq!(
            values["externalDirs"],
            "~/.agents/skills\n/home/shared/team-skills"
        );
        assert_eq!(values["templateVars"], false);
        assert_eq!(values["inlineShell"], true);
        assert_eq!(values["inlineShellTimeout"], 25);
        assert_eq!(values["guardAgentCreated"], true);
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
                "templateVars": false,
                "inlineShell": true,
                "inlineShellTimeout": "30",
                "guardAgentCreated": true,
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
        assert_eq!(config["skills"]["template_vars"].as_bool(), Some(false));
        assert_eq!(config["skills"]["inline_shell"].as_bool(), Some(true));
        assert_eq!(config["skills"]["inline_shell_timeout"].as_i64(), Some(30));
        assert_eq!(
            config["skills"]["guard_agent_created"].as_bool(),
            Some(true)
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
        let err = merge_hermes_skills_config(&mut config, &json!({ "inlineShellTimeout": 0 }))
            .unwrap_err();
        assert!(err.contains("skills.inline_shell_timeout"));
        let err = merge_hermes_skills_config(&mut config, &json!({ "inlineShellTimeout": 86401 }))
            .unwrap_err();
        assert!(err.contains("skills.inline_shell_timeout"));
    }
}

#[cfg(test)]
mod hermes_curator_config_tests {
    use super::{build_hermes_curator_config_values, merge_hermes_curator_config};
    use serde_json::json;

    #[test]
    fn curator_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_curator_config_values(&config);
        assert_eq!(values["curatorEnabled"], true);
        assert_eq!(values["curatorIntervalHours"], 168);
        assert_eq!(values["curatorMinIdleHours"], 2);
        assert_eq!(values["curatorStaleAfterDays"], 30);
        assert_eq!(values["curatorArchiveAfterDays"], 90);
        assert_eq!(values["curatorBackupEnabled"], true);
        assert_eq!(values["curatorBackupKeep"], 5);
    }

    #[test]
    fn curator_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
curator:
  enabled: false
  interval_hours: 24
  min_idle_hours: 6
  stale_after_days: 14
  archive_after_days: 45
  backup:
    enabled: false
    keep: 9
"#,
        )
        .unwrap();

        let values = build_hermes_curator_config_values(&config);
        assert_eq!(values["curatorEnabled"], false);
        assert_eq!(values["curatorIntervalHours"], 24);
        assert_eq!(values["curatorMinIdleHours"], 6);
        assert_eq!(values["curatorStaleAfterDays"], 14);
        assert_eq!(values["curatorArchiveAfterDays"], 45);
        assert_eq!(values["curatorBackupEnabled"], false);
        assert_eq!(values["curatorBackupKeep"], 9);
    }

    #[test]
    fn merge_curator_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
curator:
  enabled: true
  backup:
    enabled: true
    custom_flag: keep-backup
  custom_flag: keep-curator
skills:
  external_dirs:
    - ~/.agents/skills
model:
  provider: anthropic
"#,
        )
        .unwrap();

        merge_hermes_curator_config(
            &mut config,
            &json!({
                "curatorEnabled": false,
                "curatorIntervalHours": "48",
                "curatorMinIdleHours": "4",
                "curatorStaleAfterDays": "21",
                "curatorArchiveAfterDays": "60",
                "curatorBackupEnabled": false,
                "curatorBackupKeep": "3",
            }),
        )
        .unwrap();

        assert_eq!(
            config["skills"]["external_dirs"][0].as_str(),
            Some("~/.agents/skills")
        );
        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["curator"]["enabled"].as_bool(), Some(false));
        assert_eq!(config["curator"]["interval_hours"].as_i64(), Some(48));
        assert_eq!(config["curator"]["min_idle_hours"].as_i64(), Some(4));
        assert_eq!(config["curator"]["stale_after_days"].as_i64(), Some(21));
        assert_eq!(config["curator"]["archive_after_days"].as_i64(), Some(60));
        assert_eq!(
            config["curator"]["backup"]["enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(config["curator"]["backup"]["keep"].as_i64(), Some(3));
        assert_eq!(
            config["curator"]["backup"]["custom_flag"].as_str(),
            Some("keep-backup")
        );
        assert_eq!(
            config["curator"]["custom_flag"].as_str(),
            Some("keep-curator")
        );
    }

    #[test]
    fn merge_curator_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_curator_config(&mut config, &json!({ "curatorIntervalHours": 0 }))
            .unwrap_err();
        assert!(err.contains("curator.interval_hours"));
        let err = merge_hermes_curator_config(&mut config, &json!({ "curatorMinIdleHours": -1 }))
            .unwrap_err();
        assert!(err.contains("curator.min_idle_hours"));
        let err = merge_hermes_curator_config(&mut config, &json!({ "curatorBackupKeep": 1001 }))
            .unwrap_err();
        assert!(err.contains("curator.backup.keep"));
        let err = merge_hermes_curator_config(
            &mut config,
            &json!({
                "curatorStaleAfterDays": 90,
                "curatorArchiveAfterDays": 30,
            }),
        )
        .unwrap_err();
        assert!(err.contains("curator.archive_after_days"));
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
mod hermes_model_config_tests {
    use super::{build_hermes_model_config_values, merge_hermes_model_config};
    use serde_json::json;

    #[test]
    fn model_values_have_defaults_and_read_legacy_model_key() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_model_config_values(&config);
        assert_eq!(values["modelDefault"], "");
        assert_eq!(values["modelProvider"], "auto");
        assert_eq!(values["modelBaseUrl"], "");
        assert_eq!(values["modelContextLength"], "");
        assert_eq!(values["modelMaxTokens"], "");

        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  model: anthropic/claude-sonnet-4-6
  provider: openrouter
  base_url: https://openrouter.ai/api/v1
  context_length: 131072
  max_tokens: 8192
"#,
        )
        .unwrap();
        let values = build_hermes_model_config_values(&config);
        assert_eq!(values["modelDefault"], "anthropic/claude-sonnet-4-6");
        assert_eq!(values["modelProvider"], "openrouter");
        assert_eq!(values["modelBaseUrl"], "https://openrouter.ai/api/v1");
        assert_eq!(values["modelContextLength"], "131072");
        assert_eq!(values["modelMaxTokens"], "8192");
    }

    #[test]
    fn merge_model_preserves_unknown_fields_and_writes_base_url() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  default: old-model
  provider: auto
  base_url: https://old.example/v1
  auth_mode: env
  context_length: 200000
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "anthropic/claude-opus-4.6",
                "modelProvider": "openrouter",
                "modelBaseUrl": "https://openrouter.ai/api/v1",
                "modelContextLength": "262144",
                "modelMaxTokens": "16384",
            }),
        )
        .unwrap();

        assert_eq!(
            config["model"]["default"].as_str(),
            Some("anthropic/claude-opus-4.6")
        );
        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(
            config["model"]["base_url"].as_str(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(config["model"]["context_length"].as_i64(), Some(262144));
        assert_eq!(config["model"]["max_tokens"].as_i64(), Some(16384));
        assert_eq!(config["model"]["auth_mode"].as_str(), Some("env"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_model_empty_base_url_removes_field_and_legacy_model_key() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  model: old-model
  provider: custom
  base_url: https://old.example/v1
  max_tokens: 8192
display:
  language: zh
"#,
        )
        .unwrap();

        merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "google/gemini-3-flash-preview",
                "modelProvider": "auto",
                "modelBaseUrl": "  ",
                "modelContextLength": "",
                "modelMaxTokens": " ",
            }),
        )
        .unwrap();

        assert_eq!(
            config["model"]["default"].as_str(),
            Some("google/gemini-3-flash-preview")
        );
        assert_eq!(config["model"]["provider"].as_str(), Some("auto"));
        assert!(config["model"]["base_url"].is_null());
        assert!(config["model"]["model"].is_null());
        assert!(config["model"]["context_length"].is_null());
        assert!(config["model"]["max_tokens"].is_null());
        assert_eq!(config["display"]["language"].as_str(), Some("zh"));
    }

    #[test]
    fn merge_model_rejects_empty_model() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": " ",
                "modelProvider": "auto",
            }),
        )
        .unwrap_err();
        assert!(err.contains("model.default"));
    }

    #[test]
    fn merge_model_rejects_non_string_form_values() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  default: gpt-5
  provider: auto
"#,
        )
        .unwrap();
        let err = merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "gpt-5",
                "modelProvider": 123,
            }),
        )
        .unwrap_err();
        assert!(err.contains("model.provider"));

        let err = merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "gpt-5",
                "modelProvider": "auto",
                "modelBaseUrl": 123,
            }),
        )
        .unwrap_err();
        assert!(err.contains("model.base_url"));

        let err = merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "gpt-5",
                "modelProvider": "auto",
                "modelContextLength": "0",
            }),
        )
        .unwrap_err();
        assert!(err.contains("model.context_length"));

        let err = merge_hermes_model_config(
            &mut config,
            &json!({
                "modelDefault": "gpt-5",
                "modelProvider": "auto",
                "modelMaxTokens": "1.5",
            }),
        )
        .unwrap_err();
        assert!(err.contains("model.max_tokens"));
    }
}

#[cfg(test)]
mod hermes_model_aliases_config_tests {
    use super::{build_hermes_model_aliases_config_values, merge_hermes_model_aliases_config};
    use serde_json::json;

    #[test]
    fn model_aliases_values_have_empty_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_model_aliases_config_values(&config);
        assert_eq!(values["modelAliasesJson"], "{}");
    }

    #[test]
    fn model_aliases_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model_aliases:
  opus:
    model: claude-opus-4-6
    provider: anthropic
  qwen:
    model: "qwen3.5:397b"
    provider: custom
    base_url: https://ollama.com/v1
"#,
        )
        .unwrap();

        let values = build_hermes_model_aliases_config_values(&config);
        let parsed: serde_json::Value =
            serde_json::from_str(values["modelAliasesJson"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["opus"]["model"], "claude-opus-4-6");
        assert_eq!(parsed["opus"]["provider"], "anthropic");
        assert_eq!(parsed["qwen"]["model"], "qwen3.5:397b");
        assert_eq!(parsed["qwen"]["base_url"], "https://ollama.com/v1");
    }

    #[test]
    fn merge_model_aliases_config_preserves_unknown_fields_and_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
model_aliases:
  opus:
    model: old-opus
    provider: anthropic
    custom_flag: drop-with-replace
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_model_aliases_config(
            &mut config,
            &json!({
                "modelAliasesJson": r#"{
                  "opus": {
                    "model": "claude-opus-4-6",
                    "provider": "anthropic",
                    "custom_flag": "keep-alias"
                  },
                  "qwen": {
                    "model": "qwen3.5:397b",
                    "provider": "custom",
                    "base_url": "https://ollama.com/v1"
                  }
                }"#,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["model_aliases"]["opus"]["model"].as_str(),
            Some("claude-opus-4-6")
        );
        assert_eq!(
            config["model_aliases"]["opus"]["custom_flag"].as_str(),
            Some("keep-alias")
        );
        assert_eq!(
            config["model_aliases"]["qwen"]["provider"].as_str(),
            Some("custom")
        );
        assert_eq!(
            config["model_aliases"]["qwen"]["base_url"].as_str(),
            Some("https://ollama.com/v1")
        );
    }

    #[test]
    fn merge_model_aliases_config_removes_empty_mapping() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model_aliases:
  opus:
    model: claude-opus-4-6
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_model_aliases_config(&mut config, &json!({ "modelAliasesJson": "{}" }))
            .unwrap();

        assert!(config["model_aliases"].is_null());
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_model_aliases_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_model_aliases_config(&mut config, &json!({ "modelAliasesJson": "[" }))
                .unwrap_err();
        assert!(err.contains("model_aliases JSON"));
        let err =
            merge_hermes_model_aliases_config(&mut config, &json!({ "modelAliasesJson": "[]" }))
                .unwrap_err();
        assert!(err.contains("model_aliases"));
        let err = merge_hermes_model_aliases_config(
            &mut config,
            &json!({ "modelAliasesJson": r#"{ "bad alias": { "model": "m", "provider": "p" } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("model_aliases.bad alias"));
        let err = merge_hermes_model_aliases_config(
            &mut config,
            &json!({ "modelAliasesJson": r#"{ "opus": "claude-opus-4-6" }"# }),
        )
        .unwrap_err();
        assert!(err.contains("model_aliases.opus"));
        let err = merge_hermes_model_aliases_config(
            &mut config,
            &json!({ "modelAliasesJson": r#"{ "opus": { "provider": "anthropic" } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("model_aliases.opus.model"));
        let err = merge_hermes_model_aliases_config(
            &mut config,
            &json!({ "modelAliasesJson": r#"{ "opus": { "model": "claude-opus-4-6", "provider": 123 } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("model_aliases.opus.provider"));
        let err = merge_hermes_model_aliases_config(
            &mut config,
            &json!({ "modelAliasesJson": r#"{ "qwen": { "model": "qwen3.5:397b", "base_url": 123 } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("model_aliases.qwen.base_url"));
    }
}

#[cfg(test)]
mod hermes_hooks_config_tests {
    use super::{build_hermes_hooks_config_values, merge_hermes_hooks_config};
    use serde_json::json;

    #[test]
    fn hooks_values_have_safe_defaults() {
        let config = serde_yaml::Value::Mapping(Default::default());
        let values = build_hermes_hooks_config_values(&config);

        assert_eq!(values["hooksAutoAccept"], false);
        assert_eq!(values["hooksJson"], "{}");
    }

    #[test]
    fn hooks_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
hooks_auto_accept: true
hooks:
  pre_tool_call:
    - matcher: terminal
      command: ~/.hermes/agent-hooks/block-rm-rf.sh
      timeout: 10
  pre_llm_call:
    - command: ~/.hermes/agent-hooks/inject-cwd-context.sh
"#,
        )
        .unwrap();

        let values = build_hermes_hooks_config_values(&config);
        let hooks: serde_json::Value =
            serde_json::from_str(values["hooksJson"].as_str().unwrap()).unwrap();

        assert_eq!(values["hooksAutoAccept"], true);
        assert_eq!(hooks["pre_tool_call"][0]["matcher"], "terminal");
        assert_eq!(
            hooks["pre_tool_call"][0]["command"],
            "~/.hermes/agent-hooks/block-rm-rf.sh"
        );
        assert_eq!(hooks["pre_tool_call"][0]["timeout"], 10);
        assert_eq!(
            hooks["pre_llm_call"][0]["command"],
            "~/.hermes/agent-hooks/inject-cwd-context.sh"
        );
    }

    #[test]
    fn merge_hooks_config_preserves_unknown_fields_and_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
hooks:
  pre_tool_call:
    - matcher: terminal
      command: old-hook.sh
      extra_flag: keep-old
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_hooks_config(
            &mut config,
            &json!({
                "hooksAutoAccept": "true",
                "hooksJson": serde_json::to_string(&json!({
                    "pre_tool_call": [{
                        "matcher": "terminal",
                        "command": "~/.hermes/agent-hooks/block-rm-rf.sh",
                        "timeout": 10,
                        "extra_flag": "keep-hook"
                    }],
                    "post_tool_call": [{
                        "matcher": "write_file|patch",
                        "command": "~/.hermes/agent-hooks/auto-format.sh"
                    }]
                })).unwrap(),
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(config["hooks_auto_accept"].as_bool(), Some(true));
        assert_eq!(
            config["hooks"]["pre_tool_call"][0]["command"].as_str(),
            Some("~/.hermes/agent-hooks/block-rm-rf.sh")
        );
        assert_eq!(
            config["hooks"]["pre_tool_call"][0]["timeout"].as_i64(),
            Some(10)
        );
        assert_eq!(
            config["hooks"]["pre_tool_call"][0]["extra_flag"].as_str(),
            Some("keep-hook")
        );
        assert_eq!(
            config["hooks"]["post_tool_call"][0]["matcher"].as_str(),
            Some("write_file|patch")
        );
    }

    #[test]
    fn merge_hooks_config_removes_empty_mapping_but_keeps_auto_accept() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
hooks_auto_accept: true
hooks:
  pre_tool_call:
    - command: old-hook.sh
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksAutoAccept": false, "hooksJson": "{}" }),
        )
        .unwrap();

        assert!(config["hooks"].is_null());
        assert_eq!(config["hooks_auto_accept"].as_bool(), Some(false));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_hooks_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(Default::default());
        let err = merge_hermes_hooks_config(&mut config, &json!({ "hooksJson": "[" })).unwrap_err();
        assert!(err.contains("hooks JSON"));

        let err = merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksJson": serde_json::to_string(&json!({ "bad_event": [{ "command": "hook.sh" }] })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("hooks.bad_event"));

        let err = merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksJson": serde_json::to_string(&json!({ "pre_tool_call": { "command": "hook.sh" } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("hooks.pre_tool_call"));

        let err = merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksJson": serde_json::to_string(&json!({ "pre_tool_call": ["hook.sh"] })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("hooks.pre_tool_call.0"));

        let err = merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksJson": serde_json::to_string(&json!({ "pre_tool_call": [{ "command": "" }] })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("hooks.pre_tool_call.0.command"));

        let err = merge_hermes_hooks_config(
            &mut config,
            &json!({ "hooksJson": serde_json::to_string(&json!({ "pre_tool_call": [{ "command": "hook.sh", "timeout": 0 }] })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("hooks.pre_tool_call.0.timeout"));
    }
}

#[cfg(test)]
mod hermes_mcp_servers_config_tests {
    use super::{build_hermes_mcp_servers_config_values, merge_hermes_mcp_servers_config};
    use serde_json::json;

    #[test]
    fn mcp_servers_values_have_empty_defaults() {
        let config = serde_yaml::Value::Mapping(Default::default());
        let values = build_hermes_mcp_servers_config_values(&config);

        assert_eq!(values["mcpServersJson"], "{}");
    }

    #[test]
    fn mcp_servers_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
mcp_servers:
  time:
    command: uvx
    args:
      - mcp-server-time
  notion:
    url: https://mcp.notion.com/mcp
    connect_timeout: 30
"#,
        )
        .unwrap();

        let values = build_hermes_mcp_servers_config_values(&config);
        let mapping: serde_json::Value =
            serde_json::from_str(values["mcpServersJson"].as_str().unwrap()).unwrap();

        assert_eq!(mapping["time"]["command"], "uvx");
        assert_eq!(mapping["time"]["args"][0], "mcp-server-time");
        assert_eq!(mapping["notion"]["url"], "https://mcp.notion.com/mcp");
        assert_eq!(mapping["notion"]["connect_timeout"], 30);
    }

    #[test]
    fn merge_mcp_servers_config_preserves_unknown_fields_and_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
mcp_servers:
  time:
    command: uvx
    args:
      - old-server
    sampling:
      enabled: true
      model: gemini-3-flash
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_mcp_servers_config(
            &mut config,
            &json!({
                "mcpServersJson": serde_json::to_string(&json!({
                    "time": {
                        "command": "uvx",
                        "args": ["mcp-server-time"],
                        "timeout": 120,
                        "sampling": {
                            "enabled": true,
                            "model": "gemini-3-flash",
                            "max_tokens_cap": 4096,
                            "timeout": 30,
                            "max_rpm": 10,
                            "allowed_models": ["gemini-3-flash", "gpt-5-mini"],
                            "max_tool_rounds": 5,
                            "log_level": "info",
                            "custom_flag": "keep-sampling"
                        }
                    },
                    "notion": {
                        "url": "https://mcp.notion.com/mcp",
                        "headers": {
                            "Authorization": "Bearer token"
                        },
                        "connect_timeout": 30
                    }
                })).unwrap(),
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["mcp_servers"]["time"]["command"].as_str(),
            Some("uvx")
        );
        assert_eq!(
            config["mcp_servers"]["time"]["args"][0].as_str(),
            Some("mcp-server-time")
        );
        assert_eq!(config["mcp_servers"]["time"]["timeout"].as_i64(), Some(120));
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["model"].as_str(),
            Some("gemini-3-flash")
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["max_tokens_cap"].as_i64(),
            Some(4096)
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["timeout"].as_i64(),
            Some(30)
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["max_rpm"].as_i64(),
            Some(10)
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["allowed_models"][1].as_str(),
            Some("gpt-5-mini")
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["max_tool_rounds"].as_i64(),
            Some(5)
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["log_level"].as_str(),
            Some("info")
        );
        assert_eq!(
            config["mcp_servers"]["time"]["sampling"]["custom_flag"].as_str(),
            Some("keep-sampling")
        );
        assert_eq!(
            config["mcp_servers"]["notion"]["headers"]["Authorization"].as_str(),
            Some("Bearer token")
        );
        assert_eq!(
            config["mcp_servers"]["notion"]["connect_timeout"].as_i64(),
            Some(30)
        );
    }

    #[test]
    fn merge_mcp_servers_config_removes_empty_mapping() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
mcp_servers:
  time:
    command: uvx
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_mcp_servers_config(&mut config, &json!({ "mcpServersJson": "{}" })).unwrap();

        assert!(config["mcp_servers"].is_null());
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_mcp_servers_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(Default::default());
        let err = merge_hermes_mcp_servers_config(&mut config, &json!({ "mcpServersJson": "[" }))
            .unwrap_err();
        assert!(err.contains("mcp_servers JSON"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "bad server": { "command": "uvx" } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.bad server"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": "uvx" })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "" } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.command"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "notion": { "url": "ftp://example.com/mcp" } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.notion.url"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "args": "mcp-server-time" } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.args"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "timeout": 0 } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.timeout"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "sampling": [] } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.sampling"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "sampling": { "enabled": "yes" } } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.sampling.enabled"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "sampling": { "allowed_models": "gpt-5" } } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.sampling.allowed_models"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "sampling": { "max_tool_rounds": -1 } } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.sampling.max_tool_rounds"));

        let err = merge_hermes_mcp_servers_config(
            &mut config,
            &json!({ "mcpServersJson": serde_json::to_string(&json!({ "time": { "command": "uvx", "sampling": { "log_level": "trace" } } })).unwrap() }),
        )
        .unwrap_err();
        assert!(err.contains("mcp_servers.time.sampling.log_level"));
    }
}

#[cfg(test)]
mod hermes_provider_overrides_config_tests {
    use super::{
        build_hermes_provider_overrides_config_values, merge_hermes_provider_overrides_config,
    };
    use serde_json::json;

    #[test]
    fn provider_overrides_values_have_empty_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_provider_overrides_config_values(&config);
        assert_eq!(values["providerOverridesJson"], "{}");
    }

    #[test]
    fn provider_overrides_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
providers:
  ollama-local:
    request_timeout_seconds: 300
    stale_timeout_seconds: 900
  anthropic:
    request_timeout_seconds: 30
    models:
      claude-opus-4.6:
        timeout_seconds: 600
"#,
        )
        .unwrap();

        let values = build_hermes_provider_overrides_config_values(&config);
        let mapping: serde_json::Value =
            serde_json::from_str(values["providerOverridesJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            mapping["ollama-local"]["request_timeout_seconds"].as_i64(),
            Some(300)
        );
        assert_eq!(
            mapping["ollama-local"]["stale_timeout_seconds"].as_i64(),
            Some(900)
        );
        assert_eq!(
            mapping["anthropic"]["models"]["claude-opus-4.6"]["timeout_seconds"].as_i64(),
            Some(600)
        );
    }

    #[test]
    fn merge_provider_overrides_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: openrouter
providers:
  anthropic:
    request_timeout_seconds: 30
    custom_flag: keep-provider
    models:
      claude-opus-4.6:
        timeout_seconds: 600
        custom_flag: keep-model
openrouter:
  response_cache: true
"#,
        )
        .unwrap();

        merge_hermes_provider_overrides_config(
            &mut config,
            &json!({
                "providerOverridesJson": r#"{
                  "anthropic": {
                    "request_timeout_seconds": 45,
                    "stale_timeout_seconds": 300,
                    "custom_flag": "keep-provider",
                    "models": {
                      "claude-opus-4.6": {
                        "timeout_seconds": 900,
                        "stale_timeout_seconds": 1200,
                        "custom_flag": "keep-model"
                      }
                    }
                  },
                  "openai-codex": {
                    "models": {
                      "gpt-5.4": {
                        "stale_timeout_seconds": 1800
                      }
                    }
                  }
                }"#,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("openrouter"));
        assert_eq!(config["openrouter"]["response_cache"].as_bool(), Some(true));
        assert_eq!(
            config["providers"]["anthropic"]["request_timeout_seconds"].as_i64(),
            Some(45)
        );
        assert_eq!(
            config["providers"]["anthropic"]["stale_timeout_seconds"].as_i64(),
            Some(300)
        );
        assert_eq!(
            config["providers"]["anthropic"]["custom_flag"].as_str(),
            Some("keep-provider")
        );
        assert_eq!(
            config["providers"]["anthropic"]["models"]["claude-opus-4.6"]["timeout_seconds"]
                .as_i64(),
            Some(900)
        );
        assert_eq!(
            config["providers"]["anthropic"]["models"]["claude-opus-4.6"]["stale_timeout_seconds"]
                .as_i64(),
            Some(1200)
        );
        assert_eq!(
            config["providers"]["anthropic"]["models"]["claude-opus-4.6"]["custom_flag"].as_str(),
            Some("keep-model")
        );
        assert_eq!(
            config["providers"]["openai-codex"]["models"]["gpt-5.4"]["stale_timeout_seconds"]
                .as_i64(),
            Some(1800)
        );
    }

    #[test]
    fn merge_provider_overrides_config_removes_empty_mapping() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
providers:
  anthropic:
    request_timeout_seconds: 30
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": "{}" }),
        )
        .unwrap();

        assert!(config["providers"].is_null());
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn merge_provider_overrides_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": "[" }),
        )
        .unwrap_err();
        assert!(err.contains("providers JSON"));
        let err = merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": r#"{ "bad provider": { "request_timeout_seconds": 30 } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("providers.bad provider"));
        let err = merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": r#"{ "anthropic": { "request_timeout_seconds": 0 } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("providers.anthropic.request_timeout_seconds"));
        let err = merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": r#"{ "anthropic": { "models": { "../secret": { "timeout_seconds": 30 } } } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("providers.anthropic.models.../secret"));
        let err = merge_hermes_provider_overrides_config(
            &mut config,
            &json!({ "providerOverridesJson": r#"{ "anthropic": { "models": { "opus": { "timeout_seconds": "slow" } } } }"# }),
        )
        .unwrap_err();
        assert!(err.contains("providers.anthropic.models.opus.timeout_seconds"));
    }
}

#[cfg(test)]
mod hermes_agent_toolsets_config_tests {
    use super::{build_hermes_agent_toolsets_config_values, merge_hermes_agent_toolsets_config};
    use serde_json::json;

    #[test]
    fn agent_toolsets_values_have_empty_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_agent_toolsets_config_values(&config);
        assert_eq!(values["disabledToolsets"], "");
    }

    #[test]
    fn agent_toolsets_values_read_yaml_sequence() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
agent:
  disabled_toolsets:
    - memory
    - web
    - browser
"#,
        )
        .unwrap();

        let values = build_hermes_agent_toolsets_config_values(&config);
        assert_eq!(values["disabledToolsets"], "memory\nweb\nbrowser");
    }

    #[test]
    fn merge_agent_toolsets_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
agent:
  disabled_toolsets:
    - memory
  max_turns: 80
  custom_flag: keep-agent
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_agent_toolsets_config(
            &mut config,
            &json!({
                "disabledToolsets": " terminal \n browser \n\n memory\nbrowser ",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(
            config["agent"]["disabled_toolsets"][0].as_str(),
            Some("terminal")
        );
        assert_eq!(
            config["agent"]["disabled_toolsets"][1].as_str(),
            Some("browser")
        );
        assert_eq!(
            config["agent"]["disabled_toolsets"][2].as_str(),
            Some("memory")
        );
        assert_eq!(config["agent"]["max_turns"].as_i64(), Some(80));
        assert_eq!(config["agent"]["custom_flag"].as_str(), Some("keep-agent"));
    }

    #[test]
    fn merge_agent_toolsets_config_writes_empty_sequence() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
agent:
  disabled_toolsets:
    - memory
  custom_flag: keep-agent
"#,
        )
        .unwrap();

        merge_hermes_agent_toolsets_config(&mut config, &json!({ "disabledToolsets": "  \n " }))
            .unwrap();

        assert!(config["agent"]["disabled_toolsets"]
            .as_sequence()
            .unwrap()
            .is_empty());
        assert_eq!(config["agent"]["custom_flag"].as_str(), Some("keep-agent"));
    }

    #[test]
    fn merge_agent_toolsets_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_agent_toolsets_config(
            &mut config,
            &json!({ "disabledToolsets": "bad tool" }),
        )
        .unwrap_err();
        assert!(err.contains("agent.disabled_toolsets"));
        let err = merge_hermes_agent_toolsets_config(
            &mut config,
            &json!({ "disabledToolsets": "../secret" }),
        )
        .unwrap_err();
        assert!(err.contains("agent.disabled_toolsets"));
    }
}

#[cfg(test)]
mod hermes_platform_toolsets_config_tests {
    use super::{
        build_hermes_platform_toolsets_config_values, merge_hermes_platform_toolsets_config,
    };
    use serde_json::json;

    #[test]
    fn platform_toolsets_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_platform_toolsets_config_values(&config);
        let mapping: serde_json::Value =
            serde_json::from_str(values["platformToolsetsJson"].as_str().unwrap()).unwrap();

        assert_eq!(mapping["cli"][0].as_str(), Some("hermes-cli"));
        assert_eq!(mapping["telegram"][0].as_str(), Some("hermes-telegram"));
        assert_eq!(mapping["discord"][0].as_str(), Some("hermes-discord"));
        assert_eq!(mapping["whatsapp"][0].as_str(), Some("hermes-whatsapp"));
        assert_eq!(
            mapping["google_chat"][0].as_str(),
            Some("hermes-google_chat")
        );
    }

    #[test]
    fn platform_toolsets_values_read_yaml_mapping() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
platform_toolsets:
  cli:
    - web
    - terminal
    - file
  telegram:
    - hermes-telegram
  custom_platform:
    - safe
"#,
        )
        .unwrap();
        let values = build_hermes_platform_toolsets_config_values(&config);
        let mapping: serde_json::Value =
            serde_json::from_str(values["platformToolsetsJson"].as_str().unwrap()).unwrap();

        assert_eq!(mapping["cli"][0].as_str(), Some("web"));
        assert_eq!(mapping["cli"][1].as_str(), Some("terminal"));
        assert_eq!(mapping["cli"][2].as_str(), Some("file"));
        assert_eq!(mapping["telegram"][0].as_str(), Some("hermes-telegram"));
        assert_eq!(mapping["custom_platform"][0].as_str(), Some("safe"));
    }

    #[test]
    fn merge_platform_toolsets_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
platform_toolsets:
  cli:
    - hermes-cli
agent:
  max_turns: 80
"#,
        )
        .unwrap();

        merge_hermes_platform_toolsets_config(
            &mut config,
            &json!({
                "platformToolsetsJson": serde_json::to_string(&json!({
                    "cli": ["web", "terminal", "file", "web"],
                    "telegram": ["hermes-telegram"],
                    "custom_platform": ["safe"]
                })).unwrap()
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["agent"]["max_turns"].as_i64(), Some(80));
        assert_eq!(config["platform_toolsets"]["cli"][0].as_str(), Some("web"));
        assert_eq!(
            config["platform_toolsets"]["cli"][1].as_str(),
            Some("terminal")
        );
        assert_eq!(config["platform_toolsets"]["cli"][2].as_str(), Some("file"));
        assert_eq!(
            config["platform_toolsets"]["telegram"][0].as_str(),
            Some("hermes-telegram")
        );
        assert_eq!(
            config["platform_toolsets"]["custom_platform"][0].as_str(),
            Some("safe")
        );
    }

    #[test]
    fn merge_platform_toolsets_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_platform_toolsets_config(
            &mut config,
            &json!({ "platformToolsetsJson": "[" }),
        )
        .unwrap_err();
        assert!(err.contains("platform_toolsets JSON"));

        let err = merge_hermes_platform_toolsets_config(
            &mut config,
            &json!({ "platformToolsetsJson": r#"{"bad platform":["web"]}"# }),
        )
        .unwrap_err();
        assert!(err.contains("platform_toolsets.bad platform"));

        let err = merge_hermes_platform_toolsets_config(
            &mut config,
            &json!({ "platformToolsetsJson": r#"{"cli":["bad tool"]}"# }),
        )
        .unwrap_err();
        assert!(err.contains("platform_toolsets.cli"));

        let err = merge_hermes_platform_toolsets_config(
            &mut config,
            &json!({ "platformToolsetsJson": r#"{"cli":[]}"# }),
        )
        .unwrap_err();
        assert!(err.contains("platform_toolsets.cli"));
    }
}

#[cfg(test)]
mod hermes_agent_runtime_config_tests {
    use super::{build_hermes_agent_runtime_config_values, merge_hermes_agent_runtime_config};
    use serde_json::{json, Value};

    #[test]
    fn agent_runtime_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_agent_runtime_config_values(&config);
        assert_eq!(values["agentMaxTurns"], 90);
        assert_eq!(values["gatewayTimeout"], 1800);
        assert_eq!(values["restartDrainTimeout"], 180);
        assert_eq!(values["apiMaxRetries"], 3);
        assert_eq!(values["gatewayTimeoutWarning"], 900);
        assert_eq!(values["clarifyTimeout"], 600);
        assert_eq!(values["gatewayNotifyInterval"], 180);
        assert_eq!(values["gatewayAutoContinueFreshness"], 3600);
        assert_eq!(values["imageInputMode"], "auto");
        assert_eq!(values["agentVerbose"], false);
        assert_eq!(values["reasoningEffort"], "medium");
        assert_eq!(values["personalitiesJson"], "{}");
    }

    #[test]
    fn agent_runtime_values_read_yaml_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
agent:
  max_turns: 240
  gateway_timeout: 7200
  restart_drain_timeout: 600
  api_max_retries: 5
  gateway_timeout_warning: 1200
  clarify_timeout: 900
  gateway_notify_interval: 240
  gateway_auto_continue_freshness: 5400
  image_input_mode: native
  verbose: true
  reasoning_effort: high
  personalities:
    concise: Keep answers short.
    teacher: Explain with examples.
"#,
        )
        .unwrap();

        let values = build_hermes_agent_runtime_config_values(&config);
        assert_eq!(values["agentMaxTurns"], 240);
        assert_eq!(values["gatewayTimeout"], 7200);
        assert_eq!(values["restartDrainTimeout"], 600);
        assert_eq!(values["apiMaxRetries"], 5);
        assert_eq!(values["gatewayTimeoutWarning"], 1200);
        assert_eq!(values["clarifyTimeout"], 900);
        assert_eq!(values["gatewayNotifyInterval"], 240);
        assert_eq!(values["gatewayAutoContinueFreshness"], 5400);
        assert_eq!(values["imageInputMode"], "native");
        assert_eq!(values["agentVerbose"], true);
        assert_eq!(values["reasoningEffort"], "high");
        let personalities: Value =
            serde_json::from_str(values["personalitiesJson"].as_str().unwrap()).unwrap();
        assert_eq!(personalities["concise"], "Keep answers short.");
        assert_eq!(personalities["teacher"], "Explain with examples.");
    }

    #[test]
    fn merge_agent_runtime_config_preserves_unrelated_yaml() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
agent:
  max_turns: 90
  disabled_toolsets:
    - terminal
  custom_flag: keep-agent
streaming:
  enabled: true
"#,
        )
        .unwrap();

        merge_hermes_agent_runtime_config(
            &mut config,
            &json!({
                "agentMaxTurns": "180",
                "gatewayTimeout": "3600",
                "restartDrainTimeout": "300",
                "apiMaxRetries": "2",
                "gatewayTimeoutWarning": "600",
                "clarifyTimeout": "300",
                "gatewayNotifyInterval": "120",
                "gatewayAutoContinueFreshness": "1800",
                "imageInputMode": "text",
                "agentVerbose": true,
                "reasoningEffort": "low",
                "personalitiesJson": r#"{"concise":" Keep replies brief. ","ops":"Focus on operational risk."}"#,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["streaming"]["enabled"].as_bool(), Some(true));
        assert_eq!(config["agent"]["max_turns"].as_i64(), Some(180));
        assert_eq!(config["agent"]["gateway_timeout"].as_i64(), Some(3600));
        assert_eq!(config["agent"]["restart_drain_timeout"].as_i64(), Some(300));
        assert_eq!(config["agent"]["api_max_retries"].as_i64(), Some(2));
        assert_eq!(
            config["agent"]["gateway_timeout_warning"].as_i64(),
            Some(600)
        );
        assert_eq!(config["agent"]["clarify_timeout"].as_i64(), Some(300));
        assert_eq!(
            config["agent"]["gateway_notify_interval"].as_i64(),
            Some(120)
        );
        assert_eq!(
            config["agent"]["gateway_auto_continue_freshness"].as_i64(),
            Some(1800)
        );
        assert_eq!(config["agent"]["image_input_mode"].as_str(), Some("text"));
        assert_eq!(config["agent"]["verbose"].as_bool(), Some(true));
        assert_eq!(config["agent"]["reasoning_effort"].as_str(), Some("low"));
        assert_eq!(
            config["agent"]["personalities"]["concise"].as_str(),
            Some("Keep replies brief.")
        );
        assert_eq!(
            config["agent"]["personalities"]["ops"].as_str(),
            Some("Focus on operational risk.")
        );
        assert_eq!(
            config["agent"]["disabled_toolsets"][0].as_str(),
            Some("terminal")
        );
        assert_eq!(config["agent"]["custom_flag"].as_str(), Some("keep-agent"));
    }

    #[test]
    fn merge_agent_runtime_config_removes_empty_personalities() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
agent:
  personalities:
    concise: Keep answers short.
  custom_flag: keep-agent
"#,
        )
        .unwrap();

        merge_hermes_agent_runtime_config(
            &mut config,
            &json!({
                "personalitiesJson": "{}",
            }),
        )
        .unwrap();

        assert!(config["agent"].get("personalities").is_none());
        assert_eq!(config["agent"]["custom_flag"].as_str(), Some("keep-agent"));
    }

    #[test]
    fn merge_agent_runtime_config_allows_zero_disable_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        merge_hermes_agent_runtime_config(
            &mut config,
            &json!({
                "gatewayTimeout": "0",
                "restartDrainTimeout": "0",
                "gatewayTimeoutWarning": "0",
                "gatewayNotifyInterval": "0",
                "gatewayAutoContinueFreshness": "0",
            }),
        )
        .unwrap();

        assert_eq!(config["agent"]["gateway_timeout"].as_i64(), Some(0));
        assert_eq!(config["agent"]["restart_drain_timeout"].as_i64(), Some(0));
        assert_eq!(config["agent"]["gateway_timeout_warning"].as_i64(), Some(0));
        assert_eq!(config["agent"]["gateway_notify_interval"].as_i64(), Some(0));
        assert_eq!(
            config["agent"]["gateway_auto_continue_freshness"].as_i64(),
            Some(0)
        );
    }

    #[test]
    fn merge_agent_runtime_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err =
            merge_hermes_agent_runtime_config(&mut config, &json!({ "imageInputMode": "pixel" }))
                .unwrap_err();
        assert!(err.contains("agent.image_input_mode"));
        let err = merge_hermes_agent_runtime_config(&mut config, &json!({ "agentMaxTurns": "0" }))
            .unwrap_err();
        assert!(err.contains("agent.max_turns"));
        let err = merge_hermes_agent_runtime_config(&mut config, &json!({ "apiMaxRetries": "0" }))
            .unwrap_err();
        assert!(err.contains("agent.api_max_retries"));
        let err =
            merge_hermes_agent_runtime_config(&mut config, &json!({ "clarifyTimeout": "-1" }))
                .unwrap_err();
        assert!(err.contains("agent.clarify_timeout"));
        let err =
            merge_hermes_agent_runtime_config(&mut config, &json!({ "reasoningEffort": "max" }))
                .unwrap_err();
        assert!(err.contains("agent.reasoning_effort"));
        let err = merge_hermes_agent_runtime_config(
            &mut config,
            &json!({ "personalitiesJson": r#"{"bad name":"x"}"# }),
        )
        .unwrap_err();
        assert!(err.contains("agent.personalities.bad name"));
        let err = merge_hermes_agent_runtime_config(
            &mut config,
            &json!({ "personalitiesJson": r#"{"concise":123}"# }),
        )
        .unwrap_err();
        assert!(err.contains("agent.personalities.concise"));
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
mod hermes_display_config_tests {
    use super::{build_hermes_display_config_values, merge_hermes_display_config};
    use serde_json::json;

    #[test]
    fn display_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_display_config_values(&config);
        assert_eq!(values["displayToolProgress"], "all");
        assert_eq!(values["displayCompact"], false);
        assert_eq!(values["displaySkin"], "default");
        assert_eq!(values["displayToolPrefix"], "┊");
        assert_eq!(values["displayShowReasoning"], false);
        assert_eq!(values["displayToolPreviewLength"], 0);
        assert_eq!(values["displayCleanupProgress"], false);
        assert_eq!(values["displayToolProgressCommand"], false);
        assert_eq!(values["displayInterimAssistantMessages"], true);
        assert_eq!(values["displayRuntimeFooterEnabled"], false);
        assert_eq!(
            values["displayRuntimeFooterFields"],
            "model\ncontext_pct\ncwd"
        );
        assert_eq!(values["displayFileMutationVerifier"], true);
        assert_eq!(values["displayShowCost"], false);
        assert_eq!(values["dashboardShowTokenAnalytics"], false);
        assert_eq!(values["displayLanguage"], "en");
        assert_eq!(values["displayResumeDisplay"], "full");
        assert_eq!(values["displayBusyInputMode"], "interrupt");
        assert_eq!(values["displayBackgroundProcessNotifications"], "all");
        assert_eq!(values["displayFinalResponseMarkdown"], "strip");
        assert_eq!(values["displayTimestamps"], false);
        assert_eq!(values["displayBellOnComplete"], false);
        assert_eq!(values["displayPersistentOutput"], true);
        assert_eq!(values["displayPersistentOutputMaxLines"], 200);
        assert_eq!(values["displayInlineDiffs"], true);
        assert_eq!(values["displayTuiAutoResumeRecent"], false);
        assert_eq!(values["displayTuiStatusIndicator"], "kaomoji");
        assert_eq!(values["displayUserMessagePreviewFirstLines"], 2);
        assert_eq!(values["displayUserMessagePreviewLastLines"], 2);
        assert_eq!(values["displayEphemeralSystemTtl"], 0);
        assert_eq!(values["displayCopyShortcut"], "auto");
    }

    #[test]
    fn display_values_normalize_existing_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
display:
  tool_progress: VERBOSE
  compact: true
  skin: MONO
  tool_prefix: "╎"
  show_reasoning: true
  tool_preview_length: 80
  cleanup_progress: true
  tool_progress_command: true
  interim_assistant_messages: false
  runtime_footer:
    enabled: true
    fields:
      - model
      - duration
      - cost
  file_mutation_verifier: false
  show_cost: true
  language: ZH
  resume_display: minimal
  busy_input_mode: QUEUE
  background_process_notifications: ERROR
  final_response_markdown: RAW
  timestamps: true
  bell_on_complete: true
  persistent_output: false
  persistent_output_max_lines: 80
  inline_diffs: false
  tui_auto_resume_recent: true
  tui_status_indicator: EMOJI
  user_message_preview:
    first_lines: 3
    last_lines: 1
  ephemeral_system_ttl: 120
  copy_shortcut: CTRL_SHIFT_C
dashboard:
  show_token_analytics: true
"#,
        )
        .unwrap();
        let values = build_hermes_display_config_values(&config);
        assert_eq!(values["displayToolProgress"], "verbose");
        assert_eq!(values["displayCompact"], true);
        assert_eq!(values["displaySkin"], "mono");
        assert_eq!(values["displayToolPrefix"], "╎");
        assert_eq!(values["displayShowReasoning"], true);
        assert_eq!(values["displayToolPreviewLength"], 80);
        assert_eq!(values["displayCleanupProgress"], true);
        assert_eq!(values["displayToolProgressCommand"], true);
        assert_eq!(values["displayInterimAssistantMessages"], false);
        assert_eq!(values["displayRuntimeFooterEnabled"], true);
        assert_eq!(
            values["displayRuntimeFooterFields"],
            "model\nduration\ncost"
        );
        assert_eq!(values["displayFileMutationVerifier"], false);
        assert_eq!(values["displayShowCost"], true);
        assert_eq!(values["dashboardShowTokenAnalytics"], true);
        assert_eq!(values["displayLanguage"], "zh");
        assert_eq!(values["displayResumeDisplay"], "minimal");
        assert_eq!(values["displayBusyInputMode"], "queue");
        assert_eq!(values["displayBackgroundProcessNotifications"], "error");
        assert_eq!(values["displayFinalResponseMarkdown"], "raw");
        assert_eq!(values["displayTimestamps"], true);
        assert_eq!(values["displayBellOnComplete"], true);
        assert_eq!(values["displayPersistentOutput"], false);
        assert_eq!(values["displayPersistentOutputMaxLines"], 80);
        assert_eq!(values["displayInlineDiffs"], false);
        assert_eq!(values["displayTuiAutoResumeRecent"], true);
        assert_eq!(values["displayTuiStatusIndicator"], "emoji");
        assert_eq!(values["displayUserMessagePreviewFirstLines"], 3);
        assert_eq!(values["displayUserMessagePreviewLastLines"], 1);
        assert_eq!(values["displayEphemeralSystemTtl"], 120);
        assert_eq!(values["displayCopyShortcut"], "ctrl_shift_c");
    }

    #[test]
    fn merge_display_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
display:
  skin: midnight
  runtime_footer:
    enabled: false
    custom_flag: keep-footer
  user_message_preview:
    custom_flag: keep-preview
  platforms:
    telegram:
      tool_progress: new
  custom_flag: keep-display
dashboard:
  custom_flag: keep-dashboard
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_display_config(
            &mut config,
            &json!({
                "displayToolProgress": "off",
                "displayCompact": true,
                "displaySkin": "slate",
                "displayToolPrefix": "│",
                "displayShowReasoning": true,
                "displayToolPreviewLength": 120,
                "displayCleanupProgress": true,
                "displayToolProgressCommand": true,
                "displayInterimAssistantMessages": false,
                "displayRuntimeFooterEnabled": true,
                "displayRuntimeFooterFields": "model\ncontext_pct\nduration",
                "displayFileMutationVerifier": true,
                "displayShowCost": true,
                "dashboardShowTokenAnalytics": true,
                "displayLanguage": "zh-hant",
                "displayResumeDisplay": "minimal",
                "displayBusyInputMode": "steer",
                "displayBackgroundProcessNotifications": "result",
                "displayFinalResponseMarkdown": "render",
                "displayTimestamps": true,
                "displayBellOnComplete": true,
                "displayPersistentOutput": false,
                "displayPersistentOutputMaxLines": 120,
                "displayInlineDiffs": false,
                "displayTuiAutoResumeRecent": true,
                "displayTuiStatusIndicator": "ascii",
                "displayUserMessagePreviewFirstLines": 4,
                "displayUserMessagePreviewLastLines": 0,
                "displayEphemeralSystemTtl": 360,
                "displayCopyShortcut": "disabled",
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(
            config["dashboard"]["custom_flag"].as_str(),
            Some("keep-dashboard")
        );
        assert_eq!(
            config["dashboard"]["show_token_analytics"].as_bool(),
            Some(true)
        );
        assert_eq!(config["display"]["compact"].as_bool(), Some(true));
        assert_eq!(config["display"]["skin"].as_str(), Some("slate"));
        assert_eq!(config["display"]["tool_prefix"].as_str(), Some("│"));
        assert_eq!(config["display"]["show_reasoning"].as_bool(), Some(true));
        assert_eq!(config["display"]["tool_preview_length"].as_i64(), Some(120));
        assert_eq!(config["display"]["cleanup_progress"].as_bool(), Some(true));
        assert_eq!(
            config["display"]["platforms"]["telegram"]["tool_progress"].as_str(),
            Some("new")
        );
        assert_eq!(config["display"]["tool_progress"].as_str(), Some("off"));
        assert_eq!(
            config["display"]["tool_progress_command"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["display"]["interim_assistant_messages"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["display"]["runtime_footer"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["display"]["runtime_footer"]["custom_flag"].as_str(),
            Some("keep-footer")
        );
        assert_eq!(
            config["display"]["runtime_footer"]["fields"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>(),
            vec!["model", "context_pct", "duration"]
        );
        assert_eq!(
            config["display"]["file_mutation_verifier"].as_bool(),
            Some(true)
        );
        assert_eq!(config["display"]["show_cost"].as_bool(), Some(true));
        assert_eq!(config["display"]["language"].as_str(), Some("zh-hant"));
        assert_eq!(
            config["display"]["resume_display"].as_str(),
            Some("minimal")
        );
        assert_eq!(config["display"]["busy_input_mode"].as_str(), Some("steer"));
        assert_eq!(
            config["display"]["background_process_notifications"].as_str(),
            Some("result")
        );
        assert_eq!(
            config["display"]["final_response_markdown"].as_str(),
            Some("render")
        );
        assert_eq!(config["display"]["timestamps"].as_bool(), Some(true));
        assert_eq!(config["display"]["bell_on_complete"].as_bool(), Some(true));
        assert_eq!(
            config["display"]["persistent_output"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["display"]["persistent_output_max_lines"].as_i64(),
            Some(120)
        );
        assert_eq!(config["display"]["inline_diffs"].as_bool(), Some(false));
        assert_eq!(
            config["display"]["tui_auto_resume_recent"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["display"]["tui_status_indicator"].as_str(),
            Some("ascii")
        );
        assert_eq!(
            config["display"]["user_message_preview"]["first_lines"].as_i64(),
            Some(4)
        );
        assert_eq!(
            config["display"]["user_message_preview"]["last_lines"].as_i64(),
            Some(0)
        );
        assert_eq!(
            config["display"]["user_message_preview"]["custom_flag"].as_str(),
            Some("keep-preview")
        );
        assert_eq!(
            config["display"]["ephemeral_system_ttl"].as_i64(),
            Some(360)
        );
        assert_eq!(
            config["display"]["copy_shortcut"].as_str(),
            Some("disabled")
        );
        assert_eq!(
            config["display"]["custom_flag"].as_str(),
            Some("keep-display")
        );
    }

    #[test]
    fn merge_display_config_rejects_invalid_values() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayToolProgress": "everything" }),
        )
        .unwrap_err();
        assert!(err.contains("display.tool_progress"));

        let err = merge_hermes_display_config(&mut config, &json!({ "displaySkin": "unknown" }))
            .unwrap_err();
        assert!(err.contains("display.skin"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayToolPrefix": "too-long-prefix" }),
        )
        .unwrap_err();
        assert!(err.contains("display.tool_prefix"));

        let err =
            merge_hermes_display_config(&mut config, &json!({ "displayResumeDisplay": "compact" }))
                .unwrap_err();
        assert!(err.contains("display.resume_display"));

        let err = merge_hermes_display_config(&mut config, &json!({ "displayLanguage": "cn" }))
            .unwrap_err();
        assert!(err.contains("display.language"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayRuntimeFooterFields": "model\npassword" }),
        )
        .unwrap_err();
        assert!(err.contains("display.runtime_footer.fields"));

        let err =
            merge_hermes_display_config(&mut config, &json!({ "displayBusyInputMode": "replace" }))
                .unwrap_err();
        assert!(err.contains("display.busy_input_mode"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayBackgroundProcessNotifications": "silent" }),
        )
        .unwrap_err();
        assert!(err.contains("display.background_process_notifications"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayFinalResponseMarkdown": "html" }),
        )
        .unwrap_err();
        assert!(err.contains("display.final_response_markdown"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayPersistentOutputMaxLines": -1 }),
        )
        .unwrap_err();
        assert!(err.contains("display.persistent_output_max_lines"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayToolPreviewLength": 200001 }),
        )
        .unwrap_err();
        assert!(err.contains("display.tool_preview_length"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayTuiStatusIndicator": "rainbow" }),
        )
        .unwrap_err();
        assert!(err.contains("display.tui_status_indicator"));

        let err =
            merge_hermes_display_config(&mut config, &json!({ "displayCopyShortcut": "cmd_c" }))
                .unwrap_err();
        assert!(err.contains("display.copy_shortcut"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayUserMessagePreviewFirstLines": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("display.user_message_preview.first_lines"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayUserMessagePreviewLastLines": 101 }),
        )
        .unwrap_err();
        assert!(err.contains("display.user_message_preview.last_lines"));

        let err = merge_hermes_display_config(
            &mut config,
            &json!({ "displayEphemeralSystemTtl": 86401 }),
        )
        .unwrap_err();
        assert!(err.contains("display.ephemeral_system_ttl"));
    }
}

#[cfg(test)]
mod hermes_kanban_config_tests {
    use super::{build_hermes_kanban_config_values, merge_hermes_kanban_config};
    use serde_json::json;

    #[test]
    fn kanban_values_have_upstream_defaults() {
        let config: serde_yaml::Value = serde_yaml::from_str("{}").unwrap();
        let values = build_hermes_kanban_config_values(&config);
        assert_eq!(values["dispatchInGateway"], true);
        assert_eq!(values["dispatchIntervalSeconds"], 60);
        assert_eq!(values["maxSpawn"], 0);
        assert_eq!(values["maxInProgress"], 0);
        assert_eq!(values["failureLimit"], 2);
        assert_eq!(values["autoDecompose"], true);
        assert_eq!(values["autoDecomposePerTick"], 3);
        assert_eq!(values["workerLogRotateBytes"], 2097152);
        assert_eq!(values["workerLogBackupCount"], 1);
        assert_eq!(values["orchestratorProfile"], "");
        assert_eq!(values["defaultAssignee"], "");
        assert_eq!(values["dispatchStaleTimeoutSeconds"], 14400);
    }

    #[test]
    fn kanban_values_normalize_existing_fields() {
        let config: serde_yaml::Value = serde_yaml::from_str(
            r#"
kanban:
  dispatch_in_gateway: false
  dispatch_interval_seconds: "120"
  max_spawn: "4"
  max_in_progress: "6"
  failure_limit: "5"
  auto_decompose: false
  auto_decompose_per_tick: "7"
  worker_log_rotate_bytes: "4194304"
  worker_log_backup_count: "3"
  orchestrator_profile: triage
  default_assignee: builder
  dispatch_stale_timeout_seconds: "7200"
"#,
        )
        .unwrap();
        let values = build_hermes_kanban_config_values(&config);
        assert_eq!(values["dispatchInGateway"], false);
        assert_eq!(values["dispatchIntervalSeconds"], 120);
        assert_eq!(values["maxSpawn"], 4);
        assert_eq!(values["maxInProgress"], 6);
        assert_eq!(values["failureLimit"], 5);
        assert_eq!(values["autoDecompose"], false);
        assert_eq!(values["autoDecomposePerTick"], 7);
        assert_eq!(values["workerLogRotateBytes"], 4194304);
        assert_eq!(values["workerLogBackupCount"], 3);
        assert_eq!(values["orchestratorProfile"], "triage");
        assert_eq!(values["defaultAssignee"], "builder");
        assert_eq!(values["dispatchStaleTimeoutSeconds"], 7200);
    }

    #[test]
    fn merge_kanban_config_preserves_unknown_fields() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
model:
  provider: anthropic
kanban:
  dispatch_interval_seconds: 30
  max_spawn: 9
  max_in_progress: 11
  custom_flag: keep-me
memory:
  memory_enabled: true
"#,
        )
        .unwrap();

        merge_hermes_kanban_config(
            &mut config,
            &json!({
                "dispatchInGateway": false,
                "dispatchIntervalSeconds": 15,
                "maxSpawn": 4,
                "maxInProgress": 6,
                "failureLimit": 4,
                "autoDecompose": false,
                "autoDecomposePerTick": 2,
                "workerLogRotateBytes": 1048576,
                "workerLogBackupCount": 0,
                "orchestratorProfile": "triage",
                "defaultAssignee": "builder",
                "dispatchStaleTimeoutSeconds": 0,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["memory"]["memory_enabled"].as_bool(), Some(true));
        assert_eq!(config["kanban"]["custom_flag"].as_str(), Some("keep-me"));
        assert_eq!(
            config["kanban"]["dispatch_in_gateway"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["kanban"]["dispatch_interval_seconds"].as_i64(),
            Some(15)
        );
        assert_eq!(config["kanban"]["max_spawn"].as_i64(), Some(4));
        assert_eq!(config["kanban"]["max_in_progress"].as_i64(), Some(6));
        assert_eq!(config["kanban"]["failure_limit"].as_i64(), Some(4));
        assert_eq!(config["kanban"]["auto_decompose"].as_bool(), Some(false));
        assert_eq!(
            config["kanban"]["auto_decompose_per_tick"].as_i64(),
            Some(2)
        );
        assert_eq!(
            config["kanban"]["worker_log_rotate_bytes"].as_i64(),
            Some(1048576)
        );
        assert_eq!(
            config["kanban"]["worker_log_backup_count"].as_i64(),
            Some(0)
        );
        assert_eq!(
            config["kanban"]["orchestrator_profile"].as_str(),
            Some("triage")
        );
        assert_eq!(
            config["kanban"]["default_assignee"].as_str(),
            Some("builder")
        );
        assert_eq!(
            config["kanban"]["dispatch_stale_timeout_seconds"].as_i64(),
            Some(0)
        );
    }

    #[test]
    fn merge_kanban_config_removes_optional_profile_routes() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
kanban:
  orchestrator_profile: triage
  default_assignee: builder
  custom_flag: keep-me
"#,
        )
        .unwrap();

        merge_hermes_kanban_config(
            &mut config,
            &json!({
                "orchestratorProfile": "   ",
                "defaultAssignee": "",
            }),
        )
        .unwrap();

        assert_eq!(config["kanban"]["custom_flag"].as_str(), Some("keep-me"));
        assert!(config["kanban"].get("orchestrator_profile").is_none());
        assert!(config["kanban"].get("default_assignee").is_none());
    }

    #[test]
    fn merge_kanban_config_removes_optional_concurrency_limits() {
        let mut config: serde_yaml::Value = serde_yaml::from_str(
            r#"
kanban:
  max_spawn: 4
  max_in_progress: 6
  custom_flag: keep-me
"#,
        )
        .unwrap();

        merge_hermes_kanban_config(
            &mut config,
            &json!({
                "maxSpawn": 0,
                "maxInProgress": 0,
            }),
        )
        .unwrap();

        assert_eq!(config["kanban"]["custom_flag"].as_str(), Some("keep-me"));
        assert!(config["kanban"].get("max_spawn").is_none());
        assert!(config["kanban"].get("max_in_progress").is_none());
    }

    #[test]
    fn merge_kanban_config_rejects_invalid_timeout() {
        let mut config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
        let err = merge_hermes_kanban_config(&mut config, &json!({ "dispatchIntervalSeconds": 0 }))
            .unwrap_err();
        assert!(err.contains("kanban.dispatch_interval_seconds"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "maxSpawn": -1 })).unwrap_err();
        assert!(err.contains("kanban.max_spawn"));

        let err =
            merge_hermes_kanban_config(&mut config, &json!({ "maxInProgress": -1 })).unwrap_err();
        assert!(err.contains("kanban.max_in_progress"));

        let err =
            merge_hermes_kanban_config(&mut config, &json!({ "failureLimit": 0 })).unwrap_err();
        assert!(err.contains("kanban.failure_limit"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "autoDecomposePerTick": 0 }))
            .unwrap_err();
        assert!(err.contains("kanban.auto_decompose_per_tick"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "workerLogRotateBytes": 0 }))
            .unwrap_err();
        assert!(err.contains("kanban.worker_log_rotate_bytes"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "workerLogBackupCount": -1 }))
            .unwrap_err();
        assert!(err.contains("kanban.worker_log_backup_count"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "orchestratorProfile": 123 }))
            .unwrap_err();
        assert!(err.contains("kanban.orchestrator_profile"));

        let err = merge_hermes_kanban_config(&mut config, &json!({ "defaultAssignee": false }))
            .unwrap_err();
        assert!(err.contains("kanban.default_assignee"));

        let err =
            merge_hermes_kanban_config(&mut config, &json!({ "dispatchStaleTimeoutSeconds": -1 }))
                .unwrap_err();
        assert!(err.contains("kanban.dispatch_stale_timeout_seconds"));

        let err = merge_hermes_kanban_config(
            &mut config,
            &json!({ "dispatchStaleTimeoutSeconds": 604801 }),
        )
        .unwrap_err();
        assert!(err.contains("kanban.dispatch_stale_timeout_seconds"));
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
        assert_eq!(values["installPolicyJson"], "");
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
  installPolicy:
    enabled: true
    targets:
      - skill
      - plugin
"#,
        )
        .unwrap();
        let values = build_hermes_security_config_values(&config);
        assert_eq!(values["tirithEnabled"], false);
        assert_eq!(values["tirithPath"], "C:/tools/tirith.exe");
        assert_eq!(values["tirithTimeout"], 12);
        assert_eq!(values["tirithFailOpen"], false);
        let install_policy: serde_json::Value =
            serde_json::from_str(values["installPolicyJson"].as_str().unwrap()).unwrap();
        assert_eq!(install_policy["enabled"], true);
        assert_eq!(install_policy["targets"][0], "skill");
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
  installPolicy:
    enabled: false
    targets:
      - skill
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
                "installPolicyJson": r#"{"enabled":true,"targets":["skill","plugin"],"exec":{"source":"exec","command":"tirith","args":["scan"]}}"#,
            }),
        )
        .unwrap();

        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
        assert_eq!(config["terminal"]["backend"].as_str(), Some("docker"));
        assert_eq!(
            config["security"]["custom_flag"].as_str(),
            Some("keep-security")
        );
        assert_eq!(
            config["security"]["installPolicy"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["security"]["installPolicy"]["targets"][1].as_str(),
            Some("plugin")
        );
        assert_eq!(
            config["security"]["installPolicy"]["exec"]["command"].as_str(),
            Some("tirith")
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

        let err = merge_hermes_security_config(&mut config, &json!({ "installPolicyJson": "[]" }))
            .unwrap_err();
        assert!(err.contains("security.installPolicy"));
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
                "replyToMode": "off",
                "guestMode": true,
                "disableLinkPreviews": true,
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
        assert_eq!(
            config["platforms"]["telegram"]["extra"]["reply_to_mode"].as_str(),
            Some("off")
        );
        assert_eq!(
            config["platforms"]["telegram"]["extra"]["guest_mode"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["platforms"]["telegram"]["extra"]["disable_link_previews"].as_bool(),
            Some(true)
        );
        assert_eq!(values["telegram"]["replyToMode"], "off");
        assert_eq!(values["telegram"]["guestMode"], true);
        assert_eq!(values["telegram"]["disableLinkPreviews"], true);
        let env = build_hermes_channel_env_updates(
            "telegram",
            &json!({
                "botToken": "123:token",
                "allowFrom": "1001, 1002",
                "requireMention": true,
                "replyToMode": "off",
                "guestMode": true,
                "disableLinkPreviews": true,
            }),
        );
        assert!(env.contains(&("TELEGRAM_BOT_TOKEN".to_string(), "123:token".to_string())));
        assert!(env.contains(&("TELEGRAM_REPLY_TO_MODE".to_string(), "off".to_string())));
        assert!(env.contains(&("TELEGRAM_GUEST_MODE".to_string(), "true".to_string())));
        assert!(env.contains(&(
            "TELEGRAM_DISABLE_LINK_PREVIEWS".to_string(),
            "true".to_string()
        )));
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
