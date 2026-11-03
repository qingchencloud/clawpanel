use std::error::Error;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::{tls, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FIXTURE: &str = "clawpanel-https-transport";
const READY_LIMIT: u64 = 16 * 1024;
const BODY_LIMIT: usize = 128 * 1024;
const IO_BUDGET: Duration = Duration::from_secs(5);
const CHILD_ENV_ALLOWLIST: [&str; 8] = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
];
type TestResult<T> = Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Certificates {
    root_certificate_pem: String,
    certificate_der_base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    schema_version: u8,
    fixture: String,
    pid: u32,
    host: String,
    port: u16,
    protocol: String,
    nonce: String,
    node_version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransportRequest {
    request_id: String,
    message: String,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransportResponse {
    schema_version: u8,
    fixture: String,
    nonce: String,
    protocol: String,
    method: String,
    path: String,
    request_count: u32,
    received: TransportRequest,
}

// PID 来自创建返回值，始终持有原始 Child；不按进程名枚举或重找目标。
struct ChildHandle {
    child: Child,
    pid: u32,
    reader: Option<JoinHandle<()>>,
    ready_deadline: Instant,
    endpoint: Option<SocketAddr>,
    cleanup_started: bool,
}

impl ChildHandle {
    fn spawn(protocol: &str, nonce: &str) -> TestResult<Self> {
        let node = std::env::var_os("CLAWPANEL_TEST_NODE").unwrap_or_else(|| "node".into());
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/https-transport-server.mjs");
        let mut command = Command::new(node);
        command
            .arg(script)
            .args([protocol, nonce])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // 只继承运行 Node 所需的系统路径，不继承凭据、代理或启动注入变量。
        for name in CHILD_ENV_ALLOWLIST {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let ready_deadline = Instant::now() + IO_BUDGET;
        let child = command.spawn().map_err(|_| "Node fixture spawn failed")?;
        let pid = child.id();
        Ok(Self {
            child,
            pid,
            reader: None,
            ready_deadline,
            endpoint: None,
            cleanup_started: false,
        })
    }

    fn ready(&mut self, protocol: &str, nonce: &str) -> TestResult<Ready> {
        let stdout = self.child.stdout.take().ok_or("Missing fixture stdout")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.reader = Some(
            thread::Builder::new()
                .name("https-fixture-ready".into())
                .spawn(move || {
                    let mut line = Vec::new();
                    let result = BufReader::new(stdout)
                        .take(READY_LIMIT + 1)
                        .read_until(b'\n', &mut line)
                        .map(|_| line);
                    let _ = sender.send(result);
                })
                .map_err(|_| "Fixture stdout reader spawn failed")?,
        );
        let remaining = self
            .ready_deadline
            .checked_duration_since(Instant::now())
            .ok_or("Fixture ready exceeded original 5s deadline")?;
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Fixture ready exceeded 5s or reader disconnected")?
            .map_err(|_| "Fixture stdout read failed")?;
        if line.len() as u64 > READY_LIMIT || line.last() != Some(&b'\n') {
            return Err("Fixture ready must be a bounded newline-terminated JSON".into());
        }
        let ready: Ready = serde_json::from_slice(&line).map_err(|_| "Invalid ready JSON")?;
        if ready.schema_version != 1
            || ready.fixture != FIXTURE
            || ready.pid != self.pid
            || ready.host != "127.0.0.1"
            || ready.port == 0
            || ready.protocol != protocol
            || ready.nonce != nonce
        {
            return Err("Fixture ready identity/protocol/bind mismatch".into());
        }
        if Instant::now() >= self.ready_deadline {
            return Err("Fixture ready exceeded original 5s deadline".into());
        }
        self.endpoint = Some(SocketAddr::from((Ipv4Addr::LOCALHOST, ready.port)));
        Ok(ready)
    }

    fn stop(&mut self) -> Value {
        // 停止、kill、wait、端口只读探测和 reader 回收共享原 5 秒预算。
        // 清理中不提前返回；错误保留为硬失败，同时尽力回收同一个 Child。
        self.cleanup_started = true;
        let start = Instant::now();
        let deadline = start + IO_BUDGET;
        let mut errors = Vec::new();
        let stop_requested = self
            .child
            .stdin
            .take()
            .is_some_and(|mut input| input.write_all(b"stop\n").is_ok());
        let graceful_deadline = start + Duration::from_secs(1);
        let mut killed = false;
        let mut kill_attempts = 0;
        let mut wait_error = false;
        let mut kill_error = false;
        let status = loop {
            if Instant::now() >= deadline {
                errors.push("Own child cleanup exceeded 5s");
                break None;
            }
            match self.child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => (),
                Err(_) => wait_error = true,
            }
            if !killed && (wait_error || Instant::now() >= graceful_deadline) {
                kill_attempts += 1;
                match self.child.kill() {
                    Ok(()) => killed = true,
                    Err(_) => kill_error = true,
                }
            }
            thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10)),
            );
        };
        if wait_error {
            errors.push("Child try_wait failed");
        }
        if kill_error {
            errors.push("Own child kill failed");
        }
        // try_wait 已确认退出；wait 读取该 Child 的缓存退出状态，不引入新预算。
        let mut reaped = false;
        if let Some(status) = status {
            match self.child.wait() {
                Ok(waited) if waited == status => reaped = true,
                _ => errors.push("Own child wait failed or status mismatch"),
            }
            if !killed && !status.success() {
                errors.push("Fixture child exited unsuccessfully");
            }
        }
        let mut port_closed = None;
        let mut port_probe = Value::Null;
        if reaped {
            if let Some(endpoint) = self.endpoint {
                match deadline.checked_duration_since(Instant::now()) {
                    Some(remaining) if !remaining.is_zero() => {
                        // 仅一次只读连接；即使端口已被 foreign 占用，也只报告失败。
                        // Windows 的 200ms 子分配已实测先超时；只重分配原总预算剩余量。
                        let probe_budget = remaining;
                        let probe_start = Instant::now();
                        match TcpStream::connect_timeout(&endpoint, probe_budget) {
                            Ok(connection) => {
                                drop(connection);
                                port_closed = Some(false);
                                port_probe = json!({ "result": "connected", "attempts": 1 });
                                errors.push("Fixture port still listening after owned child reap");
                            }
                            Err(error) => {
                                port_probe = json!({
                                    "result": "error", "attempts": 1,
                                    "errorKind": format!("{:?}", error.kind()),
                                    "rawOsError": error.raw_os_error(), "debug": format!("{error:?}"),
                                });
                                if error.kind() == std::io::ErrorKind::ConnectionRefused {
                                    port_closed = Some(true);
                                } else {
                                    errors.push("Fixture port closure probe inconclusive");
                                }
                            }
                        }
                        port_probe["budgetMs"] = json!(probe_budget.as_millis());
                        port_probe["elapsedMs"] = json!(probe_start.elapsed().as_millis());
                    }
                    _ => errors.push("No remaining cleanup budget for port closure probe"),
                }
            }
        }
        let mut reader_joined = true;
        if let Some(reader) = self.reader.take() {
            while !reader.is_finished() {
                if Instant::now() >= deadline {
                    reader_joined = false;
                    errors.push("Fixture stdout reader cleanup exceeded 5s");
                    break;
                }
                thread::sleep(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(5)),
                );
            }
            if reader_joined && reader.join().is_err() {
                reader_joined = false;
                errors.push("Fixture stdout reader panicked");
            }
        }
        if Instant::now() >= deadline && errors.is_empty() {
            errors.push("Own child cleanup exceeded 5s");
        }
        json!({
            "status": if errors.is_empty() { "passed" } else { "failed" }, "errors": errors,
            "pid": self.pid, "stopRequested": stop_requested, "killSent": killed,
            "killAttempts": kill_attempts, "reaped": reaped, "portClosed": port_closed, "portProbe": port_probe,
            "stdoutReaderJoined": reader_joined, "elapsedMs": start.elapsed().as_millis(),
            "exitCode": status.and_then(|value| value.code()),
        })
    }
}

impl Drop for ChildHandle {
    fn drop(&mut self) {
        if self.cleanup_started {
            return;
        }
        if self.stop()["status"] != "passed" {
            eprintln!("HTTPS fixture cleanup failed for owned child {}", self.pid);
        }
    }
}

fn client(ready: &Ready, version: tls::Version, trust_fixture: bool) -> TestResult<Client> {
    let mut builder = Client::builder()
        .use_rustls_tls()
        .no_proxy()
        .tls_built_in_root_certs(false)
        .min_tls_version(version)
        .max_tls_version(version)
        .tls_info(true)
        .timeout(IO_BUDGET)
        .redirect(reqwest::redirect::Policy::none())
        .resolve(
            "localhost",
            SocketAddr::from((Ipv4Addr::LOCALHOST, ready.port)),
        )
        .resolve(
            "wrong-hostname.invalid",
            SocketAddr::from((Ipv4Addr::LOCALHOST, ready.port)),
        );
    if trust_fixture {
        let certificates: Certificates =
            serde_json::from_str(include_str!("fixtures/tls-localhost.json"))
                .map_err(|_| "Invalid public certificate fixture")?;
        let root = reqwest::Certificate::from_pem(certificates.root_certificate_pem.as_bytes())
            .map_err(|_| "Invalid public test CA")?;
        builder = builder.add_root_certificate(root);
    }
    builder
        .build()
        .map_err(|_| "Rustls client build failed".into())
}

async fn exchange(client: &Client, ready: &Ready, sequence: u32) -> TestResult<Value> {
    let input = TransportRequest {
        request_id: format!("{}-{sequence}", ready.nonce),
        message: "完整传输-UTF8-transport-".repeat(2048),
    };
    let url = format!("https://localhost:{}/transport", ready.port);
    let mut response = client
        .post(url)
        .json(&input)
        .send()
        .await
        .map_err(|_| "Trusted HTTPS request failed")?;
    if response.status() != reqwest::StatusCode::OK
        || response.version() != reqwest::Version::HTTP_11
    {
        return Err("Unexpected HTTPS status or HTTP protocol".into());
    }
    let certificates: Certificates =
        serde_json::from_str(include_str!("fixtures/tls-localhost.json"))
            .map_err(|_| "Invalid public certificate fixture")?;
    let expected_der = base64::engine::general_purpose::STANDARD
        .decode(certificates.certificate_der_base64)
        .map_err(|_| "Invalid public leaf DER")?;
    let peer = response
        .extensions()
        .get::<tls::TlsInfo>()
        .and_then(tls::TlsInfo::peer_certificate)
        .ok_or("Missing TLS peer certificate")?;
    if peer != expected_der
        || response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            != Some("application/json; charset=utf-8")
    {
        return Err("TLS peer certificate or content type mismatch".into());
    }
    let content_length = response.content_length().ok_or("Missing Content-Length")?;
    if content_length > BODY_LIMIT as u64 {
        return Err("Response exceeds body limit".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "HTTPS body read failed")?
    {
        if body.len() + chunk.len() > BODY_LIMIT {
            return Err("Response exceeds body limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    // 派生反序列化拒绝重复字段；from_slice 同时拒绝尾随第二段 JSON 和截断。
    let actual: TransportResponse = serde_json::from_slice(&body)
        .map_err(|_| "Response is not one complete, unique-schema JSON")?;
    let expected = TransportResponse {
        schema_version: 1,
        fixture: FIXTURE.into(),
        nonce: ready.nonce.clone(),
        protocol: ready.protocol.clone(),
        method: "POST".into(),
        path: "/transport".into(),
        request_count: sequence,
        received: input,
    };
    if actual != expected || body.len() as u64 != content_length {
        return Err("Complete JSON, protocol, nonce, echo or request count mismatch".into());
    }
    Ok(json!({
        "case": format!("trusted-json-{sequence}"), "status": "passed",
        "requestCount": sequence, "protocol": actual.protocol, "httpVersion": "HTTP/1.1",
        "bodyBytes": body.len(), "bodySha256": format!("{:x}", Sha256::digest(&body)),
        "peerCertificateSha256": format!("{:x}", Sha256::digest(&expected_der)),
        "completeUniqueJson": true,
    }))
}

fn certificate_error_in_chain<'a>(
    error: &'a (dyn Error + 'static),
    chain: &mut Vec<Value>,
) -> Option<&'a rustls::CertificateError> {
    let mut source = Some(error);
    let mut seen: Vec<&(dyn Error + 'static)> = Vec::new();
    let mut via = "root";
    for _ in 0..16 {
        let current = source?;
        if seen.iter().any(|previous| std::ptr::eq(*previous, current)) {
            chain.push(json!({ "cycleDetected": true }));
            return None;
        }
        seen.push(current);
        let type_label = if current.is::<rustls::Error>() {
            "rustls::Error"
        } else if current.is::<std::io::Error>() {
            "std::io::Error"
        } else if current.is::<reqwest::Error>() {
            "reqwest::Error"
        } else {
            "opaque dyn std::error::Error (see debug)"
        };
        // 调用端仅自有 loopback 请求和合成错误；不输出环境、证书或真实业务 URL。
        chain.push(json!({
            "type": type_label, "via": via,
            "debug": format!("{current:?}").chars().take(4096).collect::<String>(),
        }));
        if let Some(rustls::Error::InvalidCertificate(reason)) =
            current.downcast_ref::<rustls::Error>()
        {
            return Some(reason);
        }
        // io::Error::source() 委托 inner.source()，会跳过 boxed inner 本身。
        // 先读取 get_ref()，再由下一轮访问 inner 的普通 source，保持精确 downcast。
        if let Some(inner) = current
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            source = Some(inner);
            via = "std::io::Error::get_ref";
        } else {
            source = current.source();
            via = "std::error::Error::source";
        }
    }
    chain.push(json!({ "truncated": true, "maxNodes": 16 }));
    None
}

async fn reject_certificate(
    client: &Client,
    ready: &Ready,
    wrong_hostname: bool,
    report: &mut Value,
) -> TestResult<Value> {
    let host = if wrong_hostname {
        "wrong-hostname.invalid"
    } else {
        "localhost"
    };
    let error = match client
        .get(format!("https://{host}:{}/transport", ready.port))
        .send()
        .await
    {
        Ok(_) => return Err("Invalid certificate unexpectedly reached HTTP".into()),
        Err(error) => error,
    };
    let mut chain = Vec::new();
    let reason = certificate_error_in_chain(&error, &mut chain);
    report["certificateAttempts"]
        .as_array_mut()
        .ok_or("Invalid certificate diagnostics")?
        .push(json!({
            "case": if wrong_hostname { "wrong-hostname" } else { "unknown-ca" },
            "errorChain": chain,
        }));
    if error.is_timeout() {
        return Err("Timeout is not proof of certificate rejection".into());
    }
    if let Some(reason) = reason {
        let expected = if wrong_hostname {
            matches!(
                reason,
                rustls::CertificateError::NotValidForName
                    | rustls::CertificateError::NotValidForNameContext { .. }
            )
        } else {
            matches!(reason, rustls::CertificateError::UnknownIssuer)
        };
        if !expected {
            return Err("TLS rejected a certificate for the wrong reason".into());
        }
        return Ok(json!({
            "case": if wrong_hostname { "wrong-hostname" } else { "unknown-ca" },
            "status": "passed", "httpResponseReceived": false,
            "certificateError": if wrong_hostname { "NotValidForName" } else { "UnknownIssuer" },
            "typedRustlsCertificateError": true,
        }));
    }
    Err("Failure source was not a typed Rustls certificate error".into())
}

async fn scenarios(ready: &Ready, version: tls::Version, report: &mut Value) -> TestResult<()> {
    let trusted = client(ready, version, true)?;
    let untrusted = client(ready, version, false)?;
    let first = exchange(&trusted, ready, 1).await?;
    report["cases"]
        .as_array_mut()
        .ok_or("Invalid evidence cases")?
        .push(first);
    let unknown = reject_certificate(&untrusted, ready, false, report).await?;
    report["cases"]
        .as_array_mut()
        .ok_or("Invalid evidence cases")?
        .push(unknown);
    let hostname = reject_certificate(&trusted, ready, true, report).await?;
    report["cases"]
        .as_array_mut()
        .ok_or("Invalid evidence cases")?
        .push(hostname);
    let second = exchange(&trusted, ready, 2).await?;
    report["cases"]
        .as_array_mut()
        .ok_or("Invalid evidence cases")?
        .push(second);
    Ok(())
}

fn verify(protocol: &str, version: tls::Version, label: &str) {
    let start = Instant::now();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("UTC clock")
        .as_nanos();
    let nonce = format!("{label}-{}-{timestamp}", std::process::id());
    let mut report = json!({
        "schemaVersion": 1, "fixture": FIXTURE, "protocol": protocol, "nonce": nonce,
        "status": "running", "cases": [], "certificateAttempts": [], "readyBudgetMs": 5000, "requestBudgetMs": 5000,
        "readyMaxBytes": READY_LIMIT, "cleanupBudgetMs": 5000, "nativeGuiQualification": false,
        "childEnvironmentAllowlist": CHILD_ENV_ALLOWLIST,
        "scope": "compiled reqwest/Rustls real loopback HTTPS only",
        "clientPolicy": { "builtInRoots": false, "proxy": false, "redirect": "none (test-only)" },
    });
    let result = (|| -> TestResult<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Tokio runtime creation failed")?;
        let mut handle = ChildHandle::spawn(protocol, &nonce)?;
        report["childPidAtSpawn"] = json!(handle.pid);
        let outcome = (|| {
            let ready = handle.ready(protocol, &nonce)?;
            report["ready"] =
                serde_json::to_value(&ready).map_err(|_| "Ready evidence encoding failed")?;
            runtime.block_on(scenarios(&ready, version, &mut report))
        })();
        let cleanup = handle.stop();
        report["cleanup"] = cleanup.clone();
        outcome?;
        if cleanup["status"] != "passed" {
            return Err("Owned child cleanup failed; see cleanup evidence".into());
        }
        Ok(())
    })();
    report["status"] = json!(if result.is_ok() { "passed" } else { "failed" });
    report["elapsedMs"] = json!(start.elapsed().as_millis());
    if let Err(error) = &result {
        report["error"] = json!(error);
    }
    if let Some(directory) = std::env::var_os("CLAWPANEL_TLS_TEST_EVIDENCE_DIR") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).expect("Create HTTPS evidence directory");
        std::fs::write(
            directory.join(format!("{label}-{nonce}.json")),
            serde_json::to_vec_pretty(&report).expect("Encode HTTPS evidence"),
        )
        .expect("Write HTTPS evidence");
    }
    println!(
        "HTTPS_TRANSPORT_EVIDENCE {}",
        serde_json::to_string(&report).expect("Encode report")
    );
    if let Err(error) = result {
        panic!("{label} loopback HTTPS failed: {error}");
    }
}

#[test]
fn tls12_real_https_complete_json_and_certificate_rejection() {
    verify("TLSv1.2", tls::Version::TLS_1_2, "tls12");
}

#[test]
fn tls13_real_https_complete_json_and_certificate_rejection() {
    verify("TLSv1.3", tls::Version::TLS_1_3, "tls13");
}

#[test]
fn io_wrapped_certificate_errors_keep_exact_typed_reason() {
    for expected in [
        rustls::CertificateError::UnknownIssuer,
        rustls::CertificateError::NotValidForName,
    ] {
        let error = std::io::Error::other(rustls::Error::InvalidCertificate(expected.clone()));
        let mut chain = Vec::new();
        let actual = certificate_error_in_chain(&error, &mut chain);
        assert_eq!(
            actual,
            Some(&expected),
            "typed cause hidden by io wrapper: {chain:?}"
        );
    }
}

#[test]
fn non_certificate_errors_never_pass_by_text_or_transport_failure() {
    let errors = [
        std::io::Error::other(rustls::Error::General(
            "UnknownIssuer NotValidForName".into(),
        )),
        std::io::Error::new(std::io::ErrorKind::TimedOut, "UnknownIssuer"),
        std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "NotValidForName"),
    ];
    for error in errors {
        assert!(certificate_error_in_chain(&error, &mut Vec::new()).is_none());
    }
}
