//! Gateway 进程管理模块。
//! 管理 Gateway 进程的启动、停止、重启和状态检查。

use crate::sandbox::gateway_port;
#[allow(unused_imports)]
use std::process::Stdio;
use std::time::Duration;
use tauri::command;

/// Gateway 状态响应
#[derive(Debug, serde::Serialize)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub message: String,
}

/// 检查 Gateway 是否运行
#[command]
pub fn gateway_status() -> Result<GatewayStatus, String> {
    let port = gateway_port();

    // 尝试查找端口上的进程
    let pid = find_pid_by_port(port);

    let running = pid.is_some();
    let message = if running {
        format!("Gateway is running on port {}", port)
    } else {
        format!("Gateway is not running on port {}", port)
    };

    Ok(GatewayStatus {
        running,
        port,
        pid,
        message,
    })
}

/// 在指定端口上查找进程 PID
fn find_pid_by_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        // macOS: 使用 lsof
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output()
            .ok()?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        pid_str.parse::<u32>().ok()
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: 使用 ss 或 lsof
        let output = std::process::Command::new("ss")
            .args(["-tlnp", &format!("sport = :{}", port)])
            .output()
            .ok()?;

        let output_str = String::from_utf8_lossy(&output.stdout);
        // 解析输出格式: LISTEN 0 128 *:28790 *:* users:(("node",pid=1234,fd=20))
        for line in output_str.lines() {
            if let Some(pid_start) = line.find("pid=") {
                let rest = &line[pid_start + 4..];
                if let Some(pid_end) = rest.find(|c: char| !c.is_ascii_digit()) {
                    if let Ok(pid) = rest[..pid_end].parse::<u32>() {
                        return Some(pid);
                    }
                }
            }
        }

        // 备用: 尝试 lsof
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output()
            .ok()?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        pid_str.parse::<u32>().ok()
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 netstat
        let output = std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output()
            .ok()?;

        let output_str = String::from_utf8_lossy(&output.stdout);
        let port_str = format!(":{}", port);

        for line in output_str.lines() {
            if line.contains(&port_str) && line.contains("LISTENING") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(pid_str) = parts.last() {
                    return pid_str.parse::<u32>().ok();
                }
            }
        }

        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = port;
        None
    }
}

/// 等待端口上有进程监听，最多重试 max_attempts 次
fn wait_for_port(port: u16, max_attempts: u32) -> Option<u32> {
    for _ in 0..max_attempts {
        if let Some(pid) = find_pid_by_port(port) {
            return Some(pid);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    None
}

/// 启动 Gateway
#[command]
pub fn gateway_start() -> Result<GatewayStatus, String> {
    let port = gateway_port();

    // 检查是否已运行
    if let Some(pid) = find_pid_by_port(port) {
        return Ok(GatewayStatus {
            running: true,
            port,
            pid: Some(pid),
            message: format!("Gateway already running on port {} (PID: {})", port, pid),
        });
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: 使用 LaunchAgent
        let label = "com.cjgclaw.gateway";
        let plist_path = dirs::home_dir()
            .unwrap_or_default()
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label));

        if !plist_path.exists() {
            // 创建 LaunchAgent plist
            let plist_content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-a</string>
        <string>CJGClaw</string>
        <string>--args</string>
        <string>gateway</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>"#,
                label
            );
            std::fs::write(&plist_path, plist_content)
                .map_err(|e| format!("Failed to create LaunchAgent plist: {}", e))?;
        }

        // 加载并启动
        let output = std::process::Command::new("launchctl")
            .args(["load", &plist_path.to_string_lossy()])
            .output()
            .map_err(|e| format!("Failed to run launchctl: {}", e))?;
        if !output.status.success() {
            return Err(format!("launchctl load failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 作为后台进程启动
        let cli_path = crate::sandbox::bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs");
        std::process::Command::new("node")
            .arg(cli_path)
            .arg("gateway")
            .env("CJGCLAW_DIR", crate::sandbox::cjgclaw_dir().to_string_lossy().as_ref())
            .env("CJGCLAW", "1")
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start Gateway: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: 直接启动
        let cli_path = crate::sandbox::bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs");
        std::process::Command::new("node")
            .arg(cli_path)
            .arg("gateway")
            .env("CJGCLAW_DIR", crate::sandbox::cjgclaw_dir().to_string_lossy().as_ref())
            .env("CJGCLAW", "1")
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start Gateway: {}", e))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Err("Unsupported platform for gateway_start".to_string());
    }

    // 等待启动并检查（带重试）
    let pid = wait_for_port(port, 5);

    Ok(GatewayStatus {
        running: pid.is_some(),
        port,
        pid,
        message: if pid.is_some() {
            format!("Gateway started on port {}", port)
        } else {
            "Gateway start initiated, but status check pending".to_string()
        },
    })
}

/// 停止 Gateway
#[command]
pub fn gateway_stop() -> Result<GatewayStatus, String> {
    let port = gateway_port();
    let pid = find_pid_by_port(port);

    if pid.is_none() {
        return Ok(GatewayStatus {
            running: false,
            port,
            pid: None,
            message: format!("Gateway is not running on port {}", port),
        });
    }

    let pid = pid.unwrap();

    #[cfg(target_os = "macos")]
    {
        // 尝试 launchctl
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", "gui/self/com.cjgclaw.gateway"])
            .output();

        // 如果 launchctl 失败，尝试 kill
        if find_pid_by_port(port).is_some() {
            std::process::Command::new("kill")
                .arg(pid.to_string())
                .output()
                .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("kill")
            .arg(pid.to_string())
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Err("Unsupported platform for gateway_stop".to_string());
    }

    // 等待停止（同步等待）
    std::thread::sleep(Duration::from_secs(1));

    Ok(GatewayStatus {
        running: false,
        port,
        pid: None,
        message: format!("Gateway stopped (was PID: {})", pid),
    })
}

/// 重启 Gateway
#[command]
pub fn gateway_restart() -> Result<GatewayStatus, String> {
    // 停止
    gateway_stop()?;

    // 等待（同步等待）
    std::thread::sleep(Duration::from_secs(1));

    // 启动
    gateway_start()
}

/// 发送重载信号给 Gateway
#[command]
pub fn gateway_reload() -> Result<GatewayStatus, String> {
    let port = gateway_port();
    let pid = find_pid_by_port(port);

    if pid.is_none() {
        return Err(format!("Gateway is not running on port {}", port));
    }

    let pid = pid.unwrap();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("kill")
            .args(["-HUP", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to send HUP to {}: {}", pid, e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("kill")
            .args(["-HUP", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to send HUP to {}: {}", pid, e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Windows 不支持 SIGHUP，使用特定的重载机制
        return Err("SIGHUP not supported on Windows. Use gateway_restart() instead.".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Err("Unsupported platform for gateway_reload".to_string());
    }

    Ok(GatewayStatus {
        running: true,
        port,
        pid: Some(pid),
        message: format!("Gateway reload signal sent to PID {}", pid),
    })
}
