use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardianStatus {
    pub auto_restart_count: u32,
    pub max_auto_restarts: u32,
    pub manual_hold: bool,
    pub last_seen_running: Option<String>,
    pub running_since: Option<String>,
    pub give_up: bool,
}
