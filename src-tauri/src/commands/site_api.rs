use rand::RngCore;
use reqwest::Url;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SITE_BASE_URL: &str = "https://claw.qt.cool";

const LATEST_PATH: &str = "/api/v1/latest";
const ANNOUNCEMENTS_PATH: &str = "/api/v1/announcements";
const HEARTBEAT_PATH: &str = "/api/v1/client/heartbeat";

pub fn cache_busted_site_url(path: &str, params: &[(&str, String)]) -> String {
    // 隔离 debug 模式的公共官网请求也限定到同一测试 origin，生产地址保持固定。
    let origin = super::platform::isolated_origin().unwrap_or_else(|| SITE_BASE_URL.to_string());
    let mut url = Url::parse(&origin).expect("site base url is valid");
    url.set_path(path);
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in params {
            if !value.trim().is_empty() {
                pairs.append_pair(key, value);
            }
        }
        pairs.append_pair("_t", &timestamp_millis().to_string());
    }
    url.to_string()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn normalize_public_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('/') {
        return Url::parse(SITE_BASE_URL)
            .ok()?
            .join(trimmed)
            .ok()
            .map(|url| url.to_string());
    }

    let mut url = Url::parse(trimmed).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    match host.as_str() {
        "claw.qt.cool" => {
            let _ = url.set_scheme("https");
            Some(url.to_string())
        }
        "github.com" | "api.github.com" => {
            if url.scheme() == "https" {
                Some(url.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

fn normalize_download_fields(value: &mut Value) {
    match value {
        Value::Object(obj) => {
            for key in ["downloadUrl", "url", "ctaUrl"] {
                if let Some(entry) = obj.get_mut(key) {
                    if let Some(raw) = entry.as_str() {
                        if let Some(normalized) = normalize_public_url(raw) {
                            *entry = Value::String(normalized);
                        } else if !raw.trim().is_empty() {
                            *entry = Value::String(String::new());
                        }
                    }
                }
            }
            for child in obj.values_mut() {
                normalize_download_fields(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_download_fields(item);
            }
        }
        _ => {}
    }
}

fn downloadable_asset(asset: &Value) -> bool {
    asset.get("source").and_then(Value::as_str) != Some("unavailable")
        && asset
            .get("downloadUrl")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
}

fn matches_platform(asset: &Value, platform: &str) -> bool {
    asset
        .get("platform")
        .and_then(Value::as_str)
        .map(|v| v.eq_ignore_ascii_case(platform))
        .unwrap_or(false)
}

fn matches_arch(asset: &Value, arch: &str) -> bool {
    asset
        .get("arch")
        .and_then(Value::as_str)
        .map(|v| v.eq_ignore_ascii_case(arch))
        .unwrap_or(false)
}

fn matches_file_type(asset: &Value, file_type: &str) -> bool {
    asset
        .get("fileType")
        .and_then(Value::as_str)
        .map(|v| v.eq_ignore_ascii_case(file_type))
        .unwrap_or(false)
}

fn asset_name(asset: &Value) -> String {
    asset
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn select_recommended_asset(assets: &[Value]) -> Option<Value> {
    select_recommended_asset_for(assets, target_platform(), target_arch())
}

fn target_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn target_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn arch_matches_target(asset: &Value, arch: &str) -> bool {
    matches_arch(asset, arch) || matches_arch(asset, "any")
}

fn select_recommended_asset_for(assets: &[Value], platform: &str, arch: &str) -> Option<Value> {
    let candidates: Vec<&Value> = assets
        .iter()
        .filter(|asset| downloadable_asset(asset))
        .collect();
    let platform_candidates: Vec<&Value> = candidates
        .iter()
        .copied()
        .filter(|asset| matches_platform(asset, platform))
        .collect();

    if let Some(asset) = platform_candidates.iter().find(|asset| {
        asset
            .get("recommended")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && arch_matches_target(asset, arch)
    }) {
        return Some((**asset).clone());
    }
    if let Some(asset) = platform_candidates.iter().find(|asset| {
        asset
            .get("recommended")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }) {
        return Some((**asset).clone());
    }

    if platform == "windows" {
        for asset in &platform_candidates {
            let name = asset_name(asset);
            if arch_matches_target(asset, arch)
                && matches_file_type(asset, "exe")
                && name.contains("x64-setup.exe")
                && !name.contains("full")
            {
                return Some((**asset).clone());
            }
        }
        for asset in &platform_candidates {
            if arch_matches_target(asset, arch) && matches_file_type(asset, "exe") {
                return Some((**asset).clone());
            }
        }
    }

    if platform == "macos" {
        for asset in &platform_candidates {
            if arch_matches_target(asset, arch) && matches_file_type(asset, "dmg") {
                return Some((**asset).clone());
            }
        }
    }

    if platform == "linux" {
        for file_type in ["appimage", "deb", "rpm"] {
            for asset in &platform_candidates {
                if matches_file_type(asset, file_type) {
                    return Some((**asset).clone());
                }
            }
        }
    }

    platform_candidates
        .into_iter()
        .next()
        .cloned()
        .or_else(|| candidates.into_iter().next().cloned())
}

pub async fn site_latest_for_panel_update() -> Result<Value, String> {
    if super::platform::isolated_debug_enabled() {
        return Ok(
            json!({"latest":env!("CARGO_PKG_VERSION"),"url":"","source":"isolated-debug","downloadUrl":"","assets":[],"recommendedAsset":null}),
        );
    }
    let client = super::build_http_client(Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut latest = fetch_site_latest(&client).await?;
    normalize_download_fields(&mut latest);

    let version = latest
        .get("version")
        .and_then(Value::as_str)
        .or_else(|| latest.get("tagName").and_then(Value::as_str))
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    if version.is_empty() {
        return Err("site: 未找到版本号".into());
    }

    let assets: Vec<Value> = latest
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let recommended_asset = select_recommended_asset(&assets);
    let download_url = recommended_asset
        .as_ref()
        .and_then(|asset| asset.get("downloadUrl"))
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(SITE_BASE_URL)
        .to_string();

    let mut result = Map::new();
    result.insert("latest".into(), Value::String(version));
    result.insert("url".into(), Value::String(SITE_BASE_URL.into()));
    result.insert("source".into(), Value::String("site".into()));
    result.insert("downloadUrl".into(), Value::String(download_url));
    result.insert("assets".into(), Value::Array(assets));
    if let Some(asset) = recommended_asset {
        result.insert("recommendedAsset".into(), asset);
    } else {
        result.insert("recommendedAsset".into(), Value::Null);
    }
    for key in [
        "releaseNotes",
        "publishedAt",
        "tagName",
        "downloads",
        "telemetry",
        "update",
    ] {
        if let Some(value) = latest.get(key) {
            result.insert(key.into(), value.clone());
        }
    }

    Ok(Value::Object(result))
}

async fn fetch_site_latest(client: &reqwest::Client) -> Result<Value, String> {
    let url = cache_busted_site_url(LATEST_PATH, &[]);
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("site: 请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("site: HTTP {}", resp.status()));
    }
    resp.json()
        .await
        .map_err(|e| format!("site: 解析响应失败: {e}"))
}

#[tauri::command]
pub async fn check_site_announcements(locale: Option<String>) -> Result<Value, String> {
    if super::platform::isolated_debug_enabled() {
        return Ok(json!({"notifications":[],"announcements":[]}));
    }
    let client = super::build_http_client(Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let raw_locale = locale
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(default_locale);
    let locale = normalize_site_locale(&raw_locale);
    let url = cache_busted_site_url(
        ANNOUNCEMENTS_PATH,
        &[
            ("app", "ClawPanel".to_string()),
            ("version", env!("CARGO_PKG_VERSION").to_string()),
            ("locale", locale),
            ("surface", "client".to_string()),
        ],
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("公告请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("公告服务器返回 {}", resp.status()));
    }
    let mut body: Value = resp
        .json()
        .await
        .map_err(|e| format!("公告解析失败: {e}"))?;
    normalize_download_fields(&mut body);
    Ok(body)
}

pub fn start_heartbeat_loop() {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await;
        loop {
            send_heartbeat_once().await;
            interval.tick().await;
        }
    });
}

async fn send_heartbeat_once() {
    let client_id = match get_or_create_client_id() {
        Ok(id) => id,
        Err(_) => return,
    };
    let client = match super::build_http_client(Duration::from_secs(8), Some("ClawPanel")) {
        Ok(client) => client,
        Err(_) => return,
    };
    let payload = json!({
        "app": "ClawPanel",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "channel": "stable",
        "runtime": "tauri",
        "runtimeVersion": "tauri-v2",
        "locale": default_locale(),
    });
    let url = cache_busted_site_url(HEARTBEAT_PATH, &[]);
    let _ = client
        .post(url)
        .header("X-ClawPanel-Client-ID", client_id)
        .json(&payload)
        .send()
        .await;
}

fn client_id_path() -> PathBuf {
    default_openclaw_state_dir()
        .join("clawpanel")
        .join("client-id")
}

fn default_openclaw_state_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join(".openclaw");
            }
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".openclaw"))
        .unwrap_or_else(super::openclaw_dir)
}

fn get_or_create_client_id() -> Result<String, String> {
    let path = client_id_path();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if is_valid_client_id(trimmed) {
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 client-id 目录失败: {e}"))?;
    }
    fs::write(&path, &id).map_err(|e| format!("写入 client-id 失败: {e}"))?;
    Ok(id)
}

fn is_valid_client_id(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn default_locale() -> String {
    let raw = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    let normalized = raw
        .split('.')
        .next()
        .unwrap_or("")
        .replace('_', "-")
        .trim()
        .to_string();
    if normalized.is_empty() || normalized == "C" {
        "zh-CN".to_string()
    } else {
        normalized
    }
}

fn normalize_site_locale(locale: &str) -> String {
    let value = locale.trim().to_ascii_lowercase();
    if value.starts_with("zh") {
        "zh-CN".to_string()
    } else {
        "en".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, platform: &str, arch: &str, file_type: &str, recommended: bool) -> Value {
        json!({
            "name": name,
            "platform": platform,
            "arch": arch,
            "fileType": file_type,
            "recommended": recommended,
            "source": "mirror",
            "downloadUrl": format!("/api/v1/download/{name}")
        })
    }

    #[test]
    fn cache_busted_site_url_adds_timestamp_and_params() {
        let url = cache_busted_site_url(
            "/api/v1/latest",
            &[
                ("platform", "windows".to_string()),
                ("arch", "x64".to_string()),
            ],
        );
        assert!(url.starts_with("https://claw.qt.cool/api/v1/latest?"));
        assert!(url.contains("platform=windows"));
        assert!(url.contains("arch=x64"));
        assert!(url.contains("_t="));
    }

    #[test]
    fn announcements_url_targets_client_surface() {
        let url = cache_busted_site_url(
            ANNOUNCEMENTS_PATH,
            &[
                ("app", "ClawPanel".to_string()),
                ("version", "0.17.0".to_string()),
                ("locale", "zh-CN".to_string()),
                ("surface", "client".to_string()),
            ],
        );
        assert!(url.starts_with("https://claw.qt.cool/api/v1/announcements?"));
        assert!(url.contains("app=ClawPanel"));
        assert!(url.contains("version=0.17.0"));
        assert!(url.contains("locale=zh-CN"));
        assert!(url.contains("surface=client"));
    }

    #[test]
    fn site_locale_uses_chinese_or_english_only() {
        assert_eq!(normalize_site_locale("zh-CN"), "zh-CN");
        assert_eq!(normalize_site_locale("zh-TW"), "zh-CN");
        assert_eq!(normalize_site_locale("ja"), "en");
        assert_eq!(normalize_site_locale("de-DE"), "en");
        assert_eq!(normalize_site_locale(""), "en");
    }

    #[test]
    fn normalize_public_url_allows_only_site_and_github() {
        assert_eq!(
            normalize_public_url("http://claw.qt.cool/api/v1/download/1").as_deref(),
            Some("https://claw.qt.cool/api/v1/download/1")
        );
        assert_eq!(
            normalize_public_url("/api/v1/download/1").as_deref(),
            Some("https://claw.qt.cool/api/v1/download/1")
        );
        assert!(
            normalize_public_url("https://github.com/qingchencloud/clawpanel/releases").is_some()
        );
        assert!(normalize_public_url("https://example.com/file.exe").is_none());
    }

    #[test]
    fn select_recommended_asset_respects_remote_flag_on_target_platform() {
        let assets = vec![
            asset(
                "ClawPanel_0.17.0_x64-setup.exe",
                "windows",
                "x64",
                "exe",
                false,
            ),
            asset("ClawPanel_0.17.0_arm64.dmg", "macos", "arm64", "dmg", true),
            asset("web-0.17.0.zip", "web", "any", "zip", true),
        ];
        let selected =
            select_recommended_asset_for(&assets, "windows", "x64").expect("asset selected");
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ClawPanel_0.17.0_x64-setup.exe")
        );
    }

    #[test]
    fn select_recommended_asset_ignores_unavailable_assets() {
        let mut unavailable = asset(
            "ClawPanel_0.17.0_x64-setup.exe",
            "windows",
            "x64",
            "exe",
            true,
        );
        unavailable["source"] = Value::String("unavailable".into());
        unavailable["downloadUrl"] = Value::String(String::new());
        let fallback = asset(
            "ClawPanel_0.17.0.AppImage",
            "linux",
            "x64",
            "appimage",
            false,
        );
        let selected = select_recommended_asset_for(&[unavailable, fallback], "linux", "x64")
            .expect("asset selected");
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ClawPanel_0.17.0.AppImage")
        );
    }
}
