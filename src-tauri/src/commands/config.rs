use crate::utils::openclaw_command;
/// 配置读写命令
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
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

fn find_panel_policy_entry<'a>(
    policy: &'a VersionPolicy,
    current_version: &str,
) -> Option<&'a VersionPolicyEntry> {
    if let Some(entry) = policy.panels.get(current_version) {
        return Some(entry);
    }

    let current_parts = parse_version(current_version);
    if current_parts.len() < 2 {
        return None;
    }

    policy
        .panels
        .iter()
        .filter_map(|(version, entry)| {
            let parts = parse_version(version);
            if parts.len() < 2 {
                return None;
            }
            if parts[0] != current_parts[0] || parts[1] != current_parts[1] {
                return None;
            }
            if parts > current_parts {
                return None;
            }
            Some((parts, entry))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, entry)| entry)
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse().ok())
        .collect()
}

fn parse_node_version_triplet(value: &str) -> Option<[u32; 3]> {
    let parts = parse_version(value);
    if parts.is_empty() {
        return None;
    }
    Some([
        *parts.first().unwrap_or(&0),
        *parts.get(1).unwrap_or(&0),
        *parts.get(2).unwrap_or(&0),
    ])
}

fn cmp_version_triplet(left: [u32; 3], right: [u32; 3]) -> std::cmp::Ordering {
    left.cmp(&right)
}

fn node_version_satisfies_clause(version: [u32; 3], clause: &str) -> bool {
    let clause = clause.trim();
    if clause.is_empty() || clause == "*" {
        return true;
    }

    if let Some(raw) = clause.strip_prefix(">=") {
        return parse_node_version_triplet(raw)
            .map(|min| cmp_version_triplet(version, min).is_ge())
            .unwrap_or(false);
    }
    if let Some(raw) = clause.strip_prefix("<=") {
        return parse_node_version_triplet(raw)
            .map(|max| cmp_version_triplet(version, max).is_le())
            .unwrap_or(false);
    }
    if let Some(raw) = clause.strip_prefix('>') {
        return parse_node_version_triplet(raw)
            .map(|min| cmp_version_triplet(version, min).is_gt())
            .unwrap_or(false);
    }
    if let Some(raw) = clause.strip_prefix('<') {
        return parse_node_version_triplet(raw)
            .map(|max| cmp_version_triplet(version, max).is_lt())
            .unwrap_or(false);
    }
    if let Some(raw) = clause.strip_prefix('^') {
        let Some(min) = parse_node_version_triplet(raw) else {
            return false;
        };
        let max = [min[0].saturating_add(1), 0, 0];
        return cmp_version_triplet(version, min).is_ge()
            && cmp_version_triplet(version, max).is_lt();
    }
    parse_node_version_triplet(clause)
        .map(|target| version == target)
        .unwrap_or(false)
}

fn node_version_satisfies_requirement(version: &str, requirement: &str) -> bool {
    let Some(version) = parse_node_version_triplet(version) else {
        return false;
    };
    let requirement = requirement.trim();
    if requirement.is_empty() {
        return true;
    }
    requirement.split("||").any(|range| {
        range
            .split_whitespace()
            .all(|clause| node_version_satisfies_clause(version, clause))
    })
}

fn read_package_json_field(path: &std::path::Path, pointer: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()?
        .pointer(pointer)?
        .as_str()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

const OPENCLAW_NODE_22_19_VERSION_FLOOR: &str = "2026.6.5";
const OPENCLAW_NODE_22_19_REQUIREMENT: &str = ">=22.19.0";
const OPENCLAW_NODE_7_1_VERSION_FLOOR: &str = "2026.7.1";
const OPENCLAW_NODE_7_1_REQUIREMENT: &str = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";

fn fallback_openclaw_node_requirement(version: &str) -> Option<&'static str> {
    let version = parse_version(&base_version(version));
    if version >= parse_version(OPENCLAW_NODE_7_1_VERSION_FLOOR) {
        return Some(OPENCLAW_NODE_7_1_REQUIREMENT);
    }
    if version >= parse_version(OPENCLAW_NODE_22_19_VERSION_FLOOR) {
        return Some(OPENCLAW_NODE_22_19_REQUIREMENT);
    }
    None
}

fn cli_source_prefers_zh_package(cli_source: &str) -> bool {
    matches!(cli_source, "npm-zh" | "standalone" | "portable")
}

fn find_openclaw_package_json(cli_path: &std::path::Path) -> Option<PathBuf> {
    let dir = cli_path.parent()?;
    let cli_source = crate::utils::classify_cli_source(&cli_path.to_string_lossy());
    let pkg_names: &[&str] = if cli_source_prefers_zh_package(&cli_source) {
        &["@qingchencloud/openclaw-zh", "openclaw"]
    } else {
        &["openclaw", "@qingchencloud/openclaw-zh"]
    };

    let mut current = Some(dir);
    while let Some(candidate_dir) = current {
        let own_pkg = candidate_dir.join("package.json");
        if let Some(name) = read_package_json_field(&own_pkg, "/name") {
            if name == "openclaw" || name == "@qingchencloud/openclaw-zh" {
                return Some(own_pkg);
            }
        }
        current = candidate_dir.parent();
    }

    for base in [Some(dir), dir.parent()].into_iter().flatten() {
        for pkg_name in pkg_names {
            let pkg = base
                .join("node_modules")
                .join(pkg_name)
                .join("package.json");
            if pkg.is_file() {
                return Some(pkg);
            }
        }
    }
    None
}

pub(crate) fn openclaw_node_requirement() -> Option<String> {
    let cli_path = crate::utils::resolve_openclaw_cli_path()?;
    let cli_path_ref = std::path::Path::new(&cli_path);
    let pkg_json = find_openclaw_package_json(cli_path_ref);
    if let Some(pkg_json) = pkg_json.as_ref() {
        if let Some(requirement) = read_package_json_field(pkg_json, "/engines/node")
            .filter(|requirement| !requirement.trim().is_empty())
        {
            return Some(requirement);
        }
    }
    let installed_version = pkg_json
        .as_ref()
        .and_then(|pkg| read_package_json_field(pkg, "/version"))
        .or_else(|| read_version_from_installation(cli_path_ref));
    installed_version
        .as_deref()
        .and_then(fallback_openclaw_node_requirement)
        .map(str::to_string)
}

fn standalone_bundled_node_bin(cli_path: &str) -> Option<PathBuf> {
    let dir = std::path::Path::new(cli_path).parent()?;
    #[cfg(target_os = "windows")]
    let node_bin = dir.join("node.exe");
    #[cfg(not(target_os = "windows"))]
    let node_bin = dir.join("node");
    node_bin.is_file().then_some(node_bin)
}

fn node_version_from_bin(node_bin: &std::path::Path) -> Option<String> {
    let mut cmd = Command::new(node_bin);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

fn populate_node_detection_result(
    result: &mut serde_json::Map<String, Value>,
    version: String,
    path: String,
    detected_from: String,
) {
    let required_version = openclaw_node_requirement();
    let compatible = required_version
        .as_deref()
        .map(|req| node_version_satisfies_requirement(&version, req))
        .unwrap_or(true);
    result.insert("installed".into(), Value::Bool(true));
    result.insert("version".into(), Value::String(version));
    result.insert("path".into(), Value::String(path));
    result.insert("detectedFrom".into(), Value::String(detected_from));
    result.insert("compatible".into(), Value::Bool(compatible));
    result.insert(
        "requiredVersion".into(),
        required_version.map(Value::String).unwrap_or(Value::Null),
    );
}

pub(crate) fn ensure_node_runtime_compatible() -> Result<(), String> {
    let node = check_node()?;
    let installed = node
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !installed {
        return Err("Node.js 未安装或未检测到，请先安装 Node.js 后重新检测".into());
    }
    let compatible = node
        .get("compatible")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if compatible {
        return Ok(());
    }
    let version = node
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let requirement = node
        .get("requiredVersion")
        .and_then(Value::as_str)
        .unwrap_or("当前 OpenClaw 要求的版本");
    let path = node.get("path").and_then(Value::as_str).unwrap_or("");
    Err(format!(
        "Node.js 版本过低：当前检测到 {version}，当前 OpenClaw 要求 {requirement}。请升级 Node.js 后重新检测。检测路径：{path}"
    ))
}

fn ensure_target_node_runtime_compatible_for_npm(version: &str) -> Result<(), String> {
    let Some(requirement) = fallback_openclaw_node_requirement(version) else {
        return Ok(());
    };
    let enhanced = super::enhanced_path();
    let node_path = find_node_path(&enhanced).ok_or_else(|| {
        format!(
            "无法通过 npm 安装 OpenClaw {version}：未检测到系统 Node.js。目标版本要求 {requirement}，请先安装兼容版本，或选择自带 Node.js 的 standalone 安装。"
        )
    })?;
    let current = node_version_from_bin(std::path::Path::new(&node_path))
        .ok_or_else(|| format!("无法读取系统 Node.js 版本：{node_path}"))?;
    if !node_version_satisfies_requirement(&current, requirement) {
        return Err(format!(
            "无法通过 npm 安装 OpenClaw {version}：当前 Node.js {current}，目标版本要求 {requirement}。请先升级 Node.js，或选择自带 Node.js 的 standalone 安装。"
        ));
    }
    Ok(())
}

/// 提取基础版本号（去掉 -zh.x / -nightly.xxx 等后缀，只保留主版本数字部分）
/// "2026.3.13-zh.1" → "2026.3.13", "2026.3.13" → "2026.3.13"
fn base_version(v: &str) -> String {
    // 在第一个 '-' 处截断
    let base = v.split('-').next().unwrap_or(v);
    base.to_string()
}

fn has_version_suffix(v: &str) -> bool {
    v.contains('-')
}

/// 判断 CLI 报告的版本是否与推荐版匹配（考虑汉化版 -zh.x 后缀差异）
fn versions_match(cli_version: &str, recommended: &str) -> bool {
    if cli_version == recommended {
        return true;
    }
    // CLI 报告 "2026.3.13"，推荐版 "2026.3.13-zh.1" → 基础版本相同即视为匹配
    if base_version(cli_version) != base_version(recommended) {
        return false;
    }
    if has_version_suffix(cli_version) {
        return false;
    }
    true
}

/// 判断推荐版是否真的比当前版本更新（忽略 -zh.x 后缀）
fn recommended_is_newer(recommended: &str, current: &str) -> bool {
    let r = parse_version(&base_version(recommended));
    let c = parse_version(&base_version(current));
    if r != c {
        return r > c;
    }
    if has_version_suffix(recommended) && has_version_suffix(current) {
        return parse_version(recommended) > parse_version(current);
    }
    false
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

// 生产路径仅 Windows（zip 解压）调用；Unix 走 tar。test 门控保留跨平台单元测试
#[cfg(any(target_os = "windows", test))]
fn promote_nested_standalone_dir(
    install_dir: &std::path::Path,
    node_bin: &str,
) -> Result<(), String> {
    let nested = install_dir.join("openclaw");
    if !(nested.exists() && nested.join(node_bin).exists()) {
        return Ok(());
    }

    for entry in std::fs::read_dir(&nested)
        .map_err(|e| format!("读取目录 {} 失败: {e}", nested.display()))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let dest = install_dir.join(entry.file_name());
        if dest.exists() {
            let meta = std::fs::metadata(&dest)
                .map_err(|e| format!("读取旧文件 {} 失败: {e}", dest.display()))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&dest)
                    .map_err(|e| format!("删除旧目录 {} 失败: {e}", dest.display()))?;
            } else {
                std::fs::remove_file(&dest)
                    .map_err(|e| format!("删除旧文件 {} 失败: {e}", dest.display()))?;
            }
        }
        std::fs::rename(entry.path(), &dest)
            .map_err(|e| format!("移动 {} 失败: {e}", dest.display()))?;
    }
    std::fs::remove_dir_all(&nested)
        .map_err(|e| format!("删除临时目录 {} 失败: {e}", nested.display()))?;
    Ok(())
}

/// standalone 安装目录
pub(crate) fn standalone_install_dir() -> Option<PathBuf> {
    standalone_install_dir_impl(crate::commands::portable::portable_context())
}

/// 实际逻辑拆出以便单测（portable context 是进程级 OnceLock，测试中无法控制）
fn standalone_install_dir_impl(
    portable: Option<&crate::commands::portable::PortableContext>,
) -> Option<PathBuf> {
    // 便携模式：standalone 安装/升级一律落 U 盘 engines/openclaw，不碰本机目录
    if let Some(ctx) = portable {
        return Some(ctx.engines_openclaw_dir.clone());
    }
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
    let panel_entry = find_panel_policy_entry(&policy, panel_version());
    match source {
        "official" => panel_entry
            .and_then(|entry| entry.official.recommended.clone())
            .or(policy.default.official.recommended),
        _ => panel_entry
            .and_then(|entry| entry.chinese.recommended.clone())
            .or(policy.default.chinese.recommended),
    }
}

/// 获取用户配置的 git 可执行文件路径，回退到 "git"
fn configured_git_path() -> Option<String> {
    super::read_panel_config_value()
        .and_then(|v| v.get("gitPath")?.as_str().map(String::from))
        .map(|custom| custom.trim().to_string())
        .filter(|custom| !custom.is_empty())
}

/// 获取用户配置的 git 可执行文件路径，回退到 "git"
pub fn git_executable() -> String {
    configured_git_path().unwrap_or_else(|| "git".into())
}

fn configure_git_https_rules() -> usize {
    let git = git_executable();
    // Collect unique target prefixes to unset old rules
    let targets: std::collections::HashSet<&str> =
        GIT_HTTPS_REWRITES.iter().map(|(t, _)| *t).collect();
    for target in &targets {
        let key = format!("url.{target}.insteadOf");
        let mut unset = Command::new(&git);
        unset.args(["config", "--global", "--unset-all", &key]);
        #[cfg(target_os = "windows")]
        unset.creation_flags(0x08000000);
        let _ = unset.output();
    }

    let mut success = 0;
    for (target, from) in GIT_HTTPS_REWRITES {
        let key = format!("url.{target}.insteadOf");
        let mut cmd = Command::new(&git);
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
    if let Some(custom_git) = configured_git_path() {
        let git_path = PathBuf::from(&custom_git);
        if let Some(parent) = git_path.parent() {
            let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
                .map(|value| std::env::split_paths(&value).collect())
                .unwrap_or_default();
            if !paths.iter().any(|p| p == parent) {
                paths.insert(0, parent.to_path_buf());
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                cmd.env("PATH", joined);
            }
        }
        cmd.env("GIT", &custom_git);
    }
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

/// 创建使用配置源的 npm Command（不带提权，用于 npm list 等只读操作）
/// Windows 上 npm 是 npm.cmd，需要通过 cmd /c 调用，并隐藏窗口
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
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("npm");
        cmd.args(["--registry", &registry]);
        cmd.env("PATH", super::enhanced_path());
        crate::commands::apply_proxy_env(&mut cmd);
        cmd
    }
}

/// Linux: 检测 npm 全局目录是否在用户 home 下（nvm/fnm/volta 等不需要提权）
#[cfg(target_os = "linux")]
fn npm_prefix_is_user_writable() -> bool {
    if nix_is_root() {
        return true;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    if let Ok(o) = Command::new("npm")
        .args(["config", "get", "prefix"])
        .env("PATH", super::enhanced_path())
        .output()
    {
        if o.status.success() {
            let prefix = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !prefix.is_empty() && prefix.starts_with(&home) {
                return true;
            }
        }
    }
    false
}

/// Linux: 收集需要透传给提权子进程的环境变量
#[cfg(target_os = "linux")]
fn collect_elevated_env_args() -> Vec<String> {
    let mut env_args = vec![format!("PATH={}", super::enhanced_path())];
    if let Ok(home) = std::env::var("HOME") {
        env_args.push(format!("HOME={home}"));
    }
    if let Some(proxy) = crate::commands::configured_proxy_url() {
        env_args.push(format!("HTTP_PROXY={proxy}"));
        env_args.push(format!("HTTPS_PROXY={proxy}"));
        env_args.push(format!("http_proxy={proxy}"));
        env_args.push(format!("https_proxy={proxy}"));
        env_args.push("NO_PROXY=localhost,127.0.0.1,::1".to_string());
        env_args.push("no_proxy=localhost,127.0.0.1,::1".to_string());
    }
    env_args
}

/// 创建需要全局写入权限的 npm Command（用于 install -g / uninstall -g）
/// Linux 非 root 用户：先检测 npm prefix 是否在用户 home 下（nvm/fnm/volta），
/// 不需要提权则直接调用；否则优先使用 pkexec（图形密码对话框），
/// 降级到 sudo（不再使用 -E，改用 env 显式传递变量）。
fn npm_command_elevated() -> Command {
    #[cfg(not(target_os = "linux"))]
    {
        npm_command()
    }
    #[cfg(target_os = "linux")]
    {
        if nix_is_root() || npm_prefix_is_user_writable() {
            return npm_command();
        }
        let registry = get_configured_registry();
        let env_args = collect_elevated_env_args();
        // 优先 pkexec：图形密码对话框，适合桌面 GUI 应用
        let has_pkexec = Command::new("which")
            .arg("pkexec")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let mut cmd = if has_pkexec {
            let mut c = Command::new("pkexec");
            c.arg("/usr/bin/env");
            for ea in &env_args {
                c.arg(ea);
            }
            c.args(["npm", "--registry", &registry]);
            c
        } else {
            // 降级到 sudo：不再用 -E（sudo-rs 不支持），通过 env 显式传递
            let mut c = Command::new("sudo");
            c.arg("--non-interactive");
            c.arg("/usr/bin/env");
            for ea in &env_args {
                c.arg(ea);
            }
            c.args(["npm", "--registry", &registry]);
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
    /// 带超时执行命令（spawn + try_wait），防止任何子进程无限阻塞
    fn run_with_timeout(
        mut child: std::process::Child,
        timeout_secs: u64,
    ) -> Option<std::process::Output> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stdout = child
                        .stdout
                        .take()
                        .map(|mut s| {
                            let mut buf = Vec::new();
                            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
                            buf
                        })
                        .unwrap_or_default();
                    return Some(std::process::Output {
                        status,
                        stdout,
                        stderr: Vec::new(),
                    });
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(_) => return None,
            }
        }
    }

    // 1. 先通过 CLI 正常停止 Gateway（10s 超时）
    if let Ok(child) = openclaw_command()
        .args(["gateway", "stop"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        run_with_timeout(child, 10);
    }

    // 2. 停止 Gateway 进程，释放 openclaw 相关文件锁
    #[cfg(target_os = "windows")]
    {
        // 杀死所有运行 openclaw gateway 的 node.exe 进程（通过命令行匹配）
        // 使用 PowerShell Get-CimInstance（兼容 Windows 11，wmic 已废弃）（10s 超时）
        if let Ok(child) = Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"CommandLine like '%openclaw%gateway%'\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Some(output) = run_with_timeout(child, 10) {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if let Ok(_pid) = line.trim().parse::<u32>() {
                        let _ = Command::new("taskkill").args(["/F", "/PID", line.trim()]).output();
                    }
                }
            }
        }

        // 同时杀死 standalone 目录下的 node.exe 进程（每个目录 10s 超时）
        for sa_dir in all_standalone_dirs() {
            if sa_dir.exists() {
                let dir_lower = sa_dir
                    .to_string_lossy()
                    .to_lowercase()
                    .replace('\\', "\\\\");
                let ps_script = format!(
                    "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.ToLower().Contains('{}') }} | Select-Object -ExpandProperty Id",
                    dir_lower
                );
                if let Ok(child) = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &ps_script])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    if let Some(output) = run_with_timeout(child, 10) {
                        let text = String::from_utf8_lossy(&output.stdout);
                        for line in text.lines() {
                            if let Ok(_pid) = line.trim().parse::<u32>() {
                                let _ = Command::new("taskkill")
                                    .args(["/F", "/PID", line.trim()])
                                    .output();
                            }
                        }
                    }
                }
            }
        }

        // 等文件锁释放（Node.js 进程退出需要时间）
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    #[cfg(target_os = "macos")]
    {
        let uid = get_uid().unwrap_or(501);
        if let Ok(child) = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/ai.openclaw.gateway")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            run_with_timeout(child, 10);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(child) = Command::new("pkill")
            .args(["-f", "openclaw.*gateway"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            run_with_timeout(child, 10);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    // 3. 清理 npm 全局 bin 目录下的 openclaw 残留文件（Windows EEXIST 根因）
    #[cfg(target_os = "windows")]
    {
        if let Some(npm_bin) = npm_global_bin_dir() {
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
            // JSON 解析失败，尝试自动修复
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

fn validate_openclaw_model_candidate(config: &Value) -> Result<(), String> {
    let Some(models) = config.get("models") else {
        return Ok(());
    };
    let models = models
        .as_object()
        .ok_or_else(|| "OpenClaw models 必须是对象".to_string())?;
    let Some(providers) = models.get("providers") else {
        return Ok(());
    };
    let providers = providers
        .as_object()
        .ok_or_else(|| "OpenClaw models.providers 必须是对象".to_string())?;
    for (provider_id, provider) in providers {
        let provider = provider
            .as_object()
            .ok_or_else(|| format!("模型服务商 {provider_id} 配置必须是对象"))?;
        if let Some(api) = provider.get("api") {
            let api = api
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("模型服务商 {provider_id} 的 api 必须是非空字符串"))?;
            if api == "openai-codex-responses" {
                return Err(format!(
                    "模型服务商 {provider_id} 使用了已移除的 api；请改用 openai-chatgpt-responses"
                ));
            }
        }
        if let Some(base_url) = provider.get("baseUrl") {
            let base_url = base_url
                .as_str()
                .ok_or_else(|| format!("模型服务商 {provider_id} 的 baseUrl 必须是字符串"))?;
            if !(base_url.is_empty()
                || base_url.starts_with("https://")
                || base_url.starts_with("http://"))
            {
                return Err(format!(
                    "模型服务商 {provider_id} 的 baseUrl 必须使用 http 或 https"
                ));
            }
        }
        let Some(entries) = provider.get("models") else {
            continue;
        };
        let entries = entries
            .as_array()
            .ok_or_else(|| format!("模型服务商 {provider_id} 的 models 必须是数组"))?;
        for (index, model) in entries.iter().enumerate() {
            let model = model.as_object().ok_or_else(|| {
                format!(
                    "模型服务商 {provider_id} 的第 {} 个模型必须是对象",
                    index + 1
                )
            })?;
            for key in ["id", "name"] {
                if model
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    return Err(format!(
                        "模型服务商 {provider_id} 的第 {} 个模型缺少 {key}",
                        index + 1
                    ));
                }
            }
            if model.get("api").and_then(Value::as_str) == Some("openai-codex-responses") {
                return Err(format!(
                    "模型服务商 {provider_id} 的模型 {} 使用了已移除的 api",
                    model.get("id").and_then(Value::as_str).unwrap_or("")
                ));
            }
            for key in ["contextWindow", "contextTokens", "maxTokens"] {
                if let Some(value) = model.get(key) {
                    let valid = value.as_u64().is_some_and(|number| number > 0);
                    if !valid {
                        return Err(format!(
                            "模型服务商 {provider_id} 的模型 {} 字段 {key} 必须是正整数",
                            model.get("id").and_then(Value::as_str).unwrap_or("")
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn write_verified_json_with_backup(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&content).map_err(|e| format!("候选配置校验失败: {e}"))?;
    if &parsed != value {
        return Err("候选配置序列化后内容不一致".into());
    }

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp = parent.join(format!(
        ".openclaw.json.{}.{suffix}.tmp",
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("创建候选配置失败: {e}"))?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入候选配置失败: {error}"));
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("设置候选配置权限失败: {error}"));
        }
    }

    let backup = path.with_extension("json.bak");
    let had_existing = path.exists();
    if had_existing {
        fs::copy(path, &backup).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("备份当前配置失败: {e}")
        })?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&backup)
            .and_then(|file| file.sync_all())
            .map_err(|e| {
                let _ = fs::remove_file(&tmp);
                format!("同步当前配置备份失败: {e}")
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                format!("设置配置备份权限失败: {e}")
            })?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    let replace_result = fs::rename(&tmp, path);

    #[cfg(target_os = "windows")]
    let replace_result = {
        let swap = parent.join(format!(
            ".openclaw.json.{}.{suffix}.old",
            std::process::id()
        ));
        let _ = fs::remove_file(&swap);
        if had_existing {
            fs::rename(path, &swap).and_then(|_| {
                fs::rename(&tmp, path).inspect_err(|_| {
                    let _ = fs::rename(&swap, path);
                })
            })
        } else {
            fs::rename(&tmp, path)
        }
        .map(|_| {
            let _ = fs::remove_file(&swap);
        })
    };

    if let Err(error) = replace_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换 OpenClaw 配置失败，原配置已保留: {error}"));
    }

    let readback = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    if readback.as_ref() != Some(value) {
        if had_existing && backup.exists() {
            let _ = fs::copy(&backup, path);
        } else {
            let _ = fs::remove_file(path);
        }
        return Err("OpenClaw 配置写入后回读不一致，已恢复原配置".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn model_env_values_for_config(config: &Value) -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Some(env) = config.get("env").and_then(|v| v.as_object()) {
        for (key, value) in env {
            if !is_valid_env_key(key) {
                continue;
            }
            if let Some(s) = value.as_str() {
                values.insert(key.clone(), s.to_string());
            } else if value.is_number() || value.is_boolean() {
                values.insert(key.clone(), value.to_string());
            }
        }
    }
    let env_path = super::openclaw_dir().join(".env");
    if let Ok(content) = fs::read_to_string(env_path) {
        for line in content.lines() {
            if let Some((key, value)) = parse_dotenv_line(line) {
                values.entry(key).or_insert(value);
            }
        }
    }
    values
}

fn validate_model_provider_env_refs(
    config: &Value,
    previous_config: Option<&Value>,
) -> Result<(), String> {
    let values = model_env_values_for_config(config);
    let Some(providers) = config
        .get("models")
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_object())
    else {
        return Ok(());
    };

    for (provider_name, provider) in providers {
        let Some(api_key) = provider.get("apiKey").and_then(|v| v.as_str()) else {
            continue;
        };
        let previous_api_key = previous_config
            .and_then(|config| config.get("models"))
            .and_then(|models| models.get("providers"))
            .and_then(|providers| providers.get(provider_name))
            .and_then(|provider| provider.get("apiKey"))
            .and_then(Value::as_str);
        if previous_api_key == Some(api_key) {
            continue;
        }
        let Some(env_key) = model_api_key_env_ref(api_key)? else {
            continue;
        };
        let configured = values
            .get(&env_key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        let process_env = std::env::var(&env_key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !configured && !process_env {
            return Err(format!(
                "模型服务商 \"{provider_name}\" 的 API Key 引用了缺失的环境变量 \"{env_key}\"。请先在 OpenClaw env、~/.openclaw/.env 或当前进程环境中补齐，或删除该服务商后再保存。"
            ));
        }
    }

    Ok(())
}

/// 供其他模块复用：触发 Gateway 重载
pub async fn do_reload_gateway(app: &tauri::AppHandle) -> Result<String, String> {
    reload_gateway_internal(Some(app)).await
}

#[tauri::command]
pub fn write_openclaw_config(config: Value) -> Result<(), String> {
    let path = super::openclaw_dir().join("openclaw.json");

    // Issue #127 修复：先读取现有配置，合并后写入
    // 这样可以保留用户手动添加的合法字段（如 browser.profiles）
    // 即使这些字段不在前端传入的配置对象中
    let existing_config = fs::read_to_string(&path)
        .ok()
        .and_then(|c| parse_json_relaxed(&c));

    // 合并配置：现有配置 + 新配置
    // 策略：遍历现有配置，保留所有非 UI 字段
    // 然后将新配置的值覆盖到合并结果中
    let merged = if let Some(existing) = existing_config.as_ref() {
        merge_configs_preserving_fields(existing, &config)
    } else {
        config.clone()
    };

    // 清理 UI 专属字段，避免 CLI schema 校验失败
    let cleaned = strip_ui_fields(merged);
    validate_model_provider_env_refs(&cleaned, existing_config.as_ref())?;
    validate_openclaw_model_candidate(&cleaned)?;

    // 候选文件写入、备份、替换并回读验证。失败时保持或恢复最后有效配置。
    write_verified_json_with_backup(&path, &cleaned)?;

    // 同步 provider 配置到所有 agent 的 models.json（运行时注册表）
    // 必须使用与磁盘一致的 merged+strip 结果，而非前端原始 payload：
    // 否则 partial 写入时 merge 保留了其它 provider，但 sync 按 payload 会把
    // agents/*/agent/models.json 里多出的 provider 整棵删掉，造成与 openclaw.json 不一致。
    sync_providers_to_agent_models(&cleaned);

    Ok(())
}

const CALIBRATION_RESET_INHERIT_KEYS: &[&str] = &[
    "agents", "auth", "bindings", "browser", "channels", "commands", "env", "hooks", "memory",
    "models", "plugins", "secrets", "security", "session", "skills", "tui", "wizard",
];

fn calibration_required_origins() -> Vec<String> {
    vec![
        "tauri://localhost".into(),
        "https://tauri.localhost".into(),
        "http://tauri.localhost".into(),
        "http://localhost".into(),
        "http://localhost:1420".into(),
        "http://127.0.0.1:1420".into(),
        "http://localhost:18777".into(),
        "http://127.0.0.1:18777".into(),
    ]
}

fn calibration_last_touched_version() -> String {
    recommended_version_for("chinese").unwrap_or_else(|| "2026.1.1".to_string())
}

fn calibration_default_workspace() -> String {
    super::openclaw_dir()
        .join("workspace")
        .to_string_lossy()
        .to_string()
}

fn generate_calibration_token() -> String {
    format!(
        "cp-{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    )
}

fn decode_json_bytes(raw: &[u8]) -> String {
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&raw[3..]).into_owned()
    } else {
        String::from_utf8_lossy(raw).into_owned()
    }
}

fn parse_json_relaxed(content: &str) -> Option<Value> {
    serde_json::from_str(content)
        .ok()
        .or_else(|| serde_json::from_str(&fix_common_json_errors(content)).ok())
}

fn read_json_file_relaxed(path: &PathBuf) -> Option<Value> {
    let raw = fs::read(path).ok()?;
    let content = decode_json_bytes(&raw);
    parse_json_relaxed(&content)
}

fn calibration_has_usable_gateway_auth(auth: &Value) -> bool {
    let mode = auth.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    match mode {
        "token" => auth
            .get("token")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false),
        "password" => auth
            .get("password")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false),
        _ => false,
    }
}

fn calibration_richness_score(config: &Value) -> usize {
    let mut score = 0;
    if config
        .pointer("/models/providers")
        .and_then(|v| v.as_object())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 4;
    }
    if config.pointer("/agents/defaults").is_some() {
        score += 2;
    }
    if config
        .pointer("/agents/list")
        .and_then(|v| v.as_array())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 3;
    }
    if config
        .get("channels")
        .and_then(|v| v.as_object())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 2;
    }
    if config
        .get("bindings")
        .and_then(|v| v.as_array())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 2;
    }
    if config
        .pointer("/plugins/entries")
        .and_then(|v| v.as_object())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || config
            .pointer("/plugins/installs")
            .and_then(|v| v.as_object())
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    {
        score += 2;
    }
    if config
        .get("env")
        .and_then(|v| v.as_object())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 1;
    }
    if config
        .pointer("/gateway/auth")
        .map(calibration_has_usable_gateway_auth)
        .unwrap_or(false)
    {
        score += 3;
    }
    if config
        .pointer("/gateway/controlUi/allowedOrigins")
        .and_then(|v| v.as_array())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        score += 1;
    }
    score
}

fn select_calibration_source(current: Option<Value>, backup: Option<Value>) -> (String, Value) {
    match (current, backup) {
        (Some(current), Some(backup)) => {
            let current_score = calibration_richness_score(&current);
            if current_score == 0 {
                let backup_score = calibration_richness_score(&backup);
                if backup_score > 0 {
                    return ("backup".into(), backup);
                }
            }
            ("current".into(), current)
        }
        (Some(current), None) => ("current".into(), current),
        (None, Some(backup)) => ("backup".into(), backup),
        (None, None) => ("empty".into(), json!({})),
    }
}

fn build_calibration_baseline() -> Value {
    json!({
        "$schema": "https://openclaw.ai/schema/config.json",
        "meta": {
            "lastTouchedVersion": calibration_last_touched_version(),
        },
        "models": { "providers": {} },
        "agents": {
            "defaults": {
                "workspace": calibration_default_workspace(),
            },
            "list": [],
        },
        "bindings": [],
        "channels": {},
        "commands": {
            "native": "auto",
            "nativeSkills": "auto",
            "ownerDisplay": "raw",
            "restart": true,
        },
        "plugins": {},
        "session": { "dmScope": "per-channel-peer" },
        "skills": { "entries": {} },
        "tools": {
            "profile": "full",
            "sessions": { "visibility": "all" },
        },
        "gateway": {
            "mode": "local",
            "bind": "loopback",
            "port": 18789,
            "auth": {
                "mode": "token",
                "token": generate_calibration_token(),
            },
            "controlUi": {
                "enabled": true,
                "allowedOrigins": calibration_required_origins(),
                "allowInsecureAuth": true,
            },
        },
    })
}

fn apply_reset_inheritance(mut config: Value, seed: &Value) -> (Value, Vec<String>) {
    let mut inherited = Vec::new();
    let Some(root) = config.as_object_mut() else {
        return (config, inherited);
    };

    for key in CALIBRATION_RESET_INHERIT_KEYS {
        if let Some(value) = seed.get(*key) {
            root.insert((*key).to_string(), value.clone());
            inherited.push((*key).to_string());
        }
    }

    if let Some(seed_tools) = seed.get("tools") {
        let baseline_tools = root.get("tools").cloned().unwrap_or_else(|| json!({}));
        root.insert(
            "tools".into(),
            merge_configs_preserving_fields(&baseline_tools, seed_tools),
        );
        inherited.push("tools".into());
    }

    (config, inherited)
}

fn normalize_calibrated_config(mut config: Value) -> Value {
    let required_origins = calibration_required_origins();
    let last_touched_version = calibration_last_touched_version();
    let default_workspace = calibration_default_workspace();

    let Some(root) = config.as_object_mut() else {
        return build_calibration_baseline();
    };

    root.insert(
        "$schema".into(),
        Value::String("https://openclaw.ai/schema/config.json".into()),
    );

    let meta = root.entry("meta").or_insert_with(|| json!({}));
    if !meta.is_object() {
        *meta = json!({});
    }
    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert(
            "lastTouchedVersion".into(),
            Value::String(last_touched_version),
        );
        meta_obj.insert(
            "lastTouchedAt".into(),
            Value::String(chrono::Utc::now().to_rfc3339()),
        );
    }

    let models = root.entry("models").or_insert_with(|| json!({}));
    if !models.is_object() {
        *models = json!({});
    }
    if let Some(models_obj) = models.as_object_mut() {
        let providers = models_obj.entry("providers").or_insert_with(|| json!({}));
        if !providers.is_object() {
            *providers = json!({});
        }
    }

    let agents = root.entry("agents").or_insert_with(|| json!({}));
    if !agents.is_object() {
        *agents = json!({});
    }
    if let Some(agents_obj) = agents.as_object_mut() {
        let defaults = agents_obj.entry("defaults").or_insert_with(|| json!({}));
        if !defaults.is_object() {
            *defaults = json!({});
        }
        if let Some(defaults_obj) = defaults.as_object_mut() {
            if !defaults_obj
                .get("workspace")
                .and_then(|v| v.as_str())
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
            {
                defaults_obj.insert("workspace".into(), Value::String(default_workspace));
            }
        }
        let list = agents_obj.entry("list").or_insert_with(|| json!([]));
        if !list.is_array() {
            *list = json!([]);
        }
    }

    let bindings = root.entry("bindings").or_insert_with(|| json!([]));
    if !bindings.is_array() {
        *bindings = json!([]);
    }

    let channels = root.entry("channels").or_insert_with(|| json!({}));
    if !channels.is_object() {
        *channels = json!({});
    }

    let plugins = root.entry("plugins").or_insert_with(|| json!({}));
    if !plugins.is_object() {
        *plugins = json!({});
    }

    let tools = root.entry("tools").or_insert_with(|| json!({}));
    if !tools.is_object() {
        *tools = json!({});
    }
    if let Some(tools_obj) = tools.as_object_mut() {
        if !tools_obj
            .get("profile")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            tools_obj.insert("profile".into(), Value::String("full".into()));
        }
        let sessions = tools_obj.entry("sessions").or_insert_with(|| json!({}));
        if !sessions.is_object() {
            *sessions = json!({});
        }
        if let Some(sessions_obj) = sessions.as_object_mut() {
            if !sessions_obj
                .get("visibility")
                .and_then(|v| v.as_str())
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
            {
                sessions_obj.insert("visibility".into(), Value::String("all".into()));
            }
        }
    }

    let gateway = root.entry("gateway").or_insert_with(|| json!({}));
    if !gateway.is_object() {
        *gateway = json!({});
    }
    if let Some(gateway_obj) = gateway.as_object_mut() {
        if !gateway_obj
            .get("mode")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            gateway_obj.insert("mode".into(), Value::String("local".into()));
        }

        let port_valid = gateway_obj
            .get("port")
            .and_then(|v| v.as_u64())
            .map(|port| (1..=65535).contains(&port))
            .unwrap_or(false);
        if !port_valid {
            gateway_obj.insert("port".into(), json!(18789));
        }

        if !gateway_obj
            .get("bind")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            gateway_obj.insert("bind".into(), Value::String("loopback".into()));
        }

        let auth_valid = gateway_obj
            .get("auth")
            .map(calibration_has_usable_gateway_auth)
            .unwrap_or(false);
        if !auth_valid {
            gateway_obj.insert(
                "auth".into(),
                json!({
                    "mode": "token",
                    "token": generate_calibration_token(),
                }),
            );
        }

        let control_ui = gateway_obj.entry("controlUi").or_insert_with(|| json!({}));
        if !control_ui.is_object() {
            *control_ui = json!({});
        }
        if let Some(control_ui_obj) = control_ui.as_object_mut() {
            let existing: Vec<String> = control_ui_obj
                .get("allowedOrigins")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|value| value.as_str().map(|value| value.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let mut merged = existing;
            for origin in required_origins {
                if !merged.iter().any(|existing| existing == &origin) {
                    merged.push(origin);
                }
            }
            control_ui_obj.insert("allowedOrigins".into(), json!(merged));
            control_ui_obj.insert("enabled".into(), Value::Bool(true));
            control_ui_obj.insert("allowInsecureAuth".into(), Value::Bool(true));
        }
    }

    config
}

#[tauri::command]
pub fn calibrate_openclaw_config(mode: String) -> Result<Value, String> {
    let normalized_mode = match mode.trim() {
        "inherit" => "inherit",
        "reset" | "reinitialize" => "reset",
        _ => return Err("mode 必须是 inherit 或 reset".into()),
    };

    let dir = super::openclaw_dir();
    let config_path = dir.join("openclaw.json");
    let backup_path = dir.join("openclaw.json.bak");
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let mut warnings: Vec<String> = vec![];
    let pre_backup = if config_path.exists() {
        match create_backup() {
            Ok(result) => result
                .get("name")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
            Err(err) => {
                warnings.push(format!("修复前备份失败: {err}"));
                None
            }
        }
    } else {
        None
    };

    let current = read_json_file_relaxed(&config_path);
    let backup = read_json_file_relaxed(&backup_path);
    let (source, seed) = select_calibration_source(current, backup);

    let (calibrated, mut inherited_keys) = if normalized_mode == "inherit" {
        let inherited = seed
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_else(Vec::new);
        (
            merge_configs_preserving_fields(&build_calibration_baseline(), &seed),
            inherited,
        )
    } else {
        apply_reset_inheritance(build_calibration_baseline(), &seed)
    };

    inherited_keys.sort();
    inherited_keys.dedup();

    let calibrated = strip_ui_fields(normalize_calibrated_config(calibrated));
    let json = serde_json::to_string_pretty(&calibrated)
        .map_err(|e| format!("序列化校准配置失败: {e}"))?;

    fs::write(&config_path, &json).map_err(|e| format!("写入校准配置失败: {e}"))?;
    fs::write(&backup_path, &json).map_err(|e| format!("写入配置备份失败: {e}"))?;

    sync_providers_to_agent_models(&calibrated);

    Ok(json!({
        "mode": normalized_mode,
        "source": source,
        "backup": pre_backup,
        "inheritedKeys": inherited_keys,
        "warnings": warnings,
        "message": if normalized_mode == "inherit" {
            "配置已按继承模式校准"
        } else {
            "配置已按完全初始化修复模式校准"
        }
    }))
}

/// 合并两个配置对象，保留现有配置中的合法字段
///
/// Issue #127: 修复配置合并时丢失 browser.* 等合法字段的问题
///
/// 策略：对 Object 类型字段递归合并（新值覆盖旧值，旧值中新配置没有的字段保留）。
/// 数组与标量显式替换，避免把模型列表、Agent 列表等顺序集合错误拼接。
/// 这样用户通过 CLI / 手动编辑添加的自定义子字段不会被前端的部分配置所覆盖掉。
///
/// 清理的字段：
/// - UI 专属字段（通过 strip_ui_fields 处理）
fn merge_configs_preserving_fields(existing: &Value, new: &Value) -> Value {
    merge_configs_preserving_fields_at(existing, new, "")
}

fn merge_configs_preserving_fields_at(existing: &Value, new: &Value, path: &str) -> Value {
    use serde_json::Value;

    match (existing, new) {
        (Value::Object(existing_obj), Value::Object(new_obj)) => {
            let mut merged = existing_obj.clone();

            for (key, new_value) in new_obj {
                // models.providers.<id> = null 是显式删除墓碑；省略键仍表示保留。
                if path == "models.providers" && new_value.is_null() {
                    merged.remove(key);
                    continue;
                }
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if let Some(existing_value) = existing_obj.get(key) {
                    if let (Value::Object(existing_sub), Value::Object(new_sub)) =
                        (existing_value, new_value)
                    {
                        // 两边都是对象：递归合并（新值覆盖，旧值保留未覆盖的 key）
                        merged.insert(
                            key.clone(),
                            merge_configs_preserving_fields_at(
                                &Value::Object(existing_sub.clone()),
                                &Value::Object(new_sub.clone()),
                                &child_path,
                            ),
                        );
                    } else {
                        // 类型不同、数组或标量，直接使用新值
                        merged.insert(key.clone(), new_value.clone());
                    }
                } else {
                    // 现有配置没有此 key，使用新值
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
    "profiles",
];

/// 已知需要保留的合法 OpenClaw 配置字段（用于诊断报告）
/// 这些字段虽然不在标准列表中，但不应被警告为未知字段
/// 注意：这些字段在 `merge_configs_preserving_fields` 中会被特殊处理
#[allow(dead_code)]
const KNOWN_LEGAL_FIELDS: &[&str] = &["browser", "agents", "gateway", "logging", "mcp"];

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
        Ok(v) => {
            // BOM 被剥离过，静默写回干净文件
            if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                let _ = fs::write(&path, &content);
            }
            v
        }
        Err(e) => {
            // JSON 解析失败，尝试自动修复
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
                            "发现 agents.profiles 字段，上游 schema 未定义此字段，ClawPanel 会自动清理"
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
/// 包括：同步 baseUrl/apiKey/api + 清理已删除的 models
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
                            // 注意：不删除 agent models.json 中用户手动添加的模型。
                            // 只同步连接信息（baseUrl/apiKey/api），保留用户通过 CLI
                            // 或手动编辑添加的自定义模型。
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
            "qqbot",
            "profiles",
        ] {
            if obj.contains_key(*key) {
                return true;
            }
        }
        if obj
            .get("agents")
            .and_then(|v| v.as_object())
            .map(|agents| agents.contains_key("profiles"))
            .unwrap_or(false)
        {
            return true;
        }
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
            "profiles",
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
                                if let Some(api) = provider_obj.get("api").and_then(Value::as_str) {
                                    provider_obj.insert(
                                        "api".into(),
                                        Value::String(normalize_model_api_type(api)),
                                    );
                                }
                                if let Some(Value::Array(arr)) = provider_obj.get_mut("models") {
                                    for model in arr.iter_mut() {
                                        if let Some(id) = model
                                            .as_str()
                                            .map(str::trim)
                                            .filter(|id| !id.is_empty())
                                            .map(str::to_string)
                                        {
                                            *model = json!({ "id": id, "name": id });
                                        }
                                        if let Some(mobj) = model.as_object_mut() {
                                            if let Some(api) =
                                                mobj.get("api").and_then(Value::as_str)
                                            {
                                                mobj.insert(
                                                    "api".into(),
                                                    Value::String(normalize_model_api_type(api)),
                                                );
                                            }
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
                agents_obj.remove("profiles");
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

        if let Some(npm_bin) = npm_global_bin_dir() {
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
            if sa_dir.join("openclaw").exists() || sa_dir.join("VERSION").exists() {
                if let Some(ver) = read_version_from_installation(&sa_dir.join("openclaw")) {
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

    let mut status_cmd = crate::utils::openclaw_command_async();
    status_cmd.args(["status", "--json"]);
    if let Ok(Ok(output)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), status_cmd.output()).await
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(ver) = crate::commands::skills::extract_json_pub(&stdout)
                .and_then(|v| v.get("runtimeVersion")?.as_str().map(String::from))
            {
                return Some(ver);
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

fn detect_standalone_source_from_dir(dir: &std::path::Path) -> Option<String> {
    let version_file = dir.join("VERSION");
    if let Ok(content) = std::fs::read_to_string(&version_file) {
        let mut edition = String::new();
        let mut package = String::new();
        for line in content.lines() {
            if let Some(value) = line.strip_prefix("edition=") {
                edition = value.trim().to_ascii_lowercase();
            } else if let Some(value) = line.strip_prefix("package=") {
                package = value.trim().to_ascii_lowercase();
            }
        }
        if package.contains("openclaw-zh") || package.contains("@qingchencloud") {
            return Some("chinese".into());
        }
        if package == "openclaw" {
            return Some("official".into());
        }
        if matches!(edition.as_str(), "zh" | "zh-cn" | "chinese" | "cn") {
            return Some("chinese".into());
        }
        if matches!(edition.as_str(), "en" | "official") {
            return Some("official".into());
        }
    }
    if dir
        .join("node_modules")
        .join("@qingchencloud")
        .join("openclaw-zh")
        .join("package.json")
        .exists()
    {
        return Some("chinese".into());
    }
    if dir
        .join("node_modules")
        .join("openclaw")
        .join("package.json")
        .exists()
    {
        return Some("official".into());
    }
    None
}

fn detect_standalone_source_from_cli_path(cli_path: &std::path::Path) -> Option<String> {
    cli_path
        .parent()
        .and_then(detect_standalone_source_from_dir)
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
            if source == "standalone" || source == "portable" {
                return detect_standalone_source_from_cli_path(&resolved)
                    .unwrap_or_else(|| "chinese".into());
            }
            if source == "npm-zh" {
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
                return detect_standalone_source_from_dir(&sa_dir)
                    .unwrap_or_else(|| "chinese".into());
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
            if source == "standalone" || source == "portable" {
                return detect_standalone_source_from_cli_path(std::path::Path::new(&cli_path))
                    .unwrap_or_else(|| "chinese".into());
            }
            if source == "npm-zh" {
                return "chinese".into();
            }
            // npm-official / npm-global / unknown: 路径不含包名，读 .cmd 内容判断
            if let Some(shim_source) = detect_source_from_cmd_shim(std::path::Path::new(&cli_path))
            {
                return shim_source;
            }
        }
        // 无活跃 CLI 时的兜底：仅检查 npm 全局目录中实际存在的 shim
        if let Some(npm_bin) = npm_global_bin_dir() {
            let shim = npm_bin.join("openclaw.cmd");
            if let Some(s) = detect_source_from_cmd_shim(&shim) {
                return s;
            }
        }
        for sa_dir in all_standalone_dirs() {
            if sa_dir.join("openclaw.cmd").exists() || sa_dir.join("VERSION").exists() {
                return detect_standalone_source_from_dir(&sa_dir)
                    .unwrap_or_else(|| "chinese".into());
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
            if source == "standalone" || source == "portable" {
                return detect_standalone_source_from_cli_path(&resolved)
                    .unwrap_or_else(|| "chinese".into());
            }
            if source == "npm-zh" {
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
                return detect_standalone_source_from_dir(&sa_dir)
                    .unwrap_or_else(|| "chinese".into());
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

fn detect_active_cli_install_mode() -> &'static str {
    let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() else {
        return "unknown";
    };
    let resolved = std::fs::canonicalize(&cli_path)
        .ok()
        .unwrap_or_else(|| PathBuf::from(&cli_path));
    let source = crate::utils::classify_cli_source(&resolved.to_string_lossy());
    if source == "portable" {
        "portable"
    } else if source == "standalone" {
        "standalone"
    } else if source == "npm-zh" || source == "npm-official" || source == "npm-global" {
        "npm"
    } else {
        "unknown"
    }
}

/// auto 模式下 standalone 安装失败后是否允许降级到 npm 全局安装。
/// 便携模式一律禁止（npm -g 会写宿主机，违背便携原则）；
/// 当前已是 standalone / portable 模式的安装也禁止（避免静默切换安装方式）。
fn should_fallback_standalone_to_npm(
    current_install_mode: &str,
    method: &str,
    portable_mode: bool,
) -> bool {
    if portable_mode {
        return false;
    }
    method == "auto" && current_install_mode != "standalone" && current_install_mode != "portable"
}

fn standalone_install_version(
    requested_version: Option<&str>,
    recommended_version: Option<&str>,
    _method: &str,
    _portable_mode: bool,
) -> String {
    if let Some(version) = requested_version {
        return version.to_string();
    }

    recommended_version.unwrap_or("latest").to_string()
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

fn scan_cli_identity(cli_path: &std::path::Path) -> String {
    #[cfg(target_os = "windows")]
    let identity_path = {
        let mut identity_path = cli_path.to_path_buf();
        let file_name = cli_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            file_name.as_str(),
            "openclaw" | "openclaw.exe" | "openclaw.ps1"
        ) {
            let cmd_path = cli_path.with_file_name("openclaw.cmd");
            if cmd_path.exists() {
                identity_path = cmd_path;
            }
        }
        identity_path
    };

    #[cfg(not(target_os = "windows"))]
    let identity_path = cli_path.to_path_buf();

    identity_path
        .canonicalize()
        .unwrap_or(identity_path)
        .to_string_lossy()
        .to_lowercase()
}

/// 扫描系统中所有可检测到的 OpenClaw 安装
fn scan_all_installations(
    active_path: &Option<String>,
) -> Vec<crate::models::types::OpenClawInstallation> {
    use crate::models::types::OpenClawInstallation;
    let mut results: Vec<OpenClawInstallation> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let active_identity = active_path
        .as_ref()
        .map(|path| scan_cli_identity(std::path::Path::new(path)));

    let mut try_add = |path: std::path::PathBuf| {
        if !path.exists() {
            return;
        }
        if crate::utils::is_rejected_cli_path(&path.to_string_lossy()) {
            return;
        }
        #[cfg(target_os = "windows")]
        if !crate::utils::is_windows_launchable_openclaw_path(&path) {
            return;
        }
        let identity = scan_cli_identity(&path);
        if seen.contains(&identity) {
            return;
        }
        seen.insert(identity.clone());
        let path_str = path.to_string_lossy().to_string();
        let source = crate::utils::classify_cli_source(&path_str);
        let version = read_version_from_installation(&path);
        let is_active = active_identity
            .as_ref()
            .map(|active| active == &identity)
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
        {
            try_add(sa_dir.join("openclaw.cmd"));
            try_add(sa_dir.join("openclaw.exe"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            try_add(sa_dir.join("openclaw"));
        }
    }

    for configured in super::openclaw_search_paths() {
        if let Some(resolved) = resolve_openclaw_cli_input_path(&configured) {
            try_add(resolved);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let appdata_npm = std::path::PathBuf::from(&appdata).join("npm");
            try_add(appdata_npm.join("openclaw.cmd"));
            try_add(appdata_npm.join("openclaw.exe"));
            try_add(appdata_npm.join("openclaw.bat"));
            try_add(appdata_npm.join("openclaw.js"));
        }
        if let Some(prefix) = super::windows_npm_global_prefix() {
            let prefix_path = std::path::PathBuf::from(prefix);
            try_add(prefix_path.join("openclaw.cmd"));
            try_add(prefix_path.join("openclaw.exe"));
            try_add(prefix_path.join("openclaw.bat"));
            try_add(prefix_path.join("openclaw.js"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let localappdata_path = std::path::PathBuf::from(&localappdata);
            try_add(
                localappdata_path
                    .join("Programs")
                    .join("OpenClaw")
                    .join("openclaw.exe"),
            );
            try_add(localappdata_path.join("OpenClaw").join("openclaw.cmd"));
            try_add(localappdata_path.join("OpenClaw").join("openclaw.exe"));
            try_add(
                localappdata_path
                    .join("Programs")
                    .join("nodejs")
                    .join("openclaw.cmd"),
            );
            try_add(
                localappdata_path
                    .join("Programs")
                    .join("nodejs")
                    .join("openclaw.exe"),
            );
            try_add(
                localappdata_path
                    .join("Programs")
                    .join("nodejs")
                    .join("node_modules")
                    .join("@qingchencloud")
                    .join("openclaw-zh")
                    .join("bin")
                    .join("openclaw.js"),
            );
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            try_add(
                std::path::PathBuf::from(&program_files)
                    .join("nodejs")
                    .join("openclaw.cmd"),
            );
            try_add(
                std::path::PathBuf::from(&program_files)
                    .join("OpenClaw")
                    .join("openclaw.cmd"),
            );
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            try_add(
                std::path::PathBuf::from(&program_files_x86)
                    .join("nodejs")
                    .join("openclaw.cmd"),
            );
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            try_add(
                std::path::PathBuf::from(&profile)
                    .join(".openclaw-bin")
                    .join("openclaw.cmd"),
            );
        }
        for drive in ["C", "D", "E", "F", "G"] {
            try_add(std::path::PathBuf::from(format!(
                r"{}:\OpenClaw\openclaw.cmd",
                drive
            )));
            try_add(std::path::PathBuf::from(format!(
                r"{}:\AI\OpenClaw\openclaw.cmd",
                drive
            )));
        }
        let mut where_cmd = Command::new("where");
        where_cmd.arg("openclaw");
        where_cmd.creation_flags(0x08000000);
        if let Ok(output) = where_cmd.output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    try_add(std::path::PathBuf::from(trimmed));
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            try_add(home.join(".npm-global").join("bin").join("openclaw"));
            try_add(home.join(".local").join("bin").join("openclaw"));
            try_add(
                home.join(".nvm")
                    .join("current")
                    .join("bin")
                    .join("openclaw"),
            );
            try_add(home.join(".volta").join("bin").join("openclaw"));
            try_add(
                home.join(".fnm")
                    .join("current")
                    .join("bin")
                    .join("openclaw"),
            );
            try_add(home.join("bin").join("openclaw"));
        }
        try_add(std::path::PathBuf::from("/opt/openclaw/openclaw"));
        try_add(std::path::PathBuf::from("/opt/homebrew/bin/openclaw"));
        try_add(std::path::PathBuf::from("/usr/local/bin/openclaw"));
        try_add(std::path::PathBuf::from("/usr/bin/openclaw"));
        try_add(std::path::PathBuf::from("/snap/bin/openclaw"));
        if let Ok(output) = Command::new("which").args(["-a", "openclaw"]).output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    try_add(std::path::PathBuf::from(trimmed));
                }
            }
        }
    }

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
            try_add(base.join("openclaw.exe"));
            try_add(base.join("openclaw"));
            try_add(
                base.join("node_modules")
                    .join("@qingchencloud")
                    .join("openclaw-zh")
                    .join("bin")
                    .join("openclaw.js"),
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            try_add(base.join("openclaw"));
        }
    }

    results.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.path.cmp(&b.path))
    });

    results
}

pub(crate) fn resolve_openclaw_cli_input_path(
    cli_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    if cli_path.as_os_str().is_empty() {
        return None;
    }
    let input = cli_path.to_path_buf();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if input.is_dir() {
        #[cfg(target_os = "windows")]
        {
            candidates.push(input.join("openclaw.cmd"));
            candidates.push(input.join("openclaw.exe"));
            candidates.push(input.join("openclaw.bat"));
            candidates.push(input.join("openclaw.js"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(input.join("openclaw"));
        }
    } else {
        #[cfg(target_os = "windows")]
        {
            if let Some(resolved) = crate::utils::canonicalize_windows_openclaw_cli_path(&input) {
                return Some(resolved);
            }
        }
        candidates.push(input);
    }

    candidates.into_iter().find(|candidate| {
        candidate.exists() && !crate::utils::is_rejected_cli_path(&candidate.to_string_lossy()) && {
            #[cfg(target_os = "windows")]
            {
                crate::utils::is_windows_launchable_openclaw_path(candidate)
            }
            #[cfg(not(target_os = "windows"))]
            {
                true
            }
        }
    })
}

pub(crate) fn resolve_openclaw_cli_input(cli_path: &str) -> Option<std::path::PathBuf> {
    let raw = cli_path.trim();
    if raw.is_empty() {
        return None;
    }
    resolve_openclaw_cli_input_path(std::path::Path::new(raw))
}

#[tauri::command]
pub fn scan_openclaw_paths() -> Result<Vec<crate::models::types::OpenClawInstallation>, String> {
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();
    let active_path = crate::utils::resolve_openclaw_cli_path();
    Ok(scan_all_installations(&active_path))
}

#[tauri::command]
pub fn check_openclaw_at_path(cli_path: String) -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    if let Some(resolved) = resolve_openclaw_cli_input(&cli_path) {
        let path_str = resolved.to_string_lossy().to_string();
        result.insert("installed".into(), Value::Bool(true));
        result.insert("path".into(), Value::String(path_str.clone()));
        result.insert(
            "source".into(),
            Value::String(crate::utils::classify_cli_source(&path_str)),
        );
        if let Some(version) = read_version_from_installation(&resolved) {
            result.insert("version".into(), Value::String(version));
        } else {
            result.insert("version".into(), Value::Null);
        }
    } else {
        result.insert("installed".into(), Value::Bool(false));
        result.insert("path".into(), Value::Null);
        result.insert("source".into(), Value::Null);
        result.insert("version".into(), Value::Null);
    }
    Ok(Value::Object(result))
}

fn find_git_path() -> Option<String> {
    // #Compat-4: 必须把子进程 PATH 替换成 enhanced_path，否则继承的是 Tauri 启动时快照，
    // 用户新装的 git 不在快照里，`where git` / `which git` 就找不到。对齐 find_node_path 的做法。
    let enhanced = super::enhanced_path();
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("where");
        cmd.arg("git");
        cmd.creation_flags(0x08000000);
        cmd.env("PATH", &enhanced);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Some(first_line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = first_line.trim().to_string();
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("which");
        cmd.arg("git");
        cmd.env("PATH", &enhanced);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() && std::path::Path::new(&path).exists() {
                    return Some(path);
                }
            }
        }
    }

    None
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
        // CLI 本体位于包目录中时（如 npm 全局安装：nvm、Homebrew 等），
        // 直接读取同目录的 package.json（即该包自身的版本文件）
        let own_pkg = dir.join("package.json");
        if let Ok(content) = std::fs::read_to_string(&own_pkg) {
            if let Some(ver) = serde_json::from_str::<serde_json::Value>(&content)
                .ok()
                .and_then(|v| v.get("version")?.as_str().map(String::from))
            {
                return Some(ver);
            }
        }
        // 根据 CLI 路径判断来源，决定 package.json 检查顺序
        // 避免残留的另一来源包被优先读取
        let cli_source = crate::utils::classify_cli_source(&cli_path.to_string_lossy());
        let pkg_names: &[&str] = if cli_source_prefers_zh_package(&cli_source) {
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
        super::windows_npm_global_prefix()
            .map(|prefix| PathBuf::from(prefix).join("node_modules"))
            .or_else(|| {
                std::env::var("APPDATA")
                    .ok()
                    .map(|a| PathBuf::from(a).join("npm").join("node_modules"))
            })
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
        super::windows_npm_global_prefix()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("APPDATA")
                    .ok()
                    .map(|a| PathBuf::from(a).join("npm"))
            })
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

fn npm_openclaw_cli_path() -> Option<PathBuf> {
    let bin_dir = npm_global_bin_dir()?;
    #[cfg(target_os = "windows")]
    {
        for name in [
            "openclaw.cmd",
            "openclaw.exe",
            "openclaw.bat",
            "openclaw.js",
        ] {
            let candidate = bin_dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        Some(bin_dir.join("openclaw.cmd"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(bin_dir.join("openclaw"))
    }
}

fn standalone_work_dir(install_dir: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let name = install_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("openclaw");
    install_dir
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!("{name}.{suffix}"))
}

fn verify_standalone_install(
    staging_dir: &std::path::Path,
    remote_version: &str,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let openclaw_bin = staging_dir.join("openclaw.cmd");
    #[cfg(not(target_os = "windows"))]
    let openclaw_bin = staging_dir.join("openclaw");

    if !openclaw_bin.exists() {
        return Err("standalone 解压后未找到 openclaw 可执行文件".into());
    }
    let verified_version = read_version_from_installation(&openclaw_bin)
        .ok_or_else(|| "standalone 安装后无法读取目标 CLI 版本".to_string())?;
    if !versions_match(&verified_version, remote_version) {
        return Err(format!(
            "standalone 安装校验失败：目标 CLI 版本为 {verified_version}，清单版本为 {remote_version}"
        ));
    }
    verify_standalone_runtime_dependencies(staging_dir)?;
    Ok(verified_version)
}

fn verify_standalone_runtime_dependencies(staging_dir: &std::path::Path) -> Result<(), String> {
    let package_dir = [
        staging_dir
            .join("node_modules")
            .join("@qingchencloud")
            .join("openclaw-zh"),
        staging_dir.join("node_modules").join("openclaw"),
    ]
    .into_iter()
    .find(|dir| dir.join("package.json").exists())
    .ok_or_else(|| "standalone 解压后未找到 OpenClaw 主包".to_string())?;

    let package_json_path = package_dir.join("package.json");
    let package_json: Value = serde_json::from_slice(
        &std::fs::read(&package_json_path)
            .map_err(|e| format!("standalone 主包 package.json 无法读取: {e}"))?,
    )
    .map_err(|e| format!("standalone 主包 package.json 无法解析: {e}"))?;

    let mut missing = package_json
        .get("dependencies")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(dependency, _)| {
            let dependency_path = dependency
                .split('/')
                .filter(|part| !part.is_empty())
                .fold(PathBuf::new(), |path, part| path.join(part));
            let nested = package_dir
                .join("node_modules")
                .join(&dependency_path)
                .join("package.json");
            let hoisted = staging_dir
                .join("node_modules")
                .join(&dependency_path)
                .join("package.json");
            (!nested.exists() && !hoisted.exists()).then(|| dependency.to_string())
        })
        .collect::<Vec<_>>();
    missing.sort();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "standalone 安装校验失败：缺少运行时依赖：{}",
            missing.join(", ")
        ))
    }
}

fn replace_standalone_install(
    staging_dir: &std::path::Path,
    install_dir: &std::path::Path,
    backup_dir: &std::path::Path,
) -> Result<(), String> {
    if backup_dir.exists() {
        std::fs::remove_dir_all(backup_dir).map_err(|e| format!("清理旧升级备份失败: {e}"))?;
    }
    let old_install_moved = if install_dir.exists() {
        std::fs::rename(install_dir, backup_dir)
            .map_err(|e| format!("备份当前 standalone 安装失败: {e}"))?;
        true
    } else {
        false
    };

    if let Err(error) = std::fs::rename(staging_dir, install_dir) {
        if old_install_moved && !install_dir.exists() && backup_dir.exists() {
            let _ = std::fs::rename(backup_dir, install_dir);
        }
        return Err(format!("激活新 standalone 安装失败，已恢复原版本: {error}"));
    }
    if old_install_moved {
        std::fs::remove_dir_all(backup_dir).map_err(|e| format!("清理升级备份失败: {e}"))?;
    }
    Ok(())
}

/// 尝试从 standalone 独立安装包安装 OpenClaw（自带 Node.js，零依赖）
/// 动态查询 latest.json 获取最新版本，下载对应平台的归档并解压
/// 成功返回 Ok(版本号)，失败返回 Err(原因) 供 caller 降级到 R2/npm
async fn try_standalone_install(
    app: &tauri::AppHandle,
    version: &str,
    override_base_url: Option<&str>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
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
    if crate::commands::portable::portable_context().is_some() {
        let _ = app.emit(
            "upgrade-log",
            format!("便携模式：将安装到 U 盘 {}", install_dir.display()),
        );
    }

    // 1. GitHub 固定版本直接解析；只有 latest 或 CDN 路径需要清单。
    let _ = app.emit(
        "upgrade-log",
        "\u{1F4E6} 尝试 standalone 独立安装包（汉化版专属，自带 Node.js 运行时，无需 npm）",
    );
    let client = crate::commands::build_http_client(std::time::Duration::from_secs(10), None)
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let (remote_version, manifest_base_url, archive_prefix): (String, Option<String>, &str) =
        if override_base_url.is_some() && version != "latest" {
            (version.to_string(), None, "openclaw-zh")
        } else {
            let _ = app.emit("upgrade-log", "查询最新版本...");
            let manifest_url = format!("{base_url}/latest.json");
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
            let edition_obj = manifest.get("editions").and_then(|e| e.get("zh"));
            if let Some(ed) = edition_obj {
                let ver = ed
                    .get("version")
                    .and_then(|v| v.as_str())
                    .ok_or("standalone 清单 editions.zh 缺少 version 字段")?;
                let bu = ed
                    .get("base_url")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                (ver.to_string(), bu, "openclaw-zh")
            } else {
                let ver = manifest
                    .get("version")
                    .and_then(|v| v.as_str())
                    .ok_or("standalone 清单缺少 version 字段")?;
                let bu = manifest
                    .get("base_url")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                (ver.to_string(), bu, "openclaw")
            }
        };

    if version != "latest" && !versions_match(&remote_version, version) {
        return Err(format!(
            "standalone 版本 {remote_version} 与请求版本 {version} 不匹配"
        ));
    }

    let default_base = format!("{base_url}/{remote_version}");
    let remote_base = if let Some(override_url) = override_base_url {
        override_url.replace("{version}", &remote_version)
    } else if let Some(manifest_url) = manifest_base_url {
        manifest_url
    } else {
        default_base
    };

    // 2. 构造下载 URL
    let ext = standalone_archive_ext();
    let filename = format!("{archive_prefix}-{remote_version}-{platform}.{ext}");
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

    let actual_sha = {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&archive_path)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut stream = dl_resp.bytes_stream();
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut last_progress: u32 = 15;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入失败: {e}"))?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            if total_bytes > 0 {
                let pct = 15 + ((downloaded as f64 / total_bytes as f64) * 55.0) as u32;
                if pct > last_progress {
                    // 每 5% 输出一次文字进度
                    if pct / 5 > last_progress / 5 {
                        let dl_mb = downloaded as f64 / 1_048_576.0;
                        let total_mb = total_bytes as f64 / 1_048_576.0;
                        let real_pct = (downloaded as f64 / total_bytes as f64 * 100.0) as u32;
                        let _ = app.emit(
                            "upgrade-log",
                            format!("下载中 {real_pct}% ({dl_mb:.0}/{total_mb:.0}MB)"),
                        );
                    }
                    last_progress = pct;
                    let _ = app.emit("upgrade-progress", pct.min(70));
                }
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("刷新文件失败: {e}"))?;
        format!("{:x}", hasher.finalize())
    };

    let _ = app.emit("upgrade-log", "下载完成，正在校验 SHA-256...");
    let checksum_url = format!("{download_url}.sha256");
    let checksum_resp = dl_client
        .get(&checksum_url)
        .send()
        .await
        .map_err(|e| format!("standalone 校验文件下载失败: {e}"))?;
    if !checksum_resp.status().is_success() {
        return Err(format!(
            "standalone 校验文件不可用 (HTTP {})",
            checksum_resp.status()
        ));
    }
    let checksum_text = checksum_resp
        .text()
        .await
        .map_err(|e| format!("standalone 校验文件读取失败: {e}"))?;
    let expected_sha = checksum_text
        .split_whitespace()
        .find(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or("standalone 校验文件格式无效")?;
    if actual_sha != expected_sha {
        return Err(format!(
            "standalone SHA-256 校验失败：expected={expected_sha}, actual={actual_sha}"
        ));
    }
    let _ = app.emit("upgrade-log", "SHA-256 校验通过，解压安装中...");
    let _ = app.emit("upgrade-progress", 72);

    // 4. 解压到同盘 staging，验证通过后再原子切换。
    let staging_dir = standalone_work_dir(&install_dir, "staging");
    let backup_dir = standalone_work_dir(&install_dir, "backup");
    if !install_dir.exists() && backup_dir.exists() {
        std::fs::rename(&backup_dir, &install_dir)
            .map_err(|e| format!("恢复上次 standalone 升级备份失败: {e}"))?;
    }
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|e| format!("清理 staging 目录失败: {e}"))?;
    }
    if backup_dir.exists() {
        std::fs::remove_dir_all(&backup_dir).map_err(|e| format!("清理旧升级备份失败: {e}"))?;
    }
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建 staging 目录失败: {e}"))?;

    // 5. 解压
    #[cfg(target_os = "windows")]
    {
        // Windows: zip 解压
        let archive_file =
            std::fs::File::open(&archive_path).map_err(|e| format!("打开归档失败: {e}"))?;
        let mut zip_archive =
            zip::ZipArchive::new(archive_file).map_err(|e| format!("ZIP 解析失败: {e}"))?;
        zip_archive
            .extract(&staging_dir)
            .map_err(|e| format!("ZIP 解压失败: {e}"))?;
        // 归档内可能有 openclaw/ 子目录，需要提升一层
        promote_nested_standalone_dir(&staging_dir, "node.exe")?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Unix: tar.gz 解压
        let status = Command::new("tar")
            .args([
                "-xzf",
                &archive_path.to_string_lossy(),
                "-C",
                &staging_dir.to_string_lossy(),
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

    // 6. 验证 staging 并切换
    let verified_version = verify_standalone_install(&staging_dir, &remote_version)?;
    replace_standalone_install(&staging_dir, &install_dir, &backup_dir)?;

    #[cfg(target_os = "windows")]
    let openclaw_bin = install_dir.join("openclaw.cmd");
    #[cfg(not(target_os = "windows"))]
    let openclaw_bin = install_dir.join("openclaw");

    let _ = app.emit(
        "upgrade-log",
        format!(
            "目标 CLI 验证通过: {} ({verified_version})",
            openclaw_bin.display()
        ),
    );

    // 7. 添加到 PATH（Windows 用户 PATH，Unix 创建 symlink）。
    // 便携模式跳过：不写用户 PATH / 不建系统 symlink，避免在宿主机留下痕迹；
    // 后续 bind_openclaw_cli_path 绑定的是 U 盘 clawpanel.json，解析链可直接命中
    let portable_mode = crate::commands::portable::portable_context().is_some();
    if portable_mode {
        let _ = app.emit(
            "upgrade-log",
            "便携模式：跳过写入用户 PATH / 系统 symlink，仅绑定 U 盘内 CLI",
        );
    }
    #[cfg(target_os = "windows")]
    if !portable_mode {
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
    if !portable_mode {
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

    match bind_openclaw_cli_path(&openclaw_bin) {
        Ok(()) => {
            let _ = app.emit(
                "upgrade-log",
                format!("已切换当前 CLI: {}", openclaw_bin.display()),
            );
        }
        Err(err) => {
            let _ = app.emit("upgrade-log", format!("⚠️ 自动绑定当前 CLI 失败: {err}"));
        }
    }

    Ok(verified_version)
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
        let mut install_cmd = npm_command_elevated();
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
    let current_install_mode = detect_active_cli_install_mode();
    let pkg_name = npm_package_name(&source);
    let requested_version = version.clone();
    let recommended_version = recommended_version_for(&source);
    let portable_mode = crate::commands::portable::portable_context().is_some();
    let ver = requested_version
        .as_deref()
        .or(recommended_version.as_deref())
        .unwrap_or("latest");
    let standalone_ver = standalone_install_version(
        requested_version.as_deref(),
        recommended_version.as_deref(),
        &method,
        portable_mode,
    );
    let pkg = format!("{}@{}", pkg_name, ver);
    let active_cli_before = crate::utils::resolve_openclaw_cli_path();
    let current_version_before = get_local_version().await;
    let installations_before = scan_all_installations(&active_cli_before);
    let _ = app.emit("upgrade-log", "升级前扫描当前 OpenClaw 安装...");
    let _ = app.emit(
        "upgrade-log",
        format!(
            "当前使用: {}{}",
            active_cli_before
                .as_deref()
                .unwrap_or("未检测到 openclaw CLI"),
            current_version_before
                .as_ref()
                .map(|v| format!(" ({v})"))
                .unwrap_or_default()
        ),
    );
    if installations_before.len() > 1 {
        let _ = app.emit(
            "upgrade-log",
            format!(
                "检测到 {} 个 OpenClaw 安装；升级成功后会切换到新版，旧安装不会自动删除。",
                installations_before.len()
            ),
        );
    }

    // ── standalone 安装（auto / standalone-r2 / standalone-github） ──
    let try_standalone = source != "official"
        && (method == "auto" || method == "standalone-r2" || method == "standalone-github");

    if try_standalone {
        let github_release_base =
            "https://github.com/qingchencloud/openclaw-standalone/releases/download/v{version}";

        if method == "standalone-github" {
            // standalone-github 模式：只走 GitHub
            match try_standalone_install(&app, &standalone_ver, Some(github_release_base)).await {
                Ok(installed_ver) => {
                    let _ = app.emit("upgrade-progress", 100);
                    super::refresh_enhanced_path();
                    crate::commands::service::invalidate_cli_detection_cache();
                    let msg = format!("✅ standalone (GitHub) 安装完成，当前版本: {installed_ver}");
                    let _ = app.emit("upgrade-log", &msg);
                    let _ = app.emit(
                        "upgrade-log",
                        "升级已原子切换；如安装失败会自动恢复原版本。",
                    );
                    return Ok(msg);
                }
                Err(reason) => {
                    return Err(format!("standalone 安装失败: {reason}"));
                }
            }
        } else {
            // auto / standalone-r2 模式：R2 CDN → GitHub Releases fallback
            match try_standalone_install(&app, &standalone_ver, None).await {
                Ok(installed_ver) => {
                    let _ = app.emit("upgrade-progress", 100);
                    super::refresh_enhanced_path();
                    crate::commands::service::invalidate_cli_detection_cache();
                    let msg = format!("✅ standalone (CDN) 安装完成，当前版本: {installed_ver}");
                    let _ = app.emit("upgrade-log", &msg);
                    let _ = app.emit(
                        "upgrade-log",
                        "升级已原子切换；如安装失败会自动恢复原版本。",
                    );
                    return Ok(msg);
                }
                Err(cdn_reason) => {
                    let _ = app.emit(
                        "upgrade-log",
                        format!("CDN 下载失败（{cdn_reason}），尝试从 GitHub Releases 下载..."),
                    );
                    let _ = app.emit("upgrade-progress", 5);
                    // Fallback: GitHub Releases
                    match try_standalone_install(&app, &standalone_ver, Some(github_release_base))
                        .await
                    {
                        Ok(installed_ver) => {
                            let _ = app.emit("upgrade-progress", 100);
                            super::refresh_enhanced_path();
                            crate::commands::service::invalidate_cli_detection_cache();
                            let msg = format!(
                                "✅ standalone (GitHub) 安装完成，当前版本: {installed_ver}"
                            );
                            let _ = app.emit("upgrade-log", &msg);
                            let _ = app.emit(
                                "upgrade-log",
                                "升级已原子切换；如安装失败会自动恢复原版本。",
                            );
                            return Ok(msg);
                        }
                        Err(gh_reason) => {
                            if should_fallback_standalone_to_npm(
                                current_install_mode,
                                &method,
                                portable_mode,
                            ) {
                                let _ = app.emit(
                                    "upgrade-log",
                                    format!("standalone 不可用（GitHub: {gh_reason}），降级到 npm 安装..."),
                                );
                                let _ = app.emit("upgrade-progress", 5);
                            } else if method == "auto" && portable_mode {
                                return Err(format!(
                                    "当前处于便携模式，已阻止自动降级到 npm 全局安装（npm -g 会写入本机而非 U 盘）。请检查网络后重试独立包安装。standalone 安装失败: CDN={cdn_reason}, GitHub={gh_reason}"
                                ));
                            } else if method == "auto" {
                                return Err(format!(
                                    "当前 OpenClaw 使用 standalone 独立包模式，已阻止自动降级到 npm 全局安装。请稍后重试独立包升级，或在升级方式中手动选择 npm。standalone 安装失败: CDN={cdn_reason}, GitHub={gh_reason}"
                                ));
                            } else {
                                return Err(format!(
                                    "standalone 安装失败: CDN={cdn_reason}, GitHub={gh_reason}"
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    // ── npm install（兜底或用户明确选择） ──

    ensure_target_node_runtime_compatible_for_npm(ver)?;

    // 切换源时需要卸载旧包，但为避免安装失败导致 CLI 丢失，
    // 先安装新包，成功后再卸载旧包
    let old_pkg = npm_package_name(&current_source);
    let need_uninstall_old = current_source != source && old_pkg != pkg_name;

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
    #[cfg(target_os = "linux")]
    {
        if !nix_is_root() {
            if npm_prefix_is_user_writable() {
                let _ = app.emit("upgrade-log", "npm prefix 在用户目录下，无需提权");
            } else {
                let has_pkexec = Command::new("which")
                    .arg("pkexec")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if has_pkexec {
                    let _ = app.emit(
                        "upgrade-log",
                        "需要管理员权限，将通过 pkexec 弹出认证窗口...",
                    );
                } else {
                    let _ = app.emit(
                        "upgrade-log",
                        "⚠️ 需要管理员权限但 pkexec 不可用，可能需要手动安装",
                    );
                }
            }
        }
    }
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

    let mut install_cmd = npm_command_elevated();
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
            let mut install_cmd2 = npm_command_elevated();
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
    // 清理步骤采用错误隔离：任何清理失败都不影响安装成功的最终结果
    if need_uninstall_old {
        let _ = app.emit("upgrade-log", format!("清理旧版本 ({old_pkg})..."));
        // npm uninstall 加 30s 超时，避免无限卡住
        let uninstall_child = npm_command_elevated()
            .args(["uninstall", "-g", old_pkg])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match uninstall_child {
            Ok(mut child) => {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    match child.try_wait() {
                        Ok(Some(_status)) => break,
                        Ok(None) => {
                            if std::time::Instant::now() >= deadline {
                                let _ = child.kill();
                                let _ = app.emit("upgrade-log", "⚠️ 清理旧版本超时（30s），已跳过");
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                        Err(_) => break,
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("upgrade-log", format!("⚠️ 清理旧版本启动失败: {e}，已跳过"));
            }
        }

        // 清理 standalone 安装目录（不论从 standalone 切走还是切到 standalone，
        // npm 路径已经安装了新 CLI，standalone 残留会干扰源检测）
        for sa_dir in all_standalone_dirs() {
            if sa_dir.exists() {
                let _ = app.emit(
                    "upgrade-log",
                    format!("清理 standalone 残留: {}", sa_dir.display()),
                );

                // Windows: 终止占用该目录的 node.exe 进程
                // 使用 PowerShell Get-Process（兼容 Windows 11，wmic 已废弃）
                #[cfg(target_os = "windows")]
                {
                    let dir_lower = sa_dir
                        .to_string_lossy()
                        .to_lowercase()
                        .replace('\\', "\\\\");
                    let ps_script = format!(
                        "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.ToLower().Contains('{}') }} | Select-Object -ExpandProperty Id",
                        dir_lower
                    );
                    if let Ok(output) = Command::new("powershell")
                        .args(["-NoProfile", "-Command", &ps_script])
                        .output()
                    {
                        let text = String::from_utf8_lossy(&output.stdout);
                        for line in text.lines() {
                            if let Ok(pid) = line.trim().parse::<u32>() {
                                let _ =
                                    app.emit("upgrade-log", format!("终止占用进程 PID {pid}..."));
                                let _ = Command::new("taskkill")
                                    .args(["/F", "/PID", &pid.to_string()])
                                    .output();
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }

                match std::fs::remove_dir_all(&sa_dir) {
                    Ok(()) => {
                        let _ = app.emit("upgrade-log", "standalone 残留已清理 ✓");
                    }
                    Err(_) => {
                        let _ = app.emit("upgrade-log", "文件被占用，等待后重试...");
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if let Err(e) = std::fs::remove_dir_all(&sa_dir) {
                            let _ = app.emit(
                                "upgrade-log",
                                format!(
                                    "⚠️ 清理 standalone 残留失败: {e}（可手动删除 {}）",
                                    sa_dir.display()
                                ),
                            );
                        } else {
                            let _ = app.emit("upgrade-log", "standalone 残留已清理（重试成功）✓");
                        }
                    }
                }
            }
        }
    }

    if need_uninstall_old {
        let _ = app.emit(
            "upgrade-log",
            "正在修复 npm CLI 入口（避免旧包卸载删除 openclaw.cmd）...",
        );
        let mut repair_cmd = npm_command_elevated();
        repair_cmd.args(["install", "-g", &pkg, "--force", "--registry", registry]);
        apply_git_install_env(&mut repair_cmd);
        match repair_cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(o) if o.status.success() => {
                let _ = app.emit("upgrade-log", "npm CLI 入口已确认");
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                return Err(format!(
                    "安装完成但修复 npm CLI 入口失败: {}",
                    stderr.trim()
                ));
            }
            Err(e) => return Err(format!("安装完成但修复 npm CLI 入口失败: {e}")),
        }
    }

    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();

    let npm_cli = npm_openclaw_cli_path()
        .ok_or_else(|| "安装完成但无法确定 npm openclaw CLI 路径".to_string())?;
    let new_ver = read_version_from_installation(&npm_cli)
        .or_else(|| {
            crate::utils::resolve_openclaw_cli_path()
                .and_then(|p| read_version_from_installation(std::path::Path::new(&p)))
        })
        .ok_or_else(|| format!("安装完成但无法读取 OpenClaw 版本: {}", npm_cli.display()))?;
    if ver != "latest" && !versions_match(&new_ver, ver) {
        return Err(format!(
            "安装校验失败：目标 CLI 版本为 {new_ver}，期望版本为 {ver}"
        ));
    }
    bind_openclaw_cli_path(&npm_cli)?;
    let _ = app.emit(
        "upgrade-log",
        format!("已切换当前 CLI: {} ({new_ver})", npm_cli.display()),
    );

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
        // 等待旧 Gateway 进程退出
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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

    // #Compat-4: npm 首次安装场景下，前面 `if need_uninstall_old` 块被跳过，
    // PATH 缓存和 CLI 检测缓存都是装 openclaw 之前的旧快照。必须在这里统一刷新一次，
    // 否则前端 `check_installation`/`get_services_status` 拿到的仍是「CLI 未安装」
    // —— 用户反馈「一键装完日志显示成功，但面板不识别，重启客户端才能用」。
    // 切换源场景前面已刷过，这里重刷无害（几十 ms 扫描开销可接受）。
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();

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

    // 等待进程完全退出（Gateway stop 是异步的，需要等文件锁释放）
    let _ = app.emit("upgrade-log", "等待进程退出...");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // 3. 清理 standalone 安装（所有可能的位置）
    for sa_dir in &all_standalone_dirs() {
        if sa_dir.exists() {
            let _ = app.emit(
                "upgrade-log",
                format!("清理 standalone 安装: {}", sa_dir.display()),
            );

            // Windows: 先尝试终止占用该目录的 node.exe 进程
            // 使用 PowerShell Get-Process（兼容 Windows 11，wmic 已废弃）
            #[cfg(target_os = "windows")]
            {
                let dir_lower = sa_dir
                    .to_string_lossy()
                    .to_lowercase()
                    .replace('\\', "\\\\");
                let ps_script = format!(
                    "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.ToLower().Contains('{}') }} | Select-Object -ExpandProperty Id",
                    dir_lower
                );
                if let Ok(output) = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &ps_script])
                    .output()
                {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        if let Ok(pid) = line.trim().parse::<u32>() {
                            let _ = app.emit("upgrade-log", format!("终止占用进程 PID {pid}..."));
                            let _ = Command::new("taskkill")
                                .args(["/F", "/PID", &pid.to_string()])
                                .output();
                        }
                    }
                }
                // 短暂等待进程退出
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }

            // 尝试删除，失败则重试一次
            match std::fs::remove_dir_all(sa_dir) {
                Ok(()) => {
                    let _ = app.emit("upgrade-log", "standalone 安装已清理 ✓");
                }
                Err(_) => {
                    // 重试：等待后再删一次
                    let _ = app.emit("upgrade-log", "文件被占用，等待后重试...");
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if let Err(e) = std::fs::remove_dir_all(sa_dir) {
                        let _ = app.emit(
                            "upgrade-log",
                            format!(
                                "⚠️ 清理 standalone 失败: {e}（可手动删除 {}）",
                                sa_dir.display()
                            ),
                        );
                    } else {
                        let _ = app.emit("upgrade-log", "standalone 安装已清理（重试成功）✓");
                    }
                }
            }
        }
    }

    // 4. npm uninstall
    let _ = app.emit("upgrade-log", format!("$ npm uninstall -g {pkg}"));
    let _ = app.emit("upgrade-progress", 20);

    let mut child = npm_command_elevated()
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
    let _ = npm_command_elevated()
        .args(["uninstall", "-g", other_pkg])
        .output();
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
    // #Compat-4: 卸载后刷缓存，否则 is_cli_installed（60s TTL）/ enhanced_path
    // 仍是旧快照，UI 会在 60 秒内继续显示「CLI 已安装」或 Gateway 还在运行。
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();
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
    let backup_path = dir.join("openclaw.json.bak");
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

    if backup_path.exists() {
        let backup_content =
            std::fs::read_to_string(&backup_path).map_err(|e| format!("读取配置备份失败: {e}"))?;
        serde_json::from_str::<Value>(&backup_content)
            .map_err(|e| format!("配置备份损坏，无法恢复: {e}"))?;
        std::fs::write(&config_path, backup_content)
            .map_err(|e| format!("恢复配置备份失败: {e}"))?;

        result.insert("created".into(), Value::Bool(false));
        result.insert("restored".into(), Value::Bool(true));
        result.insert(
            "message".into(),
            Value::String("已从 openclaw.json.bak 恢复配置文件".into()),
        );
        return Ok(Value::Object(result));
    }

    let default_config = strip_ui_fields(normalize_calibrated_config(build_calibration_baseline()));

    let content =
        serde_json::to_string_pretty(&default_config).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&config_path, content).map_err(|e| format!("写入失败: {e}"))?;

    result.insert("created".into(), Value::Bool(true));
    result.insert("restored".into(), Value::Bool(false));
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

    // standalone 安装会在 openclaw 启动脚本中优先使用同目录 Node.js。
    // 这里按实际运行时检测，避免被 PATH 中较旧的系统 Node.js 误判拦截。
    // 便携模式下 standalone 包装进 U 盘 engines/openclaw（来源归类为 portable），
    // 同样自带 node.exe，一并识别，避免误报"未安装 Node"
    if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
        if matches!(
            crate::utils::classify_cli_source(&cli_path).as_str(),
            "standalone" | "portable"
        ) {
            if let Some(bundled) = standalone_bundled_node_bin(&cli_path) {
                if let Some(ver) = node_version_from_bin(&bundled) {
                    populate_node_detection_result(
                        &mut result,
                        ver,
                        bundled.to_string_lossy().to_string(),
                        "standalone-bundled".into(),
                    );
                    return Ok(Value::Object(result));
                }
            }
        }
    }

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
                populate_node_detection_result(&mut result, ver, path, detected_from);
            }
            _ => {
                result.insert("installed".into(), Value::Bool(false));
                result.insert("version".into(), Value::Null);
                result.insert("path".into(), Value::Null);
                result.insert("detectedFrom".into(), Value::Null);
                result.insert("compatible".into(), Value::Bool(false));
                result.insert("requiredVersion".into(), Value::Null);
            }
        }
    } else {
        result.insert("installed".into(), Value::Bool(false));
        result.insert("version".into(), Value::Null);
        result.insert("path".into(), Value::Null);
        result.insert("detectedFrom".into(), Value::Null);
        result.insert("compatible".into(), Value::Bool(false));
        result.insert("requiredVersion".into(), Value::Null);
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
        result.insert("compatible".into(), Value::Bool(false));
        result.insert("requiredVersion".into(), Value::Null);
        return Ok(Value::Object(result));
    }

    let mut cmd = Command::new(&node_bin);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let required_version = openclaw_node_requirement();
            let compatible = required_version
                .as_deref()
                .map(|req| node_version_satisfies_requirement(&ver, req))
                .unwrap_or(true);
            result.insert("installed".into(), Value::Bool(true));
            result.insert("version".into(), Value::String(ver));
            result.insert("path".into(), Value::String(node_dir));
            result.insert("compatible".into(), Value::Bool(compatible));
            result.insert(
                "requiredVersion".into(),
                required_version.map(Value::String).unwrap_or(Value::Null),
            );
        }
        _ => {
            result.insert("installed".into(), Value::Bool(false));
            result.insert("version".into(), Value::Null);
            result.insert("compatible".into(), Value::Bool(false));
            result.insert("requiredVersion".into(), Value::Null);
        }
    }
    Ok(Value::Object(result))
}

/// 扫描常见路径，返回所有找到的 Node.js 安装，包含来源说明
#[tauri::command]
pub fn scan_node_paths() -> Result<Value, String> {
    let mut found: Vec<Value> = vec![];
    let home = dirs::home_dir().unwrap_or_default();
    let required_version = openclaw_node_requirement();

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
        if let Some(prefix) = super::windows_npm_global_prefix() {
            candidates.push((prefix, "NPM_GLOBAL".to_string()));
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
                    let compatible = required_version
                        .as_deref()
                        .map(|req| node_version_satisfies_requirement(&ver, req))
                        .unwrap_or(true);
                    let node_dir = node_bin
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| dir.clone());
                    let mut entry = serde_json::Map::new();
                    entry.insert("path".into(), Value::String(node_path_str));
                    entry.insert("dir".into(), Value::String(node_dir));
                    entry.insert("version".into(), Value::String(ver));
                    entry.insert("source".into(), Value::String(source.clone()));
                    entry.insert("compatible".into(), Value::Bool(compatible));
                    entry.insert(
                        "requiredVersion".into(),
                        required_version
                            .clone()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
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
    let detected = check_node_at_path(node_dir.clone())?;
    if !detected
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("该目录下未找到 node 可执行文件，请确认路径正确。".into());
    }
    if !detected
        .get("compatible")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        let version = detected
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let requirement = detected
            .get("requiredVersion")
            .and_then(Value::as_str)
            .unwrap_or("当前 OpenClaw 要求的版本");
        return Err(format!(
            "Node.js 版本过低：当前 {version}，要求 {requirement}。请升级 Node.js 后再使用该路径。"
        ));
    }

    let config_path = super::panel_config_path();
    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
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
        return Err(format!(
            "只允许写入 {} 目录下的文件",
            openclaw_base.display()
        ));
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

/// 获取当前用户 UID，供 macOS launchctl 的 gui/<uid> 服务域使用。
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

const OPENCLAW_NATIVE_CONFIG_RELOAD_VERSION_FLOOR: &str = "2026.7.1";

fn supports_native_config_reload(version: &str) -> bool {
    let version = parse_version(&base_version(version));
    !version.is_empty() && version >= parse_version(OPENCLAW_NATIVE_CONFIG_RELOAD_VERSION_FLOOR)
}

async fn restart_gateway_internal(app: Option<&tauri::AppHandle>) -> Result<String, String> {
    crate::commands::service::restart_service(
        app.cloned()
            .ok_or_else(|| "缺少 AppHandle，无法重启 Gateway".to_string())?,
        "ai.openclaw.gateway".into(),
    )
    .await
    .map(|_| "Gateway 已重启".to_string())
}

/// 让 Gateway 应用最新配置。
/// OpenClaw 2026.7.1 起由内核文件监听器按变更类型执行热更新或安全重启；
/// ClawPanel 不再探测面板自身的 HTTP 端口，也不重复打断正在运行的 Gateway。
async fn reload_gateway_internal(app: Option<&tauri::AppHandle>) -> Result<String, String> {
    if let Some(version) = get_local_version().await {
        if supports_native_config_reload(&version) {
            return Ok(format!(
                "OpenClaw {version} 已接收配置变更，将由内核自动应用"
            ));
        }
    }

    // 旧内核没有统一的配置监听契约，保留显式重启兼容路径。
    restart_gateway_internal(app).await
}

/// 全局 Gateway 重启 mutex（单飞行锁）
/// 保证同时只有一个重启操作在运行，彻底避免僵尸进程堆积（issue #243）
static RESTART_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// 上一次重启完成的时间戳（用于 2 秒冷却，防止穿透式重复调用）
static LAST_RESTART_FINISHED_AT: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

const RESTART_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);

/// 带单飞行锁和 2s 冷却的 restart 入口
/// 即使前端穿透节流发来多个请求，后端也只串行执行，且 2s 内不重复
async fn restart_gateway_guarded(app: Option<&tauri::AppHandle>) -> Result<String, String> {
    // 获取 mutex：并发调用时串行化
    let _guard = RESTART_MUTEX.lock().await;

    // 2 秒冷却：如果刚刚才完成一次重启，跳过本次（配置已被前一次生效）
    let last_finished = {
        let guard = LAST_RESTART_FINISHED_AT.lock().unwrap();
        *guard
    };
    if let Some(last) = last_finished {
        if last.elapsed() < RESTART_COOLDOWN {
            return Ok("Gateway 刚重启过，本次请求已合并（冷却中）".to_string());
        }
    }

    let result = restart_gateway_internal(app).await;

    // 无论成功失败都记录时间，避免失败后被重试风暴压爆
    {
        let mut guard = LAST_RESTART_FINISHED_AT.lock().unwrap();
        *guard = Some(std::time::Instant::now());
    }

    result
}

#[tauri::command]
pub async fn reload_gateway(app: tauri::AppHandle) -> Result<String, String> {
    reload_gateway_internal(Some(&app)).await
}

/// 用户显式请求重启时才执行进程级 stop/start。
#[tauri::command]
pub async fn restart_gateway(app: tauri::AppHandle) -> Result<String, String> {
    restart_gateway_guarded(Some(&app)).await
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

fn normalize_model_api_type(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "openai" | "openai-chat" | "openai-completions" => "openai-completions".into(),
        "openai-codex-responses" => "openai-chatgpt-responses".into(),
        "anthropic" | "anthropic-messages" => "anthropic-messages".into(),
        "google-gemini" | "gemini" | "google" | "google-generative-ai" => {
            "google-generative-ai".into()
        }
        other => other.to_string(),
    }
}

fn normalize_base_url_for_api(raw: &str, api_type: &str) -> String {
    let mut base = normalize_base_url(raw);
    match normalize_model_api_type(api_type).as_str() {
        "anthropic-messages" => {
            if !base.ends_with("/v1") {
                base.push_str("/v1");
            }
            base
        }
        "google-generative-ai" | "google-vertex" => base,
        _ => {
            // 不再强制追加 /v1，尊重用户填写的 URL（火山引擎等第三方用 /v3 等路径）
            // 仅 Ollama (端口 11434) 自动补 /v1
            base
        }
    }
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn model_api_key_env_ref(raw: &str) -> Result<Option<String>, String> {
    let value = raw.trim();
    if value.starts_with("${") && value.ends_with('}') {
        let key = &value[2..value.len() - 1];
        if is_valid_env_key(key) {
            return Ok(Some(key.to_string()));
        }
        return Err(format!("无效的环境变量引用: {value}"));
    }
    if let Some(key) = value.strip_prefix('$') {
        if !key.is_empty() && is_valid_env_key(key) {
            return Ok(Some(key.to_string()));
        }
    }
    Ok(None)
}

fn parse_dotenv_line(line: &str) -> Option<(String, String)> {
    let line = line.trim().trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let line = line.strip_prefix("export ").unwrap_or(line).trim();
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if !is_valid_env_key(key) {
        return None;
    }
    let mut value = value.trim().to_string();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            value = value[1..value.len() - 1].to_string();
        }
    }
    Some((key.to_string(), value))
}

fn model_env_values() -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Ok(cfg) = load_openclaw_json() {
        if let Some(env) = cfg.get("env").and_then(|v| v.as_object()) {
            for (key, value) in env {
                if !is_valid_env_key(key) {
                    continue;
                }
                if let Some(s) = value.as_str() {
                    values.insert(key.clone(), s.to_string());
                } else if value.is_number() || value.is_boolean() {
                    values.insert(key.clone(), value.to_string());
                }
            }
        }
    }
    let env_path = super::openclaw_dir().join(".env");
    if let Ok(content) = fs::read_to_string(env_path) {
        for line in content.lines() {
            if let Some((key, value)) = parse_dotenv_line(line) {
                values.entry(key).or_insert(value);
            }
        }
    }
    values
}

fn home_path(parts: &[&str]) -> Option<PathBuf> {
    let mut path = dirs::home_dir()?;
    for part in parts {
        path.push(part);
    }
    Some(path)
}

fn strip_config_value(raw: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    for ch in raw.trim().chars() {
        if ch == '"' || ch == '\'' {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            }
            out.push(ch);
            continue;
        }
        if ch == '#' && quote.is_none() {
            break;
        }
        out.push(ch);
    }
    let value = out.trim().trim_end_matches(',').trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn parse_simple_config_blocks(raw: &str) -> HashMap<String, HashMap<String, String>> {
    let mut blocks: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current = String::from("");
    blocks.entry(current.clone()).or_default();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = trimmed.trim_matches(&['[', ']'][..]).trim().to_string();
            blocks.entry(current.clone()).or_default();
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        blocks
            .entry(current.clone())
            .or_default()
            .insert(key.trim().to_string(), strip_config_value(value));
    }
    blocks
}

fn first_env_ref(keys: &[&str]) -> (String, String) {
    for key in keys {
        if std::env::var(key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            return (format!("${{{key}}}"), "found".into());
        }
    }
    if let Some(key) = keys.first() {
        (format!("${{{key}}}"), "missing".into())
    } else {
        (String::new(), "none".into())
    }
}

fn find_json_string(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 5 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(v) = map.get(*key).and_then(|v| v.as_str()) {
                    if !v.trim().is_empty() {
                        return Some(v.trim().to_string());
                    }
                }
            }
            for v in map.values() {
                if let Some(found) = find_json_string(v, keys, depth + 1) {
                    return Some(found);
                }
            }
        }
        Value::Array(list) => {
            for v in list {
                if let Some(found) = find_json_string(v, keys, depth + 1) {
                    return Some(found);
                }
            }
        }
        _ => {}
    }
    None
}

// 客户端配置导入需要把所有渲染必需的字段一次性塞进 Value，分组成 struct 反而会
// 让调用站全部要先建一个临时结构体，可读性更差。这里显式 allow，仅作用于这个函数。
#[allow(clippy::too_many_arguments)]
fn push_client_candidate(
    out: &mut Vec<Value>,
    id: &str,
    source: &str,
    source_path: &str,
    provider_key: &str,
    display_name: &str,
    base_url: &str,
    api: &str,
    api_key: &str,
    api_key_status: &str,
    models: Vec<String>,
    importable: bool,
    auth_hint: &str,
    warning: &str,
) {
    out.push(json!({
        "id": id,
        "source": source,
        "sourcePath": source_path,
        "providerKey": provider_key,
        "displayName": display_name,
        "baseUrl": base_url,
        "api": api,
        "apiKey": api_key,
        "apiKeyStatus": api_key_status,
        "models": models,
        "importable": importable,
        "authHint": auth_hint,
        "warning": warning,
    }));
}

#[allow(clippy::too_many_arguments)]
fn scan_json_client_file(
    out: &mut Vec<Value>,
    id: &str,
    source: &str,
    parts: &[&str],
    provider_key: &str,
    display_name: &str,
    base_url: &str,
    api: &str,
    env_keys: &[&str],
    default_model: &str,
) {
    let Some(path) = home_path(parts) else {
        return;
    };
    if !path.exists() {
        return;
    }
    let model = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| find_json_string(&value, &["model", "defaultModel", "modelName"], 0))
        .unwrap_or_else(|| default_model.to_string());
    let (api_key, status) = first_env_ref(env_keys);
    let warning = if status == "missing" {
        "未在当前进程环境中检测到对应 API Key 环境变量。请先在 OpenClaw env 或 .env 中补齐后再导入。"
    } else {
        ""
    };
    push_client_candidate(
        out,
        id,
        source,
        &path.to_string_lossy(),
        provider_key,
        display_name,
        base_url,
        api,
        &api_key,
        &status,
        vec![model],
        status != "missing",
        "",
        warning,
    );
}

#[tauri::command]
pub fn scan_model_client_configs() -> Result<Value, String> {
    let mut candidates = Vec::new();
    if let Some(path) = home_path(&[".codex", "config.toml"]) {
        if let Ok(raw) = fs::read_to_string(&path) {
            let blocks = parse_simple_config_blocks(&raw);
            let root = blocks.get("").cloned().unwrap_or_default();
            let provider_id = root
                .get("model_provider")
                .cloned()
                .unwrap_or_else(|| "openai".into());
            let section = blocks
                .get(&format!("model_providers.{provider_id}"))
                .cloned()
                .unwrap_or_default();
            let model = root
                .get("model")
                .cloned()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "gpt-5.1-codex-mini".into());
            let base_url = section.get("base_url").cloned().unwrap_or_else(|| {
                if provider_id.contains("codex") {
                    "https://chatgpt.com/backend-api/codex".into()
                } else {
                    "https://api.openai.com/v1".into()
                }
            });
            let wire_api = section.get("wire_api").cloned().unwrap_or_default();
            let explicit_env_key = section
                .get("env_key")
                .cloned()
                .filter(|v| is_valid_env_key(v));
            let env_key = explicit_env_key.or_else(|| {
                if provider_id == "openai" {
                    Some("OPENAI_API_KEY".into())
                } else {
                    None
                }
            });
            let is_external_codex =
                provider_id.contains("codex") || base_url.contains("chatgpt.com/backend-api/codex");
            let api = if is_external_codex {
                "openai-codex-responses"
            } else if wire_api.contains("responses") {
                "openai-responses"
            } else {
                "openai-completions"
            };
            let (api_key, status) = if let Some(key) = env_key.as_deref() {
                if std::env::var(key)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
                {
                    (format!("${{{key}}}"), "found")
                } else {
                    (format!("${{{key}}}"), "missing")
                }
            } else {
                (String::new(), "none")
            };
            let provider_key = if provider_id == "openai" {
                "codex-openai".to_string()
            } else {
                format!("codex-{provider_id}")
            };
            let warning = if is_external_codex {
                "ChatGPT/Codex OAuth 令牌不会导入到 OpenClaw。请优先使用 Hermes 的 openai-codex 登录。"
            } else if status == "none" {
                "Codex 配置没有声明可安全引用的 env_key，无法自动导入 API Key。请在 Codex 配置中添加 env_key，或在 OpenClaw 中手动配置服务商密钥。"
            } else if status == "missing" {
                "未在当前进程环境中检测到 Codex 配置引用的 API Key 环境变量。请先在 OpenClaw env 或 .env 中补齐后再导入。"
            } else {
                ""
            };
            push_client_candidate(
                &mut candidates,
                "codex-cli",
                "Codex CLI",
                &path.to_string_lossy(),
                &provider_key,
                &format!("Codex CLI / {provider_id}"),
                &base_url,
                api,
                &api_key,
                status,
                vec![model],
                !is_external_codex && status != "none" && status != "missing",
                if is_external_codex {
                    "hermes auth login openai-codex"
                } else {
                    ""
                },
                warning,
            );
        }
    }
    scan_json_client_file(
        &mut candidates,
        "claude-code",
        "Claude Code",
        &[".claude", "settings.json"],
        "anthropic",
        "Anthropic / Claude Code",
        "https://api.anthropic.com/v1",
        "anthropic-messages",
        &["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
        "claude-sonnet-4-5-20250514",
    );
    scan_json_client_file(
        &mut candidates,
        "gemini-cli",
        "Gemini CLI",
        &[".gemini", "settings.json"],
        "google",
        "Google Gemini CLI",
        "https://generativelanguage.googleapis.com/v1beta",
        "google-generative-ai",
        &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "gemini-2.5-pro",
    );
    for (env_key, provider_key, display_name, base_url, api, model) in [
        (
            "OPENAI_API_KEY",
            "openai-env",
            "OpenAI 环境变量",
            std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into()),
            "openai-completions",
            std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()),
        ),
        (
            "ANTHROPIC_API_KEY",
            "anthropic-env",
            "Anthropic 环境变量",
            "https://api.anthropic.com/v1".into(),
            "anthropic-messages",
            std::env::var("ANTHROPIC_MODEL")
                .unwrap_or_else(|_| "claude-sonnet-4-5-20250514".into()),
        ),
        (
            "GEMINI_API_KEY",
            "gemini-env",
            "Gemini 环境变量",
            "https://generativelanguage.googleapis.com/v1beta".into(),
            "google-generative-ai",
            std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-2.5-pro".into()),
        ),
    ] {
        if std::env::var(env_key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            push_client_candidate(
                &mut candidates,
                provider_key,
                "Environment",
                env_key,
                provider_key,
                display_name,
                &base_url,
                api,
                &format!("${{{env_key}}}"),
                "found",
                vec![model],
                true,
                "",
                "",
            );
        }
    }
    Ok(json!({ "candidates": candidates }))
}

pub(super) fn resolve_model_api_key(api_key: &str) -> Result<String, String> {
    let Some(key) = model_api_key_env_ref(api_key)? else {
        return Ok(api_key.to_string());
    };
    let values = model_env_values();
    if let Some(value) = values.get(&key).filter(|v| !v.is_empty()) {
        return Ok(value.clone());
    }
    if let Ok(value) = std::env::var(&key) {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    Err(format!(
        "API Key 引用了环境变量 {key}，但未在 openclaw.json env、~/.openclaw/.env 或当前进程环境中找到"
    ))
}

fn resolve_model_api_key_value(api_key: &Value) -> Result<String, String> {
    if let Some(api_key) = api_key.as_str() {
        return resolve_model_api_key(api_key);
    }
    let Some(secret_ref) = api_key.as_object() else {
        return Err("API Key 必须是字符串或 OpenClaw SecretRef".into());
    };
    let source = secret_ref
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let id = secret_ref
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if source != "env" || !is_valid_env_key(id) {
        return Err("该 SecretRef 需要由 OpenClaw 运行时解析，请使用 OpenClaw 模型探测".into());
    }
    let values = model_env_values();
    if let Some(value) = values.get(id).filter(|value| !value.trim().is_empty()) {
        return Ok(value.clone());
    }
    if let Ok(value) = std::env::var(id) {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }
    Err(format!(
        "API Key 引用了环境变量 {id}，但未在 openclaw.json env、~/.openclaw/.env 或当前进程环境中找到"
    ))
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

fn unsupported_direct_model_test(api_type: &str) -> String {
    format!("该 API 类型需要由 OpenClaw 运行时验证: {api_type}")
}

/// 测试模型连通性：向 provider 发送一个简单的 chat completion 请求
#[tauri::command]
pub async fn test_model(
    base_url: String,
    api_key: Value,
    model_id: String,
    api_type: Option<String>,
) -> Result<String, String> {
    let api_type = normalize_model_api_type(api_type.as_deref().unwrap_or("openai-completions"));
    let base = normalize_base_url_for_api(&base_url, &api_type);
    let api_key = resolve_model_api_key_value(&api_key)?;

    let client =
        crate::commands::build_http_client_no_proxy(std::time::Duration::from_secs(30), None)
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = match api_type.as_str() {
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
        "google-generative-ai" => {
            let url = format!(
                "{}/models/{}:generateContent?key={}",
                base, model_id, api_key
            );
            let body = json!({
                "contents": [{"role": "user", "parts": [{"text": "Hi"}]}]
            });
            client.post(&url).json(&body).send()
        }
        "openai-responses" | "azure-openai-responses" => {
            let url = format!("{}/responses", base);
            let body = json!({
                "model": model_id,
                "input": "Hi",
                "max_output_tokens": 16
            });
            let mut req = client.post(&url).json(&body);
            if !api_key.is_empty() {
                req = if api_type == "azure-openai-responses" {
                    req.header("api-key", api_key.clone())
                } else {
                    req.header("Authorization", format!("Bearer {api_key}"))
                };
            }
            req.send()
        }
        "openai-completions" | "ollama" => {
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
        _ => return Err(unsupported_direct_model_test(&api_type)),
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
        return Err(format!("API 返回 {status}: {msg}"));
    }

    let reply = extract_single_json_reply(&text);
    if reply.is_empty() {
        return Err("API 已响应但未解析出内容".to_string());
    }

    Ok(reply)
}

/// 从 SSE 流文本中累积 OpenAI 风格的 delta.content / delta.reasoning_content
/// 格式示例：
///   data: {"choices":[{"delta":{"content":"你好"}}]}
///   data: {"choices":[{"delta":{"content":"，"}}]}
///   data: [DONE]
fn extract_sse_reply(text: &str) -> String {
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut saw_data_line = false;
    for line in text.lines() {
        let data = if let Some(rest) = line.strip_prefix("data: ") {
            rest
        } else if let Some(rest) = line.strip_prefix("data:") {
            rest
        } else {
            continue;
        };
        saw_data_line = true;
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            // OpenAI / 兼容后端：choices[0].delta.content
            let delta = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("delta"));
            if let Some(d) = delta {
                if let Some(c) = d.get("content").and_then(|c| c.as_str()) {
                    content.push_str(c);
                }
                if let Some(rc) = d.get("reasoning_content").and_then(|c| c.as_str()) {
                    reasoning.push_str(rc);
                }
            }
            // Anthropic streaming: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
            if v.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                if let Some(c) = v
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    content.push_str(c);
                }
            }
        }
    }
    if !saw_data_line {
        return String::new();
    }
    if !content.is_empty() {
        content
    } else if !reasoning.is_empty() {
        format!("[reasoning] {reasoning}")
    } else {
        String::new()
    }
}

/// 从单个 JSON 响应中提取 reply（兼容 OpenAI / Anthropic / Gemini / DashScope 非流式）
fn extract_single_json_reply(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            if let Some(t) = v
                .get("output_text")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
            {
                return Some(t.to_string());
            }
            if let Some(output) = v.get("output").and_then(|o| o.as_array()) {
                let text = output
                    .iter()
                    .filter_map(|item| item.get("content").and_then(|c| c.as_array()))
                    .flatten()
                    .filter(|part| {
                        matches!(
                            part.get("type").and_then(|t| t.as_str()),
                            Some("output_text") | Some("text")
                        )
                    })
                    .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                if !text.is_empty() {
                    return Some(text);
                }
            }
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
            if let Some(msg) = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
            {
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                if !content.is_empty() {
                    return Some(content.to_string());
                }
                if let Some(rc) = msg
                    .get("reasoning_content")
                    .and_then(|c| c.as_str())
                    .filter(|s| !s.is_empty())
                {
                    return Some(format!("[reasoning] {rc}"));
                }
            }
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
        .unwrap_or_default()
}

/// 测试模型（详细版 #Compat-1）：返回完整 req/resp 信息，供前端 debug 面板展示
///
/// 相比 test_model：
/// - 不会因 400/422/429 等吞掉错误返回"连接正常"，一律如实回传 status + body
/// - 返回结构化 JSON：success/status/req_url/req_body/resp_body/reply/error/elapsed_ms/used_api
/// - 前端拿到后可以直接渲染 debug 面板，无需在 webview 里走外部 fetch（规避 status 0）
/// - OpenAI 兼容路径使用 stream:true（绕开某些 new-api 后端的 non-streaming bug，
///   并与真实对话行为一致）
#[tauri::command]
pub async fn test_model_verbose(
    base_url: String,
    api_key: Value,
    model_id: String,
    api_type: Option<String>,
) -> Result<serde_json::Value, String> {
    use std::time::Instant;
    let api_type_norm =
        normalize_model_api_type(api_type.as_deref().unwrap_or("openai-completions"));
    let base = normalize_base_url_for_api(&base_url, &api_type_norm);
    let api_key = resolve_model_api_key_value(&api_key)?;
    let start = Instant::now();

    let client =
        crate::commands::build_http_client_no_proxy(std::time::Duration::from_secs(30), None)
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    // 关键：显式 Accept-Encoding: identity 禁止响应压缩，避免：
    // - reqwest 未启用 brotli feature 时，provider 返回 Content-Encoding: br 导致 text() 失败
    // - 某些 CDN 会根据默认 UA 自动压缩响应
    // 测试请求的响应体很小（几百字节），不压缩的性能损失可忽略
    let (used_api, req_url, req_body_json, req_builder) = match api_type_norm.as_str() {
        "anthropic-messages" => {
            let url = format!("{}/messages", base);
            let body = json!({
                "model": model_id,
                "messages": [{"role": "user", "content": "你好，请用一句话回复"}],
                "max_tokens": 200,
            });
            let mut req = client
                .post(&url)
                .header("anthropic-version", "2023-06-01")
                .header("Accept-Encoding", "identity")
                .json(&body);
            if !api_key.is_empty() {
                req = req.header("x-api-key", api_key.clone());
            }
            ("Anthropic Messages", url, body, req)
        }
        "google-generative-ai" => {
            let url_display = format!("{}/models/{}:generateContent?key=***", base, model_id);
            let url_real = format!(
                "{}/models/{}:generateContent?key={}",
                base, model_id, api_key
            );
            let body = json!({
                "contents": [{"role": "user", "parts": [{"text": "你好，请用一句话回复"}]}]
            });
            let req = client
                .post(&url_real)
                .header("Accept-Encoding", "identity")
                .json(&body);
            ("Gemini", url_display, body, req)
        }
        "openai-responses" | "azure-openai-responses" => {
            let url = format!("{}/responses", base);
            let body = json!({
                "model": model_id,
                "input": "你好，请用一句话回复",
                "max_output_tokens": 200
            });
            let mut req = client
                .post(&url)
                .header("Accept-Encoding", "identity")
                .json(&body);
            if !api_key.is_empty() {
                req = if api_type_norm == "azure-openai-responses" {
                    req.header("api-key", api_key.clone())
                } else {
                    req.header("Authorization", format!("Bearer {api_key}"))
                };
            }
            ("Responses", url, body, req)
        }
        "openai-completions" | "ollama" => {
            let url = format!("{}/chat/completions", base);
            // 关键：测试请求用 stream: true 而非 stream: false
            // 理由：部分兼容网关的 non-streaming 分支对某些模型会返回 200 + 空 body，
            // 而 streaming 分支是真实对话路径，所有 provider 都稳定支持。
            // 测试走 stream: true + SSE 累积，行为与真实对话一致。
            let body = json!({
                "model": model_id,
                "messages": [{"role": "user", "content": "你好，请用一句话回复"}],
                "max_tokens": 200,
                "stream": true
            });
            let mut req = client
                .post(&url)
                .header("Accept-Encoding", "identity")
                .header("Accept", "text/event-stream")
                .json(&body);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            ("Chat Completions (SSE)", url, body, req)
        }
        _ => return Err(unsupported_direct_model_test(&api_type_norm)),
    };

    let resp_result = req_builder.send().await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    let resp = match resp_result {
        Ok(r) => r,
        Err(e) => {
            let error = if e.is_timeout() {
                "请求超时 (30s)".to_string()
            } else if e.is_connect() {
                format!("连接失败: {e}")
            } else {
                format!("请求失败: {e}")
            };
            return Ok(json!({
                "success": false,
                "status": 0,
                "reqUrl": req_url,
                "reqBody": req_body_json,
                "respBody": "",
                "reply": "",
                "error": error,
                "elapsedMs": elapsed_ms,
                "usedApi": used_api,
            }));
        }
    };

    let status = resp.status();
    let status_code = status.as_u16();

    // 先抓取响应头（text() 会消耗 resp）—— 这是关键诊断信息：
    // Content-Encoding 告诉我们是否压缩、是 br/gzip/zstd 还是啥
    // Content-Type 告诉我们是否是 JSON / text
    // Content-Length 告诉我们服务器声明的响应体大小
    let resp_headers = {
        let mut map = serde_json::Map::new();
        for (k, v) in resp.headers().iter() {
            map.insert(
                k.to_string(),
                serde_json::Value::String(v.to_str().unwrap_or("<non-utf8>").to_string()),
            );
        }
        serde_json::Value::Object(map)
    };

    // 读取响应体：改用 bytes() 拿原始字节（reqwest 会按 Content-Encoding 自动解压），
    // 然后自己做 UTF-8 decode。这样：
    // 1. 失败时能给出更精确的错误分类（网络错误 vs 解压错误 vs UTF-8 错误）
    // 2. UTF-8 失败时能 fallback 到 hex dump + lossy string，方便诊断
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let mut err_chain = format!("{e}");
            let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
            while let Some(s) = src {
                err_chain.push_str(&format!(" → {s}"));
                src = std::error::Error::source(s);
            }
            return Ok(json!({
                "success": false,
                "status": status_code,
                "reqUrl": req_url,
                "reqBody": req_body_json,
                "respHeaders": resp_headers,
                "respBody": "",
                "respRawHex": "",
                "respByteCount": 0,
                "reply": "",
                "error": format!("读取响应字节失败: {err_chain}"),
                "elapsedMs": elapsed_ms,
                "usedApi": used_api,
            }));
        }
    };
    let byte_count = bytes.len();

    // 前 200 字节的 hex dump（无论成功失败都附上，方便调试）
    let hex_preview = bytes
        .iter()
        .take(200)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");

    // 尝试严格 UTF-8 decode；失败时 fallback 到 lossy 并在 error 里带上诊断
    let text = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(e) => {
            let lossy = String::from_utf8_lossy(&bytes).into_owned();
            let ascii_preview: String = bytes
                .iter()
                .take(80)
                .map(|&b| {
                    if (0x20..=0x7e).contains(&b) {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect();
            return Ok(json!({
                "success": false,
                "status": status_code,
                "reqUrl": req_url,
                "reqBody": req_body_json,
                "respHeaders": resp_headers,
                "respBody": lossy,
                "respRawHex": hex_preview,
                "respByteCount": byte_count,
                "reply": "",
                "error": format!("响应体 UTF-8 解码失败: {e} | 字节数={byte_count} | 前 80 字节 ASCII='{ascii_preview}'"),
                "elapsedMs": elapsed_ms,
                "usedApi": used_api,
            }));
        }
    };

    // 提取 reply 文本：同时兼容 SSE 流（stream:true）和单次 JSON（stream:false）
    // 优先尝试 SSE 解析（OpenAI 兼容路径现在用 stream:true），失败再回退到单 JSON
    let reply = {
        let sse_reply = extract_sse_reply(&text);
        if !sse_reply.is_empty() {
            sse_reply
        } else {
            extract_single_json_reply(&text)
        }
    };

    let success = status.is_success() && !reply.is_empty();
    let error = if !status.is_success() {
        Some(extract_error_message(&text, status))
    } else if reply.is_empty() {
        Some("API 已响应但未解析出内容".to_string())
    } else {
        None
    };

    Ok(json!({
        "success": success,
        "status": status_code,
        "reqUrl": req_url,
        "reqBody": req_body_json,
        "respHeaders": resp_headers,
        "respBody": text,
        "respRawHex": hex_preview,
        "respByteCount": byte_count,
        "reply": reply,
        "error": error,
        "elapsedMs": elapsed_ms,
        "usedApi": used_api,
    }))
}

/// 获取服务商的远程模型列表（调用 /models 接口）
#[tauri::command]
pub async fn list_remote_models(
    base_url: String,
    api_key: Value,
    api_type: Option<String>,
) -> Result<Vec<String>, String> {
    let api_type = normalize_model_api_type(api_type.as_deref().unwrap_or("openai-completions"));
    let base = normalize_base_url_for_api(&base_url, &api_type);
    let api_key = resolve_model_api_key_value(&api_key)?;

    let client =
        crate::commands::build_http_client_no_proxy(std::time::Duration::from_secs(15), None)
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = match api_type.as_str() {
        "anthropic-messages" => {
            let url = format!("{}/models", base);
            let mut req = client.get(&url).header("anthropic-version", "2023-06-01");
            if !api_key.is_empty() {
                req = req.header("x-api-key", api_key.clone());
            }
            req.send()
        }
        "google-generative-ai" => {
            let url = format!("{}/models?key={}", base, api_key);
            client.get(&url).send()
        }
        "openai-completions" | "openai-responses" | "ollama" => {
            let url = format!("{}/models", base);
            let mut req = client.get(&url);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            req.send()
        }
        "azure-openai-responses" => {
            let url = format!("{}/models", base);
            let mut req = client.get(&url);
            if !api_key.is_empty() {
                req = req.header("api-key", api_key.clone());
            }
            req.send()
        }
        _ => return Err(unsupported_direct_model_test(&api_type)),
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
        // 404/405/501 = 服务商不支持 /models 接口，给用户友好提示而非技术错误
        let code = status.as_u16();
        if code == 404 || code == 405 || code == 501 {
            return Err(
                "[NOT_SUPPORTED] 该服务商不支持自动获取模型列表，请手动输入模型 ID".to_string(),
            );
        }
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

/// 检查 ClawPanel 自身是否有新版本（官网唯一发现源）
#[tauri::command]
pub async fn check_panel_update() -> Result<Value, String> {
    super::site_api::site_latest_for_panel_update()
        .await
        .map_err(|e| format!("官网版本接口不可用: {e}"))
}

// === 面板配置 (clawpanel.json) ===

/// 获取当前生效的 OpenClaw 配置目录路径
#[tauri::command]
pub fn get_openclaw_dir() -> Result<Value, String> {
    let resolved = super::openclaw_dir();
    let is_custom = super::read_panel_config_value()
        .and_then(|v| v.get("openclawDir")?.as_str().map(String::from))
        .map(|s| !s.trim().is_empty())
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

fn path_without_curdir_string(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy();
    let separator = if raw.contains('\\') {
        '\\'
    } else {
        std::path::MAIN_SEPARATOR
    };
    raw.split(['/', '\\'])
        .filter(|component| *component != ".")
        .collect::<Vec<_>>()
        .join(&separator.to_string())
}

fn bind_openclaw_cli_path(cli_path: &std::path::Path) -> Result<(), String> {
    let mut config = read_panel_config().unwrap_or_else(|_| json!({}));
    if !config.is_object() {
        config = json!({});
    }
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "openclawCliPath".into(),
            Value::String(path_without_curdir_string(cli_path)),
        );
    }
    write_panel_config(config)?;
    super::refresh_enhanced_path();
    crate::commands::service::invalidate_cli_detection_cache();
    Ok(())
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
    let configured = configured_git_path();
    let git = configured.clone().unwrap_or_else(|| "git".into());
    let is_custom = configured.is_some();
    let git_path = if is_custom {
        Some(git.clone())
    } else {
        find_git_path()
    };
    // #Compat-4: 优先用 find_git_path 拿到的绝对路径执行 --version（避免依赖子进程 PATH），
    // 回退到 "git" 时也把 enhanced_path 注入子进程 PATH，让刚装完 git 的场景立即可识别。
    let exec = git_path.as_deref().unwrap_or(&git);
    let mut cmd = Command::new(exec);
    cmd.arg("--version");
    cmd.env("PATH", super::enhanced_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            result.insert("installed".into(), Value::Bool(true));
            result.insert("version".into(), Value::String(ver));
            result.insert(
                "path".into(),
                git_path.map(Value::String).unwrap_or(Value::Null),
            );
            result.insert("isCustom".into(), Value::Bool(is_custom));
        }
        _ => {
            result.insert("installed".into(), Value::Bool(false));
            result.insert("version".into(), Value::Null);
            result.insert("path".into(), Value::Null);
            result.insert("isCustom".into(), Value::Bool(is_custom));
        }
    }
    Ok(Value::Object(result))
}

/// 扫描常见路径，返回所有找到的 Git 安装
#[tauri::command]
pub fn scan_git_paths() -> Result<Value, String> {
    let mut found: Vec<Value> = vec![];
    let mut candidates: Vec<(String, String)> = vec![]; // (path, source)

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();

        // 标准安装路径
        candidates.push((format!(r"{}\Git\cmd\git.exe", pf), "SYSTEM".into()));
        candidates.push((format!(r"{}\Git\cmd\git.exe", pf86), "SYSTEM".into()));

        // 常见盘符
        for drive in &["C", "D", "E", "F", "G"] {
            candidates.push((format!(r"{}:\Git\cmd\git.exe", drive), "MANUAL".into()));
            candidates.push((
                format!(r"{}:\Program Files\Git\cmd\git.exe", drive),
                "SYSTEM".into(),
            ));
            // 工具目录
            for sub in &["Tools", "Dev", "AI", "Apps", "Software"] {
                candidates.push((
                    format!(r"{}:\{}\Git\cmd\git.exe", drive, sub),
                    "MANUAL".into(),
                ));
            }
        }

        // 自定义应用目录（如 D:\Data\exeApp\Git）
        for drive in &["C", "D", "E", "F"] {
            candidates.push((
                format!(r"{}:\Data\exeApp\Git\cmd\git.exe", drive),
                "MANUAL".into(),
            ));
        }

        // GitHub Desktop 内置 Git
        if !localappdata.is_empty() {
            let gh_dir = std::path::Path::new(&localappdata).join("GitHubDesktop");
            if gh_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&gh_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() {
                            let git_exe = p
                                .join("resources")
                                .join("app")
                                .join("git")
                                .join("cmd")
                                .join("git.exe");
                            if git_exe.exists() {
                                candidates.push((
                                    git_exe.to_string_lossy().to_string(),
                                    "GITHUB_DESKTOP".into(),
                                ));
                            }
                        }
                    }
                }
            }
        }

        // VS Code 内置 Git
        if !localappdata.is_empty() {
            let vscode_git = std::path::Path::new(&localappdata).join(r"Programs\Microsoft VS Code\resources\app\node_modules.asar.unpacked\vscode-git\git\cmd\git.exe");
            if vscode_git.exists() {
                candidates.push((vscode_git.to_string_lossy().to_string(), "VSCODE".into()));
            }
        }

        // MinGW / MSYS2 / Git Bash
        candidates.push((format!(r"{}\Git\mingw64\bin\git.exe", pf), "MINGW".into()));
        for drive in &["C", "D"] {
            candidates.push((
                format!(r"{}:\msys64\usr\bin\git.exe", drive),
                "MSYS2".into(),
            ));
            candidates.push((format!(r"{}:\msys2\usr\bin\git.exe", drive), "MSYS2".into()));
        }

        // Scoop
        let home = dirs::home_dir().unwrap_or_default();
        candidates.push((
            format!(r"{}\scoop\apps\git\current\cmd\git.exe", home.display()),
            "SCOOP".into(),
        ));
        candidates.push((
            format!(r"{}\scoop\shims\git.exe", home.display()),
            "SCOOP".into(),
        ));

        // Chocolatey
        let choco_dir = std::env::var("ChocolateyInstall")
            .unwrap_or_else(|_| r"C:\ProgramData\chocolatey".into());
        candidates.push((format!(r"{}\bin\git.exe", choco_dir), "CHOCOLATEY".into()));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(("/usr/bin/git".into(), "SYSTEM".into()));
        candidates.push(("/usr/local/bin/git".into(), "SYSTEM".into()));
        candidates.push(("/opt/homebrew/bin/git".into(), "BREW".into()));
        // Xcode
        candidates.push((
            "/Library/Developer/CommandLineTools/usr/bin/git".into(),
            "XCODE_CLT".into(),
        ));
        candidates.push((
            "/Applications/Xcode.app/Contents/Developer/usr/bin/git".into(),
            "XCODE".into(),
        ));
        // Snap / Flatpak
        candidates.push(("/snap/bin/git".into(), "SNAP".into()));
        // Nix
        let home = dirs::home_dir().unwrap_or_default();
        candidates.push((
            format!("{}/.nix-profile/bin/git", home.display()),
            "NIX".into(),
        ));
        // Linuxbrew
        candidates.push((
            format!("{}/.linuxbrew/bin/git", home.display()),
            "BREW".into(),
        ));
        candidates.push(("/home/linuxbrew/.linuxbrew/bin/git".into(), "BREW".into()));
    }

    // 去重并检测
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (path, source) in &candidates {
        let p = std::path::Path::new(path);
        if !p.exists() {
            continue;
        }
        let canonical = p.to_string_lossy().to_string();
        if seen.contains(&canonical) {
            continue;
        }
        seen.insert(canonical.clone());

        let mut cmd = Command::new(path);
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if let Ok(o) = cmd.output() {
            if o.status.success() {
                let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let mut entry = serde_json::Map::new();
                entry.insert("path".into(), Value::String(canonical));
                entry.insert("version".into(), Value::String(ver));
                entry.insert("source".into(), Value::String(source.clone()));
                found.push(Value::Object(entry));
            }
        }
    }

    Ok(Value::Array(found))
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
            // #Compat-4: 刷新 PATH 缓存，使 check_git 能立即检测到新装的 git，
            // 避免用户反馈「装完不识别，重启客户端才能用」
            super::refresh_enhanced_path();
            crate::commands::service::invalidate_cli_detection_cache();
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
            // #Compat-4: 刷新缓存（即便是"触发"而非同步完成，下次检测时缓存也已清）
            super::refresh_enhanced_path();
            crate::commands::service::invalidate_cli_detection_cache();
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
            // #Compat-4: 刷新 PATH 缓存，使 check_git 立即识别新装的 git
            super::refresh_enhanced_path();
            crate::commands::service::invalidate_cli_detection_cache();
            return Ok("Git 已安装".to_string());
        }
        Err("Git 安装失败，请手动执行: sudo apt install git".to_string())
    }
}

/// 尝试自动安装或升级 Node.js LTS
#[tauri::command]
pub async fn auto_install_node(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    let _ = app.emit("upgrade-log", "正在尝试安装或升级 Node.js LTS...");

    #[cfg(target_os = "windows")]
    {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;

        let run_winget = |mode: &str| -> Result<std::process::Child, String> {
            let mut args = vec![
                mode,
                "--id",
                "OpenJS.NodeJS.LTS",
                "-e",
                "--source",
                "winget",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ];
            if mode == "upgrade" {
                args.push("--silent");
            }
            let mut cmd = Command::new("winget");
            cmd.args(args)
                .creation_flags(0x08000000)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("winget 不可用，请手动升级 Node.js: {e}"))
        };

        let stream_child_logs = |app_handle: &tauri::AppHandle, child: &mut std::process::Child| {
            let stderr = child.stderr.take();
            let stdout = child.stdout.take();
            let app_for_stderr = app_handle.clone();
            let stderr_handle = std::thread::spawn(move || {
                if let Some(pipe) = stderr {
                    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                        let _ = app_for_stderr.emit("upgrade-log", &line);
                    }
                }
            });
            if let Some(pipe) = stdout {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = app_handle.emit("upgrade-log", &line);
                }
            }
            let _ = stderr_handle.join();
        };

        let _ = app.emit("upgrade-progress", 20);
        let _ = app.emit("upgrade-log", "尝试通过 winget 升级 Node.js LTS...");
        let mut child = run_winget("upgrade")?;
        stream_child_logs(&app, &mut child);

        let status = child
            .wait()
            .map_err(|e| format!("等待 winget 升级 Node.js 失败: {e}"))?;
        if !status.success() {
            let _ = app.emit("upgrade-progress", 45);
            let _ = app.emit("upgrade-log", "升级命令未成功，尝试改用 winget install...");
            let mut install_child = run_winget("install")?;
            stream_child_logs(&app, &mut install_child);
            let install_status = install_child
                .wait()
                .map_err(|e| format!("等待 winget 安装 Node.js 失败: {e}"))?;
            if !install_status.success() {
                let requirement = openclaw_node_requirement()
                    .unwrap_or_else(|| "当前 OpenClaw 要求的版本".to_string());
                return Err(format!(
                    "winget 安装/升级 Node.js 失败，请手动安装满足 {requirement} 的 Node.js：https://nodejs.org/"
                ));
            }
        }

        let _ = app.emit("upgrade-progress", 75);
        let _ = app.emit("upgrade-log", "正在刷新 PATH 并重新检测 Node.js...");
        super::refresh_enhanced_path();
        crate::commands::service::invalidate_cli_detection_cache();
        let node = check_node()?;
        if node
            .get("compatible")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let _ = app.emit("upgrade-progress", 100);
            return Ok("Node.js 已安装或升级，请重新检测后启动 Gateway".into());
        }
        let version = node
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let requirement = node
            .get("requiredVersion")
            .and_then(Value::as_str)
            .unwrap_or("当前 OpenClaw 要求的版本");
        Err(format!(
            "Node.js 升级后仍不满足要求：当前 {version}，要求 {requirement}。请重启 ClawPanel 或手动安装新版 Node.js。"
        ))
    }

    #[cfg(target_os = "macos")]
    {
        Err("请通过官网、Homebrew、nvm 或 fnm 升级 Node.js 后重新检测。".into())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("请使用系统包管理器、nvm 或 fnm 升级 Node.js 后重新检测。".into())
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

#[cfg(test)]
mod write_openclaw_config_merge_tests {
    use super::apply_reset_inheritance;
    use super::calibration_richness_score;
    use super::fallback_openclaw_node_requirement;
    use super::merge_configs_preserving_fields;
    use super::node_version_satisfies_requirement;
    use super::normalize_model_api_type;
    use super::path_without_curdir_string;
    use super::promote_nested_standalone_dir;
    use super::replace_standalone_install;
    use super::resolve_model_api_key_value;
    #[cfg(target_os = "windows")]
    use super::resolve_openclaw_cli_input_path;
    use super::select_calibration_source;
    use super::should_fallback_standalone_to_npm;
    use super::standalone_bundled_node_bin;
    use super::standalone_install_dir_impl;
    use super::standalone_install_version;
    use super::strip_ui_fields;
    use super::supports_native_config_reload;
    use super::validate_model_provider_env_refs;
    use super::verify_standalone_install;
    use super::write_verified_json_with_backup;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("clawpanel-{name}-{}-{suffix}", std::process::id()))
    }

    #[test]
    fn standalone_activation_replaces_verified_staging() {
        let root = unique_temp_dir("standalone-swap");
        let install_dir = root.join("install");
        let staging_dir = root.join("staging");
        let backup_dir = root.join("backup");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::create_dir_all(&staging_dir).unwrap();
        std::fs::write(install_dir.join("old.txt"), "old").unwrap();
        std::fs::write(staging_dir.join("new.txt"), "new").unwrap();

        replace_standalone_install(&staging_dir, &install_dir, &backup_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(install_dir.join("new.txt")).unwrap(),
            "new"
        );
        assert!(!install_dir.join("old.txt").exists());
        assert!(!backup_dir.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn standalone_activation_restores_old_install_on_failure() {
        let root = unique_temp_dir("standalone-rollback");
        let install_dir = root.join("install");
        let missing_staging_dir = root.join("missing-staging");
        let backup_dir = root.join("backup");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::write(install_dir.join("old.txt"), "old").unwrap();

        assert!(
            replace_standalone_install(&missing_staging_dir, &install_dir, &backup_dir).is_err()
        );

        assert_eq!(
            std::fs::read_to_string(install_dir.join("old.txt")).unwrap(),
            "old"
        );
        assert!(!backup_dir.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn standalone_validation_rejects_missing_runtime_dependency() {
        let root = unique_temp_dir("standalone-runtime-missing");
        #[cfg(target_os = "windows")]
        let cli_name = "openclaw.cmd";
        #[cfg(not(target_os = "windows"))]
        let cli_name = "openclaw";
        let package_dir = root
            .join("node_modules")
            .join("@qingchencloud")
            .join("openclaw-zh");
        std::fs::create_dir_all(&package_dir).unwrap();
        std::fs::write(root.join(cli_name), "").unwrap();
        std::fs::write(root.join("VERSION"), "openclaw_version=2026.7.1-zh.2\n").unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            serde_json::to_vec(&json!({
                "name": "@qingchencloud/openclaw-zh",
                "version": "2026.7.1-zh.2",
                "dependencies": {
                    "@openclaw/ai": "2026.7.1"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let error = verify_standalone_install(&root, "2026.7.1-zh.2").unwrap_err();
        let _ = std::fs::remove_dir_all(&root);

        assert!(error.contains("缺少运行时依赖"));
        assert!(error.contains("@openclaw/ai"));
    }

    /// Regression guard: Issue #127 merge keeps full provider map when the UI payload
    /// only touches one provider — `sync_providers_to_agent_models` must use the same
    /// merged view (see `write_openclaw_config`), not the raw `config` argument.
    #[test]
    fn partial_models_merge_retains_other_providers() {
        let existing = json!({
            "models": {
                "providers": {
                    "a": { "models": [{ "id": "m1" }] },
                    "b": { "models": [{ "id": "m2" }] }
                }
            }
        });
        let new = json!({
            "models": {
                "providers": {
                    "a": {
                        "baseUrl": "http://example",
                        "models": [{ "id": "m1" }]
                    }
                }
            }
        });
        let merged = merge_configs_preserving_fields(&existing, &new);
        let prov = merged
            .pointer("/models/providers")
            .and_then(|p| p.as_object())
            .expect("merged.models.providers");
        assert!(prov.contains_key("a"));
        assert!(
            prov.contains_key("b"),
            "merged config must retain provider b when the write payload omits it"
        );
        assert_eq!(prov["a"]["baseUrl"], json!("http://example"));
    }

    #[test]
    fn provider_null_tombstone_deletes_only_target_provider() {
        let existing = json!({
            "models": { "providers": {
                "a": { "models": [{ "id": "m1" }] },
                "b": { "models": [{ "id": "m2" }] }
            }},
            "browser": { "profiles": { "keep": {} } }
        });
        let patch = json!({ "models": { "providers": { "a": null } } });
        let merged = merge_configs_preserving_fields(&existing, &patch);
        assert!(merged["models"]["providers"].get("a").is_none());
        assert_eq!(
            merged["models"]["providers"]["b"]["models"][0]["id"],
            json!("m2")
        );
        assert!(merged["browser"]["profiles"].get("keep").is_some());
    }

    #[test]
    fn model_api_normalization_keeps_real_transport_identity() {
        assert_eq!(
            normalize_model_api_type("openai-responses"),
            "openai-responses"
        );
        assert_eq!(
            normalize_model_api_type("openai-codex-responses"),
            "openai-chatgpt-responses"
        );
        assert_eq!(normalize_model_api_type("ollama"), "ollama");
        assert_eq!(normalize_model_api_type("future-adapter"), "future-adapter");
    }

    #[test]
    fn strip_ui_fields_migrates_retired_api_at_provider_and_model_level() {
        let cleaned = strip_ui_fields(json!({
            "models": { "providers": { "legacy": {
                "api": "openai-codex-responses",
                "models": [
                    { "id": "gpt-test", "api": "openai-codex-responses" },
                    "legacy-string-model"
                ]
            }}}
        }));
        assert_eq!(
            cleaned["models"]["providers"]["legacy"]["api"],
            json!("openai-chatgpt-responses")
        );
        assert_eq!(
            cleaned["models"]["providers"]["legacy"]["models"][0]["api"],
            json!("openai-chatgpt-responses")
        );
        assert_eq!(
            cleaned["models"]["providers"]["legacy"]["models"][1],
            json!({ "id": "legacy-string-model", "name": "legacy-string-model" })
        );
    }

    #[test]
    fn verified_writer_round_trips_and_preserves_last_good_backup() {
        let root = unique_temp_dir("verified-config-write");
        let path = root.join("openclaw.json");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&path, r#"{"models":{"mode":"merge"}}"#).unwrap();
        let next = json!({
            "models": { "mode": "merge", "providers": {
                "custom": { "api": "openai-responses", "models": [{ "id": "gpt-test", "name": "GPT Test" }] }
            }}
        });

        write_verified_json_with_backup(&path, &next).unwrap();

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let backup: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("openclaw.json.bak")).unwrap())
                .unwrap();
        assert_eq!(written, next);
        assert_eq!(backup["models"]["mode"], json!("merge"));
        assert!(backup["models"].get("providers").is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn calibration_reset_inherits_memory_and_security_extensions() {
        let baseline = json!({
            "tools": {
                "profile": "full",
                "sessions": { "visibility": "all" }
            }
        });
        let seed = json!({
            "memory": {
                "qmd": { "rerank": false },
            },
            "security": {
                "installPolicy": {
                    "enabled": true,
                    "targets": ["skill", "plugin"]
                }
            },
            "secrets": {
                "defaults": { "source": "env", "provider": "default" },
                "providers": {
                    "vaultfile": {
                        "source": "file",
                        "path": "/etc/openclaw/secrets.json"
                    }
                }
            },
            "tui": {
                "footer": { "showRemoteHost": true }
            },
            "tools": {
                "toolSearch": { "enabled": true, "mode": "directory" },
                "web": { "search": { "backend": "parallel" } }
            }
        });

        let (next, inherited) = apply_reset_inheritance(baseline, &seed);

        assert!(inherited.contains(&"memory".to_string()));
        assert!(inherited.contains(&"security".to_string()));
        assert!(inherited.contains(&"secrets".to_string()));
        assert!(inherited.contains(&"tui".to_string()));
        assert!(inherited.contains(&"tools".to_string()));
        assert_eq!(next["memory"]["qmd"]["rerank"], json!(false));
        assert_eq!(
            next["security"]["installPolicy"]["targets"][1],
            json!("plugin")
        );
        assert_eq!(next["tui"]["footer"]["showRemoteHost"], json!(true));
        assert_eq!(
            next["secrets"]["providers"]["vaultfile"]["source"],
            json!("file")
        );
        assert_eq!(next["tools"]["profile"], json!("full"));
        assert_eq!(next["tools"]["toolSearch"]["mode"], json!("directory"));
        assert_eq!(next["tools"]["web"]["search"]["backend"], json!("parallel"));
    }

    #[test]
    fn strip_ui_fields_preserves_auth_profiles_metadata() {
        let config = json!({
            "current": "2026.6.11",
            "auth": {
                "profiles": {
                    "bedrock:default": {
                        "provider": "bedrock",
                        "mode": "aws-sdk"
                    }
                },
                "order": { "bedrock": ["bedrock:default"] }
            },
            "agents": {
                "profiles": {
                    "legacy-ui-field": {}
                },
                "list": []
            }
        });

        let cleaned = strip_ui_fields(config);

        assert!(cleaned.get("current").is_none());
        assert_eq!(
            cleaned["auth"]["profiles"]["bedrock:default"]["mode"],
            json!("aws-sdk")
        );
        assert!(cleaned["agents"].get("profiles").is_none());
    }

    #[test]
    fn partial_gateway_patch_preserves_auth_token() {
        let existing = json!({
            "gateway": {
                "auth": { "token": "secret-new" },
                "controlUi": { "allowedOrigins": ["http://localhost:3000"] }
            }
        });
        let patch = json!({
            "gateway": {
                "controlUi": {
                    "allowedOrigins": ["http://localhost:3000", "tauri://localhost"]
                }
            }
        });

        let merged = merge_configs_preserving_fields(&existing, &patch);

        assert_eq!(
            merged.pointer("/gateway/auth/token"),
            Some(&json!("secret-new"))
        );
        let origins = merged
            .pointer("/gateway/controlUi/allowedOrigins")
            .and_then(|v| v.as_array())
            .expect("allowedOrigins");
        assert!(origins.iter().any(|v| v == "tauri://localhost"));
    }

    #[test]
    fn select_calibration_source_prefers_current_over_richer_backup() {
        let current = json!({
            "models": { "providers": {} },
            "gateway": {
                "auth": { "mode": "token", "token": "secret-current" },
            }
        });
        let backup = json!({
            "models": {
                "providers": {
                    "old": { "type": "openai", "apiKey": "old" }
                }
            },
            "agents": {
                "defaults": { "workspace": "/tmp/work" },
                "list": [{ "id": "old-agent" }]
            },
            "channels": { "telegram": { "enabled": true } },
            "gateway": {
                "auth": { "mode": "token", "token": "secret-backup" },
                "controlUi": { "allowedOrigins": ["http://localhost:3000"] }
            }
        });

        assert!(calibration_richness_score(&backup) > calibration_richness_score(&current));
        let (source, seed) = select_calibration_source(Some(current.clone()), Some(backup));

        assert_eq!(source, "current");
        assert_eq!(seed, current);
    }

    #[test]
    fn select_calibration_source_uses_backup_when_current_empty() {
        let backup = json!({
            "models": {
                "providers": {
                    "old": { "type": "openai", "apiKey": "old" }
                }
            }
        });

        let (source, seed) = select_calibration_source(Some(json!({})), Some(backup.clone()));

        assert_eq!(source, "backup");
        assert_eq!(seed, backup);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_cli_input_rejects_extensionless_openclaw_shim() {
        let dir = unique_temp_dir("extensionless-openclaw");
        std::fs::create_dir_all(&dir).unwrap();
        let bare = dir.join("openclaw");
        std::fs::write(&bare, "#!/bin/sh\n").unwrap();

        let resolved = resolve_openclaw_cli_input_path(&bare);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            resolved.is_none(),
            "Windows must not treat extensionless npm shell shims as launchable CLI"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_cli_input_canonicalizes_bare_openclaw_to_cmd() {
        let dir = unique_temp_dir("openclaw-cmd");
        std::fs::create_dir_all(&dir).unwrap();
        let bare = dir.join("openclaw");
        let cmd = dir.join("openclaw.cmd");
        std::fs::write(&bare, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\r\n").unwrap();

        let resolved = resolve_openclaw_cli_input_path(&bare);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(resolved, Some(cmd));
    }

    #[test]
    fn node_requirement_rejects_versions_below_minimum() {
        assert!(!node_version_satisfies_requirement("v22.17.0", ">=22.19.0"));
    }

    #[test]
    fn node_requirement_accepts_minimum_and_newer_major() {
        assert!(node_version_satisfies_requirement("v22.19.0", ">=22.19.0"));
        assert!(node_version_satisfies_requirement("v24.0.0", ">=22.19.0"));
    }

    #[test]
    fn openclaw_node_requirement_fallback_tracks_runtime_floors() {
        assert_eq!(fallback_openclaw_node_requirement("2026.6.4"), None);
        assert_eq!(
            fallback_openclaw_node_requirement("2026.6.5-zh.1"),
            Some(">=22.19.0")
        );
        assert_eq!(
            fallback_openclaw_node_requirement("2026.7.1"),
            Some(">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0")
        );
        assert_eq!(
            fallback_openclaw_node_requirement("2026.7.1-zh.1"),
            Some(">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0")
        );
    }

    #[test]
    fn openclaw_2026_7_1_node_range_rejects_unsupported_gaps() {
        let requirement = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";
        assert!(!node_version_satisfies_requirement("v22.22.2", requirement));
        assert!(node_version_satisfies_requirement("v22.22.3", requirement));
        assert!(!node_version_satisfies_requirement("v23.11.1", requirement));
        assert!(!node_version_satisfies_requirement("v24.14.9", requirement));
        assert!(node_version_satisfies_requirement("v24.15.0", requirement));
        assert!(!node_version_satisfies_requirement("v25.8.9", requirement));
        assert!(node_version_satisfies_requirement("v25.9.0", requirement));
        assert!(node_version_satisfies_requirement("v33.0.0", requirement));
    }

    #[test]
    fn node_requirement_supports_common_or_ranges() {
        assert!(node_version_satisfies_requirement(
            "v22.20.0",
            "^22.19.0 || >=24.0.0"
        ));
        assert!(!node_version_satisfies_requirement(
            "v23.0.0",
            "^22.19.0 || >=24.0.0"
        ));
        assert!(node_version_satisfies_requirement(
            "v24.1.0",
            "^22.19.0 || >=24.0.0"
        ));
    }

    fn test_portable_ctx(root: &Path) -> crate::commands::portable::PortableContext {
        crate::commands::portable::PortableContext {
            root: root.to_path_buf(),
            data_dir: root.join("data"),
            panel_config_path: root.join("data").join("clawpanel").join("clawpanel.json"),
            openclaw_dir: root.join("data").join("openclaw"),
            hermes_home: root.join("data").join("hermes"),
            node_dir: None,
            engines_openclaw_dir: root.join("engines").join("openclaw"),
            engines_hermes_dir: root.join("engines").join("hermes"),
            openclaw_cli_path: None,
            hermes_cli_path: None,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn standalone_install_dir_portable_stays_inside_root() {
        let root = unique_temp_dir("portable-install-root");
        let ctx = test_portable_ctx(&root);
        let dir = standalone_install_dir_impl(Some(&ctx)).unwrap();
        assert!(dir.starts_with(&root), "安装目录必须在 portable root 内");
        assert_eq!(dir, root.join("engines").join("openclaw"));
    }

    #[test]
    fn standalone_install_dir_normal_mode_unchanged() {
        let dir = standalone_install_dir_impl(None);
        #[cfg(target_os = "windows")]
        {
            let expected = std::env::var("LOCALAPPDATA")
                .ok()
                .map(|d| PathBuf::from(d).join("Programs").join("OpenClaw"));
            assert_eq!(dir, expected);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let expected = dirs::home_dir().map(|h| h.join(".openclaw-bin"));
            assert_eq!(dir, expected);
        }
    }

    #[test]
    fn npm_fallback_blocked_in_portable_mode() {
        // 便携模式：无论当前安装模式如何，auto 均不得降级到 npm 全局安装
        for mode in ["unknown", "npm", "standalone", "portable"] {
            assert!(!should_fallback_standalone_to_npm(mode, "auto", true));
        }
        // 普通模式原行为不变
        assert!(should_fallback_standalone_to_npm("npm", "auto", false));
        assert!(should_fallback_standalone_to_npm("unknown", "auto", false));
        assert!(!should_fallback_standalone_to_npm(
            "standalone",
            "auto",
            false
        ));
        assert!(!should_fallback_standalone_to_npm(
            "portable", "auto", false
        ));
        // 非 auto 方式从不触发降级分支
        assert!(!should_fallback_standalone_to_npm(
            "npm",
            "standalone-r2",
            false
        ));
    }

    #[test]
    fn standalone_version_uses_recommended_for_portable_without_explicit_version() {
        assert_eq!(
            standalone_install_version(None, Some("2026.5.18-zh.1"), "auto", true),
            "2026.5.18-zh.1"
        );
    }

    #[test]
    fn standalone_version_uses_recommended_for_explicit_standalone_method() {
        assert_eq!(
            standalone_install_version(None, Some("2026.5.18-zh.1"), "standalone-r2", false),
            "2026.5.18-zh.1"
        );
        assert_eq!(
            standalone_install_version(None, Some("2026.5.18-zh.1"), "standalone-github", false),
            "2026.5.18-zh.1"
        );
    }

    #[test]
    fn standalone_version_keeps_recommended_for_auto_non_portable() {
        assert_eq!(
            standalone_install_version(None, Some("2026.5.18-zh.1"), "auto", false),
            "2026.5.18-zh.1"
        );
    }

    #[test]
    fn standalone_version_keeps_explicit_requested_version() {
        assert_eq!(
            standalone_install_version(
                Some("2026.6.1-zh.1"),
                Some("2026.5.18-zh.1"),
                "standalone-r2",
                true
            ),
            "2026.6.1-zh.1"
        );
    }

    #[test]
    fn cli_binding_path_omits_curdir_components() {
        let path = PathBuf::from(r"U:\ClawPanelPortable\.\engines\openclaw\openclaw.cmd");
        assert_eq!(
            path_without_curdir_string(&path),
            r"U:\ClawPanelPortable\engines\openclaw\openclaw.cmd"
        );
    }

    #[test]
    fn standalone_extract_promotes_nested_dir_over_existing_files() {
        let dir = unique_temp_dir("standalone-promote");
        std::fs::create_dir_all(dir.join("openclaw")).unwrap();
        std::fs::write(dir.join("openclaw.cmd"), b"old").unwrap();
        std::fs::write(dir.join("VERSION"), b"old").unwrap();
        let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(dir.join("openclaw").join(node_bin), b"node").unwrap();
        std::fs::write(dir.join("openclaw").join("openclaw.cmd"), b"new").unwrap();
        std::fs::write(dir.join("openclaw").join("VERSION"), b"new").unwrap();

        promote_nested_standalone_dir(&dir, node_bin).unwrap();

        assert!(!dir.join("openclaw").exists());
        assert_eq!(std::fs::read(dir.join("openclaw.cmd")).unwrap(), b"new");
        assert_eq!(std::fs::read(dir.join("VERSION")).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn standalone_bundled_node_bin_resolves_next_to_cli() {
        let dir = unique_temp_dir("standalone-bundled-node");
        std::fs::create_dir_all(&dir).unwrap();
        let cli_path = dir.join("openclaw.cmd");
        std::fs::write(&cli_path, "@echo off\r\n").unwrap();
        #[cfg(target_os = "windows")]
        let node_name = "node.exe";
        #[cfg(not(target_os = "windows"))]
        let node_name = "node";
        let node_bin = dir.join(node_name);
        std::fs::write(&node_bin, "").unwrap();

        let resolved = standalone_bundled_node_bin(&cli_path.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(resolved, Some(node_bin));
    }

    #[test]
    fn unchanged_external_env_reference_does_not_block_unrelated_save() {
        let previous = json!({
            "models": { "providers": { "external": {
                "apiKey": "${CLAWPANEL_TEST_EXTERNAL_ONLY}"
            } } }
        });
        let unchanged = json!({
            "models": { "providers": { "external": {
                "apiKey": "${CLAWPANEL_TEST_EXTERNAL_ONLY}"
            } } },
            "gateway": { "port": 18789 }
        });
        assert!(validate_model_provider_env_refs(&unchanged, Some(&previous)).is_ok());

        let changed = json!({
            "models": { "providers": { "external": {
                "apiKey": "${CLAWPANEL_TEST_NEW_MISSING}"
            } } }
        });
        let error = validate_model_provider_env_refs(&changed, Some(&previous)).unwrap_err();
        assert!(error.contains("CLAWPANEL_TEST_NEW_MISSING"));
    }

    #[test]
    fn structured_secret_ref_never_becomes_fake_plaintext() {
        let missing_env = json!({
            "source": "env",
            "provider": "default",
            "id": "CLAWPANEL_TEST_SECRET_REF_MISSING"
        });
        let error = resolve_model_api_key_value(&missing_env).unwrap_err();
        assert!(error.contains("CLAWPANEL_TEST_SECRET_REF_MISSING"));

        let file_ref = json!({
            "source": "file",
            "provider": "default",
            "id": "providers/openai/apiKey"
        });
        let error = resolve_model_api_key_value(&file_ref).unwrap_err();
        assert!(error.contains("OpenClaw") && error.contains("运行时"));
    }

    #[test]
    fn native_config_reload_starts_at_openclaw_2026_7_1() {
        assert!(!supports_native_config_reload("2026.6.5"));
        assert!(supports_native_config_reload("2026.7.1"));
        assert!(supports_native_config_reload("2026.7.1-zh.2"));
    }
}
