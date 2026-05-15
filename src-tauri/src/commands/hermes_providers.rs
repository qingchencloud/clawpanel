//! Hermes Provider Registry — ClawPanel's built-in provider catalog
//! by Hermes Agent, with their auth schemes, env vars, base URLs, and known
//! model catalogs.
//!
//! This module is intentionally self-contained: it must NOT depend on any
//! runtime state. The static data is queried by commands in `hermes.rs`
//! and surfaced to the frontend via `hermes_list_providers`.

use serde::Serialize;

// =============================================================================
// Data model
// =============================================================================

/// - `api_key`: traditional env-var based key (`<PROVIDER>_API_KEY`, etc.)
/// - `oauth_device_code`: interactive device-code OAuth flow (Nous)
/// - `oauth_external`: OAuth handled by external process (Codex, Qwen)
/// - `external_process`: backing process handles auth (Copilot ACP)
pub const AUTH_API_KEY: &str = "api_key";
pub const AUTH_OAUTH_DEVICE: &str = "oauth_device_code";
pub const AUTH_OAUTH_EXTERNAL: &str = "oauth_external";
pub const AUTH_EXTERNAL_PROCESS: &str = "external_process";
pub const AUTH_AWS_SDK: &str = "aws_sdk";
pub const AUTH_OAUTH_MINIMAX: &str = "oauth_minimax";

/// Transport negotiated with the provider.
pub const TRANSPORT_OPENAI_CHAT: &str = "openai_chat";
pub const TRANSPORT_ANTHROPIC: &str = "anthropic_messages";
pub const TRANSPORT_GOOGLE: &str = "google_gemini";
pub const TRANSPORT_CODEX: &str = "codex_responses";

/// `/models` probe strategy used by `hermes_fetch_models`.
///
/// Note: all OpenAI-compatible providers (including Gemini via its OpenAI
/// adapter) use `PROBE_OPENAI`. A separate `PROBE_GOOGLE` was considered for
/// native Google Gemini API probing, but in practice every provider we
/// support uses one of these three strategies.
pub const PROBE_OPENAI: &str = "openai";
pub const PROBE_ANTHROPIC: &str = "anthropic";
pub const PROBE_NONE: &str = "none";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesProvider {
    /// Stable provider identifier.
    pub id: &'static str,
    /// Human-readable display name.
    pub name: &'static str,
    /// See AUTH_* constants above.
    pub auth_type: &'static str,
    /// Default inference base URL.
    pub base_url: &'static str,
    /// Env var name for overriding `base_url` (empty string = none).
    pub base_url_env_var: &'static str,
    /// Env vars checked in priority order for API key (empty for OAuth/external).
    pub api_key_env_vars: &'static [&'static str],
    /// See TRANSPORT_* constants above.
    pub transport: &'static str,
    /// See PROBE_* constants above.
    pub models_probe: &'static str,
    /// Known static model list.
    pub models: &'static [&'static str],
    /// True for aggregators/routers (OpenRouter, AI Gateway, etc.) — users
    /// must explicitly specify a model since there is no sensible default.
    pub is_aggregator: bool,
    /// Hint for the UI when the CLI must be used for login (OAuth providers).
    pub cli_auth_hint: &'static str,
}

// =============================================================================
// Static registry
// =============================================================================

const P_ANTHROPIC: HermesProvider = HermesProvider {
    id: "anthropic",
    name: "Anthropic",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.anthropic.com",
    base_url_env_var: "",
    api_key_env_vars: &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    transport: TRANSPORT_ANTHROPIC,
    models_probe: PROBE_ANTHROPIC,
    models: &[
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-20250514",
        "claude-sonnet-4-20250514",
        "claude-haiku-4-5-20251001",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_GEMINI: HermesProvider = HermesProvider {
    id: "gemini",
    name: "Google AI Studio",
    auth_type: AUTH_API_KEY,
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    base_url_env_var: "GEMINI_BASE_URL",
    api_key_env_vars: &["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemma-4-31b-it",
        "gemma-4-26b-it",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_DEEPSEEK: HermesProvider = HermesProvider {
    id: "deepseek",
    name: "DeepSeek",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.deepseek.com",
    base_url_env_var: "DEEPSEEK_BASE_URL",
    api_key_env_vars: &["DEEPSEEK_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &["deepseek-chat", "deepseek-reasoner"],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_ZAI: HermesProvider = HermesProvider {
    id: "zai",
    name: "Z.AI / GLM",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.z.ai/api/paas/v4",
    base_url_env_var: "GLM_BASE_URL",
    api_key_env_vars: &["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "glm-5.1",
        "glm-5",
        "glm-5v-turbo",
        "glm-5-turbo",
        "glm-4.7",
        "glm-4.5",
        "glm-4.5-flash",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_KIMI_CODING: HermesProvider = HermesProvider {
    id: "kimi-coding",
    name: "Kimi / Moonshot",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.moonshot.ai/v1",
    base_url_env_var: "KIMI_BASE_URL",
    api_key_env_vars: &["KIMI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "kimi-for-coding",
        "kimi-k2.6",
        "kimi-k2.5",
        "kimi-k2-thinking",
        "kimi-k2-turbo-preview",
        "kimi-k2-0905-preview",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_KIMI_CODING_CN: HermesProvider = HermesProvider {
    id: "kimi-coding-cn",
    name: "Kimi / Moonshot (China)",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.moonshot.cn/v1",
    base_url_env_var: "",
    api_key_env_vars: &["KIMI_CN_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "kimi-for-coding",
        "kimi-k2.6",
        "kimi-k2.5",
        "kimi-k2-thinking",
        "kimi-k2-turbo-preview",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_XAI: HermesProvider = HermesProvider {
    id: "xai",
    name: "xAI",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.x.ai/v1",
    base_url_env_var: "XAI_BASE_URL",
    api_key_env_vars: &["XAI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &["grok-4.20-reasoning", "grok-4-1-fast-reasoning"],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_MINIMAX: HermesProvider = HermesProvider {
    id: "minimax",
    name: "MiniMax (International)",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.minimax.io/anthropic/v1",
    base_url_env_var: "MINIMAX_BASE_URL",
    api_key_env_vars: &["MINIMAX_API_KEY"],
    transport: TRANSPORT_ANTHROPIC,
    models_probe: PROBE_ANTHROPIC,
    models: &[
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
        "MiniMax-M2-highspeed",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_MINIMAX_CN: HermesProvider = HermesProvider {
    id: "minimax-cn",
    name: "MiniMax (China)",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.minimaxi.com/v1",
    base_url_env_var: "MINIMAX_CN_BASE_URL",
    api_key_env_vars: &["MINIMAX_CN_API_KEY"],
    transport: TRANSPORT_ANTHROPIC,
    models_probe: PROBE_ANTHROPIC,
    models: &[
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
        "MiniMax-M2-highspeed",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_MINIMAX_OAUTH: HermesProvider = HermesProvider {
    id: "minimax-oauth",
    name: "MiniMax (OAuth)",
    auth_type: AUTH_OAUTH_MINIMAX,
    base_url: "https://api.minimax.io/anthropic",
    base_url_env_var: "",
    api_key_env_vars: &[],
    transport: TRANSPORT_ANTHROPIC,
    models_probe: PROBE_NONE,
    models: &[
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
        "MiniMax-M2-highspeed",
    ],
    is_aggregator: false,
    cli_auth_hint: "hermes auth login minimax-oauth",
};

const P_ALIBABA: HermesProvider = HermesProvider {
    id: "alibaba",
    // 与 Hermes 内核 1e01b25e7 保持一致：显示名重命名为 Qwen Cloud，
    // slug "alibaba" 与 DASHSCOPE_API_KEY env var 保持不变（用户现有配置不受影响）。
    name: "Qwen Cloud",
    auth_type: AUTH_API_KEY,
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    base_url_env_var: "DASHSCOPE_BASE_URL",
    api_key_env_vars: &["DASHSCOPE_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "qwen3.5-plus",
        "qwen3-coder-plus",
        "qwen3-coder-next",
        "glm-5",
        "glm-4.7",
        "kimi-k2.5",
        "MiniMax-M2.5",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_ALIBABA_CODING_PLAN: HermesProvider = HermesProvider {
    id: "alibaba-coding-plan",
    name: "Alibaba Cloud (Coding Plan)",
    auth_type: AUTH_API_KEY,
    base_url: "https://coding-intl.dashscope.aliyuncs.com/v1",
    base_url_env_var: "ALIBABA_CODING_PLAN_BASE_URL",
    api_key_env_vars: &["ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "qwen3-coder-plus",
        "qwen3-coder-next",
        "qwen3.5-plus",
        "qwen3.5-coder",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_HUGGINGFACE: HermesProvider = HermesProvider {
    id: "huggingface",
    name: "Hugging Face",
    auth_type: AUTH_API_KEY,
    base_url: "https://router.huggingface.co/v1",
    base_url_env_var: "HF_BASE_URL",
    api_key_env_vars: &["HF_TOKEN"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "Qwen/Qwen3.5-397B-A17B",
        "Qwen/Qwen3.5-35B-A3B",
        "deepseek-ai/DeepSeek-V3.2",
        "moonshotai/Kimi-K2.5",
        "MiniMaxAI/MiniMax-M2.5",
        "zai-org/GLM-5",
        "XiaomiMiMo/MiMo-V2-Flash",
        "moonshotai/Kimi-K2-Thinking",
    ],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_XIAOMI: HermesProvider = HermesProvider {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.xiaomimimo.com/v1",
    base_url_env_var: "XIAOMI_BASE_URL",
    api_key_env_vars: &["XIAOMI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &["mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_ARCEE: HermesProvider = HermesProvider {
    id: "arcee",
    name: "Arcee AI",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.arcee.ai/api/v1",
    base_url_env_var: "ARCEE_BASE_URL",
    api_key_env_vars: &["ARCEEAI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_AZURE_FOUNDRY: HermesProvider = HermesProvider {
    id: "azure-foundry",
    name: "Azure Foundry",
    auth_type: AUTH_API_KEY,
    base_url: "",
    base_url_env_var: "AZURE_FOUNDRY_BASE_URL",
    api_key_env_vars: &["AZURE_FOUNDRY_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_BEDROCK: HermesProvider = HermesProvider {
    id: "bedrock",
    name: "AWS Bedrock",
    auth_type: AUTH_AWS_SDK,
    base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
    base_url_env_var: "BEDROCK_BASE_URL",
    api_key_env_vars: &[],
    transport: TRANSPORT_ANTHROPIC,
    models_probe: PROBE_NONE,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_GMI: HermesProvider = HermesProvider {
    id: "gmi",
    name: "GMI Cloud",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.gmi-serving.com/v1",
    base_url_env_var: "GMI_BASE_URL",
    api_key_env_vars: &["GMI_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_LMSTUDIO: HermesProvider = HermesProvider {
    id: "lmstudio",
    name: "LM Studio",
    auth_type: AUTH_API_KEY,
    base_url: "http://127.0.0.1:1234/v1",
    base_url_env_var: "LM_BASE_URL",
    api_key_env_vars: &["LM_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_NVIDIA: HermesProvider = HermesProvider {
    id: "nvidia",
    name: "NVIDIA NIM",
    auth_type: AUTH_API_KEY,
    base_url: "https://integrate.api.nvidia.com/v1",
    base_url_env_var: "NVIDIA_BASE_URL",
    api_key_env_vars: &["NVIDIA_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_OLLAMA_CLOUD: HermesProvider = HermesProvider {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    auth_type: AUTH_API_KEY,
    base_url: "https://ollama.com/v1",
    base_url_env_var: "OLLAMA_BASE_URL",
    api_key_env_vars: &["OLLAMA_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_AI_GATEWAY: HermesProvider = HermesProvider {
    id: "ai-gateway",
    name: "Vercel AI Gateway",
    auth_type: AUTH_API_KEY,
    base_url: "https://ai-gateway.vercel.sh/v1",
    base_url_env_var: "AI_GATEWAY_BASE_URL",
    api_key_env_vars: &["AI_GATEWAY_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-haiku-4.5",
        "openai/gpt-5",
        "openai/gpt-4.1",
        "openai/gpt-4.1-mini",
        "google/gemini-3-pro-preview",
        "google/gemini-3-flash",
        "google/gemini-2.5-pro",
        "google/gemini-2.5-flash",
        "deepseek/deepseek-v3.2",
    ],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_OPENCODE_ZEN: HermesProvider = HermesProvider {
    id: "opencode-zen",
    name: "OpenCode Zen",
    auth_type: AUTH_API_KEY,
    base_url: "https://opencode.ai/zen/v1",
    base_url_env_var: "OPENCODE_ZEN_BASE_URL",
    api_key_env_vars: &["OPENCODE_ZEN_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "gpt-5.4-pro",
        "gpt-5.4",
        "gpt-5.3-codex",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "gemini-3.1-pro",
        "gemini-3-pro",
        "minimax-m2.7",
        "glm-5",
        "kimi-k2.5",
        "qwen3-coder",
    ],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_OPENCODE_GO: HermesProvider = HermesProvider {
    id: "opencode-go",
    name: "OpenCode Go",
    auth_type: AUTH_API_KEY,
    base_url: "https://opencode.ai/zen/go/v1",
    base_url_env_var: "OPENCODE_GO_BASE_URL",
    api_key_env_vars: &["OPENCODE_GO_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "glm-5.1",
        "glm-5",
        "kimi-k2.5",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "minimax-m2.7",
        "minimax-m2.5",
    ],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_KILOCODE: HermesProvider = HermesProvider {
    id: "kilocode",
    name: "Kilo Code",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.kilo.ai/api/gateway",
    base_url_env_var: "KILOCODE_BASE_URL",
    api_key_env_vars: &["KILOCODE_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5.4",
        "google/gemini-3-pro-preview",
        "google/gemini-3-flash-preview",
    ],
    is_aggregator: true,
    cli_auth_hint: "",
};

const P_COPILOT: HermesProvider = HermesProvider {
    id: "copilot",
    name: "GitHub Copilot (PAT)",
    auth_type: AUTH_API_KEY,
    base_url: "https://api.githubcopilot.com",
    base_url_env_var: "",
    api_key_env_vars: &["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_NONE,
    models: &[
        "gpt-4o",
        "gpt-4.1",
        "claude-3.5-sonnet",
        "claude-3.7-sonnet",
        "claude-sonnet-4-5",
        "o1",
        "o1-mini",
        "gemini-2.5-pro",
    ],
    is_aggregator: false,
    cli_auth_hint: "",
};

const P_OPENROUTER: HermesProvider = HermesProvider {
    id: "openrouter",
    name: "OpenRouter",
    auth_type: AUTH_API_KEY,
    base_url: "https://openrouter.ai/api/v1",
    base_url_env_var: "OPENAI_BASE_URL",
    api_key_env_vars: &["OPENROUTER_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: true,
    cli_auth_hint: "",
};

// OAuth providers — NO api_key_env_vars; user must run CLI to log in.

const P_NOUS: HermesProvider = HermesProvider {
    id: "nous",
    name: "Nous Portal",
    auth_type: AUTH_OAUTH_DEVICE,
    base_url: "https://inference-api.nousresearch.com/v1",
    base_url_env_var: "",
    api_key_env_vars: &[],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_NONE,
    models: &[
        "moonshotai/kimi-k2.6",
        "anthropic/claude-opus-4.7",
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5.4",
        "google/gemini-3-pro-preview",
        "qwen/qwen3.5-plus-02-15",
        "minimax/minimax-m2.7",
        "z-ai/glm-5.1",
        "x-ai/grok-4.20-beta",
    ],
    is_aggregator: true,
    cli_auth_hint: "hermes auth login nous",
};

const P_OPENAI_CODEX: HermesProvider = HermesProvider {
    id: "openai-codex",
    name: "OpenAI Codex",
    auth_type: AUTH_OAUTH_EXTERNAL,
    base_url: "https://chatgpt.com/backend-api/codex",
    base_url_env_var: "",
    api_key_env_vars: &[],
    transport: TRANSPORT_CODEX,
    models_probe: PROBE_NONE,
    models: &[
        "gpt-5.5",
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.2-codex",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-mini",
    ],
    is_aggregator: false,
    cli_auth_hint: "hermes auth login openai-codex",
};

const P_QWEN_OAUTH: HermesProvider = HermesProvider {
    id: "qwen-oauth",
    name: "Qwen OAuth",
    auth_type: AUTH_OAUTH_EXTERNAL,
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    base_url_env_var: "",
    api_key_env_vars: &[],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_NONE,
    models: &["qwen3.5-plus", "qwen3-coder-plus", "qwen3-coder-next"],
    is_aggregator: false,
    cli_auth_hint: "hermes auth login qwen-oauth",
};

const P_GOOGLE_GEMINI_CLI: HermesProvider = HermesProvider {
    id: "google-gemini-cli",
    name: "Google Gemini (OAuth)",
    auth_type: AUTH_OAUTH_EXTERNAL,
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    base_url_env_var: "",
    api_key_env_vars: &[],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_NONE,
    models: &["gemini-2.5-pro", "gemini-2.5-flash"],
    is_aggregator: false,
    cli_auth_hint: "hermes auth login google-gemini-cli",
};

const P_COPILOT_ACP: HermesProvider = HermesProvider {
    id: "copilot-acp",
    name: "GitHub Copilot ACP",
    auth_type: AUTH_EXTERNAL_PROCESS,
    base_url: "http://127.0.0.1:0",
    base_url_env_var: "COPILOT_ACP_BASE_URL",
    api_key_env_vars: &[],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_NONE,
    models: &[
        "gpt-4o",
        "gpt-4.1",
        "claude-3.5-sonnet",
        "claude-3.7-sonnet",
    ],
    is_aggregator: false,
    cli_auth_hint: "hermes auth login copilot-acp",
};

// Custom placeholder — frontend-only. Backend treats `custom` as opaque:
// uses whatever api_key + base_url the user provides.
const P_CUSTOM: HermesProvider = HermesProvider {
    id: "custom",
    name: "Custom OpenAI-Compatible",
    auth_type: AUTH_API_KEY,
    base_url: "",
    base_url_env_var: "OPENAI_BASE_URL",
    api_key_env_vars: &["OPENAI_API_KEY", "CUSTOM_API_KEY"],
    transport: TRANSPORT_OPENAI_CHAT,
    models_probe: PROBE_OPENAI,
    models: &[],
    is_aggregator: true,
    cli_auth_hint: "",
};

/// Full provider registry. Order matters for UI rendering (first = top).
pub const ALL_PROVIDERS: &[HermesProvider] = &[
    // API-key providers — international
    P_ANTHROPIC,
    P_GEMINI,
    P_DEEPSEEK,
    P_XAI,
    P_MINIMAX,
    P_HUGGINGFACE,
    P_ARCEE,
    P_AZURE_FOUNDRY,
    P_GMI,
    P_LMSTUDIO,
    P_NVIDIA,
    P_OLLAMA_CLOUD,
    P_COPILOT,
    // API-key providers — China
    P_ZAI,
    P_KIMI_CODING,
    P_KIMI_CODING_CN,
    P_ALIBABA,
    P_ALIBABA_CODING_PLAN,
    P_MINIMAX_CN,
    P_XIAOMI,
    // SDK-backed providers
    P_BEDROCK,
    // Aggregators / routers
    P_OPENROUTER,
    P_AI_GATEWAY,
    P_OPENCODE_ZEN,
    P_OPENCODE_GO,
    P_KILOCODE,
    // OAuth / external-process
    P_NOUS,
    P_OPENAI_CODEX,
    P_QWEN_OAUTH,
    P_GOOGLE_GEMINI_CLI,
    P_MINIMAX_OAUTH,
    P_COPILOT_ACP,
    // Custom (frontend placeholder)
    P_CUSTOM,
];

// =============================================================================
// Query helpers
// =============================================================================

/// Look up a provider by stable id.
pub fn get_provider(id: &str) -> Option<&'static HermesProvider> {
    ALL_PROVIDERS.iter().find(|p| p.id == id)
}

/// Primary env var for writing the API key for a given provider.
/// Returns `None` for OAuth / external_process providers.
pub fn primary_api_key_env(provider_id: &str) -> Option<&'static str> {
    get_provider(provider_id).and_then(|p| p.api_key_env_vars.first().copied())
}

/// Env var for overriding the base URL (empty string if provider has no such var).
pub fn primary_base_url_env(provider_id: &str) -> Option<&'static str> {
    get_provider(provider_id).and_then(|p| {
        if p.base_url_env_var.is_empty() {
            None
        } else {
            Some(p.base_url_env_var)
        }
    })
}

/// All env var keys that ClawPanel manages across every provider.
/// Used by `configure_hermes::merge_env_file` to know which keys to clear
/// when the user switches providers. This is the union of:
///   - all `api_key_env_vars` across providers
///   - all non-empty `base_url_env_var` values
///   - the two ClawPanel-specific env vars (`GATEWAY_ALLOW_ALL_USERS`,
///     `API_SERVER_KEY`)
pub fn all_managed_env_keys() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for p in ALL_PROVIDERS {
        for ev in p.api_key_env_vars {
            if !out.contains(ev) {
                out.push(ev);
            }
        }
        if !p.base_url_env_var.is_empty() && !out.contains(&p.base_url_env_var) {
            out.push(p.base_url_env_var);
        }
    }
    // ClawPanel-specific keys
    for extra in &["GATEWAY_ALLOW_ALL_USERS", "API_SERVER_KEY"] {
        if !out.contains(extra) {
            out.push(extra);
        }
    }
    out
}

/// Given the set of env var keys present in a `.env` file, infer the most
/// likely provider. Priority follows `ALL_PROVIDERS` order, so users who have
/// multiple provider keys set will be identified with the first matching
/// canonical provider.
pub fn infer_provider_from_env_keys(keys: &[&str]) -> Option<&'static str> {
    for p in ALL_PROVIDERS {
        if p.api_key_env_vars.is_empty() {
            continue; // Skip OAuth/external
        }
        for ev in p.api_key_env_vars {
            if keys.contains(ev) {
                return Some(p.id);
            }
        }
    }
    None
}

/// Find the first provider whose static model catalog contains the given model
/// name (exact match). Returns `None` on ambiguity (multiple matches) or miss.
pub fn find_provider_by_model(model: &str) -> Option<&'static str> {
    let hits: Vec<&'static str> = ALL_PROVIDERS
        .iter()
        .filter(|p| p.models.contains(&model))
        .map(|p| p.id)
        .collect();
    if hits.len() == 1 {
        Some(hits[0])
    } else {
        None
    }
}

// =============================================================================
// Tauri command
// =============================================================================

/// Return the full provider registry for the frontend. The list is static —
/// clients can cache it for the lifetime of the session.
#[tauri::command]
pub fn hermes_list_providers() -> Vec<HermesProvider> {
    ALL_PROVIDERS.to_vec()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_expected_providers() {
        assert_eq!(ALL_PROVIDERS.len(), 33);
        assert!(get_provider("anthropic").is_some());
        assert!(get_provider("gemini").is_some());
        assert!(get_provider("alibaba-coding-plan").is_some());
        assert!(get_provider("bedrock").is_some());
        assert!(get_provider("lmstudio").is_some());
        assert!(get_provider("nous").is_some());
        assert!(get_provider("custom").is_some());
        assert!(get_provider("nonexistent").is_none());
    }

    #[test]
    fn primary_api_key_env_picks_first() {
        assert_eq!(primary_api_key_env("anthropic"), Some("ANTHROPIC_API_KEY"));
        assert_eq!(primary_api_key_env("gemini"), Some("GOOGLE_API_KEY"));
        assert_eq!(primary_api_key_env("zai"), Some("GLM_API_KEY"));
        assert_eq!(primary_api_key_env("bedrock"), None);
        assert_eq!(primary_api_key_env("nous"), None);
    }

    #[test]
    fn all_managed_env_keys_covers_everything() {
        let keys = all_managed_env_keys();
        assert!(keys.contains(&"ANTHROPIC_API_KEY"));
        assert!(keys.contains(&"DEEPSEEK_API_KEY"));
        assert!(keys.contains(&"GOOGLE_API_KEY"));
        assert!(keys.contains(&"GEMINI_API_KEY"));
        assert!(keys.contains(&"GEMINI_BASE_URL"));
        assert!(keys.contains(&"ALIBABA_CODING_PLAN_API_KEY"));
        assert!(keys.contains(&"LM_API_KEY"));
        assert!(keys.contains(&"GATEWAY_ALLOW_ALL_USERS"));
        assert!(keys.contains(&"API_SERVER_KEY"));
        // No duplicates
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                assert_ne!(keys[i], keys[j], "duplicate: {}", keys[i]);
            }
        }
    }

    #[test]
    fn infer_provider_from_env_keys_follows_registry_order() {
        // ANTHROPIC appears before DEEPSEEK in ALL_PROVIDERS, so if both are present
        // the anthropic entry wins.
        let keys = vec!["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY"];
        assert_eq!(infer_provider_from_env_keys(&keys), Some("anthropic"));

        // Only DeepSeek set → matches deepseek.
        let keys = vec!["DEEPSEEK_API_KEY"];
        assert_eq!(infer_provider_from_env_keys(&keys), Some("deepseek"));

        // Secondary anthropic env var still matches.
        let keys = vec!["ANTHROPIC_TOKEN"];
        assert_eq!(infer_provider_from_env_keys(&keys), Some("anthropic"));

        // Unknown key → no match.
        let keys = vec!["UNRELATED_KEY"];
        assert_eq!(infer_provider_from_env_keys(&keys), None);
    }

    #[test]
    fn find_provider_by_model_is_unambiguous() {
        assert_eq!(find_provider_by_model("deepseek-chat"), Some("deepseek"));
        assert_eq!(find_provider_by_model("kimi-for-coding"), None);
        assert_eq!(find_provider_by_model("nonexistent"), None);
    }
}
