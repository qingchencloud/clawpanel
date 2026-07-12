use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// media-jobs.json 的读改写锁：并发轮询/写入时防止互相覆盖
static MEDIA_JOBS_LOCK: Mutex<()> = Mutex::new(());

fn lock_media_jobs() -> std::sync::MutexGuard<'static, ()> {
    MEDIA_JOBS_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

const PROVIDER_VOLCENGINE: &str = "volcengine";
const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_NEWAPI: &str = "newapi";
const DEFAULT_VOLCENGINE_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_NEWAPI_BASE_URL: &str = "https://your-newapi.example.com/v1";
const MEDIA_CONFIG_FILE: &str = "media-config.json";
const MEDIA_JOBS_FILE: &str = "media-jobs.json";
const MAX_IMAGE_COUNT: u64 = 4;
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
/// 内嵌预览（base64 IPC）上限：超过此大小引导用户打开文件夹本地查看
const MAX_INLINE_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
struct MediaProviderConfig {
    provider: String,
    base_url: String,
    api_key: String,
    image_model: String,
    video_model: String,
    timeout_seconds: u64,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn u64_field(value: &Value, key: &str, default: u64) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(default)
}

fn bool_field(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn default_media_config() -> Value {
    json!({
        "version": 1,
        "outputDir": "",
        "providers": {
            "volcengine": {
                "enabled": false,
                "baseUrl": DEFAULT_VOLCENGINE_BASE_URL,
                "apiKey": "",
                "imageModel": "",
                "videoModel": "",
                "timeoutSeconds": 600
            },
            "openai": {
                "enabled": false,
                "baseUrl": DEFAULT_OPENAI_BASE_URL,
                "apiKey": "",
                "imageModel": "gpt-image-1",
                "videoModel": "sora-2",
                "timeoutSeconds": 600
            },
            "newapi": {
                "enabled": false,
                "baseUrl": DEFAULT_NEWAPI_BASE_URL,
                "apiKey": "",
                "imageModel": "gpt-image-1",
                "videoModel": "sora-2",
                "timeoutSeconds": 600
            }
        },
        "defaults": {
            "provider": PROVIDER_VOLCENGINE,
            "image": { "size": "2K", "count": 1, "watermark": true },
            "video": { "ratio": "16:9", "resolution": "720p", "duration": 5, "pollIntervalSeconds": 5 }
        }
    })
}

fn default_media_jobs() -> Value {
    json!({ "version": 1, "jobs": [] })
}

pub(super) fn api_key_mask(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "已保存".to_string();
    }
    let head: String = chars.iter().take(3).collect();
    let tail: String = chars.iter().skip(chars.len().saturating_sub(4)).collect();
    format!("{head}***{tail}")
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object ensured")
}

fn media_provider_ids() -> [&'static str; 3] {
    [PROVIDER_VOLCENGINE, PROVIDER_OPENAI, PROVIDER_NEWAPI]
}

fn is_supported_media_provider(provider: &str) -> bool {
    media_provider_ids().contains(&provider)
}

fn is_openai_compatible_provider(provider: &str) -> bool {
    matches!(provider, PROVIDER_OPENAI | PROVIDER_NEWAPI)
}

fn default_provider_base_url(provider: &str) -> &'static str {
    match provider {
        PROVIDER_OPENAI => DEFAULT_OPENAI_BASE_URL,
        PROVIDER_NEWAPI => DEFAULT_NEWAPI_BASE_URL,
        _ => DEFAULT_VOLCENGINE_BASE_URL,
    }
}

fn normalize_provider_config(provider_id: &str, provider: &mut Value, current: Option<&Value>) {
    let obj = ensure_object(provider);
    obj.entry("enabled").or_insert(Value::Bool(false));
    let base_url = obj
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default_provider_base_url(provider_id))
        .trim_end_matches('/')
        .to_string();
    obj.insert("baseUrl".into(), Value::String(base_url));

    let incoming_key = obj
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let old_key = current
        .and_then(|v| v.get("apiKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let keep_old = incoming_key.is_empty()
        || incoming_key == "__KEEP__"
        || incoming_key == "••••••••"
        || incoming_key == "********";
    obj.insert(
        "apiKey".into(),
        Value::String(if keep_old { old_key } else { incoming_key }.to_string()),
    );

    for key in ["imageModel", "videoModel"] {
        let value = obj
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        obj.insert(key.into(), Value::String(value));
    }
    let timeout = obj
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, 1800);
    obj.insert("timeoutSeconds".into(), Value::Number(timeout.into()));
}

fn normalize_media_config(mut config: Value, current: Option<&Value>) -> Value {
    if !config.is_object() {
        config = default_media_config();
    }
    let default = default_media_config();
    let root = ensure_object(&mut config);
    root.entry("version").or_insert(Value::Number(1.into()));
    let output_dir = root
        .get("outputDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    root.insert("outputDir".into(), Value::String(output_dir));
    root.entry("providers")
        .or_insert_with(|| default["providers"].clone());
    root.entry("defaults")
        .or_insert_with(|| default["defaults"].clone());

    {
        let providers = root.get_mut("providers").expect("providers exists");
        let providers_obj = ensure_object(providers);
        for provider_id in media_provider_ids() {
            providers_obj
                .entry(provider_id)
                .or_insert_with(|| default["providers"][provider_id].clone());
            let current_provider = current
                .and_then(|v| v.get("providers"))
                .and_then(|v| v.get(provider_id));
            if let Some(provider) = providers_obj.get_mut(provider_id) {
                normalize_provider_config(provider_id, provider, current_provider);
            }
        }
    }

    if let Some(defaults) = root.get_mut("defaults") {
        let defaults_obj = ensure_object(defaults);
        defaults_obj
            .entry("image")
            .or_insert_with(|| default["defaults"]["image"].clone());
        defaults_obj
            .entry("video")
            .or_insert_with(|| default["defaults"]["video"].clone());
        let provider = defaults_obj
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| is_supported_media_provider(value))
            .unwrap_or(PROVIDER_VOLCENGINE)
            .to_string();
        defaults_obj.insert("provider".into(), Value::String(provider));
    }

    config
}

fn sanitize_media_config_for_read(config: &Value) -> Value {
    let mut sanitized = normalize_media_config(config.clone(), None);
    let resolved_output_dir = media_output_root_from_config(&sanitized)
        .to_string_lossy()
        .to_string();
    if let Some(root) = sanitized.as_object_mut() {
        root.insert(
            "resolvedOutputDir".into(),
            Value::String(resolved_output_dir),
        );
    }
    if let Some(providers) = sanitized
        .get_mut("providers")
        .and_then(Value::as_object_mut)
    {
        for provider_id in media_provider_ids() {
            if let Some(provider) = providers
                .get_mut(provider_id)
                .and_then(Value::as_object_mut)
            {
                let api_key = provider
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                provider.insert("apiKey".into(), Value::String(String::new()));
                provider.insert(
                    "apiKeySaved".into(),
                    Value::Bool(!api_key.trim().is_empty()),
                );
                provider.insert("apiKeyMask".into(), Value::String(api_key_mask(&api_key)));
            }
        }
    }
    sanitized
}

/// 媒体数据固定放在 OpenClaw 数据目录下的 clawpanel/media。
/// 便携模式下 openclaw_dir() 本身已指向便携数据目录，因此"迁移为便携式"
/// 整体复制 OpenClaw 目录后，媒体配置与历史无需额外搬运即可被读取。
fn media_root_impl(openclaw_dir: &Path) -> PathBuf {
    openclaw_dir.join("clawpanel").join("media")
}

fn media_root() -> PathBuf {
    media_root_impl(&super::openclaw_dir())
}

fn is_safe_relative_output_dir(raw: &str) -> bool {
    let path = Path::new(raw);
    !raw.trim().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn validate_media_output_dir(raw: &str) -> Result<(), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() || is_safe_relative_output_dir(trimmed) {
        Ok(())
    } else {
        Err("产出目录不能包含 .. 或非法路径片段".into())
    }
}

fn media_output_root_impl(media_root: &Path, output_dir: &str) -> PathBuf {
    let trimmed = output_dir.trim();
    if trimmed.is_empty() {
        return media_root.to_path_buf();
    }
    let configured = PathBuf::from(trimmed);
    if configured.is_absolute() {
        configured
    } else if is_safe_relative_output_dir(trimmed) {
        media_root.join(configured)
    } else {
        media_root.to_path_buf()
    }
}

fn media_output_root_from_config(config: &Value) -> PathBuf {
    media_output_root_impl(&media_root(), str_field(config, "outputDir"))
}

fn media_config_path() -> PathBuf {
    media_root().join(MEDIA_CONFIG_FILE)
}

fn media_jobs_path() -> PathBuf {
    media_root().join(MEDIA_JOBS_FILE)
}

fn ensure_media_root() -> Result<PathBuf, String> {
    let root = media_root();
    std::fs::create_dir_all(root.join("assets")).map_err(|e| format!("创建媒体目录失败: {e}"))?;
    Ok(root)
}

fn ensure_media_output_root_from_config(config: &Value) -> Result<PathBuf, String> {
    ensure_media_root()?;
    let root = media_output_root_from_config(config);
    std::fs::create_dir_all(root.join("assets"))
        .map_err(|e| format!("创建媒体产出目录失败: {e}"))?;
    Ok(root)
}

fn read_json_or_default(path: &Path, default: Value) -> Value {
    let Ok(bytes) = std::fs::read(path) else {
        return default;
    };
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes
    };
    serde_json::from_slice(bytes).unwrap_or(default)
}

pub(super) fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败: {e}"))?;
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换文件失败: {e}"))
}

fn read_media_config_private() -> Value {
    let cfg = read_json_or_default(&media_config_path(), default_media_config());
    normalize_media_config(cfg, None)
}

fn read_media_jobs_private() -> Value {
    let mut jobs = read_json_or_default(&media_jobs_path(), default_media_jobs());
    if !jobs.is_object() {
        jobs = default_media_jobs();
    }
    let obj = ensure_object(&mut jobs);
    obj.entry("version").or_insert(Value::Number(1.into()));
    obj.entry("jobs")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !obj.get("jobs").is_some_and(Value::is_array) {
        obj.insert("jobs".into(), Value::Array(Vec::new()));
    }
    jobs
}

fn write_media_jobs_private(jobs: &Value) -> Result<(), String> {
    write_json_atomic(&media_jobs_path(), jobs)
}

fn upsert_media_job(job: Value) -> Result<Value, String> {
    let job_id = str_field(&job, "id").to_string();
    if job_id.is_empty() {
        return Err("媒体任务缺少 id".into());
    }
    let _guard = lock_media_jobs();
    let mut jobs_doc = read_media_jobs_private();
    let jobs = jobs_doc
        .get_mut("jobs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "媒体任务文件格式错误".to_string())?;
    if let Some(existing) = jobs
        .iter_mut()
        .find(|entry| str_field(entry, "id") == job_id.as_str())
    {
        *existing = job.clone();
    } else {
        jobs.push(job.clone());
    }
    write_media_jobs_private(&jobs_doc)?;
    Ok(job)
}

fn update_media_job<F>(job_id: &str, update: F) -> Result<Value, String>
where
    F: FnOnce(&mut Value),
{
    let _guard = lock_media_jobs();
    let mut jobs_doc = read_media_jobs_private();
    let jobs = jobs_doc
        .get_mut("jobs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "媒体任务文件格式错误".to_string())?;
    let job = jobs
        .iter_mut()
        .find(|entry| str_field(entry, "id") == job_id)
        .ok_or_else(|| format!("媒体任务不存在: {job_id}"))?;
    update(job);
    if let Some(obj) = job.as_object_mut() {
        obj.insert("updatedAt".into(), Value::String(now_iso()));
    }
    let result = job.clone();
    write_media_jobs_private(&jobs_doc)?;
    Ok(result)
}

fn media_job_by_id(job_id: &str) -> Option<Value> {
    read_media_jobs_private()
        .get("jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| jobs.iter().find(|entry| str_field(entry, "id") == job_id))
        .cloned()
}

fn new_job_id(prefix: &str) -> String {
    format!(
        "{}-{}-{}",
        prefix,
        chrono::Utc::now().format("%Y%m%d%H%M%S%3f"),
        rand::random::<u32>()
    )
}

fn validate_provider_id(provider: &str) -> Result<(), String> {
    if is_supported_media_provider(provider) {
        Ok(())
    } else {
        Err(format!("暂不支持媒体服务商: {provider}"))
    }
}

fn validate_common_prompt(prompt: &str) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("提示词不能为空".into());
    }
    if prompt.chars().count() > 6000 {
        return Err("提示词过长，请控制在 6000 字以内".into());
    }
    Ok(())
}

fn valid_size(size: &str) -> bool {
    let value = size.trim();
    if value.is_empty() {
        return true;
    }
    matches!(value, "1K" | "2K" | "4K" | "adaptive" | "auto")
        || value
            .split_once(['x', 'X'])
            .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
            .is_some_and(|(w, h)| (256..=8192).contains(&w) && (256..=8192).contains(&h))
}

fn validate_image_request(request: &Value) -> Result<(), String> {
    validate_provider_id(str_field(request, "provider"))?;
    validate_common_prompt(str_field(request, "prompt"))?;
    let count = u64_field(request, "count", 1);
    if !(1..=MAX_IMAGE_COUNT).contains(&count) {
        return Err(format!("图片数量必须在 1-{MAX_IMAGE_COUNT} 之间"));
    }
    let size = str_field(request, "size");
    if !valid_size(size) {
        return Err("图片尺寸格式不正确，可填 2K、4K 或 1024x1024".into());
    }
    Ok(())
}

fn validate_video_request(request: &Value) -> Result<(), String> {
    validate_provider_id(str_field(request, "provider"))?;
    validate_common_prompt(str_field(request, "prompt"))?;
    let duration = u64_field(request, "duration", 5);
    if !(1..=30).contains(&duration) {
        return Err("视频时长必须在 1-30 秒之间".into());
    }
    let ratio = str_field(request, "ratio");
    if !ratio.is_empty() && !matches!(ratio, "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9") {
        return Err("视频比例暂只支持 16:9、9:16、1:1、4:3、3:4、21:9".into());
    }
    let resolution = str_field(request, "resolution");
    if !resolution.is_empty() && !matches!(resolution, "480p" | "720p" | "1080p" | "1440p") {
        return Err("视频分辨率暂只支持 480p、720p、1080p、1440p".into());
    }
    Ok(())
}

fn load_provider_config(
    provider: &str,
    kind: &str,
    request_model: &str,
) -> Result<MediaProviderConfig, String> {
    validate_provider_id(provider)?;
    let cfg = read_media_config_private();
    let raw = cfg
        .get("providers")
        .and_then(|v| v.get(provider))
        .ok_or_else(|| format!("媒体服务商未配置: {provider}"))?;
    let api_key = str_field(raw, "apiKey").to_string();
    if api_key.is_empty() {
        return Err("请先在创作中心对接配置里填写 API Key".into());
    }
    let image_model = str_field(raw, "imageModel").to_string();
    let video_model = str_field(raw, "videoModel").to_string();
    let selected_model = if request_model.trim().is_empty() {
        if kind == "image" {
            image_model.clone()
        } else {
            video_model.clone()
        }
    } else {
        request_model.trim().to_string()
    };
    if selected_model.is_empty() {
        return Err(if kind == "image" {
            "请先填写图片模型 ID".to_string()
        } else {
            "请先填写视频模型 ID".to_string()
        });
    }
    let base_url = str_field(raw, "baseUrl").trim_end_matches('/').to_string();
    Ok(MediaProviderConfig {
        provider: provider.to_string(),
        base_url: if base_url.is_empty() {
            default_provider_base_url(provider).to_string()
        } else {
            base_url
        },
        api_key,
        image_model: if kind == "image" {
            selected_model.clone()
        } else {
            image_model
        },
        video_model: if kind == "video" {
            selected_model
        } else {
            video_model
        },
        timeout_seconds: u64_field(raw, "timeoutSeconds", 600).clamp(30, 1800),
    })
}

fn build_api_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn provider_docs(provider: &str) -> Value {
    match provider {
        PROVIDER_OPENAI => json!({
            "apiKey": "https://platform.openai.com/api-keys",
            "modelList": "https://developers.openai.com/api/docs/models",
            "image": "https://developers.openai.com/api/docs/guides/image-generation",
            "video": "https://developers.openai.com/api/docs/guides/video-generation"
        }),
        PROVIDER_NEWAPI => json!({
            "apiKey": "https://docs.newapi.pro/en/docs/api",
            "modelList": "https://docs.newapi.pro/en/docs/api",
            "image": "https://docs.newapi.pro/en/docs/api/ai-model/images/openai/post-v1-images-generations",
            "video": "https://docs.newapi.pro/en/docs/api/ai-model/videos/sora/createvideo"
        }),
        _ => json!({
            "apiKey": "https://www.volcengine.com/docs/82379/1541594",
            "modelList": "https://www.volcengine.com/docs/82379/1330310"
        }),
    }
}

fn infer_model_capabilities(id: &str, label: &str) -> Vec<&'static str> {
    let text = format!("{id} {label}").to_ascii_lowercase();
    let mut caps = Vec::new();
    if text.contains("seedream")
        || text.contains("gpt-image")
        || text.contains("dall-e")
        || text.contains("text-to-image")
        || text.contains("image-generation")
        || text.contains("image_generation")
        || text.contains("t2i")
    {
        caps.push("image");
    }
    if text.contains("seedance")
        || text.contains("sora")
        || text.contains("text-to-video")
        || text.contains("image-to-video")
        || text.contains("video-generation")
        || text.contains("video_generation")
        || text.contains("t2v")
        || text.contains("i2v")
    {
        caps.push("video");
    }
    caps
}

fn model_string_field<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    ""
}

fn collect_media_model_items<'a>(value: &'a Value, out: &mut Vec<&'a Value>) {
    if let Some(arr) = value.as_array() {
        out.extend(arr.iter());
        return;
    }
    if !value.is_object() {
        return;
    }
    for key in [
        "data",
        "models",
        "items",
        "Items",
        "ModelList",
        "model_list",
        "foundationModels",
        "FoundationModels",
    ] {
        if let Some(arr) = value.get(key).and_then(Value::as_array) {
            out.extend(arr.iter());
        }
    }
    for key in ["result", "Result", "response", "Response"] {
        if let Some(nested) = value.get(key) {
            collect_media_model_items(nested, out);
        }
    }
}

fn extract_media_models(value: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    collect_media_model_items(value, &mut items);

    let mut result: Vec<Value> = Vec::new();
    for item in items {
        let id = model_string_field(
            item,
            &[
                "id",
                "model",
                "model_id",
                "modelId",
                "ModelId",
                "ModelID",
                "ModelName",
                "FoundationModelId",
                "FoundationModelName",
                "EndpointId",
                "endpoint_id",
            ],
        );
        if id.is_empty() || result.iter().any(|m| m["id"].as_str() == Some(id)) {
            continue;
        }
        let label = model_string_field(
            item,
            &[
                "name",
                "display_name",
                "displayName",
                "DisplayName",
                "Description",
                "description",
            ],
        );
        let caps = infer_model_capabilities(id, label);
        result.push(json!({
            "id": id,
            "label": if label.is_empty() { id } else { label },
            "capabilities": caps,
        }));
    }
    result.sort_by(|a, b| str_field(a, "id").cmp(str_field(b, "id")));
    result
}

fn is_gpt_image_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("gpt-image")
}

fn normalize_openai_image_size(size: &str) -> Option<String> {
    let value = size.trim();
    if value.is_empty() {
        return None;
    }
    if value.eq_ignore_ascii_case("auto") {
        return Some("auto".into());
    }
    if value.eq_ignore_ascii_case("1K")
        || value.eq_ignore_ascii_case("2K")
        || value.eq_ignore_ascii_case("4K")
        || value.eq_ignore_ascii_case("adaptive")
    {
        return Some("1024x1024".into());
    }
    Some(value.to_string())
}

fn build_image_generation_payload(provider: &MediaProviderConfig, request: &Value) -> Value {
    let mut payload = json!({
        "model": provider.image_model.clone(),
        "prompt": str_field(request, "prompt"),
        "n": u64_field(request, "count", 1)
    });

    if is_openai_compatible_provider(&provider.provider) {
        if let Some(size) = normalize_openai_image_size(str_field(request, "size")) {
            payload["size"] = Value::String(size);
        }
        if !is_gpt_image_model(&provider.image_model) {
            payload["response_format"] = Value::String("b64_json".into());
        }
    } else {
        payload["response_format"] = Value::String("url".into());
        payload["watermark"] = Value::Bool(bool_field(request, "watermark", true));
        let size = str_field(request, "size");
        if !size.is_empty() {
            payload["size"] = Value::String(size.to_string());
        }
    }

    if let Some(images) = request.get("images").filter(|v| v.is_array()) {
        payload["images"] = images.clone();
    }
    payload
}

fn openai_video_seconds(duration: u64) -> &'static str {
    let candidates = [4_u64, 8, 12];
    let selected = candidates
        .into_iter()
        .min_by_key(|value| value.abs_diff(duration))
        .unwrap_or(4);
    match selected {
        8 => "8",
        12 => "12",
        _ => "4",
    }
}

fn openai_video_size(ratio: &str, resolution: &str) -> &'static str {
    let high = matches!(resolution.trim(), "1080p" | "1440p");
    match ratio.trim() {
        "9:16" | "3:4" => {
            if high {
                "1024x1792"
            } else {
                "720x1280"
            }
        }
        _ => {
            if high {
                "1792x1024"
            } else {
                "1280x720"
            }
        }
    }
}

fn build_openai_video_payload(provider: &MediaProviderConfig, request: &Value) -> Value {
    let mut payload = json!({
        "model": provider.video_model.clone(),
        "prompt": str_field(request, "prompt"),
        "seconds": openai_video_seconds(u64_field(request, "duration", 5)),
        "size": openai_video_size(str_field(request, "ratio"), str_field(request, "resolution"))
    });
    if let Some(image_url) = request
        .get("imageUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if provider.provider == PROVIDER_NEWAPI {
            payload["image"] = Value::String(image_url.to_string());
        } else {
            payload["input_reference"] = json!({
                "type": "image_url",
                "image_url": { "url": image_url }
            });
        }
    }
    payload
}

fn openai_video_dimensions(size: &str) -> Option<(&str, &str)> {
    size.split_once('x')
}

fn provider_status_to_job_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "created" | "queued" | "pending" | "running" | "processing" | "in_progress" => "running",
        "succeeded" | "success" | "completed" | "done" => "succeeded",
        "failed" | "error" | "cancelled" | "canceled" | "expired" => {
            if status.trim().eq_ignore_ascii_case("cancelled")
                || status.trim().eq_ignore_ascii_case("canceled")
            {
                "canceled"
            } else {
                "failed"
            }
        }
        _ => "running",
    }
}

fn extract_nested_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        // 空字符串视为未命中，继续向嵌套容器找（与 dev-api.js 的 extractNestedString 行为一致）
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    for container in ["data", "task", "result", "output"] {
        if let Some(s) = value
            .get(container)
            .and_then(|v| extract_nested_string(v, keys))
        {
            return Some(s);
        }
    }
    None
}

fn extract_provider_task_id(value: &Value) -> String {
    extract_nested_string(value, &["id", "task_id", "taskId", "providerTaskId"])
        .unwrap_or("")
        .to_string()
}

fn extract_provider_status(value: &Value) -> String {
    extract_nested_string(value, &["status", "state", "task_status", "taskStatus"])
        .unwrap_or("running")
        .to_string()
}

fn looks_like_video_url(url: &str, key_hint: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && (key_hint.contains("video")
            || lower.contains(".mp4")
            || lower.contains(".mov")
            || lower.contains(".webm")
            || lower.contains("video"))
}

fn collect_video_urls_inner(value: &Value, key_hint: &str, out: &mut Vec<String>) {
    match value {
        Value::String(s) if looks_like_video_url(s, key_hint) && !out.iter().any(|v| v == s) => {
            out.push(s.to_string());
        }
        Value::String(_) => {}
        Value::Array(arr) => {
            for item in arr {
                collect_video_urls_inner(item, key_hint, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                let hint = if key_hint.is_empty() {
                    key.to_ascii_lowercase()
                } else {
                    format!("{} {}", key_hint, key.to_ascii_lowercase())
                };
                collect_video_urls_inner(item, &hint, out);
            }
        }
        _ => {}
    }
}

fn collect_video_urls(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    collect_video_urls_inner(value, "", &mut urls);
    urls
}

fn is_safe_relative_media_path(raw: &str) -> bool {
    let path = Path::new(raw);
    let bytes = raw.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if raw.trim().is_empty()
        || path.is_absolute()
        || raw.starts_with(['/', '\\'])
        || has_windows_drive_prefix
    {
        return false;
    }
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
        && raw.split(['/', '\\']).all(|component| component != "..")
}

fn path_compare_key(path: &Path) -> String {
    crate::utils::path_compare_key(path)
}

fn paths_equivalent(a: &Path, b: &Path) -> bool {
    path_compare_key(a) == path_compare_key(b)
}

fn media_job_knows_asset_root(raw: &str, root: &Path) -> bool {
    read_media_jobs_private()
        .get("jobs")
        .and_then(Value::as_array)
        .is_some_and(|jobs| {
            jobs.iter().any(|job| {
                job.get("assets")
                    .and_then(Value::as_array)
                    .is_some_and(|assets| {
                        assets.iter().any(|asset| {
                            asset.get("path").and_then(Value::as_str) == Some(raw)
                                && asset
                                    .get("root")
                                    .and_then(Value::as_str)
                                    .is_some_and(|stored| paths_equivalent(Path::new(stored), root))
                        })
                    })
            })
        })
}

fn resolve_media_asset_path(raw: &str, root_hint: Option<&str>) -> Result<PathBuf, String> {
    if !is_safe_relative_media_path(raw) {
        return Err("非法媒体文件路径".into());
    }

    let default_root = media_root();
    let root = root_hint
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root.clone());
    if root_hint.is_some()
        && !paths_equivalent(&root, &default_root)
        && !paths_equivalent(
            &root,
            &media_output_root_from_config(&read_media_config_private()),
        )
        && !media_job_knows_asset_root(raw, &root)
    {
        return Err("媒体文件路径不在已知产出目录中".into());
    }

    let target = root.join(raw);
    let normalized_root = path_compare_key(&root);
    let normalized_target = path_compare_key(&target);
    if normalized_target != normalized_root
        && !normalized_target.starts_with(&format!("{normalized_root}/"))
    {
        return Err("非法媒体文件路径".into());
    }
    Ok(target)
}

fn asset_ext_from_content_type(content_type: &str, fallback: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("image/png") {
        "png"
    } else if ct.contains("image/webp") {
        "webp"
    } else if ct.contains("image/gif") {
        "gif"
    } else if ct.contains("video/mp4") {
        "mp4"
    } else if ct.contains("video/webm") {
        "webm"
    } else if fallback == "video" {
        "mp4"
    } else {
        "jpg"
    }
}

fn guess_mime_from_ext(ext: &str, kind: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ if kind == "video" => "video/mp4",
        _ => "image/jpeg",
    }
}

fn media_content_length_exceeds_limit(
    headers: &reqwest::header::HeaderMap,
) -> Result<bool, String> {
    let Some(value) = headers.get(reqwest::header::CONTENT_LENGTH) else {
        return Ok(false);
    };
    let Ok(raw) = value.to_str() else {
        return Ok(false);
    };
    let Ok(size) = raw.trim().parse::<u64>() else {
        return Ok(false);
    };
    Ok(size > MAX_ASSET_BYTES)
}

fn ensure_media_content_length_allowed(headers: &reqwest::header::HeaderMap) -> Result<(), String> {
    if media_content_length_exceeds_limit(headers)? {
        Err("媒体文件超过 512MB，已停止保存".into())
    } else {
        Ok(())
    }
}

fn relative_asset_path(_kind: &str, job_id: &str, index: usize, ext: &str) -> PathBuf {
    PathBuf::from("assets")
        .join(chrono::Utc::now().format("%Y").to_string())
        .join(chrono::Utc::now().format("%m").to_string())
        .join(format!("{job_id}-{index}.{ext}"))
}

async fn write_asset_bytes(
    kind: &str,
    job_id: &str,
    index: usize,
    bytes: &[u8],
    mime: &str,
    source_url: Option<&str>,
) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err("媒体文件超过 512MB，已停止保存".into());
    }
    let cfg = read_media_config_private();
    let root = ensure_media_output_root_from_config(&cfg)?;
    let ext = asset_ext_from_content_type(mime, kind);
    let relative = relative_asset_path(kind, job_id, index, ext);
    let target = root.join(&relative);
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建媒体资产目录失败: {e}"))?;
    }
    tokio::fs::write(&target, bytes)
        .await
        .map_err(|e| format!("保存媒体资产失败: {e}"))?;
    Ok(json!({
        "kind": kind,
        "path": relative.to_string_lossy().replace('\\', "/"),
        "root": root.to_string_lossy(),
        "mime": mime,
        "bytes": bytes.len() as u64,
        "sourceUrl": source_url.unwrap_or("")
    }))
}

/// 仅当资产 URL 与服务商 Base URL 同主机同端口时才允许携带 API Key，
/// 防止服务商响应中混入第三方 URL 后把密钥发给任意主机
fn asset_url_same_origin(url: &str, base_url: &str) -> bool {
    let (Ok(asset), Ok(base)) = (reqwest::Url::parse(url), reqwest::Url::parse(base_url)) else {
        return false;
    };
    asset.scheme().eq_ignore_ascii_case(base.scheme())
        && asset.host_str().map(str::to_ascii_lowercase)
            == base.host_str().map(str::to_ascii_lowercase)
        && asset.port_or_known_default() == base.port_or_known_default()
}

fn should_retry_asset_without_auth(status: reqwest::StatusCode, same_host: bool) -> bool {
    same_host && matches!(status.as_u16(), 401 | 403)
}

async fn download_asset_to_media_root(
    client: &reqwest::Client,
    provider: &MediaProviderConfig,
    url: &str,
    kind: &str,
    job_id: &str,
    index: usize,
) -> Result<Value, String> {
    let (resp, final_url) = fetch_media_asset_response(client, provider, url).await?;
    if !resp.status().is_success() {
        return Err(format!("下载媒体资产失败: HTTP {}", resp.status()));
    }
    stream_response_to_asset(
        resp,
        kind,
        job_id,
        index,
        Some(&final_url),
        provider.timeout_seconds,
    )
    .await
}

async fn fetch_media_asset_response(
    client: &reqwest::Client,
    provider: &MediaProviderConfig,
    url: &str,
) -> Result<(reqwest::Response, String), String> {
    let mut current = reqwest::Url::parse(url).map_err(|e| format!("媒体资产 URL 无效: {e}"))?;
    let mut retry_without_auth = false;
    for redirects in 0..=5 {
        let same_origin = asset_url_same_origin(current.as_str(), &provider.base_url);
        let send_auth = same_origin && !retry_without_auth && !provider.api_key.is_empty();
        let mut request = client.get(current.clone());
        if send_auth {
            request = request.bearer_auth(&provider.api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("下载媒体资产失败: {e}"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("媒体资产重定向缺少 Location")?;
            if redirects == 5 {
                return Err("媒体资产重定向次数过多".into());
            }
            current = current
                .join(location)
                .map_err(|e| format!("媒体资产重定向 URL 无效: {e}"))?;
            retry_without_auth = false;
            continue;
        }
        if send_auth && should_retry_asset_without_auth(response.status(), same_origin) {
            retry_without_auth = true;
            continue;
        }
        return Ok((response, current.to_string()));
    }
    Err("媒体资产重定向次数过多".into())
}

async fn stream_response_to_asset(
    resp: reqwest::Response,
    kind: &str,
    job_id: &str,
    index: usize,
    source_url: Option<&str>,
    timeout_seconds: u64,
) -> Result<Value, String> {
    ensure_media_content_length_allowed(resp.headers())?;
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_else(|| {
            if kind == "video" {
                "video/mp4"
            } else {
                "image/jpeg"
            }
        })
        .to_string();
    let cfg = read_media_config_private();
    let root = ensure_media_output_root_from_config(&cfg)?;
    let relative = relative_asset_path(
        kind,
        job_id,
        index,
        asset_ext_from_content_type(&mime, kind),
    );
    let target = root.join(&relative);
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建媒体资产目录失败: {e}"))?;
    }
    let temp = target.with_extension(format!(
        "{}.part-{}-{}",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("asset"),
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let operation = async {
        let mut file = tokio::fs::File::create(&temp)
            .await
            .map_err(|e| format!("创建媒体资产临时文件失败: {e}"))?;
        let mut stream = resp.bytes_stream();
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("读取媒体资产失败: {e}"))?;
            total = total.saturating_add(chunk.len() as u64);
            if total > MAX_ASSET_BYTES {
                return Err("媒体文件超过 512MB，已停止保存".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("保存媒体资产失败: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("刷新媒体资产失败: {e}"))?;
        drop(file);
        if target.exists() {
            tokio::fs::remove_file(&target)
                .await
                .map_err(|e| format!("替换媒体资产失败: {e}"))?;
        }
        tokio::fs::rename(&temp, &target)
            .await
            .map_err(|e| format!("提交媒体资产失败: {e}"))?;
        Ok::<u64, String>(total)
    };
    let result = tokio::time::timeout(Duration::from_secs(timeout_seconds.max(1)), operation).await;
    let bytes = match result {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(error);
        }
        Err(_) => {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err("媒体资产下载超时".into());
        }
    };
    Ok(json!({
        "kind": kind,
        "path": relative.to_string_lossy().replace('\\', "/"),
        "root": root.to_string_lossy(),
        "mime": mime,
        "bytes": bytes,
        "sourceUrl": source_url.unwrap_or("")
    }))
}

async fn download_openai_video_content(
    client: &reqwest::Client,
    provider: &MediaProviderConfig,
    provider_task_id: &str,
    job_id: &str,
    index: usize,
) -> Result<Value, String> {
    let endpoint = build_api_url(
        &provider.base_url,
        &format!("/videos/{provider_task_id}/content"),
    );
    let (resp, final_url) = fetch_media_asset_response(client, provider, &endpoint).await?;
    if !resp.status().is_success() {
        return Err(format!("下载视频内容失败: HTTP {}", resp.status()));
    }
    stream_response_to_asset(
        resp,
        "video",
        job_id,
        index,
        Some(&final_url),
        provider.timeout_seconds,
    )
    .await
}

fn collect_image_outputs(value: &Value) -> Vec<Value> {
    let mut outputs = Vec::new();
    if let Some(arr) = value.get("data").and_then(Value::as_array) {
        outputs.extend(arr.iter().cloned());
    } else if let Some(arr) = value.get("images").and_then(Value::as_array) {
        outputs.extend(arr.iter().cloned());
    } else if value.get("url").is_some() || value.get("b64_json").is_some() {
        outputs.push(value.clone());
    }
    outputs
}

async fn save_image_outputs(
    client: &reqwest::Client,
    provider: &MediaProviderConfig,
    job_id: &str,
    response: &Value,
) -> Result<Vec<Value>, String> {
    let outputs = collect_image_outputs(response);
    if outputs.is_empty() {
        return Err("服务商响应中没有图片结果".into());
    }
    let mut assets = Vec::new();
    for (idx, item) in outputs.iter().enumerate() {
        if let Some(url) = item
            .get("url")
            .or_else(|| item.get("image_url"))
            .and_then(|v| {
                if v.is_string() {
                    v.as_str()
                } else {
                    v.get("url").and_then(Value::as_str)
                }
            })
        {
            assets.push(
                download_asset_to_media_root(client, provider, url, "image", job_id, idx).await?,
            );
            continue;
        }
        if let Some(raw_b64) = item.get("b64_json").and_then(Value::as_str) {
            let pure = raw_b64.split_once(',').map(|(_, v)| v).unwrap_or(raw_b64);
            let bytes = general_purpose::STANDARD
                .decode(pure)
                .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
            assets.push(write_asset_bytes("image", job_id, idx, &bytes, "image/png", None).await?);
        }
    }
    if assets.is_empty() {
        return Err("服务商响应中没有可保存的图片 URL 或 base64".into());
    }
    Ok(assets)
}

fn sanitize_provider_error(raw: &str, api_key: &str) -> String {
    if api_key.is_empty() {
        raw.to_string()
    } else {
        raw.replace(api_key, "***")
    }
}

fn media_http_client(timeout_seconds: u64) -> Result<reqwest::Client, String> {
    super::build_http_client_no_proxy_no_redirect(
        Duration::from_secs(timeout_seconds),
        Some("ClawPanel Media"),
    )
}

/// 落盘前允许保留的最长字符串（字节）。超过即视为 base64/data URL 等大负载，
/// 只保留开头片段，避免 media-jobs.json 随任务数量膨胀到 GB 级
const MAX_PERSISTED_STRING_BYTES: usize = 2048;

/// 递归裁剪 JSON 中的超长字符串（如 gpt-image 响应里的 b64_json），用于持久化前瘦身
fn truncate_large_strings(value: &Value) -> Value {
    match value {
        Value::String(s) if s.len() > MAX_PERSISTED_STRING_BYTES => {
            let head: String = s.chars().take(64).collect();
            Value::String(format!("{head}…[已截断 {} 字节]", s.len()))
        }
        Value::Array(arr) => Value::Array(arr.iter().map(truncate_large_strings).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), truncate_large_strings(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn media_error_job(
    id: &str,
    kind: &str,
    provider: &str,
    prompt: &str,
    model: &str,
    error: String,
    raw_response: Option<Value>,
) -> Value {
    let now = now_iso();
    json!({
        "id": id,
        "type": kind,
        "provider": provider,
        "providerTaskId": null,
        "status": "failed",
        "prompt": prompt,
        "model": model,
        "createdAt": now,
        "updatedAt": now,
        "assets": [],
        "error": error,
        "rawProviderResponse": raw_response.map(|v| truncate_large_strings(&v)).unwrap_or(Value::Null)
    })
}

#[tauri::command]
pub fn read_media_config() -> Result<Value, String> {
    ensure_media_root()?;
    Ok(sanitize_media_config_for_read(&read_media_config_private()))
}

#[tauri::command]
pub fn write_media_config(config: Value) -> Result<(), String> {
    ensure_media_root()?;
    let current = read_media_config_private();
    let normalized = normalize_media_config(config, Some(&current));
    validate_media_output_dir(str_field(&normalized, "outputDir"))?;
    ensure_media_output_root_from_config(&normalized)?;
    write_json_atomic(&media_config_path(), &normalized)
}

#[tauri::command]
pub async fn test_media_provider(provider: String) -> Result<Value, String> {
    validate_provider_id(&provider)?;
    let cfg = read_media_config_private();
    let raw = cfg
        .get("providers")
        .and_then(|v| v.get(&provider))
        .ok_or_else(|| format!("媒体服务商未配置: {provider}"))?;
    let api_key = str_field(raw, "apiKey");
    if api_key.is_empty() {
        return Err("请先填写 API Key".into());
    }
    let base_url = str_field(raw, "baseUrl");
    // 允许 http://：自建 NewAPI / 内网网关是合法场景，与实际生成请求的校验保持一致
    if base_url.is_empty() || !(base_url.starts_with("https://") || base_url.starts_with("http://"))
    {
        return Err("Base URL 必须以 http:// 或 https:// 开头".into());
    }
    Ok(json!({
        "ok": true,
        "provider": provider,
        "baseUrl": base_url,
        "message": "本地配置检查通过。生成图片或创建视频任务时才会调用服务商接口。"
    }))
}

#[tauri::command]
pub async fn fetch_media_models(provider: String) -> Result<Value, String> {
    validate_provider_id(&provider)?;
    let cfg = read_media_config_private();
    let raw = cfg
        .get("providers")
        .and_then(|v| v.get(&provider))
        .ok_or_else(|| format!("媒体服务商未配置: {provider}"))?;
    let api_key = str_field(raw, "apiKey").to_string();
    if api_key.is_empty() {
        return Err("请先填写 API Key".into());
    }
    let base_url = str_field(raw, "baseUrl").trim_end_matches('/').to_string();
    // 允许 http://：自建 NewAPI / 内网网关是合法场景，与实际生成请求的校验保持一致
    if base_url.is_empty() || !(base_url.starts_with("https://") || base_url.starts_with("http://"))
    {
        return Err("Base URL 必须以 http:// 或 https:// 开头".into());
    }
    let timeout_seconds = u64_field(raw, "timeoutSeconds", 600).clamp(30, 1800);
    let client = media_http_client(timeout_seconds)?;
    let endpoint = build_api_url(&base_url, "/models");
    let resp = client
        .get(&endpoint)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("获取模型列表失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取模型列表响应失败: {e}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "raw": text }));
    if !status.is_success() {
        if matches!(status.as_u16(), 404 | 405 | 501) {
            return Ok(json!({
                "ok": false,
                "supported": false,
                "models": [],
                "message": "当前 Base URL 未开放 /models 列表接口，请按官方模型列表或控制台填写模型 ID。",
                "docs": provider_docs(&provider)
            }));
        }
        let error = sanitize_provider_error(&format!("HTTP {status}: {parsed}"), &api_key);
        return Err(error);
    }
    let models = extract_media_models(&parsed);
    Ok(json!({
        "ok": true,
        "supported": !models.is_empty(),
        "models": models,
        "message": if models.is_empty() {
            "服务商响应中没有可识别的模型 ID，请按官方模型列表或控制台填写。"
        } else {
            "模型列表已获取。"
        },
        "docs": provider_docs(&provider)
    }))
}

#[tauri::command]
pub async fn generate_image(request: Value) -> Result<Value, String> {
    validate_image_request(&request)?;
    let provider_id = str_field(&request, "provider").to_string();
    let prompt = str_field(&request, "prompt").to_string();
    let provider = load_provider_config(&provider_id, "image", str_field(&request, "model"))?;
    let job_id = new_job_id("img");
    let client = media_http_client(provider.timeout_seconds)?;
    let payload = build_image_generation_payload(&provider, &request);
    let endpoint = build_api_url(&provider.base_url, "/images/generations");
    let resp = client
        .post(endpoint)
        .bearer_auth(&provider.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("图片生成请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取图片生成响应失败: {e}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "raw": text }));
    if !status.is_success() {
        let error = sanitize_provider_error(&format!("HTTP {status}: {parsed}"), &provider.api_key);
        let job = media_error_job(
            &job_id,
            "image",
            &provider.provider,
            &prompt,
            &provider.image_model,
            error.clone(),
            Some(parsed),
        );
        let _ = upsert_media_job(job);
        return Err(error);
    }
    let assets = match save_image_outputs(&client, &provider, &job_id, &parsed).await {
        Ok(assets) => assets,
        Err(error) => {
            let job = media_error_job(
                &job_id,
                "image",
                &provider.provider,
                &prompt,
                &provider.image_model,
                error.clone(),
                Some(parsed),
            );
            let _ = upsert_media_job(job);
            return Err(error);
        }
    };
    let now = now_iso();
    let job = json!({
        "id": job_id,
        "type": "image",
        "provider": provider.provider,
        "providerTaskId": null,
        "status": "succeeded",
        "prompt": prompt,
        "model": provider.image_model,
        "createdAt": now,
        "updatedAt": now,
        "request": truncate_large_strings(&payload),
        "assets": assets,
        "error": null,
        "rawProviderResponse": truncate_large_strings(&parsed)
    });
    upsert_media_job(job)
}

#[tauri::command]
pub async fn create_video_task(request: Value) -> Result<Value, String> {
    validate_video_request(&request)?;
    let provider_id = str_field(&request, "provider").to_string();
    let prompt = str_field(&request, "prompt").to_string();
    let provider = load_provider_config(&provider_id, "video", str_field(&request, "model"))?;
    let job_id = new_job_id("vid");
    let client = media_http_client(provider.timeout_seconds)?;
    let (payload, resp) = if is_openai_compatible_provider(&provider.provider) {
        let payload = build_openai_video_payload(&provider, &request);
        let mut form = reqwest::multipart::Form::new()
            .text("model", str_field(&payload, "model").to_string())
            .text("prompt", str_field(&payload, "prompt").to_string())
            .text("seconds", str_field(&payload, "seconds").to_string())
            .text("size", str_field(&payload, "size").to_string());
        if provider.provider == PROVIDER_NEWAPI {
            form = form.text("duration", str_field(&payload, "seconds").to_string());
            if let Some((width, height)) = openai_video_dimensions(str_field(&payload, "size")) {
                form = form
                    .text("width", width.to_string())
                    .text("height", height.to_string());
            }
        }
        if let Some(image_url) = payload.get("image").and_then(Value::as_str) {
            form = form.text("image", image_url.to_string());
        }
        if let Some(input_reference) = payload.get("input_reference").filter(|v| v.is_object()) {
            form = form.text("input_reference", input_reference.to_string());
        }
        let endpoint = build_api_url(&provider.base_url, "/videos");
        let resp = client
            .post(&endpoint)
            .bearer_auth(&provider.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("创建视频任务失败: {e}"))?;
        (payload, resp)
    } else {
        let mut content = vec![json!({ "type": "text", "text": prompt })];
        if let Some(url) = request
            .get("imageUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
        }
        let mut payload = json!({
            "model": provider.video_model.clone(),
            "content": content,
            "ratio": str_field(&request, "ratio"),
            "resolution": str_field(&request, "resolution"),
            "duration": u64_field(&request, "duration", 5)
        });
        for key in ["ratio", "resolution"] {
            if payload[key].as_str().unwrap_or("").is_empty() {
                payload.as_object_mut().unwrap().remove(key);
            }
        }
        let endpoint = build_api_url(&provider.base_url, "/contents/generations/tasks");
        let resp = client
            .post(&endpoint)
            .bearer_auth(&provider.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("创建视频任务失败: {e}"))?;
        (payload, resp)
    };
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取视频任务响应失败: {e}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "raw": text }));
    if !status.is_success() {
        let error = sanitize_provider_error(&format!("HTTP {status}: {parsed}"), &provider.api_key);
        let job = media_error_job(
            &job_id,
            "video",
            &provider.provider,
            &prompt,
            &provider.video_model,
            error.clone(),
            Some(parsed),
        );
        let _ = upsert_media_job(job);
        return Err(error);
    }
    let provider_task_id = extract_provider_task_id(&parsed);
    if provider_task_id.is_empty() {
        // 任务可能已在服务商侧创建并计费：即使无法识别任务 ID，也要落盘保留原始响应供恢复
        let error = "服务商响应中没有视频任务 ID".to_string();
        let _ = upsert_media_job(media_error_job(
            &job_id,
            "video",
            &provider.provider,
            &prompt,
            &provider.video_model,
            error.clone(),
            Some(parsed),
        ));
        return Err(error);
    }
    let provider_status = extract_provider_status(&parsed);
    let job_status = provider_status_to_job_status(&provider_status);
    let now = now_iso();
    let job = json!({
        "id": job_id,
        "type": "video",
        "provider": provider.provider,
        "providerTaskId": provider_task_id,
        "status": job_status,
        "providerStatus": provider_status,
        "prompt": prompt,
        "model": provider.video_model,
        "createdAt": now,
        "updatedAt": now,
        "request": truncate_large_strings(&payload),
        "assets": [],
        "error": null,
        "rawProviderResponse": truncate_large_strings(&parsed)
    });
    upsert_media_job(job)
}

#[tauri::command]
pub async fn poll_video_task(job_id: String) -> Result<Value, String> {
    let job = media_job_by_id(&job_id).ok_or_else(|| format!("媒体任务不存在: {job_id}"))?;
    if str_field(&job, "type") != "video" {
        return Err("只支持轮询视频任务".into());
    }
    let provider_id = str_field(&job, "provider");
    let provider_task_id = str_field(&job, "providerTaskId").to_string();
    if provider_task_id.is_empty() {
        return Err("视频任务缺少服务商任务 ID".into());
    }
    let provider = load_provider_config(provider_id, "video", str_field(&job, "model"))?;
    let client = media_http_client(provider.timeout_seconds)?;
    let endpoint = if is_openai_compatible_provider(&provider.provider) {
        build_api_url(&provider.base_url, &format!("/videos/{provider_task_id}"))
    } else {
        build_api_url(
            &provider.base_url,
            &format!("/contents/generations/tasks/{provider_task_id}"),
        )
    };
    let resp = client
        .get(endpoint)
        .bearer_auth(&provider.api_key)
        .send()
        .await
        .map_err(|e| format!("查询视频任务失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取视频任务查询响应失败: {e}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "raw": text }));
    if !status.is_success() {
        let error = sanitize_provider_error(&format!("HTTP {status}: {parsed}"), &provider.api_key);
        // 429 / 5xx 属于瞬时错误：保留原状态允许继续轮询，避免把服务商侧仍在运行的付费任务永久标记为失败
        let transient = status.as_u16() == 429 || status.is_server_error();
        return update_media_job(&job_id, |entry| {
            if !transient {
                entry["status"] = Value::String("failed".into());
            }
            entry["error"] = Value::String(error.clone());
            entry["rawProviderResponse"] = truncate_large_strings(&parsed);
        });
    }
    let provider_status = extract_provider_status(&parsed);
    let job_status = provider_status_to_job_status(&provider_status);
    let mut assets = job.get("assets").cloned().unwrap_or_else(|| json!([]));
    let mut download_error = None;
    if job_status == "succeeded" && assets.as_array().is_none_or(|arr| arr.is_empty()) {
        let urls = collect_video_urls(&parsed);
        let mut saved = Vec::new();
        for (idx, url) in urls.iter().enumerate() {
            match download_asset_to_media_root(&client, &provider, url, "video", &job_id, idx).await
            {
                Ok(asset) => saved.push(asset),
                Err(e) => download_error = Some(e),
            }
        }
        if saved.is_empty() && is_openai_compatible_provider(&provider.provider) {
            match download_openai_video_content(
                &client,
                &provider,
                &provider_task_id,
                &job_id,
                saved.len(),
            )
            .await
            {
                Ok(asset) => saved.push(asset),
                Err(e) => download_error = Some(e),
            }
        }
        assets = Value::Array(saved);
    }
    update_media_job(&job_id, |entry| {
        entry["status"] = Value::String(job_status.into());
        entry["providerStatus"] = Value::String(provider_status.clone());
        entry["assets"] = assets.clone();
        entry["rawProviderResponse"] = truncate_large_strings(&parsed);
        if let Some(err) = download_error.clone() {
            entry["error"] = Value::String(err);
        } else if job_status != "failed" {
            entry["error"] = Value::Null;
        }
    })
}

#[tauri::command]
pub async fn cancel_media_job(job_id: String) -> Result<Value, String> {
    update_media_job(&job_id, |entry| {
        entry["status"] = Value::String("canceled".into());
        entry["providerStatus"] = Value::String("local-canceled".into());
    })
}

#[tauri::command]
pub fn list_media_jobs(filter: Option<Value>) -> Result<Value, String> {
    let filter = filter.unwrap_or_else(|| json!({}));
    let jobs_doc = read_media_jobs_private();
    Ok(media_jobs_response_from_doc(&jobs_doc, Some(&filter)))
}

fn media_filter_usize(filter: Option<&Value>, key: &str, default: usize, max: usize) -> usize {
    let Some(value) = filter.and_then(|v| v.get(key)) else {
        return default.min(max);
    };
    let parsed = value
        .as_u64()
        .or_else(|| {
            value
                .as_str()
                .and_then(|raw| raw.trim().parse::<u64>().ok())
        })
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default);
    parsed.min(max)
}

fn media_jobs_response_from_doc(jobs_doc: &Value, filter: Option<&Value>) -> Value {
    let mut jobs: Vec<Value> = jobs_doc
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(kind) = filter
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        jobs.retain(|job| str_field(job, "type") == kind);
    }
    if let Some(status) = filter
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        jobs.retain(|job| str_field(job, "status") == status);
    }
    jobs.sort_by(|a, b| str_field(b, "createdAt").cmp(str_field(a, "createdAt")));
    let total = jobs.len();
    let offset = media_filter_usize(filter, "offset", 0, total);
    let limit = media_filter_usize(filter, "limit", 24, 200).max(1);
    let paged: Vec<Value> = jobs.into_iter().skip(offset).take(limit).collect();
    let has_more = offset.saturating_add(paged.len()) < total;
    json!({
        "version": 1,
        "jobs": paged,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": has_more
    })
}

#[tauri::command]
pub fn delete_media_job(job_id: String, delete_assets: Option<bool>) -> Result<(), String> {
    let _guard = lock_media_jobs();
    let mut jobs_doc = read_media_jobs_private();
    let jobs = jobs_doc
        .get_mut("jobs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "媒体任务文件格式错误".to_string())?;
    let Some(pos) = jobs
        .iter()
        .position(|entry| str_field(entry, "id") == job_id)
    else {
        return Err(format!("媒体任务不存在: {job_id}"));
    };
    let job = jobs.remove(pos);
    if delete_assets.unwrap_or(true) {
        if let Some(assets) = job.get("assets").and_then(Value::as_array) {
            for asset in assets {
                if let Some(path) = asset.get("path").and_then(Value::as_str) {
                    let root = asset.get("root").and_then(Value::as_str);
                    if let Ok(full) = resolve_media_asset_path(path, root) {
                        let _ = std::fs::remove_file(full);
                    }
                }
            }
        }
    }
    write_media_jobs_private(&jobs_doc)
}

#[tauri::command]
pub fn reveal_media_asset(path: String, root: Option<String>) -> Result<Value, String> {
    let full = resolve_media_asset_path(&path, root.as_deref())?;
    let parent = full
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(json!({
        "path": full.to_string_lossy(),
        "parent": parent
    }))
}

#[tauri::command]
pub fn reveal_media_output_dir() -> Result<Value, String> {
    let cfg = read_media_config_private();
    let root = ensure_media_output_root_from_config(&cfg)?;
    Ok(json!({
        "path": root.to_string_lossy()
    }))
}

#[tauri::command]
pub async fn load_media_asset(path: String, root: Option<String>) -> Result<Value, String> {
    let full = resolve_media_asset_path(&path, root.as_deref())?;
    // 先 stat 后读：避免超大文件整读进内存才被拒绝；
    // 内嵌预览走 base64 IPC，上限收紧到 64MB，超限引导用户打开文件夹本地查看
    let meta = tokio::fs::metadata(&full)
        .await
        .map_err(|e| format!("读取媒体资产失败: {e}"))?;
    if meta.len() > MAX_INLINE_PREVIEW_BYTES {
        return Err("媒体文件过大，无法内嵌预览，请使用「打开文件夹」在本地查看".into());
    }
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|e| format!("读取媒体资产失败: {e}"))?;
    let ext = full
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = if matches!(ext.as_str(), "mp4" | "webm" | "mov") {
        "video"
    } else {
        "image"
    };
    let mime = guess_mime_from_ext(&ext, kind);
    let encoded = general_purpose::STANDARD.encode(&bytes);
    Ok(json!({
        "path": path,
        "kind": kind,
        "mime": mime,
        "dataUrl": format!("data:{mime};base64,{encoded}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn read_config_masks_saved_api_key() {
        let cfg = json!({
            "providers": {
                "volcengine": {
                    "apiKey": "sk-secret",
                    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3"
                }
            }
        });

        let public = sanitize_media_config_for_read(&cfg);
        let provider = &public["providers"]["volcengine"];
        assert_eq!(provider["apiKey"], "");
        assert_eq!(provider["apiKeySaved"], true);
        assert_eq!(provider["apiKeyMask"], "sk-***cret");
    }

    #[test]
    fn media_config_preserves_openai_compatible_providers() {
        let cfg = normalize_media_config(
            json!({
                "defaults": { "provider": "openai" },
                "providers": {
                    "openai": {
                        "apiKey": "sk-openai-secret",
                        "baseUrl": "https://api.openai.com/v1/",
                        "imageModel": "gpt-image-1",
                        "videoModel": "sora-2"
                    },
                    "newapi": {
                        "apiKey": "sk-newapi-secret",
                        "baseUrl": "https://newapi.example.com/v1/",
                        "imageModel": "gpt-image-1",
                        "videoModel": "sora-2"
                    }
                }
            }),
            None,
        );

        assert_eq!(cfg["defaults"]["provider"], "openai");
        assert_eq!(
            cfg["providers"]["openai"]["baseUrl"],
            "https://api.openai.com/v1"
        );
        assert_eq!(
            cfg["providers"]["newapi"]["baseUrl"],
            "https://newapi.example.com/v1"
        );

        let public = sanitize_media_config_for_read(&cfg);
        assert_eq!(public["providers"]["openai"]["apiKey"], "");
        assert_eq!(public["providers"]["openai"]["apiKeySaved"], true);
        assert_eq!(public["providers"]["newapi"]["apiKey"], "");
        assert_eq!(public["providers"]["newapi"]["apiKeySaved"], true);
    }

    #[test]
    fn gpt_image_payload_omits_openai_unsupported_fields() {
        let provider = MediaProviderConfig {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "sk-test".into(),
            image_model: "gpt-image-1".into(),
            video_model: "sora-2".into(),
            timeout_seconds: 600,
        };
        let payload = build_image_generation_payload(
            &provider,
            &json!({
                "prompt": "a product shot",
                "size": "1024x1024",
                "count": 2,
                "watermark": true
            }),
        );

        assert_eq!(payload["model"], "gpt-image-1");
        assert_eq!(payload["n"], 2);
        assert!(payload.get("response_format").is_none());
        assert!(payload.get("watermark").is_none());
    }

    #[test]
    fn openai_video_payload_maps_panel_controls() {
        let provider = MediaProviderConfig {
            provider: "newapi".into(),
            base_url: "https://newapi.example.com/v1".into(),
            api_key: "sk-test".into(),
            image_model: "gpt-image-1".into(),
            video_model: "sora-2".into(),
            timeout_seconds: 600,
        };
        let payload = build_openai_video_payload(
            &provider,
            &json!({
                "prompt": "cinematic launch",
                "ratio": "9:16",
                "resolution": "720p",
                "duration": 5,
                "imageUrl": "https://example.com/ref.png"
            }),
        );

        assert_eq!(payload["model"], "sora-2");
        assert_eq!(payload["prompt"], "cinematic launch");
        assert_eq!(payload["size"], "720x1280");
        assert_eq!(payload["seconds"], "4");
        assert_eq!(payload["image"], "https://example.com/ref.png");
    }

    #[test]
    fn validate_image_request_rejects_empty_prompt_and_bad_count() {
        let empty_prompt = json!({ "provider": "volcengine", "prompt": "  ", "count": 1 });
        assert!(validate_image_request(&empty_prompt).is_err());

        let bad_count = json!({ "provider": "volcengine", "prompt": "cat", "count": 9 });
        assert!(validate_image_request(&bad_count).is_err());
    }

    #[test]
    fn media_paths_must_stay_relative_to_media_root() {
        assert!(is_safe_relative_media_path("assets/2026/07/job-1.png"));
        assert!(is_safe_relative_media_path(r"assets\2026\07\job-1.png"));
        assert!(!is_safe_relative_media_path("../openclaw.json"));
        assert!(!is_safe_relative_media_path("assets/../../openclaw.json"));
        assert!(!is_safe_relative_media_path(r"assets\..\openclaw.json"));
        assert!(!is_safe_relative_media_path("C:/Users/test/secret.txt"));
        assert!(!is_safe_relative_media_path(r"C:\Users\test\secret.txt"));
        assert!(!is_safe_relative_media_path(r"\\server\share\secret.txt"));
    }

    #[test]
    fn provider_statuses_map_to_stable_job_statuses() {
        assert_eq!(provider_status_to_job_status("queued"), "running");
        assert_eq!(provider_status_to_job_status("processing"), "running");
        assert_eq!(provider_status_to_job_status("succeeded"), "succeeded");
        assert_eq!(provider_status_to_job_status("failed"), "failed");
        assert_eq!(provider_status_to_job_status("cancelled"), "canceled");
    }

    #[test]
    fn same_host_asset_download_retries_without_auth_on_auth_rejection() {
        assert!(should_retry_asset_without_auth(
            reqwest::StatusCode::UNAUTHORIZED,
            true
        ));
        assert!(should_retry_asset_without_auth(
            reqwest::StatusCode::FORBIDDEN,
            true
        ));
        assert!(!should_retry_asset_without_auth(
            reqwest::StatusCode::UNAUTHORIZED,
            false
        ));
        assert!(!should_retry_asset_without_auth(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            true
        ));
    }

    #[test]
    fn asset_auth_requires_matching_scheme_host_and_port() {
        assert!(asset_url_same_origin(
            "https://api.example.com/v1/asset",
            "https://api.example.com/v1"
        ));
        assert!(!asset_url_same_origin(
            "http://api.example.com/v1/asset",
            "https://api.example.com/v1"
        ));
        assert!(!asset_url_same_origin(
            "https://api.example.com:8443/asset",
            "https://api.example.com/v1"
        ));
    }

    #[test]
    fn media_download_rejects_oversized_content_length_before_buffering() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::HeaderValue::from_static("536870913"),
        );
        assert!(media_content_length_exceeds_limit(&headers).unwrap());

        headers.insert(
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::HeaderValue::from_static("536870912"),
        );
        assert!(!media_content_length_exceeds_limit(&headers).unwrap());
    }

    #[test]
    fn extracts_media_models_from_common_response_shapes() {
        let openai = json!({
            "data": [
                { "id": "doubao-seedream-4-0" },
                { "id": "doubao-seedance-2-0-pro" }
            ]
        });
        let models = extract_media_models(&openai);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["capabilities"][0], "video");
        assert_eq!(models[1]["capabilities"][0], "image");

        let control_plane = json!({
            "Result": {
                "Items": [
                    { "FoundationModelName": "seedream-image", "DisplayName": "Seedream" }
                ]
            }
        });
        let models = extract_media_models(&control_plane);
        assert_eq!(models[0]["id"], "seedream-image");
        assert_eq!(models[0]["label"], "Seedream");
    }

    #[test]
    fn media_root_follows_openclaw_dir() {
        // 普通模式与便携模式共用同一相对布局：openclaw_dir/clawpanel/media。
        // 便携模式下 openclaw_dir 已指向便携数据目录，迁移复制后无需搬运。
        let normal = media_root_impl(Path::new("/home/alice/.openclaw"));
        assert_eq!(
            normal,
            PathBuf::from("/home/alice/.openclaw/clawpanel/media")
        );

        let portable = media_root_impl(Path::new("/mnt/usb/data/openclaw"));
        assert_eq!(
            portable,
            PathBuf::from("/mnt/usb/data/openclaw/clawpanel/media")
        );
    }

    #[test]
    fn normalize_config_keeps_trimmed_output_dir() {
        let cfg = normalize_media_config(json!({ "outputDir": "  exports/media  " }), None);
        assert_eq!(cfg["outputDir"], "exports/media");

        let defaulted = normalize_media_config(json!({}), None);
        assert_eq!(defaulted["outputDir"], "");
    }

    #[test]
    fn media_output_root_prefers_custom_dir() {
        let media_root = Path::new("/home/alice/.openclaw/clawpanel/media");
        assert_eq!(media_output_root_impl(media_root, ""), media_root);
        assert_eq!(
            media_output_root_impl(media_root, "exports"),
            media_root.join("exports")
        );

        let absolute = if cfg!(windows) {
            PathBuf::from(r"D:\ClawPanelMedia")
        } else {
            PathBuf::from("/mnt/ClawPanelMedia")
        };
        assert_eq!(
            media_output_root_impl(media_root, absolute.to_string_lossy().as_ref()),
            absolute
        );
    }

    #[test]
    fn media_job_collection_filters_sorts_and_paginates() {
        let jobs_doc = json!({
            "jobs": [
                { "id": "old", "type": "image", "status": "succeeded", "createdAt": "2026-07-01T00:00:00Z" },
                { "id": "running-video", "type": "video", "status": "running", "createdAt": "2026-07-03T00:00:00Z" },
                { "id": "new-image", "type": "image", "status": "succeeded", "createdAt": "2026-07-04T00:00:00Z" },
                { "id": "middle-image", "type": "image", "status": "succeeded", "createdAt": "2026-07-02T00:00:00Z" }
            ]
        });
        let filter = json!({ "type": "image", "status": "succeeded", "offset": 1, "limit": 1 });

        let result = media_jobs_response_from_doc(&jobs_doc, Some(&filter));
        assert_eq!(result["total"], 3);
        assert_eq!(result["offset"], 1);
        assert_eq!(result["limit"], 1);
        assert_eq!(result["hasMore"], true);
        assert_eq!(result["jobs"][0]["id"], "middle-image");
    }
}
