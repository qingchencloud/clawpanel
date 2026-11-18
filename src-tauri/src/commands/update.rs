use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 前端热更新目录 (~/.openclaw/clawpanel/web-update/)
pub fn update_dir() -> PathBuf {
    super::openclaw_dir().join("clawpanel").join("web-update")
}

/// 官网提供的桌面前端热更新清单。
const LATEST_JSON_URL: &str = "https://claw.qt.cool/update/latest.json";

/// 检查前端是否有新版本可用
#[tauri::command]
pub async fn check_frontend_update() -> Result<Value, String> {
    // 仅显式隔离 debug 场景跳过外部自动更新，避免本地 E2E 出网或安装新版。
    if super::platform::isolated_debug_enabled() {
        return Ok(
            serde_json::json!({"currentVersion":env!("CARGO_PKG_VERSION"),"latestVersion":env!("CARGO_PKG_VERSION"),"hasUpdate":false,"compatible":true,"updateReady":false,"manifest":{}}),
        );
    }
    let client = super::build_http_client(std::time::Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let url = format!(
        "{}?_t={}",
        LATEST_JSON_URL,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("服务器返回 {}", resp.status()));
    }

    let mut manifest: Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    normalize_manifest_url(&mut manifest);

    let latest = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 优先读取已热更新的版本，避免 macOS/Linux 用户安装旧包后永远提示有更新
    let frontend_current = {
        let version_file = update_dir().join(".version");
        update_dir()
            .join("index.html")
            .is_file()
            .then(|| fs::read_to_string(version_file).ok())
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
    };

    // 检查最低兼容的 app 版本（前端可能依赖较新的 Rust 后端命令）
    let min_app = manifest
        .get("minAppVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");

    let app_version = env!("CARGO_PKG_VERSION");
    let compatible = version_ge(app_version, min_app);
    let remote_newer = !latest.is_empty() && compatible && version_gt(&latest, &frontend_current);
    let update_ready = compatible
        && frontend_current == latest
        && version_gt(&latest, app_version)
        && update_dir().join("index.html").is_file();
    let has_update = remote_newer;

    Ok(serde_json::json!({
        "currentVersion": frontend_current,
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
    if super::platform::isolated_debug_enabled() {
        return Err("隔离联调不下载或应用外部更新".into());
    }
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

    let dir = update_dir();
    let files = install_frontend_archive(&dir, &bytes, &version)?;
    Ok(serde_json::json!({"success": true, "files": files, "path": dir.to_string_lossy()}))
}

fn lock_updates(dir: &Path) -> Result<fs::File, String> {
    let parent = dir.parent().ok_or("热更新目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.with_file_name("web-update.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock()
        .map_err(|e| format!("锁定热更新目录失败: {e}"))?;
    Ok(lock)
}

fn remove_dir_if_present(dir: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// 目录替换中断时，优先恢复上一次已验证的资源。
fn recover_previous(dir: &Path) -> Result<(), String> {
    let previous = dir.with_file_name("web-update.previous");
    if previous.is_dir() {
        if dir.join("index.html").is_file() {
            remove_dir_if_present(&previous).map_err(|e| e.to_string())?;
        } else {
            remove_dir_if_present(dir).map_err(|e| e.to_string())?;
            fs::rename(previous, dir).map_err(|e| format!("恢复热更新目录失败: {e}"))?;
        }
    }
    Ok(())
}

pub(crate) fn recover_frontend_update(dir: &Path) -> Result<(), String> {
    if dir.with_file_name("web-update.previous").is_dir() {
        let _lock = lock_updates(dir)?;
        recover_previous(dir)?;
    }
    Ok(())
}

fn install_frontend_archive(dir: &Path, bytes: &[u8], version: &str) -> Result<usize, String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("解压失败: {e}"))?;
    let index = archive
        .by_name("index.html")
        .map_err(|_| "桌面前端包缺少根目录 index.html")?;
    if !index.is_file() || index.size() == 0 {
        return Err("桌面入口为空".into());
    }
    drop(index);

    let _lock = lock_updates(dir)?;
    recover_previous(dir)?;
    let next = dir.with_file_name("web-update.next");
    let previous = dir.with_file_name("web-update.previous");
    remove_dir_if_present(&next).map_err(|e| e.to_string())?;
    fs::create_dir(&next).map_err(|e| e.to_string())?;
    let staged = (|| -> Result<(), String> {
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = file.enclosed_name().ok_or("桌面包内路径无效")?;
            if name
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
                || file.is_symlink()
            {
                return Err("桌面包包含无效路径".into());
            }
            let target = next.join(name);
            if file.is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut dest = fs::File::create_new(&target).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut dest).map_err(|e| e.to_string())?;
            }
        }
        if !version.is_empty() {
            fs::write(next.join(".version"), version).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = remove_dir_if_present(&next);
        return Err(e);
    }
    if dir.exists() {
        fs::rename(dir, &previous).map_err(|e| format!("备份热更新目录失败: {e}"))?;
    }
    if let Err(e) = fs::rename(&next, dir) {
        recover_previous(dir)?;
        return Err(format!("切换热更新目录失败: {e}"));
    }
    // 当前资源已切换成功，旧目录占用时在下次启动重试清理。
    let _ = remove_dir_if_present(&previous);
    Ok(archive.len())
}

/// 回退前端更新（删除热更新目录，下次启动使用内嵌资源）
#[tauri::command]
pub fn rollback_frontend_update() -> Result<Value, String> {
    let dir = update_dir();
    let _lock = lock_updates(&dir)?;
    for item in [
        dir.with_file_name("web-update.previous"),
        dir.with_file_name("web-update.next"),
        dir,
    ] {
        remove_dir_if_present(&item).map_err(|e| format!("回退失败: {e}"))?;
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

fn normalize_manifest_url(manifest: &mut Value) {
    let download_url = manifest
        .get("downloadUrl")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(String::from)
        .or_else(|| {
            manifest
                .get("url")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .map(String::from)
        });

    if let Some(raw) = download_url {
        if let Some(normalized) = super::site_api::normalize_public_url(&raw) {
            if let Some(obj) = manifest.as_object_mut() {
                obj.insert("downloadUrl".into(), Value::String(normalized.clone()));
                obj.insert("url".into(), Value::String(normalized));
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for &(name, bytes) in files {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    // 模拟旧客户端升级，校验服务端包、损坏下载和未完成切换都可回到可用前端。
    #[test]
    fn replaces_only_a_complete_desktop_archive() {
        let root = std::env::temp_dir().join(format!(
            "clawpanel-update-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let dir = root.join("web-update");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("index.html"), b"old").unwrap();
        for bad in [
            archive(&[("dist/index.html", b"server")]),
            b"incomplete".to_vec(),
        ] {
            assert!(install_frontend_archive(&dir, &bad, "1.2.3").is_err());
            assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"old");
        }
        fs::rename(&dir, dir.with_file_name("web-update.previous")).unwrap();
        recover_frontend_update(&dir).unwrap();
        assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"old");
        let good = archive(&[("index.html", b"new"), ("assets/app.js", b"ready")]);
        assert_eq!(install_frontend_archive(&dir, &good, "1.2.3").unwrap(), 2);
        assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"new");
        assert_eq!(fs::read_to_string(dir.join(".version")).unwrap(), "1.2.3");
        fs::remove_dir_all(root).unwrap();
    }
}
