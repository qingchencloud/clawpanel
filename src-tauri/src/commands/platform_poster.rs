//! 本人邀请海报：固定只读资源、业务白名单、保存前重新核对和身份锁。
use super::{identity, Platform, Value};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const VIEW_PATH: &str = "/api/v1/member/invitation-poster";
const QR_PATH: &str = "/api/v1/member/invitation-poster/qr.png";
const MAX_PNG: usize = 8 * 1024 * 1024;

fn status(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| ["active", "not_open", "upcoming", "ended", "unavailable"].contains(s))
}

fn amount(value: &Value) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    let s = value.as_str()?;
    if s.is_empty()
        || s.len() > 13
        || !s.bytes().all(|c| c.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
        || s.parse::<u64>().ok()? > 1_000_000_000_000
    {
        return None;
    }
    Some(json!(s))
}

fn integer(value: &Value, min: u64, max: u64) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    value
        .as_u64()
        .filter(|n| (min..=max).contains(n))
        .map(|n| json!(n))
}

fn text(value: &Value, max: usize) -> Option<Value> {
    let s = value.as_str()?;
    (s.chars().count() <= max && !s.chars().any(char::is_control)).then(|| json!(s))
}

fn timestamp(value: &Value) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    let s = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok()?;
    Some(json!(s))
}

fn benefit(value: &Value, referral: bool) -> Option<Value> {
    let mut out =
        json!({"available":value["available"].as_bool()?,"status":status(&value["status"])?});
    out["valid_hours"] = integer(&value["valid_hours"], 1, 8760)?;
    if !referral {
        out["amount_micro_cny"] = amount(&value["amount_micro_cny"])?;
        if out["available"] == true
            && (out["amount_micro_cny"].is_null() || out["valid_hours"].is_null())
        {
            return None;
        }
        return Some(out);
    }
    for key in ["campaign_id", "rules_version"] {
        out[key] = if value[key].is_null() {
            Value::Null
        } else {
            text(&value[key], 128)?
        };
    }
    for key in ["starts_at", "ends_at"] {
        out[key] = timestamp(&value[key])?;
    }
    for key in ["inviter_amount_micro_cny", "invitee_amount_micro_cny"] {
        out[key] = amount(&value[key])?;
    }
    for (key, min, max) in [
        ("qualification_days", 1, 365),
        ("successful_requests_required", 1, 10000),
        ("distinct_utc_dates_required", 1, 365),
        ("observation_seconds", 0, 2592000),
        ("per_member_daily_referral_limit", 0, 1000000),
    ] {
        out[key] = integer(&value[key], min, max)?;
    }
    out["reward_expiry_from_issuance"] = if value["reward_expiry_from_issuance"].is_null() {
        Value::Null
    } else {
        json!(value["reward_expiry_from_issuance"].as_bool()?)
    };
    if out["available"] == true
        && ([
            "campaign_id",
            "rules_version",
            "starts_at",
            "ends_at",
            "inviter_amount_micro_cny",
            "invitee_amount_micro_cny",
            "valid_hours",
            "qualification_days",
            "successful_requests_required",
            "distinct_utc_dates_required",
            "observation_seconds",
        ]
        .iter()
        .any(|k| out[*k].is_null())
            || out["status"] != "active")
    {
        return None;
    }
    Some(out)
}

fn project(value: &Value, origin: &str) -> Option<Value> {
    let promotion = &value["promotion"];
    let mut copy = json!({});
    for (key, limit) in [
        ("title_zh", 80),
        ("subtitle_zh", 240),
        ("title_en", 80),
        ("subtitle_en", 240),
    ] {
        copy[key] = text(&promotion["copy"][key], limit)?;
    }
    let mut view = json!({"available":value["available"].as_bool()?,"status":status(&value["status"])?,
        "server_time":timestamp(&value["server_time"])? ,"invite_code":null,"invite_url":null,"qr_url":null,
        "promotion":{"status":status(&promotion["status"])?,"copy":copy,
            "registration":benefit(&promotion["registration"],false)?,"referral":benefit(&promotion["referral"],true)?}});
    if !value["invite_code"].is_null() || !value["invite_url"].is_null() {
        let code = value["invite_code"].as_str()?;
        if !(6..=64).contains(&code.len())
            || !code
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return None;
        }
        let expected = format!("{origin}/member?invite={code}");
        // 精确规范URL同时拒绝编码路径、重复参数、userinfo、fragment和跨origin。
        if value["invite_url"].as_str()? != expected || value["qr_url"].as_str()? != QR_PATH {
            return None;
        }
        view["invite_code"] = json!(code);
        view["invite_url"] = json!(expected);
        view["qr_url"] = json!(QR_PATH);
    }
    if view["available"] == true
        && (view["status"] != "active"
            || view["invite_url"].is_null()
            || view["promotion"]["referral"]["available"] != true)
    {
        return None;
    }
    Some(view)
}

fn unavailable() -> Value {
    let benefit = json!({"available":false,"status":"unavailable","amount_micro_cny":null,"valid_hours":null});
    json!({"available":false,"status":"unavailable","server_time":chrono::Utc::now().to_rfc3339(),"invite_code":null,"invite_url":null,"qr_url":null,
        "promotion":{"status":"unavailable","copy":{"title_zh":"","subtitle_zh":"","title_en":"","subtitle_en":""},"registration":benefit,
        "referral":{"available":false,"status":"unavailable","campaign_id":null,"rules_version":null,"starts_at":null,"ends_at":null,"inviter_amount_micro_cny":null,"invitee_amount_micro_cny":null,"valid_hours":null,"qualification_days":null,"successful_requests_required":null,"distinct_utc_dates_required":null,"observation_seconds":null,"per_member_daily_referral_limit":null,"reward_expiry_from_issuance":null}}})
}

fn png(bytes: &[u8], width: u32, height: u32, max: usize) -> bool {
    if bytes.len() > max
        || bytes.len() < 45
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[8..16] != b"\0\0\0\rIHDR"
        || bytes[16..20] != width.to_be_bytes()
        || bytes[20..24] != height.to_be_bytes()
    {
        return false;
    }
    // 要求完整块边界和终结块；先检查头部尺寸，避免恶意大图分配。
    let mut at = 8usize;
    let mut ended = false;
    while at.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let Some(end) = at
            .checked_add(12)
            .and_then(|n| n.checked_add(len))
            .filter(|end| *end <= bytes.len())
        else {
            return false;
        };
        if &bytes[at + 4..at + 8] == b"IEND" {
            ended = len == 0 && end == bytes.len();
            break;
        }
        at = end;
    }
    ended
        && tauri::image::Image::from_bytes(bytes).is_ok_and(|image| {
            image.width() == width
                && image.height() == height
                && image.rgba().len() == width as usize * height as usize * 4
        })
}

fn safe_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("platform_poster_save_unavailable".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("platform_poster_save_unavailable".into());
        }
        current.push(part.as_os_str());
        if !current.exists() {
            fs::create_dir(&current).map_err(|_| "platform_poster_save_unavailable")?;
        }
        let meta =
            fs::symlink_metadata(&current).map_err(|_| "platform_poster_save_unavailable")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("platform_poster_save_unavailable".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("platform_poster_save_unavailable".into());
            }
        }
    }
    Ok(())
}

impl Platform {
    async fn poster_identity(&self) -> Result<(u64, String), String> {
        let state = self.state.lock().await;
        if state.vault.as_ref().is_none_or(|v| v.credential.is_none()) {
            return Err("platform_login_required".into());
        }
        let member = state.member["member_id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("platform_login_required")?;
        Ok((state.epoch, member.to_string()))
    }

    fn poster_bundle(&self, epoch: u64, member: &str, view: Value, qr: Option<Vec<u8>>) -> Value {
        let mut normalized = view.clone();
        normalized.as_object_mut().unwrap().remove("server_time");
        let qr_digest = qr.as_ref().map(identity::digest);
        let revision = identity::digest(
            serde_json::to_vec(
                &json!({"epoch":epoch,"member":member,"view":normalized,"qr":qr_digest}),
            )
            .unwrap(),
        );
        json!({"epoch":epoch,"memberId":member,"origin":self.transport.origin,"revision":revision,"view":view,
            "qrDataUrl":qr.map(|bytes| format!("data:image/png;base64,{}",STANDARD.encode(bytes)))})
    }

    pub(super) async fn read_invitation_poster(&self) -> Result<Value, String> {
        let (epoch, member) = self.poster_identity().await?;
        let read = async {
            let wire = self
                .resource_response(epoch, Method::GET, VIEW_PATH, &[], None)
                .await?;
            if !(200..300).contains(&wire.status) {
                return Err(wire
                    .error
                    .unwrap_or_else(|| "platform_poster_unavailable".into()));
            }
            let body = identity::bounded_body(
                wire.response.ok_or("platform_poster_unavailable")?,
                64 * 1024,
            )
            .await?;
            let raw: Value =
                serde_json::from_slice(&body).map_err(|_| "platform_poster_unavailable")?;
            let view =
                project(&raw, &self.transport.origin).ok_or("platform_poster_unavailable")?;
            let qr = if view["available"] == true {
                let wire = self
                    .resource_response(epoch, Method::GET, QR_PATH, &[], None)
                    .await?;
                if wire.status != 200 {
                    return Err(wire
                        .error
                        .unwrap_or_else(|| "platform_poster_unavailable".into()));
                }
                if wire
                    .headers
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .is_none_or(|v| v.split(';').next().unwrap_or("").trim() != "image/png")
                {
                    return Err("platform_poster_unavailable".into());
                }
                let bytes = identity::bounded_body(
                    wire.response.ok_or("platform_poster_unavailable")?,
                    1024 * 1024,
                )
                .await?;
                if !png(&bytes, 512, 512, 1024 * 1024) {
                    return Err("platform_poster_unavailable".into());
                }
                Some(bytes)
            } else {
                None
            };
            Ok::<_, String>((view, qr))
        };
        let (view, qr) = match tokio::time::timeout(Duration::from_secs(15), read).await {
            Ok(Ok(value)) => value,
            Ok(Err(error))
                if matches!(
                    error.as_str(),
                    "invalid_token"
                        | "insufficient_scope"
                        | "platform_account_changed"
                        | "platform_login_required"
                        | "platform_reauthorization_required"
                ) || error.starts_with("platform_storage")
                    || error == "platform_key_unavailable" =>
            {
                return Err(error)
            }
            _ => (unavailable(), None),
        };
        let current = self.poster_identity().await?;
        if current != (epoch, member.clone()) {
            return Err("platform_account_changed".into());
        }
        Ok(self.poster_bundle(epoch, &member, view, qr))
    }

    pub(super) async fn save_invitation_poster(&self, args: Value) -> Result<Value, String> {
        let epoch = args["epoch"].as_u64().ok_or("invalid_platform_arguments")?;
        let member = args["memberId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("invalid_platform_arguments")?;
        let revision = args["revision"]
            .as_str()
            .filter(|s| {
                s.len() == 43
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
            })
            .ok_or("invalid_platform_arguments")?;
        let template = args["template"]
            .as_str()
            .filter(|s| ["warm", "dark", "paper"].contains(s))
            .ok_or("invalid_platform_arguments")?;
        let language = args["language"]
            .as_str()
            .filter(|s| ["zh", "en"].contains(s))
            .ok_or("invalid_platform_arguments")?;
        let encoded = args["pngBase64"]
            .as_str()
            .filter(|s| s.len() <= MAX_PNG.div_ceil(3) * 4)
            .ok_or("platform_poster_png_invalid")?;
        if self.poster_identity().await? != (epoch, member.into()) {
            return Err("platform_account_changed".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "platform_poster_png_invalid")?;
        if STANDARD.encode(&bytes) != encoded || !png(&bytes, 1080, 1440, MAX_PNG) {
            return Err("platform_poster_png_invalid".into());
        }
        let fresh = self.read_invitation_poster().await?;
        if fresh["epoch"] != epoch || fresh["memberId"] != member {
            return Err("platform_account_changed".into());
        }
        if fresh["revision"] != revision {
            return Ok(json!({"status":"updated","poster":fresh}));
        }
        if fresh["view"]["available"] != true {
            return Err("platform_poster_unavailable".into());
        }
        let directory = self.poster_save_directory()?;
        // 身份锁持续到本地create_new写入结束，切号和退出不能与最终落盘交错。
        let state = self.state.lock().await;
        if state.epoch != epoch
            || state.member["member_id"] != member
            || state.vault.as_ref().is_none_or(|v| v.credential.is_none())
        {
            return Err("platform_account_changed".into());
        }
        safe_directory(&directory)?;
        let path = directory.join(format!(
            "ClawPanel-invitation-{template}-{language}-{}.png",
            identity::random_id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "platform_poster_save_unavailable")?;
        if file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .is_err()
        {
            drop(file);
            // 仅此分支刚由create_new成功创建的随机路径可回收，既存文件绝不删除。
            let _ = fs::remove_file(&path);
            return Err("platform_poster_save_unavailable".into());
        }
        Ok(json!({"status":"saved","path":path.to_string_lossy()}))
    }

    fn poster_save_directory(&self) -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        if let Some(value) = std::env::var_os("CLAWPANEL_PLATFORM_POSTER_SAVE_DIR") {
            let path = PathBuf::from(value);
            if !identity::isolated_debug_enabled()
                || !path.is_absolute()
                || path == self.dir
                || !path.starts_with(&self.dir)
                || path
                    .components()
                    .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
            {
                return Err("platform_poster_save_unavailable".into());
            }
            return Ok(path);
        }
        dirs::download_dir()
            .map(|path| path.join("ClawPanel").join("Invitations"))
            .ok_or_else(|| "platform_poster_save_unavailable".into())
    }
}
