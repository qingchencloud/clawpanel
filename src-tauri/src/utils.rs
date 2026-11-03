#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 后台子进程统一禁止Windows控制台；调用方的参数、环境、stdio与权限保持不变。
pub fn background_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let command = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(target_os = "windows"))]
    command
}

/// Tokio后台子进程同样在创建时应用隐藏策略，避免版本与状态探针漏设。
pub fn background_command_async(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let command = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(target_os = "windows"))]
    command
}

#[cfg(target_os = "windows")]
fn push_unique_candidate(
    candidates: &mut Vec<std::path::PathBuf>,
    seen: &mut std::collections::HashSet<String>,
    path: std::path::PathBuf,
) {
    let key = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if seen.insert(key) {
        candidates.push(path);
    }
}

#[cfg(target_os = "windows")]
fn push_windows_cli_files(
    candidates: &mut Vec<std::path::PathBuf>,
    seen: &mut std::collections::HashSet<String>,
    base: std::path::PathBuf,
) {
    push_unique_candidate(candidates, seen, base.join("openclaw.cmd"));
    push_unique_candidate(candidates, seen, base.join("openclaw.exe"));
    push_unique_candidate(candidates, seen, base.join("openclaw.bat"));
    push_unique_candidate(candidates, seen, base.join("openclaw.js"));
    push_unique_candidate(
        candidates,
        seen,
        base.join("node_modules")
            .join("@qingchencloud")
            .join("openclaw-zh")
            .join("bin")
            .join("openclaw.js"),
    );
    push_unique_candidate(
        candidates,
        seen,
        base.join("node_modules")
            .join("openclaw")
            .join("bin")
            .join("openclaw.js"),
    );
}

#[cfg(target_os = "windows")]
fn common_windows_cli_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 先按 enhanced PATH 顺序找，保持与用户命令行优先级一致。
    for dir in crate::commands::enhanced_path().split(';') {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        push_windows_cli_files(&mut candidates, &mut seen, std::path::PathBuf::from(dir));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            std::path::PathBuf::from(appdata).join("npm"),
        );
    }
    if let Some(prefix) = crate::commands::windows_npm_global_prefix() {
        push_windows_cli_files(&mut candidates, &mut seen, std::path::PathBuf::from(prefix));
    }
    for sa_dir in crate::commands::config::all_standalone_dirs() {
        push_windows_cli_files(&mut candidates, &mut seen, sa_dir);
    }
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let localappdata = std::path::PathBuf::from(localappdata);
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            localappdata.join("Programs").join("OpenClaw"),
        );
        push_windows_cli_files(&mut candidates, &mut seen, localappdata.join("OpenClaw"));
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            localappdata.join("Programs").join("nodejs"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let program_files = std::path::PathBuf::from(program_files);
        push_windows_cli_files(&mut candidates, &mut seen, program_files.join("nodejs"));
        push_windows_cli_files(&mut candidates, &mut seen, program_files.join("OpenClaw"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            std::path::PathBuf::from(program_files_x86).join("nodejs"),
        );
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            std::path::PathBuf::from(profile).join(".openclaw-bin"),
        );
    }
    for drive in ["C", "D", "E", "F", "G"] {
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            std::path::PathBuf::from(format!(r"{drive}:\OpenClaw")),
        );
        push_windows_cli_files(
            &mut candidates,
            &mut seen,
            std::path::PathBuf::from(format!(r"{drive}:\AI\OpenClaw")),
        );
    }

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut where_cmd = crate::utils::background_command("where");
    where_cmd.arg("openclaw");
    where_cmd.env("PATH", crate::commands::enhanced_path());
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    push_unique_candidate(
                        &mut candidates,
                        &mut seen,
                        std::path::PathBuf::from(trimmed),
                    );
                }
            }
        }
    }

    candidates
}

#[cfg(target_os = "windows")]
pub fn is_windows_launchable_openclaw_path(path: &std::path::Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        file_name.as_str(),
        "openclaw.cmd" | "openclaw.exe" | "openclaw.bat" | "openclaw.js"
    )
}

#[cfg(target_os = "windows")]
pub fn canonicalize_windows_openclaw_cli_path(
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        file_name.as_str(),
        "openclaw" | "openclaw.exe" | "openclaw.ps1"
    ) {
        for name in [
            "openclaw.cmd",
            "openclaw.exe",
            "openclaw.bat",
            "openclaw.js",
        ] {
            let candidate = path.with_file_name(name);
            if candidate.exists() && !is_rejected_cli_path(&candidate.to_string_lossy()) {
                return Some(candidate);
            }
        }
    }
    if path.exists()
        && is_windows_launchable_openclaw_path(path)
        && !is_rejected_cli_path(&path.to_string_lossy())
    {
        return Some(path.to_path_buf());
    }
    None
}

pub fn is_rejected_cli_path(cli_path: &str) -> bool {
    let lower = cli_path.replace('\\', "/").to_lowercase();
    lower.contains("/.cherrystudio/") || lower.contains("cherry-studio")
}

/// 便携模式下 U 盘 engines/openclaw 里的 CLI（存在才返回），优先级最高；
/// 缺失时正常回退本机链路，支持"数据便携 + 本机引擎"混合形态
fn portable_cli_path() -> Option<std::path::PathBuf> {
    crate::commands::portable::portable_context()?
        .openclaw_cli_path
        .clone()
}

/// 读取 clawpanel.json 中用户绑定的 CLI 路径
fn bound_cli_path() -> Option<std::path::PathBuf> {
    let config = crate::commands::read_panel_config_value()?;
    let raw = config.get("openclawCliPath")?.as_str()?;
    if raw.is_empty() {
        return None;
    }
    let p = std::path::PathBuf::from(raw);
    crate::commands::config::resolve_openclaw_cli_input_path(&p)
}

fn apply_openclaw_dir_env(cmd: &mut std::process::Command) {
    let openclaw_dir = crate::commands::openclaw_dir();
    let config_path = openclaw_dir.join("openclaw.json");
    cmd.env("OPENCLAW_HOME", &openclaw_dir);
    cmd.env("OPENCLAW_STATE_DIR", &openclaw_dir);
    cmd.env("OPENCLAW_CONFIG_PATH", &config_path);
}

fn apply_openclaw_dir_env_tokio(cmd: &mut tokio::process::Command) {
    let openclaw_dir = crate::commands::openclaw_dir();
    let config_path = openclaw_dir.join("openclaw.json");
    cmd.env("OPENCLAW_HOME", &openclaw_dir);
    cmd.env("OPENCLAW_STATE_DIR", &openclaw_dir);
    cmd.env("OPENCLAW_CONFIG_PATH", &config_path);
}

fn configured_cli_candidates() -> Vec<std::path::PathBuf> {
    crate::commands::openclaw_search_paths()
        .into_iter()
        .filter_map(|p| crate::commands::config::resolve_openclaw_cli_input_path(&p))
        .filter(|p| !is_rejected_cli_path(&p.to_string_lossy()))
        .collect()
}

/// Windows: 在 PATH 和常见安装目录中查找 openclaw CLI 的完整路径
/// 避免通过 `cmd /c openclaw` 调用时 npm .cmd shim 中的引号导致
/// "\"node\"" is not recognized 错误
#[cfg(target_os = "windows")]
fn find_openclaw_cmd() -> Option<std::path::PathBuf> {
    // 便携模式：U 盘引擎优先
    if let Some(portable) = portable_cli_path() {
        return Some(portable);
    }
    // 优先使用用户绑定的路径
    if let Some(bound) = bound_cli_path() {
        return Some(bound);
    }
    for candidate in configured_cli_candidates() {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    common_windows_cli_candidates()
        .into_iter()
        .find_map(|candidate| canonicalize_windows_openclaw_cli_path(&candidate))
}

#[cfg(not(target_os = "windows"))]
fn common_non_windows_cli_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    // standalone 安装目录（集中管理，避免多处硬编码）
    for sa_dir in crate::commands::config::all_standalone_dirs() {
        candidates.push(sa_dir.join("openclaw"));
    }
    // 其他标准路径
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join("openclaw"));
    }
    candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/openclaw"));
    candidates.push(std::path::PathBuf::from("/usr/local/bin/openclaw"));
    candidates.push(std::path::PathBuf::from("/usr/bin/openclaw"));
    candidates
}

/// 解析当前实际使用的 openclaw CLI 完整路径（跨平台）
pub fn resolve_openclaw_cli_path() -> Option<String> {
    // 便携模式：U 盘引擎优先
    if let Some(portable) = portable_cli_path() {
        return Some(portable.to_string_lossy().to_string());
    }
    // 优先使用用户绑定的路径
    if let Some(bound) = bound_cli_path() {
        return Some(bound.to_string_lossy().to_string());
    }
    for candidate in configured_cli_candidates() {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        find_openclaw_cmd().map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Fix #219: 优先通过 enhanced_path 搜索：其中 nvm/volta 等版本管理器路径排在 Homebrew 前面，
        // 与 `which openclaw` 的优先级一致，避免残留的 Homebrew 旧版本被优先检测到
        let path = crate::commands::enhanced_path();
        let sep = ':';
        for dir in path.split(sep) {
            let candidate = std::path::Path::new(dir).join("openclaw");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        // 兜底：检查 enhanced_path 可能未覆盖到的固定路径（如 GUI 环境 PATH 受限时）
        for candidate in common_non_windows_cli_candidates() {
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        None
    }
}

/// 跨平台路径比较 key：统一分隔符；Windows / macOS 文件系统默认大小写不敏感，
/// 故仅在这两个平台小写化（Linux 大小写敏感，不能小写化，否则不同目录会被误判相等）
pub fn path_compare_key(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if cfg!(any(windows, target_os = "macos")) {
        raw.to_ascii_lowercase()
    } else {
        raw
    }
}

/// 将路径解析为可用于安全比较的绝对路径。
/// 已存在路径直接 canonicalize；不存在路径 canonicalize 最近的存在祖先后再拼回尾部。
pub fn canonicalize_path_for_safety(
    path: &std::path::Path,
    label: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::Component;

    if path.as_os_str().is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("{label}不能包含 .. 路径段"));
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("读取当前目录失败: {e}"))?
            .join(path)
    };
    if absolute.exists() {
        return std::fs::canonicalize(&absolute)
            .map_err(|e| format!("解析{label} {} 失败: {e}", absolute.display()));
    }

    let mut ancestor = absolute.clone();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| format!("找不到{label}的存在祖先: {}", absolute.display()))?
            .to_os_string();
        missing.push(name);
        if !ancestor.pop() {
            return Err(format!("找不到{label}的存在祖先: {}", absolute.display()));
        }
    }

    let mut resolved = std::fs::canonicalize(&ancestor)
        .map_err(|e| format!("解析{label}祖先 {} 失败: {e}", ancestor.display()))?;
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// path 是否等于 base 或位于 base 之下（带路径分隔符边界，media 不会误匹配 media-evil）
pub fn path_is_inside_or_same(path: &std::path::Path, base: &std::path::Path) -> bool {
    let path_key = path_compare_key(path);
    let base_key = path_compare_key(base).trim_end_matches('/').to_string();
    !base_key.is_empty() && (path_key == base_key || path_key.starts_with(&format!("{base_key}/")))
}

/// 根据 CLI 路径判断安装来源
pub fn classify_cli_source(cli_path: &str) -> String {
    let lower = cli_path.replace('\\', "/").to_lowercase();
    // 便携模式：CLI 位于 U 盘 portable root 之下
    if let Some(ctx) = crate::commands::portable::portable_context() {
        if path_is_inside_or_same(std::path::Path::new(cli_path), &ctx.root) {
            return "portable".into();
        }
    }
    // standalone 安装
    if lower.contains("/programs/openclaw/")
        || lower.contains("/openclaw-bin/")
        || lower.contains("/opt/openclaw/")
    {
        return "standalone".into();
    }
    // npm 汉化版
    if lower.contains("openclaw-zh") || lower.contains("@qingchencloud") {
        return "npm-zh".into();
    }
    #[cfg(target_os = "windows")]
    {
        if lower.ends_with("/openclaw.cmd") || lower.ends_with("/openclaw.bat") {
            if let Ok(content) = std::fs::read_to_string(cli_path) {
                let content = content.to_lowercase();
                if content.contains("@qingchencloud") || content.contains("openclaw-zh") {
                    return "npm-zh".into();
                }
                if content.contains("/node_modules/openclaw/")
                    || content.contains("\\node_modules\\openclaw\\")
                {
                    return "npm-official".into();
                }
            }
        }
    }
    // npm 全局（大概率官方版）
    if lower.contains("/npm/") || lower.contains("/npm-global/") || lower.contains("/node_modules/")
    {
        return "npm-official".into();
    }
    // Homebrew
    if lower.contains("/homebrew/") || lower.contains("/usr/local/bin") {
        return "npm-global".into();
    }
    "unknown".into()
}

/// 跨平台获取 openclaw 命令的方法（同步版本）
#[allow(dead_code)]
pub fn openclaw_command() -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let enhanced = crate::commands::enhanced_path();
        // 优先：找到 openclaw.cmd 完整路径，用 cmd /c "完整路径" 避免引号问题
        if let Some(cmd_path) = find_openclaw_cmd() {
            let mut cmd = crate::utils::background_command("cmd");
            if cmd_path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("js"))
            {
                cmd.arg("/c").arg("node").arg(cmd_path);
            } else {
                cmd.arg("/c").arg(cmd_path);
            }
            cmd.env("PATH", &enhanced);
            apply_openclaw_dir_env(&mut cmd);
            crate::commands::apply_proxy_env(&mut cmd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
        // 兜底：直接用 cmd /c openclaw
        let mut cmd = crate::utils::background_command("cmd");
        cmd.arg("/c").arg("openclaw");
        cmd.env("PATH", &enhanced);
        apply_openclaw_dir_env(&mut cmd);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = resolve_openclaw_cli_path().unwrap_or_else(|| "openclaw".into());
        let mut cmd = std::process::Command::new(bin);
        cmd.env("PATH", crate::commands::enhanced_path());
        apply_openclaw_dir_env(&mut cmd);
        crate::commands::apply_proxy_env(&mut cmd);
        cmd
    }
}

/// 异步版本的 openclaw 命令（推荐使用，避免阻塞 UI）
pub fn openclaw_command_async() -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let enhanced = crate::commands::enhanced_path();
        // 优先：找到 openclaw.cmd 完整路径
        if let Some(cmd_path) = find_openclaw_cmd() {
            let mut cmd = crate::utils::background_command_async("cmd");
            if cmd_path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("js"))
            {
                cmd.arg("/c").arg("node").arg(cmd_path);
            } else {
                cmd.arg("/c").arg(cmd_path);
            }
            cmd.env("PATH", &enhanced);
            apply_openclaw_dir_env_tokio(&mut cmd);
            crate::commands::apply_proxy_env_tokio(&mut cmd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
        // 兜底
        let mut cmd = crate::utils::background_command_async("cmd");
        cmd.arg("/c").arg("openclaw");
        cmd.env("PATH", &enhanced);
        apply_openclaw_dir_env_tokio(&mut cmd);
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = resolve_openclaw_cli_path().unwrap_or_else(|| "openclaw".into());
        let mut cmd = tokio::process::Command::new(bin);
        cmd.env("PATH", crate::commands::enhanced_path());
        apply_openclaw_dir_env_tokio(&mut cmd);
        crate::commands::apply_proxy_env_tokio(&mut cmd);
        cmd
    }
}

/// Windows 子进程输出与日志可能是 GBK 或 UTF-16 编码；按 UTF-8 → UTF-16LE → GBK 的顺序解码，
/// 避免把系统 OEM 编码的中文日志显示成乱码。
pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    // 无 BOM 的 UTF-16LE：每个 ASCII 字符后紧跟 NUL，按奇数字节 NUL 密度判断。
    if bytes.len() >= 4
        && bytes.len().is_multiple_of(2)
        && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 4 > bytes.len()
    {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return text.into_owned();
    }
    let (text, _, _) = encoding_rs::GBK.decode(bytes);
    text.into_owned()
}

#[cfg(all(test, target_os = "windows"))]
mod windows_background_tests {
    use super::*;

    #[test]
    fn owned_console_child() {
        if std::env::var("CLAWPANEL_OWN_CONSOLE_FIXTURE").as_deref() != Ok("owned") {
            return;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        let window = unsafe { GetConsoleWindow() } as usize;
        println!("OWN_CONSOLE_WINDOW={window}");
        println!(
            "OWN_UNICODE={}",
            std::env::var("CLAWPANEL_OWN_UNICODE").unwrap()
        );
        eprintln!("OWN_STDERR=后台中文");
        std::process::exit(7);
    }

    #[test]
    fn background_command_sync_preserves_owned_output_and_exit_without_console() {
        let output = background_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "utils::windows_background_tests::owned_console_child",
                "--nocapture",
            ])
            .env("CLAWPANEL_OWN_CONSOLE_FIXTURE", "owned")
            .env("CLAWPANEL_OWN_UNICODE", "后台中文🙂")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("OWN_CONSOLE_WINDOW=0"));
        assert!(stdout.contains("OWN_UNICODE=后台中文🙂"));
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("OWN_STDERR=后台中文"));
        println!("OWN_STD_SYNC console=0 exit=7 stdout/stderr/unicode preserved");
    }

    #[test]
    fn background_command_async_preserves_owned_output_and_exit_without_console() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                background_command_async(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "utils::windows_background_tests::owned_console_child",
                        "--nocapture",
                    ])
                    .env("CLAWPANEL_OWN_CONSOLE_FIXTURE", "owned")
                    .env("CLAWPANEL_OWN_UNICODE", "后台中文🙂")
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(output.status.code(), Some(7));
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("OWN_CONSOLE_WINDOW=0"));
            assert!(stdout.contains("OWN_UNICODE=后台中文🙂"));
            assert!(String::from_utf8(output.stderr)
                .unwrap()
                .contains("OWN_STDERR=后台中文"));
            println!("OWN_TOKIO console=0 exit=7 stdout/stderr/unicode preserved");
        });
    }
}
