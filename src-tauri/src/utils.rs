#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedOpenClawCli {
    pub selected_path: Option<std::path::PathBuf>,
    pub version: Option<String>,
    pub distribution_source: Option<String>,
    pub path_source: Option<String>,
    pub candidates: Vec<String>,
    pub selected_from_config: bool,
}

#[cfg(target_os = "windows")]
fn windows_candidate_cli_paths() -> Vec<std::path::PathBuf> {
    use std::env;
    use std::path::Path;

    let mut candidates = Vec::new();

    if let Some(configured) = crate::commands::configured_openclaw_path() {
        candidates.push(std::path::PathBuf::from(configured.trim()));
    }

    if let Ok(localappdata) = env::var("LOCALAPPDATA") {
        candidates.push(Path::new(&localappdata).join("Programs").join("OpenClaw").join("openclaw.cmd"));
        candidates.push(Path::new(&localappdata).join("OpenClaw").join("openclaw.cmd"));
    }
    if let Ok(pf) = env::var("ProgramFiles") {
        candidates.push(Path::new(&pf).join("OpenClaw").join("openclaw.cmd"));
    }
    if let Ok(appdata) = env::var("APPDATA") {
        candidates.push(Path::new(&appdata).join("npm").join("openclaw.cmd"));
        candidates.push(Path::new(&appdata).join("npm").join("openclaw"));
    }

    for dir in crate::commands::enhanced_path().split(';') {
        let trimmed = dir.trim();
        if trimmed.is_empty() {
            continue;
        }
        let base = Path::new(trimmed);
        candidates.push(base.join("openclaw.cmd"));
        candidates.push(base.join("openclaw"));
    }

    candidates
}

#[cfg(target_os = "windows")]
fn normalize_cli_candidate(path: std::path::PathBuf) -> Option<std::path::PathBuf> {
    if !path.exists() {
        return None;
    }
    let text = path.to_string_lossy().to_ascii_lowercase();
    if text.contains(".cherrystudio") || text.contains("cherry-studio") {
        return None;
    }
    Some(path)
}

#[cfg(target_os = "windows")]
fn dedupe_cli_candidates(paths: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in paths.into_iter().filter_map(normalize_cli_candidate) {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn detect_distribution_from_cli_path(path: &std::path::Path) -> Option<String> {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.contains("openclaw-zh") || lower.contains("qingchencloud") {
        return Some("chinese".to_string());
    }

    let base = path.parent()?;
    let zh_pkg = base
        .join("node_modules")
        .join("@qingchencloud")
        .join("openclaw-zh");
    if zh_pkg.exists() {
        return Some("chinese".to_string());
    }

    let official_pkg = base.join("node_modules").join("openclaw");
    if official_pkg.exists() {
        return Some("official".to_string());
    }

    if lower.ends_with("openclaw.cmd") || lower.ends_with("\\openclaw") {
        return Some("official".to_string());
    }

    None
}

#[cfg(target_os = "windows")]
fn detect_cli_version(path: &std::path::Path, distribution_source: Option<&str>) -> Option<String> {
    let base = path.parent()?;
    let package_dir = match distribution_source {
        Some("chinese") => Some(
            base.join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh"),
        ),
        Some("official") => Some(base.join("node_modules").join("openclaw")),
        _ => {
            let zh = base
                .join("node_modules")
                .join("@qingchencloud")
                .join("openclaw-zh");
            if zh.exists() {
                Some(zh)
            } else {
                Some(base.join("node_modules").join("openclaw"))
            }
        }
    }?;

    let package_json = package_dir.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&package_json) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ver) = json.get("version").and_then(|v| v.as_str()) {
                return Some(ver.to_string());
            }
        }
    }

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/c").arg(path).arg("--version");
    crate::commands::apply_system_env(&mut cmd);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    raw.split_whitespace().last().map(|s| s.to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_openclaw_cli() -> ResolvedOpenClawCli {
    let configured = crate::commands::configured_openclaw_path();
    let candidates = dedupe_cli_candidates(windows_candidate_cli_paths());
    let selected_path = candidates.first().cloned();
    let distribution_source = selected_path
        .as_deref()
        .and_then(detect_distribution_from_cli_path);
    let version = selected_path
        .as_deref()
        .and_then(|path| detect_cli_version(path, distribution_source.as_deref()));
    let path_source = selected_path.as_ref().map(|path| {
        let text = path.to_string_lossy();
        let lower = text.to_ascii_lowercase();
        if configured
            .as_ref()
            .is_some_and(|cfg| cfg.trim().eq_ignore_ascii_case(&text))
        {
            "configured".to_string()
        } else if lower.contains("appdata") && lower.contains("npm") {
            "npm-global".to_string()
        } else if lower.contains("programs\\openclaw") || lower.contains("program files\\openclaw") {
            "standalone".to_string()
        } else if lower.contains("nvm") {
            "nvm-path".to_string()
        } else {
            "path".to_string()
        }
    });

    ResolvedOpenClawCli {
        selected_path,
        version,
        distribution_source,
        path_source,
        candidates: candidates
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        selected_from_config: configured.is_some(),
    }
}

/// Windows: 在 PATH 中查找 openclaw.cmd 的完整路径
/// 避免通过 `cmd /c openclaw` 调用时 npm .cmd shim 中的引号导致
/// "\"node\"" is not recognized 错误
#[cfg(target_os = "windows")]
pub(crate) fn find_openclaw_cmd() -> Option<std::path::PathBuf> {
    resolve_openclaw_cli().selected_path
}

/// 跨平台获取 openclaw 命令的方法（同步版本）
#[allow(dead_code)]
pub fn openclaw_command() -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _enhanced = crate::commands::enhanced_path();
        // 优先：找到 openclaw.cmd 完整路径，用 cmd /c "完整路径" 避免引号问题
        if let Some(cmd_path) = find_openclaw_cmd() {
            let mut cmd = std::process::Command::new("cmd");
            cmd.arg("/c").arg(cmd_path);
            crate::commands::apply_system_env(&mut cmd);
            crate::commands::apply_proxy_env(&mut cmd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
        // 兜底：直接用 cmd /c openclaw
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/c").arg("openclaw");
        crate::commands::apply_system_env(&mut cmd);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = std::process::Command::new("openclaw");
        crate::commands::apply_system_env(&mut cmd);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd
    }
}

/// 异步版本的 openclaw 命令（推荐使用，避免阻塞 UI）
pub fn openclaw_command_async() -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _enhanced = crate::commands::enhanced_path();
        // 优先：找到 openclaw.cmd 完整路径
        if let Some(cmd_path) = find_openclaw_cmd() {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/c").arg(cmd_path);
            crate::commands::apply_system_env_tokio(&mut cmd);
            crate::commands::apply_proxy_env_tokio(&mut cmd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
        // 兜底
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/c").arg("openclaw");
        crate::commands::apply_system_env_tokio(&mut cmd);
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("openclaw");
        crate::commands::apply_system_env_tokio(&mut cmd);
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        cmd
    }
}
