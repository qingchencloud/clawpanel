/// Gateway 连接诊断命令
///
/// 执行一系列检查步骤，返回结构化诊断结果，帮助用户定位连接问题。
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseStep {
    pub name: String,
    pub ok: bool,
    pub message: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseEnv {
    pub openclaw_dir: String,
    pub config_exists: bool,
    pub port: u16,
    pub auth_mode: String,
    pub device_key_exists: bool,
    pub gateway_owner: Option<String>,
    pub err_log_excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseResult {
    pub steps: Vec<DiagnoseStep>,
    pub env: DiagnoseEnv,
    pub overall_ok: bool,
    pub summary: String,
}

fn step_timer() -> Instant {
    Instant::now()
}

fn finish_step(name: &str, ok: bool, message: &str, start: Instant) -> DiagnoseStep {
    DiagnoseStep {
        name: name.to_string(),
        ok,
        message: message.to_string(),
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

/// 读取环境信息
fn collect_env() -> DiagnoseEnv {
    let openclaw_dir = crate::commands::openclaw_dir();
    let config_path = openclaw_dir.join("openclaw.json");
    let config_exists = config_path.exists();
    let port = crate::commands::gateway_listen_port();

    // 认证模式
    let auth_mode = if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            let auth = val.get("gateway").and_then(|g| g.get("auth"));
            if let Some(auth) = auth {
                if auth
                    .get("token")
                    .and_then(|t| t.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                {
                    "token".to_string()
                } else if auth
                    .get("password")
                    .and_then(|p| p.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                {
                    "password".to_string()
                } else {
                    "none".to_string()
                }
            } else {
                "none".to_string()
            }
        } else {
            "config_parse_error".to_string()
        }
    } else {
        "config_missing".to_string()
    };

    // 设备密钥
    let device_key_path = openclaw_dir.join("clawpanel-device-key.json");
    let device_key_exists = device_key_path.exists();

    // Gateway owner
    let owner_path = openclaw_dir.join("gateway-owner.json");
    let gateway_owner = std::fs::read_to_string(&owner_path).ok();

    // 错误日志
    let err_log_path = openclaw_dir.join("logs").join("gateway.err.log");
    let err_log_excerpt = if let Ok(bytes) = std::fs::read(&err_log_path) {
        let max = 2048;
        let tail = if bytes.len() > max {
            &bytes[bytes.len() - max..]
        } else {
            &bytes[..]
        };
        String::from_utf8_lossy(tail).to_string()
    } else {
        String::new()
    };

    DiagnoseEnv {
        openclaw_dir: openclaw_dir.display().to_string(),
        config_exists,
        port,
        auth_mode,
        device_key_exists,
        gateway_owner,
        err_log_excerpt,
    }
}

/// TCP 端口探测
async fn check_tcp_port(port: u16) -> DiagnoseStep {
    let t = step_timer();
    let addr = format!("127.0.0.1:{port}");
    match tokio::net::TcpStream::connect(&addr).await {
        Ok(_) => finish_step("tcp_port", true, &format!("端口 {port} 可达"), t),
        Err(e) => finish_step("tcp_port", false, &format!("端口 {port} 不可达: {e}"), t),
    }
}

/// 检查配置文件
fn check_config() -> DiagnoseStep {
    let t = step_timer();
    let config_path = crate::commands::openclaw_dir().join("openclaw.json");
    if !config_path.exists() {
        return finish_step("config", false, "openclaw.json 不存在", t);
    }
    match std::fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(val) => {
                if val.get("gateway").is_some() {
                    finish_step("config", true, "配置文件有效，含 gateway 配置", t)
                } else {
                    finish_step("config", false, "配置文件缺少 gateway 段", t)
                }
            }
            Err(e) => finish_step("config", false, &format!("JSON 解析失败: {e}"), t),
        },
        Err(e) => finish_step("config", false, &format!("读取失败: {e}"), t),
    }
}

/// 检查设备密钥
fn check_device_key() -> DiagnoseStep {
    let t = step_timer();
    let key_path = crate::commands::openclaw_dir().join("clawpanel-device-key.json");
    if key_path.exists() {
        match std::fs::read_to_string(&key_path) {
            Ok(content) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if val.get("deviceId").is_some() && val.get("publicKey").is_some() {
                        finish_step("device_key", true, "设备密钥有效", t)
                    } else {
                        finish_step("device_key", false, "设备密钥文件缺少必要字段", t)
                    }
                } else {
                    finish_step("device_key", false, "设备密钥文件 JSON 无效", t)
                }
            }
            Err(e) => finish_step("device_key", false, &format!("读取失败: {e}"), t),
        }
    } else {
        finish_step(
            "device_key",
            false,
            "设备密钥不存在（将在首次连接时自动生成）",
            t,
        )
    }
}

/// 检查 allowedOrigins 配置
fn check_allowed_origins() -> DiagnoseStep {
    let t = step_timer();
    let config_path = crate::commands::openclaw_dir().join("openclaw.json");
    match std::fs::read_to_string(&config_path) {
        Ok(content) => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let origins = val
                    .get("gateway")
                    .and_then(|g| g.get("controlUi"))
                    .and_then(|c| c.get("allowedOrigins"))
                    .and_then(|o| o.as_array());
                match origins {
                    Some(arr) if !arr.is_empty() => {
                        let list: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
                        let has_tauri = list.iter().any(|o| {
                            o.contains("tauri://") || o.contains("https://tauri.localhost")
                        });
                        if has_tauri {
                            finish_step(
                                "allowed_origins",
                                true,
                                &format!("allowedOrigins 包含 Tauri origin: {:?}", list),
                                t,
                            )
                        } else {
                            finish_step(
                                "allowed_origins",
                                false,
                                &format!("allowedOrigins 缺少 Tauri origin: {:?}", list),
                                t,
                            )
                        }
                    }
                    Some(_) => finish_step("allowed_origins", false, "allowedOrigins 为空数组", t),
                    None => finish_step(
                        "allowed_origins",
                        false,
                        "未配置 allowedOrigins（autoPair 会自动修复）",
                        t,
                    ),
                }
            } else {
                finish_step("allowed_origins", false, "配置文件解析失败", t)
            }
        }
        Err(_) => finish_step("allowed_origins", false, "配置文件不可读", t),
    }
}

/// HTTP /health 探测（尝试性，上游可能未暴露）
async fn check_http_health(port: u16) -> DiagnoseStep {
    let t = step_timer();
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();
    match client {
        Ok(c) => match c.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    finish_step(
                        "http_health",
                        true,
                        &format!("HTTP /health 返回 {status}"),
                        t,
                    )
                } else {
                    finish_step(
                        "http_health",
                        false,
                        &format!("HTTP /health 返回 {status}"),
                        t,
                    )
                }
            }
            Err(e) => finish_step(
                "http_health",
                false,
                &format!("HTTP /health 请求失败: {e}"),
                t,
            ),
        },
        Err(e) => finish_step(
            "http_health",
            false,
            &format!("HTTP client 创建失败: {e}"),
            t,
        ),
    }
}

/// 检查 Gateway 错误日志
fn check_error_log() -> DiagnoseStep {
    let t = step_timer();
    let log_path = crate::commands::openclaw_dir()
        .join("logs")
        .join("gateway.err.log");
    if !log_path.exists() {
        return finish_step("err_log", true, "无错误日志（正常）", t);
    }
    match std::fs::metadata(&log_path) {
        Ok(meta) => {
            let size = meta.len();
            if size == 0 {
                finish_step("err_log", true, "错误日志为空（正常）", t)
            } else {
                // 读最后 1KB 看有没有关键错误
                let content = std::fs::read(&log_path).unwrap_or_default();
                let tail = if content.len() > 1024 {
                    &content[content.len() - 1024..]
                } else {
                    &content[..]
                };
                let text = String::from_utf8_lossy(tail).to_lowercase();
                let has_fatal = text.contains("fatal")
                    || text.contains("eaddrinuse")
                    || text.contains("config invalid");
                if has_fatal {
                    finish_step(
                        "err_log",
                        false,
                        &format!("错误日志含关键错误 ({size} bytes)"),
                        t,
                    )
                } else {
                    finish_step(
                        "err_log",
                        true,
                        &format!("错误日志存在但无致命错误 ({size} bytes)"),
                        t,
                    )
                }
            }
        }
        Err(e) => finish_step("err_log", false, &format!("无法读取日志: {e}"), t),
    }
}

#[tauri::command]
pub async fn diagnose_gateway_connection() -> DiagnoseResult {
    let env = collect_env();
    let port = env.port;

    let mut steps = Vec::new();

    // 1. 配置文件检查
    steps.push(check_config());

    // 2. 设备密钥检查
    steps.push(check_device_key());

    // 3. allowedOrigins 检查
    steps.push(check_allowed_origins());

    // 4. TCP 端口探测
    steps.push(check_tcp_port(port).await);

    // 5. HTTP /health 探测
    steps.push(check_http_health(port).await);

    // 6. 错误日志检查
    steps.push(check_error_log());

    let overall_ok = steps.iter().all(|s| s.ok);
    let failed: Vec<&str> = steps
        .iter()
        .filter(|s| !s.ok)
        .map(|s| s.name.as_str())
        .collect();
    let summary = if overall_ok {
        "所有检查项通过".to_string()
    } else {
        format!("以下检查未通过: {}", failed.join(", "))
    };

    DiagnoseResult {
        steps,
        env,
        overall_ok,
        summary,
    }
}

// =============================================================================
// @homebridge/ciao Windows cmd popup bug detection
//
// Upstream issue:  https://github.com/homebridge/ciao/issues/64
// Upstream PR:     https://github.com/homebridge/ciao/pull/65   (still open)
//
// Symptom on Windows: every 15-30s a cmd.exe / conhost.exe window flashes while
// Gateway is running. Root cause is @homebridge/ciao < 1.3.7 calling
// `child_process.exec("arp -a ...", callback)` without `{ windowsHide: true }`.
//
// This is NOT a ClawPanel bug — we only expose a detection command so the
// dashboard can surface a clear, actionable hint to users rather than silently
// inheriting third-party noise.
// =============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiaoCheckResult {
    /// Whether the bug is affecting the current installation
    pub affected: bool,
    /// Platform quick-check (non-Windows installations can never be affected)
    pub platform: String,
    /// Detected @homebridge/ciao version if the package is installed
    pub version: Option<String>,
    /// Absolute path to NetworkManager.js (when detected)
    pub network_manager_path: Option<String>,
    /// Human-readable detail for the UI
    pub detail: String,
}

/// Resolve the openclaw CLI module root — directory containing the installed
/// package's `package.json`. Returns None when the CLI cannot be located.
fn openclaw_module_root() -> Option<std::path::PathBuf> {
    let cli = crate::utils::resolve_openclaw_cli_path()?;
    let cli_path = std::path::PathBuf::from(&cli);

    // The CLI entrypoint is typically `<module_root>/dist/entry.js` or
    // similar. Walk up until we find a `package.json`, stopping at the
    // nearest node_modules boundary.
    let mut current = cli_path.parent()?.to_path_buf();
    for _ in 0..6 {
        if current.join("package.json").is_file() {
            return Some(current);
        }
        current = current.parent()?.to_path_buf();
    }
    None
}

/// Check the `@homebridge/ciao` package bundled with openclaw. Only runs on
/// Windows since the bug does not manifest on other platforms.
#[tauri::command]
pub fn check_ciao_windowshide_bug() -> CiaoCheckResult {
    let platform = std::env::consts::OS.to_string();

    #[cfg(not(target_os = "windows"))]
    {
        return CiaoCheckResult {
            affected: false,
            platform,
            version: None,
            network_manager_path: None,
            detail: "Non-Windows platform — bug does not manifest here.".into(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let Some(root) = openclaw_module_root() else {
            return CiaoCheckResult {
                affected: false,
                platform,
                version: None,
                network_manager_path: None,
                detail: "openclaw CLI not installed; nothing to check.".into(),
            };
        };

        let ciao_dir = root.join("node_modules").join("@homebridge").join("ciao");
        if !ciao_dir.is_dir() {
            return CiaoCheckResult {
                affected: false,
                platform,
                version: None,
                network_manager_path: None,
                detail: "@homebridge/ciao not found in openclaw dependencies.".into(),
            };
        }

        // Read version for reporting only — we do not key off it to avoid
        // lying to the user if someone backports the fix without bumping.
        let version = std::fs::read_to_string(ciao_dir.join("package.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(String::from));

        let nm_path = ciao_dir.join("lib").join("NetworkManager.js");
        if !nm_path.is_file() {
            return CiaoCheckResult {
                affected: false,
                platform,
                version,
                network_manager_path: None,
                detail: "NetworkManager.js not found; skipping scan.".into(),
            };
        }

        let content = match std::fs::read_to_string(&nm_path) {
            Ok(text) => text,
            Err(err) => {
                return CiaoCheckResult {
                    affected: false,
                    platform,
                    version,
                    network_manager_path: Some(nm_path.to_string_lossy().to_string()),
                    detail: format!("Unable to read NetworkManager.js: {err}"),
                };
            }
        };

        // Detection heuristic: look for the Windows ARP call and check whether
        // the third argument is an options object or the callback. A fixed
        // version uses  exec("arp -a ...", { windowsHide: true }, callback).
        // The buggy version uses  exec("arp -a ...", (error, stdout) => ...).
        let affected = content.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.contains(".exec(\"arp -a")
                && !trimmed.contains("windowsHide")
                && !trimmed.contains("windows_hide")
        });

        let detail = if affected {
            "Detected @homebridge/ciao without windowsHide option — cmd.exe will flash every 15-30s while Gateway runs. See upstream issues #64 / #65."
                .into()
        } else {
            "No buggy @homebridge/ciao pattern detected.".into()
        };

        CiaoCheckResult {
            affected,
            platform,
            version,
            network_manager_path: Some(nm_path.to_string_lossy().to_string()),
            detail,
        }
    }
}
