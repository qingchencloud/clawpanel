//! 助手官方传输：固定请求、短期模型凭据、SSE 与原请求只读恢复。
use super::{
    identity::{self, MODEL_AUD},
    project, safe_id, Operation, Platform,
};
use futures_util::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct ModelCredential {
    token: String,
    expires_at: i64,
    models: Vec<String>,
    epoch: u64,
}
impl Drop for ModelCredential {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.token.zeroize();
    }
}

fn business_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn admission_rejected(status: u16, code: &str, has_request_reference: bool) -> bool {
    // 402 可能已造 ID 但事务回滚；新增准入拒绝仅在两个原始请求引用均不存在时确认。
    matches!(
        (status, code),
        (402, "insufficient_credit") | (429, "concurrency_limit_exceeded")
    ) || (status == 403 && code == "model_not_allowed" && !has_request_reference)
        || (status == 400
            && !has_request_reference
            && matches!(code, "context_limit_exceeded" | "invalid_request"))
        || (status == 429
            && !has_request_reference
            && matches!(
                code,
                "daily_request_limit_exceeded" | "cost_budget_exceeded" | "rate_limited"
            ))
}

fn validate_body(body: &Value) -> Result<(), String> {
    let object = body.as_object().ok_or("invalid_official_request")?;
    let allowed = [
        "model",
        "messages",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stop",
        "tools",
        "tool_choice",
        "n",
        "parallel_tool_calls",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unsupported_official_request".into());
    }
    if !body["model"]
        .as_str()
        .is_some_and(|v| !v.is_empty() && v.len() <= 128)
    {
        return Err("invalid_official_request".into());
    }
    let messages = body["messages"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or("invalid_official_request")?;
    for message in messages {
        let role = message["role"].as_str().ok_or("invalid_official_request")?;
        if !["system", "user", "assistant", "tool"].contains(&role) {
            return Err("unsupported_official_request".into());
        }
        if !(message["content"].is_string()
            || role == "assistant"
                && message["tool_calls"].is_array()
                && message["content"].is_null())
        {
            return Err("unsupported_official_request".into());
        }
    }
    if body.get("n").is_some_and(|v| v.as_i64() != Some(1))
        || body
            .get("parallel_tool_calls")
            .is_some_and(|v| v.as_bool() != Some(false))
    {
        return Err("unsupported_official_request".into());
    }
    if body.get("stream").is_some_and(|v| !v.is_boolean()) {
        return Err("invalid_official_request".into());
    }
    if body.get("max_tokens").is_some() && body.get("max_completion_tokens").is_some() {
        return Err("invalid_official_request".into());
    }
    for key in ["max_tokens", "max_completion_tokens"] {
        if body
            .get(key)
            .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=8192).contains(&n)))
        {
            return Err("invalid_official_request".into());
        }
    }
    if body
        .get("tools")
        .is_some_and(|v| v.as_array().is_none_or(|v| v.len() > 32))
    {
        return Err("invalid_official_request".into());
    }
    Ok(())
}

impl Platform {
    #[cfg(debug_assertions)]
    pub(super) async fn harness_model_boundary(
        &self,
        epoch: u64,
        kind: &str,
    ) -> Result<Value, String> {
        if !super::harness::enabled() {
            return Err("platform_harness_faults_disabled".into());
        }
        // 只对两个固定合成模型作负向准入；不开放任意URL、body或凭据给测试器。
        let (key, credential) = self.platform_credential(epoch).await?;
        let business_key = identity::random_id();
        let response = if kind == "g01_old_session_b" {
            let session = self
                .state
                .lock()
                .await
                .model_session
                .clone()
                .filter(|session| {
                    session.epoch == epoch
                        && !session
                            .models
                            .iter()
                            .any(|model| model == "official/fixture-tools")
                })
                .ok_or("platform_harness_original_a_session_required")?;
            let body = serde_json::to_vec(&json!({"model":"official/fixture-tools","messages":[{"role":"user","content":"本地旧模型会话负向准入"}],"stream":false,"max_tokens":1})).unwrap();
            self.transport
                .send(
                    &key,
                    Some(&session.token),
                    MODEL_AUD,
                    Method::POST,
                    "/v1/chat/completions",
                    &body,
                    "application/json",
                    Some(&business_key),
                )
                .await?
        } else {
            let model = match kind {
                "g01_new_session_b" => "official/fixture-tools",
                "d11_disabled_session" => "official/fixture-chat",
                _ => return Err("platform_harness_invalid_fault".into()),
            };
            let device = credential
                .device_id
                .as_deref()
                .ok_or("platform_binding_required")?;
            let body = serde_json::to_vec(
                &json!({"device_id":device,"requested_model_ids":[model],"runtime":"assistant"}),
            )
            .unwrap();
            self.transport
                .send(
                    &key,
                    Some(&credential.access_token),
                    identity::PLATFORM_AUD,
                    Method::POST,
                    "/api/v1/model-sessions",
                    &body,
                    "application/json",
                    Some(&business_key),
                )
                .await?
        };
        self.current(epoch).await?;
        Ok(
            json!({"httpStatus":response.status,"accepted":(200..300).contains(&response.status),"code":response.error,"hasRequestReference":response.headers.contains_key("X-Model-Request-ID")||response.headers.contains_key("Location")}),
        )
    }
    #[cfg(debug_assertions)]
    pub(super) async fn harness_model_at_platform(&self, epoch: u64) -> Result<Value, String> {
        if !super::harness::enabled() {
            return Err("platform_harness_faults_disabled".into());
        }
        // 固定负向audience请求，只把状态交给私有stdin；模型凭据不出native。
        let session = self.model_credential(epoch, None).await?;
        let key = self
            .state
            .lock()
            .await
            .vault
            .as_ref()
            .ok_or("platform_login_required")?
            .key()?;
        let response = self
            .transport
            .send(
                &key,
                Some(&session.token),
                identity::PLATFORM_AUD,
                Method::GET,
                "/api/v1/member/me",
                &[],
                "application/json",
                None,
            )
            .await?;
        self.current(epoch).await?;
        Ok(
            json!({"httpStatus":response.status,"accepted":(200..300).contains(&response.status),"code":response.error}),
        )
    }
    async fn model_credential(
        &self,
        epoch: u64,
        wanted: Option<&str>,
    ) -> Result<ModelCredential, String> {
        self.model_credential_for(epoch, wanted, "assistant").await
    }
    async fn model_credential_for(
        &self,
        epoch: u64,
        wanted: Option<&str>,
        runtime: &str,
    ) -> Result<ModelCredential, String> {
        let _guard = self.model_lock.lock().await;
        let now = chrono::Utc::now().timestamp();
        let (device, candidates) = {
            let state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            if state.phase != "bound" {
                return Err("platform_binding_required".into());
            }
            if state
                .vault
                .as_ref()
                .is_some_and(|v| v.retry_after_until > chrono::Utc::now().timestamp())
            {
                return Err("rate_limited".into());
            }
            if let Some(model) = &state.model_session {
                if model.epoch == epoch
                    && model.expires_at > now + 10
                    && wanted.is_none_or(|id| model.models.iter().any(|v| v == id))
                {
                    return Ok(model.clone());
                }
            }
            let vault = state.vault.as_ref().ok_or("platform_login_required")?;
            if vault.model_issue_pending_until > now {
                return Err("model_session_issuance_unknown".into());
            }
            let device = vault
                .credential
                .as_ref()
                .and_then(|v| v.device_id.clone())
                .ok_or("platform_binding_required")?;
            let candidates: Vec<String> = state.member["eligible_model_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            (device, candidates)
        };
        let mut candidates = if let Some(wanted) = wanted {
            if !candidates.iter().any(|v| v == wanted) {
                return Err("model_not_allowed".into());
            }
            let mut all = candidates;
            all.retain(|v| v != wanted);
            all.insert(0, wanted.to_string());
            all
        } else {
            candidates
        };
        candidates.truncate(8);
        if candidates.is_empty() {
            return Err("official_models_unavailable".into());
        }
        {
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            let vault = state.vault.as_mut().ok_or("platform_login_required")?;
            vault.model_issue_pending_until = now + 300;
            self.save_vault(vault)?;
        }
        let body = serde_json::to_vec(
            &json!({"device_id":device,"requested_model_ids":candidates,"runtime":runtime}),
        )
        .unwrap();
        let result = self
            .resource(
                epoch,
                Method::POST,
                "/api/v1/model-sessions",
                &body,
                Some(&identity::random_id()),
            )
            .await;
        let value = match result {
            Ok(v) => v,
            Err(error) => {
                // 已明确的准入拒绝没有签发；网络或一次性结果未知保留等待截止。
                if [
                    "insufficient_credit",
                    "model_not_allowed",
                    "model_session_limit",
                    "entitlements_unavailable",
                    "account_restricted",
                    "budget_unavailable",
                    "upstream_disabled",
                ]
                .contains(&error.as_str())
                {
                    let mut state = self.state.lock().await;
                    if state.epoch == epoch {
                        if let Some(v) = state.vault.as_mut() {
                            v.model_issue_pending_until = 0;
                            self.save_vault(v)?;
                        }
                    }
                }
                return Err(error);
            }
        };
        if value["token_type"] != "DPoP"
            || value["audience"] != MODEL_AUD
            || value["expires_in"].as_i64() != Some(300)
            || value["gateway_base_url"].as_str() != Some(self.transport.origin.as_str())
            || value["device_id"].as_str() != Some(device.as_str())
        {
            return Err("platform_model_session_invalid".into());
        }
        let models: Vec<String> = value["allowed_model_ids"]
            .as_array()
            .ok_or("platform_model_session_invalid")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or("platform_model_session_invalid")
            })
            .collect::<Result<_, _>>()?;
        if models.iter().any(|id| !candidates.contains(id)) {
            return Err("platform_model_session_invalid".into());
        }
        let model = ModelCredential {
            token: value["access_token"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or("platform_model_session_invalid")?
                .to_string(),
            expires_at: now + 300,
            models,
            epoch,
        };
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        if let Some(vault) = state.vault.as_mut() {
            vault.model_issue_pending_until = 0;
            self.save_vault(vault)?;
        }
        state.model_session = Some(model.clone());
        Ok(model)
    }

    pub(super) async fn models(self: &Arc<Self>, model_id: Option<&str>) -> Result<Value, String> {
        self.models_for("assistant", model_id).await
    }
    pub(super) async fn models_for(
        self: &Arc<Self>,
        runtime: &str,
        model_id: Option<&str>,
    ) -> Result<Value, String> {
        let epoch = self.state.lock().await.epoch;
        let session = self.model_credential_for(epoch, model_id, runtime).await?;
        let key = {
            let state = self.state.lock().await;
            state
                .vault
                .as_ref()
                .ok_or("platform_key_unavailable")?
                .key()?
        };
        let value = identity::json_response(
            self.transport
                .send(
                    &key,
                    Some(&session.token),
                    MODEL_AUD,
                    Method::GET,
                    "/v1/models",
                    &[],
                    "application/json",
                    None,
                )
                .await?,
        )
        .await?;
        let models: Vec<Value> = value["data"]
            .as_array()
            .ok_or("platform_response_invalid")?
            .iter()
            .map(|v| {
                project(
                    v,
                    &[
                        "id",
                        "object",
                        "owned_by",
                        "display_name",
                        "capabilities",
                        "context_tokens",
                        "default_output_tokens",
                        "max_output_tokens",
                        "price",
                    ],
                )
            })
            .collect();
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        state.models = json!({"data":models});
        let result = state.models.clone();
        drop(state);
        self.emit_snapshot().await;
        Ok(result)
    }

    pub(super) async fn begin_send(self: &Arc<Self>, args: Value) -> Result<Value, String> {
        self.begin_send_for(args, "assistant", None).await
    }
    pub(super) async fn begin_send_for(
        self: &Arc<Self>,
        args: Value,
        runtime: &str,
        expected: Option<(u64, &str)>,
    ) -> Result<Value, String> {
        if runtime != "assistant" && !super::gateway::ENGINES.contains(&runtime) {
            return Err("unsupported_official_engine".into());
        }
        let id = args["operationId"]
            .as_str()
            .filter(|v| business_id(v))
            .ok_or("invalid_operation_id")?
            .to_string();
        let body = args.get("body").ok_or("invalid_official_request")?;
        if let Err(error) = validate_body(body) {
            #[cfg(debug_assertions)]
            self.transport.engine_trace(json!({"phase":"engine_body_rejected","operationId":id,"engine":runtime,"code":error,"bodyKeys":body.as_object().map(|value|value.keys().map(|key|if key.len()<=64 && key.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'){key.as_str()}else{"other"}).collect::<Vec<_>>()),"messageTypes":body["messages"].as_array().map(|messages|messages.iter().map(|message|json!({"role":match message["role"].as_str(){Some("system"|"user"|"assistant"|"tool")=>message["role"].clone(),_=>json!("other")},"content":if message["content"].is_string(){"string"}else if message["content"].is_null(){"null"}else if message["content"].is_array(){"array"}else{"other"}})).collect::<Vec<_>>()),"toolCount":body["tools"].as_array().map(Vec::len),"parallelToolCalls":body["parallel_tool_calls"].as_bool()}));
            return Err(error);
        }
        let bytes = serde_json::to_vec(body).map_err(|_| "invalid_official_request")?;
        if bytes.len() > 1024 * 1024 {
            return Err("official_request_too_large".into());
        }
        let hash = identity::digest(&bytes);
        let epoch = {
            let mut state = self.state.lock().await;
            if state.phase != "bound" {
                return Err("platform_binding_required".into());
            }
            let member = state
                .vault
                .as_ref()
                .and_then(|v| v.member_id.clone())
                .ok_or("platform_login_required")?;
            // lease 身份与 journal 准入在同一锁内核对，旧账号请求不能借新账号派发。
            if expected.is_some_and(|(epoch, owner)| epoch != state.epoch || owner != member) {
                return Err("platform_account_changed".into());
            }
            if let Some(old) = state.operations.iter().find(|op| op.operation_id == id) {
                if old.member_id != member || old.body_hash != hash || old.runtime != runtime {
                    return Err("idempotency_conflict".into());
                }
                return Ok(
                    json!({"epoch":state.epoch,"operationId":id,"accepted":false,"requestId":old.request_id,"state":old.state,"replyComplete":old.reply_complete,"recoveryRequired":true}),
                );
            }
            if state.operations.iter().any(|op| {
                op.member_id == member
                    && !matches!(op.state.as_str(), "settled" | "released")
                    && (runtime == "assistant"
                        || op.runtime == "assistant"
                        || op.epoch != state.epoch
                        || op.state == "unknown"
                        || op.body.is_empty())
            }) {
                return Err("official_request_recovery_required".into());
            }
            // 仅已读到的正常模式关闭能力阻止新准入；未知 HTTP 结果仍按原请求恢复。
            if state.platform_status["fixture_mode"].as_bool() == Some(false)
                && state.platform_status["real_upstream_enabled"].as_bool() == Some(false)
            {
                return Err("upstream_disabled".into());
            }
            if state.operations.len() >= 96 {
                // 只淘汰已知终态，绝不删除未决恢复记录来释放准入。
                let remove = state.operations.len() - 64;
                let mut removed = 0;
                state.operations.retain(|op| {
                    if removed < remove && matches!(op.state.as_str(), "settled" | "released") {
                        removed += 1;
                        false
                    } else {
                        true
                    }
                });
            }
            if state.operations.len() >= 128 {
                return Err("platform_journal_limit".into());
            }
            let epoch = state.epoch;
            // 安全库先置未决标记：即使 journal 被删或写入中断，恢复也失败关闭。
            let vault = state.vault.as_mut().ok_or("platform_login_required")?;
            vault.outstanding_operation = Some(id.clone());
            self.save_vault(vault)?;
            state.operations.push(Operation {
                operation_id: id.clone(),
                member_id: member,
                epoch,
                body_hash: hash,
                request_id: None,
                state: "preparing".into(),
                reply_complete: false,
                cancellation_requested: false,
                cancel_key: identity::random_id(),
                runtime: runtime.into(),
                admission_rejected: false,
                body: bytes,
            });
            self.save_journal(&state.operations)?;
            epoch
        };
        let this = self.clone();
        let operation = id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = this.send_operation(epoch, &operation).await {
                if error.starts_with("platform_storage") || error.starts_with("platform_journal") {
                    let current_epoch = this.state.lock().await.epoch;
                    this.fail(current_epoch, &error).await;
                }
                let (terminal, admission, request_id) = {
                    let state = this.state.lock().await;
                    state
                        .operations
                        .iter()
                        .find(|op| op.operation_id == operation)
                        .map(|op| {
                            (
                                matches!(op.state.as_str(), "settled" | "released"),
                                op.admission_rejected,
                                op.request_id.clone(),
                            )
                        })
                        .unwrap_or((false, false, None))
                };
                if !terminal {
                    let _ = this
                        .mark_operation(epoch, &operation, None, Some("unknown"), Some(false))
                        .await;
                }
                this.emit_snapshot().await;
                this.emit(
                    epoch,
                    "error",
                    Some(&operation),
                    request_id.as_deref(),
                    json!({"code":error,"unknown":!terminal,"replyComplete":false,"admissionRejected":admission,"preDispatch":admission}),
                )
                .await;
                // 仅只读核对原请求；没有请求 ID 就保持未知，不猜未注册的按键查询接口。
                let _ = this.control(&operation, false).await;
            }
        });
        Ok(json!({"epoch":epoch,"operationId":id,"accepted":true}))
    }

    async fn mark_operation(
        &self,
        epoch: u64,
        id: &str,
        request: Option<&str>,
        status: Option<&str>,
        complete: Option<bool>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        let op = state
            .operations
            .iter_mut()
            .find(|op| op.operation_id == id)
            .ok_or("platform_request_not_found")?;
        if let Some(request) = request {
            if !safe_id(request) {
                return Err("platform_request_id_invalid".into());
            }
            op.request_id = Some(request.into());
        }
        if let Some(status) = status {
            op.state = status.into();
        }
        if let Some(complete) = complete {
            op.reply_complete = complete;
        }
        self.save_journal(&state.operations)?;
        Ok(())
    }

    async fn send_operation(self: &Arc<Self>, epoch: u64, id: &str) -> Result<(), String> {
        let (bytes, runtime) = {
            let state = self.state.lock().await;
            let op = state
                .operations
                .iter()
                .find(|op| op.operation_id == id)
                .ok_or("platform_request_not_found")?;
            (op.body.clone(), op.runtime.clone())
        };
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_official_request")?;
        #[cfg(debug_assertions)]
        self.transport.engine_trace(json!({"phase":"engine_body_shape","operationId":id,"engine":runtime,"stream":body["stream"].as_bool(),"includeUsage":body["stream_options"]["include_usage"].as_bool(),"maxTokens":body["max_tokens"].as_u64()}));
        let model = body["model"].as_str().ok_or("invalid_official_request")?;
        let session = match self
            .model_credential_for(epoch, Some(model), &runtime)
            .await
        {
            Ok(v) => v,
            Err(error) => {
                self.mark_operation(epoch, id, None, Some("released"), Some(false))
                    .await?;
                self.clear_outstanding(epoch, id).await?;
                return Err(error);
            }
        };
        self.current(epoch).await?;
        {
            let state = self.state.lock().await;
            let op = state
                .operations
                .iter()
                .find(|op| op.operation_id == id)
                .ok_or("platform_request_not_found")?;
            if op.cancellation_requested {
                drop(state);
                self.mark_operation(epoch, id, None, Some("released"), Some(false))
                    .await?;
                self.clear_outstanding(epoch, id).await?;
                return Err("official_request_cancelled_before_dispatch".into());
            }
        }
        let key = {
            let state = self.state.lock().await;
            state
                .vault
                .as_ref()
                .ok_or("platform_key_unavailable")?
                .key()?
        };
        self.mark_operation(epoch, id, None, Some("dispatching"), None)
            .await?;
        let mut wire = self
            .transport
            .send(
                &key,
                Some(&session.token),
                MODEL_AUD,
                Method::POST,
                "/v1/chat/completions",
                &bytes,
                "application/json",
                Some(id),
            )
            .await?;
        if wire.status == 429 {
            self.capture_retry_after(epoch, &wire.headers).await?;
        }
        let has_request_reference = wire.headers.contains_key("X-Model-Request-ID")
            || wire.headers.contains_key("Location");
        let request = wire
            .headers
            .get("X-Model-Request-ID")
            .and_then(|v| v.to_str().ok())
            .filter(|id| safe_id(id))
            .map(str::to_string)
            .or_else(|| {
                let location = wire.headers.get("Location")?.to_str().ok()?;
                let url = reqwest::Url::parse(&self.transport.origin)
                    .ok()?
                    .join(location)
                    .ok()?;
                if url.origin().ascii_serialization() != self.transport.origin
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return None;
                }
                url.path()
                    .strip_prefix("/api/v1/model-requests/")
                    .filter(|v| safe_id(v))
                    .map(str::to_string)
            });
        if let Some(request) = &request {
            self.mark_operation(epoch, id, Some(request), None, None)
                .await?;
            self.emit(
                epoch,
                "request",
                Some(id),
                Some(request),
                json!({"state":"dispatching"}),
            )
            .await;
        }
        let cancel_pending = {
            let state = self.state.lock().await;
            state
                .operations
                .iter()
                .find(|op| op.operation_id == id)
                .is_some_and(|op| op.cancellation_requested)
        };
        if cancel_pending && request.is_some() {
            let _ = self.control(id, true).await;
        }
        if let Some(error) = wire.error {
            if admission_rejected(wire.status, &error, has_request_reference) {
                self.mark_admission_rejected(epoch, id).await?;
                self.mark_operation(epoch, id, None, Some("released"), Some(false))
                    .await?;
                self.clear_outstanding(epoch, id).await?;
            }
            return Err(error);
        }
        let response = wire.response.take().ok_or("platform_response_incomplete")?;
        if !(200..300).contains(&wire.status) {
            let bytes = identity::bounded_body(response, 1024 * 1024).await?;
            let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let error = identity::error_code(&value);
            if admission_rejected(wire.status, &error, has_request_reference) {
                self.mark_admission_rejected(epoch, id).await?;
                self.mark_operation(epoch, id, None, Some("released"), Some(false))
                    .await?;
                self.clear_outstanding(epoch, id).await?;
            }
            return Err(error);
        }
        let stream = body["stream"].as_bool().unwrap_or(false);
        let completion = if stream {
            if !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("text/event-stream"))
            {
                return Err("platform_stream_invalid".into());
            }
            self.read_stream(epoch, id, request.as_deref(), response)
                .await?;
            json!({"done":true,"replyComplete":true})
        } else {
            let value: Value =
                serde_json::from_slice(&identity::bounded_body(response, 8 * 1024 * 1024).await?)
                    .map_err(|_| "platform_response_invalid")?;
            if !value["choices"].is_array() || !value["usage"].is_object() {
                return Err("platform_response_incomplete".into());
            }
            let mut completion = project(
                &value,
                &["id", "object", "created", "model", "choices", "usage"],
            );
            completion["replyComplete"] = json!(true);
            completion
        };
        self.mark_operation(epoch, id, None, None, Some(true))
            .await?;
        self.emit(epoch, "complete", Some(id), request.as_deref(), completion)
            .await;
        let _ = self.control(id, false).await;
        let _ = self.refresh_snapshot().await;
        Ok(())
    }

    async fn read_stream(
        &self,
        epoch: u64,
        id: &str,
        request: Option<&str>,
        response: reqwest::Response,
    ) -> Result<(), String> {
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut done = false;
        let mut usage = false;
        let mut finish = false;
        let mut total = 0usize;
        while let Some(chunk) = stream.next().await {
            self.current(epoch).await?;
            let chunk = chunk.map_err(|_| "platform_stream_incomplete")?;
            total += chunk.len();
            if total > 32 * 1024 * 1024 || buffer.len() + chunk.len() > 1024 * 1024 {
                return Err("platform_stream_too_large".into());
            }
            buffer.extend_from_slice(&chunk);
            loop {
                let lf = buffer.windows(2).position(|v| v == b"\n\n").map(|p| (p, 2));
                let crlf = buffer
                    .windows(4)
                    .position(|v| v == b"\r\n\r\n")
                    .map(|p| (p, 4));
                let separator = match (lf, crlf) {
                    (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                    (a, None) => a,
                    (None, b) => b,
                };
                let Some((at, len)) = separator else {
                    break;
                };
                let frame = String::from_utf8(buffer.drain(..at + len).collect())
                    .map_err(|_| "platform_stream_invalid")?;
                let mut data = Vec::new();
                let mut event_error = false;
                for line in frame.lines() {
                    if line.starts_with(':') {
                        continue;
                    }
                    if let Some(value) = line.strip_prefix("data:") {
                        data.push(value.strip_prefix(' ').unwrap_or(value));
                    }
                    if line
                        .strip_prefix("event:")
                        .is_some_and(|v| v.trim() == "error")
                    {
                        event_error = true;
                    }
                }
                if data.is_empty() {
                    continue;
                }
                let data = data.join("\n");
                if event_error {
                    return Err("platform_stream_error".into());
                }
                if data == "[DONE]" {
                    done = true;
                    continue;
                }
                let value: Value =
                    serde_json::from_str(&data).map_err(|_| "platform_stream_invalid")?;
                if value.get("error").is_some() {
                    return Err("platform_stream_error".into());
                }
                usage |= value["usage"].is_object();
                finish |= value["choices"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|v| v["finish_reason"].is_string()));
                self.emit(
                    epoch,
                    "delta",
                    Some(id),
                    request,
                    project(
                        &value,
                        &["id", "object", "created", "model", "choices", "usage"],
                    ),
                )
                .await;
            }
        }
        #[cfg(debug_assertions)]
        self.transport.engine_trace(json!({"phase":"stream_validation","operationId":id,"sawUsage":usage,"sawFinish":finish,"sawDone":done,"trailingBytes":buffer.len()}));
        if !done || !usage || !finish || buffer.iter().any(|v| !v.is_ascii_whitespace()) {
            return Err("platform_stream_incomplete".into());
        }
        Ok(())
    }

    async fn clear_outstanding(&self, epoch: u64, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        let outstanding = state
            .operations
            .iter()
            .find(|op| {
                op.operation_id != id && !matches!(op.state.as_str(), "settled" | "released")
            })
            .map(|op| op.operation_id.clone());
        if let Some(vault) = state.vault.as_mut() {
            if vault.outstanding_operation.as_deref() == Some(id) {
                vault.outstanding_operation = outstanding;
                self.save_vault(vault)?;
            }
        }
        Ok(())
    }

    async fn mark_admission_rejected(&self, epoch: u64, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        let op = state
            .operations
            .iter_mut()
            .find(|op| op.operation_id == id)
            .ok_or("platform_request_not_found")?;
        op.admission_rejected = true;
        self.save_journal(&state.operations)?;
        Ok(())
    }

    pub(super) async fn control(self: &Arc<Self>, id: &str, cancel: bool) -> Result<Value, String> {
        if !business_id(id) {
            return Err("invalid_operation_id".into());
        }
        let (epoch, request, key, local_rejected) = {
            let mut state = self.state.lock().await;
            let epoch = state.epoch;
            let member = state
                .vault
                .as_ref()
                .and_then(|v| v.member_id.clone())
                .ok_or("platform_login_required")?;
            let op = state
                .operations
                .iter_mut()
                .find(|op| op.operation_id == id && op.member_id == member)
                .ok_or("platform_request_not_found")?;
            if cancel {
                op.cancellation_requested = true;
            }
            let result = (
                epoch,
                op.request_id.clone(),
                op.cancel_key.clone(),
                op.admission_rejected,
            );
            self.save_journal(&state.operations)?;
            result
        };
        let Some(request) = request else {
            return Err("official_request_id_unknown".into());
        };
        let path = format!(
            "/api/v1/model-requests/{request}{}",
            if cancel { "/cancel" } else { "" }
        );
        let result = self
            .resource(
                epoch,
                if cancel { Method::POST } else { Method::GET },
                &path,
                if cancel {
                    b"{\"reason\":\"user_cancelled\"}"
                } else {
                    b""
                },
                if cancel { Some(key.as_str()) } else { None },
            )
            .await;
        let value = match result {
            Err(error) if local_rejected && error == "not_found" => {
                return Err("official_request_not_created".into())
            }
            other => other?,
        };
        if value["request_id"].as_str() != Some(request.as_str()) {
            return Err("platform_request_id_invalid".into());
        }
        let status = value["state"]
            .as_str()
            .filter(|v| {
                [
                    "reserved",
                    "dispatching",
                    "streaming",
                    "reconciling",
                    "settled",
                    "released",
                ]
                .contains(v)
            })
            .ok_or("platform_response_invalid")?;
        self.mark_operation(epoch, id, None, Some(status), None)
            .await?;
        if matches!(status, "settled" | "released") {
            self.clear_outstanding(epoch, id).await?;
        }
        let projected = project(
            &value,
            &[
                "request_id",
                "state",
                "cancellation_requested",
                "public_reason_code",
                "created_at",
                "updated_at",
            ],
        );
        self.emit(
            epoch,
            "request",
            Some(id),
            Some(&request),
            projected.clone(),
        )
        .await;
        self.emit_snapshot().await;
        Ok(projected)
    }
}
