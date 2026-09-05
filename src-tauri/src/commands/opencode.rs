//! OpenCode 受管运行时与模型配置同步。
//!
//! 桌面端直接访问仅绑定 127.0.0.1 的 OpenCode；Web 端另由 Node 后端
//! 使用随机密码和短期能力令牌代理，不公开 OpenCode 端口。

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const OPENCODE_PACKAGE_NAME: &str = "opencode-ai";
const OPENCODE_PACKAGE_VERSION: &str = "1.18.21";
const OPENCODE_DEFAULT_PORT: u16 = 4096;
const OPENCODE_CONFIG_SCHEMA: &str = "https://opencode.ai/config.json";

static INSTALL_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn root_dir() -> PathBuf {
    super::openclaw_dir().join("clawpanel").join("opencode")
}

fn runtime_dir() -> PathBuf {
    root_dir().join("runtime")
}

fn home_dir() -> PathBuf {
    root_dir().join("home")
}

fn config_dir() -> PathBuf {
    home_dir().join("config")
}

fn config_path() -> PathBuf {
    config_dir().join("opencode.json")
}

fn credential_dir() -> PathBuf {
    home_dir().join("credentials")
}

fn workspace_dir() -> PathBuf {
    home_dir().join("workspace")
}

fn data_dir() -> PathBuf {
    home_dir().join("data")
}

fn cache_dir() -> PathBuf {
    home_dir().join("cache")
}

fn state_dir() -> PathBuf {
    home_dir().join("state")
}

fn pid_path() -> PathBuf {
    runtime_dir().join("server.pid.json")
}

fn log_path() -> PathBuf {
    runtime_dir().join("server.log")
}

fn package_json_path_at(runtime: &Path) -> PathBuf {
    runtime
        .join("node_modules")
        .join(OPENCODE_PACKAGE_NAME)
        .join("package.json")
}

fn platform_package_candidates() -> Vec<String> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    let suffixes: &[&str] = if cfg!(target_os = "linux") {
        &["", "-baseline", "-musl", "-baseline-musl"]
    } else {
        &["", "-baseline"]
    };
    suffixes
        .iter()
        .map(|suffix| format!("opencode-{platform}-{arch}{suffix}"))
        .collect()
}

fn managed_binary_candidates_at(runtime: &Path) -> Vec<PathBuf> {
    let executable = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    platform_package_candidates()
        .into_iter()
        .map(|package| {
            runtime
                .join("node_modules")
                .join(package)
                .join("bin")
                .join(executable)
        })
        .collect()
}

fn find_managed_binary_at(runtime: &Path) -> Option<PathBuf> {
    managed_binary_candidates_at(runtime)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn find_managed_binary() -> Option<PathBuf> {
    find_managed_binary_at(&runtime_dir())
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

fn global_command() -> Option<PathBuf> {
    find_command(if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    })
    .or_else(|| find_command("opencode"))
}

fn managed_version_at(runtime: &Path) -> String {
    fs::read_to_string(package_json_path_at(runtime))
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

fn managed_version() -> String {
    managed_version_at(&runtime_dir())
}

fn set_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置私有文件权限失败: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value, backup: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    let content =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化 JSON 失败: {error}"))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("opencode.json"),
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("创建临时配置失败: {error}"))?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入临时配置失败: {error}"))?;
    drop(file);
    set_private_permissions(&temp)?;
    if backup && path.is_file() {
        let backup_path = path.with_extension("json.bak");
        fs::copy(path, &backup_path).map_err(|error| format!("备份 OpenCode 配置失败: {error}"))?;
        set_private_permissions(&backup_path)?;
    }
    if let Err(first_error) = fs::rename(&temp, path) {
        if path.exists() {
            let swap = parent.join(format!(
                ".{}.{}.rollback",
                path.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("opencode.json"),
                std::process::id()
            ));
            let _ = fs::remove_file(&swap);
            fs::rename(path, &swap)
                .map_err(|error| format!("准备替换 OpenCode 配置失败: {first_error}; {error}"))?;
            if let Err(error) = fs::rename(&temp, path) {
                let _ = fs::rename(&swap, path);
                return Err(format!("替换 OpenCode 配置失败，已回滚: {error}"));
            }
            let _ = fs::remove_file(&swap);
        } else {
            return Err(format!("写入 OpenCode 配置失败: {first_error}"));
        }
    }
    set_private_permissions(path)
}

fn ensure_home() -> Result<(), String> {
    for dir in [
        config_dir(),
        credential_dir(),
        workspace_dir(),
        data_dir(),
        cache_dir(),
        state_dir(),
    ] {
        fs::create_dir_all(&dir).map_err(|error| format!("创建 OpenCode 目录失败: {error}"))?;
    }
    if !config_path().is_file() {
        write_json_atomic(
            &config_path(),
            &json!({ "$schema": OPENCODE_CONFIG_SCHEMA, "autoupdate": false }),
            false,
        )?;
    }
    Ok(())
}

fn read_config() -> Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn read_pid_record() -> Option<Value> {
    let value: Value = serde_json::from_str(&fs::read_to_string(pid_path()).ok()?).ok()?;
    value.get("pid")?.as_u64().filter(|pid| *pid > 0)?;
    value.get("port")?.as_u64().filter(|port| *port > 0)?;
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
    if let Ok(mut file) = File::open(format!("/proc/{pid}/cmdline")) {
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
    let expected = record
        .get("entry")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase()
        .replace('\\', "/");
    let port = record.get("port")?.as_u64()?.to_string();
    if !expected.is_empty()
        && command.contains(&expected)
        && command.contains("serve")
        && command.contains(&port)
    {
        Some(pid)
    } else {
        None
    }
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

async fn health(port: u16, password: &str) -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        .build()
        .ok()?;
    let mut request = client.get(format!("http://127.0.0.1:{port}/global/health"));
    if !password.is_empty() {
        request = request.basic_auth("opencode", Some(password));
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    (body.get("healthy").and_then(Value::as_bool) == Some(true)).then_some(body)
}

fn config_summary(config: &Value) -> Value {
    let providers = config
        .get("provider")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let configured: Vec<Value> = providers.keys().cloned().map(Value::String).collect();
    let managed: Vec<Value> = providers
        .keys()
        .filter(|id| id.starts_with("clawpanel-"))
        .cloned()
        .map(Value::String)
        .collect();
    let model_count: usize = providers
        .values()
        .map(|provider| {
            provider
                .get("models")
                .and_then(Value::as_object)
                .map(Map::len)
                .unwrap_or(0)
        })
        .sum();
    json!({
        "configuredProviders": configured,
        "managedProviders": managed,
        "defaultModel": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "modelCount": model_count,
    })
}

fn verified_managed_dir(name: &str) -> Result<PathBuf, String> {
    if !matches!(
        name,
        "runtime" | "runtime.update-staging" | "runtime.update-backup"
    ) {
        return Err("OpenCode 受管目录名称无效".into());
    }
    let root = root_dir();
    let target = root.join(name);
    if target.parent() != Some(root.as_path())
        || target.file_name().and_then(|value| value.to_str()) != Some(name)
    {
        return Err("OpenCode 受管目录校验失败，未执行文件操作".into());
    }
    Ok(target)
}

fn recover_runtime_swap() -> Result<(), String> {
    let runtime = verified_managed_dir("runtime")?;
    let staging = verified_managed_dir("runtime.update-staging")?;
    let backup = verified_managed_dir("runtime.update-backup")?;
    fs::create_dir_all(root_dir()).map_err(|error| format!("创建 OpenCode 根目录失败: {error}"))?;
    if !runtime.exists() && backup.exists() {
        fs::rename(&backup, &runtime)
            .map_err(|error| format!("恢复 OpenCode 运行时备份失败: {error}"))?;
    }
    if runtime.exists() && backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("清理 OpenCode 旧运行时失败: {error}"))?;
    }
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("清理 OpenCode 更新暂存目录失败: {error}"))?;
    }
    Ok(())
}

fn normalize_version(value: &str) -> Option<String> {
    let version = value.trim();
    if version.is_empty() || version.len() > 120 {
        return None;
    }
    let core = version.split(['-', '+']).next()?;
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || part.parse::<u64>().is_err())
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+'))
    {
        return None;
    }
    Some(version.to_string())
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    fn parts(value: &str) -> Option<([u64; 3], bool)> {
        let normalized = normalize_version(value)?;
        let core = normalized.split(['-', '+']).next()?;
        let values: Vec<u64> = core
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        Some(([values[0], values[1], values[2]], !normalized.contains('-')))
    }
    let Some((latest_core, latest_stable)) = parts(latest) else {
        return false;
    };
    let Some((current_core, current_stable)) = parts(current) else {
        return false;
    };
    latest_core > current_core || (latest_core == current_core && latest_stable && !current_stable)
}

fn configured_npm_registry() -> String {
    fs::read_to_string(super::openclaw_dir().join("npm-registry.txt"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://registry.npmmirror.com".to_string())
}

fn normalize_registry(value: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    let next_path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&next_path);
    if !url.as_str().chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '~' | ':' | '/' | '%' | '+' | '-')
    }) {
        return None;
    }
    Some(url)
}

async fn latest_version() -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建 OpenCode 更新客户端失败: {error}"))?;
    let mut registries = vec![
        configured_npm_registry(),
        "https://registry.npmjs.org/".into(),
    ];
    registries.dedup();
    let mut errors = Vec::new();
    for raw in registries {
        let Some(registry) = normalize_registry(&raw) else {
            errors.push(format!("{raw}: 地址无效"));
            continue;
        };
        let endpoint = match registry.join(&format!("{OPENCODE_PACKAGE_NAME}/latest")) {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{registry}: {error}"));
                continue;
            }
        };
        match client
            .get(endpoint)
            .header("accept", "application/json")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(payload) => {
                        let version = payload
                            .get("version")
                            .and_then(Value::as_str)
                            .and_then(normalize_version);
                        if let Some(version) = version {
                            return Ok((version, registry.to_string()));
                        }
                        errors.push(format!("{registry}: 仓库返回的版本号无效"));
                    }
                    Err(error) => errors.push(format!("{registry}: {error}")),
                }
            }
            Ok(response) => errors.push(format!("{registry}: HTTP {}", response.status())),
            Err(error) => errors.push(format!("{registry}: {error}")),
        }
    }
    Err(format!("检查 OpenCode 更新失败: {}", errors.join("; ")))
}

fn normalize_port(port: Option<u16>) -> Result<u16, String> {
    let port = port.unwrap_or(OPENCODE_DEFAULT_PORT);
    if port < 1024 {
        return Err("OpenCode 端口必须是 1024-65535 的整数".into());
    }
    Ok(port)
}

#[tauri::command]
pub async fn opencode_status(port: Option<u16>) -> Result<Value, String> {
    let port = normalize_port(port)?;
    if let Ok(_guard) = INSTALL_MUTEX.try_lock() {
        recover_runtime_swap()?;
    }
    let managed_binary = find_managed_binary();
    let managed_installed = managed_binary.is_some();
    let global = if managed_installed {
        None
    } else {
        global_command()
    };
    let pid = managed_pid();
    let record = read_pid_record();
    let record_port = record
        .as_ref()
        .and_then(|value| value.get("port").and_then(Value::as_u64))
        .and_then(|value| u16::try_from(value).ok());
    let password = record
        .as_ref()
        .and_then(|value| value.get("password").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let is_port_open = port_open(port).await;
    let service_health = if is_port_open {
        health(
            port,
            if pid.is_some() && record_port == Some(port) {
                &password
            } else {
                ""
            },
        )
        .await
    } else {
        None
    };
    let running = service_health.is_some();
    let config = read_config();
    Ok(json!({
        "installed": managed_installed || global.is_some(),
        "managedInstalled": managed_installed,
        "installRunning": INSTALL_MUTEX.try_lock().is_err(),
        "running": running,
        "managed": running && pid.is_some() && record_port == Some(port),
        "requiresManagedAuth": running && pid.is_some() && record_port == Some(port) && !password.is_empty(),
        "portOpen": is_port_open,
        "foreignPort": is_port_open && !running,
        "port": port,
        "url": format!("http://127.0.0.1:{port}"),
        "version": service_health.as_ref().and_then(|value| value.get("version")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| if managed_installed { managed_version() } else { String::new() }),
        "targetVersion": OPENCODE_PACKAGE_VERSION,
        "packageName": OPENCODE_PACKAGE_NAME,
        "path": managed_binary.or(global).map(|value| value.to_string_lossy().to_string()).unwrap_or_default(),
        "runtimeDir": runtime_dir().to_string_lossy(),
        "configPath": config_path().to_string_lossy(),
        "workspacePath": workspace_dir().to_string_lossy(),
        "logPath": log_path().to_string_lossy(),
        "pid": if running { pid } else { None },
        "summary": config_summary(&config),
    }))
}

async fn run_install_at(
    runtime: &Path,
    target_version: &str,
    registry: Option<&str>,
) -> Result<(), String> {
    let version = normalize_version(target_version)
        .ok_or_else(|| format!("OpenCode 目标版本无效: {target_version}"))?;
    let mut command = if cfg!(windows) {
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "npm"]);
        command
    } else {
        tokio::process::Command::new("npm")
    };
    command
        .arg("install")
        .arg("--prefix")
        .arg(runtime)
        .args([
            "--save-exact",
            "--omit=dev",
            "--ignore-scripts",
            "--audit=false",
            "--fund=false",
            &format!("{OPENCODE_PACKAGE_NAME}@{version}"),
        ])
        .env("PATH", super::enhanced_path());
    if let Some(registry) = registry.and_then(normalize_registry) {
        command.arg("--registry").arg(registry.as_str());
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(20 * 60), command.output())
        .await
        .map_err(|_| "OpenCode npm 安装超时".to_string())?
        .map_err(|error| format!("启动 npm 失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail: String = detail
        .chars()
        .rev()
        .take(8000)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Err(if detail.trim().is_empty() {
        format!("OpenCode npm 安装失败: {}", output.status)
    } else {
        detail
    })
}

async fn prepare_staging(target_version: &str, registry: Option<&str>) -> Result<(), String> {
    let staging = verified_managed_dir("runtime.update-staging")?;
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("清理 OpenCode 更新暂存目录失败: {error}"))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|error| format!("创建 OpenCode 更新暂存目录失败: {error}"))?;
    run_install_at(&staging, target_version, registry).await?;
    let binary = find_managed_binary_at(&staging)
        .ok_or_else(|| "npm 安装完成，但未找到适用于当前平台的 OpenCode 二进制".to_string())?;
    let probe = Command::new(&binary)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("验证 OpenCode 新版本二进制失败: {error}"))?;
    if !probe.success() {
        return Err("OpenCode 新版本二进制验证失败".into());
    }
    let installed = managed_version_at(&staging);
    if installed != target_version {
        return Err(format!(
            "OpenCode 安装版本回读不一致: {installed}，期望 {target_version}"
        ));
    }
    Ok(())
}

fn activate_staging() -> Result<(), String> {
    let runtime = verified_managed_dir("runtime")?;
    let staging = verified_managed_dir("runtime.update-staging")?;
    let backup = verified_managed_dir("runtime.update-backup")?;
    if find_managed_binary_at(&staging).is_none() {
        return Err("OpenCode 暂存运行时校验失败".into());
    }
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("清理 OpenCode 旧运行时失败: {error}"))?;
    }
    let moved_old = if runtime.exists() {
        fs::rename(&runtime, &backup)
            .map_err(|error| format!("备份 OpenCode 原运行时失败: {error}"))?;
        true
    } else {
        false
    };
    if let Err(error) = fs::rename(&staging, &runtime) {
        if moved_old && !runtime.exists() && backup.exists() {
            let _ = fs::rename(&backup, &runtime);
        }
        return Err(format!("切换 OpenCode 新版本失败，已回滚原运行时: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

#[tauri::command]
pub async fn opencode_install() -> Result<Value, String> {
    let _guard = INSTALL_MUTEX
        .try_lock()
        .map_err(|_| "OpenCode 安装任务正在运行".to_string())?;
    recover_runtime_swap()?;
    ensure_home()?;
    let registry = configured_npm_registry();
    prepare_staging(OPENCODE_PACKAGE_VERSION, Some(&registry)).await?;
    activate_staging()?;
    opencode_status(Some(OPENCODE_DEFAULT_PORT)).await
}

fn verified_runtime_dir() -> Result<PathBuf, String> {
    verified_managed_dir("runtime")
}

#[tauri::command]
pub async fn opencode_check_update() -> Result<Value, String> {
    let (latest, registry) = latest_version().await?;
    let current = managed_version();
    Ok(json!({
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": version_is_newer(&latest, &current),
        "registry": registry,
    }))
}

#[tauri::command]
pub async fn opencode_update() -> Result<Value, String> {
    let _guard = INSTALL_MUTEX
        .try_lock()
        .map_err(|_| "OpenCode 安装、更新或卸载任务正在运行".to_string())?;
    recover_runtime_swap()?;
    let before = opencode_status(Some(OPENCODE_DEFAULT_PORT)).await?;
    if before.get("managedInstalled").and_then(Value::as_bool) != Some(true) {
        return Err("在线更新仅适用于 ClawPanel 管理的 OpenCode 运行时".into());
    }
    let running = before.get("running").and_then(Value::as_bool) == Some(true);
    let managed = before.get("managed").and_then(Value::as_bool) == Some(true);
    if running && !managed {
        return Err("当前 OpenCode 不是由 ClawPanel 启动，未执行更新".into());
    }
    let port = before
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(OPENCODE_DEFAULT_PORT);
    let current = managed_version();
    let (latest, registry) = latest_version().await?;
    if !version_is_newer(&latest, &current) {
        let mut result = before;
        if let Some(value) = result.as_object_mut() {
            value.insert("currentVersion".into(), Value::String(current));
            value.insert("latestVersion".into(), Value::String(latest));
            value.insert("updateAvailable".into(), Value::Bool(false));
            value.insert("updated".into(), Value::Bool(false));
            value.insert("registry".into(), Value::String(registry));
        }
        return Ok(result);
    }

    if running {
        opencode_stop(Some(port)).await?;
    }
    let update_result = async {
        prepare_staging(&latest, Some(&registry)).await?;
        activate_staging()?;
        Ok::<(), String>(())
    }
    .await;
    let restart_result = if running {
        opencode_start(Some(port)).await.map(|_| ())
    } else {
        Ok(())
    };
    if let Err(error) = update_result {
        return Err(match restart_result {
            Ok(()) => error,
            Err(restart_error) => format!("{error}；恢复服务失败: {restart_error}"),
        });
    }
    restart_result.map_err(|error| format!("OpenCode 已更新，但重新启动失败: {error}"))?;
    let mut status = opencode_status(Some(port)).await?;
    let installed = managed_version();
    if installed != latest {
        return Err(format!(
            "OpenCode 更新后版本核对失败: {installed}，期望 {latest}"
        ));
    }
    if let Some(value) = status.as_object_mut() {
        value.insert("currentVersion".into(), Value::String(installed));
        value.insert("latestVersion".into(), Value::String(latest));
        value.insert("updateAvailable".into(), Value::Bool(false));
        value.insert("updated".into(), Value::Bool(true));
        value.insert("restarted".into(), Value::Bool(running));
        value.insert("registry".into(), Value::String(registry));
    }
    Ok(status)
}

#[tauri::command]
pub async fn opencode_uninstall() -> Result<Value, String> {
    let _guard = INSTALL_MUTEX
        .try_lock()
        .map_err(|_| "OpenCode 安装或卸载任务正在运行".to_string())?;
    recover_runtime_swap()?;
    let before = opencode_status(Some(OPENCODE_DEFAULT_PORT)).await?;
    let running = before.get("running").and_then(Value::as_bool) == Some(true);
    let managed = before.get("managed").and_then(Value::as_bool) == Some(true);
    if running && !managed {
        return Err("当前 OpenCode 不是由 ClawPanel 启动，未执行卸载".into());
    }
    if running {
        let port = before
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(OPENCODE_DEFAULT_PORT);
        opencode_stop(Some(port)).await?;
    }
    let runtime = verified_runtime_dir()?;
    if runtime.exists() {
        fs::remove_dir_all(&runtime)
            .map_err(|error| format!("卸载 OpenCode 运行目录失败: {error}"))?;
    }
    if runtime.exists() {
        return Err("OpenCode 运行目录卸载后仍然存在".into());
    }
    let mut status = opencode_status(Some(OPENCODE_DEFAULT_PORT)).await?;
    if let Some(value) = status.as_object_mut() {
        value.insert("removedManaged".into(), Value::Bool(true));
    }
    Ok(status)
}

fn append_log_file() -> Result<File, String> {
    fs::create_dir_all(runtime_dir())
        .map_err(|error| format!("创建 OpenCode 运行目录失败: {error}"))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|error| format!("打开 OpenCode 日志失败: {error}"))
}

fn write_pid_record(pid: u32, port: u16, entry: &Path) -> Result<(), String> {
    write_json_atomic(
        &pid_path(),
        &json!({
            "pid": pid,
            "port": port,
            "startedAt": chrono::Utc::now().to_rfc3339(),
            "entry": entry.to_string_lossy(),
        }),
        false,
    )
}

fn spawn_server(port: u16) -> Result<u32, String> {
    ensure_home()?;
    let entry = find_managed_binary()
        .or_else(global_command)
        .ok_or_else(|| "OpenCode 未安装".to_string())?;
    let log = append_log_file()?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("复制 OpenCode 日志句柄失败: {error}"))?;
    let mut command = Command::new(&entry);
    command
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .current_dir(workspace_dir())
        .env("PATH", super::enhanced_path())
        .env("OPENCODE_CONFIG", config_path())
        .env("OPENCODE_CONFIG_DIR", config_dir())
        .env("OPENCODE_DISABLE_DEFAULT_PLUGINS", "true")
        .env("OPENCODE_DISABLE_CLAUDE_CODE", "true")
        .env("XDG_DATA_HOME", data_dir())
        .env("XDG_CACHE_HOME", cache_dir())
        .env("XDG_STATE_HOME", state_dir())
        .env("CLAWPANEL_OPENCODE_MANAGED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("启动 OpenCode 失败: {error}"))?;
    let pid = child.id();
    write_pid_record(pid, port, &entry)?;
    Ok(pid)
}

#[tauri::command]
pub async fn opencode_start(port: Option<u16>) -> Result<Value, String> {
    let port = normalize_port(port)?;
    let before = opencode_status(Some(port)).await?;
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
            "ClawPanel 管理的 OpenCode 已在端口 {managed_port} 启动，请先停止后再切换端口"
        ));
    }
    if before.get("installed").and_then(Value::as_bool) != Some(true) {
        return Err("OpenCode 未安装，请先安装受管运行时".into());
    }
    spawn_server(port)?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let current = opencode_status(Some(port)).await?;
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
        "OpenCode 启动失败".into()
    } else {
        format!("OpenCode 启动失败: {tail}")
    })
}

#[tauri::command]
pub async fn opencode_stop(port: Option<u16>) -> Result<Value, String> {
    let port = normalize_port(port)?;
    let Some(pid) = managed_pid() else {
        let current = opencode_status(Some(port)).await?;
        if current.get("running").and_then(Value::as_bool) == Some(true) {
            return Err("当前 OpenCode 不是由 ClawPanel 启动，未执行停止操作".into());
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
    let current = opencode_status(Some(port)).await?;
    if current.get("running").and_then(Value::as_bool) == Some(true) {
        return Err("OpenCode 进程停止后服务仍可达，请检查是否存在其他实例".into());
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
    format!(
        "clawpanel-{}",
        suffix.trim_matches('-').to_string().if_empty("model")
    )
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn provider_package(api_type: &str) -> Option<&'static str> {
    match api_type.trim() {
        "openai-completions" | "ollama" => Some("@ai-sdk/openai-compatible"),
        "openai-responses" => Some("@ai-sdk/openai"),
        "anthropic-messages" => Some("@ai-sdk/anthropic"),
        _ => None,
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

fn provider_config(
    channel: &Value,
    credential_path: &Path,
    provider: &str,
) -> Result<Value, String> {
    let api_type = str_field(channel, "apiType");
    let package = provider_package(api_type).ok_or_else(|| {
        format!(
            "OpenCode 暂不支持该 API 类型: {}",
            if api_type.is_empty() { "-" } else { api_type }
        )
    })?;
    let base_url = str_field(channel, "baseUrl").trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("OpenCode Base URL 必须以 http:// 或 https:// 开头".into());
    }
    let mut models = Map::new();
    let mut seen = HashSet::new();
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
        let name = str_field(raw, "name");
        if !name.is_empty() {
            model.insert("name".into(), Value::String(name.into()));
        }
        let context = positive_integer(
            raw.get("contextWindow")
                .or_else(|| raw.get("contextTokens")),
        );
        let output = positive_integer(raw.get("maxTokens"));
        if context.is_some() || output.is_some() {
            let mut limit = Map::new();
            if let Some(context) = context {
                limit.insert("context".into(), Value::Number(context.into()));
            }
            if let Some(output) = output {
                limit.insert("output".into(), Value::Number(output.into()));
            }
            model.insert("limit".into(), Value::Object(limit));
        }
        models.insert(id.into(), Value::Object(model));
    }
    if models.is_empty() {
        return Err("OpenCode 至少需要一个模型".into());
    }
    let credential = credential_path.to_string_lossy().replace('\\', "/");
    Ok(json!({
        "npm": package,
        "name": if str_field(channel, "name").is_empty() { provider } else { str_field(channel, "name") },
        "options": { "baseURL": base_url, "apiKey": format!("{{file:{credential}}}") },
        "models": models,
    }))
}

fn write_credential(provider: &str, api_key: &str) -> Result<PathBuf, String> {
    ensure_home()?;
    if !provider.starts_with("clawpanel-")
        || !provider
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(format!("OpenCode Provider ID 无效: {provider}"));
    }
    let path = credential_dir().join(format!("{provider}.key"));
    fs::write(&path, format!("{}\n", api_key.trim()))
        .map_err(|error| format!("写入 OpenCode 凭据失败: {error}"))?;
    set_private_permissions(&path)?;
    Ok(path)
}

#[tauri::command]
pub async fn opencode_sync_provider(
    channel_id: String,
    set_default: Option<bool>,
) -> Result<Value, String> {
    let channel = super::model_channels::read_model_channel_private(&channel_id)?;
    if channel.get("apiKeyRef").is_some() {
        return Err("该渠道使用 OpenClaw SecretRef，只能原样同步到 OpenClaw".into());
    }
    let api_key = super::config::resolve_model_api_key(str_field(&channel, "apiKey"))?;
    if api_key.trim().is_empty() {
        return Err("OpenCode API Key 不能为空".into());
    }
    let provider = provider_key(&channel);
    let credential = write_credential(&provider, &api_key)?;
    let profile = provider_config(&channel, &credential, &provider)?;
    let first_model = profile
        .get("models")
        .and_then(Value::as_object)
        .and_then(|models| models.keys().next())
        .cloned()
        .unwrap_or_default();
    let requested = str_field(&channel, "defaultModel");
    let default_model = profile
        .get("models")
        .and_then(Value::as_object)
        .filter(|models| models.contains_key(requested))
        .map(|_| requested.to_string())
        .unwrap_or(first_model);
    let model_count = profile
        .get("models")
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0);

    let mut current = read_config();
    let root = current
        .as_object_mut()
        .ok_or_else(|| "OpenCode 配置必须是 JSON 对象".to_string())?;
    root.entry("$schema")
        .or_insert_with(|| Value::String(OPENCODE_CONFIG_SCHEMA.into()));
    root.insert("autoupdate".into(), Value::Bool(false));
    if !root.get("provider").is_some_and(Value::is_object) {
        root.insert("provider".into(), Value::Object(Map::new()));
    }
    root.get_mut("provider")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "OpenCode provider 配置无效".to_string())?
        .insert(provider.clone(), profile.clone());
    if set_default.unwrap_or(false) && !default_model.is_empty() {
        root.insert(
            "model".into(),
            Value::String(format!("{provider}/{default_model}")),
        );
    }
    write_json_atomic(&config_path(), &current, true)?;
    let saved = read_config();
    if saved.pointer(&format!("/provider/{provider}")).cloned() != Some(profile) {
        return Err(format!("OpenCode Provider 写入后回读核对失败: {provider}"));
    }
    let expected_default = format!("{provider}/{default_model}");
    if set_default.unwrap_or(false)
        && saved.get("model").and_then(Value::as_str) != Some(expected_default.as_str())
    {
        return Err(format!(
            "OpenCode 默认模型写入后回读核对失败: {provider}/{default_model}"
        ));
    }
    Ok(json!({
        "providerId": provider,
        "model": default_model,
        "modelCount": model_count,
        "verified": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_versions_are_strict_and_comparable() {
        assert_eq!(normalize_version("1.18.21").as_deref(), Some("1.18.21"));
        assert_eq!(
            normalize_version("1.19.0-beta.2").as_deref(),
            Some("1.19.0-beta.2")
        );
        assert!(normalize_version("latest").is_none());
        assert!(normalize_version("1.2.3 && bad").is_none());
        assert!(version_is_newer("1.19.0", "1.18.21"));
        assert!(version_is_newer("1.19.0", "1.19.0-beta.2"));
        assert!(!version_is_newer("1.18.21", "1.18.21"));
    }

    #[test]
    fn managed_runtime_paths_reject_unexpected_targets() {
        assert_eq!(
            verified_managed_dir("runtime")
                .unwrap()
                .file_name()
                .and_then(|value| value.to_str()),
            Some("runtime")
        );
        assert!(verified_managed_dir("../home").is_err());
        assert!(verified_managed_dir("home").is_err());
    }

    #[test]
    fn update_registry_rejects_credentials_and_non_http_schemes() {
        assert!(normalize_registry("https://registry.npmjs.org/").is_some());
        assert!(normalize_registry("https://user:secret@example.com/").is_none());
        assert!(normalize_registry("file:///tmp/npm").is_none());
    }
}
