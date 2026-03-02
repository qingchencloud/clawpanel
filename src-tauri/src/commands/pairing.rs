/// 设备配对命令
/// 自动向 Gateway 注册设备，跳过手动配对流程

#[tauri::command]
pub fn auto_pair_device() -> Result<String, String> {
    // 读取设备密钥
    let device_key_path = crate::commands::openclaw_dir().join("clawpanel-device-key.json");
    if !device_key_path.exists() {
        return Err("设备密钥文件不存在".into());
    }

    let device_key_content = std::fs::read_to_string(&device_key_path)
        .map_err(|e| format!("读取设备密钥失败: {e}"))?;

    let device_key: serde_json::Value = serde_json::from_str(&device_key_content)
        .map_err(|e| format!("解析设备密钥失败: {e}"))?;

    let device_id = device_key["deviceId"]
        .as_str()
        .ok_or("设备 ID 不存在")?
        .to_string();

    let public_key = device_key["publicKey"]
        .as_str()
        .ok_or("公钥不存在")?
        .to_string();

    // 读取或创建 paired.json
    let paired_path = crate::commands::openclaw_dir().join("devices").join("paired.json");
    let devices_dir = crate::commands::openclaw_dir().join("devices");

    // 确保 devices 目录存在
    if !devices_dir.exists() {
        std::fs::create_dir_all(&devices_dir)
            .map_err(|e| format!("创建 devices 目录失败: {e}"))?;
    }

    let mut paired: serde_json::Value = if paired_path.exists() {
        let content = std::fs::read_to_string(&paired_path)
            .map_err(|e| format!("读取 paired.json 失败: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("解析 paired.json 失败: {e}"))?
    } else {
        serde_json::json!({})
    };

    // 检查设备是否已配对
    if paired.get(&device_id).is_some() {
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
        "platform": "desktop",
        "clientId": "gateway-client",
        "clientMode": "backend",
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

    std::fs::write(&paired_path, new_content)
        .map_err(|e| format!("写入 paired.json 失败: {e}"))?;

    Ok("设备配对成功".into())
}

#[tauri::command]
pub fn check_pairing_status() -> Result<bool, String> {
    // 读取设备密钥
    let device_key_path = crate::commands::openclaw_dir().join("clawpanel-device-key.json");
    if !device_key_path.exists() {
        return Ok(false);
    }

    let device_key_content = std::fs::read_to_string(&device_key_path)
        .map_err(|e| format!("读取设备密钥失败: {e}"))?;

    let device_key: serde_json::Value = serde_json::from_str(&device_key_content)
        .map_err(|e| format!("解析设备密钥失败: {e}"))?;

    let device_id = device_key["deviceId"]
        .as_str()
        .ok_or("设备 ID 不存在")?;

    // 检查 paired.json
    let paired_path = crate::commands::openclaw_dir().join("devices").join("paired.json");
    if !paired_path.exists() {
        return Ok(false);
    }

    let content = std::fs::read_to_string(&paired_path)
        .map_err(|e| format!("读取 paired.json 失败: {e}"))?;

    let paired: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 paired.json 失败: {e}"))?;

    Ok(paired.get(device_id).is_some())
}
