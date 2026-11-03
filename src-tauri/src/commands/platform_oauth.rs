//! 系统浏览器 PKCE、严格 loopback callback、显式绑定与 family 生命周期。
use super::{
    identity::{self, Credential, PLATFORM_AUD},
    only_args, project, safe_id, Platform,
};
use p256::ecdsa::SigningKey;
use reqwest::{Method, Url};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const INITIAL_SCOPES: &str = "profile:read devices:read devices:bind wallet:read referrals:read";
const BOUND_SCOPES:&str="profile:read devices:read devices:bind devices:revoke wallet:read referrals:read model_sessions:create model_requests:read model_requests:cancel";

pub(super) struct PendingConnection {
    pub epoch: u64,
    pub id: String,
    pub cancel_key: String,
}

enum ConnectionCapability {
    Legacy,
    OneConnect,
}

pub(super) fn language(args: &Value) -> Result<Option<&str>, String> {
    match args.get("language") {
        None => Ok(None),
        Some(Value::String(value)) if matches!(value.as_str(), "zh" | "en") => Ok(Some(value)),
        _ => Err("invalid_platform_arguments".into()),
    }
}

fn desktop_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn connection_id(value: &Value) -> Result<&str, String> {
    value["connection_id"]
        .as_str()
        .filter(|id| id.len() == 32 && id.starts_with("connect_") && safe_id(id))
        .ok_or_else(|| "platform_connection_response_invalid".into())
}

fn expires_at(value: &Value) -> Result<i64, String> {
    value["expires_at"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp())
        .ok_or_else(|| "platform_connection_response_invalid".into())
}

async fn connection_json(
    platform: &Platform,
    epoch: u64,
    response: identity::WireResponse,
) -> Result<Value, String> {
    if response.status == 429 || response.status == 503 {
        platform
            .capture_retry_after(epoch, &response.headers)
            .await?;
    }
    if response.error.is_none()
        && !response
            .headers
            .get("cache-control")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|part| part.trim() == "no-store"))
    {
        return Err("platform_connection_response_invalid".into());
    }
    identity::json_response(response).await
}

#[cfg(debug_assertions)]
fn open_headless_tab(port: u16, url: &str) -> Result<bool, String> {
    use std::io::{BufRead, BufReader, Read, Write};
    // 仅显式隔离调试使用回环 CDP；不记录授权 URL 或 DevTools 响应。
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match std::net::TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
        Ok(stream) => stream,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => return Ok(false),
        Err(_) => return Err("platform_browser_unavailable".into()),
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(2))))
        .map_err(|_| "platform_browser_unavailable")?;
    let mut encoded = Url::parse("http://127.0.0.1/").unwrap();
    encoded.query_pairs_mut().append_pair("target", url);
    let query = encoded.query().unwrap().strip_prefix("target=").unwrap();
    let request = format!("PUT /json/new?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "platform_browser_unavailable")?;
    let mut status = String::new();
    BufReader::new(stream.take(512))
        .read_line(&mut status)
        .map_err(|_| "platform_browser_unavailable")?;
    if status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ") {
        Ok(true)
    } else {
        Err("platform_browser_unavailable".into())
    }
}

pub(super) fn open_browser(url: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if identity::isolated_debug_enabled() {
        if let (Some(exe), Some(profile)) = (
            std::env::var_os("CLAWPANEL_PLATFORM_BROWSER_EXE"),
            std::env::var_os("CLAWPANEL_PLATFORM_BROWSER_PROFILE"),
        ) {
            let exe = std::path::PathBuf::from(exe);
            let profile = std::path::PathBuf::from(profile);
            if !exe.is_absolute() || !exe.is_file() || !profile.is_absolute() {
                return Err("platform_browser_unavailable".into());
            }
            let name = exe
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                name.as_str(),
                "chrome.exe" | "msedge.exe" | "chrome" | "chromium" | "microsoft-edge"
            ) {
                return Err("platform_browser_unavailable".into());
            }
            let mut command = std::process::Command::new(exe);
            command
                .arg(format!("--user-data-dir={}", profile.display()))
                .args([
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--remote-debugging-address=127.0.0.1",
                ]);
            // 仅显式隔离调试可后台打开授权页；正式系统浏览器路径不受影响。
            let headless =
                std::env::var("CLAWPANEL_PLATFORM_BROWSER_HEADLESS").as_deref() == Ok("1");
            if headless {
                command.arg("--headless=new");
            }
            if let Ok(port) = std::env::var("CLAWPANEL_PLATFORM_BROWSER_CDP_PORT") {
                let port: u16 = port
                    .parse()
                    .ok()
                    .filter(|v| *v >= 1024)
                    .ok_or("platform_browser_unavailable")?;
                command.arg(format!("--remote-debugging-port={port}"));
                if headless && open_headless_tab(port, &url)? {
                    return Ok(());
                }
            }
            command
                .arg(url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            command
                .spawn()
                .map_err(|_| "platform_browser_unavailable")?;
            return Ok(());
        }
    }
    #[cfg(windows)]
    {
        open::that_detached(url).map_err(|_| "platform_browser_unavailable".into())
    }
    #[cfg(not(windows))]
    {
        super::browser::dispatch_commands(open::commands(url))
    }
}

fn form(fields: &[(&str, &str)]) -> Vec<u8> {
    let mut url = Url::parse("http://127.0.0.1/").unwrap();
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in fields {
            pairs.append_pair(k, v);
        }
    }
    url.query().unwrap_or("").as_bytes().to_vec()
}

fn credential(value: Value, device: Option<&str>) -> Result<Credential, String> {
    if value["token_type"] != "DPoP"
        || value["audience"] != PLATFORM_AUD
        || value["expires_in"].as_i64() != Some(300)
        || value["device_id"].as_str() != device
    {
        return Err("platform_oauth_response_invalid".into());
    }
    let get = |field: &str| {
        value[field]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "platform_oauth_response_invalid".to_string())
    };
    let scope = get("scope")?;
    let required = if device.is_some() {
        BOUND_SCOPES
    } else {
        INITIAL_SCOPES
    };
    if required
        .split_whitespace()
        // 收益只读是可选能力；旧family续期缺此scope仍可读取原身份/钱包。
        .filter(|scope| *scope != "referrals:read")
        .any(|s| !scope.split_whitespace().any(|v| v == s))
    {
        return Err("insufficient_scope".into());
    }
    Ok(Credential {
        access_token: get("access_token")?,
        refresh_token: get("refresh_token")?,
        expires_at: chrono::Utc::now().timestamp() + 300,
        refresh_expires_at: get("refresh_expires_at")?,
        scope,
        session_id: get("session_id")?,
        device_id: device.map(str::to_string),
    })
}

pub(super) async fn refresh(
    platform: &Platform,
    key: &SigningKey,
    previous: &Credential,
) -> Result<Credential, String> {
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("client_id", "clawpanel-public"),
        ("refresh_token", &previous.refresh_token),
    ]);
    let response = platform
        .transport
        .send(
            key,
            None,
            PLATFORM_AUD,
            Method::POST,
            "/oauth/token",
            &body,
            "application/x-www-form-urlencoded",
            None,
        )
        .await?;
    let value = identity::json_response(response).await?;
    let next = credential(value, previous.device_id.as_deref())?;
    if next.session_id != previous.session_id {
        return Err("platform_oauth_response_invalid".into());
    }
    Ok(next)
}

async fn revoke(
    platform: &Platform,
    key: &SigningKey,
    credential: &Credential,
) -> Result<(), String> {
    let body = form(&[
        ("client_id", "clawpanel-public"),
        ("token", &credential.refresh_token),
        ("token_type_hint", "refresh_token"),
    ]);
    let response = platform
        .transport
        .send(
            key,
            None,
            PLATFORM_AUD,
            Method::POST,
            "/oauth/revoke",
            &body,
            "application/x-www-form-urlencoded",
            None,
        )
        .await?;
    if response.status != 200 {
        return Err(response
            .error
            .unwrap_or_else(|| "platform_revocation_pending".into()));
    }
    Ok(())
}

async fn validate_metadata(platform: &Platform) -> Result<ConnectionCapability, String> {
    let response = platform
        .transport
        .client
        .get(format!(
            "{}/.well-known/oauth-authorization-server",
            platform.transport.origin
        ))
        .send()
        .await
        .map_err(|_| "platform_offline")?;
    if !response.status().is_success() {
        return Err("platform_oauth_metadata_invalid".into());
    }
    let value: Value = serde_json::from_slice(&identity::bounded_body(response, 64 * 1024).await?)
        .map_err(|_| "platform_oauth_metadata_invalid")?;
    for (field, suffix) in [
        ("issuer", ""),
        ("authorization_endpoint", "/oauth/authorize"),
        ("token_endpoint", "/oauth/token"),
        ("revocation_endpoint", "/oauth/revoke"),
    ] {
        if value[field].as_str() != Some(format!("{}{suffix}", platform.transport.origin).as_str())
        {
            return Err("platform_oauth_metadata_invalid".into());
        }
    }
    for (field, wanted) in [
        ("response_types_supported", "code"),
        ("grant_types_supported", "authorization_code"),
        ("grant_types_supported", "refresh_token"),
        ("token_endpoint_auth_methods_supported", "none"),
        ("revocation_endpoint_auth_methods_supported", "none"),
        ("code_challenge_methods_supported", "S256"),
        ("dpop_signing_alg_values_supported", "ES256"),
    ] {
        if !value[field]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v == wanted))
        {
            return Err("platform_oauth_metadata_invalid".into());
        }
    }
    if value["authorization_response_iss_parameter_supported"] != true {
        return Err("platform_oauth_metadata_invalid".into());
    }
    match (
        value.get("x_clawpanel_desktop_connect_v1"),
        value.get("x_clawpanel_desktop_connection_endpoint"),
    ) {
        (None | Some(Value::Bool(false)), None) => Ok(ConnectionCapability::Legacy),
        (Some(Value::Bool(true)), Some(Value::String(endpoint)))
            if endpoint == &format!("{}/api/v1/desktop-connections", platform.transport.origin) =>
        {
            Ok(ConnectionCapability::OneConnect)
        }
        _ => Err("platform_oauth_metadata_invalid".into()),
    }
}

async fn callback(
    platform: &Platform,
    epoch: u64,
    listener: TcpListener,
    state: &str,
    deadline: Instant,
) -> Result<String, String> {
    let local = listener
        .local_addr()
        .map_err(|_| "platform_callback_unavailable")?;
    let expected_host = local.to_string();
    loop {
        platform.current(epoch).await?;
        if Instant::now() >= deadline {
            return Err("platform_authorization_timeout".into());
        }
        let accepted = tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
        let Ok(Ok((mut socket, peer))) = accepted else {
            continue;
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let read = async {
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while request.len() < 8192 {
                let n = socket.read(&mut byte).await.map_err(|_| ())?;
                if n == 0 {
                    break;
                }
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            String::from_utf8(request).map_err(|_| ())
        };
        let request = tokio::time::timeout(Duration::from_secs(3), read)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        platform.current(epoch).await?;
        if Instant::now() >= deadline {
            return Err("platform_authorization_timeout".into());
        }
        let result = validate_callback(&request, &expected_host, &platform.transport.origin, state);
        let outcome = match result.as_ref() {
            Ok(_) => super::callback_page::Outcome::Received,
            Err(error) if error == "platform_authorization_denied" => {
                super::callback_page::Outcome::Denied
            }
            Err(_) => super::callback_page::Outcome::Rejected,
        };
        // 只把浏览器首个支持的语言映射为固定布尔值，不回显请求头。
        let english = request
            .split("\r\n")
            .skip(1)
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("Accept-Language"))
            .and_then(|(_, value)| {
                value.split(',').find_map(|range| {
                    let language = range.split(';').next()?.trim().split('-').next()?;
                    if language.eq_ignore_ascii_case("en") {
                        Some(true)
                    } else if language.eq_ignore_ascii_case("zh") {
                        Some(false)
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(false);
        let response = super::callback_page::response(outcome, english);
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
        platform.current(epoch).await?;
        if result.is_ok()
            || result
                .as_ref()
                .is_err_and(|error| error == "platform_authorization_denied")
        {
            return result;
        }
    }
}

fn validate_callback(
    request: &str,
    host: &str,
    origin: &str,
    state: &str,
) -> Result<String, String> {
    let fail = || "platform_callback_rejected".to_string();
    // 有界读取到上限或对方提前断开时，不能把截断的请求头前缀当作有效回调。
    if !request.ends_with("\r\n\r\n") {
        return Err(fail());
    }
    let mut lines = request.split("\r\n");
    let first = lines.next().ok_or_else(fail)?;
    let pieces: Vec<_> = first.split(' ').collect();
    if pieces.len() != 3
        || pieces[0] != "GET"
        || pieces[2] != "HTTP/1.1"
        || !pieces[1].starts_with("/oauth/callback?")
        || pieces[1].contains('#')
    {
        return Err(fail());
    }
    let mut hosts = 0;
    let mut origins = 0;
    for line in lines.take_while(|v| !v.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(fail)?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("Host") {
            hosts += 1;
            if value != host {
                return Err(fail());
            }
        }
        if name.eq_ignore_ascii_case("Origin") {
            origins += 1;
            if value != origin {
                return Err(fail());
            }
        }
        if name.eq_ignore_ascii_case("Transfer-Encoding")
            || (name.eq_ignore_ascii_case("Content-Length") && value != "0")
        {
            return Err(fail());
        }
    }
    if hosts != 1 || origins > 1 {
        return Err(fail());
    }
    let url = Url::parse(&format!("http://{host}{}", pieces[1])).map_err(|_| fail())?;
    if url.path() != "/oauth/callback" {
        return Err(fail());
    }
    let mut params = HashMap::new();
    for (k, v) in url.query_pairs() {
        if !["code", "state", "iss", "error"].contains(&k.as_ref())
            || params.insert(k.to_string(), v.to_string()).is_some()
        {
            return Err(fail());
        }
    }
    if params.get("state").map(String::as_str) != Some(state)
        || params.get("iss").map(String::as_str) != Some(origin)
    {
        return Err(fail());
    }
    if params.contains_key("error") {
        if params.contains_key("code")
            || params.len() != 3
            || params.get("error").map(String::as_str) != Some("access_denied")
        {
            return Err(fail());
        }
        return Err("platform_authorization_denied".into());
    }
    if params.len() != 3 {
        return Err(fail());
    }
    params
        .remove("code")
        .filter(|v| !v.is_empty() && v.len() <= 1024)
        .ok_or_else(fail)
}

async fn authorize(
    platform: &Arc<Platform>,
    epoch: u64,
    device: Option<&str>,
) -> Result<Credential, String> {
    #[cfg(debug_assertions)]
    let callback_port = platform.harness_callback_port().await;
    #[cfg(not(debug_assertions))]
    let callback_port = 0;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, callback_port))
        .await
        .map_err(|_| "platform_callback_unavailable")?;
    let redirect = format!(
        "http://{}/oauth/callback",
        listener
            .local_addr()
            .map_err(|_| "platform_callback_unavailable")?
    );
    validate_metadata(platform).await?;
    let key = {
        let state = platform.state.lock().await;
        state
            .vault
            .as_ref()
            .ok_or("platform_key_unavailable")?
            .key()?
    };
    let state = identity::random_id();
    let verifier = zeroize::Zeroizing::new(identity::random_id());
    let challenge = identity::digest(verifier.as_bytes());
    let mut url = Url::parse(&format!("{}/oauth/authorize", platform.transport.origin))
        .map_err(|_| "invalid_platform_origin")?;
    {
        let mut query = url.query_pairs_mut();
        for (k, v) in [
            ("response_type", "code"),
            ("client_id", "clawpanel-public"),
            ("redirect_uri", redirect.as_str()),
            (
                "scope",
                if device.is_some() {
                    BOUND_SCOPES
                } else {
                    INITIAL_SCOPES
                },
            ),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("dpop_jkt", identity::thumbprint(&key).as_str()),
        ] {
            query.append_pair(k, v);
        }
        if let Some(device) = device {
            query.append_pair("device_id", device);
        }
    }
    platform.current(epoch).await?;
    platform.open(url.to_string()).await?;
    let code = zeroize::Zeroizing::new(
        callback(
            platform,
            epoch,
            listener,
            &state,
            Instant::now() + Duration::from_secs(300),
        )
        .await?,
    );
    platform.current(epoch).await?;
    let body = zeroize::Zeroizing::new(form(&[
        ("grant_type", "authorization_code"),
        ("client_id", "clawpanel-public"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ]));
    #[cfg(debug_assertions)]
    platform.harness_remember_code(&body).await;
    let response = platform
        .transport
        .send(
            &key,
            None,
            PLATFORM_AUD,
            Method::POST,
            "/oauth/token",
            &body,
            "application/x-www-form-urlencoded",
            None,
        )
        .await?;
    let cache = response
        .headers
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if response.error.is_none() && !cache.contains("no-store") {
        return Err("platform_oauth_response_invalid".into());
    }
    credential(identity::json_response(response).await?, device)
}

impl Platform {
    async fn delete_connection(&self, connection: &PendingConnection) {
        let key = self
            .state
            .lock()
            .await
            .vault
            .as_ref()
            .and_then(|vault| vault.key().ok());
        if let Some(key) = key {
            // 本机交易已经关闭；取消失败也不能恢复旧监听或撤销已有账号。
            let _ = tokio::time::timeout(
                Duration::from_secs(10),
                self.transport.send_connection(
                    &key,
                    Method::DELETE,
                    &format!("/api/v1/desktop-connections/{}", connection.id),
                    &[],
                    Some(&connection.cancel_key),
                ),
            )
            .await;
        }
    }

    pub(super) async fn cancel_login(self: &Arc<Self>) -> Result<Value, String> {
        // 等待已发送的轮换落盘后再关闭 epoch，不能丢掉结果并留下可重放的旧 refresh。
        let refresh_guard = self.refresh_lock.lock().await;
        let pending = {
            let mut state = self.state.lock().await;
            state.epoch += 1;
            let epoch = state.epoch;
            let phase = match state
                .vault
                .as_ref()
                .and_then(|vault| vault.credential.as_ref())
            {
                Some(credential) if credential.device_id.is_some() => "bound",
                Some(_) => "logged_in",
                None => "guest",
            };
            if let Some(vault) = state.vault.as_mut() {
                let mut next = vault.clone();
                next.epoch = epoch;
                self.save_vault(&next)?;
                *vault = next;
            }
            state.phase = phase.into();
            state.error = None;
            if !state.connection.is_null() {
                state.connection["status"] = json!("cancelled");
            }
            state.pending_connection.take()
        };
        drop(refresh_guard);
        self.emit_snapshot().await;
        if let Some(pending) = pending {
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                this.delete_connection(&pending).await;
            });
        }
        Ok(self.snapshot().await)
    }

    async fn set_connection(&self, epoch: u64, value: &Value, interval: u64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        state.connection = project(value, &["connection_id", "status", "expires_at"]);
        state.connection["poll_interval_seconds"] = json!(interval);
        drop(state);
        self.emit_snapshot().await;
        Ok(())
    }

    async fn poll_connection(
        &self,
        epoch: u64,
        key: &SigningKey,
        id: &str,
        expires: i64,
        interval: u64,
        deadline: Instant,
    ) -> Result<(), String> {
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            self.current(epoch).await?;
            if Instant::now() >= deadline {
                return Err("platform_authorization_timeout".into());
            }
            let response = self
                .transport
                .send_connection(
                    key,
                    Method::GET,
                    &format!("/api/v1/desktop-connections/{id}"),
                    &[],
                    None,
                )
                .await?;
            if response.status != 200 {
                if matches!(response.status, 429 | 503) {
                    let _ = self.capture_retry_after(epoch, &response.headers).await;
                }
                return Err(response
                    .error
                    .clone()
                    .unwrap_or_else(|| "platform_connection_response_invalid".into()));
            }
            let value = connection_json(self, epoch, response).await?;
            if connection_id(&value)? != id || expires_at(&value)? != expires {
                return Err("platform_connection_response_invalid".into());
            }
            let status = value["status"]
                .as_str()
                .ok_or("platform_connection_response_invalid")?;
            if !matches!(
                status,
                "pending" | "approved" | "redeemed" | "rejected" | "cancelled" | "expired"
            ) || value["device_id"].as_str().is_some_and(|id| !safe_id(id))
            {
                return Err("platform_connection_response_invalid".into());
            }
            self.set_connection(epoch, &value, interval).await?;
            match status {
                "pending" | "approved" | "redeemed" => {}
                "rejected" => return Err("platform_authorization_denied".into()),
                "cancelled" => return Err("platform_connection_cancelled".into()),
                "expired" => return Err("platform_authorization_timeout".into()),
                _ => unreachable!(),
            }
        }
    }

    async fn one_connect(
        self: &Arc<Self>,
        epoch: u64,
        device_name: &str,
        language: Option<&str>,
    ) -> Result<(), String> {
        // 上次失败留下的本机 pending 连接先撤销，避免官网 pending 上限挡住重试。
        let stale = {
            let mut state = self.state.lock().await;
            state.pending_connection.take()
        };
        if let Some(stale) = stale {
            let _ = self.delete_connection(&stale).await;
        }
        {
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            state.phase = "authorizing".into();
            state.binding = Value::Null;
        }
        self.emit_snapshot().await;
        #[cfg(debug_assertions)]
        let callback_port = self.harness_callback_port().await;
        #[cfg(not(debug_assertions))]
        let callback_port = 0;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, callback_port))
            .await
            .map_err(|_| "platform_callback_unavailable")?;
        let redirect = format!(
            "http://{}/oauth/callback",
            listener
                .local_addr()
                .map_err(|_| "platform_callback_unavailable")?
        );
        let key = self
            .state
            .lock()
            .await
            .vault
            .as_ref()
            .ok_or("platform_key_unavailable")?
            .key()?;
        let state = identity::random_id();
        let verifier = zeroize::Zeroizing::new(identity::random_id());
        let body = serde_json::to_vec(&json!({"response_type":"code","client_id":"clawpanel-public","redirect_uri":redirect,"scope":BOUND_SCOPES,"state":state,"code_challenge":identity::digest(verifier.as_bytes()),"code_challenge_method":"S256","dpop_jkt":identity::thumbprint(&key),"device_name":device_name,"instance_kind":"desktop","platform":desktop_platform(),"public_jwk":identity::public_jwk(&key)})).map_err(|_| "invalid_platform_arguments")?;
        let started = Instant::now();
        self.current(epoch).await?;
        let response = self
            .transport
            .send_connection(
                &key,
                Method::POST,
                "/api/v1/desktop-connections",
                &body,
                Some(&identity::random_id()),
            )
            .await?;
        if response.status != 201 {
            if matches!(response.status, 429 | 503) {
                let _ = self.capture_retry_after(epoch, &response.headers).await;
            }
            return Err(response
                .error
                .clone()
                .unwrap_or_else(|| "platform_connection_response_invalid".into()));
        }
        let created = connection_json(self, epoch, response).await?;
        let id = connection_id(&created)?.to_string();
        let pending = PendingConnection {
            epoch,
            id: id.clone(),
            cancel_key: identity::random_id(),
        };
        let mut local = self.state.lock().await;
        if local.epoch != epoch {
            drop(local);
            self.delete_connection(&pending).await;
            return Err("platform_account_changed".into());
        }
        local.pending_connection = Some(pending);
        drop(local);
        let result = async {
            let now = chrono::Utc::now().timestamp();
            let expires = expires_at(&created)?;
            let interval = created["poll_interval_seconds"].as_u64().filter(|value| (5..=300).contains(value)).ok_or("platform_connection_response_invalid")?;
            // 服务端与本机时钟可能存在秒级偏差；窗口判断保留容差，超出容差时提示校准时间。
            const CLOCK_SKEW: i64 = 5;
            if created["status"] != "pending" {
                return Err("platform_connection_response_invalid".into());
            }
            if expires <= now - CLOCK_SKEW || expires > now + 300 + CLOCK_SKEW {
                return Err("platform_clock_skew".into());
            }
            let window = (expires - now).clamp(1, 305) as u64;
            let deadline = (started + Duration::from_secs(300))
                .min(Instant::now() + Duration::from_secs(window + CLOCK_SKEW as u64));
            let expected_uri = format!("{}/oauth/connect?connection_id={id}", self.transport.origin);
            if created["browser_authorization_uri"].as_str() != Some(expected_uri.as_str()) { return Err("platform_connection_response_invalid".into()); }
            let mut browser = Url::parse(&expected_uri).map_err(|_| "platform_connection_response_invalid")?;
            if let Some(language) = language { browser.query_pairs_mut().append_pair("lang", language); }
            self.set_connection(epoch, &created, interval).await?;
            self.current(epoch).await?;
            self.open(browser.to_string()).await?;
            let callback = callback(self, epoch, listener, &state, deadline);
            let polling = self.poll_connection(epoch, &key, &id, expires, interval, deadline);
            let code = zeroize::Zeroizing::new(tokio::select! {
                result = callback => result?,
                result = polling => { result?; return Err("platform_connection_response_invalid".into()); },
            });
            self.current(epoch).await?;
            if Instant::now() >= deadline { return Err("platform_authorization_timeout".into()); }
            let body = zeroize::Zeroizing::new(form(&[("grant_type", "authorization_code"), ("client_id", "clawpanel-public"), ("code", &code), ("redirect_uri", &redirect), ("code_verifier", &verifier)]));
            #[cfg(debug_assertions)]
            self.harness_remember_code(&body).await;
            let response = self.transport.send(&key, None, PLATFORM_AUD, Method::POST, "/oauth/token", &body, "application/x-www-form-urlencoded", None).await?;
            if response.error.is_none() && (!response.headers.get("cache-control").and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|part| part.trim() == "no-store")) || !response.headers.get("pragma").and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("no-cache"))) { return Err("platform_oauth_response_invalid".into()); }
            let value = identity::json_response(response).await?;
            let device = value["device_id"].as_str().filter(|id| safe_id(id)).ok_or("platform_oauth_response_invalid")?.to_string();
            let granted = value["scope"].as_str().ok_or("platform_oauth_response_invalid")?;
            let mut scopes = std::collections::HashSet::new();
            if granted.split_whitespace().any(|scope| !BOUND_SCOPES.split_whitespace().any(|allowed| allowed == scope) || !scopes.insert(scope)) { return Err("platform_oauth_response_invalid".into()); }
            let next = credential(value, Some(&device))?;
            if let Err(error) = self.accept_credential(epoch, next.clone()).await {
                let _ = revoke(self, &key, &next).await;
                return Err(error);
            }
            let mut local = self.state.lock().await;
            if local.epoch != epoch { return Err("platform_account_changed".into()); }
            local.connection["status"] = json!("redeemed");
            drop(local);
            self.refresh_snapshot().await?;
            Ok(())
        }.await;
        let pending = {
            let mut local = self.state.lock().await;
            if local
                .pending_connection
                .as_ref()
                .is_some_and(|pending| pending.epoch == epoch)
            {
                local.pending_connection.take()
            } else {
                None
            }
        };
        if result.is_err() {
            if let Some(pending) = pending {
                self.delete_connection(&pending).await;
            }
        }
        result
    }

    pub(super) async fn retry_pending_revocations(self: &Arc<Self>) -> Result<(), String> {
        let (epoch, key, pending) = {
            let state = self.state.lock().await;
            let Some(vault) = state.vault.as_ref() else {
                return Ok(());
            };
            let pending: Vec<Credential> = vault
                .pending_revoke
                .iter()
                .chain(vault.pending_revocations.iter())
                .take(4)
                .cloned()
                .collect();
            if pending.is_empty() {
                return Ok(());
            }
            (state.epoch, vault.key()?, pending)
        };
        // 每次明确恢复最多处理四个已知 family，不循环网络错误，也不改变绑定归属。
        for credential in pending {
            self.current(epoch).await?;
            if revoke(self, &key, &credential).await.is_err() {
                break;
            }
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            if let Some(vault) = state.vault.as_mut() {
                vault.confirm_revocation(&credential.session_id);
                self.save_vault(vault)?;
            }
        }
        Ok(())
    }

    pub(super) async fn begin_login(
        self: &Arc<Self>,
        device_name: Option<&str>,
        language: Option<&str>,
    ) -> Result<Value, String> {
        self.load(true).await?;
        self.retry_pending_revocations().await?;
        let device_name = device_name
            .unwrap_or(if cfg!(windows) {
                "ClawPanel on Windows"
            } else if cfg!(target_os = "macos") {
                "ClawPanel on macOS"
            } else {
                "ClawPanel on Linux"
            })
            .trim()
            .to_string();
        if device_name.is_empty() || device_name.len() > 80 {
            return Err("invalid_device_name".into());
        }
        let language = language.map(str::to_string);
        let refresh_guard = self.refresh_lock.lock().await;
        let bound = self
            .state
            .lock()
            .await
            .vault
            .as_ref()
            .and_then(|vault| vault.credential.as_ref())
            .is_some_and(|credential| credential.device_id.is_some());
        if bound {
            drop(refresh_guard);
            return self.refresh_snapshot().await;
        }
        let epoch = {
            let mut state = self.state.lock().await;
            if matches!(
                state.phase.as_str(),
                "authorizing" | "binding" | "reauthorizing"
            ) {
                return Err("platform_authorization_in_progress".into());
            }
            state.epoch += 1;
            state.error = None;
            state.connection = Value::Null;
            let epoch = state.epoch;
            let vault = state.vault.as_mut().ok_or("platform_key_unavailable")?;
            vault.epoch = epoch;
            self.save_vault(vault)?;
            let device = vault.bound_device.clone();
            state.phase = if device.is_some() {
                "reauthorizing"
            } else {
                "authorizing"
            }
            .into();
            epoch
        };
        drop(refresh_guard);
        self.emit_snapshot().await;
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                if matches!(
                    validate_metadata(&this).await?,
                    ConnectionCapability::OneConnect
                ) {
                    return this
                        .one_connect(epoch, &device_name, language.as_deref())
                        .await;
                }
                // 只有受信 metadata 明确缺能力才进入旧链；已有初始凭据不先删除。
                let initial = this
                    .state
                    .lock()
                    .await
                    .vault
                    .as_ref()
                    .is_some_and(|vault| vault.credential.is_some());
                // 旧设备可能已在官网撤销，先完成无设备的本人授权，再核对原绑定。
                if !initial {
                    let credential = authorize(&this, epoch, None).await?;
                    this.accept_credential(epoch, credential).await?;
                }
                let active_device = {
                    let state = this.state.lock().await;
                    if state.epoch != epoch {
                        return Err("platform_account_changed".into());
                    }
                    state
                        .vault
                        .as_ref()
                        .and_then(|vault| vault.bound_device.clone())
                };
                if let Some(device) = active_device {
                    let credential = authorize(&this, epoch, Some(&device)).await?;
                    this.accept_credential(epoch, credential).await?;
                }
                this.refresh_snapshot().await?;
                Ok::<_, String>(())
            }
            .await;
            if let Err(e) = result {
                this.fail(epoch, &e).await;
            }
        });
        Ok(self.snapshot().await)
    }

    async fn accept_credential(
        self: &Arc<Self>,
        epoch: u64,
        credential: Credential,
    ) -> Result<(), String> {
        let _refresh_guard = self.refresh_lock.lock().await;
        // 保存前用新 family 读取身份，二次授权不得把另一个账号写入原安装。
        let key = {
            let state = self.state.lock().await;
            state
                .vault
                .as_ref()
                .ok_or("platform_key_unavailable")?
                .key()?
        };
        let me = identity::json_response(
            self.transport
                .send(
                    &key,
                    Some(&credential.access_token),
                    PLATFORM_AUD,
                    Method::GET,
                    "/api/v1/member/me",
                    &[],
                    "application/json",
                    None,
                )
                .await?,
        )
        .await?;
        let member = me["member_id"]
            .as_str()
            .filter(|v| safe_id(v))
            .ok_or("platform_oauth_response_invalid")?;
        if let Some(device) = credential.device_id.as_deref() {
            if me["device_id"].as_str() != Some(device)
                || me["binding_required"] != false
                || me["status"] != "active"
            {
                return Err("platform_oauth_response_invalid".into());
            }
        }
        let retained_device = {
            let state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            let vault = state.vault.as_ref().ok_or("platform_key_unavailable")?;
            if vault.member_id.as_deref().is_some_and(|v| v != member)
                && vault.bound_device.is_some()
            {
                return Err("platform_installation_account_mismatch".into());
            }
            if credential.device_id.is_none() {
                vault.bound_device.clone()
            } else {
                None
            }
        };
        let revoked = if let Some(device_id) = retained_device.as_deref() {
            let devices = identity::json_response(
                self.transport
                    .send(
                        &key,
                        Some(&credential.access_token),
                        PLATFORM_AUD,
                        Method::GET,
                        "/api/v1/devices",
                        &[],
                        "application/json",
                        None,
                    )
                    .await?,
            )
            .await?;
            let device = devices["items"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["device_id"] == device_id))
                .ok_or("platform_binding_response_invalid")?;
            if device["jwk_thumbprint"] != identity::thumbprint(&key) {
                return Err("platform_binding_response_invalid".into());
            }
            match device["status"].as_str() {
                Some("revoked") => true,
                Some("active") => false,
                _ => return Err("platform_binding_response_invalid".into()),
            }
        } else {
            false
        };
        let old = {
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                return Err("platform_account_changed".into());
            }
            let mut next = state
                .vault
                .as_ref()
                .ok_or("platform_key_unavailable")?
                .clone();
            let vault = &mut next;
            if vault.member_id.as_deref().is_some_and(|v| v != member)
                && vault.bound_device.is_some()
            {
                return Err("platform_installation_account_mismatch".into());
            }
            let old = vault.credential.clone();
            vault.member_id = Some(member.to_string());
            vault.credential = Some(credential.clone());
            vault.refresh_pending = false;
            if credential.device_id.is_some() {
                vault.bound_device = credential.device_id.clone();
            } else if revoked {
                // 仅同会员、同安装公钥的官网撤销事实可清除本地关联；不重造安装身份。
                vault.bound_device = None;
            }
            if let Some(old) = old.clone() {
                vault.enqueue_revocation(old);
            }
            self.save_vault(vault)?;
            let phase = if credential.device_id.is_some() {
                "bound"
            } else if vault.bound_device.is_some() {
                "reauthorizing"
            } else {
                "logged_in"
            }
            .into();
            state.vault = Some(next);
            state.phase = phase;
            state.member = project(
                &me,
                &[
                    "member_id",
                    "email_masked",
                    "device_id",
                    "binding_required",
                    "eligible_model_ids",
                    "plan_id",
                    "plan_display_name",
                ],
            );
            old
        };
        if let Some(old) = old {
            if revoke(self, &key, &old).await.is_ok() {
                let mut state = self.state.lock().await;
                if state.epoch == epoch {
                    if let Some(v) = state.vault.as_mut() {
                        v.confirm_revocation(&old.session_id);
                        self.save_vault(v)?;
                    }
                }
            }
        }
        self.emit_snapshot().await;
        Ok(())
    }

    pub(super) async fn begin_binding(
        self: &Arc<Self>,
        device_name: &str,
        language: Option<&str>,
    ) -> Result<Value, String> {
        let device_name = device_name.trim().to_string();
        if device_name.is_empty() || device_name.len() > 80 {
            return Err("invalid_device_name".into());
        }
        let language = language.map(str::to_string);
        let refresh_guard = self.refresh_lock.lock().await;
        let epoch = {
            let mut state = self.state.lock().await;
            if state.phase != "logged_in" {
                return Err("platform_binding_not_ready".into());
            }
            state.epoch += 1;
            let epoch = state.epoch;
            let vault = state.vault.as_mut().ok_or("platform_key_unavailable")?;
            let mut next = vault.clone();
            next.epoch = epoch;
            self.save_vault(&next)?;
            *vault = next;
            state.connection = Value::Null;
            state.phase = "binding".into();
            state.error = None;
            state.epoch
        };
        drop(refresh_guard);
        self.emit_snapshot().await;
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                match validate_metadata(&this).await? {
                    ConnectionCapability::OneConnect => {
                        this.one_connect(epoch, &device_name, language.as_deref())
                            .await
                    }
                    ConnectionCapability::Legacy => this.binding_flow(epoch, device_name).await,
                }
            }
            .await;
            if let Err(error) = result {
                this.fail(epoch, &error).await;
            }
        });
        Ok(self.snapshot().await)
    }

    async fn binding_flow(self: &Arc<Self>, epoch: u64, device_name: String) -> Result<(), String> {
        let approved = {
            let state = self.state.lock().await;
            state.vault.as_ref().and_then(|v| v.bound_device.clone())
        };
        if let Some(device) = approved {
            {
                let mut state = self.state.lock().await;
                if state.epoch != epoch {
                    return Err("platform_account_changed".into());
                }
                state.phase = "reauthorizing".into();
            }
            self.emit_snapshot().await;
            let credential = authorize(self, epoch, Some(&device)).await?;
            self.accept_credential(epoch, credential).await?;
            self.refresh_snapshot().await?;
            return Ok(());
        }
        let (key, _) = self.platform_credential(epoch).await?;
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        let body=serde_json::to_vec(&json!({"device_name":device_name,"instance_kind":"desktop","platform":platform,"public_jwk":identity::public_jwk(&key)})).unwrap();
        let intent = self
            .resource(
                epoch,
                Method::POST,
                "/api/v1/devices/binding-intents",
                &body,
                Some(&identity::random_id()),
            )
            .await?;
        let id = intent["intent_id"]
            .as_str()
            .filter(|v| safe_id(v))
            .ok_or("platform_binding_response_invalid")?
            .to_string();
        let expected = format!("{}/member?binding_intent={id}", self.transport.origin);
        if intent["verification_uri"].as_str() != Some(expected.as_str())
            || intent["jwk_thumbprint"] != identity::thumbprint(&key)
        {
            return Err("platform_binding_response_invalid".into());
        }
        self.set_binding(epoch, &intent).await?;
        self.open(expected).await?;
        let expires = intent["expires_at"]
            .as_str()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .ok_or("platform_binding_response_invalid")?
            .timestamp();
        let mut interval = 5u64;
        loop {
            for _ in 0..interval * 4 {
                tokio::time::sleep(Duration::from_millis(250)).await;
                self.current(epoch).await?;
            }
            if chrono::Utc::now().timestamp() >= expires {
                return Err("binding_intent_expired".into());
            }
            let intent = match self
                .resource(
                    epoch,
                    Method::GET,
                    &format!("/api/v1/devices/binding-intents/{id}"),
                    &[],
                    None,
                )
                .await
            {
                Ok(v) => v,
                Err(e) if e == "binding_poll_too_fast" => {
                    interval = 10;
                    continue;
                }
                Err(e) => return Err(e),
            };
            self.set_binding(epoch, &intent).await?;
            match intent["status"].as_str() {
                Some("pending") => continue,
                Some("rejected") => return Err("platform_binding_rejected".into()),
                Some("expired") => return Err("binding_intent_expired".into()),
                Some("approved") => {
                    let device = intent["device_id"]
                        .as_str()
                        .filter(|v| safe_id(v))
                        .ok_or("platform_binding_response_invalid")?;
                    {
                        let mut state = self.state.lock().await;
                        if state.epoch != epoch {
                            return Err("platform_account_changed".into());
                        }
                        // 批准事实先安全保存；用户取消第二次 consent 后可明确继续，不能重新造 intent。
                        let vault = state.vault.as_mut().ok_or("platform_key_unavailable")?;
                        vault.bound_device = Some(device.to_string());
                        self.save_vault(vault)?;
                        state.phase = "reauthorizing".into();
                    }
                    self.emit_snapshot().await;
                    let credential = authorize(self, epoch, Some(device)).await?;
                    self.accept_credential(epoch, credential).await?;
                    self.refresh_snapshot().await?;
                    return Ok(());
                }
                _ => return Err("platform_binding_response_invalid".into()),
            }
        }
    }

    async fn set_binding(&self, epoch: u64, intent: &Value) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.epoch != epoch {
            return Err("platform_account_changed".into());
        }
        state.binding = project(
            intent,
            &[
                "intent_id",
                "status",
                "display_code",
                "expires_at",
                "poll_interval_seconds",
                "jwk_thumbprint",
                "device_name",
                "platform",
                "instance_kind",
                "device_id",
            ],
        );
        drop(state);
        self.emit_snapshot().await;
        Ok(())
    }

    pub(super) async fn logout(
        self: &Arc<Self>,
        local_only: bool,
        unbind: bool,
    ) -> Result<Value, String> {
        only_args(&json!({}), &[])?;
        let (epoch, key, old, device, previous_identity, cancellations, pending_connection) = {
            let mut state = self.state.lock().await;
            let previous_epoch = state.epoch;
            let previous_member = state
                .vault
                .as_ref()
                .and_then(|vault| vault.member_id.clone());
            let previous_identity = previous_member
                .as_ref()
                .map(|member| json!({"memberId":member,"epoch":previous_epoch}));
            let cancellations = state
                .operations
                .iter_mut()
                .filter(|op| {
                    previous_member.as_deref() == Some(op.member_id.as_str())
                        && op.epoch == previous_epoch
                        && !matches!(op.state.as_str(), "settled" | "released")
                })
                .filter_map(|op| {
                    op.cancellation_requested = true;
                    op.request_id
                        .as_ref()
                        .map(|request| (request.clone(), op.cancel_key.clone()))
                })
                .collect::<Vec<_>>();
            self.save_journal(&state.operations)?;
            state.epoch += 1;
            let epoch = state.epoch;
            let vault = state.vault.as_mut().ok_or("platform_login_required")?;
            let key = vault.key()?;
            let old = vault.credential.clone();
            let device = vault.bound_device.clone();
            vault.credential = None;
            vault.refresh_pending = false;
            if let Some(old) = old.clone() {
                vault.enqueue_revocation(old);
            }
            vault.epoch = epoch;
            self.save_vault(vault)?;
            state.phase = "guest".into();
            state.model_session = None;
            state.member = Value::Null;
            state.entitlements = Value::Null;
            state.trial = Value::Null;
            state.wallet = Value::Null;
            state.grants = Value::Null;
            state.usage = Value::Null;
            state.models = Value::Null;
            state.binding = Value::Null;
            state.connection = Value::Null;
            state.benefits = Value::Null;
            state.updated_at = None;
            // 退出是可预期的用户操作，旧错误不应继续展示；撤销结果由 revocationPending 单独提示。
            state.error = None;
            let pending_connection = state.pending_connection.take();
            (
                epoch,
                key,
                old,
                device,
                previous_identity,
                cancellations,
                pending_connection,
            )
        };
        self.emit_snapshot().await;
        if let Some(pending) = pending_connection {
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                this.delete_connection(&pending).await;
            });
        }
        if let Some(previous) = previous_identity.as_ref() {
            super::stop_official_runtimes(Some(previous)).await;
        }
        if let Some(credential) = old.as_ref() {
            // 本机身份先失效；旧凭据只用于原请求停止及撤销，不可再用于推理。
            for (request, cancel_key) in cancellations {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    self.transport.send(
                        &key,
                        Some(&credential.access_token),
                        PLATFORM_AUD,
                        Method::POST,
                        &format!("/api/v1/model-requests/{request}/cancel"),
                        b"{\"reason\":\"user_cancelled\"}",
                        "application/json",
                        Some(&cancel_key),
                    ),
                )
                .await;
            }
        }
        if let Some(old) = old {
            let result = if local_only {
                Err("platform_revocation_pending".into())
            } else if unbind {
                let device = device.ok_or("platform_binding_required")?;
                self.transport
                    .send(
                        &key,
                        Some(&old.access_token),
                        PLATFORM_AUD,
                        Method::DELETE,
                        &format!("/api/v1/devices/{device}"),
                        b"{}",
                        "application/json",
                        Some(&identity::random_id()),
                    )
                    .await
                    .and_then(|r| match r.error {
                        Some(error) => Err(error),
                        None => Ok(()),
                    })
            } else {
                revoke(self, &key, &old).await
            };
            let mut state = self.state.lock().await;
            if state.epoch == epoch {
                if result.is_ok() {
                    if let Some(vault) = state.vault.as_mut() {
                        vault.confirm_revocation(&old.session_id);
                        if unbind {
                            vault.bound_device = None;
                            vault.member_id = None;
                        }
                        self.save_vault(vault)?;
                    }
                    state.error = None;
                } else if !local_only {
                    // 本地退出时服务器撤销按设计延后重试，不是失败；仅在线退出失败才提示。
                    state.error = Some("platform_revocation_pending".into());
                }
            }
        }
        self.emit_snapshot().await;
        Ok(self.snapshot().await)
    }
}
