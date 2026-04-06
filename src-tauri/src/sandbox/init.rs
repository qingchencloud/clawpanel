//! 沙箱初始化模块。
//! 实现设备身份密钥生成和目录结构创建。

use crate::sandbox::openclaw_config_dir;
use crate::sandbox::{cjgclaw_dir, gateway_port};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

/// 沙箱状态响应
#[derive(Debug, Serialize, Deserialize)]
pub struct SandboxStatus {
    pub initialized: bool,
    pub cjgclaw_dir: String,
    pub openclaw_dir: String,
    pub gateway_port: u16,
    pub device_id: Option<String>,
    pub version: Option<String>,
}

/// 初始化沙箱（幂等）
/// 创建目录结构、设备身份密钥、cjgclaw.json
#[command]
pub fn sandbox_init() -> Result<SandboxStatus, String> {
    let _home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let cjgclaw = cjgclaw_dir();
    let openclaw_cfg = openclaw_config_dir();

    // 创建目录结构
    let dirs_to_create: [PathBuf; 10] = [
        cjgclaw.clone(),
        cjgclaw.join("agents"),
        cjgclaw.join("memory"),
        cjgclaw.join("identity"),
        cjgclaw.join("backups"),
        cjgclaw.join("logs"),
        cjgclaw.join("cron"),
        openclaw_cfg.clone(),
        openclaw_cfg.join("extensions"),
        openclaw_cfg.join("skills"),
    ];

    for dir in &dirs_to_create {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create directory {:?}: {}", dir, e))?;
    }

    // 检查是否已初始化（通过检查 identity/keypair 文件）
    let identity_dir = cjgclaw.join("identity");
    let keypair_path = identity_dir.join("keypair");
    let device_id = if keypair_path.exists() {
        // 读取现有密钥
        let content = std::fs::read_to_string(&keypair_path)
            .map_err(|e| format!("Failed to read keypair: {}", e))?;
        let parts: Vec<&str> = content.split(':').collect();
        if parts.len() >= 2 {
            Some(parts[1].to_string())
        } else {
            None
        }
    } else {
        // 生成新的 Ed25519 密钥
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = signing_key.verifying_key();
        let keypair = format!(
            "cjgclaw:{}",
            BASE64.encode(public_key.as_bytes())
        );

        std::fs::write(&keypair_path, &keypair)
            .map_err(|e| format!("Failed to write keypair: {}", e))?;

        // 设置权限为 600（仅所有者可读写）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            std::fs::set_permissions(&keypair_path, perms)
                .map_err(|e| format!("Failed to set keypair permissions: {}", e))?;
        }

        let _ = &keypair_path;
        let pub_key = keypair.split(':').nth(1).map(|s| s.to_string());
        pub_key
    };

    // 确保 .installed 文件存在（包含版本）
    let installed_path = cjgclaw.join(".installed");
    let version_str = env!("CARGO_PKG_VERSION");
    if !installed_path.exists() {
        std::fs::write(&installed_path, version_str)
            .map_err(|e| format!("Failed to write .installed: {}", e))?;
    }

    Ok(SandboxStatus {
        initialized: true,
        cjgclaw_dir: cjgclaw.to_string_lossy().to_string(),
        openclaw_dir: openclaw_cfg.to_string_lossy().to_string(),
        gateway_port: gateway_port(),
        device_id,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
    })
}

/// 获取沙箱状态
#[command]
pub fn sandbox_status() -> Result<SandboxStatus, String> {
    let cjgclaw = cjgclaw_dir();
    let openclaw_cfg = openclaw_config_dir();

    // 检查是否已初始化
    let initialized = cjgclaw.exists() && cjgclaw.join(".installed").exists();

    // 读取设备 ID
    let device_id = std::fs::read_to_string(cjgclaw.join("identity/keypair"))
        .ok()
        .and_then(|content| {
            let parts: Vec<&str> = content.split(':').collect();
            if parts.len() >= 2 {
                Some(parts[1].to_string())
            } else {
                None
            }
        });

    // 读取版本
    let version = std::fs::read_to_string(cjgclaw.join(".installed"))
        .ok()
        .map(|v| v.trim().to_string());

    Ok(SandboxStatus {
        initialized,
        cjgclaw_dir: cjgclaw.to_string_lossy().to_string(),
        openclaw_dir: openclaw_cfg.to_string_lossy().to_string(),
        gateway_port: gateway_port(),
        device_id,
        version,
    })
}
