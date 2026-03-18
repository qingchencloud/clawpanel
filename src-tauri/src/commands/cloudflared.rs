use crate::commands::{apply_proxy_env, build_http_client, openclaw_dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::process::Command;

use tokio::process::Child;
use tokio::io::AsyncBufReadExt;

static STATE: std::sync::LazyLock<Mutex<CloudflaredState>> =
    std::sync::LazyLock::new(|| Mutex::new(CloudflaredState::default()));

#[derive(Default, Debug)]
struct CloudflaredState {
    running: bool,
    mode: String,
    url: Option<String>,
    port: u16,
    tunnel_name: Option<String>,
    hostname: Option<String>,
    last_error: Option<String>,
    child: Option<Child>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudflaredStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub running: bool,
    pub url: Option<String>,
    pub mode: Option<String>,
    pub port: Option<u16>,
    pub tunnel_name: Option<String>,
    pub hostname: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudflaredStartConfig {
    pub mode: String,              // quick | named
    pub port: u16,
    pub use_http2: bool,
    pub tunnel_name: Option<String>,
    pub hostname: Option<String>,
    pub add_allowed_origins: bool,
    pub expose_target: Option<String>, // gateway | webui | custom
}

const CLOUDFLARED_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

// Mirrors are prefixes prepended to the GitHub release URL.
// Keep them short and stable; we probe latency via HEAD.
const MIRROR_PREFIXES: [&str; 7] = [
    "https://gh-proxy.com/",
    "https://gh-proxy.org/",
    "https://cdn.gh-proxy.org/",
    "https://hk.gh-proxy.org/",
    "https://gh.ddlc.top/",
    "https://mirror.ghproxy.com/",
    "", // direct GitHub
];

fn resolve_cloudflared_bin() -> Option<PathBuf> {
    let openclaw_bin = openclaw_dir().join("bin").join("cloudflared.exe");
    if openclaw_bin.exists() {
        return Some(openclaw_bin);
    }

    // PATH search: cloudflared.exe or cloudflare.exe
    let path = crate::commands::enhanced_path();
    for p in path.split(';') {
        let base = Path::new(p);
        let cand = base.join("cloudflared.exe");
        if cand.exists() {
            return Some(cand);
        }
        let cand2 = base.join("cloudflare.exe");
        if cand2.exists() {
            return Some(cand2);
        }
    }
    None
}

fn cloudflared_cmd(bin: &Path) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(bin);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        return cmd;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(bin)
    }
}

fn get_version(bin: &Path) -> Option<String> {
    let mut cmd = cloudflared_cmd(bin);
    cmd.arg("--version");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let output = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if output.is_empty() {
        return None;
    }
    Some(output)
}

#[tauri::command]
pub fn cloudflared_get_status() -> Result<Value, String> {
    let bin = resolve_cloudflared_bin();
    let installed = bin.is_some();
    let version = bin.as_ref().and_then(|b| get_version(b));

    let state = STATE.lock().unwrap();
    Ok(json!(CloudflaredStatus {
        installed,
        version,
        running: state.running,
        url: state.url.clone(),
        mode: if state.mode.is_empty() { None } else { Some(state.mode.clone()) },
        port: if state.port == 0 { None } else { Some(state.port) },
        tunnel_name: state.tunnel_name.clone(),
        hostname: state.hostname.clone(),
        last_error: state.last_error.clone(),
    }))
}

#[tauri::command]
pub async fn cloudflared_install() -> Result<Value, String> {
    let bin_path = openclaw_dir().join("bin").join("cloudflared.exe");
    if bin_path.exists() {
        return cloudflared_get_status();
    }

    let client = build_http_client(Duration::from_secs(60), Some("ClawPanel"))
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;

    // Probe mirrors (HEAD)
    let mut fastest: Option<(String, i64)> = None;
    for prefix in MIRROR_PREFIXES.iter() {
        let url = format!("{}{}", prefix, CLOUDFLARED_URL);
        let start = std::time::Instant::now();
        let resp = client.head(&url).send().await;
        let elapsed = start.elapsed().as_millis() as i64;
        if let Ok(r) = resp {
            if r.status().as_u16() < 400 {
                match fastest {
                    None => fastest = Some((prefix.to_string(), elapsed)),
                    Some((_, best)) if elapsed < best => fastest = Some((prefix.to_string(), elapsed)),
                    _ => {}
                }
            }
        }
    }

    let prefix = fastest.map(|v| v.0).unwrap_or_else(|| "".to_string());
    let url = format!("{}{}", prefix, CLOUDFLARED_URL);

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if resp.status().as_u16() >= 400 {
        return Err(format!("下载失败: HTTP {}", resp.status().as_u16()));
    }

    if let Some(parent) = bin_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let bytes = resp.bytes().await.map_err(|e| format!("读取下载内容失败: {e}"))?;
    let tmp = bin_path.with_extension("exe.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    if bin_path.exists() {
        let _ = std::fs::remove_file(&bin_path);
    }
    std::fs::rename(&tmp, &bin_path).map_err(|e| format!("安装失败: {e}"))?;

    cloudflared_get_status()
}

#[tauri::command]
pub fn cloudflared_login() -> Result<String, String> {
    let bin = resolve_cloudflared_bin().ok_or("cloudflared 未安装")?;
    let mut cmd = cloudflared_cmd(&bin);
    cmd.args(["tunnel", "login"]);
    apply_proxy_env(&mut cmd);
    let out = cmd.output().map_err(|e| format!("登录失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("登录失败: {stderr}"));
    }
    Ok("登录成功".into())
}

fn parse_quick_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        if token.starts_with("https://") && token.contains("trycloudflare.com") {
            return Some(token.trim().to_string());
        }
    }
    None
}

fn extract_origin(url: &str) -> Option<String> {
    if let Some(idx) = url.find("//") {
        let rest = &url[idx + 2..];
        let host = rest.split('/').next().unwrap_or("");
        if !host.is_empty() {
            return Some(format!("https://{host}"));
        }
    }
    None
}

fn add_allowed_origin_for_target(origin: &str, target: &str, port: u16) -> Result<(), String> {
    let mut config = crate::commands::config::load_openclaw_json()?;
    let root = config.as_object_mut().ok_or("配置格式错误")?;
    let gateway = root.entry("gateway").or_insert_with(|| json!({}));
    let gateway_obj = gateway.as_object_mut().ok_or("gateway 节点格式错误")?;

    // webui 目标时，确保 controlUi 存在
    let control = gateway_obj.entry("controlUi").or_insert_with(|| json!({}));
    let control_obj = control.as_object_mut().ok_or("gateway.controlUi 节点格式错误")?;
    let arr = control_obj
        .entry("allowedOrigins")
        .or_insert_with(|| json!([]));
    let list = arr.as_array_mut().ok_or("allowedOrigins 格式错误")?;

    // 允许同时写入指定 origin（用于 Web UI 1420）
    if !list.iter().any(|v| v.as_str() == Some(origin)) {
        list.push(Value::String(origin.to_string()));
    }

    // gateway 目标时，补充 http origin（用于 18789）
    if target == "gateway" || target == "custom" {
        let http_origin = format!("http://{}", origin.trim_start_matches("https://"));
        if !list.iter().any(|v| v.as_str() == Some(http_origin.as_str())) {
            list.push(Value::String(http_origin));
        }
    }

    // webui 目标时，补充具体端口 origin
    if target == "webui" {
        let host = origin.trim_start_matches("https://");
        let http_origin = format!("http://{host}:{port}");
        if !list.iter().any(|v| v.as_str() == Some(http_origin.as_str())) {
            list.push(Value::String(http_origin));
        }
    }

    crate::commands::config::save_openclaw_json(&config)?;
    Ok(())
}

#[allow(dead_code)]
fn add_allowed_origin(origin: &str) -> Result<(), String> {
    let mut config = crate::commands::config::load_openclaw_json()?;
    let root = config.as_object_mut().ok_or("配置格式错误")?;
    let gateway = root.entry("gateway").or_insert_with(|| json!({}));
    let gateway_obj = gateway.as_object_mut().ok_or("gateway 节点格式错误")?;
    let control = gateway_obj.entry("controlUi").or_insert_with(|| json!({}));
    let control_obj = control.as_object_mut().ok_or("gateway.controlUi 节点格式错误")?;
    let arr = control_obj
        .entry("allowedOrigins")
        .or_insert_with(|| json!([]));
    let list = arr.as_array_mut().ok_or("allowedOrigins 格式错误")?;
    if !list.iter().any(|v| v.as_str() == Some(origin)) {
        list.push(Value::String(origin.to_string()));
    }
    crate::commands::config::save_openclaw_json(&config)?;
    Ok(())
}

fn ensure_named_config(tunnel_name: &str, hostname: &str, port: u16) -> Result<PathBuf, String> {
    let bin = resolve_cloudflared_bin().ok_or("cloudflared 未安装")?;

    // create tunnel if not exists
    let mut cmd = cloudflared_cmd(&bin);
    cmd.args(["tunnel", "list", "--output", "json"]);
    apply_proxy_env(&mut cmd);
    let out = cmd.output().map_err(|e| format!("tunnel list failed: {e}"))?;
    let mut tunnel_id = None;
    if out.status.success() {
        if let Ok(items) = serde_json::from_slice::<Vec<Value>>(&out.stdout) {
            for it in items {
                if it.get("name").and_then(|v| v.as_str()) == Some(tunnel_name) {
                    if let Some(id) = it.get("id").and_then(|v| v.as_str()) {
                        tunnel_id = Some(id.to_string());
                        break;
                    }
                }
            }
        }
    }

    if tunnel_id.is_none() {
        let mut c = cloudflared_cmd(&bin);
        c.args(["tunnel", "create", tunnel_name]);
        apply_proxy_env(&mut c);
        let out = c.output().map_err(|e| format!("tunnel create failed: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("tunnel create failed: {stderr}"));
        }
        // re-list
        let mut list = cloudflared_cmd(&bin);
        list.args(["tunnel", "list", "--output", "json"]);
        apply_proxy_env(&mut list);
        let out2 = list.output().map_err(|e| format!("tunnel list failed: {e}"))?;
        if out2.status.success() {
            if let Ok(items) = serde_json::from_slice::<Vec<Value>>(&out2.stdout) {
                for it in items {
                    if it.get("name").and_then(|v| v.as_str()) == Some(tunnel_name) {
                        if let Some(id) = it.get("id").and_then(|v| v.as_str()) {
                            tunnel_id = Some(id.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    let tunnel_id = tunnel_id.ok_or("无法获取 tunnel id")?;

    let home = dirs::home_dir().ok_or("无法获取用户目录")?;
    let cred_path = home.join(".cloudflared").join(format!("{tunnel_id}.json"));
    if !cred_path.exists() {
        return Err("凭据文件不存在，请先完成登录".into());
    }

    let mut route = cloudflared_cmd(&bin);
    route.args(["tunnel", "route", "dns", "--overwrite-dns", &tunnel_id, hostname]);
    apply_proxy_env(&mut route);
    let out = route.output().map_err(|e| format!("route dns failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("route dns failed: {stderr}"));
    }

    let cfg_dir = openclaw_dir().join("cloudflared");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let cfg_path = cfg_dir.join("config.yml");
    let content = format!(
        "tunnel: {tunnel_id}\ncredentials-file: {}\n\ningress:\n  - hostname: {hostname}\n    service: http://127.0.0.1:{port}\n  - service: http_status:404\n",
        cred_path.to_string_lossy()
    );
    std::fs::write(&cfg_path, content).map_err(|e| format!("写入配置失败: {e}"))?;

    Ok(cfg_path)
}

#[tauri::command]
pub async fn cloudflared_start(config: CloudflaredStartConfig) -> Result<Value, String> {
    let bin = resolve_cloudflared_bin().ok_or("cloudflared 未安装")?;

    let port = if config.port == 0 { 18789 } else { config.port };

    // stop existing
    let existing_child = {
        let mut state = STATE.lock().unwrap();
        let child = state.child.take();
        state.running = false;
        state.url = None;
        state.last_error = None;
        child
    };
    if let Some(mut child) = existing_child {
        let _ = child.kill().await;
    }

    let mode = config.mode.clone();
    let use_http2 = config.use_http2;

    let mut child: Child;
    let mut url: Option<String> = None;

    if mode == "quick" {
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")]);
        if use_http2 {
            cmd.args(["--protocol", "http2"]);
        }
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let mut state = STATE.lock().unwrap();
                    state.last_error = Some(line);
                }
            });
        }

        // parse stdout for url
        if let Some(stdout) = child.stdout.take() {
            let mut reader = tokio::io::BufReader::new(stdout).lines();
            let deadline = std::time::Instant::now() + Duration::from_secs(12);
            loop {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                let remain = deadline.saturating_duration_since(now);
                match tokio::time::timeout(remain, reader.next_line()).await {
                    Ok(Ok(Some(l))) => {
                        if let Some(u) = parse_quick_url(&l) {
                            url = Some(u);
                            break;
                        }
                    }
                    Ok(Ok(None)) => break,
                    Ok(Err(_)) => break,
                    Err(_) => break,
                }
            }
        }
    } else {
        let tunnel_name = config.tunnel_name.clone().ok_or("缺少隧道名称")?;
        let hostname = config.hostname.clone().ok_or("缺少域名")?;
        let cfg_path = ensure_named_config(&tunnel_name, &hostname, port)?;

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args([
            "tunnel",
            "--config",
            &cfg_path.to_string_lossy(),
            "--edge-ip-version",
            "4",
            "run",
            "--dns-resolver-addrs",
            "1.1.1.1:53",
            "--dns-resolver-addrs",
            "8.8.8.8:53",
            &tunnel_name,
        ]);
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
        url = Some(format!("https://{hostname}"));
    }

    if let Some(u) = url.clone() {
        if config.add_allowed_origins {
            if let Some(origin) = extract_origin(&u) {
                let _ = add_allowed_origin_for_target(&origin, config.expose_target.as_deref().unwrap_or("gateway"), port);
            }
        }
    }

    let mut state = STATE.lock().unwrap();
    state.running = true;
    state.mode = mode;
    state.url = url.clone();
    state.port = port;
    state.tunnel_name = config.tunnel_name.clone();
    state.hostname = config.hostname.clone();
    state.child = Some(child);

    Ok(json!(CloudflaredStatus {
        installed: true,
        version: get_version(&bin),
        running: true,
        url,
        mode: Some(config.mode),
        port: Some(port),
        tunnel_name: config.tunnel_name,
        hostname: config.hostname,
        last_error: None,
    }))
}

#[tauri::command]
pub async fn cloudflared_stop() -> Result<Value, String> {
    let existing_child = {
        let mut state = STATE.lock().unwrap();
        let child = state.child.take();
        state.running = false;
        state.url = None;
        child
    };
    if let Some(mut child) = existing_child {
        let _ = child.kill().await;
    }
    let state = STATE.lock().unwrap();
    Ok(json!(CloudflaredStatus {
        installed: resolve_cloudflared_bin().is_some(),
        version: resolve_cloudflared_bin().as_ref().and_then(|b| get_version(b)),
        running: false,
        url: None,
        mode: if state.mode.is_empty() { None } else { Some(state.mode.clone()) },
        port: if state.port == 0 { None } else { Some(state.port) },
        tunnel_name: state.tunnel_name.clone(),
        hostname: state.hostname.clone(),
        last_error: None,
    }))
}
