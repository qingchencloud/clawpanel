//! 官方模型本机桥：凭据留在native，受管内核仅持有本安装/账号/epoch的局部能力。
use super::{identity, project, Platform, Value, PLATFORM};
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Semaphore},
};

pub(super) const ENGINES: &[&str] = &["pi", "deepseek-harness", "opencode", "openclaw", "hermes"];

#[derive(Default)]
pub(super) struct Gateway {
    port: Option<u16>,
    leases: Vec<Lease>,
}
pub(super) struct Lease {
    cap: String,
    engine: String,
    member: String,
    epoch: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.cap.zeroize();
    }
}

const PROXY_STATE: &str = "official-gateway.json";

fn proxy_state_path() -> std::path::PathBuf {
    super::super::openclaw_dir()
        .join("clawpanel")
        .join(PROXY_STATE)
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct ProxyState {
    port: Option<u16>,
    #[serde(default)]
    leases: Vec<LeaseState>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LeaseState {
    cap: String,
    engine: String,
    member: String,
    epoch: u64,
}

fn load_proxy_state() -> ProxyState {
    std::fs::read(proxy_state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 端口与能力令牌落盘：客户端重启后引擎配置里的 provider baseUrl 仍然有效。
fn save_proxy_state(gateway: &Gateway) {
    let Some(port) = gateway.port else { return };
    let state = ProxyState {
        port: Some(port),
        leases: gateway
            .leases
            .iter()
            .map(|lease| LeaseState {
                cap: lease.cap.clone(),
                engine: lease.engine.clone(),
                member: lease.member.clone(),
                epoch: lease.epoch,
            })
            .collect(),
    };
    let Ok(bytes) = serde_json::to_vec_pretty(&state) else {
        return;
    };
    let path = proxy_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, bytes);
}

/// 启动时若已有接入记录，则按持久化端口恢复本机代理监听。
pub async fn ensure_proxy() {
    if !proxy_state_path().exists() {
        return;
    }
    let Ok(platform) = PLATFORM.as_ref() else {
        return;
    };
    let _ = platform.clone().ensure_gateway_listener().await;
}

/// 只供本机native adapter；不能直接作为WebView IPC返回或普通渠道导出。
pub async fn engine_connection(engine: &str) -> Result<Value, String> {
    PLATFORM
        .as_ref()
        .map_err(Clone::clone)?
        .clone()
        .engine_connection(engine)
        .await
}

/// 仅记录本人当前内核的停止意图；资金是否释放由原请求终态决定。
pub async fn engine_cancel(engine: &str, expected: &Value) -> Result<Value, String> {
    PLATFORM
        .as_ref()
        .map_err(Clone::clone)?
        .clone()
        .engine_cancel(engine, expected)
        .await
}

/// 高频事件只核对本安装当前身份，不读取模型目录或发起网络请求。
pub async fn engine_identity_current(expected: &Value) -> bool {
    let Ok(platform) = PLATFORM.as_ref() else {
        return false;
    };
    let state = platform.state.lock().await;
    state.phase == "bound"
        && expected["epoch"].as_u64() == Some(state.epoch)
        && expected["memberId"].as_str()
            == state
                .vault
                .as_ref()
                .and_then(|vault| vault.member_id.as_deref())
}

/// 仅恢复当前本人内核的原请求；明确准入前拒绝的记录不伪造服务器请求。
pub async fn engine_recover_operation(
    engine: &str,
    expected: &Value,
    id: &str,
) -> Result<Value, String> {
    if !ENGINES.contains(&engine) {
        return Err("unsupported_official_engine".into());
    }
    let platform = PLATFORM.as_ref().map_err(Clone::clone)?.clone();
    let admission_rejected = {
        let state = platform.state.lock().await;
        let member = state
            .vault
            .as_ref()
            .and_then(|vault| vault.member_id.as_deref());
        if state.phase != "bound"
            || expected["epoch"].as_u64() != Some(state.epoch)
            || expected["memberId"].as_str() != member
        {
            return Err("platform_account_changed".into());
        }
        let op = state
            .operations
            .iter()
            .find(|op| {
                op.operation_id == id
                    && Some(op.member_id.as_str()) == member
                    && op.runtime == engine
            })
            .ok_or("platform_request_not_found")?;
        op.admission_rejected && op.state == "released"
    };
    if !admission_rejected {
        platform.control(id, false).await?;
    }
    if !engine_identity_current(expected).await {
        return Err("platform_account_changed".into());
    }
    let state = platform.state.lock().await;
    let op = state
        .operations
        .iter()
        .find(|op| op.operation_id == id)
        .ok_or("platform_request_not_found")?;
    Ok(json!({"operationId":id,"state":op.state,"replyComplete":op.reply_complete}))
}

impl Platform {
    pub(super) async fn engine_cancel(
        self: &Arc<Self>,
        engine: &str,
        expected: &Value,
    ) -> Result<Value, String> {
        if !ENGINES.contains(&engine) {
            return Err("unsupported_official_engine".into());
        }
        let operations = {
            let state = self.state.lock().await;
            if state.phase != "bound" {
                return Err("platform_binding_required".into());
            }
            let member = state
                .vault
                .as_ref()
                .and_then(|v| v.member_id.as_deref())
                .ok_or("platform_login_required")?;
            if expected["epoch"].as_u64() != Some(state.epoch)
                || expected["memberId"].as_str() != Some(member)
            {
                return Err("platform_account_changed".into());
            }
            state
                .operations
                .iter()
                .filter(|op| {
                    op.runtime == engine
                        && op.member_id == member
                        && op.epoch == state.epoch
                        && !matches!(op.state.as_str(), "settled" | "released")
                })
                .map(|op| op.operation_id.clone())
                .collect::<Vec<_>>()
        };
        let mut recovery_required = false;
        for id in &operations {
            if self.control(id, true).await.is_err() {
                recovery_required = true;
            }
        }
        Ok(
            json!({"requested":operations.len(),"cancellationRequested":true,"recoveryRequired":recovery_required}),
        )
    }

    /// 确保本机官方代理监听：优先复用持久化端口，并把持久化的能力令牌恢复为租约。
    pub(super) async fn ensure_gateway_listener(self: &Arc<Self>) -> Result<u16, String> {
        let mut gateway = self.gateway.lock().await;
        if let Some(port) = gateway.port {
            return Ok(port);
        }
        let saved = load_proxy_state();
        let mut bound = None;
        if let Some(saved_port) = saved.port {
            if let Ok(listener) =
                TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, saved_port)).await
            {
                bound = Some(listener);
            }
        }
        let listener = match bound {
            Some(listener) => listener,
            None => TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| "official_gateway_unavailable")?,
        };
        let port = listener
            .local_addr()
            .map_err(|_| "official_gateway_unavailable")?
            .port();
        gateway.port = Some(port);
        gateway.leases = saved
            .leases
            .into_iter()
            .map(|lease| Lease {
                cap: lease.cap,
                engine: lease.engine,
                member: lease.member,
                epoch: lease.epoch,
            })
            .collect();
        let weak = Arc::downgrade(self);
        let permits = Arc::new(Semaphore::new(32));
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((socket, peer)) = listener.accept().await else {
                    break;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    continue;
                };
                let Some(platform) = weak.upgrade() else {
                    break;
                };
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let _ = platform.gateway_request(socket, port).await;
                });
            }
        });
        save_proxy_state(&gateway);
        Ok(port)
    }

    pub(super) async fn engine_connection(self: &Arc<Self>, engine: &str) -> Result<Value, String> {
        if !ENGINES.contains(&engine) {
            return Err("unsupported_official_engine".into());
        }
        self.load(false).await?;
        let (epoch, member) = {
            let state = self.state.lock().await;
            if state.phase != "bound" {
                return Err("platform_binding_required".into());
            }
            (
                state.epoch,
                state
                    .vault
                    .as_ref()
                    .and_then(|v| v.member_id.clone())
                    .ok_or("platform_login_required")?,
            )
        };
        let catalog = self.models_for(engine, None).await?;
        self.current(epoch).await?;
        let port = self.ensure_gateway_listener().await?;
        let mut gateway = self.gateway.lock().await;
        gateway
            .leases
            .retain(|lease| lease.epoch == epoch && lease.member == member);
        if !gateway.leases.iter().any(|lease| lease.engine == engine) {
            gateway.leases.push(Lease {
                cap: identity::random_id(),
                engine: engine.into(),
                member: member.clone(),
                epoch,
            });
        }
        save_proxy_state(&gateway);
        let lease = gateway
            .leases
            .iter()
            .find(|lease| lease.engine == engine)
            .unwrap();
        Ok(
            json!({"engine":engine,"providerId":"clawpanel-official","baseUrl":format!("http://127.0.0.1:{}/engine/{}/v1",port,lease.cap),"apiKey":"clawpanel-local","models":catalog["data"],"memberId":member,"epoch":epoch}),
        )
    }

    async fn gateway_request(
        self: Arc<Self>,
        mut socket: TcpStream,
        port: u16,
    ) -> Result<(), String> {
        let parsed = tokio::time::timeout(Duration::from_secs(10), read_request(&mut socket)).await;
        let request = match parsed {
            Ok(Ok(value)) => value,
            _ => {
                let _ = error(&mut socket, 400, "invalid_official_http").await;
                return Ok(());
            }
        };
        if request.headers.get("host").map(String::as_str)
            != Some(format!("127.0.0.1:{port}").as_str())
            || request.headers.contains_key("origin")
        {
            return error(&mut socket, 403, "official_gateway_origin_denied").await;
        }
        if request.headers.get("authorization").map(String::as_str)
            != Some("Bearer clawpanel-local")
        {
            return error(&mut socket, 401, "official_gateway_auth_required").await;
        }
        let parts: Vec<&str> = request.path.split('/').collect();
        // 常驻Gateway的诊断会记录URL；局部能力只经私有Token头传递。
        let gateway_alias = parts.len() >= 4 && parts[1] == "openclaw-gateway" && parts[2] == "v1";
        let capability = if gateway_alias {
            request
                .headers
                .get("x-clawpanel-engine-token")
                .map(String::as_str)
                .unwrap_or("")
        } else if parts.len() >= 5 && parts[1] == "engine" && parts[3] == "v1" {
            parts[2]
        } else {
            return error(&mut socket, 404, "official_gateway_not_found").await;
        };
        let identity = {
            let gateway = self.gateway.lock().await;
            gateway
                .leases
                .iter()
                .find(|lease| lease.cap == capability)
                .map(|lease| (lease.epoch, lease.member.clone(), lease.engine.clone()))
        };
        let Some((epoch, member, engine)) = identity else {
            return error(&mut socket, 401, "official_gateway_expired").await;
        };
        if gateway_alias && engine != "openclaw" {
            return error(&mut socket, 403, "official_gateway_engine_denied").await;
        }
        if !self.engine_current(epoch, &member).await {
            return error(&mut socket, 401, "official_gateway_expired").await;
        }
        let suffix = parts[if gateway_alias { 3 } else { 4 }..].join("/");
        if request.method == "GET" && suffix == "models" && request.body.is_empty() {
            return match self.models_for(&engine, None).await {
                Ok(value) if self.engine_current(epoch, &member).await => {
                    reply(&mut socket, 200, &value).await
                }
                Ok(_) => error(&mut socket, 401, "official_gateway_expired").await,
                Err(code) => error(&mut socket, status(&code), &code).await,
            };
        }
        if request.method != "POST" || suffix != "chat/completions" {
            return error(&mut socket, 404, "unsupported_official_endpoint").await;
        }
        if !request
            .headers
            .get("content-type")
            .is_some_and(|v| v.starts_with("application/json"))
        {
            return error(&mut socket, 400, "invalid_official_request").await;
        }
        // 普通 provider 不携带私有头：缺失时由本机代理生成操作 ID，显式提供则仍做校验。
        let id = match request.headers.get("x-clawpanel-operation-id") {
            Some(raw) => {
                let candidate = String::from_utf8_lossy(raw.as_bytes());
                if !(16..=128).contains(&candidate.len())
                    || !candidate
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                {
                    return error(&mut socket, 400, "official_operation_id_invalid").await;
                }
                candidate.into_owned()
            }
            None => identity::random_id(),
        };
        let mut body: Value = match serde_json::from_slice(&request.body) {
            Ok(value) => value,
            Err(_) => return error(&mut socket, 400, "invalid_official_request").await,
        };
        let catalog = self.state.lock().await.models.clone();
        let (stream, upstream_stream) = match prepare_engine_transport(&mut body, &catalog) {
            Ok(value) => value,
            Err(code) => return error(&mut socket, 400, &code).await,
        };
        #[cfg(debug_assertions)]
        self.harness_engine_pause().await;
        let (sender, mut receiver) = mpsc::channel(128);
        {
            let mut sinks = self.engine_sinks.lock().await;
            if sinks.contains_key(&id) {
                return error(&mut socket, 409, "official_request_recovery_required").await;
            }
            sinks.insert(id.clone(), sender);
        }
        let accepted = self
            .begin_send_for(
                json!({"operationId":id,"body":body}),
                &engine,
                Some((epoch, &member)),
            )
            .await;
        match accepted {
            Ok(value) if value["accepted"] == true => {}
            other => {
                self.engine_sinks.lock().await.remove(&id);
                let code = match other {
                    Err(code) => code,
                    _ => {
                        let _ = self.control(&id, false).await;
                        "official_request_recovery_required".into()
                    }
                };
                return error(&mut socket, status(&code), &code).await;
            }
        }
        let result = async {
            let deadline=tokio::time::Instant::now()+Duration::from_secs(120);
            let mut started = false;
            let mut request_id = None;
            let mut peer = [0_u8;1];
            loop {
                if !self.engine_current(epoch,&member).await {
                    if started { let _=write_sse(&mut socket,&json!({"error":{"code":"platform_account_changed","message":"platform_account_changed"}})).await;return Ok(()); }
                    return error(&mut socket,401,"platform_account_changed").await;
                }
                let event = tokio::select! {
                    event = receiver.recv() => event,
                    _ = socket.read(&mut peer) => { let _=self.control(&id,true).await; return Ok(()); },
                    _ = tokio::time::sleep_until(deadline) => { let _=self.control(&id,true).await; return Err("official_gateway_timeout".into()); },
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                };
                let Some(event) = event else { return Err("official_gateway_incomplete".into()); };
                if let Some(value)=event["requestId"].as_str() { request_id=Some(value.to_string()); }
                match event["type"].as_str() {
                    Some("delta") if stream => {
                        #[cfg(debug_assertions)]
                        if event["data"]["usage"].is_object() {
                            self.transport.engine_trace(json!({"phase":"engine_response_usage","operationId":id,"engine":engine,"stream":upstream_stream,"usage":project(&event["data"]["usage"],&["prompt_tokens","completion_tokens","total_tokens"])}));
                        }
                        if !started { write_headers(&mut socket,200,"text/event-stream",&id,request_id.as_deref()).await?;started=true; }
                        write_sse(&mut socket,&event["data"]).await?;
                    },
                    Some("complete") => {
                        #[cfg(debug_assertions)]
                        if event["data"]["usage"].is_object() {
                            self.transport.engine_trace(json!({"phase":"engine_response_usage","operationId":id,"engine":engine,"stream":upstream_stream,"usage":project(&event["data"]["usage"],&["prompt_tokens","completion_tokens","total_tokens"])}));
                        }
                        if stream {
                            // 部分SDK只接事件流；普通官网回复完整到达后再等价投影，不伪造上游流式。
                            let frames = if upstream_stream { Vec::new() } else { completion_frames(&event["data"])? };
                            if !started { write_headers(&mut socket,200,"text/event-stream",&id,request_id.as_deref()).await?; }
                            for frame in frames { write_sse(&mut socket,&frame).await?; }
                            socket.write_all(b"data: [DONE]\n\n").await.map_err(|_|"official_gateway_disconnected")?;
                            return Ok(());
                        }
                        let value=project(&event["data"],&["id","object","created","model","choices","usage"]);
                        return reply_with_id(&mut socket,200,&value,&id,request_id.as_deref()).await;
                    },
                    Some("error") => {
                        let code=event["data"]["code"].as_str().unwrap_or("official_request_unknown");
                        if started { return write_sse(&mut socket,&json!({"error":{"code":code,"message":code,"type":"official_model_error"}})).await; }
                        return reply_with_id(&mut socket,status(code),&json!({"error":{"code":code,"message":code,"type":"official_model_error"}}),&id,request_id.as_deref()).await;
                    },
                    _=>{},
                }
            }
        }.await;
        self.engine_sinks.lock().await.remove(&id);
        if result.is_err() {
            let _ = self.control(&id, true).await;
        }
        let _ = socket.shutdown().await;
        result
    }

    async fn engine_current(&self, epoch: u64, member: &str) -> bool {
        let state = self.state.lock().await;
        state.epoch == epoch
            && state.phase == "bound"
            && state.vault.as_ref().and_then(|v| v.member_id.as_deref()) == Some(member)
    }
}

fn prepare_engine_transport(body: &mut Value, catalog: &Value) -> Result<(bool, bool), String> {
    let object = body.as_object_mut().ok_or("invalid_official_request")?;
    let requested = match object.get("stream") {
        None => false,
        Some(value) => value.as_bool().ok_or("invalid_official_request")?,
    };
    let capability = catalog["data"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .find(|model| model["id"].as_str() == object.get("model").and_then(Value::as_str))
        })
        .and_then(|model| model["capabilities"]["streaming"].as_bool());
    // 仅目录明确声明不支持流式时转普通请求；未知模型/能力仍由原校验拒绝。
    let upstream = requested && capability != Some(false);
    if requested && !upstream {
        object.insert("stream".into(), json!(false));
        object.remove("stream_options");
    }
    Ok((requested, upstream))
}

fn completion_frames(completion: &Value) -> Result<Vec<Value>, String> {
    let choices = completion["choices"]
        .as_array()
        .filter(|choices| choices.len() == 1)
        .ok_or("official_gateway_incomplete")?;
    let choice = &choices[0];
    let reason = choice["finish_reason"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("official_gateway_incomplete")?;
    let mut message = choice["message"]
        .as_object()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .cloned()
        .ok_or("official_gateway_incomplete")?;
    if let Some(calls) = message.get_mut("tool_calls") {
        let calls = calls.as_array_mut().ok_or("official_gateway_incomplete")?;
        for (index, call) in calls.iter_mut().enumerate() {
            call.as_object_mut()
                .ok_or("official_gateway_incomplete")?
                .insert("index".into(), json!(index));
        }
    }
    let common = || json!({"id":completion["id"],"object":"chat.completion.chunk","created":completion["created"],"model":completion["model"]});
    let mut content = common();
    content["choices"] = json!([{"index":0,"delta":message,"finish_reason":null}]);
    let mut finish = common();
    finish["choices"] = json!([{"index":0,"delta":{},"finish_reason":reason}]);
    if completion["usage"].is_object() {
        finish["usage"] = completion["usage"].clone();
    }
    Ok(vec![content, finish])
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}
async fn read_request(socket: &mut TcpStream) -> Result<Request, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let end = loop {
        if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            if at > 16384 {
                return Err("header_limit".into());
            }
            break at + 4;
        }
        if bytes.len() > 16384 {
            return Err("header_limit".into());
        }
        let read = socket.read(&mut buffer).await.map_err(|_| "http_read")?;
        if read == 0 {
            return Err("http_eof".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
    };
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| "invalid_header")?;
    let mut lines = header.split("\r\n");
    let first: Vec<_> = lines.next().ok_or("invalid_header")?.split(' ').collect();
    if first.len() != 3
        || first[2] != "HTTP/1.1"
        || !first[1].starts_with('/')
        || first[1].contains(['?', '#', '%', '\\'])
    {
        return Err("invalid_header".into());
    }
    let (method, path) = (first[0].to_string(), first[1].to_string());
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or("invalid_header")?;
        if !key.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-')
            || value.chars().any(|v| v.is_control() && v != '\t')
        {
            return Err("invalid_header".into());
        }
        if headers
            .insert(key.to_ascii_lowercase(), value.trim().to_string())
            .is_some()
        {
            return Err("duplicate_header".into());
        }
    }
    if headers.contains_key("transfer-encoding") || headers.contains_key("expect") {
        return Err("unsupported_encoding".into());
    }
    let length = match headers.get("content-length") {
        Some(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => {
            v.parse::<usize>().map_err(|_| "invalid_length")?
        }
        Some(_) => return Err("invalid_length".into()),
        None => 0,
    };
    if length > 1024 * 1024 || bytes.len() > end + length {
        return Err("body_limit".into());
    }
    while bytes.len() < end + length {
        let read = socket.read(&mut buffer).await.map_err(|_| "http_read")?;
        if read == 0 {
            return Err("http_eof".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > end + length {
            return Err("http_pipeline".into());
        }
    }
    Ok(Request {
        method,
        path,
        headers,
        body: bytes[end..].to_vec(),
    })
}
fn status(code: &str) -> u16 {
    match code {
        "insufficient_credit" => 402,
        "model_not_allowed" => 403,
        "concurrency_limit_exceeded" | "rate_limited" => 429,
        "platform_login_required"
        | "platform_binding_required"
        | "platform_account_changed"
        | "invalid_token" => 401,
        "official_request_recovery_required"
        | "idempotency_conflict"
        | "official_request_id_unknown" => 409,
        "invalid_official_request"
        | "unsupported_official_request"
        | "official_request_too_large"
        | "context_limit_exceeded" => 400,
        _ => 503,
    }
}
async fn write_headers(
    socket: &mut TcpStream,
    status: u16,
    kind: &str,
    id: &str,
    request: Option<&str>,
) -> Result<(), String> {
    let reason = if status == 200 {
        "OK"
    } else {
        "Official model request failed"
    };
    let extra = if id.is_empty() {
        String::new()
    } else {
        format!("X-ClawPanel-Operation-ID: {id}\r\n")
    };
    let reference = request
        .map(|id| format!("X-Model-Request-ID: {id}\r\n"))
        .unwrap_or_default();
    let header=format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-Should-Retry: false\r\n{extra}{reference}\r\n");
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|_| "official_gateway_disconnected".into())
}
async fn reply_with_id(
    socket: &mut TcpStream,
    status: u16,
    value: &Value,
    id: &str,
    request: Option<&str>,
) -> Result<(), String> {
    write_headers(socket, status, "application/json", id, request).await?;
    socket
        .write_all(&serde_json::to_vec(value).map_err(|_| "official_gateway_response")?)
        .await
        .map_err(|_| "official_gateway_disconnected".into())
}
async fn reply(socket: &mut TcpStream, status: u16, value: &Value) -> Result<(), String> {
    reply_with_id(socket, status, value, "", None).await
}
async fn error(socket: &mut TcpStream, status: u16, code: &str) -> Result<(), String> {
    reply(
        socket,
        status,
        &json!({"error":{"code":code,"message":code,"type":"official_model_error"}}),
    )
    .await
}
async fn write_sse(socket: &mut TcpStream, value: &Value) -> Result<(), String> {
    let frame = format!(
        "data: {}\n\n",
        serde_json::to_string(value).map_err(|_| "official_gateway_response")?
    );
    tokio::time::timeout(Duration::from_secs(15), socket.write_all(frame.as_bytes()))
        .await
        .map_err(|_| "official_gateway_slow_reader")?
        .map_err(|_| "official_gateway_disconnected".into())
}
