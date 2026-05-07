//! 检测和清理 PATH 中残留的非 standalone OpenClaw 安装
//!
//! ## 用户场景
//!
//! 用户系统可能装了多个 OpenClaw（CherryStudio 自带、旧 npm 全局、手动下载等），
//! 它们与 ClawPanel 管理的 standalone 共存时会引起：
//! - 用户在终端用 `openclaw` 时拿到老版本，schema 与 standalone 不兼容 → doctor --fix 卡死
//! - 第三方工具调用 openclaw 时拿到老版本
//! - PATH 优先级影响 Tauri 后端选择 CLI（虽然 `is_rejected_cli_path` 排除了 cherrystudio，
//!   但其他来源仍可能漏过）
//!
//! ## 本模块功能
//!
//! - **扫描**：列出 PATH 中所有非 standalone 的 openclaw 可执行文件
//! - **隔离**：把指定路径重命名为 `<原名>.disabled-by-clawpanel-<ts>.bak`，**不真删**
//! - **列出已隔离**：扫描 PATH 中现有的 `.bak` 文件
//! - **恢复**：把 `.bak` 改回原名
//!
//! 隔离而非删除，是为了让用户/被影响的第三方软件可以恢复，避免 ClawPanel 越界破坏用户系统。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConflict {
    /// 冲突的 openclaw 可执行文件绝对路径
    pub path: String,
    /// 来源识别：`cherrystudio` / `npm-global` / `unknown`
    pub source: String,
    /// 人类可读的来源描述
    pub source_label: String,
    /// 从同目录 / 父目录 package.json 读到的版本（不调用 CLI 防止卡死）
    pub version: Option<String>,
    /// 文件大小（bytes）
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineRecord {
    /// 隔离前的原始路径（可读，未必当前还存在）
    pub original_path: String,
    /// 隔离后的 `.bak` 文件路径
    pub quarantined_path: String,
    /// ISO-8601 时间戳
    pub quarantined_at: String,
}

/// 一键隔离结果统计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkQuarantineResult {
    pub records: Vec<QuarantineRecord>,
    pub failed: Vec<BulkQuarantineFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkQuarantineFailure {
    pub path: String,
    pub error: String,
}

/// 标准化路径用于比较：转换为 lowercase 字符串（Windows 不区分大小写），
/// `/` 和 `\` 统一为 `/`，去掉尾部分隔符。
fn canonical_lower(path: &Path) -> String {
    let canon = path
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let mut s = canon.replace('\\', "/").to_lowercase();
    // 去掉 Windows 上 canonicalize() 加的 \\?\ 前缀
    if let Some(stripped) = s.strip_prefix("//?/") {
        s = stripped.to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    s
}

/// 候选可执行文件名（带扩展名）
fn executable_candidates(dir: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        vec![
            dir.join("openclaw.exe"),
            dir.join("openclaw.cmd"),
            dir.join("openclaw.bat"),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join("openclaw")]
    }
}

/// 来源识别：路径关键字匹配
fn detect_source(path: &Path) -> (&'static str, &'static str) {
    let s = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if s.contains("/.cherrystudio/") || s.contains("cherry-studio") {
        ("cherrystudio", "Cherry Studio 内嵌")
    } else if s.contains("/.cursor/") || s.contains("/cursor/") {
        ("cursor", "Cursor 内嵌")
    } else if s.contains("/node_modules/.bin/")
        || s.contains("/npm/")
        || s.contains("\\npm\\")
        || s.contains("/.npm-global/")
    {
        ("npm-global", "npm 全局安装")
    } else {
        ("unknown", "未识别来源")
    }
}

/// 尝试从同目录 / 父目录的 `package.json` 读取版本号。
/// **不主动调用** openclaw 二进制 —— 避免被损坏或老旧的 CLI 卡死扫描流程。
fn try_get_version(path: &Path) -> Option<String> {
    let dir = path.parent()?;
    let mut candidates = vec![dir.join("package.json")];
    if let Some(parent) = dir.parent() {
        candidates.push(parent.join("package.json"));
        // 常见 npm 全局：xxx/openclaw 包目录在 node_modules/openclaw 下
        candidates.push(
            parent
                .join("node_modules")
                .join("openclaw")
                .join("package.json"),
        );
        candidates.push(
            parent
                .join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh")
                .join("package.json"),
        );
    }

    for pkg in candidates.iter().filter(|p| p.exists()) {
        let Ok(content) = std::fs::read_to_string(pkg) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        // 必须是 openclaw 相关的包
        let name = json.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let is_openclaw_pkg =
            name == "openclaw" || name == "@qingchencloud/openclaw-zh" || name.contains("openclaw");
        if !is_openclaw_pkg {
            continue;
        }
        if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
            return Some(v.to_string());
        }
    }
    None
}

/// 扫描 PATH 中所有非 standalone 的 openclaw 可执行文件
#[tauri::command]
pub async fn scan_openclaw_path_conflicts() -> Result<Vec<CliConflict>, String> {
    let mut conflicts = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let standalone_canon: Vec<String> = crate::commands::config::all_standalone_dirs()
        .iter()
        .map(|p| canonical_lower(p))
        .filter(|s| !s.is_empty())
        .collect();

    let path_var = crate::commands::enhanced_path();
    #[cfg(target_os = "windows")]
    let separator = ';';
    #[cfg(not(target_os = "windows"))]
    let separator = ':';

    for dir_str in path_var.split(separator) {
        let dir = Path::new(dir_str.trim());
        if dir.as_os_str().is_empty() || !dir.is_dir() {
            continue;
        }

        for candidate in executable_candidates(dir) {
            if !candidate.exists() {
                continue;
            }

            let canon = canonical_lower(&candidate);
            if !seen.insert(canon.clone()) {
                continue;
            }

            // 跳过 standalone 目录下的（这是当前在用的合法版本）
            let is_standalone = standalone_canon
                .iter()
                .any(|sa| !sa.is_empty() && canon.starts_with(sa));
            if is_standalone {
                continue;
            }

            let (source, source_label) = detect_source(&candidate);
            let size_bytes = std::fs::metadata(&candidate).ok().map(|m| m.len());
            let version = try_get_version(&candidate);

            conflicts.push(CliConflict {
                path: candidate.to_string_lossy().to_string(),
                source: source.to_string(),
                source_label: source_label.to_string(),
                version,
                size_bytes,
            });
        }
    }

    Ok(conflicts)
}

/// 把指定路径的 openclaw 可执行文件重命名为 `.disabled-by-clawpanel-<ts>.bak`
#[tauri::command]
pub async fn quarantine_openclaw_path(path: String) -> Result<QuarantineRecord, String> {
    let original = PathBuf::from(&path);
    if !original.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if !original.is_file() {
        return Err(format!("不是文件: {}", path));
    }

    // 安全检查 1：拒绝隔离 standalone 目录下的文件
    let canon = canonical_lower(&original);
    let standalone_dirs = crate::commands::config::all_standalone_dirs();
    for sa in &standalone_dirs {
        let sa_canon = canonical_lower(sa);
        if !sa_canon.is_empty() && canon.starts_with(&sa_canon) {
            return Err("拒绝隔离 standalone 安装目录下的 OpenClaw（这是当前运行版本）".into());
        }
    }

    // 安全检查 2：文件名必须以 openclaw 开头（防止误用接口隔离别的文件）
    let file_name = original
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无效的文件名".to_string())?;
    if !file_name.to_lowercase().starts_with("openclaw") {
        return Err(format!("拒绝隔离非 openclaw 文件: {}", file_name));
    }

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let new_name = format!("{}.disabled-by-clawpanel-{}.bak", file_name, ts);
    let parent = original
        .parent()
        .ok_or_else(|| "无法解析父目录".to_string())?;
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(format!(
            "目标文件已存在，请稍后再试: {}",
            new_path.display()
        ));
    }

    std::fs::rename(&original, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    // 刷新 PATH 缓存，让 Tauri 后端立刻看到变化
    crate::commands::refresh_enhanced_path();

    Ok(QuarantineRecord {
        original_path: original.to_string_lossy().to_string(),
        quarantined_path: new_path.to_string_lossy().to_string(),
        quarantined_at: chrono::Local::now().to_rfc3339(),
    })
}

/// 一键隔离多个冲突路径。即使部分失败，已成功的不会回滚。
#[tauri::command]
pub async fn quarantine_openclaw_paths_bulk(
    paths: Vec<String>,
) -> Result<BulkQuarantineResult, String> {
    let mut records = Vec::new();
    let mut failed = Vec::new();

    for p in paths {
        match quarantine_openclaw_path(p.clone()).await {
            Ok(rec) => records.push(rec),
            Err(e) => failed.push(BulkQuarantineFailure { path: p, error: e }),
        }
    }

    Ok(BulkQuarantineResult { records, failed })
}

/// 解析 `<original>.disabled-by-clawpanel-<digits>.bak` 中的 `<original>`
fn parse_quarantined_name(name: &str) -> Option<&str> {
    if !name.ends_with(".bak") {
        return None;
    }
    let marker = ".disabled-by-clawpanel-";
    let pos = name.rfind(marker)?;
    // marker 之后必须是 数字-数字 / 数字 这种 timestamp，简单做法只校验 marker 之后到 .bak 之间不为空
    let between = &name[pos + marker.len()..name.len() - 4];
    if between.is_empty() {
        return None;
    }
    Some(&name[..pos])
}

/// 列出 PATH 中所有已隔离的 `.bak` 文件
#[tauri::command]
pub async fn list_quarantined_openclaw() -> Result<Vec<QuarantineRecord>, String> {
    let mut records = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let path_var = crate::commands::enhanced_path();
    #[cfg(target_os = "windows")]
    let separator = ';';
    #[cfg(not(target_os = "windows"))]
    let separator = ':';

    for dir_str in path_var.split(separator) {
        let dir = Path::new(dir_str.trim());
        if dir.as_os_str().is_empty() || !dir.is_dir() {
            continue;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            // 仅看 openclaw 相关
            if !name.to_lowercase().starts_with("openclaw") {
                continue;
            }
            let Some(orig_name) = parse_quarantined_name(&name) else {
                continue;
            };

            let canon = canonical_lower(&path);
            if !seen.insert(canon) {
                continue;
            }

            let original_path = dir.join(orig_name);
            let mtime_iso = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.to_rfc3339()
                })
                .unwrap_or_default();

            records.push(QuarantineRecord {
                original_path: original_path.to_string_lossy().to_string(),
                quarantined_path: path.to_string_lossy().to_string(),
                quarantined_at: mtime_iso,
            });
        }
    }

    Ok(records)
}

/// 撤销隔离：把 `.bak` 改回原始文件名
#[tauri::command]
pub async fn restore_quarantined_openclaw(quarantined_path: String) -> Result<String, String> {
    let qpath = PathBuf::from(&quarantined_path);
    if !qpath.exists() {
        return Err(format!("隔离文件不存在: {}", quarantined_path));
    }
    if !qpath.is_file() {
        return Err(format!("不是文件: {}", quarantined_path));
    }

    let file_name = qpath
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无效的文件名".to_string())?;
    let original_name = parse_quarantined_name(file_name)
        .ok_or_else(|| format!("不是 ClawPanel 隔离文件，无法恢复: {}", file_name))?;

    let parent = qpath.parent().ok_or_else(|| "无法解析父目录".to_string())?;
    let original_path = parent.join(original_name);

    if original_path.exists() {
        return Err(format!(
            "目标位置已存在文件，无法恢复: {}",
            original_path.display()
        ));
    }

    std::fs::rename(&qpath, &original_path).map_err(|e| format!("恢复失败: {}", e))?;
    crate::commands::refresh_enhanced_path();

    Ok(original_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_quarantined_name_basic() {
        assert_eq!(
            parse_quarantined_name("openclaw.exe.disabled-by-clawpanel-20260507-153012.bak"),
            Some("openclaw.exe")
        );
        assert_eq!(
            parse_quarantined_name("openclaw.cmd.disabled-by-clawpanel-12345.bak"),
            Some("openclaw.cmd")
        );
    }

    #[test]
    fn parse_quarantined_name_invalid() {
        assert_eq!(parse_quarantined_name("openclaw.exe"), None);
        assert_eq!(parse_quarantined_name("openclaw.exe.bak"), None);
        assert_eq!(
            parse_quarantined_name("openclaw.exe.disabled-by-clawpanel-.bak"),
            None
        );
        assert_eq!(parse_quarantined_name("not-related.bak"), None);
    }

    #[test]
    fn detect_source_cherrystudio() {
        let p = PathBuf::from(r"C:\Users\u\.cherrystudio\bin\openclaw.exe");
        let (key, _) = detect_source(&p);
        assert_eq!(key, "cherrystudio");
    }

    #[test]
    fn detect_source_npm_global() {
        let p = PathBuf::from(r"C:\Users\u\AppData\Roaming\npm\openclaw.cmd");
        let (key, _) = detect_source(&p);
        assert_eq!(key, "npm-global");
    }
}
