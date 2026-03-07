/// 设备配对命令
/// 自动向 Gateway 注册设备，跳过手动配对流程

#[tauri::command]
pub fn auto_pair_device() -> Result<String, String> {
    // 无论是否已配对，都确保 gateway.controlUi.allowedOrigins 已写入
    // 必须在最前面，避免因设备密钥不存在而跳过
    patch_gateway_origins();

    // 获取或生成设备密钥（首次安装时自动创建）
    let (device_id, public_key, _) = super::device::get_or_create_key()?;

    // 读取或创建 paired.json
    let paired_path = crate::commands::openclaw_dir()
        .join("devices")
        .join("paired.json");
    let devices_dir = crate::commands::openclaw_dir().join("devices");

    // 确保 devices 目录存在
    if !devices_dir.exists() {
        std::fs::create_dir_all(&devices_dir).map_err(|e| format!("创建 devices 目录失败: {e}"))?;
    }

    let mut paired: serde_json::Value = if paired_path.exists() {
        let content = std::fs::read_to_string(&paired_path)
            .map_err(|e| format!("读取 paired.json 失败: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("解析 paired.json 失败: {e}"))?
    } else {
        serde_json::json!({})
    };

    let os_platform = std::env::consts::OS; // "windows" | "macos" | "linux"

    // 如果已配对，档查 platform 字段是否正确；不正确则覆盖更新，
    // 避免 Gateway 因 metadata-upgrade 拒绝静默自动配对
    if let Some(existing) = paired.get_mut(&device_id) {
        let current_platform = existing
            .get("platform")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if current_platform != os_platform {
            if let Some(obj) = existing.as_object_mut() {
                obj.insert(
                    "platform".to_string(),
                    serde_json::Value::String(os_platform.to_string()),
                );
                obj.insert(
                    "deviceFamily".to_string(),
                    serde_json::Value::String("desktop".to_string()),
                );
            }
            let new_content = serde_json::to_string_pretty(&paired)
                .map_err(|e| format!("序列化 paired.json 失败: {e}"))?;
            std::fs::write(&paired_path, new_content)
                .map_err(|e| format!("更新 paired.json 失败: {e}"))?;
            return Ok("设备已配对（已修正平台字段）".into());
        }
        return Ok("设备已配对".into());
    }

    // 添加设备到配对列表
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    paired[&device_id] = serde_json::json!({
        "deviceId": device_id,
        "publicKey": public_key,
        "platform": os_platform,
        "deviceFamily": "desktop",
        "clientId": "openclaw-control-ui",
        "clientMode": "ui",
        "role": "operator",
        "roles": ["operator"],
        "scopes": [
            "operator.admin",
            "operator.approvals",
            "operator.pairing",
            "operator.read",
            "operator.write"
        ],
        "approvedScopes": [
            "operator.admin",
            "operator.approvals",
            "operator.pairing",
            "operator.read",
            "operator.write"
        ],
        "tokens": {},
        "createdAtMs": now_ms,
        "approvedAtMs": now_ms
    });

    // 写入 paired.json
    let new_content = serde_json::to_string_pretty(&paired)
        .map_err(|e| format!("序列化 paired.json 失败: {e}"))?;

    std::fs::write(&paired_path, new_content).map_err(|e| format!("写入 paired.json 失败: {e}"))?;

    Ok("设备配对成功".into())
}

/// 将 Tauri 应用的 origin 写入 gateway.controlUi.allowedOrigins
/// 避免 Gateway 因 origin not allowed 拒绝 WebSocket 握手
fn patch_gateway_origins() {
    let config_path = crate::commands::openclaw_dir().join("openclaw.json");
    if !config_path.exists() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return;
    };
    let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };

    // 仅允许 Tauri 应用 + 本地开发服务器的 origin
    let origins = serde_json::json!([
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420"
    ]);

    if let Some(obj) = config.as_object_mut() {
        let gateway = obj
            .entry("gateway")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(gw) = gateway.as_object_mut() {
            let control_ui = gw
                .entry("controlUi")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(cui) = control_ui.as_object_mut() {
                cui.insert("allowedOrigins".to_string(), origins);
            }
        }
    }

    if let Ok(new_json) = serde_json::to_string_pretty(&config) {
        let _ = std::fs::write(&config_path, new_json);
    }
}

#[tauri::command]
pub fn check_pairing_status() -> Result<bool, String> {
    // 读取设备密钥
    let device_key_path = crate::commands::openclaw_dir().join("clawpanel-device-key.json");
    if !device_key_path.exists() {
        return Ok(false);
    }

    let device_key_content =
        std::fs::read_to_string(&device_key_path).map_err(|e| format!("读取设备密钥失败: {e}"))?;

    let device_key: serde_json::Value =
        serde_json::from_str(&device_key_content).map_err(|e| format!("解析设备密钥失败: {e}"))?;

    let device_id = device_key["deviceId"].as_str().ok_or("设备 ID 不存在")?;

    // 检查 paired.json
    let paired_path = crate::commands::openclaw_dir()
        .join("devices")
        .join("paired.json");
    if !paired_path.exists() {
        return Ok(false);
    }

    let content =
        std::fs::read_to_string(&paired_path).map_err(|e| format!("读取 paired.json 失败: {e}"))?;

    let paired: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 paired.json 失败: {e}"))?;

    Ok(paired.get(device_id).is_some())
}
