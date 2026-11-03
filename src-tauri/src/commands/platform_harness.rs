//! 仅debug私有stdin的隔离故障操作；不属于WebView IPC合同。
use super::{identity, oauth, only_args, Credential, Platform, Value};
use reqwest::Method;
use serde_json::json;
use std::sync::Arc;

#[derive(Default)]
pub(super) struct HarnessState {
    remember_refresh: bool,
    saved_refresh: Option<Credential>,
    remember_code: bool,
    saved_code: Option<zeroize::Zeroizing<Vec<u8>>>,
    callback_port: u16,
    engine_pause_next: bool,
    engine_pause_entered: bool,
    engine_release: Arc<tokio::sync::Notify>,
}

pub(super) fn enabled() -> bool {
    identity::isolated_debug_enabled()
        && std::env::var("CLAWPANEL_PLATFORM_HARNESS_FAULTS").as_deref() == Ok("1")
        && std::env::var("CLAWPANEL_PLATFORM_NAMESPACE")
            .is_ok_and(|namespace| namespace.starts_with("desktop-protocol-"))
}

impl Platform {
    pub(super) async fn harness_engine_pause(&self) {
        if !enabled() {
            return;
        }
        let notify = {
            let mut state = self.harness.lock().await;
            if !state.engine_pause_next {
                return;
            }
            state.engine_pause_next = false;
            state.engine_pause_entered = true;
            state.engine_release.clone()
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(120), notify.notified()).await;
    }
    pub(super) async fn harness_remember_code(&self, body: &[u8]) {
        if enabled() {
            let mut harness = self.harness.lock().await;
            if harness.remember_code {
                harness.saved_code = Some(zeroize::Zeroizing::new(body.to_vec()));
                harness.remember_code = false;
            }
        }
    }
    pub(super) async fn harness_remember_refresh(&self, previous: &Credential) {
        if enabled() {
            let mut harness = self.harness.lock().await;
            if harness.remember_refresh {
                harness.saved_refresh = Some(previous.clone());
                harness.remember_refresh = false;
            }
        }
    }

    pub(super) async fn harness_callback_port(&self) -> u16 {
        if enabled() {
            self.harness.lock().await.callback_port
        } else {
            0
        }
    }

    pub(super) async fn harness_request(self: &Arc<Self>, args: Value) -> Result<Value, String> {
        if !enabled() {
            return Err("platform_harness_faults_disabled".into());
        }
        only_args(
            &args,
            &["action", "kind", "port", "gatewayAction", "gatewayArgs"],
        )?;
        match args["action"].as_str() {
            Some("official_engine_access") => {
                let root = std::env::var_os("CLAWPANEL_PORTABLE_ROOT")
                    .map(std::path::PathBuf::from)
                    .filter(|root| root.join(".clawpanel-engine-access-owned").is_file())
                    .ok_or("platform_engine_access_portable_required")?;
                if super::super::portable::portable_context().is_none()
                    || !super::super::openclaw_dir().starts_with(&root)
                {
                    return Err("platform_engine_access_portable_required".into());
                }
                super::super::engine_official::official_engine_access(
                    args["gatewayAction"]
                        .as_str()
                        .ok_or("platform_harness_invalid_fault")?
                        .into(),
                    args.get("gatewayArgs").cloned(),
                )
                .await
            }
            Some("openclaw_gateway_official") => {
                let root = std::env::var_os("CLAWPANEL_PORTABLE_ROOT")
                    .map(std::path::PathBuf::from)
                    .filter(|root| root.join(".clawpanel-gateway-official-owned").is_file())
                    .and_then(|root| root.canonicalize().ok())
                    .ok_or("platform_gateway_harness_portable_required")?;
                if super::super::portable::portable_context().is_none()
                    || !super::super::openclaw_dir()
                        .canonicalize()
                        .is_ok_and(|dir| dir.starts_with(&root))
                {
                    return Err("platform_gateway_harness_portable_required".into());
                }
                super::super::openclaw_gateway_official::call(
                    args["gatewayAction"]
                        .as_str()
                        .ok_or("platform_harness_invalid_fault")?,
                    args.get("gatewayArgs")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                )
                .await
            }
            Some("engine_pause_next") => {
                let mut state = self.harness.lock().await;
                state.engine_pause_next = true;
                state.engine_pause_entered = false;
                Ok(json!({"armed":true}))
            }
            Some("engine_pause_status") => {
                Ok(json!({"entered":self.harness.lock().await.engine_pause_entered}))
            }
            Some("engine_pause_release") => {
                self.harness.lock().await.engine_release.notify_one();
                Ok(json!({"released":true}))
            }
            Some("engine_gateway_contract") => Ok(
                json!({"requiresOperationId":true,"engines":super::gateway::ENGINES,"privatePipeOnly":true}),
            ),
            Some("engine_gateway") => {
                self.engine_connection(
                    args["kind"]
                        .as_str()
                        .ok_or("platform_harness_invalid_fault")?,
                )
                .await
            }
            Some("engine_cancel") => {
                let engine = args["kind"]
                    .as_str()
                    .ok_or("platform_harness_invalid_fault")?;
                // 停止意图不能先取得新模型授权；限流期间也须保留原请求取消路径。
                let state = self.state.lock().await;
                let expected = json!({"epoch":state.epoch,"memberId":state.vault.as_ref().and_then(|v|v.member_id.as_deref())});
                drop(state);
                self.engine_cancel(engine, &expected).await
            }
            Some("capabilities") => {
                Ok(json!({"debugPrivateOnly":true,"newNamespaceRequired":true}))
            }
            Some("boundary_capabilities") => Ok(json!({"fixedModelNegativeOnly":true})),
            Some("growth_projection") => {
                // 固定合成用例只调用实际只读parser；私有stdin不提供任意URL访问。
                let code = "iv_growthOnly12345";
                let valid = format!("{}/member?invite={code}", self.transport.origin);
                let (code, url) = match args["kind"].as_str() {
                    Some("valid") => (code, valid),
                    Some("foreign_origin") => (
                        code,
                        format!("https://untrusted.invalid/member?invite={code}"),
                    ),
                    Some("userinfo") => (code, valid.replacen("http://", "http://user@", 1)),
                    Some("fragment") => (code, format!("{valid}#unexpected")),
                    Some("extra_query") => (code, format!("{valid}&extra=1")),
                    Some("duplicate_invite") => (code, format!("{valid}&invite={code}")),
                    Some("mismatched_code") => (
                        code,
                        format!("{}/member?invite=iv_otherOnly12345", self.transport.origin),
                    ),
                    Some("bad_code") => ("iv_/bad", valid),
                    Some("wrong_path") => (code, valid.replace("/member?", "/member/?")),
                    Some("relative") => (code, format!("/member?invite={code}")),
                    Some("encoded_path") => (code, valid.replace("/member?", "/%6dember?")),
                    Some("encoded_key") => (code, valid.replace("?invite=", "?%69nvite=")),
                    Some("encoded_value") => (code, valid.replace("=iv_", "=%69v_")),
                    Some("double_encoded") => (code, valid.replace("=iv_", "=%2569v_")),
                    Some("missing_code") => ("", valid),
                    _ => return Err("platform_harness_invalid_fault".into()),
                };
                let source = json!({"invite_code":code,"invite_url":url,"confirmed_count":1,"participation":{"qualification_status":"pending_usage","rules":{"reward_expiry_from_issuance":true,"per_member_daily_referral_limit":3}}});
                Ok(
                    json!({"projection":super::benefits::referrals(&source, &self.transport.origin)}),
                )
            }
            Some("callback_port") => {
                let port = args["port"]
                    .as_u64()
                    .filter(|port| *port <= u16::MAX as u64)
                    .ok_or("platform_harness_invalid_fault")? as u16;
                self.harness.lock().await.callback_port = port;
                Ok(json!({"applied":true}))
            }
            Some("remember_refresh") => {
                self.harness.lock().await.remember_refresh = true;
                Ok(json!({"applied":true}))
            }
            Some("remember_code") => {
                self.harness.lock().await.remember_code = true;
                Ok(json!({"applied":true}))
            }
            Some("replay_code") => {
                let body = self
                    .harness
                    .lock()
                    .await
                    .saved_code
                    .clone()
                    .ok_or("platform_harness_no_saved_code")?;
                let (epoch, key) = {
                    let state = self.state.lock().await;
                    (
                        state.epoch,
                        state
                            .vault
                            .as_ref()
                            .ok_or("platform_login_required")?
                            .key()?,
                    )
                };
                let response = self
                    .transport
                    .send(
                        &key,
                        None,
                        identity::PLATFORM_AUD,
                        Method::POST,
                        "/oauth/token",
                        &body,
                        "application/x-www-form-urlencoded",
                        None,
                    )
                    .await?;
                self.current(epoch).await?;
                Ok(
                    json!({"httpStatus":response.status,"accepted":(200..300).contains(&response.status),"code":response.error}),
                )
            }
            Some("expire_access_cache") | Some("lose_installation_key") => {
                let mut state = self.state.lock().await;
                let vault = state.vault.as_mut().ok_or("platform_login_required")?;
                if args["action"] == "lose_installation_key" {
                    use zeroize::Zeroize;
                    vault.private_key.zeroize();
                } else {
                    vault
                        .credential
                        .as_mut()
                        .ok_or("platform_login_required")?
                        .expires_at = 0;
                }
                self.save_vault(vault)?;
                Ok(json!({"applied":true,"testMetadataOnly":args["action"]=="expire_access_cache"}))
            }
            Some("replay_refresh") => {
                let previous = self
                    .harness
                    .lock()
                    .await
                    .saved_refresh
                    .clone()
                    .ok_or("platform_harness_no_saved_refresh")?;
                let (epoch, key) = {
                    let state = self.state.lock().await;
                    (
                        state.epoch,
                        state
                            .vault
                            .as_ref()
                            .ok_or("platform_login_required")?
                            .key()?,
                    )
                };
                let result = oauth::refresh(self, &key, &previous).await;
                self.current(epoch).await?;
                match result {
                    Ok(_) => Ok(json!({"accepted":true})),
                    Err(code) => Ok(json!({"accepted":false,"code":code})),
                }
            }
            Some("probe") => {
                let kind = args["kind"]
                    .as_str()
                    .ok_or("platform_harness_invalid_fault")?;
                let epoch = self.state.lock().await.epoch;
                if kind == "model_token_at_platform" {
                    return self.harness_model_at_platform(epoch).await;
                }
                if [
                    "g01_old_session_b",
                    "g01_new_session_b",
                    "d11_disabled_session",
                ]
                .contains(&kind)
                {
                    return self.harness_model_boundary(epoch, kind).await;
                }
                let (key, credential) = self.platform_credential(epoch).await?;
                let (path, audience, method, body, business_key) = if kind == "binding_key_mismatch"
                {
                    let other = p256::ecdsa::SigningKey::random(
                        &mut p256::elliptic_curve::rand_core::OsRng,
                    );
                    ("/api/v1/devices/binding-intents".to_string(), identity::PLATFORM_AUD,
                        Method::POST, serde_json::to_vec(&json!({"device_name":"Native isolated wrong-key probe","instance_kind":"desktop","platform":"windows","public_jwk":identity::public_jwk(&other)})).unwrap(), Some(identity::random_id()))
                } else if kind == "binding_poll" {
                    let state = self.state.lock().await;
                    let intent = state.binding["intent_id"]
                        .as_str()
                        .filter(|value| super::safe_id(value))
                        .ok_or("platform_harness_no_binding_intent")?;
                    (
                        format!("/api/v1/devices/binding-intents/{intent}"),
                        identity::PLATFORM_AUD,
                        Method::GET,
                        Vec::new(),
                        None,
                    )
                } else if kind == "platform_token_at_model" {
                    (
                        "/v1/models".to_string(),
                        identity::MODEL_AUD,
                        Method::GET,
                        Vec::new(),
                        None,
                    )
                } else {
                    if kind != "valid" {
                        self.transport.set_harness_proof_fault(kind).await?;
                    }
                    (
                        "/api/v1/member/me".to_string(),
                        identity::PLATFORM_AUD,
                        Method::GET,
                        Vec::new(),
                        None,
                    )
                };
                let response = self
                    .transport
                    .send(
                        &key,
                        Some(&credential.access_token),
                        audience,
                        method,
                        &path,
                        &body,
                        "application/json",
                        business_key.as_deref(),
                    )
                    .await?;
                self.current(epoch).await?;
                Ok(
                    json!({"httpStatus":response.status,"accepted":(200..300).contains(&response.status),"code":response.error}),
                )
            }
            _ => Err("platform_harness_invalid_fault".into()),
        }
    }
}
