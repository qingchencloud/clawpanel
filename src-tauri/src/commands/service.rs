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
use serde::Serialize;
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
        match std::net::TcpStream::connect_timeout(&socket_addr, std::time::Duration::from_secs(1))
        {
            Ok(_) => {
                // 尝试通过 lsof 获取 PID
                let pid = get_pid_by_lsof(port);
                (true, pid)
            }
            Err(_) => (false, None),
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

        let enhanced = crate::commands::enhanced_path();

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

        Err("Gateway 启动超时，请查看 ~/.openclaw/logs/gateway.err.log".into())
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

    /// 清理残留的僵尸 Gateway 进程（启动时调用，防止 Windows 重启后多进程堆积）
    pub(crate) fn cleanup_zombie_gateway_processes() {
        let port = crate::commands::gateway_listen_port();

        // 用 netstat 找到端口 18789 的所有监听进程 PID
        let output = match StdCommand::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return,
        };

        for line in output.lines() {
            let line = line.trim();
            // 匹配  TCP    0.0.0.0:18789    0.0.0.0:0    LISTENING    <PID>
            if !line.contains(&format!(":{port}")) || !line.contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            let pid_str = parts.last().unwrap();
            let pid = match pid_str.parse::<u32>() {
                Ok(p) => p,
                Err(_) => continue,
            };

            // 验证这个 PID 的命令行是否确实是 Gateway
            if let Some(cmdline) = read_process_command_line(pid) {
                let cmdline_lower = cmdline.to_lowercase();
                // 只要包含 openclaw 且包含 gateway 就认为是 Gateway 进程
                // 排除纯 node.exe（可能是其他应用）
                if cmdline_lower.contains("openclaw") && cmdline_lower.contains("gateway") {
                    // 只杀我们自己的 PID，不杀记录中的"已知好进程"
                    let our_pid = *LAST_KNOWN_GATEWAY_PID.lock().unwrap();
                    if Some(pid) != our_pid {
                        kill_process_tree(pid);
                    }
                }
            }
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
    /// 策略：先 TCP 端口检测连通性，再用 netstat+WMIC 验证命令行是 OpenClaw Gateway
    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = crate::commands::gateway_listen_port();
        let addr = format!("127.0.0.1:{port}");
        let socket_addr = match addr.parse() {
            Ok(a) => a,
            Err(_) => return (false, None),
        };
        if std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_secs(1)).is_err() {
            // 端口不通，先清空已知的僵死 PID
            let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            *known = None;
            return (false, None);
        }

        // 端口通了，获取真实 PID
        if let Some(pid) = get_gateway_pid_by_port(port) {
            let mut known = LAST_KNOWN_GATEWAY_PID.lock().unwrap();
            *known = Some(pid);
            (true, Some(pid))
        } else {
            // 端口通但找不到合法 Gateway PID → 可能是其他进程占用了端口
            (false, None)
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

        Err("Gateway 启动超时，请查看 ~/.openclaw/logs/gateway.err.log".into())
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

/// 跨平台统一的服务状态检测：纯 TCP 端口连通性（macOS/Linux 使用）
#[cfg(not(target_os = "windows"))]
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
        // Windows 使用 platform::check_service_status（含真实 PID 检测）
        #[cfg(target_os = "windows")]
        let (running, pid) = platform::check_service_status(_uid, label);
        #[cfg(not(target_os = "windows"))]
        let (running, pid) = check_tcp_service_status(_uid, label);
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
