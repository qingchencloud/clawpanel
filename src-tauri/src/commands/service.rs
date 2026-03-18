/// 服务管理命令
/// macOS: launchctl + LaunchAgents plist
/// Windows: openclaw CLI + 进程检测
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::models::types::ServiceStatus;
use serde::Serialize;
use tauri::Emitter;

/// OpenClaw 官方服务的友好名称映射
fn description_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("ai.openclaw.gateway", "OpenClaw Gateway"),
        ("ai.openclaw.node", "OpenClaw Node Host"),
    ])
}

#[cfg(target_os = "windows")]
fn looks_like_gateway_command_line(command_line: &str) -> bool {
    let text = command_line.to_ascii_lowercase();
    text.contains("openclaw") && text.contains("gateway")
}

#[cfg(target_os = "windows")]
fn parse_listening_pids_from_netstat(stdout: &str, port: u16) -> Vec<u32> {
    let port_pattern = format!(":{port}");
    let mut pids = HashSet::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("LISTENING") || trimmed.contains("侦听")) {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }

        let Some(local_addr) = parts.get(1) else {
            continue;
        };

        if !local_addr.ends_with(&port_pattern) {
            continue;
        }

        if let Ok(pid) = parts[4].parse::<u32>() {
            if pid > 0 {
                pids.insert(pid);
            }
        }
    }

    let mut ordered: Vec<u32> = pids.into_iter().collect();
    ordered.sort_unstable();
    ordered
}

const GUARDIAN_INTERVAL: Duration = Duration::from_secs(15);
const GUARDIAN_RESTART_COOLDOWN: Duration = Duration::from_secs(60);
const GUARDIAN_STABLE_WINDOW: Duration = Duration::from_secs(120);
const GUARDIAN_MAX_AUTO_RESTART: u32 = 3;

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

static GUARDIAN_STATE: OnceLock<Arc<Mutex<GuardianRuntimeState>>> = OnceLock::new();
static GUARDIAN_STARTED: AtomicBool = AtomicBool::new(false);

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
        if let Err(err) = start_service_impl_internal("ai.openclaw.gateway").await {
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

async fn start_service_impl_internal(label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::start_service_impl(label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::start_service_impl(label).await
    }
}

async fn stop_service_impl_internal(label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::stop_service_impl(label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::stop_service_impl(label).await
    }
}

async fn restart_service_impl_internal(label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::restart_service_impl(label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::restart_service_impl(label).await
    }
}

pub fn start_backend_guardian(app: tauri::AppHandle) {
    if GUARDIAN_STARTED.swap(true, Ordering::SeqCst) {
        return;
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
    use std::process::Command;

    const OPENCLAW_PREFIXES: &[&str] = &["ai.openclaw."];

    /// macOS 上 CLI 是否安装（检查 plist 是否存在即可）
    pub fn is_cli_installed() -> bool {
        true // macOS 通过 plist 扫描，不依赖 CLI 检测
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
        labels
    }

    fn plist_path(label: &str) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        format!("{}/Library/LaunchAgents/{}.plist", home.display(), label)
    }

    /// 用 launchctl print 检测单个服务状态，返回 (running, pid)
    pub fn check_service_status(uid: u32, label: &str) -> (bool, Option<u32>) {
        let target = format!("gui/{}/{}", uid, label);
        let output = Command::new("launchctl").args(["print", &target]).output();

        let Ok(out) = output else {
            return (false, None);
        };

        if !out.status.success() {
            return (false, None);
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut pid: Option<u32> = None;
        let mut running = false;

        for line in stdout.lines() {
            if !line.starts_with('\t') || line.starts_with("\t\t") {
                continue;
            }
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("pid = ") {
                if let Ok(p) = rest.trim().parse::<u32>() {
                    pid = Some(p);
                }
            }
            if let Some(rest) = trimmed.strip_prefix("state = ") {
                running = rest.trim() == "running";
            }
        }

        (running, pid)
    }

    /// launchctl 失败时的回退：直接通过 CLI spawn Gateway 进程
    fn start_gateway_direct() -> Result<(), String> {
        let enhanced = crate::commands::enhanced_path();

        let log_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".openclaw")
            .join("logs");
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

        let mut cmd = Command::new("openclaw");
        cmd.arg("gateway")
            .env("PATH", &enhanced)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "OpenClaw CLI 未找到，请确认已安装并重启 ClawPanel。".to_string()
            } else {
                format!("启动 Gateway 失败: {e}")
            }
        })?;

        // 等 Gateway 初始化
        std::thread::sleep(std::time::Duration::from_secs(2));
        Ok(())
    }

    pub fn start_service_impl(label: &str) -> Result<(), String> {
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
    use std::process::Stdio;
    use std::sync::Mutex;
    use tokio::process::Command as TokioCommand;

    /// 缓存 is_cli_installed 结果，避免每 15 秒 polling 都 spawn cmd.exe
    static CLI_CACHE: Mutex<Option<(bool, std::time::Instant)>> = Mutex::new(None);
    const CLI_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
    const CREATE_NO_WINDOW: u32 = 0x08000000;

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

        // standalone 安装目录（优先检测，覆盖所有可能位置）
        if let Ok(localappdata) = env::var("LOCALAPPDATA") {
            // Inno Setup PrivilegesRequired=lowest 默认路径
            candidates.push(
                Path::new(&localappdata)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("openclaw.cmd"),
            );
            candidates.push(
                Path::new(&localappdata)
                    .join("OpenClaw")
                    .join("openclaw.cmd"),
            );
        }
        if let Ok(pf) = env::var("ProgramFiles") {
            candidates.push(Path::new(&pf).join("OpenClaw").join("openclaw.cmd"));
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

    /// 从 openclaw.json 读取 gateway 端口，fallback 到 18789
    fn read_gateway_port() -> u16 {
        let config_path = crate::commands::openclaw_dir().join("openclaw.json");
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(port) = val
                    .get("gateway")
                    .and_then(|g| g.get("port"))
                    .and_then(|p| p.as_u64())
                {
                    if port > 0 && port < 65536 {
                        return port as u16;
                    }
                }
            }
        }
        18789
    }

    fn query_listening_pids(port: u16) -> Result<Vec<u32>, String> {
        let output = std::process::Command::new("netstat")
            .args(["-ano"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("netstat 失败: {e}"))?;

        Ok(super::parse_listening_pids_from_netstat(
            &String::from_utf8_lossy(&output.stdout),
            port,
        ))
    }

    fn query_process_command_line(pid: u32) -> Option<String> {
        let script = format!(
            r#"$p = Get-CimInstance Win32_Process -Filter "ProcessId = {pid}"; if ($p) {{ [Console]::Out.Write($p.CommandLine) }}"#,
        );

        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    fn inspect_port_owners(port: u16) -> Result<(Vec<u32>, Vec<u32>), String> {
        let listening_pids = query_listening_pids(port)?;
        let mut gateway_pids = Vec::new();
        let mut foreign_pids = Vec::new();

        for pid in listening_pids {
            match query_process_command_line(pid) {
                Some(command_line) if super::looks_like_gateway_command_line(&command_line) => {
                    gateway_pids.push(pid);
                }
                Some(command_line) if !command_line.is_empty() => {
                    foreign_pids.push(pid);
                }
                _ => {
                    // 命令行读不到时，假定为 Gateway（避免权限问题导致误报）
                    gateway_pids.push(pid);
                }
            }
        }

        gateway_pids.sort_unstable();
        gateway_pids.dedup();
        foreign_pids.sort_unstable();
        foreign_pids.dedup();
        Ok((gateway_pids, foreign_pids))
    }

    fn format_pid_list(pids: &[u32]) -> String {
        pids.iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }

    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = read_gateway_port();
        match inspect_port_owners(port) {
            Ok((gateway_pids, _)) => {
                let pid = gateway_pids.first().copied();
                (pid.is_some(), pid)
            }
            Err(_) => (false, None),
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
        let log_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".openclaw")
            .join("logs");
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

        let port = read_gateway_port();
        let (gateway_pids, foreign_pids) = inspect_port_owners(port)?;
        if !gateway_pids.is_empty() {
            return Ok(());
        }
        if !foreign_pids.is_empty() {
            return Err(format!(
                "端口 {port} 已被非 Gateway 进程占用 (PID: {})，已阻止启动以避免无限重启",
                format_pid_list(&foreign_pids)
            ));
        }

        let enhanced = crate::commands::enhanced_path();
        let (stdout_log, stderr_log) = create_gateway_log_files()?;

        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "openclaw", "gateway"])
            .env("PATH", &enhanced)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {e}"))?;

        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if check_service_status(0, "").0 {
                return Ok(());
            }
        }

        let (_, foreign_pids_after) = inspect_port_owners(port)?;
        if !foreign_pids_after.is_empty() {
            return Err(format!(
                "Gateway 启动失败，端口 {port} 已被其他进程占用 (PID: {})",
                format_pid_list(&foreign_pids_after)
            ));
        }

        Err("Gateway 启动超时，请查看 gateway.err.log".into())
    }

    /// 关闭 Gateway，只允许停止已确认的 Gateway 进程
    pub async fn stop_service_impl(_label: &str) -> Result<(), String> {
        let port = read_gateway_port();
        let (gateway_pids, foreign_pids) = inspect_port_owners(port)?;
        if gateway_pids.is_empty() {
            if !foreign_pids.is_empty() {
                return Err(format!(
                    "端口 {port} 当前由非 Gateway 进程占用 (PID: {})，已拒绝停止以避免误杀",
                    format_pid_list(&foreign_pids)
                ));
            }
            cleanup_legacy_gateway_window();
            return Ok(());
        }

        // 先尝试优雅停止
        let _ = crate::utils::openclaw_command_async()
            .args(["gateway", "stop"])
            .output()
            .await;

        // 等一下看是否停了
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if !check_service_status(0, "").0 {
                cleanup_legacy_gateway_window();
                return Ok(());
            }
        }

        // 优雅停止失败，只对已确认的 Gateway PID 做强制终止
        for pid in gateway_pids {
            let _ = TokioCommand::new("taskkill")
                .args(["/f", "/t", "/pid", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .await;
        }

        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if !check_service_status(0, "").0 {
                cleanup_legacy_gateway_window();
                return Ok(());
            }
        }

        Err(format!(
            "停止 Gateway 失败，端口 {port} 仍被 Gateway 进程占用"
        ))
    }

    pub async fn restart_service_impl(_label: &str) -> Result<(), String> {
        stop_service_impl(_label).await?;
        start_service_impl(_label).await
    }
}

// ===== Linux 实现（与 Windows 类似，使用 openclaw CLI） =====

#[cfg(target_os = "linux")]
mod platform {
    use tokio::process::Command;

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

    pub async fn is_cli_installed() -> bool {
        Command::new("openclaw")
            .arg("--version")
            .env("PATH", crate::commands::enhanced_path())
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn scan_service_labels() -> Vec<String> {
        vec!["ai.openclaw.gateway".to_string()]
    }

    /// 从 openclaw.json 读取 gateway 端口，fallback 到 18789
    fn read_gateway_port() -> u16 {
        let config_path = crate::commands::openclaw_dir().join("openclaw.json");
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(port) = val
                    .get("gateway")
                    .and_then(|g| g.get("port"))
                    .and_then(|p| p.as_u64())
                {
                    if port > 0 && port < 65536 {
                        return port as u16;
                    }
                }
            }
        }
        18789
    }

    pub async fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = read_gateway_port();
        let addr = format!("127.0.0.1:{port}");
        match std::net::TcpStream::connect_timeout(
            &addr
                .parse()
                .unwrap_or_else(|_| "127.0.0.1:18789".parse().unwrap()),
            std::time::Duration::from_secs(2),
        ) {
            Ok(_) => (true, None),
            Err(_) => {
                if let Ok(output) = Command::new("openclaw")
                    .arg("health")
                    .env("PATH", crate::commands::enhanced_path())
                    .output()
                    .await
                {
                    let text = String::from_utf8_lossy(&output.stdout);
                    if output.status.success() && !text.contains("not running") {
                        return (true, None);
                    }
                }
                (false, None)
            }
        }
    }

    async fn gateway_command(action: &str) -> Result<(), String> {
        if !is_cli_installed().await {
            return Err(
                "openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装"
                    .into(),
            );
        }
        let output = crate::utils::openclaw_command_async()
            .args(["gateway", action])
            .output()
            .await
            .map_err(|e| format!("执行 openclaw gateway {action} 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("openclaw gateway {action} 失败: {stderr}"));
        }
        Ok(())
    }

    pub async fn start_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("start").await
    }

    pub async fn stop_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("stop").await
    }

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

#[cfg(target_os = "linux")]
async fn check_service_status_for_label(uid: u32, label: &str) -> (bool, Option<u32>) {
    platform::check_service_status(uid, label).await
}

#[cfg(not(target_os = "linux"))]
async fn check_service_status_for_label(uid: u32, label: &str) -> (bool, Option<u32>) {
    platform::check_service_status(uid, label)
}

#[tauri::command]
pub async fn get_services_status() -> Result<Vec<ServiceStatus>, String> {
    let uid = platform::current_uid()?;
    let labels = platform::scan_service_labels();
    let desc_map = description_map();

    #[cfg(target_os = "linux")]
    let cli_installed = platform::is_cli_installed().await;
    #[cfg(not(target_os = "linux"))]
    let cli_installed = platform::is_cli_installed();

    let mut results = Vec::new();

    for label in labels.iter().map(String::as_str) {
        let (running, pid) = check_service_status_for_label(uid, label).await;

        results.push(ServiceStatus {
            label: label.to_string(),
            pid,
            running,
            description: desc_map.get(label).unwrap_or(&"").to_string(),
            cli_installed,
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn start_service(label: String) -> Result<(), String> {
    guardian_mark_manual_start();
    start_service_impl_internal(&label).await
}

#[tauri::command]
pub async fn stop_service(label: String) -> Result<(), String> {
    guardian_mark_manual_stop();
    stop_service_impl_internal(&label).await
}

#[tauri::command]
pub async fn restart_service(label: String) -> Result<(), String> {
    guardian_pause("manual restart");
    guardian_mark_manual_start();
    let result = restart_service_impl_internal(&label).await;
    guardian_resume("manual restart");
    result
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{looks_like_gateway_command_line, parse_listening_pids_from_netstat};

    #[test]
    fn 只把_openclaw_gateway_命令行识别为_gateway_进程() {
        assert!(looks_like_gateway_command_line(
            r#""C:\Program Files\nodejs\node.exe" "C:\Users\me\AppData\Roaming\npm\node_modules\@qingchencloud\openclaw-zh\bin\openclaw.js" gateway"#,
        ));
        assert!(!looks_like_gateway_command_line(
            r#""C:\Program Files\nodejs\node.exe" "C:\app\server.js""#,
        ));
        assert!(!looks_like_gateway_command_line(
            r#""C:\Program Files\SomeApp\someapp.exe" --port 18789"#,
        ));
    }

    #[test]
    fn 只解析目标端口的监听_pid() {
        let netstat = r#"
  TCP    0.0.0.0:18789          0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:18790        0.0.0.0:0              LISTENING       2222
  TCP    [::]:18789             [::]:0                 LISTENING       3333
        "#;

        let pids = parse_listening_pids_from_netstat(netstat, 18789);
        assert_eq!(pids, vec![1234, 3333]);
    }
}
