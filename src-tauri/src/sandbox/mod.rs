//! CJGClaw 沙箱隔离模块。
//! 所有路径解析到 ~/.cjgclaw/ 而不是 ~/.openclaw/
//! 所有 OpenClaw CLI 调用使用捆绑的绝对路径。

use std::path::PathBuf;

/// 返回 CJGClaw 数据目录（~/.cjgclaw）
pub fn cjgclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cjgclaw")
}

/// 返回从应用包中捆绑的 OpenClaw CLI 路径。
/// macOS: /Applications/CJGClaw.app/Contents/Resources/openclaw/...
/// Windows: C:/Program Files/CJGClaw/resources/openclaw/...
/// Linux: /opt/cjgclaw/resources/openclaw/...
pub fn bundled_openclaw_dir() -> PathBuf {
    std::env::var("RESOURCE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            if let Ok(exe) = std::env::current_exe() {
                exe.parent()
                    .map(|p| p.join("openclaw"))
                    .unwrap_or_else(|| PathBuf::from("/opt/cjgclaw/openclaw"))
            } else {
                PathBuf::from("/opt/cjgclaw/openclaw")
            }
        })
}

/// 返回 OpenClaw CLI 入口点的绝对路径。
/// 解析到: bundled_openclaw_dir()/node_modules/openclaw/openclaw.mjs
pub fn openclaw_cli_path() -> PathBuf {
    bundled_openclaw_dir().join("node_modules/openclaw/openclaw.mjs")
}

/// 返回 Gateway 监听端口（默认 28790，从 cjgclaw.json 读取）
pub fn gateway_port() -> u16 {
    static CACHE: std::sync::LazyLock<std::sync::Mutex<(std::time::Instant, u16)>> =
        std::sync::LazyLock::new(|| {
            std::sync::Mutex::new((std::time::Instant::now(), 28790))
        });

    let guard = CACHE.lock().unwrap();
    let elapsed = guard.0.elapsed().as_secs();
    if elapsed < 5 {
        return guard.1;
    }
    drop(guard);

    let port = read_cjgclaw_json_port().unwrap_or(28790);
    *CACHE.lock().unwrap() = (std::time::Instant::now(), port);
    port
}

fn read_cjgclaw_json_port() -> Option<u16> {
    let path = cjgclaw_dir().join("cjgclaw.json");
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("gateway")?.get("port")?.as_u64().map(|p| p as u16)
}

/// 返回 OpenClaw 配置目录（用于配置文件兼容性）。
/// CJGClaw 中为 ~/.cjgclaw/openclaw/（符号链接或捆绑默认值的副本）。
pub fn openclaw_config_dir() -> PathBuf {
    cjgclaw_dir().join("openclaw")
}

pub mod init;
pub mod openclaw;
pub mod gateway;
