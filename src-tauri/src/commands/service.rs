/// 服务管理命令
///
/// 检测策略（跨平台统一）：
///   1. TCP 连 127.0.0.1:{port}，超时 1.5s
///   2. 连通 → 认为 Gateway 在运行
///
/// 不依赖任何系统命令（无 netstat / PowerShell / launchctl / openclaw health），
/// 无权限问题，逻辑一致。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::models::types::ServiceStatus;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// OpenClaw 官方服务的友好名称映射
fn description_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("ai.openclaw.gateway", "OpenClaw Gateway"),
        ("ai.openclaw.node", "OpenClaw Node Host"),
    ])
}

const GUARDIAN_INTERVAL: Duration = Duration::from_secs(15);
const GUARDIAN_RESTART_COOLDOWN: Duration = Duration::from_secs(60);
const GUARDIAN_STABLE_WINDOW: Duration = Duration::from_secs(120);
const GUARDIAN_MAX_AUTO_RESTART: u32 = 3;
const GATEWAY_CONFIG_AUTO_FIX_COOLDOWN: Duration = Duration::from_secs(120);

#[derive(Debug, Default)]
struct GuardianRuntimeState {
    last_seen_running: Option<bool>,
    running_since: Option<Instant>,
    auto_restart_count: u32,
    last_restart_time: Option<Instant>,
    manual_hold: bool,
    pause_reason: Option<String>,
    give_up: bool,
}

#[derive(Debug, Default)]
struct GatewayConfigAutoFixState {
    last_attempt: Option<Instant>,
    in_progress: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardianStatus {
    pub backend_managed: bool,
    pub paused: bool,
    pub manual_hold: bool,
    pub give_up: bool,
    pub auto_restart_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuardianEventPayload {
    kind: String,
    auto_restart_count: u32,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GatewayOwnerRecord {
    pid: Option<u32>,
    port: u16,
    cli_path: Option<String>,
    openclaw_dir: String,
    started_at: String,
    started_by: String,
}

fn normalize_owned_path(path: impl AsRef<std::path::Path>) -> String {
    let path_ref = path.as_ref();
    path_ref
        .canonicalize()
        .unwrap_or_else(|_| path_ref.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn gateway_owner_path() -> std::path::PathBuf {
    crate::commands::openclaw_dir().join("gateway-owner.json")
}

fn current_gateway_owner_signature() -> (u16, String, Option<String>) {
    let openclaw_dir = normalize_owned_path(crate::commands::openclaw_dir());
    let cli_path = crate::utils::resolve_openclaw_cli_path()
        .map(|p| normalize_owned_path(std::path::PathBuf::from(p)));
    (
        crate::commands::gateway_listen_port(),
        openclaw_dir,
        cli_path,
    )
}

fn matches_current_gateway_owner_signature(owner: &GatewayOwnerRecord) -> bool {
    if owner.started_by != "clawpanel" {
        return false;
    }
    let (port, openclaw_dir, cli_path) = current_gateway_owner_signature();
    if owner.port != port {
        return false;
    }
    if normalize_owned_path(&owner.openclaw_dir) != openclaw_dir {
        return false;
    }
    let owner_cli_path = owner.cli_path.as_ref().map(normalize_owned_path);
    // 仅当双方都有 cli_path 且不同才视为不匹配；任一侧缺失时放宽为兼容（向后兼容旧记录/未绑定 CLI）
    match (owner_cli_path.as_deref(), cli_path.as_deref()) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

fn gateway_owner_pid_needs_refresh(owner: &GatewayOwnerRecord, pid: Option<u32>) -> bool {
    matches_current_gateway_owner_signature(owner)
        && matches!(pid, Some(current_pid) if owner.pid != Some(current_pid))
}

fn read_gateway_owner() -> Option<GatewayOwnerRecord> {
    let content = std::fs::read_to_string(gateway_owner_path()).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_gateway_owner(pid: Option<u32>) -> Result<(), String> {
    let owner_path = gateway_owner_path();
    if let Some(parent) = owner_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Gateway owner 目录失败: {e}"))?;
    }
    let (port, openclaw_dir, cli_path) = current_gateway_owner_signature();
    let record = GatewayOwnerRecord {
        pid,
        port,
        cli_path,
        openclaw_dir,
        started_at: chrono::Local::now().to_rfc3339(),
        started_by: "clawpanel".into(),
    };
    let content = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("序列化 Gateway owner 失败: {e}"))?;
    std::fs::write(owner_path, content).map_err(|e| format!("写入 Gateway owner 失败: {e}"))
}

fn clear_gateway_owner() {
    let _ = std::fs::remove_file(gateway_owner_path());
}

fn is_current_gateway_owner(owner: &GatewayOwnerRecord, _pid: Option<u32>) -> bool {
    matches_current_gateway_owner_signature(owner)
}

/// 判断是否可以安全地自动认领 Gateway：端口 + 数据目录匹配即可（忽略 started_by）
fn should_auto_claim_gateway(owner: &Option<GatewayOwnerRecord>) -> bool {
    let (port, openclaw_dir, _cli_path) = current_gateway_owner_signature();
    match owner {
        None => true, // 无 owner 文件 → 自动认领
        Some(record) => {
            // owner 文件存在但签名不完全匹配 → 仅按 port + openclaw_dir 判断
            record.port == port && normalize_owned_path(&record.openclaw_dir) == openclaw_dir
        }
    }
}

fn foreign_gateway_error(pid: Option<u32>) -> String {
    let pid_suffix = pid
        .map(|value| format!(" (PID: {value})"))
        .unwrap_or_default();
    format!(
        "检测到端口 {} 上已有其他 OpenClaw Gateway 正在运行{}，且不属于当前面板实例。为避免误接管，请先关闭该实例，或将当前 CLI/目录绑定到它对应的安装。",
        crate::commands::gateway_listen_port(),
        pid_suffix
    )
}

fn ensure_owned_gateway_or_err(pid: Option<u32>) -> Result<(), String> {
    let owner = read_gateway_owner();
    if let Some(ref record) = owner {
        if is_current_gateway_owner(record, pid) {
            if gateway_owner_pid_needs_refresh(record, pid) {
                write_gateway_owner(pid)?;
            }
            return Ok(());
        }
    }
    // 无有效 owner 或签名不匹配 → 尝试自动认领（端口 + 数据目录匹配即可）
    if should_auto_claim_gateway(&owner) {
        write_gateway_owner(pid)?;
        return Ok(());
    }
    Err(foreign_gateway_error(pid))
}

async fn current_gateway_runtime(label: &str) -> (bool, Option<u32>) {
    #[cfg(target_os = "windows")]
    {
        platform::check_service_status(0, label)
    }
    #[cfg(target_os = "macos")]
    {
        platform::check_service_status(0, label)
    }
    #[cfg(target_os = "linux")]
    {
        platform::check_service_status(0, label).await
    }
}

async fn wait_for_gateway_running(label: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let (running, pid) = current_gateway_runtime(label).await;
        if running {
            write_gateway_owner(pid)?;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(format!(
        "Gateway 启动超时，请查看 {}",
        crate::commands::openclaw_dir()
            .join("logs")
            .join("gateway.err.log")
            .display()
    ))
}

async fn wait_for_gateway_stopped(label: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let (running, _) = current_gateway_runtime(label).await;
        if !running {
            clear_gateway_owner();
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err("Gateway 停止超时，请手动检查进程".into())
}

fn gateway_err_log_path() -> std::path::PathBuf {
    crate::commands::openclaw_dir()
        .join("logs")
        .join("gateway.err.log")
}

fn read_gateway_error_log_excerpt(max_bytes: usize) -> String {
    let bytes = match std::fs::read(gateway_err_log_path()) {
        Ok(content) => content,
        Err(_) => return String::new(),
    };
    if bytes.is_empty() {
        return String::new();
    }
    let tail = if bytes.len() > max_bytes {
        &bytes[bytes.len() - max_bytes..]
    } else {
        &bytes[..]
    };
    String::from_utf8_lossy(tail).to_string()
}

fn looks_like_gateway_config_mismatch(reason: &str) -> bool {
    let combined = format!("{}\n{}", reason, read_gateway_error_log_excerpt(8192)).to_lowercase();
    let has_invalid = combined.contains("config invalid") || combined.contains("invalid config");
    let has_newer_version = combined.contains("config was last written by a newer openclaw");
    let has_schema_mismatch = combined.contains("must not have additional properties")
        || combined.contains("must not have additional property")
        || combined.contains("plugins.entries.memory-core.config")
        || combined.contains("additional properties");
    let mentions_doctor_fix = combined.contains("doctor --fix");
    (has_invalid && (has_schema_mismatch || mentions_doctor_fix))
        || (has_newer_version && mentions_doctor_fix)
}

/// 直接修复 openclaw.json 中 plugins.entries.*.config 的多余属性
/// 当 `openclaw doctor --fix` 无法修复时作为二级回退
fn try_direct_config_strip() -> Result<bool, String> {
    let config_path = crate::commands::openclaw_dir().join("openclaw.json");
    let raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置文件失败: {e}"))?;
    let mut doc: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析配置文件失败: {e}"))?;

    // 从错误日志中提取哪些 plugin entry 有 additional properties
    let err_log = read_gateway_error_log_excerpt(8192).to_lowercase();
    let mut changed = false;

    // 匹配形如 "plugins.entries.XXX.config: invalid config" 的模式
    if let Some(entries) = doc
        .pointer_mut("/plugins/entries")
        .and_then(|v| v.as_object_mut())
    {
        let entry_names: Vec<String> = entries.keys().cloned().collect();
        for name in &entry_names {
            let pattern = format!("plugins.entries.{}.config", name).to_lowercase();
            if err_log.contains(&pattern) {
                if let Some(entry) = entries.get_mut(name) {
                    if let Some(obj) = entry.as_object_mut() {
                        if obj.contains_key("config") {
                            guardian_log(&format!(
                                "直接修复: 清空 plugins.entries.{name}.config（含多余属性）"
                            ));
                            obj.remove("config");
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    // 通用回退：如果错误日志提到 additional properties 但没匹配到具体 entry，
    // 清空所有 plugin entry 的 config
    if !changed
        && (err_log.contains("additional properties") || err_log.contains("additional property"))
    {
        if let Some(entries) = doc
            .pointer_mut("/plugins/entries")
            .and_then(|v| v.as_object_mut())
        {
            let entry_names: Vec<String> = entries.keys().cloned().collect();
            for name in &entry_names {
                if let Some(entry) = entries.get_mut(name) {
                    if let Some(obj) = entry.as_object_mut() {
                        if obj.contains_key("config") {
                            let config = obj.get("config").unwrap();
                            if config.is_object()
                                && config.as_object().map(|m| !m.is_empty()).unwrap_or(false)
                            {
                                guardian_log(&format!(
                                    "直接修复(通用回退): 清空 plugins.entries.{name}.config"
                                ));
                                obj.remove("config");
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
    }

    if changed {
        let formatted =
            serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化配置失败: {e}"))?;
        std::fs::write(&config_path, formatted).map_err(|e| format!("写入配置文件失败: {e}"))?;
        guardian_log("直接修复: 已写回 openclaw.json");
    }

    Ok(changed)
}

static GUARDIAN_STATE: OnceLock<Arc<Mutex<GuardianRuntimeState>>> = OnceLock::new();
static GUARDIAN_STARTED: AtomicBool = AtomicBool::new(false);
static GATEWAY_CONFIG_AUTO_FIX_STATE: OnceLock<Arc<Mutex<GatewayConfigAutoFixState>>> =
    OnceLock::new();

fn gateway_config_auto_fix_state() -> &'static Arc<Mutex<GatewayConfigAutoFixState>> {
    GATEWAY_CONFIG_AUTO_FIX_STATE
        .get_or_init(|| Arc::new(Mutex::new(GatewayConfigAutoFixState::default())))
}

fn finish_gateway_config_auto_fix_attempt() {
    let mut state = gateway_config_auto_fix_state().lock().unwrap();
    state.in_progress = false;
}

async fn try_auto_fix_gateway_config(
    reason: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<bool, String> {
    if !looks_like_gateway_config_mismatch(reason) {
        return Ok(false);
    }

    {
        let mut state = gateway_config_auto_fix_state().lock().unwrap();
        if state.in_progress {
            return Ok(false);
        }
        if let Some(last_attempt) = state.last_attempt {
            if last_attempt.elapsed() < GATEWAY_CONFIG_AUTO_FIX_COOLDOWN {
                return Ok(false);
            }
        }
        state.in_progress = true;
        state.last_attempt = Some(Instant::now());
    }

    guardian_log("检测到 Gateway 启动疑似配置失配，尝试自动执行 openclaw doctor --fix");
    emit_guardian_event(
        app,
        "auto_fix_start",
        "检测到 Gateway 配置异常，正在自动执行 openclaw doctor --fix…",
    );

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        crate::utils::openclaw_command_async()
            .args(["doctor", "--fix"])
            .output(),
    )
    .await;

    finish_gateway_config_auto_fix_attempt();

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if output.status.success() {
                let summary = if !stderr.is_empty() { stderr } else { stdout };
                if summary.is_empty() {
                    guardian_log("自动执行 openclaw doctor --fix 成功");
                } else {
                    guardian_log(&format!("自动执行 openclaw doctor --fix 成功: {summary}"));
                }
                Ok(true)
            } else {
                let summary = if !stderr.is_empty() { stderr } else { stdout };
                let detail = if summary.is_empty() {
                    "doctor --fix 返回失败".to_string()
                } else {
                    summary
                };
                guardian_log(&format!("自动执行 openclaw doctor --fix 失败: {detail}"));
                emit_guardian_event(
                    app,
                    "auto_fix_failure",
                    format!("已尝试自动执行 openclaw doctor --fix，但修复失败：{detail}"),
                );
                Err(format!(
                    "检测到 Gateway 配置异常，已尝试自动执行 openclaw doctor --fix，但修复失败：{detail}"
                ))
            }
        }
        Ok(Err(err)) => {
            guardian_log(&format!("自动执行 openclaw doctor --fix 失败: {err}"));
            emit_guardian_event(
                app,
                "auto_fix_failure",
                format!("已尝试自动执行 openclaw doctor --fix，但命令执行失败：{err}"),
            );
            Err(format!(
                "检测到 Gateway 配置异常，已尝试自动执行 openclaw doctor --fix，但命令执行失败：{err}"
            ))
        }
        Err(_) => {
            guardian_log("自动执行 openclaw doctor --fix 超时 (30s)");
            emit_guardian_event(
                app,
                "auto_fix_failure",
                "已尝试自动执行 openclaw doctor --fix，但修复超时 (30s)",
            );
            Err(
                "检测到 Gateway 配置异常，已尝试自动执行 openclaw doctor --fix，但修复超时 (30s)"
                    .into(),
            )
        }
    }
}

fn guardian_state() -> &'static Arc<Mutex<GuardianRuntimeState>> {
    GUARDIAN_STATE.get_or_init(|| Arc::new(Mutex::new(GuardianRuntimeState::default())))
}

fn guardian_log(message: &str) {
    let log_dir = crate::commands::openclaw_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let path = log_dir.join("guardian.log");
    let line = format!(
        "[{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        message
    );
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

fn emit_guardian_event(app: Option<&tauri::AppHandle>, kind: &str, message: impl Into<String>) {
    if let Some(app) = app {
        let payload = GuardianEventPayload {
            kind: kind.to_string(),
            auto_restart_count: 0,
            message: message.into(),
        };
        let _ = app.emit("guardian-event", payload);
    }
}

fn guardian_snapshot() -> GuardianStatus {
    let state = guardian_state().lock().unwrap();
    GuardianStatus {
        backend_managed: true,
        paused: state.pause_reason.is_some(),
        manual_hold: state.manual_hold,
        give_up: state.give_up,
        auto_restart_count: state.auto_restart_count,
    }
}

pub(crate) fn guardian_mark_manual_stop() {
    let mut state = guardian_state().lock().unwrap();
    state.manual_hold = true;
    state.give_up = false;
    state.auto_restart_count = 0;
    state.last_restart_time = None;
    state.running_since = None;
    guardian_log("用户主动停止 Gateway，后端守护进入手动停机保持状态");
}

pub(crate) fn guardian_mark_manual_start() {
    let mut state = guardian_state().lock().unwrap();
    state.manual_hold = false;
    state.give_up = false;
    state.auto_restart_count = 0;
    state.last_restart_time = None;
    state.running_since = None;
    guardian_log("用户主动启动/恢复 Gateway，后端守护已重置自动重启状态");
}

pub(crate) fn guardian_pause(reason: &str) {
    let mut state = guardian_state().lock().unwrap();
    state.pause_reason = Some(reason.to_string());
    state.give_up = false;
    guardian_log(&format!("后端守护已暂停: {reason}"));
}

pub(crate) fn guardian_resume(reason: &str) {
    let mut state = guardian_state().lock().unwrap();
    state.pause_reason = None;
    state.running_since = None;
    guardian_log(&format!("后端守护已恢复: {reason}"));
}

fn gateway_config_exists() -> bool {
    crate::commands::openclaw_dir()
        .join("openclaw.json")
        .exists()
}

async fn gateway_service_status() -> Result<Option<ServiceStatus>, String> {
    let mut services = get_services_status().await?;
    if let Some(index) = services
        .iter()
        .position(|svc| svc.label == "ai.openclaw.gateway")
    {
        return Ok(Some(services.remove(index)));
    }
    Ok(services.into_iter().next())
}

async fn guardian_tick(app: &tauri::AppHandle) {
    let snapshot = match gateway_service_status().await {
        Ok(Some(svc)) => svc,
        Ok(None) => return,
        Err(err) => {
            guardian_log(&format!("读取 Gateway 状态失败: {err}"));
            return;
        }
    };

    let ready = snapshot.cli_installed && gateway_config_exists();
    let running = snapshot.running;
    let now = Instant::now();
    let (restart_attempt, emit_give_up) = {
        let mut state = guardian_state().lock().unwrap();
        let mut restart_attempt = None::<u32>;
        let mut emit_give_up = None::<String>;

        if state.last_seen_running.is_none() {
            state.last_seen_running = Some(running);
            state.running_since = running.then_some(now);
            return;
        }

        if !ready {
            state.last_seen_running = Some(running);
            state.running_since = running.then_some(now);
            return;
        }

        if state.pause_reason.is_some() {
            state.last_seen_running = Some(running);
            state.running_since = if running {
                state.running_since.or(Some(now))
            } else {
                None
            };
            return;
        }

        if running {
            if state.last_seen_running != Some(true) {
                if state.manual_hold || state.give_up {
                    state.manual_hold = false;
                    state.give_up = false;
                    state.auto_restart_count = 0;
                    state.last_restart_time = None;
                    guardian_log("检测到 Gateway 已重新运行，后端守护已退出手动停机/放弃状态");
                }
                state.running_since = Some(now);
            }

            if state.auto_restart_count > 0
                && state
                    .running_since
                    .map(|ts| now.duration_since(ts) >= GUARDIAN_STABLE_WINDOW)
                    .unwrap_or(false)
            {
                state.auto_restart_count = 0;
                state.last_restart_time = None;
                guardian_log("Gateway 已稳定运行，后端守护已清零自动重启计数");
            }

            state.last_seen_running = Some(true);
            return;
        }

        let was_running = state.last_seen_running == Some(true);
        state.last_seen_running = Some(false);
        state.running_since = None;

        if !was_running || state.manual_hold || state.give_up {
            return;
        }

        if let Some(last) = state.last_restart_time {
            if now.duration_since(last) < GUARDIAN_RESTART_COOLDOWN {
                return;
            }
        }

        if state.auto_restart_count >= GUARDIAN_MAX_AUTO_RESTART {
            state.give_up = true;
            let message = format!(
                "Gateway 连续自动重启 {} 次后仍异常，后端守护已停止自动拉起",
                GUARDIAN_MAX_AUTO_RESTART
            );
            guardian_log(&message);
            emit_give_up = Some(message);
            (restart_attempt, emit_give_up)
        } else {
            state.auto_restart_count += 1;
            state.last_restart_time = Some(now);
            restart_attempt = Some(state.auto_restart_count);
            (restart_attempt, emit_give_up)
        }
    };

    if let Some(attempt) = restart_attempt {
        guardian_log(&format!(
            "检测到 Gateway 异常退出，后端守护开始自动重启 ({attempt}/{GUARDIAN_MAX_AUTO_RESTART})"
        ));
        if let Err(err) = start_service_impl_internal("ai.openclaw.gateway", Some(app)).await {
            guardian_log(&format!("后端守护自动重启失败: {err}"));
        }
    }

    if let Some(message) = emit_give_up {
        let payload = GuardianEventPayload {
            kind: "give_up".into(),
            auto_restart_count: GUARDIAN_MAX_AUTO_RESTART,
            message,
        };
        let _ = app.emit("guardian-event", payload);
    }
}

async fn start_service_impl_internal(
    label: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    match start_service_impl_internal_once(label).await {
        Ok(()) => Ok(()),
        Err(err) => match try_auto_fix_gateway_config(&err, app).await {
            Ok(true) => {
                guardian_log("自动修复完成，准备重试启动 Gateway");
                emit_guardian_event(
                    app,
                    "auto_fix_retry",
                    "已自动修复配置，正在重试启动 Gateway…",
                );
                #[cfg(target_os = "windows")]
                {
                    platform::cleanup_zombie_gateway_processes();
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                match start_service_impl_internal_once(label).await {
                    Ok(()) => {
                        emit_guardian_event(
                            app,
                            "auto_fix_success",
                            "已自动修复配置并成功重试启动 Gateway。",
                        );
                        Ok(())
                    }
                    Err(retry_err) => {
                        // 二级回退：doctor --fix 没解决问题，尝试直接修改 JSON
                        if looks_like_gateway_config_mismatch(&retry_err) {
                            guardian_log("doctor --fix 后仍失败，尝试直接修复 openclaw.json");
                            match try_direct_config_strip() {
                                Ok(true) => {
                                    emit_guardian_event(
                                        app,
                                        "auto_fix_retry",
                                        "已直接修复配置文件，正在再次重试启动 Gateway…",
                                    );
                                    #[cfg(target_os = "windows")]
                                    {
                                        platform::cleanup_zombie_gateway_processes();
                                    }
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                    match start_service_impl_internal_once(label).await {
                                        Ok(()) => {
                                            emit_guardian_event(
                                                app,
                                                "auto_fix_success",
                                                "已直接修复配置并成功启动 Gateway。",
                                            );
                                            return Ok(());
                                        }
                                        Err(e) => {
                                            emit_guardian_event(
                                                app,
                                                "auto_fix_failure",
                                                format!("直接修复后仍启动失败：{e}"),
                                            );
                                        }
                                    }
                                }
                                Ok(false) => {
                                    guardian_log("直接修复未找到可清理的配置项");
                                }
                                Err(e) => {
                                    guardian_log(&format!("直接修复失败: {e}"));
                                }
                            }
                        }
                        emit_guardian_event(
                            app,
                            "auto_fix_failure",
                            format!(
                                "已自动执行 openclaw doctor --fix 并重试启动 Gateway，但仍失败：{retry_err}"
                            ),
                        );
                        Err(format!(
                            "{retry_err}\n（已自动执行 openclaw doctor --fix + 直接修复并重试启动 Gateway）"
                        ))
                    }
                }
            }
            Ok(false) => Err(err),
            Err(fix_err) => Err(format!("{err}\n{fix_err}")),
        },
    }
}

async fn start_service_impl_internal_once(label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::start_service_impl(label)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::start_service_impl(label).await?;
    }
    wait_for_gateway_running(label, Duration::from_secs(15)).await
}

async fn stop_service_impl_internal(label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::stop_service_impl(label)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::stop_service_impl(label).await?;
    }
    wait_for_gateway_stopped(label, Duration::from_secs(10)).await
}

async fn restart_service_impl_internal(
    label: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    stop_service_impl_internal(label).await?;
    start_service_impl_internal(label, app).await
}

pub fn start_backend_guardian(app: tauri::AppHandle) {
    if GUARDIAN_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    // Windows 重启后清理残留的僵尸 Gateway 进程（防止多进程堆积）
    #[cfg(target_os = "windows")]
    {
        platform::cleanup_zombie_gateway_processes();
    }

    guardian_log("后端守护循环已启动");
    tauri::async_runtime::spawn(async move {
        loop {
            guardian_tick(&app).await;
            tokio::time::sleep(GUARDIAN_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub fn guardian_status() -> Result<GuardianStatus, String> {
    Ok(guardian_snapshot())
}

// ===== macOS 实现 =====

#[cfg(target_os = "macos")]
mod platform {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    const OPENCLAW_PREFIXES: &[&str] = &["ai.openclaw."];

    fn common_cli_candidates() -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        // standalone 安装目录（集中管理，避免多处硬编码）
        for sa_dir in crate::commands::config::all_standalone_dirs() {
            candidates.push(sa_dir.join("openclaw"));
        }
        // Homebrew 路径（非 standalone，保留）
        candidates.push(PathBuf::from("/opt/homebrew/bin/openclaw"));
        candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
        candidates
    }

    /// macOS 上 CLI 是否安装（兼容手动安装 / standalone / Homebrew）
    pub fn is_cli_installed() -> bool {
        crate::utils::resolve_openclaw_cli_path().is_some()
            || common_cli_candidates().into_iter().any(|p| p.exists())
    }

    pub fn current_uid() -> Result<u32, String> {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|e| format!("获取 UID 失败: {e}"))?;
        let uid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        uid_str
            .parse::<u32>()
            .map_err(|e| format!("解析 UID 失败: {e}"))
    }

    /// 动态扫描 LaunchAgents 目录，只返回 OpenClaw 核心服务
    pub fn scan_service_labels() -> Vec<String> {
        let home = dirs::home_dir().unwrap_or_default();
        let agents_dir = home.join("Library/LaunchAgents");
        let mut labels = Vec::new();

        if let Ok(entries) = fs::read_dir(&agents_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".plist") {
                    continue;
                }
                let label = name.trim_end_matches(".plist");
                if OPENCLAW_PREFIXES.iter().any(|p| label.starts_with(p)) {
                    labels.push(label.to_string());
                }
            }
        }
        labels.sort();
        if labels.is_empty() {
            labels.push("ai.openclaw.gateway".to_string());
        }
        labels
    }

    fn plist_path(label: &str) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        format!("{}/Library/LaunchAgents/{}.plist", home.display(), label)
    }

    /// 跨平台统一检测：TCP 连端口 + lsof 获取 PID
    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = crate::commands::gateway_listen_port();
        let addr = format!("127.0.0.1:{port}");
        let socket_addr = match addr.parse() {
            Ok(a) => a,
            Err(_) => return (false, None),
        };
        // 两次尝试：第一次 1 秒，失败后短暂等待再用 2 秒重试，避免瞬态超时误判
        let connected =
            std::net::TcpStream::connect_timeout(&socket_addr, std::time::Duration::from_secs(1))
                .is_ok()
                || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    std::net::TcpStream::connect_timeout(
                        &socket_addr,
                        std::time::Duration::from_secs(2),
                    )
                    .is_ok()
                };
        if connected {
            let pid = get_pid_by_lsof(port);
            (true, pid)
        } else {
            (false, None)
        }
    }

    /// 通过 lsof 获取监听指定端口的进程 PID
    fn get_pid_by_lsof(port: u16) -> Option<u32> {
        let output = Command::new("lsof")
            .args(["-i", &format!("TCP:{}", port), "-sTCP:LISTEN", "-t"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().next()?.trim().parse::<u32>().ok()
    }

    /// launchctl 失败时的回退：直接通过 CLI spawn Gateway 进程
    fn start_gateway_direct() -> Result<(), String> {
        // 启动前再次检查端口（防止 launchctl→direct 回退链路中重复拉起）
        let port = crate::commands::gateway_listen_port();
        if let Ok(addr) = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>() {
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500))
                .is_ok()
            {
                return Err(format!("端口 {} 已被占用，跳过 direct 启动", port));
            }
        }

        let log_dir = crate::commands::openclaw_dir().join("logs");
        fs::create_dir_all(&log_dir).ok();

        let stdout_log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.log"))
            .map_err(|e| format!("创建日志文件失败: {e}"))?;

        let stderr_log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.err.log"))
            .map_err(|e| format!("创建错误日志文件失败: {e}"))?;

        let mut cmd = crate::utils::openclaw_command();
        cmd.arg("gateway")
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log);
        cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "OpenClaw CLI 未找到，请确认已安装并重启 ClawPanel。".to_string()
            } else {
                format!("启动 Gateway 失败: {e}")
            }
        })?;

        // 等 Gateway 初始化（最多 10s，轮询端口就绪）
        let port = crate::commands::gateway_listen_port();
        let addr = format!("127.0.0.1:{port}");
        let addr = match addr.parse() {
            Ok(a) => a,
            Err(_) => {
                return Err(format!("端口 {port} 解析失败"));
            }
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200))
                .is_ok()
            {
                return Ok(());
            }
        }

        Err(format!(
            "Gateway 启动超时，请查看 {}",
            log_dir.join("gateway.err.log").display()
        ))
    }

    pub fn start_service_impl(label: &str) -> Result<(), String> {
        // 启动前检查端口是否已被占用，防止重复拉起导致端口冲突和内存浪费
        let port = crate::commands::gateway_listen_port();
        let pre_check_addr: std::net::SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .map_err(|_| format!("端口 {port} 解析失败"))?;
        if std::net::TcpStream::connect_timeout(
            &pre_check_addr,
            std::time::Duration::from_millis(500),
        )
        .is_ok()
        {
            return Err(format!(
                "端口 {} 已被占用，Gateway 可能已在运行中（或其他程序占用了该端口）",
                port
            ));
        }

        let uid = current_uid()?;
        let path = plist_path(label);
        let domain_target = format!("gui/{}", uid);
        let service_target = format!("gui/{}/{}", uid, label);

        // 先尝试 plist 文件是否存在
        if !std::path::Path::new(&path).exists() {
            return start_gateway_direct();
        }

        // Issue #91: 先检查服务是否已注册，避免重复 bootstrap 触发 macOS "后台项已添加" 通知
        let already_registered = Command::new("launchctl")
            .args(["print", &service_target])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

        if !already_registered {
            let bootstrap_out = Command::new("launchctl")
                .args(["bootstrap", &domain_target, &path])
                .output()
                .map_err(|e| format!("bootstrap 失败: {e}"))?;

            if !bootstrap_out.status.success() {
                let stderr = String::from_utf8_lossy(&bootstrap_out.stderr);
                if !stderr.contains("already bootstrapped") && !stderr.trim().is_empty() {
                    return start_gateway_direct();
                }
            }
        }

        let kickstart_out = Command::new("launchctl")
            .args(["kickstart", &service_target])
            .output()
            .map_err(|e| format!("kickstart 失败: {e}"))?;

        if !kickstart_out.status.success() {
            let stderr = String::from_utf8_lossy(&kickstart_out.stderr);
            if !stderr.trim().is_empty() {
                // kickstart 也失败，回退到直接启动
                return start_gateway_direct();
            }
        }

        Ok(())
    }

    pub fn stop_service_impl(label: &str) -> Result<(), String> {
        let uid = current_uid()?;
        let service_target = format!("gui/{}/{}", uid, label);

        let output = Command::new("launchctl")
            .args(["bootout", &service_target])
            .output()
            .map_err(|e| format!("停止失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("No such process")
                && !stderr.contains("Could not find specified service")
                && !stderr.trim().is_empty()
            {
                return Err(format!("停止 {label} 失败: {stderr}"));
            }
        }

        Ok(())
    }

    #[allow(dead_code)]
    pub fn restart_service_impl(label: &str) -> Result<(), String> {
        let uid = current_uid()?;
        let path = plist_path(label);
        let domain_target = format!("gui/{}", uid);
        let service_target = format!("gui/{}/{}", uid, label);

        // 先停
        let _ = Command::new("launchctl")
            .args(["bootout", &service_target])
            .output();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let (running, _) = check_service_status(uid, label);
            if !running || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        // plist 不存在，直接用 CLI 启动
        if !std::path::Path::new(&path).exists() {
            return start_gateway_direct();
        }

        let bootstrap_out = Command::new("launchctl")
            .args(["bootstrap", &domain_target, &path])
            .output()
            .map_err(|e| format!("重启 bootstrap 失败: {e}"))?;

        if !bootstrap_out.status.success() {
            let stderr = String::from_utf8_lossy(&bootstrap_out.stderr);
            if !stderr.contains("already bootstrapped") && !stderr.trim().is_empty() {
                // launchctl 失败，回退到直接启动
                return start_gateway_direct();
            }
        }

        let kickstart_out = Command::new("launchctl")
            .args(["kickstart", "-k", &service_target])
            .output()
            .map_err(|e| format!("重启 kickstart 失败: {e}"))?;

        if !kickstart_out.status.success() {
            let stderr = String::from_utf8_lossy(&kickstart_out.stderr);
            if !stderr.trim().is_empty() {
                // kickstart 也失败，回退到直接启动
                return start_gateway_direct();
            }
        }

        Ok(())
    }
}

// ===== Windows 实现 =====

#[cfg(target_os = "windows")]
mod platform {
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;
    use std::process::Stdio;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// 缓存 is_cli_installed 结果，避免每 15 秒 polling 都 spawn cmd.exe
    static CLI_CACHE: Mutex<Option<(bool, std::time::Instant)>> = Mutex::new(None);
    const CLI_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    /// 记录最后一次成功启动的 Gateway PID，避免误判旧进程为新进程
    static LAST_KNOWN_GATEWAY_PID: Mutex<Option<u32>> = Mutex::new(None);

    /// 记录当前活跃的 Gateway 子进程（用于 stop 时精确 kill）
    static ACTIVE_GATEWAY_CHILD: Mutex<Option<u32>> = Mutex::new(None);

    /// 检查 Gateway 端口是否有响应（阻塞式 HTTP /health，3s 超时）
    fn is_gateway_port_responsive(port: u16) -> bool {
        use std::io::{Read, Write as IoWrite};
        use std::net::TcpStream;
        let addr = format!("127.0.0.1:{port}");
        let mut stream =
            match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_secs(3)) {
                Ok(s) => s,
                Err(_) => return false,
            };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let req = format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = [0u8; 256];
        match stream.read(&mut buf) {
            Ok(n) if n > 0 => {
                let resp = String::from_utf8_lossy(&buf[..n]);
                resp.contains("200") || resp.contains("OK")
            }
            _ => false,
        }
    }

    /// 从 netstat 输出中提取监听指定端口的所有 PID
    fn find_listening_pids(port: u16) -> Vec<u32> {
        let output = match StdCommand::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return vec![],
        };
        let mut pids = vec![];
        for line in output.lines() {
            let line = line.trim();
            if !line.contains(&format!(":{port}")) || !line.contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            if let Ok(pid) = parts.last().unwrap().parse::<u32>() {
                if pid > 0 && !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
        pids
    }

    /// 清理残留的僵尸 Gateway 进程（启动时调用，防止 Windows 重启后多进程堆积）
    /// 增强：检测端口占用但 /health 无响应的僵尸进程，强制杀掉
    pub(crate) fn cleanup_zombie_gateway_processes() {
        let port = crate::commands::gateway_listen_port();
        let pids = find_listening_pids(port);
        if pids.is_empty() {
            return;
        }

        // 先检查 /health 是否有响应 —— 如果端口有进程但无响应，说明是僵尸
        let responsive = is_gateway_port_responsive(port);

        for pid in &pids {
            let pid = *pid;

            if let Some(cmdline) = read_process_command_line(pid) {
                let cmdline_lower = cmdline.to_lowercase();
                let is_gateway =
                    cmdline_lower.contains("openclaw") && cmdline_lower.contains("gateway");
                let our_pid = *LAST_KNOWN_GATEWAY_PID.lock().unwrap();

                if is_gateway {
                    if !responsive {
                        // /health 无响应 → 僵尸进程，无条件杀掉（包括"已知好进程"）
                        super::guardian_log(&format!(
                            "检测到僵尸 Gateway 进程 (PID {pid})：端口 {port} 占用但 /health 无响应，强制终止"
                        ));
                        kill_process_tree(pid);
                    } else if Some(pid) != our_pid {
                        // /health 有响应但不是当前实例启动的 → 采纳为已知进程，不杀
                        super::guardian_log(&format!(
                            "检测到外部启动的 Gateway 进程 (PID {pid})：/health 正常响应，已采纳"
                        ));
                        let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
                        *known = Some(pid);
                    }
                }
            }
            // 读不到命令行时，不做假设，避免误杀其他进程
        }
    }

    fn read_process_command_line(pid: u32) -> Option<String> {
        // 优先用 PowerShell Get-CimInstance（wmic 在 Win11 已弃用）
        // fallback 到 wmic 以兼容旧版 Windows
        let ps_output = StdCommand::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId={}').CommandLine",
                    pid
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = ps_output {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
        // fallback: wmic（兼容 Win10 及更早版本）
        let output = match StdCommand::new("wmic")
            .args([
                "process",
                "where",
                &format!("ProcessId={pid}"),
                "get",
                "CommandLine",
                "/format:list",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return None,
        };
        for line in output.lines() {
            let line = line.trim();
            if let Some(cmd) = line.strip_prefix("CommandLine=") {
                return Some(cmd.to_string());
            }
        }
        None
    }

    fn kill_process_tree(pid: u32) {
        // 先尝试 /ti（包含子进程）
        let _ = StdCommand::new("taskkill")
            .args(["/f", "/t", "/pid", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    /// 获取 Gateway 端口对应的真实 PID（仅返回 OpenClaw Gateway 的 PID）
    fn get_gateway_pid_by_port(port: u16) -> Option<u32> {
        let output = match StdCommand::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return None,
        };

        for line in output.lines() {
            let line = line.trim();
            if !line.contains(&format!(":{port}")) || !line.contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            let pid = match parts.last().unwrap().parse::<u32>() {
                Ok(p) => p,
                Err(_) => continue,
            };

            // 验证命令行
            if let Some(cmdline) = read_process_command_line(pid) {
                let cmdline_lower = cmdline.to_lowercase();
                if cmdline_lower.contains("openclaw") && cmdline_lower.contains("gateway") {
                    return Some(pid);
                }
            } else {
                // 读不到命令行时，不做假设，避免误杀其他进程
                continue;
            }
        }
        None
    }

    /// 验证指定 PID 是否还活着
    fn is_process_alive(pid: u32) -> bool {
        let output = StdCommand::new("tasklist")
            .args(["/fi", &format!("PID eq {pid}"), "/nh"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // tasklist /nh 输出格式: "node.exe  1234 Console  1  50,000 K"
                // 行首是进程名，PID 在中间，需要检查行中是否包含该 PID
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    // 跳过空行和 "INFO: No tasks" 之类的提示
                    if trimmed.is_empty() || trimmed.starts_with("INFO:") {
                        continue;
                    }
                    // 检查行中是否包含该 PID（作为独立的数字字段）
                    let fields: Vec<&str> = trimmed.split_whitespace().collect();
                    if fields.len() >= 2 {
                        if let Ok(line_pid) = fields[1].parse::<u32>() {
                            if line_pid == pid {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            Err(_) => false,
        }
    }

    /// Windows 不需要 UID
    pub fn current_uid() -> Result<u32, String> {
        Ok(0)
    }

    /// 检测 openclaw CLI 是否已安装（带 60s 缓存，避免频繁 spawn 进程）
    pub fn is_cli_installed() -> bool {
        // 检查缓存
        if let Ok(guard) = CLI_CACHE.lock() {
            if let Some((val, ts)) = *guard {
                if ts.elapsed() < CLI_CACHE_TTL {
                    return val;
                }
            }
        }
        let result = check_cli_installed_inner();
        if let Ok(mut guard) = CLI_CACHE.lock() {
            *guard = Some((result, std::time::Instant::now()));
        }
        result
    }

    pub fn invalidate_cli_cache() {
        if let Ok(mut guard) = CLI_CACHE.lock() {
            *guard = None;
        }
    }

    fn candidate_cli_paths() -> Vec<PathBuf> {
        let mut candidates = Vec::new();

        // standalone 安装目录（集中管理，避免多处硬编码）
        for sa_dir in crate::commands::config::all_standalone_dirs() {
            candidates.push(sa_dir.join("openclaw.cmd"));
        }

        if let Ok(appdata) = env::var("APPDATA") {
            candidates.push(Path::new(&appdata).join("npm").join("openclaw.cmd"));
        }
        if let Ok(localappdata) = env::var("LOCALAPPDATA") {
            candidates.push(
                Path::new(&localappdata)
                    .join("Programs")
                    .join("nodejs")
                    .join("node_modules")
                    .join("@qingchencloud")
                    .join("openclaw-zh")
                    .join("bin")
                    .join("openclaw.js"),
            );
        }

        for segment in crate::commands::enhanced_path().split(';') {
            let dir = segment.trim();
            if dir.is_empty() {
                continue;
            }
            let base = Path::new(dir);
            candidates.push(base.join("openclaw.cmd"));
            candidates.push(base.join("openclaw"));
            candidates.push(
                base.join("node_modules")
                    .join("@qingchencloud")
                    .join("openclaw-zh")
                    .join("bin")
                    .join("openclaw.js"),
            );
        }

        candidates
    }

    fn check_cli_installed_inner() -> bool {
        if let Some(path) = crate::utils::resolve_openclaw_cli_path() {
            if Path::new(&path).exists() {
                return true;
            }
        }

        // 方式1: 检查常见文件路径（零进程，最快）
        for path in candidate_cli_paths() {
            if path.exists() {
                return true;
            }
        }

        // 方式2: 通过 where 查找（兼容 nvm、自定义 prefix 等）
        // 过滤掉第三方 openclaw（如 CherryStudio 的 .cherrystudio/bin/openclaw.exe）
        let mut where_cmd = std::process::Command::new("where");
        where_cmd.arg("openclaw");
        where_cmd.env("PATH", crate::commands::enhanced_path());
        where_cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(o) = where_cmd.output() {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout);
                for line in stdout.lines() {
                    let p = line.trim().to_lowercase();
                    // 跳过已知第三方 openclaw 路径
                    if p.contains(".cherrystudio") || p.contains("cherry-studio") {
                        continue;
                    }
                    if !p.is_empty() {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Windows 上始终返回 Gateway 标签（不管 CLI 是否安装）
    pub fn scan_service_labels() -> Vec<String> {
        vec!["ai.openclaw.gateway".to_string()]
    }

    /// 检测 Gateway 是否在运行，并返回其 PID
    /// 策略：先 TCP 端口检测连通性，再用 netstat+PowerShell 验证命令行是 OpenClaw Gateway
    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = crate::commands::gateway_listen_port();
        let addr = format!("127.0.0.1:{port}");
        let socket_addr = match addr.parse() {
            Ok(a) => a,
            Err(_) => return (false, None),
        };
        // 两次尝试：第一次 1 秒，失败后短暂等待再用 2 秒重试，避免瞬态超时误判
        let connected =
            std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_secs(1)).is_ok() || {
                std::thread::sleep(Duration::from_millis(300));
                std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)).is_ok()
            };
        if !connected {
            // 端口不通，先清空已知的僵死 PID
            let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            *known = None;
            return (false, None);
        }

        // 端口通了，PID 识别仅作为增强信息
        if let Some(pid) = get_gateway_pid_by_port(port) {
            let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            *known = Some(pid);
            (true, Some(pid))
        } else {
            // 避免因命令行查询失败误判为“未运行”并触发重复拉起
            (true, None)
        }
    }

    fn cleanup_legacy_gateway_window() {
        let _ = std::process::Command::new("taskkill")
            .args([
                "/f",
                "/t",
                "/fi",
                &format!("WINDOWTITLE eq {GATEWAY_WINDOW_TITLE}"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    fn create_gateway_log_files() -> Result<(std::fs::File, std::fs::File), String> {
        let log_dir = crate::commands::openclaw_dir().join("logs");
        fs::create_dir_all(&log_dir).map_err(|e| format!("创建日志目录失败: {e}"))?;

        let mut stdout_log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.log"))
            .map_err(|e| format!("创建日志文件失败: {e}"))?;

        let stderr_log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.err.log"))
            .map_err(|e| format!("创建错误日志文件失败: {e}"))?;

        let _ = writeln!(
            stdout_log,
            "\n[{}] [ClawPanel] Hidden-start Gateway on Windows",
            chrono::Local::now().to_rfc3339()
        );

        Ok((stdout_log, stderr_log))
    }

    const GATEWAY_WINDOW_TITLE: &str = "OpenClaw Gateway";

    /// 在后台隐藏启动 Gateway，避免守护重试时不断弹出终端窗口
    pub async fn start_service_impl(_label: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err(
                "openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装"
                    .into(),
            );
        }

        // Windows 重启后清理残留的僵尸 Gateway 进程（防止多进程堆积）
        cleanup_zombie_gateway_processes();

        // 端口已通 → 检查是不是我们的进程
        let (running, pid) = check_service_status(0, "");
        if running {
            // 有 PID 说明就是我们的进程在跑，可以直接返回
            if pid.is_some() {
                return Ok(());
            }
            // 无 PID 但端口通 → 可能是其他进程占用，拒绝启动
            return Err(format!(
                "端口 {} 被未知进程占用，请先关闭占用该端口的程序",
                crate::commands::gateway_listen_port()
            ));
        }

        let (stdout_log, stderr_log) = create_gateway_log_files()?;

        let mut cmd = crate::utils::openclaw_command();
        cmd.arg("gateway")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log);

        // 记录 spawn 前的已知 PID
        let before_pid = *LAST_KNOWN_GATEWAY_PID.lock().unwrap();

        let child = cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {e}"))?;
        let spawned_pid = child.id();

        // 记录活跃子进程 PID（用于 stop 时精确 kill）
        {
            let mut active = ACTIVE_GATEWAY_CHILD.lock().unwrap();
            *active = Some(spawned_pid);
        }

        // 轮询等待：端口就绪 AND PID 变化（说明新进程已接管端口）
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let (running2, pid2) = check_service_status(0, "");

            if let (true, Some(current_pid)) = (running2, pid2) {
                // PID 变了（新进程接管了端口）或 PID 仍然是我们刚 spawn 的
                let is_new = Some(current_pid) != before_pid;
                let is_spawned = current_pid == spawned_pid;
                if is_new || is_spawned {
                    // 验证这个 PID 确实还活着
                    if is_process_alive(current_pid) {
                        return Ok(());
                    }
                }
            }
        }

        Err("Gateway 启动超时，请查看 gateway.err.log".into())
    }

    /// 关闭 Gateway：精确 kill Gateway 进程，不误杀其他 node.exe
    pub async fn stop_service_impl(_label: &str) -> Result<(), String> {
        let port = crate::commands::gateway_listen_port();

        // 端口不通 → 已停止
        if !check_service_status(0, "").0 {
            cleanup_legacy_gateway_window();
            // 清空已记录的 PID
            {
                let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
                *known = None;
            }
            {
                let mut active = ACTIVE_GATEWAY_CHILD.lock().unwrap();
                *active = None;
            }
            return Ok(());
        }

        // 先尝试 openclaw gateway stop
        let _ = crate::utils::openclaw_command_async()
            .args(["gateway", "stop"])
            .output()
            .await;

        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if !check_service_status(0, "").0 {
                cleanup_legacy_gateway_window();
                let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
                *known = None;
                let mut active = ACTIVE_GATEWAY_CHILD.lock().unwrap();
                *active = None;
                return Ok(());
            }
        }

        // 精确 kill：只杀 Gateway 进程，不杀所有 node.exe
        // 1. 用记录的活跃子进程 PID
        let pids_to_kill: Vec<u32> = {
            let active = ACTIVE_GATEWAY_CHILD.lock().unwrap();
            let known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            [active.as_ref(), known.as_ref()]
                .into_iter()
                .flatten()
                .copied()
                .collect()
        };

        for &pid in &pids_to_kill {
            if pid > 0 && is_process_alive(pid) {
                kill_process_tree(pid);
            }
        }

        // 2. 再用 netstat 找当前端口上的 Gateway PID（兜底）
        if let Some(gw_pid) = get_gateway_pid_by_port(port) {
            if !pids_to_kill.contains(&gw_pid) {
                kill_process_tree(gw_pid);
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
        cleanup_legacy_gateway_window();

        if !check_service_status(0, "").0 {
            // 清空记录
            let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            *known = None;
            let mut active = ACTIVE_GATEWAY_CHILD.lock().unwrap();
            *active = None;
            Ok(())
        } else {
            Err("停止 Gateway 失败，请手动检查进程".into())
        }
    }

    #[allow(dead_code)]
    pub async fn restart_service_impl(_label: &str) -> Result<(), String> {
        stop_service_impl(_label).await?;
        start_service_impl(_label).await
    }
}

// ===== Linux 实现（与 Windows 类似，使用 openclaw CLI） =====

#[cfg(target_os = "linux")]
mod platform {
    use std::env;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;

    static CLI_CACHE: Mutex<Option<(bool, std::time::Instant)>> = Mutex::new(None);
    const CLI_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

    pub fn current_uid() -> Result<u32, String> {
        let output = std::process::Command::new("id")
            .arg("-u")
            .output()
            .map_err(|e| format!("获取 UID 失败: {e}"))?;
        let uid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        uid_str
            .parse::<u32>()
            .map_err(|e| format!("解析 UID 失败: {e}"))
    }

    /// Linux 上检测 CLI 是否安装（带缓存）
    pub fn is_cli_installed() -> bool {
        if let Ok(guard) = CLI_CACHE.lock() {
            if let Some((val, ts)) = *guard {
                if ts.elapsed() < CLI_CACHE_TTL {
                    return val;
                }
            }
        }
        let result = candidate_cli_paths().into_iter().any(|p| p.exists())
            || std::process::Command::new("which")
                .arg("openclaw")
                .env("PATH", crate::commands::enhanced_path())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        if let Ok(mut guard) = CLI_CACHE.lock() {
            *guard = Some((result, std::time::Instant::now()));
        }
        result
    }

    fn candidate_cli_paths() -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(home) = env::var("HOME") {
            candidates.push(PathBuf::from(&home).join(".openclaw").join("openclaw"));
            candidates.push(
                PathBuf::from(&home)
                    .join(".npm-global")
                    .join("bin")
                    .join("openclaw"),
            );
            candidates.push(
                PathBuf::from(&home)
                    .join("node_modules")
                    .join(".bin")
                    .join("openclaw"),
            );
        }
        // standalone 安装目录（集中管理，避免多处硬编码）
        for sa_dir in crate::commands::config::all_standalone_dirs() {
            candidates.push(sa_dir.join("openclaw"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
        candidates.push(PathBuf::from("/usr/bin/openclaw"));
        for segment in crate::commands::enhanced_path().split(':') {
            let dir = segment.trim();
            if dir.is_empty() {
                continue;
            }
            let base = PathBuf::from(dir);
            candidates.push(base.join("openclaw"));
        }
        candidates
    }

    pub fn scan_service_labels() -> Vec<String> {
        vec!["ai.openclaw.gateway".to_string()]
    }

    /// 跨平台统一检测：TCP 连端口
    #[allow(dead_code)]
    pub async fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = crate::commands::gateway_listen_port();
        let addr = format!("127.0.0.1:{port}");
        let socket_addr: std::net::SocketAddr = match addr.parse() {
            Ok(a) => a,
            Err(_) => return (false, None),
        };
        // 使用 spawn_blocking 避免阻塞 Tokio 运行时
        let result = tokio::task::spawn_blocking(move || {
            std::net::TcpStream::connect_timeout(&socket_addr, std::time::Duration::from_secs(1))
                .is_ok()
        })
        .await
        .unwrap_or(false);
        if result {
            (true, None)
        } else {
            (false, None)
        }
    }

    /// 清理残留的 Gateway 进程（Linux 版：通过 fuser 查端口占用进程并 kill）
    fn cleanup_zombie_gateway_processes() {
        let port = crate::commands::gateway_listen_port();
        // 尝试用 fuser 找到端口占用进程
        if let Ok(output) = std::process::Command::new("fuser")
            .args([&format!("{port}/tcp")])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &pid.to_string()])
                        .output();
                    eprintln!("[cleanup_zombie] killed PID {pid} on port {port}");
                }
            }
        }
    }

    async fn gateway_command(action: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err(
                "openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装"
                    .into(),
            );
        }
        let action_owned = action.to_string();
        let mut child = crate::utils::openclaw_command_async()
            .args(["gateway", &action_owned])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("执行 openclaw gateway {action_owned} 失败: {e}"))?;

        // 带超时等待命令完成（防止 restart 时旧进程卡死导致永远阻塞）
        let timeout = if action_owned == "stop" || action_owned == "restart" {
            Duration::from_secs(20)
        } else {
            Duration::from_secs(30)
        };

        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => {
                if !status.success() {
                    let stderr = if let Some(mut err) = child.stderr.take() {
                        let mut buf = String::new();
                        use tokio::io::AsyncReadExt;
                        let _ = err.read_to_string(&mut buf).await;
                        buf
                    } else {
                        String::new()
                    };
                    if action_owned == "restart" {
                        eprintln!("[gateway_command] restart 失败，尝试强制清理后重启");
                        cleanup_zombie_gateway_processes();
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        return start_service_impl("ai.openclaw.gateway").await;
                    }
                    return Err(format!("openclaw gateway {action_owned} 失败: {stderr}"));
                }
                Ok(())
            }
            Ok(Err(e)) => Err(format!("openclaw gateway {action_owned} 进程异常: {e}")),
            Err(_) => {
                let _ = child.kill().await;
                eprintln!(
                    "[gateway_command] openclaw gateway {} 超时 ({}s)，强制终止",
                    action_owned,
                    timeout.as_secs()
                );
                if action_owned == "restart" || action_owned == "stop" {
                    cleanup_zombie_gateway_processes();
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if action_owned == "restart" {
                        return start_service_impl("ai.openclaw.gateway").await;
                    }
                    return Ok(());
                }
                Err(format!("openclaw gateway {action_owned} 超时"))
            }
        }
    }

    pub async fn start_service_impl(_label: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err(
                "openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装"
                    .into(),
            );
        }

        // 启动前检查端口是否已被占用，防止重复拉起导致端口冲突和内存浪费
        let port = crate::commands::gateway_listen_port();
        let pre_check_addr: std::net::SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .map_err(|_| format!("端口 {port} 解析失败"))?;
        let already_occupied = tokio::task::spawn_blocking(move || {
            std::net::TcpStream::connect_timeout(
                &pre_check_addr,
                std::time::Duration::from_millis(500),
            )
            .is_ok()
        })
        .await
        .unwrap_or(false);
        if already_occupied {
            return Err(format!(
                "端口 {} 已被占用，Gateway 可能已在运行中（或其他程序占用了该端口）",
                port
            ));
        }

        let output = crate::utils::openclaw_command_async()
            .args(["gateway", "start"])
            .output()
            .await
            .map_err(|e| format!("执行 openclaw gateway start 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("openclaw gateway start 失败: {stderr}"));
        }

        // 等端口就绪（最多 15s）
        let port = crate::commands::gateway_listen_port();
        let addr: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(a) => a,
            Err(_) => return Err(format!("端口 {port} 解析失败")),
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let addr_clone = addr;
            let connected = tokio::task::spawn_blocking(move || {
                std::net::TcpStream::connect_timeout(
                    &addr_clone,
                    std::time::Duration::from_millis(200),
                )
                .is_ok()
            })
            .await
            .unwrap_or(false);
            if connected {
                return Ok(());
            }
        }

        Err(format!(
            "Gateway 启动超时，请查看 {}",
            crate::commands::openclaw_dir()
                .join("logs")
                .join("gateway.err.log")
                .display()
        ))
    }

    pub async fn stop_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("stop").await
    }

    #[allow(dead_code)]
    pub async fn restart_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("restart").await
    }
}

#[cfg(target_os = "windows")]
pub fn invalidate_cli_detection_cache() {
    platform::invalidate_cli_cache();
}

#[cfg(not(target_os = "windows"))]
pub fn invalidate_cli_detection_cache() {}

// ===== 跨平台公共接口 =====

/// 跨平台统一的服务状态检测：纯 TCP 端口连通性（macOS/Linux 使用）
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn check_tcp_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
    let port = crate::commands::gateway_listen_port();
    let addr = format!("127.0.0.1:{port}");
    let socket_addr = match addr.parse() {
        Ok(a) => a,
        Err(_) => return (false, None),
    };
    match std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_secs(1)) {
        Ok(_) => (true, None),
        Err(_) => (false, None),
    }
}

#[tauri::command]
pub async fn get_services_status() -> Result<Vec<ServiceStatus>, String> {
    let _uid = platform::current_uid()?;
    let labels = platform::scan_service_labels();
    let desc_map = description_map();
    let cli_installed = platform::is_cli_installed();

    let mut results = Vec::new();
    for label in labels.iter().map(String::as_str) {
        let (running, pid) = current_gateway_runtime(label).await;
        let owner = read_gateway_owner();
        let mut owned_by_current_instance = running
            && owner
                .as_ref()
                .map(|record| is_current_gateway_owner(record, pid))
                .unwrap_or(false);
        if owned_by_current_instance {
            if let Some(record) = owner.as_ref() {
                if gateway_owner_pid_needs_refresh(record, pid) {
                    let _ = write_gateway_owner(pid);
                }
            }
        }
        // 自动认领：Gateway 在运行但无有效 owner，且端口 + 数据目录匹配 → 自动写入 owner
        if running && !owned_by_current_instance && should_auto_claim_gateway(&owner) {
            let _ = write_gateway_owner(pid);
            owned_by_current_instance = true;
        }
        let ownership = if !running {
            Some("stopped".to_string())
        } else if owned_by_current_instance {
            Some("owned".to_string())
        } else {
            Some("foreign".to_string())
        };
        results.push(ServiceStatus {
            label: label.to_string(),
            pid,
            running,
            description: desc_map.get(label).unwrap_or(&"").to_string(),
            cli_installed,
            ownership,
            owned_by_current_instance: Some(owned_by_current_instance),
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn start_service(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let (running, pid) = current_gateway_runtime(&label).await;
    if running {
        ensure_owned_gateway_or_err(pid)?;
        write_gateway_owner(pid)?;
        guardian_mark_manual_start();
        return Ok(());
    }
    guardian_mark_manual_start();
    start_service_impl_internal(&label, Some(&app)).await
}

#[tauri::command]
pub async fn stop_service(label: String) -> Result<(), String> {
    let (running, pid) = current_gateway_runtime(&label).await;
    if running {
        ensure_owned_gateway_or_err(pid)?;
    }
    guardian_mark_manual_stop();
    stop_service_impl_internal(&label).await
}

#[tauri::command]
pub async fn restart_service(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let (running, pid) = current_gateway_runtime(&label).await;
    if running {
        ensure_owned_gateway_or_err(pid)?;
    }
    guardian_pause("manual restart");
    guardian_mark_manual_start();
    let result = restart_service_impl_internal(&label, Some(&app)).await;
    guardian_resume("manual restart");
    result
}

/// 认领外部 Gateway：将 gateway-owner.json 强制覆写为当前面板实例签名
#[tauri::command]
pub async fn claim_gateway() -> Result<(), String> {
    let (running, pid) = current_gateway_runtime("ai.openclaw.gateway").await;
    if !running {
        return Err("Gateway 未运行，无需认领".into());
    }
    write_gateway_owner(pid)?;
    Ok(())
}

/// 轻量 TCP 端口探测：检测 Gateway 端口是否可连通（用于 WS 连接前的就绪等待）
#[tauri::command]
pub async fn probe_gateway_port() -> bool {
    let port = crate::commands::gateway_listen_port();
    let addr = format!("127.0.0.1:{port}");
    tokio::net::TcpStream::connect(&addr).await.is_ok()
}
