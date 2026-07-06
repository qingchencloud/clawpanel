//! U 盘便携模式（Portable Mode）
//!
//! 检测规则（启动时一次性判定，运行期不变）：
//! 1. 环境变量 `CLAWPANEL_PORTABLE_ROOT` 指向的目录（开发/测试用）；
//! 2. 否则取 exe 所在目录。
//!
//! 该目录下存在 `portable.json` 且 `mode == "portable"` 时进入便携模式。
//!
//! portable.json 里的相对路径一律相对 portable root 解析（不是 cwd），
//! 保证 U 盘换盘符后无需修改任何配置。
//! 解析失败（JSON 损坏等）只记日志并按普通模式运行，绝不影响启动。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct PortableContext {
    /// portable root（exe 所在目录，启动时动态解析，不落盘）
    pub root: PathBuf,
    pub data_dir: PathBuf,
    /// data/clawpanel/clawpanel.json
    pub panel_config_path: PathBuf,
    /// data/openclaw
    pub openclaw_dir: PathBuf,
    /// data/hermes
    pub hermes_home: PathBuf,
    /// runtimes/node（存在 node 可执行文件才 Some）
    pub node_dir: Option<PathBuf>,
    /// engines/openclaw（standalone 安装/升级在便携模式下的目标目录，不要求已存在）
    pub engines_openclaw_dir: PathBuf,
    /// engines/hermes（uv tool 安装/升级在便携模式下的目标目录，不要求已存在）
    pub engines_hermes_dir: PathBuf,
    /// engines/openclaw 下的 CLI 入口（存在才 Some）
    pub openclaw_cli_path: Option<PathBuf>,
    /// engines/hermes/bin 下的 CLI 入口（存在才 Some）
    pub hermes_cli_path: Option<PathBuf>,
    /// key 风格告警：`absolute-path:<field>` / `node-missing` / `cli-missing`
    pub warnings: Vec<String>,
}

static PORTABLE_CONTEXT: OnceLock<Option<PortableContext>> = OnceLock::new();

/// 启动时尽早调用（必须先于任何 openclaw_dir()/panel config 读取）
pub fn init() {
    let _ = portable_context();
}

/// 便携模式上下文；普通模式返回 None
pub fn portable_context() -> Option<&'static PortableContext> {
    PORTABLE_CONTEXT.get_or_init(detect).as_ref()
}

fn detect() -> Option<PortableContext> {
    let root = detect_root()?;
    detect_at(&root)
}

/// 对指定 root 执行完整检测流程（读 manifest → 解析 → 建目录），便于测试
fn detect_at(root: &Path) -> Option<PortableContext> {
    let manifest_path = root.join("portable.json");
    if !manifest_path.is_file() {
        return None;
    }
    let raw = match std::fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[portable] 读取 portable.json 失败，按普通模式运行: {e}");
            return None;
        }
    };
    // 兼容记事本保存的 UTF-8 BOM
    let text = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&raw[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&raw).into_owned()
    };
    let manifest: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[portable] portable.json 解析失败，按普通模式运行: {e}");
            return None;
        }
    };
    let ctx = resolve_portable_paths(&manifest, root)?;
    // 首次启动自动创建面板与 OpenClaw 数据目录（失败不阻塞启动，
    // 后续 write_panel_config 等写入时还会再尝试建目录）
    for dir in [
        ctx.panel_config_path.parent().map(Path::to_path_buf),
        Some(ctx.openclaw_dir.clone()),
        Some(ctx.hermes_home.clone()),
    ]
    .into_iter()
    .flatten()
    {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[portable] 创建目录 {} 失败: {e}", dir.display());
        }
    }
    eprintln!("[portable] 便携模式已启用，root: {}", ctx.root.display());
    Some(ctx)
}

fn detect_root() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CLAWPANEL_PORTABLE_ROOT") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.is_dir() {
                return Some(p);
            }
            eprintln!("[portable] CLAWPANEL_PORTABLE_ROOT 不是有效目录，忽略: {trimmed}");
        }
    }
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

fn clean_portable_path(path: PathBuf) -> PathBuf {
    path.components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .collect()
}

/// 相对路径按 root 解析；绝对路径接受但记 warning（换盘符会失效）
fn resolve_dir(
    manifest: &Value,
    root: &Path,
    field: &str,
    default: &str,
    warnings: &mut Vec<String>,
) -> PathBuf {
    let raw = manifest
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default);
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        warnings.push(format!("absolute-path:{field}"));
        clean_portable_path(p)
    } else {
        clean_portable_path(root.join(p))
    }
}

/// 纯解析逻辑（不建目录），便于单元测试
fn resolve_portable_paths(manifest: &Value, root: &Path) -> Option<PortableContext> {
    let mode = manifest.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    if mode != "portable" {
        eprintln!("[portable] portable.json 存在但 mode != \"portable\"，按普通模式运行");
        return None;
    }

    let mut warnings = Vec::new();
    let data_dir = resolve_dir(manifest, root, "dataDir", "./data", &mut warnings);
    let engines_dir = resolve_dir(manifest, root, "enginesDir", "./engines", &mut warnings);
    let runtimes_dir = resolve_dir(manifest, root, "runtimesDir", "./runtimes", &mut warnings);

    // Node 运行时：目录不存在 → 静默回退本机；目录存在但缺可执行文件 → 半拷贝状态，告警
    let node_root = runtimes_dir.join("node");
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    let node_dir = if node_root.join(node_bin).is_file() {
        Some(node_root)
    } else {
        if node_root.is_dir() {
            warnings.push("node-missing".into());
        }
        None
    };

    // OpenClaw CLI：与 utils.rs 的候选文件名保持一致
    let cli_root = engines_dir.join("openclaw");
    let openclaw_cli_path = portable_cli_candidates(&cli_root)
        .into_iter()
        .find(|p| p.is_file());
    if openclaw_cli_path.is_none() && cli_root.is_dir() {
        warnings.push("cli-missing".into());
    }

    let hermes_root = engines_dir.join("hermes");
    let hermes_cli_path = portable_hermes_cli_candidates(&hermes_root)
        .into_iter()
        .find(|p| p.is_file());
    if hermes_cli_path.is_none() && hermes_root.is_dir() {
        warnings.push("hermes-cli-missing".into());
    }

    Some(PortableContext {
        root: root.to_path_buf(),
        panel_config_path: data_dir.join("clawpanel").join("clawpanel.json"),
        openclaw_dir: data_dir.join("openclaw"),
        hermes_home: data_dir.join("hermes"),
        data_dir,
        node_dir,
        engines_openclaw_dir: cli_root,
        engines_hermes_dir: hermes_root,
        openclaw_cli_path,
        hermes_cli_path,
        warnings,
    })
}

fn node_bin_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn portable_cli_candidates(cli_root: &Path) -> Vec<PathBuf> {
    vec![
        cli_root.join("openclaw.cmd"),
        cli_root.join("openclaw.exe"),
        cli_root.join("openclaw.bat"),
        cli_root.join("openclaw.js"),
        cli_root.join("openclaw"),
    ]
}

fn portable_hermes_cli_candidates(hermes_root: &Path) -> Vec<PathBuf> {
    let bin_dir = hermes_root.join("bin");
    let tool_dir = hermes_root.join("hermes-agent");
    let mut candidates = vec![
        bin_dir.join("hermes.cmd"),
        bin_dir.join("hermes.exe"),
        bin_dir.join("hermes.bat"),
        bin_dir.join("hermes"),
    ];
    if cfg!(windows) {
        candidates.push(tool_dir.join("Scripts").join("hermes.exe"));
        candidates.push(tool_dir.join("Scripts").join("hermes.cmd"));
    } else {
        candidates.push(tool_dir.join("bin").join("hermes"));
    }
    candidates
}

fn current_portable_cli_path(ctx: &PortableContext) -> Option<PathBuf> {
    ctx.openclaw_cli_path
        .as_ref()
        .filter(|p| p.is_file())
        .cloned()
        .or_else(|| {
            portable_cli_candidates(&ctx.engines_openclaw_dir)
                .into_iter()
                .find(|p| p.is_file())
        })
}

fn current_portable_hermes_cli_path(ctx: &PortableContext) -> Option<PathBuf> {
    ctx.hermes_cli_path
        .as_ref()
        .filter(|p| p.is_file())
        .cloned()
        .or_else(|| {
            portable_hermes_cli_candidates(&ctx.engines_hermes_dir)
                .into_iter()
                .find(|p| p.is_file())
        })
}

fn current_portable_node_dir(ctx: &PortableContext) -> Option<PathBuf> {
    ctx.node_dir
        .as_ref()
        .filter(|p| p.join(node_bin_name()).is_file())
        .cloned()
        .or_else(|| {
            ctx.engines_openclaw_dir
                .join(node_bin_name())
                .is_file()
                .then(|| ctx.engines_openclaw_dir.clone())
        })
}

fn clean_status_path(path: &Path) -> String {
    let cleaned: PathBuf = path
        .components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .collect();
    cleaned.to_string_lossy().into_owned()
}

fn status_snapshot(ctx: &PortableContext) -> Value {
    let node_dir = current_portable_node_dir(ctx);
    let cli_path = current_portable_cli_path(ctx);
    let hermes_cli_path = current_portable_hermes_cli_path(ctx);
    let warnings: Vec<String> = ctx
        .warnings
        .iter()
        .filter(|warning| {
            !(warning.as_str() == "node-missing" && node_dir.is_some()
                || warning.as_str() == "cli-missing" && cli_path.is_some()
                || warning.as_str() == "hermes-cli-missing" && hermes_cli_path.is_some())
        })
        .cloned()
        .collect();

    json!({
        "enabled": true,
        "root": clean_status_path(&ctx.root),
        "dataDir": clean_status_path(&ctx.data_dir),
        "openclawDir": clean_status_path(&ctx.openclaw_dir),
        "hermesHome": clean_status_path(&ctx.hermes_home),
        "nodeDir": node_dir.as_ref().map(|p| clean_status_path(p)),
        "enginesOpenclawDir": clean_status_path(&ctx.engines_openclaw_dir),
        "enginesHermesDir": clean_status_path(&ctx.engines_hermes_dir),
        "openclawCliPath": cli_path.as_ref().map(|p| clean_status_path(p)),
        "hermesCliPath": hermes_cli_path.as_ref().map(|p| clean_status_path(p)),
        "uvBinPath": clean_status_path(&portable_uv_bin_path(&ctx.root)),
        "warnings": warnings,
    })
}

fn portable_uv_bin_path(root: &Path) -> PathBuf {
    let bin = root.join("runtimes").join("uv").join("bin");
    if cfg!(windows) {
        bin.join("uv.exe")
    } else {
        bin.join("uv")
    }
}

/// 只读状态查询，供前端展示"当前为便携模式"
#[tauri::command]
pub fn get_portable_status() -> Result<Value, String> {
    match portable_context() {
        Some(ctx) => Ok(status_snapshot(ctx)),
        None => Ok(json!({ "enabled": false })),
    }
}

fn portable_manifest() -> Value {
    json!({
        "mode": "portable",
        "dataDir": "./data",
        "enginesDir": "./engines",
        "runtimesDir": "./runtimes"
    })
}

fn sanitized_panel_config(config: Option<Value>) -> (Value, Vec<String>) {
    let mut config = config.unwrap_or_else(|| json!({}));
    if !config.is_object() {
        config = json!({});
    }

    let mut removed = Vec::new();
    if let Some(obj) = config.as_object_mut() {
        for key in [
            "openclawDir",
            "openclawCliPath",
            "openclawSearchPaths",
            "nodePath",
            "gitPath",
        ] {
            if obj.remove(key).is_some() {
                removed.push(key.to_string());
            }
        }
    }
    (config, removed)
}

fn path_is_inside_or_same(path: &Path, base: &Path) -> bool {
    crate::utils::path_is_inside_or_same(path, base)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("源目录不存在: {}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {e}", dst.display()))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let meta = entry
            .metadata()
            .map_err(|e| format!("读取元数据 {} 失败: {e}", src_path.display()))?;
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if meta.is_file() {
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
            }
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "复制文件 {} -> {} 失败: {e}",
                    src_path.display(),
                    dst_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn migrate_to_portable_impl(
    target_root: &Path,
    panel_config: Option<Value>,
    source_openclaw_dir: &Path,
    source_engine_dir: Option<&Path>,
    source_hermes_home: Option<&Path>,
) -> Result<Value, String> {
    if target_root.as_os_str().is_empty() {
        return Err("请选择便携模式目标目录".into());
    }
    if target_root.is_file() {
        return Err("目标路径是文件，请选择目录".into());
    }

    let portable_json = target_root.join("portable.json");
    if portable_json.exists() {
        return Err("目标目录已存在 portable.json，请选择空目录或新的便携目录".into());
    }

    let data_dir = target_root.join("data");
    let panel_dir = data_dir.join("clawpanel");
    let portable_panel_config = panel_dir.join("clawpanel.json");
    let portable_openclaw_dir = data_dir.join("openclaw");
    let portable_hermes_home = data_dir.join("hermes");
    let engines_openclaw_dir = target_root.join("engines").join("openclaw");
    let engines_hermes_dir = target_root.join("engines").join("hermes");
    let runtimes_node_dir = target_root.join("runtimes").join("node");
    let runtimes_uv_dir = target_root.join("runtimes").join("uv");

    if source_openclaw_dir.is_dir()
        && path_is_inside_or_same(&portable_openclaw_dir, source_openclaw_dir)
    {
        return Err("目标目录不能放在当前 OpenClaw 配置目录内部，避免递归复制".into());
    }
    if let Some(engine_dir) = source_engine_dir {
        if engine_dir.is_dir() && path_is_inside_or_same(&engines_openclaw_dir, engine_dir) {
            return Err("目标目录不能放在当前 OpenClaw 引擎目录内部，避免递归复制".into());
        }
    }
    if let Some(hermes_home) = source_hermes_home {
        if hermes_home.is_dir() && path_is_inside_or_same(&portable_hermes_home, hermes_home) {
            return Err("目标目录不能放在当前 Hermes 数据目录内部，避免递归复制".into());
        }
    }

    for dir in [
        target_root,
        &data_dir,
        &panel_dir,
        &portable_openclaw_dir,
        &portable_hermes_home,
        &engines_openclaw_dir,
        &engines_hermes_dir,
        &runtimes_node_dir,
        &runtimes_uv_dir,
    ] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;
    }

    let manifest = portable_manifest();
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 portable.json 失败: {e}"))?;
    std::fs::write(&portable_json, manifest_text)
        .map_err(|e| format!("写入 portable.json 失败: {e}"))?;

    let (portable_panel, removed_panel_keys) = sanitized_panel_config(panel_config);
    let panel_text = serde_json::to_string_pretty(&portable_panel)
        .map_err(|e| format!("序列化 clawpanel.json 失败: {e}"))?;
    std::fs::write(&portable_panel_config, panel_text)
        .map_err(|e| format!("写入 clawpanel.json 失败: {e}"))?;

    let mut warnings = Vec::new();
    let copied_openclaw = if source_openclaw_dir.is_dir() {
        copy_dir_recursive(source_openclaw_dir, &portable_openclaw_dir)?;
        true
    } else {
        warnings.push("openclaw-source-missing".to_string());
        false
    };

    let mut copied_engine = false;
    if let Some(engine_dir) = source_engine_dir {
        if engine_dir.is_dir() {
            copy_dir_recursive(engine_dir, &engines_openclaw_dir)?;
            copied_engine = true;
        }
    }

    let mut copied_hermes_home = false;
    if let Some(hermes_home) = source_hermes_home {
        if hermes_home.is_dir() {
            copy_dir_recursive(hermes_home, &portable_hermes_home)?;
            copied_hermes_home = true;
        }
    }

    Ok(json!({
        "root": target_root.to_string_lossy(),
        "portableJson": portable_json.to_string_lossy(),
        "panelConfigPath": portable_panel_config.to_string_lossy(),
        "openclawDir": portable_openclaw_dir.to_string_lossy(),
        "hermesHome": portable_hermes_home.to_string_lossy(),
        "enginesOpenclawDir": engines_openclaw_dir.to_string_lossy(),
        "enginesHermesDir": engines_hermes_dir.to_string_lossy(),
        "copiedOpenclaw": copied_openclaw,
        "copiedEngine": copied_engine,
        "copiedHermesHome": copied_hermes_home,
        "needsOpenclawInstall": !copied_engine,
        "needsHermesInstall": true,
        "removedPanelKeys": removed_panel_keys,
        "warnings": warnings,
    }))
}

/// 目录存在且非空才值得备份；空目录直接复用，避免产生噪音备份
fn needs_backup(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// 目标已存在时的备份路径（同级、带时间戳），rename 即时完成
fn backup_sibling_path(path: &Path, timestamp: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".into());
    path.with_file_name(format!("{name}.backup-{timestamp}"))
}

/// 将便携数据迁移回本机默认位置（migrate_to_portable 的反向）。
/// 语义：以 U 盘数据为准——本机已有数据先整体改名备份（.backup-<时间戳>），
/// 再全新复制，避免新旧数据合并出难排查的混合状态。
/// 引擎与运行时不迁移（本机按常规方式安装），只搬用户数据。
fn migrate_to_local_impl(
    source_openclaw_dir: &Path,
    source_hermes_home: &Path,
    source_panel_config: Option<Value>,
    target_openclaw_dir: &Path,
    target_hermes_home: &Path,
) -> Result<Value, String> {
    // 防呆：目标不能位于便携源内部或与其相同（自定义路径可能指回 U 盘）
    if path_is_inside_or_same(target_openclaw_dir, source_openclaw_dir)
        || path_is_inside_or_same(source_openclaw_dir, target_openclaw_dir)
    {
        return Err("本机 OpenClaw 目录与便携目录重叠，无法迁移".into());
    }
    if path_is_inside_or_same(target_hermes_home, source_hermes_home)
        || path_is_inside_or_same(source_hermes_home, target_hermes_home)
    {
        return Err("本机 Hermes 目录与便携目录重叠，无法迁移".into());
    }

    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut backups: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // OpenClaw 数据（含面板级 clawpanel/ 子目录：模型渠道、媒体数据随之带回）
    let mut copied_openclaw = false;
    if source_openclaw_dir.is_dir() {
        if target_openclaw_dir.exists() && needs_backup(target_openclaw_dir) {
            let bak = backup_sibling_path(target_openclaw_dir, &timestamp);
            std::fs::rename(target_openclaw_dir, &bak).map_err(|e| {
                format!("备份本机 OpenClaw 数据失败（若本机 Gateway 正在运行请先停止）: {e}")
            })?;
            backups.push(bak.to_string_lossy().to_string());
        }
        copy_dir_recursive(source_openclaw_dir, target_openclaw_dir)?;
        copied_openclaw = true;
    } else {
        warnings.push("portable-openclaw-missing".into());
    }

    // Hermes 数据
    let mut copied_hermes = false;
    if source_hermes_home.is_dir() {
        if target_hermes_home.exists() && needs_backup(target_hermes_home) {
            let bak = backup_sibling_path(target_hermes_home, &timestamp);
            std::fs::rename(target_hermes_home, &bak)
                .map_err(|e| format!("备份本机 Hermes 数据失败: {e}"))?;
            backups.push(bak.to_string_lossy().to_string());
        }
        copy_dir_recursive(source_hermes_home, target_hermes_home)?;
        copied_hermes = true;
    }

    // 面板配置：写入本机 openclaw 目录下的 clawpanel.json；
    // 与正向迁移同理清洗绝对路径字段（便携配置里可能残留指向 U 盘的路径）
    let (panel, removed_keys) = sanitized_panel_config(source_panel_config);
    let target_panel_config = target_openclaw_dir.join("clawpanel.json");
    std::fs::create_dir_all(target_openclaw_dir)
        .map_err(|e| format!("创建本机数据目录失败: {e}"))?;
    let panel_text = serde_json::to_string_pretty(&panel)
        .map_err(|e| format!("序列化 clawpanel.json 失败: {e}"))?;
    std::fs::write(&target_panel_config, panel_text)
        .map_err(|e| format!("写入本机 clawpanel.json 失败: {e}"))?;

    Ok(json!({
        "openclawDir": target_openclaw_dir.to_string_lossy(),
        "hermesHome": target_hermes_home.to_string_lossy(),
        "panelConfigPath": target_panel_config.to_string_lossy(),
        "copiedOpenclaw": copied_openclaw,
        "copiedHermesHome": copied_hermes,
        "backups": backups,
        "removedPanelKeys": removed_keys,
        // 引擎与运行时不迁移：本机没有安装时需按常规方式安装
        "enginesNotMigrated": true,
        "warnings": warnings,
    }))
}

/// 便携模式 → 本机：把 U 盘上的用户数据迁移回本机默认位置。
/// 当前进程仍是便携模式；迁移后请从本机安装的 ClawPanel 启动查看
#[tauri::command]
pub fn migrate_to_local() -> Result<Value, String> {
    let Some(ctx) = portable_context() else {
        return Err("当前不是便携模式，无需迁移回本机".into());
    };
    let target_openclaw = crate::commands::default_openclaw_dir();
    let target_hermes = crate::commands::hermes::local_hermes_home_default();
    let panel_config = crate::commands::read_panel_config_from(&ctx.panel_config_path);
    migrate_to_local_impl(
        &ctx.openclaw_dir,
        &ctx.hermes_home,
        panel_config,
        &target_openclaw,
        &target_hermes,
    )
}

fn active_standalone_engine_dir() -> Option<PathBuf> {
    let cli_path = crate::utils::resolve_openclaw_cli_path()?;
    if crate::utils::classify_cli_source(&cli_path) != "standalone" {
        return None;
    }
    let path = PathBuf::from(cli_path);
    if path.is_file() {
        return path.parent().map(Path::to_path_buf);
    }
    None
}

fn copy_current_app_binary(target_root: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("读取当前程序路径失败: {e}"))?;
    let file_name = exe
        .file_name()
        .ok_or_else(|| "当前程序路径无文件名".to_string())?;
    let target = target_root.join(file_name);
    if exe != target {
        std::fs::copy(&exe, &target).map_err(|e| {
            format!(
                "复制当前程序 {} -> {} 失败: {e}",
                exe.display(),
                target.display()
            )
        })?;
    }
    Ok(target)
}

/// 将当前本机配置复制到一个新的便携目录。当前进程不会切换到便携模式；
/// 用户需要从目标目录里的程序重新启动，启动期才会读取 portable.json。
#[tauri::command]
pub fn migrate_to_portable(target_root: String) -> Result<Value, String> {
    if portable_context().is_some() {
        return Err("当前已经处于便携模式，无需迁移".into());
    }
    let target_root = target_root.trim();
    if target_root.is_empty() {
        return Err("请选择便携模式目标目录".into());
    }
    let target_root = PathBuf::from(target_root);
    let source_openclaw_dir = crate::commands::openclaw_dir();
    let engine_dir = active_standalone_engine_dir();
    let mut report = migrate_to_portable_impl(
        &target_root,
        crate::commands::read_panel_config_value(),
        &source_openclaw_dir,
        engine_dir.as_deref(),
        Some(&crate::commands::hermes::hermes_home_path()),
    )?;

    match copy_current_app_binary(&target_root) {
        Ok(path) => {
            if let Some(obj) = report.as_object_mut() {
                obj.insert("appCopied".into(), Value::Bool(true));
                obj.insert(
                    "portableAppPath".into(),
                    Value::String(path.to_string_lossy().to_string()),
                );
            }
        }
        Err(err) => {
            if let Some(obj) = report.as_object_mut() {
                obj.insert("appCopied".into(), Value::Bool(false));
                obj.insert("portableAppPath".into(), Value::Null);
                if let Some(warnings) = obj.get_mut("warnings").and_then(|v| v.as_array_mut()) {
                    warnings.push(Value::String(format!("app-copy-failed:{err}")));
                }
            }
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clawpanel-portable-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolves_relative_paths_against_root() {
        let root = temp_root("rel");
        let manifest: Value = serde_json::from_str(
            r#"{ "mode": "portable", "dataDir": "./data", "enginesDir": "./engines", "runtimesDir": "./runtimes" }"#,
        )
        .unwrap();
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert_eq!(ctx.data_dir, root.join("data"));
        assert_eq!(
            ctx.data_dir.to_string_lossy(),
            root.join("data").to_string_lossy()
        );
        assert_eq!(
            ctx.panel_config_path,
            root.join("data").join("clawpanel").join("clawpanel.json")
        );
        assert_eq!(ctx.openclaw_dir, root.join("data").join("openclaw"));
        assert_eq!(ctx.hermes_home, root.join("data").join("hermes"));
        assert_eq!(
            ctx.engines_openclaw_dir,
            root.join("engines").join("openclaw")
        );
        assert_eq!(ctx.engines_hermes_dir, root.join("engines").join("hermes"));
        // runtimes/engines 目录不存在 → 静默回退，无告警
        assert!(ctx.node_dir.is_none());
        assert!(ctx.openclaw_cli_path.is_none());
        assert!(ctx.hermes_cli_path.is_none());
        assert!(ctx.warnings.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn defaults_apply_when_fields_missing() {
        let root = temp_root("default");
        let manifest: Value = serde_json::from_str(r#"{ "mode": "portable" }"#).unwrap();
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert_eq!(ctx.data_dir, root.join("data"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_accepted_with_warning() {
        let root = temp_root("abs");
        let abs = std::env::temp_dir().join("clawpanel-abs-data");
        let manifest = json!({ "mode": "portable", "dataDir": abs.to_string_lossy() });
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert_eq!(ctx.data_dir, abs);
        assert!(ctx.warnings.iter().any(|w| w == "absolute-path:dataDir"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_portable_mode_disables() {
        let root = temp_root("mode");
        for raw in [r#"{}"#, r#"{ "mode": "normal" }"#] {
            let manifest: Value = serde_json::from_str(raw).unwrap();
            assert!(resolve_portable_paths(&manifest, &root).is_none());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn half_copied_runtime_and_engine_warn() {
        let root = temp_root("half");
        std::fs::create_dir_all(root.join("runtimes").join("node")).unwrap();
        std::fs::create_dir_all(root.join("engines").join("openclaw")).unwrap();
        let manifest: Value = serde_json::from_str(r#"{ "mode": "portable" }"#).unwrap();
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert!(ctx.node_dir.is_none());
        assert!(ctx.openclaw_cli_path.is_none());
        assert!(ctx.warnings.iter().any(|w| w == "node-missing"));
        assert!(ctx.warnings.iter().any(|w| w == "cli-missing"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_snapshot_refreshes_cli_and_bundled_node_after_install() {
        let root = temp_root("status-refresh");
        std::fs::create_dir_all(root.join("runtimes").join("node")).unwrap();
        let cli_dir = root.join("engines").join("openclaw");
        let hermes_dir = root.join("engines").join("hermes");
        std::fs::create_dir_all(&cli_dir).unwrap();
        std::fs::create_dir_all(&hermes_dir).unwrap();
        let manifest: Value = serde_json::from_str(r#"{ "mode": "portable" }"#).unwrap();
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert!(ctx.warnings.iter().any(|w| w == "node-missing"));
        assert!(ctx.warnings.iter().any(|w| w == "cli-missing"));
        assert!(ctx.warnings.iter().any(|w| w == "hermes-cli-missing"));

        let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(cli_dir.join(node_bin), b"").unwrap();
        std::fs::write(cli_dir.join("openclaw.cmd"), b"").unwrap();
        std::fs::create_dir_all(hermes_dir.join("bin")).unwrap();
        std::fs::write(hermes_dir.join("bin").join("hermes.cmd"), b"").unwrap();

        let snapshot = status_snapshot(&ctx);
        let warnings = snapshot
            .get("warnings")
            .and_then(|v| v.as_array())
            .expect("warnings");
        assert!(!warnings.iter().any(|w| w == "node-missing"));
        assert!(!warnings.iter().any(|w| w == "cli-missing"));
        assert!(!warnings.iter().any(|w| w == "hermes-cli-missing"));
        assert_eq!(
            snapshot.get("nodeDir").and_then(|v| v.as_str()),
            Some(cli_dir.to_string_lossy().as_ref())
        );
        assert_eq!(
            snapshot.get("openclawCliPath").and_then(|v| v.as_str()),
            Some(cli_dir.join("openclaw.cmd").to_string_lossy().as_ref())
        );
        assert_eq!(
            snapshot.get("hermesCliPath").and_then(|v| v.as_str()),
            Some(
                hermes_dir
                    .join("bin")
                    .join("hermes.cmd")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_at_full_flow_creates_data_dirs() {
        let root = temp_root("flow");
        std::fs::write(
            root.join("portable.json"),
            // 带 UTF-8 BOM，模拟记事本保存
            [&[0xEF_u8, 0xBB, 0xBF][..], br#"{ "mode": "portable" }"#].concat(),
        )
        .unwrap();
        let ctx = detect_at(&root).expect("portable mode should enable");
        assert!(root.join("data").join("clawpanel").is_dir());
        assert!(root.join("data").join("openclaw").is_dir());
        assert!(root.join("data").join("hermes").is_dir());
        assert_eq!(ctx.openclaw_dir, root.join("data").join("openclaw"));
        assert_eq!(ctx.hermes_home, root.join("data").join("hermes"));
        // manifest 缺失 → 普通模式
        let empty_root = temp_root("flow-empty");
        assert!(detect_at(&empty_root).is_none());
        // manifest 损坏 → 普通模式（不 panic）
        std::fs::write(empty_root.join("portable.json"), b"{ not json").unwrap();
        assert!(detect_at(&empty_root).is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty_root);
    }

    #[test]
    fn detects_cli_and_node_when_present() {
        let root = temp_root("full");
        let node_dir = root.join("runtimes").join("node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(node_dir.join(node_bin), b"").unwrap();
        let cli_dir = root.join("engines").join("openclaw");
        std::fs::create_dir_all(&cli_dir).unwrap();
        std::fs::write(cli_dir.join("openclaw.cmd"), b"").unwrap();
        let hermes_bin = root.join("engines").join("hermes").join("bin");
        std::fs::create_dir_all(&hermes_bin).unwrap();
        std::fs::write(hermes_bin.join("hermes.cmd"), b"").unwrap();
        let manifest: Value = serde_json::from_str(r#"{ "mode": "portable" }"#).unwrap();
        let ctx = resolve_portable_paths(&manifest, &root).unwrap();
        assert_eq!(ctx.node_dir.as_deref(), Some(node_dir.as_path()));
        assert_eq!(
            ctx.openclaw_cli_path.as_deref(),
            Some(cli_dir.join("openclaw.cmd").as_path())
        );
        assert_eq!(
            ctx.hermes_cli_path.as_deref(),
            Some(hermes_bin.join("hermes.cmd").as_path())
        );
        assert!(ctx.warnings.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_to_local_backs_up_existing_and_copies_portable_data() {
        let usb_openclaw = temp_root("to-local-src-oc");
        let usb_hermes = temp_root("to-local-src-hm");
        let local_openclaw = temp_root("to-local-dst-oc");
        let local_hermes = temp_root("to-local-dst-hm");

        // U 盘数据
        std::fs::write(usb_openclaw.join("openclaw.json"), br#"{ "from": "usb" }"#).unwrap();
        std::fs::create_dir_all(usb_openclaw.join("clawpanel").join("media")).unwrap();
        std::fs::write(
            usb_openclaw.join("clawpanel").join("model-channels.json"),
            br#"{ "version": 1 }"#,
        )
        .unwrap();
        std::fs::write(usb_hermes.join("config.yaml"), b"model: usb\n").unwrap();

        // 本机已有旧数据（应被整体备份而非覆盖合并）
        std::fs::write(
            local_openclaw.join("openclaw.json"),
            br#"{ "from": "local" }"#,
        )
        .unwrap();
        std::fs::write(local_openclaw.join("local-only.txt"), b"keep-in-backup").unwrap();

        let panel = json!({
            "accessPassword": "usb-pw",
            "nodePath": "F:\\ClawPanelPortable\\runtimes\\node"
        });

        let report = migrate_to_local_impl(
            &usb_openclaw,
            &usb_hermes,
            Some(panel),
            &local_openclaw,
            &local_hermes,
        )
        .unwrap();

        // U 盘数据落到本机
        let restored = std::fs::read_to_string(local_openclaw.join("openclaw.json")).unwrap();
        assert!(restored.contains("usb"));
        assert!(local_openclaw
            .join("clawpanel")
            .join("model-channels.json")
            .is_file());
        assert!(local_hermes.join("config.yaml").is_file());
        // 面板配置写入且绝对路径字段被清洗
        let panel_restored: Value = serde_json::from_str(
            &std::fs::read_to_string(local_openclaw.join("clawpanel.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(panel_restored["accessPassword"], "usb-pw");
        assert!(panel_restored.get("nodePath").is_none());
        // 本机旧数据完整备份
        let backups = report["backups"].as_array().unwrap();
        assert_eq!(backups.len(), 1);
        let backup_dir = PathBuf::from(backups[0].as_str().unwrap());
        assert!(backup_dir.join("local-only.txt").is_file());
        let old = std::fs::read_to_string(backup_dir.join("openclaw.json")).unwrap();
        assert!(old.contains("local"));
        assert_eq!(report["enginesNotMigrated"], true);

        for dir in [
            &usb_openclaw,
            &usb_hermes,
            &local_openclaw,
            &local_hermes,
            &backup_dir,
        ] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn migrate_to_local_rejects_overlapping_paths() {
        let usb = temp_root("to-local-overlap");
        let nested = usb.join("data").join("openclaw");
        std::fs::create_dir_all(&nested).unwrap();
        let err = migrate_to_local_impl(&nested, &usb.join("hm"), None, &usb, &usb.join("hm2"))
            .unwrap_err();
        assert!(err.contains("重叠"));
        let _ = std::fs::remove_dir_all(&usb);
    }

    #[test]
    fn migration_creates_portable_layout_and_sanitizes_host_paths() {
        let target = temp_root("migrate-target");
        let source = temp_root("migrate-source");
        std::fs::write(
            source.join("openclaw.json"),
            br#"{ "gateway": { "port": 18789 } }"#,
        )
        .unwrap();
        std::fs::create_dir_all(source.join("agents").join("main")).unwrap();
        std::fs::write(
            source.join("agents").join("main").join("agent.json"),
            br#"{}"#,
        )
        .unwrap();

        let panel = json!({
            "accessPassword": "secret",
            "networkProxy": { "url": "http://127.0.0.1:7897" },
            "openclawDir": "C:\\Users\\demo\\.openclaw",
            "openclawCliPath": "C:\\Users\\demo\\AppData\\Roaming\\npm\\openclaw.cmd",
            "openclawSearchPaths": ["C:\\Tools\\OpenClaw"],
            "nodePath": "C:\\Program Files\\nodejs",
            "gitPath": "C:\\Program Files\\Git\\cmd\\git.exe"
        });

        let hermes_source = temp_root("migrate-hermes-source");
        std::fs::write(hermes_source.join("config.yaml"), b"model: test\n").unwrap();

        let report =
            migrate_to_portable_impl(&target, Some(panel), &source, None, Some(&hermes_source))
                .unwrap();

        assert!(target.join("portable.json").is_file());
        assert!(target
            .join("data")
            .join("clawpanel")
            .join("clawpanel.json")
            .is_file());
        assert!(target
            .join("data")
            .join("openclaw")
            .join("openclaw.json")
            .is_file());
        assert!(target
            .join("data")
            .join("openclaw")
            .join("agents")
            .join("main")
            .join("agent.json")
            .is_file());
        assert!(target
            .join("data")
            .join("hermes")
            .join("config.yaml")
            .is_file());

        let migrated_panel: Value = serde_json::from_str(
            &std::fs::read_to_string(target.join("data").join("clawpanel").join("clawpanel.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(migrated_panel["accessPassword"], "secret");
        assert_eq!(
            migrated_panel["networkProxy"]["url"],
            "http://127.0.0.1:7897"
        );
        for key in [
            "openclawDir",
            "openclawCliPath",
            "openclawSearchPaths",
            "nodePath",
            "gitPath",
        ] {
            assert!(migrated_panel.get(key).is_none(), "{key} should be removed");
        }
        assert_eq!(report["copiedOpenclaw"], true);
        assert_eq!(report["copiedHermesHome"], true);
        assert_eq!(report["needsOpenclawInstall"], true);
        assert_eq!(report["needsHermesInstall"], true);

        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&source);
        let _ = std::fs::remove_dir_all(&hermes_source);
    }
}
