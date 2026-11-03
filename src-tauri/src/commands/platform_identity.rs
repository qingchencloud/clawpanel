//! 官网原生秘密边界：系统凭据库、P-256 身份与固定目的地 DPoP 传输。
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use rand::{rngs::OsRng, RngCore};
use reqwest::{header::HeaderMap, Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use zeroize::Zeroizing;

pub const PLATFORM_AUD: &str = "clawpanel-platform";
pub const MODEL_AUD: &str = "clawpanel-model-gateway";

pub fn random_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn digest(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes.as_ref()))
}

pub fn origin() -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("CLAWPANEL_PLATFORM_ORIGIN") {
        let url = Url::parse(&value).map_err(|_| "invalid_platform_origin")?;
        let literal = url
            .host_str()
            .and_then(|v| v.parse::<std::net::IpAddr>().ok());
        if url.scheme() != "http"
            || !literal.is_some_and(|ip| ip.is_loopback())
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid_platform_origin".into());
        }
        return Ok(url.origin().ascii_serialization());
    }
    Ok(super::super::site_api::SITE_BASE_URL.to_string())
}

pub fn isolated_debug_enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        let isolated = std::env::var_os("CLAWPANEL_PLATFORM_STATE_DIR")
            .map(PathBuf::from)
            .is_some_and(|p| p.is_absolute());
        isolated
            && std::env::var_os("CLAWPANEL_PLATFORM_NAMESPACE").is_some()
            && std::env::var_os("CLAWPANEL_PLATFORM_ORIGIN").is_some()
            && origin().is_ok()
    }
    #[cfg(not(debug_assertions))]
    false
}

pub fn state_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("CLAWPANEL_PLATFORM_STATE_DIR") {
        let path = PathBuf::from(value);
        if !path.is_absolute() || !isolated_debug_enabled() {
            return Err("invalid_platform_state_directory".into());
        }
        return Ok(path);
    }
    let installation = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| digest(p.to_string_lossy().as_bytes())))
        .ok_or("platform_storage_unavailable")?;
    dirs::data_local_dir()
        .map(|p| p.join("ClawPanel").join("platform").join(installation))
        .ok_or_else(|| "platform_storage_unavailable".into())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Credential {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub refresh_expires_at: String,
    pub scope: String,
    pub session_id: String,
    pub device_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Vault {
    pub private_key: String,
    pub epoch: u64,
    pub member_id: Option<String>,
    pub bound_device: Option<String>,
    pub credential: Option<Credential>,
    pub pending_revoke: Option<Credential>,
    #[serde(default)]
    pub pending_revocations: Vec<Credential>,
    #[serde(default)]
    pub refresh_pending: bool,
    #[serde(default)]
    pub outstanding_operation: Option<String>,
    #[serde(default)]
    pub model_issue_pending_until: i64,
    #[serde(default)]
    pub retry_after_until: i64,
}

impl Vault {
    pub fn fresh() -> Self {
        let key = SigningKey::random(&mut OsRng);
        Self {
            private_key: URL_SAFE_NO_PAD.encode(key.to_bytes()),
            epoch: 1,
            member_id: None,
            bound_device: None,
            credential: None,
            pending_revoke: None,
            pending_revocations: Vec::new(),
            refresh_pending: false,
            outstanding_operation: None,
            model_issue_pending_until: 0,
            retry_after_until: 0,
        }
    }
    pub fn key(&self) -> Result<SigningKey, String> {
        let bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&self.private_key)
                .map_err(|_| "platform_key_unavailable")?,
        );
        SigningKey::from_slice(&bytes).map_err(|_| "platform_key_unavailable".into())
    }

    pub fn enqueue_revocation(&mut self, credential: Credential) {
        if self
            .pending_revoke
            .as_ref()
            .is_some_and(|v| v.session_id == credential.session_id)
            || self
                .pending_revocations
                .iter()
                .any(|v| v.session_id == credential.session_id)
        {
            return;
        }
        if self.pending_revoke.is_none() {
            self.pending_revoke = Some(credential);
        } else {
            self.pending_revocations.push(credential);
        }
    }

    pub fn confirm_revocation(&mut self, family: &str) {
        if self
            .pending_revoke
            .as_ref()
            .is_some_and(|v| v.session_id == family)
        {
            self.pending_revoke = None;
        }
        self.pending_revocations.retain(|v| v.session_id != family);
    }
}

impl Drop for Credential {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.private_key.zeroize();
    }
}

pub struct SecureStore {
    entry: keyring::Entry,
}
impl SecureStore {
    pub fn new(origin: &str, dir: &std::path::Path) -> Result<Self, String> {
        let namespace = if cfg!(debug_assertions) {
            std::env::var("CLAWPANEL_PLATFORM_NAMESPACE").unwrap_or_default()
        } else {
            String::new()
        };
        let name = digest(format!("{origin}|{}|{namespace}", dir.display()));
        let entry = keyring::Entry::new("ClawPanel.Platform.v1", &name)
            .map_err(|_| "platform_storage_unavailable")?;
        Ok(Self { entry })
    }
    pub fn load(&self) -> Result<Option<Vault>, String> {
        let bytes = match self.entry.get_secret() {
            Ok(value) => Zeroizing::new(value),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err("platform_storage_unavailable".into()),
        };
        let vault: Vault =
            serde_json::from_slice(&bytes).map_err(|_| "platform_storage_corrupt")?;
        vault.key()?;
        Ok(Some(vault))
    }
    pub fn save(&self, vault: &Vault) -> Result<(), String> {
        let bytes =
            Zeroizing::new(serde_json::to_vec(vault).map_err(|_| "platform_storage_corrupt")?);
        self.entry
            .set_secret(&bytes)
            .map_err(|_| "platform_storage_unavailable".into())
    }
}

pub fn public_jwk(key: &SigningKey) -> Value {
    let point = key.verifying_key().to_encoded_point(false);
    json!({"kty":"EC","crv":"P-256","x":URL_SAFE_NO_PAD.encode(point.x().unwrap()),"y":URL_SAFE_NO_PAD.encode(point.y().unwrap())})
}
pub fn thumbprint(key: &SigningKey) -> String {
    // RFC 7638 的成员顺序固定，不依赖 JSON map 的插入顺序。
    let jwk = public_jwk(key);
    digest(format!(
        "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
        jwk["x"].as_str().unwrap(),
        jwk["y"].as_str().unwrap()
    ))
}
fn proof(
    key: &SigningKey,
    method: &Method,
    mut url: Url,
    token: Option<&str>,
    nonce: Option<&str>,
) -> String {
    url.set_query(None);
    url.set_fragment(None);
    let header = json!({"typ":"dpop+jwt","alg":"ES256","jwk":public_jwk(key)});
    let mut claims = json!({"htm":method.as_str(),"htu":url.as_str(),"iat":chrono::Utc::now().timestamp(),"jti":random_id()});
    if let Some(value) = token {
        claims["ath"] = json!(digest(value));
    }
    if let Some(value) = nonce {
        claims["nonce"] = json!(value);
    }
    let signing = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    let signature: Signature = key.sign(signing.as_bytes());
    format!("{signing}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub struct WireResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub response: Option<Response>,
    pub error: Option<String>,
}
#[cfg(debug_assertions)]
type WireReporter = std::sync::Arc<dyn Fn(Value) + Send + Sync>;
#[cfg(debug_assertions)]
#[derive(Default)]
struct HarnessProofs {
    next: Option<String>,
    previous: std::collections::HashMap<String, Zeroizing<String>>,
}
pub struct Transport {
    pub client: Client,
    pub origin: String,
    nonces: tokio::sync::Mutex<std::collections::HashMap<String, String>>,
    #[cfg(debug_assertions)]
    wire_reporter: std::sync::RwLock<Option<WireReporter>>,
    #[cfg(debug_assertions)]
    harness_proofs: tokio::sync::Mutex<HarnessProofs>,
}
impl Transport {
    pub fn new(origin: String) -> Result<Self, String> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .http1_only()
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| "platform_transport_unavailable")?;
        Ok(Self {
            client,
            origin,
            nonces: tokio::sync::Mutex::new(Default::default()),
            #[cfg(debug_assertions)]
            wire_reporter: std::sync::RwLock::new(None),
            #[cfg(debug_assertions)]
            harness_proofs: tokio::sync::Mutex::new(Default::default()),
        })
    }
    #[cfg(debug_assertions)]
    pub fn set_wire_reporter(&self, reporter: WireReporter) {
        if isolated_debug_enabled() {
            *self.wire_reporter.write().unwrap() = Some(reporter);
        }
    }
    #[cfg(debug_assertions)]
    fn wire(&self, event: Value) {
        let report = self.wire_reporter.read().unwrap().clone();
        if let Some(report) = report {
            report(event);
        }
    }
    #[cfg(debug_assertions)]
    pub(super) fn engine_trace(&self, event: Value) {
        if super::harness::enabled() {
            self.wire(event);
        }
    }
    #[cfg(debug_assertions)]
    pub(super) async fn set_harness_proof_fault(&self, kind: &str) -> Result<(), String> {
        if !super::harness::enabled()
            || ![
                "wrong_htu",
                "wrong_htm",
                "wrong_ath",
                "missing_ath",
                "stale_iat",
                "future_iat",
                "replay",
            ]
            .contains(&kind)
        {
            return Err("platform_harness_invalid_fault".into());
        }
        self.harness_proofs.lock().await.next = Some(kind.to_string());
        Ok(())
    }
    #[cfg(debug_assertions)]
    async fn harness_proof(
        &self,
        key: &SigningKey,
        url: &Url,
        audience: &str,
        original: String,
    ) -> Result<String, String> {
        if !super::harness::enabled() {
            return Ok(original);
        }
        let cache_key = format!("{audience}|{}", url.path());
        let mut harness = self.harness_proofs.lock().await;
        let kind = harness.next.take();
        if kind.as_deref() == Some("replay") {
            return harness
                .previous
                .get(&cache_key)
                .map(|value| value.to_string())
                .ok_or_else(|| "platform_harness_no_previous_proof".into());
        }
        if let Some(kind) = kind {
            // 只改自有安装签出的负向proof；真实OAuth token保持原样且不交给测试器。
            let parts: Vec<_> = original.split('.').collect();
            let bytes = URL_SAFE_NO_PAD
                .decode(parts[1])
                .map_err(|_| "platform_harness_invalid_fault")?;
            let mut claims: Value =
                serde_json::from_slice(&bytes).map_err(|_| "platform_harness_invalid_fault")?;
            match kind.as_str() {
                "wrong_htu" => claims["htu"] = json!(format!("{}/invalid-proof-path", self.origin)),
                "wrong_htm" => claims["htm"] = json!("POST"),
                "wrong_ath" => claims["ath"] = json!(digest("isolated-negative-ath")),
                "missing_ath" => {
                    claims
                        .as_object_mut()
                        .ok_or("platform_harness_invalid_fault")?
                        .remove("ath");
                }
                "stale_iat" => claims["iat"] = json!(chrono::Utc::now().timestamp() - 600),
                "future_iat" => claims["iat"] = json!(chrono::Utc::now().timestamp() + 600),
                _ => return Err("platform_harness_invalid_fault".into()),
            }
            let signing = format!(
                "{}.{}",
                parts[0],
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
            );
            let signature: Signature = key.sign(signing.as_bytes());
            return Ok(format!(
                "{signing}.{}",
                URL_SAFE_NO_PAD.encode(signature.to_bytes())
            ));
        }
        if harness.previous.len() >= 64 {
            harness.previous.clear();
        }
        harness
            .previous
            .insert(cache_key, Zeroizing::new(original.clone()));
        Ok(original)
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        &self,
        key: &SigningKey,
        token: Option<&str>,
        audience: &str,
        method: Method,
        path: &str,
        body: &[u8],
        content_type: &str,
        business_key: Option<&str>,
    ) -> Result<WireResponse, String> {
        let challenge_status = if token.is_some() { 401 } else { 400 };
        self.send_request(
            key,
            token,
            audience,
            method,
            path,
            body,
            content_type,
            business_key,
            challenge_status,
        )
        .await
    }

    // 一次连接只证明本机持钥；此入口没有 token 参数，也不继承资源请求的身份头。
    pub async fn send_connection(
        &self,
        key: &SigningKey,
        method: Method,
        path: &str,
        body: &[u8],
        business_key: Option<&str>,
    ) -> Result<WireResponse, String> {
        let root = "/api/v1/desktop-connections";
        let item = path.strip_prefix(&format!("{root}/")).is_some_and(|id| {
            id.starts_with("connect_") && super::safe_id(id) && !id.contains('/')
        });
        if !(method == Method::POST && path == root && business_key.is_some()
            || method == Method::GET && item && body.is_empty() && business_key.is_none()
            || method == Method::DELETE && item && body.is_empty() && business_key.is_some())
        {
            return Err("invalid_platform_path".into());
        }
        self.send_request(
            key,
            None,
            PLATFORM_AUD,
            method,
            path,
            body,
            "application/json",
            business_key,
            401,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_request(
        &self,
        key: &SigningKey,
        token: Option<&str>,
        audience: &str,
        method: Method,
        path: &str,
        body: &[u8],
        content_type: &str,
        business_key: Option<&str>,
        challenge_status: u16,
    ) -> Result<WireResponse, String> {
        let url =
            Url::parse(&format!("{}{path}", self.origin)).map_err(|_| "invalid_platform_path")?;
        if url.origin().ascii_serialization() != self.origin {
            return Err("invalid_platform_path".into());
        }
        let nonce_key = format!("{}|{audience}", thumbprint(key));
        #[cfg(debug_assertions)]
        let group = random_id();
        for attempt in 0..=1 {
            #[cfg(debug_assertions)]
            let trace = |phase: &str, status: Option<u16>, challenge: bool, will_retry: bool| {
                self.wire(json!({"groupId":group,"phase":phase,"method":method.as_str(),"path":url.path(),"audience":audience,"attemptIndex":attempt,"status":status,"nonceChallenge":challenge,"willRetry":will_retry}))
            };
            let nonce = self.nonces.lock().await.get(&nonce_key).cloned();
            let dpop = proof(key, &method, url.clone(), token, nonce.as_deref());
            #[cfg(debug_assertions)]
            let dpop = self.harness_proof(key, &url, audience, dpop).await?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .header("DPoP", dpop)
                .header("Accept", "application/json, text/event-stream");
            if let Some(token) = token {
                request = request.header("Authorization", format!("DPoP {token}"));
            }
            if let Some(value) = business_key {
                request = request.header("Idempotency-Key", value);
            }
            if method != Method::GET {
                // 不可克隆 stream body + never retry，禁止 HTTP 库内部隐式重放。
                let fixed = body.to_vec();
                let len = fixed.len();
                request = request
                    .header("Content-Type", content_type)
                    .header("Content-Length", len)
                    .body(reqwest::Body::wrap_stream(futures_util::stream::once(
                        async move { Ok::<_, std::io::Error>(fixed) },
                    )));
            }
            #[cfg(debug_assertions)]
            trace("attempt", None, false, false);
            let response = request.send().await.map_err(|_| {
                #[cfg(debug_assertions)]
                trace("network_error", None, false, false);
                "platform_offline"
            })?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            if (200..300).contains(&status) {
                #[cfg(debug_assertions)]
                trace("response", Some(status), false, false);
                return Ok(WireResponse {
                    status,
                    headers,
                    response: Some(response),
                    error: None,
                });
            }
            // 已受理模型请求优先把响应头交给 journal，不能等错误正文读取完成。
            if path == "/v1/chat/completions"
                && (headers.contains_key("X-Model-Request-ID") || headers.contains_key("Location"))
            {
                #[cfg(debug_assertions)]
                trace("response", Some(status), false, false);
                return Ok(WireResponse {
                    status,
                    headers,
                    response: Some(response),
                    error: None,
                });
            }
            let bytes = match bounded_body(response, 1024 * 1024).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    #[cfg(debug_assertions)]
                    trace("response", Some(status), false, false);
                    return Ok(WireResponse {
                        status,
                        headers,
                        response: None,
                        error: Some(error),
                    });
                }
            };
            let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let code = error_code(&value);
            #[cfg(debug_assertions)]
            trace(
                "response",
                Some(status),
                status == challenge_status && code == "use_dpop_nonce",
                attempt == 0
                    && status == challenge_status
                    && code == "use_dpop_nonce"
                    && headers
                        .get("DPoP-Nonce")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| !v.is_empty() && v.len() <= 1024),
            );
            if attempt == 0 && status == challenge_status && code == "use_dpop_nonce" {
                if let Some(nonce) = headers
                    .get("DPoP-Nonce")
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| !v.is_empty() && v.len() <= 1024)
                {
                    self.nonces
                        .lock()
                        .await
                        .insert(nonce_key.clone(), nonce.to_string());
                    continue;
                }
            }
            return Ok(WireResponse {
                status,
                headers,
                response: None,
                error: Some(code),
            });
        }
        Err("use_dpop_nonce".into())
    }
}
pub fn error_code(value: &Value) -> String {
    let code = value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .unwrap_or("platform_request_failed");
    if code.len() <= 96
        && code
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'_')
    {
        code.to_string()
    } else {
        "platform_request_failed".into()
    }
}
pub async fn bounded_body(response: Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "platform_response_incomplete")?;
        if bytes.len() + chunk.len() > limit {
            return Err("platform_response_too_large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub async fn json_response(mut wire: WireResponse) -> Result<Value, String> {
    if let Some(code) = wire.error {
        return Err(code);
    }
    let response = wire.response.take().ok_or("platform_response_incomplete")?;
    let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| "platform_response_invalid".into())
}
