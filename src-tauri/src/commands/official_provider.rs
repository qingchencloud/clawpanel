//! 官网模型作为普通 provider 一键接入引擎配置。
//!
//! 平台凭据只保存在本机安全存储；引擎配置里只出现本机回环 baseUrl 与占位 key，
//! 真实鉴权由 `platform_gateway` 在请求时注入并自动刷新。
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use std::collections::BTreeMap;

const PROVIDER_ID: &str = "clawpanel-official";
const PROVIDER_POINTER: &str = "/models/providers/clawpanel-official";
const STATE_FILE: &str = "official-provider.json";
const SUPPORTED: &[&str] = &["openclaw"];

fn state_path() -> std::path::PathBuf {
    super::openclaw_dir().join("clawpanel").join(STATE_FILE)
}

#[derive(Default, Serialize, Deserialize)]
struct ProviderState {
    #[serde(default)]
    engines: BTreeMap<String, Entry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    epoch: u64,
    #[serde(rename = "memberId")]
    member_id: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "installedAt")]
    installed_at: String,
    #[serde(rename = "modelIds", default)]
    model_ids: Vec<String>,
}

fn load_state() -> ProviderState {
    std::fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(state: &ProviderState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| "official_provider_state_invalid")?;
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "official_provider_storage_failed")?;
    }
    std::fs::write(&path, bytes).map_err(|_| "official_provider_storage_failed".to_string())
}

/// 把平台模型目录映射成 OpenClaw provider 的 models 配置。
fn provider_value(connection: &Value) -> Result<Value, String> {
    let models = connection["models"]
        .as_array()
        .ok_or("platform_response_invalid")?;
    let mut list = Vec::new();
    for model in models {
        let Some(id) = model["id"].as_str() else {
            continue;
        };
        let context = model["context_tokens"]
            .as_u64()
            .filter(|value| *value >= 4000)
            .or(model["context_window"].as_u64())
            .unwrap_or(0);
        if context == 0 {
            continue;
        }
        let max = model["max_output_tokens"]
            .as_u64()
            .unwrap_or(2048)
            .min(8192);
        list.push(json!({
            "id": id,
            "name": model["display_name"].as_str().unwrap_or(id),
            "reasoning": false,
            "input": ["text"],
            "contextWindow": context,
            "maxTokens": max,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        }));
    }
    if list.is_empty() {
        return Err("official_model_context_missing".into());
    }
    Ok(json!({
        "baseUrl": connection["baseUrl"],
        "apiKey": connection["apiKey"],
        "api": "openai-completions",
        "models": list
    }))
}

fn write_provider(provider: Value) -> Result<(), String> {
    let mut config = super::config::load_openclaw_json()?;
    let models = config
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .ok_or("openclaw_models_invalid")?;
    models
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("openclaw_models_invalid")?
        .insert(PROVIDER_ID.into(), provider);
    super::config::save_openclaw_json(&config)
}

fn strip_provider() -> Result<(), String> {
    let mut config = super::config::load_openclaw_json()?;
    if let Some(providers) = config
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .and_then(|models| models.get_mut("providers"))
        .and_then(Value::as_object_mut)
    {
        providers.remove(PROVIDER_ID);
    }
    super::config::save_openclaw_json(&config)
}

fn installed_in_config() -> bool {
    super::config::load_openclaw_json()
        .ok()
        .and_then(|config| config.pointer(PROVIDER_POINTER).cloned())
        .is_some_and(|provider| provider["apiKey"].as_str() == Some("clawpanel-local"))
}

async fn identity_current(entry: &Entry) -> bool {
    super::platform::official_provider_identity_current(&json!({
        "epoch": entry.epoch,
        "memberId": entry.member_id
    }))
    .await
}

async fn collect(state: &ProviderState) -> Value {
    let config_installed = installed_in_config();
    let mut rows = Vec::new();
    for engine in SUPPORTED {
        let entry = state.engines.get(*engine);
        let identity_current = match entry {
            Some(entry) => identity_current(entry).await,
            None => false,
        };
        rows.push(json!({
            "engine": engine,
            "providerId": PROVIDER_ID,
            "supported": true,
            "installed": config_installed || entry.is_some(),
            "identityCurrent": identity_current,
            "baseUrl": entry.map(|entry| entry.base_url.clone()),
            "installedAt": entry.map(|entry| entry.installed_at.clone()),
            "modelIds": entry.map(|entry| entry.model_ids.clone()).unwrap_or_default(),
            "requiresRestart": config_installed
        }));
    }
    json!({"engines": rows})
}

#[tauri::command]
pub async fn official_provider_status() -> Result<Value, String> {
    let state = load_state();
    Ok(collect(&state).await)
}

#[tauri::command]
pub async fn official_provider_install(engine: String) -> Result<Value, String> {
    if !SUPPORTED.contains(&engine.as_str()) {
        return Err("unsupported_official_engine".into());
    }
    let connection = super::platform::official_provider_connection(&engine).await?;
    let provider = provider_value(&connection)?;
    let mut state = load_state();
    if !state.engines.contains_key(&engine) && installed_in_config() {
        // 配置里已有同名 provider 但不是本面板接入的，避免覆盖用户配置。
        return Err("official_provider_conflict".into());
    }
    write_provider(provider)?;
    let model_ids = connection["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    state.engines.insert(
        engine.clone(),
        Entry {
            epoch: connection["epoch"].as_u64().unwrap_or(0),
            member_id: connection["memberId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            base_url: connection["baseUrl"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            model_ids,
        },
    );
    save_state(&state)?;
    Ok(collect(&state).await)
}

#[tauri::command]
pub async fn official_provider_remove(engine: String) -> Result<Value, String> {
    let mut state = load_state();
    if state.engines.remove(&engine).is_some() || installed_in_config() {
        strip_provider()?;
    }
    save_state(&state)?;
    Ok(collect(&state).await)
}
