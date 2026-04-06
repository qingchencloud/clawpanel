//! OpenClaw CLI 调用模块。
//! 使用捆绑的绝对路径执行 OpenClaw 命令。

use crate::sandbox::bundled_openclaw_dir;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::command;

/// 返回 OpenClaw CLI 路径（供前端显示）
#[command]
pub fn openclaw_path() -> String {
    openclaw_cli_path().to_string_lossy().to_string()
}

/// 返回 OpenClaw CLI 入口点路径
fn openclaw_cli_path() -> PathBuf {
    bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs")
}

/// 执行 OpenClaw CLI 命令（同步）
/// 注入 CJGCLAW_DIR 环境变量
#[command]
pub fn openclaw_command(args: Vec<String>) -> Result<String, String> {
    let cli_path = openclaw_cli_path();

    // 检查 CLI 是否存在
    if !cli_path.exists() {
        return Err(format!(
            "OpenClaw CLI not found at: {}. Please bundle OpenClaw first.",
            cli_path.display()
        ));
    }

    let output = std::process::Command::new("node")
        .arg(cli_path)
        .args(&args)
        .env("CJGCLAW_DIR", crate::sandbox::cjgclaw_dir().to_string_lossy().as_ref())
        .env("CJGCLAW", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to execute OpenClaw: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("OpenClaw exited with {}: {}", output.status, stderr))
    }
}

/// 执行 OpenClaw CLI 命令（异步）
/// 注入 CJGCLAW_DIR 环境变量
#[command]
pub async fn openclaw_command_async(args: Vec<String>) -> Result<String, String> {
    let cli_path = openclaw_cli_path();

    // 检查 CLI 是否存在
    if !cli_path.exists() {
        return Err(format!(
            "OpenClaw CLI not found at: {}. Please bundle OpenClaw first.",
            cli_path.display()
        ));
    }

    let cjgclaw_dir = crate::sandbox::cjgclaw_dir().to_string_lossy().to_string();

    tokio::process::Command::new("node")
        .arg(cli_path)
        .args(&args)
        .env("CJGCLAW_DIR", &cjgclaw_dir)
        .env("CJGCLAW", "1")
        .output()
        .await
        .map_err(|e| format!("Failed to execute OpenClaw: {}", e))
        .and_then(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if output.status.success() {
                Ok(stdout)
            } else {
                Err(format!("OpenClaw exited with {}: {}", output.status, stderr))
            }
        })
}

/// 获取捆绑的 OpenClaw 目录路径
#[command]
pub fn bundled_openclaw_path() -> String {
    bundled_openclaw_dir().to_string_lossy().to_string()
}
