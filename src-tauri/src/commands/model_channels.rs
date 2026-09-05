//! 统一模型渠道（Model Channels）
//!
//! 用户只维护一份「渠道 = Base URL + API Key + 可用模型列表」配置，
//! 由前端组合现有命令（write_openclaw_config / hermes_env_set /
//! hermes_model_config_save / DeepSeek Harness 回环 RPC / localStorage）显式同步到
//! OpenClaw、Hermes、DeepSeek Harness 与晴辰助手。
//!
//! 本模块只负责渠道存储：
//! - 读取接口对 API Key 永远只返回掩码（apiKeySaved + apiKeyMask）；
//! - 写入支持 `__KEEP__` / 空值哨兵保留旧 Key（与创作中心一致）；
//! - 明文 Key 仅由后端同步命令或 reveal_model_channel_key 按渠道单独取出
//!   （先例：hermes_env_reveal），不会进入 Harness 的前端命令参数。
//!
//! 存储位置：openclaw_dir/clawpanel/model-channels.json —— 跟随 OpenClaw
//! 数据目录，便携迁移整体复制后自动生效（与媒体数据同一决策）。

use serde_json::{json, Value};
use std::path::PathBuf;

const CHANNELS_FILE: &str = "model-channels.json";
/// 渠道数量上限：防呆，不是产品限制
const MAX_CHANNELS: usize = 100;

fn channels_path() -> PathBuf {
    super::openclaw_dir().join("clawpanel").join(CHANNELS_FILE)
}

fn default_channels_doc() -> Value {
    json!({ "version": 2, "channels": [], "syncState": {} })
}

fn str_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn is_keep_sentinel(key: &str) -> bool {
    key.is_empty() || key == "__KEEP__" || key == "••••••••" || key == "********"
}

fn normalize_api_type(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => "openai-completions".into(),
        "openai-codex-responses" => "openai-chatgpt-responses".into(),
        "google-gemini" | "gemini" | "google" => "google-generative-ai".into(),
        "anthropic" => "anthropic-messages".into(),
        "openai" | "openai-chat" => "openai-completions".into(),
        other => other.to_string(),
    }
}

/// 归一化单个模型条目，并保留 OpenClaw 的能力、成本和兼容性元数据。
fn normalize_model_entry(entry: &Value) -> Option<Value> {
    if let Some(id) = entry.as_str() {
        let id = id.trim();
        if id.is_empty() {
            return None;
        }
        return Some(json!({ "id": id }));
    }
    let id = str_of(entry, "id");
    if id.is_empty() {
        return None;
    }
    let mut out = entry.as_object()?.clone();
    out.insert("id".into(), Value::String(id));
    let name = str_of(entry, "name");
    if !name.is_empty() {
        out.insert("name".into(), Value::String(name));
    } else {
        out.remove("name");
    }
    for key in ["contextWindow", "contextTokens", "maxTokens"] {
        match entry
            .get(key)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            Some(value) => {
                out.insert(key.into(), Value::Number(value.into()));
            }
            None => {
                out.remove(key);
            }
        }
    }
    if let Some(api) = entry.get("api").and_then(Value::as_str) {
        out.insert("api".into(), Value::String(normalize_api_type(api)));
    }
    Some(Value::Object(out))
}

fn normalize_api_key_ref(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    if str_of(&Value::Object(value.clone()), "source").is_empty()
        || str_of(&Value::Object(value.clone()), "id").is_empty()
    {
        return None;
    }
    Some(Value::Object(value.clone()))
}

/// 归一化单个渠道；current 为同 id 的旧渠道（用于保留旧 Key）。
/// 返回 None 表示条目非法（缺 id/名称），直接丢弃。
fn normalize_channel(entry: &Value, current: Option<&Value>) -> Option<Value> {
    let id = str_of(entry, "id");
    let name = str_of(entry, "name");
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let base_url = str_of(entry, "baseUrl").trim_end_matches('/').to_string();
    if !(base_url.is_empty() || base_url.starts_with("https://") || base_url.starts_with("http://"))
    {
        return None;
    }

    let incoming_key = str_of(entry, "apiKey");
    let keep_key = is_keep_sentinel(&incoming_key);
    let current_key = current.map(|c| str_of(c, "apiKey")).unwrap_or_default();
    let api_key = if keep_key {
        current_key.clone()
    } else {
        incoming_key
    };
    let incoming_ref = normalize_api_key_ref(entry.get("apiKeyRef"));
    let current_ref = normalize_api_key_ref(current.and_then(|value| value.get("apiKeyRef")));
    let api_key_ref = if keep_key {
        incoming_ref.or_else(|| current_ref.clone())
    } else {
        None
    };
    let stored_version = entry
        .get("credentialVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let current_version = current
        .and_then(|value| value.get("credentialVersion"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| u64::from(!current_key.is_empty()));
    let credential_version = if current.is_some() {
        if (!keep_key && api_key != current_key) || api_key_ref != current_ref {
            current_version.saturating_add(1)
        } else {
            current_version
        }
    } else {
        stored_version.max(u64::from(!api_key.is_empty() || api_key_ref.is_some()))
    };

    let mut models: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(arr) = entry.get("models").and_then(Value::as_array) {
        for item in arr {
            if let Some(model) = normalize_model_entry(item) {
                let model_id = str_of(&model, "id");
                if seen.insert(model_id) {
                    models.push(model);
                }
            }
        }
    }

    let default_model = str_of(entry, "defaultModel");
    let default_model =
        if !default_model.is_empty() && models.iter().any(|m| str_of(m, "id") == default_model) {
            default_model
        } else {
            // 默认模型必须在列表内；否则取第一个
            models.first().map(|m| str_of(m, "id")).unwrap_or_default()
        };

    let api_type = normalize_api_type(&str_of(entry, "apiType"));
    let mut provider_config = entry
        .get("providerConfig")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for managed in ["baseUrl", "api", "apiKey", "models"] {
        provider_config.remove(managed);
    }

    let mut normalized = json!({
        "id": id,
        "name": name,
        "presetKey": str_of(entry, "presetKey"),
        "baseUrl": base_url,
        "apiType": api_type,
        "apiKey": api_key,
        "credentialVersion": credential_version,
        "providerConfig": provider_config,
        "models": models,
        "defaultModel": default_model,
        "enabled": entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "updatedAt": str_of(entry, "updatedAt"),
    });
    if let Some(api_key_ref) = api_key_ref {
        normalized["apiKeyRef"] = api_key_ref;
    }
    Some(normalized)
}

/// 归一化整个文档；current 提供旧文档以支持保留旧 Key
fn normalize_channels_doc(config: &Value, current: Option<&Value>) -> Value {
    let empty = Vec::new();
    let current_channels = current
        .and_then(|c| c.get("channels"))
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let find_current = |id: &str| current_channels.iter().find(|c| str_of(c, "id") == id);

    let mut channels = Vec::new();
    if let Some(arr) = config.get("channels").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        for entry in arr.iter().take(MAX_CHANNELS) {
            let id = str_of(entry, "id");
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(ch) = normalize_channel(entry, find_current(&id)) {
                channels.push(ch);
            }
        }
    }

    let sync_state = config
        .get("syncState")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    json!({ "version": 2, "channels": channels, "syncState": sync_state })
}

fn read_channels_private() -> Value {
    let parsed = super::read_json_file_content(&channels_path())
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(default_channels_doc);
    normalize_channels_doc(&parsed, None)
}

/// 供同一后端内的同步命令读取单个完整渠道；不得直接暴露给前端。
pub(super) fn read_model_channel_private(channel_id: &str) -> Result<Value, String> {
    let id = channel_id.trim();
    let doc = read_channels_private();
    doc.get("channels")
        .and_then(Value::as_array)
        .and_then(|channels| channels.iter().find(|channel| str_of(channel, "id") == id))
        .cloned()
        .ok_or_else(|| format!("模型渠道不存在: {channel_id}"))
}

/// 对外读取：API Key 只回掩码
fn sanitize_doc_for_read(doc: &Value) -> Value {
    let mut out = doc.clone();
    if let Some(channels) = out.get_mut("channels").and_then(Value::as_array_mut) {
        for channel in channels {
            if let Some(obj) = channel.as_object_mut() {
                let api_key = obj
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let has_api_key_ref = normalize_api_key_ref(obj.get("apiKeyRef")).is_some();
                obj.insert("apiKey".into(), Value::String(String::new()));
                obj.insert(
                    "apiKeySaved".into(),
                    Value::Bool(!api_key.trim().is_empty() || has_api_key_ref),
                );
                obj.insert(
                    "apiKeyMask".into(),
                    Value::String(if has_api_key_ref {
                        "SecretRef".into()
                    } else {
                        super::media::api_key_mask(&api_key)
                    }),
                );
            }
        }
    }
    out
}

#[tauri::command]
pub fn read_model_channels() -> Result<Value, String> {
    Ok(sanitize_doc_for_read(&read_channels_private()))
}

#[tauri::command]
pub fn write_model_channels(config: Value) -> Result<Value, String> {
    let current = read_channels_private();
    let normalized = normalize_channels_doc(&config, Some(&current));
    let path = channels_path();
    if path.exists() {
        let backup = path.with_extension("json.bak");
        std::fs::copy(&path, &backup).map_err(|e| format!("备份模型渠道配置失败: {e}"))?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&backup)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("同步模型渠道备份失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("设置模型渠道备份权限失败: {e}"))?;
        }
    }
    super::media::write_json_atomic(&path, &normalized)?;
    Ok(sanitize_doc_for_read(&normalized))
}

/// 明文 Key 仅在同步 / 助手拷贝时按渠道取出，不进入常规读取链路
#[tauri::command]
pub fn reveal_model_channel_key(channel_id: String) -> Result<String, String> {
    let channel = read_model_channel_private(&channel_id)?;
    if normalize_api_key_ref(channel.get("apiKeyRef")).is_some() {
        return Err("该渠道使用 OpenClaw SecretRef，只能原样同步到 OpenClaw".into());
    }
    Ok(str_of(&channel, "apiKey"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_channel(id: &str, key: &str) -> Value {
        json!({
            "id": id,
            "name": "测试渠道",
            "presetKey": "openai",
            "baseUrl": "https://api.openai.com/v1/",
            "apiType": "openai-completions",
            "apiKey": key,
            "models": ["gpt-4o", { "id": "gpt-4o-mini", "name": "Mini" }, "", "gpt-4o"],
            "defaultModel": "gpt-4o-mini"
        })
    }

    #[test]
    fn normalize_trims_and_dedups_models() {
        let doc = normalize_channels_doc(
            &json!({ "channels": [sample_channel("ch-1", "sk-abcdefgh1234")] }),
            None,
        );
        let ch = &doc["channels"][0];
        assert_eq!(ch["baseUrl"], "https://api.openai.com/v1");
        let models = ch["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "gpt-4o");
        assert_eq!(models[1]["name"], "Mini");
        // 默认模型在列表内则保留
        assert_eq!(ch["defaultModel"], "gpt-4o-mini");
        assert_eq!(ch["enabled"], true);
    }

    #[test]
    fn keep_sentinel_preserves_old_key() {
        let current = normalize_channels_doc(
            &json!({ "channels": [sample_channel("ch-1", "sk-real-key-123")] }),
            None,
        );
        for sentinel in ["", "__KEEP__", "••••••••", "********"] {
            let incoming = json!({ "channels": [sample_channel("ch-1", sentinel)] });
            let merged = normalize_channels_doc(&incoming, Some(&current));
            assert_eq!(
                merged["channels"][0]["apiKey"], "sk-real-key-123",
                "sentinel {sentinel:?} 应保留旧 Key"
            );
        }
        // 新 Key 覆盖旧 Key
        let incoming = json!({ "channels": [sample_channel("ch-1", "sk-new")] });
        let merged = normalize_channels_doc(&incoming, Some(&current));
        assert_eq!(merged["channels"][0]["apiKey"], "sk-new");
    }

    #[test]
    fn read_sanitization_masks_key() {
        let doc = normalize_channels_doc(
            &json!({ "channels": [sample_channel("ch-1", "sk-abcdefgh1234")] }),
            None,
        );
        let public = sanitize_doc_for_read(&doc);
        let ch = &public["channels"][0];
        assert_eq!(ch["apiKey"], "");
        assert_eq!(ch["apiKeySaved"], true);
        assert_eq!(ch["apiKeyMask"], "sk-***1234");
    }

    #[test]
    fn invalid_entries_are_dropped() {
        let doc = normalize_channels_doc(
            &json!({ "channels": [
                { "name": "缺 id" },
                { "id": "ch-2", "name": "" },
                { "id": "ch-3", "name": "非法地址", "baseUrl": "ftp://x" },
                sample_channel("ch-4", "k"),
                sample_channel("ch-4", "k2")
            ] }),
            None,
        );
        let channels = doc["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 1, "只有合法且未重复的渠道保留");
        assert_eq!(channels[0]["id"], "ch-4");
    }

    #[test]
    fn default_model_falls_back_to_first() {
        let mut entry = sample_channel("ch-1", "k");
        entry["defaultModel"] = json!("not-in-list");
        let doc = normalize_channels_doc(&json!({ "channels": [entry] }), None);
        assert_eq!(doc["channels"][0]["defaultModel"], "gpt-4o");
    }

    #[test]
    fn rich_model_metadata_survives_normalization() {
        let mut entry = sample_channel("ch-rich", "sk-rich");
        entry["models"] = json!([{
            "id": "vision",
            "name": "Vision",
            "input": ["text", "image"],
            "reasoning": true,
            "contextWindow": 200000,
            "contextTokens": 160000,
            "maxTokens": 8192,
            "compat": { "supportsDeveloperRole": false },
            "cost": { "input": 1, "output": 2 }
        }]);
        let doc = normalize_channels_doc(&json!({ "channels": [entry] }), None);
        let model = &doc["channels"][0]["models"][0];
        assert_eq!(model["input"], json!(["text", "image"]));
        assert_eq!(model["reasoning"], json!(true));
        assert_eq!(model["contextTokens"], json!(160000));
        assert_eq!(model["maxTokens"], json!(8192));
        assert_eq!(model["compat"]["supportsDeveloperRole"], json!(false));
        assert_eq!(model["cost"]["output"], json!(2));
    }

    #[test]
    fn retired_api_type_is_migrated_and_key_revision_tracks_changes() {
        let mut initial = sample_channel("ch-legacy", "sk-old-same-tail");
        initial["apiType"] = json!("openai-codex-responses");
        let current = normalize_channels_doc(&json!({ "channels": [initial] }), None);
        assert_eq!(
            current["channels"][0]["apiType"],
            json!("openai-chatgpt-responses")
        );
        assert_eq!(current["channels"][0]["credentialVersion"], json!(1));

        let kept = normalize_channels_doc(
            &json!({ "channels": [sample_channel("ch-legacy", "__KEEP__")] }),
            Some(&current),
        );
        assert_eq!(kept["channels"][0]["credentialVersion"], json!(1));

        let changed = normalize_channels_doc(
            &json!({ "channels": [sample_channel("ch-legacy", "sk-new-same-tail")] }),
            Some(&current),
        );
        assert_eq!(changed["channels"][0]["credentialVersion"], json!(2));
    }

    #[test]
    fn structured_secret_ref_survives_and_plaintext_replaces_it() {
        let secret_ref = json!({
            "source": "env",
            "provider": "default",
            "id": "OPENAI_API_KEY"
        });
        let initial = json!({
            "id": "secret-ref",
            "name": "Secret Ref",
            "baseUrl": "https://example.com/v1",
            "apiType": "openai-responses",
            "apiKey": "",
            "apiKeyRef": secret_ref,
            "models": [{ "id": "gpt-test" }]
        });
        let stored = normalize_channel(&initial, None).unwrap();
        assert_eq!(stored["apiKey"], "");
        assert_eq!(stored["apiKeyRef"], secret_ref);

        let mut replacement = stored.clone();
        replacement["apiKey"] = json!("sk-new");
        let replaced = normalize_channel(&replacement, Some(&stored)).unwrap();
        assert_eq!(replaced["apiKey"], "sk-new");
        assert!(replaced.get("apiKeyRef").is_none());
    }
}
