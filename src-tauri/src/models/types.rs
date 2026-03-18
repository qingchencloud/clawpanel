use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub label: String,
    pub pid: Option<u32>,
    pub running: bool,
    pub description: String,
    /// CLI 工具是否已安装（Windows/Linux: openclaw CLI）
    pub cli_installed: bool,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub cli_source: Option<String>,
    #[serde(default)]
    pub cli_candidates: Vec<String>,
    pub cli_selected_from_config: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VersionInfo {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub recommended: Option<String>,
    pub update_available: bool,
    pub latest_update_available: bool,
    pub is_recommended: bool,
    pub ahead_of_recommended: bool,
    pub panel_version: String,
    pub source: String,
}
