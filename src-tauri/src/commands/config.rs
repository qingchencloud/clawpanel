/// 配置读写命令
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use crate::utils::openclaw_command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::models::types::VersionInfo;

/// 预设 npm 源列表
const DEFAULT_REGISTRY: &str = "https://registry.npmmirror.com";

/// 读取用户配置的 npm registry，fallback 到淘宝镜像
fn get_configured_registry() -> String {
    let path = super::openclaw_dir().join("npm-registry.txt");
    fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_string())
}

/// 创建使用配置源的 npm Command
/// Windows 上 npm 是 npm.cmd，需要通过 cmd /c 调用，并隐藏窗口
fn npm_command() -> Command {
    let registry = get_configured_registry();
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npm", "--registry", &registry]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("npm");
        cmd.args(["--registry", &registry]);
        cmd
    }
}

fn backups_dir() -> PathBuf {
    super::openclaw_dir().join("backups")
}

#[tauri::command]
pub fn read_openclaw_config() -> Result<Value, String> {
    let path = super::openclaw_dir().join("openclaw.json");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_openclaw_config(config: Value) -> Result<(), String> {
    let path = super::openclaw_dir().join("openclaw.json");
    // 备份
    let bak = super::openclaw_dir().join("openclaw.json.bak");
    let _ = fs::copy(&path, &bak);
    // 清理 UI 专属字段，避免 CLI schema 校验失败
    let cleaned = strip_ui_fields(config);
    // 写入
    let json = serde_json::to_string_pretty(&cleaned)
        .map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json)
        .map_err(|e| format!("写入失败: {e}"))
}

/// 递归清理 models 数组中的 UI 专属字段（lastTestAt, latency, testStatus, testError）
/// 并为缺少 name 字段的模型自动补上 name = id
fn strip_ui_fields(mut val: Value) -> Value {
    if let Some(obj) = val.as_object_mut() {
        // 递归处理 providers -> xxx -> models 数组
        if let Some(models) = obj.get("models") {
            if let Some(providers) = models.as_object() {
                let mut new_models = providers.clone();
                for (_key, provider) in new_models.iter_mut() {
                    if let Some(pobj) = provider.as_object_mut() {
                        if let Some(Value::Array(arr)) = pobj.get_mut("models") {
                            for model in arr.iter_mut() {
                                if let Some(mobj) = model.as_object_mut() {
                                    mobj.remove("lastTestAt");
                                    mobj.remove("latency");
                                    mobj.remove("testStatus");
                                    mobj.remove("testError");
                                    // 补上 name 字段（CLI 要求）
                                    if !mobj.contains_key("name") {
                                        if let Some(id) = mobj.get("id").and_then(|v| v.as_str()) {
                                            mobj.insert("name".into(), Value::String(id.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                obj.insert("models".into(), Value::Object(new_models));
            }
        }
    }
    val
}

#[tauri::command]
pub fn read_mcp_config() -> Result<Value, String> {
    let path = super::openclaw_dir().join("mcp.json");
    if !path.exists() {
        return Ok(Value::Object(Default::default()));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取 MCP 配置失败: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_mcp_config(config: Value) -> Result<(), String> {
    let path = super::openclaw_dir().join("mcp.json");
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json)
        .map_err(|e| format!("写入失败: {e}"))
}

/// 获取本地安装的 openclaw 版本号
/// macOS: 优先从 npm 包的 package.json 读取（含完整后缀），fallback 到 CLI
/// Windows/Linux: 直接用 CLI
fn get_local_version() -> Option<String> {
    // macOS: 通过 symlink 找到包目录，读 package.json 的 version
    #[cfg(target_os = "macos")]
    {
        if let Ok(target) = fs::read_link("/opt/homebrew/bin/openclaw") {
            let pkg_json = PathBuf::from("/opt/homebrew/bin")
                .join(&target)
                .parent()?
                .join("package.json");
            if let Ok(content) = fs::read_to_string(&pkg_json) {
                if let Some(ver) = serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|v| v.get("version")?.as_str().map(String::from))
                {
                    return Some(ver);
                }
            }
        }
    }
    // Windows: 直接读 npm 全局目录下的 package.json，避免 spawn 进程
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            // 先查汉化版，再查官方版
            for pkg in &["@qingchencloud/openclaw-zh", "openclaw"] {
                let pkg_json = PathBuf::from(&appdata)
                    .join("npm").join("node_modules").join(pkg).join("package.json");
                if let Ok(content) = fs::read_to_string(&pkg_json) {
                    if let Some(ver) = serde_json::from_str::<Value>(&content)
                        .ok()
                        .and_then(|v| v.get("version")?.as_str().map(String::from))
                    {
                        return Some(ver);
                    }
                }
            }
        }
    }
    // 所有平台通用 fallback: CLI 输出
    let output = openclaw_command().arg("--version").output().ok()?;
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    raw.split_whitespace().last().filter(|s| !s.is_empty()).map(String::from)
}

/// 从 npm registry 获取最新版本号，超时 5 秒
async fn get_latest_version_for(source: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;
    let pkg = npm_package_name(source).replace('/', "%2F").replace('@', "%40");
    let registry = get_configured_registry();
    let url = format!("{registry}/{pkg}/latest");
    let resp = client.get(&url).send().await.ok()?;
    let json: Value = resp.json().await.ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// 检测当前安装的是官方版还是汉化版
/// macOS: 优先检查 homebrew symlink，fallback 到 npm list
/// Windows: 优先检查 npm 全局目录下的 package.json，避免调用 npm list 阻塞
/// Linux: 直接用 npm list
fn detect_installed_source() -> String {
    // macOS: 检查 openclaw bin 的 symlink 指向
    #[cfg(target_os = "macos")]
    {
        if let Ok(target) = std::fs::read_link("/opt/homebrew/bin/openclaw") {
            if target.to_string_lossy().contains("openclaw-zh") {
                return "chinese".into();
            }
            return "official".into();
        }
    }
    // Windows: 优先通过文件系统检测，避免 npm list 阻塞
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let zh_dir = PathBuf::from(&appdata)
                .join("npm")
                .join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh");
            if zh_dir.exists() {
                return "chinese".into();
            }
        }
        return "official".into();
    }
    // 所有平台通用: npm list 检测
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(o) = npm_command()
            .args(["list", "-g", "@qingchencloud/openclaw-zh", "--depth=0"])
            .output()
        {
            if String::from_utf8_lossy(&o.stdout).contains("openclaw-zh@") {
                return "chinese".into();
            }
        }
        "official".into()
    }
}

#[tauri::command]
pub async fn get_version_info() -> Result<VersionInfo, String> {
    let current = get_local_version();
    let source = detect_installed_source();
    let latest = get_latest_version_for(&source).await;
    let parse_ver = |v: &str| -> Vec<u32> {
        v.split(|c: char| !c.is_ascii_digit())
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let update_available = match (&current, &latest) {
        (Some(c), Some(l)) => parse_ver(l) > parse_ver(c),
        _ => false,
    };
    Ok(VersionInfo {
        current,
        latest,
        update_available,
        source,
    })
}

/// npm 包名映射
fn npm_package_name(source: &str) -> &'static str {
    match source {
        "official" => "openclaw",
        _ => "@qingchencloud/openclaw-zh",
    }
}

/// 执行 npm 全局升级 openclaw（流式推送日志）
#[tauri::command]
pub async fn upgrade_openclaw(app: tauri::AppHandle, source: String) -> Result<String, String> {
    use std::process::Stdio;
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let current_source = detect_installed_source();
    let pkg = format!("{}@latest", npm_package_name(&source));

    // 切换源时，或者未安装时（检测 source 和 target，或者目前未安装）
    // 如果系统里已经安装了别的源，先卸载
    let old_pkg = npm_package_name(&current_source);
    if current_source != source {
        // 先检查是否真的安装了旧包，如果没有安装，npm uninstall 会报错但不影响
        let _ = app.emit("upgrade-log", format!("清理遗留环境 ({old_pkg})..."));
        let _ = app.emit("upgrade-progress", 5);
        let _ = npm_command()
            .args(["uninstall", "-g", &old_pkg])
            .output();
    }

    let _ = app.emit("upgrade-log", format!("$ npm install -g {pkg}"));
    let _ = app.emit("upgrade-progress", 10);

    let mut child = npm_command()
        .args(["install", "-g", &pkg, "--verbose"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行升级命令失败: {e}"))?;

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    // stderr 每行递增进度（10→80 区间），让用户看到进度在动
    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        let mut progress: u32 = 15;
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("upgrade-log", &line);
                if progress < 75 {
                    progress += 2;
                    let _ = app2.emit("upgrade-progress", progress);
                }
            }
        }
    });

    if let Some(pipe) = stdout {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("upgrade-log", &line);
        }
    }

    let _ = handle.join();
    let _ = app.emit("upgrade-progress", 80);

    let status = child.wait().map_err(|e| format!("等待进程失败: {e}"))?;
    let _ = app.emit("upgrade-progress", 100);

    if !status.success() {
        let _ = app.emit("upgrade-log", "❌ 升级失败");
        return Err("升级失败，请查看日志".into());
    }

    // 切换源后重装 Gateway 服务
    if current_source != source {
        let _ = app.emit("upgrade-log", "正在重装 Gateway 服务（更新启动路径）...");
        // 先停掉旧的
        #[cfg(target_os = "macos")]
        {
            let uid = get_uid().unwrap_or(501);
            let _ = Command::new("launchctl")
                .args(["bootout", &format!("gui/{uid}/ai.openclaw.gateway")])
                .output();
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = openclaw_command()
                .args(["gateway", "stop"])
                .output();
        }
        // 重新安装
        let gw_out = openclaw_command()
            .args(["gateway", "install"])
            .output();
        match gw_out {
            Ok(o) if o.status.success() => {
                let _ = app.emit("upgrade-log", "Gateway 服务已重装");
            }
            _ => {
                let _ = app.emit("upgrade-log", "⚠️ Gateway 重装失败，请手动执行 openclaw gateway install");
            }
        }
    }

    let new_ver = get_local_version().unwrap_or_else(|| "未知".into());
    let msg = format!("✅ 升级成功，当前版本: {new_ver}");
    let _ = app.emit("upgrade-log", &msg);
    Ok(msg)
}

#[tauri::command]
pub fn check_installation() -> Result<Value, String> {
    let dir = super::openclaw_dir();
    let installed = dir.join("openclaw.json").exists();
    let mut result = serde_json::Map::new();
    result.insert("installed".into(), Value::Bool(installed));
    result.insert("path".into(), Value::String(dir.to_string_lossy().to_string()));
    Ok(Value::Object(result))
}

/// 检测 Node.js 是否已安装，返回版本号
#[tauri::command]
pub fn check_node() -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    let mut cmd = Command::new("node");
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            result.insert("installed".into(), Value::Bool(true));
            result.insert("version".into(), Value::String(ver));
        }
        _ => {
            result.insert("installed".into(), Value::Bool(false));
            result.insert("version".into(), Value::Null);
        }
    }
    Ok(Value::Object(result))
}

#[tauri::command]
pub fn write_env_file(path: String, config: String) -> Result<(), String> {
    let expanded = if path.starts_with("~/") {
        dirs::home_dir()
            .unwrap_or_default()
            .join(&path[2..])
    } else {
        PathBuf::from(&path)
    };

    // 安全限制：只允许写入 ~/.openclaw/ 目录下的文件
    let openclaw_base = super::openclaw_dir();
    if !expanded.starts_with(&openclaw_base) {
        return Err("只允许写入 ~/.openclaw/ 目录下的文件".to_string());
    }

    if let Some(parent) = expanded.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&expanded, &config)
        .map_err(|e| format!("写入 .env 失败: {e}"))
}

// ===== 备份管理 =====

#[tauri::command]
pub fn list_backups() -> Result<Value, String> {
    let dir = backups_dir();
    if !dir.exists() {
        return Ok(Value::Array(vec![]));
    }
    let mut backups: Vec<Value> = vec![];
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let meta = fs::metadata(&path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        // macOS 支持 created()，fallback 到 modified()
        let created = meta
            .and_then(|m| {
                m.created().ok().or_else(|| m.modified().ok())
            })
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut obj = serde_json::Map::new();
        obj.insert("name".into(), Value::String(name));
        obj.insert("size".into(), Value::Number(size.into()));
        obj.insert("created_at".into(), Value::Number(created.into()));
        backups.push(Value::Object(obj));
    }
    // 按时间倒序
    backups.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(Value::Array(backups))
}

#[tauri::command]
pub fn create_backup() -> Result<Value, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("创建备份目录失败: {e}"))?;

    let src = super::openclaw_dir().join("openclaw.json");
    if !src.exists() {
        return Err("openclaw.json 不存在".into());
    }

    let now = chrono::Local::now();
    let name = format!("openclaw-{}.json", now.format("%Y%m%d-%H%M%S"));
    let dest = dir.join(&name);
    fs::copy(&src, &dest)
        .map_err(|e| format!("备份失败: {e}"))?;

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let mut obj = serde_json::Map::new();
    obj.insert("name".into(), Value::String(name));
    obj.insert("size".into(), Value::Number(size.into()));
    Ok(Value::Object(obj))
}

/// 检查备份文件名是否安全
fn is_unsafe_backup_name(name: &str) -> bool {
    name.contains("..") || name.contains('/') || name.contains('\\')
}

#[tauri::command]
pub fn restore_backup(name: String) -> Result<(), String> {
    if is_unsafe_backup_name(&name) {
        return Err("非法文件名".into());
    }
    let backup_path = backups_dir().join(&name);
    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    let target = super::openclaw_dir().join("openclaw.json");

    // 恢复前先自动备份当前配置
    if target.exists() {
        let _ = create_backup();
    }

    fs::copy(&backup_path, &target)
        .map_err(|e| format!("恢复失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(name: String) -> Result<(), String> {
    if is_unsafe_backup_name(&name) {
        return Err("非法文件名".into());
    }
    let path = backups_dir().join(&name);
    if !path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    fs::remove_file(&path)
        .map_err(|e| format!("删除失败: {e}"))
}

/// 获取当前用户 UID（macOS/Linux 用 id -u，Windows 返回 0）
#[allow(dead_code)]
fn get_uid() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|e| format!("获取 UID 失败: {e}"))?;
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .map_err(|e| format!("解析 UID 失败: {e}"))
    }
}

/// 重载 Gateway 服务
/// macOS: launchctl kickstart -k
/// Windows/Linux: openclaw gateway restart
#[tauri::command]
pub fn reload_gateway() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid()?;
        let target = format!("gui/{uid}/ai.openclaw.gateway");
        let output = Command::new("launchctl")
            .args(["kickstart", "-k", &target])
            .output()
            .map_err(|e| format!("重载失败: {e}"))?;
        if output.status.success() {
            Ok("Gateway 已重载".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("重载失败: {stderr}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let cli_check = openclaw_command().arg("--version").output();
        match cli_check {
            Ok(o) if o.status.success() => {}
            _ => return Err("openclaw CLI 未安装，无法重载 Gateway".into()),
        }
        let output = openclaw_command()
            .args(["gateway", "restart"])
            .output()
            .map_err(|e| format!("重载失败: {e}"))?;
        if output.status.success() {
            Ok("Gateway 已重载".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("重载失败: {stderr}"))
        }
    }
}

/// 测试模型连通性：向 provider 发送一个简单的 chat completion 请求
#[tauri::command]
pub async fn test_model(
    base_url: String,
    api_key: String,
    model_id: String,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 16,
        "stream": false
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "请求超时 (30s)".to_string()
        } else if e.is_connect() {
            format!("连接失败: {e}")
        } else {
            format!("请求失败: {e}")
        }
    })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // 尝试提取错误信息
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }

    // 提取回复内容（兼容 reasoning 模型的 reasoning_content 字段）
    let reply = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            let msg = v.get("choices")?.get(0)?.get("message")?;
            // 优先取 content，为空则取 reasoning_content
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if !content.is_empty() {
                return Some(content.to_string());
            }
            msg.get("reasoning_content")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!("[reasoning] {s}"))
        })
        .unwrap_or_else(|| "（无回复内容）".into());

    Ok(reply)
}

/// 获取服务商的远程模型列表（调用 /models 接口）
#[tauri::command]
pub async fn list_remote_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "请求超时 (15s)，该服务商可能不支持模型列表接口".to_string()
        } else if e.is_connect() {
            format!("连接失败，请检查接口地址是否正确: {e}")
        } else {
            format!("请求失败: {e}")
        }
    })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("获取模型列表失败: {msg}"));
    }

    // 解析 OpenAI 格式的 /models 响应
    let ids = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            let data = v.get("data")?.as_array()?;
            let mut ids: Vec<String> = data
                .iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect();
            ids.sort();
            Some(ids)
        })
        .unwrap_or_default();

    if ids.is_empty() {
        return Err("该服务商返回了空的模型列表，可能不支持 /models 接口".to_string());
    }

    Ok(ids)
}

/// 安装 Gateway 服务（执行 openclaw gateway install）
#[tauri::command]
pub fn install_gateway() -> Result<String, String> {
    // 先检测 openclaw CLI 是否可用
    let cli_check = openclaw_command().arg("--version").output();
    match cli_check {
        Ok(o) if o.status.success() => {}
        _ => {
            return Err(
                "openclaw CLI 未安装。请先执行以下命令安装：\n\n\
                 npm install -g @qingchencloud/openclaw-zh\n\n\
                 安装完成后再点击此按钮安装 Gateway 服务。".into()
            );
        }
    }

    let output = openclaw_command()
        .args(["gateway", "install"])
        .output()
        .map_err(|e| format!("安装失败: {e}"))?;

    if output.status.success() {
        Ok("Gateway 服务已安装".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("安装失败: {stderr}"))
    }
}

/// 卸载 Gateway 服务
/// macOS: launchctl bootout + 删除 plist
/// Windows/Linux: openclaw gateway stop
#[tauri::command]
pub fn uninstall_gateway() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid()?;
        let target = format!("gui/{uid}/ai.openclaw.gateway");

        // 先停止服务
        let _ = Command::new("launchctl")
            .args(["bootout", &target])
            .output();

        // 删除 plist 文件
        let home = dirs::home_dir().unwrap_or_default();
        let plist = home.join("Library/LaunchAgents/ai.openclaw.gateway.plist");
        if plist.exists() {
            fs::remove_file(&plist)
                .map_err(|e| format!("删除 plist 失败: {e}"))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux: 停止 Gateway 服务
        let _ = openclaw_command()
            .args(["gateway", "stop"])
            .output();
    }

    Ok("Gateway 服务已卸载".to_string())
}

#[tauri::command]
pub fn get_npm_registry() -> Result<String, String> {
    Ok(get_configured_registry())
}

#[tauri::command]
pub fn set_npm_registry(registry: String) -> Result<(), String> {
    let path = super::openclaw_dir().join("npm-registry.txt");
    fs::write(&path, registry.trim())
        .map_err(|e| format!("保存失败: {e}"))
}
