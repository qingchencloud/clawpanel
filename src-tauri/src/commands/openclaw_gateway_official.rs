//! 原持久Gateway的可选官方通道：配置只保存公开别名，授权经原生私有HTTP交给插件内存。
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::LazyLock, time::Duration};
use tokio::sync::Mutex;

const PROVIDER: &str = "clawpanel-official-gateway";
const PLACEHOLDER: &str = "http://127.0.0.1:1/v1";
const MARKER: &str = "clawpanel-local";
static CHANGE_LOCK: Mutex<()> = Mutex::const_new(());
static ATTACHED: LazyLock<Mutex<Option<Attachment>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone)]
struct Attachment {
    identity: Value,
    port: u16,
    auth: String,
}
impl Drop for Attachment {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.auth.zeroize();
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn root() -> PathBuf {
    super::openclaw_dir()
        .join("clawpanel")
        .join("official-gateway")
}
fn config_path() -> PathBuf {
    super::openclaw_dir().join("openclaw.json")
}
fn read_config() -> Result<(Value, String), String> {
    let bytes = std::fs::read(config_path()).map_err(|_| "official_gateway_config_unavailable")?;
    let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let value: Value =
        serde_json::from_slice(content).map_err(|_| "official_gateway_config_invalid")?;
    if !value.is_object() {
        return Err("official_gateway_config_invalid".into());
    }
    Ok((value, digest(&bytes)))
}
fn fields(args: &Value, allowed: &[&str]) -> Result<(), String> {
    if !args.is_object()
        || args
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err("invalid_platform_arguments".into());
    }
    Ok(())
}
fn object(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| "official_gateway_config_invalid".into())
}
fn child<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Value, String> {
    let map = object(value)?;
    if !map.contains_key(key) {
        map.insert(key.into(), json!({}));
    }
    let value = map.get_mut(key).unwrap();
    if !value.is_object() {
        return Err("official_gateway_config_invalid".into());
    }
    Ok(value)
}
fn registry(config: &Value) -> Map<String, Value> {
    config
        .pointer(&format!("/plugins/entries/{PROVIDER}/config/agents"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn member_agents(config: &Value, member: &str) -> Vec<String> {
    registry(config)
        .iter()
        .filter(|(_, value)| value["memberId"].as_str() == Some(member))
        .map(|(id, _)| id.clone())
        .collect()
}
fn models_match(config: &Value, status: &Value) -> bool {
    status["adapterVersion"].as_u64() == Some(8)
        && registry(config)
            .iter()
            .all(|(id, value)| status["agentModels"][id] == value["modelId"])
}
fn agent_id(member: &str) -> String {
    format!("clawpanel-official-{}", &digest(member.as_bytes())[..20])
}
fn expected(snapshot: &Value) -> Value {
    json!({"memberId":snapshot["member"]["member_id"],"epoch":snapshot["epoch"]})
}
async fn check_identity(args: &Value) -> Result<Value, String> {
    if !super::platform::engine_identity_current(&args["expected"]).await {
        return Err("platform_account_changed".into());
    }
    Ok(args["expected"].clone())
}
fn target(config: &Value) -> Result<(u16, String), String> {
    if config.pointer("/gateway/mode").and_then(Value::as_str) == Some("remote") {
        return Err("official_gateway_local_required".into());
    }
    let port = config
        .pointer("/gateway/port")
        .and_then(Value::as_u64)
        .unwrap_or(18789);
    if !(1024..=65535).contains(&port) {
        return Err("official_gateway_config_invalid".into());
    }
    let auth = match config.pointer("/gateway/auth/mode").and_then(Value::as_str) {
        Some("token") => config.pointer("/gateway/auth/token"),
        Some("password") => config.pointer("/gateway/auth/password"),
        _ => None,
    }
    .and_then(Value::as_str)
    .filter(|value| !value.is_empty() && value.len() <= 4096)
    .ok_or("official_gateway_auth_required")?;
    Ok((port as u16, auth.into()))
}
async fn control(
    port: u16,
    auth: &str,
    action: &str,
    body: Option<&Value>,
    cleanup: bool,
) -> Result<Value, String> {
    if !["status", "attach", "detach", "reconcile"].contains(&action) {
        return Err("invalid_platform_arguments".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(if cleanup { 2 } else { 15 }))
        .build()
        .map_err(|_| "official_gateway_unavailable")?;
    let url = format!("http://127.0.0.1:{port}/plugins/clawpanel-official/{action}");
    let mut request = if action == "status" {
        client.get(url)
    } else {
        client.post(url)
    };
    request = request.bearer_auth(auth);
    if let Some(body) = body {
        request = request.json(body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "official_gateway_unavailable")?;
    let code = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "official_gateway_unavailable")?
    {
        if bytes.len() + chunk.len() > 131072 {
            return Err("official_gateway_invalid_response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if code == 404 {
        return Err("official_gateway_restart_required".into());
    }
    if code == 401 || code == 403 {
        return Err("official_gateway_auth_required".into());
    }
    if code == 409 {
        return Err("official_gateway_state_changed".into());
    }
    if code != 200 {
        return Err("official_gateway_unavailable".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "official_gateway_invalid_response")?;
    if !value.is_object() {
        return Err("official_gateway_invalid_response".into());
    }
    Ok(value)
}
fn public_models(dto: &Value) -> Vec<Value> {
    dto["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| {
            model["capabilities"]["tool_calls"].is_boolean()
                && model["capabilities"]["streaming"].is_boolean()
                && model["context_tokens"].as_u64().unwrap_or(0) >= 4000
        })
        .map(|model| {
            let mut output = Map::new();
            for key in [
                "id",
                "display_name",
                "context_tokens",
                "max_output_tokens",
                "capabilities",
            ] {
                if let Some(value) = model.get(key) {
                    output.insert(key.into(), value.clone());
                }
            }
            let tools_available = model["capabilities"]["tool_calls"] == true;
            output.insert("toolsAvailable".into(), json!(tools_available));
            output.insert("textOnly".into(), json!(!tools_available));
            Value::Object(output)
        })
        .collect()
}
async fn view(models: Option<Vec<Value>>) -> Result<Value, String> {
    let snapshot = super::platform::current_public_snapshot().await?;
    let (config, hash) = read_config()?;
    let member = snapshot["member"]["member_id"].as_str().unwrap_or("");
    let agents = registry(&config);
    let current_id = agent_id(member);
    let enabled = config
        .pointer(&format!("/models/providers/{PROVIDER}/baseUrl"))
        .and_then(Value::as_str)
        == Some(PLACEHOLDER)
        && root().join("owner.json").is_file();
    let remote = if enabled {
        if let Ok((port, auth)) = target(&config) {
            control(port, &auth, "status", None, false).await.ok()
        } else {
            None
        }
    } else {
        None
    };
    let attached = remote.as_ref().is_some_and(|value| {
        value["attached"] == true
            && value["memberId"] == snapshot["member"]["member_id"]
            && value["epoch"] == snapshot["epoch"]
    }) && ATTACHED
        .lock()
        .await
        .as_ref()
        .is_some_and(|value| value.identity == expected(&snapshot));
    let port = config
        .pointer("/gateway/port")
        .and_then(Value::as_u64)
        .unwrap_or(18789) as u16;
    let running = tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .is_ok_and(|value| value.is_ok());
    let supported = super::config::installed_openclaw_version_from_files()
        .is_some_and(|value| value.starts_with("2026.7.1"));
    let current_agents = member_agents(&config, member);
    let pending_recovery = remote
        .as_ref()
        .and_then(|status| status["activeRuns"].as_array())
        .is_some_and(|runs| {
            runs.iter().any(|run| {
                run["state"] == "recovery_required"
                    && run["agentId"]
                        .as_str()
                        .is_some_and(|id| current_agents.iter().any(|owned| owned == id))
            })
        });
    let restart_required = enabled
        && remote
            .as_ref()
            .is_none_or(|status| !models_match(&config, status));
    let attached = attached && !restart_required;
    let phase = if snapshot["phase"] != "bound" {
        "account_required"
    } else if !supported {
        "unsupported"
    } else if pending_recovery {
        "recovery_required"
    } else if attached {
        "ready"
    } else if !enabled {
        "not_enabled"
    } else if restart_required {
        "restart_required"
    } else {
        "disconnected"
    };
    Ok(
        json!({"supported":supported,"enabled":enabled,"attached":attached,"phase":phase,"memberId":snapshot["member"]["member_id"],"epoch":snapshot["epoch"],"configSha256":hash,
        "providerId":PROVIDER,"agentIds":agents.keys().collect::<Vec<_>>(),"agentId":if !member.is_empty() && agents.contains_key(&current_id){Some(current_id.clone())}else{None},
        "modelId":agents.get(&current_id).and_then(|value|value.get("modelId")),"models":models.unwrap_or_default(),"gatewayRunning":running,"restartRequired":restart_required,"pendingRecovery":pending_recovery}),
    )
}
fn write_owned_plugin() -> Result<PathBuf, String> {
    let base = root();
    let owner_path = base.join("owner.json");
    let plugin = base.join("plugin");
    if base.exists() {
        let owner: Value = std::fs::read(&owner_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or("official_gateway_config_collision")?;
        if owner["schema"] != "clawpanel-official-gateway-owner-v1" {
            return Err("official_gateway_config_collision".into());
        }
        let source = std::fs::read(plugin.join("index.mjs"))
            .map_err(|_| "official_gateway_config_collision")?;
        if owner["sourceSha256"].as_str() != Some(digest(&source).as_str()) {
            return Err("official_gateway_config_collision".into());
        }
    } else {
        std::fs::create_dir_all(&base).map_err(|_| "official_gateway_storage_failed")?;
    }
    if std::fs::symlink_metadata(&base)
        .map_err(|_| "official_gateway_storage_failed")?
        .file_type()
        .is_symlink()
    {
        return Err("official_gateway_config_collision".into());
    }
    std::fs::create_dir_all(&plugin).map_err(|_| "official_gateway_storage_failed")?;
    let source = include_str!("../../../scripts/openclaw-gateway-official-plugin.mjs");
    std::fs::write(plugin.join("index.mjs"), source)
        .map_err(|_| "official_gateway_storage_failed")?;
    std::fs::write(
        plugin.join("openclaw.plugin.json"),
        include_str!("../../../scripts/openclaw-gateway-official-plugin.manifest.json"),
    )
    .map_err(|_| "official_gateway_storage_failed")?;
    std::fs::write(owner_path, serde_json::to_vec(&json!({"schema":"clawpanel-official-gateway-owner-v1","sourceSha256":digest(source.as_bytes())})).unwrap()).map_err(|_| "official_gateway_storage_failed")?;
    Ok(plugin)
}
fn prepare_workspace(id: &str) -> Result<PathBuf, String> {
    let workspace = root().join("workspaces").join(id);
    for suffix in ["", ".git/objects", ".git/refs/heads"] {
        std::fs::create_dir_all(workspace.join(suffix))
            .map_err(|_| "official_gateway_storage_failed")?;
    }
    if !workspace.join(".git/HEAD").exists() {
        std::fs::write(workspace.join(".git/HEAD"), "ref: refs/heads/main\n")
            .map_err(|_| "official_gateway_storage_failed")?;
        std::fs::write(
            workspace.join(".git/config"),
            "[core]\nrepositoryformatversion = 0\nbare = false\n",
        )
        .map_err(|_| "official_gateway_storage_failed")?;
    }
    Ok(workspace)
}
async fn enable(args: Value) -> Result<Value, String> {
    fields(&args, &["modelId", "expected", "expectedConfigSha256"])?;
    let identity = check_identity(&args).await?;
    let dto = super::platform::engine_connection("openclaw").await?;
    if identity != json!({"memberId":dto["memberId"],"epoch":dto["epoch"]}) {
        return Err("platform_account_changed".into());
    }
    let models = public_models(&dto);
    let selected = args["modelId"]
        .as_str()
        .ok_or("invalid_platform_arguments")?;
    let selected_model = models
        .iter()
        .find(|model| model["id"].as_str() == Some(selected))
        .ok_or("model_not_allowed")?;
    let text_only = selected_model["capabilities"]["tool_calls"] == false;
    let _lock = CHANGE_LOCK.lock().await;
    let (mut config, hash) = read_config()?;
    if args["expectedConfigSha256"].as_str() != Some(hash.as_str()) {
        return Err("official_gateway_config_changed".into());
    }
    if !super::config::installed_openclaw_version_from_files()
        .is_some_and(|value| value.starts_with("2026.7.1"))
    {
        return Err("official_gateway_version_unsupported".into());
    }
    target(&config)?;
    if config.pointer("/plugins/enabled") == Some(&json!(false))
        || config
            .pointer("/plugins/deny")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value == PROVIDER))
    {
        return Err("official_gateway_plugin_disabled".into());
    }
    let existing = config.pointer(&format!("/models/providers/{PROVIDER}"));
    if existing.is_some()
        && (!root().join("owner.json").is_file()
            || existing.unwrap()["baseUrl"] != PLACEHOLDER
            || existing.unwrap()["apiKey"] != MARKER)
    {
        return Err("official_gateway_config_collision".into());
    }
    if config
        .pointer(&format!("/plugins/entries/{PROVIDER}"))
        .is_some()
        && !root().join("owner.json").is_file()
    {
        return Err("official_gateway_config_collision".into());
    }
    if existing.is_some() && root().join("owner.json").is_file() {
        let (port, auth) = target(&config)?;
        match control(port, &auth, "status", None, false).await {
            Ok(status)
                if status["activeRuns"]
                    .as_array()
                    .is_some_and(|runs| !runs.is_empty()) =>
            {
                return Err("official_gateway_request_pending".into())
            }
            Err(_) if ATTACHED.lock().await.is_some() => {
                return Err("official_gateway_unavailable".into())
            }
            _ => {}
        }
    }
    let member = identity["memberId"]
        .as_str()
        .ok_or("platform_binding_required")?;
    let id = agent_id(member);
    let old_registry = registry(&config);
    let previous_text_only = old_registry
        .get(&id)
        .and_then(|old| old["modelId"].as_str())
        .and_then(|old_id| models.iter().find(|model| model["id"] == old_id))
        .is_some_and(|model| model["capabilities"]["tool_calls"] == false);
    if let Some(old) = old_registry.get(&id) {
        if old["memberId"] != member {
            return Err("official_gateway_config_collision".into());
        }
    }
    let old_agents = super::agent::list_agent_configs(&config);
    if old_agents.iter().any(|agent| agent["id"] == id) && !old_registry.contains_key(&id) {
        return Err("official_gateway_config_collision".into());
    }
    let plugin = write_owned_plugin()?;
    let workspace = prepare_workspace(&id)?;
    let providers = child(child(&mut config, "models")?, "providers")?;
    let mut stub_models = providers
        .get(PROVIDER)
        .and_then(|provider| provider["models"].as_array())
        .cloned()
        .unwrap_or_default();
    for model in &models {
        let stub = json!({"id":model["id"],"name":model["display_name"].as_str().or_else(||model["id"].as_str()),"api":"openai-completions","reasoning":false,"input":["text"],"contextWindow":model["context_tokens"],"maxTokens":model["max_output_tokens"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}});
        if let Some(old) = stub_models.iter_mut().find(|old| old["id"] == model["id"]) {
            *old = stub;
        } else {
            stub_models.push(stub);
        }
    }
    object(providers)?.insert(PROVIDER.into(),json!({"baseUrl":PLACEHOLDER,"apiKey":MARKER,"api":"openai-completions","models":stub_models}));
    let plugins = child(&mut config, "plugins")?;
    if let Some(allow) = plugins.get_mut("allow") {
        let allow = allow
            .as_array_mut()
            .ok_or("official_gateway_config_invalid")?;
        if !allow.iter().any(|value| value == PROVIDER) {
            allow.push(json!(PROVIDER));
        }
    }
    let load = child(plugins, "load")?;
    if load.get("paths").is_none() {
        object(load)?.insert("paths".into(), json!([]));
    }
    let paths = load["paths"]
        .as_array_mut()
        .ok_or("official_gateway_config_invalid")?;
    let plugin_string = plugin.to_string_lossy().to_string();
    if !paths
        .iter()
        .any(|value| value.as_str() == Some(plugin_string.as_str()))
    {
        paths.push(json!(plugin_string));
    }
    let entries = child(plugins, "entries")?;
    let entry = object(entries)?
        .entry(PROVIDER)
        .or_insert_with(|| json!({"enabled":true,"config":{"agents":{}}}));
    object(entry)?.insert("enabled".into(), json!(true));
    object(child(entry, "hooks")?)?.insert("allowConversationAccess".into(), json!(true));
    let owned_agents = child(child(entry, "config")?, "agents")?;
    object(owned_agents)?.insert(id.clone(), json!({"memberId":member,"modelId":selected}));
    // 只改本人受管Agent：文本模型正式禁用全部工具，不在transport裁剪工具。
    let text_tools = json!({"deny":["*"]});
    let tools = if text_only {
        text_tools.clone()
    } else {
        json!({"profile":"coding","alsoAllow":["message"]})
    };
    let agent = json!({"id":id,"name":"Official models","workspace":workspace,"model":{"primary":format!("{PROVIDER}/{selected}"),"fallbacks":[]},"tools":tools});
    let agents = child(&mut config, "agents")?;
    if agents.get("entries").is_some() {
        let entries = child(agents, "entries")?;
        if old_agents.is_empty() {
            object(entries)?.entry("main").or_insert_with(|| json!({}));
        }
        if let Some(old) = entries.get_mut(&id) {
            object(old)?.insert("model".into(), agent["model"].clone());
            if text_only || (previous_text_only && old["tools"] == text_tools) {
                object(old)?.insert("tools".into(), agent["tools"].clone());
            } else {
                object(old)?
                    .entry("tools")
                    .or_insert_with(|| agent["tools"].clone());
            }
        } else {
            let mut entry = agent.clone();
            object(&mut entry)?.remove("id");
            object(entries)?.insert(id.clone(), entry);
        }
    } else {
        if agents.get("list").is_none() {
            object(agents)?.insert("list".into(), json!([]));
        }
        let list = agents["list"]
            .as_array_mut()
            .ok_or("official_gateway_config_invalid")?;
        if list.is_empty() {
            list.push(json!({"id":"main","default":true}));
        }
        if let Some(old) = list.iter_mut().find(|value| value["id"] == id) {
            object(old)?.insert("model".into(), agent["model"].clone());
            if text_only || (previous_text_only && old["tools"] == text_tools) {
                object(old)?.insert("tools".into(), agent["tools"].clone());
            } else {
                object(old)?
                    .entry("tools")
                    .or_insert_with(|| agent["tools"].clone());
            }
        } else {
            list.push(agent);
        }
    }
    if !super::platform::engine_identity_current(&identity).await {
        return Err("platform_account_changed".into());
    }
    if read_config()?.1 != hash {
        return Err("official_gateway_config_changed".into());
    }
    // 专用写入只增受管别名/Agent；不运行普通provider全量同步或默认归一化。
    super::config::write_verified_json_with_backup(&config_path(), &config)
        .map_err(|_| "official_gateway_storage_failed")?;
    stop_for_identity(Some(&identity)).await;
    drop(_lock);
    view(Some(models)).await
}
async fn connect(args: Value) -> Result<Value, String> {
    fields(&args, &["expected"])?;
    let identity = check_identity(&args).await?;
    let _lock = CHANGE_LOCK.lock().await;
    let (config, _) = read_config()?;
    let member = identity["memberId"]
        .as_str()
        .ok_or("platform_binding_required")?;
    let ids = member_agents(&config, member);
    if ids.is_empty() {
        return Err("official_gateway_not_enabled".into());
    }
    let (port, auth) = target(&config)?;
    let before = control(port, &auth, "status", None, false).await?;
    if !models_match(&config, &before) {
        return Err("official_gateway_restart_required".into());
    }
    let dto = super::platform::engine_connection("openclaw").await?;
    if dto["memberId"] != identity["memberId"] || dto["epoch"] != identity["epoch"] {
        return Err("platform_account_changed".into());
    }
    let models = public_models(&dto);
    let prior = if before["attached"] == true {
        json!({"memberId":before["memberId"],"epoch":before["epoch"]})
    } else {
        Value::Null
    };
    let payload = json!({"connection":dto,"agentIds":ids,"expected":prior});
    control(port, &auth, "attach", Some(&payload), false).await?;
    let attachment = Attachment {
        identity: identity.clone(),
        port,
        auth,
    };
    if !super::platform::engine_identity_current(&identity).await {
        let _ = control(
            port,
            &attachment.auth,
            "detach",
            Some(&json!({"expected":identity})),
            true,
        )
        .await;
        return Err("platform_account_changed".into());
    }
    *ATTACHED.lock().await = Some(attachment);
    drop(_lock);
    view(Some(models)).await
}

/// 原生退出只撤去官方内存授权，不结束原Gateway或自有Key服务。
pub(crate) async fn stop_for_identity(identity: Option<&Value>) {
    let attachment = {
        let mut slot = ATTACHED.lock().await;
        if slot
            .as_ref()
            .is_some_and(|value| identity.is_none_or(|expected| expected == &value.identity))
        {
            slot.take()
        } else {
            None
        }
    };
    if let Some(value) = attachment {
        let _ = control(
            value.port,
            &value.auth,
            "detach",
            Some(&json!({"expected":value.identity})),
            true,
        )
        .await;
    }
}

async fn recover(args: Value) -> Result<Value, String> {
    fields(&args, &["expected"])?;
    let identity = check_identity(&args).await?;
    let _lock = CHANGE_LOCK.lock().await;
    let (config, _) = read_config()?;
    let member = identity["memberId"]
        .as_str()
        .ok_or("platform_binding_required")?;
    let ids = member_agents(&config, member);
    let (port, auth) = target(&config)?;
    let before = control(port, &auth, "status", None, false).await?;
    if before["memberId"] != identity["memberId"] || before["epoch"] != identity["epoch"] {
        return Err("official_gateway_state_changed".into());
    }
    let mut operations = std::collections::BTreeSet::new();
    for run in before["activeRuns"]
        .as_array()
        .ok_or("official_gateway_invalid_response")?
    {
        if run["state"] != "recovery_required"
            || !run["agentId"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|owned| owned == id))
        {
            continue;
        }
        let original = run["operationIds"]
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= 128)
            .ok_or("official_request_id_unknown")?;
        for id in original {
            operations.insert(
                id.as_str()
                    .ok_or("official_gateway_invalid_response")?
                    .to_string(),
            );
        }
    }
    let mut terminal = Vec::new();
    for id in operations {
        let value = super::platform::engine_recover_operation("openclaw", &identity, &id).await?;
        if !matches!(value["state"].as_str(), Some("settled" | "released")) {
            return view(None).await;
        }
        terminal.push(value);
    }
    if !super::platform::engine_identity_current(&identity).await {
        return Err("platform_account_changed".into());
    }
    if !terminal.is_empty() {
        control(
            port,
            &auth,
            "reconcile",
            Some(&json!({"expected":identity,"operations":terminal})),
            false,
        )
        .await?;
    }
    view(None).await
}

pub(crate) async fn call(action: &str, args: Value) -> Result<Value, String> {
    match action {
        "status" => {
            fields(&args, &[])?;
            view(None).await
        }
        "catalog" => {
            fields(&args, &["expected"])?;
            let identity = check_identity(&args).await?;
            let dto = super::platform::engine_connection("openclaw").await?;
            if !super::platform::engine_identity_current(&identity).await {
                return Err("platform_account_changed".into());
            }
            view(Some(public_models(&dto))).await
        }
        "enable" => enable(args).await,
        "connect" => connect(args).await,
        "recover" => recover(args).await,
        "disconnect" => {
            fields(&args, &["expected"])?;
            let identity = check_identity(&args).await?;
            stop_for_identity(Some(&identity)).await;
            view(None).await
        }
        _ => Err("invalid_platform_arguments".into()),
    }
}

#[tauri::command]
pub async fn openclaw_gateway_official(
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    call(&action, args.unwrap_or_else(|| json!({}))).await
}
