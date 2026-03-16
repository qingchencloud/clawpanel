use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PATCH_VERSION: &str = "sessionMessage-v1";

#[derive(Serialize, Deserialize, Default)]
pub struct GatewayPatchStatus {
    pub installed_version: Option<String>,
    pub patched: bool,
    pub patched_version: Option<String>,
    pub patched_at: Option<String>,
    pub files: Vec<String>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub async fn gateway_patch_status() -> Result<GatewayPatchStatus, String> {
    let mut status = read_status_from_panel().unwrap_or_default();
    status.installed_version = read_openclaw_version().ok();
    Ok(status)
}

#[tauri::command]
pub async fn gateway_patch_apply(force: Option<bool>) -> Result<GatewayPatchStatus, String> {
    let force_apply = force.unwrap_or(false);
    let mut status = read_status_from_panel().unwrap_or_default();

    let openclaw_version = read_openclaw_version().ok();
    let dist_dir = resolve_openclaw_dist_dir()?;
    let reply_path = find_latest_file(&dist_dir, "reply-")?;
    let gateway_path = find_latest_file(&dist_dir, "gateway-cli-")?;

    let files = vec![
        reply_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        gateway_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
    ];

    if force_apply {
        restore_backup(&reply_path)?;
        restore_backup(&gateway_path)?;
    }

    let reply_patched = patch_reply_file(&reply_path, false)?;
    let gateway_patched = patch_gateway_file(&gateway_path, false)?;

    if !reply_patched && !gateway_patched {
        status.patched = true;
        status.patched_version = status.patched_version.or(Some(PATCH_VERSION.to_string()));
        status.installed_version = openclaw_version;
        status.files = files;
        write_status_to_panel(&status)?;
        return Ok(status);
    }

    status.patched = true;
    status.patched_version = Some(PATCH_VERSION.to_string());
    status.patched_at = Some(chrono::Local::now().to_rfc3339());
    status.installed_version = openclaw_version;
    status.files = files;
    status.last_error = None;
    write_status_to_panel(&status)?;
    Ok(status)
}

#[tauri::command]
pub async fn gateway_patch_rollback() -> Result<GatewayPatchStatus, String> {
    let mut status = read_status_from_panel().unwrap_or_default();
    let dist_dir = resolve_openclaw_dist_dir()?;
    let reply_path = find_latest_file(&dist_dir, "reply-")?;
    let gateway_path = find_latest_file(&dist_dir, "gateway-cli-")?;

    restore_backup(&reply_path)?;
    restore_backup(&gateway_path)?;

    status.patched = false;
    status.patched_version = None;
    status.patched_at = None;
    status.last_error = None;
    write_status_to_panel(&status)?;
    Ok(status)
}

fn openclaw_dir() -> PathBuf {
    crate::commands::openclaw_dir()
}

fn panel_config_path() -> PathBuf {
    openclaw_dir().join("clawpanel.json")
}

fn read_status_from_panel() -> Option<GatewayPatchStatus> {
    let path = panel_config_path();
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    let entry = value.get("gatewayPatch")?.clone();
    serde_json::from_value(entry).ok()
}

fn write_status_to_panel(status: &GatewayPatchStatus) -> Result<(), String> {
    let path = panel_config_path();
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let mut root: Value = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("解析失败: {e}"))?
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }
    let entry = serde_json::to_value(status).map_err(|e| format!("序列化失败: {e}"))?;
    root["gatewayPatch"] = entry;
    let json = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))
}

fn npm_root_global() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/c", "npm", "root", "-g"]);
        c
    } else {
        let mut c = Command::new("npm");
        c.args(["root", "-g"]);
        c
    };
    cmd.env("PATH", crate::commands::enhanced_path());
    crate::commands::apply_proxy_env(&mut cmd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().map_err(|e| format!("npm root -g 执行失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "npm root -g 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("npm root -g 返回空路径".to_string());
    }
    Ok(PathBuf::from(text))
}

fn resolve_openclaw_dist_dir() -> Result<PathBuf, String> {
    let root = npm_root_global()?;
    let openclaw_dir = root.join("openclaw");
    if !openclaw_dir.exists() {
        return Err("未找到全局 openclaw 安装目录".to_string());
    }
    let dist = openclaw_dir.join("dist");
    if !dist.exists() {
        return Err("未找到 openclaw dist 目录".to_string());
    }
    Ok(dist)
}

fn read_openclaw_version() -> Result<String, String> {
    let root = npm_root_global()?;
    let pkg = root.join("openclaw").join("package.json");
    if !pkg.exists() {
        return Err("未找到 openclaw package.json".to_string());
    }
    let content = fs::read_to_string(&pkg).map_err(|e| format!("读取失败: {e}"))?;
    let value: Value = serde_json::from_str(&content).map_err(|e| format!("解析失败: {e}"))?;
    let version = value
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if version.is_empty() {
        return Err("openclaw 版本为空".to_string());
    }
    Ok(version)
}

fn find_latest_file(dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = vec![];
    for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.starts_with(prefix) || !name.ends_with(".js") {
            continue;
        }
        let meta = entry.metadata().map_err(|e| format!("读取文件信息失败: {e}"))?;
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((path, modified));
    }
    candidates.sort_by_key(|(_, t)| *t);
    candidates
        .last()
        .map(|(p, _)| p.clone())
        .ok_or_else(|| format!("未找到 {prefix}*.js"))
}

fn backup_file(path: &Path) -> Result<(), String> {
    let backup_path = PathBuf::from(format!("{}.bak", path.display()));
    fs::copy(path, &backup_path).map_err(|e| format!("备份失败: {e}"))?;
    Ok(())
}

fn restore_backup(path: &Path) -> Result<(), String> {
    let backup_path = PathBuf::from(format!("{}.bak", path.display()));
    if !backup_path.exists() {
        return Err("未找到备份文件".to_string());
    }
    fs::copy(&backup_path, path).map_err(|e| format!("回滚失败: {e}"))?;
    Ok(())
}

fn replace_once(hay: &str, needle: &str, replacement: &str) -> Result<String, String> {
    if !hay.contains(needle) {
        return Err("未找到补丁位置".to_string());
    }
    Ok(hay.replacen(needle, replacement, 1))
}

fn patch_reply_file(path: &Path, _force: bool) -> Result<bool, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
    if content.contains("kind: Type.Literal(\"sessionMessage\")") {
        return Ok(false);
    }
    let needle_schema = "const CronPayloadSchema = Type.Union([Type.Object({\n\tkind: Type.Literal(\"systemEvent\"),\n\ttext: NonEmptyString\n}, { additionalProperties: false }), ";
    let insert_schema = "const CronPayloadSchema = Type.Union([Type.Object({\n\tkind: Type.Literal(\"systemEvent\"),\n\ttext: NonEmptyString\n}, { additionalProperties: false }), Type.Object({\n\tkind: Type.Literal(\"sessionMessage\"),\n\tlabel: NonEmptyString,\n\tmessage: NonEmptyString,\n\trole: Type.Optional(Type.Literal(\"user\")),\n\twaitForIdle: Type.Optional(Type.Boolean())\n}, { additionalProperties: false }), ";

    let needle_patch = "const CronPayloadPatchSchema = Type.Union([Type.Object({\n\tkind: Type.Literal(\"systemEvent\"),\n\ttext: Type.Optional(NonEmptyString)\n}, { additionalProperties: false }), ";
    let insert_patch = "const CronPayloadPatchSchema = Type.Union([Type.Object({\n\tkind: Type.Literal(\"systemEvent\"),\n\ttext: Type.Optional(NonEmptyString)\n}, { additionalProperties: false }), Type.Object({\n\tkind: Type.Literal(\"sessionMessage\"),\n\tlabel: Type.Optional(NonEmptyString),\n\tmessage: Type.Optional(NonEmptyString),\n\trole: Type.Optional(Type.Literal(\"user\")),\n\twaitForIdle: Type.Optional(Type.Boolean())\n}, { additionalProperties: false }), ";

    let mut next = replace_once(&content, needle_schema, insert_schema)?;
    next = replace_once(&next, needle_patch, insert_patch)?;

    backup_file(path)?;
    fs::write(path, next).map_err(|e| format!("写入失败: {e}"))?;
    Ok(true)
}

fn patch_gateway_file(path: &Path, _force: bool) -> Result<bool, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
    if content.contains("payload.kind === \"sessionMessage\"") {
        return Ok(false);
    }

    let needle_assert = "\tif (job.sessionTarget === \"main\" && job.payload.kind !== \"systemEvent\") throw new Error(\"main cron jobs require payload.kind=\\\"systemEvent\\\"\");";
    let insert_assert = "\tif (job.sessionTarget === \"main\" && job.payload.kind !== \"systemEvent\" && job.payload.kind !== \"sessionMessage\") throw new Error(\"main cron jobs require payload.kind=\\\"systemEvent\\\" or \\\"sessionMessage\\\"\");";

    let needle_merge = "\tif (patch.kind === \"systemEvent\") {\n\t\tif (existing.kind !== \"systemEvent\") return buildPayloadFromPatch(patch);\n\t\treturn {\n\t\t\tkind: \"systemEvent\",\n\t\t\ttext: typeof patch.text === \"string\" ? patch.text : existing.text\n\t\t};\n\t}\n\tif (existing.kind !== \"agentTurn\") return buildPayloadFromPatch(patch);";
    let insert_merge = "\tif (patch.kind === \"systemEvent\") {\n\t\tif (existing.kind !== \"systemEvent\") return buildPayloadFromPatch(patch);\n\t\treturn {\n\t\t\tkind: \"systemEvent\",\n\t\t\ttext: typeof patch.text === \"string\" ? patch.text : existing.text\n\t\t};\n\t}\n\tif (patch.kind === \"sessionMessage\") {\n\t\tif (existing.kind !== \"sessionMessage\") return buildPayloadFromPatch(patch);\n\t\treturn {\n\t\t\tkind: \"sessionMessage\",\n\t\t\tlabel: typeof patch.label === \"string\" ? patch.label : existing.label,\n\t\t\tmessage: typeof patch.message === \"string\" ? patch.message : existing.message,\n\t\t\trole: \"user\",\n\t\t\twaitForIdle: typeof patch.waitForIdle === \"boolean\" ? patch.waitForIdle : existing.waitForIdle\n\t\t};\n\t}\n\tif (existing.kind !== \"agentTurn\") return buildPayloadFromPatch(patch);";

    let needle_build = "\tif (patch.kind === \"systemEvent\") {\n\t\tif (typeof patch.text !== \"string\" || patch.text.length === 0) throw new Error(\"cron.update payload.kind=\\\"systemEvent\\\" requires text\");\n\t\treturn {\n\t\t\tkind: \"systemEvent\",\n\t\t\ttext: patch.text\n\t\t};\n\t}\n\tif (typeof patch.message !== \"string\" || patch.message.length === 0) throw new Error(\"cron.update payload.kind=\\\"agentTurn\\\" requires message\");";
    let insert_build = "\tif (patch.kind === \"systemEvent\") {\n\t\tif (typeof patch.text !== \"string\" || patch.text.length === 0) throw new Error(\"cron.update payload.kind=\\\"systemEvent\\\" requires text\");\n\t\treturn {\n\t\t\tkind: \"systemEvent\",\n\t\t\ttext: patch.text\n\t\t};\n\t}\n\tif (patch.kind === \"sessionMessage\") {\n\t\tif (typeof patch.label !== \"string\" || patch.label.length === 0) throw new Error(\"cron.update payload.kind=\\\"sessionMessage\\\" requires label\");\n\t\tif (typeof patch.message !== \"string\" || patch.message.length === 0) throw new Error(\"cron.update payload.kind=\\\"sessionMessage\\\" requires message\");\n\t\treturn {\n\t\t\tkind: \"sessionMessage\",\n\t\t\tlabel: patch.label,\n\t\t\tmessage: patch.message,\n\t\t\trole: \"user\",\n\t\t\twaitForIdle: typeof patch.waitForIdle === \"boolean\" ? patch.waitForIdle : true\n\t\t};\n\t}\n\tif (typeof patch.message !== \"string\" || patch.message.length === 0) throw new Error(\"cron.update payload.kind=\\\"agentTurn\\\" requires message\");";

    let needle_execute = "\tif (abortSignal?.aborted) return resolveAbortError();\n\tif (job.sessionTarget === \"main\") {";
    let insert_execute = "\tif (abortSignal?.aborted) return resolveAbortError();\n\tif (job.payload.kind === \"sessionMessage\") {\n\t\tconst cfg = loadConfig();\n\t\tconst resolved = await resolveSessionKeyFromResolveParams({\n\t\t\tcfg,\n\t\t\tp: { label: job.payload.label }\n\t\t});\n\t\tif (!resolved.ok) return {\n\t\t\tstatus: \"error\",\n\t\t\terror: resolved.error?.message ?? \"session not found\"\n\t\t};\n\t\tif (job.payload.waitForIdle) {\n\t\t\tawait waitForActiveEmbeddedRuns(15e3);\n\t\t}\n\t\tconst { entry } = loadSessionEntry(resolved.key);\n\t\tconst prefixOptions = createReplyPrefixOptions({\n\t\t\tcfg,\n\t\t\tentry,\n\t\t\tsessionKey: resolved.key,\n\t\t\tclient: void 0\n\t\t});\n\t\tconst dispatcher = createReplyDispatcher({\n\t\t\t...prefixOptions,\n\t\t\tonError: (err) => {\n\t\t\t\tstate.deps.log.warn(`cron sessionMessage dispatch failed: ${String(err)}`);\n\t\t\t}\n\t\t});\n\t\tconst message = job.payload.message;\n\t\tconst ctx = {\n\t\t\tBody: message,\n\t\t\tBodyForAgent: message,\n\t\t\tBodyForCommands: message,\n\t\t\tRawBody: message,\n\t\t\tCommandBody: message,\n\t\t\tSessionKey: resolved.key,\n\t\t\tProvider: INTERNAL_MESSAGE_CHANNEL,\n\t\t\tSurface: INTERNAL_MESSAGE_CHANNEL,\n\t\t\tChatType: \"direct\",\n\t\t\tCommandAuthorized: true,\n\t\t\tMessageSid: `cron:${job.id}:${state.deps.nowMs()}`\n\t\t};\n\t\tawait dispatchInboundMessage({\n\t\t\tctx,\n\t\t\tcfg,\n\t\t\tdispatcher,\n\t\t\treplyOptions: { runId: `cron:${job.id}:${state.deps.nowMs()}` }\n\t\t});\n\t\treturn {\n\t\t\tstatus: \"ok\",\n\t\t\tsummary: message,\n\t\t\tsessionKey: resolved.key\n\t\t};\n\t}\n\tif (job.sessionTarget === \"main\") {";

    let mut next = replace_once(&content, needle_assert, insert_assert)?;
    next = replace_once(&next, needle_merge, insert_merge)?;
    next = replace_once(&next, needle_build, insert_build)?;
    next = replace_once(&next, needle_execute, insert_execute)?;

    backup_file(path)?;
    fs::write(path, next).map_err(|e| format!("写入失败: {e}"))?;
    Ok(true)
}
