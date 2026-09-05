//! DeepSeek Harness 回环服务管理与模型配置同步。
//!
//! Harness 始终绑定 127.0.0.1；远程浏览器只调用 ClawPanel 的 Tauri/Web
//! 后端命令，不直接暴露 Harness 配置面和凭据接口。

use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const DSH_PACKAGE_NAME: &str = "@deepseek-ai/dsh";
const DSH_PACKAGE_VERSION: &str = "0.1.1-rc.2";
const DSH_DEFAULT_PORT: u16 = 3080;
const DSH_NODE_REQUIREMENT: &str = "^22.19.0 || >=24.0.0";
const DSH_PNPM_VERSION: &str = "11.7.0";
const DSH_BUILD_PACKAGES: &[&str] = &[
    "@deepseek-ai/dsh-subprocess-local",
    "@google/genai",
    "koffi",
    "node-pty",
    "protobufjs",
];
const DSH_SETTINGS_NAMESPACE: &str = "llm-pi-ai";
const DSH_DEFAULT_MODEL_NAMESPACE: &str = "agent-default-model";

static INSTALL_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime_dir() -> PathBuf {
    super::openclaw_dir()
        .join("clawpanel")
        .join("deepseek-harness")
}

fn managed_entry() -> PathBuf {
    runtime_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

fn package_json_path() -> PathBuf {
    runtime_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json")
}

fn pid_path() -> PathBuf {
    runtime_dir().join("web.pid.json")
}

fn log_path() -> PathBuf {
    runtime_dir().join("web.log")
}

fn parse_version(value: &str) -> Option<[u64; 3]> {
    let raw = value.trim().trim_start_matches('v');
    let core = raw.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    Some([
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
    ])
}

fn node_compatible(version: &str) -> bool {
    let Some([major, minor, _patch]) = parse_version(version) else {
        return false;
    };
    major >= 24 || (major == 22 && minor >= 19)
}

fn find_command(name: &str) -> Option<PathBuf> {
    let output = if cfg!(windows) {
        Command::new("where.exe").arg(name).output().ok()?
    } else {
        Command::new("which").arg(name).output().ok()?
    };
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

fn node_program() -> Result<PathBuf, String> {
    find_command(if cfg!(windows) { "node.exe" } else { "node" })
        .ok_or_else(|| "未检测到 Node.js，请先安装 Node.js 22.19+".to_string())
}

fn node_version() -> String {
    node_program()
        .and_then(|node| {
            Command::new(node)
                .arg("--version")
                .env("PATH", super::enhanced_path())
                .output()
                .map_err(|e| e.to_string())
        })
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn managed_version() -> String {
    fs::read_to_string(package_json_path())
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn read_pid_record() -> Option<Value> {
    let value: Value = serde_json::from_str(&fs::read_to_string(pid_path()).ok()?).ok()?;
    value.get("pid")?.as_u64().filter(|pid| *pid > 0)?;
    Some(value)
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    } else {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn process_command_line(pid: u32) -> String {
    if cfg!(windows) {
        let script = format!(
            "(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction SilentlyContinue).CommandLine"
        );
        return Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default();
    }
    let proc_path = PathBuf::from(format!("/proc/{pid}/cmdline"));
    if let Ok(mut file) = File::open(proc_path) {
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_ok() {
            return String::from_utf8_lossy(&bytes).replace('\0', " ");
        }
    }
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default()
}

fn managed_pid() -> Option<u32> {
    let record = read_pid_record()?;
    let pid = u32::try_from(record.get("pid")?.as_u64()?).ok()?;
    if !process_alive(pid) {
        return None;
    }
    let command = process_command_line(pid).to_lowercase().replace('\\', "/");
    let expected_entry = record
        .get("entry")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase()
        .replace('\\', "/");
    let local_entry = managed_entry()
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/");
    if (!expected_entry.is_empty() && command.contains(&expected_entry))
        || command.contains(&local_entry)
    {
        Some(pid)
    } else {
        None
    }
}

fn rpc_id() -> String {
    format!(
        "clawpanel-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    )
}

async fn rpc(method: &str, payload: Value, port: u16) -> Result<Value, String> {
    if method.is_empty()
        || !method
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
    {
        return Err("DeepSeek Harness RPC 方法名无效".into());
    }
    let rpc_id = rpc_id();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建 DeepSeek Harness HTTP 客户端失败: {e}"))?;
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/{method}"))
        .json(&json!({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": method,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|e| format!("DeepSeek Harness 不可达: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("DeepSeek Harness 返回非 JSON 响应: HTTP {status}: {e}"))?;
    let error_message = || {
        body.pointer("/result/error/message")
            .or_else(|| body.pointer("/error/message"))
            .or_else(|| body.get("error"))
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string())
            })
            .unwrap_or_else(|| format!("{method} 调用失败"))
    };
    if !status.is_success() {
        return Err(error_message());
    }
    if body.get("type").and_then(Value::as_str) != Some("server-response")
        || body.get("rpcId").and_then(Value::as_str) != Some(rpc_id.as_str())
    {
        return Err(format!("DeepSeek Harness RPC 响应不匹配: {method}"));
    }
    if body.pointer("/result/ok").and_then(Value::as_bool) != Some(true) {
        return Err(error_message());
    }
    Ok(body
        .pointer("/result/value")
        .cloned()
        .unwrap_or_else(|| json!({})))
}

fn namespace<'a>(describe: &'a Value, ns: &str) -> Option<&'a Value> {
    describe
        .get("namespaces")?
        .as_array()?
        .iter()
        .find(|item| item.get("ns").and_then(Value::as_str) == Some(ns))
}

async fn read_summary(port: u16) -> Result<Value, String> {
    let settings = rpc("settings.describe", json!({}), port).await?;
    let providers = rpc("llm.providers", json!({}), port).await?;
    let models = rpc("llm.models", json!({}), port).await?;
    let configured: Vec<Value> = namespace(&settings, DSH_SETTINGS_NAMESPACE)
        .and_then(|value| value.pointer("/value/providers"))
        .and_then(Value::as_object)
        .map(|value| value.keys().cloned().map(Value::String).collect())
        .unwrap_or_default();
    let active: Vec<Value> = providers
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("active").and_then(Value::as_bool) == Some(true))
                .filter_map(|item| item.get("provider").and_then(Value::as_str))
                .map(|value| Value::String(value.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let defaults =
        namespace(&settings, DSH_DEFAULT_MODEL_NAMESPACE).and_then(|value| value.get("value"));
    let default_model = defaults
        .and_then(|value| {
            Some(format!(
                "{}/{}",
                value.get("provider")?.as_str()?,
                value.get("model")?.as_str()?
            ))
        })
        .unwrap_or_default();
    let model_count: usize = models
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|group| {
                    group
                        .get("models")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0);
    Ok(json!({
        "writable": settings.get("writable").and_then(Value::as_bool) == Some(true),
        "configuredProviders": configured,
        "activeProviders": active,
        "defaultModel": default_model,
        "modelCount": model_count,
        "failures": models.get("failures").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
    }))
}

async fn port_open(port: u16) -> bool {
    tokio::task::spawn_blocking(move || {
        let address = format!("127.0.0.1:{port}").parse().ok();
        address
            .and_then(|address| {
                std::net::TcpStream::connect_timeout(&address, Duration::from_millis(700)).ok()
            })
            .is_some()
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn dsh_status(port: Option<u16>) -> Result<Value, String> {
    let port = port.unwrap_or(DSH_DEFAULT_PORT);
    if port < 1024 {
        return Err("DeepSeek Harness 端口必须是 1024-65535 的整数".into());
    }
    let entry = managed_entry();
    let managed_installed = entry.is_file();
    let global = if managed_installed {
        None
    } else {
        find_command(if cfg!(windows) { "dsh.cmd" } else { "dsh" }).or_else(|| find_command("dsh"))
    };
    let pid = managed_pid();
    let node_version = node_version();
    let is_port_open = port_open(port).await;
    let (running, summary, error) = if is_port_open {
        match read_summary(port).await {
            Ok(summary) => (true, Some(summary), String::new()),
            Err(error) => (false, None, error),
        }
    } else {
        (false, None, String::new())
    };
    Ok(json!({
        "installed": managed_installed || global.is_some(),
        "managedInstalled": managed_installed,
        "installRunning": INSTALL_MUTEX.try_lock().is_err(),
        "running": running,
        "managed": running && pid.is_some(),
        "portOpen": is_port_open,
        "foreignPort": is_port_open && !running,
        "port": port,
        "url": format!("http://127.0.0.1:{port}"),
        "version": if managed_installed { managed_version() } else { String::new() },
        "targetVersion": DSH_PACKAGE_VERSION,
        "packageName": DSH_PACKAGE_NAME,
        "path": if managed_installed { entry.to_string_lossy().to_string() } else { global.as_ref().map(|value| value.to_string_lossy().to_string()).unwrap_or_default() },
        "runtimeDir": runtime_dir().to_string_lossy(),
        "logPath": log_path().to_string_lossy(),
        "pid": pid,
        "nodeVersion": node_version,
        "nodeRequirement": DSH_NODE_REQUIREMENT,
        "nodeCompatible": node_compatible(&node_version),
        "summary": summary,
        "error": error,
    }))
}

async fn run_install_command(runtime: PathBuf) -> Result<(), String> {
    let path = super::enhanced_path();
    let pnpm_available = if cfg!(windows) {
        Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "pnpm", "--version"])
            .env("PATH", &path)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    } else {
        Command::new("pnpm")
            .arg("--version")
            .env("PATH", &path)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    };
    let mut command = if cfg!(windows) {
        let mut command = tokio::process::Command::new("cmd.exe");
        if pnpm_available {
            command.args(["/D", "/S", "/C", "pnpm"]);
        } else {
            command.args([
                "/D",
                "/S",
                "/C",
                "npm",
                "exec",
                "--yes",
                &format!("pnpm@{DSH_PNPM_VERSION}"),
                "--",
            ]);
        }
        command
    } else if pnpm_available {
        tokio::process::Command::new("pnpm")
    } else {
        let mut command = tokio::process::Command::new("npm");
        command.args(["exec", "--yes", &format!("pnpm@{DSH_PNPM_VERSION}"), "--"]);
        command
    };
    command.args(["add", "--dir"]);
    command.arg(&runtime);
    command.args(["--save-exact", "--prod"]);
    for package in DSH_BUILD_PACKAGES {
        command.arg(format!("--allow-build={package}"));
    }
    command.arg(format!("{DSH_PACKAGE_NAME}@{DSH_PACKAGE_VERSION}"));
    command.env("PATH", path);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(20 * 60), command.output())
        .await
        .map_err(|_| "DeepSeek Harness pnpm 安装超时".to_string())?
        .map_err(|e| format!("启动 pnpm 失败: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail
            .chars()
            .rev()
            .take(8000)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        return Err(if detail.trim().is_empty() {
            format!("pnpm 安装失败: {}", output.status)
        } else {
            detail
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn dsh_install() -> Result<Value, String> {
    let _guard = INSTALL_MUTEX
        .try_lock()
        .map_err(|_| "DeepSeek Harness 安装任务正在运行".to_string())?;
    let node = node_version();
    if !node_compatible(&node) {
        return Err(format!(
            "DeepSeek Harness {DSH_PACKAGE_VERSION} 要求 Node.js {DSH_NODE_REQUIREMENT}，当前为 {}",
            if node.is_empty() {
                "未检测到"
            } else {
                &node
            }
        ));
    }
    fs::create_dir_all(runtime_dir()).map_err(|e| format!("创建 Harness 运行目录失败: {e}"))?;
    run_install_command(runtime_dir()).await?;
    if !managed_entry().is_file() {
        return Err("pnpm 安装完成，但未找到 DeepSeek Harness 入口文件".into());
    }
    let version = managed_version();
    if version != DSH_PACKAGE_VERSION {
        return Err(format!("DeepSeek Harness 安装版本回读不一致: {version}"));
    }
    dsh_status(Some(DSH_DEFAULT_PORT)).await
}

fn verified_runtime_dir() -> Result<PathBuf, String> {
    let expected = super::openclaw_dir()
        .join("clawpanel")
        .join("deepseek-harness");
    let actual = runtime_dir();
    if actual != expected
        || actual.file_name().and_then(|value| value.to_str()) != Some("deepseek-harness")
    {
        return Err("DeepSeek Harness 运行目录校验失败，未执行卸载".into());
    }
    Ok(actual)
}

#[tauri::command]
pub async fn dsh_uninstall() -> Result<Value, String> {
    let _guard = INSTALL_MUTEX
        .try_lock()
        .map_err(|_| "DeepSeek Harness 安装或卸载任务正在运行".to_string())?;
    if managed_pid().is_some() {
        return Err("请先停止 ClawPanel 管理的 DeepSeek Harness，再卸载受管运行时".into());
    }
    let runtime = verified_runtime_dir()?;
    if runtime.exists() {
        fs::remove_dir_all(&runtime)
            .map_err(|e| format!("卸载 DeepSeek Harness 运行目录失败: {e}"))?;
    }
    if runtime.exists() {
        return Err("DeepSeek Harness 运行目录卸载后仍然存在".into());
    }
    let mut status = dsh_status(Some(DSH_DEFAULT_PORT)).await?;
    if let Some(object) = status.as_object_mut() {
        object.insert("removedManaged".into(), Value::Bool(true));
    }
    Ok(status)
}

fn append_log_file() -> Result<File, String> {
    fs::create_dir_all(runtime_dir()).map_err(|e| format!("创建 Harness 运行目录失败: {e}"))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|e| format!("打开 Harness 日志失败: {e}"))
}

fn write_pid_record(pid: u32, port: u16, entry: &Path) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&json!({
        "pid": pid,
        "port": port,
        "startedAt": chrono::Utc::now().to_rfc3339(),
        "entry": entry.to_string_lossy(),
    }))
    .map_err(|e| format!("序列化 Harness PID 失败: {e}"))?;
    fs::write(pid_path(), content).map_err(|e| format!("写入 Harness PID 失败: {e}"))
}

fn spawn_web(port: u16) -> Result<u32, String> {
    let entry = managed_entry();
    let (program, mut args, record_entry) = if entry.is_file() {
        (
            node_program()?,
            vec![entry.to_string_lossy().to_string()],
            entry.clone(),
        )
    } else {
        let command = find_command(if cfg!(windows) { "dsh.cmd" } else { "dsh" })
            .or_else(|| find_command("dsh"))
            .ok_or_else(|| "DeepSeek Harness 未安装".to_string())?;
        (command.clone(), Vec::new(), command)
    };
    args.extend([
        "web".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--no-open".into(),
    ]);
    let log = append_log_file()?;
    let err_log = log
        .try_clone()
        .map_err(|e| format!("复制 Harness 日志句柄失败: {e}"))?;

    let mut command = if cfg!(windows)
        && program
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("cmd"))
    {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]);
        command.arg(&program);
        command
    } else {
        Command::new(&program)
    };
    command
        .args(args)
        .current_dir(runtime_dir())
        .env("PATH", super::enhanced_path())
        .env("CLAWPANEL_DSH_MANAGED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("启动 DeepSeek Harness 失败: {e}"))?;
    let pid = child.id();
    write_pid_record(pid, port, &record_entry)?;
    Ok(pid)
}

#[tauri::command]
pub async fn dsh_start(port: Option<u16>) -> Result<Value, String> {
    let port = port.unwrap_or(DSH_DEFAULT_PORT);
    let before = dsh_status(Some(port)).await?;
    if before.get("running").and_then(Value::as_bool) == Some(true) {
        return Ok(before);
    }
    if before.get("foreignPort").and_then(Value::as_bool) == Some(true) {
        return Err(format!("端口 {port} 已被其他服务占用"));
    }
    if managed_pid().is_some() {
        let managed_port = read_pid_record()
            .and_then(|record| record.get("port").and_then(Value::as_u64))
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".into());
        return Err(format!(
            "ClawPanel 管理的 DeepSeek Harness 已在端口 {managed_port} 启动，请先停止后再切换端口"
        ));
    }
    if before.get("installed").and_then(Value::as_bool) != Some(true) {
        return Err("DeepSeek Harness 未安装，请先安装受管运行时".into());
    }
    spawn_web(port)?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let current = dsh_status(Some(port)).await?;
        if current.get("running").and_then(Value::as_bool) == Some(true) {
            return Ok(current);
        }
        if managed_pid().is_none() {
            break;
        }
    }
    let tail = fs::read_to_string(log_path())
        .ok()
        .map(|content| {
            content
                .chars()
                .rev()
                .take(4000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        })
        .unwrap_or_default();
    Err(if tail.trim().is_empty() {
        "DeepSeek Harness 启动失败".into()
    } else {
        format!("DeepSeek Harness 启动失败: {tail}")
    })
}

#[tauri::command]
pub async fn dsh_stop(port: Option<u16>) -> Result<Value, String> {
    let port = port.unwrap_or(DSH_DEFAULT_PORT);
    if port < 1024 {
        return Err("DeepSeek Harness 端口必须是 1024-65535 的整数".into());
    }
    let Some(pid) = managed_pid() else {
        let current = dsh_status(Some(port)).await?;
        if current.get("running").and_then(Value::as_bool) == Some(true) {
            return Err("当前 DeepSeek Harness 不是由 ClawPanel 启动，未执行停止操作".into());
        }
        return Ok(current);
    };
    if cfg!(windows) {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    } else {
        let _ = Command::new("kill").arg(pid.to_string()).output();
    }
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if !process_alive(pid) {
            break;
        }
    }
    if !cfg!(windows) && process_alive(pid) {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
    let _ = fs::remove_file(pid_path());
    let current = dsh_status(Some(port)).await?;
    if current.get("running").and_then(Value::as_bool) == Some(true) {
        return Err("DeepSeek Harness 进程停止后服务仍可达，请检查是否存在其他实例".into());
    }
    Ok(current)
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn provider_key(channel: &Value) -> String {
    let source = ["id", "presetKey", "name"]
        .iter()
        .map(|key| str_field(channel, key))
        .find(|value| !value.is_empty())
        .unwrap_or("model")
        .to_ascii_lowercase();
    let mut suffix = String::new();
    let mut dash = false;
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() {
            if dash && !suffix.is_empty() {
                suffix.push('-');
            }
            dash = false;
            suffix.push(ch);
        } else {
            dash = true;
        }
        if suffix.len() >= 52 {
            break;
        }
    }
    let suffix = suffix.trim_matches('-');
    format!(
        "clawpanel-{}",
        if suffix.is_empty() { "model" } else { suffix }
    )
}

fn credential_ref(provider: &str) -> String {
    format!(
        "{}_API_KEY",
        provider.to_ascii_uppercase().replace('-', "_")
    )
}

fn protocol(api_type: &str) -> Option<&'static str> {
    match api_type {
        "openai-completions" | "ollama" => Some("openai-completions"),
        "openai-responses" => Some("openai-responses"),
        "anthropic-messages" => Some("anthropic-messages"),
        _ => None,
    }
}

fn normalize_api_type(api_type: &str) -> String {
    match api_type.trim() {
        "openai-codex-responses" => "openai-chatgpt-responses".into(),
        "openai-chat-completions" | "openai-compatible" => "openai-completions".into(),
        value => value.to_string(),
    }
}

fn positive_integer(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
            .filter(|number| *number > 0)
    })
}

fn provider_profile(channel: &Value, provider: &str) -> Result<Value, String> {
    let api_type = normalize_api_type(str_field(channel, "apiType"));
    let api = protocol(&api_type)
        .ok_or_else(|| format!("DeepSeek Harness 暂不支持该 API 类型: {api_type}"))?;
    let base_url = str_field(channel, "baseUrl").trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("DeepSeek Harness Base URL 必须以 http:// 或 https:// 开头".into());
    }
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in channel
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = raw.as_str().unwrap_or_else(|| str_field(raw, "id")).trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let mut model = Map::new();
        model.insert("id".into(), Value::String(id.into()));
        let name = str_field(raw, "name");
        if !name.is_empty() {
            model.insert("name".into(), Value::String(name.into()));
        }
        if let Some(context) = positive_integer(
            raw.get("contextWindow")
                .or_else(|| raw.get("contextTokens")),
        ) {
            model.insert("contextWindow".into(), Value::Number(context.into()));
        }
        if let Some(max_tokens) = positive_integer(raw.get("maxTokens")) {
            model.insert("maxTokens".into(), Value::Number(max_tokens.into()));
        }
        if let Some(input) = raw.get("input").and_then(Value::as_array) {
            let input: Vec<Value> = input
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| matches!(*value, "text" | "image"))
                .map(|value| Value::String(value.to_string()))
                .collect();
            if !input.is_empty() {
                model.insert("input".into(), Value::Array(input));
            }
        }
        models.push(Value::Object(model));
    }
    if models.is_empty() {
        return Err("DeepSeek Harness 至少需要一个模型".into());
    }
    Ok(json!({
        "displayName": if str_field(channel, "name").is_empty() { provider } else { str_field(channel, "name") },
        "apiKeyEnv": credential_ref(provider),
        "api": api,
        "baseURL": base_url,
        "models": models,
    }))
}

fn subset_matches(expected: &Value, actual: &Value) -> bool {
    match expected {
        Value::Array(items) => actual.as_array().is_some_and(|other| {
            items.len() == other.len() && items.iter().zip(other).all(|(a, b)| subset_matches(a, b))
        }),
        Value::Object(map) => actual.as_object().is_some_and(|other| {
            map.iter().all(|(key, value)| {
                other
                    .get(key)
                    .is_some_and(|item| subset_matches(value, item))
            })
        }),
        _ => expected == actual,
    }
}

#[tauri::command]
pub async fn dsh_sync_provider(
    channel_id: String,
    set_default: Option<bool>,
    port: Option<u16>,
) -> Result<Value, String> {
    let port = port.unwrap_or(DSH_DEFAULT_PORT);
    if port < 1024 {
        return Err("DeepSeek Harness 端口必须是 1024-65535 的整数".into());
    }
    let channel = super::model_channels::read_model_channel_private(&channel_id)?;
    if channel.get("apiKeyRef").is_some() {
        return Err("该渠道使用 OpenClaw SecretRef，只能原样同步到 OpenClaw".into());
    }
    let provider = provider_key(&channel);
    let profile = provider_profile(&channel, &provider)?;
    let credential = credential_ref(&provider);
    let key = super::config::resolve_model_api_key(str_field(&channel, "apiKey"))?;
    if key.trim().is_empty() {
        return Err("DeepSeek Harness API Key 不能为空".into());
    }
    let before = rpc("settings.describe", json!({}), port).await?;
    if before.get("writable").and_then(Value::as_bool) != Some(true) {
        return Err("DeepSeek Harness 设置当前为只读".into());
    }
    let llm_namespace = namespace(&before, DSH_SETTINGS_NAMESPACE)
        .ok_or_else(|| format!("DeepSeek Harness 缺少设置命名空间: {DSH_SETTINGS_NAMESPACE}"))?;
    let revision = llm_namespace
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| "DeepSeek Harness 设置缺少 revision".to_string())?;
    rpc(
        "settings.mutate",
        json!({
            "ns": DSH_SETTINGS_NAMESPACE,
            "ops": [{ "op": "set", "path": ["providers", provider], "value": profile }],
            "expectedRevision": revision,
        }),
        port,
    )
    .await?;
    rpc(
        "credentials.set",
        json!({ "ref": credential, "value": key }),
        port,
    )
    .await
    .map_err(|error| format!("DeepSeek Harness provider 已写入，但凭据写入失败: {error}"))?;

    let default_model = str_field(&channel, "defaultModel")
        .to_string()
        .or_else_empty(|| {
            profile
                .pointer("/models/0/id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        });
    if set_default.unwrap_or(false) && !default_model.is_empty() {
        let current = rpc("settings.describe", json!({}), port).await?;
        let defaults = namespace(&current, DSH_DEFAULT_MODEL_NAMESPACE).ok_or_else(|| {
            format!("DeepSeek Harness 缺少设置命名空间: {DSH_DEFAULT_MODEL_NAMESPACE}")
        })?;
        let revision = defaults
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(|| "DeepSeek Harness 默认模型设置缺少 revision".to_string())?;
        rpc(
            "settings.replace",
            json!({
                "ns": DSH_DEFAULT_MODEL_NAMESPACE,
                "section": { "provider": provider, "model": default_model },
                "expectedRevision": revision,
            }),
            port,
        )
        .await?;
    }

    let settings = rpc("settings.describe", json!({}), port).await?;
    let credentials = rpc(
        "credentials.describe",
        json!({ "refs": [credential] }),
        port,
    )
    .await?;
    let providers = rpc("llm.providers", json!({}), port).await?;
    let saved = namespace(&settings, DSH_SETTINGS_NAMESPACE)
        .and_then(|value| value.pointer(&format!("/value/providers/{provider}")))
        .ok_or_else(|| format!("DeepSeek Harness provider 写入后回读核对失败: {provider}"))?;
    if !subset_matches(&profile, saved) {
        return Err(format!(
            "DeepSeek Harness provider 写入后回读核对失败: {provider}"
        ));
    }
    if credentials
        .pointer(&format!("/credentials/{credential}/configured"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(format!(
            "DeepSeek Harness 凭据写入后回读核对失败: {credential}"
        ));
    }
    let active = providers
        .get("providers")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("provider").and_then(Value::as_str) == Some(provider.as_str())
                    && item.get("active").and_then(Value::as_bool) == Some(true)
            })
        });
    if !active {
        return Err(format!("DeepSeek Harness provider 尚未激活: {provider}"));
    }
    if set_default.unwrap_or(false) && !default_model.is_empty() {
        let defaults =
            namespace(&settings, DSH_DEFAULT_MODEL_NAMESPACE).and_then(|value| value.get("value"));
        if defaults
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            != Some(provider.as_str())
            || defaults
                .and_then(|value| value.get("model"))
                .and_then(Value::as_str)
                != Some(default_model.as_str())
        {
            return Err(format!(
                "DeepSeek Harness 默认模型写入后回读核对失败: {provider}/{default_model}"
            ));
        }
    }
    Ok(json!({
        "providerId": provider,
        "credentialRef": credential,
        "model": default_model,
        "modelCount": profile.get("models").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "verified": true,
    }))
}

trait OrElseEmpty {
    fn or_else_empty(self, fallback: impl FnOnce() -> String) -> String;
}

impl OrElseEmpty for String {
    fn or_else_empty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_profile_preserves_context_capacity() {
        let channel = json!({
            "id": "lm",
            "name": "LM Studio",
            "baseUrl": "http://127.0.0.1:1234/v1/",
            "apiType": "openai-completions",
            "models": [{ "id": "qwen", "contextTokens": 131072, "maxTokens": 8192 }],
        });
        let provider = provider_key(&channel);
        assert_eq!(provider, "clawpanel-lm");
        let profile = provider_profile(&channel, &provider).unwrap();
        assert_eq!(
            profile.pointer("/models/0/contextWindow"),
            Some(&json!(131072))
        );
        assert_eq!(profile.pointer("/models/0/maxTokens"), Some(&json!(8192)));
        assert_eq!(
            profile.get("apiKeyEnv"),
            Some(&json!("CLAWPANEL_LM_API_KEY"))
        );
    }

    #[test]
    fn provider_id_is_stable_and_channel_scoped() {
        let first = json!({ "id": "ch-one", "name": "同名渠道" });
        let renamed = json!({ "id": "ch-one", "name": "已重命名" });
        let second = json!({ "id": "ch-two", "name": "同名渠道" });
        assert_eq!(provider_key(&first), provider_key(&renamed));
        assert_ne!(provider_key(&first), provider_key(&second));
    }

    #[test]
    fn unsupported_protocol_is_rejected() {
        let channel = json!({
            "name": "Gemini",
            "baseUrl": "https://example.test",
            "apiType": "google-generative-ai",
            "models": [{ "id": "gemini" }],
        });
        assert!(provider_profile(&channel, "clawpanel-gemini")
            .unwrap_err()
            .contains("暂不支持"));
    }
}
