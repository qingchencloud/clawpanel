/// 消息渠道管理
/// 负责 Telegram / Discord / QQ Bot 等消息渠道的配置持久化与凭证校验
/// 配置写入配置文件的 channels / plugins 节点
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn platform_storage_key(platform: &str) -> &str {
    match platform {
        "dingtalk" | "dingtalk-connector" => "dingtalk-connector",
        _ => platform,
    }
}

fn platform_list_id(platform: &str) -> &str {
    match platform {
        "dingtalk-connector" => "dingtalk",
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

/// 读取指定平台的当前配置（从配置文件中提取表单可用的值）
#[tauri::command]
pub async fn read_platform_config(platform: String) -> Result<Value, String> {
    let cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform);

    // 从已有配置中提取用户可编辑字段
    let saved = cfg
        .get("channels")
        .and_then(|c| c.get(storage_key))
        .cloned()
        .unwrap_or(Value::Null);

    let mut form = Map::new();
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
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // QQ Bot: token 格式为 "AppID:AppSecret"，拆分回表单字段
            if let Some(t) = saved.get("token").and_then(|v| v.as_str()) {
                if let Some((app_id, app_secret)) = t.split_once(':') {
                    form.insert("appId".into(), Value::String(app_id.into()));
                    form.insert("appSecret".into(), Value::String(app_secret.into()));
                }
            }
        }
        "feishu" => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // 飞书: appId, appSecret, domain 直接保存
            if let Some(v) = saved.get("appId").and_then(|v| v.as_str()) {
                form.insert("appId".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("appSecret").and_then(|v| v.as_str()) {
                form.insert("appSecret".into(), Value::String(v.into()));
            }
            if let Some(v) = saved.get("domain").and_then(|v| v.as_str()) {
                form.insert("domain".into(), Value::String(v.into()));
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
        _ => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // 通用：原样返回字符串类型字段
            if let Some(obj) = saved.as_object() {
                for (k, v) in obj {
                    if k == "enabled" {
                        continue;
                    }
                    if let Some(s) = v.as_str() {
                        form.insert(k.clone(), Value::String(s.into()));
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
#[tauri::command]
pub async fn save_messaging_platform(
    platform: String,
    form: Value,
    account_id: Option<String>,
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
            let app_secret = form_obj
                .get("appSecret")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if app_id.is_empty() || app_secret.is_empty() {
                return Err("AppID 和 AppSecret 不能为空".into());
            }

            let token = format!("{}:{}", app_id, app_secret);
            let mut entry = Map::new();
            entry.insert("token".into(), Value::String(token));
            entry.insert("enabled".into(), Value::Bool(true));

            channels_map.insert("qqbot".into(), Value::Object(entry));
            ensure_plugin_allowed(&mut cfg, "qqbot")?;
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

            // 多账号模式：写入 channels.feishu.accounts.<account_id>
            if let Some(ref acct) = account_id {
                if !acct.is_empty() {
                    let feishu = channels_map
                        .entry("feishu")
                        .or_insert_with(|| json!({ "enabled": true }));
                    let feishu_obj = feishu.as_object_mut().ok_or("feishu 节点格式错误")?;
                    feishu_obj.entry("enabled").or_insert(Value::Bool(true));
                    let accounts = feishu_obj.entry("accounts").or_insert_with(|| json!({}));
                    let accounts_obj = accounts.as_object_mut().ok_or("accounts 格式错误")?;
                    accounts_obj.insert(acct.clone(), Value::Object(entry));
                } else {
                    channels_map.insert("feishu".into(), Value::Object(entry));
                }
            } else {
                channels_map.insert("feishu".into(), Value::Object(entry));
            }
            ensure_plugin_allowed(&mut cfg, "feishu")?;
            let _ = cleanup_legacy_plugin_backup_dir("feishu");
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
#[tauri::command]
pub async fn remove_messaging_platform(
    platform: String,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let storage_key = platform_storage_key(&platform);

    if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
        channels.remove(storage_key);
    }

    super::config::save_openclaw_json(&cfg)?;
    // Gateway 重载在后台进行，不阻塞 UI 响应
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
        _ => Ok(json!({
            "valid": true,
            "warnings": ["该平台暂不支持在线校验"]
        })),
    }
}

/// 列出当前已配置的平台清单
#[tauri::command]
pub async fn list_configured_platforms() -> Result<Value, String> {
    let cfg = super::config::load_openclaw_json()?;
    let mut result: Vec<Value> = vec![];

    if let Some(channels) = cfg.get("channels").and_then(|c| c.as_object()) {
        for (name, val) in channels {
            let enabled = val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            result.push(json!({
                "id": platform_list_id(name),
                "enabled": enabled
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
    let installed = plugin_dir.is_dir() && plugin_install_marker_exists(&plugin_dir);
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
        "path": plugin_dir.to_string_lossy(),
        "allowed": allowed,
        "enabled": enabled,
        "legacyBackupDetected": legacy_backup_detected
    }))
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
    let app_secret = form
        .get("appSecret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if app_id.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["AppID 不能为空"] }));
    }
    if app_secret.is_empty() {
        return Ok(json!({ "valid": false, "errors": ["AppSecret 不能为空"] }));
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

fn plugin_backup_root() -> PathBuf {
    super::openclaw_dir()
        .join("backups")
        .join("plugin-installs")
}

fn qqbot_plugin_dir() -> PathBuf {
    super::openclaw_dir().join("extensions").join("qqbot")
}

fn qqbot_backup_dir() -> PathBuf {
    plugin_backup_root().join("qqbot.__clawpanel_backup")
}

fn qqbot_config_backup_path() -> PathBuf {
    plugin_backup_root().join("openclaw.qqbot-install.bak")
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

fn path_to_plugin_entry(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    format!("./{}", normalized.trim_start_matches('/'))
}

fn plugin_entry_exists(plugin_dir: &Path, entry: &str) -> bool {
    plugin_dir.join(entry.trim_start_matches("./")).is_file()
}

fn synthesize_qqbot_runtime_entry(plugin_dir: &Path) -> Result<String, String> {
    let channel = plugin_dir.join("src").join("channel.js");
    let runtime = plugin_dir.join("src").join("runtime.js");
    if !channel.is_file() || !runtime.is_file() {
        return Err("QQBot 插件缺少运行时文件，无法自动修复".into());
    }
    let dist_dir = plugin_dir.join("dist");
    fs::create_dir_all(&dist_dir).map_err(|e| format!("创建 dist 目录失败: {e}"))?;
    let dist_entry = dist_dir.join("index.js");
    let code = r#"import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { qqbotPlugin } from "../src/channel.js";
import { setQQBotRuntime } from "../src/runtime.js";

const plugin = {
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin });
  },
};

export default plugin;
"#;
    fs::write(&dist_entry, code).map_err(|e| format!("写入 dist/index.js 失败: {e}"))?;
    Ok("./dist/index.js".into())
}

fn repair_qqbot_package_manifest(plugin_dir: &Path) -> Result<String, String> {
    let package_path = plugin_dir.join("package.json");
    if !package_path.is_file() {
        return Err("QQBot 插件缺少 package.json".into());
    }

    let raw =
        fs::read_to_string(&package_path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let mut pkg: Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 package.json 失败: {e}"))?;

    let desired_entry = if let Some(main) = pkg.get("main").and_then(|v| v.as_str()) {
        let candidate = path_to_plugin_entry(Path::new(main));
        if plugin_entry_exists(plugin_dir, &candidate) {
            candidate
        } else if main.replace('\\', "/") == "dist/index.js" {
            synthesize_qqbot_runtime_entry(plugin_dir)?
        } else {
            return Err(format!("插件入口文件不存在: {main}"));
        }
    } else if plugin_entry_exists(plugin_dir, "./index.js") {
        "./index.js".into()
    } else if plugin_dir.join("index.ts").is_file() {
        synthesize_qqbot_runtime_entry(plugin_dir)?
    } else {
        return Err("未找到可用的 QQBot 插件入口".into());
    };

    for field in ["openclaw", "clawdbot", "moltbot"] {
        if let Some(obj) = pkg.get_mut(field).and_then(|v| v.as_object_mut()) {
            obj.insert("extensions".into(), json!([desired_entry.clone()]));
        }
    }

    let serialized =
        serde_json::to_string_pretty(&pkg).map_err(|e| format!("序列化 package.json 失败: {e}"))?;
    fs::write(&package_path, serialized).map_err(|e| format!("写入 package.json 失败: {e}"))?;
    Ok(desired_entry)
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

fn cleanup_failed_qqbot_install(
    had_plugin_backup: bool,
    had_config_backup: bool,
) -> Result<(), String> {
    let plugin_dir = qqbot_plugin_dir();
    let plugin_backup = qqbot_backup_dir();
    let config_path = super::openclaw_dir().join("openclaw.json");
    let config_backup = qqbot_config_backup_path();

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

/// 检测插件是否为 OpenClaw 内置（作为 npm 依赖打包在 openclaw/openclaw-zh 中）
fn is_plugin_builtin(plugin_id: &str) -> bool {
    // 插件 ID → npm 包名映射
    let pkg_name = match plugin_id {
        "feishu" => "@openclaw/feishu",
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

    let plugin_dir = qqbot_plugin_dir();
    let plugin_backup = qqbot_backup_dir();
    let config_path = super::openclaw_dir().join("openclaw.json");
    let config_backup = qqbot_config_backup_path();
    let had_existing_plugin = plugin_dir.exists();
    let had_existing_config = config_path.exists();

    let _ = app.emit("plugin-log", "正在安装 QQBot 社区插件 @sliverp/qqbot ...");
    let _ = app.emit("plugin-progress", 10);

    fs::create_dir_all(plugin_backup_root()).map_err(|e| format!("创建插件备份目录失败: {e}"))?;
    if cleanup_legacy_plugin_backup_dir("qqbot")? {
        let _ = app.emit("plugin-log", "已清理旧版 QQBot 插件备份目录");
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
        .args(["plugins", "install", "@sliverp/qqbot@latest"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(e) => {
            let _ = cleanup_failed_qqbot_install(had_existing_plugin, had_existing_config);
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
        let _ = cleanup_failed_qqbot_install(had_existing_plugin, had_existing_config);
        let _ = app.emit("plugin-progress", 100);
        return Err("OpenClaw CLI 原生依赖缺失，请先在终端重装 OpenClaw（详见上方日志）".into());
    }

    let finalize = (|| -> Result<(), String> {
        if !status.success() {
            let _ = app.emit(
                "plugin-log",
                "安装器返回失败，正在尝试自动修复 QQBot 插件...",
            );
        }

        let entry = repair_qqbot_package_manifest(&plugin_dir)?;
        let _ = app.emit("plugin-log", format!("已修正 QQBot 插件入口: {entry}"));

        let mut cfg = super::config::load_openclaw_json()?;
        ensure_plugin_allowed(&mut cfg, "qqbot")?;
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
            let _ = app.emit("plugin-log", "QQBot 插件安装完成");
            Ok("安装成功".into())
        }
        Err(err) => {
            let _ = app.emit("plugin-log", format!("自动修复失败，正在回退: {err}"));
            let rollback_err =
                cleanup_failed_qqbot_install(had_existing_plugin, had_existing_config)
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
