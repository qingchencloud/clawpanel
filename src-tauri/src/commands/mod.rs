use std::path::PathBuf;

pub mod agent;
pub mod config;
pub mod device;
pub mod extensions;
pub mod logs;
pub mod memory;
pub mod pairing;
pub mod service;

/// 获取 OpenClaw 配置目录 (~/.openclaw/)
pub fn openclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".openclaw")
}
