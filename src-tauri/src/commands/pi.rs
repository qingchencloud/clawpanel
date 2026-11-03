//! Pi 桌面适配：嵌入同一份 Node 运行时，通过私有回环桥复用配置及会话语义。
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

struct PiBridge {
    child: Child,
    root: PathBuf,
    port: u16,
    token: String,
}

static BRIDGE: LazyLock<tokio::sync::Mutex<Option<PiBridge>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

// 只观察实际读取进度，不改变 BufReader 的首行/EOF/UTF8 语义，不记录 stdout 内容。
struct BridgeStartupReader<R> {
    inner: R,
    bytes: Arc<AtomicUsize>,
}

impl<R: Read> Read for BridgeStartupReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let size = self.inner.read(buffer)?;
        self.bytes.fetch_add(size, Ordering::Relaxed);
        Ok(size)
    }
}

pub(super) fn official_installed_local() -> bool {
    super::openclaw_dir()
        .join(
            "clawpanel/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        )
        .is_file()
}

/// 只读已存在的桥；没有桥时立即返回，不生成脚本、目录或子进程。
pub(super) async fn official_status_existing() -> Result<Value, String> {
    let (port, token) = {
        let mut slot = BRIDGE.lock().await;
        let Some(bridge) = slot.as_mut() else {
            return Ok(json!({"connected":false}));
        };
        if bridge
            .child
            .try_wait()
            .map_err(|_| "official_runtime_unavailable")?
            .is_some()
        {
            return Ok(json!({"connected":false}));
        }
        (bridge.port, bridge.token.clone())
    };
    let body: Value = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "official_runtime_unavailable")?
        .post(format!("http://127.0.0.1:{port}/call"))
        .bearer_auth(token)
        .json(&json!({"command":"official_status","args":{}}))
        .send()
        .await
        .map_err(|_| "official_runtime_unavailable")?
        .json()
        .await
        .map_err(|_| "official_runtime_unavailable")?;
    let value = &body["result"];
    Ok(
        json!({"connected":value["status"]=="connected","memberId":value["memberId"],"epoch":value["epoch"],"running":false,"modelId":value["modelId"],"textOnly":value["textOnly"],"toolsAvailable":value["toolsAvailable"]}),
    )
}

pub(super) async fn official_connect_selected(connection: Value) -> Result<Value, String> {
    if !super::platform::engine_identity_current(&connection).await {
        return Err("platform_account_changed".into());
    }
    let result = bridge_call("connect_official", json!({"connection":connection})).await?;
    if !super::platform::engine_identity_current(&connection).await {
        let _ = stop_official_for_identity(Some(&connection)).await;
        return Err("platform_account_changed".into());
    }
    Ok(result)
}

pub(super) async fn official_new_session(
    model_id: &str,
    expected: &Value,
) -> Result<Value, String> {
    if !super::platform::engine_identity_current(expected).await {
        return Err("platform_account_changed".into());
    }
    let status = official_status_existing().await?;
    if status["connected"] != true
        || status["memberId"] != expected["memberId"]
        || status["epoch"] != expected["epoch"]
    {
        return Err("official_engine_not_connected".into());
    }
    let result = bridge_call("open_session", json!({"officialModelId":model_id})).await?;
    if !super::platform::engine_identity_current(expected).await {
        return Err("platform_account_changed".into());
    }
    Ok(json!({"sessionId":result["sessionId"],"model":result["state"]["model"],"newSession":true}))
}

/// 仅移除本项目的静态相对 import，保留 Node 内置模块导入；不改写第三方源码。
fn bridge_source() -> String {
    let runtime = include_str!("../../../scripts/pi-runtime.js")
        .replace("\r\n", "\n")
        .replace("import { PiRpcProcess } from './pi-rpc.js'\n", "")
        .replace("import { PI_PACKAGE_NAME, PI_PACKAGE_VERSION, piVersion, piNodeSupported, piCredentialEnv, mergePiConfig, piOfficialConnection, PI_OFFICIAL_SOURCE } from './pi-models.js'\n", "")
        .replace("import { PI_PERMISSION_SOURCE } from './pi-permission.js'\n", "");
    let bridge = include_str!("../../../scripts/pi-bridge.js")
        .replace("\r\n", "\n")
        .replace("import { PiRuntime } from './pi-runtime.js'\n", "");
    [
        include_str!("../../../scripts/pi-models.js"),
        include_str!("../../../scripts/pi-rpc.js"),
        include_str!("../../../scripts/pi-permission.js"),
        &runtime,
        &bridge,
        "process.stderr.write('CLAWPANEL_PI_BRIDGE_MODULE_ENTERED\\n');\n",
        "await startPiBridge();\n",
        "process.stderr.write('CLAWPANEL_PI_BRIDGE_LISTEN_RETURNED\\n');\n",
    ]
    .join("\n")
}

fn node_path(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        // Windows canonicalize 返回的 verbatim 前缀会让 Node CLI 主模块加载报 EISDIR。
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else if let Some(disk) = value.strip_prefix(r"\\?\") {
            PathBuf::from(disk)
        } else {
            path.to_path_buf()
        }
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn spawn_bridge(root: PathBuf) -> Result<PiBridge, String> {
    std::fs::create_dir_all(&root).map_err(|e| format!("Pi 目录创建失败: {e}"))?;
    if std::fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Pi 受管目录不接受符号链接".into());
    }
    let source_path = root.join("clawpanel-bridge.mjs");
    if source_path.is_symlink() {
        return Err("Pi 桥文件不接受符号链接".into());
    }
    let source = bridge_source();
    std::fs::write(&source_path, &source).map_err(|e| format!("Pi 桥写入失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        std::fs::set_permissions(&source_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut command = crate::utils::background_command("node");
    command
        .arg(node_path(&source_path))
        .env("PATH", super::enhanced_path())
        .env("CLAWPANEL_PI_ROOT", node_path(&root))
        .env("CLAWPANEL_PI_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Pi 桥启动失败，请检查 Node.js: {e}"))?;
    let started = Instant::now();
    let stdout_bytes = Arc::new(AtomicUsize::new(0));
    let stdout_finished = Arc::new(AtomicBool::new(false));
    let diagnostics = Arc::new(Mutex::new(Vec::<u8>::new()));
    let captured = Arc::clone(&diagnostics);
    let mut stderr = child.stderr.take().ok_or("Pi 桥 stderr 缺失")?;
    let reader = std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(size) = stderr.read(&mut chunk) {
            if size == 0 {
                break;
            }
            if let Ok(mut output) = captured.lock() {
                output.extend_from_slice(&chunk[..size]);
                if output.len() > 32000 {
                    let excess = output.len() - 32000;
                    output.drain(..excess);
                }
            }
        }
    });
    let result = (|| {
        let stdout = child.stdout.take().ok_or("Pi 桥 stdout 缺失")?;
        let stdout = BridgeStartupReader {
            inner: stdout,
            bytes: Arc::clone(&stdout_bytes),
        };
        let finished = Arc::clone(&stdout_finished);
        let mut line = String::new();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            finished.store(true, Ordering::Relaxed);
            let _ = sender.send(result);
        });
        let line = receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Pi 桥启动超时，请检查 Node.js 与目录权限".to_string())?
            .map_err(|e| e.to_string())?;
        let ready: Value = serde_json::from_str(&line)
            .map_err(|_| "Pi 桥未就绪，请检查 Node.js 安装与目录权限".to_string())?;
        let port = ready["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= 65535)
            .ok_or("Pi 桥端口无效")? as u16;
        Ok::<_, String>(port)
    })();
    match result {
        Ok(port) => Ok(PiBridge {
            child,
            root,
            port,
            token,
        }),
        Err(error) => {
            use sha2::{Digest, Sha256};
            // 先采直接子进程/管道状态再终止；元数据仅用于排障，绝不升级握手结果。
            let elapsed_ms = started.elapsed().as_millis();
            let child_state = child.try_wait();
            let bytes_read = stdout_bytes.load(Ordering::Relaxed);
            let reader_finished = stdout_finished.load(Ordering::Relaxed);
            let _ = child.kill();
            let reaped = child.wait().is_ok();
            let _ = reader.join();
            let output = diagnostics
                .lock()
                .map(|output| output.clone())
                .unwrap_or_default();
            let details = String::from_utf8_lossy(&output).replace(&token, "[REDACTED]");
            let diagnostic = json!({
                "pid": child.id(),
                "timeoutMs": 15000,
                "elapsedMs": elapsed_ms,
                "childExitedBeforeCleanup": child_state.as_ref().ok().map(|status| status.is_some()),
                "childExitCodeBeforeCleanup": child_state.as_ref().ok().and_then(|status| status.as_ref()).and_then(|status| status.code()),
                "childQueryErrorCode": child_state.as_ref().err().and_then(|error| error.raw_os_error()),
                "stdoutBytesRead": bytes_read,
                "stdoutReaderFinished": reader_finished,
                "stderrBytesCaptured": output.len(),
                "moduleEntered": details.contains("CLAWPANEL_PI_BRIDGE_MODULE_ENTERED"),
                "listenReturned": details.contains("CLAWPANEL_PI_BRIDGE_LISTEN_RETURNED"),
                "nodeOptionsPresent": std::env::var_os("NODE_OPTIONS").is_some(),
                "nodePathPresent": std::env::var_os("NODE_PATH").is_some(),
                "sourceSha256": format!("{:x}", Sha256::digest(source.as_bytes())),
                "reaped": reaped,
            });
            let error = format!("{error}\nCLAWPANEL_PI_BRIDGE_STARTUP {diagnostic}");
            if details.trim().is_empty() {
                Err(error)
            } else {
                Err(format!("{error}\n{}", details.trim()))
            }
        }
    }
}

#[tauri::command]
pub async fn pi_call(command: String, args: Option<Value>) -> Result<Value, String> {
    let mut args = args.unwrap_or_else(|| json!({}));
    let object = args.as_object_mut().ok_or("Pi 参数无效")?;
    // 回环能力只由原生取得，不接受页面提供的地址、密钥或账户归属。
    object.remove("connection");
    if command == "connect_official" {
        object.insert(
            "connection".into(),
            super::platform::engine_connection("pi").await?,
        );
    } else if command == "prompt" {
        let selected = bridge_call("official_status", args.clone()).await?;
        if selected["selected"].as_bool() == Some(true) {
            args["connection"] = super::platform::engine_connection("pi").await?;
        }
    }
    bridge_call(&command, args).await
}

async fn bridge_call(command: &str, args: Value) -> Result<Value, String> {
    let root = super::openclaw_dir().join("clawpanel").join("pi");
    let (port, token) = {
        let mut slot = BRIDGE.lock().await;
        let replace = match slot.as_mut() {
            Some(bridge) => {
                bridge.root != root
                    || bridge
                        .child
                        .try_wait()
                        .map_err(|e| e.to_string())?
                        .is_some()
            }
            None => true,
        };
        if replace {
            // 关闭父管道后 Node 桥优雅退出并释放 Pi 子进程。
            if let Some(mut old) = slot.take() {
                old.child.stdin.take();
            }
            let bridge = tokio::task::spawn_blocking(move || spawn_bridge(root))
                .await
                .map_err(|e| e.to_string())??;
            *slot = Some(bridge);
        }
        let bridge = slot.as_ref().ok_or("Pi 桥未启动")?;
        (bridge.port, bridge.token.clone())
    };
    let timeout = if command == "install" || command == "update" {
        720
    } else {
        60
    };
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("http://127.0.0.1:{port}/call"))
        .bearer_auth(token)
        .json(&json!({ "command": command, "args": args }))
        .send()
        .await
        .map_err(|e| format!("Pi 桥请求失败: {e}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Pi 桥响应无效: {e}"))?;
    if let Some(error) = body["error"].as_str() {
        return Err(error.to_string());
    }
    Ok(body["result"].clone())
}

/// 仅向已运行的私有桥清理官方会话，不为退出登录或应用退出新建桥。
pub(crate) async fn stop_official_for_identity(expected: Option<&Value>) -> Result<Value, String> {
    let (port, token) = {
        let mut slot = BRIDGE.lock().await;
        let Some(bridge) = slot.as_mut() else {
            return Ok(json!({"disconnected":true,"bridgeRunning":false,"closed":0}));
        };
        if bridge
            .child
            .try_wait()
            .map_err(|_| "official_runtime_unavailable")?
            .is_some()
        {
            *slot = None;
            return Ok(json!({"disconnected":true,"bridgeRunning":false,"closed":0}));
        }
        (bridge.port, bridge.token.clone())
    };
    let args = match expected {
        Some(value) => {
            let epoch = value["epoch"].as_u64().ok_or("platform_account_changed")?;
            let member = value["memberId"]
                .as_str()
                .filter(|member| !member.is_empty())
                .ok_or("platform_account_changed")?;
            json!({"epoch":epoch,"memberId":member})
        }
        None => json!({}),
    };
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "official_runtime_unavailable")?
        .post(format!("http://127.0.0.1:{port}/call"))
        .bearer_auth(token)
        .json(&json!({"command":"disconnect_official","args":args}))
        .send()
        .await
        .map_err(|_| "official_runtime_stop_pending")?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| "official_runtime_stop_pending")?;
    if body.get("error").is_some() {
        return Err("official_runtime_stop_pending".into());
    }
    Ok(body["result"].clone())
}

pub fn shutdown() {
    if let Ok(mut slot) = BRIDGE.try_lock() {
        if let Some(mut bridge) = slot.take() {
            bridge.child.stdin.take();
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn node_paths_remove_verbatim_disk_and_unc_prefix() {
        use std::path::Path;
        assert_eq!(
            super::node_path(Path::new(r"\\?\D:\Pi\bridge.mjs")),
            Path::new(r"D:\Pi\bridge.mjs")
        );
        assert_eq!(
            super::node_path(Path::new(r"\\?\UNC\server\share\bridge.mjs")),
            Path::new(r"\\server\share\bridge.mjs")
        );
    }

    #[test]
    fn embedded_bridge_has_no_relative_imports() {
        let source = super::bridge_source();
        assert!(!source.contains("from './pi-"));
        assert!(source.contains("await startPiBridge()"));
        assert!(source.contains("127.0.0.1"));
    }

    #[test]
    fn bridge_startup_timeout_reports_owned_child_without_token_or_output() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let flag = "CLAWPANEL_PI_TEST_STARTUP_DIAGNOSTIC";
        if let Ok(nonce) = std::env::var(flag) {
            let nonce: u64 = nonce.parse().unwrap();
            let root = parent.parent().unwrap().to_path_buf();
            assert_eq!(root.join("temp"), parent);
            assert_eq!(
                root.file_name().unwrap().to_string_lossy(),
                format!("clawpanel-pi-startup-diagnostic-{nonce}")
            );
            let error = super::spawn_bridge(root.join("bridge")).err().unwrap();
            let diagnostic = error
                .split("CLAWPANEL_PI_BRIDGE_STARTUP ")
                .nth(1)
                .unwrap_or_else(|| panic!("缺少实际超时诊断: {error}"))
                .lines()
                .next()
                .unwrap();
            let row: serde_json::Value = serde_json::from_str(diagnostic).unwrap();
            assert_eq!(row["timeoutMs"], 15000);
            assert!(row["pid"].as_u64().unwrap() > 0);
            assert_eq!(row["childExitedBeforeCleanup"], false);
            assert!(row["stdoutBytesRead"].as_u64().unwrap() > 0);
            assert_eq!(row["stdoutReaderFinished"], false);
            assert_eq!(row["moduleEntered"], false);
            assert_eq!(row["reaped"], true);
            assert!(row["stderrBytesCaptured"].as_u64().unwrap() <= 32000);
            assert!(error.contains("fixture-token=[REDACTED]"));
            assert!(!error.contains("owned-partial-without-newline"));
            println!("PI_STARTUP_FAULT_RECEIPT {diagnostic}");
            return;
        }
        let nonce = rand::random::<u64>();
        let root = parent.join(format!("clawpanel-pi-startup-diagnostic-{nonce}"));
        std::fs::create_dir(&root).unwrap();
        let preload = root.join("owned-preload.cjs");
        // 自有 Node 仅输出半行并低CPU等待；不执行 Pi、不安装、不修改父环境。
        std::fs::write(
            &preload,
            "process.stdout.write('owned-partial-without-newline');\nprocess.stderr.write('fixture-token='+process.env.CLAWPANEL_PI_TOKEN+'\\n');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);\n",
        )
        .unwrap();
        let mut command = crate::utils::background_command(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "commands::pi::tests::bridge_startup_timeout_reports_owned_child_without_token_or_output",
            "--nocapture",
        ]);
        command.env(flag, nonce.to_string()).env(
            "NODE_OPTIONS",
            format!(
                "--require={}",
                serde_json::to_string(&super::node_path(&preload).to_string_lossy()).unwrap()
            ),
        );
        for (key, directory) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "home/appdata"),
            ("LOCALAPPDATA", "home/localappdata"),
            ("XDG_CONFIG_HOME", "home/config"),
            ("XDG_CACHE_HOME", "home/cache"),
            ("TEMP", "temp"),
            ("TMP", "temp"),
            ("TMPDIR", "temp"),
        ] {
            let directory = root.join(directory);
            std::fs::create_dir_all(&directory).unwrap();
            command.env(key, super::node_path(&directory));
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().unwrap();
        assert_eq!(
            root.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }

    #[test]
    fn embedded_bridge_starts_and_exits_with_parent_pipe() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = parent.join(format!("clawpanel-pi-rust-{}", rand::random::<u64>()));
        let mut bridge = super::spawn_bridge(root.clone()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .build()?;
            let endpoint = format!("http://127.0.0.1:{}/call", bridge.port);
            let denied = client.post(&endpoint).body("{}").send().await?;
            assert_eq!(denied.status(), reqwest::StatusCode::UNAUTHORIZED);
            let allowed: serde_json::Value = client
                .post(&endpoint)
                .bearer_auth(&bridge.token)
                .json(&serde_json::json!({ "command": "status" }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            assert_eq!(allowed["result"]["installed"], false);
            Ok::<_, reqwest::Error>(())
        });
        bridge.child.stdin.take();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let exited = loop {
            if let Some(status) = bridge.child.try_wait().unwrap() {
                break status.success();
            }
            if std::time::Instant::now() > deadline {
                let _ = bridge.child.kill();
                let _ = bridge.child.wait();
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        };
        assert_eq!(
            root.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        std::fs::remove_dir_all(root).unwrap();
        result.unwrap();
        assert!(exited, "Pi 桥应随父进程管道关闭退出");
    }
}
