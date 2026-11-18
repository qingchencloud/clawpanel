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
const ENGINE: &str = "openclaw";
static ACCESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_hash: Option<String>,
}

fn load_state() -> Result<ProviderState, String> {
    match std::fs::read(state_path()) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "official_provider_state_invalid".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProviderState::default()),
        Err(_) => Err("official_provider_storage_failed".into()),
    }
}

fn save_state(state: &ProviderState) -> Result<(), String> {
    let value = serde_json::to_value(state).map_err(|_| "official_provider_state_invalid")?;
    super::media::write_json_atomic(&state_path(), &value)
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

fn current_provider() -> Result<Option<Value>, String> {
    let path = super::openclaw_dir().join("openclaw.json");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("openclaw_models_invalid".into()),
    };
    let content = std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
        .map_err(|_| "openclaw_models_invalid")?;
    let config = super::config::parse_json_relaxed(content).ok_or("openclaw_models_invalid")?;
    if !config.is_object()
        || config.get("models").is_some_and(|v| !v.is_object())
        || config
            .pointer("/models/providers")
            .is_some_and(|v| !v.is_object())
    {
        return Err("openclaw_models_invalid".into());
    }
    Ok(config.pointer(PROVIDER_POINTER).cloned())
}

fn fingerprint(provider: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(provider.to_string().as_bytes()))
}

fn owns(entry: Option<&Entry>, provider: &Value) -> bool {
    let Some(entry) = entry else { return false };
    let hash = fingerprint(provider);
    if let Some(expected) = &entry.provider_hash {
        return expected == &hash || entry.previous_hash.as_ref() == Some(&hash);
    }
    // 旧接入记录没有摘要，必须匹配原端点、占位密钥和协议。
    provider["baseUrl"].as_str() == Some(&entry.base_url)
        && provider["apiKey"] == "clawpanel-local"
        && provider["api"] == "openai-completions"
}

pub(super) fn recorded_endpoint(epoch: u64, member: &str, url: &str) -> bool {
    load_state()
        .ok()
        .and_then(|mut state| state.engines.remove(ENGINE))
        .is_some_and(|entry| {
            entry.epoch == epoch && entry.member_id == member && entry.base_url == url
        })
}

pub(super) fn active_endpoint(epoch: u64, member: &str, url: &str) -> bool {
    let Ok(state) = load_state() else {
        return false;
    };
    let Some(entry) = state.engines.get(ENGINE) else {
        return false;
    };
    if entry.epoch != epoch || entry.member_id != member || entry.base_url != url {
        return false;
    }
    current_provider()
        .ok()
        .flatten()
        .is_some_and(|provider| provider["baseUrl"] == url && owns(Some(entry), &provider))
}

/// 只更新已存在的受管 Agent 注册表中的官方条目，保留其他服务商、本地模型以及运行时设置。
fn sync_agent_registries(config: &Value, value: &Value, owner: &Entry) -> Result<(), String> {
    use std::collections::BTreeSet;
    let home = super::openclaw_dir();
    let canonical_home = home
        .canonicalize()
        .map_err(|_| "official_provider_storage_failed")?;
    let mut ids = BTreeSet::from(["main"]);
    if let Some(list) = config.pointer("/agents/list").and_then(Value::as_array) {
        ids.extend(list.iter().filter_map(|agent| agent["id"].as_str()));
    }
    if let Some(entries) = config.pointer("/agents/entries").and_then(Value::as_object) {
        ids.extend(entries.keys().map(String::as_str));
    }
    let mut changes = Vec::new();
    for id in ids {
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            continue;
        }
        let path = home.join("agents").join(id).join("agent/models.json");
        let path = match path.canonicalize() {
            Ok(path) if crate::utils::path_is_inside_or_same(&path, &canonical_home) => path,
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("official_provider_storage_failed".into()),
        };
        let bytes = std::fs::read(&path).map_err(|_| "official_provider_storage_failed")?;
        let mut registry: Value =
            serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                .map_err(|_| "openclaw_models_invalid")?;
        let root = registry.as_object_mut().ok_or("openclaw_models_invalid")?;
        if value.is_null() && !root.contains_key("providers") {
            continue;
        }
        let providers = root
            .entry("providers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("openclaw_models_invalid")?;
        if let Some(existing) = providers.get(PROVIDER_ID) {
            if existing == value {
                continue;
            }
            if !owns(Some(owner), existing) {
                if value.is_null() {
                    continue;
                }
                return Err("official_provider_conflict".into());
            }
        } else if value.is_null() {
            continue;
        }
        if value.is_null() {
            providers.remove(PROVIDER_ID);
        } else {
            providers.insert(PROVIDER_ID.into(), value.clone());
        }
        changes.push((path, bytes, registry));
    }
    for (path, previous, registry) in changes {
        if std::fs::read(&path).map_err(|_| "official_provider_storage_failed")? != previous {
            return Err("official_provider_conflict".into());
        }
        super::media::write_json_atomic(&path, &registry)?;
    }
    Ok(())
}

fn write_provider(value: &Value, previous: Option<&Value>, owner: &Entry) -> Result<(), String> {
    // 配置写接口用 null 显式删除，省略服务商键会保留原配置。
    super::config::save_openclaw_json_if_unchanged(
        json!({"models":{"providers":{PROVIDER_ID:value}}}),
        Some((PROVIDER_POINTER, previous)),
        |config| sync_agent_registries(config, value, owner),
    )?;
    if current_provider()?.as_ref() != (!value.is_null()).then_some(value) {
        return Err("official_provider_write_failed".into());
    }
    Ok(())
}

fn install_connection(connection: &Value, state: &mut ProviderState) -> Result<(), String> {
    if !super::openclaw_dir().join("openclaw.json").is_file() {
        return Err("openclaw_config_missing".into());
    }
    let provider = provider_value(connection)?;
    let existing = current_provider()?;
    if existing
        .as_ref()
        .is_some_and(|item| !owns(state.engines.get(ENGINE), item))
    {
        return Err("official_provider_conflict".into());
    }
    let model_ids = provider["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|model| model["id"].as_str().map(str::to_owned))
        .collect();
    // 先保存本次允许的前后两个配置摘要，中断后可重试；其他内容永远不会取得所有权。
    let entry = Entry {
        epoch: connection["epoch"]
            .as_u64()
            .ok_or("platform_response_invalid")?,
        member_id: connection["memberId"]
            .as_str()
            .ok_or("platform_response_invalid")?
            .into(),
        base_url: connection["baseUrl"]
            .as_str()
            .ok_or("platform_response_invalid")?
            .into(),
        model_ids,
        installed_at: chrono::Utc::now().to_rfc3339(),
        provider_hash: Some(fingerprint(&provider)),
        previous_hash: existing.as_ref().map(fingerprint),
    };
    state.engines.insert(ENGINE.into(), entry);
    save_state(state)?;
    write_provider(&provider, existing.as_ref(), &state.engines[ENGINE])?;
    state.engines.get_mut(ENGINE).unwrap().previous_hash = None;
    save_state(state)
}

fn remove_connection(state: &mut ProviderState) -> Result<(), String> {
    let existing = current_provider()?;
    if existing
        .as_ref()
        .is_some_and(|value| !owns(state.engines.get(ENGINE), value))
    {
        return Err("official_provider_conflict".into());
    }
    if let Some(entry) = state.engines.get(ENGINE) {
        if super::openclaw_dir().join("openclaw.json").is_file() {
            write_provider(&Value::Null, existing.as_ref(), entry)?;
        }
    }
    if state.engines.remove(ENGINE).is_some() {
        save_state(state)?;
    }
    Ok(())
}

async fn collect(state: &ProviderState) -> Result<Value, String> {
    let entry = state.engines.get(ENGINE);
    let provider = current_provider()?;
    let installed = provider.as_ref().is_some_and(|value| owns(entry, value));
    let identity_current = match entry {
        Some(e) if installed => {
            super::platform::official_provider_identity_current(
                &json!({"epoch":e.epoch,"memberId":e.member_id}),
            )
            .await
        }
        _ => false,
    };
    // 向界面只返回展示字段，本机能力地址仅归原生代理与配置写入使用。
    Ok(json!({"engines":[{
        "engine": ENGINE, "providerId": PROVIDER_ID, "supported": true, "installed":installed,
        "configReady":super::openclaw_dir().join("openclaw.json").is_file(), "conflict": provider.is_some() && !installed, "identityCurrent": identity_current,
        "modelIds": entry.filter(|_| installed).map(|e| &e.model_ids),
    }]}))
}

#[tauri::command]
pub async fn official_provider_status() -> Result<Value, String> {
    let _guard = ACCESS.lock().await;
    collect(&load_state()?).await
}

#[tauri::command]
pub async fn official_provider_install(
    engine: String,
    expected: Option<Value>,
) -> Result<Value, String> {
    if engine != ENGINE {
        return Err("unsupported_official_engine".into());
    }
    let _guard = ACCESS.lock().await;
    let mut state = load_state()?;
    let connection = super::platform::official_provider_connection(&engine).await?;
    if expected.as_ref().is_some_and(|id| {
        id["epoch"] != connection["epoch"] || id["memberId"] != connection["memberId"]
    }) || !super::platform::official_provider_identity_current(&connection).await
    {
        return Err("platform_account_changed".into());
    }
    install_connection(&connection, &mut state)?;
    collect(&state).await
}

#[tauri::command]
pub async fn official_provider_remove(
    engine: String,
    expected: Option<Value>,
) -> Result<Value, String> {
    if engine != ENGINE {
        return Err("unsupported_official_engine".into());
    }
    let _guard = ACCESS.lock().await;
    let mut state = load_state()?;
    if let Some(expected) = expected {
        if !super::platform::official_provider_identity_current(&expected).await {
            return Err("platform_account_changed".into());
        }
    }
    remove_connection(&mut state)?;
    collect(&state).await
}

#[cfg(test)]
mod tests;
