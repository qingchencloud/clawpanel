//! Pi 桌面适配：嵌入同一份 Node 运行时，通过私有回环桥复用配置及会话语义。
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

struct PiBridge {
    child: Child,
    root: PathBuf,
    port: u16,
    token: String,
}

static BRIDGE: LazyLock<tokio::sync::Mutex<Option<PiBridge>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

/// 仅移除本项目的静态相对 import，保留 Node 内置模块导入；不改写第三方源码。
fn bridge_source() -> String {
    let runtime = include_str!("../../../scripts/pi-runtime.js")
        .replace("\r\n", "\n")
        .replace("import { PiRpcProcess } from './pi-rpc.js'\n", "")
        .replace("import { PI_PACKAGE_NAME, PI_PACKAGE_VERSION, piVersion, piNodeSupported, piCredentialEnv, mergePiConfig } from './pi-models.js'\n", "")
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
        "await startPiBridge();\n",
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
    std::fs::write(&source_path, bridge_source()).map_err(|e| format!("Pi 桥写入失败: {e}"))?;
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
    let mut command = Command::new("node");
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
        let mut line = String::new();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
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
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let details = diagnostics
                .lock()
                .map(|output| String::from_utf8_lossy(&output).replace(&token, "[REDACTED]"))
                .unwrap_or_default();
            if details.trim().is_empty() {
                Err(error)
            } else {
                Err(format!("{error}: {}", details.trim()))
            }
        }
    }
}

#[tauri::command]
pub async fn pi_call(command: String, args: Option<Value>) -> Result<Value, String> {
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
        .json(&json!({ "command": command, "args": args.unwrap_or_else(|| json!({})) }))
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
