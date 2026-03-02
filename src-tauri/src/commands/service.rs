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
        uid_str.parse::<u32>().map_err(|e| format!("解析 UID 失败: {e}"))
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
        format!(
            "{}/Library/LaunchAgents/{}.plist",
            home.display(),
            label
        )
    }

    /// 用 launchctl print 检测单个服务状态，返回 (running, pid)
    pub fn check_service_status(uid: u32, label: &str) -> (bool, Option<u32>) {
        let target = format!("gui/{}/{}", uid, label);
        let output = Command::new("launchctl")
            .args(["print", &target])
            .output();

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
            if trimmed.starts_with("pid = ") {
                if let Ok(p) = trimmed["pid = ".len()..].trim().parse::<u32>() {
                    pid = Some(p);
                }
            }
            if trimmed.starts_with("state = ") {
                let state = trimmed["state = ".len()..].trim();
                running = state == "running";
            }
        }

        (running, pid)
    }

    pub fn start_service_impl(label: &str) -> Result<(), String> {
        let uid = current_uid()?;
        let path = plist_path(label);
        let domain_target = format!("gui/{}", uid);
        let service_target = format!("gui/{}/{}", uid, label);

        let bootstrap_out = Command::new("launchctl")
            .args(["bootstrap", &domain_target, &path])
            .output()
            .map_err(|e| format!("bootstrap 失败: {e}"))?;

        if !bootstrap_out.status.success() {
            let stderr = String::from_utf8_lossy(&bootstrap_out.stderr);
            if !stderr.contains("already bootstrapped") && !stderr.trim().is_empty() {
                return Err(format!("启动 {label} 失败: {stderr}"));
            }
        }

        let kickstart_out = Command::new("launchctl")
            .args(["kickstart", &service_target])
            .output()
            .map_err(|e| format!("kickstart 失败: {e}"))?;

        if !kickstart_out.status.success() {
            let stderr = String::from_utf8_lossy(&kickstart_out.stderr);
            if !stderr.trim().is_empty() {
                return Err(format!("kickstart {label} 失败: {stderr}"));
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

        let bootstrap_out = Command::new("launchctl")
            .args(["bootstrap", &domain_target, &path])
            .output()
            .map_err(|e| format!("重启 bootstrap 失败: {e}"))?;

        if !bootstrap_out.status.success() {
            let stderr = String::from_utf8_lossy(&bootstrap_out.stderr);
            if !stderr.contains("already bootstrapped") && !stderr.trim().is_empty() {
                return Err(format!("重启 {label} 失败 (bootstrap): {stderr}"));
            }
        }

        let kickstart_out = Command::new("launchctl")
            .args(["kickstart", "-k", &service_target])
            .output()
            .map_err(|e| format!("重启 kickstart 失败: {e}"))?;

        if !kickstart_out.status.success() {
            let stderr = String::from_utf8_lossy(&kickstart_out.stderr);
            if !stderr.trim().is_empty() {
                return Err(format!("重启 {label} 失败 (kickstart): {stderr}"));
            }
        }

        Ok(())
    }
}

// ===== Windows 实现 =====

#[cfg(target_os = "windows")]
mod platform {
    /// Windows 不需要 UID
    pub fn current_uid() -> Result<u32, String> {
        Ok(0)
    }

    /// 检测 openclaw CLI 是否已安装（文件系统检测，避免 spawn 进程）
    pub fn is_cli_installed() -> bool {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let cmd_path = std::path::Path::new(&appdata).join("npm").join("openclaw.cmd");
            if cmd_path.exists() { return true; }
        }
        false
    }

    /// Windows 上始终返回 Gateway 标签（不管 CLI 是否安装）
    pub fn scan_service_labels() -> Vec<String> {
        vec!["ai.openclaw.gateway".to_string()]
    }

    /// 通过端口探测检测 Gateway 状态
    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        match std::net::TcpStream::connect_timeout(
            &"127.0.0.1:18789".parse().unwrap(),
            std::time::Duration::from_millis(150),
        ) {
            Ok(_) => (true, None),
            Err(_) => (false, None),
        }
    }

    /// 以前台模式 spawn Gateway（不需要管理员权限）
    pub fn start_service_impl(_label: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err("openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装".into());
        }
        if check_service_status(0, "").0 {
            return Ok(());
        }
        crate::utils::openclaw_command()
            .arg("gateway")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 Gateway 失败: {e}"))?;

        for _ in 0..25 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if check_service_status(0, "").0 {
                return Ok(());
            }
        }
        Err("Gateway 启动超时，请检查日志".into())
    }

    pub fn stop_service_impl(_label: &str) -> Result<(), String> {
        let _ = crate::utils::openclaw_command()
            .args(["gateway", "stop"])
            .output();
        if check_service_status(0, "").0 {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = std::process::Command::new("cmd")
                .args(["/c", "taskkill", "/f", "/im", "node.exe", "/fi", "WINDOWTITLE eq openclaw*"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        Ok(())
    }

    pub fn restart_service_impl(_label: &str) -> Result<(), String> {
        let _ = stop_service_impl(_label);
        for _ in 0..10 {
            if !check_service_status(0, "").0 { break; }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        start_service_impl(_label)
    }
}

// ===== Linux 实现（与 Windows 类似，使用 openclaw CLI） =====

#[cfg(target_os = "linux")]
mod platform {
    use std::process::Command;

    pub fn current_uid() -> Result<u32, String> {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|e| format!("获取 UID 失败: {e}"))?;
        let uid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        uid_str.parse::<u32>().map_err(|e| format!("解析 UID 失败: {e}"))
    }

    pub fn is_cli_installed() -> bool {
        Command::new("openclaw")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn scan_service_labels() -> Vec<String> {
        vec!["ai.openclaw.gateway".to_string()]
    }

    pub fn check_service_status(_uid: u32, _label: &str) -> (bool, Option<u32>) {
        match std::net::TcpStream::connect_timeout(
            &"127.0.0.1:18789".parse().unwrap(),
            std::time::Duration::from_secs(2),
        ) {
            Ok(_) => (true, None),
            Err(_) => {
                if let Ok(output) = Command::new("openclaw").arg("health").output() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    if output.status.success() && !text.contains("not running") {
                        return (true, None);
                    }
                }
                (false, None)
            }
        }
    }

    fn gateway_command(action: &str) -> Result<(), String> {
        if !is_cli_installed() {
            return Err("openclaw CLI 未安装，请先通过 npm install -g @qingchencloud/openclaw-zh 安装".into());
        }
        let output = crate::utils::openclaw_command()
            .args(["gateway", action])
            .output()
            .map_err(|e| format!("执行 openclaw gateway {action} 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("openclaw gateway {action} 失败: {stderr}"));
        }
        Ok(())
    }

    pub fn start_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("start")
    }

    pub fn stop_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("stop")
    }

    pub fn restart_service_impl(_label: &str) -> Result<(), String> {
        gateway_command("restart")
    }
}

// ===== 跨平台公共接口 =====

#[tauri::command]
pub fn get_services_status() -> Result<Vec<ServiceStatus>, String> {
    let uid = platform::current_uid()?;
    let labels = platform::scan_service_labels();
    let desc_map = description_map();
    let cli_installed = platform::is_cli_installed();
    let mut results = Vec::new();

    for label in &labels {
        let (running, pid) = platform::check_service_status(uid, label);
        results.push(ServiceStatus {
            label: label.clone(),
            pid,
            running,
            description: desc_map
                .get(label.as_str())
                .unwrap_or(&"")
                .to_string(),
            cli_installed,
        });
    }

    Ok(results)
}

#[tauri::command]
pub fn start_service(label: String) -> Result<(), String> {
    platform::start_service_impl(&label)
}

#[tauri::command]
pub fn stop_service(label: String) -> Result<(), String> {
    platform::stop_service_impl(&label)
}

#[tauri::command]
pub fn restart_service(label: String) -> Result<(), String> {
    platform::restart_service_impl(&label)
}
