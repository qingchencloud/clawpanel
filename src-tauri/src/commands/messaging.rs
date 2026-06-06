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

fn secret_ref_parts(value: &Value) -> Option<(&str, &str, &str)> {
    let obj = value.as_object()?;
    let source = obj.get("source").and_then(|v| v.as_str())?.trim();
    if !matches!(source, "env" | "file" | "exec") {
        return None;
    }
    let provider = obj
        .get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some((source, provider, id))
}

fn secret_ref_placeholder(value: &Value) -> Option<String> {
    let (source, provider, id) = secret_ref_parts(value)?;
    Some(format!("SecretRef({}:{}:{})", source, provider, id))
}

fn insert_secret_aware_form_value(form: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(v) = source.get(key).and_then(|v| v.as_str()) {
        form.insert(key.into(), Value::String(v.into()));
        return;
    }

    let Some(value) = source.get(key) else {
        return;
    };
    let Some(placeholder) = secret_ref_placeholder(value) else {
        return;
    };
    form.insert(key.into(), Value::String(placeholder));
    let refs = form
        .entry("__secretRefs")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(obj) = refs.as_object_mut() {
        obj.insert(key.into(), value.clone());
    }
}

fn insert_secret_aware_form_alias(
    form: &mut Map<String, Value>,
    source: &Value,
    source_key: &str,
    form_key: &str,
) {
    if let Some(v) = source.get(source_key).and_then(|v| v.as_str()) {
        form.insert(form_key.into(), Value::String(v.into()));
        return;
    }

    let Some(value) = source.get(source_key) else {
        return;
    };
    let Some(placeholder) = secret_ref_placeholder(value) else {
        return;
    };
    form.insert(form_key.into(), Value::String(placeholder));
    let refs = form
        .entry("__secretRefs")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(obj) = refs.as_object_mut() {
        obj.insert(form_key.into(), value.clone());
    }
}

fn resolve_messaging_credential_value_for_save(
    form_obj: &Map<String, Value>,
    current: &Value,
    key: &str,
) -> Option<Value> {
    let raw_value = form_obj.get(key)?;
    let Value::String(raw) = raw_value else {
        return Some(raw_value.clone());
    };
    let value = raw.trim();
    if let Some(current_value) = current.get(key) {
        if let Some(placeholder) = secret_ref_placeholder(current_value) {
            if value.is_empty() || value == placeholder {
                return Some(current_value.clone());
            }
        }
    }
    if value.is_empty() {
        None
    } else {
        Some(Value::String(value.to_string()))
    }
}

fn resolve_messaging_credential_value_for_save_alias(
    form_obj: &Map<String, Value>,
    current: &Value,
    form_key: &str,
    current_key: &str,
) -> Option<Value> {
    let raw_value = form_obj.get(form_key)?;
    let Value::String(raw) = raw_value else {
        return Some(raw_value.clone());
    };
    let value = raw.trim();
    if let Some(current_value) = current.get(current_key) {
        if let Some(placeholder) = secret_ref_placeholder(current_value) {
            if value.is_empty() || value == placeholder {
                return Some(current_value.clone());
            }
        }
    }
    if value.is_empty() {
        None
    } else {
        Some(Value::String(value.to_string()))
    }
}

fn preserve_messaging_credential_refs(
    entry: &mut Map<String, Value>,
    form_obj: &Map<String, Value>,
    current: &Value,
) {
    entry.remove("__secretRefs");
    for key in [
        "accessToken",
        "appId",
        "appPassword",
        "appSecret",
        "appToken",
        "apiPassword",
        "apiPasswordFile",
        "botSecret",
        "botSecretFile",
        "botToken",
        "channelAccessToken",
        "channelSecret",
        "code",
        "clientId",
        "clientSecret",
        "refreshToken",
        "gatewayPassword",
        "gatewayToken",
        "password",
        "passwordFile",
        "privateKey",
        "secretFile",
        "serviceAccount",
        "serviceAccountFile",
        "serviceAccountRef",
        "signingSecret",
        "token",
        "tokenFile",
        "webhookSecret",
    ] {
        if !form_obj.contains_key(key) {
            continue;
        }
        match resolve_messaging_credential_value_for_save(form_obj, current, key) {
            Some(value) => {
                entry.insert(key.into(), value);
            }
            None => {
                entry.remove(key);
            }
        }
    }
}

fn has_configured_messaging_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(raw)) => !raw.trim().is_empty(),
        Some(value) if secret_ref_parts(value).is_some() => true,
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn is_enabled_form_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_i64().map(|n| n != 0).unwrap_or(false),
        Some(Value::String(raw)) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on" | "enabled"
        ),
        _ => false,
    }
}

fn msteams_credential_missing_labels(form: &Map<String, Value>) -> Vec<&'static str> {
    if !has_configured_messaging_value(form.get("appId")) {
        return vec!["App ID"];
    }
    if has_configured_messaging_value(form.get("appPassword")) {
        return vec![];
    }
    if is_enabled_form_flag(form.get("useManagedIdentity")) {
        return vec![];
    }

    let auth_type = form_string(form, "authType").to_ascii_lowercase();
    let has_federated_credential = has_configured_messaging_value(form.get("certificatePath"))
        || has_configured_messaging_value(form.get("certificateThumbprint"));
    if auth_type == "federated" && has_federated_credential {
        return vec![];
    }
    if auth_type == "federated" {
        return vec!["Certificate Path / Certificate Thumbprint / Managed Identity / App Password"];
    }
    vec!["App Password"]
}

fn channel_root_has_messaging_credential(root: &Map<String, Value>) -> bool {
    [
        "accessToken",
        "appId",
        "appPassword",
        "appSecret",
        "appToken",
        "apiPassword",
        "apiPasswordFile",
        "botSecret",
        "botSecretFile",
        "botToken",
        "channelAccessToken",
        "channelSecret",
        "code",
        "clientId",
        "clientSecret",
        "refreshToken",
        "gatewayPassword",
        "gatewayToken",
        "password",
        "privateKey",
        "secretFile",
        "serviceAccount",
        "serviceAccountFile",
        "serviceAccountRef",
        "signingSecret",
        "token",
        "tokenFile",
        "webhookSecret",
    ]
    .iter()
    .any(|key| has_configured_messaging_value(root.get(*key)))
}

fn value_has_messaging_credential(value: &Value) -> bool {
    value
        .as_object()
        .map(channel_root_has_messaging_credential)
        .unwrap_or(false)
}

fn required_channel_credential_fields(
    platform: &str,
    form: &Map<String, Value>,
) -> Vec<(&'static str, &'static str)> {
    match platform_storage_key(platform) {
        "telegram" => vec![("botToken", "Bot Token")],
        "discord" => vec![("token", "Bot Token")],
        "feishu" => vec![("appId", "App ID"), ("appSecret", "App Secret")],
        "dingtalk-connector" => vec![("clientId", "Client ID"), ("clientSecret", "Client Secret")],
        "mattermost" => vec![("botToken", "Bot Token"), ("baseUrl", "Base URL")],
        "synology-chat" => vec![("token", "Token"), ("incomingUrl", "Incoming URL")],
        "clickclack" => vec![
            ("baseUrl", "Base URL"),
            ("token", "Token"),
            ("workspace", "Workspace"),
        ],
        "nextcloud-talk" => vec![("baseUrl", "Base URL")],
        "nostr" => vec![("privateKey", "Private Key")],
        "irc" => vec![("host", "Host"), ("nick", "Nick")],
        "tlon" => vec![("ship", "Ship"), ("url", "URL"), ("code", "Code")],
        "twitch" => vec![
            ("username", "Username"),
            ("accessToken", "Access Token"),
            ("clientId", "Client ID"),
            ("channel", "Channel"),
        ],
        "signal" => vec![("account", "Signal 账号")],
        "slack" => {
            let mode = form_string(form, "mode");
            vec![
                ("botToken", "Bot Token"),
                if mode == "http" {
                    ("signingSecret", "Signing Secret")
                } else {
                    ("appToken", "App Token")
                },
            ]
        }
        "matrix" => {
            if has_configured_messaging_value(form.get("accessToken")) {
                vec![("accessToken", "Access Token")]
            } else {
                vec![
                    ("homeserver", "Homeserver"),
                    ("userId", "User ID"),
                    ("password", "Password"),
                ]
            }
        }
        "msteams" => msteams_credential_missing_labels(form)
            .into_iter()
            .map(|label| {
                if label == "App ID" {
                    ("appId", "App ID")
                } else {
                    ("__msteamsAuth", label)
                }
            })
            .collect(),
        _ => vec![],
    }
}

fn channel_any_credential_fields(platform: &str) -> Vec<(&'static str, &'static str)> {
    match platform_storage_key(platform) {
        "zalo" => vec![("botToken", "Bot Token"), ("tokenFile", "Token File")],
        "googlechat" => vec![
            ("serviceAccountFile", "Service Account File"),
            ("serviceAccount", "Service Account JSON"),
            ("serviceAccountRef", "Service Account SecretRef"),
        ],
        _ => vec![],
    }
}

fn channel_any_credential_groups(
    platform: &str,
) -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    match platform_storage_key(platform) {
        "line" => vec![
            (
                "Channel Access Token 或 Token File",
                vec![
                    ("channelAccessToken", "Channel Access Token"),
                    ("tokenFile", "Token File"),
                ],
            ),
            (
                "Channel Secret 或 Secret File",
                vec![
                    ("channelSecret", "Channel Secret"),
                    ("secretFile", "Secret File"),
                ],
            ),
        ],
        "nextcloud-talk" => vec![(
            "Bot Secret 或 Secret File",
            vec![
                ("botSecret", "Bot Secret"),
                ("botSecretFile", "Secret File"),
            ],
        )],
        _ => vec![],
    }
}

fn channel_diagnosis_credentials_ready(platform: &str, form: &Map<String, Value>) -> bool {
    if matches!(
        platform_storage_key(platform),
        "zalouser" | "imessage" | "whatsapp"
    ) {
        return true;
    }
    if platform_storage_key(platform) == "msteams" {
        return msteams_credential_missing_labels(form).is_empty();
    }
    let required_fields = required_channel_credential_fields(platform, form);
    let any_groups = channel_any_credential_groups(platform);
    if !required_fields.is_empty() {
        return required_fields
            .iter()
            .all(|(key, _)| has_configured_messaging_value(form.get(*key)))
            && any_groups.iter().all(|(_, fields)| {
                fields
                    .iter()
                    .any(|(key, _)| has_configured_messaging_value(form.get(*key)))
            });
    }
    if !any_groups.is_empty() {
        return any_groups.iter().all(|(_, fields)| {
            fields
                .iter()
                .any(|(key, _)| has_configured_messaging_value(form.get(*key)))
        });
    }
    let any_fields = channel_any_credential_fields(platform);
    if !any_fields.is_empty() {
        return any_fields
            .iter()
            .any(|(key, _)| has_configured_messaging_value(form.get(*key)));
    }
    channel_root_has_messaging_credential(form)
}

fn credential_labels(fields: &[(&'static str, &'static str)]) -> String {
    fields
        .iter()
        .map(|(_, label)| *label)
        .collect::<Vec<_>>()
        .join(" / ")
}

fn json_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn compact_diagnostic_details(values: &[String]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("；")
}

fn build_openclaw_channel_diagnosis(
    platform: &str,
    account_id: Option<&str>,
    config_exists: bool,
    channel_enabled: bool,
    form: &Map<String, Value>,
    verify_result: Option<Value>,
    verify_error: Option<String>,
) -> Value {
    let storage_key = platform_storage_key(platform);
    let display_platform = platform_list_id(storage_key);
    let account_id = account_id.map(str::trim).filter(|id| !id.is_empty());
    let mut checks = Vec::new();

    checks.push(json!({
        "id": "config_exists",
        "ok": config_exists,
        "title": "渠道配置已保存",
        "detail": if config_exists {
            format!(
                "已读取 channels.{}{} 的配置。",
                storage_key,
                account_id.map(|id| format!(".accounts.{}", id)).unwrap_or_default()
            )
        } else {
            format!(
                "未在 openclaw.json 中找到 {} 渠道配置，请先在「渠道列表」接入并保存。",
                display_platform
            )
        }
    }));

    checks.push(json!({
        "id": "channel_enabled",
        "ok": channel_enabled,
        "title": "渠道已启用",
        "detail": if channel_enabled {
            "渠道未被显式禁用，Gateway 重启/重载后会尝试加载。".to_string()
        } else {
            format!("channels.{}.enabled 为 false，请先在渠道列表中启用该渠道。", storage_key)
        }
    }));

    let required_fields = required_channel_credential_fields(storage_key, form);
    let any_fields = channel_any_credential_fields(storage_key);
    let any_groups = channel_any_credential_groups(storage_key);
    let missing: Vec<&str> = if storage_key == "msteams" {
        msteams_credential_missing_labels(form)
    } else {
        required_fields
            .iter()
            .filter(|(key, _)| !has_configured_messaging_value(form.get(*key)))
            .map(|(_, label)| *label)
            .collect()
    };
    let missing_groups: Vec<&str> = any_groups
        .iter()
        .filter(|(_, fields)| {
            !fields
                .iter()
                .any(|(key, _)| has_configured_messaging_value(form.get(*key)))
        })
        .map(|(label, _)| *label)
        .collect();
    let any_credential_ok = if any_fields.is_empty() {
        false
    } else {
        any_fields
            .iter()
            .any(|(key, _)| has_configured_messaging_value(form.get(*key)))
    };
    let credential_ok = if matches!(storage_key, "zalouser" | "imessage" | "whatsapp") {
        config_exists
    } else if !required_fields.is_empty() {
        missing.is_empty() && missing_groups.is_empty()
    } else if !any_groups.is_empty() {
        missing_groups.is_empty()
    } else if !any_fields.is_empty() {
        any_credential_ok
    } else {
        channel_root_has_messaging_credential(form)
    };
    let required_labels = credential_labels(&required_fields);
    let any_labels = credential_labels(&any_fields);
    checks.push(json!({
        "id": "credentials",
        "ok": credential_ok,
        "title": if storage_key == "zalouser" {
            "登录/会话配置"
        } else if storage_key == "imessage" {
            "桥接运行配置"
        } else if storage_key == "whatsapp" {
            "扫码/会话配置"
        } else {
            "必要凭证字段"
        },
        "detail": if storage_key == "zalouser" {
            "Zalo Personal 通过二维码登录保存本地会话；配置已保存后，请按手动命令完成或刷新登录。".to_string()
        } else if storage_key == "imessage" {
            if config_exists {
                "iMessage 使用本机或远端桥接运行，不需要 Bot Token；已保存基础运行配置。".to_string()
            } else {
                "尚未保存 iMessage 渠道配置，请先填写并保存。".to_string()
            }
        } else if storage_key == "whatsapp" {
            if config_exists {
                "WhatsApp 使用扫码登录保存本地会话，不需要 Bot Token；已保存扫码运行配置。".to_string()
            } else {
                "尚未保存 WhatsApp 渠道配置，请先填写并保存，再启动扫码登录。".to_string()
            }
        } else if credential_ok {
            if !required_fields.is_empty() {
                if !any_groups.is_empty() {
                    format!(
                        "已填写 {}；{}。",
                        required_labels,
                        any_groups
                            .iter()
                            .map(|(label, _)| *label)
                            .collect::<Vec<_>>()
                            .join("；")
                    )
                } else {
                    format!("已填写 {}。", required_labels)
                }
            } else if !any_groups.is_empty() {
                format!(
                    "已填写 {}。",
                    any_groups
                        .iter()
                        .map(|(label, _)| *label)
                        .collect::<Vec<_>>()
                        .join("；")
                )
            } else if !any_fields.is_empty() {
                format!("已填写 {} 其中一项。", any_labels)
            } else {
                "已检测到可用凭证字段。".to_string()
            }
        } else if !missing.is_empty() {
            format!("缺少 {}，请补齐后保存。", missing.join(" / "))
        } else if !missing_groups.is_empty() {
            format!("缺少 {}，请补齐后保存。", missing_groups.join("；"))
        } else if !any_fields.is_empty() {
            format!("缺少 {}，至少填写一项后保存。", any_labels)
        } else {
            "未检测到可用凭证字段，请检查渠道配置。".to_string()
        }
    }));

    if let Some(error) = verify_error.filter(|error| !error.trim().is_empty()) {
        checks.push(json!({
            "id": "online_verify",
            "ok": false,
            "title": "平台在线校验",
            "detail": error
        }));
    } else if let Some(result) = verify_result {
        let valid = result.get("valid").and_then(|v| v.as_bool()) == Some(true);
        let errors = json_string_list(result.get("errors"));
        let warnings = json_string_list(result.get("warnings"));
        let details = json_string_list(result.get("details"));
        let verify_ok = valid || (!warnings.is_empty() && errors.is_empty());
        checks.push(json!({
            "id": "online_verify",
            "ok": verify_ok,
            "title": "平台在线校验",
            "detail": if valid {
                let detail = compact_diagnostic_details(&details);
                if detail.is_empty() {
                    "平台 API 已接受当前凭证。".to_string()
                } else {
                    detail
                }
            } else {
                let detail = compact_diagnostic_details(&errors);
                if detail.is_empty() {
                    let warning_detail = compact_diagnostic_details(&warnings);
                    if warning_detail.is_empty() {
                        "该平台暂不支持在线校验。".to_string()
                    } else {
                        warning_detail
                    }
                } else {
                    detail
                }
            }
        }));
    } else {
        checks.push(json!({
            "id": "online_verify",
            "ok": true,
            "title": "平台在线校验",
            "detail": "未执行在线校验，仅完成本地配置检查。"
        }));
    }

    let failed_count = checks
        .iter()
        .filter(|check| check.get("ok").and_then(|v| v.as_bool()) != Some(true))
        .count();
    json!({
        "ok": failed_count == 0,
        "overallReady": failed_count == 0,
        "platform": display_platform,
        "accountId": account_id,
        "checks": checks,
        "userHints": if failed_count == 0 {
            vec!["配置侧检查已通过。若仍收不到消息，请确认 Gateway 已重启、机器人已加入目标会话，并检查 Gateway 日志。"]
        } else {
            vec![
                "先修复未通过的检查项，保存渠道后重启或重载 Gateway。",
                "在线校验只能证明平台凭证可用；群聊白名单、机器人邀请和平台回调仍需在对应平台控制台确认。",
            ]
        }
    })
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

fn insert_irc_groups_form_values(form: &mut Map<String, Value>, source: &Value) {
    let Some(groups) = source.get("groups").and_then(|v| v.as_object()) else {
        return;
    };
    let group_ids = groups
        .keys()
        .filter(|key| !key.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>();
    if !group_ids.is_empty() {
        form.insert("groups".into(), Value::String(group_ids.join(", ")));
    }
    let mention_values = group_ids
        .iter()
        .filter_map(|group_id| {
            groups
                .get(group_id)
                .and_then(|group| group.get("requireMention"))
                .and_then(|v| v.as_bool())
        })
        .collect::<Vec<_>>();
    if let Some(first) = mention_values.first() {
        if mention_values.iter().all(|value| value == first) {
            form.insert(
                "requireMention".into(),
                Value::String(if *first { "true" } else { "false" }.into()),
            );
        }
    }
}

fn insert_number_as_string(form: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(v) = source.get(key).and_then(|v| v.as_f64()) {
        form.insert(key.into(), Value::String(v.to_string()));
    }
}

fn insert_access_policy_form_values(
    form: &mut Map<String, Value>,
    source: &Value,
    telegram_compat: bool,
    mention_compat: bool,
) {
    insert_string_if_present(form, source, "dmPolicy");
    insert_string_if_present(form, source, "groupPolicy");
    if mention_compat
        && form.get("groupPolicy").and_then(|v| v.as_str()) == Some("open")
        && source.get("requireMention").and_then(|v| v.as_bool()) == Some(true)
    {
        form.insert("groupPolicy".into(), Value::String("mentioned".into()));
    }
    insert_array_as_csv(form, source, "allowFrom");
    if telegram_compat {
        if let Some(v) = form.get("allowFrom").cloned() {
            form.insert("allowedUsers".into(), v);
        }
    }
}

fn csv_to_json_array(raw: &str) -> Option<Value> {
    let items = raw
        .split(&[',', '\n', ';'][..])
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

fn json_array_from_csv_value(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(Value::String(trimmed.to_string()))
                    }
                } else if v.is_number() || v.is_boolean() {
                    Some(Value::String(v.to_string()))
                } else {
                    None
                }
            })
            .collect(),
        Some(Value::String(raw)) => csv_to_json_array(raw)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default(),
        _ => vec![],
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

fn put_number_from_form(entry: &mut Map<String, Value>, key: &str, raw: &str) {
    let value = raw.trim();
    if value.is_empty() {
        return;
    }
    if let Ok(number) = value.parse::<f64>() {
        if let Some(json_number) = serde_json::Number::from_f64(number) {
            entry.insert(key.into(), Value::Number(json_number));
        }
    }
}

fn put_number_value_if_present(entry: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(number) = value.and_then(|v| v.as_f64()) {
        if let Some(json_number) = serde_json::Number::from_f64(number) {
            entry.insert(key.into(), Value::Number(json_number));
        }
        return;
    }
    put_number_from_form(entry, key, value.and_then(|v| v.as_str()).unwrap_or(""));
}

fn normalize_numeric_form_value(map: &mut Map<String, Value>, key: &str) {
    let Some(value) = map.get(key).cloned() else {
        return;
    };
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                map.remove(key);
                return;
            }
            if let Ok(number) = trimmed.parse::<f64>() {
                if let Some(json_number) = serde_json::Number::from_f64(number) {
                    map.insert(key.into(), Value::Number(json_number));
                }
            }
        }
        Value::Null => {
            map.remove(key);
        }
        _ => {}
    }
}

fn put_bool_value_if_present(entry: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        Some(Value::Bool(v)) => {
            entry.insert(key.into(), Value::Bool(*v));
        }
        Some(Value::String(raw)) => put_bool_from_form(entry, key, raw),
        _ => {}
    }
}

fn put_array_from_form_value(entry: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    let items = json_array_from_csv_value(value);
    if !items.is_empty() {
        entry.insert(key.into(), Value::Array(items));
    }
}

fn build_irc_groups_from_form(form_obj: &Map<String, Value>) -> Option<Value> {
    let group_ids = json_array_from_csv_value(form_obj.get("groups"));
    if group_ids.is_empty() {
        return None;
    }
    let require_mention = form_obj.get("requireMention").and_then(|v| v.as_bool());
    let mut groups = Map::new();
    for value in group_ids {
        let Some(group_id) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut group = Map::new();
        if let Some(require_mention) = require_mention {
            group.insert("requireMention".into(), Value::Bool(require_mention));
        }
        groups.insert(group_id.to_string(), Value::Object(group));
    }
    if groups.is_empty() {
        None
    } else {
        Some(Value::Object(groups))
    }
}

fn normalize_dm_policy_value(raw: Option<&Value>, fallback: &str) -> String {
    let value = raw.and_then(|v| v.as_str()).unwrap_or("").trim();
    match value {
        "" => fallback.to_string(),
        "allow" | "open" => "open".into(),
        "deny" | "disabled" => "disabled".into(),
        "pairing" => "pairing".into(),
        "allowlist" => "allowlist".into(),
        _ => fallback.to_string(),
    }
}

fn normalize_group_policy_value(raw: Option<&Value>, fallback: &str) -> String {
    let value = raw.and_then(|v| v.as_str()).unwrap_or("").trim();
    match value {
        "" => fallback.to_string(),
        "all" | "mentioned" | "open" => "open".into(),
        "deny" | "disabled" => "disabled".into(),
        "allowlist" => "allowlist".into(),
        _ => fallback.to_string(),
    }
}

fn platform_supports_top_level_require_mention(platform: &str) -> bool {
    matches!(
        platform_storage_key(platform),
        "feishu" | "slack" | "msteams" | "mattermost" | "googlechat" | "nextcloud-talk" | "twitch"
    )
}

fn normalize_messaging_platform_form(
    platform: &str,
    form: &Map<String, Value>,
) -> Map<String, Value> {
    let storage_key = platform_storage_key(platform);
    let mut normalized = form.clone();

    if !normalized.contains_key("allowFrom") {
        if let Some(v) = normalized.get("allowedUsers").cloned() {
            normalized.insert("allowFrom".into(), v);
        }
    }

    let needs_access_defaults = matches!(
        storage_key,
        "telegram"
            | "discord"
            | "feishu"
            | "slack"
            | "signal"
            | "msteams"
            | "whatsapp"
            | "zalo"
            | "zalouser"
            | "line"
            | "mattermost"
            | "googlechat"
            | "nextcloud-talk"
            | "imessage"
            | "irc"
    );
    let has_dm_field = normalized.contains_key("dmPolicy") || needs_access_defaults;
    let has_group_field = normalized.contains_key("groupPolicy") || needs_access_defaults;

    if has_dm_field {
        let dm_policy = normalize_dm_policy_value(normalized.get("dmPolicy"), "pairing");
        normalized.insert("dmPolicy".into(), Value::String(dm_policy.clone()));
        if normalized.contains_key("allowFrom") {
            let items = json_array_from_csv_value(normalized.get("allowFrom"));
            normalized.insert("allowFrom".into(), Value::Array(items));
        }
        if dm_policy == "open" {
            let mut items = json_array_from_csv_value(normalized.get("allowFrom"));
            if !items.iter().any(|v| v.as_str() == Some("*")) {
                items.push(Value::String("*".into()));
            }
            normalized.insert("allowFrom".into(), Value::Array(items));
        }
    } else if normalized.contains_key("allowFrom") {
        let items = json_array_from_csv_value(normalized.get("allowFrom"));
        normalized.insert("allowFrom".into(), Value::Array(items));
    }

    if has_group_field {
        let requested_group_policy = normalized
            .get("groupPolicy")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let group_policy = normalize_group_policy_value(normalized.get("groupPolicy"), "allowlist");
        normalized.insert("groupPolicy".into(), Value::String(group_policy));
        if requested_group_policy == "mentioned"
            && platform_supports_top_level_require_mention(storage_key)
        {
            normalized.insert("requireMention".into(), Value::Bool(true));
        } else if requested_group_policy != "mentioned" {
            if platform_supports_top_level_require_mention(storage_key) {
                normalized.insert("requireMention".into(), Value::Bool(false));
            } else if normalized.contains_key("requireMention") {
                let value = match normalized.get("requireMention") {
                    Some(Value::Bool(v)) => *v,
                    Some(Value::String(s)) => bool_from_form_value(s).unwrap_or(false),
                    _ => false,
                };
                normalized.insert("requireMention".into(), Value::Bool(value));
            }
        }
    }

    if normalized.contains_key("groupAllowFrom") {
        let items = json_array_from_csv_value(normalized.get("groupAllowFrom"));
        normalized.insert("groupAllowFrom".into(), Value::Array(items));
    }

    if normalized.contains_key("allowedUserIds") {
        let items = json_array_from_csv_value(normalized.get("allowedUserIds"));
        normalized.insert("allowedUserIds".into(), Value::Array(items));
    }

    normalize_numeric_form_value(&mut normalized, "mediaMaxMb");
    normalize_numeric_form_value(&mut normalized, "historyLimit");
    normalize_numeric_form_value(&mut normalized, "dmHistoryLimit");
    normalize_numeric_form_value(&mut normalized, "textChunkLimit");
    normalize_numeric_form_value(&mut normalized, "probeTimeoutMs");
    normalize_numeric_form_value(&mut normalized, "debounceMs");
    normalize_numeric_form_value(&mut normalized, "rateLimitPerMinute");
    normalize_numeric_form_value(&mut normalized, "httpPort");
    normalize_numeric_form_value(&mut normalized, "webhookPort");
    normalize_numeric_form_value(&mut normalized, "feedbackReflectionCooldownMs");
    normalize_numeric_form_value(&mut normalized, "timeoutSeconds");
    normalize_numeric_form_value(&mut normalized, "reconnectMs");
    normalize_numeric_form_value(&mut normalized, "expiresIn");
    normalize_numeric_form_value(&mut normalized, "obtainmentTimestamp");
    normalize_numeric_form_value(&mut normalized, "port");

    for key in [
        "promptStarters",
        "delegatedAuthScopes",
        "attachmentRoots",
        "remoteAttachmentRoots",
        "toolsAllow",
        "allowedRoles",
        "relays",
        "channels",
        "groups",
        "mentionPatterns",
        "groupChannels",
        "dmAllowlist",
        "groupInviteAllowlist",
        "defaultAuthorizedShips",
    ] {
        if normalized.contains_key(key) {
            let items = json_array_from_csv_value(normalized.get(key));
            normalized.insert(key.into(), Value::Array(items));
        }
    }

    for key in [
        "dangerouslyAllowNameMatching",
        "dangerouslyAllowPrivateNetwork",
        "dangerouslyAllowInheritedWebhookPath",
        "allowInsecureSsl",
        "enabled",
        "allowBots",
        "blockStreaming",
        "useManagedIdentity",
        "typingIndicator",
        "welcomeCard",
        "groupWelcomeCard",
        "feedbackEnabled",
        "feedbackReflection",
        "delegatedAuthEnabled",
        "ssoEnabled",
        "configWrites",
        "includeAttachments",
        "sendReadReceipts",
        "coalesceSameSenderDms",
        "selfChatMode",
        "ackDirect",
        "senderIsOwner",
        "requireMention",
        "tls",
        "nickservEnabled",
        "nickservRegister",
        "autoDiscoverChannels",
        "showModelSignature",
        "autoAcceptDmInvites",
        "autoAcceptGroupInvites",
    ] {
        if normalized.contains_key(key) {
            let value = match normalized.get(key) {
                Some(Value::Bool(v)) => Some(*v),
                Some(Value::String(raw)) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(bool_from_form_value(trimmed).unwrap_or(false))
                    }
                }
                _ => None,
            };
            if let Some(v) = value {
                normalized.insert(key.into(), Value::Bool(v));
            } else {
                normalized.remove(key);
            }
        }
    }

    if storage_key == "feishu" {
        let domain = normalized
            .get("domain")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        normalized.insert(
            "domain".into(),
            Value::String(if domain.is_empty() { "feishu" } else { domain }.into()),
        );
        normalized
            .entry("connectionMode")
            .or_insert(Value::String("websocket".into()));
        normalized
            .entry("webhookPath")
            .or_insert(Value::String("/feishu/events".into()));
        normalized
            .entry("reactionNotifications")
            .or_insert(Value::String("off".into()));
        normalized
            .entry("typingIndicator")
            .or_insert(Value::Bool(true));
        normalized
            .entry("resolveSenderNames")
            .or_insert(Value::Bool(true));
    }

    if storage_key == "slack" {
        normalized
            .entry("mode")
            .or_insert(Value::String("socket".into()));
        normalized
            .entry("webhookPath")
            .or_insert(Value::String("/slack/events".into()));
        normalized
            .entry("userTokenReadOnly")
            .or_insert(Value::Bool(false));
    }

    normalized
}

/// 合并渠道配置：将新的表单字段覆盖到现有配置上，保留用户通过 CLI 或手动编辑的自定义字段。
/// 例如用户手动添加的 streaming / retry / dmPolicy 等不会被丢弃。
fn merge_channel_entry(
    channels_map: &mut Map<String, Value>,
    key: &str,
    new_entry: Map<String, Value>,
) {
    let merged = if let Some(Value::Object(existing)) = channels_map.get(key) {
        let mut m = existing.clone();
        for (k, v) in new_entry {
            m.insert(k, v);
        }
        m
    } else {
        new_entry
    };
    channels_map.insert(key.to_string(), Value::Object(merged));
}

/// 合并账号级渠道配置：保留渠道根节点和账号已有自定义字段，只覆盖本次表单字段。
fn merge_account_channel_entry(
    channels_map: &mut Map<String, Value>,
    key: &str,
    account_id: &str,
    new_entry: Map<String, Value>,
) -> Result<(), String> {
    let channel = channels_map
        .entry(key.to_string())
        .or_insert_with(|| json!({ "enabled": true }));
    let channel_obj = channel
        .as_object_mut()
        .ok_or(format!("{} 节点格式错误", key))?;
    let accounts_before = channel_obj
        .get("accounts")
        .and_then(|value| value.as_object())
        .map(|accounts| accounts.keys().filter(|id| !id.is_empty()).count())
        .unwrap_or(0);
    let should_set_default_account = channel_obj
        .get("defaultAccount")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        && !channel_root_has_messaging_credential(channel_obj)
        && accounts_before == 0;
    channel_obj.insert("enabled".into(), Value::Bool(true));
    let accounts = channel_obj.entry("accounts").or_insert_with(|| json!({}));
    let accounts_obj = accounts.as_object_mut().ok_or("accounts 格式错误")?;
    let merged = if let Some(Value::Object(existing)) = accounts_obj.get(account_id) {
        let mut m = existing.clone();
        for (k, v) in new_entry {
            m.insert(k, v);
        }
        m
    } else {
        new_entry
    };
    accounts_obj.insert(account_id.to_string(), Value::Object(merged));
    if should_set_default_account {
        channel_obj.insert(
            "defaultAccount".into(),
            Value::String(account_id.to_string()),
        );
    }
    Ok(())
}

fn merge_channel_entry_for_account(
    channels_map: &mut Map<String, Value>,
    key: &str,
    account_id: Option<&str>,
    new_entry: Map<String, Value>,
) -> Result<(), String> {
    if let Some(acct) = account_id.map(str::trim).filter(|s| !s.is_empty()) {
        merge_account_channel_entry(channels_map, key, acct, new_entry)
    } else {
        merge_channel_entry(channels_map, key, new_entry);
        Ok(())
    }
}

fn normalize_binding_match_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(Value::String(s.trim().to_string())),
        Value::Array(items) => {
            let mut normalized: Vec<Value> = items
                .iter()
                .filter_map(normalize_binding_match_value)
                .collect();
            if normalized.iter().all(|item| item.as_str().is_some()) {
                normalized.sort_by(|a, b| a.as_str().unwrap().cmp(b.as_str().unwrap()));
            }
            Some(Value::Array(normalized))
        }
        Value::Object(map) => {
            let mut result = Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();

            for key in keys {
                let Some(item) = map.get(key) else {
                    continue;
                };

                if key == "peer" {
                    if let Some(peer_id) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        result.insert("peer".into(), json!({ "kind": "direct", "id": peer_id }));
                    } else if let Some(peer_obj) = item.as_object() {
                        let kind = peer_obj
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or("direct");
                        let id = peer_obj
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty());
                        if let Some(peer_id) = id {
                            result.insert("peer".into(), json!({ "kind": kind, "id": peer_id }));
                        }
                    }
                    continue;
                }

                let Some(normalized) = normalize_binding_match_value(item) else {
                    continue;
                };
                if key == "accountId" && normalized.as_str().map(|s| s.is_empty()).unwrap_or(false)
                {
                    continue;
                }
                if normalized.as_str().map(|s| s.is_empty()).unwrap_or(false) {
                    continue;
                }
                result.insert(key.clone(), normalized);
            }

            Some(Value::Object(result))
        }
        _ => Some(value.clone()),
    }
}

fn build_binding_match(channel: &str, account_id: Option<&str>, binding_config: &Value) -> Value {
    let mut match_config = Map::new();
    match_config.insert("channel".into(), Value::String(channel.to_string()));

    if let Some(acct) = account_id.map(str::trim).filter(|s| !s.is_empty()) {
        match_config.insert("accountId".into(), Value::String(acct.to_string()));
    }

    if let Some(config_obj) = binding_config.as_object() {
        for (k, v) in config_obj {
            if k == "peer" {
                if let Some(peer_str) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    match_config.insert("peer".into(), json!({ "kind": "direct", "id": peer_str }));
                } else if let Some(peer_obj) = v.as_object() {
                    let kind = peer_obj
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("direct");
                    let id = peer_obj
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let Some(peer_id) = id {
                        match_config.insert("peer".into(), json!({ "kind": kind, "id": peer_id }));
                    }
                }
            } else if k != "accountId" && k != "channel" && !v.is_null() {
                match_config.insert(k.clone(), v.clone());
            }
        }
    }

    normalize_binding_match_value(&Value::Object(match_config))
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn binding_identity_matches(binding: &Value, agent_id: &str, target_match: &Value) -> bool {
    let binding_agent = binding
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    if binding_agent != agent_id {
        return false;
    }

    let existing_match =
        normalize_binding_match_value(binding.get("match").unwrap_or(&Value::Null))
            .unwrap_or_else(|| Value::Object(Map::new()));
    let expected_match =
        normalize_binding_match_value(target_match).unwrap_or_else(|| Value::Object(Map::new()));

    existing_match == expected_match
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

fn resolve_platform_config_entry(
    channel_root: Option<&Value>,
    platform: &str,
    account_id: Option<&str>,
) -> Option<Value> {
    let root = channel_root?;
    let account = account_id.map(str::trim).filter(|s| !s.is_empty());
    if let Some(acct) = account {
        if platform_storage_key(platform) == "tlon" && acct == QQBOT_DEFAULT_ACCOUNT_ID {
            return Some(root.clone());
        }
        if let Some(value) = root.get("accounts").and_then(|a| a.get(acct)) {
            return Some(value.clone());
        }
        if platform_storage_key(platform) == "qqbot" && !qqbot_channel_has_credentials(root) {
            return None;
        }
        return Some(root.clone());
    }

    if platform_storage_key(platform) == "qqbot" && !qqbot_channel_has_credentials(root) {
        return root
            .get("accounts")
            .and_then(|a| a.get(QQBOT_DEFAULT_ACCOUNT_ID))
            .cloned()
            .or_else(|| Some(root.clone()));
    }

    Some(root.clone())
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
    let saved = resolve_platform_config_entry(channel_root, &platform, account_id.as_deref())
        .unwrap_or(Value::Null);

    let exists = !saved.is_null();

    match platform.as_str() {
        "discord" => {
            if saved.is_null() {
                return Ok(json!({ "exists": false }));
            }
            // Discord 配置在 openclaw.json 中是展开的 guilds 结构
            // 需要反向提取成表单字段：token, guildId, channelId
            insert_secret_aware_form_value(&mut form, &saved, "token");
            insert_string_if_present(&mut form, &saved, "applicationId");
            insert_access_policy_form_values(&mut form, &saved, false, false);
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
            insert_secret_aware_form_value(&mut form, &saved, "botToken");
            insert_access_policy_form_values(&mut form, &saved, true, false);
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

            // 写入表单字段（前端 UI 用 clientSecret）；SecretRef 显示占位并保留原始对象
            insert_secret_aware_form_value(&mut form, qqbot_val, "appId");
            insert_secret_aware_form_value(&mut form, qqbot_val, "clientSecret");
            if !form.contains_key("appId") {
                if let Some(v) = app_id_val {
                    form.insert("appId".into(), Value::String(v.into()));
                }
            }
            if !form.contains_key("clientSecret") {
                if let Some(v) = client_secret_val {
                    form.insert("clientSecret".into(), Value::String(v.into()));
                }
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
            insert_secret_aware_form_value(&mut form, &saved, "appId");
            insert_secret_aware_form_value(&mut form, &saved, "appSecret");
            // 读 shared fields：优先从 channel root 读（多账号模式下 credentials 在 accounts 下，shared fields 在 root）
            if let Some(ref acct) = account_id {
                if !acct.is_empty() {
                    // 从 channel root 补 shared fields
                    let mut shared_source = saved.clone();
                    if let Some(ch_root) = channel_root {
                        if let (Some(target), Some(root)) =
                            (shared_source.as_object_mut(), ch_root.as_object())
                        {
                            for key in &[
                                "domain",
                                "connectionMode",
                                "webhookPath",
                                "dmPolicy",
                                "groupPolicy",
                                "allowFrom",
                                "reactionNotifications",
                                "typingIndicator",
                                "resolveSenderNames",
                                "requireMention",
                                "textChunkLimit",
                                "mediaMaxMb",
                            ] {
                                if let Some(v) = root.get(*key) {
                                    target.insert(key.to_string(), v.clone());
                                }
                            }
                        }
                    }
                    {
                        for key in &[
                            "domain",
                            "connectionMode",
                            "webhookPath",
                            "groupAllowFrom",
                            "groups",
                            "reactionNotifications",
                            "streaming",
                            "blockStreaming",
                            "textChunkLimit",
                            "mediaMaxMb",
                        ] {
                            if let Some(v) = shared_source.get(*key) {
                                if !v.is_null() {
                                    form.insert(key.to_string(), v.clone());
                                }
                            }
                        }
                        insert_access_policy_form_values(&mut form, &shared_source, false, true);
                        insert_bool_as_string(&mut form, &shared_source, "typingIndicator");
                        insert_bool_as_string(&mut form, &shared_source, "resolveSenderNames");
                        insert_bool_as_string(&mut form, &shared_source, "requireMention");
                    }
                }
            } else {
                // 无账号：直接从 root 读 shared fields
                for key in &[
                    "domain",
                    "connectionMode",
                    "webhookPath",
                    "reactionNotifications",
                    "textChunkLimit",
                    "mediaMaxMb",
                ] {
                    insert_string_if_present(&mut form, &saved, key);
                }
                insert_access_policy_form_values(&mut form, &saved, false, true);
                insert_bool_as_string(&mut form, &saved, "typingIndicator");
                insert_bool_as_string(&mut form, &saved, "resolveSenderNames");
                insert_bool_as_string(&mut form, &saved, "requireMention");
            }
        }
        "dingtalk" | "dingtalk-connector" => {
            insert_secret_aware_form_value(&mut form, &saved, "clientId");
            insert_secret_aware_form_value(&mut form, &saved, "clientSecret");
            insert_secret_aware_form_value(&mut form, &saved, "gatewayToken");
            insert_secret_aware_form_value(&mut form, &saved, "gatewayPassword");
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
            insert_secret_aware_form_value(&mut form, &saved, "botToken");
            insert_secret_aware_form_value(&mut form, &saved, "appToken");
            insert_secret_aware_form_value(&mut form, &saved, "signingSecret");
            insert_string_if_present(&mut form, &saved, "webhookPath");
            insert_string_if_present(&mut form, &saved, "teamId");
            insert_string_if_present(&mut form, &saved, "appId");
            insert_string_if_present(&mut form, &saved, "socketMode");
            insert_access_policy_form_values(&mut form, &saved, false, true);
            insert_bool_as_string(&mut form, &saved, "userTokenReadOnly");
            insert_bool_as_string(&mut form, &saved, "requireMention");
        }
        "whatsapp" => {
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "enabled");
            for key in [
                "configWrites",
                "sendReadReceipts",
                "selfChatMode",
                "blockStreaming",
            ] {
                insert_bool_as_string(&mut form, &saved, key);
            }
            for key in [
                "defaultTo",
                "contextVisibility",
                "chunkMode",
                "reactionLevel",
                "replyToMode",
                "messagePrefix",
                "responsePrefix",
            ] {
                insert_string_if_present(&mut form, &saved, key);
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "debounceMs",
                "textChunkLimit",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
            if let Some(ack_reaction) = saved.get("ackReaction") {
                if let Some(v) = ack_reaction.get("emoji").and_then(|v| v.as_str()) {
                    form.insert("ackEmoji".into(), Value::String(v.into()));
                }
                if let Some(v) = ack_reaction.get("direct").and_then(|v| v.as_bool()) {
                    form.insert(
                        "ackDirect".into(),
                        Value::String(if v { "true" } else { "false" }.into()),
                    );
                }
                if let Some(v) = ack_reaction.get("group").and_then(|v| v.as_str()) {
                    form.insert("ackGroup".into(), Value::String(v.into()));
                }
            }
        }
        "signal" => {
            insert_string_if_present(&mut form, &saved, "account");
            insert_string_if_present(&mut form, &saved, "cliPath");
            insert_string_if_present(&mut form, &saved, "httpUrl");
            insert_string_if_present(&mut form, &saved, "httpHost");
            insert_number_as_string(&mut form, &saved, "httpPort");
            insert_string_if_present(&mut form, &saved, "responsePrefix");
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "blockStreaming");
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
        }
        "imessage" => {
            for key in [
                "cliPath",
                "dbPath",
                "remoteHost",
                "service",
                "region",
                "defaultTo",
                "contextVisibility",
                "chunkMode",
                "reactionNotifications",
                "responsePrefix",
            ] {
                insert_string_if_present(&mut form, &saved, key);
            }
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_array_as_csv(&mut form, &saved, "attachmentRoots");
            insert_array_as_csv(&mut form, &saved, "remoteAttachmentRoots");
            for key in [
                "configWrites",
                "includeAttachments",
                "blockStreaming",
                "sendReadReceipts",
                "coalesceSameSenderDms",
            ] {
                insert_bool_as_string(&mut form, &saved, key);
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "probeTimeoutMs",
                "textChunkLimit",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
        }
        "matrix" => {
            insert_string_if_present(&mut form, &saved, "homeserver");
            insert_secret_aware_form_value(&mut form, &saved, "accessToken");
            insert_string_if_present(&mut form, &saved, "userId");
            insert_secret_aware_form_value(&mut form, &saved, "password");
            insert_string_if_present(&mut form, &saved, "deviceId");
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_bool_as_string(&mut form, &saved, "e2ee");
            if saved.get("accessToken").and_then(|v| v.as_str()).is_some() {
                form.insert("authMode".into(), Value::String("token".into()));
            } else if saved.get("userId").and_then(|v| v.as_str()).is_some()
                || saved.get("password").and_then(|v| v.as_str()).is_some()
            {
                form.insert("authMode".into(), Value::String("password".into()));
            }
        }
        "msteams" => {
            insert_secret_aware_form_value(&mut form, &saved, "appId");
            insert_secret_aware_form_value(&mut form, &saved, "appPassword");
            for key in [
                "tenantId",
                "authType",
                "certificatePath",
                "certificateThumbprint",
                "managedIdentityClientId",
                "botEndpoint",
                "replyStyle",
                "sharePointSiteId",
                "responsePrefix",
            ] {
                insert_string_if_present(&mut form, &saved, key);
            }
            if let Some(webhook) = saved.get("webhook") {
                insert_string_if_present(&mut form, webhook, "path");
                if let Some(v) = form.remove("path") {
                    form.insert("webhookPath".into(), v);
                }
                insert_number_as_string(&mut form, webhook, "port");
                if let Some(v) = form.remove("port") {
                    form.insert("webhookPort".into(), v);
                }
            } else {
                insert_string_if_present(&mut form, &saved, "webhookPath");
            }
            insert_access_policy_form_values(&mut form, &saved, false, true);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "requireMention");
            for key in [
                "useManagedIdentity",
                "blockStreaming",
                "typingIndicator",
                "welcomeCard",
                "groupWelcomeCard",
                "feedbackEnabled",
                "feedbackReflection",
            ] {
                insert_bool_as_string(&mut form, &saved, key);
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
                "feedbackReflectionCooldownMs",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
            insert_array_as_csv(&mut form, &saved, "promptStarters");
            if let Some(delegated_auth) = saved.get("delegatedAuth") {
                insert_bool_as_string(&mut form, delegated_auth, "enabled");
                if let Some(v) = form.remove("enabled") {
                    form.insert("delegatedAuthEnabled".into(), v);
                }
                insert_array_as_csv(&mut form, delegated_auth, "scopes");
                if let Some(v) = form.remove("scopes") {
                    form.insert("delegatedAuthScopes".into(), v);
                }
            }
            if let Some(sso) = saved.get("sso") {
                insert_bool_as_string(&mut form, sso, "enabled");
                if let Some(v) = form.remove("enabled") {
                    form.insert("ssoEnabled".into(), v);
                }
                insert_string_if_present(&mut form, sso, "connectionName");
                if let Some(v) = form.remove("connectionName") {
                    form.insert("ssoConnectionName".into(), v);
                }
            }
        }
        "line" => {
            for key in [
                "channelAccessToken",
                "tokenFile",
                "channelSecret",
                "secretFile",
                "webhookPath",
                "responsePrefix",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            if let Some(v) = saved.get("mediaMaxMb").and_then(|v| v.as_i64()) {
                form.insert("mediaMaxMb".into(), Value::String(v.to_string()));
            }
        }
        "mattermost" => {
            for key in [
                "botToken",
                "baseUrl",
                "name",
                "replyToMode",
                "responsePrefix",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_access_policy_form_values(&mut form, &saved, false, true);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "dangerouslyAllowNameMatching");
            if let Some(network) = saved.get("network") {
                insert_bool_as_string(&mut form, network, "dangerouslyAllowPrivateNetwork");
            }
            if let Some(commands) = saved.get("commands") {
                insert_string_if_present(&mut form, commands, "callbackPath");
                insert_string_if_present(&mut form, commands, "callbackUrl");
            }
        }
        "clickclack" => {
            for key in [
                "name",
                "baseUrl",
                "token",
                "workspace",
                "botUserId",
                "agentId",
                "replyMode",
                "model",
                "systemPrompt",
                "defaultTo",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_bool_as_string(&mut form, &saved, "enabled");
            insert_bool_as_string(&mut form, &saved, "senderIsOwner");
            insert_array_as_csv(&mut form, &saved, "toolsAllow");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
            insert_number_as_string(&mut form, &saved, "timeoutSeconds");
            insert_number_as_string(&mut form, &saved, "reconnectMs");
        }
        "nextcloud-talk" => {
            for key in [
                "name",
                "baseUrl",
                "botSecret",
                "botSecretFile",
                "apiUser",
                "apiPassword",
                "apiPasswordFile",
                "webhookHost",
                "webhookPath",
                "webhookPublicUrl",
                "chunkMode",
                "responsePrefix",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_bool_as_string(&mut form, &saved, "enabled");
            insert_access_policy_form_values(&mut form, &saved, false, true);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "blockStreaming");
            if let Some(network) = saved.get("network") {
                insert_bool_as_string(&mut form, network, "dangerouslyAllowPrivateNetwork");
            }
            for key in [
                "webhookPort",
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "textChunkLimit",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
        }
        "twitch" => {
            for key in [
                "username",
                "accessToken",
                "clientId",
                "channel",
                "responsePrefix",
                "clientSecret",
                "refreshToken",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_bool_as_string(&mut form, &saved, "enabled");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
            insert_array_as_csv(&mut form, &saved, "allowedRoles");
            insert_bool_as_string(&mut form, &saved, "requireMention");
            insert_number_as_string(&mut form, &saved, "expiresIn");
            insert_number_as_string(&mut form, &saved, "obtainmentTimestamp");
        }
        "nostr" => {
            insert_secret_aware_form_value(&mut form, &saved, "privateKey");
            for key in ["name", "defaultAccount", "dmPolicy"] {
                insert_string_if_present(&mut form, &saved, key);
            }
            insert_bool_as_string(&mut form, &saved, "enabled");
            insert_array_as_csv(&mut form, &saved, "relays");
            insert_array_as_csv(&mut form, &saved, "allowFrom");
            if let Some(profile) = saved.get("profile") {
                for (source_key, form_key) in [
                    ("name", "profileName"),
                    ("displayName", "profileDisplayName"),
                    ("about", "profileAbout"),
                    ("picture", "profilePicture"),
                    ("banner", "profileBanner"),
                    ("website", "profileWebsite"),
                    ("nip05", "profileNip05"),
                    ("lud16", "profileLud16"),
                ] {
                    if let Some(v) = profile.get(source_key).and_then(|v| v.as_str()) {
                        form.insert(form_key.into(), Value::String(v.into()));
                    }
                }
            }
        }
        "irc" => {
            for key in [
                "name",
                "host",
                "nick",
                "username",
                "realname",
                "password",
                "passwordFile",
                "defaultTo",
                "chunkMode",
                "responsePrefix",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            for key in [
                "enabled",
                "tls",
                "blockStreaming",
                "dangerouslyAllowNameMatching",
            ] {
                insert_bool_as_string(&mut form, &saved, key);
            }
            insert_access_policy_form_values(&mut form, &saved, false, false);
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_array_as_csv(&mut form, &saved, "channels");
            insert_array_as_csv(&mut form, &saved, "mentionPatterns");
            insert_irc_groups_form_values(&mut form, &saved);
            for key in [
                "port",
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "textChunkLimit",
            ] {
                insert_number_as_string(&mut form, &saved, key);
            }
            if let Some(nickserv) = saved.get("nickserv") {
                if let Some(v) = nickserv.get("enabled").and_then(|v| v.as_bool()) {
                    form.insert(
                        "nickservEnabled".into(),
                        Value::String(if v { "true" } else { "false" }.into()),
                    );
                }
                insert_secret_aware_form_alias(&mut form, nickserv, "service", "nickservService");
                insert_secret_aware_form_alias(&mut form, nickserv, "password", "nickservPassword");
                insert_secret_aware_form_alias(
                    &mut form,
                    nickserv,
                    "passwordFile",
                    "nickservPasswordFile",
                );
                if let Some(v) = nickserv.get("register").and_then(|v| v.as_bool()) {
                    form.insert(
                        "nickservRegister".into(),
                        Value::String(if v { "true" } else { "false" }.into()),
                    );
                }
                if let Some(v) = nickserv.get("registerEmail").and_then(|v| v.as_str()) {
                    form.insert("nickservRegisterEmail".into(), Value::String(v.into()));
                }
            }
        }
        "tlon" => {
            let mut shared = channel_root
                .and_then(|root| root.as_object())
                .cloned()
                .unwrap_or_default();
            if let Some(saved_obj) = saved.as_object() {
                for (key, value) in saved_obj {
                    shared.insert(key.clone(), value.clone());
                }
            }
            let shared = Value::Object(shared);
            for key in ["name", "ship", "url", "code", "responsePrefix", "ownerShip"] {
                insert_secret_aware_form_value(&mut form, &shared, key);
            }
            insert_bool_as_string(&mut form, &shared, "enabled");
            if let Some(network) = shared.get("network") {
                insert_bool_as_string(&mut form, network, "dangerouslyAllowPrivateNetwork");
            }
            for key in [
                "groupChannels",
                "dmAllowlist",
                "groupInviteAllowlist",
                "defaultAuthorizedShips",
            ] {
                insert_array_as_csv(&mut form, &shared, key);
            }
            for key in [
                "autoDiscoverChannels",
                "showModelSignature",
                "autoAcceptDmInvites",
                "autoAcceptGroupInvites",
            ] {
                insert_bool_as_string(&mut form, &shared, key);
            }
        }
        "synology-chat" => {
            for key in ["token", "incomingUrl", "nasHost", "webhookPath", "botName"] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            insert_string_if_present(&mut form, &saved, "dmPolicy");
            insert_array_as_csv(&mut form, &saved, "allowedUserIds");
            if let Some(v) = saved.get("rateLimitPerMinute").and_then(|v| v.as_i64()) {
                form.insert("rateLimitPerMinute".into(), Value::String(v.to_string()));
            }
            insert_bool_as_string(&mut form, &saved, "dangerouslyAllowNameMatching");
            insert_bool_as_string(&mut form, &saved, "dangerouslyAllowInheritedWebhookPath");
            insert_bool_as_string(&mut form, &saved, "allowInsecureSsl");
        }
        "googlechat" => {
            for key in [
                "serviceAccount",
                "serviceAccountFile",
                "serviceAccountRef",
                "audienceType",
                "audience",
                "appPrincipal",
                "webhookPath",
                "webhookUrl",
                "botUser",
                "chunkMode",
                "replyToMode",
                "typingIndicator",
                "responsePrefix",
            ] {
                insert_secret_aware_form_value(&mut form, &saved, key);
            }
            if let Some(dm) = saved.get("dm") {
                if let Some(policy) = dm.get("policy").and_then(|v| v.as_str()) {
                    form.insert("dmPolicy".into(), Value::String(policy.into()));
                }
                insert_array_as_csv(&mut form, dm, "allowFrom");
            }
            insert_string_if_present(&mut form, &saved, "groupPolicy");
            insert_array_as_csv(&mut form, &saved, "groupAllowFrom");
            insert_bool_as_string(&mut form, &saved, "requireMention");
            insert_bool_as_string(&mut form, &saved, "dangerouslyAllowNameMatching");
            insert_bool_as_string(&mut form, &saved, "allowBots");
            insert_bool_as_string(&mut form, &saved, "blockStreaming");
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
            ] {
                if let Some(v) = saved.get(key).and_then(|v| v.as_f64()) {
                    form.insert(key.into(), Value::String(v.to_string()));
                }
            }
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
                    if secret_ref_placeholder(v).is_some() {
                        insert_secret_aware_form_value(&mut form, &saved, k);
                    } else if let Some(s) = v.as_str() {
                        form.insert(k.clone(), Value::String(s.into()));
                    } else if v.is_array() {
                        insert_array_as_csv(&mut form, &saved, k);
                    } else if let Some(b) = v.as_bool() {
                        form.insert(
                            k.clone(),
                            Value::String(if b { "true" } else { "false" }.into()),
                        );
                    } else if v.is_number() {
                        form.insert(k.clone(), Value::String(v.to_string()));
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

    let raw_form_obj = form.as_object().ok_or("表单数据格式错误")?;
    let normalized_form = normalize_messaging_platform_form(&platform, raw_form_obj);
    let form_obj = &normalized_form;
    let current_saved = resolve_platform_config_entry(
        channels_map.get(storage_key.as_str()),
        &platform,
        account_id.as_deref(),
    )
    .unwrap_or(Value::Null);

    // 用于后续创建 bindings 的平台信息
    let saved_account_id = account_id.clone();

    match platform.as_str() {
        "discord" => {
            let mut entry = Map::new();

            // Bot Token
            if let Some(t) = form_obj.get("token").and_then(|v| v.as_str()) {
                entry.insert("token".into(), Value::String(t.trim().into()));
            }
            put_string(
                &mut entry,
                "applicationId",
                form_string(form_obj, "applicationId"),
            );
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));

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

            // 合并到现有配置，保留用户通过 CLI 设置的 streaming / retry / dmPolicy 等
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(channels_map, "discord", account_id.as_deref(), entry)?;
            // 仅在首次创建时设置默认值，不覆盖用户已有的设置
            if let Some(Value::Object(d)) = channels_map.get_mut("discord") {
                d.entry("groupPolicy")
                    .or_insert(Value::String("allowlist".into()));
                d.entry("dm").or_insert(json!({ "enabled": false }));
                d.entry("retry").or_insert(json!({
                    "attempts": 3,
                    "minDelayMs": 500,
                    "maxDelayMs": 30000,
                    "jitter": 0.1
                }));
            }
        }
        "telegram" => {
            let mut entry = Map::new();

            if let Some(t) = form_obj.get("botToken").and_then(|v| v.as_str()) {
                entry.insert("botToken".into(), Value::String(t.trim().into()));
            }
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));

            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                "telegram",
                account_id.as_deref(),
                entry,
            )?;
        }
        "zalo" => {
            let bot_token = form_string(form_obj, "botToken");
            let token_file = form_string(form_obj, "tokenFile");
            if bot_token.is_empty() && token_file.is_empty() {
                return Err("Bot Token 或 Token File 至少填写一项".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "botToken", bot_token);
            put_string(&mut entry, "tokenFile", token_file);
            put_string(
                &mut entry,
                "webhookUrl",
                form_string(form_obj, "webhookUrl"),
            );
            put_string(
                &mut entry,
                "webhookSecret",
                form_string(form_obj, "webhookSecret"),
            );
            put_string(
                &mut entry,
                "webhookPath",
                form_string(form_obj, "webhookPath"),
            );
            put_string(&mut entry, "proxy", form_string(form_obj, "proxy"));
            put_string(
                &mut entry,
                "responsePrefix",
                form_string(form_obj, "responsePrefix"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            if let Some(value) = form_obj.get("mediaMaxMb").and_then(|v| v.as_f64()) {
                if let Some(number) = serde_json::Number::from_f64(value) {
                    entry.insert("mediaMaxMb".into(), Value::Number(number));
                }
            } else {
                put_number_from_form(
                    &mut entry,
                    "mediaMaxMb",
                    &form_string(form_obj, "mediaMaxMb"),
                );
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "zalo")?;
        }
        "zalouser" => {
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "profile", form_string(form_obj, "profile"));
            put_string(
                &mut entry,
                "messagePrefix",
                form_string(form_obj, "messagePrefix"),
            );
            put_string(
                &mut entry,
                "responsePrefix",
                form_string(form_obj, "responsePrefix"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_bool_value_if_present(
                &mut entry,
                "dangerouslyAllowNameMatching",
                form_obj.get("dangerouslyAllowNameMatching"),
            );
            if let Some(value) = form_obj.get("historyLimit").and_then(|v| v.as_f64()) {
                if let Some(number) = serde_json::Number::from_f64(value) {
                    entry.insert("historyLimit".into(), Value::Number(number));
                }
            } else {
                put_number_from_form(
                    &mut entry,
                    "historyLimit",
                    &form_string(form_obj, "historyLimit"),
                );
            }
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "zalouser")?;
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

            // 与 `openclaw channels add --channel qqbot --token "AppID:Secret"` 一致：凭证写在 accounts.<id> 下
            let acct_key = account_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(QQBOT_DEFAULT_ACCOUNT_ID);

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

            let mut entry = Map::new();
            if !app_id.is_empty() {
                entry.insert("appId".into(), Value::String(app_id));
            }
            if !client_secret.is_empty() {
                entry.insert("clientSecret".into(), Value::String(client_secret));
            }
            entry.insert("enabled".into(), Value::Bool(true));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);

            if !has_configured_messaging_value(entry.get("appId")) {
                return Err("AppID 不能为空".into());
            }
            if !has_configured_messaging_value(entry.get("clientSecret")) {
                return Err("ClientSecret 不能为空".into());
            }

            // 明文凭证时写入组合 token；SecretRef 等场景保留已有 token
            if let (Some(Value::String(aid)), Some(Value::String(sec))) = (
                entry.get("appId"),
                entry.get("clientSecret"),
            ) {
                entry.insert("token".into(), Value::String(format!("{}:{}", aid, sec)));
            } else if let Some(token) = current_saved.get("token") {
                if has_configured_messaging_value(Some(token)) {
                    entry.insert("token".into(), token.clone());
                }
            }

            merge_account_channel_entry(channels_map, "qqbot", acct_key, entry)?;

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
            put_string(
                &mut entry,
                "connectionMode",
                form_string(form_obj, "connectionMode"),
            );
            put_string(&mut entry, "domain", form_string(form_obj, "domain"));
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
            put_string(
                &mut entry,
                "reactionNotifications",
                form_string(form_obj, "reactionNotifications"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_bool_value_if_present(
                &mut entry,
                "typingIndicator",
                form_obj.get("typingIndicator"),
            );
            put_bool_value_if_present(
                &mut entry,
                "resolveSenderNames",
                form_obj.get("resolveSenderNames"),
            );
            put_bool_value_if_present(&mut entry, "requireMention", form_obj.get("requireMention"));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);

            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
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

            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
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
            put_bool_value_if_present(
                &mut entry,
                "userTokenReadOnly",
                form_obj.get("userTokenReadOnly"),
            );
            put_bool_value_if_present(&mut entry, "requireMention", form_obj.get("requireMention"));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
        }
        "whatsapp" => {
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in [
                "defaultTo",
                "contextVisibility",
                "chunkMode",
                "reactionLevel",
                "replyToMode",
                "messagePrefix",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            for key in [
                "configWrites",
                "sendReadReceipts",
                "selfChatMode",
                "blockStreaming",
            ] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "debounceMs",
                "textChunkLimit",
            ] {
                put_number_value_if_present(&mut entry, key, form_obj.get(key));
            }
            let mut ack_reaction = current_saved
                .get("ackReaction")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_string(
                &mut ack_reaction,
                "emoji",
                form_string(form_obj, "ackEmoji"),
            );
            put_bool_value_if_present(&mut ack_reaction, "direct", form_obj.get("ackDirect"));
            put_string(
                &mut ack_reaction,
                "group",
                form_string(form_obj, "ackGroup"),
            );
            if !ack_reaction.is_empty() {
                entry.insert("ackReaction".into(), Value::Object(ack_reaction));
            }
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "whatsapp")?;
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
            put_number_from_form(&mut entry, "httpPort", &form_string(form_obj, "httpPort"));
            put_string(
                &mut entry,
                "responsePrefix",
                form_string(form_obj, "responsePrefix"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_bool_value_if_present(&mut entry, "blockStreaming", form_obj.get("blockStreaming"));
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
            ] {
                put_number_from_form(&mut entry, key, &form_string(form_obj, key));
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
        }
        "imessage" => {
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            for key in [
                "cliPath",
                "dbPath",
                "remoteHost",
                "service",
                "region",
                "defaultTo",
                "contextVisibility",
                "chunkMode",
                "reactionNotifications",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_array_from_form_value(
                &mut entry,
                "attachmentRoots",
                form_obj.get("attachmentRoots"),
            );
            put_array_from_form_value(
                &mut entry,
                "remoteAttachmentRoots",
                form_obj.get("remoteAttachmentRoots"),
            );
            for key in [
                "configWrites",
                "includeAttachments",
                "blockStreaming",
                "sendReadReceipts",
                "coalesceSameSenderDms",
            ] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "probeTimeoutMs",
                "textChunkLimit",
            ] {
                put_number_value_if_present(&mut entry, key, form_obj.get(key));
            }
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "imessage")?;
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
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "matrix")?;
        }
        "msteams" => {
            let app_id = form_string(form_obj, "appId");
            let app_password = form_string(form_obj, "appPassword");
            let missing_credentials = msteams_credential_missing_labels(form_obj);
            if !missing_credentials.is_empty() {
                return Err(format!("缺少 {}", missing_credentials.join(" / ")));
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "appId", app_id);
            put_string(&mut entry, "appPassword", app_password);
            for key in [
                "tenantId",
                "authType",
                "certificatePath",
                "certificateThumbprint",
                "managedIdentityClientId",
                "replyStyle",
                "sharePointSiteId",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            let mut webhook = current_saved
                .get("webhook")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_number_from_form(&mut webhook, "port", &form_string(form_obj, "webhookPort"));
            put_string(&mut webhook, "path", form_string(form_obj, "webhookPath"));
            if !webhook.is_empty() {
                entry.insert("webhook".into(), Value::Object(webhook));
            }
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            for key in [
                "useManagedIdentity",
                "requireMention",
                "blockStreaming",
                "typingIndicator",
                "welcomeCard",
                "groupWelcomeCard",
                "feedbackEnabled",
                "feedbackReflection",
            ] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
                "feedbackReflectionCooldownMs",
            ] {
                put_number_from_form(&mut entry, key, &form_string(form_obj, key));
            }
            put_array_from_form_value(&mut entry, "promptStarters", form_obj.get("promptStarters"));
            let mut delegated_auth = current_saved
                .get("delegatedAuth")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_bool_value_if_present(
                &mut delegated_auth,
                "enabled",
                form_obj.get("delegatedAuthEnabled"),
            );
            put_array_from_form_value(
                &mut delegated_auth,
                "scopes",
                form_obj.get("delegatedAuthScopes"),
            );
            if !delegated_auth.is_empty() {
                entry.insert("delegatedAuth".into(), Value::Object(delegated_auth));
            }
            let mut sso = current_saved
                .get("sso")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_bool_value_if_present(&mut sso, "enabled", form_obj.get("ssoEnabled"));
            put_string(
                &mut sso,
                "connectionName",
                form_string(form_obj, "ssoConnectionName"),
            );
            if !sso.is_empty() {
                entry.insert("sso".into(), Value::Object(sso));
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "msteams")?;
        }
        "line" => {
            let channel_access_token = form_string(form_obj, "channelAccessToken");
            let token_file = form_string(form_obj, "tokenFile");
            let channel_secret = form_string(form_obj, "channelSecret");
            let secret_file = form_string(form_obj, "secretFile");
            if channel_access_token.is_empty() && token_file.is_empty() {
                return Err("Channel Access Token 或 Token File 至少填写一项".into());
            }
            if channel_secret.is_empty() && secret_file.is_empty() {
                return Err("Channel Secret 或 Secret File 至少填写一项".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "channelAccessToken", channel_access_token);
            put_string(&mut entry, "tokenFile", token_file);
            put_string(&mut entry, "channelSecret", channel_secret);
            put_string(&mut entry, "secretFile", secret_file);
            put_string(
                &mut entry,
                "webhookPath",
                form_string(form_obj, "webhookPath"),
            );
            put_string(
                &mut entry,
                "responsePrefix",
                form_string(form_obj, "responsePrefix"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            if let Some(value) = form_obj.get("mediaMaxMb").and_then(|v| v.as_f64()) {
                if let Some(number) = serde_json::Number::from_f64(value) {
                    entry.insert("mediaMaxMb".into(), Value::Number(number));
                }
            } else {
                put_number_from_form(
                    &mut entry,
                    "mediaMaxMb",
                    &form_string(form_obj, "mediaMaxMb"),
                );
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "line")?;
        }
        "mattermost" => {
            let bot_token = form_string(form_obj, "botToken");
            let base_url = form_string(form_obj, "baseUrl");
            if bot_token.is_empty() {
                return Err("Mattermost Bot Token 不能为空".into());
            }
            if base_url.is_empty() {
                return Err("Mattermost Base URL 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "botToken", bot_token);
            put_string(&mut entry, "baseUrl", base_url);
            put_string(&mut entry, "name", form_string(form_obj, "name"));
            put_string(
                &mut entry,
                "replyToMode",
                form_string(form_obj, "replyToMode"),
            );
            put_string(
                &mut entry,
                "responsePrefix",
                form_string(form_obj, "responsePrefix"),
            );
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_bool_value_if_present(&mut entry, "requireMention", form_obj.get("requireMention"));
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_bool_value_if_present(
                &mut entry,
                "dangerouslyAllowNameMatching",
                form_obj.get("dangerouslyAllowNameMatching"),
            );

            if form_obj.contains_key("dangerouslyAllowPrivateNetwork") {
                let mut network = current_saved
                    .get("network")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                match form_obj.get("dangerouslyAllowPrivateNetwork") {
                    Some(Value::Bool(v)) => {
                        network.insert("dangerouslyAllowPrivateNetwork".into(), Value::Bool(*v));
                    }
                    Some(Value::String(raw)) => {
                        if let Some(v) = bool_from_form_value(raw) {
                            network.insert("dangerouslyAllowPrivateNetwork".into(), Value::Bool(v));
                        }
                    }
                    _ => {}
                }
                if !network.is_empty() {
                    entry.insert("network".into(), Value::Object(network));
                }
            }

            let mut commands = current_saved
                .get("commands")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_string(
                &mut commands,
                "callbackPath",
                form_string(form_obj, "callbackPath"),
            );
            put_string(
                &mut commands,
                "callbackUrl",
                form_string(form_obj, "callbackUrl"),
            );
            if !commands.is_empty() {
                entry.insert("commands".into(), Value::Object(commands));
            }

            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "mattermost")?;
        }
        "clickclack" => {
            let base_url = form_string(form_obj, "baseUrl");
            let token = form_string(form_obj, "token");
            let workspace = form_string(form_obj, "workspace");
            if base_url.is_empty() {
                return Err("ClickClack Base URL 不能为空".into());
            }
            if token.is_empty() {
                return Err("ClickClack Token 不能为空".into());
            }
            if workspace.is_empty() {
                return Err("ClickClack Workspace 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            put_string(&mut entry, "baseUrl", base_url);
            put_string(&mut entry, "token", token);
            put_string(&mut entry, "workspace", workspace);
            for key in [
                "name",
                "botUserId",
                "agentId",
                "replyMode",
                "model",
                "systemPrompt",
                "defaultTo",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_array_from_form_value(&mut entry, "toolsAllow", form_obj.get("toolsAllow"));
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_bool_value_if_present(&mut entry, "senderIsOwner", form_obj.get("senderIsOwner"));
            put_number_value_if_present(
                &mut entry,
                "timeoutSeconds",
                form_obj.get("timeoutSeconds"),
            );
            put_number_value_if_present(&mut entry, "reconnectMs", form_obj.get("reconnectMs"));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "clickclack")?;
        }
        "nextcloud-talk" => {
            let base_url = form_string(form_obj, "baseUrl");
            let bot_secret = form_string(form_obj, "botSecret");
            let bot_secret_file = form_string(form_obj, "botSecretFile");
            if base_url.is_empty() {
                return Err("Nextcloud Talk Base URL 不能为空".into());
            }
            if bot_secret.is_empty()
                && bot_secret_file.is_empty()
                && !has_configured_messaging_value(form_obj.get("botSecret"))
                && !has_configured_messaging_value(form_obj.get("botSecretFile"))
            {
                return Err("Nextcloud Talk Bot Secret 或 Secret File 至少填写一项".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in [
                "name",
                "baseUrl",
                "botSecret",
                "botSecretFile",
                "apiUser",
                "apiPassword",
                "apiPasswordFile",
                "webhookHost",
                "webhookPath",
                "webhookPublicUrl",
                "chunkMode",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_bool_value_if_present(&mut entry, "requireMention", form_obj.get("requireMention"));
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_bool_value_if_present(&mut entry, "blockStreaming", form_obj.get("blockStreaming"));
            for key in [
                "webhookPort",
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "textChunkLimit",
            ] {
                put_number_value_if_present(&mut entry, key, form_obj.get(key));
            }
            if form_obj.contains_key("dangerouslyAllowPrivateNetwork") {
                let mut network = current_saved
                    .get("network")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                put_bool_value_if_present(
                    &mut network,
                    "dangerouslyAllowPrivateNetwork",
                    form_obj.get("dangerouslyAllowPrivateNetwork"),
                );
                if !network.is_empty() {
                    entry.insert("network".into(), Value::Object(network));
                }
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "nextcloud-talk")?;
        }
        "twitch" => {
            let username = form_string(form_obj, "username");
            let access_token = form_string(form_obj, "accessToken");
            let client_id = form_string(form_obj, "clientId");
            let channel = form_string(form_obj, "channel");
            if username.is_empty() {
                return Err("Twitch Username 不能为空".into());
            }
            if access_token.is_empty()
                && !has_configured_messaging_value(form_obj.get("accessToken"))
            {
                return Err("Twitch Access Token 不能为空".into());
            }
            if client_id.is_empty() {
                return Err("Twitch Client ID 不能为空".into());
            }
            if channel.is_empty() {
                return Err("Twitch Channel 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in [
                "username",
                "accessToken",
                "clientId",
                "channel",
                "responsePrefix",
                "clientSecret",
                "refreshToken",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "allowedRoles", form_obj.get("allowedRoles"));
            put_bool_value_if_present(&mut entry, "requireMention", form_obj.get("requireMention"));
            put_number_value_if_present(&mut entry, "expiresIn", form_obj.get("expiresIn"));
            put_number_value_if_present(
                &mut entry,
                "obtainmentTimestamp",
                form_obj.get("obtainmentTimestamp"),
            );
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "twitch")?;
        }
        "nostr" => {
            let private_key = form_string(form_obj, "privateKey");
            if private_key.is_empty() && !has_configured_messaging_value(form_obj.get("privateKey"))
            {
                return Err("Nostr Private Key 不能为空".into());
            }

            let root_saved = channels_map
                .get(storage_key.as_str())
                .cloned()
                .unwrap_or(Value::Null);
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in ["name", "defaultAccount", "privateKey", "dmPolicy"] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_array_from_form_value(&mut entry, "relays", form_obj.get("relays"));
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));

            let mut profile = Map::new();
            for (form_key, target_key) in [
                ("profileName", "name"),
                ("profileDisplayName", "displayName"),
                ("profileAbout", "about"),
                ("profilePicture", "picture"),
                ("profileBanner", "banner"),
                ("profileWebsite", "website"),
                ("profileNip05", "nip05"),
                ("profileLud16", "lud16"),
            ] {
                put_string(&mut profile, target_key, form_string(form_obj, form_key));
            }
            if !profile.is_empty() {
                entry.insert("profile".into(), Value::Object(profile));
            }

            preserve_messaging_credential_refs(&mut entry, form_obj, &root_saved);
            merge_channel_entry_for_account(channels_map, &storage_key, None, entry)?;
            ensure_plugin_allowed(&mut cfg, "nostr")?;
        }
        "irc" => {
            let host = form_string(form_obj, "host");
            let nick = form_string(form_obj, "nick");
            if host.is_empty() {
                return Err("IRC Host 不能为空".into());
            }
            if nick.is_empty() {
                return Err("IRC Nick 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in [
                "name",
                "host",
                "nick",
                "username",
                "realname",
                "password",
                "passwordFile",
                "defaultTo",
                "chunkMode",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "allowFrom", form_obj.get("allowFrom"));
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            put_array_from_form_value(&mut entry, "channels", form_obj.get("channels"));
            put_array_from_form_value(
                &mut entry,
                "mentionPatterns",
                form_obj.get("mentionPatterns"),
            );
            if let Some(groups) = build_irc_groups_from_form(form_obj) {
                entry.insert("groups".into(), groups);
            }
            for key in ["tls", "blockStreaming", "dangerouslyAllowNameMatching"] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "port",
                "historyLimit",
                "dmHistoryLimit",
                "mediaMaxMb",
                "textChunkLimit",
            ] {
                put_number_value_if_present(&mut entry, key, form_obj.get(key));
            }

            let mut nickserv = current_saved
                .get("nickserv")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_bool_value_if_present(&mut nickserv, "enabled", form_obj.get("nickservEnabled"));
            put_string(
                &mut nickserv,
                "service",
                form_string(form_obj, "nickservService"),
            );
            match resolve_messaging_credential_value_for_save_alias(
                form_obj,
                current_saved.get("nickserv").unwrap_or(&Value::Null),
                "nickservPassword",
                "password",
            ) {
                Some(value) => {
                    nickserv.insert("password".into(), value);
                }
                None => {
                    nickserv.remove("password");
                }
            }
            match resolve_messaging_credential_value_for_save_alias(
                form_obj,
                current_saved.get("nickserv").unwrap_or(&Value::Null),
                "nickservPasswordFile",
                "passwordFile",
            ) {
                Some(value) => {
                    nickserv.insert("passwordFile".into(), value);
                }
                None => {
                    nickserv.remove("passwordFile");
                }
            }
            put_bool_value_if_present(&mut nickserv, "register", form_obj.get("nickservRegister"));
            put_string(
                &mut nickserv,
                "registerEmail",
                form_string(form_obj, "nickservRegisterEmail"),
            );
            if !nickserv.is_empty() {
                entry.insert("nickserv".into(), Value::Object(nickserv));
            }

            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "irc")?;
        }
        "tlon" => {
            let ship = form_string(form_obj, "ship");
            let url = form_string(form_obj, "url");
            let code = form_string(form_obj, "code");
            if ship.is_empty() {
                return Err("Tlon Ship 不能为空".into());
            }
            if url.is_empty() {
                return Err("Tlon URL 不能为空".into());
            }
            if code.is_empty() && !has_configured_messaging_value(form_obj.get("code")) {
                return Err("Tlon Code 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_bool_value_if_present(&mut entry, "enabled", form_obj.get("enabled"));
            for key in ["name", "ship", "url", "responsePrefix", "ownerShip"] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }
            match resolve_messaging_credential_value_for_save(form_obj, &current_saved, "code") {
                Some(value) => {
                    entry.insert("code".into(), value);
                }
                None => {
                    entry.remove("code");
                }
            }
            for key in [
                "groupChannels",
                "dmAllowlist",
                "groupInviteAllowlist",
                "defaultAuthorizedShips",
            ] {
                put_array_from_form_value(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "autoDiscoverChannels",
                "showModelSignature",
                "autoAcceptDmInvites",
                "autoAcceptGroupInvites",
            ] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            if form_obj.contains_key("dangerouslyAllowPrivateNetwork") {
                let mut network = current_saved
                    .get("network")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                put_bool_value_if_present(
                    &mut network,
                    "dangerouslyAllowPrivateNetwork",
                    form_obj.get("dangerouslyAllowPrivateNetwork"),
                );
                if !network.is_empty() {
                    entry.insert("network".into(), Value::Object(network));
                }
            }
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            let target_account_id =
                if account_id.as_deref().map(str::trim) == Some(QQBOT_DEFAULT_ACCOUNT_ID) {
                    None
                } else {
                    account_id.as_deref()
                };
            merge_channel_entry_for_account(channels_map, &storage_key, target_account_id, entry)?;
            ensure_plugin_allowed(&mut cfg, "tlon")?;
        }
        "synology-chat" => {
            let token = form_string(form_obj, "token");
            let incoming_url = form_string(form_obj, "incomingUrl");
            if token.is_empty() {
                return Err("Synology Chat Token 不能为空".into());
            }
            if incoming_url.is_empty() {
                return Err("Synology Chat Incoming URL 不能为空".into());
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            put_string(&mut entry, "token", token);
            put_string(&mut entry, "incomingUrl", incoming_url);
            put_string(&mut entry, "nasHost", form_string(form_obj, "nasHost"));
            put_string(
                &mut entry,
                "webhookPath",
                form_string(form_obj, "webhookPath"),
            );
            put_string(&mut entry, "botName", form_string(form_obj, "botName"));
            put_string(&mut entry, "dmPolicy", form_string(form_obj, "dmPolicy"));
            put_array_from_form_value(&mut entry, "allowedUserIds", form_obj.get("allowedUserIds"));
            if let Some(value) = form_obj.get("rateLimitPerMinute").and_then(|v| v.as_f64()) {
                if let Some(number) = serde_json::Number::from_f64(value) {
                    entry.insert("rateLimitPerMinute".into(), Value::Number(number));
                }
            } else {
                put_number_from_form(
                    &mut entry,
                    "rateLimitPerMinute",
                    &form_string(form_obj, "rateLimitPerMinute"),
                );
            }
            put_bool_value_if_present(
                &mut entry,
                "dangerouslyAllowNameMatching",
                form_obj.get("dangerouslyAllowNameMatching"),
            );
            put_bool_value_if_present(
                &mut entry,
                "dangerouslyAllowInheritedWebhookPath",
                form_obj.get("dangerouslyAllowInheritedWebhookPath"),
            );
            put_bool_value_if_present(
                &mut entry,
                "allowInsecureSsl",
                form_obj.get("allowInsecureSsl"),
            );
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "synology-chat")?;
        }
        "googlechat" => {
            let has_service_account =
                has_configured_messaging_value(form_obj.get("serviceAccount"))
                    || has_configured_messaging_value(form_obj.get("serviceAccountFile"))
                    || has_configured_messaging_value(form_obj.get("serviceAccountRef"));
            if !has_service_account {
                return Err(
                    "Google Chat 需要填写 Service Account JSON、Service Account File 或 SecretRef"
                        .into(),
                );
            }

            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(true));
            for key in [
                "serviceAccount",
                "serviceAccountFile",
                "serviceAccountRef",
                "audienceType",
                "audience",
                "appPrincipal",
                "webhookPath",
                "webhookUrl",
                "botUser",
                "chunkMode",
                "replyToMode",
                "typingIndicator",
                "responsePrefix",
            ] {
                put_string(&mut entry, key, form_string(form_obj, key));
            }

            let mut dm = current_saved
                .get("dm")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            put_string(&mut dm, "policy", form_string(form_obj, "dmPolicy"));
            let allow_from = json_array_from_csv_value(form_obj.get("allowFrom"));
            if !allow_from.is_empty() {
                dm.insert("allowFrom".into(), Value::Array(allow_from));
            }
            if !dm.is_empty() {
                entry.insert("dm".into(), Value::Object(dm));
            }

            put_string(
                &mut entry,
                "groupPolicy",
                form_string(form_obj, "groupPolicy"),
            );
            put_array_from_form_value(&mut entry, "groupAllowFrom", form_obj.get("groupAllowFrom"));
            for key in [
                "dangerouslyAllowNameMatching",
                "requireMention",
                "allowBots",
                "blockStreaming",
            ] {
                put_bool_value_if_present(&mut entry, key, form_obj.get(key));
            }
            for key in [
                "historyLimit",
                "dmHistoryLimit",
                "textChunkLimit",
                "mediaMaxMb",
            ] {
                if let Some(value) = form_obj.get(key).and_then(|v| v.as_f64()) {
                    if let Some(number) = serde_json::Number::from_f64(value) {
                        entry.insert(key.into(), Value::Number(number));
                    }
                } else {
                    put_number_from_form(&mut entry, key, &form_string(form_obj, key));
                }
            }

            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
            ensure_plugin_allowed(&mut cfg, "googlechat")?;
        }
        _ => {
            // 通用平台：直接保存表单字段
            let mut entry = Map::new();
            for (k, v) in form_obj {
                entry.insert(k.clone(), v.clone());
            }
            entry.insert("enabled".into(), Value::Bool(true));
            preserve_messaging_credential_refs(&mut entry, form_obj, &current_saved);
            merge_channel_entry_for_account(
                channels_map,
                &storage_key,
                account_id.as_deref(),
                entry,
            )?;
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
        "zalo" => verify_zalo(&client, form_obj).await,
        "zalouser" => Ok(json!({
            "valid": true,
            "warnings": ["Zalo Personal 通过二维码登录维护本地会话；请使用 openclaw channels status --probe 检查登录状态"]
        })),
        "matrix" => verify_matrix(&client, form_obj).await,
        "signal" => verify_signal(&client, form_obj).await,
        "msteams" => verify_msteams(&client, form_obj).await,
        "imessage" => Ok(json!({
            "valid": true,
            "warnings": ["iMessage 使用本机或远端桥接运行，无需在线校验 Bot Token；请通过 Gateway 日志确认桥接进程状态"]
        })),
        "whatsapp" => Ok(json!({
            "valid": true,
            "warnings": ["WhatsApp 使用扫码登录，无需在线校验凭证；请通过「启动扫码登录」完成配对"]
        })),
        "clickclack" => Ok(json!({
            "valid": true,
            "warnings": ["ClickClack 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
        })),
        "nextcloud-talk" => Ok(json!({
            "valid": true,
            "warnings": ["Nextcloud Talk 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
        })),
        "twitch" => Ok(json!({
            "valid": true,
            "warnings": ["Twitch 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
        })),
        "nostr" => Ok(json!({
            "valid": true,
            "warnings": ["Nostr 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
        })),
        "irc" => Ok(json!({
            "valid": true,
            "warnings": ["IRC 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
        })),
        "tlon" => Ok(json!({
            "valid": true,
            "warnings": ["Tlon 面板已完成基础字段校验；实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证"]
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

    // 兼容性检查：微信插件要求 OpenClaw >= 2026.3.22，通过版本号判断
    let mut compatible = true;
    let mut compat_error = String::new();
    if installed {
        let oc_ver = crate::utils::resolve_openclaw_cli_path()
            .and_then(|_| {
                let out = crate::utils::openclaw_command()
                    .arg("--version")
                    .output()
                    .ok()?;
                let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                raw.split_whitespace()
                    .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .map(String::from)
            })
            .unwrap_or_default();
        let oc_nums: Vec<u32> = oc_ver
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|s| s.parse().ok())
            .collect();
        if oc_nums < vec![2026, 3, 22] {
            compatible = false;
            compat_error = format!(
                "插件版本与当前 OpenClaw {} 不兼容（要求 >= 2026.3.22），请先升级 OpenClaw 或在终端执行: npx -y @tencent-weixin/openclaw-weixin-cli@latest install",
                oc_ver
            );
        }
    }

    Ok(json!({
        "installed": installed,
        "installedVersion": installed_version,
        "latestVersion": latest_version,
        "updateAvailable": update_available,
        "extensionDir": ext_dir.to_string_lossy(),
        "compatible": compatible,
        "compatError": compat_error,
    }))
}

#[tauri::command]
pub async fn run_channel_action(
    app: tauri::AppHandle,
    platform: String,
    action: String,
    version: Option<String>,
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
        // 微信 CLI 版本号独立于 OpenClaw（1.0.x / 2.0.x），不能用 OpenClaw 版本号 pin
        // v2.0.1 需要 OpenClaw >= 2026.3.22 的 SDK，旧版用 v1.0.3（最后兼容版）
        let weixin_spec = if version.as_deref().is_some_and(|v| !v.is_empty()) {
            format!(
                "@tencent-weixin/openclaw-weixin-cli@{}",
                version.as_deref().unwrap()
            )
        } else {
            // 检测 OpenClaw 版本，决定装哪个
            let oc_ver = crate::utils::resolve_openclaw_cli_path()
                .and_then(|_| {
                    let out = crate::utils::openclaw_command()
                        .arg("--version")
                        .output()
                        .ok()?;
                    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    // 输出格式: "OpenClaw 2026.3.24 (hash)" → 取第二个词（版本号）
                    raw.split_whitespace()
                        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
                        .map(String::from)
                })
                .unwrap_or_default();
            let oc_nums: Vec<u32> = oc_ver
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|s| s.parse().ok())
                .collect();
            let needs_legacy = oc_nums < vec![2026, 3, 22];
            if needs_legacy {
                // 微信插件所有版本都依赖 OpenClaw >= 2026.3.22 的 SDK
                // 给用户两个选择：升级 OpenClaw 或手动尝试安装
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "error",
                        "message": format!("⚠ 微信插件要求 OpenClaw >= 2026.3.22，当前版本 {}。", oc_ver) }),
                );
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info",
                        "message": "建议方案 1（推荐）：先升级 OpenClaw，再安装微信插件" }),
                );
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info",
                        "message": "  → 前往「服务管理」页面点击升级" }),
                );
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info",
                        "message": "建议方案 2：在终端手动尝试安装（可能存在兼容问题）" }),
                );
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info",
                        "message": "  → npx -y @tencent-weixin/openclaw-weixin-cli@latest install" }),
                );
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info",
                        "message": "后续版本将升级推荐内核到最新版以完整支持微信插件。" }),
                );
                let _ = app.emit(
                    "channel-action-progress",
                    json!({ "platform": &platform, "action": &action, "progress": 100 }),
                );
                return Err(format!(
                    "微信插件要求 OpenClaw >= 2026.3.22（当前 {}），请先升级 OpenClaw 或在终端手动安装",
                    oc_ver
                ));
            }
            "@tencent-weixin/openclaw-weixin-cli@latest".to_string()
        };
        // 先清理旧的不兼容插件目录 + openclaw.json 中的残留配置
        // （否则 OpenClaw 配置校验会报 unknown channel / plugin not found）
        let weixin_ext_dir = super::openclaw_dir()
            .join("extensions")
            .join("openclaw-weixin");
        if weixin_ext_dir.exists() {
            let _ = app.emit(
                "channel-action-log",
                json!({ "platform": &platform, "action": &action, "kind": "info", "message": "清理旧版微信插件目录..." }),
            );
            let _ = std::fs::remove_dir_all(&weixin_ext_dir);
        }
        // 清理 openclaw.json 中的微信残留配置
        if let Ok(mut cfg) = super::config::load_openclaw_json() {
            let mut changed = false;
            if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
                if channels.remove("openclaw-weixin").is_some() {
                    changed = true;
                }
            }
            if let Some(plugins) = cfg.get_mut("plugins").and_then(|p| p.as_object_mut()) {
                if let Some(allow) = plugins.get_mut("allow").and_then(|a| a.as_array_mut()) {
                    let before = allow.len();
                    allow.retain(|v| v.as_str() != Some("openclaw-weixin"));
                    if allow.len() != before {
                        changed = true;
                    }
                }
                if let Some(entries) = plugins.get_mut("entries").and_then(|e| e.as_object_mut()) {
                    if entries.remove("openclaw-weixin").is_some() {
                        changed = true;
                    }
                }
            }
            if changed {
                let _ = super::config::save_openclaw_json(&cfg);
                let _ = app.emit(
                    "channel-action-log",
                    json!({ "platform": &platform, "action": &action, "kind": "info", "message": "已清理 openclaw.json 中的微信插件残留配置" }),
                );
            }
        }

        let _ = app.emit(
            "channel-action-log",
            json!({
                "platform": &platform, "action": &action, "kind": "info",
                "message": format!("开始安装微信插件: npx -y {} install", weixin_spec),
            }),
        );
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
            c.args(["/c", "npx", "-y", &weixin_spec, "install"]);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = std::process::Command::new("npx");
            c.args(["-y", &weixin_spec, "install"]);
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
                    .map(|r| r.entry("channels").or_insert_with(|| json!({})))
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
    val.get("appId").is_some_and(secret_like_value_present)
        || val
            .get("clientSecret")
            .or_else(|| val.get("appSecret"))
            .is_some_and(secret_like_value_present)
        || val.get("token").is_some_and(secret_like_value_present)
}

fn secret_like_value_present(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty()) || secret_ref_placeholder(value).is_some()
}

fn account_display_value(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| {
        v.as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| secret_ref_placeholder(v))
    })
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
    let platform = platform.trim().to_string();
    if platform.is_empty() {
        return Err("platform 不能为空".into());
    }
    if platform == "qqbot" {
        return diagnose_qqbot_channel(account_id).await;
    }

    let cfg = super::config::load_openclaw_json().unwrap_or_else(|_| json!({}));
    let storage_key = platform_storage_key(&platform);
    let normalized_account_id = account_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let channel_root = cfg.get("channels").and_then(|c| c.get(storage_key));
    let channel_enabled = channel_root
        .and_then(|node| node.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let saved =
        read_platform_config(platform.clone(), normalized_account_id.map(str::to_string)).await?;
    let config_exists = saved
        .get("exists")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let form = saved
        .get("values")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let credentials_ready = channel_diagnosis_credentials_ready(&platform, &form);
    let (verify_result, verify_error) = if config_exists && credentials_ready {
        match verify_bot_token(platform.clone(), Value::Object(form.clone())).await {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };

    Ok(build_openclaw_channel_diagnosis(
        &platform,
        normalized_account_id,
        config_exists,
        channel_enabled,
        &form,
        verify_result,
        verify_error,
    ))
}

/// 一键修复 QQ 插件：未安装则安装官方包并重启 Gateway；已安装则补齐 plugins.allow / entries 并重载 Gateway。
#[tauri::command]
pub async fn repair_qqbot_channel_setup(app: tauri::AppHandle) -> Result<Value, String> {
    let (installed, _loc) = qqbot_extension_installed();
    if !installed {
        install_qqbot_plugin(app.clone(), None).await?;
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
                    if let Some(display_id) = account_display_value(acct_val, "appId")
                        .or_else(|| account_display_value(acct_val, "clientId"))
                        .or_else(|| account_display_value(acct_val, "account"))
                        .or_else(|| account_display_value(acct_val, "nick"))
                        .or_else(|| account_display_value(acct_val, "ship"))
                    {
                        entry["appId"] = Value::String(display_id);
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

#[tauri::command]
pub async fn list_all_plugins() -> Result<Value, String> {
    let cfg = super::config::load_openclaw_json().unwrap_or_else(|_| json!({}));
    let entries = cfg
        .pointer("/plugins/entries")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let allow_arr = cfg
        .pointer("/plugins/allow")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let ext_dir = super::openclaw_dir().join("extensions");
    let mut plugins: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Scan extensions directory
    if ext_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&ext_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let has_marker = p.join("package.json").is_file()
                    || p.join("plugin.ts").is_file()
                    || p.join("index.js").is_file();
                if !has_marker {
                    continue;
                }

                let plugin_id = name.clone();
                seen.insert(plugin_id.clone());

                let entry_cfg = entries.get(&plugin_id);
                let enabled = entry_cfg
                    .and_then(|e| e.get("enabled"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let allowed = allow_arr.iter().any(|v| v.as_str() == Some(&plugin_id));
                let builtin = is_plugin_builtin(&plugin_id);

                // Try to read version from package.json
                let version = std::fs::read_to_string(p.join("package.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v.get("version").and_then(|v| v.as_str().map(String::from)));

                let description = std::fs::read_to_string(p.join("package.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| {
                        v.get("description")
                            .and_then(|v| v.as_str().map(String::from))
                    });

                plugins.push(json!({
                    "id": plugin_id,
                    "installed": true,
                    "builtin": builtin,
                    "enabled": enabled,
                    "allowed": allowed,
                    "version": version,
                    "description": description,
                    "config": entry_cfg.and_then(|e| e.get("config")),
                }));
            }
        }
    }

    // Also include entries from config that might not be in extensions dir (built-in)
    for (pid, entry_val) in &entries {
        if seen.contains(pid.as_str()) {
            continue;
        }
        seen.insert(pid.clone());
        let enabled = entry_val
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let allowed = allow_arr.iter().any(|v| v.as_str() == Some(pid.as_str()));
        let builtin = is_plugin_builtin(pid);
        plugins.push(json!({
            "id": pid,
            "installed": builtin,
            "builtin": builtin,
            "enabled": enabled,
            "allowed": allowed,
            "version": null,
            "description": null,
            "config": entry_val.get("config"),
        }));
    }

    plugins.sort_by(|a, b| {
        let ae = a.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let be = b.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        be.cmp(&ae).then_with(|| {
            let an = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let bn = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
            an.cmp(bn)
        })
    });

    Ok(json!({ "plugins": plugins }))
}

#[tauri::command]
pub async fn toggle_plugin(plugin_id: String, enabled: bool) -> Result<Value, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id 不能为空".into());
    }

    let mut cfg = super::config::load_openclaw_json().unwrap_or_else(|_| json!({}));

    if enabled {
        ensure_plugin_allowed(&mut cfg, plugin_id)?;
    } else {
        disable_legacy_plugin(&mut cfg, plugin_id);
    }

    // 使用 save_openclaw_json 写入（含备份和 UI 字段清理），而非直接 fs::write
    super::config::save_openclaw_json(&cfg)?;

    Ok(json!({ "ok": true, "enabled": enabled, "pluginId": plugin_id }))
}

#[tauri::command]
pub async fn install_plugin(package_name: String) -> Result<Value, String> {
    let package_name = package_name.trim().to_string();
    if package_name.is_empty() {
        return Err("包名不能为空".into());
    }

    let cli = crate::utils::resolve_openclaw_cli_path()
        .ok_or_else(|| "找不到 OpenClaw CLI，请先安装".to_string())?;
    let output = std::process::Command::new(&cli)
        .args(["plugins", "install", &package_name])
        .current_dir(dirs::home_dir().unwrap_or_default())
        .output()
        .map_err(|e| format!("执行 openclaw plugins install 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("安装失败: {}{}", stdout, stderr));
    }

    Ok(json!({ "ok": true, "output": format!("{}{}", stdout, stderr).trim().to_string() }))
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
    let missing_credentials = msteams_credential_missing_labels(form);
    if !missing_credentials.is_empty() {
        return Ok(
            json!({ "valid": false, "errors": [format!("缺少 {}", missing_credentials.join(" / "))] }),
        );
    }
    if app_password.is_empty() {
        return Ok(json!({
            "valid": true,
            "warnings": ["当前 Teams 认证模式不使用 Client Secret；面板已完成结构校验，实际连通性请通过 Gateway 启动日志或 openclaw channels status --probe 验证。"],
            "details": [format!("App ID: {}", app_id)]
        }));
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
    version: Option<String>,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let package_name = package_name.trim();
    let plugin_id = plugin_id.trim();
    if package_name.is_empty() || plugin_id.is_empty() {
        return Err("package_name 和 plugin_id 不能为空".into());
    }
    // 拼接版本号：package@version（兼容用户 OpenClaw 版本的插件）
    let install_spec = match &version {
        Some(v) if !v.is_empty() => format!("{}@{}", package_name, v),
        _ => package_name.to_string(),
    };
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

    let _ = app.emit("plugin-log", format!("安装规格: {}", install_spec));
    let spawn_result = crate::utils::openclaw_command()
        .args(["plugins", "install", &install_spec])
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
    let stderr_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let stderr_clone = stderr_lines.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("plugin-log", &line);
                stderr_clone.lock().unwrap().push(line);
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
        let all_stderr = stderr_lines.lock().unwrap().join("\n");
        let is_host_version_issue = all_stderr.contains("minHostVersion")
            || all_stderr.contains("minimum host version")
            || all_stderr.contains("requires OpenClaw")
            || all_stderr.contains("host version");
        if is_host_version_issue {
            let _ = app.emit(
                "plugin-log",
                "⚠ 插件要求更高版本的 OpenClaw（minHostVersion 不满足）",
            );
            let _ = app.emit("plugin-log", "请先升级 OpenClaw 到最新版，再安装此插件：");
            let _ = app.emit(
                "plugin-log",
                "  前往「服务管理」页面点击升级，或在终端执行：",
            );
            let _ = app.emit("plugin-log", "  npm i -g @qingchencloud/openclaw-zh@latest --registry https://registry.npmmirror.com");
        }
        let rollback_err =
            cleanup_failed_plugin_install(plugin_id, had_existing_plugin, had_existing_config)
                .err()
                .unwrap_or_default();
        let _ = app.emit(
            "plugin-log",
            format!("插件 {} 安装失败，已回退", package_name),
        );
        if is_host_version_issue {
            return Err("插件安装失败：当前 OpenClaw 版本过低，请先升级后重试".into());
        }
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
pub async fn install_qqbot_plugin(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let install_spec = match &version {
        Some(v) if !v.is_empty() => format!("{}@{}", TENCENT_OPENCLAW_QQBOT_PACKAGE, v),
        _ => TENCENT_OPENCLAW_QQBOT_PACKAGE.to_string(),
    };

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

    let _ = app.emit("plugin-log", format!("安装规格: {}", install_spec));
    let spawn_result = crate::utils::openclaw_command()
        .args(["plugins", "install", &install_spec])
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
        let all_stderr = qqbot_stderr_lines.lock().unwrap().join("\n");
        let is_host_version_issue = all_stderr.contains("minHostVersion")
            || all_stderr.contains("minimum host version")
            || all_stderr.contains("requires OpenClaw")
            || all_stderr.contains("host version");
        if is_host_version_issue {
            let _ = app.emit(
                "plugin-log",
                "⚠ 插件要求更高版本的 OpenClaw（minHostVersion 不满足）",
            );
            let _ = app.emit("plugin-log", "请先升级 OpenClaw 到最新版，再安装此插件：");
            let _ = app.emit(
                "plugin-log",
                "  前往「服务管理」页面点击升级，或在终端执行：",
            );
            let _ = app.emit("plugin-log", "  npm i -g @qingchencloud/openclaw-zh@latest --registry https://registry.npmmirror.com");
        } else {
            let _ = app.emit(
                "plugin-log",
                "openclaw plugins install 未成功结束，正在回退",
            );
        }
        let _ = cleanup_failed_extension_install(
            &plugin_dir,
            &plugin_backup,
            &config_backup,
            had_existing_plugin,
            had_existing_config,
        );
        let _ = app.emit("plugin-progress", 100);
        if is_host_version_issue {
            return Err("插件安装失败：当前 OpenClaw 版本过低，请先升级后重试".into());
        }
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
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ =
                    crate::commands::service::restart_service(app2, "ai.openclaw.gateway".into())
                        .await;
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
                    .map(value_has_messaging_credential)
                    .unwrap_or(false);

                if !has_account {
                    let has_root = ch
                        .as_object()
                        .map(channel_root_has_messaging_credential)
                        .unwrap_or(false);
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
                         请先在渠道列表中为账号「{}」接入对应渠道账号。",
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

    let target_match = build_binding_match(&channel, account_id.as_deref(), &binding_config);

    new_binding.insert("match".to_string(), target_match.clone());

    // 先转换为 Value，避免在循环中移动
    let binding_value = serde_json::Value::Object(new_binding);

    let mut found = false;
    for binding in bindings_arr.iter_mut() {
        if binding_identity_matches(binding, &agent_id, &target_match) {
            *binding = binding_value.clone();
            found = true;
            break;
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
    binding_config: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut cfg = super::config::load_openclaw_json()?;
    let target_match = build_binding_match(
        &channel,
        account_id.as_deref(),
        binding_config.as_ref().unwrap_or(&Value::Null),
    );

    let Some(bindings) = cfg.get_mut("bindings").and_then(|b| b.as_array_mut()) else {
        return Ok(serde_json::json!({ "ok": true }));
    };

    let original_len = bindings.len();
    bindings.retain(|b| !binding_identity_matches(b, &agent_id, &target_match));

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

// ── Zalo Bot 凭证校验 ─────────────────────────────────────

async fn verify_zalo(client: &reqwest::Client, form: &Map<String, Value>) -> Result<Value, String> {
    let bot_token = form
        .get("botToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let token_file = form
        .get("tokenFile")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if bot_token.is_empty() {
        if token_file.is_empty() {
            return Ok(json!({ "valid": false, "errors": ["请填写 Bot Token 或 Token File"] }));
        }
        return Ok(json!({
            "valid": true,
            "warnings": ["已配置 Token File；桌面端不会读取外部文件做在线校验"]
        }));
    }

    let resp = client
        .post(format!(
            "https://bot-api.zaloplatforms.com/bot{}/getMe",
            bot_token
        ))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Zalo API 连接失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(json!({
            "valid": true,
            "errors": [],
            "details": ["Zalo Bot Token 已通过 getMe 校验"]
        }))
    } else {
        let msg = body
            .get("description")
            .or_else(|| body.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Zalo Bot Token 无效");
        Ok(json!({
            "valid": false,
            "errors": [msg]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_channel_form_adds_telegram_access_defaults() {
        let form = json!({
            "botToken": "123:token"
        });
        let normalized =
            normalize_messaging_platform_form("telegram", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("botToken").and_then(|v| v.as_str()),
            Some("123:token")
        );
        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("pairing")
        );
        assert_eq!(
            normalized.get("groupPolicy").and_then(|v| v.as_str()),
            Some("allowlist")
        );
    }

    #[test]
    fn normalize_channel_form_converts_legacy_ui_policy_values() {
        let form = json!({
            "mode": "socket",
            "botToken": "xoxb-token",
            "appToken": "xapp-token",
            "dmPolicy": "allow",
            "groupPolicy": "mentioned"
        });
        let normalized =
            normalize_messaging_platform_form("slack", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("open")
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .cloned(),
            Some(vec![Value::String("*".into())])
        );
        assert_eq!(
            normalized.get("groupPolicy").and_then(|v| v.as_str()),
            Some("open")
        );
        assert_eq!(
            normalized.get("requireMention").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("webhookPath").and_then(|v| v.as_str()),
            Some("/slack/events")
        );
        assert_eq!(
            normalized
                .get("userTokenReadOnly")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn normalize_channel_form_avoids_unsupported_top_level_require_mention() {
        let form = json!({
            "account": "+15551234567",
            "dmPolicy": "deny",
            "groupPolicy": "mentioned"
        });
        let normalized =
            normalize_messaging_platform_form("signal", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("disabled")
        );
        assert_eq!(
            normalized.get("groupPolicy").and_then(|v| v.as_str()),
            Some("open")
        );
        assert!(!normalized.contains_key("requireMention"));
    }

    #[test]
    fn normalize_channel_form_adds_feishu_required_defaults() {
        let form = json!({
            "appId": "cli_a",
            "appSecret": "secret",
            "domain": ""
        });
        let normalized =
            normalize_messaging_platform_form("feishu", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("domain").and_then(|v| v.as_str()),
            Some("feishu")
        );
        assert_eq!(
            normalized.get("connectionMode").and_then(|v| v.as_str()),
            Some("websocket")
        );
        assert_eq!(
            normalized.get("webhookPath").and_then(|v| v.as_str()),
            Some("/feishu/events")
        );
        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("pairing")
        );
        assert_eq!(
            normalized.get("groupPolicy").and_then(|v| v.as_str()),
            Some("allowlist")
        );
        assert_eq!(
            normalized
                .get("reactionNotifications")
                .and_then(|v| v.as_str()),
            Some("off")
        );
        assert_eq!(
            normalized.get("typingIndicator").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("resolveSenderNames")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn normalize_imessage_form_preserves_bridge_runtime_fields() {
        let form = json!({
            "dmPolicy": "allowlist",
            "allowFrom": "+15551234567, +15557654321",
            "groupPolicy": "allowlist",
            "groupAllowFrom": "chat-guid-1, chat-guid-2",
            "probeTimeoutMs": "5000",
            "attachmentRoots": "/Users/me/Downloads, /tmp/imessage",
            "includeAttachments": "true",
            "sendReadReceipts": "false"
        });
        let normalized =
            normalize_messaging_platform_form("imessage", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("allowlist")
        );
        assert_eq!(
            normalized.get("probeTimeoutMs").and_then(|v| v.as_f64()),
            Some(5000.0)
        );
        assert_eq!(
            normalized
                .get("includeAttachments")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("sendReadReceipts").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            normalized
                .get("attachmentRoots")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready("imessage", &normalized));
        let diagnosis =
            build_openclaw_channel_diagnosis("imessage", None, true, true, &normalized, None, None);
        assert_eq!(
            diagnosis
                .get("checks")
                .and_then(|v| v.as_array())
                .and_then(|items| items
                    .iter()
                    .find(|item| item.get("id").and_then(|v| v.as_str()) == Some("credentials")))
                .and_then(|item| item.get("title"))
                .and_then(|v| v.as_str()),
            Some("桥接运行配置")
        );
    }

    #[test]
    fn normalize_whatsapp_form_preserves_scan_runtime_fields() {
        let form = json!({
            "enabled": "true",
            "configWrites": "true",
            "sendReadReceipts": "false",
            "selfChatMode": "true",
            "dmPolicy": "allowlist",
            "allowFrom": "+15551234567, +15557654321",
            "groupPolicy": "allowlist",
            "groupAllowFrom": "120363@g.us, 120364@g.us",
            "debounceMs": "800",
            "mediaMaxMb": "50",
            "ackDirect": "true",
            "ackGroup": "mentions"
        });
        let normalized =
            normalize_messaging_platform_form("whatsapp", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("configWrites").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("sendReadReceipts").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            normalized.get("selfChatMode").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("debounceMs").and_then(|v| v.as_f64()),
            Some(800.0)
        );
        assert_eq!(
            normalized.get("mediaMaxMb").and_then(|v| v.as_f64()),
            Some(50.0)
        );
        assert_eq!(
            normalized.get("ackDirect").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("groupAllowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready("whatsapp", &normalized));
        let diagnosis =
            build_openclaw_channel_diagnosis("whatsapp", None, true, true, &normalized, None, None);
        assert_eq!(
            diagnosis
                .get("checks")
                .and_then(|v| v.as_array())
                .and_then(|items| items
                    .iter()
                    .find(|item| item.get("id").and_then(|v| v.as_str()) == Some("credentials")))
                .and_then(|item| item.get("title"))
                .and_then(|v| v.as_str()),
            Some("扫码/会话配置")
        );
    }

    #[test]
    fn normalize_clickclack_form_preserves_workspace_runtime_fields() {
        let form = json!({
            "enabled": "true",
            "baseUrl": "https://clickclack.example.com",
            "token": "clickclack-token",
            "workspace": "ops",
            "replyMode": "model",
            "timeoutSeconds": "120",
            "toolsAllow": "shell, browser.search",
            "senderIsOwner": "true",
            "defaultTo": "channel:ops",
            "allowFrom": "channel:ops, dm:alice",
            "reconnectMs": "2500"
        });
        let normalized =
            normalize_messaging_platform_form("clickclack", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("timeoutSeconds").and_then(|v| v.as_f64()),
            Some(120.0)
        );
        assert_eq!(
            normalized.get("reconnectMs").and_then(|v| v.as_f64()),
            Some(2500.0)
        );
        assert_eq!(
            normalized.get("senderIsOwner").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("toolsAllow")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready(
            "clickclack",
            &normalized
        ));

        let missing_workspace = json!({
            "baseUrl": "https://clickclack.example.com",
            "token": "clickclack-token"
        });
        let missing = normalize_messaging_platform_form(
            "clickclack",
            missing_workspace.as_object().expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready("clickclack", &missing));
        let diagnosis =
            build_openclaw_channel_diagnosis("clickclack", None, true, true, &missing, None, None);
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Workspace"));
    }

    #[test]
    fn normalize_nextcloud_talk_form_preserves_self_hosted_runtime_fields() {
        let form = json!({
            "enabled": "true",
            "baseUrl": "https://cloud.example.com",
            "botSecret": "bot-secret",
            "apiUser": "openclaw-bot",
            "apiPassword": "app-password",
            "webhookPort": "8788",
            "webhookHost": "0.0.0.0",
            "webhookPath": "/nextcloud-talk-webhook",
            "webhookPublicUrl": "https://panel.example.com/nextcloud-talk-webhook",
            "dmPolicy": "allowlist",
            "allowFrom": "alice, bob",
            "groupPolicy": "mentioned",
            "groupAllowFrom": "room-token-1, room-token-2",
            "historyLimit": "80",
            "dmHistoryLimit": "20",
            "mediaMaxMb": "50",
            "textChunkLimit": "4000",
            "chunkMode": "newline",
            "blockStreaming": "true",
            "dangerouslyAllowPrivateNetwork": "true"
        });
        let normalized =
            normalize_messaging_platform_form("nextcloud-talk", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("webhookPort").and_then(|v| v.as_f64()),
            Some(8788.0)
        );
        assert_eq!(
            normalized.get("historyLimit").and_then(|v| v.as_f64()),
            Some(80.0)
        );
        assert_eq!(
            normalized.get("blockStreaming").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("dangerouslyAllowPrivateNetwork")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("groupPolicy").and_then(|v| v.as_str()),
            Some("open")
        );
        assert_eq!(
            normalized.get("requireMention").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("groupAllowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready(
            "nextcloud-talk",
            &normalized
        ));

        let missing_secret = json!({
            "baseUrl": "https://cloud.example.com"
        });
        let missing = normalize_messaging_platform_form(
            "nextcloud-talk",
            missing_secret.as_object().expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready(
            "nextcloud-talk",
            &missing
        ));
        let diagnosis = build_openclaw_channel_diagnosis(
            "nextcloud-talk",
            None,
            true,
            true,
            &missing,
            None,
            None,
        );
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Bot Secret 或 Secret File"));
    }

    #[test]
    fn normalize_twitch_form_preserves_chat_runtime_fields() {
        let form = json!({
            "enabled": "true",
            "username": "openclaw",
            "accessToken": "oauth:abc123",
            "clientId": "client-123",
            "channel": "openclaw",
            "allowFrom": "123456, 789012",
            "allowedRoles": "moderator, vip",
            "requireMention": "true",
            "responsePrefix": "[AI]",
            "clientSecret": "client-secret",
            "refreshToken": "refresh-token",
            "expiresIn": "3600",
            "obtainmentTimestamp": "1779490000"
        });
        let normalized =
            normalize_messaging_platform_form("twitch", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("allowedRoles")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized.get("requireMention").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("expiresIn").and_then(|v| v.as_f64()),
            Some(3600.0)
        );
        assert_eq!(
            normalized
                .get("obtainmentTimestamp")
                .and_then(|v| v.as_f64()),
            Some(1779490000.0)
        );
        assert!(channel_diagnosis_credentials_ready("twitch", &normalized));

        let missing = normalize_messaging_platform_form(
            "twitch",
            json!({
                "username": "openclaw",
                "clientId": "client-123",
                "channel": "openclaw"
            })
            .as_object()
            .expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready("twitch", &missing));
        let diagnosis =
            build_openclaw_channel_diagnosis("twitch", None, true, true, &missing, None, None);
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Access Token"));
    }

    #[test]
    fn normalize_nostr_form_preserves_relay_access_and_profile_fields() {
        let form = json!({
            "enabled": "true",
            "name": "nostr-bot",
            "defaultAccount": "default",
            "privateKey": "nsec1example",
            "relays": "wss://relay.damus.io, wss://nos.lol",
            "dmPolicy": "allowlist",
            "allowFrom": "npub1sender, 0123456789abcdef",
            "profileName": "openclaw",
            "profileDisplayName": "OpenClaw Bot",
            "profileAbout": "Nostr DM assistant",
            "profilePicture": "https://example.com/avatar.png",
            "profileWebsite": "https://example.com",
            "profileNip05": "openclaw@example.com",
            "profileLud16": "openclaw@example.com"
        });
        let normalized =
            normalize_messaging_platform_form("nostr", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("dmPolicy").and_then(|v| v.as_str()),
            Some("allowlist")
        );
        assert_eq!(
            normalized
                .get("relays")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("allowFrom")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready("nostr", &normalized));

        let missing = normalize_messaging_platform_form(
            "nostr",
            json!({
                "relays": "wss://relay.damus.io"
            })
            .as_object()
            .expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready("nostr", &missing));
        let diagnosis =
            build_openclaw_channel_diagnosis("nostr", None, true, true, &missing, None, None);
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Private Key"));
    }

    #[test]
    fn normalize_irc_form_preserves_server_nickserv_and_group_fields() {
        let form = json!({
            "enabled": "true",
            "host": "irc.libera.chat",
            "port": "6697",
            "tls": "true",
            "nick": "openclaw-bot",
            "username": "openclaw",
            "realname": "OpenClaw Bot",
            "passwordFile": "/run/secrets/irc-password",
            "nickservEnabled": "true",
            "nickservService": "NickServ",
            "nickservPasswordFile": "/run/secrets/irc-nickserv",
            "nickservRegister": "false",
            "channels": "#openclaw, #ops",
            "dmPolicy": "allowlist",
            "allowFrom": "alice!ident@example.org, bob",
            "groupPolicy": "allowlist",
            "groups": "#openclaw, #ops",
            "groupAllowFrom": "alice!ident@example.org",
            "requireMention": "false",
            "mentionPatterns": "openclaw:, @openclaw",
            "historyLimit": "80",
            "dmHistoryLimit": "20",
            "mediaMaxMb": "25",
            "textChunkLimit": "350",
            "blockStreaming": "true",
            "dangerouslyAllowNameMatching": "true"
        });
        let normalized =
            normalize_messaging_platform_form("irc", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("port").and_then(|v| v.as_f64()),
            Some(6697.0)
        );
        assert_eq!(normalized.get("tls").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            normalized
                .get("channels")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("groups")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized.get("requireMention").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            normalized.get("nickservEnabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized.get("nickservRegister").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            normalized
                .get("mentionPatterns")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert!(channel_diagnosis_credentials_ready("irc", &normalized));

        let groups = build_irc_groups_from_form(&normalized).expect("groups");
        assert_eq!(
            groups
                .get("#openclaw")
                .and_then(|group| group.get("requireMention"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );

        let missing = normalize_messaging_platform_form(
            "irc",
            json!({
                "host": "irc.libera.chat"
            })
            .as_object()
            .expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready("irc", &missing));
        let diagnosis =
            build_openclaw_channel_diagnosis("irc", None, true, true, &missing, None, None);
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Nick"));
    }

    #[test]
    fn verify_irc_token_returns_probe_guidance_warning() {
        let result = tauri::async_runtime::block_on(verify_bot_token(
            "irc".to_string(),
            json!({
                "host": "irc.libera.chat",
                "nick": "openclaw-bot"
            }),
        ))
        .expect("verify result");

        assert_eq!(result.get("valid").and_then(|v| v.as_bool()), Some(true));
        assert!(result
            .get("warnings")
            .and_then(|v| v.as_array())
            .and_then(|items| items.first())
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("IRC 面板已完成基础字段校验"));
    }

    #[test]
    fn normalize_tlon_form_preserves_ship_login_and_invite_fields() {
        let form = json!({
            "enabled": "true",
            "name": "Main Ship",
            "ship": "~sampel-palnet",
            "url": "https://urbit.example.com",
            "code": "lidlut-tabwed-pillex-ridrup",
            "dangerouslyAllowPrivateNetwork": "true",
            "groupChannels": "chat/~host-ship/general, chat/~host-ship/support",
            "dmAllowlist": "zod, ~nec",
            "groupInviteAllowlist": "~bus",
            "autoDiscoverChannels": "true",
            "showModelSignature": "false",
            "responsePrefix": "[Tlon]",
            "autoAcceptDmInvites": "true",
            "autoAcceptGroupInvites": "false",
            "ownerShip": "~sampel-palnet",
            "defaultAuthorizedShips": "~zod, ~nec"
        });
        let normalized =
            normalize_messaging_platform_form("tlon", form.as_object().expect("object"));

        assert_eq!(
            normalized.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("dangerouslyAllowPrivateNetwork")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("groupChannels")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("dmAllowlist")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("groupInviteAllowlist")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(1)
        );
        assert_eq!(
            normalized
                .get("defaultAuthorizedShips")
                .and_then(|v| v.as_array())
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            normalized
                .get("autoDiscoverChannels")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("showModelSignature")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            normalized
                .get("autoAcceptDmInvites")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            normalized
                .get("autoAcceptGroupInvites")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert!(channel_diagnosis_credentials_ready("tlon", &normalized));

        let missing = normalize_messaging_platform_form(
            "tlon",
            json!({
                "ship": "~sampel-palnet",
                "url": "https://urbit.example.com"
            })
            .as_object()
            .expect("object"),
        );
        assert!(!channel_diagnosis_credentials_ready("tlon", &missing));
        let diagnosis =
            build_openclaw_channel_diagnosis("tlon", None, true, true, &missing, None, None);
        assert!(diagnosis
            .get("checks")
            .and_then(|v| v.as_array())
            .and_then(|items| items
                .iter()
                .find(|item| { item.get("id").and_then(|v| v.as_str()) == Some("credentials") }))
            .and_then(|item| item.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Code"));
    }

    #[test]
    fn verify_tlon_token_returns_probe_guidance_warning() {
        let result = tauri::async_runtime::block_on(verify_bot_token(
            "tlon".to_string(),
            json!({
                "ship": "~sampel-palnet",
                "url": "https://urbit.example.com",
                "code": "lidlut-tabwed-pillex-ridrup"
            }),
        ))
        .expect("verify result");

        assert_eq!(result.get("valid").and_then(|v| v.as_bool()), Some(true));
        assert!(result
            .get("warnings")
            .and_then(|v| v.as_array())
            .and_then(|items| items.first())
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Tlon 面板已完成基础字段校验"));
    }

    #[test]
    fn channel_form_readback_preserves_mention_policy_choice() {
        let saved = json!({
            "groupPolicy": "open",
            "requireMention": true,
            "allowFrom": ["U123"]
        });
        let mut form = Map::new();
        insert_access_policy_form_values(&mut form, &saved, false, true);

        assert_eq!(
            form.get("groupPolicy").and_then(|v| v.as_str()),
            Some("mentioned")
        );
        assert_eq!(form.get("allowFrom").and_then(|v| v.as_str()), Some("U123"));
    }

    #[test]
    fn channel_form_readback_masks_secret_refs() {
        let saved = json!({
            "botToken": {
                "source": "env",
                "provider": "default",
                "id": "TELEGRAM_BOT_TOKEN"
            }
        });
        let mut form = Map::new();
        insert_secret_aware_form_value(&mut form, &saved, "botToken");

        assert_eq!(
            form.get("botToken").and_then(|v| v.as_str()),
            Some("SecretRef(env:default:TELEGRAM_BOT_TOKEN)")
        );
        assert_eq!(
            form.get("__secretRefs")
                .and_then(|v| v.get("botToken"))
                .cloned(),
            saved.get("botToken").cloned()
        );
    }

    #[test]
    fn channel_save_preserves_unchanged_secret_ref_placeholder() {
        let current = json!({
            "botToken": {
                "source": "env",
                "provider": "default",
                "id": "SLACK_BOT_TOKEN"
            }
        });
        let form = json!({
            "botToken": "SecretRef(env:default:SLACK_BOT_TOKEN)"
        });
        let value = resolve_messaging_credential_value_for_save(
            form.as_object().expect("object"),
            &current,
            "botToken",
        );

        assert_eq!(value, current.get("botToken").cloned());
    }

    #[test]
    fn channel_save_replaces_secret_ref_when_user_enters_new_secret() {
        let current = json!({
            "token": {
                "source": "env",
                "provider": "default",
                "id": "DISCORD_BOT_TOKEN"
            }
        });
        let form = json!({
            "token": "new-discord-token"
        });
        let value = resolve_messaging_credential_value_for_save(
            form.as_object().expect("object"),
            &current,
            "token",
        );

        assert_eq!(value, Some(Value::String("new-discord-token".into())));
    }

    #[test]
    fn messaging_credential_detection_accepts_non_app_id_channels() {
        for account in [
            json!({ "botToken": "telegram-token" }),
            json!({ "token": "discord-token" }),
            json!({ "botToken": "xoxb-token", "appToken": "xapp-token" }),
            json!({ "clientId": "teams-client-id" }),
        ] {
            assert!(value_has_messaging_credential(&account));
        }

        assert!(!value_has_messaging_credential(&json!({
            "enabled": true,
            "dmPolicy": "pairing"
        })));
    }

    #[test]
    fn messaging_credential_detection_accepts_secret_refs() {
        let account = json!({
            "token": {
                "source": "env",
                "provider": "default",
                "id": "DISCORD_BOT_TOKEN"
            }
        });

        assert!(value_has_messaging_credential(&account));
    }

    #[test]
    fn qqbot_account_merge_preserves_cli_custom_fields() {
        let mut channels_map = Map::new();
        channels_map.insert(
            "qqbot".into(),
            json!({
                "enabled": true,
                "accounts": {
                    "mybot": {
                        "appId": "aid",
                        "clientSecret": "sec",
                        "token": "aid:sec",
                        "enabled": true,
                        "dmPolicy": "pairing",
                        "groupPolicy": "allowlist"
                    }
                }
            }),
        );
        let current = channels_map
            .get("qqbot")
            .and_then(|v| v.get("accounts"))
            .and_then(|a| a.get("mybot"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut entry = Map::new();
        entry.insert("appId".into(), Value::String("aid".into()));
        entry.insert("clientSecret".into(), Value::String("sec".into()));
        entry.insert("enabled".into(), Value::Bool(true));
        entry.insert("token".into(), Value::String("aid:sec".into()));
        preserve_messaging_credential_refs(&mut entry, &Map::new(), &current);
        merge_account_channel_entry(&mut channels_map, "qqbot", "mybot", entry).expect("merge");

        let saved = channels_map
            .get("qqbot")
            .and_then(|v| v.get("accounts"))
            .and_then(|a| a.get("mybot"))
            .expect("account");
        assert_eq!(saved.get("dmPolicy").and_then(|v| v.as_str()), Some("pairing"));
        assert_eq!(
            saved.get("groupPolicy").and_then(|v| v.as_str()),
            Some("allowlist")
        );
    }

    #[test]
    fn qqbot_save_preserves_unchanged_client_secret_secret_ref() {
        let current = json!({
            "appId": "aid",
            "clientSecret": {
                "source": "env",
                "provider": "default",
                "id": "QQBOT_CLIENT_SECRET"
            },
            "token": "aid:placeholder"
        });
        let form = json!({
            "appId": "aid",
            "clientSecret": "SecretRef(env:default:QQBOT_CLIENT_SECRET)"
        });
        let mut entry = Map::new();
        entry.insert("appId".into(), Value::String("aid".into()));
        entry.insert(
            "clientSecret".into(),
            Value::String("SecretRef(env:default:QQBOT_CLIENT_SECRET)".into()),
        );
        preserve_messaging_credential_refs(
            &mut entry,
            form.as_object().expect("object"),
            &current,
        );

        assert_eq!(entry.get("clientSecret"), current.get("clientSecret"));
    }
}
