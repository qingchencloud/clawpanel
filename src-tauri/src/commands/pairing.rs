/// 设备配对命令
/// 自动向 Gateway 注册设备，跳过手动配对流程
use base64::Engine;

const CONTROL_UI_CLIENT_ID: &str = "openclaw-control-ui";
const CONTROL_UI_CLIENT_MODE: &str = "ui";
const CONTROL_UI_ROLE: &str = "operator";
const CONTROL_UI_DEVICE_FAMILY: &str = "desktop";
const CONTROL_UI_SCOPES: &[&str] = &[
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
    "operator.read",
    "operator.write",
];

fn scope_values() -> Vec<serde_json::Value> {
    CONTROL_UI_SCOPES
        .iter()
        .map(|scope| serde_json::Value::String((*scope).to_string()))
        .collect()
}

fn generate_pairing_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn ensure_string_field(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) -> bool {
    if obj.get(key).and_then(|v| v.as_str()) == Some(value) {
        return false;
    }
    obj.insert(
        key.to_string(),
        serde_json::Value::String(value.to_string()),
    );
    true
}

fn ensure_array_contains(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    required: &[&str],
) -> bool {
    let mut changed = false;
    let mut values: Vec<String> = obj
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    for item in required {
        if !values.iter().any(|existing| existing == item) {
            values.push((*item).to_string());
            changed = true;
        }
    }

    let normalized: Vec<serde_json::Value> = values
        .iter()
        .map(|item| serde_json::Value::String(item.clone()))
        .collect();
    if obj.get(key).and_then(|v| v.as_array()) != Some(&normalized) {
        obj.insert(key.to_string(), serde_json::Value::Array(normalized));
        changed = true;
    }

    changed
}

fn operator_token_is_usable(value: Option<&serde_json::Value>) -> bool {
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return false;
    };
    if obj
        .get("revokedAtMs")
        .map(|v| !v.is_null())
        .unwrap_or(false)
    {
        return false;
    }
    if obj.get("role").and_then(|v| v.as_str()) != Some(CONTROL_UI_ROLE) {
        return false;
    }
    if !obj
        .get("token")
        .and_then(|v| v.as_str())
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    let scopes: Vec<String> = obj
        .get("scopes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    CONTROL_UI_SCOPES
        .iter()
        .all(|scope| scopes.iter().any(|existing| existing == scope))
}

fn ensure_operator_token(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    now_ms: u64,
) -> bool {
    let tokens = obj.entry("tokens").or_insert_with(|| serde_json::json!({}));
    if !tokens.is_object() {
        *tokens = serde_json::json!({});
    }
    let Some(tokens_obj) = tokens.as_object_mut() else {
        return false;
    };

    if operator_token_is_usable(tokens_obj.get(CONTROL_UI_ROLE)) {
        return false;
    }

    let existing = tokens_obj.get(CONTROL_UI_ROLE).and_then(|v| v.as_object());
    let token = existing
        .and_then(|entry| entry.get("token"))
        .and_then(|v| v.as_str())
        .filter(|token| !token.trim().is_empty())
        .map(|token| token.to_string())
        .unwrap_or_else(generate_pairing_token);
    let created_at_ms = existing
        .and_then(|entry| entry.get("createdAtMs"))
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .unwrap_or(now_ms);

    tokens_obj.insert(
        CONTROL_UI_ROLE.to_string(),
        serde_json::json!({
            "token": token,
            "role": CONTROL_UI_ROLE,
            "scopes": scope_values(),
            "createdAtMs": created_at_ms,
            "rotatedAtMs": now_ms,
            "lastUsedAtMs": existing
                .and_then(|entry| entry.get("lastUsedAtMs"))
                .and_then(|v| v.as_u64()),
        }),
    );
    true
}

fn normalize_control_ui_pairing(
    entry: &mut serde_json::Value,
    device_id: &str,
    public_key: &str,
    platform: &str,
    now_ms: u64,
) -> bool {
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }

    let Some(obj) = entry.as_object_mut() else {
        return false;
    };

    let mut changed = false;
    changed |= ensure_string_field(obj, "deviceId", device_id);
    changed |= ensure_string_field(obj, "publicKey", public_key);
    changed |= ensure_string_field(obj, "platform", platform);
    changed |= ensure_string_field(obj, "deviceFamily", CONTROL_UI_DEVICE_FAMILY);
    changed |= ensure_string_field(obj, "clientId", CONTROL_UI_CLIENT_ID);
    changed |= ensure_string_field(obj, "clientMode", CONTROL_UI_CLIENT_MODE);
    changed |= ensure_string_field(obj, "role", CONTROL_UI_ROLE);
    changed |= ensure_array_contains(obj, "roles", &[CONTROL_UI_ROLE]);
    changed |= ensure_array_contains(obj, "scopes", CONTROL_UI_SCOPES);
    changed |= ensure_array_contains(obj, "approvedScopes", CONTROL_UI_SCOPES);

    changed |= ensure_operator_token(obj, now_ms);
    if !obj
        .get("createdAtMs")
        .and_then(|v| v.as_u64())
        .map(|v| v > 0)
        .unwrap_or(false)
    {
        obj.insert("createdAtMs".into(), serde_json::json!(now_ms));
        changed = true;
    }
    if changed
        || !obj
            .get("approvedAtMs")
            .and_then(|v| v.as_u64())
            .map(|v| v > 0)
            .unwrap_or(false)
    {
        obj.insert("approvedAtMs".into(), serde_json::json!(now_ms));
        changed = true;
    }

    changed
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

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

    let now_ms = now_ms();

    // 如果已配对，仍要补齐控制 UI 必需字段。
    // 旧版本可能只写入了 publicKey，但缺失 role/scopes/approvedScopes，
    // Gateway 会把它视为 roleFrom=<none>，从而拒绝 operator 握手。
    if let Some(existing) = paired.get_mut(&device_id) {
        if normalize_control_ui_pairing(existing, &device_id, &public_key, os_platform, now_ms) {
            let new_content = serde_json::to_string_pretty(&paired)
                .map_err(|e| format!("序列化 paired.json 失败: {e}"))?;
            std::fs::write(&paired_path, new_content)
                .map_err(|e| format!("更新 paired.json 失败: {e}"))?;
            return Ok("设备已配对（已修正权限字段）".into());
        }
        return Ok("设备已配对".into());
    }

    // 添加设备到配对列表
    paired[&device_id] = serde_json::json!({
        "deviceId": device_id,
        "publicKey": public_key,
        "platform": os_platform,
        "deviceFamily": CONTROL_UI_DEVICE_FAMILY,
        "clientId": CONTROL_UI_CLIENT_ID,
        "clientMode": CONTROL_UI_CLIENT_MODE,
        "role": CONTROL_UI_ROLE,
        "roles": [CONTROL_UI_ROLE],
        "scopes": scope_values(),
        "approvedScopes": scope_values(),
        "tokens": {
            (CONTROL_UI_ROLE): {
                "token": generate_pairing_token(),
                "role": CONTROL_UI_ROLE,
                "scopes": scope_values(),
                "createdAtMs": now_ms
            }
        },
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
    const REQUIRED: &[&str] = &[
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
    ];
    let _ = super::config::append_gateway_allowed_origins(REQUIRED);
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

async fn run_pairing_command(args: Vec<String>) -> Result<String, String> {
    let mut cmd = crate::utils::openclaw_command_async();
    cmd.args(args);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 openclaw 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    };

    if output.status.success() {
        Ok(if message.is_empty() {
            "操作完成".into()
        } else {
            message
        })
    } else {
        Err(if message.is_empty() {
            format!("命令执行失败: {}", output.status)
        } else {
            message
        })
    }
}

#[tauri::command]
pub async fn pairing_list_channel(channel: String) -> Result<String, String> {
    let channel = channel.trim();
    if channel.is_empty() {
        return Err("channel 不能为空".into());
    }
    run_pairing_command(vec!["pairing".into(), "list".into(), channel.into()]).await
}

#[tauri::command]
pub async fn pairing_approve_channel(
    channel: String,
    code: String,
    notify: bool,
) -> Result<String, String> {
    let channel = channel.trim();
    let code = code.trim();
    if channel.is_empty() {
        return Err("channel 不能为空".into());
    }
    if code.is_empty() {
        return Err("配对码不能为空".into());
    }
    let mut args = vec![
        "pairing".into(),
        "approve".into(),
        channel.into(),
        code.into(),
    ];
    if notify {
        args.push("--notify".into());
    }
    run_pairing_command(args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_existing_pairing_upgrades_missing_operator_fields() {
        let mut entry = serde_json::json!({
            "deviceId": "device-1",
            "publicKey": "old-key",
            "clientId": "openclaw-control-ui"
        });

        let changed =
            normalize_control_ui_pairing(&mut entry, "device-1", "new-key", "windows", 1234);

        assert!(changed);
        assert_eq!(entry["publicKey"], "new-key");
        assert_eq!(entry["platform"], "windows");
        assert_eq!(entry["deviceFamily"], "desktop");
        assert_eq!(entry["clientMode"], "ui");
        assert_eq!(entry["role"], "operator");
        assert_eq!(entry["roles"], serde_json::json!(["operator"]));
        assert_eq!(entry["scopes"], serde_json::json!(scope_values()));
        assert_eq!(entry["approvedScopes"], serde_json::json!(scope_values()));
        assert_eq!(entry["tokens"]["operator"]["role"], "operator");
        assert_eq!(
            entry["tokens"]["operator"]["scopes"],
            serde_json::json!(scope_values())
        );
        assert!(entry["tokens"]["operator"]["token"]
            .as_str()
            .map(|token| !token.is_empty())
            .unwrap_or(false));
        assert_eq!(entry["approvedAtMs"], serde_json::json!(1234));
    }

    #[test]
    fn normalize_existing_pairing_keeps_complete_entry_unchanged() {
        let mut entry = serde_json::json!({
            "deviceId": "device-1",
            "publicKey": "key",
            "platform": "windows",
            "deviceFamily": "desktop",
            "clientId": "openclaw-control-ui",
            "clientMode": "ui",
            "role": "operator",
            "roles": ["operator"],
            "scopes": scope_values(),
            "approvedScopes": scope_values(),
            "tokens": {
                "operator": {
                    "token": "existing-token",
                    "role": "operator",
                    "scopes": scope_values(),
                    "createdAtMs": 1
                }
            },
            "createdAtMs": 1,
            "approvedAtMs": 1
        });

        let changed = normalize_control_ui_pairing(&mut entry, "device-1", "key", "windows", 1234);

        assert!(!changed);
        assert_eq!(entry["approvedAtMs"], serde_json::json!(1));
    }
}
