/// 设备密钥管理 + Gateway connect 握手签名
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;

const DEVICE_KEY_FILE: &str = "clawpanel-device-key.json";
const SCOPES: &[&str] = &[
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
    "operator.read",
    "operator.write",
];

/// 获取或生成设备密钥
pub(crate) fn get_or_create_key() -> Result<(String, String, SigningKey), String> {
    let dir = super::openclaw_dir();
    let path = dir.join(DEVICE_KEY_FILE);

    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取设备密钥失败: {e}"))?;
        let json: Value =
            serde_json::from_str(&content).map_err(|e| format!("解析设备密钥失败: {e}"))?;

        let device_id = json["deviceId"].as_str().unwrap_or("").to_string();
        let pub_b64 = json["publicKey"].as_str().unwrap_or("").to_string();
        let secret_hex = json["secretKey"].as_str().unwrap_or("");

        let secret_bytes = hex::decode(secret_hex).map_err(|e| format!("解码密钥失败: {e}"))?;
        if secret_bytes.len() != 32 {
            return Err("密钥长度错误".into());
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&secret_bytes);
        let signing_key = SigningKey::from_bytes(&key_bytes);

        return Ok((device_id, pub_b64, signing_key));
    }

    // 生成新密钥
    let mut rng = rand::thread_rng();
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key: VerifyingKey = (&signing_key).into();
    let pub_bytes = verifying_key.to_bytes();

    let device_id = {
        let mut hasher = Sha256::new();
        hasher.update(pub_bytes);
        hex::encode(hasher.finalize())
    };
    let pub_b64 = base64_url_encode(&pub_bytes);
    let secret_hex = hex::encode(signing_key.to_bytes());

    let json = serde_json::json!({
        "deviceId": device_id,
        "publicKey": pub_b64,
        "secretKey": secret_hex,
    });

    let _ = fs::create_dir_all(&dir);
    fs::write(&path, serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| format!("保存设备密钥失败: {e}"))?;

    Ok((device_id, pub_b64, signing_key))
}

/// base64url 编码（无 padding）
fn base64_url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// hex 编码（ed25519_dalek 不自带 hex）
mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        data.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
    pub fn decode(s: &str) -> Result<Vec<u8>, String> {
        if !s.len().is_multiple_of(2) {
            return Err("奇数长度".into());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
            .collect()
    }
}

/// 生成 Gateway connect 帧（含 Ed25519 签名）
/// gateway_token: token 模式认证凭据（可为空）
/// gateway_password: password 模式认证凭据（可为空，新增）
#[tauri::command]
pub fn create_connect_frame(
    nonce: String,
    gateway_token: String,
    gateway_password: Option<String>,
) -> Result<Value, String> {
    let (device_id, pub_b64, signing_key) = get_or_create_key()?;
    let signed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    let platform = std::env::consts::OS; // "windows" | "macos" | "linux"
    let device_family = "desktop";

    // v3 签名 payload 中 token 字段：优先 token，其次 password，最后空串
    let auth_secret = if !gateway_token.is_empty() {
        &gateway_token
    } else {
        gateway_password.as_deref().unwrap_or("")
    };

    let scopes_str = SCOPES.join(",");
    // v3 格式：v3|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce|platform|deviceFamily
    // 使用 openclaw-control-ui + ui 模式，使 Gateway 识别为 Control UI 客户端，
    // 本地连接时触发静默自动配对（shouldAllowSilentLocalPairing = true）。
    //
    // ⚠️ 注意：这里的 `v3|` 前缀是 **device signature payload 字符串的 schema 版本**，
    // 与下面 `params.minProtocol/maxProtocol` 协商的 **Gateway WebSocket 握手帧协议版本**
    // （v3 / v4）是两套独立的版本号。即使在 v4 握手协议下，签名 payload 仍以 `v3|` 开头。
    // 详见 src/lib/feature-catalog.js KERNEL_TARGET 注释。
    let payload_str = format!(
        "v3|{device_id}|openclaw-control-ui|ui|operator|{scopes_str}|{signed_at}|{auth_secret}|{nonce}|{platform}|{device_family}"
    );

    let signature = signing_key.sign(payload_str.as_bytes());
    let sig_b64 = base64_url_encode(&signature.to_bytes());

    // 构建 auth 对象：根据有无 token/password 选择填充字段
    let password = gateway_password.unwrap_or_default();
    let auth = if !gateway_token.is_empty() {
        serde_json::json!({ "token": gateway_token })
    } else if !password.is_empty() {
        serde_json::json!({ "password": password })
    } else {
        serde_json::json!({})
    };

    let frame = serde_json::json!({
        "type": "req",
        "id": format!("connect-{:08x}-{:04x}", signed_at as u32, rand::random::<u16>()),
        "method": "connect",
        "params": {
            // 协议握手范围声明：下限 3 用于继续兼容历史内核，上限 4 启用新版增量 delta 协议。
            "minProtocol": 3,
            "maxProtocol": 4,
            "client": {
                "id": "openclaw-control-ui",
                "version": env!("CARGO_PKG_VERSION"),
                "platform": platform,
                "deviceFamily": device_family,
                "mode": "ui"
            },
            "role": "operator",
            "scopes": SCOPES,
            "caps": ["tool-events"],
            "auth": auth,
            "device": {
                "id": device_id,
                "publicKey": pub_b64,
                "signedAt": signed_at as u64,
                "nonce": nonce,
                "signature": sig_b64,
            },
            "locale": "zh-CN",
            "userAgent": format!("ClawPanel/{}", env!("CARGO_PKG_VERSION")),
        }
    });

    Ok(frame)
}
