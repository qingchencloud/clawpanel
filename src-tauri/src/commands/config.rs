#[cfg(not(target_os = "macos"))]
use crate::utils::openclaw_command;
/// 配置读写命令
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use crate::models::types::VersionInfo;

struct GuardianPause {
    reason: &'static str,
}

impl GuardianPause {
    fn new(reason: &'static str) -> Self {
        crate::commands::service::guardian_pause(reason);
        Self { reason }
    }
}

impl Drop for GuardianPause {
    fn drop(&mut self) {
        crate::commands::service::guardian_resume(self.reason);
    }
}

/// 预设 npm 源列表
const DEFAULT_REGISTRY: &str = "https://registry.npmmirror.com";
/// (target_https_prefix, from_pattern) pairs for Git HTTPS rewriting.
/// Each entry maps a non-HTTPS Git URL pattern to the corresponding HTTPS URL.
const GIT_HTTPS_REWRITES: &[(&str, &str)] = &[
    // github.com
    ("https://github.com/", "ssh://git@github.com/"),
    ("https://github.com/", "ssh://git@github.com"),
    ("https://github.com/", "ssh://git@://github.com/"),
    ("https://github.com/", "git@github.com:"),
    ("https://github.com/", "git://github.com/"),
    ("https://github.com/", "git+ssh://git@github.com/"),
    // gitlab.com
    ("https://gitlab.com/", "ssh://git@gitlab.com/"),
    ("https://gitlab.com/", "git@gitlab.com:"),
    ("https://gitlab.com/", "git://gitlab.com/"),
    ("https://gitlab.com/", "git+ssh://git@gitlab.com/"),
    // bitbucket.org
    ("https://bitbucket.org/", "ssh://git@bitbucket.org/"),
    ("https://bitbucket.org/", "git@bitbucket.org:"),
    ("https://bitbucket.org/", "git://bitbucket.org/"),
    ("https://bitbucket.org/", "git+ssh://git@bitbucket.org/"),
];

#[derive(Debug, Deserialize, Default)]
struct VersionPolicySource {
    recommended: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct VersionPolicyEntry {
    #[serde(default)]
    official: VersionPolicySource,
    #[serde(default)]
    chinese: VersionPolicySource,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
struct R2Config {
    #[serde(default)]
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Deserialize, Default)]
struct StandaloneConfig {
    #[serde(default)]
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Deserialize, Default)]
struct VersionPolicy {
    #[serde(default)]
    standalone: StandaloneConfig,
    #[serde(default)]
    r2: R2Config,
    #[serde(default)]
    default: VersionPolicyEntry,
    #[serde(default)]
    panels: HashMap<String, VersionPolicyEntry>,
}

fn panel_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// 提取基础版本号（去掉 -zh.x / -nightly.xxx 等后缀，只保留主版本数字部分）
/// "2026.3.13-zh.1" → "2026.3.13", "2026.3.13" → "2026.3.13"
fn base_version(v: &str) -> String {
    // 在第一个 '-' 处截断
    let base = v.split('-').next().unwrap_or(v);
    base.to_string()
}

/// 判断 CLI 报告的版本是否与推荐版匹配（考虑汉化版 -zh.x 后缀差异）
fn versions_match(cli_version: &str, recommended: &str) -> bool {
    if cli_version == recommended {
        return true;
    }
    // CLI 报告 "2026.3.13"，推荐版 "2026.3.13-zh.1" → 基础版本相同即视为匹配
    base_version(cli_version) == base_version(recommended)
}

/// 判断推荐版是否真的比当前版本更新（忽略 -zh.x 后缀）
fn recommended_is_newer(recommended: &str, current: &str) -> bool {
    let r = parse_version(&base_version(recommended));
    let c = parse_version(&base_version(current));
    r > c
}

fn load_version_policy() -> VersionPolicy {
    serde_json::from_str(include_str!("../../../openclaw-version-policy.json")).unwrap_or_default()
}

#[allow(dead_code)]
fn r2_config() -> R2Config {
    load_version_policy().r2
}

fn standalone_config() -> StandaloneConfig {
    load_version_policy().standalone
}

/// standalone 包的平台 key（与 CI 构建矩阵一致）
fn standalone_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "mac-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "mac-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

/// standalone 包的文件扩展名
fn standalone_archive_ext() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "zip"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "tar.gz"
    }
}

/// standalone 安装目录
pub(crate) fn standalone_install_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // Inno Setup PrivilegesRequired=lowest 默认安装到 %LOCALAPPDATA%\Programs
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join("Programs").join("OpenClaw"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|h| h.join(".openclaw-bin"))
    }
}

/// 所有可能的 standalone 安装位置（用于检测和卸载）
pub(crate) fn all_standalone_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&la).join("Programs").join("OpenClaw"));
            dirs.push(PathBuf::from(&la).join("OpenClaw"));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(pf).join("OpenClaw"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(h) = dirs::home_dir() {
            dirs.push(h.join(".openclaw-bin"));
        }
        dirs.push(PathBuf::from("/opt/openclaw"));
    }
    dirs
}

fn recommended_version_for(source: &str) -> Option<String> {
    let policy = load_version_policy();
    let panel_entry = policy.panels.get(panel_version());
    match source {
        "official" => panel_entry
            .and_then(|entry| entry.official.recommended.clone())
            .or(policy.default.official.recommended),
        _ => panel_entry
            .and_then(|entry| entry.chinese.recommended.clone())
            .or(policy.default.chinese.recommended),
    }
}

fn configure_git_https_rules() -> usize {
    // Collect unique target prefixes to unset old rules
    let targets: std::collections::HashSet<&str> =
        GIT_HTTPS_REWRITES.iter().map(|(t, _)| *t).collect();
    for target in &targets {
        let key = format!("url.{target}.insteadOf");
        let mut unset = Command::new("git");
        unset.args(["config", "--global", "--unset-all", &key]);
        #[cfg(target_os = "windows")]
        unset.creation_flags(0x08000000);
        let _ = unset.output();
    }

    let mut success = 0;
    for (target, from) in GIT_HTTPS_REWRITES {
        let key = format!("url.{target}.insteadOf");
        let mut cmd = Command::new("git");
        cmd.args(["config", "--global", "--add", &key, from]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if cmd.output().map(|o| o.status.success()).unwrap_or(false) {
            success += 1;
        }
    }
    success
}

fn apply_git_install_env(cmd: &mut Command) {
    crate::commands::apply_proxy_env(cmd);
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes",
        )
        .env("GIT_ALLOW_PROTOCOL", "https:http:file");
    cmd.env("GIT_CONFIG_COUNT", GIT_HTTPS_REWRITES.len().to_string());
    for (idx, (target, from)) in GIT_HTTPS_REWRITES.iter().enumerate() {
        cmd.env(
            format!("GIT_CONFIG_KEY_{idx}"),
            format!("url.{target}.insteadOf"),
        )
        .env(format!("GIT_CONFIG_VALUE_{idx}"), *from);
    }
}

/// Linux: 检测是否以 root 身份运行（避免 unsafe libc 调用）
#[cfg(target_os = "linux")]
fn nix_is_root() -> bool {
    std::env::var("USER")
        .or_else(|_| std::env::var("EUID"))
        .map(|v| v == "root" || v == "0")
        .unwrap_or(false)
}

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
/// Linux 非 root 用户全局安装需要 sudo
fn npm_command() -> Command {
    let registry = get_configured_registry();
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npm", "--registry", &registry]);
        cmd.env("PATH", super::enhanced_path());
        crate::commands::apply_proxy_env(&mut cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("npm");
        cmd.args(["--registry", &registry]);
        cmd.env("PATH", super::enhanced_path());
        crate::commands::apply_proxy_env(&mut cmd);
        cmd
    }
    #[cfg(target_os = "linux")]
    {
        // Linux 非 root 用户全局 npm install 需要 sudo
        let need_sudo = !nix_is_root();
        let mut cmd = if need_sudo {
            let mut c = Command::new("sudo");
            c.args(["-E", "npm", "--registry", &registry]);
            c
        } else {
            let mut c = Command::new("npm");
            c.args(["--registry", &registry]);
            c
        };
        cmd.env("PATH", super::enhanced_path());
        crate::commands::apply_proxy_env(&mut cmd);
        cmd
    }
}

/// 安装/升级前的清理工作：停止 Gateway、清理 npm 全局 bin 下的 openclaw 残留文件
/// 解决 Windows 上 EEXIST（文件已存在）和文件被占用的问题
fn pre_install_cleanup() {
    // 1. 停止 Gateway 进程，释放 openclaw 相关文件锁
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 杀死所有 openclaw gateway 相关的 node 进程
        let _ = Command::new("taskkill")
            .args(["/f", "/im", "node.exe", "/fi", "WINDOWTITLE eq OpenClaw*"])
            .creation_flags(0x08000000)
            .output();
        // 等文件锁释放
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid().unwrap_or(501);
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/ai.openclaw.gateway")])
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("pkill")
            .args(["-f", "openclaw.*gateway"])
            .output();
    }

    // 2. 清理 npm 全局 bin 目录下的 openclaw 残留文件（Windows EEXIST 根因）
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_bin = std::path::Path::new(&appdata).join("npm");
            for name in &["openclaw", "openclaw.cmd", "openclaw.ps1"] {
                let p = npm_bin.join(name);
                if p.exists() {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }
}

fn backups_dir() -> PathBuf {
    super::openclaw_dir().join("backups")
}

#[tauri::command]
pub fn read_openclaw_config() -> Result<Value, String> {
    let path = super::openclaw_dir().join("openclaw.json");
    let raw = fs::read(&path).map_err(|e| format!("读取配置失败: {e}"))?;

    // 自愈：自动剥离 UTF-8 BOM（EF BB BF），防止 JSON 解析失败
    let content = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&raw[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&raw).into_owned()
    };

    // 解析 JSON，失败时尝试自动修复或从备份恢复
    let mut config: Value = match serde_json::from_str(&content) {
        Ok(v) => {
            // BOM 被剥离过，静默写回干净文件
            if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                let _ = fs::write(&path, &content);
            }
            v
        }
        Err(e) => {
            // JSON 解析失败，尝试自动修复常见错误
            let fixed_content = fix_common_json_errors(&content);
            if let Ok(v) = serde_json::from_str(&fixed_content) {
                eprintln!("自动修复了配置文件的 JSON 语法错误");
                // 写回修复后的配置
                let _ = fs::write(&path, &fixed_content);
                v
            } else {
                // 自动修复失败，尝试从备份恢复
                let bak = super::openclaw_dir().join("openclaw.json.bak");
                if bak.exists() {
                    let bak_raw = fs::read(&bak).map_err(|e2| format!("备份也读取失败: {e2}"))?;
                    let bak_content = if bak_raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                        String::from_utf8_lossy(&bak_raw[3..]).into_owned()
                    } else {
                        String::from_utf8_lossy(&bak_raw).into_owned()
                    };
                    let bak_config: Value = serde_json::from_str(&bak_content).map_err(|e2| {
                        format!("配置损坏且备份也无效: 原始错误='{}', 备份错误='{}'", e, e2)
                    })?;
                    // 备份有效，恢复主文件
                    let _ = fs::write(&path, &bak_content);
                    eprintln!("从备份恢复了配置文件");
                    bak_config
                } else {
                    return Err(format!(
                        "配置 JSON 损坏且无备份: {} (行: {}, 列: {})",
                        e,
                        e.line(),
                        e.column()
                    ));
                }
            }
        }
    };

    // 自动清理 UI 专属字段，防止污染配置导致 CLI 启动失败
    if has_ui_fields(&config) {
        config = strip_ui_fields(config);
        // 静默写回清理后的配置
        let bak = super::openclaw_dir().join("openclaw.json.bak");
        let _ = fs::copy(&path, &bak);
        let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
        let _ = fs::write(&path, json);
    }

    Ok(config)
}

/// 尝试自动修复常见的 JSON 语法错误
/// Issue #127: 增强配置读取容错性
fn fix_common_json_errors(content: &str) -> String {
    let mut fixed = content.to_string();

    // 修复尾随逗号（在 ] 或 } 之前的逗号）
    // 模式: ,] 或 ,}
    fixed = fixed.replace(",]", "]");
    fixed = fixed.replace(",}", "}");

    // 修复多余逗号（在键值对后面的逗号）
    while fixed.contains(",,") {
        fixed = fixed.replace(",,", ",");
    }

    // 修复单引号：在字符串外将单引号替换为双引号
    fixed = simple_fix_single_quotes(&fixed);

    // 移除 JavaScript 风格的注释（// 或 /* */）
    // 注意：必须正确处理字符串内的 // （如 URL 中的 https://）
    let lines: Vec<&str> = fixed.lines().collect();
    let cleaned_lines: Vec<&str> = lines
        .iter()
        .map(|line| {
            // 逐字符扫描，跳过字符串内部，找到字符串外的 //
            let chars: Vec<char> = line.chars().collect();
            let mut in_string = false;
            let mut i = 0;
            while i < chars.len() {
                if chars[i] == '\\' && in_string {
                    // 转义字符，跳过下一个字符
                    i += 2;
                    continue;
                }
                if chars[i] == '"' {
                    in_string = !in_string;
                }
                if !in_string && i + 1 < chars.len() && chars[i] == '/' && chars[i + 1] == '/' {
                    // 找到字符串外的 //，截断该行
                    let truncated: String = chars[..i].iter().collect();
                    return Box::leak(truncated.into_boxed_str()) as &str;
                }
                i += 1;
            }
            *line
        })
        .collect();
    fixed = cleaned_lines.join("\n");

    // 移除多行注释 /* ... */
    // 简化处理：只在确认不在字符串内时移除
    static RE_MULTI_COMMENT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"/\*[\s\S]*?\*/").unwrap());
    if RE_MULTI_COMMENT.is_match(&fixed) {
        fixed = RE_MULTI_COMMENT.replace_all(&fixed, "").to_string();
    }

    fixed
}

/// 简单的单引号修复（fallback 方案）
fn simple_fix_single_quotes(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut in_string = false;
    let chars: Vec<char> = content.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let prev_char = if i > 0 { Some(chars[i - 1]) } else { None };

        if c == '"' && prev_char != Some('\\') {
            in_string = !in_string;
            result.push(c);
        } else if !in_string && c == '\'' {
            // 在字符串外，将单引号替换为双引号
            result.push('"');
        } else {
            result.push(c);
        }
        i += 1;
    }

    result
}

/// 供其他模块复用：读取 openclaw.json 为 JSON Value
pub fn load_openclaw_json() -> Result<Value, String> {
    read_openclaw_config()
}

/// 供其他模块复用：将 JSON Value 写回 openclaw.json（含备份和清理）
pub fn save_openclaw_json(config: &Value) -> Result<(), String> {
    write_openclaw_config(config.clone())
}

/// 供其他模块复用：触发 Gateway 重载
pub async fn do_reload_gateway(app: &tauri::AppHandle) -> Result<String, String> {
    let _ = app; // 预留扩展用
    reload_gateway().await
}

#[tauri::command]
pub fn write_openclaw_config(config: Value) -> Result<(), String> {
    let path = super::openclaw_dir().join("openclaw.json");

    // Issue #127 修复：先读取现有配置，合并后写入
    // 这样可以保留用户手动添加的合法字段（如 browser.profiles）
    // 即使这些字段不在前端传入的配置对象中
    let existing_config = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok());

    // 备份
    let bak = super::openclaw_dir().join("openclaw.json.bak");
    let _ = fs::copy(&path, &bak);

    // 合并配置：现有配置 + 新配置
    // 策略：遍历现有配置，保留所有非 UI 字段
    // 然后将新配置的值覆盖到合并结果中
    let merged = if let Some(existing) = existing_config {
        merge_configs_preserving_fields(&existing, &config)
    } else {
        config.clone()
    };

    // 清理 UI 专属字段，避免 CLI schema 校验失败
    let cleaned = strip_ui_fields(merged);

    // 写入
    let json = serde_json::to_string_pretty(&cleaned).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, &json).map_err(|e| format!("写入失败: {e}"))?;

    // 同步 provider 配置到所有 agent 的 models.json（运行时注册表）
    sync_providers_to_agent_models(&config);

    Ok(())
}

/// 合并两个配置对象，保留现有配置中的合法字段
///
/// Issue #127: 修复配置合并时丢失 browser.* 等合法字段的问题
///
/// 保留的字段：
/// - `browser.*` - OpenClaw browser profiles
/// - `agents.list` - OpenClaw agent list
/// - 其他 OpenClaw schema 定义的字段
///
/// 清理的字段：
/// - UI 专属字段（通过 strip_ui_fields 处理）
fn merge_configs_preserving_fields(existing: &Value, new: &Value) -> Value {
    use serde_json::Value;

    match (existing, new) {
        (Value::Object(existing_obj), Value::Object(new_obj)) => {
            let mut merged = existing_obj.clone();

            for (key, new_value) in new_obj {
                if key == "browser" || key == "agents" {
                    // 保留现有配置中的 browser 和 agents
                    // 如果新配置有对应的值且是对象，进行深度合并
                    if let Some(existing_value) = existing_obj.get(key) {
                        if let (Value::Object(existing_sub), Value::Object(new_sub)) =
                            (existing_value, new_value)
                        {
                            let mut sub_merged = existing_sub.clone();
                            for (sub_key, sub_value) in new_sub {
                                sub_merged.insert(sub_key.clone(), sub_value.clone());
                            }
                            merged.insert(key.clone(), Value::Object(sub_merged));
                        } else {
                            // 新值不是对象，直接使用新值
                            merged.insert(key.clone(), new_value.clone());
                        }
                    } else {
                        merged.insert(key.clone(), new_value.clone());
                    }
                } else {
                    // 其他字段直接使用新配置的值
                    merged.insert(key.clone(), new_value.clone());
                }
            }

            Value::Object(merged)
        }
        // 非对象类型，直接使用新配置
        _ => new.clone(),
    }
}

/// 已知需要清理的 UI 字段列表（用于诊断报告）
const KNOWN_UI_FIELDS: &[&str] = &[
    "current",
    "latest",
    "recommended",
    "update_available",
    "latest_update_available",
    "is_recommended",
    "ahead_of_recommended",
    "panel_version",
    "source",
    // models.providers 中的 UI 字段
    "lastTestAt",
    "latency",
    "testStatus",
    "testError",
];

/// 已知需要保留的合法 OpenClaw 配置字段（用于诊断报告）
/// 这些字段虽然不在标准列表中，但不应被警告为未知字段
/// 注意：这些字段在 `merge_configs_preserving_fields` 中会被特殊处理
#[allow(dead_code)]
const KNOWN_LEGAL_FIELDS: &[&str] = &["browser", "profiles", "agents", "gateway", "logging", "mcp"];

// KNOWN_LEGAL_FIELDS 目前在诊断逻辑中使用，用于生成报告信息

/// 验证 openclaw.json 配置，报告潜在问题
///
/// Issue #127: 新增诊断命令，帮助用户识别配置问题
///
/// 返回内容：
/// - config_valid: 配置是否可以正常读取
/// - ui_fields_found: 发现的 UI 专属字段（会被自动清理）
/// - unknown_fields: 未知的字段（可能是用户手动添加或 OpenClaw 新增）
/// - warnings: 警告信息和建议
#[tauri::command]
pub fn validate_openclaw_config() -> Result<Value, String> {
    let path = super::openclaw_dir().join("openclaw.json");

    // 读取原始内容（不经过自愈逻辑）
    let raw = fs::read(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let content = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&raw[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&raw).into_owned()
    };

    // 尝试解析 JSON
    let config: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            // JSON 解析失败，尝试自动修复
            let fixed_content = fix_common_json_errors(&content);
            match serde_json::from_str::<Value>(&fixed_content) {
                Ok(_v) => {
                    return Ok(json!({
                        "config_valid": false,
                        "json_error": format!("JSON 有语法错误，但已自动修复 (行: {}, 列: {})", e.line(), e.column()),
                        "auto_fixed": true,
                        "warnings": [
                            "配置文件存在 JSON 语法错误，已自动修复",
                            "建议：检查配置文件是否有尾随逗号或注释"
                        ]
                    }));
                }
                Err(_) => {
                    // 自动修复失败，检查备份
                    let bak = super::openclaw_dir().join("openclaw.json.bak");
                    if bak.exists() {
                        if let Ok(bak_content) = fs::read_to_string(&bak) {
                            if serde_json::from_str::<Value>(&bak_content).is_ok() {
                                return Ok(json!({
                                    "config_valid": false,
                                    "json_error": format!("JSON 解析失败 (行: {}, 列: {}), 建议从备份恢复", e.line(), e.column()),
                                    "backup_exists": true,
                                    "warnings": [
                                        "配置文件损坏，建议使用备份恢复",
                                        "备份文件：openclaw.json.bak"
                                    ]
                                }));
                            }
                        }
                    }
                    return Ok(json!({
                        "config_valid": false,
                        "json_error": format!("JSON 解析失败 (行: {}, 列: {}): {}", e.line(), e.column(), e),
                        "warnings": [
                            "配置文件严重损坏且无有效备份",
                            "建议：手动检查或重新创建配置文件"
                        ]
                    }));
                }
            }
        }
    };

    // 分析配置内容
    let mut ui_fields_found: Vec<String> = Vec::new();
    let mut unknown_fields: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 检查根层级的 UI 字段
    if let Some(obj) = config.as_object() {
        for key in obj.keys() {
            if KNOWN_UI_FIELDS.contains(&key.as_str()) {
                ui_fields_found.push(format!("根层级.{}", key));
            }
        }

        // 检查 browser 字段是否存在
        if obj.contains_key("browser") {
            if let Some(browser) = obj.get("browser") {
                if let Some(browser_obj) = browser.as_object() {
                    // 检查 browser.profiles
                    if browser_obj.contains_key("profiles") {
                        warnings.push(
                            "发现 browser.profiles 字段，这是 OpenClaw 合法的配置字段，将被保留"
                                .to_string(),
                        );
                    }
                    // 报告 browser 中的其他未知字段
                    for key in browser_obj.keys() {
                        if key != "profiles" {
                            unknown_fields.push(format!("browser.{}", key));
                        }
                    }
                }
            }
        }

        // 检查 agents 字段
        if obj.contains_key("agents") {
            if let Some(agents) = obj.get("agents") {
                if let Some(agents_obj) = agents.as_object() {
                    // 检查 agents 子字段（上游 schema 只定义 agents.list）
                    if agents_obj.contains_key("profiles") {
                        warnings.push(
                            "发现 agents.profiles 字段，上游 schema 未定义此字段，将保留但建议核实"
                                .to_string(),
                        );
                    }
                    // 检查 agents.list 中的元素
                    if let Some(Value::Array(list)) = agents_obj.get("list") {
                        for (idx, agent) in list.iter().enumerate() {
                            if let Some(agent_obj) = agent.as_object() {
                                for key in agent_obj.keys() {
                                    if KNOWN_UI_FIELDS.contains(&key.as_str()) {
                                        ui_fields_found
                                            .push(format!("agents.list[{}].{}", idx, key));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 检查 models.providers 中的测试状态字段
        if let Some(models) = obj.get("models") {
            if let Some(models_obj) = models.as_object() {
                if let Some(providers) = models_obj.get("providers") {
                    if let Some(providers_obj) = providers.as_object() {
                        for (provider_name, provider_val) in providers_obj {
                            if let Some(provider_obj) = provider_val.as_object() {
                                if let Some(Value::Array(models_arr)) = provider_obj.get("models") {
                                    for (model_idx, model) in models_arr.iter().enumerate() {
                                        if let Some(model_obj) = model.as_object() {
                                            for field in
                                                ["lastTestAt", "latency", "testStatus", "testError"]
                                            {
                                                if model_obj.contains_key(field) {
                                                    ui_fields_found.push(format!(
                                                        "models.providers.{}.models[{}].{}",
                                                        provider_name, model_idx, field
                                                    ));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 生成警告信息
        if !ui_fields_found.is_empty() {
            warnings.push(format!(
                "发现 {} 个 UI 专属字段，将被自动清理",
                ui_fields_found.len()
            ));
        }
    }

    Ok(json!({
        "config_valid": true,
        "ui_fields_found": ui_fields_found,
        "unknown_fields": unknown_fields,
        "warnings": warnings,
        "suggestions": if !ui_fields_found.is_empty() || !unknown_fields.is_empty() {
            vec![
                "UI 专属字段会被 ClawPanel 自动清理，不影响 OpenClaw 运行".to_string(),
                "未知字段如果是用户手动添加的，请确保符合 OpenClaw schema".to_string(),
                "如果遇到 'Unrecognized key' 错误，请检查配置文件是否包含 OpenClaw 不支持的字段".to_string(),
            ]
        } else {
            vec!["配置文件看起来正常，没有发现已知问题".to_string()]
        }
    }))
}

/// 将 openclaw.json 的 models.providers 完整同步到每个 agent 的 models.json
/// 包括：同步 baseUrl/apiKey/api、删除已移除的 provider、删除已移除的 model、
/// 确保 Gateway 运行时不会引用 openclaw.json 中已不存在的模型
fn sync_providers_to_agent_models(config: &Value) {
    let src_providers = config
        .pointer("/models/providers")
        .and_then(|p| p.as_object());

    // 收集 openclaw.json 中所有有效的 provider/model 组合
    let mut valid_models: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(providers) = src_providers {
        for (pk, pv) in providers {
            if let Some(models) = pv.get("models").and_then(|m| m.as_array()) {
                for m in models {
                    let id = m.get("id").and_then(|v| v.as_str()).or_else(|| m.as_str());
                    if let Some(id) = id {
                        valid_models.insert(format!("{}/{}", pk, id));
                    }
                }
            }
        }
    }

    // 收集所有 agent ID
    let mut agent_ids = vec!["main".to_string()];
    if let Some(Value::Array(list)) = config.pointer("/agents/list") {
        for agent in list {
            if let Some(id) = agent.get("id").and_then(|v| v.as_str()) {
                if id != "main" {
                    agent_ids.push(id.to_string());
                }
            }
        }
    }

    let agents_dir = super::openclaw_dir().join("agents");
    for agent_id in &agent_ids {
        let models_path = agents_dir.join(agent_id).join("agent").join("models.json");
        if !models_path.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&models_path) else {
            continue;
        };
        let Ok(mut models_json) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        let mut changed = false;

        if models_json
            .get("providers")
            .and_then(|p| p.as_object())
            .is_none()
        {
            if let Some(root) = models_json.as_object_mut() {
                root.insert("providers".into(), json!({}));
                changed = true;
            }
        }

        // 同步 providers
        if let Some(dst_providers) = models_json
            .get_mut("providers")
            .and_then(|p| p.as_object_mut())
        {
            // 1. 删除 openclaw.json 中已不存在的 provider
            if let Some(src) = src_providers {
                let to_remove: Vec<String> = dst_providers
                    .keys()
                    .filter(|k| !src.contains_key(k.as_str()))
                    .cloned()
                    .collect();
                for k in to_remove {
                    dst_providers.remove(&k);
                    changed = true;
                }

                for (provider_name, src_provider) in src.iter() {
                    if !dst_providers.contains_key(provider_name) {
                        dst_providers.insert(provider_name.clone(), src_provider.clone());
                        changed = true;
                    }
                }

                // 2. 同步存在的 provider 的 baseUrl/apiKey/api + 清理已删除的 models
                for (provider_name, src_provider) in src.iter() {
                    if let Some(dst_provider) = dst_providers.get_mut(provider_name) {
                        if let Some(dst_obj) = dst_provider.as_object_mut() {
                            // 同步连接信息
                            for field in ["baseUrl", "apiKey", "api"] {
                                if let Some(src_val) =
                                    src_provider.get(field).and_then(|v| v.as_str())
                                {
                                    if dst_obj.get(field).and_then(|v| v.as_str()) != Some(src_val)
                                    {
                                        dst_obj.insert(
                                            field.to_string(),
                                            Value::String(src_val.to_string()),
                                        );
                                        changed = true;
                                    }
                                }
                            }
                            // 清理已删除的 models
                            if let Some(dst_models) =
                                dst_obj.get_mut("models").and_then(|m| m.as_array_mut())
                            {
                                let src_model_ids: std::collections::HashSet<String> = src_provider
                                    .get("models")
                                    .and_then(|m| m.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("id")
                                                    .and_then(|v| v.as_str())
                                                    .or_else(|| m.as_str())
                                                    .map(|s| s.to_string())
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let before = dst_models.len();
                                dst_models.retain(|m| {
                                    let id = m
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| m.as_str())
                                        .unwrap_or("");
                                    src_model_ids.contains(id)
                                });
                                if dst_models.len() != before {
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if changed {
            if let Ok(new_json) = serde_json::to_string_pretty(&models_json) {
                let _ = fs::write(&models_path, new_json);
            }
        }
    }
}

/// 检测配置中是否包含 UI 专属字段
fn has_ui_fields(val: &Value) -> bool {
    if let Some(obj) = val.as_object() {
        if let Some(models_val) = obj.get("models") {
            if let Some(models_obj) = models_val.as_object() {
                if let Some(providers_val) = models_obj.get("providers") {
                    if let Some(providers_obj) = providers_val.as_object() {
                        for (_provider_name, provider_val) in providers_obj.iter() {
                            if let Some(provider_obj) = provider_val.as_object() {
                                if let Some(Value::Array(arr)) = provider_obj.get("models") {
                                    for model in arr.iter() {
                                        if let Some(mobj) = model.as_object() {
                                            if mobj.contains_key("lastTestAt")
                                                || mobj.contains_key("latency")
                                                || mobj.contains_key("testStatus")
                                                || mobj.contains_key("testError")
                                            {
                                                return true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    false
}

/// 清理 ClawPanel 内部字段，避免污染 openclaw.json 导致 Gateway 启动失败
/// Issue #89: version info 字段被写入 openclaw.json → Unknown config keys
/// Issue #127: 增强清理逻辑，保留 OpenClaw 合法的配置字段
///
/// 保留的合法配置字段（不清理）：
/// - `browser.*` - OpenClaw browser profiles 配置（如 browser.profiles）
/// - `agents.list` - OpenClaw agent list 配置
/// - 其他 OpenClaw schema 定义的字段
///
/// 清理的 UI 专属字段：
/// - 根层级：current, latest, update_available 等版本信息
/// - models.providers 中每个 model 的测试状态：lastTestAt, latency, testStatus, testError
fn strip_ui_fields(mut val: Value) -> Value {
    if let Some(obj) = val.as_object_mut() {
        // 清理根层级 ClawPanel 内部字段（version info 等）
        // 注意：保留 browser.* 和 agents.list，这些是 OpenClaw 合法的配置字段
        for key in &[
            "current",
            "latest",
            "recommended",
            "update_available",
            "latest_update_available",
            "is_recommended",
            "ahead_of_recommended",
            "panel_version",
            "source",
            // 渠道插件别名：OpenClaw schema 不承认 qqbot 作为根键（应写在 channels.qqbot）
            "qqbot",
        ] {
            obj.remove(*key);
        }
        // 处理 models.providers.xxx.models 结构
        if let Some(models_val) = obj.get_mut("models") {
            if let Some(models_obj) = models_val.as_object_mut() {
                if let Some(providers_val) = models_obj.get_mut("providers") {
                    if let Some(providers_obj) = providers_val.as_object_mut() {
                        for (_provider_name, provider_val) in providers_obj.iter_mut() {
                            if let Some(provider_obj) = provider_val.as_object_mut() {
                                if let Some(Value::Array(arr)) = provider_obj.get_mut("models") {
                                    for model in arr.iter_mut() {
                                        if let Some(mobj) = model.as_object_mut() {
                                            mobj.remove("lastTestAt");
                                            mobj.remove("latency");
                                            mobj.remove("testStatus");
                                            mobj.remove("testError");
                                            if !mobj.contains_key("name") {
                                                if let Some(id) =
                                                    mobj.get("id").and_then(|v| v.as_str())
                                                {
                                                    mobj.insert(
                                                        "name".into(),
                                                        Value::String(id.to_string()),
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // 递归处理 agents 数组中的元素（保留 agents.list 等合法字段）
        if let Some(agents_val) = obj.get_mut("agents") {
            if let Some(agents_obj) = agents_val.as_object_mut() {
                // 保留 agents 子字段不做修改
                // 只清理 agents 数组中的元素（如果有 UI 字段）
                if let Some(Value::Array(arr)) = agents_obj.get_mut("list") {
                    for agent in arr.iter_mut() {
                        if let Some(agent_obj) = agent.as_object_mut() {
                            // 清理 agent 中的 UI 字段，但保留 profiles
                            agent_obj.remove("current");
                            agent_obj.remove("latest");
                            agent_obj.remove("update_available");
                        }
                    }
                }
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
    let content = fs::read_to_string(&path).map_err(|e| format!("读取 MCP 配置失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_mcp_config(config: Value) -> Result<(), String> {
    let path = super::openclaw_dir().join("mcp.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))
}

/// 获取本地安装的 openclaw 版本号（异步版本）
/// macOS: 优先从 npm 包的 package.json 读取（含完整后缀），fallback 到 CLI
/// Windows/Linux: 优先读文件系统，fallback 到 CLI
async fn get_local_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let resolved = std::fs::canonicalize(&cli_path)
                .ok()
                .unwrap_or_else(|| PathBuf::from(&cli_path));
            if let Some(ver) = read_version_from_installation(&resolved)
                .or_else(|| read_version_from_installation(std::path::Path::new(&cli_path)))
            {
                return Some(ver);
            }
        }

        for brew_prefix in &["/opt/homebrew/bin", "/usr/local/bin"] {
            let openclaw_path = format!("{}/openclaw", brew_prefix);
            if let Ok(target) = fs::read_link(&openclaw_path) {
                let pkg_json = PathBuf::from(brew_prefix)
                    .join(&target)
                    .parent()
                    .map(|p| p.join("package.json"));
                if let Some(pkg_path) = pkg_json {
                    if let Ok(content) = fs::read_to_string(&pkg_path) {
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
    }

    #[cfg(target_os = "windows")]
    {
        // 优先从活跃 CLI 路径读取版本（与 macOS 逻辑一致）
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let cli_pb = PathBuf::from(&cli_path);
            let resolved = std::fs::canonicalize(&cli_pb).unwrap_or_else(|_| cli_pb.clone());
            if let Some(ver) = read_version_from_installation(&resolved)
                .or_else(|| read_version_from_installation(&cli_pb))
            {
                return Some(ver);
            }
        }

        for sa_dir in all_standalone_dirs() {
            // 仅当 CLI 二进制实际存在时才读取版本，避免残留文件误判为已安装
            if !sa_dir.join("openclaw.cmd").exists() {
                continue;
            }
            let version_file = sa_dir.join("VERSION");
            if let Ok(content) = fs::read_to_string(&version_file) {
                for line in content.lines() {
                    if let Some(ver) = line.strip_prefix("openclaw_version=") {
                        let ver = ver.trim();
                        if !ver.is_empty() {
                            return Some(ver.to_string());
                        }
                    }
                }
            }
            let sa_pkg = sa_dir
                .join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh")
                .join("package.json");
            if let Ok(content) = fs::read_to_string(&sa_pkg) {
                if let Some(ver) = serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|v| v.get("version")?.as_str().map(String::from))
                {
                    return Some(ver);
                }
            }
        }

        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_bin = PathBuf::from(&appdata).join("npm");
            let shim_path = npm_bin.join("openclaw.cmd");
            // 仅当 npm 全局 CLI shim 存在时才读取版本
            if !shim_path.exists() {
                // npm 全局无 CLI shim，跳过
            } else {
                // 读 .cmd 内容判断活跃包，而非依赖 classify_cli_source（路径无法区分）
                let is_zh = detect_source_from_cmd_shim(&shim_path)
                    .map(|s| s == "chinese")
                    .unwrap_or(false);
                let pkgs: &[&str] = if is_zh {
                    &["@qingchencloud/openclaw-zh", "openclaw"]
                } else {
                    &["openclaw", "@qingchencloud/openclaw-zh"]
                };
                for pkg in pkgs {
                    let pkg_json = npm_bin.join("node_modules").join(pkg).join("package.json");
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
    }

    // Linux: 参照 macOS/Windows 实现，完整检测链
    #[cfg(target_os = "linux")]
    {
        // 1. 活跃 CLI 优先
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let cli_pb = PathBuf::from(&cli_path);
            let resolved = std::fs::canonicalize(&cli_pb).unwrap_or_else(|_| cli_pb.clone());
            if let Some(ver) = read_version_from_installation(&resolved)
                .or_else(|| read_version_from_installation(&cli_pb))
            {
                return Some(ver);
            }
        }
        // 2. standalone 目录
        for sa_dir in all_standalone_dirs() {
            if !sa_dir.join("openclaw").exists() {
                continue;
            }
            let version_file = sa_dir.join("VERSION");
            if let Ok(content) = fs::read_to_string(&version_file) {
                for line in content.lines() {
                    if let Some(ver) = line.strip_prefix("openclaw_version=") {
                        let ver = ver.trim();
                        if !ver.is_empty() {
                            return Some(ver.to_string());
                        }
                    }
                }
            }
            let sa_pkg = sa_dir
                .join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh")
                .join("package.json");
            if let Ok(content) = fs::read_to_string(&sa_pkg) {
                if let Some(ver) = serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|v| v.get("version")?.as_str().map(String::from))
                {
                    return Some(ver);
                }
            }
        }
        // 3. symlink -> package.json
        if let Ok(target) = fs::read_link("/usr/local/bin/openclaw") {
            let pkg_json = PathBuf::from("/usr/local/bin")
                .join(&target)
                .parent()
                .map(|p| p.join("package.json"));
            if let Some(ref pkg_path) = pkg_json {
                if let Ok(content) = fs::read_to_string(pkg_path) {
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
    // Windows: 先确认 openclaw 不是第三方程序（如 CherryStudio）
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(o) = std::process::Command::new("where")
            .arg("openclaw")
            .creation_flags(0x08000000)
            .output()
        {
            let stdout = String::from_utf8_lossy(&o.stdout).to_lowercase();
            let all_third_party = stdout
                .lines()
                .filter(|l| !l.trim().is_empty())
                .all(|l| l.contains(".cherrystudio") || l.contains("cherry-studio"));
            if all_third_party {
                return None;
            }
        }
    }

    use crate::utils::openclaw_command_async;
    let output = openclaw_command_async()
        .arg("--version")
        .output()
        .await
        .ok()?;
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // 输出格式: "OpenClaw 2026.3.24 (hash)" → 取第一个数字开头的词（版本号）
    raw.split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(String::from)
}

/// 从 npm registry 获取最新版本号，超时 5 秒
async fn get_latest_version_for(source: &str) -> Option<String> {
    let client =
        crate::commands::build_http_client(std::time::Duration::from_secs(2), None).ok()?;
    let pkg = npm_package_name(source)
        .replace('/', "%2F")
        .replace('@', "%40");
    let registry = get_configured_registry();
    let url = format!("{registry}/{pkg}/latest");
    let resp = client.get(&url).send().await.ok()?;
    let json: Value = resp.json().await.ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// 从 Windows .cmd shim 文件内容判断实际关联的 npm 包来源
/// npm 生成的 shim 末尾引用实际 JS 入口，据此区分官方版与汉化版
#[cfg(target_os = "windows")]
fn detect_source_from_cmd_shim(cmd_path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let lower = content.to_lowercase();
    // 汉化版标记：@qingchencloud 或 openclaw-zh
    if lower.contains("openclaw-zh") || lower.contains("@qingchencloud") {
        return Some("chinese".into());
    }
    // 确认是 npm shim（含 node_modules 引用）→ 官方版
    if lower.contains("node_modules") {
        return Some("official".into());
    }
    // standalone 的 .cmd 可能不含 node_modules（自定义脚本），由 classify 处理
    None
}

/// 检测当前安装的是官方版还是汉化版
/// macOS: 优先检查 symlink 指向的实际路径
/// Windows: 读取 .cmd shim 内容判断实际关联的包
/// Linux: 直接用 npm list
fn detect_installed_source() -> String {
    // macOS: 检查 openclaw bin 的 symlink 指向
    #[cfg(target_os = "macos")]
    {
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let resolved = std::fs::canonicalize(&cli_path)
                .ok()
                .unwrap_or_else(|| PathBuf::from(&cli_path));
            let source = crate::utils::classify_cli_source(&resolved.to_string_lossy());
            if source == "npm-zh" || source == "standalone" {
                return "chinese".into();
            }
            if source == "npm-official" || source == "npm-global" {
                return "official".into();
            }
        }
        // 兼容 ARM (/opt/homebrew) 和 Intel (/usr/local) 两种 Homebrew 路径
        for brew_prefix in &["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"] {
            if let Ok(target) = std::fs::read_link(brew_prefix) {
                if target.to_string_lossy().contains("openclaw-zh") {
                    return "chinese".into();
                }
                return "official".into();
            }
        }
        for sa_dir in all_standalone_dirs() {
            if sa_dir.join("openclaw").exists() || sa_dir.join("VERSION").exists() {
                return "chinese".into();
            }
        }
        "unknown".into()
    }
    // Windows: 通过活跃 CLI 的 .cmd shim 内容判断来源
    // npm 生成的 .cmd shim 最后一行包含实际 JS 入口路径，例如:
    //   "%dp0%\node_modules\openclaw\bin\openclaw.js"           → 官方版
    //   "%dp0%\node_modules\@qingchencloud\openclaw-zh\..."     → 汉化版
    // 读取内容即可一锤定音，不依赖文件系统扫描（避免残留目录误判）
    #[cfg(target_os = "windows")]
    {
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let source = crate::utils::classify_cli_source(&cli_path);
            // 路径本身能确定的情况（standalone 目录、npm-zh 路径含 openclaw-zh）
            if source == "npm-zh" || source == "standalone" {
                return "chinese".into();
            }
            // npm-official / npm-global / unknown: 路径不含包名，读 .cmd 内容判断
            if let Some(shim_source) = detect_source_from_cmd_shim(std::path::Path::new(&cli_path))
            {
                return shim_source;
            }
        }
        // 无活跃 CLI 时的兜底：仅检查 npm 全局目录中实际存在的 shim
        if let Ok(appdata) = std::env::var("APPDATA") {
            let shim = PathBuf::from(&appdata).join("npm").join("openclaw.cmd");
            if let Some(s) = detect_source_from_cmd_shim(&shim) {
                return s;
            }
        }
        // 确实无法判断
        "unknown".into()
    }
    // Linux: 参照 macOS 实现，完整检测链
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // 1. 活跃 CLI 路径分类（与 macOS 一致）
        if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
            let resolved = std::fs::canonicalize(&cli_path)
                .ok()
                .unwrap_or_else(|| PathBuf::from(&cli_path));
            let source = crate::utils::classify_cli_source(&resolved.to_string_lossy());
            if source == "npm-zh" || source == "standalone" {
                return "chinese".into();
            }
            if source == "npm-official" || source == "npm-global" {
                return "official".into();
            }
        }
        // 2. 检查 symlink 指向（/usr/local/bin/openclaw, ~/bin/openclaw）
        let home = dirs::home_dir().unwrap_or_default();
        for link in &[
            PathBuf::from("/usr/local/bin/openclaw"),
            home.join("bin").join("openclaw"),
        ] {
            if let Ok(target) = std::fs::read_link(link) {
                if target.to_string_lossy().contains("openclaw-zh") {
                    return "chinese".into();
                }
                return "official".into();
            }
        }
        // 3. standalone 目录检测
        for sa_dir in all_standalone_dirs() {
            if sa_dir.join("openclaw").exists() || sa_dir.join("VERSION").exists() {
                return "chinese".into();
            }
        }
        // 4. npm list 兜底
        if let Ok(o) = npm_command()
            .args(["list", "-g", "@qingchencloud/openclaw-zh", "--depth=0"])
            .output()
        {
            if String::from_utf8_lossy(&o.stdout).contains("openclaw-zh@") {
                return "chinese".into();
            }
        }
        "unknown".into()
    }
}

#[tauri::command]
pub async fn get_version_info() -> Result<VersionInfo, String> {
    let current = get_local_version().await;
    let mut source = detect_installed_source();
    // 兜底：版本号含 -zh 则一定是汉化版
    if let Some(ref ver) = current {
        if ver.contains("-zh") && source != "chinese" {
            source = "chinese".to_string();
        }
    }
    // unknown 来源不查询 latest/recommended（无法确定对应哪个 npm 包）
    let latest = if source == "unknown" {
        None
    } else {
        get_latest_version_for(&source).await
    };
    let recommended = if source == "unknown" {
        None
    } else {
        recommended_version_for(&source)
    };
    let update_available = match (&current, &recommended) {
        (Some(c), Some(r)) => recommended_is_newer(r, c),
        (None, Some(_)) => true,
        _ => false,
    };
    let latest_update_available = match (&current, &latest) {
        (Some(c), Some(l)) => recommended_is_newer(l, c),
        (None, Some(_)) => true,
        _ => false,
    };
    let is_recommended = match (&current, &recommended) {
        (Some(c), Some(r)) => versions_match(c, r),
        _ => false,
    };
    let ahead_of_recommended = match (&current, &recommended) {
        (Some(c), Some(r)) => recommended_is_newer(c, r),
        _ => false,
    };

    // 解析当前实际使用的 CLI 路径
    let cli_path = crate::utils::resolve_openclaw_cli_path();
    let cli_source = cli_path
        .as_ref()
        .map(|p| crate::utils::classify_cli_source(p));

    // 扫描所有可检测到的 OpenClaw 安装
    let all_installations = scan_all_installations(&cli_path);

    Ok(VersionInfo {
        current,
        latest,
        recommended,
        update_available,
        latest_update_available,
        is_recommended,
        ahead_of_recommended,
        panel_version: panel_version().to_string(),
        source,
        cli_path,
        cli_source,
        all_installations: Some(all_installations),
    })
}

/// 扫描系统中所有可检测到的 OpenClaw 安装
fn scan_all_installations(
    active_path: &Option<String>,
) -> Vec<crate::models::types::OpenClawInstallation> {
    use crate::models::types::OpenClawInstallation;
    let mut results: Vec<OpenClawInstallation> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut try_add = |path: std::path::PathBuf| {
        if !path.exists() {
            return;
        }
        let canonical = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_string();
        if seen.contains(&canonical) {
            return;
        }
        seen.insert(canonical.clone());
        let path_str = path.to_string_lossy().to_string();
        let source = crate::utils::classify_cli_source(&path_str);
        let version = read_version_from_installation(&path);
        let is_active = active_path
            .as_ref()
            .map(|a| {
                let a_canon = std::path::Path::new(a)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::PathBuf::from(a))
                    .to_string_lossy()
                    .to_string();
                a_canon == canonical
            })
            .unwrap_or(false);
        results.push(OpenClawInstallation {
            path: path_str,
            source,
            version,
            active: is_active,
        });
    };

    // standalone 安装目录
    for sa_dir in all_standalone_dirs() {
        #[cfg(target_os = "windows")]
        try_add(sa_dir.join("openclaw.cmd"));
        #[cfg(not(target_os = "windows"))]
        try_add(sa_dir.join("openclaw"));
    }

    // npm 全局目录
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            try_add(
                std::path::PathBuf::from(&appdata)
                    .join("npm")
                    .join("openclaw.cmd"),
            );
        }
    }

    // PATH 中找到的所有 openclaw
    let enhanced = super::enhanced_path();
    #[cfg(target_os = "windows")]
    let sep = ';';
    #[cfg(not(target_os = "windows"))]
    let sep = ':';
    for dir in enhanced.split(sep) {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        let base = std::path::Path::new(dir);
        #[cfg(target_os = "windows")]
        {
            try_add(base.join("openclaw.cmd"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            try_add(base.join("openclaw"));
        }
    }

    results
}

/// 从安装路径附近读取版本信息
fn read_version_from_installation(cli_path: &std::path::Path) -> Option<String> {
    // 尝试从同目录的 VERSION 文件读取
    if let Some(dir) = cli_path.parent() {
        let version_file = dir.join("VERSION");
        if let Ok(content) = std::fs::read_to_string(&version_file) {
            for line in content.lines() {
                if let Some(ver) = line.strip_prefix("openclaw_version=") {
                    let ver = ver.trim();
                    if !ver.is_empty() {
                        return Some(ver.to_string());
                    }
                }
            }
        }
        // 根据 CLI 路径判断来源，决定 package.json 检查顺序
        // 避免残留的另一来源包被优先读取
        let cli_source = crate::utils::classify_cli_source(&cli_path.to_string_lossy());
        let pkg_names: &[&str] = if cli_source == "npm-zh" || cli_source == "standalone" {
            &["@qingchencloud/openclaw-zh", "openclaw"]
        } else {
            &["openclaw", "@qingchencloud/openclaw-zh"]
        };
        // 尝试从 package.json 读取
        for pkg_name in pkg_names {
            let pkg_json = dir.join("node_modules").join(pkg_name).join("package.json");
            if let Ok(content) = std::fs::read_to_string(&pkg_json) {
                if let Some(ver) = serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|v| v.get("version")?.as_str().map(String::from))
                {
                    return Some(ver);
                }
            }
        }
        // npm shim 情况：向上查找 node_modules
        if let Some(parent) = dir.parent() {
            for pkg_name in pkg_names {
                let pkg_json = parent
                    .join("node_modules")
                    .join(pkg_name)
                    .join("package.json");
                if let Ok(content) = std::fs::read_to_string(&pkg_json) {
                    if let Some(ver) = serde_json::from_str::<serde_json::Value>(&content)
                        .ok()
                        .and_then(|v| v.get("version")?.as_str().map(String::from))
                    {
                        return Some(ver);
                    }
                }
            }
        }
    }
    None
}

/// 获取 OpenClaw 运行时状态摘要（openclaw status --json）
/// 包含 runtimeVersion、会话列表（含 token 用量、fastMode 等标签）
#[tauri::command]
pub async fn get_status_summary() -> Result<Value, String> {
    let output = crate::utils::openclaw_command_async()
        .args(["status", "--json"])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // CLI 输出可能含非 JSON 行，复用 skills 模块的 extract_json
            crate::commands::skills::extract_json_pub(&stdout)
                .ok_or_else(|| "解析失败: 输出中未找到有效 JSON".to_string())
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            Err(format!("openclaw status 失败: {}", stderr.trim()))
        }
        Err(e) => Err(format!("执行 openclaw 失败: {e}")),
    }
}

/// npm 包名映射
fn npm_package_name(source: &str) -> &'static str {
    match source {
        "official" => "openclaw",
        _ => "@qingchencloud/openclaw-zh",
    }
}

/// 获取指定源的所有可用版本列表（从 npm registry 查询）
#[tauri::command]
pub async fn list_openclaw_versions(source: String) -> Result<Vec<String>, String> {
    let client = crate::commands::build_http_client(std::time::Duration::from_secs(10), None)
        .map_err(|e| format!("HTTP 初始化失败: {e}"))?;
    let pkg = npm_package_name(&source).replace('/', "%2F");
    let registry = get_configured_registry();
    let url = format!("{registry}/{pkg}");
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("查询版本失败: {e}"))?;
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    let mut versions = json
        .get("versions")
        .and_then(|v| v.as_object())
        .map(|obj| {
            let mut vers: Vec<String> = obj.keys().cloned().collect();
            vers.sort_by(|a, b| {
                let pa = parse_version(a);
                let pb = parse_version(b);
                pb.cmp(&pa)
            });
            vers
        })
        .unwrap_or_default();
    if let Some(recommended) = recommended_version_for(&source) {
        if let Some(pos) = versions.iter().position(|v| v == &recommended) {
            let version = versions.remove(pos);
            versions.insert(0, version);
        } else {
            versions.insert(0, recommended);
        }
    }
    Ok(versions)
}

/// 执行 npm 全局安装/升级/降级 openclaw（后台执行，通过 event 推送进度）
/// 立即返回，不阻塞前端。完成后 emit "upgrade-done" 或 "upgrade-error"。
#[tauri::command]
pub async fn upgrade_openclaw(
    app: tauri::AppHandle,
    source: String,
    version: Option<String>,
    method: Option<String>,
) -> Result<String, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let result = upgrade_openclaw_inner(
            app2.clone(),
            source,
            version,
            method.unwrap_or_else(|| "auto".into()),
        )
        .await;
        match result {
            Ok(msg) => {
                let _ = app2.emit("upgrade-done", &msg);
            }
            Err(err) => {
                let _ = app2.emit("upgrade-error", &err);
            }
        }
    });
    Ok("任务已启动".into())
}

/// 检测当前平台标识（用于 R2 归档文件名）
#[allow(dead_code)]
fn r2_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

/// npm 全局 node_modules 目录
#[allow(dead_code)]
fn npm_global_modules_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|a| PathBuf::from(a).join("npm").join("node_modules"))
    }
    #[cfg(target_os = "macos")]
    {
        // homebrew 或系统 node
        let brew = PathBuf::from("/opt/homebrew/lib/node_modules");
        if brew.exists() {
            return Some(brew);
        }
        let sys = PathBuf::from("/usr/local/lib/node_modules");
        if sys.exists() {
            return Some(sys);
        }
        Some(brew) // fallback to homebrew path
    }
    #[cfg(target_os = "linux")]
    {
        // 尝试 npm config get prefix
        if let Ok(output) = Command::new("npm")
            .args(["config", "get", "prefix"])
            .output()
        {
            let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !prefix.is_empty() {
                return Some(PathBuf::from(prefix).join("lib").join("node_modules"));
            }
        }
        Some(PathBuf::from("/usr/local/lib/node_modules"))
    }
}

/// npm 全局 bin 目录
#[allow(dead_code)]
fn npm_global_bin_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|a| PathBuf::from(a).join("npm"))
    }
    #[cfg(target_os = "macos")]
    {
        let brew = PathBuf::from("/opt/homebrew/bin");
        if brew.exists() {
            return Some(brew);
        }
        Some(PathBuf::from("/usr/local/bin"))
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("npm")
            .args(["config", "get", "prefix"])
            .output()
        {
            let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !prefix.is_empty() {
                return Some(PathBuf::from(prefix).join("bin"));
            }
        }
        Some(PathBuf::from("/usr/local/bin"))
    }
}

/// 尝试从 standalone 独立安装包安装 OpenClaw（自带 Node.js，零依赖）
/// 动态查询 latest.json 获取最新版本，下载对应平台的归档并解压
/// 成功返回 Ok(版本号)，失败返回 Err(原因) 供 caller 降级到 R2/npm
async fn try_standalone_install(
    app: &tauri::AppHandle,
    version: &str,
    override_base_url: Option<&str>,
) -> Result<String, String> {
    let source_label = if override_base_url.is_some() {
        "GitHub"
    } else {
        "CDN"
    };
    use tauri::Emitter;

    let cfg = standalone_config();
    if !cfg.enabled {
        return Err("standalone 安装未启用".into());
    }
    let base_url = cfg.base_url.as_deref().ok_or("standalone baseUrl 未配置")?;
    let platform = standalone_platform_key();
    if platform == "unknown" {
        return Err("当前平台不支持 standalone 安装包".into());
    }
    let install_dir = standalone_install_dir().ok_or("无法确定 standalone 安装目录")?;

    // 1. 动态查询最新版本
    let _ = app.emit(
        "upgrade-log",
        "\u{1F4E6} 尝试 standalone 独立安装包（汉化版专属，自带 Node.js 运行时，无需 npm）",
    );
    let _ = app.emit("upgrade-log", "查询最新版本...");
    let manifest_url = format!("{base_url}/latest.json");
    let client = crate::commands::build_http_client(std::time::Duration::from_secs(10), None)
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let manifest_resp = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("standalone 清单获取失败: {e}"))?;
    if !manifest_resp.status().is_success() {
        return Err(format!(
            "standalone 清单不可用 (HTTP {})",
            manifest_resp.status()
        ));
    }
    let manifest: Value = manifest_resp
        .json()
        .await
        .map_err(|e| format!("standalone 清单解析失败: {e}"))?;

    let remote_version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or("standalone 清单缺少 version 字段")?;

    // 版本匹配检查
    if version != "latest" && !versions_match(remote_version, version) {
        return Err(format!(
            "standalone 版本 {remote_version} 与请求版本 {version} 不匹配"
        ));
    }

    let default_base = format!("{base_url}/{remote_version}");
    let remote_base = if let Some(ovr) = override_base_url {
        ovr
    } else {
        manifest
            .get("base_url")
            .and_then(|v| v.as_str())
            .unwrap_or(&default_base)
    };

    // 2. 构造下载 URL
    let ext = standalone_archive_ext();
    let filename = format!("openclaw-{remote_version}-{platform}.{ext}");
    let download_url = format!("{remote_base}/{filename}");

    let _ = app.emit("upgrade-log", format!("从 {source_label} 下载: {filename}"));
    let _ = app.emit("upgrade-progress", 15);

    // 3. 流式下载
    let tmp_dir = std::env::temp_dir();
    let archive_path = tmp_dir.join(&filename);
    let dl_client = crate::commands::build_http_client(std::time::Duration::from_secs(600), None)
        .map_err(|e| format!("下载客户端创建失败: {e}"))?;
    let dl_resp = dl_client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("standalone 下载失败: {e}"))?;
    if !dl_resp.status().is_success() {
        return Err(format!(
            "standalone 下载失败 (HTTP {}): {download_url}",
            dl_resp.status()
        ));
    }
    let total_bytes = dl_resp.content_length().unwrap_or(0);
    let size_mb = if total_bytes > 0 {
        format!("{:.0}MB", total_bytes as f64 / 1_048_576.0)
    } else {
        "未知大小".into()
    };
    let _ = app.emit("upgrade-log", format!("下载中 ({size_mb})..."));

    {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&archive_path)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut stream = dl_resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_progress: u32 = 15;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入失败: {e}"))?;
            downloaded += chunk.len() as u64;
            if total_bytes > 0 {
                let pct = 15 + ((downloaded as f64 / total_bytes as f64) * 55.0) as u32;
                if pct > last_progress {
                    last_progress = pct;
                    let _ = app.emit("upgrade-progress", pct.min(70));
                }
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("刷新文件失败: {e}"))?;
    }

    let _ = app.emit("upgrade-log", "下载完成，解压安装中...");
    let _ = app.emit("upgrade-progress", 72);

    // 4. 清理旧安装 & 创建目录
    if install_dir.exists() {
        let _ = std::fs::remove_dir_all(&install_dir);
    }
    std::fs::create_dir_all(&install_dir).map_err(|e| format!("创建安装目录失败: {e}"))?;

    // 5. 解压
    #[cfg(target_os = "windows")]
    {
        // Windows: zip 解压
        let archive_file =
            std::fs::File::open(&archive_path).map_err(|e| format!("打开归档失败: {e}"))?;
        let mut zip_archive =
            zip::ZipArchive::new(archive_file).map_err(|e| format!("ZIP 解析失败: {e}"))?;
        zip_archive
            .extract(&install_dir)
            .map_err(|e| format!("ZIP 解压失败: {e}"))?;
        // 归档内可能有 openclaw/ 子目录，需要提升一层
        let nested = install_dir.join("openclaw");
        if nested.exists() && nested.join("node.exe").exists() {
            for entry in std::fs::read_dir(&nested)
                .map_err(|e| format!("读取目录失败: {e}"))?
                .flatten()
            {
                let dest = install_dir.join(entry.file_name());
                let _ = std::fs::rename(entry.path(), &dest);
            }
            let _ = std::fs::remove_dir_all(&nested);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Unix: tar.gz 解压
        let status = Command::new("tar")
            .args([
                "-xzf",
                &archive_path.to_string_lossy(),
                "-C",
                &install_dir.to_string_lossy(),
                "--strip-components=1",
            ])
            .status()
            .map_err(|e| format!("解压失败: {e}"))?;
        if !status.success() {
            return Err("tar 解压失败".into());
        }
    }

    // 清理临时文件
    let _ = std::fs::remove_file(&archive_path);
    let _ = app.emit("upgrade-progress", 85);

    // 6. 验证安装
    #[cfg(target_os = "windows")]
    let openclaw_bin = install_dir.join("openclaw.cmd");
    #[cfg(not(target_os = "windows"))]
    let openclaw_bin = install_dir.join("openclaw");

    if !openclaw_bin.exists() {
        return Err("standalone 解压后未找到 openclaw 可执行文件".into());
    }

    // 7. 添加到 PATH（Windows 用户 PATH，Unix 创建 symlink）
    #[cfg(target_os = "windows")]
    {
        let install_str = install_dir.to_string_lossy().to_string();
        // 检查是否已在 PATH 中
        let current_path = std::env::var("PATH").unwrap_or_default();
        if !current_path
            .split(';')
            .any(|p| p.eq_ignore_ascii_case(&install_str))
        {
            // 写入用户 PATH（注册表）
            let _ = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "$p = [Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*{}*') {{ [Environment]::SetEnvironmentVariable('Path', $p + ';{}', 'User') }}",
                        install_str.replace('\'', "''"),
                        install_str.replace('\'', "''")
                    ),
                ])
                .creation_flags(0x08000000)
                .status();
            // 同步更新当前进程的 PATH 环境变量，使后续 resolve_openclaw_cli_path()
            // 和 build_enhanced_path() 能立即发现 standalone 安装的 CLI，
            // 无需重启应用（注册表写入仅对新进程生效）
            // SAFETY: 在 Tauri 命令处理器中单次调用，此时无其他线程并发读写 PATH。
            // enhanced_path 使用独立的 RwLock 缓存，不受影响。
            unsafe {
                std::env::set_var("PATH", format!("{};{}", current_path, install_str));
            }
            let _ = app.emit("upgrade-log", format!("已添加到 PATH: {install_str}"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Unix: 创建 /usr/local/bin/openclaw symlink 或 ~/bin/openclaw
        let link_targets = [
            PathBuf::from("/usr/local/bin/openclaw"),
            dirs::home_dir()
                .unwrap_or_default()
                .join("bin")
                .join("openclaw"),
        ];
        for link in &link_targets {
            if let Some(parent) = link.parent() {
                if parent.exists() {
                    let _ = std::fs::remove_file(link);
                    #[cfg(unix)]
                    {
                        if std::os::unix::fs::symlink(&openclaw_bin, link).is_ok() {
                            let _ = Command::new("chmod")
                                .args(["+x", &openclaw_bin.to_string_lossy()])
                                .status();
                            let _ = app
                                .emit("upgrade-log", format!("symlink 已创建: {}", link.display()));
                            break;
                        }
                    }
                }
            }
        }
    }

    let _ = app.emit("upgrade-progress", 95);
    let _ = app.emit(
        "upgrade-log",
        format!("✅ standalone 独立安装包安装完成 ({remote_version})"),
    );
    let _ = app.emit(
        "upgrade-log",
        format!("安装目录: {}", install_dir.display()),
    );

    // 刷新 CLI 检测缓存
    crate::commands::service::invalidate_cli_detection_cache();

    Ok(remote_version.to_string())
}

/// 尝试从 R2 CDN 下载预装归档安装 OpenClaw（跳过 npm 依赖解析）
/// 成功返回 Ok(版本号)，失败返回 Err(原因) 供 caller 降级到 npm install
#[allow(dead_code)]
async fn try_r2_install(
    app: &tauri::AppHandle,
    version: &str,
    source: &str,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tauri::Emitter;

    let r2 = r2_config();
    if !r2.enabled {
        return Err("R2 加速未启用".into());
    }
    let base_url = r2.base_url.as_deref().ok_or("R2 baseUrl 未配置")?;
    let platform = r2_platform_key();
    if platform == "unknown" {
        return Err("当前平台不支持 R2 预装归档".into());
    }

    // 1. 获取 latest.json
    let _ = app.emit("upgrade-log", "尝试从 CDN 加速下载...");
    let manifest_url = format!("{}/latest.json", base_url);
    let client = crate::commands::build_http_client(std::time::Duration::from_secs(10), None)
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let manifest_resp = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("获取 CDN 清单失败: {e}"))?;
    if !manifest_resp.status().is_success() {
        return Err(format!("CDN 清单不可用 (HTTP {})", manifest_resp.status()));
    }
    let manifest: Value = manifest_resp
        .json()
        .await
        .map_err(|e| format!("CDN 清单解析失败: {e}"))?;

    // 2. 查找归档：优先通用 tarball（全平台），其次平台特定 assets
    let source_key = if source == "official" {
        "official"
    } else {
        "chinese"
    };
    let source_obj = manifest.get(source_key);
    let cdn_version = source_obj
        .and_then(|s| s.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or(version);

    // 优先通用 tarball（npm pack 产物，~50MB，全平台通用）
    let tarball = source_obj.and_then(|s| s.get("tarball"));
    // 其次平台特定 assets（预装 node_modules，~200MB）
    let asset = source_obj
        .and_then(|s| s.get("assets"))
        .and_then(|a| a.get(platform));
    let use_tarball = tarball
        .and_then(|t| t.get("url"))
        .and_then(|v| v.as_str())
        .is_some();

    let (archive_url, expected_sha, expected_size) = if let Some(a) = asset {
        // 优先平台预装归档（直接解压，零网络依赖，最快）
        (
            a.get("url")
                .and_then(|v| v.as_str())
                .ok_or("归档 URL 缺失")?,
            a.get("sha256").and_then(|v| v.as_str()).unwrap_or(""),
            a.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        )
    } else if use_tarball {
        // 其次通用 tarball（需要 npm install，仍有网络依赖）
        let t = tarball.unwrap();
        (
            t.get("url")
                .and_then(|v| v.as_str())
                .ok_or("tarball URL 缺失")?,
            t.get("sha256").and_then(|v| v.as_str()).unwrap_or(""),
            t.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        )
    } else {
        return Err(format!("CDN 无 {source_key} 可用归档"));
    };

    // 版本匹配检查（如果用户指定了版本，CDN 版本必须匹配）
    if version != "latest" && !versions_match(cdn_version, version) {
        return Err(format!(
            "CDN 版本 {cdn_version} 与请求版本 {version} 不匹配"
        ));
    }

    let size_mb = if expected_size > 0 {
        format!("{:.0}MB", expected_size as f64 / 1_048_576.0)
    } else {
        "未知大小".into()
    };
    let _ = app.emit(
        "upgrade-log",
        format!("CDN 下载: {cdn_version} ({platform}, {size_mb})"),
    );
    let _ = app.emit("upgrade-progress", 15);

    // 3. 流式下载到临时文件
    let tmp_dir = std::env::temp_dir();
    let archive_path = tmp_dir.join(format!("openclaw-{platform}.tgz"));
    let dl_client = crate::commands::build_http_client(std::time::Duration::from_secs(300), None)
        .map_err(|e| format!("下载客户端创建失败: {e}"))?;
    let dl_resp = dl_client
        .get(archive_url)
        .send()
        .await
        .map_err(|e| format!("CDN 下载失败: {e}"))?;
    if !dl_resp.status().is_success() {
        return Err(format!("CDN 下载失败 (HTTP {})", dl_resp.status()));
    }
    let total_bytes = dl_resp.content_length().unwrap_or(expected_size);

    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&archive_path)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut stream = dl_resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_progress: u32 = 15;
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入失败: {e}"))?;
            downloaded += chunk.len() as u64;
            if total_bytes > 0 {
                let pct = 15 + ((downloaded as f64 / total_bytes as f64) * 50.0) as u32;
                if pct > last_progress {
                    last_progress = pct;
                    let _ = app.emit("upgrade-progress", pct.min(65));
                }
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("刷新文件失败: {e}"))?;
    }

    let _ = app.emit("upgrade-log", "下载完成，校验中...");
    let _ = app.emit("upgrade-progress", 68);

    // 4. SHA256 校验
    if !expected_sha.is_empty() {
        let file_bytes = std::fs::read(&archive_path).map_err(|e| format!("读取归档失败: {e}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&file_bytes);
        let actual_sha = format!("{:x}", hasher.finalize());
        if actual_sha != expected_sha {
            let _ = std::fs::remove_file(&archive_path);
            return Err(format!(
                "SHA256 校验失败: 期望 {expected_sha}, 实际 {actual_sha}"
            ));
        }
        let _ = app.emit("upgrade-log", "SHA256 校验通过 ✓");
    }

    let _ = app.emit("upgrade-progress", 72);

    // 5. 安装：通用 tarball 用 npm install -g，平台归档用 tar 解压
    if use_tarball {
        // 通用 tarball 模式：npm install -g ./file.tgz（全平台通用，npm 自动处理原生模块）
        let _ = app.emit("upgrade-log", "通用 tarball 模式，执行 npm install...");
        let mut install_cmd = npm_command();
        install_cmd.args(["install", "-g", &archive_path.to_string_lossy(), "--force"]);
        apply_git_install_env(&mut install_cmd);
        let install_output = install_cmd
            .output()
            .map_err(|e| format!("npm install 执行失败: {e}"))?;
        if !install_output.status.success() {
            let stderr = String::from_utf8_lossy(&install_output.stderr);
            let _ = std::fs::remove_file(&archive_path);
            return Err(format!(
                "npm install -g tarball 失败: {}",
                &stderr[stderr.len().saturating_sub(300)..]
            ));
        }
        let _ = app.emit("upgrade-log", "npm install 完成 ✓");
    } else {
        // 平台特定归档模式：直接解压到 npm 全局 node_modules
        let modules_dir = npm_global_modules_dir().ok_or("无法确定 npm 全局 node_modules 目录")?;
        if !modules_dir.exists() {
            std::fs::create_dir_all(&modules_dir)
                .map_err(|e| format!("创建 node_modules 目录失败: {e}"))?;
        }
        let _ = app.emit("upgrade-log", format!("解压到 {}", modules_dir.display()));

        let qc_dir = modules_dir.join("@qingchencloud");
        if qc_dir.exists() {
            let _ = std::fs::remove_dir_all(&qc_dir);
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let status = Command::new("tar")
                .args([
                    "-xzf",
                    &archive_path.to_string_lossy(),
                    "-C",
                    &modules_dir.to_string_lossy(),
                ])
                .creation_flags(0x08000000)
                .status()
                .map_err(|e| format!("解压失败: {e}"))?;
            if !status.success() {
                return Err("tar 解压失败".into());
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let status = Command::new("tar")
                .args([
                    "-xzf",
                    &archive_path.to_string_lossy(),
                    "-C",
                    &modules_dir.to_string_lossy(),
                ])
                .status()
                .map_err(|e| format!("解压失败: {e}"))?;
            if !status.success() {
                return Err("tar 解压失败".into());
            }
        }

        // 归档内目录可能是 qingchencloud/（Windows tar 不支持 @ 前缀），需要重命名
        let no_at_dir = modules_dir.join("qingchencloud");
        if no_at_dir.exists() && !qc_dir.exists() {
            std::fs::rename(&no_at_dir, &qc_dir)
                .map_err(|e| format!("重命名 qingchencloud → @qingchencloud 失败: {e}"))?;
            let _ = app.emit("upgrade-log", "目录已修正: qingchencloud → @qingchencloud");
        }

        let _ = app.emit("upgrade-log", "解压完成，创建 bin 链接...");

        // 创建 bin 链接
        let bin_dir = npm_global_bin_dir().ok_or("无法确定 npm bin 目录")?;
        let openclaw_js = modules_dir
            .join("@qingchencloud")
            .join("openclaw-zh")
            .join("bin")
            .join("openclaw.js");

        if openclaw_js.exists() {
            #[cfg(target_os = "windows")]
            {
                let cmd_path = bin_dir.join("openclaw.cmd");
                let cmd_content = format!(
                    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"{}\" %*\r\n",
                    openclaw_js.display()
                );
                std::fs::write(&cmd_path, cmd_content)
                    .map_err(|e| format!("创建 openclaw.cmd 失败: {e}"))?;
                let ps1_path = bin_dir.join("openclaw.ps1");
                let ps1_content = format!(
                    "#!/usr/bin/env pwsh\r\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n\r\n$exe=\"\"\r\nif ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {{\r\n  $exe=\".exe\"\r\n}}\r\n$ret=0\r\nif (Test-Path \"$basedir/node$exe\") {{\r\n  if ($MyInvocation.ExpectingInput) {{\r\n    $input | & \"$basedir/node$exe\"  \"{}\" $args\r\n  }} else {{\r\n    & \"$basedir/node$exe\"  \"{}\" $args\r\n  }}\r\n  $ret=$LASTEXITCODE\r\n}} else {{\r\n  if ($MyInvocation.ExpectingInput) {{\r\n    $input | & \"node$exe\"  \"{}\" $args\r\n  }} else {{\r\n    & \"node$exe\"  \"{}\" $args\r\n  }}\r\n  $ret=$LASTEXITCODE\r\n}}\r\nexit $ret\r\n",
                    openclaw_js.display(), openclaw_js.display(), openclaw_js.display(), openclaw_js.display()
                );
                let _ = std::fs::write(&ps1_path, ps1_content);
            }
            #[cfg(not(target_os = "windows"))]
            {
                let link_path = bin_dir.join("openclaw");
                let _ = std::fs::remove_file(&link_path);
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink(&openclaw_js, &link_path)
                        .map_err(|e| format!("创建 symlink 失败: {e}"))?;
                    let _ = Command::new("chmod")
                        .args(["+x", &openclaw_js.to_string_lossy()])
                        .status();
                    let _ = Command::new("chmod")
                        .args(["+x", &link_path.to_string_lossy()])
                        .status();
                }
            }
            let _ = app.emit("upgrade-log", "bin 链接已创建 ✓");
        } else {
            let _ = app.emit("upgrade-log", "⚠️ openclaw.js 未找到，bin 链接跳过");
        }
    }

    // 清理临时文件
    let _ = std::fs::remove_file(&archive_path);

    let _ = app.emit("upgrade-progress", 95);
    Ok(cdn_version.to_string())
}

async fn upgrade_openclaw_inner(
    app: tauri::AppHandle,
    source: String,
    version: Option<String>,
    method: String,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;
    let _guardian_pause = GuardianPause::new("upgrade");

    let current_source = detect_installed_source();
    let pkg_name = npm_package_name(&source);
    let requested_version = version.clone();
    let recommended_version = recommended_version_for(&source);
    let ver = requested_version
        .as_deref()
        .or(recommended_version.as_deref())
        .unwrap_or("latest");
    let pkg = format!("{}@{}", pkg_name, ver);

    // ── standalone 安装（auto / standalone-r2 / standalone-github） ──
    let try_standalone = source != "official"
        && (method == "auto" || method == "standalone-r2" || method == "standalone-github");

    if try_standalone {
        // standalone-github 模式：使用 GitHub Releases 下载地址
        let github_base = if method == "standalone-github" {
            Some(format!(
                "https://github.com/qingchencloud/openclaw-standalone/releases/download/v{}",
                ver
            ))
        } else {
            None
        };
        match try_standalone_install(&app, ver, github_base.as_deref()).await {
            Ok(installed_ver) => {
                let _ = app.emit("upgrade-progress", 100);
                super::refresh_enhanced_path();
                crate::commands::service::invalidate_cli_detection_cache();
                let label = if method == "standalone-github" {
                    "GitHub"
                } else {
                    "CDN"
                };
                let msg = format!("✅ standalone ({label}) 安装完成，当前版本: {installed_ver}");
                let _ = app.emit("upgrade-log", &msg);
                return Ok(msg);
            }
            Err(reason) => {
                if method == "auto" {
                    let _ = app.emit(
                        "upgrade-log",
                        format!("standalone 不可用（{reason}），降级到 npm 安装..."),
                    );
                    let _ = app.emit("upgrade-progress", 5);
                } else {
                    return Err(format!("standalone 安装失败: {reason}"));
                }
            }
        }
    }

    // ── npm install（兜底或用户明确选择） ──

    // 切换源时需要卸载旧包，但为避免安装失败导致 CLI 丢失，
    // 先安装新包，成功后再卸载旧包
    let old_pkg = npm_package_name(&current_source);
    let need_uninstall_old = current_source != source;

    if requested_version.is_none() {
        if let Some(recommended) = &recommended_version {
            let _ = app.emit(
                "upgrade-log",
                format!(
                    "ClawPanel {} 默认绑定 OpenClaw 稳定版: {}",
                    panel_version(),
                    recommended
                ),
            );
        } else {
            let _ = app.emit("upgrade-log", "未找到绑定稳定版，将回退到 latest");
        }
    }
    let configured_rules = configure_git_https_rules();
    let _ = app.emit(
        "upgrade-log",
        format!(
            "Git HTTPS 规则已就绪 ({}/{})",
            configured_rules,
            GIT_HTTPS_REWRITES.len()
        ),
    );

    // 安装前：停止 Gateway 并清理可能冲突的 bin 文件
    let _ = app.emit("upgrade-log", "正在停止 Gateway 并清理旧文件...");
    pre_install_cleanup();

    let _ = app.emit("upgrade-log", format!("$ npm install -g {pkg} --force"));
    let _ = app.emit("upgrade-progress", 10);

    // 汉化版只支持官方源和淘宝源
    let configured_registry = get_configured_registry();
    let registry = if pkg_name.contains("openclaw-zh") {
        // 汉化版：淘宝源或官方源
        if configured_registry.contains("npmmirror.com")
            || configured_registry.contains("taobao.org")
        {
            configured_registry.as_str()
        } else {
            "https://registry.npmjs.org"
        }
    } else {
        // 官方版：使用用户配置的镜像源
        configured_registry.as_str()
    };

    let mut install_cmd = npm_command();
    install_cmd.args([
        "install",
        "-g",
        &pkg,
        "--force",
        "--registry",
        registry,
        "--verbose",
    ]);
    apply_git_install_env(&mut install_cmd);
    let mut child = install_cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行升级命令失败: {e}"))?;

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    // stderr 每行递增进度（10→80 区间），让用户看到进度在动
    // 同时收集 stderr 用于失败时返回给前端诊断
    let app2 = app.clone();
    let stderr_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let stderr_lines2 = stderr_lines.clone();
    let handle = std::thread::spawn(move || {
        let mut progress: u32 = 15;
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("upgrade-log", &line);
                stderr_lines2.lock().unwrap().push(line);
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
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or("unknown".into());

        // 如果使用了镜像源失败，自动降级到官方源重试
        let used_mirror = registry.contains("npmmirror.com") || registry.contains("taobao.org");
        if used_mirror {
            let _ = app.emit("upgrade-log", "");
            let _ = app.emit("upgrade-log", "⚠️ 镜像源安装失败，自动切换到官方源重试...");
            let _ = app.emit("upgrade-progress", 15);
            let fallback = "https://registry.npmjs.org";
            let mut install_cmd2 = npm_command();
            install_cmd2.args([
                "install",
                "-g",
                &pkg,
                "--force",
                "--registry",
                fallback,
                "--verbose",
            ]);
            apply_git_install_env(&mut install_cmd2);
            let mut child2 = install_cmd2
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("执行重试命令失败: {e}"))?;
            let stderr2 = child2.stderr.take();
            let stdout2 = child2.stdout.take();
            let app3 = app.clone();
            let stderr_lines3 = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let stderr_lines4 = stderr_lines3.clone();
            let handle2 = std::thread::spawn(move || {
                if let Some(pipe) = stderr2 {
                    let mut p: u32 = 20;
                    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                        let _ = app3.emit("upgrade-log", &line);
                        stderr_lines4.lock().unwrap().push(line);
                        if p < 75 {
                            p += 2;
                            let _ = app3.emit("upgrade-progress", p);
                        }
                    }
                }
            });
            if let Some(pipe) = stdout2 {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = app.emit("upgrade-log", &line);
                }
            }
            let _ = handle2.join();
            let _ = app.emit("upgrade-progress", 80);
            let status2 = child2
                .wait()
                .map_err(|e| format!("等待重试进程失败: {e}"))?;
            let _ = app.emit("upgrade-progress", 100);
            if !status2.success() {
                let code2 = status2
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or("unknown".into());
                let tail = stderr_lines3
                    .lock()
                    .unwrap()
                    .iter()
                    .rev()
                    .take(15)
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                return Err(format!(
                    "升级失败（镜像源和官方源均失败），exit code: {code2}\n{tail}"
                ));
            }
            let _ = app.emit("upgrade-log", "✅ 官方源安装成功");
        } else {
            let _ = app.emit("upgrade-log", format!("❌ 升级失败 (exit code: {code})"));
            let tail = stderr_lines
                .lock()
                .unwrap()
                .iter()
                .rev()
                .take(15)
                .rev()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!("升级失败，exit code: {code}\n{tail}"));
        }
    }

    // 安装成功后再卸载旧包（确保 CLI 始终可用）
    if need_uninstall_old {
        let _ = app.emit("upgrade-log", format!("清理旧版本 ({old_pkg})..."));
        let _ = npm_command().args(["uninstall", "-g", old_pkg]).output();

        // 清理 standalone 安装目录（不论从 standalone 切走还是切到 standalone，
        // npm 路径已经安装了新 CLI，standalone 残留会干扰源检测）
        for sa_dir in all_standalone_dirs() {
            if sa_dir.exists() {
                let _ = app.emit(
                    "upgrade-log",
                    format!("清理 standalone 残留: {}", sa_dir.display()),
                );
                let _ = std::fs::remove_dir_all(&sa_dir);
            }
        }
    }

    // 切换源后重装 Gateway 服务
    if need_uninstall_old {
        let _ = app.emit("upgrade-log", "正在重装 Gateway 服务（更新启动路径）...");

        // 刷新 PATH 缓存和 CLI 检测缓存，确保找到新安装的二进制
        super::refresh_enhanced_path();
        crate::commands::service::invalidate_cli_detection_cache();

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
            let _ = openclaw_command().args(["gateway", "stop"]).output();
        }
        // 重新安装（刷新后的 PATH 会找到新二进制）
        use crate::utils::openclaw_command_async;
        let gw_out = openclaw_command_async()
            .args(["gateway", "install"])
            .output()
            .await;
        match gw_out {
            Ok(o) if o.status.success() => {
                let _ = app.emit("upgrade-log", "Gateway 服务已重装");
            }
            _ => {
                let _ = app.emit(
                    "upgrade-log",
                    "⚠️ Gateway 重装失败，请手动执行 openclaw gateway install",
                );
            }
        }
    }

    let new_ver = get_local_version().await.unwrap_or_else(|| "未知".into());
    let msg = format!("✅ 安装完成，当前版本: {new_ver}");
    let _ = app.emit("upgrade-log", &msg);
    Ok(msg)
}

/// 卸载 OpenClaw（后台执行，通过 event 推送进度）
/// 立即返回，不阻塞前端。完成后 emit "upgrade-done" 或 "upgrade-error"。
#[tauri::command]
pub async fn uninstall_openclaw(
    app: tauri::AppHandle,
    clean_config: bool,
) -> Result<String, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let result = uninstall_openclaw_inner(app2.clone(), clean_config).await;
        match result {
            Ok(msg) => {
                let _ = app2.emit("upgrade-done", &msg);
            }
            Err(err) => {
                let _ = app2.emit("upgrade-error", &err);
            }
        }
    });
    Ok("任务已启动".into())
}

async fn uninstall_openclaw_inner(
    app: tauri::AppHandle,
    clean_config: bool,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;
    let _guardian_pause = GuardianPause::new("uninstall openclaw");
    crate::commands::service::guardian_mark_manual_stop();

    let source = detect_installed_source();
    let pkg = npm_package_name(&source);

    // 1. 先停止 Gateway
    let _ = app.emit("upgrade-log", "正在停止 Gateway...");
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid().unwrap_or(501);
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/ai.openclaw.gateway")])
            .output();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = openclaw_command().args(["gateway", "stop"]).output();
    }

    // 2. 卸载 Gateway 服务
    let _ = app.emit("upgrade-log", "正在卸载 Gateway 服务...");
    #[cfg(not(target_os = "macos"))]
    {
        let _ = openclaw_command().args(["gateway", "uninstall"]).output();
    }

    // 3. 清理 standalone 安装（所有可能的位置）
    for sa_dir in &all_standalone_dirs() {
        if sa_dir.exists() {
            let _ = app.emit(
                "upgrade-log",
                format!("清理 standalone 安装: {}", sa_dir.display()),
            );
            if let Err(e) = std::fs::remove_dir_all(sa_dir) {
                let _ = app.emit(
                    "upgrade-log",
                    format!("⚠️ 清理 standalone 失败: {e}（可能需要管理员权限）"),
                );
            } else {
                let _ = app.emit("upgrade-log", "standalone 安装已清理 ✓");
            }
        }
    }

    // 4. npm uninstall
    let _ = app.emit("upgrade-log", format!("$ npm uninstall -g {pkg}"));
    let _ = app.emit("upgrade-progress", 20);

    let mut child = npm_command()
        .args(["uninstall", "-g", pkg])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行卸载命令失败: {e}"))?;

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("upgrade-log", &line);
            }
        }
    });

    if let Some(pipe) = stdout {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("upgrade-log", &line);
        }
    }

    let _ = handle.join();
    let _ = app.emit("upgrade-progress", 60);

    let status = child.wait().map_err(|e| format!("等待进程失败: {e}"))?;
    if !status.success() {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or("unknown".into());
        return Err(format!("卸载失败，exit code: {code}"));
    }

    // 4. 两个包都尝试卸载（确保干净）
    let other_pkg = if source == "official" {
        "@qingchencloud/openclaw-zh"
    } else {
        "openclaw"
    };
    let _ = app.emit("upgrade-log", format!("清理 {other_pkg}..."));
    let _ = npm_command().args(["uninstall", "-g", other_pkg]).output();
    let _ = app.emit("upgrade-progress", 80);

    // 5. 可选：清理配置目录
    if clean_config {
        let config_dir = super::openclaw_dir();
        if config_dir.exists() {
            let _ = app.emit(
                "upgrade-log",
                format!("清理配置目录: {}", config_dir.display()),
            );
            if let Err(e) = std::fs::remove_dir_all(&config_dir) {
                let _ = app.emit(
                    "upgrade-log",
                    format!("⚠️ 清理配置目录失败: {e}（可能有文件被占用）"),
                );
            }
        }
    }

    let _ = app.emit("upgrade-progress", 100);
    let msg = if clean_config {
        "✅ OpenClaw 已完全卸载（包括配置文件）"
    } else {
        "✅ OpenClaw 已卸载（配置文件保留在 ~/.openclaw/）"
    };
    let _ = app.emit("upgrade-log", msg);
    Ok(msg.into())
}

/// 自动初始化配置文件（CLI 已装但 openclaw.json 不存在时）
#[tauri::command]
pub fn init_openclaw_config() -> Result<Value, String> {
    let dir = super::openclaw_dir();
    let config_path = dir.join("openclaw.json");
    let mut result = serde_json::Map::new();

    if config_path.exists() {
        result.insert("created".into(), Value::Bool(false));
        result.insert("message".into(), Value::String("配置文件已存在".into()));
        return Ok(Value::Object(result));
    }

    // 确保目录存在
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let last_touched_version =
        recommended_version_for("chinese").unwrap_or_else(|| "2026.1.1".to_string());
    let default_config = serde_json::json!({
        "$schema": "https://openclaw.ai/schema/config.json",
        "meta": { "lastTouchedVersion": last_touched_version },
        "models": { "providers": {} },
        "gateway": {
            "mode": "local",
            "port": 18789,
            "auth": { "mode": "none" },
            "controlUi": { "allowedOrigins": ["*"], "allowInsecureAuth": true }
        },
        "tools": { "profile": "full", "sessions": { "visibility": "all" } }
    });

    let content =
        serde_json::to_string_pretty(&default_config).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&config_path, content).map_err(|e| format!("写入失败: {e}"))?;

    result.insert("created".into(), Value::Bool(true));
    result.insert("message".into(), Value::String("配置文件已创建".into()));
    Ok(Value::Object(result))
}

#[tauri::command]
pub fn check_installation() -> Result<Value, String> {
    let dir = super::openclaw_dir();
    let installed = dir.join("openclaw.json").exists();
    let mut result = serde_json::Map::new();
    result.insert("installed".into(), Value::Bool(installed));
    result.insert(
        "path".into(),
        Value::String(dir.to_string_lossy().to_string()),
    );
    Ok(Value::Object(result))
}

/// 检测 Node.js 是否已安装，返回版本号和检测到的路径
#[tauri::command]
pub fn check_node() -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    let enhanced = super::enhanced_path();

    // 尝试通过 which/where 命令找到 node 的实际路径
    let node_path = find_node_path(&enhanced);

    if let Some(path) = node_path {
        let mut cmd = Command::new(&path);
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        match cmd.output() {
            Ok(o) if o.status.success() => {
                let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let detected_from = detect_node_source(&path);
                result.insert("installed".into(), Value::Bool(true));
                result.insert("version".into(), Value::String(ver));
                result.insert("path".into(), Value::String(path));
                result.insert("detectedFrom".into(), Value::String(detected_from));
            }
            _ => {
                result.insert("installed".into(), Value::Bool(false));
                result.insert("version".into(), Value::Null);
                result.insert("path".into(), Value::Null);
                result.insert("detectedFrom".into(), Value::Null);
            }
        }
    } else {
        result.insert("installed".into(), Value::Bool(false));
        result.insert("version".into(), Value::Null);
        result.insert("path".into(), Value::Null);
        result.insert("detectedFrom".into(), Value::Null);
    }
    Ok(Value::Object(result))
}

/// 在 PATH 中查找 node 可执行文件的实际路径
fn find_node_path(enhanced_path: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 where 命令
        let mut cmd = Command::new("where");
        cmd.arg("node");
        cmd.creation_flags(0x08000000);
        // 设置 PATH 为 enhanced_path，优先查找 node
        if std::env::var("PATH").is_ok() {
            cmd.env("PATH", enhanced_path);
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    // where 输出可能有多行，取第一行
                    if let Some(first_line) = stdout.lines().next() {
                        let path = first_line.trim().to_string();
                        if !path.is_empty() && std::path::Path::new(&path).exists() {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix: 使用 which 命令
        let mut cmd = Command::new("which");
        cmd.arg("node");
        if let Ok(_current_path) = std::env::var("PATH") {
            cmd.env("PATH", enhanced_path);
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

/// 根据 node 路径推断其来源
fn detect_node_source(node_path: &str) -> String {
    let path_lower = node_path.to_lowercase();
    let path_obj = std::path::Path::new(node_path);

    // 检查父目录
    if let Some(parent) = path_obj.parent() {
        let parent_str = parent.to_string_lossy().to_lowercase();

        // nvm-windows 符号链接路径
        if parent_str.contains("nvm") || parent_str.contains(".nvm") {
            // 检查是否是 nvm-windows 的当前版本符号链接
            if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                if path_lower.contains(&nvm_symlink.to_lowercase()) {
                    return "NVM_SYMLINK".to_string();
                }
            }
            return "NVM".to_string();
        }

        // Volta
        if parent_str.contains(".volta") || parent_str.contains("volta") {
            return "VOLTA".to_string();
        }

        // fnm
        if parent_str.contains("fnm") || parent_str.contains("fnm_multishells") {
            return "FNM".to_string();
        }

        // nodenv
        if parent_str.contains("nodenv") {
            return "NODENV".to_string();
        }

        // n (node version manager)
        if parent_str.contains("/n/bin") || parent_str.contains("\\n\\bin") {
            return "N".to_string();
        }

        // npm 全局
        if parent_str.contains("npm") && parent_str.contains("appdata") {
            return "NPM_GLOBAL".to_string();
        }

        // 系统默认安装位置
        if parent_str.contains("program files") || parent_str.contains("programs\\nodejs") {
            return "SYSTEM".to_string();
        }
    }

    // 检查环境变量
    #[cfg(target_os = "windows")]
    {
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            if path_lower.contains(&nvm_symlink.to_lowercase()) {
                return "NVM_SYMLINK".to_string();
            }
        }
    }

    "PATH".to_string()
}

/// 在指定路径下检测 node 是否存在
#[tauri::command]
pub fn check_node_at_path(node_dir: String) -> Result<Value, String> {
    let dir = std::path::PathBuf::from(&node_dir);
    #[cfg(target_os = "windows")]
    let node_bin = dir.join("node.exe");
    #[cfg(not(target_os = "windows"))]
    let node_bin = dir.join("node");

    let mut result = serde_json::Map::new();
    if !node_bin.exists() {
        result.insert("installed".into(), Value::Bool(false));
        result.insert("version".into(), Value::Null);
        return Ok(Value::Object(result));
    }

    let mut cmd = Command::new(&node_bin);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            result.insert("installed".into(), Value::Bool(true));
            result.insert("version".into(), Value::String(ver));
            result.insert("path".into(), Value::String(node_dir));
        }
        _ => {
            result.insert("installed".into(), Value::Bool(false));
            result.insert("version".into(), Value::Null);
        }
    }
    Ok(Value::Object(result))
}

/// 扫描常见路径，返回所有找到的 Node.js 安装，包含来源说明
#[tauri::command]
pub fn scan_node_paths() -> Result<Value, String> {
    let mut found: Vec<Value> = vec![];
    let home = dirs::home_dir().unwrap_or_default();

    let mut candidates: Vec<(String, String)> = vec![]; // (path, source)

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();

        // NVM_SYMLINK - nvm-windows 活跃版本
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            if std::path::Path::new(&nvm_symlink).is_dir() {
                candidates.push((nvm_symlink, "NVM_SYMLINK".to_string()));
            }
        }

        // NVM_HOME - 用户自定义 nvm 目录
        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            if std::path::Path::new(&nvm_home).is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_home) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            // 检查是否是当前激活版本（通过 settings.json）
                            let is_active = is_nvm_active_version(&nvm_home, &p);
                            let source = if is_active { "NVM_ACTIVE" } else { "NVM" };
                            candidates.push((p.to_string_lossy().to_string(), source.to_string()));
                        }
                    }
                }
            }
        }

        // %APPDATA%\nvm - nvm-windows 默认目录
        if !appdata.is_empty() {
            let nvm_dir = std::path::Path::new(&appdata).join("nvm");
            if nvm_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            let is_active =
                                is_nvm_active_version(nvm_dir.to_string_lossy().as_ref(), &p);
                            let source = if is_active { "NVM_ACTIVE" } else { "NVM" };
                            candidates.push((p.to_string_lossy().to_string(), source.to_string()));
                        }
                    }
                }
            }
        }

        // Volta
        let volta_bin = format!(r"{}\.volta\bin", home.display());
        candidates.push((volta_bin.clone(), "VOLTA".to_string()));
        // 检查 volta 当前激活版本
        if let Ok(volta_home) = std::env::var("VOLTA_HOME") {
            let volta_current = std::path::Path::new(&volta_home).join("current/bin");
            if volta_current.exists() {
                candidates.push((
                    volta_current.to_string_lossy().to_string(),
                    "VOLTA_ACTIVE".to_string(),
                ));
            }
        }

        // fnm
        if !localappdata.is_empty() {
            candidates.push((
                format!(r"{}\fnm_multishells", localappdata),
                "FNM_TEMP".to_string(),
            ));
        }
        let fnm_base = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(&appdata).join("fnm"));
        // fnm current
        let fnm_current = fnm_base.join("current/installation");
        if fnm_current.is_dir() && fnm_current.join("node.exe").exists() {
            candidates.push((
                fnm_current.to_string_lossy().to_string(),
                "FNM_ACTIVE".to_string(),
            ));
        }
        // fnm versions
        let fnm_versions = fnm_base.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let inst = entry.path().join("installation");
                    if inst.is_dir() && inst.join("node.exe").exists() {
                        let source = if inst == fnm_current {
                            "FNM_ACTIVE"
                        } else {
                            "FNM"
                        };
                        candidates.push((inst.to_string_lossy().to_string(), source.to_string()));
                    }
                }
            }
        }

        // npm 全局
        if !appdata.is_empty() {
            candidates.push((format!(r"{}\npm", appdata), "NPM_GLOBAL".to_string()));
        }

        // 系统默认
        candidates.push((format!(r"{}\nodejs", pf), "SYSTEM".to_string()));
        candidates.push((format!(r"{}\nodejs", pf86), "SYSTEM".to_string()));
        if !localappdata.is_empty() {
            candidates.push((
                format!(r"{}\Programs\nodejs", localappdata),
                "SYSTEM".to_string(),
            ));
        }

        // 常见盘符
        for drive in &["C", "D", "E", "F", "G"] {
            candidates.push((format!(r"{}:\nodejs", drive), "MANUAL".to_string()));
            candidates.push((format!(r"{}:\Node", drive), "MANUAL".to_string()));
            candidates.push((format!(r"{}:\Node.js", drive), "MANUAL".to_string()));
            candidates.push((
                format!(r"{}:\Program Files\nodejs", drive),
                "SYSTEM".to_string(),
            ));
            // AI/Dev 工具目录
            candidates.push((format!(r"{}:\AI\Node", drive), "MANUAL".to_string()));
            candidates.push((format!(r"{}:\AI\nodejs", drive), "MANUAL".to_string()));
            candidates.push((format!(r"{}:\Dev\nodejs", drive), "MANUAL".to_string()));
            candidates.push((format!(r"{}:\Tools\nodejs", drive), "MANUAL".to_string()));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(("/usr/local/bin".into(), "SYSTEM".to_string()));
        candidates.push(("/opt/homebrew/bin".into(), "BREW".to_string()));
        candidates.push((
            format!("{}/.nvm/current/bin", home.display()),
            "NVM_ACTIVE".to_string(),
        ));
        candidates.push((
            format!("{}/.volta/bin", home.display()),
            "VOLTA".to_string(),
        ));
        candidates.push((
            format!("{}/.nodenv/shims", home.display()),
            "NODENV".to_string(),
        ));
        candidates.push((
            format!("{}/.fnm/current/bin", home.display()),
            "FNM_ACTIVE".to_string(),
        ));
        candidates.push((format!("{}/n/bin", home.display()), "N".to_string()));
        candidates.push((
            format!("{}/.npm-global/bin", home.display()),
            "NPM_GLOBAL".to_string(),
        ));
    }

    // 去重并检测 node
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (dir, source) in &candidates {
        let path = std::path::Path::new(dir);
        #[cfg(target_os = "windows")]
        let node_bin = path.join("node.exe");
        #[cfg(not(target_os = "windows"))]
        let node_bin = path.join("node");

        if node_bin.exists() {
            let node_path_str = node_bin.to_string_lossy().to_string();
            // 去重
            if seen_paths.contains(&node_path_str) {
                continue;
            }
            seen_paths.insert(node_path_str.clone());

            let mut cmd = Command::new(&node_bin);
            cmd.arg("--version");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            if let Ok(o) = cmd.output() {
                if o.status.success() {
                    let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let mut entry = serde_json::Map::new();
                    entry.insert("path".into(), Value::String(node_path_str));
                    entry.insert("version".into(), Value::String(ver));
                    entry.insert("source".into(), Value::String(source.clone()));
                    // 标记是否激活
                    let is_active = source.contains("ACTIVE");
                    entry.insert("active".into(), Value::Bool(is_active));
                    found.push(Value::Object(entry));
                }
            }
        }
    }

    // 按激活状态排序（激活的版本排在前面）
    found.sort_by(|a, b| {
        let a_active = a.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_active = b.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
        b_active.cmp(&a_active)
    });

    Ok(Value::Array(found))
}

/// 检查给定版本目录是否是 nvm-windows 的当前激活版本
#[allow(dead_code)]
fn is_nvm_active_version(nvm_dir: &str, version_dir: &std::path::Path) -> bool {
    let settings_path = std::path::Path::new(nvm_dir).join("settings.json");
    if !settings_path.exists() {
        return false;
    }

    if let Ok(content) = std::fs::read_to_string(&settings_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(current_path) = json.get("path").and_then(|v| v.as_str()) {
                // settings.json 中的 path 可能是绝对路径或相对路径
                let expected_path: std::path::PathBuf =
                    if current_path.starts_with('/') || current_path.contains(':') {
                        // 绝对路径
                        std::path::Path::new(current_path).to_path_buf()
                    } else {
                        // 相对路径
                        std::path::Path::new(nvm_dir).join(current_path)
                    };
                return version_dir == expected_path.as_path();
            }
        }
    }
    false
}

/// 保存用户自定义的 Node.js 路径到 ~/.openclaw/clawpanel.json
#[tauri::command]
pub fn save_custom_node_path(node_dir: String) -> Result<(), String> {
    let config_path = super::openclaw_dir().join("clawpanel.json");
    let mut config: serde_json::Map<String, Value> = if config_path.exists() {
        let content =
            std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {e}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    config.insert("nodePath".into(), Value::String(node_dir));
    let json = serde_json::to_string_pretty(&Value::Object(config))
        .map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&config_path, json).map_err(|e| format!("写入配置失败: {e}"))?;
    // 立即刷新 PATH 缓存，使新路径生效（无需重启应用）
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();
    Ok(())
}

#[tauri::command]
pub fn write_env_file(path: String, config: String) -> Result<(), String> {
    let expanded = if let Some(stripped) = path.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(stripped)
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
    fs::write(&expanded, &config).map_err(|e| format!("写入 .env 失败: {e}"))
}

// ===== 备份管理 =====

#[tauri::command]
pub fn list_backups() -> Result<Value, String> {
    let dir = backups_dir();
    if !dir.exists() {
        return Ok(Value::Array(vec![]));
    }
    let mut backups: Vec<Value> = vec![];
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let meta = fs::metadata(&path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        // macOS 支持 created()，fallback 到 modified()
        let created = meta
            .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
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
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let src = super::openclaw_dir().join("openclaw.json");
    if !src.exists() {
        return Err("openclaw.json 不存在".into());
    }

    let now = chrono::Local::now();
    let name = format!("openclaw-{}.json", now.format("%Y%m%d-%H%M%S"));
    let dest = dir.join(&name);
    fs::copy(&src, &dest).map_err(|e| format!("备份失败: {e}"))?;

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

    fs::copy(&backup_path, &target).map_err(|e| format!("恢复失败: {e}"))?;
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
    fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))
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

/// 重载 Gateway 配置（热重载，不重启进程）
/// 通过 HTTP POST 向 Gateway 发送 reload 信号，避免触发完整的服务重启循环
#[allow(dead_code)]
async fn reload_gateway_via_http() -> Result<String, String> {
    // 读取 gateway 端口和 token
    let config_path = crate::commands::openclaw_dir().join("openclaw.json");
    let content =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {e}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?;

    let gw_port = config
        .get("gateway")
        .and_then(|g| g.get("port"))
        .and_then(|p| p.as_u64())
        .unwrap_or(18789) as u16;

    let token = config
        .get("gateway")
        .and_then(|g| g.get("auth"))
        .and_then(|a| a.get("token"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    // 尝试两个可能的 control UI 端口
    let control_ports = [gw_port + 2, 18792];

    for ctrl_port in control_ports {
        let url = format!("http://127.0.0.1:{}/__api/reload", ctrl_port);
        let client = crate::commands::build_http_client(
            std::time::Duration::from_secs(5),
            Some("ClawPanel"),
        )?;

        let mut req = client.post(&url);
        if !token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", token));
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                return Ok("Gateway 配置已热重载".to_string());
            }
            Ok(resp) => {
                eprintln!(
                    "[reload_gateway] 端口 {ctrl_port} 返回状态: {}",
                    resp.status()
                );
            }
            Err(e) => {
                eprintln!("[reload_gateway] 端口 {ctrl_port} 请求失败: {e}");
            }
        }
    }

    // 所有 HTTP 重载方式都失败，回退到进程重启
    eprintln!("[reload_gateway] HTTP 热重载不可用，将触发进程重启");
    Err("Gateway HTTP 重载不可用".to_string())
}

/// 重载 Gateway 服务
/// Windows/Linux: 优先尝试 HTTP 热重载（不重启进程）
/// 如果 HTTP 重载失败，回退到 restart_service（会触发 Guardian 重启循环）
#[tauri::command]
pub async fn reload_gateway() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid()?;
        let target = format!("gui/{uid}/ai.openclaw.gateway");
        let output = tokio::process::Command::new("launchctl")
            .args(["kickstart", "-k", &target])
            .output()
            .await
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
        // 优先尝试 HTTP 热重载（不影响现有连接）
        match reload_gateway_via_http().await {
            Ok(msg) => Ok(msg),
            Err(_) => {
                // HTTP 重载失败，回退到进程重启
                crate::commands::service::restart_service("ai.openclaw.gateway".into())
                    .await
                    .map(|_| "Gateway 已重启".to_string())
            }
        }
    }
}

/// 重启 Gateway 服务（与 reload_gateway 相同实现）
#[tauri::command]
pub async fn restart_gateway() -> Result<String, String> {
    reload_gateway().await
}

/// 运行 openclaw doctor --fix 自动修复配置问题
#[tauri::command]
pub async fn doctor_fix() -> Result<Value, String> {
    use crate::utils::openclaw_command_async;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        openclaw_command_async().args(["doctor", "--fix"]).output(),
    )
    .await;

    match result {
        Ok(Ok(o)) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let success = o.status.success();
            Ok(json!({
                "success": success,
                "output": stdout.trim(),
                "errors": stderr.trim(),
                "exitCode": o.status.code(),
            }))
        }
        Ok(Err(e)) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Err("OpenClaw CLI 未找到，请先安装".to_string())
            } else {
                Err(format!("执行 doctor 失败: {e}"))
            }
        }
        Err(_) => Err("doctor --fix 执行超时 (30s)".to_string()),
    }
}

/// 运行 openclaw doctor（仅诊断，不修复）
#[tauri::command]
pub async fn doctor_check() -> Result<Value, String> {
    use crate::utils::openclaw_command_async;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        openclaw_command_async().args(["doctor"]).output(),
    )
    .await;

    match result {
        Ok(Ok(o)) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            Ok(json!({
                "success": o.status.success(),
                "output": stdout.trim(),
                "errors": stderr.trim(),
            }))
        }
        Ok(Err(e)) => Err(format!("执行 doctor 失败: {e}")),
        Err(_) => Err("doctor 执行超时 (20s)".to_string()),
    }
}

/// 清理 base URL：去掉尾部斜杠和已知端点路径，防止用户粘贴完整端点 URL 导致路径重复
fn normalize_base_url(raw: &str) -> String {
    let mut base = raw.trim_end_matches('/').to_string();
    for suffix in &[
        "/api/chat",
        "/api/generate",
        "/api/tags",
        "/api",
        "/chat/completions",
        "/completions",
        "/responses",
        "/messages",
        "/models",
    ] {
        if base.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    base = base.trim_end_matches('/').to_string();
    if base.ends_with(":11434") {
        return format!("{base}/v1");
    }
    base
}

fn normalize_model_api_type(raw: &str) -> &'static str {
    match raw.trim() {
        "anthropic" | "anthropic-messages" => "anthropic-messages",
        "google-gemini" => "google-gemini",
        "openai" | "openai-completions" | "openai-responses" | "" => "openai-completions",
        _ => "openai-completions",
    }
}

fn normalize_base_url_for_api(raw: &str, api_type: &str) -> String {
    let mut base = normalize_base_url(raw);
    match normalize_model_api_type(api_type) {
        "anthropic-messages" => {
            if !base.ends_with("/v1") {
                base.push_str("/v1");
            }
            base
        }
        "google-gemini" => base,
        _ => {
            // 不再强制追加 /v1，尊重用户填写的 URL（火山引擎等第三方用 /v3 等路径）
            // 仅 Ollama (端口 11434) 自动补 /v1
            base
        }
    }
}

fn extract_error_message(text: &str, status: reqwest::StatusCode) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
                .or_else(|| v.get("message").and_then(|m| m.as_str()).map(String::from))
        })
        .unwrap_or_else(|| format!("HTTP {status}"))
}

/// 测试模型连通性：向 provider 发送一个简单的 chat completion 请求
#[tauri::command]
pub async fn test_model(
    base_url: String,
    api_key: String,
    model_id: String,
    api_type: Option<String>,
) -> Result<String, String> {
    let api_type = normalize_model_api_type(api_type.as_deref().unwrap_or("openai-completions"));
    let base = normalize_base_url_for_api(&base_url, api_type);

    let client =
        crate::commands::build_http_client_no_proxy(std::time::Duration::from_secs(30), None)
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = match api_type {
        "anthropic-messages" => {
            let url = format!("{}/messages", base);
            let body = json!({
                "model": model_id,
                "messages": [{"role": "user", "content": "Hi"}],
                "max_tokens": 16,
            });
            let mut req = client
                .post(&url)
                .header("anthropic-version", "2023-06-01")
                .json(&body);
            if !api_key.is_empty() {
                req = req.header("x-api-key", api_key.clone());
            }
            req.send()
        }
        "google-gemini" => {
            let url = format!(
                "{}/models/{}:generateContent?key={}",
                base, model_id, api_key
            );
            let body = json!({
                "contents": [{"role": "user", "parts": [{"text": "Hi"}]}]
            });
            client.post(&url).json(&body).send()
        }
        _ => {
            let url = format!("{}/chat/completions", base);
            let body = json!({
                "model": model_id,
                "messages": [{"role": "user", "content": "Hi"}],
                "max_tokens": 16,
                "stream": false
            });
            let mut req = client.post(&url).json(&body);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            req.send()
        }
    }
    .await
    .map_err(|e| {
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
        let msg = extract_error_message(&text, status);
        // 401/403 是认证错误，一定要报错
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(msg);
        }
        // 其他错误（400/422/429 等）：服务器可达、认证通过，仅模型对简单测试不兼容
        // 返回成功但带提示和完整错误信息，方便前端展示
        return Ok(format!(
            "⚠ 连接正常（API 返回 {status}，部分模型对简单测试不兼容，不影响实际使用）\n{msg}"
        ));
    }

    // 提取回复内容（兼容多种响应格式）
    let reply = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
                let text = arr
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                if !text.is_empty() {
                    return Some(text);
                }
            }
            if let Some(t) = v
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.get(0))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
            {
                return Some(t.to_string());
            }
            // 标准 OpenAI 格式: choices[0].message.content
            if let Some(msg) = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
            {
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                if !content.is_empty() {
                    return Some(content.to_string());
                }
                // reasoning 模型
                if let Some(rc) = msg
                    .get("reasoning_content")
                    .and_then(|c| c.as_str())
                    .filter(|s| !s.is_empty())
                {
                    return Some(format!("[reasoning] {rc}"));
                }
            }
            // DashScope 格式: output.text
            if let Some(t) = v
                .get("output")
                .and_then(|o| o.get("text"))
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
            {
                return Some(t.to_string());
            }
            None
        })
        .unwrap_or_else(|| "（模型已响应）".into());

    Ok(reply)
}

/// 获取服务商的远程模型列表（调用 /models 接口）
#[tauri::command]
pub async fn list_remote_models(
    base_url: String,
    api_key: String,
    api_type: Option<String>,
) -> Result<Vec<String>, String> {
    let api_type = normalize_model_api_type(api_type.as_deref().unwrap_or("openai-completions"));
    let base = normalize_base_url_for_api(&base_url, api_type);

    let client =
        crate::commands::build_http_client_no_proxy(std::time::Duration::from_secs(15), None)
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = match api_type {
        "anthropic-messages" => {
            let url = format!("{}/models", base);
            let mut req = client.get(&url).header("anthropic-version", "2023-06-01");
            if !api_key.is_empty() {
                req = req.header("x-api-key", api_key.clone());
            }
            req.send()
        }
        "google-gemini" => {
            let url = format!("{}/models?key={}", base, api_key);
            client.get(&url).send()
        }
        _ => {
            let url = format!("{}/models", base);
            let mut req = client.get(&url);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            req.send()
        }
    }
    .await
    .map_err(|e| {
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
        let msg = extract_error_message(&text, status);
        return Err(format!("获取模型列表失败: {msg}"));
    }

    // 解析 OpenAI / Anthropic / Gemini 格式的 /models 响应
    let ids = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .map(|v| {
            let mut ids: Vec<String> = if let Some(data) = v.get("data").and_then(|d| d.as_array())
            {
                data.iter()
                    .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                    .collect()
            } else if let Some(data) = v.get("models").and_then(|d| d.as_array()) {
                data.iter()
                    .filter_map(|m| {
                        m.get("name")
                            .and_then(|id| id.as_str())
                            .map(|s| s.trim_start_matches("models/").to_string())
                    })
                    .collect()
            } else {
                vec![]
            };
            ids.sort();
            ids
        })
        .unwrap_or_default();

    if ids.is_empty() {
        return Err("该服务商返回了空的模型列表，可能不支持 /models 接口".to_string());
    }

    Ok(ids)
}

/// 安装 Gateway 服务（执行 openclaw gateway install）
#[tauri::command]
pub async fn install_gateway() -> Result<String, String> {
    use crate::utils::openclaw_command_async;
    let _guardian_pause = GuardianPause::new("install gateway");
    // 先检测 openclaw CLI 是否可用
    let cli_check = openclaw_command_async().arg("--version").output().await;
    match cli_check {
        Ok(o) if o.status.success() => {}
        _ => {
            return Err("openclaw CLI 未安装。请先执行以下命令安装：\n\n\
                 npm install -g @qingchencloud/openclaw-zh\n\n\
                 安装完成后再点击此按钮安装 Gateway 服务。"
                .into());
        }
    }

    let output = openclaw_command_async()
        .args(["gateway", "install"])
        .output()
        .await
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
/// Windows: 直接 taskkill
/// Linux: pkill
#[tauri::command]
pub fn uninstall_gateway() -> Result<String, String> {
    let _guardian_pause = GuardianPause::new("uninstall gateway");
    crate::commands::service::guardian_mark_manual_stop();
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
            fs::remove_file(&plist).map_err(|e| format!("删除 plist 失败: {e}"))?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        // 直接杀死 gateway 相关的 node.exe 进程，不走慢 CLI
        let _ = Command::new("taskkill")
            .args(["/f", "/im", "node.exe", "/fi", "WINDOWTITLE eq openclaw*"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("pkill")
            .args(["-f", "openclaw.*gateway"])
            .output();
    }
    Ok("Gateway 服务已卸载".to_string())
}

/// 为 openclaw.json 中所有模型添加 input: ["text", "image"]，使 Gateway 识别模型支持图片输入
#[tauri::command]
pub fn patch_model_vision() -> Result<bool, String> {
    let path = super::openclaw_dir().join("openclaw.json");
    let content = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let mut config: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;

    let vision_input = Value::Array(vec![
        Value::String("text".into()),
        Value::String("image".into()),
    ]);

    let mut changed = false;

    if let Some(obj) = config.as_object_mut() {
        if let Some(models_val) = obj.get_mut("models") {
            if let Some(models_obj) = models_val.as_object_mut() {
                if let Some(providers_val) = models_obj.get_mut("providers") {
                    if let Some(providers_obj) = providers_val.as_object_mut() {
                        for (_provider_name, provider_val) in providers_obj.iter_mut() {
                            if let Some(provider_obj) = provider_val.as_object_mut() {
                                if let Some(Value::Array(arr)) = provider_obj.get_mut("models") {
                                    for model in arr.iter_mut() {
                                        if let Some(mobj) = model.as_object_mut() {
                                            if !mobj.contains_key("input") {
                                                mobj.insert("input".into(), vision_input.clone());
                                                changed = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if changed {
        let bak = super::openclaw_dir().join("openclaw.json.bak");
        let _ = fs::copy(&path, &bak);
        let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
        fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))?;
    }

    Ok(changed)
}

/// 检查 ClawPanel 自身是否有新版本（GitHub → Gitee 自动降级）
#[tauri::command]
pub async fn check_panel_update() -> Result<Value, String> {
    let client =
        crate::commands::build_http_client(std::time::Duration::from_secs(8), Some("ClawPanel"))
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    // 先尝试 GitHub，失败后降级 Gitee
    let sources = [
        (
            "https://api.github.com/repos/qingchencloud/clawpanel/releases/latest",
            "https://github.com/qingchencloud/clawpanel/releases",
            "github",
        ),
        (
            "https://gitee.com/api/v5/repos/QtCodeCreators/clawpanel/releases/latest",
            "https://gitee.com/QtCodeCreators/clawpanel/releases",
            "gitee",
        ),
    ];

    let mut last_err = String::new();
    for (api_url, releases_url, source) in &sources {
        match client.get(*api_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let json: Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("解析响应失败: {e}"))?;

                let tag = json
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches('v')
                    .to_string();

                if tag.is_empty() {
                    last_err = format!("{source}: 未找到版本号");
                    continue;
                }

                let mut result = serde_json::Map::new();
                result.insert("latest".into(), Value::String(tag));
                result.insert(
                    "url".into(),
                    json.get("html_url")
                        .cloned()
                        .unwrap_or(Value::String(releases_url.to_string())),
                );
                result.insert("source".into(), Value::String(source.to_string()));
                result.insert(
                    "downloadUrl".into(),
                    Value::String("https://claw.qt.cool".into()),
                );
                return Ok(Value::Object(result));
            }
            Ok(resp) => {
                last_err = format!("{source}: HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = format!("{source}: {e}");
            }
        }
    }

    Err(last_err)
}

// === 面板配置 (clawpanel.json) ===

/// 获取当前生效的 OpenClaw 配置目录路径
#[tauri::command]
pub fn get_openclaw_dir() -> Result<Value, String> {
    let resolved = super::openclaw_dir();
    let is_custom = super::read_panel_config_value()
        .and_then(|v| v.get("openclawDir")?.as_str().map(String::from))
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let config_exists = resolved.join("openclaw.json").exists();
    Ok(json!({
        "path": resolved.to_string_lossy(),
        "isCustom": is_custom,
        "configExists": config_exists,
    }))
}

#[tauri::command]
pub fn read_panel_config() -> Result<Value, String> {
    let path = super::panel_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析失败: {e}"))
}

#[tauri::command]
pub fn write_panel_config(config: Value) -> Result<(), String> {
    let path = super::panel_config_path();
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))
}

/// 重启应用（用于设置变更后自动重启）
#[tauri::command]
pub async fn relaunch_app(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取可执行文件路径失败: {e}"))?;
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("重启失败: {e}"))?;
    // 短暂延迟后退出当前进程
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    app.exit(0);
    Ok(())
}

/// 测试代理连通性：通过配置的代理访问指定 URL，返回状态码和耗时
#[tauri::command]
pub async fn test_proxy(url: Option<String>) -> Result<Value, String> {
    let proxy_url = crate::commands::configured_proxy_url()
        .ok_or("未配置代理地址，请先在面板设置中保存代理地址")?;

    let target = url.unwrap_or_else(|| "https://registry.npmjs.org/-/ping".to_string());

    let client =
        crate::commands::build_http_client(std::time::Duration::from_secs(10), Some("ClawPanel"))
            .map_err(|e| format!("创建代理客户端失败: {e}"))?;

    let start = std::time::Instant::now();
    let resp = client.get(&target).send().await.map_err(|e| {
        let elapsed = start.elapsed().as_millis();
        format!("代理连接失败 ({elapsed}ms): {e}")
    })?;

    let elapsed = start.elapsed().as_millis();
    let status = resp.status().as_u16();

    Ok(json!({
        "ok": status < 500,
        "status": status,
        "elapsed_ms": elapsed,
        "proxy": proxy_url,
        "target": target,
    }))
}

#[tauri::command]
pub fn get_npm_registry() -> Result<String, String> {
    Ok(get_configured_registry())
}

#[tauri::command]
pub fn set_npm_registry(registry: String) -> Result<(), String> {
    let path = super::openclaw_dir().join("npm-registry.txt");
    fs::write(&path, registry.trim()).map_err(|e| format!("保存失败: {e}"))
}

/// 检测 Git 是否已安装
#[tauri::command]
pub fn check_git() -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
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

/// 尝试自动安装 Git（Windows: winget; macOS: xcode-select; Linux: apt/yum）
#[tauri::command]
pub async fn auto_install_git(app: tauri::AppHandle) -> Result<String, String> {
    use std::process::Stdio;
    use tauri::Emitter;

    let _ = app.emit("upgrade-log", "正在尝试自动安装 Git...");

    #[cfg(target_os = "windows")]
    {
        use std::io::{BufRead, BufReader};
        // 尝试 winget
        let _ = app.emit("upgrade-log", "尝试使用 winget 安装 Git...");
        let mut child = Command::new("winget")
            .args([
                "install",
                "--id",
                "Git.Git",
                "-e",
                "--source",
                "winget",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .creation_flags(0x08000000)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("winget 不可用，请手动安装 Git: {e}"))?;

        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        let app2 = app.clone();
        let handle = std::thread::spawn(move || {
            if let Some(pipe) = stderr {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = app2.emit("upgrade-log", &line);
                }
            }
        });
        if let Some(pipe) = stdout {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app.emit("upgrade-log", &line);
            }
        }
        let _ = handle.join();
        let status = child
            .wait()
            .map_err(|e| format!("等待 winget 完成失败: {e}"))?;
        if status.success() {
            let _ = app.emit("upgrade-log", "Git 安装成功！");
            return Ok("Git 已通过 winget 安装".to_string());
        }
        Err("winget 安装 Git 失败，请手动下载安装: https://git-scm.com/downloads".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app.emit("upgrade-log", "尝试通过 xcode-select 安装 Git...");
        let mut child = Command::new("xcode-select")
            .arg("--install")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("xcode-select 不可用: {e}"))?;
        let status = child.wait().map_err(|e| format!("等待安装完成失败: {e}"))?;
        if status.success() {
            let _ = app.emit("upgrade-log", "Git 安装已触发，请在弹出的窗口中确认安装。");
            return Ok("已触发 xcode-select 安装，请在弹窗中确认".to_string());
        }
        Err(
            "xcode-select 安装失败，请手动安装 Xcode Command Line Tools 或 brew install git"
                .to_string(),
        )
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::{BufRead, BufReader};
        // 检测包管理器
        let pkg_mgr = if Command::new("apt-get")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            "apt"
        } else if Command::new("yum")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            "yum"
        } else if Command::new("dnf")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            "dnf"
        } else if Command::new("pacman")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            "pacman"
        } else {
            return Err(
                "未找到包管理器，请手动安装 Git: sudo apt install git 或 sudo yum install git"
                    .to_string(),
            );
        };

        let (cmd_name, args): (&str, Vec<&str>) = match pkg_mgr {
            "apt" => ("sudo", vec!["apt-get", "install", "-y", "git"]),
            "yum" => ("sudo", vec!["yum", "install", "-y", "git"]),
            "dnf" => ("sudo", vec!["dnf", "install", "-y", "git"]),
            "pacman" => ("sudo", vec!["pacman", "-S", "--noconfirm", "git"]),
            _ => return Err("不支持的包管理器".to_string()),
        };

        let _ = app.emit(
            "upgrade-log",
            format!("执行: {} {}", cmd_name, args.join(" ")),
        );
        let mut child = Command::new(cmd_name)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("安装命令执行失败: {e}"))?;

        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        let app2 = app.clone();
        let handle = std::thread::spawn(move || {
            if let Some(pipe) = stderr {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = app2.emit("upgrade-log", &line);
                }
            }
        });
        if let Some(pipe) = stdout {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app.emit("upgrade-log", &line);
            }
        }
        let _ = handle.join();
        let status = child.wait().map_err(|e| format!("等待安装完成失败: {e}"))?;
        if status.success() {
            let _ = app.emit("upgrade-log", "Git 安装成功！");
            return Ok("Git 已安装".to_string());
        }
        Err("Git 安装失败，请手动执行: sudo apt install git".to_string())
    }
}

/// 配置 Git 使用 HTTPS 替代 SSH，解决国内用户 SSH 不通的问题
#[tauri::command]
pub fn configure_git_https() -> Result<String, String> {
    let success = configure_git_https_rules();
    if success > 0 {
        Ok(format!(
            "已配置 Git 使用 HTTPS（{success}/{} 条规则）",
            GIT_HTTPS_REWRITES.len()
        ))
    } else {
        Err("Git 未安装或配置失败".to_string())
    }
}

/// 刷新 enhanced_path 缓存，使新设置的 Node.js 路径立即生效
#[tauri::command]
pub fn invalidate_path_cache() -> Result<(), String> {
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();
    Ok(())
}
