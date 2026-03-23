/// 消息渠道管理
/// 负责 Telegram / Discord / QQ Bot 等消息渠道的配置持久化与凭证校验
/// 配置写入 openclaw.json 的 channels / plugins 节点
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn platform_storage_key(platform: &str) -> &str {
    match platform {
        "dingtalk" | "dingtalk-connector" => "dingtalk-connector",
        "weixin" => "openclaw-weixin",
        _ => platform,
    }
}

fn platform_list_id(platform: &str) -> &str {
    match platform {
        "dingtalk-connector" => "dingtalk",
        "openclaw-weixin" => "weixin",
        _ => platform,
    }
}

fn ensure_chat_completions_enabled(cfg: &mut Value) -> Result<(), String> {
    let root = cfg.as_object_mut().ok_or("配置格式错误")?;
    let gateway = root.entry("gateway").or_insert_with(|| json!({}));
    let gateway_obj = gateway.as_object_mut().ok_or("gateway 节点格式错误")?;
    let http = gateway_obj.entry("http").or_insert_with(|| json!({}));
    let http_obj = http.as_object_mut().ok_or("gateway.http 节点格式错误")?;
    let endpoints = http_obj.entry("endpoints").or_insert_with(|| json!({}));
    let endpoints_obj = endpoints
        .as_object_mut()
        .ok_or("gateway.http.endpoints 节点格式错误")?;
    let chat = endpoints_obj
        .entry("chatCompletions")
        .or_insert_with(|| json!({}));
    let chat_obj = chat
        .as_object_mut()
        .ok_or("gateway.http.endpoints.chatCompletions 节点格式错误")?;
    chat_obj.insert("enabled".into(), Value::Bool(true));
    Ok(())
}

fn form_string(form_obj: &Map<String, Value>, key: &str) -> String {
    form_obj
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn insert_string_if_present(form: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(v) = source.get(key).and_then(|v| v.as_str()) {
        form.insert(key.into(), Value::String(v.into()));
    }
}

fn insert_bool_as_string(form: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(v) = source.get(key).and_then(|v| v.as_bool()) {
        form.insert(
            key.into(),
            Value::String(if v { "true" } else { "false" }.into()),
        );
    }
}

fn insert_array_as_csv(form: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(items) = source.get(key).and_then(|v| v.as_array()) {
        let joined = items
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if !joined.is_empty() {
            form.insert(key.into(), Value::String(joined));
        }
    }
}

fn csv_to_json_array(raw: &str) -> Option<Value> {
    let items = raw
        .split(|c| c == ',' || c == '\n' || c == ';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .collect::<Vec<_>>();
    if items.is_empty() {
        None
    } else {
        Some(Value::Array(items))
    }
}

fn bool_from_form_value(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn put_string(entry: &mut Map<String, Value>, key: &str, value: String) {
    if !value.is_empty() {
        entry.insert(key.into(), Value::String(value));
    }
}

fn put_bool_from_form(entry: &mut Map<String, Value>, key: &str, raw: &str) {
    if let Some(v) = bool_from_form_value(raw) {
        entry.insert(key.into(), Value::Bool(v));
    }
}

fn put_csv_array_from_form(entry: &mut Map<String, Value>, key: &str, raw: &str) {
    if let Some(v) = csv_to_json_array(raw) {
        entry.insert(key.into(), v);
    }
}

fn gateway_auth_mode(cfg: &Value) -> Option<&str> {
    cfg.get("gateway")
        .and_then(|g| g.get("auth"))
        .and_then(|a| a.get("mode"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn gateway_auth_value(cfg: &Value, key: &str) -> Option<String> {
    cfg.get("gateway")
        .and_then(|g| g.get("auth"))
        .and_then(|a| a.get(key))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

/// 读取指定平台的当前配置（从 openclaw.json 中提取表单可用的值）
/// account_id: 可选，指定时读取 channels.<platform>.accounts.<account_id>（多账号模式）
#[tauri::command]
pub async fn read_platform_config(
    platform: String,
    account_id: Option<String>,
) -> Result<Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform);

    let mut form = Map::new();

    // 多账号模式：读凭证位置
    // 飞书：credentials 可写在 root 或 accounts.<id> 下，优先找非空那个
    let channel_root = cfg.get("channels").and_then(|c| c.get(storage_key));
    let saved = match (&account_id, channel_root) {
        // 读指定账号的凭证（accounts.<id>），查不到时再试 root
        (Some(acct), Some(ch)) if !acct.is_empty() => {
            ch.get("accounts")
                .and_then(|a| a.get(acct.as_str()))
                .cloned()
                .or_else(|| {
                    // accountId 指定但该账号不存在 → 尝试读 root（可能是旧格式直接写在 root）
                    ch.get("appId")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|_| ch.clone())
                })
                .unwrap_or(Value::Null)
        }
        // 无账号：直接读 channel root（单账号场景）
        (_, Some(ch)) => ch.clone(),
        _ => Value::Null,
    };

    let exists = !saved.is_null();

    match platform.as_str() {
        "discord" => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // Discord 配置在 openclaw.json 中是展开的 guilds 结构
            // 需要反向提取成表单字段：token, guildId, channelId
            if let Some(t) = saved.get("token").and_then(|v| v.as_str()) {
                form.insert("token".into(), Value::String(t.into()));
            }
            if let Some(guilds) = saved.get("guilds").and_then(|v| v.as_object()) {
                if let Some(gid) = guilds.keys().next() {
                    form.insert("guildId".into(), Value::String(gid.clone()));
                    if let Some(channels) = guilds[gid].get("channels").and_then(|v| v.as_object())
                    {
                        let cids: Vec<&String> =
                            channels.keys().filter(|k| k.as_str() != "*").collect();
                        if let Some(cid) = cids.first() {
                            form.insert("channelId".into(), Value::String((*cid).clone()));
                        }
                    }
                }
            }
        }
        "telegram" => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // Telegram: botToken 直接保存, allowFrom 数组需要拼回逗号字符串
            if let Some(t) = saved.get("botToken").and_then(|v| v.as_str()) {
                form.insert("botToken".into(), Value::String(t.into()));
            }
            if let Some(arr) = saved.get("allowFrom").and_then(|v| v.as_array()) {
                let users: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
                form.insert("allowedUsers".into(), Value::String(users.join(", ")));
            }
        }
        "qqbot" => {
            // 多账号：读 accounts.<account_id>；单账号：先读 qqbot 根节点，若无凭证再读 accounts.default（与官方 CLI 一致）
            let qqbot_val: &Value = match (&account_id, channel_root) {
                (Some(acct), Some(ch)) if !acct.is_empty() => ch
                    .get("accounts")
                    .and_then(|a| a.get(acct.as_str()))
                    .filter(|v| !v.is_null())
                    .unwrap_or(&Value::Null),
                (_, Some(ch)) => {
                    if qqbot_channel_has_credentials(ch) {
                        ch
                    } else {
                        ch.get("accounts")
                            .and_then(|a| a.get(QQBOT_DEFAULT_ACCOUNT_ID))
                            .filter(|v| !v.is_null())
                            .unwrap_or(ch)
                    }
                }
                _ => &Value::Null,
            };

            let mut needs_migrate = false;
            let mut app_id_val: Option<&str> = None;
            let mut client_secret_val: Option<&str> = None;

            // 优先读新格式 appId + clientSecret
            if let Some(v) = qqbot_val
                .get("appId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                app_id_val = Some(v);
            }
            if let Some(v) = qqbot_val
                .get("clientSecret")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                client_secret_val = Some(v);
            }

            // 旧格式兼容：token = "AppID:ClientSecret"
            // 若新格式缺失，尝试从 token 拆分（仅读，不写回）
            if app_id_val.is_none() || client_secret_val.is_none() {
                if let Some(t) = qqbot_val.get("token").and_then(|v| v.as_str()) {
                    if let Some((aid, csec)) = t.split_once(':') {
                        if app_id_val.is_none() {
                            app_id_val = Some(aid.trim());
                        }
                        if client_secret_val.is_none() {
                            client_secret_val = Some(csec.trim());
                        }
                        needs_migrate = app_id_val.is_some() && client_secret_val.is_some();
                    }
                }
            }

            if app_id_val.is_none() && client_secret_val.is_none() {
                return Ok(json!({ "exists": false }));
            }

            // 写入表单字段（前端 UI 用 clientSecret）
            if let Some(v) = app_id_val {
                form.insert("appId".into(), Value::String(v.into()));
            }
            if let Some(v) = client_secret_val {
                form.insert("clientSecret".into(), Value::String(v.into()));
            }

            // 旧格式迁移：仅有 token 字符串时，折叠为 accounts.* 下的 appId + clientSecret + token（与官方 CLI 结构一致）
            let migrate_app_id = app_id_val.map(|s| s.to_string());
            let migrate_secret = client_secret_val.map(|s| s.to_string());
            if needs_migrate {
                let acct_key = account_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(QQBOT_DEFAULT_ACCOUNT_ID);
                let channels = cfg.as_object_mut().ok_or("配置格式错误")?;
                let qqbot_node = channels
                    .entry("qqbot")
                    .or_insert_with(|| json!({ "enabled": true }));
                let qqbot_obj = qqbot_node.as_object_mut().ok_or("qqbot 节点格式错误")?;
                qqbot_obj.insert("enabled".into(), Value::Bool(true));
                qqbot_obj.remove("appId");
                qqbot_obj.remove("clientSecret");
                qqbot_obj.remove("appSecret");
                qqbot_obj.remove("token");
                let accounts = qqbot_obj.entry("accounts").or_insert_with(|| json!({}));
                let accounts_obj = accounts.as_object_mut().ok_or("accounts 格式错误")?;
                let target = accounts_obj
                    .entry(acct_key.to_string())
                    .or_insert_with(|| json!({}));
                if let Some(obj) = target.as_object_mut() {
                    if let (Some(aid), Some(sec)) = (&migrate_app_id, &migrate_secret) {
                        obj.insert("appId".into(), Value::String(aid.clone()));
                        obj.insert("clientSecret".into(), Value::String(sec.clone()));
                        obj.insert("token".into(), Value::String(format!("{}:{}", aid, sec)));
                    }
                    obj.insert("enabled".into(), Value::Bool(true));
                }
                super::config::save_openclaw_json(&cfg)?;
            }

            return Ok(json!({ "exists": true, "values": Value::Object(form) }));
        }
        "feishu" => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // 飞书凭证：优先从 accounts.<id> 读（多账号），否则从 root 读
            if let Some(v) = saved.get("appId").and_then(|v| v.as_str()) {
                form.insert("appId".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("appSecret").and_then(|v| v.as_str()) {
                form.insert("appSecret".into(), Value::String(v.into()));
            }
            // 读 shared fields：优先从 channel root 读（多账号模式下 credentials 在 accounts 下，shared fields 在 root）
            if let Some(ref acct) = account_id {
                if !acct.is_empty() {
                    // 从 channel root 补 shared fields
                    if let Some(ch_root) = channel_root {
                        for key in &[
                            "domain",
                            "connectionMode",
                            "dmPolicy",
                            "groupPolicy",
                            "groupAllowFrom",
                            "groups",
                            "streaming",
                            "blockStreaming",
                            "typingIndicator",
                            "resolveSenderNames",
                            "textChunkLimit",
                            "mediaMaxMb",
                        ] {
                            if let Some(v) = ch_root.get(*key) {
                                if !v.is_null() {
                                    form.insert(key.to_string(), v.clone());
                                }
                            }
                        }
                    }
                }
            } else {
                // 无账号：直接从 root 读 shared fields
                if let Some(v) = saved.get("domain").and_then(|v| v.as_str()) {
                    form.insert("domain".into(), Value::String(v.into()));
                }
            }
        }
        "dingtalk" | "dingtalk-connector" => {
            if let Some(v) = saved.get("clientId").and_then(|v| v.as_str()) {
                form.insert("clientId".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("clientSecret").and_then(|v| v.as_str()) {
                form.insert("clientSecret".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("gatewayToken").and_then(|v| v.as_str()) {
                form.insert("gatewayToken".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("gatewayPassword").and_then(|v| v.as_str()) {
                form.insert("gatewayPassword".into(), Value::String(v.into()));
            }
            match gateway_auth_mode(&cfg) {
                Some("token") => {
                    if let Some(v) = gateway_auth_value(&cfg, "token") {
                        form.insert("gatewayToken".into(), Value::String(v));
                    }
                    form.remove("gatewayPassword");
                }
                Some("password") => {
                    if let Some(v) = gateway_auth_value(&cfg, "password") {
                        form.insert("gatewayPassword".into(), Value::String(v));
                    }
                    form.remove("gatewayToken");
                }
                _ => {}
            }
        }
        "slack" => {
            insert_string_if_present(&mut form, &saved, "mode");
            insert_string_if_present(&mut form, &saved, "botToken");
            insert_string_if_present(&mut form, &saved, "appToken");
            insert_string_if_present(&mut form, &saved, "signingSecret");
            insert_string_if_present(&mut form, &saved, "webhookPath");
            insert_string_if_present(&mut form, &saved, "teamId");
            insert_string_if_present(&mut form, &saved, "appId");
            insert_string_if_present(&mut form, &saved, "socketMode");
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
        }
        "whatsapp" => {
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
            insert_bool_as_string(&mut form, &saved, "enabled");
        }
        "signal" => {
            insert_string_if_present(&mut form, &saved, "account");
            insert_string_if_present(&mut form, &saved, "cliPath");
            insert_string_if_present(&mut form, &saved, "httpUrl");
            insert_string_if_present(&mut form, &saved, "httpHost");
            insert_string_if_present(&mut form, &saved, "httpPort");
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
        }
        "matrix" => {
            insert_string_if_present(&mut form, &saved, "homeserver");
            insert_string_if_present(&mut form, &saved, "accessToken");
            insert_string_if_present(&mut form, &saved, "userId");
            insert_string_if_present(&mut form, &saved, "password");
            insert_string_if_present(&mut form, &saved, "deviceId");
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_bool_as_string(&mut form, &saved, "e2ee");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
            if saved.get("accessToken").and_then(|v| v.as_str()).is_some() {
                form.insert("authMode".into(), Value::String("token".into()));
            } else if saved.get("userId").and_then(|v| v.as_str()).is_some()
                || saved.get("password").and_then(|v| v.as_str()).is_some()
            {
                form.insert("authMode".into(), Value::String("password".into()));
            }
        }
        "msteams" => {
            insert_string_if_present(&mut form, &saved, "appId");
            insert_string_if_present(&mut form, &saved, "appPassword");
            insert_string_if_present(&mut form, &saved, "tenantId");
            insert_string_if_present(&mut form, &saved, "botEndpoint");
            insert_string_if_present(&mut form, &saved, "webhookPath");
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
        }
        _ => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // 通用：原样返回字符串 / 数组 / 布尔字段
            if let Some(obj) = saved.as_object() {
                for (k, v) in obj {
                    if k == "enabled" {
                        continue;
                    }
                    if let Some(s) = v.as_str() {
                        form.insert(k.clone(), Value::String(s.into()));
                    } else if v.is_array() {
                        insert_array_as_csv(&mut form, &saved, k);
                    } else if let Some(b) = v.as_bool() {
                        form.insert(
                            k.clone(),
                            Value::String(if b { "true" } else { "false" }.into()),
                        );
                    }
                }
            }
        }
    }

    Ok(json!({ "exists": exists, "values": Value::Object(form) }))
}

/// 保存平台配置到 openclaw.json
/// 前端传入的是表单字段，后端负责转换成 OpenClaw 要求的结构
/// account_id: 可选，指定时写入 channels.<platform>.accounts.<account_id>（多账号模式）
/// agent_id: 可选，指定时同时创建 bindings 配置将渠道绑定到 Agent
#[tauri::command]
pub async fn save_messaging_platform(
    platform: String,
    form: Value,
    account_id: Option<String>,
    agent_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform).to_string();

    let channels = cfg
        .as_object_mut()
        .ok_or("配置格式错误")?
        .entry("channels")
        .or_insert_with(|| json!({}));
    let channels_map = channels.as_object_mut().ok_or("channels 节点格式错误")?;

    let form_obj = form.as_object().ok_or("表单数据格式错误")?;

    // 用于后续创建 bindings 的平台信息
    let saved_account_id = account_id.clone();

    match platform.as_str() {
        "discord" => {
            let mut entry = Map::new();

            // Bot Token
            if let Some(t) = form_obj.get("token").and_then(|v| v.as_str()) {
                entry.insert("token".into(), Value::String(t.trim().into()));
            }
            entry.insert("enabled".into(), Value::Bool(true));
            entry.insert("groupPolicy".into(), Value::String("allowlist".into()));
            entry.insert("dm".into(), json!({ "enabled": false }));
            entry.insert(
                "retry".into(),
                json!({
                    "attempts": 3,
                    "minDelayMs": 500,
                    "maxDelayMs": 30000,
                    "jitter": 0.1
                }),
            );

            // guildId + channelId 展开为 guilds 嵌套结构
            let guild_id = form_obj
                .get("guildId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !guild_id.is_empty() {
                let channel_id = form_obj
                    .get("channelId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let channel_key = if channel_id.is_empty() {
                    "*".to_string()
                } else {
                    channel_id
                };
                entry.insert(
                    "guilds".into(),
                    json!({
                        guild_id: {
                            "users": ["*"],
                            "requireMention": true,
                            "channels": {
                                channel_key: { "allow": true, "requireMention": true }
                            }
                        }
                    }),
                );
            }

            channels_map.insert("discord".into(), Value::Object(entry));
        }
        "telegram" => {
            let mut entry = Map::new();

            if let Some(t) = form_obj.get("botToken").and_then(|v| v.as_str()) {
                entry.insert("botToken".into(), Value::String(t.trim().into()));
            }
            entry.insert("enabled".into(), Value::Bool(true));

            // allowedUsers 逗号字符串 → allowFrom 数组
            if let Some(users_str) = form_obj.get("allowedUsers").and_then(|v| v.as_str()) {
                let users: Vec<Value> = users_str
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| Value::String(s.into()))
                    .collect();
                if !users.is_empty() {
                    entry.insert("allowFrom".into(), Value::Array(users));
                }
            }

            channels_map.insert("telegram".into(), Value::Object(entry));
        }
        "qqbot" => {
            let app_id = form_obj
                .get("appId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            // 优先取 clientSecret（腾讯官方插件字段名）
            // 也兼容前端 UI 传 appSecret（旧字段名）
            let client_secret = form_obj
                .get("clientSecret")
                .or_else(|| form_obj.get("appSecret"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if app_id.is_empty() {
                return Err("AppID 不能为空".into());
            }
            if client_secret.is_empty() {
                return Err("ClientSecret 不能为空".into());
            }

            // 与 `openclaw channels add --channel qqbot --token "AppID:Secret"` 一致：凭证写在 accounts.<id> 下，并保留组合 token
            let acct_key = account_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(QQBOT_DEFAULT_ACCOUNT_ID);
            let token_combo = format!("{}:{}", app_id, client_secret);

            let qqbot_node = channels_map
                .entry("qqbot")
                .or_insert_with(|| json!({ "enabled": true }));
            let qqbot_obj = qqbot_node.as_object_mut().ok_or("qqbot 节点格式错误")?;
            qqbot_obj.insert("enabled".into(), Value::Bool(true));
            // 清除写在根上的旧字段，避免官方插件只认 accounts.* 时读不到账号
            qqbot_obj.remove("appId");
            qqbot_obj.remove("clientSecret");
            qqbot_obj.remove("appSecret");
            qqbot_obj.remove("token");

            let accounts = qqbot_obj.entry("accounts").or_insert_with(|| json!({}));
            let accounts_obj = accounts.as_object_mut().ok_or("accounts 格式错误")?;
            let mut entry = Map::new();
            entry.insert("appId".into(), Value::String(app_id));
            entry.insert("clientSecret".into(), Value::String(client_secret));
            entry.insert("token".into(), Value::String(token_combo));
            entry.insert("enabled".into(), Value::Bool(true));
            accounts_obj.insert(acct_key.to_string(), Value::Object(entry));

            ensure_openclaw_qqbot_plugin(&mut cfg)?;
            ensure_chat_completions_enabled(&mut cfg)?;
            let _ = cleanup_legacy_plugin_backup_dir("qqbot");
        }
        "feishu" => {
            let app_id = form_obj
                .get("appId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let app_secret = form_obj
                .get("appSecret")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if app_id.is_empty() || app_secret.is_empty() {
                return Err("App ID 和 App Secret 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("appId".into(), Value::String(app_id));
            entry.insert("appSecret".into(), Value::String(app_secret));
            entry.insert("enabled".into(), Value::Bool(true));
            entry.insert("connectionMode".into(), Value::String("websocket".into()));

            let domain = form_obj
                .get("domain")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !domain.is_empty() {
                entry.insert("domain".into(), Value::String(domain));
            }

            // 多账号模式：写入 channels.<storage_key>.accounts.<account_id>
            if let Some(ref acct) = account_id {
                if !acct.is_empty() {
                    let feishu = channels_map
                        .entry(storage_key.as_str())
                        .or_insert_with(|| json!({ "enabled": true }));
                    let feishu_obj = feishu.as_object_mut().ok_or("飞书节点格式错误")?;
                    feishu_obj.entry("enabled").or_insert(Value::Bool(true));
                    let accounts = feishu_obj.entry("accounts").or_insert_with(|| json!({}));
                    let accounts_obj = accounts.as_object_mut().ok_or("accounts 格式错误")?;
                    accounts_obj.insert(acct.clone(), Value::Object(entry));
                } else {
                    channels_map.insert(storage_key.clone(), Value::Object(entry));
                }
            } else {
                channels_map.insert(storage_key.clone(), Value::Object(entry));
            }
            ensure_plugin_allowed(&mut cfg, "openclaw-lark")?;
            // 禁用旧版 feishu 插件，防止新旧插件同时运行冲突
            disable_legacy_plugin(&mut cfg, "feishu");
            let _ = cleanup_legacy_plugin_backup_dir("feishu");
            let _ = cleanup_legacy_plugin_backup_dir("openclaw-lark");
        }
        "dingtalk" | "dingtalk-connector" => {
            let client_id = form_obj
                .get("clientId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let client_secret = form_obj
                .get("clientSecret")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if client_id.is_empty() || client_secret.is_empty() {
                return Err("Client ID 和 Client Secret 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("clientId".into(), Value::String(client_id));
            entry.insert("clientSecret".into(), Value::String(client_secret));
            entry.insert("enabled".into(), Value::Bool(true));

            let gateway_token = form_obj
                .get("gatewayToken")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !gateway_token.is_empty() {
                entry.insert("gatewayToken".into(), Value::String(gateway_token.into()));
            }

            let gateway_password = form_obj
                .get("gatewayPassword")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !gateway_password.is_empty() {
                entry.insert(
                    "gatewayPassword".into(),
                    Value::String(gateway_password.into()),
                );
            }

            channels_map.insert(storage_key, Value::Object(entry));
            ensure_plugin_allowed(&mut cfg, "dingtalk-connector")?;
            ensure_chat_completions_enabled(&mut cfg)?;
            let _ = cleanup_legacy_plugin_backup_dir("dingtalk-connector");
        }
        "slack" => {
            let mode = form_string(form_obj, "mode");
            let bot_token = form_string(form_obj, "botToken");
            let app_token = form_string(form_obj, "appToken");
            let signing_secret = form_string(form_obj, "signingSecret");

            if bot_token.is_empty() {
                return Err("Slack Bot Token 不能为空".into());
            }
            if mode == "http" && signing_secret.is_empty() {
                return Err("HTTP 模式下 Signing Secret 不能为空".into());
            }
            if mode != "http" && app_token.is_empty() {
                return Err("Socket 模式下 App Token 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(
                &mut entry,
                "mode",
                if mode.is_empty() {
                    "socket".into()
                } else {
                    mode
                },
            );
            put_string(&mut entry, "botToken", bot_token);
            put_string(&mut entry, "appToken", app_token);
            put_string(&mut entry, "signingSecret", signing_secret);
            put_string(
                &mut entry,
                "webhookPath",
                form_string(form_obj, "webhookPath"),
            );
            put_string(&mut entry, "teamId", form_string(form_obj, "teamId"));
            put_string(&mut entry, "appId", form_string(form_obj, "appId"));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_csv_array_from_form(&mut entry, "allowFrom", &form_string(form_obj, "allowFrom"));
            channels_map.insert(storage_key, Value::Object(entry));
        }
        "whatsapp" => {
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_csv_array_from_form(&mut entry, "allowFrom", &form_string(form_obj, "allowFrom"));
            put_bool_from_form(&mut entry, "enabled", &form_string(form_obj, "enabled"));
            channels_map.insert(storage_key, Value::Object(entry));
        }
        "signal" => {
            let account = form_string(form_obj, "account");
            if account.is_empty() {
                return Err("Signal 号码不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "account", account);
            put_string(&mut entry, "cliPath", form_string(form_obj, "cliPath"));
            put_string(&mut entry, "httpUrl", form_string(form_obj, "httpUrl"));
            put_string(&mut entry, "httpHost", form_string(form_obj, "httpHost"));
            put_string(&mut entry, "httpPort", form_string(form_obj, "httpPort"));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_csv_array_from_form(&mut entry, "allowFrom", &form_string(form_obj, "allowFrom"));
            channels_map.insert(storage_key, Value::Object(entry));
        }
        "matrix" => {
            let homeserver = form_string(form_obj, "homeserver");
            let access_token = form_string(form_obj, "accessToken");
            let user_id = form_string(form_obj, "userId");
            let password = form_string(form_obj, "password");

            if homeserver.is_empty() {
                return Err("Homeserver 不能为空".into());
            }
            if access_token.is_empty() && (user_id.is_empty() || password.is_empty()) {
                return Err("请至少填写 Access Token，或填写 User ID + Password".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "homeserver", homeserver);
            put_string(&mut entry, "accessToken", access_token);
            put_string(&mut entry, "userId", user_id);
            put_string(&mut entry, "password", password);
            put_string(&mut entry, "deviceId", form_string(form_obj, "deviceId"));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_bool_from_form(&mut entry, "e2ee", &form_string(form_obj, "e2ee"));
            put_csv_array_from_form(&mut entry, "allowFrom", &form_string(form_obj, "allowFrom"));
            channels_map.insert(storage_key, Value::Object(entry));
            ensure_plugin_allowed(&mut cfg, "matrix")?;
        }
        "msteams" => {
            let app_id = form_string(form_obj, "appId");
            let app_password = form_string(form_obj, "appPassword");
            if app_id.is_empty() || app_password.is_empty() {
                return Err("App ID 和 App Password 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "appId", app_id);
            put_string(&mut entry, "appPassword", app_password);
            put_string(&mut entry, "tenantId", form_string(form_obj, "tenantId"));
            put_string(
                &mut entry,
                "botEndpoint",
                form_string(form_obj, "botEndpoint"),
            );
            put_string(
                &mut entry,
                "webhookPath",
                form_string(form_obj, "webhookPath"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_csv_array_from_form(&mut entry, "allowFrom", &form_string(form_obj, "allowFrom"));
            channels_map.insert(storage_key, Value::Object(entry));
            ensure_plugin_allowed(&mut cfg, "msteams")?;
        }
        _ => {
            // 通用平台：直接保存表单字段
            let mut entry = Map::new();
            for (k, v) in form_obj {
                entry.insert(k.clone(), v.clone());
            }
            entry.insert("enabled".into(), Value::Bool(true));
            channels_map.insert(storage_key, Value::Object(entry));
        }
    }

    // 如果指定了 agent_id，同时创建 bindings 配置
    if let Some(ref agent) = agent_id {
        if !agent.is_empty() {
            create_agent_binding(&mut cfg, agent, &platform, saved_account_id)?;
        }
    }

    // 写回配置并重载 Gateway
    super::config::save_openclaw_json(&cfg)?;

    // Gateway 重载在后台进行，不阻塞 UI 响应
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(json!({ "ok": true }))
}

/// 删除指定平台配置
/// account_id: 可选，指定时仅删除 channels.<platform>.accounts.<account_id>（多账号模式）
///             未指定时删除整个平台配置
#[tauri::command]
pub async fn remove_messaging_platform(
    platform: String,
    account_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform);

    match &account_id {
        Some(acct) if !acct.is_empty() => {
            // 多账号模式：仅删除指定账号
            if let Some(channel) = cfg.get_mut("channels").and_then(|c| c.get_mut(storage_key)) {
                if let Some(accounts) = channel.get_mut("accounts").and_then(|a| a.as_object_mut())
                {
                    accounts.remove(acct.as_str());
                }
            }
        }
        _ => {
            // 整平台删除
            if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
                channels.remove(storage_key);
            }
        }
    }

    // 清理对应的 bindings 条目
    let binding_channel = platform_list_id(&platform);
    if let Some(bindings) = cfg.get_mut("bindings").and_then(|b| b.as_array_mut()) {
        bindings.retain(|b| {
            let m = match b.get("match") {
                Some(m) => m,
                None => return true,
            };
            if m.get("channel").and_then(|v| v.as_str()) != Some(binding_channel) {
                return true; // 不同渠道，保留
            }
            match &account_id {
                Some(acct) if !acct.is_empty() => {
                    m.get("accountId").and_then(|v| v.as_str()) != Some(acct.as_str())
                }
                _ => false, // 整平台删除，移除该渠道所有 binding
            }
        });
    }

    super::config::save_openclaw_json(&cfg)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(json!({ "ok": true }))
}

/// 切换平台启用/禁用
#[tauri::command]
pub async fn toggle_messaging_platform(
    platform: String,
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform);

    if let Some(entry) = cfg
        .get_mut("channels")
        .and_then(|c| c.get_mut(storage_key))
        .and_then(|v| v.as_object_mut())
    {
        entry.insert("enabled".into(), Value::Bool(enabled));
    } else {
        return Err(format!("平台 {} 未配置", platform));
    }

    super::config::save_openclaw_json(&cfg)?;
    // Gateway 重载在后台进行，不阻塞 UI 响应
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(json!({ "ok": true }))
}

/// 在线校验 Bot 凭证（调用平台 API 验证 Token 是否有效）
#[tauri::command]
pub async fn verify_bot_token(platform: String, form: Value) -> Result<Value, String> {
    let form_obj = form.as_object().ok_or("表单数据格式错误")?;
    let client = super::build_http_client(std::time::Duration::from_secs(15), None)
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;

    match platform.as_str() {
        "discord" => verify_discord(&client, form_obj).await,
        "telegram" => verify_telegram(&client, form_obj).await,
        "qqbot" => verify_qqbot(&client, form_obj).await,
        "feishu" => verify_feishu(&client, form_obj).await,
        "dingtalk" | "dingtalk-connector" => verify_dingtalk(&client, form_obj).await,
        "slack" => verify_slack(&client, form_obj).await,
        "matrix" => verify_matrix(&client, form_obj).await,
        "signal" => verify_signal(&client, form_obj).await,
        "msteams" => verify_msteams(&client, form_obj).await,
        "whatsapp" => Ok(json!({
            "valid": true,
            "warnings": ["WhatsApp 使用扫码登录，无需在线校验凭证；请通过「启动扫码登录」完成配对"]
        })),
        _ => Ok(json!({
            "valid": true,
            "warnings": ["该平台暂不支持在线校验"]
        })),
    }
}

/// 检测微信插件安装状态与版本
#[tauri::command]
pub async fn check_weixin_plugin_status() -> Result<Value, String> {
    let ext_dir = super::openclaw_dir()
        .join("extensions")
        .join("openclaw-weixin");
    let mut installed = false;
    let mut installed_version: Option<String> = None;

    // 检查本地安装
    let pkg_json = ext_dir.join("package.json");
    if pkg_json.is_file() {
        installed = true;
        if let Ok(content) = std::fs::read_to_string(&pkg_json) {
            if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
                installed_version = pkg
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }

    // 从 npm registry 获取最新版本
    let mut latest_version: Option<String> = None;
    let client = super::build_http_client(std::time::Duration::from_secs(8), None)
        .unwrap_or_else(|_| reqwest::Client::new());
    if let Ok(resp) = client
        .get("https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/latest")
        .header("Accept", "application/json")
        .send()
        .await
    {
        if let Ok(body) = resp.json::<Value>().await {
            latest_version = body
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }

    let update_available = match (&installed_version, &latest_version) {
        (Some(cur), Some(lat)) if cur != lat => {
            // 简单 semver 比较：按 . 分割为数字段逐段比较
            let parse =
                |s: &str| -> Vec<u32> { s.split('.').filter_map(|p| p.parse().ok()).collect() };
            let cv = parse(cur);
            let lv = parse(lat);
            lv > cv
        }
        _ => false,
    };

    Ok(json!({
        "installed": installed,
        "installedVersion": installed_version,
        "latestVersion": latest_version,
        "updateAvailable": update_available,
        "extensionDir": ext_dir.to_string_lossy(),
    }))
}

#[tauri::command]
pub async fn run_channel_action(
    app: tauri::AppHandle,
    platform: String,
    action: String,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;

    let platform = platform.trim().to_string();
    let action = action.trim().to_string();
    if platform.is_empty() || action.is_empty() {
        return Err("platform 和 action 不能为空".into());
    }

    // weixin install 走 npx 而非 openclaw CLI
    if platform == "weixin" && action == "install" {
        let _ = app.emit("channel-action-log", json!({
            "platform": &platform, "action": &action, "kind": "info",
            "message": "开始安装微信插件: npx -y @tencent-weixin/openclaw-weixin-cli@latest install",
        }));
        let _ = app.emit(
            "channel-action-progress",
            json!({ "platform": &platform, "action": &action, "progress": 5 }),
        );

        let path_env = super::enhanced_path();
        #[cfg(target_os = "windows")]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut c = std::process::Command::new("cmd");
            c.args([
                "/c",
                "npx",
                "-y",
                "@tencent-weixin/openclaw-weixin-cli@latest",
                "install",
            ]);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = std::process::Command::new("npx");
            c.args([
                "-y",
                "@tencent-weixin/openclaw-weixin-cli@latest",
                "install",
            ]);
            c
        };
        cmd.env("PATH", &path_env);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        crate::commands::apply_proxy_env(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("启动 npx 失败: {}", e))?;

        let stderr = child.stderr.take();
        let app2 = app.clone();
        let platform2 = platform.clone();
        let action2 = action.clone();
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let err_lines = lines.clone();
        let handle = std::thread::spawn(move || {
            if let Some(pipe) = stderr {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    if let Ok(mut guard) = err_lines.lock() {
                        guard.push(line.clone());
                    }
                    let _ = app2.emit("channel-action-log", json!({ "platform": platform2, "action": action2, "message": line, "kind": "stderr" }));
                }
            }
        });

        let mut progress: u32 = 15;
        if let Some(pipe) = child.stdout.take() {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Ok(mut guard) = lines.lock() {
                    guard.push(line.clone());
                }
                let _ = app.emit("channel-action-log", json!({ "platform": &platform, "action": &action, "message": line, "kind": "stdout" }));
                if progress < 90 {
                    progress += 5;
                    let _ = app.emit(
                        "channel-action-progress",
                        json!({ "platform": &platform, "action": &action, "progress": progress }),
                    );
                }
            }
        }

        let _ = handle.join();
        let status = child
            .wait()
            .map_err(|e| format!("等待命令结束失败: {}", e))?;
        let text = lines.lock().ok().map(|g| g.join("\n")).unwrap_or_default();
        let _ = app.emit(
            "channel-action-progress",
            json!({ "platform": &platform, "action": &action, "progress": 100 }),
        );
        if status.success() {
            let _ = app.emit(
                "channel-action-done",
                json!({ "platform": &platform, "action": &action }),
            );
            return Ok(text);
        } else {
            let _ = app.emit(
                "channel-action-error",
                json!({ "platform": &platform, "action": &action, "message": "安装失败" }),
            );
            return Err(format!(
                "微信插件安装失败 (exit {})\n{}",
                status.code().unwrap_or(-1),
                text
            ));
        }
    }

    // weixin login 映射到 openclaw-weixin channel id
    let channel_id = if platform == "weixin" {
        "openclaw-weixin".to_string()
    } else {
        platform.clone()
    };

    let args: Vec<String> = match action.as_str() {
        "login" => {
            vec![
                "channels".into(),
                "login".into(),
                "--channel".into(),
                channel_id,
            ]
        }
        _ => return Err(format!("不支持的渠道动作: {}", action)),
    };

    let emit_payload = |kind: &str, message: String| {
        let payload = json!({
            "platform": platform,
            "action": action,
            "message": message,
            "kind": kind,
        });
        let _ = app.emit("channel-action-log", payload);
    };

    let progress_payload = |progress: u32| {
        let payload = json!({
            "platform": platform,
            "action": action,
            "progress": progress,
        });
        let _ = app.emit("channel-action-progress", payload);
    };

    emit_payload("info", format!("开始执行 openclaw {}", args.join(" ")));
    progress_payload(5);

    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let spawn_result = crate::utils::openclaw_command()
        .args(args.iter().map(|s| s.as_str()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(child) => child,
        Err(e) => {
            let payload = json!({
                "platform": platform,
                "action": action,
                "message": format!("启动 openclaw 失败: {}", e),
            });
            let _ = app.emit("channel-action-error", payload);
            return Err(format!("启动 openclaw 失败: {}", e));
        }
    };

    let stderr = child.stderr.take();
    let app2 = app.clone();
    let platform2 = platform.clone();
    let action2 = action.clone();
    let err_lines = lines.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Ok(mut guard) = err_lines.lock() {
                    guard.push(line.clone());
                }
                let payload = json!({
                    "platform": platform2,
                    "action": action2,
                    "message": line,
                    "kind": "stderr",
                });
                let _ = app2.emit("channel-action-log", payload);
            }
        }
    });

    let mut progress = 15;
    if let Some(pipe) = child.stdout.take() {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            if let Ok(mut guard) = lines.lock() {
                guard.push(line.clone());
            }
            let payload = json!({
                "platform": platform,
                "action": action,
                "message": line,
                "kind": "stdout",
            });
            let _ = app.emit("channel-action-log", payload);
            if progress < 90 {
                progress += 5;
                progress_payload(progress);
            }
        }
    }

    let _ = handle.join();
    let status = child
        .wait()
        .map_err(|e| format!("等待命令结束失败: {}", e))?;
    let message = lines
        .lock()
        .ok()
        .map(|guard| {
            let text = guard.join("\n");
            if text.trim().is_empty() {
                "操作完成".to_string()
            } else {
                text
            }
        })
        .unwrap_or_else(|| "操作完成".into());

    if status.success() {
        // 微信登录成功后写入 channels.openclaw-weixin.enabled 以便 list_configured_platforms 检测
        if platform == "weixin" && action == "login" {
            if let Ok(mut cfg) = super::config::load_openclaw_json() {
                let channels = cfg
                    .as_object_mut()
                    .and_then(|r| Some(r.entry("channels").or_insert_with(|| json!({}))))
                    .and_then(|c| c.as_object_mut());
                if let Some(ch) = channels {
                    let entry = ch.entry("openclaw-weixin").or_insert_with(|| json!({}));
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("enabled".into(), json!(true));
                    }
                    let _ = super::config::save_openclaw_json(&cfg);
                }
            }
        }

        progress_payload(100);
        let payload = json!({
            "platform": platform,
            "action": action,
            "message": message,
        });
        let _ = app.emit("channel-action-done", payload);
        Ok(message)
    } else {
        let payload = json!({
            "platform": platform,
            "action": action,
            "message": message,
        });
        let _ = app.emit("channel-action-error", payload);
        Err(message)
    }
}

const QQ_OPENCLAW_FAQ_URL: &str = "https://q.qq.com/qqbot/openclaw/faq.html";

/// OpenClaw 配置 schema 中 `plugins.entries` / `plugins.allow` 的合法 QQ 插件键。
/// 插件自身 package 声明 id 为 "qqbot"（openclaw.plugin.json）。
const OPENCLAW_QQBOT_PLUGIN_ID: &str = "qqbot";

/// 腾讯文档推荐的包；CLI 通常安装到 `~/.openclaw/extensions/openclaw-qqbot`（插件运行时 id 仍为 `qqbot`）。
const TENCENT_OPENCLAW_QQBOT_PACKAGE: &str = "@tencent-connect/openclaw-qqbot@latest";
const OPENCLAW_QQBOT_EXTENSION_FOLDER: &str = "openclaw-qqbot";
/// 与 `openclaw channels add --channel qqbot` 默认账号 id 一致。
const QQBOT_DEFAULT_ACCOUNT_ID: &str = "default";

fn qqbot_channel_has_credentials(val: &Value) -> bool {
    val.get("appId")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty())
        || val
            .get("clientSecret")
            .or_else(|| val.get("appSecret"))
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
        || val
            .get("token")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
}

// ── QQ 插件：扩展目录可能是 ~/.openclaw/extensions/openclaw-qqbot（官方包）或旧版 qqbot 目录 ──

fn qqbot_extension_installed() -> (bool, Option<&'static str>) {
    let d1 = qqbot_plugin_dir();
    if d1.is_dir() && plugin_install_marker_exists(&d1) {
        return (true, Some("qqbot"));
    }
    let d2 = generic_plugin_dir("openclaw-qqbot");
    if d2.is_dir() && plugin_install_marker_exists(&d2) {
        return (true, Some("openclaw-qqbot"));
    }
    (false, None)
}

fn qqbot_plugins_allow_flags(cfg: &Value) -> (bool, bool) {
    let Some(arr) = cfg
        .get("plugins")
        .and_then(|p| p.get("allow"))
        .and_then(|v| v.as_array())
    else {
        return (false, false);
    };
    let aq = arr
        .iter()
        .any(|v| v.as_str() == Some(OPENCLAW_QQBOT_PLUGIN_ID));
    let ao = arr.iter().any(|v| v.as_str() == Some("openclaw-qqbot"));
    (aq, ao)
}

/// 移除可能导致 OpenClaw 校验失败的旧/误配置。
/// 注意：plugins.entries.qqbot 是合法的（插件 id = "qqbot"），不要删。
fn strip_legacy_qqbot_plugin_config_keys(cfg: &mut Value) {
    let Some(plugins) = cfg.get_mut("plugins").and_then(|p| p.as_object_mut()) else {
        return;
    };
    // 仅删 plugins.allow 里的误识别字符串 "openclaw-qqbot"（插件实际 id 是 qqbot）
    if let Some(allow) = plugins.get_mut("allow").and_then(|a| a.as_array_mut()) {
        allow.retain(|v| v.as_str() != Some("openclaw-qqbot"));
    }
    // plugins.entries.qqbot 本身是合法的，不删除；根级 qqbot 由 strip_ui_fields 处理
}

fn ensure_openclaw_qqbot_plugin(cfg: &mut Value) -> Result<(), String> {
    strip_legacy_qqbot_plugin_config_keys(cfg);
    ensure_plugin_allowed(cfg, OPENCLAW_QQBOT_PLUGIN_ID)
}

fn qqbot_entry_enabled_ok(cfg: &Value, plugin_id: &str) -> bool {
    let has_entry = cfg
        .get("plugins")
        .and_then(|p| p.get("entries"))
        .and_then(|e| e.get(plugin_id))
        .is_some();
    if !has_entry {
        return true;
    }
    cfg.get("plugins")
        .and_then(|p| p.get("entries"))
        .and_then(|e| e.get(plugin_id))
        .and_then(|ent| ent.get("enabled"))
        .and_then(|v| v.as_bool())
        != Some(false)
}

/// (plugin_ok, detail_line)
fn qqbot_plugin_diagnose(cfg: &Value) -> (bool, String) {
    let (installed, loc) = qqbot_extension_installed();
    let (allow_q, allow_o) = qqbot_plugins_allow_flags(cfg);

    let entry_id_ok = qqbot_entry_enabled_ok(cfg, OPENCLAW_QQBOT_PLUGIN_ID);
    // 与 ensure_plugin_allowed 一致：插件 id 为 qqbot，plugins.entries.qqbot + enabled 为合法配置；
    // 仅当存在该条目且 enabled=false 时判失败（不存在条目视为可接受，由一键修复补齐）。
    let plugin_ok = installed && allow_q && entry_id_ok;
    let mut detail = format!(
        "本地扩展：{}（目录：{}）；plugins.allow：qqbot={}、误识别 openclaw-qqbot={}；plugins.entries.qqbot 未禁用={}。",
        if installed {
            "已检测到插件文件"
        } else {
            "未检测到（~/.openclaw/extensions/openclaw-qqbot 或旧版 …/qqbot）"
        },
        loc.unwrap_or("—"),
        allow_q,
        allow_o,
        entry_id_ok
    );
    if allow_o && !allow_q {
        detail.push_str(
            " **plugins.allow 仅有 openclaw-qqbot 不够，需包含 qqbot（保存 QQ 渠道或一键修复）。**",
        );
    } else if installed && allow_q && !entry_id_ok {
        detail.push_str(" **plugins.entries.qqbot 已存在但被禁用（enabled=false），请改为启用或删除该条目后一键修复。**");
    }
    (plugin_ok, detail)
}

/// QQ 渠道深度诊断：凭证 + 本机 Gateway + HTTP 健康检查 + 配置与插件。
/// 用于解释 QQ 客户端「灵魂不在线」等（多为 Gateway / 长连接侧，而非 AppID 填错）。
#[tauri::command]
pub async fn diagnose_channel(
    platform: String,
    account_id: Option<String>,
) -> Result<Value, String> {
    match platform.as_str() {
        "qqbot" => diagnose_qqbot_channel(account_id).await,
        _ => Err(format!(
            "暂不支持平台「{}」的深度诊断（当前仅实现 qqbot）",
            platform
        )),
    }
}

/// 一键修复 QQ 插件：未安装则安装官方包并重启 Gateway；已安装则补齐 plugins.allow / entries 并重载 Gateway。
#[tauri::command]
pub async fn repair_qqbot_channel_setup(app: tauri::AppHandle) -> Result<Value, String> {
    let (installed, _loc) = qqbot_extension_installed();
    if !installed {
        install_qqbot_plugin(app.clone()).await?;
        return Ok(json!({
            "ok": true,
            "action": "installed",
            "message": "已安装腾讯 openclaw-qqbot 插件、写入 plugins 并已触发 Gateway 重启"
        }));
    }

    let mut cfg = super::config::load_openclaw_json()?;
    ensure_openclaw_qqbot_plugin(&mut cfg)?;
    super::config::save_openclaw_json(&cfg)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });
    Ok(json!({
        "ok": true,
        "action": "config_repaired",
        "message": "已写入 plugins.allow / entries 并重载 Gateway"
    }))
}

async fn diagnose_qqbot_channel(account_id: Option<String>) -> Result<Value, String> {
    let port = crate::commands::gateway_listen_port();
    let cfg = super::config::load_openclaw_json().unwrap_or_else(|_| json!({}));

    let mut checks: Vec<Value> = vec![];

    // ── 1) 已保存的凭证 ──
    let saved = read_platform_config("qqbot".to_string(), account_id.clone()).await?;
    let exists = saved
        .get("exists")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let values = saved
        .get("values")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let cred_ok = if !exists {
        checks.push(json!({
            "id": "credentials",
            "ok": false,
            "title": "QQ 凭证已写入配置",
            "detail": "未在 openclaw.json 中找到 qqbot 渠道配置，请先在「渠道列表」完成接入并保存。"
        }));
        false
    } else {
        match verify_qqbot(
            &super::build_http_client(Duration::from_secs(15), None)
                .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?,
            &values,
        )
        .await
        {
            Ok(r) if r.get("valid").and_then(|v| v.as_bool()) == Some(true) => {
                let details: Vec<String> = r
                    .get("details")
                    .and_then(|d| d.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                checks.push(json!({
                    "id": "credentials",
                    "ok": true,
                    "title": "QQ 开放平台凭证（getAppAccessToken）",
                    "detail": if details.is_empty() {
                        "AppID / ClientSecret 可通过腾讯接口换取 access_token。".to_string()
                    } else {
                        details.join(" · ")
                    }
                }));
                true
            }
            Ok(r) => {
                let errs: Vec<String> = r
                    .get("errors")
                    .and_then(|e| e.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["凭证校验失败".into()]);
                checks.push(json!({
                    "id": "credentials",
                    "ok": false,
                    "title": "QQ 开放平台凭证（getAppAccessToken）",
                    "detail": errs.join("；")
                }));
                false
            }
            Err(e) => {
                checks.push(json!({
                    "id": "credentials",
                    "ok": false,
                    "title": "QQ 开放平台凭证（getAppAccessToken）",
                    "detail": e
                }));
                false
            }
        }
    };

    // ── 2) channels.qqbot.enabled ──
    let qq_node = cfg.get("channels").and_then(|c| c.get("qqbot"));
    let qq_enabled = qq_node
        .and_then(|n| n.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    checks.push(json!({
        "id": "qq_channel_enabled",
        "ok": qq_enabled,
        "title": "配置中 QQ 渠道已启用",
        "detail": if qq_enabled {
            "channels.qqbot.enabled 为 true（或未写，默认启用）。"
        } else {
            "channels.qqbot.enabled 为 false，Gateway 不会连接 QQ，请在渠道列表中启用。"
        }
    }));

    // ── 3) chatCompletions（QQ 常见问题里 405 等） ──
    let chat_on = cfg
        .get("gateway")
        .and_then(|g| g.get("http"))
        .and_then(|h| h.get("endpoints"))
        .and_then(|e| e.get("chatCompletions"))
        .and_then(|c| c.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    checks.push(json!({
        "id": "chat_completions",
        "ok": chat_on,
        "title": "Gateway HTTP · chatCompletions 端点",
        "detail": if chat_on {
            "gateway.http.endpoints.chatCompletions.enabled 已开启。"
        } else {
            "未启用 chatCompletions 时，机器人往往无法正常对话（如 405）。保存 QQ 渠道时面板通常会打开此项；若手动改过配置请检查。"
        }
    }));

    // ── 4) QQ 插件（extensions/qqbot 或 extensions/openclaw-qqbot + plugins.allow） ──
    let (plugin_ok, plugin_detail) = qqbot_plugin_diagnose(&cfg);
    checks.push(json!({
        "id": "qq_plugin",
        "ok": plugin_ok,
        "title": "QQ 机器人插件（qqbot / openclaw-qqbot）",
        "detail": plugin_detail
    }));

    // ── 5) Gateway TCP ──
    let port_copy = port;
    let tcp_ok = tokio::task::spawn_blocking(move || {
        let addr = format!("127.0.0.1:{}", port_copy);
        match addr.parse::<std::net::SocketAddr>() {
            Ok(a) => std::net::TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok(),
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false);
    checks.push(json!({
        "id": "gateway_tcp",
        "ok": tcp_ok,
        "title": format!("本机 Gateway 端口 {}（TCP）", port),
        "detail": if tcp_ok {
            format!("可在 {}s 内连接到 127.0.0.1:{}。", 2, port)
        } else {
            format!(
                "无法连接 127.0.0.1:{}。QQ 提示「灵魂不在线」时最常见原因是 OpenClaw Gateway 未在本机运行或未监听该端口。请在面板「Gateway」页或托盘菜单启动 Gateway。",
                port
            )
        }
    }));

    // ── 6) Gateway HTTP /__api/health ──
    let (http_ok, http_detail) = if tcp_ok {
        let url = format!("http://127.0.0.1:{}/__api/health", port);
        match super::build_http_client(Duration::from_secs(3), None) {
            Ok(client) => match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let ok = status.is_success() || status.is_redirection();
                    (ok, format!("GET {} → HTTP {}", url, status))
                }
                Err(e) => (false, format!("请求 {} 失败: {}", url, e)),
            },
            Err(e) => (false, format!("HTTP 客户端错误: {}", e)),
        }
    } else {
        (false, "已跳过（TCP 未连通）。".to_string())
    };
    checks.push(json!({
        "id": "gateway_http",
        "ok": http_ok,
        "title": "Gateway HTTP 探测（/__api/health）",
        "detail": http_detail
    }));

    let overall_ready = cred_ok && qq_enabled && chat_on && plugin_ok && tcp_ok && http_ok;

    let hints: Vec<String> = vec![
        "QQ 客户端提示「灵魂不在线」表示消息到了腾讯侧，但本机 OpenClaw Gateway 未就绪或未建立 QQ 长连接；仅通过「换 token」校验不能发现该问题。".to_string(),
        format!(
            "请确认本机 Gateway 已启动、端口与 openclaw.json 中 gateway.port（当前 {}）一致，并查看日志目录（如 ~/.openclaw/logs/）中 gateway 与 qqbot 相关报错。",
            port
        ),
        format!("官方排查说明见：{}", QQ_OPENCLAW_FAQ_URL),
    ];

    Ok(json!({
        "platform": "qqbot",
        "gatewayPort": port,
        "faqUrl": QQ_OPENCLAW_FAQ_URL,
        "checks": checks,
        "overallReady": overall_ready,
        "userHints": hints,
    }))
}

/// 列出当前已配置的平台清单
/// 若平台包含 accounts 子对象（多账号模式），返回各账号的安全显示字段
#[tauri::command]
pub async fn list_configured_platforms() -> Result<Value, String> {
    let cfg = super::config::load_openclaw_json()?;
    let mut result: Vec<Value> = vec![];

    if let Some(channels) = cfg.get("channels").and_then(|c| c.as_object()) {
        for (name, val) in channels {
            let enabled = val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let mut accounts: Vec<Value> = vec![];

            // 提取多账号信息（仅安全字段，不含 appSecret 等敏感数据）
            if let Some(accts) = val.get("accounts").and_then(|a| a.as_object()) {
                for (acct_id, acct_val) in accts {
                    let mut entry = json!({ "accountId": acct_id });
                    if let Some(app_id) = acct_val.get("appId").and_then(|v| v.as_str()) {
                        entry["appId"] = Value::String(app_id.to_string());
                    }
                    accounts.push(entry);
                }
            }

            result.push(json!({
                "id": platform_list_id(name),
                "enabled": enabled,
                "accounts": accounts
            }));
        }
    }

    Ok(json!(result))
}

#[tauri::command]
pub async fn get_channel_plugin_status(plugin_id: String) -> Result<Value, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id 不能为空".into());
    }

    let plugin_dir = generic_plugin_dir(plugin_id);
    let (qq_ext_ok, qq_ext_loc) = if plugin_id == OPENCLAW_QQBOT_PLUGIN_ID {
        qqbot_extension_installed()
    } else {
        (false, None)
    };
    // QQ 官方包落在 extensions/openclaw-qqbot，运行时插件 id 仍为 qqbot
    let installed = if plugin_id == OPENCLAW_QQBOT_PLUGIN_ID {
        qq_ext_ok
    } else {
        plugin_dir.is_dir() && plugin_install_marker_exists(&plugin_dir)
    };
    let path_display: PathBuf = if plugin_id == OPENCLAW_QQBOT_PLUGIN_ID {
        match qq_ext_loc {
            Some("openclaw-qqbot") => generic_plugin_dir(OPENCLAW_QQBOT_EXTENSION_FOLDER),
            Some("qqbot") => qqbot_plugin_dir(),
            _ => generic_plugin_dir(OPENCLAW_QQBOT_EXTENSION_FOLDER),
        }
    } else {
        plugin_dir.clone()
    };
    let legacy_backup_detected = legacy_plugin_backup_dir(plugin_id).exists();

    // 检测插件是否为 OpenClaw 内置（新版 openclaw/openclaw-zh 打包了 feishu 等插件）
    let builtin = is_plugin_builtin(plugin_id);

    let cfg = super::config::load_openclaw_json().unwrap_or_else(|_| json!({}));
    let allowed = cfg
        .get("plugins")
        .and_then(|p| p.get("allow"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|v| v.as_str() == Some(plugin_id)))
        .unwrap_or(false);
    let enabled = cfg
        .get("plugins")
        .and_then(|p| p.get("entries"))
        .and_then(|e| e.get(plugin_id))
        .and_then(|entry| entry.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(json!({
        "installed": installed,
        "builtin": builtin,
        "path": path_display.to_string_lossy(),
        "allowed": allowed,
        "enabled": enabled,
        "legacyBackupDetected": legacy_backup_detected
    }))
}

// ── Slack / Matrix / Discord 凭证校验 ─────────────────────

async fn verify_slack(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let bot_token = form
        .get("botToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if bot_token.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Bot Token 不能为空"] }));
    }

    let resp = client
        .post("https://slack.com/api/auth.test")
        .bearer_auth(bot_token)
        .send()
        .await
        .map_err(|e| format!("Slack API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Slack 响应失败: {}", e))?;

    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_error");
        return Ok(json!({ "valid": false, "errors": [format!("Slack 鉴权失败: {}", err)] }));
    }

    let team = body
        .get("team")
        .and_then(|v| v.as_str())
        .unwrap_or("未知工作区");
    let user = body
        .get("user")
        .and_then(|v| v.as_str())
        .unwrap_or("未知用户");

    Ok(json!({
        "valid": true,
        "details": [format!("工作区: {}", team), format!("Bot 用户: {}", user)]
    }))
}

async fn verify_matrix(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let homeserver = form
        .get("homeserver")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let access_token = form
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if homeserver.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Homeserver 不能为空"] }));
    }
    if access_token.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Access Token 不能为空"] }));
    }

    let base = homeserver.trim_end_matches('/');
    let resp = client
        .get(format!("{}/_matrix/client/v3/account/whoami", base))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Matrix API 连接失败: {}", e))?;

    if resp.status() == 401 {
        return Ok(json!({ "valid": false, "errors": ["Access Token 无效或已失效"] }));
    }
    if !resp.status().is_success() {
        return Ok(json!({
            "valid": false,
            "errors": [format!("Matrix API 返回异常: {}", resp.status())]
        }));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Matrix 响应失败: {}", e))?;
    let user_id = body
        .get("user_id")
        .and_then(|v| v.as_str())
        .unwrap_or("未知用户");
    let device_id = body
        .get("device_id")
        .and_then(|v| v.as_str())
        .unwrap_or("未返回");

    Ok(json!({
        "valid": true,
        "details": [format!("用户: {}", user_id), format!("设备: {}", device_id)]
    }))
}

// ── Signal 连通性校验 ─────────────────────────────────────

async fn verify_signal(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let account = form
        .get("account")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if account.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Signal 号码不能为空"] }));
    }

    let http_url = form
        .get("httpUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let http_host = form
        .get("httpHost")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1")
        .trim()
        .to_string();
    let http_port = form
        .get("httpPort")
        .and_then(|v| v.as_str())
        .unwrap_or("8080")
        .trim()
        .to_string();

    let base = if !http_url.is_empty() {
        http_url
    } else {
        format!("http://{}:{}", http_host, http_port)
    };

    let url = format!("{}/v1/about", base.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                let body: Value = resp.json().await.unwrap_or(json!({}));
                let versions = body
                    .get("versions")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                let mut details = vec![
                    format!("号码: {}", account),
                    format!("signal-cli 端点: {}", base),
                ];
                if !versions.is_empty() {
                    details.push(format!("API 版本: {}", versions));
                }
                Ok(json!({ "valid": true, "details": details }))
            } else {
                Ok(json!({
                    "valid": false,
                    "errors": [format!("signal-cli HTTP 返回异常: {} — 请确认 signal-cli daemon 正在运行", resp.status())]
                }))
            }
        }
        Err(e) => Ok(json!({
            "valid": false,
            "errors": [format!("无法连接 signal-cli HTTP 端点 {} — {}", url, e)]
        })),
    }
}

// ── MS Teams 凭证校验 ─────────────────────────────────────

async fn verify_msteams(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let app_id = form
        .get("appId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let app_password = form
        .get("appPassword")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let tenant_id = form
        .get("tenantId")
        .and_then(|v| v.as_str())
        .unwrap_or("botframework.com")
        .trim();

    if app_id.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["App ID 不能为空"] }));
    }
    if app_password.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["App Password 不能为空"] }));
    }

    let token_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        if tenant_id.is_empty() {
            "botframework.com"
        } else {
            tenant_id
        }
    );

    let resp = client
        .post(&token_url)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", app_id),
            ("client_secret", app_password),
            ("scope", "https://api.botframework.com/.default"),
        ])
        .send()
        .await
        .map_err(|e| format!("Azure AD 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Azure AD 响应失败: {}", e))?;

    if body
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .is_some()
    {
        let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(0);
        Ok(json!({
            "valid": true,
            "details": [
                format!("App ID: {}", app_id),
                format!("Tenant: {}", tenant_id),
                format!("Token 有效期: {}s", expires_in)
            ]
        }))
    } else {
        let err = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("凭证无效，请检查 App ID 和 App Password");
        Ok(json!({
            "valid": false,
            "errors": [err]
        }))
    }
}

// ── Discord 凭证校验 ──────────────────────────────────────

async fn verify_discord(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let token = form
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if token.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Bot Token 不能为空"] }));
    }

    // 验证 Bot Token
    let me_resp = client
        .get("https://discord.com/api/v10/users/@me")
        .header("Authorization", format!("Bot {}", token))
        .send()
        .await
        .map_err(|e| format!("Discord API 连接失败: {}", e))?;

    if me_resp.status() == 401 {
        return Ok(json!({ "valid": false, "errors": ["Bot Token 无效，请检查后重试"] }));
    }
    if !me_resp.status().is_success() {
        return Ok(json!({
            "valid": false,
            "errors": [format!("Discord API 返回异常: {}", me_resp.status())]
        }));
    }

    let me: Value = me_resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    if me.get("bot").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(json!({
            "valid": false,
            "errors": ["提供的 Token 不属于 Bot 账号，请使用 Bot Token"]
        }));
    }

    let bot_name = me
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("未知");
    let mut details = vec![format!("Bot: @{}", bot_name)];

    // 验证 Guild（可选）
    let guild_id = form
        .get("guildId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if !guild_id.is_empty() {
        match client
            .get(format!("https://discord.com/api/v10/guilds/{}", guild_id))
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let guild: Value = resp.json().await.unwrap_or_default();
                let name = guild.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                details.push(format!("服务器: {}", name));
            }
            Ok(resp) if resp.status().as_u16() == 403 || resp.status().as_u16() == 404 => {
                return Ok(json!({
                    "valid": false,
                    "errors": [format!("无法访问服务器 {}，请确认 Bot 已加入该服务器", guild_id)]
                }));
            }
            _ => {
                details.push("服务器 ID 未能验证（网络问题）".into());
            }
        }
    }

    Ok(json!({
        "valid": true,
        "errors": [],
        "details": details
    }))
}

// ── QQ Bot 凭证校验 ──────────────────────────────────────

async fn verify_qqbot(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let app_id = form
        .get("appId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    // 腾讯官方插件用 clientSecret，也兼容旧版 appSecret
    let app_secret = form
        .get("clientSecret")
        .or_else(|| form.get("appSecret"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if app_id.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["AppID 不能为空"] }));
    }
    if app_secret.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["ClientSecret 不能为空"] }));
    }

    // 通过 QQ Bot API 获取 access_token 验证凭证
    let resp = client
        .post("https://bots.qq.com/app/getAppAccessToken")
        .json(&json!({
            "appId": app_id,
            "clientSecret": app_secret
        }))
        .send()
        .await
        .map_err(|e| format!("QQ Bot API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if body.get("access_token").and_then(|v| v.as_str()).is_some() {
        Ok(json!({
            "valid": true,
            "errors": [],
            "details": [format!("AppID: {}", app_id)]
        }))
    } else {
        let msg = body
            .get("message")
            .or_else(|| body.get("msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("凭证无效，请检查 AppID 和 AppSecret");
        Ok(json!({
            "valid": false,
            "errors": [msg]
        }))
    }
}

fn ensure_plugin_allowed(cfg: &mut Value, plugin_id: &str) -> Result<(), String> {
    let root = cfg.as_object_mut().ok_or("配置格式错误")?;
    let plugins = root.entry("plugins").or_insert_with(|| json!({}));
    let plugins_map = plugins.as_object_mut().ok_or("plugins 节点格式错误")?;

    let allow = plugins_map.entry("allow").or_insert_with(|| json!([]));
    let allow_arr = allow.as_array_mut().ok_or("plugins.allow 节点格式错误")?;
    if !allow_arr.iter().any(|v| v.as_str() == Some(plugin_id)) {
        allow_arr.push(Value::String(plugin_id.to_string()));
    }

    let entries = plugins_map.entry("entries").or_insert_with(|| json!({}));
    let entries_map = entries
        .as_object_mut()
        .ok_or("plugins.entries 节点格式错误")?;
    let entry = entries_map
        .entry(plugin_id.to_string())
        .or_insert_with(|| json!({}));
    let entry_obj = entry
        .as_object_mut()
        .ok_or("plugins.entries 条目格式错误")?;
    entry_obj.insert("enabled".into(), Value::Bool(true));
    Ok(())
}

/// 禁用旧版插件：在 plugins.entries 中设置 enabled=false，并从 plugins.allow 中移除
fn disable_legacy_plugin(cfg: &mut Value, plugin_id: &str) {
    if let Some(root) = cfg.as_object_mut() {
        if let Some(plugins) = root.get_mut("plugins").and_then(|p| p.as_object_mut()) {
            // 从 allow 列表中移除
            if let Some(allow) = plugins.get_mut("allow").and_then(|a| a.as_array_mut()) {
                allow.retain(|v| v.as_str() != Some(plugin_id));
            }
            // 在 entries 中设置 enabled=false
            if let Some(entries) = plugins.get_mut("entries").and_then(|e| e.as_object_mut()) {
                if let Some(entry) = entries.get_mut(plugin_id).and_then(|e| e.as_object_mut()) {
                    entry.insert("enabled".into(), Value::Bool(false));
                }
            }
        }
    }
}

fn plugin_backup_root() -> PathBuf {
    super::openclaw_dir()
        .join("backups")
        .join("plugin-installs")
}

fn qqbot_plugin_dir() -> PathBuf {
    super::openclaw_dir().join("extensions").join("qqbot")
}

fn legacy_plugin_backup_dir(plugin_id: &str) -> PathBuf {
    super::openclaw_dir()
        .join("extensions")
        .join(format!("{plugin_id}.__clawpanel_backup"))
}

fn cleanup_legacy_plugin_backup_dir(plugin_id: &str) -> Result<bool, String> {
    let legacy_backup = legacy_plugin_backup_dir(plugin_id);
    if !legacy_backup.exists() {
        return Ok(false);
    }
    if legacy_backup.is_dir() {
        fs::remove_dir_all(&legacy_backup).map_err(|e| format!("清理旧版插件备份失败: {e}"))?;
    } else {
        fs::remove_file(&legacy_backup).map_err(|e| format!("清理旧版插件备份失败: {e}"))?;
    }
    Ok(true)
}

fn plugin_install_marker_exists(plugin_dir: &Path) -> bool {
    plugin_dir.join("package.json").is_file()
        || plugin_dir.join("plugin.ts").is_file()
        || plugin_dir.join("index.js").is_file()
        || plugin_dir.join("dist").join("index.js").is_file()
}

fn restore_path(backup: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        if target.is_dir() {
            fs::remove_dir_all(target).map_err(|e| format!("清理目录失败: {e}"))?;
        } else {
            fs::remove_file(target).map_err(|e| format!("清理文件失败: {e}"))?;
        }
    }
    if backup.exists() {
        fs::rename(backup, target).map_err(|e| format!("恢复备份失败: {e}"))?;
    }
    Ok(())
}

fn cleanup_failed_extension_install(
    plugin_dir: &Path,
    plugin_backup: &Path,
    config_backup: &Path,
    had_plugin_backup: bool,
    had_config_backup: bool,
) -> Result<(), String> {
    let config_path = super::openclaw_dir().join("openclaw.json");

    if plugin_dir.exists() {
        fs::remove_dir_all(plugin_dir).map_err(|e| format!("清理坏插件目录失败: {e}"))?;
    }
    if had_plugin_backup {
        restore_path(plugin_backup, plugin_dir)?;
    } else if plugin_backup.exists() {
        fs::remove_dir_all(plugin_backup).map_err(|e| format!("清理插件备份失败: {e}"))?;
    }

    if had_config_backup {
        restore_path(config_backup, &config_path)?;
    } else if config_backup.exists() {
        fs::remove_file(config_backup).map_err(|e| format!("清理配置备份失败: {e}"))?;
    }

    Ok(())
}

/// 检测插件是否为 OpenClaw 内置（作为 npm 依赖打包在 openclaw/openclaw-zh 中）
fn is_plugin_builtin(plugin_id: &str) -> bool {
    // 插件 ID → npm 包名映射
    let pkg_name = match plugin_id {
        "feishu" => "@openclaw/feishu",
        "openclaw-lark" => "@larksuite/openclaw-lark",
        "dingtalk-connector" => "@dingtalk-real-ai/dingtalk-connector",
        _ => return false,
    };
    // 在全局 npm node_modules 中查找 openclaw 安装目录
    let npm_dirs: Vec<PathBuf> = {
        let mut dirs = Vec::new();
        #[cfg(target_os = "windows")]
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(appdata).join("npm").join("node_modules");
            dirs.push(base.join("@qingchencloud").join("openclaw-zh"));
            dirs.push(base.join("openclaw"));
        }
        #[cfg(target_os = "macos")]
        {
            dirs.push(PathBuf::from(
                "/opt/homebrew/lib/node_modules/@qingchencloud/openclaw-zh",
            ));
            dirs.push(PathBuf::from("/opt/homebrew/lib/node_modules/openclaw"));
            dirs.push(PathBuf::from(
                "/usr/local/lib/node_modules/@qingchencloud/openclaw-zh",
            ));
            dirs.push(PathBuf::from("/usr/local/lib/node_modules/openclaw"));
        }
        #[cfg(target_os = "linux")]
        {
            dirs.push(PathBuf::from(
                "/usr/local/lib/node_modules/@qingchencloud/openclaw-zh",
            ));
            dirs.push(PathBuf::from("/usr/local/lib/node_modules/openclaw"));
            dirs.push(PathBuf::from(
                "/usr/lib/node_modules/@qingchencloud/openclaw-zh",
            ));
            dirs.push(PathBuf::from("/usr/lib/node_modules/openclaw"));
        }
        dirs
    };
    // 插件包名拆分成路径片段，如 @openclaw/feishu → @openclaw/feishu
    let pkg_path: PathBuf = pkg_name.split('/').collect();
    for base in &npm_dirs {
        let candidate = base.join("node_modules").join(&pkg_path);
        if candidate.join("package.json").is_file() {
            return true;
        }
    }
    false
}

fn generic_plugin_dir(plugin_id: &str) -> PathBuf {
    super::openclaw_dir().join("extensions").join(plugin_id)
}

fn generic_plugin_backup_dir(plugin_id: &str) -> PathBuf {
    plugin_backup_root().join(format!("{plugin_id}.__clawpanel_backup"))
}

fn generic_plugin_config_backup_path(plugin_id: &str) -> PathBuf {
    plugin_backup_root().join(format!("openclaw.{plugin_id}-install.bak"))
}

fn cleanup_failed_plugin_install(
    plugin_id: &str,
    had_plugin_backup: bool,
    had_config_backup: bool,
) -> Result<(), String> {
    let plugin_dir = generic_plugin_dir(plugin_id);
    let plugin_backup = generic_plugin_backup_dir(plugin_id);
    let config_path = super::openclaw_dir().join("openclaw.json");
    let config_backup = generic_plugin_config_backup_path(plugin_id);

    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir).map_err(|e| format!("清理坏插件目录失败: {e}"))?;
    }
    if had_plugin_backup {
        restore_path(&plugin_backup, &plugin_dir)?;
    } else if plugin_backup.exists() {
        fs::remove_dir_all(&plugin_backup).map_err(|e| format!("清理插件备份失败: {e}"))?;
    }

    if had_config_backup {
        restore_path(&config_backup, &config_path)?;
    } else if config_backup.exists() {
        fs::remove_file(&config_backup).map_err(|e| format!("清理配置备份失败: {e}"))?;
    }

    Ok(())
}

// ── QQ Bot 插件安装（带日志流） ──────────────────────────

#[tauri::command]
pub async fn install_channel_plugin(
    app: tauri::AppHandle,
    package_name: String,
    plugin_id: String,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let package_name = package_name.trim();
    let plugin_id = plugin_id.trim();
    if package_name.is_empty() || plugin_id.is_empty() {
        return Err("package_name 和 plugin_id 不能为空".into());
    }
    let plugin_dir = generic_plugin_dir(plugin_id);
    let plugin_backup = generic_plugin_backup_dir(plugin_id);
    let config_path = super::openclaw_dir().join("openclaw.json");
    let config_backup = generic_plugin_config_backup_path(plugin_id);
    let had_existing_plugin = plugin_dir.exists();
    let had_existing_config = config_path.exists();

    let _ = app.emit("plugin-log", format!("正在安装插件 {} ...", package_name));
    let _ = app.emit("plugin-progress", 10);

    fs::create_dir_all(plugin_backup_root()).map_err(|e| format!("创建插件备份目录失败: {e}"))?;
    if cleanup_legacy_plugin_backup_dir(plugin_id)? {
        let _ = app.emit("plugin-log", "已清理旧版插件备份目录");
    }

    if plugin_backup.exists() {
        let _ = fs::remove_dir_all(&plugin_backup);
    }
    if had_existing_plugin {
        fs::rename(&plugin_dir, &plugin_backup).map_err(|e| format!("备份旧插件失败: {e}"))?;
        let _ = app.emit(
            "plugin-log",
            format!("检测到旧插件目录，已备份 {}", plugin_dir.display()),
        );
    }

    if config_backup.exists() {
        let _ = fs::remove_file(&config_backup);
    }
    if had_existing_config {
        fs::copy(&config_path, &config_backup).map_err(|e| format!("备份配置失败: {e}"))?;
    }

    let spawn_result = crate::utils::openclaw_command()
        .args(["plugins", "install", package_name])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(e) => {
            let _ =
                cleanup_failed_plugin_install(plugin_id, had_existing_plugin, had_existing_config);
            return Err(format!("启动 openclaw 失败: {}", e));
        }
    };

    let stderr = child.stderr.take();
    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("plugin-log", &line);
            }
        }
    });

    let _ = app.emit("plugin-progress", 30);
    let mut progress = 30;
    if let Some(pipe) = child.stdout.take() {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("plugin-log", &line);
            if progress < 90 {
                progress += 10;
                let _ = app.emit("plugin-progress", progress);
            }
        }
    }

    let _ = handle.join();
    let _ = app.emit("plugin-progress", 95);

    let status = child
        .wait()
        .map_err(|e| format!("等待安装进程失败: {}", e))?;
    if !status.success() {
        let rollback_err =
            cleanup_failed_plugin_install(plugin_id, had_existing_plugin, had_existing_config)
                .err()
                .unwrap_or_default();
        let _ = app.emit(
            "plugin-log",
            format!("插件 {} 安装失败，已回退", package_name),
        );
        return if rollback_err.is_empty() {
            Err(format!("插件安装失败：{}", package_name))
        } else {
            Err(format!(
                "插件安装失败：{}；回退失败：{}",
                package_name, rollback_err
            ))
        };
    }

    let finalize = (|| -> Result<(), String> {
        let mut cfg = super::config::load_openclaw_json()?;
        ensure_plugin_allowed(&mut cfg, plugin_id)?;
        super::config::save_openclaw_json(&cfg)?;
        Ok(())
    })();

    if let Err(err) = finalize {
        let rollback_err =
            cleanup_failed_plugin_install(plugin_id, had_existing_plugin, had_existing_config)
                .err()
                .unwrap_or_default();
        let _ = app.emit(
            "plugin-log",
            format!("插件 {} 安装后收尾失败，已回退: {}", package_name, err),
        );
        return if rollback_err.is_empty() {
            Err(format!("插件安装失败：{err}"))
        } else {
            Err(format!("插件安装失败：{err}；回退失败：{rollback_err}"))
        };
    }

    if plugin_backup.exists() {
        let _ = fs::remove_dir_all(&plugin_backup);
    }
    if config_backup.exists() {
        let _ = fs::remove_file(&config_backup);
    }
    let _ = app.emit("plugin-progress", 100);
    let _ = app.emit("plugin-log", format!("插件 {} 安装完成", package_name));
    Ok("安装成功".into())
}

#[tauri::command]
pub async fn install_qqbot_plugin(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let plugin_dir = generic_plugin_dir(OPENCLAW_QQBOT_EXTENSION_FOLDER);
    let plugin_backup = generic_plugin_backup_dir(OPENCLAW_QQBOT_EXTENSION_FOLDER);
    let config_path = super::openclaw_dir().join("openclaw.json");
    let config_backup = generic_plugin_config_backup_path(OPENCLAW_QQBOT_EXTENSION_FOLDER);
    let had_existing_plugin = plugin_dir.exists();
    let had_existing_config = config_path.exists();

    let _ = app.emit(
        "plugin-log",
        format!(
            "正在安装腾讯 OpenClaw QQ 插件 {} ...",
            TENCENT_OPENCLAW_QQBOT_PACKAGE
        ),
    );
    let _ = app.emit("plugin-progress", 10);

    fs::create_dir_all(plugin_backup_root()).map_err(|e| format!("创建插件备份目录失败: {e}"))?;
    if cleanup_legacy_plugin_backup_dir(OPENCLAW_QQBOT_EXTENSION_FOLDER)? {
        let _ = app.emit("plugin-log", "已清理旧版 QQ 插件备份目录");
    }

    if plugin_backup.exists() {
        let _ = fs::remove_dir_all(&plugin_backup);
    }
    if had_existing_plugin {
        fs::rename(&plugin_dir, &plugin_backup)
            .map_err(|e| format!("备份旧 QQBot 插件失败: {e}"))?;
    }

    if config_backup.exists() {
        let _ = fs::remove_file(&config_backup);
    }
    if had_existing_config {
        fs::copy(&config_path, &config_backup).map_err(|e| format!("备份配置失败: {e}"))?;
    }

    let spawn_result = crate::utils::openclaw_command()
        .args(["plugins", "install", TENCENT_OPENCLAW_QQBOT_PACKAGE])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(e) => {
            let _ = cleanup_failed_extension_install(
                &plugin_dir,
                &plugin_backup,
                &config_backup,
                had_existing_plugin,
                had_existing_config,
            );
            return Err(format!("启动 openclaw 失败: {}", e));
        }
    };

    let stderr = child.stderr.take();
    let app2 = app.clone();
    let qqbot_stderr_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let qqbot_stderr_clone = qqbot_stderr_lines.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("plugin-log", &line);
                qqbot_stderr_clone.lock().unwrap().push(line);
            }
        }
    });

    let _ = app.emit("plugin-progress", 30);

    let mut progress = 30;
    let mut qqbot_stdout_lines = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("plugin-log", &line);
            qqbot_stdout_lines.push(line);
            if progress < 90 {
                progress += 10;
                let _ = app.emit("plugin-progress", progress);
            }
        }
    }

    let _ = handle.join();
    let _ = app.emit("plugin-progress", 95);

    let status = child
        .wait()
        .map_err(|e| format!("等待安装进程失败: {}", e))?;

    // 检测 native binding 缺失（macOS/Linux 上 OpenClaw CLI 自身启动失败）
    let all_output = {
        let stderr_guard = qqbot_stderr_lines.lock().unwrap();
        let mut combined = qqbot_stdout_lines.join("\n");
        combined.push('\n');
        combined.push_str(&stderr_guard.join("\n"));
        combined
    };
    if all_output.contains("native binding") || all_output.contains("Failed to start CLI") {
        let _ = app.emit("plugin-log", "");
        let _ = app.emit(
            "plugin-log",
            "⚠️ 检测到 OpenClaw CLI 原生依赖问题（native binding 缺失）",
        );
        let _ = app.emit(
            "plugin-log",
            "这是 OpenClaw 的上游依赖问题，非 QQBot 插件本身的问题。",
        );
        let _ = app.emit("plugin-log", "请在终端手动执行以下命令重装 OpenClaw：");
        let _ = app.emit("plugin-log", "  npm i -g @qingchencloud/openclaw-zh@latest --registry https://registry.npmmirror.com");
        let _ = app.emit("plugin-log", "重装完成后再回来安装 QQBot 插件。");
        let _ = cleanup_failed_extension_install(
            &plugin_dir,
            &plugin_backup,
            &config_backup,
            had_existing_plugin,
            had_existing_config,
        );
        let _ = app.emit("plugin-progress", 100);
        return Err("OpenClaw CLI 原生依赖缺失，请先在终端重装 OpenClaw（详见上方日志）".into());
    }

    if !status.success() {
        let _ = app.emit(
            "plugin-log",
            "openclaw plugins install 未成功结束，正在回退",
        );
        let _ = cleanup_failed_extension_install(
            &plugin_dir,
            &plugin_backup,
            &config_backup,
            had_existing_plugin,
            had_existing_config,
        );
        let _ = app.emit("plugin-progress", 100);
        return Err("QQ 插件安装失败：openclaw plugins install 进程退出码非零".into());
    }

    if !plugin_install_marker_exists(&plugin_dir) {
        let _ = app.emit(
            "plugin-log",
            format!("未在 {} 检测到插件文件，正在回退", plugin_dir.display()),
        );
        let _ = cleanup_failed_extension_install(
            &plugin_dir,
            &plugin_backup,
            &config_backup,
            had_existing_plugin,
            had_existing_config,
        );
        let _ = app.emit("plugin-progress", 100);
        return Err(format!(
            "安装后未在 extensions/{} 检测到插件，请检查 OpenClaw 版本与网络",
            OPENCLAW_QQBOT_EXTENSION_FOLDER
        ));
    }

    let finalize = (|| -> Result<(), String> {
        let mut cfg = super::config::load_openclaw_json()?;
        ensure_openclaw_qqbot_plugin(&mut cfg)?;
        super::config::save_openclaw_json(&cfg)?;
        let _ = app.emit(
            "plugin-log",
            "已补齐 plugins.allow 与 entries.qqbot.enabled",
        );
        Ok(())
    })();

    match finalize {
        Ok(()) => {
            let _ = app.emit("plugin-progress", 100);
            if plugin_backup.exists() {
                let _ = fs::remove_dir_all(&plugin_backup);
            }
            if config_backup.exists() {
                let _ = fs::remove_file(&config_backup);
            }
            if qqbot_plugin_dir().is_dir() {
                let _ = app.emit(
                    "plugin-log",
                    "提示：检测到旧的 extensions/qqbot 目录，可能与官方包并存并触发「无 provenance」日志；不需要时可手动删除或改名备份。",
                );
            }
            let _ = app.emit(
                "plugin-log",
                "QQ 插件安装完成；正在重启 Gateway 以加载插件（与官方文档一致）",
            );
            tauri::async_runtime::spawn(async move {
                let _ =
                    crate::commands::service::restart_service("ai.openclaw.gateway".into()).await;
            });
            Ok("安装成功".into())
        }
        Err(err) => {
            let _ = app.emit(
                "plugin-log",
                format!("写入 plugins 配置失败，正在回退: {err}"),
            );
            let rollback_err = cleanup_failed_extension_install(
                &plugin_dir,
                &plugin_backup,
                &config_backup,
                had_existing_plugin,
                had_existing_config,
            )
            .err()
            .unwrap_or_default();
            let _ = app.emit("plugin-progress", 100);
            let _ = app.emit("plugin-log", "QQBot 插件安装失败，已自动回退到安装前状态");
            if rollback_err.is_empty() {
                Err(format!("插件安装失败：{err}"))
            } else {
                Err(format!("插件安装失败：{err}；回退失败：{rollback_err}"))
            }
        }
    }
}

// ── Agent 渠道绑定管理 ──────────────────────────────────

/// 创建 Agent 到渠道的绑定配置（OpenClaw bindings schema）
fn create_agent_binding(
    cfg: &mut serde_json::Value,
    agent_id: &str,
    channel: &str,
    account_id: Option<String>,
) -> Result<(), String> {
    let bindings = cfg
        .as_object_mut()
        .ok_or("配置格式错误")?
        .entry("bindings")
        .or_insert_with(|| serde_json::json!([]));
    let bindings_arr = bindings.as_array_mut().ok_or("bindings 节点格式错误")?;

    // 构建新绑定条目（遵循 OpenClaw bindings schema）
    let mut new_binding = serde_json::Map::new();
    new_binding.insert(
        "type".to_string(),
        serde_json::Value::String("route".to_string()),
    );
    new_binding.insert(
        "agentId".to_string(),
        serde_json::Value::String(agent_id.to_string()),
    );

    // 构建 match 配置
    let mut match_config = serde_json::Map::new();
    match_config.insert(
        "channel".to_string(),
        serde_json::Value::String(channel.to_string()),
    );
    if let Some(ref acct) = account_id {
        match_config.insert(
            "accountId".to_string(),
            serde_json::Value::String(acct.clone()),
        );
    }

    new_binding.insert("match".to_string(), serde_json::Value::Object(match_config));

    // 先转换为 Value，避免在循环中移动
    let binding_value = serde_json::Value::Object(new_binding);

    // 检查是否已存在相同 agentId + channel + accountId 的绑定，如有则更新
    let mut found = false;
    for binding in bindings_arr.iter_mut() {
        if let (Some(existing_agent), Some(existing_channel), Some(existing_match)) = (
            binding.get("agentId").and_then(|v| v.as_str()),
            binding
                .get("match")
                .and_then(|m| m.get("channel"))
                .and_then(|v| v.as_str()),
            binding.get("match"),
        ) {
            if existing_agent == agent_id && existing_channel == channel {
                let existing_account = existing_match.get("accountId").and_then(|v| v.as_str());
                if existing_account == account_id.as_deref() {
                    *binding = binding_value.clone();
                    found = true;
                    break;
                }
            }
        }
    }

    // 如果没有找到现有绑定，则添加新绑定
    if !found {
        bindings_arr.push(binding_value);
    }

    Ok(())
}

/// 获取指定 Agent 的所有渠道绑定
/// 返回格式: { agentId, bindings: [{ channel, accountId, peer, ... }] }
#[tauri::command]
pub async fn get_agent_bindings(agent_id: String) -> Result<serde_json::Value, String> {
    let cfg = super::config::load_openclaw_json()?;

    let bindings: Vec<serde_json::Value> = cfg
        .get("bindings")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|b| {
                    b.get("agentId")
                        .and_then(|v| v.as_str())
                        .map(|id| id == agent_id)
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    Ok(serde_json::json!({
        "agentId": agent_id,
        "bindings": bindings
    }))
}

/// 获取所有 Agent 的绑定列表（用于管理界面）
#[tauri::command]
pub async fn list_all_bindings() -> Result<serde_json::Value, String> {
    let cfg = super::config::load_openclaw_json()?;

    let bindings: Vec<serde_json::Value> = cfg
        .get("bindings")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(serde_json::json!({
        "bindings": bindings
    }))
}

/// 保存/更新 Agent 的渠道绑定
/// - agent_id: Agent ID
/// - channel: 渠道类型 (feishu/telegram/discord/qqbot/dingtalk)
/// - account_id: 可选，指定账号（多账号模式）
/// - binding_config: 绑定配置 { peer, match, ... }
#[tauri::command]
pub async fn save_agent_binding(
    agent_id: String,
    channel: String,
    account_id: Option<String>,
    binding_config: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;

    // 账号配置存在性校验（读操作，提前执行以避免与后续可变借用冲突）
    let mut warnings: Vec<String> = vec![];
    if let Some(ref acct) = account_id {
        if !acct.is_empty() {
            if let Some(ch) = cfg.get("channels").and_then(|c| c.get(channel.as_str())) {
                let has_account = ch
                    .get("accounts")
                    .and_then(|a| a.get(acct.as_str()))
                    .map(|acct_val| {
                        acct_val
                            .get("appId")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .is_some()
                    })
                    .unwrap_or(false);

                if !has_account {
                    let has_root = ch
                        .get("appId")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .is_some();
                    if has_root {
                        warnings.push(format!(
                            "账号「{}」在 channels.{}.accounts 下未找到对应配置，\
                         当前凭证写在根级别（单账号旧格式）。\
                         建议将账号凭证移入 channels.{}.accounts.\"{}\" 下以支持多账号。",
                            acct, channel, channel, acct
                        ));
                    } else {
                        warnings.push(format!(
                            "账号「{}」在 channels.{}.accounts 下未找到对应配置，\
                         该绑定可能无法正常路由消息。\
                         请先在渠道列表中为账号「{}」接入飞书应用。",
                            acct, channel, acct
                        ));
                    }
                }
            } else {
                warnings.push(format!(
                    "渠道「{}」尚未接入（channels.{} 不存在），该绑定可能无法正常工作。",
                    channel, channel
                ));
            }
        }
    }

    // 确保 bindings 节点存在（从这里开始需要可变借用）
    let bindings = cfg
        .as_object_mut()
        .ok_or("配置格式错误")?
        .entry("bindings")
        .or_insert_with(|| serde_json::json!([]));
    let bindings_arr = bindings.as_array_mut().ok_or("bindings 节点格式错误")?;

    // 构建新绑定条目（遵循 OpenClaw bindings schema）
    let mut new_binding = serde_json::Map::new();
    new_binding.insert(
        "type".to_string(),
        serde_json::Value::String("route".to_string()),
    );
    new_binding.insert(
        "agentId".to_string(),
        serde_json::Value::String(agent_id.clone()),
    );

    // 构建 match 配置
    let mut match_config = serde_json::Map::new();
    match_config.insert(
        "channel".to_string(),
        serde_json::Value::String(channel.clone()),
    );
    if let Some(ref acct) = account_id {
        if !acct.is_empty() {
            match_config.insert(
                "accountId".to_string(),
                serde_json::Value::String(acct.clone()),
            );
        }
    }

    // 合并用户提供的配置到 match 中
    if let Some(config_obj) = binding_config.as_object() {
        for (k, v) in config_obj {
            if k == "peer" {
                // peer 写入 match.peer（OpenClaw schema 要求）
                if let Some(peer_str) = v.as_str().filter(|s| !s.is_empty()) {
                    match_config.insert(
                        "peer".to_string(),
                        serde_json::json!({ "kind": "direct", "id": peer_str }),
                    );
                } else if let Some(peer_obj) = v.as_object() {
                    let kind = peer_obj
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("direct");
                    let id = peer_obj
                        .get("id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty());
                    if let Some(id_val) = id {
                        match_config.insert(
                            "peer".to_string(),
                            serde_json::json!({ "kind": kind, "id": id_val }),
                        );
                    }
                }
            } else if k == "accountId" || k == "channel" {
                // 这两个已有专门逻辑处理，跳过
            } else {
                match_config.insert(k.clone(), v.clone());
            }
        }
    }

    new_binding.insert("match".to_string(), serde_json::Value::Object(match_config));

    // 先转换为 Value，避免在循环中移动
    let binding_value = serde_json::Value::Object(new_binding);

    // 检查是否已存在相同 agentId + channel + accountId 的绑定，如有则更新
    let mut found = false;
    for binding in bindings_arr.iter_mut() {
        if let (Some(existing_agent), Some(existing_channel), Some(existing_match)) = (
            binding.get("agentId").and_then(|v| v.as_str()),
            binding
                .get("match")
                .and_then(|m| m.get("channel"))
                .and_then(|v| v.as_str()),
            binding.get("match"),
        ) {
            if existing_agent == agent_id && existing_channel == channel {
                // 检查 accountId 是否匹配
                let existing_account = existing_match.get("accountId").and_then(|v| v.as_str());
                if existing_account == account_id.as_deref() {
                    *binding = binding_value.clone();
                    found = true;
                    break;
                }
            }
        }
    }

    // 如果没有找到现有绑定，则添加新绑定
    if !found {
        bindings_arr.push(binding_value);
    }

    // 写回配置并重载 Gateway
    super::config::save_openclaw_json(&cfg)?;

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(serde_json::json!({
        "ok": true,
        "warnings": warnings
    }))
}

/// 删除 Agent 的渠道绑定
/// - agent_id: Agent ID
/// - channel: 渠道类型
/// - account_id: 指定子账号时仅删该条；为 None 时仅删除「无 accountId」的默认绑定（不会一次删掉同渠道下其它子账号）
#[tauri::command]
pub async fn delete_agent_binding(
    agent_id: String,
    channel: String,
    account_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;

    let Some(bindings) = cfg.get_mut("bindings").and_then(|b| b.as_array_mut()) else {
        return Ok(serde_json::json!({ "ok": true }));
    };

    let original_len = bindings.len();
    bindings.retain(|b| {
        // 检查是否是该 agent 的绑定
        if b.get("agentId")
            .and_then(|v| v.as_str())
            .map(|id| id != agent_id)
            .unwrap_or(true)
        {
            return true; // 保留非该 agent 的绑定
        }

        // 检查 channel 是否匹配
        let match_obj = match b.get("match").and_then(|m| m.as_object()) {
            Some(m) => m,
            None => return true, // 保留无效格式
        };

        let binding_channel = match_obj.get("channel").and_then(|v| v.as_str());
        if binding_channel != Some(&channel) {
            return true; // 保留不匹配 channel 的绑定
        }

        let binding_acct = match_obj
            .get("accountId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        match account_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(acct) => {
                if binding_acct != Some(acct) {
                    return true;
                }
            }
            None => {
                // 未指定 account：只删默认绑定（无 accountId 或空）
                if binding_acct.is_some() {
                    return true;
                }
            }
        }

        false // 删除这个绑定
    });

    let removed = original_len - bindings.len();
    if removed == 0 {
        return Err("未找到对应的绑定".to_string());
    }

    // 写回配置并重载 Gateway
    super::config::save_openclaw_json(&cfg)?;

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(serde_json::json!({
        "ok": true,
        "removed": removed
    }))
}

/// 删除指定 Agent 的所有绑定
#[tauri::command]
pub async fn delete_agent_all_bindings(
    agent_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;

    let Some(bindings) = cfg.get_mut("bindings").and_then(|b| b.as_array_mut()) else {
        return Ok(serde_json::json!({ "ok": true, "removed": 0 }));
    };

    let original_len = bindings.len();
    bindings.retain(|b| {
        b.get("agentId")
            .and_then(|v| v.as_str())
            .map(|id| id != agent_id)
            .unwrap_or(true)
    });

    let removed = original_len - bindings.len();

    // 写回配置并重载 Gateway
    super::config::save_openclaw_json(&cfg)?;

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config::do_reload_gateway(&app2).await;
    });

    Ok(serde_json::json!({
        "ok": true,
        "removed": removed
    }))
}

// ── Telegram 凭证校验 ─────────────────────────────────────

async fn verify_telegram(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let bot_token = form
        .get("botToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if bot_token.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Bot Token 不能为空"] }));
    }

    let allowed = form
        .get("allowedUsers")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if allowed.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["至少需要填写一个允许的用户 ID"] }));
    }

    let url = format!("https://api.telegram.org/bot{}/getMe", bot_token);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Telegram API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let username = body
            .get("result")
            .and_then(|r| r.get("username"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知");
        Ok(json!({
            "valid": true,
            "errors": [],
            "details": [format!("Bot: @{}", username)]
        }))
    } else {
        let desc = body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("Token 无效");
        Ok(json!({
            "valid": false,
            "errors": [desc]
        }))
    }
}

// ── 飞书凭证校验 ──────────────────────────────────────

async fn verify_feishu(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let app_id = form
        .get("appId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let app_secret = form
        .get("appSecret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if app_id.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["App ID 不能为空"] }));
    }
    if app_secret.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["App Secret 不能为空"] }));
    }

    // 通过飞书 API 获取 tenant_access_token 验证凭证
    let domain = form
        .get("domain")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let base_url = if domain == "lark" {
        "https://open.larksuite.com"
    } else {
        "https://open.feishu.cn"
    };

    let resp = client
        .post(format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            base_url
        ))
        .json(&json!({
            "app_id": app_id,
            "app_secret": app_secret
        }))
        .send()
        .await
        .map_err(|e| format!("飞书 API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code == 0 {
        Ok(json!({
            "valid": true,
            "errors": [],
            "details": [format!("App ID: {}", app_id)]
        }))
    } else {
        let msg = body
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("凭证无效，请检查 App ID 和 App Secret");
        Ok(json!({
            "valid": false,
            "errors": [msg]
        }))
    }
}

// ── 钉钉凭证校验 ──────────────────────────────────────

async fn verify_dingtalk(
    client: &reqwest::Client,
    form: &Map<String, Value>,
) -> Result<Value, String> {
    let client_id = form
        .get("clientId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let client_secret = form
        .get("clientSecret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if client_id.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Client ID 不能为空"] }));
    }
    if client_secret.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["Client Secret 不能为空"] }));
    }

    let resp = client
        .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
        .json(&json!({
            "appKey": client_id,
            "appSecret": client_secret
        }))
        .send()
        .await
        .map_err(|e| format!("钉钉 API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if body
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .is_some()
        || body
            .get("access_token")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .is_some()
    {
        Ok(json!({
            "valid": true,
            "errors": [],
            "details": [
                format!("AppKey: {}", client_id),
                "已通过 accessToken 接口校验".to_string()
            ]
        }))
    } else {
        let msg = body
            .get("message")
            .or_else(|| body.get("msg"))
            .or_else(|| body.get("errmsg"))
            .and_then(|v| v.as_str())
            .unwrap_or("凭证无效，请检查 Client ID 和 Client Secret");
        Ok(json!({
            "valid": false,
            "errors": [msg]
        }))
    }
}
