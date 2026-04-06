use serde::{Deserialize, Serialize};

/// Result returned after sandbox initialization completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxInitResult {
    pub initialized: bool,
    pub version: String,
}

/// Summary info about sandbox installation status (lightweight, for listing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStatus {
    pub installed: bool,
    pub version: String,
    pub dir: String,
}
