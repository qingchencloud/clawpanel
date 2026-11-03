//! 账户收益只读投影；活动公开规则与本人冻结资格分别保留。
use super::{Platform, Value};
use reqwest::Method;
use serde_json::json;
use std::time::Duration;

fn unavailable_offer() -> Value {
    json!({"status":"unavailable","registration_rewards_enabled":false,"simulation":false,"offer":null,"server_time":null})
}

fn registration_offer(value: &Value) -> Option<Value> {
    let status = value["status"].as_str()?;
    if !["offered", "not_open", "unavailable"].contains(&status) {
        return None;
    }
    let enabled = value["registration_rewards_enabled"].as_bool()?;
    let simulation = value["simulation"].as_bool()?;
    let server_time = value["server_time"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(server_time).ok()?;
    let mut result = json!({"status":status,"registration_rewards_enabled":enabled,"simulation":simulation,"offer":null,"server_time":server_time});
    if status != "offered" {
        return value["offer"].is_null().then_some(result);
    }
    if !simulation && !enabled {
        return None;
    }
    let offer = &value["offer"];
    let amount = offer["amount_micro_cny"].as_str()?;
    if amount.is_empty() || amount.len() > 13 || !amount.bytes().all(|v| v.is_ascii_digit()) {
        return None;
    }
    if !(1..=1_000_000_000_000_u64).contains(&amount.parse::<u64>().ok()?) {
        return None;
    }
    // 小时字段存在时必须有效；不能用兼容天数掩盖错误的小时政策。
    let hours = match offer.get("valid_hours") {
        Some(value) => {
            let hours = value.as_u64()?;
            if !(1..=720).contains(&hours) {
                return None;
            }
            Some(hours)
        }
        None => None,
    };
    let days = if let Some(hours) = hours {
        hours.div_ceil(24)
    } else {
        let days = offer["valid_days"].as_u64()?;
        if !(1..=30).contains(&days) {
            return None;
        }
        days
    };
    let source_models = offer["models"].as_array()?;
    if source_models.is_empty() || source_models.len() > 64 {
        return None;
    }
    let mut models = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for model in source_models {
        let id = model["id"].as_str()?;
        let suffix = id.strip_prefix("official/")?;
        if suffix.is_empty()
            || suffix.len() > 64
            || !suffix
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || matches!(v, b'_' | b'-'))
            || !suffix.as_bytes()[0].is_ascii_alphanumeric()
            || !ids.insert(id)
        {
            return None;
        }
        let name = model["display_name"].as_str()?;
        if name.trim().is_empty()
            || name.chars().count() > 128
            || name.chars().any(char::is_control)
        {
            return None;
        }
        models.push(json!({"id":id,"display_name":name}));
    }
    result["offer"] = json!({"amount_micro_cny":amount,"valid_days":days,"models":models});
    if let Some(hours) = hours {
        result["offer"]["valid_hours"] = json!(hours);
    }
    Some(result)
}

fn invitation_link(value: &Value, origin: &str) -> Option<(String, String)> {
    let code = value["invite_code"].as_str()?;
    if !(6..=64).contains(&code.len())
        || !code
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'_' | b'-'))
    {
        return None;
    }
    let raw = value["invite_url"].as_str()?;
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    // 只接受服务端现有ASCII邀请码的规范分享形态，拒绝多重编码或别名参数。
    if url.origin().ascii_serialization() != origin
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != "/member"
        || url.query()? != format!("invite={code}")
    {
        return None;
    }
    Some((code.into(), url.to_string()))
}

const RULE_FIELDS: &[&str] = &[
    "campaign_id",
    "rules_version",
    "status",
    "simulation",
    "reward_delivery_enabled",
    "starts_at",
    "ends_at",
    "newcomer_credits",
    "newcomer_valid_days",
    "inviter_credits",
    "invitee_credits",
    "referral_valid_days",
    "reward_expiry_from_issuance",
    "per_member_daily_referral_limit",
    "qualification_days",
    "successful_requests_required",
    "distinct_utc_dates_required",
    "observation_seconds",
];
const REQUIREMENT_FIELDS: &[&str] = &[
    "qualification_days",
    "successful_requests_required",
    "distinct_utc_dates_required",
    "observation_seconds",
];

fn public_fields(value: &Value, fields: &[&str]) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    let mut result = serde_json::Map::new();
    for field in fields {
        if let Some(value) = value.get(*field) {
            // 不透传嵌套对象、列表或服务端未来扩展字段。
            if value.is_null()
                || value.is_boolean()
                || value.is_i64()
                || value.is_u64()
                || value
                    .as_str()
                    .is_some_and(|text| text.len() <= 512 && !text.chars().any(char::is_control))
            {
                result.insert((*field).to_string(), value.clone());
            }
        }
    }
    Value::Object(result)
}

fn invitation_copy(value: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for (field, limit) in [
        ("title_zh", 80),
        ("subtitle_zh", 240),
        ("title_en", 80),
        ("subtitle_en", 240),
    ] {
        let Some(text) = value[field].as_str() else {
            return Value::Null;
        };
        if text.chars().count() > limit || text.chars().any(char::is_control) {
            return Value::Null;
        }
        result.insert(field.into(), Value::String(text.to_string()));
    }
    Value::Object(result)
}

pub(super) fn referrals(value: &Value, origin: &str) -> Value {
    let mut result = public_fields(
        value,
        &[
            "simulation",
            "reward_delivery_enabled",
            "confirmed_count",
            "qualified_count",
            "rewarded_count",
            "rewarded_micro_cny",
        ],
    );
    if !result.is_object() || !value["participation"].is_object() {
        return Value::Null;
    }
    let source = &value["participation"];
    let mut participation = public_fields(
        source,
        &[
            "campaign_id",
            "rules_version",
            "qualification_status",
            "registered_at",
            "first_bound_at",
            "qualification_deadline_at",
            "observation_ends_at",
            "qualified_at",
            "progress_updated_at",
            "successful_requests",
            "distinct_utc_dates",
        ],
    );
    participation["rules"] = public_fields(&source["rules"], RULE_FIELDS);
    participation["requirements"] = public_fields(&source["requirements"], REQUIREMENT_FIELDS);
    for field in ["newcomer_reward", "invitee_reward"] {
        participation[field] = public_fields(
            &source[field],
            &["status", "amount_micro_cny", "issued_at", "expires_at"],
        );
    }
    result["participation"] = participation;
    result["invite_code"] = Value::Null;
    result["invite_url"] = Value::Null;
    if let Some((code, url)) = invitation_link(value, origin) {
        result["invite_code"] = Value::String(code);
        result["invite_url"] = Value::String(url);
    }
    result
}

impl Platform {
    pub(super) async fn public_benefits(&self) -> Value {
        // 访客读取不接触私钥、凭据或账户状态；所有失败只给保守的可选DTO。
        let read = async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_millis(750))
                .timeout(Duration::from_secs(2))
                .build()
                .ok()?;
            let mut response = client
                .get(format!(
                    "{}/api/v1/registration-offer",
                    self.transport.origin
                ))
                .send()
                .await
                .ok()?;
            if !response.status().is_success()
                || response.content_length().is_some_and(|n| n > 64 * 1024)
            {
                return None;
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if bytes.len() + chunk.len() > 64 * 1024 {
                    return None;
                }
                bytes.extend_from_slice(&chunk);
            }
            registration_offer(&serde_json::from_slice::<Value>(&bytes).ok()?)
        }
        .await
        .unwrap_or_else(unavailable_offer);
        json!({"registrationOffer":read})
    }
    pub(super) async fn read_benefits(&self, epoch: u64) -> Value {
        // 可选只读接口失败不影响已成功读取的钱包；身份失效仍沿用 resource 的关闭行为。
        let campaign = self
            .resource(epoch, Method::GET, "/api/v1/campaigns/current", &[], None)
            .await
            .ok()
            .map(|value| public_fields(&value["campaign"], RULE_FIELDS))
            .unwrap_or(Value::Null);
        let has_scope = {
            let state = self.state.lock().await;
            state.epoch == epoch
                && state
                    .vault
                    .as_ref()
                    .and_then(|vault| vault.credential.as_ref())
                    .is_some_and(|credential| {
                        credential
                            .scope
                            .split_whitespace()
                            .any(|scope| scope == "referrals:read")
                    })
        };
        if !has_scope {
            return json!({"status":"scope_required","currentCampaign":campaign,"referrals":null,"invitationCopy":null});
        }
        let summary = self
            .resource(epoch, Method::GET, "/api/v1/referrals", &[], None)
            .await;
        let copy = self
            .resource(
                epoch,
                Method::GET,
                "/api/v1/member/invitation-copy",
                &[],
                None,
            )
            .await
            .ok()
            .map(|value| invitation_copy(&value))
            .unwrap_or(Value::Null);
        let (status, summary) = match summary {
            Ok(value) => {
                let public = referrals(&value, &self.transport.origin);
                (
                    if public.is_null() {
                        "unavailable"
                    } else {
                        "ready"
                    },
                    public,
                )
            }
            Err(error) => (
                if error == "insufficient_scope" {
                    "scope_required"
                } else {
                    "unavailable"
                },
                Value::Null,
            ),
        };
        json!({"status":status,"currentCampaign":campaign,"referrals":summary,"invitationCopy":copy})
    }
}
