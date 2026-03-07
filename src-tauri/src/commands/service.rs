/// 服务管理命令
/// macOS: launchctl + LaunchAgents plist
/// Windows: openclaw CLI + 进程检测
use std::collections::HashMap;

use crate::models::types::ServiceStatus;

/// OpenClaw 官方服务的友好名称映射
fn description_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("ai.openclaw.gateway", "OpenClaw Gateway"),
        ("ai.openclaw.node", "OpenClaw Node Host"),
    ])
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

        Command::new("openclaw")
            .arg("gateway")
            .env("PATH", &enhanced)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log)
            .spawn()
            .map_err(|e| {
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
            // plist 不存在，直接用 CLI 启动
            return start_gateway_direct();
        }

        let bootstrap_out = Command::new("launchctl")
            .args(["bootstrap", &domain_target, &path])
            .output()
            .map_err(|e| format!("bootstrap 失败: {e}"))?;

        if !bootstrap_out.status.success() {
            let stderr = String::from_utf8_lossy(&bootstrap_out.stderr);
            if !stderr.contains("already bootstrapped") && !stderr.trim().is_empty() {
                // launchctl 失败（如 plist 二进制路径过期），回退到直接启动
                return start_gateway_direct();
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
    use std::os::windows::process::CommandExt;
    use std::sync::Mutex;
    use tokio::process::Command as TokioCommand;

    /// 缓存 is_cli_installed 结果，避免每 15 秒 polling 都 spawn cmd.exe
    static CLI_CACHE: Mutex<Option<(bool, std::time::Instant)>> = Mutex::new(None);
    const CLI_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

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

    fn check_cli_installed_inner() -> bool {
        // 方式1: 检查常见文件路径（零进程，最快）
        if let Ok(appdata) = std::env::var("APPDATA") {
            let cmd_path = std::path::Path::new(&appdata)
                .join("npm")
                .join("openclaw.cmd");
            if cmd_path.exists() {
                return true;
            }
        }
        // 方式2: 通过 PATH 查找（兼容 nvm、自定义 prefix 等）
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "openclaw", "--version"]);
        cmd.env("PATH", crate::commands::enhanced_path());
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(o) = cmd.output() {
            if o.status.success() {
                return true;
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

    /// 通过端口探测检测 Gateway 状态
    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        let port = read_gateway_port();
        let addr = format!("127.0.0.1:{port}");
        match std::net::TcpStream::connect_timeout(
            &addr
                .parse()
                .unwrap_or_else(|_| "127.0.0.1:18789".parse().unwrap()),
            std::time::Duration::from_millis(150),
        ) {
            Ok(_) => (true, None),
            Err(_) => (false, None),
        }
    }

    /// 以前台模式 spawn Gateway（不需要管理员权限）
    pub async fn start_service_impl(_label: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err(
                "openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装"
                    .into(),
            );
        }
        if check_service_status(0, "").0 {
            return Ok(());
        }

        let log_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".openclaw")
            .join("logs");
        std::fs::create_dir_all(&log_dir).ok();

        let stdout_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.log"))
            .map_err(|e| format!("创建日志文件失败: {e}"))?;

        let stderr_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("gateway.err.log"))
            .map_err(|e| format!("创建错误日志文件失败: {e}"))?;

        crate::utils::openclaw_command_async()
            .arg("gateway")
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log)
            .spawn()
            .map_err(|e| format!("启动 Gateway 失败: {e}"))?;

        for _ in 0..25 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if check_service_status(0, "").0 {
                return Ok(());
            }
        }
        Err("Gateway 启动超时，请检查日志".into())
    }

    pub async fn stop_service_impl(_label: &str) -> Result<(), String> {
        let _ = crate::utils::openclaw_command_async()
            .args(["gateway", "stop"])
            .output()
            .await;
        if check_service_status(0, "").0 {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = TokioCommand::new("cmd")
                .args([
                    "/c",
                    "taskkill",
                    "/f",
                    "/im",
                    "node.exe",
                    "/fi",
                    "WINDOWTITLE eq openclaw*",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .await;
        }
        Ok(())
    }

    pub async fn restart_service_impl(_label: &str) -> Result<(), String> {
        let _ = stop_service_impl(_label).await;
        for _ in 0..10 {
            if !check_service_status(0, "").0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
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

// ===== 跨平台公共接口 =====

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

    for label in &labels {
        #[cfg(target_os = "linux")]
        let (running, pid) = platform::check_service_status(uid, label).await;
        #[cfg(not(target_os = "linux"))]
        let (running, pid) = platform::check_service_status(uid, label);

        results.push(ServiceStatus {
            label: label.clone(),
            pid,
            running,
            description: desc_map.get(label.as_str()).unwrap_or(&"").to_string(),
            cli_installed,
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn start_service(label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::start_service_impl(&label);
    #[cfg(not(target_os = "macos"))]
    platform::start_service_impl(&label).await
}

#[tauri::command]
pub async fn stop_service(label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::stop_service_impl(&label);
    #[cfg(not(target_os = "macos"))]
    platform::stop_service_impl(&label).await
}

#[tauri::command]
pub async fn restart_service(label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::restart_service_impl(&label);
    #[cfg(not(target_os = "macos"))]
    platform::restart_service_impl(&label).await
}
