use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RegType, KEY_READ};
#[cfg(target_os = "windows")]
use winreg::RegKey;

pub mod agent;
pub mod assistant;
pub mod cloudflared;
pub mod config;
pub mod device;
pub mod extensions;
pub mod logs;
pub mod memory;
pub mod messaging;
pub mod pairing;
pub mod service;
pub mod skills;
pub mod update;

/// 获取 OpenClaw 配置目录 (~/.openclaw/)
pub fn openclaw_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".openclaw"));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(profile).join(".openclaw"));
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            candidates.push(PathBuf::from(format!("{}{}", drive, path)).join(".openclaw"));
        }
        for dir in &candidates {
            if dir.join("openclaw.json").exists() || dir.join("clawpanel.json").exists() {
                return dir.to_path_buf();
            }
        }
        candidates
            .into_iter()
            .next()
            .unwrap_or_else(|| PathBuf::from(".openclaw"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().unwrap_or_default().join(".openclaw")
    }
}

/// 获取 OpenClaw 配置文件路径（仅使用 openclaw.json）
pub fn openclaw_config_path() -> PathBuf {
    openclaw_dir().join("openclaw.json")
}

fn panel_config_path() -> PathBuf {
    openclaw_dir().join("clawpanel.json")
}

fn read_panel_config_value() -> Option<serde_json::Value> {
    std::fs::read_to_string(panel_config_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

pub fn configured_proxy_url() -> Option<String> {
    let value = read_panel_config_value()?;
    let raw = value
        .get("networkProxy")
        .and_then(|entry| {
            if let Some(obj) = entry.as_object() {
                obj.get("url").and_then(|v| v.as_str())
            } else {
                entry.as_str()
            }
        })?
        .trim()
        .to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn should_bypass_proxy_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    if lower.is_empty() || lower == "localhost" || lower.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local()
            }
        };
    }
    false
}

/// 构建 HTTP 客户端，use_proxy=true 时走用户配置的代理
pub fn build_http_client(
    timeout: Duration,
    user_agent: Option<&str>,
) -> Result<reqwest::Client, String> {
    build_http_client_opt(timeout, user_agent, true)
}

/// 构建模型请求用的 HTTP 客户端
/// 默认不走代理；用户在面板设置中开启 proxyModelRequests 后才走代理
pub fn build_http_client_no_proxy(
    timeout: Duration,
    user_agent: Option<&str>,
) -> Result<reqwest::Client, String> {
    let use_proxy = read_panel_config_value()
        .and_then(|v| v.get("networkProxy")?.get("proxyModelRequests")?.as_bool())
        .unwrap_or(false);
    build_http_client_opt(timeout, user_agent, use_proxy)
}

fn build_http_client_opt(
    timeout: Duration,
    user_agent: Option<&str>,
    use_proxy: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if let Some(ua) = user_agent {
        builder = builder.user_agent(ua);
    }
    if use_proxy {
        if let Some(proxy_url) = configured_proxy_url() {
            let proxy_value = proxy_url.clone();
            builder = builder.proxy(reqwest::Proxy::custom(move |url| {
                let host = url.host_str().unwrap_or("");
                if should_bypass_proxy_host(host) {
                    None
                } else {
                    Some(proxy_value.clone())
                }
            }));
        }
    }
    builder.build().map_err(|e| e.to_string())
}

pub fn apply_proxy_env(cmd: &mut std::process::Command) {
    if let Some(proxy_url) = configured_proxy_url() {
        cmd.env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("no_proxy", "localhost,127.0.0.1,::1");
    }
}

pub fn apply_proxy_env_tokio(cmd: &mut tokio::process::Command) {
    if let Some(proxy_url) = configured_proxy_url() {
        cmd.env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("no_proxy", "localhost,127.0.0.1,::1");
    }
}

pub fn apply_system_env(cmd: &mut std::process::Command) {
    cmd.envs(build_system_env());
}

pub fn apply_system_env_tokio(cmd: &mut tokio::process::Command) {
    cmd.envs(build_system_env());
}

fn merge_path_parts(parts: Vec<String>, sep: char) -> String {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        for seg in part.split(sep) {
            let trimmed = seg.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = trimmed.to_ascii_lowercase();
            if seen.insert(key) {
                out.push(trimmed.to_string());
            }
        }
    }
    out.join(&sep.to_string())
}

#[cfg(target_os = "windows")]
fn decode_reg_utf16(bytes: &[u8]) -> String {
    let mut u16s: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks(2) {
        if chunk.len() == 2 {
            u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
    }
    while let Some(&0) = u16s.last() {
        u16s.pop();
    }
    String::from_utf16_lossy(&u16s)
}

#[cfg(target_os = "windows")]
fn read_registry_env(hkey: RegKey, subkey: &str) -> Vec<(String, String, RegType)> {
    let key = match hkey.open_subkey_with_flags(subkey, KEY_READ) {
        Ok(k) => k,
        Err(_) => return Vec::new(),
    };
    let mut entries = Vec::new();
    for item in key.enum_values().flatten() {
        let (name, value) = item;
        let vtype = value.vtype;
        if vtype == RegType::REG_SZ || vtype == RegType::REG_EXPAND_SZ {
            let text = decode_reg_utf16(&value.bytes);
            entries.push((name, text, vtype));
        }
    }
    entries
}

#[cfg(target_os = "windows")]
fn expand_env_vars(value: &str, env_map: &HashMap<String, String>) -> String {
    let mut output = value.to_string();
    for _ in 0..5 {
        let chars: Vec<char> = output.chars().collect();
        let mut i = 0usize;
        let mut changed = false;
        let mut result = String::new();
        while i < chars.len() {
            if chars[i] == '%' {
                let mut j = i + 1;
                while j < chars.len() && chars[j] != '%' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '%' {
                    let key: String = chars[i + 1..j].iter().collect();
                    let lookup = key.to_ascii_uppercase();
                    if let Some(repl) = env_map.get(&lookup) {
                        result.push_str(repl);
                        changed = true;
                    }
                    i = j + 1;
                    continue;
                }
            }
            result.push(chars[i]);
            i += 1;
        }
        output = result;
        if !changed {
            break;
        }
    }
    output
}

pub fn build_system_env() -> Vec<(String, String)> {
    if let Ok(guard) = SYSTEM_ENV_CACHE.read() {
        if let Some((ts, cached)) = &*guard {
            if ts.elapsed().as_secs() <= SYSTEM_ENV_CACHE_TTL_SECS {
                return cached.clone();
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let system_entries = read_registry_env(
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        );
        let user_entries = read_registry_env(RegKey::predef(HKEY_CURRENT_USER), r"Environment");

        let mut map: HashMap<String, String> = HashMap::new();
        for (k, v, _) in system_entries.iter() {
            map.insert(k.to_ascii_uppercase(), v.clone());
        }
        for (k, v, _) in user_entries.iter() {
            map.insert(k.to_ascii_uppercase(), v.clone());
        }

        for (k, v, t) in system_entries.iter().chain(user_entries.iter()) {
            if *t == RegType::REG_EXPAND_SZ {
                let key = k.to_ascii_uppercase();
                let expanded = expand_env_vars(v, &map);
                map.insert(key, expanded);
            }
        }

        for (k, v) in std::env::vars() {
            map.insert(k.to_ascii_uppercase(), v);
        }

        let mut path_parts: Vec<String> = Vec::new();
        for (k, v, _) in system_entries.iter() {
            if k.eq_ignore_ascii_case("PATH") {
                path_parts.push(v.clone());
            }
        }
        for (k, v, _) in user_entries.iter() {
            if k.eq_ignore_ascii_case("PATH") {
                path_parts.push(v.clone());
            }
        }
        if let Ok(process_path) = std::env::var("PATH") {
            path_parts.push(process_path);
        }

        let base_path = merge_path_parts(path_parts, ';');
        let enhanced = build_enhanced_path_with_base(&base_path);
        map.insert("PATH".to_string(), enhanced);

        let built: Vec<(String, String)> = map.into_iter().collect();
        if let Ok(mut guard) = SYSTEM_ENV_CACHE.write() {
            *guard = Some((std::time::Instant::now(), built.clone()));
        }
        built
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut map: HashMap<String, String> = std::env::vars().collect();
        let base = map.get("PATH").cloned().unwrap_or_default();
        let enhanced = build_enhanced_path_with_base(&base);
        map.insert("PATH".to_string(), enhanced);
        let built: Vec<(String, String)> = map.into_iter().collect();
        if let Ok(mut guard) = SYSTEM_ENV_CACHE.write() {
            *guard = Some((std::time::Instant::now(), built.clone()));
        }
        built
    }
}

/// 缓存 enhanced_path 结果，避免每次调用都扫描文件系统
/// 使用 RwLock 替代 OnceLock，支持运行时刷新缓存
static ENHANCED_PATH_CACHE: RwLock<Option<String>> = RwLock::new(None);
static SYSTEM_ENV_CACHE: RwLock<Option<(std::time::Instant, Vec<(String, String)>)>> = RwLock::new(None);
const SYSTEM_ENV_CACHE_TTL_SECS: u64 = 5;

/// Tauri 应用启动时 PATH 可能不完整：
/// - macOS 从 Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
/// - Windows 上安装 Node.js 到非默认路径、或安装后未重启进程
///
/// 补充 Node.js / npm 常见安装路径
pub fn enhanced_path() -> String {
    // 先尝试读缓存
    if let Ok(guard) = ENHANCED_PATH_CACHE.read() {
        if let Some(ref cached) = *guard {
            return cached.clone();
        }
    }
    // 缓存为空，重新构建
    let path = build_enhanced_path_with_base(&std::env::var("PATH").unwrap_or_default());
    if let Ok(mut guard) = ENHANCED_PATH_CACHE.write() {
        *guard = Some(path.clone());
    }
    path
}

/// 刷新 enhanced_path 缓存，使新设置的 Node.js 路径立即生效（无需重启应用）
pub fn refresh_enhanced_path() {
    let new_path = build_enhanced_path_with_base(&std::env::var("PATH").unwrap_or_default());
    if let Ok(mut guard) = ENHANCED_PATH_CACHE.write() {
        *guard = Some(new_path);
    }
}

fn build_enhanced_path_with_base(base_path: &str) -> String {
    let current = base_path.to_string();
    let home = dirs::home_dir().unwrap_or_default();

    // 读取用户保存的自定义 Node.js 路径
    let custom_path = openclaw_dir()
        .join("clawpanel.json")
        .exists()
        .then(|| {
            std::fs::read_to_string(openclaw_dir().join("clawpanel.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("nodePath")?.as_str().map(String::from))
        })
        .flatten();

    #[cfg(target_os = "macos")]
    {
        let mut extra: Vec<String> = vec![
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
            format!("{}/.nvm/current/bin", home.display()),
            format!("{}/.volta/bin", home.display()),
            format!("{}/.nodenv/shims", home.display()),
            format!("{}/n/bin", home.display()),
            format!("{}/.npm-global/bin", home.display()),
        ];
        // NPM_CONFIG_PREFIX: 用户通过 npm config set prefix 自定义的全局安装路径
        if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
            extra.push(format!("{}/bin", prefix));
        }
        // 扫描 nvm 实际安装的版本目录（兼容无 current 符号链接的情况）
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // fnm: 扫描 $FNM_DIR 或默认 ~/.local/share/fnm 下的版本目录
        let fnm_dir = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/fnm"));
        let fnm_versions = fnm_dir.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("installation/bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        let mut parts: Vec<&str> = vec![];
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        parts.extend(extra.iter().map(|s| s.as_str()));
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(":")
    }

    #[cfg(target_os = "linux")]
    {
        let mut extra: Vec<String> = vec![
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/snap/bin".into(),
            format!("{}/.local/bin", home.display()),
            format!("{}/.nvm/current/bin", home.display()),
            format!("{}/.volta/bin", home.display()),
            format!("{}/.nodenv/shims", home.display()),
            format!("{}/n/bin", home.display()),
            format!("{}/.npm-global/bin", home.display()),
        ];
        // NPM_CONFIG_PREFIX: 用户通过 npm config set prefix 自定义的全局安装路径
        if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
            extra.push(format!("{}/bin", prefix));
        }
        // NVM_DIR 环境变量（用户可能自定义了 nvm 安装目录）
        let nvm_dir = std::env::var("NVM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"));
        let nvm_versions = nvm_dir.join("versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // fnm: 扫描 $FNM_DIR 或默认 ~/.local/share/fnm 下的版本目录
        let fnm_dir = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/fnm"));
        let fnm_versions = fnm_dir.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("installation/bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // nodesource / 手动安装的 Node.js 可能在 /usr/local/lib/nodejs/ 下
        let nodejs_lib = std::path::Path::new("/usr/local/lib/nodejs");
        if nodejs_lib.is_dir() {
            if let Ok(entries) = std::fs::read_dir(nodejs_lib) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        let mut parts: Vec<&str> = vec![];
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        parts.extend(extra.iter().map(|s| s.as_str()));
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(":")
    }

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();

        let mut extra: Vec<String> = vec![format!(r"{}\nodejs", pf), format!(r"{}\nodejs", pf86)];
        if !localappdata.is_empty() {
            extra.push(format!(r"{}\Programs\nodejs", localappdata));
            extra.push(format!(r"{}\fnm_multishells", localappdata));
        }
        if !appdata.is_empty() {
            extra.push(format!(r"{}\npm", appdata));
            extra.push(format!(r"{}\nvm", appdata));
            // 扫描 nvm-windows 实际安装的版本目录
            let nvm_dir = std::path::Path::new(&appdata).join("nvm");
            if nvm_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            extra.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        // NVM_SYMLINK 环境变量（nvm-windows 的活跃版本符号链接，如 D:\nodejs）
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            let symlink_path = std::path::Path::new(&nvm_symlink);
            if symlink_path.is_dir() {
                extra.push(nvm_symlink.clone());
            }
        }
        // NVM_HOME 环境变量（用户可能自定义了 nvm 安装目录）
        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            let nvm_path = std::path::Path::new(&nvm_home);
            if nvm_path.is_dir() {
                if let Ok(entries) = std::fs::read_dir(nvm_path) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            extra.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        extra.push(format!(r"{}\.volta\bin", home.display()));
        // fnm: 扫描 %FNM_DIR% 或默认 %APPDATA%\fnm 下的版本目录
        let fnm_base = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(&appdata).join("fnm"));
        let fnm_versions = fnm_base.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let inst = entry.path().join("installation");
                    if inst.is_dir() && inst.join("node.exe").exists() {
                        extra.push(inst.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 扫描常见盘符下的 Node 安装（用户可能装在 D:\、F:\ 等）
        for drive in &["C", "D", "E", "F"] {
            extra.push(format!(r"{}:\nodejs", drive));
            extra.push(format!(r"{}:\Node", drive));
            extra.push(format!(r"{}:\Program Files\nodejs", drive));
        }

        let mut parts: Vec<&str> = vec![];
        // 用户自定义路径优先级最高
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        // 然后是默认扫描到的路径
        for p in &extra {
            if std::path::Path::new(p).exists() {
                parts.push(p.as_str());
            }
        }
        // 最后是系统 PATH
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(";")
    }
}
