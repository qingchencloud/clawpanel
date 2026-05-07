use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;

/// 前端热更新目录 (~/.openclaw/clawpanel/web-update/)
pub fn update_dir() -> PathBuf {
    super::openclaw_dir().join("clawpanel").join("web-update")
}

/// 更新清单 URL（GitHub Pages 托管）
const LATEST_JSON_URL: &str = "https://claw.qt.cool/update/latest.json";

/// 检查前端是否有新版本可用
#[tauri::command]
pub async fn check_frontend_update() -> Result<Value, String> {
    let client = super::build_http_client(std::time::Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let resp = client
        .get(LATEST_JSON_URL)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("服务器返回 {}", resp.status()));
    }

    let manifest: Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;

    let latest = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 优先读取已热更新的版本，避免 macOS/Linux 用户安装旧包后永远提示有更新
    let current = {
        let version_file = update_dir().join(".version");
        std::fs::read_to_string(&version_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
    };

    // 检查最低兼容的 app 版本（前端可能依赖较新的 Rust 后端命令）
    let min_app = manifest
        .get("minAppVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");

    let compatible = version_ge(&current, min_app);
    let remote_newer = !latest.is_empty() && compatible && version_gt(&latest, &current);
    let update_ready = remote_newer && update_dir().join("index.html").exists();
    let has_update = remote_newer && !update_ready;

    Ok(serde_json::json!({
        "currentVersion": current,
        "latestVersion": latest,
        "hasUpdate": has_update,
        "compatible": compatible,
        "updateReady": update_ready,
        "manifest": manifest
    }))
}

/// 下载并解压前端更新包
#[tauri::command]
pub async fn download_frontend_update(
    url: String,
    expected_hash: String,
    version: String,
) -> Result<Value, String> {
    let client = super::build_http_client(std::time::Duration::from_secs(120), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取数据失败: {e}"))?;

    // 校验 SHA-256
    if !expected_hash.is_empty() {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = format!("{:x}", hasher.finalize());
        let expected = expected_hash
            .strip_prefix("sha256:")
            .unwrap_or(&expected_hash);
        if hash != expected {
            return Err(format!("哈希校验失败: 期望 {}，实际 {}", expected, hash));
        }
    }

    // 清理旧更新，解压新包
    let dir = update_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清理旧更新失败: {e}"))?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;

    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("解压失败: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩条目失败: {e}"))?;

        let name = file.name().to_string();
        let target = dir.join(&name);

        if name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|e| format!("创建子目录失败: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| format!("读取文件内容失败: {e}"))?;
            fs::write(&target, &buf).map_err(|e| format!("写入文件失败: {e}"))?;
        }
    }

    // 写入版本号文件，供下次 check_frontend_update 读取
    if !version.is_empty() {
        let _ = std::fs::write(dir.join(".version"), &version);
    }

    Ok(serde_json::json!({
        "success": true,
        "files": archive.len(),
        "path": dir.to_string_lossy()
    }))
}

/// 回退前端更新（删除热更新目录，下次启动使用内嵌资源）
#[tauri::command]
pub fn rollback_frontend_update() -> Result<Value, String> {
    let dir = update_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("回退失败: {e}"))?;
    }
    Ok(serde_json::json!({ "success": true }))
}

/// 获取当前热更新状态
#[tauri::command]
pub fn get_update_status() -> Result<Value, String> {
    let dir = update_dir();
    let ready = dir.join("index.html").exists();

    // 尝试读取已下载更新的版本信息
    let update_version = if ready {
        dir.join(".version")
            .exists()
            .then(|| fs::read_to_string(dir.join(".version")).ok())
            .flatten()
            .unwrap_or_default()
    } else {
        String::new()
    };

    Ok(serde_json::json!({
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "updateReady": ready,
        "updateVersion": update_version,
        "updateDir": dir.to_string_lossy()
    }))
}

/// 简单的语义化版本比较：current >= required
pub fn version_ge(current: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    let c = parse(current);
    let r = parse(required);
    for i in 0..r.len().max(c.len()) {
        let cv = c.get(i).copied().unwrap_or(0);
        let rv = r.get(i).copied().unwrap_or(0);
        if cv > rv {
            return true;
        }
        if cv < rv {
            return false;
        }
    }
    true
}

fn version_gt(left: &str, right: &str) -> bool {
    version_ge(left, right) && !version_ge(right, left)
}

/// 根据文件扩展名推断 MIME 类型
pub fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
