//! 官方引擎隔离会话：原用户配置不写入，局部能力只经stdin传给受管进程。
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::Mutex,
};

struct Runtime {
    dto: Value,
    model: String,
    home: PathBuf,
    client: reqwest::Client,
    port: Option<u16>,
    child: Option<Child>,
    running: Option<String>,
    stopped: bool,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct Identity {
    epoch: u64,
    member: String,
}
impl Identity {
    fn parse(value: &Value) -> Result<Self, String> {
        let epoch = value["epoch"].as_u64().ok_or("invalid_expected_identity")?;
        let member = value["memberId"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("invalid_expected_identity")?
            .to_string();
        Ok(Self { epoch, member })
    }
}
#[derive(Clone)]
struct Slot {
    identity: Identity,
    runtime: Arc<Mutex<Runtime>>,
}
#[derive(Default)]
struct Registry {
    slots: HashMap<String, Slot>,
    revisions: HashMap<Identity, u64>,
    generation: u64,
    closed: bool,
}
static RUNTIMES: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn safe_status(engine: &str, runtime: &Runtime) -> Value {
    json!({"engine":engine,"connected":true,"modelId":runtime.model,"memberId":runtime.dto["memberId"],"epoch":runtime.dto["epoch"],"running":runtime.running,"textOnly":runtime.dto["textOnly"],"toolsAvailable":runtime.dto["toolsAvailable"]})
}
fn own_command(program: impl AsRef<std::ffi::OsStr>, home: &std::path::Path) -> Command {
    let mut command = Command::new(program);
    command.env_clear();
    for key in [
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "COMSPEC",
        "PATHEXT",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", super::enhanced_path())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("TEMP", home.join("tmp"))
        .env("TMP", home.join("tmp"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .current_dir(home.join("workspace"));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    command
}
fn openclaw_entry() -> Result<PathBuf, String> {
    let cli = crate::utils::resolve_openclaw_cli_path().ok_or("official_openclaw_not_installed")?;
    let path = PathBuf::from(cli);
    if path.extension().is_some_and(|ext| ext == "mjs") {
        return Ok(path);
    }
    for parent in path.ancestors().skip(1).take(4) {
        for relative in [
            "openclaw.mjs",
            "node_modules/@qingchencloud/openclaw-zh/openclaw.mjs",
            "node_modules/openclaw/openclaw.mjs",
        ] {
            let entry = parent.join(relative);
            if entry.is_file() {
                return Ok(entry);
            }
        }
    }
    Err("official_openclaw_entry_unavailable".into())
}
fn write(path: &std::path::Path, value: impl AsRef<[u8]>) -> Result<(), String> {
    std::fs::write(path, value).map_err(|_| "official_runtime_storage_failed".into())
}
async fn connection_current(_engine: &str, dto: &Value) -> Result<(), String> {
    if super::platform::engine_identity_current(dto).await {
        Ok(())
    } else {
        Err("platform_account_changed".into())
    }
}
async fn owned_runtime(engine: &str, expected: &Value) -> Result<Arc<Mutex<Runtime>>, String> {
    let identity = Identity::parse(expected)?;
    let registry = RUNTIMES.lock().await;
    let slot = registry
        .slots
        .get(engine)
        .ok_or("official_engine_not_connected")?;
    if slot.identity != identity {
        return Err("platform_account_changed".into());
    }
    Ok(slot.runtime.clone())
}
async fn stop_runtime(runtime: Arc<Mutex<Runtime>>) -> Value {
    // 取走句柄后不持Runtime锁做HTTP/wait；不会因挂住的进程阻塞其他身份。
    let (mut child, port, run, client) = {
        let mut runtime = runtime.lock().await;
        runtime.stopped = true;
        (
            runtime.child.take(),
            runtime.port,
            runtime.running.take(),
            runtime.client.clone(),
        )
    };
    if let (Some(port), Some(run)) = (port, run) {
        let _ = client
            .post(format!("http://127.0.0.1:{port}/v1/runs/{run}/stop"))
            .bearer_auth("clawpanel-owned-runtime")
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    }
    let mut graceful = true;
    let mut exited = true;
    let pid = child.as_ref().and_then(Child::id);
    if let Some(child) = child.as_mut() {
        drop(child.stdin.take());
        graceful = matches!(
            tokio::time::timeout(Duration::from_secs(8), child.wait()).await,
            Ok(Ok(_))
        );
        if !graceful {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        exited = child.try_wait().ok().flatten().is_some();
    }
    json!({"pid":pid,"exited":exited,"graceful":graceful,"onlyOwned":true})
}
/// 平台先失效身份并释放state锁后调用；Some只清旧身份，None仅正式退出清全部owned。
pub async fn stop_all_official(expected: Option<&Value>) -> Value {
    let wanted = match expected {
        Some(value) => match Identity::parse(value) {
            Ok(value) => Some(value),
            Err(_) => return json!({"stopped":0,"invalidExpected":true}),
        },
        None => None,
    };
    let owned = {
        let mut registry = RUNTIMES.lock().await;
        if let Some(identity) = wanted.as_ref() {
            *registry.revisions.entry(identity.clone()).or_default() += 1;
        } else {
            registry.generation += 1;
            registry.closed = true;
        }
        let keys: Vec<String> = registry
            .slots
            .iter()
            .filter(|(_, slot)| {
                wanted
                    .as_ref()
                    .is_none_or(|identity| identity == &slot.identity)
            })
            .map(|(engine, _)| engine.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| registry.slots.remove(&key).map(|slot| slot.runtime))
            .collect::<Vec<_>>()
    };
    let count = owned.len();
    let mut jobs = tokio::task::JoinSet::new();
    for runtime in owned {
        jobs.spawn(stop_runtime(runtime));
    }
    let mut receipts = Vec::new();
    while let Some(result) = jobs.join_next().await {
        receipts.push(result.unwrap_or_else(|_| json!({"exited":false,"onlyOwned":true})));
    }
    let complete = receipts.iter().all(|receipt| receipt["exited"] == true);
    json!({"removedRuntimes":count,"cleanupComplete":complete,"children":receipts,"onlyOwned":true})
}

#[tauri::command]
pub async fn official_engine_connect(
    engine: String,
    model_id: String,
    expected: Option<Value>,
) -> Result<Value, String> {
    if !["openclaw", "hermes"].contains(&engine.as_str()) {
        return Err("unsupported_official_engine".into());
    }
    if let Some(expected) = expected.as_ref() {
        connection_current(&engine, expected).await?;
    } else if !model_id.is_empty() {
        return Err("invalid_expected_identity".into());
    }
    let mut dto = super::platform::engine_connection(&engine).await?;
    if model_id.is_empty() {
        return Ok(
            json!({"engine":engine,"connected":false,"models":dto["models"],"memberId":dto["memberId"],"epoch":dto["epoch"]}),
        );
    }
    let model = dto["models"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .find(|model| model["id"].as_str() == Some(&model_id))
        })
        .cloned()
        .ok_or("official_model_not_allowed")?;
    if engine == "openclaw" && model["context_tokens"].as_u64().unwrap_or(0) < 4000 {
        return Err("official_engine_context_insufficient".into());
    }
    dto["modelId"] = json!(model_id);
    dto["textOnly"] = json!(model["capabilities"]["tool_calls"] != true);
    dto["toolsAvailable"] = json!(model["capabilities"]["tool_calls"] == true);
    let expected = expected.ok_or("invalid_expected_identity")?;
    let identity = Identity::parse(&expected)?;
    if identity != Identity::parse(&dto)? {
        return Err("platform_account_changed".into());
    }
    let (generation, revision) = {
        let registry = RUNTIMES.lock().await;
        if registry.closed {
            return Err("official_engine_stopping".into());
        }
        if registry.slots.contains_key(&engine) {
            return Err("official_engine_already_connected".into());
        }
        (
            registry.generation,
            *registry.revisions.get(&identity).unwrap_or(&0),
        )
    };
    // 单独目录按账号epoch隔离；原.env/default/custom/session均不复制。
    let home = super::openclaw_dir()
        .join("official-engines")
        .join(&engine)
        .join(random_id());
    for dir in [
        home.clone(),
        home.join("workspace"),
        home.join("AppData/Roaming"),
        home.join("AppData/Local"),
        home.join("tmp"),
        home.join("openclaw"),
        home.join("hermes"),
    ] {
        std::fs::create_dir_all(dir).map_err(|_| "official_runtime_storage_failed")?;
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "official_runtime_http_unavailable")?;
    let mut runtime = Runtime {
        dto,
        model: model_id,
        home,
        client,
        port: None,
        child: None,
        running: None,
        stopped: false,
    };
    let placeholder = "http://127.0.0.1:1/engine/placeholder_owned_only/v1";
    if engine == "openclaw" {
        let plugin = runtime.home.join("official-plugin");
        std::fs::create_dir_all(&plugin).map_err(|_| "official_runtime_storage_failed")?;
        write(
            &plugin.join("index.mjs"),
            include_str!("engine_openclaw_plugin.mjs"),
        )?;
        write(&plugin.join("package.json"),br#"{"name":"clawpanel-official","type":"module","openclaw":{"extensions":["./index.mjs"]}}"#)?;
        write(&plugin.join("openclaw.plugin.json"),br#"{"id":"clawpanel-official","providers":["clawpanel-official"],"configSchema":{"type":"object","additionalProperties":false,"properties":{}}}"#)?;
        write(
            &runtime.home.join("entry.mjs"),
            include_str!("engine_openclaw_entry.mjs"),
        )?;
        let context = model["context_tokens"]
            .as_u64()
            .or(model["context_window"].as_u64())
            .or(model["max_context_tokens"].as_u64())
            .unwrap_or(0);
        if context == 0 {
            return Err("official_context_limit_missing".into());
        }
        let max = model["max_output_tokens"]
            .as_u64()
            .unwrap_or(2048)
            .min(8192);
        let mut config = json!({"agents":{"defaults":{"workspace":runtime.home.join("workspace"),"model":{"primary":format!("clawpanel-official/{}",runtime.model),"fallbacks":[]},"skipBootstrap":true}},"models":{"mode":"merge","providers":{"clawpanel-official":{"baseUrl":placeholder,"apiKey":"clawpanel-local","api":"openai-completions","models":[{"id":runtime.model,"name":runtime.model,"reasoning":false,"input":["text"],"contextWindow":context,"maxTokens":max,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}},"plugins":{"allow":["clawpanel-official"],"load":{"paths":[plugin]},"entries":{"clawpanel-official":{"enabled":true}}}});
        if runtime.dto["textOnly"] == true {
            config["tools"] = json!({"deny":["*"]});
        }
        write(
            &runtime.home.join("openclaw/config.json"),
            config.to_string(),
        )?;
        openclaw_entry()?;
    } else {
        write(
            &runtime.home.join("entry.py"),
            include_str!("engine_hermes_entry.py"),
        )?;
        let config = json!({"model":{"provider":"custom","default":runtime.model,"base_url":placeholder,"api_mode":"chat_completions"},"agent":{"api_max_retries":1},"fallback_model":null});
        write(&runtime.home.join("hermes/config.yaml"), config.to_string())?;
        write(
            &runtime.home.join("hermes/.env"),
            "CUSTOM_API_KEY=clawpanel-local\nOPENAI_API_KEY=clawpanel-local\n",
        )?;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "official_runtime_port_unavailable")?;
        let port = listener
            .local_addr()
            .map_err(|_| "official_runtime_port_unavailable")?
            .port();
        drop(listener);
        let python = super::hermes::hermes_venv_python().ok_or("official_hermes_not_installed")?;
        let mut command = own_command(python, &runtime.home);
        command
            .arg(runtime.home.join("entry.py"))
            .env("HERMES_HOME", runtime.home.join("hermes"))
            .env("API_SERVER_ENABLED", "true")
            .env("API_SERVER_HOST", "127.0.0.1")
            .env("API_SERVER_PORT", port.to_string())
            .env("API_SERVER_KEY", "clawpanel-owned-runtime");
        let mut child = command
            .spawn()
            .map_err(|_| "official_runtime_start_failed")?;
        child
            .stdin
            .as_mut()
            .ok_or("official_runtime_stdin_failed")?
            .write_all(format!("{}\n", runtime.dto).as_bytes())
            .await
            .map_err(|_| "official_runtime_stdin_failed")?;
        runtime.port = Some(port);
        runtime.child = Some(child);
        let mut ready = false;
        for _ in 0..200 {
            if runtime
                .client
                .get(format!("http://127.0.0.1:{port}/health"))
                .timeout(Duration::from_secs(1))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                ready = true;
                break;
            }
            if runtime
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
                .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        if !ready {
            return Err("official_runtime_not_ready".into());
        }
    }
    connection_current(&engine, &runtime.dto).await?;
    let status = safe_status(&engine, &runtime);
    let runtime = Arc::new(Mutex::new(runtime));
    let mut registry = RUNTIMES.lock().await;
    if registry.closed
        || registry.generation != generation
        || *registry.revisions.get(&identity).unwrap_or(&0) != revision
        || registry.slots.contains_key(&engine)
    {
        drop(registry);
        stop_runtime(runtime).await;
        return Err("platform_account_changed".into());
    }
    registry.slots.insert(engine, Slot { identity, runtime });
    Ok(status)
}

#[tauri::command]
pub async fn official_engine_status(
    engine: String,
    expected: Option<Value>,
) -> Result<Value, String> {
    let slot = RUNTIMES.lock().await.slots.get(&engine).cloned();
    match slot {
        Some(slot) => {
            if let Some(expected) = expected {
                if Identity::parse(&expected)? != slot.identity {
                    return Err("platform_account_changed".into());
                }
            }
            let runtime = slot.runtime.lock().await;
            connection_current(&engine, &runtime.dto).await?;
            Ok(safe_status(&engine, &runtime))
        }
        None => Ok(json!({"engine":engine,"connected":false})),
    }
}

const ACCESS_ENGINES: [&str; 5] = ["openclaw", "hermes", "deepseek-harness", "opencode", "pi"];
static ACCESS_CHANGE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static ACCESS_MODELS: LazyLock<Mutex<HashMap<String, Value>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn installed_local(engine: &str) -> bool {
    match engine {
        "deepseek-harness" => super::deepseek_harness::official_installed_local(),
        "opencode" => super::opencode::official_installed_local(),
        "pi" => super::pi::official_installed_local(),
        "hermes" => super::hermes::official_installed_local(),
        "openclaw" => {
            // 账户页不能调用where/npm/openclaw；只检查既有代码入口。
            let mut dirs: Vec<PathBuf> =
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
            if let Some(ctx) = super::portable::portable_context() {
                dirs.push(ctx.engines_openclaw_dir.clone());
            }
            if let Some(dir) = std::env::var_os("APPDATA") {
                dirs.push(PathBuf::from(dir).join("npm"));
            }
            if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(PathBuf::from(dir).join("Programs/OpenClaw"));
            }
            for value in ["OPENCLAW_CLI_PATH", "NPM_CONFIG_PREFIX"] {
                if let Some(p) = std::env::var_os(value) {
                    dirs.push(PathBuf::from(p));
                }
            }
            dirs.iter().any(|dir| {
                dir.is_file()
                    && dir
                        .file_name()
                        .is_some_and(|name| name == "openclaw.mjs" || name == "openclaw.cmd")
                    || [
                        "openclaw.mjs",
                        "openclaw.cmd",
                        "openclaw",
                        "node_modules/@qingchencloud/openclaw-zh/openclaw.mjs",
                        "node_modules/openclaw/openclaw.mjs",
                    ]
                    .iter()
                    .any(|name| dir.join(name).is_file())
            })
        }
        _ => false,
    }
}

async fn access_status(engine: &str, expected: Option<&Value>) -> Result<Value, String> {
    let installed = installed_local(engine);
    let managed = ["deepseek-harness", "opencode", "pi"].contains(&engine);
    let mut row = json!({"engine":engine,"installed":installed,"managed":managed,"available":installed && expected.is_some(),"connected":false,"running":false,"modelId":null,"memberId":null,"epoch":null,"textOnly":null,"toolsAvailable":null});
    if let Some(expected) = expected {
        let status = match engine {
            "openclaw" | "hermes" => {
                match official_engine_status(engine.into(), Some(expected.clone())).await {
                    Ok(value) => value,
                    Err(error) if error == "platform_account_changed" => json!({"connected":false}),
                    Err(error) => return Err(error),
                }
            }
            "pi" => super::pi::official_status_existing().await?,
            _ => super::deepseek_harness::official_status_local(engine, expected)?,
        };
        if status["connected"] == true
            && status["memberId"] == expected["memberId"]
            && status["epoch"] == expected["epoch"]
        {
            row["connected"] = json!(true);
            row["memberId"] = expected["memberId"].clone();
            row["epoch"] = expected["epoch"].clone();
            row["running"] = json!(status["running"] == true || status["running"].is_string());
            for key in ["modelId", "textOnly", "toolsAvailable"] {
                row[key] = status[key].clone();
            }
            if row["modelId"].is_null() {
                if let Some(cached) = ACCESS_MODELS.lock().await.get(engine) {
                    if cached["memberId"] == expected["memberId"]
                        && cached["epoch"] == expected["epoch"]
                    {
                        for key in ["modelId", "textOnly", "toolsAvailable"] {
                            row[key] = cached[key].clone();
                        }
                    }
                }
            }
        }
    }
    Ok(row)
}

fn access_models(engine: &str, dto: &Value) -> Vec<Value> {
    dto["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| {
            (engine != "openclaw" || model["context_tokens"].as_u64().unwrap_or(0) >= 4000)
                && (!["deepseek-harness", "opencode"].contains(&engine)
                    || model["capabilities"]["streaming"].is_boolean())
        })
        .map(|model| {
            let mut model = model.clone();
            model["textOnly"] = json!(model["capabilities"]["tool_calls"] != true);
            model["toolsAvailable"] = json!(model["capabilities"]["tool_calls"] == true);
            model
        })
        .collect()
}

/// 五核显式官方接入。inventory只读本地；只有open可创建新的空官方会话。
#[tauri::command]
pub async fn official_engine_access(action: String, args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or_else(|| json!({}));
    let object = args.as_object().ok_or("invalid_official_access_args")?;
    let allowed: &[&str] = match action.as_str() {
        "inventory" => &["expected"],
        "catalog" => &["engine", "expected"],
        "connect" => &["engine", "modelId", "expected"],
        "open" => &["engine", "modelId", "expected", "newSession"],
        _ => return Err("invalid_official_access_action".into()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("invalid_official_access_args".into());
    }
    let expected = args.get("expected");
    if let Some(expected) = expected {
        if expected
            .as_object()
            .is_none_or(|o| o.len() != 2 || !o.contains_key("memberId") || !o.contains_key("epoch"))
        {
            return Err("invalid_expected_identity".into());
        }
        Identity::parse(expected)?;
        connection_current("", expected).await?;
    }
    if action == "inventory" {
        let mut rows = Vec::new();
        for engine in ACCESS_ENGINES {
            rows.push(access_status(engine, expected).await?);
        }
        if let Some(expected) = expected {
            connection_current("", expected).await?;
        }
        return Ok(
            json!({"memberId":expected.map(|v|v["memberId"].clone()),"epoch":expected.map(|v|v["epoch"].clone()),"engines":rows,"models":[]}),
        );
    }
    let expected = expected.ok_or("invalid_expected_identity")?;
    let engine = args["engine"]
        .as_str()
        .filter(|engine| ACCESS_ENGINES.contains(engine))
        .ok_or("unsupported_official_engine")?;
    if !installed_local(engine) {
        return Err("official_runtime_not_installed".into());
    }
    let _change = ACCESS_CHANGE.lock().await;
    connection_current(engine, expected).await?;
    if action == "open" && args["newSession"] != true {
        return Err("official_new_session_required".into());
    }
    if action == "catalog" {
        let dto = super::platform::engine_connection(engine).await?;
        connection_current(engine, expected).await?;
        return Ok(
            json!({"engine":engine,"memberId":expected["memberId"],"epoch":expected["epoch"],"models":access_models(engine,&dto)}),
        );
    }
    let model_id = args["modelId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or("official_model_not_allowed")?;
    let mut row = access_status(engine, Some(expected)).await?;
    if row["connected"] == true && !(engine == "pi" && row["modelId"].is_null()) {
        if row["modelId"].as_str() != Some(model_id) {
            return Err("official_engine_model_conflict".into());
        }
    } else {
        let mut dto = super::platform::engine_connection(engine).await?;
        if Identity::parse(&dto)? != Identity::parse(expected)? {
            return Err("platform_account_changed".into());
        }
        let model = access_models(engine, &dto)
            .into_iter()
            .find(|model| model["id"] == model_id)
            .ok_or("official_model_not_allowed")?;
        dto["modelId"] = json!(model_id);
        dto["textOnly"] = model["textOnly"].clone();
        dto["toolsAvailable"] = model["toolsAvailable"].clone();
        match engine {
            "openclaw" | "hermes" => {
                official_engine_connect(engine.into(), model_id.into(), Some(expected.clone()))
                    .await?;
            }
            "pi" => {
                super::pi::official_connect_selected(dto).await?;
            }
            "deepseek-harness" => {
                super::deepseek_harness::connect_official_selected("deepseek-harness", dto).await?;
            }
            "opencode" => {
                super::deepseek_harness::connect_official_selected("opencode", dto).await?;
            }
            _ => unreachable!(),
        }
        connection_current(engine, expected).await?;
        ACCESS_MODELS.lock().await.insert(engine.into(),json!({"memberId":expected["memberId"],"epoch":expected["epoch"],"modelId":model_id,"textOnly":model["textOnly"],"toolsAvailable":model["toolsAvailable"]}));
        row = access_status(engine, Some(expected)).await?;
    }
    if action == "open" {
        if row["running"] == true {
            return Err("official_engine_busy".into());
        }
        let opened = match engine {
            "pi" => super::pi::official_new_session(model_id, expected).await?,
            "deepseek-harness" => {
                super::deepseek_harness::official_new_session(
                    "deepseek-harness",
                    model_id.into(),
                    expected.clone(),
                )
                .await?
            }
            "opencode" => {
                super::deepseek_harness::official_new_session(
                    "opencode",
                    model_id.into(),
                    expected.clone(),
                )
                .await?
            }
            _ => json!({"newSession":true}),
        };
        connection_current(engine, expected).await?;
        for (key, value) in opened.as_object().ok_or("official_runtime_unavailable")? {
            row[key] = value.clone();
        }
    }
    connection_current(engine, expected).await?;
    Ok(row)
}

fn event(app: &tauri::AppHandle, engine: &str, dto: &Value, kind: &str, run_id: &str, data: Value) {
    let _=app.emit("official-engine-event",json!({"engine":engine,"memberId":dto["memberId"],"epoch":dto["epoch"],"type":kind,"runId":run_id,"data":data}));
}

#[tauri::command]
pub async fn official_engine_run(
    app: tauri::AppHandle,
    engine: String,
    input: String,
    session_id: Option<String>,
    expected: Value,
) -> Result<Value, String> {
    if input.trim().is_empty() || input.len() > 131072 {
        return Err("invalid_official_input".into());
    }
    let runtime = owned_runtime(&engine, &expected).await?;
    let mut runtime_guard = runtime.lock().await;
    connection_current(&engine, &runtime_guard.dto).await?;
    if runtime_guard.stopped {
        return Err("official_engine_stopping".into());
    }
    if runtime_guard.running.is_some() {
        return Err("official_engine_busy".into());
    }
    let run_id = random_id();
    let session = session_id.unwrap_or_else(|| format!("official-{}", random_id()));
    if session.len() > 128
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid_official_session".into());
    }
    runtime_guard.running = Some(run_id.clone());
    let dto = runtime_guard.dto.clone();
    if engine == "openclaw" {
        let mut command = own_command("node", &runtime_guard.home);
        command
            .arg(runtime_guard.home.join("entry.mjs"))
            .arg(openclaw_entry()?)
            .args([
                "agent",
                "--local",
                "--agent",
                "main",
                "--session-id",
                &session,
                "--message",
                &input,
                "--json",
            ])
            .env("OPENCLAW_STATE_DIR", runtime_guard.home.join("openclaw"))
            .env(
                "OPENCLAW_CONFIG_PATH",
                runtime_guard.home.join("openclaw/config.json"),
            )
            .env("OPENCLAW_NO_BANNER", "1")
            .stdout(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| "official_runtime_start_failed")?;
        child
            .stdin
            .as_mut()
            .ok_or("official_runtime_stdin_failed")?
            .write_all(format!("{dto}\n").as_bytes())
            .await
            .map_err(|_| "official_runtime_stdin_failed")?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or("official_runtime_stdout_failed")?;
        runtime_guard.child = Some(child);
        drop(runtime_guard);
        let run = run_id.clone();
        let engine_name = engine.clone();
        tauri::async_runtime::spawn(async move {
            let mut bytes = Vec::new();
            let result = tokio::time::timeout(
                Duration::from_secs(300),
                (&mut stdout)
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes),
            )
            .await;
            let bounded =
                result.as_ref().is_ok_and(|read| read.is_ok()) && bytes.len() <= 4 * 1024 * 1024;
            let child = runtime.lock().await.child.take();
            let success = if let Some(mut child) = child {
                if !bounded {
                    let _ = child.start_kill();
                }
                match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => bounded && status.success(),
                    _ => {
                        let _ = child.start_kill();
                        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                        false
                    }
                }
            } else {
                false
            };
            runtime.lock().await.running = None;
            if connection_current(&engine_name, &dto).await.is_err() {
                return;
            }
            let text = String::from_utf8_lossy(&bytes);
            let output = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| {
                    value["payloads"].as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                })
                .unwrap_or_default();
            if success && result.is_ok() && !output.is_empty() {
                event(
                    &app,
                    &engine_name,
                    &dto,
                    "complete",
                    &run,
                    json!({"output":output}),
                );
            } else {
                event(
                    &app,
                    &engine_name,
                    &dto,
                    "error",
                    &run,
                    json!({"code":"official_runtime_failed_recover_original"}),
                );
            }
        });
    } else {
        let port = runtime_guard.port.ok_or("official_runtime_not_ready")?;
        let client = runtime_guard.client.clone();
        drop(runtime_guard);
        let response = client
            .post(format!("http://127.0.0.1:{port}/v1/runs"))
            .bearer_auth("clawpanel-owned-runtime")
            .json(&json!({"input":input,"session_id":session}))
            .send()
            .await
            .map_err(|_| "official_runtime_unknown_recover_original")?;
        if !response.status().is_success() {
            let mut current = runtime.lock().await;
            if current.running.as_deref() == Some(&run_id) {
                current.running = None;
            }
            return Err("official_runtime_run_rejected".into());
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| "official_runtime_unknown_recover_original")?;
        let actual = body["run_id"]
            .as_str()
            .filter(|value| {
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            .ok_or("official_runtime_invalid_run")?
            .to_string();
        let mut current = runtime.lock().await;
        if current.stopped || current.running.as_deref() != Some(&run_id) {
            return Err("platform_account_changed".into());
        }
        current.running = Some(actual.clone());
        drop(current);
        let run = actual.clone();
        let engine_name = engine.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let response = client
                    .get(format!("http://127.0.0.1:{port}/v1/runs/{run}/events"))
                    .bearer_auth("clawpanel-owned-runtime")
                    .send()
                    .await
                    .map_err(|_| ())?;
                if !response.status().is_success() {
                    return Err(());
                }
                use futures_util::StreamExt;
                let mut stream = response.bytes_stream();
                let mut buffer = Vec::new();
                while let Some(chunk) = stream.next().await {
                    buffer.extend_from_slice(&chunk.map_err(|_| ())?);
                    if buffer.len() > 1048576 {
                        return Err(());
                    }
                    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                        let line =
                            String::from_utf8(buffer.drain(..=index).collect()).map_err(|_| ())?;
                        if let Some(data) = line.strip_prefix("data:") {
                            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                                // 只发送稳定的内容/状态事件，运行时原始诊断与连接信息不出native。
                                if connection_current(&engine_name, &dto).await.is_err() {
                                    return Err(());
                                }
                                let kind = value["event"].as_str().unwrap_or("");
                                if kind == "run.completed" {
                                    event(
                                        &app,
                                        &engine_name,
                                        &dto,
                                        "complete",
                                        &run,
                                        json!({"output":value["output"]}),
                                    );
                                    return Ok(());
                                }
                                if ["run.failed", "run.cancelled"].contains(&kind) {
                                    return Err(());
                                }
                                if let Some(delta) = value["delta"].as_str() {
                                    event(
                                        &app,
                                        &engine_name,
                                        &dto,
                                        "delta",
                                        &run,
                                        json!({"delta":delta}),
                                    );
                                }
                            }
                        }
                    }
                }
                Err(())
            }
            .await;
            runtime.lock().await.running = None;
            if result.is_err() && connection_current(&engine_name, &dto).await.is_ok() {
                event(
                    &app,
                    &engine_name,
                    &dto,
                    "error",
                    &run,
                    json!({"code":"official_runtime_incomplete_recover_original"}),
                );
            }
        });
        return Ok(json!({"accepted":true,"runId":actual,"engine":engine}));
    }
    Ok(json!({"accepted":true,"runId":run_id,"engine":engine}))
}

#[tauri::command]
pub async fn official_engine_disconnect(engine: String, expected: Value) -> Result<Value, String> {
    let identity = Identity::parse(&expected)?;
    let owned = {
        let mut registry = RUNTIMES.lock().await;
        if let Some(slot) = registry.slots.get(&engine) {
            if slot.identity != identity {
                return Err("platform_account_changed".into());
            }
        }
        registry.slots.remove(&engine)
    };
    if let Some(slot) = owned {
        let _ = super::platform::engine_cancel(&engine, &expected).await;
        stop_runtime(slot.runtime).await;
    }
    Ok(json!({"engine":engine,"connected":false,"billing":"query_original_operations"}))
}

#[tauri::command]
pub async fn official_engine_cancel(engine: String, expected: Value) -> Result<Value, String> {
    // 先记录官网取消意图；停止进程本身不代表消费/占款已释放。
    let runtime = owned_runtime(&engine, &expected).await?;
    let receipt = super::platform::engine_cancel(&engine, &expected).await?;
    let (port, run, client) = {
        let mut runtime = runtime.lock().await;
        if engine == "openclaw" {
            if let Some(child) = runtime.child.as_mut() {
                let _ = child.start_kill();
            }
        }
        (
            runtime.port,
            runtime.running.clone(),
            runtime.client.clone(),
        )
    };
    if let (Some(port), Some(run)) = (port, run) {
        let _ = client
            .post(format!("http://127.0.0.1:{port}/v1/runs/{run}/stop"))
            .bearer_auth("clawpanel-owned-runtime")
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    }
    Ok(receipt)
}
