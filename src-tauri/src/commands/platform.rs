//! 官网账户与助手专用原生入口；WebView 只可见公开状态和当次模型正文。
#[path = "platform_benefits.rs"]
mod benefits;
#[cfg(not(windows))]
#[path = "platform_browser.rs"]
mod browser;
#[path = "platform_callback_page.rs"]
mod callback_page;
#[path = "platform_gateway.rs"]
mod gateway;
#[cfg(debug_assertions)]
#[path = "platform_harness.rs"]
mod harness;
#[path = "platform_identity.rs"]
mod identity;
#[path = "platform_model.rs"]
mod model;
pub use gateway::{
    engine_cancel, engine_connection, engine_identity_current, engine_recover_operation,
};
#[path = "platform_oauth.rs"]
mod oauth;
#[path = "platform_poster.rs"]
mod poster;

use identity::{Credential, SecureStore, Transport, Vault, PLATFORM_AUD};
use p256::ecdsa::SigningKey;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, LazyLock, RwLock},
};
use tauri::Emitter;
use tokio::sync::Mutex;

type Reporter = Arc<dyn Fn(Value) + Send + Sync>;
type Browser = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    operation_id: String,
    member_id: String,
    epoch: u64,
    body_hash: String,
    request_id: Option<String>,
    state: String,
    reply_complete: bool,
    cancellation_requested: bool,
    cancel_key: String,
    #[serde(default = "assistant_runtime")]
    runtime: String,
    #[serde(default)]
    admission_rejected: bool,
    #[serde(skip)]
    body: Vec<u8>,
}

#[derive(Default)]
struct State {
    epoch: u64,
    phase: String,
    loaded: bool,
    vault: Option<Vault>,
    member: Value,
    entitlements: Value,
    trial: Value,
    wallet: Value,
    grants: Value,
    usage: Value,
    models: Value,
    binding: Value,
    connection: Value,
    pending_connection: Option<oauth::PendingConnection>,
    platform_status: Value,
    benefits: Value,
    error: Option<String>,
    updated_at: Option<String>,
    refresh_sequence: u64,
    operations: Vec<Operation>,
    model_session: Option<model::ModelCredential>,
    installation_lock: Option<std::fs::File>,
}

pub struct Platform {
    transport: Transport,
    dir: PathBuf,
    state: Mutex<State>,
    refresh_lock: Mutex<()>,
    model_lock: Mutex<()>,
    gateway: Mutex<gateway::Gateway>,
    engine_sinks: Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<Value>>>,
    reporter: RwLock<Reporter>,
    browser: RwLock<Browser>,
    #[cfg(debug_assertions)]
    harness: Mutex<harness::HarnessState>,
}

static PLATFORM: LazyLock<Result<Arc<Platform>, String>> = LazyLock::new(Platform::new);

pub fn isolated_debug_enabled() -> bool {
    identity::isolated_debug_enabled()
}

pub fn isolated_origin() -> Option<String> {
    if isolated_debug_enabled() {
        identity::origin().ok()
    } else {
        None
    }
}

/// 供受管Gateway入口读取身份；不导出安装密钥、平台凭据或模型能力。
/// 官方模型 provider 接入：只返回本机受管 baseUrl 与模型目录，不导出平台凭据。
pub async fn official_provider_connection(engine: &str) -> Result<Value, String> {
    gateway::engine_connection(engine).await
}

/// 校验 provider 记录对应的账户身份是否仍是当前账号。
pub async fn official_provider_identity_current(expected: &Value) -> bool {
    gateway::engine_identity_current(expected).await
}

/// 启动时若已有 provider 接入，按持久化端口恢复本机代理监听。
pub async fn ensure_official_proxy() {
    gateway::ensure_proxy().await
}

pub async fn current_public_snapshot() -> Result<Value, String> {
    let platform = PLATFORM.as_ref().map_err(Clone::clone)?.clone();
    platform.load(false).await?;
    Ok(platform.snapshot().await)
}

/// 只清理本进程持有的官方运行时；普通Key引擎和用户配置不在此范围。
pub(crate) async fn stop_official_runtimes(expected: Option<&Value>) {
    let _ = tokio::join!(
        super::engine_official::stop_all_official(expected),
        super::deepseek_harness::stop_all_official(expected),
        super::pi::stop_official_for_identity(expected),
        super::openclaw_gateway_official::stop_for_identity(expected),
    );
}

fn project(value: &Value, fields: &[&str]) -> Value {
    let mut map = serde_json::Map::new();
    for field in fields {
        if let Some(value) = value.get(*field) {
            map.insert((*field).to_string(), value.clone());
        }
    }
    Value::Object(map)
}

fn safe_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn assistant_runtime() -> String {
    "assistant".into()
}

fn only_args(args: &Value, fields: &[&str]) -> Result<(), String> {
    if !args.is_object()
        || args
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !fields.contains(&k.as_str()))
    {
        return Err("invalid_platform_arguments".into());
    }
    Ok(())
}

impl Platform {
    pub fn new() -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            transport: Transport::new(identity::origin()?)?,
            dir: identity::state_dir()?,
            state: Mutex::new(State {
                phase: "guest".into(),
                epoch: 1,
                ..Default::default()
            }),
            refresh_lock: Mutex::new(()),
            model_lock: Mutex::new(()),
            gateway: Mutex::new(Default::default()),
            engine_sinks: Mutex::new(Default::default()),
            reporter: RwLock::new(Arc::new(|_| {})),
            browser: RwLock::new(Arc::new(oauth::open_browser)),
            #[cfg(debug_assertions)]
            harness: Mutex::new(Default::default()),
        }))
    }

    fn store(&self) -> Result<SecureStore, String> {
        SecureStore::new(&self.transport.origin, &self.dir)
    }

    fn save_vault(&self, vault: &Vault) -> Result<(), String> {
        self.store()?.save(vault)
    }

    async fn load(self: &Arc<Self>, create: bool) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.loaded && (state.vault.is_some() || !create) && state.phase != "storage_error" {
            return Ok(());
        }
        if state.installation_lock.is_none() {
            std::fs::create_dir_all(&self.dir).map_err(|_| "platform_storage_unavailable")?;
            if self.dir.is_symlink() {
                return Err("platform_storage_unavailable".into());
            }
            let lock_path = self.dir.join(format!(
                "installation-{}.lock",
                identity::digest(&self.transport.origin)
            ));
            if lock_path.is_symlink() {
                return Err("platform_storage_unavailable".into());
            }
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(lock_path)
                .map_err(|_| "platform_storage_unavailable")?;
            // OS 文件锁跨进程持有，第二个桌面实例不可并发轮换同一 refresh family。
            file.try_lock()
                .map_err(|_| "platform_installation_in_use")?;
            state.installation_lock = Some(file);
        }
        let mut vault = self.store()?.load()?;
        if vault.is_none() && create {
            let fresh = Vault::fresh();
            self.save_vault(&fresh)?;
            vault = Some(fresh);
        }
        if let Some(vault) = vault.as_mut() {
            // 进程在 refresh 已发送后崩溃，旧凭据不可再次消费。
            if vault.refresh_pending {
                if let Some(old) = vault.credential.clone() {
                    vault.enqueue_revocation(old);
                }
                vault.credential = None;
                vault.refresh_pending = false;
                self.save_vault(vault)?;
                state.phase = "reauth_required".into();
            } else if let Some(credential) = &vault.credential {
                state.phase = if credential.device_id.is_some() {
                    "bound"
                } else {
                    "logged_in"
                }
                .into();
            }
            state.epoch = state.epoch.max(vault.epoch).saturating_add(1);
            vault.epoch = state.epoch;
            self.save_vault(vault)?;
        }
        state.operations = self.load_journal()?;
        if vault
            .as_ref()
            .and_then(|v| v.outstanding_operation.as_deref())
            .is_some_and(|id| !state.operations.iter().any(|op| op.operation_id == id))
        {
            return Err("platform_journal_unavailable".into());
        }
        state.vault = vault;
        state.loaded = true;
        Ok(())
    }

    fn journal_path(&self) -> PathBuf {
        self.dir.join(format!(
            "requests-{}.json",
            identity::digest(&self.transport.origin)
        ))
    }

    fn load_journal(&self) -> Result<Vec<Operation>, String> {
        let path = self.journal_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        if path.is_symlink() {
            return Err("platform_journal_unavailable".into());
        }
        let bytes = std::fs::read(path).map_err(|_| "platform_journal_unavailable")?;
        if bytes.len() > 1024 * 1024 {
            return Err("platform_journal_unavailable".into());
        }
        let operations: Vec<Operation> =
            serde_json::from_slice(&bytes).map_err(|_| "platform_journal_unavailable")?;
        if operations.iter().any(|op| {
            !safe_id(&op.operation_id) || op.request_id.as_deref().is_some_and(|id| !safe_id(id))
        }) {
            return Err("platform_journal_unavailable".into());
        }
        Ok(operations)
    }

    fn save_journal(&self, operations: &[Operation]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|_| "platform_journal_unavailable")?;
        if std::fs::symlink_metadata(&self.dir)
            .map_err(|_| "platform_journal_unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("platform_journal_unavailable".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "platform_journal_unavailable")?;
        }
        let path = self.journal_path();
        if path.is_symlink() {
            return Err("platform_journal_unavailable".into());
        }
        let temp = path.with_extension(format!("{}.tmp", identity::random_id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| "platform_journal_unavailable")?;
        use std::io::Write;
        let bytes = serde_json::to_vec(operations).map_err(|_| "platform_journal_unavailable")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "platform_journal_unavailable")?;
        drop(file);
        // 同目录原子覆盖；失败保留旧记录，绝不先删除最后一份未决记录。
        std::fs::rename(&temp, &path).map_err(|_| "platform_journal_unavailable")?;
        Ok(())
    }

    async fn current(&self, epoch: u64) -> Result<(), String> {
        if self.state.lock().await.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        Ok(())
    }

    async fn emit(
        &self,
        epoch: u64,
        kind: &str,
        operation_id: Option<&str>,
        request_id: Option<&str>,
        data: Value,
    ) {
        if self.current(epoch).await.is_err() {
            return;
        }
        let event = json!({"epoch":epoch,"type":kind,"operationId":operation_id,"requestId":request_id,"data":data});
        if let Some(id) = operation_id {
            let engine_request = self
                .state
                .lock()
                .await
                .operations
                .iter()
                .find(|op| op.operation_id == id)
                .is_some_and(|op| op.runtime != "assistant");
            if engine_request {
                let sink = self.engine_sinks.lock().await.get(id).cloned();
                if let Some(sink) = sink {
                    let _ = sink.send(event).await;
                }
                return;
            }
        }
        let report = self.reporter.read().unwrap().clone();
        report(event);
    }

    pub async fn snapshot(&self) -> Value {
        let state = self.state.lock().await;
        let member_id = if state.vault.as_ref().is_some_and(|v| v.credential.is_some()) {
            state
                .member
                .get("member_id")
                .and_then(Value::as_str)
                .or_else(|| state.vault.as_ref().and_then(|v| v.member_id.as_deref()))
        } else {
            None
        };
        let pending: Vec<Value> = state.operations.iter().filter(|op| Some(op.member_id.as_str()) == member_id).map(|op| json!({"operationId":op.operation_id,"requestId":op.request_id,"state":op.state,"epoch":state.epoch,"engine":op.runtime,"replyComplete":op.reply_complete,"cancellationRequested":op.cancellation_requested,"admissionRejected":op.admission_rejected,"preDispatch":op.admission_rejected})).collect();
        json!({"supported":true,"epoch":state.epoch,"phase":state.phase,"origin":self.transport.origin,
            "debugLocalOnly":isolated_debug_enabled(),"member":state.member,"entitlements":state.entitlements,"trial":state.trial,
            "wallet":state.wallet,"grants":state.grants,"usage":state.usage,"models":state.models,"binding":state.binding,"connection":state.connection,
            "platformStatus":state.platform_status,"benefits":state.benefits,"error":state.error,"updatedAt":state.updated_at,
            "revocationPending":state.vault.as_ref().is_some_and(|v|v.pending_revoke.is_some()||!v.pending_revocations.is_empty()),
            "retryAfterSeconds":state.vault.as_ref().map(|v|(v.retry_after_until-chrono::Utc::now().timestamp()).max(0)).unwrap_or(0),"pendingRequests":pending})
    }

    async fn emit_snapshot(&self) {
        let inactive = {
            let state = self.state.lock().await;
            if matches!(state.phase.as_str(), "reauth_required" | "storage_error") {
                state
                    .vault
                    .as_ref()
                    .and_then(|v| v.member_id.as_ref())
                    .map(|member| json!({"memberId":member,"epoch":state.epoch}))
            } else {
                None
            }
        };
        let snapshot = self.snapshot().await;
        self.emit(
            snapshot["epoch"].as_u64().unwrap(),
            "snapshot",
            None,
            None,
            snapshot,
        )
        .await;
        if let Some(identity) = inactive {
            stop_official_runtimes(Some(&identity)).await;
        }
    }

    async fn fail(&self, epoch: u64, error: &str) {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return;
        }
        state.error = Some(error.to_string());
        if error.starts_with("platform_storage")
            || error.starts_with("platform_journal")
            || error == "platform_key_unavailable"
        {
            state.phase = "storage_error".into();
        } else if matches!(
            state.phase.as_str(),
            "authorizing" | "binding" | "reauthorizing"
        ) {
            state.phase =
                if state.vault.as_ref().is_some_and(|v| v.credential.is_some()) {
                    if state.vault.as_ref().is_some_and(|v| {
                        v.credential.as_ref().is_some_and(|c| c.device_id.is_some())
                    }) {
                        "bound"
                    } else {
                        "logged_in"
                    }
                } else {
                    "guest"
                }
                .into();
        }
        drop(state);
        self.emit_snapshot().await;
    }

    async fn platform_credential(&self, epoch: u64) -> Result<(SigningKey, Credential), String> {
        // 全窗口/全部用途共用一把刷新锁；等待者先检查已轮换的新凭据。
        let _guard = self.refresh_lock.lock().await;
        let (key, previous) = {
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            if state.phase == "storage_error" {
                return Err("platform_storage_unavailable".into());
            }
            let vault = state.vault.as_mut().ok_or("platform_login_required")?;
            let credential = vault.credential.clone().ok_or("platform_login_required")?;
            let key = vault.key()?;
            if credential.expires_at > chrono::Utc::now().timestamp() + 30 {
                return Ok((key, credential));
            }
            vault.refresh_pending = true;
            self.save_vault(vault)?;
            (key, credential)
        };
        #[cfg(debug_assertions)]
        self.harness_remember_refresh(&previous).await;
        let result = oauth::refresh(self, &key, &previous).await;
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        let vault = state.vault.as_mut().ok_or("platform_login_required")?;
        vault.refresh_pending = false;
        match result {
            Ok(credential) => {
                vault.credential = Some(credential.clone());
                self.save_vault(vault)?;
                Ok((key, credential))
            }
            Err(_) => {
                vault.enqueue_revocation(previous);
                vault.credential = None;
                self.save_vault(vault)?;
                state.model_session = None;
                state.phase = "reauth_required".into();
                state.error = Some("platform_reauthorization_required".into());
                Err("platform_reauthorization_required".into())
            }
        }
    }

    async fn resource(
        &self,
        epoch: u64,
        method: Method,
        path: &str,
        body: &[u8],
        business_key: Option<&str>,
    ) -> Result<Value, String> {
        let response = self
            .resource_response(epoch, method, path, body, business_key)
            .await?;
        let value = identity::json_response(response).await?;
        self.current(epoch).await?;
        Ok(value)
    }

    // 图片和JSON共用凭据、nonce及401处理；图片不得被JSON解析器消费。
    async fn resource_response(
        &self,
        epoch: u64,
        method: Method,
        path: &str,
        body: &[u8],
        business_key: Option<&str>,
    ) -> Result<identity::WireResponse, String> {
        let (key, credential) = self.platform_credential(epoch).await?;
        let response = self
            .transport
            .send(
                &key,
                Some(&credential.access_token),
                PLATFORM_AUD,
                method,
                path,
                body,
                "application/json",
                business_key,
            )
            .await?;
        if response.status == 429 {
            self.capture_retry_after(epoch, &response.headers).await?;
        }
        if response.status == 401 && response.error.as_deref() == Some("invalid_token") {
            let mut state = self.state.lock().await;
            if state.epoch == epoch
                && state
                    .vault
                    .as_ref()
                    .and_then(|v| v.credential.as_ref())
                    .is_some_and(|current| {
                        current.session_id == credential.session_id
                            && current.access_token == credential.access_token
                    })
            {
                if let Some(vault) = state.vault.as_mut() {
                    vault.enqueue_revocation(credential);
                    vault.credential = None;
                    self.save_vault(vault)?;
                }
                state.model_session = None;
                state.phase = "reauth_required".into();
                state.error = Some("invalid_token".into());
            }
            return Err("invalid_token".into());
        }
        self.current(epoch).await?;
        Ok(response)
    }

    async fn capture_retry_after(
        &self,
        epoch: u64,
        headers: &reqwest::header::HeaderMap,
    ) -> Result<(), String> {
        let Some(value) = headers.get("Retry-After").and_then(|v| v.to_str().ok()) else {
            return Ok(());
        };
        let now = chrono::Utc::now().timestamp();
        let until = value
            .parse::<i64>()
            .ok()
            .filter(|v| *v >= 0)
            .and_then(|v| now.checked_add(v))
            .or_else(|| {
                chrono::DateTime::parse_from_rfc2822(value)
                    .ok()
                    .map(|v| v.timestamp())
            });
        let Some(until) = until else {
            return Ok(());
        };
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        if let Some(vault) = state.vault.as_mut() {
            vault.retry_after_until = vault.retry_after_until.max(until);
            self.save_vault(vault)?;
        }
        Ok(())
    }

    async fn refresh_snapshot(self: &Arc<Self>) -> Result<Value, String> {
        let (epoch, sequence) = {
            let mut state = self.state.lock().await;
            state.refresh_sequence += 1;
            (state.epoch, state.refresh_sequence)
        };
        let tomorrow = chrono::Utc::now()
            .date_naive()
            .succ_opt()
            .ok_or("platform_clock_invalid")?;
        let from = tomorrow - chrono::Duration::days(7);
        let usage_path = format!("/api/v1/member/usage?from_date={from}&to_date={tomorrow}");
        let member = self
            .resource(epoch, Method::GET, "/api/v1/member/me", &[], None)
            .await?;
        let entitlements = self
            .resource(epoch, Method::GET, "/api/v1/member/entitlements", &[], None)
            .await?;
        let trial_result = self
            .resource(
                epoch,
                Method::GET,
                "/api/v1/member/registration-trial",
                &[],
                None,
            )
            .await;
        let wallet = self
            .resource(epoch, Method::GET, "/api/v1/wallet", &[], None)
            .await?;
        let grants = self
            .resource(
                epoch,
                Method::GET,
                "/api/v1/wallet/grants?limit=100",
                &[],
                None,
            )
            .await?;
        let usage = self
            .resource(epoch, Method::GET, &usage_path, &[], None)
            .await?;
        let platform_status = self
            .resource(epoch, Method::GET, "/api/v1/platform/status", &[], None)
            .await
            .ok();
        let benefits = self.read_benefits(epoch).await;
        let mut state = self.state.lock().await;
        if state.epoch != epoch || state.refresh_sequence != sequence {
            return Err("platform_account_changed".into());
        }
        let member_id = member["member_id"]
            .as_str()
            .filter(|v| safe_id(v))
            .ok_or("platform_response_invalid")?;
        let vault = state.vault.as_mut().ok_or("platform_login_required")?;
        if vault.member_id.as_deref().is_some_and(|v| v != member_id) {
            return Err("platform_account_changed".into());
        }
        vault.member_id = Some(member_id.to_string());
        self.save_vault(vault)?;
        state.member = project(
            &member,
            &[
                "member_id",
                "status",
                "email_verified",
                "email_masked",
                "binding_required",
                "device_id",
                "granted_scopes",
                "server_time",
                "eligible_model_ids",
                "plan_id",
                "plan_display_name",
                "plan_revision_id",
            ],
        );
        state.entitlements = project(
            &entitlements,
            &[
                "plan_id",
                "plan_display_name",
                "plan_revision_id",
                "entitlement_version",
                "effective_at",
                "server_time",
                "allowed_model_ids",
                "max_concurrent_requests",
                "active_requests",
                "rate_limit_rpm",
                "max_output_tokens",
                "daily_request_limit",
                "remaining_daily_requests",
                "control_state",
            ],
        );
        state.wallet = project(
            &wallet,
            &[
                "currency",
                "units_per_cny",
                "credits_per_cny",
                "summary",
                "as_of",
                "simulated",
            ],
        );
        state.grants = project(&grants, &["items", "next_cursor", "first_page_only"]);
        state.usage = project(
            &usage,
            &["from_date", "to_date", "timezone", "as_of", "days"],
        );
        state.benefits = benefits;
        if let Some(status) = platform_status {
            state.platform_status = project(
                &status,
                &[
                    "local_only",
                    "fixture_mode",
                    "rewards_enabled",
                    "registration_rewards_enabled",
                    "referral_rewards_enabled",
                    "real_upstream_enabled",
                    "paid_services_enabled",
                    "training_export_enabled",
                ],
            );
        }
        match trial_result {
            Ok(value) => {
                state.trial = project(
                    &value,
                    &[
                        "status",
                        "label",
                        "amount_micro_cny",
                        "expires_at",
                        "simulated",
                        "reason_code",
                    ],
                );
                state.error = None;
            }
            Err(error) => state.error = Some(error),
        }
        state.updated_at = Some(chrono::Utc::now().to_rfc3339());
        drop(state);
        self.emit_snapshot().await;
        Ok(self.snapshot().await)
    }

    pub async fn dispatch(self: &Arc<Self>, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "read_invitation_poster" => {
                only_args(&args, &[])?;
                self.read_invitation_poster().await
            }
            "save_invitation_poster" => {
                only_args(
                    &args,
                    &[
                        "epoch",
                        "memberId",
                        "revision",
                        "template",
                        "language",
                        "pngBase64",
                    ],
                )?;
                self.save_invitation_poster(args).await
            }
            "public_benefits" => {
                only_args(&args, &[])?;
                Ok(self.public_benefits().await)
            }
            "snapshot" => {
                only_args(&args, &[])?;
                Ok(self.snapshot().await)
            }
            "restore" => {
                only_args(&args, &[])?;
                self.load(false).await?;
                self.retry_pending_revocations().await?;
                let signed_in = self
                    .state
                    .lock()
                    .await
                    .vault
                    .as_ref()
                    .is_some_and(|v| v.credential.is_some());
                if signed_in {
                    self.refresh_snapshot().await
                } else {
                    let mut state = self.state.lock().await;
                    if state.phase == "guest" {
                        state.error = None;
                    }
                    drop(state);
                    self.emit_snapshot().await;
                    Ok(self.snapshot().await)
                }
            }
            "login" => {
                only_args(&args, &["language", "deviceName"])?;
                let language = oauth::language(&args)?;
                self.begin_login(args["deviceName"].as_str(), language)
                    .await
            }
            "login_cancel" => {
                only_args(&args, &[])?;
                self.cancel_login().await
            }
            "bind" => {
                only_args(&args, &["deviceName", "language"])?;
                let language = oauth::language(&args)?;
                self.begin_binding(
                    args["deviceName"].as_str().unwrap_or("ClawPanel 桌面安装"),
                    language,
                )
                .await
            }
            "refresh" => {
                only_args(&args, &[])?;
                let pending_without_credential = {
                    let state = self.state.lock().await;
                    matches!(state.phase.as_str(), "authorizing" | "reauthorizing")
                        && state.vault.as_ref().is_none_or(|v| v.credential.is_none())
                };
                // 初始授权尚无凭据时，只读刷新不得通过错误处理打断 PKCE 等待。
                if pending_without_credential {
                    return Ok(self.snapshot().await);
                }
                self.refresh_snapshot().await
            }
            "models" => {
                only_args(&args, &["modelId"])?;
                self.models(args.get("modelId").and_then(Value::as_str))
                    .await
            }
            "send" => {
                only_args(&args, &["operationId", "body"])?;
                self.begin_send(args).await
            }
            "cancel" | "recover" => {
                only_args(&args, &["operationId"])?;
                self.control(
                    args["operationId"]
                        .as_str()
                        .ok_or("invalid_platform_arguments")?,
                    command == "cancel",
                )
                .await
            }
            "logout" => {
                only_args(&args, &["localOnly"])?;
                self.logout(args["localOnly"].as_bool().unwrap_or(false), false)
                    .await
            }
            "unbind" => {
                only_args(&args, &[])?;
                self.logout(false, true).await
            }
            "open_member" => {
                only_args(&args, &["section"])?;
                let suffix = match args["section"].as_str().unwrap_or("account") {
                    "account" => "/member",
                    "referrals" => "/member#referrals",
                    _ => return Err("invalid_platform_arguments".into()),
                };
                self.open(format!("{}{suffix}", self.transport.origin))
                    .await?;
                Ok(json!({"opened":true}))
            }
            _ => Err("unsupported_platform_command".into()),
        }
    }

    async fn execute(self: &Arc<Self>, command: &str, args: Value) -> Result<Value, String> {
        let entry_epoch = self.state.lock().await.epoch;
        let result = self.dispatch(command, args).await;
        if let Err(error) = &result {
            // 普通迟到错误归原账号；安装级存储故障必须关闭当前凭据准入。
            let storage_failure = error.starts_with("platform_storage")
                || error.starts_with("platform_journal")
                || error == "platform_key_unavailable";
            // 海报是可选读取，但凭据失效仍须发布重新登录状态并关闭旧官方运行时。
            let credential_failure = matches!(
                error.as_str(),
                "invalid_token" | "platform_reauthorization_required"
            );
            if error != "platform_account_changed"
                && (storage_failure
                    || credential_failure
                    || !matches!(command, "read_invitation_poster" | "save_invitation_poster"))
            {
                let epoch = if error.starts_with("platform_storage")
                    || error.starts_with("platform_journal")
                    || error == "platform_key_unavailable"
                {
                    self.state.lock().await.epoch
                } else {
                    entry_epoch
                };
                self.fail(epoch, error).await;
            }
        }
        result
    }

    async fn open(&self, url: String) -> Result<(), String> {
        let opener = self.browser.read().unwrap().clone();
        // 系统 launcher 的有界观测不占用异步 runtime；地址与底层错误留在原生层。
        tauri::async_runtime::spawn_blocking(move || opener(url))
            .await
            .map_err(|_| "platform_browser_unavailable".to_string())?
    }
}

#[tauri::command]
pub async fn platform_call(
    app: tauri::AppHandle,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let platform = PLATFORM.as_ref().map_err(Clone::clone)?.clone();
    *platform.reporter.write().unwrap() = Arc::new(move |event| {
        let _ = app.emit("platform-event", event);
    });
    platform
        .execute(&command, args.unwrap_or_else(|| json!({})))
        .await
}

#[cfg(debug_assertions)]
pub async fn run_harness() -> Result<(), String> {
    if !isolated_debug_enabled() {
        return Err("platform_harness_requires_isolation".into());
    }
    use tokio::io::{AsyncBufReadExt, BufReader};
    let platform = PLATFORM.as_ref().map_err(Clone::clone)?.clone();
    // 仅测试进程私有计数：没有 URL query、请求头、正文、proof、nonce 或凭据。
    platform
        .transport
        .set_wire_reporter(Arc::new(|event| println!("{}", json!({"wire":event}))));
    *platform.reporter.write().unwrap() = Arc::new(|event| println!("{}", json!({"event":event})));
    // 仅测试进程的私有管道供系统浏览器驱动消费；从不发送给 WebView 或报告。
    *platform.browser.write().unwrap() = Arc::new(|url| {
        println!("{}", json!({"browser":{"url":url}}));
        Ok(())
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut jobs = tokio::task::JoinSet::new();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| "platform_harness_input")?
    {
        if line.len() > 12 * 1024 * 1024 {
            return Err("platform_harness_input".into());
        }
        let input: Value = serde_json::from_str(&line).map_err(|_| "platform_harness_input")?;
        let command = input["command"]
            .as_str()
            .ok_or("platform_harness_input")?
            .to_string();
        // 仅海报的8MiB图片需要较大的私有测试输入；其他命令保留原上限。
        if command != "save_invitation_poster" && line.len() > 2 * 1024 * 1024 {
            return Err("platform_harness_input".into());
        }
        let args = input.get("args").cloned().unwrap_or_else(|| json!({}));
        let current = platform.clone();
        // 私有驱动并行模拟真实多窗口IPC；不会改变正式命令分发或返回秘密。
        jobs.spawn(async move {
            let result = if command == "harness_fault" {
                current.harness_request(args).await
            } else {
                current.execute(&command, args).await
            };
            match result {
                Ok(result) => println!("{}", json!({"id":input["id"],"result":result})),
                Err(error) => println!("{}", json!({"id":input["id"],"error":error})),
            }
        });
        while jobs.len() >= 16 {
            let _ = jobs.join_next().await;
        }
    }
    while jobs.join_next().await.is_some() {}
    Ok(())
}
